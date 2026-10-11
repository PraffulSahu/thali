# Launch readiness checklist

An honest split between what has been verified in this repository and what still depends on external
configuration, approvals or work nobody has done yet. Nothing in the second table has been exercised against a
live provider or a real cloud environment.

How to read the evidence column

- A path such as `services/payments/test/webhook.int.test.ts` is an automated test (real MongoDB replica set and
  Redis, provider calls stubbed at the port boundary). Each was green when its task was completed and reviewed,
  and the **consolidated final run** on a fresh `docker compose down -v` stack (UI-redesign final gate at
  `f9863ed`: build exit 0, 222 test files / 1 881 tests passed, seed 138,702 then 0, seed-verify 17/17, smoke 26/26,
  Playwright e2e 33/33) is recorded in [10-testing.md](10-testing.md) section 6.1 (platform baseline: 6.2).
- A command (for example `docker compose ps`) is something that was run against the demo stack.
- "Demo" means the mock/Mailpit/MinIO path with the real application code around it. It is not live proof.

Status at a glance: the application is functionally complete and verified in demo mode. It is **not launch
ready**: every provider is unverified live, and the launch blockers in section 3 are open.

## 1. Verified (evidence: test file / command)

### 1.1 Platform and runtime

| Capability | Evidence |
|---|---|
| Full stack builds and starts from `cp .env.example .env && npm run stack:up`; 12 long-running containers healthy and both one-shot init jobs exit 0 | `docker compose up -d --build --wait` (2m04s) and `docker compose ps` recorded in task 15 stage A; `scripts/wait-for-health.sh`; `e2e/tests/12-startup.spec.ts` (passed in the final run) |
| Per-service Mongo user can write only its own database (cross-DB read/write denied) | task 15: as `thali_identity`, write to `thali_orders` returned `Unauthorized`; `infra/mongo/init-replica.js` |
| Mongo replica set with auth + keyfile, Redis AOF everysec, MinIO buckets with CORS verified by the init job | `docker-compose.yml`, `docker compose config`; `redis-cli config get appendonly` returns yes |
| Production refuses mock providers, Mailpit, demo geo, any truthy `DEMO_*`, `thali-demo-` placeholder secrets (ADR-032), `COOKIE_SECURE=false`, short internal secret, missing JWT key | `packages/service-kit/test/config.test.ts`, `services/payments/test/config.test.ts`, `services/gateway/test/meta.test.ts`, `services/identity/test/keys-config.int.test.ts` |
| Mode labels are honest (`demo`/`sandbox`/`live`) | `services/gateway/test/meta.test.ts`; `curl localhost:8080/api/v1/meta` |
| Swagger for all 7 services aggregated at `/api/docs`; every route is in OpenAPI | `services/*/test/openapi.int.test.ts`, `services/gateway/test/docs.test.ts`; spec fetch via `/api/docs/specs/<svc>.json` returned 200 for all seven |
| Graceful shutdown, health endpoints, request-id propagation, error envelope | `packages/service-kit/test/{shutdown,app,health-details,internal}.test.ts` |

### 1.1a PRD completion criteria 1 to 12 (verified in demo mode)

Verified on the fresh demo stack by the final run (Playwright 33/33 plus smoke 26/26 at `f9863ed`, see
[10-testing.md](10-testing.md) section 6). "Demo mode" means mock payment/SMS/geo providers: this is not live
provider proof (section 2).

