import fs from 'node:fs';
import path from 'node:path';
import {
  allSkills,
  ApplicationModel,
  getEnv,
  getSettings,
  JobModel,
  loadProfile,
  loadQaBank,
  logger,
  SavedAnswerModel,
  startOfToday,
  TailoredDocModel,
  type ApplicationStatus,
} from '@ja/shared';
import { escapeHtml } from '../notify/telegram.js';
import { buildVocabulary } from '../tailor/claims.js';
import { answerFields } from './answers.js';
import { appDir, filesFor, notify } from './common.js';
import { openBrowser } from './browser.js';
import { applyTargetFor, openApplicationForm, readFormFields } from './extract.js';
import { fillForm, submitForm } from './fill.js';
import { LINK_CHANNEL, runLinkApplication } from './link.js';
import { PORTAL_CHANNELS, runPortalApplication } from '../portals/apply.js';
import type { Answer } from './types.js';

const CHANNEL = 'ats';
const FINAL: ApplicationStatus[] = ['submitted', 'skipped'];

/**
 * Reads the job's application form and works out an answer for every field. The result is an
 * Application in `ready` (nothing missing) or `needs_input` (a required question needs you).
 * Uses a headless browser: nothing is typed into the real form at this stage.
 */
export async function prepareApplication(
  jobId: string,
): Promise<{ appId: string; status: ApplicationStatus }> {
  const job = await JobModel.findById(jobId).lean();
  if (!job) throw new Error(`job ${jobId} not found`);
  const target = applyTargetFor(job);
  if (!target) throw new Error('This job has no Greenhouse, Lever or Ashby form');

  const existing = await ApplicationModel.findOne({ jobId: job._id, channel: CHANNEL }).lean();
  if (existing && FINAL.includes(existing.status))
    return { appId: String(existing._id), status: existing.status };

  const settings = await getSettings();
  const app =
    existing ??
    (await ApplicationModel.create({
      jobId: job._id,
      channel: CHANNEL,
      ats: target.ats,
      applyUrl: target.applyUrl,
      mode: settings.channels.ats.mode,
      status: 'needs_input',
    }));
  const appId = String(app._id);

  const { doc, files } = await filesFor(String(job._id), appId);
  if (!doc) throw new Error('No application kit yet: generate the resume + cover letter first');

  const profile = loadProfile().data;
  let qaBank;
  try {
    qaBank = loadQaBank().data;
  } catch {
    qaBank = { answers: [] };
  }
  const saved = await SavedAnswerModel.find().lean();

  const context = await openBrowser({ headless: true });
  try {
    const page = await context.newPage();
    await openApplicationForm(page, target);
    const fields = await readFormFields(page, target);
    const answers = await answerFields(fields, {
      profile,
      qaBank,
      saved,
      job: {
        title: job.title,
        company: job.company,
        location: job.location ?? '',
        description: job.description ?? '',
      },
      files,
      vocab: buildVocabulary(allSkills(profile)),
    });
    const status: ApplicationStatus = answers.some((a) => a.needsInput) ? 'needs_input' : 'ready';
    await ApplicationModel.updateOne(
      { _id: app._id },
      {
        $set: {
          answers,
          status,
          docId: doc._id,
          applyUrl: target.applyUrl,
          ats: target.ats,
          preparedAt: new Date(),
          error: null,
        },
      },
    );
    logger.info({ jobId, appId, status, fields: fields.length }, 'application prepared');
    return { appId, status };
  } catch (err) {
    await ApplicationModel.updateOne(
      { _id: app._id },
      { $set: { status: 'failed', error: `Preparing: ${(err as Error).message}` } },
    );
    throw err;
  } finally {
    await context.close();
  }
}

async function submittedToday(): Promise<number> {
  return ApplicationModel.countDocuments({
    channel: CHANNEL,
    status: 'submitted',
    submittedAt: { $gte: startOfToday() },
  });
}

/**
 * Fills the real form with the stored answers and submits it. Honours the kill switch, the daily
 * limit and DRY_RUN (fill + screenshot, no submit). Never submits an application twice.
 */
