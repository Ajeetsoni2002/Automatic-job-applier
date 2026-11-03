import YAML from 'yaml';
import { z } from 'zod';
import { getEnv, type Profile, type ResumeBulletDto, type TailoredResumeDto } from '@ja/shared';
import { LlmOutputError, structuredCall, type StructuredCall } from '../llm/client.js';
import { checkClaims, techKey, type TechVocabulary } from './claims.js';

export const TAILOR_PROMPT_VERSION = 'tailor-v1';

const MAX_BULLETS_PER_ROLE = 5;
const MAX_PROJECTS = 3;
const MAX_JOB_TEXT = 6000;

export interface TailorJobInput {
  title: string;
  company: string;
  location: string;
  description: string;
}

export interface Issue {
  kind: 'resume' | 'cover_letter' | 'pdf';
  message: string;
}

const BulletPlan = z.object({ id: z.string(), text: z.string() });

export const ResumePlanSchema = z.object({
  summary: z
    .string()
    .describe('2-3 sentence professional summary for this job, using only facts from the profile'),
  skillsOrder: z
    .array(z.string())
    .describe(
      'Skills from the profile, most relevant to this job first. Only skills the profile lists.',
    ),
  experience: z.array(z.object({ id: z.string(), bullets: z.array(BulletPlan) })),
  projects: z.array(z.object({ id: z.string(), bullets: z.array(BulletPlan) })),
  notes: z.string().describe('One sentence: what you emphasised for this job and why'),
});
export type ResumePlan = z.infer<typeof ResumePlanSchema>;

/** The parts of the profile the model may draw on, with ids, and without contact details. */
export function profileForPrompt(profile: Profile): string {
  return YAML.stringify({
    summary: profile.summary,
    totalExperienceYears: profile.totalExperienceYears,
    noticePeriodDays: profile.preferences.noticePeriodDays,
    skills: profile.skills,
    experience: profile.experience.map((e) => ({
      id: e.id,
      company: e.company,
      title: e.title,
      start: e.start,
      end: e.end,
      bullets: e.bullets.map((b) => ({ id: b.id, text: b.text })),
    })),
    projects: profile.projects.map((p) => ({
      id: p.id,
      name: p.name,
      stack: p.stack,
      bullets: p.bullets.map((b) => ({ id: b.id, text: b.text })),
    })),
    education: profile.education,
    achievements: profile.achievements,
  });
}

export function buildResumeSystemPrompt(profile: Profile): string {
  return `You tailor a resume to one job posting. You may only SELECT, REORDER and lightly REPHRASE content that already exists in the candidate profile below.

Rules:
- Each bullet you return must carry the id of a profile bullet and keep that bullet's meaning. Never merge, split or invent bullets.
- Never add a technology, tool, number, metric, team size, duration, outcome, company or title that the original bullet does not state. If a better wording would need any of those, copy the original text exactly.
- Rephrase only to put the job's priorities first or to use the job's wording for something the original already says.
- Include every experience entry (by id) with its 2-${MAX_BULLETS_PER_ROLE} most relevant bullets, most relevant first.
- Include the 1-${MAX_PROJECTS} most relevant projects (by id) with 1-3 bullets each.
- summary: 2-3 sentences built only from facts in the profile (current role, real experience, real projects, listed skills). No adjectives the profile can't back, such as "expert" or "seasoned".
- skillsOrder: skills exactly as the profile spells them, most relevant to the job first.

Candidate profile (YAML):
${profileForPrompt(profile)}`;
}

export function buildJobPrompt(job: TailorJobInput, task: string): string {
  return `${task}

Job title: ${job.title}
Company: ${job.company}
Location: ${job.location || 'not stated'}

Job description:
${job.description.trim() ? job.description.slice(0, MAX_JOB_TEXT) : '(no description available; tailor to the title and company)'}`;
}

const SKILL_GROUP_LABELS: Record<string, string> = {
  languages: 'Languages',
  frontend: 'Frontend',
  backend: 'Backend',
  databases: 'Databases',
  devops: 'DevOps & Deployment',
  tools: 'Tools',
  other: 'Other',
};

/**
 * Builds the final resume from the model's plan. Everything factual (companies, titles, dates,
 * education, contact) comes from the profile; the plan only chooses and words bullets. Any bullet
 * or summary that claims a technology or number its source doesn't contain is replaced by the
 * original text and reported as an issue.
 */
