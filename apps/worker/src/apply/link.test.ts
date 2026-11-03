import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { allSkills, companyFromUrl, detectAts, ProfileSchema } from '@ja/shared';
import type { StructuredCall } from '../llm/client.js';
import { buildVocabulary } from '../tailor/claims.js';
import type { AnswerContext } from './answers.js';
import { answersForPage, titleFromPage } from './link.js';
import type { FormField } from './types.js';
import { looksLikeForm } from './walk.js';

describe('link helpers', () => {
  it('recognises hosted job sites and guesses the company', () => {
    expect(detectAts('https://acme.wd5.myworkdayjobs.com/en-US/careers/job/123')).toBe('workday');
    expect(detectAts('https://jobs.lever.co/acme/abc')).toBe('lever');
    expect(detectAts('https://careers.acme.com/job/1')).toBe('website');
    expect(companyFromUrl('https://acme-labs.wd5.myworkdayjobs.com/en-US/x')).toBe('Acme Labs');
    expect(companyFromUrl('https://jobs.lever.co/zeta/abc')).toBe('Zeta');
    expect(companyFromUrl('https://careers.infosys.co.in/job/1')).toBe('Infosys');
    expect(companyFromUrl('https://www.razorpay.com/jobs/1')).toBe('Razorpay');
    expect(companyFromUrl('https://surveys.infosysapps.com/r/a/x')).toBe('Infosys');
  });

  it('reads the job title from the heading, else the page title', () => {
    expect(titleFromPage({ h1: 'Software Engineer I', title: 'x' })).toBe('Software Engineer I');
    expect(titleFromPage({ h1: 'Careers', title: 'SDE 1 - Backend | Acme Careers' })).toBe('SDE 1');
    expect(titleFromPage({ h1: '', title: 'Jobs' })).toBeUndefined();
    // A heading that is only the brand gives way to the page's own title.
    expect(
      titleFromPage({
        h1: 'IBM',
        title: 'Job Requisition for Executive Referrals only - 132895 - IBM',
        og: 'Job Requisition for Executive Referrals only',
      }),
    ).toBe('Job Requisition for Executive Referrals only');
  });

  it('tells a form from a job description page', () => {
    const f = (kind: FormField['kind'], required = false): FormField => ({
      key: kind + Math.random(),
      label: kind,
      kind,
      required,
      selector: '#x',
    });
    expect(looksLikeForm([f('email')])).toBe(false);
    expect(looksLikeForm([f('text'), f('checkbox'), f('checkbox')])).toBe(false);
    expect(looksLikeForm([f('file')])).toBe(true);
    expect(looksLikeForm([f('text', true), f('email')])).toBe(true);
  });
});

const profile = ProfileSchema.parse({
  personal: {
    name: 'Rahul Kumar Sharma',
    email: 'a@example.com',
    phone: '+91-9999999999',
    location: 'Pune, India',
    links: { github: 'https://github.com/x' },
  },
  totalExperienceYears: 1,
  skills: { frontend: ['React'], backend: ['Node.js'] },
  experience: [
    {
      id: 'e1',
      company: 'Globex',
      title: 'MERN Stack Developer',
      start: '2025-12',
      end: 'present',
      bullets: [],
    },
  ],
  preferences: { roles: ['Developer'], locations: ['Noida'], noticePeriodDays: 30, allowGeneratedApplicationAnswers:true },
});

const resumePdf = path.join(os.tmpdir(), 'ja-link-test-resume.pdf');
const ctx: AnswerContext = {
  profile,
  qaBank: { answers: [] },
  saved: [],
  job: { title: 'Software Engineer', company: 'Acme', location: 'Noida', description: '' },
  files: { resumePdf },
  vocab: buildVocabulary(allSkills(profile)),
};