export async function submitApplication(appId: string): Promise<ApplicationStatus> {
  const env = getEnv();
  const settings = await getSettings();
  const app = await ApplicationModel.findById(appId);
  if (!app) throw new Error(`application ${appId} not found`);
  if (app.status === 'submitted') return 'submitted';
  if (app.channel === LINK_CHANNEL) return runLinkApplication(appId, { submit: true });
  if ((PORTAL_CHANNELS as string[]).includes(app.channel))
    return runPortalApplication(appId, { submit: true });
  if (settings.killSwitch) throw new Error('Kill switch is on');
  if (!['ready', 'approved', 'dry_run', 'needs_manual', 'failed'].includes(app.status))
    throw new Error(`Application is "${app.status}" and can't be submitted`);
  if (app.answers.some((a) => a.needsInput))
    throw new Error('Some required questions still need your answer');
  if (!env.DRY_RUN && (await submittedToday()) >= settings.channels.ats.dailyLimit)
    throw new Error(`Daily limit of ${settings.channels.ats.dailyLimit} applications reached`);

  const job = await JobModel.findById(app.jobId).lean();
  const target = job && applyTargetFor(job);
  if (!job || !target) throw new Error('Job or its form is gone');

  // Claim it, so two workers can't submit the same application.
  const claimed = await ApplicationModel.updateOne(
    { _id: app._id, status: app.status },
    { $set: { status: 'submitting', error: null }, $inc: { attempts: 1 } },
  );
  if (!claimed.modifiedCount) throw new Error('Application is already being processed');

  const dir = appDir(appId);
  fs.mkdirSync(dir, { recursive: true });
  const shots: Array<{ label: string; path: string; takenAt: Date }> = [];
  const shoot = async (page: import('playwright-core').Page, label: string) => {
    const p = path.join(dir, `${Date.now()}-${label}.png`);
    await page.screenshot({ path: p, fullPage: true }).catch(() => undefined);
    if (fs.existsSync(p)) shots.push({ label, path: p, takenAt: new Date() });
  };

  const headless = env.ATS_HEADLESS;
  const context = await openBrowser({ headless });
  let status: ApplicationStatus = 'failed';
  let error: string | undefined;
  let confirmation: string | undefined;
  try {
    const page = await context.newPage();
    await openApplicationForm(page, target);
    const fields = await readFormFields(page, target);
    const answers = app.toObject().answers as Answer[];
    // Files may have moved since preparing; refresh their paths.
    const { files } = await filesFor(String(job._id), appId);
    for (const a of answers) {
      if (a.kind !== 'file' || a.source !== 'file') continue;
      if (/cover/i.test(a.label) && files.coverLetterPdf) a.value = files.coverLetterPdf;
      else if (files.resumePdf) a.value = files.resumePdf;
    }
    const problems = await fillForm(page, fields, answers);
    await shoot(page, 'filled');
    const missing = fields.filter((f) => f.required && !answers.some((a) => a.key === f.key));

    if (problems.length || missing.length) {
      status = 'needs_manual';
      error = [...problems, ...missing.map((f) => `New required question: "${f.label}"`)].join(
        ' | ',
      );
    } else if (env.DRY_RUN) {
      status = 'dry_run';
      error = 'Filled but not submitted because DRY_RUN=true';
    } else {
      const result = await submitForm(page, {
        headless,
        captchaWaitMs: env.ATS_CAPTCHA_WAIT_SECONDS * 1000,
      });
      await shoot(page, 'after-submit');
      if (result.outcome === 'submitted') {
        status = 'submitted';
        confirmation = result.detail;
      } else {
        status = result.outcome === 'invalid' ? 'failed' : 'needs_manual';
        error = result.detail;
      }
    }
  } catch (err) {
    status = 'failed';
    error = (err as Error).message.split('\n')[0];
  } finally {
    await context.close().catch(() => undefined);
  }

  await ApplicationModel.updateOne(
    { _id: app._id },
    {
      $set: {
        status,
        error,
        confirmation,
        ...(status === 'submitted' && { submittedAt: new Date() }),
      },
      $push: { screenshots: { $each: shots } },
    },
  );
  if (status === 'submitted') {
    await JobModel.updateOne({ _id: job._id }, { $set: { status: 'applied_manually' } });
    await notify(`✅ Applied: <b>${escapeHtml(job.title)}</b> — ${escapeHtml(job.company)}`);
  } else if (status === 'needs_manual') {
    await notify(
      `⚠️ Needs you: <b>${escapeHtml(job.title)}</b> — ${escapeHtml(job.company)}\n${escapeHtml(error ?? '')}\n${escapeHtml(target.applyUrl)}`,
    );
  }
  logger.info({ appId, status, error }, 'application attempt finished');
  return status;
}

export interface AutoApplySummary {
  prepared: number;
  submitted: number;
  needsYou: number;
  errors: string[];
}

const PREPARE_PER_RUN = 5;

/**
 * After each pipeline run: prepare applications for ATS jobs that have a ready kit, then, in
 * `auto` mode, submit the ready ones within the daily limit. In `approve` mode submission waits
 * for your click in the dashboard.
 */
export async function autoApply(): Promise<AutoApplySummary> {
  const summary: AutoApplySummary = { prepared: 0, submitted: 0, needsYou: 0, errors: [] };
  const settings = await getSettings();
  const mode = settings.channels.ats.mode;
  if (settings.killSwitch || mode === 'off') return summary;

  const kitJobIds = await TailoredDocModel.distinct('jobId', { status: 'ready' });
  const haveApp = new Set(
    (await ApplicationModel.distinct('jobId', { channel: CHANNEL })).map(String),
  );
  const candidates = await JobModel.find(
    {
      _id: { $in: kitJobIds },
      status: { $in: ['scored', 'shortlisted'] },
      $or: [
        { source: { $in: ['greenhouse', 'lever', 'ashby'] } },
        { 'seenOn.source': { $in: ['greenhouse', 'lever', 'ashby'] } },
      ],
    },
    { _id: 1 },
  )
    .sort({ score: -1 })
    .lean();

  for (const c of candidates.filter((j) => !haveApp.has(String(j._id))).slice(0, PREPARE_PER_RUN)) {
    try {
      const r = await prepareApplication(String(c._id));
      summary.prepared++;
      if (r.status === 'needs_input') summary.needsYou++;
    } catch (err) {
      summary.errors.push((err as Error).message);
    }
  }

  if (mode === 'auto') {
    const ready = await ApplicationModel.find({ channel: CHANNEL, status: 'ready' })
      .sort({ preparedAt: 1 })
      .lean();
    for (const app of ready) {
      if (!getEnv().DRY_RUN && (await submittedToday()) >= settings.channels.ats.dailyLimit) break;
      try {
        const s = await submitApplication(String(app._id));
        if (s === 'submitted') summary.submitted++;
        else if (s === 'needs_manual') summary.needsYou++;
      } catch (err) {
        summary.errors.push((err as Error).message);
      }
    }
  }
  return summary;
}
