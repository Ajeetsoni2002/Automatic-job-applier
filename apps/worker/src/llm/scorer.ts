import YAML from 'yaml';
import { z } from 'zod';
import { allSkills, getEnv, llmEnabled, type Confidence, type Profile } from '@ja/shared';
import { containsKeyword } from '../pipeline/filter.js';
import { LlmOutputError, structuredCall, type StructuredCall } from './client.js';

export const PROMPT_VERSION = 'score-v3';
const MAX_DESCRIPTION_CHARS = 6000;

export interface ScoreInput {
  title: string;
  company: string;
  location: string;
  workMode: string;
  experienceMin?: number | null;
  experienceMax?: number | null;
  /** Eligible graduation batches named in the posting (empty if none). */
  batchYears?: number[] | null;
  salary?: {
    min?: number | null;
    max?: number | null;
    currency?: string | null;
    period?: string | null;
  } | null;
  description: string;
  descriptionQuality: 'full' | 'truncated' | 'none';
  source: string;
}

export interface ScoreOutput {
  score: number;
  confidence: Confidence;
  reasons: string[];
  matchedSkills: string[];
  missingSkills: string[];
  redFlags: string[];
  model: string;
  promptVersion: string;
}

export interface Scorer {
  name: string;
  score(job: ScoreInput): Promise<ScoreOutput>;
}

export const ScoreSchema = z.object({
  score: z.number().describe('Overall fit, integer 0-100'),
  confidence: z.enum(['high', 'medium', 'low']),
  reasons: z.array(z.string()).describe('2-4 short reasons for the score'),
  matchedSkills: z.array(z.string()),
  missingSkills: z.array(z.string()).describe('Required skills the candidate does not list'),
  redFlags: z
    .array(z.string())
    .describe('e.g. seniority mismatch, unpaid, unrelated stack; empty if none'),
});

/** Caps confidence by how much of the job we actually saw. */
export function capConfidence(
  c: Confidence,
  quality: ScoreInput['descriptionQuality'],
): Confidence {
  if (quality === 'none') return 'low';
  if (quality === 'truncated' && c === 'high') return 'medium';
  return c;
}

export function buildSystemPrompt(profile: Profile): string {
  // Contact details are deliberately left out: they don't affect fit.
  const candidate = {
    summary: profile.summary,
    totalExperienceYears: profile.totalExperienceYears,
    skills: profile.skills,
    experience: profile.experience.map((e) => ({
      title: e.title,
      company: e.company,
      start: e.start,
      end: e.end,
      highlights: e.bullets.map((b) => b.text),
    })),
    projects: profile.projects.map((p) => ({
      name: p.name,
      stack: p.stack,
      highlights: p.bullets.map((b) => b.text),
    })),
    education: profile.education.map((e) => `${e.degree} ${e.field ?? ''} (${e.start}-${e.end})`),
    achievements: profile.achievements,
    preferences: {
      roles: profile.preferences.roles,
      locations: profile.preferences.locations,
      workModes: profile.preferences.workModes,
      acceptGlobalRemote: profile.preferences.acceptGlobalRemote,
      maxExperienceYears: profile.preferences.maxExperienceYears,
      graduationYear: profile.preferences.graduationYear,
      minSalaryLpa: profile.preferences.minSalaryLpa,
    },
  };

  return `You score job postings for one specific candidate. Judge how good a fit the job is and how likely the candidate is to be shortlisted.

Scoring rubric (total 100):
- Tech stack match (40): overlap between the job's required/primary stack and the candidate's real skills. Core MERN/JavaScript/TypeScript overlap matters most; nice-to-haves matter little.
- Experience fit (25): the candidate has ${profile.totalExperienceYears} year(s) of experience${profile.preferences.graduationYear ? `, graduated in ${profile.preferences.graduationYear} (the "${profile.preferences.graduationYear} batch")` : ''}, and targets roles needing at most ${profile.preferences.maxExperienceYears}. Penalise jobs clearly needing more, or senior/lead scope. Fresher and graduate-trainee roles open to the candidate's batch fit fully.${profile.preferences.graduationYear ? ` If the posting lists eligible batches and ${profile.preferences.graduationYear} is among them, give full experience marks and say so in a reason.` : ''}
- Role type (15): how close the role is to the candidate's target roles.
- Location / work mode (10): matches the candidate's preferences.
- Other signals (10): salary vs. preference when stated, company/role quality.

Rules:
- Use only facts present in the job text and the candidate profile. Never assume skills the candidate does not list.
- Missing information is not evidence against the job. Many postings come from job-alert emails with only a title, company and location. When the description is missing or truncated, give each rubric part the score that the available fields most plausibly imply (e.g. a "React Developer" title implies a React stack and a junior-to-mid level unless it says senior), and express the uncertainty through the confidence field, not by lowering the score.
- Keep each reason under 20 words. List at most 8 matched and 8 missing skills.
- Red flags are concrete problems stated in the posting: seniority mismatch, unpaid/commission-only, unrelated primary stack, suspicious posting. A missing description, salary or other detail is never a red flag. Empty list if none.

Candidate profile (YAML):
${YAML.stringify(candidate)}`;
}

