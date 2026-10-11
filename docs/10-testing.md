# Testing

How the automated tests are organised, how to run each layer, and where the recorded results go. The
requirements behind the tests are the "minimum tests" of the brief; the mapping from requirement to test file is
in section 4.

> **Status of this document.** Sections 1 to 5 describe how the suites work. Section 6 records verified results:
> 6.1 the UI-redesign final gate on 2026-10-11 at `f9863ed` (fresh volumes: build exit 0, 222 test files / 1 881
> tests, seed 138,702 then 0, seed-verify 17/17, smoke 26/26, Playwright e2e 33/33) and 6.2 the earlier platform run
> (169 files / 1 375 tests, e2e 29/29). Nothing else in the documentation claims result numbers.

## 1. Layers

| Layer | Tooling | Needs | Where |
|---|---|---|---|
| Unit | Vitest 4 | nothing | `packages/*/test/*.test.ts`, pure parts of services (state machines, pricing, phone, signatures, batching, templates, open-status) |
| Integration | Vitest 4 + supertest | Mongo replica set + Redis from `docker-compose.infra.yml` | `services/*/test/*.int.test.ts`, `packages/service-kit/test/*.int.test.ts` |
| Web component/unit | Vitest + jsdom + Testing Library | nothing | `apps/web/test/**/*.test.ts(x)` |
| System smoke | `tsx scripts/smoke.ts` (HTTP) | the full compose stack, demo mode, seeded | `scripts/smoke.ts` |
| End-to-end and failure scenarios | Playwright 1.64 | the full compose stack, demo mode, seeded | `e2e/` (`npm run e2e`) |

Properties of the integration tests:

- They use a real MongoDB replica set (transactions are exercised) and real Redis:
  `mongodb://localhost:27018/?replicaSet=rs0&directConnection=true`, `redis://localhost:6379`.
- Each test file creates a uniquely named database and a unique `EVENT_STREAM_PREFIX` / Redis key prefix, so
  files and services can run in parallel and never see each other's data.
- Cross-service flows run in-process: the apps of two or more services share the test Redis and exchange real
  events (outbox to stream to consumer). Providers are replaced by test doubles at the port boundary (Razorpay,
  Twilio, Resend, Google are stubbed `fetch` or fakes; Mailpit and MinIO tests hit the live infra containers).
- No test calls a live external provider. The provider checks in
  [05-provider-setup.md](05-provider-setup.md) are the live/sandbox verification and are not yet done.

## 2. How to run

Prerequisites: Node 22, `npm ci`, Docker.

```bash
npm run infra:up         # starts thali-infra: Mongo :27018 (rs0), Redis :6379, MinIO :9000/:9001, Mailpit :8025/:1025
npm run build            # tsc -b packages + services, then the web build
npm run typecheck        # tsc -b including e2e, then the web typecheck
npm test                 # everything: vitest run (all projects)
npm run test:unit        # THALI_TEST_KIND=unit  : excludes *.int.test.ts, no infra needed
npm run test:int         # THALI_TEST_KIND=int   : only *.int.test.ts
```

One project or file (projects are named `@thali/<workspace>`):

```bash
npx vitest run --project @thali/payments
npx vitest run --project @thali/orders services/orders/test/partial-rejection.int.test.ts
npm run test -w @thali/web
```

Full stack suites (demo mode):

```bash
cp .env.example .env                 # demo placeholders; use scripts/gen-env.sh for anything that is not a local demo
npm run stack:up                     # docker compose up -d --build --wait
npm run seed                         # idempotent: story data + the Bengaluru dataset (about 138,700 documents on a fresh stack), 0 on the second run
npx tsx scripts/seed-verify.ts       # per-collection counts + 13 consistency checks over the seeded databases
npm run smoke                        # scripted API walk (26 steps, PASS/FAIL per step, non-zero exit on the first failure)
npm run e2e                          # stack:up + seed + Playwright (12 completion flows, 4 redesign flows, 8 system failure scenarios)
npm run test -w @thali/e2e           # Playwright only, against an already running and seeded stack
cd e2e && npx playwright test tests/08-partial-rejection.spec.ts    # one spec
```

