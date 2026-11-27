import { describe, expect, it } from "vitest";

import { ValidationError } from "../../src/core/errors.js";
import { buildFindPageSql } from "../../src/query/builder.js";
import { decodeCursor, encodeCursor } from "../../src/query/cursor.js";
import { validateAndNormalizePageFilters } from "../../src/query/validator.js";

const ID = "8f14e45f-ceea-467f-a9c5-6b7c1e1d2a3b";
const TS = "2026-01-02T03:04:05.123456";

describe("page cursor", () => {
  it("round-trips", () => {
    const c = { ts: TS, id: ID, order: "desc" as const };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
  });

  it("rejects malformed cursors", () => {
    for (const bad of ["", "nope", 42, encodeCursor({ ts: "x", id: ID, order: "asc" })]) {
      expect(() => decodeCursor(bad)).toThrow(ValidationError);
    }
  });

  it("validates page filters", () => {
    expect(validateAndNormalizePageFilters(undefined).cursor).toBeNull();
    expect(() => validateAndNormalizePageFilters({ offset: 10 } as never)).toThrow(/cursor/);
    const cursor = encodeCursor({ ts: TS, id: ID, order: "desc" });
    expect(validateAndNormalizePageFilters({ cursor }).cursor).toEqual({
      ts: TS,
      id: ID,
      order: "desc",
    });
    expect(() => validateAndNormalizePageFilters({ cursor, order: "asc" })).toThrow(/order/);
    expect(() => validateAndNormalizePageFilters({ limit: 0 })).toThrow(ValidationError);
  });

  it("builds a keyset query that fetches limit + 1 rows", () => {
    const filters = validateAndNormalizePageFilters({
      event: "e",
      limit: 10,
      cursor: encodeCursor({ ts: TS, id: ID, order: "desc" }),
    });
    const { sql, params } = buildFindPageSql("audit_logs", filters);
    expect(sql).toContain("(occurred_at, id) < ($2::timestamp AT TIME ZONE 'UTC', $3::uuid)");
    expect(sql).toContain("ORDER BY occurred_at DESC, id DESC LIMIT $4");
    expect(params).toEqual(["e", TS, ID, 11]);
  });
});
