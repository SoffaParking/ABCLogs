import { LEVEL_NAMES, type LevelName } from '@apiloupe/shared';
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
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
      </div>

      <Card>
        {list.isPending ? (
          <Spinner />
        ) : list.isError ? (
          <ErrorNote error={list.error} />
        ) : items.length === 0 ? (
          <Empty>No log lines at {minLevel} or above match in this time range.</Empty>
        ) : (
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
                    onClick={() => patch({ open: log.ref })}
                  >
                    <td className="nowrap muted">{formatEventTime(log.time)}</td>
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
                    <td>
                      {log.requestId ? (
                        <button
                          type="button"
                          className="link small"
                          title="Show every log line of this request"
                          onClick={(e) => {
                            e.stopPropagation();
                            patch({ requestId: log.requestId, minLevel: 'trace', q: null });
                          }}
                        >
                          {log.requestId.length > 14
                            ? `${log.requestId.slice(0, 14)}…`
                            : log.requestId}
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
