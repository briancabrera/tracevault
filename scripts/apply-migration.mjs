#!/usr/bin/env node
/**
 * Wait for PostgreSQL to accept connections, then apply shipped migrations.
 * Intended to run between `docker compose up` and the integration test suite.
 *
 * Env:
 *   TEST_DATABASE_URL  full connection string (default below)
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

const { Client } = pg;

const CONN =
  process.env.TEST_DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5433/tracevault_test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATION_001 = resolve(__dirname, "../sql/001_init_audit_logs.sql");
const MIGRATION_002 = resolve(__dirname, "../sql/002_audit_logs_outcome_error_code.sql");
const MIGRATION_003 = resolve(__dirname, "../sql/003_audit_logs_severity.sql");

async function waitReady(maxMs = 30_000) {
  const started = Date.now();
  let lastErr;
  while (Date.now() - started < maxMs) {
    const client = new Client({ connectionString: CONN });
    try {
      await client.connect();
      await client.query("SELECT 1");
      await client.end();
      return;
    } catch (err) {
      lastErr = err;
      try {
        await client.end();
      } catch {
        /* noop */
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(
    `Timed out waiting for PostgreSQL at ${CONN}: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
  );
}

async function main() {
  console.log(`[tracevault] waiting for ${CONN} ...`);
  await waitReady();

  const client = new Client({ connectionString: CONN });
  await client.connect();
  try {
    await client.query('DROP TABLE IF EXISTS "audit_logs" CASCADE');
    await client.query(readFileSync(MIGRATION_001, "utf8"));
    await client.query(readFileSync(MIGRATION_002, "utf8"));
    await client.query(readFileSync(MIGRATION_003, "utf8"));
    console.log("[tracevault] migrations 001 + 002 + 003 applied.");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("[tracevault] migration failed:", err);
  process.exit(1);
});
