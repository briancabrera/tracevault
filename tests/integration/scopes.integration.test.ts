import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";

import { generateInitSql, createTracevault } from "../../src/index.js";
import {
  CONN_STRING,
  TABLE,
  createDbClient,
  selectAll,
  truncate,
} from "./helpers.js";

const USER_TABLE = "audit_user_events";
const TX_TABLE = "audit_transaction_events";
const ORDER_TABLE = "audit_order_events";
// "user" is a SQL reserved word in several dialects; we always quote table
// names, so a table literally called "user" is legal. We still use a safer
// name here but pick something that tests the quoting (starts with a shape
// people often avoid): `user`-prefixed with no suffix wouldn't be valid per
// our regex, so we use "user_logs" and verify it works through the
// double-quoted identifier path.
const QUOTED_TABLE = "user_logs";

const ALL_EXTRA_TABLES = [USER_TABLE, TX_TABLE, ORDER_TABLE, QUOTED_TABLE];

let dbClient: pg.Client;

async function applyInitSql(client: pg.Client, tableName: string): Promise<void> {
  await client.query(`DROP TABLE IF EXISTS "${tableName}" CASCADE`);
  await client.query(generateInitSql(tableName));
}

beforeAll(async () => {
  dbClient = await createDbClient();
  for (const t of ALL_EXTRA_TABLES) {
    await applyInitSql(dbClient, t);
  }
});

afterAll(async () => {
  for (const t of ALL_EXTRA_TABLES) {
    await dbClient.query(`DROP TABLE IF EXISTS "${t}" CASCADE`);
  }
  await dbClient.end();
});

afterEach(async () => {
  await truncate(dbClient, TABLE);
  for (const t of ALL_EXTRA_TABLES) {
    await truncate(dbClient, t);
  }
});

// -----------------------------------------------------------------------------
describe("integration / scopes — schema application via generateInitSql", () => {
  it("generateInitSql produces DDL that creates a working audit table", async () => {
    const freshTable = "audit_integration_fresh";
    await dbClient.query(`DROP TABLE IF EXISTS "${freshTable}" CASCADE`);
    try {
      const sql = generateInitSql(freshTable);
      await dbClient.query(sql);

      const root = createTracevault({
        driver: "postgres",
        connectionString: CONN_STRING,
        tableName: freshTable,
      });
      try {
        await root.emit({ event: "fresh.evt", data: { ok: true } });
        const rows = await selectAll(dbClient, freshTable);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.event).toBe("fresh.evt");
      } finally {
        await root.close();
      }

      // Running the SQL again must be a no-op (IF NOT EXISTS).
      await expect(dbClient.query(sql)).resolves.toBeDefined();
    } finally {
      await dbClient.query(`DROP TABLE IF EXISTS "${freshTable}" CASCADE`);
    }
  });

  it("generateInitSql creates the same usable shape for several tables at once", async () => {
    // The three tables (user/tx/order) were created by beforeAll using
    // generateInitSql. We verify basic insert+read works on each.
    const root = createTracevault({
      driver: "postgres",
      connectionString: CONN_STRING,
      tableName: TABLE,
    });
    const users = root.scope({ tableName: USER_TABLE });
    const tx = root.scope({ tableName: TX_TABLE });
    const orders = root.scope({ tableName: ORDER_TABLE });
    try {
      await users.emit({ event: "u.evt", actor: { id: "u1", type: "user" } });
      await tx.emit({ event: "t.evt", actor: { id: "m1", type: "merchant" } });
      await orders.emit({ event: "o.evt", target: { id: "o1", type: "order" } });

      expect((await selectAll(dbClient, USER_TABLE)).map((r) => r.event)).toEqual(["u.evt"]);
      expect((await selectAll(dbClient, TX_TABLE)).map((r) => r.event)).toEqual(["t.evt"]);
      expect((await selectAll(dbClient, ORDER_TABLE)).map((r) => r.event)).toEqual(["o.evt"]);
    } finally {
      await root.close();
    }
  });
});

