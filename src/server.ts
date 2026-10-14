import { createApp } from "./app.js";
import { HttpOrderLookup } from "./clients/order-client.js";
import { ServiceTokenProvider } from "./clients/service-token-provider.js";
import { loadEnv } from "./config/env.js";
import { createPool } from "./db/pool.js";
import { createLogger } from "./lib/logger.js";
import { createWorkers } from "./messaging/runner.js";
import { PaymentService } from "./payments/payment-service.js";
import { MockProvider } from "./providers/mock-provider.js";
import type { PaymentProvider } from "./providers/provider.js";
import { StripeProvider } from "./providers/stripe-provider.js";
import { TokenVerifier } from "./security/token-verifier.js";

const env = loadEnv();
const logger = createLogger(env.LOG_LEVEL);
const db = createPool(env.DATABASE_URL);

const tokens = new ServiceTokenProvider({
  authUrl: env.AUTH_SERVICE_URL,
  clientId: env.SERVICE_CLIENT_ID,
  clientSecret: env.SERVICE_CLIENT_SECRET,
  timeoutMs: env.DEPENDENCY_TIMEOUT_MS,
});
if (!env.SERVICE_CLIENT_SECRET) logger.warn("SERVICE_CLIENT_SECRET is not set: payment intents will fail (no order lookups)");

// The mock provider delivers its signed webhooks to this service over HTTP, like a real provider.
const selfWebhookUrl = `http://127.0.0.1:${env.PORT}/api/v1/payments/webhooks/mock`;
const mock =
  env.PAYMENT_PROVIDER === "mock"
    ? new MockProvider(
        { publicBaseUrl: env.PUBLIC_BASE_URL, webhookSecret: env.MOCK_WEBHOOK_SECRET, refundDelayMs: env.MOCK_REFUND_DELAY_MS },
        async (rawBody, headers) => {
          const res = await fetch(selfWebhookUrl, { method: "POST", headers, body: rawBody, signal: AbortSignal.timeout(5_000) });
          if (!res.ok) throw new Error(`webhook delivery failed: ${res.status}`);
        },
      )
    : undefined;
const provider: PaymentProvider = mock ?? StripeProvider.create(env.STRIPE_SECRET_KEY!, env.STRIPE_WEBHOOK_SECRET!);

const payments = new PaymentService(
  db,
  provider,
  new HttpOrderLookup(env.ORDER_SERVICE_URL, tokens, env.DEPENDENCY_TIMEOUT_MS),
  { checkoutExpiryMinutes: env.CHECKOUT_EXPIRY_MINUTES, reconcileAfterSeconds: env.RECONCILE_AFTER_SECONDS },
  logger,
);
const workers = createWorkers(env, db, payments, logger);

let shuttingDown = false;

const app = createApp({
  env,
  logger,
  payments,
  mock,
  verifier: new TokenVerifier({ jwksUrl: env.JWKS_URL, issuer: env.JWT_ISSUER, audiences: [env.JWT_AUDIENCE, env.JWT_SERVICE_AUDIENCE] }),
  readinessChecks: [
    {
      // Report "not ready" as soon as shutdown starts, so the load balancer
      // stops sending new requests while in-flight ones finish.
      name: "accepting-traffic",
      check: async () => {
        if (shuttingDown) throw new Error("shutting down");
      },
    },
    { name: "database", check: async () => void (await db.query("SELECT 1")) },
  ],
});

const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, provider: provider.name }, "server listening");
  workers.start();
});

function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutdown started");

  server.close((err) => {
    void workers
      .stop()
      .then(() => db.end())
      .finally(() => {
        if (err) {
          logger.error({ err }, "error while closing server");
          process.exit(1);
        }
        logger.info("shutdown complete");
        process.exit(0);
      });
  });
  server.closeIdleConnections();

  setTimeout(() => {
    logger.error({ timeoutMs: env.SHUTDOWN_TIMEOUT_MS }, "forced shutdown after timeout");
    process.exit(1);
  }, env.SHUTDOWN_TIMEOUT_MS).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
