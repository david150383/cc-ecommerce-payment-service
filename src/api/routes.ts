import express, { type Request, type Response, Router } from "express";
import { HttpProblem } from "../lib/problem.js";
import { requireRole } from "../middleware/authenticate.js";
import { parse } from "../middleware/validate.js";
import type { PaymentService } from "../payments/payment-service.js";
import type { TokenVerifier } from "../security/token-verifier.js";
import { AdminRefundRequest, CreateIntentRequest, ListQuery, PaymentIdParam, ReopenCheckoutRequest, toPaymentDto, toRefundDto } from "./schemas.js";

function idempotencyKey(req: Request): string {
  const key = req.get("idempotency-key");
  if (!key || !/^[\x21-\x7e]{1,255}$/.test(key)) throw new HttpProblem(400, "IDEMPOTENCY_KEY_REQUIRED", "A valid Idempotency-Key header is required");
  return key;
}

const meta = (res: Response) => ({ correlationId: res.locals.correlationId as string });
const viewer = (res: Response) => ({ subject: res.locals.principal!.subject, isAdmin: res.locals.principal!.roles.has("admin") });

/**
 * Webhooks need the RAW body: the signature is computed over the exact bytes, and parsing then
 * re-serializing JSON would change them. Mounted BEFORE the global JSON parser.
 */
export function webhookRouter(payments: PaymentService, providerName: string): Router {
  const router = Router();
  router.post("/api/v1/payments/webhooks/:provider", express.raw({ type: "*/*", limit: "256kb" }), async (req, res) => {
    if (req.params.provider !== providerName) throw new HttpProblem(404, "NOT_FOUND", "Unknown payment provider");
    const result = await payments.handleWebhook(req.body as Buffer, req.headers);
    // 2xx quickly (providers retry anything else); duplicates are acknowledged too.
    res.status(200).json({ received: true, result });
  });
  return router;
}

export function paymentRouter(payments: PaymentService, verifier: TokenVerifier): Router {
  const router = Router();
  const service = requireRole(verifier, "service");
  const customer = requireRole(verifier, "customer", "admin");
  const admin = requireRole(verifier, "admin");

  router.post("/payments/intent", service, async (req, res) => {
    const body = parse(CreateIntentRequest, req.body);
    const { payment, replayed } = await payments.createIntent(idempotencyKey(req), body, meta(res));
    if (replayed) res.setHeader("Idempotency-Replayed", "true");
    else res.setHeader("Location", `/api/v1/payments/${payment.id}`);
    res.status(replayed ? 200 : 201).json({ payment: toPaymentDto(payment) });
  });

  router.post("/payments/checkout", customer, async (req, res) => {
    const { paymentId } = parse(ReopenCheckoutRequest, req.body);
    res.json({ payment: toPaymentDto(await payments.reopenCheckout(paymentId, viewer(res))) });
  });

  router.get("/payments/:paymentId", customer, async (req, res) => {
    const { paymentId } = parse(PaymentIdParam, req.params);
    const p = await payments.get(paymentId, viewer(res));
    res.json({ payment: toPaymentDto(p), refunds: (await payments.refundsOf(p.id)).map((r) => toRefundDto(r, p.currency)) });
  });

  router.post("/payments/:paymentId/refund", admin, async (req, res) => {
    const { paymentId } = parse(PaymentIdParam, req.params);
    const body = parse(AdminRefundRequest, req.body);
    const p = await payments.get(paymentId, null);
    if (body.amount && body.amount.currency !== p.currency) throw new HttpProblem(422, "CURRENCY_MISMATCH", `This payment is in ${p.currency}`);
    const refund = await payments.requestRefund(
      idempotencyKey(req),
      { paymentId, amountMinor: body.amount ? BigInt(body.amount.amountMinor) : undefined, reason: body.reason },
      res.locals.principal!.subject,
      meta(res),
    );
    // 202: a refund is not complete until the provider confirms it.
    res.status(202).json({ refund: toRefundDto(refund, p.currency) });
  });

  router.get("/admin/payments", admin, async (req, res) => {
    const q = parse(ListQuery, req.query);
    const { payments: rows, nextCursor } = await payments.list(q);
    res.json({ data: rows.map(toPaymentDto), page: { limit: q.limit, nextCursor } });
  });

  return router;
}
