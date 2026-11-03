# Job Autopilot

Personal, single-user job search automation. **Phase 1** (this code) collects jobs every day, removes the irrelevant ones with cheap rules, scores the rest against your profile with an LLM, and shows them in a dashboard plus a daily Telegram digest.

Nothing is applied for or sent anywhere in Phase 1. See [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) for the full design and later phases.

```
Sources (Adzuna, Remotive, Greenhouse, Lever, Ashby, Gmail job alerts)
   → normalize → dedupe → hard filters → LLM score → MongoDB
   → dashboard (React)  +  daily Telegram digest
```

## Repository layout

| Path | What it is |
|---|---|
| `apps/worker` | Scheduler (node-cron), sources, pipeline, LLM scoring, Gmail, Telegram, CLI scripts |
| `apps/api` | Express REST API with single-user JWT login |
| `apps/web` | React + Vite dashboard |
| `packages/shared` | Env validation, logger, Mongoose models, profile schema, shared types |
| `data/*.example.yaml` | Templates for your profile, Q&A bank and target companies |
| `deploy/` | PM2 and Nginx config for a VPS |

## Prerequisites

- Node.js 22+
- MongoDB (local service, or a MongoDB Atlas free cluster)
- Optional, but needed for the matching features:
  - Anthropic API key (without it, a free keyword-based mock scorer is used)
  - Adzuna API keys, Gmail OAuth client, Telegram bot (setup steps below)

## Local setup

```bash
npm install
cp .env.example .env                      # Windows PowerShell: Copy-Item .env.example .env
cp data/profile.example.yaml data/profile.yaml
cp data/target_companies.example.yaml data/target_companies.yaml
cp data/qa_bank.example.yaml data/qa_bank.yaml
```

1. **Fill in `data/profile.yaml`.** Every bullet needs a unique `id`. Only facts written here will ever be used about you. Check it with:
   ```bash
   npm run profile:check
   ```
2. **Set the dashboard login** in `.env`:
   ```bash
   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"   # paste as JWT_SECRET
   npm run set-password    # asks for a password and writes ADMIN_PASSWORD_HASH into .env
   ```
   Also set `ADMIN_EMAIL`.
3. **Try it with sample data:**
   ```bash
   npm run seed        # adds ~14 sample jobs (remove later with: npm run seed '--' --clear)
   npm run dev         # api :4000, worker, web :5173
   ```
   Open http://localhost:5173 and log in.
4. **Fetch real jobs:**
   ```bash
   npm run ingest:once '--' --dry     # fetch + filter, print results, save nothing
   npm run ingest:once              # full run: save, then score
   ```

## Environment variables

All variables are documented in [.env.example](.env.example). The important ones:

| Variable | Default | Notes |
|---|---|---|
| `MONGODB_URI` | `mongodb://127.0.0.1:27017/job-autopilot` | |
| `JWT_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD_HASH` | — | Required for the dashboard |
| `DRY_RUN` | `true` | Blocks outbound third-party actions (applications and emails, from Phase 2). Telegram messages to yourself still send. |
| `ANTHROPIC_API_KEY` | — | Empty means the mock scorer is used |
| `LLM_MODEL_FAST` | `claude-haiku-4-5` | Used for scoring and alert-email extraction |
| `MAX_LLM_CALLS_PER_DAY` | `300` | Hard cap. Usage is shown in the dashboard header and the digest. |
| `MIN_SCORE` | `70` | Initial value. The dashboard Settings page overrides it. |
| `MAX_JOB_AGE_DAYS` | `21` | Older postings are filtered out |
| `INGEST_CRON` / `DIGEST_CRON` | `0 7,15 * * *` / `0 9 * * *` | Times in `TZ` (default `Asia/Kolkata`) |
| `SMTP_USER`, `SMTP_APP_PASSWORD` | — | Gmail account and App Password used to send cold emails and read their replies |
| `APP_HOME` | `~/.job-autopilot` | Gmail token storage, outside the repo |

## Sources

