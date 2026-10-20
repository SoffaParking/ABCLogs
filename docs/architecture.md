# Architecture

apiloupe is one server process plus Postgres.

```
 your app ── @apiloupe/node (SDK) ──────┐
                                        ├─► POST /ingest/v1/events ─► Postgres ◄─ /api/v1/* ◄─ dashboard
 existing logs ── apiloupe-import ──────┘
```

## Events

There are two kinds of event, both with a time, a service, a level and an
optional request id:

- a **request**: method, path, route, status, duration;
- a **log** line: message, plus an error type, message and stack when it has one.

Every level is stored on pino's numeric scale (trace 10 … fatal 60), so a
verbosity filter is always `level >= N`. `packages/shared` holds that mapping
and every other rule the packages must agree on: how a JSON log line becomes
an event (`mapLogLine`), redaction, path-to-route folding, and the latency
histogram.

## Ingest

`POST /ingest/v1/events` (see [ingest-api.md](ingest-api.md)):

1. The key is checked (cached for a minute; revoking clears it at once).
2. The batch is rate-limited per key, in events.
3. Each event is validated on its own; invalid ones are reported back by index.
4. Routes are capped per project so ids in route names cannot explode the
   rollups.
5. One transaction inserts the raw events with `ON CONFLICT DO NOTHING`, then
   updates the per-minute rollups **from the rows actually inserted**. That is
   what makes resending harmless: a duplicate is neither stored nor counted.

Event ids make deduplication work across senders: the importer uses a hash of
the log line, so a line shipped live by the SDK and the same line imported
from a file later are one event.

A write gate bounds how many batches hit the database at once; beyond its
queue, senders get `503` with `Retry-After` instead of piling up.

## The Node.js SDK

`@apiloupe/node` records events into a fixed-size ring buffer and sends them
in gzip batches on a timer, one request at a time. The hot path is a single
buffer write: the middleware notes method, path, route, status and duration
on `finish`; the pino stream stores the raw line, which is parsed only when
the batch is built, with the same `mapLogLine` and line-hash id the importer
uses. Background sends do not keep the process alive; `flush` and `shutdown`
do, up to their deadline. The package is bundled (shared code included) into
one CommonJS and one ESM file with no runtime dependencies.

## The importer

`apiloupe-import` turns each line into an event with `mapLogLine` and an id
that is a hash of the line, after taking off a log shipper's envelope (Docker
json-file, FireLens). That id is what makes imports repeatable and lets a
backfill overlap with live shipping: the server stores an id once.

From CloudWatch Logs it calls `FilterLogEvents` for one-hour windows, page by
page, and writes a checkpoint (atomically: temp file, then rename) once every
event of a window has been accepted. Resumed and `--follow` reads start a few
minutes before the checkpoint and stay a couple of minutes behind now, so
events CloudWatch indexes late are still read; the overlap only produces
duplicates, which cost nothing. Lines without a time of their own take
CloudWatch's timestamp, so re-imports keep the same id and time.

## Storage

- `request_events`, `log_events`: raw events, **partitioned by UTC day**.
  Partitions are created on demand (the first event of a day creates it) and
  dropped whole once the day is past `RETENTION_DAYS`.
- `rollup_requests_1m`: per minute, service, method, route and status: count,
  duration sum and max, and a 24-bucket latency histogram. Histograms add up,
  so any time range or group of routes gets its percentiles from the summed
  histogram, exact to within one bucket.
- `rollup_levels_1m`: per minute, service, kind and level: count. The severity
  chart reads this.
- `projects`, `ingest_keys` (only a SHA-256 of each key), `project_routes`,
  `ingest_stats_hourly`.
- `users` (scrypt password hashes), `sessions` (only a SHA-256 of each
  token), `invites`.

Charts read only the rollups. Lists and detail views read the raw events by
their primary key `(project_id, time, id)`, newest first with keyset paging.

Housekeeping runs at boot and every 15 minutes: next day's partition,
retention, expired sessions. With several server processes, one does it.

## Issues

Every log event at error level or above belongs to an issue. The grouping
(`packages/shared/src/grouping.ts`) is, with a stack trace: service, error
type and the top five frames of the app's own code (node_modules and the
runtime left out), without line or column numbers and with paths cut to their
last two segments, so redeploying moved or relocated code does not split an
issue. Without a stack: service, type and the message with numbers, ids,
emails and addresses masked. The key is stored readable, and the issue page
shows it.

Ingest assigns issues in the same transaction as the events: it locks the
batch's existing issues in fingerprint order, inserts only groups never seen
before (so issue numbers stay dense), and then updates counts, first and last
seen and hourly counts from the rows actually inserted. A resolved issue whose
new occurrence is newer than its resolution reopens and is marked regressed;
a backfilled older event does not reopen it.

`apiloupe-server reprocess-issues` regroups stored events after the rules
change. An issue with unchanged grouping keeps its id and status; a new group
inherits the status of the old issue most of its events came from. At boot,
errors stored before issues existed are grouped the same way. Issues outlive
their events: they are kept for four times the retention period after they
were last seen, so a long-quiet issue that comes back is still a regression.

## Dashboard API and sign-in

`/api/v1/*` is what the dashboard reads. Sessions are an HttpOnly,
SameSite=Strict cookie (`__Host-` prefixed and Secure behind https). State
changes also need a same-origin `Origin` header. Logins are rate-limited per IP
and per email, and a wrong email costs the same time as a wrong password.

Until the first account exists, setup requires a code printed in the server
log, so whoever reaches a fresh server first cannot claim it.

## Dashboard

React, with hand-written SVG charts (no chart library), served by the same
server under a strict content security policy: nothing loads from other
origins, and no inline scripts or styles.
