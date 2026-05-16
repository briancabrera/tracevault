import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";

import { ConfigError, ValidationError } from "../../src/core/errors.js";
import {
  assertUuid,
  validateAndNormalizeCountFilters,
  validateAndNormalizeFilters,
  validateQueryConfig,
  validateQueryScopeOverrides,
} from "../../src/query/validator.js";

describe("query / validateQueryConfig", () => {
  it("accepts a minimal valid config", () => {
    expect(() =>
      validateQueryConfig({
        driver: "postgres",
        connectionString: "postgres://localhost/x",
      }),
    ).not.toThrow();
  });

  it("accepts pool with connectionString", () => {
    const pool = {
      query: async () => ({ rows: [] }),
      connect: async () => ({ release: vi.fn() }),
    } as unknown as Pool;
    expect(() =>
      validateQueryConfig({
        driver: "postgres",
        connectionString: "postgres://localhost/x",
        pool,
      }),
    ).not.toThrow();
  });

  it("accepts a valid tableName", () => {
    expect(() =>
      validateQueryConfig({
        driver: "postgres",
        connectionString: "postgres://localhost/x",
        tableName: "audit_logs",
      }),
    ).not.toThrow();
  });

  it.each([
    [null],
    [undefined],
    ["not-an-object"],
    [42],
  ])("rejects non-object config %p", (value) => {
    expect(() => validateQueryConfig(value as never)).toThrow(ConfigError);
  });

  it("rejects a missing driver", () => {
    expect(() =>
      validateQueryConfig({ connectionString: "x" } as never),
    ).toThrow(/`driver` is required/);
  });

  it("rejects an unsupported driver", () => {
    expect(() =>
      validateQueryConfig({ driver: "mysql" as never, connectionString: "x" }),
    ).toThrow(/unsupported driver/);
  });

  it("rejects an empty connectionString", () => {
    expect(() =>
      validateQueryConfig({ driver: "postgres", connectionString: "   " }),
    ).toThrow(/connectionString/);
  });

  it("rejects an invalid tableName", () => {
    expect(() =>
      validateQueryConfig({
        driver: "postgres",
        connectionString: "x",
        tableName: "123bad",
      }),
    ).toThrow(/tableName/);
  });
});

describe("query / validateQueryScopeOverrides", () => {
  it("accepts undefined / null / empty", () => {
    expect(() => validateQueryScopeOverrides(undefined)).not.toThrow();
    expect(() => validateQueryScopeOverrides(null)).not.toThrow();
    expect(() => validateQueryScopeOverrides({})).not.toThrow();
  });

  it("accepts a valid tableName override", () => {
    expect(() => validateQueryScopeOverrides({ tableName: "audit_user_events" })).not.toThrow();
  });

  it("rejects non-object overrides", () => {
    expect(() => validateQueryScopeOverrides("x" as never)).toThrow(ConfigError);
    expect(() => validateQueryScopeOverrides([] as never)).toThrow(ConfigError);
  });

  it("explicitly rejects `driver` and `connectionString`", () => {
    expect(() =>
      validateQueryScopeOverrides({ driver: "postgres" } as never),
    ).toThrow(/`driver` cannot be overridden/);
    expect(() =>
      validateQueryScopeOverrides({ connectionString: "x" } as never),
    ).toThrow(/`connectionString` cannot be overridden/);
  });

  it("rejects unknown keys", () => {
    expect(() =>
      validateQueryScopeOverrides({ limit: 10 } as never),
    ).toThrow(/unknown override/);
  });

  it("rejects an invalid tableName", () => {
    expect(() =>
      validateQueryScopeOverrides({ tableName: "bad name" }),
    ).toThrow(/tableName/);
  });
});

describe("query / assertUuid", () => {
  it("accepts valid UUID strings", () => {
    expect(() => assertUuid("00000000-0000-4000-8000-000000000000", "id")).not.toThrow();
    expect(() => assertUuid("DEADBEEF-1234-5678-9ABC-DEF012345678", "id")).not.toThrow();
  });

  it("rejects non-strings and malformed UUIDs", () => {
    expect(() => assertUuid(42 as never, "id")).toThrow(ValidationError);
    expect(() => assertUuid("", "id")).toThrow(ValidationError);
    expect(() => assertUuid("not-a-uuid", "id")).toThrow(ValidationError);
    expect(() => assertUuid("00000000-0000-0000-0000", "id")).toThrow(ValidationError);
  });
});

