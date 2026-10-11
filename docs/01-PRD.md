# PRD — "Thali" Food Delivery Platform (Pilot)

Status: Approved for build · Owner: Platform team · Date: 2026-10-10
Source brief: `context.md` (treated as the product brief; this PRD resolves its open choices).

## 1. Problem & goal

Build a working food-delivery marketplace for a pilot launch in India that connects
**consumers**, **restaurants / cloud kitchens**, **delivery partners**, and **administrators**.
The pilot must run real money flows through a payment provider sandbox, real OTP/email
through provider adapters, and real operational workflows — not a UI mock.

Success = all 12 completion flows in §9 run end to end on the documented local stack
(demo mode) and every provider adapter is either verified in sandbox or explicitly marked
"pending credentials" in the launch checklist.

## 2. Assumptions (decided, not open)

| Topic | Decision |
|---|---|
| Market / currency | India, INR. All money stored as integer **paise** (`*_paise` fields). |
| Time | Stored UTC (ISO-8601 / BSON Date). Displayed in `Asia/Kolkata` by default. |
| Service areas | Admin-configurable polygons (GeoJSON) with per-area delivery fee rules. No hardcoded cities. |
| "TMS" | Transport/delivery management (Delivery service). Customer support tickets are a separate module. |
| Scale target | Pilot: ~1 city, ≤ 200 restaurants, ≤ 500 partners, ≤ 5k orders/day. Horizontal path documented. |
| Brand name | "Thali" (placeholder, changeable via config). |
| Taxes | Configurable GST rates: food 5% (500 bps), fees 18% (1800 bps). Not tax advice — finance must confirm before launch. |
| Payments | Razorpay (Orders API + Standard Checkout + webhooks + Refunds API). |
| SMS | Twilio Programmable Messaging (India DLT registration is a launch prerequisite). |
| Email | Resend (REST API + signed webhooks). |
| Maps | Display: Leaflet + OpenStreetMap tiles. Geocoding/ETA: Google Maps Platform adapter; demo uses labeled haversine estimator. |
| Storage | S3-compatible (AWS S3 in prod; MinIO locally) via presigned URLs. |
| Payouts | **Recorded after verified manual bank settlement** (admin enters UTR). No automated disbursement in pilot. |
| Membership | Prepaid plans only (no auto-renew in pilot). |

## 3. Personas & jobs-to-be-done

1. **Consumer (Priya)** — "Show me what can actually be delivered to my address, let me mix
   biryani from one place and dessert from another, pay once, and track both."
2. **Restaurant owner (Ravi)** — "Get my kitchen listed, keep my menu/stock right, accept orders
   quickly, and see exactly what I'll be paid."
3. **Delivery partner (Arjun)** — "Go online, take offers that make sense on my route, prove
   pickup/drop, and see my earnings and payouts."
4. **Admin / Ops (Meera)** — "Approve the right businesses and riders, fix stuck orders, handle
   refunds and tickets, and know the system is actually healthy."

## 4. Scope — functional requirements

IDs are referenced from the HLD/LLD and tests.

### 4.1 Consumer
- **C-1 Guest discovery**: browse without login; pick location via browser geolocation or map
  pin / saved address.
