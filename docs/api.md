# Payment Service API (v1)

Base URL (local): `http://localhost:4005`. Conventions: `ecommerce-infrastructure/docs/architecture/conventions.md`.
Status: **documented, not yet implemented** (Phase 4). Implemented today: health endpoints only.

## Endpoints

| Method | Path | Auth | Idempotency | Purpose |
|---|---|---|---|---|
| POST | `/api/v1/payments/intent` | service token (saga) | `Idempotency-Key` **required** | Create a payment + provider checkout session for an order |
| POST | `/api/v1/payments/checkout` | customer (owner) | `Idempotency-Key` required | Re-open checkout for an existing PENDING payment (e.g. user closed the tab) |
| GET | `/api/v1/payments/{paymentId}` | owner or admin | n/a | Payment status and history (no card data) |
| POST | `/api/v1/payments/webhooks/{provider}` | provider signature | dedupe by provider event ID | Receive provider events |
| POST | `/api/v1/payments/{paymentId}/refund` | admin | `Idempotency-Key` required | Manual refund (saga refunds use the `RefundRequested` command) |
| GET | `/api/v1/admin/payments` | admin | n/a | Payment and refund records |

## POST /api/v1/payments/intent

```json
// request: note there is NO amount; it is read from the Order Service
{ "orderId": "uuid", "returnUrl": "http://localhost:5173/checkout/result" }
// 201
{ "payment": { "id": "uuid", "orderId": "uuid", "status": "PENDING",
               "amount": { "amountMinor": 117764, "currency": "INR" }, "provider": "mock",
               "checkoutUrl": "http://localhost:4005/mock-provider/checkout/cs_123",
               "expiresAt": "2026-10-13T10:00:00.000Z" } }
```

The service calls `GET /internal/v1/orders/{orderId}` on the Order Service and refuses unless
the order is in `INVENTORY_RESERVED` or `PAYMENT_PENDING`. The amount **always** comes from that
response.

## Payment statuses

`PENDING → PROCESSING → SUCCEEDED | FAILED | EXPIRED`, then for refunds
`SUCCEEDED → REFUND_PENDING → PARTIALLY_REFUNDED | REFUNDED`.

## Webhooks

1. Read the **raw** body (signature is computed over exact bytes; JSON re-serialization breaks it).
2. Verify the signature using the provider's documented scheme, with a constant-time comparison
   and a timestamp tolerance (Stripe: `Stripe-Signature`; Razorpay: `X-Razorpay-Signature`
   HMAC-SHA256; mock: `X-Mock-Signature` HMAC-SHA256 with the same structure).
3. Insert into `webhook_events (provider, provider_event_id UNIQUE)`. A duplicate returns
   `200` immediately (providers retry until they get a 2xx).
4. Apply the state change and write the outbox event in the same transaction.
5. Respond `200` quickly. Never call other services inside the webhook request.

Invalid signature returns `400` and an alarm metric. The body is not processed.

## Never stored

Card numbers, CVV, expiry, or full provider payloads containing them. Only provider references
(`pi_...`, `pay_...`), status, amount, currency, and a last-4/brand summary if the provider
supplies one.

## Reconciliation

A job queries the provider for payments stuck in `PENDING`/`PROCESSING` for more than 10 minutes,
and for refunds in `REFUND_PENDING`. Results are applied through the same code path as webhooks.
A refund is complete only when the provider reports success.