describe('answersForPage', () => {
  it('discards old generated answers when facts-only filling is enabled', async () => {
    const board:FormField={key:'board',label:'School board',kind:'text',required:true,selector:'#board'};
    const stored=[{...board,value:'Guessed University',source:'llm',needsInput:false,needsReview:false,step:0}];
    const strict={...ctx,profile:ProfileSchema.parse({...profile,preferences:{...profile.preferences,allowGeneratedApplicationAnswers:false}})};
    const out=await answersForPage([board],0,stored,strict,vi.fn(async()=>({answers:[]})) as never);
    expect(out.answers[0]).toMatchObject({value:'',needsInput:true});
  });
  const fields: FormField[] = [
    { key: 'first', label: 'First name', kind: 'text', required: true, selector: '#first' },
    {
      key: 'gender',
      label: 'Gender',
      kind: 'select',
      required: true,
      options: ['Male', 'Female'],
      selector: '#gender',
    },
  ];

  it('refreshes a derived saved answer when it disagrees with the current saved fact', async () => {
    const gender: FormField = {
      key: 'gender',
      label: 'Gender',
      kind: 'buttons',
      required: true,
      selector: '#gender',
      options: ['MALE', 'FEMALE'],
    };
    const stored = [
      {
        ...gender,
        value: 'FEMALE',
        source: 'saved',
        needsInput: false,
        needsReview: false,
        step: 0,
      },
    ];
    const out = await answersForPage(
      [gender],
      0,
      stored,
      { ...ctx, saved: [{ questionKey: 'gender', question: 'Gender', value: 'MALE' }] },
      vi.fn(async () => ({ answers: [] })) as never,
    );
    expect(out.answers[0]).toMatchObject({ value: 'MALE', source: 'saved' });
    expect(out.fresh).toBe(true);
  });

  it('preserves a reviewed lookup answer outside a searchable dropdown rendered window', async () => {
    const office: FormField = {
      key: 'office',
      label: 'Post Office',
      kind: 'combobox',
      required: true,
      selector: '#office',
      options: ['Bandha'],
      searchable: true,
    };
    const stored = [
      {
        ...office,
        value: 'Pachaur',
        source: 'user',
        needsInput: false,
        needsReview: false,
        step: 0,
      },
    ];
    const out = await answersForPage(
      [office],
      0,
      stored,
      ctx,
      vi.fn(async () => ({ answers: [] })) as never,
    );
    expect(out.answers[0]?.value).toBe('Pachaur');
    expect(out.fresh).toBe(false);
  });

  it('does not reuse an answer when a survey reuses the id for a different question', async () => {
    const changed = { ...fields[0]!, label: 'Last name' };
    const stored = [
      {
        key: 'first',
        label: 'First name',
        kind: 'text' as const,
        required: true,
        value: 'Rahul Kumar',
        source: 'user',
        needsInput: false,
        needsReview: false,
        step: 0,
      },
    ];
    const out = await answersForPage(
      [changed],
      0,
      stored,
      ctx,
      vi.fn(async () => ({ answers: [] })) as never,
    );
    expect(out.answers[0]).toMatchObject({ value: 'Sharma', source: 'profile' });
  });

  it('refreshes profile-derived values instead of replaying a previously malformed phone number', async () => {
    const phone: FormField = {
      key: 'phone',
      label: 'Preferred contact number',
      kind: 'number',
      required: true,
      selector: '#phone',
    };
    const stored = [
      {
        ...phone,
        value: '+91 9999999999',
        source: 'profile',
        needsInput: false,
        needsReview: false,
        step: 0,
      },
    ];
    const out = await answersForPage(
      [phone],
      0,
      stored,
      ctx,
      vi.fn(async () => ({ answers: [] })) as never,
    );
    expect(out.answers[0]?.value).toBe('9999999999');
  });

  it('keeps reviewed profile answers stable after option casing is conformed', async () => {
    const choice: FormField = {
      key: 'relocate',
      label: 'Are you willing to relocate to Chennai?',
      kind: 'buttons',
      required: true,
      selector: '#relocate',
      options: ['YES', 'NO'],
    };
    const stored = [
      { ...choice, value: 'NO', source: 'profile', needsInput: false, needsReview: false, step: 0 },
    ];
    const out = await answersForPage(
      [choice],
      0,
      stored,
      ctx,
      vi.fn(async () => ({ answers: [] })) as never,
    );
    expect(out.answers[0]?.value).toBe('NO');
    expect(out.fresh).toBe(false);
  });

  it('works out new answers and flags what only you know', async () => {
    const call = vi.fn(async () => ({ answers: [] })) as unknown as StructuredCall;
    const r = await answersForPage(fields, 1, [], ctx, call);
    expect(r.fresh).toBe(true);
    expect(r.answers.map((a) => [a.key, a.value, a.needsInput, a.step])).toEqual([
      ['first', 'Rahul Kumar', false, 1],
      ['gender', '', true, 1],
    ]);
  });

  it('reuses stored answers for the same page, matching by label when ids changed', async () => {
    const call = vi.fn() as unknown as StructuredCall;
    const stored = [
      {
        ...(await answersForPage(fields, 1, [], ctx, vi.fn(async () => ({ answers: [] })) as never))
          .answers[1]!,
        value: 'Male',
        source: 'user',
        needsInput: false,
      },
      // Same key on another page is not reused.
      {
        key: 'first',
        label: 'First name',
        kind: 'text' as const,
        required: true,
        value: 'Other',
        source: 'user',
        needsInput: false,
        needsReview: false,
        step: 0,
      },
    ];
    const renamed = fields.map((f) => (f.key === 'gender' ? { ...f, key: 'input-9f3' } : f));
    const r = await answersForPage(renamed, 1, stored, ctx, call);
    expect(r.answers.find((a) => a.label === 'Gender')).toMatchObject({
      key: 'input-9f3',
      value: 'Male',
      needsInput: false,
    });
    expect(r.answers.find((a) => a.key === 'first')?.value).toBe('Rahul Kumar');
  });

  it('fills country and city from the profile location, typing cities into search boxes', async () => {
    const call = vi.fn(async () => ({ answers: [] })) as unknown as StructuredCall;
    const r = await answersForPage(
      [
        {
          key: 'country',
          label: 'Country',
          kind: 'combobox',
          required: true,
          options: ['India +91', 'Indonesia +62'],
          selector: '#c',
        },
        {
          key: 'loc',
          label: 'Location (City)',
          kind: 'combobox',
          required: true,
          options: ['No options'],
          selector: '#l',
        },
        { key: 'city', label: 'City', kind: 'text', required: true, selector: '#t' },
      ],
      0,
      [],
      ctx,
      call,
    );
    expect(r.answers.map((a) => [a.value, a.needsInput])).toEqual([
      ['India +91', false],
      ['Pune', false],
      ['Pune', false],
    ]);
  });

  it('still answers from the profile when the LLM is unavailable', async () => {
    const call = vi.fn(async () => {
      throw new Error('Daily LLM call cap reached');
    }) as unknown as StructuredCall;
    const r = await answersForPage(fields, 0, [], ctx, call);
    expect(r.answers.map((a) => a.needsInput)).toEqual([false, true]);
  });
});

