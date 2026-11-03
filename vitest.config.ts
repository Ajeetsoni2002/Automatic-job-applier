import os from 'node:os';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/*/src/**/*.test.ts',
      'apps/api/src/**/*.test.ts',
      'apps/worker/src/**/*.test.ts',
    ],
    environment: 'node',
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      JWT_SECRET: 'test-secret-test-secret-test-secret',
      ADMIN_EMAIL: 'admin@example.com',
      // bcrypt hash of "test-password-123"
      ADMIN_PASSWORD_HASH: '$2b$04$wTniw/73H5EcXu3mxOxqRuzRNhbsGzE9XUnkhYWlBMNr4Axt1XUye',
      LLM_MOCK: 'true',
      DRY_RUN: 'true',
      MIN_SCORE: '70',
      ANTHROPIC_API_KEY: '',
      TZ: 'Asia/Kolkata',
      // Uploads, PDFs and browser profiles made by tests stay out of your real ~/.job-autopilot.
      APP_HOME: path.join(os.tmpdir(), 'job-autopilot-test-home'),
    },
  },
});
