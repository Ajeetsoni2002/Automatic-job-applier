import { describe, expect, it, vi } from 'vitest';
import { testProfile } from '../../test/helpers.js';
import { LlmBudgetExceededError, LlmOutputError, type StructuredCall } from './client.js';
import {
  buildSystemPrompt,
  buildUserPrompt,
  capConfidence,
  createAnthropicScorer,
  createMockScorer,
  type ScoreInput,
} from './scorer.js';

const input: ScoreInput = {
  title: 'MERN Stack Developer',
  company: 'Acme',
  location: 'Bengaluru',
  workMode: 'onsite',
  experienceMin: 1,
  experienceMax: 3,
  description: 'React, Node.js, Express, MongoDB, JWT. '.repeat(20),
  descriptionQuality: 'full',
  source: 'greenhouse',
};

const valid = {
  score: 86.6,
  confidence: 'high',
  reasons: ['Strong MERN overlap'],
  matchedSkills: ['React'],
  missingSkills: [],
  redFlags: [],
};

describe('anthropic scorer (mocked API)', () => {
  it('returns a clamped, rounded score with model metadata', async () => {
    const call = vi.fn(async () => valid) as unknown as StructuredCall;
    const out = await createAnthropicScorer(testProfile, call).score(input);
    expect(out).toMatchObject({ score: 87, confidence: 'high', promptVersion: 'score-v3' });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('retries once on unusable output, then succeeds', async () => {
    const call = vi
      .fn()
      .mockRejectedValueOnce(new LlmOutputError('bad json'))
      .mockResolvedValueOnce({ ...valid, score: 140 }) as unknown as StructuredCall;
    const out = await createAnthropicScorer(testProfile, call).score(input);
    expect(out.score).toBe(100);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('gives up after the retry', async () => {
    const call = vi
      .fn()
      .mockRejectedValue(new LlmOutputError('bad json')) as unknown as StructuredCall;
    await expect(createAnthropicScorer(testProfile, call).score(input)).rejects.toBeInstanceOf(
      LlmOutputError,
    );
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('does not retry when the daily budget is exhausted', async () => {
    const call = vi
      .fn()
      .mockRejectedValue(new LlmBudgetExceededError('cap')) as unknown as StructuredCall;
    await expect(createAnthropicScorer(testProfile, call).score(input)).rejects.toBeInstanceOf(
      LlmBudgetExceededError,
    );
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('caps confidence for alert-email jobs without a description', async () => {
    const call = vi.fn(async () => valid) as unknown as StructuredCall;
    const out = await createAnthropicScorer(testProfile, call).score({
      ...input,
      description: '',
      descriptionQuality: 'none',
    });
    expect(out.confidence).toBe('low');
  });
});

describe('prompts', () => {
  it('keeps contact details out of the system prompt', () => {
    const prompt = buildSystemPrompt(testProfile);
    expect(prompt).not.toContain('test@example.com');
    expect(prompt).toContain('MERN Stack Developer');
  });

  it('tells the model the candidate batch and the posting batches', () => {
    expect(buildSystemPrompt(testProfile)).toContain('2025 batch');
    expect(buildUserPrompt({ ...input, batchYears: [2024, 2025] })).toContain(
      'Eligible batches: 2024, 2025',
    );
    expect(buildUserPrompt(input)).toContain('Eligible batches: not stated');
  });
});

describe('capConfidence', () => {
  it.each([
    ['high', 'full', 'high'],
    ['high', 'truncated', 'medium'],
    ['medium', 'truncated', 'medium'],
    ['high', 'none', 'low'],
  ] as const)('%s + %s -> %s', (c, q, expected) => expect(capConfidence(c, q)).toBe(expected));
});

describe('mock scorer', () => {
  it('scores a matching MERN job above a mismatched one', async () => {
    const scorer = createMockScorer(testProfile);
    const good = await scorer.score(input);
    const bad = await scorer.score({
      ...input,
      title: 'Data Engineer',
      description: 'Python, Spark, AWS, Kubernetes. 6+ years.',
      experienceMin: 6,
    });
    expect(good.score).toBeGreaterThan(70);
    expect(bad.score).toBeLessThan(50);
    expect(good.matchedSkills).toEqual(expect.arrayContaining(['React', 'Node.js', 'MongoDB']));
  });
});
