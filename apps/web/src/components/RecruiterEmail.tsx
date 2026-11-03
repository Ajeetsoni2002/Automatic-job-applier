import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { Badge, Button, ErrorNote, Input } from './ui';

/** Drawer section: give a recruiter's email for this job and the worker drafts a cold email. */
export function RecruiterEmail({ jobId }: { jobId: string }) {
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  // Number of emails this job had when we asked for a draft; polling stops once it grows.
  const [waitingFrom, setWaitingFrom] = useState<number | null>(null);
  const waiting = waitingFrom !== null;
  const existing = useQuery({
    queryKey: ['outreach', 'job', jobId],
    queryFn: () => api.outreach({ jobId }),
    refetchInterval: waiting ? 4000 : false,
  });
  const count = existing.data?.length ?? 0;
  const add = useMutation({
    mutationFn: () => api.addContact(jobId, { email, ...(name && { name }) }),
    onSuccess: () => {
      setWaitingFrom(count);
      setEmail('');
      setName('');
    },
  });
  useEffect(() => {
    if (!waiting) return;
    const t = setTimeout(() => setWaitingFrom(null), 90_000);
    return () => clearTimeout(t);
  }, [waiting]);
  useEffect(() => {
    if (waitingFrom !== null && count > waitingFrom) {
      setWaitingFrom(null);
      void qc.invalidateQueries({ queryKey: ['outreach'] });
    }
  }, [count, waitingFrom, qc]);

  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold">Email a recruiter</h3>
      {existing.data?.map((o) => (
        <div key={o.id} className="flex items-center gap-2 text-sm">
          <span className="truncate">{o.email}</span>
          <Badge tone={o.status === 'sent' || o.status === 'replied' ? 'green' : 'slate'}>
            {o.type === 'follow_up' ? `follow-up ${o.status}` : o.status}
          </Badge>
        </div>
      ))}
      {count > 0 && (
        <Link
          to="/outreach"
          className="text-xs text-indigo-600 hover:underline dark:text-indigo-400"
        >
          Review in Outreach →
        </Link>
      )}
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate();
        }}
      >
        <Input
          required
          type="email"
          placeholder="recruiter@company.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="min-w-0 flex-1"
        />
        <Input
          placeholder="Name (optional)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-36"
        />
        <Button type="submit" disabled={add.isPending || waiting}>
          {waiting ? 'Drafting…' : 'Draft email'}
        </Button>
      </form>
      <ErrorNote error={add.error} />
    </section>
  );
}
