/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// Walks an application form on any careers site: finds the form (clicking "Apply" if needed),
// hands logins to you, fills each page, clicks Next, and on the last page submits or stops.
import type { BrowserContext, Locator, Page } from 'playwright-core';
import { logger } from '@ja/shared';
import { NAME_SHIM, prepareContext } from './browser.js';
import { readFormFields } from './extract.js';
import { fillForm, setChecked, submitForm, visibleErrors } from './fill.js';
import type { Answer, FormField } from './types.js';

const NEXT_RE =
  /^(next|continue|save (and|&) continue|save (and|&) next|proceed|next step|continue to next step|review( (and|&) continue| application| your application)?)\b/i;
const SUBMIT_RE =
  /submit|send( my)? application|^apply( now)?$|^finish( application)?$|^complete application$/i;
const APPLY_RE =
  /^(apply manually|apply now|apply for (this|the) (job|position|role|opening)|apply to (this )?(job|position|role)|apply( here)?|start( your)? application|i'?m interested|easy apply)$/i;
const NOT_APPLY = /linkedin|indeed|seek|google|autofill|use my last|with resume/i;
const LOGIN_BUTTON_RE =
  /^(sign in|log ?in|login|continue with email|create( an)? account|sign up|register|verify|send (otp|code))$/i;
const COOKIE_RE = /^(accept( all)?( cookies)?|allow all( cookies)?|i agree|got it|ok(ay)?)$/i;
const CONSENT_LABEL = /i (have read|agree|accept|consent)|terms|privacy|declaration/i;
const CONSENT_BUTTON_RE =
  /^(accept|i accept|agree|i agree|accept (and|&) (continue|proceed)|proceed|start|begin|get started)$/i;
const OTP_LABEL = /\botp\b|one[- ]time|verification code|security code|passcode|enter (the )?code/i;
const USER_LABEL = /e-?mail|user ?name|user ?id|login|mobile|phone|\bid$/i;
const USER_KEY = /user|login|email|signin|account/i;

export type WalkResult = {
  outcome: 'needs_input' | 'ready' | 'dry_run' | 'submitted' | 'needs_login' | 'needs_manual';
  /** Form page reached (0 = first). */
  step: number;
  detail: string;
};

export interface WalkOptions {
  /** Answers for the fields on page `step`: stored ones, plus new ones worked out now. */
  answersFor: (fields: FormField[], step: number) => Promise<Answer[]>;
  /** Asked on the last page: true = click submit, false = stop there (preparing / review). */
  shouldSubmit: () => boolean;
  dryRun: boolean;
  /** A headless browser can't show you a login page, so the walk stops there instead. */
  headless: boolean;
  loginWaitMs: number;
  captchaWaitMs: number;
  onLoginWait?: () => Promise<void>;
  onLoggedIn?: () => Promise<void>;
  shoot?: (page: Page, label: string) => Promise<void>;
  maxSteps?: number;
  /**
   * CSS selector of the part of the page holding the form (e.g. a dialog). Fields and buttons are
   * looked for only inside it, and the walk never navigates away looking for a form.
   */
  root?: string;
}

const BUTTONS =
  'button, input[type="submit"], input[type="button"], [role="button"], a[role="button"]';

/**
 * Marks the last visible button (or link, for `withLinks`) whose text matches `re` and returns
 * it. Done in the page in one pass, since career sites can have hundreds of buttons.
 */
async function findButton(
  page: Page,
  tag: string,
  re: RegExp,
  opts: { exclude?: RegExp; withLinks?: boolean } = {},
): Promise<Locator | null> {
  const found = await page
    .evaluate(
      ([selector, tagName, src, flags, exSrc, exFlags]) => {
        const re = new RegExp(src!, flags);
        const ex = exSrc ? new RegExp(exSrc, exFlags) : null;
        for (const el of document.querySelectorAll(`[data-ja-btn="${tagName}"]`))
          el.removeAttribute('data-ja-btn');
        let last: Element | null = null;
        const rootSel = (window as unknown as { __jaRoot?: string }).__jaRoot;
        const scope = (rootSel && document.querySelector(rootSel)) || document;
        for (const el of scope.querySelectorAll(selector!)) {
          const r = el.getBoundingClientRect();
          const s = getComputedStyle(el);
          if (!r.width || !r.height || s.visibility === 'hidden' || s.display === 'none') continue;
          if ((el as HTMLButtonElement).disabled) continue;
          const text = (
            (el as HTMLElement).innerText ||
            (el as HTMLInputElement).value ||
            el.getAttribute('aria-label') ||
            ''
          )
            .replace(/\s+/g, ' ')
            .trim();
          if (!text || text.length > 60) continue;
          if (re.test(text) && !(ex && ex.test(text))) {
            last = el;
            // Job pages also contain Apply links for recommended jobs further down.
            if (tagName === 'apply') break;
          }
        }
        last?.setAttribute('data-ja-btn', tagName!);
        return last !== null;
      },
      [
        opts.withLinks ? `${BUTTONS}, a` : BUTTONS,
        tag,
        re.source,
        re.flags,
        opts.exclude?.source ?? '',
        opts.exclude?.flags ?? '',
      ] as const,
    )
    .catch(() => false);
  return found ? page.locator(`[data-ja-btn="${tag}"]`).first() : null;
}

async function settle(page: Page, ms = 1200): Promise<void> {
  await page.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => undefined);
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
  await page.waitForTimeout(ms);
}

