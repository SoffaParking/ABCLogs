import { LEVEL_NAMES, type LevelName } from '@apiloupe/shared';
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { api, type LogItem, type Page, type RequestItem } from '../api';
import { SearchBox } from '../components/filters';
import { StackTrace } from '../components/StackTrace';
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
  Segmented,
  Spinner,
  StatusBadge,
} from '../components/ui';
import { formatDuration, formatEventTime, formatFullTime } from '../format';
import { useQueryState } from '../hooks';
import { rangeParams } from '../range';
import { ServiceFilter } from './Overview';

/** A compact list of log lines, used inside the request and log drawers. */
export function LogList({
  logs,
  onOpen,
  current,
}: {
  logs: LogItem[];
  onOpen: (ref: string) => void;
  current?: string;
}) {
  return (
    <ul className="log-list">
      {logs.map((log) => (
        <li key={log.ref}>
          <button
            type="button"
            className={`log-line ${log.ref === current ? 'selected' : ''}`}
            onClick={() => onOpen(log.ref)}
          >
            <span className="muted nowrap">{formatEventTime(log.time)}</span>
            <LevelBadge level={log.level} />
            <span className="log-message">
              {log.message || <span className="muted">(no message)</span>}
              {log.errorMessage && log.errorMessage !== log.message && (
                <span className="log-error">
                  {log.errorType ? `${log.errorType}: ` : ''}
                  {log.errorMessage}
                </span>
              )}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function isLevel(value: string | null): value is LevelName {
  return value !== null && (LEVEL_NAMES as readonly string[]).includes(value);
}

export function LogsPage({ slug }: { slug: string }) {
  const [params, patch] = useQueryState();
  const refetchInterval = useRefreshInterval();
  const range = params.get('range');
  const service = params.get('service') ?? '';
  const minLevel: LevelName = isLevel(params.get('minLevel'))
    ? (params.get('minLevel') as LevelName)
    : 'info';
  const q = params.get('q') ?? '';
  const requestId = params.get('requestId') ?? '';
  const errorsOnly = params.get('errorsOnly') === 'true';
  const open = params.get('open');
  const live = params.get('live') === '1';

  const list = useInfiniteQuery({
    queryKey: ['logs', slug, range, service, minLevel, q, requestId, errorsOnly],
    queryFn: ({ pageParam }) =>
      api.get<Page<LogItem>>(`/projects/${slug}/logs`, {
        ...rangeParams(range),
        service,
        minLevel,
        q,
        requestId,
        errorsOnly: errorsOnly || undefined,
        cursor: pageParam,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval,
    placeholderData: keepPreviousData,
    enabled: !live,
  });
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="page">
      <div className="page-header">
        <h1>Logs</h1>
        <ServiceFilter slug={slug} value={service} onChange={(v) => patch({ service: v })} />
      </div>
      <div className="filters">
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
        <SearchBox
          label="Search messages"
          placeholder="Search messages and errors…"
          value={q}
          onChange={(v) => patch({ q: v })}
        />
        <SearchBox
          label="Request id"
          placeholder="Request id"
          value={requestId}
          onChange={(v) => patch({ requestId: v })}
        />
        <label className="check">
          <input
            type="checkbox"
            checked={errorsOnly}
            onChange={(e) => patch({ errorsOnly: e.target.checked ? 'true' : null })}
          />
          With an error only
        </label>
        <button
          type="button"
          className={`button small ${live ? 'on' : ''}`}
          aria-pressed={live}
          title="Show new log lines as they arrive"
          onClick={() => patch({ live: live ? null : '1' })}
        >
          {live ? '■ Stop live tail' : '▶ Live tail'}
        </button>
      </div>

      {live ? (
        <LiveTail
          slug={slug}
          filters={{ service, minLevel, q, requestId, errorsOnly: errorsOnly || undefined }}
          open={open}
          onOpen={(ref) => patch({ open: ref })}
          onRequest={(id) => patch({ requestId: id, minLevel: 'trace', q: null })}
        />
      ) : (
        <Card className={list.isPlaceholderData ? 'stale' : ''}>
          {list.isPending ? (
            <Spinner />
          ) : list.isError ? (
            <ErrorNote error={list.error} />
          ) : items.length === 0 ? (
            <Empty>No log lines at {minLevel} or above match in this time range.</Empty>
          ) : (
            <LogTable
              items={items}
              open={open}
              onOpen={(ref) => patch({ open: ref })}
              onRequest={(id) => patch({ requestId: id, minLevel: 'trace', q: null })}
            />
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
      )}

      {open && (
        <LogDrawer
          slug={slug}
          reference={open}
          onOpen={(ref) => patch({ open: ref })}
          onClose={() => patch({ open: null })}
        />
      )}
    </div>
  );
}

/** The log table, shared by the paged list and the live tail. */
function LogTable({
  items,
  open,
  onOpen,
  onRequest,
}: {
  items: LogItem[];
  open: string | null;
  onOpen: (ref: string) => void;
  onRequest: (requestId: string) => void;
}) {
  return (
    <div className="table-wrap">
      <table className="table stack-mobile">
        <thead>
          <tr>
            <th>Time</th>
            <th>Level</th>
            <th>Message</th>
            <th>Request</th>
          </tr>
        </thead>
        <tbody>
          {items.map((log) => (
            <tr
              key={log.ref}
              className={`clickable ${open === log.ref ? 'selected' : ''}`}
              onClick={() => onOpen(log.ref)}
            >
              <td className="nowrap muted">
                {formatEventTime(log.time)}
                {log.weight && <SampledBadge weight={log.weight} />}
              </td>
              <td>
                <LevelBadge level={log.level} />
              </td>
              <td className="wide">
                <div className="log-message">
                  {log.message || <span className="muted">(no message)</span>}
                  {log.errorMessage && log.errorMessage !== log.message && (
                    <span className="log-error">
                      {log.errorType ? `${log.errorType}: ` : ''}
                      {log.errorMessage}
                    </span>
                  )}
                </div>
              </td>
              <td className="nowrap">
                {log.requestId ? (
                  <button
                    type="button"
                    className="link small"
                    title="Show every log line of this request"
                    onClick={(e) => {
                      e.stopPropagation();
                      onRequest(log.requestId!);
                    }}
                  >
                    {log.requestId.length > 14 ? `${log.requestId.slice(0, 14)}…` : log.requestId}
                  </button>
                ) : (
                  <span className="muted">–</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A sampled event stands for several: say how many. */
export function SampledBadge({ weight }: { weight: number }) {
  return (
    <span
      className="sampled"
      title={`Sampled: this event stands for ${weight} like it in the charts`}
    >
      {' '}
      ×{weight}
    </span>
  );
}

const TAIL_EVERY_MS = 2000;
const TAIL_KEEP = 500;

interface TailFilters {
  service: string;
  minLevel: string;
  q: string;
  requestId: string;
  errorsOnly: boolean | undefined;
}

/**
 * New log lines as they arrive, newest at the top, in arrival order. Polls
 * every two seconds from a cursor; the server re-sends a little overlap and
 * lines already shown are dropped here.
 */
function LiveTail({
  slug,
  filters,
  open,
  onOpen,
  onRequest,
}: {
  slug: string;
  filters: TailFilters;
  open: string | null;
  onOpen: (ref: string) => void;
  onRequest: (requestId: string) => void;
}) {
  const [items, setItems] = useState<LogItem[]>([]);
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [polledAt, setPolledAt] = useState<number | null>(null);
  const cursor = useRef<string | null>(null);
  const seen = useRef(new Set<string>());
  const filterKey = JSON.stringify(filters);

  useEffect(() => {
    // New filters: start over.
    cursor.current = null;
    seen.current = new Set();
    setItems([]);
  }, [slug, filterKey]);

  useEffect(() => {
    if (paused) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const res = await api.get<{ items: LogItem[]; cursor: string }>(
          `/projects/${slug}/logs/tail`,
          {
            ...(JSON.parse(filterKey) as TailFilters),
            since: cursor.current,
          },
        );
        if (stopped) return;
        cursor.current = res.cursor;
        const fresh = res.items.filter((item) => !seen.current.has(item.ref));
        for (const item of fresh) seen.current.add(item.ref);
        if (seen.current.size > TAIL_KEEP * 10)
          seen.current = new Set([...seen.current].slice(-TAIL_KEEP * 2));
        if (fresh.length > 0) setItems((prev) => [...fresh, ...prev].slice(0, TAIL_KEEP));
        setError(null);
        setPolledAt(Date.now());
      } catch (err) {
        if (!stopped) setError(err);
      }
      if (!stopped) timer = setTimeout(() => void tick(), TAIL_EVERY_MS);
    };
    void tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [slug, filterKey, paused]);

  return (
    <Card
      title={
        <span className="tail-title">
          <span className={paused ? 'tail-dot paused' : 'tail-dot'} aria-hidden="true" />
          {paused ? 'Live tail paused' : 'Live tail'}
        </span>
      }
      actions={
        <>
          <span className="muted small" aria-live="polite">
            {items.length} lines
            {polledAt ? ` · checked ${new Date(polledAt).toLocaleTimeString()}` : ''}
          </span>
          <button type="button" className="button small" onClick={() => setPaused(!paused)}>
            {paused ? 'Resume' : 'Pause'}
          </button>
          <button type="button" className="button small" onClick={() => setItems([])}>
            Clear
          </button>
        </>
      }
    >
      <ErrorNote error={error} />
      {items.length === 0 ? (
        <Empty>Waiting for new log lines that match… they appear here as they arrive.</Empty>
      ) : (
        <LogTable items={items} open={open} onOpen={onOpen} onRequest={onRequest} />
      )}
    </Card>
  );
}

function LogDrawer({
  slug,
  reference,
  onOpen,
  onClose,
}: {
  slug: string;
  reference: string;
  onOpen: (ref: string) => void;
  onClose: () => void;
}) {
  const [params] = useQueryState();
  const [, navigate] = useLocation();
  const detail = useQuery({
    queryKey: ['log', slug, reference],
    queryFn: () =>
      api.get<{ log: LogItem; request: RequestItem | null; related: LogItem[] }>(
        `/projects/${slug}/logs/${encodeURIComponent(reference)}`,
      ),
  });
  return (
    <Drawer title="Log line" onClose={onClose}>
      {detail.isPending ? (
        <Spinner />
      ) : detail.isError ? (
        <ErrorNote error={detail.error} />
      ) : (
        <>
          <div className="drawer-title-line">
            <LevelBadge level={detail.data.log.level} />{' '}
            {detail.data.log.message || <span className="muted">(no message)</span>}
          </div>
          <Fields
            rows={[
              ['Time', formatFullTime(detail.data.log.time)],
              ['Service', detail.data.log.service || '–'],
              [
                'Request id',
                detail.data.log.requestId ? (
                  <span key="id" className="inline">
                    <code>{detail.data.log.requestId}</code>{' '}
                    <CopyButton text={detail.data.log.requestId} />
                  </span>
                ) : (
                  '–'
                ),
              ],
            ]}
          />
          {detail.data.log.issueId != null && (
            <p>
              <Link
                href={linkWith(`/p/${slug}/issues/${detail.data.log.issueId}`, params)}
                className="button small"
              >
                Open the issue this error belongs to →
              </Link>
            </p>
          )}
          {(detail.data.log.errorType ||
            detail.data.log.errorMessage ||
            detail.data.log.errorStack) && (
            <>
              <h3>Error</h3>
              <p className="error-title">
                {detail.data.log.errorType && <strong>{detail.data.log.errorType}</strong>}
                {detail.data.log.errorType && detail.data.log.errorMessage ? ': ' : ''}
                {detail.data.log.errorMessage}
              </p>
              {detail.data.log.errorStack && <StackTrace stack={detail.data.log.errorStack} />}
            </>
          )}
          <h3>Attributes</h3>
          <Json value={detail.data.log.attrs} />
          {detail.data.request && (
            <>
              <h3>The request</h3>
              <button
                type="button"
                className="request-link"
                onClick={() =>
                  navigate(
                    linkWith(`/p/${slug}/requests`, params, { open: detail.data.request!.ref }),
                  )
                }
              >
                <span className="method">{detail.data.request.method}</span>{' '}
                <code>{detail.data.request.path}</code>{' '}
                <StatusBadge status={detail.data.request.status} />{' '}
                <span className="muted">{formatDuration(detail.data.request.durationMs)}</span>
              </button>
            </>
          )}
          {detail.data.related.length > 1 && (
            <>
              <h3>Every log line of this request</h3>
              <LogList logs={detail.data.related} onOpen={onOpen} current={reference} />
            </>
          )}
        </>
      )}
    </Drawer>
  );
}
