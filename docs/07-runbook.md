# Operations runbook

Concise, command-level procedures for the failures that are likely in a pilot. Everything here is built from
the shipped admin APIs, internal endpoints and Mongo/Redis structures. Procedures that need a database shell
change data directly: do them in staging first and write down what you changed.

Conventions

- `$API` = public base URL (local: `http://localhost:8080`), `$ADMIN_TOKEN` = an admin access token (below).
- Local compose commands are shown as `docker compose exec <service> ...`; in ECS use ECS Exec
  (`aws ecs execute-command ...`) into the same container.
- Money is integer paise. IDs are Mongo ObjectId hex strings. Every response carries `x-request-id`; the same
  value appears as `reqId`/`correlationId` in logs and event envelopes, so one id traces a request across
  services.
- Scheduled workers (relay, checkout sweeper, acceptance timeout, dispatcher, refund worker, reconcile job,
  notification retry worker, reservation sweeper) are **leader-locked in Redis**: if a worker looks idle, check
  that Redis is up and that one instance logs as leader.

## 0. Toolbox

### 0.1 Get an admin token

```bash
API=http://localhost:8080
curl -sS -X POST $API/api/v1/auth/admin/login -H 'content-type: application/json' \
  -d '{"email":"ops@example.com","password":"..."}'
# -> {"mfaRequired":true,"mfaToken":"...","expiresInSec":300}
curl -sS -X POST $API/api/v1/auth/admin/mfa -H 'content-type: application/json' \
  -d '{"mfaToken":"<mfaToken>","code":"<6-digit TOTP>"}'
# -> {"accessToken":"...", ...}      (15 min lifetime; amr includes mfa)
export ADMIN_TOKEN=<accessToken>
```

All `/api/v1/admin/*` routes need `ADMIN` plus MFA. Sub-roles: order admin writes need OPS, SUPPORT or
FINANCE; finance (refunds, payouts) needs FINANCE or SUPER_ADMIN; delivery mutations need OPS; SUPER_ADMIN
passes every check. Every privileged action is audited (`GET /api/v1/admin/audit-logs`).

### 0.2 Look at system health first

```bash
curl -sS $API/api/v1/admin/health -H "authorization: Bearer $ADMIN_TOKEN"
```

Returns `overall` and, per service, `status` (`up`/`degraded`/`down`), `latencyMs` and `details`:
`mongo`, `redis`, `outboxPending`, `outboxOldestAgeSec`, `consumerLag{stream}`, `deadLetters`,
`providerErrorsLastHour`, `providerErrorsByProvider`. Read it like this:

| Signal | Meaning | Go to |
|---|---|---|
| `down` / `degraded` service | process or dependency problem | logs, section 9 or 8 |
| `outboxPending` > 0 and `outboxOldestAgeSec` growing | relay cannot publish (Redis down, relay not leader) | section 8 |
| `consumerLag` growing | consumer stuck or slow | logs; section 6 |
| `deadLetters` > 0 | events a consumer gave up on | section 6 |
| `providerErrorsByProvider` non-empty | upstream provider failing | section 11 |
| `degradedReasons` / `summary` / `providers` (2026-10-11 redesign) | the health page says in words why a service is degraded | section 14.6 |

The same details are available per service from inside the network (this snippet is verified):

```bash
docker compose exec -T payments node --input-type=module -e "
import { signServiceToken } from '@thali/service-kit';
const t = await signServiceToken('gateway','payments',process.env.INTERNAL_SERVICE_SECRET);
const r = await fetch('http://localhost:4004/internal/health/details',{headers:{authorization:'Bearer '+t}});
console.log(r.status, await r.text());"
```

### 0.3 Call an internal endpoint (service token)

Internal routes (`/internal/*`) are never exposed at the gateway. Mint a 60 s token with the target's secret
inside any backend container; `from` must be a service the route allows. The ops routes (`/internal/health/details`, `/internal/dead-letters*`) accept only `gateway` and
`notifications` as `from` (ADR-031).

```bash
internal() {  # usage: internal <svc-container> <port> <from> <METHOD> <path>
  docker compose exec -T "$1" node --input-type=module -e "
  import { signServiceToken } from '@thali/service-kit';
  const [svc, port, from, method, path] = process.argv.slice(1);
  const t = await signServiceToken(from, svc, process.env.INTERNAL_SERVICE_SECRET);
  const r = await fetch('http://localhost:'+port+path, { method, headers: { authorization: 'Bearer '+t } });
  console.log(r.status, await r.text());" "$1" "$2" "$3" "$4" "$5"
}
internal payments 4004 orders POST /internal/payment-intents/<intentId>/reconcile
```

### 0.4 Database shell

```bash
# local compose (root user inside the mongo container)
docker compose exec mongo bash -c 'mongosh -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin'
# production: mongosh "mongodb+srv://<ops-user>@<cluster>/" (Atlas), read-only user by default
```

Databases are `thali_identity`, `thali_marketplace`, `thali_orders`, `thali_payments`, `thali_delivery`,
`thali_notifications`. Each has the standard collections `outbox`, `inbox`, `dead_letters`, `idempotency_keys`.

