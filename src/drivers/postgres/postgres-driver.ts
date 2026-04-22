import type { Pool } from "pg";

import { DriverError } from "../../core/errors.js";
import type { PersistedRecord } from "../../types/index.js";
import type { AuditDriverClient } from "../driver.js";
import { buildInsertSql } from "./sql.js";

export interface PostgresDriverOptions {
  /**
   * Shared `pg.Pool`. The driver does NOT own this pool — creating and
   * tearing it down is the caller's responsibility. This is what lets a
   * single root Tracevault instance share a single connection pool across
   * arbitrarily many scope instances, each pointing at its own table.
   */
  pool: Pool;
  tableName: string;
}

export class PostgresDriver implements AuditDriverClient {
  private readonly pool: Pool;
  private readonly insertSql: string;
  private closed = false;

  constructor(opts: PostgresDriverOptions) {
    this.pool = opts.pool;
    this.insertSql = buildInsertSql(opts.tableName);
  }

  async insert(record: PersistedRecord): Promise<void> {
    if (this.closed) {
      throw new DriverError("Tracevault: driver is closed; cannot insert.");
    }

    const params: unknown[] = [
      record.id,
      record.event,
      record.actorId,
      record.actorType,
      record.targetId,
      record.targetType,
      record.data === null ? null : safeStringify(record.data, "data"),
      record.meta === null ? null : safeStringify(record.meta, "meta"),
      record.mode,
      record.occurredAt,
      record.correlationId,
      record.requestId,
      record.environment,
    ];

    try {
      await this.pool.query(this.insertSql, params);
    } catch (err) {
      throw new DriverError(
        `Tracevault: failed to insert audit event "${record.event}" (id=${record.id}).`,
        err,
      );
    }
  }

  async healthcheck(): Promise<boolean> {
    if (this.closed) return false;
    try {
      const result = await this.pool.query("SELECT 1 AS ok");
      return result.rows[0]?.ok === 1;
    } catch {
      return false;
    }
  }

  /**
   * Marks the driver as closed. The underlying pool is intentionally NOT
   * released here: the root Tracevault owns the pool lifecycle (see
   * `createTracevault` in `src/core/tracevault.ts`).
   */
  async close(): Promise<void> {
    this.closed = true;
  }
}

function safeStringify(value: unknown, field: string): string {
  try {
    return JSON.stringify(value);
  } catch (err) {
    throw new DriverError(
      `Tracevault: could not serialize \`${field}\` to JSON.`,
      err,
    );
  }
}
