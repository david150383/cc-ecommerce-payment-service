import Stripe from "stripe";
import { describe, expect, it } from "vitest";
import { InvalidSignature } from "../src/providers/provider.js";
import { STRIPE_API_VERSION, StripeProvider } from "../src/providers/stripe-provider.js";

// Offline: the real SDK verifies signatures locally; API calls go to a recording fake. No network.
const SECRET = "whsec_test_offline_secret";
const real = new Stripe("sk_test_offline", { apiVersion: STRIPE_API_VERSION });

function fakeStripe() {
  const calls: { method: string; params: unknown; options: unknown }[] = [];
  const rec = (method: string, result: unknown) => async (params: unknown, options?: unknown) => {
    calls.push({ method, params, options });
    return result;
  };
  const fake = {
    webhooks: real.webhooks,
    checkout: {
      sessions: {
        create: rec("sessions.create", { id: "cs_test_1", url: "https://checkout.stripe.com/c/pay/cs_test_1" }),
        retrieve: rec("sessions.retrieve", { id: "cs_test_1", payment_status: "paid", status: "complete", payment_intent: "pi_1" }),
      },
    },
    refunds: {
      create: rec("refunds.create", { id: "re_1", status: "pending" }),
      retrieve: rec("refunds.retrieve", { id: "re_1", status: "succeeded" }),
    },
  };
  return { provider: new StripeProvider(fake as unknown as Stripe, SECRET), calls };
}

function signed(event: object, secret = SECRET, timestamp?: number) {
  const payload = JSON.stringify(event);
  const header = real.webhooks.generateTestHeaderString({ payload, secret, ...(timestamp && { timestamp }) });
  return { raw: Buffer.from(payload), headers: { "stripe-signature": header } };
}

const sessionEvent = (type: string, object: object) => ({ id: "evt_1", object: "event", type, data: { object: { id: "cs_test_1", object: "checkout.session", ...object } } });

describe("StripeProvider (offline)", () => {
  it("creates a Checkout Session with OUR amount, metadata and the idempotency key", async () => {
    const { provider, calls } = fakeStripe();
    const r = await provider.createCheckout({
      paymentId: "pay_1", orderId: "ord_1", amountMinor: 117_764n, currency: "INR",
      returnUrl: "http://localhost:5173/checkout/result?saga=s1", expiresAt: new Date("2026-10-14T12:00:00Z"), idempotencyKey: "k1",
    });
    expect(r).toEqual({ sessionId: "cs_test_1", checkoutUrl: "https://checkout.stripe.com/c/pay/cs_test_1" });
    expect(calls[0]).toMatchObject({
      params: {
        mode: "payment",
        line_items: [{ quantity: 1, price_data: { currency: "inr", unit_amount: 117_764 } }],
        metadata: { paymentId: "pay_1", orderId: "ord_1" },
        success_url: "http://localhost:5173/checkout/result?saga=s1&result=success",
        expires_at: 1_791_979_200,
      },
      options: { idempotencyKey: "k1" },
    });
  });

  it("maps a paid checkout.session.completed to payment_succeeded", () => {
    const { provider } = fakeStripe();
    const { raw, headers } = signed(sessionEvent("checkout.session.completed", { payment_status: "paid", payment_intent: "pi_1", amount_total: 117_764 }));
    expect(provider.parseWebhook(raw, headers)).toEqual({ eventId: "evt_1", kind: "payment_succeeded", sessionId: "cs_test_1", paymentRef: "pi_1", amountMinor: 117_764n });
  });

  it("ignores a completed-but-unpaid session (async payment methods) and maps the async outcomes", () => {
    const { provider } = fakeStripe();
    const p = (type: string, obj: object) => { const s = signed(sessionEvent(type, obj)); return provider.parseWebhook(s.raw, s.headers).kind; };
    expect(p("checkout.session.completed", { payment_status: "unpaid" })).toBe("ignored");
    expect(p("checkout.session.async_payment_failed", {})).toBe("payment_failed");
    expect(p("checkout.session.expired", {})).toBe("session_expired");
    expect(p("customer.created", {})).toBe("ignored");
  });

  it("maps refund status updates", () => {
    const { provider } = fakeStripe();
    const p = (status: string) => {
      const s = signed({ id: "evt_r", object: "event", type: "refund.updated", data: { object: { id: "re_1", object: "refund", status, metadata: { refundId: "rf_1" } } } });
      return provider.parseWebhook(s.raw, s.headers);
    };
    expect(p("succeeded")).toMatchObject({ kind: "refund_succeeded", refundRef: "re_1", refundId: "rf_1" });
    expect(p("failed")).toMatchObject({ kind: "refund_failed", failureCode: "PROVIDER_REJECTED" });
    expect(p("pending").kind).toBe("ignored");
  });

  it.each([
    ["a wrong secret", () => signed(sessionEvent("checkout.session.completed", {}), "whsec_attacker")],
    ["an old timestamp (replay)", () => signed(sessionEvent("checkout.session.completed", {}), SECRET, Math.floor(Date.now() / 1000) - 600)],
    ["a tampered body", () => { const s = signed(sessionEvent("checkout.session.completed", { amount_total: 1 })); return { ...s, raw: Buffer.from(s.raw.toString().replace('"amount_total":1', '"amount_total":2')) }; }],
    ["no header", () => ({ raw: Buffer.from("{}"), headers: {} })],
  ])("rejects %s with InvalidSignature", (_l, make) => {
    const { provider } = fakeStripe();
    const { raw, headers } = make();
    expect(() => provider.parseWebhook(raw, headers)).toThrow(InvalidSignature);
  });

  it("refunds with the idempotency key and reads remote state for reconciliation", async () => {
    const { provider, calls } = fakeStripe();
    expect(await provider.refund({ paymentRef: "pi_1", amountMinor: 500n, idempotencyKey: "rk", refundId: "rf_1" })).toEqual({ refundRef: "re_1", state: "pending" });
    expect(calls[0]).toMatchObject({ params: { payment_intent: "pi_1", amount: 500, metadata: { refundId: "rf_1" } }, options: { idempotencyKey: "rk" } });
    expect(await provider.getRefundState("re_1")).toEqual({ state: "succeeded" });
    expect(await provider.getPaymentState("cs_test_1")).toEqual({ state: "succeeded", paymentRef: "pi_1" });
  });
});
