# API guide

The API is documented by machine-readable OpenAPI 3 specs generated from the same Zod schemas that validate
requests, so the docs cannot drift from behaviour. This page explains where to find them and the conventions
that apply to every endpoint. The endpoint catalogue itself is in Swagger and in
[LLD section 10](03-LLD.md).

## 1. Where the documentation lives

| What | Where |
|---|---|
| Aggregated Swagger UI (dropdown over all seven specs) | `GET {gateway}/api/docs` (local: http://localhost:8080/api/docs) |
| Raw spec per service through the gateway | `GET {gateway}/api/docs/specs/{identity,marketplace,orders,payments,delivery,notifications,gateway}.json` |
| Spec/UI of one service (inside the network, or `debug` profile ports 14001 to 14006) | `GET /openapi.json` and `GET /docs` on the service |
| Enable or disable | `DOCS_ENABLED` (`true` in demo; set `false` in production or restrict the path at the load balancer) |

The gateway fetches each service's `/openapi.json`, strips internal and health paths, and serves them under
the aggregated UI. Spec fetches fail with 502/504 envelopes if a service is down.

**Coverage guarantee.** Every route registered by a service is also registered in its OpenAPI document (request
schemas, responses, security and error responses). Each service has an `openapi.int.test.ts` that compares the
service-kit introspection (`GET /internal/routes`, service token required) with `/openapi.json`; the end-to-end
suite repeats this against the running stack (`e2e` flow 11, see [10-testing.md](10-testing.md)).

## 2. Base URL, versioning, content

- All public routes live under `/api/v1/...`. The JWKS is `/.well-known/jwks.json` (routed to identity).
- `/internal/*` routes are service-to-service only (service token); the gateway never routes them and they are
  not part of the public specs.
- JSON request and response bodies, `Content-Type: application/json`, 1 MB body limit (413
  `PAYLOAD_TOO_LARGE`). Timestamps are ISO-8601 UTC with `Z`. Money is integer **paise** in fields ending
  `Paise`; rates are basis points in fields ending `Bps`; currency is always INR.
- Every response has `x-request-id` (a well-formed inbound id is kept). Quote it in bug reports; it is the
  `reqId` in logs and the `correlationId` in events.

## 3. Authentication and authorization

| Caller | Mechanism |
|---|---|
| Consumer, restaurant owner, partner | `POST /api/v1/auth/otp/request {phone}` then `POST /api/v1/auth/otp/verify {phone, code, guestCartToken?}` returns `{accessToken, user, guestCartMerged?}` and sets the refresh cookie |
| Admin | `POST /api/v1/auth/admin/login {email, password}` returns `{mfaRequired, mfaToken}` (or `mfaSetupRequired` with a password-only token for first-time TOTP enrolment); `POST /api/v1/auth/admin/mfa {mfaToken, code}` returns the full token |
| Authenticated call | `Authorization: Bearer <accessToken>`; EdDSA JWT, 15 min; verified locally by each service against the identity JWKS |
| Refresh | `POST /api/v1/auth/refresh` with the `thali_rt` cookie (httpOnly, SameSite=Strict, path `/api/v1/auth`); rotated on every use, reuse of an old token revokes the session family |
| Service to service | `Authorization: Bearer <HS256 service token>` (`iss` caller, `aud` callee, 60 s) on `/internal/*` only |
| Provider webhooks | Signatures only, no bearer (section 7) |

- **Roles:** `CONSUMER`, `RESTAURANT_OWNER`, `DELIVERY_PARTNER`, `ADMIN`; admin sub-roles `SUPER_ADMIN`, `OPS`,
  `FINANCE`, `SUPPORT` (JWT claim `adm`). Admin routes require `ADMIN` and an `amr` containing `mfa`.
- **Ownership** is enforced in handlers, not only by role: an owner reaches only their restaurants and orders, a
  partner only their own jobs and offers, a customer only their own checkouts. Cross-tenant ids return 404
  (not 403) where existence would leak.
- **CSRF:** only the cookie endpoints (`/auth/refresh`, `/auth/logout`) are cookie-authenticated; they require
  the header `X-Requested-With: thali-web` and an `Origin` in `CSRF_ALLOWED_ORIGINS`. Everything else uses the
  bearer token, so it is not CSRF-exposed.
- **Guest cart:** `POST /api/v1/cart/guest` issues an opaque token; send it as `X-Guest-Cart` on the cart
  routes. Merge happens on sign-in (`guestCartToken` on `otp/verify`, or `POST /api/v1/cart/merge`).
  A guest `GET /cart` with no cart is an empty cart.
- Admin console users are created only through the bootstrap CLI or by a SUPER_ADMIN; there is no public
  admin registration.

## 4. Errors

All services return the same envelope:

```json
{ "error": { "code": "ORDER_INVALID_TRANSITION", "message": "human readable",
             "details": { }, "requestId": "..." } }
```

| HTTP | Meaning | Typical codes |
|---|---|---|
| 400 | Validation or malformed input | `VALIDATION_FAILED` (with `details.issues[]`), `OTP_INVALID`, `OTP_EXPIRED`, `DELIVERY_CODE_INVALID`, `IDEMPOTENCY_KEY_REQUIRED`, `WEBHOOK_SIGNATURE_INVALID` |
| 401 | Missing/expired/revoked credentials | `UNAUTHENTICATED`, `INVALID_CREDENTIALS`, `SESSION_REVOKED`, `SESSION_REUSE_DETECTED` |
| 403 | Authenticated but not allowed | `FORBIDDEN`, `MFA_REQUIRED`, `ACCOUNT_BLOCKED`, `CSRF_CHECK_FAILED`, `PARTNER_NOT_APPROVED` |
| 404 | Unknown or not yours | `NOT_FOUND` |
| 409 | Conflict or illegal state change | `*_INVALID_TRANSITION`, `CONFLICT`, `IDEMPOTENCY_CONFLICT`, `IDEMPOTENCY_IN_PROGRESS`, `OUT_OF_STOCK`, `ASSIGNMENT_TAKEN`, `OFFER_EXPIRED`, `CAPACITY_EXCEEDED`, `ORDER_ACCEPT_WINDOW_EXPIRED`, `CONCURRENT_MODIFICATION`, `PARTNER_HAS_ACTIVE_JOBS` |
| 413 | Body too large | `PAYLOAD_TOO_LARGE` |
| 422 | Business rule | `NOT_SERVICEABLE`, `RESTAURANT_CLOSED`, `ITEM_UNAVAILABLE`, `INVALID_SELECTION`, `PRICE_CHANGED`, `COUPON_INVALID`, `COUPON_LIMIT_REACHED`, `CART_EMPTY`, `FILE_INVALID`, `REFUND_EXCEEDS_CAPTURED`, `REFUND_EXCEEDS_REMAINING`, `REFUND_TARGET_MISMATCH`, `PAYOUT_EXCEEDS_AVAILABLE`, `PARTNER_PROFILE_INCOMPLETE` |
| 423 | Locked | `ACCOUNT_LOCKED`, `DELIVERY_CODE_LOCKED` |
| 429 | Rate limited (`Retry-After` header) | `RATE_LIMITED`, `OTP_ATTEMPTS_EXCEEDED` |
| 502/503/504 | Upstream or dependency | `UPSTREAM_UNAVAILABLE`, `UPSTREAM_TIMEOUT`, `PAYMENT_PROVIDER_UNAVAILABLE`, `OTP_DELIVERY_FAILED`, `SERVICE_UNAVAILABLE` |

Codes added late in the build, and where they come from:

| Code | HTTP | Raised by | Meaning |
|---|---|---|---|
| `REFUND_TARGET_MISMATCH` | 422 | `POST /admin/finance/refunds` (payments) | The `childOrderId` is not in this payment's checkout, the `restaurantId` is not the child's, or the child is unknown. `details.reason`: `CHILD_NOT_IN_PAYMENT`, `RESTAURANT_MISMATCH`, `CHILD_NOT_FOUND` (ADR-028) |
| `REFUND_EXCEEDS_REMAINING` | 422 | manual refund (payments); admin cancel/refund on the order (orders) | The amount is more than the child's total minus refunds already committed for it; `details.remainingPaise` says what is left |
| `REFUND_EXCEEDS_CAPTURED` | 422 | payments | The refund is more than what was captured on the payment |
| `PAYOUT_EXCEEDS_AVAILABLE` | 422 | `POST /admin/finance/payouts` | The payout is more than the account's available balance |
| `PARTNER_PROFILE_INCOMPLETE` | 422 | partner submit; admin approve (delivery) | Required profile fields or documents for the vehicle are missing; `details.missing` lists them |
| `PARTNER_HAS_ACTIVE_JOBS` | 409 | `POST /partner/offline` (delivery) | The partner still holds active deliveries; finish them or ask ops to reassign |
| `ORDER_ACCEPT_WINDOW_EXPIRED` | 409 | restaurant accept (orders) | The acceptance window has passed |
| `CONCURRENT_MODIFICATION` | 409 | any service | Optimistic-concurrency conflict; re-read and retry |
| `PAYLOAD_TOO_LARGE` | 413 | any service | Body over the 1 MB JSON limit |

Not separate codes: `FIRST_ORDER_ONLY`, `MIN_ORDER`, `EXPIRED`, `NOT_STARTED`, `INACTIVE`, `NOT_FOUND`,
`NO_DISCOUNT` are values of `error.details.reason` on `COUPON_INVALID` (422), and `TOTAL_LIMIT` / `PER_USER_LIMIT`
on `COUPON_LIMIT_REACHED` (422). `PARTNER_PROFILE_INCOMPLETE` and `PARTNER_HAS_ACTIVE_JOBS` are defined in the
delivery service (`services/delivery/src/contracts-local.ts`), `PAYOUT_EXCEEDS_AVAILABLE` in payments
(`domain/payouts.ts`); the rest are in `ErrorCode` in `@thali/contracts`.

Demo-pay (`/api/v1/demo-pay/:intentId`, `.../complete`) requires a bearer token and returns 404 for anyone who is
not the intent's owner (ADR-030). Ops routes under `/internal/*` accept only the gateway and notifications
(ADR-031).

In production, 5xx messages are scrubbed. The authoritative list is `ErrorCode` in `packages/contracts`; clients
must tolerate unknown codes. Cross-service errors are mapped, never leaked: an upstream 401/403 reaching the
caller becomes 502.

## 5. Idempotency

Send `Idempotency-Key` (8 to 128 chars of `[A-Za-z0-9_-]`) on these routes; it is **required** (400
`IDEMPOTENCY_KEY_REQUIRED` otherwise):

| Route | Scope |
|---|---|
| `POST /api/v1/checkouts` | per user; also rate limited to 10/min/user |
| `POST /api/v1/memberships/purchase` | per user |
| `POST /api/v1/admin/finance/refunds` (manual refund) | per admin |
| `POST /api/v1/admin/finance/payouts` | per admin |

Behaviour (`idempotency_keys` collection, TTL 24 h):

- Same key and same body: the stored response is replayed (same status and body).
- Same key and a different body: 409 `IDEMPOTENCY_CONFLICT`.
- Same key while the first call is still running: 409 `IDEMPOTENCY_IN_PROGRESS`.
- A first response with status >= 400 releases the key, so you can correct the request and retry with the same
  key (ADR-023).
- Beyond the header: a second checkout for the same cart version while one is `AWAITING_PAYMENT` returns the
  existing checkout; internal commands and provider calls use natural keys (checkout id, `refund:<child>:<reason>`,
  the Razorpay `X-Refund-Idempotency` header, Resend `Idempotency-Key`).

## 6. Pagination

Cursor pagination everywhere: `GET ...?limit=20&cursor=<opaque>` returns
`{ "items": [...], "nextCursor": "<opaque>" | null }`. Items are sorted `createdAt desc, _id desc`; the cursor is
a base64url token (invalid cursors return 400). Pass `nextCursor` back unchanged until it is `null`.
`limit` defaults to 20 or 50 depending on the route and has a per-route maximum (documented in Swagger).
Exception: restaurant discovery sorts by per-request computed values (distance, fee, ETA), so it uses an opaque
offset cursor; pages can shift between requests.

Admin search endpoints add filters as query parameters (for example `GET /api/v1/admin/orders?q&status&
restaurantId&phone&from&to`); phone search matches the masked last four digits only.

## 7. Webhooks (provider to Thali)

| Route | Provider | Authenticity | Success response |
|---|---|---|---|
| `POST /api/v1/webhooks/razorpay` | Razorpay | `X-Razorpay-Signature` = HMAC-SHA256 of the **raw body** with `RAZORPAY_WEBHOOK_SECRET` | 200 `{status, eventId, result}`; bad signature 400 |
| `POST /api/v1/webhooks/twilio/status` | Twilio | `X-Twilio-Signature` = HMAC-SHA1 of the exact URL plus sorted form params (token = auth token) | 204; bad signature 403 |
| `POST /api/v1/webhooks/resend` | Resend (Svix) | `svix-id`, `svix-timestamp`, `svix-signature` over `${id}.${timestamp}.${rawBody}`, 5 min tolerance | 200 `{received:true}`; bad signature 401 |

Rules that matter for integrators and proxies:

- Signatures are over the exact bytes. Nothing between the provider and the service may parse and re-serialize
  the body; the gateway and nginx pass it through untouched.
- Webhooks are idempotent: a repeated event id returns 200 and is recorded as `IGNORED_DUPLICATE`; an event
  that implies an earlier state is `IGNORED_STALE`; mismatched amount/currency/receipt is `REJECTED_MISMATCH`.
- Return codes drive provider retries: 200 only after the event is durably recorded; an unexpected internal
  error returns 500 on purpose.
- In demo mode, `POST /api/v1/demo-pay/:intentId/complete {outcome: success|failure}` (bearer token of the intent's
  owner required, ADR-030) runs the same webhook
  pipeline in-process with `MOCK_WEBHOOK_SECRET` (route exists only when `PAYMENT_PROVIDER=mock`).

Provider-side configuration (URLs, events, secrets) is in [05-provider-setup.md](05-provider-setup.md).

## 8. Rate limits

| Limit | Scope | Where |
|---|---|---|
| 300 / min | per IP, all routes | gateway (fails open if Redis is down) |
| 60 / min | per IP, `/api/v1/discovery*` | gateway |
| 10 / min | per IP, `/api/v1/auth/otp/*` | gateway (fails closed with 503 if Redis is down) |
| 5 / hour, 30 s cooldown | per phone, OTP requests; 20 / hour per IP | identity |
| 5 attempts | per OTP challenge | identity |
| 10 / 15 min | admin login per IP + email; lock after 5 failures for 15 min | identity |
| 10 / min | checkout creation per user | orders |
| 1 / 3 s | location ping per partner | delivery |
| 20 / min | payment verify per user | payments |

429 responses carry `Retry-After`; the gateway exposes `retry-after`, `ratelimit-limit`,
`ratelimit-remaining` to browsers.

## 9. Realtime (SSE)

1. `POST /api/v1/realtime/ticket` (bearer) returns `{ticket, expiresInSec: 30}`, single use.
2. `GET /api/v1/realtime/stream?ticket=<ticket>` opens `text/event-stream` (heartbeat comment `: ping` every
   20 s, `retry: 5000`, closed after 1 h, at most 5 streams per user).
3. Event names: `order.updated`, `owner.order`, `delivery.location`, `partner.offer`, `notification`.
4. If the stream drops, poll the REST resource every 10 s (the SPA does this and says so).

The bearer token never goes into the URL; the ticket is consumed on connect.

## 10. Meta and health endpoints

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /api/v1/meta` | none | `{mode, brand, currency, timezone, providers:{payment,sms,email,maps,storage}}` with labels `demo`/`sandbox`/`live`; drives the mode banner |
| `GET /health/live`, `GET /health/ready` | none | Process liveness; readiness checks Mongo and Redis (gateway: Redis) |
| `GET /api/v1/admin/health` | ADMIN + MFA | Aggregated per-service details (outbox, consumer lag, dead letters, provider errors) |
| `GET /api/v1/admin/audit-logs` | ADMIN + MFA | Central audit log (actor, action, target, summary, IP, correlation id) |
