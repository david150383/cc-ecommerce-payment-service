# ---- build: compile TypeScript ----
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---- prod: production dependencies + compiled JS + SQL migrations + command schemas ----
FROM node:24-alpine AS prod
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
# The RefundRequested consumer validates against these at runtime.
COPY events/schemas ./events/schemas
USER node

# ---- migrate: one-off job that applies SQL migrations (node-pg-migrate), then exits ----
FROM prod AS migrate
CMD ["npx", "node-pg-migrate", "up", "--migrations-dir", "migrations", "--migration-file-language", "sql"]

# ---- runtime (last stage = the default for a plain `docker build .`) ----
FROM prod AS runtime
EXPOSE 4005
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s \
  CMD wget -qO- "http://127.0.0.1:${PORT:-4005}/health/live" >/dev/null || exit 1
CMD ["node", "dist/server.js"]
