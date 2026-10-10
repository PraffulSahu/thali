# Launch readiness checklist

An honest split between what has been verified in this repository and what still depends on external
configuration, approvals or work nobody has done yet. Nothing in the second table has been exercised against a
live provider or a real cloud environment.

How to read the evidence column

- A path such as `services/payments/test/webhook.int.test.ts` is an automated test (real MongoDB replica set and
  Redis, provider calls stubbed at the port boundary). Each was green when its task was completed and reviewed
  (see the task reports); the **consolidated final run** (`npm run build && npm test && npm run smoke &&
  npm run e2e`) is recorded in [10-testing.md](10-testing.md) section 6 and is **pending**.
- A command (for example `docker compose ps`) is something that was run against the demo stack.
- "Demo" means the mock/Mailpit/MinIO path with the real application code around it. It is not live proof.

Status at a glance: the application is functionally complete and verified in demo mode. It is **not launch
ready**: every provider is unverified live, and the launch blockers in section 3 are open.

## 1. Verified (evidence: test file / command)

### 1.1 Platform and runtime

| Capability | Evidence |
|---|---|
| Full stack builds and starts from `cp .env.example .env && npm run stack:up`; 12 long-running containers healthy and both one-shot init jobs exit 0 | `docker compose up -d --build --wait` (2m04s) and `docker compose ps` recorded in task 15 stage A; `scripts/wait-for-health.sh`; `e2e` startup flow (pending final run) |
| Per-service Mongo user can write only its own database (cross-DB read/write denied) | task 15: as `thali_identity`, write to `thali_orders` returned `Unauthorized`; `infra/mongo/init-replica.js` |
| Mongo replica set with auth + keyfile, Redis AOF everysec, MinIO buckets with CORS verified by the init job | `docker-compose.yml`, `docker compose config`; `redis-cli config get appendonly` returns yes |
| Production refuses mock providers, Mailpit, demo geo, any truthy `DEMO_*`, short internal secret, missing JWT key | `packages/service-kit/test/config.test.ts`, `services/payments/test/config.test.ts`, `services/gateway/test/meta.test.ts`, `services/identity/test/keys-config.int.test.ts` |
| Mode labels are honest (`demo`/`sandbox`/`live`) | `services/gateway/test/meta.test.ts`; `curl localhost:8080/api/v1/meta` |
| Swagger for all 7 services aggregated at `/api/docs`; every route is in OpenAPI | `services/*/test/openapi.int.test.ts`, `services/gateway/test/docs.test.ts`; spec fetch via `/api/docs/specs/<svc>.json` returned 200 for all seven |
| Graceful shutdown, health endpoints, request-id propagation, error envelope | `packages/service-kit/test/{shutdown,app,health-details,internal}.test.ts` |

### 1.2 Security and access control

| Capability | Evidence |
|---|---|
| Phone OTP: 6 digits, expiry, single use, attempt cap, cooldown, hourly caps, constant-time compare, E.164 normalisation variants | `services/identity/test/otp.int.test.ts`, `packages/contracts/test/phone.test.ts` |
| Rotating refresh cookie with reuse detection; CSRF header + origin check | `services/identity/test/refresh.int.test.ts`; task 15: evil origin rejected with `CSRF_CHECK_FAILED` through nginx |
| Admin password (argon2id) + TOTP, lockout, MFA required on every admin route, sub-role guards | `services/identity/test/admin-auth.int.test.ts`, `roles.int.test.ts`; `packages/service-kit/test/require-auth.int.test.ts` |
| Central audit log of privileged actions via outbox | `services/identity/test/audit.int.test.ts`; audited admin actions asserted in orders, payments, delivery, marketplace tests |
| Cross-user / cross-restaurant / cross-partner access denied | `services/marketplace/test/owner-isolation.int.test.ts`, `services/orders/test/isolation.int.test.ts`, `services/payments/test/finance-isolation.int.test.ts`, `services/delivery/test/tracking.int.test.ts` |
| Service-to-service tokens (HS256, aud/iss, 60 s) and internal routes not exposed at the gateway | `packages/service-kit/test/internal.test.ts`, `services/gateway/test/proxy.test.ts` |
| Field encryption (AES-256-GCM) for TOTP secrets, bank details, recipients | `packages/service-kit/test/crypto.test.ts`; notifications `otp-send.int.test.ts` (no code or number in the record or logs) |
| Rate limits (OTP, admin login, search, checkout, location, gateway global) | `packages/service-kit/test/rate-limit.int.test.ts`, `services/gateway/test/rate-limit.int.test.ts` |
| Uploads: presigned PUT with signed type/size, magic-byte verification, private KYC bucket, 5-minute admin URLs | `packages/service-kit/test/s3-storage.int.test.ts` (live MinIO), `services/marketplace/test/uploads.int.test.ts`, `services/delivery/test/onboarding.int.test.ts` |

