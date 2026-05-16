# Tracevault

> **Tracevault is a lightweight audit event library for Node.js that lets developers define their own events while persisting them in a consistent and reliable way.**

```ts
await audit.emit({
  event: "product.price.updated",
  actor:  { id: "user_123",    type: "user" },
  target: { id: "product_456", type: "product" },
  data:   { oldPrice: 120, newPrice: 150, currency: "UYU" },
  meta:   { source: "admin-panel", ip: "127.0.0.1" },
});
```

---

## Why Tracevault

Most audit libraries try to impose a rigid event catalog, a prescribed diff shape,
or a compliance taxonomy. Tracevault intentionally doesn't.

> **Tracevault does not define your event catalog.
> It gives you a consistent, reliable way to store your custom audit events.**

You keep full control over:

- **what** each event is called (`product.price.updated`, `auth.login.failed`, …),
- **who** the actor is,
- **what** sits in `data` and `meta`.

Tracevault only guarantees the boring-but-crucial part: validation, masking,
normalization, and persistence.

## Philosophy

- **Custom by default** — you define the events, not the library.
- **Structured by design** — a small, stable persisted shape.
- **Minimalist** — a tiny public API, no decorators, no magic, no ORM coupling.
- **Reliable** — strict validation, recursive masking, explicit sync/async modes.
- **Typed** — strong TypeScript types without gymnastics.

## Features

- `emit()` for any custom event — you own the schema of `data` and `meta`.
- `emitDiff()` helper computes a shallow field diff and stores `{ before, after, diff }`.
- **Strict input validation** — non-JSON values (BigInt, functions, symbols,
  NaN, cycles, class instances) are rejected with clear paths.
- **Recursive, cycle-safe masking** for sensitive fields (`password`, `token`, …).
- **Sync** persistence (write-through) or **async** persistence (in-process queue).
- **PostgreSQL** driver with `JSONB`-first, event-oriented schema.
- **Multi-table audits** — logical scope names map to physical tables; `getScope("users")` shares the same write/read pools as the root.
- **Optional shared `pg.Pool`** — pass **`pool`** (and optionally **`readPool`**) so schema bootstrap and auditing reuse your TLS/RDS/`ssl` configuration instead of opening bare clients from URLs alone.
- **Narrow Read API** on the same app object (`audit.query`) — equality filters (including
  generated `outcome` / `errorCode` / `severity`), `errorsOnly` shorthand,
  `severities` list filter, time windows, deterministic pagination, per-scope
  readers. No DSL, no magic.
- **Correlation helpers** — `randomCorrelationId`, `readCorrelationIdHeader`,
  `resolveCorrelationId` for consistent `correlationId` on emits.
- **Optional generated columns** (PostgreSQL migrations **002**–**003**) —
  `outcome`, `error_code`, and `severity` derived from `data` for indexed reads
  without losing custom events.
- **Idempotent lifecycle** — `close()` is safe to call multiple times.
- **Zero runtime dependencies** beyond `pg`.

## Installation

```bash
npm install tracevault pg
```

### Database schema

By default, **`startTracevault`** runs idempotent DDL for every physical table listed in `scopes` (same shape as `generateInitSql`). Set `bootstrap: { ensureSchema: false }` if your migrations own the schema.

You can still apply SQL manually:

```bash
psql "$DATABASE_URL" -f node_modules/tracevault/sql/001_init_audit_logs.sql
psql "$DATABASE_URL" -f node_modules/tracevault/sql/002_audit_logs_outcome_error_code.sql
psql "$DATABASE_URL" -f node_modules/tracevault/sql/003_audit_logs_severity.sql
```

Shipped SQL lives under `sql/` in the package. **001** creates the table; **002**
adds optional STORED generated columns `outcome` and `error_code` (derived from
`data`) plus supporting indexes; **003** adds generated `severity` from
`data.severity` plus an index. Greenfield projects can instead run
`generateInitSql("audit_logs")` once for an equivalent combined DDL.

> If you use a custom `tableName`, run **001** with the name substituted, then
> adapt **002** and **003** (replace `"audit_logs"`) or use `generateInitSql("your_table")`.

## Quick start

