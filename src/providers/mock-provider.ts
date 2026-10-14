import { v7 as uuidv7 } from "uuid";
import type { CheckoutRequest, PaymentProvider, ProviderEvent, RemotePaymentState, RemoteRefundState } from "./provider.js";
import { sign, verify } from "./signature.js";

interface MockSession {
  sessionId: string;
  paymentId: string;
  amountMinor: bigint;
  currency: string;
  returnUrl: string;
  state: "open" | "paid" | "declined" | "expired";
  paymentRef: string | null;
}

export type WebhookSink = (rawBody: string, headers: Record<string, string>) => Promise<void>;

/**
 * A local stand-in for a real provider, faithful where it matters:
 * - a hosted checkout page (served under /mock-provider) where you click Pay or Decline
 * - webhooks signed exactly like Stripe's (see signature.ts) and delivered over HTTP
 * - refunds are PENDING first and confirmed later by webhook, like real refunds
 * State lives in memory: restarting the service forgets open sessions (local use only).
 */
export class MockProvider implements PaymentProvider {
  readonly name = "mock" as const;
  readonly sessions = new Map<string, MockSession>();
  private readonly refunds = new Map<string, { refundRef: string; state: "pending" | "succeeded" | "failed" }>();
  /** Test/dev control: make the next refund fail at the provider. */
  failNextRefund = false;

  constructor(
    private readonly config: { publicBaseUrl: string; webhookSecret: string; refundDelayMs: number },
    private readonly sink: WebhookSink,
  ) {}

  async createCheckout(req: CheckoutRequest) {
    // Idempotent like a real provider: the same key returns the same session.
    const existing = [...this.sessions.values()].find((s) => s.paymentId === req.paymentId);
    const session = existing ?? {
      sessionId: `mock_cs_${uuidv7().replaceAll("-", "")}`,
      paymentId: req.paymentId,
      amountMinor: req.amountMinor,
      currency: req.currency,
      returnUrl: req.returnUrl,
      state: "open" as const,
      paymentRef: null,
    };
    this.sessions.set(session.sessionId, session);
    return { sessionId: session.sessionId, checkoutUrl: `${this.config.publicBaseUrl}/mock-provider/checkout/${session.sessionId}` };
  }

  /** What the hosted page does when the customer clicks a button. */
  async complete(sessionId: string, outcome: "pay" | "decline"): Promise<MockSession> {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error("unknown session");
    if (s.state === "open") {
      if (outcome === "pay") {
        s.state = "paid";
        s.paymentRef = `mock_pi_${uuidv7().replaceAll("-", "")}`;
        await this.emit({ type: "checkout.session.completed", data: { sessionId, paymentRef: s.paymentRef, amountMinor: String(s.amountMinor) } });
      } else {
        s.state = "declined";
        await this.emit({ type: "checkout.session.declined", data: { sessionId, failureCode: "DECLINED" } });
      }
    }
    return s;
  }

  async expire(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (s?.state === "open") {
      s.state = "expired";
      await this.emit({ type: "checkout.session.expired", data: { sessionId } });
    }
  }

  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): ProviderEvent {
    const header = headers["x-mock-signature"];
    verify(rawBody, Array.isArray(header) ? header[0] : header, this.config.webhookSecret);
    const e = JSON.parse(rawBody.toString("utf8")) as { id: string; type: string; data: Record<string, string> };
    switch (e.type) {
      case "checkout.session.completed":
        return { eventId: e.id, kind: "payment_succeeded", sessionId: e.data.sessionId!, paymentRef: e.data.paymentRef!, amountMinor: BigInt(e.data.amountMinor!) };
      case "checkout.session.declined":
        return { eventId: e.id, kind: "payment_failed", sessionId: e.data.sessionId!, failureCode: e.data.failureCode ?? "DECLINED" };
      case "checkout.session.expired":
        return { eventId: e.id, kind: "session_expired", sessionId: e.data.sessionId! };
      case "refund.succeeded":
        return { eventId: e.id, kind: "refund_succeeded", refundRef: e.data.refundRef!, refundId: e.data.refundId ?? null };
      case "refund.failed":
        return { eventId: e.id, kind: "refund_failed", refundRef: e.data.refundRef!, refundId: e.data.refundId ?? null, failureCode: e.data.failureCode ?? "PROVIDER_REJECTED" };
      default:
        return { eventId: e.id, kind: "ignored", type: e.type };
    }
  }

  async getPaymentState(sessionId: string): Promise<RemotePaymentState> {
    const s = this.sessions.get(sessionId);
    if (!s || s.state === "open") return { state: "pending" };
    if (s.state === "paid") return { state: "succeeded", paymentRef: s.paymentRef! };
    if (s.state === "expired") return { state: "expired" };
    return { state: "failed", failureCode: "DECLINED" };
  }

  async refund({ refundId }: { paymentRef: string; amountMinor: bigint; idempotencyKey: string; refundId: string }) {
    const existing = this.refunds.get(refundId);
    if (existing) return { refundRef: existing.refundRef, state: "pending" as const };
    const refundRef = `mock_re_${uuidv7().replaceAll("-", "")}`;
    const fail = this.failNextRefund;
    this.failNextRefund = false;
    this.refunds.set(refundId, { refundRef, state: "pending" });
    // Like a real provider: accepted now, final outcome later by webhook.
    setTimeout(() => {
      const r = this.refunds.get(refundId)!;
      r.state = fail ? "failed" : "succeeded";
      void this.emit(
        fail
          ? { type: "refund.failed", data: { refundRef, refundId, failureCode: "PROVIDER_REJECTED" } }
          : { type: "refund.succeeded", data: { refundRef, refundId } },
      ).catch(() => undefined);
    }, this.config.refundDelayMs).unref();
    return { refundRef, state: "pending" as const };
  }

  async getRefundState(refundRef: string): Promise<RemoteRefundState> {
    const r = [...this.refunds.values()].find((x) => x.refundRef === refundRef);
    if (!r || r.state === "pending") return { state: "pending" };
    return r.state === "succeeded" ? { state: "succeeded" } : { state: "failed", failureCode: "PROVIDER_REJECTED" };
  }

  private async emit(event: { type: string; data: Record<string, string> }): Promise<void> {
    const body = JSON.stringify({ id: `mock_evt_${uuidv7().replaceAll("-", "")}`, ...event });
    await this.sink(body, { "content-type": "application/json", "x-mock-signature": sign(body, this.config.webhookSecret) });
  }
}
