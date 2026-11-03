import type { Job } from './models/job.js';
import type { JobScore } from './models/jobScore.js';
import type {
  ApplicationAnswerDto,
  ApplicationDto,
  JobDetailDto,
  JobDto,
  JobScoreDto,
  JobSourceName,
  TailoredDocDto,
  TailoredResumeDto,
} from './types.js';

type WithId<T> = T & { _id: { toString(): string } };

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : undefined);
const opt = <T>(v: T | null | undefined): T | undefined => (v === null ? undefined : v);

export function toJobDto(job: WithId<Job>): JobDto {
  return {
    id: job._id.toString(),
    source: job.source as JobSourceName,
    url: job.url,
    company: job.company,
    title: job.title,
    location: job.location ?? '',
    city: opt(job.city),
    country: opt(job.country),
    workMode: job.workMode ?? 'unknown',
    experienceMin: opt(job.experienceMin),
    experienceMax: opt(job.experienceMax),
    batchYears: job.batchYears ?? [],
    batchMatch: opt(job.batchMatch),
    salary:
      job.salary && (job.salary.min != null || job.salary.max != null)
        ? {
            min: opt(job.salary.min),
            max: opt(job.salary.max),
            currency: opt(job.salary.currency),
            period: opt(job.salary.period),
          }
        : undefined,
    descriptionQuality: job.descriptionQuality ?? 'none',
    postedAt: iso(job.postedAt),
    fetchedAt: iso(job.fetchedAt) ?? new Date(0).toISOString(),
    status: job.status,
    filterReason: opt(job.filterReason),
    score: opt(job.score),
    scoreConfidence: opt(job.scoreConfidence),
    notes: opt(job.notes),
    seenOn: (job.seenOn ?? []).map((s) => ({
      source: s.source as JobSourceName,
      sourceJobId: s.sourceJobId,
      url: s.url,
      seenAt: iso(s.seenAt) ?? '',
    })),
  };
}

export function toJobScoreDto(s: JobScore & { createdAt?: Date }): JobScoreDto {
  return {
    score: s.score,
    confidence: s.confidence,
    reasons: s.reasons ?? [],
    matchedSkills: s.matchedSkills ?? [],
    missingSkills: s.missingSkills ?? [],
    redFlags: s.redFlags ?? [],
    model: s.model,
    promptVersion: s.promptVersion,
    createdAt: iso(s.createdAt) ?? '',
  };
}

export function toJobDetailDto(
  job: WithId<Job>,
  score?: (JobScore & { createdAt?: Date }) | null,
): JobDetailDto {
  return {
    ...toJobDto(job),
    description: job.description ?? '',
    latestScore: score ? toJobScoreDto(score) : undefined,
  };
}

/** Shape of a TailoredDoc as read with .lean() (sub-documents flattened). */
interface TailoredDocLike {
  _id: { toString(): string };
  jobId: unknown;
  version: number;
  status: 'ready' | 'failed';
  resume?: unknown;
  coverLetter?: string | null;
  coverLetterEdited?: boolean | null;
  issues?: Array<{ kind?: string | null; message?: string | null }> | null;
  resumePdfPath?: string | null;
  notes?: string | null;
  model?: string | null;
  error?: string | null;
  trigger?: string | null;
  createdAt?: Date;
}

export function toTailoredDocDto(d: TailoredDocLike): TailoredDocDto {
  return {
    id: d._id.toString(),
    jobId: String(d.jobId),
    version: d.version,
    status: d.status,
    resume: (d.resume ?? undefined) as TailoredResumeDto | undefined,
    coverLetter: d.coverLetter ?? '',
    coverLetterEdited: Boolean(d.coverLetterEdited),
    issues: (d.issues ?? []).map((i) => ({ kind: i.kind ?? '', message: i.message ?? '' })),
    hasPdf: Boolean(d.resumePdfPath),
    notes: opt(d.notes),
    model: opt(d.model),
    error: opt(d.error),
    trigger: (d.trigger ?? 'manual') as TailoredDocDto['trigger'],
    createdAt: iso(d.createdAt) ?? '',
  };
}

/** Shape of an Application as read with .lean(). */
interface ApplicationLike {
  _id: { toString(): string };
  jobId: unknown;
  channel: string;
  ats?: string | null;
  applyUrl: string;
  mode: string;
  status: string;
  docId?: unknown;
  answers?: ReadonlyArray<object> | null;
  screenshots?: Array<{
    label?: string | null;
    path?: string | null;
    takenAt?: Date | null;
  }> | null;
  attempts?: number | null;
  error?: string | null;
  confirmation?: string | null;
  preparedAt?: Date | null;
  approvedAt?: Date | null;
  submittedAt?: Date | null;
  updatedAt?: Date;
}

export function toApplicationDto(
  a: ApplicationLike,
  job?: {
    title: string;
    company: string;
    location?: string | null;
    score?: number | null;
    url: string;
  } | null,
): ApplicationDto {
  const id = a._id.toString();
  return {
    id,
    jobId: String(a.jobId),
    job: job
      ? {
          title: job.title,
          company: job.company,
          location: job.location ?? '',
          score: opt(job.score),
          url: job.url,
        }
      : undefined,
    channel: a.channel,
    ats: opt(a.ats),
    applyUrl: a.applyUrl,
    mode: a.mode,
    status: a.status as ApplicationDto['status'],
    docId: a.docId ? String(a.docId) : undefined,
    answers: (a.answers ?? []).map((raw) => {
      const x = raw as Record<string, unknown>;
      return {
        key: String(x.key),
        label: String(x.label ?? ''),
        kind: x.kind as ApplicationAnswerDto['kind'],
        required: Boolean(x.required),
        options: (x.options as string[] | undefined) ?? undefined,
        value: (x.value ?? '') as ApplicationAnswerDto['value'],
        source: String(x.source ?? ''),
        needsInput: Boolean(x.needsInput),
        needsReview: Boolean(x.needsReview),
        step: typeof x.step === 'number' ? x.step : undefined,
        section: (x.section as string | undefined) || undefined,
        note: (x.note as string | undefined) ?? undefined,
      };
    }),
    screenshots: (a.screenshots ?? []).map((s, i) => ({
      label: s.label ?? '',
      url: `/api/applications/${id}/screenshots/${i}`,
      takenAt: iso(s.takenAt) ?? '',
    })),
    attempts: a.attempts ?? 0,
    error: opt(a.error),
    confirmation: opt(a.confirmation),
    preparedAt: iso(a.preparedAt),
    approvedAt: iso(a.approvedAt),
    submittedAt: iso(a.submittedAt),
    updatedAt: iso(a.updatedAt) ?? '',
  };
}
