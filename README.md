# Thali

A food-delivery marketplace for a pilot launch in India: consumers, restaurants and cloud kitchens, delivery
partners and administrators, with multi-restaurant checkout, real payment/refund/ledger flows, dispatch and
live tracking. It is a MERN-style monorepo of six domain services behind an API gateway and one React SPA.

> **Mode and honesty note.** The stack boots in `APP_MODE=demo`: payments, SMS and maps are simulated
> (a signed mock payment webhook, a mock SMS provider, a haversine estimator), email goes to a local Mailpit
> inbox and files go to a local MinIO. Every provider adapter for Razorpay, Twilio, Resend, Google Maps and
> S3 is implemented, but **live/sandbox verification is pending credentials**. See
> [docs/05-provider-setup.md](docs/05-provider-setup.md) and
> [docs/08-launch-checklist.md](docs/08-launch-checklist.md).

## Prerequisites

- Node.js 22 LTS (`.nvmrc` = 22; `engines` is `>=22 <23`) and npm 10
- Docker with Compose v2 (`docker compose version`)
- Free host ports: 5173 (web), 8080 (gateway), 8025 (Mailpit), 9000 and 9001 (MinIO)

## Quick start (full stack in Docker)

```bash
cp .env.example .env        # demo-only placeholder secrets; boots out of the box
npm ci
npm run stack:up            # docker compose up -d --build --wait (first build takes a few minutes)
npm run seed                # idempotent demo data (refuses to run unless APP_MODE=demo)
```

`npm run seed` runs each service's own seed inside its container (`docker compose exec <svc> node dist/seed.js`;
order: identity, marketplace, delivery, payments, notifications, orders), so every service only writes its own
database. A second run reports 0 inserts. Options: `npm run seed -- identity marketplace` (only some services)
and `npm run seed -- --local` (host mode with tsx against the infra stack and the values in `.env`).

Then open:

| What | URL |
|---|---|
| Web app (consumer, `/restaurant`, `/partner`, `/admin`) | http://localhost:5173 |
| API gateway | http://localhost:8080 (health: `/health/ready`, meta: `/api/v1/meta`) |
| Swagger UI (all seven specs) | http://localhost:8080/api/docs |
| Mailpit inbox (demo emails) | http://localhost:8025 |
| MinIO console (images, KYC documents) | http://localhost:9001 (user `MINIO_ROOT_USER`, password `MINIO_ROOT_PASSWORD` from `.env`) |

Stop with `npm run stack:down` (keeps data). For a clean slate use `docker compose down -v` (drops the Mongo,
Redis and MinIO volumes).

Mongo, Redis and the six services are not published to the host. To reach them for debugging:
`docker compose --profile debug up -d debug-ports` (services on `localhost:14001..14006`, Mongo on
`localhost:27019` with `directConnection=true`, Redis on `localhost:16379`).

If a port is taken (for example the test infra stack also binds 8025/9000/9001), override it in `.env`:
`MAILPIT_HOST_PORT=18025 MINIO_HOST_PORT=19000 MINIO_CONSOLE_HOST_PORT=19001` (also `WEB_HOST_PORT`,
`GATEWAY_HOST_PORT`, `PUBLISH_ADDR`).

## Demo credentials (demo mode only)

| Role | Sign in | Code / password |
|---|---|---|
| Consumers | phone `+919000000001`, `+919000000002`, `+919000000003` | OTP `123456` |
| Restaurant owners | `+919100000001`, `+919100000002` | OTP `123456` |
| Delivery partners | `+919200000001` (approved, online), `+919200000002` (approved, offline) | OTP `123456` |
| Admin | `admin@thali.demo` at `/admin` | password `ThaliDemo#2026`, TOTP secret `THALIDEMOTOTPSECRETKEY234567ABCD`; the seed prints both, the otpauth URI and the current 6-digit code. Override with `SEED_ADMIN_PASSWORD` / `SEED_ADMIN_TOTP_SECRET` |

The fixed OTP works only for the numbers in `DEMO_PHONES` while `APP_MODE=demo` and
`DEMO_OTP_ENABLED=true`. OTP requests are rate limited per phone (5 per hour), so vary the phone when you
script flows. In production there is no fixed OTP and no demo admin: create admins with the bootstrap CLI
([docs/06-deployment.md](docs/06-deployment.md)).

Partners `+919200000003` (approval pending) and `+919200000004` (suspended) also exist but are not in
`DEMO_PHONES`, so they have no fixed OTP. The seed creates approved and pending restaurants in one Bengaluru service area, menus with customizations
and one tracked-stock item, partners in each state, coupons `WELCOME50` and `FLAT100`, a membership plan, and
a multi-restaurant demo order `TH-DEMOMULTI` (one child delivered, one rejected and refunded). All demo rows
are flagged `isDemo`, and the UI shows a persistent mode banner.

## Local development without rebuilding images

```bash
npm run dev                 # infra stack (Mongo :27018, Redis, MinIO, Mailpit) + all services with tsx watch + Vite
npm run dev -- identity web # only some apps (identity marketplace orders payments delivery notifications gateway web)
```

`npm run dev` sources `.env`, builds the three shared packages once and starts the infra stack
(`docker-compose.infra.yml`). Do not run it together with `stack:up` (same host ports).

