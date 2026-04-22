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
- **Idempotent lifecycle** — `close()` is safe to call multiple times.
- **Zero runtime dependencies** beyond `pg`.

## Installation

```bash
npm install tracevault pg
```

### Run the initial migration **manually**

> Tracevault **does not** create the `audit_logs` table for you at boot.
> Run the migration explicitly, as part of your normal DB migration flow.

```bash
psql "$DATABASE_URL" -f node_modules/tracevault/sql/001_init_audit_logs.sql
```

The SQL file is shipped with the package under `sql/001_init_audit_logs.sql`.

## Quick start

```ts
import { createTracevault } from "tracevault";

const audit = createTracevault({
  driver: "postgres",
  connectionString: process.env.DATABASE_URL ?? "",
  tableName: "audit_logs",
  maskFields: ["password", "token", "pin", "biometricData"],
  defaultMode: "sync",
  environment: process.env.NODE_ENV,
});

await audit.emit({
  event: "auth.login.succeeded",
  actor:  { id: "user_123", type: "user" },
  meta:   { ip: "127.0.0.1", userAgent: "curl/8" },
});
```

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

## Multi-table audits with scopes

One `createTracevault(...)` owns a single `pg.Pool`. From that root you can derive
as many **scopes** as you want — each writing to its own table — via `root.scope(...)`:

```ts
const root = createTracevault({
  driver: "postgres",
  connectionString: process.env.DATABASE_URL ?? "",
  tableName: "audit_logs",
  maskFields: ["password", "token", "pin", "biometricData"],
  defaultMode: "sync",
  environment: process.env.NODE_ENV,
});

const userAudit = root.scope({ tableName: "audit_user_events" });
const txAudit   = root.scope({ tableName: "audit_transaction_events", defaultMode: "sync" });

await userAudit.emit({
  event: "user.profile.updated",
  actor:  { id: "user_123", type: "user" },
  target: { id: "user_123", type: "user" },
  data:   { field: "phone" },
});

await txAudit.emit({
  event: "payment.intent.created",
  actor:  { id: "merchant_42", type: "merchant" },
  target: { id: "payment_987", type: "payment" },
  data:   { amount: 1200, currency: "UYU" },
});
```

Scopes are explicit by design:

- **Tables are chosen when you create the scope**, never per-event. `emit()` and
  `emitDiff()` intentionally ignore any `tableName` in the payload — it would
  just be another stringly-typed routing mechanism.
- **There is no event-name-based routing.** If an event should land in a
  different table, use a different scope.
- **Scopes share the root's connection pool.** No extra connections, no extra
  lifecycle to manage.

### What scopes inherit and what they can override

A scope inherits *every* setting from its parent (the root, or another scope).
Only the following fields may be overridden:

| Override                | Effect                                                              |
| ----------------------- | ------------------------------------------------------------------- |
| `tableName`             | Write to a different audit table.                                   |
| `defaultMode`           | Switch the scope's default `sync`/`async` behavior.                 |
| `environment`           | Stamp a different `environment` on the scope's events.              |
| `maskFields`            | Replace (not merge) the set of sensitive field names.               |
| `maskValue`             | Replace the masking placeholder.                                    |
| `onError`               | Route this scope's async failures to a different handler.           |
| `asyncBatchSize`        | Tune the scope's async batch size.                                  |
| `asyncFlushIntervalMs`  | Tune the scope's async flush cadence.                               |

`driver` and `connectionString` are **not** overridable — trying to do so
throws `ConfigError` with a clear message.

Every other key also throws `ConfigError`. There is no implicit passthrough.

### Queues are per-scope

Each scope maintains its **own** async queue. That means:

- `scope.flush()` drains only that scope's buffered events.
- `scope.close()` flushes and tears down that scope's queue — the shared pool
  and all other scopes keep working.
- A scope's `onError` only receives failures from its own inserts.

### `close()` semantics

| Call                | What it does                                                                 |
| ------------------- | ---------------------------------------------------------------------------- |
| `scope.close()`     | Drains this scope's queue, marks it unusable. The root pool is untouched.    |
| `root.close()`      | Drains the root's queue, drains every live scope's queue, then releases the pool. Every scope then rejects `emit()` / `emitDiff()` and reports `healthcheck() === false`. |

`close()` is idempotent on both the root and each scope. Creating a new scope
(`root.scope(...)`) after the root is closed throws `TracevaultError`.

### Migrating several tables — `generateInitSql`

Tracevault does not auto-create tables at boot. For the default `audit_logs`
table, keep using the shipped migration:

```bash
psql "$DATABASE_URL" -f node_modules/tracevault/sql/001_init_audit_logs.sql
```

For additional tables used by scopes, generate the DDL with `generateInitSql`
and pipe it through whatever migration tool you already use:

```ts
import { generateInitSql } from "tracevault";

// Same schema as audit_logs, but for a different table.
const ddl = generateInitSql("audit_user_events");
console.log(ddl);
// -> CREATE TABLE IF NOT EXISTS "audit_user_events" ( … ); CREATE INDEX …
```

Or straight from the shell:

```bash
node -e 'console.log(require("tracevault").generateInitSql("audit_user_events"))' \
  | psql "$DATABASE_URL"
```

