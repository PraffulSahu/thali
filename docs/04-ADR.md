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
because SigV4 presigning is non-trivial). Amended 2026-10-10: email in demo mode goes through
Mailpit's HTTP send API (`POST /api/v1/send`), not SMTP (see ADR-018).

## ADR-010 Payouts recorded after manual settlement
Automated disbursement (RazorpayX Payouts) requires a current account + KYC approvals unlikely
for a pilot. Ledger tracks earnings → available balance → payout REQUESTED → admin confirms with
bank UTR → PAID (ledger PAYOUT entry). UI never shows "paid" without a confirmed UTR.

## ADR-011 Demo payment flow goes through the real webhook pipeline
The mock payment provider's "demo pay" page posts to payments, which emits an HMAC-signed
webhook (with `MOCK_WEBHOOK_SECRET`) to its own webhook endpoint. This exercises signature
verification, dedupe and out-of-order handling exactly like Razorpay, while being impossible to
enable in production (startup guard).
Amended 2026-10-10: `POST /demo-pay/:intentId/complete` calls the same `ingestWebhook` function the
HTTP route uses (in-process, signature verified with `MOCK_WEBHOOK_SECRET`, dedupe and out-of-order rules
intact) instead of an HTTP self-POST; only the `express.raw` body parsing is skipped. The demo-pay routes
are mounted whenever `PAYMENT_PROVIDER=mock` (also in `sandbox`), and never in production because the
production guard refuses `mock`. Completing an intent that is not CREATED/AUTHORIZED/FAILED returns 409
`PAYMENT_INVALID_TRANSITION`. Mock refunds settle instantly but still go REQUESTED, PROCESSING, SUCCEEDED.

## ADR-012 Single SPA with four role areas
One Vite React app (`/`, `/restaurant/*`, `/partner/*`, `/admin/*`) shares the design system,
API client and auth. Route guards are UX only; authorization is server-side.

## ADR-013 Express 5 + Mongoose 8 + Zod 4 + zod-to-openapi
OpenAPI is generated from the same Zod schemas used for validation, keeping docs synchronized
with implementation. Mature majors chosen over brand-new ones (TS 5.9 not 7, Vitest 3, Vite 7,
React Router 7) to minimize integration risk; all exact-pinned.

---

## Decisions made during the build (rulings, 2026-10-10)

These record behaviour that differs from, or refines, the original LLD. The LLD was amended in the same
change where noted. Each is covered by tests named in [08-launch-checklist.md](08-launch-checklist.md).

## ADR-014 `payment.failed` is mirror-only; the sweeper decides
Context: Razorpay lets a customer retry on the same provider order after a failed attempt (payment
FAILED to CAPTURED is legal). If orders released the checkout on the first `payment.failed`, a successful
retry would arrive as a late payment and be auto-refunded, a surprising and costly UX.
Decision: orders only records `paymentStatus=FAILED` and a timeline entry. The checkout stays
`AWAITING_PAYMENT` with stock, coupon and membership holds intact. The expiry sweeper (reconcile-first)
moves it to EXPIRED or PAYMENT_FAILED and emits `checkout.released` after `CHECKOUT_TTL_SEC`. Marketplace
applies the same rule to membership purchases: `payment.failed` keeps the membership `PENDING_PAYMENT`
and a reconcile job expires it after `MEMBERSHIP_PENDING_TTL_SEC` (900 s).
Consequence: a failed payment holds stock up to the TTL (15 min). The payment SM gained
`CREATED to CAPTURED`, `FAILED to CAPTURED` and a `PARTIALLY_REFUNDED` self-loop (all SYSTEM only)
because the provider can capture without an observed authorization, retries after failure, and refund
partially several times. The delivery SM deliberately stays strict (PICKED_UP to OUT_FOR_DELIVERY via
`start` before DELIVERED): one extra partner tap.

