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

## ADR-028 Admin manual refunds are validated per child order through orders
Context: `POST /api/v1/admin/finance/refunds` could name any `childOrderId`/`restaurantId`; the per-child cap
was assumed to be enforced by orders, but orders only sees the refunds it requests itself. A manual refund
could therefore be attributed to the wrong checkout or restaurant, or exceed what the child had left.
Decision: when the request carries a `childOrderId`, payments calls orders `GET /internal/orders/child/:id`
(which returns the child's `checkoutGroupId`, `restaurantId`, `totalPaise` and `committedRefundPaise`) inside
the refund transaction and refuses with 422 `REFUND_TARGET_MISMATCH` (details `reason`: `CHILD_NOT_IN_PAYMENT`,
`RESTAURANT_MISMATCH` or `CHILD_NOT_FOUND`) a child outside the payment's checkout, a restaurant that is not the
child's, or an unknown child. The amount must be at most `child total - max(payments non-FAILED refunds for the
child, orders committedRefundPaise)`, else 422 `REFUND_EXCEEDS_REMAINING` (details carry the remaining paise).
The intent reservation write makes concurrent refunds on one payment conflict and retry, so the per-child sum is
re-read before a second refund commits. In the other direction orders ignores (and logs the alert
`REFUND_CHECKOUT_MISMATCH` for) a refund event whose checkout is not the child's. Admin cancel through the order
screen has its own `REFUND_EXCEEDS_REMAINING` check against `remainingRefundable(child)`.
Consequence: one extra synchronous call to orders on child-scoped manual refunds (payments depends on orders
being reachable for those); refunds without a `childOrderId` keep the payment-level cap only
(`REFUND_EXCEEDS_CAPTURED`). Supersedes the earlier assumption that orders enforces the per-child cap.

## ADR-029 Admin "Delivery failed" ends the delivery job through `order.delivery_failed`
Context: an admin can mark a child order `DELIVERY_FAILED` from the order screen. Delivery did not hear about it,
so the job stayed live (the partner kept it, capacity stayed consumed) while the order was terminal.
Decision: delivery consumes `order.delivery_failed`: a `PICKED_UP`/`OUT_FOR_DELIVERY` job moves to `FAILED`
(actor `ADMIN`, which the delivery transition table allows; `SYSTEM` is not), a pre-pickup job moves to
`CANCELLED` with its offers cancelled, partner capacity is released, a terminal job is a no-op, and an order with
no job is logged and ignored. Delivery emits `delivery.failed` only for the `FAILED` case. Orders treats a
`delivery.failed` for a child that is already `DELIVERY_FAILED` as already applied (mirror update only, no second
transition and no second `order.delivery_failed`), which prevents a loop. The admin's free-text reason stays on
the order; the event reason sent to payments is the `DELIVERY_FAILED` enum.
Consequence: two paths can fail a delivery (admin order screen and admin TMS `POST .../jobs/:id/fail`); both end
in the same terminal job state. Known residual (see launch checklist): a retried event for a tombstoned order with
no job can throw `NOT_FOUND` and reach the dead-letter queue (noise; visible in the admin dead-letter view).

## ADR-030 Demo payment routes require sign-in and the intent owner
Context: the demo pay page and its `complete` call run the real webhook pipeline for any intent id, so in a shared
sandbox anyone who learned an intent id could pay or fail another customer's checkout.
Decision: `GET /api/v1/demo-pay/:intentId` and `POST /api/v1/demo-pay/:intentId/complete` require a bearer token
and serve only the intent's owner (`intent.userId`); anyone else gets 404 (existence is not revealed). The routes
still exist only while `PAYMENT_PROVIDER=mock` and never in production. The web demo-pay page, `scripts/smoke.ts`
and the e2e helpers send the customer's bearer token.
Consequence: scripting a demo payment needs the customer's access token (not just the intent id); this applies
in `demo` and `sandbox` alike. Amends ADR-011.

## ADR-031 Ops routes accept only the gateway and notifications
Context: every service mounts the service-kit ops routes (`/internal/health/details`, dead-letter list and replay). They were callable by any service holding a valid service token, so a compromised peer (for example
delivery) could read or replay another service's dead letters.
Decision: `registerOpsRoutes` defaults `allowed` to `DEFAULT_OPS_CALLERS = ['gateway', 'notifications']`: the
gateway (`GET /api/v1/admin/health` fan-out) and notifications (dead-letter aggregation and replay for the admin
console) are the only real callers. A service may pass an explicit list to widen or narrow it; an empty list keeps
the legacy "any service with a valid token" behaviour (used only in tests). The gateway itself has no
`/internal/health/details` (it has no Mongo or outbox) and never routes `/internal/*` to the public.
Consequence: the runbook's service-token helper must mint a token with `iss` equal to `gateway` or `notifications`
(its default is `gateway`).

## ADR-032 Placeholder secrets are rejected in production; `scripts/gen-env.sh` creates real ones
Context: `.env.example` has to boot out of the box, so it ships placeholder secrets. Nothing stopped a production
deployment from copying `.env.example` and running with those public values.
Decision: every placeholder secret in `.env.example` carries the marker `thali-demo-` (`FIELD_ENCRYPTION_KEY` is a
base64 value that decodes to bytes beginning with it). `loadConfig` in service-kit refuses to start with
`APP_MODE=production` if any environment value contains the marker (raw, inside a connection URI such as a Mongo
URL, or base64-encoded), naming the variable but never echoing the value. `scripts/gen-env.sh [file] [--force]`
writes a `.env` from `.env.example` with every marked placeholder replaced by `openssl rand` output (base64 of 32
bytes for `FIELD_ENCRYPTION_KEY`, 32 hex bytes otherwise so passwords stay URL-safe), mode 600, no overwrite
without `--force`, and aborts if any marker survives. It changes nothing else. The same pass made identity refuse
`COOKIE_SECURE=false` in production.
Consequence: the guard scans all variables, so a literal `thali-demo-` inside an unrelated production value
(for example a URL) is also refused. Pre-existing seeded databases need `docker compose down -v` to pick up
`isDemo` flags added at the same time (demo only).

## ADR-033 Membership `payment.failed` is mirror-only as well
Context: ADR-014 made orders mirror-only for `payment.failed` on checkouts because Razorpay lets the customer
retry on the same provider order. Marketplace initially cancelled a membership on the first failure, so a
successful retry would arrive for a cancelled membership and be treated as a late payment.
Decision: for `purpose=MEMBERSHIP`, marketplace only records `lastPaymentFailure` (reason, intent id, time) and
keeps the membership `PENDING_PAYMENT`. A repeated purchase reuses the same membership and payment intent
(`lastAttemptAt` is refreshed). A sweeper (`MEMBERSHIP_PENDING_TTL_SEC`, default 900 s) takes pending memberships
idle past the TTL, asks payments for the intent by reference and reconciles it with the provider: `CAPTURED`
activates (the same path as `payment.captured`), anything else (or no intent) cancels; a later capture still
activates a cancelled membership. If payments is unreachable the row is backed off (`RESERVATION_RECHECK_SEC`).
Consequence: an abandoned membership purchase stays `PENDING_PAYMENT` for up to the TTL plus one sweep interval;
a tracked `AMOUNT_MISMATCH` row is not backed off (known minor, see launch checklist).

## ADR-034 Paused restaurants are listed as "Not accepting orders" (overrules PRD C-2)
Status: accepted (2026-10-11, UI redesign). Amends PRD C-2.
Context: PRD C-2 hid a paused restaurant from discovery. The redesign (boards 10 and 11) shows the restaurant
with an explicit state instead, because a customer who saw it a minute ago otherwise cannot tell whether it
vanished, closed or broke, and a 600-restaurant catalogue churns visibly when a kitchen pauses for ten minutes.
Decision: `GET /discovery/restaurants` and `/discovery/search` keep paused restaurants in the result. Each item
carries `closedReason` (`PAUSED` | `OUTSIDE_HOURS` | `null`), `pausedUntil`, `acceptingOrders` (true only when
open and not paused) and `closesAt`. Sorting puts accepting restaurants first, then applies the chosen sort;
`openNow=true` excludes paused ones and `counts.open` counts accepting restaurants only. Only APPROVED
restaurants inside a service area and within the delivery radius are listed (the rest of C-2 is unchanged).
Ordering stays safe because quote and checkout already reject a closed or paused restaurant with
`RESTAURANT_CLOSED`; the web app disables "Add" and shows "Not accepting orders" (or "Opens at 6:00 PM").
Consequence: the discovery tests that asserted "paused restaurants are not listed" now assert the new
behaviour. Counts and facets are computed before the `openNow` filter and before pagination so they stay stable
across pages. Listing results are cached per area for up to `DISCOVERY_CACHE_TTL_SEC` (default 60 s); API writes
that change visibility bump the discovery epoch, but a pause written straight to Mongo is only seen after the
TTL. Pages are re-hydrated on read, so open status and rating on a page are always current.

## ADR-035 Image references: upload keys or allowlisted absolute URLs; the seed mirrors a CC-licensed pool into MinIO
Status: accepted (2026-10-11, UI redesign).
Context: every image field (`images.cover/logo`, `menu_items.imageKey`, cuisine and banner `imageKey`, user
`avatarKey`) held an S3 key and every view called `storage.publicUrl(key)`. A realistic Bengaluru dataset needs
about 900 photos reused by 600 restaurants and 15 000 items; uploading 16 000 objects through presigned PUTs is
slow, and passing an `https://` value through `publicUrl` produced a broken URL.
Decision: an image reference is either a storage key or an absolute `https://` URL on a host listed in
`EXTERNAL_IMAGE_HOSTS` (default `live.staticflickr.com,upload.wikimedia.org,randomuser.me`; `none` disables
external hosts; `*.example.com` matches subdomains only). `resolveImageUrl(storage, ref, allowHosts)` in
service-kit is the only way views turn a ref into a URL: an allowlisted `https` URL without userinfo or port is
returned unchanged, any other absolute or protocol-relative URL (http, `data:`, `javascript:`, unknown host)
resolves to `null`, and everything else is a key resolved by `storage.publicUrl`. Write paths stay strict:
owners and users can only store keys under their own verified upload prefix (`verifyAttachment`/`verifyUpload`
check prefix, size and magic bytes); admin catalog routes (cuisines, banners) may store an allowlisted
`https://` URL; the seed writes documents directly. The seed photos are real CC-licensed images (Wikimedia
Commons and Openverse, commercial-use licences only, no NC/ND) plus randomuser.me portraits; the attribution row
for every image is in `scripts/seed-data/CREDITS.md`, which must ship with any distribution that shows them.
`npm run seed:images` downloads the pool once (cached under `.cache/`), uploads it to the public MinIO bucket
(`images/pool/<id>.jpg`, `images/avatars/...`) and writes a manifest; the seed then references mirrored keys and
falls back to the absolute URL for any image that could not be mirrored, so after one successful mirror the demo
shows every photo offline and does not hot-link third parties.
Consequence: a client or admin cannot make the app render an arbitrary external URL; adding a host is an
environment change. The SPA has no CSP, so external hosts are not browser-blocked; a future CSP `img-src` must
include the allowlist and the public bucket origin. Photos are "close match" for some dishes (see the seed data
README); restaurant names are fictional, localities, streets, dishes and prices are researched. Production
(real restaurants upload their own images) normally sets `EXTERNAL_IMAGE_HOSTS=none`.

## ADR-036 Deterministic Bengaluru seed generator (`@thali/contracts/seed-blr`)
Status: accepted (2026-10-11, UI redesign). Extends the demo seed; the original story data (`TH-DEMOMULTI`,
`+919000000001`...) is untouched.
Context: the redesign needs a marketplace that looks alive: about 600 restaurants over 71 localities, 15 000
menu items, 1 000 consumers, 250 partners and a few thousand historical orders, consistent across six
databases, without lookups between services and re-runnable on any day.
Decision: a pure Node-only generator, `import { buildBlrWorld } from '@thali/contracts/seed-blr'` (never from the
package root), reads `scripts/seed-data` and returns the whole world from seeded PRNG streams and `seedId('blr:...')`
ids. Each service seed calls it and writes only the slice it owns, so ids and money reconcile by construction
(every rating maps to a delivered child, `ratingCount` equals the number of ratings, coupon `usedCount` equals
redemptions, ledger and payout totals follow `priceCheckout` output). Randomness never depends on the clock;
only timestamps move with an `anchor` that `scripts/seed.ts` passes to every service, so a re-run on another
day inserts nothing new. Writes go through `ensureDocsBulk` (service-kit `/seed`): find-missing by `_id`, validate
the chunk once, `insertMany({ordered:false})`; a unique clash with a non-seed document throws `SeedConflictError`.
Generated phones use `+9191010…` (consumers), `+9192020…` (owners) and `+9193030…` (partners), exactly the
default `DEMO_PHONE_PREFIXES`, so every generated account signs in with the demo OTP in demo mode. The seed must write the
denormalised fields the new services read: `pureVeg`, `address.locality`, `searchTokens`, `menuStats` (marketplace
`recomputeMenuStats`/`recomputeSearchTokens`), `customerContact.phoneLast4` and `restaurantSetKey:'*'` (orders),
delivery job codes, `drop.area`, `drop.label` and `pickup.phone`. The seed-owned service area (`blr-koramangala`)
is upgraded in place to a city-wide Bengaluru polygon (upsert by id), so an existing volume does not need a reset.
The localities gazetteer (`localities` collection) is loaded with `upsertLocalities`.
Consequence: seeds still refuse to run outside `APP_MODE=demo` and are never run against staging or production.
The seed data directory must be present where a seed runs (inside the service images, or `npm run seed -- --local`
with `SEED_DATA_DIR`). Direct Mongo writes bypass the discovery cache epoch; the first listing may be stale for up
to `DISCOVERY_CACHE_TTL_SEC`.

## ADR-037 Per-restaurant checkout with supersede semantics and a version-guarded cart write
Status: accepted (2026-10-11, UI redesign). Refines ADR-014 and the checkout saga (LLD section 8).
Context: the floating cart bar lets a customer pay for one restaurant's lines while keeping the rest of a
multi-restaurant cart. A subset checkout has to keep the other groups, allow a second checkout on the same cart
version, and never let two payable checkouts buy the same restaurant twice (double payment).
Decision: `POST /cart/preview` and `POST /checkouts` accept `restaurantIds` (1 to 10 unique ids, each with a line
in the cart, else 422 `VALIDATION_FAILED {restaurantIds}`). The set is normalised by `restaurantSetKey` (lower
case, de-duplicated, sorted, comma-joined; `'*'` for the whole cart) and the unique partial index becomes
`{userId, cartVersion, restaurantSetKey}` where `status=AWAITING_PAYMENT`; the legacy index is dropped by a
startup migration only after the new one exists. Placement removes only the purchased lines; the other
restaurants stay in the cart. Overlap rule: inside the checkout lock, any other `AWAITING_PAYMENT` checkout of
the same user that shares a restaurant with the new one (any cart version, different set) is superseded before
quote and reserve: released through `releaseCheckout(..., 'EXPIRED', detail 'superseded by <id>')`, which emits
`checkout.released` (holds freed). A capture that still arrives for a superseded checkout is a `LATE_PAYMENT`
and is refunded; a recorded amount mismatch on the old checkout is refunded the same way. If the older checkout
turns out to be already paid, the new request fails with 409 `CONFLICT {reason:'CHECKOUT_ALREADY_PAID'}` and
nothing new is created. The cart write that marks `checkedOutVersion` is conditional on `cartVersion` and
increments `checkoutSeq` on every creation: when the cart changed meanwhile (or another creation committed), the
request fails with 409 `{reason:'CART_CHANGED'}` and its hold is released. A cart-level coupon that does not
apply to the subset is dropped (preview shows the same); a coupon sent in the body that does not apply is 422
`COUPON_INVALID {reason:'NOT_APPLICABLE'}`.
Consequence: while a rolling deploy runs, old instances do not supersede (those overlaps resolve at checkout TTL,
15 min). Overlapping unpaid checkouts are released before the new reserve, so a stock-limited item is not blocked by
the superseded hold; a concurrent overlap that appears mid-request is superseded again inside the transaction.

## ADR-038 Delivery partner privacy: area on offers, full drop address only after pickup
Status: accepted (2026-10-11, UI redesign).
Context: an offered partner has not committed and may be anyone online; the customer's name, address and
coordinates were visible to all of them. The redesign also adds a "Call" button.
Decision: an offer (`GET /partner/offers`, offer reject) exposes only `drop {area, distanceFromPickupKm}` plus
pickup details, a distance rounded to 0.1 km and whole-minute ETA. `area` is the address locality, else the
pincode (the service-area-name step of the original plan was dropped because the quote does not carry it).
For the assigned partner, `drop {name, area, label, address, location, addressRevealed, phoneMasked}` has
`address`, `location` and `navigation.dropUrl` null until the job is `PICKED_UP`; they are shown only while
`PICKED_UP` or `OUT_FOR_DELIVERY`. Completed (DELIVERED, FAILED, CANCELLED) jobs in partner history show area and
label only. Coordinates and the maps link are withheld too, because they would reveal the address.
`POST /deliveries/:jobId/contact {target}` is limited to the assigned partner with role
`DELIVERY_PARTNER` (others get 404 or 403), allowed only in the states where a call makes sense (restaurant:
ASSIGNED, AT_PICKUP; customer: AT_PICKUP to OUT_FOR_DELIVERY), rate limited (10/min/partner, fails closed),
and audited as `delivery.contact_revealed` in the same transaction before the response (no number in the
summary). Demo mode returns a masked display number and no `tel:` URL; every other mode returns a `tel:` URL
from identity (customer) or the order's `pickup.phone` / marketplace (restaurant), valid for 10 minutes.
Consequence: partner web screens must read `drop.area/label/addressRevealed`, not `drop.address`. The admin TMS
view keeps the full address. `partner.offer` realtime stays `{offerId, jobId, expiresAt}` (tested to carry no
customer data). A proxy-number mode (`PROXY`) is reserved in the enum but not implemented.

## ADR-039 Admin password reset: emailed link plus TOTP, with a credential version
Status: accepted (2026-10-11, UI redesign). Extends the admin authentication design (password plus mandatory TOTP, PRD A-1).
Context: the admin sign-in design has a "Forgot?" link. A reset by email alone would turn a mailbox compromise
into an admin takeover, and admin accounts must keep mandatory MFA.
Decision: `POST /auth/admin/password/forgot {email}` always answers 202 `{status:'ACCEPTED'}` and does its work
after the response, so it never reveals whether an account exists. Only an ACTIVE, undeleted, unlocked ADMIN
with TOTP enabled and an email gets a link. The token is 32 random bytes (base64url); only its sha256 is stored
(`admin_credentials.resetTokenHash`, unique partial index, with `resetExpiresAt` = 30 minutes); a new request
replaces the old token. The email goes through notifications template `ADMIN_PASSWORD_RESET` (the URL is a
secret key, encrypted at rest) with link `${PUBLIC_WEB_URL}/admin/reset-password?token=...`.
`POST /auth/admin/password/reset {token, newPassword, totpCode}` checks, in order: token, account state, TOTP
(within one step and newer than `lastTotpStep`, so a code used for login cannot be replayed), then consumes the
TOTP step and only then the password policy (12 to 256 characters and different from the current one, reported as
one generic message so it is not an oracle). A wrong TOTP counts towards the existing lockout (5 failures lock
15 minutes). One transaction consumes the token, writes the argon2id hash, increments
`credentialVersion`, stamps `passwordChangedAt`, revokes every session and writes the audit entry. The pending
MFA token carries the claim `cv`; `mfaVerify` rejects a stale `cv`, and accepting the TOTP and creating the
session happen in one transaction on the credential document, so a reset and a concurrent login serialise.
Limits: per IP 10 per 15 min and per email 3 per 15 min on forgot, 10 per 15 min per IP on reset, plus a
fail-closed gateway limiter (`RATE_LIMIT_ADMIN_PASSWORD_PER_MIN`, default 10). Audit: `admin.password_reset_requested`
and `admin.password_reset_failed` use an anonymous actor with the admin as target; `admin.password_reset_completed`
names the admin. In production `PUBLIC_WEB_URL` is required and may not be a localhost address.
Consequence: anyone can block a specific admin from requesting new links for 15 minutes (per-email limit; chosen
over mail-bombing). A crash between the 202 and the send loses that email; the admin requests again. The SPA
removes the token from the address bar and sets `no-referrer` while the reset page is mounted.

## ADR-040 Explanatory health: a failing provider is "degraded", never "down"
Status: accepted (2026-10-11, UI redesign). Refines PRD A-11.
Context: the admin overview and health page must say why something is wrong. A service that answers
`/internal/health/details` is not down just because its SMTP or SMS provider is failing, and calling it down
breaks the honest-data rule.
Decision: service-kit stores the last scrubbed provider error per provider (hash per service, 1 h TTL;
`lastProviderErrors` in health details; emails become `[email]`, 10+ digit numbers `[phone]`, bearer tokens and
`key=`/`token=`/`secret=` values `[redacted]`, 300 characters max). The gateway adds `degradedReasons[]`,
`summary` and `providers {category: 'up'|'failing'}` per service. `down` still means only "did not answer". A
reachable service is `degraded` when: Mongo or Redis is down; a provider category is failing; total provider
errors reach 5 per hour; consumer lag exceeds 100 on any stream; the oldest outbox event is older than 60 s; or
dead letters exceed 0. A provider category (email: resend, mailpit, smtp, ses; sms: twilio, msg91; payment:
razorpay; maps: google*; other names shown as-is) is failing when it has 5 or more errors in the last hour, or at
least 2 errors in the last hour with the latest within 10 minutes. A single blip is not failing. The summary
reads "All checks passing", "Unreachable: <error>", or up to three reasons plus "+N more".
Consequence: the "2 in 10 minutes" rule is approximated from hourly counts and the latest timestamp (exact
needs a per-provider 10-minute count in service-kit). The admin overview counts "failed notifications" as
`FAILED + DEAD` (all-time retryable), not the 24-hour figure.

## ADR-041 Masala design system: tokens, light/dark/system theme, self-hosted fonts
Status: accepted (2026-10-11, UI redesign).
Context: the web app is rebuilt from the Claude Design export (boards 00 to 40). It needs one visual language
for four role areas, dark mode that is legible on every screen, and no third-party font requests (privacy,
offline demo, CSP-readiness).
Decision: design tokens are CSS custom properties in `apps/web/src/styles.css`, defined for light and dark
(foundations board 02) and bridged to Tailwind v4 utilities; a legacy bridge keeps old class names working
during the migration. Theme preference is `light | dark | system`, stored in `localStorage` key `thali.theme`,
applied as `<html data-theme>`; an inline script in `index.html` sets it before first paint to avoid a flash,
and `system` follows the OS live. Fonts are self-hosted through `@fontsource-variable` packages (Bricolage
Grotesque for display, Figtree for body, JetBrains Mono for codes and data; woff2 subsets emitted by Vite), with no request to a font CDN. Shells (`PublicShell`, `ConsumerShell`,
`CheckoutShell`, `RoleSidebarShell` for owner, partner and admin) and the component library are documented in
`apps/web/src/README-DESIGN-SYSTEM.md`. The honest-data rules carry over: "New" under 5 ratings, `EST.` on
estimates, `SIMULATED LOCATION`, payouts "Paid" only with a UTR. Screens the boards do not draw keep their
information architecture and are rebuilt in the same system.
Consequence: every colour must come from a token (no hard-coded light colours) and meet the contrast targets in
the design spec for both themes. Known polish backlog (sub-role tag slot, tab-bar order per role, shared table
primitives) is tracked in the task reports, not in this ADR. Design sources: `.superpowers/sdd/2026-10-11-ui-redesign/`
(design spec, overrides, boards, fonts; git-ignored working directory).
