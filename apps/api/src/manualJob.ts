import crypto from 'node:crypto';
import { JobModel } from '@ja/shared';

const norm = (s: string, keep: RegExp) =>
  s.toLowerCase().replace(keep, ' ').replace(/\s+/g, ' ').trim();

/** Stores a job you brought in yourself (a pasted link, a recruiter's email) as a `manual` job. */
export async function createManualJob(j: {
  company: string;
  title: string;
  url: string;
  location?: string;
  description?: string;
}) {
  const id = crypto.randomUUID();
  const description = j.description ?? '';
  return JobModel.create({
    source: 'manual',
    sourceJobId: id,
    url: j.url,
    canonicalUrl: j.url,
    company: j.company,
    companyNorm: norm(j.company, /[^a-z0-9 ]+/g),
    title: j.title,
    titleNorm: norm(j.title, /[^a-z0-9+# ]+/g),
    location: j.location ?? '',
    description,
    descriptionQuality: description.length >= 400 ? 'full' : description ? 'truncated' : 'none',
    dedupeHash: crypto.createHash('sha1').update(`manual|${id}`).digest('hex'),
    seenOn: [{ source: 'manual', sourceJobId: id, url: j.url, seenAt: new Date() }],
    status: 'shortlisted',
  });
}
