import { ConfigError, ValidationError } from "../core/errors.js";
import { assertValidTableName } from "../core/validator.js";
import type {
  AuditCountFilters,
  AuditQueryFilters,
  TracevaultQueryConfig,
  TracevaultQueryScopeOverrides,
} from "./types.js";

const VALID_DRIVERS = new Set(["postgres"]);
const VALID_MODES = new Set(["sync", "async"]);
const VALID_ORDERS = new Set(["asc", "desc"]);

const MAX_IDENTIFIER_LEN = 512;
const MAX_ENVIRONMENT_LEN = 128;
const MAX_EVENT_NAME_LEN = 255;

export const MAX_LIMIT = 500;
export const DEFAULT_LIMIT = 50;
export const DEFAULT_ORDER: "asc" | "desc" = "desc";

/**
 * Keys `scope()` is allowed to override. Mirrors the write API policy: any
 * attempt to change `driver`/`connectionString` or pass an unknown key is a
 * `ConfigError` — explicit over magic.
 */
const ALLOWED_SCOPE_OVERRIDE_KEYS = new Set<keyof TracevaultQueryScopeOverrides>([
  "tableName",
]);

/**
 * Keys accepted on `AuditQueryFilters`. Used to reject typos / unknown
 * properties up front so callers don't silently miss a filter.
 */
const ALLOWED_FILTER_KEYS = new Set<keyof AuditQueryFilters>([
  "event",
  "actorId",
  "actorType",
  "targetId",
  "targetType",
  "correlationId",
  "requestId",
  "environment",
  "mode",
  "from",
  "to",
  "limit",
  "offset",
  "order",
]);

const ALLOWED_COUNT_FILTER_KEYS = new Set<keyof AuditCountFilters>([
  "event",
  "actorId",
  "actorType",
  "targetId",
  "targetType",
  "correlationId",
  "requestId",
  "environment",
  "mode",
  "from",
  "to",
]);

// RFC 4122-ish UUID shape (hex + dashes). We accept any variant/version so
// the Read API isn't accidentally stricter than the write side.
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateQueryConfig(config: TracevaultQueryConfig): void {
  if (!config || typeof config !== "object") {
    throw new ConfigError("Tracevault query config must be an object.");
  }

  if (!config.driver) {
    throw new ConfigError("Tracevault query config: `driver` is required.");
  }

  if (!VALID_DRIVERS.has(config.driver)) {
    throw new ConfigError(
      `Tracevault query config: unsupported driver "${config.driver}". V1 only supports "postgres".`,
    );
  }

  if (
    typeof config.connectionString !== "string" ||
    config.connectionString.trim().length === 0
  ) {
    throw new ConfigError(
      "Tracevault query config: `connectionString` is required and must be a non-empty string.",
    );
  }

  if (config.tableName !== undefined) {
    assertValidTableName(config.tableName, "Tracevault query config");
  }
}

export function validateQueryScopeOverrides(overrides: unknown): void {
  if (overrides === undefined || overrides === null) return;
  if (typeof overrides !== "object" || Array.isArray(overrides)) {
    throw new ConfigError("Tracevault query scope: overrides must be a plain object.");
  }

  for (const key of Object.keys(overrides)) {
    if (key === "driver" || key === "connectionString") {
      throw new ConfigError(
        `Tracevault query scope: \`${key}\` cannot be overridden on a scope (it is inherited from the root).`,
      );
    }
    if (!ALLOWED_SCOPE_OVERRIDE_KEYS.has(key as keyof TracevaultQueryScopeOverrides)) {
      throw new ConfigError(
        `Tracevault query scope: unknown override \`${key}\`. Allowed: ${Array.from(
          ALLOWED_SCOPE_OVERRIDE_KEYS,
        ).join(", ")}.`,
      );
    }
  }

  const o = overrides as Record<string, unknown>;
  if (o.tableName !== undefined) {
    assertValidTableName(o.tableName, "Tracevault query scope");
  }
}

