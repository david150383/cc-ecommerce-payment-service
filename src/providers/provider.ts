/**
 * The boundary between our payment logic and a payment provider. Everything provider-specific
 * (APIs, signature schemes, event names) stays behind this interface.
 */
export type ProviderName = "mock" | "stripe";

export interface CheckoutRequest {
  paymentId: string;
  orderId: string;
  amountMinor: bigint;
  currency: string;
  returnUrl: string;
  expiresAt: Date;
  /** Passed to the provider's own idempotency mechanism: a retried create returns the same session. */
  idempotencyKey: string;
}

/** Provider events, normalized. Anything we do not act on is "ignored". */
export type ProviderEvent =
  | { eventId: string; kind: "payment_succeeded"; sessionId: string; paymentRef: string; amountMinor: bigint | null }
  | { eventId: string; kind: "payment_failed"; sessionId: string; failureCode: string }
  | { eventId: string; kind: "session_expired"; sessionId: string }
  // refundId: OUR refund id echoed back by the provider (metadata), when present. It lets a webhook
  // that overtakes our own "store the provider's refund id" write still find its refund.
  | { eventId: string; kind: "refund_succeeded"; refundRef: string; refundId: string | null }
  | { eventId: string; kind: "refund_failed"; refundRef: string; refundId: string | null; failureCode: string }
  | { eventId: string; kind: "ignored"; type: string };

export type RemotePaymentState =
  | { state: "pending" }
  | { state: "succeeded"; paymentRef: string }
  | { state: "failed"; failureCode: string }
  | { state: "expired" };

export type RemoteRefundState = { state: "pending" } | { state: "succeeded" } | { state: "failed"; failureCode: string };

export class InvalidSignature extends Error {}

export interface PaymentProvider {
  readonly name: ProviderName;
  createCheckout(req: CheckoutRequest): Promise<{ sessionId: string; checkoutUrl: string }>;
  /** Verifies the signature over the RAW body (throws InvalidSignature) and normalizes the event. */
  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): ProviderEvent;
  /** Server-side truth for reconciliation (webhooks can be lost). */
  getPaymentState(sessionId: string): Promise<RemotePaymentState>;
  refund(req: { paymentRef: string; amountMinor: bigint; idempotencyKey: string; refundId: string }): Promise<{ refundRef: string } & RemoteRefundState>;
  getRefundState(refundRef: string): Promise<RemoteRefundState>;
}
