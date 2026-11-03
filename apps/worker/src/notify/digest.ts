import {
  ApplicationModel,
  dayKey,
  getSettings,
  JobModel,
  LlmUsageModel,
  logger,
  OutreachModel,
  SourceRunModel,
  TailoredDocModel,
} from '@ja/shared';
import { escapeHtml, sendTelegram } from './telegram.js';

const TOP_N = 10;

export async function buildDigest(now = new Date()): Promise<string> {
  const settings = await getSettings();
  const since = new Date(now.getTime() - 24 * 3_600_000);

  const [top, newBySource, filtered, pending, failures, usage] = await Promise.all([
    JobModel.find({
      scoredAt: { $gte: since },
      score: { $gte: settings.minScore },
      status: { $in: ['scored', 'shortlisted'] },
    })
      .sort({ score: -1 })
      .limit(TOP_N)
      .lean(),
    JobModel.aggregate<{ _id: string; n: number }>([
      { $match: { fetchedAt: { $gte: since } } },
      { $group: { _id: '$source', n: { $sum: 1 } } },
      { $sort: { n: -1 } },
    ]),
    JobModel.countDocuments({ fetchedAt: { $gte: since }, status: 'filtered_out' }),
    JobModel.countDocuments({ status: 'new' }),
    SourceRunModel.find({ startedAt: { $gte: since }, status: 'failed' })
      .sort({ startedAt: -1 })
      .limit(5)
      .lean(),
    LlmUsageModel.find({ date: { $in: [dayKey(since), dayKey(now)] } }).lean(),
  ]);
  const aboveMin = await JobModel.countDocuments({
    scoredAt: { $gte: since },
    score: { $gte: settings.minScore },
    status: { $in: ['scored', 'shortlisted'] },
  });

  const lines: string[] = [`<b>Job Autopilot — daily digest</b>`, ''];

  lines.push(`<b>${aboveMin}</b> new job(s) scored ≥ ${settings.minScore} in the last 24h`);
  for (const j of top) {
    const conf =
      j.scoreConfidence && j.scoreConfidence !== 'high' ? ` (${j.scoreConfidence} conf.)` : '';
    lines.push(
      `• <b>${j.score}</b>${conf} <a href="${escapeHtml(j.url)}">${escapeHtml(j.title)}</a> — ${escapeHtml(j.company)}` +
        (j.location ? `, ${escapeHtml(j.location)}` : ''),
    );
  }
  if (aboveMin > top.length) lines.push(`…and ${aboveMin - top.length} more in the dashboard`);

  lines.push('');
  const total = newBySource.reduce((s, r) => s + r.n, 0);
  lines.push(
    `${total} new job(s) collected` +
      (total ? `: ${newBySource.map((r) => `${r._id} ${r.n}`).join(', ')}` : ''),
  );
  lines.push(`Filtered out: ${filtered} · Waiting to be scored: ${pending}`);

  const calls = usage.reduce((s, u) => s + (u.calls ?? 0), 0);
  const tokens = usage.reduce((s, u) => s + (u.inputTokens ?? 0) + (u.outputTokens ?? 0), 0);
  lines.push(`LLM: ${calls} call(s), ${tokens.toLocaleString('en-IN')} tokens (yesterday + today)`);

  if (failures.length) {
    lines.push('', '<b>Source failures</b>');
    for (const f of failures)
      lines.push(`• ${f.source}: ${escapeHtml((f.error ?? 'unknown error').slice(0, 200))}`);
  }
  const [applied, waiting, kits] = await Promise.all([
    ApplicationModel.countDocuments({ status: 'submitted', submittedAt: { $gte: since } }),
    ApplicationModel.countDocuments({
      status: { $in: ['needs_input', 'ready', 'dry_run', 'needs_manual', 'failed'] },
    }),
    TailoredDocModel.countDocuments({ status: 'ready', createdAt: { $gte: since } }),
  ]);
  if (applied || waiting || kits)
    lines.push(
      '',
      `Applications: ${applied} submitted · ${waiting} waiting for you (dashboard → Applications) · ${kits} new resume kit(s)`,
    );

  const [emailsSent, replies, drafts] = await Promise.all([
    OutreachModel.countDocuments({ status: 'sent', sentAt: { $gte: since } }),
    OutreachModel.countDocuments({ status: 'replied', repliedAt: { $gte: since } }),
    OutreachModel.countDocuments({ status: { $in: ['draft', 'failed'] } }),
  ]);
  if (emailsSent || replies || drafts)
    lines.push(
      `Emails: ${emailsSent} sent · ${replies} repl${replies === 1 ? 'y' : 'ies'} · ${drafts} draft(s) waiting for you (dashboard → Outreach)`,
    );

  if (settings.killSwitch) lines.push('', '⚠️ Kill switch is ON — pipeline is paused.');
  return lines.join('\n');
}

export async function sendDigest(): Promise<boolean> {
  const settings = await getSettings();
  if (!settings.digest.enabled) {
    logger.info('digest disabled in settings');
    return false;
  }
  await sendTelegram(await buildDigest());
  logger.info('digest sent');
  return true;
}