### 1.3 Money, checkout and orders (PRD completion criteria 3, 4, 8, 10)

| Capability | Evidence |
|---|---|
| Integer-paise pricing; group totals equal the sum of children to the paisa (property-tested) | `packages/pricing/test/{price-checkout,allocate,delivery-fee,reconcile.property}.test.ts` |
| Server-side re-validation: prices, open status, serviceability, stock, customizations (min/max, unavailable options) | `services/marketplace/test/quote.int.test.ts`, `services/orders/test/checkout.int.test.ts`, `cart.int.test.ts` |
| Guest cart survives sign-in (merge) | `services/orders/test/cart.int.test.ts`, `merge.int.test.ts` |
| Duplicate submit: same key replays, different body conflicts, no double reservation | `services/orders/test/checkout-idempotency.int.test.ts`, `packages/service-kit/test/idempotency.int.test.ts` |
| Atomic stock, coupon and membership holds, no oversell under races | `services/marketplace/test/reservations.int.test.ts`, `coupons.int.test.ts`, `memberships.int.test.ts` |
| Payment webhook: raw-body signature, duplicate, out-of-order, mismatch, unknown order | `services/payments/test/webhook.int.test.ts`, `razorpay.test.ts` |
| Payment recovery: captured while orders is down, late payment, abandoned checkout, reconcile before expiry | `services/payments/test/reconcile.int.test.ts`, `services/orders/test/expiry-recovery.int.test.ts`, `payment-outcomes.int.test.ts` |
| Partial rejection gives a per-child refund and the other child continues; parent status derived | `services/orders/test/partial-rejection.int.test.ts`, `timeout.int.test.ts`, `packages/contracts/test/derive-status.test.ts` |
| Refunds: reservation cap, idempotent provider key, retry/backoff, definitive vs uncertain failure, admin retry | `services/payments/test/refunds.int.test.ts` |
| Ledger (earning, commission, delivery earning), balances, payout request/confirm with UTR, hold days | `services/payments/test/ledger.int.test.ts`, `payouts.int.test.ts` |
| Illegal and unauthorised state changes rejected | `packages/contracts/test/state-machines.test.ts`, `services/orders/test/lifecycle-guards.int.test.ts`, `admin-actions.int.test.ts`, `customer-cancel.int.test.ts` |
| Restaurant isolation and acceptance window | `services/orders/test/owner-orders.int.test.ts`, `timeout.int.test.ts` |

### 1.4 Marketplace and onboarding (criteria 1, 5, 9)

| Capability | Evidence |
|---|---|
| Deliverable = approved, open, inside the drop's service area and radius; opening hours across midnight / IST boundary | `services/marketplace/test/discovery.int.test.ts`, `open-status.test.ts` |
| Business email verification gate and separate admin approval; email change resets verification | `services/marketplace/test/email-verification.int.test.ts`, `onboarding.int.test.ts`, `admin-approval.int.test.ts` |
| Menu, stock, availability, owner dashboard, ratings, coupons, memberships, banners | `services/marketplace/test/{menu,dashboard,ratings,coupons,memberships}.int.test.ts`, `patch-defaults.int.test.ts` |

### 1.5 Delivery (criteria 6, 7)

