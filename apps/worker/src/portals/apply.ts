/// <reference lib="dom" />
// Applying on LinkedIn (Easy Apply) and Naukri with your own logged-in browser session.
// Every step stops on a CAPTCHA, security check or block, and pauses that site for a day.
import type { BrowserContext, Page } from 'playwright-core';
import {
  ApplicationModel,
  getEnv,
  getSettings,
  JobModel,
  PortalModel,
  questionKey,
  TaskModel,
  type ApplicationStatus,
  type PortalName,
} from '@ja/shared';
import type { StructuredCall } from '../llm/client.js';
import {
  answersForPage,
  kitAndContext,
  LINK_CHANNEL,
  recordRun,
  shooter,
  toOutcome,
} from '../apply/link.js';
import type { Answer, FormField } from '../apply/types.js';
import { walkForm, type WalkOptions, type WalkResult } from '../apply/walk.js';
import { blockedReason, markDisconnected, openPortal, pausePortal } from './session.js';

type StoredAnswer = Answer & { step?: number };

export type FlowResult =
  | WalkResult
  | { outcome: 'external'; step: number; detail: string; url: string }
  | { outcome: 'already' | 'closed' | 'logged_out' | 'blocked'; step: number; detail: string };

const settle = async (page: Page, ms = 1500) => {
  await page.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => undefined);
  await page.waitForTimeout(ms);
};

/** Clicks something that may open the company's own site in a new tab; returns that address. */
async function followExternal(
  context: BrowserContext,
  page: Page,
  click: () => Promise<void>,
): Promise<string | undefined> {
  const popup = context.waitForEvent('page', { timeout: 10_000 }).catch(() => null);
  const before = page.url();
  await click();
  let opened = await popup;
  if (!opened) {
    // LinkedIn sometimes asks first ("Continue to apply" / share profile).
    const go = page.getByRole('button', { name: /^continue|^apply$/i }).last();
    if (await go.isVisible().catch(() => false)) {
      const second = context.waitForEvent('page', { timeout: 10_000 }).catch(() => null);
      await go.click().catch(() => undefined);
      opened = await second;
    }
  }
  if (opened) {
    await opened.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => undefined);
    const url = opened.url();
    await opened.close().catch(() => undefined);
    return url;
  }
  return page.url() !== before ? page.url() : undefined;
}

// ---------------------------------------------------------------- LinkedIn

const EASY_APPLY_DIALOG =
  '.jobs-easy-apply-modal, [data-test-modal-id="easy-apply-modal"], div[role="dialog"]';

export async function linkedinFlow(
  context: BrowserContext,
  page: Page,
  walk: Omit<WalkOptions, 'root'>,
): Promise<FlowResult> {
  const r = (outcome: 'already' | 'closed' | 'logged_out', detail: string): FlowResult => ({
    outcome,
    step: 0,
    detail,
  });
  if (/\/(login|authwall|signup)/.test(new URL(page.url()).pathname))
    return r('logged_out', 'LinkedIn is asking you to sign in');
  const top = await page
    .locator('main')
    .first()
    .innerText({ timeout: 10_000 })
    .catch(() => '');
  if (/no longer accepting applications/i.test(top))
    return r('closed', 'LinkedIn: no longer accepting applications');
  if (/\bapplied (\d+ \w+|on \w+)|application submitted\b/i.test(top.slice(0, 2500)))
    return r('already', 'Already applied on LinkedIn');

  const applyButtons = page.locator('button.jobs-apply-button, a.jobs-apply-button');
  const easy = applyButtons.filter({ hasText: /easy apply/i }).first();
  if (await easy.isVisible().catch(() => false)) {
    await easy.click();
    await page
      .locator(EASY_APPLY_DIALOG)
      .first()
      .waitFor({ timeout: 15_000 })
      .catch(() => undefined);
    await page.waitForTimeout(1500);
    const result = await walkForm(context, page, { ...walk, root: EASY_APPLY_DIALOG });
    // Not sent (stopped for answers, review or DRY_RUN): close without saving a draft. Sent:
    // close the "application sent" message.
    await page
      .locator('button[aria-label="Dismiss"], button[aria-label*="Dismiss"]')
      .first()
      .click({ timeout: 5000 })
      .catch(() => undefined);
    await page
      .getByRole('button', { name: /^(discard|done|not now)$/i })
      .first()
      .click({ timeout: 5000 })
      .catch(() => undefined);
    return result;
  }

  const external = applyButtons.first();
  if (await external.isVisible().catch(() => false)) {
    const url = await followExternal(context, page, () => external.click());
    if (url && !/linkedin\.com/.test(url))
      return { outcome: 'external', step: 0, detail: 'Applies on the company site', url };
  }
  return { outcome: 'needs_manual', step: 0, detail: 'No Easy Apply or Apply button found' };
}

