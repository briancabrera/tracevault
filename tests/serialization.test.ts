import { describe, expect, it } from "vitest";

import { ValidationError } from "../src/core/errors.js";
import { assertJsonSerializable } from "../src/core/serialization.js";

describe("assertJsonSerializable", () => {
  it("accepts plain objects with primitives and Dates", () => {
    expect(() =>
      assertJsonSerializable(
        {
          s: "x",
          n: 1,
          b: true,
          d: new Date("2026-01-01"),
          nested: { arr: [1, "two", null, { inner: true }] },
          empty: {},
          emptyArr: [],
          nul: null,
        },
        "data",
      ),
    ).not.toThrow();
  });

  it("rejects BigInt", () => {
    expect(() => assertJsonSerializable({ big: 1n }, "data")).toThrow(ValidationError);
  });

  it("rejects functions", () => {
    expect(() => assertJsonSerializable({ fn: () => 1 }, "data")).toThrow(ValidationError);
  });

  it("rejects symbols", () => {
    expect(() => assertJsonSerializable({ s: Symbol("x") }, "data")).toThrow(ValidationError);
  });

  it("rejects undefined inside objects", () => {
    expect(() => assertJsonSerializable({ u: undefined }, "data")).toThrow(ValidationError);
  });

  it("rejects NaN and Infinity", () => {
    expect(() => assertJsonSerializable({ n: NaN }, "data")).toThrow(ValidationError);
    expect(() => assertJsonSerializable({ n: Infinity }, "data")).toThrow(ValidationError);
  });

  it("rejects circular references", () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj;
    expect(() => assertJsonSerializable(obj, "data")).toThrow(/circular/);
  });

  it("rejects class instances (non-plain objects)", () => {
    class Foo {
      x = 1;
    }
    expect(() => assertJsonSerializable({ foo: new Foo() }, "data")).toThrow(/plain object/);
  });

  it("rejects Map and Set", () => {
    expect(() => assertJsonSerializable({ m: new Map() }, "data")).toThrow(ValidationError);
    expect(() => assertJsonSerializable({ s: new Set() }, "data")).toThrow(ValidationError);
  });

  it("rejects invalid Date", () => {
    expect(() => assertJsonSerializable({ d: new Date("invalid") }, "data")).toThrow(/invalid Date/);
  });

  it("points at the offending path in the error message", () => {
    try {
      assertJsonSerializable({ a: { b: [{ c: 1n }] } }, "data");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as Error).message).toContain("data.a.b[0].c");
    }
  });
});
