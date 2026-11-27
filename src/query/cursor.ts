import { ValidationError } from "../core/errors.js";

/** Position of the last row of a page: `occurred_at` (UTC, microseconds) and `id`. */
export interface PageCursor {
  ts: string;
  id: string;
  order: "asc" | "desc";
}

const TS_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}$/;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeCursor(cursor: PageCursor): string {
  const json = JSON.stringify({ t: cursor.ts, i: cursor.id, o: cursor.order });
  return Buffer.from(json, "utf8").toString("base64url");
}

export function decodeCursor(value: unknown): PageCursor {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw new ValidationError("`cursor` must be a `nextCursor` string returned by `findPage`.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    parsed = null;
  }
  const c = parsed as { t?: unknown; i?: unknown; o?: unknown } | null;
  if (
    !c ||
    typeof c.t !== "string" ||
    !TS_REGEX.test(c.t) ||
    typeof c.i !== "string" ||
    !UUID_REGEX.test(c.i) ||
    (c.o !== "asc" && c.o !== "desc")
  ) {
    throw new ValidationError("`cursor` is malformed; pass a `nextCursor` returned by `findPage`.");
  }
  return { ts: c.t, id: c.i, order: c.o };
}
