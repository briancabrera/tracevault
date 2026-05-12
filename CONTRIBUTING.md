# Contributing to Tracevault

Thanks for taking the time to contribute. This guide covers the local
development loop and the two test suites.

## Requirements

- Node.js ≥ 18
- npm ≥ 9
- Docker & Docker Compose v2 (only for the integration suite)

## Install

```bash
npm install
```

## Project layout

```
src/
  core/           factory, validator, normalizer, masker, differ, queue, errors, serialization, schema, correlation
  drivers/        driver interface + PostgreSQL driver
  query/          Read API (query.ts, builder, reader, validator, severity constants)
  types/          public types
  index.ts        public exports

tests/
  *.test.ts                       unit tests (no external deps)
  integration/*.integration.test.ts  real-DB integration tests

CHANGELOG.md                      release notes
sql/001_init_audit_logs.sql       initial migration
sql/002_audit_logs_outcome_error_code.sql  generated outcome/error_code + indexes
sql/003_audit_logs_severity.sql   generated severity + index
docker/docker-compose.yml         PostgreSQL for integration tests
scripts/apply-migration.mjs       waits for PG + applies 001 + 002 + 003 to audit_logs
scripts/run-integration.mjs       up → migrate → test → down orchestrator
scripts/smoke.mjs                 post-build consumption smoke test
examples/express                  runnable Express demo
```

## Scripts

| Command                              | What it does                                               |
| ------------------------------------ | ---------------------------------------------------------- |
| `npm run build`                      | Build `dist/` with tsup (ESM + CJS + d.ts)                 |
| `npm run typecheck`                  | `tsc --noEmit`                                             |
| `npm run lint`                       | ESLint over `src` and `tests`                              |
| `npm run format`                     | Prettier rewrite                                           |
| `npm run test` / `npm run test:unit` | Unit tests (fast, in-memory mocks for `pg`)                |
| `npm run test:watch`                 | Unit tests in watch mode                                   |
| `npm run test:integration`           | Full up → migrate → run → down sequence (cleans up on failure) |
| `npm run test:all`                   | Unit + integration                                         |
| `npm run smoke`                      | Builds `dist/` and asserts the CJS + ESM entrypoints expose the documented API |

## Running integration tests

```bash
npm run test:integration
```

A single command that spins up a PostgreSQL 16 Alpine container on port
`5433` with `POSTGRES_DB=tracevault_test`, applies
`sql/001_init_audit_logs.sql` and `sql/002_audit_logs_outcome_error_code.sql` and
`sql/003_audit_logs_severity.sql`,
runs the `tests/integration/**` suite, and
tears everything down — even if the tests fail or the run is interrupted
with Ctrl-C.

If you want to point at an existing database instead, override the
connection string and call Vitest directly:

```bash
TEST_DATABASE_URL=postgres://user:pass@host:port/db \
  npx vitest run --config vitest.integration.config.ts
```

## Coding conventions

- Keep the public API small. New surface area needs a strong justification.
- Prefer small, single-purpose functions. Avoid clever code.
- No decorators, no ORMs, no "framework" features.
- Comments should explain *why*, not *what*. Don't narrate the code.
- Strict TypeScript (`strict: true`, `noUncheckedIndexedAccess: true`).

## Opening a PR

Before pushing, make sure the following all succeed:

```bash
npm run lint
npm run typecheck
npm run test:unit
npm run smoke           # build + verify built entrypoints
```

If your change touches persistence or masking, please also run the integration
suite (`npm run test:integration`) and include the result in the PR description.
