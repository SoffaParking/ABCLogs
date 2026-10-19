# Architecture

apiloupe is one server process plus Postgres.

```
 your app ── @apiloupe/node (SDK) ──┐
                                   ├─► POST /ingest/v1/events ─► Postgres ◄─ /api/v1/* ◄─ dashboard
 existing logs ── apiloupe-import ──┘
```

- **Ingest** (`/ingest/v1`): authenticated by a per-project key, accepts
  batches of request and log events, deduplicates by event id, and writes raw
  events plus per-minute rollups in one transaction.
- **Storage:** raw events in day-partitioned tables, so old data is dropped a
  partition at a time; rollups with latency histograms for fast charts;
  grouped errors ("issues") keyed by a fingerprint.
- **Query API** (`/api/v1`): what the dashboard reads, behind a sign-in.
- **Dashboard:** a React app the server serves as static files.

Every severity is stored on pino's numeric scale (trace 10 … fatal 60), so a
verbosity filter is always `level >= N`. `packages/shared` holds that mapping
and the other rules every package must agree on.

This document grows with each milestone; see the roadmap in the README.
