# Deployment guide (staging and production)

This describes how to run Thali outside a laptop. The reference target is **AWS ECS Fargate + MongoDB Atlas +
managed Redis + S3**, but nothing in the code is AWS-specific: Fly.io, Render, Kubernetes or plain VMs work the
same way because every service is a stateless container configured only through environment variables.

Nothing here has been executed against a real cloud account yet. Treat it as a reviewed design plus the exact
configuration surface the code exposes; the staging rollout is the first real test (see
[08-launch-checklist.md](08-launch-checklist.md)).

## 1. Environments

| | Local demo | Staging | Production |
|---|---|---|---|
| `APP_MODE` | `demo` | `sandbox` | `production` |
| Payments | mock (signed mock webhooks) | Razorpay **test** keys | Razorpay **live** keys |
| SMS | mock | Twilio (trial or test, registered numbers) | Twilio with DLT-registered sender and templates |
| Email | Mailpit | Resend (verified staging domain) | Resend (verified production domain) |
| Maps | haversine estimator | Google key (restricted) | Google key (restricted) |
| Storage | MinIO | S3 (separate buckets) | S3 (separate buckets) |
| Demo OTP, seeds, demo-pay, simulator | on | **off** | refused at startup |
| Swagger (`DOCS_ENABLED`) | on | on, network-restricted | off (or restricted) |
| Data | seeded | synthetic | real |

Keep staging and production in separate AWS accounts (or at least separate VPCs, Atlas projects, Redis
instances, buckets and secrets). Staging must never share a database, a Razorpay account mode or a webhook
secret with production.

## 2. Images

Each of the seven backend images is built from the repository root with its own Dockerfile
(`services/<name>/Dockerfile`, context `.`); the web image is `apps/web/Dockerfile`.

```bash
docker build -f services/identity/Dockerfile -t <registry>/thali/identity:<git-sha> .
# repeat for marketplace orders payments delivery notifications gateway, and:
docker build -f apps/web/Dockerfile -t <registry>/thali/web:<git-sha> .
```

- Base `node:22.20.0-alpine3.22`, multi-stage, production dependencies only, `USER node`, `HEALTHCHECK` on
  `/health/live`. The install and shared-package stages are byte-identical across services, so BuildKit caches
  them once.
- Tag with the git SHA (not `latest`); promote the same digest from staging to production.
- The web image is nginx serving the built SPA and proxying `/api` to `gateway:8080`
  (`infra/nginx/web.conf`; SSE location unbuffered). You can instead host the static build on S3 + CloudFront
  and route `/api/*` to the gateway at the load balancer (section 4).

## 3. Topology on ECS Fargate

| Component | Runtime | Count (start) | Port | Health check |
|---|---|---|---|---|
| gateway | ECS service behind the ALB | 2 | 8080 | `GET /health/ready` |
| identity, marketplace, orders, payments, delivery, notifications | ECS services, internal only (Cloud Map / ECS Service Connect DNS names such as `identity.thali.internal`) | 2 each | 4001 to 4006 | `GET /health/ready` (Mongo + Redis ping) |
| web | ECS service or S3 + CloudFront | 2 | 80 | `GET /` |
| MongoDB | Atlas dedicated replica set | M10+ (3 nodes) | 27017 | n/a |
| Redis | managed Redis (see section 6) | primary + replica | 6379 | n/a |

- Start each task at 0.5 vCPU / 1 GB and tune from metrics. Fargate tasks need outbound internet through NAT
  for Razorpay, Twilio, Resend, Google and S3 (or VPC endpoints for S3).
- Use the container health check on `/health/live` for restarts and the ALB/target group on `/health/ready`
  for routing. Allow a 40 s start period (matches compose).
- Set the stop timeout to at least 30 s: services drain on SIGTERM (`gracefulShutdown`, SSE streams are
  closed first).
- Security groups: only the ALB reaches the gateway (and web); only the gateway (and peers) reach services on
  4001 to 4006; services reach Mongo, Redis and the internet; nothing else is open.
- Peer URLs are plain environment variables: `IDENTITY_URL`, `MARKETPLACE_URL`, `ORDERS_URL`, `PAYMENTS_URL`,
  `DELIVERY_URL`, `NOTIFICATIONS_URL` and `JWKS_URL` (`http://identity.thali.internal:4001/.well-known/jwks.json`).
  Internal traffic is signed with `INTERNAL_SERVICE_SECRET` but not encrypted; keep it inside the VPC.
- The `/internal/*` routes are never routed by the gateway. Do not add an ALB rule that exposes them.

## 4. Edge: TLS, routing, same origin

