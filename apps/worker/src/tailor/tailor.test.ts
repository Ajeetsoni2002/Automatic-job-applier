import { describe, expect, it, vi } from 'vitest';
import { allSkills, ProfileSchema } from '@ja/shared';
import { LlmOutputError, type StructuredCall } from '../llm/client.js';
import { buildVocabulary, checkClaims, findNumbers, techKey } from './claims.js';
import { letterWithFrame, reviewLetter, writeCoverLetter } from './coverLetter.js';
import { formatMonth, renderResumeHtml } from './render.js';
import { assembleResume, type ResumePlan } from './resume.js';

const profile = ProfileSchema.parse({
  personal: {
    name: 'Test <User>',
    email: 'test@example.com',
    phone: '+91-9999999999',
    location: 'Pune, India',
    links: { github: 'https://github.com/test', portfolio: 'https://<your-site>' },
  },
  summary: 'MERN developer building React and Node.js apps.',
  totalExperienceYears: 1,
  skills: {
    languages: ['JavaScript', 'TypeScript'],
    frontend: ['React', 'Tailwind CSS'],
    backend: ['Node.js', 'Express.js', 'REST APIs'],
    databases: ['MongoDB'],
    devops: ['GitHub Actions'],
  },
  experience: [
    {
      id: 'exp1',
      company: 'Acme',
      title: 'MERN Stack Developer',
      start: '2025-12',
      end: 'present',
      bullets: [
        {
          id: 'e1',
          text: 'Built REST APIs with Node.js, Express.js and MongoDB.',
          skills: ['Node.js'],
        },
        { id: 'e2', text: 'Developed React screens for 3 product areas.', skills: ['React'] },
        { id: 'e3', text: 'Supported deployment of the application.', skills: [] },
      ],
    },
  ],
  projects: [
    {
      id: 'p1',
      name: 'PYQ Portal',
      stack: ['React', 'MongoDB'],
      bullets: [{ id: 'p1b1', text: 'Built filters for question papers.', skills: [] }],
    },
    {
      id: 'p2',
      name: 'Portfolio',
      stack: ['React'],
      bullets: [{ id: 'p2b1', text: 'Responsive personal site.', skills: [] }],
    },
  ],
  education: [
    { institution: 'UIT', degree: 'B.Tech', start: '2021', end: '2025', grade: 'CGPA 8.1' },
  ],
  achievements: ['Solved 450+ coding problems.'],
  preferences: { roles: ['MERN Stack Developer'], noticePeriodDays: 30 },
});
const vocab = buildVocabulary(allSkills(profile));

const plan = (over: Partial<ResumePlan> = {}): ResumePlan => ({
  summary: 'MERN developer at Acme building React screens and Node.js REST APIs.',
  skillsOrder: ['MongoDB', 'Node.js', 'React'],
  experience: [
    {
      id: 'exp1',
      bullets: [
        { id: 'e2', text: 'Developed React screens across 3 product areas.' },
        { id: 'e1', text: 'Built Node.js and Express.js REST APIs on MongoDB.' },
      ],
    },
  ],
  projects: [{ id: 'p1', bullets: [{ id: 'p1b1', text: 'Built filters for question papers.' }] }],
  notes: 'n',
  ...over,
});

describe('claims', () => {
  it('treats spelling variants of a technology as the same', () => {
    expect(techKey('Node.js')).toBe(techKey('NodeJS'));
    expect(techKey('Express.js')).toBe(techKey('express'));
  });
  it('finds numbers but not years', () => {
    expect([...findNumbers('450+ problems, 30% faster, 10k users, in 2025')]).toEqual([
      '450',
      '30',
      '10',
    ]);
  });
  it('flags technologies and numbers missing from the source', () => {
    const c = checkClaims(
      vocab,
      'Built APIs with Node.js and Docker for 10k users',
      'Built APIs with Node.js',
    );
    expect(c).toEqual({ ok: false, newTech: ['Docker'], newNumbers: ['10'] });
  });
});

