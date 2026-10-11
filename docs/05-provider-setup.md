# Provider setup

Thali talks to five external systems through adapters selected by environment variables. This document lists,
per provider, what the adapter does, the exact credentials and approvals you need, where to configure them
and how to verify them.

## Status at a glance

| Provider | Adapter | Verified in demo | Live / sandbox status |
|---|---|---|---|
| Razorpay (payments, refunds) | `services/payments/src/providers/razorpay.ts` | Yes, with the mock provider and signed mock webhooks through the real webhook pipeline | **Implemented; sandbox verification pending credentials.** Request shapes verified against Razorpay's published docs and stubbed `fetch` tests, never called against Razorpay |
| Twilio (SMS) | `services/notifications/src/providers/twilio-sms.ts` | Yes, with the mock SMS provider (logs `[DEMO] would send`, no body or number) | **Implemented; live verification pending credentials and India DLT registration** |
| Resend (email) | `services/notifications/src/providers/resend-email.ts` | Yes, with Mailpit (verified against a live Mailpit in `mailpit.int.test.ts`) | **Implemented; live verification pending an API key, a verified domain and a webhook secret** |
| Google Maps (ETA, distance, geocoding) | `packages/service-kit/src/providers/google-geo.ts` | Yes, with the labeled haversine estimator | **Implemented; live verification pending an API key** (stubbed `fetch` tests only) |
| S3 (images, KYC documents) | `packages/service-kit/src/providers/s3-storage.ts` | Yes, against MinIO (same S3 API; `s3-storage.int.test.ts`) | **Implemented; verified on MinIO only. AWS S3 pending buckets, CORS and an IAM role** |
| Payouts | Manual-UTR recorder (`services/payments/src/domain/payouts.ts`) | Yes | **By design there is no payout provider**: an admin records a payout after a real bank transfer and enters the bank UTR (ADR-010). There is nothing to configure |

"Verified in demo" means exercised by automated tests or the running demo stack. It does not mean the live
provider has ever been called.

## How modes select adapters

| Variable | Values | Demo default | Production |
|---|---|---|---|
| `PAYMENT_PROVIDER` | `razorpay`, `mock` | `mock` | must be `razorpay` |
| `SMS_PROVIDER` | `twilio`, `mock` | `mock` | must be `twilio` |
| `EMAIL_PROVIDER` | `resend`, `mailpit`, `mock` | `mailpit` | must be `resend` |
| `GEO_PROVIDER` | `google`, `demo` | `demo` | must be `google` |
| `STORAGE_PROVIDER` | `s3` | `s3` | `s3` (AWS S3 or any S3-compatible store) |

- `APP_MODE=production` refuses to start with any mock provider, Mailpit, the demo geo provider or any truthy
  `DEMO_*` variable. `APP_MODE=sandbox` may run real providers with test credentials.
- The gateway reports the labels at `GET /api/v1/meta` (`demo`, `sandbox` or `live`) and the SPA shows the mode
  banner from it. The gateway only knows what it is told, so set the same `*_PROVIDER` values on the gateway
  and on the services.
- Missing credentials fail at startup (`ConfigError` names the variable), not at first use.

---

## 1. Razorpay (payments and refunds)

Adapter behaviour: create an order per checkout (`POST /v1/orders`, receipt `<intentId>_<attempt>` at most 40
chars, amount in paise), capture authorized payments (`POST /v1/payments/:id/capture`), refunds
(`POST /v1/payments/:id/refund` with the `X-Refund-Idempotency` header), fetch order payments and refunds for
reconciliation, and verify webhooks. The browser uses Razorpay Standard Checkout
(`https://checkout.razorpay.com/v1/checkout.js`).

### What you need

| Item | Where it goes |
|---|---|
| Key Id (`rzp_test_...` or `rzp_live_...`) | `RAZORPAY_KEY_ID` (public; returned to the browser) |
| Key Secret | `RAZORPAY_KEY_SECRET` (secret) |
| Webhook secret you choose when creating the webhook | `RAZORPAY_WEBHOOK_SECRET` (secret) |
| A public HTTPS URL for the gateway | `PUBLIC_API_URL` and the webhook target |
| For live mode: Razorpay account activation (business KYC, bank account, website/app details) | Razorpay Dashboard, done by the business owner |

