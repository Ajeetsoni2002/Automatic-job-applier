import crypto from 'node:crypto';
import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import type { AnyNode, Element } from 'domhandler';
import { findCities } from '../../pipeline/normalize.js';

export interface AlertJob {
  /** Stable id, e.g. "linkedin:4012345678". */
  key: string;
  title: string;
  company: string;
  location: string;
  url: string;
}

export interface AlertParser {
  name: string;
  matches(from: string, subject: string): boolean;
  parse(html: string, text: string): AlertJob[] | Promise<AlertJob[]>;
}

/** Follows tracking redirects that carry the real URL in a query parameter. */
export function unwrapRedirect(href: string, depth = 0): string {
  if (depth > 3) return href;
  try {
    const u = new URL(href);
    for (const key of [
      'url',
      'u',
      'target',
      'redirect',
      'redirect_url',
      'dest',
      'destination',
      'q',
      'link',
    ]) {
      const v = u.searchParams.get(key);
      if (v && /^https?:\/\//i.test(v)) return unwrapRedirect(v, depth + 1);
    }
  } catch {
    /* not a URL */
  }
  return href;
}

const NOISE_LINE =
  /^(apply( now)?|easy apply|easily apply|view( job| jobs| all)?|see (all|more)( jobs)?|save|actively (recruiting|hiring)|urgently hiring|responsive employer|hiring multiple candidates|promoted|new|be an early applicant|.*\b(applicants?|connections?|alumni)\b.*|.*\bago\b|just now|just posted|today|yesterday|since yesterday|for last \d+ days|\d+[+]? (days?|hours?) ago|job alert.*|unsubscribe.*|manage.*alerts?.*|hot job|featured|find jobs|edit( (this )?alert)?|pause.*|update.*preferences|view all.*|see all.*|help cent(re|er)|privacy policy|terms|\d(\.\d)?)$/i;
const EXPERIENCE_LINE = /\b\d{1,2}\s*(-|to)\s*\d{1,2}\s*(yrs?|years?)\b|\bfresher\b/i;
const SALARY_LINE = /₹|\blpa\b|\bnot disclosed\b|\bper (annum|month)\b|\bsalary\b|\binr\b/i;

const COMPANY_HINT =
  /\b(pvt|private|ltd|limited|inc|llc|llp|technologies|technology|solutions|labs|consulting|consultancy|services|corporation|corp|systems|software|infotech)\b/i;

function looksLikeLocation(line: string): boolean {
  if (COMPANY_HINT.test(line)) return false; // "Clearwater Analytics India Private Limited"
  return (
    findCities(line).length > 0 || /\b(india|remote|hybrid|on-?site|work from home)\b/i.test(line)
  );
}

// Zero-width and soft-hyphen characters email templates use as invisible padding.
const INVISIBLE = new RegExp(
  `[${[0xad, 0x34f, 0x200b, 0x200c, 0x200d, 0xfeff].map((c) => String.fromCharCode(c)).join('')}]`,
  'g',
);
const WHITESPACE = /\s+/g;
const clean = (s: string) => s.replace(INVISIBLE, ' ').replace(WHITESPACE, ' ').trim();

/** Text directly inside an element (not inside its child elements). */
function ownText($: CheerioAPI, el: AnyNode): string {
  return clean(
    $(el)
      .contents()
      .filter((_, c) => c.type === 'text')
      .text(),
  );
}

/**
 * Company and location of the job whose title link is `link`, read from the text that follows it.
 * Climbs from the link through its ancestors until that text yields a company, stopping at the
 * next job's link so a card without a company line can't take its neighbour's.
 */
function cardDetails(
  $: CheerioAPI,
  link: Element,
  isOtherJob: (el: AnyNode) => boolean,
): { company: string; location: string } {
  const inLink = new Set<AnyNode>([link, ...$(link).find('*').toArray()]);
  let container = $(link).parent();
  let details = { company: '', location: '' };
  for (let level = 0; level < 8 && container.length; level++) {
    const all = container.find('*').toArray();
    const items: string[] = [];
    for (const el of all.slice(all.indexOf(link) + 1)) {
      if (isOtherJob(el)) break; // never borrow the next job's company
      if (inLink.has(el)) continue;
      const text = ownText($, el);
      if (text) items.push(text);
      if (items.length >= 12) break;
    }
    details = companyAndLocation(items);
    if (details.company) return details;
    container = container.parent();
  }
  return details;
}

/** Company and location from the card items: "Company · Location", or company then location. */
function companyAndLocation(items: string[]): { company: string; location: string } {
  let company = '';
  let location = '';
  for (const raw of items) {
    const t = raw.replace(/^[-–•·|]\s*/, '').trim();
    if (!t || t.length > 80 || NOISE_LINE.test(t)) continue;
    if (EXPERIENCE_LINE.test(t) || SALARY_LINE.test(t)) continue;
    if (t.includes(' · ') && !company) {
      const [c, ...rest] = t.split(' · ');
      company = c!.trim();
      location ||= rest.join(', ').trim();
    } else if (!company && !looksLikeLocation(t)) company = t;
    else if (!location && (company || looksLikeLocation(t))) location = t;
    if (company && location) break;
  }
  return { company, location };
}

/**
 * A job link identified from its href. `key` is the site's own job id when the URL carries one;
 * leave it out for opaque tracking links and the job is keyed by title + company + location.
 */
export type CardId = { key?: string; url: string };

/**
 * Generic card extractor used by the sender-specific parsers.
 * 1. Find links whose (unwrapped) href identifies a job. Several links can point to one job
 *    (logo, title, and in LinkedIn alerts an outer link around the whole card); the title is the
 *    shortest usable link text.
 * 2. Company and location come from the card items that follow the title link.
 */
export function extractCards(
  html: string,
  identify: (href: string) => CardId | null,
  keyPrefix: string,
): AlertJob[] {
  const $ = cheerio.load(html);
  const found = new Map<
    string,
    { title: string; links: Array<{ text: string; el: Element }>; url: string; siteKey?: string }
  >();
  /** Every job link in the email -> its group (undefined = a job link we couldn't group). */
  const linkGroup = new Map<AnyNode, string | undefined>();
  let anon = 0;
  let lastAnonTitle = '';

  $('a[href]').each((_, el) => {
    const href = unwrapRedirect($(el).attr('href') ?? '');
    const id = identify(href);
    if (!id) return;

    const text = clean($(el).text());
    const usable = text.length >= 3 && text.length <= 150 && !NOISE_LINE.test(text);
    linkGroup.set(el, undefined);

    let groupKey: string;
    if (id.key) groupKey = id.key;
    else {
      // No id in the URL: consecutive links with the same title (logo + title) are one job.
      if (!usable) return;
      if (text !== lastAnonTitle) anon++;
      lastAnonTitle = text;
      groupKey = `anon:${anon}`;
    }
    linkGroup.set(el, groupKey);
    const entry = found.get(groupKey) ?? { title: '', links: [], url: id.url, siteKey: id.key };
    if (usable) {
      entry.links.push({ text, el });
      if (!entry.title || text.length < entry.title.length) entry.title = text;
    }
    found.set(groupKey, entry);
  });

  const jobs: AlertJob[] = [];
  for (const [groupKey, { title, links, url, siteKey }] of found) {
    if (!title) continue;
    const isOtherJob = (el: AnyNode) => linkGroup.has(el) && linkGroup.get(el) !== groupKey;
    // Try the job's links shortest-text first and keep the first that yields a company.
    let card = { company: '', location: '' };
    for (const { el } of [...links].sort((a, b) => a.text.length - b.text.length)) {
      card = cardDetails($, el, isOtherJob);
      if (card.company) break;
    }
    const company = card.company || 'Unknown';
    const location = card.location;
    const key =
      siteKey ??
      `${keyPrefix}:${crypto.createHash('sha1').update(`${title}|${company}|${location}`.toLowerCase()).digest('hex').slice(0, 16)}`;
    jobs.push({ key, title, company, location, url });
  }
  return jobs;
}
