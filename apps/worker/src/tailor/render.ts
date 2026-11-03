import fs from 'node:fs';
import path from 'node:path';
import type { TailoredResumeDto } from '@ja/shared';

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2025-12" -> "Dec 2025", "present" -> "Present", "2025" -> "2025". */
export function formatMonth(value: string): string {
  if (value.toLowerCase() === 'present') return 'Present';
  const m = value.match(/^(\d{4})-(\d{2})$/);
  return m ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : value;
}

const LINK_LABELS: Record<string, string> = {
  linkedin: 'LinkedIn',
  github: 'GitHub',
  portfolio: 'Portfolio',
  leetcode: 'LeetCode',
};

/**
 * Single-column, ATS-friendly resume: real text (no images or icons), standard section names,
 * no tables, links written out so they survive copy-paste into application forms.
 */
export function renderResumeHtml(r: TailoredResumeDto): string {
  const link = (url: string, label?: string) =>
    `<a href="${esc(url)}">${esc(label ?? url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, ''))}</a>`;

  const contact = [
    r.contact.phone && esc(r.contact.phone),
    `<a href="mailto:${esc(r.contact.email)}">${esc(r.contact.email)}</a>`,
    esc(r.contact.location),
    ...Object.entries(r.contact.links).map(([k, url]) => link(url, LINK_LABELS[k] ?? k)),
  ].filter(Boolean);

  const bullets = (items: Array<{ text: string }>) =>
    items.length ? `<ul>${items.map((b) => `<li>${esc(b.text)}</li>`).join('')}</ul>` : '';

  const experience = r.experience
    .map(
      (e) => `<div class="entry">
  <div class="row"><span class="strong">${esc(e.title)}</span><span>${formatMonth(e.start)} – ${formatMonth(e.end)}</span></div>
  <div class="row sub"><span>${esc(e.company)}</span><span>${esc(e.location ?? '')}</span></div>
  ${bullets(e.bullets)}
</div>`,
    )
    .join('\n');

  const projects = r.projects
    .map((p) => {
      const links = [p.url && link(p.url, 'Live'), p.repo && link(p.repo, 'Code')]
        .filter(Boolean)
        .join(' · ');
      return `<div class="entry">
  <div class="row"><span><span class="strong">${esc(p.name)}</span>${p.stack.length ? ` <span class="muted">| ${esc(p.stack.join(', '))}</span>` : ''}</span><span>${links}</span></div>
  ${bullets(p.bullets)}
</div>`;
    })
    .join('\n');

  const education = r.education
    .map(
      (e) =>
        `<div class="row"><span><span class="strong">${esc(e.degree)}${e.field ? `, ${esc(e.field)}` : ''}</span> — ${esc(e.institution)}${e.grade ? ` <span class="muted">(${esc(e.grade)})</span>` : ''}</span><span>${esc(e.start)} – ${esc(e.end)}</span></div>`,
    )
    .join('\n');

  const skills = r.skills
    .map(
      (s) => `<div><span class="strong">${esc(s.group)}:</span> ${esc(s.items.join(', '))}</div>`,
    )
    .join('\n');

  const section = (title: string, body: string) =>
    body.trim() ? `<h2>${title}</h2>\n${body}` : '';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(r.name)} - Resume</title>
<style>
  @page { size: A4; margin: 12mm 14mm; }
  * { box-sizing: border-box; }
  body { font-family: Calibri, Carlito, "Segoe UI", Arial, sans-serif; font-size: 10.5pt; line-height: 1.35; color: #111; margin: 0; }
  h1 { font-size: 20pt; margin: 0 0 2px; letter-spacing: 0.5px; }
  h2 { font-size: 11pt; text-transform: uppercase; letter-spacing: 0.8px; border-bottom: 1px solid #444; padding-bottom: 1px; margin: 10px 0 5px; }
  .contact { font-size: 9.5pt; color: #333; }
  .contact a, a { color: #1a4fa3; text-decoration: none; }
  .row { display: flex; justify-content: space-between; gap: 12px; }
  .row > span:last-child { white-space: nowrap; flex-shrink: 0; }
  .sub { color: #333; font-style: italic; }
  .strong { font-weight: 700; }
  .muted { color: #555; font-weight: 400; }
  .entry { margin-bottom: 6px; break-inside: avoid; }
  ul { margin: 2px 0 0 0; padding-left: 16px; }
  li { margin: 1px 0; }
  p { margin: 0; }
</style></head>
<body>
  <h1>${esc(r.name)}</h1>
  <div class="contact">${contact.join(' &nbsp;|&nbsp; ')}</div>
  ${section('Summary', `<p>${esc(r.summary)}</p>`)}
  ${section('Skills', skills)}
  ${section('Experience', experience)}
  ${section('Projects', projects)}
  ${section('Education', education)}
  ${section('Achievements', r.achievements.length ? `<ul>${r.achievements.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>` : '')}
</body></html>`;
}

/** A plain one-page letter, for forms that want the cover letter as a file. */
export function renderCoverLetterHtml(name: string, text: string): string {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(name)} - Cover letter</title>
<style>
  @page { size: A4; margin: 22mm 20mm; }
  body { font-family: Calibri, Carlito, "Segoe UI", Arial, sans-serif; font-size: 11pt; line-height: 1.5; color: #111; margin: 0; }
  p { margin: 0 0 12px; }
</style></head>
<body>${paragraphs}</body></html>`;
}

// A4 is 210 x 297 mm; minus the @page margins (14 mm sides, 12 mm top/bottom) at 96 px per inch.
const MM = 96 / 25.4;
const A4_CONTENT_WIDTH_PX = Math.floor((210 - 28) * MM);
const A4_CONTENT_HEIGHT_PX = Math.floor((297 - 24) * MM);
/** Below this a one-page fit gets hard to read; longer resumes simply run to a second page. */
const MIN_SCALE = 0.85;

/**
 * Prints HTML to an A4 PDF with a locally installed Chrome or Edge (no browser download needed).
 * On a server without either, install Chromium with `npx playwright install chromium`.
 */
export async function renderPdf(html: string, outPath: string): Promise<void> {
  const { chromium } = await import('playwright-core');
  let browser;
  const errors: string[] = [];
  for (const options of [{ channel: 'chrome' }, { channel: 'msedge' }, {}]) {
    try {
      browser = await chromium.launch({ headless: true, ...options });
      break;
    } catch (err) {
      errors.push((err as Error).message.split('\n')[0]!);
    }
  }
  if (!browser) throw new Error(`No browser available to print PDFs: ${errors.join(' | ')}`);
  try {
    const page = await browser.newPage();
    // Lay the page out at A4 content width, then shrink slightly if it would spill onto page 2.
    await page.setViewportSize({ width: A4_CONTENT_WIDTH_PX, height: A4_CONTENT_HEIGHT_PX });
    await page.setContent(html, { waitUntil: 'load' });
    const height = Number(await page.evaluate('document.body.scrollHeight'));
    const scale =
      height > A4_CONTENT_HEIGHT_PX ? Math.max(MIN_SCALE, A4_CONTENT_HEIGHT_PX / height - 0.01) : 1;
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    await page.pdf({
      path: outPath,
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
      scale,
    });
  } finally {
    await browser.close();
  }
}
