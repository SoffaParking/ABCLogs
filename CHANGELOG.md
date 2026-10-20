# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.1.0] - 2026-10-20

### Changed

- The project is now called **Soffa API Logs Dashboard**: the dashboard's
  header and browser tab, the sign-in and setup pages, Settings, the server's
  `/api/v1/meta` name, the SDK's warnings, the command-line help, the
  deployment scripts' messages and the docs all use the new name.
- Nothing technical changed name, so existing installs, integrations and
  scripts keep working: the repository, the Docker image
  (`ghcr.io/emaalouf/apiloupe`), the packages and commands (`@apiloupe/node`,
  `apiloupe-import`, `apiloupe-server`), the `APILOUPE_*` settings, cookies
  and the `alk_` ingest keys are unchanged.

## [1.0.0] - 2026-10-20

### Added

- **Live tail:** new log lines appear on the Logs page as they arrive, with
  the page's filters, pause and clear.
- **Sampling:** `sampleRate` in `@apiloupe/node` and `--sample-rate` in the
  importer send a share of successful requests and routine logs (never
  errors, warnings or failed requests); the server counts each sampled event
  as 1/rate everywhere, so totals, latency, severity and issues stay right.
  The choice depends only on the event's id, so live shipping and a backfill
  at the same rate keep the same lines and nothing is counted twice. Sampled
  events show what they stand for (×10).
- **Browser tests** (Playwright): first-run setup and every page, driven in
  Chromium in CI. Any console error or content security policy violation
  fails the run.
- **Release images:** each version tag publishes `ghcr.io/emaalouf/apiloupe`
  for amd64 and arm64, and `@apiloupe/node` to npm when a token is set.
- The server reports its version (`/api/v1/meta`, Settings).
- Screenshots in the README, generated from the demo data by the browser
  tests.

### Upgrading

- Migration 003 adds an index and a `weight` column to the event tables;
  it runs by itself at start-up.

## [0.4.1] - 2026-10-20

### Added

- `deploy/ec2`: one command launches apiloupe on a small EC2 server (Ubuntu
  24.04, arm64) with Caddy for HTTPS, Postgres sized for 2 GB, a nightly
  `pg_dump` kept for 7 days, SSH open to your address only, IMDSv2 and an
  encrypted disk. `upgrade.sh` moves the server to another release.

## [0.4.0] - 2026-10-20

### Added

- `apiloupe-import --cloudwatch`: imports AWS CloudWatch Logs directly, with
  the usual AWS credentials (profiles, SSO, roles, environment). Reads in
  one-hour windows and checkpoints after each fully accepted window, so an
  interrupted import resumes where it stopped; `--follow` keeps importing new
  logs. Filters by stream prefix and CloudWatch filter pattern.
- Lines wrapped by Docker's json-file driver or FireLens are unwrapped before
  import, so their ids match the same lines shipped live.
- Lines without a timestamp take their source's time (CloudWatch's), keeping
  re-imports idempotent.

## [0.3.0] - 2026-10-20

### Added

- Issues: every error and fatal log line grouped with the ones like it (same
  service, error type and app stack frames, or the same masked message when
  there is no stack). Issues list with trend lines and resolve / ignore /
  reopen; issue page with the latest stack trace (your own frames
  highlighted), recent occurrences with the requests they hit, the routes
  affected, and why the events were grouped.
- Regressions: a resolved issue that happens again reopens and is marked.
- Top issues on the overview; links from error log lines to their issue.
- `apiloupe-server reprocess-issues` regroups stored errors.

### Upgrading

- Errors stored by 0.1 or 0.2 are grouped into issues automatically when
  0.3 starts (the server log says so per project). Ingest of errors pauses
  while that runs.

## [0.2.0] - 2026-10-20

### Added

- `@apiloupe/node`, the Node.js SDK: Express middleware (requests with route,
  status, duration and request id), an Express error handler, a pino stream
  (every log line, the same ids as the importer so live and backfilled lines
  are stored once), `log` and `captureException`. Bounded queue, gzip
  batches, retries with `Retry-After`, never throws or holds the process
  open. No runtime dependencies; CommonJS and ESM; Node 20+.
- `examples/express-pino`, a small app wired to apiloupe.
- Node.js setup snippet on the project settings page.

## [0.1.0] - 2026-10-20

### Added

- Ingest API (`POST /ingest/v1/events`): per-project keys, gzip bodies,
  batches of up to 1000 events checked one by one, idempotent writes, rate
  limits and back-pressure.
- Storage: day-partitioned raw events with retention, per-minute rollups with
  latency histograms, a per-project route cap.
- Dashboard: overview (traffic, error rates, p50/p95/p99, top routes), severity
  breakdown with a "show this level and above" control, requests and logs
  pages with filters, and request ↔ log linking by request id.
- Accounts: first-run setup guarded by a code from the server log, email and
  password sign-in, admins and members, invite links, password change, and
  `apiloupe-server create-admin` / `reset-password`.
- `apiloupe-import`: imports pino-style JSON logs from files, gzipped files or
  standard input; `--demo` sends synthetic traffic.
- Redaction of secrets in attributes and messages, on the way in.
- CI runs the database tests on Postgres 15, 17 and 18, and an end-to-end
  check of the Docker image.

### Changed

- The compose file maps Postgres to host port 5433, so it does not collide
  with a local Postgres.

### Added in M0

- Repository scaffold: pnpm workspace with `shared`, `server` and `ui`
  packages, strict TypeScript, ESLint, Prettier and Vitest.
- Level normalisation shared by every package: pino numbers and common names
  (`warning`, `critical`, `verbose`, …) mapped onto trace / debug / info /
  warn / error / fatal.
- Server with `/healthz` (process up) and `/readyz` (Postgres reachable), a
  strict content security policy, and hosting for the built dashboard.
- Docker image and `docker-compose.yml` (app + Postgres 17).
- GitHub Actions CI.
