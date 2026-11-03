import type { Profile, WorkMode } from '@ja/shared';
import { findCities, normalizeCompany, remoteScope, titleSeniority } from './normalize.js';

export interface FilterableJob {
  companyNorm: string;
  title: string;
  location: string;
  workMode: WorkMode;
  country?: string | null;
  experienceMin?: number | null;
  postedAt?: Date | null;
  batchYears?: number[] | null;
}

export interface FilterOptions {
  maxJobAgeDays: number;
  now?: Date;
}

export type FilterResult = { pass: true } | { pass: false; reason: string };

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whole-word, case-insensitive match that also works for keywords like ".NET" or "C++". */
export function containsKeyword(text: string, keyword: string): boolean {
  const k = keyword.trim();
  if (!k) return false;
  const before = /^[a-z0-9]/i.test(k) ? '(?<![a-z0-9])' : '';
  const after = /[a-z0-9]$/i.test(k) ? '(?![a-z0-9])' : '';
  return new RegExp(`${before}${escapeRe(k)}${after}`, 'i').test(text);
}

/**
 * true = the posting names eligible batches and yours is one of them; false = it names batches and
 * yours isn't; undefined = no batches mentioned (or no graduationYear in the profile).
 */
export function batchMatch(
  job: Pick<FilterableJob, 'batchYears'>,
  prefs: Profile['preferences'],
): boolean | undefined {
  if (!prefs.graduationYear || !job.batchYears?.length) return undefined;
  return job.batchYears.includes(prefs.graduationYear);
}

/**
 * Cheap rule-based filters that run before any LLM call. A job that fails gets
 * status=filtered_out with the reason, so the rules can be tuned from the dashboard.
 */
export function applyHardFilters(
  job: FilterableJob,
  prefs: Profile['preferences'],
  opts: FilterOptions,
): FilterResult {
  const fail = (reason: string): FilterResult => ({ pass: false, reason });
  const now = opts.now ?? new Date();

  const excludedCompanies = new Set(prefs.excludeCompanies.map(normalizeCompany));
  if (excludedCompanies.has(job.companyNorm)) return fail('excluded company');

  const badKeyword = prefs.excludeKeywords.find((k) => containsKeyword(job.title, k));
  if (badKeyword) return fail(`title has excluded keyword "${badKeyword}"`);

  if (prefs.titleKeywords.length && !prefs.titleKeywords.some((k) => containsKeyword(job.title, k)))
    return fail('title is not a target role');

  if (titleSeniority(job.title) === 'senior') return fail('senior-level title');

  const batch = batchMatch(job, prefs);
  if (batch === false)
    return fail(`for ${job.batchYears!.join('/')} batch only (you: ${prefs.graduationYear})`);

  // A posting that explicitly lists your batch is a fresher hire, whatever "N years" it mentions.
  if (!batch && job.experienceMin != null && job.experienceMin > prefs.maxExperienceYears)
    return fail(`needs ${job.experienceMin}+ years (max ${prefs.maxExperienceYears})`);

  if (job.postedAt) {
    const ageDays = (now.getTime() - job.postedAt.getTime()) / 86_400_000;
    if (ageDays > opts.maxJobAgeDays) return fail(`posted ${Math.floor(ageDays)} days ago`);
  }

  if (job.workMode === 'remote') {
    if (!prefs.workModes.includes('remote')) return fail('remote not wanted');
    const scope = remoteScope(job.location);
    if (scope === 'restricted') return fail(`remote, but restricted to: ${job.location}`);
    if (scope === 'global' && !prefs.acceptGlobalRemote) return fail('global remote not accepted');
    return { pass: true };
  }

  if (job.workMode !== 'unknown' && !prefs.workModes.includes(job.workMode))
    return fail(`${job.workMode} not wanted`);
  if (job.country && prefs.countries.length && !prefs.countries.includes(job.country))
    return fail(`country ${job.country} not in preferences`);

  const cities = findCities(job.location);
  if (cities.length && prefs.locations.length) {
    const wanted = new Set(prefs.locations.flatMap((l) => findCities(l)));
    if (wanted.size && !cities.some((c) => wanted.has(c)))
      return fail(`location ${cities.join('/')} not in preferences`);
  }
  // Non-remote job whose location isn't recognisably Indian (e.g. "San Francisco, CA", "Hybrid - London").
  // Country detection currently only recognises India, so this applies when IN is a preferred country.
  if (!cities.length && !job.country && job.location.trim() && prefs.countries.includes('IN'))
    return fail(`location outside preferred countries: ${job.location}`);

  return { pass: true };
}
