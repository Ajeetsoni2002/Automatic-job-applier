import { describe, expect, it, vi } from 'vitest';
import { allSkills, ProfileSchema } from '@ja/shared';
import { LlmOutputError, type StructuredCall } from '../llm/client.js';
import { buildVocabulary } from '../tailor/claims.js';
import { composeBody, draftColdEmail, followUpEmail } from './draft.js';
import { extractEmails, isValidEmail } from './emails.js';
import { inSendWindow, nextSendSlot, nextWindowStart } from './schedule.js';

const TZ = 'Asia/Kolkata';
/** A wall-clock time in India (UTC+05:30) as a Date. */
const ist = (s: string) => new Date(`${s}+05:30`);

describe('extractEmails', () => {
  it('keeps recruiter addresses and drops job boards, no-reply and images', () => {
    const text = `Send your CV to Careers@Acme.in. or hr.team@acme.co.in
      Questions: noreply@acme.in, alerts@naukri.com, jobs@linkedin.com, logo@2x.png
      Also careers@acme.in again.`;
    expect(extractEmails(text)).toEqual(['careers@acme.in', 'hr.team@acme.co.in']);
  });

  it('validates a single address', () => {
    expect(isValidEmail(' hr@acme.in ')).toBe(true);
    expect(isValidEmail('hr@acme')).toBe(false);
    expect(isValidEmail('not an email')).toBe(false);
  });
});

describe('send window', () => {
  it('is open on weekdays between 09:30 and 18:30 local time', () => {
    expect(inSendWindow(ist('2026-10-07T09:30:00'), TZ)).toBe(true); // Wednesday
    expect(inSendWindow(ist('2026-10-07T09:29:00'), TZ)).toBe(false);
    expect(inSendWindow(ist('2026-10-07T18:29:00'), TZ)).toBe(true);
    expect(inSendWindow(ist('2026-10-07T18:30:00'), TZ)).toBe(false);
    expect(inSendWindow(ist('2026-10-10T11:00:00'), TZ)).toBe(false); // Saturday
  });

  it('moves a Friday-evening time to Monday morning', () => {
    const t = nextWindowStart(ist('2026-10-09T19:00:00'), TZ);
    expect(t.getTime()).toBe(ist('2026-10-12T09:30:00').getTime());
  });
});

describe('nextSendSlot', () => {
  const half = () => 0.5;

  it('spaces emails a few minutes apart', () => {
    const now = ist('2026-10-07T10:00:00');
    const first = nextSendSlot(now, [], 5, TZ, half);
    expect(first.getTime()).toBe(now.getTime());
    const second = nextSendSlot(now, [first], 5, TZ, half);
    expect((second.getTime() - first.getTime()) / 60_000).toBeCloseTo(5.5);
  });

  it('starts inside the window when asked outside it', () => {
    const slot = nextSendSlot(ist('2026-10-07T06:00:00'), [], 5, TZ, half);
    expect(inSendWindow(slot, TZ)).toBe(true);
    expect(slot.getTime()).toBe(ist('2026-10-07T09:40:00').getTime());
  });

  it('rolls over to the next weekday once the daily limit is used', () => {
    const now = ist('2026-10-09T10:00:00'); // Friday
    const planned = [0, 10, 20].map((m) => new Date(now.getTime() + m * 60_000));
    const slot = nextSendSlot(now, planned, 3, TZ, half);
    expect(inSendWindow(slot, TZ)).toBe(true);
    expect(slot.getTime()).toBeGreaterThanOrEqual(ist('2026-10-12T09:30:00').getTime());
    expect(slot.getTime()).toBeLessThan(ist('2026-10-12T10:00:00').getTime());
  });
});

