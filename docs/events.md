# Payment Service: messages

Schemas: [`events/schemas/`](../events/schemas). Examples: [`events/examples/`](../events/examples).
Every outgoing event is written to the `outbox` table in the same transaction as the state change, then published
by the relay (at-least-once; consumers dedupe on `messageId`). The tests validate every produced event against
these schemas.

## Produced events (owned here, SNS `payment-events`, attribute `messageType`)

| Event | Consumers | When |
|---|---|---|
| `PaymentInitiated` v1 | none yet | Payment + checkout session created |
| `PaymentSucceeded` v1 | Saga | Verified webhook or reconciliation confirms capture (also after FAILED/EXPIRED: the saga refunds late payments) |
| `PaymentFailed` v1 | Saga, Notification | Declined (`DECLINED`) or expired (`EXPIRED`) |
| `RefundSucceeded` v1 | Saga, Notification | Provider confirms the refund |
| `RefundFailed` v1 | Saga | Provider rejects (`PROVIDER_REJECTED`) or nothing left to refund (`NOT_REFUNDABLE`) |

`sagaId` is set when the intent was created with one, so the saga can route without a lookup.

## Consumed commands (owned here, SQS `payment-commands`)

| Command | Sender | Idempotency |
|---|---|---|
| `RefundRequested` v1 | Saga | The command's `idempotencyKey` is the refund's key here **and** is passed to the provider's idempotency mechanism: a redelivered command can never create a second refund. Invalid commands are not deleted, so they reach the DLQ |
