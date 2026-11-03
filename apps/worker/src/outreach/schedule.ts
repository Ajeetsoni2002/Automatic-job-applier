import { dayKey, getEnv } from '@ja/shared';

/** Emails go out on weekdays, 09:30–18:30 in the app timezone, like a person sending them. */
const WINDOW_START_MIN = 9 * 60 + 30;
const WINDOW_END_MIN = 18 * 60 + 30;
const MIN_GAP_MIN = 3;
const MAX_GAP_MIN = 8;

function local(d: Date, tz: string): { weekday: number; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { weekday, minutes: (Number(get('hour')) % 24) * 60 + Number(get('minute')) };
}

export function inSendWindow(d: Date, tz: string = getEnv().TZ): boolean {
  const { weekday, minutes } = local(d, tz);
  return weekday >= 1 && weekday <= 5 && minutes >= WINDOW_START_MIN && minutes < WINDOW_END_MIN;
}

/** The first moment at or after `d` that is inside the sending window (15-minute steps). */
export function nextWindowStart(d: Date, tz: string = getEnv().TZ): Date {
  let t = new Date(d.getTime());
  for (let i = 0; i < 7 * 24 * 4 && !inSendWindow(t, tz); i++)
    t = new Date(t.getTime() + 15 * 60_000);
  return t;
}

const randomMinutes = (min: number, max: number, random: () => number) =>
  (min + random() * (max - min)) * 60_000;

/**
 * Picks the send time for the next email: a few random minutes after the last planned one,
 * inside the window, and on a day that still has room under the daily limit.
 * `planned` = send times already taken (sent today and scheduled).
 */
export function nextSendSlot(
  now: Date,
  planned: Date[],
  dailyLimit: number,
  tz: string = getEnv().TZ,
  random: () => number = Math.random,
): Date {
  const last = planned.reduce((m, d) => (d > m ? d : m), new Date(0));
  let t = new Date(
    Math.max(now.getTime(), last.getTime() + randomMinutes(MIN_GAP_MIN, MAX_GAP_MIN, random)),
  );
  for (let guard = 0; guard < 30; guard++) {
    if (!inSendWindow(t, tz))
      t = new Date(nextWindowStart(t, tz).getTime() + randomMinutes(0, 20, random));
    const day = dayKey(t, tz);
    const used = planned.filter((p) => dayKey(p, tz) === day).length;
    if (used < dailyLimit) return t;
    // Day is full: jump past the window end so the next window (next weekday) is chosen.
    const { minutes } = local(t, tz);
    t = new Date(t.getTime() + (WINDOW_END_MIN - minutes + 1) * 60_000);
  }
  return t;
}