Each command in one line:

| Command | What it does | Needs |
|---|---|---|
| `npm run build` | `tsc -b` for the three packages and six services, then the Vite web build | nothing |
| `npx vitest run` (same as `npm test`) | all unit + integration tests, every workspace project | `npm run infra:up` |
| `npm run seed` | runs each service's own seed inside its container (identity, marketplace, delivery, payments, notifications, orders); refuses unless `APP_MODE=demo`; `-- --local` runs with tsx against the infra stack | the full stack |
| `npm run smoke` | `scripts/smoke.ts`: multi-restaurant checkout through the public API (env: `SMOKE_BASE_URL`, `SMOKE_ORIGIN`, `SMOKE_TIMEOUT_SEC`) | the full stack, seeded |
| `npm run e2e` | Playwright in `e2e/` (config `e2e/playwright.config.ts`: Chromium, one worker, serial, no retries, 240 s per test, HTML report in `e2e/playwright-report`, traces/screenshots/video kept on failure in `e2e/test-results`) | Docker, Playwright browsers (`npx playwright install chromium`) |

**Run smoke and e2e sequentially, never in parallel.** They share the demo phones (OTP cooldowns and hourly
limits), the demo partners and the seeded restaurants' order boards; two concurrent drivers would compete for the
same partner offers.

**E2E rate-limit reset (demo only).** The e2e suite signs in about 20 times per run from one IP, while identity
allows 20 OTP requests per IP per hour, 5 per phone per hour and a 30 s resend cooldown. Before the flows that
sign in, `e2e/fixtures/stack.ts` (`resetAuthRateLimits`) deletes exactly these Redis keys in the demo Redis through
`docker compose exec redis redis-cli DEL`: the demo phones' OTP cooldown/hour counters, the OTP and admin-login
counters of the test client's IP (the compose network gateway, as the services see it) and the demo admin's
login counter. It refuses to run unless `GET /api/v1/meta` reports `mode=demo`. Set `E2E_RESET_RATE_LIMITS=0`
to disable it (then re-runs within the hour hit 429); `E2E_REDIS_KEY_PREFIX` (default `thali:`) must match
the stack's `REDIS_KEY_PREFIX`. Rate limiting itself is covered by the identity and gateway tests, not by the
e2e flows. Smoke does not reset anything; it rotates through the three demo consumer phones and caches owner and
partner refresh sessions in the OS temp dir.

Notes

- The infra stack (`thali-infra`) and the full stack (`thali`) both publish Mailpit and MinIO ports. To run
  them together override one set in `.env`, for example `MAILPIT_HOST_PORT=18025 MINIO_HOST_PORT=19000
  MINIO_CONSOLE_HOST_PORT=19001`. The full stack does not publish Mongo or Redis, so there is no clash there.
- `THALI_TEST_KIND` is a POSIX environment variable (the scripts do not run unchanged on Windows shells).
- Mongo under parallel load can run out of file descriptors; both compose files set `nofile 64000` and
  `restart: unless-stopped`. `ECONNREFUSED ::1:27018` means the infra Mongo is down: `npm run infra:up`.
- Phone-OTP tests for demo numbers are rate limited (5 per hour per phone); smoke and e2e vary phones.
- Clean slate for the final run: `docker compose down -v` (and `npm run infra:down` if you want fresh infra
  volumes), then the commands above.

## 3. Quality gates

| Command | Gate |
|---|---|
| `npm run typecheck` | TypeScript `strict` across packages, services, e2e and web |
| `npm run build` | Production build of every package, service and the SPA |
| `npm test` | All unit and integration tests, including OpenAPI coverage tests per service |
| `npm run smoke` | Happy path through the real stack |
| `npm run e2e` | The 12 completion criteria and the 8 system failure scenarios |
| `npm audit` (manual, not a script) | Dependencies are exact-pinned; advisory-driven replacements are recorded in ADR-017/018; record the output in section 6 if run |

