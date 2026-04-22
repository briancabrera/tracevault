import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";

import { generateInitSql } from "../../src/index.js";
import { createTracevaultQuery } from "../../src/query/index.js";
import { CONN_STRING, createDbClient, truncate } from "./helpers.js";

// Dedicated pool of tables for read stress. Independent from write stress so
// both suites can run back-to-back without stepping on each other.
const STRESS_TABLES = Array.from({ length: 6 }, (_, i) => `audit_query_stress_${i}`);
const BULK_TABLE = STRESS_TABLES[0]!;

let dbClient: pg.Client;

async function resetTables(): Promise<void> {
  for (const t of STRESS_TABLES) {
    await dbClient.query(`DROP TABLE IF EXISTS "${t}" CASCADE`);
    await dbClient.query(generateInitSql(t));
  }
}

/**
 * Seed a table with N rows via a single multi-row INSERT.
 *
 * We intentionally bypass the write API here: the Read API is the code under
 * test, and running thousands of sync emits per test pushes every assertion
 * budget beyond the timeout for no structural gain. The schema is the same
 * one Tracevault produces via `generateInitSql`, so the rows are
 * indistinguishable from what the library would have written.
 */
async function seedBulk(
  table: string,
  count: number,
  opts: {
    event?: (i: number) => string;
    environment?: (i: number) => string | undefined;
    occurredAt?: (i: number) => Date;
  } = {},
): Promise<void> {
  const chunkSize = 500;
  for (let start = 0; start < count; start += chunkSize) {
    const end = Math.min(start + chunkSize, count);
    const values: string[] = [];
    const params: unknown[] = [];
    for (let i = start; i < end; i++) {
      const event = opts.event?.(i) ?? "bulk.event";
      const environment = opts.environment?.(i) ?? null;
      const occurredAt =
        opts.occurredAt?.(i) ?? new Date(Date.UTC(2024, 0, 1, 0, 0, 0) + i * 1000);
      const base = params.length;
      params.push(
        randomUUID(),
        event,
        `actor_${i}`,
        "user",
        JSON.stringify({ i }),
        "sync",
        occurredAt,
        environment,
      );
      values.push(
        `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}::jsonb, $${base + 6}, $${base + 7}, $${base + 8})`,
      );
    }
    await dbClient.query(
      `INSERT INTO "${table}" (id, event, actor_id, actor_type, data, mode, occurred_at, environment) VALUES ${values.join(", ")}`,
      params,
    );
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

// -----------------------------------------------------------------------------
describe("integration / query — stress: volume", () => {
  it("paginates through 1000 rows with no duplicates, no gaps, full coverage", async () => {
    const TOTAL = 1000;
    await seedBulk(BULK_TABLE, TOTAL);

    const q = createTracevaultQuery({
      driver: "postgres",
      connectionString: CONN_STRING,
      tableName: BULK_TABLE,
    });
    try {
      expect(await q.count()).toBe(TOTAL);

      const pageSize = 250;
      const seen: string[] = [];
      for (let offset = 0; offset < TOTAL; offset += pageSize) {
        const page = await q.findMany({
          limit: pageSize,
          offset,
          order: "asc",
        });
        for (const r of page) seen.push(r.id);
      }
      expect(seen.length).toBe(TOTAL);
      expect(new Set(seen).size).toBe(TOTAL); // no duplicates across pages

      // The concatenation of asc pages is strictly monotonic by (occurred_at, id).
      const fullAsc = await q.findMany({ limit: 500, order: "asc" });
      const nextAsc = await q.findMany({ limit: 500, offset: 500, order: "asc" });
      const reassembled = [...fullAsc, ...nextAsc].map((r) => r.id);
      expect(reassembled).toEqual(seen);
    } finally {
      await q.close();
    }
  });

  it("limit at the hard cap (500) works against a large dataset", async () => {
    await seedBulk(BULK_TABLE, 1000);
    const q = createTracevaultQuery({
      driver: "postgres",
      connectionString: CONN_STRING,
      tableName: BULK_TABLE,
    });
    try {
      const first = await q.findMany({ limit: 500 });
      expect(first).toHaveLength(500);
      const second = await q.findMany({ limit: 500, offset: 500 });
      expect(second).toHaveLength(500);
      const union = new Set([...first, ...second].map((r) => r.id));
      expect(union.size).toBe(1000);
    } finally {
      await q.close();
    }
  });

  it("count() respects combined filters across a large dataset", async () => {
    await seedBulk(BULK_TABLE, 600, {
      environment: (i) => (i % 3 === 0 ? "prod" : "staging"),
      event: (i) => (i % 5 === 0 ? "bulk.rare" : "bulk.common"),
    });

    const q = createTracevaultQuery({
      driver: "postgres",
      connectionString: CONN_STRING,
      tableName: BULK_TABLE,
    });
    try {
      expect(await q.count()).toBe(600);
      expect(await q.count({ environment: "prod" })).toBe(200);
      expect(await q.count({ event: "bulk.rare" })).toBe(120);
      expect(
        await q.count({ event: "bulk.rare", environment: "prod" }),
      ).toBe(40);
      expect(await q.count({ event: "bulk.common", environment: "staging" })).toBe(
        320,
      );
    } finally {
      await q.close();
    }
  });
});

// -----------------------------------------------------------------------------
describe("integration / query — stress: concurrency", () => {
  it("N concurrent findMany/count/findById across root + many scopes", async () => {
    // Seed each stress table independently so scopes can read in parallel.
    for (const t of STRESS_TABLES) {
      await seedBulk(t, 120, {
        event: (i) => `evt.${t}.${i % 4}`,
      });
    }

    const root = createTracevaultQuery({
      driver: "postgres",
      connectionString: CONN_STRING,
      tableName: STRESS_TABLES[0]!,
    });
    const scopes = STRESS_TABLES.slice(1).map((t) => root.scope({ tableName: t }));
    const all = [root, ...scopes];

    try {
      // Pre-grab one id per instance so findById has real targets.
      const sampleIds = await Promise.all(
        all.map(async (inst) => (await inst.findMany({ limit: 1 }))[0]!.id),
      );

      // Fire a mixed barrage across every instance.
      const ops: Array<Promise<unknown>> = [];
      for (let i = 0; i < all.length; i++) {
        const inst = all[i]!;
        const sampleId = sampleIds[i]!;
        for (let k = 0; k < 20; k++) {
          ops.push(inst.findMany({ limit: 50, offset: k % 3 }));
          ops.push(inst.count({ event: `evt.${STRESS_TABLES[i]}.${k % 4}` }));
          ops.push(inst.findById(sampleId));
        }
      }

      const results = await Promise.all(ops);
      expect(results).toHaveLength(all.length * 20 * 3);
      // Every findById must have found its seeded row.
      const foundById = results.filter(
        (r) =>
          r !== null &&
          typeof r === "object" &&
          !Array.isArray(r) &&
          "id" in (r as Record<string, unknown>),
      );
      expect(foundById.length).toBe(all.length * 20);
      // Every findMany returns an array.
      const arrays = results.filter(Array.isArray);
      expect(arrays.length).toBe(all.length * 20);
      // Every count returns a non-negative number.
      const counts = results.filter((r) => typeof r === "number") as number[];
      expect(counts.length).toBe(all.length * 20);
      expect(counts.every((n) => n >= 0)).toBe(true);
    } finally {
      await root.close();
    }
  });

  it("many scopes over the same table produce consistent counts and row sets", async () => {
    await seedBulk(BULK_TABLE, 300);
    const root = createTracevaultQuery({
      driver: "postgres",
      connectionString: CONN_STRING,
      tableName: BULK_TABLE,
    });
    try {
      const scopes = Array.from({ length: 15 }, () =>
        root.scope({ tableName: BULK_TABLE }),
      );
      const counts = await Promise.all(scopes.map((s) => s.count()));
      expect(counts.every((n) => n === 300)).toBe(true);

      const idsA = (await scopes[0]!.findMany({ limit: 500, order: "asc" })).map(
        (r) => r.id,
      );
      const idsB = (await scopes[1]!.findMany({ limit: 500, order: "asc" })).map(
        (r) => r.id,
      );
      expect(idsA).toEqual(idsB);
    } finally {
      await root.close();
    }
  });
});

// -----------------------------------------------------------------------------
describe("integration / query — stress: lifecycle churn", () => {
  it("rapid create/close cycles of independent query instances do not leak or hang", async () => {
    await seedBulk(BULK_TABLE, 50);
    const CYCLES = 30;
    for (let i = 0; i < CYCLES; i++) {
      const q = createTracevaultQuery({
        driver: "postgres",
        connectionString: CONN_STRING,
        tableName: BULK_TABLE,
      });
      expect(await q.healthcheck()).toBe(true);
      const rows = await q.findMany({ limit: 10 });
      expect(rows.length).toBeGreaterThan(0);
      await q.close();
      expect(await q.healthcheck()).toBe(false);
    }
    // A final fresh instance must still succeed — proving the test DB isn't
    // exhausted of connections.
    const probe = createTracevaultQuery({
      driver: "postgres",
      connectionString: CONN_STRING,
      tableName: BULK_TABLE,
    });
    try {
      expect(await probe.count()).toBe(50);
    } finally {
      await probe.close();
    }
  });

  it("50 concurrent close() calls across root and scopes all resolve and are idempotent", async () => {
    const root = createTracevaultQuery({
      driver: "postgres",
      connectionString: CONN_STRING,
      tableName: BULK_TABLE,
    });
    const scopes = STRESS_TABLES.slice(1).map((t) => root.scope({ tableName: t }));

    const closes: Array<Promise<void>> = [];
    for (let i = 0; i < 20; i++) closes.push(root.close());
    for (const s of scopes) {
      for (let i = 0; i < 5; i++) closes.push(s.close());
    }
    await Promise.all(closes);

    expect(await root.healthcheck()).toBe(false);
    for (const s of scopes) expect(await s.healthcheck()).toBe(false);
  });

  it("root.close() while dispatched reads are in-flight on many scopes — all settle, then reads reject", async () => {
    // NOTE: we stay below pg's default pool max (10) intentionally. When a
    // caller oversubscribes the pool AND calls end() in the same tick, the
    // queries still waiting in pg's internal pending queue never get
    // dispatched — that's a `pg-pool` behavior, not ours. Here we exercise
    // the scenario we actually promise: queries that have already acquired
    // a client complete cleanly while close() is draining.
    for (const t of STRESS_TABLES.slice(0, 4)) await seedBulk(t, 50);

    const root = createTracevaultQuery({
      driver: "postgres",
      connectionString: CONN_STRING,
      tableName: STRESS_TABLES[0]!,
    });
    const scopes = STRESS_TABLES.slice(1, 4).map((t) =>
      root.scope({ tableName: t }),
    );

    const inflight: Array<Promise<unknown>> = [
      root.findMany({ limit: 50 }),
      root.count(),
      scopes[0]!.findMany({ limit: 50 }),
      scopes[1]!.findMany({ limit: 50 }),
      scopes[2]!.count(),
    ];
    expect(inflight.length).toBeLessThan(10);

    // Fire root.close() without awaiting first. pool.end() must wait for
    // dispatched queries to complete before tearing the pool down, so none
    // of the inflight promises should reject.
    const closing = root.close();

    const settled = await Promise.allSettled(inflight);
    const rejected = settled.filter((s) => s.status === "rejected");
    expect(rejected).toHaveLength(0);

    await closing;

    // Post-close: every instance rejects further reads.
    await expect(root.findMany()).rejects.toThrow(/closed/);
    for (const s of scopes) {
      await expect(s.count()).rejects.toThrow(/closed/);
    }
  });
});