export function buildUserPrompt(job: ScoreInput): string {
  const exp =
    job.experienceMin != null
      ? `${job.experienceMin}${job.experienceMax != null ? `-${job.experienceMax}` : '+'} years`
      : 'not stated';
  const salary =
    job.salary && (job.salary.min || job.salary.max)
      ? `${job.salary.min ?? '?'}-${job.salary.max ?? '?'} ${job.salary.currency ?? ''} per ${job.salary.period ?? 'year'}`
      : 'not stated';
  const desc =
    job.descriptionQuality === 'none'
      ? '(no description available — only the fields above)'
      : job.description.slice(0, MAX_DESCRIPTION_CHARS);
  return `Score this job.

Title: ${job.title}
Company: ${job.company}
Location: ${job.location || 'not stated'} (work mode: ${job.workMode})
Experience required: ${exp}
Eligible batches: ${job.batchYears?.length ? job.batchYears.join(', ') : 'not stated'}
Salary: ${salary}
Description quality: ${job.descriptionQuality}

Description:
${desc}`;
}

export function createAnthropicScorer(
  profile: Profile,
  call: StructuredCall = structuredCall,
): Scorer {
  const model = getEnv().LLM_MODEL_FAST;
  const system = buildSystemPrompt(profile);
  return {
    name: model,
    async score(job) {
      const user = buildUserPrompt(job);
      let out: z.infer<typeof ScoreSchema> | undefined;
      for (let attempt = 0; attempt < 2 && !out; attempt++) {
        try {
          out = await call({
            purpose: 'score',
            model,
            system,
            user,
            schema: ScoreSchema,
            maxTokens: 1024,
          });
        } catch (err) {
          if (!(err instanceof LlmOutputError) || attempt === 1) throw err;
        }
      }
      return {
        score: Math.max(0, Math.min(100, Math.round(out!.score))),
        confidence: capConfidence(out!.confidence, job.descriptionQuality),
        reasons: out!.reasons.slice(0, 5),
        matchedSkills: out!.matchedSkills.slice(0, 12),
        missingSkills: out!.missingSkills.slice(0, 12),
        redFlags: out!.redFlags.slice(0, 6),
        model,
        promptVersion: PROMPT_VERSION,
      };
    },
  };
}

/** Deterministic keyword scorer: used without an API key, in tests, and for the seed. */
export function createMockScorer(profile: Profile): Scorer {
  const skills = allSkills(profile);
  const roleWords = profile.preferences.roles
    .flatMap((r) => r.toLowerCase().split(/\s+/))
    .filter((w) => w.length > 2);
  const COMMON_REQS = [
    'Python',
    'Java',
    'Go',
    'AWS',
    'Docker',
    'Kubernetes',
    'GraphQL',
    'Next.js',
    'PostgreSQL',
    'Redis',
    'Angular',
    'Vue',
  ];

  return {
    name: 'mock-keyword',
    async score(job) {
      const text = `${job.title}\n${job.description}`;
      const matched = skills.filter((s) => containsKeyword(text, s));
      const missing = COMMON_REQS.filter(
        (s) => containsKeyword(text, s) && !skills.some((k) => k.toLowerCase() === s.toLowerCase()),
      );
      const title = job.title.toLowerCase();
      const roleHit = roleWords.some((w) => title.includes(w));
      const expOk =
        job.experienceMin == null || job.experienceMin <= profile.preferences.maxExperienceYears;

      let score =
        30 +
        Math.min(40, matched.length * 6) +
        (roleHit ? 15 : 0) +
        (expOk ? 10 : -15) -
        missing.length * 3;
      if (job.descriptionQuality === 'none') score = roleHit ? 65 : 45;
      score = Math.max(0, Math.min(100, score));

      const reasons = [
        `${matched.length} profile skill(s) mentioned${matched.length ? `: ${matched.slice(0, 5).join(', ')}` : ''}`,
        roleHit ? 'Title matches a target role' : 'Title is not a close match to target roles',
        expOk ? 'Experience requirement fits' : `Needs ${job.experienceMin}+ years`,
      ];
      return {
        score,
        confidence: capConfidence(
          job.descriptionQuality === 'full' ? 'medium' : 'low',
          job.descriptionQuality,
        ),
        reasons,
        matchedSkills: matched.slice(0, 12),
        missingSkills: missing,
        redFlags: expOk ? [] : ['Experience requirement above preference'],
        model: 'mock-keyword',
        promptVersion: PROMPT_VERSION,
      };
    },
  };
}

/** Real LLM scorer when an API key is configured (and LLM_MOCK is off), otherwise the mock. */
export function createScorer(profile: Profile): Scorer {
  return llmEnabled() ? createAnthropicScorer(profile) : createMockScorer(profile);
}
