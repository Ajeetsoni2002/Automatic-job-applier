import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { timeAgo } from '../lib/format';
import { Badge, Button, ErrorNote } from './ui';

/** Tailored resume + cover letter for one job: generate, download, review, edit. */
export function ApplicationKit({ jobId, atsJob }: { jobId: string; atsJob: boolean }) {
  const qc = useQueryClient();
  const docs = useQuery({
    queryKey: ['docs', jobId],
    queryFn: () => api.jobDocs(jobId),
    // While the worker is generating, check every few seconds.
    refetchInterval: (q) => (q.state.data?.pendingTaskId ? 4000 : false),
  });
  const [letter, setLetter] = useState('');
  const [copied, setCopied] = useState(false);
  const latest = docs.data?.latest;
  useEffect(() => setLetter(latest?.coverLetter ?? ''), [latest?.id, latest?.coverLetter]);

  const generate = useMutation({
    mutationFn: () => api.tailor(jobId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['docs', jobId] }),
  });
  const save = useMutation({
    mutationFn: () => api.saveCoverLetter(latest!.id, letter),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['docs', jobId] }),
  });

  const pending = Boolean(docs.data?.pendingTaskId) || generate.isPending;
  const copy = async () => {
    await navigator.clipboard.writeText(letter);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <section className="space-y-3 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">Application kit</h3>
        {latest && (
          <span className="text-xs text-slate-500">
            v{latest.version} · {timeAgo(latest.createdAt)} · {latest.trigger}
          </span>
        )}
        <div className="ml-auto flex gap-2">
          {latest?.hasPdf && (
            <a href={api.resumePdfUrl(latest.id)}>
              <Button variant="primary">Download resume PDF</Button>
            </a>
          )}
          <Button
            disabled={pending || docs.data?.llmEnabled === false}
            onClick={() => generate.mutate()}
            title={docs.data?.llmEnabled === false ? 'Needs ANTHROPIC_API_KEY' : undefined}
          >
            {pending
              ? 'Generating… (~1 min)'
              : latest
                ? 'Regenerate'
                : 'Generate resume + cover letter'}
          </Button>
        </div>
      </div>

      <ErrorNote error={docs.error ?? generate.error ?? save.error} />
      {!latest && !pending && (
        <p className="text-sm text-slate-500">
          A one-page resume tailored to this job (only facts from your profile) and a short cover
          letter. Shortlisting a job generates this automatically.
        </p>
      )}
      {latest?.status === 'failed' && (
        <p className="text-sm text-rose-600">Generation failed: {latest.error}</p>
      )}

      {latest?.status === 'ready' && atsJob && <ApplyStatus jobId={jobId} />}
      {latest?.status === 'ready' && (
        <>
          {latest.issues.length > 0 && (
            <ul className="space-y-1 rounded-md bg-amber-50 p-2 text-xs text-amber-800 dark:bg-amber-950/50 dark:text-amber-300">
              {latest.issues.map((i, n) => (
                <li key={n}>
                  <Badge tone="amber">{i.kind.replace('_', ' ')}</Badge> {i.message}
                </li>
              ))}
            </ul>
          )}
          {latest.resume && (
            <details className="text-sm">
              <summary className="cursor-pointer font-medium">
                Resume summary{latest.notes ? ` — ${latest.notes}` : ''}
              </summary>
              <p className="mt-1 text-slate-700 dark:text-slate-300">{latest.resume.summary}</p>
              <p className="mt-1 text-xs text-slate-500">
                {
                  latest.resume.experience.flatMap((e) => e.bullets).filter((b) => b.rephrased)
                    .length
                }{' '}
                bullet(s) reworded for this job; everything else is your profile text.
              </p>
            </details>
          )}
          <div>
            <div className="mb-1 flex items-center gap-2">
              <label htmlFor={`cl-${jobId}`} className="text-sm font-medium">
                Cover letter
              </label>
              {latest.coverLetterEdited && <Badge>edited</Badge>}
              <div className="ml-auto flex gap-2">
                <Button variant="ghost" onClick={copy}>
                  {copied ? 'Copied ✓' : 'Copy'}
                </Button>
                <Button
                  disabled={letter === latest.coverLetter || save.isPending}
                  onClick={() => save.mutate()}
                >
                  Save edits
                </Button>
              </div>
            </div>
            <textarea
              id={`cl-${jobId}`}
              rows={12}
              value={letter}
              onChange={(e) => setLetter(e.target.value)}
              className="w-full rounded-md border-0 bg-white px-2.5 py-1.5 text-sm ring-1 ring-slate-300 focus:ring-2 focus:ring-indigo-500 dark:bg-slate-950 dark:ring-slate-700"
            />
          </div>
        </>
      )}
    </section>
  );
}

/** For Greenhouse/Lever/Ashby jobs: the auto-apply status, or a button to prepare the form. */
function ApplyStatus({ jobId }: { jobId: string }) {
  const qc = useQueryClient();
  const apps = useQuery({
    queryKey: ['applications', 'job', jobId],
    queryFn: () => api.applications({ jobId }),
  });
  const [preparing, setPreparing] = useState(false);
  const prepare = useMutation({
    mutationFn: () => api.prepareApplication(jobId),
    onSuccess: () => setPreparing(true),
  });
  useEffect(() => {
    if (!preparing) return;
    const t = setInterval(
      () => void qc.invalidateQueries({ queryKey: ['applications', 'job', jobId] }),
      4000,
    );
    return () => clearInterval(t);
  }, [preparing, jobId, qc]);
  const app = apps.data?.[0];
  useEffect(() => {
    if (app) setPreparing(false);
  }, [app]);

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md bg-indigo-50 px-3 py-2 text-sm dark:bg-indigo-950/40">
      <span className="font-medium">Auto-apply:</span>
      {app ? (
        <>
          <Badge tone="indigo">{app.status.replace('_', ' ')}</Badge>
          <Link to="/applications" className="text-indigo-600 hover:underline dark:text-indigo-400">
            Review in Applications →
          </Link>
        </>
      ) : (
        <Button disabled={preparing || prepare.isPending} onClick={() => prepare.mutate()}>
          {preparing ? 'Reading the form… (~1 min)' : 'Prepare application'}
        </Button>
      )}
      <ErrorNote error={prepare.error} />
    </div>
  );
}
