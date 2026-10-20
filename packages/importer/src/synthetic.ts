/**
 * Synthetic logs shaped like a real Node API's pino output (request lines,
 * error lines tied to failed requests, warnings, the odd plain-text line), for
 * the demo and the tests. Deterministic for a given seed. Never real data.
 */

export interface SyntheticOptions {
  /** The end of the generated window, epoch ms. Defaults to now. */
  now?: number;
  /** How far back the window starts. */
  minutes?: number;
  /** Average requests per minute. */
  requestsPerMinute?: number;
  seed?: number;
  service?: string;
}

interface RouteSpec {
  method: string;
  path: (r: () => number) => string;
  weight: number;
  /** Median duration, ms. */
  ms: number;
  /** Probability of each failing status. */
  failures: [status: number, p: number][];
}

const ROUTES: RouteSpec[] = [
  {
    method: 'GET',
    path: () => '/api/parking/current',
    weight: 30,
    ms: 18,
    failures: [[403, 0.04]],
  },
  {
    method: 'GET',
    path: () => '/api/parking/occupancy',
    weight: 12,
    ms: 25,
    failures: [[403, 0.03]],
  },
  { method: 'GET', path: () => '/api/users', weight: 10, ms: 60, failures: [] },
  {
    method: 'GET',
    path: (r) => `/api/users/${1000 + Math.floor(r() * 9000)}`,
    weight: 10,
    ms: 22,
    failures: [[404, 0.05]],
  },
  {
    method: 'GET',
    path: () => '/api/whitelist/desired',
    weight: 8,
    ms: 140,
    failures: [[500, 0.01]],
  },
  {
    method: 'POST',
    path: () => '/api/sync/import',
    weight: 8,
    ms: 210,
    failures: [
      [409, 0.02],
      [503, 0.015],
    ],
  },
  {
    method: 'POST',
    path: () => '/api/auth/login',
    weight: 5,
    ms: 95,
    failures: [
      [401, 0.12],
      [429, 0.01],
    ],
  },
  { method: 'GET', path: () => '/api/promotions', weight: 5, ms: 35, failures: [] },
  {
    method: 'GET',
    path: () => '/api/access-logs',
    weight: 6,
    ms: 650,
    failures: [
      [500, 0.03],
      [504, 0.01],
    ],
  },
  {
    method: 'POST',
    path: (r) => `/api/gates/${1 + Math.floor(r() * 9)}/open`,
    weight: 4,
    ms: 300,
    failures: [[502, 0.04]],
  },
  { method: 'GET', path: () => '/api/companies/3/members', weight: 2, ms: 400, failures: [] },
];

const SERVER_ERRORS: Record<number, string[]> = {
  500: [
    'ER_LOCK_WAIT_TIMEOUT: Lock wait timeout exceeded; try restarting transaction',
    "Cannot read properties of undefined (reading 'plate')",
    'Pool is closed.',
  ],
  502: ['camera did not answer the barrier request'],
  503: ['too many sync imports in flight'],
  504: ['query exceeded the 20 s deadline'],
};

const INFO_MESSAGES = [
  'whitelist rebuild started',
  'whitelist rebuild finished',
  'scheduled report sent',
  'sync agent heartbeat',
  'session auto-closed after max stay',
];

const WARN_MESSAGES = [
  'slow query',
  'camera answered late',
  'retrying payment gateway call',
  'tenant rate limit reached',
];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(r: () => number, items: readonly T[]): T {
  return items[Math.floor(r() * items.length)]!;
}

/** Log-normal-ish duration around a median, with a long tail. */
function duration(r: () => number, median: number): number {
  const u = Math.max(r(), 1e-9);
  const v = r();
  const normal = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return Math.max(1, Math.round(median * Math.exp(0.6 * normal)));
}

export function synthesizeLines(options: SyntheticOptions = {}): string[] {
  const now = options.now ?? Date.now();
  const minutes = options.minutes ?? 120;
  const rpm = options.requestsPerMinute ?? 40;
  const service = options.service ?? 'parking-backend';
  const r = mulberry32(options.seed ?? 42);
  const totalWeight = ROUTES.reduce((sum, route) => sum + route.weight, 0);
  const lines: { time: number; line: string }[] = [];
  let requestNumber = 0;

  const emit = (time: number, fields: Record<string, unknown>, msg: string, level: number) => {
    lines.push({
      time,
      line: JSON.stringify({ level, time: new Date(time).toISOString(), service, ...fields, msg }),
    });
  };

  const start = Math.floor((now - minutes * 60_000) / 60_000) * 60_000;
  for (let m = 0; m < minutes; m++) {
    const minuteStart = start + m * 60_000;
    const count = Math.max(0, Math.round(rpm * (0.7 + r() * 0.6)));
    for (let i = 0; i < count; i++) {
      const time = minuteStart + Math.floor(r() * 60_000);
      if (time >= now) continue;
      let roll = r() * totalWeight;
      const route = ROUTES.find((spec) => (roll -= spec.weight) < 0) ?? ROUTES[0]!;
      let status = route.method === 'POST' ? 201 : 200;
      if (route.method === 'GET' && r() < 0.04) status = 304;
      for (const [failure, p] of route.failures) if (r() < p) status = failure;
      const durationMs = status >= 500 ? duration(r, route.ms * 3) : duration(r, route.ms);
      const requestId = `req-${(++requestNumber).toString(36)}-${Math.floor(r() * 1e6).toString(36)}`;
      const path = route.path(r);
      const level = status >= 500 ? 50 : status >= 400 ? 40 : 30;
      if (status >= 500) {
        const err = pick(r, SERVER_ERRORS[status] ?? ['unexpected error']);
        emit(time + durationMs - 1, { err, path, requestId, status }, 'Request error', 50);
      }
      if (route.ms > 300 && r() < 0.1) {
        emit(time + 1, { requestId, durationMs, companyId: 3 }, 'slow query', 40);
      }
      emit(
        time + durationMs,
        { requestId, method: route.method, path, status, durationMs },
        'request',
        level,
      );
    }
    if (r() < 0.5)
      emit(minuteStart + Math.floor(r() * 60_000), { companyId: 3 }, pick(r, INFO_MESSAGES), 30);
    if (r() < 0.15) emit(minuteStart + Math.floor(r() * 60_000), {}, pick(r, WARN_MESSAGES), 40);
    if (r() < 0.05)
      emit(
        minuteStart + Math.floor(r() * 60_000),
        { cacheHits: Math.floor(r() * 100) },
        'cache stats',
        20,
      );
  }

  // One crash, one stray console line and a couple of blank lines: real log
  // files have them, and the importer has to cope.
  const crash = start + Math.floor(minutes / 2) * 60_000 + 30_000;
  emit(
    crash,
    {
      err: {
        type: 'TypeError',
        message: "Cannot read properties of null (reading 'id')",
        stack:
          "TypeError: Cannot read properties of null (reading 'id')\n    at closeSession (/app/src/services/sessionService.js:212:31)\n    at async reconcile (/app/src/jobs/reconciler.js:88:7)",
      },
    },
    'uncaughtException',
    60,
  );
  lines.push({ time: crash + 1, line: 'DB init failed: connect ECONNREFUSED 10.0.0.12:3306' });
  lines.push({ time: crash + 2, line: '' });

  return lines
    .filter((entry) => entry.time < now)
    .sort((a, b) => a.time - b.time)
    .map((entry) => entry.line);
}
