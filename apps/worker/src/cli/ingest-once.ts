// Runs the full pipeline once.
//   npm run ingest:once                       all enabled sources, then scoring
//   npm run ingest:once '--' --source=greenhouse,lever --dry   fetch + filter only, print, write nothing
//   npm run ingest:once '--' --no-score --force
import { parseArgs } from 'node:util';
import { connectDb, disconnectDb, SOURCE_NAMES, type SourceName } from '@ja/shared';
import { runPipeline } from '../pipeline/run.js';

const { values } = parseArgs({
  options: {
    source: { type: 'string' },
    dry: { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
    'no-score': { type: 'boolean', default: false },
    preview: { type: 'string', default: '10' },
  },
});

const sources = values.source?.split(',').map((s) => s.trim()) as SourceName[] | undefined;
const unknown = sources?.filter((s) => !SOURCE_NAMES.includes(s));
if (unknown?.length) {
  console.error(`Unknown source(s): ${unknown.join(', ')}. Valid: ${SOURCE_NAMES.join(', ')}`);
  process.exit(1);
}

await connectDb();
try {
  const summary = await runPipeline({
    trigger: 'cli',
    sources,
    dryRun: values.dry,
    force: values.force,
    skipScoring: values['no-score'],
  });

  if (summary.skipped) console.log(`\nPipeline skipped: ${summary.skipped}`);
  console.log(
    `\nRun ${summary.runId} — ${(summary.durationMs / 1000).toFixed(1)}s${values.dry ? ' (dry run, nothing saved)' : ''}`,
  );
  console.table(
    summary.sources.map((s) => ({
      source: s.source,
      status: s.status,
      fetched: s.fetched,
      [values.dry ? 'would pass' : 'new']: s.inserted,
      filtered: s.filtered,
      duplicates: s.duplicates,
      invalid: s.invalid,
      note: (s.message ?? '').slice(0, 80),
    })),
  );

  if (values.dry) {
    const n = Number(values.preview) || 10;
    for (const s of summary.sources) {
      if (!s.preview?.length) continue;
      console.log(`\n${s.source} — first ${Math.min(n, s.preview.length)} of ${s.preview.length}:`);
      for (const j of s.preview.slice(0, n)) {
        const verdict = j.filter.pass ? 'PASS' : `skip: ${j.filter.reason}`;
        console.log(
          `  [${verdict}] ${j.title} — ${j.company} | ${j.location || '-'} | ${j.workMode} | exp ${j.experienceMin ?? '?'}`,
        );
      }
    }
  }

  if (summary.scoring) {
    const sc = summary.scoring;
    console.log(
      `\nScoring: ${sc.scored} scored, ${sc.failed} failed, ${sc.remaining} still waiting${sc.stoppedReason ? ` (stopped: ${sc.stoppedReason})` : ''}`,
    );
  }
} finally {
  await disconnectDb();
}
