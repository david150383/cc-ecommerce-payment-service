import express, { Router } from "express";
import type { MockProvider } from "./mock-provider.js";

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * The mock provider's "hosted checkout page" (LOCAL DEVELOPMENT ONLY: refused in production by config).
 * Clicking Pay/Decline makes the mock provider send a SIGNED webhook to this service, exactly like a
 * real provider, then redirects the browser to the return URL, which by itself proves nothing.
 */
export function mockProviderRouter(mock: MockProvider): Router {
  const router = Router();
  // Relaxed CSP for this dev page only: the form posts here and then redirects to the storefront.
  const csp: express.RequestHandler = (_req, res, next) => {
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action *");
    next();
  };

  router.get("/mock-provider/checkout/:sessionId", csp, (req, res) => {
    const s = mock.sessions.get(String(req.params.sessionId));
    if (!s) return void res.status(404).type("text/plain").send("Unknown or expired checkout session");
    const amount = (Number(s.amountMinor) / 100).toFixed(2);
    res.type("html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Mock checkout</title>
<style>body{font-family:system-ui;max-width:28rem;margin:4rem auto;padding:0 1rem}button{padding:.6rem 1.2rem;margin-right:.5rem;font-size:1rem}</style></head>
<body><h1>Mock payment provider</h1><p>Local development only. No real money moves.</p>
<p>Amount: <strong>${escape(s.currency)} ${escape(amount)}</strong></p><p>Session: <code>${escape(s.sessionId)}</code> (${escape(s.state)})</p>
<form method="post" action="/mock-provider/checkout/${escape(s.sessionId)}/complete">
<button name="outcome" value="pay">Pay</button><button name="outcome" value="decline">Decline</button></form></body></html>`);
  });

  router.post("/mock-provider/checkout/:sessionId/complete", csp, express.urlencoded({ extended: false }), async (req, res) => {
    const outcome = (req.body as { outcome?: string }).outcome === "pay" ? "pay" : "decline";
    const s = await mock.complete(String(req.params.sessionId), outcome);
    const sep = s.returnUrl.includes("?") ? "&" : "?";
    res.redirect(303, `${s.returnUrl}${sep}result=${outcome === "pay" ? "success" : "cancelled"}`);
  });

  return router;
}