// ---------------------------------------------------------------- Naukri

const SUCCESS_NAUKRI =
  /successfully applied|applied successfully|you have applied|application (has been )?sent/i;
const CHATBOT = '[class*="chatbot_Drawer"], [class*="chatbot_drawer"], [class*="chatbot"]';

/** One screening question from Naukri's chat drawer, with its answer controls. */
async function readChatQuestion(page: Page) {
  const drawer = page.locator(CHATBOT).first();
  if (!(await drawer.isVisible().catch(() => false))) return null;
  return drawer.evaluate((d) => {
    const text = (e: Element | null | undefined) =>
      ((e as HTMLElement | null)?.innerText ?? '').replace(/\s+/g, ' ').trim();
    const bots = [
      ...d.querySelectorAll('[class*="botMsg"], [class*="botItem"], [class*="bot-msg"]'),
    ];
    const question = text(bots[bots.length - 1]);
    // Only the current question's controls: earlier ones stay in the chat, hidden.
    const shown = (e: Element | null | undefined) =>
      Boolean((e as HTMLElement | null)?.offsetParent);
    const inputs = [...d.querySelectorAll('input[type="radio"], input[type="checkbox"]')]
      .map((i) => {
        const id = i.getAttribute('id');
        const label = id ? d.querySelector(`label[for="${CSS.escape(id)}"]`) : i.closest('label');
        return { i, label };
      })
      .filter(({ i, label }) => shown(i) || shown(label));
    const choices = inputs.map(({ i, label }) => text(label) || (i as HTMLInputElement).value);
    const chips = [...d.querySelectorAll('[class*="chip"], [class*="Chip"]')]
      .filter((c) => (c as HTMLElement).offsetParent && !c.querySelector('[class*="chip"]'))
      .map(text)
      .filter(Boolean);
    const box = [
      ...d.querySelectorAll(
        '[contenteditable="true"], textarea, input[type="text"], input[type="number"]',
      ),
    ].find(shown);
    return {
      question,
      options: [...new Set([...choices, ...chips])].filter(Boolean),
      multi: inputs.some(({ i }) => i.getAttribute('type') === 'checkbox'),
      hasBox: Boolean(box),
    };
  });
}