describe('assembleResume', () => {
  it('keeps facts from the profile and the bullet order from the plan', () => {
    const { resume, issues } = assembleResume(profile, plan(), vocab);
    expect(issues).toEqual([]);
    expect(resume.experience[0]).toMatchObject({
      company: 'Acme',
      title: 'MERN Stack Developer',
      start: '2025-12',
    });
    expect(resume.experience[0]!.bullets.map((b) => b.id)).toEqual(['e2', 'e1']);
    expect(resume.experience[0]!.bullets[1]!.rephrased).toBe(true);
  });

  it('reverts a rephrase that adds a technology or a number', () => {
    const { resume, issues } = assembleResume(
      profile,
      plan({
        experience: [
          {
            id: 'exp1',
            bullets: [
              { id: 'e1', text: 'Built REST APIs with Node.js, Docker and Kubernetes.' },
              { id: 'e3', text: 'Supported deployment for 50k users.' },
            ],
          },
        ],
      }),
      vocab,
    );
    expect(resume.experience[0]!.bullets.map((b) => b.text)).toEqual([
      'Built REST APIs with Node.js, Express.js and MongoDB.',
      'Supported deployment of the application.',
    ]);
    expect(issues.map((i) => i.message).join(' ')).toMatch(/Docker.*Kubernetes[\s\S]*50/);
  });

  it('ignores unknown ids and falls back to profile bullets when none are usable', () => {
    const { resume } = assembleResume(
      profile,
      plan({ experience: [{ id: 'exp1', bullets: [{ id: 'nope', text: 'Invented.' }] }] }),
      vocab,
    );
    expect(resume.experience[0]!.bullets.map((b) => b.id)).toEqual(['e1', 'e2', 'e3']);
  });

  it('replaces a summary that invents claims with the profile summary', () => {
    const { resume, issues } = assembleResume(
      profile,
      plan({ summary: 'Developer with 5 years of AWS experience.' }),
      vocab,
    );
    expect(resume.summary).toBe(profile.summary);
    expect(issues[0]!.message).toMatch(/AWS/);
  });

  it('orders skills by relevance and drops placeholder links', () => {
    const { resume } = assembleResume(profile, plan(), vocab);
    expect(resume.skills[0]).toEqual({ group: 'Databases', items: ['MongoDB'] });
    expect(resume.contact.links).toEqual({ github: 'https://github.com/test' });
  });
});

describe('cover letter', () => {
  const job = {
    title: 'MERN Developer',
    company: 'ShopKart',
    location: 'Pune',
    description: 'We use Kafka and React. 2+ years.',
  };

  it('accepts profile facts, warns about job-only tech, rejects invented numbers', () => {
    expect(
      reviewLetter(
        'I built React screens and solved 450 problems. Notice: 30 days.',
        profile,
        job,
        vocab,
      ),
    ).toEqual({
      hard: [],
      warnings: [],
    });
    const r = reviewLetter('I know Kafka and Rust, and grew traffic by 40%.', profile, job, vocab);
    expect(r.warnings[0]).toMatch(/Kafka/);
    expect(r.hard.join(' ')).toMatch(/Rust[\s\S]*40/);
  });

  it('regenerates once when the first draft invents a number', async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce({ paragraphs: ['I improved speed by 70%.'] })
      .mockResolvedValueOnce({
        paragraphs: ['I built React screens at Acme.'],
      }) as unknown as StructuredCall;
    const out = await writeCoverLetter(profile, job, vocab, call);
    expect(call).toHaveBeenCalledTimes(2);
    expect(out.issues).toEqual([]);
    expect(out.text).toBe(letterWithFrame(profile, ['I built React screens at Acme.']));
    expect(out.text).toMatch(
      /^Dear Hiring Manager,[\s\S]*Regards,\nTest <User>\n\+91-9999999999 \| test@example.com$/,
    );
  });

  it('propagates unusable output after a retry', async () => {
    const call = vi.fn().mockRejectedValue(new LlmOutputError('bad')) as unknown as StructuredCall;
    await expect(writeCoverLetter(profile, job, vocab, call)).rejects.toBeInstanceOf(
      LlmOutputError,
    );
  });
});

describe('render', () => {
  it('formats months', () => {
    expect(formatMonth('2025-12')).toBe('Dec 2025');
    expect(formatMonth('present')).toBe('Present');
  });
  it('escapes HTML and includes every section', () => {
    const html = renderResumeHtml(assembleResume(profile, plan(), vocab).resume);
    expect(html).toContain('Test &lt;User&gt;');
    expect(html).not.toContain('<User>');
    for (const h of ['Summary', 'Skills', 'Experience', 'Projects', 'Education', 'Achievements'])
      expect(html).toContain(`<h2>${h}</h2>`);
    expect(html).toContain('Dec 2025 – Present');
  });
});
