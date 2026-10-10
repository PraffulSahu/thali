# Architecture Decision Records

Each ADR: context → decision → consequences. Status: accepted (2026-10-10) unless noted.

## ADR-001 Monorepo with npm workspaces
pnpm/turbo not installed in the target environment; npm 10 workspaces are sufficient for 3 shared
packages + 7 services + 1 app. Shared code is built with `tsc -b` project references. Each
service has its own Dockerfile building only its dependency closure.

## ADR-002 One MongoDB replica set, one database per service
Pilot cost/ops favors one cluster. Isolation is enforced by (a) separate databases
`thali_<svc>`, (b) per-service connection strings (production: per-service DB users with
`readWrite` on their own DB only — documented in deployment guide), (c) no shared models.
Single-node replica set `rs0` locally because transactions require a replica set.

## ADR-003 Transactional outbox + Redis Streams for events; Mongo-backed sweepers for timers
Alternatives: RabbitMQ/NATS/Kafka (extra infra), BullMQ (job queue, awkward fan-out).
Redis is already required for rate limiting; Streams give consumer groups, pending-entry lists
(retries) and replay. Durability comes from the **outbox** (source of truth) plus AOF.
Timers (checkout expiry, acceptance window, offer TTL, refund retries, notification retries)
are stored as fields in Mongo and processed by leader-locked sweepers — durable across restarts
and inspectable. Path to scale: swap the relay/consumer transport for NATS JetStream or Kafka.

## ADR-004 Stock reservations owned by Marketplace (refines brief)
The brief places inventory reservations in Orders, but stock counts live with menu items in
Marketplace. Atomic "decrement if available" must execute where the stock document lives, so
Marketplace owns `stock_reservations` and exposes an idempotent reservation API keyed by
`checkoutId`. Orders orchestrates (saga) and never touches marketplace data directly. Coupon
holds and membership usage holds live in the same marketplace transaction for the same reason.

## ADR-005 Support tickets in Orders service
Tickets are overwhelmingly order-scoped and need order ownership checks. A separate support
service would add a deployable without new data ownership benefits for the pilot. Tickets
live in `thali_orders.support_tickets` with their own module/routes; extraction later is easy
since they only reference order ids.

## ADR-006 Central audit log in Identity via events
Every service emits `audit.recorded` via its outbox inside the same transaction as the
privileged change; Identity consumes and stores them in `audit_logs`. Gives one searchable
admin view without cross-service DB access, and audit writes cannot be lost if the action
committed.

## ADR-007 SSE realtime hub in Notifications
Notifications already consumes all domain events. SSE (not WebSockets) is enough for
server→client pushes, works through the gateway proxy, and degrades to polling. Redis pub/sub
fans out across instances. Partner location pings go partner→delivery (HTTP POST) →
Redis pub/sub → customer SSE; they are ephemeral and not written to the durable stream.

## ADR-008 Auth: EdDSA access JWT + rotating refresh cookie
Bearer access tokens avoid CSRF on the API surface; refresh cookie is httpOnly + SameSite=Strict
+ path-scoped with origin/header CSRF checks. Services verify JWTs locally via JWKS (no identity
round-trip per request) and check a Redis revocation key for immediate logout.

## ADR-009 Providers via plain `fetch` adapters, not SDKs
Uniform timeouts (`AbortSignal.timeout`), error mapping, retries and test doubles; fewer
dependencies to pin. Implemented against the providers' documented REST APIs:
Razorpay (`/v1/orders`, `/v1/payments/:id`, `/v1/payments/:id/capture`, `/v1/payments/:id/refund`,
`/v1/refunds/:id`; webhook HMAC-SHA256 of raw body), Twilio (`/2010-04-01/Accounts/:sid/Messages.json`;
`X-Twilio-Signature` HMAC-SHA1 of URL + sorted params), Resend (`POST /emails`; Svix-signed
webhooks), Google (Geocoding API, Routes API `computeRoutes`), S3 (AWS SDK v3 — the one SDK used,
because SigV4 presigning is non-trivial).

## ADR-010 Payouts recorded after manual settlement
Automated disbursement (RazorpayX Payouts) requires a current account + KYC approvals unlikely
for a pilot. Ledger tracks earnings → available balance → payout REQUESTED → admin confirms with
bank UTR → PAID (ledger PAYOUT entry). UI never shows "paid" without a confirmed UTR.

## ADR-011 Demo payment flow goes through the real webhook pipeline
The mock payment provider's "demo pay" page posts to payments, which emits an HMAC-signed
webhook (with `MOCK_WEBHOOK_SECRET`) to its own webhook endpoint. This exercises signature
verification, dedupe and out-of-order handling exactly like Razorpay, while being impossible to
enable in production (startup guard).

## ADR-012 Single SPA with four role areas
One Vite React app (`/`, `/restaurant/*`, `/partner/*`, `/admin/*`) shares the design system,
API client and auth. Route guards are UX only; authorization is server-side.

## ADR-013 Express 5 + Mongoose 8 + Zod 4 + zod-to-openapi
OpenAPI is generated from the same Zod schemas used for validation, keeping docs synchronized
with implementation. Mature majors chosen over brand-new ones (TS 5.9 not 7, Vitest 3, Vite 7,
React Router 7) to minimize integration risk; all exact-pinned.
