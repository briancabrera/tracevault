import { describe, expect, it } from "vitest";

import {
  randomCorrelationId,
  readCorrelationIdHeader,
  resolveCorrelationId,
} from "../src/core/correlation.js";

describe("correlation helpers", () => {
  it("randomCorrelationId returns a UUID-shaped string", () => {
    const id = randomCorrelationId();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it("readCorrelationIdHeader trims and rejects blank / oversize", () => {
    expect(readCorrelationIdHeader(() => "  abc  ")).toBe("abc");
    expect(readCorrelationIdHeader(() => undefined)).toBeUndefined();
    expect(readCorrelationIdHeader(() => "   ")).toBeUndefined();
    expect(readCorrelationIdHeader(() => "x".repeat(513))).toBeUndefined();
  });

  it("resolveCorrelationId falls back to a fresh id when header missing", () => {
    const a = resolveCorrelationId(() => undefined);
    const b = resolveCorrelationId(() => undefined);
    expect(a).toMatch(/^[0-9a-f-]{36}$/i);
    expect(b).toMatch(/^[0-9a-f-]{36}$/i);
    expect(a).not.toBe(b);
    expect(resolveCorrelationId(() => "from-header")).toBe("from-header");
  });
});
