# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
