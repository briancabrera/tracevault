import { describe, expect, it, vi } from "vitest";

import { QueueFullError } from "../src/core/errors.js";
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

    queue.push(makeRecord("a"));
    queue.push(makeRecord("b"));
    queue.push(makeRecord("c"));

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

    queue.push(makeRecord("a"));
    queue.push(makeRecord("bad"));
    queue.push(makeRecord("c"));

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

    queue.push(makeRecord("a"));
    queue.push(makeRecord("bad"));
    queue.push(makeRecord("c"));

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

    queue.push(makeRecord("a"));
    await queue.close();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(queue.isClosed).toBe(true);

    expect(() => queue.push(makeRecord("b"))).toThrow(/closed/);
  });

  it("close() is idempotent", async () => {
    const handler = vi.fn(async () => {});
    const queue = new AsyncQueue({
      batchSize: 10,
      flushIntervalMs: 0,
      handler,
      onError: () => {},
    });

    queue.push(makeRecord("a"));

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

    queue.push(makeRecord("a"));
    queue.push(makeRecord("b"));

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
          queue.push(makeRecord("b"));
        }
      },
      onError: () => {},
    });

    queue.push(makeRecord("a"));
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
    queue.push(makeRecord("a"));
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
    queue.push(makeRecord("a"));
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
        if (record.id === "a") queue.push(makeRecord("b"));
      },
      onError: () => {},
    });
    queue.push(makeRecord("a"));
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

    for (const id of ["a", "b", "c", "d", "e"]) queue.push(makeRecord(id));
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

    for (const id of ["a", "bad", "c"]) queue.push(makeRecord(id));
    await queue.flush();

    expect(processed).toEqual(["a", "c"]);
    expect(errors).toEqual(["bad"]);
  });
});

describe("AsyncQueue — maxSize", () => {
  function gatedQueue(opts: { maxSize: number; whenFull?: "wait" | "drop" }) {
    const processed: string[] = [];
    const errors: Array<{ err: Error; id: string }> = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const queue = new AsyncQueue({
      batchSize: 1,
      flushIntervalMs: 0,
      maxSize: opts.maxSize,
      whenFull: opts.whenFull,
      handler: async (record) => {
        await gate;
        processed.push(record.id);
      },
      onError: (err, record) => errors.push({ err, id: record.id }),
    });
    return { queue, processed, errors, release };
  }

  it("\"wait\": push() resolves only once there is room, and keeps FIFO order", async () => {
    const { queue, processed, release } = gatedQueue({ maxSize: 2 });
    const resolved: string[] = [];
    for (const id of ["a", "b", "c", "d", "e"]) {
      void queue.push(makeRecord(id)).then(() => resolved.push(id));
    }
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    // "a" is in flight, "b" and "c" fill the buffer; "d" and "e" wait.
    expect(queue.size).toBe(2);
    expect(resolved).toEqual(["a", "b", "c"]);
    release();
    await queue.flush();
    expect(resolved).toEqual(["a", "b", "c", "d", "e"]);
    expect(processed).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("\"drop\": reports overflow to onError with QueueFullError and keeps going", async () => {
    const { queue, processed, errors, release } = gatedQueue({ maxSize: 2, whenFull: "drop" });
    for (const id of ["a", "b", "c", "d"]) await queue.push(makeRecord(id));
    expect(errors.map((e) => e.id)).toEqual(["c", "d"]);
    expect(errors[0]!.err).toBeInstanceOf(QueueFullError);
    release();
    await queue.flush();
    expect(processed).toEqual(["a", "b"]);
  });

  it("close() drains records still waiting for room", async () => {
    const { queue, processed, release } = gatedQueue({ maxSize: 1 });
    const pushes = ["a", "b", "c"].map((id) => queue.push(makeRecord(id)));
    const closing = queue.close();
    release();
    await Promise.all([...pushes, closing]);
    expect(processed).toEqual(["a", "b", "c"]);
  });

  it("a full buffer drains right away instead of waiting for flushIntervalMs", async () => {
    const processed: string[] = [];
    const queue = new AsyncQueue({
      batchSize: 10,
      flushIntervalMs: 60_000,
      maxSize: 2,
      handler: async (record) => {
        processed.push(record.id);
      },
      onError: () => {},
    });
    await queue.push(makeRecord("a"));
    await queue.push(makeRecord("b"));
    const started = Date.now();
    await queue.push(makeRecord("c"));
    expect(Date.now() - started).toBeLessThan(1_000);
    await queue.close();
    expect(processed).toEqual(["a", "b", "c"]);
  });

  it("admits many waiters in FIFO order", async () => {
    const processed: string[] = [];
    const queue = new AsyncQueue({
      batchSize: 7,
      flushIntervalMs: 0,
      maxSize: 3,
      handler: async () => {},
      batchHandler: async (records) => {
        for (const r of records) processed.push(r.id);
      },
      onError: () => {},
    });
    const ids = Array.from({ length: 5_000 }, (_, i) => String(i));
    await Promise.all(ids.map((id) => queue.push(makeRecord(id))));
    await queue.close();
    expect(processed).toEqual(ids);
  });
});
