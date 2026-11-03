import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CHANNEL_NAMES, SOURCE_NAMES, type SettingsDto } from '@ja/shared/types';
import { Badge, Button, Card, ErrorNote, Input, Select, Toggle } from '../components/ui';
import { api } from '../lib/api';
import { dateTime } from '../lib/format';

const CHANNEL_LABEL: Record<string, string> = {
  ats: 'ATS forms (Greenhouse / Lever / Ashby)',
  cold_email: 'Cold email',
  naukri: 'Naukri (apply with your Naukri login)',
  linkedin: 'LinkedIn Easy Apply (with your LinkedIn login)',
  linkedin_referral: 'LinkedIn referral messages (not built yet)',
};

export function SettingsPage() {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  const [draft, setDraft] = useState<SettingsDto | null>(null);
  useEffect(() => {
    if (settings.data) setDraft(settings.data);
  }, [settings.data]);

  const save = useMutation({
    mutationFn: (d: SettingsDto) =>
      api.saveSettings({
        killSwitch: d.killSwitch,
        minScore: d.minScore,
        sources: d.sources,
        digest: d.digest,
        tailoring: d.tailoring,
      }),
    onSuccess: (data) => {
      qc.setQueryData(['settings'], data);
      void qc.invalidateQueries({ queryKey: ['jobs'] });
    },
  });

  if (!draft) return <ErrorNote error={settings.error} />;
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings.data);
  const patch = (p: Partial<SettingsDto>) => setDraft({ ...draft, ...p });

  return (
    <div className="max-w-2xl space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Settings</h1>
        <span className="text-xs text-slate-500">Saved {dateTime(settings.data?.updatedAt)}</span>
      </div>

      <Card className="divide-y divide-slate-100 px-4 dark:divide-slate-800">
        <Toggle
          danger
          checked={draft.killSwitch}
          onChange={(v) => patch({ killSwitch: v })}
          label={
            <span>
              <b>Kill switch</b>{' '}
              <span className="text-slate-500">
                — pauses the whole pipeline (fetching, scoring, and later all actions)
              </span>
            </span>
          }
        />
        <label className="flex items-center justify-between gap-4 py-3">
          <span className="text-sm">
            <b>Minimum score</b>{' '}
            <span className="text-slate-500">
              — jobs at or above this go to the digest (and, from Phase 2, the action queue)
            </span>
          </span>
          <Input
            type="number"
            min={0}
            max={100}
            value={draft.minScore}
            onChange={(e) =>
              patch({ minScore: Math.max(0, Math.min(100, Number(e.target.value) || 0)) })
            }
            className="w-20 text-right"
          />
        </label>
        <Toggle
          checked={draft.digest.enabled}
          onChange={(v) => patch({ digest: { enabled: v } })}
          label={<b>Daily Telegram digest</b>}
        />
      </Card>

      <Card className="divide-y divide-slate-100 px-4 dark:divide-slate-800">
        <Toggle
          checked={draft.tailoring.auto}
          onChange={(v) => patch({ tailoring: { ...draft.tailoring, auto: v } })}
          label={
            <span>
              <b>Auto-generate application kits</b>{' '}
              <span className="text-slate-500">
                — tailored resume PDF + cover letter for top jobs (~$0.03–0.04 each)
              </span>
            </span>
          }
        />
        <label className="flex items-center justify-between gap-4 py-3">
          <span className="text-sm">For jobs scoring at least</span>
          <Input
            type="number"
            min={0}
            max={100}
            value={draft.tailoring.minScore}
            onChange={(e) =>
              patch({
                tailoring: {
                  ...draft.tailoring,
                  minScore: Math.max(0, Math.min(100, Number(e.target.value) || 0)),
                },
              })
            }
            className="w-20 text-right"
          />
        </label>
        <label className="flex items-center justify-between gap-4 py-3">
          <span className="text-sm">
            At most per day{' '}
            <span className="text-slate-500">(shortlisting and manual "Generate" don't count)</span>
          </span>
          <Input
            type="number"
            min={0}
            max={50}
            value={draft.tailoring.dailyLimit}
            onChange={(e) =>
              patch({
                tailoring: {
                  ...draft.tailoring,
                  dailyLimit: Math.max(0, Math.min(50, Number(e.target.value) || 0)),
                },
              })
            }
            className="w-20 text-right"
          />
        </label>
      </Card>

      <Card className="px-4 py-2">
        <h2 className="pt-2 text-sm font-semibold">Sources</h2>
        <div className="grid sm:grid-cols-2 sm:gap-x-8">
          {SOURCE_NAMES.map((s) => (
            <Toggle
              key={s}
              checked={draft.sources[s]}
              onChange={(v) => patch({ sources: { ...draft.sources, [s]: v } })}
              label={s}
            />
          ))}
        </div>
      </Card>

      <Card className="px-4 py-3">
        <h2 className="text-sm font-semibold">Where it applies</h2>
        <p className="mt-1 text-xs text-slate-500">
          <b>auto</b>: sends by itself within the daily limit · <b>approve</b>: fills it, then waits
          for you in Applications · <b>off</b>: does nothing. DRY_RUN=true in .env still stops every
          real send.
        </p>
        <ul className="mt-2 divide-y divide-slate-100 text-sm dark:divide-slate-800">
          {CHANNEL_NAMES.filter((c) => c !== 'linkedin_referral').map((c) => (
            <li key={c} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span>{CHANNEL_LABEL[c]}</span>
              <span className="flex items-center gap-2">
                <Select
                  value={draft.channels[c].mode === 'assist' ? 'approve' : draft.channels[c].mode}
                  onChange={(e) =>
                    patch({
                      channels: {
                        ...draft.channels,
                        [c]: { ...draft.channels[c], mode: e.target.value as 'auto' },
                      },
                    })
                  }
                >
                  <option value="auto">auto</option>
                  <option value="approve">approve</option>
                  <option value="off">off</option>
                </Select>
                <Input
                  type="number"
                  min={0}
                  max={50}
                  className="w-20"
                  value={draft.channels[c].dailyLimit}
                  onChange={(e) =>
                    patch({
                      channels: {
                        ...draft.channels,
                        [c]: { ...draft.channels[c], dailyLimit: Number(e.target.value) },
                      },
                    })
                  }
                />
                <span className="text-xs text-slate-500">/day</span>
              </span>
            </li>
          ))}
        </ul>
      </Card>

      <ErrorNote error={save.error} />
      <div className="flex gap-2">
        <Button
          variant="primary"
          disabled={!dirty || save.isPending}
          onClick={() => save.mutate(draft)}
        >
          {save.isPending ? 'Saving…' : 'Save changes'}
        </Button>
        <Button disabled={!dirty} onClick={() => setDraft(settings.data!)}>
          Discard
        </Button>
      </div>

      <Portals />

      <SavedAnswers />
    </div>
  );
}

