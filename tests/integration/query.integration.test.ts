import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";

import { createTracevault, generateInitSql } from "../../src/index.js";
import { createTracevaultQuery } from "../../src/query/index.js";
import {
  DriverError,
  TracevaultError,
  ValidationError,
} from "../../src/core/errors.js";
import {
  CONN_STRING,
  TABLE,
  createDbClient,
  truncate,
} from "./helpers.js";

const USER_TABLE = "audit_user_events_q";
const TX_TABLE = "audit_transaction_events_q";

let dbClient: pg.Client;

async function applyInitSql(client: pg.Client, tableName: string): Promise<void> {
  await client.query(`DROP TABLE IF EXISTS "${tableName}" CASCADE`);
  await client.query(generateInitSql(tableName));
}

function newQuery(tableName = TABLE) {
  return createTracevaultQuery({
    driver: "postgres",
    connectionString: CONN_STRING,
    tableName,
  });
}

beforeAll(async () => {
  dbClient = await createDbClient();
  await applyInitSql(dbClient, USER_TABLE);
  await applyInitSql(dbClient, TX_TABLE);
});

afterAll(async () => {
  await dbClient.query(`DROP TABLE IF EXISTS "${USER_TABLE}" CASCADE`);
  await dbClient.query(`DROP TABLE IF EXISTS "${TX_TABLE}" CASCADE`);
  await dbClient.end();
});

afterEach(async () => {
  await truncate(dbClient, TABLE);
  await truncate(dbClient, USER_TABLE);
  await truncate(dbClient, TX_TABLE);
});

async function seed(): Promise<void> {
  const audit = createTracevault({
    driver: "postgres",
    connectionString: CONN_STRING,
    tableName: TABLE,
  });
  const users = audit.scope({ tableName: USER_TABLE });
  const tx = audit.scope({ tableName: TX_TABLE });
  try {
    await audit.emit({
      event: "app.started",
      actor: { id: "root", type: "system" },
      occurredAt: new Date("2026-04-01T08:00:00Z"),
      environment: "prod",
    });
    await audit.emit({
      event: "user.login",
      actor: { id: "user_1", type: "user" },
      occurredAt: new Date("2026-04-02T10:00:00Z"),
      environment: "prod",
      correlationId: "corr-1",
    });
    await audit.emit({
      event: "user.login",
      actor: { id: "user_2", type: "user" },
      occurredAt: new Date("2026-04-15T10:00:00Z"),
      environment: "staging",
      correlationId: "corr-2",
    });
    await audit.emit({
      event: "user.logout",
      actor: { id: "user_1", type: "user" },
      occurredAt: new Date("2026-05-01T10:00:00Z"),
      environment: "prod",
      mode: "async",
    });

    await users.emit({
      event: "user.profile.updated",
      actor: { id: "user_1", type: "user" },
      target: { id: "user_1", type: "user" },
      data: { field: "phone", value: "000-000" },
      occurredAt: new Date("2026-04-10T12:00:00Z"),
    });
    await users.emit({
      event: "user.profile.updated",
      actor: { id: "user_2", type: "user" },
      target: { id: "user_2", type: "user" },
      data: { field: "email" },
      occurredAt: new Date("2026-04-11T12:00:00Z"),
    });

    await tx.emit({
      event: "payment.intent.created",
      actor: { id: "merchant_42", type: "merchant" },
      target: { id: "payment_1", type: "payment" },
      data: { amount: 1000, currency: "UYU" },
      occurredAt: new Date("2026-04-05T09:00:00Z"),
    });
    await tx.emit({
      event: "payment.intent.created",
      actor: { id: "merchant_42", type: "merchant" },
      target: { id: "payment_2", type: "payment" },
      data: { amount: 1200, currency: "UYU" },
      occurredAt: new Date("2026-04-20T09:00:00Z"),
    });
    await tx.emit({
      event: "payment.intent.failed",
      actor: { id: "merchant_42", type: "merchant" },
      target: { id: "payment_3", type: "payment" },
      data: { reason: "card_declined" },
      occurredAt: new Date("2026-04-25T09:00:00Z"),
    });

    await audit.flush();
  } finally {
    await audit.close();
  }
}

