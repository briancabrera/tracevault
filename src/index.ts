export {
  startTracevault,
  type TracevaultApp,
  type TracevaultAppQuery,
  type TracevaultScopeHandle,
} from "./core/start-tracevault.js";
export {
  ConfigError,
  DriverError,
  TracevaultError,
  ValidationError,
} from "./core/errors.js";
export { computeDiff } from "./core/differ.js";
export { mask, DEFAULT_MASK_VALUE } from "./core/masker.js";
export { generateInitSql } from "./core/schema.js";
export {
  randomCorrelationId,
  readCorrelationIdHeader,
  resolveCorrelationId,
} from "./core/correlation.js";
export { assertValidScopeName, assertValidTableName } from "./core/validator.js";

export type {
  AuditActor,
  AuditDiffEvent,
  AuditDriver,
  AuditEvent,
  AuditMode,
  AuditTarget,
  Diff,
  DiffEntry,
  PersistedRecord,
  StartTracevaultBootstrap,
  StartTracevaultOptions,
  Tracevault,
  TracevaultConfig,
  TracevaultScopeOverrides,
  TracevaultScopeTableConfig,
  TracevaultScopesMap,
} from "./types/index.js";

export type {
  AuditCountFilters,
  AuditQueryFilters,
  AuditRecord,
  TracevaultQuery,
  TracevaultQueryScopeOverrides,
} from "./query/types.js";

export {
  DOCUMENTED_SEVERITY_LEVELS,
  SEVERITIES_FOR_ERRORS_ONLY_FILTER,
} from "./query/severity.js";
export type { DocumentedSeverity } from "./query/severity.js";
