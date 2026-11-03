/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// Applications from a link you paste: any company's careers site, any number of form pages.
// The worker reads the job from the page, makes the resume kit, fills the form page by page,
// stops for logins (you log in in the window) and for questions only you can answer, and
// submits at the end (after your approval, unless you asked it to submit by itself).
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright-core';
import {
  allSkills,
  ApplicationModel,
  companyFromUrl,
  getEnv,
  getSettings,
  JobModel,
  LINK_JOB_TITLE,
  llmEnabled,
  loadProfile,
  loadQaBank,
  logger,
  SavedAnswerModel,
  type ApplicationStatus,
} from '@ja/shared';
import type { StructuredCall } from '../llm/client.js';
import { escapeHtml } from '../notify/telegram.js';
import { buildVocabulary } from '../tailor/claims.js';
import { tailorJob } from '../tailor/index.js';
import { answerFields, conform, knownAnswer, ruleAnswer, type AnswerContext } from './answers.js';
import { openBrowser } from './browser.js';
import { appDir, filesFor, notify } from './common.js';
import type { Answer, FillFiles, FormField } from './types.js';
import { isLoginPage, walkForm, type WalkResult } from './walk.js';

export const LINK_CHANNEL = 'link';

type StoredAnswer = Answer & { step?: number };

const isEmpty = (a: { value: Answer['value']; kind: string }) =>
  a.value === '' ||
  (Array.isArray(a.value) && a.value.length === 0) ||
  (a.kind === 'checkbox' && a.value === false);

/** Model that answers nothing: used when the LLM is off or over its daily cap. */
const noLlm = (async () => ({ answers: [] })) as unknown as StructuredCall;

/**
 * Answers for one page: reuses what is stored for that page (matched by field key, then by
 * label, since some sites generate new ids on every load) and works out the rest.
 */
export async function answersForPage(
  fields: FormField[],
  step: number,
  stored: StoredAnswer[],
  ctx: AnswerContext,
  call?: StructuredCall,
): Promise<{ answers: StoredAnswer[]; fresh: boolean }> {
  const pool = stored.filter((a) => (a.step ?? 0) === step);
  const used = new Set<StoredAnswer>();
  const reused = new Map<string, StoredAnswer>();
  const missing: FormField[] = [];
  for (const f of fields) {
    const prev =
      pool.find(
        (a) =>
          !used.has(a) &&
          a.key === f.key &&
          a.kind === f.kind &&
          (!a.label || a.label.toLowerCase() === f.label.toLowerCase()),
      ) ??
      pool.find(
        (a) =>
          !used.has(a) &&
          a.label &&
          a.label === f.label &&
          a.kind === f.kind &&
          (a.section ?? '') === (f.section ?? ''),
      );
    if (prev) used.add(prev);
    // Nothing usable stored (blank, and not your answer): work it out again, since the page may
    // be read better now or a saved answer may exist.
    const currentRule =
      prev?.source === 'profile'
        ? ruleAnswer(f, ctx)
        : prev?.source === 'saved'
          ? knownAnswer(f, ctx)
          : undefined;
    const currentValue = currentRule ? conform(f, currentRule.value) : undefined;
    const choices = [
      'select',
      'multiselect',
      'radio',
      'checkboxes',
      'buttons',
      'combobox',
    ].includes(f.kind);
    const values = prev && (Array.isArray(prev.value) ? prev.value : [String(prev.value)]);
    const invalidChoice =
      choices &&
      !(f.kind === 'combobox' && f.searchable) &&
      f.options?.length &&
      values?.some((v) => v && !f.options!.includes(v));
    if (
      !prev ||
      (prev.source === 'llm' && !ctx.profile.preferences.allowGeneratedApplicationAnswers) ||
      (isEmpty(prev) && prev.source !== 'user') ||
      invalidChoice ||
      (currentValue &&
        (!currentValue.ok || JSON.stringify(currentValue.value) !== JSON.stringify(prev.value)))
    ) {
      missing.push(f);
      continue;
    }
    reused.set(f.key, {
      ...prev,
      key: f.key,
      label: f.label,
      section: f.section,
      options: f.options,
      required: f.required,
      step,
      needsInput: f.required && isEmpty(prev),
    });
  }
  let fresh: Answer[] = [];
  if (missing.length) {
    try {
      fresh = await answerFields(missing, ctx, call);
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'LLM unavailable for form answers');
      fresh = await answerFields(missing, ctx, noLlm);
    }
  }
  const freshByKey = new Map(fresh.map((a) => [a.key, a]));
  const answers = fields.map((f) => reused.get(f.key) ?? { ...freshByKey.get(f.key)!, step });
  return { answers, fresh: missing.length > 0 };
}

