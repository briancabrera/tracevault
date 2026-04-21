import type { PersistedRecord } from "../types/index.js";

export interface AsyncQueueOptions {
  batchSize: number;
  flushIntervalMs: number;
  handler: (record: PersistedRecord) => Promise<void>;
  onError: (error: Error, record: PersistedRecord) => void;
}

/**
 * Minimal in-memory FIFO queue for async event persistence.
 *
 * Contract:
 * - `enqueue(record)` appends and schedules a drain. Throws if the queue
 *   is already closed.
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
  private readonly opts: AsyncQueueOptions;
  private processing = false;
  private closed = false;
  private closingPromise: Promise<void> | null = null;
  private drainPromise: Promise<void> | null = null;
  private drainResolve: (() => void) | null = null;

  constructor(opts: AsyncQueueOptions) {
    this.opts = opts;
  }

  get size(): number {
    return this.buffer.length;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  enqueue(record: PersistedRecord): void {
    if (this.closed) {
      throw new Error("Tracevault: cannot enqueue events, queue is closed.");
    }
    this.buffer.push(record);
    this.schedule();
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
    this.schedule();
    return this.drainPromise;
  }

  /** Idempotent: subsequent calls return the same pending close promise. */
  close(): Promise<void> {
    if (this.closingPromise) return this.closingPromise;
    this.closed = true;
    this.closingPromise = this.flush();
    return this.closingPromise;
  }

  private schedule(): void {
    if (this.processing) return;
    if (this.buffer.length === 0) return;

    this.processing = true;
    const run = () => {
      void this.drain();
    };

    if (this.opts.flushIntervalMs > 0) {
      setTimeout(run, this.opts.flushIntervalMs).unref?.();
    } else {
      setImmediate(run);
    }
  }

  private async drain(): Promise<void> {
    try {
      while (this.buffer.length > 0) {
        const batch = this.buffer.splice(0, this.opts.batchSize);
        for (const record of batch) {
          try {
            await this.opts.handler(record);
          } catch (err) {
            try {
              this.opts.onError(
                err instanceof Error ? err : new Error(String(err)),
                record,
              );
            } catch {
              // onError must never break the drain loop.
            }
          }
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
