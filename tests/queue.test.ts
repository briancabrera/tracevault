import { describe, expect, it, vi } from "vitest";

import { AsyncQueue } from "../src/core/queue.js";
import type { PersistedRecord } from "../src/types/index.js";

function makeRecord(id: string): PersistedRecord {
  return {
    id,
    event: "test",
    actorId: null,
    actorType: null,
    targetId: null,
    targetType: null,
    data: null,
    meta: null,
    mode: "async",
    occurredAt: new Date(),
    correlationId: null,
    requestId: null,
    environment: null,
  };
}

describe("AsyncQueue", () => {
  it("processes enqueued records in FIFO order", async () => {
    const processed: string[] = [];
    const queue = new AsyncQueue({
      batchSize: 10,
      flushIntervalMs: 0,
      handler: async (record) => {
        processed.push(record.id);
      },
      onError: () => {},
    });

    queue.enqueue(makeRecord("a"));
    queue.enqueue(makeRecord("b"));
    queue.enqueue(makeRecord("c"));

    await queue.flush();

    expect(processed).toEqual(["a", "b", "c"]);
  });

  it("routes handler errors through onError and keeps processing", async () => {
    const processed: string[] = [];
    const errors: string[] = [];
    const queue = new AsyncQueue({
      batchSize: 10,
      flushIntervalMs: 0,
      handler: async (record) => {
        if (record.id === "bad") throw new Error("boom");
        processed.push(record.id);
      },
      onError: (_err, record) => {
        errors.push(record.id);
      },
    });

    queue.enqueue(makeRecord("a"));
    queue.enqueue(makeRecord("bad"));
    queue.enqueue(makeRecord("c"));

    await queue.flush();

    expect(processed).toEqual(["a", "c"]);
    expect(errors).toEqual(["bad"]);
  });

  it("does not let a throwing onError break the drain loop", async () => {
    const processed: string[] = [];
    const queue = new AsyncQueue({
      batchSize: 10,
      flushIntervalMs: 0,
      handler: async (record) => {
        if (record.id === "bad") throw new Error("boom");
        processed.push(record.id);
      },
      onError: () => {
        throw new Error("user onError blew up");
      },
    });

    queue.enqueue(makeRecord("a"));
    queue.enqueue(makeRecord("bad"));
    queue.enqueue(makeRecord("c"));

    await queue.flush();

    expect(processed).toEqual(["a", "c"]);
  });

  it("close flushes and then rejects further enqueues", async () => {
    const handler = vi.fn(async () => {});
    const queue = new AsyncQueue({
      batchSize: 10,
      flushIntervalMs: 0,
      handler,
      onError: () => {},
    });

    queue.enqueue(makeRecord("a"));
    await queue.close();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(queue.isClosed).toBe(true);

    expect(() => queue.enqueue(makeRecord("b"))).toThrow(/closed/);
  });

  it("close() is idempotent", async () => {
    const handler = vi.fn(async () => {});
    const queue = new AsyncQueue({
      batchSize: 10,
      flushIntervalMs: 0,
      handler,
      onError: () => {},
    });

    queue.enqueue(makeRecord("a"));

    const [r1, r2, r3] = await Promise.all([queue.close(), queue.close(), queue.close()]);
    expect(r1).toBeUndefined();
    expect(r2).toBeUndefined();
    expect(r3).toBeUndefined();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("flush on empty queue resolves immediately", async () => {
    const queue = new AsyncQueue({
      batchSize: 10,
      flushIntervalMs: 0,
      handler: async () => {},
      onError: () => {},
    });
    await expect(queue.flush()).resolves.toBeUndefined();
  });

  it("concurrent flush calls share the same drain promise", async () => {
    const processed: string[] = [];
    const queue = new AsyncQueue({
      batchSize: 10,
      flushIntervalMs: 0,
      handler: async (record) => {
        processed.push(record.id);
      },
      onError: () => {},
    });

    queue.enqueue(makeRecord("a"));
    queue.enqueue(makeRecord("b"));

    await Promise.all([queue.flush(), queue.flush(), queue.flush()]);
    expect(processed).toEqual(["a", "b"]);
  });

  it("handles enqueues that arrive mid-drain", async () => {
    const processed: string[] = [];
    let step = 0;
    const queue = new AsyncQueue({
      batchSize: 10,
      flushIntervalMs: 0,
      handler: async (record) => {
        processed.push(record.id);
        if (step === 0) {
          step = 1;
          queue.enqueue(makeRecord("b"));
        }
      },
      onError: () => {},
    });

    queue.enqueue(makeRecord("a"));
    await queue.flush();

    expect(processed).toEqual(["a", "b"]);
  });

  it("respects flushIntervalMs scheduling", async () => {
    const processed: string[] = [];
    const queue = new AsyncQueue({
      batchSize: 10,
      flushIntervalMs: 10,
      handler: async (record) => {
        processed.push(record.id);
      },
      onError: () => {},
    });
    queue.enqueue(makeRecord("a"));
    await queue.flush();
    expect(processed).toEqual(["a"]);
  });

  it("flush() does not wait for a pending flushIntervalMs timer", async () => {
    const processed: string[] = [];
    const queue = new AsyncQueue({
      batchSize: 10,
      flushIntervalMs: 60_000,
      handler: async (record) => {
        processed.push(record.id);
      },
      onError: () => {},
    });
    queue.enqueue(makeRecord("a"));
    const started = Date.now();
    await queue.close();
    expect(processed).toEqual(["a"]);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("flush() drains records enqueued mid-drain without waiting for the interval", async () => {
    const processed: string[] = [];
    const queue: AsyncQueue = new AsyncQueue({
      batchSize: 1,
      flushIntervalMs: 60_000,
      handler: async (record) => {
        processed.push(record.id);
        if (record.id === "a") queue.enqueue(makeRecord("b"));
      },
      onError: () => {},
    });
    queue.enqueue(makeRecord("a"));
    const started = Date.now();
    await queue.flush();
    expect(processed).toEqual(["a", "b"]);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("AsyncQueue — batchHandler", () => {
  it("persists each batch with a single batchHandler call", async () => {
    const batches: string[][] = [];
    const single = vi.fn(async () => {});
    const queue = new AsyncQueue({
      batchSize: 2,
      flushIntervalMs: 0,
      handler: single,
      batchHandler: async (records) => {
        batches.push(records.map((r) => r.id));
      },
      onError: () => {},
    });

    for (const id of ["a", "b", "c", "d", "e"]) queue.enqueue(makeRecord(id));
    await queue.flush();

    expect(batches).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
    expect(single).toHaveBeenCalledTimes(1);
  });

  it("falls back to per-record handler when the batch fails, reporting only bad records", async () => {
    const processed: string[] = [];
    const errors: string[] = [];
    const queue = new AsyncQueue({
      batchSize: 10,
      flushIntervalMs: 0,
      handler: async (record) => {
        if (record.id === "bad") throw new Error("boom");
        processed.push(record.id);
      },
      batchHandler: async () => {
        throw new Error("batch failed");
      },
      onError: (_err, record) => {
        errors.push(record.id);
      },
    });

    for (const id of ["a", "bad", "c"]) queue.enqueue(makeRecord(id));
    await queue.flush();

    expect(processed).toEqual(["a", "c"]);
    expect(errors).toEqual(["bad"]);
  });
});