/** URL plus the visible inputs: changes when the form moves to another page. */
async function signature(page: Page): Promise<string> {
  return page
    .evaluate(() => {
      const names = [...document.querySelectorAll('input, textarea, select')]
        .filter((e) => {
          const r = e.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        })
        .map((e) => e.getAttribute('name') || e.id || e.tagName)
        .join(',');
      const questions = [
        ...document.querySelectorAll(
          'legend, [role="heading"], [class*="display-text"], [class*="question-title"], [class*="questionTitle"]',
        ),
      ]
        .filter((e) => e.getBoundingClientRect().height > 0)
        .map((e) => e.textContent?.replace(/\s+/g, ' ').trim())
        .join('|');
      return `${location.href}|${names}|${questions}`;
    })
    .catch(() => page.url());
}

const fillable = (fields: FormField[]) => fields.filter((f) => f.kind !== 'checkbox');

/** A page that is (part of) an application form, rather than a job description. */
export function looksLikeForm(fields: FormField[]): boolean {
  return (
    fields.some((f) => f.kind === 'file') ||
    fillable(fields).length >= 3 ||
    (fillable(fields).length >= 2 && fields.some((f) => f.required))
  );
}

/** A password or one-time-code field: certainly a login (or sign-up) step. */
async function hasPasswordOrCode(page: Page, fields: FormField[]): Promise<boolean> {
  if (await page.locator('input[type="password"]:visible').count()) return true;
  return fields.some((x) => OTP_LABEL.test(x.label));
}

/** One or two fields (email / username / mobile) and a "Sign in"-type button. */
async function isShortSignIn(page: Page, fields: FormField[]): Promise<boolean> {
  const n = fillable(fields).length;
  if (!n || n > 2 || fields.some((x) => x.kind === 'file')) return false;
  const userish = fields.some((x) => USER_LABEL.test(x.label) || USER_KEY.test(x.key));
  if (userish && (await findButton(page, 'login', LOGIN_BUTTON_RE))) return true;
  // Two-step logins ("IBMid" + Continue, password on the next page): the page itself says so.
  return looksLikeLoginPage(page);
}

const LOGIN_TEXT =
  /\b(log ?in|sign ?in|sign-in|create an? (account|id|ibmid|profile)|forgot (your )?password)\b/i;
const LOGIN_URL =
  /[/.](login|signin|sign-in|authsvc|auth|sso|oauth2?|idp|saml|authorize|account\/login)([/.?#_-]|$)/i;

/** The page's address, title or visible headings say it's a login. */
async function looksLikeLoginPage(page: Page): Promise<boolean> {
  if (LOGIN_URL.test(new URL(page.url()).pathname + '/')) return true;
  const text = await page
    .evaluate(() =>
      [
        document.title,
        ...[...document.querySelectorAll('h1, h2, legend, [role="heading"]')]
          .filter((h) => h.getBoundingClientRect().height > 0)
          .map((h) => h.textContent ?? ''),
      ].join(' | '),
    )
    .catch(() => '');
  return LOGIN_TEXT.test(text);
}

/** Login, sign-up or one-time-code page: only you can get past these. */
export async function isLoginPage(page: Page, fields?: FormField[]): Promise<boolean> {
  const f = fields ?? (await readFormFields(page).catch(() => [] as FormField[]));
  return (await hasPasswordOrCode(page, f)) || (await isShortSignIn(page, f));
}

/** Waits until you've logged in (no login page for two checks in a row). */
async function waitForLogin(
  context: BrowserContext,
  ref: { page: Page },
  ms: number,
): Promise<boolean> {
  const deadline = Date.now() + ms;
  let clear = 0;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    if (ref.page.isClosed()) {
      const open = context.pages().filter((p) => !p.isClosed());
      if (!open.length) return false;
      ref.page = open[open.length - 1]!;
    }
    if (await isLoginPage(ref.page).catch(() => true)) clear = 0;
    else if (++clear >= 2) return true;
  }
  return false;
}

const NOT_A_FORM_FRAME =
  /recaptcha|hcaptcha|youtube|vimeo|google\.com\/maps|doubleclick|facebook|twitter|linkedin|intercom|hotjar|chat/i;

/**
 * Many careers sites embed the hiring system's form in an iframe (Greenhouse, Lever, Zoho…).
 * Returns that frame's address so the form can be opened directly.
 */
async function embeddedFormUrl(page: Page): Promise<string | null> {
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    const url = frame.url();
    if (!/^https?:/i.test(url) || NOT_A_FORM_FRAME.test(url)) continue;
    const inputs = await frame
      .locator('input:not([type="hidden"]), textarea, select')
      .count()
      .catch(() => 0);
    if (inputs >= 3) return url;
  }
  return null;
}

