/// <reference lib="dom" />
import type { Locator, Page } from 'playwright-core';

/** Exclude inline choices that were already visible before this dropdown opened. */
export async function markExistingOptions(page: Page): Promise<void> {
  await page
    .locator('[data-ja-existing-option]')
    .evaluateAll((elements) =>
      elements.forEach((el) => el.removeAttribute('data-ja-existing-option')),
    );
  await page
    .locator('[role="option"]:visible')
    .evaluateAll((elements) =>
      elements.forEach((el) => el.setAttribute('data-ja-existing-option', '1')),
    );
}

export async function dropdownOptions(page: Page, box: Locator): Promise<Locator> {
  const id = (await box.getAttribute('aria-controls')) ?? (await box.getAttribute('aria-owns'));
  let options: Locator;
  if (id) {
    const escaped = id.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    options = page.locator(`[id="${escaped}"] [role="option"]:visible`);
  } else {
    options = page.locator('[role="option"]:visible:not([data-ja-existing-option="1"])');
  }
  // Material wraps its search input in a role=option row. Its accessible name can equal
  // the query, but clicking that row does not select the matching result below it.
  return options.filter({
    hasNot: page.locator(
      'input:not([type="checkbox"]):not([type="radio"]), textarea, [contenteditable="true"]',
    ),
  });
}

/** A filter inside this dropdown, excluding unrelated text fields on the application. */
export async function dropdownSearchInput(page: Page, box: Locator): Promise<Locator | null> {
  const id = (await box.getAttribute('aria-controls')) ?? (await box.getAttribute('aria-owns'));
  const escaped = id?.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const root = escaped
    ? page.locator(`[id="${escaped}"]`)
    : page.locator('.cdk-overlay-pane:visible');
  const input = root.locator(
    'input:visible:not([type="checkbox"]):not([type="radio"]):not([type="hidden"])',
  );
  return (await input.count()) === 1 ? input : null;
}
