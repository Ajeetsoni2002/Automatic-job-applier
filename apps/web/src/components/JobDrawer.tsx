import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UserSettableStatus } from '@ja/shared/types';
import { api } from '../lib/api';
import { dateTime, salaryText, STATUS_LABEL, timeAgo } from '../lib/format';
import { ApplicationKit } from './ApplicationKit';
import { RecruiterEmail } from './RecruiterEmail';
import { Badge, Button, ErrorNote, ScoreBadge } from './ui';

const ACTIONS: Array<{
  status: UserSettableStatus;
  label: string;
  variant: 'primary' | 'secondary' | 'ghost';
}> = [
  { status: 'shortlisted', label: 'Shortlist', variant: 'primary' },
  { status: 'applied_manually', label: 'Mark applied', variant: 'secondary' },
  { status: 'ignored', label: 'Ignore', variant: 'secondary' },
  { status: 'scored', label: 'Reset', variant: 'ghost' },
];

export function JobDrawer({ jobId, onClose }: { jobId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const {
    data: job,
    error,
    isLoading,
  } = useQuery({ queryKey: ['job', jobId], queryFn: () => api.job(jobId) });
  const [notes, setNotes] = useState('');
  const [showDesc, setShowDesc] = useState(false);
  useEffect(() => setNotes(job?.notes ?? ''), [job?.notes]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const update = useMutation({
    mutationFn: (patch: { status?: UserSettableStatus; notes?: string }) =>
      api.updateJob(jobId, patch),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['job', jobId] });
      void qc.invalidateQueries({ queryKey: ['jobs'] });
      void qc.invalidateQueries({ queryKey: ['stats'] });
      void qc.invalidateQueries({ queryKey: ['docs', jobId] }); // shortlisting starts a kit
    },
  });

  const s = job?.latestScore;
  const canChangeStatus = job && !['new', 'filtered_out'].includes(job.status);

  return (
    <div className="fixed inset-0 z-30 flex justify-end" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-slate-900/40" onClick={onClose} />
      <aside className="relative flex h-full w-full max-w-2xl flex-col overflow-y-auto bg-white shadow-xl dark:bg-slate-900">
        <div className="sticky top-0 flex items-start gap-3 border-b border-slate-200 bg-white px-5 py-4 dark:border-slate-800 dark:bg-slate-900">
          {job && <ScoreBadge score={job.score} confidence={job.scoreConfidence} />}
          <div className="min-w-0 flex-1">
            <h2 className="text-lg leading-tight font-semibold">{job?.title ?? 'Loading…'}</h2>
            {job && (
              <p className="text-sm text-slate-600 dark:text-slate-400">
                {job.company} · {job.location || 'location not stated'} · {job.workMode}
              </p>
            )}
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="space-y-5 px-5 py-4">
          {isLoading && <p className="text-sm text-slate-500">Loading…</p>}
          <ErrorNote error={error ?? update.error} />
          {job && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <a href={job.url} target="_blank" rel="noreferrer noopener">
                  <Button variant="primary">Open job ↗</Button>
                </a>
                {canChangeStatus &&
                  ACTIONS.filter((a) => a.status !== job.status).map((a) => (
                    <Button
                      key={a.status}
                      variant={a.variant}
                      disabled={update.isPending}
                      onClick={() => update.mutate({ status: a.status })}
                    >
                      {a.label}
                    </Button>
                  ))}
                <Badge tone="slate">{STATUS_LABEL[job.status] ?? job.status}</Badge>
              </div>

              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
                <Meta label="Posted" value={job.postedAt ? `${timeAgo(job.postedAt)}` : '—'} />
                <Meta label="Fetched" value={dateTime(job.fetchedAt)} />
                <Meta
                  label="Experience"
                  value={
                    job.experienceMin != null
                      ? `${job.experienceMin}${job.experienceMax != null ? `–${job.experienceMax}` : '+'} yrs`
                      : 'not stated'
                  }
                />
                <Meta label="Salary" value={salaryText(job.salary) ?? 'not stated'} />
                <Meta
                  label="Eligible batches"
                  value={
                    job.batchYears.length
                      ? `${job.batchYears.join(', ')}${job.batchMatch ? ' ✓ yours' : ''}`
                      : 'not stated'
                  }
                />
                <Meta label="Description" value={job.descriptionQuality} />
                <Meta label="Seen on" value={job.seenOn.map((x) => x.source).join(', ')} />
              </dl>

              {job.filterReason && (
                <p className="text-sm text-amber-700 dark:text-amber-400">
                  Filtered out: {job.filterReason}
                </p>
              )}

              {s ? (
                <section className="space-y-3">
                  <h3 className="text-sm font-semibold">
                    Why {s.score}?{' '}
                    <span className="font-normal text-slate-500">
                      ({s.confidence} confidence · {s.model})
                    </span>
                  </h3>
                  <ul className="list-disc space-y-1 pl-5 text-sm">
                    {s.reasons.map((r, i) => (
                      <li key={i}>{r}</li>
                    ))}
                  </ul>
                  <SkillRow label="Matched" items={s.matchedSkills} tone="green" />
                  <SkillRow label="Missing" items={s.missingSkills} tone="amber" />
                  <SkillRow label="Red flags" items={s.redFlags} tone="red" />
                </section>
              ) : (
                <p className="text-sm text-slate-500">Not scored yet.</p>
              )}

              {canChangeStatus && (
                <ApplicationKit
                  jobId={job.id}
                  atsJob={job.seenOn.some((s) =>
                    ['greenhouse', 'lever', 'ashby'].includes(s.source),
                  )}
                />
              )}

              {canChangeStatus && <RecruiterEmail jobId={job.id} />}

              <section>
                <label className="text-sm font-semibold" htmlFor="notes">
                  Notes
                </label>
                <textarea
                  id="notes"
                  rows={3}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  className="mt-1 w-full rounded-md border-0 bg-white px-2.5 py-1.5 text-sm ring-1 ring-slate-300 focus:ring-2 focus:ring-indigo-500 dark:bg-slate-950 dark:ring-slate-700"
                  placeholder="Referral contact, follow-up date, …"
                />
                <Button
                  className="mt-1"
                  disabled={notes === (job.notes ?? '') || update.isPending}
                  onClick={() => update.mutate({ notes })}
                >
                  Save notes
                </Button>
              </section>

              {job.description && (
                <section>
                  <button
                    className="text-sm font-semibold text-indigo-600 dark:text-indigo-400"
                    onClick={() => setShowDesc((v) => !v)}
                  >
                    {showDesc ? 'Hide' : 'Show'} job description
                  </button>
                  {showDesc && (
                    <pre className="mt-2 font-sans text-sm whitespace-pre-wrap text-slate-700 dark:text-slate-300">
                      {job.description}
                    </pre>
                  )}
                </section>
              )}

              {job.seenOn.length > 1 && (
                <section className="text-sm">
                  <h3 className="font-semibold">Also listed on</h3>
                  <ul className="mt-1 space-y-1">
                    {job.seenOn.map((x) => (
                      <li key={`${x.source}:${x.sourceJobId}`}>
                        <a
                          className="text-indigo-600 hover:underline dark:text-indigo-400"
                          href={x.url}
                          target="_blank"
                          rel="noreferrer noopener"
                        >
                          {x.source}
                        </a>{' '}
                        <span className="text-slate-500">· {timeAgo(x.seenAt)}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </>
          )}
        </div>
      </aside>
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="truncate">{value}</dd>
    </div>
  );
}

function SkillRow({
  label,
  items,
  tone,
}: {
  label: string;
  items: string[];
  tone: 'green' | 'amber' | 'red';
}) {
  if (!items.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-sm">
      <span className="w-20 shrink-0 text-xs text-slate-500">{label}</span>
      {items.map((x) => (
        <Badge key={x} tone={tone}>
          {x}
        </Badge>
      ))}
    </div>
  );
}
