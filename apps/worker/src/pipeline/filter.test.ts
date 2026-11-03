import { describe, expect, it } from 'vitest';
import { testProfile } from '../../test/helpers.js';
import { applyHardFilters, batchMatch, containsKeyword, type FilterableJob } from './filter.js';

const now = new Date('2026-10-08T00:00:00Z');
const prefs = testProfile.preferences;
const opts = { maxJobAgeDays: 21, now };

const job = (over: Partial<FilterableJob> = {}): FilterableJob => ({
  companyNorm: 'acme',
  title: 'MERN Stack Developer',
  location: 'Bengaluru',
  workMode: 'onsite',
  country: 'IN',
  experienceMin: 1,
  postedAt: new Date('2026-10-06T00:00:00Z'),
  ...over,
});

const reason = (j: FilterableJob) => {
  const r = applyHardFilters(j, prefs, opts);
  return r.pass ? 'pass' : r.reason;
};

describe('containsKeyword', () => {
  it('matches whole words only', () => {
    expect(containsKeyword('Java Developer', 'Java')).toBe(true);
    expect(containsKeyword('JavaScript Developer', 'Java')).toBe(false);
  });
  it('handles keywords that start or end with symbols', () => {
    expect(containsKeyword('ASP.NET Developer', '.NET')).toBe(true);
    expect(containsKeyword('C++ Engineer', 'C++')).toBe(true);
  });
});

describe('applyHardFilters', () => {
  it('passes a good match', () => expect(reason(job())).toBe('pass'));
  it('excludes companies after normalization', () =>
    expect(reason(job({ companyNorm: 'bad' }))).toBe('excluded company'));
  it('excludes title keywords', () =>
    expect(reason(job({ title: 'Java Developer' }))).toMatch(/excluded keyword "Java"/));
  it('keeps JavaScript titles', () =>
    expect(reason(job({ title: 'JavaScript Developer' }))).toBe('pass'));
  it('drops non-tech roles', () =>
    expect(reason(job({ title: 'Account Executive' }))).toBe('title is not a target role'));
  it('drops senior titles', () =>
    expect(reason(job({ title: 'Senior Full Stack Engineer' }))).toBe('senior-level title'));
  it('drops jobs needing too much experience', () =>
    expect(reason(job({ experienceMin: 5 }))).toMatch(/needs 5\+ years/));
  it('keeps jobs with unknown experience', () =>
    expect(reason(job({ experienceMin: null }))).toBe('pass'));
  it('drops old postings', () =>
    expect(reason(job({ postedAt: new Date('2026-09-01T00:00:00Z') }))).toMatch(
      /posted \d+ days ago/,
    ));
  it('drops cities outside preferences', () =>
    expect(reason(job({ location: 'Chennai' }))).toMatch(/location Chennai/));
  it('keeps multi-city listings if any city matches', () =>
    expect(reason(job({ location: 'Chennai / Pune' }))).toBe('pass'));
  it('drops foreign on-site jobs', () =>
    expect(
      reason(job({ location: 'San Francisco, CA', workMode: 'unknown', country: null })),
    ).toMatch(/outside preferred countries/));
  it('keeps jobs with no location at all', () =>
    expect(reason(job({ location: '', workMode: 'unknown', country: null }))).toBe('pass'));

  describe('graduation batch', () => {
    it('drops postings for other batches only', () =>
      expect(reason(job({ batchYears: [2026] }))).toBe('for 2026 batch only (you: 2025)'));
    it('keeps postings that include your batch', () =>
      expect(reason(job({ batchYears: [2024, 2025] }))).toBe('pass'));
    it('lets an eligible-batch posting through despite a high "years" mention', () =>
      expect(reason(job({ batchYears: [2025], experienceMin: 5 }))).toBe('pass'));
    it('reports match state', () => {
      expect(batchMatch({ batchYears: [2025] }, prefs)).toBe(true);
      expect(batchMatch({ batchYears: [2026] }, prefs)).toBe(false);
      expect(batchMatch({ batchYears: [] }, prefs)).toBeUndefined();
      expect(
        batchMatch({ batchYears: [2025] }, { ...prefs, graduationYear: undefined }),
      ).toBeUndefined();
    });
  });

  describe('remote', () => {
    it('keeps worldwide remote when global remote is accepted', () =>
      expect(reason(job({ workMode: 'remote', location: 'Worldwide', country: null }))).toBe(
        'pass',
      ));
    it('keeps India remote', () =>
      expect(reason(job({ workMode: 'remote', location: 'India (Remote)' }))).toBe('pass'));
    it('drops region-restricted remote', () =>
      expect(reason(job({ workMode: 'remote', location: 'USA Only', country: null }))).toMatch(
        /restricted/,
      ));
    it('drops global remote when not accepted', () => {
      const r = applyHardFilters(
        job({ workMode: 'remote', location: 'Anywhere', country: null }),
        { ...prefs, acceptGlobalRemote: false },
        opts,
      );
      expect(r).toEqual({ pass: false, reason: 'global remote not accepted' });
    });
  });
});
