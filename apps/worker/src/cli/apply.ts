// Phase 3 from the terminal.
//   npm run apply '--' --prepare=<jobId>   read the job's form and work out answers
//   npm run apply '--' --submit=<appId>    fill + submit (or just fill + screenshot when DRY_RUN=true)
//   npm run apply '--' --auto              what the pipeline does after each run
import { parseArgs } from 'node:util';
import { ApplicationModel, connectDb, disconnectDb } from '@ja/shared';
import { autoApply, prepareApplication, submitApplication } from '../apply/index.js';

const { values } = parseArgs({
  options: {
    prepare: { type: 'string' },
    submit: { type: 'string' },
    auto: { type: 'boolean', default: false },
  },
});

await connectDb();
try {
  if (values.prepare) {
    const r = await prepareApplication(values.prepare);
    const app = await ApplicationModel.findById(r.appId).lean();
    console.log(`application ${r.appId}: ${r.status} (${app?.applyUrl})`);
    for (const a of app?.answers ?? []) {
      const v = Array.isArray(a.value) ? a.value.join('; ') : String(a.value);
      const flag = a.needsInput ? 'NEEDS INPUT' : a.needsReview ? 'review' : '';
      console.log(
        `  ${a.required ? '*' : ' '} [${a.kind}] ${a.label.slice(0, 50).padEnd(50)} = ${v.slice(0, 70).replace(/\n/g, ' ')}  (${a.source || '-'}) ${flag}`,
      );
    }
  } else if (values.submit) {
    console.log(`result: ${await submitApplication(values.submit)}`);
    const app = await ApplicationModel.findById(values.submit).lean();
    if (app?.error) console.log(`note: ${app.error}`);
    for (const s of app?.screenshots ?? []) console.log(`screenshot (${s.label}): ${s.path}`);
  } else if (values.auto) {
    console.log(await autoApply());
  } else {
    console.log('Use --prepare=<jobId>, --submit=<appId> or --auto');
  }
} finally {
  await disconnectDb();
}