| # | Criterion | Evidence (`e2e/tests/...`, `scripts/smoke.ts`) |
|---|---|---|
| 1 | Guest discovers restaurants serving an address | `01-guest-discovery.spec.ts`; smoke step "discovery lists both demo restaurants" |
| 2 | Multi-restaurant guest cart survives OTP sign-in | `02-cart-login-preserve.spec.ts`; smoke "demo OTP login with guest cart merge" |
| 3 | Server-side totals, payment initiated | `03-04-checkout-payment.spec.ts`; smoke "checkout preview" / "create checkout" |
| 4 | Verified payment places the correct children exactly once | `03-04-checkout-payment.spec.ts`, `system/duplicate-webhooks.spec.ts`, `system/payment-recovery.spec.ts`; smoke "both child orders PLACED after capture" |
| 5 | Restaurants see and manage only their own child order | `05-restaurant-isolation.spec.ts`, `10-unauthorized.spec.ts` |
| 6 | Approved partner accepts, picks up, delivers | `06-07-delivery-tracking.spec.ts`, `system/assignment-race.spec.ts`; smoke partner steps (offer, accept, pickup code, delivery code) |
| 7 | Consumer sees accurate order and delivery progress | `06-07-delivery-tracking.spec.ts` |
| 8 | Partial rejection: messaging, totals, refund | `08-partial-rejection.spec.ts`; smoke "B refund SUCCEEDED ... PARTIALLY_REFUNDED", "checkout PARTIALLY_COMPLETED"; `system/delivery-split-outcome.spec.ts` |
| 9 | Business email verification plus admin approval gate activation | `09-restaurant-activation.spec.ts` (real Mailpit email) |
| 10 | Unauthorized access and invalid transitions rejected | `10-unauthorized.spec.ts` |
| 11 | All endpoints documented in OpenAPI | `11-openapi-coverage.spec.ts` (every registered route of all 7 services, plus Swagger UI) |
| 12 | Stack starts from the README without undocumented fixes | `12-startup.spec.ts`; the final run itself (`cp .env.example .env`, build, up, seed) |

