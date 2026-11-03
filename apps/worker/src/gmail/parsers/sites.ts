import { extractCards, type AlertParser, type CardId } from './common.js';

const fromDomain = (from: string, domain: string) => from.toLowerCase().includes(domain);

export const linkedinParser: AlertParser = {
  name: 'linkedin',
  matches: (from) => fromDomain(from, 'linkedin.com'),
  parse: (html) =>
    extractCards(
      html,
      (href) => {
        const m = href.match(/linkedin\.com\/(?:comm\/)?jobs\/view\/(?:[^/?]*-)?(\d{6,})/i);
        return m
          ? { key: `linkedin:${m[1]}`, url: `https://www.linkedin.com/jobs/view/${m[1]}` }
          : null;
      },
      'linkedin',
    ),
};

export const naukriParser: AlertParser = {
  name: 'naukri',
  matches: (from) => fromDomain(from, 'naukri.com'),
  parse: (html) =>
    extractCards(
      html,
      (href) => {
        const m = href.match(/naukri\.com\/job-listings-[^?#]*?-(\d{9,})(?:[?#/]|$)/i);
        if (!m) return null;
        const clean = href.split(/[?#]/)[0]!;
        return { key: `naukri:${m[1]}`, url: clean };
      },
      'naukri',
    ),
};

/**
 * Indeed sends three link styles:
 * - viewjob / rc/clk links with a `jk` job id (keyed by it);
 * - job-alert emails (jobalert.indeed.com) with opaque engage.indeed.com/f/a/… tracking links;
 * - recommendation emails (match.indeed.com) with pagead/clk links without a job id.
 * The last two keep the original link (it still opens the job) and are keyed by title/company/location.
 */
export function identifyIndeedLink(href: string): CardId | null {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  if (!u.hostname.includes('indeed.')) return null;
  const jk = u.searchParams.get('jk') ?? u.searchParams.get('vjk');
  if (jk && /^[a-f0-9]{10,20}$/i.test(jk)) {
    const host = u.hostname.startsWith('in.') ? u.hostname : 'in.indeed.com';
    return { key: `indeed:${jk}`, url: `https://${host}/viewjob?jk=${jk}` };
  }
  if (u.hostname === 'engage.indeed.com' && u.pathname.startsWith('/f/a/')) return { url: href };
  if (/\/(pagead|rc)\/clk/.test(u.pathname)) return { url: href };
  return null;
}

export const indeedParser: AlertParser = {
  name: 'indeed',
  matches: (from) => fromDomain(from, 'indeed.'),
  parse: (html) => extractCards(html, identifyIndeedLink, 'indeed'),
};

export const SITE_PARSERS: AlertParser[] = [linkedinParser, naukriParser, indeedParser];
