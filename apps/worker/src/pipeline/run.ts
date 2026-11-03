import crypto from 'node:crypto';
import {
  getEnv,
  getSettings,
  loadProfile,
  loadTargetCompanies,
  logger,
  SOURCE_NAMES,
  SourceRunModel,
  type Profile,
  type SourceName,
  type TargetCompany,
} from '@ja/shared';
import { createHttpClient } from '../http.js';
import { createScorer } from '../llm/scorer.js';
import { SOURCES, type SourceContext } from '../sources/index.js';
import { applyHardFilters, batchMatch, type FilterResult } from './filter.js';
import { acquireLock } from './lock.js';
import { normalizeJob, type NormalizedJob } from './normalize.js';
import { scorePendingJobs, type ScoreSummary } from './score.js';
import { autoTailor, type AutoTailorSummary } from '../tailor/index.js';
import { autoApply, type AutoApplySummary } from '../apply/index.js';
import { discoverFromJobPosts } from '../outreach/index.js';
import { upsertJob } from './upsert.js';

export interface RunOptions {
  /** Limit to these sources (default: all enabled in Settings). */
  sources?: SourceName[];
  /** Fetch, normalize and filter only — nothing is written to the database. */
  dryRun?: boolean;
  skipScoring?: boolean;
  /** Ignore each source's minimum interval between runs. */
  force?: boolean;
  trigger: 'cron' | 'cli' | 'api';
}

export interface SourceSummary {
  source: SourceName;
  status: 'ok' | 'failed' | 'skipped';
  fetched: number;
  inserted: number;
  filtered: number;
  duplicates: number;
  invalid: number;
  message?: string;
  /** Only on dry runs: what would have been stored. */
  preview?: Array<NormalizedJob & { filter: FilterResult }>;
}

export interface PipelineSummary {
  runId: string;
  skipped?: string;
  sources: SourceSummary[];
  scoring?: ScoreSummary;
  tailoring?: AutoTailorSummary;
  applying?: AutoApplySummary;
  durationMs: number;
}

const LOCK_NAME = 'pipeline';
const LOCK_TTL_MS = 45 * 60_000;

export async function runPipeline(opts: RunOptions): Promise<PipelineSummary> {
  const started = Date.now();
  const runId = crypto.randomUUID();
  const settings = await getSettings();
  const finish = (s: Omit<PipelineSummary, 'runId' | 'durationMs'>): PipelineSummary => ({
    runId,
    durationMs: Date.now() - started,
    ...s,
  });

  if (settings.killSwitch) return finish({ skipped: 'kill switch is on', sources: [] });

  const release = opts.dryRun ? async () => {} : await acquireLock(LOCK_NAME, LOCK_TTL_MS);
  if (!release) return finish({ skipped: 'another pipeline run is in progress', sources: [] });

  try {
    const env = getEnv();
    const profile = loadProfile().data;
    let targets: TargetCompany[] = [];
    try {
      targets = loadTargetCompanies().data.companies;
    } catch (err) {
      logger.warn(
        { err: (err as Error).message },
        'target companies not loaded; ATS sources will be skipped',
      );
    }
    const ctx: SourceContext = { http: createHttpClient(), env, profile, targets, logger };
    const selected = opts.sources ?? SOURCE_NAMES.filter((s) => settings.sources[s]);

    logger.info({ runId, sources: selected, dryRun: Boolean(opts.dryRun) }, 'pipeline started');
    const settled = await Promise.allSettled(
      selected.map((name) => runSource(name, ctx, profile, runId, opts)),
    );
    const sources = settled.map((r, i): SourceSummary =>
      r.status === 'fulfilled'
        ? r.value
        : {
            source: selected[i]!,
            status: 'failed',
            fetched: 0,
            inserted: 0,
            filtered: 0,
            duplicates: 0,
            invalid: 0,
            message: String(r.reason),
          },
    );

    let scoring: ScoreSummary | undefined;
    if (!opts.dryRun && !opts.skipScoring) {
      scoring = await scorePendingJobs(createScorer(profile));
      logger.info({ runId, ...scoring }, 'scoring finished');
    }
    let tailoring: AutoTailorSummary | undefined;
    if (!opts.dryRun && !opts.skipScoring) {
      try {
        tailoring = await autoTailor();
        if (tailoring.generated || tailoring.failed)
          logger.info({ runId, ...tailoring }, 'auto-tailoring finished');
      } catch (err) {
        logger.error({ runId, err: (err as Error).message }, 'auto-tailoring failed');
      }
    }
    let applying: AutoApplySummary | undefined;
    if (!opts.dryRun && !opts.skipScoring) {
      try {
        applying = await autoApply();
        if (applying.prepared || applying.submitted || applying.errors.length)
          logger.info({ runId, ...applying }, 'auto-apply finished');
      } catch (err) {
        logger.error({ runId, err: (err as Error).message }, 'auto-apply failed');
      }
    }
    if (!opts.dryRun && !opts.skipScoring) {
      try {
        const o = await discoverFromJobPosts();
        if (o.drafted || o.errors.length)
          logger.info({ runId, ...o }, 'recruiter emails from job posts');
      } catch (err) {
        logger.error({ runId, err: (err as Error).message }, 'outreach discovery failed');
      }
    }
    const summary = finish({ sources, scoring, tailoring, applying });
    logger.info({ runId, durationMs: summary.durationMs }, 'pipeline finished');
    return summary;
  } finally {
    await release();
  }
}

