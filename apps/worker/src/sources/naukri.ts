/// <reference lib="dom" />
// Naukri jobs, read from Naukri's own search pages (and your recommended jobs when you're logged
// in). Naukri blocks headless browsers, so this runs in a visible Chrome window on your computer,
// at most twice a day, slowly, and stops at the first sign of a block.
import { JobModel, PortalModel, type SalaryDto } from '@ja/shared';
import {
  blockedReason,
  isLoggedIn,
  openPortal,
  pausePortal,
  portalsUnavailable,
} from '../portals/session.js';
import type { JobSource, RawJob } from './types.js';

const MAX_SEARCH_PAGES = 6;
const MAX_DETAIL_PAGES = 30;

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/** "3-6 Lacs PA" → 300000–600000 INR a year. */
export function parseNaukriSalary(text: string): SalaryDto | undefined {
  const m = text.match(/([\d.]+)\s*-\s*([\d.]+)\s*lacs?/i);
  if (!m) return undefined;
  return {
    min: Number(m[1]) * 100_000,
    max: Number(m[2]) * 100_000,
    currency: 'INR',
    period: 'year',
  };
}

/** "Just now", "Few hours ago", "3 days ago", "2 weeks ago", "30+ days ago" → a date. */
export function parseNaukriAge(text: string, now = new Date()): Date | undefined {
  const t = text.toLowerCase();
  if (/just now|today|few hours|hour/.test(t)) return now;
  const m = t.match(/(\d+)\+?\s*(day|week|month)/);
  if (!m) return undefined;
  const days = Number(m[1]) * (m[2] === 'week' ? 7 : m[2] === 'month' ? 30 : 1);
  return new Date(now.getTime() - days * 86_400_000);
}

interface Card {
  id: string;
  url: string;
  title: string;
  company: string;
  location: string;
  experience: string;
  salary: string;
  snippet: string;
  skills: string[];
  age: string;
}

const pause = (min: number, max: number) =>
  new Promise((r) => setTimeout(r, min + Math.random() * (max - min)));

export const naukriSource: JobSource = {
  name: 'naukri',
  minIntervalHours: 10,
  unavailableReason: () => portalsUnavailable(),
  async fetch(ctx) {
    const warnings: string[] = [];
    const portal = await PortalModel.findOne({ name: 'naukri' }).lean();
    if (portal?.pausedUntil && portal.pausedUntil > new Date())
      return { jobs: [], warnings: [`Naukri paused: ${portal.pauseReason ?? ''}`] };

    const prefs = ctx.profile.preferences;
    const keywords = (prefs.searchKeywords.length ? prefs.searchKeywords : prefs.roles)
      .filter((k) => !/\b(batch|passout)\b/i.test(k))
      .slice(0, 3);
    const cities = prefs.locations.slice(0, 2);
    const exp = Math.max(0, Math.round(ctx.profile.totalExperienceYears));
    const urls = keywords
      .flatMap((k) =>
        cities.map((c) => `https://www.naukri.com/${slug(k)}-jobs-in-${slug(c)}?experience=${exp}`),
      )
      .slice(0, MAX_SEARCH_PAGES);

    const context = await openPortal('naukri');
    const cards = new Map<string, Card>();
    try {
      if (await isLoggedIn(context, 'naukri'))
        urls.unshift('https://www.naukri.com/mnjuser/recommendedjobs');
      const page = context.pages()[0] ?? (await context.newPage());
      for (const url of urls) {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await page.waitForTimeout(4000);
        const blocked = await blockedReason(page);
        if (blocked) {
          await pausePortal('naukri', blocked);
          warnings.push(`stopped: ${blocked}`);
          break;
        }
        const found = (await page.evaluate(() =>
          [...document.querySelectorAll('[data-job-id]')].map((c) => {
            const q = (s: string) =>
              (c.querySelector(s) as HTMLElement | null)?.innerText.trim() ?? '';
            const a = c.querySelector(
              'a.title, a[href*="job-listings"]',
            ) as HTMLAnchorElement | null;
            return {
              id: c.getAttribute('data-job-id') ?? '',
              url: a?.href ?? '',
              title: a?.getAttribute('title') || a?.innerText.trim() || '',
              company: q('.comp-name') || q('[class*="comp-name"]'),
              location: q('.locWdth') || q('[class*="loc"]'),
              experience: q('.expwdth') || q('[class*="exp"]'),
              salary: q('.sal-wrap') || q('[class*="sal"]'),
              snippet: q('.job-desc') || q('[class*="job-desc"]'),
              skills: [...c.querySelectorAll('.tags-gt li, [class*="tag"] li')].map((li) =>
                (li as HTMLElement).innerText.trim(),
              ),
              age: q('.job-post-day') || q('[class*="post-day"]'),
            };
          }),
        )) as Card[];
        for (const c of found) if (c.id && c.url && c.title) cards.set(c.id, c);
        await pause(2000, 5000);
      }

      // Full descriptions for jobs not seen before (the card has only a line of text).
      const known = new Set(
        (
          await JobModel.find(
            { source: 'naukri', sourceJobId: { $in: [...cards.keys()] } },
            { sourceJobId: 1 },
          ).lean()
        ).map((j) => j.sourceJobId),
      );
      const fresh = [...cards.values()].filter((c) => !known.has(c.id)).slice(0, MAX_DETAIL_PAGES);
      const details = new Map<string, string>();
      for (const c of fresh) {
        try {
          await page.goto(c.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
          await page.waitForTimeout(2500);
          const blocked = await blockedReason(page);
          if (blocked) {
            await pausePortal('naukri', blocked);
            warnings.push(`stopped: ${blocked}`);
            break;
          }
          details.set(
            c.id,
            await page.evaluate(() =>
              [
                ...document.querySelectorAll(
                  '[class*="job-desc-container"], [class*="key-skill"], [class*="other-details"]',
                ),
              ]
                .map((e) => (e as HTMLElement).innerText.trim())
                .join('\n\n'),
            ),
          );
        } catch (err) {
          warnings.push(`${c.url}: ${(err as Error).message.split('\n')[0]}`);
        }
        await pause(2000, 4500);
      }

      const jobs: RawJob[] = [...cards.values()]
        .filter((c) => !known.has(c.id))
        .map((c) => {
          const full = details.get(c.id);
          return {
            source: 'naukri',
            sourceJobId: c.id,
            url: c.url.split('?')[0]!,
            company: c.company || 'Unknown company',
            title: c.title,
            location: c.location,
            countryHint: 'IN',
            description: [
              full || c.snippet,
              c.skills.length ? `Key skills: ${c.skills.join(', ')}` : '',
              c.experience ? `Experience: ${c.experience}` : '',
            ]
              .filter(Boolean)
              .join('\n\n'),
            descriptionTruncated: !full,
            postedAt: parseNaukriAge(c.age),
            salary: parseNaukriSalary(c.salary),
          };
        });
      return { jobs, warnings };
    } finally {
      await context.close().catch(() => undefined);
    }
  },
};