- **C-2 Deliverability** *(amended 2026-10-11, ADR-034)*: list only restaurants that are APPROVED, inside an
  active service area that contains the drop point, and within the restaurant's delivery radius. A paused
  restaurant is **still listed**, shown as "Not accepting orders" (it cannot be ordered from: quote and
  checkout reject it with `RESTAURANT_CLOSED`); restaurants outside their opening hours are listed with their
  next opening time. Accepting restaurants sort first. Show open/closed state, ETA (labeled "estimate"; "demo
  estimate" in demo mode), delivery fee.
- **C-3 Search & filter**: text search over restaurants and items; filters veg-only, cuisine,
  price band, open-now; sort by distance, delivery fee, ETA, rating (rating sort only when the
  restaurant has ≥ 5 real ratings; otherwise "New").
- **C-4 Restaurant page**: categories, items, veg/non-veg marker, price, availability,
  customization groups (single/multi select with min/max) and add-ons.
- **C-5 Phone OTP auth**: E.164 normalization (default region IN), OTP 6 digits, 5-min expiry,
  30 s resend cooldown, ≤ 5 sends/phone/hour, ≤ 5 verify attempts per OTP, single use.
- **C-6 Guest cart preservation**: guest cart is server-side keyed by an opaque guest token;
  merged into user cart on login.
- **C-7 Profile**: name, email (optional), saved addresses with default, notification prefs,
  sign out (revokes session), sign out everywhere.
- **C-8 Multi-restaurant cart**: items from many restaurants, grouped per restaurant;
  customizations; quantity; remove; per-restaurant subtotal and fees.
- **C-9 Checkout**: server re-validates prices, stock, open status, coupon, membership,
  serviceability right before payment; shows full price breakdown per restaurant and in total;
  idempotent submit; hosted payment (Razorpay Checkout; demo: labeled demo payment page).
- **C-10 Order tracking**: per-restaurant child orders with independent status and delivery
  tracking (live partner location with last-updated time and stale indicator).
- **C-11 Cancellation**: customer may cancel a child order while it is PLACED (not yet
  accepted) → full child refund. Later cancellation via support ticket.
- **C-12 Order history & reorder**: reorder re-runs price/stock/serviceability checks and
  reports what changed.
- **C-13 Membership**: view plans and terms, buy (prepaid), view status/expiry/history; benefits
  enforced server-side.
- **C-14 Support**: raise ticket against an order; view ticket thread.

### 4.2 Restaurant
- **R-1 Onboarding**: business name, restaurant name, owner contact, business email, phone,
  address + coordinates, cuisines, description, hours, images, documents (FSSAI, GST, PAN —
  configurable), settlement bank details (encrypted at rest, masked on read).
- **R-2 States**: `DRAFT → VERIFICATION_PENDING → APPROVAL_PENDING → APPROVED`, plus
  `REJECTED` (reason, can resubmit → APPROVAL_PENDING) and `SUSPENDED` (reason, admin can
  reinstate). Email verification and admin approval are separate gates.
- **R-3 Menu**: categories, items, price, veg flag, images, customization groups, add-ons,
  availability toggle, optional tracked stock.
- **R-4 Store controls**: weekly hours (Asia/Kolkata), temporary pause (until time).
- **R-5 Orders**: real-time incoming orders, accept / reject (reason required), prep-time
  update, mark ready. Acceptance window default 5 min → auto-reject with reason
  `RESTAURANT_TIMEOUT` and refund.
- **R-6 Dashboard**: today's orders, acceptance rate, revenue — computed from stored records.
- **R-7 Finance**: earnings ledger (gross, commission, refunds, adjustments), balance, payouts.
- **R-8 Isolation**: an owner sees only their restaurants, orders, and financials.

### 4.3 Delivery partner
- **D-1 Onboarding**: phone OTP, profile, vehicle (type, registration), documents (ID, licence),
  admin approval; states `DRAFT → APPROVAL_PENDING → APPROVED | REJECTED | SUSPENDED`.
  Demo mode may auto-flag documents as "demo-verified" — never auto-approve outside demo.
- **D-2 Availability**: online/offline toggle; location permission prompt; location pings.
- **D-3 Offers**: time-limited offers (default 45 s); accept/reject; atomic — exactly one
  partner wins.
- **D-4 Batching**: second concurrent delivery only if it passes the explainable batching
  policy (LLD §7). UI shows why an offer is batch-eligible.
- **D-5 Execution**: pickup info + navigation link; confirm pickup (restaurant shows a pickup
  code); start delivery; confirm drop via 4-digit customer delivery code; mark failed with
  reason (customer unreachable, etc.).
- **D-6 History, earnings, payouts** (recorded settlements).

### 4.4 Admin
- **A-1 Auth**: email + password (argon2id), mandatory TOTP MFA for all admin endpoints,
  admins created only via CLI bootstrap or by an existing super-admin.
- **A-2 Overview**: live metrics from stored records (orders today by state, GMV, active
  partners, pending approvals).
- **A-3 Approvals**: restaurants and partners — approve, reject (reason), suspend (reason),
  reinstate; view documents via short-lived signed URLs.
- **A-4 Users & roles**: search users, view roles, block/unblock.
- **A-5 Orders**: search by id/phone/restaurant/status; full timeline; cancel with refund.
- **A-6 TMS**: unassigned/stuck deliveries, manual assign/reassign, mark exceptions.
- **A-7 Catalog config**: coupons, banners, categories (cuisines), membership plans,
  service areas, fee rules.
- **A-8 Support tickets**: queue, assign, reply, resolve.
- **A-9 Finance**: refunds (review, retry failed, manual refund within captured amount),
  restaurant/partner balances, record payout settlement (UTR).
- **A-10 Audit log**: every privileged action recorded (actor, action, target, before/after
  summary, IP, correlation id).
- **A-11 Health**: per-service readiness, Mongo/Redis connectivity, outbox/stream backlog,
  dead-lettered events, failed notifications, provider error counts — all measured live.

### 4.4a Redesign capabilities (2026-10-11)
The UI redesign (Masala design system, boards 00 to 40 of the Claude Design export) adds these capabilities on
top of the requirements above; the matching decisions are ADR-034 to ADR-041 and the contracts are LLD 10.1.
- **C-15 Address search**: the landing page and the location picker search addresses as you type
  (Google Places when configured, otherwise a seeded Bengaluru gazetteer in demo), resolve a place or the
  device location (reverse geocode) to a locality and pincode, and say "We don't deliver here yet" when the
  point is not serviceable. Saved addresses carry a locality.
- **C-16 Discovery at city scale**: counts ("N open now, M deliver here") and cuisine facets that stay stable
  across pages, explicit pure-veg restaurants, "New" until 5 ratings, an offers page that guests can read,
  restaurant-scoped offers with a card badge, a "Recommended" menu section, "sold out today / only N left"
  reasons on items.
- **C-17 Per-restaurant checkout**: pay for one restaurant's lines from a multi-restaurant cart and keep the
  rest in the cart; paying for overlapping selections can never charge the same restaurant twice (ADR-037).
- **C-18 Order tracking detail**: restaurant point on the map, live remaining ETA from the rider position,
  "rider at restaurant", refund progress per restaurant, "have I rated this" state.
- **C-19 Avatars**: customers can upload a profile picture (own uploads only).
- **R-9 Pure-veg and featured items**: owners declare a restaurant pure veg (non-veg items are then rejected)
  and pick up to 6 recommended items; the live-orders board shows customer, items, options and rider name.
- **D-7 Call from the delivery**: the assigned partner can call the restaurant or the customer from the job
  (demo: simulated and masked). Before pickup a partner sees only the drop area and label, never the full
  address, coordinates or phone (ADR-038); offers show only the area and a coarse distance.
- **A-12 Password reset**: an admin can reset a forgotten password through an emailed link, a TOTP code and a
  new password; all sessions are revoked (ADR-039).
- **A-13 Bulk operations**: retry all failed or dead notifications and replay all dead letters from the admin
  overview and health page (audited, bounded, runbook 14.5); order search by checkout, child code or phone;
  assign picker ranks partners by distance to the pickup.
- **A-11 Health (amended)**: each service explains its state in words; a failing provider is "degraded", not
  "down" (ADR-040).
- **UX-1 Theme**: light, dark and system themes on every screen, self-hosted fonts, honest-data labels
  retained (ADR-041).
- **Data-1 Demo marketplace**: a deterministic Bengaluru dataset (about 600 restaurants, 1,000 consumers,
  250 partners, thousands of historical orders) with CC-licensed photos credited in
  `scripts/seed-data/CREDITS.md` (ADR-035, ADR-036). Demo mode only.

### 4.5 Multi-restaurant ordering (mandatory)
- **M-1** One **CheckoutGroup** (parent) per purchase; one **ChildOrder** per restaurant; one
  **DeliveryJob** per child order; one **Payment** per CheckoutGroup; refunds per child order.
- **M-2** Deterministic allocation of group-level discounts across children (largest-remainder,
  LLD §6) so Σchildren == group total to the paisa.
- **M-3** Independent accept/reject; rejection triggers that child's refund only.
- **M-4** Parent status derived from children.
- **M-5** Edge cases handled: restaurant closes mid-checkout, price change, last-item race,
  payment captured while orders service down, duplicate submissions, customer leaves payment
  page, one delivery fails while the other succeeds.

## 5. Non-functional requirements
- **Security**: RBAC + resource ownership on every endpoint; argon2id; short-lived access JWT
  (15 min, EdDSA) + rotating refresh token in httpOnly cookie; CSRF protection on cookie
  endpoints; Zod validation at every boundary; rate limits (OTP, login, search, checkout);
  log redaction; secrets only via env; internal endpoints require service tokens.
- **Reliability**: transactional outbox + idempotent inbox; bounded retries with backoff;
  dead-letter handling with admin replay; atomic stock/coupon/assignment controls; request
  timeouts; graceful shutdown; liveness/readiness; correlation IDs; recovery sweepers.
- **Performance (pilot)**: p95 discovery < 500 ms, checkout create < 1.5 s (excluding
  provider), SSE event latency < 2 s.
- **Accessibility**: WCAG 2.1 AA intent — labeled inputs, keyboard nav, focus states,
  aria-live for status changes.
- **Observability**: pino JSON logs, correlation id propagated through HTTP and events.

## 6. Modes
`APP_MODE=demo | sandbox | production`.
- **demo**: seeded data, mock providers (labeled), fixed OTP `123456` for seeded demo phones
  only, demo payment page, location simulator. Persistent "DEMO MODE" banner.
- **sandbox**: real providers with test credentials; no fixed OTP; "SANDBOX" banner.
- **production**: startup fails if any mock adapter, demo flag, or missing secret is configured.

## 7. Out of scope (pilot)
Native mobile apps; recurring membership billing; automated payouts; dynamic surge pricing;
ML ETA/dispatch optimization; scheduled orders; cash on delivery; ratings write-flow beyond a
simple post-delivery 1–5 rating (rating capture is in scope; display gated by ≥ 5 ratings);
multi-language UI; Kubernetes.

## 8. Metrics
Order conversion (checkout→PLACED), restaurant acceptance rate & latency, delivery assignment
latency, on-time %, refund rate, OTP delivery success rate, notification failure rate.

## 9. Completion criteria (acceptance)
1. Guest discovers restaurants serving a selected address.
2. Guest builds a multi-restaurant cart, signs in via OTP, cart preserved.
3. Checkout computes correct server-side totals and initiates payment.
4. Verified payment confirmation moves the correct child orders to PLACED, exactly once.
5. Each restaurant sees and manages only its own child order.
6. An approved partner accepts, picks up, and completes delivery.
7. Consumer sees accurate order + delivery progress.
8. Partial rejection → correct customer messaging, updated totals, refund workflow.
9. Business email verification + admin approval gate restaurant activation.
10. Unauthorized access and invalid transitions rejected.
11. All endpoints documented in OpenAPI.
12. Stack starts from README without undocumented fixes.
