// Phase 3: ATS applications prepared by the worker, reviewed and approved here.
import fs from 'node:fs';
import path from 'node:path';
import express, { Router } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import {
  APPLICATION_STATUSES,
  ApplicationModel,
  appHome,
  companyFromUrl,
  detectAts,
  getSettings,
  LINK_JOB_TITLE,
  JobModel,
  questionKey,
  savedAnswerKeys,
  SavedAnswerModel,
  TailoredDocModel,
  TaskModel,
  toApplicationDto,
  type ApplicationStatus,
} from '@ja/shared';
import { HttpError, parse } from '../http.js';
import { createManualJob } from '../manualJob.js';

export const applicationsRouter = Router();

const ACTIVE = { $in: ['pending', 'running'] };

const LINK = 'link';
/** Applications the worker can run again from the start (it opens the page itself). */
const RESTARTABLE = [LINK, 'linkedin', 'naukri'];

async function enqueueOnce(
  type: string,
  payload: Record<string, string | boolean>,
): Promise<string> {
  const filter = Object.fromEntries(Object.entries(payload).map(([k, v]) => [`payload.${k}`, v]));
  const active = await TaskModel.findOne({ type, ...filter, status: ACTIVE }).lean();
  if (active) return String(active._id);
  const task = await TaskModel.create({ type, payload, maxAttempts: 1 });
  return String(task._id);
}

async function withJobs(apps: Array<Parameters<typeof toApplicationDto>[0]>) {
  const jobs = await JobModel.find(
    { _id: { $in: apps.map((a) => a.jobId) } },
    { title: 1, company: 1, location: 1, score: 1, url: 1 },
  ).lean();
  const byId = new Map(jobs.map((j) => [String(j._id), j]));
  return apps.map((a) => toApplicationDto(a, byId.get(String(a.jobId))));
}

const ListQuery = z.object({
  status: z
    .string()
    .transform((s) => s.split(',').filter(Boolean))
    .pipe(z.array(z.enum(APPLICATION_STATUSES)))
    .optional(),
  jobId: z
    .string()
    .refine((v) => mongoose.isValidObjectId(v), 'invalid id')
    .optional(),
});

applicationsRouter.get('/applications', async (req, res) => {
  const q = parse(ListQuery, req.query);
  const filter: Record<string, unknown> = {};
  if (q.status) filter.status = { $in: q.status };
  if (q.jobId) filter.jobId = q.jobId;
  const apps = await ApplicationModel.find(filter).sort({ updatedAt: -1 }).limit(200).lean();
  res.json(await withJobs(apps));
});

applicationsRouter.get('/applications/:id', async (req, res) => {
  const app = await ApplicationModel.findById(req.params.id).lean();
  if (!app) throw new HttpError(404, 'Application not found');
  res.json((await withJobs([app]))[0]);
});

const PatchBody = z
  .object({
    answers: z
      .array(
        z.object({
          key: z.string(),
          value: z.union([z.string().max(5000), z.array(z.string()), z.boolean()]),
        }),
      )
      .min(1),
  })
  .strict();

/**
 * Keeps your answer for good: later forms asking the same question get it filled in (written
 * answers and files too). Labels that are only an element id are not worth keeping.
 */
async function rememberAnswer(
  label: string,
  section: string | undefined,
  kind: string,
  value: unknown,
): Promise<void> {
  if (!/[a-z]{3}/i.test(label) || /^(mat-input|label:)/i.test(label)) return;
  const plain = questionKey(label);
  for (const key of savedAnswerKeys(label, section)) {
    await SavedAnswerModel.updateOne(
      { questionKey: key },
      { $set: { question: key === plain ? label : `${section} › ${label}`, value, kind } },
      { upsert: true },
    );
  }
}

const EDITABLE: ApplicationStatus[] = ['needs_input', 'ready', 'dry_run', 'needs_manual', 'failed'];

/**
 * Saves your answers. Short answers (not essays or files) are also remembered and reused when a
 * later form asks a similarly worded question.
 */
