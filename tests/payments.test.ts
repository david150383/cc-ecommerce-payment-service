import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { RefundCommandHandler } from "../src/messaging/refund-command-handler.js";
import { sign } from "../src/providers/signature.js";
import { auth, buildTestContext, newId, outbox, resetDatabase, waitFor, WEBHOOK_SECRET } from "./helpers.js";

type Ctx = Awaited<ReturnType<typeof buildTestContext>>;
let ctx: Ctx;
beforeEach(async () => {
  await resetDatabase();
  ctx = await buildTestContext();
});

async function intent(orderId: string, key = newId(), sagaId?: string) {
  return request(ctx.app)
    .post("/api/v1/payments/intent")
    .set(await auth(["service"], "ecommerce-saga-orchestrator"))
    .set("Idempotency-Key", key)
    .send({ orderId, returnUrl: "http://localhost:5173/checkout/result", ...(sagaId && { sagaId }) });
}

const sessionOf = (checkoutUrl: string) => checkoutUrl.split("/").pop()!;
const statusOf = async (paymentId: string) => (await ctx.db.query(`SELECT status, refunded_minor FROM payments WHERE id = $1`, [paymentId])).rows[0];
const types = async () => (await outbox()).map((e) => e.type);

async function paid() {
  const order = ctx.orders.add();
  const { body } = await intent(order.id, newId(), newId());
  await ctx.mock.complete(sessionOf(body.payment.checkoutUrl), "pay");
  return { order, payment: body.payment };
}

