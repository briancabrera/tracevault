import pg from "pg";

import { createTracevault } from "../../src/index.js";
import type { Tracevault, TracevaultConfig } from "../../src/types/index.js";

const { Client } = pg;

export const CONN_STRING =
  process.env.TEST_DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5433/tracevault_test";

export const TABLE = "audit_logs";

export interface AuditLogRow {
  id: string;
  event: string;
  actor_id: string | null;
  actor_type: string | null;
  target_id: string | null;
  target_type: string | null;
  data: Record<string, unknown> | null;
  meta: Record<string, unknown> | null;
  mode: "sync" | "async";
  occurred_at: Date;
  created_at: Date;
  correlation_id: string | null;
  request_id: string | null;
  environment: string | null;
  outcome: string | null;
  error_code: string | null;
  severity: string | null;
}

export async function createDbClient(): Promise<pg.Client> {
  const client = new Client({ connectionString: CONN_STRING });
  await client.connect();
  return client;
}

export async function selectAll(
  client: pg.Client,
  table: string = TABLE,
): Promise<AuditLogRow[]> {
  const res = await client.query<AuditLogRow>(
    `SELECT * FROM "${table}" ORDER BY occurred_at ASC, created_at ASC`,
  );
  return res.rows;
}

export async function selectRaw(
  client: pg.Client,
  table: string = TABLE,
): Promise<Array<{ data: string | null; meta: string | null }>> {
  const res = await client.query<{ data: string | null; meta: string | null }>(
    `SELECT data::text AS data, meta::text AS meta FROM "${table}"`,
  );
  return res.rows;
}

export async function truncate(client: pg.Client, table: string = TABLE): Promise<void> {
  await client.query(`TRUNCATE TABLE "${table}"`);
}

/** Build a fresh Tracevault pointing at the test database. */
export function newAudit(overrides: Partial<TracevaultConfig> = {}): Tracevault {
  return createTracevault({
    driver: "postgres",
    connectionString: CONN_STRING,
    tableName: TABLE,
    ...overrides,
  });
}
