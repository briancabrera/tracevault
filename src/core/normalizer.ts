import { randomUUID } from "node:crypto";

import type {
  AuditDiffEvent,
  AuditEvent,
  AuditMode,
  PersistedRecord,
} from "../types/index.js";
import { computeDiff } from "./differ.js";
import { mask } from "./masker.js";

export interface NormalizeOptions {
  defaultMode: AuditMode;
  defaultEnvironment: string | null;
  maskFields: readonly string[];
  maskValue: string;
}

/**
 * Convert a user-supplied `AuditEvent` into a persistable record.
 *
 * Responsibilities:
 * - assign id and `occurredAt` defaults
 * - resolve effective mode
 * - apply masking to `data` and `meta`
 * - flatten actor/target into columnar fields
 */
export function normalizeEvent(event: AuditEvent, opts: NormalizeOptions): PersistedRecord {
  const occurredAt = resolveOccurredAt(event.occurredAt);
  const mode: AuditMode = event.mode ?? opts.defaultMode;

  const data = event.data ? mask(event.data, opts.maskFields, opts.maskValue) : null;
  const meta = event.meta ? mask(event.meta, opts.maskFields, opts.maskValue) : null;

  return {
    id: randomUUID(),
    event: event.event,
    actorId: event.actor?.id ?? null,
    actorType: event.actor?.type ?? null,
    targetId: event.target?.id ?? null,
    targetType: event.target?.type ?? null,
    data,
    meta,
    mode,
    occurredAt,
    correlationId: event.correlationId ?? null,
    requestId: event.requestId ?? null,
    environment: event.environment ?? opts.defaultEnvironment,
  };
}

/**
 * Translate a diff-shaped input into a normalized record by stuffing
 * `{ before, after, diff }` inside `data`. The result is then masked and
 * normalized like any other event.
 */
export function normalizeDiffEvent(event: AuditDiffEvent, opts: NormalizeOptions): PersistedRecord {
  const diff = computeDiff(event.before, event.after);

  const data: Record<string, unknown> = {
    before: event.before ?? {},
    after: event.after ?? {},
    diff,
  };

  const normalizedEvent: AuditEvent = {
    event: event.event,
    data,
  };
  if (event.actor !== undefined) normalizedEvent.actor = event.actor;
  if (event.target !== undefined) normalizedEvent.target = event.target;
  if (event.meta !== undefined) normalizedEvent.meta = event.meta;
  if (event.correlationId !== undefined) normalizedEvent.correlationId = event.correlationId;
  if (event.requestId !== undefined) normalizedEvent.requestId = event.requestId;
  if (event.environment !== undefined) normalizedEvent.environment = event.environment;
  if (event.occurredAt !== undefined) normalizedEvent.occurredAt = event.occurredAt;
  if (event.mode !== undefined) normalizedEvent.mode = event.mode;

  return normalizeEvent(normalizedEvent, opts);
}

function resolveOccurredAt(input: Date | string | undefined): Date {
  if (input === undefined) return new Date();
  if (input instanceof Date) return input;
  return new Date(input);
}
