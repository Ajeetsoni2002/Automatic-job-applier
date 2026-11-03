import { useEffect, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { JOB_SOURCES } from '@ja/shared/types';
import { JobDrawer } from '../components/JobDrawer';
import { Badge, Button, Card, Empty, ErrorNote, Input, ScoreBadge, Select } from '../components/ui';
import { api, type JobQuery } from '../lib/api';
import { STATUS_LABEL, timeAgo } from '../lib/format';

const VIEWS = [
  { key: 'active', label: 'Active', status: undefined },
  { key: 'shortlisted', label: 'Shortlisted', status: 'shortlisted' },
  { key: 'applied', label: 'Applied', status: 'applied_manually' },
  { key: 'unscored', label: 'Not scored', status: 'new,score_failed' },
  { key: 'ignored', label: 'Ignored', status: 'ignored' },
] as const;

const PAGE_SIZE = 25;

export function JobsPage() {
  const [params, setParams] = useSearchParams();
  const [openId, setOpenId] = useState<string | null>(null);
  const [search, setSearch] = useState(params.get('q') ?? '');
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings });

  const view = VIEWS.find((v) => v.key === params.get('view')) ?? VIEWS[0];
  const aboveMin = params.get('aboveMin') !== '0';
  const query: JobQuery = {
    status: view.status,
    source: params.get('source') ?? undefined,
    workMode: params.get('workMode') ?? undefined,
    confidence: params.get('confidence') ?? undefined,
    batch: params.get('batch') === 'eligible' ? 'eligible' : undefined,
    minScore: aboveMin && view.key === 'active' ? settings.data?.minScore : undefined,
    postedWithinDays: params.get('days') ? Number(params.get('days')) : undefined,
    q: params.get('q') ?? undefined,
    sort: (params.get('sort') as JobQuery['sort']) ?? 'score',
    page: Number(params.get('page') ?? 1),
    pageSize: PAGE_SIZE,
  };

  const set = (key: string, value: string | undefined) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key !== 'page') next.delete('page');
    setParams(next, { replace: true });
  };

  // Debounce the search box into the URL.
  useEffect(() => {
    const t = setTimeout(
      () => (search !== (params.get('q') ?? '') ? set('q', search || undefined) : undefined),
      300,
    );
    return () => clearTimeout(t);
  }, [search]);

  const jobs = useQuery({
    queryKey: ['jobs', query],
    queryFn: () => api.jobs(query),
    enabled: settings.isSuccess,
    placeholderData: keepPreviousData,
  });
  const pages = jobs.data ? Math.max(1, Math.ceil(jobs.data.total / PAGE_SIZE)) : 1;

  return (
    <div className="space-y-4">
      <StatsStrip />

      <div className="flex flex-wrap items-center gap-1 border-b border-slate-200 dark:border-slate-800">
        {VIEWS.map((v) => (
          <button
            key={v.key}
            onClick={() => set('view', v.key === 'active' ? undefined : v.key)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${
              v.key === view.key
                ? 'border-indigo-600 text-indigo-600 dark:text-indigo-400'
                : 'border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
            }`}
          >
            {v.label}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          placeholder="Search title, company, location"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full sm:w-64"
        />
        <Select value={params.get('source') ?? ''} onChange={(e) => set('source', e.target.value)}>
          <option value="">All sources</option>
          {JOB_SOURCES.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </Select>
        <Select
          value={params.get('workMode') ?? ''}
          onChange={(e) => set('workMode', e.target.value)}
        >
          <option value="">Any work mode</option>
          <option value="remote">Remote</option>
          <option value="hybrid">Hybrid</option>
          <option value="onsite">On-site</option>
          <option value="unknown">Unknown</option>
        </Select>
        <Select
          value={params.get('confidence') ?? ''}
          onChange={(e) => set('confidence', e.target.value)}
        >
          <option value="">Any confidence</option>
          <option value="high,medium">High / medium</option>
          <option value="low">Low (alert emails)</option>
        </Select>
        <Select value={params.get('batch') ?? ''} onChange={(e) => set('batch', e.target.value)}>
          <option value="">Any batch</option>
          <option value="eligible">My batch eligible</option>
        </Select>
        <Select value={params.get('days') ?? ''} onChange={(e) => set('days', e.target.value)}>
          <option value="">Any date</option>
          <option value="1">Last 24h</option>
          <option value="3">Last 3 days</option>
          <option value="7">Last 7 days</option>
        </Select>
        <Select
          value={params.get('sort') ?? 'score'}
          onChange={(e) => set('sort', e.target.value === 'score' ? undefined : e.target.value)}
        >
          <option value="score">Sort: score</option>
          <option value="posted">Sort: newest posted</option>
          <option value="fetched">Sort: recently fetched</option>
        </Select>
        {view.key === 'active' && (
          <label className="flex items-center gap-1.5 text-sm text-slate-600 dark:text-slate-400">
            <input
              type="checkbox"
              checked={aboveMin}
              onChange={(e) => set('aboveMin', e.target.checked ? undefined : '0')}
            />
            Only ≥ {settings.data?.minScore ?? '…'}
          </label>
        )}
      </div>

      <ErrorNote error={jobs.error} />

      <Card className="overflow-hidden">
        {jobs.data && jobs.data.items.length === 0 ? (
          <Empty>
            No jobs match these filters.
            {aboveMin && view.key === 'active' && ' Try unticking the minimum-score filter.'}
          </Empty>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs text-slate-500 uppercase dark:bg-slate-800/50">
              <tr>
                <th className="w-14 px-3 py-2">Score</th>
                <th className="px-3 py-2">Job</th>
                <th className="hidden px-3 py-2 md:table-cell">Location</th>
                <th className="hidden px-3 py-2 lg:table-cell">Source</th>
                <th className="hidden px-3 py-2 sm:table-cell">Posted</th>
                <th className="hidden px-3 py-2 md:table-cell">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {jobs.data?.items.map((j) => (
                <tr
                  key={j.id}
                  onClick={() => setOpenId(j.id)}
                  className="cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50"
                >
                  <td className="px-3 py-2.5">
                    <ScoreBadge score={j.score} confidence={j.scoreConfidence} />
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="font-medium">
                      {j.title}{' '}
                      {j.batchMatch && (
                        <Badge tone="green" title={`Eligible batches: ${j.batchYears.join(', ')}`}>
                          batch ✓
                        </Badge>
                      )}
                    </div>
                    <div className="text-slate-500">
                      {j.company}
                      <span className="md:hidden"> · {j.location || j.workMode}</span>
                    </div>
                  </td>
                  <td className="hidden px-3 py-2.5 md:table-cell">
                    <div className="max-w-56 truncate">{j.location || '—'}</div>
                    <div className="text-xs text-slate-500">{j.workMode}</div>
                  </td>
                  <td className="hidden px-3 py-2.5 lg:table-cell">
                    <div className="flex flex-wrap gap-1">
                      {[...new Set(j.seenOn.map((s) => s.source))].map((s) => (
                        <Badge key={s}>{s}</Badge>
                      ))}
                    </div>
                  </td>
                  <td className="hidden px-3 py-2.5 whitespace-nowrap text-slate-500 sm:table-cell">
                    {timeAgo(j.postedAt ?? j.fetchedAt)}
                  </td>
                  <td className="hidden px-3 py-2.5 md:table-cell">
                    <Badge
                      tone={
                        j.status === 'shortlisted'
                          ? 'indigo'
                          : j.status === 'applied_manually'
                            ? 'green'
                            : 'slate'
                      }
                    >
                      {STATUS_LABEL[j.status] ?? j.status}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {jobs.isLoading && <Empty>Loading…</Empty>}
      </Card>

      {jobs.data && jobs.data.total > PAGE_SIZE && (
        <div className="flex items-center justify-between text-sm text-slate-600 dark:text-slate-400">
          <span>
            {jobs.data.total} jobs · page {query.page} of {pages}
          </span>
          <div className="flex gap-2">
            <Button
              disabled={query.page! <= 1}
              onClick={() => set('page', String(query.page! - 1))}
            >
              Previous
            </Button>
            <Button
              disabled={query.page! >= pages}
              onClick={() => set('page', String(query.page! + 1))}
            >
              Next
            </Button>
          </div>
        </div>
      )}

      {openId && <JobDrawer jobId={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}

function StatsStrip() {
  const qc = useQueryClient();
  const stats = useQuery({ queryKey: ['stats'], queryFn: api.stats, refetchInterval: 60_000 });
  const [taskId, setTaskId] = useState<string | null>(null);

  const run = useMutation({
    mutationFn: () => api.runPipeline(),
    onSuccess: (r) => setTaskId(r.taskId),
  });
  const task = useQuery({
    queryKey: ['task', taskId],
    queryFn: () => api.task(taskId!),
    enabled: Boolean(taskId),
    refetchInterval: (q) =>
      q.state.data && ['done', 'failed'].includes(q.state.data.status) ? false : 3000,
  });
  const finished = task.data && ['done', 'failed'].includes(task.data.status);
  useEffect(() => {
    if (finished) void qc.invalidateQueries();
  }, [finished, qc]);

  const s = stats.data;
  const running = Boolean(taskId) && !finished;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <Stat label="Fetched today" value={s?.newToday} />
      <Stat label="High-score today" value={s?.aboveMinScoreToday} />
      <Stat label="Waiting to score" value={s ? (s.byStatus.new ?? 0) : undefined} />
      <Card className="flex flex-col justify-between gap-2 p-3">
        <span className="text-xs text-slate-500">Last run: {timeAgo(s?.lastRunAt)}</span>
        <Button variant="primary" disabled={running || run.isPending} onClick={() => run.mutate()}>
          {running
            ? task.data?.status === 'running'
              ? 'Running…'
              : 'Queued…'
            : 'Run pipeline now'}
        </Button>
        {(run.error || task.data?.status === 'failed') && (
          <span className="text-xs text-rose-600">
            {(run.error as Error | null)?.message ?? task.data?.error}
          </span>
        )}
      </Card>
    </div>
  );
}

function Stat({ label, value }: { label: string; value?: number }) {
  return (
    <Card className="p-3">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value ?? '…'}</div>
    </Card>
  );
}
