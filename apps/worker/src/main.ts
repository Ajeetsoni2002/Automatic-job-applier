import cron from 'node-cron';
import { connectDb, disconnectDb, getEnv, loadProfile, logger } from '@ja/shared';
import { sendDigest } from './notify/digest.js';
import { telegramConfigured } from './notify/telegram.js';
import { outreachTick } from './outreach/index.js';
import { portalTick } from './portals/tick.js';
import { runPipeline } from './pipeline/run.js';
import { startTaskPoller } from './tasks.js';

async function main() {
  const env = getEnv();
  const profile = loadProfile(); // fail fast on an invalid profile
  if (profile.isExample)
    logger.warn('Using data/profile.example.yaml — copy it to data/profile.yaml and fill it in');
  await connectDb();

  for (const [name, expr] of [
    ['INGEST_CRON', env.INGEST_CRON],
    ['DIGEST_CRON', env.DIGEST_CRON],
  ] as const) {
    if (!cron.validate(expr)) throw new Error(`${name} is not a valid cron expression: "${expr}"`);
  }

  const ingest = cron.schedule(
    env.INGEST_CRON,
    async () => {
      try {
        await runPipeline({ trigger: 'cron' });
      } catch (err) {
        logger.error({ err: (err as Error).message }, 'scheduled pipeline failed');
      }
    },
    { timezone: env.TZ, name: 'ingest', noOverlap: true },
  );

  const digest = cron.schedule(
    env.DIGEST_CRON,
    async () => {
      const problem = telegramConfigured();
      if (problem) return logger.warn(`digest skipped: ${problem}`);
      try {
        await sendDigest();
      } catch (err) {
        logger.error({ err: (err as Error).message }, 'digest failed');
      }
    },
    { timezone: env.TZ, name: 'digest', noOverlap: true },
  );

  // Replies, follow-ups and sending (sending itself only happens inside the weekday window).
  const outreach = cron.schedule('*/10 * * * *', () => outreachTick(), {
    timezone: env.TZ,
    name: 'outreach',
    noOverlap: true,
  });

  // LinkedIn / Naukri: queues the next application when it's time (see portals/tick.ts).
  const portals = cron.schedule(
    '*/10 * * * *',
    async () => {
      try {
        await portalTick();
      } catch (err) {
        logger.error({ err: (err as Error).message }, 'portal tick failed');
      }
    },
    { timezone: env.TZ, name: 'portals', noOverlap: true },
  );

  const stopPoller = startTaskPoller();
  logger.info({ ingest: env.INGEST_CRON, digest: env.DIGEST_CRON, tz: env.TZ }, 'worker started');

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'worker shutting down');
    await ingest.stop();
    await digest.stop();
    await outreach.stop();
    await portals.stop();
    stopPoller();
    await disconnectDb();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.fatal({ err: (err as Error).message }, 'worker failed to start');
  process.exit(1);
});