applicationsRouter.patch('/applications/:id', async (req, res) => {
  const { answers } = parse(PatchBody, req.body);
  const app = await ApplicationModel.findById(req.params.id);
  if (!app) throw new HttpError(404, 'Application not found');
  if (!EDITABLE.includes(app.status))
    throw new HttpError(409, `Can't edit an application that is "${app.status}"`);

  for (const { key, value } of answers) {
    const a = app.answers.find((x) => x.key === key);
    if (!a) throw new HttpError(400, `Unknown field "${key}"`);
    // Search boxes (cities…) list their options only after typing, so any text is allowed there.
    if (
      a.kind !== 'combobox' &&
      a.options?.length &&
      typeof value === 'string' &&
      value &&
      !a.options.includes(value)
    )
      throw new HttpError(400, `"${value}" is not an option for "${a.label}"`);
    // Files are set by uploading them (below), never by a path typed here.
    if (a.kind === 'file' && value !== '')
      throw new HttpError(400, 'Upload the file with the Upload button');
    a.value = value;
    a.source = 'user';
    a.needsReview = false;
    const empty = value === '' || (Array.isArray(value) && !value.length);
    a.needsInput = Boolean(a.required) && empty;
    if (!empty) await rememberAnswer(a.label, a.section ?? undefined, a.kind, value);
  }
  const missing = app.answers.some((a) => a.needsInput);
  if (missing) app.status = 'needs_input';
  else if (app.status === 'needs_input') app.status = 'ready';
  // A pasted link set to submit by itself carries on as soon as nothing is missing.
  const carryOn =
    RESTARTABLE.includes(app.channel) && app.mode === 'auto' && app.status === 'ready';
  if (carryOn) {
    app.status = 'approved';
    app.approvedAt = new Date();
  }
  await app.save();
  if (carryOn)
    await enqueueOnce(app.channel === LINK ? 'link_apply' : 'portal_apply', {
      appId: String(app._id),
      submit: true,
    });
  res.json((await withJobs([app.toObject()]))[0]);
});

/** Approve = submit now (DRY_RUN=true only fills the form and takes a screenshot). */
applicationsRouter.post('/applications/:id/approve', async (req, res) => {
  const app = await ApplicationModel.findById(req.params.id);
  if (!app) throw new HttpError(404, 'Application not found');
  if (app.answers.some((a) => a.needsInput))
    throw new HttpError(409, 'Answer the highlighted questions first');
  if (!['ready', 'dry_run', 'needs_manual', 'failed'].includes(app.status))
    throw new HttpError(409, `Can't approve an application that is "${app.status}"`);
  app.status = 'approved';
  app.approvedAt = new Date();
  await app.save();
  res
    .status(202)
    .json({ taskId: await enqueueOnce('submit_application', { appId: String(app._id) }) });
});

applicationsRouter.post('/applications/:id/skip', async (req, res) => {
  const app = await ApplicationModel.findByIdAndUpdate(
    req.params.id,
    { $set: { status: 'skipped' } },
    { new: true },
  ).lean();
  if (!app) throw new HttpError(404, 'Application not found');
  res.json((await withJobs([app]))[0]);
});

/** Reads the job's form and drafts answers (needs a ready application kit). */
applicationsRouter.post('/jobs/:id/apply', async (req, res) => {
  const job = await JobModel.findById(req.params.id, { _id: 1, source: 1, seenOn: 1 }).lean();
  if (!job) throw new HttpError(404, 'Job not found');
  const ats = [job.source, ...(job.seenOn ?? []).map((s) => s.source)].some((s) =>
    ['greenhouse', 'lever', 'ashby'].includes(s),
  );
  if (!ats) throw new HttpError(409, 'Auto-apply works for Greenhouse, Lever and Ashby jobs only');
  if (!(await TailoredDocModel.exists({ jobId: job._id, status: 'ready' })))
    throw new HttpError(409, 'Generate the resume + cover letter first');
  res
    .status(202)
    .json({ taskId: await enqueueOnce('prepare_application', { jobId: String(job._id) }) });
});

