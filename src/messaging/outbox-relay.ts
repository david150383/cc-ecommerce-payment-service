import { PublishCommand, type SNSClient } from "@aws-sdk/client-sns";
import { type Pool, transaction } from "../db/pool.js";
import type { Logger } from "../lib/logger.js";

/**
 * Publishes committed outbox rows to SNS (payment-events). Rows are claimed FOR UPDATE SKIP LOCKED,
 * so several instances can relay; a failed publish leaves the row for the next tick. At-least-once:
 * consumers dedupe on messageId.
 */
export class OutboxRelay {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private stopped = false;

  constructor(
    private readonly db: Pool,
    private readonly sns: SNSClient,
    private readonly topicArn: string,
    private readonly intervalMs: number,
    private readonly logger: Logger,
    private readonly batchSize = 50,
  ) {}

  start(): void {
    const tick = () => {
      if (this.stopped) return;
      this.running = this.publishPending()
        .then(() => undefined)
        .catch((err: unknown) => this.logger.error({ err }, "outbox relay tick failed"))
        .finally(() => {
          if (!this.stopped) this.timer = setTimeout(tick, this.intervalMs);
        });
    };
    tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
  }

  async publishPending(): Promise<number> {
    let total = 0;
    for (;;) {
      const batch = await transaction(this.db, async (c) => {
        const { rows } = await c.query<{ seq: bigint; id: string; message_type: string; envelope: unknown }>(
          `SELECT seq, id, message_type, envelope FROM outbox WHERE published_at IS NULL ORDER BY seq LIMIT $1 FOR UPDATE SKIP LOCKED`,
          [this.batchSize],
        );
        let ok = 0;
        for (const row of rows) {
          try {
            await this.sns.send(
              new PublishCommand({
                TopicArn: this.topicArn,
                Message: JSON.stringify(row.envelope),
                MessageAttributes: { messageType: { DataType: "String", StringValue: row.message_type } },
              }),
            );
          } catch (err) {
            await c.query(`UPDATE outbox SET attempts = attempts + 1 WHERE seq = $1`, [row.seq]);
            this.logger.warn({ err, messageId: row.id, messageType: row.message_type }, "publish failed; will retry");
            return { ok, more: false };
          }
          await c.query(`UPDATE outbox SET published_at = now(), attempts = attempts + 1 WHERE seq = $1`, [row.seq]);
          ok++;
        }
        return { ok, more: rows.length === this.batchSize };
      });
      total += batch.ok;
      if (!batch.more) return total;
    }
  }
}
