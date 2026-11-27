import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";

import { QueueFullError, startTracevault } from "../../src/index.js";
import { CONN_STRING, TABLE, createDbClient, newAudit, truncate } from "./helpers.js";

let dbClient: pg.Client;

beforeAll(async () => {
  dbClient = await createDbClient();
});

afterAll(async () => {
  await dbClient.end();
});

afterEach(async () => {
  await truncate(dbClient, TABLE);
});

async function countRows(): Promise<number> {
  const res = await dbClient.query<{ n: string }>(`SELECT count(*) AS n FROM "${TABLE}"`);
  return Number(res.rows[0]!.n);
}

describe("integration / bounded async queue", () => {
  it('"wait" applies back-pressure and persists every event', async () => {
    const audit = newAudit({ defaultMode: "async", asyncMaxQueueSize: 50, asyncBatchSize: 10 });
    try {
      await Promise.all(Array.from({ length: 2000 }, (_, i) => audit.emit({ event: `bp.${i}` })));
      await audit.flush();
      expect(await countRows()).toBe(2000);
    } finally {
      await audit.close();
    }
  });

  it('"drop" reports overflow through onError and persists the rest', async () => {
    const dropped: Error[] = [];
    const audit = newAudit({
      defaultMode: "async",
      asyncMaxQueueSize: 20,
      asyncQueueFullBehavior: "drop",
      onError: (err) => dropped.push(err),
    });
    try {
      for (let i = 0; i < 1000; i++) await audit.emit({ event: `drop.${i}` });
      await audit.flush();
      expect(dropped.length).toBeGreaterThan(0);
      expect(dropped.every((e) => e instanceof QueueFullError)).toBe(true);
      expect((await countRows()) + dropped.length).toBe(1000);
    } finally {
      await audit.close();
    }
  });
});

describe("integration / pool errors", () => {
  it("reports an idle client killed by the server to onPoolError and keeps working", async () => {
    const appName = `tv_pool_err_${process.pid}`;
    const poolErrors: Error[] = [];
    const tv = await startTracevault({
      driver: "postgres",
      connectionString: `${CONN_STRING}?application_name=${appName}`,
      defaultScope: "default",
      scopes: { default: { tableName: TABLE } },
      onPoolError: (err) => poolErrors.push(err),
    });
    try {
      await tv.emit({ event: "before.kill" });
      await dbClient.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1",
        [appName],
      );
      for (let i = 0; i < 50 && poolErrors.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(poolErrors.length).toBeGreaterThan(0);
      await tv.emit({ event: "after.kill" });
      expect(await countRows()).toBe(2);
    } finally {
      await tv.close();
    }
  });
});
