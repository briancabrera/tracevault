#!/usr/bin/env node
/**
 * Smoke test for the built package.
 *
 * Verifies that `dist/` exposes the documented public API through both the
 * CJS and ESM entry points, that type declaration files exist, and that
 * `startTracevault` can be constructed and closed without touching the network.
 *
 * Run with `npm run smoke` (which builds first).
 */
import { createRequire } from "node:module";
import { readdirSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(__dirname, "..", "dist");

const EXPECTED_FUNCTIONS = [
  "startTracevault",
  "computeDiff",
  "mask",
  "generateInitSql",
  "randomCorrelationId",
  "readCorrelationIdHeader",
  "resolveCorrelationId",
  "assertValidScopeName",
  "assertValidTableName",
  "assertPgPoolLike",
];
const EXPECTED_ERROR_CLASSES = [
  "TracevaultError",
  "ConfigError",
  "ValidationError",
  "DriverError",
];
const EXPECTED_CONSTANTS = ["DEFAULT_MASK_VALUE"];
const EXPECTED_DIST_FILES = ["index.js", "index.mjs", "index.d.ts", "index.d.mts"];

function fail(msg) {
  console.error(`[smoke] FAIL: ${msg}`);
  process.exit(1);
}

function assertDistLayout() {
  try {
    statSync(distDir);
  } catch {
    fail(`dist/ does not exist at ${distDir}. Did you run \`npm run build\`?`);
  }
  const present = new Set(readdirSync(distDir));
  for (const f of EXPECTED_DIST_FILES) {
    if (!present.has(f)) fail(`dist/${f} is missing.`);
  }
}

function assertExports(moduleName, mod) {
  for (const name of EXPECTED_FUNCTIONS) {
    if (typeof mod[name] !== "function") {
      fail(`${moduleName}: expected \`${name}\` to be a function, got ${typeof mod[name]}.`);
    }
  }
  for (const name of EXPECTED_ERROR_CLASSES) {
    if (typeof mod[name] !== "function") {
      fail(`${moduleName}: expected error class \`${name}\` to be exported.`);
    }
  }
  for (const name of EXPECTED_CONSTANTS) {
    if (typeof mod[name] !== "string" || mod[name].length === 0) {
      fail(`${moduleName}: expected \`${name}\` to be a non-empty string.`);
    }
  }
}

async function createAndCloseStartTracevault(startTracevault) {
  const tv = await startTracevault({
    driver: "postgres",
    connectionString: "postgres://smoke:smoke@127.0.0.1:1/smoke",
    defaultScope: "default",
    scopes: {
      default: { tableName: "audit_smoke_default" },
      other: { tableName: "audit_smoke_other" },
    },
    bootstrap: { ensureSchema: false },
    defaultMode: "sync",
    maskFields: ["password"],
  });

  for (const method of ["emit", "emitDiff", "flush", "close", "healthcheck", "getScope"]) {
    if (typeof tv[method] !== "function") {
      fail(`TracevaultApp is missing method \`${method}\`.`);
    }
  }
  if (typeof tv.query?.findMany !== "function") {
    fail("TracevaultApp.query.findMany is missing.");
  }

  const scoped = tv.getScope("other");
  for (const method of ["emit", "emitDiff", "flush"]) {
    if (typeof scoped[method] !== "function") {
      fail(`Scope handle is missing method \`${method}\`.`);
    }
  }
  if (typeof scoped.query?.findMany !== "function") {
    fail("Scope handle query.findMany is missing.");
  }

  await tv.close();
  await tv.close();
}

function assertGenerateInitSql(moduleName, mod) {
  const ddl = mod.generateInitSql("audit_smoke_scope");
  if (typeof ddl !== "string" || !ddl.includes('CREATE TABLE IF NOT EXISTS "audit_smoke_scope"')) {
    fail(`${moduleName}: generateInitSql did not produce the expected DDL.`);
  }
  if (!ddl.includes("GENERATED ALWAYS AS") || !ddl.includes("error_code") || !ddl.includes("severity")) {
    fail(`${moduleName}: generateInitSql should include generated outcome/error_code/severity columns.`);
  }
  try {
    mod.generateInitSql("bad-name;DROP");
    fail(`${moduleName}: expected ConfigError for invalid table name in generateInitSql.`);
  } catch (err) {
    if (!(err instanceof mod.ConfigError)) {
      fail(
        `${moduleName}: expected ConfigError from generateInitSql, got ${err?.name ?? typeof err}.`,
      );
    }
  }
}

async function assertScopeNameValidation(mod) {
  try {
    mod.assertValidScopeName("0bad", "smoke");
    fail("Expected ConfigError from assertValidScopeName.");
  } catch (err) {
    if (!(err instanceof mod.ConfigError)) {
      fail(`Expected ConfigError from assertValidScopeName, got ${err?.name ?? typeof err}.`);
    }
  }
}

async function main() {
  assertDistLayout();

  const require = createRequire(import.meta.url);
  const cjs = require(resolve(distDir, "index.js"));
  assertExports("CJS (dist/index.js)", cjs);

  const esm = await import(pathToFileURL(resolve(distDir, "index.mjs")).href);
  assertExports("ESM (dist/index.mjs)", esm);

  if (cjs.DEFAULT_MASK_VALUE !== esm.DEFAULT_MASK_VALUE) {
    fail(
      `CJS and ESM disagree on DEFAULT_MASK_VALUE (${cjs.DEFAULT_MASK_VALUE} vs ${esm.DEFAULT_MASK_VALUE}).`,
    );
  }

  await createAndCloseStartTracevault(cjs.startTracevault);
  await createAndCloseStartTracevault(esm.startTracevault);

  assertGenerateInitSql("CJS (dist/index.js)", cjs);
  assertGenerateInitSql("ESM (dist/index.mjs)", esm);

  await assertScopeNameValidation(cjs);
  await assertScopeNameValidation(esm);

  try {
    await cjs.startTracevault({
      driver: "mysql",
      connectionString: "postgres://x",
      defaultScope: "default",
      scopes: { default: { tableName: "audit_x" } },
      bootstrap: { ensureSchema: false },
    });
    fail("Expected ConfigError for unsupported driver, but none was thrown.");
  } catch (err) {
    if (!(err instanceof cjs.ConfigError)) {
      fail(`Expected ConfigError for unsupported driver, got ${err?.name ?? typeof err}.`);
    }
  }

  console.log("[smoke] OK — CJS/ESM exports, startTracevault lifecycle, and helpers look healthy.");
}

main().catch((err) => {
  console.error("[smoke] Unexpected error:", err);
  process.exit(1);
});
