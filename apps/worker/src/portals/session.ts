/// <reference lib="dom" />
// Your own browser sessions on LinkedIn and Naukri. You log in yourself, once, in the window this
// opens; the session stays in a separate Chrome profile per site. Nothing here types a password.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import type { BrowserContext, Page } from 'playwright-core';
import {
  ApplicationModel,
  getEnv,
  logger,
  PortalModel,
  startOfToday,
  type PortalDto,
  type PortalName,
} from '@ja/shared';
import { escapeHtml } from '../notify/telegram.js';
import { atsProfileDir, openBrowser } from '../apply/browser.js';
import { captchaChallengeVisible } from '../apply/fill.js';
import { notify } from '../apply/common.js';

export const PORTALS: Record<PortalName, { label: string; home: string; login: string }> = {
  linkedin: {
    label: 'LinkedIn',
    home: 'https://www.linkedin.com/feed/',
    login: 'https://www.linkedin.com/login',
  },
  naukri: {
    label: 'Naukri',
    home: 'https://www.naukri.com/mnjuser/homepage',
    login: 'https://www.naukri.com/nlogin/login',
  },
};

/** Portals need a visible browser on your own computer: they block headless browsers. */
export function portalsUnavailable(): string | undefined {
  return getEnv().ATS_HEADLESS
    ? 'LinkedIn and Naukri need a visible browser on your computer (ATS_HEADLESS=false)'
    : undefined;
}

export function openPortal(name: PortalName): Promise<BrowserContext> {
  return openBrowser({ headless: false, profile: name });
}

/** Logged in = the site's members-only home page opens without sending you to a login page. */
export async function isLoggedIn(context: BrowserContext, name: PortalName): Promise<boolean> {
  if (name === 'linkedin') {
    const cookies = await context.cookies('https://www.linkedin.com');
    if (!cookies.some((c) => c.name === 'li_at' && c.value)) return false;
  }
  const page = await context.newPage();
  try {
    await page.goto(PORTALS[name].home, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForTimeout(2500);
    return !/login|signin|authwall|checkpoint|nlogin/i.test(new URL(page.url()).pathname);
  } catch {
    return false;
  } finally {
    await page.close().catch(() => undefined);
  }
}

const BLOCK_TEXT =
  /access denied|security (check|verification)|verify (you are|you're) (a )?human|unusual activity|are you a robot|let'?s do a quick security check|too many requests/i;

/**
 * Anything that says "stop": a CAPTCHA, a security checkpoint, an access-denied page, or a rate
 * limit. Returns the reason, or undefined when the page looks normal.
 */
export async function blockedReason(page: Page): Promise<string | undefined> {
  const url = page.url();
  if (/\/checkpoint\/|\/authwall|captcha/i.test(url)) return `security check at ${url}`;
  const head = await page
    .evaluate(() => `${document.title} ${document.body?.innerText.slice(0, 1500) ?? ''}`)
    .catch(() => '');
  const m = head.match(BLOCK_TEXT);
  if (m) return `"${m[0]}" on ${new URL(url).hostname}`;
  // Sites load an invisible reCAPTCHA badge on every page; only a challenge on screen counts.
  if (await captchaChallengeVisible(page).catch(() => false))
    return `CAPTCHA on ${new URL(url).hostname}`;
  const arkose = page.locator('iframe[src*="arkoselabs"], iframe[src*="funcaptcha"]');
  const n = await arkose.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    const box = await arkose
      .nth(i)
      .boundingBox()
      .catch(() => null);
    if (box && box.width > 100 && box.height > 100) return `CAPTCHA on ${new URL(url).hostname}`;
  }
  return undefined;
}

/** Stops applying on a site for a while and tells you why. */
export async function pausePortal(name: PortalName, reason: string, hours = 24): Promise<void> {
  const until = new Date(Date.now() + hours * 3_600_000);
  await PortalModel.updateOne(
    { name },
    { $set: { pausedUntil: until, pauseReason: reason } },
    { upsert: true },
  );
  logger.warn({ portal: name, reason, until }, 'portal paused');
  await notify(
    `⛔ ${PORTALS[name].label} paused for ${hours}h: ${escapeHtml(reason)}\nNothing more is sent there until then (Settings → Job portals to resume).`,
  );
}

export async function markDisconnected(name: PortalName): Promise<void> {
  await PortalModel.updateOne(
    { name },
    { $set: { connected: false, checkedAt: new Date() } },
    { upsert: true },
  );
  await notify(
    `🔐 ${PORTALS[name].label} is logged out. Dashboard → Settings → Job portals → Connect, and log in in the window.`,
  );
}

const CHROME_PATHS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  `${process.env.LOCALAPPDATA ?? ''}/Google/Chrome/Application/chrome.exe`,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

async function checkLogin(name: PortalName): Promise<boolean> {
  const context = await openPortal(name);
  try {
    return await isLoggedIn(context, name);
  } finally {
    await context.close().catch(() => undefined);
  }
}

/**
 * Logging in happens in a plain Chrome window (not one driven by automation), using the same
 * profile folder the applications use later: sites such as LinkedIn quietly refuse logins from
 * automated browsers. You log in, close the window, and the session is checked.
 * Waits up to ATS_LOGIN_WAIT_SECONDS for the window to be closed.
 */
export async function connectPortal(name: PortalName): Promise<boolean> {
  const problem = portalsUnavailable();
  if (problem) throw new Error(problem);
  let ok = await checkLogin(name);
  if (!ok) {
    const chrome = CHROME_PATHS.find((p) => fs.existsSync(p));
    if (!chrome) throw new Error('Chrome (or Edge) was not found on this computer');
    const child = spawn(
      chrome,
      [
        `--user-data-dir=${atsProfileDir(name)}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--new-window',
        PORTALS[name].login,
      ],
      { stdio: 'ignore' },
    );
    await notify(
      `🔐 A Chrome window with ${PORTALS[name].label} opened on your computer: log in there (OTP / CAPTCHA included), then <b>close that window</b>.`,
    );
    const closed = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), getEnv().ATS_LOGIN_WAIT_SECONDS * 1000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve(true);
      });
      child.once('error', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    if (!closed) child.kill();
    // Chrome needs a moment to write the profile to disk after closing.
    await new Promise((r) => setTimeout(r, 3000));
    ok = await checkLogin(name);
  }
  await PortalModel.updateOne(
    { name },
    { $set: { connected: ok, checkedAt: new Date() } },
    { upsert: true },
  );
  await notify(
    ok
      ? `✅ ${PORTALS[name].label} connected.`
      : `❌ ${PORTALS[name].label} login was not found. Try Connect again, and close the window only after you see your ${PORTALS[name].label} home page.`,
  );
  return ok;
}

export async function portalStates(): Promise<PortalDto[]> {
  const docs = await PortalModel.find().lean();
  const out: PortalDto[] = [];
  for (const name of ['linkedin', 'naukri'] as const) {
    const d = docs.find((x) => x.name === name);
    out.push({
      name,
      connected: Boolean(d?.connected),
      checkedAt: d?.checkedAt?.toISOString(),
      pausedUntil:
        d?.pausedUntil && d.pausedUntil > new Date() ? d.pausedUntil.toISOString() : undefined,
      pauseReason:
        d?.pausedUntil && d.pausedUntil > new Date() ? (d.pauseReason ?? undefined) : undefined,
      lastAppliedAt: d?.lastAppliedAt?.toISOString(),
      appliedToday: await ApplicationModel.countDocuments({
        channel: name,
        status: 'submitted',
        submittedAt: { $gte: startOfToday() },
      }),
    });
  }
  return out;
}
