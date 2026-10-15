import type { Logger } from "../lib/logger.js";
import { HttpProblem } from "../lib/problem.js";
import type { PaymentService } from "../payments/payment-service.js";
import { type CommandEnvelope, type CommandHandler, InvalidCommand } from "./command-consumer.js";

/**
 * RefundRequested from the saga. The command's idempotency key is the refund's idempotency key, so a
 * redelivered or re-sent command never creates a second refund (and the provider receives
 * `refund:{refundId}` as ITS idempotency key: no double refund at the provider either).
 */
export class RefundCommandHandler implements CommandHandler {
  constructor(
    private readonly payments: PaymentService,
    private readonly logger: Logger,
  ) {}

  async handle(cmd: CommandEnvelope): Promise<void> {
    if (cmd.messageType !== "RefundRequested") throw new InvalidCommand(`no handler for ${cmd.messageType}`);
    const p = cmd.payload as { paymentId: string; orderId: string; amount: { amountMinor: number; currency: string }; reason: string };
    const meta = { correlationId: cmd.correlationId, causationId: cmd.messageId };
    const existing = await this.payments.findRefundByKey(cmd.idempotencyKey);
    if (existing) {
      // Duplicate (redelivered or re-sent): never a second refund, but answer again if it is final.
      const answered = await this.payments.reemitRefundOutcome(existing.id, meta);
      this.logger.info({ refundId: existing.id, status: existing.status, answered }, "duplicate refund command");
      return;
    }
    try {
      const refund = await this.payments.requestRefund(
        cmd.idempotencyKey,
        { paymentId: p.paymentId, amountMinor: BigInt(p.amount.amountMinor), reason: p.reason },
        cmd.producer,
        meta,
      );
      this.logger.info({ refundId: refund.id, status: refund.status, paymentId: p.paymentId }, "refund requested");
    } catch (err) {
      if (err instanceof HttpProblem && err.code === "NOT_FOUND") throw new InvalidCommand(`unknown payment ${p.paymentId}`);
      throw err; // infrastructure: retry
    }
  }
}
