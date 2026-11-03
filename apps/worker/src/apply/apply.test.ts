import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { allSkills, ProfileSchema, questionKey } from '@ja/shared';
import type { StructuredCall } from '../llm/client.js';
import { buildVocabulary } from '../tailor/claims.js';
import {
  answerFields,
  knownAnswer,
  pickOption,
  ruleAnswer,
  type AnswerContext,
} from './answers.js';
import { applyTargetFor } from './extract.js';
import { parseDate } from './fill.js';
import type { FormField } from './types.js';

const profile = ProfileSchema.parse({
  personal: {
    name: 'Rahul Kumar Sharma',
    email: 'a@example.com',
    phone: '+91-9999999999',
    location: 'Pune, India',
    links: { linkedin: 'https://linkedin.com/in/x', github: 'https://github.com/x' },
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
    {
      id: 'e2',
      company: 'Sparx',
      title: 'Web Developer Intern',
      start: '2025-08',
      end: '2025-10',
      bullets: [],
    },
  ],
  preferences: {
    allowGeneratedApplicationAnswers: true,
    roles: ['Developer'],
    locations: ['Noida', 'Bengaluru'],
    graduationYear: 2025,
    noticePeriodDays: 30,
  },
});

const ctx = (over: Partial<AnswerContext> = {}): AnswerContext => ({
  profile,
  qaBank: {
    answers: [
      {
        key: 'expected_ctc',
        question: 'What is your expected CTC?',
        answer: '6 LPA',
        aliases: ['expected salary'],
      },
      { key: 'current_ctc', question: 'What is your current CTC?', answer: '<X LPA>', aliases: [] },
    ],
  },
  saved: [],
  job: { title: 'Developer', company: 'Acme', location: 'Pune', description: '' },
  files: { resumePdf: 'C:/r.pdf', coverLetterText: 'Dear Hiring Manager, …' },
  vocab: buildVocabulary(allSkills(profile)),
  ...over,
});

const field = (over: Partial<FormField>): FormField => ({
  key: 'k',
  label: 'L',
  kind: 'text',
  required: true,
  selector: '#k',
  ...over,
});

const rule = (f: Partial<FormField>) => ruleAnswer(field(f), ctx());

