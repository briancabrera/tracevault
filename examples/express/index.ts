import express, { type Request, type Response } from "express";

import { createTracevault, resolveCorrelationId } from "tracevault";

const audit = createTracevault({
  driver: "postgres",
  connectionString: process.env.DATABASE_URL ?? "postgres://localhost:5432/tracevault_example",
  tableName: "audit_logs",
  maskFields: ["password", "token", "pin"],
  defaultMode: "sync",
  environment: process.env.NODE_ENV ?? "development",
});

type RequestWithCorrelation = Request & { correlationId: string };

function correlationId(req: Request): string {
  return (req as RequestWithCorrelation).correlationId;
}

const app = express();
app.use(express.json());

/** One correlation id per HTTP request: header if valid, else a new UUID (see README). */
app.use((req, res, next) => {
  const id = resolveCorrelationId((h) => req.get(h));
  (req as RequestWithCorrelation).correlationId = id;
  res.setHeader("x-correlation-id", id);
  next();
});

/**
 * Emit a free-form custom event. The shape of `data` is entirely up to
 * the caller — Tracevault only ensures it gets persisted consistently.
 */
app.post("/events/price-updated", async (req: Request, res: Response) => {
  const { productId, oldPrice, newPrice, currency, userId } = req.body ?? {};

  await audit.emit({
    event: "product.price.updated",
    actor: { id: String(userId ?? "anonymous"), type: "user" },
    target: { id: String(productId), type: "product" },
    data: { oldPrice, newPrice, currency },
    meta: {
      source: "example-api",
      ip: req.ip,
      userAgent: req.get("user-agent") ?? null,
    },
    correlationId: correlationId(req),
    requestId: req.get("x-request-id") ?? undefined,
  });

  res.status(202).json({ ok: true });
});

/**
 * Use the optional diff helper. The library computes the changed fields
 * and stores `{ before, after, diff }` inside `data`.
 */
app.post("/events/product-updated", async (req: Request, res: Response) => {
  const { productId, before, after, userId } = req.body ?? {};

  await audit.emitDiff({
    event: "product.updated",
    actor: { id: String(userId ?? "anonymous"), type: "user" },
    target: { id: String(productId), type: "product" },
    before,
    after,
    meta: { source: "example-api" },
    correlationId: correlationId(req),
  });

  res.status(202).json({ ok: true });
});

app.get("/health", async (_req, res) => {
  const ok = await audit.healthcheck();
  res.status(ok ? 200 : 503).json({ ok });
});

const port = Number(process.env.PORT ?? 3000);
const server = app.listen(port, () => {
  console.log(`Tracevault example listening on :${port}`);
});

async function shutdown(signal: string) {
  console.log(`Received ${signal}, draining...`);
  server.close();
  await audit.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
