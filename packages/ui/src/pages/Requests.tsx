import { LEVEL_NAMES } from '@apiloupe/shared';
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useLocation } from 'wouter';
import { api, type Facets, type LogItem, type Page, type RequestItem } from '../api';
import { FilterSelect, SearchBox } from '../components/filters';
import { linkWith, useRefreshInterval } from '../components/Shell';
import {
  Card,
  CopyButton,
  Drawer,
  Empty,
  ErrorNote,
  Fields,
  Json,
  LevelBadge,
  Spinner,
  StatusBadge,
} from '../components/ui';
import { formatDuration, formatEventTime, formatFullTime } from '../format';
import { useQueryState } from '../hooks';
import { rangeParams } from '../range';
import { LogList, SampledBadge } from './Logs';
import { ServiceFilter } from './Overview';

const FILTER_KEYS = [
  'method',
  'route',
  'status',
  'minLevel',
  'q',
  'minDurationMs',
  'requestId',
] as const;

export function RequestsPage({ slug }: { slug: string }) {
  const [params, patch] = useQueryState();
  const refetchInterval = useRefreshInterval();
  const range = params.get('range');
  const filters = Object.fromEntries(FILTER_KEYS.map((k) => [k, params.get(k) ?? ''])) as Record<
    (typeof FILTER_KEYS)[number],
    string
  >;
  const service = params.get('service') ?? '';
  const open = params.get('open');

  const facets = useQuery({
    queryKey: ['facets', slug, range],
    queryFn: () => api.get<Facets>(`/projects/${slug}/facets`, rangeParams(range)),
    staleTime: 60_000,
  });
  const list = useInfiniteQuery({
    queryKey: ['requests', slug, range, service, filters],
    queryFn: ({ pageParam }) =>
      api.get<Page<RequestItem>>(`/projects/${slug}/requests`, {
        ...rangeParams(range),
        service,
        ...filters,
        cursor: pageParam,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval,
    placeholderData: keepPreviousData,
  });

  const routes = facets.data?.routes ?? [];
  const methods = [...new Set(routes.map((r) => r.method))].sort();
  const routeNames = [
    ...new Set(
      routes.filter((r) => !filters.method || r.method === filters.method).map((r) => r.route),
    ),
  ];
  if (filters.route && !routeNames.includes(filters.route)) routeNames.unshift(filters.route);
  const active = FILTER_KEYS.some((k) => filters[k]);
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="page">
      <div className="page-header">
        <h1>Requests</h1>
        <ServiceFilter slug={slug} value={service} onChange={(v) => patch({ service: v })} />
      </div>
      <div className="filters">
        <FilterSelect
          label="Method"
          value={filters.method}
          onChange={(v) => patch({ method: v })}
          options={[
            { value: '', label: 'Any method' },
            ...methods.map((m) => ({ value: m, label: m })),
          ]}
        />
        <FilterSelect
          label="Route"
          value={filters.route}
          onChange={(v) => patch({ route: v })}
          options={[
            { value: '', label: 'Any route' },
            ...routeNames.map((r) => ({ value: r, label: r })),
          ]}
        />
        <FilterSelect
          label="Status"
          value={filters.status}
          onChange={(v) => patch({ status: v })}
          options={[
            { value: '', label: 'Any status' },
            { value: '2xx', label: '2xx success' },
            { value: '3xx', label: '3xx redirect' },
            { value: '4xx', label: '4xx client error' },
            { value: '5xx', label: '5xx server error' },
          ]}
        />
        <FilterSelect
          label="Minimum level"
          value={filters.minLevel}
          onChange={(v) => patch({ minLevel: v })}
          options={[
            { value: '', label: 'Any level' },
            ...LEVEL_NAMES.slice(1).map((n) => ({ value: n, label: `${n} and above` })),
          ]}
        />
        <FilterSelect
          label="Slower than"
          value={filters.minDurationMs}
          onChange={(v) => patch({ minDurationMs: v })}
          options={[
            { value: '', label: 'Any duration' },
            { value: '100', label: '≥ 100 ms' },
            { value: '500', label: '≥ 500 ms' },
            { value: '1000', label: '≥ 1 s' },
            { value: '5000', label: '≥ 5 s' },
          ]}
        />
        <SearchBox
          label="Path contains"
          placeholder="Path contains…"
          value={filters.q}
          onChange={(v) => patch({ q: v })}
        />
        <SearchBox
          label="Request id"
          placeholder="Request id"
          value={filters.requestId}
          onChange={(v) => patch({ requestId: v })}
        />
        {active && (
          <button
            type="button"
            className="button ghost small"
            onClick={() => patch(Object.fromEntries(FILTER_KEYS.map((k) => [k, null])))}
          >
            Clear filters
          </button>
        )}
      </div>

      <Card className={list.isPlaceholderData ? 'stale' : ''}>
        {list.isPending ? (
          <Spinner />
        ) : list.isError ? (
          <ErrorNote error={list.error} />
        ) : items.length === 0 ? (
          <Empty>No requests match in this time range.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table stack-mobile">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Request</th>
                  <th>Status</th>
                  <th className="num">Duration</th>
                  <th>Level</th>
                </tr>
              </thead>
              <tbody>
                {items.map((r) => (
                  <tr
                    key={r.ref}
                    className={`clickable ${open === r.ref ? 'selected' : ''}`}
                    onClick={() => patch({ open: r.ref })}
                  >
                    <td className="nowrap muted">
                      {formatEventTime(r.time)}
                      {r.weight && <SampledBadge weight={r.weight} />}
                    </td>
                    <td className="wide">
                      <span className="method">{r.method}</span>{' '}
                      <code title={r.route}>{r.path}</code>
                    </td>
                    <td>
                      <StatusBadge status={r.status} />
                    </td>
                    <td
                      className={`num ${r.durationMs !== null && r.durationMs >= 1000 ? 'tone-warn' : ''}`}
                    >
                      {formatDuration(r.durationMs)}
                    </td>
                    <td>
                      <LevelBadge level={r.level} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {list.hasNextPage && (
          <div className="more">
            <button
              type="button"
              className="button"
              disabled={list.isFetchingNextPage}
              onClick={() => void list.fetchNextPage()}
            >
              {list.isFetchingNextPage ? 'Loading…' : 'Load more'}
            </button>
          </div>
        )}
      </Card>

      {open && <RequestDrawer slug={slug} reference={open} onClose={() => patch({ open: null })} />}
    </div>
  );
}

function RequestDrawer({
  slug,
  reference,
  onClose,
}: {
  slug: string;
  reference: string;
  onClose: () => void;
}) {
  const [params] = useQueryState();
  const [, navigate] = useLocation();
  const detail = useQuery({
    queryKey: ['request', slug, reference],
    queryFn: () =>
      api.get<{ request: RequestItem; logs: LogItem[] }>(
        `/projects/${slug}/requests/${encodeURIComponent(reference)}`,
      ),
  });
  return (
    <Drawer title="Request" onClose={onClose}>
      {detail.isPending ? (
        <Spinner />
      ) : detail.isError ? (
        <ErrorNote error={detail.error} />
      ) : (
        <>
          <div className="drawer-title-line">
            <span className="method">{detail.data.request.method}</span>{' '}
            <code>{detail.data.request.path}</code>{' '}
            <StatusBadge status={detail.data.request.status} />
          </div>
          <Fields
            rows={[
              ['Time', formatFullTime(detail.data.request.time)],
              ['Route', <code key="r">{detail.data.request.route}</code>],
              ['Duration', formatDuration(detail.data.request.durationMs)],
              ['Level', <LevelBadge key="l" level={detail.data.request.level} />],
              ['Service', detail.data.request.service || '–'],
              [
                'Request id',
                detail.data.request.requestId ? (
                  <span key="id" className="inline">
                    <code>{detail.data.request.requestId}</code>{' '}
                    <CopyButton text={detail.data.request.requestId} />
                  </span>
                ) : (
                  '–'
                ),
              ],
            ]}
          />
          <h3>Attributes</h3>
          <Json value={detail.data.request.attrs} />
          <h3>Logs written for this request</h3>
          {detail.data.request.requestId ? (
            detail.data.logs.length > 0 ? (
              <LogList
                logs={detail.data.logs}
                onOpen={(ref) => navigate(linkWith(`/p/${slug}/logs`, params, { open: ref }))}
              />
            ) : (
              <p className="muted">No log lines carry this request id.</p>
            )
          ) : (
            <p className="muted">This request has no request id, so its logs cannot be linked.</p>
          )}
        </>
      )}
    </Drawer>
  );
}