export function assembleResume(
  profile: Profile,
  plan: ResumePlan,
  vocab: TechVocabulary,
): { resume: TailoredResumeDto; issues: Issue[] } {
  const issues: Issue[] = [];
  const profileSkillKeys = new Set(Object.values(profile.skills).flat().map(techKey));

  const pickBullets = (
    source: Array<{ id: string; text: string; skills: string[] }>,
    planned: Array<{ id: string; text: string }> | undefined,
    fallbackCount: number,
    max: number,
  ): ResumeBulletDto[] => {
    const byId = new Map(source.map((b) => [b.id, b]));
    const chosen: ResumeBulletDto[] = [];
    const seen = new Set<string>();
    for (const p of planned ?? []) {
      const original = byId.get(p.id);
      if (!original || seen.has(p.id)) continue;
      seen.add(p.id);
      let text = p.text.trim() || original.text;
      const check = checkClaims(vocab, text, original.text, new Set(original.skills.map(techKey)));
      if (!check.ok) {
        const added = [...check.newTech, ...check.newNumbers].join(', ');
        issues.push({
          kind: 'resume',
          message: `Kept original wording for bullet ${p.id}: the rephrase added ${added}`,
        });
        text = original.text;
      }
      chosen.push({ id: p.id, text, rephrased: text !== original.text });
      if (chosen.length >= max) break;
    }
    if (!chosen.length)
      return source
        .slice(0, fallbackCount)
        .map((b) => ({ id: b.id, text: b.text, rephrased: false }));
    return chosen;
  };

  const experience = profile.experience.map((e) => ({
    id: e.id,
    company: e.company,
    title: e.title,
    location: e.location,
    start: e.start,
    end: e.end,
    bullets: pickBullets(
      e.bullets,
      plan.experience.find((x) => x.id === e.id)?.bullets,
      3,
      MAX_BULLETS_PER_ROLE,
    ),
  }));

  const projectById = new Map(profile.projects.map((p) => [p.id, p]));
  let plannedProjects = plan.projects.filter((p) => projectById.has(p.id));
  plannedProjects = plannedProjects.filter(
    (p, i) => plannedProjects.findIndex((q) => q.id === p.id) === i,
  );
  if (!plannedProjects.length)
    plannedProjects = profile.projects.slice(0, 2).map((p) => ({ id: p.id, bullets: [] }));
  const projects = plannedProjects.slice(0, MAX_PROJECTS).map((pp) => {
    const p = projectById.get(pp.id)!;
    return {
      id: p.id,
      name: p.name,
      url: p.url && !p.url.includes('<') ? p.url : undefined,
      repo: p.repo && !p.repo.includes('<') ? p.repo : undefined,
      stack: p.stack,
      bullets: pickBullets(p.bullets, pp.bullets, 2, 3),
    };
  });

  let summary = plan.summary.trim();
  const summaryCheck = checkClaims(vocab, summary, profileForPrompt(profile), profileSkillKeys);
  if (!summary || !summaryCheck.ok) {
    if (summary)
      issues.push({
        kind: 'resume',
        message: `Used the profile summary: the tailored one added ${[...summaryCheck.newTech, ...summaryCheck.newNumbers].join(', ')}`,
      });
    summary = profile.summary.trim();
  }

  // Skills keep the profile's groups; within and across groups, the model's order decides.
  const rank = new Map<string, number>();
  plan.skillsOrder.forEach((s, i) => {
    const k = techKey(s);
    if (!rank.has(k)) rank.set(k, i);
  });
  const r = (s: string) => rank.get(techKey(s)) ?? Number.MAX_SAFE_INTEGER;
  const skills = Object.entries(profile.skills)
    .filter(([, items]) => items.length)
    .map(([group, items]) => ({
      group: SKILL_GROUP_LABELS[group] ?? group,
      items: [...items].sort((a, b) => r(a) - r(b)),
    }))
    .sort((a, b) => Math.min(...a.items.map(r)) - Math.min(...b.items.map(r)));

  const links = Object.fromEntries(
    Object.entries(profile.personal.links).filter(([, v]) => v && !v.includes('<')),
  ) as Record<string, string>;

  return {
    issues,
    resume: {
      name: profile.personal.name,
      contact: {
        email: profile.personal.email,
        phone: profile.personal.phone,
        location: profile.personal.location,
        links,
      },
      summary,
      skills,
      experience,
      projects,
      education: profile.education.map((e) => ({ ...e })),
      achievements: profile.achievements,
    },
  };
}

export async function tailorResume(
  profile: Profile,
  job: TailorJobInput,
  vocab: TechVocabulary,
  call: StructuredCall = structuredCall,
): Promise<{ resume: TailoredResumeDto; issues: Issue[]; notes: string; model: string }> {
  const model = getEnv().LLM_MODEL_SMART;
  const system = buildResumeSystemPrompt(profile);
  const user = buildJobPrompt(job, 'Tailor the resume for this job.');
  let plan: ResumePlan | undefined;
  for (let attempt = 0; attempt < 2 && !plan; attempt++) {
    try {
      plan = await call({
        purpose: 'tailor_resume',
        model,
        system,
        user,
        schema: ResumePlanSchema,
        maxTokens: 16000,
        effort: 'medium',
        fallback: true,
      });
    } catch (err) {
      if (!(err instanceof LlmOutputError) || attempt === 1) throw err;
    }
  }
  const { resume, issues } = assembleResume(profile, plan!, vocab);
  return { resume, issues, notes: plan!.notes, model };
}
