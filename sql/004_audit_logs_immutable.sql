-- Optional: make audit_logs append-only.
-- UPDATE, DELETE and TRUNCATE on the table fail with SQLSTATE 42501.
-- Same DDL as `bootstrap: { immutable: true }` and
-- `generateInitSql("audit_logs", { immutable: true })`. Safe to re-run: it only
-- creates what is missing,
-- never drops a trigger and never replaces an existing function.
-- Rename audit_logs if your table has another name.

DO $tv$
BEGIN
  IF to_regprocedure('tracevault_reject_mutation()') IS NULL THEN
    EXECUTE $fn$CREATE OR REPLACE FUNCTION tracevault_reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Tracevault: audit table "%" is append-only (% rejected)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$$fn$;
  END IF;
END
$tv$;

DO $tv$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid = '"audit_logs"'::regclass AND tgname = 'tracevault_append_only'
  ) THEN
    CREATE TRIGGER tracevault_append_only BEFORE UPDATE OR DELETE ON "audit_logs"
      FOR EACH ROW EXECUTE FUNCTION tracevault_reject_mutation();
  END IF;
END
$tv$;

DO $tv$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid = '"audit_logs"'::regclass AND tgname = 'tracevault_no_truncate'
  ) THEN
    CREATE TRIGGER tracevault_no_truncate BEFORE TRUNCATE ON "audit_logs"
      FOR EACH STATEMENT EXECUTE FUNCTION tracevault_reject_mutation();
  END IF;
END
$tv$;
