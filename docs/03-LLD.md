# LLD — Thali Food Delivery Platform

This is the **contract** document. Implementations must match names, enums, payloads and
algorithms here. If an implementation needs to deviate, update this file in the same commit.

## 0. Repository layout

```
/
├── package.json                 # npm workspaces root, scripts
├── tsconfig.base.json
├── docker-compose.yml           # full local stack
├── docker-compose.infra.yml     # mongo + redis + minio + mailpit only (for tests/dev)
├── .env.example
├── packages/
│   ├── contracts/   @thali/contracts   enums, zod schemas, state machines, event types, error codes
│   ├── pricing/     @thali/pricing     pure pricing + allocation (no I/O)
│   └── service-kit/ @thali/service-kit express factory, config, logger, auth, mongo, redis,
│                                        outbox/inbox/stream consumer, idempotency, rate limit,
│                                        scheduler, internal http client, openapi helpers, providers
├── services/
│   ├── gateway/ identity/ marketplace/ orders/ payments/ delivery/ notifications/
│   │   └── src/{index.ts, app.ts, config.ts, routes/, domain/, models/, events/, jobs/, openapi.ts}
│   │       test/ (vitest), Dockerfile
├── apps/web/                    # React + Vite SPA
├── e2e/                         # Playwright
├── scripts/                     # seed, bootstrap-admin, mongo-init
└── docs/
```

Module system: ESM everywhere (`"type": "module"`, TS `module: NodeNext`). Node 22 LTS.
Each service builds with `tsc -b` to `dist/` and runs `node dist/index.js`; dev via `tsx watch`.

### Pinned dependency versions
typescript 5.9.3 · express 5.3.0 · mongoose 8.24.5 · ioredis 5.11.1 · zod 4.6.5 ·
@asteasolutions/zod-to-openapi 8.5.0 · swagger-ui-express 5.0.1 · pino 9.14.0 ·
pino-http 10.5.0 · helmet 8.3.0 · cors 2.8.6 · cookie-parser 1.4.7 · jose 6.2.12 ·
argon2 0.45.1 · otplib 12.0.1 · libphonenumber-js 1.13.15 ·
@aws-sdk/client-s3 + s3-request-presigner 3.1149.0 · file-type 21.3.4 · vitest 4.1.11 ·
supertest 7.3.1 · tsx 4.23.15 · react/react-dom 19.3.0 · react-router 7.18.4 · vite 7.3.7 ·
@vitejs/plugin-react 5.2.0 · @tanstack/react-query 5.104.1 · tailwindcss/@tailwindcss/vite 4.3.3 ·
leaflet 1.9.4 · react-leaflet 5.0.0 · @playwright/test 1.64.0.
Gateway proxying uses a small native `node:http` proxy (no http-proxy-middleware: unfixable micromatch/braces advisory). Provider HTTP calls use Node's built-in `fetch` + `AbortSignal.timeout()` (no provider SDKs).

## 1. Cross-cutting conventions

### 1.1 Money, time, ids
- Money: integer paise, field suffix `Paise` (e.g. `subtotalPaise`). Never floats. Currency
  constant `INR`.
- Rates: basis points (`Bps`, 500 = 5%).
- Rounding: `roundHalfUp(x) = Math.floor(x + 0.5)` for non-negative rational amounts computed
  as `Math.floor((a * bps + 5000) / 10000)` — always integer arithmetic.
- Time: `Date` in Mongo (UTC). API emits ISO-8601 strings with `Z`.
- IDs: Mongo ObjectId hex strings externally. Human order codes: `TH-` + 8 Crockford base32
  chars (unique index).

### 1.2 Error envelope (all services)
```json
{ "error": { "code": "ORDER_INVALID_TRANSITION", "message": "human readable",
             "details": { }, "requestId": "..." } }
```
HTTP mapping: 400 `VALIDATION_FAILED`, 401 `UNAUTHENTICATED`, 403 `FORBIDDEN`, 404 `NOT_FOUND`,
409 conflicts (`*_INVALID_TRANSITION`, `IDEMPOTENCY_CONFLICT`, `OUT_OF_STOCK`,
`ASSIGNMENT_TAKEN`, ...), 422 business rule (`NOT_SERVICEABLE`, `RESTAURANT_CLOSED`,
`PRICE_CHANGED`, `COUPON_INVALID`), 429 `RATE_LIMITED` (+ `Retry-After`), 502/503/504 upstream.
Error codes are exported from `@thali/contracts` as `ErrorCode` const object.

### 1.3 Pagination
Cursor-based: `?limit=20&cursor=<opaque>` → `{ items: [...], nextCursor: string|null }`.
Cursor = base64url of `{ createdAt, _id }` (sort `createdAt desc, _id desc`).
Exception: discovery listings sort by per-request computed values (distance, fee, ETA), so they use an opaque offset cursor (pages may shift between requests; acceptable for pilot).
Admin search endpoints may also accept filters as query params documented per route.

### 1.4 Idempotency
- Header `Idempotency-Key` (8–128 chars, `[A-Za-z0-9_-]`) **required** on: `POST /checkouts`,
  `POST /memberships/purchase`, admin refund creation, admin payout recording.
- Stored in service DB `idempotency_keys`: `{ _id: <scope>:<userId>:<key>, requestHash,
  status: IN_PROGRESS|COMPLETED, responseStatus, responseBody, createdAt }` TTL 24 h.
  Same key + same body hash → replay stored response; same key + different hash → 409
  `IDEMPOTENCY_CONFLICT`; IN_PROGRESS → 409 `IDEMPOTENCY_IN_PROGRESS`.
- Internal commands are idempotent by natural keys (checkoutId, childOrderId+reason, ...).

### 1.5 Auth context
`req.auth = { userId, roles: Role[], sessionId, amr: string[] }` for user tokens;
`req.caller = { service }` for internal tokens.
Roles: `CONSUMER | RESTAURANT_OWNER | DELIVERY_PARTNER | ADMIN`. Every user has `CONSUMER`.
Admin sub-roles in `adminRoles`: `SUPER_ADMIN | OPS | FINANCE | SUPPORT` (claim `adm`).

### 1.6 Event envelope (`@thali/contracts/events`)
```ts
interface EventEnvelope<T extends EventType = EventType> {
  id: string;            // uuid v4 — dedupe key
  type: T;               // e.g. "order.placed"
  version: 1;
  occurredAt: string;    // ISO
  producer: ServiceName;
  correlationId: string;
  aggregateId: string;   // e.g. childOrderId
  payload: EventPayloads[T];
}
```
Streams: `events.identity | events.marketplace | events.orders | events.payments |
events.delivery`. Consumer groups `cg.<service>`. DLQ stream `dlq.<service>`.

## 2. Shared packages — exact public APIs

### 2.1 `@thali/contracts`
- `enums.ts`: `Role`, `AdminRole`, `AppMode`, `RestaurantStatus`, `PartnerStatus`,
  `CheckoutStatus`, `ChildOrderStatus`, `PaymentStatus`, `RefundStatus`, `DeliveryStatus`,
  `OfferStatus`, `NotificationStatus`, `NotificationChannel`, `TicketStatus`,
  `LedgerAccountType`, `PayoutStatus`, `VehicleType` — as `const` objects + union types.
- `state-machines.ts`: generic
  ```ts
  type Actor = 'CUSTOMER'|'RESTAURANT'|'PARTNER'|'ADMIN'|'SYSTEM';
  interface Transition<S extends string> { from: S; to: S; actors: Actor[]; }
  function canTransition<S extends string>(m: Transition<S>[], from: S, to: S, actor: Actor): boolean;
  function assertTransition<S extends string>(m, from, to, actor): void // throws DomainError(code `<ENTITY>_INVALID_TRANSITION`)
  ```
  exported tables: `childOrderTransitions`, `checkoutTransitions`, `paymentTransitions`,
  `refundTransitions`, `deliveryTransitions`, `restaurantTransitions`, `partnerTransitions`,
  plus `deriveCheckoutStatus(children: ChildOrderStatus[], current: CheckoutStatus): CheckoutStatus`.
