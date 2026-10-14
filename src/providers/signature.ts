import { createHmac, timingSafeEqual } from "node:crypto";
import { InvalidSignature } from "./provider.js";

/**
 * The webhook signature scheme used by the mock provider. It is the same construction Stripe uses:
 *   header  = "t=<unix seconds>,v1=<hex HMAC-SHA256(secret, `${t}.${rawBody}`)>"
 * - signed over the RAW bytes (re-serialized JSON would not match)
 * - the timestamp is signed too and checked against a tolerance, so an old captured request
 *   cannot be replayed later
 * - compared in constant time, so the signature cannot be guessed byte by byte from timing
 */
export function sign(rawBody: string | Buffer, secret: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const mac = createHmac("sha256", secret).update(`${timestamp}.`).update(rawBody).digest("hex");
  return `t=${timestamp},v1=${mac}`;
}

export function verify(rawBody: Buffer, header: string | undefined, secret: string, toleranceSeconds = 300, now = Date.now()): void {
  if (!header) throw new InvalidSignature("missing signature header");
  const parts = new Map(header.split(",").map((kv) => kv.split("=", 2) as [string, string]));
  const t = Number(parts.get("t"));
  const v1 = parts.get("v1") ?? "";
  if (!Number.isInteger(t) || !/^[0-9a-f]{64}$/.test(v1)) throw new InvalidSignature("malformed signature header");
  if (Math.abs(now / 1000 - t) > toleranceSeconds) throw new InvalidSignature("timestamp outside tolerance");
  const expected = createHmac("sha256", secret).update(`${t}.`).update(rawBody).digest();
  const given = Buffer.from(v1, "hex");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new InvalidSignature("signature mismatch");
}
