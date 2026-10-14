import Stripe from "stripe";
import type { CheckoutRequest, PaymentProvider, ProviderEvent, RemotePaymentState, RemoteRefundState } from "./provider.js";
import { InvalidSignature } from "./provider.js";

/** Pinned explicitly: an SDK upgrade must not silently change API behaviour. */
export const STRIPE_API_VERSION = "2026-09-30.endive";

/**
 * Stripe Checkout. The amount is ours (from the Order Service); Stripe hosts the card form, so card
 * data never touches our servers. Webhooks: `Stripe-Signature`, verified by the official SDK over the
 * raw body with a 5-minute timestamp tolerance.
 */
export class StripeProvider implements PaymentProvider {
  readonly name = "stripe" as const;

  constructor(
    private readonly stripe: Stripe,
    private readonly webhookSecret: string,
  ) {}

  static create(secretKey: string, webhookSecret: string): StripeProvider {
    return new StripeProvider(new Stripe(secretKey, { apiVersion: STRIPE_API_VERSION, maxNetworkRetries: 2, timeout: 10_000 }), webhookSecret);
  }

  async createCheckout(req: CheckoutRequest) {
    const session = await this.stripe.checkout.sessions.create(
      {
        mode: "payment",
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: req.currency.toLowerCase(),
              unit_amount: Number(req.amountMinor),
              product_data: { name: `Order ${req.orderId}` },
            },
          },
        ],
        client_reference_id: req.paymentId,
        metadata: { paymentId: req.paymentId, orderId: req.orderId },
        payment_intent_data: { metadata: { paymentId: req.paymentId, orderId: req.orderId } },
        success_url: `${req.returnUrl}${req.returnUrl.includes("?") ? "&" : "?"}result=success`,
        cancel_url: `${req.returnUrl}${req.returnUrl.includes("?") ? "&" : "?"}result=cancelled`,
        // Stripe allows 30 minutes to 24 hours.
        expires_at: Math.floor(req.expiresAt.getTime() / 1000),
      },
      { idempotencyKey: req.idempotencyKey },
    );
    if (!session.url) throw new Error("Stripe returned a session without a URL");
    return { sessionId: session.id, checkoutUrl: session.url };
  }

  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): ProviderEvent {
    const header = headers["stripe-signature"];
    let event: Stripe.Event;
    try {
      event = this.stripe.webhooks.constructEvent(rawBody, Array.isArray(header) ? header[0]! : (header ?? ""), this.webhookSecret, 300);
    } catch (err) {
      throw new InvalidSignature((err as Error).message);
    }
    switch (event.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded": {
        const s = event.data.object;
        // Some payment methods complete the session before funds arrive ("unpaid"); wait for async_payment_succeeded.
        if (s.payment_status !== "paid") return { eventId: event.id, kind: "ignored", type: `${event.type}:${s.payment_status}` };
        return {
          eventId: event.id,
          kind: "payment_succeeded",
          sessionId: s.id,
          paymentRef: typeof s.payment_intent === "string" ? s.payment_intent : (s.payment_intent?.id ?? ""),
          amountMinor: s.amount_total === null ? null : BigInt(s.amount_total),
        };
      }
      case "checkout.session.async_payment_failed":
        return { eventId: event.id, kind: "payment_failed", sessionId: event.data.object.id, failureCode: "DECLINED" };
      case "checkout.session.expired":
        return { eventId: event.id, kind: "session_expired", sessionId: event.data.object.id };
      case "refund.updated":
      case "refund.failed": {
        const r = event.data.object;
        const refundId = r.metadata?.refundId ?? null;
        if (r.status === "succeeded") return { eventId: event.id, kind: "refund_succeeded", refundRef: r.id, refundId };
        if (r.status === "failed" || r.status === "canceled") return { eventId: event.id, kind: "refund_failed", refundRef: r.id, refundId, failureCode: "PROVIDER_REJECTED" };
        return { eventId: event.id, kind: "ignored", type: `${event.type}:${r.status}` };
      }
      default:
        return { eventId: event.id, kind: "ignored", type: event.type };
    }
  }

  async getPaymentState(sessionId: string): Promise<RemotePaymentState> {
    const s = await this.stripe.checkout.sessions.retrieve(sessionId);
    if (s.payment_status === "paid") {
      return { state: "succeeded", paymentRef: typeof s.payment_intent === "string" ? s.payment_intent : (s.payment_intent?.id ?? "") };
    }
    if (s.status === "expired") return { state: "expired" };
    return { state: "pending" };
  }

  async refund(req: { paymentRef: string; amountMinor: bigint; idempotencyKey: string; refundId: string }) {
    const r = await this.stripe.refunds.create(
      { payment_intent: req.paymentRef, amount: Number(req.amountMinor), metadata: { refundId: req.refundId } },
      { idempotencyKey: req.idempotencyKey },
    );
    return { refundRef: r.id, ...toRefundState(r.status) };
  }

  async getRefundState(refundRef: string): Promise<RemoteRefundState> {
    return toRefundState((await this.stripe.refunds.retrieve(refundRef)).status);
  }
}

function toRefundState(status: string | null): RemoteRefundState {
  if (status === "succeeded") return { state: "succeeded" };
  if (status === "failed" || status === "canceled") return { state: "failed", failureCode: "PROVIDER_REJECTED" };
  return { state: "pending" }; // pending, requires_action
}
