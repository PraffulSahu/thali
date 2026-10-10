# syntax=docker/dockerfile:1
# Thali marketplace service (port 4002). Build context = repository root:
#   docker build -f services/marketplace/Dockerfile -t thali-marketplace .
#
# All service Dockerfiles share byte-identical "install" and "packages" stages, so BuildKit builds the
# workspace install and the shared packages (contracts, pricing, service-kit) once and reuses the cache
# for every service image. npm ci validates the lockfile against every workspace manifest, so all
# manifests are copied. Keep this file in sync with the other services/*/Dockerfile.
ARG NODE_IMAGE=node:22.20.0-alpine3.22

# ---- install: full workspace install (dev deps incl. typescript), no lifecycle scripts ----
FROM ${NODE_IMAGE} AS install
WORKDIR /repo
COPY package.json package-lock.json .npmrc tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/pricing/package.json packages/pricing/
COPY packages/service-kit/package.json packages/service-kit/
COPY services/identity/package.json services/identity/
COPY services/marketplace/package.json services/marketplace/
COPY services/orders/package.json services/orders/
COPY services/payments/package.json services/payments/
COPY services/delivery/package.json services/delivery/
COPY services/notifications/package.json services/notifications/
COPY services/gateway/package.json services/gateway/
COPY apps/web/package.json apps/web/
COPY e2e/package.json e2e/
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts --no-audit --no-fund

# ---- packages: compile the shared workspace packages ----
FROM install AS packages
COPY packages/contracts packages/contracts
COPY packages/pricing packages/pricing
COPY packages/service-kit packages/service-kit
RUN npx tsc -b packages/contracts packages/pricing packages/service-kit

# ---- build: compile this service ----
FROM packages AS build
COPY services/marketplace services/marketplace
RUN npx tsc -b services/marketplace

# ---- deps: production dependencies of this service only ----
FROM ${NODE_IMAGE} AS deps
WORKDIR /repo
COPY package.json package-lock.json .npmrc tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/pricing/package.json packages/pricing/
COPY packages/service-kit/package.json packages/service-kit/
COPY services/identity/package.json services/identity/
COPY services/marketplace/package.json services/marketplace/
COPY services/orders/package.json services/orders/
COPY services/payments/package.json services/payments/
COPY services/delivery/package.json services/delivery/
COPY services/notifications/package.json services/notifications/
COPY services/gateway/package.json services/gateway/
COPY apps/web/package.json apps/web/
COPY e2e/package.json e2e/
RUN --mount=type=cache,target=/root/.npm \
  npm ci --workspace @thali/marketplace --omit=dev --ignore-scripts --no-audit --no-fund

# ---- runtime ----
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production SERVICE_NAME=marketplace PORT=4002
WORKDIR /repo
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/package.json ./package.json
COPY --from=build /repo/packages/contracts/package.json packages/contracts/package.json
COPY --from=build /repo/packages/contracts/dist packages/contracts/dist
COPY --from=build /repo/packages/pricing/package.json packages/pricing/package.json
COPY --from=build /repo/packages/pricing/dist packages/pricing/dist
COPY --from=build /repo/packages/service-kit/package.json packages/service-kit/package.json
COPY --from=build /repo/packages/service-kit/dist packages/service-kit/dist
COPY --from=build /repo/services/marketplace/package.json services/marketplace/package.json
COPY --from=build /repo/services/marketplace/dist services/marketplace/dist
USER node
WORKDIR /repo/services/marketplace
EXPOSE 4002
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health/live" >/dev/null || exit 1
CMD ["node", "dist/index.js"]
