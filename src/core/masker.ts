export const DEFAULT_MASK_VALUE = "[REDACTED]";

/**
 * Recursively mask any field whose key appears in `maskFields`.
 *
 * Guarantees:
 * - the input object is never mutated (returns a deep clone)
 * - matches keys case-insensitively (`password` ≡ `Password`)
 * - works on plain objects, arrays, nulls, primitives, and Dates
 * - cycle-safe: already-visited objects are replaced by the mask value to
 *   avoid infinite recursion (validator rejects cycles upstream anyway;
 *   this is defense-in-depth)
 * - non-plain objects (class instances, Map, Set, etc.) are cloned only
 *   as deep as Object.entries reveals; callers should feed plain JSON data
 */
export function mask<T>(value: T, maskFields: readonly string[], maskValue = DEFAULT_MASK_VALUE): T {
  const lowered =
    maskFields.length === 0 ? EMPTY_SET : new Set(maskFields.map((f) => f.toLowerCase()));
  return walk(value, lowered, maskValue, new WeakMap()) as T;
}

const EMPTY_SET: ReadonlySet<string> = new Set();

function walk(
  value: unknown,
  masked: ReadonlySet<string>,
  maskValue: string,
  seen: WeakMap<object, unknown>,
): unknown {
  if (value === null || value === undefined) return value;

  const t = typeof value;
  if (t !== "object") return value;

  const obj = value as object;

  if (obj instanceof Date) return new Date(obj.getTime());

  const cached = seen.get(obj);
  if (cached !== undefined) return cached;

  if (Array.isArray(obj)) {
    const out: unknown[] = [];
    seen.set(obj, out);
    for (const item of obj) {
      out.push(walk(item, masked, maskValue, seen));
    }
    return out;
  }

  const out: Record<string, unknown> = {};
  seen.set(obj, out);
  for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
    if (masked.has(key.toLowerCase())) {
      out[key] = maskValue;
    } else {
      out[key] = walk(val, masked, maskValue, seen);
    }
  }
  return out;
}
