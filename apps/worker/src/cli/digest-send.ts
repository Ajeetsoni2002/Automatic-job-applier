// Sends the daily digest now (or prints it with --print).
import { parseArgs } from 'node:util';
import { connectDb, disconnectDb } from '@ja/shared';
import { buildDigest, sendDigest } from '../notify/digest.js';

const { values } = parseArgs({ options: { print: { type: 'boolean', default: false } } });

await connectDb();
try {
  if (values.print) console.log(await buildDigest());
  else console.log((await sendDigest()) ? 'Digest sent.' : 'Digest is disabled in Settings.');
} finally {
  await disconnectDb();
}
