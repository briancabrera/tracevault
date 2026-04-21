#!/usr/bin/env node
/**
 * Run the integration suite end-to-end:
 *   1. docker compose up -d
 *   2. wait for Postgres and apply the migration
 *   3. run the integration Vitest config
 *   4. docker compose down -v (always, even on failure)
 */
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const COMPOSE_FILE = "docker/docker-compose.yml";

function run(cmd, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(cmd, args, { stdio: "inherit", cwd: ROOT });
    child.on("error", rejectRun);
    child.on("exit", (code) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`\`${cmd} ${args.join(" ")}\` exited with code ${code}`));
    });
  });
}

async function tearDown() {
  try {
    await run("docker", ["compose", "-f", COMPOSE_FILE, "down", "-v"]);
  } catch (err) {
    console.error("[tracevault] teardown failed:", err instanceof Error ? err.message : err);
  }
}

async function main() {
  let failure;

  // Ensure Ctrl-C still tears the container down.
  const onSignal = () => {
    tearDown().finally(() => process.exit(1));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    await run("docker", ["compose", "-f", COMPOSE_FILE, "up", "-d"]);
    await run(process.execPath, ["scripts/apply-migration.mjs"]);
    await run("npx", ["vitest", "run", "--config", "vitest.integration.config.ts"]);
  } catch (err) {
    failure = err;
  } finally {
    await tearDown();
  }

  if (failure) {
    console.error(
      "[tracevault] integration run failed:",
      failure instanceof Error ? failure.message : failure,
    );
    process.exit(1);
  }
}

main();
