# apiloupe

**Self-hosted dashboard for your API's requests and errors.** See request
volume, latency and status codes, slice everything by severity with a single
"show this level and above" control, and follow any failed request to the log
lines and stack trace it produced.

> **Status: 0.2 (milestone M2).** Ingest, the dashboard, sign-in, the log
> importer and the Node.js SDK work. Grouped errors and native CloudWatch
> import are next; see the [roadmap](#roadmap).

## What it does

- **Overview:** requests per minute, 4xx and 5xx rates, p50 / p95 / p99
  latency, requests by status over time, and the busiest routes with their
  error rates and latency.
- **Severity breakdown:** every event counted by level (trace → fatal), with a
  verbosity control that hides everything below the level you pick, for
  requests, logs, or both.
- **Requests:** filter by method, route, status, level, duration, path or
  request id; open one to see every log line written while serving it.
- **Logs:** filter by minimum level, search messages and errors, see the stack
  trace and the request behind each error.
- **Sign-in:** email and password accounts, admins and members, invite links.
- **Your logs as they are:** an importer that reads the JSON logs you already
  write (pino, pino-http, bunyan and most JSON loggers), from files or a pipe.
  Importing the same lines twice stores them once.
- **Privacy by default:** request bodies, query strings, headers and IPs are
  dropped unless you ask for them, and passwords, tokens and card numbers are
  masked before anything is stored.

## Quick start

Requirements: Docker with Compose.

```sh
git clone https://github.com/emaalouf/apiloupe.git
cd apiloupe
docker compose up -d
docker compose logs app | grep 'setup code'
```

The app prints the setup code a few seconds after it starts, so if the `grep`
finds nothing, wait a moment and run it again.

Open <http://localhost:8080>, enter the setup code from the log, and create the
first admin. Then create a project and an ingest key (the dashboard walks you
through it).

To see the dashboard with data straight away, send two hours of synthetic
traffic:

```sh
docker compose exec app apiloupe-import --demo 120 --key alk_...
```

Before running it anywhere but your own machine, change `POSTGRES_PASSWORD`
(and `DATABASE_URL` to match) in `docker-compose.yml`, put it behind a TLS
proxy, and set `PUBLIC_URL` to the https address people will use.

## Sending data

**From a Node.js app**, with [`@apiloupe/node`](packages/sdk-node) (no
dependencies; CommonJS and ESM):

```js
const { createApiloupe } = require('@apiloupe/node');
const apiloupe = createApiloupe({
  endpoint: process.env.APILOUPE_ENDPOINT,
  key: process.env.APILOUPE_KEY,
});

app.use(apiloupe.express()); // every request
const logger = pino(
  opts,
  pino.multistream([
    { stream: process.stdout },
    { stream: apiloupe.pinoStream({ requests: false }) }, // every log line
  ]),
);
```

It never throws into your app, costs microseconds per request, keeps its queue
bounded when apiloupe is down, and does nothing until both settings are
present. [examples/express-pino](examples/express-pino) is a complete app.

**Existing log files.** `apiloupe-import` reads JSON log lines from files
(gzipped or not) or standard input:

```sh
apiloupe-import --endpoint https://apiloupe.example.com --key alk_... app.log app.log.1.gz
kubectl logs deploy/api | apiloupe-import --key alk_...
```

A line with a method, a path and a status code becomes a **request**; any
other line becomes a **log** event, with its error and stack trace when it has
one. Lines that are not JSON are skipped unless you pass `--plain-text`.
`--dry-run` shows what would be sent. Inside the Docker image the importer is
already installed; from a clone, run `pnpm import-logs …`.

From **AWS CloudWatch Logs** (native import is on the roadmap):

```sh
aws logs filter-log-events --log-group-name /ecs/my-api --start-time 1760000000000 \
  --output json | jq -r '.events[].message' | apiloupe-import --key alk_...
```

**Anything else** can post events directly. See the
[ingest API](docs/ingest-api.md):

```sh
curl -X POST https://apiloupe.example.com/ingest/v1/events \
  -H 'Authorization: Bearer alk_...' -H 'Content-Type: application/json' \
  -d '{"events":[{"type":"log","time":"2026-10-20T12:00:00Z","level":"error","message":"payment failed","requestId":"r-42"}]}'
```

## Configuration

| Variable                   | Default    | Meaning                                                                   |
| -------------------------- | ---------- | ------------------------------------------------------------------------- |
| `DATABASE_URL`             | required   | Postgres connection string. Postgres 15 or newer.                         |
| `PORT`                     | `8080`     | HTTP port.                                                                |
| `HOST`                     | `0.0.0.0`  | Interface to listen on.                                                   |
| `PUBLIC_URL`               | none       | The dashboard's public address. When https: HSTS and Secure cookies.      |
| `TRUST_PROXY`              | `false`    | Trust `X-Forwarded-*` from a reverse proxy (for client IPs and https).    |
| `RETENTION_DAYS`           | `14`       | Days of events kept. Older days are dropped a whole partition at a time.  |
| `SETUP_CODE`               | random     | The first-run setup code. When unset, a random one is printed in the log. |
| `INGEST_EVENTS_PER_SECOND` | `10000`    | Rate limit per ingest key; bursts of five seconds' worth are allowed.     |
| `INGEST_CONCURRENCY`       | `4`        | Batches written at once; more queue, and past the queue senders get 503.  |
| `MAX_ROUTES_PER_PROJECT`   | `1000`     | Distinct routes per project; further routes are counted as `(other)`.     |
| `LOG_LEVEL`                | `info`     | The server's own log level.                                               |
| `PUBLIC_DIR`               | `./public` | Where the built dashboard is served from (set by the Docker image).       |

## Accounts

The first admin is created in the browser with the setup code. After that,
admins invite people from **Settings → Users**: apiloupe makes a one-time link
for you to pass on (it sends no email). Members can see every project; admins
can also manage projects, keys and users.

From the command line (`docker compose exec -T app …` in Docker):

```sh
echo 'a long password' | apiloupe-server create-admin --email you@example.com
echo 'a new password'  | apiloupe-server reset-password --email you@example.com
```

## Development

Requirements: Node.js 22+ and Corepack (bundled with Node).

```sh
corepack enable
pnpm install
cp .env.example .env
pnpm db:up          # Postgres in Docker, on localhost:5433
pnpm dev            # server on :8080, dashboard on :5173
pnpm demo --key alk_...
pnpm lint && pnpm typecheck && pnpm test
```

The database tests need `TEST_DATABASE_URL` (see `.env.example`); without it
they are skipped.

| Package             | Contents                                                             |
| ------------------- | -------------------------------------------------------------------- |
| `packages/shared`   | Event format, levels, log-line mapping, redaction, latency histogram |
| `packages/server`   | Ingest API, dashboard API, accounts, and host for the built UI       |
| `packages/ui`       | The dashboard (React + Vite)                                         |
| `packages/importer` | `apiloupe-import`                                                    |

See [docs/architecture.md](docs/architecture.md) for how the pieces fit.

## Roadmap

| Milestone | Scope                                                                                 | Status |
| --------- | ------------------------------------------------------------------------------------- | ------ |
| M0        | Repository, tooling, CI, Docker image, health checks                                  | done   |
| M1        | Ingest API, overview with severity filter, requests and logs pages, importer, sign-in | done   |
| M2        | Node.js SDK: Express middleware and pino destination                                  | done   |
| M3        | Grouped errors: issues, resolve and ignore, regressions, trends                       |        |
| M4        | AWS CloudWatch import with resume                                                     |        |
| M5        | Live tail, sampling, end-to-end browser tests, 1.0                                    |        |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Please report security issues as
described in [SECURITY.md](SECURITY.md), not in public issues.

## License

[MIT](LICENSE)
