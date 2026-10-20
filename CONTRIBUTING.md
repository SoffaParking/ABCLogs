# Contributing to apiloupe

Thanks for helping. This is a young project, so issues that describe a real
use case are as valuable as code.

## Setting up

```sh
corepack enable
pnpm install
cp .env.example .env
pnpm db:up
pnpm dev
```

Node.js 22 or newer is required. Corepack picks the pinned pnpm version from
`package.json`.

The server's database tests create a throwaway database per test file. They
run when `TEST_DATABASE_URL` points at a Postgres user allowed to create
databases (the one from `pnpm db:up` is), and are skipped otherwise. CI always
runs them.

The browser tests (`pnpm build && pnpm test:e2e`) start the built server on a
fresh database and drive every page in Chromium; run
`pnpm --filter @apiloupe/e2e exec playwright install chromium` once first, or
set `PW_CHANNEL=chrome` to use your installed Chrome. They fail on any console
error or content security policy violation.
`pnpm --filter @apiloupe/e2e screenshots` regenerates the README's images.

## Before opening a pull request

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm format:check
```

CI runs the same commands, plus a Docker build.

## Guidelines

- **One change per pull request**, with a description of why, not only what.
- **Tests come with behaviour.** A bug fix includes a test that fails without
  it.
- **The SDK must never hurt its host.** Anything in `packages/sdk-node` must
  not throw into, block, or crash the application that installed it.
- **Privacy by default.** Nothing that could hold personal data (request
  bodies, query strings, IPs, headers) is collected unless the user turns it
  on, and redaction applies when they do.
- **Never commit real logs.** Test fixtures are synthetic.
- Keep changes formatted with Prettier (`pnpm format`).

## Commit messages

Short, imperative subject lines (`fix(ingest): reject batches over 1000
events`). Conventional prefixes (`feat`, `fix`, `docs`, `chore`, `test`) are
welcome but not enforced.

## Code of conduct

Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).
