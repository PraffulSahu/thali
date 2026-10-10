# syntax=docker/dockerfile:1
# Build context: repository root  (docker build -f services/identity/Dockerfile .)

FROM node:22.20.0-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/service-kit/package.json packages/service-kit/
COPY services/identity/package.json services/identity/
RUN npm ci --workspace @thali/identity --include-workspace-root --ignore-scripts
COPY packages/contracts packages/contracts
COPY packages/service-kit packages/service-kit
COPY services/identity services/identity
RUN npx tsc -b services/identity

# Production deps. argon2 ships no musl prebuild, so it is compiled here (only argon2's install
# script runs; everything else is installed with --ignore-scripts).
FROM node:22.20.0-alpine AS deps
WORKDIR /repo
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/service-kit/package.json packages/service-kit/
COPY services/identity/package.json services/identity/
RUN npm ci --workspace @thali/identity --omit=dev --ignore-scripts \
  && npm rebuild argon2 \
  && npm cache clean --force

FROM node:22.20.0-alpine AS runtime
ENV NODE_ENV=production PORT=4001
WORKDIR /repo
COPY --from=deps --chown=node:node /repo/node_modules ./node_modules
COPY --from=deps --chown=node:node /repo/package.json ./package.json
COPY --from=build --chown=node:node /repo/packages/contracts/package.json packages/contracts/package.json
COPY --from=build --chown=node:node /repo/packages/contracts/dist packages/contracts/dist
COPY --from=build --chown=node:node /repo/packages/service-kit/package.json packages/service-kit/package.json
COPY --from=build --chown=node:node /repo/packages/service-kit/dist packages/service-kit/dist
COPY --from=build --chown=node:node /repo/services/identity/package.json services/identity/package.json
COPY --from=build --chown=node:node /repo/services/identity/dist services/identity/dist
USER node
WORKDIR /repo/services/identity
EXPOSE 4001
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health/live" >/dev/null || exit 1
# Bootstrap an admin inside the container: node dist/cli/bootstrap-admin.js --email ... --name ... --role SUPER_ADMIN
CMD ["node", "dist/index.js"]
