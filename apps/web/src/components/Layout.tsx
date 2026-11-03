import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { NavLink, Outlet } from 'react-router-dom';
import { api } from '../lib/api';
import { Badge, cx } from './ui';

const NAV = [
  { to: '/', label: 'Jobs', end: true },
  { to: '/applications', label: 'Applications' },
  { to: '/outreach', label: 'Outreach' },
  { to: '/filtered', label: 'Filtered' },
  { to: '/sources', label: 'Sources' },
  { to: '/settings', label: 'Settings' },
];

export function Layout({ email }: { email: string }) {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  const stats = useQuery({ queryKey: ['stats'], queryFn: api.stats, refetchInterval: 60_000 });
  const logout = useMutation({
    mutationFn: api.logout,
    onSuccess: () => qc.setQueryData(['me'], null),
  });

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/90 backdrop-blur dark:border-slate-800 dark:bg-slate-950/90">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <span className="font-semibold tracking-tight">Job Autopilot</span>
          <nav className="flex gap-1">
            {NAV.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                end={n.end}
                className={({ isActive }) =>
                  cx(
                    'rounded-md px-2.5 py-1.5 text-sm font-medium',
                    isActive
                      ? 'bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-white'
                      : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white',
                  )
                }
              >
                {n.label}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2 text-xs">
            {settings.data?.killSwitch && <Badge tone="red">Kill switch ON</Badge>}
            {stats.data?.dryRun && (
              <Badge tone="amber" title="No applications or emails are sent while DRY_RUN=true">
                Dry run
              </Badge>
            )}
            {stats.data && (
              <Badge
                tone={stats.data.llm.mode === 'mock' ? 'slate' : 'indigo'}
                title="LLM calls today / daily cap"
              >
                {stats.data.llm.mode === 'mock'
                  ? 'Mock scorer'
                  : `LLM ${stats.data.llm.callsToday}/${stats.data.llm.maxPerDay}`}
              </Badge>
            )}
            <span className="hidden text-slate-500 sm:inline">{email}</span>
            <button
              onClick={() => logout.mutate()}
              className="text-slate-500 underline-offset-2 hover:underline"
            >
              Log out
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