| Source | Needs | Notes |
|---|---|---|
| Greenhouse, Lever, Ashby | `data/target_companies.yaml` | Public job-board APIs. A wrong slug shows as a "check slug" warning on the Sources page. |
| Remotive | nothing | Remote jobs. Runs at most once every 6 hours, as Remotive asks. |
| Adzuna | `ADZUNA_APP_ID`, `ADZUNA_APP_KEY` | India search. Free keys from https://developer.adzuna.com/. Descriptions are snippets, so scores get medium confidence at most. |
| Gmail alerts | Gmail OAuth (below) | Reads LinkedIn, Naukri, Indeed and other job-alert emails. Never opens LinkedIn or Naukri pages. Alert emails have no description, so these jobs are scored with low confidence. |

### Gmail setup (job alerts)

1. Create job alerts on LinkedIn, Naukri and Indeed.
2. In Gmail, create a filter (e.g. `from:(jobalerts-noreply@linkedin.com OR naukri.com OR indeed.com)`) that applies the label **`job-alerts`**.

Then connect the mailbox in **one** of two ways.

**Option A: App Password over IMAP (recommended).** Nothing expires, and no Google Cloud project is needed.
1. On the alerts Gmail account, turn on **2-Step Verification** (Google Account → Security).
2. Open https://myaccount.google.com/apppasswords, create one named `job-autopilot`, and copy the 16 letters.
3. In `.env`, set `GMAIL_IMAP_USER` (the alerts address) and `GMAIL_IMAP_APP_PASSWORD`. Spaces in the password are fine.

The mailbox is opened read-only, so nothing is marked as read. An App Password can read and send mail on that account, so keep `.env` private. Revoke it from the same page if it ever leaks.

**Option B: Gmail API with OAuth.**
1. In Google Cloud Console: create a project → enable **Gmail API** → **OAuth consent screen**: External, add yourself as a test user → **publish the app ("In production")**. While the app is in "Testing", Google expires its tokens every 7 days. Unverified is fine for personal use; you'll click through a warning once.
2. **Credentials** → Create OAuth client ID → type **Desktop app** → copy the ID and secret into `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
3. Run `npm run gmail:auth` and approve in the browser. The token is saved to `~/.job-autopilot/gmail-token.json`.

When both are configured, IMAP is used. Option B asks only for `gmail.readonly`.

> The LinkedIn and Indeed parsers were tuned on real alert emails (Oct 2026); the Naukri parser has only been tested on a synthetic sample. If an alert format changes, run `npm run ingest:once '--' --source=gmail --dry` and check the output. If fields come out wrong, save an anonymised alert email as a fixture in `apps/worker/test/fixtures/` and adjust `apps/worker/src/gmail/parsers/`.

### Telegram setup (digest)

1. In Telegram, message **@BotFather** → `/newbot` → copy the token into `TELEGRAM_BOT_TOKEN`.
2. Send any message to your new bot, then open `https://api.telegram.org/bot<TOKEN>/getUpdates` and copy `message.chat.id` into `TELEGRAM_CHAT_ID`.
3. Test it:
   ```bash
   npm run telegram:test
   npm run digest:send '--' --print   # preview the digest in the terminal
   ```

## Scripts

> **Windows PowerShell drops a bare `--`**, so `npm run ingest:once -- --dry` silently runs *without* `--dry`. Quote it: `npm run ingest:once '--' --dry` (works in every shell), or use the shortcut scripts below (`ingest:dry`, `refilter`, `seed:clear`, `digest:preview`).

