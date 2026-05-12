import { randomUUID } from "node:crypto";

/** Same cap as optional `correlationId` on `emit` / Read API string filters. */
const MAX_CORRELATION_ID_LEN = 512;

/**
 * Generate a new RFC 4122 UUID for use as `correlationId` when the inbound
 * request has no `X-Correlation-Id` header.
 */
export function randomCorrelationId(): string {
  return randomUUID();
}

/**
 * Read a correlation id from the `x-correlation-id` HTTP header.
 *
 * @param getHeader - Case-insensitive lookup (e.g. Express `req.get`).
 * @returns `undefined` when missing, blank, or longer than the emit-side cap.
 */
export function readCorrelationIdHeader(
  getHeader: (name: string) => string | undefined,
): string | undefined {
  const raw = getHeader("x-correlation-id") ?? getHeader("X-Correlation-Id");
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > MAX_CORRELATION_ID_LEN) return undefined;
  return trimmed;
}

/**
 * Prefer the inbound correlation header when valid; otherwise a fresh UUID.
 * Typical use: one value per HTTP request / job attempt, passed to every `emit`.
 */
export function resolveCorrelationId(
  getHeader: (name: string) => string | undefined,
): string {
  return readCorrelationIdHeader(getHeader) ?? randomCorrelationId();
}
