# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Bounded async queue** — `asyncMaxQueueSize` (default 10000) caps the events waiting to be written. When it is full, async `emit()` waits for room (`asyncQueueFullBehavior: "wait"`, the default) or drops the event and reports a `QueueFullError` to `onError` (`"drop"`). Before, the queue had no limit: 200k queued events used ~240 MB.
- **`onPoolError`** — `error` events from the PostgreSQL pool (e.g. an idle connection killed by the server) are now reported, by default with `console.error`. Before, they were silently discarded, including on injected pools that had their own listener.
- **Transactional emits** — `emit(event, { client })` and `emitDiff(event, { client })` write through the given `pg` client, so the audit row commits or rolls back with your own transaction. These writes are always synchronous.

### Fixed

- **Upgrade with oversized legacy values** — upgrading a `001`-only table whose rows hold `outcome` / `error.code` / `severity` longer than the generated columns allow now fails with `SchemaUpgradeError`, naming the row counts and the fix `UPDATE`, instead of a bare "value too long" from `ALTER TABLE`.

### Fixed

- **Upgrading older schemas** — `bootstrap.ensureSchema` now adds the generated `outcome`, `error_code` and `severity` columns to tables created by `sql/001` only. Before, `startTracevault` failed with `column "error_code" does not exist`.
- **Concurrent startup** — schema bootstrap runs under a PostgreSQL advisory lock, so several replicas starting at once no longer fail with `duplicate key value violates unique constraint "pg_type_typname_nsp_index"`.
- **Long table names** — index names that would exceed 63 chars now use a shortened, hashed prefix. Before, PostgreSQL truncated them, they collided, and most indexes were silently skipped. Names that already fit are unchanged.
- **`close()` lost async events with `asyncFlushIntervalMs > 0`** — `flush()`/`close()` waited behind the unref'd interval timer, so a script ending with `await audit.close()` could exit before writing anything. They now drain immediately.
- **Closed scopes leaked** — `scope().close()` now removes the scope from the root, so creating and closing scopes per request no longer grows memory.
- **Values PostgreSQL refuses now fail validation** — NUL characters (in `data`/`meta` and identifiers) and unpaired UTF-16 surrogates in `data`/`meta` throw `ValidationError` from `emit()`. Before, they failed at the database: a `DriverError` in sync mode, or an `onError` call in async mode. The payload check runs after masking, so masked fields are not rejected.

### Changed

- **Async mode writes batches with one multi-row `INSERT`** (up to `asyncBatchSize` rows). If a batch fails it is retried row by row, so `onError` still receives only the records that failed.
- **`AuditDriverClient`** gains `insertMany(records)`.

### Added

- GitHub Actions CI: lint, typecheck, unit tests and smoke on Node 18/20/22, plus the Postgres integration suite.

## [1.0.1] - 2026-05-14

### Added

- **`startTracevault` pool injection** — optional **`pool`** and **`readPool`** (`pg.Pool`) so DDL (`bootstrap.ensureSchema`), writes, and reads use the same driver configuration as the host app (TLS / RDS CA, custom `ssl`, pools from `@flash/pg-config`, …). DDL uses `pool.connect()` / `client.release()` instead of a separate `pg.Client` when a pool is supplied.
- **`assertPgPoolLike`** — exported helper that validates a value has pool-like **`.query`** and **`.connect`** (for tests or adapters).

### Changed

- **`close()`** on the app calls **`pool.end()`** only for pools Tracevault created. If you pass **`pool`** / **`readPool`**, you own their lifecycle: call **`await audit.close()`** first (drain queues, release internal state), then end the pool(s) yourself if you are shutting down the process.

### Validation

- **`readPool`** requires **`pool`** (both injected).
- With a single injected write **`pool`** (no **`readPool`**), **`readConnectionString`** must match **`connectionString`** or be omitted — use **`readPool`** for a physical replica URL.

## [1.0.0] - 2026-05-14

### Added

- **`startTracevault`**: single application entry point — optional idempotent DDL (`bootstrap.ensureSchema`), named `scopes`, separate **write** and **read** `pg.Pool`s (`readConnectionString` optional; defaults to the write URL for local use), integrated **`query`** (`findMany`, `findById`, `count`) on the app and on each `getScope(name)` handle.
- **`audit-ddl`**: shared DDL statements used by `generateInitSql` and runtime bootstrap.
- **`assertValidScopeName`** and runtime validation of `startTracevault` options.

### Changed

- **Public API** is now centered on `startTracevault` / `TracevaultApp`. Types and helpers that previously lived only under `tracevault/query` (`AuditRecord`, `TracevaultQuery`, severity constants, …) are re-exported from the main **`tracevault`** entry.

### Removed

- **`createTracevault`**, **`createTracevaultQuery`**, and the **`tracevault/query`** package subpath — they are no longer part of the supported public surface (internal modules may still use the underlying factories for tests).

### Migration from 0.4.x

1. Replace `createTracevault` + `createTracevaultQuery` with one `await startTracevault({ connectionString, readConnectionString?, defaultScope, scopes, … })`.
2. Replace `root.scope({ tableName })` with `getScope("logicalName")` and declare the mapping in `scopes`.
3. Replace `query.*` imports with `app.query` or `app.getScope("x").query`.
4. Either rely on `bootstrap.ensureSchema` or keep applying `sql/` / `generateInitSql` yourself (`ensureSchema: false`).

## [0.4.0] - 2026-05-12

### Added

- **SQL migrations** [`002_audit_logs_outcome_error_code.sql`](./sql/002_audit_logs_outcome_error_code.sql) and [`003_audit_logs_severity.sql`](./sql/003_audit_logs_severity.sql): PostgreSQL `STORED` generated columns `outcome`, `error_code`, and `severity` (from `data`), with partial indexes for correlation timelines, error/outcome dashboards, and severity scans.
- **Read API** (`tracevault/query`): filters `outcome`, `errorCode`, `severity`, `severities` (SQL `IN`), and `errorsOnly` (rows with `outcome = 'failure'` or `severity` in `error` / `critical` / `fatal`). `AuditRecord` includes `outcome`, `errorCode`, `severity`.
- **Write-side helpers** (main export): `randomCorrelationId`, `readCorrelationIdHeader`, `resolveCorrelationId`.
- **Query exports** for consoles: `DOCUMENTED_SEVERITY_LEVELS`, `SEVERITIES_FOR_ERRORS_ONLY_FILTER`, type `DocumentedSeverity`.
- **`generateInitSql`**: DDL for a new table now matches running migrations **001** through **003** (single combined script).

### Changed

- Integration bootstrap [`scripts/apply-migration.mjs`](./scripts/apply-migration.mjs) applies **001 + 002 + 003** when testing against the default `audit_logs` table.

### Migration notes

- Existing databases that already ran **001** only: apply **002**, then **003**, in order (or replace `"audit_logs"` in the SQL files if you use a custom table name).
- Existing databases that ran **001 + 002**: apply **003** only.
- Greenfield: run all three migrations, or pipe `generateInitSql("your_table")` into your migration runner.

## [0.3.0] and earlier

Prior releases did not maintain this changelog file; see git history for earlier changes.