describe('ruleAnswer', () => {
  it('splits names and fills contact details', () => {
    expect(rule({ key: 'first_name', label: 'First Name' })?.value).toBe('Rahul Kumar');
    expect(rule({ key: 'last_name', label: 'Last Name' })?.value).toBe('Sharma');
    expect(rule({ label: 'Full name', key: 'name' })?.value).toBe('Rahul Kumar Sharma');
    expect(rule({ label: 'Phone', kind: 'tel' })?.value).toBe('+91 9999999999');
    expect(rule({ label: 'GitHub URL' })?.value).toBe('https://github.com/x');
    expect(rule({ label: 'Portfolio URL' })).toBeUndefined(); // not in profile
  });

  it('handles country phone codes without putting the phone number into the code dropdown', () => {
    expect(
      rule({
        label: 'Country Phone Code',
        kind: 'select',
        options: ['United States (+1)', 'India (+91)'],
      })?.value,
    ).toBe('India (+91)');
    expect(
      rule({
        label: 'Country Code',
        kind: 'combobox',
        options: ['India (91)', 'United States (1)'],
      })?.value,
    ).toBe('India (91)');
    expect(
      rule({ label: 'Country or Region', kind: 'select', options: ['India', 'United States'] })
        ?.value,
    ).toBe('India');
    expect(
      rule({ label: 'Alternate contact number (optional)', kind: 'number', required: false }),
    ).toBeUndefined();
    expect(
      rule({ label: 'Phone Device Type', kind: 'select', options: ['Mobile', 'Landline'] }),
    ).toBeUndefined();
  });

  it('fills the Greenhouse employment section, without an end date for the current role', () => {
    expect(rule({ key: 'company-name-0' })?.value).toBe('Globex');
    expect(rule({ key: 'start-date-month-0', kind: 'combobox' })?.value).toBe('December');
    expect(rule({ key: 'end-date-year-0' })).toMatchObject({ value: '', notRequired: true });
    expect(rule({ key: 'current-role-0_1', kind: 'checkbox' })?.value).toBe(true);
    expect(rule({ key: 'end-date-month-1', kind: 'combobox' })?.value).toBe('October');
  });

  it('answers office/relocation questions from preferred locations', () => {
    const opts = { kind: 'combobox' as const, options: ['Yes', 'No'] };
    expect(
      rule({ label: 'Are you willing to work from office in Bengaluru?', ...opts })?.value,
    ).toBe('Yes');
    expect(rule({ label: 'Are you willing to relocate to Chennai?', ...opts })?.value).toBe('No');
  });

  it('declines voluntary questions only when a decline option exists', () => {
    expect(
      rule({
        label: 'Gender',
        kind: 'select',
        options: ['Male', 'Female', 'Decline to self-identify'],
      })?.value,
    ).toBe('Decline to self-identify');
    expect(
      rule({ label: 'Gender', kind: 'select', options: ['Male', 'Female', 'Others'] }),
    ).toBeUndefined();
  });

  it('handles age, source, notice period and placeholder-only Q&A answers', () => {
    expect(
      rule({ label: 'Are you over the age of 18?', kind: 'buttons', options: ['Yes', 'No'] })
        ?.value,
    ).toBe('Yes');
    expect(rule({ label: 'Where did you hear about this vacancy?' })?.value).toBe(
      'Company careers page',
    );
    expect(rule({ label: 'What is your notice period?' })?.value).toBe('30 days');
    expect(rule({ label: 'Current CTC' })).toBeUndefined(); // "<X LPA>" placeholder is ignored
  });

  it('attaches the tailored resume to resume uploads', () => {
    expect(rule({ label: 'Resume/CV', kind: 'file' })).toEqual({
      value: 'C:/r.pdf',
      source: 'file',
    });
  });
});

describe('parseDate', () => {
  it('reads the ways people type dates, day first', () => {
    const d = { y: 2002, m: 8, d: 15 };
    for (const s of [
      '15/08/2002',
      '15-8-2002',
      '2002-08-15',
      '15 Aug 2002',
      '15th August 2002',
      'August 15, 2002',
    ])
      expect(parseDate(s)).toEqual(d);
    expect(parseDate('sometime in 2002')).toBeNull();
  });
});

describe('saved answers', () => {
  const saved = (question: string, value: unknown, kind?: string) => ({
    questionKey: questionKey(question),
    question,
    value,
    kind,
  });

  it('reuses your answers on later forms, files only while they exist', () => {
    const photo = `${process.cwd()}/package.json`;
    const c = ctx({
      saved: [
        saved('Date of Birth', '15/08/2002', 'date'),
        saved('Upload recent passport photo', photo, 'file'),
        saved('Upload your marksheet', 'C:/gone/marks.pdf', 'file'),
        saved('Why do you want to join?', 'I like Acme.', 'textarea'),
      ],
    });
    expect(knownAnswer(field({ label: 'Date of birth', kind: 'date' }), c)).toMatchObject({
      value: '15/08/2002',
      source: 'saved',
    });
    expect(
      knownAnswer(field({ label: 'Upload recent passport photo', kind: 'file' }), c),
    ).toMatchObject({ value: photo });
    expect(knownAnswer(field({ label: 'Upload your marksheet', kind: 'file' }), c)).toBeUndefined();
    // A file answer never goes into a text box.
    expect(
      knownAnswer(field({ label: 'Upload recent passport photo', kind: 'text' }), c),
    ).toBeUndefined();
    expect(
      knownAnswer(field({ label: 'Why do you want to join?', kind: 'textarea' }), c),
    ).toMatchObject({ value: 'I like Acme.', needsReview: true });
    // A field without a readable label matches nothing.
    expect(knownAnswer(field({ label: '' }), ctx({ saved: [saved('', 'x')] }))).toBeUndefined();
  });

  it('types phone numbers into number boxes as 10 digits', () => {
    expect(rule({ label: 'Preferred contact number', kind: 'number' })?.value).toBe('9999999999');
  });
});

