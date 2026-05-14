import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";

import { startTracevault } from "../../src/index.js";
import {
  CONN_STRING,
  TABLE,
  createDbClient,
  selectAll,
  truncate,
} from "./helpers.js";

const SECOND_TABLE = "audit_tv_app_scope";

let dbClient: pg.Client;

beforeAll(async () => {
  dbClient = await createDbClient();
});

afterAll(async () => {
  await dbClient.end();
});

afterEach(async () => {
  await truncate(dbClient, TABLE);
  await truncate(dbClient, SECOND_TABLE);
});

describe("integration / startTracevault", () => {
  it("ensures schema, emits on default scope, and reads via query", async () => {
    const tv = await startTracevault({
      driver: "postgres",
      connectionString: CONN_STRING,
      defaultScope: "default",
      scopes: {
        default: { tableName: TABLE },
        other: { tableName: SECOND_TABLE },
      },
      bootstrap: { ensureSchema: true },
    });
    try {
      await tv.emit({ event: "app.boot", data: { ok: true } });
      const rows = await tv.query.findMany({ event: "app.boot", limit: 10 });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.event).toBe("app.boot");

      const dbRows = await selectAll(dbClient, TABLE);
      expect(dbRows).toHaveLength(1);
    } finally {
      await tv.close();
    }
  });

  it("getScope routes writes and reads to the correct table", async () => {
    const tv = await startTracevault({
      driver: "postgres",
      connectionString: CONN_STRING,
      defaultScope: "default",
      scopes: {
        default: { tableName: TABLE },
        other: { tableName: SECOND_TABLE },
      },
      bootstrap: { ensureSchema: true },
    });
    try {
      const other = tv.getScope("other");
      await other.emit({ event: "scoped.evt", data: { n: 1 } });
      const qrows = await other.query.findMany({ event: "scoped.evt" });
      expect(qrows).toHaveLength(1);

      const mainRows = await selectAll(dbClient, TABLE);
      const secondRows = await selectAll(dbClient, SECOND_TABLE);
      expect(mainRows).toHaveLength(0);
      expect(secondRows).toHaveLength(1);
      expect(secondRows[0]!.event).toBe("scoped.evt");
    } finally {
      await tv.close();
    }
  });

  it("getScope caches the default scope handle without duplicating tables", async () => {
    const tv = await startTracevault({
      driver: "postgres",
      connectionString: CONN_STRING,
      defaultScope: "default",
      scopes: {
        default: { tableName: TABLE },
      },
      bootstrap: { ensureSchema: true },
    });
    try {
      const a = tv.getScope("default");
      const b = tv.getScope("default");
      expect(a).toBe(b);
      await a.emit({ event: "dup.scope", data: {} });
      const rows = await tv.query.findMany({ event: "dup.scope" });
      expect(rows).toHaveLength(1);
    } finally {
      await tv.close();
    }
  });

  it("rejects unknown scope names", async () => {
    const tv = await startTracevault({
      driver: "postgres",
      connectionString: CONN_STRING,
      defaultScope: "default",
      scopes: { default: { tableName: TABLE } },
      bootstrap: { ensureSchema: true },
    });
    try {
      expect(() => tv.getScope("nope")).toThrow(/Unknown scope/);
    } finally {
      await tv.close();
    }
  });

  it("is idempotent when ensureSchema runs twice in a row", async () => {
    const opts = {
      driver: "postgres" as const,
      connectionString: CONN_STRING,
      defaultScope: "default",
      scopes: { default: { tableName: TABLE } },
      bootstrap: { ensureSchema: true },
    };
    const a = await startTracevault(opts);
    await a.close();
    const b = await startTracevault(opts);
    await b.emit({ event: "idempotent.ok", data: {} });
    await b.close();
    const rows = await selectAll(dbClient, TABLE);
    expect(rows.some((r) => r.event === "idempotent.ok")).toBe(true);
  });
});