## 4. Requirement to test mapping

### 4.1 Brief minimum tests

| Requirement | Test files (evidence) |
|---|---|
| OTP expiry, reuse, attempts, cooldown, hourly limits | `services/identity/test/otp.int.test.ts`; refresh rotation and reuse detection `refresh.int.test.ts`; session/CSRF behaviours `me.int.test.ts` |
| Admin login, lockout, TOTP, MFA required | `services/identity/test/admin-auth.int.test.ts`, `roles.int.test.ts`, `audit.int.test.ts` |
| Business email verification gate | `services/marketplace/test/email-verification.int.test.ts`, `onboarding.int.test.ts` |
| Approval restrictions (only approved restaurants are discoverable/orderable; partners need approval) | `services/marketplace/test/admin-approval.int.test.ts`, `discovery.int.test.ts`; `services/delivery/test/onboarding.int.test.ts` |
| Cross-user and cross-restaurant access denied | `services/marketplace/test/owner-isolation.int.test.ts`; `services/orders/test/isolation.int.test.ts`, `owner-orders.int.test.ts`; `services/payments/test/finance-isolation.int.test.ts`; `services/delivery/test/tracking.int.test.ts` |
| Guest cart and merge on login | `services/orders/test/cart.int.test.ts`, `merge.int.test.ts` |
| Same item with different customizations, selection min/max, unavailable options | `services/orders/test/cart.int.test.ts`; `services/marketplace/test/quote.int.test.ts` |
| Multi-restaurant pricing, allocation reconciles to the paisa | `packages/pricing/test/{price-checkout,allocate,delivery-fee,reconcile.property}.test.ts`; `services/orders/test/checkout.int.test.ts`, `preview.int.test.ts` |
| Coupon limits and stock races | `services/marketplace/test/coupons.int.test.ts`, `reservations.int.test.ts`, `memberships.int.test.ts` |
| Duplicate checkout | `services/orders/test/checkout-idempotency.int.test.ts`; `packages/service-kit/test/idempotency.int.test.ts` |
| Duplicate and out-of-order webhooks, raw-body signature | `services/payments/test/webhook.int.test.ts`, `razorpay.test.ts`; `services/gateway/test/proxy.test.ts` (byte-identical passthrough) |
| Payment recovery (captured while orders was down, late payment, abandoned) | `services/payments/test/reconcile.int.test.ts`; `services/orders/test/expiry-recovery.int.test.ts`, `payment-outcomes.int.test.ts` |
| Partial rejection and refund | `services/orders/test/partial-rejection.int.test.ts`, `timeout.int.test.ts`; `services/payments/test/refunds.int.test.ts` |
| Ledger, payouts, UTR rule | `services/payments/test/ledger.int.test.ts`, `payouts.int.test.ts` |
| Assignment races, batching, handover codes | `services/delivery/test/accept-race.int.test.ts`, `batching.test.ts`, `dispatch.int.test.ts`, `execution.int.test.ts`, `admin-tms.int.test.ts` |
| Unauthorized state changes and illegal transitions | `packages/contracts/test/state-machines.test.ts`, `derive-status.test.ts`; `services/orders/test/lifecycle-guards.int.test.ts`, `admin-actions.int.test.ts`, `customer-cancel.int.test.ts` |
| Provider outages and notification retries | `services/notifications/test/retries.int.test.ts`, `handlers.int.test.ts`, `otp-send.int.test.ts`, `providers.test.ts`, `twilio-webhook*.test.ts`, `resend-webhook*.test.ts`; `packages/service-kit/test/google-geo.test.ts` |
| Outbox, inbox, consumer retry, DLQ, replay, leader locks | `packages/service-kit/test/{outbox-relay,consumer,dlq,scheduler,health-details}.int.test.ts` |
| Production guard (mock providers, demo flags refused) | `packages/service-kit/test/config.test.ts`, `services/payments/test/config.test.ts`, `services/gateway/test/meta.test.ts`, `services/identity/test/keys-config.int.test.ts` |
| OpenAPI covers every route | `services/*/test/openapi.int.test.ts`, `packages/service-kit/test/openapi.test.ts`; e2e flow 11 |

