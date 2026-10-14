import { HttpProblem } from "../lib/problem.js";
import type { ServiceTokenProvider } from "./service-token-provider.js";

export interface OrderView {
  id: string;
  customerId: string;
  status: string;
  total: { amountMinor: number; currency: string };
}

/** The authoritative order amount and owner. Tests substitute a fake. */
export interface OrderLookup {
  get(orderId: string): Promise<OrderView | null>;
}

export class HttpOrderLookup implements OrderLookup {
  constructor(
    private readonly baseUrl: string,
    private readonly tokens: ServiceTokenProvider,
    private readonly timeoutMs: number,
  ) {}

  async get(orderId: string): Promise<OrderView | null> {
    const audience = "ecommerce-order-service";
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/internal/v1/orders/${orderId}`, {
        headers: { authorization: `Bearer ${await this.tokens.token(audience)}` },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new HttpProblem(503, "DEPENDENCY_UNAVAILABLE", "Order Service unreachable", undefined, undefined, { cause: err });
    }
    if (res.status === 404) return null;
    if (res.status === 401) this.tokens.invalidate(audience);
    if (!res.ok) throw new HttpProblem(503, "DEPENDENCY_UNAVAILABLE", `Order Service responded ${res.status}`);
    return (await res.json()) as OrderView;
  }
}
