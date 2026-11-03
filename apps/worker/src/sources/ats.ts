// Public job-board APIs of Greenhouse, Lever and Ashby, queried per target company.
import type { AtsType, TargetCompany } from '@ja/shared';
import { HttpError } from '../http.js';
import { htmlToText } from '../text.js';
import type { JobSource, RawJob, SourceContext, SourceResult } from './types.js';

// ---------- Greenhouse: https://developers.greenhouse.io/job-board.html ----------
interface GreenhouseResponse {
  jobs: Array<{
    id: number;
    title: string;
    absolute_url: string;
    location?: { name?: string };
    updated_at?: string;
    first_published?: string;
    content?: string;
    company_name?: string;
  }>;
}

export async function fetchGreenhouse(ctx: SourceContext, c: TargetCompany): Promise<RawJob[]> {
  const res = await ctx.http.getJson<GreenhouseResponse>(
    `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(c.slug)}/jobs?content=true`,
  );
  return (res.jobs ?? []).map((j) => ({
    source: 'greenhouse',
    sourceJobId: `${c.slug}:${j.id}`,
    url: j.absolute_url,
    company: c.name,
    title: j.title,
    location: j.location?.name ?? '',
    description: htmlToText(j.content),
    postedAt: parseDate(j.first_published ?? j.updated_at),
  }));
}

// ---------- Lever: https://github.com/lever/postings-api ----------
interface LeverPosting {
  id: string;
  text: string;
  hostedUrl: string;
  categories?: { location?: string; allLocations?: string[]; commitment?: string; team?: string };
  workplaceType?: string;
  createdAt?: number;
  descriptionPlain?: string;
  additionalPlain?: string;
  lists?: Array<{ text: string; content: string }>;
  salaryRange?: { min?: number; max?: number; currency?: string; interval?: string };
}

export async function fetchLever(ctx: SourceContext, c: TargetCompany): Promise<RawJob[]> {
  const res = await ctx.http.getJson<LeverPosting[]>(
    `https://api.lever.co/v0/postings/${encodeURIComponent(c.slug)}?mode=json`,
  );
  return (res ?? []).map((p) => {
    const lists = (p.lists ?? []).map((l) => `${l.text}\n${htmlToText(l.content)}`).join('\n\n');
    const description = [p.descriptionPlain, lists, p.additionalPlain]
      .filter(Boolean)
      .join('\n\n')
      .trim();
    const interval = p.salaryRange?.interval ?? '';
    return {
      source: 'lever',
      sourceJobId: `${c.slug}:${p.id}`,
      url: p.hostedUrl,
      company: c.name,
      title: p.text,
      location: p.categories?.allLocations?.join(' / ') || p.categories?.location || '',
      workModeHint: mapWorkplace(p.workplaceType),
      description,
      postedAt: p.createdAt ? new Date(p.createdAt) : undefined,
      salary:
        p.salaryRange && (p.salaryRange.min || p.salaryRange.max)
          ? {
              min: p.salaryRange.min,
              max: p.salaryRange.max,
              currency: p.salaryRange.currency,
              period: interval.includes('hour')
                ? 'hour'
                : interval.includes('month')
                  ? 'month'
                  : 'year',
            }
          : undefined,
    } satisfies RawJob;
  });
}

// ---------- Ashby: https://developers.ashbyhq.com/docs/public-job-posting-api ----------
interface AshbyResponse {
  jobs: Array<{
    id: string;
    title: string;
    location?: string;
    secondaryLocations?: Array<{ location?: string }>;
    isRemote?: boolean;
    workplaceType?: string;
    descriptionPlain?: string;
    descriptionHtml?: string;
    publishedAt?: string;
    jobUrl: string;
    isListed?: boolean;
  }>;
}

export async function fetchAshby(ctx: SourceContext, c: TargetCompany): Promise<RawJob[]> {
  const res = await ctx.http.getJson<AshbyResponse>(
    `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(c.slug)}?includeCompensation=true`,
  );
  return (res.jobs ?? [])
    .filter((j) => j.isListed !== false)
    .map((j) => ({
      source: 'ashby',
      sourceJobId: `${c.slug}:${j.id}`,
      url: j.jobUrl,
      company: c.name,
      title: j.title,
      location: [j.location, ...(j.secondaryLocations ?? []).map((s) => s.location)]
        .filter(Boolean)
        .join(' / '),
      workModeHint: mapWorkplace(j.workplaceType) ?? (j.isRemote ? 'remote' : undefined),
      description: j.descriptionPlain?.trim() || htmlToText(j.descriptionHtml),
      postedAt: parseDate(j.publishedAt),
    }));
}

// ---------- shared ----------

function parseDate(s: string | undefined): Date | undefined {
  if (!s) return undefined;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function mapWorkplace(t: string | undefined): RawJob['workModeHint'] {
  const v = (t ?? '').toLowerCase().replace(/[^a-z]/g, '');
  if (v === 'remote') return 'remote';
  if (v === 'hybrid') return 'hybrid';
  if (v === 'onsite') return 'onsite';
  return undefined;
}

const FETCHERS: Record<AtsType, (ctx: SourceContext, c: TargetCompany) => Promise<RawJob[]>> = {
  greenhouse: fetchGreenhouse,
  lever: fetchLever,
  ashby: fetchAshby,
};

/** One JobSource per ATS; each iterates the target companies using that ATS. */
function atsSource(ats: AtsType): JobSource {
  return {
    name: ats,
    minIntervalHours: 0,
    unavailableReason: ({ targets }) =>
      targets.some((t) => t.ats === ats && t.enabled)
        ? undefined
        : `no enabled ${ats} companies in target_companies`,
    async fetch(ctx): Promise<SourceResult> {
      const jobs: RawJob[] = [];
      const warnings: string[] = [];
      for (const company of ctx.targets.filter((t) => t.ats === ats && t.enabled)) {
        try {
          jobs.push(...(await FETCHERS[ats](ctx, company)));
        } catch (err) {
          const msg =
            err instanceof HttpError && err.status === 404
              ? `${company.name}: board "${company.slug}" not found (check slug)`
              : `${company.name}: ${(err as Error).message}`;
          warnings.push(msg);
          ctx.logger.warn({ ats, company: company.name }, msg);
        }
      }
      if (jobs.length === 0 && warnings.length > 0) throw new Error(warnings.join('; '));
      return { jobs, warnings };
    },
  };
}

export const greenhouseSource = atsSource('greenhouse');
export const leverSource = atsSource('lever');
export const ashbySource = atsSource('ashby');
