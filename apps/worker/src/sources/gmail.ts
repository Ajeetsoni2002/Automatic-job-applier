import { ProcessedEmailModel } from '@ja/shared';
import { gmailConfigured } from '../gmail/auth.js';
import { createGmailReader, type GmailReader } from '../gmail/client.js';
import { createImapReader, imapConfigured } from '../gmail/imap.js';
import { genericParser } from '../gmail/parsers/generic.js';
import { SITE_PARSERS } from '../gmail/parsers/sites.js';
import type { AlertParser } from '../gmail/parsers/common.js';
import type { JobSource, RawJob, SourceContext, SourceResult } from './types.js';

const MAX_MESSAGES_PER_RUN = 100;

function pickParser(from: string, subject: string): AlertParser {
  return SITE_PARSERS.find((p) => p.matches(from, subject)) ?? genericParser;
}

/**
 * Reads job-alert emails (labelled GMAIL_ALERT_LABEL) and turns each listed job into a RawJob.
 * Never opens the job pages themselves, so no LinkedIn/Naukri scraping happens.
 */
export async function fetchGmailAlerts(
  ctx: SourceContext,
  reader: GmailReader,
): Promise<SourceResult> {
  const { env } = ctx;
  const label = env.GMAIL_ALERT_LABEL.replace(/"/g, '');
  const query = `label:"${label}" newer_than:${env.GMAIL_LOOKBACK_DAYS}d`;
  const ids = await reader.listMessageIds(query, MAX_MESSAGES_PER_RUN);

  const done = new Set(
    (
      await ProcessedEmailModel.find({ gmailMessageId: { $in: ids } }, { gmailMessageId: 1 }).lean()
    ).map((d) => d.gmailMessageId),
  );

  const jobs: RawJob[] = [];
  const warnings: string[] = [];
  const processed: Array<{
    gmailMessageId: string;
    sender: string;
    subject: string;
    parser: string;
    parsedJobs: number;
  }> = [];

  for (const id of ids.filter((i) => !done.has(i))) {
    try {
      const msg = await reader.getMessage(id);
      const parser = pickParser(msg.from, msg.subject);
      const found = await parser.parse(msg.html, msg.text);
      for (const j of found) {
        jobs.push({
          source: 'gmail',
          sourceJobId: j.key,
          url: j.url,
          company: j.company,
          title: j.title,
          location: j.location,
          // Naukri and Indeed India alerts only list Indian jobs.
          countryHint: /^(naukri|indeed):/.test(j.key) ? 'IN' : undefined,
          description: '',
          postedAt: msg.date,
        });
      }
      if (found.length === 0) warnings.push(`no jobs found in "${msg.subject}" (${parser.name})`);
      processed.push({
        gmailMessageId: id,
        sender: msg.from,
        subject: msg.subject,
        parser: parser.name,
        parsedJobs: found.length,
      });
    } catch (err) {
      // Leave unprocessed so the next run retries it.
      warnings.push(`message ${id}: ${(err as Error).message}`);
    }
  }

  return {
    jobs,
    warnings,
    // Marked processed only after the pipeline has stored the jobs.
    onCommitted: async () => {
      if (processed.length)
        await ProcessedEmailModel.insertMany(processed, { ordered: false }).catch(() => undefined);
    },
  };
}

export const gmailSource: JobSource = {
  name: 'gmail',
  minIntervalHours: 0,
  // IMAP (App Password) wins when configured; otherwise the Gmail API with an OAuth token.
  unavailableReason: () =>
    imapConfigured()
      ? undefined
      : gmailConfigured() &&
        'Gmail not connected: set GMAIL_IMAP_USER + GMAIL_IMAP_APP_PASSWORD, or run npm run gmail:auth',
  async fetch(ctx) {
    const reader = imapConfigured() ? await createImapReader() : createGmailReader();
    try {
      return await fetchGmailAlerts(ctx, reader);
    } finally {
      await reader.close?.();
    }
  },
};
