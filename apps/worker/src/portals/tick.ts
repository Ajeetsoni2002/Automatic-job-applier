// Every few minutes: starts the next LinkedIn / Naukri application, one at a time per site,
// spaced out by random gaps, within the daily limit and daytime hours, never while paused.
import {
  ApplicationModel,
  getEnv,
  getSettings,
  JobModel,
  logger,
  PortalModel,
  startOfToday,
  TaskModel,
  type PortalName,
} from '@ja/shared';
import { portalsUnavailable } from './session.js';

const MIN_GAP_MIN = 6;
const MAX_GAP_MIN = 15;
const START_MIN = 9 * 60 + 30;
const END_MIN = 20 * 60;
const MAX_POSTING_AGE_DAYS = 21;
/** Approve mode: at most this many prepared applications waiting for you per site. */
const MAX_WAITING = 5;

function localMinutes(d: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return (get('hour') % 24) * 60 + get('minute');
}

export function inPortalHours(d: Date, tz: string = getEnv().TZ): boolean {
  const m = localMinutes(d, tz);
  return m >= START_MIN && m < END_MIN;
}

/** Jobs this site can apply to, best first: scored above your minimum and not handled yet. */
export function portalJobFilter(name: PortalName, minScore: number, now = new Date()) {
  const where =
    name === 'linkedin'
      ? {
          $or: [
            { url: { $regex: 'linkedin\\.com/jobs/view/' } },
            { 'seenOn.url': { $regex: 'linkedin\\.com/jobs/view/' } },
          ],
        }
      : { $or: [{ source: 'naukri' }, { 'seenOn.source': 'naukri' }] };
  return {
    ...where,
    status: { $in: ['scored', 'shortlisted'] },
    score: { $gte: minScore },
    $and: [
      {
        $or: [
          { postedAt: { $gte: new Date(now.getTime() - MAX_POSTING_AGE_DAYS * 86_400_000) } },
          { postedAt: null },
        ],
      },
    ],
  };
}

/** The job's address on that site (it may have been found on another source first). */
export function portalUrl(
  name: PortalName,
  job: { url: string; source: string; seenOn?: Array<{ source: string; url: string }> },
): string | undefined {
  const all = [{ source: job.source, url: job.url }, ...(job.seenOn ?? [])];
  const hit =
    name === 'linkedin'
      ? all.find((s) => /linkedin\.com\/jobs\/view\//.test(s.url))
      : all.find((s) => s.source === 'naukri' || /naukri\.com\/job-listings/.test(s.url));
  return hit?.url.split('?')[0];
}

export async function portalTick(
  now = new Date(),
  random: () => number = Math.random,
): Promise<string[]> {
  const started: string[] = [];
  if (portalsUnavailable()) return started;
  const settings = await getSettings();
  if (settings.killSwitch || !inPortalHours(now)) return started;

  for (const name of ['linkedin', 'naukri'] as const) {
    const channel = settings.channels[name];
    if (!channel || channel.mode === 'off' || channel.mode === 'assist') continue;
    const portal = await PortalModel.findOne({ name }).lean();
    if (!portal?.connected) continue;
    if (portal.pausedUntil && portal.pausedUntil > now) continue;
    if (portal.nextAt && portal.nextAt > now) continue;
    // One application at a time per site (they share one browser profile).
    const busy = await TaskModel.exists({
      type: { $in: ['portal_apply', 'portal_connect'] },
      status: { $in: ['pending', 'running'] },
    });
    if (busy) break;
    const today = await ApplicationModel.countDocuments({
      channel: name,
      status: 'submitted',
      submittedAt: { $gte: startOfToday() },
    });
    if (today >= channel.dailyLimit) continue;
    const auto = channel.mode === 'auto';
    if (
      !auto &&
      (await ApplicationModel.countDocuments({
        channel: name,
        status: { $in: ['ready', 'needs_input'] },
      })) >= MAX_WAITING
    )
      continue;

    const handled = await ApplicationModel.distinct('jobId');
    const job = await JobModel.findOne(
      { ...portalJobFilter(name, settings.minScore, now), _id: { $nin: handled } },
      { url: 1, source: 1, seenOn: 1, title: 1, company: 1 },
    )
      .sort({ score: -1, postedAt: -1 })
      .lean();
    if (!job) continue;
    const url = portalUrl(name, job);
    if (!url) continue;

    const app = await ApplicationModel.create({
      jobId: job._id,
      channel: name,
      ats: name,
      applyUrl: url,
      mode: auto ? 'auto' : 'approve',
      status: 'preparing',
      error: 'Waiting for the worker…',
    });
    await TaskModel.create({
      type: 'portal_apply',
      payload: { appId: String(app._id), submit: auto },
      maxAttempts: 1,
    });
    const gap = (MIN_GAP_MIN + random() * (MAX_GAP_MIN - MIN_GAP_MIN)) * 60_000;
    await PortalModel.updateOne({ name }, { $set: { nextAt: new Date(now.getTime() + gap) } });
    logger.info(
      { portal: name, job: `${job.title} — ${job.company}`, auto },
      'portal application queued',
    );
    started.push(`${name}:${String(app._id)}`);
    break; // one site per tick keeps the pace human
  }
  return started;
}