export function assertUuid(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string") {
    throw new ValidationError(`\`${field}\` must be a string UUID.`);
  }
  if (!UUID_REGEX.test(value)) {
    throw new ValidationError(
      `\`${field}\` must be a valid UUID (got ${JSON.stringify(value)}).`,
    );
  }
}

function assertString(
  value: unknown,
  field: string,
  maxLen: number,
): asserts value is string {
  if (typeof value !== "string") {
    throw new ValidationError(`\`${field}\` must be a string.`);
  }
  if (value.length === 0 || value.trim().length === 0) {
    throw new ValidationError(`\`${field}\` must be a non-empty, non-whitespace string.`);
  }
  if (value.length > maxLen) {
    throw new ValidationError(`\`${field}\` must be at most ${maxLen} characters.`);
  }
}

function assertDateOrIsoString(value: unknown, field: string): Date {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new ValidationError(`\`${field}\` is an invalid Date.`);
    }
    return value;
  }
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new ValidationError(`\`${field}\` must be a parseable date string.`);
    }
    return parsed;
  }
  throw new ValidationError(`\`${field}\` must be a Date or ISO string.`);
}

/**
 * Normalize and validate filters used by `findMany`.
 *
 * Returns a struct with Date-typed `from`/`to`, numeric defaults applied,
 * and every string field trimmed of wrapping whitespace so downstream SQL
 * always sees the same canonical shape.
 */
export interface NormalizedQueryFilters {
  event: string | null;
  actorId: string | null;
  actorType: string | null;
  targetId: string | null;
  targetType: string | null;
  correlationId: string | null;
  requestId: string | null;
  environment: string | null;
  mode: "sync" | "async" | null;
  from: Date | null;
  to: Date | null;
  limit: number;
  offset: number;
  order: "asc" | "desc";
}

export function validateAndNormalizeFilters(
  filters: AuditQueryFilters | undefined,
): NormalizedQueryFilters {
  if (filters === undefined || filters === null) return defaultNormalized();
  if (typeof filters !== "object" || Array.isArray(filters)) {
    throw new ValidationError("Filters must be a plain object.");
  }

  for (const key of Object.keys(filters)) {
    if (!ALLOWED_FILTER_KEYS.has(key as keyof AuditQueryFilters)) {
      throw new ValidationError(
        `Unknown filter \`${key}\`. Allowed: ${Array.from(ALLOWED_FILTER_KEYS).join(", ")}.`,
      );
    }
  }

  const base = validateSharedFilters(filters);

  let limit = DEFAULT_LIMIT;
  if (filters.limit !== undefined) {
    if (!Number.isInteger(filters.limit) || filters.limit <= 0) {
      throw new ValidationError("`limit` must be a positive integer.");
    }
    if (filters.limit > MAX_LIMIT) {
      throw new ValidationError(`\`limit\` must be at most ${MAX_LIMIT}.`);
    }
    limit = filters.limit;
  }

  let offset = 0;
  if (filters.offset !== undefined) {
    if (!Number.isInteger(filters.offset) || filters.offset < 0) {
      throw new ValidationError("`offset` must be a non-negative integer.");
    }
    offset = filters.offset;
  }

  let order: "asc" | "desc" = DEFAULT_ORDER;
  if (filters.order !== undefined) {
    if (typeof filters.order !== "string" || !VALID_ORDERS.has(filters.order)) {
      throw new ValidationError(
        `\`order\` must be "asc" or "desc", got ${JSON.stringify(filters.order)}.`,
      );
    }
    order = filters.order;
  }

  return { ...base, limit, offset, order };
}

