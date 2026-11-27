import type { AsyncQueueFullBehavior, PersistedRecord } from "../types/index.js";
import { QueueFullError } from "./errors.js";

export interface AsyncQueueOptions {
  batchSize: number;
  flushIntervalMs: number;
  /** Max records waiting in the buffer. `Infinity` disables the bound. */
  maxSize?: number;
  /** What `push()` does when the buffer is full. Defaults to `"wait"`. */
  whenFull?: AsyncQueueFullBehavior;
  handler: (record: PersistedRecord) => Promise<void>;
  /**
   * Optional bulk handler. When set, each batch is persisted with one call;
   * if it throws, the batch is retried record by record through `handler`
   * so `onError` only sees the records that actually failed.
   */
  batchHandler?: (records: readonly PersistedRecord[]) => Promise<void>;
  onError: (error: Error, record: PersistedRecord) => void;
}

/**
 * Minimal in-memory FIFO queue for async event persistence.
 *
 * Contract:
 * - `push(record)` appends and schedules a drain. Throws if the queue
 *   is already closed. When `maxSize` records are already waiting it either
 *   resolves once there is room (`"wait"`, FIFO) or reports the record to
 *   `onError` with a `QueueFullError` and drops it (`"drop"`).
 * - `flush()` resolves once all currently-enqueued records have been
 *   processed. Safe to call at any time.
 * - `close()` marks the queue closed (enqueue becomes an error), drains
 *   pending work, and resolves. It is idempotent: calling `close()`
 *   multiple times returns the same in-flight promise.
 * - Handler errors are never thrown asynchronously; they are funneled
 *   through `onError(err, record)` and processing continues.
 *
 * Not a distributed system: records live only in this process's heap.
 * On crash, unflushed records are lost. That is an explicit trade-off.
 */
export class AsyncQueue {
  private readonly buffer: PersistedRecord[] = [];
  /** Admitted slots are cleared to `undefined` so written records can be GC'd. */
  private waiting: Array<{ record: PersistedRecord; resolve: () => void } | undefined> = [];
  /** Index of the oldest entry in `waiting`; avoids O(n) `shift()` per admit. */
  private waitingHead = 0;
  private readonly maxSize: number;
  private readonly opts: AsyncQueueOptions;
  private processing = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private closingPromise: Promise<void> | null = null;
  private drainPromise: Promise<void> | null = null;
  private drainResolve: (() => void) | null = null;

  constructor(opts: AsyncQueueOptions) {
    this.opts = opts;
    this.maxSize = opts.maxSize ?? Infinity;
  }

  get size(): number {
    return this.buffer.length;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  push(record: PersistedRecord): Promise<void> {
    if (this.closed) {
      throw new Error("Tracevault: cannot enqueue events, queue is closed.");
    }
    if (this.buffer.length < this.maxSize && this.waitingHead === this.waiting.length) {
      this.buffer.push(record);
      this.schedule();
      return Promise.resolve();
    }
    if (this.opts.whenFull === "drop") {
      this.report(
        new QueueFullError(
          `Tracevault: async queue is full (${this.maxSize} events waiting); event dropped.`,
        ),
        record,
      );
      return Promise.resolve();
    }
    const waiter = new Promise<void>((resolve) => {
      this.waiting.push({ record, resolve });
    });
    // A full buffer must not sit behind the (unref'd) interval timer: nothing
    // else may keep the process alive while the producer awaits room.
    this.drainNow();
    return waiter;
  }

  /**
   * Resolves once the queue is fully drained (all currently-enqueued events
   * have been processed). Safe to call multiple times concurrently.
   */
  flush(): Promise<void> {
    if (this.buffer.length === 0 && !this.processing) return Promise.resolve();
    if (this.drainPromise) return this.drainPromise;
    this.drainPromise = new Promise<void>((resolve) => {
      this.drainResolve = resolve;
    });
    // A waiting flush must not sit behind the (unref'd) interval timer,
    // or the process can exit before the buffer is written.
    this.drainNow();
    return this.drainPromise;
  }

  /** Idempotent: subsequent calls return the same pending close promise. */
  close(): Promise<void> {
    if (this.closingPromise) return this.closingPromise;
    this.closed = true;
    this.closingPromise = this.flush();
    return this.closingPromise;
  }

  private drainNow(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
      this.processing = false;
    }
    this.schedule(true);
  }

  private schedule(immediate = false): void {
    if (this.processing) return;
    if (this.buffer.length === 0) return;

    this.processing = true;
    const run = () => {
      void this.drain();
    };

    if (this.opts.flushIntervalMs > 0 && !this.drainResolve && !immediate) {
      this.timer = setTimeout(() => {
        this.timer = null;
        run();
      }, this.opts.flushIntervalMs);
      this.timer.unref?.();
    } else {
      setImmediate(run);
    }
  }

  private async processOne(record: PersistedRecord): Promise<void> {
    try {
      await this.opts.handler(record);
    } catch (err) {
      this.report(err instanceof Error ? err : new Error(String(err)), record);
    }
  }

  private report(error: Error, record: PersistedRecord): void {
    try {
      this.opts.onError(error, record);
    } catch {
      // onError must never break the drain loop.
    }
  }

  /** Moves waiting `push()` calls into the buffer, oldest first, while there is room. */
  private admitWaiting(): void {
    while (this.waitingHead < this.waiting.length && this.buffer.length < this.maxSize) {
      const next = this.waiting[this.waitingHead]!;
      this.waiting[this.waitingHead++] = undefined;
      this.buffer.push(next.record);
      next.resolve();
    }
    if (this.waitingHead === this.waiting.length) {
      this.waiting = [];
      this.waitingHead = 0;
    } else if (this.waitingHead > 1024 && this.waitingHead * 2 > this.waiting.length) {
      this.waiting = this.waiting.slice(this.waitingHead);
      this.waitingHead = 0;
    }
  }

  private async drain(): Promise<void> {
    try {
      while (this.buffer.length > 0) {
        const batch = this.buffer.splice(0, this.opts.batchSize);
        this.admitWaiting();
        if (this.opts.batchHandler && batch.length > 1) {
          try {
            await this.opts.batchHandler(batch);
            continue;
          } catch {
            // Fall through to per-record inserts to isolate the failures.
          }
        }
        for (const record of batch) {
          await this.processOne(record);
        }
      }
    } finally {
      this.processing = false;
      if (this.buffer.length === 0 && this.drainResolve) {
        const resolve = this.drainResolve;
        this.drainPromise = null;
        this.drainResolve = null;
        resolve();
      } else if (this.buffer.length > 0) {
        this.schedule();
      }
    }
  }
}
