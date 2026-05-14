import { assertValidTableName } from "./validator.js";

/**
 * Ordered DDL statements for one audit table (idempotent).
 * Shared by `generateInitSql` and runtime schema bootstrap.
 */
export function auditTableDdlStatements(tableName: string): readonly string[] {
  assertValidTableName(tableName, "auditTableDdlStatements");
  const t = tableName;
  return [
    `CREATE TABLE IF NOT EXISTS "${t}" (
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
  outcome         VARCHAR(64) GENERATED ALWAYS AS (
    NULLIF(BTRIM(data->>'outcome'), '')
  ) STORED,
  error_code      VARCHAR(255) GENERATED ALWAYS AS (
    NULLIF(BTRIM(data->'error'->>'code'), '')
  ) STORED,
  severity        VARCHAR(32) GENERATED ALWAYS AS (
    NULLIF(BTRIM(data->>'severity'), '')
  ) STORED
)`,
    `CREATE INDEX IF NOT EXISTS idx_${t}_event        ON "${t}" (event)`,
    `CREATE INDEX IF NOT EXISTS idx_${t}_actor        ON "${t}" (actor_id, actor_type)`,
    `CREATE INDEX IF NOT EXISTS idx_${t}_target       ON "${t}" (target_id, target_type)`,
    `CREATE INDEX IF NOT EXISTS idx_${t}_occurred_at  ON "${t}" (occurred_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${t}_correlation_occurred_id
  ON "${t}" (correlation_id, occurred_at DESC, id DESC)
  WHERE correlation_id IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_${t}_error_code_occurred
  ON "${t}" (error_code, occurred_at DESC)
  WHERE error_code IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_${t}_outcome_occurred
  ON "${t}" (outcome, occurred_at DESC)
  WHERE outcome IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_${t}_severity_occurred
  ON "${t}" (severity, occurred_at DESC)
  WHERE severity IS NOT NULL`,
  ];
}

export function auditTableDdlScript(tableName: string): string {
  return auditTableDdlStatements(tableName).join(";\n\n") + ";";
}

export interface SqlExecutor {
  query(sql: string): Promise<unknown>;
}

/** Run all idempotent DDL statements for one table (bootstrap / migrations). */
export async function ensureAuditTableSchema(
  executor: SqlExecutor,
  tableName: string,
): Promise<void> {
  for (const stmt of auditTableDdlStatements(tableName)) {
    await executor.query(stmt);
  }
}