Use one public hostname, for example `https://app.example.com`.

| ALB listener rule (HTTPS 443, ACM certificate) | Target |
|---|---|
| `/api/*` and `/.well-known/*` (priority 1) | gateway target group |
| default | web target group |

Why one origin: the refresh cookie `thali_rt` is `httpOnly`, `SameSite=Strict`, path `/api/v1/auth`, and the
refresh/logout endpoints require `X-Requested-With: thali-web` plus an allowed `Origin`. Serving the SPA and the
API from the same site keeps this working without third-party-cookie issues.

Settings that must agree with the hostname:

```
PUBLIC_WEB_URL=https://app.example.com
PUBLIC_API_URL=https://app.example.com
CORS_ORIGINS=https://app.example.com
CSRF_ALLOWED_ORIGINS=https://app.example.com
COOKIE_SECURE=            # empty = Secure cookies (true everywhere except APP_MODE=demo)
```

- Redirect HTTP 80 to HTTPS 443; add HSTS at the ALB/CloudFront. Terminate TLS 1.2+ only.
- ALB idle timeout: at least 120 s for SSE (`/api/v1/realtime/stream`); the server sends a `: ping` every 20 s
  and closes a stream after `SSE_MAX_AGE_SEC` (1 h), the client reconnects with a new ticket.
- Do not enable response compression or buffering for `/api/v1/realtime/*` on a CDN.
- Webhook paths must reach the gateway unmodified (no body rewriting WAF rule): `/api/v1/webhooks/razorpay`,
  `/api/v1/webhooks/twilio/status`, `/api/v1/webhooks/resend`.
- `TRUST_PROXY`: the gateway must see the real client IP for rate limits. Behind exactly one proxy hop (ALB
  to gateway) set `TRUST_PROXY=1` on the gateway and on every service (the gateway sets `X-Forwarded-For` for
  upstreams). With CloudFront in front of the ALB it is 2 for the gateway. Never use `true` on an
  internet-facing gateway and never expose the gateway port other than through the ALB, otherwise clients can
  spoof `X-Forwarded-For` and dodge the per-IP limits.
- Swagger: set `DOCS_ENABLED=false` in production (the gateway then answers 404 for `/api/docs`), or keep it
  on but restrict `/api/docs*` at the ALB/WAF to an office IP range or SSO. The OpenAPI specs describe every
  public route; they are not a secret but are an attack-surface map.
- Add a WAF with rate-based rules in front of the ALB as a second layer; the app has its own limits (global
  300/min per IP, discovery 60/min, OTP 10/min, plus per-phone, per-user and per-admin limits).
- The SPA currently ships no Content-Security-Policy. If you add one, allow `https://checkout.razorpay.com`
  (script) and `https://api.razorpay.com` (frames), the S3/CDN origin for images, and the OSM tile host.

## 5. MongoDB Atlas

- Cluster: dedicated replica set (M10 or larger), Mongo 8.0 or the closest supported, region near the services.
  **Continuous cloud backups / point-in-time recovery on.** Multi-document transactions are used everywhere
  (outbox, inbox, reservations), so a replica set is mandatory.
- Network: private connectivity (VPC peering or PrivateLink); the IP access list otherwise limited to NAT egress
  addresses.
- **One database user per service, `readWrite` on that service's database only** (ADR-002). The compose stack
  already does this (`infra/mongo/init-replica.js`); replicate it in Atlas:

| User | Role |
|---|---|
| `thali_identity` | `readWrite` on `thali_identity` |
| `thali_marketplace` | `readWrite` on `thali_marketplace` |
| `thali_orders` | `readWrite` on `thali_orders` |
| `thali_payments` | `readWrite` on `thali_payments` |
| `thali_delivery` | `readWrite` on `thali_delivery` |
| `thali_notifications` | `readWrite` on `thali_notifications` |
| `thali_backup` (ops only) | `backup` + `read` on all, or Atlas snapshots only |

- Connection string per service (no database in the path; the service selects its own `thali_<service>`):
  `mongodb+srv://thali_orders:<password>@<cluster>.mongodb.net/?retryWrites=true&w=majority`
  Marketplace also reads `MONGO_DB_NAME` (default `thali_marketplace`); identity reads `IDENTITY_DB_NAME` for the
  admin CLI. Use URL-safe passwords (hex) or URL-encode them.
- Services create their collections and indexes at startup (`createIndexes`/`syncIndexes`, within the
  `readWrite` privileges); there is no separate migration step today. See Known limitations in the launch
  checklist (no migration framework).