/** Clicks a button or link and follows it if it opens a new tab. */
async function clickAndFollow(
  context: BrowserContext,
  ref: { page: Page },
  target: Locator,
): Promise<void> {
  const popup = context.waitForEvent('page', { timeout: 5000 }).catch(() => null);
  await target.click({ timeout: 10_000 });
  const opened = await popup;
  if (opened) ref.page = opened;
  await settle(ref.page, 1500);
}

export async function walkForm(
  context: BrowserContext,
  startPage: Page,
  opts: WalkOptions,
): Promise<WalkResult> {
  const ref = { page: startPage };
  const startUrl = startPage.url();
  const maxSteps = opts.maxSteps ?? 12;
  let step = 0;
  let applyClicks = 0;
  let logins = 0;
  let wentBack = false;
  let waitedForForm = false;
  let consents = 0;
  const result = (outcome: WalkResult['outcome'], detail: string): WalkResult => ({
    outcome,
    step,
    detail,
  });

  await prepareContext(context);
  await settle(ref.page);
  await ref.page.evaluate(NAME_SHIM).catch(() => undefined);
  await ref.page
    .evaluate((r) => {
      (window as unknown as { __jaRoot?: string | null }).__jaRoot = r;
    }, opts.root ?? null)
    .catch(() => undefined);
  if (!opts.root) {
    const cookie = await findButton(ref.page, 'cookie', COOKIE_RE);
    if (cookie) await cookie.click({ timeout: 3000 }).catch(() => undefined);
  }

  for (let guard = 0; guard < maxSteps + 8; guard++) {
    const page = ref.page;
    let fields = await readFormFields(page);
    const formLike = looksLikeForm(fields);
    let login = await hasPasswordOrCode(page, fields);

    // 1. Job description page: open the form. (Checked before the weaker login signs, since a
    // description page can have a "Sign in" link and a newsletter email box.)
    if (!login && !formLike && !opts.root) {
      const framed = applyClicks < 3 ? await embeddedFormUrl(page) : null;
      if (framed) {
        applyClicks++;
        await page.goto(framed, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await settle(page);
        continue;
      }
      const apply = await findButton(page, 'apply', APPLY_RE, {
        exclude: NOT_APPLY,
        withLinks: true,
      });
      if (apply && applyClicks < 3) {
        applyClicks++;
        await clickAndFollow(context, ref, apply);
        continue;
      }
      // Privacy / terms declaration in front of the form: tick "I agree" and accept.
      if (consents < 2) {
        const boxes = fields.filter((f) => f.kind === 'checkbox' && CONSENT_LABEL.test(f.label));
        for (const b of boxes)
          await setChecked(page.locator(b.selector).first(), true).catch(() => undefined);
        const accept = await findButton(page, 'consent', CONSENT_BUTTON_RE);
        if (accept && (boxes.length || !fillable(fields).length)) {
          consents++;
          await opts.shoot?.(page, 'declaration');
          await clickAndFollow(context, ref, accept);
          continue;
        }
      }
      login = await isShortSignIn(page, fields);
    }

    // 2. Logins and one-time codes: you do these in the window.
    if (login) {
      if (opts.headless)
        return result(
          'needs_login',
          'This site needs a login. Set ATS_HEADLESS=false so a browser window opens, then try again.',
        );
      if (logins++ >= 3) return result('needs_manual', 'Still on a login page after 3 tries');
      await opts.onLoginWait?.();
      if (!(await waitForLogin(context, ref, opts.loginWaitMs)))
        return result(
          'needs_login',
          'Login was not finished in time. Press "Start again" to reopen the window.',
        );
      await opts.onLoggedIn?.();
      await settle(ref.page);
      continue;
    }

    // A page with no form and no buttons: not the application (yet).
    if (!formLike) {
      const next = await findButton(page, 'next', NEXT_RE, { exclude: SUBMIT_RE });
      const submit = await findButton(page, 'submit', SUBMIT_RE);
      // A page without a form-like set of fields, an Apply button, Next or Submit.
      if (!next && !submit) {
        // Embedded forms and single-page apps can load late: wait once more.
        if (!waitedForForm) {
          waitedForForm = true;
          await page.waitForTimeout(5000);
          continue;
        }
        // After a login some sites land on a dashboard: go back to the link once.
        if (logins && !wentBack) {
          wentBack = true;
          await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
          await settle(page);
          continue;
        }
        await opts.shoot?.(page, 'no-form');
        return result('needs_manual', `No application form found on ${page.url()}`);
      }
    }

    // 3. Fill this page.
    fields = await readFormFields(page);
    let answers: Answer[] = [];
    let settled = false;
    const applied = new Map<string, string>();
    for (let round = 0; round < 5; round++) {
      answers = await opts.answersFor(fields, step);
      const toFill = answers.filter(
        (a) => !a.needsInput && applied.get(a.key) !== JSON.stringify([a.kind, a.value]),
      );
      const problems = await fillForm(page, fields, toFill);
      if (problems.length) {
        await opts.shoot?.(page, `page-${step + 1}-problem`);
        return result('needs_manual', `Page ${step + 1}: ${problems.join(' | ')}`);
      }
      for (const a of toFill) applied.set(a.key, JSON.stringify([a.kind, a.value]));
      // Choices and pincode lookups can reveal required fields without changing the page.
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => undefined);
      const refreshed = await readFormFields(page);
      const shape = (list: FormField[]) =>
        JSON.stringify(
          list.map((f) => [
            f.key,
            f.label,
            f.kind,
            f.required,
            f.searchable ? undefined : f.options,
            f.searchable,
          ]),
        );
      if (shape(refreshed) === shape(fields)) {
        settled = true;
        break;
      }
      fields = refreshed;
      for (const key of applied.keys()) if (!fields.some((f) => f.key === key)) applied.delete(key);
    }
    if (!settled)
      return result(
        'needs_manual',
        'The form kept changing while filling; review the current questions.',
      );
    if (answers.some((a) => a.needsInput)) {
      await opts.shoot?.(page, `page-${step + 1}-questions`);
      const n = answers.filter((a) => a.needsInput).length;
      return result(
        'needs_input',
        `Page ${step + 1} of the form has ${n} question(s) only you can answer.`,
      );
    }

    // 4. Next page, or the end.
    const next = await findButton(page, 'next', NEXT_RE, { exclude: SUBMIT_RE });
    if (next) {
      if (step + 1 >= maxSteps)
        return result('needs_manual', `The form has more than ${maxSteps} pages`);
      const before = await signature(page);
      await clickAndFollow(context, ref, next);
      let moved = false;
      for (let i = 0; i < 10 && !moved; i++) {
        moved = (await signature(ref.page)) !== before;
        if (!moved) await ref.page.waitForTimeout(1000);
      }
      if (!moved) {
        const errors = await visibleErrors(ref.page);
        await opts.shoot?.(ref.page, `page-${step + 1}-stuck`);
        return result(
          'needs_manual',
          `Page ${step + 1} didn't move on after "Next"${errors.length ? `: ${errors.join(' | ')}` : ''}`,
        );
      }
      step++;
      continue;
    }

    const submit =
      (await findButton(page, 'submit', SUBMIT_RE)) ??
      ((await page.locator('button[type="submit"]:visible, input[type="submit"]:visible').count())
        ? page.locator('button[type="submit"]:visible, input[type="submit"]:visible').last()
        : null);
    if (!submit) {
      await opts.shoot?.(page, `page-${step + 1}-no-button`);
      return result('needs_manual', `Page ${step + 1}: no Next or Submit button found`);
    }
    await opts.shoot?.(page, 'filled');
    if (!opts.shouldSubmit())
      return result('ready', `All ${step + 1} page(s) filled; waiting for your approval.`);
    if (opts.dryRun)
      return result('dry_run', 'Filled every page but did not submit because DRY_RUN=true');
    const r = await submitForm(page, {
      headless: opts.headless,
      captchaWaitMs: opts.captchaWaitMs,
    });
    await opts.shoot?.(ref.page, 'after-submit');
    if (r.outcome === 'submitted') return result('submitted', r.detail);
    logger.info({ outcome: r.outcome, detail: r.detail }, 'link application submit');
    return result('needs_manual', r.detail);
  }
  return result('needs_manual', 'Gave up: the form kept looping');
}
