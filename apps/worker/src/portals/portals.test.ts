import fs from 'node:fs';
import http from 'node:http';
import mongoose from 'mongoose';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApplicationModel,
  connectDb,
  JobModel,
  PortalModel,
  SettingsModel,
  TaskModel,
} from '@ja/shared';
import type { Answer, FormField } from '../apply/types.js';
import { parseNaukriAge, parseNaukriSalary } from '../sources/naukri.js';
import { linkedinFlow, naukriFlow } from './apply.js';
import { inPortalHours, portalTick, portalUrl } from './tick.js';

const ist = (s: string) => new Date(`${s}+05:30`);

describe('naukri parsing', () => {
  it('reads salary ranges in lakhs and posting age', () => {
    expect(parseNaukriSalary('3-6 Lacs PA')).toEqual({
      min: 300_000,
      max: 600_000,
      currency: 'INR',
      period: 'year',
    });
    expect(parseNaukriSalary('Not disclosed')).toBeUndefined();
    const now = ist('2026-10-09T10:00:00');
    expect(parseNaukriAge('2 weeks ago', now)?.toISOString()).toBe(
      ist('2026-09-25T10:00:00').toISOString(),
    );
    expect(parseNaukriAge('30+ Days Ago', now)?.toISOString()).toBe(
      ist('2026-09-09T10:00:00').toISOString(),
    );
    expect(parseNaukriAge('Just now', now)).toBe(now);
  });
});

describe('portal timing and links', () => {
  it('applies only during the day', () => {
    expect(inPortalHours(ist('2026-10-09T09:29:00'), 'Asia/Kolkata')).toBe(false);
    expect(inPortalHours(ist('2026-10-09T09:30:00'), 'Asia/Kolkata')).toBe(true);
    expect(inPortalHours(ist('2026-10-09T19:59:00'), 'Asia/Kolkata')).toBe(true);
    expect(inPortalHours(ist('2026-10-09T20:00:00'), 'Asia/Kolkata')).toBe(false);
  });

  it('finds the job on the right site, even when first seen elsewhere', () => {
    const job = {
      source: 'gmail',
      url: 'https://in.indeed.com/viewjob?jk=1',
      seenOn: [{ source: 'gmail', url: 'https://www.linkedin.com/jobs/view/123?refId=x' }],
    };
    expect(portalUrl('linkedin', job)).toBe('https://www.linkedin.com/jobs/view/123');
    expect(portalUrl('naukri', job)).toBeUndefined();
  });
});

const dbUp = await connectDb(
  process.env.MONGODB_URI_TEST_PORTALS ?? 'mongodb://127.0.0.1:27017/job-autopilot-test-portals',
)
  .then(() => true)
  .catch(() => false);

