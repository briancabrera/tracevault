import { describe, expect, it } from "vitest";

import { computeDiff } from "../src/core/differ.js";

describe("computeDiff", () => {
  it("returns an empty object for identical inputs", () => {
    expect(computeDiff({ a: 1, b: "x" }, { a: 1, b: "x" })).toEqual({});
  });

  it("captures changed scalar values", () => {
    expect(
      computeDiff({ price: 120, name: "Café" }, { price: 150, name: "Café" }),
    ).toEqual({
      price: { before: 120, after: 150 },
    });
  });

  it("captures added keys", () => {
    expect(computeDiff({ a: 1 }, { a: 1, b: 2 })).toEqual({
      b: { before: undefined, after: 2 },
    });
  });

  it("captures removed keys", () => {
    expect(computeDiff({ a: 1, b: 2 }, { a: 1 })).toEqual({
      b: { before: 2, after: undefined },
    });
  });

  it("treats deeply equal nested objects as unchanged", () => {
    expect(
      computeDiff({ addr: { city: "MVD" } }, { addr: { city: "MVD" } }),
    ).toEqual({});
  });

  it("captures nested object changes as a whole entry", () => {
    expect(
      computeDiff({ addr: { city: "MVD" } }, { addr: { city: "BUE" } }),
    ).toEqual({
      addr: { before: { city: "MVD" }, after: { city: "BUE" } },
    });
  });

  it("handles missing before/after objects", () => {
    expect(computeDiff(undefined, { a: 1 })).toEqual({
      a: { before: undefined, after: 1 },
    });
    expect(computeDiff({ a: 1 }, undefined)).toEqual({
      a: { before: 1, after: undefined },
    });
  });

  it("compares arrays by index", () => {
    expect(computeDiff({ tags: ["a", "b"] }, { tags: ["a", "c"] })).toEqual({
      tags: { before: ["a", "b"], after: ["a", "c"] },
    });
  });
});
