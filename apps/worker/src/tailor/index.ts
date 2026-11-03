import path from 'node:path';
import {
  allSkills,
  appHome,
  getSettings,
  JobModel,
  llmEnabled,
  loadProfile,
  logger,
  startOfToday,
  TailoredDocModel,
} from '@ja/shared';
import { LlmBudgetExceededError } from '../llm/client.js';
import { buildVocabulary } from './claims.js';
import { writeCoverLetter } from './coverLetter.js';
import { renderPdf, renderResumeHtml } from './render.js';
import { TAILOR_PROMPT_VERSION, tailorResume, type Issue } from './resume.js';

export type TailorTrigger = 'auto' | 'manual' | 'shortlist';

export const resumePdfPath = (jobId: string, version: number) =>
  path.join(appHome(), 'output', 'resumes', jobId, `v${version}.pdf`);

/**
 * Generates a tailored resume (JSON + PDF) and cover letter for one job and stores them as a new
 * TailoredDoc version. LLM budget/API errors propagate (the caller retries later); unusable model
 * output is stored as a failed version so the dashboard can show what happened.
 */
export async function tailorJob(
  jobId: string,
  trigger: TailorTrigger,
): Promise<{ docId: string; status: 'ready' | 'failed' }> {
  if (!llmEnabled())
    throw new Error(
      'Generating resumes needs ANTHROPIC_API_KEY (LLM_MOCK is on or the key is missing)',
    );
  const job = await JobModel.findById(jobId).lean();
  if (!job) throw new Error(`job ${jobId} not found`);
  const profile = loadProfile().data;
  const vocab = buildVocabulary(allSkills(profile));
  const input = {
    title: job.title,
    company: job.company,
    location: job.location ?? '',
    description: job.description ?? '',
  };
  const last = await TailoredDocModel.findOne({ jobId: job._id }).sort({ version: -1 }).lean();
  const version = (last?.version ?? 0) + 1;

  try {
    const resume = await tailorResume(profile, input, vocab);
    const letter = await writeCoverLetter(profile, input, vocab);
    const issues: Issue[] = [...resume.issues, ...letter.issues];

    let pdfPath: string | undefined = resumePdfPath(String(job._id), version);
    try {
      await renderPdf(renderResumeHtml(resume.resume), pdfPath);
    } catch (err) {
      issues.push({ kind: 'pdf', message: `PDF not created: ${(err as Error).message}` });
      pdfPath = undefined;
    }

    const doc = await TailoredDocModel.create({
      jobId: job._id,
      version,
      status: 'ready',
      resume: resume.resume,
      coverLetter: letter.text,
      issues,
      resumePdfPath: pdfPath,
      notes: resume.notes,
      model: resume.model,
      promptVersion: TAILOR_PROMPT_VERSION,
      trigger,
    });
    logger.info({ jobId, version, issues: issues.length }, 'application kit generated');
    return { docId: String(doc._id), status: 'ready' };
  } catch (err) {
    if (err instanceof LlmBudgetExceededError || (err as { status?: number }).status) throw err;
    const doc = await TailoredDocModel.create({
      jobId: job._id,
      version,
      status: 'failed',
      error: (err as Error).message,
      promptVersion: TAILOR_PROMPT_VERSION,
      trigger,
    });
    logger.warn({ jobId, err: (err as Error).message }, 'application kit failed');
    return { docId: String(doc._id), status: 'failed' };
  }
}

export interface AutoTailorSummary {
  generated: number;
  failed: number;
  stoppedReason?: string;
}

const AUTO_LOOKBACK_DAYS = 7;

/** Generates kits for the best recent jobs above the threshold, within today's automatic limit. */
export async function autoTailor(): Promise<AutoTailorSummary> {
  const summary: AutoTailorSummary = { generated: 0, failed: 0 };
  const { tailoring, killSwitch } = await getSettings();
  if (killSwitch || !tailoring.auto || tailoring.dailyLimit <= 0) return summary;
  if (!llmEnabled()) return { ...summary, stoppedReason: 'needs ANTHROPIC_API_KEY (mock mode)' };

  const doneToday = await TailoredDocModel.countDocuments({
    trigger: 'auto',
    createdAt: { $gte: startOfToday() },
  });
  let remaining = tailoring.dailyLimit - doneToday;
  if (remaining <= 0) return summary;

  const since = new Date(Date.now() - AUTO_LOOKBACK_DAYS * 86_400_000);
  const candidates = await JobModel.find(
    {
      status: { $in: ['scored', 'shortlisted'] },
      score: { $gte: tailoring.minScore },
      fetchedAt: { $gte: since },
    },
    { _id: 1 },
  )
    .sort({ score: -1, postedAt: -1 })
    .limit(remaining * 4)
    .lean();
  const already = new Set(
    (
      await TailoredDocModel.distinct('jobId', { jobId: { $in: candidates.map((c) => c._id) } })
    ).map(String),
  );

  for (const c of candidates) {
    if (remaining <= 0) break;
    if (already.has(String(c._id))) continue;
    try {
      const r = await tailorJob(String(c._id), 'auto');
      if (r.status === 'ready') summary.generated++;
      else summary.failed++;
      remaining--;
    } catch (err) {
      summary.stoppedReason = (err as Error).message;
      break;
    }
  }
  return summary;
}
