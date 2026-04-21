import type { Diff } from "../types/index.js";

/**
 * Compute a shallow-by-key diff between two objects.
 *
 * For each key present in either `before` or `after`:
 * - if values are deeply equal, it is skipped
 * - otherwise both sides are included as `{ before, after }`
 *
 * Deep equality is intentionally simple (JSON-structural) — this library is
 * for audit events, not for diffing arbitrary object graphs. Objects with
 * cycles, functions, or class instances should be serialized by the caller.
 */
export function computeDiff(
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
): Diff {
  const a = before ?? {};
  const b = after ?? {};
  const keys = new Set<string>([...Object.keys(a), ...Object.keys(b)]);
  const diff: Diff = {};

  for (const key of keys) {
    const beforeValue = a[key];
    const afterValue = b[key];
    if (!deepEqual(beforeValue, afterValue)) {
      diff[key] = { before: beforeValue, after: afterValue };
    }
  }

  return diff;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;

  if (a instanceof Date && b instanceof Date) {
    return a.getTime() === b.getTime();
  }

  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }

  if (typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    if (ka.length !== kb.length) return false;
    for (const k of ka) {
      if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
      if (!deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
    }
    return true;
  }

  return false;
}