| Command | What it does |
|---|---|
| `npm run dev` | API, worker and dashboard with auto-reload |
| `npm run ingest:once` | One full pipeline run. Flags: `--source=greenhouse,lever`, `--dry`, `--force` (ignore per-source intervals), `--no-score`. |
| `npm run refilter` | Re-apply hard filters after editing `profile.yaml` preferences |
| `npm run rescore '--' --since=2026-10-01` | Re-score jobs fetched since a date (e.g. after a prompt change) |
| `npm run seed` / `npm run seed:clear` | Add or remove sample jobs |
| `npm run profile:check` | Validate `data/*.yaml` and list placeholders still left in them |
| `npm run gmail:auth` | One-time Gmail authorization |
| `npm run telegram:test` / `npm run digest:send` | Telegram test message / send the digest now |
| `npm run outreach '--' --test` | Send a test email to yourself (checks `SMTP_*`) |
| `npm run set-password` | Set the dashboard password (writes the hash into `.env`) |
| `npm test` / `npm run typecheck` / `npm run lint` | Tests (Vitest), TypeScript, ESLint |

The MongoDB tests use separate `job-autopilot-test*` databases and are skipped automatically if MongoDB isn't running.

## How the pipeline decides

1. **Normalize:** city aliases (Bangalore → Bengaluru, Gurgaon → Gurugram, …), company suffixes (Pvt Ltd, Inc, …), title variants (Sr. → senior, SDE → software engineer), experience ranges, and tracking parameters stripped from URLs.
2. **Dedupe:** one job per `company + title + city` (or `remote`). The same job found on another source is added to its "seen on" list. If the new copy has a better description, the stored description is replaced and the job is re-scored.
3. **Hard filters** (from `preferences` in `profile.yaml`): target-role title keywords, excluded keywords and companies, senior titles, experience above `maxExperienceYears`, posting age, location, and remote region. Filtered jobs are kept with the reason and shown on the **Filtered** page, so you can tune the rules.
4. **Score:** the fast model returns a Zod-validated JSON score (0–100), reasons, matched and missing skills, and red flags. Confidence is capped by how much of the posting was available. Unusable model output is retried once and then marked `score_failed`. When the daily cap is reached, scoring stops and the remaining jobs wait for the next run.

## Application kits (Phase 2a)

For a job, the system can produce a **one-page tailored resume PDF** and a **cover letter**:

- **How it's made:** the smart model (`LLM_MODEL_SMART`) picks and orders bullets from `profile.yaml` and may reword them. A checker then compares every reworded bullet and the summary with the profile; if a technology or number appears that the source doesn't contain, the original text is used and the change is listed under the kit's issues. Companies, titles, dates, education and contact details always come straight from the profile.
- **Cover letter:** built from profile facts only. A number found in neither your profile nor the job post triggers one regeneration. A technology that only the job post mentions is flagged for you to check.
- **When it runs:** automatically after each pipeline run for the best recent jobs (Settings → *Auto-generate application kits*: minimum score, daily limit), whenever you **Shortlist** a job, or with **Generate** in the job's detail panel. From the terminal: `npm run tailor '--' --top=3` or `npm run tailor '--' --job=<id>`.
- **Output:** PDFs are saved under `~/.job-autopilot/output/resumes/<jobId>/` and downloaded from the dashboard. Chrome or Edge must be installed to print them; on a server, run `npx playwright install chromium`.
- **Cost:** about $0.03–0.04 per kit with Sonnet.

## Auto-apply on Greenhouse, Lever and Ashby (Phase 3)

For jobs from company boards on these three ATSs, the system fills and submits the application form.

1. **Prepare:** once a job has an application kit, the form is opened in a headless browser and every field is read. Each field is answered from, in order: your profile (name, contact, links, current role, employment dates, years of experience, preferred cities), `qa_bank.yaml` and answers you saved earlier, then the fast model for choices and short written answers. Personal details that aren't in your profile (gender, passport, CTC, …) are never guessed: the application waits in **Applications → Needs you**.
2. **Review:** in **Applications**, fix or fill answers. Short answers you give are remembered and reused for similar questions on later forms.
3. **Submit:** *Approve & submit* (approve mode), or automatically after each pipeline run (auto mode: Settings → channels → `ats`, within its daily limit). The form opens in a visible Chrome window using a separate profile (`~/.job-autopilot/browser-profiles/ats`). If a CAPTCHA appears, solve it in that window; the system waits `ATS_CAPTCHA_WAIT_SECONDS` (default 180) and never tries to solve one itself. It saves a screenshot after filling and after submitting, and sends a Telegram message when an application is submitted or needs you.
4. **DRY_RUN=true** (the default) fills the form and takes a screenshot but does not click submit. Set `DRY_RUN=false` in `.env` and restart when you're ready to apply for real.