const LinkBody = z
  .object({
    url: z
      .string()
      .trim()
      .url()
      .refine((u) => /^https?:\/\//i.test(u), 'Use an http(s) link'),
    company: z.string().trim().max(120).optional(),
    title: z.string().trim().max(160).optional(),
    /** Submit as soon as every question is answered, without waiting for your approval. */
    autoSubmit: z.boolean().default(false),
  })
  .strict();

/**
 * Apply from any link: stores the job and starts the worker, which opens the link in a browser
 * window, asks you to log in there if needed, fills every page and asks what it can't answer.
 */
applicationsRouter.post('/applications/from-link', async (req, res) => {
  const b = parse(LinkBody, req.body);
  if ((await getSettings()).killSwitch) throw new HttpError(409, 'Kill switch is on');
  const url = b.url.replace(/#.*$/, '');
  const known = await JobModel.findOne({ source: 'manual', canonicalUrl: url }, { _id: 1 }).lean();
  const existing = known
    ? await ApplicationModel.findOne({ jobId: known._id, channel: LINK })
    : null;
  if (existing) {
    if (existing.status === 'submitted')
      throw new HttpError(409, 'You already applied with this link');
    existing.status = 'preparing';
    existing.mode = b.autoSubmit ? 'auto' : 'approve';
    existing.error = undefined;
    await existing.save();
    const taskId = await enqueueOnce('link_apply', {
      appId: String(existing._id),
      submit: b.autoSubmit,
    });
    res.status(202).json({ appId: String(existing._id), jobId: String(known!._id), taskId });
    return;
  }
  const job = await createManualJob({
    company: b.company || companyFromUrl(url),
    title: b.title || LINK_JOB_TITLE,
    url,
  });
  const app = await ApplicationModel.create({
    jobId: job._id,
    channel: LINK,
    ats: detectAts(url),
    applyUrl: url,
    mode: b.autoSubmit ? 'auto' : 'approve',
    status: 'preparing',
    error: 'Waiting for the worker…',
  });
  const taskId = await enqueueOnce('link_apply', { appId: String(app._id), submit: b.autoSubmit });
  res.status(202).json({ appId: String(app._id), jobId: String(job._id), taskId });
});

/** Pasted links: run again from the start (after a login timeout, an error or a site change). */
applicationsRouter.post('/applications/:id/retry', async (req, res) => {
  const app = await ApplicationModel.findById(req.params.id);
  if (!app) throw new HttpError(404, 'Application not found');
  if (!RESTARTABLE.includes(app.channel))
    throw new HttpError(409, 'Only pasted-link, LinkedIn and Naukri applications can be restarted');
  if (['submitted', 'submitting', 'preparing'].includes(app.status))
    throw new HttpError(409, `Application is "${app.status}"`);
  app.status = 'preparing';
  app.error = 'Waiting for the worker…';
  await app.save();
  const taskId = await enqueueOnce(app.channel === LINK ? 'link_apply' : 'portal_apply', {
    appId: String(app._id),
    submit: app.mode === 'auto',
  });
  res.status(202).json({ taskId });
});

const UPLOAD_TYPES = /\.(pdf|docx?|rtf|txt|jpe?g|png|webp|heic)$/i;

/**
 * A file a form asks for (photo, ID, certificate). Stored under ~/.job-autopilot/uploads and
 * remembered, so the next form asking for the same thing gets it automatically.
 */
applicationsRouter.post(
  '/applications/:id/answers/:key/file',
  express.raw({ type: () => true, limit: '10mb' }),
  async (req, res) => {
    const app = await ApplicationModel.findById(req.params.id);
    if (!app) throw new HttpError(404, 'Application not found');
    if (!EDITABLE.includes(app.status))
      throw new HttpError(409, `Can't edit an application that is "${app.status}"`);
    const a = app.answers.find((x) => x.key === req.params.key);
    if (!a || a.kind !== 'file') throw new HttpError(400, 'Not a file question');
    const name = decodeURIComponent(String(req.headers['x-file-name'] ?? ''))
      .split(/[/\\]/)
      .pop()!
      .replace(/[^A-Za-z0-9._-]+/g, '_')
      .slice(-100);
    if (!name || !UPLOAD_TYPES.test(name))
      throw new HttpError(400, 'Use a PDF, Word, text or image file');
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw new HttpError(400, 'Empty file');
    const dir = path.join(appHome(), 'uploads', questionKey(a.label).replace(/ /g, '-') || 'file');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name);
    fs.writeFileSync(file, req.body);
    a.value = file;
    a.source = 'user';
    a.needsInput = false;
    a.needsReview = false;
    await rememberAnswer(a.label, a.section ?? undefined, 'file', file);
    if (!app.answers.some((x) => x.needsInput) && app.status === 'needs_input')
      app.status = 'ready';
    await app.save();
    res.json((await withJobs([app.toObject()]))[0]);
  },
);

/** Everything you've answered on forms so far. */
applicationsRouter.get('/saved-answers', async (_req, res) => {
  const all = await SavedAnswerModel.find().sort({ updatedAt: -1 }).lean();
  res.json(
    all.map((s) => ({
      id: String(s._id),
      question: s.question,
      value: s.value,
      kind: s.kind ?? undefined,
      updatedAt: s.updatedAt?.toISOString(),
    })),
  );
});

applicationsRouter.put('/saved-answers/:id', async (req, res) => {
  const { value } = parse(
    z.object({ value: z.union([z.string().max(5000), z.array(z.string()), z.boolean()]) }).strict(),
    req.body,
  );
  const s = await SavedAnswerModel.findById(req.params.id);
  if (!s) throw new HttpError(404, 'Saved answer not found');
  if (s.kind === 'file') throw new HttpError(400, 'Upload a new file from an application instead');
  s.value = value;
  await s.save();
  res.json({ ok: true });
});

applicationsRouter.delete('/saved-answers/:id', async (req, res) => {
  await SavedAnswerModel.deleteOne({ _id: req.params.id });
  res.json({ ok: true });
});

applicationsRouter.get('/applications/:id/screenshots/:n', async (req, res) => {
  const app = await ApplicationModel.findById(req.params.id, { screenshots: 1 }).lean();
  const shot = app?.screenshots?.[Number(req.params.n)];
  if (!shot?.path || !fs.existsSync(shot.path)) throw new HttpError(404, 'Screenshot not found');
  res.sendFile(shot.path);
});
