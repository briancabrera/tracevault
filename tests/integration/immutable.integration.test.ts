import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";

import { ConfigError, generateInitSql, startTracevault } from "../../src/index.js";
import { CONN_STRING, createDbClient } from "./helpers.js";

const SQL_004 = readFileSync(resolve(__dirname, "../../sql/004_audit_logs_immutable.sql"), "utf8");

let db: pg.Client;

beforeAll(async () => {
  db = await createDbClient();
});

afterAll(async () => {
  await db.end();
});

function start(tableName: string, immutable: boolean) {
  return startTracevault({
    driver: "postgres",
    connectionString: CONN_STRING,
    defaultScope: "d",
    scopes: { d: { tableName } },
    bootstrap: { immutable },
  });
}

async function expectRejected(sql: string): Promise<void> {
  await expect(db.query(sql)).rejects.toMatchObject({ code: "42501" });
}

async function expectAppendOnly(table: string): Promise<void> {
  await expectRejected(`UPDATE "${table}" SET event = 'tampered'`);
  await expectRejected(`DELETE FROM "${table}"`);
  await expectRejected(`TRUNCATE "${table}"`);
}

describe("integration / immutable audit tables", () => {
  it("bootstrap.immutable rejects UPDATE, DELETE and TRUNCATE; inserts keep working", async () => {
    const table = "audit_tv_immutable";
    await db.query(`DROP TABLE IF EXISTS "${table}"`);
    const tv = await start(table, true);
    try {
      await tv.emit({ event: "first" });
      await expectAppendOnly(table);
      await tv.emit({ event: "second" });
      expect(await tv.query.count()).toBe(2);
    } finally {
      await tv.close();
    }

    // Restarting is a no-op and keeps exactly one trigger of each kind.
    await (await start(table, true)).close();
    const { rows } = await db.query(
      `SELECT tgname FROM pg_trigger WHERE tgrelid = $1::regclass AND NOT tgisinternal ORDER BY 1`,
      [table],
    );
    expect(rows.map((r) => r.tgname)).toEqual(["tracevault_append_only", "tracevault_no_truncate"]);
    await db.query(`DROP TABLE "${table}"`);
  });

  it("is opt-in: without it the table stays mutable", async () => {
    const table = "audit_tv_mutable";
    await db.query(`DROP TABLE IF EXISTS "${table}"`);
    await (await start(table, false)).close();
    await db.query(`DELETE FROM "${table}"`);
    await db.query(`DROP TABLE "${table}"`);
  });

  it("generateInitSql({ immutable }) and sql/004 install the same triggers, idempotently", async () => {
    for (const [table, sql] of [
      ["audit_tv_imm_gen", generateInitSql("audit_tv_imm_gen", { immutable: true })],
      [
        "audit_tv_imm_004",
        generateInitSql("audit_tv_imm_004") + SQL_004.replaceAll("audit_logs", "audit_tv_imm_004"),
      ],
    ] as const) {
      await db.query(`DROP TABLE IF EXISTS "${table}"`);
      await db.query(sql);
      await db.query(sql);
      // Row triggers only fire when a row matches.
      await db.query(
        `INSERT INTO "${table}" (id, event, mode, occurred_at) VALUES (gen_random_uuid(), 'e', 'sync', now())`,
      );
      await expectAppendOnly(table);
      await db.query(`DROP TABLE "${table}"`);
    }
  });

  it("bootstraps when another role owns the shared trigger function", async () => {
    const table = "audit_tv_imm_other_owner";
    await db.query(`DROP TABLE IF EXISTS "${table}"`);
    await db.query(`DROP FUNCTION IF EXISTS tracevault_reject_mutation() CASCADE`);
    await db.query(`DROP ROLE IF EXISTS tv_imm_app`);
    await db.query(`CREATE ROLE tv_imm_app LOGIN PASSWORD 'tv_imm_app'`);
    await db.query(`GRANT CREATE, USAGE ON SCHEMA public TO tv_imm_app`);
    // Installed first by the superuser (another "service").
    await db.query(generateInitSql("audit_tv_imm_first", { immutable: true }));
    const url = new URL(CONN_STRING);
    url.username = "tv_imm_app";
    url.password = "tv_imm_app";
    const tv = await startTracevault({
      driver: "postgres",
      connectionString: url.toString(),
      defaultScope: "d",
      scopes: { d: { tableName: table } },
      bootstrap: { immutable: true },
    });
    try {
      await tv.emit({ event: "e" });
    } finally {
      await tv.close();
    }
    await expectAppendOnly(table);
    await db.query(`DROP TABLE "${table}", "audit_tv_imm_first"`);
    await db.query(`REVOKE ALL ON SCHEMA public FROM tv_imm_app`);
    await db.query(`DROP ROLE tv_imm_app`);
  });

  it("rejects immutable without ensureSchema", async () => {
    await expect(
      startTracevault({
        driver: "postgres",
        connectionString: CONN_STRING,
        defaultScope: "d",
        scopes: { d: { tableName: "audit_tv_never" } },
        bootstrap: { ensureSchema: false, immutable: true },
      }),
    ).rejects.toThrow(ConfigError);
  });
});
