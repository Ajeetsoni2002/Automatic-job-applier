import fs from 'node:fs';
import path from 'node:path';
import type { BrowserContext } from 'playwright-core';
import { appHome, getEnv } from '@ja/shared';

/**
 * tsx/esbuild wrap named functions in `__name(fn, "name")`. Functions passed to page.evaluate
 * run in the page, where that helper doesn't exist: define a no-op one there.
 */
export const NAME_SHIM = 'globalThis.__name = globalThis.__name || ((f) => f);';

/** Adds the shim to every page of the context, and to pages that are already open. */
export async function prepareContext(context: BrowserContext): Promise<void> {
  await context.addInitScript(NAME_SHIM);
  for (const p of context.pages()) await p.evaluate(NAME_SHIM).catch(() => undefined);
}

/**
 * Separate from your everyday Chrome profile; cookies persist between runs, which helps CAPTCHAs
 * and keeps you logged in to career sites. `links` is used for links you paste, so it can run
 * while the ATS profile is busy (Chrome locks a profile to one window).
 */
export type BrowserProfile = 'ats' | 'links' | 'linkedin' | 'naukri';
export const atsProfileDir = (profile: BrowserProfile = 'ats') =>
  path.join(appHome(), 'browser-profiles', profile);

/**
 * Opens Chrome (or Edge) with the persistent ATS profile. Visible by default so a CAPTCHA can be
 * solved by hand; set ATS_HEADLESS=true on a server.
 */
export async function openBrowser(
  opts: { headless?: boolean; profile?: BrowserProfile } = {},
): Promise<BrowserContext> {
  const { chromium } = await import('playwright-core');
  const headless = opts.headless ?? getEnv().ATS_HEADLESS;
  const dir = atsProfileDir(opts.profile);
  fs.mkdirSync(dir, { recursive: true });
  const errors: string[] = [];
  for (const channel of ['chrome', 'msedge', undefined] as const) {
    try {
      const context = await chromium.launchPersistentContext(dir, {
        headless,
        channel,
        viewport: { width: 1280, height: 900 },
        locale: 'en-IN',
        timezoneId: getEnv().TZ,
      });
      await prepareContext(context);
      return context;
    } catch (err) {
      errors.push((err as Error).message.split('\n')[0]!);
    }
  }
  throw new Error(`Could not start a browser for applications: ${errors.join(' | ')}`);
}
