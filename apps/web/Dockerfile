# syntax=docker/dockerfile:1
# Thali web SPA. Build context = repository root:
#   docker build -f apps/web/Dockerfile -t thali-web .
# Serves the Vite build with nginx (infra/nginx/web.conf): SPA fallback + /api proxy to gateway:8080
# (unbuffered for /api/v1/realtime SSE). Compose maps 5173 -> 8080 (non-root nginx).

# ---- build: install the web workspace closure and run `tsc --noEmit && vite build` ----
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
RUN npm ci --workspace @thali/web --include-workspace-root
# The web build compiles workspace packages from source (vite alias + tsconfig paths): no prebuild needed.
COPY packages/contracts packages/contracts
COPY packages/pricing packages/pricing
COPY apps/web apps/web
RUN npm run build -w @thali/web && rm -f apps/web/dist/assets/*.map

# ---- runtime: static files + reverse proxy ----
# nginx-unprivileged: same nginx build, runs as uid 101 (non-root) and listens on 8080.
FROM nginxinc/nginx-unprivileged:1.28.0-alpine AS runtime
COPY infra/nginx/web.conf /etc/nginx/conf.d/default.conf
COPY infra/nginx/security-headers.conf /etc/nginx/snippets/thali-security-headers.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/ || exit 1