---

## 1. Stuck payment (customer paid, order not placed)

Symptoms: checkout `AWAITING_PAYMENT` after the customer says they paid; payment intent `CREATED` or
`AUTHORIZED` although money was taken; support ticket "paid but no order".

Why it self-heals: the payments reconcile job (every `RECONCILE_INTERVAL_MS`, 60 s) fetches the provider state
for `CREATED` intents older than 2 minutes (re-checked every 5 minutes, for 24 h) and captures `AUTHORIZED`
ones older than `AUTHORIZED_CAPTURE_AFTER_SEC` (300 s); at checkout expiry the orders sweeper reconciles before
releasing anything. Most cases resolve within a few minutes without action.

1. Find the intent (by checkout id, provider order/payment id, intent id or user id):

```bash
curl -sS "$API/api/v1/admin/finance/payments?q=<checkoutId|providerPaymentId>" -H "authorization: Bearer $ADMIN_TOKEN"
```

   Note `status`, `capturedPaise`, `lastReconciledAt`, `providerOrderId`.
2. Look at the checkout timeline: `GET $API/api/v1/admin/orders/<checkoutId>` (status, `paymentStatus`,
   events).
3. If the intent is not `CAPTURED` but the provider shows the payment captured, force a reconcile (idempotent;
   same code path as the webhook, so amount/currency/receipt are validated):

```bash
internal payments 4004 orders POST /internal/payment-intents/<intentId>/reconcile
# -> 200 {"paymentIntentId":"...","status":"CAPTURED","capturedPaise":123400}
```

   A customer session can also trigger it: `POST $API/api/v1/payments/<intentId>/verify` with the Razorpay
   `razorpay_payment_id`, `razorpay_order_id`, `razorpay_signature` (it only reconciles; it never marks paid).
4. Once the intent is `CAPTURED`, `payment.captured` reaches orders through the stream and the children become
   `PLACED`. If it does not within a minute: `consumerLag` and `deadLetters` for orders (sections 6 and 8).
5. If the checkout already expired (`EXPIRED`) and the payment is `CAPTURED`: orders emitted
   `checkout.late_payment` and payments issues a full `LATE_PAYMENT` refund. Confirm in
   `GET $API/api/v1/admin/finance/refunds?status=...`; tell the customer a refund is on its way (no re-place).
6. Webhook never arrived at all: check the provider dashboard's webhook log for non-200 responses, confirm
   `RAZORPAY_WEBHOOK_SECRET` matches, then use step 3. A `WEBHOOK_SIGNATURE_INVALID` (400) spike after a secret
   change means the dashboard secret and the environment differ (section 12).
7. Amount mismatch: logs show `alert: PAYMENT_MISMATCH` and the event is `REJECTED_MISMATCH` (no order is
   placed). Treat as a security/finance incident: compare the provider payment with the intent, refund manually
   if money was taken for the wrong amount (section 5).

## 2. Stuck checkout (AWAITING_PAYMENT past expiry, stock still held)

Normal behaviour: a checkout lives `CHECKOUT_TTL_SEC` (900 s). The orders sweeper runs every
`CHECKOUT_EXPIRY_INTERVAL_MS` (30 s), always reconciles with payments first, then places, waits (AUTHORIZED
within `AUTHORIZED_GRACE_SEC` = 600 s after expiry) or expires and emits `checkout.released`; marketplace then
releases stock, coupon and membership holds. A `payment.failed` alone does not release (ADR-014).

1. Confirm: `GET $API/api/v1/admin/orders/<checkoutId>`; `expiresAt` is in the past and status still
   `AWAITING_PAYMENT`.
2. Check the sweeper's reason. In the orders logs look for `reconcile failed; checkout left AWAITING_PAYMENT
   for the next sweep` (payments unreachable: fix payments, it retries every 30 s) or no sweeper activity at
   all (Redis down or no leader: section 8).
3. Check the payment (section 1 step 1). `AUTHORIZED` is deliberately left alone for 10 minutes while payments
   captures it.
4. After the checkout is `EXPIRED`/`PLACED`, stock holds are released/committed by marketplace on
   `checkout.released`/`checkout.confirmed`. A hold that outlives its checkout is also swept by marketplace's
   reservation job, which asks orders `GET /internal/checkouts/:id/status` (grace `RESERVATION_GRACE_SEC`
   300 s). If stock stays reserved, check marketplace dead letters (section 6) and its logs.
5. Do not edit checkout documents by hand. If a checkout is truly wedged and the payment is not captured,
   restarting orders gives the sweeper a fresh leader election; if it is captured, reconcile (section 1).

## 3. Stuck order (child order not progressing)

First decide who owns the next step: restaurant (PLACED, ACCEPTED, PREPARING), delivery (READY_FOR_PICKUP to
DELIVERED) or system (events).

| Child status | Expected exit | If stuck |
|---|---|---|
| `PLACED` | restaurant accepts/rejects within `acceptBy` (300 s); otherwise orders auto-rejects (`RESTAURANT_TIMEOUT`, sweeper every 15 s) with a refund | sweeper not running (Redis/leader), or restaurant is online but the order is not visible to them: check `owner` isolation by ownerId |
| `ACCEPTED` / `PREPARING` / `READY_FOR_PICKUP` | delivery job assigned and picked up | job missing (the `order.accepted` event dead-lettered: section 6) or unassigned (section 10) |
| `PICKED_UP` / `OUT_FOR_DELIVERY` | partner delivers or fails | partner unreachable: section 10 |
| `DELIVERY_FAILED` | an admin decides | cancel with refund (below) |

Admin actions (audited; OPS, SUPPORT or FINANCE sub-role):

```bash
# See the whole timeline
curl -sS $API/api/v1/admin/orders/<checkoutId> -H "authorization: Bearer $ADMIN_TOKEN"

