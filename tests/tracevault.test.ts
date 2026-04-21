import { beforeEach, describe, expect, it, vi } from "vitest";

import { createTracevault } from "../src/index.js";
import { TracevaultError, ConfigError, ValidationError } from "../src/core/errors.js";

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

vi.mock("pg", () => {
  class Pool {
    query = queryImpl;
    end = endImpl;
    on = (_event: string, _handler: (...args: unknown[]) => void) => this;
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
});

describe("createTracevault", () => {
  it("rejects invalid config", () => {
    expect(() =>
      createTracevault({
        driver: "mysql" as unknown as "postgres",
        connectionString: "x",
      }),
    ).toThrow(ConfigError);
  });

  it("emit (sync) persists an event to postgres with the correct shape", async () => {
    const audit = createTracevault({
      driver: "postgres",
      connectionString: "postgres://localhost/x",
      tableName: "audit_logs",
      maskFields: ["password", "token"],
    });

    await audit.emit({
      event: "product.price.updated",
      actor: { id: "user_123", type: "user" },
      target: { id: "product_456", type: "product" },
      data: { oldPrice: 120, newPrice: 150, password: "nope" },
      meta: { source: "admin-panel", token: "abc" },
      correlationId: "corr-1",
      requestId: "req-1",
      environment: "test",
      occurredAt: "2026-02-15T10:00:00.000Z",
    });

    await audit.close();

    expect(queryImpl).toHaveBeenCalledTimes(1);
    const call = queryCalls[0]!;
    expect(call.sql).toContain('INSERT INTO "audit_logs"');
    const params = call.params;
    expect(params[1]).toBe("product.price.updated");
    expect(params[2]).toBe("user_123");
    expect(params[3]).toBe("user");
    expect(params[4]).toBe("product_456");
    expect(params[5]).toBe("product");
    const data = JSON.parse(params[6] as string);
    expect(data).toEqual({ oldPrice: 120, newPrice: 150, password: "[REDACTED]" });
    const meta = JSON.parse(params[7] as string);
    expect(meta).toEqual({ source: "admin-panel", token: "[REDACTED]" });
    expect(params[8]).toBe("sync");
    expect(params[9]).toBeInstanceOf(Date);
    expect((params[9] as Date).toISOString()).toBe("2026-02-15T10:00:00.000Z");
    expect(params[10]).toBe("corr-1");
    expect(params[11]).toBe("req-1");
    expect(params[12]).toBe("test");
  });

  it("uses defaultMode when event does not override it", async () => {
    const audit = createTracevault({
      driver: "postgres",
      connectionString: "postgres://localhost/x",
      defaultMode: "async",
    });

    await audit.emit({ event: "x" });
    await audit.flush();
    await audit.close();

    expect(queryImpl).toHaveBeenCalledTimes(1);
    expect(queryCalls[0]!.params[8]).toBe("async");
  });

  it("emitDiff persists { before, after, diff } inside data", async () => {
    const audit = createTracevault({
      driver: "postgres",
      connectionString: "postgres://localhost/x",
    });

    await audit.emitDiff({
      event: "product.updated",
      actor: { id: "u", type: "user" },
      target: { id: "p", type: "product" },
      before: { name: "Café", price: 120 },
      after: { name: "Café", price: 150 },
    });

    await audit.close();

    const data = JSON.parse(queryCalls[0]!.params[6] as string);
    expect(data).toEqual({
      before: { name: "Café", price: 120 },
      after: { name: "Café", price: 150 },
      diff: { price: { before: 120, after: 150 } },
    });
  });

  it("emitDiff masks sensitive fields in before/after and diff", async () => {
    const audit = createTracevault({
      driver: "postgres",
      connectionString: "postgres://localhost/x",
      maskFields: ["password"],
    });

    await audit.emitDiff({
      event: "user.updated",
      before: { email: "a@b.com", password: "old" },
      after: { email: "a@b.com", password: "new" },
    });
    await audit.close();

    const data = JSON.parse(queryCalls[0]!.params[6] as string);
    expect(data.before.password).toBe("[REDACTED]");
    expect(data.after.password).toBe("[REDACTED]");
    expect(data.diff.password).toBe("[REDACTED]");
  });

  it("async mode buffers events until flush", async () => {
    const audit = createTracevault({
      driver: "postgres",
      connectionString: "postgres://localhost/x",
      defaultMode: "async",
    });

    await audit.emit({ event: "a" });
    await audit.emit({ event: "b" });

    expect(queryImpl).not.toHaveBeenCalled();

    await audit.flush();
    expect(queryImpl).toHaveBeenCalledTimes(2);

    await audit.close();
  });

  it("async mode funnels driver errors through onError", async () => {
    queryImpl.mockImplementationOnce(async () => {
      throw new Error("pg boom");
    });

    const errors: Error[] = [];
    const audit = createTracevault({
      driver: "postgres",
      connectionString: "postgres://localhost/x",
      defaultMode: "async",
      onError: (err) => {
        errors.push(err);
      },
    });

    await audit.emit({ event: "fails" });
    await audit.flush();
    await audit.close();

    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toMatch(/fails/);
  });

  it("rejects invalid events at emit time", async () => {
    const audit = createTracevault({
      driver: "postgres",
      connectionString: "postgres://localhost/x",
    });

    await expect(audit.emit({ event: "" })).rejects.toThrow(ValidationError);
    await expect(audit.emit({ event: "   " })).rejects.toThrow(ValidationError);
    await expect(
      audit.emit({ event: "x", data: { big: 1n as unknown as number } }),
    ).rejects.toThrow(ValidationError);
    await audit.close();
  });

  it("rejects emit and emitDiff after close", async () => {
    const audit = createTracevault({
      driver: "postgres",
      connectionString: "postgres://localhost/x",
    });
    await audit.close();

    await expect(audit.emit({ event: "x" })).rejects.toThrow(TracevaultError);
    await expect(audit.emitDiff({ event: "x" })).rejects.toThrow(TracevaultError);
  });

  it("close() is idempotent (pool.end called once)", async () => {
    const audit = createTracevault({
      driver: "postgres",
      connectionString: "postgres://localhost/x",
    });
    await Promise.all([audit.close(), audit.close(), audit.close()]);
    expect(endImpl).toHaveBeenCalledTimes(1);
  });

  it("healthcheck returns true when SELECT 1 succeeds", async () => {
    const audit = createTracevault({
      driver: "postgres",
      connectionString: "postgres://localhost/x",
    });
    expect(await audit.healthcheck()).toBe(true);
    await audit.close();
  });

  it("healthcheck returns false after close", async () => {
    const audit = createTracevault({
      driver: "postgres",
      connectionString: "postgres://localhost/x",
    });
    await audit.close();
    expect(await audit.healthcheck()).toBe(false);
  });

  it("healthcheck returns false when driver errors", async () => {
    const audit = createTracevault({
      driver: "postgres",
      connectionString: "postgres://localhost/x",
    });
    queryImpl.mockImplementationOnce(async () => {
      throw new Error("down");
    });
    expect(await audit.healthcheck()).toBe(false);
    await audit.close();
  });

  it("uses the configured tableName", async () => {
    const audit = createTracevault({
      driver: "postgres",
      connectionString: "postgres://localhost/x",
      tableName: "custom_audit",
    });
    await audit.emit({ event: "x" });
    await audit.close();
    expect(queryCalls[0]!.sql).toContain('INSERT INTO "custom_audit"');
  });

  it("stamps the configured environment when the event doesn't set one", async () => {
    const audit = createTracevault({
      driver: "postgres",
      connectionString: "postgres://localhost/x",
      environment: "staging",
    });
    await audit.emit({ event: "x" });
    await audit.close();
    expect(queryCalls[0]!.params[12]).toBe("staging");
  });

  it("event-level environment overrides config default", async () => {
    const audit = createTracevault({
      driver: "postgres",
      connectionString: "postgres://localhost/x",
      environment: "staging",
    });
    await audit.emit({ event: "x", environment: "prod" });
    await audit.close();
    expect(queryCalls[0]!.params[12]).toBe("prod");
  });
});
