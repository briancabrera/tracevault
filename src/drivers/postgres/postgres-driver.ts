import type { Pool } from "pg";

import { DriverError } from "../../core/errors.js";
import type { PersistedRecord } from "../../types/index.js";
import type { AuditDriverClient } from "../driver.js";
import { buildInsertManySql, buildInsertSql } from "./sql.js";

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
  private readonly insertManySql: string;
  private closed = false;

  constructor(opts: PostgresDriverOptions) {
    this.pool = opts.pool;
    this.insertSql = buildInsertSql(opts.tableName);
    this.insertManySql = buildInsertManySql(opts.tableName);
  }

  async insert(record: PersistedRecord): Promise<void> {
    if (this.closed) {
      throw new DriverError("Tracevault: driver is closed; cannot insert.");
    }

    const params = recordToParams(record);

    try {
      await this.pool.query(this.insertSql, params);
    } catch (err) {
      throw new DriverError(
        `Tracevault: failed to insert audit event "${record.event}" (id=${record.id}).`,
        err,
      );
    }
  }

  /**
   * Insert many records in one statement. Atomic: on failure nothing from
   * the batch is persisted, so callers can safely retry records one by one.
   */
  async insertMany(records: readonly PersistedRecord[]): Promise<void> {
    if (this.closed) {
      throw new DriverError("Tracevault: driver is closed; cannot insert.");
    }
    if (records.length === 0) return;
    if (records.length === 1) return this.insert(records[0]!);

    const columns: unknown[][] = Array.from({ length: COLUMN_COUNT }, () => []);
    for (const record of records) {
      const params = recordToParams(record);
      for (let i = 0; i < COLUMN_COUNT; i++) columns[i]!.push(params[i]);
    }

    try {
      await this.pool.query(this.insertManySql, columns);
    } catch (err) {
      throw new DriverError(
        `Tracevault: failed to insert batch of ${records.length} audit events.`,
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
   * released here: the root write-side instance owns the pool lifecycle (see
   * `createTracevault` in `src/core/tracevault.ts`).
   */
  async close(): Promise<void> {
    this.closed = true;
  }
}

const COLUMN_COUNT = 13;

function recordToParams(record: PersistedRecord): unknown[] {
  return [
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
