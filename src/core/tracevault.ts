import { PostgresDriver } from "../drivers/postgres/postgres-driver.js";
import type { AuditDriverClient } from "../drivers/driver.js";
import { TracevaultError } from "./errors.js";
import { DEFAULT_MASK_VALUE } from "./masker.js";
import type {
  AuditDiffEvent,
  AuditEvent,
  PersistedRecord,
  Tracevault,
  TracevaultConfig,
} from "../types/index.js";
import { normalizeDiffEvent, normalizeEvent, type NormalizeOptions } from "./normalizer.js";
import { AsyncQueue } from "./queue.js";
import { validateConfig, validateDiffEvent, validateEvent } from "./validator.js";

const DEFAULT_TABLE_NAME = "audit_logs";
const DEFAULT_BATCH_SIZE = 50;

/**
 * Create a Tracevault instance.
 *
 * This factory is the only public entry point developers interact with.
 * It returns an object with the minimum API needed to emit custom events.
 */
export function createTracevault(config: TracevaultConfig): Tracevault {
  validateConfig(config);

  const tableName = config.tableName ?? DEFAULT_TABLE_NAME;
  const defaultMode = config.defaultMode ?? "sync";
  const maskFields = config.maskFields ?? [];
  const maskValue = config.maskValue ?? DEFAULT_MASK_VALUE;
  const defaultEnvironment = config.environment ?? null;

  const normalizeOpts: NormalizeOptions = {
    defaultMode,
    defaultEnvironment,
    maskFields,
    maskValue,
  };

  const driver: AuditDriverClient = new PostgresDriver({
    connectionString: config.connectionString,
    tableName,
  });

  const onError =
    config.onError ??
    ((err: Error, record: PersistedRecord) => {
      // eslint-disable-next-line no-console
      console.error(
        `[Tracevault] async insert failed for event "${record.event}" (id=${record.id}):`,
        err,
      );
    });

  const queue = new AsyncQueue({
    batchSize: config.asyncBatchSize ?? DEFAULT_BATCH_SIZE,
    flushIntervalMs: config.asyncFlushIntervalMs ?? 0,
    handler: (record) => driver.insert(record),
    onError,
  });

  let closed = false;
  let closingPromise: Promise<void> | null = null;

  function assertOpen(): void {
    if (closed) {
      throw new TracevaultError("Tracevault: instance is closed; no further events accepted.");
    }
  }

  async function persist(record: PersistedRecord): Promise<void> {
    if (record.mode === "async") {
      queue.enqueue(record);
      return;
    }
    await driver.insert(record);
  }

  return {
    async emit(event: AuditEvent): Promise<void> {
      assertOpen();
      validateEvent(event);
      const record = normalizeEvent(event, normalizeOpts);
      await persist(record);
    },

    async emitDiff(event: AuditDiffEvent): Promise<void> {
      assertOpen();
      validateDiffEvent(event);
      const record = normalizeDiffEvent(event, normalizeOpts);
      await persist(record);
    },

    async flush(): Promise<void> {
      await queue.flush();
    },

    close(): Promise<void> {
      if (closingPromise) return closingPromise;
      closed = true;
      closingPromise = (async () => {
        await queue.close();
        await driver.close();
      })();
      return closingPromise;
    },

    async healthcheck(): Promise<boolean> {
      if (closed) return false;
      return driver.healthcheck();
    },
  };
}
