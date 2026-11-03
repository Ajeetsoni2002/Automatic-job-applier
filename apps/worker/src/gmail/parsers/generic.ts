import crypto from 'node:crypto';
import { convert } from 'html-to-text';
import { z } from 'zod';
import { getEnv, llmEnabled } from '@ja/shared';
import { structuredCall } from '../../llm/client.js';
import type { AlertJob, AlertParser } from './common.js';

const ExtractSchema = z.object({
  jobs: z.array(
    z.object({
      title: z.string(),
      company: z.string(),
      location: z.string(),
      url: z.string().describe('The job link exactly as it appears in the email'),
    }),
  ),
});

const SYSTEM = `You extract job postings from job-alert emails. Return every distinct job listed in the email with its title, company, location and link.
Rules: copy values exactly as written; use "" for anything not present; ignore ads, newsletters, and links that are not individual job postings. Return an empty list if the email contains no job postings.`;

/**
 * Fallback for alert emails from senders without a dedicated parser (Instahyre, Foundit, Wellfound, ...).
 * Uses the fast LLM when available; otherwise the email is skipped and counted as unparsed.
 */
export const genericParser: AlertParser = {
  name: 'generic-llm',
  matches: () => true,
  async parse(html, text) {
    if (!llmEnabled()) return [];
    const body = (
      html
        ? convert(html, { wordwrap: false, selectors: [{ selector: 'img', format: 'skip' }] })
        : text
    ).slice(0, 15_000);
    if (!body.trim()) return [];
    const out = await structuredCall({
      purpose: 'gmail_extract',
      model: getEnv().LLM_MODEL_FAST,
      system: SYSTEM,
      user: `Email content:\n\n${body}`,
      schema: ExtractSchema,
      maxTokens: 4096,
    });
    return out.jobs
      .filter((j) => j.title.trim() && /^https?:\/\//.test(j.url))
      .map((j): AlertJob => ({
        key: `generic:${crypto.createHash('sha1').update(j.url).digest('hex').slice(0, 16)}`,
        title: j.title.trim(),
        company: j.company.trim() || 'Unknown',
        location: j.location.trim(),
        url: j.url.trim(),
      }));
  },
};
