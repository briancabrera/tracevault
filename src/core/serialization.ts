import { ValidationError } from "./errors.js";

/**
 * Walk `value` and throw a `ValidationError` if anything inside cannot be
 * safely persisted as JSON/JSONB.
 *
 * We reject explicitly rather than let `JSON.stringify` silently drop things
 * (functions, symbols, undefined inside objects) or throw opaque errors
 * (BigInt, circular references).
 *
 * Accepted shapes:
 * - `null`, strings, finite numbers, booleans
 * - `Date` instances (serialized by pg as ISO timestamps inside JSONB)
 * - plain objects `{ [k: string]: accepted }`
 * - arrays of accepted values
 */
export function assertJsonSerializable(value: unknown, field: string): void {
  walk(value, field, new WeakSet());
}

function walk(value: unknown, path: string, visited: WeakSet<object>): void {
  if (value === null) return;

  const t = typeof value;

  if (t === "string" || t === "boolean") return;

  if (t === "number") {
    if (!Number.isFinite(value as number)) {
      throw new ValidationError(`\`${path}\` contains a non-finite number (NaN/Infinity).`);
    }
    return;
  }

  if (t === "undefined") {
    throw new ValidationError(`\`${path}\` contains \`undefined\`, which is not JSON-serializable.`);
  }

  if (t === "bigint") {
    throw new ValidationError(`\`${path}\` contains a BigInt, which is not JSON-serializable.`);
  }

  if (t === "function") {
    throw new ValidationError(`\`${path}\` contains a function, which is not JSON-serializable.`);
  }

  if (t === "symbol") {
    throw new ValidationError(`\`${path}\` contains a Symbol, which is not JSON-serializable.`);
  }

  if (t === "object") {
    const obj = value as object;

    if (visited.has(obj)) {
      throw new ValidationError(`\`${path}\` contains a circular reference.`);
    }
    visited.add(obj);

    if (obj instanceof Date) {
      if (Number.isNaN(obj.getTime())) {
        throw new ValidationError(`\`${path}\` contains an invalid Date.`);
      }
      return;
    }

    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i++) {
        walk(obj[i], `${path}[${i}]`, visited);
      }
      return;
    }

    // Reject things like Map/Set/class instances with custom prototypes —
    // they serialize to `{}` via JSON.stringify which is a silent data loss.
    const proto = Object.getPrototypeOf(obj);
    if (proto !== Object.prototype && proto !== null) {
      throw new ValidationError(
        `\`${path}\` must be a plain object; got ${describeType(obj)}.`,
      );
    }

    for (const key of Object.keys(obj as Record<string, unknown>)) {
      walk((obj as Record<string, unknown>)[key], `${path}.${key}`, visited);
    }
    return;
  }

  throw new ValidationError(`\`${path}\` has an unsupported type: ${t}.`);
}

function describeType(obj: object): string {
  const name = obj.constructor?.name;
  if (name && name !== "Object") return name;
  return Object.prototype.toString.call(obj);
}
