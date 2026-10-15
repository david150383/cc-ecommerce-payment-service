import { v7 as uuidv7 } from "uuid";
import type { OrderLookup } from "../clients/order-client.js";
import { type Client, isUniqueViolation, type Pool, transaction } from "../db/pool.js";
import type { Logger } from "../lib/logger.js";
import { SERVICE_NAME } from "../lib/logger.js";
import { HttpProblem } from "../lib/problem.js";
import { InvalidSignature, type PaymentProvider, type ProviderEvent, type RemotePaymentState, type RemoteRefundState } from "../providers/provider.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PaymentStatus = "PENDING" | "SUCCEEDED" | "FAILED" | "EXPIRED" | "PARTIALLY_REFUNDED" | "REFUNDED";

export interface Payment {
  id: string;
  orderId: string;
  customerId: string;
  sagaId: string | null;
  idempotencyKey: string;
  provider: string;
  amountMinor: bigint;
  currency: string;
  status: PaymentStatus;
  providerSessionId: string | null;
  providerPaymentRef: string | null;
  checkoutUrl: string | null;
  expiresAt: Date;
  failureCode: string | null;
  refundedMinor: bigint;
  createdAt: Date;
  updatedAt: Date;
}

export interface Refund {
  id: string;
  paymentId: string;
  amountMinor: bigint;
  reason: string;
  status: "PENDING" | "SUCCEEDED" | "FAILED";
  providerRefundId: string | null;
  idempotencyKey: string;
  failureCode: string | null;
  requestedBy: string;
  createdAt: Date;
}

interface Meta {
  correlationId: string;
  causationId?: string | null;
}

const PAYABLE_ORDER_STATUSES = ["INVENTORY_RESERVED", "PAYMENT_PENDING"];

const toPayment = (r: Record<string, unknown>): Payment => ({
  id: r.id as string,
  orderId: r.order_id as string,
  customerId: r.customer_id as string,
  sagaId: (r.saga_id as string | null) ?? null,
  idempotencyKey: r.idempotency_key as string,
  provider: r.provider as string,
  amountMinor: r.amount_minor as bigint,
  currency: r.currency as string,
  status: r.status as PaymentStatus,
  providerSessionId: (r.provider_session_id as string | null) ?? null,
  providerPaymentRef: (r.provider_payment_ref as string | null) ?? null,
  checkoutUrl: (r.checkout_url as string | null) ?? null,
  expiresAt: r.expires_at as Date,
  failureCode: (r.failure_code as string | null) ?? null,
  refundedMinor: r.refunded_minor as bigint,
  createdAt: r.created_at as Date,
  updatedAt: r.updated_at as Date,
});

const toRefund = (r: Record<string, unknown>): Refund => ({
  id: r.id as string,
  paymentId: r.payment_id as string,
  amountMinor: r.amount_minor as bigint,
  reason: r.reason as string,
  status: r.status as Refund["status"],
  providerRefundId: (r.provider_refund_id as string | null) ?? null,
  idempotencyKey: r.idempotency_key as string,
  failureCode: (r.failure_code as string | null) ?? null,
  requestedBy: r.requested_by as string,
  createdAt: r.created_at as Date,
});

export class PaymentService {
  constructor(
    private readonly db: Pool,
    private readonly provider: PaymentProvider,
    private readonly orders: OrderLookup,
    private readonly config: { checkoutExpiryMinutes: number; reconcileAfterSeconds: number },
    private readonly logger: Logger,
  ) {}

  // ====================================================================== create

