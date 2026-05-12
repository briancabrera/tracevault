-- Tracevault V3: optional `data.severity` as a STORED generated column + index.
-- Apply after `002_audit_logs_outcome_error_code.sql`.

ALTER TABLE "audit_logs"
  ADD COLUMN severity VARCHAR(32) GENERATED ALWAYS AS (
    NULLIF(BTRIM(data->>'severity'), '')
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_audit_logs_severity_occurred
  ON "audit_logs" (severity, occurred_at DESC)
  WHERE severity IS NOT NULL;
