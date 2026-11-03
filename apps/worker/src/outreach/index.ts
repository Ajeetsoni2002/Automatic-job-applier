import fs from 'node:fs';
import {
  allSkills,
  ContactModel,
  getEnv,
  getSettings,
  JobModel,
  loadProfile,
  logger,
  OutreachModel,
  startOfToday,
  SuppressionModel,
  TailoredDocModel,
} from '@ja/shared';
import { escapeHtml, sendTelegram, telegramConfigured } from '../notify/telegram.js';
import { buildVocabulary } from '../tailor/claims.js';
import { tailorJob } from '../tailor/index.js';
import { draftColdEmail, followUpEmail } from './draft.js';
import { domainAcceptsMail, extractEmails, isValidEmail } from './emails.js';
import { sendMail, smtpConfigured, withSentMailbox } from './mail.js';
import { inSendWindow, nextSendSlot } from './schedule.js';

const CONTACT_COOLDOWN_DAYS = 14;
const REPLY_LOOKBACK_DAYS = 30;
const OPT_OUT_RE = /^\s*(no|stop|unsubscribe|not interested|remove me)\b/i;

async function notify(html: string) {
  if (telegramConfigured())
    await sendTelegram(html).catch((err) => logger.warn({ err: err.message }, 'telegram failed'));
}

const isSuppressed = async (email: string) =>
  Boolean(await SuppressionModel.exists({ email: email.toLowerCase() }));

async function plannedSlots(): Promise<Date[]> {
  const [sent, scheduled] = await Promise.all([
    OutreachModel.find({ sentAt: { $gte: startOfToday() } }, { sentAt: 1 }).lean(),
    OutreachModel.find(
      { status: { $in: ['scheduled', 'sending'] }, scheduledFor: { $ne: null } },
      { scheduledFor: 1 },
    ).lean(),
  ]);
  return [...sent.map((s) => s.sentAt!), ...scheduled.map((s) => s.scheduledFor!)].filter(Boolean);
}

/**
 * Writes the first email to `email` about a job and stores it as a draft (approve mode) or
 * schedules it (auto mode). Generates the job's application kit first if it has none, so the
 * tailored resume can be attached.
 */
export async function draftOutreach(
  jobId: string,
  rawEmail: string,
  opts: { name?: string; source: 'job_post' | 'manual' },
): Promise<{ outreachId: string; status: string }> {
  const email = rawEmail.trim().toLowerCase();
  if (!isValidEmail(email)) throw new Error(`"${rawEmail}" is not a valid email address`);
  const settings = await getSettings();
  const mode = settings.channels.cold_email.mode;
  if (mode === 'off') throw new Error('Cold email is turned off in Settings');
  if (await isSuppressed(email)) throw new Error(`${email} is on the do-not-email list`);

  const job = await JobModel.findById(jobId).lean();
  if (!job) throw new Error(`job ${jobId} not found`);

  const contact = await ContactModel.findOneAndUpdate(
    { email },
    {
      $setOnInsert: { email, source: opts.source },
      $set: { company: job.company, ...(opts.name && { name: opts.name }) },
    },
    { upsert: true, new: true },
  );
  if (!contact.domainOk) {
    contact.domainOk = await domainAcceptsMail(email);
    await contact.save();
  }
  if (!contact.domainOk) throw new Error(`${email.split('@')[1]} has no mail server`);

  const existing = await OutreachModel.findOne({
    jobId: job._id,
    contactId: contact._id,
    type: 'cold_email',
  }).lean();
  if (existing) return { outreachId: String(existing._id), status: existing.status };

  let doc = await TailoredDocModel.findOne({ jobId: job._id, status: 'ready' })
    .sort({ version: -1 })
    .lean();
  if (!doc) {
    await tailorJob(String(job._id), 'manual');
    doc = await TailoredDocModel.findOne({ jobId: job._id, status: 'ready' })
      .sort({ version: -1 })
      .lean();
  }

  const profile = loadProfile().data;
  const draft = await draftColdEmail(
    profile,
    {
      title: job.title,
      company: job.company,
      location: job.location ?? '',
      description: job.description ?? '',
    },
    buildVocabulary(allSkills(profile)),
    opts.name ?? contact.name ?? undefined,
  );
  const auto = mode === 'auto' && draft.issues.length === 0;
  const created = await OutreachModel.create({
    jobId: job._id,
    contactId: contact._id,
    email,
    type: 'cold_email',
    status: auto ? 'scheduled' : 'draft',
    subject: draft.subject,
    body: draft.body,
    issues: draft.issues,
    docId: doc?._id,
    attachResume: Boolean(doc?.resumePdfPath),
    scheduledFor: auto
      ? nextSendSlot(new Date(), await plannedSlots(), settings.channels.cold_email.dailyLimit)
      : undefined,
  });
  logger.info(
    { jobId, outreachId: String(created._id), status: created.status },
    'outreach drafted',
  );
  return { outreachId: String(created._id), status: created.status };
}