```ts
import { startTracevault } from "tracevault";

const audit = await startTracevault({
  driver: "postgres",
  connectionString: process.env.DATABASE_URL_WRITE!,
  readConnectionString: process.env.DATABASE_URL_READ,
  defaultScope: "default",
  scopes: {
    default: { tableName: "audit_logs" },
    users: { tableName: "audit_user_events" },
  },
  bootstrap: { ensureSchema: true },
  maskFields: ["password", "token", "pin", "biometricData"],
  defaultMode: "sync",
  environment: process.env.NODE_ENV,
});

await audit.emit({
  event: "auth.login.succeeded",
  actor: { id: "user_123", type: "user" },
  meta: { ip: "127.0.0.1", userAgent: "curl/8" },
});

const userRows = await audit.getScope("users").query.findMany({
  event: "user.profile.updated",
  limit: 20,
});

await audit.close();
```

Use **`readConnectionString`** with a PostgreSQL role that has only `SELECT` on the audit tables; the write URL should carry `INSERT` (and DDL if `ensureSchema` is enabled).

### `emit`

```ts
await audit.emit({
  event: "product.price.updated",
  actor:  { id: "user_123",    type: "user" },
  target: { id: "product_456", type: "product" },
  data:   { oldPrice: 120, newPrice: 150, currency: "UYU" },
  meta:   { source: "admin-panel", ip: "127.0.0.1" },
  correlationId: "req_abc",
  requestId: "req_abc",
  // occurredAt: new Date(),
  // mode: "async",
});
```

Only `event` is required. Everything else is optional.

### `emitDiff` (optional helper)

`emitDiff` is a convenience helper for the common "object changed" case. It:

1. calculates a shallow field diff between `before` and `after`,
2. stores the result as a normal audit event whose `data` is
   `{ before, after, diff }`.

```ts
await audit.emitDiff({
  event: "product.updated",
  actor:  { id: "user_123",    type: "user" },
  target: { id: "product_456", type: "product" },
  before: { name: "Café", price: 120 },
  after:  { name: "Café", price: 150 },
  meta:   { source: "admin-panel" },
});
```

Persisted `data`:

```json
{
  "before": { "name": "Café", "price": 120 },
  "after":  { "name": "Café", "price": 150 },
  "diff":   { "price": { "before": 120, "after": 150 } }
}
```

> `emitDiff` is just sugar around `emit`. The core of the library is `emit`.

Notes on the diff shape:

- Each entry is `{ before, after }`.
- Keys added in `after` (missing in `before`) produce `{ after }` only — the
  `before` side is `undefined` and is dropped by `JSON.stringify`, which is how
  `JSONB` columns are written.
- Keys removed in `after` (missing in `before`-only) produce `{ before }` only,
  for the same reason.
- Nested objects are compared structurally for equality; when they differ, the
  whole subtree is emitted as one diff entry (no path flattening).

## Named scopes

Logical keys in `scopes` map to physical `tableName` values once at startup. Use **`getScope("users")`** for writes and **`getScope("users").query`** for reads. The default scope (`defaultScope`) is what `audit.emit` / `audit.query` use.

Each non-default scope has its **own async queue** on the write path. **`close()`** drains every queue, then ends **only** the pools Tracevault constructed. If you inject **`pool`** / **`readPool`**, end those yourself after **`await audit.close()`** when tearing down the process.

### `generateInitSql` (operators / CI)

`generateInitSql(tableName)` returns the same DDL `startTracevault` runs when `bootstrap.ensureSchema` is not `false`. It does **not** execute SQL.

- Validates the table name (`/^[A-Za-z_][A-Za-z0-9_]*$/`, max 63 chars); invalid names throw `ConfigError`.
- Safe to run repeatedly (`IF NOT EXISTS`).

```bash
node -e 'console.log(require("tracevault").generateInitSql("audit_user_events"))' \
  | psql "$DATABASE_URL"
```

## Configuration (`startTracevault`)

