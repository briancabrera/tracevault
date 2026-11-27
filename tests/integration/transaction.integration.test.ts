import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { ValidationError, startTracevault, type TracevaultApp } from "../../src/index.js";
import { CONN_STRING, TABLE, createDbClient, truncate } from "./helpers.js";

let dbClient: pg.Client;
let pool: pg.Pool;
let tv: TracevaultApp;

beforeAll(async () => {
  dbClient = await createDbClient();
  pool = new pg.Pool({ connectionString: CONN_STRING });
  tv = await startTracevault({
    driver: "postgres",
    connectionString: CONN_STRING,
    pool,
    defaultScope: "default",
    scopes: { default: { tableName: TABLE } },
    defaultMode: "async",
  });
});

afterAll(async () => {
  await tv.close();
  await pool.end();
  await dbClient.end();
});

afterEach(async () => {
  await truncate(dbClient, TABLE);
});

async function countRows(): Promise<number> {
  const res = await dbClient.query<{ n: string }>(`SELECT count(*) AS n FROM "${TABLE}"`);
  return Number(res.rows[0]!.n);
}

describe("integration / emit inside the caller's transaction", () => {
  it("commits with the transaction, written synchronously even with defaultMode async", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await tv.emit({ event: "tx.commit", data: { n: 1 } }, { client });
      await tv.emitDiff({ event: "tx.diff", before: { a: 1 }, after: { a: 2 } }, { client });
      const inTx = await client.query(`SELECT mode FROM "${TABLE}"`);
      expect(inTx.rows.map((r) => r.mode)).toEqual(["sync", "sync"]);
      expect(await countRows()).toBe(0);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    expect(await countRows()).toBe(2);
  });

  it("rolls back with the transaction", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await tv.emit({ event: "tx.rollback" }, { client });
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    expect(await countRows()).toBe(0);
  });

  it("rejects mode async with a client and an invalid client", async () => {
    await expect(tv.emit({ event: "x", mode: "async" }, { client: pool })).rejects.toThrow(
      ValidationError,
    );
    await expect(tv.emit({ event: "x" }, { client: {} as never })).rejects.toThrow(ValidationError);
  });
});
