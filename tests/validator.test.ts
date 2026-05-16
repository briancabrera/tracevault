import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";

import { ConfigError, ValidationError } from "../src/core/errors.js";
import {
  assertValidTableName,
  validateConfig,
  validateDiffEvent,
  validateEvent,
  validateScopeOverrides,
  validateStartTracevaultOptions,
} from "../src/core/validator.js";
import type { TracevaultConfig } from "../src/types/index.js";

function baseConfig(): TracevaultConfig {
  return {
    driver: "postgres",
    connectionString: "postgres://localhost/test",
  };
}

describe("validateConfig", () => {
  it("accepts a minimal valid config", () => {
    expect(() => validateConfig(baseConfig())).not.toThrow();
  });

  it("accepts a fully-specified config", () => {
    expect(() =>
      validateConfig({
        ...baseConfig(),
        tableName: "audit_logs",
        maskFields: ["password"],
        maskValue: "***",
        defaultMode: "async",
        environment: "prod",
        onError: () => {},
        asyncBatchSize: 10,
        asyncFlushIntervalMs: 50,
      }),
    ).not.toThrow();
  });

  it("rejects unsupported drivers", () => {
    expect(() =>
      validateConfig({ ...baseConfig(), driver: "mysql" as unknown as "postgres" }),
    ).toThrow(ConfigError);
  });

  it("rejects missing connectionString", () => {
    expect(() => validateConfig({ ...baseConfig(), connectionString: "" })).toThrow(ConfigError);
    expect(() => validateConfig({ ...baseConfig(), connectionString: "   " })).toThrow(ConfigError);
  });

  it("rejects invalid tableName", () => {
    expect(() => validateConfig({ ...baseConfig(), tableName: "bad-name;DROP" })).toThrow(
      ConfigError,
    );
    expect(() => validateConfig({ ...baseConfig(), tableName: "1starts_with_digit" })).toThrow(
      ConfigError,
    );
    expect(() => validateConfig({ ...baseConfig(), tableName: "" })).toThrow(ConfigError);
    expect(() =>
      validateConfig({ ...baseConfig(), tableName: "a".repeat(64) }),
    ).toThrow(ConfigError);
  });

  it("rejects invalid defaultMode", () => {
    expect(() =>
      validateConfig({ ...baseConfig(), defaultMode: "fire-and-forget" as "sync" }),
    ).toThrow(ConfigError);
  });

  it("rejects non-array maskFields", () => {
    expect(() =>
      validateConfig({ ...baseConfig(), maskFields: "password" as unknown as string[] }),
    ).toThrow(ConfigError);
  });

  it("rejects maskFields entries that aren't non-empty strings", () => {
    expect(() => validateConfig({ ...baseConfig(), maskFields: ["password", ""] })).toThrow(
      ConfigError,
    );
    expect(() =>
      validateConfig({ ...baseConfig(), maskFields: [123 as unknown as string] }),
    ).toThrow(ConfigError);
  });

  it("rejects non-string maskValue", () => {
    expect(() =>
      validateConfig({ ...baseConfig(), maskValue: 42 as unknown as string }),
    ).toThrow(ConfigError);
  });

  it("rejects non-string environment", () => {
    expect(() =>
      validateConfig({ ...baseConfig(), environment: 1 as unknown as string }),
    ).toThrow(ConfigError);
  });

  it("rejects non-function onError", () => {
    expect(() =>
      validateConfig({
        ...baseConfig(),
        onError: "not-a-fn" as unknown as TracevaultConfig["onError"],
      }),
    ).toThrow(ConfigError);
  });

  it("rejects non-positive asyncBatchSize", () => {
    expect(() => validateConfig({ ...baseConfig(), asyncBatchSize: 0 })).toThrow(ConfigError);
    expect(() => validateConfig({ ...baseConfig(), asyncBatchSize: 1.5 })).toThrow(ConfigError);
    expect(() => validateConfig({ ...baseConfig(), asyncBatchSize: -1 })).toThrow(ConfigError);
  });

  it("rejects negative asyncFlushIntervalMs", () => {
    expect(() => validateConfig({ ...baseConfig(), asyncFlushIntervalMs: -1 })).toThrow(
      ConfigError,
    );
    expect(() => validateConfig({ ...baseConfig(), asyncFlushIntervalMs: Infinity })).toThrow(
      ConfigError,
    );
  });
});

