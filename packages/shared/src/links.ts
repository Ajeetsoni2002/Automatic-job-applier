// Helpers for application links you paste into the dashboard (any company's careers site).

/** Hiring systems recognised from the link's host, for display. Anything else is "website". */
const ATS_HOSTS: Array<[RegExp, string]> = [
  [/(^|\.)greenhouse\.io$/, 'greenhouse'],
  [/(^|\.)lever\.co$/, 'lever'],
  [/(^|\.)ashbyhq\.com$/, 'ashby'],
  [/(^|\.)myworkdayjobs\.com$|(^|\.)myworkdaysite\.com$|(^|\.)workday\.com$/, 'workday'],
  [/(^|\.)smartrecruiters\.com$/, 'smartrecruiters'],
  [/(^|\.)successfactors\.(com|eu)$|(^|\.)sapsf\.(com|eu)$/, 'successfactors'],
  [/(^|\.)taleo\.net$/, 'taleo'],
  [/(^|\.)icims\.com$/, 'icims'],
  [/(^|\.)zohorecruit\.(com|in)$/, 'zoho'],
  [/(^|\.)freshteam\.com$/, 'freshteam'],
  [/(^|\.)keka\.com$/, 'keka'],
  [/(^|\.)darwinbox\.(com|in)$/, 'darwinbox'],
  [/(^|\.)workable\.com$/, 'workable'],
  [/(^|\.)recruitee\.com$/, 'recruitee'],
  [/(^|\.)bamboohr\.com$/, 'bamboohr'],
  [/(^|\.)jobvite\.com$/, 'jobvite'],
  [/(^|\.)breezy\.hr$/, 'breezy'],
  [/(^|\.)oraclecloud\.com$/, 'oracle'],
  [/^docs\.google\.com$/, 'google-forms'],
];

export function detectAts(url: string): string {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return 'website';
  }
  return ATS_HOSTS.find(([re]) => re.test(host))?.[1] ?? 'website';
}

const GENERIC_LABELS = new Set([
  'www',
  'careers',
  'career',
  'jobs',
  'job',
  'apply',
  'hire',
  'recruit',
  'talent',
  'boards',
  'job-boards',
  'app',
  'forms',
  'docs',
]);
const HOSTED_ON =
  /myworkdayjobs|myworkdaysite|greenhouse|lever|ashbyhq|smartrecruiters|zohorecruit|freshteam|keka|darwinbox|workable|recruitee|bamboohr|jobvite|breezy|icims|taleo|successfactors|oraclecloud/;

/**
 * A first guess at the company name from the link: the tenant on hosted job sites
 * (acme.wd5.myworkdayjobs.com, jobs.lever.co/acme) or the site's own name (careers.acme.com).
 */
export function companyFromUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'Unknown company';
  }
  const labels = u.hostname.toLowerCase().split('.');
  const pathFirst = u.pathname.split('/').filter(Boolean)[0] ?? '';
  let name: string | undefined;
  if (HOSTED_ON.test(u.hostname)) {
    const sub = labels.find((l) => !GENERIC_LABELS.has(l) && !/^wd\d+$/.test(l));
    name =
      sub && !HOSTED_ON.test(sub)
        ? sub
        : pathFirst && !/^(en|en-us|en-in|jobs|careers|apply)$/i.test(pathFirst)
          ? pathFirst
          : undefined;
  } else {
    const meaningful = labels.slice(0, -1).filter((l) => !GENERIC_LABELS.has(l));
    // careers.acme.co.in → "acme"; acme.com → "acme"
    name = meaningful.filter((l) => !/^(co|com|org|net|ac|gov)$/.test(l)).pop();
  }
  if (!name) return 'Unknown company';
  // infosysapps → infosys, acmecareers → acme
  name = name.replace(/(apps|careers|jobs|hiring|recruit(ment)?)$/, '') || name;
  return name
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

/** Title given to a pasted-link job until the worker reads the real one from the page. */
export const LINK_JOB_TITLE = 'Job application';
