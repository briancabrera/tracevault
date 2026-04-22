import type {
  AuditActor,
  AuditDiffEvent,
  AuditEvent,
  AuditTarget,
  TracevaultConfig,
  TracevaultScopeOverrides,
} from "../types/index.js";
import { ConfigError, ValidationError } from "./errors.js";
import { assertJsonSerializable } from "./serialization.js";

const VALID_MODES = new Set(["sync", "async"]);
const VALID_DRIVERS = new Set(["postgres"]);

/** Hard upper bounds to keep payloads sane. Intentionally generous. */
const MAX_EVENT_NAME_LEN = 255;
const MAX_IDENTIFIER_LEN = 512;
const MAX_ENVIRONMENT_LEN = 128;
const MAX_TABLE_NAME_LEN = 63; // PostgreSQL identifier limit

const TABLE_NAME_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Fields the `scope()` method is allowed to override. Any other key — and
 * crucially `driver` / `connectionString` — causes a `ConfigError`.
 */
const ALLOWED_SCOPE_OVERRIDE_KEYS = new Set<keyof TracevaultScopeOverrides>([
  "tableName",
  "defaultMode",
  "environment",
  "maskFields",
  "maskValue",
  "onError",
  "asyncBatchSize",
  "asyncFlushIntervalMs",
]);

/**
 * Validate a table name against Tracevault's strict policy.
 *
 * Exported because both `validateConfig`, `validateScopeOverrides` and the
 * `generateInitSql` utility must apply the exact same rule.
 */
export function assertValidTableName(value: unknown, context: string): asserts value is string {
  if (typeof value !== "string") {
    throw new ConfigError(`${context}: \`tableName\` must be a string.`);
  }
  if (value.length === 0 || value.length > MAX_TABLE_NAME_LEN) {
    throw new ConfigError(
      `${context}: \`tableName\` length must be between 1 and ${MAX_TABLE_NAME_LEN}.`,
    );
  }
  if (!TABLE_NAME_REGEX.test(value)) {
    throw new ConfigError(
      `${context}: \`tableName\` must match /^[A-Za-z_][A-Za-z0-9_]*$/ (letters, digits, underscores; no leading digit).`,
    );
  }
}

export function validateConfig(config: TracevaultConfig): void {
  if (!config || typeof config !== "object") {
    throw new ConfigError("Tracevault config must be an object.");
  }

  if (!config.driver) {
    throw new ConfigError("Tracevault config: `driver` is required.");
  }

  if (!VALID_DRIVERS.has(config.driver)) {
    throw new ConfigError(
      `Tracevault config: unsupported driver "${config.driver}". V1 only supports "postgres".`,
    );
  }

  if (typeof config.connectionString !== "string" || config.connectionString.trim().length === 0) {
    throw new ConfigError(
      "Tracevault config: `connectionString` is required and must be a non-empty string.",
    );
  }

  if (config.tableName !== undefined) {
    assertValidTableName(config.tableName, "Tracevault config");
  }

  if (config.defaultMode !== undefined && !VALID_MODES.has(config.defaultMode)) {
    throw new ConfigError(
      `Tracevault config: \`defaultMode\` must be "sync" or "async", got "${String(config.defaultMode)}".`,
    );
  }

  if (config.maskFields !== undefined) {
    assertValidMaskFields(config.maskFields, "Tracevault config");
  }

  if (config.maskValue !== undefined && typeof config.maskValue !== "string") {
    throw new ConfigError("Tracevault config: `maskValue` must be a string.");
  }

  if (config.environment !== undefined) {
    assertValidEnvironment(config.environment, "Tracevault config");
  }

  if (config.onError !== undefined && typeof config.onError !== "function") {
    throw new ConfigError("Tracevault config: `onError` must be a function.");
  }

  if (config.asyncBatchSize !== undefined) {
    if (!Number.isInteger(config.asyncBatchSize) || config.asyncBatchSize <= 0) {
      throw new ConfigError("Tracevault config: `asyncBatchSize` must be a positive integer.");
    }
  }

  if (config.asyncFlushIntervalMs !== undefined) {
    if (!Number.isFinite(config.asyncFlushIntervalMs) || config.asyncFlushIntervalMs < 0) {
      throw new ConfigError(
        "Tracevault config: `asyncFlushIntervalMs` must be a non-negative finite number.",
      );
    }
  }
}