/** The current file paths for upload fields (files are copied per application). */
function withFiles(answers: StoredAnswer[], files: FillFiles): StoredAnswer[] {
  return answers.map((a) => {
    if (a.kind !== 'file' || a.source !== 'file') return a;
    if (/cover/i.test(a.label) && files.coverLetterPdf)
      return { ...a, value: files.coverLetterPdf };
    return files.resumePdf ? { ...a, value: files.resumePdf } : a;
  });
}

interface PageInfo {
  /** document.title */
  title: string;
  /** og:title, when the page has one */
  og?: string;
  h1: string;
  siteName: string;
  text: string;
}

async function readPageInfo(page: Page): Promise<PageInfo> {
  return page.evaluate(() => {
    const h1 = [...document.querySelectorAll('h1')].find((h) => h.getBoundingClientRect().height);
    const meta = (p: string) =>
      document.querySelector(`meta[property="${p}"]`)?.getAttribute('content') ?? '';
    return {
      title: document.title,
      og: meta('og:title').trim(),
      h1: (h1?.textContent ?? '').replace(/\s+/g, ' ').trim(),
      siteName: meta('og:site_name').trim(),
      text: (document.body?.innerText ?? '').slice(0, 20_000),
    };
  });
}

const GENERIC_HEADING =
  /^(careers?|jobs?|job (details|description|opening)|apply|application|join us|open positions?|welcome|surveys?|forms?|privacy (statement|policy|notice)|data privacy( declaration)?|terms( (and|&) conditions)?|declaration|sign ?in|log ?in|register|registration)$/i;

/** Job title from the page: the main heading, else the page title before " | Company". */
export function titleFromPage(info: Pick<PageInfo, 'title' | 'h1' | 'og'>): string | undefined {
  const ok = (t: string) => t.length >= 3 && t.length <= 120 && !GENERIC_HEADING.test(t);
  const segments = info.title.split(/\s+[|–—-]\s+/).map((x) => x.trim());
  // A heading that is just the site's brand ("IBM" in "Software Engineer - 1234 - IBM").
  const brand =
    segments.length > 1 && segments.some((x) => x.toLowerCase() === info.h1.toLowerCase());
  if (ok(info.h1) && !brand) return info.h1;
  if (info.og && ok(info.og)) return info.og;
  return ok(segments[0] ?? '') ? segments[0] : undefined;
}

const norm = (s: string, keep: RegExp) =>
  s.toLowerCase().replace(keep, ' ').replace(/\s+/g, ' ').trim();

