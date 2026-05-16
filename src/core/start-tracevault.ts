import { Client, Pool } from "pg";

import { createTracevaultQuery } from "../query/query.js";
import type { TracevaultQuery } from "../query/types.js";
import type { AuditDiffEvent, AuditEvent, StartTracevaultOptions } from "../types/index.js";
import { ensureAuditTableSchema } from "./audit-ddl.js";
import { ConfigError } from "./errors.js";
import { createTracevault } from "./tracevault.js";
import {
  assertValidScopeName,
  validateStartTracevaultOptions,
} from "./validator.js";

/** Read-only surface exposed on `TracevaultApp` and each scope handle. */
export type TracevaultAppQuery = Pick<TracevaultQuery, "findMany" | "findById" | "count">;

export interface TracevaultScopeHandle {
  emit(event: AuditEvent): Promise<void>;
  emitDiff(event: AuditDiffEvent): Promise<void>;
  flush(): Promise<void>;
  query: TracevaultAppQuery;
}

export interface TracevaultApp {
  emit(event: AuditEvent): Promise<void>;
  emitDiff(event: AuditDiffEvent): Promise<void>;
  flush(): Promise<void>;
  query: TracevaultAppQuery;
  getScope(name: string): TracevaultScopeHandle;
  close(): Promise<void>;
  healthcheck(): Promise<boolean>;
}

function queryFacade(query: TracevaultQuery): TracevaultAppQuery {
  return {
    findMany: query.findMany.bind(query),
    findById: query.findById.bind(query),
    count: query.count.bind(query),
  };
}

function attachPoolErrorHandler(pool: Pool): void {
  pool.on("error", () => {
    /* swallow idle-client errors; per-query errors still propagate */
  });
}

/**
 * Start Tracevault for a typical application: optional schema bootstrap,
 * separate read/write pools (or one injected pool with TLS), named scopes,
 * and integrated read API.
 */
export async function startTracevault(options: StartTracevaultOptions): Promise<TracevaultApp> {
  validateStartTracevaultOptions(options);

  const ensureSchema = options.bootstrap?.ensureSchema !== false;

  if (ensureSchema) {
    const uniqueTables = [...new Set(Object.values(options.scopes).map((s) => s.tableName))];
    if (options.pool) {
      const client = await options.pool.connect();
      try {
        for (const tableName of uniqueTables) {
          await ensureAuditTableSchema(client, tableName);
        }
      } finally {
        client.release();
      }
    } else {
      const client = new Client({ connectionString: options.connectionString });
      await client.connect();
      try {
        for (const tableName of uniqueTables) {
          await ensureAuditTableSchema(client, tableName);
        }
      } finally {
        await client.end();
      }
    }
  }

  let writePool: Pool;
  let ownsWritePool: boolean;
  if (options.pool) {
    writePool = options.pool;
    ownsWritePool = false;
  } else {
    writePool = new Pool({ connectionString: options.connectionString });
    attachPoolErrorHandler(writePool);
    ownsWritePool = true;
  }

  const readCs = options.readConnectionString ?? options.connectionString;

  let readPool: Pool;
  let ownsReadPool: boolean;
  if (options.readPool) {
    readPool = options.readPool;
    ownsReadPool = false;
  } else if (options.pool) {
    readPool = options.pool;
    ownsReadPool = false;
  } else {
    readPool = new Pool({ connectionString: readCs });
    attachPoolErrorHandler(readPool);
    ownsReadPool = true;
  }

  const defaultEntry = options.scopes[options.defaultScope];
  if (!defaultEntry) {
    throw new ConfigError(
      `startTracevault: missing scope config for defaultScope "${options.defaultScope}".`,
    );
  }
  const defaultTable = defaultEntry.tableName;

  const writer = createTracevault({
    driver: "postgres",
    connectionString: options.connectionString,
    pool: writePool,
    endPoolOnClose: ownsWritePool,
    tableName: defaultTable,
    defaultMode: options.defaultMode,
    environment: options.environment,
    maskFields: options.maskFields,
    maskValue: options.maskValue,
    onError: options.onError,
    asyncBatchSize: options.asyncBatchSize,
    asyncFlushIntervalMs: options.asyncFlushIntervalMs,
  });

  const reader = createTracevaultQuery({
    driver: "postgres",
    connectionString: readCs,
    pool: readPool,
    endPoolOnClose: ownsReadPool,
    tableName: defaultTable,
  });

  const scopeCache = new Map<string, TracevaultScopeHandle>();

  function getScope(name: string): TracevaultScopeHandle {
    assertValidScopeName(name, "getScope");
    if (!Object.prototype.hasOwnProperty.call(options.scopes, name)) {
      throw new ConfigError(
        `Unknown scope "${name}". Known scopes: ${Object.keys(options.scopes).join(", ")}.`,
      );
    }
    const hit = scopeCache.get(name);
    if (hit) return hit;

    let handle: TracevaultScopeHandle;
    if (name === options.defaultScope) {
      handle = {
        emit: writer.emit.bind(writer),
        emitDiff: writer.emitDiff.bind(writer),
        flush: writer.flush.bind(writer),
        query: queryFacade(reader),
      };
    } else {
      const scopeEntry = options.scopes[name];
      if (!scopeEntry) {
        throw new ConfigError(`Unknown scope "${name}".`);
      }
      const tableName = scopeEntry.tableName;
      const w = writer.scope({ tableName });
      const r = reader.scope({ tableName });
      handle = {
        emit: w.emit.bind(w),
        emitDiff: w.emitDiff.bind(w),
        flush: w.flush.bind(w),
        query: queryFacade(r),
      };
    }
    scopeCache.set(name, handle);
    return handle;
  }

  return {
    emit: writer.emit.bind(writer),
    emitDiff: writer.emitDiff.bind(writer),
    flush: writer.flush.bind(writer),
    query: queryFacade(reader),
    getScope,
    async close() {
      await writer.close();
      await reader.close();
    },
    async healthcheck() {
      return (await writer.healthcheck()) && (await reader.healthcheck());
    },
  };
}
