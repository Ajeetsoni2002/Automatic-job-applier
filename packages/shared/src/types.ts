// Runtime-light constants and DTO types shared by api, worker and web.
// This file must not import mongoose or anything Node-only: the web app imports it.

export const SOURCE_NAMES = [
  'adzuna',
  'remotive',
  'greenhouse',
  'lever',
  'ashby',
  'gmail',
  /** Naukri search pages, read in a visible browser on your computer (Phase 4). */
  'naukri',
] as const;
export type SourceName = (typeof SOURCE_NAMES)[number];

/** Where a stored job came from: a fetched source, or added by hand from the dashboard. */
export const JOB_SOURCES = [...SOURCE_NAMES, 'manual'] as const;
export type JobSourceName = (typeof JOB_SOURCES)[number];

export const WORK_MODES = ['onsite', 'hybrid', 'remote', 'unknown'] as const;
export type WorkMode = (typeof WORK_MODES)[number];

export const JOB_STATUSES = [
  'new',
  'filtered_out',
  'scored',
  'score_failed',
  'shortlisted',
  'ignored',
  'applied_manually',
  'queued',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** Statuses a user may set from the dashboard. */
export const USER_SETTABLE_STATUSES = [
  'scored',
  'shortlisted',
  'ignored',
  'applied_manually',
] as const;
export type UserSettableStatus = (typeof USER_SETTABLE_STATUSES)[number];

export const DESCRIPTION_QUALITIES = ['full', 'truncated', 'none'] as const;
export type DescriptionQuality = (typeof DESCRIPTION_QUALITIES)[number];

export const CONFIDENCES = ['high', 'medium', 'low'] as const;
export type Confidence = (typeof CONFIDENCES)[number];

export const CHANNEL_NAMES = [
  'ats',
  'cold_email',
  'naukri',
  'linkedin',
  'linkedin_referral',
] as const;

/** Job sites applied on with your own logged-in browser session (Phase 4). */
export const PORTAL_NAMES = ['linkedin', 'naukri'] as const;
export type PortalName = (typeof PORTAL_NAMES)[number];

export interface PortalDto {
  name: PortalName;
  connected: boolean;
  checkedAt?: string;
  /** Stopped after a CAPTCHA / security check / block; resumes by itself after this time. */
  pausedUntil?: string;
  pauseReason?: string;
  lastAppliedAt?: string;
  appliedToday: number;
}
export type ChannelName = (typeof CHANNEL_NAMES)[number];

export const CHANNEL_MODES = ['auto', 'approve', 'assist', 'off'] as const;
export type ChannelMode = (typeof CHANNEL_MODES)[number];

export interface SalaryDto {
  min?: number;
  max?: number;
  currency?: string;
  period?: 'year' | 'month' | 'hour';
}

export interface SeenOnDto {
  source: JobSourceName;
  sourceJobId: string;
  url: string;
  seenAt: string;
}

export interface JobScoreDto {
  score: number;
  confidence: Confidence;
  reasons: string[];
  matchedSkills: string[];
  missingSkills: string[];
  redFlags: string[];
  model: string;
  promptVersion: string;
  createdAt: string;
}

export interface JobDto {
  id: string;
  source: JobSourceName;
  url: string;
  company: string;
  title: string;
  location: string;
  city?: string;
  country?: string;
  workMode: WorkMode;
  experienceMin?: number;
  experienceMax?: number;
  /** Eligible graduation batches named in the posting. */
  batchYears: number[];
  /** true when the posting names your batch, false when it names others only. */
  batchMatch?: boolean;
  salary?: SalaryDto;
  descriptionQuality: DescriptionQuality;
  postedAt?: string;
  fetchedAt: string;
  status: JobStatus;
  filterReason?: string;
  score?: number;
  scoreConfidence?: Confidence;
  notes?: string;
  seenOn: SeenOnDto[];
}

export interface JobDetailDto extends JobDto {
  description: string;
  latestScore?: JobScoreDto;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ChannelSettingsDto {
  mode: ChannelMode;
  dailyLimit: number;
}

export interface TailoringSettingsDto {
  /** Generate resume + cover letter automatically for high-scoring jobs. */
  auto: boolean;
  minScore: number;
  /** Max automatic generations per day (manual "Generate" and shortlisting don't count). */
  dailyLimit: number;
}

export interface OutreachSettingsDto {
  /** Draft emails only for jobs scoring at least this. */
  minScore: number;
  /** Days to wait for a reply before the single follow-up. */
  followUpDays: number;
}

export interface SettingsDto {
  killSwitch: boolean;
  minScore: number;
  tailoring: TailoringSettingsDto;
  outreach: OutreachSettingsDto;
  sources: Record<SourceName, boolean>;
  channels: Record<ChannelName, ChannelSettingsDto>;
  digest: { enabled: boolean };
  updatedAt?: string;
}

export interface ResumeBulletDto {
  id: string;
  text: string;
  /** True when the text differs from the profile bullet. */
  rephrased: boolean;
}

export interface TailoredResumeDto {
  name: string;
  contact: { email: string; phone?: string; location: string; links: Record<string, string> };
  summary: string;
  skills: Array<{ group: string; items: string[] }>;
  experience: Array<{
    id: string;
    company: string;
    title: string;
    location?: string;
    start: string;
    end: string;
    bullets: ResumeBulletDto[];
  }>;
  projects: Array<{
    id: string;
    name: string;
    url?: string;
    repo?: string;
    stack: string[];
    bullets: ResumeBulletDto[];
  }>;
  education: Array<{
    institution: string;
    degree: string;
    field?: string;
    start: string;
    end: string;
    grade?: string;
  }>;
  achievements: string[];
}

export interface TailoredDocDto {
  id: string;
  jobId: string;
  version: number;
  status: 'ready' | 'failed';
  resume?: TailoredResumeDto;
  coverLetter: string;
  coverLetterEdited: boolean;
  issues: Array<{ kind: string; message: string }>;
  hasPdf: boolean;
  notes?: string;
  model?: string;
  error?: string;
  trigger: 'auto' | 'manual' | 'shortlist';
  createdAt: string;
}

export const APPLICATION_STATUSES = [
  /** The worker is reading the form (links you pasted). */
  'preparing',
  /** The site wants you to log in or create an account, in the browser window that opened. */
  'needs_login',
  /** Form read, but a required question has no answer yet. */
  'needs_input',
  /** All required answers present; waiting for approval (approve mode) or the auto run. */
  'ready',
  'approved',
  'submitting',
  'submitted',
  /** Filled but not submitted because DRY_RUN=true. */
  'dry_run',
  /** CAPTCHA or an unexpected page: open the link and finish by hand. */
  'needs_manual',
  'failed',
  'skipped',
] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export const FIELD_KINDS = [
  'text',
  'email',
  'tel',
  'url',
  'number',
  'date',
  'textarea',
  'select',
  'combobox',
  'multiselect',
  'radio',
  'checkbox',
  'checkboxes',
  'buttons',
  'file',
] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];

export interface ApplicationAnswerDto {
  key: string;
  label: string;
  kind: FieldKind;
  required: boolean;
  options?: string[];
  value: string | string[] | boolean;
  /** profile | qa_bank | saved | llm | user | file | rule */
  source: string;
  needsInput: boolean;
  needsReview: boolean;
  note?: string;
  /** Page of a multi-page form the field is on (0 = first). */
  step?: number;
  /** Heading of the form section holding the field (e.g. "XII Standard"). */
  section?: string;
}

export interface ApplicationDto {
  id: string;
  jobId: string;
  job?: { title: string; company: string; location: string; score?: number; url: string };
  channel: string;
  ats?: string;
  applyUrl: string;
  mode: string;
  status: ApplicationStatus;
  docId?: string;
  answers: ApplicationAnswerDto[];
  screenshots: Array<{ label: string; url: string; takenAt: string }>;
  attempts: number;
  error?: string;
  confirmation?: string;
  preparedAt?: string;
  approvedAt?: string;
  submittedAt?: string;
  updatedAt: string;
}

export const OUTREACH_STATUSES = [
  /** Written, waiting for your approval (approve mode). */
  'draft',
  /** Approved (or auto mode): will be sent at scheduledFor. */
  'scheduled',
  'sending',
  'sent',
  /** Would have been sent, but DRY_RUN=true. */
  'dry_run',
  'replied',
  'bounced',
  'failed',
  'skipped',
] as const;
export type OutreachStatus = (typeof OUTREACH_STATUSES)[number];

export interface OutreachDto {
  id: string;
  jobId: string;
  job?: { title: string; company: string; score?: number; url: string };
  email: string;
  contactName?: string;
  contactSource: 'job_post' | 'manual';
  type: 'cold_email' | 'follow_up';
  status: OutreachStatus;
  subject: string;
  body: string;
  edited: boolean;
  issues: string[];
  attachResume: boolean;
  scheduledFor?: string;
  sentAt?: string;
  repliedAt?: string;
  replySnippet?: string;
  error?: string;
  updatedAt: string;
}

export interface SourceRunDto {
  id: string;
  runId: string;
  source: SourceName;
  startedAt: string;
  finishedAt?: string;
  status: 'running' | 'ok' | 'failed' | 'skipped';
  fetched: number;
  inserted: number;
  duplicates: number;
  filtered: number;
  error?: string;
}

export interface StatsDto {
  byStatus: Record<string, number>;
  bySource: Record<string, number>;
  newToday: number;
  aboveMinScoreToday: number;
  llm: {
    callsToday: number;
    maxPerDay: number;
    inputTokensToday: number;
    outputTokensToday: number;
    mode: 'anthropic' | 'mock';
  };
  dryRun: boolean;
  lastRunAt?: string;
}