# Cancel a child and refund up to what is left (any of ACCEPTED, PREPARING, READY_FOR_PICKUP, DELIVERY_FAILED, PLACED)
curl -sS -X POST $API/api/v1/admin/orders/child/<childId>/cancel -H "authorization: Bearer $ADMIN_TOKEN" \
  -H 'content-type: application/json' -d '{"reason":"restaurant closed","refundPaise":45900}'

# Move to another state the table allows for ADMIN (for example PLACED -> ACCEPTED or REJECTED)
curl -sS -X POST $API/api/v1/admin/orders/child/<childId>/transition -H "authorization: Bearer $ADMIN_TOKEN" \
  -H 'content-type: application/json' -d '{"to":"REJECTED","reason":"restaurant unreachable"}'
```

- `transition` only performs transitions whose allowed actors include ADMIN (see
  [state-machines](diagrams/state-machines.md)); everything SYSTEM-only (PICKED_UP, OUT_FOR_DELIVERY,
  DELIVERED) must be driven by the delivery side. An illegal move returns 409 `ORDER_INVALID_TRANSITION`.
- `to=CANCELLED` requires `refundPaise` (0 is allowed; it must not exceed what is left of the child total).
- A cancel or reject emits `order.cancelled`/`order.rejected`, which makes payments create the refund and
  delivery cancel the job. Check the refund afterwards (section 5).
- A child that shows `PICKED_UP` while the delivery job is `DELIVERED` means an event is stuck: replay it
  (section 6).

## 4. Order cancelled by the customer or restaurant, refund not visible

`GET $API/api/v1/admin/orders/<checkoutId>` shows the child `refundStatus` (`REQUESTED`, `PROCESSING`,
`SUCCEEDED`, `FAILED`). `REQUESTED` for more than a minute means payments has not consumed `order.rejected` /
`order.cancelled` (consumer lag or dead letter: sections 6 and 8). Then check
`GET $API/api/v1/admin/finance/refunds?status=REQUESTED`.

## 5. Refund FAILED (admin retry)

A refund is `FAILED` after 5 automatic attempts (backoff 1, 2, 4, 8 minutes, same provider idempotency key
each time) or after a definitive provider rejection. The admin finance list shows `lastError`.

```bash
curl -sS "$API/api/v1/admin/finance/refunds?status=FAILED" -H "authorization: Bearer $ADMIN_TOKEN"
curl -sS -X POST $API/api/v1/admin/finance/refunds/<refundId>/retry -H "authorization: Bearer $ADMIN_TOKEN"
```

(FINANCE or SUPER_ADMIN.) Retry re-reserves the amount atomically and uses a fresh provider key; 422
`REFUND_EXCEEDS_CAPTURED` means the payment no longer has that much unreserved; 409 `REFUND_INVALID_TRANSITION`
means it is not in a retryable state.

If retry keeps failing: read `lastError` and the provider dashboard (typical causes: payment older than the
provider's refund window, insufficient settlement balance, payment not captured). If the provider cannot
refund, settle the customer outside the system (bank/UPI) and record it:

```bash
curl -sS -X POST $API/api/v1/admin/finance/refunds -H "authorization: Bearer $ADMIN_TOKEN" \
  -H 'content-type: application/json' -H "Idempotency-Key: refund-$(uuidgen)" \
  -d '{"paymentIntentId":"<id>","childOrderId":"<id>","amountPaise":45900,"reason":"ADMIN","note":"paid out manually, UTR ...","chargeRestaurantPaise":0}'
```

(Manual refund is capped by what is captured and not yet reserved; it is audited.) Never retry in a loop from a
script: the idempotency key and reservation protect the money, but each attempt is an audit entry.

## 6. Dead letters (list and replay)

A consumer dead-letters an event after 5 failed handler attempts (backoff 1 s, 2 s, 4 s ...) or when an entry
is malformed. Infrastructure outages do not count as attempts. The record lives in the owning service's
`dead_letters` collection and in the `dlq.<service>` stream.

```bash
# list across all services (identity, marketplace, orders, payments, delivery, notifications)
curl -sS "$API/api/v1/admin/notifications/dead-letters?limit=50" -H "authorization: Bearer $ADMIN_TOKEN"
# -> {"items":[{"service":"orders","id":"<eventId>","error":"...","envelope":{...}}], "errors":[], "sources":[...]}