describe("payment intent", () => {
  it("takes the amount from the Order Service, opens a checkout, and records PaymentInitiated", async () => {
    const order = ctx.orders.add({ total: { amountMinor: 250_000, currency: "INR" } });
    const sagaId = newId();
    const res = await intent(order.id, newId(), sagaId);
    expect(res.status).toBe(201);
    expect(res.body.payment).toMatchObject({ orderId: order.id, customerId: order.customerId, status: "PENDING", provider: "mock", amount: { amountMinor: 250_000, currency: "INR" } });
    expect(res.body.payment.checkoutUrl).toMatch(/^http:\/\/localhost:4005\/mock-provider\/checkout\/mock_cs_/);
    const [initiated] = await outbox();
    expect(initiated).toMatchObject({ type: "PaymentInitiated", envelope: { sagaId, payload: { amount: { amountMinor: 250_000 } } } });
  });

  it("is idempotent: the same key returns the same payment and session", async () => {
    const order = ctx.orders.add();
    const key = newId();
    const a = await intent(order.id, key);
    const b = await intent(order.id, key);
    expect(b.status).toBe(200);
    expect(b.headers["idempotency-replayed"]).toBe("true");
    expect(b.body.payment.id).toBe(a.body.payment.id);
    expect(b.body.payment.checkoutUrl).toBe(a.body.payment.checkoutUrl);
    expect(ctx.mock.sessions.size).toBe(1);
    expect((await intent(ctx.orders.add().id, key)).body.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("refuses orders that are missing, not payable, or already have a payment", async () => {
    expect((await intent(newId())).body.code).toBe("ORDER_NOT_FOUND");
    expect((await intent(ctx.orders.add({ status: "CANCELLED" }).id)).body.code).toBe("ORDER_NOT_PAYABLE");
    const order = ctx.orders.add();
    await intent(order.id);
    expect((await intent(order.id)).body.code).toBe("PAYMENT_EXISTS");
  });

  it("only the saga (a service token for THIS service) may create intents", async () => {
    const order = ctx.orders.add();
    const asCustomer = await request(ctx.app).post("/api/v1/payments/intent").set(await auth(["customer"])).set("Idempotency-Key", newId())
      .send({ orderId: order.id, returnUrl: "http://localhost:5173/x" });
    expect(asCustomer.status).toBe(403);
    const withAmount = await request(ctx.app).post("/api/v1/payments/intent").set(await auth(["service"])).set("Idempotency-Key", newId())
      .send({ orderId: order.id, returnUrl: "http://localhost:5173/x", amount: 1 });
    expect(withAmount.status).toBe(400); // the caller can never set the amount
  });
});

describe("hosted checkout and webhooks", () => {
  it("Pay on the hosted page → signed webhook → SUCCEEDED + PaymentSucceeded; the browser is redirected", async () => {
    const order = ctx.orders.add();
    const { body } = await intent(order.id);
    const session = sessionOf(body.payment.checkoutUrl);
    const page = await request(ctx.app).get(`/mock-provider/checkout/${session}`);
    expect(page.text).toContain("INR 1177.64");

    const click = await request(ctx.app).post(`/mock-provider/checkout/${session}/complete`).type("form").send({ outcome: "pay" });
    expect(click.status).toBe(303);
    expect(click.headers.location).toBe("http://localhost:5173/checkout/result?result=success");
    expect((await statusOf(body.payment.id)).status).toBe("SUCCEEDED");
    expect(await types()).toEqual(["PaymentInitiated", "PaymentSucceeded"]);
    expect(ctx.webhookResults.at(-1)).toMatchObject({ status: 200, body: { result: "applied" } });
  });

  it("the return URL proves nothing: until the webhook arrives the payment stays PENDING", async () => {
    const { body } = await intent(ctx.orders.add().id);
    await request(ctx.app).get(`/api/v1/payments/${body.payment.id}`).set(await auth(["admin"])); // anyone can visit the success page
    expect((await statusOf(body.payment.id)).status).toBe("PENDING");
  });

  it("Decline → FAILED (DECLINED); expiry → EXPIRED; both publish PaymentFailed", async () => {
    const a = (await intent(ctx.orders.add().id)).body.payment;
    const b = (await intent(ctx.orders.add().id)).body.payment;
    await ctx.mock.complete(sessionOf(a.checkoutUrl), "decline");
    await ctx.mock.expire(sessionOf(b.checkoutUrl));
    expect((await statusOf(a.id)).status).toBe("FAILED");
    expect((await statusOf(b.id)).status).toBe("EXPIRED");
    const failed = (await outbox()).filter((e) => e.type === "PaymentFailed").map((e) => e.envelope.payload.failureCode);
    expect(failed).toEqual(["DECLINED", "EXPIRED"]);
  });

  describe("signature verification", () => {
    const body = JSON.stringify({ id: "mock_evt_forged", type: "checkout.session.completed", data: { sessionId: "x", paymentRef: "p", amountMinor: "1" } });
    const post = (raw: string, headers: Record<string, string>) =>
      request(ctx.app).post("/api/v1/payments/webhooks/mock").set({ "content-type": "application/json", ...headers }).send(raw);

    it.each([
      ["no signature", {}],
      ["wrong secret", { "x-mock-signature": sign(body, "attacker-secret-1234") }],
      ["replayed (old timestamp)", { "x-mock-signature": sign(body, WEBHOOK_SECRET, Math.floor(Date.now() / 1000) - 3600) }],
      ["malformed header", { "x-mock-signature": "v1=deadbeef" }],
    ])("rejects a webhook with %s (400) and changes nothing", async (_label, headers) => {
      const res = await post(body, headers as Record<string, string>);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("INVALID_SIGNATURE");
      expect((await ctx.db.query(`SELECT count(*)::int AS n FROM webhook_events`)).rows[0].n).toBe(0);
    });

    it("rejects a body that was tampered with after signing", async () => {
      const header = sign(body, WEBHOOK_SECRET);
      expect((await post(body.replace('"amountMinor":"1"', '"amountMinor":"999999"'), { "x-mock-signature": header })).status).toBe(400);
    });

    it("the webhook path for another provider is 404", async () => {
      expect((await request(ctx.app).post("/api/v1/payments/webhooks/stripe").send("{}")).status).toBe(404);
    });
  });

  it("a duplicate delivery of the same event is acknowledged but applied once", async () => {
    const order = ctx.orders.add();
    const { body } = await intent(order.id);
    const raw = JSON.stringify({ id: "mock_evt_dup", type: "checkout.session.completed", data: { sessionId: sessionOf(body.payment.checkoutUrl), paymentRef: "mock_pi_1", amountMinor: "117764" } });
    const headers = { "content-type": "application/json", "x-mock-signature": sign(raw, WEBHOOK_SECRET) };
    const first = await request(ctx.app).post("/api/v1/payments/webhooks/mock").set(headers).send(raw);
    const second = await request(ctx.app).post("/api/v1/payments/webhooks/mock").set(headers).send(raw);
    expect([first.body.result, second.body.result]).toEqual(["applied", "duplicate"]);
    expect((await types()).filter((t) => t === "PaymentSucceeded")).toHaveLength(1);
  });

  it("a webhook for a session not stored yet fails (5xx) so the provider retries, and is accepted later", async () => {
    const raw = JSON.stringify({ id: "mock_evt_early", type: "checkout.session.completed", data: { sessionId: "mock_cs_not_yet", paymentRef: "p", amountMinor: "1" } });
    const headers = { "content-type": "application/json", "x-mock-signature": sign(raw, WEBHOOK_SECRET) };
    expect((await request(ctx.app).post("/api/v1/payments/webhooks/mock").set(headers).send(raw)).status).toBe(500);
    // The failed attempt did not consume the event id: a retry after the session exists is applied.
    const { body } = await intent(ctx.orders.add().id);
    await ctx.db.query(`UPDATE payments SET provider_session_id = 'mock_cs_not_yet' WHERE id = $1`, [body.payment.id]);
    expect((await request(ctx.app).post("/api/v1/payments/webhooks/mock").set(headers).send(raw)).body.result).toBe("applied");
  });

  it("money truth wins: a success after we expired the payment is still recorded (the saga refunds it)", async () => {
    const { body } = await intent(ctx.orders.add().id);
    const session = sessionOf(body.payment.checkoutUrl);
    await ctx.mock.expire(session);
    ctx.mock.sessions.get(session)!.state = "open"; // the provider captured anyway (a race at the provider)
    await ctx.mock.complete(session, "pay");
    expect((await statusOf(body.payment.id)).status).toBe("SUCCEEDED");
    expect(await types()).toEqual(["PaymentInitiated", "PaymentFailed", "PaymentSucceeded"]);
  });
});

describe("refunds", () => {
  const refund = async (paymentId: string, body: object, key = newId()) =>
    request(ctx.app).post(`/api/v1/payments/${paymentId}/refund`).set(await auth(["admin"])).set("Idempotency-Key", key).send(body);

  it("is PENDING until the provider confirms; then RefundSucceeded and the payment is (partially) refunded", async () => {
    const { payment } = await paid();
    const res = await refund(payment.id, { amount: { amountMinor: 17_764, currency: "INR" }, reason: "CUSTOMER_REQUESTED" });
    expect(res.status).toBe(202);
    expect(res.body.refund.status).toBe("PENDING");
    expect(await types()).not.toContain("RefundSucceeded");

    await waitFor(async () => ((await statusOf(payment.id)).status === "PARTIALLY_REFUNDED" ? true : undefined));
    expect((await statusOf(payment.id)).refunded_minor).toBe(17_764n);
    await refund(payment.id, { reason: "ADMIN" }); // the rest
    await waitFor(async () => ((await statusOf(payment.id)).status === "REFUNDED" ? true : undefined));
    expect((await types()).filter((t) => t === "RefundSucceeded")).toHaveLength(2);
  });

  it("never refunds more than was paid (and says so with RefundFailed NOT_REFUNDABLE)", async () => {
    const { payment } = await paid();
    const res = await refund(payment.id, { amount: { amountMinor: 999_999, currency: "INR" }, reason: "ADMIN" });
    expect(res.body.refund).toMatchObject({ status: "FAILED", failureCode: "NOT_REFUNDABLE" });
    expect((await outbox()).at(-1)).toMatchObject({ type: "RefundFailed", envelope: { payload: { failureCode: "NOT_REFUNDABLE" } } });
    expect((await statusOf(payment.id)).status).toBe("SUCCEEDED");
  });

  it("is idempotent per key, also for the saga's RefundRequested command delivered twice", async () => {
    const { order, payment } = await paid();
    const handler = new RefundCommandHandler(ctx.payments, ctx.logger);
    const cmd = {
      messageId: newId(), messageKind: "command" as const, messageType: "RefundRequested", messageVersion: 1, producer: "ecommerce-saga-orchestrator",
      correlationId: newId(), causationId: null, sagaId: newId(), idempotencyKey: `saga:refund:${payment.id}`,
      payload: { paymentId: payment.id, orderId: order.id, amount: { amountMinor: 117_764, currency: "INR" }, reason: "OUT_OF_STOCK_AFTER_PAYMENT" },
    };
    await handler.handle(cmd);
    await handler.handle(cmd);
    expect((await ctx.db.query(`SELECT count(*)::int AS n FROM refunds`)).rows[0].n).toBe(1);
    await waitFor(async () => ((await statusOf(payment.id)).status === "REFUNDED" ? true : undefined));
  });

  it("a refund webhook that overtakes storing the provider's refund id is still applied (matched by our id)", async () => {
    const { payment } = await paid();
    const realRefund = ctx.mock.refund.bind(ctx.mock);
    ctx.mock.refund = async () => { throw new Error("timeout"); }; // our write of provider_refund_id never happens
    const { body } = await refund(payment.id, { reason: "ADMIN" });
    ctx.mock.refund = realRefund;
    const raw = JSON.stringify({ id: "mock_evt_fast", type: "refund.succeeded", data: { refundRef: "mock_re_fast", refundId: body.refund.id } });
    const res = await request(ctx.app).post("/api/v1/payments/webhooks/mock")
      .set({ "content-type": "application/json", "x-mock-signature": sign(raw, WEBHOOK_SECRET) }).send(raw);
    expect(res.body.result).toBe("applied");
    expect((await statusOf(payment.id)).status).toBe("REFUNDED");
    expect((await ctx.db.query(`SELECT provider_refund_id FROM refunds WHERE id = $1`, [body.refund.id])).rows[0].provider_refund_id).toBe("mock_re_fast");
  });

  it("a refund the provider rejects publishes RefundFailed and leaves the payment as it was", async () => {
    const { payment } = await paid();
    ctx.mock.failNextRefund = true;
    await refund(payment.id, { reason: "ADMIN" });
    await waitFor(async () => ((await types()).includes("RefundFailed") ? true : undefined));
    expect((await outbox()).at(-1)!.envelope.payload.failureCode).toBe("PROVIDER_REJECTED");
    expect((await statusOf(payment.id)).status).toBe("SUCCEEDED");
  });
});

describe("reconciliation (lost webhooks)", () => {
  it("asks the provider and applies the answer through the same code path", async () => {
    const order = ctx.orders.add();
    const { body } = await intent(order.id);
    const session = ctx.mock.sessions.get(sessionOf(body.payment.checkoutUrl))!;
    session.state = "paid"; // paid at the provider, but the webhook never arrived
    session.paymentRef = "mock_pi_lost";
    await ctx.db.query(`UPDATE payments SET updated_at = now() - interval '1 hour' WHERE id = $1`, [body.payment.id]);
    expect(await ctx.payments.reconcile()).toEqual({ payments: 1, refunds: 0 });
    expect((await statusOf(body.payment.id)).status).toBe("SUCCEEDED");
    expect(await ctx.payments.reconcile()).toEqual({ payments: 0, refunds: 0 }); // nothing left
  });

  it("an open session past its expiry is expired", async () => {
    const { body } = await intent(ctx.orders.add().id);
    await ctx.db.query(`UPDATE payments SET expires_at = now() - interval '1 minute', updated_at = now() - interval '1 hour' WHERE id = $1`, [body.payment.id]);
    await ctx.payments.reconcile();
    expect((await statusOf(body.payment.id)).status).toBe("EXPIRED");
  });
});

describe("access", () => {
  it("customers see only their own payments and can re-open a valid checkout", async () => {
    const order = ctx.orders.add();
    const { body } = await intent(order.id);
    const me = await auth(["customer"], order.customerId);
    expect((await request(ctx.app).get(`/api/v1/payments/${body.payment.id}`).set(me)).status).toBe(200);
    expect((await request(ctx.app).get(`/api/v1/payments/${body.payment.id}`).set(await auth(["customer"]))).status).toBe(404);
    const reopen = await request(ctx.app).post("/api/v1/payments/checkout").set(me).send({ paymentId: body.payment.id });
    expect(reopen.body.payment.checkoutUrl).toBe(body.payment.checkoutUrl);
    expect((await request(ctx.app).get("/api/v1/admin/payments").set(me)).status).toBe(403);
  });
});

describe("published events match this service's schemas", () => {
  it("every event type validates and carries no card data", async () => {
    const schemasDir = join(import.meta.dirname, "..", "events", "schemas");
    const ajv = new Ajv2020({ strict: true, strictTypes: false, allErrors: true });
    addFormats.default(ajv);
    ajv.addVocabulary(["x-producer", "x-consumers", "x-channel", "x-message-kind"]);
    for (const f of readdirSync(schemasDir)) ajv.addSchema(JSON.parse(readFileSync(join(schemasDir, f), "utf8")));

    const { payment } = await paid();
    await ctx.mock.complete(sessionOf((await intent(ctx.orders.add().id)).body.payment.checkoutUrl), "decline");
    await request(ctx.app).post(`/api/v1/payments/${payment.id}/refund`).set(await auth(["admin"])).set("Idempotency-Key", newId()).send({ reason: "ADMIN" });
    await waitFor(async () => ((await types()).includes("RefundSucceeded") ? true : undefined));
    ctx.mock.failNextRefund = true;
    const p2 = (await paid()).payment;
    await request(ctx.app).post(`/api/v1/payments/${p2.id}/refund`).set(await auth(["admin"])).set("Idempotency-Key", newId()).send({ reason: "ADMIN" });
    await waitFor(async () => ((await types()).includes("RefundFailed") ? true : undefined));

    const events = await outbox();
    expect(new Set(events.map((e) => e.type))).toEqual(new Set(["PaymentInitiated", "PaymentSucceeded", "PaymentFailed", "RefundSucceeded", "RefundFailed"]));
    for (const e of events) {
      const id = `https://schemas.ecommerce.local/payment-service/${e.type.replace(/(?<!^)([A-Z])/g, "-$1").toLowerCase()}.v1.schema.json`;
      const validate = ajv.getSchema(id)!;
      validate(e.envelope);
      expect({ type: e.type, errors: validate.errors ?? [] }).toEqual({ type: e.type, errors: [] });
    }
    expect(JSON.stringify(events)).not.toMatch(/card|cvv|cvc|exp_month/i);
  });
});
