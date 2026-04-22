import { beforeEach, describe, expect, it, vi } from "vitest";

import { createTracevault } from "../src/index.js";
import { ConfigError, TracevaultError } from "../src/core/errors.js";

type QueryCall = { sql: string; params: unknown[] };

const queryCalls: QueryCall[] = [];
const queryImpl = vi.fn(async (sql: string, params?: unknown[]) => {
  queryCalls.push({ sql, params: params ?? [] });
  if (sql.includes("SELECT 1")) {
    return { rows: [{ ok: 1 }], rowCount: 1 };
  }
  return { rows: [], rowCount: 1 };
});
const endImpl = vi.fn(async () => {});

// One Pool *constructor* call per `createTracevault`. Scopes share the pool
// so they MUST NOT instantiate new Pools.
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
    if (sql.includes("SELECT 1")) {
      return { rows: [{ ok: 1 }], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  });
  endImpl.mockClear();
  endImpl.mockImplementation(async () => {});
  poolCtor.mockClear();
});

describe("tracevault scope() — configuration", () => {
  it("inherits every setting from the root", async () => {
    const root = createTracevault({
      driver: "postgres",
      connectionString: "postgres://localhost/x",
      tableName: "audit_logs",
      maskFields: ["password"],
      defaultMode: "sync",
      environment: "prod",
    });
    const child = root.scope();

    await child.emit({
      event: "x",
      data: { password: "secret", keep: "me" },
    });
    await root.close();

    expect(queryCalls[0]!.sql).toContain('INSERT INTO "audit_logs"');
    const data = JSON.parse(queryCalls[0]!.params[6] as string);
    expect(data).toEqual({ password: "[REDACTED]", keep: "me" });
    expect(queryCalls[0]!.params[8]).toBe("sync");
    expect(queryCalls[0]!.params[12]).toBe("prod");
  });

  it("overrides tableName for scope emits without touching the root", async () => {
    const root = createTracevault({
      driver: "postgres",
      connectionString: "postgres://localhost/x",
      tableName: "audit_logs",
    });
    const users = root.scope({ tableName: "audit_user_events" });

    await root.emit({ event: "root.one" });
    await users.emit({ event: "user.one" });
    await root.close();

    expect(queryCalls).toHaveLength(2);
    const rootCall = queryCalls.find((c) => c.params[1] === "root.one")!;
    const userCall = queryCalls.find((c) => c.params[1] === "user.one")!;
    expect(rootCall.sql).toContain('INSERT INTO "audit_logs"');
    expect(userCall.sql).toContain('INSERT INTO "audit_user_events"');
  });

  it("overrides defaultMode, environment, maskFields and maskValue on a scope", async () => {
    const root = createTracevault({
      driver: "postgres",
      connectionString: "postgres://localhost/x",
      defaultMode: "sync",
      environment: "prod",
      maskFields: ["password"],
    });
    const scoped = root.scope({
      defaultMode: "async",
      environment: "staging",
      maskFields: ["token"],
      maskValue: "***",
    });

    await scoped.emit({
      event: "scoped.evt",
      data: { password: "keep-me", token: "zap" },
    });
    await scoped.flush();
    await root.close();

    expect(queryCalls).toHaveLength(1);
    const params = queryCalls[0]!.params;
    expect(params[8]).toBe("async");
    expect(params[12]).toBe("staging");
    const data = JSON.parse(params[6] as string);
    expect(data).toEqual({ password: "keep-me", token: "***" });
  });

  it("forwards scope-level onError when async insert fails", async () => {
    const root = createTracevault({
      driver: "postgres",
      connectionString: "postgres://localhost/x",
      onError: () => {
        throw new Error("should not reach root onError");
      },
    });
    const errors: Error[] = [];
    const child = root.scope({
      defaultMode: "async",
      onError: (err) => errors.push(err),
    });

    queryImpl.mockImplementationOnce(async () => {
      throw new Error("pg boom");
    });

    await child.emit({ event: "scope.fails" });
    await child.flush();
    await root.close();

    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toMatch(/scope\.fails/);
  });

  it("sub-scopes inherit from the parent scope, not straight from the root", async () => {
    const root = createTracevault({
      driver: "postgres",
      connectionString: "postgres://localhost/x",
      tableName: "root_t",
      environment: "root-env",
    });
    const mid = root.scope({ tableName: "mid_t", environment: "mid-env" });
    const leaf = mid.scope({ tableName: "leaf_t" });

    await leaf.emit({ event: "deep" });
    await root.close();

    const call = queryCalls[0]!;
    expect(call.sql).toContain('INSERT INTO "leaf_t"');
    expect(call.params[12]).toBe("mid-env");
  });
});

