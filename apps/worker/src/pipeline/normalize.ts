import crypto from 'node:crypto';
import type { WorkMode } from '@ja/shared';
import { describeQuality } from '../text.js';
import type { RawJob } from '../sources/types.js';

// ---------- location ----------

/** Lowercase alias -> canonical city. Covers common Indian spellings. */
export const CITY_ALIASES: Record<string, string> = {
  bangalore: 'Bengaluru',
  bengaluru: 'Bengaluru',
  'bengaluru urban': 'Bengaluru',
  gurgaon: 'Gurugram',
  gurugram: 'Gurugram',
  'new delhi': 'Delhi',
  delhi: 'Delhi',
  'delhi ncr': 'Delhi',
  ncr: 'Delhi',
  noida: 'Noida',
  'greater noida': 'Noida',
  ghaziabad: 'Ghaziabad',
  faridabad: 'Faridabad',
  mumbai: 'Mumbai',
  bombay: 'Mumbai',
  'navi mumbai': 'Mumbai',
  thane: 'Mumbai',
  pune: 'Pune',
  hyderabad: 'Hyderabad',
  secunderabad: 'Hyderabad',
  chennai: 'Chennai',
  madras: 'Chennai',
  kolkata: 'Kolkata',
  calcutta: 'Kolkata',
  ahmedabad: 'Ahmedabad',
  gandhinagar: 'Ahmedabad',
  jaipur: 'Jaipur',
  indore: 'Indore',
  bhopal: 'Bhopal',
  chandigarh: 'Chandigarh',
  mohali: 'Chandigarh',
  panchkula: 'Chandigarh',
  kochi: 'Kochi',
  cochin: 'Kochi',
  coimbatore: 'Coimbatore',
  trivandrum: 'Thiruvananthapuram',
  thiruvananthapuram: 'Thiruvananthapuram',
  bhubaneswar: 'Bhubaneswar',
  nagpur: 'Nagpur',
  lucknow: 'Lucknow',
  vadodara: 'Vadodara',
  surat: 'Surat',
  mysore: 'Mysuru',
  mysuru: 'Mysuru',
  visakhapatnam: 'Visakhapatnam',
  vizag: 'Visakhapatnam',
  mangalore: 'Mangaluru',
  mangaluru: 'Mangaluru',
  dehradun: 'Dehradun',
  patna: 'Patna',
  ranchi: 'Ranchi',
  kanpur: 'Kanpur',
  varanasi: 'Varanasi',
  prayagraj: 'Prayagraj',
  allahabad: 'Prayagraj',
};

const CITY_PATTERN = new RegExp(
  `\\b(${Object.keys(CITY_ALIASES)
    .sort((a, b) => b.length - a.length)
    .map((k) => k.replace(/ /g, '\\s+'))
    .join('|')})\\b`,
  'gi',
);

const REMOTE_RE = /\b(remote|work\s*from\s*home|wfh|anywhere|distributed)\b/i;
const HYBRID_RE = /\bhybrid\b/i;
const ONSITE_RE = /\b(on-?site|in-?office|office\s*based|work\s*from\s*office|wfo)\b/i;

export interface NormalizedLocation {
  city?: string;
  cities: string[];
  country?: string;
  workMode: WorkMode;
}

export function findCities(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(CITY_PATTERN)) {
    const city = CITY_ALIASES[m[1]!.toLowerCase().replace(/\s+/g, ' ')];
    if (city) out.add(city);
  }
  return [...out];
}

export function normalizeLocation(
  raw: string,
  hint?: RawJob['workModeHint'],
  countryHint?: string,
): NormalizedLocation {
  const text = raw ?? '';
  const cities = findCities(text);
  const mentionsIndia = /\bindia\b/i.test(text) || cities.length > 0;
  let workMode: WorkMode = 'unknown';
  if (hint) workMode = hint;
  else if (HYBRID_RE.test(text)) workMode = 'hybrid';
  else if (REMOTE_RE.test(text)) workMode = 'remote';
  else if (ONSITE_RE.test(text) || cities.length > 0) workMode = 'onsite';

  return {
    city: cities[0],
    cities,
    country: mentionsIndia ? 'IN' : countryHint,
    workMode,
  };
}

