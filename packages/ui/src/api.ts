import type { LevelName } from '@apiloupe/shared';

/** An error response from the server, with its HTTP status. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type Params = Record<string, string | number | boolean | null | undefined>;

function withParams(path: string, params?: Params): string {
  if (!params) return path;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `${path}?${query}` : path;
}

/** Called on every 401, so the app can drop back to the sign-in screen. */
let onUnauthorized: () => void = () => undefined;
export function setUnauthorizedHandler(handler: () => void): void {
  onUnauthorized = handler;
}

async function call<T>(method: string, path: string, body?: unknown, params?: Params): Promise<T> {
  const res = await fetch(withParams(`/api/v1${path}`, params), {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const data: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth/')) onUnauthorized();
    const message =
      typeof data === 'object' && data !== null && 'error' in data
        ? String(data.error)
        : res.statusText;
    throw new ApiError(res.status, message);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string, params?: Params) => call<T>('GET', path, undefined, params),
  post: <T>(path: string, body: unknown = {}) => call<T>('POST', path, body),
  patch: <T>(path: string, body: unknown) => call<T>('PATCH', path, body),
  delete: <T = void>(path: string) => call<T>('DELETE', path),
};

export type Role = 'admin' | 'member';

export interface User {
  id: number;
  email: string;
  name: string;
  role: Role;
}

export interface AuthState {
  setupRequired: boolean;
  user: User | null;
}

export interface Project {
  id: number;
  slug: string;
  name: string;
  createdAt: string;
  lastIngestAt: string | null;
}

export interface IngestKey {
  id: number;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface Overview {
  from: string;
  to: string;
  stepSeconds: number;
  totals: {
    requests: number;
    perMinute: number;
    status: Record<'2xx' | '3xx' | '4xx' | '5xx', number>;
    clientErrorRate: number;
    serverErrorRate: number;
    avgMs: number | null;
    p50: number | null;
    p95: number | null;
    p99: number | null;
  };
  series: {
    t: string;
    '2xx': number;
    '3xx': number;
    '4xx': number;
    '5xx': number;
    p50: number | null;
    p95: number | null;
  }[];
  routes: {
    method: string;
    route: string;
    count: number;
    clientErrors: number;
    serverErrors: number;
    avgMs: number | null;
    p50: number | null;
    p95: number | null;
  }[];
}

export interface Levels {
  from: string;
  to: string;
  stepSeconds: number;
  totals: Record<LevelName, number>;
  series: ({ t: string } & Record<LevelName, number>)[];
}

export interface RequestItem {
  ref: string;
  time: string;
  service: string;
  level: number;
  method: string;
  route: string;
  path: string;
  status: number;
  durationMs: number | null;
  requestId: string | null;
  attrs?: unknown;
}

export interface LogItem {
  ref: string;
  time: string;
  service: string;
  level: number;
  message: string;
  requestId: string | null;
  errorType: string | null;
  errorMessage: string | null;
  hasStack?: boolean;
  errorStack?: string | null;
  attrs?: unknown;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface Facets {
  services: string[];
  routes: { method: string; route: string; count: number }[];
}
