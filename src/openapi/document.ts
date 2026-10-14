import { OpenApiGeneratorV31, OpenAPIRegistry, type RouteConfig } from "@asteasolutions/zod-to-openapi";
import { AdminRefundRequest, CreateIntentRequest, ListQuery, PaymentDto, RefundDto, ReopenCheckoutRequest } from "../api/schemas.js";
import { z } from "../lib/zod.js";

// Built from the SAME zod schemas that validate requests; a test compares it with openapi/openapi.json.
const Problem = z.object({ type: z.string(), title: z.string(), status: z.number().int(), code: z.string(), instance: z.string() }).catchall(z.unknown()).openapi("Problem");
const json = <T extends z.ZodType>(schema: T, description: string) => ({ description, content: { "application/json": { schema } } });
const problem = (description: string) => ({ description, content: { "application/problem+json": { schema: Problem } } });
const body = <T extends z.ZodType>(schema: T) => ({ body: { content: { "application/json": { schema } } } });
const Id = z.object({ paymentId: z.uuid() });
const Key = z.object({ "idempotency-key": z.string().min(1).max(255) });

export function buildOpenApiDocument() {
  const registry = new OpenAPIRegistry();
  const bearer = registry.registerComponent("securitySchemes", "bearerAuth", { type: "http", scheme: "bearer", bearerFormat: "JWT" });
  const secured = [{ [bearer.name]: [] }];
  const paths: RouteConfig[] = [
    {
      method: "post", path: "/api/v1/payments/intent", tags: ["payments"], security: secured,
      summary: "Create the payment + provider checkout for an order (service token: saga). Amount comes from the Order Service.",
      request: { ...body(CreateIntentRequest), headers: Key },
      responses: { 201: json(z.object({ payment: PaymentDto }), "Created"), 200: json(z.object({ payment: PaymentDto }), "Replayed"),
        409: problem("ORDER_NOT_PAYABLE / PAYMENT_EXISTS"), 422: problem("ORDER_NOT_FOUND / IDEMPOTENCY_KEY_REUSED"), 503: problem("PROVIDER_UNAVAILABLE / DEPENDENCY_UNAVAILABLE") },
    },
    {
      method: "post", path: "/api/v1/payments/checkout", tags: ["payments"], security: secured, summary: "Re-open a still-valid checkout (owner)",
      request: body(ReopenCheckoutRequest), responses: { 200: json(z.object({ payment: PaymentDto }), "Checkout URL"), 409: problem("CHECKOUT_NOT_OPEN") },
    },
    {
      method: "get", path: "/api/v1/payments/{paymentId}", tags: ["payments"], security: secured, summary: "Payment with its refunds (owner or admin)",
      request: { params: Id }, responses: { 200: json(z.object({ payment: PaymentDto, refunds: z.array(RefundDto) }), "Payment"), 404: problem("NOT_FOUND") },
    },
    {
      method: "post", path: "/api/v1/payments/webhooks/{provider}", tags: ["webhooks"],
      summary: "Provider webhooks (signature-verified over the raw body; duplicates acknowledged)",
      request: { params: z.object({ provider: z.enum(["mock", "stripe"]) }) },
      responses: { 200: json(z.object({ received: z.boolean(), result: z.enum(["applied", "duplicate", "ignored"]) }), "Accepted"), 400: problem("INVALID_SIGNATURE / MALFORMED_WEBHOOK") },
    },
    {
      method: "post", path: "/api/v1/payments/{paymentId}/refund", tags: ["admin"], security: secured,
      summary: "Refund (admin). 202: complete only when the provider confirms.", request: { params: Id, ...body(AdminRefundRequest), headers: Key },
      responses: { 202: json(z.object({ refund: RefundDto }), "Requested") },
    },
    {
      method: "get", path: "/api/v1/admin/payments", tags: ["admin"], security: secured, summary: "Payment records (admin)", request: { query: ListQuery },
      responses: { 200: json(z.object({ data: z.array(PaymentDto), page: z.object({ limit: z.number().int(), nextCursor: z.string().nullable() }) }), "Payments") },
    },
  ];
  paths.forEach((p) => registry.registerPath(p));
  return new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: "3.1.0",
    info: { title: "Payment Service", version: "1.0.0", description: "Payments, webhooks, refunds, reconciliation. Semantics: docs/api.md" },
    servers: [{ url: "http://localhost:4005" }],
  });
}
