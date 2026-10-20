# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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