describe("validateEvent", () => {
  it("accepts a minimal event", () => {
    expect(() => validateEvent({ event: "something.happened" })).not.toThrow();
  });

  it("rejects missing event name", () => {
    expect(() => validateEvent({ event: "" })).toThrow(ValidationError);
  });

  it("rejects whitespace-only event name", () => {
    expect(() => validateEvent({ event: "   " })).toThrow(ValidationError);
  });

  it("rejects event names containing newlines or tabs", () => {
    expect(() => validateEvent({ event: "a\nb" })).toThrow(ValidationError);
    expect(() => validateEvent({ event: "a\tb" })).toThrow(ValidationError);
  });

  it("rejects event names longer than 255 chars", () => {
    expect(() => validateEvent({ event: "a".repeat(256) })).toThrow(ValidationError);
  });

  it("rejects non-string event", () => {
    expect(() => validateEvent({ event: 1 as unknown as string })).toThrow(ValidationError);
  });

  it("rejects malformed actor", () => {
    expect(() => validateEvent({ event: "x", actor: { id: "", type: "user" } })).toThrow(
      ValidationError,
    );
    expect(() =>
      validateEvent({ event: "x", actor: [] as unknown as { id: string; type: string } }),
    ).toThrow(ValidationError);
  });

  it("rejects malformed target", () => {
    expect(() => validateEvent({ event: "x", target: { id: "abc", type: "" } })).toThrow(
      ValidationError,
    );
  });

  it("rejects identifiers longer than the max", () => {
    const long = "a".repeat(513);
    expect(() => validateEvent({ event: "x", actor: { id: long, type: "user" } })).toThrow(
      ValidationError,
    );
  });

  it("rejects invalid occurredAt", () => {
    expect(() => validateEvent({ event: "x", occurredAt: "not-a-date" })).toThrow(ValidationError);
    expect(() =>
      validateEvent({ event: "x", occurredAt: new Date("invalid") }),
    ).toThrow(ValidationError);
    expect(() =>
      validateEvent({ event: "x", occurredAt: 123 as unknown as string }),
    ).toThrow(ValidationError);
  });

  it("rejects non-object data", () => {
    expect(() =>
      validateEvent({ event: "x", data: [1, 2] as unknown as Record<string, unknown> }),
    ).toThrow(ValidationError);
  });

  it("rejects invalid mode", () => {
    expect(() => validateEvent({ event: "x", mode: "fast" as "sync" })).toThrow(ValidationError);
  });

  it("rejects non-serializable data (BigInt, function, circular)", () => {
    expect(() =>
      validateEvent({ event: "x", data: { big: 1n as unknown as number } }),
    ).toThrow(ValidationError);
    expect(() =>
      validateEvent({
        event: "x",
        data: { fn: (() => 1) as unknown as number },
      }),
    ).toThrow(ValidationError);

    const cyc: Record<string, unknown> = { a: 1 };
    cyc.self = cyc;
    expect(() => validateEvent({ event: "x", data: cyc })).toThrow(/circular/);
  });

  it("rejects class instances in data", () => {
    class Foo {
      x = 1;
    }
    expect(() =>
      validateEvent({ event: "x", data: { foo: new Foo() } as unknown as Record<string, unknown> }),
    ).toThrow(/plain object/);
  });

  it("rejects optional strings that are not strings", () => {
    expect(() =>
      validateEvent({ event: "x", correlationId: 42 as unknown as string }),
    ).toThrow(ValidationError);
    expect(() =>
      validateEvent({ event: "x", requestId: "" as unknown as string }),
    ).toThrow(ValidationError);
  });
});

describe("assertValidTableName", () => {
  it("accepts typical valid names", () => {
    expect(() => assertValidTableName("audit_logs", "ctx")).not.toThrow();
    expect(() => assertValidTableName("_underscore", "ctx")).not.toThrow();
    expect(() => assertValidTableName("Audit_123", "ctx")).not.toThrow();
  });

  it("rejects names violating the policy and includes the context prefix", () => {
    expect(() => assertValidTableName("1bad", "generateInitSql")).toThrow(
      /generateInitSql: `tableName`/,
    );
    expect(() => assertValidTableName("a".repeat(64), "ctx")).toThrow(ConfigError);
    expect(() => assertValidTableName("", "ctx")).toThrow(ConfigError);
    expect(() => assertValidTableName("bad-name", "ctx")).toThrow(ConfigError);
    expect(() => assertValidTableName(42 as unknown as string, "ctx")).toThrow(
      ConfigError,
    );
  });
});

describe("validateScopeOverrides", () => {
  it("accepts undefined / null / empty object", () => {
    expect(() => validateScopeOverrides(undefined)).not.toThrow();
    expect(() => validateScopeOverrides(null)).not.toThrow();
    expect(() => validateScopeOverrides({})).not.toThrow();
  });

  it("rejects non-object inputs", () => {
    expect(() => validateScopeOverrides(42 as unknown)).toThrow(ConfigError);
    expect(() => validateScopeOverrides([] as unknown)).toThrow(ConfigError);
    expect(() => validateScopeOverrides("hi" as unknown)).toThrow(ConfigError);
  });

  it("rejects driver / connectionString explicitly", () => {
    expect(() =>
      validateScopeOverrides({ driver: "postgres" } as unknown),
    ).toThrow(/cannot be overridden/);
    expect(() =>
      validateScopeOverrides({ connectionString: "x" } as unknown),
    ).toThrow(/cannot be overridden/);
  });

  it("rejects unknown keys", () => {
    expect(() => validateScopeOverrides({ frobnicate: true } as unknown)).toThrow(
      /unknown override `frobnicate`/,
    );
  });

  it("accepts valid full override set", () => {
    expect(() =>
      validateScopeOverrides({
        tableName: "audit_user_events",
        defaultMode: "async",
        environment: "prod",
        maskFields: ["secret"],
        maskValue: "***",
        onError: () => {},
        asyncBatchSize: 10,
        asyncFlushIntervalMs: 25,
      }),
    ).not.toThrow();
  });

  it("applies field-level validation for each override", () => {
    expect(() => validateScopeOverrides({ tableName: "bad-name" })).toThrow(ConfigError);
    expect(() =>
      validateScopeOverrides({ defaultMode: "fire" as unknown as "sync" }),
    ).toThrow(ConfigError);
    expect(() =>
      validateScopeOverrides({ maskFields: "password" as unknown as string[] }),
    ).toThrow(ConfigError);
    expect(() =>
      validateScopeOverrides({ maskValue: 42 as unknown as string }),
    ).toThrow(ConfigError);
    expect(() =>
      validateScopeOverrides({ environment: 1 as unknown as string }),
    ).toThrow(ConfigError);
    expect(() =>
      validateScopeOverrides({ onError: "nope" as unknown as () => void }),
    ).toThrow(ConfigError);
    expect(() => validateScopeOverrides({ asyncBatchSize: 0 })).toThrow(ConfigError);
    expect(() => validateScopeOverrides({ asyncFlushIntervalMs: -1 })).toThrow(
      ConfigError,
    );
  });
});