/** Finds recruiter emails printed in descriptions of good recent jobs and drafts an email for each. */
export async function discoverFromJobPosts(): Promise<{ drafted: number; errors: string[] }> {
  const out = { drafted: 0, errors: [] as string[] };
  const settings = await getSettings();
  if (settings.killSwitch || settings.channels.cold_email.mode === 'off' || smtpConfigured())
    return out;
  const since = new Date(Date.now() - 14 * 86_400_000);
  const jobs = await JobModel.find(
    {
      status: { $in: ['scored', 'shortlisted'] },
      score: { $gte: settings.outreach.minScore },
      fetchedAt: { $gte: since },
      description: /@/,
    },
    { _id: 1, description: 1 },
  )
    .sort({ score: -1 })
    .limit(50)
    .lean();
  const cooldown = new Date(Date.now() - CONTACT_COOLDOWN_DAYS * 86_400_000);
  for (const job of jobs) {
    if (out.drafted >= settings.channels.cold_email.dailyLimit) break;
    for (const email of extractEmails(job.description ?? '')) {
      const contact = await ContactModel.findOne({ email }).lean();
      if (contact?.lastEmailedAt && contact.lastEmailedAt > cooldown) continue;
      if (contact && (await OutreachModel.exists({ jobId: job._id, contactId: contact._id })))
        continue;
      try {
        await draftOutreach(String(job._id), email, { source: 'job_post' });
        out.drafted++;
      } catch (err) {
        out.errors.push(`${email}: ${(err as Error).message}`);
      }
    }
  }
  return out;
}

/** Creates the single follow-up for first emails that got no reply after `followUpDays`. */
export async function createFollowUps(): Promise<number> {
  const settings = await getSettings();
  const mode = settings.channels.cold_email.mode;
  if (mode === 'off') return 0;
  const due = new Date(Date.now() - settings.outreach.followUpDays * 86_400_000);
  const firsts = await OutreachModel.find({
    type: 'cold_email',
    status: 'sent',
    sentAt: { $lte: due },
  }).lean();
  const profile = loadProfile().data;
  let created = 0;
  for (const first of firsts) {
    if (await OutreachModel.exists({ parentId: first._id })) continue;
    if (await isSuppressed(first.email)) continue;
    const job = await JobModel.findById(first.jobId, { title: 1, company: 1 }).lean();
    const contact = await ContactModel.findById(first.contactId, { name: 1 }).lean();
    if (!job) continue;
    const f = followUpEmail(profile, job, first.subject, contact?.name ?? undefined);
    await OutreachModel.create({
      jobId: first.jobId,
      contactId: first.contactId,
      email: first.email,
      type: 'follow_up',
      parentId: first._id,
      status: mode === 'auto' ? 'scheduled' : 'draft',
      subject: f.subject,
      body: f.body,
      docId: first.docId,
      attachResume: first.attachResume,
    });
    created++;
  }
  return created;
}