/**
 * Validate the overrides passed to `scope()`. Rejects unknown keys and
 * explicitly rejects attempts to override `driver` / `connectionString`.
 */
export function validateScopeOverrides(overrides: unknown): void {
  if (overrides === undefined || overrides === null) return;
  if (typeof overrides !== "object" || Array.isArray(overrides)) {
    throw new ConfigError("Tracevault scope: overrides must be a plain object.");
  }

  for (const key of Object.keys(overrides)) {
    if (key === "driver" || key === "connectionString") {
      throw new ConfigError(
        `Tracevault scope: \`${key}\` cannot be overridden on a scope (it is inherited from the root).`,
      );
    }
    if (!ALLOWED_SCOPE_OVERRIDE_KEYS.has(key as keyof TracevaultScopeOverrides)) {
      throw new ConfigError(
        `Tracevault scope: unknown override \`${key}\`. Allowed: ${Array.from(
          ALLOWED_SCOPE_OVERRIDE_KEYS,
        ).join(", ")}.`,
      );
    }
  }

  const o = overrides as Record<string, unknown>;

  if (o.tableName !== undefined) {
    assertValidTableName(o.tableName, "Tracevault scope");
  }

  if (o.defaultMode !== undefined && (typeof o.defaultMode !== "string" || !VALID_MODES.has(o.defaultMode))) {
    throw new ConfigError(
      `Tracevault scope: \`defaultMode\` must be "sync" or "async", got "${String(o.defaultMode)}".`,
    );
  }

  if (o.maskFields !== undefined) {
    assertValidMaskFields(o.maskFields, "Tracevault scope");
  }

  if (o.maskValue !== undefined && typeof o.maskValue !== "string") {
    throw new ConfigError("Tracevault scope: `maskValue` must be a string.");
  }

  if (o.environment !== undefined) {
    assertValidEnvironment(o.environment, "Tracevault scope");
  }

  if (o.onError !== undefined && typeof o.onError !== "function") {
    throw new ConfigError("Tracevault scope: `onError` must be a function.");
  }

  if (o.asyncBatchSize !== undefined) {
    if (!Number.isInteger(o.asyncBatchSize) || (o.asyncBatchSize as number) <= 0) {
      throw new ConfigError("Tracevault scope: `asyncBatchSize` must be a positive integer.");
    }
  }

  if (o.asyncFlushIntervalMs !== undefined) {
    if (!Number.isFinite(o.asyncFlushIntervalMs) || (o.asyncFlushIntervalMs as number) < 0) {
      throw new ConfigError(
        "Tracevault scope: `asyncFlushIntervalMs` must be a non-negative finite number.",
      );
    }
  }
}

function assertValidMaskFields(value: unknown, context: string): void {
  if (!Array.isArray(value)) {
    throw new ConfigError(`${context}: \`maskFields\` must be an array of strings.`);
  }
  for (const field of value) {
    if (typeof field !== "string" || field.length === 0) {
      throw new ConfigError(
        `${context}: every \`maskFields\` entry must be a non-empty string.`,
      );
    }
  }
}

function assertValidEnvironment(value: unknown, context: string): void {
  if (typeof value !== "string") {
    throw new ConfigError(`${context}: \`environment\` must be a string.`);
  }
  if (value.length > MAX_ENVIRONMENT_LEN) {
    throw new ConfigError(
      `${context}: \`environment\` must be at most ${MAX_ENVIRONMENT_LEN} characters.`,
    );
  }
}

function validateEventName(name: unknown): void {
  if (typeof name !== "string") {
    throw new ValidationError("`event` must be a string.");
  }
  if (name.length === 0 || name.trim().length === 0) {
    throw new ValidationError("`event` must be a non-empty, non-whitespace string.");
  }
  if (name.length > MAX_EVENT_NAME_LEN) {
    throw new ValidationError(`\`event\` must be at most ${MAX_EVENT_NAME_LEN} characters.`);
  }
  if (/[\n\r\t\0]/.test(name)) {
    throw new ValidationError("`event` must not contain newline, tab or null characters.");
  }
}

