# ecommerce-payment-service

Payments for the e-commerce platform: checkout sessions for the **authoritative** order amount, signed webhook processing, payment and refund records, idempotency and reconciliation. Pluggable providers: `mock` (local, with a hosted test checkout page) and Stripe (test mode). Never sees or stores card data.

| | |
|---|---|
| Stack | Node.js 24, Express 5, TypeScript 5.9, PostgreSQL 17 (`pg`, node-pg-migrate SQL migrations), Stripe SDK (pinned API version), AWS SDK v3 (SNS/SQS), jose 6, Zod 4 |
| Port | 4005 |
| Database | `payment_db` (PostgreSQL), owned exclusively by this service |
| API docs | [docs/api.md](docs/api.md) |
| Messages | [docs/events.md](docs/events.md), [events/schemas](events/schemas) |

## Status

| Phase | Done |
|---|---|
| 1: skeleton | ✅ app factory, zod-validated config, pino logging with secret redaction, correlation IDs, RFC 9457 errors, health/readiness, graceful shutdown, Dockerfile, CI, message schemas with validated examples |
| 4: features | ✅ Intents for the authoritative order amount, mock + Stripe providers, signed webhooks (raw body, replay window, dedupe), refunds confirmed by the provider, reconciliation, outbox → SNS, `RefundRequested` consumer. See [docs/api.md](docs/api.md) |

## Run locally

```bash
cp .env.example .env
npm install
npm run dev            # http://localhost:4005/health/live
npm test
```

Dependencies: `docker compose up -d` here (standalone Postgres on 5445), or in `ecommerce-infrastructure`
(whole platform, Postgres on 5432 + Floci on 4566). `npm run db:migrate` applies `migrations/`. `npm test` needs
Postgres and Floci; the Stripe adapter tests run offline (no network, no keys).

### Trying Stripe (test mode)

Put a **test** key in `.env` (`STRIPE_SECRET_KEY=sk_test_…`, `PAYMENT_PROVIDER=stripe`), run
`stripe listen --forward-to localhost:4005/api/v1/payments/webhooks/stripe`, and copy the `whsec_…` it prints into
`STRIPE_WEBHOOK_SECRET`. Pay with Stripe's test cards. A live key (`sk_live_`) is refused unless `NODE_ENV=production`.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Watch mode with `.env` |
| `npm test` | Vitest + Supertest (in-process) and message-schema validation |
| `npm run lint` / `npm run typecheck` | ESLint / `tsc --noEmit` |
| `npm run build && npm start` | Compile to `dist/` and run |
| `npm run db:migrate` / `db:rollback` | Apply / revert SQL migrations |
| `npm run openapi:export` | Regenerate `openapi/openapi.json` |
| `docker build --target runtime` / `--target migrate` | Production image / one-off migration job (non-root, multi-stage) |

## Layout

```
src/app.ts            createApp(): Express app without listen(), used by tests
src/server.ts         entry point: listen + graceful shutdown on SIGTERM/SIGINT
src/config/env.ts     validated environment
src/lib/              logger (redaction), RFC 9457 problem details
src/middleware/       correlation/request IDs, error handling
src/routes/health.ts  /health/live, /health/ready
src/api/              routes, request/response schemas
src/payments/         PaymentService: intents, webhooks, refunds, reconciliation
src/providers/        PaymentProvider interface, mock (+ hosted page), Stripe, signatures
src/clients/          Order Service lookup, service tokens
src/messaging/        outbox relay, RefundRequested consumer, workers
migrations/           SQL migrations
events/schemas        JSON Schemas for messages this service owns
events/examples       one valid example per schema
```