- `events.ts`: `EventType` union, `EventPayloads` map (§9), `EventEnvelope`.
- `errors.ts`: `ErrorCode`, `class DomainError extends Error { code; httpStatus; details }`.
- `schemas/*.ts`: zod schemas for request/response bodies shared by services and web
  (`PhoneSchema`, `AddressSchema`, `GeoPointSchema`, `CartItemInputSchema`, `MoneySchema`, …).
- `phone.ts`: `normalizePhone(input: string, defaultRegion='IN'): string` (E.164; throws
  `DomainError(VALIDATION_FAILED)` for invalid/non-mobile).

### 2.2 `@thali/pricing` (pure)
```ts
interface PricingConfig { foodTaxBps: number; feeTaxBps: number; platformFeePaise: number; }
interface LineInput { itemId; name; unitPricePaise; addOns: {id;name;pricePaise}[]; quantity; }
interface RestaurantInput { restaurantId; lines: LineInput[]; packagingFeePaise;
  deliveryFeePaise; }   // delivery fee already computed from service-area rule + distance
interface GroupDiscountInput { couponCode?: string; couponDiscountPaise: number; } // computed by marketplace
interface MembershipBenefitInput { freeDeliveryRestaurantIds: string[]; extraDiscountBps: number; extraDiscountCapPaise: number; }
function priceCheckout(rs: RestaurantInput[], d: GroupDiscountInput, m: MembershipBenefitInput|null, c: PricingConfig): PricedCheckout;
function allocateProRata(totalPaise: number, weights: {key: string; weight: number}[]): Record<string, number>;
function lineTotal(l: LineInput): number;
```
See §6 for the algorithm. Output `PricedCheckout = { children: PricedChild[]; totals: Breakdown }`
where `Breakdown = { itemsSubtotalPaise, couponDiscountPaise, membershipDiscountPaise,
packagingFeePaise, deliveryFeePaise, deliveryDiscountPaise, platformFeePaise, foodTaxPaise,
feeTaxPaise, totalPaise }` and each `PricedChild = { restaurantId, lines: (LineInput & {lineTotalPaise})[], breakdown: Breakdown }`.
Invariant (property-tested): Σ child.breakdown.X == totals.X for every X.

### 2.3 `@thali/service-kit`
```ts
loadConfig<T extends z.ZodRawShape>(shape: T): BaseConfig & z.infer<z.ZodObject<T>>
  // BaseConfig: { SERVICE_NAME, PORT, APP_MODE, MONGO_URI, REDIS_URL, INTERNAL_SERVICE_SECRET,
  //   JWKS_URL, LOG_LEVEL, CORS_ORIGINS, DOCS_ENABLED }
  // production guard: throws if APP_MODE=production and any *_PROVIDER=mock or DEMO_* set.
createLogger(service): pino.Logger           // redact paths list §5.5
createApp({ config, logger, routes(app), openapi?: OpenAPIRegistry, healthChecks }): Express
  // helmet, json(1mb), requestId, pino-http, /health/live, /health/ready, /openapi.json,
  // /docs (if DOCS_ENABLED), notFound, errorHandler(DomainError|ZodError → envelope)
validate({ body?, query?, params? }: zod schemas) → middleware (sets req.valid)
requireAuth(opts?: { roles?: Role[]; mfa?: boolean }) → middleware (JWKS verify + revocation check)
requireInternal(allowed?: ServiceName[]) → middleware
internalClient(target: ServiceName, baseUrl): { get, post } // signs service token, timeout, retries for GET
connectMongo(uri, dbName): Promise<mongoose.Connection>
withTransaction(conn, fn: (session) => Promise<T>): Promise<T>  // retries TransientTransactionError
createRedis(url): Redis
Outbox: outboxModel(conn); enqueue(session, envelope); startRelay({ conn, redis, stream, logger })
Inbox/consumer: startConsumer({ conn, redis, service, streams: string[], handlers: Record<EventType, (e, session)=>Promise<void>>, logger })
  // handler runs inside withTransaction; inbox insert {_id:eventId} in same txn; duplicate → skip
idempotency({ scope, conn }) → middleware
rateLimit({ redis, keyFn, points, durationSec, blockSec? }) → middleware (429 + Retry-After)
startScheduler({ redis, name, intervalMs, run, logger })  // Redis SET NX PX lock leader election
gracefulShutdown({ server, logger, closers: (() => Promise<void>)[] })
auditEvent(session, { actorId, actorRole, action, targetType, targetId, summary, ip, correlationId }) // enqueues audit.recorded via outbox
providers/: SmsProvider, EmailProvider, StorageProvider, GeoProvider interfaces + factories
openapi helpers: registry, registerRoute(...) wrappers, standard error responses, bearer + internal security schemes
```

## 3. Data models (Mongoose; collection names exact)

Common fields on all: `createdAt`, `updatedAt` (timestamps). `version` (optimistic
concurrency, Mongoose `optimisticConcurrency: true`) on stateful aggregates marked (OCC).

### 3.1 identity (`thali_identity`)
| Collection | Fields | Indexes |
|---|---|---|
| `users` | `phone` (E.164)?, `email`?, `name`?, `roles[]`, `adminRoles[]`, `status` ACTIVE\|BLOCKED, `addresses[] {_id,label,line1,line2,landmark,city,pincode,location:{type:'Point',coordinates:[lng,lat]},isDefault}`, `notificationPrefs {orderSms,orderEmail,marketingSms,marketingEmail}`, `deletedAt`? | unique sparse `phone`; unique sparse `email`; `roles` |
| `otp_challenges` | `phone`, `codeHash` (HMAC-SHA256 with `OTP_PEPPER`), `purpose` LOGIN, `expiresAt`, `attempts`, `maxAttempts` 5, `consumedAt`?, `lastSentAt`, `sendCount`, `ip` | `phone+createdAt`; TTL on `expiresAt`+1 day |
| `sessions` | `userId`, `familyId`, `refreshHash`, `prevRefreshHash`?, `amr[]`, `userAgent`, `ip`, `expiresAt` (30 d; admin 12 h), `revokedAt`? | unique `refreshHash`; `userId`; TTL `expiresAt` |
| `admin_credentials` | `userId` (unique), `passwordHash` argon2id, `totpSecretEnc` (AES-GCM), `totpEnabled`, `failedAttempts`, `lockedUntil`? | unique `userId` |
| `audit_logs` | `eventId` (unique), `actorId`, `actorRole`, `action`, `targetType`, `targetId`, `summary`, `ip`, `correlationId`, `service`, `occurredAt` | `occurredAt desc`; `targetType+targetId`; `actorId` |
| `outbox`, `inbox`, `idempotency_keys`, `dead_letters` | (service-kit standard, every service) | outbox `publishedAt+createdAt`; TTL inbox 30 d |