/** Marks threads that got a reply or bounced; replies stop follow-ups, opt-outs and bounces suppress. */
export async function checkReplies(): Promise<{ replies: number; bounces: number }> {
  const result = { replies: 0, bounces: 0 };
  const since = new Date(Date.now() - REPLY_LOOKBACK_DAYS * 86_400_000);
  const sent = await OutreachModel.find({ status: 'sent', sentAt: { $gte: since } }).lean();
  if (!sent.length) return result;

  const byEmail = new Map<string, typeof sent>();
  for (const o of sent) byEmail.set(o.email, [...(byEmail.get(o.email) ?? []), o]);

  await withSentMailbox(async (search) => {
    for (const [email, items] of byEmail) {
      const first = items.reduce((a, b) => (a.sentAt! < b.sentAt! ? a : b));
      const after = first.sentAt!.toISOString().slice(0, 10).replace(/-/g, '/');
      const threadIds = items.flatMap((o) => [o._id, ...(o.parentId ? [o.parentId] : [])]);

      const bounces = (await search(`from:mailer-daemon "${email}" after:${after}`)).filter(
        (h) => !h.date || h.date >= first.sentAt!,
      );
      if (bounces.length) {
        await OutreachModel.updateMany(
          { _id: { $in: threadIds } },
          { $set: { status: 'bounced', error: 'Delivery failed' } },
        );
        await SuppressionModel.updateOne(
          { email },
          { $setOnInsert: { email, reason: 'bounced' } },
          { upsert: true },
        );
        await OutreachModel.updateMany(
          { email, status: { $in: ['draft', 'scheduled'] } },
          { $set: { status: 'skipped', error: 'Address bounced' } },
        );
        result.bounces++;
        continue;
      }

      // Out-of-office and other automatic replies don't count: the follow-up still goes out.
      const replies = (await search(`from:${email} after:${after}`)).filter(
        (h) =>
          (!h.date || h.date >= first.sentAt!) &&
          !/automatic reply|auto-?reply|out of (the )?office|autoreply/i.test(h.subject),
      );
      if (!replies.length) continue;
      const reply = replies.at(-1)!;
      await OutreachModel.updateMany(
        { _id: { $in: threadIds } },
        {
          $set: {
            status: 'replied',
            repliedAt: reply.date ?? new Date(),
            replySnippet: reply.snippet,
          },
        },
      );
      await OutreachModel.updateMany(
        { email, status: { $in: ['draft', 'scheduled'] }, type: 'follow_up' },
        { $set: { status: 'skipped', error: 'They replied' } },
      );
      if (OPT_OUT_RE.test(reply.snippet))
        await SuppressionModel.updateOne(
          { email },
          { $setOnInsert: { email, reason: 'asked not to be emailed' } },
          { upsert: true },
        );
      const job = await JobModel.findById(first.jobId, { title: 1, company: 1 }).lean();
      await notify(
        `📩 Reply from <b>${escapeHtml(email)}</b> about ${escapeHtml(job?.title ?? 'your email')} — ${escapeHtml(job?.company ?? '')}\n<i>${escapeHtml(reply.snippet.slice(0, 200))}</i>`,
      );
      result.replies++;
    }
  });
  return result;
}

async function attachmentFor(
  outreachId: string,
  docId: unknown,
): Promise<Array<{ filename: string; path: string }>> {
  if (!docId) return [];
  const doc = await TailoredDocModel.findById(docId, { resumePdfPath: 1, resume: 1 }).lean();
  if (!doc?.resumePdfPath || !fs.existsSync(doc.resumePdfPath)) return [];
  const name = ((doc.resume as { name?: string } | undefined)?.name ?? 'Resume')
    .trim()
    .replace(/[^A-Za-z0-9]+/g, '_');
  return [{ filename: `${name}_Resume.pdf`, path: doc.resumePdfPath }];
}

/**
 * Sends scheduled emails whose time has come. Assigns send times to newly approved emails,
 * and keeps to the window, the daily limit, the kill switch, the do-not-email list and DRY_RUN.
 */