# replay one (re-publishes the envelope to its original stream)
curl -sS -X POST $API/api/v1/admin/notifications/dead-letters/<service>/<id>/replay -H "authorization: Bearer $ADMIN_TOKEN"
```

Procedure:

1. Read `error` and the envelope. If the cause is a bug or missing data, fix that first: a replay of an event
   that fails deterministically will dead-letter again (it resets `replayedAt` and bumps `attempts`).
2. Replay is safe to repeat: handlers are idempotent through the inbox (30 day retention).
3. Replay the oldest first for the same aggregate (for example `order.accepted` before `order.rejected`).
4. Confirm `deadLetters` returns to 0 on the health page and the downstream state is right (order status,
   refund, job).
5. Per-service direct access (inside the network): `internal <svc> <port> notifications GET
   "/internal/dead-letters?limit=50&includeReplayed=false"` and `POST /internal/dead-letters/<id>/replay`.

Entries trimmed from the stream before processing appear with `envelope: null`; they cannot be replayed:
reconstruct the missing effect from the aggregate's own state or re-publish from the outbox (section 8).

## 7. Notification DEAD (retry)

`DEAD` means 6 delivery attempts failed (backoff 30, 60, 120, 240, 480 s), a permanent provider error
(4xx other than 408/425/429), or a bounce/undelivered receipt. `SKIPPED` is not an error (opted out, blocked,
no phone/email).

```bash
curl -sS "$API/api/v1/admin/notifications?status=DEAD&channel=SMS" -H "authorization: Bearer $ADMIN_TOKEN"
curl -sS -X POST $API/api/v1/admin/notifications/<id>/retry -H "authorization: Bearer $ADMIN_TOKEN"
```

- Retry resets attempts to 0 and re-queues; it is audited. Fix the cause first (credentials, DLT template,
  sender, invalid address), otherwise it just dies again.
- OTP records cannot be retried (409): the code is not stored; the user requests a new OTP.
- Resend retries reuse the `Idempotency-Key`; SMS has no provider idempotency, so a crash around a send can
  deliver twice (accepted trade-off, ADR-025).
- Rows stuck in `SENDING` longer than `NOTIF_SENDING_TIMEOUT_SEC` (120 s) are recovered automatically.

## 8. Redis loss (outbox re-publish)

Effects of losing Redis (restart without persistence, failover with data loss): every service's `/health/ready`
fails while Redis is down (so the load balancer drains them: the API is unavailable until Redis returns; this is
deliberate because rate limiting, revocation and the event bus depend on it); streams, DLQ streams, rate-limit
counters, leader locks, realtime tickets and `revoked:sid:*` keys are gone.

No business data is lost: the outbox rows are in Mongo. Recovery:

1. Restore Redis service (new instance, same `REDIS_URL`). Services reconnect; consumers recreate their groups
   from stream id 0 (`MKSTREAM`) and keep running.
2. Decide the loss window: from the time Redis last had good data (snapshot/AOF time, or the incident start
   minus a safety margin) until now.
3. For **each** service database, mark outbox rows in the window as unpublished. The relay then re-publishes
   them in `createdAt` order; consumers dedupe by event id, so replaying events that were already processed
   has no effect. Published outbox rows are kept for 7 days, so the window cannot be older than that.

```javascript
// mongosh, per database: thali_identity, thali_marketplace, thali_orders, thali_payments, thali_delivery, thali_notifications
const since = ISODate("2026-10-10T08:00:00Z");   // start of the loss window, UTC
["thali_identity","thali_marketplace","thali_orders","thali_payments","thali_delivery","thali_notifications"].forEach(name => {
  const r = db.getSiblingDB(name).outbox.updateMany({ createdAt: { $gte: since }, publishedAt: { $ne: null } }, { $set: { publishedAt: null } });
  print(name, r.modifiedCount);
});
```

4. Watch the health page: `outboxPending` rises then drains to 0, `consumerLag` returns to 0, no growth in
   `deadLetters`. Order of effects is preserved per stream by `createdAt`.
5. Dead letters survive (stored in Mongo): replay still works (section 6) even though `dlq.*` streams are gone.
6. Side effects to accept or mitigate: rate-limit counters reset; a session revoked in the last 15 minutes can
   work until its access token expires (at most 15 minutes), so for a security incident also run `logout-all`
   or block the user (`POST /api/v1/admin/users/:id/block`); SSE clients reconnect (tickets are re-issued);
   sweepers resume on the next tick; payments reconcile covers any provider event whose webhook failed
   while the API was unavailable (the provider also retries webhooks).
7. If Mongo and Redis were both lost, restore Mongo first ([backup-restore.md](backup-restore.md)), then do
   steps 2 to 4 for the window since the restored point.

Related: **outbox stuck without Redis loss** (`outboxPending` grows, Redis healthy): the relay is not leading
or XADD fails. Check the service log `outbox publish failed; will retry` (the row keeps `attempts`/`lastError`),
confirm one instance holds the relay lock, restart the service. Rows are never dropped.

## 9. Mongo failover and restore

**Failover (Atlas election, planned maintenance):** expect 5 to 30 s of errors. Mongoose reconnects; Mongo
transactions retry on `TransientTransactionError`; consumers treat connectivity errors as infrastructure
(they pause and resume, no handler attempts burned); the payment webhook route returns 500 on purpose so the
provider retries; checkout requests during the window fail with 5xx and are safe to retry with the same
`Idempotency-Key`.

Verify afterwards: health page all `up`, `outboxPending` draining, no new `deadLetters`, `consumerLag` 0.
Check for stuck work: checkouts `AWAITING_PAYMENT` older than 20 minutes (section 2), refunds `PROCESSING`
older than 10 minutes (the worker polls the provider and settles them).

**Restore (data corruption, bad deploy, region loss):** follow [backup-restore.md](backup-restore.md). In
short: restore all six databases to the same point in time (Atlas PITR is cluster-wide), restart services, then
reconcile what happened after that point:

1. Provider truth wins for money: for the lost window compare Razorpay payments and refunds with
   `payment_intents` and `refunds`; run section 1 step 3 for any intent that is not `CAPTURED` there.
2. Outbox rows written after the restore point no longer exist, so there is nothing to re-publish for that
   window. Let the reconcile job and sweepers run, replay dead letters (section 6), and if Redis was restored
   from older data than Mongo, do the outbox re-publish in section 8 from the restore time.
3. Tell affected customers/restaurants; support tickets in the window may be lost.

## 10. Partner location stale

How "stale" is defined: the customer sees "last updated Xs ago" and a stale marker after
`LOCATION_STALE_SEC` (60 s); the dispatcher ignores partners whose last ping is older than
`DISPATCH_LOCATION_MAX_AGE_SEC` (120 s). Pings are at most one per 3 s and are ephemeral (stored in
`location_pings` for 7 days, the latest point on the partner and the active job).

1. Look at the job: `GET $API/api/v1/admin/delivery/jobs?status=ASSIGNED` (or `PICKED_UP`,
   `OUT_FOR_DELIVERY`; add `exception=true` for jobs nobody took) and the partner list
   `GET .../admin/delivery/partners?status=APPROVED` (online flag, last location time).
2. Usual causes: app in background (browsers throttle geolocation), permission denied, no network, phone
   battery. Ask the partner (phone number is on the partner record) to reopen the app and keep it in the
   foreground.
3. Before pickup (`ASSIGNED`/`AT_PICKUP`) and the partner is unreachable: unassign, the job goes back to
   `PENDING_ASSIGNMENT` and re-dispatches:

```bash
curl -sS -X POST $API/api/v1/admin/delivery/jobs/<jobId>/unassign -H "authorization: Bearer $ADMIN_TOKEN" \
  -H 'content-type: application/json' -d '{"reason":"partner offline"}'