/**
 * For remote jobs: who may apply, judged from the location text.
 * india = India/APAC explicitly allowed, global = worldwide/unspecified, restricted = other regions only.
 */
const RESTRICTED_REGION_RE =
  /\b(us|usa|u\.s\.|united states|canada|uk|united kingdom|europe|eu|emea|amer|latam|americas|north(ern)? america|israel|germany|france|netherlands|spain|poland|australia|brazil|mexico|us time ?zones?|est|pst|cet)\b/;

export function remoteScope(location: string): 'india' | 'global' | 'restricted' {
  const t = location.toLowerCase();
  if (/\b(india|apac|asia)\b/.test(t) || findCities(t).length > 0) return 'india';
  if (RESTRICTED_REGION_RE.test(t)) return 'restricted';
  return 'global'; // worldwide / anywhere / unspecified
}

// ---------- company & title ----------

const COMPANY_SUFFIXES = new Set([
  'pvt',
  'private',
  'ltd',
  'limited',
  'inc',
  'llc',
  'llp',
  'corp',
  'corporation',
  'co',
  'company',
  'technologies',
  'technology',
  'tech',
  'solutions',
  'software',
  'labs',
  'india',
  'services',
  'systems',
  'gmbh',
  'plc',
  'the',
]);

export function normalizeCompany(name: string): string {
  const tokens = name
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const kept = tokens.filter((t) => !COMPANY_SUFFIXES.has(t));
  return (kept.length ? kept : tokens).join(' ');
}

