import { z } from "../lib/zod.js";
import type { Payment, Refund } from "../payments/payment-service.js";

const Money = z.object({ amountMinor: z.number().int().min(1), currency: z.string().regex(/^[A-Z]{3}$/) }).openapi("Money");

export const CreateIntentRequest = z
  .object({
    orderId: z.uuid(),
    returnUrl: z.url().openapi({ description: "Where the provider sends the customer afterwards. Proves nothing about payment." }),
    sagaId: z.uuid().optional(),
  })
  .strict()
  .openapi("CreateIntentRequest", { description: "No amount: it is read from the Order Service." });

export const ReopenCheckoutRequest = z.object({ paymentId: z.uuid() }).strict().openapi("ReopenCheckoutRequest");

export const AdminRefundRequest = z
  .object({ amount: Money.optional().openapi({ description: "Omit for a full refund of what remains" }), reason: z.enum(["ADMIN", "CUSTOMER_REQUESTED"]) })
  .strict()
  .openapi("AdminRefundRequest");

export const PaymentIdParam = z.object({ paymentId: z.uuid() });
export const ListQuery = z
  .object({
    status: z.enum(["PENDING", "SUCCEEDED", "FAILED", "EXPIRED", "PARTIALLY_REFUNDED", "REFUNDED"]).optional(),
    customerId: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.uuid().optional(),
  })
  .strict();

export const PaymentDto = z
  .object({
    id: z.uuid(),
    orderId: z.uuid(),
    customerId: z.uuid(),
    status: z.string(),
    provider: z.string(),
    amount: Money,
    refunded: z.object({ amountMinor: z.number().int(), currency: z.string() }),
    checkoutUrl: z.string().nullable().openapi({ description: "Only while PENDING" }),
    expiresAt: z.iso.datetime(),
    failureCode: z.string().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .openapi("Payment", { description: "Never contains card data: the provider hosts the card form." });

export const RefundDto = z
  .object({
    id: z.uuid(),
    paymentId: z.uuid(),
    amount: z.object({ amountMinor: z.number().int(), currency: z.string() }),
    reason: z.string(),
    status: z.enum(["PENDING", "SUCCEEDED", "FAILED"]),
    failureCode: z.string().nullable(),
    createdAt: z.iso.datetime(),
  })
  .openapi("Refund");

export function toPaymentDto(p: Payment) {
  return {
    id: p.id,
    orderId: p.orderId,
    customerId: p.customerId,
    status: p.status,
    provider: p.provider,
    amount: { amountMinor: Number(p.amountMinor), currency: p.currency },
    refunded: { amountMinor: Number(p.refundedMinor), currency: p.currency },
    checkoutUrl: p.status === "PENDING" ? p.checkoutUrl : null,
    expiresAt: p.expiresAt.toISOString(),
    failureCode: p.failureCode,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

export function toRefundDto(r: Refund, currency: string) {
  return {
    id: r.id,
    paymentId: r.paymentId,
    amount: { amountMinor: Number(r.amountMinor), currency },
    reason: r.reason,
    status: r.status,
    failureCode: r.failureCode,
    createdAt: r.createdAt.toISOString(),
  };
}