# or assign someone directly (APPROVED, online, with capacity)
curl -sS -X POST $API/api/v1/admin/delivery/jobs/<jobId>/assign -H "authorization: Bearer $ADMIN_TOKEN" \
  -H 'content-type: application/json' -d '{"partnerId":"<partnerId>"}'
```

4. After pickup (`PICKED_UP`/`OUT_FOR_DELIVERY`) and the partner cannot be reached: mark the job failed, then
   cancel the child with the right refund (section 3):

```bash
curl -sS -X POST $API/api/v1/admin/delivery/jobs/<jobId>/fail -H "authorization: Bearer $ADMIN_TOKEN" \
  -H 'content-type: application/json' -d '{"reason":"partner unreachable"}'
```

5. A job that nobody accepts after 5 dispatch rounds is flagged `exception=true` and a `delivery.exception`
   notification goes to admins; auto-dispatch stops, so assign manually (step 3).
6. A locked job (5 wrong handover codes, HTTP 423) only clears through admin fail or reassign.
7. Demo only: `POST /api/v1/admin/delivery/demo/simulate/<jobId>` emits 10 `simulated:true` pings (UI shows a
   simulated label); it never changes job state.
8. Partner suspended while online: forced offline, live offers cancelled, not-yet-picked-up jobs return to
   dispatch automatically; picked-up jobs stay with the partner.

## 11. Provider outage

Detect: admin health `providerErrorsByProvider`, provider status pages, spikes of `PAYMENT_PROVIDER_UNAVAILABLE`
or `OTP_DELIVERY_FAILED`.

| Provider | What happens | What to do |
|---|---|---|
| **Razorpay API down** | `POST /checkouts` returns 502 `PAYMENT_PROVIDER_UNAVAILABLE`; the new checkout is released (stock and coupon freed). Webhooks for payments already made are delayed by the provider. Refund calls fail and retry with backoff | Show a banner; do nothing else. Afterwards: reconcile any intent still not `CAPTURED` (section 1), `GET .../refunds?status=FAILED` and retry (section 5) |
| **Razorpay webhooks failing** (our side: 4xx/5xx) | Intents stay `CREATED`/`AUTHORIZED`; reconcile job captures/sync every minute | Fix signature secret or URL (section 12); reconcile covers the gap; the provider retries deliveries |
| **Twilio down / DLT blocked** | OTP requests return 503 `OTP_DELIVERY_FAILED`: **phone sign-in is unavailable** (no alternative channel today). Order SMS retries 6 times then `DEAD`; in-app and email still go out | Switch to the Messaging Service/sender that works, fix DLT template mismatches (rejected messages show an error code), then retry DEAD rows (section 7) |
| **Resend down** | Email rows retry then `DEAD`; restaurant verification emails are the critical ones | Owners can use "resend verification"; retry DEAD rows afterwards |
| **Google Maps down / quota** | Adapter falls back to haversine, labelled `HAVERSINE_FALLBACK`; discovery and delivery keep working with estimates | Check quota/billing/key restriction; estimates may under-state distance and fees until it recovers |
| **S3 down** | Uploads fail (restaurant onboarding, menu images, partner KYC); public images may not load; checkout unaffected | Wait, or check CORS/credentials if only the browser fails |
| **MinIO (demo)** | Same as S3 | `docker compose restart minio` |

Drill (demo mode only): `POST $API/api/v1/admin/notifications/demo/fail-mode` with `{"sms":true,"email":true}`
makes the mock SMS/email providers fail so you can watch retries and DEAD handling (it auto-expires after 1 h).

## 12. Rotating secrets

General rule: change the value in the secrets store, then redeploy only the services that use it. Test in
staging first.

| Secret | Procedure | Impact |
|---|---|---|
| `INTERNAL_SERVICE_SECRET` | Generate 64 hex chars; update **all** backends and the gateway, then force a new deployment of every service in one window (there is no dual-secret mode) | Service-to-service calls fail between old and new tasks for the duration of the rollout (tokens live 60 s); events keep retrying; user traffic degrades briefly |
| `JWT_PRIVATE_KEY_PEM` (+`JWT_PUBLIC_KEY_PEM`, `JWT_KID`) | Generate a new Ed25519 PKCS#8 key, update identity, redeploy identity | Only one signing key is published, so every outstanding access token stops verifying; clients get 401 and transparently refresh with the refresh cookie (sessions are not lost). Do it off-peak |
| `OTP_PEPPER` | Update identity, redeploy | Only OTPs issued before the change (at most 5 minutes) stop working |
| `FIELD_ENCRYPTION_KEY` | **Do not rotate casually.** Identity (TOTP secrets), marketplace (bank details) and notifications (recipients) store ciphertext in the `v1:` format with no key id | A new key cannot read old rows; there is no re-encryption tool yet (limitation). Rotation needs a one-off script that decrypts with the old key and re-encrypts. Keep an offline copy of every key |
| `MONGO_*` passwords | In Atlas create the new password (or a second user), update the service's `MONGO_URI`, redeploy, delete the old credential | None if done as a rolling deploy |
| `REDIS_URL` password | Update the managed Redis AUTH, update all services, rolling redeploy | Brief reconnects |
| `RAZORPAY_KEY_ID/SECRET` | Generate new keys in the dashboard, update payments, redeploy, then revoke the old pair | Calls fail between regeneration and deployment: reconcile afterwards (section 1) |
| `RAZORPAY_WEBHOOK_SECRET` | Edit the webhook secret in the dashboard and update payments at the same time | Deliveries between the two moments fail with 400; the provider retries and reconcile covers the rest |
| `TWILIO_AUTH_TOKEN` | Use Twilio's secondary auth token: create it, deploy it, then promote and retire the old one | None if done in that order; the token is also the status-callback signature key |
| `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET` | Create the new key / rotate the signing secret in Resend, deploy notifications, revoke the old | Webhooks signed with the old secret fail with 401 until deployed |
| `GOOGLE_MAPS_API_KEY` | Create a new restricted key, deploy marketplace and delivery, delete the old | None (haversine fallback covers gaps) |
| `S3_ACCESS_KEY_ID/SECRET` | Prefer IAM roles. Otherwise create a new access key, deploy marketplace and delivery, deactivate the old key | None |
| Admin credentials | There is no password reset route. A SUPER_ADMIN can create another admin (`POST /api/v1/admin/admins`) and block the old user (`POST /api/v1/admin/users/:id/block`); `bootstrap-admin` creates the first one | Audited |
| A leaked user token or session | `POST /api/v1/auth/logout-all` (self), or block the user; refresh tokens rotate with reuse detection (reuse revokes the session family) | |

After any rotation confirm `GET /api/v1/admin/health` is all `up`, `/api/v1/meta` is unchanged, and run the
provider verification step from [05-provider-setup.md](05-provider-setup.md) for the provider you touched.

## 13. Alerts worth wiring

Log lines (JSON) with `alert` set: `PAYMENT_MISMATCH`, `DUPLICATE_CAPTURE`, `FAILED_AFTER_CAPTURE`,
`REFUND_FAILED_AFTER_SUCCESS`, `REFUND_OVER_RESERVED`, `WEBHOOK_MALFORMED`, `LEDGER_DISTANCE_MISSING`.
Metrics from the health page: `outboxOldestAgeSec` > 60, `consumerLag` > 100, `deadLetters` > 0,
`providerErrorsLastHour` > 0. Business signals: checkouts `AWAITING_PAYMENT` older than 20 minutes,
refunds `FAILED` or `PROCESSING` > 10 minutes, delivery jobs with `exception=true`, notifications `DEAD`.

## 14. Demo data, reseed and bulk operations (2026-10-11 redesign)

### 14.1 Reseed (demo only)

Seeds refuse to run unless `APP_MODE=demo` and must never run against staging or production (ADR-036).

```bash
# fresh volumes (cleanest: drops Mongo, Redis and MinIO data)
docker compose down -v && npm run stack:up
npm run seed:images        # optional first: mirror the photos into MinIO (14.2); `npm run seed` also runs it unless --no-images
npm run seed               # idempotent; order: identity, marketplace, delivery, payments, notifications, orders
```

- Re-running `npm run seed` on a seeded stack inserts nothing new (ids are deterministic; only timestamps follow
  the anchor passed to every service). `npm run seed -- identity marketplace` seeds only some services;
  `npm run seed -- --local` runs with tsx against the infra stack and the `.env` values (needs `SEED_DATA_DIR`
  if the repo layout differs).
- An existing volume does not need a reset: the seed-owned service area `blr-koramangala` is upgraded in place to
  a city-wide Bengaluru polygon, and the localities gazetteer is upserted.
- Direct Mongo writes bypass the discovery cache epoch: right after a reseed the first listings can be stale for
  up to `DISCOVERY_CACHE_TTL_SEC` (60 s). Wait a minute, or bump the epoch by editing any restaurant through the API.
- The seed-data directory (`scripts/seed-data`) must be reachable by the service that reads it. If a seed fails
  with a missing file, run `npm run seed -- --local`, or set `SEED_DATA_DIR`.
- TODO (controller, after Task 8 verification): record the seed duration, per-collection document counts on a
  fresh stack, the sample sign-in phones per role (consumers `+91910...`, owners `+91920...`, partners
  `+91930...`, all with OTP `123456` in demo) and the admin credentials printed by the identity seed.

### 14.2 Image mirror (`npm run seed:images`)

The photos come from `scripts/seed-data/images.json` (CC-licensed; credits in `scripts/seed-data/CREDITS.md`)
and `avatars.json` (randomuser.me).

```bash
npm run seed:images                      # download (cached in .cache/seed-images) + upload to the public MinIO bucket + write the manifest
npm run seed:images -- --no-upload       # only fill the download cache
npm run seed:images -- --offline         # no downloads: upload what is cached
npm run seed:images -- --concurrency 4   # be gentler with the hosts
```

- It needs MinIO up (`MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`, `MINIO_HOST_PORT`, `S3_PUBLIC_BUCKET` from `.env`;
  override the endpoint with `SEED_IMAGES_S3_ENDPOINT`). Uploads are HEAD-then-PUT, so re-runs upload nothing.
- Wikimedia throttles with 429 when many full-size thumbnails are requested at once: the script backs off and
  retries; a host that keeps failing leaves some images out of `.cache/seed-images/manifest.json`. That is not an
  error: the seed falls back to the absolute URL (host must be in `EXTERNAL_IMAGE_HOSTS`) for those.
- Symptom "images missing in the app": check the browser network tab. Mirrored keys resolve under
  `S3_PUBLIC_BASE_URL`; absolute URLs need their host in `EXTERNAL_IMAGE_HOSTS` on every service that serves
  the view, otherwise `imageUrl` is `null` and the SPA draws a placeholder.
- After the images are mirrored once, re-run `npm run seed` so the documents reference the mirrored keys.

### 14.3 Demo traffic (`npm run demo:traffic`)

Makes the boards look alive: places live orders through the public APIs as seeded demo consumers and walks
some of them through accept, ready, pickup and delivery with the demo owners and partners.

```bash
npm run demo:traffic
```

- Demo mode only. It signs in with the demo OTP, so it is subject to the per-phone OTP limits (5 per hour,
  30 s cooldown): do not run it in a tight loop.
- Run it instead of, not together with, `npm run smoke` or `npm run e2e`: they share the demo partners and the
  owner boards.
- TODO (controller, after Task 8 verification): document the options (order count, pacing) and the expected
  end state once the script is final.

### 14.4 Order contact backfill and delivery code backfill (force run)

Two leader-locked scheduler jobs fill fields that older rows lack. Both run at boot and then every 5 minutes as
cheap, indexed no-ops once nothing is left.

| Job | Service | Fills | Marker |
|---|---|---|---|
| `orders:contact-backfill` | orders | `child_orders.customerContact.phoneLast4`, `checkout_groups.customerContact`, `restaurantSetKey:'*'` on settled legacy groups (AWAITING_PAYMENT groups are skipped) | document `_id: 'orders:contact-backfill:v1'` in `thali_orders.migrations`, written once a clean run finds nothing left |
| `delivery:order-code-backfill` | delivery | `delivery_jobs.childOrderCode` and `checkoutCode` from orders `GET /internal/orders/child/:id` | per row `codesCheckedAt` (an order that answers 404 is not asked again) |

When to force the orders backfill: after a rolling deploy that took longer than one 5-minute tick, old instances
can write checkouts without `restaurantSetKey` or `customerContact`, and the completion marker may already be
set. Remove the marker (database shell, section 0.4); the next tick (within 5 minutes, on the leader) does a
real pass and writes the marker again when nothing is left:

```js
// mongosh, database thali_orders
use thali_orders
db.migrations.deleteOne({ _id: 'orders:contact-backfill:v1' })
// afterwards: rows still missing the field (expect 0 once the pass has run)
db.child_orders.countDocuments({ 'customerContact.phoneLast4': { $exists: false } })
db.checkout_groups.countDocuments({ restaurantSetKey: { $exists: false }, status: { $ne: 'AWAITING_PAYMENT' } })
```

The code-level equivalent is `runContactBackfill(ctx, {force:true})` in `services/orders/src/jobs/contact-backfill.ts`
(used by tests). It only updates rows where the field is still missing and writes with `timestamps:false`, so
it is safe to repeat. Legacy `AWAITING_PAYMENT` groups keep no `restaurantSetKey` until they settle or expire;
that is expected and read as `'*'`.

- If the delivery backfill logs an orders error and stops, it resumes on the next tick; rows whose order is
  unknown (404) are marked and skipped, other 4xx errors skip that row only.
- Searching orders by phone (admin) depends on `phoneLast4`: rows not yet backfilled are not found by phone.

### 14.5 Bulk notification retry and dead-letter replay

Admin overview ("N failed notifications / Retry", "N dead letters / Replay") and the health page call these;
both are audited and bounded. Roles: retry needs OPS or SUPPORT, replay needs OPS.

```bash
# how many are failing (all-time byStatus; failedLast24h counts SMS/EMAIL only)
curl -sS $API/api/v1/admin/notifications/summary -H "authorization: Bearer $ADMIN_TOKEN"

