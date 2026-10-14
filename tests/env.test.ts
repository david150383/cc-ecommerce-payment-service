import { describe, expect, it } from "vitest";
import { loadEnv } from "../src/config/env.js";

const required = { DATABASE_URL: "postgresql://u:p@localhost:5432/db" };

describe("loadEnv", () => {
  it("applies defaults", () => {
    const env = loadEnv(required);
    expect(env.PORT).toBe(4005);
    expect(env.CORS_ALLOWED_ORIGINS).toEqual(["http://localhost:5173"]);
  });

  it("parses comma-separated CORS origins", () => {
    const env = loadEnv({ ...required, CORS_ALLOWED_ORIGINS: "https://a.example, https://b.example" });
    expect(env.CORS_ALLOWED_ORIGINS).toEqual(["https://a.example", "https://b.example"]);
  });

  it("refuses the mock provider in production and Stripe without keys", () => {
    expect(() => loadEnv({ ...required, NODE_ENV: "production" })).toThrow(/mock is for local development only/);
    expect(() => loadEnv({ ...required, PAYMENT_PROVIDER: "stripe" })).toThrow(/requires STRIPE_SECRET_KEY/);
    expect(loadEnv({ ...required, PAYMENT_PROVIDER: "stripe", STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_x" }).PAYMENT_PROVIDER).toBe("stripe");
    expect(loadEnv({ ...required, STRIPE_SECRET_KEY: "", STRIPE_WEBHOOK_SECRET: "" }).STRIPE_SECRET_KEY).toBeUndefined();
    const live = { ...required, PAYMENT_PROVIDER: "stripe", STRIPE_SECRET_KEY: "sk_live_x", STRIPE_WEBHOOK_SECRET: "whsec_x" };
    expect(() => loadEnv(live)).toThrow(/only accepted when NODE_ENV=production/);
    expect(loadEnv({ ...live, NODE_ENV: "production" }).STRIPE_SECRET_KEY).toBe("sk_live_x");
  });

  it("rejects invalid configuration at startup", () => {
    expect(() => loadEnv({ ...required, PORT: "not-a-port" })).toThrow(/Invalid environment configuration/);
  });
});