describe.skipIf(!dbUp)('portalTick (MongoDB)', () => {
  const noon = ist('2026-10-09T12:00:00');
  beforeEach(async () => {
    await Promise.all([
      JobModel.deleteMany({}),
      ApplicationModel.deleteMany({}),
      TaskModel.deleteMany({}),
      PortalModel.deleteMany({}),
      SettingsModel.deleteMany({}),
    ]);
    const base = {
      source: 'gmail',
      companyNorm: 'x',
      titleNorm: 'x',
      location: 'Noida',
      status: 'scored',
      postedAt: ist('2026-10-05T10:00:00'),
    };
    await JobModel.create([
      {
        ...base,
        sourceJobId: 'a',
        url: 'https://www.linkedin.com/jobs/view/1',
        canonicalUrl: 'a',
        company: 'A',
        title: 'SDE',
        dedupeHash: 'a',
        score: 82,
      },
      {
        ...base,
        sourceJobId: 'b',
        url: 'https://www.linkedin.com/jobs/view/2',
        canonicalUrl: 'b',
        company: 'B',
        title: 'SDE',
        dedupeHash: 'b',
        score: 91,
      },
      {
        ...base,
        sourceJobId: 'c',
        url: 'https://www.linkedin.com/jobs/view/3',
        canonicalUrl: 'c',
        company: 'C',
        title: 'SDE',
        dedupeHash: 'c',
        score: 50,
      },
    ]);
  });
  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  it('does nothing until the site is connected', async () => {
    expect(await portalTick(noon)).toEqual([]);
  });

  it('queues the best job, then waits a random gap before the next one', async () => {
    await PortalModel.create({ name: 'linkedin', connected: true });
    const first = await portalTick(noon, () => 0);
    expect(first).toHaveLength(1);
    const app = await ApplicationModel.findOne({ channel: 'linkedin' }).lean();
    const job = await JobModel.findById(app!.jobId).lean();
    expect(job!.company).toBe('B');
    expect(app).toMatchObject({
      mode: 'auto',
      status: 'preparing',
      applyUrl: 'https://www.linkedin.com/jobs/view/2',
    });
    expect(await TaskModel.findOne({ type: 'portal_apply' }).lean()).toMatchObject({
      payload: { appId: String(app!._id), submit: true },
    });
    // The first application is still running.
    expect(await portalTick(new Date(noon.getTime() + 60 * 60_000))).toEqual([]);
    await TaskModel.updateMany({}, { $set: { status: 'done' } });
    // Gap of 6 minutes (random = 0) not over yet.
    expect(await portalTick(new Date(noon.getTime() + 5 * 60_000))).toEqual([]);
    const second = await portalTick(new Date(noon.getTime() + 7 * 60_000));
    expect(second).toHaveLength(1);
    // The 50-score job is below the minimum; nothing left.
    await TaskModel.updateMany({}, { $set: { status: 'done' } });
    expect(await portalTick(new Date(noon.getTime() + 60 * 60_000))).toEqual([]);
  });

  it('respects pauses, night hours, the daily limit and the kill switch', async () => {
    await PortalModel.create({
      name: 'linkedin',
      connected: true,
      pausedUntil: ist('2026-10-10T12:00:00'),
    });
    expect(await portalTick(noon)).toEqual([]);
    await PortalModel.updateOne({ name: 'linkedin' }, { $unset: { pausedUntil: 1 } });
    expect(await portalTick(ist('2026-10-09T22:00:00'))).toEqual([]);
    await SettingsModel.updateMany(
      {},
      { $set: { 'channels.linkedin': { mode: 'auto', dailyLimit: 0 } } },
    );
    expect(await portalTick(noon)).toEqual([]);
    await SettingsModel.updateOne(
      {},
      { $set: { killSwitch: true, 'channels.linkedin.dailyLimit': 5 } },
    );
    expect(await portalTick(noon)).toEqual([]);
  });
});

