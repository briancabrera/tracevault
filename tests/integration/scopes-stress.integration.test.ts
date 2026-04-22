import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";

import { createTracevault, generateInitSql } from "../../src/index.js";
import { CONN_STRING, createDbClient, selectAll, truncate } from "./helpers.js";

// A dedicated pool of tables for stress tests. We use many to exercise the
// shared pg.Pool under concurrent multi-scope writes.
const STRESS_TABLES = Array.from({ length: 10 }, (_, i) => `audit_stress_${i}`);

let dbClient: pg.Client;

async function resetTables(): Promise<void> {
  for (const t of STRESS_TABLES) {
    await dbClient.query(`DROP TABLE IF EXISTS "${t}" CASCADE`);
    await dbClient.query(generateInitSql(t));
  }
}

beforeAll(async () => {
  dbClient = await createDbClient();
  await resetTables();
});

afterAll(async () => {
  for (const t of STRESS_TABLES) {
    await dbClient.query(`DROP TABLE IF EXISTS "${t}" CASCADE`);
  }
  await dbClient.end();
});

afterEach(async () => {
  for (const t of STRESS_TABLES) await truncate(dbClient, t);
});

async function countAll(tables: readonly string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of tables) {
    const res = await dbClient.query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM "${t}"`);
    out[t] = Number(res.rows[0]!.c);
  }
  return out;
}

async function allIdsAcross(tables: readonly string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const t of tables) {
    const res = await dbClient.query<{ id: string }>(`SELECT id FROM "${t}"`);
    for (const r of res.rows) ids.push(r.id);
  }
  return ids;
}

// -----------------------------------------------------------------------------
describe("integration / scopes — stress (sync)", () => {
  it("N scopes × M concurrent sync emits land in the right tables with no id collisions", async () => {
    const N = STRESS_TABLES.length; // 10
    const M = 100;
    const root = createTracevault({
      driver: "postgres",
      connectionString: CONN_STRING,
      tableName: STRESS_TABLES[0]!,
    });
    const scopes = STRESS_TABLES.map((t) => root.scope({ tableName: t }));
    try {
      const tasks: Array<Promise<void>> = [];
      for (let i = 0; i < N; i++) {
        const scope = scopes[i]!;
        const table = STRESS_TABLES[i]!;
        for (let j = 0; j < M; j++) {
          tasks.push(
            scope.emit({
              event: `stress.${i}.${j}`,
              actor: { id: `actor_${i}`, type: "user" },
              data: { scope: table, j },
            }),
          );
        }
      }
      await Promise.all(tasks);
    } finally {
      await root.close();
    }

    const counts = await countAll(STRESS_TABLES);
    for (const t of STRESS_TABLES) expect(counts[t]).toBe(M);

    // Global UUID uniqueness across every table.
    const ids = await allIdsAcross(STRESS_TABLES);
    expect(ids).toHaveLength(N * M);
    expect(new Set(ids).size).toBe(N * M);
  }, 60_000);

  it("root + scope pointing at the same table both succeed without interleaving corruption", async () => {
    // Edge case: two handles on the same pool writing to the same table.
    // Every row must land exactly once, with per-handle provenance in `meta`.
    const table = STRESS_TABLES[0]!;
    const root = createTracevault({
      driver: "postgres",
      connectionString: CONN_STRING,
      tableName: table,
    });
    const sibling = root.scope({ tableName: table });
    const N = 150;

    try {
      const tasks: Array<Promise<void>> = [];
      for (let i = 0; i < N; i++) {
        tasks.push(
          root.emit({
            event: `same.table.root.${i}`,
            meta: { source: "root", i },
          }),
        );
        tasks.push(
          sibling.emit({
            event: `same.table.sibling.${i}`,
            meta: { source: "sibling", i },
          }),
        );
      }
      await Promise.all(tasks);
    } finally {
      await root.close();
    }

    const rows = await selectAll(dbClient, table);
    expect(rows).toHaveLength(N * 2);
    const byEvent = rows.map((r) => r.event);
    expect(byEvent.filter((e) => e.startsWith("same.table.root.")).length).toBe(N);
    expect(byEvent.filter((e) => e.startsWith("same.table.sibling.")).length).toBe(N);
    expect(new Set(rows.map((r) => r.id)).size).toBe(N * 2);
  }, 30_000);
});

// -----------------------------------------------------------------------------
describe("integration / scopes — stress (async)", () => {
  it("root.close() drains a large async backlog spread across many scopes", async () => {
    const N = 5;
    const M = 200;
    const usedTables = STRESS_TABLES.slice(0, N);
    const root = createTracevault({
      driver: "postgres",
      connectionString: CONN_STRING,
      tableName: usedTables[0]!,
    });
    const scopes = usedTables.map((t) =>
      root.scope({
        tableName: t,
        defaultMode: "async",
        // Keep the timer long enough that nothing auto-flushes during enqueue,
        // forcing root.close() to do the actual draining.
        asyncFlushIntervalMs: 10_000,
      }),
    );

    for (let j = 0; j < M; j++) {
      for (let i = 0; i < N; i++) {
        await scopes[i]!.emit({ event: `a.${i}`, data: { j } });
      }
    }

    // Nothing scoped has flushed yet. root.close() is the only drain path.
    const before = await countAll(usedTables);
    for (const t of usedTables) expect(before[t]).toBe(0);

    await root.close();

    const after = await countAll(usedTables);
    for (const t of usedTables) expect(after[t]).toBe(M);

    // After root.close() every scope must be unusable.
    for (const s of scopes) {
      expect(await s.healthcheck()).toBe(false);
      await expect(s.emit({ event: "post" })).rejects.toThrow(/root instance is closed/);
    }
  }, 60_000);

  it("mixed sync + async across scopes maintains per-scope mode and order within a scope", async () => {
    const [syncT, asyncT, mixedT] = STRESS_TABLES.slice(0, 3) as [string, string, string];
    const root = createTracevault({
      driver: "postgres",
      connectionString: CONN_STRING,
      tableName: syncT,
    });
    const syncScope = root.scope({ tableName: syncT, defaultMode: "sync" });
    const asyncScope = root.scope({ tableName: asyncT, defaultMode: "async" });
    const mixedScope = root.scope({ tableName: mixedT, defaultMode: "sync" });
    const N = 80;

    try {
      for (let i = 0; i < N; i++) {
        await Promise.all([
          syncScope.emit({ event: `s.${i}`, data: { i } }),
          asyncScope.emit({ event: `a.${i}`, data: { i } }),
          // Explicit mode override per emit on the mixed scope.
          mixedScope.emit({ event: `m.${i}`, data: { i }, mode: i % 2 === 0 ? "sync" : "async" }),
        ]);
      }
      // Sync rows should be there already without any flush.
      const syncBefore = await countAll([syncT]);
      expect(syncBefore[syncT]).toBe(N);

      await asyncScope.flush();
      await mixedScope.flush();
    } finally {
      await root.close();
    }

    const counts = await countAll([syncT, asyncT, mixedT]);
    expect(counts[syncT]).toBe(N);
    expect(counts[asyncT]).toBe(N);
    expect(counts[mixedT]).toBe(N);

    // Every row in the async-mode table must be stamped mode='async'.
    const asyncRows = await selectAll(dbClient, asyncT);
    for (const r of asyncRows) expect(r.mode).toBe("async");

    // In the mixed table, parity must follow the per-emit override.
    const mixedRows = await selectAll(dbClient, mixedT);
    for (const r of mixedRows) {
      const i = (r.data as { i: number }).i;
      expect(r.mode).toBe(i % 2 === 0 ? "sync" : "async");
    }
  }, 60_000);

  it("small asyncBatchSize per scope under heavy load still drains fully", async () => {
    const table = STRESS_TABLES[0]!;
    const root = createTracevault({
      driver: "postgres",
      connectionString: CONN_STRING,
      tableName: table,
    });
    const scope = root.scope({
      tableName: table,
      defaultMode: "async",
      asyncBatchSize: 3, // Force many drain iterations
    });
    const N = 250;

    try {
      for (let i = 0; i < N; i++) {
        await scope.emit({ event: "batch.small", data: { i } });
      }
      await scope.flush();
      const rows = await selectAll(dbClient, table);
      expect(rows).toHaveLength(N);
      // No duplicates.
      expect(new Set(rows.map((r) => r.id)).size).toBe(N);
    } finally {
      await root.close();
    }
  }, 60_000);
});

// -----------------------------------------------------------------------------
describe("integration / scopes — stress (lifecycle churn)", () => {
  it("create-emit-close cycles don't leak: the shared pool stays healthy across many iterations", async () => {
    const table = STRESS_TABLES[0]!;
    const root = createTracevault({
      driver: "postgres",
      connectionString: CONN_STRING,
      tableName: table,
    });
    const ITER = 50;

    try {
      for (let i = 0; i < ITER; i++) {
        const scope = root.scope({ tableName: table, defaultMode: i % 2 === 0 ? "sync" : "async" });
        await scope.emit({ event: "churn", data: { i } });
        await scope.close();
        // Root is still alive after every cycle.
        expect(await root.healthcheck()).toBe(true);
      }
    } finally {
      await root.close();
    }

    const rows = await selectAll(dbClient, table);
    expect(rows).toHaveLength(ITER);
    expect(new Set(rows.map((r) => r.id)).size).toBe(ITER);
  }, 60_000);

  it("many scopes created up-front + concurrent emits + a single root.close() at the end", async () => {
    const N = STRESS_TABLES.length; // 10
    const root = createTracevault({
      driver: "postgres",
      connectionString: CONN_STRING,
      tableName: STRESS_TABLES[0]!,
    });
    const scopes = STRESS_TABLES.map((t, i) =>
      root.scope({
        tableName: t,
        // Alternate sync/async to exercise both paths through one root.close().
        defaultMode: i % 2 === 0 ? "sync" : "async",
      }),
    );
    const M = 60;

    const tasks: Array<Promise<void>> = [];
    for (let j = 0; j < M; j++) {
      for (let i = 0; i < N; i++) {
        tasks.push(scopes[i]!.emit({ event: `many.${i}.${j}`, data: { i, j } }));
      }
    }
    await Promise.all(tasks);

    // Don't flush scopes manually; let root.close() drain all async queues.
    await root.close();

    const counts = await countAll(STRESS_TABLES);
    for (const t of STRESS_TABLES) expect(counts[t]).toBe(M);

    const ids = await allIdsAcross(STRESS_TABLES);
    expect(ids).toHaveLength(N * M);
    expect(new Set(ids).size).toBe(N * M);
  }, 60_000);
});
