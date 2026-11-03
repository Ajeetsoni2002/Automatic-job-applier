import { describe, expect, it } from 'vitest';
import { fakeHttp, jsonFixture, testCtx } from '../../test/helpers.js';
import { HttpError } from '../http.js';
import { adzunaSource } from './adzuna.js';
import { ashbySource, greenhouseSource, leverSource } from './ats.js';
import { remotiveSource } from './remotive.js';

const target = (ats: 'greenhouse' | 'lever' | 'ashby', slug: string) => ({
  name: slug,
  ats,
  slug,
  priority: 'medium' as const,
  enabled: true,
});

describe('greenhouse adapter', () => {
  it('maps jobs and decodes escaped HTML content', async () => {
    const http = fakeHttp({
      'boards-api.greenhouse.io/v1/boards/acme/jobs': jsonFixture('greenhouse.json'),
    });
    const { jobs, warnings } = await greenhouseSource.fetch(
      testCtx(http, [target('greenhouse', 'acme')]),
    );
    expect(warnings).toEqual([]);
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({
      source: 'greenhouse',
      sourceJobId: 'acme:7001',
      company: 'acme',
      title: 'Software Engineer - Backend (Node.js)',
      location: 'Bangalore, India',
    });
    expect(jobs[0]!.description).toContain('1-3 years');
    expect(jobs[0]!.description).not.toContain('<p>');
    expect(jobs[0]!.postedAt?.toISOString()).toBe('2026-10-04T13:00:00.000Z');
    expect(http.calls[0]).toContain('content=true');
  });

  it('reports a bad slug as a warning and keeps other companies', async () => {
    const http = fakeHttp({
      '/boards/missing/': new HttpError('HTTP 404', 404, 'x'),
      '/boards/acme/': jsonFixture('greenhouse.json'),
    });
    const { jobs, warnings } = await greenhouseSource.fetch(
      testCtx(http, [target('greenhouse', 'missing'), target('greenhouse', 'acme')]),
    );
    expect(jobs).toHaveLength(2);
    expect(warnings[0]).toMatch(/board "missing" not found/);
  });

  it('throws when every company fails', async () => {
    const http = fakeHttp({ '/boards/missing/': new HttpError('HTTP 404', 404, 'x') });
    await expect(
      greenhouseSource.fetch(testCtx(http, [target('greenhouse', 'missing')])),
    ).rejects.toThrow(/not found/);
  });

  it('is unavailable without target companies', () => {
    expect(greenhouseSource.unavailableReason(testCtx(fakeHttp({}), []))).toMatch(
      /no enabled greenhouse/,
    );
  });
});

describe('lever adapter', () => {
  it('maps postings including lists, workplace type and salary', async () => {
    const http = fakeHttp({ 'api.lever.co/v0/postings/shopkart': jsonFixture('lever.json') });
    const { jobs } = await leverSource.fetch(testCtx(http, [target('lever', 'shopkart')]));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      title: 'Full Stack Developer (MERN)',
      location: 'Pune / Remote - India',
      workModeHint: 'hybrid',
      salary: { min: 600000, max: 1000000, currency: 'INR', period: 'year' },
    });
    expect(jobs[0]!.description).toContain('0-2 years of experience');
  });
});

describe('ashby adapter', () => {
  it('maps listed jobs and skips unlisted ones', async () => {
    const http = fakeHttp({
      'api.ashbyhq.com/posting-api/job-board/cloudnine': jsonFixture('ashby.json'),
    });
    const { jobs } = await ashbySource.fetch(testCtx(http, [target('ashby', 'cloudnine')]));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      title: 'Frontend Engineer',
      location: 'Remote / India',
      workModeHint: 'remote',
    });
  });
});

describe('remotive adapter', () => {
  it('maps jobs as remote with the required-location text', async () => {
    const http = fakeHttp({ 'remotive.com/api/remote-jobs': jsonFixture('remotive.json') });
    const { jobs } = await remotiveSource.fetch(testCtx(http));
    expect(jobs.map((j) => j.location)).toEqual(['Worldwide', 'USA Only']);
    expect(jobs.every((j) => j.workModeHint === 'remote')).toBe(true);
    expect(jobs[0]!.description).toBe('Node.js, Express, PostgreSQL. 2+ years of experience.');
  });
});

describe('adzuna adapter', () => {
  const env = { ADZUNA_APP_ID: 'id', ADZUNA_APP_KEY: 'key', ADZUNA_MAX_PAGES: 1 };

  it('is unavailable without keys', () => {
    expect(
      adzunaSource.unavailableReason(
        testCtx(fakeHttp({}), [], { ADZUNA_APP_ID: undefined, ADZUNA_APP_KEY: undefined }),
      ),
    ).toMatch(/not set/);
  });

  it('queries India, strips HTML from titles, ignores predicted salaries, dedupes across keywords', async () => {
    const http = fakeHttp({ 'api.adzuna.com/v1/api/jobs/in/search/1': jsonFixture('adzuna.json') });
    const ctx = testCtx(http, [], env);
    ctx.profile = {
      ...ctx.profile,
      preferences: { ...ctx.profile.preferences, searchKeywords: ['mern', 'node'] },
    };
    const { jobs } = await adzunaSource.fetch(ctx);
    expect(http.calls).toHaveLength(2);
    expect(http.calls[0]).toContain('what=mern');
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({
      title: 'MERN Stack Developer',
      company: 'Infotech Solutions Pvt Ltd',
      descriptionTruncated: true,
      countryHint: 'IN',
    });
    expect(jobs[0]!.salary).toEqual({ min: 500000, max: 800000, currency: 'INR', period: 'year' });
    expect(jobs[1]!.salary).toBeUndefined();
  });
});