### 4.2 Review-focus items

| Item | Test |
|---|---|
| Opening hours across midnight and the IST day boundary | `services/marketplace/test/open-status.test.ts` |
| Phone input variants (`+91 98765 43210`, `09876543210`, `9876543210`, `919876543210`; landline/short/alpha rejected) | `packages/contracts/test/phone.test.ts` |
| Webhook raw body through gateway and express | `services/payments/test/webhook.int.test.ts`, `services/gateway/test/proxy.test.ts` |
| SSE through the gateway proxy, heartbeat, polling fallback | `services/gateway/test/sse-proxy.test.ts`; `services/notifications/test/sse.int.test.ts`; `apps/web/test/useRealtime.test.ts` |
| Same item, different customizations | `services/orders/test/cart.int.test.ts`, `services/marketplace/test/quote.int.test.ts` |

### 4.3 End-to-end and system scenarios (`e2e/tests`, Playwright against the demo stack)

Twelve completion flows (10 spec files, 20 test definitions: flow 11 has one test per service plus the Swagger
check, flow 12 has three), four UI-redesign flows (4 spec files, 4 tests) and eight system failure scenarios (8 spec
files, 9 test definitions), so 33 Playwright tests in 22 files:

| Spec | Covers |
|---|---|
| `01-guest-discovery` | flow 1: landing "Use my location" → Discover lists exactly the server's first page with the MKT-2 counts; veg filter agrees with the API; outside every service area gives the "we don't deliver here yet" state |
| `02-cart-login-preserve` | flow 2: two-restaurant guest cart (dock chips, cart page) survives OTP sign-in from "Proceed to checkout" |
| `03-04-checkout-payment` | flows 3 and 4: server totals re-derived from first principles and shown in "Bill, per restaurant", demo payment, child orders placed exactly once |
| `05-restaurant-isolation` | flow 5: each owner sees only their own child order on the board 20 kanban (prep pill + "Accept · N min"); cross-restaurant actions refused |
| `06-07-delivery-tracking` | flows 6 and 7: partner online, offer with drop area only (DLV-2), "Accept offer", Call shows the demo note (DLV-1), "I’ve arrived", inline pickup code, start, inline delivery code; the customer follows every step and sees the delivery code once a rider is assigned |
| `08-partial-rejection` | flow 8: A accepted, B rejected inline with a reason ("Other…" needs text), refund SUCCEEDED for exactly B, payment PARTIALLY_REFUNDED |
| `09-restaurant-activation` | flow 9: business email verification (real Mailpit mail) plus admin approval gate activation |
| `10-unauthorized` | flow 10: 401/403/404/409 with the standard envelope and no state change; UI no-access states |
| `11-openapi-coverage` | flow 11: every registered route of every service is in its OpenAPI spec and in the gateway's public spec; Swagger UI loads |
| `12-startup` | flow 12: all containers healthy, gateway ready, `/meta` demo, web served, README lists the start commands |
| `13-landing-address-search` | redesign: landing address autocomplete (MKT-1) → Discover for that point with the Bengaluru dataset (counts, first page, mirrored photo loads, offer badges, cuisine pill narrows like the API) |
| `14-per-restaurant-checkout` | redesign: "Checkout only Spice Route" (ORD-3) pays one restaurant; the other stays in the cart; a cart coupon scoped to Green Leaf is shown as "Applies to Green Leaf", not used, and stays on the cart (I-1) |
| `15-admin-bulk-actions` | redesign: admin overview "N failed notifications · Retry" (SMS outage via demo fail mode, NTF-2) and "N dead letters · Replay" (health count injected for the page, real NTF-3 endpoint). **Note:** a healthy stack has no dead letters to make on demand, so the "N dead letters" path is never driven by a real DLQ count end to end: the spec asserts the live `/admin/health` carries a numeric `notifications.details.deadLetters`, injects `2` into exactly that field for the page only, and expects the real replay to report the real count. The real count itself is covered by `service-kit/test/health-details.int.test.ts` |
| `16-theme-persists` | redesign: dark mode from the utility bar and the sign-in toggle persists across reloads and areas |
| `system/duplicate-webhooks` | 5x replay and out-of-order webhooks; failed attempt then successful retry on the same provider order |
| `system/payment-recovery` | `docker compose stop orders` during capture: PLACED within 60 s of restart, exactly once |
| `system/stock-race` | 5 parallel checkouts for the last unit: exactly one succeeds (losers: 409 at reserve or 422 at quote, both `OUT_OF_STOCK`; leftovers of earlier runs are superseded first) |
| `system/coupon-race` | 3 parallel checkouts with a limit-1 coupon: exactly one gets it |
| `system/assignment-race` | 3 partners accept the same job concurrently: exactly one wins |
| `system/notification-retry` | SMS outage (demo fail mode): FAILED with retries, SENT after recovery |
| `system/duplicate-checkout` | same Idempotency-Key three times in parallel: one checkout |
| `system/delivery-split-outcome` | one part delivered, one failed: IN_PROGRESS, admin cancel with refund, PARTIALLY_COMPLETED |