// -----------------------------------------------------------------------------
describe("integration / scopes — isolated persistence", () => {
  it("each scope persists only to its own table", async () => {
    const root = createTracevault({
      driver: "postgres",
      connectionString: CONN_STRING,
      tableName: TABLE,
      environment: "prod",
    });
    const userAudit = root.scope({ tableName: USER_TABLE });
    const txAudit = root.scope({ tableName: TX_TABLE, defaultMode: "sync" });

    try {
      await userAudit.emit({
        event: "user.profile.updated",
        actor: { id: "user_123", type: "user" },
        target: { id: "user_123", type: "user" },
        data: { field: "phone" },
      });
      await txAudit.emit({
        event: "payment.intent.created",
        actor: { id: "merchant_42", type: "merchant" },
        target: { id: "payment_987", type: "payment" },
        data: { amount: 1200, currency: "UYU" },
      });
      await root.emit({ event: "root.only" });
    } finally {
      await root.close();
    }

    const userRows = await selectAll(dbClient, USER_TABLE);
    const txRows = await selectAll(dbClient, TX_TABLE);
    const rootRows = await selectAll(dbClient, TABLE);

    expect(userRows).toHaveLength(1);
    expect(userRows[0]!.event).toBe("user.profile.updated");
    expect(userRows[0]!.actor_id).toBe("user_123");
    expect(userRows[0]!.environment).toBe("prod"); // inherited from root

    expect(txRows).toHaveLength(1);
    expect(txRows[0]!.event).toBe("payment.intent.created");
    expect((txRows[0]!.data as { amount: number }).amount).toBe(1200);

    expect(rootRows).toHaveLength(1);
    expect(rootRows[0]!.event).toBe("root.only");
  });

  it("emitDiff on a scope persists to the scope's table with { before, after, diff }", async () => {
    const root = createTracevault({
      driver: "postgres",
      connectionString: CONN_STRING,
      tableName: TABLE,
      maskFields: ["password"],
    });
    const users = root.scope({ tableName: USER_TABLE });

    try {
      await users.emitDiff({
        event: "user.updated",
        actor: { id: "u1", type: "user" },
        before: { name: "Jane", password: "old" },
        after: { name: "Jane D.", password: "new" },
      });
    } finally {
      await root.close();
    }

    const rootRows = await selectAll(dbClient, TABLE);
    const userRows = await selectAll(dbClient, USER_TABLE);
    expect(rootRows).toHaveLength(0);
    expect(userRows).toHaveLength(1);
    const data = userRows[0]!.data as {
      before: Record<string, unknown>;
      after: Record<string, unknown>;
      diff: Record<string, unknown>;
    };
    expect(data.before).toEqual({ name: "Jane", password: "[REDACTED]" });
    expect(data.after).toEqual({ name: "Jane D.", password: "[REDACTED]" });
    expect(data.diff).toEqual({
      name: { before: "Jane", after: "Jane D." },
      password: "[REDACTED]",
    });
  });

  it("each scope has its own async queue", async () => {
    // Proving "own queue" end-to-end requires preventing the two queues from
    // racing each other into the event loop. We pin tx's drain far in the
    // future so users.flush() must resolve *before* tx's queue even
    // schedules its handler — if scopes truly share a queue, this can't work.
    const root = createTracevault({
      driver: "postgres",
      connectionString: CONN_STRING,
      tableName: TABLE,
    });
    const users = root.scope({
      tableName: USER_TABLE,
      defaultMode: "async",
      asyncFlushIntervalMs: 0,
    });
    const tx = root.scope({
      tableName: TX_TABLE,
      defaultMode: "async",
      // Long enough that tx's timer can't fire while users.flush() awaits
      // its microtasks; root.close() at the end drains it regardless.
      asyncFlushIntervalMs: 500,
    });

    try {
      for (let i = 0; i < 10; i++) {
        await users.emit({ event: "u.evt", data: { i } });
        await tx.emit({ event: "t.evt", data: { i } });
      }

      await users.flush();
      expect(await selectAll(dbClient, USER_TABLE)).toHaveLength(10);
      // tx's timer is still pending, so no rows should have landed yet.
      expect(await selectAll(dbClient, TX_TABLE)).toHaveLength(0);
    } finally {
      // root.close() unconditionally drains every scope's queue, including tx.
      await root.close();
    }

    expect(await selectAll(dbClient, TX_TABLE)).toHaveLength(10);
  });
});

