# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Repository scaffold: pnpm workspace with `shared`, `server` and `ui`
  packages, strict TypeScript, ESLint, Prettier and Vitest.
- Level normalisation shared by every package: pino numbers and common names
  (`warning`, `critical`, `verbose`, …) mapped onto trace / debug / info /
  warn / error / fatal.
- Server with `/healthz` (process up) and `/readyz` (Postgres reachable), a
  strict content security policy, and hosting for the built dashboard.
- Docker image and `docker-compose.yml` (app + Postgres 17).
- GitHub Actions CI.