### Steps

1. Razorpay Dashboard, **Test Mode**: Account & Settings, API Keys, generate a key pair. Set
   `PAYMENT_PROVIDER=razorpay`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` on the **payments** service. Use
   `APP_MODE=sandbox` for test keys.
2. Payment capture: set automatic capture for the account (Settings, Payment Capture). If a payment stays
   `authorized`, payments captures it itself after `AUTHORIZED_CAPTURE_AFTER_SEC` (300 s), but automatic capture
   is the intended configuration.
3. Webhook: Account & Settings, Webhooks, Add New Webhook.
   - **URL:** `https://<your-api-host>/api/v1/webhooks/razorpay` (`PUBLIC_API_URL` + `/api/v1/webhooks/razorpay`;
     the gateway forwards it to payments byte-for-byte).
   - **Secret:** the same value as `RAZORPAY_WEBHOOK_SECRET`.
   - **Active events (subscribe to exactly these):** `payment.authorized`, `payment.captured`,
     `payment.failed`, `order.paid`, `refund.processed`, `refund.failed`. Other event types are accepted (200)
     and stored as `IGNORED_UNKNOWN`, so extra subscriptions are harmless but unnecessary.
4. Local testing needs a public tunnel to the gateway (for example `ngrok http 8080`) and
   `PUBLIC_API_URL`/webhook URL set to the tunnel. Razorpay cannot reach `localhost`.
5. Live mode: after activation, generate **Live Mode** keys, create a second webhook with the production URL
   and a new secret, rotate the three variables, set `APP_MODE=production`. Enable the payment methods you
   want (UPI, cards, netbanking, wallets) in the dashboard.

### How to verify (what "sandbox verified" means for the launch checklist)

- A test-mode checkout with a Razorpay test card/UPI reaches `PLACED` exactly once; the `payment_events`
  collection shows one `APPLIED` row per distinct event id and `IGNORED_DUPLICATE` for re-deliveries.
- Dashboard "Test webhook" or replay delivers a body with whitespace/ordering exactly as sent; the signature
  still verifies (the raw body is not re-serialized).
- A rejected child order produces a refund that goes `REQUESTED`, `PROCESSING`, `SUCCEEDED` after the
  `refund.processed` webhook.
- `POST /api/v1/payments/:intentId/verify` with a wrong signature returns 400 and never marks the intent paid.

### Operational notes

- Signature: HMAC-SHA256 of the raw body with the webhook secret in `X-Razorpay-Signature`, compared in
  constant time. Dedupe key: header `x-razorpay-event-id`, else a hash of the body.
- Every refund sends `X-Refund-Idempotency` (`thali_<refundId>_<seq>`) so a retried call cannot double-refund.
- The in-process "demo pay" page exists only while `PAYMENT_PROVIDER=mock` (never in production).
- API references used: Razorpay Orders, Payments (capture), Refunds (create, fetch, idempotency), Webhooks
  (validate, payload shapes) and Standard Checkout docs at https://razorpay.com/docs/ (see ADR-009).
- Settlement of money from Razorpay to your bank account, fees and GST on fees are Razorpay account matters
  and outside this codebase.

---

## 2. Twilio (SMS) and India DLT registration

Adapter behaviour: `POST https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json` with `To`, `Body`,
`From` or `MessagingServiceSid`, and `StatusCallback`; delivery receipts arrive at
`POST /api/v1/webhooks/twilio/status` and are verified with `X-Twilio-Signature` (HMAC-SHA1 over the exact
callback URL plus the sorted form parameters, keyed with the auth token). SMS is sent for the OTP and for
`order_placed_customer`, `order_placed_restaurant` and `order_rejected` (always, as transactional), and for
other order updates only if the user's preference allows it.

### What you need