export async function naukriFlow(
  context: BrowserContext,
  page: Page,
  h: {
    submit: boolean;
    dryRun: boolean;
    answer: (field: FormField) => Promise<Answer>;
    shoot: (page: Page, label: string) => Promise<void>;
  },
): Promise<FlowResult> {
  const r = (outcome: FlowResult['outcome'], detail: string, step = 0) =>
    ({ outcome, step, detail }) as FlowResult;
  if (/nlogin|login/i.test(new URL(page.url()).pathname))
    return r('logged_out', 'Naukri is asking you to log in');
  if (
    await page
      .locator('#login_Layer')
      .isVisible()
      .catch(() => false)
  )
    return r('logged_out', 'Naukri shows you as logged out');
  const body = await page
    .locator('body')
    .innerText()
    .catch(() => '');
  if (
    /already applied/i.test(body.slice(0, 4000)) ||
    (await page.locator('#already-applied').count())
  )
    return r('already', 'Already applied on Naukri');
  if (/job (has )?expired|no longer (accepting|available)/i.test(body.slice(0, 4000)))
    return r('closed', 'This Naukri job has expired');

  const companySite = page
    .locator('#company-site-button, button:has-text("Apply on company site")')
    .first();
  if (await companySite.isVisible().catch(() => false)) {
    const url = await followExternal(context, page, () => companySite.click());
    if (url && !/naukri\.com/.test(url))
      return { outcome: 'external', step: 0, detail: 'Applies on the company site', url };
    return r('needs_manual', '"Apply on company site" did not open the company page');
  }
  const apply = page.locator('#apply-button').first();
  if (!(await apply.isVisible().catch(() => false)))
    return r('needs_manual', 'No Apply button on the Naukri page');
  if (!h.submit)
    return r(
      'ready',
      'One-click apply with your Naukri profile; screening questions, if any, are answered when it applies.',
    );
  if (h.dryRun) return r('dry_run', 'Not applied because DRY_RUN=true');

  await apply.click();
  let lastQuestion = '';
  let sameCount = 0;
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(2000);
    const text = await page
      .locator('body')
      .innerText()
      .catch(() => '');
    const ok = text.match(SUCCESS_NAUKRI);
    if (ok) return r('submitted', ok[0]);
    const blocked = await blockedReason(page);
    if (blocked) return r('blocked', blocked);
    const q = await readChatQuestion(page);
    if (!q || !q.question) continue;
    if (q.question === lastQuestion) {
      if (++sameCount >= 4) {
        await h.shoot(page, 'naukri-stuck');
        return r('needs_manual', `Naukri's question didn't move on: "${q.question}"`);
      }
      continue;
    }
    sameCount = 0;
    const field: FormField = {
      key: `naukri:${questionKey(q.question) || q.question.slice(0, 40)}`,
      label: q.question,
      kind: q.options.length ? (q.multi ? 'checkboxes' : 'radio') : 'text',
      required: true,
      options: q.options.length ? q.options : undefined,
      selector: CHATBOT,
    };
    const a = await h.answer(field);
    if (a.needsInput) {
      await h.shoot(page, 'naukri-question');
      return r('needs_input', `Naukri asks: "${q.question}"`);
    }
    const drawer = page.locator(CHATBOT).first();
    const values = Array.isArray(a.value) ? a.value : [String(a.value)];
    if (q.options.length) {
      for (const v of values)
        await drawer
          .getByText(v, { exact: true })
          .first()
          .click({ timeout: 5000 })
          .catch(() => undefined);
    } else {
      const box = drawer
        .locator('[contenteditable="true"], textarea, input[type="text"], input[type="number"]')
        .filter({ visible: true })
        .first();
      await box.click({ timeout: 5000 });
      await page.keyboard.type(values.join(', '), { delay: 40 });
    }
    await page.waitForTimeout(500);
    await drawer
      .locator(
        '[class*="sendMsg"], [class*="send"], button:has-text("Save"), button:has-text("Submit")',
      )
      .last()
      .click({ timeout: 5000 })
      .catch(() => undefined);
    lastQuestion = q.question;
  }
  await h.shoot(page, 'naukri-no-confirmation');
  return r('needs_manual', 'Naukri showed no "applied" message within a minute');
}

// ---------------------------------------------------------------- Runner

export const PORTAL_CHANNELS: PortalName[] = ['linkedin', 'naukri'];

/**
 * Runs one LinkedIn / Naukri application. `submit: false` prepares it (fills and stops before
 * sending), `submit: true` sends when everything is answered (approve mode: only if you've seen
 * every answer).
 */
