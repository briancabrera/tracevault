import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";

import { createDbClient, newAudit, selectAll, truncate } from "./helpers.js";

let dbClient: pg.Client;

beforeAll(async () => {
  dbClient = await createDbClient();
});

afterAll(async () => {
  await dbClient.end();
});

afterEach(async () => {
  await truncate(dbClient);
});

describe("integration / concurrency & volume", () => {
  it("handles 50 concurrent sync emits without duplicates or loss", async () => {
    const audit = newAudit();
    try {
      const N = 50;
      const promises = Array.from({ length: N }, (_, i) =>
        audit.emit({
          event: "concurrent.sync",
          actor: { id: `u${i}`, type: "user" },
          data: { i },
        }),
      );
      await Promise.all(promises);

      const rows = await selectAll(dbClient);
      expect(rows).toHaveLength(N);

      const ids = new Set(rows.map((r) => r.id));
      expect(ids.size).toBe(N);

      const seen = new Set(rows.map((r) => (r.data as { i: number }).i));
      expect(seen.size).toBe(N);
      for (let i = 0; i < N; i++) expect(seen.has(i)).toBe(true);
    } finally {
      await audit.close();
    }
  });

  it("persists a large async batch (200) in order, with small asyncBatchSize", async () => {
    const audit = newAudit({ defaultMode: "async", asyncBatchSize: 7 });
    try {
      const N = 200;
      for (let i = 0; i < N; i++) {
        await audit.emit({
          event: "batch.item",
          data: { i },
          occurredAt: new Date(2026, 0, 1, 0, 0, 0, i), // strictly increasing
        });
      }
      // Buffered so far.
      expect(await selectAll(dbClient)).toHaveLength(0);

      await audit.flush();

      const rows = await selectAll(dbClient);
      expect(rows).toHaveLength(N);

      const seen = rows.map((r) => (r.data as { i: number }).i);
      expect(seen).toEqual(Array.from({ length: N }, (_, i) => i));
      expect(rows.every((r) => r.mode === "async")).toBe(true);
    } finally {
      await audit.close();
    }
  });

  it("mixes sync and async on the same instance and records each mode", async () => {
    const audit = newAudit({ defaultMode: "sync" });
    try {
      await audit.emit({ event: "m.sync.1" });
      await audit.emit({ event: "m.async.1", mode: "async" });
      await audit.emit({ event: "m.sync.2" });
      await audit.emit({ event: "m.async.2", mode: "async" });
      await audit.flush();

      const rows = await selectAll(dbClient);
      const byEvent = Object.fromEntries(rows.map((r) => [r.event, r.mode]));
      expect(byEvent["m.sync.1"]).toBe("sync");
      expect(byEvent["m.sync.2"]).toBe("sync");
      expect(byEvent["m.async.1"]).toBe("async");
      expect(byEvent["m.async.2"]).toBe("async");
    } finally {
      await audit.close();
    }
  });

  it("two concurrent instances writing in parallel do not interfere", async () => {
    const a = newAudit();
    const b = newAudit();
    try {
      const N = 25;
      const aJobs = Array.from({ length: N }, (_, i) =>
        a.emit({ event: "pair.a", actor: { id: `a-${i}`, type: "user" } }),
      );
      const bJobs = Array.from({ length: N }, (_, i) =>
        b.emit({ event: "pair.b", actor: { id: `b-${i}`, type: "user" } }),
      );
      await Promise.all([...aJobs, ...bJobs]);

      const rows = await selectAll(dbClient);
      expect(rows).toHaveLength(2 * N);

      const aCount = rows.filter((r) => r.event === "pair.a").length;
      const bCount = rows.filter((r) => r.event === "pair.b").length;
      expect(aCount).toBe(N);
      expect(bCount).toBe(N);

      const ids = new Set(rows.map((r) => r.id));
      expect(ids.size).toBe(2 * N);
    } finally {
      await Promise.all([a.close(), b.close()]);
    }
  });

  it("close() alone drains a large pending async backlog", async () => {
    const audit = newAudit({ defaultMode: "async", asyncBatchSize: 10 });
    const N = 100;
    for (let i = 0; i < N; i++) {
      await audit.emit({ event: "pending", data: { i } });
    }
    // No explicit flush — close() has to drain it.
    await audit.close();

    const rows = await selectAll(dbClient);
    expect(rows).toHaveLength(N);
  });
});