## ADR-015 Discounts are platform-funded
Context: the brief's earning formula subtracted coupon and membership discounts from the restaurant's
earning, contradicting its own note that the platform funds discounts.
Decision: restaurant `ORDER_EARNING = itemsSubtotal + packagingFee`; `COMMISSION = -bps(itemsSubtotal,
commissionBps)` (commission is on the undiscounted items subtotal). The customer pays the discounted
amount; the difference is a platform cost. A `PLATFORM` mirror entry (`platform-commission:<child>`,
`accountId: platform`) is posted so admin balances for the platform account are meaningful; payouts to the
platform account are rejected. Only positive entries are subject to `PAYOUT_HOLD_DAYS`; negative entries
(commission, adjustments) apply immediately.
Consequence: restaurant payouts do not shrink with discounts; platform margin does. Finance must confirm
this commercial model before launch.

## ADR-016 A restaurant is deliverable only if inside the drop's service area
Decision: discovery and quote treat a restaurant as deliverable only when its location lies inside the
same active service-area polygon that contains the customer's drop point (PRD C-2), in addition to its own
`deliveryRadiusKm`. The service area also supplies the delivery-fee rule. A restaurant near an area edge may
therefore not be listed for drops just inside the neighbouring area even if it is geographically close.
Discovery sorts by per-request computed values, so it uses an opaque offset cursor (LLD 1.3 amended).

## ADR-017 Native `node:http` gateway proxy; fewer, fixed dependencies
Decision: the gateway streams requests with a small native `node:http` proxy instead of
`http-proxy-middleware` (its `micromatch`/`braces` advisory had no fix). No body parser is mounted, so
webhook bodies reach payments and notifications byte-identical (signatures are over the raw bytes); SSE is
unbuffered and uncompressed; dot-segment paths are rejected; hop-by-hop and spoofable forwarding headers are
stripped. For the same reason `nodemailer` was dropped (ADR-018) and Vitest moved to 4.1.11.
Consequence: roughly 400 more lines of gateway code to own, covered by `proxy.test.ts` and
`sse-proxy.test.ts`.

## ADR-018 Demo email through Mailpit's HTTP API
Decision: `EMAIL_PROVIDER=mailpit` posts to `MAILPIT_URL/api/v1/send` (no SMTP client; `nodemailer <10.0.2`
was vulnerable). The compose stack does not publish Mailpit's SMTP port. `EMAIL_PROVIDER=mailpit` and
`mock` are refused in production; `resend` is the production adapter.

## ADR-019 Browser-facing S3 endpoint is separate from the internal one
Context: a presigned URL is signed for a host (SigV4 signs the `Host` header). Inside compose the services
reach MinIO at `http://minio:9000`, which a browser cannot resolve.
Decision: `S3_ENDPOINT` is what services call; `S3_PUBLIC_ENDPOINT` is the host used only to presign
(a second S3 client that never sends requests); `S3_PUBLIC_BASE_URL` is the base of public image URLs
(CDN in production). MinIO CORS is server-wide (`MINIO_API_CORS_ALLOW_ORIGIN`) and the init job fails if it
was not applied. On AWS S3 leave `S3_ENDPOINT` and `S3_PUBLIC_ENDPOINT` empty and configure bucket CORS.

## ADR-020 Partner availability and location rules
Decisions: (a) the partner app posts location only to `POST /partner/location` while online; the server
fans the ping out to that partner's active jobs (the `/deliveries/:jobId/location` route also exists).
(b) Going offline while holding jobs returns 409 `PARTNER_HAS_ACTIVE_JOBS`. (c) Suspension forces the
partner offline, cancels their live offers and returns ASSIGNED/AT_PICKUP jobs to PENDING_ASSIGNMENT;
jobs already picked up stay with the partner. (d) Dispatch only considers partners whose last ping is
younger than `DISPATCH_LOCATION_MAX_AGE_SEC` (120 s); the customer UI marks a location stale after
`LOCATION_STALE_SEC` (60 s). (e) The demo simulator emits `simulated:true` pings only and never changes job
state. (f) Delivery TMS mutations (assign, unassign, fail, simulate, approve, reject, suspend, reinstate)
require the OPS admin sub-role (SUPER_ADMIN passes); SUPPORT and FINANCE admins can read but not reassign.

