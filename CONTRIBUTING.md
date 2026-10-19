# Contributing to apiloupe

Thanks for helping. This is a young project, so issues that describe a real
use case are as valuable as code.

## Setting up

```sh
corepack enable
pnpm install
pnpm db:up
pnpm dev
```

Node.js 22 or newer is required. Corepack picks the pinned pnpm version from
`package.json`.

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
