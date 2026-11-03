import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import type { ApplicationAnswerDto, ApplicationDto } from '@ja/shared/types';
import { Badge, Button, Card, Empty, ErrorNote, Input, Select, cx } from '../components/ui';
import { api } from '../lib/api';
import { dateTime, timeAgo } from '../lib/format';

const TABS = [
  { key: 'you', label: 'Needs you', status: 'needs_login,needs_input,needs_manual,failed' },
  { key: 'ready', label: 'Ready to approve', status: 'ready,dry_run' },
  { key: 'progress', label: 'In progress', status: 'preparing,approved,submitting' },
  { key: 'submitted', label: 'Submitted', status: 'submitted' },
  { key: 'skipped', label: 'Skipped', status: 'skipped' },
] as const;

const STATUS_TONE: Record<string, 'slate' | 'green' | 'amber' | 'red' | 'indigo'> = {
  preparing: 'indigo',
  needs_login: 'red',
  needs_input: 'amber',
  ready: 'indigo',
  approved: 'indigo',
  submitting: 'indigo',
  submitted: 'green',
  dry_run: 'slate',
  needs_manual: 'amber',
  failed: 'red',
  skipped: 'slate',
};

const STATUS_TEXT: Record<string, string> = {
  preparing: 'Reading the form…',
  needs_login: 'Log in, in the browser window',
  needs_input: 'Needs your answers',
  ready: 'Ready',
  approved: 'Approved, waiting for the worker',
  submitting: 'Submitting…',
  submitted: 'Submitted',
  dry_run: 'Filled (dry run, not sent)',
  needs_manual: 'Finish by hand',
  failed: 'Failed',
  skipped: 'Skipped',
};

/** Statuses that change by themselves soon: the list refreshes quickly while one is shown. */
const BUSY = ['preparing', 'needs_login', 'approved', 'submitting'];

export function ApplicationsPage() {
  const [params, setParams] = useSearchParams();
  const [linkOpen, setLinkOpen] = useState(false);
  const tab = TABS.find((t) => t.key === params.get('tab')) ?? TABS[0];
  const apps = useQuery({
    queryKey: ['applications', tab.status],
    queryFn: () => api.applications({ status: tab.status }),
    refetchInterval: (q) => (q.state.data?.some((a) => BUSY.includes(a.status)) ? 4000 : 30_000),
  });
  const stats = useQuery({ queryKey: ['stats'], queryFn: api.stats });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-semibold">Applications</h1>
          <p className="text-sm text-slate-500">
            Forms the system filled from your profile: Greenhouse, Lever and Ashby jobs, and any
            link you paste.{' '}
            {stats.data?.dryRun
              ? 'DRY_RUN is on: approving fills the form and takes a screenshot, but nothing is sent.'
              : 'Approving submits the application in a browser window; solve a CAPTCHA there if one appears.'}
          </p>
        </div>
        <Button variant="primary" onClick={() => setLinkOpen((v) => !v)}>
          {linkOpen ? 'Close' : 'Apply from a link'}
        </Button>
      </div>
      {linkOpen && (
        <LinkForm
          onStarted={() => {
            setLinkOpen(false);
            setParams({ tab: 'progress' }, { replace: true });
          }}
        />
      )}
      <div className="flex flex-wrap gap-1 border-b border-slate-200 dark:border-slate-800">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setParams(t.key === 'you' ? {} : { tab: t.key }, { replace: true })}
            className={cx(
              '-mb-px border-b-2 px-3 py-2 text-sm font-medium',
              t.key === tab.key
                ? 'border-indigo-600 text-indigo-600 dark:text-indigo-400'
                : 'border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      <ErrorNote error={apps.error} />
      {apps.data?.length === 0 && (
        <Card>
          <Empty>Nothing here.</Empty>
        </Card>
      )}
      <div className="space-y-4">
        {apps.data?.map((a) => (
          <ApplicationCard key={a.id} app={a} />
        ))}
      </div>
    </div>
  );
}

