# Payment Service: messages

Schemas: [`events/schemas/`](../events/schemas). Examples: [`events/examples/`](../events/examples).

## Produced events (owned here, SNS `payment-events`)

| Event | Consumers | When |
|---|---|---|
| `PaymentInitiated` v1 | none yet | Checkout session created |
| `PaymentSucceeded` v1 | Saga | Verified webhook or reconciliation confirms capture |
| `PaymentFailed` v1 | Saga, Notification | Declined, expired, or cancelled |
| `RefundSucceeded` v1 | Saga, Notification | Provider confirms refund |
| `RefundFailed` v1 | Saga | Provider rejects, or unconfirmed after retries |

## Consumed commands (owned here, SQS `payment-commands`)

| Command | Sender | Idempotency |
|---|---|---|
| `RefundRequested` v1 | Saga | `idempotencyKey` is passed to the provider's own idempotency mechanism, so a redelivered command can never create a second refund |

## Sent commands

`NotificationRequested` to `notification-commands` (payment receipts, later phases).
