import { LEVEL, LEVEL_NAMES, type LevelName } from '@apiloupe/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link, useLocation } from 'wouter';
import { api, type Facets, type Levels, type Overview, type TopIssues } from '../api';
import { LineChart, StackedBars, type Series } from '../components/charts';
import { linkWith, useRefreshInterval } from '../components/Shell';
import { Card, Empty, ErrorNote, LevelBadge, Segmented, Spinner, Stat } from '../components/ui';
import { formatAgo, formatCount, formatDuration, formatPercent, formatRate } from '../format';
import { useQueryState } from '../hooks';
import { rangeParams } from '../range';

const STATUS_SERIES: Series[] = [
  { key: '2xx', label: '2xx', className: 'c-2xx' },
  { key: '3xx', label: '3xx', className: 'c-3xx' },
  { key: '4xx', label: '4xx', className: 'c-4xx' },
  { key: '5xx', label: '5xx', className: 'c-5xx' },
];

const LATENCY_SERIES: Series[] = [
  { key: 'p50', label: 'p50', className: 'c-p50' },
  { key: 'p95', label: 'p95', className: 'c-p95' },
];

const LEVEL_SERIES: Series[] = LEVEL_NAMES.map((name) => ({
  key: name,
  label: name,
  className: `c-${name}`,
}));

function isLevel(value: string | null): value is LevelName {
  return value !== null && (LEVEL_NAMES as readonly string[]).includes(value);
}