describe('pickOption', () => {
  it('does not match a gender or country inside a different option word', () => {
    expect(pickOption(['FEMALE', "I don't want to disclose"], 'MALE')).toBeUndefined();
    expect(pickOption(['MALE', "I don't want to disclose"], 'FEMALE')).toBeUndefined();
    expect(pickOption(['Indonesia'], 'India')).toBeUndefined();
    expect(pickOption(['Other'], 'Mother')).toBeUndefined();
  });
  it('matches exactly, then by prefix, then by substring', () => {
    expect(pickOption(['United States +1', 'India +91'], 'India')).toBe('India +91');
    expect(pickOption(['Yes', 'No'], 'no')).toBe('No');
    expect(pickOption(['A', 'B'], 'C')).toBeUndefined();
  });
});

describe('answerFields', () => {
  it('asks for unknown facts instead of accepting generated answers in facts-only mode', async () => {
    const strict=ctx({profile:ProfileSchema.parse({...profile,preferences:{...profile.preferences,allowGeneratedApplicationAnswers:false}})});
    const call=vi.fn(async()=>({answers:[{key:'board',value:'Some University',needsUser:false,note:'guessed'},{key:'date',value:'January 2025',needsUser:false,note:'guessed'}]}));
    const out=await answerFields([field({key:'board',label:'School board'}),field({key:'date',label:'Passing month and year'})],strict,call as never);
    expect(out.map(a=>[a.value,a.needsInput])).toEqual([['',true],['',true]]);
    expect(call).not.toHaveBeenCalled();
  });
  it('preserves the full saved degree when a searchable sample contains a shorter degree', async () => {
    const degree = field({
      key: 'degree',
      label: 'Degree',
      kind: 'combobox',
      searchable: true,
      options: ['Bachelor of Technology'],
    });
    const out = await answerFields(
      [degree],
      ctx({
        saved: [
          { questionKey: 'degree', question: 'Degree', value: 'Bachelor of Technology (Honours)' },
        ],
      }),
      vi.fn(async () => ({ answers: [] })) as never,
    );
    expect(out[0]?.value).toBe('Bachelor of Technology (Honours)');
  });
  const fields: FormField[] = [
    field({ key: 'email', label: 'Email', kind: 'email' }),
    field({ key: 'q1', label: 'Gender', kind: 'select', options: ['Male', 'Female', 'Others'] }),
    field({
      key: 'q2',
      label: 'Current Designation',
      kind: 'select',
      options: ['Experienced Professional', 'Fresher'],
    }),
    field({ key: 'q3', label: 'Why do you want to join?', kind: 'textarea' }),
    field({ key: 'q4', label: 'Expected salary', kind: 'text' }),
    field({ key: 'q5', label: 'Industry', kind: 'select', options: ['Software', 'Retail'] }),
  ];

  it('uses rules and the Q&A bank first, the LLM for the rest, and flags what only you can answer', async () => {
    const call = vi.fn(async () => ({
      answers: [
        { key: 'q1', value: '', needsUser: true, note: 'personal' },
        { key: 'q2', value: 'Experienced Professional', needsUser: false, note: '' },
        { key: 'q3', value: 'I build React apps at Globex.', needsUser: false, note: '' },
        { key: 'q5', value: 'Banking', needsUser: false, note: 'not an option' },
      ],
    })) as unknown as StructuredCall;
    const out = await answerFields(fields, ctx(), call);
    const by = Object.fromEntries(out.map((a) => [a.key, a]));
    expect(by.email).toMatchObject({
      value: 'a@example.com',
      source: 'profile',
      needsInput: false,
    });
    expect(by.q4).toMatchObject({ value: '6 LPA', source: 'qa_bank' });
    expect(by.q1).toMatchObject({ value: '', needsInput: true });
    expect(by.q2).toMatchObject({
      value: 'Experienced Professional',
      source: 'llm',
      needsReview: false,
    });
    expect(by.q3).toMatchObject({ source: 'llm', needsReview: true });
    expect(by.q5).toMatchObject({ value: '', needsInput: true }); // invented option rejected
  });

  it('reuses answers you saved for the same question', async () => {
    const call = vi.fn(async () => ({ answers: [] })) as unknown as StructuredCall;
    const out = await answerFields(
      [fields[1]!],
      ctx({ saved: [{ questionKey: 'gender', question: 'Gender', value: 'Female' }] }),
      call,
    );
    expect(out[0]).toMatchObject({ value: 'Female', source: 'saved', needsInput: false });
    expect(call).not.toHaveBeenCalled();
  });
});

