# syntax=docker/dockerfile:1
# Build context: repository root  (docker build -f services/notifications/Dockerfile .)

FROM node:22.20.0-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/service-kit/package.json packages/service-kit/
COPY services/notifications/package.json services/notifications/
RUN npm ci --workspace @thali/notifications --include-workspace-root --ignore-scripts
COPY packages/contracts packages/contracts
COPY packages/service-kit packages/service-kit
COPY services/notifications services/notifications
RUN npx tsc -b services/notifications

FROM node:22.20.0-alpine AS deps
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/service-kit/package.json packages/service-kit/
COPY services/notifications/package.json services/notifications/
RUN npm ci --workspace @thali/notifications --omit=dev --ignore-scripts && npm cache clean --force

FROM node:22.20.0-alpine AS runtime
ENV NODE_ENV=production PORT=4006
WORKDIR /repo
COPY --from=deps --chown=node:node /repo/node_modules ./node_modules
COPY --from=deps --chown=node:node /repo/package.json ./package.json
COPY --from=build --chown=node:node /repo/packages/contracts/package.json packages/contracts/package.json
COPY --from=build --chown=node:node /repo/packages/contracts/dist packages/contracts/dist
COPY --from=build --chown=node:node /repo/packages/service-kit/package.json packages/service-kit/package.json
COPY --from=build --chown=node:node /repo/packages/service-kit/dist packages/service-kit/dist
COPY --from=build --chown=node:node /repo/services/notifications/package.json services/notifications/package.json
COPY --from=build --chown=node:node /repo/services/notifications/dist services/notifications/dist
USER node
WORKDIR /repo/services/notifications
EXPOSE 4006
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health/live" >/dev/null || exit 1
CMD ["node", "dist/index.js"]