| Option                   | Type                        | Default        | Notes |
| ------------------------ | --------------------------- | -------------- | ----- |
| `driver`                 | `"postgres"`                | —              | Only Postgres is supported. |
| `connectionString`       | `string`                    | —              | Write role (`INSERT`; DDL when `ensureSchema`). |
| `readConnectionString`   | `string`                    | same as write | Read-only role for `query` (recommended in production). Ignored for reads when **`readPool`** is set. |
| `pool`                   | `pg.Pool`                   | —              | Optional. Shared write pool (DDL + inserts). Must define **`.query`** and **`.connect`**. |
| `readPool`               | `pg.Pool`                   | —              | Optional reader pool (e.g. replica). Requires **`pool`**; do not set a different **`readConnectionString`** unless you use two pools. |
| `defaultScope`           | `string`                    | —              | Must be a key of `scopes`. |
| `scopes`                 | `Record<string, { tableName }>` | —        | Logical name → physical table. |
| `bootstrap.ensureSchema` | `boolean`                   | `true`         | Set `false` if migrations own DDL. |
| `maskFields`             | `string[]`                  | `[]`           | Same semantics as before. |
| `maskValue`              | `string`                    | `"[REDACTED]"` | |
| `defaultMode`            | `"sync" \| "async"`         | `"sync"`       | |
| `environment`            | `string`                    | `undefined`    | |
| `onError`                | `(err, record) => void`     | `console.error`| Async insert failures. |
| `asyncBatchSize`         | `number`                    | `50`           | |
| `asyncFlushIntervalMs`   | `number`                    | `0`            | |

### Shared `pg.Pool` (TLS, RDS, `@flash/pg-config`)

When you need **`ssl`** (custom CA for RDS, mutual TLS, etc.), build **`Pool`** instances the same way as the rest of your service and pass them in. Tracevault runs **`ensureAuditTableSchema`** via **`pool.connect()`** / **`release()`**, so bootstrap sees the same options as runtime queries.

```ts
import { startTracevault } from "tracevault";
import { createPgPool } from "@flash/pg-config"; // example: your shared factory

const pool = createPgPool({ connectionString: process.env.DATABASE_URL! });
const audit = await startTracevault({
  driver: "postgres",
  connectionString: process.env.DATABASE_URL!,
  pool,
  defaultScope: "default",
  scopes: { default: { tableName: "audit_logs" } },
});
```

Use **`readPool`** when the read side should hit a replica; **`readPool`** requires **`pool`**. With only **`pool`** (no **`readPool`**), **`readConnectionString`** must match **`connectionString`** or be omitted.

## Sync vs async

- `sync` — awaits the insert before `emit()` resolves. Easiest correctness story.
- `async` — pushes into an in-memory queue and returns immediately. Lower latency,
  but events are **not durable** across process crashes.

```ts
// per-event override
await audit.emit({ event: "noise.collected", mode: "async" });

// drain in graceful shutdown
await audit.flush();
await audit.close();
```

> Async mode uses a simple in-process FIFO queue. It is **not** a distributed
> system. There is no retry, no persistence across process boundaries, and no
> back-pressure. If the process crashes before `flush()` completes, **buffered
> events are lost**. Use `sync` mode when you need durability guarantees.

## Masking

Any object key whose name matches `maskFields` (case-insensitive) is replaced
with `maskValue`, recursively, inside `data`, `meta`, and `emitDiff`'s `before`/`after`.

```ts
// options passed to startTracevault({ … maskFields: ["password", …] })

await audit.emit({
  event: "user.updated",
  data: {
    email: "jane@acme.com",
    password: "hunter2",               // → "[REDACTED]"
    profile: { biometricData: "..." }, // → "[REDACTED]" (recursive)
  },
});
```

- Masking runs against a deep clone; your input object is never mutated.
- The walker is cycle-safe; shared subtrees are mapped to the same cloned ref.

## Input validation

Tracevault validates inputs strictly so bad data fails fast with clear errors:

- `event` is required, non-empty, non-whitespace, ≤ 255 chars, no newlines/tabs.
- `actor`/`target`, when present, must be `{ id: string, type: string }` with
  non-empty values.
- `occurredAt` must be a valid `Date` or a parseable ISO string.
- `data`, `meta`, `before`, `after` must be **plain objects** with only
  JSON-serializable values — BigInts, functions, symbols, `undefined`,
  `NaN`/`Infinity`, circular references and class instances are rejected with
  a path like `data.payment.amount`.
