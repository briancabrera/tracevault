import { describe, expect, it } from "vitest";

import {
  buildCountSql,
  buildFindByIdSql,
  buildFindManySql,
} from "../../src/query/builder.js";
import { validateAndNormalizeFilters } from "../../src/query/validator.js";

function normalize(filters: Parameters<typeof validateAndNormalizeFilters>[0]) {
  return validateAndNormalizeFilters(filters);
}

describe("query / builder — findMany", () => {
  it("no filters → SELECT ... WHERE TRUE ORDER BY occurred_at DESC, id DESC LIMIT/OFFSET", () => {
    const { sql, params } = buildFindManySql("audit_logs", normalize(undefined));
    expect(sql).toContain('FROM "audit_logs"');
    expect(sql).toContain("WHERE TRUE");
    expect(sql).toContain("ORDER BY occurred_at DESC, id DESC");
    expect(sql).toMatch(/LIMIT \$1 OFFSET \$2$/);
    expect(params).toEqual([50, 0]);
  });

  it("ascending order is reflected in both ORDER BY columns", () => {
    const { sql } = buildFindManySql("audit_logs", normalize({ order: "asc" }));
    expect(sql).toContain("ORDER BY occurred_at ASC, id ASC");
  });

  it("equality filters are parameterized in a stable order", () => {
    const { sql, params } = buildFindManySql(
      "audit_logs",
      normalize({
        event: "user.updated",
        actorId: "u1",
        actorType: "user",
        targetId: "t1",
        targetType: "user",
        correlationId: "corr",
        requestId: "req",
        environment: "prod",
        mode: "async",
        outcome: "failure",
        errorCode: "E_AUTH",
        severity: "warning",
        limit: 10,
        offset: 0,
      }),
    );
    expect(sql).toMatch(
      /WHERE event = \$1 AND actor_id = \$2 AND actor_type = \$3 AND target_id = \$4 AND target_type = \$5 AND correlation_id = \$6 AND request_id = \$7 AND environment = \$8 AND mode = \$9 AND outcome = \$10 AND error_code = \$11 AND severity = \$12 ORDER BY/,
    );
    expect(params).toEqual([
      "user.updated",
      "u1",
      "user",
      "t1",
      "user",
      "corr",
      "req",
      "prod",
      "async",
      "failure",
      "E_AUTH",
      "warning",
      10,
      0,
    ]);
  });

  it("severities expands to IN (...)", () => {
    const { sql, params } = buildFindManySql(
      "audit_logs",
      normalize({ severities: ["error", "critical"], limit: 3 }),
    );
    expect(sql).toContain("severity IN ($1, $2)");
    expect(sql).toMatch(/LIMIT \$3 OFFSET \$4$/);
    expect(params).toEqual(["error", "critical", 3, 0]);
  });

  it("errorsOnly adds outcome failure or high-severity OR group", () => {
    const { sql, params } = buildFindManySql(
      "audit_logs",
      normalize({ errorsOnly: true, limit: 5 }),
    );
    expect(sql).toContain("(outcome = $1 OR severity IN ($2, $3, $4))");
    expect(params).toEqual(["failure", "error", "critical", "fatal", 5, 0]);
  });

  it("from/to append occurred_at bounds after equality filters", () => {
    const from = new Date("2026-01-01T00:00:00.000Z");
    const to = new Date("2026-02-01T00:00:00.000Z");
    const { sql, params } = buildFindManySql(
      "audit_logs",
      normalize({ event: "x", from, to, limit: 5 }),
    );
    expect(sql).toContain("event = $1");
    expect(sql).toContain("occurred_at >= $2");
    expect(sql).toContain("occurred_at <= $3");
    expect(sql).toMatch(/LIMIT \$4 OFFSET \$5$/);
    expect(params).toEqual(["x", from, to, 5, 0]);
  });

  it("quotes the table name literally but disallows injection via validator", () => {
    // Builder trusts that tableName was pre-validated. We simply check the
    // double-quoted form is used (PG treats "user" as a legal reserved-word
    // identifier this way).
    const { sql } = buildFindManySql("user_logs", normalize(undefined));
    expect(sql).toContain('FROM "user_logs"');
  });
});

describe("query / builder — count", () => {
  it("emits COUNT(*)::text with the same WHERE shape", () => {
    const { sql, params } = buildCountSql("audit_logs", normalize({ event: "x" }));
    expect(sql).toBe(
      'SELECT COUNT(*)::text AS c FROM "audit_logs" WHERE event = $1',
    );
    expect(params).toEqual(["x"]);
  });

  it("uses WHERE TRUE when no filters are given", () => {
    const { sql, params } = buildCountSql("audit_logs", normalize(undefined));
    expect(sql).toBe('SELECT COUNT(*)::text AS c FROM "audit_logs" WHERE TRUE');
    expect(params).toEqual([]);
  });
});

describe("query / builder — findById", () => {
  it("selects by primary key with a single parameter", () => {
    const { sql, params } = buildFindByIdSql(
      "audit_logs",
      "00000000-0000-4000-8000-000000000000",
    );
    expect(sql).toMatch(/^SELECT .* FROM "audit_logs" WHERE id = \$1$/);
    expect(params).toEqual(["00000000-0000-4000-8000-000000000000"]);
  });
});
