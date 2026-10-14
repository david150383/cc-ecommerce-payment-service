import type { Env } from "../config/env.js";
import type { Pool } from "../db/pool.js";
import type { Logger } from "../lib/logger.js";
import type { PaymentService } from "../payments/payment-service.js";
import { createSns, createSqs } from "./aws.js";
import { CommandConsumer } from "./command-consumer.js";
import { commandParser } from "./command-schemas.js";
import { OutboxRelay } from "./outbox-relay.js";
import { RefundCommandHandler } from "./refund-command-handler.js";

/** Background loops: outbox relay, refund-command consumer, and reconciliation. */
export function createWorkers(env: Env, db: Pool, payments: PaymentService, logger: Logger) {
  const relay = new OutboxRelay(db, createSns(env), env.EVENTS_TOPIC_ARN, env.OUTBOX_POLL_INTERVAL_MS, logger);
  const consumer = new CommandConsumer(createSqs(env), env.COMMANDS_QUEUE_NAME, new RefundCommandHandler(payments, logger), commandParser(), logger, env.CONSUMER_WAIT_TIME_SECONDS);
  let timer: NodeJS.Timeout | undefined;
  let run: Promise<unknown> | undefined;
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    run = payments
      .reconcile()
      .then((r) => {
        if (r.payments + r.refunds > 0) logger.info(r, "reconciled with the provider");
      })
      .catch((err: unknown) => logger.error({ err }, "reconciliation failed"))
      .finally(() => {
        if (!stopped) timer = setTimeout(tick, env.RECONCILE_INTERVAL_MS);
      });
  };
  return {
    relay,
    consumer,
    start() {
      if (env.MESSAGING_ENABLED) {
        relay.start();
        consumer.start();
      }
      if (env.RECONCILE_INTERVAL_MS > 0) timer = setTimeout(tick, env.RECONCILE_INTERVAL_MS);
      logger.info({ messaging: env.MESSAGING_ENABLED, provider: env.PAYMENT_PROVIDER }, "payment workers started");
    },
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await consumer.stop();
      await run;
      await relay.stop();
    },
  };
}
