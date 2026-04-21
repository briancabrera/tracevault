# Tracevault — Express example

A tiny Express API that uses **Tracevault** to emit custom events.

## Setup

The example installs Tracevault from the parent workspace via `file:../..`,
which consumes the built `dist/` folder. Build it once before installing.

```bash
# 1. Build the library once (from the repo root):
cd ../..
npm install
npm run build

# 2. Install and run the example:
cd examples/express
npm install

# 3. Create the table in your database:
psql "$DATABASE_URL" -f ../../sql/001_init_audit_logs.sql

# 4. Run:
DATABASE_URL=postgres://user:pass@localhost:5432/mydb npm run dev
```

> If you later change library sources, rerun `npm run build` at the repo root
> and `npm install` in this folder to pick up the updated `dist/`.

## Endpoints

### `POST /events/price-updated`

Emits a free-form custom event using `audit.emit`.

```bash
curl -X POST http://localhost:3000/events/price-updated \
  -H 'Content-Type: application/json' \
  -d '{
    "productId": "product_456",
    "oldPrice": 120,
    "newPrice": 150,
    "currency": "UYU",
    "userId": "user_123"
  }'
```

### `POST /events/product-updated`

Uses the optional diff helper `audit.emitDiff` to compute the changed fields
and store `{ before, after, diff }` inside `data`.

```bash
curl -X POST http://localhost:3000/events/product-updated \
  -H 'Content-Type: application/json' \
  -d '{
    "productId": "product_456",
    "userId": "user_123",
    "before": { "name": "Café", "price": 120 },
    "after":  { "name": "Café", "price": 150 }
  }'
```

### `GET /health`

Runs a lightweight driver healthcheck.

```bash
curl http://localhost:3000/health
```