export async function runPortalApplication(
  appId: string,
  opts: { submit: boolean; call?: StructuredCall },
): Promise<ApplicationStatus> {
  const env = getEnv();
  const settings = await getSettings();
  const app = await ApplicationModel.findById(appId).lean();
  const name = app?.channel as PortalName;
  if (!app || !PORTAL_CHANNELS.includes(name))
    throw new Error(`portal application ${appId} not found`);
  if (app.status === 'submitted' || app.status === 'skipped') return app.status;
  if (settings.killSwitch) throw new Error('Kill switch is on');
  const portal = await PortalModel.findOne({ name }).lean();
  if (portal?.pausedUntil && portal.pausedUntil > new Date())
    throw new Error(`${name} is paused: ${portal.pauseReason ?? ''}`);
  const job = await JobModel.findById(app.jobId).lean();
  if (!job) throw new Error('The job for this application is gone');

  const working: ApplicationStatus = opts.submit ? 'submitting' : 'preparing';
  const setStatus = (status: ApplicationStatus, error?: string | null) =>
    ApplicationModel.updateOne({ _id: app._id }, { $set: { status, error } });
  await ApplicationModel.updateOne(
    { _id: app._id },
    { $set: { status: working, error: `Opening ${name}…` }, $inc: { attempts: 1 } },
  );
  const { shots, shoot } = shooter(appId);

  let result: FlowResult | undefined;
  let failure: string | undefined;
  let kitNote: string | undefined;
  const context = await openPortal(name);
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(app.applyUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await settle(page, 3000);
    const blocked = await blockedReason(page);
    if (blocked) result = { outcome: 'blocked', step: 0, detail: blocked };
    else {
      const kit = await kitAndContext(job._id, appId, (m) => setStatus(working, m));
      kitNote = kit.kitNote;
      await setStatus(working, 'Filling the application…');
      let stored = (app.answers ?? []) as StoredAnswer[];
      let sawNewAnswers = false;
      const save = async (answers: StoredAnswer[], replace: (a: StoredAnswer) => boolean) => {
        stored = [...stored.filter((a) => !replace(a)), ...answers];
        await ApplicationModel.updateOne(
          { _id: app._id },
          { $set: { answers: stored, docId: kit.doc._id } },
        );
      };
      if (name === 'linkedin') {
        result = await linkedinFlow(context, page, {
          answersFor: async (fields, step) => {
            const r = await answersForPage(fields, step, stored, kit.ctx, opts.call);
            if (r.fresh) sawNewAnswers = true;
            await save(r.answers, (a) => (a.step ?? 0) === step);
            return r.answers;
          },
          shouldSubmit: () => opts.submit && (app.mode === 'auto' || !sawNewAnswers),
          dryRun: env.DRY_RUN,
          headless: false,
          loginWaitMs: 0,
          captchaWaitMs: env.ATS_CAPTCHA_WAIT_SECONDS * 1000,
          shoot,
        });
      } else {
        result = await naukriFlow(context, page, {
          submit: opts.submit,
          dryRun: env.DRY_RUN,
          shoot,
          answer: async (field) => {
            const r = await answersForPage([field], 0, stored, kit.ctx, opts.call);
            await save(r.answers, (a) => a.key === field.key);
            return r.answers[0]!;
          },
        });
      }
      await shoot(page, 'end');
    }
  } catch (err) {
    failure = (err as Error).message.split('\n')[0];
  } finally {
    await context.close().catch(() => undefined);
  }

  // Outcomes that only exist on portals.
  if (result?.outcome === 'blocked') {
    await pausePortal(name, result.detail);
    await recordRun(
      app,
      job._id,
      { status: 'needs_manual', error: `Stopped: ${result.detail}` },
      shots,
    );
    return 'needs_manual';
  }
  if (result?.outcome === 'logged_out') {
    await markDisconnected(name);
    await recordRun(
      app,
      job._id,
      { status: 'needs_login', error: `${result.detail}. Settings → Job portals → Connect.` },
      shots,
    );
    return 'needs_login';
  }
  if (result?.outcome === 'already' || result?.outcome === 'closed') {
    if (result.outcome === 'already')
      await JobModel.updateOne({ _id: job._id }, { $set: { status: 'applied_manually' } });
    await recordRun(app, job._id, { status: 'skipped', error: result.detail }, shots);
    return 'skipped';
  }
  if (result?.outcome === 'external') {
    // The company's own form: handled as a pasted link, always shown to you before sending.
    const link = await ApplicationModel.findOneAndUpdate(
      { jobId: job._id, channel: LINK_CHANNEL },
      {
        $setOnInsert: {
          jobId: job._id,
          channel: LINK_CHANNEL,
          ats: 'website',
          applyUrl: result.url,
          mode: 'approve',
          status: 'preparing',
        },
      },
      { upsert: true, new: true },
    );
    await TaskModel.create({
      type: 'link_apply',
      payload: { appId: String(link!._id), submit: false },
      maxAttempts: 1,
    });
    await recordRun(
      app,
      job._id,
      {
        status: 'skipped',
        error: `Applies on the company site: moved to a link application (${result.url})`,
      },
      shots,
    );
    return 'skipped';
  }

  const outcome = toOutcome(result as WalkResult | undefined, failure, kitNote, opts.submit);
  await recordRun(
    app,
    job._id,
    { ...outcome, confirmation: result?.outcome === 'submitted' ? result.detail : undefined },
    shots,
  );
  if (outcome.status === 'submitted')
    await PortalModel.updateOne(
      { name },
      { $set: { lastAppliedAt: new Date() } },
      { upsert: true },
    );
  return outcome.status;
}
