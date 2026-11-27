import { Pool } from "pg";

import { attachPoolErrorHandler } from "../drivers/postgres/pool-errors.js";
import { PostgresDriver } from "../drivers/postgres/postgres-driver.js";
import { DriverError, TracevaultError } from "./errors.js";
import { DEFAULT_MASK_VALUE } from "./masker.js";
import type {
  AsyncQueueFullBehavior,
  AuditDiffEvent,
  AuditEvent,
  AuditMode,
  PersistedRecord,
  Tracevault,
  TracevaultConfig,
  TracevaultScopeOverrides,
} from "../types/index.js";
import { normalizeDiffEvent, normalizeEvent, type NormalizeOptions } from "./normalizer.js";
import { AsyncQueue } from "./queue.js";
import {
  validateConfig,
  validateDiffEvent,
  validateEvent,
  validatePersistedPayload,
  validateScopeOverrides,
} from "./validator.js";

const DEFAULT_TABLE_NAME = "audit_logs";
const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_MAX_QUEUE_SIZE = 10_000;

/**
 * Fully-resolved, normalized settings for a single Tracevault instance
 * (root or scope). Carries all the knobs the instance needs at runtime.
 */
interface EffectiveConfig {
  tableName: string;
  defaultMode: AuditMode;
  environment: string | null;
  maskFields: readonly string[];
  maskValue: string;
  onError: (err: Error, record: PersistedRecord) => void;
  asyncBatchSize: number;
  asyncFlushIntervalMs: number;
  asyncMaxQueueSize: number;
  asyncQueueFullBehavior: AsyncQueueFullBehavior;
}

/**
 * State shared by the root and every scope derived from it. This is how
 * `scope()` gets to reuse the same `pg.Pool` and how `root.close()` can
 * atomically invalidate every scope.
 */
interface SharedRuntime {
  pool: Pool;
  /** Root only: whether `close()` should call `pool.end()`. */
  endPoolOnClose: boolean;
  /** Set to `true` when root.close() has started. */
  rootClosed: boolean;
  /** Cached promise so `root.close()` is idempotent. */
  rootClosing: Promise<void> | null;
  /** All live scope instances, used by root.close() to drain their queues. */
  scopes: Set<InternalScopeHandle>;
}

interface InternalScopeHandle {
  close(): Promise<void>;
}

const DEFAULT_ON_ERROR = (err: Error, record: PersistedRecord): void => {
  // eslint-disable-next-line no-console
  console.error(
    `[Tracevault] async insert failed for event "${record.event}" (id=${record.id}):`,
    err,
  );
};

function effectiveFromConfig(config: TracevaultConfig): EffectiveConfig {
  return {
    tableName: config.tableName ?? DEFAULT_TABLE_NAME,
    defaultMode: config.defaultMode ?? "sync",
    environment: config.environment ?? null,
    maskFields: config.maskFields ?? [],
    maskValue: config.maskValue ?? DEFAULT_MASK_VALUE,
    onError: config.onError ?? DEFAULT_ON_ERROR,
    asyncBatchSize: config.asyncBatchSize ?? DEFAULT_BATCH_SIZE,
    asyncFlushIntervalMs: config.asyncFlushIntervalMs ?? 0,
    asyncMaxQueueSize: config.asyncMaxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE,
    asyncQueueFullBehavior: config.asyncQueueFullBehavior ?? "wait",
  };
}

function mergeOverrides(
  base: EffectiveConfig,
  overrides: TracevaultScopeOverrides | undefined,
): EffectiveConfig {
  if (!overrides) return { ...base };
  return {
    tableName: overrides.tableName ?? base.tableName,
    defaultMode: overrides.defaultMode ?? base.defaultMode,
    environment:
      overrides.environment !== undefined ? overrides.environment : base.environment,
    maskFields: overrides.maskFields ?? base.maskFields,
    maskValue: overrides.maskValue ?? base.maskValue,
    onError: overrides.onError ?? base.onError,
    asyncBatchSize: overrides.asyncBatchSize ?? base.asyncBatchSize,
    asyncFlushIntervalMs: overrides.asyncFlushIntervalMs ?? base.asyncFlushIntervalMs,
    asyncMaxQueueSize: overrides.asyncMaxQueueSize ?? base.asyncMaxQueueSize,
    asyncQueueFullBehavior: overrides.asyncQueueFullBehavior ?? base.asyncQueueFullBehavior,
  };
}

/**
 * Create a write-side Tracevault instance (internal building block).
 *
 * Applications should use `startTracevault` from the package entry.
 */
export function createTracevault(config: TracevaultConfig): Tracevault {
  validateConfig(config);

  const pool =
    config.pool ??
    new Pool({
      connectionString: config.connectionString,
    });
  const endPoolOnClose = config.endPoolOnClose ?? config.pool === undefined;
  attachPoolErrorHandler(pool, config.onPoolError, { injected: config.pool !== undefined });

  const runtime: SharedRuntime = {
    pool,
    endPoolOnClose,
    rootClosed: false,
    rootClosing: null,
    scopes: new Set(),
  };

  return buildInstance(runtime, effectiveFromConfig(config), { isRoot: true });
}