function ApplicationCard({ app }: { app: ApplicationDto }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Record<string, ApplicationAnswerDto['value']>>({});
  const [showAll, setShowAll] = useState(false);
  useEffect(() => setDraft({}), [app.updatedAt]);

  const refresh = () => qc.invalidateQueries({ queryKey: ['applications'] });
  const save = useMutation({
    mutationFn: () =>
      api.saveAnswers(
        app.id,
        Object.entries(draft).map(([key, value]) => ({ key, value })),
      ),
    onSuccess: refresh,
  });
  const approve = useMutation({
    mutationFn: () => api.approveApplication(app.id),
    onSuccess: refresh,
  });
  const skip = useMutation({ mutationFn: () => api.skipApplication(app.id), onSuccess: refresh });
  const retry = useMutation({ mutationFn: () => api.retryApplication(app.id), onSuccess: refresh });
  const upload = useMutation({
    mutationFn: ({ key, file }: { key: string; file: File }) =>
      api.uploadAnswerFile(app.id, key, file),
    onSuccess: refresh,
  });
  const isLink = ['link', 'linkedin', 'naukri'].includes(app.channel);

  const dirty = Object.keys(draft).length > 0;
  const missing = app.answers.filter(
    (a) => a.needsInput && !(a.key in draft && draft[a.key] !== ''),
  );
  const highlighted = app.answers.filter((a) => a.needsInput || a.needsReview);
  const shown = showAll ? app.answers : highlighted;
  const editable = ['needs_input', 'ready', 'dry_run', 'needs_manual', 'failed'].includes(
    app.status,
  );

  return (
    <Card className="space-y-3 p-4">
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="font-medium">
            {app.job?.title ?? 'Job'} <span className="text-slate-500">— {app.job?.company}</span>
          </div>
          <div className="text-xs text-slate-500">
            {app.channel === 'linkedin'
              ? 'LinkedIn'
              : app.channel === 'naukri'
                ? 'Naukri'
                : isLink
                  ? `pasted link · ${app.ats ?? 'website'}`
                  : app.ats}{' '}
            · {app.job?.location || 'location not stated'}
            {app.job?.score != null && ` · score ${app.job.score}`} · updated{' '}
            {timeAgo(app.updatedAt)}
            {app.submittedAt && ` · submitted ${dateTime(app.submittedAt)}`}
          </div>
        </div>
        <Badge tone={STATUS_TONE[app.status] ?? 'slate'}>
          {STATUS_TEXT[app.status] ?? app.status}
        </Badge>
      </div>

      {app.error && <p className="text-sm text-amber-700 dark:text-amber-400">{app.error}</p>}
      {app.confirmation && (
        <p className="text-sm text-emerald-700 dark:text-emerald-400">“{app.confirmation}”</p>
      )}

      {shown.length > 0 && (
        <div className="divide-y divide-slate-100 rounded-md ring-1 ring-slate-200 dark:divide-slate-800 dark:ring-slate-800">
          {shown.map((a) => (
            <AnswerRow
              key={a.key}
              answer={a}
              value={a.key in draft ? draft[a.key]! : a.value}
              disabled={!editable}
              onChange={(v) => setDraft((d) => ({ ...d, [a.key]: v }))}
              onUpload={(file) => upload.mutate({ key: a.key, file })}
            />
          ))}
        </div>
      )}
      <button
        className="text-xs text-indigo-600 dark:text-indigo-400"
        onClick={() => setShowAll((v) => !v)}
      >
        {showAll ? 'Show only what needs you' : `Show all ${app.answers.length} answers`}
      </button>

      <ErrorNote error={save.error ?? approve.error ?? skip.error ?? retry.error ?? upload.error} />
      <div className="flex flex-wrap items-center gap-2">
        {editable && (
          <Button disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
            Save answers
          </Button>
        )}
        {(isLink ? ['ready', 'dry_run'] : ['ready', 'dry_run', 'needs_manual', 'failed']).includes(
          app.status,
        ) && (
          <Button
            variant="primary"
            disabled={dirty || missing.length > 0 || approve.isPending}
            title={
              dirty
                ? 'Save your answers first'
                : missing.length
                  ? 'Answer the highlighted questions first'
                  : undefined
            }
            onClick={() => approve.mutate()}
          >
            {app.status === 'ready' ? 'Approve & submit' : 'Try again'}
          </Button>
        )}
        {isLink &&
          ['needs_login', 'needs_input', 'needs_manual', 'failed'].includes(app.status) && (
            <Button
              disabled={retry.isPending || dirty}
              title="Open the link again and carry on from the start, reusing your answers"
              onClick={() => retry.mutate()}
            >
              Start again
            </Button>
          )}
        <a href={app.applyUrl} target="_blank" rel="noreferrer noopener">
          <Button variant="ghost">Open form ↗</Button>
        </a>
        {app.screenshots.map((s) => (
          <a
            key={s.url}
            href={s.url}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-indigo-600 hover:underline dark:text-indigo-400"
          >
            screenshot: {s.label}
          </a>
        ))}
        {!['submitted', 'skipped', 'submitting', 'preparing'].includes(app.status) && (
          <Button variant="ghost" className="ml-auto" onClick={() => skip.mutate()}>
            Skip
          </Button>
        )}
      </div>
    </Card>
  );
}