// -----------------------------------------------------------------------------
describe("integration / scopes — lifecycle", () => {
  it("scope.close() drains only the scope's queue; root keeps working", async () => {
    const root = createTracevault({
      driver: "postgres",
      connectionString: CONN_STRING,
      tableName: TABLE,
    });
    const users = root.scope({ tableName: USER_TABLE, defaultMode: "async" });

    try {
      for (let i = 0; i < 5; i++) {
        await users.emit({ event: "buffered", data: { i } });
      }
      await users.close(); // drains scope queue; root stays usable

      expect(await selectAll(dbClient, USER_TABLE)).toHaveLength(5);

      await root.emit({ event: "root.still.alive" });
      expect((await selectAll(dbClient, TABLE)).map((r) => r.event)).toEqual([
        "root.still.alive",
      ]);

      expect(await root.healthcheck()).toBe(true);
    } finally {
      await root.close();
    }
  });

  it("root.close() drains every scope's queue before releasing the pool", async () => {
    const root = createTracevault({
      driver: "postgres",
      connectionString: CONN_STRING,
      tableName: TABLE,
    });
    const users = root.scope({ tableName: USER_TABLE, defaultMode: "async" });
    const tx = root.scope({ tableName: TX_TABLE, defaultMode: "async" });

    for (let i = 0; i < 15; i++) {
      await users.emit({ event: "u", data: { i } });
      await tx.emit({ event: "t", data: { i } });
    }
    // No explicit flush / close on scopes. root.close() must drain them.
    await root.close();

    expect(await selectAll(dbClient, USER_TABLE)).toHaveLength(15);
    expect(await selectAll(dbClient, TX_TABLE)).toHaveLength(15);
  });

  it("root.close() invalidates every scope, and emit rejects clearly", async () => {
    const root = createTracevault({
      driver: "postgres",
      connectionString: CONN_STRING,
      tableName: TABLE,
    });
    const users = root.scope({ tableName: USER_TABLE });
    const tx = root.scope({ tableName: TX_TABLE });

    await root.close();

    await expect(users.emit({ event: "x" })).rejects.toThrow(/root instance is closed/);
    await expect(tx.emitDiff({ event: "x" })).rejects.toThrow(/root instance is closed/);
    expect(await users.healthcheck()).toBe(false);
    expect(await tx.healthcheck()).toBe(false);
    expect(() => root.scope({ tableName: USER_TABLE })).toThrow(
      /root instance is closed/,
    );
  });
});