  /**
   * Creates the payment and the provider checkout for an order. The AMOUNT comes from the Order
   * Service, never from the caller. Idempotent per key: a retry returns the same payment and, if the
   * provider call failed last time, completes it now (the provider's own idempotency key prevents a
   * second session).
   */
  async createIntent(
    idempotencyKey: string,
    input: { orderId: string; returnUrl: string; sagaId?: string | undefined },
    meta: Meta,
  ): Promise<{ payment: Payment; replayed: boolean }> {
    let payment = await this.findByKey(idempotencyKey);
    let replayed = payment !== null;
    if (payment && payment.orderId !== input.orderId) {
      throw new HttpProblem(422, "IDEMPOTENCY_KEY_REUSED", "This idempotency key was used for a different order");
    }

    if (!payment) {
      const order = await this.orders.get(input.orderId);
      if (!order) throw new HttpProblem(422, "ORDER_NOT_FOUND", "Order not found");
      if (!PAYABLE_ORDER_STATUSES.includes(order.status)) {
        throw new HttpProblem(409, "ORDER_NOT_PAYABLE", `An order that is ${order.status} cannot be paid`);
      }
      const id = uuidv7();
      try {
        payment = await transaction(this.db, async (c) => {
          const { rows } = await c.query(
            `INSERT INTO payments (id, order_id, customer_id, saga_id, idempotency_key, provider, amount_minor, currency, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + make_interval(mins => $9)) RETURNING *`,
            [id, order.id, order.customerId, input.sagaId ?? null, idempotencyKey, this.provider.name, BigInt(order.total.amountMinor), order.total.currency, this.config.checkoutExpiryMinutes],
          );
          const p = toPayment(rows[0]!);
          await this.event(c, p, "PaymentInitiated", { ...this.basePayload(p), provider: p.provider }, meta);
          return p;
        });
      } catch (err) {
        if (isUniqueViolation(err, "uq_payments_idempotency_key")) {
          payment = (await this.findByKey(idempotencyKey))!;
          replayed = true;
        } else if (isUniqueViolation(err, "uq_payments_order")) {
          throw new HttpProblem(409, "PAYMENT_EXISTS", "This order already has a payment");
        } else {
          throw err;
        }
      }
    }

    if (!payment.providerSessionId && payment.status === "PENDING") {
      payment = await this.openSession(payment, input.returnUrl);
    }
    return { payment, replayed };
  }

  private async openSession(payment: Payment, returnUrl: string): Promise<Payment> {
    let session: { sessionId: string; checkoutUrl: string };
    try {
      session = await this.provider.createCheckout({
        paymentId: payment.id,
        orderId: payment.orderId,
        amountMinor: payment.amountMinor,
        currency: payment.currency,
        returnUrl,
        expiresAt: payment.expiresAt,
        idempotencyKey: `checkout:${payment.id}`,
      });
    } catch (err) {
      this.logger.warn({ err, paymentId: payment.id }, "provider checkout creation failed");
      // The payment row exists; a retry with the same key completes the session.
      throw new HttpProblem(503, "PROVIDER_UNAVAILABLE", "The payment provider is unavailable; retry");
    }
    const { rows } = await this.db.query(
      `UPDATE payments SET provider_session_id = $2, checkout_url = $3, updated_at = now() WHERE id = $1 RETURNING *`,
      [payment.id, session.sessionId, session.checkoutUrl],
    );
    return toPayment(rows[0]!);
  }

  // ====================================================================== reads

  async get(id: string, viewer: { subject: string; isAdmin: boolean } | null): Promise<Payment> {
    const { rows } = await this.db.query(`SELECT * FROM payments WHERE id = $1`, [id]);
    const p = rows[0] ? toPayment(rows[0]) : null;
    if (!p || (viewer && !viewer.isAdmin && p.customerId !== viewer.subject)) throw new HttpProblem(404, "NOT_FOUND", "Payment not found");
    return p;
  }

  async refundsOf(paymentId: string): Promise<Refund[]> {
    const { rows } = await this.db.query(`SELECT * FROM refunds WHERE payment_id = $1 ORDER BY created_at`, [paymentId]);
    return rows.map(toRefund);
  }

  async list(filter: { status?: PaymentStatus | undefined; customerId?: string | undefined; limit: number; cursor?: string | undefined }) {
    const { rows } = await this.db.query(
      `SELECT * FROM payments
        WHERE ($1::payment_status IS NULL OR status = $1) AND ($2::uuid IS NULL OR customer_id = $2) AND ($3::uuid IS NULL OR id < $3)
        ORDER BY id DESC LIMIT $4`,
      [filter.status ?? null, filter.customerId ?? null, filter.cursor ?? null, filter.limit + 1],
    );
    const all = rows.map(toPayment);
    const page = all.slice(0, filter.limit);
    return { payments: page, nextCursor: all.length > filter.limit ? page[page.length - 1]!.id : null };
  }

