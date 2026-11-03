import { describe, expect, it } from 'vitest';
import {
  canonicalUrl,
  normalizeCompany,
  normalizeJob,
  normalizeLocation,
  normalizeTitle,
  parseBatchYears,
  parseExperience,
  remoteScope,
  titleSeniority,
} from './normalize.js';
import type { RawJob } from '../sources/types.js';

describe('normalizeCompany', () => {
  it.each([
    ['Razorpay Software Pvt Ltd', 'razorpay'],
    ['Razorpay', 'razorpay'],
    ['Acme Technologies Private Limited', 'acme'],
    ['Zeta Inc.', 'zeta'],
    ['Amazon India', 'amazon'],
    ['Tech Solutions', 'tech solutions'], // nothing left after stripping -> keep original tokens
  ])('%s -> %s', (input, expected) => expect(normalizeCompany(input)).toBe(expected));
});

describe('normalizeTitle', () => {
  it.each([
    ['Sr. Full-Stack Developer', 'senior full stack developer'],
    ['SDE-1 (Backend)', 'software engineer 1'],
    ['Software Engineer II', 'software engineer 2'],
    ['Node.js Developer [Bangalore]', 'node developer'],
    ['ReactJS Developer - R12345', 'react developer'],
    ['MERN Stack Dev', 'mern stack developer'],
  ])('%s -> %s', (input, expected) => expect(normalizeTitle(input)).toBe(expected));
});

describe('titleSeniority', () => {
  it('flags senior titles', () => {
    expect(titleSeniority('Senior Backend Engineer')).toBe('senior');
    expect(titleSeniority('Tech Lead - Node')).toBe('senior');
    expect(titleSeniority('Software Engineer III')).toBe('senior');
    expect(titleSeniority('Security Engineer III')).toBe('senior');
    expect(titleSeniority('Backend - TL/STL')).toBe('senior');
    expect(titleSeniority('Software Engineer II')).toBeUndefined();
  });
  it('flags junior titles', () => {
    expect(titleSeniority('Junior React Developer')).toBe('junior');
    expect(titleSeniority('SDE 1')).toBe('junior');
  });
  it('returns undefined for neutral titles', () =>
    expect(titleSeniority('MERN Stack Developer')).toBeUndefined());
});

describe('normalizeLocation', () => {
  it('maps city aliases and detects India', () => {
    expect(normalizeLocation('Bangalore, Karnataka, India')).toMatchObject({
      city: 'Bengaluru',
      country: 'IN',
      workMode: 'onsite',
    });
    expect(normalizeLocation('Gurgaon')).toMatchObject({ city: 'Gurugram', country: 'IN' });
  });
  it('detects work modes', () => {
    expect(normalizeLocation('Pune (Hybrid)').workMode).toBe('hybrid');
    expect(normalizeLocation('India (Remote)').workMode).toBe('remote');
    expect(normalizeLocation('Anywhere').workMode).toBe('remote');
    expect(normalizeLocation('San Francisco, CA').workMode).toBe('unknown');
  });
  it('lets the source hint win', () =>
    expect(normalizeLocation('Pune', 'remote').workMode).toBe('remote'));
  it('uses the country hint for towns outside the city list', () => {
    expect(normalizeLocation('Jhirniya, Khargone', undefined, 'IN').country).toBe('IN');
    expect(normalizeLocation('Jhirniya, Khargone').country).toBeUndefined();
  });
});

describe('remoteScope', () => {
  it.each([
    ['Worldwide', 'global'],
    ['', 'global'],
    ['Remote - India', 'india'],
    ['APAC', 'india'],
    ['USA Only', 'restricted'],
    ['Europe, UK', 'restricted'],
    ['Remote, AMER', 'restricted'],
    ['Northern America, LATAM', 'restricted'],
  ] as const)('%s -> %s', (input, expected) => expect(remoteScope(input)).toBe(expected));
});

