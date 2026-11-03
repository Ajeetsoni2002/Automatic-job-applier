import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';
import { ROOT_DIR } from './paths.js';

dotenv.config({ path: path.join(ROOT_DIR, '.env'), quiet: true });

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) =>
      v === undefined || v.trim() === ''
        ? def
        : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase()),
    );

const int = (def: number) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v.trim() === '') return def;
      const n = Number(v);
      if (!Number.isInteger(n)) {
        ctx.addIssue({ code: 'custom', message: `expected an integer, got "${v}"` });
        return z.NEVER;
      }
      return n;
    });

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined));

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DRY_RUN: bool(true),

  MONGODB_URI: z.string().default('mongodb://127.0.0.1:27017/job-autopilot'),

  API_PORT: int(4000),
  WEB_ORIGIN: z.string().default('http://localhost:5173'),
  JWT_SECRET: optionalString,
  ADMIN_EMAIL: optionalString,
  ADMIN_PASSWORD_HASH: optionalString,

  ANTHROPIC_API_KEY: optionalString,
  /** Only for keys not scoped to a workspace (Console shows the ID as wrkspc_...). */
  ANTHROPIC_WORKSPACE_ID: optionalString,
  LLM_MOCK: bool(false),
  LLM_MODEL_FAST: z.string().default('claude-haiku-4-5'),
  LLM_MODEL_SMART: z.string().default('claude-sonnet-5-5'),
  MAX_LLM_CALLS_PER_DAY: int(300),

  MIN_SCORE: int(70),
  MAX_JOB_AGE_DAYS: int(21),

  ADZUNA_APP_ID: optionalString,
  ADZUNA_APP_KEY: optionalString,
  ADZUNA_MAX_PAGES: int(3),

  GOOGLE_CLIENT_ID: optionalString,
  GOOGLE_CLIENT_SECRET: optionalString,
  GMAIL_ALERT_LABEL: z.string().default('job-alerts'),
  /** IMAP + App Password: the alerts Gmail address and its 16-letter App Password (spaces ignored). */
  GMAIL_IMAP_USER: optionalString,
  GMAIL_IMAP_APP_PASSWORD: optionalString.transform((v) => v?.replace(/ /g, '')),
  GMAIL_LOOKBACK_DAYS: int(3),

  /** Outreach: the Gmail address emails are sent from, and its App Password (spaces ignored). */
  SMTP_USER: optionalString,
  SMTP_APP_PASSWORD: optionalString.transform((v) => v?.replace(/ /g, '')),

  /** Applications: run the browser without a window (servers). Locally a window lets you solve CAPTCHAs. */
  ATS_HEADLESS: bool(false),
  /** Seconds to wait for you to solve a CAPTCHA in the visible window before giving up. */
  ATS_CAPTCHA_WAIT_SECONDS: int(180),
  /** How long a pasted-link application waits for you to log in in the browser window. */
  ATS_LOGIN_WAIT_SECONDS: int(600),

  TELEGRAM_BOT_TOKEN: optionalString,
  TELEGRAM_CHAT_ID: optionalString,

  INGEST_CRON: z.string().default('0 7,15 * * *'),
  DIGEST_CRON: z.string().default('0 9 * * *'),
  TZ: z.string().default('Asia/Kolkata'),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | undefined;

/** Validated environment. Exits with a readable message when a value is malformed. */
export function getEnv(): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment variables (check .env):\n${lines.join('\n')}`);
  }
  cached = parsed.data;
  return cached;
}

/** True when the real Anthropic API should be used (key present and mock not forced). */
export function llmEnabled(env: Env = getEnv()): boolean {
  return Boolean(env.ANTHROPIC_API_KEY) && !env.LLM_MOCK;
}