From the terminal: `npm run apply '--' --prepare=<jobId>`, `npm run apply '--' --submit=<appId>`, `npm run apply '--' --auto`.

To find more companies that use these ATSs: `npm run discover` (report) or `npm run discover '--' --add` (adds them to `target_companies.yaml`).

Limits: CAPTCHAs (all three ATSs use reCAPTCHA or hCaptcha) can stop an unattended submission; it then shows as *Finish by hand* with a link. Form layouts change over time; if a required field can't be filled, the application stops instead of submitting a partial form.

## Apply from any link

**Applications → Apply from a link** takes the link to a job (or its form) on any careers site: company sites, Workday, SmartRecruiters, Zoho, Keka, Darwinbox, embedded Greenhouse/Lever forms, Google Forms, and so on.

1. A Chrome window opens on your computer (profile `~/.job-autopilot/browser-profiles/links`). The job title, company and description are read from the page, and a tailored resume kit is made for it.
2. **Login:** if the site asks you to log in, create an account or enter a one-time code, the application shows *Log in, in the browser window* and you get a Telegram message. Do it in that window; the form carries on by itself (it waits `ATS_LOGIN_WAIT_SECONDS`, default 10 min). Passwords are never asked for or stored by the system, and the login is remembered in that browser profile for next time.
3. **Pages:** it clicks *Apply* when the link is a description page, opens embedded forms, fills each page from your profile, the Q&A bank, saved answers and the fast model, and clicks *Next* until the last page.
4. **Questions only you can answer** (gender, date of birth, pincode, a photo, …) stop it on that page: answer them in **Applications → Needs you** (files with *Upload*), then *Approve & submit* (or *Start again*).
   **Every answer you give is saved for good** (files under `~/.job-autopilot/uploads`) and filled in automatically when a later form asks the same question; written answers are shown to you for a check before reuse. See and edit them in **Settings → Saved answers**.
   Card-style survey forms (Infosys, Google Forms-like builders) are supported: question titles, choice tiles and chips, calendar date boxes (type the date as 15/08/2002) and "Upload" buttons.
5. **Submit:** by default it stops on the last page for your approval. Tick *Submit by itself once every question is answered* to skip that step. If new pages appear after your approval, it shows them to you before submitting. DRY_RUN=true fills every page but doesn't submit.

Limits: CAPTCHAs are left to you in the window. Unusual widgets (date pickers, drag-and-drop, video questions) or a form that won't move on stop it with a screenshot and *Finish by hand*.

## LinkedIn and Naukri (Phase 4)

Applies on LinkedIn (Easy Apply) and Naukri with **your own logged-in session**, on your computer only (both sites block headless browsers and servers).

1. **Connect:** Settings → Job portals → *Connect*. A Chrome window opens (separate profiles under `~/.job-autopilot/browser-profiles/linkedin|naukri`); log in there yourself, OTP included. Your password is never typed or stored by the system. The login is remembered.
2. **Jobs:** LinkedIn jobs come from your LinkedIn alert emails. Naukri jobs come from a new `naukri` source: Naukri's search pages for your top keywords and cities (plus your recommended jobs when connected), read in a visible window at most twice a day, then filtered and scored like every other job.
3. **Applying:** every 10 minutes between 09:30 and 20:00, the next best job (score ≥ your minimum, posted in the last 21 days, not handled yet) is started on one site, with 6–15 random minutes between applications and at most the daily limit (Settings → *Where it applies*, default auto, 5/day each).
   - LinkedIn Easy Apply: the dialog is filled page by page with the same engine as other forms; questions only you can answer go to *Needs you*.
   - Naukri: the one-click *Apply*, then its screening chat questions are answered from saved answers, your profile and the fast model.
   - "Apply on company site" jobs become a pasted-link application, always shown to you before sending.
