import type {
  ApplicationDto,
  JobDetailDto,
  JobDto,
  OutreachDto,
  Paginated,
  PortalDto,
  PortalName,
  SettingsDto,
  SourceName,
  SourceRunDto,
  StatsDto,
  TailoredDocDto,
  UserSettableStatus,
} from '@ja/shared/types';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    credentials: 'include',
    ...init,
    headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok)
    throw new ApiError(res.status, (body as { error?: string }).error ?? `HTTP ${res.status}`);
  return body as T;
}

const json = (method: string, data: unknown): RequestInit => ({
  method,
  body: JSON.stringify(data),
});

export interface JobQuery {
  status?: string;
  source?: string;
  workMode?: string;
  confidence?: string;
  minScore?: number;
  batch?: 'eligible';
  postedWithinDays?: number;
  q?: string;
  sort?: 'score' | 'posted' | 'fetched';
  page?: number;
  pageSize?: number;
}

function qs(params: object): string {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params))
    if (v !== undefined && v !== '' && v !== null) s.set(k, String(v));
  const str = s.toString();
  return str ? `?${str}` : '';
}

export const api = {
  me: () => request<{ email: string }>('/auth/me'),
  login: (email: string, password: string) =>
    request<{ email: string }>('/auth/login', json('POST', { email, password })),
  logout: () => request<{ ok: true }>('/auth/logout', { method: 'POST' }),

  jobs: (q: JobQuery) => request<Paginated<JobDto>>(`/jobs${qs(q)}`),
  job: (id: string) => request<JobDetailDto>(`/jobs/${id}`),
  updateJob: (id: string, patch: { status?: UserSettableStatus; notes?: string }) =>
    request<JobDto>(`/jobs/${id}`, json('PATCH', patch)),

  stats: () => request<StatsDto>('/stats'),
  settings: () => request<SettingsDto>('/settings'),
  saveSettings: (patch: Partial<SettingsDto>) =>
    request<SettingsDto>('/settings', json('PUT', patch)),
  sourceRuns: (limit = 60) => request<SourceRunDto[]>(`/source-runs?limit=${limit}`),

  runPipeline: (body: { sources?: SourceName[]; force?: boolean } = {}) =>
    request<{ taskId: string }>('/admin/run-pipeline', json('POST', body)),
  jobDocs: (jobId: string) =>
    request<{ latest: TailoredDocDto | null; pendingTaskId?: string; llmEnabled: boolean }>(
      `/jobs/${jobId}/docs`,
    ),
  tailor: (jobId: string) =>
    request<{ taskId: string }>(`/jobs/${jobId}/tailor`, { method: 'POST' }),
  saveCoverLetter: (docId: string, coverLetter: string) =>
    request<TailoredDocDto>(`/docs/${docId}`, json('PATCH', { coverLetter })),
  resumePdfUrl: (docId: string) => `/api/docs/${docId}/resume.pdf`,
  applications: (q: { status?: string; jobId?: string } = {}) =>
    request<ApplicationDto[]>(`/applications${qs(q)}`),
  saveAnswers: (id: string, answers: Array<{ key: string; value: string | string[] | boolean }>) =>
    request<ApplicationDto>(`/applications/${id}`, json('PATCH', { answers })),
  approveApplication: (id: string) =>
    request<{ taskId: string }>(`/applications/${id}/approve`, { method: 'POST' }),
  skipApplication: (id: string) =>
    request<ApplicationDto>(`/applications/${id}/skip`, { method: 'POST' }),
  applyFromLink: (body: { url: string; company?: string; title?: string; autoSubmit: boolean }) =>
    request<{ appId: string; jobId: string; taskId: string }>(
      '/applications/from-link',
      json('POST', body),
    ),
  uploadAnswerFile: (id: string, key: string, file: File) =>
    request<ApplicationDto>(`/applications/${id}/answers/${encodeURIComponent(key)}/file`, {
      method: 'POST',
      body: file,
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-File-Name': encodeURIComponent(file.name),
      },
    }),
  savedAnswers: () =>
    request<
      Array<{
        id: string;
        question: string;
        value: string | string[] | boolean;
        kind?: string;
        updatedAt?: string;
      }>
    >('/saved-answers'),
  saveSavedAnswer: (id: string, value: string | string[] | boolean) =>
    request<{ ok: true }>(`/saved-answers/${id}`, json('PUT', { value })),
  deleteSavedAnswer: (id: string) =>
    request<{ ok: true }>(`/saved-answers/${id}`, { method: 'DELETE' }),
  portals: () => request<PortalDto[]>('/portals'),
  connectPortal: (name: PortalName) =>
    request<{ taskId: string }>(`/portals/${name}/connect`, { method: 'POST' }),
  resumePortal: (name: PortalName) =>
    request<{ ok: true }>(`/portals/${name}/resume`, { method: 'POST' }),
  runPortalNow: (name: PortalName) =>
    request<{ ok: true }>(`/portals/${name}/run-now`, { method: 'POST' }),
  retryApplication: (id: string) =>
    request<{ taskId: string }>(`/applications/${id}/retry`, { method: 'POST' }),
  prepareApplication: (jobId: string) =>
    request<{ taskId: string }>(`/jobs/${jobId}/apply`, { method: 'POST' }),
  outreach: (q: { status?: string; jobId?: string } = {}) =>
    request<OutreachDto[]>(`/outreach${qs(q)}`),
  saveOutreach: (id: string, patch: { subject?: string; body?: string; attachResume?: boolean }) =>
    request<OutreachDto>(`/outreach/${id}`, json('PATCH', patch)),
  approveOutreach: (id: string) =>
    request<OutreachDto>(`/outreach/${id}/approve`, { method: 'POST' }),
  skipOutreach: (id: string) => request<OutreachDto>(`/outreach/${id}/skip`, { method: 'POST' }),
  addContact: (jobId: string, body: { email: string; name?: string }) =>
    request<{ taskId: string }>(`/jobs/${jobId}/contacts`, json('POST', body)),
  manualOutreach: (body: {
    company: string;
    title: string;
    email: string;
    name?: string;
    location?: string;
    description?: string;
    url?: string;
  }) => request<{ jobId: string; taskId: string }>('/outreach/manual', json('POST', body)),
  suppress: (email: string) => request<{ ok: true }>('/suppressions', json('POST', { email })),
  task: (id: string) =>
    request<{ id: string; status: 'pending' | 'running' | 'done' | 'failed'; error?: string }>(
      `/admin/tasks/${id}`,
    ),
};
