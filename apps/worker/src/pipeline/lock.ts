import crypto from 'node:crypto';
import { LockModel } from '@ja/shared';

/**
 * Mongo-backed mutex. Returns a release function, or null if another holder has an unexpired lock.
 * The TTL protects against a crashed holder keeping the lock forever.
 */
export async function acquireLock(
  name: string,
  ttlMs: number,
): Promise<(() => Promise<void>) | null> {
  const owner = crypto.randomUUID();
  const now = new Date();
  try {
    await LockModel.findOneAndUpdate(
      { name, expiresAt: { $lt: now } },
      { $set: { owner, expiresAt: new Date(now.getTime() + ttlMs) } },
      { upsert: true },
    );
  } catch (err) {
    if ((err as { code?: number }).code === 11000) return null; // live lock held by someone else
    throw err;
  }
  return async () => {
    await LockModel.deleteOne({ name, owner });
  };
}
