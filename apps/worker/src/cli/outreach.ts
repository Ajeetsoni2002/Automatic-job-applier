// Cold email from the terminal.
//   npm run outreach '--' --test                              send one test email to yourself
//   npm run outreach '--' --draft=<jobId> --to=hr@acme.com    draft an email to a recruiter
//   npm run outreach '--' --tick                              replies → follow-ups → send what's due
import { parseArgs } from 'node:util';
import { connectDb, disconnectDb, OutreachModel } from '@ja/shared';
import { draftOutreach, outreachTick, sendTestEmail } from '../outreach/index.js';

const { values } = parseArgs({
  options: {
    test: { type: 'boolean', default: false },
    draft: { type: 'string' },
    to: { type: 'string' },
    name: { type: 'string' },
    tick: { type: 'boolean', default: false },
  },
});

await connectDb();
try {
  if (values.test) {
    console.log(`Test email sent (Message-ID ${await sendTestEmail()}). Check your inbox.`);
  } else if (values.draft) {
    if (!values.to) throw new Error('--to=<email> is required with --draft');
    const r = await draftOutreach(values.draft, values.to, { name: values.name, source: 'manual' });
    const o = await OutreachModel.findById(r.outreachId).lean();
    console.log(`${r.status}: ${o?.subject}\n\n${o?.body}`);
    for (const i of o?.issues ?? []) console.log(`! ${i}`);
  } else if (values.tick) {
    await outreachTick();
    console.log('done');
  } else {
    console.log('Use --test, --draft=<jobId> --to=<email>, or --tick');
  }
} finally {
  await disconnectDb();
}