/** First visit: store the job's title, company and description from the page. */
async function learnJob(page: Page, jobId: unknown): Promise<void> {
  const job = await JobModel.findById(jobId).lean();
  if (!job || (job.description ?? '').length >= 200) return;
  if (await isLoginPage(page)) return;
  const info = await readPageInfo(page);
  const set: Record<string, unknown> = {};
  if (info.text.trim().length >= 200) {
    set.description = info.text.trim();
    set.descriptionQuality = 'full';
  }
  const title = job.title === LINK_JOB_TITLE ? titleFromPage(info) : undefined;
  if (title) {
    set.title = title;
    set.titleNorm = norm(title, /[^a-z0-9+# ]+/g);
  }
  if (info.siteName && job.company === companyFromUrl(job.url) && info.siteName.length <= 80) {
    set.company = info.siteName;
    set.companyNorm = norm(info.siteName, /[^a-z0-9 ]+/g);
  }
  if (Object.keys(set).length) await JobModel.updateOne({ _id: job._id }, { $set: set });
}

/**
 * Runs (or continues) a pasted-link application. `submit: false` prepares: fills every page it
 * can and stops on the last one. `submit: true` submits at the end when allowed: in approve
 * mode only if you've already seen every answer, in auto mode as soon as all are answered.
 */
export async function runLinkApplication(
  appId: string,
  opts: { submit: boolean; call?: StructuredCall },
): Promise<ApplicationStatus> {
  const env = getEnv();
  const settings = await getSettings();
  const app = await ApplicationModel.findById(appId).lean();
  if (!app || app.channel !== LINK_CHANNEL) throw new Error(`link application ${appId} not found`);
  if (app.status === 'submitted' || app.status === 'skipped') return app.status;
  if (settings.killSwitch) throw new Error('Kill switch is on');
  const job = await JobModel.findById(app.jobId).lean();
  if (!job) throw new Error('The job for this application is gone');

  const working: ApplicationStatus = opts.submit ? 'submitting' : 'preparing';
  const setStatus = (status: ApplicationStatus, error?: string | null) =>
    ApplicationModel.updateOne({ _id: app._id }, { $set: { status, error } });
  await ApplicationModel.updateOne(
    { _id: app._id },
    { $set: { status: working, error: 'Opening the link…' }, $inc: { attempts: 1 } },
  );

  const { shots, shoot } = shooter(appId);

  const headless = env.ATS_HEADLESS;
  const context = await openBrowser({ headless, profile: 'links' });
  let result: WalkResult | undefined;
  let kitNote: string | undefined;
  let failure: string | undefined;
  try {
    const page = await context.newPage();
    await page.goto(app.applyUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);
    await learnJob(page, job._id);

    const {
      doc,
      files,
      ctx,
      kitNote: note,
    } = await kitAndContext(job._id, appId, (m) => setStatus(working, m));
    kitNote = note;
    await setStatus(working, 'Filling the form…');
    const fresh = (await JobModel.findById(job._id).lean()) ?? job;

    let stored = (app.answers ?? []) as StoredAnswer[];
    let sawNewAnswers = false;
    result = await walkForm(context, page, {
      answersFor: async (fields, step) => {
        const r = await answersForPage(fields, step, stored, ctx, opts.call);
        if (r.fresh) sawNewAnswers = true;
        const answers = withFiles(r.answers, files);
        stored = [...stored.filter((a) => (a.step ?? 0) !== step), ...answers];
        await ApplicationModel.updateOne(
          { _id: app._id },
          { $set: { answers: stored, docId: doc._id } },
        );
        return answers;
      },
      shouldSubmit: () => opts.submit && (app.mode === 'auto' || !sawNewAnswers),
      dryRun: env.DRY_RUN,
      headless,
      loginWaitMs: env.ATS_LOGIN_WAIT_SECONDS * 1000,
      captchaWaitMs: env.ATS_CAPTCHA_WAIT_SECONDS * 1000,
      onLoginWait: async () => {
        await setStatus(
          'needs_login',
          `Log in (or create an account) in the Chrome window that opened. The form continues by itself once you're in; waiting up to ${Math.round(env.ATS_LOGIN_WAIT_SECONDS / 60)} min.`,
        );
        await notify(
          `🔐 Login needed: <b>${escapeHtml(fresh.company)}</b> — log in in the Chrome window on your computer. The application continues after that.`,
        );
      },
      onLoggedIn: async () => {
        await setStatus(working, 'Logged in; filling the form…');
      },
      shoot,
    });
  } catch (err) {
    failure = (err as Error).message.split('\n')[0];
  } finally {
    await context.close().catch(() => undefined);
  }

  const { status, error } = toOutcome(result, failure, kitNote, opts.submit);
  await recordRun(
    app,
    job._id,
    { status, error, confirmation: result?.outcome === 'submitted' ? result.detail : undefined },
    shots,
  );
  logger.info({ appId, status, error }, 'link application run finished');
  return status;
}

/** Screenshots for an application, kept under ~/.job-autopilot/output/applications/<id>. */
export function shooter(appId: string) {
  const dir = appDir(appId);
  fs.mkdirSync(dir, { recursive: true });
  const shots: Array<{ label: string; path: string; takenAt: Date }> = [];
  const shoot = async (page: Page, label: string) => {
    const p = path.join(dir, `${Date.now()}-${label}.png`);
    await page.screenshot({ path: p, fullPage: true }).catch(() => undefined);
    if (fs.existsSync(p)) shots.push({ label, path: p, takenAt: new Date() });
  };
  return { shots, shoot };
}

/**
 * The resume kit to upload and everything answers are worked out from. Makes a tailored resume
 * when the job has none; if that can't be done (LLM off or over its daily cap), the most recent
 * resume made for another job is used and `kitNote` says so.
 */
export async function kitAndContext(
  jobId: unknown,
  appId: string,
  onStatus: (message: string) => Promise<unknown>,
) {
  const job = await JobModel.findById(jobId).lean();
  if (!job) throw new Error('The job for this application is gone');
  let kitNote: string | undefined;
  let { doc, files } = await filesFor(String(job._id), appId);
  if (!doc) {
    // A tailored resume for this job; if that can't be made (LLM off or over its daily cap),
    // the most recent resume made for another job is used instead.
    let why = 'the LLM is off';
    if (llmEnabled()) {
      await onStatus('Making a tailored resume for this job…');
      try {
        await tailorJob(String(job._id), 'manual');
      } catch (err) {
        why = (err as Error).message.split('\n')[0]!;
      }
    }
    ({ doc, files } = await filesFor(String(job._id), appId, { anyJob: true }));
    if (!doc) throw new Error(`No resume to upload: a tailored one couldn't be made (${why})`);
    if (doc.jobId && String(doc.jobId) !== String(job._id))
      kitNote = `Uploaded your latest resume (made for another job) because a tailored one couldn't be made: ${why}`;
  }
  const fresh = (await JobModel.findById(job._id).lean()) ?? job;
  const profile = loadProfile().data;
  let qaBank;
  try {
    qaBank = loadQaBank().data;
  } catch {
    qaBank = { answers: [] };
  }
  const ctx: AnswerContext = {
    profile,
    qaBank,
    saved: await SavedAnswerModel.find().lean(),
    job: {
      title: fresh.title,
      company: fresh.company,
      location: fresh.location ?? '',
      description: fresh.description ?? '',
    },
    files,
    vocab: buildVocabulary(allSkills(profile)),
  };

  return { doc, files, ctx, kitNote };
}

/** Maps a form walk (or a failure) to the application's status and message. */
export function toOutcome(
  result: WalkResult | undefined,
  failure: string | undefined,
  kitNote: string | undefined,
  submit: boolean,
): { status: ApplicationStatus; error: string | null } {
  if (failure || !result) return { status: 'failed', error: failure ?? 'Stopped unexpectedly' };
  const status = result.outcome as ApplicationStatus;
  let error: string | null = status === 'submitted' ? null : result.detail;
  if (status === 'ready' && submit)
    error = 'New pages were filled since you last looked: check the answers and approve again.';
  if (kitNote && status !== 'submitted') error = [error, kitNote].filter(Boolean).join(' · ');
  return { status, error };
}

/** Stores the outcome of a run, marks the job applied, and tells you on Telegram. */
export async function recordRun(
  app: { _id: unknown; applyUrl: string; channel: string },
  jobId: unknown,
  outcome: { status: ApplicationStatus; error: string | null; confirmation?: string },
  shots: Array<{ label: string; path: string; takenAt: Date }>,
): Promise<void> {
  const { status, error, confirmation } = outcome;
  await ApplicationModel.updateOne(
    { _id: app._id },
    {
      $set: {
        status,
        error,
        confirmation,
        preparedAt: new Date(),
        ...(status === 'submitted' && { submittedAt: new Date() }),
      },
      $push: { screenshots: { $each: shots } },
    },
  );
  const job = await JobModel.findById(jobId).lean();
  const name = job ? `<b>${escapeHtml(job.title)}</b> — ${escapeHtml(job.company)}` : 'a job';
  const where =
    app.channel === 'linkedin' ? ' (LinkedIn)' : app.channel === 'naukri' ? ' (Naukri)' : '';
  if (status === 'submitted') {
    await JobModel.updateOne({ _id: jobId }, { $set: { status: 'applied_manually' } });
    await notify(`✅ Applied${where}: ${name}`);
  } else if (status === 'needs_input')
    await notify(`❓ ${name}${where}
${escapeHtml(error ?? '')}
Dashboard → Applications`);
  else if (status === 'ready')
    await notify(`📝 Ready to approve${where}: ${name}
Dashboard → Applications`);
  else if (status !== 'dry_run' && status !== 'skipped')
    await notify(`⚠️ Needs you${where}: ${name}
${escapeHtml(error ?? '')}
${escapeHtml(app.applyUrl)}`);
  logger.info({ appId: String(app._id), status, error }, 'application run finished');
}
