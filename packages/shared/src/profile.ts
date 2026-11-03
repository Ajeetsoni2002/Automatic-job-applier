import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { DATA_DIR } from './paths.js';
import { WORK_MODES } from './types.js';

// ---------- profile.yaml ----------

const BulletSchema = z.object({
  id: z.string().regex(/^[a-z0-9_-]+$/i, 'bullet id may contain letters, digits, _ and - only'),
  text: z.string().min(1),
  skills: z.array(z.string()).default([]),
});

const ExperienceSchema = z.object({
  id: z.string(),
  company: z.string(),
  title: z.string(),
  location: z.string().optional(),
  start: z.string().regex(/^\d{4}-\d{2}$/, 'use YYYY-MM'),
  end: z.union([z.string().regex(/^\d{4}-\d{2}$/, 'use YYYY-MM'), z.literal('present')]),
  bullets: z.array(BulletSchema).default([]),
});

const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string().optional(),
  repo: z.string().optional(),
  stack: z.array(z.string()).default([]),
  bullets: z.array(BulletSchema).default([]),
});

const EducationSchema = z.object({
  level: z.enum(['secondary', 'higher_secondary', 'diploma', 'undergraduate', 'postgraduate']).optional(),
  institution: z.string(),
  degree: z.string(),
  field: z.string().optional(),
  start: z.string(),
  end: z.string(),
  grade: z.string().optional(),
  board: z.string().optional(),
  university: z.string().optional(),
  state: z.string().optional(),
  country: z.string().optional(),
});

export const ProfileSchema = z.object({
  personal: z.object({
    name: z.string().min(1),
    email: z.string().min(3),
    phone: z.string().optional(),
    location: z.string(),
    links: z
      .object({
        linkedin: z.string().optional(),
        github: z.string().optional(),
        portfolio: z.string().optional(),
        leetcode: z.string().optional(),
      })
      .default({}),
  }),
  summary: z.string().default(''),
  totalExperienceYears: z.number().min(0),
  skills: z.object({
    languages: z.array(z.string()).default([]),
    frontend: z.array(z.string()).default([]),
    backend: z.array(z.string()).default([]),
    databases: z.array(z.string()).default([]),
    devops: z.array(z.string()).default([]),
    tools: z.array(z.string()).default([]),
    other: z.array(z.string()).default([]),
  }),
  experience: z.array(ExperienceSchema).default([]),
  projects: z.array(ProjectSchema).default([]),
  education: z.array(EducationSchema).default([]),
  certifications: z.array(z.string()).default([]),
  achievements: z.array(z.string()).default([]),
  preferences: z.object({
    /** Unknown form facts wait for the candidate unless generation was explicitly enabled. */
    allowGeneratedApplicationAnswers: z.boolean().default(false),
    roles: z.array(z.string()).min(1, 'add at least one target role'),
    searchKeywords: z.array(z.string()).default([]),
    locations: z.array(z.string()).default([]),
    countries: z.array(z.string()).default(['IN']),
    acceptGlobalRemote: z.boolean().default(true),
    workModes: z.array(z.enum(WORK_MODES)).default(['onsite', 'hybrid', 'remote']),
    maxExperienceYears: z.number().min(0).default(3),
    /** Your graduation year ("batch"). Postings that list eligible batches are matched against it. */
    graduationYear: z.number().int().min(2000).max(2100).optional(),
    minSalaryLpa: z.number().min(0).optional(),
    noticePeriodDays: z.number().min(0).default(30),
    excludeCompanies: z.array(z.string()).default([]),
    excludeKeywords: z.array(z.string()).default([]),
    /** A job title must contain at least one of these (case-insensitive) to be considered. */
    titleKeywords: z
      .array(z.string())
      .default([
        'developer',
        'engineer',
        'sde',
        'software',
        'full stack',
        'fullstack',
        'frontend',
        'front end',
        'backend',
        'back end',
        'web',
        'mern',
        'mean',
        'node',
        'react',
        'javascript',
        'typescript',
        'programmer',
      ]),
  }),
});

export type Profile = z.infer<typeof ProfileSchema>;

// ---------- qa_bank.yaml ----------

export const QaBankSchema = z.object({
  answers: z
    .array(
      z.object({
        key: z.string(),
        question: z.string(),
        answer: z.string(),
        aliases: z.array(z.string()).default([]),
      }),
    )
    .default([]),
});

export type QaBank = z.infer<typeof QaBankSchema>;

// ---------- target_companies.yaml ----------

export const ATS_TYPES = ['greenhouse', 'lever', 'ashby'] as const;
export type AtsType = (typeof ATS_TYPES)[number];

export const TargetCompaniesSchema = z.object({
  companies: z
    .array(
      z.object({
        name: z.string(),
        ats: z.enum(ATS_TYPES),
        slug: z.string().min(1),
        priority: z.enum(['high', 'medium', 'low']).default('medium'),
        enabled: z.boolean().default(true),
      }),
    )
    .default([]),
});

export type TargetCompanies = z.infer<typeof TargetCompaniesSchema>;
export type TargetCompany = TargetCompanies['companies'][number];

// ---------- loading ----------

export interface LoadedFile<T> {
  data: T;
  file: string;
  isExample: boolean;
}

export class ConfigFileError extends Error {}

function loadYaml<T>(baseName: string, schema: z.ZodType<T>): LoadedFile<T> {
  const real = path.join(DATA_DIR, `${baseName}.yaml`);
  const example = path.join(DATA_DIR, `${baseName}.example.yaml`);
  const file = fs.existsSync(real) ? real : example;
  if (!fs.existsSync(file))
    throw new ConfigFileError(`Missing ${real} (and no example file found)`);

  let raw: unknown;
  try {
    raw = YAML.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new ConfigFileError(
      `${path.basename(file)} is not valid YAML: ${(err as Error).message}`,
    );
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const lines = parsed.error.issues.map(
      (i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`,
    );
    throw new ConfigFileError(`${path.basename(file)} has invalid fields:\n${lines.join('\n')}`);
  }
  return { data: parsed.data, file, isExample: file === example };
}

export const loadProfile = () => loadYaml('profile', ProfileSchema);
export const loadQaBank = () => loadYaml('qa_bank', QaBankSchema);
export const loadTargetCompanies = () => loadYaml('target_companies', TargetCompaniesSchema);

/** All skills in the profile, flattened and de-duplicated (original casing). */
export function allSkills(profile: Profile): string[] {
  const set = new Map<string, string>();
  for (const list of Object.values(profile.skills))
    for (const s of list) set.set(s.toLowerCase(), s);
  for (const p of profile.projects) for (const s of p.stack) set.set(s.toLowerCase(), s);
  return [...set.values()];
}