/** The service picker, shown only when a project reports more than one. */
export function ServiceFilter({
  slug,
  value,
  onChange,
}: {
  slug: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const [params] = useQueryState();
  const facets = useQuery({
    queryKey: ['facets', slug, params.get('range')],
    queryFn: () => api.get<Facets>(`/projects/${slug}/facets`, rangeParams(params.get('range'))),
    staleTime: 60_000,
  });
  const services = facets.data?.services ?? [];
  if (services.length < 2 && !value) return null;
  return (
    <select aria-label="Service" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">All services</option>
      {services.map((s) => (
        <option key={s} value={s}>
          {s || '(unnamed)'}
        </option>
      ))}
    </select>
  );
}

export function OverviewPage({ slug }: { slug: string }) {
  const [params, patch] = useQueryState();
  const [, navigate] = useLocation();
  const refetchInterval = useRefreshInterval();
  const range = params.get('range');
  const service = params.get('service') ?? '';
  const minLevel: LevelName = isLevel(params.get('minLevel'))
    ? (params.get('minLevel') as LevelName)
    : 'info';
  const kind = params.get('kind') ?? 'all';

  const overview = useQuery({
    queryKey: ['overview', slug, range, service],
    queryFn: () =>
      api.get<Overview>(`/projects/${slug}/overview`, { ...rangeParams(range), service }),
    refetchInterval,
    placeholderData: keepPreviousData,
  });
  const levels = useQuery({
    queryKey: ['levels', slug, range, service, kind],
    queryFn: () =>
      api.get<Levels>(`/projects/${slug}/levels`, {
        ...rangeParams(range),
        service,
        kind: kind === 'all' ? undefined : kind,
      }),
    refetchInterval,
    placeholderData: keepPreviousData,
  });

  const topIssues = useQuery({
    queryKey: ['top-issues', slug, range],
    queryFn: () => api.get<TopIssues>(`/projects/${slug}/issues/top`, rangeParams(range)),
    refetchInterval,
    placeholderData: keepPreviousData,
  });

  if (overview.isPending || levels.isPending) return <Spinner />;
  if (overview.isError) return <ErrorNote error={overview.error} />;
  if (levels.isError) return <ErrorNote error={levels.error} />;

  const o = overview.data;
  const l = levels.data;
  const levelTotal = Object.values(l.totals).reduce((a, b) => a + b, 0);
  const visibleLevels = LEVEL_SERIES.filter((s) => LEVEL[s.key as LevelName] >= LEVEL[minLevel]);
  const spanMinutes = (Date.parse(o.to) - Date.parse(o.from)) / 60_000;

  if (o.totals.requests === 0 && levelTotal === 0 && !service) {
    return (
      <Card title="No data in this time range">
        <Empty>
          <p>Nothing has arrived for this project in the selected range.</p>
          <p>
            Pick a longer range above, or{' '}
            <Link href={`/settings/projects/${slug}`}>create an ingest key</Link> and send some
            events.
          </p>
        </Empty>
      </Card>
    );
  }

  return (
    <div className="page">
      <div className="page-header">
        <h1>Overview</h1>
        <ServiceFilter slug={slug} value={service} onChange={(v) => patch({ service: v })} />
      </div>

      <div className="stats">
        <Stat
          label="Requests"
          value={formatCount(o.totals.requests, { compact: true })}
          sub={`${formatRate(o.totals.perMinute)} / min`}
        />
        <Stat
          label="Server errors (5xx)"
          value={formatPercent(o.totals.serverErrorRate)}
          sub={`${formatCount(o.totals.status['5xx'])} requests`}
          tone={o.totals.serverErrorRate > 0.01 ? 'bad' : undefined}
        />
        <Stat
          label="Client errors (4xx)"
          value={formatPercent(o.totals.clientErrorRate)}
          sub={`${formatCount(o.totals.status['4xx'])} requests`}
          tone={o.totals.clientErrorRate > 0.1 ? 'warn' : undefined}
        />
        <Stat
          label="Median (p50)"
          value={formatDuration(o.totals.p50)}
          sub={`avg ${formatDuration(o.totals.avgMs)}`}
        />
        <Stat
          label="p95"
          value={formatDuration(o.totals.p95)}
          sub={`p99 ${formatDuration(o.totals.p99)}`}
        />
      </div>

      <div className="grid-2">
        <Card title="Requests by status">
          <StackedBars
            data={o.series}
            series={STATUS_SERIES}
            format={(v) => formatCount(v ?? 0, { compact: true })}
            label="Requests by status class over time"
          />
          <Legend series={STATUS_SERIES} totals={o.totals.status} />
        </Card>
        <Card title="Latency">
          <LineChart
            data={o.series}
            series={LATENCY_SERIES}
            format={formatDuration}
            label="p50 and p95 latency over time"
          />
          <Legend series={LATENCY_SERIES} />
        </Card>
      </div>

      <Card
        title="Events by severity"
        actions={
          <>
            <Segmented
              label="Source"
              value={kind}
              onChange={(v) => patch({ kind: v === 'all' ? null : v })}
              options={[
                { value: 'all', label: 'All' },
                { value: 'request', label: 'Requests' },
                { value: 'log', label: 'Logs' },
              ]}
            />
            <span className="muted small">Show</span>
            <Segmented
              label="Minimum level"
              value={minLevel}
              onChange={(v) => patch({ minLevel: v === 'info' ? null : v })}
              options={LEVEL_NAMES.map((name) => ({
                value: name,
                label: name === 'trace' ? 'all' : `${name}+`,
                className: `level-${name}`,
              }))}
            />
          </>
        }
      >
        <StackedBars
          data={l.series}
          series={visibleLevels}
          format={(v) => formatCount(v ?? 0, { compact: true })}
          label="Events by severity over time"
        />
        <div className="level-totals">
          {LEVEL_SERIES.map((s) => {
            const name = s.key as LevelName;
            const hidden = LEVEL[name] < LEVEL[minLevel];
            return (
              <button
                key={name}
                type="button"
                className={`level-total ${hidden ? 'hidden' : ''}`}
                title={`Open ${name} and above in Logs`}
                onClick={() => navigate(linkWith(`/p/${slug}/logs`, params, { minLevel: name }))}
              >
                <span className={`swatch ${s.className}`} />
                <span>{name}</span>
                <strong>{formatCount(l.totals[name], { compact: true })}</strong>
              </button>
            );
          })}
        </div>
      </Card>

      <Card
        title="Top issues"
        actions={
          <Link href={linkWith(`/p/${slug}/issues`, params)} className="small">
            {topIssues.data && topIssues.data.newIssues > 0
              ? `${topIssues.data.newIssues} new in this range · all issues →`
              : 'All issues →'}
          </Link>
        }
      >
        {!topIssues.data ? (
          <Spinner />
        ) : topIssues.data.items.length === 0 ? (
          <Empty>No unresolved errors in this time range.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <tbody>
                {topIssues.data.items.map((issue) => (
                  <tr
                    key={issue.id}
                    className="clickable"
                    onClick={() => navigate(linkWith(`/p/${slug}/issues/${issue.id}`, params))}
                  >
                    <td className="wide">
                      <LevelBadge level={issue.level} />{' '}
                      <span className="issue-title-text">{issue.title}</span>
                      {issue.culprit && (
                        <div className="muted small">
                          <code>{issue.culprit}</code>
                        </div>
                      )}
                    </td>
                    <td className="num">
                      {formatCount(issue.rangeCount)} <span className="muted small">events</span>
                    </td>
                    <td className="muted nowrap small">{formatAgo(issue.lastSeen)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Top routes">
        {o.routes.length === 0 ? (
          <Empty>No requests in this range.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Route</th>
                  <th className="num">Requests</th>
                  <th className="num">4xx</th>
                  <th className="num">5xx</th>
                  <th className="num">p50</th>
                  <th className="num">p95</th>
                </tr>
              </thead>
              <tbody>
                {o.routes.map((r) => (
                  <tr
                    key={`${r.method} ${r.route}`}
                    className="clickable"
                    onClick={() =>
                      navigate(
                        linkWith(`/p/${slug}/requests`, params, {
                          method: r.method,
                          route: r.route,
                        }),
                      )
                    }
                  >
                    <td>
                      <span className="method">{r.method}</span> <code>{r.route}</code>
                    </td>
                    <td className="num">
                      {formatCount(r.count)}
                      <span className="muted small">
                        {' '}
                        {formatRate(r.count / Math.max(spanMinutes, 1))}/min
                      </span>
                    </td>
                    <td className={`num ${r.clientErrors / r.count > 0.1 ? 'tone-warn' : ''}`}>
                      {formatPercent(r.clientErrors / r.count)}
                    </td>
                    <td className={`num ${r.serverErrors > 0 ? 'tone-bad' : ''}`}>
                      {formatPercent(r.serverErrors / r.count)}
                    </td>
                    <td className="num">{formatDuration(r.p50)}</td>
                    <td className="num">{formatDuration(r.p95)}</td>
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

function Legend({ series, totals }: { series: Series[]; totals?: Record<string, number> }) {
  return (
    <div className="legend">
      {series.map((s) => (
        <span key={s.key} className="legend-item">
          <span className={`swatch ${s.className}`} />
          {s.label}
          {totals && <strong>{formatCount(totals[s.key] ?? 0, { compact: true })}</strong>}
        </span>
      ))}
    </div>
  );
}
