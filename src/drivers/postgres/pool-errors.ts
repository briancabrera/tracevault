import type { Pool } from "pg";

const DEFAULT_ON_POOL_ERROR = (err: Error): void => {
  // eslint-disable-next-line no-console
  console.error("[Tracevault] PostgreSQL pool error (idle client):", err);
};

/**
 * `pg.Pool` emits `error` when an idle client's connection fails; with no
 * listener, Node crashes the process. Tracevault reports these through
 * `onPoolError` instead of silently swallowing them.
 *
 * An injected pool that already has an `error` listener is left to its owner
 * unless `onPoolError` is passed explicitly.
 */
export function attachPoolErrorHandler(
  pool: Pool,
  onPoolError: ((err: Error) => void) | undefined,
  opts: { injected: boolean },
): void {
  const listeners = typeof pool.listenerCount === "function" ? pool.listenerCount("error") : 0;
  if (opts.injected && onPoolError === undefined && listeners > 0) return;
  const handler = onPoolError ?? DEFAULT_ON_POOL_ERROR;
  pool.on("error", (err: Error) => {
    try {
      handler(err);
    } catch {
      // A throwing handler must not turn into an unhandled `error` event.
    }
  });
}
