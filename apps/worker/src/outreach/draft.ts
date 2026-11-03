import { z } from 'zod';
import { getEnv, type Profile } from '@ja/shared';
import { LlmOutputError, structuredCall, type StructuredCall } from '../llm/client.js';
import type { TechVocabulary } from '../tailor/claims.js';
import { reviewLetter } from '../tailor/coverLetter.js';
import { buildJobPrompt, profileForPrompt, type TailorJobInput } from '../tailor/resume.js';

const MAX_WORDS = 140;

export const EmailDraftSchema = z.object({
  subject: z.string().describe('Short, specific subject line naming the role'),
  paragraphs: z.array(z.string()).describe('2-3 short paragraphs. No greeting, no sign-off.'),
});

function systemPrompt(profile: Profile): string {
  return `You write short cold emails from one job seeker to a recruiter or hiring manager about one specific opening.

Rules:
- ${MAX_WORDS - 50}-${MAX_WORDS} words in total, plain text, 2-3 short paragraphs, no greeting or sign-off (added for you).
- Paragraph 1: the exact role and company, and one line on why the candidate fits.
- Paragraph 2: one concrete, real example from the profile that matches the job (current work, a project, an achievement). Mention that the resume is attached.
- Last paragraph: one clear, low-pressure ask (consider the application / a short call). Notice period is ${profile.preferences.noticePeriodDays} days if relevant.
- Facts only from the profile. Never invent numbers, tools, outcomes, mutual contacts or how the candidate found the role.
- Never claim a technology the profile doesn't list. You may name the company's stack only as theirs.
- No flattery, no clichés ("I hope this email finds you well", "passionate", "esteemed"), no emojis.
- Subject: under 9 words, e.g. "Application: MERN Developer — 1 yr, Bengaluru".

Candidate profile (YAML):
${profileForPrompt(profile)}`;
}

export function signature(profile: Profile): string {
  const p = profile.personal;
  const links = [p.links.linkedin, p.links.github, p.links.portfolio].filter(
    (l) => l && !l.includes('<'),
  );
  return ['Regards,', p.name, [p.phone, p.email].filter(Boolean).join(' | '), ...links].join('\n');
}

const OPT_OUT = 'P.S. If this isn\'t relevant, just reply "no" and I won\'t email again.';

export function composeBody(profile: Profile, paragraphs: string[], contactName?: string): string {
  const first = contactName?.trim().split(/\s+/)[0];
  return [
    `Hi${first ? ` ${first}` : ''},`,
    ...paragraphs.map((p) => p.trim()),
    signature(profile),
    OPT_OUT,
  ].join('\n\n');
}

/** First email to a recruiter: written by the smart model, checked against the profile. */
export async function draftColdEmail(
  profile: Profile,
  job: TailorJobInput,
  vocab: TechVocabulary,
  contactName?: string,
  call: StructuredCall = structuredCall,
): Promise<{ subject: string; body: string; issues: string[] }> {
  const system = systemPrompt(profile);
  let feedback = '';
  let last:
    { subject: string; paragraphs: string[]; review: ReturnType<typeof reviewLetter> } | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const out = await call({
        purpose: 'outreach_email',
        model: getEnv().LLM_MODEL_SMART,
        system,
        user: buildJobPrompt(job, `Write the cold email for this job.${feedback}`),
        schema: EmailDraftSchema,
        maxTokens: 16000,
        effort: 'medium',
        fallback: true,
      });
      last = { ...out, review: reviewLetter(out.paragraphs.join('\n\n'), profile, job, vocab) };
    } catch (err) {
      if (!(err instanceof LlmOutputError) || attempt === 1) throw err;
      continue;
    }
    if (!last.review.hard.length) break;
    feedback = `\n\nA previous draft was rejected because it ${last.review.hard.join('; ')}. Use only facts from the profile.`;
  }
  const words = last!.paragraphs.join(' ').split(/\s+/).filter(Boolean).length;
  const issues = [
    ...last!.review.hard.map((m) => `Check this: the email ${m}`),
    ...last!.review.warnings,
    ...(words > MAX_WORDS + 40 ? [`Email body is ${words} words; consider trimming`] : []),
  ];
  return {
    subject: last!.subject.trim(),
    body: composeBody(profile, last!.paragraphs, contactName),
    issues,
  };
}

/** The single follow-up: a short fixed template (no LLM, no new claims). */
export function followUpEmail(
  profile: Profile,
  job: { title: string; company: string },
  originalSubject: string,
  contactName?: string,
): { subject: string; body: string } {
  const current = profile.experience.find((e) => e.end === 'present') ?? profile.experience[0];
  const what = current ? `my work as a ${current.title} at ${current.company}` : 'my experience';
  const paragraphs = [
    `Following up on my email about the ${job.title} role at ${job.company}. I'm still keen on it and happy to share more about ${what}, or to take a short call whenever convenient.`,
    'My resume is attached again for convenience. Thank you for your time.',
  ];
  return {
    subject: originalSubject.toLowerCase().startsWith('re:')
      ? originalSubject
      : `Re: ${originalSubject}`,
    body: composeBody(profile, paragraphs, contactName),
  };
}
