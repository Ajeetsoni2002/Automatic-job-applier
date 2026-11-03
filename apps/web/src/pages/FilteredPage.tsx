import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { JobDrawer } from '../components/JobDrawer';
import { Button, Card, Empty, ErrorNote, Input } from '../components/ui';
import { api } from '../lib/api';
import { timeAgo } from '../lib/format';

const PAGE_SIZE = 50;

/** Jobs removed by hard filters, with the reason — for tuning profile.yaml preferences. */
export function FilteredPage() {
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<string | null>(null);
  const jobs = useQuery({
    queryKey: ['jobs', 'filtered', q, page],
    queryFn: () =>
      api.jobs({
        status: 'filtered_out',
        q: q || undefined,
        sort: 'fetched',
        page,
        pageSize: PAGE_SIZE,
      }),
    placeholderData: keepPreviousData,
  });

  const reasons = new Map<string, number>();
  for (const j of jobs.data?.items ?? []) {
    const key = (j.filterReason ?? 'unknown')
      .replace(/:.*$/, '')
      .replace(/"[^"]*"/, '"…"')
      .replace(/\d+/g, 'N');
    reasons.set(key, (reasons.get(key) ?? 0) + 1);
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Filtered out</h1>
        <p className="text-sm text-slate-500">
          These never reached the LLM. If good jobs show up here, loosen <code>preferences</code> in{' '}
          <code>data/profile.yaml</code>, then run <code>npm run refilter</code>.
        </p>
      </div>
      {reasons.size > 0 && (
        <div className="flex flex-wrap gap-2 text-xs text-slate-600 dark:text-slate-400">
          {[...reasons]
            .sort((a, b) => b[1] - a[1])
            .map(([r, n]) => (
              <span key={r} className="rounded bg-slate-100 px-2 py-1 dark:bg-slate-800">
                {r} · {n}
              </span>
            ))}
          <span className="py-1">(this page)</span>
        </div>
      )}
      <Input
        placeholder="Search"
        value={q}
        onChange={(e) => (setQ(e.target.value), setPage(1))}
        className="w-full sm:w-64"
      />
      <ErrorNote error={jobs.error} />
      <Card className="overflow-hidden">
        {jobs.data?.items.length === 0 ? (
          <Empty>Nothing filtered out yet.</Empty>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs text-slate-500 uppercase dark:bg-slate-800/50">
              <tr>
                <th className="px-3 py-2">Job</th>
                <th className="px-3 py-2">Reason</th>
                <th className="hidden px-3 py-2 sm:table-cell">Fetched</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {jobs.data?.items.map((j) => (
                <tr
                  key={j.id}
                  onClick={() => setOpenId(j.id)}
                  className="cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50"
                >
                  <td className="px-3 py-2">
                    <div className="font-medium">{j.title}</div>
                    <div className="text-slate-500">
                      {j.company} · {j.location || j.workMode} · {j.source}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-amber-700 dark:text-amber-400">{j.filterReason}</td>
                  <td className="hidden px-3 py-2 whitespace-nowrap text-slate-500 sm:table-cell">
                    {timeAgo(j.fetchedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {jobs.data && jobs.data.total > PAGE_SIZE && (
        <div className="flex items-center justify-end gap-2 text-sm">
          <span className="mr-auto text-slate-500">{jobs.data.total} filtered jobs</span>
          <Button disabled={page <= 1} onClick={() => setPage(page - 1)}>
            Previous
          </Button>
          <Button disabled={page * PAGE_SIZE >= jobs.data.total} onClick={() => setPage(page + 1)}>
            Next
          </Button>
        </div>
      )}
      {openId && <JobDrawer jobId={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}