### 3.2 marketplace (`thali_marketplace`)
| Collection | Fields | Indexes |
|---|---|---|
| `restaurants` (OCC) | `ownerUserId`, `businessName`, `name`, `slug`, `description`, `cuisines[]`, `phone`, `businessEmail`, `emailVerifiedAt`?, `emailVerification {tokenHash, expiresAt, sentAt}`?, `address {line1,line2,city,pincode}`, `location` GeoJSON Point, `deliveryRadiusKm` (default 6), `hours[] {day 0-6, open "HH:mm", close "HH:mm"}`, `timezone` 'Asia/Kolkata', `pausedUntil`?, `status` RestaurantStatus, `statusReason`?, `statusHistory[] {from,to,actorId,reason,at}`, `images {cover?, logo?}`, `documents[] {type, key, verified}`, `settlement {accountHolder, accountNumberEnc, ifsc, last4}`?, `packagingFeePaise`, `avgPrepMinutes` (20), `commissionBps` (1800), `ratingSum`, `ratingCount`, `isDemo` | `location 2dsphere`; unique `slug`; `ownerUserId`; `status`; text index `name, cuisines, description` |
| `menu_categories` | `restaurantId`, `name`, `sortOrder`, `active` | `restaurantId+sortOrder` |
| `menu_items` (OCC) | `restaurantId`, `categoryId`, `name`, `description`, `pricePaise`, `isVeg`, `imageKey`?, `available`, `trackStock` bool, `stockQty` (≥0), `reservedQty` (≥0), `customizationGroups[] {_id,name,minSelect,maxSelect,options[] {_id,name,pricePaise,isVeg,available}}`, `tags[]` | `restaurantId+categoryId`; text `name, description, tags` |
| `stock_reservations` | `checkoutId` (unique), `lines[] {itemId, qty}`, `couponCode`?, `userId`, `status` HELD\|COMMITTED\|RELEASED, `expiresAt` | unique `checkoutId`; `status+expiresAt` |
| `service_areas` | `name`, `polygon` GeoJSON Polygon, `active`, `deliveryFee {basePaise, baseKm, perKmPaise, maxPaise}`, `minOrderPaise` | `polygon 2dsphere` |
| `cuisines` | `name`, `slug`, `imageKey`, `sortOrder`, `active` | unique `slug` |
| `banners` | `title`, `imageKey`, `linkType` RESTAURANT\|CUISINE\|COUPON, `linkValue`, `activeFrom`, `activeTo`, `active`, `isDemo` | `active+activeFrom` |
| `coupons` (OCC) | `code` (upper), `description`, `type` FLAT\|PERCENT, `valuePaise`\|`valueBps`, `maxDiscountPaise`, `minOrderPaise`, `validFrom`, `validTo`, `totalLimit`, `perUserLimit`, `usedCount`, `heldCount`, `active`, `firstOrderOnly` | unique `code` |
| `coupon_redemptions` | `couponId`, `code`, `userId`, `checkoutId` (unique), `status` HELD\|REDEEMED\|RELEASED, `discountPaise`, `expiresAt` | unique `checkoutId`; `couponId+userId+status` |
| `membership_plans` | `name`, `pricePaise`, `durationDays`, `benefits {freeDeliveryMinOrderPaise, freeDeliveriesPerPeriod, extraDiscountBps, extraDiscountCapPaise}`, `terms` (markdown), `active` | — |
| `memberships` | `userId`, `planId`, `planSnapshot`, `status` PENDING_PAYMENT\|ACTIVE\|EXPIRED\|CANCELLED, `startsAt`, `endsAt`, `paymentIntentId`, `freeDeliveriesUsed`, `usage[] {checkoutId, freeDeliveries, discountPaise, status HELD\|USED\|RELEASED}` | `userId+status`; `endsAt` |
| `ratings` | `restaurantId`, `childOrderId` (unique), `userId`, `stars` 1-5, `comment` | unique `childOrderId` |

### 3.3 orders (`thali_orders`)
| Collection | Fields | Indexes |
|---|---|---|
| `carts` (OCC) | `ownerType` USER\|GUEST, `userId`?, `guestTokenHash`?, `items[] {_id(lineId), restaurantId, restaurantName, itemId, name, isVeg, unitPricePaise (display snapshot), quantity (1-20), selections[] {groupId, optionIds[]}, addOns snapshot, note}`, `addressId`?, `deliveryAddress` snapshot?, `couponCode`?, `cartVersion` (int, ++ on change), `expiresAt` (guest 7 d) | unique sparse `userId`; unique sparse `guestTokenHash`; TTL `expiresAt` |
| `checkout_groups` (OCC) | `code`, `userId`, `cartVersion`, `status` CheckoutStatus, `deliveryAddress` snapshot (with location), `childOrderIds[]`, `pricing` (Breakdown), `couponCode`?, `membershipId`?, `paymentIntentId`?, `providerOrderId`?, `paymentStatus` (mirror), `expiresAt` (now + 15 min), `statusHistory[]`, `idempotencyKey`, `isDemo` | unique `code`; `userId+createdAt`; `status+expiresAt`; unique partial `{userId, cartVersion}` where status=AWAITING_PAYMENT |
| `child_orders` (OCC) | `code`, `checkoutGroupId`, `userId`, `restaurantId`, `restaurantOwnerId`, `restaurantName`, `restaurantLocation`, `lines[]` (priced lines incl. selections snapshot), `breakdown` (Breakdown), `status` ChildOrderStatus, `statusHistory[] {from,to,actor,actorId,reason,at}`, `acceptBy`?, `prepMinutes`?, `readyEta`?, `rejectionReason`?, `cancellationReason`?, `refundStatus` NONE\|REQUESTED\|PROCESSING\|SUCCEEDED\|FAILED, `refundedPaise`, `deliveryJobId`?, `deliveryStatus` (mirror), `pickupCode` (4 digits, shown to restaurant), `deliveryCode` (4 digits, shown to customer), `customerContact {name, phoneMasked}`, timestamps `placedAt, acceptedAt, readyAt, pickedUpAt, deliveredAt, cancelledAt` | unique `code`; `checkoutGroupId`; `restaurantId+status+createdAt`; `restaurantOwnerId+createdAt`; `userId+createdAt`; `status+acceptBy` |
| `order_events` | `childOrderId`?, `checkoutGroupId`, `type`, `data`, `actor`, `at` (append-only timeline) | `checkoutGroupId+at` |
| `support_tickets` | `code`, `userId`, `childOrderId`?, `checkoutGroupId`?, `subject`, `category` ORDER_ISSUE\|PAYMENT\|DELIVERY\|ACCOUNT\|OTHER, `status` OPEN\|IN_PROGRESS\|RESOLVED\|CLOSED, `assigneeId`?, `messages[] {authorId, authorRole, body, at}`, `priority` | `status+createdAt`; `userId+createdAt` |
| `restaurant_projection` | `_id`=restaurantId, `ownerUserId`, `name`, `status`, `location` | — |

### 3.4 payments (`thali_payments`)
| Collection | Fields | Indexes |
|---|---|---|
| `payment_intents` (OCC) | `purpose` CHECKOUT\|MEMBERSHIP, `referenceId` (checkoutId or membershipId), `userId`, `amountPaise`, `currency` INR, `provider` razorpay\|mock, `providerOrderId`, `providerPaymentId`?, `status` PaymentStatus, `capturedPaise`, `refundedPaise`, `statusHistory[]`, `lastReconciledAt`?, `failureReason`?, `isDemo` | unique `purpose+referenceId`; unique `providerOrderId`; sparse `providerPaymentId` |
| `payment_events` | `_id` = provider event id (or sha256 of body when none), `provider`, `type`, `providerOrderId`, `providerPaymentId`?, `payload` (redacted), `receivedAt`, `processedAt`?, `result` APPLIED\|IGNORED_DUPLICATE\|IGNORED_STALE\|REJECTED_MISMATCH | `providerOrderId` |
| `refunds` (OCC) | `paymentIntentId`, `checkoutGroupId`, `childOrderId`?, `amountPaise`, `reason` RESTAURANT_REJECTED\|RESTAURANT_TIMEOUT\|CUSTOMER_CANCELLED\|ADMIN\|LATE_PAYMENT\|DELIVERY_FAILED, `idempotencyKey` (unique), `status` RefundStatus, `providerRefundId`?, `attempts`, `nextAttemptAt`?, `lastError`?, `requestedBy`, `statusHistory[]` | unique `idempotencyKey`; `status+nextAttemptAt`; `childOrderId` |
| `ledger_entries` (append-only) | `accountType` RESTAURANT\|PARTNER\|PLATFORM, `accountId`, `entryType` ORDER_EARNING\|COMMISSION\|REFUND_ADJUSTMENT\|DELIVERY_EARNING\|PAYOUT\|MANUAL_ADJUSTMENT, `amountPaise` (signed), `childOrderId`?, `deliveryJobId`?, `payoutId`?, `dedupeKey` (unique), `memo`, `createdBy` | unique `dedupeKey`; `accountType+accountId+createdAt` |
| `payouts` | `accountType`, `accountId`, `amountPaise`, `status` REQUESTED\|PROCESSING\|PAID\|FAILED\|CANCELLED, `method` MANUAL_BANK_TRANSFER, `utr`?, `requestedBy`, `confirmedBy`?, `confirmedAt`?, `notes` | `accountType+accountId+createdAt` |

Balance = Σ ledger amounts for account. Available = Σ entries older than hold period
(default 0 days for pilot; configurable `PAYOUT_HOLD_DAYS`) − PAYOUT entries − amounts in
REQUESTED/PROCESSING payouts.