| Item | Where it goes |
|---|---|
| Account SID | `TWILIO_ACCOUNT_SID` |
| Auth Token (also the webhook signature key) | `TWILIO_AUTH_TOKEN` (secret) |
| Sender: an E.164 number or alphanumeric sender registered for India | `TWILIO_FROM` |
| or a Messaging Service SID (takes precedence over `From`) | `TWILIO_MESSAGING_SERVICE_SID` |
| The exact public callback URL | `TWILIO_STATUS_CALLBACK_URL` (default `<PUBLIC_API_URL>/api/v1/webhooks/twilio/status`) |
| **India DLT registration** (below) | Telecom and Twilio consoles, done by the business |

The status callback URL must be the exact URL Twilio calls (scheme, host, path), because it is part of the
signed string. If neither `TWILIO_STATUS_CALLBACK_URL` nor `PUBLIC_API_URL` is set while an auth token is, all
callbacks are rejected with 403 and an error is logged.

### India DLT registration (a launch prerequisite)

Indian telecom regulation (TRAI) requires commercial SMS to use registered entities, headers and templates on
a Distributed Ledger Technology (DLT) platform. Unregistered traffic is blocked by operators. Required steps
(confirm the current process in the Twilio console under Regulatory Compliance, India, and your chosen
operator portal such as Jio, Airtel, Vi or BSNL DLT):

1. Register the **Principal Entity** on a DLT portal with business KYC documents; obtain the **PE ID**.
2. Register the **sender ID / header** (a six-letter alphanumeric, for example `THALIX`), transactional
   (service-implicit) category.