The 12 flows and the system scenarios deliberately run serially in one worker. The failure scenarios stop and
start containers (`orders`) and toggle demo failure modes, so they must not run against a stack that someone else is using.

## 5. Interpreting failures

| Symptom | Likely cause |
|---|---|
| Many integration tests fail at once with connection errors | infra not running or Mongo restarted: `npm run infra:up` and re-run |
| A single timing-sensitive test fails once | re-run the file; report it if it is reproducible (tests avoid fixed sleeps by polling on state) |
| `smoke` or `e2e` fails at sign-in with 429 | demo phone rate limit; wait or use another seeded phone |
| `e2e` fails at startup | containers unhealthy: `docker compose ps`, `scripts/wait-for-health.sh` |
| Tests pass but the stack behaves differently | tests use in-process apps and fakes for providers; run `smoke` against the real stack |

## 6. Recorded results

### 6.1 UI redesign (branch `feat/ui-redesign`, 2026-10-11, final gate at `f9863ed`)

Final fix round gate, run in order on HEAD `f9863ed` (every service image rebuilt from it; `f9863ed` itself only
touches e2e files, which run from the host). Unit and integration tests ran against the infra stack.

| Command | Result | Duration | Notes |
|---|---|---|---|
| `npm run build` | **exit 0** | 20 s | packages, services, web |
| `npm run stack:down -- -v && npm run stack:up` | **exit 0**, all containers healthy | 5 min 26 s | fresh volumes (Mongo, Redis, MinIO), `--build` for every image |
| `npm run seed` (fresh) | **138,702 inserted** | 88 s | identity 1,711 · marketplace 25,909 · delivery 5,528 · payments 42,190 · notifications 2,703 · orders 60,661; photo mirror: 1,107 cached, uploaded to the empty bucket |
| `npm run seed` (re-run) | **0 inserted** | 41 s | idempotent |
| `npx tsx scripts/seed-verify.ts` | **17/17 checks passed** | n/a | 13 consistency checks + 4 realism checks (cover / brand twice in a locality, live Discover first two pages at Indiranagar / Koramangala / HSR repeat no cover and no restaurant) |
| `npm test` (`vitest run`) | **222 test files, 1 881 tests passed, 0 failed** | 2 min 47 s | unit + integration + web component tests (web alone: 67 files / 526 tests) |
| `npm run smoke` | **26/26 steps PASS** | 18 s | |
| `npm run test -w @thali/e2e` | **33 passed, 0 failed** | 4.6 min | 20 completion-flow tests, 4 redesign flows, 9 system scenarios |