  /** The customer closed the tab: hand back the still-valid checkout URL. */
  async reopenCheckout(paymentId: string, viewer: { subject: string; isAdmin: boolean }): Promise<Payment> {
    const p = await this.get(paymentId, viewer);
    if (p.status !== "PENDING" || !p.checkoutUrl || p.expiresAt <= new Date()) {
      throw new HttpProblem(409, "CHECKOUT_NOT_OPEN", "This payment can no longer be completed");
    }
    return p;
  }

  // ====================================================================== webhooks

  /**
   * Verify (over the raw body) → dedupe (provider event id) → apply → 2xx. The dedupe row and the
   * state change commit together. An event for a session we do not know yet throws, so the provider
   * retries later (it may have arrived before we stored the session id).
   */
  async handleWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): Promise<"applied" | "duplicate" | "ignored"> {
    let event: ProviderEvent;
    try {
      event = this.provider.parseWebhook(rawBody, headers);
    } catch (err) {
      if (err instanceof InvalidSignature) {
        this.logger.warn({ provider: this.provider.name, reason: err.message }, "webhook signature rejected");
        throw new HttpProblem(400, "INVALID_SIGNATURE", "Webhook signature verification failed");
      }
      throw new HttpProblem(400, "MALFORMED_WEBHOOK", "Webhook payload could not be parsed");
    }
    const meta = { correlationId: event.eventId, causationId: null };
    return transaction(this.db, async (c) => {
      const fresh = await c.query(
        `INSERT INTO webhook_events (provider, provider_event_id, event_type) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [this.provider.name, event.eventId, event.kind === "ignored" ? event.type : event.kind],
      );
      if (fresh.rowCount === 0) return "duplicate";
      if (event.kind === "ignored") return "ignored";
      await this.applyEvent(c, event, meta);
      return "applied";
    });
  }

  private async applyEvent(c: Client, event: Exclude<ProviderEvent, { kind: "ignored" }>, meta: Meta): Promise<void> {
    if (event.kind === "refund_succeeded" || event.kind === "refund_failed") {
      // The webhook may overtake submitRefund storing the provider's id: fall back to our own id.
      const ours = event.refundId !== null && UUID.test(event.refundId) ? event.refundId : null;
      const { rows } = await c.query(
        `SELECT * FROM refunds WHERE provider_refund_id = $1 OR (provider_refund_id IS NULL AND id = $2::uuid) FOR UPDATE`,
        [event.refundRef, ours],
      );
      if (!rows[0]) throw new Error(`refund ${event.refundRef} not known (yet)`); // provider retries
      if (rows[0].provider_refund_id === null) {
        await c.query(`UPDATE refunds SET provider_refund_id = $2 WHERE id = $1`, [rows[0].id, event.refundRef]);
      }
      const refund = toRefund(rows[0]);
      await this.applyRefundOutcome(c, refund, event.kind === "refund_succeeded" ? { state: "succeeded" } : { state: "failed", failureCode: event.failureCode }, meta);
      return;
    }
    const { rows } = await c.query(`SELECT * FROM payments WHERE provider = $1 AND provider_session_id = $2 FOR UPDATE`, [this.provider.name, event.sessionId]);
    if (!rows[0]) throw new Error(`session ${event.sessionId} not known (yet)`); // provider retries
    const payment = toPayment(rows[0]);
    if (event.kind === "payment_succeeded") {
      if (event.amountMinor !== null && event.amountMinor !== payment.amountMinor) {
        this.logger.error({ paymentId: payment.id, expected: String(payment.amountMinor), got: String(event.amountMinor) }, "captured amount differs from the order total");
      }
      await this.applyPaymentOutcome(c, payment, { state: "succeeded", paymentRef: event.paymentRef }, meta);
    } else if (event.kind === "payment_failed") {
      await this.applyPaymentOutcome(c, payment, { state: "failed", failureCode: event.failureCode }, meta);
    } else {
      await this.applyPaymentOutcome(c, payment, { state: "expired" }, meta);
    }
  }

  /**
   * The single place payment status changes. "Money truth wins": a success for a payment we had
   * already marked failed/expired is still recorded (and published), because the provider captured
   * the funds; the saga then refunds it. Repeats are no-ops.
   */
  private async applyPaymentOutcome(c: Client, p: Payment, outcome: RemotePaymentState, meta: Meta): Promise<void> {
    if (outcome.state === "pending") return;
    if (outcome.state === "succeeded") {
      if (!["PENDING", "FAILED", "EXPIRED"].includes(p.status)) return;
      const { rows } = await c.query(
        `UPDATE payments SET status = 'SUCCEEDED', provider_payment_ref = $2, failure_code = NULL, version = version + 1, updated_at = now() WHERE id = $1 RETURNING *`,
        [p.id, outcome.paymentRef],
      );
      const updated = toPayment(rows[0]!);
      await this.event(c, updated, "PaymentSucceeded", { ...this.basePayload(updated), provider: updated.provider, providerPaymentRef: outcome.paymentRef }, meta);
      return;
    }
    if (p.status !== "PENDING") return; // only an open payment can fail or expire
    const status = outcome.state === "expired" ? "EXPIRED" : "FAILED";
    const failureCode = outcome.state === "expired" ? "EXPIRED" : outcome.failureCode;
    const { rows } = await c.query(
      `UPDATE payments SET status = $2, failure_code = $3, version = version + 1, updated_at = now() WHERE id = $1 RETURNING *`,
      [p.id, status, failureCode],
    );
    const updated = toPayment(rows[0]!);
    await this.event(c, updated, "PaymentFailed", { ...this.basePayload(updated), provider: updated.provider, failureCode }, meta);
  }

  // ====================================================================== refunds

  /**
   * Requests a refund. Idempotent per key. A refund is only COMPLETE when the provider confirms it
   * (webhook or reconciliation): until then it is PENDING and no RefundSucceeded is published.
   */
  async requestRefund(
    idempotencyKey: string,
    input: { paymentId: string; amountMinor?: bigint | undefined; reason: string },
    requestedBy: string,
    meta: Meta,
  ): Promise<Refund> {
    const existing = await this.db.query(`SELECT * FROM refunds WHERE idempotency_key = $1`, [idempotencyKey]);
    if (existing.rows[0]) return toRefund(existing.rows[0]);

    const refund = await transaction(this.db, async (c) => {
      const { rows } = await c.query(`SELECT * FROM payments WHERE id = $1 FOR UPDATE`, [input.paymentId]);
      if (!rows[0]) throw new HttpProblem(404, "NOT_FOUND", "Payment not found");
      const p = toPayment(rows[0]);
      // sum(bigint) is NUMERIC in Postgres, which pg returns as a string: cast it back to bigint.
      const pending = await c.query<{ sum: bigint | null }>(`SELECT sum(amount_minor)::bigint AS sum FROM refunds WHERE payment_id = $1 AND status = 'PENDING'`, [p.id]);
      const refundable = p.amountMinor - p.refundedMinor - (pending.rows[0]?.sum ?? 0n);
      const amount = input.amountMinor ?? refundable;
      const id = uuidv7();
      const notRefundable = !["SUCCEEDED", "PARTIALLY_REFUNDED"].includes(p.status) || amount <= 0n || amount > refundable;
      const { rows: inserted } = await c.query(
        `INSERT INTO refunds (id, payment_id, amount_minor, reason, idempotency_key, requested_by, status, failure_code)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [id, p.id, amount > 0n ? amount : 1n, input.reason, idempotencyKey, requestedBy, notRefundable ? "FAILED" : "PENDING", notRefundable ? "NOT_REFUNDABLE" : null],
      );
      const r = toRefund(inserted[0]!);
      if (notRefundable) {
        // Recorded and answered (the saga escalates to manual review), never silently dropped.
        await this.event(c, p, "RefundFailed", { refundId: r.id, paymentId: p.id, orderId: p.orderId, failureCode: "NOT_REFUNDABLE" }, meta);
      }
      return r;
    });
    if (refund.status === "FAILED") return refund;
    return this.submitRefund(refund, meta);
  }

  async findRefundByKey(idempotencyKey: string): Promise<Refund | null> {
    const { rows } = await this.db.query(`SELECT * FROM refunds WHERE idempotency_key = $1`, [idempotencyKey]);
    return rows[0] ? toRefund(rows[0]) : null;
  }

  /**
   * Answers a duplicate refund command again with the refund's FINAL outcome, so a sender that re-sent
   * (e.g. the saga after a timeout) is not left waiting. A PENDING refund gets its answer later, from the
   * webhook or reconciliation. Consumers dedupe by state, so an extra copy is harmless.
   */
  async reemitRefundOutcome(refundId: string, meta: Meta): Promise<boolean> {
    return transaction(this.db, async (c) => {
      const { rows } = await c.query(`SELECT * FROM refunds WHERE id = $1`, [refundId]);
      if (!rows[0]) return false;
      const r = toRefund(rows[0]);
      if (r.status === "PENDING") return false;
      const { rows: pr } = await c.query(`SELECT * FROM payments WHERE id = $1`, [r.paymentId]);
      const p = toPayment(pr[0]!);
      if (r.status === "SUCCEEDED") {
        await this.event(c, p, "RefundSucceeded", { refundId: r.id, paymentId: p.id, orderId: p.orderId, customerId: p.customerId, amount: this.money(r.amountMinor, p.currency) }, meta);
      } else {
        const failureCode = r.failureCode === "NOT_REFUNDABLE" || r.failureCode === "UNCONFIRMED_AFTER_RETRIES" ? r.failureCode : "PROVIDER_REJECTED";
        await this.event(c, p, "RefundFailed", { refundId: r.id, paymentId: p.id, orderId: p.orderId, failureCode }, meta);
      }
      return true;
    });
  }

  /** Sends the refund to the provider (outside any transaction) and applies an immediate outcome. */
  private async submitRefund(refund: Refund, meta: Meta): Promise<Refund> {
    const payment = await this.get(refund.paymentId, null);
    let result: { refundRef: string } & RemoteRefundState;
    try {
      result = await this.provider.refund({
        paymentRef: payment.providerPaymentRef ?? "",
        amountMinor: refund.amountMinor,
        idempotencyKey: `refund:${refund.id}`,
        refundId: refund.id,
      });
    } catch (err) {
      // Unknown outcome: stays PENDING without a provider id; reconciliation re-submits (same idempotency key).
      this.logger.warn({ err, refundId: refund.id }, "provider refund call failed; reconciliation will retry");
      return refund;
    }
    return transaction(this.db, async (c) => {
      const { rows } = await c.query(`UPDATE refunds SET provider_refund_id = $2, updated_at = now() WHERE id = $1 RETURNING *`, [refund.id, result.refundRef]);
      const r = toRefund(rows[0]!);
      await this.applyRefundOutcome(c, r, result, meta);
      const { rows: after } = await c.query(`SELECT * FROM refunds WHERE id = $1`, [refund.id]);
      return toRefund(after[0]!);
    });
  }

  private async applyRefundOutcome(c: Client, r: Refund, outcome: RemoteRefundState, meta: Meta): Promise<void> {
    if (outcome.state === "pending" || r.status !== "PENDING") return;
    const { rows: pr } = await c.query(`SELECT * FROM payments WHERE id = $1 FOR UPDATE`, [r.paymentId]);
    const p = toPayment(pr[0]!);
    if (outcome.state === "succeeded") {
      await c.query(`UPDATE refunds SET status = 'SUCCEEDED', updated_at = now() WHERE id = $1`, [r.id]);
      const refunded = p.refundedMinor + r.amountMinor;
      const { rows } = await c.query(
        `UPDATE payments SET refunded_minor = $2, status = $3, version = version + 1, updated_at = now() WHERE id = $1 RETURNING *`,
        [p.id, refunded, refunded >= p.amountMinor ? "REFUNDED" : "PARTIALLY_REFUNDED"],
      );
      const updated = toPayment(rows[0]!);
      await this.event(c, updated, "RefundSucceeded", { refundId: r.id, paymentId: p.id, orderId: p.orderId, customerId: p.customerId, amount: this.money(r.amountMinor, p.currency) }, meta);
    } else {
      await c.query(`UPDATE refunds SET status = 'FAILED', failure_code = $2, updated_at = now() WHERE id = $1`, [r.id, outcome.failureCode]);
      await this.event(c, p, "RefundFailed", { refundId: r.id, paymentId: p.id, orderId: p.orderId, failureCode: "PROVIDER_REJECTED" }, meta);
    }
  }

  // ====================================================================== reconciliation

  /**
   * Webhooks can be lost. Asks the provider about payments and refunds that have been waiting longer
   * than RECONCILE_AFTER_SECONDS and applies the answer through the SAME code paths as webhooks.
   * Expired-but-still-pending sessions (e.g. the mock provider forgot them on restart) become EXPIRED.
   */
  async reconcile(): Promise<{ payments: number; refunds: number }> {
    const after = this.config.reconcileAfterSeconds;
    const { rows: ps } = await this.db.query(
      `SELECT * FROM payments WHERE status = 'PENDING' AND provider_session_id IS NOT NULL AND updated_at < now() - make_interval(secs => $1) ORDER BY created_at LIMIT 50`,
      [after],
    );
    let payments = 0;
    for (const row of ps) {
      const p = toPayment(row);
      try {
        let state = await this.provider.getPaymentState(p.providerSessionId!);
        if (state.state === "pending" && p.expiresAt < new Date()) state = { state: "expired" };
        if (state.state === "pending") continue;
        await transaction(this.db, async (c) => {
          const { rows } = await c.query(`SELECT * FROM payments WHERE id = $1 FOR UPDATE`, [p.id]);
          await this.applyPaymentOutcome(c, toPayment(rows[0]!), state, { correlationId: `reconcile-${p.id}`, causationId: null });
        });
        payments++;
      } catch (err) {
        this.logger.warn({ err, paymentId: p.id }, "payment reconciliation failed");
      }
    }

    const { rows: rs } = await this.db.query(
      `SELECT * FROM refunds WHERE status = 'PENDING' AND updated_at < now() - make_interval(secs => $1) ORDER BY created_at LIMIT 50`,
      [after],
    );
    let refunds = 0;
    for (const row of rs) {
      const r = toRefund(row);
      try {
        if (!r.providerRefundId) {
          await this.submitRefund(r, { correlationId: `reconcile-${r.id}` }); // never reached the provider
          refunds++;
          continue;
        }
        const state = await this.provider.getRefundState(r.providerRefundId);
        if (state.state === "pending") continue;
        await transaction(this.db, async (c) => {
          const { rows } = await c.query(`SELECT * FROM refunds WHERE id = $1 FOR UPDATE`, [r.id]);
          await this.applyRefundOutcome(c, toRefund(rows[0]!), state, { correlationId: `reconcile-${r.id}` });
        });
        refunds++;
      } catch (err) {
        this.logger.warn({ err, refundId: r.id }, "refund reconciliation failed");
      }
    }
    return { payments, refunds };
  }

  // ====================================================================== internals

  private async findByKey(key: string): Promise<Payment | null> {
    const { rows } = await this.db.query(`SELECT * FROM payments WHERE idempotency_key = $1`, [key]);
    return rows[0] ? toPayment(rows[0]) : null;
  }

  private basePayload(p: Payment) {
    return { paymentId: p.id, orderId: p.orderId, customerId: p.customerId, amount: this.money(p.amountMinor, p.currency) };
  }

  private money(amount: bigint, currency: string) {
    return { amountMinor: Number(amount), currency };
  }

  /** Writes an event to the outbox in the CALLER's transaction. Never contains card data. */
  private async event(c: Client, p: Payment, messageType: string, payload: Record<string, unknown>, meta: Meta): Promise<void> {
    const envelope = {
      messageId: uuidv7(),
      messageKind: "event",
      messageType,
      messageVersion: 1,
      producer: SERVICE_NAME,
      occurredAt: new Date().toISOString(),
      correlationId: meta.correlationId,
      causationId: meta.causationId ?? null,
      sagaId: p.sagaId,
      idempotencyKey: null,
      payload,
    };
    await c.query(`INSERT INTO outbox (id, message_type, envelope) VALUES ($1, $2, $3)`, [envelope.messageId, messageType, JSON.stringify(envelope)]);
  }
}
