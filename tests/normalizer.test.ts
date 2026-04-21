import { describe, expect, it } from "vitest";

import { normalizeDiffEvent, normalizeEvent } from "../src/core/normalizer.js";

const baseOpts = {
  defaultMode: "sync" as const,
  defaultEnvironment: null,
  maskFields: [] as string[],
  maskValue: "[REDACTED]",
};

describe("normalizeEvent", () => {
  it("assigns defaults for missing fields", () => {
    const record = normalizeEvent({ event: "user.signed_in" }, baseOpts);
    expect(record.event).toBe("user.signed_in");
    expect(record.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(record.actorId).toBeNull();
    expect(record.actorType).toBeNull();
    expect(record.targetId).toBeNull();
    expect(record.targetType).toBeNull();
    expect(record.data).toBeNull();
    expect(record.meta).toBeNull();
    expect(record.mode).toBe("sync");
    expect(record.occurredAt).toBeInstanceOf(Date);
    expect(record.correlationId).toBeNull();
    expect(record.requestId).toBeNull();
    expect(record.environment).toBeNull();
  });

  it("flattens actor and target", () => {
    const record = normalizeEvent(
      {
        event: "product.price.updated",
        actor: { id: "u1", type: "user" },
        target: { id: "p1", type: "product" },
      },
      baseOpts,
    );
    expect(record.actorId).toBe("u1");
    expect(record.actorType).toBe("user");
    expect(record.targetId).toBe("p1");
    expect(record.targetType).toBe("product");
  });

  it("parses string occurredAt into a Date", () => {
    const record = normalizeEvent(
      { event: "x", occurredAt: "2026-01-01T00:00:00.000Z" },
      baseOpts,
    );
    expect(record.occurredAt.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("prefers event.mode over defaultMode", () => {
    const record = normalizeEvent(
      { event: "x", mode: "async" },
      { ...baseOpts, defaultMode: "sync" },
    );
    expect(record.mode).toBe("async");
  });

  it("applies environment default", () => {
    const record = normalizeEvent(
      { event: "x" },
      { ...baseOpts, defaultEnvironment: "production" },
    );
    expect(record.environment).toBe("production");
  });

  it("applies masking to data and meta", () => {
    const record = normalizeEvent(
      {
        event: "x",
        data: { password: "secret", email: "a@b.com" },
        meta: { token: "abc" },
      },
      { ...baseOpts, maskFields: ["password", "token"] },
    );
    expect(record.data).toEqual({ password: "[REDACTED]", email: "a@b.com" });
    expect(record.meta).toEqual({ token: "[REDACTED]" });
  });
});

describe("normalizeDiffEvent", () => {
  it("stuffs before/after/diff inside data", () => {
    const record = normalizeDiffEvent(
      {
        event: "product.updated",
        before: { name: "Café", price: 120 },
        after: { name: "Café", price: 150 },
      },
      baseOpts,
    );
    expect(record.data).toEqual({
      before: { name: "Café", price: 120 },
      after: { name: "Café", price: 150 },
      diff: { price: { before: 120, after: 150 } },
    });
  });

  it("applies masking to before/after inside data", () => {
    const record = normalizeDiffEvent(
      {
        event: "user.updated",
        before: { password: "old" },
        after: { password: "new" },
      },
      { ...baseOpts, maskFields: ["password"] },
    );
    expect(record.data).toMatchObject({
      before: { password: "[REDACTED]" },
      after: { password: "[REDACTED]" },
    });
  });
});
