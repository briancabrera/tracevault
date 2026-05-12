-- Tracevault V2: STORED generated columns from `data` (optional convention)
-- + indexes for correlation timelines and error/outcome filters.
--
-- Apply after `001_init_audit_logs.sql`. Safe to run once per database;
-- re-running after success will fail on ADD COLUMN (drop columns first if needed).

-- Replace partial index (correlation_id, occurred_at) with one that includes `id`
-- so ordering matches the Read API tie-break.
DROP INDEX IF EXISTS idx_audit_logs_correlation_occurred;

ALTER TABLE "audit_logs"
  ADD COLUMN outcome VARCHAR(64) GENERATED ALWAYS AS (
    NULLIF(BTRIM(data->>'outcome'), '')
  ) STORED,
  ADD COLUMN error_code VARCHAR(255) GENERATED ALWAYS AS (
    NULLIF(BTRIM(data->'error'->>'code'), '')
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_audit_logs_correlation_occurred_id
  ON "audit_logs" (correlation_id, occurred_at DESC, id DESC)
  WHERE correlation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_audit_logs_error_code_occurred
  ON "audit_logs" (error_code, occurred_at DESC)
  WHERE error_code IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_audit_logs_outcome_occurred
  ON "audit_logs" (outcome, occurred_at DESC)
  WHERE outcome IS NOT NULL;
