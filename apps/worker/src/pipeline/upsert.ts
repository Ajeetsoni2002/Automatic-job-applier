import { JobModel } from '@ja/shared';
import type { FilterResult } from './filter.js';
import type { NormalizedJob } from './normalize.js';

export type UpsertOutcome = 'inserted' | 'filtered' | 'duplicate';

const QUALITY_RANK = { none: 0, truncated: 1, full: 2 } as const;

const isDuplicateKeyError = (err: unknown) => (err as { code?: number })?.code === 11000;

/**
 * Stores a normalized job exactly once.
 * - Same (source, sourceJobId) seen before -> only lastSeenAt is refreshed.
 * - Same dedupeHash from another source -> appended to seenOn; a better description replaces a
 *   worse one, and an already-scored job is queued for rescoring with the richer text.
 * - Otherwise inserted as `new` (passed filters) or `filtered_out` (with the reason).
 */
export async function upsertJob(
  job: NormalizedJob,
  filter: FilterResult,
  now = new Date(),
): Promise<UpsertOutcome> {
  const seenEntry = { source: job.source, sourceJobId: job.sourceJobId, url: job.url, seenAt: now };

  const same = await JobModel.findOneAndUpdate(
    { source: job.source, sourceJobId: job.sourceJobId },
    { $set: { lastSeenAt: now } },
    { projection: { _id: 1 } },
  );
  if (same) return 'duplicate';

  const twin = await JobModel.findOne(
    { dedupeHash: job.dedupeHash },
    { _id: 1, seenOn: 1, descriptionQuality: 1, status: 1 },
  ).lean();
  if (twin) {
    const update: Record<string, unknown> = { $set: { lastSeenAt: now } };
    const alreadySeen = twin.seenOn?.some(
      (s) => s.source === job.source && s.sourceJobId === job.sourceJobId,
    );
    if (!alreadySeen) update.$push = { seenOn: seenEntry };
    if (QUALITY_RANK[job.descriptionQuality] > QUALITY_RANK[twin.descriptionQuality ?? 'none']) {
      Object.assign(update.$set as object, {
        description: job.description,
        descriptionQuality: job.descriptionQuality,
        ...(job.experienceMin != null && {
          experienceMin: job.experienceMin,
          experienceMax: job.experienceMax,
        }),
        ...(job.batchYears.length && { batchYears: job.batchYears, batchMatch: job.batchMatch }),
        ...(['scored', 'score_failed'].includes(twin.status) && { status: 'new' }),
      });
    }
    await JobModel.updateOne({ _id: twin._id }, update);
    return 'duplicate';
  }

  try {
    await JobModel.create({
      ...job,
      fetchedAt: now,
      lastSeenAt: now,
      seenOn: [seenEntry],
      status: filter.pass ? 'new' : 'filtered_out',
      filterReason: filter.pass ? undefined : filter.reason,
    });
  } catch (err) {
    if (isDuplicateKeyError(err)) return 'duplicate'; // concurrent insert of the same job
    throw err;
  }
  return filter.pass ? 'inserted' : 'filtered';
}