function validateIdentity(value: AuditActor | AuditTarget, field: "actor" | "target"): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ValidationError(`\`${field}\` must be an object with { id, type }.`);
  }
  for (const key of ["id", "type"] as const) {
    const v = value[key];
    if (typeof v !== "string") {
      throw new ValidationError(`\`${field}.${key}\` must be a string.`);
    }
    if (v.length === 0 || v.trim().length === 0) {
      throw new ValidationError(`\`${field}.${key}\` must be non-empty.`);
    }
    if (v.length > MAX_IDENTIFIER_LEN) {
      throw new ValidationError(
        `\`${field}.${key}\` must be at most ${MAX_IDENTIFIER_LEN} characters.`,
      );
    }
  }
}

function validateOccurredAt(occurredAt: unknown): void {
  if (occurredAt instanceof Date) {
    if (Number.isNaN(occurredAt.getTime())) {
      throw new ValidationError("`occurredAt` is an invalid Date.");
    }
    return;
  }
  if (typeof occurredAt === "string") {
    const parsed = new Date(occurredAt);
    if (Number.isNaN(parsed.getTime())) {
      throw new ValidationError("`occurredAt` must be a parseable date string.");
    }
    return;
  }
  throw new ValidationError("`occurredAt` must be a Date or ISO string.");
}

function validateOptionalString(value: unknown, field: string, maxLen = MAX_IDENTIFIER_LEN): void {
  if (value === undefined) return;
  if (typeof value !== "string") {
    throw new ValidationError(`\`${field}\` must be a string.`);
  }
  if (value.length === 0) {
    throw new ValidationError(`\`${field}\` must not be an empty string (use undefined instead).`);
  }
  if (value.length > maxLen) {
    throw new ValidationError(`\`${field}\` must be at most ${maxLen} characters.`);
  }
}

function validatePlainObjectField(value: unknown, field: string): void {
  if (value === undefined || value === null) return;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError(`\`${field}\` must be a plain object.`);
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new ValidationError(`\`${field}\` must be a plain object (no class instances).`);
  }
  assertJsonSerializable(value, field);
}

function validateMode(mode: unknown): void {
  if (mode === undefined) return;
  if (typeof mode !== "string" || !VALID_MODES.has(mode)) {
    throw new ValidationError(`\`mode\` must be "sync" or "async", got ${JSON.stringify(mode)}.`);
  }
}

export function validateEvent(event: AuditEvent): void {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw new ValidationError("Event must be a plain object.");
  }
  validateEventName(event.event);
  if (event.actor !== undefined) validateIdentity(event.actor, "actor");
  if (event.target !== undefined) validateIdentity(event.target, "target");
  validateMode(event.mode);
  if (event.occurredAt !== undefined) validateOccurredAt(event.occurredAt);
  validateOptionalString(event.correlationId, "correlationId");
  validateOptionalString(event.requestId, "requestId");
  validateOptionalString(event.environment, "environment", MAX_ENVIRONMENT_LEN);
  validatePlainObjectField(event.data, "data");
  validatePlainObjectField(event.meta, "meta");
}

export function validateDiffEvent(event: AuditDiffEvent): void {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw new ValidationError("Diff event must be a plain object.");
  }
  validateEventName(event.event);
  if (event.actor !== undefined) validateIdentity(event.actor, "actor");
  if (event.target !== undefined) validateIdentity(event.target, "target");
  validateMode(event.mode);
  if (event.occurredAt !== undefined) validateOccurredAt(event.occurredAt);
  validateOptionalString(event.correlationId, "correlationId");
  validateOptionalString(event.requestId, "requestId");
  validateOptionalString(event.environment, "environment", MAX_ENVIRONMENT_LEN);
  validatePlainObjectField(event.before, "before");
  validatePlainObjectField(event.after, "after");
  validatePlainObjectField(event.meta, "meta");
}
