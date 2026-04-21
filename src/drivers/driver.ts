import type { PersistedRecord } from "../types/index.js";

/**
 * Persistence interface implemented by each driver.
 *
 * Having a small surface area keeps the core decoupled from PostgreSQL and
 * makes it easy to add new drivers later without touching the public API.
 */
export interface AuditDriverClient {
  insert(record: PersistedRecord): Promise<void>;
  healthcheck(): Promise<boolean>;
  close(): Promise<void>;
}
