# Job Autopilot — Implementation Plan

Single-user job search automation system for a single candidate (MERN developer, 0–3 yrs, India + global remote).
This plan is based on the original design doc, with the corrections listed in section 1 applied.

## Status (2026-10-08)

**Phase 1 is built** (M1–M13). Differences from the plan below:
- Added a **Filtered** dashboard page and `npm run rescore '--' --refilter`, for tuning hard filters without re-fetching.
- Added a `titleKeywords` preference: a job title must contain one of them. Company boards list sales, HR and ops roles too, and this keeps those away from the LLM.
- Per-source minimum run interval (Remotive: 6h) and a dry-run mode (`ingest:once --dry`).
- Arbeitnow and RemoteOK were not added (optional extras, as planned).
- Gmail parsers are tested against synthetic emails only. They need a check against real alert emails (see README).
- Channel modes are stored and shown, but read-only until Phase 2.

**Phase 2a (application kits) is built:** tailored one-page resume PDF + cover letter per job, with a claim checker (technologies and numbers must come from the profile), auto-generation for top jobs within a daily limit, generation on shortlist, and a dashboard panel to download, review and edit. Gmail can now also be read over IMAP with an App Password (no 7-day expiry).

**Phase 3 (ATS auto-apply) is built:** form reading for Greenhouse (plus its questions API), Lever and Ashby; answers from profile → Q&A bank/saved answers → LLM, with personal facts always left to the user; review/approve page; submission in a visible persistent Chrome profile with CAPTCHA hand-off, screenshots, confirmation detection, daily limit and DRY_RUN. Tested end to end in DRY_RUN on one live form per ATS. A discovery command finds more companies on these ATSs (15 added).

**Phase 2b (cold email) is built:** recruiter emails come from job posts or are added by hand (per job, or as a new manual job); Hunter.io was dropped because it needs a company email. Drafts by the smart model with the claim checker, review/edit/approve page, sending via Gmail SMTP with an App Password in a weekday 09:30–18:30 window with random gaps and a daily limit, one threaded follow-up, reply/bounce/opt-out detection over IMAP, do-not-email list, Telegram notice on replies, digest line. DRY_RUN blocks sending.

**Apply from any link is built:** paste a job or form link from any careers site; the worker opens it in a visible Chrome profile, reads the job, makes the kit, clicks Apply / opens embedded forms, fills multi-page forms page by page (answers stored per page and reused), hands logins/sign-ups/OTP to the user in the window (no passwords stored), asks for unknown answers in the dashboard, and submits after approval (or by itself if chosen). Smoke-tested on a real Lever page and a Greenhouse form embedded in a company site, without submitting.

**Phase 4 (LinkedIn + Naukri) is built (2026-10-09):** manual-login sessions in separate Chrome profiles (Connect in Settings, no stored passwords); a browser-based `naukri` source (Naukri alerts never reached the alerts mailbox; tested live: 91 jobs fetched, 15 past filters); LinkedIn Easy Apply through the form engine scoped to the dialog; Naukri one-click apply plus screening-chat answers; a 10-minute tick with daytime hours, random 6–15 min gaps, daily limits, approve/auto; pause-for-24h on CAPTCHA/checkpoint/block/logout with Telegram notices; external "apply on company site" jobs handed to link applications. Apply flows are tested on look-alike pages; the first live LinkedIn/Naukri applications still need a supervised run after you connect.

**Decisions for the next phases (2026-10-08):** cold email and ATS applications start in approve mode and move to auto once quality is confirmed; LinkedIn/Naukri will run in auto mode at a low daily limit, locally only, stopping on any CAPTCHA or security check (the user accepted the account risk).

---

## 1. Corrections to the original design

