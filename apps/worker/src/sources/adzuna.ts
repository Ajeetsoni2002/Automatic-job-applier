import { htmlToText } from '../text.js';
import type { JobSource, RawJob } from './types.js';

// API docs: https://developer.adzuna.com/ — India endpoint is /jobs/in/. Descriptions are snippets.
interface AdzunaResponse {
  count: number;
  results: Array<{
    id: string;
    title: string;
    description?: string;
    redirect_url: string;
    created?: string;
    company?: { display_name?: string };
    location?: { display_name?: string; area?: string[] };
    salary_min?: number;
    salary_max?: number;
    salary_is_predicted?: string | number;
  }>;
}

const PER_PAGE = 50;

export const adzunaSource: JobSource = {
  name: 'adzuna',
  minIntervalHours: 0,
  unavailableReason: ({ env }) =>
    env.ADZUNA_APP_ID && env.ADZUNA_APP_KEY ? undefined : 'ADZUNA_APP_ID / ADZUNA_APP_KEY not set',

  async fetch(ctx) {
    const { env, profile } = ctx;
    const keywords = profile.preferences.searchKeywords.length
      ? profile.preferences.searchKeywords
      : profile.preferences.roles;
    const seen = new Set<string>();
    const jobs: RawJob[] = [];

    for (const what of keywords) {
      for (let page = 1; page <= env.ADZUNA_MAX_PAGES; page++) {
        const url = new URL(`https://api.adzuna.com/v1/api/jobs/in/search/${page}`);
        url.searchParams.set('app_id', env.ADZUNA_APP_ID!);
        url.searchParams.set('app_key', env.ADZUNA_APP_KEY!);
        url.searchParams.set('results_per_page', String(PER_PAGE));
        url.searchParams.set('what', what);
        url.searchParams.set('max_days_old', String(env.MAX_JOB_AGE_DAYS));
        url.searchParams.set('sort_by', 'date');
        url.searchParams.set('content-type', 'application/json');

        const res = await ctx.http.getJson<AdzunaResponse>(url.toString());
        for (const r of res.results ?? []) {
          if (seen.has(r.id)) continue;
          seen.add(r.id);
          const predicted = String(r.salary_is_predicted ?? '0') === '1';
          jobs.push({
            source: 'adzuna',
            sourceJobId: r.id,
            url: r.redirect_url,
            company: r.company?.display_name?.trim() || 'Unknown',
            title: htmlToText(r.title),
            location: r.location?.display_name ?? '',
            description: htmlToText(r.description),
            descriptionTruncated: true,
            countryHint: 'IN', // /jobs/in/ only returns Indian jobs, even in towns we can't recognise
            postedAt: r.created ? new Date(r.created) : undefined,
            salary:
              !predicted && (r.salary_min || r.salary_max)
                ? { min: r.salary_min, max: r.salary_max, currency: 'INR', period: 'year' }
                : undefined,
          });
        }
        if ((res.results?.length ?? 0) < PER_PAGE) break;
      }
    }
    return { jobs, warnings: [] };
  },
};