# retry FAILED, then DEAD (oldest first, up to `limit` <= 500 per call; optional channel and before filters)
curl -sS -X POST $API/api/v1/admin/notifications/retry -H "authorization: Bearer $ADMIN_TOKEN" \
  -H 'content-type: application/json' -d '{"status":"FAILED","channel":"EMAIL","limit":500}'
# -> {"queued":N}

# replay dead letters across services (oldest first, `limit` <= 100 in total)
curl -sS -X POST $API/api/v1/admin/notifications/dead-letters/replay -H "authorization: Bearer $ADMIN_TOKEN" \
  -H 'content-type: application/json' -d '{"service":"orders","limit":100}'
# -> {"replayed":N,"failed":[{"service":"...","id":"...","error":"..."}]}
```

- Fix the cause first (provider credentials, template, sender, a bug behind a dead letter); a bulk retry of rows
  that fail deterministically just dies again. OTP rows and rows with no resolvable recipient are never retried
  (they are skipped, so `queued` can be lower than the number of failing rows). The first 25 re-queued rows are kicked immediately; the
  retry worker takes the rest.
- A replay entry in `failed` with `id: "*"` means that service's dead letters could not be listed (service down
  or ops route refused); the other services were still replayed. Repeat after the service is healthy.
- Replay is idempotent through the inbox (30 day retention). Replay order within one aggregate matters; the bulk
  call goes oldest first, so run it once and check the downstream state rather than looping.
- Every call writes one audit entry (`notification.bulk_retry`, `dead_letter.bulk_replay`).

### 14.6 Reading "degraded" on the health page

`GET /api/v1/admin/health` (and the admin Health and Overview pages) now explain each service in words
(ADR-040). `down` means the service did not answer. A service that answers is `degraded` when one of these holds:

| Reason shown | Rule | What to do |
|---|---|---|
| Mongo or Redis down | the service's own dependency check failed | section 8 or 9 |
| "Email provider failing: ..." / SMS / payment / maps | category has >= 5 errors in the last hour, or >= 2 errors in the last hour with the latest within 10 minutes; the reason carries the last scrubbed provider message | section 11; the service itself is fine and still serving |
| provider errors >= 5 per hour | total across providers | section 11 |
| consumer lag > 100 | a stream consumer is behind | logs; section 6 |
| oldest outbox event > 60 s | relay cannot publish | section 8 |
| dead letters > 0 | events a consumer gave up on | section 6 / 14.5 |

- One provider error is not "failing": a single blip leaves the category `up`. The 10-minute rule is an
  approximation from hourly counts plus the latest error time.
- `summary` is "All checks passing", "Unreachable: <error>", or up to three reasons plus "+N more".
- A provider chip in the admin console reads "failing", never "down"; the platform is still serving requests.
- Messages are scrubbed (emails, long digit runs, bearer/key/token values) and kept 1 hour per provider.