| Capability | Evidence |
|---|---|
| Partner onboarding and approval; only approved partners go online | `services/delivery/test/onboarding.int.test.ts` |
| Dispatch rounds, offer TTL, explainable batching policy, exception after 5 rounds | `services/delivery/test/dispatch.int.test.ts`, `batching.test.ts` |
| Exactly one winner for concurrent accepts | `services/delivery/test/accept-race.int.test.ts` |
| Pickup and delivery handover codes (5-attempt lock), failure path, admin TMS actions | `services/delivery/test/execution.int.test.ts`, `admin-tms.int.test.ts` |
| Live tracking: last-updated, stale flag, simulated label, owner-only; demo simulator never changes state | `services/delivery/test/tracking.int.test.ts`, `simulator.int.test.ts` |
| Order events drive jobs and back | `services/delivery/test/order-events.int.test.ts`, `services/orders/test/delivery-events.int.test.ts` |

### 1.6 Reliability and notifications

| Capability | Evidence |
|---|---|
| Transactional outbox, leader-locked relay, idempotent inbox, retry/backoff, dead letters, admin replay | `packages/service-kit/test/{outbox-relay,consumer,dlq,transaction,scheduler}.int.test.ts` |
| SSE through the gateway: unbuffered, heartbeat, polling fallback in the client | `services/gateway/test/sse-proxy.test.ts`, `services/notifications/test/sse.int.test.ts`, `apps/web/test/useRealtime.test.ts` |
| Notification retries 30/60/120/240/480 s then DEAD, admin retry, recipient resolved at dispatch, preferences, dedupe | `services/notifications/test/retries.int.test.ts`, `handlers.int.test.ts`, `routes.int.test.ts` |
| Twilio and Resend signature verification (incl. exact raw bytes), no status downgrade | `services/notifications/test/{twilio-webhook,resend-webhook}*.test.ts`, `providers.test.ts` |
| Demo email lands in Mailpit | `services/notifications/test/mailpit.int.test.ts` (live Mailpit); task 7 smoke of a verification email |
| Gateway: byte-identical raw body passthrough, header hygiene, rate limits, admin health aggregation, 502/504 mapping | `services/gateway/test/{proxy,rate-limit.int,health.int,docs}.test.ts` |

### 1.7 Web app

| Capability | Evidence |
|---|---|
| Consumer, restaurant, partner and admin areas call real APIs with loading, empty, error, forbidden and session-expired states | `apps/web/test/**` (component tests for each area: cart, checkout, payment step, orders board, onboarding wizard, offers, active delivery, refunds and payouts panels, health page, service-area editor) |
| Accessibility fixes from review (dialog focus trap, focus on session-expired, live regions, keyboard polygon editing) | review fix rounds for tasks 16, 18, 19, 20; `apps/web/test/{components,SessionExpired}.test.tsx` |
| Demo/simulated data is visibly labelled (mode banner, `isDemo`, `estimateSource`, `simulated`) | web component tests that render the mode banner and `Demo`/`simulated` badges (`apps/web/test/`); `docs/screenshots/` |

### 1.8 Operations documentation

| Capability | Evidence |
|---|---|
| Runbook helper commands work against the running stack (service token health call, dead-letter list, DB shell) | run during authoring: `internal payments 4004 gateway GET /internal/health/details` returned 200 |
| `mongodump`/`mongorestore --dryRun` per service database and Redis AOF commands | run during authoring against the compose stack |

## 2. Pending external configuration and approvals

None of these can be completed from inside the repository. "Blocks launch" means real customers cannot be
served safely or legally until it is done.