const profile = ProfileSchema.parse({
  personal: {
    name: 'Test User',
    email: 'test@example.com',
    phone: '+91-9999999999',
    location: 'Pune, India',
    links: { github: 'https://github.com/test', portfolio: 'https://<your-site>' },
  },
  totalExperienceYears: 1,
  skills: {
    languages: ['JavaScript'],
    frontend: ['React'],
    backend: ['Node.js', 'Express.js'],
    databases: ['MongoDB'],
  },
  experience: [
    {
      id: 'exp1',
      company: 'Acme',
      title: 'MERN Stack Developer',
      start: '2025-12',
      end: 'present',
      bullets: [{ id: 'e1', text: 'Built REST APIs with Node.js and MongoDB.', skills: [] }],
    },
  ],
  preferences: { roles: ['MERN Stack Developer'], noticePeriodDays: 30 },
});
const vocab = buildVocabulary(allSkills(profile));
const job = {
  title: 'Software Engineer',
  company: 'Zeta',
  location: 'Bengaluru',
  description: 'Node.js, React, MongoDB, Kafka.',
};

describe('composeBody', () => {
  it('adds the greeting, signature without placeholders, and the opt-out line', () => {
    const body = composeBody(profile, ['Para one.', 'Para two.'], 'Priya Sharma');
    expect(body.startsWith('Hi Priya,\n\nPara one.\n\nPara two.\n\nRegards,\nTest User')).toBe(
      true,
    );
    expect(body).toContain('+91-9999999999 | test@example.com');
    expect(body).toContain('https://github.com/test');
    expect(body).not.toContain('<your-site>');
    expect(body).toMatch(/reply "no"/);
    expect(composeBody(profile, ['x']).startsWith('Hi,')).toBe(true);
  });
});

describe('draftColdEmail', () => {
  it('returns a clean draft from the model', async () => {
    const call = vi.fn(async () => ({
      subject: ' Application: Software Engineer, Zeta ',
      paragraphs: [
        'I am applying for the Software Engineer role at Zeta.',
        'At Acme I build REST APIs with Node.js and MongoDB. My resume is attached.',
        'Would you consider my application?',
      ],
    })) as unknown as StructuredCall;
    const r = await draftColdEmail(profile, job, vocab, 'Priya', call);
    expect(call).toHaveBeenCalledTimes(1);
    expect(r.subject).toBe('Application: Software Engineer, Zeta');
    expect(r.body.startsWith('Hi Priya,')).toBe(true);
    expect(r.issues).toEqual([]);
  });

  it('retries once when the draft claims a skill in neither profile nor job, then reports it', async () => {
    const bad = {
      subject: 'Application',
      paragraphs: ['I have production Rust experience.', 'Resume attached.'],
    };
    const call = vi.fn(async () => bad) as unknown as StructuredCall;
    const r = await draftColdEmail(profile, job, vocab, undefined, call);
    expect(call).toHaveBeenCalledTimes(2);
    expect(r.issues.some((i) => /^Check this: .*Rust/.test(i))).toBe(true);
  });

  it('only warns about tech that is in the job post but not the profile', async () => {
    const call = vi.fn(async () => ({
      subject: 'Application',
      paragraphs: ['I would enjoy working with Kafka at Zeta.', 'Resume attached.'],
    })) as unknown as StructuredCall;
    const r = await draftColdEmail(profile, job, vocab, undefined, call);
    expect(call).toHaveBeenCalledTimes(1);
    expect(r.issues).toEqual([expect.stringMatching(/Kafka, which is in the job post/)]);
  });

  it('retries once on unreadable model output', async () => {
    const call = vi
      .fn()
      .mockRejectedValueOnce(new LlmOutputError('bad json'))
      .mockResolvedValueOnce({ subject: 'S', paragraphs: ['Para.'] }) as unknown as StructuredCall;
    const r = await draftColdEmail(profile, job, vocab, undefined, call);
    expect(r.subject).toBe('S');
  });
});

describe('followUpEmail', () => {
  it('replies in the same thread with a fixed, claim-free text', () => {
    const f = followUpEmail(profile, job, 'Application: Software Engineer', 'Priya');
    expect(f.subject).toBe('Re: Application: Software Engineer');
    expect(f.body).toContain('MERN Stack Developer at Acme');
    expect(followUpEmail(profile, job, 'Re: Hello').subject).toBe('Re: Hello');
  });
});