/** Answers you gave on application forms: reused whenever a form asks the same question. */
function SavedAnswers() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['saved-answers'], queryFn: api.savedAnswers });
  const [editing, setEditing] = useState<Record<string, string>>({});
  const refresh = () => qc.invalidateQueries({ queryKey: ['saved-answers'] });
  const save = useMutation({
    mutationFn: ({ id, value }: { id: string; value: string }) => api.saveSavedAnswer(id, value),
    onSuccess: (_r, v) => {
      setEditing((e) => {
        const { [v.id]: _drop, ...rest } = e;
        return rest;
      });
      void refresh();
    },
  });
  const remove = useMutation({ mutationFn: api.deleteSavedAnswer, onSuccess: refresh });

  return (
    <Card className="px-4 py-3">
      <h2 className="text-sm font-semibold">Saved answers ({list.data?.length ?? 0})</h2>
      <p className="mt-1 text-xs text-slate-500">
        Everything you answer on an application form is kept here and filled in automatically when
        another form asks the same question. Written answers are shown to you for a check before
        they are reused.
      </p>
      <ErrorNote error={list.error ?? save.error ?? remove.error} />
      <ul className="mt-2 divide-y divide-slate-100 text-sm dark:divide-slate-800">
        {list.data?.map((a) => {
          const text = Array.isArray(a.value) ? a.value.join(', ') : String(a.value);
          const shown = a.kind === 'file' ? text.split(/[\\/]/).pop() : text;
          const isEditing = a.id in editing;
          return (
            <li
              key={a.id}
              className="grid gap-1 py-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] sm:gap-3"
            >
              <span className="text-slate-600 dark:text-slate-300">{a.question}</span>
              {isEditing ? (
                <Input
                  value={editing[a.id]}
                  onChange={(e) => setEditing((x) => ({ ...x, [a.id]: e.target.value }))}
                />
              ) : (
                <span className="truncate" title={text}>
                  {a.kind === 'file' ? `📎 ${shown}` : shown}
                </span>
              )}
              <span className="flex gap-1">
                {isEditing ? (
                  <Button onClick={() => save.mutate({ id: a.id, value: editing[a.id]! })}>
                    Save
                  </Button>
                ) : (
                  a.kind !== 'file' &&
                  typeof a.value === 'string' && (
                    <Button
                      variant="ghost"
                      onClick={() => setEditing((x) => ({ ...x, [a.id]: String(a.value) }))}
                    >
                      Edit
                    </Button>
                  )
                )}
                <Button
                  variant="ghost"
                  onClick={() => {
                    if (confirm(`Forget your answer to "${a.question}"?`)) remove.mutate(a.id);
                  }}
                >
                  Delete
                </Button>
              </span>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

const PORTAL_LABEL = { linkedin: 'LinkedIn', naukri: 'Naukri' } as const;

/** LinkedIn and Naukri: your own login, kept in a separate Chrome profile on this computer. */
function Portals() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['portals'], queryFn: api.portals, refetchInterval: 15_000 });
  const refresh = () => qc.invalidateQueries({ queryKey: ['portals'] });
  const connect = useMutation({ mutationFn: api.connectPortal, onSuccess: refresh });
  const resume = useMutation({ mutationFn: api.resumePortal, onSuccess: refresh });
  const runNow = useMutation({ mutationFn: api.runPortalNow, onSuccess: refresh });

  return (
    <Card className="px-4 py-3">
      <h2 className="text-sm font-semibold">Job portals</h2>
      <p className="mt-1 text-xs text-slate-500">
        <b>Connect</b> opens the site in a Chrome window on this computer: log in there yourself
        (your password is never stored here). Applications then run between 09:30 and 20:00, one at
        a time, 6–15 minutes apart, within the daily limit above. Any CAPTCHA or security check
        pauses that site for 24 hours and messages you on Telegram. This needs your computer on and
        start.bat running.
      </p>
      <ErrorNote error={list.error ?? connect.error ?? resume.error ?? runNow.error} />
      <ul className="mt-2 divide-y divide-slate-100 text-sm dark:divide-slate-800">
        {list.data?.map((p) => (
          <li key={p.name} className="flex flex-wrap items-center gap-2 py-2">
            <span className="w-24 font-medium">{PORTAL_LABEL[p.name]}</span>
            {p.pausedUntil ? (
              <Badge tone="red" title={p.pauseReason}>
                paused until {dateTime(p.pausedUntil)}
              </Badge>
            ) : p.connected ? (
              <Badge tone="green">connected</Badge>
            ) : (
              <Badge tone="amber">not connected</Badge>
            )}
            <span className="text-xs text-slate-500">
              {p.appliedToday} applied today
              {p.lastAppliedAt && ` · last ${dateTime(p.lastAppliedAt)}`}
            </span>
            {p.pauseReason && (
              <span className="w-full text-xs text-rose-600 dark:text-rose-400">
                {p.pauseReason}
              </span>
            )}
            <span className="ml-auto flex gap-2">
              {p.pausedUntil && <Button onClick={() => resume.mutate(p.name)}>Resume</Button>}
              {p.connected && !p.pausedUntil && (
                <Button variant="ghost" onClick={() => runNow.mutate(p.name)}>
                  Apply to the next one now
                </Button>
              )}
              <Button
                variant={p.connected ? 'ghost' : 'primary'}
                disabled={connect.isPending}
                onClick={() => connect.mutate(p.name)}
              >
                {p.connected ? 'Reconnect' : 'Connect'}
              </Button>
            </span>
          </li>
        ))}
      </ul>
      {connect.isSuccess && (
        <p className="mt-2 text-xs text-slate-500">
          A Chrome window is opening on this computer: log in there. This page updates when you are
          done.
        </p>
      )}
    </Card>
  );
}
