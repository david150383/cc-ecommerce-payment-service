import { Writable } from "node:stream";
import { type CryptoKey, exportJWK, generateKeyPair, type JSONWebKeySet, SignJWT } from "jose";
import { pino } from "pino";
import request from "supertest";
import { v7 as uuidv7 } from "uuid";
import { createApp } from "../src/app.js";
import type { OrderLookup, OrderView } from "../src/clients/order-client.js";
import { loadEnv } from "../src/config/env.js";
import { createPool, type Pool } from "../src/db/pool.js";
import { PaymentService } from "../src/payments/payment-service.js";
import { MockProvider } from "../src/providers/mock-provider.js";
import type { PaymentProvider } from "../src/providers/provider.js";
import type { ReadinessCheck } from "../src/routes/health.js";
import { TokenVerifier } from "../src/security/token-verifier.js";
import { TEST_DATABASE_URL } from "./global-setup.js";

export const WEBHOOK_SECRET = "test-mock-webhook-secret";

/** Stands in for the Order Service's internal order view. */
export class FakeOrders implements OrderLookup {
  readonly orders = new Map<string, OrderView>();
  down = false;

  add(over: Partial<OrderView> = {}): OrderView {
    const o: OrderView = { id: uuidv7(), customerId: uuidv7(), status: "INVENTORY_RESERVED", total: { amountMinor: 117_764, currency: "INR" }, ...over };
    this.orders.set(o.id, o);
    return o;
  }

  async get(id: string): Promise<OrderView | null> {
    if (this.down) throw new Error("order service down");
    return this.orders.get(id) ?? null;
  }
}

let keys: Promise<{ privateKey: CryptoKey; jwks: JSONWebKeySet }> | undefined;
function testKeys() {
  keys ??= generateKeyPair("RS256").then(async ({ privateKey, publicKey }) => ({
    privateKey,
    jwks: { keys: [{ ...(await exportJWK(publicKey)), kid: "test-key", alg: "RS256", use: "sig" }] },
  }));
  return keys;
}

export async function auth(roles: string[], sub = uuidv7()) {
  const { privateKey } = await testKeys();
  const token = await new SignJWT({ roles })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer("ecommerce-auth-service")
    .setAudience(roles.includes("service") ? "ecommerce-payment-service" : "ecommerce-api")
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(privateKey);
  return { Authorization: `Bearer ${token}` };
}

let pool: Pool | undefined;
export function testPool(): Pool {
  pool ??= createPool(TEST_DATABASE_URL, 20);
  return pool;
}

export async function resetDatabase(): Promise<void> {
  await testPool().query("TRUNCATE payments, refunds, webhook_events, outbox CASCADE");
}

export async function buildTestContext(
  overrides: Record<string, string> = {},
  readinessChecks: ReadinessCheck[] = [],
  provider?: (sink: (raw: string, headers: Record<string, string>) => Promise<void>) => PaymentProvider,
) {
  const env = loadEnv({ NODE_ENV: "test", LOG_LEVEL: "silent", DATABASE_URL: TEST_DATABASE_URL, RECONCILE_INTERVAL_MS: "0", ...overrides });
  const logger = pino({ level: env.LOG_LEVEL }, new Writable({ write: (_c, _e, cb) => cb() }));
  const orders = new FakeOrders();
  const webhookResults: { status: number; body: unknown }[] = [];
  // The mock provider delivers its signed webhooks INTO the app under test, over (in-process) HTTP.
  const target: { app?: ReturnType<typeof createApp> } = {}; // set below; the sink only runs later
  const sink = async (raw: string, headers: Record<string, string>) => {
    const res = await request(target.app!).post(`/api/v1/payments/webhooks/${env.PAYMENT_PROVIDER}`).set(headers).send(raw);
    webhookResults.push({ status: res.status, body: res.body });
    if (res.status >= 300) throw new Error(`webhook rejected: ${res.status}`);
  };
  const mock = new MockProvider({ publicBaseUrl: "http://localhost:4005", webhookSecret: WEBHOOK_SECRET, refundDelayMs: 20 }, sink);
  const chosen = provider ? provider(sink) : mock;
  const payments = new PaymentService(testPool(), chosen, orders, { checkoutExpiryMinutes: 30, reconcileAfterSeconds: 1 }, logger);
  const verifier = new TokenVerifier(
    { jwksUrl: "http://unused.invalid/jwks", issuer: "ecommerce-auth-service", audiences: ["ecommerce-api", "ecommerce-payment-service"] },
    (await testKeys()).jwks,
  );
  const app = (target.app = createApp({ env, logger, payments, verifier, mock: chosen === mock ? mock : undefined, readinessChecks }));
  return { app, payments, orders, mock, env, logger, db: testPool(), webhookResults };
}

export const newId = () => uuidv7();

export async function outbox() {
  const { rows } = await testPool().query(`SELECT message_type AS type, envelope FROM outbox ORDER BY seq`);
  return rows as { type: string; envelope: { sagaId: string | null; payload: Record<string, unknown> } }[];
}

export async function waitFor<T>(fn: () => Promise<T | undefined> | T | undefined, timeoutMs = 3_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}
