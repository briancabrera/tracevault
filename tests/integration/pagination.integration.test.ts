import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";

import { createTracevaultQuery } from "../../src/query/query.js";
import type { TracevaultQuery } from "../../src/query/types.js";
import { CONN_STRING, TABLE, createDbClient, truncate } from "./helpers.js";

let dbClient: pg.Client;
let query: TracevaultQuery;

beforeAll(async () => {
  dbClient = await createDbClient();
  query = createTracevaultQuery({
    driver: "postgres",
    connectionString: CONN_STRING,
    tableName: TABLE,
  });
});

afterAll(async () => {
  await query.close();
  await dbClient.end();
});

afterEach(async () => {
  await truncate(dbClient, TABLE);
});

/** Inserts rows with microsecond timestamps and many exact ties, like raw SQL `now()` writes. */
async function seed(n: number, event = "page.e"): Promise<void> {
  await dbClient.query(
    `INSERT INTO "${TABLE}" (id, event, mode, occurred_at)
     SELECT gen_random_uuid(), $1, 'sync',
            TIMESTAMPTZ '2026-01-01 00:00:00.000001+00' + (g / 3) * INTERVAL '1.000123 ms'
     FROM generate_series(1, $2) AS g`,
    [event, n],
  );
}

async function readAll(order: "asc" | "desc", limit: number, onPage?: () => Promise<void>) {
  const ids: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const page = await query.findPage({ event: "page.e", order, limit, cursor });
    ids.push(...page.items.map((r) => r.id));
    cursor = page.nextCursor;
    pages++;
    if (onPage) await onPage();
  } while (cursor);
  return { ids, pages };
}

describe("integration / findPage", () => {
  for (const order of ["asc", "desc"] as const) {
    it(`walks every row exactly once in ${order} order, across timestamp ties`, async () => {
      await seed(253);
      const { ids, pages } = await readAll(order, 20);
      expect(pages).toBe(13);
      expect(new Set(ids).size).toBe(253);
      const expected = await query.findMany({ event: "page.e", order, limit: 500 });
      expect(ids).toEqual(expected.map((r) => r.id));
    });
  }

  it("does not repeat or skip rows when new rows arrive while paging", async () => {
    await seed(100);
    const before = (await query.findMany({ event: "page.e", limit: 500 })).map((r) => r.id);
    const { ids } = await readAll("desc", 15, async () => {
      // Newer rows land before the first page in desc order: offset paging would shift.
      await dbClient.query(
        `INSERT INTO "${TABLE}" (id, event, mode, occurred_at) VALUES ($1, 'page.e', 'sync', now())`,
        [randomUUID()],
      );
    });
    expect(ids).toEqual(before);
  });

  it("returns nextCursor null on an exact last page and on an empty table", async () => {
    expect(await query.findPage({ event: "page.e" })).toEqual({ items: [], nextCursor: null });
    await seed(10);
    const first = await query.findPage({ event: "page.e", limit: 10 });
    expect(first.items).toHaveLength(10);
    expect(first.nextCursor).toBeNull();
  });

  it("pages across BC, year > 9999 and infinite timestamps", async () => {
    await dbClient.query(
      `INSERT INTO "${TABLE}" (id, event, mode, occurred_at)
       SELECT gen_random_uuid(), 'page.e', 'sync', ts
       FROM unnest($1::timestamptz[]) AS ts, generate_series(1, 2)`,
      [
        [
          "-infinity",
          "0044-03-15 12:00:00.000001+00 BC",
          "0044-03-15 12:00:00.000001+00",
          "12026-01-01 00:00:00+00",
          "infinity",
        ],
      ],
    );
    for (const order of ["asc", "desc"] as const) {
      const { ids } = await readAll(order, 1);
      expect(ids).toHaveLength(10);
      expect(new Set(ids).size).toBe(10);
    }
  });

  it("combines the cursor with filters", async () => {
    await seed(30, "page.e");
    await seed(30, "page.other");
    const { ids } = await readAll("asc", 7);
    expect(ids).toHaveLength(30);
  });
});
