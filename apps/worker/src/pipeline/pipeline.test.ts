// Integration tests against a real MongoDB (database "job-autopilot-test"). Skipped if Mongo isn't running.
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  connectDb,
  JobModel,
  JobScoreModel,
  SettingsModel,
  SourceRunModel,
  updateSettings,
} from '@ja/shared';
import { testProfile } from '../../test/helpers.js';
import { SOURCES } from '../sources/index.js';
import type { RawJob } from '../sources/types.js';
import { runPipeline } from './run.js';

vi.mock('@ja/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ja/shared')>();
  const { testProfile: profile } = await import('../../test/helpers.js');
  return {
    ...actual,
    loadProfile: () => ({ data: profile, file: 'test', isExample: false }),
    loadTargetCompanies: () => ({ data: { companies: [] }, file: 'test', isExample: false }),
  };
});

const TEST_URI = process.env.MONGODB_URI_TEST ?? 'mongodb://127.0.0.1:27017/job-autopilot-test';
const dbUp = await connectDb(TEST_URI)
  .then(() => true)
  .catch(() => false);

const recent = new Date(Date.now() - 86_400_000);
const raw = (over: Partial<RawJob>): RawJob => ({
  source: 'remotive',
  sourceJobId: '1',
  url: 'https://example.com/1',
  company: 'Acme',
  title: 'MERN Stack Developer',
  location: 'Worldwide',
  workModeHint: 'remote',
  description: 'React, Node.js, Express and MongoDB. 1-3 years of experience. '.repeat(12),
  postedAt: recent,
  ...over,
});

describe.skipIf(!dbUp)('pipeline (MongoDB)', () => {
  beforeAll(async () => {
    expect(mongoose.connection.name).toBe('job-autopilot-test'); // never touch the real database
  });
  afterAll(async () => {
    if (dbUp) await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });
  beforeEach(async () => {
    vi.restoreAllMocks();
    await Promise.all([
      JobModel.deleteMany({}),
      JobScoreModel.deleteMany({}),
      SourceRunModel.deleteMany({}),
      SettingsModel.deleteMany({}),
    ]);
    for (const s of Object.values(SOURCES))
      vi.spyOn(s, 'unavailableReason').mockReturnValue(undefined);
  });

  it('stores, filters and scores jobs, and never duplicates on a second run', async () => {
    vi.spyOn(SOURCES.remotive, 'fetch').mockResolvedValue({
      jobs: [
        raw({}),
        raw({ sourceJobId: '2', title: 'Senior Backend Engineer', url: 'https://example.com/2' }),
      ],
      warnings: [],
    });

    const first = await runPipeline({ trigger: 'cli', sources: ['remotive'] });
    expect(first.sources[0]).toMatchObject({ status: 'ok', fetched: 2, inserted: 1, filtered: 1 });
    expect(first.scoring).toMatchObject({ scored: 1, failed: 0 });

    const filtered = await JobModel.findOne({ sourceJobId: '2' }).lean();
    expect(filtered).toMatchObject({ status: 'filtered_out', filterReason: 'senior-level title' });
    const scored = await JobModel.findOne({ sourceJobId: '1' }).lean();
    expect(scored?.status).toBe('scored');
    expect(await JobScoreModel.countDocuments({ jobId: scored!._id })).toBe(1);

    const second = await runPipeline({ trigger: 'cli', sources: ['remotive'], force: true });
    expect(second.sources[0]).toMatchObject({ inserted: 0, duplicates: 2 });
    expect(await JobModel.countDocuments()).toBe(2);
  });

  it('respects a source minimum interval unless forced', async () => {
    vi.spyOn(SOURCES.remotive, 'fetch').mockResolvedValue({ jobs: [], warnings: [] });
    await runPipeline({ trigger: 'cli', sources: ['remotive'], skipScoring: true });
    const again = await runPipeline({ trigger: 'cli', sources: ['remotive'], skipScoring: true });
    expect(again.sources[0]!.status).toBe('skipped');
    expect(again.sources[0]!.message).toMatch(/min interval/);
  });

  it('merges the same job from two sources and upgrades the description', async () => {
    vi.spyOn(SOURCES.gmail, 'fetch').mockResolvedValue({
      jobs: [
        raw({
          source: 'gmail',
          sourceJobId: 'linkedin:42',
          company: 'Acme Pvt Ltd',
          location: 'Remote',
          description: '',
        }),
      ],
      warnings: [],
    });
    vi.spyOn(SOURCES.greenhouse, 'fetch').mockResolvedValue({
      jobs: [raw({ source: 'greenhouse', sourceJobId: 'acme:42' })],
      warnings: [],
    });

    await runPipeline({ trigger: 'cli', sources: ['gmail'] });
    const before = await JobModel.findOne().lean();
    expect(before).toMatchObject({
      descriptionQuality: 'none',
      status: 'scored',
      scoreConfidence: 'low',
    });

    const r = await runPipeline({ trigger: 'cli', sources: ['greenhouse'] });
    expect(r.sources[0]).toMatchObject({ duplicates: 1, inserted: 0 });
    const after = await JobModel.findOne().lean();
    expect(await JobModel.countDocuments()).toBe(1);
    expect(after!.seenOn.map((s) => s.source)).toEqual(['gmail', 'greenhouse']);
    expect(after!.descriptionQuality).toBe('full');
    expect(after!.status).toBe('scored'); // re-scored with the full description
    expect(await JobScoreModel.countDocuments({ jobId: after!._id })).toBe(2);
  });

  it('isolates a failing source', async () => {
    vi.spyOn(SOURCES.lever, 'fetch').mockRejectedValue(new Error('boom'));
    vi.spyOn(SOURCES.remotive, 'fetch').mockResolvedValue({ jobs: [raw({})], warnings: [] });
    const r = await runPipeline({
      trigger: 'cli',
      sources: ['lever', 'remotive'],
      skipScoring: true,
    });
    expect(r.sources.find((s) => s.source === 'lever')).toMatchObject({
      status: 'failed',
      message: 'boom',
    });
    expect(r.sources.find((s) => s.source === 'remotive')).toMatchObject({
      status: 'ok',
      inserted: 1,
    });
    expect(await SourceRunModel.findOne({ source: 'lever' }).lean()).toMatchObject({
      status: 'failed',
      error: 'boom',
    });
  });

  it('does nothing when the kill switch is on', async () => {
    const fetch = vi.spyOn(SOURCES.remotive, 'fetch');
    await updateSettings({ killSwitch: true });
    const r = await runPipeline({ trigger: 'cli', sources: ['remotive'] });
    expect(r.skipped).toBe('kill switch is on');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('writes nothing on a dry run', async () => {
    vi.spyOn(SOURCES.remotive, 'fetch').mockResolvedValue({ jobs: [raw({})], warnings: [] });
    const r = await runPipeline({ trigger: 'cli', sources: ['remotive'], dryRun: true });
    expect(r.sources[0]!.preview).toHaveLength(1);
    expect(await JobModel.countDocuments()).toBe(0);
    expect(await SourceRunModel.countDocuments()).toBe(0);
  });

  it('uses the test profile', () => expect(testProfile.personal.name).toBe('Test User'));
});
