import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";

import { SchemaUpgradeError, startTracevault } from "../../src/index.js";
import { CONN_STRING, createDbClient } from "./helpers.js";

const SQL_001 = readFileSync(resolve(__dirname, "../../sql/001_init_audit_logs.sql"), "utf8");

let db: pg.Client;

beforeAll(async () => {
  db = await createDbClient();
});

afterAll(async () => {
  await db.end();
});

async function indexCount(table: string): Promise<number> {
  const res = await db.query<{ c: string }>(
    "SELECT COUNT(*)::text AS c FROM pg_indexes WHERE tablename = $1",
    [table],
  );
  return Number(res.rows[0]!.c);
}

function start(tableName: string) {
  return startTracevault({
    driver: "postgres",
    connectionString: CONN_STRING,
    defaultScope: "d",
    scopes: { d: { tableName } },
  });
}

describe("integration / bootstrap", () => {
  it("explains which old rows block the upgrade, and upgrades once they are fixed", async () => {
    const table = "audit_tv_upgrade_oversized";
    await db.query(`DROP TABLE IF EXISTS "${table}"`);
    await db.query(SQL_001.replaceAll("audit_logs", table));
    await db.query(
      `INSERT INTO "${table}" (id, event, data, mode, occurred_at) VALUES
       (gen_random_uuid(), 'a', jsonb_build_object('outcome', repeat('o', 65)), 'sync', NOW()),
       (gen_random_uuid(), 'b', jsonb_build_object('error', jsonb_build_object('code', repeat('c', 256))), 'sync', NOW()),
       (gen_random_uuid(), 'c', jsonb_build_object('outcome', '  ' || repeat('o', 64) || '  '), 'sync', NOW())`,
    );

    const err = await start(table).then(
      (tv) => tv.close().then(() => null),
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SchemaUpgradeError);
    const message = (err as Error).message;
    expect(message).toContain(`1 row(s) with data#>>'{outcome}' longer than 64`);
    expect(message).toContain(`1 row(s) with data#>>'{error,code}' longer than 255`);
    expect(message).not.toContain("severity");

    // The suggested fixes are valid SQL and unblock the upgrade.
    for (const fix of message.match(/UPDATE .*;/g)!) await db.query(fix);
    const tv = await start(table);
    try {
      expect(await tv.query.count({ outcome: "o".repeat(64) })).toBe(2);
    } finally {
      await tv.close();
    }
    await db.query(`DROP TABLE "${table}"`);
  });

  it("upgrades a table created by sql/001 only (adds generated columns)", async () => {
    const table = "audit_tv_upgrade_001";
    await db.query(`DROP TABLE IF EXISTS "${table}"`);
    await db.query(SQL_001.replaceAll("audit_logs", table));
    await db.query(
      `INSERT INTO "${table}" (id, event, data, mode, occurred_at)
       VALUES (gen_random_uuid(), 'legacy', '{"outcome":"failure"}', 'sync', NOW())`,
    );

    const tv = await start(table);
    try {
      await tv.emit({ event: "after.upgrade", data: { outcome: "success", severity: "info" } });
      expect(await tv.query.count({ outcome: "failure" })).toBe(1);
      expect(await tv.query.count({ severity: "info" })).toBe(1);
    } finally {
      await tv.close();
    }
    expect(await indexCount(table)).toBe(9);
    await db.query(`DROP TABLE "${table}"`);
  });

  it("concurrent startTracevault calls on a fresh table all succeed", async () => {
    const table = "audit_tv_concurrent_boot";
    await db.query(`DROP TABLE IF EXISTS "${table}"`);
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => start(table)));
    const rejected = results.filter((r) => r.status === "rejected");
    for (const r of results) if (r.status === "fulfilled") await r.value.close();
    expect(rejected).toEqual([]);
    expect(await indexCount(table)).toBe(9);
    await db.query(`DROP TABLE "${table}"`);
  });

  it("creates every index for table names near the 63-char limit", async () => {
    const t1 = "a".repeat(55) + "_one";
    const t2 = "a".repeat(55) + "_two";
    for (const t of [t1, t2]) await db.query(`DROP TABLE IF EXISTS "${t}"`);
    const tv = await startTracevault({
      driver: "postgres",
      connectionString: CONN_STRING,
      defaultScope: "x",
      scopes: { x: { tableName: t1 }, y: { tableName: t2 } },
    });
    await tv.close();
    expect(await indexCount(t1)).toBe(9);
    expect(await indexCount(t2)).toBe(9);
    for (const t of [t1, t2]) await db.query(`DROP TABLE "${t}"`);
  });

  it("async batches persist every field via multi-row insert", async () => {
    const table = "audit_tv_batch_insert";
    await db.query(`DROP TABLE IF EXISTS "${table}"`);
    const tv = await startTracevault({
      driver: "postgres",
      connectionString: CONN_STRING,
      defaultScope: "d",
      scopes: { d: { tableName: table } },
      defaultMode: "async",
      asyncBatchSize: 25,
      environment: "test",
    });
    try {
      for (let i = 0; i < 100; i++) {
        await tv.emit({
          event: "batch.item",
          actor: { id: `u${i}`, type: "user" },
          data: { i, outcome: i % 2 ? "success" : "failure" },
          meta: i % 3 === 0 ? undefined : { n: i },
          correlationId: `c${i % 4}`,
        });
      }
      await tv.flush();
      expect(await tv.query.count({})).toBe(100);
      expect(await tv.query.count({ outcome: "failure" })).toBe(50);
      const [row] = await tv.query.findMany({ actorId: "u7" });
      expect(row).toMatchObject({
        event: "batch.item",
        actorType: "user",
        data: { i: 7, outcome: "success" },
        meta: { n: 7 },
        correlationId: "c3",
        environment: "test",
        mode: "async",
      });
      const [noMeta] = await tv.query.findMany({ actorId: "u9" });
      expect(noMeta!.meta).toBeNull();
    } finally {
      await tv.close();
    }
    await db.query(`DROP TABLE "${table}"`);
  });
});
