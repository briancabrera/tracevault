export { createTracevault } from "./core/tracevault.js";
export {
  ConfigError,
  DriverError,
  TracevaultError,
  ValidationError,
} from "./core/errors.js";
export { computeDiff } from "./core/differ.js";
export { mask, DEFAULT_MASK_VALUE } from "./core/masker.js";

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
  Tracevault,
  TracevaultConfig,
} from "./types/index.js";