async function runSource(
  name: SourceName,
  ctx: SourceContext,
  profile: Profile,
  runId: string,
  opts: RunOptions,
): Promise<SourceSummary> {
  const source = SOURCES[name];
  const summary: SourceSummary = {
    source: name,
    status: 'ok',
    fetched: 0,
    inserted: 0,
    filtered: 0,
    duplicates: 0,
    invalid: 0,
  };
  const startedAt = new Date();

  const skip = async (message: string): Promise<SourceSummary> => {
    if (!opts.dryRun)
      await SourceRunModel.create({
        runId,
        source: name,
        startedAt,
        finishedAt: new Date(),
        status: 'skipped',
        error: message,
      });
    return { ...summary, status: 'skipped', message };
  };

  const unavailable = source.unavailableReason(ctx);
  if (unavailable) return skip(unavailable);

  if (source.minIntervalHours > 0 && !opts.force) {
    const last = await SourceRunModel.findOne({ source: name, status: 'ok' })
      .sort({ startedAt: -1 })
      .lean();
    const hoursSince = last ? (Date.now() - last.startedAt.getTime()) / 3_600_000 : Infinity;
    if (hoursSince < source.minIntervalHours)
      return skip(`ran ${hoursSince.toFixed(1)}h ago (min interval ${source.minIntervalHours}h)`);
  }

  const run = opts.dryRun
    ? null
    : await SourceRunModel.create({ runId, source: name, startedAt, status: 'running' });
  try {
    const result = await source.fetch(ctx);
    summary.fetched = result.jobs.length;
    if (opts.dryRun) summary.preview = [];

    for (const raw of result.jobs) {
      let job: NormalizedJob;
      try {
        if (!raw.title?.trim() || !raw.url?.trim() || !raw.sourceJobId)
          throw new Error('missing title/url/id');
        job = normalizeJob(raw);
        job.batchMatch = batchMatch(job, profile.preferences);
      } catch (err) {
        summary.invalid++;
        logger.debug({ source: name, err: (err as Error).message }, 'invalid job skipped');
        continue;
      }
      const filter = applyHardFilters(job, profile.preferences, {
        maxJobAgeDays: ctx.env.MAX_JOB_AGE_DAYS,
      });

      if (opts.dryRun) {
        summary.preview!.push({ ...job, filter });
        if (filter.pass) summary.inserted++;
        else summary.filtered++;
        continue;
      }
      const outcome = await upsertJob(job, filter);
      if (outcome === 'inserted') summary.inserted++;
      else if (outcome === 'filtered') summary.filtered++;
      else summary.duplicates++;
    }

    if (!opts.dryRun) await result.onCommitted?.();
    if (result.warnings.length) summary.message = result.warnings.slice(0, 10).join('; ');
  } catch (err) {
    summary.status = 'failed';
    summary.message = (err as Error).message;
    logger.error({ source: name, err: summary.message }, 'source failed');
  }

  if (run) {
    await SourceRunModel.updateOne(
      { _id: run._id },
      {
        $set: {
          finishedAt: new Date(),
          status: summary.status,
          fetched: summary.fetched,
          inserted: summary.inserted,
          duplicates: summary.duplicates,
          filtered: summary.filtered,
          error: summary.message,
        },
      },
    );
  }
  logger.info(
    {
      source: name,
      status: summary.status,
      fetched: summary.fetched,
      new: summary.inserted,
      filtered: summary.filtered,
      dup: summary.duplicates,
    },
    'source done',
  );
  return summary;
}