describe('parseExperience', () => {
  it.each([
    ['1-3 years of experience', { min: 1, max: 3 }],
    ['2 to 4 Yrs', { min: 2, max: 4 }],
    ['3+ years', { min: 3, max: undefined }],
    ['minimum 5 years of hands-on experience', { min: 5, max: undefined }],
    ['2 years of professional experience', { min: 2, max: undefined }],
    ['Freshers welcome', { min: 0, max: 1 }],
    ['We have been in business for 25 years', {}],
    ['No numbers here', {}],
  ])('%s', (input, expected) => expect(parseExperience(input)).toEqual(expected));

  it('takes the lowest minimum when several are mentioned', () => {
    expect(parseExperience('5+ years preferred, but 2+ years of experience is fine')).toEqual({
      min: 2,
      max: undefined,
    });
  });
});

describe('parseBatchYears', () => {
  it.each([
    ['Eligibility: 2024/2025 batch only', [2024, 2025]],
    ['Open for 2025 passouts', [2025]],
    ['2024 & 2025 graduates can apply', [2024, 2025]],
    ['Batch: 2025, 2026', [2025, 2026]],
    ['YOP - 2023, 2024', [2023, 2024]],
    ['Class of 2026', [2026]],
    ['2023-2025 batch', [2023, 2024, 2025]],
    ['B.Tech 2021-2025 batch', [2021, 2025]],
    [
      'Graduated in 2023 or later',
      [2023, 2024, 2025, 2026, 2027, 2028, 2029, 2030, 2031, 2032, 2033, 2034, 2035],
    ],
    ['Founded in 2015, we ship every quarter. Apply by 2025-10-31.', []],
    ['Hiring freshers for 2026 graduates only', [2026]],
  ])('%s', (text, expected) => expect(parseBatchYears(text)).toEqual(expected));
});

describe('canonicalUrl', () => {
  it('normalizes LinkedIn tracking links', () => {
    expect(
      canonicalUrl('https://www.linkedin.com/comm/jobs/view/4012345678/?trackingId=abc&refId=x'),
    ).toBe('https://www.linkedin.com/jobs/view/4012345678');
  });
  it('keeps only jk for Indeed', () => {
    expect(canonicalUrl('https://in.indeed.com/viewjob?jk=abc123&tk=1&from=ja')).toBe(
      'https://in.indeed.com/viewjob?jk=abc123',
    );
  });
  it('strips utm and gh_src params', () => {
    expect(
      canonicalUrl('https://boards.greenhouse.io/acme/jobs/1?gh_src=x&utm_source=y&id=5#apply'),
    ).toBe('https://boards.greenhouse.io/acme/jobs/1?id=5');
  });
});

describe('normalizeJob dedupe hash', () => {
  const base: RawJob = {
    source: 'greenhouse',
    sourceJobId: '1',
    url: 'https://x/1',
    company: 'Acme Fintech Pvt Ltd',
    title: 'MERN Stack Developer',
    location: 'Bangalore',
    description: '',
  };

  it('matches the same job across sources despite spelling differences', () => {
    const a = normalizeJob(base);
    const b = normalizeJob({
      ...base,
      source: 'gmail',
      sourceJobId: 'linkedin:9',
      company: 'Acme Fintech',
      location: 'Bengaluru, Karnataka, India',
    });
    expect(a.dedupeHash).toBe(b.dedupeHash);
  });

  it('differs for a different city or title', () => {
    const a = normalizeJob(base);
    expect(normalizeJob({ ...base, location: 'Pune' }).dedupeHash).not.toBe(a.dedupeHash);
    expect(normalizeJob({ ...base, title: 'Senior MERN Stack Developer' }).dedupeHash).not.toBe(
      a.dedupeHash,
    );
  });

  it('treats all remote listings of a role as one', () => {
    const a = normalizeJob({ ...base, location: 'Remote', workModeHint: 'remote' });
    const b = normalizeJob({ ...base, location: 'Remote - India', workModeHint: 'remote' });
    expect(a.dedupeHash).toBe(b.dedupeHash);
  });

  it('marks description quality', () => {
    expect(normalizeJob(base).descriptionQuality).toBe('none');
    expect(
      normalizeJob({ ...base, description: 'short', descriptionTruncated: true })
        .descriptionQuality,
    ).toBe('truncated');
    expect(normalizeJob({ ...base, description: 'x'.repeat(800) }).descriptionQuality).toBe('full');
  });
});
