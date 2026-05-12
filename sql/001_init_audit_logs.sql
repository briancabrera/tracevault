-- Tracevault V1 initial schema.
--
-- Run this against your database once before using the library.
-- If you configured a custom `tableName`, replace "audit_logs" below.

CREATE TABLE IF NOT EXISTS "audit_logs" (
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
  environment     VARCHAR     NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_event        ON "audit_logs" (event);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor        ON "audit_logs" (actor_id, actor_type);
CREATE INDEX IF NOT EXISTS idx_audit_logs_target       ON "audit_logs" (target_id, target_type);
CREATE INDEX IF NOT EXISTS idx_audit_logs_occurred_at  ON "audit_logs" (occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_correlation_occurred
  ON "audit_logs" (correlation_id, occurred_at DESC)
  WHERE correlation_id IS NOT NULL;