// Look-alike pages for the two sites' apply flows, in a real browser.
const PAGES: Record<string, string> = {
  '/jobs/view/1': `<html><body><main><h1>Software Engineer</h1><p>Node.js and React.</p>
    <button class="jobs-apply-button" onclick="document.getElementById('dlg').style.display = 'block'">Easy Apply</button></main>
    <input id="global-search" placeholder="Search" required>
    <div id="dlg" class="jobs-easy-apply-modal" role="dialog" style="display:none">
      <button aria-label="Dismiss" onclick="window.__dismissed = true">x</button>
      <div id="s1"><label for="ph">Mobile phone number</label><input id="ph" name="ph" required>
        <button onclick="s1.style.display = 'none'; s2.style.display = 'block'">Next</button></div>
      <div id="s2" style="display:none">
        <label for="yrs">How many years of work experience do you have with Node.js?</label><input id="yrs" name="yrs" required>
        <button onclick="s2.style.display = 'none'; s3.style.display = 'block'">Review</button></div>
      <div id="s3" style="display:none"><p>Review your application</p>
        <button onclick="fetch('/done', {method: 'POST', body: JSON.stringify({ph: ph.value, yrs: yrs.value})}); s3.innerHTML = '<h2>Your application was sent to Acme</h2>'">Submit application</button></div>
    </div></body></html>`,
  '/job-listings-sde-1': `<html><body><h1>SDE 1</h1>
    <button id="apply-button" onclick="document.getElementById('bot').style.display = 'block'">Apply</button>
    <div id="bot" class="chatbot_DrawerContentWrapper" style="display:none">
      <ul id="msgs"><li class="botItem"><div class="botMsg">Are you willing to relocate to Bengaluru?</div></li></ul>
      <div id="opts"><input type="radio" id="r1" name="q"><label for="r1">Yes</label><input type="radio" id="r2" name="q"><label for="r2">No</label></div>
      <div id="box" contenteditable="true" style="display:none; min-height: 20px"></div>
      <div class="sendMsg" onclick="window.__step = (window.__step || 0) + 1; window.__step === 1 ? (window.__a1 = r1.checked ? 'Yes' : r2.checked ? 'No' : '', msgs.innerHTML += '<li class=botItem><div class=botMsg>What is your notice period in days?</div></li>', opts.style.display = 'none', box.style.display = 'block') : (fetch('/done', {method: 'POST', body: JSON.stringify({relocate: window.__a1, notice: box.innerText})}), document.body.innerHTML = '<p>You have successfully applied to SDE 1</p>')">Save</div>
    </div></body></html>`,
};

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
describe.skipIf(!fs.existsSync(CHROME))('apply flows in a real browser', () => {
  it('fills LinkedIn Easy Apply inside its dialog and Naukri screening questions', async () => {
    const posted: unknown[] = [];
    const server = http.createServer((req, res) => {
      if (req.method === 'POST') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          posted.push(JSON.parse(body));
          res.end('ok');
        });
        return;
      }
      res.setHeader('content-type', 'text/html');
      res.end(PAGES[req.url ?? ''] ?? '<h1>Not found</h1>');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const { chromium } = await import('playwright-core');
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    const answer = (f: FormField, value: string): Answer => ({
      key: f.key,
      label: f.label,
      kind: f.kind,
      required: f.required,
      options: f.options,
      value,
      source: 'test',
      needsInput: false,
      needsReview: false,
    });
    try {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await page.goto(`${base}/jobs/view/1`);
      const seen: string[] = [];
      const li = await linkedinFlow(ctx, page, {
        answersFor: async (fields) => {
          seen.push(...fields.map((f) => f.label));
          return fields.map((f) => answer(f, /phone/i.test(f.label) ? '9999999999' : '1'));
        },
        shouldSubmit: () => true,
        dryRun: false,
        headless: true,
        loginWaitMs: 0,
        captchaWaitMs: 0,
      });
      expect(li).toMatchObject({ outcome: 'submitted' });
      // The page's own search box (outside the dialog) is never touched.
      expect(seen).toEqual([
        'Mobile phone number',
        'How many years of work experience do you have with Node.js?',
      ]);
      expect(posted).toEqual([{ ph: '9999999999', yrs: '1' }]);

      posted.length = 0;
      const page2 = await ctx.newPage();
      await page2.goto(`${base}/job-listings-sde-1`);
      const asked: string[] = [];
      const nk = await naukriFlow(ctx, page2, {
        submit: true,
        dryRun: false,
        shoot: async () => undefined,
        answer: async (f) => {
          asked.push(`${f.label} [${f.kind}${f.options ? `: ${f.options.join('/')}` : ''}]`);
          return answer(f, f.options ? 'Yes' : '30');
        },
      });
      expect(nk).toMatchObject({ outcome: 'submitted' });
      expect(asked).toEqual([
        'Are you willing to relocate to Bengaluru? [radio: Yes/No]',
        'What is your notice period in days? [text]',
      ]);
      expect(posted).toEqual([{ relocate: 'Yes', notice: '30' }]);

      // Preparing (or DRY_RUN) never clicks Naukri's one-click Apply.
      const page3 = await ctx.newPage();
      await page3.goto(`${base}/job-listings-sde-1`);
      const dry = await naukriFlow(ctx, page3, {
        submit: true,
        dryRun: true,
        shoot: async () => undefined,
        answer: vi.fn(),
      });
      expect(dry.outcome).toBe('dry_run');
      expect(await page3.locator('#bot').isVisible()).toBe(false);
    } finally {
      await browser.close();
      server.close();
    }
  }, 180_000);
});
