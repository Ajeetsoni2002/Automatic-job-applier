// Phase 2b: cold emails to recruiters. The worker drafts and sends; you review here.
import { Router } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import {
  ContactModel,
  JobModel,
  OUTREACH_STATUSES,
  OutreachModel,
  SuppressionModel,
  TaskModel,
  type OutreachDto,
} from '@ja/shared';
import { HttpError, parse } from '../http.js';
import { createManualJob } from '../manualJob.js';

export const outreachRouter = Router();

const emailSchema = z.string().trim().toLowerCase().email();

async function toDtos(
  items: Array<Record<string, unknown> & { _id: unknown }>,
): Promise<OutreachDto[]> {
  const [jobs, contacts] = await Promise.all([
    JobModel.find(
      { _id: { $in: items.map((o) => o.jobId) } },
      { title: 1, company: 1, score: 1, url: 1 },
    ).lean(),
    ContactModel.find(
      { _id: { $in: items.map((o) => o.contactId) } },
      { name: 1, source: 1 },
    ).lean(),
  ]);
  const jobById = new Map(jobs.map((j) => [String(j._id), j]));
  const contactById = new Map(contacts.map((c) => [String(c._id), c]));
  const iso = (d: unknown) => (d instanceof Date ? d.toISOString() : undefined);
  return items.map((o) => {
    const job = jobById.get(String(o.jobId));
    const contact = contactById.get(String(o.contactId));
    return {
      id: String(o._id),
      jobId: String(o.jobId),
      job: job
        ? { title: job.title, company: job.company, score: job.score ?? undefined, url: job.url }
        : undefined,
      email: String(o.email),
      contactName: contact?.name ?? undefined,
      contactSource: (contact?.source ?? 'manual') as OutreachDto['contactSource'],
      type: o.type as OutreachDto['type'],
      status: o.status as OutreachDto['status'],
      subject: String(o.subject),
      body: String(o.body),
      edited: Boolean(o.edited),
      issues: (o.issues as string[] | undefined) ?? [],
      attachResume: Boolean(o.attachResume),
      scheduledFor: iso(o.scheduledFor),
      sentAt: iso(o.sentAt),
      repliedAt: iso(o.repliedAt),
      replySnippet: (o.replySnippet as string | undefined) ?? undefined,
      error: (o.error as string | undefined) ?? undefined,
      updatedAt: iso(o.updatedAt) ?? '',
    };
  });
}

const ListQuery = z.object({
  status: z
    .string()
    .transform((s) => s.split(',').filter(Boolean))
    .pipe(z.array(z.enum(OUTREACH_STATUSES)))
    .optional(),
  jobId: z
    .string()
    .refine((v) => mongoose.isValidObjectId(v), 'invalid id')
    .optional(),
});

outreachRouter.get('/outreach', async (req, res) => {
  const q = parse(ListQuery, req.query);
  const filter: Record<string, unknown> = {};
  if (q.status) filter.status = { $in: q.status };
  if (q.jobId) filter.jobId = q.jobId;
  const items = await OutreachModel.find(filter).sort({ updatedAt: -1 }).limit(200).lean();
  res.json(await toDtos(items as never));
});

const PatchBody = z
  .object({
    subject: z.string().trim().min(3).max(200),
    body: z.string().trim().min(30).max(5000),
    attachResume: z.boolean(),
  })
  .partial()
  .strict();

outreachRouter.patch('/outreach/:id', async (req, res) => {
  const patch = parse(PatchBody, req.body);
  const o = await OutreachModel.findById(req.params.id);
  if (!o) throw new HttpError(404, 'Email not found');
  if (!['draft', 'scheduled', 'dry_run', 'failed'].includes(o.status))
    throw new HttpError(409, `Can't edit an email that is "${o.status}"`);
  Object.assign(o, patch, patch.subject || patch.body ? { edited: true } : {});
  await o.save();
  res.json((await toDtos([o.toObject() as never]))[0]);
});

