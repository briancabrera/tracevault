import type { Pool } from "pg";

import { DriverError } from "../core/errors.js";
import type { AuditMode } from "../types/index.js";
import {
  buildCountSql,
  buildFindByIdSql,
  buildFindManySql,
} from "./builder.js";
import type { AuditRecord } from "./types.js";
import type { NormalizedQueryFilters } from "./validator.js";

interface RawRow {
  id: string;
  event: string;
  actor_id: string | null;
  actor_type: string | null;
  target_id: string | null;
  target_type: string | null;
  data: Record<string, unknown> | null;
  meta: Record<string, unknown> | null;
  mode: AuditMode;
  occurred_at: Date;
  created_at: Date;
  correlation_id: string | null;
  request_id: string | null;
  environment: string | null;
}

/**
 * Read-side counterpart of `PostgresDriver`. Wraps a shared `pg.Pool` and
 * executes the prebuilt SELECT / COUNT queries produced by `builder.ts`.
 *
 * The reader does NOT own the pool — `createTracevaultQuery` creates and
 * tears it down, and scopes reuse it.
 */
export class PostgresReader {
  private readonly pool: Pool;
  private readonly tableName: string;

  constructor(opts: { pool: Pool; tableName: string }) {
    this.pool = opts.pool;
    this.tableName = opts.tableName;
  }

  async findMany<TData extends Record<string, unknown>, TMeta extends Record<string, unknown>>(
    filters: NormalizedQueryFilters,
  ): Promise<Array<AuditRecord<TData, TMeta>>> {
    const { sql, params } = buildFindManySql(this.tableName, filters);
    try {
      const result = await this.pool.query<RawRow>(sql, params);
      return result.rows.map((row) => mapRow<TData, TMeta>(row));
    } catch (err) {
      throw new DriverError(
        `Tracevault: failed to query "${this.tableName}".`,
        err,
      );
    }
  }

  async findById<TData extends Record<string, unknown>, TMeta extends Record<string, unknown>>(
    id: string,
  ): Promise<AuditRecord<TData, TMeta> | null> {
    const { sql, params } = buildFindByIdSql(this.tableName, id);
    try {
      const result = await this.pool.query<RawRow>(sql, params);
      if (result.rows.length === 0) return null;
      return mapRow<TData, TMeta>(result.rows[0]!);
    } catch (err) {
      throw new DriverError(
        `Tracevault: failed to look up id "${id}" in "${this.tableName}".`,
        err,
      );
    }
  }

  async count(
    filters: Omit<NormalizedQueryFilters, "limit" | "offset" | "order">,
  ): Promise<number> {
    const { sql, params } = buildCountSql(this.tableName, filters);
    try {
      const result = await this.pool.query<{ c: string }>(sql, params);
      const raw = result.rows[0]?.c ?? "0";
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) {
        throw new DriverError(
          `Tracevault: received non-numeric count "${raw}" from "${this.tableName}".`,
        );
      }
      return parsed;
    } catch (err) {
      if (err instanceof DriverError) throw err;
      throw new DriverError(
        `Tracevault: failed to count rows in "${this.tableName}".`,
        err,
      );
    }
  }
}

function mapRow<
  TData extends Record<string, unknown>,
  TMeta extends Record<string, unknown>,
>(row: RawRow): AuditRecord<TData, TMeta> {
  return {
    id: row.id,
    event: row.event,
    actorId: row.actor_id,
    actorType: row.actor_type,
    targetId: row.target_id,
    targetType: row.target_type,
    data: (row.data as TData | null) ?? null,
    meta: (row.meta as TMeta | null) ?? null,
    mode: row.mode,
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
    correlationId: row.correlation_id,
    requestId: row.request_id,
    environment: row.environment,
  };
}