| # | Original design | Problem | Change in this plan |
|---|---|---|---|
| 1 | BullMQ + Redis, with node-cron fallback | Two queue code paths for a single-user app. Redis does not run natively on Windows, which is the local dev machine. | **node-cron + MongoDB-backed queue** (one `tasks` collection with status + lock). No Redis. Can be swapped for BullMQ later if needed. |
| 2 | ATS forms (Greenhouse/Lever/Ashby) = low risk, `auto` by default | Most of these forms now carry reCAPTCHA/hCaptcha. From a VPS (datacenter IP) the CAPTCHA rate is higher. Greenhouse's application POST API needs the *company's* API key, so it can't be used. | ATS apply defaults to **`approve`**, runs **locally first**. Expect many jobs to fall into `awaiting_approval` due to CAPTCHA. That's acceptable. |
| 3 | Workday in the overview diagram | Workday needs a separate account per company + heavy anti-bot. Not feasible to automate safely. | **Workday dropped** (only appears as a link in dashboard). |
| 4 | Hunter.io free tier, 20–30 cold emails/day | Hunter free plan gives only a small number of searches and verifications **per month** (≈25 searches / 50 verifications; check current limits). That supports ~1 email/day, not 25. | Default `EMAIL_DAILY_LIMIT=5`, contact lookup only for jobs with score ≥ 80. Cache every contact found. Paid plan or Apollo is an upgrade path. |
| 5 | Gmail API OAuth (implied "just works") | An OAuth app left in **Testing** status issues refresh tokens that **expire after 7 days**. Daily cron would silently break every week. | Set the Google Cloud OAuth app to **"In production"** (unverified is fine for personal use; you'll click through a warning once). Token stored outside the repo. Phase 1 uses only `gmail.readonly`; `gmail.send` is added in Phase 2. |
| 6 | Gmail alert emails → "job links" → scoring | LinkedIn/Naukri alert emails contain title, company, location and a **tracking redirect link**, but **no job description**. Fetching the LinkedIn/Naukri page to get the JD = scraping, which is what we're avoiding. | Parse per-sender, canonicalize URL (extract job ID, strip tracking). Score on available fields with `confidence: "low"`. Dashboard shows these separately. |
| 7 | `data/profile.yaml` created with placeholders | Real personal data (phone, email, CTC) would end up in git. | Commit `data/*.example.yaml` only. Real `data/profile.yaml`, `qa_bank.yaml`, `target_companies.yaml` are **gitignored**. |
| 8 | Dedup hash = company + title + location | "Bangalore" vs "Bengaluru", "Razorpay Software Pvt Ltd" vs "Razorpay", "Sr." vs "Senior" all produce different hashes. | Normalize company, title, city before hashing. Also unique index on `(source, sourceJobId)`. On cross-source match, keep one Job and append to `seenOn[]`. |
| 9 | "Validation step flags any claim not traceable to profile" | Asking an LLM to free-write and then catching lies afterwards is unreliable. | Tailoring works by **selection**: every bullet in `profile.yaml` has an `id`; the LLM returns selected IDs + optional rephrasing. Validator rejects any rephrase that introduces new numbers, skills, companies or dates, and falls back to the original bullet. |
| 10 | Target list = companies on Greenhouse/Lever/Ashby | For 0–3 yr MERN roles in India, most hiring happens on Naukri/LinkedIn, and many Indian companies use Keka, Darwinbox, Zoho Recruit, Freshteam. Greenhouse/Lever/Ashby volume will be small. | Treat **Gmail alerts + Adzuna** as the main India pipeline. ATS boards are for a curated list of product companies + global remote. |
| 11 | Playwright on Naukri in "assist" mode is safe | Playwright-controlled Chrome is still detectable (`navigator.webdriver`, CDP). Lower risk than full auto, but not zero. | Use a **dedicated persistent Chrome profile** (not your daily one), headed, `channel: "chrome"`, low daily volume. Phase 4 alternative to evaluate: a small Chrome extension that autofills in your real browser. |
| 12 | Adzuna descriptions used for scoring | Adzuna API returns a **truncated** description (a few hundred chars). | Score with what's available, mark `confidence: "medium"`. |
| 13 | `DRY_RUN=true` | Unclear whether it blocks the Telegram digest too. | `DRY_RUN` blocks every **outbound action to third parties** (applications, emails). Notifications to yourself (Telegram) still send. |
| 14 | LLM cost not addressed | Scoring hundreds of jobs/day adds up. | Prompt caching for the profile system prompt, `MAX_LLM_CALLS_PER_DAY` cap, `LlmUsage` collection to track token spend. Optional Batch API for scoring. |

Everything else in the original design (channel modes, kill switch, idempotency, local-only LinkedIn/Naukri, phase order) is kept.

---

## 2. Architecture

```
                         ┌────────────── apps/worker (node-cron) ──────────────┐
 Sources                 │                                                     │
  Adzuna (in)  ─┐        │  ingest ──► normalize ──► dedup ──► hard filters    │
  Remotive     ─┤        │                                         │           │
  Greenhouse   ─┼──────► │                                         ▼           │
  Lever        ─┤        │                                    LLM score (fast) │
  Ashby        ─┤        │                                         │           │
  Gmail alerts ─┘        │                     score ≥ MIN_SCORE ──┴─► tasks   │
                         │                                     (Phase 2+ queue)│
                         └──────────────────────────┬──────────────────────────┘
                                                    │
                                              MongoDB
                                                    │
               apps/api (Express, JWT) ◄────────────┴────────► Telegram digest
                       │
               apps/web (React + Vite dashboard)

 Local machine only (Phase 3–4): apps/worker local-assist → Playwright (headed, persistent profile)
```

**Defaults chosen:**
- Node.js 22 LTS, TypeScript strict, npm workspaces
- MongoDB: local install or MongoDB Atlas free tier (M0) — connection string via `MONGODB_URI`
- LLM: `LLM_MODEL_FAST=claude-haiku-4-5`, `LLM_MODEL_SMART=claude-sonnet-5-5` (overridable)
- Timezone: `Asia/Kolkata`; ingestion at 07:00 and 15:00, digest at 09:00
- UI: Tailwind CSS + TanStack Query + React Router
- Everything Windows-compatible (no bash-only npm scripts; `cross-env` where needed)

---

## 3. Repository structure

```
job-autopilot/
├─ apps/
│  ├─ api/                 Express REST API
│  │  └─ src/{routes,middleware,services,app.ts,server.ts}
│  ├─ web/                 React + Vite dashboard
│  │  └─ src/{pages,components,api,hooks}
│  └─ worker/
│     └─ src/
│        ├─ sources/       one adapter per source + JobSource interface
│        ├─ pipeline/      normalize, dedup, filter, score
│        ├─ llm/           Anthropic client, prompts, usage tracking
│        ├─ gmail/         OAuth, alert parsers (linkedin, naukri, indeed, generic)
│        ├─ notify/        Telegram
│        ├─ scheduler.ts   node-cron entry
│        └─ cli/           ingest-once, gmail-auth, profile-check, seed
├─ packages/
│  └─ shared/              Zod schemas, types, Mongoose models, env loader, logger, utils
├─ data/
│  ├─ profile.example.yaml
│  ├─ qa_bank.example.yaml
│  └─ target_companies.example.yaml
├─ deploy/
│  ├─ ecosystem.config.js
│  └─ nginx.example.conf
├─ docs/
├─ .env.example
├─ .gitignore              .env, data/*.yaml (non-example), .secrets/, browser-profiles/, screenshots/, output/
└─ README.md
```

Secrets and tokens live in `~/.job-autopilot/` (Gmail token, browser profiles), configurable via `APP_HOME`.

---

## 4. Data models (Phase 1)

Models are defined in `packages/shared` so api and worker share them.

**Job**
- `source`, `sourceJobId`, `url`, `canonicalUrl`, `company`, `companyNorm`, `title`, `titleNorm`, `location`, `city`, `country`, `workMode` (onsite | hybrid | remote | unknown), `experienceMin`, `experienceMax`, `salary {min,max,currency,period}`, `description`, `descriptionQuality` (full | truncated | none), `postedAt`, `fetchedAt`, `dedupeHash`, `seenOn[] {source, url, sourceJobId}`
- `status`: `new | filtered_out | scored | shortlisted | ignored | applied_manually | queued` (later phases extend)
- `filterReason` (when filtered_out)
- Indexes: unique `(source, sourceJobId)`, unique `dedupeHash`, `(status, score desc)`, `postedAt`

**JobScore**
- `jobId`, `score` (0–100), `confidence` (high | medium | low), `reasons[]`, `matchedSkills[]`, `missingSkills[]`, `redFlags[]`, `model`, `promptVersion`, `createdAt`
- Score denormalized onto Job (`score`, `scoreConfidence`) for fast sorting

**Settings** (single document)
- `killSwitch`, `minScore` (default 70), `sources {name: enabled}`, `channels {name: {mode, dailyLimit}}` (stored now, used from Phase 2), `digest {enabled, hour}`

**SourceRun**
- `source`, `startedAt`, `finishedAt`, `status` (ok | failed | partial), `fetched`, `inserted`, `duplicates`, `filtered`, `error`

**LlmUsage**
- `date`, `model`, `purpose` (score | tailor | …), `inputTokens`, `outputTokens`, `cachedTokens`, `calls`

**ProcessedEmail**
- `gmailMessageId` (unique), `sender`, `parsedJobs`, `processedAt`

**Task** (MongoDB queue; created in Phase 1, consumed from Phase 2)
- `type`, `payload`, `status` (pending | running | done | failed), `runAt`, `attempts`, `lockedUntil`, `idempotencyKey` (unique)

Phase 2+ models (`Application`, `Contact`, `Outreach`, `Suppression`) are added in their phases.

---

## 5. Phase 1 — detailed tasks

Each milestone ends with something runnable/testable.

### M1. Monorepo scaffold
- npm workspaces, root `tsconfig.base.json`, ESLint + Prettier, Vitest config
- `packages/shared`: `env.ts` (Zod-validated env, fails fast with a readable message), `logger.ts` (Pino, pretty in dev), `db.ts` (Mongoose connect)
- Root scripts: `dev` (api + web + worker concurrently), `build`, `test`, `lint`, `ingest:once`, `seed`, `gmail:auth`, `profile:check`
- `.env.example`, `.gitignore`, `git init` with first commit
- ✅ `npm run dev` starts three empty processes; `npm run test` passes

### M2. Profile and config files
- `data/profile.example.yaml`: personal, links, summary, experience (each bullet with `id`), projects (bullets with `id`), skills (grouped), education, preferences (roles, locations, workModes, minSalary, noticePeriod, maxExperienceYears, excludeCompanies, excludeKeywords)
- `data/qa_bank.example.yaml`: notice period, current/expected CTC, relocation, work authorization, years of experience per skill, "why this company" template, etc.
- `data/target_companies.example.yaml`: `name`, `ats` (greenhouse | lever | ashby), `slug`, `priority`
- Zod schemas + loader; `npm run profile:check` validates and prints a summary
- ✅ Invalid YAML gives a clear error pointing at the field

### M3. Data layer
- Mongoose models from section 4 with indexes
- `npm run seed`: inserts ~20 sample jobs with scores across statuses
- ✅ Seed runs twice without duplicates

### M4. Source adapters
- Interface:
  ```ts
  interface JobSource {
    name: SourceName;
    isEnabled(ctx): boolean;
    fetch(ctx): Promise<RawJob[]>;      // ctx: settings, profile, http client, logger, since
  }
  ```
- Shared HTTP client: timeout, retry with exponential backoff on 429/5xx, per-source concurrency + min interval, descriptive User-Agent
- Adapters:
  - **Adzuna** — `country=in`, queries from `profile.preferences.roles`, paginate up to a cap
  - **Remotive** — category `software-dev`, max 4 fetches/day (their stated limit), keep attribution link
  - **Greenhouse** — `boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true`
  - **Lever** — `api.lever.co/v0/postings/{slug}?mode=json`
  - **Ashby** — `api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=true`
- HTML → plain text for descriptions
- Tests: each adapter against a saved JSON fixture (no network in tests)
- ✅ `npm run ingest:once '--' --source=greenhouse --dry` prints normalized jobs

(Arbeitnow and RemoteOK are optional extras: Arbeitnow is mostly EU jobs, RemoteOK requires attribution. Add only if Remotive volume is low.)

### M5. Normalize + dedup
- City aliases (Bangalore→Bengaluru, Gurgaon→Gurugram, Bombay→Mumbai, "Remote - India"→remote/IN…)
- Company normalization (strip Pvt Ltd, Private Limited, Inc, LLC, Technologies, punctuation)
- Title normalization (Sr→Senior, Jr→Junior, SDE-1→Software Engineer I, strip req IDs)
- Experience parser: "0-2 yrs", "2+ years", "Fresher", seniority words (Senior/Lead/Staff/Principal/Manager)
- `dedupeHash = sha1(companyNorm | titleNorm | city|remote)`
- Tests: table-driven cases for each normalizer and dedup collisions
- ✅ Same job from Greenhouse + Gmail alert results in one Job with two `seenOn` entries

### M6. Hard filters
- Rules from `profile.preferences`: location/workMode allowlist, `experienceMin > maxExperienceYears` → out, seniority keywords → out, excluded companies/keywords → out, older than `MAX_JOB_AGE_DAYS` (default 21) → out
- Filtered jobs are **stored** with `status=filtered_out` and `filterReason` (useful for tuning; viewable in dashboard)
- ✅ Unit tests per rule

### M7. LLM scoring
- Anthropic SDK client; model from `LLM_MODEL_FAST`
- System prompt = scoring rubric + full profile (prompt-cached); user message = one job
- Output via tool use / JSON, validated by Zod: `score`, `confidence`, `reasons`, `matchedSkills`, `missingSkills`, `redFlags`; one retry on invalid output, then mark job `score_failed`
- `confidence` forced to `low` when `descriptionQuality = none`
- Rubric weights: stack match 40, experience fit 25, role type 15, location/workMode 10, company/salary signals 10
- Daily cap `MAX_LLM_CALLS_PER_DAY` (default 300); usage written to `LlmUsage`
- `promptVersion` stored so scores can be recomputed after prompt changes (`npm run rescore '--' --since=…`)
- No API key or `LLM_MOCK=true` → deterministic keyword-based mock scorer (used in tests and seed)
- ✅ Tests with mocked client: valid JSON, invalid JSON → retry, cap reached → stop

### M8. Gmail alert ingestion
- `npm run gmail:auth`: local OAuth desktop flow, saves refresh token to `~/.job-autopilot/gmail-token.json`
- Scope: `gmail.readonly`
- User creates a Gmail filter that labels alert emails as `job-alerts`; worker queries `label:job-alerts newer_than:3d`
- Parsers by sender: LinkedIn, Naukri, Indeed; generic fallback uses the fast LLM to extract `{title, company, location, url}` from the email HTML
- URL canonicalization: follow known patterns to extract job IDs (e.g. LinkedIn `/jobs/view/{id}`), strip UTM/tracking params. Do **not** fetch the job page.
- Idempotency via `ProcessedEmail`
- Tests: parsers against saved sample emails (anonymized `.html` fixtures)
- ✅ Running twice on the same mailbox creates no duplicates

### M9. Worker pipeline + scheduler
- `runPipeline()`: all enabled sources via `Promise.allSettled` → normalize → dedup/upsert → filter → score new jobs → write `SourceRun` per source
- Mongo lock document so two runs never overlap
- Kill switch checked at the start of every run
- node-cron: ingestion 07:00 and 15:00 IST, digest 09:00 IST
- `npm run ingest:once` runs the full pipeline once and prints a summary table
- ✅ One source throwing does not stop the others; failure visible in `SourceRun`

### M10. API
- Auth: single user; `ADMIN_EMAIL` + `ADMIN_PASSWORD_HASH` (bcrypt) in env; `npm run hash-password` helper; JWT in httpOnly cookie; login rate limit
- Middleware: helmet, CORS (web origin only), Zod request validation, central error handler
- Endpoints:
  - `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`
  - `GET /jobs` (filters: status, minScore, source, workMode, confidence, text search, postedAfter; sort; pagination)
  - `GET /jobs/:id` (with score details and `seenOn`)
  - `PATCH /jobs/:id` (status: shortlisted | ignored | applied_manually, notes)
  - `GET /stats` (counts by status/source, today's new jobs, LLM usage)
  - `GET /settings`, `PUT /settings`
  - `GET /source-runs`
  - `POST /admin/run-pipeline` (triggers a run via the Task queue)
- Tests: supertest for auth guard and jobs filtering

### M11. Dashboard
- Pages: Login, **Jobs** (table: score badge, title, company, location, mode, source, posted; filters; detail drawer with reasons, matched/missing skills, red flags, "Open job" link, status buttons), **Settings** (min score, kill switch, sources on/off, digest time), **Source health** (last runs, errors), **Filtered** (filtered-out jobs with reasons)
- Low-confidence scores clearly labelled
- Mobile-usable layout
- ✅ Shortlisting a job in UI persists and shows in filters

### M12. Telegram digest
- Bot token + chat ID from env; `npm run telegram:test` sends a test message
- Daily message: new jobs ≥ minScore (top 10 with score, title, company, link), counts by source, source failures, LLM usage
- Sent even when `DRY_RUN=true`; skipped when kill switch is on
- ✅ Digest received on phone

### M13. Docs + deployment
- README: prerequisites, env vars table, Gmail OAuth setup (incl. "In production" step), Telegram setup, local run, VPS run
- `deploy/ecosystem.config.cjs` (api, worker; web served as static build by Nginx)
- `deploy/nginx.example.conf` (HTTPS via certbot, `/api` proxy, static web)
- "How to verify Phase 1" checklist (section 9)

---

## 6. Phase 2 — Tailoring + cold email (outline)

- **Resume**: ATS-friendly single-column HTML template → PDF via Playwright. LLM (smart model) returns `{summary, selectedBulletIds[], rephrases{id: text}, skillsOrder[]}`. Validator: rephrase may not add numbers, skills, companies, dates or tools absent from the original bullet/profile; failing rephrases fall back to the original text. PDFs in `output/resumes/{jobId}.pdf` (gitignored).
- **Cover letter + answers**: from Q&A bank first; LLM only for gaps; same claim validator.
- **Contacts**: Hunter domain search (only for score ≥ 80, cached per company), email verification required before send.
- **Cold email**: Gmail `gmail.send` scope added, plain text, personalized (company + role + 1 relevant project), opt-out line, `Suppression` list, random 2–8 min gaps, sending window 10:00–18:00 IST on weekdays, `EMAIL_DAILY_LIMIT=5` to start.
- **Follow-up**: one follow-up after 4 days; reply detection by polling the Gmail thread; reply → stop + Telegram alert.
- **Default mode**: `approve` for the first 2 weeks (each email shown in an Approval Queue page with edit), then switch to `auto` if quality is good.
- Models: `Application`, `Contact`, `Outreach`, `Suppression`.

## 7. Phase 3 — ATS apply (outline)

- Executors for Greenhouse, Lever, Ashby. Greenhouse's board API exposes the question list (`?questions=true`), so answers can be planned **before** opening the browser.
- Flow: plan answers → any unknown required question → `awaiting_approval` with the question listed → user answers in dashboard (answer saved to Q&A bank) → execute.
- Playwright: fill, upload resume, screenshot before submit and after submit, verify confirmation text.
- CAPTCHA detected → stop, `awaiting_approval` with "open and submit manually" link. Never solve or bypass.
- Runs **locally** by default (`npm run local-assist`), mode `approve`, daily limit 10.
- Approval Queue + Applications kanban pages.

## 8. Phase 4 — Naukri assist, referrals, analytics (outline)

- **Naukri assist** (local only): dedicated persistent Chrome profile in `~/.job-autopilot/browser-profiles/naukri`, user logs in manually once. Script opens job, fills what it can, **never clicks final submit**, never logs in, never touches CAPTCHA. Low daily volume. Evaluate Chrome-extension autofill as a lower-detection alternative.
- **Referral assistant**: search API (Brave Search or SerpAPI; check free-tier quotas) with `site:linkedin.com/in "<company>" "<role keyword>"`; show name/title/profile link; draft a short message (≤ 300 chars for connection notes); "Copy message" + "Open profile" buttons. Nothing is sent automatically.
- **Analytics**: funnel by source and channel (jobs → scored → applied → replies → interviews), reply rate per email template, score vs. outcome.

---

## 9. Phase 1 verification checklist

```
npm install
npm run profile:check        # profile.yaml valid
npm run seed                 # sample data
npm run dev                  # api :4000, web :5173, worker idle
npm run ingest:once          # real fetch from all enabled sources
npm run test
```

- [ ] Dashboard login works; Jobs page shows jobs with score, reasons, missing skills
- [ ] Running `ingest:once` twice does not create duplicate jobs
- [ ] The same job from two sources shows once with both sources
- [ ] Filtered-out jobs are visible with a reason
- [ ] Disabling one source in Settings skips it on the next run
- [ ] Breaking one source (wrong slug) shows a failed `SourceRun`, other sources still ingest
- [ ] Kill switch on → pipeline exits immediately
- [ ] Gmail alerts are parsed; re-running doesn't re-process the same email
- [ ] `LlmUsage` shows today's calls; cap stops scoring when reached
- [ ] Telegram digest received
- [ ] `git status` shows no `.env`, real profile YAMLs or tokens

---

## 10. Environment variables (Phase 1)

| Variable | Default | Notes |
|---|---|---|
| `NODE_ENV` | development | |
| `TZ` | Asia/Kolkata | |
| `APP_HOME` | `~/.job-autopilot` | tokens, browser profiles (outside repo) |
| `MONGODB_URI` | `mongodb://127.0.0.1:27017/job-autopilot` | |
| `API_PORT` | 4000 | |
| `WEB_ORIGIN` | `http://localhost:5173` | CORS |
| `JWT_SECRET` | — | required |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD_HASH` | — | required |
| `DRY_RUN` | true | blocks outbound third-party actions |
| `ANTHROPIC_API_KEY` | — | if empty → mock scorer |
| `LLM_MODEL_FAST` | claude-haiku-4-5 | |
| `LLM_MODEL_SMART` | claude-sonnet-5-5 | Phase 2+ |
| `LLM_MOCK` | false | |
| `MAX_LLM_CALLS_PER_DAY` | 300 | |
| `MIN_SCORE` | 70 | initial value; Settings overrides |
| `MAX_JOB_AGE_DAYS` | 21 | |
| `ADZUNA_APP_ID`, `ADZUNA_APP_KEY` | — | |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | — | OAuth desktop client |
| `GMAIL_ALERT_LABEL` | job-alerts | |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | — | |
| `INGEST_CRON` | `0 7,15 * * *` | |
| `DIGEST_CRON` | `0 9 * * *` | |

---

## 11. Prerequisites (before Phase 1 build)

1. Node.js 22 LTS + Git installed
2. MongoDB: local install **or** MongoDB Atlas free cluster (connection string)
3. Anthropic API key
4. Adzuna developer account → `app_id` + `app_key`
5. Google Cloud project → enable Gmail API → OAuth consent screen (External, **publish to "In production"**) → OAuth client type "Desktop app"
6. Telegram: create bot via @BotFather → token; send the bot a message → get your chat ID
7. Job alerts on LinkedIn / Naukri / Indeed → Gmail filter that applies label `job-alerts`
8. 15–30 target companies with ATS type + slug (can be filled after Phase 1 starts; examples will be in the template)

---

## 12. Known risks

| Risk | Mitigation |
|---|---|
| LinkedIn/Naukri account restriction | No automation on those sites in Phase 1–3; Phase 4 assist only, local, low volume, no login/CAPTCHA automation |
| Gmail account flagged for spam | Low volume, plain text, personalized, opt-out, suppression list, approve mode first |
| Wrong/fabricated info in applications | Selection-based tailoring + validator; approve mode for first weeks |
| LLM cost creep | Daily cap, caching, usage tracking, hard filters before LLM |
| Source API changes | Fixture tests, `SourceRun` failure tracking, failure shown in digest |
| ATS form changes break executors | Screenshots + `failed` status with error; executor stops, never guesses |
