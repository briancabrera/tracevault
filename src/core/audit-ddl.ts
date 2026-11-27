import { createHash } from "node:crypto";

import { assertValidTableName } from "./validator.js";

/** PostgreSQL truncates identifiers longer than this (NAMEDATALEN - 1). */
const PG_MAX_IDENTIFIER_LEN = 63;

/**
 * Session-level advisory lock key that serializes schema bootstrap across
 * processes, so N replicas starting at once don't race on `CREATE TABLE`.
 */
export const SCHEMA_BOOTSTRAP_LOCK_KEY = "7740323601894170113";

/**
 * Index name for `tableName`. Keeps the historical `idx_<table>_<suffix>` name
 * when it fits in 63 chars; otherwise shortens the table part and adds a hash
 * so distinct indexes never collapse into the same truncated name.
 */
export function auditIndexName(tableName: string, suffix: string): string {
  const plain = `idx_${tableName}_${suffix}`;
  if (plain.length <= PG_MAX_IDENTIFIER_LEN) return plain;
  const hash = createHash("sha256").update(tableName).digest("hex").slice(0, 8);
  const room = PG_MAX_IDENTIFIER_LEN - `idx__${hash}_${suffix}`.length;
  return `idx_${tableName.slice(0, room)}_${hash}_${suffix}`;
}

interface GeneratedColumn {
  name: string;
  definition: string;
}

const GENERATED_COLUMNS: readonly GeneratedColumn[] = [
  {
    name: "outcome",
    definition: `VARCHAR(64) GENERATED ALWAYS AS (
    NULLIF(BTRIM(data->>'outcome'), '')
  ) STORED`,
  },
  {
    name: "error_code",
    definition: `VARCHAR(255) GENERATED ALWAYS AS (
    NULLIF(BTRIM(data->'error'->>'code'), '')
  ) STORED`,
  },
  {
    name: "severity",
    definition: `VARCHAR(32) GENERATED ALWAYS AS (
    NULLIF(BTRIM(data->>'severity'), '')
  ) STORED`,
  },
];

function createTableStatement(t: string): string {
  const generated = GENERATED_COLUMNS.map((c) => `  ${c.name.padEnd(15)} ${c.definition}`).join(
    ",\n",
  );
  return `CREATE TABLE IF NOT EXISTS "${t}" (
  id              UUID        PRIMARY KEY,
  event           VARCHAR     NOT NULL,
  actor_id        VARCHAR     NULL,
  actor_type      VARCHAR     NULL,
  target_id       VARCHAR     NULL,
  target_type     VARCHAR     NULL,
  data            JSONB       NULL,
  meta            JSONB       NULL,
  mode            VARCHAR     NOT NULL,
  occurred_at     TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  correlation_id  VARCHAR     NULL,
  request_id      VARCHAR     NULL,
  environment     VARCHAR     NULL,
${generated}
)`;
}

function indexStatements(t: string): string[] {
  const idx = (suffix: string) => auditIndexName(t, suffix);
  return [
    `CREATE INDEX IF NOT EXISTS ${idx("event")}        ON "${t}" (event)`,
    `CREATE INDEX IF NOT EXISTS ${idx("actor")}        ON "${t}" (actor_id, actor_type)`,
    `CREATE INDEX IF NOT EXISTS ${idx("target")}       ON "${t}" (target_id, target_type)`,
    `CREATE INDEX IF NOT EXISTS ${idx("occurred_at")}  ON "${t}" (occurred_at DESC)`,
    `CREATE INDEX IF NOT EXISTS ${idx("correlation_occurred_id")}
  ON "${t}" (correlation_id, occurred_at DESC, id DESC)
  WHERE correlation_id IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS ${idx("error_code_occurred")}
  ON "${t}" (error_code, occurred_at DESC)
  WHERE error_code IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS ${idx("outcome_occurred")}
  ON "${t}" (outcome, occurred_at DESC)
  WHERE outcome IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS ${idx("severity_occurred")}
  ON "${t}" (severity, occurred_at DESC)
  WHERE severity IS NOT NULL`,
  ];
}

/**
 * Ordered DDL statements for one audit table (idempotent).
 * Used by `generateInitSql`; runtime bootstrap uses `ensureAuditTableSchema`.
 */
export function auditTableDdlStatements(tableName: string): readonly string[] {
  assertValidTableName(tableName, "auditTableDdlStatements");
  return [createTableStatement(tableName), ...indexStatements(tableName)];
}

export function auditTableDdlScript(tableName: string): string {
  return auditTableDdlStatements(tableName).join(";\n\n") + ";";
}

export interface SqlExecutor {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

/**
 * Bring one table up to the current schema (idempotent).
 *
 * Tables created by older releases (e.g. only `sql/001`) get the missing
 * generated columns added before any index that depends on them. Columns are
 * only altered when actually missing, so a no-op startup never takes an
 * `ACCESS EXCLUSIVE` lock on the audit table.
 */
export async function ensureAuditTableSchema(
  executor: SqlExecutor,
  tableName: string,
): Promise<void> {
  assertValidTableName(tableName, "ensureAuditTableSchema");
  const t = tableName;
  await executor.query(createTableStatement(t));

  const { rows } = await executor.query(
    `SELECT attname FROM pg_attribute
     WHERE attrelid = to_regclass($1) AND attnum > 0 AND NOT attisdropped`,
    [`"${t}"`],
  );
  const existing = new Set((rows as Array<{ attname: string }>).map((r) => r.attname));
  const missing = GENERATED_COLUMNS.filter((c) => !existing.has(c.name));
  if (missing.length > 0) {
    await executor.query(
      `ALTER TABLE "${t}"\n` +
        missing.map((c) => `  ADD COLUMN IF NOT EXISTS ${c.name} ${c.definition}`).join(",\n"),
    );
    // Superseded by `correlation_occurred_id` (same as sql/002).
    await executor.query(`DROP INDEX IF EXISTS ${auditIndexName(t, "correlation_occurred")}`);
  }

  for (const stmt of indexStatements(t)) {
    await executor.query(stmt);
  }
}

/**
 * Ensure every table's schema, one transaction per table, each holding a
 * transaction-scoped advisory lock. Per-table commits keep DDL locks on one
 * table from blocking writes to the others. The lock is released on
 * COMMIT/ROLLBACK or when the session dies, and a transaction stays on one
 * backend under PgBouncer transaction pooling. `executor` must be a single
 * dedicated connection (not a pool).
 */
export async function bootstrapAuditSchema(
  executor: SqlExecutor,
  tableNames: readonly string[],
): Promise<void> {
  for (const tableName of new Set(tableNames)) {
    await executor.query("BEGIN");
    try {
      await executor.query("SELECT pg_advisory_xact_lock($1::bigint)", [SCHEMA_BOOTSTRAP_LOCK_KEY]);
      await ensureAuditTableSchema(executor, tableName);
      await executor.query("COMMIT");
    } catch (err) {
      await executor.query("ROLLBACK").catch(() => {});
      throw err;
    }
  }
}