export async function sendDue(
  now = new Date(),
): Promise<{ sent: number; dryRun: number; failed: number }> {
  const result = { sent: 0, dryRun: 0, failed: 0 };
  const env = getEnv();
  const settings = await getSettings();
  if (settings.killSwitch || settings.channels.cold_email.mode === 'off') return result;
  const limit = settings.channels.cold_email.dailyLimit;

  // Approved from the dashboard without a time yet: give each a slot.
  for (const o of await OutreachModel.find({ status: 'scheduled', scheduledFor: null }).sort({
    updatedAt: 1,
  })) {
    o.scheduledFor = nextSendSlot(now, await plannedSlots(), limit);
    await o.save();
  }

  if (!inSendWindow(now)) return result;
  const due = await OutreachModel.find({ status: 'scheduled', scheduledFor: { $lte: now } })
    .sort({ scheduledFor: 1 })
    .lean();
  const profile = loadProfile().data;
  for (const o of due) {
    const sentToday = await OutreachModel.countDocuments({ sentAt: { $gte: startOfToday() } });
    if (!env.DRY_RUN && sentToday >= limit) {
      await OutreachModel.updateOne(
        { _id: o._id },
        { $set: { scheduledFor: nextSendSlot(now, await plannedSlots(), limit) } },
      );
      continue;
    }
    if (await isSuppressed(o.email)) {
      await OutreachModel.updateOne(
        { _id: o._id },
        { $set: { status: 'skipped', error: 'On the do-not-email list' } },
      );
      continue;
    }
    const claimed = await OutreachModel.updateOne(
      { _id: o._id, status: 'scheduled' },
      { $set: { status: 'sending' } },
    );
    if (!claimed.modifiedCount) continue;

    if (env.DRY_RUN) {
      await OutreachModel.updateOne(
        { _id: o._id },
        { $set: { status: 'dry_run', error: 'Not sent because DRY_RUN=true' } },
      );
      result.dryRun++;
      continue;
    }
    try {
      const parent = o.parentId
        ? await OutreachModel.findById(o.parentId, { messageId: 1 }).lean()
        : null;
      const messageId = await sendMail({
        fromName: profile.personal.name,
        to: o.email,
        subject: o.subject,
        text: o.body,
        attachments: o.attachResume ? await attachmentFor(String(o._id), o.docId) : [],
        inReplyTo: parent?.messageId ?? undefined,
      });
      await OutreachModel.updateOne(
        { _id: o._id },
        { $set: { status: 'sent', sentAt: new Date(), messageId, error: null } },
      );
      await ContactModel.updateOne({ _id: o.contactId }, { $set: { lastEmailedAt: new Date() } });
      result.sent++;
    } catch (err) {
      await OutreachModel.updateOne(
        { _id: o._id },
        { $set: { status: 'failed', error: (err as Error).message.split('\n')[0] } },
      );
      result.failed++;
    }
  }
  return result;
}

/** Runs every few minutes from the worker: replies first, then follow-ups, then sending. */
export async function outreachTick(): Promise<void> {
  if (smtpConfigured()) return;
  try {
    const r = await checkReplies();
    const f = await createFollowUps();
    const s = await sendDue();
    if (r.replies || r.bounces || f || s.sent || s.dryRun || s.failed)
      logger.info({ ...r, followUps: f, ...s }, 'outreach tick');
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'outreach tick failed');
  }
}

/** One test email to yourself, to check the SMTP settings (allowed even with DRY_RUN=true). */
export async function sendTestEmail(): Promise<string> {
  const problem = smtpConfigured();
  if (problem) throw new Error(problem);
  const env = getEnv();
  const profile = loadProfile().data;
  const doc = await TailoredDocModel.findOne({ status: 'ready', resumePdfPath: { $ne: null } })
    .sort({ createdAt: -1 })
    .lean();
  return sendMail({
    fromName: profile.personal.name,
    to: env.SMTP_USER!,
    subject: 'Job Autopilot: test email',
    text: 'This is a test from Job Autopilot. If you can read it, sending works.\n\nThe attachment is your latest tailored resume.',
    attachments: doc ? await attachmentFor('test', doc._id) : [],
  });
}
