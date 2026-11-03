import { getEnv } from './env.js';

/** YYYY-MM-DD for the given instant in the app timezone. */
export function dayKey(date: Date = new Date(), tz: string = getEnv().TZ): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/** Start of "today" in the app timezone, as a UTC Date. */
export function startOfToday(tz: string = getEnv().TZ, now: Date = new Date()): Date {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const elapsedMs =
    (((get('hour') % 24) * 60 + get('minute')) * 60 + get('second')) * 1000 + now.getMilliseconds();
  return new Date(now.getTime() - elapsedMs);
}