/** Approve = queue for sending. The worker picks the time (weekdays 09:30–18:30, spaced out). */
outreachRouter.post('/outreach/:id/approve', async (req, res) => {
  const o = await OutreachModel.findById(req.params.id);
  if (!o) throw new HttpError(404, 'Email not found');
  if (!['draft', 'dry_run', 'failed'].includes(o.status))
    throw new HttpError(409, `Can't approve an email that is "${o.status}"`);
  if (await SuppressionModel.exists({ email: o.email }))
    throw new HttpError(409, `${o.email} is on the do-not-email list`);
  o.status = 'scheduled';
  o.scheduledFor = undefined;
  o.error = undefined;
  await o.save();
  res.json((await toDtos([o.toObject() as never]))[0]);
});

outreachRouter.post('/outreach/:id/skip', async (req, res) => {
  const o = await OutreachModel.findOneAndUpdate(
    { _id: req.params.id, status: { $in: ['draft', 'scheduled', 'dry_run', 'failed'] } },
    { $set: { status: 'skipped' } },
    { new: true },
  ).lean();
  if (!o) throw new HttpError(409, 'Email not found or already sent');
  res.json((await toDtos([o as never]))[0]);
});

async function queueDraft(jobId: string, email: string, name?: string): Promise<string> {
  const active = await TaskModel.findOne({
    type: 'draft_outreach',
    'payload.jobId': jobId,
    'payload.email': email,
    status: { $in: ['pending', 'running'] },
  }).lean();
  if (active) return String(active._id);
  const task = await TaskModel.create({
    type: 'draft_outreach',
    payload: { jobId, email, name },
    maxAttempts: 1,
  });
  return String(task._id);
}

const ContactBody = z
  .object({ email: emailSchema, name: z.string().trim().max(80).optional() })
  .strict();

/** You found a recruiter's email (e.g. in a LinkedIn post): draft an email about this job. */
outreachRouter.post('/jobs/:id/contacts', async (req, res) => {
  const { email, name } = parse(ContactBody, req.body);
  const job = await JobModel.findById(req.params.id, { _id: 1 }).lean();
  if (!job) throw new HttpError(404, 'Job not found');
  if (await SuppressionModel.exists({ email }))
    throw new HttpError(409, `${email} is on the do-not-email list`);
  res.status(202).json({ taskId: await queueDraft(String(job._id), email, name) });
});

const ManualBody = z
  .object({
    company: z.string().trim().min(1).max(120),
    title: z.string().trim().min(2).max(160),
    email: emailSchema,
    name: z.string().trim().max(80).optional(),
    location: z.string().trim().max(120).optional(),
    description: z.string().trim().max(20_000).optional(),
    url: z.string().trim().url().optional(),
  })
  .strict();

/** A role you heard about outside the system: store it as a job, then draft the email. */
outreachRouter.post('/outreach/manual', async (req, res) => {
  const b = parse(ManualBody, req.body);
  if (await SuppressionModel.exists({ email: b.email }))
    throw new HttpError(409, `${b.email} is on the do-not-email list`);
  const job = await createManualJob({
    company: b.company,
    title: b.title,
    url: b.url ?? `mailto:${b.email}`,
    location: b.location,
    description: b.description,
  });
  res
    .status(202)
    .json({ jobId: String(job._id), taskId: await queueDraft(String(job._id), b.email, b.name) });
});

outreachRouter.post('/suppressions', async (req, res) => {
  const { email } = parse(z.object({ email: emailSchema }).strict(), req.body);
  await SuppressionModel.updateOne(
    { email },
    { $setOnInsert: { email, reason: 'added by you' } },
    { upsert: true },
  );
  await OutreachModel.updateMany(
    { email, status: { $in: ['draft', 'scheduled'] } },
    { $set: { status: 'skipped', error: 'On the do-not-email list' } },
  );
  res.json({ ok: true });
});