`generateInitSql`:

- Validates the table name with the same strict policy as `tableName`
  (`/^[A-Za-z_][A-Za-z0-9_]*$/`, max 63 chars); invalid names throw `ConfigError`.
- **Never executes anything.** It only returns a string.
- Uses `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS`, so it is
  safe to run repeatedly.

## Configuration

| Option                 | Type                        | Default        | Notes                                                              |
| ---------------------- | --------------------------- | -------------- | ------------------------------------------------------------------ |
| `driver`               | `"postgres"`                | —              | Only `"postgres"` is supported in V1.                              |
| `connectionString`     | `string`                    | —              | Standard `pg` connection string.                                   |
| `tableName`            | `string`                    | `"audit_logs"` | `/^[A-Za-z_][A-Za-z0-9_]*$/`, max 63 chars.                        |
| `maskFields`           | `string[]`                  | `[]`           | Case-insensitive. Recursively masked in `data`, `meta`, `before`, `after`. |
| `maskValue`            | `string`                    | `"[REDACTED]"` | Value used for masked fields.                                      |
| `defaultMode`          | `"sync" \| "async"`         | `"sync"`       | Used when an event does not specify `mode`.                        |
| `environment`          | `string`                    | `null`         | Default environment stamped on every event.                        |
| `onError`              | `(err, record) => void`     | `console.error`| Called when an **async** insert fails.                             |
| `asyncBatchSize`       | `number`                    | `50`           | Max records processed per async tick. Positive integer.            |
| `asyncFlushIntervalMs` | `number`                    | `0`            | Delay between async ticks. `0` uses `setImmediate`.                |

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
createTracevault({
  /* ... */
  maskFields: ["password", "token", "pin", "biometricData"],
});

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
| `ConfigError`      | `createTracevault` receives an invalid configuration.                            |
| `ValidationError`  | `emit` / `emitDiff` receives an invalid event or a non-JSON-safe payload.        |
| `DriverError`      | The database driver fails to insert, healthcheck, or close.                      |
| `TracevaultError`  | Base class. Also thrown directly for lifecycle violations (emit after `close()`). |

## Data model

Tracevault persists every event to a single, JSONB-first table. The schema is
intentionally event-oriented — no `old_values` / `new_values` columns, no
compliance-specific taxonomy.

See [`sql/001_init_audit_logs.sql`](./sql/001_init_audit_logs.sql) for the full DDL.

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

Default indexes are created on `event`, `(actor_id, actor_type)`,
`(target_id, target_type)`, and `occurred_at DESC`.

## Reading events

Tracevault does **not** ship a read API. Once events are persisted, query them
with whatever you already use — `pg`, `drizzle`, `knex`, `prisma`, or raw SQL:

```sql
SELECT id, event, actor_id, data, occurred_at
FROM audit_logs
WHERE event = 'product.price.updated'
  AND occurred_at >= now() - interval '7 days'
ORDER BY occurred_at DESC
LIMIT 100;
```

## API

```ts
const audit: Tracevault = createTracevault(config);

audit.emit(event)          // Promise<void>
audit.emitDiff(event)      // Promise<void>
audit.flush()              // Promise<void>  — drain this instance's async queue
audit.close()              // Promise<void>  — root: flush every scope + release pool; scope: flush own queue only (idempotent)
audit.healthcheck()        // Promise<boolean>
audit.scope(overrides?)    // Tracevault   — derive a sibling that shares the pool but writes to a different table
```

Plus the standalone helper:

```ts
import { generateInitSql } from "tracevault";

generateInitSql(tableName) // string  — DDL for an audit table (validated, does not execute)
```

All types (`AuditEvent`, `AuditDiffEvent`, `TracevaultConfig`,
`TracevaultScopeOverrides`, `PersistedRecord`, `AuditActor`, `AuditTarget`,
`AuditMode`, `Diff`, `DiffEntry`, `TracevaultError`, `ConfigError`,
`ValidationError`, `DriverError`) are exported from the package entry.

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
2. applies `sql/001_init_audit_logs.sql` against an ephemeral
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

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for more detail.

## Limitations (V1)

- **PostgreSQL only.** No MySQL, SQLite, Mongo, or file sink in V1.
- **No distributed queue.** Async mode is in-process and non-durable.
- **No automatic schema management.** Tracevault never creates tables at boot.
  Use `sql/001_init_audit_logs.sql` for the default table and `generateInitSql`
  for additional tables used by scopes.
- **No built-in retries.** Sync `emit` throws on failure; async `emit`
  delivers the error to `onError(err, record)` exactly once.
- **No query/read API.** Tracevault writes events; reading is your decision.
- **Shallow diff.** `emitDiff` compares top-level keys. Nested objects are
  compared structurally for equality and emitted as a single diff entry when
  they differ.

## Roadmap

- Optional read API (paginated query helpers over the `audit_logs` table).
- Additional drivers (MySQL, SQLite, file, HTTP sink).
- Optional durable async queue (disk-backed or Redis-backed).
- Per-event TTL / retention hooks.
- Structured diff with path-based entries.

## License

MIT