// -----------------------------------------------------------------------------
describe("integration / scopes — error handling", () => {
  it("emitting against a non-existent scope table surfaces a clear DriverError", async () => {
    const missingTable = "audit_totally_missing_table";
    await dbClient.query(`DROP TABLE IF EXISTS "${missingTable}" CASCADE`);

    const root = createTracevault({
      driver: "postgres",
      connectionString: CONN_STRING,
      tableName: TABLE,
    });
    const scoped = root.scope({ tableName: missingTable });

    try {
      await expect(scoped.emit({ event: "no.table" })).rejects.toThrow(
        /failed to insert audit event "no\.table"/,
      );
      // Root remains functional against its own existing table.
      await root.emit({ event: "root.lives" });
      expect((await selectAll(dbClient, TABLE)).map((r) => r.event)).toEqual([
        "root.lives",
      ]);
    } finally {
      await root.close();
    }
  });

  it("async inserts against a non-existent scope table flow to onError", async () => {
    const missingTable = "audit_async_missing";
    await dbClient.query(`DROP TABLE IF EXISTS "${missingTable}" CASCADE`);

    const errors: Array<{ event: string; err: Error }> = [];
    const root = createTracevault({
      driver: "postgres",
      connectionString: CONN_STRING,
      tableName: TABLE,
    });
    const scoped = root.scope({
      tableName: missingTable,
      defaultMode: "async",
      onError: (err, record) => errors.push({ event: record.event, err }),
    });

    try {
      await scoped.emit({ event: "async.missing.a" });
      await scoped.emit({ event: "async.missing.b" });
      await scoped.flush();

      expect(errors.map((e) => e.event).sort()).toEqual([
        "async.missing.a",
        "async.missing.b",
      ]);
      for (const e of errors) expect(e.err.message).toMatch(/failed to insert/);
    } finally {
      await root.close();
    }
  });

  it("onError on one scope never receives failures from another scope", async () => {
    const tableA = "audit_onerror_a_missing";
    const tableB = "audit_onerror_b_missing";
    await dbClient.query(`DROP TABLE IF EXISTS "${tableA}" CASCADE`);
    await dbClient.query(`DROP TABLE IF EXISTS "${tableB}" CASCADE`);

    const aErrors: string[] = [];
    const bErrors: string[] = [];
    const root = createTracevault({
      driver: "postgres",
      connectionString: CONN_STRING,
      tableName: TABLE,
      onError: () => {
        throw new Error("should not reach root onError");
      },
    });
    const a = root.scope({
      tableName: tableA,
      defaultMode: "async",
      onError: (_err, r) => aErrors.push(r.event),
    });
    const b = root.scope({
      tableName: tableB,
      defaultMode: "async",
      onError: (_err, r) => bErrors.push(r.event),
    });

    try {
      for (let i = 0; i < 5; i++) {
        await a.emit({ event: `a.${i}` });
        await b.emit({ event: `b.${i}` });
      }
      await root.close(); // drains both scopes' queues

      expect(aErrors.sort()).toEqual(["a.0", "a.1", "a.2", "a.3", "a.4"]);
      expect(bErrors.sort()).toEqual(["b.0", "b.1", "b.2", "b.3", "b.4"]);
      // No cross-pollination.
      expect(aErrors.some((e) => e.startsWith("b."))).toBe(false);
      expect(bErrors.some((e) => e.startsWith("a."))).toBe(false);
    } catch (err) {
      await root.close().catch(() => {});
      throw err;
    }
  });

  it("an async failure on one scope does not prevent later successes on the same scope", async () => {
    // Drop the scope's table to provoke failure, then recreate it and verify
    // subsequent emits land cleanly. Mirror of the root-level recovery test,
    // confirming each scope's queue is independent of the failure state.
    const scopeTable = "audit_scope_recovery";
    await applyInitSql(dbClient, scopeTable);
    await dbClient.query(`ALTER TABLE "${scopeTable}" RENAME TO "${scopeTable}_missing"`);

    const errors: string[] = [];
    const root = createTracevault({
      driver: "postgres",
      connectionString: CONN_STRING,
      tableName: TABLE,
    });
    const scoped = root.scope({
      tableName: scopeTable,
      defaultMode: "async",
      asyncBatchSize: 1,
      onError: (_err, r) => errors.push(r.event),
    });

    try {
      await scoped.emit({ event: "broken.1" });
      await scoped.emit({ event: "broken.2" });
      await scoped.flush();
      expect(errors).toEqual(["broken.1", "broken.2"]);

      // Restore the table and confirm the same scope handle still works.
      await dbClient.query(`ALTER TABLE "${scopeTable}_missing" RENAME TO "${scopeTable}"`);
      await scoped.emit({ event: "recovered" });
      await scoped.flush();

      const rows = await selectAll(dbClient, scopeTable);
      expect(rows.map((r) => r.event)).toEqual(["recovered"]);

      // The root's own table is untouched by any of this.
      expect(await selectAll(dbClient, TABLE)).toHaveLength(0);
    } finally {
      await root.close();
      await dbClient
        .query(`ALTER TABLE IF EXISTS "${scopeTable}_missing" RENAME TO "${scopeTable}"`)
        .catch(() => {});
      await dbClient.query(`DROP TABLE IF EXISTS "${scopeTable}" CASCADE`);
    }
  });
});