- `mode` must be `"sync"` or `"async"` if specified.
- `emit`/`emitDiff` called after `close()` throws `TracevaultError`.

All errors extend `TracevaultError`:

```ts
import { TracevaultError, ConfigError, ValidationError, DriverError } from "tracevault";
```

| Class              | Thrown when                                                                      |
| ------------------ | -------------------------------------------------------------------------------- |
| `ConfigError`      | `startTracevault` receives an invalid configuration.                            |
| `ValidationError`  | `emit` / `emitDiff` receives an invalid event or a non-JSON-safe payload.        |
| `DriverError`      | The database driver fails to insert, healthcheck, or close.                      |
| `TracevaultError`  | Base class. Also thrown directly for lifecycle violations (emit after `close()`). |

## Data model

Tracevault persists every event to a single, JSONB-first table. The schema is
intentionally event-oriented — no `old_values` / `new_values` columns, no
compliance-specific taxonomy.

See [`sql/001_init_audit_logs.sql`](./sql/001_init_audit_logs.sql),
[`sql/002_audit_logs_outcome_error_code.sql`](./sql/002_audit_logs_outcome_error_code.sql),
[`sql/003_audit_logs_severity.sql`](./sql/003_audit_logs_severity.sql),
or use `generateInitSql("audit_logs")` for an equivalent one-shot DDL.

| Column           | Type          | Notes                               |
| ---------------- | ------------- | ----------------------------------- |
| `id`             | `UUID`        | Generated per event.                |
| `event`          | `VARCHAR`     | The event name.                     |
| `actor_id`       | `VARCHAR`     | Nullable.                           |
| `actor_type`     | `VARCHAR`     | Nullable.                           |
| `target_id`      | `VARCHAR`     | Nullable.                           |
| `target_type`    | `VARCHAR`     | Nullable.                           |
| `data`           | `JSONB`       | Free-form event payload.            |
| `meta`           | `JSONB`       | Free-form metadata.                 |
| `mode`           | `VARCHAR`     | `"sync"` or `"async"`.              |
| `occurred_at`    | `TIMESTAMPTZ` | Provided or generated at emit-time. |
| `created_at`     | `TIMESTAMPTZ` | DB-side `DEFAULT NOW()`.            |
| `correlation_id` | `VARCHAR`     | Nullable.                           |
| `request_id`     | `VARCHAR`     | Nullable.                           |
| `environment`    | `VARCHAR`     | Nullable.                           |
| `outcome`        | `VARCHAR(64)` | **Generated (migration 002+).** `NULLIF(BTRIM(data->>'outcome'),'')`. Omitted in inserts. |
| `error_code`     | `VARCHAR(255)` | **Generated.** `NULLIF(BTRIM(data->'error'->>'code'),'')`. Omitted in inserts. |
| `severity`       | `VARCHAR(32)` | **Generated (migration 003+).** `NULLIF(BTRIM(data->>'severity'),'')`. Omitted in inserts. |

Default indexes are created on `event`, `(actor_id, actor_type)`,
`(target_id, target_type)`, `occurred_at DESC`, partial
`(correlation_id, occurred_at DESC, id DESC)` where `correlation_id IS NOT NULL`,
partial `(error_code, occurred_at DESC)` where `error_code IS NOT NULL`,
partial `(outcome, occurred_at DESC)` where `outcome IS NOT NULL`, and
partial `(severity, occurred_at DESC)` where `severity IS NOT NULL`.

## Correlation IDs and structured outcomes (optional)

Tracevault stays **custom-events-first**: nothing here is validated by the
library. These are recommended patterns for consoles and dashboards.

- **Correlation** — use the same `correlationId` on every `emit` that belongs
  to one logical operation (checkout, login attempt, …). Helpers exported from
  the main entry point:
  - `randomCorrelationId()`
  - `readCorrelationIdHeader((name) => req.get(name))`
  - `resolveCorrelationId(...)` — header when present, otherwise a new UUID.
