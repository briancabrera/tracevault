import { createHash } from "node:crypto";

import { SchemaUpgradeError } from "./errors.js";
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
  /** Path of the source value inside `data`, as a `#>>` text-array literal. */
  path: string;
  maxLength: number;
  definition: string;
}

function generatedColumn(name: string, path: string, maxLength: number): GeneratedColumn {
  return {
    name,
    path,
    maxLength,
    definition: `VARCHAR(${maxLength}) GENERATED ALWAYS AS (
    NULLIF(BTRIM(${path === "{error,code}" ? "data->'error'->>'code'" : `data->>'${name}'`}), '')
  ) STORED`,
  };
}

const GENERATED_COLUMNS: readonly GeneratedColumn[] = [
  generatedColumn("outcome", "{outcome}", 64),
  generatedColumn("error_code", "{error,code}", 255),
  generatedColumn("severity", "{severity}", 32),
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
    await assertNoOversizedValues(executor, t, missing);
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
 * Rows written before the generated columns existed may hold values longer
 * than the new VARCHAR, which would make `ADD COLUMN` fail with a bare
 * "value too long". Detect them first and explain how to fix them.
 */
async function assertNoOversizedValues(
  executor: SqlExecutor,
  t: string,
  columns: readonly GeneratedColumn[],
): Promise<void> {
  const counts = columns
    .map(
      (c) =>
        `count(*) FILTER (WHERE length(BTRIM(data #>> '${c.path}')) > ${c.maxLength}) AS "${c.name}"`,
    )
    .join(", ");
  const { rows } = await executor.query(`SELECT ${counts} FROM "${t}"`);
  const found = (rows[0] ?? {}) as Record<string, string | number>;
  const problems = columns.filter((c) => Number(found[c.name]) > 0);
  if (problems.length === 0) return;

  const detail = problems
    .map((c) => {
      const where = `length(BTRIM(data #>> '${c.path}')) > ${c.maxLength}`;
      // Sibling key, so nothing in the audit payload is lost (works for objects too).
      const keepPath = c.path.replace(/\}$/, "_original}");
      const keep = keepPath.slice(1, -1).replace(",", ".");
      return (
        `  - ${Number(found[c.name])} row(s) with data#>>'${c.path}' longer than ${c.maxLength} chars ` +
        `(column "${c.name}"). Fix, e.g. (keeps the original under "${keep}"):\n` +
        `      UPDATE "${t}" SET data = jsonb_set(jsonb_set(data, '${keepPath}', data #> '${c.path}'), ` +
        `'${c.path}', to_jsonb(left(BTRIM(data #>> '${c.path}'), ${c.maxLength}))) WHERE ${where};`
      );
    })
    .join("\n");
  throw new SchemaUpgradeError(
    `Tracevault: cannot add generated columns to "${t}"; existing rows hold values that do not fit:\n` +
      `${detail}\nNo schema change was applied.`,
  );
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