The first e2e run of the gate was 31/33: `system/stock-race` saw a buyer's own unpaid hold from an earlier spec
released synchronously by its new checkout (the I-2 fix), so a loser failed at the quote (422 `OUT_OF_STOCK`) and a
rerun found two free units; `system/assignment-race` hit the gateway's shared-IP 300/min limit on a GET. Both were
test-side (`f9863ed`: leftovers superseded first, 409 or 422 `OUT_OF_STOCK` accepted for losers, read-only fixture
calls retry a 429); the second full run on the same stack (no reseed) is the 33/33 above.

Not recorded in this run: `npm audit`, `npm run demo:traffic`.

### 6.2 Platform baseline (branch `build/platform`)

Controller-verified on 2026-10-10/11 on a fresh `docker compose down -v` stack built from committed code (branch
`build/platform`, `.env` copied from `.env.example` plus the `MAILPIT_HOST_PORT=18025 MINIO_HOST_PORT=19000
MINIO_CONSOLE_HOST_PORT=19001` overrides because the infra stack was running; compose build and `up --wait`
exit 0, all 12 long-running containers healthy, `/api/v1/meta` mode `demo`, web 200). Unit and integration tests ran against the
infra stack (Mongo replica set, Redis, MinIO).

| Command | Result | Duration | Notes |
|---|---|---|---|
| `npm run build` | **exit 0** | n/a | `tsc -b` for all packages and services, then the web Vite build |
| `npx vitest run` | **169 test files, 1 375 tests passed, 0 failed** | about 134 s | unit + integration; some logged error noise in the consumer `PaymentStep` component test, no failures |
| `npm run seed` (first run) | **168 documents inserted**: identity 11, marketplace 63, delivery 18, payments 20, notifications 19, orders 37 | n/a | |
| `npm run seed` (second run) | **0 inserted** | n/a | idempotent |
| `npm run smoke` | **26/26 steps PASS** | n/a | multi-restaurant checkout `TH-...`: A accepted and delivered, B rejected, B refund SUCCEEDED, payment PARTIALLY_REFUNDED, checkout PARTIALLY_COMPLETED |
| `npm run test -w @thali/e2e` (Playwright, Chromium, 1 worker: 12 completion flows + 8 system failure scenarios) | **29 passed, 0 failed** | 3.9 min | completion flows 01-12 = 20 tests (including OpenAPI coverage for all 7 services plus the Swagger UI listing, and startup/health); system failure scenarios = 9 tests (assignment-race, coupon-race, delivery-split-outcome, duplicate-checkout, duplicate-webhooks x2 including failed-then-captured retry, notification-retry: SMS outage then FAILED with retries then SENT, payment-recovery: orders down during capture then PLACED once after restart, stock-race) |

Smoke steps (all PASS): platform meta (demo mode); discovery lists both demo restaurants; menus with customizations;
guest cart token; guest cart with 2 restaurants; demo OTP login with guest cart merge; merged cart belongs to the
user; checkout preview; create checkout (Idempotency-Key); demo pay success; both child orders PLACED after
capture; owner A, owner B and partner sign in; partner online with a location ping; restaurant A accepts;
restaurant B rejects; B refund SUCCEEDED with the full B share, payment PARTIALLY_REFUNDED and adjusted totals;
A preparing and ready for pickup; dispatch offers the job; partner accepts; arrived and pickup with the restaurant
code; start delivery; deliver with the customer code; child A DELIVERED and checkout PARTIALLY_COMPLETED; partner
goes offline.

Not recorded in this verification run (so not claimed): `npm run typecheck` as a separate gate (the build runs
`tsc -b` for packages and services; e2e specs are type-checked only by `npm run typecheck`), `npm audit` output,
and per-project test counts (only the totals above were reported).

Known failures, skips and flakes at the time of the run: none in the build, vitest, seed, smoke and e2e results. One
earlier machine-load flake class is documented: integration hooks use a 120 s timeout because of parallel
Mongo load, and Mongo restarts under extreme parallel load (`restart: unless-stopped` recovers it).

Things the automated suites do **not** prove (carried to the launch checklist): live Razorpay/Twilio/Resend/
Google/S3 behaviour, load and soak behaviour, backup restore, mobile-browser GPS quality, accessibility with a
real screen reader, security penetration testing.
