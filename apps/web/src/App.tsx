import { useQuery } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { ErrorNote } from './components/ui';
import { api, ApiError } from './lib/api';
import { ApplicationsPage } from './pages/ApplicationsPage';
import { FilteredPage } from './pages/FilteredPage';
import { JobsPage } from './pages/JobsPage';
import { LoginPage } from './pages/LoginPage';
import { OutreachPage } from './pages/OutreachPage';
import { SettingsPage } from './pages/SettingsPage';
import { SourcesPage } from './pages/SourcesPage';

export function App() {
  const me = useQuery({
    queryKey: ['me'],
    queryFn: () =>
      api.me().catch((e) => (e instanceof ApiError && e.status === 401 ? null : Promise.reject(e))),
    staleTime: Infinity,
  });

  if (me.isLoading) return null;
  if (me.error)
    return (
      <div className="mx-auto max-w-md p-8">
        <ErrorNote
          error={
            new Error(
              `Cannot reach the API: ${(me.error as Error).message}. Is "npm run dev" running?`,
            )
          }
        />
      </div>
    );
  if (!me.data) return <LoginPage />;

  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout email={me.data.email} />}>
          <Route index element={<JobsPage />} />
          <Route path="applications" element={<ApplicationsPage />} />
          <Route path="outreach" element={<OutreachPage />} />
          <Route path="filtered" element={<FilteredPage />} />
          <Route path="sources" element={<SourcesPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