describe("tracevault scope() — validation", () => {
  it("rejects overriding `driver`", () => {
    const root = createTracevault({
      driver: "postgres",
      connectionString: "postgres://localhost/x",
    });
    expect(() =>
      root.scope({ driver: "mysql" } as unknown as Parameters<typeof root.scope>[0]),
    ).toThrow(ConfigError);
    expect(() =>
      root.scope({ driver: "mysql" } as unknown as Parameters<typeof root.scope>[0]),
    ).toThrow(/cannot be overridden/);
  });

  it("rejects overriding `connectionString`", () => {
    const root = createTracevault({
      driver: "postgres",
      connectionString: "postgres://localhost/x",
    });
    expect(() =>
      root.scope({
        connectionString: "postgres://elsewhere/y",
      } as unknown as Parameters<typeof root.scope>[0]),
    ).toThrow(ConfigError);
  });

  it("rejects unknown override keys", () => {
    const root = createTracevault({
      driver: "postgres",
      connectionString: "postgres://localhost/x",
    });
    expect(() =>
      root.scope({ frobnicate: true } as unknown as Parameters<typeof root.scope>[0]),
    ).toThrow(/unknown override/);
  });

  it("rejects invalid tableName", () => {
    const root = createTracevault({
      driver: "postgres",
      connectionString: "postgres://localhost/x",
    });
    expect(() => root.scope({ tableName: "bad-name;DROP" })).toThrow(ConfigError);
    expect(() => root.scope({ tableName: "" })).toThrow(ConfigError);
    expect(() => root.scope({ tableName: "1leading_digit" })).toThrow(ConfigError);
  });

  it("rejects invalid defaultMode", () => {
    const root = createTracevault({
      driver: "postgres",
      connectionString: "postgres://localhost/x",
    });
    expect(() =>
      root.scope({
        defaultMode: "fire-and-forget" as unknown as "sync",
      }),
    ).toThrow(ConfigError);
  });

  it("rejects non-array maskFields and non-function onError", () => {
    const root = createTracevault({
      driver: "postgres",
      connectionString: "postgres://localhost/x",
    });
    expect(() =>
      root.scope({
        maskFields: "password" as unknown as string[],
      }),
    ).toThrow(ConfigError);
    expect(() =>
      root.scope({
        onError: "nope" as unknown as Parameters<typeof root.scope>[0] extends
          | infer T
          | undefined
          ? T extends { onError?: infer F }
            ? F
            : never
          : never,
      }),
    ).toThrow(ConfigError);
  });

  it("accepts the empty overrides object", () => {
    const root = createTracevault({
      driver: "postgres",
      connectionString: "postgres://localhost/x",
    });
    expect(() => root.scope({})).not.toThrow();
    expect(() => root.scope()).not.toThrow();
  });
});

