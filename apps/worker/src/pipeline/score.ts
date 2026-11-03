import Anthropic from '@anthropic-ai/sdk';
import { JobModel, JobScoreModel, logger, type Job } from '@ja/shared';
import { LlmBudgetExceededError, LlmOutputError } from '../llm/client.js';
import type { Scorer } from '../llm/scorer.js';

export interface ScoreSummary {
  scored: number;
  failed: number;
  remaining: number;
  stoppedReason?: string;
}

const CONCURRENCY = 3;

/** Scores jobs in status `new`, newest first. Stops cleanly on budget cap or API outage. */
export async function scorePendingJobs(
  scorer: Scorer,
  opts: { limit?: number; filter?: Record<string, unknown> } = {},
): Promise<ScoreSummary> {
  const limit = opts.limit ?? 500;
  const pending = await JobModel.find({ ...opts.filter, status: 'new' })
    .sort({ postedAt: -1, fetchedAt: -1 })
    .limit(limit)
    .lean();

  const summary: ScoreSummary = { scored: 0, failed: 0, remaining: 0 };
  let stop = false;
  let next = 0;

  async function scoreOne(job: Job & { _id: unknown }) {
    try {
      const out = await scorer.score({
        title: job.title,
        company: job.company,
        location: job.location ?? '',
        workMode: job.workMode ?? 'unknown',
        experienceMin: job.experienceMin,
        experienceMax: job.experienceMax,
        batchYears: job.batchYears,
        salary: job.salary,
        description: job.description ?? '',
        descriptionQuality: job.descriptionQuality ?? 'none',
        source: job.source,
      });
      await JobScoreModel.create({ jobId: job._id, ...out });
      await JobModel.updateOne(
        { _id: job._id, status: 'new' },
        {
          $set: {
            status: 'scored',
            score: out.score,
            scoreConfidence: out.confidence,
            scoredAt: new Date(),
          },
        },
      );
      summary.scored++;
    } catch (err) {
      if (err instanceof LlmBudgetExceededError) {
        summary.stoppedReason = err.message;
        stop = true;
      } else if (err instanceof LlmOutputError) {
        summary.failed++;
        await JobModel.updateOne({ _id: job._id }, { $set: { status: 'score_failed' } });
        logger.warn({ jobId: String(job._id), err: err.message }, 'scoring output unusable');
      } else if (err instanceof Anthropic.APIError) {
        // Auth problems, or rate limit / outage after the SDK's own retries: leave the job `new`.
        summary.stoppedReason = `Anthropic API error ${err.status ?? ''}: ${err.message}`;
        stop = true;
      } else {
        throw err;
      }
    }
  }

  async function worker() {
    while (!stop && next < pending.length) await scoreOne(pending[next++]!);
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length) }, worker));

  summary.remaining = await JobModel.countDocuments({ status: 'new' });
  return summary;
}
