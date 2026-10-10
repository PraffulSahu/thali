# syntax=docker/dockerfile:1
# Thali payments service. Build context = repository root:
#   docker build -f services/payments/Dockerfile -t thali-payments .

# ---- build: install the payments workspace closure and compile (contracts, service-kit, payments) ----
FROM node:22.20.0-alpine AS build
WORKDIR /repo
# npm ci validates the lockfile against every workspace manifest, so all manifests must be present.
COPY package.json package-lock.json tsconfig.base.json .npmrc ./
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
RUN npm ci --workspace @thali/payments --include-workspace-root --ignore-scripts
COPY packages/contracts packages/contracts
COPY packages/service-kit packages/service-kit
COPY services/payments services/payments
RUN npx tsc -b services/payments

# ---- deps: production dependencies only ----
FROM node:22.20.0-alpine AS deps
WORKDIR /repo
COPY package.json package-lock.json .npmrc ./
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
RUN npm ci --workspace @thali/payments --omit=dev --ignore-scripts && npm cache clean --force

# ---- runtime ----
FROM node:22.20.0-alpine AS runtime
ENV NODE_ENV=production PORT=4004
WORKDIR /repo
COPY --from=deps --chown=node:node /repo/node_modules ./node_modules
COPY --from=deps --chown=node:node /repo/package.json ./package.json
COPY --from=build --chown=node:node /repo/packages/contracts/package.json packages/contracts/package.json
COPY --from=build --chown=node:node /repo/packages/contracts/dist packages/contracts/dist
COPY --from=build --chown=node:node /repo/packages/service-kit/package.json packages/service-kit/package.json
COPY --from=build --chown=node:node /repo/packages/service-kit/dist packages/service-kit/dist
COPY --from=build --chown=node:node /repo/services/payments/package.json services/payments/package.json
COPY --from=build --chown=node:node /repo/services/payments/dist services/payments/dist
USER node
WORKDIR /repo/services/payments
EXPOSE 4004
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health/live" >/dev/null || exit 1
CMD ["node", "dist/index.js"]