4. **Safety:** a visible CAPTCHA, a security checkpoint, "Access Denied" or a logout stops that site and pauses it for 24 hours, with a Telegram message (Settings → Job portals → *Resume*). Approve mode prepares applications and waits for you; DRY_RUN=true fills LinkedIn forms without sending and never clicks Naukri's Apply.

LinkedIn and Naukri don't allow automated applying in their terms: your account could be restricted. Keep the daily limits low.

## Cold email to recruiters (Phase 2b)

The system emails a recruiter about one specific job, from your own Gmail (`SMTP_USER`), with the tailored resume attached.

1. **Who to email:** addresses printed in job posts are picked up after each pipeline run (job boards, no-reply and similar addresses are ignored, and the domain must accept mail). You can also add one yourself: open a job → **Email a recruiter**, or **Outreach → New email** for a role you found elsewhere (it is stored as a job with source `manual`). Hunter.io and similar finders need a company email address, so they are not used.
2. **Draft:** the smart model writes a short email (about 100 words) from profile facts only, checked by the same claim checker as cover letters. A greeting, your signature and a one-line opt-out are added. Issues are shown on the draft.
3. **Review:** in **Outreach → Drafts**, edit the subject and body, choose whether to attach the resume, then **Approve & schedule** (approve mode) or **Skip**. In auto mode (Settings → channels → `cold_email`), clean drafts are scheduled without review.
4. **Sending:** weekdays 09:30–18:30 (`TZ`), 3–8 minutes apart, at most the channel's daily limit (default 5). One follow-up goes in the same thread after `followUpDays` (default 4) if there's no reply. Replies, bounces and "no" are detected from the inbox every 10 minutes; a reply stops the follow-up and sends you a Telegram message, and a bounce or "no" puts the address on the do-not-email list.
5. **DRY_RUN=true** marks due emails as *Dry run* instead of sending them. A test email to yourself is always allowed: `npm run outreach '--' --test`.

From the terminal: `npm run outreach '--' --draft=<jobId> --to=<email> --name=<name>`, `npm run outreach '--' --tick` (check replies, create follow-ups, send what's due).

## Deploying to a VPS

The worker, API and dashboard can all run on a Linux VPS. Keep LinkedIn and Naukri automation (Phase 4) on your own machine only.

```bash
git clone <repo> ~/job-autopilot && cd ~/job-autopilot
npm ci                       # installs tsx too, which the processes run with
cp .env.example .env         # fill in; set NODE_ENV=production and WEB_ORIGIN=https://your-domain
# copy your data/*.yaml files over (they are gitignored)
npm run build                # dashboard -> apps/web/dist
npm i -g pm2
pm2 start deploy/ecosystem.config.cjs && pm2 save && pm2 startup
```

Then configure Nginx from [deploy/nginx.example.conf](deploy/nginx.example.conf) and get HTTPS with certbot. Run Gmail authorization on your local machine (it needs a browser) and copy `~/.job-autopilot/gmail-token.json` to the same path on the VPS.

## Phase 1 verification checklist

- [ ] `npm run profile:check` passes with your real profile and reports no placeholders left
- [ ] `npm test` passes
- [ ] Dashboard login works; Jobs page shows score, reasons, and matched and missing skills
- [ ] Running `npm run ingest:once` twice creates no duplicates (second run shows "duplicates")
- [ ] A job found on two sources appears once, with both sources listed
- [ ] The Filtered page shows rejected jobs with reasons
- [ ] Turning a source off in Settings skips it on the next run
- [ ] A wrong slug in `target_companies.yaml` shows a warning; the other sources still run
- [ ] Turning the kill switch on makes runs exit immediately
- [ ] Gmail alerts are parsed, and re-running doesn't process the same email again
- [ ] The dashboard header shows LLM calls today; the cap stops scoring when reached
- [ ] The Telegram digest arrives
- [ ] `git status` shows no `.env`, `data/*.yaml` or token files
