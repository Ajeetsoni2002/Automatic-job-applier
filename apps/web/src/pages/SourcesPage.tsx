import { useQuery } from '@tanstack/react-query';
import { SOURCE_NAMES, type SourceRunDto } from '@ja/shared/types';
import { Badge, Card, Empty, ErrorNote } from '../components/ui';
import { api } from '../lib/api';
import { dateTime, timeAgo } from '../lib/format';

const TONE = { ok: 'green', failed: 'red', skipped: 'slate', running: 'indigo' } as const;

export function SourcesPage() {
  const runs = useQuery({
    queryKey: ['source-runs'],
    queryFn: () => api.sourceRuns(120),
    refetchInterval: 30_000,
  });
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  const latest = new Map<string, SourceRunDto>();
  for (const r of runs.data ?? []) if (!latest.has(r.source)) latest.set(r.source, r);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold">Source health</h1>
        <p className="text-sm text-slate-500">
          Latest run per source. A failing source never stops the others.
        </p>
      </div>
      <ErrorNote error={runs.error} />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {SOURCE_NAMES.map((name) => {
          const r = latest.get(name);
          const enabled = settings.data?.sources[name] ?? true;
          return (
            <Card key={name} className="space-y-2 p-4">
              <div className="flex items-center justify-between">
                <span className="font-medium">{name}</span>
                {!enabled ? (
                  <Badge>disabled</Badge>
                ) : r ? (
                  <Badge tone={TONE[r.status]}>{r.status}</Badge>
                ) : (
                  <Badge>never run</Badge>
                )}
              </div>
              {r && (
                <>
                  <p className="text-xs text-slate-500" title={dateTime(r.startedAt)}>
                    {timeAgo(r.startedAt)}
                  </p>
                  {r.status !== 'skipped' && (
                    <p className="text-sm tabular-nums">
                      {r.fetched} fetched · {r.inserted} new · {r.filtered} filtered ·{' '}
                      {r.duplicates} dup
                    </p>
                  )}
                  {r.error && (
                    <p
                      className={`text-xs ${r.status === 'failed' ? 'text-rose-600' : 'text-slate-500'}`}
                    >
                      {r.error}
                    </p>
                  )}
                </>
              )}
            </Card>
          );
        })}
      </div>

      <Card className="overflow-x-auto">
        <h2 className="px-4 pt-3 text-sm font-semibold">Recent runs</h2>
        {runs.data?.length === 0 ? (
          <Empty>
            No runs yet. Click “Run pipeline now” on the Jobs page, or run{' '}
            <code>npm run ingest:once</code>.
          </Empty>
        ) : (
          <table className="mt-2 w-full text-sm">
            <thead className="text-left text-xs text-slate-500 uppercase">
              <tr>
                <th className="px-4 py-2">When</th>
                <th className="px-4 py-2">Source</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2 text-right">Fetched</th>
                <th className="px-4 py-2 text-right">New</th>
                <th className="hidden px-4 py-2 text-right sm:table-cell">Filtered</th>
                <th className="hidden px-4 py-2 text-right sm:table-cell">Dup</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {runs.data?.map((r) => (
                <tr key={r.id} title={r.error}>
                  <td className="px-4 py-1.5 whitespace-nowrap text-slate-500">
                    {dateTime(r.startedAt)}
                  </td>
                  <td className="px-4 py-1.5">{r.source}</td>
                  <td className="px-4 py-1.5">
                    <Badge tone={TONE[r.status]}>{r.status}</Badge>
                  </td>
                  <td className="px-4 py-1.5 text-right tabular-nums">{r.fetched}</td>
                  <td className="px-4 py-1.5 text-right tabular-nums">{r.inserted}</td>
                  <td className="hidden px-4 py-1.5 text-right tabular-nums sm:table-cell">
                    {r.filtered}
                  </td>
                  <td className="hidden px-4 py-1.5 text-right tabular-nums sm:table-cell">
                    {r.duplicates}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
