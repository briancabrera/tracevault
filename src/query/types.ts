/**
 * Public types for Tracevault's Read API.
 *
 * The Read API intentionally stays narrow: it returns rows straight from the
 * audit table, with a small set of equality/time-range filters, stable
 * pagination, and nothing else. No DSL, no JSONB probing, no joins. When
 * projects need analytics, they should build those on top of SQL directly.
 */

import type { AuditDriver, AuditMode } from "../types/index.js";

/**
 * A persisted audit record as returned by the Read API.
 *
 * 1:1 shape with the columns of the audit table, camelCased. `data` and
 * `meta` round-trip through JSONB so non-JSON types (e.g. Dates inside the
 * payload) come back as ISO strings — exactly like they went in.
 */
export interface AuditRecord<
  TData extends Record<string, unknown> = Record<string, unknown>,
  TMeta extends Record<string, unknown> = Record<string, unknown>,
> {
  id: string;
  event: string;
  actorId: string | null;
  actorType: string | null;
  targetId: string | null;
  targetType: string | null;
  data: TData | null;
  meta: TMeta | null;
  mode: AuditMode;
  occurredAt: Date;
  createdAt: Date;
  correlationId: string | null;
  requestId: string | null;
  environment: string | null;
  /**
   * STORED generated column: `NULLIF(BTRIM(data->>'outcome'), '')` when the row
   * was created under migration V2+. Null for legacy rows or when `data` omits
   * `outcome`. See README (correlation & structured outcomes).
   */
  outcome: string | null;
  /**
   * STORED generated column from `data->'error'->>'code'`. Same null semantics
   * as {@link outcome}.
   */
  errorCode: string | null;
  /**
   * STORED generated column: `NULLIF(BTRIM(data->>'severity'), '')` when migration
   * V3+ is applied. See README for the documented ordinal scale.
   */
  severity: string | null;
}

/**
 * Filters accepted by `findMany`.
 *
 * Design rules:
 * - All string fields use exact equality only (no `LIKE`, no regex).
 * - `from`/`to` clamp `occurredAt` (inclusive).
 * - Pagination is offset-based with a stable tie-broken order by
 *   `(occurred_at, id)`. For deterministic results under concurrent writes,
 *   prefer using `from`/`to` windows alongside the page.
 */
export interface AuditQueryFilters {
  event?: string;
  actorId?: string;
  actorType?: string;
  targetId?: string;
  targetType?: string;
  correlationId?: string;
  requestId?: string;
  environment?: string;
  /** Exact match on generated column `outcome` (from `data.outcome`). */
  outcome?: string;
  /** Exact match on generated column `error_code` (from `data.error.code`). */
  errorCode?: string;
  /** Exact match on generated column `severity` (from `data.severity`). */
  severity?: string;
  /**
   * Exact match: `severity` must be one of the listed values (`OR` semantics
   * via SQL `IN`).
   */
  severities?: readonly string[];
  /**
   * When `true`, keeps rows where `outcome = 'failure'` **or** `severity` is one
   * of `error`, `critical`, `fatal` (see `SEVERITIES_FOR_ERRORS_ONLY_FILTER` on
   * `tracevault/query`). Combined with other filters with `AND`.
   */
  errorsOnly?: boolean;
  mode?: AuditMode;
  /** Inclusive lower bound on `occurredAt`. Accepts Date or ISO string. */
  from?: Date | string;
  /** Inclusive upper bound on `occurredAt`. Accepts Date or ISO string. */
  to?: Date | string;
  /** Max rows to return. Default 50, capped at 500. */
  limit?: number;
  /** Rows to skip. Default 0. */
  offset?: number;
  /** Ordering on `(occurred_at, id)`. Default `"desc"`. */
  order?: "asc" | "desc";
}

/** Filters accepted by `count`. Pagination/order fields are not meaningful here. */
export type AuditCountFilters = Omit<AuditQueryFilters, "limit" | "offset" | "order">;

/** Configuration passed to `createTracevaultQuery`. */
export interface TracevaultQueryConfig {
  driver: AuditDriver;
  connectionString: string;
  tableName?: string;
}

/**
 * Fields a query scope may override on top of the root config.
 *
 * `driver` / `connectionString` are intentionally not overridable: scopes
 * share the root's connection pool and only differ in which table they
 * read from.
 */
export interface TracevaultQueryScopeOverrides {
  tableName?: string;
}

/**
 * Public read-only Tracevault instance returned by `createTracevaultQuery`.
 */
export interface TracevaultQuery {
  /**
   * Find audit records matching the given filters.
   *
   * Ordering is always deterministic: `(occurred_at, id)` with the chosen
   * direction. Defaults: `order="desc"`, `limit=50`, `offset=0`.
   */
  findMany<
    TData extends Record<string, unknown> = Record<string, unknown>,
    TMeta extends Record<string, unknown> = Record<string, unknown>,
  >(
    filters?: AuditQueryFilters,
  ): Promise<Array<AuditRecord<TData, TMeta>>>;

  /**
   * Look up a single record by its `id` (UUID). Returns `null` when not
   * found. Throws `ValidationError` if `id` is not a UUID string.
   */
  findById<
    TData extends Record<string, unknown> = Record<string, unknown>,
    TMeta extends Record<string, unknown> = Record<string, unknown>,
  >(
    id: string,
  ): Promise<AuditRecord<TData, TMeta> | null>;

  /** Count records matching the filters. Intended for light totals, not analytics. */
  count(filters?: AuditCountFilters): Promise<number>;

  /**
   * Derive a new query instance that shares the root's pool but points at
   * a different table. Scopes inherit every root option; only the fields
   * in `TracevaultQueryScopeOverrides` may be changed.
   */
  scope(overrides?: TracevaultQueryScopeOverrides): TracevaultQuery;

  /**
   * On the root instance: releases the shared DB pool and invalidates every
   * scope. On a scope: marks the scope as closed only; the shared pool
   * keeps serving the root and sibling scopes.
   *
   * Idempotent.
   */
  close(): Promise<void>;

  /** Returns `true` if the underlying pool is reachable and the instance is open. */
  healthcheck(): Promise<boolean>;
}
