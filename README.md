# Thali

A food-delivery marketplace for a pilot launch in India: consumers, restaurants and cloud kitchens, delivery
partners and administrators, with multi-restaurant checkout, real payment/refund/ledger flows, dispatch and
live tracking. It is a MERN-style monorepo of six domain services behind an API gateway and one React SPA.

## What is in it

- **Consumers**: a public landing page with address search (type an address or use your location), discovery of
  restaurants that deliver to you with counts, cuisine chips, pure-veg and offers, restaurant pages with a
  recommended section and an item customizer, a floating multi-restaurant cart, **per-restaurant checkout**
  (pay for one restaurant and keep the rest in the cart), live order tracking with the rider's remaining ETA,
  refund progress per restaurant, ratings, Thali Plus membership, support tickets, saved addresses with
  locality, profile pictures.
- **Restaurants**: live-orders board (new, preparing, ready) with accept and reject, pause controls, menu and
  stock management with pure-veg enforcement and recommended items, store settings, finance with today's
  figures and payouts, onboarding wizard.
- **Delivery partners**: online toggle, time-limited offers that show only the drop **area** (never the
  customer's address before pickup), batching explanations, pickup and delivery codes, **call the restaurant or
  customer** (simulated in demo), earnings and payouts.
- **Admins**: overview with live counts and "needs attention", global search (orders, phones, users),
  approvals, TMS with a nearest-partner assign picker, finance and refunds, catalog (scoped coupons, banners,
  cuisines, service areas), support, audit log, **explanatory health** (a failing provider is "degraded", not
  "down"), **bulk retry** of failed notifications and **bulk replay** of dead letters, and a **password reset**
  by emailed link plus authenticator code.
- **Design**: the Masala design system with **light, dark and system themes** on every screen, self-hosted fonts,
  and honest-data labels (no fake ratings, estimates marked `EST.`, simulated locations marked).

> **Mode and honesty note.** The stack boots in `APP_MODE=demo`: payments, SMS and maps are simulated
> (a signed mock payment webhook, a mock SMS provider, a haversine estimator), email goes to a local Mailpit
> inbox and files go to a local MinIO. Every provider adapter for Razorpay, Twilio, Resend, Google Maps and
> S3 is implemented, but **live/sandbox verification is pending credentials**. See
> [docs/05-provider-setup.md](docs/05-provider-setup.md) and
> [docs/08-launch-checklist.md](docs/08-launch-checklist.md).

## Run it on your machine (5 commands)

You only need **Docker** and **Node.js 22**; everything else (MongoDB, Redis, MinIO, Mailpit, the seven
services and the web app) runs in containers.

1. Install
   - [Docker Desktop](https://www.docker.com/products/docker-desktop/) (macOS, Windows, Linux) or Docker Engine
     with Compose v2. Give Docker at least **4 GB of memory** and **10 GB of free disk** (Settings → Resources).
     Start it and wait until it says it is running.
   - [Node.js 22 LTS](https://nodejs.org/) (with npm 10). With nvm: `nvm install 22 && nvm use 22`.
   - **Windows:** use WSL2 (Docker Desktop's WSL integration on) and run every command below inside the Ubuntu
     terminal, with the project unzipped inside the Linux home folder (for example `~/thali`), not under `C:\`.
   - Keep the project folder **inside your home folder** (for example `~/thali`). Docker Desktop and Colima only
     share the home folder with containers by default; from `/tmp` or another disk the database container cannot
     read its start script and keeps restarting.
2. Unzip the project, open a terminal in its folder and run:

   ```bash
   cp .env.example .env     # demo settings; works as is, nothing to fill in
   npm ci                   # installs the tools used by the seed and test scripts (about 1 min)
   npm run stack:up         # builds and starts everything (first time about 5-10 min, later about 30 s)
   npm run seed             # first run copies the demo photos (a few min), then loads the Bengaluru data: about 5-10 min
   npm run demo:traffic     # optional: places a few live orders so the restaurant, rider and admin screens are busy
   ```

3. Open **http://localhost:5173** and sign in (header → "Sign in"). Every demo phone uses OTP **`123456`**:

   | Role | Sign in with |
   |---|---|
   | Customer | `+919000000001` (has past orders) or any `+91910100xxxx`, for example `+919101000001` |
   | Restaurant owner | `+919100000001` (Spice Route) or any `+91920200xxxx`, for example `+919202000001` |
   | Delivery partner | `+919200000001` (online) or any `+91930300xxxx`, for example `+919303000002` |
   | Admin | `/signin?role=admin`: email `admin@thali.demo`, password `ThaliDemo#2026`, plus a 6-digit code (below) |

   The admin code is a TOTP for the demo secret `THALIDEMOTOTPSECRETKEY234567ABCD`. Either add that secret to an
   authenticator app, or print the current code (valid 30 s) from the project folder:

   ```bash
   node -e "const {authenticator}=require('otplib');console.log(authenticator.generate('THALIDEMOTOTPSECRETKEY234567ABCD'))"
   ```

   Coupons to try at checkout: `WELCOME50`, `FLAT100`. Demo emails (admin password reset, receipts) land in the
   Mailpit inbox at http://localhost:8025. API docs: http://localhost:8080/api/docs.

4. Stop with `npm run stack:down` (data is kept; `npm run stack:up` brings it back). Start over with
   `docker compose down -v && npm run stack:up && npm run seed`.

The first `npm run seed` copies 1,107 real food and profile photos (Wikimedia Commons, Openverse, randomuser.me)
into the local MinIO, so the app works offline afterwards; later runs reuse that copy. In a hurry? Use
`npm run seed -- --no-images` (about 2 min): the app then loads the same photos straight from those sites, so the
browser needs internet access.

If something goes wrong: a "port is already allocated" error means another app uses 5173, 8080, 8025, 9000 or
9001. Change `WEB_HOST_PORT`, `GATEWAY_HOST_PORT`, `MAILPIT_HOST_PORT`, `MINIO_HOST_PORT` or
`MINIO_CONSOLE_HOST_PORT` in `.env` and run `npm run stack:up` again. More fixes are in
[Common problems](#common-problems).

## Prerequisites

- Node.js 22 LTS (`.nvmrc` = 22; `engines` is `>=22 <23`) and npm 10
- Docker with Compose v2 (`docker compose version`)
- Free host ports: 5173 (web), 8080 (gateway), 8025 (Mailpit), 9000 and 9001 (MinIO); see "Host ports" below if
  the test infra stack is running
- For the Playwright e2e suite: Chromium for Playwright (`npx playwright install chromium`)

## Quick start (full stack in Docker)

```bash
cp .env.example .env        # demo-only placeholder secrets; boots out of the box
npm ci
npm run stack:up            # docker compose up -d --build --wait (first build takes a few minutes)
npm run seed:images         # optional: only the photo mirror (npm run seed runs it too; one time, cached)
npm run seed                # idempotent demo data (refuses to run unless APP_MODE=demo)
npm run demo:traffic        # optional: place and progress live orders so the boards are busy
```

`cp .env.example .env` is for a local demo only: every placeholder secret in it carries the marker `thali-demo-`,
which `APP_MODE=production` refuses. For any non-demo environment (shared staging, sandbox, production) generate
a `.env` with fresh random secrets instead:

```bash
scripts/gen-env.sh            # writes .env from .env.example with openssl-random secrets (mode 600)
scripts/gen-env.sh .env.staging --force
```

It replaces only the `thali-demo-` placeholders (`FIELD_ENCRYPTION_KEY` as base64 of 32 bytes, every other secret
as 32 random bytes in hex), refuses to overwrite an existing file without `--force`, and changes nothing else:
you still set `APP_MODE`, the real provider credentials, turn `DEMO_OTP_ENABLED` off and empty `DEMO_PHONES`
(see [docs/06-deployment.md](docs/06-deployment.md)).

`npm run seed` runs each service's own seed inside its container (`docker compose exec <svc> node dist/seed.js`;
order: identity, marketplace, delivery, payments, notifications, orders), so every service only writes its own
database. A second run reports 0 inserts (idempotent). On a fresh stack with the photos already mirrored the first
run inserts 138,702 documents in about 90 s (identity 1,711 · marketplace 25,909 · delivery 5,528 ·
payments 42,190 · notifications 2,703 · orders 60,661); a re-run takes about 40 s and inserts 0. The first
`npm run seed:images` downloads 1,107 photos (about 11 min, Wikimedia pacing); later runs take about 2 s. Options: `npm run seed -- identity marketplace` (only some services)
and `npm run seed -- --local` (host mode with tsx against the infra stack and the values in `.env`).

Then open:

| What | URL |
|---|---|
| Web app: public landing at `/` (always), consumer Discover at `/discover`, sign-in at `/signin?role=customer\|restaurant\|partner\|admin`, then `/restaurant`, `/partner`, `/admin` | http://localhost:5173 |
| API gateway | http://localhost:8080 (health: `/health/ready`, meta: `/api/v1/meta`) |
| Swagger UI (all seven specs) | http://localhost:8080/api/docs |
| Mailpit inbox (demo emails) | http://localhost:8025 |
| MinIO console (images, KYC documents) | http://localhost:9001 (user `MINIO_ROOT_USER`, password `MINIO_ROOT_PASSWORD` from `.env`) |

The web container is a non-root nginx (`nginx-unprivileged`, uid 101): it listens on port **8080 inside the
container** and compose publishes it as host port **5173** (`WEB_HOST_PORT`); the gateway container also listens
on 8080 and is published on host 8080 (`GATEWAY_HOST_PORT`). Published ports bind to `127.0.0.1` unless
`PUBLISH_ADDR` is changed.

Stop with `npm run stack:down` (keeps data). For a clean slate use `docker compose down -v` (drops the Mongo,
Redis and MinIO volumes).

Mongo, Redis and the six services are not published to the host. To reach them for debugging:
`docker compose --profile debug up -d debug-ports` (services on `localhost:14001..14006`, Mongo on
`localhost:27019` with `directConnection=true`, Redis on `localhost:16379`).

### Host ports

If a port is taken, override it in `.env` (`WEB_HOST_PORT`, `GATEWAY_HOST_PORT`, `MAILPIT_HOST_PORT`,
`MINIO_HOST_PORT`, `MINIO_CONSOLE_HOST_PORT`, `PUBLISH_ADDR`). The common case: the test infra stack
(`npm run infra:up`) also binds Mailpit 8025/1025 and MinIO 9000/9001, so while it is running start the full
stack with

```bash
MAILPIT_HOST_PORT=18025 MINIO_HOST_PORT=19000 MINIO_CONSOLE_HOST_PORT=19001
```

added to `.env` (the Mailpit inbox is then http://localhost:18025 and MinIO http://localhost:19000 / 19001).
`S3_PUBLIC_ENDPOINT` follows `MINIO_HOST_PORT` automatically, so browser uploads keep working. The infra stack's
Mongo is on 27018 and Redis on 6379; the full stack does not publish them, so there is no clash there.

## Demo: the Bengaluru marketplace

In demo mode the seed builds a Bengaluru-scale marketplace so every screen has realistic content: restaurants
across 71 localities with fictional names but real streets, dishes and prices, menus with photos, consumers,
delivery partners and two months of order history with ratings, payouts and refunds, plus one city-wide service area.
The data is generated deterministically (`@thali/contracts/seed-blr`), so it is the same on every machine and
re-running the seed changes nothing. The older small story data (`TH-DEMOMULTI` and the nine accounts below) is
kept. Mode is shown in a persistent banner, and everything seeded is flagged `isDemo`.

| Dataset | Count |
|---|---|
| Restaurants, owners | 600 generated (582 approved, the rest pending / suspended / rejected) across 71 localities, plus the 4 story restaurants; 450 owners (90 with two branches, 30 with three) |
| Consumers, delivery partners | 1,000 consumers with 1,720 addresses; 250 partners (228 approved) |
| Historical checkouts, menu items | 5,000 checkouts / 5,984 child orders over 60 days (4,224 ratings, 712 refunds, 4,760 paid weekly payouts); 14,904 menu items in 5,406 categories |

Try it:

1. Open http://localhost:5173. `/` is always the public landing; it asks "Where should we deliver?": type
   `Indiranagar` or `Koramangala`, pick a suggestion (or use your location) and you land on Discover
   (`/discover`) for that address. The consumer logo and Home tab go back to `/discover`.
2. Toggle **light / dark / system** from the theme control in the header (or the account menu on phones).
3. Sign in from `/signin?role=customer` (phone, demo OTP), `/signin?role=restaurant`, `/signin?role=partner`, or
   `/signin?role=admin` (email, password, authenticator code). `/admin/login` redirects there.
4. Add items from two restaurants, then check out **one** restaurant from the cart bar; the other stays in the cart.
5. For a busy dashboard run `npm run demo:traffic`, then open the owner board, the partner home and the admin overview.

Sample logins for the generated data (demo OTP `123456`; generated numbers are consumers `+91910 1000001…`, owners
`+91920 2000001…`, partners `+91930 3000001…`):

| Role | Phone | Who |
|---|---|---|
| Consumer | +919101000001 | Santosh Naik (Kalyan Nagar) |
| Consumer | +919101000002 | Narasimha Gupta (MG Road) |
| Owner, two restaurants | +919202000001 | Amreen Syed: RT Nagar Street Kitchen (Bannerghatta Road, RT Nagar) |
| Owner, two restaurants | +919202000339 | Shweta Jain: Flat White & Co. Cafe (Benson Town, Mahadevapura) |
| Partner | +919303000002 | Varun Chary, bike KA41YX7378 |
| Partner | +919303000169 | Vineet Trivedi (used by `npm run demo:traffic`) |

Photos are real, CC-licensed pictures from Wikimedia Commons and Openverse plus randomuser.me portraits; the
attribution for every image is in [scripts/seed-data/CREDITS.md](scripts/seed-data/CREDITS.md) (restaurant and
person names are fictional). `npm run seed` copies them into the local MinIO first (the same step as
`npm run seed:images`); with `npm run seed -- --no-images` the app hot-links the original hosts instead, which are
allowed by `EXTERNAL_IMAGE_HOSTS`.

## Demo credentials (demo mode only)

| Role | Sign in | Code / password |
|---|---|---|
| Consumers | phone `+919000000001`, `+919000000002`, `+919000000003` | OTP `123456` |
| Restaurant owners | `+919100000001`, `+919100000002` | OTP `123456` |
| Delivery partners | `+919200000001` (approved, online), `+919200000002` (approved, offline) | OTP `123456` |
| Admin | `admin@thali.demo` at `/signin?role=admin` | password `ThaliDemo#2026`, TOTP secret `THALIDEMOTOTPSECRETKEY234567ABCD`; the seed prints both, the otpauth URI and the current 6-digit code. Override with `SEED_ADMIN_PASSWORD` / `SEED_ADMIN_TOTP_SECRET` |

The admin password and TOTP secret are constants in `services/identity/src/seed.ts`; `npm run seed` (the identity
step) prints the email, password, TOTP secret, the `otpauth://` URI and the current 6-digit code, so you can also
copy them from the seed output. They exist only in demo data and are never created in production.

The fixed OTP `123456` works only for the numbers in `DEMO_PHONES` (and, for the generated Bengaluru accounts, the prefixes in `DEMO_PHONE_PREFIXES`, default `+9191010,+9192020,+9193030`) while `APP_MODE=demo` and
`DEMO_OTP_ENABLED=true` (demo phones and the fixed OTP exist in demo mode only; production refuses both). OTP requests are rate limited per phone (5 per hour), so vary the phone when you
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
npm run smoke               # scripted API walk (26 steps) through the running, seeded full stack
npm run e2e                 # stack:up + seed + Playwright (12 flows + 8 failure scenarios) against http://localhost:5173
```

Run `smoke` and `e2e` **sequentially**, never together: they share the demo phones, the demo partners and the
seeded restaurants' order boards. The e2e suite clears the demo phones' OTP rate-limit counters in the demo Redis
before it signs in (demo-only, refuses unless `/api/v1/meta` says `demo`; set `E2E_RESET_RATE_LIMITS=0` to
disable), so repeated runs do not lock the demo numbers.
Integration tests use `mongodb://localhost:27018/?replicaSet=rs0&directConnection=true` and
`redis://localhost:6379` with unique database names and Redis prefixes per test file. Running the infra stack
and the full stack together needs the port overrides above. How to run each suite, and the recorded results,
are in [docs/10-testing.md](docs/10-testing.md) (last verified run, UI-redesign final gate at `f9863ed` on fresh
volumes: build exit 0, 222 test files / 1 881 tests passed, seed 138,702 then 0, seed-verify 17/17, smoke 26/26,
Playwright e2e 33/33).

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
scripts/                dev.sh, gen-env.sh, wait-for-health.sh, seed.ts, seed-images.ts, demo-traffic.ts, smoke.ts, seed-data/ (Bengaluru dataset + CREDITS.md)
docs/                   PRD, HLD, LLD, ADRs, provider setup, deployment, runbook, checklist, diagrams
```

## Documentation

| Doc | Contents |
|---|---|
| [docs/01-PRD.md](docs/01-PRD.md), [02-HLD.md](docs/02-HLD.md), [03-LLD.md](docs/03-LLD.md), [04-ADR.md](docs/04-ADR.md) | Requirements, architecture, binding contracts, decisions (ADR-014 onward record build-time rulings; ADR-034 to ADR-041 the UI redesign) |
| [docs/05-provider-setup.md](docs/05-provider-setup.md) | Razorpay, Twilio (India DLT), Resend, Google Maps, S3: exact credentials, console steps, webhook URLs, status |
| [docs/06-deployment.md](docs/06-deployment.md) | Staging and production on ECS Fargate (or equivalent), Atlas, managed Redis, secrets, TLS, scaling |
| [docs/07-runbook.md](docs/07-runbook.md) | Stuck payment/checkout/order, refunds, dead letters, Redis loss, failover, provider outage, secret rotation; reseed, image mirror, demo traffic, bulk retry/replay, reading "degraded" (section 14) |
| [docs/08-launch-checklist.md](docs/08-launch-checklist.md) | Verified vs pending external configuration, limitations, launch blockers |
| [docs/09-api.md](docs/09-api.md) | Swagger locations, auth, idempotency, webhooks, pagination, errors |
| [docs/10-testing.md](docs/10-testing.md) | How to run tests; recorded results |
| [docs/backup-restore.md](docs/backup-restore.md) | mongodump / mongorestore per service database, Redis AOF |
| [docs/ui-redesign-context.md](docs/ui-redesign-context.md) | The original UI redesign brief (every screen and data object); the redesign is implemented, see the note at its top |
| [scripts/seed-data/CREDITS.md](scripts/seed-data/CREDITS.md) | Photo attribution for the demo dataset (CC licences) |
| [docs/diagrams/](docs/diagrams/) | Architecture, checkout and refund sagas, delivery flow, state machines (Mermaid) |

## Configuration

`.env.example` documents every variable, grouped per service, with `# SECRET` markers. Compose fixes the
container topology (per-service Mongo user and URI, `http://<svc>:<port>` peers, JWKS, MinIO endpoints), so
the localhost values in `.env` only apply to `npm run dev`. Regenerate every `# SECRET` value for anything
other than a local demo with `scripts/gen-env.sh` (see Quick start); by hand that is:

```bash
openssl rand -base64 32     # FIELD_ENCRYPTION_KEY (base64 of exactly 32 bytes)
openssl rand -hex 32        # INTERNAL_SERVICE_SECRET, peppers, webhook secrets, Mongo/MinIO passwords
```

For production also set `PUBLIC_WEB_URL` (the public SPA origin; identity refuses to start without it because it
builds the admin password-reset link), decide `EXTERNAL_IMAGE_HOSTS` (usually `none`) and enable Google Places for
address search ([docs/06-deployment.md](docs/06-deployment.md) section 7).

`APP_MODE=production` refuses to start with any mock provider, Mailpit, the demo geo provider, any truthy
`DEMO_*` variable, any value containing the `thali-demo-` placeholder marker (raw, inside a URI or
base64-encoded), `COOKIE_SECURE=false`, an `INTERNAL_SERVICE_SECRET` shorter than 32 characters or no
`JWT_PRIVATE_KEY_PEM`.

## Common problems

| Symptom | Fix |
|---|---|
| `stack:up` fails with `set X in .env` | `cp .env.example .env` (compose requires the secrets) |
| `mongo is unhealthy`; `docker logs` shows `/infra/mongo/keyfile.sh: No such file or directory` | The project folder is not shared with Docker: move it under your home folder (or add its path in Docker Desktop → Settings → Resources → File sharing) |
| `stack:up` hangs or containers get killed while building | Give Docker more memory (at least 4 GB) in its settings |
| Port already allocated | Override the `*_HOST_PORT` variable in `.env` (see "Host ports") |
| Production start refused: "demo placeholder" | A `thali-demo-` value from `.env.example` is still in use: run `scripts/gen-env.sh` |
| Browser upload fails with a DNS error for `minio` | `S3_PUBLIC_ENDPOINT` must be reachable by the browser (compose sets `http://localhost:${MINIO_HOST_PORT}`) |
| `Too many open files` from Mongo | compose sets `nofile 64000`; on Docker Desktop/Colima raise the VM limit |
| Tests fail with `ECONNREFUSED ::1:27018` | `npm run infra:up`; the infra Mongo uses `restart: unless-stopped` |
| 429 from OTP | Per-phone limit (5/hour, 30 s cooldown); use another demo phone or wait for the window to pass |
