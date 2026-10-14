-- Up Migration

CREATE TYPE payment_status AS ENUM (
  'PENDING',             -- checkout session created; waiting for the customer
  'SUCCEEDED',           -- captured (verified webhook or server-side status query)
  'FAILED',              -- declined / cancelled
  'EXPIRED',             -- the checkout session expired unpaid
  'PARTIALLY_REFUNDED',
  'REFUNDED'
);

CREATE TABLE payments (
  id                    uuid PRIMARY KEY,
  order_id              uuid NOT NULL,
  customer_id           uuid NOT NULL,
  saga_id               uuid,
  idempotency_key       varchar(255) NOT NULL,
  provider              varchar(20) NOT NULL CHECK (provider IN ('mock', 'stripe')),
  amount_minor          bigint NOT NULL CHECK (amount_minor > 0),   -- from the Order Service, never from the caller
  currency              char(3) NOT NULL,
  status                payment_status NOT NULL DEFAULT 'PENDING',
  provider_session_id   varchar(255),         -- e.g. Stripe Checkout Session cs_…
  provider_payment_ref  varchar(255),         -- e.g. Stripe PaymentIntent pi_… (needed for refunds)
  checkout_url          text,
  expires_at            timestamptz NOT NULL,
  failure_code          varchar(50),
  refunded_minor        bigint NOT NULL DEFAULT 0,
  version               integer NOT NULL DEFAULT 1,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_payments_idempotency_key UNIQUE (idempotency_key),
  CONSTRAINT uq_payments_order UNIQUE (order_id),               -- one payment per order
  CONSTRAINT uq_payments_provider_session UNIQUE (provider, provider_session_id),
  CONSTRAINT ck_payments_refund_within_amount CHECK (refunded_minor >= 0 AND refunded_minor <= amount_minor)
);
CREATE INDEX ix_payments_customer ON payments (customer_id, created_at DESC);
-- Reconciliation: payments still waiting on the provider.
CREATE INDEX ix_payments_pending ON payments (created_at) WHERE status = 'PENDING';

CREATE TYPE refund_status AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');

CREATE TABLE refunds (
  id                  uuid PRIMARY KEY,
  payment_id          uuid NOT NULL REFERENCES payments (id),
  amount_minor        bigint NOT NULL CHECK (amount_minor > 0),
  reason              varchar(50) NOT NULL,
  status              refund_status NOT NULL DEFAULT 'PENDING',
  provider_refund_id  varchar(255),
  idempotency_key     varchar(255) NOT NULL,
  failure_code        varchar(50),
  requested_by        varchar(255) NOT NULL,      -- saga, or an admin user id
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_refunds_idempotency_key UNIQUE (idempotency_key),
  CONSTRAINT uq_refunds_provider_refund UNIQUE (provider_refund_id)
);
CREATE INDEX ix_refunds_payment ON refunds (payment_id);
CREATE INDEX ix_refunds_pending ON refunds (created_at) WHERE status = 'PENDING';

-- Every webhook delivery accepted. The UNIQUE constraint is the dedupe: providers retry until
-- they get a 2xx, and may deliver the same event more than once.
CREATE TABLE webhook_events (
  id                 bigserial PRIMARY KEY,
  provider           varchar(20) NOT NULL,
  provider_event_id  varchar(255) NOT NULL,
  event_type         varchar(100) NOT NULL,
  received_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_webhook_events_provider_event UNIQUE (provider, provider_event_id)
);

-- Transactional outbox (events to SNS payment-events).
CREATE TABLE outbox (
  seq           bigserial PRIMARY KEY,
  id            uuid NOT NULL UNIQUE,
  message_type  varchar(100) NOT NULL,
  envelope      jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  published_at  timestamptz,
  attempts      integer NOT NULL DEFAULT 0
);
CREATE INDEX ix_outbox_unpublished ON outbox (seq) WHERE published_at IS NULL;

-- Down Migration

DROP TABLE outbox;
DROP TABLE webhook_events;
DROP TABLE refunds;
DROP TYPE refund_status;
DROP TABLE payments;
DROP TYPE payment_status;
