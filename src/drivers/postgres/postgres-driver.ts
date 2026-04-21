import { Pool } from "pg";

import { DriverError } from "../../core/errors.js";
import type { PersistedRecord } from "../../types/index.js";
import type { AuditDriverClient } from "../driver.js";
import { buildInsertSql } from "./sql.js";

export interface PostgresDriverOptions {
  connectionString: string;
  tableName: string;
}

export class PostgresDriver implements AuditDriverClient {
  private readonly pool: Pool;
  private readonly insertSql: string;
  private closing: Promise<void> | null = null;
  private closed = false;

  constructor(opts: PostgresDriverOptions) {
    this.pool = new Pool({ connectionString: opts.connectionString });
    // Prevent unhandled 'error' events from crashing the process — pg emits
    // them on idle client failures. We surface them via the insert path.
    this.pool.on("error", () => {
      /* swallow; per-query errors still propagate through `insert()` */
    });
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

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = this.pool.end().catch((err) => {
      throw new DriverError("Tracevault: failed to close PostgreSQL pool.", err);
    });
    return this.closing;
  }
}

function safeStringify(value: unknown, field: string): string {
  try {
    return JSON.stringify(value);
  } catch (err) {
    // Should not happen: the validator rejects non-serializable inputs.
    // We keep this as a last line of defense with a clear message.
    throw new DriverError(
      `Tracevault: could not serialize \`${field}\` to JSON.`,
      err,
    );
  }
}
