import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";

import {
  TABLE,
  createDbClient,
  newAudit,
  selectAll,
  selectRaw,
  truncate,
} from "./helpers.js";

let dbClient: pg.Client;

beforeAll(async () => {
  dbClient = await createDbClient();
});

afterAll(async () => {
  await dbClient.end();
});

afterEach(async () => {
  await truncate(dbClient);
});

// -----------------------------------------------------------------------------
describe("integration / persistence shape", () => {
  it("emit (sync) inserts a real row with the exact shape", async () => {
    const audit = newAudit({ maskFields: ["password"] });
    try {
      const occurredAt = new Date("2026-02-15T10:00:00.000Z");
      await audit.emit({
        event: "product.price.updated",
        actor: { id: "user_123", type: "user" },
        target: { id: "product_456", type: "product" },
        data: { oldPrice: 120, newPrice: 150, password: "nope" },
        meta: { source: "admin-panel", ip: "127.0.0.1" },
        correlationId: "corr-1",
        requestId: "req-1",
        environment: "test",
        occurredAt,
      });

      const [row] = await selectAll(dbClient);
      expect(row!.event).toBe("product.price.updated");
      expect(row!.actor_id).toBe("user_123");
      expect(row!.actor_type).toBe("user");
      expect(row!.target_id).toBe("product_456");
      expect(row!.target_type).toBe("product");
      expect(row!.data).toEqual({ oldPrice: 120, newPrice: 150, password: "[REDACTED]" });
      expect(row!.meta).toEqual({ source: "admin-panel", ip: "127.0.0.1" });
      expect(row!.mode).toBe("sync");
      expect(row!.occurred_at.toISOString()).toBe("2026-02-15T10:00:00.000Z");
      expect(row!.correlation_id).toBe("corr-1");
      expect(row!.request_id).toBe("req-1");
      expect(row!.environment).toBe("test");
      expect(row!.created_at).toBeInstanceOf(Date);
      expect(row!.id).toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      await audit.close();
    }
  });

  it("emit (async) inserts rows after flush()", async () => {
    const audit = newAudit({ defaultMode: "async" });
    try {
      await audit.emit({ event: "evt.a", occurredAt: new Date("2026-01-01T00:00:00Z") });
      await audit.emit({ event: "evt.b", occurredAt: new Date("2026-01-02T00:00:00Z") });
      await audit.emit({ event: "evt.c", occurredAt: new Date("2026-01-03T00:00:00Z") });

      expect(await selectAll(dbClient)).toHaveLength(0);

      await audit.flush();

      const rows = await selectAll(dbClient);
      expect(rows.map((r) => r.event)).toEqual(["evt.a", "evt.b", "evt.c"]);
      expect(rows.every((r) => r.mode === "async")).toBe(true);
    } finally {
      await audit.close();
    }
  });

  it("emitDiff persists { before, after, diff } inside data", async () => {
    const audit = newAudit({ maskFields: ["password"] });
    try {
      await audit.emitDiff({
        event: "user.updated",
        actor: { id: "u1", type: "user" },
        target: { id: "u1", type: "user" },
        before: { name: "Jane", password: "old" },
        after: { name: "Jane D.", password: "new" },
      });

      const [row] = await selectAll(dbClient);
      const data = row!.data as {
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
    } finally {
      await audit.close();
    }
  });

  it("emitDiff handles missing `before` (creation case) as an empty object", async () => {
    // When `before` is not provided, normalizeDiffEvent substitutes `{}` so the
    // persisted `data.before` is an empty object rather than `null`. Brand-new
    // keys only have `after` in the diff entry because JSON.stringify omits
    // `undefined` fields; this test pins that behavior explicitly.
    const audit = newAudit();
    try {
      await audit.emitDiff({ event: "created", after: { id: 1, name: "x" } });
      const [row] = await selectAll(dbClient);
      const data = row!.data as {
        before: Record<string, unknown>;
        after: Record<string, unknown>;
        diff: Record<string, { before?: unknown; after?: unknown }>;
      };
      expect(data.before).toEqual({});
      expect(data.after).toEqual({ id: 1, name: "x" });
      expect(Object.keys(data.diff).sort()).toEqual(["id", "name"]);
      expect(data.diff.id!.after).toBe(1);
      expect(data.diff.name!.after).toBe("x");
    } finally {
      await audit.close();
    }
  });

  it("occurredAt defaults to ~now when not provided", async () => {
    const audit = newAudit();
    const t0 = Date.now();
    try {
      await audit.emit({ event: "tick" });
      const [row] = await selectAll(dbClient);
      const t = row!.occurred_at.getTime();
      expect(t).toBeGreaterThanOrEqual(t0 - 1000);
      expect(t).toBeLessThanOrEqual(Date.now() + 1000);
    } finally {
      await audit.close();
    }
  });

  it("stamps the configured environment and lets events override it", async () => {
    const audit = newAudit({ environment: "staging" });
    try {
      await audit.emit({ event: "defaulted" });
      await audit.emit({ event: "overridden", environment: "prod" });

      const rows = await selectAll(dbClient);
      const byEvent = Object.fromEntries(rows.map((r) => [r.event, r.environment]));
      expect(byEvent["defaulted"]).toBe("staging");
      expect(byEvent["overridden"]).toBe("prod");
    } finally {
      await audit.close();
    }
  });

  it("respects per-event mode override over defaultMode", async () => {
    const audit = newAudit({ defaultMode: "sync" });
    try {
      await audit.emit({ event: "async.one", mode: "async" });
      await audit.emit({ event: "sync.one" });
      await audit.flush();

      const rows = await selectAll(dbClient);
      const byEvent = Object.fromEntries(rows.map((r) => [r.event, r.mode]));
      expect(byEvent["async.one"]).toBe("async");
      expect(byEvent["sync.one"]).toBe("sync");
    } finally {
      await audit.close();
    }
  });
});

// -----------------------------------------------------------------------------
describe("integration / masking in the database", () => {
  it("masked values are not recoverable from the raw JSONB text", async () => {
    const audit = newAudit({ maskFields: ["password", "token", "pin"] });
    try {
      await audit.emit({
        event: "auth.login",
        data: { email: "a@b.com", password: "hunter2", session: { token: "xyz" } },
        meta: { pin: "0000", ip: "127.0.0.1" },
      });

      const [raw] = await selectRaw(dbClient);
      expect(raw!.data).not.toContain("hunter2");
      expect(raw!.data).not.toContain("xyz");
      expect(raw!.meta).not.toContain("0000");
      expect(raw!.data).toContain("[REDACTED]");
      expect(raw!.meta).toContain("[REDACTED]");
    } finally {
      await audit.close();
    }
  });

  it("masking survives deep nesting inside data and meta", async () => {
    const audit = newAudit({ maskFields: ["password"] });
    try {
      await audit.emit({
        event: "user.tree",
        data: {
          profile: {
            security: {
              credentials: { password: "xxx", recovery: { password: "yyy" } },
            },
          },
          others: [{ password: "zzz" }, { ok: true }],
        },
      });

      const [row] = await selectAll(dbClient);
      const data = row!.data as Record<string, unknown>;
      const profile = (data.profile as Record<string, unknown>)
        .security as Record<string, unknown>;
      const creds = profile.credentials as Record<string, unknown>;
      expect(creds.password).toBe("[REDACTED]");
      expect((creds.recovery as Record<string, unknown>).password).toBe("[REDACTED]");
      expect((data.others as Array<Record<string, unknown>>)[0]!.password).toBe("[REDACTED]");
    } finally {
      await audit.close();
    }
  });
});

// -----------------------------------------------------------------------------
describe("integration / payload edge cases", () => {
  it("preserves Unicode (emoji, non-latin, accents) in event names and payload", async () => {
    const audit = newAudit();
    try {
      await audit.emit({
        event: "product.coraçÃo.updated",
        data: {
          title: "📦 package",
          jp: "こんにちは",
          emoji: "🚀",
        },
        meta: { note: "çñü" },
      });

      const [row] = await selectAll(dbClient);
      expect(row!.event).toBe("product.coraçÃo.updated");
      expect(row!.data).toEqual({ title: "📦 package", jp: "こんにちは", emoji: "🚀" });
      expect(row!.meta).toEqual({ note: "çñü" });
    } finally {
      await audit.close();
    }
  });

  it("roundtrips deeply nested structures exactly", async () => {
    const audit = newAudit();
    const payload = {
      a: { b: { c: { d: { e: [1, 2, { f: true, g: null }] } } } },
    };
    try {
      await audit.emit({ event: "deep", data: payload });
      const [row] = await selectAll(dbClient);
      expect(row!.data).toEqual(payload);
    } finally {
      await audit.close();
    }
  });

  it("preserves arrays and mixed primitive types", async () => {
    const audit = newAudit();
    try {
      await audit.emit({
        event: "mixed",
        data: {
          tags: ["a", "b", "c"],
          counts: [1, 2, 3],
          mixed: [1, "two", null, true, false],
          nested: [[{ x: 1 }], []],
        },
      });
      const [row] = await selectAll(dbClient);
      expect(row!.data).toEqual({
        tags: ["a", "b", "c"],
        counts: [1, 2, 3],
        mixed: [1, "two", null, true, false],
        nested: [[{ x: 1 }], []],
      });
    } finally {
      await audit.close();
    }
  });

  it("preserves null values and empty containers", async () => {
    const audit = newAudit();
    try {
      await audit.emit({
        event: "empties",
        data: { nil: null, emptyObj: {}, emptyArr: [] },
        meta: {},
      });
      const [row] = await selectAll(dbClient);
      expect(row!.data).toEqual({ nil: null, emptyObj: {}, emptyArr: [] });
      expect(row!.meta).toEqual({});
    } finally {
      await audit.close();
    }
  });

  it("serializes Date values inside data as ISO strings in JSONB", async () => {
    const audit = newAudit();
    const happenedAt = new Date("2026-06-15T12:00:00.000Z");
    try {
      await audit.emit({ event: "dated", data: { happenedAt } });
      const [row] = await selectAll(dbClient);
      expect((row!.data as { happenedAt: unknown }).happenedAt).toBe("2026-06-15T12:00:00.000Z");
    } finally {
      await audit.close();
    }
  });

  it("handles large string payloads without truncation", async () => {
    const audit = newAudit();
    const big = "x".repeat(10_000);
    try {
      await audit.emit({ event: "big", data: { blob: big } });
      const [row] = await selectAll(dbClient);
      const blob = (row!.data as { blob: string }).blob;
      expect(blob).toHaveLength(10_000);
      expect(blob).toBe(big);
    } finally {
      await audit.close();
    }
  });

  it("inserts when actor, target, data and meta are all absent", async () => {
    const audit = newAudit();
    try {
      await audit.emit({ event: "sparse" });
      const [row] = await selectAll(dbClient);
      expect(row!.event).toBe("sparse");
      expect(row!.actor_id).toBeNull();
      expect(row!.actor_type).toBeNull();
      expect(row!.target_id).toBeNull();
      expect(row!.target_type).toBeNull();
      expect(row!.data).toBeNull();
      expect(row!.meta).toBeNull();
      expect(row!.correlation_id).toBeNull();
      expect(row!.request_id).toBeNull();
      expect(row!.environment).toBeNull();
    } finally {
      await audit.close();
    }
  });
});

// -----------------------------------------------------------------------------
describe("integration / timestamps", () => {
  it("stores occurredAt with timezone offset as the equivalent UTC instant", async () => {
    const audit = newAudit();
    try {
      // Same instant written two different ways.
      await audit.emit({ event: "tz.utc", occurredAt: "2026-03-01T03:00:00.000Z" });
      await audit.emit({ event: "tz.offset", occurredAt: "2026-03-01T00:00:00.000-03:00" });

      const rows = await selectAll(dbClient);
      const byEvent = Object.fromEntries(rows.map((r) => [r.event, r.occurred_at]));
      expect(byEvent["tz.utc"]!.toISOString()).toBe("2026-03-01T03:00:00.000Z");
      expect(byEvent["tz.offset"]!.toISOString()).toBe("2026-03-01T03:00:00.000Z");
    } finally {
      await audit.close();
    }
  });

  it("created_at is populated by the database, independent of occurredAt", async () => {
    const audit = newAudit();
    const pastOccurrence = new Date("2001-01-01T00:00:00.000Z");
    const t0 = Date.now();
    try {
      await audit.emit({ event: "ancient", occurredAt: pastOccurrence });
      const [row] = await selectAll(dbClient);
      expect(row!.occurred_at.toISOString()).toBe(pastOccurrence.toISOString());
      const createdAtMs = row!.created_at.getTime();
      expect(createdAtMs).toBeGreaterThanOrEqual(t0 - 1000);
      expect(createdAtMs).toBeLessThanOrEqual(Date.now() + 1000);
    } finally {
      await audit.close();
    }
  });
});

// -----------------------------------------------------------------------------
describe("integration / querying by indexed columns", () => {
  it("indexed columns return the right subset under typical filters", async () => {
    const audit = newAudit();
    try {
      const t = (iso: string) => new Date(iso);
      await audit.emit({
        event: "order.created",
        actor: { id: "u1", type: "user" },
        target: { id: "o1", type: "order" },
        occurredAt: t("2026-01-01T00:00:00Z"),
      });
      await audit.emit({
        event: "order.created",
        actor: { id: "u2", type: "user" },
        target: { id: "o2", type: "order" },
        occurredAt: t("2026-01-02T00:00:00Z"),
      });
      await audit.emit({
        event: "order.shipped",
        actor: { id: "u1", type: "user" },
        target: { id: "o1", type: "order" },
        occurredAt: t("2026-01-03T00:00:00Z"),
      });
      await audit.emit({
        event: "login",
        actor: { id: "u1", type: "user" },
        occurredAt: t("2026-02-01T00:00:00Z"),
      });

      const byEvent = await dbClient.query(
        `SELECT event FROM "${TABLE}" WHERE event = $1`,
        ["order.created"],
      );
      expect(byEvent.rowCount).toBe(2);

      const byActor = await dbClient.query(
        `SELECT event FROM "${TABLE}" WHERE actor_id = $1 AND actor_type = $2`,
        ["u1", "user"],
      );
      expect(byActor.rowCount).toBe(3);

      const byTarget = await dbClient.query(
        `SELECT event FROM "${TABLE}" WHERE target_id = $1 AND target_type = $2`,
        ["o1", "order"],
      );
      expect(byTarget.rowCount).toBe(2);

      const byRange = await dbClient.query(
        `SELECT event FROM "${TABLE}" WHERE occurred_at >= $1 AND occurred_at < $2 ORDER BY occurred_at ASC`,
        ["2026-01-02T00:00:00Z", "2026-02-01T00:00:00Z"],
      );
      expect(byRange.rows.map((r: { event: string }) => r.event)).toEqual([
        "order.created",
        "order.shipped",
      ]);
    } finally {
      await audit.close();
    }
  });
});

// -----------------------------------------------------------------------------
describe("integration / error handling", () => {
  it("sync emit surfaces DB failures as DriverError with context", async () => {
    await dbClient.query(`ALTER TABLE "${TABLE}" RENAME TO "${TABLE}_missing"`);
    const audit = newAudit();
    try {
      await expect(audit.emit({ event: "will.fail" })).rejects.toThrow(
        /failed to insert audit event "will\.fail"/,
      );
    } finally {
      await audit.close();
      await dbClient.query(`ALTER TABLE "${TABLE}_missing" RENAME TO "${TABLE}"`);
    }
  });

  it("async emit routes DB failures to onError with the full record", async () => {
    await dbClient.query(`ALTER TABLE "${TABLE}" RENAME TO "${TABLE}_missing"`);
    const errors: Array<{ err: Error; eventName: string; id: string; mode: string }> = [];
    const audit = newAudit({
      defaultMode: "async",
      onError: (err, record) =>
        errors.push({ err, eventName: record.event, id: record.id, mode: record.mode }),
    });
    try {
      await audit.emit({ event: "a.fail" });
      await audit.emit({ event: "b.fail" });
      await audit.flush();
      expect(errors).toHaveLength(2);
      expect(new Set(errors.map((e) => e.eventName))).toEqual(new Set(["a.fail", "b.fail"]));
      expect(errors.every((e) => e.mode === "async")).toBe(true);
      expect(errors.every((e) => /^[0-9a-f-]{36}$/.test(e.id))).toBe(true);
    } finally {
      await audit.close();
      await dbClient.query(`ALTER TABLE "${TABLE}_missing" RENAME TO "${TABLE}"`);
    }
  });

  it("async failures for some records do not prevent later successes", async () => {
    await dbClient.query(`ALTER TABLE "${TABLE}" RENAME TO "${TABLE}_missing"`);
    const errors: string[] = [];
    const audit = newAudit({
      defaultMode: "async",
      asyncBatchSize: 1,
      onError: (_err, record) => errors.push(record.event),
    });
    try {
      await audit.emit({ event: "broken.1" });
      await audit.emit({ event: "broken.2" });
      await audit.flush();
      expect(errors).toEqual(["broken.1", "broken.2"]);

      // Restore the table and confirm the queue still works.
      await dbClient.query(`ALTER TABLE "${TABLE}_missing" RENAME TO "${TABLE}"`);
      await audit.emit({ event: "recovered" });
      await audit.flush();
      const rows = await selectAll(dbClient);
      expect(rows.map((r) => r.event)).toEqual(["recovered"]);
    } finally {
      await audit.close();
      // Best-effort restore if the test body threw before restoring.
      await dbClient
        .query(`ALTER TABLE IF EXISTS "${TABLE}_missing" RENAME TO "${TABLE}"`)
        .catch(() => {});
    }
  });

  it("validation errors are thrown even when the DB is reachable", async () => {
    const audit = newAudit();
    try {
      await expect(audit.emit({ event: "" })).rejects.toThrow(/non-empty/);
      await expect(
        audit.emit({
          event: "x",
          data: { big: 1n as unknown as number },
        }),
      ).rejects.toThrow(/BigInt/);
      expect(await selectAll(dbClient)).toHaveLength(0);
    } finally {
      await audit.close();
    }
  });
});

// -----------------------------------------------------------------------------
describe("integration / lifecycle", () => {
  it("healthcheck returns true against a live DB", async () => {
    const audit = newAudit();
    try {
      expect(await audit.healthcheck()).toBe(true);
    } finally {
      await audit.close();
    }
  });

  it("close() is idempotent", async () => {
    const audit = newAudit();
    await audit.emit({ event: "once" });
    await Promise.all([audit.close(), audit.close()]);
    await audit.close();
  });

  it("close() drains the async queue before releasing the pool", async () => {
    const audit = newAudit({ defaultMode: "async" });
    for (let i = 0; i < 25; i++) {
      await audit.emit({ event: "drain.me", data: { i } });
    }
    // No manual flush — close() must wait for the queue on its own.
    await audit.close();

    const rows = await selectAll(dbClient);
    expect(rows).toHaveLength(25);
    expect(rows.every((r) => r.event === "drain.me")).toBe(true);
  });

  it("emit and emitDiff after close are rejected clearly", async () => {
    const audit = newAudit();
    await audit.close();
    await expect(audit.emit({ event: "x" })).rejects.toThrow(/closed/);
    await expect(audit.emitDiff({ event: "x" })).rejects.toThrow(/closed/);
    expect(await audit.healthcheck()).toBe(false);
  });

  it("two Tracevault instances against the same table coexist", async () => {
    const a = newAudit();
    const b = newAudit();
    try {
      await Promise.all([
        a.emit({ event: "from.a", actor: { id: "1", type: "u" } }),
        b.emit({ event: "from.b", actor: { id: "2", type: "u" } }),
      ]);

      // Closing one does not break the other.
      await a.close();
      await b.emit({ event: "from.b.later" });

      const rows = await selectAll(dbClient);
      expect(rows.map((r) => r.event).sort()).toEqual(["from.a", "from.b", "from.b.later"]);
    } finally {
      await b.close();
    }
  });

  it("supports a configurable table name end-to-end", async () => {
    const customTable = "audit_logs_custom";
    await dbClient.query(`DROP TABLE IF EXISTS "${customTable}"`);
    await dbClient.query(`CREATE TABLE "${customTable}" (LIKE "${TABLE}" INCLUDING ALL)`);

    const audit = newAudit({ tableName: customTable });
    try {
      await audit.emit({ event: "custom.table" });
      const rows = await selectAll(dbClient, customTable);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.event).toBe("custom.table");

      // The default table is untouched.
      expect(await selectAll(dbClient)).toHaveLength(0);
    } finally {
      await audit.close();
      await dbClient.query(`DROP TABLE IF EXISTS "${customTable}"`);
    }
  });

  it("close() fired while a sync emit is still in flight waits for the row", async () => {
    // pg.Pool.end() is documented to wait for in-flight clients to complete.
    // We rely on that guarantee here so no row is lost on shutdown.
    const audit = newAudit();
    const pending = audit.emit({ event: "inflight.sync.root" });
    const closed = audit.close();
    await Promise.all([pending, closed]);

    const rows = await selectAll(dbClient);
    expect(rows.map((r) => r.event)).toEqual(["inflight.sync.root"]);
  });

  it("healthcheck stays true while many concurrent emits hit the same pool", async () => {
    const audit = newAudit();
    try {
      const N = 40;
      const emits = Array.from({ length: N }, (_, i) =>
        audit.emit({ event: "hc.under.load", data: { i } }),
      );
      // Fire a burst of healthchecks interleaved with the emits.
      const checks = Array.from({ length: 10 }, () => audit.healthcheck());
      const [checkResults] = await Promise.all([Promise.all(checks), Promise.all(emits)]);

      expect(checkResults.every((ok) => ok === true)).toBe(true);
      expect(await selectAll(dbClient)).toHaveLength(N);
    } finally {
      await audit.close();
    }
    expect(await audit.healthcheck()).toBe(false);
  });

  it("many concurrent close() calls from different callers all resolve together", async () => {
    const audit = newAudit({ defaultMode: "async" });
    for (let i = 0; i < 40; i++) await audit.emit({ event: "race.close", data: { i } });

    // Simulate three different subsystems all trying to shut down at once
    // (e.g. SIGINT handler + shutdown hook + health drain). They must all
    // observe the same successful drain.
    await Promise.all([audit.close(), audit.close(), audit.close()]);

    expect(await selectAll(dbClient)).toHaveLength(40);
    expect(await audit.healthcheck()).toBe(false);
    await expect(audit.emit({ event: "after" })).rejects.toThrow(/closed/);
  });
});
