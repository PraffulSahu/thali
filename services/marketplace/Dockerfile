# syntax=docker/dockerfile:1
# Build from the repo root:  docker build -f services/marketplace/Dockerfile .
FROM node:22.20.0-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json .npmrc tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/pricing/package.json packages/pricing/
COPY packages/service-kit/package.json packages/service-kit/
COPY services/marketplace/package.json services/marketplace/
RUN npm ci --workspace @thali/marketplace --include-workspace-root
COPY packages/contracts packages/contracts
COPY packages/pricing packages/pricing
COPY packages/service-kit packages/service-kit
COPY services/marketplace services/marketplace
RUN npx tsc -b services/marketplace

FROM node:22.20.0-alpine AS deps
WORKDIR /repo
COPY package.json package-lock.json .npmrc ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/pricing/package.json packages/pricing/
COPY packages/service-kit/package.json packages/service-kit/
COPY services/marketplace/package.json services/marketplace/
RUN npm ci --omit=dev --workspace @thali/marketplace --include-workspace-root && npm cache clean --force

FROM node:22.20.0-alpine AS runtime
ENV NODE_ENV=production PORT=4002
WORKDIR /repo
COPY --from=deps --chown=node:node /repo/node_modules node_modules
COPY --from=deps --chown=node:node /repo/package.json package.json
COPY --from=build --chown=node:node /repo/packages/contracts/package.json packages/contracts/package.json
COPY --from=build --chown=node:node /repo/packages/contracts/dist packages/contracts/dist
COPY --from=build --chown=node:node /repo/packages/pricing/package.json packages/pricing/package.json
COPY --from=build --chown=node:node /repo/packages/pricing/dist packages/pricing/dist
COPY --from=build --chown=node:node /repo/packages/service-kit/package.json packages/service-kit/package.json
COPY --from=build --chown=node:node /repo/packages/service-kit/dist packages/service-kit/dist
COPY --from=build --chown=node:node /repo/services/marketplace/package.json services/marketplace/package.json
COPY --from=build --chown=node:node /repo/services/marketplace/dist services/marketplace/dist
USER node
WORKDIR /repo/services/marketplace
EXPOSE 4002
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4002)+'/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
