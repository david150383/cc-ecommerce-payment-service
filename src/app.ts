import cors from "cors";
import express, { type Express } from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import swaggerUi from "swagger-ui-express";
import { paymentRouter, webhookRouter } from "./api/routes.js";
import type { Env } from "./config/env.js";
import type { Logger } from "./lib/logger.js";
import { errorHandler, notFoundHandler } from "./middleware/error-handler.js";
import { requestContext } from "./middleware/request-context.js";
import { buildOpenApiDocument } from "./openapi/document.js";
import type { PaymentService } from "./payments/payment-service.js";
import type { MockProvider } from "./providers/mock-provider.js";
import { mockProviderRouter } from "./providers/mock-routes.js";
import { healthRouter, type ReadinessCheck } from "./routes/health.js";
import type { TokenVerifier } from "./security/token-verifier.js";

export interface AppDependencies {
  env: Env;
  logger: Logger;
  payments: PaymentService;
  verifier: TokenVerifier;
  /** Present only with PAYMENT_PROVIDER=mock: serves the hosted checkout page. */
  mock?: MockProvider | undefined;
  readinessChecks?: ReadinessCheck[];
}

// Builds the Express app without starting a server, so tests can drive it
// in-process with Supertest.
export function createApp({ env, logger, payments, verifier, mock, readinessChecks = [] }: AppDependencies): Express {
  const app = express();

  app.disable("x-powered-by");
  app.use(helmet());
  app.use(
    cors({
      origin: env.CORS_ALLOWED_ORIGINS,
      credentials: true,
      exposedHeaders: ["X-Correlation-Id", "X-Request-Id", "Location", "Idempotency-Replayed"],
    }),
  );
  app.use(requestContext);
  app.use(
    pinoHttp({
      logger,
      genReqId: (_req, res) => res.locals.requestId as string,
      customProps: (_req, res) => ({ correlationId: res.locals.correlationId as string }),
      autoLogging: { ignore: (req) => req.url?.startsWith("/health") ?? false },
      // Log only what is useful for tracing; headers can carry credentials and are noisy.
      serializers: {
        req: (req: { id: string; method: string; url: string }) => ({ id: req.id, method: req.method, url: req.url }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
    }),
  );
  // Webhooks first: they need the RAW body for signature verification, so they must not pass
  // through the JSON parser below.
  app.use(webhookRouter(payments, env.PAYMENT_PROVIDER));
  app.use(express.json({ limit: "100kb" }));

  app.use(healthRouter(readinessChecks));
  const openApi = buildOpenApiDocument();
  app.get("/openapi.json", (_req, res) => {
    res.json(openApi);
  });
  app.use("/docs", swaggerUi.serve, swaggerUi.setup(openApi));
  if (mock) app.use(mockProviderRouter(mock));
  app.use("/api/v1", paymentRouter(payments, verifier));

  app.use(notFoundHandler);
  app.use(errorHandler(logger));
  return app;
}