function AnswerRow({
  answer: a,
  value,
  disabled,
  onChange,
  onUpload,
}: {
  answer: ApplicationAnswerDto;
  value: ApplicationAnswerDto['value'];
  disabled: boolean;
  onChange: (v: ApplicationAnswerDto['value']) => void;
  onUpload: (file: File) => void;
}) {
  const fileName = typeof value === 'string' ? value.split(/[\\/]/).pop() : '';
  let editor;
  if (a.kind === 'file')
    editor = (
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="truncate">{fileName || 'no file yet'}</span>
        {!disabled && (
          <label className="cursor-pointer text-indigo-600 hover:underline dark:text-indigo-400">
            {fileName ? 'Replace' : 'Upload'}
            <input
              type="file"
              className="hidden"
              accept=".pdf,.doc,.docx,.rtf,.txt,.jpg,.jpeg,.png,.webp,.heic"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onUpload(f);
                e.target.value = '';
              }}
            />
          </label>
        )}
      </div>
    );
  else if (a.kind === 'checkbox')
    editor = (
      <input
        type="checkbox"
        checked={value === true}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
    );
  else if ((a.kind === 'checkboxes' || a.kind === 'multiselect') && a.options) {
    const set = new Set(Array.isArray(value) ? value : []);
    editor = (
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {a.options.map((o) => (
          <label key={o} className="flex items-center gap-1 text-sm">
            <input
              type="checkbox"
              disabled={disabled}
              checked={set.has(o)}
              onChange={(e) =>
                onChange(e.target.checked ? [...set, o] : [...set].filter((x) => x !== o))
              }
            />
            {o}
          </label>
        ))}
      </div>
    );
  } else if (a.options?.length)
    editor = (
      <Select
        value={String(value)}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="w-full"
      >
        <option value="">— choose —</option>
        {a.options.map((o) => (
          <option key={o}>{o}</option>
        ))}
      </Select>
    );
  else if (a.kind === 'textarea')
    editor = (
      <textarea
        rows={4}
        value={String(value)}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md border-0 bg-white px-2.5 py-1.5 text-sm ring-1 ring-slate-300 focus:ring-2 focus:ring-indigo-500 dark:bg-slate-950 dark:ring-slate-700"
      />
    );
  else
    editor = (
      <Input
        value={String(value)}
        disabled={disabled}
        placeholder={
          a.kind === 'date'
            ? /month/i.test(a.label)
              ? 'e.g. 06/2025'
              : 'e.g. 15/08/2002'
            : undefined
        }
        onChange={(e) => onChange(e.target.value)}
        className="w-full"
      />
    );

  return (
    <div
      className={cx(
        'grid gap-1 px-3 py-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] sm:gap-3',
        a.needsInput && 'bg-rose-50 dark:bg-rose-950/30',
        !a.needsInput && a.needsReview && 'bg-amber-50 dark:bg-amber-950/30',
      )}
    >
      <div className="text-sm">
        {a.section && <div className="text-xs font-medium text-slate-500">{a.section}</div>}
        {a.label || a.key}
        {a.required && <span className="text-rose-600"> *</span>}
        <div className="text-xs text-slate-500">
          {a.step ? `page ${a.step + 1} · ` : ''}
          {a.needsInput
            ? 'Only you can answer this · saved for future forms'
            : a.source
              ? `from ${a.source}`
              : ''}
          {a.note ? ` · ${a.note}` : ''}
        </div>
      </div>
      <div>{editor}</div>
    </div>
  );
}

function LinkForm({ onStarted }: { onStarted: () => void }) {
  const qc = useQueryClient();
  const [url, setUrl] = useState('');
  const [company, setCompany] = useState('');
  const [title, setTitle] = useState('');
  const [autoSubmit, setAutoSubmit] = useState(false);
  const start = useMutation({
    mutationFn: () =>
      api.applyFromLink({
        url,
        autoSubmit,
        ...(company && { company }),
        ...(title && { title }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['applications'] });
      onStarted();
    },
  });

  return (
    <Card className="space-y-3 p-4">
      <p className="text-sm text-slate-500">
        Paste the link to a job or its application form on any site. A Chrome window opens on this
        computer: if the site asks you to <b>log in or create an account, do it in that window</b>{' '}
        (your password is never stored here) and the form carries on by itself. Questions only you
        can answer appear here under <i>Needs you</i>.
      </p>
      <form
        className="grid gap-2 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          start.mutate();
        }}
      >
        <Input
          required
          type="url"
          placeholder="https://careers.company.com/job/123 *"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          className="sm:col-span-2"
        />
        <Input
          placeholder="Company (optional, read from the page)"
          value={company}
          onChange={(e) => setCompany(e.target.value)}
        />
        <Input
          placeholder="Role (optional, read from the page)"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <label className="flex items-center gap-2 text-sm sm:col-span-2">
          <input
            type="checkbox"
            checked={autoSubmit}
            onChange={(e) => setAutoSubmit(e.target.checked)}
          />
          Submit by itself once every question is answered (otherwise you approve it first)
        </label>
        <div className="sm:col-span-2">
          <Button type="submit" variant="primary" disabled={start.isPending}>
            Start
          </Button>
        </div>
      </form>
      <ErrorNote error={start.error} />
    </Card>
  );
}