export function validateAndNormalizeCountFilters(
  filters: AuditCountFilters | undefined,
): Omit<NormalizedQueryFilters, "limit" | "offset" | "order"> {
  if (filters === undefined || filters === null) {
    const d = defaultNormalized();
    return stripPagination(d);
  }
  if (typeof filters !== "object" || Array.isArray(filters)) {
    throw new ValidationError("Filters must be a plain object.");
  }

  for (const key of Object.keys(filters)) {
    if (!ALLOWED_COUNT_FILTER_KEYS.has(key as keyof AuditCountFilters)) {
      throw new ValidationError(
        `Unknown filter \`${key}\` for count. Allowed: ${Array.from(
          ALLOWED_COUNT_FILTER_KEYS,
        ).join(", ")}.`,
      );
    }
  }

  return validateSharedFilters(filters);
}

function validateSharedFilters(
  filters: AuditQueryFilters,
): Omit<NormalizedQueryFilters, "limit" | "offset" | "order"> {
  const n: Omit<NormalizedQueryFilters, "limit" | "offset" | "order"> = {
    event: null,
    actorId: null,
    actorType: null,
    targetId: null,
    targetType: null,
    correlationId: null,
    requestId: null,
    environment: null,
    mode: null,
    from: null,
    to: null,
  };

  if (filters.event !== undefined) {
    assertString(filters.event, "event", MAX_EVENT_NAME_LEN);
    if (/[\n\r\t\0]/.test(filters.event)) {
      throw new ValidationError("`event` must not contain newline, tab or null characters.");
    }
    n.event = filters.event;
  }
  if (filters.actorId !== undefined) {
    assertString(filters.actorId, "actorId", MAX_IDENTIFIER_LEN);
    n.actorId = filters.actorId;
  }
  if (filters.actorType !== undefined) {
    assertString(filters.actorType, "actorType", MAX_IDENTIFIER_LEN);
    n.actorType = filters.actorType;
  }
  if (filters.targetId !== undefined) {
    assertString(filters.targetId, "targetId", MAX_IDENTIFIER_LEN);
    n.targetId = filters.targetId;
  }
  if (filters.targetType !== undefined) {
    assertString(filters.targetType, "targetType", MAX_IDENTIFIER_LEN);
    n.targetType = filters.targetType;
  }
  if (filters.correlationId !== undefined) {
    assertString(filters.correlationId, "correlationId", MAX_IDENTIFIER_LEN);
    n.correlationId = filters.correlationId;
  }
  if (filters.requestId !== undefined) {
    assertString(filters.requestId, "requestId", MAX_IDENTIFIER_LEN);
    n.requestId = filters.requestId;
  }
  if (filters.environment !== undefined) {
    assertString(filters.environment, "environment", MAX_ENVIRONMENT_LEN);
    n.environment = filters.environment;
  }
  if (filters.mode !== undefined) {
    if (typeof filters.mode !== "string" || !VALID_MODES.has(filters.mode)) {
      throw new ValidationError(
        `\`mode\` must be "sync" or "async", got ${JSON.stringify(filters.mode)}.`,
      );
    }
    n.mode = filters.mode;
  }
  if (filters.from !== undefined) {
    n.from = assertDateOrIsoString(filters.from, "from");
  }
  if (filters.to !== undefined) {
    n.to = assertDateOrIsoString(filters.to, "to");
  }
  if (n.from && n.to && n.from.getTime() > n.to.getTime()) {
    throw new ValidationError(
      "`from` must be less than or equal to `to` (empty range is allowed but reversed is a bug).",
    );
  }

  return n;
}

function defaultNormalized(): NormalizedQueryFilters {
  return {
    event: null,
    actorId: null,
    actorType: null,
    targetId: null,
    targetType: null,
    correlationId: null,
    requestId: null,
    environment: null,
    mode: null,
    from: null,
    to: null,
    limit: DEFAULT_LIMIT,
    offset: 0,
    order: DEFAULT_ORDER,
  };
}

function stripPagination(
  n: NormalizedQueryFilters,
): Omit<NormalizedQueryFilters, "limit" | "offset" | "order"> {
  const {
    limit: _limit,
    offset: _offset,
    order: _order,
    ...rest
  } = n;
  void _limit;
  void _offset;
  void _order;
  return rest;
}
