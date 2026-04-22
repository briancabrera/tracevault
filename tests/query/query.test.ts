import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ConfigError,
  TracevaultError,
  ValidationError,
} from "../../src/core/errors.js";
import { createTracevaultQuery } from "../../src/query/index.js";

type QueryCall = { sql: string; params: unknown[] };

const queryCalls: QueryCall[] = [];
const queryImpl = vi.fn(async (sql: string, params?: unknown[]) => {
  queryCalls.push({ sql, params: params ?? [] });
  if (sql.includes("SELECT 1 AS ok")) {
    return { rows: [{ ok: 1 }], rowCount: 1 };
  }
  if (sql.includes("COUNT(*)")) {
    return { rows: [{ c: "42" }], rowCount: 1 };
  }
  return { rows: [], rowCount: 0 };
});
const endImpl = vi.fn(async () => {});

const poolCtor = vi.fn();

vi.mock("pg", () => {
  class Pool {
    query = queryImpl;
    end = endImpl;
    on = (_event: string, _handler: (...args: unknown[]) => void) => this;
    constructor(opts: unknown) {
      poolCtor(opts);
    }
  }
  return { Pool, default: { Pool } };
});

beforeEach(() => {
  queryCalls.length = 0;
  queryImpl.mockClear();
  queryImpl.mockImplementation(async (sql: string, params?: unknown[]) => {
    queryCalls.push({ sql, params: params ?? [] });
    if (sql.includes("SELECT 1 AS ok")) return { rows: [{ ok: 1 }], rowCount: 1 };
    if (sql.includes("COUNT(*)")) return { rows: [{ c: "42" }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  endImpl.mockClear();
  endImpl.mockImplementation(async () => {});
  poolCtor.mockClear();
});

const baseConfig = {
  driver: "postgres" as const,
  connectionString: "postgres://localhost/x",
};

describe("createTracevaultQuery — configuration", () => {
  it("builds a usable instance with defaults", async () => {
    const q = createTracevaultQuery(baseConfig);
    expect(typeof q.findMany).toBe("function");
    expect(typeof q.findById).toBe("function");
    expect(typeof q.count).toBe("function");
    expect(typeof q.scope).toBe("function");
    expect(typeof q.close).toBe("function");
    expect(typeof q.healthcheck).toBe("function");
    expect(poolCtor).toHaveBeenCalledTimes(1);
    await q.close();
  });

  it.each([
    [{ driver: "mysql", connectionString: "x" }, /unsupported driver/],
    [{ driver: "postgres" }, /connectionString/],
    [{ driver: "postgres", connectionString: "" }, /connectionString/],
    [{ driver: "postgres", connectionString: "x", tableName: "1bad" }, /tableName/],
  ])("rejects invalid config %p", (cfg, msg) => {
    expect(() => createTracevaultQuery(cfg as never)).toThrow(ConfigError);
    expect(() => createTracevaultQuery(cfg as never)).toThrow(msg);
  });
});

describe("createTracevaultQuery — scopes", () => {
  it("scope() shares the same pg.Pool instance as the root", async () => {
    const root = createTracevaultQuery(baseConfig);
    try {
      const a = root.scope({ tableName: "audit_user_events" });
      const b = root.scope({ tableName: "audit_tx_events" });
      a.scope();
      b.scope();
      expect(poolCtor).toHaveBeenCalledTimes(1);
    } finally {
      await root.close();
    }
  });

  it("scope() inherits the root tableName when not overridden", async () => {
    const root = createTracevaultQuery({ ...baseConfig, tableName: "audit_logs" });
    try {
      const scoped = root.scope();
      await scoped.findMany();
      const last = queryCalls.at(-1)!;
      expect(last.sql).toContain('FROM "audit_logs"');
    } finally {
      await root.close();
    }
  });

  it("scope() uses the overridden tableName", async () => {
    const root = createTracevaultQuery(baseConfig);
    try {
      const scoped = root.scope({ tableName: "audit_user_events" });
      await scoped.findMany();
      const last = queryCalls.at(-1)!;
      expect(last.sql).toContain('FROM "audit_user_events"');
    } finally {
      await root.close();
    }
  });

  it("scope() rejects driver/connectionString overrides", () => {
    const root = createTracevaultQuery(baseConfig);
    try {
      expect(() => root.scope({ driver: "postgres" } as never)).toThrow(
        /`driver` cannot be overridden/,
      );
      expect(() => root.scope({ connectionString: "x" } as never)).toThrow(
        /`connectionString` cannot be overridden/,
      );
    } finally {
      void root.close();
    }
  });

  it("scope() rejects unknown keys", () => {
    const root = createTracevaultQuery(baseConfig);
    try {
      expect(() => root.scope({ limit: 10 } as never)).toThrow(/unknown override/);
    } finally {
      void root.close();
    }
  });
});

describe("createTracevaultQuery — lifecycle", () => {
  it("root.close() ends the pool and invalidates every scope", async () => {
    const root = createTracevaultQuery(baseConfig);
    const scoped = root.scope({ tableName: "audit_user_events" });
    await root.close();
    expect(endImpl).toHaveBeenCalledTimes(1);
    await expect(root.findMany()).rejects.toThrow(/closed/);
    await expect(scoped.findMany()).rejects.toThrow(/root query instance is closed/);
    expect(await root.healthcheck()).toBe(false);
    expect(await scoped.healthcheck()).toBe(false);
  });

  it("scope.close() does not end the shared pool", async () => {
    const root = createTracevaultQuery(baseConfig);
    const scoped = root.scope({ tableName: "audit_user_events" });
    await scoped.close();
    expect(endImpl).not.toHaveBeenCalled();
    await expect(scoped.findMany()).rejects.toThrow(/query scope is closed/);
    // Root still works.
    await root.findMany();
    expect(await root.healthcheck()).toBe(true);
    await root.close();
  });

  it("scope() on a closed root throws", async () => {
    const root = createTracevaultQuery(baseConfig);
    await root.close();
    expect(() => root.scope()).toThrow(TracevaultError);
    expect(() => root.scope()).toThrow(/root query instance is closed/);
  });

  it("scope() on a closed scope throws", async () => {
    const root = createTracevaultQuery(baseConfig);
    const scoped = root.scope({ tableName: "audit_user_events" });
    await scoped.close();
    expect(() => scoped.scope()).toThrow(/closed query scope/);
    await root.close();
  });

  it("close() is idempotent on both root and scopes", async () => {
    const root = createTracevaultQuery(baseConfig);
    const scoped = root.scope({ tableName: "audit_user_events" });
    await Promise.all([scoped.close(), scoped.close(), scoped.close()]);
    await Promise.all([root.close(), root.close()]);
    expect(endImpl).toHaveBeenCalledTimes(1);
  });

  it("healthcheck returns false after close(), true otherwise", async () => {
    const root = createTracevaultQuery(baseConfig);
    expect(await root.healthcheck()).toBe(true);
    await root.close();
    expect(await root.healthcheck()).toBe(false);
  });
});

describe("createTracevaultQuery — query dispatch (mocked pool)", () => {
  it("findMany applies defaults (limit 50, offset 0, DESC)", async () => {
    const root = createTracevaultQuery(baseConfig);
    try {
      await root.findMany();
      const call = queryCalls.at(-1)!;
      expect(call.sql).toContain("ORDER BY occurred_at DESC, id DESC");
      expect(call.params).toEqual([50, 0]);
    } finally {
      await root.close();
    }
  });

  it("findMany forwards filters and pagination", async () => {
    const root = createTracevaultQuery(baseConfig);
    try {
      await root.findMany({
        event: "user.updated",
        actorId: "u1",
        from: "2026-01-01T00:00:00Z",
        limit: 10,
        offset: 20,
        order: "asc",
      });
      const call = queryCalls.at(-1)!;
      expect(call.sql).toContain("event = $1");
      expect(call.sql).toContain("actor_id = $2");
      expect(call.sql).toContain("occurred_at >= $3");
      expect(call.sql).toContain("ORDER BY occurred_at ASC, id ASC");
      expect(call.params[0]).toBe("user.updated");
      expect(call.params[1]).toBe("u1");
      expect(call.params[2]).toBeInstanceOf(Date);
      expect(call.params.slice(-2)).toEqual([10, 20]);
    } finally {
      await root.close();
    }
  });

  it("findMany validates filters before hitting the DB", async () => {
    const root = createTracevaultQuery(baseConfig);
    try {
      await expect(root.findMany({ limit: 9999 })).rejects.toThrow(
        ValidationError,
      );
      await expect(root.findMany({ event: "" })).rejects.toThrow(ValidationError);
      await expect(root.findMany({ foo: 1 } as never)).rejects.toThrow(
        /Unknown filter/,
      );
      // None of those should have issued a DB query.
      expect(queryCalls.filter((c) => c.sql.includes("FROM"))).toHaveLength(0);
    } finally {
      await root.close();
    }
  });

  it("findById validates UUID before hitting the DB", async () => {
    const root = createTracevaultQuery(baseConfig);
    try {
      await expect(root.findById("not-a-uuid")).rejects.toThrow(ValidationError);
      expect(queryCalls.filter((c) => c.sql.includes("FROM"))).toHaveLength(0);
    } finally {
      await root.close();
    }
  });

  it("findById returns null when the row is not present", async () => {
    const root = createTracevaultQuery(baseConfig);
    try {
      const res = await root.findById("00000000-0000-4000-8000-000000000000");
      expect(res).toBeNull();
    } finally {
      await root.close();
    }
  });

  it("count parses COUNT(*)::text as a number", async () => {
    const root = createTracevaultQuery(baseConfig);
    try {
      const n = await root.count({ event: "x" });
      expect(n).toBe(42);
      const call = queryCalls.at(-1)!;
      expect(call.sql).toContain("COUNT(*)::text");
      expect(call.sql).toContain("event = $1");
      expect(call.params).toEqual(["x"]);
    } finally {
      await root.close();
    }
  });

  it("count rejects pagination/order keys", async () => {
    const root = createTracevaultQuery(baseConfig);
    try {
      await expect(root.count({ limit: 10 } as never)).rejects.toThrow(
        /for count/,
      );
    } finally {
      await root.close();
    }
  });
});