describe('applyTargetFor', () => {
  it('finds the form URL from the ATS source entry', () => {
    expect(
      applyTargetFor({
        source: 'lever',
        sourceJobId: 'acme:1',
        url: 'https://jobs.lever.co/acme/1',
      }),
    ).toEqual({
      ats: 'lever',
      applyUrl: 'https://jobs.lever.co/acme/1/apply',
    });
    expect(
      applyTargetFor({
        source: 'gmail',
        sourceJobId: 'linkedin:1',
        url: 'https://linkedin.com/jobs/view/1',
        seenOn: [
          {
            source: 'greenhouse',
            sourceJobId: 'acme:42',
            url: 'https://job-boards.greenhouse.io/acme/jobs/42',
          },
        ],
      }),
    ).toMatchObject({ ats: 'greenhouse', greenhouse: { slug: 'acme', jobId: '42' } });
    expect(applyTargetFor({ source: 'adzuna', sourceJobId: '1', url: 'https://x' })).toBeNull();
  });
});

// Browser round-trip on a local form: needs Chrome installed, so it's skipped elsewhere.
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
describe.skipIf(!fs.existsSync(CHROME))('form fill in a real browser', () => {
  it('reads, fills and submits a form, recognising the confirmation', async () => {
    const { chromium } = await import('playwright-core');
    const { readFormFields } = await import('./extract.js');
    const { fillForm, submitForm } = await import('./fill.js');
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await browser.newPage();
    await page.setContent(`
      <form onsubmit="event.preventDefault(); window.__data = Object.fromEntries(new FormData(this)); document.body.innerHTML = '<h1>Thank you for applying! Your application has been received.</h1>';">
        <label for="fn">First name *</label><input id="fn" name="fn" required>
        <label for="em">Email</label><input id="em" type="email" name="em">
        <label for="ex">Experience</label><select id="ex" name="ex"><option>Select…</option><option>0-1</option><option>1-3</option></select>
        <fieldset><legend>Willing to relocate?</legend>
          <label><input type="radio" name="rel" value="y"> Yes</label><label><input type="radio" name="rel" value="n"> No</label></fieldset>
        <label><input type="checkbox" id="ok" name="ok"> I agree to the privacy policy</label>
        <button type="submit">Submit application</button>
      </form>`);
    const fields = await readFormFields(page, { ats: 'lever', applyUrl: 'about:blank' });
    expect(fields.map((f) => [f.label, f.kind])).toEqual([
      ['First name', 'text'],
      ['Email', 'email'],
      ['Experience', 'select'],
      ['Willing to relocate?', 'radio'],
      ['I agree to the privacy policy', 'checkbox'],
    ]);
    const answers = fields.map((f) => ({
      key: f.key,
      label: f.label,
      kind: f.kind,
      required: f.required,
      options: f.options,
      source: 'test',
      needsInput: false,
      needsReview: false,
      value: (
        {
          text: 'Rahul',
          email: 'a@example.com',
          select: '1-3',
          radio: 'Yes',
          checkbox: true,
        } as Record<string, string | boolean>
      )[f.kind]!,
    }));
    expect(await fillForm(page, fields, answers)).toEqual([]);
    const result = await submitForm(page, { headless: true, captchaWaitMs: 0 });
    expect(result.outcome).toBe('submitted');
    expect(await page.evaluate('window.__data')).toEqual({
      fn: 'Rahul',
      em: 'a@example.com',
      ex: '1-3',
      rel: 'y',
      ok: 'on',
    });
    await browser.close();
  }, 60_000);
});