describe("query / validateAndNormalizeFilters", () => {
  it("applies defaults when no filters are passed", () => {
    const n = validateAndNormalizeFilters(undefined);
    expect(n.limit).toBe(50);
    expect(n.offset).toBe(0);
    expect(n.order).toBe("desc");
    expect(n.event).toBeNull();
    expect(n.from).toBeNull();
    expect(n.to).toBeNull();
  });

  it("passes through valid filters", () => {
    const n = validateAndNormalizeFilters({
      event: "user.updated",
      actorId: "u1",
      actorType: "user",
      targetId: "t1",
      targetType: "user",
      correlationId: "cid",
      requestId: "rid",
      environment: "prod",
      outcome: "failure",
      errorCode: "E_1",
      severity: "warning",
      severities: ["a", "b"],
      errorsOnly: true,
      mode: "async",
      from: "2026-01-01T00:00:00Z",
      to: new Date("2026-02-01T00:00:00Z"),
      limit: 100,
      offset: 50,
      order: "asc",
    });
    expect(n.event).toBe("user.updated");
    expect(n.actorId).toBe("u1");
    expect(n.mode).toBe("async");
    expect(n.outcome).toBe("failure");
    expect(n.errorCode).toBe("E_1");
    expect(n.severity).toBe("warning");
    expect(n.severities).toEqual(["a", "b"]);
    expect(n.errorsOnly).toBe(true);
    expect(n.from).toBeInstanceOf(Date);
    expect(n.to).toBeInstanceOf(Date);
    expect(n.from!.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(n.limit).toBe(100);
    expect(n.offset).toBe(50);
    expect(n.order).toBe("asc");
  });

  it("rejects a non-object filter payload", () => {
    expect(() => validateAndNormalizeFilters("x" as never)).toThrow(ValidationError);
    expect(() => validateAndNormalizeFilters([] as never)).toThrow(ValidationError);
  });

  it("rejects unknown filter keys", () => {
    expect(() =>
      validateAndNormalizeFilters({ foo: 1 } as never),
    ).toThrow(/Unknown filter/);
  });

  it.each([
    ["event", ""],
    ["event", "   "],
    ["actorId", ""],
    ["actorType", 42],
    ["targetId", null],
    ["correlationId", {}],
  ])("rejects invalid %s value %p", (field, value) => {
    expect(() =>
      validateAndNormalizeFilters({ [field]: value } as never),
    ).toThrow(ValidationError);
  });

  it("rejects newline/tab in event name", () => {
    expect(() => validateAndNormalizeFilters({ event: "bad\nname" })).toThrow(
      /newline/,
    );
  });

  it("rejects an invalid mode", () => {
    expect(() =>
      validateAndNormalizeFilters({ mode: "maybe" } as never),
    ).toThrow(/mode/);
  });

  it.each([
    ["from", "not-a-date"],
    ["to", "blorgh"],
  ])("rejects an invalid %s string", (field, value) => {
    expect(() =>
      validateAndNormalizeFilters({ [field]: value } as never),
    ).toThrow(/parseable/);
  });

  it("rejects a Date instance that is Invalid Date", () => {
    expect(() =>
      validateAndNormalizeFilters({ from: new Date("not-a-date") }),
    ).toThrow(/invalid Date/);
  });

  it("rejects from > to", () => {
    expect(() =>
      validateAndNormalizeFilters({
        from: new Date("2026-02-01"),
        to: new Date("2026-01-01"),
      }),
    ).toThrow(/less than or equal/);
  });

  it("accepts from equal to to", () => {
    const d = new Date("2026-01-01");
    expect(() => validateAndNormalizeFilters({ from: d, to: d })).not.toThrow();
  });

  it.each([
    [0],
    [-1],
    [1.5],
    ["10" as unknown as number],
  ])("rejects invalid limit %p", (value) => {
    expect(() =>
      validateAndNormalizeFilters({ limit: value as number }),
    ).toThrow(/limit/);
  });

  it("rejects limit above the hard cap", () => {
    expect(() => validateAndNormalizeFilters({ limit: 501 })).toThrow(/at most 500/);
  });

  it.each([[-1], [1.5], ["0" as unknown as number]])(
    "rejects invalid offset %p",
    (value) => {
      expect(() =>
        validateAndNormalizeFilters({ offset: value as number }),
      ).toThrow(/offset/);
    },
  );

  it("rejects invalid order", () => {
    expect(() =>
      validateAndNormalizeFilters({ order: "up" } as never),
    ).toThrow(/order/);
  });

  it("rejects non-boolean errorsOnly", () => {
    expect(() =>
      validateAndNormalizeFilters({ errorsOnly: "yes" } as never),
    ).toThrow(/errorsOnly/);
  });

  it("rejects empty severities array", () => {
    expect(() => validateAndNormalizeFilters({ severities: [] })).toThrow(/non-empty/);
  });

  it("rejects duplicate severities entries", () => {
    expect(() =>
      validateAndNormalizeFilters({ severities: ["x", "x"] }),
    ).toThrow(/duplicate/);
  });
});

describe("query / validateAndNormalizeCountFilters", () => {
  it("passes through the shared filter set", () => {
    const n = validateAndNormalizeCountFilters({
      event: "x",
      from: new Date("2026-01-01"),
    });
    expect(n.event).toBe("x");
    expect(n.from).toBeInstanceOf(Date);
  });

  it("rejects pagination/order keys with a clear message", () => {
    expect(() =>
      validateAndNormalizeCountFilters({ limit: 10 } as never),
    ).toThrow(/Unknown filter.*for count/);
    expect(() =>
      validateAndNormalizeCountFilters({ offset: 1 } as never),
    ).toThrow(/for count/);
    expect(() =>
      validateAndNormalizeCountFilters({ order: "asc" } as never),
    ).toThrow(/for count/);
  });

  it("returns defaults when called with undefined", () => {
    const n = validateAndNormalizeCountFilters(undefined);
    expect(n.event).toBeNull();
    expect(n.from).toBeNull();
  });
});