describe("validateDiffEvent", () => {
  it("accepts a minimal diff event", () => {
    expect(() =>
      validateDiffEvent({ event: "product.updated", before: {}, after: {} }),
    ).not.toThrow();
  });

  it("accepts diff event with missing before/after", () => {
    expect(() => validateDiffEvent({ event: "product.created" })).not.toThrow();
  });

  it("rejects missing event name", () => {
    expect(() => validateDiffEvent({ event: "" })).toThrow(ValidationError);
  });

  it("rejects non-plain before/after", () => {
    expect(() =>
      validateDiffEvent({
        event: "x",
        before: [1] as unknown as Record<string, unknown>,
      }),
    ).toThrow(ValidationError);
  });
});

describe("validateStartTracevaultOptions", () => {
  it("accepts a minimal valid options object", () => {
    expect(() =>
      validateStartTracevaultOptions({
        driver: "postgres",
        connectionString: "postgres://localhost/x",
        defaultScope: "default",
        scopes: { default: { tableName: "audit_logs" } },
      }),
    ).not.toThrow();
  });

  it("rejects defaultScope not in scopes", () => {
    expect(() =>
      validateStartTracevaultOptions({
        driver: "postgres",
        connectionString: "postgres://localhost/x",
        defaultScope: "main",
        scopes: { default: { tableName: "audit_logs" } },
      }),
    ).toThrow(/defaultScope/);
  });

  it("rejects invalid scope name key", () => {
    expect(() =>
      validateStartTracevaultOptions({
        driver: "postgres",
        connectionString: "postgres://localhost/x",
        defaultScope: "default",
        scopes: { "bad key": { tableName: "audit_logs" } },
      }),
    ).toThrow(ConfigError);
  });

  it("rejects readPool without pool", () => {
    expect(() =>
      validateStartTracevaultOptions({
        driver: "postgres",
        connectionString: "postgres://w/x",
        defaultScope: "default",
        scopes: { default: { tableName: "audit_logs" } },
        readPool: {
          query: async () => ({ rows: [] }),
          connect: async () => ({ release: vi.fn() }),
        } as unknown as Pool,
      }),
    ).toThrow(/`readPool` requires `pool`/);
  });

  it("rejects mismatched readConnectionString when using one injected pool", () => {
    const pool = {
      query: async () => ({ rows: [] }),
      connect: async () => ({ release: vi.fn() }),
    } as unknown as Pool;
    expect(() =>
      validateStartTracevaultOptions({
        driver: "postgres",
        connectionString: "postgres://write/x",
        readConnectionString: "postgres://read/x",
        pool,
        defaultScope: "default",
        scopes: { default: { tableName: "audit_logs" } },
      }),
    ).toThrow(/readPool/);
  });

  it("accepts injected pool with connect + query", () => {
    const pool = {
      query: async () => ({ rows: [] }),
      connect: async () => ({ release: vi.fn() }),
    } as unknown as Pool;
    expect(() =>
      validateStartTracevaultOptions({
        driver: "postgres",
        connectionString: "postgres://localhost/x",
        pool,
        defaultScope: "default",
        scopes: { default: { tableName: "audit_logs" } },
      }),
    ).not.toThrow();
  });
});

describe("validateConfig / pool", () => {
  it("accepts pool with connectionString", () => {
    const pool = {
      query: async () => ({ rows: [] }),
      connect: async () => ({ release: vi.fn() }),
    } as unknown as Pool;
    expect(() =>
      validateConfig({
        driver: "postgres",
        connectionString: "postgres://localhost/x",
        pool,
      }),
    ).not.toThrow();
  });

  it("rejects invalid pool", () => {
    expect(() =>
      validateConfig({
        driver: "postgres",
        connectionString: "postgres://localhost/x",
        pool: {} as Pool,
      }),
    ).toThrow(/pool/);
  });
});