### 3.5 delivery (`thali_delivery`)
| Collection | Fields | Indexes |
|---|---|---|
| `partners` (OCC) | `userId` (unique), `name`, `phone`, `vehicle {type BIKE\|SCOOTER\|BICYCLE\|CAR, registrationNumber}`, `status` PartnerStatus, `statusReason`?, `statusHistory[]`, `documents[] {type ID_PROOF\|DRIVING_LICENSE\|VEHICLE_RC, key, demoVerified}`, `online` bool, `lastLocation {type:'Point',coordinates}`?, `lastLocationAt`?, `activeJobIds[]`, `maxActive` (from policy), `isDemo` | unique `userId`; `lastLocation 2dsphere`; `status+online` |
| `delivery_jobs` (OCC) | `childOrderId` (unique), `checkoutGroupId`, `restaurantId`, `pickup {name, address, location}`, `drop {name, address, location, phoneMasked}`, `status` DeliveryStatus, `partnerId`?, `partnerUserId`?, `dispatchRound`, `distanceKm`, `estimatedMinutes`, `estimateSource` GOOGLE\|DEMO_HAVERSINE\|HAVERSINE_FALLBACK, `pickupCodeHash`, `deliveryCodeHash`, `codeAttempts`, `failureReason`?, `statusHistory[]`, `lastLocation`, `lastLocationAt`, `locationSimulated` bool, timestamps `assignedAt, pickedUpAt, deliveredAt` | unique `childOrderId`; `status+createdAt`; `partnerId+status` |
| `delivery_offers` | `jobId`, `partnerId`, `status` OfferStatus OFFERED\|ACCEPTED\|REJECTED\|EXPIRED\|CANCELLED, `expiresAt`, `batchEvaluation {eligible, reasons[]}`, `round` | unique `jobId+partnerId+round`; `partnerId+status`; `status+expiresAt` |
| `location_pings` | `partnerId`, `jobId`?, `location`, `accuracyM`, `simulated`, `at` | TTL 7 d on `at` |

### 3.6 notifications (`thali_notifications`)
| Collection | Fields | Indexes |
|---|---|---|
| `notifications` | `userId`?, `channel` SMS\|EMAIL\|IN_APP, `to` (masked for display; full value encrypted `toEnc`), `template`, `data` (non-sensitive), `status` QUEUED\|SENDING\|SENT\|DELIVERED\|FAILED\|DEAD, `attempts`, `nextAttemptAt`, `provider`, `providerMessageId`?, `lastError`?, `sourceEventId`?, `dedupeKey` (unique), `readAt`? (in-app) | unique `dedupeKey`; `status+nextAttemptAt`; `userId+createdAt`; `providerMessageId` |
| `provider_callbacks` | `provider`, `payload`, `receivedAt`, `verified` | TTL 30 d |
| `realtime_tickets` | (Redis only: `rt:ticket:<id>` → JSON auth, TTL 30 s) | — |

## 4. State machines (backend-enforced via `assertTransition`)

### 4.1 Child order
| From → To | Actor(s) | Preconditions | Timestamps / effects | Events |
|---|---|---|---|---|
| AWAITING_PAYMENT → PLACED | SYSTEM (payment.captured) | checkout not expired; payment amount == group total | `placedAt`, `acceptBy = now + ACCEPT_WINDOW_SEC` (300) | `order.placed` |
| AWAITING_PAYMENT → PAYMENT_FAILED | SYSTEM | payment.failed | — | `checkout.released` (group) |
| AWAITING_PAYMENT → EXPIRED | SYSTEM (sweeper) | now > expiresAt AND provider reconcile says not captured | — | `checkout.released` |
| PLACED → ACCEPTED | RESTAURANT (owner of restaurant), ADMIN | now ≤ acceptBy (restaurant); prepMinutes 5–120 | `acceptedAt`, `readyEta` | `order.accepted` → delivery job |
| PLACED → REJECTED | RESTAURANT (reason required), SYSTEM (timeout reason RESTAURANT_TIMEOUT), ADMIN | — | `refundStatus=REQUESTED` | `order.rejected` {refundPaise=breakdown.totalPaise} |
| PLACED → CANCELLED | CUSTOMER (owner), ADMIN | — | `cancelledAt`, refund REQUESTED | `order.cancelled` {refundPaise} |
| ACCEPTED → PREPARING | RESTAURANT | — | — | `order.preparing` |
| ACCEPTED/PREPARING → READY_FOR_PICKUP | RESTAURANT | — | `readyAt` | `order.ready` |
| ACCEPTED/PREPARING/READY_FOR_PICKUP → CANCELLED | ADMIN only (reason, refundPaise ≤ remaining) | — | refund REQUESTED if refundPaise>0 | `order.cancelled` → delivery cancels job |
| READY_FOR_PICKUP (or ACCEPTED/PREPARING) → PICKED_UP | SYSTEM (delivery.picked_up) | delivery job matches | `pickedUpAt` | `order.picked_up` |
| PICKED_UP → OUT_FOR_DELIVERY | SYSTEM (delivery.started) | — | — | `order.out_for_delivery` |
| OUT_FOR_DELIVERY (or PICKED_UP) → DELIVERED | SYSTEM (delivery.delivered) | — | `deliveredAt` | `order.delivered` → ledger |
| PICKED_UP/OUT_FOR_DELIVERY → DELIVERY_FAILED | SYSTEM (delivery.failed), ADMIN | — | admin decides refund via cancel-with-refund action on the failed order (DELIVERY_FAILED → CANCELLED, ADMIN) | `order.delivery_failed` |
| DELIVERY_FAILED → CANCELLED | ADMIN | refundPaise ≤ remaining | refund | `order.cancelled` |

Terminal: DELIVERED, REJECTED, CANCELLED, PAYMENT_FAILED, EXPIRED.
Restaurant acting after `acceptBy`: 409 `ORDER_ACCEPT_WINDOW_EXPIRED`; sweeper auto-rejects.
Ordering of system events: `delivery.picked_up` received while child is ACCEPTED/PREPARING is
allowed (restaurant forgot to mark ready). `delivery.delivered` while PICKED_UP passes through
OUT_FOR_DELIVERY implicitly (two history entries).

### 4.2 Checkout group (derived)
`AWAITING_PAYMENT → PAID_PLACED → (IN_PROGRESS) → COMPLETED | PARTIALLY_COMPLETED | CANCELLED`
and `AWAITING_PAYMENT → PAYMENT_FAILED | EXPIRED`.
`deriveCheckoutStatus(children)`:
- any AWAITING_PAYMENT → AWAITING_PAYMENT (unchanged); all PAYMENT_FAILED → PAYMENT_FAILED;
  all EXPIRED → EXPIRED
- all children terminal: all DELIVERED → COMPLETED; ≥1 DELIVERED → PARTIALLY_COMPLETED;
  none DELIVERED → CANCELLED
- else if all PLACED → PAID_PLACED; otherwise IN_PROGRESS.
Non-terminal DELIVERY_FAILED counts as non-terminal (awaiting admin).

### 4.3 Payment intent
`CREATED → AUTHORIZED → CAPTURED`, `CREATED → CAPTURED` (captured webhook/reconcile without a seen authorization), `CREATED|AUTHORIZED → FAILED`, `FAILED → CAPTURED` (a later successful attempt on the same provider order — Razorpay allows retries), `CAPTURED → PARTIALLY_REFUNDED → REFUNDED`, `PARTIALLY_REFUNDED → PARTIALLY_REFUNDED` (further partial refunds),
`CAPTURED → REFUNDED`. All payment transitions actor SYSTEM. Out-of-order rule: an event that implies an earlier state than current is
recorded (`IGNORED_STALE`) and not applied (e.g. `payment.authorized` after CAPTURED; `payment.failed`
after CAPTURED is ignored + alert). Razorpay auto-capture is configured; if AUTHORIZED persists
> 5 min, reconciliation calls capture API.

### 4.4 Refund
`REQUESTED → PROCESSING → SUCCEEDED`, `PROCESSING → FAILED → PROCESSING` (retry, max 5, backoff
1m·2^n), `REQUESTED → FAILED`. `FAILED` after max attempts surfaces in admin finance for manual
retry. Customer UI shows "Refund initiated" (REQUESTED/PROCESSING) vs "Refunded" (SUCCEEDED).
Sum of non-failed refunds for a child ≤ child total; for a payment ≤ capturedPaise (enforced
in a transaction on payment_intents with `refundedPaise` reservation).

