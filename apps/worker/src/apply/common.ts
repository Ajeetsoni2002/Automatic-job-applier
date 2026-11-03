import fs from 'node:fs';
import path from 'node:path';
import { appHome, logger, TailoredDocModel } from '@ja/shared';
import { sendTelegram, telegramConfigured } from '../notify/telegram.js';
import { renderCoverLetterHtml, renderPdf } from '../tailor/render.js';
import type { FillFiles } from './types.js';

export const appDir = (appId: string) => path.join(appHome(), 'output', 'applications', appId);

export async function notify(html: string) {
  if (telegramConfigured())
    await sendTelegram(html).catch((err) => logger.warn({ err: err.message }, 'telegram failed'));
}

/**
 * Files to upload: the latest kit's resume PDF, and the cover letter as text and as a PDF.
 * `anyJob`: when this job has no kit, use the most recent resume made for another job (the
 * resume only: that job's cover letter is about a different company).
 */
export async function filesFor(jobId: string, appId: string, opts: { anyJob?: boolean } = {}) {
  let doc = await TailoredDocModel.findOne({ jobId, status: 'ready' }).sort({ version: -1 }).lean();
  let borrowed = false;
  if (!doc && opts.anyJob) {
    doc = await TailoredDocModel.findOne({ status: 'ready', resumePdfPath: { $ne: null } })
      .sort({ createdAt: -1 })
      .lean();
    borrowed = Boolean(doc);
  }
  if (!doc) return { doc: null, files: {} as FillFiles };
  // Recruiters see the uploaded file name: use "Firstname_Lastname_Resume.pdf", not "v1.pdf".
  const name = (doc.resume as { name?: string } | undefined)?.name ?? '';
  const base = name.trim().replace(/[^A-Za-z0-9]+/g, '_') || 'Candidate';
  fs.mkdirSync(appDir(appId), { recursive: true });
  let resumePdf: string | undefined;
  if (doc.resumePdfPath && fs.existsSync(doc.resumePdfPath)) {
    resumePdf = path.join(appDir(appId), `${base}_Resume.pdf`);
    fs.copyFileSync(doc.resumePdfPath, resumePdf);
  }
  let coverLetterPdf: string | undefined;
  if (doc.coverLetter && !borrowed) {
    coverLetterPdf = path.join(appDir(appId), `${base}_Cover_Letter.pdf`);
    await renderPdf(renderCoverLetterHtml(name, doc.coverLetter), coverLetterPdf).catch(() => {
      coverLetterPdf = undefined;
    });
  }
  return {
    doc,
    borrowed,
    files: {
      resumePdf,
      coverLetterPdf,
      coverLetterText: (!borrowed && doc.coverLetter) || undefined,
    },
  };
}
