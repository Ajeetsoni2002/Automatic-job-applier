/// <reference lib="dom" />
import type { Locator, Page } from 'playwright-core';
import { logger } from '@ja/shared';
import type { Answer, FormField } from './types.js';
import { dropdownOptions, dropdownSearchInput, markExistingOptions } from './dropdown.js';
import { bestOption, closestOptions, searchQueries } from './match.js';

const isEmpty = (v: Answer['value']) => v === '' || (Array.isArray(v) && v.length === 0);

/**
 * Reads the dropdown's options until one is the wanted value, or the list has stopped changing
 * for a while (stale results can show while a search loads).
 */
async function settledOptions(
  page: Page,
  options: Locator,
  pick: (texts: string[]) => string | undefined,
  opts: { minMs: number; maxMs: number },
): Promise<{ texts: string[]; picked?: string }> {
  const read = async () =>
    (await options.allInnerTexts().catch(() => [] as string[]))
      .map((t) => t.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
  const started = Date.now();
  let last: string[] = [];
  let stableSince = started;
  for (;;) {
    const now = await read();
    const picked = pick(now);
    if (picked) {
      // A late answer to an earlier search can still replace the list: wait for it to hold.
      await page.waitForTimeout(400);
      const again = await read();
      if (pick(again) === picked) return { texts: again, picked };
    }
    if (JSON.stringify(now) !== JSON.stringify(last)) {
      last = now;
      stableSince = Date.now();
    }
    const elapsed = Date.now() - started;
    if (elapsed >= opts.maxMs || (elapsed >= opts.minMs && Date.now() - stableSince >= 800))
      return { texts: last };
    await page.waitForTimeout(250);
  }
}

async function clickOptionText(page: Page, options: Locator, text: string): Promise<void> {
  const escaped = text
    .trim()
    .split(/\s+/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('\\s+');
  await options
    .filter({ hasText: new RegExp(`^\\s*${escaped}\\s*$`, 'i') })
    .first()
    .click();
  await page.waitForTimeout(150);
}

/**
 * Finds the option with exactly this text and clicks it in one step inside the page. Virtual
 * lists reuse option elements: one found first and clicked later may by then show another
 * option (Infosys picked a different college that way).
 */
async function clickOptionNow(options: Locator, text: string): Promise<boolean> {
  return options.evaluateAll((elements, want) => {
    const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
    const el = elements.find((e) => norm((e as HTMLElement).innerText) === norm(want));
    if (!el) return false;
    for (const type of ['mousedown', 'mouseup', 'click'])
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    return true;
  }, text);
}

/** What a Material select shows as its choice (undefined for other dropdowns). */
const materialChoice = (box: Locator) =>
  box.evaluate((el) =>
    el.matches('mat-select, .mat-select, .mat-mdc-select')
      ? (el.textContent ?? '').replace(/\s+/g, ' ').trim()
      : undefined,
  );

/** One search for the whole query: a search per typed letter can answer out of order. */
async function typeQuery(search: Locator, query: string): Promise<void> {
  await search.fill(query.slice(0, -1), { timeout: 5000 });
  // Some survey filters listen to keyup rather than the input event dispatched by fill.
  await search.pressSequentially(query.slice(-1), { delay: 15, timeout: 5000 });
}

async function chooseFromCombobox(
  page: Page,
  box: Locator,
  value: string,
  field: FormField,
): Promise<void> {
  let strict = Boolean(field.searchable);
  const editable = await box.evaluate((el) =>
    el.matches('input, textarea, [contenteditable="true"]'),
  );
  if (!editable) {
    const selected = await box.evaluate((el) => ({
      text: el.getAttribute('aria-valuetext') || el.textContent || '',
      valid: el.getAttribute('aria-invalid') !== 'true' && !/mat-select-empty/.test(el.className),
    }));
    // Also "Madhya Pradesh Board" chosen earlier for "MP Board".
    if (selected.valid && selected.text.trim() && bestOption(value, [selected.text]) !== undefined)
      return;
  }
  const seen: string[] = [];
  let queries: Array<string | null> = [null];
  let options: Locator | undefined;
  let mismatch: { picked: string; shown: string } | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    await markExistingOptions(page);
    // A scan or another widget can leave this dropdown open. Clicking its trigger again
    // would close Material's panel just before we try to choose an option.
    if ((await box.getAttribute('aria-expanded')) !== 'true') await box.click();
    if (editable) {
      await box.fill('');
      await box.pressSequentially(value, { delay: 25 });
    }
    await page.waitForTimeout(500);
    // A delayed blur/layout update can dismiss Material's panel after the initial click.
    // Reopen only a confirmed collapsed trigger; never toggle a panel that is still open.
    for (
      let reopen = 0;
      !editable && reopen < 2 && (await box.getAttribute('aria-expanded')) === 'false';
      reopen++
    ) {
      await markExistingOptions(page);
      await box.click();
      await page.waitForTimeout(500);
    }
    const search = editable ? null : await dropdownSearchInput(page, box);
    options = await dropdownOptions(page, box);
    // Sites name things differently ("B.Tech" / "Bachelor of Technology", a college without
    // its city): search with each variant and take an option only when it clearly is the value.
    const country = /country|dial.*code|phone.*code/i.test(field.label);
    queries = !search
      ? [null]
      : country
        ? [value.replace(/\s*(?:\(\s*\+?\d{1,4}\s*\)|\+\d{1,4})\s*$/, '').trim() || value]
        : searchQueries(value);
    if (search) strict = true;
    let picked: string | undefined;
    let closed = false;
    for (const query of queries) {
      if (search && query !== null) {
        // The panel can close by itself after opening (a late blur): open it again.
        closed = await typeQuery(search, query).then(
          () => false,
          () => true,
        );
        if (closed) break;
      }
      // Search boxes (cities, colleges) load their options from the server: give them a moment.
      const result = await settledOptions(
        page,
        options,
        (now) =>
          now.find((t) => t.toLowerCase() === value.trim().toLowerCase()) ??
          bestOption(value, now),
        strict ? { minMs: 2000, maxMs: 6000 } : { minMs: 500, maxMs: 3000 },
      );
      seen.push(...result.texts);
      if (result.picked) {
        picked = result.picked;
        break;
      }
    }
    if (closed) {
      if (attempt === 1) throw new Error('the dropdown search box closed before typing');
      continue;
    }
    if (!picked) break;
    if (editable) {
      await clickOptionText(page, options, picked);
      return;
    }
    if (!(await clickOptionNow(options, picked))) continue;
    await page.waitForTimeout(400);
    // Check the dropdown now shows the option chosen, not a neighbour of it.
    const shown = await materialChoice(box);
    if (shown === undefined || bestOption(picked, [shown]) !== undefined) return;
    mismatch = { picked, shown };
    logger.warn(
      { control: await box.getAttribute('data-ja-control'), ...mismatch },
      'dropdown shows a different option than the one chosen; choosing again',
    );
  }
  if (mismatch)
    throw new Error(`chose "${mismatch.picked}" but the dropdown shows "${mismatch.shown}"`);
  if (!options) throw new Error('the dropdown did not open');
  const loose = options.filter({ hasText: value });
  if (!strict && (await loose.count()) === 1) {
    await loose.click();
    await page.waitForTimeout(150);
    return;
  }
  logger.warn(
    {
      control: await box.getAttribute('data-ja-control'),
      queries,
      seen: [...new Set(seen)].slice(0, 40),
    },
    'dropdown option lookup failed',
  );
  await page.keyboard.press('Escape');
  const closest = closestOptions(value, seen);
  throw new Error(
    `option "${value}" not found in the dropdown${closest.length ? `; closest: ${closest.join(' | ')}` : ''}`,
  );
}

async function setGroup(page: Page, field: FormField, wanted: string[]): Promise<void> {
  const members = page.locator(`input[name="${(field.name ?? field.key).replace(/"/g, '\\"')}"]`);
  const n = await members.count();
  const matched = new Set<string>();
  for (let i = 0; i < n; i++) {
    const input = members.nth(i);
    const id = await input.getAttribute('id');
    const labelText = id
      ? ((await page
          .locator(`label[for="${id}"]`)
          .first()
          .textContent()
          .catch(() => '')) ?? '')
      : ((await input
          .locator('xpath=ancestor::label[1]')
          .textContent()
          .catch(() => '')) ?? '');
    const text = (labelText || (await input.getAttribute('value')) || '')
      .replace(/\s+/g, ' ')
      .trim();
    const choice = wanted.find((w) => w.toLowerCase() === text.toLowerCase());
    if (choice) {
      await setChecked(input, true);
      matched.add(choice);
    } else if (field.kind === 'checkboxes') await setChecked(input, false);
  }
  const missing = wanted.filter((w) => !matched.has(w));
  if (missing.length) throw new Error(`option "${missing.join(', ')}" not found`);
}

/** Material visually hides the native checkbox; its label remains clickable. */
export async function setChecked(input: Locator, checked: boolean): Promise<void> {
  if ((await input.isChecked()) === checked) return;
  try {
    await input.setChecked(checked, { timeout: 1500 });
  } catch {
    await input.evaluate((el) => {
      const control = el as HTMLInputElement;
      const label = control.labels?.[0];
      if (label) label.click();
      else control.click();
    });
  }
  if ((await input.isChecked()) !== checked) throw new Error('checkbox selection was not accepted');
}

async function uploadFromButton(page: Page, container: Locator, value: string): Promise<void> {
  const chooser = page
    .waitForEvent('filechooser', { timeout: 10000 })
    .then((chooser) => ({ chooser }))
    .catch(() => null);
  await container.locator('[data-ja-upload]').first().click({ timeout: 10000 });
  const dialog = page.locator('[role="dialog"]:visible, dialog[open]').last();
  const editor = dialog
    .waitFor({ state: 'visible', timeout: 10000 })
    .then(() => ({ dialog }))
    .catch(() => null);
  const opened = await Promise.race([chooser, editor]);
  if (!opened) throw new Error('upload did not open a file picker or an editor');
  if ('chooser' in opened) {
    await opened.chooser.setFiles(value);
    return;
  }
  const file = opened.dialog.locator('input[type="file"]');
  await file.waitFor({ state: 'attached', timeout: 5000 });
  await file.setInputFiles(value);
  // The image editor reads and decodes the file asynchronously before Done can save it.
  await page.waitForTimeout(500);
  const done = opened.dialog.getByRole('button', {
    name: /^(done|save|confirm|use (this )?(photo|image))$/i,
  });
  await done.click({ timeout: 10000 });
  await opened.dialog.waitFor({ state: 'hidden', timeout: 10000 });
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_NAMES = MONTHS.map((m) => m[0]!.toUpperCase() + m.slice(1));

/**
 * Reads a date the way people type it in India: 15/08/2002, 15-08-2002, 2002-08-15,
 * 15 Aug 2002, August 15, 2002. Day first when ambiguous.
 */
export function parseDate(s: string): { y: number; m: number; d: number } | null {
  const t = s.trim().toLowerCase();
  let m = t.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return { y: +m[1]!, m: +m[2]!, d: +m[3]! };
  m = t.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (m) return { y: +m[3]!, m: +m[2]!, d: +m[1]! };
  m = t.match(/^(\d{1,2})(?:st|nd|rd|th)?[\s-]+([a-z]{3})[a-z]*[\s,-]+(\d{4})$/);
  if (m && MONTHS.includes(m[2]!)) return { y: +m[3]!, m: MONTHS.indexOf(m[2]!) + 1, d: +m[1]! };
  m = t.match(/^([a-z]{3})[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/);
  if (m && MONTHS.includes(m[1]!)) return { y: +m[3]!, m: MONTHS.indexOf(m[1]!) + 1, d: +m[2]! };
  return null;
}

/** A month and year without a day: 2025-06, 06/2025, 6-2025, June 2025, Jun-2025. */
export function parseMonthYear(s: string): { y: number; m: number } | null {
  const t = s.trim().toLowerCase();
  let m = t.match(/^(\d{4})[-/.](\d{1,2})$/);
  if (m) return +m[2]! >= 1 && +m[2]! <= 12 ? { y: +m[1]!, m: +m[2]! } : null;
  m = t.match(/^(\d{1,2})[-/.](\d{4})$/);
  if (m) return +m[1]! >= 1 && +m[1]! <= 12 ? { y: +m[2]!, m: +m[1]! } : null;
  m = t.match(/^([a-z]{3})[a-z]*[\s,.-]+(\d{4})$/);
  if (m && MONTHS.includes(m[1]!)) return { y: +m[2]!, m: MONTHS.indexOf(m[1]!) + 1 };
  return null;
}

/**
 * Whether the text a date box shows is the wanted date. Day-first and month-first displays are
 * both read; a month-and-year box only has to show the month and year.
 */
export function dateShown(shown: string, want: { y: number; m: number; d?: number }): boolean {
  const t = shown.trim();
  const same = (x: { y: number; m: number; d?: number } | null) =>
    Boolean(x && x.y === want.y && x.m === want.m && (x.d === undefined || x.d === want.d));
  const monthFirst = t.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  return (
    same(parseDate(t)) ||
    Boolean(monthFirst && same({ y: +monthFirst[3]!, m: +monthFirst[1]!, d: +monthFirst[2]! })) ||
    same(parseMonthYear(t))
  );
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Date boxes that open a calendar: unlock the box, type the date and check the page shows that
 * date, trying the formats such boxes commonly parse. A month-and-year box turns "01/06/2019"
 * into "01/2006": that is rejected, and "06/2019" tried next.
 */
async function fillDatePicker(page: Page, loc: Locator, value: string): Promise<void> {
  const full = parseDate(value);
  const d = full ?? parseMonthYear(value);
  const monthYear = d
    ? [`${pad(d.m)}/${d.y}`, `${d.y}-${pad(d.m)}`, `${MONTH_NAMES[d.m - 1]} ${d.y}`]
    : [];
  const formats = full
    ? [
        // ISO is unambiguous for Material/native parsers even when the displayed date is US.
        `${full.y}-${pad(full.m)}-${pad(full.d)}`,
        `${pad(full.d)}/${pad(full.m)}/${full.y}`,
        `${pad(full.m)}/${pad(full.d)}/${full.y}`,
        `${pad(full.d)}-${pad(full.m)}-${full.y}`,
        ...monthYear,
      ]
    : d
      ? monthYear
      : [value];
  const readOnly = (await loc.getAttribute('readonly')) !== null;
  await loc.evaluate((el) => el.removeAttribute('readonly'));
  try {
    for (const f of formats) {
      await loc.fill(f);
      await loc.press('Tab').catch(() => undefined);
      await page.keyboard.press('Escape').catch(() => undefined);
      await page.waitForTimeout(300);
      const state = await loc.evaluate((el) => ({
        value: (el as HTMLInputElement).value,
        invalid:
          el.getAttribute('aria-invalid') === 'true' ||
          /ng-invalid/.test((el as HTMLElement).className),
      }));
      if (state.value && !state.invalid && (!d || state.value === f || dateShown(state.value, d)))
        return;
    }
  } finally {
    if (readOnly) await loc.evaluate((el) => el.setAttribute('readonly', ''));
  }
  throw new Error(`the date "${value}" was not accepted; check its format`);
}

/** Choice tiles (marked by the extractor with data-ja-option): click the one with this text. */
async function clickTile(container: Locator, text: string): Promise<void> {
  const tiles = container.locator('[data-ja-option]');
  const n = await tiles.count();
  for (let i = 0; i < n; i++) {
    const t = tiles.nth(i);
    if ((await t.getAttribute('data-ja-option'))?.toLowerCase() === text.toLowerCase()) {
      // Clicking a ticked checkbox tile again would untick it.
      const selected = await t.evaluate(
        (el) =>
          ['aria-selected', 'aria-checked', 'aria-pressed'].some(
            (a) => el.getAttribute(a) === 'true',
          ) ||
          /(^|\s)(selected|checked)(\s|$)/.test(el.className) ||
          /\b(radio_button_checked|check_circle|check_box)\b/.test(el.textContent ?? ''),
      );
      if (!selected) await t.click();
      return;
    }
  }
  throw new Error(`option "${text}" not found`);
}

const SUGGESTIONS =
  '.dropdown-location:visible, .pac-item:visible, [role="listbox"] [role="option"]:visible';

/**
 * Location fields that only accept a picked suggestion (Lever, Google Places): type the city and
 * click the matching suggestion. Leaves the typed text if no suggestion appears.
 */
async function pickSuggestion(page: Page, loc: Locator, value: string): Promise<void> {
  const city = value.split(',')[0]!.trim();
  await page.waitForTimeout(900);
  if (!(await page.locator(SUGGESTIONS).count())) {
    await loc.fill('');
    await loc.pressSequentially(city, { delay: 50 });
    await page.waitForTimeout(1800);
  }
  const items = page.locator(SUGGESTIONS);
  if (!(await items.count())) return;
  const match = items.filter({ hasText: city }).first();
  await ((await match.count()) ? match : items.first()).click();
  await page.waitForTimeout(300);
}

/**
 * Fills the open form with the stored answers. Fields are matched by key against a fresh read of
 * the page, so selectors are always current. Returns the fields that could not be filled.
 */
export async function fillForm(
  page: Page,
  fields: FormField[],
  answers: Answer[],
): Promise<string[]> {
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const problems: string[] = [];

  // Upload files first: some ATSs (Lever) parse the resume and would overwrite fields typed earlier.
  const ordered = [
    ...answers.filter((a) => a.kind === 'file'),
    ...answers.filter((a) => a.kind !== 'file'),
  ];
  let uploaded = false;

  for (const a of ordered) {
    if (uploaded && a.kind !== 'file') {
      uploaded = false;
      await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
      await page.waitForTimeout(2500);
    }
    if (isEmpty(a.value) || (a.kind === 'checkbox' && a.value === false)) continue;
    const field = byKey.get(a.key);
    if (!field) {
      if (a.required) problems.push(`"${a.label}" is no longer on the form`);
      continue;
    }
    const loc = page.locator(field.selector).first();
    const value = a.value;
    try {
      switch (field.kind) {
        case 'file':
          if (field.upload === 'chooser') {
            await uploadFromButton(page, loc, String(value));
          } else await loc.setInputFiles(String(value));
          uploaded = true;
          break;
        case 'date':
          if (field.picker) await fillDatePicker(page, loc, String(value));
          else {
            const d = parseDate(String(value));
            const type = await loc.getAttribute('type');
            await loc.fill(d && type === 'date' ? `${d.y}-${pad(d.m)}-${pad(d.d)}` : String(value));
          }
          break;
        case 'select': {
          const labels = (await loc.locator('option').allTextContents()).map((t) =>
            t.replace(/\s+/g, ' ').trim(),
          );
          const wanted = String(value);
          const label =
            labels.find((t) => t.toLowerCase() === wanted.toLowerCase()) ??
            bestOption(wanted, labels) ??
            wanted;
          await loc.selectOption({ label }, { timeout: 5000 });
          break;
        }
        case 'multiselect':
          await loc.selectOption(
            (Array.isArray(value) ? value : [String(value)]).map((label) => ({ label })),
          );
          break;
        case 'combobox':
          await chooseFromCombobox(page, loc, String(value), field);
          break;
        case 'radio':
          await setGroup(page, field, [String(value)]);
          break;
        case 'checkboxes':
          if (field.name)
            await setGroup(page, field, Array.isArray(value) ? value : [String(value)]);
          else
            for (const v of Array.isArray(value) ? value : [String(value)]) await clickTile(loc, v);
          break;
        case 'checkbox':
          await setChecked(loc, value === true);
          break;
        case 'buttons': {
          const button = loc.getByRole('button', { name: String(value), exact: true });
          if (await button.count()) await button.first().click();
          else await clickTile(loc, String(value));
          break;
        }
        default:
          await loc.fill(String(value));
          if (/location|city/i.test(field.label) || (await loc.getAttribute('aria-autocomplete')))
            await pickSuggestion(page, loc, String(value));
          await loc.blur().catch(() => undefined);
      }
    } catch (err) {
      problems.push(`"${a.label}": ${(err as Error).message.split('\n')[0]}`);
    }
  }
  return problems;
}

const CONFIRM_TEXT =
  /thank(s| you)[^.\n]{0,80}(appl|interest|submitt)|application (has been |was )?(successfully )?(submitted|received|sent)|we('|’)ve received your application|successfully (submitted|applied)|application submitted/i;
const CONFIRM_URL = /confirmation|thank|success|submitted|applied/i;

export type SubmitOutcome =
  | { outcome: 'submitted'; detail: string }
  | { outcome: 'captcha'; detail: string }
  | { outcome: 'invalid'; detail: string }
  | { outcome: 'unknown'; detail: string };

export async function captchaChallengeVisible(page: Page): Promise<boolean> {
  const frames = page.locator(
    'iframe[src*="recaptcha/api2/bframe"], iframe[src*="recaptcha/enterprise/bframe"], iframe[src*="hcaptcha.com"][src*="challenge"]',
  );
  const n = await frames.count();
  for (let i = 0; i < n; i++) {
    const box = await frames
      .nth(i)
      .boundingBox()
      .catch(() => null);
    if (box && box.height > 100 && box.width > 100) return true;
  }
  return false;
}

export async function visibleErrors(page: Page): Promise<string[]> {
  const texts = await page
    .locator(
      '[aria-invalid="true"], .error:visible, [class*="error"]:visible, [role="alert"]:visible',
    )
    .allInnerTexts()
    .catch(() => [] as string[]);
  return [
    ...new Set(texts.map((t) => t.replace(/\s+/g, ' ').trim()).filter((t) => t && t.length < 200)),
  ].slice(0, 8);
}

/**
 * Clicks submit and waits for a confirmation. While a CAPTCHA challenge is on screen in a visible
 * window, it waits up to `captchaWaitMs` for you to solve it; it never tries to solve one itself.
 */
export async function submitForm(
  page: Page,
  opts: { headless: boolean; captchaWaitMs: number },
): Promise<SubmitOutcome> {
  const startUrl = page.url();
  const button = page
    .getByRole('button', { name: /submit( your)?( application)?|^apply( now)?$|send application/i })
    .or(page.locator('button[type="submit"], input[type="submit"]'))
    .last();
  if (!(await button.count())) return { outcome: 'unknown', detail: 'No submit button found' };
  await button.click();

  const started = Date.now();
  let deadline = started + 30_000;
  let sawCaptcha = false;
  while (Date.now() < deadline) {
    await page.waitForTimeout(1000);
    const body =
      (await page
        .locator('body')
        .innerText()
        .catch(() => '')) ?? '';
    const match = body.match(CONFIRM_TEXT);
    if (match || (page.url() !== startUrl && CONFIRM_URL.test(page.url())))
      return { outcome: 'submitted', detail: match?.[0] ?? `Redirected to ${page.url()}` };

    if (await captchaChallengeVisible(page)) {
      if (opts.headless) return { outcome: 'captcha', detail: 'A CAPTCHA challenge appeared' };
      if (!sawCaptcha) {
        sawCaptcha = true;
        deadline = Date.now() + opts.captchaWaitMs; // give you time to solve it in the window
      }
      continue;
    }
    if (Date.now() - started > 6000) {
      const errors = await visibleErrors(page);
      if (errors.length && page.url() === startUrl)
        return { outcome: 'invalid', detail: errors.join(' | ') };
    }
  }
  if (sawCaptcha) return { outcome: 'captcha', detail: 'CAPTCHA was not solved in time' };
  return { outcome: 'unknown', detail: 'No confirmation seen within 30 seconds' };
}