### 4.5 Delivery job
`PENDING_ASSIGNMENT → OFFERED → ASSIGNED → AT_PICKUP → PICKED_UP → OUT_FOR_DELIVERY → DELIVERED`;
`OFFERED → PENDING_ASSIGNMENT` (all offers expired); `ASSIGNED/AT_PICKUP → PENDING_ASSIGNMENT`
(admin unassign / partner drop before pickup); `PICKED_UP/OUT_FOR_DELIVERY → FAILED` (partner
with reason, admin); any non-terminal → CANCELLED (order cancelled); `PENDING_ASSIGNMENT`
exceeding `MAX_DISPATCH_ROUNDS` (5) → flagged `exception=true` (status unchanged) +
`delivery.exception`.
Actors: SYSTEM (dispatch/expiry), PARTNER (assigned partner only), ADMIN.
Pickup requires pickup code (from restaurant screen); drop requires delivery code (customer);
≤ 5 wrong code attempts then lock + admin.

### 4.6 Restaurant onboarding
`DRAFT → VERIFICATION_PENDING` (owner submits; required fields complete; sends verification
email) → `APPROVAL_PENDING` (SYSTEM on email verified) → `APPROVED` (ADMIN) ;
`APPROVAL_PENDING → REJECTED` (ADMIN, reason) ; `REJECTED → APPROVAL_PENDING` (owner resubmit,
email still verified) ; `APPROVED → SUSPENDED` (ADMIN, reason) ; `SUSPENDED → APPROVED` (ADMIN).
Changing `businessEmail` after verification resets `emailVerifiedAt` and, if not yet approved,
returns to VERIFICATION_PENDING. Public discovery requires `status=APPROVED`.

### 4.7 Partner
`DRAFT → APPROVAL_PENDING` (profile + vehicle + required docs) → `APPROVED | REJECTED` (ADMIN);
`REJECTED → APPROVAL_PENDING` (resubmit); `APPROVED ↔ SUSPENDED` (ADMIN). Only APPROVED partners
may go online / receive offers. Suspension while online forces offline; active jobs returned to
PENDING_ASSIGNMENT if not yet picked up.

## 5. Security details
5.1 OTP: `POST /auth/otp/request {phone}` → normalize → limits: per phone 30 s cooldown
(`OTP_RESEND_COOLDOWN_SEC`), 5/hour (`OTP_MAX_PER_HOUR`); per IP 20/hour. New request
invalidates previous unconsumed challenge. Code: `crypto.randomInt(0, 1_000_000)` padded.
`POST /auth/otp/verify {phone, code, guestCartToken?}` → latest unconsumed, unexpired challenge;
`attempts++` atomically (`findOneAndUpdate` with `attempts < maxAttempts`); constant-time compare;
on success set `consumedAt` (single use, conditional update `consumedAt: null`). Response:
`{ accessToken, user, guestCartMerged?: boolean }` + refresh cookie. Demo: if `APP_MODE=demo`
and `DEMO_OTP_ENABLED=true` and phone ∈ `DEMO_PHONES`, code `123456` accepted (challenge still
created, SMS not sent; response includes `demoOtp: true`).
5.2 Refresh rotation: `POST /auth/refresh` (cookie) → find session by hash; if matches
`prevRefreshHash` within 10 s grace → return current (multi-tab race); if matches an old hash →
reuse detected → revoke family. Otherwise rotate.
5.3 Admin login: `POST /auth/admin/login {email,password}` → lockout after 5 failures for 15 min →
if TOTP enabled returns `{ mfaRequired: true, mfaToken }` (5 min JWT, aud `mfa`) → `POST
/auth/admin/mfa {mfaToken, code}` → tokens with `amr:['pwd','mfa']`. First login when TOTP not
enabled → `POST /auth/admin/mfa/setup` returns otpauth URI; `/mfa/enable {code}`. Admin endpoints
require `amr` contains `mfa`.
5.4 Rate limits (Redis, `rate-limiter-flexible`-style fixed window implemented in service-kit):
OTP as above; admin login 10/15 min per IP+email; search 60/min per IP; checkout create 10/min
per user; location ping 1/3 s per partner; gateway global 300/min per IP.
5.5 Log redaction paths: `req.headers.authorization`, `req.headers.cookie`, `*.password`,
`*.code`, `*.otp`, `*.token`, `*.refreshToken`, `*.accountNumber`, `*.totpSecret`, `res.headers["set-cookie"]`.
5.6 Field encryption: `encrypt(plaintext)` → `v1:<iv b64>:<tag b64>:<ct b64>` AES-256-GCM,
key = base64 32 bytes `FIELD_ENCRYPTION_KEY`.

## 6. Pricing algorithm (`priceCheckout`)
For each restaurant child `r` (sorted by `restaurantId` asc for determinism):
1. `lineTotal = (unitPricePaise + Σ addOn.pricePaise) × quantity`; `itemsSubtotal_r = Σ lineTotal`.
2. **Coupon** (`couponDiscountPaise` D computed by marketplace against Σ itemsSubtotal, capped ≤ Σ subtotal):
   `alloc = allocateProRata(D, weights = itemsSubtotal_r)`.
3. **Membership extra discount**: `M = min(cap, floor(Σ(itemsSubtotal_r − couponAlloc_r) × bps / 10000))`,
   allocated pro-rata by `(itemsSubtotal_r − couponAlloc_r)`.
4. **Delivery**: `deliveryFee_r` given; `deliveryDiscount_r = deliveryFee_r` if r ∈ freeDeliveryRestaurantIds else 0.
5. `packagingFee_r` given; `platformFee_r = platformFeePaise` (per child).
6. `foodTaxable_r = itemsSubtotal_r − couponAlloc_r − membershipAlloc_r + packagingFee_r`;
   `foodTax_r = floor((foodTaxable_r × foodTaxBps + 5000) / 10000)`.
7. `feeTaxable_r = (deliveryFee_r − deliveryDiscount_r) + platformFee_r`;
   `feeTax_r = floor((feeTaxable_r × feeTaxBps + 5000) / 10000)`.
8. `total_r = itemsSubtotal_r − couponAlloc_r − membershipAlloc_r + packagingFee_r + deliveryFee_r − deliveryDiscount_r + platformFee_r + foodTax_r + feeTax_r`.
9. Group totals = component-wise sum of children (so reconciliation is exact by construction).

`allocateProRata(T, weights)`: if Σw = 0 → all to first key. Else `base_k = floor(T × w_k / Σw)`;
remainder `R = T − Σbase`; give +1 to the R keys with largest fractional part
`(T × w_k) mod Σw`, ties broken by key asc. Σ result == T exactly.