| # | Item | What is needed | Owner | Doc | Blocks launch |
|---|---|---|---|---|---|
| 1 | **Razorpay test keys, webhook, sandbox run** | Key Id/Secret (test), webhook secret, public webhook URL, six events subscribed, one full sandbox checkout + refund | Engineering + Razorpay account owner | [05](05-provider-setup.md#1-razorpay-payments-and-refunds) | Yes |
| 2 | **Razorpay live activation** | Business KYC, bank account, live keys, live webhook, payment methods, settlement terms | Business owner | [05](05-provider-setup.md#1-razorpay-payments-and-refunds) | Yes |
| 3 | **Twilio account + India DLT registration** | SID/token, sender or Messaging Service, **PE ID, registered header, every template registered**, Twilio India bundle approved | Business owner + Engineering | [05](05-provider-setup.md#2-twilio-sms-and-india-dlt-registration) | Yes (no OTP, no login) |
| 4 | **Resend domain and webhook** | Verified domain (SPF, DKIM, DMARC), API key, signing secret, `EMAIL_FROM` | Engineering + DNS owner | [05](05-provider-setup.md#3-resend-email) | Yes (restaurant verification email) |
| 5 | **Google Maps key** | Billing project, Routes + Geocoding APIs, key restricted by API and IP, quota/budget alert | Engineering | [05](05-provider-setup.md#4-google-maps-platform-eta-distance-geocoding) | Yes for accurate fees/ETAs (fallback is labelled haversine) |
| 6 | **AWS S3 buckets, CORS, IAM, CDN** | Two buckets, block public access, encryption, CORS, IAM policy, CloudFront for images | Engineering | [05](05-provider-setup.md#5-s3-object-storage) | Yes |
| 7 | **Cloud environment** | AWS account, VPC, ECS services, ALB + ACM certificate + DNS, Atlas cluster with PITR and per-service users, managed Redis, Secrets Manager | Engineering | [06](06-deployment.md) | Yes |
| 8 | **Staging deployment and live smoke** | Run the stack on cloud with sandbox providers; record `smoke`/e2e equivalent results | Engineering | [06](06-deployment.md), [10](10-testing.md) | Yes |
| 9 | **First production admin** | `bootstrap-admin` run, TOTP enrolled, second SUPER_ADMIN created | Engineering | [06](06-deployment.md) section 8 | Yes |
| 10 | **Real tile provider** | Replace public OSM tile servers with a provider/CDN (policy and capacity) | Engineering | [05](05-provider-setup.md) | Before public traffic |
| 11 | **Alerting and on-call** | Wire the alerts listed in the runbook section 13 to a pager; name an owner | Engineering/Ops | [07](07-runbook.md) | Yes |

## 3. Launch blockers (decisions and reviews not done)

| # | Blocker | Why it matters | Status |
|---|---|---|---|
| B1 | **Tax sign-off** | GST rates are configuration (`FOOD_TAX_BPS=500`, `FEE_TAX_BPS=1800`) and the breakdown is shown to customers, but finance/counsel must confirm rates, who is liable (restaurant vs platform as the supplier, e-commerce operator collection rules), and invoice requirements. The system does **not** generate GST tax invoices or credit notes | Not started |
| B2 | **Security review** | No penetration test or independent review has happened. Needed: dependency and image scan, auth/session review, SSRF/upload review, WAF rules, secrets handling, admin MFA enrolment process | Not started |
| B3 | **Load and soak test** | Pilot target (about 5 000 orders/day, SSE concurrency, Google quota, Mongo transactions under checkout bursts) is untested | Not started |
| B4 | **Backup and restore drill** | Backups are specified ([backup-restore.md](backup-restore.md)) but no restore has been rehearsed; RTO/RPO unknown | Not started |
| B5 | **DPDP / privacy review** | Privacy notice and consent, purposes, retention (financial records 8 years per LLD 14, to be confirmed), data principal rights, breach process. **Account deletion/anonymisation (LLD 14) is not implemented** (no `DELETE /me`); phone numbers are stored in clear for login and masked/encrypted elsewhere | Not started; feature gap |
| B6 | **KYC policy** | Which documents are mandatory (`REQUIRED_DOCUMENT_TYPES=FSSAI,GST,PAN` default), who reviews, what "verified" means (documents are viewed by admins; no automated verification with FSSAI/GST/PAN registries), retention of documents, partner background checks, handling of rejected applicants | Not defined |
| B7 | **Provider live verification** | Items 1 to 6 above: no adapter has ever called its live service | Blocked on credentials |
| B8 | **Commercial rules** | Commission (default 18%), platform fee, discounts are platform-funded (ADR-015), payout hold days (default 0), refund policy text, cancellation policy, support SLAs and legal pages (terms, privacy, refund) | Needs business decision |
| B9 | **Settlement process** | Payouts are manual by design: finance needs a bank-transfer process, a UTR owner and reconciliation against Razorpay settlements | Needs process |
| B10 | **Consolidated final test run** | `npm run build && npm test && npm run smoke && npm run e2e` from a clean stack, recorded in 10-testing.md | In progress (part 2 of documentation) |

## 4. Known limitations

Behaviour that is deliberate or accepted for the pilot, so nobody is surprised.

Product and data
- No GST invoices; no scheduled orders, COD, recurring membership billing, surge pricing, native
  apps or multi-language UI (PRD out of scope).
- Customer cancellation is only possible while the child is `PLACED`; later cancellation goes through a
  support ticket and an admin.
- Ratings can be posted after delivery; they are shown only once a restaurant has at least 5 (PRD C-3).
- A failed payment keeps stock, coupon and membership held until the checkout expires (up to 15 minutes,
  ADR-014).
- A restaurant near a service-area edge can be undeliverable for a drop just inside the neighbour area
  (ADR-016).
- A `firstOrderOnly` coupon can be blocked for up to 15 minutes by the customer's own abandoned checkout.
- Per-restaurant discovery calls the geo provider; with Google this is a cost and latency factor, and very
  broad searches may drop restaurants beyond the first 500 item matches.
- Discovery uses an offset cursor, so result pages can shift between requests.
- Membership `usage[]` grows without bound per membership.

Identity and security
- Phone OTP is the only consumer sign-in channel: a Twilio outage or DLT block prevents login (no email OTP
  fallback). OTP requests are never retried automatically.
- A single Ed25519 signing key is published; rotating it invalidates outstanding access tokens (clients refresh
  transparently). `FIELD_ENCRYPTION_KEY` has no key id or re-encryption tool, so it cannot be rotated without a
  one-off script.
- No admin password-reset flow; an OPS admin can block a SUPER_ADMIN; admin failed-attempt counters do not
  decay until success. `COOKIE_SECURE=false` is not refused in production (leave it empty).
- The SPA ships no Content-Security-Policy; HSTS is expected at the load balancer.
- The gateway, if published directly with `TRUST_PROXY=1`, lets a client spoof `X-Forwarded-For`; only expose it
  through the ALB.
- Bank details can be changed by an owner at any restaurant status without a notification to admins.

Reliability and operations
- Redis is required for readiness, rate limiting, revocation and the event bus: a Redis outage makes the API
  unavailable (by design); recovery from data loss uses the outbox re-publish procedure.
- SMS delivery is at-least-once (a crash around the provider call, or recovery of a stuck `SENDING` row, can
  send twice). Email is protected by the Resend idempotency key.
- Events that fail deterministically are dead-lettered after 5 handler attempts; they are recoverable through the
  admin replay once the cause is fixed. Infrastructure outages do not count as attempts.
- The reconcile job polls the provider for abandoned intents (roughly one GET per 5 minutes for up to 24 hours
  per abandoned checkout).
- Dispatch only considers partners with a ping younger than 120 s; browsers throttle background geolocation, so
  partners must keep the app in the foreground.
- A delivery locked by five wrong handover codes can be unlocked only by an admin failing or reassigning the job.
- There is no schema-migration framework yet; changes must be additive with defaults (LLD 14).
- The Geocoding adapter exists but no route uses it yet; Routes API is the only Google call at runtime.
- MinIO images are archived `bitnamilegacy` builds for dev/test only; production uses AWS S3.
- Services build their images from the working tree; build releases from a clean checkout of a tagged commit.

## 5. Sign-off

| Role | Name | Date | Notes |
|---|---|---|---|
| Engineering lead | | | Items 1 to 11 and B7, B10 |
| Finance / tax | | | B1, B8, B9 |
| Security | | | B2 |
| Legal / privacy | | | B5, B6, B8 |
| Operations | | | B3, B4, alerting |