- TTL indexes: outbox published rows 7 days, inbox 30 days, OTP challenges, sessions, location pings 7 days,
  provider callbacks 30 days. Do not disable the TTL monitor.

## 6. Redis

Redis holds: Streams (`events.*`, `dlq.*`), leader locks (relays and sweepers), rate-limit counters, session
revocation keys, realtime tickets, pub/sub for SSE, and the demo fail-mode flag. The **outbox in Mongo is the
source of truth**, so Redis can be rebuilt (runbook: "Redis loss"), but you still want it durable and highly
available.

Requirements for the managed instance:

- Redis 7 compatible, **Streams** and **Lua scripting** available, pub/sub pattern subscriptions allowed.
- `maxmemory-policy noeviction`. An eviction policy would silently drop stream entries and locks. Size memory
  for `events.*` streams (trimmed approximately to 100 000 entries each) plus keys.
- Persistence: the compose stack runs `appendonly yes`, `appendfsync everysec`. In the cloud choose an
  offering with durable writes where possible (for example Amazon MemoryDB, Redis Cloud or Upstash with
  persistence). Amazon ElastiCache does not offer AOF; if you use it, enable Multi-AZ with automatic failover
  and daily snapshots and accept that a full loss is recovered through the outbox re-publish procedure.
- TLS (`rediss://...`) and AUTH; reachable only from the service security groups. `REDIS_URL` is set per
  service; use a distinct `REDIS_KEY_PREFIX` (default `thali:`) if the instance is shared.
- Leave `EVENT_STREAM_PREFIX` empty in real environments (it exists so parallel tests do not collide).

## 7. Secrets and configuration

Store secrets in AWS Secrets Manager (or SSM Parameter Store SecureString) and inject them as ECS task
`secrets`; plain tunables go in task `environment`. Never bake secrets into images. `.env` is for local use
only and is git-ignored.

Generate with:

```bash
openssl rand -hex 32       # INTERNAL_SERVICE_SECRET (>= 32 chars required in production), OTP_PEPPER, mongo/other passwords
openssl rand -base64 32    # FIELD_ENCRYPTION_KEY (base64 of exactly 32 bytes)
# Ed25519 access-token signing key (PKCS#8 PEM), for JWT_PRIVATE_KEY_PEM:
openssl genpkey -algorithm ED25519 -out jwt-private.pem
```

| Secret | Needed by | Notes |
|---|---|---|
| `INTERNAL_SERVICE_SECRET` | all seven backends | Same value everywhere; signs service tokens; rotate with a rolling restart (runbook) |
| `MONGO_URI` | each backend (own user) | Never share one user across services |
| `REDIS_URL` | all backends including gateway | |
| `JWT_PRIVATE_KEY_PEM` (+ optional `JWT_PUBLIC_KEY_PEM`, `JWT_KID`) | identity | **Required in production** (no auto-generated key). Single `\n`-escaped line is accepted |
| `OTP_PEPPER` | identity | HMAC key for OTP hashes (min 16 chars) |
| `FIELD_ENCRYPTION_KEY` | identity (TOTP secrets), marketplace (bank details), notifications (recipients) | Use a distinct key per service. **Back it up**: losing it makes the encrypted fields unreadable. There is no re-encryption tool yet |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | payments | |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` or `TWILIO_MESSAGING_SERVICE_SID` | notifications | |
| `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `EMAIL_FROM` | notifications | |
| `GOOGLE_MAPS_API_KEY` | marketplace, delivery | |
| `S3_*` | marketplace, delivery | Prefer the task IAM role: omit the key variables |

Production-mode checklist for task environment (the services refuse to start otherwise):

```
APP_MODE=production
PAYMENT_PROVIDER=razorpay   SMS_PROVIDER=twilio   EMAIL_PROVIDER=resend   GEO_PROVIDER=google   STORAGE_PROVIDER=s3
# the same four *_PROVIDER values on the gateway so /api/v1/meta labels are honest
# UNSET (not just false): DEMO_OTP_ENABLED, DEMO_PHONES  (any truthy DEMO_* is refused; compose defaults DEMO_PHONES)
# unset MAILPIT_URL; no MOCK_WEBHOOK_SECRET needed
```

The images contain the demo seeds (`dist/seed.js`); every seed refuses to run unless `APP_MODE=demo`. Never seed
staging or production, and never run `npm run seed` against them.

