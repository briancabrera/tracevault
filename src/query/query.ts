import { Pool } from "pg";

import { DriverError, TracevaultError } from "../core/errors.js";
import { PostgresReader } from "./reader.js";
import type {
  AuditCountFilters,
  AuditQueryFilters,
  AuditRecord,
  TracevaultQuery,
  TracevaultQueryConfig,
  TracevaultQueryScopeOverrides,
} from "./types.js";
import {
  assertUuid,
  validateAndNormalizeCountFilters,
  validateAndNormalizeFilters,
  validateQueryConfig,
  validateQueryScopeOverrides,
} from "./validator.js";

const DEFAULT_TABLE_NAME = "audit_logs";

interface EffectiveQueryConfig {
  tableName: string;
}

/**
 * State shared by the root query and every scope derived from it. Same
 * shape as the write-side `SharedRuntime` but with a read-only reader
 * instead of a queue + driver.
 */
interface SharedRuntime {
  pool: Pool;
  rootClosed: boolean;
  rootClosing: Promise<void> | null;
  scopes: Set<InternalScopeHandle>;
}

interface InternalScopeHandle {
  close(): Promise<void>;
}

function effectiveFromConfig(config: TracevaultQueryConfig): EffectiveQueryConfig {
  return {
    tableName: config.tableName ?? DEFAULT_TABLE_NAME,
  };
}

function mergeOverrides(
  base: EffectiveQueryConfig,
  overrides: TracevaultQueryScopeOverrides | undefined,
): EffectiveQueryConfig {
  if (!overrides) return { ...base };
  return {
    tableName: overrides.tableName ?? base.tableName,
  };
}

/**
 * Create a read-side Tracevault instance (internal building block).
 *
 * Used by `startTracevault` for the read pool.
 */
export function createTracevaultQuery(config: TracevaultQueryConfig): TracevaultQuery {
  validateQueryConfig(config);

  const pool =
    config.pool ??
    new Pool({
      connectionString: config.connectionString,
    });
  if (!config.pool) {
    pool.on("error", () => {
      /* swallow */
    });
  } else {
    pool.on("error", () => {
      /* swallow */
    });
  }

  const runtime: SharedRuntime = {
    pool,
    rootClosed: false,
    rootClosing: null,
    scopes: new Set(),
  };

  return buildInstance(runtime, effectiveFromConfig(config), { isRoot: true });
}

function buildInstance(
  runtime: SharedRuntime,
  effective: EffectiveQueryConfig,
  opts: { isRoot: boolean },
): TracevaultQuery {
  const reader = new PostgresReader({
    pool: runtime.pool,
    tableName: effective.tableName,
  });

  let localClosed = false;
  let localClosePromise: Promise<void> | null = null;

  const subject = opts.isRoot ? "query instance" : "query scope";

  function assertOpen(): void {
    if (runtime.rootClosed && !opts.isRoot) {
      throw new TracevaultError(
        "Tracevault: root query instance is closed; scope is no longer usable.",
      );
    }
    if (runtime.rootClosed && opts.isRoot) {
      throw new TracevaultError(
        "Tracevault: query instance is closed; no further reads accepted.",
      );
    }
    if (localClosed) {
      throw new TracevaultError(
        `Tracevault: ${subject} is closed; no further reads accepted.`,
      );
    }
  }

  /**
   * Scope-local close. The reader is stateless, so this only flips a flag.
   * Idempotent.
   */
  function closeLocal(): Promise<void> {
    if (localClosePromise) return localClosePromise;
    localClosed = true;
    localClosePromise = Promise.resolve();
    return localClosePromise;
  }

  // Register scopes so root.close() can mark them closed too. As on the
  // write side, we intentionally never remove the handle from
  // `runtime.scopes` in scope.close(): root.close() is the single place
  // that clears the set, so a racing scope.close() can't cause root.close()
  // to miss a still-valid scope.
  const handle: InternalScopeHandle | null = opts.isRoot ? null : { close: closeLocal };
  if (handle) runtime.scopes.add(handle);

  const instance: TracevaultQuery = {
    async findMany<
      TData extends Record<string, unknown> = Record<string, unknown>,
      TMeta extends Record<string, unknown> = Record<string, unknown>,
    >(filters?: AuditQueryFilters): Promise<Array<AuditRecord<TData, TMeta>>> {
      assertOpen();
      const normalized = validateAndNormalizeFilters(filters);
      return reader.findMany<TData, TMeta>(normalized);
    },

    async findById<
      TData extends Record<string, unknown> = Record<string, unknown>,
      TMeta extends Record<string, unknown> = Record<string, unknown>,
    >(id: string): Promise<AuditRecord<TData, TMeta> | null> {
      assertOpen();
      assertUuid(id, "id");
      return reader.findById<TData, TMeta>(id);
    },

    async count(filters?: AuditCountFilters): Promise<number> {
      assertOpen();
      const normalized = validateAndNormalizeCountFilters(filters);
      return reader.count(normalized);
    },

    scope(overrides?: TracevaultQueryScopeOverrides): TracevaultQuery {
      if (runtime.rootClosed) {
        throw new TracevaultError(
          "Tracevault: cannot create query scope — root query instance is closed.",
        );
      }
      if (localClosed) {
        throw new TracevaultError(
          `Tracevault: cannot create query scope from a closed ${subject}.`,
        );
      }
      validateQueryScopeOverrides(overrides);
      const merged = mergeOverrides(effective, overrides);
      return buildInstance(runtime, merged, { isRoot: false });
    },

    close(): Promise<void> {
      if (opts.isRoot) {
        if (runtime.rootClosing) return runtime.rootClosing;
        runtime.rootClosed = true;
        runtime.rootClosing = (async () => {
          await closeLocal();
          const scopes = Array.from(runtime.scopes);
          runtime.scopes.clear();
          await Promise.all(scopes.map((s) => s.close().catch(() => {})));
          try {
            await runtime.pool.end();
          } catch (err) {
            throw new DriverError(
              "Tracevault: failed to close PostgreSQL pool (query).",
              err,
            );
          }
        })();
        return runtime.rootClosing;
      }

      // Scope close: flip the local flag and return. Do NOT remove
      // ourselves from runtime.scopes; root.close() is the single place
      // that clears the set, so a concurrent root.close() never misses us.
      return closeLocal();
    },

    async healthcheck(): Promise<boolean> {
      if (runtime.rootClosed || localClosed) return false;
      try {
        const result = await runtime.pool.query("SELECT 1 AS ok");
        return result.rows[0]?.ok === 1;
      } catch {
        return false;
      }
    },
  };

  return instance;
}
