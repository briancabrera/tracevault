/**
 * Public entry point for the Tracevault Read API (`tracevault/query`).
 *
 * Separate from the write API on purpose: a process might only need read
 * access (a dashboard, a replay tool, an admin panel), and shouldn't have
 * to pull in queueing/mask-config types it doesn't use.
 */

export { createTracevaultQuery } from "./query.js";

export type {
  AuditCountFilters,
  AuditQueryFilters,
  AuditRecord,
  TracevaultQuery,
  TracevaultQueryConfig,
  TracevaultQueryScopeOverrides,
} from "./types.js";

// Re-export the shared error hierarchy so consumers of the query entry
// point can `catch (err) { if (err instanceof ValidationError) ... }`
// without also importing the write entry.
export {
  ConfigError,
  DriverError,
  TracevaultError,
  ValidationError,
} from "../core/errors.js";
