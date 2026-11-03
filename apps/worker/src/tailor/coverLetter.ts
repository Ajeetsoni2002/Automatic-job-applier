import { z } from 'zod';
import { getEnv, type Profile } from '@ja/shared';
import { LlmOutputError, structuredCall, type StructuredCall } from '../llm/client.js';
import { checkClaims, findNumbers, techKey, type TechVocabulary } from './claims.js';
import { buildJobPrompt, profileForPrompt, type Issue, type TailorJobInput } from './resume.js';

const MAX_WORDS = 260;

export const CoverLetterSchema = z.object({
  paragraphs: z
    .array(z.string())
    .describe('3 short paragraphs of the letter body. No greeting, no sign-off.'),
});

export function buildCoverLetterSystemPrompt(profile: Profile): string {
  return `You write short, specific cover letters for one candidate.

Rules:
- 3 paragraphs, ${MAX_WORDS - 40}-${MAX_WORDS} words in total, plain text, no greeting or sign-off (they are added for you).
- Paragraph 1: the role and company by name, and why the candidate fits in one concrete sentence.
- Paragraph 2: one or two real examples from the profile (current work, projects, achievements) that match what the job asks for.
- Paragraph 3: availability (notice period ${profile.preferences.noticePeriodDays} days) and a short, polite close.
- Use only facts from the profile. Never invent numbers, metrics, team sizes, durations or outcomes.
- Never say the candidate knows a technology the profile doesn't list. You may name the company's stack only as theirs ("your team's use of X"), never as the candidate's experience.
- No clichés ("I am writing to express my interest", "passionate", "esteemed organisation", "I believe I would be a great fit"). Simple, direct Indian-English business tone.

Candidate profile (YAML):
${profileForPrompt(profile)}`;
}

export function letterWithFrame(profile: Profile, paragraphs: string[]): string {
  const contact = [profile.personal.phone, profile.personal.email].filter(Boolean).join(' | ');
  return [
    'Dear Hiring Manager,',
    ...paragraphs.map((p) => p.trim()),
    `Regards,\n${profile.personal.name}\n${contact}`,
  ].join('\n\n');
}

/**
 * Checks a letter body. Hard problems (numbers found in neither the profile nor the job post, or
 * technologies found in neither) trigger one regeneration; a technology that only the job post
 * mentions is reported for review, since it may be named as the company's stack.
 */
export function reviewLetter(
  body: string,
  profile: Profile,
  job: TailorJobInput,
  vocab: TechVocabulary,
): { hard: string[]; warnings: string[] } {
  const profileText = profileForPrompt(profile);
  const jobText = `${job.title}\n${job.company}\n${job.description}`;
  // The company's own name (e.g. "Supabase") is not a skill claim.
  const profileTech = new Set([...Object.values(profile.skills).flat(), job.company].map(techKey));
  const vsProfile = checkClaims(vocab, body, profileText, profileTech);
  const jobTech = vocab.find(jobText);
  const hard: string[] = [];
  const warnings: string[] = [];
  for (const t of vsProfile.newTech) {
    if (jobTech.has(techKey(t)))
      warnings.push(
        `Mentions ${t}, which is in the job post but not your profile: check it isn't claimed as your skill`,
      );
    else hard.push(`mentions ${t}, which is in neither your profile nor the job post`);
  }
  const allowedNumbers = new Set([...findNumbers(profileText), ...findNumbers(jobText)]);
  for (const n of findNumbers(body))
    if (!allowedNumbers.has(n)) hard.push(`uses the number ${n}, which isn't in your profile`);
  const words = body.split(/\s+/).filter(Boolean).length;
  if (words > MAX_WORDS + 40) warnings.push(`Letter is ${words} words; consider trimming`);
  return { hard, warnings };
}

export async function writeCoverLetter(
  profile: Profile,
  job: TailorJobInput,
  vocab: TechVocabulary,
  call: StructuredCall = structuredCall,
): Promise<{ text: string; issues: Issue[] }> {
  const model = getEnv().LLM_MODEL_SMART;
  const system = buildCoverLetterSystemPrompt(profile);
  let feedback = '';
  let last: { body: string; review: ReturnType<typeof reviewLetter> } | undefined;

  for (let attempt = 0; attempt < 2; attempt++) {
    let paragraphs: string[];
    try {
      ({ paragraphs } = await call({
        purpose: 'tailor_cover_letter',
        model,
        system,
        user: buildJobPrompt(job, `Write the cover letter body for this job.${feedback}`),
        schema: CoverLetterSchema,
        maxTokens: 16000,
        effort: 'medium',
        fallback: true,
      }));
    } catch (err) {
      if (!(err instanceof LlmOutputError) || attempt === 1) throw err;
      continue;
    }
    const body = paragraphs.join('\n\n');
    last = { body, review: reviewLetter(body, profile, job, vocab) };
    if (!last.review.hard.length) break;
    feedback = `\n\nA previous draft was rejected because it ${last.review.hard.join('; ')}. Use only facts from the profile.`;
  }

  const issues: Issue[] = [
    ...last!.review.hard.map((m) => ({
      kind: 'cover_letter' as const,
      message: `Check this: the letter ${m}`,
    })),
    ...last!.review.warnings.map((m) => ({ kind: 'cover_letter' as const, message: m })),
  ];
  return { text: letterWithFrame(profile, last!.body.split('\n\n')), issues };
}
