import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation } from 'wouter';
import { api, type Issue, type IssueDetail, type IssueList, type IssueStatus } from '../api';
import { StackedBars } from '../components/charts';
import { SearchBox, FilterSelect } from '../components/filters';
import { linkWith, useRefreshInterval } from '../components/Shell';
import { Sparkline } from '../components/Sparkline';
import { StackTrace } from '../components/StackTrace';
import {
  Card,
  Empty,
  ErrorNote,
  Fields,
  Json,
  LevelBadge,
  Segmented,
  Spinner,
  Stat,
  StatusBadge,
} from '../components/ui';
import { formatAgo, formatCount, formatDuration, formatEventTime, formatFullTime } from '../format';
import { useQueryState } from '../hooks';
import { rangeParams } from '../range';
import { ServiceFilter } from './Overview';

const STATUS_OPTIONS: { value: IssueStatus | 'all'; label: string }[] = [
  { value: 'unresolved', label: 'Unresolved' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'ignored', label: 'Ignored' },
  { value: 'all', label: 'All' },
];

/** Resolve / ignore / reopen buttons, refreshing every issue query on success. */
function useSetStatus(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }: { id: number; status: IssueStatus }) =>
      api.patch(`/projects/${slug}/issues/${id}`, { status }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['issues', slug] });
      void qc.invalidateQueries({ queryKey: ['issue', slug] });
      void qc.invalidateQueries({ queryKey: ['top-issues', slug] });
    },
  });
}

function IssueActions({ slug, issue, compact }: { slug: string; issue: Issue; compact?: boolean }) {
  const setStatus = useSetStatus(slug);
  const button = (status: IssueStatus, label: string, className = '') => (
    <button
      type="button"
      className={`button ${compact ? 'small' : ''} ${className}`}
      disabled={setStatus.isPending}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setStatus.mutate({ id: issue.id, status });
      }}
    >
      {label}
    </button>
  );
  return (
    <span className="issue-actions">
      {issue.status === 'unresolved' ? (
        <>
          {button('resolved', 'Resolve', compact ? '' : 'primary')}
          {button('ignored', 'Ignore')}
        </>
      ) : (
        button('unresolved', 'Reopen')
      )}
      {setStatus.isError && <ErrorNote error={setStatus.error} />}
    </span>
  );
}

export function IssueBadges({ issue, since }: { issue: Issue; since?: number }) {
  return (
    <>
      {issue.status === 'resolved' && <span className="badge status-2xx">resolved</span>}
      {issue.status === 'ignored' && <span className="badge level-debug">ignored</span>}
      {issue.status === 'unresolved' && issue.regressedAt && (
        <span
          className="badge level-error"
          title={`Came back ${formatAgo(issue.regressedAt)} after being resolved`}
        >
          regressed
        </span>
      )}
      {since !== undefined && Date.parse(issue.firstSeen) >= since && (
        <span className="badge level-info">new</span>
      )}
    </>
  );
}

