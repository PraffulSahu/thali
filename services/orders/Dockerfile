# syntax=docker/dockerfile:1
# Orders service image. Build from the repo root:
#   docker build -f services/orders/Dockerfile -t thali/orders .
ARG NODE_IMAGE=node:22.20.0-alpine

# ---- build: install the workspace closure and compile with tsc -b ----
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/pricing/package.json packages/pricing/
COPY packages/service-kit/package.json packages/service-kit/
COPY services/orders/package.json services/orders/
RUN npm ci --workspace @thali/orders --include-workspace-root --ignore-scripts
COPY packages/contracts packages/contracts
COPY packages/pricing packages/pricing
COPY packages/service-kit packages/service-kit
COPY services/orders services/orders
RUN npx tsc -b services/orders

# ---- prod deps only ----
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/pricing/package.json packages/pricing/
COPY packages/service-kit/package.json packages/service-kit/
COPY services/orders/package.json services/orders/
RUN npm ci --omit=dev --workspace @thali/orders --include-workspace-root --ignore-scripts

# ---- runtime ----
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production PORT=4003
WORKDIR /app
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=deps --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/packages/contracts/package.json packages/contracts/package.json
COPY --from=build --chown=node:node /app/packages/contracts/dist packages/contracts/dist
COPY --from=build --chown=node:node /app/packages/pricing/package.json packages/pricing/package.json
COPY --from=build --chown=node:node /app/packages/pricing/dist packages/pricing/dist
COPY --from=build --chown=node:node /app/packages/service-kit/package.json packages/service-kit/package.json
COPY --from=build --chown=node:node /app/packages/service-kit/dist packages/service-kit/dist
COPY --from=build --chown=node:node /app/services/orders/package.json services/orders/package.json
COPY --from=build --chown=node:node /app/services/orders/dist services/orders/dist
USER node
EXPOSE 4003
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health/live" >/dev/null || exit 1
CMD ["node", "services/orders/dist/index.js"]
