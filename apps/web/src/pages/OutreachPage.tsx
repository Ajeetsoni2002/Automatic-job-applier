import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import type { OutreachDto } from '@ja/shared/types';
import { Badge, Button, Card, Empty, ErrorNote, Input, cx } from '../components/ui';
import { api } from '../lib/api';
import { dateTime, timeAgo } from '../lib/format';

const TABS = [
  { key: 'drafts', label: 'Drafts', status: 'draft,dry_run,failed' },
  { key: 'scheduled', label: 'Scheduled', status: 'scheduled,sending' },
  { key: 'sent', label: 'Sent', status: 'sent' },
  { key: 'replies', label: 'Replies', status: 'replied,bounced' },
  { key: 'skipped', label: 'Skipped', status: 'skipped' },
] as const;

const STATUS_TONE: Record<string, 'slate' | 'green' | 'amber' | 'red' | 'indigo'> = {
  draft: 'amber',
  scheduled: 'indigo',
  sending: 'indigo',
  sent: 'green',
  dry_run: 'slate',
  replied: 'green',
  bounced: 'red',
  failed: 'red',
  skipped: 'slate',
};

const STATUS_TEXT: Record<string, string> = {
  draft: 'Draft — review it',
  scheduled: 'Scheduled',
  sending: 'Sending…',
  sent: 'Sent',
  dry_run: 'Dry run (not sent)',
  replied: 'Replied',
  bounced: 'Bounced',
  failed: 'Failed',
  skipped: 'Skipped',
};

const textarea =
  'w-full rounded-md border-0 bg-white px-2.5 py-1.5 text-sm ring-1 ring-slate-300 focus:ring-2 focus:ring-indigo-500 dark:bg-slate-950 dark:ring-slate-700';

export function OutreachPage() {
  const [params, setParams] = useSearchParams();
  const [composing, setComposing] = useState(false);
  const tab = TABS.find((t) => t.key === params.get('tab')) ?? TABS[0];
  const list = useQuery({
    queryKey: ['outreach', tab.status],
    queryFn: () => api.outreach({ status: tab.status }),
    refetchInterval: 30_000,
  });
  const stats = useQuery({ queryKey: ['stats'], queryFn: api.stats });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-semibold">Outreach</h1>
          <p className="text-sm text-slate-500">
            Cold emails to recruiters about a specific job. Approved emails go out on weekdays
            between 09:30 and 18:30, a few minutes apart, with a follow-up if there's no reply.{' '}
            {stats.data?.dryRun && 'DRY_RUN is on: nothing is actually sent.'}
          </p>
        </div>
        <Button variant="primary" onClick={() => setComposing((v) => !v)}>
          {composing ? 'Close' : 'New email'}
        </Button>
      </div>
      {composing && <ManualForm onDone={() => setComposing(false)} />}
      <div className="flex flex-wrap gap-1 border-b border-slate-200 dark:border-slate-800">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setParams(t.key === 'drafts' ? {} : { tab: t.key }, { replace: true })}
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
      <ErrorNote error={list.error} />
      {list.data?.length === 0 && (
        <Card>
          <Empty>
            {tab.key === 'drafts'
              ? 'No drafts. Add a recruiter email from a job (Jobs → open a job → "Email a recruiter") or use "New email".'
              : 'Nothing here.'}
          </Empty>
        </Card>
      )}
      <div className="space-y-4">
        {list.data?.map((o) => (
          <OutreachCard key={o.id} item={o} />
        ))}
      </div>
    </div>
  );
}

