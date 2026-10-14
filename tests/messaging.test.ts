import { CreateTopicCommand, SNSClient, SubscribeCommand } from "@aws-sdk/client-sns";
import { CreateQueueCommand, GetQueueAttributesCommand, ReceiveMessageCommand, SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createWorkers } from "../src/messaging/runner.js";
import { auth, buildTestContext, newId, resetDatabase, waitFor } from "./helpers.js";

// Runs against the local AWS emulator (Floci), with a private queue set and topic per run.
const endpoint = process.env.TEST_AWS_ENDPOINT_URL ?? "http://localhost:4566";
process.env.AWS_ACCESS_KEY_ID ??= "test";
process.env.AWS_SECRET_ACCESS_KEY ??= "test";
const sqs = new SQSClient({ region: "us-east-1", endpoint, useQueueUrlAsEndpoint: false });
const sns = new SNSClient({ region: "us-east-1", endpoint });

const id = newId().slice(-10);
const names = { commands: `t-${id}-payment-commands`, dlq: `t-${id}-payment-commands-dlq`, probe: `t-${id}-probe` };
let topicArn: string;
const url = (name: string) => `${endpoint}/000000000000/${name}`;
const arn = async (name: string) =>
  (await sqs.send(new GetQueueAttributesCommand({ QueueUrl: url(name), AttributeNames: ["QueueArn"] }))).Attributes!.QueueArn!;

async function drain(name: string, wait = 2) {
  const out: { messageType: string; payload: Record<string, unknown>; attr?: string }[] = [];
  for (let i = 0; i < 10; i++) {
    const { Messages = [] } = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: url(name), MaxNumberOfMessages: 10, WaitTimeSeconds: i === 0 ? wait : 1, VisibilityTimeout: 30, MessageAttributeNames: ["All"] }),
    );
    if (Messages.length === 0) break;
    for (const m of Messages) {
      let body;
      try {
        body = JSON.parse(m.Body!);
      } catch {
        body = { messageType: "(unparseable)", payload: {} };
      }
      out.push({ ...body, attr: m.MessageAttributes?.messageType?.StringValue });
    }
  }
  return out;
}

beforeAll(async () => {
  await sqs.send(new CreateQueueCommand({ QueueName: names.dlq }));
  await sqs.send(
    new CreateQueueCommand({
      QueueName: names.commands,
      Attributes: { VisibilityTimeout: "1", RedrivePolicy: JSON.stringify({ deadLetterTargetArn: await arn(names.dlq), maxReceiveCount: 2 }) },
    }),
  );
  await sqs.send(new CreateQueueCommand({ QueueName: names.probe }));
  topicArn = (await sns.send(new CreateTopicCommand({ Name: `t-${id}-payment-events` }))).TopicArn!;
  await sns.send(new SubscribeCommand({ TopicArn: topicArn, Protocol: "sqs", Endpoint: await arn(names.probe), Attributes: { RawMessageDelivery: "true" } }));
});

let ctx: Awaited<ReturnType<typeof buildTestContext>>;
let workers: ReturnType<typeof createWorkers>;

beforeEach(async () => {
  await resetDatabase();
  ctx = await buildTestContext({ AWS_ENDPOINT_URL: endpoint, EVENTS_TOPIC_ARN: topicArn, COMMANDS_QUEUE_NAME: names.commands, CONSUMER_WAIT_TIME_SECONDS: "1" });
  workers = createWorkers(ctx.env, ctx.db, ctx.payments, ctx.logger); // not started: driven step by step
  await drain(names.probe, 0);
});

async function paidPayment() {
  const order = ctx.orders.add();
  const { body } = await request(ctx.app).post("/api/v1/payments/intent").set(await auth(["service"])).set("Idempotency-Key", newId())
    .send({ orderId: order.id, returnUrl: "http://localhost:5173/r", sagaId: newId() });
  await ctx.mock.complete(body.payment.checkoutUrl.split("/").pop(), "pay");
  return { order, payment: body.payment as { id: string } };
}

describe("outbox relay", () => {
  it("publishes payment events to SNS with the messageType attribute (used by subscription filters)", async () => {
    await paidPayment();
    expect(await workers.relay.publishPending()).toBe(2);
    expect(await workers.relay.publishPending()).toBe(0); // marked published
    const got = await drain(names.probe);
    expect(got.map((m) => [m.messageType, m.attr])).toEqual([["PaymentInitiated", "PaymentInitiated"], ["PaymentSucceeded", "PaymentSucceeded"]]);
  });
});

describe("payment-commands consumer", () => {
  it("executes a RefundRequested command delivered over SQS (twice → one refund)", async () => {
    const { order, payment } = await paidPayment();
    const cmd = {
      messageId: newId(), messageKind: "command", messageType: "RefundRequested", messageVersion: 1, producer: "ecommerce-saga-orchestrator",
      occurredAt: new Date().toISOString(), correlationId: newId(), causationId: null, sagaId: newId(), idempotencyKey: `saga:refund:${payment.id}`,
      payload: { paymentId: payment.id, orderId: order.id, amount: { amountMinor: 117_764, currency: "INR" }, reason: "OUT_OF_STOCK_AFTER_PAYMENT" },
    };
    await sqs.send(new SendMessageCommand({ QueueUrl: url(names.commands), MessageBody: JSON.stringify(cmd) }));
    await sqs.send(new SendMessageCommand({ QueueUrl: url(names.commands), MessageBody: JSON.stringify({ ...cmd, messageId: newId() }) }));
    let n = 0;
    while (n < 2) n += await workers.consumer.pollOnce();
    expect((await ctx.db.query(`SELECT count(*)::int AS n FROM refunds`)).rows[0].n).toBe(1);
    await waitFor(async () => ((await ctx.db.query(`SELECT status FROM payments WHERE id = $1`, [payment.id])).rows[0].status === "REFUNDED" ? true : undefined));
  });

  it("malformed or invalid commands are never deleted: they end up in the DLQ", async () => {
    await sqs.send(new SendMessageCommand({ QueueUrl: url(names.commands), MessageBody: "{not json" }));
    await sqs.send(new SendMessageCommand({ QueueUrl: url(names.commands), MessageBody: JSON.stringify({ messageType: "RefundRequested", payload: { amount: -1 } }) }));
    for (let i = 0; i < 3; i++) {
      expect(await workers.consumer.pollOnce()).toBe(0);
      await new Promise((r) => setTimeout(r, 1_200));
    }
    await workers.consumer.pollOnce();
    expect(await drain(names.dlq, 3)).toHaveLength(2);
  });
});
