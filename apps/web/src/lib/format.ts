const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

export function timeAgo(iso?: string): string {
  if (!iso) return '—';
  const diff = (new Date(iso).getTime() - Date.now()) / 1000;
  const abs = Math.abs(diff);
  if (abs < 60) return 'just now';
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  return rtf.format(Math.round(diff / 86400), 'day');
}

export function dateTime(iso?: string): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
}

export function salaryText(s?: {
  min?: number;
  max?: number;
  currency?: string;
  period?: string;
}): string | undefined {
  if (!s || (s.min == null && s.max == null)) return undefined;
  const fmt = (n?: number) => {
    if (n == null) return '?';
    if (s.currency === 'INR' && (s.period ?? 'year') === 'year')
      return `${(n / 100_000).toFixed(1)}L`;
    return n.toLocaleString('en-IN');
  };
  return `${s.currency ?? ''} ${fmt(s.min)}–${fmt(s.max)} / ${s.period ?? 'year'}`.trim();
}

export const STATUS_LABEL: Record<string, string> = {
  new: 'Not scored',
  filtered_out: 'Filtered out',
  scored: 'Scored',
  score_failed: 'Score failed',
  shortlisted: 'Shortlisted',
  ignored: 'Ignored',
  applied_manually: 'Applied',
  queued: 'Queued',
};
