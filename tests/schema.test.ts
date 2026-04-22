import { describe, expect, it } from "vitest";

import { generateInitSql } from "../src/index.js";
import { ConfigError } from "../src/core/errors.js";

describe("generateInitSql", () => {
  it("produces DDL for a valid table name", () => {
    const sql = generateInitSql("audit_user_events");
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "audit_user_events"');
    expect(sql).toContain("id              UUID        PRIMARY KEY");
    expect(sql).toContain("data            JSONB");
    expect(sql).toContain("occurred_at     TIMESTAMPTZ NOT NULL");
    expect(sql).toContain("created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()");
    expect(sql).toContain('ON "audit_user_events" (event)');
    expect(sql).toContain('ON "audit_user_events" (actor_id, actor_type)');
    expect(sql).toContain('ON "audit_user_events" (target_id, target_type)');
    expect(sql).toContain('ON "audit_user_events" (occurred_at DESC)');
  });

  it("reproduces the same schema as the shipped `audit_logs` migration", () => {
    // Spot-check: the core column shapes match the pinned schema.
    const sql = generateInitSql("audit_logs");
    const expected = [
      'CREATE TABLE IF NOT EXISTS "audit_logs"',
      "id              UUID        PRIMARY KEY",
      "event           VARCHAR     NOT NULL",
      "actor_id        VARCHAR     NULL",
      "actor_type      VARCHAR     NULL",
      "target_id       VARCHAR     NULL",
      "target_type     VARCHAR     NULL",
      "data            JSONB       NULL",
      "meta            JSONB       NULL",
      "mode            VARCHAR     NOT NULL",
      "occurred_at     TIMESTAMPTZ NOT NULL",
      "created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()",
      "correlation_id  VARCHAR     NULL",
      "request_id      VARCHAR     NULL",
      "environment     VARCHAR     NULL",
      'CREATE INDEX IF NOT EXISTS idx_audit_logs_event        ON "audit_logs" (event)',
      'CREATE INDEX IF NOT EXISTS idx_audit_logs_actor        ON "audit_logs" (actor_id, actor_type)',
      'CREATE INDEX IF NOT EXISTS idx_audit_logs_target       ON "audit_logs" (target_id, target_type)',
      'CREATE INDEX IF NOT EXISTS idx_audit_logs_occurred_at  ON "audit_logs" (occurred_at DESC)',
    ];
    for (const snippet of expected) {
      expect(sql).toContain(snippet);
    }
  });

  it("rejects invalid table names with ConfigError", () => {
    expect(() => generateInitSql("bad-name;DROP")).toThrow(ConfigError);
    expect(() => generateInitSql("1leading_digit")).toThrow(ConfigError);
    expect(() => generateInitSql("")).toThrow(ConfigError);
    expect(() => generateInitSql("a".repeat(64))).toThrow(ConfigError);
    expect(() => generateInitSql(42 as unknown as string)).toThrow(ConfigError);
  });

  it("does not execute anything (returns a string only)", () => {
    const sql = generateInitSql("any_table");
    expect(typeof sql).toBe("string");
    expect(sql.length).toBeGreaterThan(0);
  });
});
