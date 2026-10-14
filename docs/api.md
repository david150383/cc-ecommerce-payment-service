# Payment Service API (v1)

Base URL (local): `http://localhost:4005`. OpenAPI: `GET /openapi.json`, Swagger UI at `/docs/`
(committed copy: [openapi/openapi.json](../openapi/openapi.json), checked by a drift test).
Conventions: `ecommerce-infrastructure/docs/architecture/conventions.md`.

## Endpoints

| Method | Path | Auth | Idempotency | Purpose |
|---|---|---|---|---|
| POST | `/api/v1/payments/intent` | service token, aud `ecommerce-payment-service` (the saga) | `Idempotency-Key` **required** | Create a payment + provider checkout session for an order |
| POST | `/api/v1/payments/checkout` | customer (owner) or admin | naturally idempotent | Return the checkout URL of a still-open PENDING payment (user closed the tab) |
| GET | `/api/v1/payments/{paymentId}` | owner or admin | n/a | Payment and its refunds (no card data, ever) |
| POST | `/api/v1/payments/webhooks/{provider}` | provider signature | dedupe on provider event id | Provider events (`mock` or `stripe`, whichever is configured; the other is 404) |
| POST | `/api/v1/payments/{paymentId}/refund` | admin | `Idempotency-Key` **required** | Manual refund; `202`, completes asynchronously |
| GET | `/api/v1/admin/payments` | admin | n/a | List with `status`, `orderId`, cursor paging |
| GET | `/mock-provider/checkout/{sessionId}` | none | n/a | **mock provider only**: the hosted "card page" with Pay / Decline buttons |

## POST /api/v1/payments/intent

```json
// request: there is NO amount field (a request that sends one is rejected); the amount comes from the Order Service
{ "orderId": "uuid", "returnUrl": "http://localhost:5173/checkout/result?saga=…", "sagaId": "uuid (optional)" }
// 201 (200 + Idempotency-Replayed: true for a repeat with the same key)
{ "payment": { "id": "uuid", "orderId": "uuid", "customerId": "uuid", "status": "PENDING", "provider": "mock",
               "amount": { "amountMinor": 117764, "currency": "INR" }, "refunded": { "amountMinor": 0, "currency": "INR" },
               "checkoutUrl": "http://localhost:4005/mock-provider/checkout/mock_cs_…", "expiresAt": "…" } }
```

The service calls `GET /internal/v1/orders/{orderId}` (service token, aud `ecommerce-order-service`) and
refuses unless the order is `INVENTORY_RESERVED` or `PAYMENT_PENDING`. One payment per order.

| Error | Status | When |
|---|---|---|
| `ORDER_NOT_FOUND` | 422 | Order Service does not know the order |
| `ORDER_NOT_PAYABLE` | 409 | Order in any other status |
| `PAYMENT_EXISTS` | 409 | The order already has a payment (under another key) |
| `IDEMPOTENCY_KEY_REUSED` | 422 | Same key, different request |
| `PROVIDER_UNAVAILABLE` | 503 | Provider call failed. The payment row exists; retrying with the **same key** resumes and reuses the provider's own idempotency key, so no duplicate session |

## Payment statuses

```
PENDING ──webhook/reconcile──▶ SUCCEEDED ──refunds──▶ PARTIALLY_REFUNDED ──▶ REFUNDED
   ├──▶ FAILED   (declined)          ▲
   └──▶ EXPIRED  (session expired) ──┘  "money truth wins": a capture reported after FAILED/EXPIRED is still recorded
```

Refunds: `PENDING ──provider confirms──▶ SUCCEEDED | FAILED`. A refund is only complete when the provider says so;
`refunded` on the payment counts confirmed refunds only. A request that exceeds *paid − refunded − pending refunds*
is recorded as `FAILED` with `NOT_REFUNDABLE` (and `RefundFailed` is published, so the saga learns it).

## Webhooks

1. Mounted **before** the JSON body parser: the signature covers the exact raw bytes.
2. Signature checked over the raw body with a constant-time comparison and a 5-minute timestamp tolerance
   (replays are rejected). Stripe: `Stripe-Signature`, verified by the official SDK. Mock: `X-Mock-Signature`,
   same `t=…,v1=HMAC-SHA256(secret, "t.body")` format.
3. Invalid → `400 INVALID_SIGNATURE`, nothing stored.
4. `INSERT webhook_events (provider, provider_event_id) ON CONFLICT DO NOTHING`, apply the change and write the
   outbox event, **in one transaction**. A duplicate → `200 {"result":"duplicate"}`.
5. An event for a session/refund we cannot find yet → `500`, the transaction (including the dedupe row) rolls
   back, so the provider's retry is processed. Refund events also carry our refund id (Stripe `metadata.refundId`),
   so a webhook that overtakes our own "store the provider refund id" write still matches.
6. No calls to other services inside the webhook request.

The browser's return to `returnUrl` proves nothing (anyone can open it); only the webhook or reconciliation changes state.

## Reconciliation

Every `RECONCILE_INTERVAL_MS`, payments still `PENDING` and refunds still `PENDING` that have not changed for
`RECONCILE_AFTER_SECONDS` are queried at the provider, and the answer is applied through the **same** code path as
webhooks. An open session past `expiresAt` is expired. Refunds whose provider call failed (unknown outcome) are
re-submitted with the same idempotency key.

## Never stored or logged

Card numbers, CVV/CVC, expiry dates: card entry happens on the provider's page, so they never reach this service.
We keep provider references (`cs_…`, `pi_…`, `re_…`), status, amounts and currency only. Provider secrets and
webhook secrets are redacted from logs.
