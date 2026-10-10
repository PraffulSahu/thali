# Testing

How the automated tests are organised, how to run each layer, and where the recorded results go. The
requirements behind the tests are the "minimum tests" of the brief; the mapping from requirement to test file is
in section 4.

> **Status of this document.** Sections 1 to 5 are final. **Section 6 (results) is intentionally empty until the
> final verification run** (`npm run build && npm test && npm run smoke && npm run e2e` from a clean
> `docker compose down -v`). No result numbers are claimed anywhere else in the documentation.

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
cp .env.example .env
npm run stack:up         # docker compose up -d --build --wait
npm run seed             # idempotent demo data
npm run smoke            # scripted API walk (prints PASS/FAIL per step, non-zero exit on failure)
npm run e2e              # stack:up + seed + Playwright (npm run test -w @thali/e2e)
```

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
| `npm run e2e` | The 12 completion criteria and the failure scenarios |
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

### 4.3 End-to-end and system scenarios (`e2e/`, Playwright against the demo stack)

Tasks 21 and 22 own these specs; the list below is the intended coverage and is reconciled with the real files
in the final pass.

| Spec group | Covers |
|---|---|
| 12 completion flows | guest discovery by address; cart survives OTP sign-in; server totals and payment start; verified payment places children once; restaurant isolation; partner accept/pickup/deliver; consumer sees accurate progress; partial rejection and refund; business email plus admin approval; unauthorized and invalid transitions; OpenAPI coverage; startup from the README with all containers healthy |
| Failure scenarios | duplicate webhooks (5x, and failed-after-captured), payment recovery with `docker compose stop orders`, stock race (parallel checkouts for a stock-1 item), coupon race (`FLAT100`, limit 1), assignment race (3 partners, 1 winner), notification retry with the demo fail-mode toggle, duplicate checkout (same key in parallel), split delivery outcome |

## 5. Interpreting failures

| Symptom | Likely cause |
|---|---|
| Many integration tests fail at once with connection errors | infra not running or Mongo restarted: `npm run infra:up` and re-run |
| A single timing-sensitive test fails once | re-run the file; report it if it is reproducible (tests avoid fixed sleeps by polling on state) |
| `smoke` or `e2e` fails at sign-in with 429 | demo phone rate limit; wait or use another seeded phone |
| `e2e` fails at startup | containers unhealthy: `docker compose ps`, `scripts/wait-for-health.sh` |
| Tests pass but the stack behaves differently | tests use in-process apps and fakes for providers; run `smoke` against the real stack |

## 6. Recorded results

**RESULTS PENDING.** To be filled in after the final clean run. Do not edit the numbers by hand: paste the real
command output summaries.

| Command | Date / commit | Environment | Result summary | Duration | Notes |
|---|---|---|---|---|---|
| `npm run build` | _pending_ | _pending_ | _pending_ | _pending_ | |
| `npm run typecheck` | _pending_ | _pending_ | _pending_ | _pending_ | |
| `npm test` | _pending_ | _pending_ | _pending_ | _pending_ | per-project file/test counts |
| `npm run smoke` | _pending_ | _pending_ | _pending_ | _pending_ | step-by-step PASS/FAIL list |
| `npm run e2e` | _pending_ | _pending_ | _pending_ | _pending_ | spec counts, HTML report path |

Per-project `npm test` counts:

| Project | Files | Tests | Result |
|---|---|---|---|
| `@thali/contracts` | _pending_ | _pending_ | _pending_ |
| `@thali/pricing` | _pending_ | _pending_ | _pending_ |
| `@thali/service-kit` | _pending_ | _pending_ | _pending_ |
| `@thali/gateway` | _pending_ | _pending_ | _pending_ |
| `@thali/identity` | _pending_ | _pending_ | _pending_ |
| `@thali/marketplace` | _pending_ | _pending_ | _pending_ |
| `@thali/orders` | _pending_ | _pending_ | _pending_ |
| `@thali/payments` | _pending_ | _pending_ | _pending_ |
| `@thali/delivery` | _pending_ | _pending_ | _pending_ |
| `@thali/notifications` | _pending_ | _pending_ | _pending_ |
| `@thali/web` | _pending_ | _pending_ | _pending_ |

Known failures, skips and flakes at the time of the run (with reason and owner): _pending_.

Things the automated suites do **not** prove (carried to the launch checklist): live Razorpay/Twilio/Resend/
Google/S3 behaviour, load and soak behaviour, backup restore, mobile-browser GPS quality, accessibility with a
real screen reader, security penetration testing.