- **Structured failures** — inside `data`, optional keys consumed by generated
  columns (after migrations **002**–**003**):
  - `outcome`: e.g. `"success"` / `"failure"`.
  - `error`: `{ "code": "AUTH_INVALID_CREDENTIALS", "stage": "…", … }` — only
    `code` is mirrored to the `error_code` column for indexed queries.
  - `severity`: e.g. `"warning"` — mirrored to the `severity` column. Suggested
    ordinal scale (export `DOCUMENTED_SEVERITY_LEVELS` from `tracevault`):
    from `debug` through `fatal`, increasing alert importance.

The Read API exposes `outcome`, `errorCode`, and `severity` on each `AuditRecord`
and accepts filters for them. Use `errorsOnly: true` to list rows with
`outcome = 'failure'` **or** `severity` in `error` / `critical` / `fatal` (see
`SEVERITIES_FOR_ERRORS_ONLY_FILTER` on `tracevault`).

## Reading events

The **Read API** is exposed as `audit.query` on the app returned by `startTracevault`, and as `audit.getScope("name").query` for each scope. It supports equality filters on scalar columns (including generated `outcome`, `error_code`, and `severity` after migrations **002**–**003**), an `occurred_at` window, and deterministic pagination.

```ts
const recent = await audit.query.findMany({
  event: "product.price.updated",
  from: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
  limit: 100,
});

const scoped = await audit.getScope("users").query.findMany({
  event: "user.profile.updated",
  limit: 50,
});

const one = await audit.query.findById("uuid-here"); // AuditRecord | null
const total = await audit.query.count({ actorType: "user", environment: "prod" });
```

### Filters

`findMany(filters)` and `count(filters)` accept the same equality filter
set; `findMany` additionally accepts pagination + ordering:

| Field           | Type                              | Notes                                             |
| --------------- | --------------------------------- | ------------------------------------------------- |
| `event`         | `string`                          | Exact match.                                      |
| `actorId`       | `string`                          | Exact match.                                      |
| `actorType`     | `string`                          | Exact match.                                      |
| `targetId`      | `string`                          | Exact match.                                      |
| `targetType`    | `string`                          | Exact match.                                      |
| `correlationId` | `string`                          | Exact match.                                      |
| `requestId`     | `string`                          | Exact match.                                      |
| `environment`   | `string`                          | Exact match.                                      |
| `outcome`       | `string`                          | Exact match on generated column (≤ 64 chars).     |
| `errorCode`     | `string`                          | Exact match on generated column (≤ 255 chars).  |
| `severity`      | `string`                          | Exact match on generated column (≤ 32 chars).   |
| `severities`    | `string[]`                        | `severity IN (...)`; max 16 entries, no duplicates. |
| `errorsOnly`    | `boolean`                         | `true` → `outcome = 'failure'` OR `severity` in `error` / `critical` / `fatal`. ANDed with other filters. |
| `mode`          | `"sync" \| "async"`               | Exact match.                                      |
| `from`          | `Date \| string`                  | Inclusive lower bound on `occurredAt`.            |
| `to`            | `Date \| string`                  | Inclusive upper bound on `occurredAt`.            |
| `limit`         | `number` (1..500, default `50`)   | `findMany` only. Rejected on `count`.             |
| `offset`        | `number` (>= 0, default `0`)      | `findMany` only. Rejected on `count`.             |
| `order`         | `"asc" \| "desc"` (default `"desc"`) | Applied to `(occurred_at, id)`. `findMany` only. |

All string filters are compared with plain equality — no `LIKE`, no regex.
Unknown keys are rejected with `ValidationError` so typos never silently
widen the result set. `from > to` is rejected eagerly for the same reason.

Ordering is always `ORDER BY occurred_at <dir>, id <dir>`: the UUID id
breaks ties so pagination is deterministic at a given point in time. Under
concurrent writes, prefer bounding the query with a `from`/`to` window.

### Scopes on the Read API

Use **`getScope("users").query`** instead of a separate reader factory. Each scope shares the **read** pool and **write** pool with the rest of the app.

### Lifecycle and `close()`

Call **`await audit.close()`** on the app once: it drains every scope's write queue, then ends **Tracevault-owned** write/read pools. Injected **`pool`** / **`readPool`** are not ended by Tracevault. After close, `emit` and `query` throw `TracevaultError`. `healthcheck()` returns `false`.

### Errors

The Read API throws from the same hierarchy as writes:

