import { EventEmitter } from "node:events";

import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { attachPoolErrorHandler } from "../src/drivers/postgres/pool-errors.js";

const fakePool = () => new EventEmitter() as unknown as Pool;

describe("attachPoolErrorHandler", () => {
  it("logs pool errors by default instead of swallowing them", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const pool = fakePool();
    attachPoolErrorHandler(pool, undefined, { injected: false });
    pool.emit("error", new Error("terminating connection"));
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("PostgreSQL pool error"),
      expect.any(Error),
    );
    log.mockRestore();
  });

  it("calls onPoolError and survives it throwing", () => {
    const pool = fakePool();
    const onPoolError = vi.fn(() => {
      throw new Error("handler bug");
    });
    attachPoolErrorHandler(pool, onPoolError, { injected: false });
    expect(() => pool.emit("error", new Error("x"))).not.toThrow();
    expect(onPoolError).toHaveBeenCalledOnce();
  });

  it("leaves an injected pool that already has an error listener alone", () => {
    const pool = fakePool();
    pool.on("error", () => {});
    attachPoolErrorHandler(pool, undefined, { injected: true });
    expect(pool.listenerCount("error")).toBe(1);
    attachPoolErrorHandler(pool, () => {}, { injected: true });
    expect(pool.listenerCount("error")).toBe(2);
  });

  it("guards an injected pool with no error listener", () => {
    const pool = fakePool();
    attachPoolErrorHandler(pool, undefined, { injected: true });
    expect(pool.listenerCount("error")).toBe(1);
  });
});