## Tests

```bash
npm run infra:up            # Mongo replica set (localhost:27018), Redis (6379), MinIO, Mailpit
npm run build               # tsc -b for packages and services, then the web build
npm run typecheck
npm test                    # all unit + integration tests (vitest, real Mongo + Redis, parallel-safe)
npm run test:unit           # no infrastructure needed
npm run test:int            # only *.int.test.ts
npm run smoke               # scripted API walk through the running full stack
npm run e2e                 # stack:up + seed + Playwright against http://localhost:5173
```

Integration tests use `mongodb://localhost:27018/?replicaSet=rs0&directConnection=true` and
`redis://localhost:6379` with unique database names and Redis prefixes per test file. Running the infra stack
and the full stack together needs the port overrides above. How to run each suite, and the recorded results,
are in [docs/10-testing.md](docs/10-testing.md).

## Repository layout

```
packages/contracts      enums, state machines, event types, error codes, shared zod schemas
packages/pricing        pure integer-paise pricing and pro-rata allocation
packages/service-kit    express factory, config guard, auth, outbox/inbox/streams, idempotency, providers
services/gateway        edge proxy, rate limits, /api/v1/meta, /api/docs, admin health
services/identity       phone OTP, admin password + TOTP, JWT/JWKS, sessions, audit log
services/marketplace    restaurants, menus, stock holds, discovery, coupons, memberships
services/orders         carts, checkout saga, child orders, support tickets
services/payments       payment intents, webhooks, refunds, ledger, recorded payouts
services/delivery       partners, dispatch and batching, handover codes, tracking, admin TMS
services/notifications  SMS / email / in-app with retries, SSE hub
apps/web                React SPA: consumer, restaurant, partner and admin areas
e2e/                    Playwright end-to-end and failure-scenario tests
infra/                  mongo init + keyfile scripts, nginx config
scripts/                dev.sh, wait-for-health.sh, seed.ts, smoke.ts
docs/                   PRD, HLD, LLD, ADRs, provider setup, deployment, runbook, checklist, diagrams
```

## Documentation

| Doc | Contents |
|---|---|
| [docs/01-PRD.md](docs/01-PRD.md), [02-HLD.md](docs/02-HLD.md), [03-LLD.md](docs/03-LLD.md), [04-ADR.md](docs/04-ADR.md) | Requirements, architecture, binding contracts, decisions (ADR-014 onward record build-time rulings) |
| [docs/05-provider-setup.md](docs/05-provider-setup.md) | Razorpay, Twilio (India DLT), Resend, Google Maps, S3: exact credentials, console steps, webhook URLs, status |
| [docs/06-deployment.md](docs/06-deployment.md) | Staging and production on ECS Fargate (or equivalent), Atlas, managed Redis, secrets, TLS, scaling |
| [docs/07-runbook.md](docs/07-runbook.md) | Stuck payment/checkout/order, refunds, dead letters, Redis loss, failover, provider outage, secret rotation |
| [docs/08-launch-checklist.md](docs/08-launch-checklist.md) | Verified vs pending external configuration, limitations, launch blockers |
| [docs/09-api.md](docs/09-api.md) | Swagger locations, auth, idempotency, webhooks, pagination, errors |
| [docs/10-testing.md](docs/10-testing.md) | How to run tests; recorded results |
| [docs/backup-restore.md](docs/backup-restore.md) | mongodump / mongorestore per service database, Redis AOF |
| [docs/diagrams/](docs/diagrams/) | Architecture, checkout and refund sagas, delivery flow, state machines (Mermaid) |

## Configuration

`.env.example` documents every variable, grouped per service, with `# SECRET` markers. Compose fixes the
container topology (per-service Mongo user and URI, `http://<svc>:<port>` peers, JWKS, MinIO endpoints), so
the localhost values in `.env` only apply to `npm run dev`. Regenerate every `# SECRET` value for anything
other than a local demo:

```bash
openssl rand -base64 32     # FIELD_ENCRYPTION_KEY (base64 of exactly 32 bytes)
openssl rand -hex 32        # INTERNAL_SERVICE_SECRET, peppers, webhook secrets, Mongo/MinIO passwords
```

`APP_MODE=production` refuses to start with any mock provider, Mailpit, the demo geo provider, any truthy
`DEMO_*` variable, an `INTERNAL_SERVICE_SECRET` shorter than 32 characters or no `JWT_PRIVATE_KEY_PEM`.

## Common problems

| Symptom | Fix |
|---|---|
| `stack:up` fails with `set X in .env` | `cp .env.example .env` (compose requires the secrets) |
| Port already allocated | Override the `*_HOST_PORT` variable in `.env` (see above) |
| Browser upload fails with a DNS error for `minio` | `S3_PUBLIC_ENDPOINT` must be reachable by the browser (compose sets `http://localhost:${MINIO_HOST_PORT}`) |
| `Too many open files` from Mongo | compose sets `nofile 64000`; on Docker Desktop/Colima raise the VM limit |
| Tests fail with `ECONNREFUSED ::1:27018` | `npm run infra:up`; the infra Mongo uses `restart: unless-stopped` |
| 429 from OTP | Per-phone limit (5/hour, 30 s cooldown); use another demo phone or wait for the window to pass |