// A small careers site: description page → two-page form, plus a login page.
const PAGES: Record<string, string> = {
  '/job': `<html><head><title>Software Engineer | Acme Careers</title></head><body>
    <header><a href="/login">Sign in</a></header>
    <h1>Software Engineer</h1><p>Build Node.js and React apps.</p>
    <footer><label for="nl">Email</label><input id="nl" type="email"><button>Subscribe</button></footer>
    <a href="/apply">Apply now</a></body></html>`,
  '/apply': `<html><body><form id="f" onsubmit="event.preventDefault(); const d = Object.fromEntries(new FormData(this)); delete d.cv; window.parent.__data = d; fetch('/done', {method: 'POST', body: JSON.stringify(d)}); document.body.innerHTML = '<h1>Thank you for applying! Your application has been received.</h1>';">
    <div id="s1">
      <label for="first">First name *</label><input id="first" name="first" required>
      <label for="last">Last name *</label><input id="last" name="last" required>
      <label for="email">Email *</label><input id="email" name="email" type="email" required>
      <label for="cv">Resume *</label><input id="cv" name="cv" type="file" required>
      <div id="err" role="alert"></div>
      <button type="button" onclick="if (!document.getElementById('first').value) { document.getElementById('err').textContent = 'First name is required'; return; } s1.style.display = 'none'; s2.style.display = 'block';">Next</button>
    </div>
    <div id="s2" style="display:none">
      <label for="gender">Gender *</label><select id="gender" name="gender" required><option value="">Select</option><option>Male</option><option>Female</option></select>
      <label for="why">Why do you want to join?</label><textarea id="why" name="why"></textarea>
      <button type="submit">Submit application</button>
    </div></form></body></html>`,
  '/survey': `<html><body>
    <div id="modal"><h1>Privacy Statement</h1><p>We collect your name and email.</p>
      <label><input type="checkbox" id="agree" onchange="document.getElementById('acc').disabled = !this.checked"> I Agree that I have read all the above declaration</label>
      <button id="acc" disabled onclick="document.getElementById('modal').remove(); document.getElementById('form').style.display = 'block'">ACCEPT</button><button>REJECT</button></div>
    <form id="form" style="display:none" onsubmit="event.preventDefault(); document.body.innerHTML = '<h1>Thank you, your application has been submitted</h1>'">
      <label for="se">Email *</label><input id="se" name="se" required>
      <label for="sf">First Name *</label><input id="sf" name="sf" required>
      <label for="sl">Last Name *</label><input id="sl" name="sl" required>
      <button type="submit">Submit</button></form></body></html>`,
  // A survey builder like Infosys's: question cards with the text in a title element, choices as
  // icon tiles and chips, a read-only calendar box, an upload button, and a read-only district.
  '/cards': `<html><body><form id="f" onsubmit="event.preventDefault(); fetch('/done', {method: 'POST', body: JSON.stringify(window.__got())}); document.body.innerHTML = '<h1>Thank you, your application has been submitted</h1>';">
    <div class="question-card"><div class="title-container"><div class="display-number">1.</div><div class="display-text">GENDER</div></div>
      <div class="input-container" onclick="window.__g = 'MALE'"><span><i class="material-icons">radio_button_unchecked</i></span><span> MALE </span></div>
      <div class="input-container" onclick="window.__g = 'FEMALE'"><span><i class="material-icons">radio_button_unchecked</i></span><span> FEMALE </span></div></div>
    <div class="question-card"><div class="title-container"><div class="display-number">2.</div><div class="display-text">First name</div><div>As it appears on passport</div></div>
      <div class="field"><div><div><label for="q2"></label><input id="q2" required></div></div></div></div>
    <div class="question-card"><div class="title-container"><div class="display-text">Date of Birth</div></div>
      <div><label for="dob">Date</label><input id="dob" readonly aria-haspopup="dialog" required oninput="this.className = /^\\d\\d\\/\\d\\d\\/\\d{4}$/.test(this.value) ? '' : 'ng-invalid'"></div></div>
    <div class="question-card"><div class="title-container"><div class="display-text">Do you have a passport?</div></div>
      <div role="listbox"><div role="option" onclick="window.__p = 'YES'"><i class="material-icons">check_circle</i><span>YES</span></div><div role="option" onclick="window.__p = 'NO'"><i class="material-icons">cancel</i><span>NO</span></div></div></div>
    <div class="question-card"><div class="title-container"><div class="display-text">Upload recent passport size photo</div></div>
      <button type="button" onclick="const i = document.createElement('input'); i.type = 'file'; i.onchange = () => (window.__photo = i.files[0].name); i.click();">Upload Image</button></div>
    <div class="question-card"><div class="title-container"><div class="display-text">Pincode</div></div>
      <input id="pin" type="number" required><label for="dist">District</label><input id="dist" readonly></div>
    <script>window.__got = () => ({ g: window.__g, first: q2.value, dob: dob.value, p: window.__p, photo: window.__photo, pin: pin.value });</script>
    <button type="submit">Submit</button></form></body></html>`,
  // Two-step login (IBMid): one box and "Continue"; the password comes on the next page.
  '/authsvc/sps/login': `<html><head><title>IBMid - Sign in or create an IBMid</title></head><body>
    <h2>Log in to IBM</h2><label for="username">IBMid</label><input id="username" name="username">
    <button>Continue</button><label><input type="checkbox" id="remember"> Remember me</label></body></html>`,
  '/login': `<html><body><h1>Sign in</h1><label for="u">Email</label><input id="u" type="email">
    <label for="p">Password</label><input id="p" type="password"><button>Sign in</button></body></html>`,
};

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
describe.skipIf(!fs.existsSync(CHROME))('walkForm in a real browser', () => {
  it('opens the form from the description, stops for your answer, then submits', async () => {
    fs.writeFileSync(resumePdf, '%PDF-1.4 test');
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
    const { walkForm } = await import('./walk.js');
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    const call = vi.fn(async () => ({
      answers: [{ key: 'why', value: 'I enjoy building web apps.', needsUser: false, note: '' }],
    })) as unknown as StructuredCall;

    let stored: Awaited<ReturnType<typeof answersForPage>>['answers'] = [];
    const run = async (url: string, submit: boolean) => {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(url);
      const r = await walkForm(context, page, {
        answersFor: async (fields, step) => {
          const out = await answersForPage(fields, step, stored, ctx, call);
          stored = [...stored.filter((a) => (a.step ?? 0) !== step), ...out.answers];
          return out.answers;
        },
        shouldSubmit: () => submit,
        dryRun: false,
        headless: true,
        loginWaitMs: 0,
        captchaWaitMs: 0,
      });
      await context.close();
      return r;
    };

    try {
      const first = await run(`${base}/job`, false);
      expect(first).toMatchObject({ outcome: 'needs_input', step: 1 });
      expect(stored.filter((a) => a.needsInput).map((a) => a.label)).toEqual(['Gender']);

      // You answer in the dashboard; the next run carries on and submits.
      stored = stored.map((a) =>
        a.label === 'Gender' ? { ...a, value: 'Male', source: 'user', needsInput: false } : a,
      );
      const second = await run(`${base}/job`, true);
      expect(second).toMatchObject({ outcome: 'submitted', step: 1 });
      expect(posted).toEqual([
        {
          first: 'Rahul Kumar',
          last: 'Sharma',
          email: 'a@example.com',
          gender: 'Male',
          why: 'I enjoy building web apps.',
        },
      ]);

      // A privacy declaration in front of the form is accepted, then the form is filled.
      stored = [];
      const survey = await run(`${base}/survey`, false);
      expect(survey).toMatchObject({ outcome: 'ready', step: 0 });
      expect(stored.map((a) => a.value)).toEqual(['a@example.com', 'Rahul Kumar', 'Sharma']);

      // Functions built by tsx carry a __name() helper; the page gets a no-op one.
      const ctx2 = await browser.newContext();
      const p2 = await ctx2.newPage();
      await walkForm(ctx2, p2, {
        answersFor: async () => [],
        shouldSubmit: () => false,
        dryRun: true,
        headless: true,
        loginWaitMs: 0,
        captchaWaitMs: 0,
        maxSteps: 1,
      });
      expect(await p2.evaluate('typeof __name')).toBe('function');
      await ctx2.close();

      // Card-style survey: every question is read with its real text, then filled and sent.
      stored = [];
      posted.length = 0;
      const cards1 = await run(`${base}/cards`, false);
      expect(cards1.outcome).toBe('needs_input');
      expect(stored.map((a) => [a.label, a.kind, a.needsInput])).toEqual([
        ['GENDER', 'buttons', true],
        ['First name', 'text', false],
        ['Date of Birth', 'date', true],
        ['Do you have a passport?', 'buttons', true],
        ['Upload recent passport size photo', 'file', true],
        ['Pincode', 'number', true],
      ]);
      expect(stored.find((a) => a.label === 'GENDER')?.options).toEqual(['MALE', 'FEMALE']);
      expect(stored.find((a) => a.label.startsWith('Do you'))?.options).toEqual(['YES', 'NO']);
      const mine: Record<string, string> = {
        GENDER: 'MALE',
        'Date of Birth': '2002-08-15',
        'Do you have a passport?': 'NO',
        'Upload recent passport size photo': resumePdf,
        Pincode: '201301',
      };
      stored = stored.map((a) =>
        a.label in mine ? { ...a, value: mine[a.label]!, source: 'user', needsInput: false } : a,
      );
      const cards2 = await run(`${base}/cards`, true);
      expect(cards2).toMatchObject({ outcome: 'submitted' });
      expect(posted).toEqual([
        {
          g: 'MALE',
          first: 'Rahul Kumar',
          dob: '15/08/2002',
          p: 'NO',
          photo: path.basename(resumePdf),
          pin: '201301',
        },
      ]);

      const login = await run(`${base}/login`, false);
      expect(login.outcome).toBe('needs_login');
      expect((await run(`${base}/authsvc/sps/login`, false)).outcome).toBe('needs_login');
    } finally {
      await browser.close();
      server.close();
    }
  }, 120_000);
});
