# apiloupe

**Self-hosted dashboard for your API's requests and errors.** See request
volume, latency and status codes, slice everything by severity with a single
"show this level and above" control, and get identical errors folded into
issues you can resolve.

> **Status: early development (M0).** The repository, build, Docker image and
> CI are in place; the ingest API and dashboard pages land in the next
> milestone. See the [roadmap](#roadmap).

## What it will do

- **Requests:** requests per minute, error rate, p50 / p95 latency and status
  classes, per route.
- **Severity breakdown:** counts by level (trace → fatal) with a verbosity
  filter that hides everything below the level you pick.
- **Error details:** message, stack trace, and the request that caused it,
  linked by request id.
- **Grouped errors:** the same error folded into one issue with a count, first
  and last seen, and a trend.
- **Two ways in:** a small Node.js SDK (Express middleware and a pino
  destination), or an importer for the JSON logs you already write (files,
  stdin, AWS CloudWatch).

## Quick start

Requirements: Docker with Compose.

```sh
git clone https://github.com/emaalouf/apiloupe.git
cd apiloupe
docker compose up -d
```

Open <http://localhost:8080>. `GET /healthz` reports the process is up and
`GET /readyz` reports it can reach Postgres.

Before running it anywhere but your own machine, change `POSTGRES_PASSWORD`
(and `DATABASE_URL` to match) in `docker-compose.yml`, and set `PUBLIC_URL` to
the https address people will use.

## Configuration

| Variable       | Default    | Meaning                                                             |
| -------------- | ---------- | ------------------------------------------------------------------- |
| `DATABASE_URL` | none       | Postgres connection string. Postgres 15 or newer.                   |
| `PORT`         | `8080`     | HTTP port.                                                          |
| `HOST`         | `0.0.0.0`  | Interface to listen on.                                             |
| `PUBLIC_URL`   | none       | The dashboard's public address. When https, enables HSTS.           |
| `LOG_LEVEL`    | `info`     | The server's own log level.                                         |
| `PUBLIC_DIR`   | `./public` | Where the built dashboard is served from (set by the Docker image). |

## Development

Requirements: Node.js 22+ and Corepack (bundled with Node).

```sh
corepack enable
pnpm install
pnpm db:up          # Postgres in Docker
pnpm dev            # server on :8080, dashboard on :5173
pnpm lint && pnpm typecheck && pnpm test
```

The repository is a pnpm workspace:

| Package           | Contents                                                        |
| ----------------- | --------------------------------------------------------------- |
| `packages/shared` | Event schema, level normalisation, helpers shared by all others |
| `packages/server` | Ingest API, query API, and host for the built dashboard         |
| `packages/ui`     | The dashboard (React + Vite)                                    |

The Node SDK (`@apiloupe/node`) and the importer (`apiloupe-import`) join the
workspace in their milestones.

## Roadmap

| Milestone | Scope                                                                                 |
| --------- | ------------------------------------------------------------------------------------- |
| M0        | Repository, tooling, CI, Docker image, health checks                                  |
| M1        | Ingest API, overview with severity filter, requests and logs pages, importer, sign-in |
| M2        | Node.js SDK: Express middleware and pino destination                                  |
| M3        | Grouped errors: issues, resolve and ignore, regressions, trends                       |
| M4        | AWS CloudWatch import with resume                                                     |
| M5        | Live tail, sampling, end-to-end tests, 1.0                                            |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Please report security issues as
described in [SECURITY.md](SECURITY.md), not in public issues.

## License

[MIT](LICENSE)
