import { convert } from 'html-to-text';

/** HTML (possibly entity-escaped, as Greenhouse returns it) to readable plain text. */
export function htmlToText(html: string | null | undefined): string {
  if (!html) return '';
  const unescaped = /&lt;\w/.test(html) ? decodeEntities(html) : html;
  return convert(unescaped, {
    wordwrap: false,
    selectors: [
      { selector: 'a', options: { ignoreHref: true } },
      { selector: 'img', format: 'skip' },
    ],
  })
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/** Description quality: Adzuna-style snippets are "truncated", empty is "none". */
export function describeQuality(text: string, truncated = false): 'full' | 'truncated' | 'none' {
  if (!text.trim()) return 'none';
  if (truncated || text.length < 400) return 'truncated';
  return 'full';
}