function OutreachCard({ item: o }: { item: OutreachDto }) {
  const qc = useQueryClient();
  const [subject, setSubject] = useState(o.subject);
  const [body, setBody] = useState(o.body);
  const [open, setOpen] = useState(['draft', 'dry_run', 'failed'].includes(o.status));
  useEffect(() => {
    setSubject(o.subject);
    setBody(o.body);
  }, [o.updatedAt, o.subject, o.body]);

  const refresh = () => qc.invalidateQueries({ queryKey: ['outreach'] });
  const save = useMutation({
    mutationFn: () => api.saveOutreach(o.id, { subject, body }),
    onSuccess: refresh,
  });
  const attach = useMutation({
    mutationFn: (v: boolean) => api.saveOutreach(o.id, { attachResume: v }),
    onSuccess: refresh,
  });
  const approve = useMutation({ mutationFn: () => api.approveOutreach(o.id), onSuccess: refresh });
  const skip = useMutation({ mutationFn: () => api.skipOutreach(o.id), onSuccess: refresh });
  const suppress = useMutation({ mutationFn: () => api.suppress(o.email), onSuccess: refresh });

  const editable = ['draft', 'scheduled', 'dry_run', 'failed'].includes(o.status);
  const dirty = subject !== o.subject || body !== o.body;

  return (
    <Card className="space-y-3 p-4">
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="font-medium">
            {o.job?.title ?? 'Job'} <span className="text-slate-500">— {o.job?.company}</span>
          </div>
          <div className="text-xs text-slate-500">
            to {o.contactName ? `${o.contactName} <${o.email}>` : o.email} ·{' '}
            {o.contactSource === 'job_post' ? 'found in the job post' : 'added by you'}
            {o.type === 'follow_up' && ' · follow-up'}
            {o.job?.score != null && ` · score ${o.job.score}`} · updated {timeAgo(o.updatedAt)}
            {o.scheduledFor && o.status === 'scheduled' && ` · sends ${dateTime(o.scheduledFor)}`}
            {o.status === 'scheduled' && !o.scheduledFor && ' · time picked on the next run'}
            {o.sentAt && ` · sent ${dateTime(o.sentAt)}`}
          </div>
        </div>
        {o.edited && <Badge>edited</Badge>}
        <Badge tone={STATUS_TONE[o.status] ?? 'slate'}>{STATUS_TEXT[o.status] ?? o.status}</Badge>
      </div>

      {o.error && <p className="text-sm text-amber-700 dark:text-amber-400">{o.error}</p>}
      {o.issues.length > 0 && (
        <ul className="space-y-1 rounded-md bg-amber-50 p-2 text-xs text-amber-800 dark:bg-amber-950/50 dark:text-amber-300">
          {o.issues.map((i, n) => (
            <li key={n}>{i}</li>
          ))}
        </ul>
      )}
      {o.replySnippet && (
        <blockquote className="rounded-md bg-emerald-50 p-2 text-sm text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">
          {o.repliedAt && <span className="text-xs">{dateTime(o.repliedAt)} · </span>}“
          {o.replySnippet}”
        </blockquote>
      )}

      {open ? (
        <div className="space-y-2">
          <Input
            value={subject}
            disabled={!editable}
            onChange={(e) => setSubject(e.target.value)}
            className="w-full"
            aria-label="Subject"
          />
          <textarea
            rows={12}
            value={body}
            disabled={!editable}
            onChange={(e) => setBody(e.target.value)}
            className={textarea}
            aria-label="Body"
          />
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={o.attachResume}
              disabled={!editable || attach.isPending}
              onChange={(e) => attach.mutate(e.target.checked)}
            />
            Attach the tailored resume PDF
          </label>
        </div>
      ) : (
        <button
          className="text-xs text-indigo-600 dark:text-indigo-400"
          onClick={() => setOpen(true)}
        >
          Show email
        </button>
      )}

      <ErrorNote
        error={save.error ?? attach.error ?? approve.error ?? skip.error ?? suppress.error}
      />
      <div className="flex flex-wrap items-center gap-2">
        {editable && (
          <Button disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
            Save
          </Button>
        )}
        {['draft', 'dry_run', 'failed'].includes(o.status) && (
          <Button
            variant="primary"
            disabled={dirty || approve.isPending}
            title={dirty ? 'Save your changes first' : undefined}
            onClick={() => approve.mutate()}
          >
            {o.status === 'draft' ? 'Approve & schedule' : 'Schedule again'}
          </Button>
        )}
        {o.job?.url && !o.job.url.startsWith('mailto:') && (
          <a href={o.job.url} target="_blank" rel="noreferrer noopener">
            <Button variant="ghost">Job post ↗</Button>
          </a>
        )}
        <div className="ml-auto flex gap-2">
          {editable && (
            <Button
              variant="ghost"
              title="Never email this address again"
              onClick={() => {
                if (confirm(`Never email ${o.email} again?`)) suppress.mutate();
              }}
            >
              Do not email
            </Button>
          )}
          {editable && (
            <Button variant="ghost" onClick={() => skip.mutate()}>
              Skip
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

const EMPTY_FORM = {
  company: '',
  title: '',
  email: '',
  name: '',
  location: '',
  url: '',
  description: '',
};

function ManualForm({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState(EMPTY_FORM);
  const set = (k: keyof typeof EMPTY_FORM) => (e: { target: { value: string } }) =>
    setF((v) => ({ ...v, [k]: e.target.value }));
  const create = useMutation({
    mutationFn: () =>
      api.manualOutreach({
        company: f.company,
        title: f.title,
        email: f.email,
        ...(f.name && { name: f.name }),
        ...(f.location && { location: f.location }),
        ...(f.url && { url: f.url }),
        ...(f.description && { description: f.description }),
      }),
    onSuccess: () => {
      setF(EMPTY_FORM);
      onDone();
      // The draft is written by the worker; it shows up under Drafts within a minute.
      setTimeout(() => void qc.invalidateQueries({ queryKey: ['outreach'] }), 15_000);
    },
  });

  return (
    <Card className="space-y-3 p-4">
      <p className="text-sm text-slate-500">
        For a role you found outside the system (a LinkedIn post, a referral). The more of the job
        description you paste, the better the email.
      </p>
      <form
        className="grid gap-2 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <Input required placeholder="Company *" value={f.company} onChange={set('company')} />
        <Input required placeholder="Role *" value={f.title} onChange={set('title')} />
        <Input
          required
          type="email"
          placeholder="Recruiter email *"
          value={f.email}
          onChange={set('email')}
        />
        <Input placeholder="Recruiter name" value={f.name} onChange={set('name')} />
        <Input placeholder="Location" value={f.location} onChange={set('location')} />
        <Input placeholder="Job post link" type="url" value={f.url} onChange={set('url')} />
        <textarea
          rows={6}
          placeholder="Job description (paste it here)"
          value={f.description}
          onChange={set('description')}
          className={cx(textarea, 'sm:col-span-2')}
        />
        <div className="flex items-center gap-2 sm:col-span-2">
          <Button type="submit" variant="primary" disabled={create.isPending}>
            Draft the email
          </Button>
          {create.isSuccess && (
            <span className="text-sm text-slate-500">Drafting… it appears under Drafts.</span>
          )}
        </div>
      </form>
      <ErrorNote error={create.error} />
    </Card>
  );
}