Everything else (timeouts, windows, limits) has a safe default in code; the full list with descriptions is
`.env.example`. A few optional tunables exist in code but not in `.env.example`:
`ACCEPT_TIMEOUT_INTERVAL_MS` (orders, 15 000), `RESERVATION_GRACE_SEC` (300), `RESERVATION_EXTEND_SEC` (300),
`RESERVATION_SWEEP_INTERVAL_MS` (60 000), `RESERVATION_RECHECK_SEC` (60), `MEMBERSHIP_PENDING_TTL_SEC` (900)
(all marketplace) and `S3_PUBLIC_ENDPOINT` (marketplace, delivery; leave empty on AWS).

## 8. First deployment, step by step

1. Create the network, ALB, ACM certificate, ECR repositories, Atlas cluster and users, Redis, buckets and
   secrets. Configure provider consoles ([05-provider-setup.md](05-provider-setup.md)).
2. Build and push images tagged with the git SHA.
3. Create the ECS services in this order: identity, then marketplace, orders, payments, delivery,
   notifications (each waits on `/health/ready`), then gateway, then web. Consumer groups are created from
   stream id `0`, so start order does not lose events.
4. Check `GET https://app.example.com/health/ready` (gateway) and `/api/v1/meta` (labels should read `sandbox`
   or `live`, never `demo`).
5. **Create the first admin.** There is no public admin sign-up and production has no seed. Run the CLI inside
   the identity container (ECS Exec) so it uses the task's `MONGO_URI`:

```bash
aws ecs execute-command --cluster thali --task <identity-task-id> --container identity --interactive \
  --command 'node dist/cli/bootstrap-admin.js --email ops@example.com --name "Ops" --role SUPER_ADMIN'
```

   (Locally: `docker compose exec identity node dist/cli/bootstrap-admin.js ...`.) It prints a one-time
   password (or pass `--password-stdin`), refuses an existing email, and the admin enrols TOTP on first login
   (`POST /api/v1/auth/admin/mfa/setup`, then `/mfa/enable`). A SUPER_ADMIN can then create more admins
   (`POST /api/v1/admin/admins`). The `npm run bootstrap-admin -w @thali/identity` form uses `tsx` and is for a
   dev checkout, not for images.
6. Configure service areas, cuisines, membership plans and coupons in the admin console, then onboard the pilot
   restaurants and partners through the real approval flow.
7. Point the provider webhooks at the public URL and run the verification steps in each provider section.

## 9. Scaling notes

- All backends are stateless; scale tasks horizontally on CPU and request count. Relays, sweepers, the
  dispatcher, the refund worker and the notification retry worker run in every task but are **leader-locked in
  Redis** (`SET NX PX`, renewed): exactly one instance works at a time, the others take over on failure.
- Consumer groups (`cg.<service>`) let several instances share a stream; handlers are idempotent through the
  inbox, so redelivery is safe.
- Realtime: `notifications` keeps the SSE connections (cap 5 per user, streams closed after an hour) and fans
  out through Redis pub/sub, so any instance can serve any user. Scale notifications on connection count; keep
  the ALB idle timeout above the heartbeat.
- Pilot target (PRD): about one city, 200 restaurants, 500 partners, 5 000 orders per day. This has **not** been
  load tested (launch blocker). Likely first limits: Mongo transactions under checkout bursts, discovery cost
  with Google calls per restaurant, and SSE connection count.
- When Redis Streams stop being enough, swap the relay/consumer transport for NATS JetStream or Kafka (ADR-003);
  the outbox/inbox model stays.
- Observability: pino JSON logs with `reqId`/`correlationId` to CloudWatch, alert on `level>=50`, on log lines
  carrying `alert:` (`PAYMENT_MISMATCH`, `DUPLICATE_CAPTURE`, `FAILED_AFTER_CAPTURE`, `REFUND_OVER_RESERVED`,
  `WEBHOOK_MALFORMED`, `LEDGER_DISTANCE_MISSING`), on the admin health page values (outbox age, consumer lag,
  dead letters, provider errors), and on Atlas/Redis metrics.
- Data protection: Atlas encryption at rest, S3 SSE, TLS to every dependency; KYC documents are in the private
  bucket only. Retention and privacy duties are in the launch checklist (DPDP review).

## 10. Release and rollback

- Rolling deployments with ECS circuit breaker enabled; deploy backends before the web image when an API
  change is additive, the web image first only when it tolerates both shapes.
- Schema changes must be additive with defaults (LLD 14); events carry `version` and consumers ignore unknown
  fields, so mixed-version fleets during a rollout are safe.
- Rollback = redeploy the previous image digest. Because writes are outbox-based and handlers idempotent, a
  rollback does not lose events; re-check the admin health page afterwards.
- Take an Atlas snapshot before any release that touches data shape, and rehearse the restore in
  [backup-restore.md](backup-restore.md) in staging before launch.