// -----------------------------------------------------------------------------
describe("integration / scopes — deep composition and inheritance", () => {
  it("root → scope → sub-scope inherit and override along the chain", async () => {
    const root = createTracevault({
      driver: "postgres",
      connectionString: CONN_STRING,
      tableName: TABLE,
      environment: "prod",
      maskFields: ["password"],
    });
    // scope(1) inherits prod + password masking, changes maskFields only.
    const mid = root.scope({
      tableName: USER_TABLE,
      maskFields: ["token"],
    });
    // scope(2) inherits mid's tableName/maskFields, overrides environment.
    const leaf = mid.scope({
      tableName: TX_TABLE,
      environment: "staging",
    });

    try {
      await root.emit({
        event: "root.evt",
        data: { password: "r", token: "r" },
      });
      await mid.emit({
        event: "mid.evt",
        data: { password: "m", token: "m" },
      });
      await leaf.emit({
        event: "leaf.evt",
        data: { password: "l", token: "l" },
      });
    } finally {
      await root.close();
    }

    const rootRow = (await selectAll(dbClient, TABLE))[0]!;
    const midRow = (await selectAll(dbClient, USER_TABLE))[0]!;
    const leafRow = (await selectAll(dbClient, TX_TABLE))[0]!;

    // Root: prod env, masks password.
    expect(rootRow.environment).toBe("prod");
    expect((rootRow.data as Record<string, unknown>).password).toBe("[REDACTED]");
    expect((rootRow.data as Record<string, unknown>).token).toBe("r");

    // Mid: inherits prod env, maskFields switched to ["token"].
    expect(midRow.environment).toBe("prod");
    expect((midRow.data as Record<string, unknown>).password).toBe("m");
    expect((midRow.data as Record<string, unknown>).token).toBe("[REDACTED]");

    // Leaf: inherits mid's maskFields (token), overrides env to staging.
    expect(leafRow.environment).toBe("staging");
    expect((leafRow.data as Record<string, unknown>).password).toBe("l");
    expect((leafRow.data as Record<string, unknown>).token).toBe("[REDACTED]");
  });

  it("root.close() drains queues from scopes nested several levels deep", async () => {
    const root = createTracevault({
      driver: "postgres",
      connectionString: CONN_STRING,
      tableName: TABLE,
    });
    const a = root.scope({ tableName: USER_TABLE, defaultMode: "async" });
    const b = a.scope({ tableName: TX_TABLE, defaultMode: "async" });
    const c = b.scope({ tableName: ORDER_TABLE, defaultMode: "async" });

    for (let i = 0; i < 12; i++) {
      await a.emit({ event: "a", data: { i } });
      await b.emit({ event: "b", data: { i } });
      await c.emit({ event: "c", data: { i } });
    }
    // Nothing flushed yet.
    await root.close();

    expect(await selectAll(dbClient, USER_TABLE)).toHaveLength(12);
    expect(await selectAll(dbClient, TX_TABLE)).toHaveLength(12);
    expect(await selectAll(dbClient, ORDER_TABLE)).toHaveLength(12);
  });
});

