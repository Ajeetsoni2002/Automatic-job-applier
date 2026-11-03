import fs from 'node:fs';
import type { Page } from 'playwright-core';
import { logger, type AtsType } from '@ja/shared';
import { createHttpClient } from '../http.js';
import type { FormField } from './types.js';
import { dropdownOptions, dropdownSearchInput, markExistingOptions } from './dropdown.js';

const EXTRACT_SCRIPT = fs.readFileSync(
  new URL('./extract-fields.browser.js', import.meta.url),
  'utf8',
);
const MAX_OPTIONS = 400;

export interface ApplyTarget {
  ats: AtsType;
  /** Page that shows the application form. */
  applyUrl: string;
  /** Greenhouse: board slug and numeric job id, for the questions API. */
  greenhouse?: { slug: string; jobId: string };
}

/** Works out where a job's application form lives, from its ATS source entry. */
export function applyTargetFor(job: {
  source: string;
  sourceJobId: string;
  url: string;
  seenOn?: Array<{ source: string; sourceJobId: string; url: string }>;
}): ApplyTarget | null {
  const entries = [
    { source: job.source, sourceJobId: job.sourceJobId, url: job.url },
    ...(job.seenOn ?? []),
  ];
  const e = entries.find((x) => ['greenhouse', 'lever', 'ashby'].includes(x.source));
  if (!e) return null;
  const url = e.url.split('#')[0]!.replace(/\/$/, '');
  if (e.source === 'greenhouse') {
    const [slug, jobId] = e.sourceJobId.split(':');
    return {
      ats: 'greenhouse',
      applyUrl: url,
      greenhouse: slug && jobId ? { slug, jobId } : undefined,
    };
  }
  if (e.source === 'lever')
    return { ats: 'lever', applyUrl: url.endsWith('/apply') ? url : `${url}/apply` };
  return { ats: 'ashby', applyUrl: url.endsWith('/application') ? url : `${url}/application` };
}

/** Opens the application form and makes sure it is rendered. */
export async function openApplicationForm(page: Page, target: ApplyTarget): Promise<void> {
  await page.goto(target.applyUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined);
  if (!(await page.locator('form input[type=file], input[type=file]').count())) {
    const apply = page
      .getByRole('button', { name: /^apply/i })
      .or(page.getByRole('link', { name: /^apply/i }))
      .first();
    if (await apply.count()) {
      await apply.click().catch(() => undefined);
      await page.waitForTimeout(2500);
    }
  }
  await page.locator('input, textarea').first().waitFor({ timeout: 20_000 });
}

/** Reads every field of the open form. Combobox options are read by opening each dropdown. */
export async function readFormFields(page: Page, target?: ApplyTarget): Promise<FormField[]> {
  const fields = (await page.evaluate(EXTRACT_SCRIPT)) as FormField[];

  for (const f of fields.filter((x) => x.kind === 'combobox' && !x.options?.length)) {
    try {
      const box = page.locator(f.selector).first();
      await markExistingOptions(page);
      if ((await box.getAttribute('aria-expanded')) !== 'true') await box.click({ timeout: 5000 });
      await page.waitForTimeout(400);
      const search = await dropdownSearchInput(page, box);
      if (search) {
        f.searchable = true;
        await search.fill('');
        await search.press('Backspace');
      }
      if (search) await page.waitForTimeout(150);
      // Read only this dropdown's list: other widgets (e.g. the phone country picker) keep their
      // own role=option elements in the page.
      const optionLocator = await dropdownOptions(page, box);
      const options = (await optionLocator.allInnerTexts())
        .map((t) => t.replace(/\s+/g, ' ').trim())
        .filter(Boolean);
      if (options.length) f.options = [...new Set(options)].slice(0, MAX_OPTIONS);
      await page.keyboard.press('Escape');
      if (
        (await box.getAttribute('aria-expanded')) === 'true' &&
        !(await box.evaluate((el) => el.matches('input, textarea, [contenteditable="true"]')))
      ) {
        await box.click({ timeout: 5000 });
      }
      await page.waitForTimeout(150);
    } catch (err) {
      logger.debug({ key: f.key, err: (err as Error).message }, 'could not read combobox options');
    }
  }

  if (target?.ats === 'greenhouse' && target.greenhouse)
    await enrichFromGreenhouseApi(fields, target.greenhouse);
  return fields;
}

interface GreenhouseQuestion {
  label: string;
  required: boolean;
  fields: Array<{ name: string; type: string; values?: Array<{ label: string }> }>;
}

/** The questions API has clean labels, the required flag and every option of each question. */
async function enrichFromGreenhouseApi(fields: FormField[], gh: { slug: string; jobId: string }) {
  try {
    const data = await createHttpClient({ retries: 1 }).getJson<{
      questions?: GreenhouseQuestion[];
    }>(
      `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(gh.slug)}/jobs/${gh.jobId}?questions=true`,
    );
    const byName = new Map<
      string,
      { q: GreenhouseQuestion; f: GreenhouseQuestion['fields'][number] }
    >();
    for (const q of data.questions ?? []) for (const f of q.fields) byName.set(f.name, { q, f });
    for (const field of fields) {
      const hit = byName.get(field.key);
      if (!hit) continue;
      field.label = hit.q.label;
      field.required = hit.q.required;
      if (hit.f.values?.length) field.options = hit.f.values.map((v) => v.label);
    }
  } catch (err) {
    logger.warn(
      { err: (err as Error).message },
      'greenhouse questions API failed; using page labels only',
    );
  }
}
