import { htmlToText } from '../text.js';
import type { JobSource, RawJob } from './types.js';

// API docs: https://remotive.com/api-documentation — they ask clients not to poll more than a
// few times a day, and to link back to the job URL (we keep the original URL).
interface RemotiveResponse {
  jobs: Array<{
    id: number;
    url: string;
    title: string;
    company_name: string;
    category?: string;
    job_type?: string;
    publication_date?: string;
    candidate_required_location?: string;
    salary?: string;
    description?: string;
  }>;
}

export const remotiveSource: JobSource = {
  name: 'remotive',
  minIntervalHours: 6,
  unavailableReason: () => undefined,
  async fetch(ctx) {
    const res = await ctx.http.getJson<RemotiveResponse>(
      'https://remotive.com/api/remote-jobs?category=software-dev',
    );
    const jobs: RawJob[] = (res.jobs ?? []).map((j) => ({
      source: 'remotive',
      sourceJobId: String(j.id),
      url: j.url,
      company: j.company_name,
      title: j.title,
      location: j.candidate_required_location || 'Worldwide',
      workModeHint: 'remote',
      description: htmlToText(j.description),
      postedAt: j.publication_date ? new Date(j.publication_date) : undefined,
    }));
    return { jobs, warnings: [] };
  },
};
