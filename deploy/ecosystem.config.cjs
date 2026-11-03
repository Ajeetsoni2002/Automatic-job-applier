// PM2 process file for a Linux VPS.  From the repo root:
//   pm2 start deploy/ecosystem.config.cjs && pm2 save
// The web dashboard is a static build served by Nginx (see nginx.example.conf), so it isn't listed here.
// Both processes read secrets from the repo-root .env.
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const common = {
  cwd: root,
  interpreter: 'node',
  interpreter_args: '--import tsx',
  env: { NODE_ENV: 'production' },
  max_memory_restart: '400M',
  time: true,
};

module.exports = {
  apps: [
    { ...common, name: 'ja-api', script: 'apps/api/src/server.ts' },
    // Exactly one worker instance: it owns the cron schedule and the task queue.
    {
      ...common,
      name: 'ja-worker',
      script: 'apps/worker/src/main.ts',
      instances: 1,
      autorestart: true,
    },
  ],
};
