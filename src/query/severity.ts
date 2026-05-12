/**
 * Documented severity scale (least → most important for alerting).
 * Tracevault does not validate emit payloads against this list; it is for
 * humans, consoles, and the `errorsOnly` read filter (see README).
 */
export const DOCUMENTED_SEVERITY_LEVELS = [
  "debug",
  "info",
  "notice",
  "warning",
  "error",
  "critical",
  "fatal",
] as const;

export type DocumentedSeverity = (typeof DOCUMENTED_SEVERITY_LEVELS)[number];

/**
 * `severity` values OR-matched together with `outcome = 'failure'` when
 * `findMany` / `count` use `errorsOnly: true`.
 */
export const SEVERITIES_FOR_ERRORS_ONLY_FILTER = ["error", "critical", "fatal"] as const;