## ADR-021 Quote lines carry `lineRef`; ambiguity fails closed
Decision: orders sends a `lineRef` per cart line to `POST /internal/quote`; marketplace echoes it. Orders
matches priced lines by `lineRef` and fails closed on ambiguity (it never falls back to `itemId`, which would
mis-price the same item with different customizations). Refunded intents cannot be placed; checkout
requires `available` and `stockOk`; cart merge copies `addressId`.

## ADR-022 Refund failure semantics
Decision: refunds distinguish uncertain failures (timeout, 5xx, 429, 409, expired worker lease) from
definitive ones (4xx, provider-reported failed, payment not captured). Uncertain: keep the reservation,
retry with exponential backoff (`REFUND_BACKOFF_BASE_MS * 2^(attempt-1)`, max `REFUND_MAX_ATTEMPTS` = 5) and
reuse the same `X-Refund-Idempotency` key (`thali_<refundId>_<seq>`), so a retry can never double-refund.
Definitive: final FAILED, reservation released, `refund.failed` emitted, no automatic retry; an admin retry
re-reserves atomically and uses a fresh key. `refund.failed` is emitted only when a refund becomes final.
Per-child refund caps are enforced by orders (`refundPaise <= remaining`); payments enforces
`sum(reserved) <= captured` per payment inside the transaction.

## ADR-023 Idempotency key released on any 4xx or 5xx
Decision: the `Idempotency-Key` record is released when the first response is >= 400 (not only 5xx), so a
client can correct a validation or business error and retry with the same key. A retried 409 re-executes
safely because handlers are guarded. Same key plus different body is 409 `IDEMPOTENCY_CONFLICT`.

## ADR-024 Webhook handling contract
Decision: payments mounts `express.raw` for `/webhooks/razorpay` before any JSON parser
(`createApp({ bodyParser: false })`). Order: verify HMAC in constant time, parse, then one transaction that
inserts the `payment_events` row (duplicate id gives `IGNORED_DUPLICATE`), validates amount/currency/receipt,
applies the transition and writes the outbox. 200 is returned once the event is durable, including
`IGNORED_*` results and correctly signed but malformed bodies (`IGNORED_UNKNOWN`, alert
`WEBHOOK_MALFORMED`); only a bad signature returns 400. An unexpected internal error (for example Mongo
down) returns 500 on purpose so the provider retries. Twilio callbacks return 403 on a bad signature and
Resend callbacks 401. Provider callbacks never downgrade a notification status.

## ADR-025 Notifications resolve recipients at dispatch time
Decision: event handlers only insert rows (one per channel the template supports) and make no network
calls inside the consumer transaction. The retry worker resolves the phone/email/preferences from identity
(and the user for `refund.succeeded` from orders) outside any transaction. Outcomes: `SKIPPED` (opted out,
blocked, no address, unknown recipient), retryable `FAILED` when a dependency is down, `DEAD` after 6
attempts. OTP sends are synchronous, never persisted with the code, and never retried. SMS delivery is
at-least-once (a crash between the Twilio response and the DB write, or a `SENDING` timeout recovery, can
resend); Resend is protected by an `Idempotency-Key`. Delivery receipts only move status forward.

## ADR-026 Coupon and membership holds
Decision: a `firstOrderOnly` coupon is disqualified by any HELD or REDEEMED `firstOrderOnly` redemption or
committed reservation for the user, so an abandoned checkout can block a first-order coupon for up to the
checkout TTL. Reservation sweeping in marketplace asks orders for `/internal/checkouts/:id/status` before
releasing (grace `RESERVATION_GRACE_SEC` 300 s) so a slow payment cannot lose its stock.

## ADR-027 Modes: mock providers are allowed outside production
Decision: `APP_MODE=production` refuses any `*_PROVIDER=mock`, `EMAIL_PROVIDER=mailpit`,
`GEO_PROVIDER=demo`, any truthy `DEMO_*` variable (including `DEMO_PHONES`), an `INTERNAL_SERVICE_SECRET`
shorter than 32 characters and a missing `JWT_PRIVATE_KEY_PEM`. `sandbox` may run real providers with test
credentials or mocks; the gateway `/api/v1/meta` labels every provider `demo`, `sandbox` or `live` so the
UI banner is honest. The gateway reports whatever `*_PROVIDER` values it is given, so they must mirror the
services' values.
