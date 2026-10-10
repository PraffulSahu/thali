# syntax=docker/dockerfile:1
# Thali gateway. Build context = repository root:
#   docker build -f services/gateway/Dockerfile -t thali-gateway .

# ---- build: install the gateway workspace closure and compile (contracts, service-kit, gateway) ----
FROM node:22.20.0-alpine3.22 AS build
WORKDIR /app
# npm ci validates the lockfile against every workspace manifest, so all manifests must be present.
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/pricing/package.json packages/pricing/
COPY packages/service-kit/package.json packages/service-kit/
COPY services/gateway/package.json services/gateway/
COPY services/identity/package.json services/identity/
COPY services/marketplace/package.json services/marketplace/
COPY services/orders/package.json services/orders/
COPY services/payments/package.json services/payments/
COPY services/delivery/package.json services/delivery/
COPY services/notifications/package.json services/notifications/
COPY apps/web/package.json apps/web/
COPY e2e/package.json e2e/
RUN npm ci --workspace @thali/gateway --include-workspace-root
COPY packages/contracts packages/contracts
COPY packages/service-kit packages/service-kit
COPY services/gateway services/gateway
RUN npx tsc -b services/gateway

# ---- prod deps only ----
FROM build AS prod-deps
RUN npm ci --workspace @thali/gateway --include-workspace-root --omit=dev

# ---- runtime ----
FROM node:22.20.0-alpine3.22 AS runtime
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build --chown=node:node /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=build --chown=node:node /app/packages/service-kit/package.json ./packages/service-kit/package.json
COPY --from=build --chown=node:node /app/packages/service-kit/dist ./packages/service-kit/dist
COPY --from=build --chown=node:node /app/services/gateway/package.json ./services/gateway/package.json
COPY --from=build --chown=node:node /app/services/gateway/dist ./services/gateway/dist
USER node
WORKDIR /app/services/gateway
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health/live" >/dev/null || exit 1
CMD ["node", "dist/index.js"]