function buildInstance(
  runtime: SharedRuntime,
  effective: EffectiveConfig,
  opts: { isRoot: boolean },
): Tracevault {
  const driver = new PostgresDriver({
    pool: runtime.pool,
    tableName: effective.tableName,
  });

  const normalizeOpts: NormalizeOptions = {
    defaultMode: effective.defaultMode,
    defaultEnvironment: effective.environment,
    maskFields: effective.maskFields,
    maskValue: effective.maskValue,
  };

  const queue = new AsyncQueue({
    batchSize: effective.asyncBatchSize,
    flushIntervalMs: effective.asyncFlushIntervalMs,
    maxSize: effective.asyncMaxQueueSize,
    whenFull: effective.asyncQueueFullBehavior,
    handler: (record) => driver.insert(record),
    batchHandler: (records) => driver.insertMany(records),
    onError: effective.onError,
  });

  let localClosed = false;
  let localClosePromise: Promise<void> | null = null;

  const subject = opts.isRoot ? "instance" : "scope";

  function assertOpen(): void {
    if (runtime.rootClosed && !opts.isRoot) {
      throw new TracevaultError(
        "Tracevault: root instance is closed; scope is no longer usable.",
      );
    }
    if (runtime.rootClosed && opts.isRoot) {
      throw new TracevaultError(
        "Tracevault: instance is closed; no further events accepted.",
      );
    }
    if (localClosed) {
      throw new TracevaultError(
        `Tracevault: ${subject} is closed; no further events accepted.`,
      );
    }
  }

  async function persist(record: PersistedRecord): Promise<void> {
    if (record.mode === "async") {
      await queue.push(record);
      return;
    }
    await driver.insert(record);
  }

  /**
   * Close this instance's *local* state: drain its queue and mark its
   * driver closed. Does NOT touch the shared pool. Used both by
   * `scope.close()` and internally by `root.close()`.
   */
  function closeLocal(): Promise<void> {
    if (localClosePromise) return localClosePromise;
    localClosed = true;
    localClosePromise = (async () => {
      await queue.close();
      await driver.close();
      if (handle) runtime.scopes.delete(handle);
    })();
    return localClosePromise;
  }

  // Register scopes so root.close() can drain them too. scope.close() only
  // removes the handle after its drain finishes: a root.close() racing it
  // must still find the handle and `await` that drain before `pool.end()`.
  const handle: InternalScopeHandle | null = opts.isRoot ? null : { close: closeLocal };
  if (handle) runtime.scopes.add(handle);

  const instance: Tracevault = {
    async emit(event: AuditEvent): Promise<void> {
      assertOpen();
      validateEvent(event);
      const record = normalizeEvent(event, normalizeOpts);
      validatePersistedPayload(record);
      await persist(record);
    },

    async emitDiff(event: AuditDiffEvent): Promise<void> {
      assertOpen();
      validateDiffEvent(event);
      const record = normalizeDiffEvent(event, normalizeOpts);
      validatePersistedPayload(record);
      await persist(record);
    },

    async flush(): Promise<void> {
      await queue.flush();
    },

    close(): Promise<void> {
      if (opts.isRoot) {
        if (runtime.rootClosing) return runtime.rootClosing;
        runtime.rootClosed = true;
        runtime.rootClosing = (async () => {
          // 1. Drain the root's own queue (and mark its driver closed).
          await closeLocal();
          // 2. Drain every scope's queue. We snapshot and clear the set
          //    first so concurrent scope.close() calls don't race with us.
          const scopes = Array.from(runtime.scopes);
          runtime.scopes.clear();
          await Promise.all(
            scopes.map((s) =>
              s.close().catch(() => {
                // Scope queue drain failures are already routed through
                // each scope's onError — don't let one bad scope block pool
                // teardown.
              }),
            ),
          );
          // 3. Release the shared pool when this factory owns it.
          if (runtime.endPoolOnClose) {
            try {
              await runtime.pool.end();
            } catch (err) {
              throw new DriverError("Tracevault: failed to close PostgreSQL pool.", err);
            }
          }
        })();
        return runtime.rootClosing;
      }

      // Scope close: drain its own queue/driver and return. Do NOT remove
      // ourselves from runtime.scopes — if root.close() is running
      // concurrently, it must still be able to `await` our drain before
      // ending the pool. closeLocal() is idempotent, so root.close()
      // calling it again is harmless.
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

    scope(overrides?: TracevaultScopeOverrides): Tracevault {
      if (runtime.rootClosed) {
        throw new TracevaultError(
          "Tracevault: cannot create scope — root instance is closed.",
        );
      }
      if (localClosed) {
        throw new TracevaultError(
          `Tracevault: cannot create scope from a closed ${subject}.`,
        );
      }
      validateScopeOverrides(overrides);
      const merged = mergeOverrides(effective, overrides);
      return buildInstance(runtime, merged, { isRoot: false });
    },
  };

  return instance;
}
