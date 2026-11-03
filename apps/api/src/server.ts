import { connectDb, disconnectDb, getEnv, logger } from '@ja/shared';
import { createApp } from './app.js';

const env = getEnv();
if (!env.JWT_SECRET || env.JWT_SECRET.length < 32) {
  logger.fatal('JWT_SECRET must be set in .env (at least 32 characters). See .env.example.');
  process.exit(1);
}
if (!env.ADMIN_EMAIL || !env.ADMIN_PASSWORD_HASH) {
  logger.warn(
    'ADMIN_EMAIL / ADMIN_PASSWORD_HASH not set — dashboard login will fail. Run: npm run set-password',
  );
}

await connectDb();
const server = createApp().listen(env.API_PORT, () => {
  logger.info({ port: env.API_PORT, dryRun: env.DRY_RUN }, 'api listening');
});

const shutdown = (signal: string) => {
  logger.info({ signal }, 'api shutting down');
  server.close(() => void disconnectDb().then(() => process.exit(0)));
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
