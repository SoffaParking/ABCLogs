import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { Redirect, Route, Switch, useLocation } from 'wouter';
import { api, setUnauthorizedHandler, type AuthState } from './api';
import { LAST_PROJECT_KEY, Shell, useProjects } from './components/Shell';
import { ErrorNote, Spinner } from './components/ui';
import { InvitePage, LoginPage, SetupPage } from './pages/Auth';
import { IssuePage, IssuesPage } from './pages/Issues';
import { LogsPage } from './pages/Logs';
import { Onboarding } from './pages/Onboarding';
import { OverviewPage } from './pages/Overview';
import { RequestsPage } from './pages/Requests';
import { SettingsPage } from './pages/Settings';

function FullPage({ children }: { children: React.ReactNode }) {
  return <main className="auth">{children}</main>;
}

/** `/`: the last project you looked at, the first one, or onboarding when there are none. */
function Home({ isAdmin }: { isAdmin: boolean }) {
  const projects = useProjects();
  if (projects.isPending) return <Spinner />;
  if (projects.isError) return <ErrorNote error={projects.error} />;
  const list = projects.data.projects;
  if (list.length === 0) return <Onboarding isAdmin={isAdmin} />;
  let last: string | null = null;
  try {
    last = localStorage.getItem(LAST_PROJECT_KEY);
  } catch {
    last = null;
  }
  const target = list.find((p) => p.slug === last) ?? list[0]!;
  return <Redirect to={`/p/${target.slug}`} replace />;
}

export function App() {
  const qc = useQueryClient();
  const [location] = useLocation();
  const auth = useQuery({
    queryKey: ['auth'],
    queryFn: () => api.get<AuthState>('/auth/state'),
    staleTime: 60_000,
  });

  useEffect(() => {
    setUnauthorizedHandler(() => void qc.invalidateQueries({ queryKey: ['auth'] }));
  }, [qc]);

  const invite = /^\/invite\/([^/?]+)/.exec(location);
  if (invite) return <InvitePage token={decodeURIComponent(invite[1]!)} />;

  if (auth.isPending) {
    return (
      <FullPage>
        <Spinner />
      </FullPage>
    );
  }
  if (auth.isError) {
    return (
      <FullPage>
        <div className="auth-card">
          <h1>Server unreachable</h1>
          <ErrorNote error={auth.error} />
          <button type="button" className="button" onClick={() => void auth.refetch()}>
            Try again
          </button>
        </div>
      </FullPage>
    );
  }
  if (auth.data.setupRequired) return <SetupPage />;
  const user = auth.data.user;
  if (!user) return <LoginPage />;

  return (
    <Shell user={user}>
      <Switch>
        <Route path="/">{() => <Home isAdmin={user.role === 'admin'} />}</Route>
        <Route path="/p/:slug">{(p) => <OverviewPage slug={p.slug} />}</Route>
        <Route path="/p/:slug/issues">{(p) => <IssuesPage slug={p.slug} />}</Route>
        <Route path="/p/:slug/issues/:id">{(p) => <IssuePage slug={p.slug} id={p.id} />}</Route>
        <Route path="/p/:slug/requests">{(p) => <RequestsPage slug={p.slug} />}</Route>
        <Route path="/p/:slug/logs">{(p) => <LogsPage slug={p.slug} />}</Route>
        <Route path="/settings/:tab?/:item?">
          {(p) => <SettingsPage user={user} tab={p.tab} item={p.item} />}
        </Route>
        <Route>
          <div className="empty">
            <h2>Page not found</h2>
          </div>
        </Route>
      </Switch>
    </Shell>
  );
}
