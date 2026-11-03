// Generates a tailored resume + cover letter.
//   npm run tailor '--' --job=<jobId>    one job
//   npm run tailor '--' --top=3          the best-scored jobs that don't have one yet
import { parseArgs } from 'node:util';
import { connectDb, disconnectDb, JobModel, TailoredDocModel } from '@ja/shared';
import { tailorJob } from '../tailor/index.js';

const { values } = parseArgs({ options: { job: { type: 'string' }, top: { type: 'string' } } });

await connectDb();
try {
  let ids: string[] = [];
  if (values.job) ids = [values.job];
  else {
    const n = Number(values.top ?? 1) || 1;
    const done = new Set((await TailoredDocModel.distinct('jobId')).map(String));
    const jobs = await JobModel.find({ status: { $in: ['scored', 'shortlisted'] } }, { _id: 1 })
      .sort({ score: -1 })
      .limit(n + done.size)
      .lean();
    ids = jobs
      .map((j) => String(j._id))
      .filter((id) => !done.has(id))
      .slice(0, n);
  }
  for (const id of ids) {
    const job = await JobModel.findById(id, { title: 1, company: 1, score: 1 }).lean();
    console.log(`\n${job?.score ?? '?'} | ${job?.title} — ${job?.company}`);
    const r = await tailorJob(id, 'manual');
    const doc = await TailoredDocModel.findById(r.docId).lean();
    console.log(`  status: ${r.status}${doc?.error ? ` (${doc.error})` : ''}`);
    if (doc?.resumePdfPath) console.log(`  PDF: ${doc.resumePdfPath}`);
    for (const i of doc?.issues ?? []) console.log(`  ! [${i.kind}] ${i.message}`);
  }
} finally {
  await disconnectDb();
}