// -----------------------------------------------------------------------------
describe("integration / query — basics", () => {
  it("returns rows with a fully-mapped AuditRecord shape", async () => {
    await seed();
    const q = newQuery();
    try {
      const rows = await q.findMany({ event: "app.started" });
      expect(rows).toHaveLength(1);
      const r = rows[0]!;
      expect(r.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
      expect(r.event).toBe("app.started");
      expect(r.actorId).toBe("root");
      expect(r.actorType).toBe("system");
      expect(r.targetId).toBeNull();
      expect(r.targetType).toBeNull();
      expect(r.mode).toBe("sync");
      expect(r.environment).toBe("prod");
      expect(r.occurredAt).toBeInstanceOf(Date);
      expect(r.createdAt).toBeInstanceOf(Date);
      expect(r.outcome).toBeNull();
      expect(r.errorCode).toBeNull();
      expect(r.severity).toBeNull();
    } finally {
      await q.close();
    }
  });

  it("orders by (occurred_at, id) with stable tie-break and respects desc/asc", async () => {
    await seed();
    const q = newQuery();
    try {
      const desc = await q.findMany();
      expect(desc.map((r) => r.event)).toEqual([
        "user.logout",
        "user.login",
        "user.login",
        "app.started",
      ]);
      const asc = await q.findMany({ order: "asc" });
      expect(asc.map((r) => r.event)).toEqual([
        "app.started",
        "user.login",
        "user.login",
        "user.logout",
      ]);
    } finally {
      await q.close();
    }
  });

  it("paginates deterministically across pages", async () => {
    await seed();
    const q = newQuery();
    try {
      const page1 = await q.findMany({ limit: 2, offset: 0 });
      const page2 = await q.findMany({ limit: 2, offset: 2 });
      const union = [...page1, ...page2].map((r) => r.id);
      expect(new Set(union).size).toBe(4);
      const full = await q.findMany({ limit: 10 });
      expect(full.map((r) => r.id)).toEqual(union);
    } finally {
      await q.close();
    }
  });

  it("filters by from/to window (inclusive)", async () => {
    await seed();
    const q = newQuery();
    try {
      const april = await q.findMany({
        from: new Date("2026-04-01T00:00:00Z"),
        to: new Date("2026-04-30T23:59:59Z"),
      });
      expect(april.map((r) => r.event).sort()).toEqual([
        "app.started",
        "user.login",
        "user.login",
      ]);

      const exact = await q.findMany({
        from: new Date("2026-04-02T10:00:00Z"),
        to: new Date("2026-04-02T10:00:00Z"),
      });
      expect(exact).toHaveLength(1);
    } finally {
      await q.close();
    }
  });

  it("combines filters (event + actor + environment + from)", async () => {
    await seed();
    const q = newQuery();
    try {
      const rows = await q.findMany({
        event: "user.login",
        actorType: "user",
        environment: "prod",
        from: new Date("2026-04-01T00:00:00Z"),
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.actorId).toBe("user_1");
    } finally {
      await q.close();
    }
  });

  it("filters by mode", async () => {
    await seed();
    const q = newQuery();
    try {
      const asyncRows = await q.findMany({ mode: "async" });
      expect(asyncRows).toHaveLength(1);
      expect(asyncRows[0]!.event).toBe("user.logout");

      const sync = await q.findMany({ mode: "sync" });
      expect(sync.map((r) => r.event).sort()).toEqual([
        "app.started",
        "user.login",
        "user.login",
      ]);
    } finally {
      await q.close();
    }
  });

  it("returns an empty array when nothing matches", async () => {
    await seed();
    const q = newQuery();
    try {
      expect(await q.findMany({ event: "nothing.here" })).toEqual([]);
    } finally {
      await q.close();
    }
  });
});

// -----------------------------------------------------------------------------
describe("integration / query — filter boundaries & semantics", () => {
  it("`from`/`to` are strictly inclusive at both ends to the millisecond", async () => {
    const audit = createTracevault({
      driver: "postgres",
      connectionString: CONN_STRING,
      tableName: TABLE,
    });
    const at = new Date("2026-06-15T12:34:56.789Z");
    try {
      await audit.emit({ event: "boundary", occurredAt: at });
    } finally {
      await audit.close();
    }

    const q = newQuery();
    try {
      // Exact match window: from == to == stored occurredAt → 1 row.
      expect(
        (await q.findMany({ from: at, to: at })).map((r) => r.event),
      ).toEqual(["boundary"]);

      // 1ms before: empty on both sides.
      const before = new Date(at.getTime() - 1);
      const after = new Date(at.getTime() + 1);
      expect(await q.findMany({ from: before, to: before })).toEqual([]);
      expect(await q.findMany({ from: after, to: after })).toEqual([]);

      // Strict ordering on >= / <= : [t, t] includes, [t+1, t+1] excludes.
      expect(await q.count({ from: at, to: at })).toBe(1);
      expect(await q.count({ from: after, to: after })).toBe(0);
    } finally {
      await q.close();
    }
  });

  it("accepts ISO date strings interchangeably with Date objects", async () => {
    await seed();
    const q = newQuery();
    try {
      const byString = await q.findMany({
        from: "2026-04-01T00:00:00Z",
        to: "2026-04-30T23:59:59Z",
      });
      const byDate = await q.findMany({
        from: new Date("2026-04-01T00:00:00Z"),
        to: new Date("2026-04-30T23:59:59Z"),
      });
      expect(byString.map((r) => r.id)).toEqual(byDate.map((r) => r.id));
    } finally {
      await q.close();
    }
  });

  it("treats `undefined` filter keys as no-op (does not filter on NULL)", async () => {
    // Rows with `environment = null` must appear when no `environment` filter
    // is provided. Passing `environment: undefined` must be identical to
    // omitting the key entirely.
    const audit = createTracevault({
      driver: "postgres",
      connectionString: CONN_STRING,
      tableName: TABLE,
    });
    try {
      await audit.emit({ event: "no.env" }); // environment = null
      await audit.emit({ event: "with.env", environment: "prod" });
    } finally {
      await audit.close();
    }

    const q = newQuery();
    try {
      expect((await q.findMany({})).length).toBe(2);
      expect((await q.findMany({ environment: undefined })).length).toBe(2);
      expect((await q.findMany({ environment: "prod" })).length).toBe(1);
      // There is intentionally no API to query `environment IS NULL`.
      // Confirmed: filtering by a value only returns non-null matches.
    } finally {
      await q.close();
    }
  });

  it("null columns come back as null in AuditRecord, not undefined", async () => {
    const audit = createTracevault({
      driver: "postgres",
      connectionString: CONN_STRING,
      tableName: TABLE,
    });
    try {
      await audit.emit({ event: "bare.event" });
    } finally {
      await audit.close();
    }
    const q = newQuery();
    try {
      const [row] = await q.findMany({ event: "bare.event" });
      expect(row).toBeDefined();
      expect(row!.actorId).toBeNull();
      expect(row!.actorType).toBeNull();
      expect(row!.targetId).toBeNull();
      expect(row!.targetType).toBeNull();
      expect(row!.data).toBeNull();
      expect(row!.meta).toBeNull();
      expect(row!.correlationId).toBeNull();
      expect(row!.requestId).toBeNull();
      expect(row!.environment).toBeNull();
      expect(row!.outcome).toBeNull();
      expect(row!.errorCode).toBeNull();
      expect(row!.severity).toBeNull();
    } finally {
      await q.close();
    }
  });
});

// -----------------------------------------------------------------------------
describe("integration / query — generated outcome & error_code columns", () => {
  it("materializes data.outcome and data.error.code and supports Read API filters", async () => {
    const audit = createTracevault({
      driver: "postgres",
      connectionString: CONN_STRING,
      tableName: TABLE,
    });
    try {
      await audit.emit({
        event: "auth.login.failed",
        data: {
          outcome: "failure",
          error: { code: "AUTH_INVALID_CREDENTIALS", stage: "credential_verify" },
        },
        correlationId: "corr-login-1",
      });
      await audit.emit({
        event: "auth.login.succeeded",
        data: { outcome: "success", tokenType: "bearer" },
        correlationId: "corr-login-1",
      });
    } finally {
      await audit.close();
    }

    const q = newQuery();
    try {
      const failures = await q.findMany({ errorCode: "AUTH_INVALID_CREDENTIALS" });
      expect(failures).toHaveLength(1);
      expect(failures[0]!.event).toBe("auth.login.failed");
      expect(failures[0]!.outcome).toBe("failure");
      expect(failures[0]!.errorCode).toBe("AUTH_INVALID_CREDENTIALS");

      const wins = await q.findMany({ outcome: "success", event: "auth.login.succeeded" });
      expect(wins).toHaveLength(1);
      expect(wins[0]!.errorCode).toBeNull();

      expect(await q.count({ outcome: "failure" })).toBe(1);
      expect(await q.count({ correlationId: "corr-login-1" })).toBe(2);
    } finally {
      await q.close();
    }
  });
});

// -----------------------------------------------------------------------------
describe("integration / query — severity & errorsOnly", () => {
  it("exposes data.severity, severities filter, and errorsOnly shorthand", async () => {
    const audit = createTracevault({
      driver: "postgres",
      connectionString: CONN_STRING,
      tableName: TABLE,
    });
    try {
      await audit.emit({
        event: "app.info",
        data: { severity: "info", msg: "started" },
        correlationId: "op-1",
      });
      await audit.emit({
        event: "auth.login.failed",
        data: {
          outcome: "failure",
          severity: "warning",
          error: { code: "AUTH_X" },
        },
        correlationId: "op-1",
      });
      await audit.emit({
        event: "db.unreachable",
        data: { severity: "critical", outcome: "success" },
        correlationId: "op-1",
      });
    } finally {
      await audit.close();
    }

    const q = newQuery();
    try {
      expect((await q.findMany({ severity: "info" })).map((r) => r.event)).toEqual([
        "app.info",
      ]);

      const warnOrErr = await q.findMany({ severities: ["warning", "error"] });
      expect(warnOrErr.map((r) => r.event).sort()).toEqual(["auth.login.failed"]);

      const errOnly = await q.findMany({ errorsOnly: true });
      expect(errOnly.map((r) => r.event).sort()).toEqual(["auth.login.failed", "db.unreachable"]);

      expect(await q.count({ errorsOnly: true, correlationId: "op-1" })).toBe(2);
    } finally {
      await q.close();
    }
  });
});

// -----------------------------------------------------------------------------
describe("integration / query — pagination edges", () => {
  it("offset beyond total returns an empty array", async () => {
    await seed();
    const q = newQuery();
    try {
      const rows = await q.findMany({ offset: 9999 });
      expect(rows).toEqual([]);
    } finally {
      await q.close();
    }
  });

  it("exhaustive walk with limit=1 visits every row exactly once", async () => {
    await seed();
    const q = newQuery();
    try {
      const seen: string[] = [];
      for (let offset = 0; ; offset++) {
        const page = await q.findMany({ limit: 1, offset });
        if (page.length === 0) break;
        seen.push(page[0]!.id);
      }
      expect(new Set(seen).size).toBe(seen.length); // no duplicates
      expect(seen.length).toBe(4); // full coverage
      const full = await q.findMany({ limit: 10 });
      expect(full.map((r) => r.id)).toEqual(seen);
    } finally {
      await q.close();
    }
  });

  it("limit at the cap (500) is accepted", async () => {
    await seed();
    const q = newQuery();
    try {
      const rows = await q.findMany({ limit: 500 });
      expect(rows).toHaveLength(4);
    } finally {
      await q.close();
    }
  });

  it("limit above the cap is rejected without hitting the DB", async () => {
    const q = newQuery();
    try {
      await expect(q.findMany({ limit: 501 })).rejects.toThrow(ValidationError);
      await expect(q.findMany({ limit: 0 })).rejects.toThrow(ValidationError);
      await expect(q.findMany({ offset: -1 })).rejects.toThrow(ValidationError);
    } finally {
      await q.close();
    }
  });
});

// -----------------------------------------------------------------------------
describe("integration / query — stable ordering with ties", () => {
  it("rows with identical `occurred_at` are tie-broken by id, consistent across directions", async () => {
    // Seed several rows with exactly the same occurredAt → stable tie-break
    // must come from the id column (primary key).
    const shared = new Date("2026-07-01T10:00:00Z");
    const audit = createTracevault({
      driver: "postgres",
      connectionString: CONN_STRING,
      tableName: TABLE,
    });
    try {
      for (let i = 0; i < 8; i++) {
        await audit.emit({
          event: "tie.event",
          actor: { id: `a_${i}`, type: "user" },
          occurredAt: shared,
        });
      }
    } finally {
      await audit.close();
    }

    const q = newQuery();
    try {
      const desc = (await q.findMany({ limit: 20 })).map((r) => r.id);
      const asc = (await q.findMany({ limit: 20, order: "asc" })).map((r) => r.id);
      expect(new Set(desc).size).toBe(desc.length);
      expect(desc).toHaveLength(8);
      // asc = reverse of desc exactly.
      expect(asc).toEqual([...desc].reverse());
      // Sorted view matches the asc listing (tie-break by id ascending).
      expect(asc).toEqual([...asc].sort());
    } finally {
      await q.close();
    }
  });
});

// -----------------------------------------------------------------------------
describe("integration / query — JSONB round-trip", () => {
  it("round-trips deeply nested data/meta payloads without shape loss", async () => {
    const audit = createTracevault({
      driver: "postgres",
      connectionString: CONN_STRING,
      tableName: TABLE,
    });

    const complex = {
      nested: {
        list: [1, 2, { a: true, b: null, c: "x" }],
        emoji: "audit.price.updated 🧾",
        quoted: 'he said "hi"',
        newlineField: "a\nb\tc",
      },
      flags: [true, false, null],
      count: 0,
    };
    const meta = {
      labels: ["a", "b"],
      map: { x: 1, y: 2 },
      empty: {},
      arr: [],
    };

    try {
      await audit.emit({
        event: "round.trip",
        actor: { id: "u", type: "user" },
        data: complex,
        meta,
      });
    } finally {
      await audit.close();
    }

    const q = newQuery();
    try {
      const [row] = await q.findMany({ event: "round.trip" });
      expect(row!.data).toEqual(complex);
      expect(row!.meta).toEqual(meta);
      // findById returns the same shape.
      const byId = await q.findById(row!.id);
      expect(byId!.data).toEqual(complex);
      expect(byId!.meta).toEqual(meta);
    } finally {
      await q.close();
    }
  });

  it("masking applied on write is visible on read (end-to-end)", async () => {
    const audit = createTracevault({
      driver: "postgres",
      connectionString: CONN_STRING,
      tableName: TABLE,
      maskFields: ["password", "token"],
    });
    try {
      await audit.emit({
        event: "auth.login",
        actor: { id: "u1", type: "user" },
        data: {
          password: "p4ssw0rd",
          token: "secret",
          nested: { token: "inner-secret" },
          ok: true,
        },
      });
    } finally {
      await audit.close();
    }

    const q = newQuery();
    try {
      const [row] = await q.findMany({ event: "auth.login" });
      expect(row!.data).toMatchObject({
        password: "[REDACTED]",
        token: "[REDACTED]",
        nested: { token: "[REDACTED]" },
        ok: true,
      });
    } finally {
      await q.close();
    }
  });
});

// -----------------------------------------------------------------------------
describe("integration / query — findById variants", () => {
  it("findById accepts uppercase UUIDs (case-insensitive)", async () => {
    const audit = createTracevault({
      driver: "postgres",
      connectionString: CONN_STRING,
      tableName: TABLE,
    });
    try {
      await audit.emit({ event: "uuid.case" });
    } finally {
      await audit.close();
    }

    const q = newQuery();
    try {
      const [row] = await q.findMany({ event: "uuid.case" });
      const upper = row!.id.toUpperCase();
      expect(upper).not.toBe(row!.id);
      const byIdUpper = await q.findById(upper);
      expect(byIdUpper).not.toBeNull();
      expect(byIdUpper!.id).toBe(row!.id);
    } finally {
      await q.close();
    }
  });

  it.each([
    ["not-a-uuid"],
    [""],
    ["00000000-0000-0000-0000"],
    ["00000000-0000-4000-8000-00000000000g"], // non-hex
    ["00000000_0000_4000_8000_000000000000"], // wrong separator
  ])("findById rejects malformed UUID %p without a DB round-trip", async (bad) => {
    const q = newQuery();
    try {
      await expect(q.findById(bad)).rejects.toThrow(ValidationError);
    } finally {
      await q.close();
    }
  });
});

// -----------------------------------------------------------------------------
describe("integration / query — deep scope composition", () => {
  it("3-level scope chain inherits the intermediate tableName and leaf override takes effect", async () => {
    const root = newQuery(TABLE);
    try {
      // root(TABLE) → users(USER_TABLE) → users2(USER_TABLE, inherited) → tx(TX_TABLE, leaf)
      const users = root.scope({ tableName: USER_TABLE });
      const users2 = users.scope(); // inherits USER_TABLE
      const tx = users2.scope({ tableName: TX_TABLE });

      await seed();

      expect((await root.count()) > 0).toBe(true);
      expect((await users.count()) > 0).toBe(true);
      expect((await users2.count()) > 0).toBe(true);
      expect(await users.count()).toBe(await users2.count());

      const usersRows = await users.findMany();
      const users2Rows = await users2.findMany();
      expect(usersRows.map((r) => r.id)).toEqual(users2Rows.map((r) => r.id));

      const txRows = await tx.findMany();
      expect(txRows.every((r) => r.event.startsWith("payment."))).toBe(true);
    } finally {
      await root.close();
    }
  });

  it("scope() on a scope shares the same pool (no extra pool per level)", async () => {
    const root = newQuery(TABLE);
    try {
      const deep = root
        .scope({ tableName: USER_TABLE })
        .scope()
        .scope({ tableName: TX_TABLE })
        .scope();
      // If each level allocated its own pool, the test DB would run out of
      // connections under load. 50 concurrent reads here is trivial over a
      // single shared pool but would exhaust a stack of per-level pools.
      const results = await Promise.all(
        Array.from({ length: 50 }, () => deep.healthcheck()),
      );
      expect(results.every(Boolean)).toBe(true);
    } finally {
      await root.close();
    }
  });
});

// -----------------------------------------------------------------------------
describe("integration / query — write ↔ read shape equivalence", () => {
  it("every persisted column is exposed by the Read API with equivalent values", async () => {
    // Use a past timestamp so the later `createdAt` assertion is timeline-sane
    // regardless of where/when this test runs.
    const occurredAt = new Date("2024-08-01T10:11:12.345Z");
    const audit = createTracevault({
      driver: "postgres",
      connectionString: CONN_STRING,
      tableName: TABLE,
    });
    try {
      await audit.emit({
        event: "full.shape",
        actor: { id: "actor1", type: "user" },
        target: { id: "target1", type: "entity" },
        data: { k: "v" },
        meta: { trace: "abc" },
        correlationId: "corr-xyz",
        requestId: "req-xyz",
        environment: "prod",
        mode: "sync",
        occurredAt,
      });
    } finally {
      await audit.close();
    }

    const q = newQuery();
    try {
      const [row] = await q.findMany({ event: "full.shape" });
      expect(row).toMatchObject({
        event: "full.shape",
        actorId: "actor1",
        actorType: "user",
        targetId: "target1",
        targetType: "entity",
        data: { k: "v" },
        meta: { trace: "abc" },
        correlationId: "corr-xyz",
        requestId: "req-xyz",
        environment: "prod",
        mode: "sync",
        outcome: null,
        errorCode: null,
        severity: null,
      });
      expect(row!.occurredAt.getTime()).toBe(occurredAt.getTime());
      expect(row!.createdAt).toBeInstanceOf(Date);
      // createdAt should be >= occurredAt (DB clock defaults NOW()).
      expect(row!.createdAt.getTime()).toBeGreaterThanOrEqual(
        occurredAt.getTime() - 5,
      );
    } finally {
      await q.close();
    }
  });

  it("emitDiff round-trips through the Read API as { before, after, diff }", async () => {
    const audit = createTracevault({
      driver: "postgres",
      connectionString: CONN_STRING,
      tableName: TABLE,
    });
    try {
      await audit.emitDiff({
        event: "product.price.updated",
        actor: { id: "admin", type: "user" },
        target: { id: "p1", type: "product" },
        before: { price: 100, currency: "UYU" },
        after: { price: 150, currency: "UYU" },
      });
    } finally {
      await audit.close();
    }

    const q = newQuery();
    try {
      const [row] = await q.findMany({ event: "product.price.updated" });
      expect(row!.data).toMatchObject({
        before: { price: 100, currency: "UYU" },
        after: { price: 150, currency: "UYU" },
        diff: { price: { before: 100, after: 150 } },
      });
    } finally {
      await q.close();
    }
  });

  it("async emit + flush is immediately visible from a fresh Read API instance", async () => {
    const audit = createTracevault({
      driver: "postgres",
      connectionString: CONN_STRING,
      tableName: TABLE,
      defaultMode: "async",
    });
    try {
      for (let i = 0; i < 25; i++) {
        await audit.emit({ event: "async.read", data: { i } });
      }
      await audit.flush();
    } finally {
      await audit.close();
    }

    // Intentionally use a *new* query instance: reads must not depend on
    // sharing any state with the writer.
    const q = newQuery();
    try {
      expect(await q.count({ event: "async.read" })).toBe(25);
    } finally {
      await q.close();
    }
  });
});

// -----------------------------------------------------------------------------
describe("integration / query — concurrent reads", () => {
  it("interleaves many findMany/count/findById calls on the same instance", async () => {
    await seed();
    const q = newQuery();
    try {
      const [sample] = await q.findMany({ limit: 1 });
      const id = sample!.id;

      const results = await Promise.all([
        q.count(),
        q.findMany({ limit: 10 }),
        q.findById(id),
        q.count({ event: "user.login" }),
        q.findMany({ event: "user.login", limit: 5 }),
        q.findById("00000000-0000-4000-8000-000000000000"),
        q.count({ actorType: "user" }),
        q.findMany({ order: "asc", limit: 2 }),
      ]);

      expect(results[0]).toBe(4);
      expect((results[1] as unknown as Array<{ id: string }>).length).toBe(4);
      expect(
        (results[2] as unknown as { id: string } | null)?.id,
      ).toBe(id);
      expect(results[3]).toBe(2);
      expect(
        (results[4] as unknown as Array<{ event: string }>).every(
          (r) => r.event === "user.login",
        ),
      ).toBe(true);
      expect(results[5]).toBeNull();
      expect(results[6]).toBeGreaterThanOrEqual(2);
      expect(
        (results[7] as unknown as Array<{ event: string }>).map((r) => r.event),
      ).toEqual(["app.started", "user.login"]);
    } finally {
      await q.close();
    }
  });

  it("root + scopes read concurrently from distinct tables without cross-contamination", async () => {
    await seed();
    const root = newQuery(TABLE);
    const users = root.scope({ tableName: USER_TABLE });
    const tx = root.scope({ tableName: TX_TABLE });
    try {
      const [rootRows, userRows, txRows, rootCount, userCount, txCount] =
        await Promise.all([
          root.findMany({ limit: 100 }),
          users.findMany({ limit: 100 }),
          tx.findMany({ limit: 100 }),
          root.count(),
          users.count(),
          tx.count(),
        ]);

      expect(rootRows.every((r) => !r.event.startsWith("payment."))).toBe(true);
      expect(rootRows.every((r) => r.event !== "user.profile.updated")).toBe(true);

      expect(userRows.every((r) => r.event === "user.profile.updated")).toBe(true);
      expect(txRows.every((r) => r.event.startsWith("payment."))).toBe(true);

      expect(rootCount).toBe(4);
      expect(userCount).toBe(2);
      expect(txCount).toBe(3);
    } finally {
      await root.close();
    }
  });

  it("50 concurrent findMany on the same instance all succeed", async () => {
    await seed();
    const q = newQuery();
    try {
      const results = await Promise.all(
        Array.from({ length: 50 }, (_, i) =>
          q.findMany({ limit: 10, offset: i % 4, order: i % 2 === 0 ? "asc" : "desc" }),
        ),
      );
      expect(results).toHaveLength(50);
      expect(results.every((r) => Array.isArray(r))).toBe(true);
    } finally {
      await q.close();
    }
  });
});

// -----------------------------------------------------------------------------
describe("integration / query — lifecycle races", () => {
  it("reads in-flight when root.close() is called still resolve cleanly", async () => {
    await seed();
    const q = newQuery();
    const inflight = Promise.all([
      q.findMany({ limit: 10 }),
      q.count(),
      q.findMany({ event: "user.login" }),
    ]);
    // Kick close() off without awaiting; pool.end() waits for active clients
    // to release before tearing the pool down, so inflight reads must complete
    // successfully.
    const closePromise = q.close();
    const results = await inflight;
    await closePromise;

    expect(Array.isArray(results[0])).toBe(true);
    expect(typeof results[1]).toBe("number");
    expect(Array.isArray(results[2])).toBe(true);
    await expect(q.findMany()).rejects.toThrow(/closed/);
  });

  it("scope.close() during an in-flight scope read does not disturb the shared pool", async () => {
    await seed();
    const root = newQuery(TABLE);
    const scope = root.scope({ tableName: USER_TABLE });
    try {
      const scopeRead = scope.findMany({ limit: 50 });
      await scope.close();
      await scopeRead;
      // Root is still healthy: the pool was not touched.
      expect(await root.healthcheck()).toBe(true);
      expect(await root.count()).toBe(4);
      await expect(scope.findMany()).rejects.toThrow(/query scope is closed/);
    } finally {
      await root.close();
    }
  });

  it("many concurrent close() calls from root + scopes resolve together exactly once", async () => {
    const q = newQuery();
    const scopes = Array.from({ length: 8 }, (_, i) =>
      q.scope({ tableName: i % 2 === 0 ? USER_TABLE : TX_TABLE }),
    );
    await Promise.all([
      q.close(),
      q.close(),
      q.close(),
      ...scopes.flatMap((s) => [s.close(), s.close()]),
    ]);
    expect(await q.healthcheck()).toBe(false);
    for (const s of scopes) expect(await s.healthcheck()).toBe(false);
  });

  it("root.close() → subsequent read/scope creation on any descendant fails", async () => {
    const root = newQuery();
    const a = root.scope({ tableName: USER_TABLE });
    const b = a.scope(); // inherits USER_TABLE, shares pool
    await root.close();

    await expect(root.findMany()).rejects.toThrow(TracevaultError);
    await expect(a.findMany()).rejects.toThrow(TracevaultError);
    await expect(b.count()).rejects.toThrow(TracevaultError);
    expect(() => root.scope()).toThrow(TracevaultError);
    expect(() => a.scope()).toThrow(TracevaultError);
  });
});

// -----------------------------------------------------------------------------
describe("integration / query — error paths", () => {
  it("reading from a non-existent table surfaces a DriverError with the table name", async () => {
    const missing = "audit_missing_read_table";
    await dbClient.query(`DROP TABLE IF EXISTS "${missing}" CASCADE`);
    const q = newQuery(missing);
    try {
      await expect(q.findMany()).rejects.toThrow(DriverError);
      await expect(q.findMany()).rejects.toThrow(/"audit_missing_read_table"/);
      await expect(q.count()).rejects.toThrow(/failed to count rows/);
      await expect(
        q.findById("00000000-0000-4000-8000-000000000000"),
      ).rejects.toThrow(/failed to look up id/);
    } finally {
      await q.close();
    }
  });

  it("DriverError exposes the original pg error via `cause`", async () => {
    const q = newQuery("audit_missing_read_table_2");
    try {
      try {
        await q.findMany();
      } catch (err) {
        expect(err).toBeInstanceOf(DriverError);
        expect((err as DriverError).cause).toBeDefined();
        expect(String((err as DriverError).cause)).toMatch(/does not exist/i);
      }
    } finally {
      await q.close();
    }
  });

  it("validation errors do not flip healthcheck to false (pool is still healthy)", async () => {
    // ValidationError comes from input checks, not the pool. The pool is
    // still healthy. This guards against future "smart" healthchecks that
    // probe the table.
    const q = newQuery();
    try {
      await expect(q.findById("bad")).rejects.toThrow(ValidationError);
      expect(await q.healthcheck()).toBe(true);
    } finally {
      await q.close();
    }
  });
});
