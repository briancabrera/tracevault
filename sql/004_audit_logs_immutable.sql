-- Optional: make audit_logs append-only.
-- UPDATE, DELETE and TRUNCATE on the table fail with SQLSTATE 42501.
-- Same DDL as `bootstrap: { immutable: true }` and
-- `generateInitSql("audit_logs", { immutable: true })`. Safe to run multiple times.
-- Rename audit_logs if your table has another name.

CREATE OR REPLACE FUNCTION tracevault_reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Tracevault: audit table "%" is append-only (% rejected)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;

DROP TRIGGER IF EXISTS tracevault_append_only ON "audit_logs";

CREATE TRIGGER tracevault_append_only BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION tracevault_reject_mutation();

DROP TRIGGER IF EXISTS tracevault_no_truncate ON "audit_logs";

CREATE TRIGGER tracevault_no_truncate BEFORE TRUNCATE ON "audit_logs"
  FOR EACH STATEMENT EXECUTE FUNCTION tracevault_reject_mutation();
