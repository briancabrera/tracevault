import { describe, expect, it } from "vitest";

import { DEFAULT_MASK_VALUE, mask } from "../src/core/masker.js";

describe("mask", () => {
  it("returns a clone when no fields to mask", () => {
    const input = { name: "Café", price: 120 };
    const out = mask(input, []);
    expect(out).toEqual(input);
    expect(out).not.toBe(input);
  });

  it("masks top-level sensitive keys", () => {
    const out = mask({ password: "secret123", name: "Jane" }, ["password"]);
    expect(out).toEqual({ password: DEFAULT_MASK_VALUE, name: "Jane" });
  });

  it("masks nested keys recursively", () => {
    const out = mask(
      {
        user: { email: "a@b.com", password: "p" },
        payment: { token: "tok_123", amount: 10 },
      },
      ["password", "token"],
    );
    expect(out).toEqual({
      user: { email: "a@b.com", password: DEFAULT_MASK_VALUE },
      payment: { token: DEFAULT_MASK_VALUE, amount: 10 },
    });
  });

  it("masks keys inside arrays of objects", () => {
    const out = mask(
      { users: [{ password: "a" }, { password: "b", name: "x" }] },
      ["password"],
    );
    expect(out).toEqual({
      users: [{ password: DEFAULT_MASK_VALUE }, { password: DEFAULT_MASK_VALUE, name: "x" }],
    });
  });

  it("is case-insensitive", () => {
    const out = mask({ Password: "p", TOKEN: "t" }, ["password", "token"]);
    expect(out).toEqual({ Password: DEFAULT_MASK_VALUE, TOKEN: DEFAULT_MASK_VALUE });
  });

  it("supports custom mask value", () => {
    const out = mask({ pin: "1234" }, ["pin"], "***");
    expect(out).toEqual({ pin: "***" });
  });

  it("does not mutate the input", () => {
    const input = { password: "secret", nested: { token: "x" }, arr: [{ password: "p" }] };
    mask(input, ["password", "token"]);
    expect(input).toEqual({
      password: "secret",
      nested: { token: "x" },
      arr: [{ password: "p" }],
    });
  });

  it("preserves primitives and Date instances", () => {
    const d = new Date("2026-01-01T00:00:00.000Z");
    const out = mask({ at: d, n: 1, b: true, s: "ok", n2: null }, []);
    expect(out.at).toEqual(d);
    expect(out.at).not.toBe(d);
    expect(out.n).toBe(1);
    expect(out.b).toBe(true);
    expect(out.s).toBe("ok");
    expect(out.n2).toBeNull();
  });

  it("handles empty objects and arrays", () => {
    expect(mask({}, ["password"])).toEqual({});
    expect(mask([], ["password"])).toEqual([]);
    expect(mask({ empty: {}, arr: [] }, ["password"])).toEqual({ empty: {}, arr: [] });
  });

  it("is cycle-safe (does not hang on circular references)", () => {
    const obj: Record<string, unknown> = { name: "root", password: "p" };
    obj.self = obj;
    const out = mask(obj, ["password"]) as Record<string, unknown>;
    expect(out.name).toBe("root");
    expect(out.password).toBe(DEFAULT_MASK_VALUE);
    // The circular ref becomes a reference to the clone itself.
    expect(out.self).toBe(out);
  });

  it("preserves shared subtrees as the same reference", () => {
    const shared = { password: "secret" };
    const input = { a: shared, b: shared };
    const out = mask(input, ["password"]) as { a: object; b: object };
    expect(out.a).toBe(out.b);
    expect(out.a).toEqual({ password: DEFAULT_MASK_VALUE });
  });
});