Refund for a rejected/cancelled child = `breakdown.totalPaise` of that child (minus prior
refunds). Coupon: if all children of a checkout are rejected/cancelled before delivery, coupon
redemption is released; partial → coupon stays redeemed (documented customer-friendly
simplification: the refund returns the child's allocated net amount).

Membership free delivery: `freeDeliveryRestaurantIds` = children with `itemsSubtotal_r ≥
freeDeliveryMinOrderPaise`, limited to remaining `freeDeliveriesPerPeriod`, chosen by highest
deliveryFee first (ties by restaurantId). Computed by marketplace `POST /internal/memberships/benefits`.

Delivery fee per child (marketplace): `distanceKm` (geo provider) from restaurant to drop;
`fee = min(maxPaise, basePaise + max(0, ceil(distanceKm − baseKm)) × perKmPaise)` using the
service area containing the drop point.

## 7. Dispatch & batching policy (delivery)
Config (env, defaults): `MAX_ACTIVE_DELIVERIES=2`, `OFFER_TTL_SEC=45`, `OFFERS_PER_ROUND=3`,
`DISPATCH_RADIUS_KM=[3,5,8]` per round (last value repeats), `MAX_DISPATCH_ROUNDS=5`,
`BATCH_PICKUP_RADIUS_KM=1.5`, `BATCH_DROP_RADIUS_KM=3`, `BATCH_MAX_EXTRA_MINUTES=12`,
`LOCATION_STALE_SEC=60`, `AVG_SPEED_KMPH=20`, `ROAD_FACTOR=1.3`.

Candidate partner p for job j is eligible iff: status APPROVED, online, `lastLocationAt` within
120 s, distance(p.lastLocation, j.pickup) ≤ round radius, no OFFERED offer for j already, and
either (a) `activeJobIds` empty, or (b) batching rule:
1. `activeJobIds.length < MAX_ACTIVE_DELIVERIES`
2. every active job is not yet PICKED_UP **or** j.pickup == active job's pickup restaurant
   (keep it simple: we only batch before pickup)
3. distance(j.pickup, active.pickup) ≤ BATCH_PICKUP_RADIUS_KM
4. distance(j.drop, active.drop) ≤ BATCH_DROP_RADIUS_KM
5. extraMinutes = time(route p→pickupA→pickupB→dropA→dropB) − time(p→pickupA→dropA) for the
   existing customer ≤ BATCH_MAX_EXTRA_MINUTES (haversine × ROAD_FACTOR / AVG_SPEED)
Evaluation records `reasons[]` strings (e.g. `"pickup 0.8km ≤ 1.5km ✓"`), shown in the partner UI.
Ranking: idle partners before batch candidates, then ascending distance to pickup.

Atomic accept (`POST /deliveries/offers/:offerId/accept`) inside one Mongo transaction:
1. offer `findOneAndUpdate({_id, partnerId: me, status: OFFERED, expiresAt > now}, {status: ACCEPTED})` — else 409 `OFFER_EXPIRED`
2. job `findOneAndUpdate({_id, status: {$in:[PENDING_ASSIGNMENT, OFFERED]}, partnerId: null}, {status: ASSIGNED, partnerId, ...})` — else 409 `ASSIGNMENT_TAKEN`
3. partner `findOneAndUpdate({_id, status: APPROVED, online: true, $expr: {$lt: [{$size:'$activeJobIds'}, MAX]}}, {$push: {activeJobIds: jobId}})` — else 409 `CAPACITY_EXCEEDED`
4. cancel other OFFERED offers for job; outbox `delivery.assigned`. Any failure aborts txn.

Dispatcher sweeper (every 5 s, leader-locked): expire offers past TTL; for jobs in
PENDING_ASSIGNMENT/OFFERED with no live offers → next round.

## 8. Checkout saga details (orders)
`POST /api/v1/checkouts` body `{ cartId? (implicit user cart), addressId | address, couponCode?,
useMembership: boolean, expectedTotalPaise? }`, header `Idempotency-Key`.
1. Load user cart; reject empty (422 `CART_EMPTY`).
2. Call marketplace `POST /internal/quote` with `{ drop?: {lat,lng}, items: [{lineRef?, restaurantId,itemId,quantity,selections}] }` (lines echo `lineRef`, in request order) →
   per restaurant: `{ restaurantId, name, ownerUserId, location, open: bool, serviceable: bool,
   deliveryFeePaise, distanceKm, etaMinutes, etaSource, packagingFeePaise, lines: [{itemId, name,
   isVeg, unitPricePaise, addOns:[...], available: bool, stockOk: bool}] }` or problems list.
   Any problem → 422 with code `RESTAURANT_CLOSED|NOT_SERVICEABLE|ITEM_UNAVAILABLE|OUT_OF_STOCK`
   and `details.problems[]` (UI shows and offers to fix cart).
3. If cart display prices differ from quote → update cart snapshot; if `expectedTotalPaise` given
   and new total differs → 422 `PRICE_CHANGED` with new breakdown (client must confirm).
4. Coupon: `POST /internal/coupons/validate {code, userId, itemsSubtotalPaise}` → `{discountPaise}`.
   Membership: `POST /internal/memberships/benefits {userId, children:[{restaurantId, itemsSubtotalPaise, deliveryFeePaise}]}`.
5. Pricing via `priceCheckout`.
6. Generate `checkoutId` (ObjectId) before reservation. Call marketplace
   `POST /internal/reservations {checkoutId, userId, lines, couponCode?, couponDiscountPaise, membership?: {membershipId, freeDeliveries, discountPaise}, ttlSec: 900}` — one marketplace txn:
   conditional `$inc reservedQty` where `stockQty - reservedQty >= qty` for tracked items; coupon
   `heldCount++` where `usedCount + heldCount < totalLimit` and per-user count check; membership
   usage HELD. Fails → 409 `OUT_OF_STOCK` / 422 `COUPON_LIMIT_REACHED`. Idempotent on checkoutId.
7. Orders txn: insert CheckoutGroup + ChildOrders (AWAITING_PAYMENT, codes, pickup/delivery
   codes) + outbox `checkout.created`; mark cart `checkedOutVersion`.
8. Payments `POST /internal/payment-intents {purpose:'CHECKOUT', referenceId: checkoutId, userId,
   amountPaise}` → `{ paymentIntentId, provider, providerOrderId, keyId?, amountPaise, currency, demoPayUrl? }`.
   On failure → mark checkout PAYMENT_FAILED + `checkout.released`; return 502 `PAYMENT_PROVIDER_UNAVAILABLE`.
9. Respond 201 `{ checkout, payment }`.
Cart is **not** cleared until `payment.captured` is applied (so leaving mid-payment keeps cart).
On PLACED: clear purchased cart items (if cartVersion unchanged; otherwise remove matching lines).

Consumers in orders:
- `payment.captured {purpose:CHECKOUT, referenceId, amountPaise}` → if checkout AWAITING_PAYMENT
  and amount == pricing.totalPaise → children PLACED; emit `checkout.confirmed`, `order.placed`×N.
  If checkout EXPIRED/PAYMENT_FAILED → emit `checkout.late_payment {checkoutId, amountPaise}`.
- `payment.failed` → mirror only: record `paymentStatus=FAILED` + timeline entry; checkout stays AWAITING_PAYMENT with reservations held so the customer can retry on the same provider order (LLD §4.3 FAILED→CAPTURED). The expiry sweeper (reconcile-first) moves it to EXPIRED/PAYMENT_FAILED and emits `checkout.released`.
- `refund.*` → update child `refundStatus`, `refundedPaise`.
- `delivery.*` → child transitions per §4.1; `delivery.assigned` stores `deliveryJobId`.
- `restaurant.*` → upsert `restaurant_projection`.
Sweepers: (a) checkouts AWAITING_PAYMENT with `expiresAt < now` → call payments
`POST /internal/payment-intents/:id/reconcile`; result CAPTURED → apply as captured; else EXPIRED +
release. (b) PLACED children with `acceptBy < now` → REJECTED reason RESTAURANT_TIMEOUT.

## 9. Event catalog (payloads; all include envelope)
| Type | Producer | Payload | Consumers |
|---|---|---|---|
| `user.registered` | identity | `{userId, phone}` | notifications (welcome, optional) |
| `role.granted` | identity | `{userId, role}` | — |
| `audit.recorded` | all | `{actorId, actorRole, action, targetType, targetId, summary, ip?, service}` | identity |
| `restaurant.submitted` | marketplace | `{restaurantId, ownerUserId}` | notifications |
| `restaurant.email_verification_requested` | marketplace | `{restaurantId, email, verifyUrl}` (url contains raw token; notifications must not log it) | notifications |
| `restaurant.status_changed` | marketplace | `{restaurantId, ownerUserId, name, from, to, reason?, location}` | orders (projection), notifications |
| `restaurant.updated` | marketplace | `{restaurantId, ownerUserId, name, status, location}` | orders |
| `membership.activated` | marketplace | `{membershipId, userId, planId, endsAt}` | notifications |
| `checkout.created` | orders | `{checkoutId, userId, totalPaise, childOrderIds}` | — |
| `checkout.confirmed` | orders | `{checkoutId, userId, childOrderIds}` | marketplace (commit reservation, redeem coupon, use membership) |
| `checkout.released` | orders | `{checkoutId, reason: PAYMENT_FAILED\|EXPIRED}` | marketplace (release) |
| `checkout.late_payment` | orders | `{checkoutId, paymentIntentId?, amountPaise}` | payments (full refund LATE_PAYMENT) |
| `order.placed` | orders | `{childOrderId, checkoutId, userId, restaurantId, restaurantOwnerId, code, totalPaise, acceptBy}` | notifications (restaurant + customer) |
| `order.accepted` | orders | `{childOrderId, checkoutId, userId, restaurantId, prepMinutes, pickup:{name,address,location}, drop:{name,address,location,phoneMasked}, pickupCode, deliveryCode}` | delivery (create job), notifications |
| `order.rejected` | orders | `{childOrderId, checkoutId, userId, restaurantId, reason, refundPaise}` | payments (refund), marketplace (release stock for that child: restore `stockQty`), notifications |
| `order.cancelled` | orders | `{childOrderId, checkoutId, userId, restaurantId, actor, reason, refundPaise}` | payments, delivery (cancel job), marketplace (restock if before PREPARING), notifications |
| `order.preparing` / `order.ready` | orders | `{childOrderId, restaurantId, userId}` | delivery (ready flag), notifications |
| `order.picked_up` / `order.out_for_delivery` | orders | `{childOrderId, userId}` | notifications |
| `order.delivered` | orders | `{childOrderId, checkoutId, userId, restaurantId, restaurantOwnerId, breakdown, commissionBps, deliveryJobId, partnerUserId, deliveryDistanceKm}` | payments (ledger), notifications |
| `order.delivery_failed` | orders | `{childOrderId, reason}` | notifications (admin), delivery (ends the job: PICKED_UP/OUT_FOR_DELIVERY → FAILED as ADMIN, else CANCELLED; releases capacity; its `delivery.failed` is a mirror-only no-op in orders) |
| `payment.captured` | payments | `{paymentIntentId, purpose, referenceId, userId, amountPaise, providerPaymentId}` | orders / marketplace (membership) |
| `payment.failed` | payments | `{paymentIntentId, purpose, referenceId, userId, reason}` | orders / marketplace |
| `refund.requested` / `refund.processing` / `refund.succeeded` / `refund.failed` | payments | `{refundId, childOrderId?, checkoutGroupId, amountPaise, reason, status}` | orders, notifications |
| `delivery.job_created` | delivery | `{jobId, childOrderId}` | — |
| `delivery.assigned` | delivery | `{jobId, childOrderId, partnerId, partnerUserId, partnerName, vehicle}` | orders, notifications |
| `delivery.unassigned` | delivery | `{jobId, childOrderId, reason}` | orders |
| `delivery.picked_up` / `delivery.started` / `delivery.delivered` | delivery | `{jobId, childOrderId, partnerUserId, at}` (+ `distanceKm` on delivered) | orders, notifications |
| `delivery.failed` | delivery | `{jobId, childOrderId, reason}` | orders |
| `delivery.exception` | delivery | `{jobId, childOrderId, reason}` | notifications (admin) |
| `partner.status_changed` | delivery | `{partnerId, userId, from, to, reason?}` | notifications |

Membership purchase: marketplace creates membership PENDING_PAYMENT, calls payments
`/internal/payment-intents {purpose: MEMBERSHIP}`; `payment.captured` (purpose MEMBERSHIP) →
marketplace activates.

## 10. External API catalog (via gateway, `/api/v1`)
Legend: 🔓 public, 👤 any authenticated user, 🍽 RESTAURANT_OWNER (+ownership), 🛵 DELIVERY_PARTNER
(+ownership), 🛡 ADMIN+MFA, 🪝 provider webhook (signature).

**gateway**: 🔓 `GET /meta` → `{mode, brand, currency, timezone, providers:{payment,sms,email,maps,storage: 'live'|'sandbox'|'demo'}}`; 🛡 `GET /admin/health`; 🔓 `GET /api/docs` (disabled in prod unless `DOCS_ENABLED`).

**identity**: 🔓 `POST /auth/otp/request`, `POST /auth/otp/verify`, `POST /auth/refresh`, `POST /auth/logout`, `POST /auth/admin/login`, `POST /auth/admin/mfa`; 🛡(pwd only) `POST /auth/admin/mfa/setup`, `POST /auth/admin/mfa/enable`; 👤 `POST /auth/logout-all`, `GET/PATCH /me`, `GET/POST /me/addresses`, `PATCH/DELETE /me/addresses/:id`, `PUT /me/notification-prefs`; 🛡 `GET /admin/users`, `GET /admin/users/:id`, `POST /admin/users/:id/block|unblock`, `POST /admin/admins` (SUPER_ADMIN), `GET /admin/audit-logs`; 🔓 `GET /.well-known/jwks.json`.
Internal: `POST /internal/users/:id/roles {role}`, `GET /internal/users/:id`.

**marketplace**: 🔓 `GET /discovery/restaurants?lat&lng&q&veg&cuisine&priceBand&openNow&sort&cursor`, `GET /discovery/search?lat&lng&q` (restaurants + items), `GET /restaurants/:idOrSlug?lat&lng` (menu included), `GET /cuisines`, `GET /banners`, `GET /memberships/plans`, `GET /restaurants/verify-email?token=` (redirect to SPA), `GET /discovery/serviceability?lat&lng`;
👤 `POST /owner/restaurants` (create DRAFT; grants RESTAURANT_OWNER), `GET /memberships/me`, `POST /memberships/purchase` (Idempotency-Key), `GET /coupons/available`, `POST /restaurants/:id/ratings`;
🍽 `GET /owner/restaurants`, `GET/PATCH /owner/restaurants/:id`, `POST /owner/restaurants/:id/submit`, `POST /owner/restaurants/:id/resend-verification`, `POST /owner/restaurants/:id/uploads` (presign), `POST /owner/restaurants/:id/documents`, `PUT /owner/restaurants/:id/settlement`, `PUT /owner/restaurants/:id/hours`, `POST /owner/restaurants/:id/pause {minutes}` / `resume`, CRUD `/owner/restaurants/:id/categories`, CRUD `/owner/restaurants/:id/items`, `PATCH /owner/restaurants/:id/items/:itemId/availability {available, stockQty?}`, `GET /owner/restaurants/:id/dashboard`;
🛡 `GET /admin/marketplace/restaurants?status`, `GET /admin/marketplace/restaurants/:id`, `POST .../:id/approve|reject|suspend|reinstate {reason}`, `GET .../:id/documents/:docId/url`, CRUD `/admin/marketplace/coupons|banners|cuisines|plans|service-areas`, `GET /admin/marketplace/overview`.
Internal: `POST /internal/quote`, `POST /internal/coupons/validate`, `POST /internal/memberships/benefits`, `POST /internal/reservations`, `GET /internal/restaurants/:id`.

**orders**: 🔓(guest token header `X-Guest-Cart`) / 👤 `GET /cart`, `POST /cart/items`, `PATCH /cart/items/:lineId`, `DELETE /cart/items/:lineId`, `DELETE /cart`, `POST /cart/guest` (issue guest token), `PUT /cart/address`, `PUT /cart/coupon`; 👤 `POST /cart/merge {guestToken}`, `POST /cart/preview` (server quote + pricing, no reservation), `POST /checkouts` (Idempotency-Key), `GET /checkouts/:id`, `GET /orders` (groups, paginated), `GET /orders/:checkoutId`, `POST /orders/child/:childId/cancel`, `POST /orders/:checkoutId/reorder`, `POST /support/tickets`, `GET /support/tickets`, `GET /support/tickets/:id`, `POST /support/tickets/:id/messages`;
🍽 `GET /owner/orders?restaurantId&status&cursor`, `GET /owner/orders/:childId`, `POST /owner/orders/:childId/accept {prepMinutes}`, `.../reject {reason}`, `.../preparing`, `.../ready`, `PATCH .../prep-time {prepMinutes}`, `GET /owner/orders/stats?restaurantId&from&to`;
🛡 `GET /admin/orders?q&status&restaurantId&phone&from&to`, `GET /admin/orders/:checkoutId` (timeline), `POST /admin/orders/child/:childId/cancel {reason, refundPaise}`, `POST /admin/orders/child/:childId/transition {to, reason}` (only transitions allowed for ADMIN), `GET /admin/orders/overview`, `GET/PATCH /admin/support/tickets...`, `POST /admin/support/tickets/:id/messages`.
Internal: `GET /internal/orders/child/:id`, `GET /internal/orders/stats?restaurantId&from&to`, `GET /internal/checkouts/:id/status`, `POST /internal/cart/merge {userId, guestToken}` (caller: identity).

**payments**: 🪝 `POST /webhooks/razorpay` (raw body); 👤 `GET /payments/checkout/:checkoutId` (status for polling), `POST /payments/:intentId/verify` (client-side signature check → triggers reconcile only; never marks paid by itself); 👤(demo only, intent owner) `GET /demo-pay/:intentId` page data, `POST /demo-pay/:intentId/complete {outcome: success|failure}` → emits signed mock webhook into the same pipeline;
🍽 `GET /finance/restaurants/:restaurantId/summary|ledger|payouts`; 🛵 `GET /finance/partner/summary|ledger|payouts`;
🛡 `GET /admin/finance/refunds?status`, `POST /admin/finance/refunds/:id/retry`, `POST /admin/finance/refunds` (manual, Idempotency-Key, ≤ remaining captured; with `childOrderId` payments checks via orders `GET /internal/orders/child/:id` that the child is in this payment's checkout and `restaurantId` matches → else 422 `REFUND_TARGET_MISMATCH`, and amount ≤ child total − committed refunds for the child → else 422 `REFUND_EXCEEDS_REMAINING`), `GET /admin/finance/balances?accountType`, `POST /admin/finance/payouts` (Idempotency-Key), `POST /admin/finance/payouts/:id/confirm {utr}`, `POST /admin/finance/payouts/:id/fail {reason}`, `GET /admin/finance/payments?q`.
Internal: `POST /internal/payment-intents`, `POST /internal/payment-intents/:id/reconcile`, `GET /internal/payment-intents/by-reference/:purpose/:refId`.

**delivery**: 🛵/👤 `POST /partner/profile` (create DRAFT; grants DELIVERY_PARTNER), `GET/PATCH /partner/profile`, `POST /partner/uploads` (presign), `POST /partner/documents`, `POST /partner/submit`, `POST /partner/online {lat,lng}`, `POST /partner/offline`, `POST /partner/location {lat,lng,accuracyM}`, `GET /partner/offers`, `POST /deliveries/offers/:offerId/accept|reject`, `GET /deliveries/active`, `GET /deliveries/history`, `POST /deliveries/:jobId/arrived`, `POST /deliveries/:jobId/pickup {code}`, `POST /deliveries/:jobId/start`, `POST /deliveries/:jobId/deliver {code}`, `POST /deliveries/:jobId/fail {reason}`, `POST /deliveries/:jobId/location {lat,lng,accuracyM}`;
👤 `GET /deliveries/tracking/:childOrderId` (customer owner only: status, partner first name, vehicle, last location, lastLocationAt, stale flag, simulated flag);
🛡 `GET /admin/delivery/partners?status`, `POST /admin/delivery/partners/:id/approve|reject|suspend|reinstate`, `GET /admin/delivery/partners/:id/documents/:docId/url`, `GET /admin/delivery/jobs?status&exception`, `POST /admin/delivery/jobs/:id/assign {partnerId}`, `POST /admin/delivery/jobs/:id/unassign`, `POST /admin/delivery/jobs/:id/fail {reason}`, `POST /admin/delivery/demo/simulate/:jobId` (demo only), `GET /admin/delivery/overview`.

**notifications**: 👤 `GET /notifications` (in-app), `POST /notifications/:id/read`, `POST /realtime/ticket`, 🔓(ticket) `GET /realtime/stream?ticket=`; 🪝 `POST /webhooks/twilio/status`, `POST /webhooks/resend`; 🛡 `GET /admin/notifications?status`, `POST /admin/notifications/:id/retry`, `GET /admin/notifications/dead-letters` (event DLQ across services via internal calls), `POST /admin/notifications/dead-letters/:service/:id/replay`.
Internal: `POST /internal/notifications/otp {phone, code}` (synchronous send; body not persisted), `POST /internal/notifications/send {channel, to, template, data, dedupeKey}`.
All services: internal `GET /internal/health/details`, `POST /internal/dead-letters/:id/replay`, `GET /internal/dead-letters`, `GET /internal/routes` (method+path list for OpenAPI coverage checks).

## 11. Realtime messages (SSE `event:` names)
`order.updated {checkoutId, childOrderId, status, refundStatus, deliveryStatus}` → user;
`owner.order {childOrderId, restaurantId, status}` → `rt:owner:<ownerUserId>`;
`delivery.location {childOrderId, lat, lng, at, simulated}` → customer;
`partner.offer {offerId, jobId, expiresAt}` → `rt:partner:<partnerUserId>`; `notification {id, title, body}` → user;
heartbeats every 20 s (`: ping`).

## 12. Configuration (env)
Common: `APP_MODE`, `MONGO_URI` (e.g. `mongodb://thali:pw@mongo:27017/?replicaSet=rs0&authSource=admin`),
`REDIS_URL`, `INTERNAL_SERVICE_SECRET`, `LOG_LEVEL`, `CORS_ORIGINS`, `DOCS_ENABLED`, `PUBLIC_WEB_URL`,
`PUBLIC_API_URL`. Identity: `JWT_PRIVATE_KEY_PEM`/`JWT_PUBLIC_KEY_PEM` (Ed25519; demo auto-generates and
persists in DB `keys` collection if absent and `APP_MODE!=production`), `OTP_PEPPER`, `DEMO_OTP_ENABLED`,
`DEMO_PHONES`, `FIELD_ENCRYPTION_KEY`, `ADMIN_SESSION_HOURS`. Marketplace: `GEO_PROVIDER=google|demo`,
`GOOGLE_MAPS_API_KEY`, `STORAGE_PROVIDER=s3`, `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`,
`S3_SECRET_ACCESS_KEY`, `S3_PUBLIC_BUCKET`, `S3_PRIVATE_BUCKET`, `S3_PUBLIC_BASE_URL`, `FIELD_ENCRYPTION_KEY`.
Orders: `ACCEPT_WINDOW_SEC=300`, `CHECKOUT_TTL_SEC=900`, `FOOD_TAX_BPS=500`, `FEE_TAX_BPS=1800`,
`PLATFORM_FEE_PAISE=500`. Payments: `PAYMENT_PROVIDER=razorpay|mock`, `RAZORPAY_KEY_ID`,
`RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `MOCK_WEBHOOK_SECRET`, `PAYOUT_HOLD_DAYS`,
`PARTNER_BASE_PAYOUT_PAISE=3000`, `PARTNER_PER_KM_PAISE=800`. Delivery: §7 vars, `GEO_PROVIDER`,
storage vars. Notifications: `SMS_PROVIDER=twilio|mock`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`,
`TWILIO_FROM` / `TWILIO_MESSAGING_SERVICE_SID`, `EMAIL_PROVIDER=resend|mailpit|mock`, `RESEND_API_KEY`,
`RESEND_WEBHOOK_SECRET`, `EMAIL_FROM`, `MAILPIT_URL` (demo: Mailpit HTTP send API `POST /api/v1/send`).

## 13. Testing strategy
- **Unit** (vitest): pricing (incl. property tests on reconciliation), state machines, phone
  normalization, batching policy, allocation, signature verification, OTP logic.
- **Integration** (vitest + supertest): each service against real Mongo replica set + Redis
  from `docker-compose.infra.yml` (test DB names suffixed with random id, dropped after).
  Cross-service flows are tested by running handlers with real events (in-process service apps
  sharing the test Redis) — `services/*/test/*.int.test.ts`.
- **E2E** (Playwright, demo mode, full compose stack): the 12 completion flows.
- Required scenario list (PRD §14 of brief) mapped to test files in the plan.

## 14. Retention & data lifecycle
- OTP challenges: TTL 1 day. Sessions: TTL on expiry. Location pings: 7 days. Provider callbacks: 30 days.
- Orders, payments, refunds, ledger: retained (financial records ≥ 8 years per Indian accounting
  norms — confirm with counsel); never hard-deleted. Customer account deletion = anonymize PII on
  `users` (phone/email/name/addresses nulled, `deletedAt`), orders keep masked contact snapshot.
- Documents (KYC): private bucket, retained while account active + configurable period; admin URLs
  expire in 5 min.
- Schema evolution: additive changes with defaults; `schemaVersion` field on aggregates; one-off
  migration scripts in `scripts/migrations/NNN-*.ts` run via `npm run migrate -w <svc>` recorded in
  `migrations` collection. Events carry `version`; consumers ignore unknown fields.
