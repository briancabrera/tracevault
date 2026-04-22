#!/usr/bin/env node
/**
 * Smoke test for the built package.
 *
 * Verifies that `dist/` exposes the documented public API through both the
 * CJS and ESM entry points, that type declaration files exist on both sides,
 * and that a minimal Tracevault instance can be created and closed without
 * touching the network.
 *
 * Run with `npm run smoke` (which builds first).
 */
import { createRequire } from "node:module";
import { readdirSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(__dirname, "..", "dist");

const EXPECTED_FUNCTIONS = ["createTracevault", "computeDiff", "mask", "generateInitSql"];
const EXPECTED_ERROR_CLASSES = [
  "TracevaultError",
  "ConfigError",
  "ValidationError",
  "DriverError",
];
const EXPECTED_CONSTANTS = ["DEFAULT_MASK_VALUE"];
const EXPECTED_DIST_FILES = [
  "index.js",
  "index.mjs",
  "index.d.ts",
  "index.d.mts",
  "query.js",
  "query.mjs",
  "query.d.ts",
  "query.d.mts",
];

const EXPECTED_QUERY_FUNCTIONS = ["createTracevaultQuery"];

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

async function createAndCloseInstance(createTracevault) {
  const audit = createTracevault({
    driver: "postgres",
    connectionString: "postgres://smoke:smoke@127.0.0.1:1/smoke",
    defaultMode: "sync",
    maskFields: ["password"],
  });

  for (const method of ["emit", "emitDiff", "flush", "close", "healthcheck", "scope"]) {
    if (typeof audit[method] !== "function") {
      fail(`Tracevault instance is missing method \`${method}\`.`);
    }
  }

  const scoped = audit.scope({ tableName: "audit_smoke_scope" });
  for (const method of ["emit", "emitDiff", "flush", "close", "healthcheck", "scope"]) {
    if (typeof scoped[method] !== "function") {
      fail(`Scope Tracevault instance is missing method \`${method}\`.`);
    }
  }

  await audit.close();
  await audit.close();
}

function assertGenerateInitSql(moduleName, mod) {
  const ddl = mod.generateInitSql("audit_smoke_scope");
  if (typeof ddl !== "string" || !ddl.includes('CREATE TABLE IF NOT EXISTS "audit_smoke_scope"')) {
    fail(`${moduleName}: generateInitSql did not produce the expected DDL.`);
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

function assertQueryExports(moduleName, mod) {
  for (const name of EXPECTED_QUERY_FUNCTIONS) {
    if (typeof mod[name] !== "function") {
      fail(`${moduleName}: expected \`${name}\` to be a function, got ${typeof mod[name]}.`);
    }
  }
  for (const name of EXPECTED_ERROR_CLASSES) {
    if (typeof mod[name] !== "function") {
      fail(`${moduleName}: expected error class \`${name}\` to be re-exported.`);
    }
  }
}

async function createAndCloseQueryInstance(createTracevaultQuery) {
  const q = createTracevaultQuery({
    driver: "postgres",
    connectionString: "postgres://smoke:smoke@127.0.0.1:1/smoke",
    tableName: "audit_smoke_read",
  });

  for (const method of [
    "findMany",
    "findById",
    "count",
    "scope",
    "close",
    "healthcheck",
  ]) {
    if (typeof q[method] !== "function") {
      fail(`TracevaultQuery instance is missing method \`${method}\`.`);
    }
  }

  const scoped = q.scope({ tableName: "audit_smoke_read_scope" });
  for (const method of ["findMany", "findById", "count", "scope", "close", "healthcheck"]) {
    if (typeof scoped[method] !== "function") {
      fail(`Scoped TracevaultQuery instance is missing method \`${method}\`.`);
    }
  }

  await q.close();
  await q.close();
}

async function assertQueryValidation(createTracevaultQuery, ValidationError) {
  // Validation runs before any DB round-trip, so we can exercise the whole
  // input pipeline without a reachable pool.
  const q = createTracevaultQuery({
    driver: "postgres",
    connectionString: "postgres://smoke:smoke@127.0.0.1:1/smoke",
  });
  try {
    try {
      await q.findById("not-a-uuid");
      fail("Expected ValidationError from findById('not-a-uuid').");
    } catch (err) {
      if (!(err instanceof ValidationError)) {
        fail(`Expected ValidationError from findById, got ${err?.name ?? typeof err}.`);
      }
    }
    try {
      await q.findMany({ limit: 99999 });
      fail("Expected ValidationError from findMany({ limit: 99999 }).");
    } catch (err) {
      if (!(err instanceof ValidationError)) {
        fail(`Expected ValidationError from findMany, got ${err?.name ?? typeof err}.`);
      }
    }
  } finally {
    await q.close();
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

  await createAndCloseInstance(cjs.createTracevault);
  await createAndCloseInstance(esm.createTracevault);

  assertGenerateInitSql("CJS (dist/index.js)", cjs);
  assertGenerateInitSql("ESM (dist/index.mjs)", esm);

  // Read API: separate subpath exports.
  const queryCjs = require(resolve(distDir, "query.js"));
  assertQueryExports("CJS (dist/query.js)", queryCjs);

  const queryEsm = await import(pathToFileURL(resolve(distDir, "query.mjs")).href);
  assertQueryExports("ESM (dist/query.mjs)", queryEsm);

  await createAndCloseQueryInstance(queryCjs.createTracevaultQuery);
  await createAndCloseQueryInstance(queryEsm.createTracevaultQuery);

  await assertQueryValidation(queryCjs.createTracevaultQuery, queryCjs.ValidationError);
  await assertQueryValidation(queryEsm.createTracevaultQuery, queryEsm.ValidationError);

  try {
    cjs.createTracevault({ driver: "mysql", connectionString: "x" });
    fail("Expected ConfigError for unsupported driver, but none was thrown.");
  } catch (err) {
    if (!(err instanceof cjs.ConfigError)) {
      fail(`Expected ConfigError for unsupported driver, got ${err?.name ?? typeof err}.`);
    }
  }

  try {
    queryCjs.createTracevaultQuery({ driver: "mysql", connectionString: "x" });
    fail("Expected ConfigError for unsupported query driver, but none was thrown.");
  } catch (err) {
    if (!(err instanceof queryCjs.ConfigError)) {
      fail(
        `Expected ConfigError from query factory, got ${err?.name ?? typeof err}.`,
      );
    }
  }

  console.log(
    "[smoke] OK — write & read CJS/ESM exports, lifecycle, and error classes look healthy.",
  );
}

main().catch((err) => {
  console.error("[smoke] Unexpected error:", err);
  process.exit(1);
});