export function IssuesPage({ slug }: { slug: string }) {
  const [params, patch] = useQueryState();
  const refetchInterval = useRefreshInterval();
  const range = params.get('range');
  const status = (params.get('status') ?? 'unresolved') as IssueStatus | 'all';
  const q = params.get('q') ?? '';
  const sort = params.get('sort') ?? 'last_seen';
  const service = params.get('service') ?? '';
  const page = Number(params.get('page') ?? 0) || 0;

  const list = useQuery({
    queryKey: ['issues', slug, range, status, q, sort, service, page],
    queryFn: () =>
      api.get<IssueList>(`/projects/${slug}/issues`, {
        ...rangeParams(range),
        status,
        q,
        sort,
        service,
        page,
      }),
    refetchInterval,
    placeholderData: keepPreviousData,
  });
  const since = rangeParams(range).from;

  return (
    <div className="page">
      <div className="page-header">
        <h1>Issues</h1>
        <ServiceFilter
          slug={slug}
          value={service}
          onChange={(v) => patch({ service: v, page: null })}
        />
      </div>
      <p className="muted small page-intro">
        Every error and fatal log line, grouped: the same error from the same place in your code is
        one issue. Showing issues seen in the selected time range.
      </p>
      <div className="filters">
        <Segmented
          label="Status"
          value={status}
          onChange={(v) => patch({ status: v === 'unresolved' ? null : v, page: null })}
          options={STATUS_OPTIONS.map((o) => ({
            value: o.value,
            label: (
              <>
                {o.label}
                {o.value !== 'all' && list.data && (
                  <span className="count"> {list.data.totals[o.value]}</span>
                )}
              </>
            ),
          }))}
        />
        <SearchBox
          label="Search issues"
          placeholder="Search titles and code locations…"
          value={q}
          onChange={(v) => patch({ q: v, page: null })}
        />
        <FilterSelect
          label="Sort"
          value={sort}
          onChange={(v) => patch({ sort: v === 'last_seen' ? null : v, page: null })}
          options={[
            { value: 'last_seen', label: 'Last seen' },
            { value: 'count', label: 'Most events' },
            { value: 'first_seen', label: 'Newest' },
          ]}
        />
      </div>
      <Card className={list.isPlaceholderData ? 'stale' : ''}>
        {list.isPending ? (
          <Spinner />
        ) : list.isError ? (
          <ErrorNote error={list.error} />
        ) : list.data.items.length === 0 ? (
          <Empty>
            {status === 'unresolved'
              ? 'No unresolved issues in this time range.'
              : 'No issues match.'}
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="table issues-table">
              <thead>
                <tr>
                  <th>Issue</th>
                  <th className="hide-narrow">Trend</th>
                  <th className="num">In range</th>
                  <th className="num hide-narrow">Total</th>
                  <th className="hide-narrow">Last seen</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list.data.items.map((issue) => (
                  <tr key={issue.id}>
                    <td className="wide">
                      <Link
                        href={linkWith(`/p/${slug}/issues/${issue.id}`, params)}
                        className="issue-title"
                      >
                        <LevelBadge level={issue.level} /> {issue.title}
                      </Link>
                      <div className="issue-meta">
                        {issue.culprit && <code className="muted">{issue.culprit}</code>}
                        <IssueBadges issue={issue} since={since} />
                        <span className="muted small">first seen {formatAgo(issue.firstSeen)}</span>
                      </div>
                    </td>
                    <td className="hide-narrow">
                      <Sparkline
                        values={issue.spark}
                        label={`${issue.rangeCount} events over the range`}
                      />
                    </td>
                    <td className="num">{formatCount(issue.rangeCount, { compact: true })}</td>
                    <td className="num muted hide-narrow">
                      {formatCount(issue.count, { compact: true })}
                    </td>
                    <td className="muted nowrap hide-narrow">{formatAgo(issue.lastSeen)}</td>
                    <td className="num">
                      <IssueActions slug={slug} issue={issue} compact />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {list.data && (page > 0 || list.data.hasMore) && (
          <div className="more">
            <button
              type="button"
              className="button"
              disabled={page === 0}
              onClick={() => patch({ page: page > 1 ? String(page - 1) : null })}
            >
              Previous
            </button>
            <button
              type="button"
              className="button"
              disabled={!list.data.hasMore}
              onClick={() => patch({ page: String(page + 1) })}
            >
              Next
            </button>
          </div>
        )}
      </Card>
    </div>
  );
}

export function IssuePage({ slug, id }: { slug: string; id: string }) {
  const [params] = useQueryState();
  const [, navigate] = useLocation();
  const refetchInterval = useRefreshInterval();
  const range = params.get('range');
  const detail = useQuery({
    queryKey: ['issue', slug, id, range],
    queryFn: () => api.get<IssueDetail>(`/projects/${slug}/issues/${id}`, rangeParams(range)),
    refetchInterval,
    placeholderData: keepPreviousData,
  });
  if (detail.isPending) return <Spinner />;
  if (detail.isError) return <ErrorNote error={detail.error} />;
  const { issue, latest, occurrences, routes, series, rangeCount } = detail.data;
  const openLog = (ref: string) =>
    navigate(linkWith(`/p/${slug}/logs`, params, { open: ref, minLevel: 'error' }));
  const openRequest = (ref: string) =>
    navigate(linkWith(`/p/${slug}/requests`, params, { open: ref }));

  return (
    <div className="page">
      <p>
        <Link href={linkWith(`/p/${slug}/issues`, params)}>← Issues</Link>
      </p>
      <div className="issue-header">
        <div>
          <h1 className="issue-heading">
            <LevelBadge level={issue.level} /> {issue.title}
          </h1>
          <div className="issue-meta">
            {issue.culprit && <code className="muted">{issue.culprit}</code>}
            <IssueBadges issue={issue} />
            {issue.status === 'resolved' && issue.resolvedAt && (
              <span className="muted small">resolved {formatAgo(issue.resolvedAt)}</span>
            )}
          </div>
        </div>
        <IssueActions slug={slug} issue={issue} />
      </div>

      <div className="stats">
        <Stat label="Events in range" value={formatCount(rangeCount, { compact: true })} />
        <Stat label="Events in total" value={formatCount(issue.count, { compact: true })} />
        <Stat
          label="First seen"
          value={formatAgo(issue.firstSeen)}
          sub={formatFullTime(issue.firstSeen)}
        />
        <Stat
          label="Last seen"
          value={formatAgo(issue.lastSeen)}
          sub={formatFullTime(issue.lastSeen)}
        />
        <Stat label="Service" value={issue.service || '–'} />
      </div>

      <Card title="Events over time">
        <StackedBars
          data={series}
          series={[{ key: 'count', label: 'events', className: 'c-error' }]}
          format={(v) => formatCount(v ?? 0, { compact: true })}
          label="Occurrences of this issue over time"
          height={140}
        />
      </Card>

      <div className="grid-2 issue-grid">
        <Card
          title="Latest occurrence"
          actions={
            latest && (
              <button type="button" className="button small" onClick={() => openLog(latest.ref)}>
                Open in Logs
              </button>
            )
          }
        >
          {!latest ? (
            <Empty>The events of this issue have passed the retention period.</Empty>
          ) : (
            <>
              <Fields
                rows={[
                  ['Time', formatFullTime(latest.time)],
                  ['Message', latest.message || '–'],
                  [
                    'Error',
                    [latest.errorType, latest.errorMessage].filter(Boolean).join(': ') || '–',
                  ],
                  ['Request id', latest.requestId ? <code key="r">{latest.requestId}</code> : '–'],
                ]}
              />
              <h3>Stack trace</h3>
              {latest.errorStack ? (
                <StackTrace stack={latest.errorStack} />
              ) : (
                <p className="muted">
                  No stack trace was logged. Log the error object itself (
                  <code>{'logger.error({ err }, …)'}</code>) to get one.
                </p>
              )}
              <h3>Attributes</h3>
              <Json value={latest.attrs} />
            </>
          )}
        </Card>

        <Card title="Where it happens">
          {routes.items.length === 0 ? (
            <Empty>
              {routes.sampled === 0
                ? 'No occurrences in this time range.'
                : 'None of these errors could be linked to a request (they carry no request id).'}
            </Empty>
          ) : (
            <>
              <table className="table">
                <tbody>
                  {routes.items.map((r) => (
                    <tr key={`${r.method} ${r.route}`}>
                      <td>
                        <span className="method">{r.method}</span> <code>{r.route}</code>
                      </td>
                      <td className="num">{formatCount(r.count)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="muted small">
                From the {formatCount(routes.sampled)} most recent occurrences,{' '}
                {formatCount(routes.withRequest)} of which are linked to a request.
              </p>
            </>
          )}
          <details className="grouping">
            <summary>Why these events are grouped together</summary>
            <pre className="code">{issue.groupingKey}</pre>
          </details>
        </Card>
      </div>

      <Card title="Recent occurrences">
        {occurrences.length === 0 ? (
          <Empty>No occurrences in this time range.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table stack-mobile">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Error</th>
                  <th>Request</th>
                </tr>
              </thead>
              <tbody>
                {occurrences.map((o) => (
                  <tr key={o.ref} className="clickable" onClick={() => openLog(o.ref)}>
                    <td className="nowrap muted">{formatEventTime(o.time)}</td>
                    <td className="wide">
                      <div className="log-message">
                        {o.errorMessage ?? o.message}
                        {o.errorMessage && o.message && o.errorMessage !== o.message && (
                          <span className="muted small"> · {o.message}</span>
                        )}
                      </div>
                    </td>
                    <td className="nowrap">
                      {o.request ? (
                        <button
                          type="button"
                          className="link small"
                          onClick={(e) => {
                            e.stopPropagation();
                            openRequest(o.request!.ref);
                          }}
                        >
                          {o.request.method} {o.request.path}
                        </button>
                      ) : (
                        <span className="muted">–</span>
                      )}{' '}
                      {o.request && <StatusBadge status={o.request.status} />}{' '}
                      {o.request && (
                        <span className="muted small">{formatDuration(o.request.durationMs)}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