const TITLE_REPLACEMENTS: Array<[RegExp, string]> = [
  [/\([^)]*\)|\[[^\]]*\]/g, ' '], // parenthetical notes: (Remote), [Bangalore]
  [/\b(req|job\s*id|jr|r)[\s#:-]*\d{3,}\b/gi, ' '], // requisition ids
  [/#\s*\d+/g, ' '],
  [/\bsr\b\.?/gi, 'senior'],
  [/\bjr\b\.?/gi, 'junior'],
  [/\bsde\b|\bswe\b/gi, 'software engineer'],
  [/\bfull[\s-]?stack\b/gi, 'full stack'],
  [/\bnode\.?js\b/gi, 'node'],
  [/\breact\.?js\b/gi, 'react'],
  [/\bfront[\s-]?end\b/gi, 'frontend'],
  [/\bback[\s-]?end\b/gi, 'backend'],
  [/\bdev\b/gi, 'developer'],
  [/\b(iii)\b/gi, '3'],
  [/\b(ii)\b/gi, '2'],
  [/\b(i)\b$/gi, '1'],
];

export function normalizeTitle(title: string): string {
  let t = title;
  for (const [re, rep] of TITLE_REPLACEMENTS) t = t.replace(re, rep);
  return t
    .toLowerCase()
    .replace(/[^a-z0-9+# ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export type Seniority = 'senior' | 'junior' | 'mid';

export function titleSeniority(title: string): Seniority | undefined {
  const t = normalizeTitle(title);
  if (/\b(senior|lead|staff|principal|architect|manager|head|director|vp|chief|tl|stl)\b/.test(t))
    return 'senior';
  if (/\b(engineer|developer|sde) (3|4|5)\b|\bl[5-9]\b/.test(t)) return 'senior';
  if (/\b(junior|intern|trainee|fresher|graduate|entry level|associate)\b/.test(t)) return 'junior';
  if (/\bsoftware engineer (1)\b/.test(t)) return 'junior';
  return undefined;
}

// ---------- experience ----------

export interface ExperienceRange {
  min?: number;
  max?: number;
}

const YRS = '(?:years?|yrs?)';
const EXP_PATTERNS: Array<{ re: RegExp; kind: 'range' | 'min' }> = [
  {
    re: new RegExp(`(\\d{1,2})\\s*(?:-|–|to)\\s*(\\d{1,2})\\s*\\+?\\s*${YRS}`, 'gi'),
    kind: 'range',
  },
  { re: new RegExp(`(\\d{1,2})\\s*\\+\\s*${YRS}`, 'gi'), kind: 'min' },
  {
    re: new RegExp(
      `(?:minimum|min\\.?|at\\s*least|atleast)\\s*(?:of\\s*)?(\\d{1,2})\\s*${YRS}`,
      'gi',
    ),
    kind: 'min',
  },
  {
    re: new RegExp(`(\\d{1,2})\\s*${YRS}\\s*(?:of\\s*)?(?:[a-z.]+\\s+){0,4}experience`, 'gi'),
    kind: 'min',
  },
];

/**
 * Parses stated experience requirements. When several are mentioned, the lowest minimum wins
 * (conservative: we'd rather score a job than wrongly filter it out).
 */
export function parseExperience(text: string): ExperienceRange {
  if (/\b(fresher|freshers|entry[\s-]level|no experience required)\b/i.test(text))
    return { min: 0, max: 1 };
  let best: ExperienceRange | undefined;
  for (const { re, kind } of EXP_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const a = Number(m[1]);
      const b = kind === 'range' ? Number(m[2]) : undefined;
      if (a > 20 || (b !== undefined && (b > 30 || b < a))) continue;
      const cand: ExperienceRange = { min: a, max: b };
      if (!best || (cand.min ?? 99) < (best.min ?? 99)) best = cand;
    }
  }
  return best ?? {};
}

// ---------- eligible graduation batches ----------

const YEAR = '20\\d{2}';
const YEAR_LIST = `${YEAR}(?:\\s*(?:\\/|,|&|and|or|-|–|to)\\s*${YEAR})*`;
const OPEN_ENDED = '(\\s*(?:or|and|&)?\\s*(?:later|after|above|onwards?|\\+))?';
const BATCH_PATTERNS = [
  // "2024/2025 batch", "2025 passouts", "2024 & 2025 graduates"
  new RegExp(
    `(${YEAR_LIST})${OPEN_ENDED}\\s*(?:batch(?:es)?|pass\\s*-?\\s*outs?|passouts?|graduates?|grads)\\b`,
    'gi',
  ),
  // "Batch: 2025", "YOP 2024, 2025", "Class of 2025", "graduated in 2023 or later"
  new RegExp(
    `\\b(?:batch(?:es)?|yop|year\\s+of\\s+passing|passing\\s+year|pass(?:ing)?\\s*-?\\s*out(?:\\s+year)?|graduat(?:ed|ing|ion)(?:\\s+year)?(?:\\s+in)?|class\\s+of)\\s*(?:[:\\-–]\\s*)?(${YEAR_LIST})${OPEN_ENDED}`,
    'gi',
  ),
];
const MIN_BATCH = 2015;
const MAX_BATCH = 2035;

/**
 * Graduation batches a posting says are eligible, e.g. "2024/2025 batch" -> [2024, 2025].
 * Short ranges ("2023-2025 batch") expand; open-ended ones ("2023 onwards") run to MAX_BATCH.
 * Returns [] when the posting doesn't mention batches.
 */
export function parseBatchYears(text: string): number[] {
  const years = new Set<number>();
  for (const re of BATCH_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const list = m[1]!;
      const nums = [...list.matchAll(/20\d{2}/g)].map((x) => Number(x[0]));
      const isRange = nums.length === 2 && /\d\s*(?:-|–|to)\s*20/.test(list);
      if (m[2]) {
        for (let y = Math.min(...nums); y <= MAX_BATCH; y++) years.add(y);
      } else if (isRange && nums[1]! >= nums[0]! && nums[1]! - nums[0]! <= 3) {
        for (let y = nums[0]!; y <= nums[1]!; y++) years.add(y);
      } else {
        for (const y of nums) years.add(y);
      }
    }
  }
  return [...years].filter((y) => y >= MIN_BATCH && y <= MAX_BATCH).sort((a, b) => a - b);
}

// ---------- url & hash ----------

const TRACKING_PARAMS =
  /^(utm_|trk|tracking|refid|ref$|src$|source$|gh_src|lever-|trackingid|eid|midtoken|midsig|otptoken|lipi|alertaction|savedsearchid|from$|xid|sid$|cid$)/i;

export function canonicalUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url.trim();
  }
  u.hash = '';
  u.hostname = u.hostname.toLowerCase();

  const li = u.pathname.match(/\/(?:comm\/)?jobs\/view\/(?:[^/]*-)?(\d{6,})/);
  if (u.hostname.endsWith('linkedin.com') && li)
    return `https://www.linkedin.com/jobs/view/${li[1]}`;

  const jk = u.searchParams.get('jk') ?? u.searchParams.get('vjk');
  if (u.hostname.includes('indeed.') && jk) return `https://${u.hostname}/viewjob?jk=${jk}`;

  for (const key of [...u.searchParams.keys()])
    if (TRACKING_PARAMS.test(key)) u.searchParams.delete(key);
  const out = u.toString();
  return out.endsWith('/') && u.pathname !== '/' ? out.slice(0, -1) : out;
}

export function dedupeHash(companyNorm: string, titleNorm: string, locKey: string): string {
  return crypto.createHash('sha1').update(`${companyNorm}|${titleNorm}|${locKey}`).digest('hex');
}

// ---------- full normalization ----------

export interface NormalizedJob {
  source: RawJob['source'];
  sourceJobId: string;
  url: string;
  canonicalUrl: string;
  company: string;
  companyNorm: string;
  title: string;
  titleNorm: string;
  location: string;
  city?: string;
  country?: string;
  workMode: WorkMode;
  experienceMin?: number;
  experienceMax?: number;
  /** Graduation batches the posting says are eligible; empty when not mentioned. */
  batchYears: number[];
  /** Set by the pipeline once the profile is known: true/false only when batches are mentioned. */
  batchMatch?: boolean;
  salary?: RawJob['salary'];
  description: string;
  descriptionQuality: 'full' | 'truncated' | 'none';
  postedAt?: Date;
  dedupeHash: string;
}

export function normalizeJob(raw: RawJob): NormalizedJob {
  const title = raw.title.replace(/\s+/g, ' ').trim();
  const company = raw.company.replace(/\s+/g, ' ').trim() || 'Unknown';
  const loc = normalizeLocation(raw.location, raw.workModeHint, raw.countryHint);
  const companyNorm = normalizeCompany(company);
  const titleNorm = normalizeTitle(title);
  const exp = parseExperience(`${title}\n${raw.description.slice(0, 4000)}`);
  const locKey =
    loc.workMode === 'remote' ? 'remote' : (loc.city?.toLowerCase() ?? loc.country ?? 'unknown');

  return {
    source: raw.source,
    sourceJobId: raw.sourceJobId,
    url: raw.url,
    canonicalUrl: canonicalUrl(raw.url),
    company,
    companyNorm,
    title,
    titleNorm,
    location: raw.location.trim(),
    city: loc.city,
    country: loc.country,
    workMode: loc.workMode,
    experienceMin: exp.min,
    experienceMax: exp.max,
    batchYears: parseBatchYears(`${title}\n${raw.description}`),
    salary: raw.salary,
    description: raw.description,
    descriptionQuality: describeQuality(raw.description, raw.descriptionTruncated),
    postedAt: raw.postedAt && !Number.isNaN(raw.postedAt.getTime()) ? raw.postedAt : undefined,
    dedupeHash: dedupeHash(companyNorm, titleNorm, locKey),
  };
}
