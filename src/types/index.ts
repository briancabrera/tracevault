/**
 * Public types for Tracevault.
 *
 * The library purposely keeps the shape minimal and flexible.
 * Developers describe their own events: `event` is required, everything
 * else is optional and free-form.
 */

import type { Pool } from "pg";

export type AuditMode = "sync" | "async";

export type AuditDriver = "postgres";

export interface AuditActor {
  id: string;
  type: string;
}

export interface AuditTarget {
  id: string;
  type: string;
}

/**
 * A free-form audit event defined by the developer.
 *
 * `data` and `meta` are intentionally untyped by default so each project
 * can narrow them with its own generic arguments.
 *
 * **Optional convention (not enforced):** after DB migrations V2–V3, you may put
 * `outcome`, `error: { code, ... }`, and `severity` inside `data` to populate
 * generated columns for faster reads — see README.
 */
export interface AuditEvent<
  TData extends Record<string, unknown> = Record<string, unknown>,
  TMeta extends Record<string, unknown> = Record<string, unknown>,
> {
  event: string;
  actor?: AuditActor;
  target?: AuditTarget;
  data?: TData;
  meta?: TMeta;
  correlationId?: string;
  requestId?: string;
  environment?: string;
  occurredAt?: Date | string;
  mode?: AuditMode;
}

/**
 * Convenience input for `emitDiff`.
 *
 * Produces a normal audit event whose `data` contains `{ before, after, diff }`.
 */
export interface AuditDiffEvent<
  TBefore extends Record<string, unknown> = Record<string, unknown>,
  TAfter extends Record<string, unknown> = Record<string, unknown>,
  TMeta extends Record<string, unknown> = Record<string, unknown>,
> {
  event: string;
  actor?: AuditActor;
  target?: AuditTarget;
  before?: TBefore;
  after?: TAfter;
  meta?: TMeta;
  correlationId?: string;
  requestId?: string;
  environment?: string;
  occurredAt?: Date | string;
  mode?: AuditMode;
}

/**
 * Shape of each field's diff entry emitted by `emitDiff`.
 */
export interface DiffEntry {
  before: unknown;
  after: unknown;
}

export type Diff = Record<string, DiffEntry>;

/**
 * Configuration for the internal write-side factory (used by `startTracevault`).
 */
export interface TracevaultConfig {
  driver: AuditDriver;
  connectionString: string;
  /**
   * When set, Tracevault uses this pool instead of creating one from
   * `connectionString`. The string is still required for configuration
   * validation and documentation.
   */
  pool?: Pool;
  /**
   * When `false`, root `close()` drains queues but does not call `pool.end()`.
   * Defaults to `true` if this factory created the pool, `false` if `pool` was injected.
   */
  endPoolOnClose?: boolean;
  tableName?: string;
  maskFields?: readonly string[];
  maskValue?: string;
  defaultMode?: AuditMode;
  environment?: string;
  /**
   * Invoked when an event queued in `async` mode fails to persist.
   * Receives the thrown error and the fully-normalized record that failed.
   * Defaults to logging via `console.error`.
   */
  onError?: (error: Error, record: PersistedRecord) => void;
  /**
   * Max batch size processed per async tick. Defaults to 50.
   */
  asyncBatchSize?: number;
  /**
   * Delay (ms) between async processing ticks when the queue is non-empty.
   * Defaults to 0 (process immediately on `setImmediate`).
   */
  asyncFlushIntervalMs?: number;
}

/**
 * The normalized, persistable shape of an audit event.
 *
 * Consumers rarely interact with this directly — it maps 1:1 to the
 * columns of the `audit_logs` table.
 */
export interface PersistedRecord {
  id: string;
  event: string;
  actorId: string | null;
  actorType: string | null;
  targetId: string | null;
  targetType: string | null;
  data: Record<string, unknown> | null;
  meta: Record<string, unknown> | null;
  mode: AuditMode;
  occurredAt: Date;
  correlationId: string | null;
  requestId: string | null;
  environment: string | null;
}

/**
 * Fields that a scope may override on top of the root config.
 *
 * The storage target (`driver`, `connectionString`) is intentionally *not*
 * overridable: scopes share the root's connection pool and only differ in
 * which table they write to and a handful of behavior knobs.
 */
export interface TracevaultScopeOverrides {
  tableName?: string;
  defaultMode?: AuditMode;
  environment?: string;
  maskFields?: readonly string[];
  maskValue?: string;
  onError?: (error: Error, record: PersistedRecord) => void;
  asyncBatchSize?: number;
  asyncFlushIntervalMs?: number;
}

/**
 * Internal write-side instance shape (composed by `startTracevault`).
 */
export interface Tracevault {
  emit(event: AuditEvent): Promise<void>;
  emitDiff(event: AuditDiffEvent): Promise<void>;
  /** Waits for all queued async events to be processed. */
  flush(): Promise<void>;
  /**
   * On the root instance: flushes every scope and releases the shared DB pool.
   * On a scope: flushes the scope's own queue only — the root pool is untouched.
   * Idempotent: safe to call multiple times.
   */
  close(): Promise<void>;
  /** Returns `true` if the underlying driver is reachable and the instance is open. */
  healthcheck(): Promise<boolean>;
  /**
   * Derive a new Tracevault that shares the root's connection pool but writes
   * to a different table and/or overrides a subset of behavior options.
   *
   * Scopes inherit every root option; only the fields listed in
   * `TracevaultScopeOverrides` may be changed.
   */
  scope(overrides?: TracevaultScopeOverrides): Tracevault;
}

/** Physical table for a logical scope name (used with `startTracevault`). */
export interface TracevaultScopeTableConfig {
  tableName: string;
}

/** Map of logical scope name → physical audit table. */
export type TracevaultScopesMap = Record<string, TracevaultScopeTableConfig>;

/** Bootstrap behaviour for `startTracevault`. */
export interface StartTracevaultBootstrap {
  /**
   * When not `false`, runs idempotent DDL for each distinct table in `scopes`
   * using the write connection. Default: ensure schema at startup.
   */
  ensureSchema?: boolean;
}

/** Options passed to {@link startTracevault}. */
export interface StartTracevaultOptions {
  driver: AuditDriver;
  /**
   * Write URL (`INSERT`, and DDL when `bootstrap.ensureSchema` runs without {@link StartTracevaultOptions.pool}).
   * Still required when using an injected {@link StartTracevaultOptions.pool} (validation / query config).
   */
  connectionString: string;
  /**
   * Pre-configured write pool (TLS/ssl, RDS, `@flash/pg-config`, etc.). Bootstrap DDL uses
   * `pool.connect()` so it shares the same options as your app.
   */
  pool?: Pool;
  /**
   * Optional read pool (e.g. replica). Requires {@link StartTracevaultOptions.pool} for writes.
   * When omitted and `pool` is set, reads use the same pool as writes.
   */
  readPool?: Pool;
  /** Read URL when Tracevault creates the read `Pool` itself. Ignored when `readPool` / shared `pool` is used for reads (except it must match `connectionString` if only one pool handles both). */
  readConnectionString?: string;
  /** Must be a key of `scopes`. */
  defaultScope: string;
  scopes: TracevaultScopesMap;
  bootstrap?: StartTracevaultBootstrap;
  defaultMode?: AuditMode;
  environment?: string;
  maskFields?: readonly string[];
  maskValue?: string;
  onError?: (error: Error, record: PersistedRecord) => void;
  asyncBatchSize?: number;
  asyncFlushIntervalMs?: number;
}
