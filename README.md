# ecommerce-payment-service

Payments for the e-commerce platform: checkout sessions for the **authoritative** order amount, signed webhook processing, payment and refund records, idempotency and reconciliation. Pluggable providers: `mock` (local), Stripe or Razorpay (sandbox). Never stores card data.

| | |
|---|---|
| Stack | Node.js 24, Express 5, TypeScript 5.9, PostgreSQL 17 *(Phase 4)* |
| Port | 4005 |
| Database | `payment_db` (PostgreSQL), owned exclusively by this service |
| API docs | [docs/api.md](docs/api.md) |
| Messages | [docs/events.md](docs/events.md), [events/schemas](events/schemas) |

## Status

| Phase | Done |
|---|---|
| 1: skeleton | ✅ app factory, zod-validated config, pino logging with secret redaction, correlation IDs, RFC 9457 errors, health/readiness, graceful shutdown, Dockerfile, CI, message schemas with validated examples |
| 4: features | ⏳ see [docs/api.md](docs/api.md) |

## Run locally

```bash
cp .env.example .env
npm install
npm run dev            # http://localhost:4005/health/live
npm test
```

Dependencies: `docker compose up -d` here (standalone), or in `ecommerce-infrastructure` (whole platform).

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Watch mode with `.env` |
| `npm test` | Vitest + Supertest (in-process) and message-schema validation |
| `npm run lint` / `npm run typecheck` | ESLint / `tsc --noEmit` |
| `npm run build && npm start` | Compile to `dist/` and run |
| `docker build -t ecommerce-payment-service .` | Production image (non-root, multi-stage) |

## Layout

```
src/app.ts            createApp(): Express app without listen(), used by tests
src/server.ts         entry point: listen + graceful shutdown on SIGTERM/SIGINT
src/config/env.ts     validated environment
src/lib/              logger (redaction), RFC 9457 problem details
src/middleware/       correlation/request IDs, error handling
src/routes/health.ts  /health/live, /health/ready
events/schemas        JSON Schemas for messages this service owns
events/examples       one valid example per schema
```
