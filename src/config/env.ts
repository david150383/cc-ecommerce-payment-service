import { z } from "zod";

const bool = z.enum(["true", "false"]).transform((v) => v === "true");

// Validated once at startup; the process refuses to boot with invalid or dangerous config.
const EnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().min(1).max(65535).default(4005),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
    CORS_ALLOWED_ORIGINS: z
      .string()
      .default("http://localhost:5173")
      .transform((value) =>
        value
          .split(",")
          .map((origin) => origin.trim())
          .filter(Boolean),
      ),
    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),

    DATABASE_URL: z.string().startsWith("postgresql://"),

    // Incoming tokens.
    JWKS_URL: z.url().default("http://localhost:4001/.well-known/jwks.json"),
    JWT_ISSUER: z.string().default("ecommerce-auth-service"),
    JWT_AUDIENCE: z.string().default("ecommerce-api"),
    JWT_SERVICE_AUDIENCE: z.string().default("ecommerce-payment-service"),

    // Outgoing: Order Service (authoritative amounts) via a client-credentials token from Auth.
    AUTH_SERVICE_URL: z.url().default("http://localhost:4001"),
    SERVICE_CLIENT_ID: z.string().default("ecommerce-payment-service"),
    SERVICE_CLIENT_SECRET: z.string().min(1).optional(),
    ORDER_SERVICE_URL: z.url().default("http://localhost:4004"),
    DEPENDENCY_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(5_000),

    // Provider.
    PAYMENT_PROVIDER: z.enum(["mock", "stripe"]).default("mock"),
    /// Where browsers reach this service (the mock provider's hosted checkout page).
    PUBLIC_BASE_URL: z.url().default("http://localhost:4005"),
    MOCK_WEBHOOK_SECRET: z.string().min(16).default("local-mock-webhook-secret"),
    MOCK_REFUND_DELAY_MS: z.coerce.number().int().min(0).default(500),
    STRIPE_SECRET_KEY: z.string().startsWith("sk_").optional(),
    STRIPE_WEBHOOK_SECRET: z.string().startsWith("whsec_").optional(),
    /// Checkout session lifetime (Stripe allows 30 minutes to 24 hours).
    CHECKOUT_EXPIRY_MINUTES: z.coerce.number().int().min(30).max(1_440).default(30),

    // Messaging.
    MESSAGING_ENABLED: bool.default(false),
    AWS_REGION: z.string().default("us-east-1"),
    AWS_ENDPOINT_URL: z.url().optional(),
    EVENTS_TOPIC_ARN: z.string().default("arn:aws:sns:us-east-1:000000000000:local-ecommerce-payment-events"),
    COMMANDS_QUEUE_NAME: z.string().default("local-ecommerce-payment-commands"),
    OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(50).default(500),
    CONSUMER_WAIT_TIME_SECONDS: z.coerce.number().int().min(0).max(20).default(20),

    // Reconciliation: ask the provider about payments/refunds that have been waiting too long.
    RECONCILE_INTERVAL_MS: z.coerce.number().int().min(0).default(60_000),
    RECONCILE_AFTER_SECONDS: z.coerce.number().int().min(1).default(300),
  })
  .refine((e) => !(e.NODE_ENV === "production" && e.PAYMENT_PROVIDER === "mock"), {
    message: "PAYMENT_PROVIDER=mock is for local development only",
    path: ["PAYMENT_PROVIDER"],
  })
  .refine((e) => e.PAYMENT_PROVIDER !== "stripe" || (e.STRIPE_SECRET_KEY && e.STRIPE_WEBHOOK_SECRET), {
    message: "PAYMENT_PROVIDER=stripe requires STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET",
    path: ["STRIPE_SECRET_KEY"],
  })
  .refine((e) => e.NODE_ENV === "production" || !e.STRIPE_SECRET_KEY?.startsWith("sk_live_"), {
    message: "a live Stripe key (sk_live_) is only accepted when NODE_ENV=production; use a sk_test_ key",
    path: ["STRIPE_SECRET_KEY"],
  });

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  // An empty variable means "not set" (Compose passes `KEY: ${KEY:-}` through as "").
  const result = EnvSchema.safeParse(Object.fromEntries(Object.entries(source).filter(([, v]) => v !== "")));
  if (!result.success) {
    throw new Error(`Invalid environment configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