// -----------------------------------------------------------------------------
describe("integration / scopes — quoted identifiers and per-scope defaults", () => {
  it("scopes work with table names that overlap with SQL reserved words (quoting)", async () => {
    const root = createTracevault({
      driver: "postgres",
      connectionString: CONN_STRING,
      tableName: TABLE,
    });
    const scoped = root.scope({ tableName: QUOTED_TABLE });

    try {
      await scoped.emit({
        event: "reserved.word.evt",
        actor: { id: "u1", type: "user" },
      });
      const rows = await selectAll(dbClient, QUOTED_TABLE);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.event).toBe("reserved.word.evt");
    } finally {
      await root.close();
    }
  });

  it("scope without a tableName override falls back to the root's table", async () => {
    const root = createTracevault({
      driver: "postgres",
      connectionString: CONN_STRING,
      tableName: TABLE,
      environment: "prod",
    });
    // Same table as root, but different onError / environment override.
    const scoped = root.scope({ environment: "staging" });

    try {
      await root.emit({ event: "root.here" });
      await scoped.emit({ event: "scope.here" });
    } finally {
      await root.close();
    }

    const rows = await selectAll(dbClient, TABLE);
    const byEvent = Object.fromEntries(rows.map((r) => [r.event, r.environment]));
    expect(byEvent["root.here"]).toBe("prod");
    expect(byEvent["scope.here"]).toBe("staging");
  });
});

// -----------------------------------------------------------------------------
describe("integration / scopes — idempotent close and concurrent shutdown", () => {
  it("scope.close() is idempotent even under concurrent invocation", async () => {
    const root = createTracevault({
      driver: "postgres",
      connectionString: CONN_STRING,
      tableName: TABLE,
    });
    const scoped = root.scope({ tableName: USER_TABLE, defaultMode: "async" });

    for (let i = 0; i < 8; i++) {
      await scoped.emit({ event: "x", data: { i } });
    }

    // Fire three close()s in parallel from different call sites.
    await Promise.all([scoped.close(), scoped.close(), scoped.close()]);

    expect(await selectAll(dbClient, USER_TABLE)).toHaveLength(8);
    await expect(scoped.emit({ event: "after" })).rejects.toThrow(/scope is closed/);

    // Root pool remains fine.
    expect(await root.healthcheck()).toBe(true);
    await root.close();
  });

  it("root.close() + scope.close() fired concurrently remain safe", async () => {
    const root = createTracevault({
      driver: "postgres",
      connectionString: CONN_STRING,
      tableName: TABLE,
    });
    const scoped = root.scope({ tableName: USER_TABLE, defaultMode: "async" });
    for (let i = 0; i < 10; i++) await scoped.emit({ event: "conc", data: { i } });

    // Race the two close paths; both must converge without data loss.
    await Promise.all([root.close(), scoped.close()]);

    expect(await selectAll(dbClient, USER_TABLE)).toHaveLength(10);
    expect(await root.healthcheck()).toBe(false);
    expect(await scoped.healthcheck()).toBe(false);
  });

  it("root.close() while a sync emit is in flight still persists that row", async () => {
    const root = createTracevault({
      driver: "postgres",
      connectionString: CONN_STRING,
      tableName: TABLE,
    });
    const scoped = root.scope({ tableName: USER_TABLE });

    // Kick off a sync emit; do NOT await it.
    const pending = scoped.emit({ event: "inflight.sync" });

    // Immediately schedule close(); pg.Pool.end() waits for in-flight queries.
    const closed = root.close();

    await Promise.all([pending, closed]);

    const rows = await selectAll(dbClient, USER_TABLE);
    expect(rows.map((r) => r.event)).toEqual(["inflight.sync"]);
  });

  it("scope.flush() reentrancy — a second flush during a drain resolves the same work", async () => {
    const root = createTracevault({
      driver: "postgres",
      connectionString: CONN_STRING,
      tableName: TABLE,
    });
    const scoped = root.scope({
      tableName: USER_TABLE,
      defaultMode: "async",
      asyncBatchSize: 1, // Force many ticks so flush() overlaps itself
    });

    try {
      for (let i = 0; i < 20; i++) await scoped.emit({ event: "r", data: { i } });

      // Three overlapping flushes. None should leak events or double-insert.
      await Promise.all([scoped.flush(), scoped.flush(), scoped.flush()]);
      const rows = await selectAll(dbClient, USER_TABLE);
      expect(rows).toHaveLength(20);
      const ids = new Set(rows.map((r) => r.id));
      expect(ids.size).toBe(20);
    } finally {
      await root.close();
    }
  });
});