describe("tracevault scope() — lifecycle", () => {
  it("shares the pg.Pool across scopes (no new pool per scope)", () => {
    const root = createTracevault({
      driver: "postgres",
      connectionString: "postgres://localhost/x",
    });
    root.scope({ tableName: "a" });
    root.scope({ tableName: "b" });
    root.scope({ tableName: "c" });
    expect(poolCtor).toHaveBeenCalledTimes(1);
  });

  it("scope.close() does NOT close the root's pool", async () => {
    const root = createTracevault({
      driver: "postgres",
      connectionString: "postgres://localhost/x",
    });
    const scope = root.scope({ tableName: "scoped" });
    await scope.emit({ event: "x" });
    await scope.close();

    expect(endImpl).not.toHaveBeenCalled();

    // Root can still accept events after a scope closes.
    await root.emit({ event: "still.works" });
    await root.close();
    expect(endImpl).toHaveBeenCalledTimes(1);
  });

  it("scope.emit() after scope.close() rejects with a clear error", async () => {
    const root = createTracevault({
      driver: "postgres",
      connectionString: "postgres://localhost/x",
    });
    const scope = root.scope({ tableName: "scoped" });
    await scope.close();

    await expect(scope.emit({ event: "x" })).rejects.toThrow(TracevaultError);
    await expect(scope.emit({ event: "x" })).rejects.toThrow(/scope is closed/);
    await expect(scope.emitDiff({ event: "x" })).rejects.toThrow(TracevaultError);

    await root.close();
  });

  it("root.close() invalidates every scope (emit throws, healthcheck false)", async () => {
    const root = createTracevault({
      driver: "postgres",
      connectionString: "postgres://localhost/x",
    });
    const a = root.scope({ tableName: "a" });
    const b = root.scope({ tableName: "b" });

    await root.close();

    await expect(a.emit({ event: "x" })).rejects.toThrow(/root instance is closed/);
    await expect(b.emitDiff({ event: "y" })).rejects.toThrow(/root instance is closed/);
    expect(await a.healthcheck()).toBe(false);
    expect(await b.healthcheck()).toBe(false);
  });

  it("scope() on a closed root throws TracevaultError", async () => {
    const root = createTracevault({
      driver: "postgres",
      connectionString: "postgres://localhost/x",
    });
    await root.close();
    expect(() => root.scope({ tableName: "late" })).toThrow(TracevaultError);
    expect(() => root.scope({ tableName: "late" })).toThrow(/root instance is closed/);
  });

  it("scope() on a closed scope throws TracevaultError", async () => {
    const root = createTracevault({
      driver: "postgres",
      connectionString: "postgres://localhost/x",
    });
    const parent = root.scope({ tableName: "a" });
    await parent.close();
    expect(() => parent.scope({ tableName: "b" })).toThrow(TracevaultError);
    await root.close();
  });

  it("root.close() drains pending async inserts from every scope", async () => {
    const root = createTracevault({
      driver: "postgres",
      connectionString: "postgres://localhost/x",
      defaultMode: "async",
    });
    const a = root.scope({ tableName: "a", defaultMode: "async" });
    const b = root.scope({ tableName: "b", defaultMode: "async" });

    await a.emit({ event: "scoped.a.1" });
    await a.emit({ event: "scoped.a.2" });
    await b.emit({ event: "scoped.b.1" });
    await root.emit({ event: "root.1" });

    expect(queryImpl).not.toHaveBeenCalled();

    await root.close();

    const inserts = queryCalls.filter((c) => c.sql.includes("INSERT INTO"));
    expect(inserts).toHaveLength(4);
    const byTable = (t: string) =>
      inserts.filter((c) => c.sql.includes(`INSERT INTO "${t}"`)).length;
    expect(byTable("a")).toBe(2);
    expect(byTable("b")).toBe(1);
    expect(byTable("audit_logs")).toBe(1);
  });

  it("scope.flush() only drains its own queue", async () => {
    // We schedule the root's async tick far enough in the future that it
    // cannot fire during scope.flush()'s awaited microtasks — that's what
    // proves scope.flush() does NOT reach into the root queue. 50 ms is
    // plenty compared to the handful of microtasks scope.flush() needs.
    const root = createTracevault({
      driver: "postgres",
      connectionString: "postgres://localhost/x",
      defaultMode: "async",
      asyncFlushIntervalMs: 50,
    });
    // Explicitly drain-immediately on the scope (overriding the inherited 50ms)
    // so scope.flush() resolves before the root's 50ms timer can fire.
    const scope = root.scope({
      tableName: "scoped",
      defaultMode: "async",
      asyncFlushIntervalMs: 0,
    });

    await root.emit({ event: "root.evt" });
    await scope.emit({ event: "scope.evt" });

    await scope.flush();

    const inserts = queryCalls.filter((c) => c.sql.includes("INSERT INTO"));
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.sql).toContain('INSERT INTO "scoped"');

    await root.close();
    const allInserts = queryCalls.filter((c) => c.sql.includes("INSERT INTO"));
    expect(allInserts).toHaveLength(2);
  });

  it("healthcheck on a scope uses the shared pool and returns true when open", async () => {
    const root = createTracevault({
      driver: "postgres",
      connectionString: "postgres://localhost/x",
    });
    const scope = root.scope({ tableName: "scoped" });
    expect(await scope.healthcheck()).toBe(true);
    await scope.close();
    expect(await scope.healthcheck()).toBe(false);
    await root.close();
  });
});