- `ConfigError` — invalid `startTracevault` options or unknown `getScope` name.
- `ValidationError` — bad filter shape (wrong key, wrong type, `limit`
  out of range, unparseable date, non-UUID passed to `findById`, …).
- `DriverError` — the underlying Postgres query failed (e.g. the table
  does not exist, the connection is unreachable).
- `TracevaultError` — base class and lifecycle violations.

### Raw SQL still works

The Read API is a convenience. The underlying schema is public and
Tracevault will never fight you for it — if you need group-by aggregations,
CTEs, or JSONB path queries, reach for `pg`, `drizzle`, `knex`, or raw SQL
directly. The library is designed to coexist peacefully with them.

## API

```ts
import {
  startTracevault,
  type TracevaultApp,
  generateInitSql,
  type StartTracevaultOptions,
} from "tracevault";

const audit: TracevaultApp = await startTracevault(config);

audit.emit(event)           // Promise<void>
audit.emitDiff(event)       // Promise<void>
audit.flush()               // Promise<void>
audit.close()               // Promise<void> — drains queues; ends only pools Tracevault created
audit.healthcheck()         // Promise<boolean>
audit.getScope(name)        // { emit, emitDiff, flush, query }

audit.query.findMany(filters?)
audit.query.findById(id)
audit.query.count(filters?)
```

```ts
import { generateInitSql } from "tracevault";

generateInitSql(tableName) // string — DDL only, does not execute
```

Types (`AuditEvent`, `AuditDiffEvent`, `StartTracevaultOptions`, `TracevaultApp`,
`PersistedRecord`, `AuditRecord`, `AuditQueryFilters`, `AuditCountFilters`,
`TracevaultQuery`, `TracevaultError`, `ConfigError`, `ValidationError`,
`DriverError`, …) and helpers (`randomCorrelationId`, `readCorrelationIdHeader`,
`resolveCorrelationId`, `assertPgPoolLike`, `DOCUMENTED_SEVERITY_LEVELS`,
`SEVERITIES_FOR_ERRORS_ONLY_FILTER`, `DocumentedSeverity`) are exported from **`tracevault`**.

## Example

A runnable Express example lives in [`examples/express`](./examples/express).

## Development & tests

### Unit tests

```bash
npm install
npm run test:unit    # fast, no dependencies
```

### Integration tests (real PostgreSQL via Docker)

```bash
npm run test:integration
```

A single command that:

1. starts a PostgreSQL 16 container on port `5433`,
2. applies `sql/001_init_audit_logs.sql` then `sql/002_audit_logs_outcome_error_code.sql`
   then `sql/003_audit_logs_severity.sql`
   against an ephemeral
   `tracevault_test` database,
3. runs the integration Vitest suite,
4. tears the container and its volume down — even if tests fail.

Environment variables:

- `TEST_DATABASE_URL` — override the connection string
  (default `postgres://postgres:postgres@localhost:5433/tracevault_test`).

### All tests

```bash
npm run test:all
```

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for more detail. Release history:
[`CHANGELOG.md`](./CHANGELOG.md).

## Limitations (V1)

- **PostgreSQL only.** No MySQL, SQLite, Mongo, or file sink in V1.
- **No distributed queue.** Async mode is in-process and non-durable.
- **Optional schema bootstrap.** Use `startTracevault` with `bootstrap.ensureSchema` (default) or apply `sql/` / `generateInitSql` yourself.
- **No built-in retries.** Sync `emit` throws on failure; async `emit`
  delivers the error to `onError(err, record)` exactly once.
- **Narrow Read API.** `audit.query` supports equality filters on scalar
  columns (including generated fields), `errorsOnly` / `severities` for error
  views, a time window on `occurredAt`, deterministic pagination, and
  per-table scopes. No JSONB path filters, no `IS NULL` query helpers, no joins
  or aggregations — those are your call, with raw SQL.
- **Shallow diff.** `emitDiff` compares top-level keys. Nested objects are
  compared structurally for equality and emitted as a single diff entry when
  they differ.

## Roadmap

- Additional drivers (MySQL, SQLite, file, HTTP sink).
- Optional durable async queue (disk-backed or Redis-backed).
- Per-event TTL / retention hooks.
- Structured diff with path-based entries.

## License

MIT