3. Register every **content template** exactly as sent, with variables as `{#var#}`, and obtain the
   **Template IDs**. The texts that Thali sends are defined in
   `services/notifications/src/domain/templates.ts` (OTP: "`<code>` is your Thali verification code. Do not
   share it with anyone."; order placed, order rejected, and so on). If you change wording, re-register it.
4. In the Twilio console, submit your PE ID, header and template IDs (Messaging, Regulatory Compliance, India)
   and attach the approved sender to a Messaging Service if you use one.
5. Test with a small batch before cutover; check delivery receipts in Twilio and in the admin notifications
   list (`GET /api/v1/admin/notifications?status=DEAD`).

Status: the adapter sends the rendered text as `Body` and does not pass DLT template ids itself; whether Twilio
needs them per request or resolves them from the console registration must be confirmed during the DLT
onboarding. This is part of "live verification pending".

### How to verify

- OTP login with a real Indian number arrives within seconds; the notification row is `SENT`, then `DELIVERED`
  after the callback; the row and the logs contain neither the code nor the number.
- A callback with a wrong signature returns 403 and changes nothing.
- Failure behaviour: retryable errors are retried with 30 s, 60 s, 120 s, 240 s, 480 s backoff then `DEAD`
  (admin can retry); permanent 4xx errors go `DEAD` at once; an undelivered/failed receipt marks the row `DEAD`
  and is never resent automatically (the provider accepted it). OTP sends are synchronous, never retried, and
  return 503 `OTP_DELIVERY_FAILED` when the provider fails.

---

## 3. Resend (email)

Adapter behaviour: `POST https://api.resend.com/emails` with a Bearer key and an `Idempotency-Key` equal to the
notification `dedupeKey`; webhooks are Svix-signed. Emails sent: restaurant business-email verification,
restaurant status changes, and order updates per template. Delivery events handled: `email.sent`,
`email.delivered`, `email.bounced`, `email.failed`, `email.suppressed`.

### What you need

| Item | Where it goes |
|---|---|
| API key (`re_...`, "Sending access" scope is enough) | `RESEND_API_KEY` (secret) |
| A verified sending domain | Resend Dashboard, Domains |
| Sender address on that domain | `EMAIL_FROM` (for example `Thali <no-reply@mail.example.com>`) |
| Webhook signing secret (`whsec_...`) | `RESEND_WEBHOOK_SECRET` (secret) |

### Steps

1. Resend Dashboard, Domains, Add Domain (use a sub-domain such as `mail.<your-domain>`). Add the DNS records it
   shows: **SPF** (a TXT on the sending/return-path sub-domain), **DKIM** (a TXT/CNAME with the public key) and
   optionally **DMARC** (`_dmarc` TXT, start with `p=none`). Wait until the domain shows Verified.
2. Create an API key; set `EMAIL_PROVIDER=resend`, `RESEND_API_KEY`, `EMAIL_FROM`.
3. Webhooks, Add Endpoint: URL `https://<your-api-host>/api/v1/webhooks/resend`; events `email.sent`,
   `email.delivered`, `email.bounced`, `email.failed`, `email.suppressed` (`email.delivery_delayed` and others
   are accepted and ignored). Copy the signing secret to `RESEND_WEBHOOK_SECRET`. Without the secret the route
   answers 404.
4. Production refuses `EMAIL_PROVIDER=mailpit` and `mock`.

### How to verify

- Submit a restaurant with a real inbox; the verification email arrives from `EMAIL_FROM`, passes SPF/DKIM
  (check the message headers), and the link in it completes verification.
- A webhook with a wrong signature or a timestamp older than 5 minutes returns 401; a replay is idempotent;
  a bounce marks the notification `DEAD`.
- Retries reuse the `Idempotency-Key`, so a retried send does not produce a duplicate email (24 h window).

---

## 4. Google Maps Platform (ETA, distance, geocoding)

Adapter behaviour: distance and ETA through the **Routes API**
(`POST https://routes.googleapis.com/directions/v2:computeRoutes`, field mask
`routes.duration,routes.distanceMeters`, default travel mode `TWO_WHEELER`); geocoding through the
**Geocoding API** (`GET https://maps.googleapis.com/maps/api/geocode/json`, region bias `in`). The key is used
only server-side, by marketplace (delivery fee, ETA, deliverability) and delivery (job distance, ETA).
On any Google failure (5 s timeout, HTTP error, no route) the adapter records a provider error (visible in the
admin health page) and falls back to a haversine estimate labelled `HAVERSINE_FALLBACK` in production
(`DEMO_HAVERSINE` in demo/sandbox), never `GOOGLE`.

### What you need

| Item | Where it goes |
|---|---|
| A Google Cloud project with **billing enabled** | Google Cloud Console |
| **Routes API** enabled | APIs & Services, Library |
| **Geocoding API** enabled | APIs & Services, Library |
| **Places API (New)** enabled (2026-10-11, address search) | APIs & Services, Library; marketplace calls `places:autocomplete` and place details (field mask `id,formattedAddress,location,addressComponents`) |
| An API key | `GOOGLE_MAPS_API_KEY` (secret) on **marketplace** and **delivery**, with `GEO_PROVIDER=google` |

### Key restrictions (do this before production)

- **API restrictions:** restrict the key to *Routes API*, *Geocoding API* and *Places API (New)* only.
- **Application restrictions:** *IP addresses*: the NAT/egress addresses of the marketplace and delivery tasks.
  Do not use HTTP-referrer restrictions (the key is never sent to browsers).
- Never ship this key in the SPA. Set a quota cap and a budget alert; rotate it if it ever appears in a log.
- The map the customer sees is Leaflet with OpenStreetMap tiles (`https://{s}.tile.openstreetmap.org`). The
  public OSM tile servers have a usage policy that does not allow heavy production traffic: put a tile
  provider (or your own tile cache) before launch by changing `OSM_TILE_URL` (and the attribution) in `apps/web/src/components/ui/Map.tsx`; it is a build-time constant, not an environment variable.

Status note (updated 2026-10-11): address search now calls Google when `GEO_PROVIDER=google`. Marketplace
`GET /discovery/places` uses Places autocomplete (India only, location-biased, with a session token),
`GET /discovery/places/:placeId` uses Place Details, and `GET /discovery/reverse` uses Geocoding reverse. Google
results are cached for 24 h and Google failures fall back to the seeded gazetteer (labelled `FALLBACK` in
production, `DEMO_GAZETTEER` in demo) and are recorded as a failing `maps` provider on the health page. A malformed
place id answers 404 and does not count as a provider error. All of this is unverified against live Google until
a key is available.

### How to verify

- With `GEO_PROVIDER=google`, restaurant discovery and `delivery_jobs.estimateSource` show `GOOGLE`.
- Revoke the key briefly: discovery keeps working with `HAVERSINE_FALLBACK` labels and the admin health page
  shows provider errors for `google-routes`.

---

## 5. S3 (object storage)

Two buckets: a **public** one for images (restaurant covers, logos, menu photos, anonymous read) and a
**private** one for KYC documents (restaurant and partner documents; presigned access only, 5-minute admin
URLs). Uploads use presigned PUT URLs with a signed content type and content length; after upload the service
verifies size and magic bytes (HEAD plus a range GET) before attaching the file.

### What you need

| Item | Where it goes |
|---|---|
| Two buckets (names) | `S3_PUBLIC_BUCKET`, `S3_PRIVATE_BUCKET` |
| Region | `S3_REGION` (for example `ap-south-1`) |
| Credentials: prefer an **IAM role** on the task (omit both keys) | otherwise `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` |
| Leave empty on AWS | `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT` (set only for MinIO or another S3-compatible store) |
| Public base URL of the public bucket (CloudFront or the bucket URL) | `S3_PUBLIC_BASE_URL` |

Set the storage variables on **marketplace** and **delivery** (the two services that use storage).

### Bucket configuration

1. **Private bucket:** Block all public access; default encryption (SSE-S3 or SSE-KMS); versioning on;
   a lifecycle rule for abandoned incomplete uploads.
2. **Public bucket:** serve through CloudFront with an origin access control and keep the bucket itself
   private, or allow public `GetObject` on the image prefix only. Set `S3_PUBLIC_BASE_URL` to the CDN origin.
3. **CORS** (both buckets, required for the browser's presigned PUT and for admins viewing a KYC document
   URL). Replace the origin with your web origin:

```json
[
  {
    "AllowedOrigins": ["https://app.example.com"],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3000
  }
]
```

4. **IAM policy** for the task role of marketplace and delivery (least privilege; the services never list
   buckets or change bucket settings):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
      "Resource": [
        "arn:aws:s3:::thali-public/*",
        "arn:aws:s3:::thali-private/*"
      ]
    }
  ]
}
```

`s3:GetObject` also covers the `HeadObject` and range reads used for post-upload verification. If you use
SSE-KMS add `kms:GenerateDataKey` and `kms:Decrypt` on the key.

### How to verify

- Upload a menu image from the restaurant area: the browser PUT succeeds (CORS), the image renders from
  `S3_PUBLIC_BASE_URL`.
- Upload a KYC document, view it from the admin approval screen: the URL expires in 5 minutes, and an
  anonymous request to the object key without a signature is denied.
- Uploading a file whose bytes do not match the declared type is rejected (422 `FILE_INVALID`).

### Local stand-in

Compose runs MinIO (`bitnamilegacy/minio`, dev only) with a `minio-init` job that creates both buckets, makes
the public one anonymously readable, and verifies the server-wide CORS setting. `S3_ENDPOINT` is what services
call inside the network, `S3_PUBLIC_ENDPOINT` is the host the browser calls for presigned URLs (ADR-019).

---

## Credentials checklist (what to request, from whom)

| Provider | Credentials and approvals to obtain |
|---|---|
| Razorpay | Test key pair now; **business activation (KYC, bank account)** for live keys; webhook created with the six events and a secret; payment methods enabled; settlement schedule agreed |
| Twilio | Account SID, Auth Token, a sender or Messaging Service; **DLT: Principal Entity, header and every template registered**; Twilio India regulatory bundle approved |
| Resend | API key; **domain verified (SPF, DKIM, ideally DMARC)**; webhook endpoint and signing secret |
| Google Maps | Billing-enabled project; Routes API and Geocoding API enabled; **restricted key** (API + IP); quota and budget alert |
| AWS S3 | Two buckets with block-public-access, encryption, CORS; IAM role/policy; CloudFront for the public bucket |
| Payouts | Nothing to configure; finance needs a bank-transfer process and an owner who records the UTR |
