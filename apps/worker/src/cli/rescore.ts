// Re-applies filters and/or re-scores stored jobs — useful after editing profile.yaml or the prompt.
//   npm run rescore '--' --refilter                 re-run hard filters on unscored/filtered/scored jobs
//   npm run rescore '--' --since=2026-10-01         re-score jobs fetched since a date
//   npm run rescore '--' --refilter --since=2026-10-01
import { parseArgs } from 'node:util';
import { connectDb, disconnectDb, getEnv, JobModel, loadProfile } from '@ja/shared';
import { createScorer } from '../llm/scorer.js';
import { applyHardFilters, batchMatch } from '../pipeline/filter.js';
import { parseBatchYears } from '../pipeline/normalize.js';
import { scorePendingJobs } from '../pipeline/score.js';

const { values } = parseArgs({
  options: {
    since: { type: 'string' },
    refilter: { type: 'boolean', default: false },
    'no-score': { type: 'boolean', default: false },
  },
});

const since = values.since ? new Date(values.since) : undefined;
if (since && Number.isNaN(since.getTime())) {
  console.error('--since must be a date, e.g. 2026-10-01');
  process.exit(1);
}

const profile = loadProfile().data;
await connectDb();
try {
  const dateFilter = since ? { fetchedAt: { $gte: since } } : {};

  if (values.refilter) {
    let nowPass = 0;
    let nowFail = 0;
    const cursor = JobModel.find({
      ...dateFilter,
      status: { $in: ['new', 'filtered_out', 'scored', 'score_failed'] },
    }).cursor();
    for await (const job of cursor) {
      // Recompute batch eligibility too, so jobs stored before graduationYear was set get it.
      const batchYears = parseBatchYears(`${job.title}\n${job.description ?? ''}`);
      const match = batchMatch({ batchYears }, profile.preferences);
      await JobModel.updateOne(
        { _id: job._id },
        match === undefined
          ? { $set: { batchYears }, $unset: { batchMatch: 1 } }
          : { $set: { batchYears, batchMatch: match } },
      );
      const r = applyHardFilters({ ...job.toObject(), batchYears }, profile.preferences, {
        maxJobAgeDays: getEnv().MAX_JOB_AGE_DAYS,
      });
      if (r.pass && job.status === 'filtered_out') {
        await JobModel.updateOne(
          { _id: job._id },
          { $set: { status: 'new' }, $unset: { filterReason: 1 } },
        );
        nowPass++;
      } else if (!r.pass && job.status !== 'filtered_out') {
        await JobModel.updateOne(
          { _id: job._id },
          { $set: { status: 'filtered_out', filterReason: r.reason } },
        );
        nowFail++;
      }
    }
    console.log(`Refilter: ${nowPass} job(s) now pass, ${nowFail} job(s) now filtered out`);
  }

  if (since) {
    const res = await JobModel.updateMany(
      { ...dateFilter, status: { $in: ['scored', 'score_failed'] } },
      { $set: { status: 'new' } },
    );
    console.log(`Queued ${res.modifiedCount} job(s) for re-scoring`);
  }

  if (!values['no-score']) {
    const s = await scorePendingJobs(createScorer(profile));
    console.log(
      `Scoring: ${s.scored} scored, ${s.failed} failed, ${s.remaining} waiting${s.stoppedReason ? ` (stopped: ${s.stoppedReason})` : ''}`,
    );
  }
} finally {
  await disconnectDb();
}
