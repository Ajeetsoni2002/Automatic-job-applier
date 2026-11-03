import { Router } from 'express';
import { z } from 'zod';
import {
  CONFIDENCES,
  JOB_STATUSES,
  JobModel,
  JobScoreModel,
  llmEnabled,
  JOB_SOURCES,
  TailoredDocModel,
  toJobDetailDto,
  toJobDto,
  USER_SETTABLE_STATUSES,
  WORK_MODES,
  type Paginated,
  type JobDto,
} from '@ja/shared';
import { HttpError, parse } from '../http.js';
import { enqueueTailor } from './docs.js';

/** Statuses shown when the client doesn't ask for specific ones. */
const DEFAULT_STATUSES = [
  'new',
  'scored',
  'score_failed',
  'shortlisted',
  'applied_manually',
  'queued',
];

const csv = <T extends string>(values: readonly T[]) =>
  z
    .string()
    .transform((s) =>
      s
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.enum(values as unknown as [T, ...T[]])));

const ListQuery = z.object({
  status: csv(JOB_STATUSES).optional(),
  source: csv(JOB_SOURCES).optional(),
  workMode: csv(WORK_MODES).optional(),
  confidence: csv(CONFIDENCES).optional(),
  minScore: z.coerce.number().min(0).max(100).optional(),
  /** "eligible" = posting explicitly names your graduation batch. */
  batch: z.enum(['eligible']).optional(),
  postedWithinDays: z.coerce.number().int().min(1).max(365).optional(),
  q: z.string().trim().max(100).optional(),
  sort: z.enum(['score', 'posted', 'fetched']).default('score'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

const PatchBody = z
  .object({
    status: z.enum(USER_SETTABLE_STATUSES).optional(),
    notes: z.string().max(2000).optional(),
  })
  .strict()
  .refine((b) => b.status !== undefined || b.notes !== undefined, 'nothing to update');

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const jobsRouter = Router();

jobsRouter.get('/', async (req, res) => {
  const q = parse(ListQuery, req.query);
  const filter: Record<string, unknown> = { status: { $in: q.status ?? DEFAULT_STATUSES } };
  if (q.source) filter.source = { $in: q.source };
  if (q.workMode) filter.workMode = { $in: q.workMode };
  if (q.confidence) filter.scoreConfidence = { $in: q.confidence };
  if (q.minScore !== undefined) filter.score = { $gte: q.minScore };
  if (q.batch === 'eligible') filter.batchMatch = true;
  if (q.postedWithinDays) {
    const since = new Date(Date.now() - q.postedWithinDays * 86_400_000);
    filter.$and = [
      { $or: [{ postedAt: { $gte: since } }, { postedAt: null, fetchedAt: { $gte: since } }] },
    ];
  }
  if (q.q) {
    const re = new RegExp(escapeRe(q.q), 'i');
    filter.$or = [{ title: re }, { company: re }, { location: re }];
  }

  const sort: Record<string, 1 | -1> =
    q.sort === 'score'
      ? { score: -1, postedAt: -1 }
      : q.sort === 'posted'
        ? { postedAt: -1, fetchedAt: -1 }
        : { fetchedAt: -1 };

  const [items, total] = await Promise.all([
    JobModel.find(filter, { description: 0 })
      .sort(sort)
      .skip((q.page - 1) * q.pageSize)
      .limit(q.pageSize)
      .lean(),
    JobModel.countDocuments(filter),
  ]);
  const body: Paginated<JobDto> = {
    items: items.map((j) => toJobDto(j)),
    total,
    page: q.page,
    pageSize: q.pageSize,
  };
  res.json(body);
});

jobsRouter.get('/:id', async (req, res) => {
  const job = await JobModel.findById(req.params.id).lean();
  if (!job) throw new HttpError(404, 'Job not found');
  const score = await JobScoreModel.findOne({ jobId: job._id }).sort({ createdAt: -1 }).lean();
  res.json(toJobDetailDto(job, score));
});

jobsRouter.patch('/:id', async (req, res) => {
  const body = parse(PatchBody, req.body);
  const job = await JobModel.findById(req.params.id);
  if (!job) throw new HttpError(404, 'Job not found');
  if (body.status) {
    if (job.status === 'filtered_out' || job.status === 'new')
      throw new HttpError(
        409,
        `A job in status "${job.status}" can't be changed until it has been scored`,
      );
    job.status = body.status;
  }
  if (body.notes !== undefined) job.notes = body.notes;
  await job.save();
  // Shortlisting a job prepares its application kit, unless it already has one.
  if (
    body.status === 'shortlisted' &&
    llmEnabled() &&
    !(await TailoredDocModel.exists({ jobId: job._id, status: 'ready' }))
  )
    await enqueueTailor(String(job._id), 'shortlist');
  res.json(toJobDto(job.toObject()));
});