System failure scenarios also verified: duplicate and out-of-order webhooks, payment recovery with orders down,
stock race, coupon race, assignment race, notification retry after an SMS outage, duplicate checkout, split
delivery outcome (`e2e/tests/system/`).

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
| Demo/simulated data is visibly labelled (mode banner, `isDemo`, `estimateSource`, `simulated`) | web component tests that render the mode banner and `Demo`/`simulated` badges (`apps/web/test/`) |

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
| 5 | **Google Maps key** | Billing project, Routes + Geocoding + Places (New) APIs, key restricted by API and IP, quota/budget alert | Engineering | [05](05-provider-setup.md#4-google-maps-platform-eta-distance-geocoding) | Yes for accurate fees/ETAs (fallback is labelled haversine) |
| 6 | **AWS S3 buckets, CORS, IAM, CDN** | Two buckets, block public access, encryption, CORS, IAM policy, CloudFront for images | Engineering | [05](05-provider-setup.md#5-s3-object-storage) | Yes |
| 7 | **Cloud environment** | AWS account, VPC, ECS services, ALB + ACM certificate + DNS, Atlas cluster with PITR and per-service users, managed Redis, Secrets Manager | Engineering | [06](06-deployment.md) | Yes |
| 8 | **Staging deployment and live smoke** | Run the stack on cloud with sandbox providers; record `smoke`/e2e equivalent results | Engineering | [06](06-deployment.md), [10](10-testing.md) | Yes |
| 9 | **First production admin** | `bootstrap-admin` run, TOTP enrolled, second SUPER_ADMIN created | Engineering | [06](06-deployment.md) section 8 | Yes |
| 10 | **Real tile provider** | Replace public OSM tile servers with a provider/CDN (policy and capacity) | Engineering | [05](05-provider-setup.md) | Before public traffic |
| 11 | **Alerting and on-call** | Wire the alerts listed in the runbook section 13 to a pager; name an owner | Engineering/Ops | [07](07-runbook.md) | Yes |
| 12 | **`PUBLIC_WEB_URL` (production)** | Set to the public SPA origin (https, not localhost) on identity and the other services; identity refuses to start otherwise because it builds the admin password-reset link from it (2026-10-11) | Engineering | [06](06-deployment.md) section 7 | Yes |
| 13 | **`EXTERNAL_IMAGE_HOSTS` decision** | Set `none` (real uploads only) or the exact trusted image hosts; the default list is the demo seed's hosts | Engineering | [06](06-deployment.md) section 7, ADR-035 | Before launch |
| 14 | **Google Places for address search** | Enable Places API (New) on the Google key (restricted by API and IP), quota cap and budget alert; verify `GET /api/v1/discovery/places?q=...` returns `source: GOOGLE` | Engineering | [05](05-provider-setup.md#4-google-maps-platform-eta-distance-geocoding) | Yes for accurate address search (fallback is the labelled gazetteer) |
| 15 | **Admin password-reset email** | Resend sending verified so `ADMIN_PASSWORD_RESET` mail is delivered; test with a second admin; reset needs TOTP | Engineering | [05](05-provider-setup.md#3-resend-email) | Yes |

## 3. Launch blockers (decisions and reviews not done)

Summary: the pilot cannot go live until all of these are closed. Each is detailed below or in section 2.

1. Provider credentials and live verification: Razorpay test then live (KYC, bank, live keys), Twilio with India
   **DLT** registration (PE ID, header, templates), Resend domain, Google Maps key, S3 (section 2 items 1 to 6; B7).
2. Tax sign-off, including GST invoices which the system does not generate (B1).
3. Security review and penetration test (B2), plus **CSP and HSTS** (the SPA ships no CSP; HSTS must be set at the
   load balancer or CDN, see section 4).
4. Load and soak test (B3).
5. Backup and restore drill with measured RTO/RPO (B4).
6. DPDP privacy review and **account deletion/anonymisation**, which is not built (B5, section 4).
7. Cloud environment, staging run with sandbox providers, first production admin, alerting and on-call (section 2
   items 7 to 9 and 11).

| # | Blocker | Why it matters | Status |
|---|---|---|---|
| B1 | **Tax sign-off** | GST rates are configuration (`FOOD_TAX_BPS=500`, `FEE_TAX_BPS=1800`) and the breakdown is shown to customers, but finance/counsel must confirm rates, who is liable (restaurant vs platform as the supplier, e-commerce operator collection rules), and invoice requirements. The system does **not** generate GST tax invoices or credit notes | Not started |
| B2 | **Security review** | No penetration test or independent review has happened. Needed: dependency and image scan, auth/session review, SSRF/upload review, WAF rules, secrets handling, admin MFA enrolment process | Not started |
| B3 | **Load and soak test** | Pilot target (about 5 000 orders/day, SSE concurrency, Google quota, Mongo transactions under checkout bursts) is untested | Not started |
| B4 | **Backup and restore drill** | Backups are specified ([backup-restore.md](backup-restore.md)) but no restore has been rehearsed; RTO/RPO unknown | Not started |
| B5 | **DPDP / privacy review** | Privacy notice and consent, purposes, retention (financial records 8 years per LLD 14, to be confirmed), data principal rights, breach process. **Account deletion/anonymisation (LLD 14) is not implemented** (no `DELETE /me`); phone numbers are stored in clear for login and masked/encrypted elsewhere | Not started; feature gap (deletion/anonymisation not built, accepted ruling: documented, required before production) |
| B6 | **KYC policy** | Which documents are mandatory (`REQUIRED_DOCUMENT_TYPES=FSSAI,GST,PAN` default), who reviews, what "verified" means (documents are viewed by admins; no automated verification with FSSAI/GST/PAN registries), retention of documents, partner background checks, handling of rejected applicants | Not defined |
| B7 | **Provider live verification** | Items 1 to 6 above: no adapter has ever called its live service | Blocked on credentials |
| B8 | **Commercial rules** | Commission (default 18%), platform fee, discounts are platform-funded (ADR-015), payout hold days (default 0), refund policy text, cancellation policy, support SLAs and legal pages (terms, privacy, refund) | Needs business decision |
| B9 | **Settlement process** | Payouts are manual by design: finance needs a bank-transfer process, a UTR owner and reconciliation against Razorpay settlements | Needs process |
| B10 | **Consolidated final test run** | `npm run build`, full vitest, seed, smoke and Playwright e2e from a clean stack | **Done** (demo mode, UI-redesign final gate at `f9863ed`): build exit 0, 222 files / 1 881 tests, seed 138,702 then 0, seed-verify 17/17, smoke 26/26, e2e 33/33; recorded in [10-testing.md](10-testing.md) section 6.1. Repeat against staging with sandbox providers (item 8) |

## 4. Known limitations / follow-ups

Behaviour that is deliberate, accepted for the pilot, or a recorded follow-up from the per-task and final
reviews, so nobody is surprised. "Before launch" rows are also listed in section 3.

### 4.1 Not built in this pass (accepted ruling)

| Gap | Impact | Follow-up |
|---|---|---|
| **Account deletion / anonymisation** (LLD 14): no `DELETE /me`, no anonymisation job | DPDP data-principal erasure cannot be honoured through the product | Required before production (B5) |
| **Schema-migration framework** (LLD 14: `scripts/migrations`, `npm run migrate`) | Changes must be additive with defaults; no tracked, re-runnable migrations | Before the first non-additive change or before production |
| **Geocoding**: the adapter's `geocode()` exists but no service calls it; Routes API is the only Google call at runtime | Address search relies on the browser/map picker; enable the Geocoding API only when a route uses it | Wire or drop from the provider checklist |
| GST tax invoices and credit notes | Not generated | B1 |
| Scheduled orders, COD, recurring membership billing, surge pricing, native apps, multi-language UI | PRD out of scope | Post-pilot |

### 4.2 Product and data

| Limitation | Source / note |
|---|---|
| Customer cancellation only while the child is `PLACED`; later cancellation goes through a support ticket and an admin | PRD |
| Ratings are shown only once a restaurant has at least 5 | PRD C-3 |
| A failed payment keeps stock, coupon and membership held until the checkout expires (up to 15 minutes); an abandoned membership purchase stays `PENDING_PAYMENT` until the pending sweeper runs (`MEMBERSHIP_PENDING_TTL_SEC`) | ADR-014, ADR-033 |
| A restaurant near a service-area edge can be undeliverable for a drop just inside the neighbour area | ADR-016 |
| A `firstOrderOnly` coupon can be blocked for up to 15 minutes by the customer's own abandoned checkout | ADR-026 |
| Discovery calls the geo provider per restaurant (cost and latency with Google); item-match search may drop restaurants beyond the first 500 matches; offset cursor so pages can shift | task 8 minors |
| Membership `usage[]` grows without bound; membership-pending sweeper `AMOUNT_MISMATCH` rows are not backed off; free-delivery logic excludes 0-fee children (harmless) | task 9 minors |
| Admin catalog lists are unpaginated; bank details can be changed by an owner at any status without notifying admins; catalog images are not content-verified after upload | task 8 minors |
| `order.cancelled.reason` carries the enum `DELIVERY_FAILED`; the admin's free text stays on the child only | task 12 minor |
| Late assignment can leave a view without partner details in a rare out-of-order case | task 12 minor |

### 4.3 Identity and security

| Limitation | Note |
|---|---|
| Phone OTP is the only consumer sign-in: a Twilio outage or DLT block prevents login (no email fallback); OTP requests are never retried | by design |
| One Ed25519 signing key is published; rotating it invalidates access tokens (clients refresh). `FIELD_ENCRYPTION_KEY` has no key id or re-encryption tool | needs a one-off script to rotate |
| No admin password-reset flow; an OPS admin can block a SUPER_ADMIN; admin failed-attempt counters do not decay until success | follow-up |
| **No Content-Security-Policy** in the SPA; **HSTS** expected at the load balancer | launch blocker (section 3) |
| The gateway published directly with `TRUST_PROXY=1` lets a client spoof `X-Forwarded-For`; `TRUST_PROXY=true` is not guarded; IPv6 rate-limit keys are per address, not per /64 | expose only through the ALB |
| Seeds and the demo admin credentials ship in every image (`dist/seed.js`) but refuse to run unless `APP_MODE=demo`; compose has demo defaults (`DEMO_PHONES`) that must be unset in production; MinIO root credentials double as the dev S3 keys; no Redis auth in the compose stack | production guard and deployment checklist |
| The production guard scans all environment variables for the `thali-demo-` marker, so a literal marker inside an unrelated value (for example a URL) is refused | ADR-032 |
| `isDemo` flags are not back-filled on databases seeded before they existed | demo only: `docker compose down -v` |
| Admin manual refunds without a `childOrderId` are capped only at the payment level | ADR-028 |

### 4.4 Reliability and operations

| Limitation | Note |
|---|---|
| Redis is required for readiness, rate limiting, revocation and the event bus: a Redis outage makes the API unavailable (by design); recovery from data loss uses the outbox re-publish procedure; the gateway's global limit fails open if Redis is down while OTP limits fail closed | runbook section 8 |
| SMS delivery is at-least-once (a crash around the provider call, or recovery of a stuck `SENDING` row after 120 s, can send twice); email is protected by the Resend idempotency key | ADR-025 |
| Events that fail deterministically are dead-lettered after 5 handler attempts and recovered through admin replay; infrastructure outages do not count as attempts; a stream group re-created from 0 re-runs history within the 30-day inbox TTL; replays after the inbox TTL re-run for other groups | task 5 minors |
| **Parked residual:** delivery `order.ready` for a tombstoned (cancelled-before-accept) order with no job throws `NOT_FOUND` and retries to the dead-letter queue in a rare race: noise and a possible false alert | final review ruling |
| **Parked residual:** a payments reconcile that must fetch and capture an aged `AUTHORIZED` payment can exceed the caller's 12 s budget (`PAYMENTS_HTTP_TIMEOUT_MS`); the sweeper retries | final review ruling |
| The reconcile job polls the provider for abandoned intents (about one GET per 5 minutes for up to 24 hours per abandoned checkout, roughly 288 per day) | task 10 minor |
| Dispatch only considers partners with a ping younger than 120 s; browsers throttle background geolocation, so partners keep the app in the foreground | by design |
| A delivery locked by five wrong handover codes can be unlocked only by an admin failing or reassigning the job; suspended or offline partners receive `CAPACITY_EXCEEDED` on accept | task 13 minors |
| The SPA blanks briefly on a cold deep link to an area route; modal focus trap can pull focus from toasts; SSE has no client stall watchdog | task 16 minors |
| Infra: MinIO images are archived `bitnamilegacy` builds (dev/test only; production uses AWS S3); infra compose image tags are not pinned; the 7 service Dockerfiles are near-duplicates; `.npmrc` sets `legacy-peer-deps=true` (npm arborist crash workaround) | tasks 1 and 15 minors |
| Integration hooks have a 120 s timeout, which can mask a hang; services build images from the working tree, so build releases from a clean checkout of a tagged commit | task 15 minor |
| E2E leaves demo data behind per run (orders and a suspended "E2E Kitchen"); reset with `docker compose down -v` | task 21 minor |

### 4.5 UI redesign (2026-10-11): known limitations and residuals

| Limitation | Source / note |
|---|---|
| Discovery listings are cached up to `DISCOVERY_CACHE_TTL_SEC` (60 s): order and counts can lag direct Mongo writes (seeds, scripts); API writes bump the epoch; pages are re-hydrated so open status and rating are current | ADR-034, task 2 |
| Distance and ETA in the restaurant list are haversine estimates (`DEMO_HAVERSINE` / `HAVERSINE_FALLBACK`), while the restaurant page and quote still call the geo provider, so the two can differ slightly with Google | task 2 concern 2 |
| `menuStats` (price band, availability counts) ignores tracked stock: a stock-out does not change it | task 2 concern 4 |
| `restaurant.updated` carries no `pureVeg`; the owner and admin set it through marketplace and orders reads restaurant data through internal calls | task 2 package gap |
| Address search is verified against the demo gazetteer only; Google Places (New) is unverified live. Gazetteer street rows sit at the locality centre | task 2 concern 5, launch item 14 |
| Provider "failing" (health) is approximated from hourly counts plus the latest error time; an exact 10-minute count needs a service-kit change | ADR-040, task 6 |
| A pending admin password reset can be blocked for 15 minutes by anyone requesting links for that email (per-email limit); the forgot email is sent in-process after the 202, so a crash right then loses it | ADR-039, task 6 |
| Rolling deploys: old orders instances do not supersede overlapping checkouts (resolve at the 15 minute TTL); force the contact backfill after a long deploy (runbook 14.4) | ADR-037, task 3 minors 3 and 5 |
| `drop.area` is the address locality, else the pincode (no service-area name); partner call "PROXY" mode is not implemented (DIRECT in non-demo, simulated in demo) | ADR-038, tasks 3 and 4 |
| Remaining-ETA on tracking is computed even when the rider position is stale; clients must check `stale` | task 4 minor 5 |
| Admin bulk notification replay walks services sequentially and takes the oldest window first; a service that cannot be listed shows as `id: "*"` | task 5 minors |
| Seed photos: some dishes use a close-match photo, covers are partly generic; restaurant names are fictional; attribution is in `scripts/seed-data/CREDITS.md` and must accompany any shared demo | ADR-035, seed data report |
| Item search matches word prefixes in name and tags only (not descriptions, not mid-word) | task 2 fix round 1 |
| Foundation polish backlog (sub-role tag slot in the admin shell, per-role mobile tab order, shared table primitives, consumer shell slots) | progress ledger |

## 5. Sign-off

| Role | Name | Date | Notes |
|---|---|---|---|
| Engineering lead | | | Items 1 to 11 and B7, B10 |
| Finance / tax | | | B1, B8, B9 |
| Security | | | B2 |
| Legal / privacy | | | B5, B6, B8 |
| Operations | | | B3, B4, alerting |
