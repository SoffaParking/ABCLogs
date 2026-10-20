import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { Link, useLocation } from 'wouter';
import { api, type Project, type User } from '../api';
import { useQueryState, useStoredState } from '../hooks';
import { DEFAULT_RANGE, RANGES } from '../range';

/** How often data pages poll, or false when auto-refresh is off. */
const RefreshContext = createContext<number | false>(false);
export const useRefreshInterval = () => useContext(RefreshContext);

export const LAST_PROJECT_KEY = 'apiloupe.project';

export function useProjects() {
  return useQuery({
    queryKey: ['projects'],
    queryFn: () => api.get<{ projects: Project[] }>('/projects'),
  });
}

/** Query parameters that follow you from page to page (time range, service). */
export function carried(params: URLSearchParams): string {
  const keep = new URLSearchParams();
  for (const key of ['range', 'service']) {
    const value = params.get(key);
    if (value) keep.set(key, value);
  }
  const query = keep.toString();
  return query ? `?${query}` : '';
}

/** A link to `path` carrying the range and service, plus `extra` parameters. */
export function linkWith(
  path: string,
  params: URLSearchParams,
  extra: Record<string, string> = {},
): string {
  const query = new URLSearchParams(carried(params));
  for (const [key, value] of Object.entries(extra)) query.set(key, value);
  const text = query.toString();
  return text ? `${path}?${text}` : path;
}

export function Shell({ user, children }: { user: User; children: ReactNode }) {
  const qc = useQueryClient();
  const [location, navigate] = useLocation();
  const [params, patch] = useQueryState();
  const [refresh, setRefresh] = useStoredState<'on' | 'off'>('apiloupe.autoRefresh', 'on');
  const projects = useProjects();
  const match = /^\/p\/([^/]+)(\/[^/]*)?/.exec(location);
  const slug = match?.[1] ? decodeURIComponent(match[1]) : undefined;
  const section = match?.[2] ?? '';
  const keep = carried(params);

  useEffect(() => {
    if (!slug) return;
    try {
      localStorage.setItem(LAST_PROJECT_KEY, slug);
    } catch {
      // storage blocked; the default project is the first one
    }
  }, [slug]);

  const logout = useMutation({
    mutationFn: () => api.post('/auth/logout'),
    onSettled: () => {
      qc.clear();
      void qc.invalidateQueries({ queryKey: ['auth'] });
      navigate('/', { replace: true });
    },
  });

  const tab = (path: string, label: string) => {
    const href = `/p/${slug}${path}${keep}`;
    const active = section === path || (path === '' && section === '/');
    return (
      <Link
        href={href}
        className={active ? 'tab active' : 'tab'}
        aria-current={active ? 'page' : undefined}
      >
        {label}
      </Link>
    );
  };

  return (
    <RefreshContext.Provider value={refresh === 'on' ? 30_000 : false}>
      <div className="layout">
        <header className="topbar">
          <Link href="/" className="brand">
            <span className="brand-mark" aria-hidden="true" />
            Soffa API Logs Dashboard
          </Link>
          {slug && projects.data && projects.data.projects.length > 0 && (
            <select
              className="project-select"
              aria-label="Project"
              value={slug}
              onChange={(e) => navigate(`/p/${e.target.value}${section}${keep}`)}
            >
              {projects.data.projects.map((p) => (
                <option key={p.slug} value={p.slug}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
          {slug && (
            <nav className="tabs" aria-label="Sections">
              {tab('', 'Overview')}
              {tab('/issues', 'Issues')}
              {tab('/requests', 'Requests')}
              {tab('/logs', 'Logs')}
            </nav>
          )}
          <div className="spacer" />
          {slug && (
            <div className="toolbar">
              <select
                aria-label="Time range"
                value={params.get('range') ?? DEFAULT_RANGE}
                onChange={(e) => patch({ range: e.target.value, cursor: null })}
              >
                {RANGES.map((r) => (
                  <option key={r.id} value={r.id}>
                    Last {r.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className={`button small ${refresh === 'on' ? 'on' : ''}`}
                aria-pressed={refresh === 'on'}
                title="Refresh every 30 seconds"
                onClick={() => setRefresh(refresh === 'on' ? 'off' : 'on')}
              >
                {refresh === 'on' ? '● Live' : '○ Paused'}
              </button>
            </div>
          )}
          <nav className="user-menu" aria-label="Account">
            <Link
              href="/settings"
              className={location.startsWith('/settings') ? 'tab active' : 'tab'}
            >
              Settings
            </Link>
            <span className="muted small" title={user.email}>
              {user.name || user.email}
            </span>
            <button type="button" className="button ghost small" onClick={() => logout.mutate()}>
              Sign out
            </button>
          </nav>
        </header>
        <main className="content">{children}</main>
      </div>
    </RefreshContext.Provider>
  );
}
