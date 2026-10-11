# Thali UI redesign: backend gap analysis

Date: 2026-10-11 · Branch `feat/ui-redesign` · Read-only audit of the repository (nothing outside this file was changed).

**Inputs read:** all 13 screenshots in `design/screens/` (b00-0/1/2, board-00 to board-09), the visible text of all 10 `design/NN-*.html` boards,
`docs/ui-redesign-context.md`, `docs/03-LLD.md` §3/§10/§11, `docs/09-api.md`, the route modules, zod schemas, models and domain code of all seven services,
`services/gateway/src/routes-map.ts`, `packages/service-kit` (geo, storage, seed, health), `packages/contracts` (events, seed-demo), the seeds, and
`apps/web/src/features/*/api.ts`.

**Legend**

| Status | Meaning |
|---|---|
| `OK` | An existing endpoint returns the field today. The frontend only has to call it, format it, or derive it with no extra request |
| `PARTIAL` | The endpoint exists, but a field, filter, count or semantic the design needs is missing or wrong |
| `MISSING` | No backend can supply this today |
| `FE` | Purely presentational. No backend involved (see §4) |

Paths are written as seen through the gateway (`/api/v1/...`). The services register the same path (the gateway forwards without rewriting).
**Gap ids** (`MKT-n`, `ORD-n`, `DLV-n`, `PAY-n`, `NTF-n`, `IDN-n`, `GW-n`) point to the contracts in §2.

---

## 1. Element → API matrix, per board

### Board 00: Public landing (`00-public.html`, `b00-*.png`, `board-00.png`)

| Element | Backend source today (METHOD path · service · field) | Status | Gap |
|---|---|---|---|
| Demo-mode strip "DEMO MODE · no real money…" | `GET /api/v1/meta` · gateway · `mode` | OK | |
| "Bengaluru · pilot city", "Now delivering across Bengaluru" | none (static copy). `/meta` has no city | FE | GW-3 (P2, optional) |
| Light/Dark toggle | n/a | FE | |
| Header "Deliver to · Set your location" | browser-stored location. Saved addresses come from `GET /api/v1/me/addresses` · identity (`me.ts:44`) | OK | |
| Header search "Search for biryani, dosa or a restaurant" + `/` shortcut | `GET /api/v1/discovery/search?lat&lng&q` · marketplace (`routes/discovery.ts:56`). **Needs lat/lng**, so before a location is set the UI must ask for it first | PARTIAL (FE rule) | MKT-1 lets typed text become a location first |
| Header "Offers" link → Offers page | `GET /api/v1/coupons/available` · marketplace (`routes/coupons.ts:26`) is `requireAuth()`, so a guest gets 401 | PARTIAL | MKT-7 |
| Header "Sign in" | `POST /api/v1/auth/otp/request` and `/otp/verify` · identity | OK | |
| Header "Cart 0" | `GET /api/v1/cart` (guest `X-Guest-Cart`) · orders · `itemCount` | OK | |
| Hero address box "Enter your delivery address" | **no geocoding or autocomplete endpoint.** `GeoProvider.geocode` exists only on the Google adapter (`packages/service-kit/src/providers/geo.ts:34`, `google-geo.ts:12`) and no service calls it (grep: 0 uses). The demo geo adapter has none | MISSING | **MKT-1 (P0)** |
| "Use my location" | browser Geolocation API → lat/lng (FE). There is **no reverse geocode** to label the result ("12th Main, Indiranagar") | PARTIAL | MKT-1 (`/discovery/reverse`) |
| "Find food" | `GET /api/v1/discovery/serviceability?lat&lng` then `/discovery/restaurants`. Needs coordinates from the address text, so it is blocked without MKT-1 | PARTIAL | MKT-1 |
| "Only kitchens that deliver to you" / "Refunds per restaurant" ticks | static | FE | |
| Illustrative cart card (Spice Route / Green Leaf, ₹646.20, Pay once) | static marketing art, **not** live data (must not be mistaken for a real cart) | FE | |
| "What are you craving?" cuisine circles (image + name) | `GET /api/v1/cuisines` · marketplace (`restaurants-public.ts:92`) · `name, slug, imageUrl` | OK | |
| Cuisine counts (asked for in the brief; **not drawn** on any board) | no per-location count. `/cuisines` is global | MISSING (not in design) | MKT-11 (P2) |
| "See all restaurants →" | route to discover | FE | |
| "Pick your door" cards → Start browsing / Restaurant / Partner / Admin sign in | routes only | FE | |
| How-it-works and "No made-up numbers" cards (New vs ★4.3, 32 min ESTIMATE, UTR, Net after refund) | static explainer copy | FE | |
| "List your restaurant" / "See the console" / "Apply to ride" / "See the partner app" | routes to `/restaurant/onboarding` (`POST /api/v1/owner/restaurants`) and `/partner/onboarding` (`POST /api/v1/partner/profile`) | OK | |
| Footer links (Thali Plus, Your orders, Help, Refunds, Terms, Privacy) | routes. Terms, Privacy and Refunds are static pages | FE | |

### Board 01: Sign-in, 4 role tabs (`01-signin.html`, `board-01.png`)

| Element | Backend source | Status | Gap |
|---|---|---|---|
| Customer / Restaurant / Partner tabs: mobile + "Send code" | `POST /api/v1/auth/otp/request {phone}` · identity (`routes/auth.ts:35`) | OK | |
| Code entry, "Resend code in 0:30", "DEMO: 123456", "Verify & continue" | `POST /api/v1/auth/otp/verify {phone, code, guestCartToken?}` (`auth.ts:41`). Cooldown and limits from the 429 `Retry-After` header. The demo hint comes from `/meta.mode` | OK | |
| Admin tab: Work email + Password + Continue | `POST /api/v1/auth/admin/login` → `POST /auth/admin/mfa` (`admin-auth.ts:43,60`) | OK | |
| Admin "Forgot?" link | **no admin password-reset flow** (only login, mfa, mfa/setup, mfa/enable; `admin-auth.ts:43-77`) | MISSING | IDN-1 (P1) |
| Right-panel role copy, "Back to site", Terms/Privacy | static | FE | |
| "Cart kept on sign-in" promise | `guestCartToken` on verify → `guestCartMerged` | OK | |

### Board 02: Foundations (`02-foundations.html`, `board-02.png`)

Mostly tokens. Data-bearing samples:

| Element | Backend source | Status | Gap |
|---|---|---|---|
| Restaurant card "**20% OFF**" badge on the cover | there are **no restaurant-scoped offers**. Coupons are platform-wide (`models/coupon.ts`), and discovery returns no offer field (`routes/discovery.ts:21-40`) | MISSING | MKT-8 (P2: only on the foundations board, not on board 10) |
| Card "Biryani · Mughlai · ₹₹", "32 min EST. · 2.1 km · ₹29 delivery", "★ 4.3" | discovery item `cuisines, priceBand, etaMinutes+etaSource, distanceKm, deliveryFeePaise, rating` | OK | |
| Status pills (Placed, Preparing, On the way, Delivered, Awaiting payment, Rejected, Cancelled) | status enums | OK | |
| "Live · updated 3s ago" with polling fallback | SSE `/api/v1/realtime/ticket` + `/stream` · notifications | OK | |
| Deadline ring "4:32" ("drains to the server's acceptBy / expiresAt") | `acceptBy` (owner order), `expiresAt` (offer, checkout) | OK | |
| Multi-cart bar "2 carts · 3 items · 2 deliveries · Checkout ₹558" | `GET /api/v1/cart` · `restaurantCount, itemCount, subtotalPaise` | OK | |

### Board 10: Consumer discover + floating multi-cart bar (`10-discover-cart.html`, `board-03.png`)

| Element | Backend source | Status | Gap |
|---|---|---|---|
| Header address chip "Home · 12th Main, Indiranagar" | `GET /api/v1/me/addresses` · identity · `label, line1` (the locality is only free text inside `line1`) | OK (PARTIAL if a separate locality is wanted) | IDN-2 (P1) |
| "Orders" link | `GET /api/v1/orders` · orders | OK | |
| Notifications bell + unread dot | `GET /api/v1/notifications?limit=1` · notifications · `unreadCount` (`routes/notifications.ts:28-35`) | OK | |
| Theme toggle | n/a | FE | |
| Avatar "P" | `GET /api/v1/me` · `name` → initial. There is no avatar image field, and the design uses an initial only | OK | IDN-3 (P2) |
| Cuisine carousel (All, Biryani, …, Rolls, Chai & Snacks) + arrows | `GET /api/v1/cuisines` · `imageUrl` (seed must supply images) | OK | |
| Cuisine filter | `GET /api/v1/discovery/restaurants?cuisine=<slug,…>` | OK | |
| "Delivering to **Home**" | label of the chosen saved address | OK | |
| "**4 open now · 6 restaurants deliver here**" | the response is one page `{items, nextCursor, serviceable, serviceArea}` with **no totals** (`discovery.ts:215-228`) | PARTIAL | MKT-2 (P1) |
| "EST. times are demo estimates" | `etaSource === 'DEMO_HAVERSINE'` | OK | |
| Preferences: **Veg only** | `veg=true` → `isVeg === 'PURE_VEG'`. It is **derived from currently-available menu items** (`discovery.ts:100-108` matches `available: true`), so a mixed restaurant whose non-veg dishes are toggled off is wrongly shown as "Pure veg" | PARTIAL (correctness) | MKT-4 (P1) |
| Preferences: **Open now** | `openNow=true` | OK | |
| Price ₹ / ₹₹ / ₹₹₹ | `priceBand=1,2,3` (band from average item price, `discovery.ts:36-40`) | OK | MKT-13 (denormalise for scale) |
| Sort by Distance / Delivery fee / Delivery time / Rating | `sort=distance|deliveryFee|eta|rating` (`discovery.ts:16`) | OK | |
| Card cover image | `imageUrl` from `images.cover` via `storage.publicUrl` (`discovery.ts:189`). Null → placeholder art | OK | MKT-10 (external URLs for seed) |
| Card "Pure veg" badge (veg shape mark) | `isVeg === 'PURE_VEG'` (same bug as Veg only) | PARTIAL | MKT-4 |
| Card "**Opens at 6:00 PM**" + "Closed now" | `open=false`, `nextOpenAt` | OK | |
| Card "**Not accepting orders**" (Kettle & Bun, paused) | **paused restaurants are dropped from discovery** (`discovery.ts:120`), and items carry no `closedReason` | MISSING | MKT-3 (P1) |
| Card rating "★ 4.3 (126)" / "New" | `rating {average,count}` or null when <5 (`restaurant-view.ts:12-16`) | OK | |
| Card "Biryani · Mughlai · ₹₹" | `cuisines`, `priceBand` | OK | |
| Card "32 min est. · 2.1 km · ₹29 delivery" | `etaMinutes`, `etaSource`, `distanceKm`, `deliveryFeePaise` | OK | |
| Empty state "Clear filters" | `items: []`, `serviceable` | OK | |
| Floating dock: "SR/GL" chips, "2 carts · 3 items", per-restaurant pill "Spice Route · ₹378" | `GET /api/v1/cart` · `groups[].restaurantName, subtotalPaise, itemCount` | OK | |
| Expanded dock: per cart "DELIVERY 1 · {eta}" | the cart has no ETA. `POST /api/v1/cart/preview` has per-child `etaMinutes` (`schemas.ts:120-124`) but is **auth-only**. Guests can only reuse the ETA from cached discovery results | PARTIAL | ORD-8 (P2) |
| Dock line qty − / + | `PATCH /api/v1/cart/items/:lineId`, `DELETE …` | OK | |
| "**Checkout only {Spice Route} →**" | `POST /api/v1/checkouts` always takes the **whole cart** (`packages/contracts/src/schemas/order.ts:25-36`: no restaurant subset) | MISSING | ORD-3 (P1) |
| "Checkout · ₹558" | route to checkout | OK | |
| Toast "Added Double ka Meetha to Spice Route" | `POST /api/v1/cart/items` response | OK | |

### Board 11: Restaurant menu + item customiser (`11-restaurant.html`, `board-04.png`)

| Element | Backend source | Status | Gap |
|---|---|---|---|
| Breadcrumb "Restaurants / Spice Route", "Cart · 3" | route + cart `itemCount` | OK | |
| Logo tile | `GET /api/v1/restaurants/:idOrSlug?lat&lng` · marketplace · `restaurant.logoUrl` (`discovery.ts:283`) | OK | |
| Name, "Biryani · Mughlai" | `restaurant.name, cuisines` | OK | |
| "· **Indiranagar** ·" locality | there is **no locality field**: `address {line1,line2,city,pincode}` (`models/restaurant.ts:31-33`) | PARTIAL | MKT-5 (P1) |
| "Open till 11:30 PM" | `open`, `hours[]`, `timezone`. The closing time of the current slot can be derived on the client. There is no `closesAt` | OK (FE derive) | MKT-12 (P2) |
| Rating ★ 4.3 (126) | `restaurant.rating` | OK | |
| Delivery "32 min EST.", Distance 2.1 km, Fee ₹29 | `delivery.etaMinutes, etaSource, distanceKm, deliveryFeePaise` (only when lat/lng are passed) | OK | |
| Not-deliverable notice | `delivery.deliverable=false, reason` | OK | |
| Menu nav with counts (Recommended 4, Biryani 6, …) | `menu[]` categories + item counts (client count) | OK | |
| "**Recommended**" section (same dishes as other categories) | no featured or bestseller flag. An item belongs to one category only (`models/menu-item.ts:21`) | MISSING | MKT-9 (P2) |
| Item name, description, veg mark | `PublicMenuItem.name, description, isVeg` | OK | |
| Item image (thumb on the right) | `imageUrl` from `imageKey` (`discovery.ts:68`) | OK | MKT-10 |
| "**from ₹249**" | `pricePaise` + the cheapest option of each required group (`minSelect>0`) → client computation | OK (FE derive) | |
| "In cart · 1" | cart lines by `itemId` | OK | |
| "**Sold out today**" + "Unavailable" button | only `available:boolean` (false = toggled off **or** stock exhausted, `discovery.ts:59,69`). It cannot say *sold out* versus *unavailable* | PARTIAL | MKT-6 (P1) |
| Customiser "Choose size · REQUIRED · PICK 1", Half ₹249 / Full ₹399 | `customizationGroups[{name,minSelect,maxSelect,options[{name,pricePaise,isVeg,available}]}]`. Absolute option prices = base + option (FE) | OK | |
| "Add-ons · **1 of 3**" | `maxSelect` + current selection count | OK | |
| "Extra leg piece · **Unavailable**" | `options[].available=false` | OK | |
| Qty stepper, "Choose a size" / "Add · ₹279" live total | client price preview. The server re-prices on `POST /cart/items` | OK | |

### Board 12: Checkout (`12-checkout.html`, `board-05.png`)

| Element | Backend source | Status | Gap |
|---|---|---|---|
| "Secure checkout", back, theme | static | FE | |
| Address cards Home (DEFAULT) / Work | `GET /api/v1/me/addresses` · `label, line1, line2, landmark, isDefault` | OK | |
| "+ Add new address" | `POST /api/v1/me/addresses` (map pin + fields). With MKT-1 it gains autocomplete | OK | MKT-1 (nice to have here) |
| Coupon "WELCOME45 · Applied −₹45.00, split across both restaurants" · Remove | `PUT /api/v1/cart/coupon` + `POST /api/v1/cart/preview` → per-child `breakdown.couponDiscountPaise` | OK | |
| "Use Thali Plus benefits" toggle | `useMembership` on preview/checkout | OK | |
| "**3 of 5** free deliveries left this month" | `GET /api/v1/memberships/me` · `freeDeliveriesRemaining` (`domain/memberships.ts:72`) and `planSnapshot.benefits.freeDeliveriesPerPeriod`. The quota is **per membership term**, not per calendar month, so the copy must say "this plan period" unless `durationDays≈30` | OK (copy) | |
| "Recalculating totals with the server…" | preview in flight | OK | |
| Review items: "Chicken Dum Biryani · Half, Extra raita ₹279" | preview `children[].lines[].addOns[].name` | OK | |
| "DELIVERY 1 · ~32 MIN EST." | preview `children[].etaMinutes, etaSource` | OK | |
| "Edit cart" | route | FE | |
| Bill per restaurant: Items, Coupon share, Packaging, Delivery fee, Platform fee, GST on food, GST on fees, total; "2 DELIVERIES" | preview `children[].breakdown` (`Breakdown` paise fields) | OK | |
| "To pay ₹646.20", "Pay ₹646.20" | `POST /api/v1/checkouts` (Idempotency-Key, `expectedTotalPaise`) → payment (Razorpay / demo-pay) | OK | |
| "If a price changes … old vs new" | 422 `PRICE_CHANGED` with details | OK | |

### Board 13: Order tracking (`13-tracking.html`, `board-06.png`)

| Element | Backend source | Status | Gap |
|---|---|---|---|
| Nav Restaurants / Orders / Thali Plus / Support | routes | FE | |
| "TH-DEMOMULTI · In progress" | `GET /api/v1/orders/:checkoutId` · orders · `checkout.code, status` | OK | |
| "Placed today, 7:42 PM · 2 restaurants · Home, Indiranagar" | `checkout.placedAt`, `children.length`, `deliveryAddress.label/line1` | OK | |
| "Live · updated 3s ago" | SSE `order.updated` / `delivery.location` + last-received timestamp | OK | |
| "DELIVERY 1 · SPICE ROUTE", "Out for delivery" pill | `children[].restaurantName, status / deliveryStatus` | OK | |
| "On the way — **about 9 min**" | `GET /api/v1/deliveries/tracking/:childOrderId` · delivery · `estimatedMinutes` is the **static job estimate** (restaurant→drop at job creation, `domain/tracking.ts:91`). There is no remaining ETA from the rider's position | PARTIAL | **DLV-3 (P0)** |
| "Arrival time is a demo estimate" | `estimateSource` | OK | |
| Map: rider marker + "SIMULATED LOCATION" | tracking `location, simulated` | OK | |
| Map: drop pin | `checkout.deliveryAddress.location` (`domain/cart.ts:365-377`) | OK | |
| Map: origin dot (restaurant) | `restaurantLocation` is stored on the child but **not exposed** to the customer (`order-views.ts:88-101`) | PARTIAL | ORD-4 (P1) |
| Map: dashed route | no route geometry (a straight or approximate line is acceptable) | FE (route = DLV-9 P2) | |
| Timeline Placed 7:42 · Accepted 7:44 · Preparing 7:45 · Ready 8:02 · Picked up 8:06 · On the way now · Delivered — | `children[].statusHistory[{to,at}]` (PICKED_UP and OUT_FOR_DELIVERY are mirrored from delivery events, `events/delivery-handlers.ts:49-52`) | OK | |
| "R · Ravi · Scooter" | `children[].partner {name(first), vehicleType}` or tracking `partner {firstName, vehicleType}` | OK | |
| "Location updated 3s ago" (+ stale warning) | tracking `lastLocationAt, stale` | OK | |
| Delivery code 4 7 1 9, "Tell Ravi at the door" | `children[].deliveryCode` | OK | |
| DELIVERY 2 "Couldn't be prepared · Rejected by restaurant" | child `status=REJECTED` | OK | |
| "Green Leaf declined your order (Out of stock). ₹218.10 refund initiated." | `explanations[{childOrderId, message, reason, refundPaise}]` (`derive.ts`) | OK | |
| "Your Spice Route order isn't affected…" | derived copy (other child still active) | FE | |
| Refund ₹218.10 stepper **Initiated → Processing → Refunded** | child `refundStatus` REQUESTED / PROCESSING / SUCCEEDED (FAILED → "Refund failed") + `refundRequestedPaise`, `refundedPaise` | OK | |
| Struck-through "1 × Ghee Podi Masala Dosa · ₹180" | child `lines` | OK | |
| Payment card Paid / Refunded / Refund pending / Net paid / Net after pending refund | `adjustedTotals {paidPaise, refundedPaise, refundPendingPaise, netPaise}` | OK | |
| "Delivering to Home, #402 … near CMH Rd" | `deliveryAddress` (label, line1, line2, landmark, city, pincode) | OK | |
| "Get help" | `POST /api/v1/support/tickets {childOrderId?/checkoutGroupId, category, subject, message}` · orders | OK | |
| "Reorder" | `POST /api/v1/orders/:checkoutId/reorder` | OK | |
| "You can rate Spice Route once it's delivered" (+ later the Rate action / "You rated") | `POST /api/v1/restaurants/:id/ratings` exists. There is **no read** of "already rated" (the UI only learns it from a 409) | PARTIAL | MKT-14 (P2) |
| Cancel (hidden unless allowed) | `canCancel` + `POST /api/v1/orders/child/:childId/cancel` | OK | |

### Board 20: Restaurant owner live orders (`20-owner-live.html`, `board-07.png`)

| Element | Backend source | Status | Gap |
|---|---|---|---|
| Restaurant switcher "SR · Spice Route · **Indiranagar**" (multiple per owner) | `GET /api/v1/owner/restaurants` · marketplace (`owner-restaurants.ts:83`) returns all the owner's restaurants. **Locality missing** | OK / PARTIAL (locality) | MKT-5 |
| Sidebar Dashboard / Live orders **1** / Order history / Menu / Store settings / Finance | badge = count of `GET /api/v1/owner/orders?restaurantId&status=PLACED` | OK | |
| Footer "A · Arjun M. · Owner" | `GET /api/v1/me` `name, roles` | OK | |
| Status banner (draft, verification, paused, …) | owner restaurant `status, statusReason, pausedUntil, emailVerified` | OK | |
| "Open · accepting" | `GET /api/v1/owner/restaurants/:id/dashboard` · `open, closedReason` (`domain/dashboard.ts:47-55`) | OK | |
| "Live" indicator | SSE `owner.order` | OK | |
| "Chime on" | browser audio after a user gesture | FE | |
| "**Pause orders**" (and Resume) | `POST /api/v1/owner/restaurants/:id/pause {minutes}` / `resume` (`owner-restaurants.ts:119,123`) | OK | |
| KPI "Orders today 18", "Acceptance 94%", "Avg. time to accept 1m 12s", "Revenue gross / net ₹9,842 / ₹8,151" | `GET /api/v1/owner/orders/stats?restaurantId&from&to` · orders (`owner-orders.ts:56`, `domain/stats.ts:32-71`: `ordersTotal, acceptanceRate, avgAcceptSeconds, grossPaise, netRevenuePaise`) or the dashboard (embeds stats) | OK | (index: §5) |
| Columns New 1 / Preparing 2 / Ready for pickup 1 | `GET /api/v1/owner/orders?restaurantId&status=PLACED,ACCEPTED,PREPARING,READY_FOR_PICKUP` | OK | |
| Card "TH-6Q2HBCW6", "8:14 PM · Ananya · +91 ••••• •3210" | `code, placedAt, customer {name, phoneMasked}` (`order-views.ts:59-84`) | OK | |
| Accept-by ring "4:01" | `acceptBy` | OK | |
| "2× Chicken Dum Biryani · Full · Extra raita", "1× Mirchi ka Salan" | `lines[].quantity, name, addOns[].name` (all chosen options incl. size, `marketplace/domain/quote.ts:163`) | OK | |
| "Note: less spicy please" | `lines[].note` | OK | |
| Prep time 10 / 15 / 20 / 30 min + "Accept · 20 min" | `POST /api/v1/owner/orders/:childId/accept {prepMinutes}` (5–120) | OK | |
| Reject + reasons (Out of stock / Kitchen busy / Closing soon / Other…) | `POST …/reject {reason}` | OK | |
| Preparing card "**13 of 20 min**" progress | `acceptedAt` + `prepMinutes` (or `readyEta`) → client progress | OK (FE derive) | |
| "**Finding partner**" / "Imran assigned" | `deliveryStatus` (null or PENDING_ASSIGNMENT/OFFERED → finding) + `partner.name` | OK | |
| "Mark ready" | `POST …/ready` (allowed via `allowedTransitions`). "Start preparing" is `POST …/preparing` | OK | |
| Ready card pickup code 8 2 5 0 | `pickupCode` | OK | |
| "R · Ravi · **at restaurant** · Partner assigned" | `partner.name` OK. But **AT_PICKUP is never mirrored to orders**: delivery emits no event on arrival (`delivery/domain/execution.ts:26`), and orders only consumes assigned/unassigned/picked_up/started/delivered/failed (`orders/events/delivery-handlers.ts:26`) | PARTIAL | DLV-6 + ORD-5 (P1) |
| Prep-time update | `PATCH …/prep-time` | OK | |

### Board 30: Delivery partner home (`30-partner-home.html`, `board-08.png`)

| Element | Backend source | Status | Gap |
|---|---|---|---|
| Sidebar "R · Ravi Kumar · Scooter · KA03HX4417" | `GET /api/v1/partner/profile` · delivery · `name, vehicle {type, registrationNumber}` | OK | |
| "Approved" badge | profile `status` | OK | |
| Nav Home / Delivery history / Earnings & payouts / Profile & documents | `GET /deliveries/history`, `/finance/partner/*`, `/partner/profile` | OK | |
| Online toggle "You're online" | `POST /api/v1/partner/online {lat,lng}` / `POST /partner/offline` (409 `PARTNER_HAS_ACTIVE_JOBS`) (`routes/partner.ts:51,55`) | OK | |
| "Location sharing active · last sent 3s ago" | `POST /api/v1/partner/location` (every ~5 s, 1 per 3 s limit) → `at` | OK | |
| "NEW OFFER · WOULD BE YOUR 2ND DELIVERY" | `GET /api/v1/partner/offers` + SSE `partner.offer`. "2nd" = active jobs count (`/deliveries/active`) + `batchEvaluation.eligible` | OK | |
| "3.2 km · ~18 min" | offer `job.distanceKm, estimatedMinutes, estimateSource` (`domain/views.ts:99-120`) | OK | |
| Countdown "11" | offer `expiresAt` | OK | |
| "Pickup · Green Leaf · 100 Feet Rd, Indiranagar" | offer `job.pickup {name, address}` | OK | |
| "Drop · **HAL 2nd Stage** · Full address after pickup" | offer returns `job.drop = place(j.drop)` = customer **name + full address + exact location** (`views.ts:112`). There is no area/locality field anywhere in the job (`models/delivery-job.ts:22-30`). The design wants the area only, so today the backend both lacks the field and over-shares | PARTIAL (privacy) | **DLV-2 (P0)** |
| "Fits with your current delivery: ✓ pickup 0.8 km ≤ 1.5 km, ✓ extra time 8 min ≤ 12 min" | `batchEvaluation.reasons[]` (strings ending ✓/✗, `domain/batching.ts:62-65`), `extraMinutes` | OK (FE reformat) | |
| Decline / Accept offer | `POST /api/v1/deliveries/offers/:offerId/reject|accept` (409 `ASSIGNMENT_TAKEN`/`OFFER_EXPIRED`) | OK | |
| "Active delivery 1 of 1 · **TH-DEMOMULTI**" | `GET /api/v1/deliveries/active` → `partnerJobView` has **no order code** (`views.ts:40-63`), and the job model stores none | PARTIAL | DLV-4 (P1) |
| Step bar At restaurant / Picked up / On the way / Deliver | job `status` | OK | |
| "Prafful · Home" | `drop.name` OK. The address **label** ("Home") is not in the job | PARTIAL (minor) | DLV-2 (adds `label`) |
| "#402, 12th Main, Indiranagar · near CMH Rd" | `drop.address` (formatted incl. landmark, `orders/domain/lifecycle.ts:77-80`) | OK | |
| "+91 ••••• •3210" | `drop.phoneMasked` | OK | |
| "Navigate" | `navigation.dropUrl / pickupUrl` (Google Maps link) | OK | |
| "**Call**" | only a masked phone exists. There is **no way to place a call** (no full number for the assigned partner, no proxy). The restaurant phone is not exposed to the partner either | MISSING | **DLV-1 (P0)** |
| "Customer's delivery code" boxes | `POST /api/v1/deliveries/:jobId/deliver {code}` (400 `DELIVERY_CODE_INVALID`, 423 `DELIVERY_CODE_LOCKED`) | OK | |
| "5 attempts left · locks after 5 wrong tries" | `codeAttemptsRemaining` (`views.ts:55`) | OK | |
| "Mark delivered" | deliver | OK | |
| "Can't deliver" | `POST /api/v1/deliveries/:jobId/fail {reason}` | OK | |
| (Arrived, pickup code, start) | `POST …/arrived`, `…/pickup {code}`, `…/start` | OK | |
| TODAY "**6 deliveries · ₹642 earned**" | `GET /api/v1/finance/partner/summary` is all-time only (`payments/domain/ledger.ts:187-200`). There is no day window. History and ledger are paginated, so summing on the client does not scale | PARTIAL | PAY-1 (P1) |
| "Earnings & payouts →" | route | FE | |
| LAST PAYOUT "₹3,410.00 · Paid · UTR 4021 8833 1190 · 8 Oct" | `GET /api/v1/finance/partner/payouts?limit=1` · `amountPaise, status, utr, confirmedAt` | OK | |
| "Keep Thali open while delivering…" | static | FE | |

### Board 40: Admin overview (`40-admin-overview.html`, `board-09.png`)

| Element | Backend source | Status | Gap |
|---|---|---|---|
| Sidebar "OPS" chip, "Nisha K. · Ops admin · MFA on" | `GET /api/v1/me` `name, adminRoles`. MFA comes from the session (token `amr`) | OK | |
| Global search "Search orders, phones… ⌘K" | `GET /api/v1/admin/orders?q=` (TH- codes, ids, restaurant-name prefix) and `?phone=` (last 4 digits of the masked snapshot, regex, **unindexed**, `admin-orders.ts:60-64`). `GET /api/v1/admin/users?q=` · identity. The client must fan out and decide whether input is a phone. There is no unified search | PARTIAL | ORD-7 (P2) |
| Sidebar badge Restaurants **2** | `GET /api/v1/admin/marketplace/overview` · `restaurants.pendingApproval` | OK | |
| Sidebar badge Partners **1** | `GET /api/v1/admin/delivery/overview` · `partners.byStatus.APPROVAL_PENDING` | OK | |
| Sidebar badge Deliveries **1** | delivery overview `exceptions` (or unassigned counts) | OK | |
| Sidebar badge Support **4** | `GET /api/v1/admin/support/tickets?status=OPEN` is paginated with **no count** | PARTIAL | ORD-2 (adds `support` counts) |
| Sidebar Health dot | `GET /api/v1/admin/health` · `overall` | OK | |
| "Sun, 11 Oct · IST · refreshed 14s ago", Refresh | client clock + refetch | FE | |
| KPI ORDERS **42** · "51 child orders" | `GET /api/v1/admin/orders/overview` · `today.checkouts`, `today.placed` (`domain/stats.ts:83-120`) | OK | |
| KPI GMV **₹28,416** | overview `today.gmvPaise` | OK | |
| GMV sub "₹1,204.20 refunded" (today) | **no refunded-today figure** in orders. Payments has refunds but its admin finance routes are FINANCE/SUPER_ADMIN only (`admin-finance.ts:83`), so an OPS admin gets 403 | PARTIAL | ORD-2 (P1) |
| KPI PARTNERS ONLINE **2 / 2** | delivery overview `partners.online` / `partners.byStatus.APPROVED` (`domain/tms.ts:91-106`) | OK | |
| "**1 on a delivery**" | not in the overview | PARTIAL | DLV-5 (P1) |
| KPI UNASSIGNED **1** + "Open deliveries →" | delivery overview `jobsByStatus.PENDING_ASSIGNMENT + OFFERED` | OK | |
| KPI APPROVALS **3** · "2 restaurants · 1 partner" | marketplace `restaurants.pendingApproval` + delivery `partners.byStatus.APPROVAL_PENDING` | OK | |
| KPI FAILED REFUNDS **0** · "Nothing to retry" | orders overview `refundsFailed` (OPS-readable) | OK | |
| "Child orders by status · 51" bar: Delivered 38 / In progress 7 / Placed 2 / Rejected 3 / Cancelled 1 | the overview has today's delivered/rejected/cancelled counts but `activeByStatus` is **all-time active** (not today's cohort), and there is no single today-by-status map | PARTIAL | ORD-2 (P1) |
| Needs attention "Finding a partner · **TH-K7Z2MP4Q** · Spice Route · no partner after 3 rounds · 6 min" · **Assign** | `GET /api/v1/admin/delivery/jobs?exception=true` → `pickup.name, dispatchRound, createdAt, exceptionReason`. **No order code** on the job (`views.ts:66-96`) | PARTIAL | DLV-4 (P1) |
| Assign → partner picker | `POST /api/v1/admin/delivery/jobs/:id/assign {partnerId}` OK. The picker list `GET /admin/delivery/partners?status` has **no online / capacity / near-job filter or distance** (`schemas.ts:52`). With 250 partners it is not usable client-side | PARTIAL | DLV-7 (P1) |
| "Awaiting approval · Tandoor Tales · Approve unlocks after business email is verified" · Approve | `GET /api/v1/admin/marketplace/restaurants?status=APPROVAL_PENDING` (`emailVerified`) + `POST …/:id/approve` | OK | |
| "Awaiting approval · Imran K. · Bike · ID, licence and RC uploaded" · Review | `GET /api/v1/admin/delivery/partners?status=APPROVAL_PENDING` (`vehicle, documents[]`) | OK | |
| System health rows: notifications **Down** "SMTP connect ECONNREFUSED 10.0.3.12:587" | gateway `services.notifications`: `status` is only `down` when unreachable and `degraded` only for mongo/redis down (`gateway/src/health.ts:56-57`). Provider failures are **counted** (`providerErrorsLastHour`) but **no message** is kept (`service-kit/health-details.ts:15-23`) | PARTIAL | GW-1 (P1) |
| payments **Degraded** "webhook lag p95 4.2s" | there is no latency percentile metric. Only `consumerLag` (entry counts) and `outboxOldestAgeSec` | PARTIAL | GW-1 (degraded rules), GW-2 (P2 p95) |
| "orders · delivery · marketplace Up · event lag under 1s" | `consumerLag`, `outboxOldestAgeSec` | OK (FE grouping) | |
| "identity · gateway · db · redis Up" | `gateway.redis`, per-service `mongo`/`redis` | OK | |
| "checked 14s ago" | `checkedAt` | OK | |
| "**3 dead letters · Replay**" | count: per-service `deadLetters` in health. List: `GET /api/v1/admin/notifications/dead-letters`. Replay is **per item only** (`…/dead-letters/:service/:id/replay`) | PARTIAL | NTF-3 (P2) |
| "**12 failed notifications · Retry**" | `GET /api/v1/admin/notifications?status=FAILED` is paginated with **no count** (`routes/admin.ts:141-148`). Retry is per id only (`/:id/retry`) | PARTIAL | NTF-1 (P1 count), NTF-2 (P2 bulk retry) |
| Recent orders table: Order · Customer "Prafful · ••3210" · Restaurants "Spice Route, Green Leaf" · Status (checkout-level: In progress / Order placed / Finding a partner / Partially completed / Completed) · Paid · Refund "₹218.10 pending" / "₹412.30 refunded" · Placed | `GET /api/v1/admin/orders` returns **child-order rows** (`admin-orders.ts:88-93`, `adminChildRow`). A checkout-grouped row with all restaurants, the derived checkout status, paid and refund totals needs N detail calls | PARTIAL | **ORD-1 (P0)** |
| "Status: All" filter (checkout statuses), "Today", "View all →" | the child list filters on **child** statuses and `from/to` | PARTIAL | ORD-1 |
| Avatars / photos (user) | none. The design uses initials | FE | IDN-3 (P2) |

### Matrix tally (MISSING + PARTIAL rows, by owning service)

| Service | MISSING rows | PARTIAL rows | Gap ids |
|---|---|---|---|
| marketplace | 5 (address geocode, cuisine counts, 20% OFF badge, "Not accepting orders" card, Recommended) | 11 | MKT-1…14 |
| orders | 1 ("Checkout only X") | 9 | ORD-1…8 |
| delivery | 1 ("Call") | 8 | DLV-1…9 |
| payments | 0 | 1 | PAY-1 |
| notifications | 0 | 2 | NTF-1…3 |
| identity | 1 (admin "Forgot?") | 1 | IDN-1…3 |
| gateway | 0 | 2 | GW-1…3 |

Count rule: matrix rows marked MISSING or PARTIAL (including "OK / PARTIAL"), counted under every service a row's gap ids name. A row fixed by two services (for example DLV-6 + ORD-5) counts for each.

---

## 2. Missing backend work, grouped by owning service

Conventions for every contract: error envelope `{error:{code,message,details,requestId}}`. Money in paise. ISO-8601 UTC timestamps. Cursor pagination `{items,nextCursor}`. Every new public route must be registered in the service's OpenAPI module (coverage test `openapi.int.test.ts`). No gateway prefix change is needed unless stated: all paths below fall under prefixes already in `routes-map.ts:24-69`.

### 2.1 marketplace

**MKT-1 (P0): Address search, place lookup and reverse geocoding**
- *Why marketplace:* it owns discovery and serviceability and already holds a `GeoProvider` (`ctx.geo`). The `/api/v1/discovery` prefix is already routed and rate-limited (60/min/IP).
- `GET /api/v1/discovery/places?q=&lat?&lng?&limit=8` (public, discovery limiter; `q` 2–100 chars, `lat/lng` bias optional).
  Response `200 {items:[{id, primary:"12th Main Rd", secondary:"Indiranagar, Bengaluru", locality:"Indiranagar", city:"Bengaluru", pincode:"560038"|null, location:{lat,lng}|null, source:"GOOGLE"|"DEMO_GAZETTEER"}], source}`.
  For Google, `location` may be null and is resolved by the next call.
- `GET /api/v1/discovery/places/:placeId` → `{id, formattedAddress, locality, city, pincode, location:{lat,lng}, serviceable:boolean, serviceArea:{id,name,minOrderPaise}|null, source}` (Google Place Details, or a gazetteer row).
- `GET /api/v1/discovery/reverse?lat&lng` → `{label:"12th Main Rd, Indiranagar", locality, city, pincode|null, serviceable, serviceArea|null, source}`. Used by "Use my location" and the header chip.
- *Providers:* extend the `GeoProvider` port (`packages/service-kit/src/providers/geo.ts:30-35`) with `autocomplete?(q, bias)`, `placeDetails?(id)` and `reverse?(p)`. Google uses Places Autocomplete (New) and the Geocoding API, with a session token. Demo and fallback use a seeded **`localities`** collection (marketplace DB: `{_id, name, aliases[], city, pincode, location Point, kind: LOCALITY|ROAD|LANDMARK, isDemo}`, indexes: text on `name, aliases`, `location 2dsphere`). Matching is by text, and reverse is `$near` with a 3 km cap. Demo results are labelled `source:"DEMO_GAZETTEER"` (honest-data rule).
- *Caching:* Redis `geo:ac:<sha1(q|bias)>` for 24 h. Reverse is keyed by geohash-7 for 24 h.
- *Errors:* 400 `VALIDATION_FAILED`, 429 `RATE_LIMITED`. A Google failure falls back to the gazetteer, `recordProviderError(…,'google-places')` and `source:"DEMO_GAZETTEER"` (in production label it `FALLBACK`). Never 5xx for a provider outage.
- *Events/realtime:* none. *Models:* the new `localities` collection and its seed (~150 Bengaluru localities + main roads + landmarks).

**MKT-2 (P1): Discovery totals.** Extend `GET /api/v1/discovery/restaurants` with `counts:{total:number, open:number}`. Compute it after the cuisine/veg/price/q filters and **before** `openNow` and pagination (`discovery.ts:204-207`), so "4 open now · 6 deliver here" is stable while paging. No new route.

**MKT-3 (P1): Show paused restaurants as "Not accepting orders".**
- Stop dropping paused restaurants in `deliverableRestaurants` (`discovery.ts:120`).
- Add to `DiscoveryItemView`: `closedReason: 'PAUSED'|'OUTSIDE_HOURS'|null`, `pausedUntil: string|null`, `acceptingOrders: boolean`.
- Sort: open first, then by the chosen sort. `openNow=true` excludes them.
- Quote and checkout already reject closed restaurants (`RESTAURANT_CLOSED`), so ordering stays safe.
- *Product decision to confirm:* PRD C-2 says paused restaurants are hidden. The design overrules this, so record the change in an ADR.

**MKT-4 (P1): Explicit pure-veg flag.**
- *Model:* `restaurants.pureVeg: boolean` (default false), owner-declared in `PATCH /api/v1/owner/restaurants/:id` (`owner-restaurants.ts:93`) and in the onboarding Business step. Admin can override it.
- *Validation:* creating or patching a non-veg item or option in a `pureVeg` restaurant → 422 `PURE_VEG_VIOLATION {itemId?, optionId?}`. Setting `pureVeg=true` while non-veg items exist → 422 with the offending ids.
- *Discovery:* `isVeg` comes from `pureVeg` (keep the field name for compatibility). This fixes the derivation bug at `discovery.ts:102`, where only available items are counted.
- *Events:* include `pureVeg` in `restaurant.updated` if consumed.

**MKT-5 (P1): Restaurant locality.**
- *Model:* `address.locality` (string ≤ 60) on restaurants (`models/restaurant.ts:31-33`) and in the contracts `RestaurantAddressSchema`.
- *Write:* owner PATCH and onboarding Location step. It can be prefilled by MKT-1 reverse.
- *Read:* expose it in the public page `restaurant.address.locality` + top-level `locality`, in discovery items (`locality`), and in the owner view.
- *Also:* add `locality` to the orders child snapshot (`restaurantAddress`) so the delivery pickup and partner views can show it.

**MKT-6 (P1): Why an item is unavailable.** Add to `PublicMenuItem` (`restaurants-public.ts:16-30`, `discovery.ts:58-85`):
- `unavailableReason: 'SOLD_OUT'|'UNAVAILABLE'|null`: SOLD_OUT when `trackStock && stockQty-reservedQty<=0 && available`, UNAVAILABLE when `available=false`.
- `stockLeft: number|null`: only when `trackStock` and ≤ 5. Optional; the design does not draw it.

No route change.

**MKT-7 (P1): Offers page for guests.** Change `GET /api/v1/coupons/available` from `requireAuth()` to optional auth (`routes/coupons.ts:26`).
- Guests get all live coupons with `remainingUses:null` and a new field `eligibility:'SIGN_IN_TO_CHECK'`.
- Signed-in users keep today's filtering (`domain/coupons.ts:99-120`) with `eligibility:'ELIGIBLE'`.
- Add an `offerHeadline` (e.g. "50% off up to ₹100") computed server-side for consistency.

**MKT-8 (P2): Restaurant-scoped offers and the card badge.**
- *Model:* coupon `restaurantIds: ObjectId[]` (empty = all) and `badgeLabel?: string` (≤ 16, e.g. "20% OFF").
- *Pricing:* `@thali/pricing` must allocate a scoped coupon only across eligible children. Then `/internal/coupons/validate` and the orders quote change. 422 `COUPON_INVALID {reason:'NOT_APPLICABLE'}` when no eligible restaurant is in the cart.
- *Discovery item:* `offer:{label, code}|null` (the best active scoped coupon). The admin catalog coupon editor gets a restaurant picker.

**MKT-9 (P2): Recommended items.** Add `menu_items.featured: boolean` (owner-editable, ≤ 6 per restaurant, 422 `VALIDATION_FAILED` beyond). The public page returns `recommended: PublicMenuItem[]` (available first) next to `menu[]`.

**MKT-10 (P1): Absolute external image URLs (for realistic seed data).** See §3.2. Add a shared `resolveImageUrl(storage, ref)` and accept `https://` refs only from seed and admin paths. This also serves the cover, logo, item, cuisine and banner images.

**MKT-11 (P2): Cuisine facets per location.** Add `facets:{cuisines:[{slug, count}]}` to `GET /discovery/restaurants` (computed with MKT-2). It lets the carousel hide empty cuisines or show counts.

**MKT-12 (P2): Closing time.** Add `closesAt: string|null` (end of the current open slot, overnight aware) on the public page and discovery items, from `open-status.ts`. The FE can derive it today from `hours[]`.

**MKT-13 (P1): Discovery cost at 600 restaurants.**
- *Denormalise:* `restaurants.menuStats {availableItemCount, nonVegCount, avgItemPricePaise, priceBand, updatedAt}` maintained in the same transaction as menu writes (`domain/menu.ts`) and reservations (stock-out). This replaces the per-request `$group` over ~15k items (`discovery.ts:100-108`).
- *Index:* `{status:1, location:'2dsphere'}`.
- *Geo:* compute listing ETA with `roadEstimate` haversine and keep Google for checkout quote only, or batch with the Routes `computeRouteMatrix`. Today every candidate triggers one `geo.distanceAndEta` call per request (`discovery.ts:181`, no cache in `google-geo.ts`).
- *Pagination:* sort once per (area, drop geohash-7, filters) and cache the ordered id list for 60 s in Redis, so paging does not recompute everything (`discovery.ts:220-221`).

**MKT-14 (P2): "Have I rated this?"** `GET /api/v1/restaurants/ratings/mine?childOrderIds=a,b` (👤) → `{items:[{childOrderId, restaurantId, stars, createdAt}]}`. Index the existing `childOrderId` unique key. Alternative: orders adds `rated:boolean` by consuming a `rating.created` event (more moving parts, not recommended).

### 2.2 orders

**ORD-1 (P0): Checkout-level admin order list.**
- *Route:* `GET /api/v1/admin/orders/checkouts` (ADMIN + MFA, read roles as `/admin/orders`). Add it as a new sub-path: the existing child list is used by `OrdersSearch.tsx` and must survive. Register it before `/:checkoutId` in `admin-orders.ts:100`.
- *Query:* `q` (TH- code / ids / restaurant prefix), `status` (CSV of **CheckoutStatus**), `phone`, `restaurantId`, `from`, `to`, `cursor`, `limit ≤ 50`.
- *Response:* `{items:[{id, code, status, placedAt, createdAt, customer:{name, phoneMasked}, restaurants:[{id, name, childStatus, deliveryStatus, refundStatus}], totalPaise, paidPaise, refundedPaise, refundPendingPaise, attention:'FINDING_PARTNER'|'AWAITING_ACCEPTANCE'|'DELIVERY_FAILED'|'REFUND_FAILED'|null}], nextCursor}`.
- `attention` drives the design's "Finding a partner" status cell: any child with `deliveryStatus ∈ {null, PENDING_ASSIGNMENT, OFFERED}` after acceptance → FINDING_PARTNER.
- *Implementation:* query `checkout_groups` (sorted `placedAt desc, _id desc`), then one `$in` fetch of children per page, then `adjustedTotals()` (`derive.ts`).
- *Models/indexes:* `checkout_groups {placedAt:-1,_id:-1}` and `{status:1, placedAt:-1}`. Add `customerContact {name, phoneMasked, phoneLast4}` to `checkout_groups` (copy of the child snapshot at placement), so the list needs no children for the customer column, plus `{ 'customerContact.phoneLast4':1 }`.
- *Errors:* 400 `VALIDATION_FAILED` (bad cursor/status), 401/403.

**ORD-2 (P1): Overview for the design tiles and badges.** Extend `GET /api/v1/admin/orders/overview` (`domain/stats.ts:83-120`), adding:
- `today.byStatus: Record<ChildOrderStatus, number>`: children with `placedAt ≥ IST midnight`, grouped by current status. It feeds the 51-segment bar.
- `today.refundedPaise`: sum of `child.refunds[].amountPaise` with `status=SUCCEEDED` and `updatedAt ≥ since`. Readable by OPS, unlike payments.
- `today.refundPendingPaise`.
- `support:{open, inProgress}` counts from `support_tickets`, for the sidebar badge.

*Indexes:* `child_orders {placedAt:1}`, `{deliveredAt:1}`, `{refundStatus:1}`. `checkout_groups {placedAt:1}` is covered by ORD-1.

**ORD-3 (P1): Check out one restaurant's cart.**
- *Contract change* (`packages/contracts/src/schemas/order.ts:25-36`, `orders/src/schemas.ts:94-101`): optional `restaurantIds: string[]` (1–10) on `POST /api/v1/cart/preview` and `POST /api/v1/checkouts`. Only those groups are quoted, reserved and placed. The other cart lines stay (placement already removes lines by `cartLineId`).
- *Idempotency:* the unique partial index `{userId, cartVersion}` where AWAITING_PAYMENT (LLD §3.3) blocks a second subset checkout on the same cart version. Replace it with `{userId, cartVersion, restaurantSetKey}`, where `restaurantSetKey` = sorted ids joined (`'*'` for the whole cart).
- *Errors:* 422 `VALIDATION_FAILED` (a restaurant not in the cart), 422 `CART_EMPTY`, plus the existing checkout errors.

**ORD-4 (P1): Restaurant point on the customer tracking map.** Add `restaurant:{location:{lat,lng}, address:{line1, locality?, city}}` to `customerChildView` (`order-views.ts:88-101`) from the existing `restaurantLocation` / `restaurantAddress` snapshots. No phone. No model change.

**ORD-5 (P1): Mirror "rider at restaurant".** Consume the new `delivery.arrived` event (DLV-6). Set `child.deliveryStatus='AT_PICKUP'`, append to `order_events`, publish realtime `owner.order` (→ `rt:owner:<ownerUserId>`) and `order.updated` (→ user). Idempotent through the inbox like the other delivery handlers (`events/delivery-handlers.ts`).

**ORD-7 (P2): Admin search by phone.**
- Store `customerContact.phoneLast4` on `child_orders` (and on groups via ORD-1). Backfill it with a migration.
- Index it and replace the suffix regex on the masked string (`admin-orders.ts:60-64`, unindexed).
- `q` auto-detects 4–13 digits as a phone search.

**ORD-8 (P2): ETA in the guest cart dock.** `GET /api/v1/cart?lat&lng` adds per-group `eta:{etaMinutes, etaSource, distanceKm}|null` through a cheap marketplace internal estimate (new `POST /internal/estimates {drop, restaurantIds}`, a batch of `estimateDelivery`). Optional: the FE can reuse the cached discovery ETA instead.

### 2.3 delivery

**DLV-1 (P0): Call the customer or restaurant.**
- *Route:* `POST /api/v1/deliveries/:jobId/contact` (DELIVERY_PARTNER, assigned partner only, else 404). Body `{target:'CUSTOMER'|'RESTAURANT'}`.
- *Allowed states:* RESTAURANT in `ASSIGNED, AT_PICKUP`. CUSTOMER in `PICKED_UP, OUT_FOR_DELIVERY` (and `AT_PICKUP` for "order not ready" issues). Otherwise 409 `CONFLICT {reason:'NOT_CALLABLE_NOW'}`.
- *Response:* `{mode:'DIRECT'|'PROXY'|'DEMO', telUrl:'tel:+9198…'|null, displayNumber:'+91 ••••• •3210', expiresAt}`.
  - `DIRECT` (pilot): fetches the customer phone from identity `GET /internal/users/:id` (delivery is already an allowed caller, `identity/src/routes/internal.ts:22`) and the restaurant phone from marketplace `GET /internal/restaurants/:id`.
  - `PROXY`: a future Twilio/Exotel masked number.
  - `DEMO`: in `APP_MODE=demo` it returns `telUrl:null` with the label "Calling is simulated in demo" (honest; the demo makes no real calls).
- *Audit:* emits `audit.recorded` (`action:'delivery.contact_revealed'`). Rate limit 10/min/partner.
- *Errors:* 404, 409, 429, 502 `UPSTREAM_UNAVAILABLE`.
- *Model:* none (no phone is stored in delivery). Optionally add `pickup.phone` to the `order.accepted` payload to avoid the marketplace call.

**DLV-2 (P0): Show only the drop area on offers.**
- *Contract change* (`packages/contracts/src/events.ts:17-25`, `orders/src/domain/lifecycle.ts:88-99`): `EventDrop` gains `area:string` (address `locality` → else the service-area name → else the pincode) and `label:string|null` (Home/Work).
- *Model:* `delivery_jobs.drop.area`, `drop.label`.
- *Views:* `offerView` (`delivery/src/domain/views.ts:99-120`) returns `job.drop = {area, distanceFromPickupKm}`, **without** the name, full address or exact location. `partnerJobView` adds `drop.label`.
- *Compatibility:* jobs created before the change fall back to `area = pincode` parsed from `address`.
- *Why:* this is both a design need ("Drop · HAL 2nd Stage · Full address after pickup") and a privacy fix. Any partner who is offered a job currently receives the customer's name and full address.

**DLV-3 (P0): Live remaining ETA.**
- Extend `GET /api/v1/deliveries/tracking/:childOrderId` (`domain/tracking.ts:58-94`) with `remaining:{minutes:number, distanceKm:number, source:EstimateSource, computedAt}|null`:
  - `PICKED_UP|OUT_FOR_DELIVERY`: `geo.distanceAndEta(lastLocation, drop)`.
  - `ASSIGNED|AT_PICKUP`: `eta(lastLocation→pickup) + max(0, readyEta-now) + eta(pickup→drop)`.
  - Null before a partner is assigned. The client then shows the static child `eta`.
- *Cache:* Redis `trk:eta:<jobId>` for 30 s, so pings do not multiply Google calls.
- *Realtime:* add `remainingMinutes` to the `delivery.location` payload (LLD §11).
- Labels stay honest: `source` maps to "demo estimate" / "estimate".

**DLV-4 (P1): Order codes on jobs.** `order.accepted` gains `childOrderCode` and `checkoutCode`. The job stores them. They appear in `partnerJobView`, `adminJobView` and `/admin/delivery/jobs` search (`q=TH-…`). Backfill existing jobs through orders `GET /internal/orders/child/:id`.

**DLV-5 (P1): Overview counts.** `GET /api/v1/admin/delivery/overview` (`domain/tms.ts:91-106`) adds:
- `partners.approved`
- `partners.onDelivery` (APPROVED ∧ online ∧ `activeJobIds` not empty)
- `unassigned` (PENDING_ASSIGNMENT + OFFERED)

**DLV-6 (P1): `delivery.arrived` event.** `arrive()` (`domain/execution.ts:26`) emits `delivery.arrived` (DeliveryAtPayload) through the outbox. Add it to the contracts event catalog and to orders' consumer streams (ORD-5).

**DLV-7 (P1): Assign picker.** `GET /api/v1/admin/delivery/partners` (`schemas.ts:52`) adds `online=true`, `hasCapacity=true` and `nearJobId=<id>` (sort by `$geoNear` on `lastLocation` from the job pickup; the `2dsphere` index exists, `models/partner.ts:67`). Rows gain `distanceToPickupKm`, `activeJobCount`, `lastLocationAt`.

**DLV-9 (P2): Route geometry.** `route: {polyline, source}` on tracking, only when the source is GOOGLE. It is not needed for the demo.

### 2.4 payments

**PAY-1 (P1): Windowed earnings ("Today · 6 deliveries · ₹642 earned").** Extend `GET /api/v1/finance/partner/summary` and `GET /api/v1/finance/restaurants/:restaurantId/summary` (`routes/finance.ts:44,56`) with optional `from`, `to` (ISO; default today in IST).
- Response adds `window:{from, to, earningsPaise, entriesByType:{DELIVERY_EARNING|ORDER_EARNING|…:paise}, deliveries:number}`, where `deliveries` = count of DELIVERY_EARNING entries (one per job, `dedupeKey`).
- The existing `{accountType, accountId, createdAt}` index covers it.
- *Why payments:* earnings are ledger facts. Counting delivered jobs in delivery would diverge from paid amounts.

### 2.5 notifications

**NTF-1 (P1): Counts and the last provider error.** `GET /api/v1/admin/notifications/summary` (ADMIN + MFA) → `{byStatus:{QUEUED,SENDING,SENT,DELIVERED,FAILED,DEAD,SKIPPED}, failedLast24h, byChannel:{SMS:{failed}, EMAIL:{failed}}, lastError:{channel, provider, message, at}|null}`. `lastError.message` is the most recent `lastError` on a FAILED/DEAD notification, scrubbed of addresses. Index `{status:1, createdAt:-1}` exists (`models/notification.ts:86`).

**NTF-2 (P2): Bulk retry.** `POST /api/v1/admin/notifications/retry {status:'FAILED'|'DEAD', channel?, before?, limit≤500}` → `{queued:n}`. Audited. Writer roles as the per-id retry (`routes/admin.ts:218`).

**NTF-3 (P2): Bulk replay of dead letters.** `POST /api/v1/admin/notifications/dead-letters/replay {service?, limit≤100}` → `{replayed, failed:[{service,id,error}]}`. It fans out to each service's `POST /internal/dead-letters/:id/replay`.

(Not in the design but useful with the bell: `POST /api/v1/notifications/read-all`, P2.)

### 2.6 identity

**IDN-1 (P1): Admin "Forgot?" password.**
- `POST /api/v1/auth/admin/password/forgot {email}` → always 202. It sends a one-time token (sha256 hashed, 30 min TTL, `admin_credentials.resetTokenHash/resetExpiresAt`) through notifications `/internal/notifications/send`.
- `POST /api/v1/auth/admin/password/reset {token, newPassword, totpCode}` → 204. It requires a valid TOTP (MFA is kept), revokes all sessions and is audited. Rate limit as admin login.
- *Errors:* 400 `VALIDATION_FAILED`, 401 `INVALID_CREDENTIALS` (bad token or TOTP), 429.
- *Alternative if email reset is unwanted for admins:* SUPER_ADMIN-only `POST /api/v1/admin/admins/:id/reset-password`, with the link copy changed to "Ask a super admin". Pick one; a dead link is not allowed.

**IDN-2 (P1): Address locality.** `addresses[].locality` (and `formattedAddress`) on `POST/PATCH /api/v1/me/addresses` and in the views (`domain/views.ts:5-17`). The orders address snapshot copies it, which feeds DLV-2 `drop.area` and the header chip "Home · 12th Main, Indiranagar".

**IDN-3 (P2): Avatar.** `users.avatarKey` with `PATCH /api/v1/me {avatarKey|null}` and a presign `POST /api/v1/me/uploads` (IMAGE rule). The view adds `avatarUrl`. The design uses initials, so it is optional.

### 2.7 gateway (+ service-kit)

**GW-1 (P1): Health that explains itself.**
- *service-kit:* `recordProviderError(redis, service, provider, at, message?)` keeps the last scrubbed message per provider (`provider_last_error:<service>:<provider>` hash, 1 h TTL). `healthDetails` adds `lastProviderErrors:{[provider]:{message, at}}` (`health-details.ts:15-23`).
- *gateway* (`health.ts:56-57`): add `degradedReasons: string[]` and `summary: string` per service. Mark `degraded` when `providerErrorsLastHour ≥ 5`, any `consumerLag > 100`, `outboxOldestAgeSec > 60` or `deadLetters > 0`.
- Add `providers:{email:'up'|'failing', sms:…}`, so "notifications · SMTP connect ECONNREFUSED" is shown as **provider failing** while the service itself is reachable. Do not call it "Down", or the honest-data rule is broken.

**GW-2 (P2): Event latency p95.** A consumer-side histogram of the time from event `occurredAt` to handled, kept in Redis (rolling 5 min) and reported as `eventLatencyP95Ms`. It is needed only for "webhook lag p95 4.2s". Until then, show `consumerLag` and `outboxOldestAgeSec`.

**GW-3 (P2): City in `/meta`.** `{city:{name:'Bengaluru', pilot:true}}` from config. Static copy is acceptable.

---

## 3. Model and data additions

### 3.1 Field additions (design + realistic seed)

| Collection (service) | Field | Purpose | Gap |
|---|---|---|---|
| `restaurants` (mkt) | `pureVeg: boolean` | "Pure veg" badge and Veg-only filter, without menu derivation | MKT-4 |
| `restaurants` | `address.locality` | "Indiranagar" in the header, switcher and pickup | MKT-5 |
| `restaurants` | `menuStats {availableItemCount, nonVegCount, avgItemPricePaise, priceBand, updatedAt}` | price band and veg without a per-request aggregate | MKT-13 |
| `restaurants` | optional `costForTwoPaise` (owner-set) | if the product wants "₹400 for two" instead of a band. Not in the design | P2 |
| `restaurants` | `images.cover`, `images.logo` accept `https://…` (seed/admin) | realistic covers | MKT-10 / §3.2 |
| `menu_items` | `featured: boolean` | Recommended section | MKT-9 |
| `menu_items` | `imageKey` accepts `https://…` (seed/admin) | dish photos | §3.2 |
| `coupons` | `restaurantIds[]`, `badgeLabel` | "20% OFF" card badge | MKT-8 |
| `localities` (new, mkt) | `name, aliases[], city, pincode, location, kind, isDemo` | demo geocoder / autocomplete | MKT-1 |
| `users.addresses[]` (identity) | `locality`, `formattedAddress` | header chip, drop area | IDN-2 |
| `users` | `avatarKey` | optional avatar | IDN-3 |
| `admin_credentials` | `resetTokenHash`, `resetExpiresAt` | Forgot password | IDN-1 |
| `checkout_groups` (orders) | `customerContact {name, phoneMasked, phoneLast4}` | admin checkout list | ORD-1 |
| `child_orders` | `customerContact.phoneLast4`; `restaurantAddress.locality`; `dropAddress.locality` | search, pickup and drop area | ORD-7, DLV-2 |
| `delivery_jobs` | `childOrderCode`, `checkoutCode`, `drop.area`, `drop.label`, optional `pickup.phone` | partner header, offer privacy, call | DLV-1/2/4 |
| `partners` | already has `vehicle {type, registrationNumber}` (`models/partner.ts:42`). Optional `photoKey` | profile "Scooter · KA03HX4417" is OK today | — |
| event `order.accepted` (contracts) | `childOrderCode, checkoutCode, drop.area, drop.label, pickup.phone?` | as above | DLV-2/4 |
| event `delivery.arrived` (new) | `DeliveryAtPayload` | "Ravi · at restaurant" | DLV-6 |

### 3.2 How images are stored and served today, and the recommendation

**Today**
- **Storage:** S3 API through `createS3Storage` (`packages/service-kit/src/providers/s3-storage.ts`). Locally this is MinIO (`S3_ENDPOINT=http://minio:9000`, path-style). Buckets: `S3_PUBLIC_BUCKET` (images) and `S3_PRIVATE_BUCKET` (KYC documents).
- **What is stored in Mongo is a key, not a URL:** `restaurants.images.cover/logo` (`models/restaurant.ts:53`), `menu_items.imageKey` (`models/menu-item.ts:26`), `cuisines.imageKey`, `banners.imageKey`.
- **Upload flow:**
  - Owners: `POST /owner/restaurants/:id/uploads` → presigned PUT (content type and exact size signed; IMAGE: jpeg/png/webp ≤ 2 MB, `domain/uploads.ts:15-18`). Then `verifyAttachment` checks that the key is under the restaurant's own prefix and sniffs magic bytes (`domain/uploads.ts:56-75`, `domain/menu.ts:128-130`).
  - Admin catalog: keys must match `^catalog/…` (`routes/admin-catalog.ts:19`).
- **Serving:** each view calls `storage.publicUrl(key)` (12 call sites). This returns `S3_PUBLIC_BASE_URL/key` when set (compose: `http://localhost:9000/thali-public`, a CDN in production), else `S3_PUBLIC_ENDPOINT || S3_ENDPOINT` + `/bucket/key`, else the AWS virtual-host URL (`s3-storage.ts:102-107`). `S3_PUBLIC_ENDPOINT` is only the browser-reachable host used to **sign presigned PUT/GET** URLs (SigV4 signs the Host). Public images use `S3_PUBLIC_BASE_URL`.
- **Seed:** marketplace generates SVG cover/logo/banner images and uploads them with `uploadSeedObjects` (HEAD then presigned PUT, idempotent) under `images/demo/<slug>/{cover,logo}.svg` (`services/marketplace/src/seed.ts:185-186, 285-320`). Menu items have no images.
- There is no CSP on the SPA (`infra/nginx/security-headers.conf` sets no `img-src`), so external image hosts are not blocked by the browser.

**Problem for a ~600-restaurant / ~15k-item seed:** uploading ~16k objects into MinIO through presigned PUTs is slow and bloats the volume. Passing an `https://…` value through as a "key" today produces a broken URL (`publicUrl` URL-encodes it under the bucket path).

**Recommendation**
1. Add `resolveImageUrl(storage, ref)` to service-kit: if `ref` matches `^https://` **and** its host is in a new `EXTERNAL_IMAGE_HOSTS` allowlist, return it unchanged; otherwise return `storage.publicUrl(ref)`. Replace the 12 direct `publicUrl` calls in marketplace views (`discovery.ts:68,92,189,282-283`, `restaurant-view.ts:54-55`, `restaurants-public.ts:95,106`, `domain/menu.ts:48`, …).
2. **Write paths stay strict:** owner routes keep accepting only verified upload keys (no change to `verifyAttachment`). Admin catalog routes may accept `https://` refs from allowlisted hosts (validated with zod `url()` + host check). Seeds write documents directly, so they need no route change.
3. **Keep the field names** (`images.cover`, `imageKey`) and document "key or absolute URL". Add `imageSource: 'UPLOAD'|'EXTERNAL'` only if analytics needs it.
4. **Seed images:** a curated, licence-checked pool (for example ~20 per cuisine × 12 cuisines, plus ~200 dish photos keyed by dish archetype, e.g. "biryani", "dosa"). Reuse the pool deterministically by hash, so 15k items reference about 400 distinct URLs. Prefer serving the pool from **our own** bucket or CDN path (upload ~400 files once, then reference them as keys). That avoids hotlinking third-party sites. External absolute URLs are the fallback when no upload is possible.
5. The frontend must keep placeholder art when `imageUrl` is null (the boards draw abstract placeholders), and must not invent images.

---

## 4. Frontend-only items (no backend work)

- Light/dark theme toggle (persist in localStorage; respect `prefers-color-scheme`). Fonts are self-hosted from `design/fonts`.
- Chime on/off (Web Audio after a user gesture), reduced-motion handling, and the aria-live announcement of new orders.
- Countdown rings (accept-by, offer expiry, resend OTP), "updated 3s ago", "last sent 3s ago", "checked 14s ago", "refreshed 14s ago" from timestamps the server already sends.
- Prep progress "13 of 20 min" from `acceptedAt` + `prepMinutes`.
- "from ₹249" (base + cheapest required options) and absolute option prices (base + option) in the customiser. "Choose a size" CTA logic and the live total preview.
- "Open till 11:30 PM" from `hours[]` + timezone (until MKT-12).
- "EST." / "Demo estimate" from `etaSource`. "New" when `rating===null`. FSSAI veg/non-veg shape marks.
- Refund stepper mapping from `refundStatus`. Delivery timeline from `statusHistory`. Struck-through rejected lines. "Net after pending refund" from `adjustedTotals`.
- "Would be your 2nd delivery" (active count + `batchEvaluation.eligible`). The "Fits with your current delivery" list reformats `reasons[]` (moves ✓/✗ to the front).
- Needs-attention list built from 3 existing lists (exception jobs, pending restaurants, pending partners). "Approve unlocks after business email is verified" from `emailVerified`.
- Cuisine carousel arrows, `/` and ⌘K shortcuts, cart dock expand/collapse, "Added … to …" toast, restaurant initials chips, avatar initials, placeholder cover art.
- Landing marketing sections, "Pick your door", the illustrative cart card, footer, static Terms/Privacy/Refunds/Help pages, "Bengaluru · pilot city" (or GW-3).
- Demo banner from `/meta`. "Keep Thali open while delivering" and the browser-limits panel.
- Ask for a location before searching from the landing header (until MKT-1 lands, the only sources are the map pin and browser geolocation).

---

## 5. Seed mechanics today, and what changes for a Bengaluru-scale seed

### 5.1 How it works today
- **Driver:** `scripts/seed.ts` runs the per-service seeds in order `identity → marketplace → delivery → payments → notifications → orders` (`scripts/seed.ts:21`). It runs either inside the containers (`docker compose exec <svc> node dist/seed.js`) or with `--local` (`npx tsx services/<svc>/src/seed.ts` using `.env`). It stops at the first failure and parses the `SEED_RESULT {...}` line from each run. The gateway has no seed.
- **Writes go straight to each service's own database with Mongoose models. No public API calls, no events, no outbox.** Every seed refuses to run unless `APP_MODE=demo` (`assertDemoSeedAllowed`, `packages/service-kit/src/seed.ts:23-27`).
- **Ids are deterministic:** `seedId(name)` = sha1(`thali-seed:<name>`)[0..24] (`packages/contracts/src/seed.ts:8-10`). Examples: `user:consumer1`, `restaurant:spice-route`, `item:<rest>:<item>`, `option:<rest>:<item>:<group>:<opt>`. This lets services reference each other's records with no lookups.
- **Idempotent:** `ensureDocs` (`service-kit/src/seed.ts:35-68`) checks each document with `model.exists({_id})` and inserts with `doc.save({timestamps:false})`. Existing documents are **never overwritten**. A unique-index clash with a non-seed document throws `SeedConflictError`. The cost is two round trips per document, one document at a time.
- **Shared story:** `@thali/contracts/seed-demo` (`packages/contracts/src/seed-demo.ts`, 280 lines) describes the demo restaurants, pricing config, delivery-fee rule, partner payout rule and three checkouts (TH-DEMOMULTI, TH-DEMODONE, TH-DEMOCNCL) with breakdowns. The orders seed recomputes them with `priceCheckout` and refuses to run on a mismatch.
- **Per service:**
  - **identity** (`services/identity/src/seed.ts`): `users` with consumers 1–3 (+91900000000{1,2,3}), owner1–2, partner1–4 and the admin; embedded addresses in Koramangala; `admin_credentials` (argon2 password + encrypted TOTP).
  - **marketplace** (`seed.ts`, 480 lines): 1 `service_areas` row (`blr-koramangala`, bbox polygon 77.58–77.68 lng × 12.90–12.99 lat, `seed.ts:340-345`); 11 `cuisines` (no images); 4 `restaurants` (spice-route and green-leaf APPROVED, tandoor-tales APPROVAL_PENDING, coastal-curry VERIFICATION_PENDING) with `menu_categories` and `menu_items` (customisation groups, one tracked-stock item); `coupons` WELCOME50 and FLAT100; `membership_plans` Thali Plus; one demo `banners` row; S3 objects (SVG cover/logo/banner + private demo PDFs for KYC).
  - **delivery:** `partners` 1–4 (incl. a pending and a suspended one, docs in S3) and `delivery_jobs` for the demo checkouts.
  - **payments:** `payment_intents` + mock-provider payment records; `refunds` (SUCCEEDED); `ledger_entries` (ORDER_EARNING, COMMISSION, PLATFORM COMMISSION, DELIVERY_EARNING per delivered child, through the same `deliveryEarningPaise`); one PAID `payouts` row with a UTR and its PAYOUT ledger entry.
  - **notifications:** in-app `notifications` for demo users.
  - **orders:** `restaurant_projection`, `checkout_groups`, `child_orders`, `order_events`.
- **Demo accounts:** see `docs/ui-redesign-context.md` §13. Demo OTP works only for phones listed in `DEMO_PHONES` with `DEMO_OTP_ENABLED` (`identity/src/config.ts:30-32, 92`).

### 5.2 What must change for ~600 restaurants / ~15k items / ~1,000 consumers / ~250 partners / several thousand delivered orders

**Rough volume:**

| Records | Count |
|---|---|
| Restaurants | 600 (+ ~450 owner users, some owning 2–3 restaurants so the switcher shows) |
| Categories | ~3k |
| Items | 15k |
| Consumers | 1k, with ~1.5k addresses |
| Partners | 250 (+ 250 users) |
| Checkouts | ~5k |
| Child orders | ~6.3k |
| Order events | ~50k |
| Delivery jobs | ~6k |
| Payment intents + mock payments | ~10k |
| Ledger entries | ~25k + payouts |
| Ratings | ~2.5k |

That is about 130k documents in total.

1. **Generator package, not hand-written arrays.** Add `@thali/contracts/seed-blr` (Node-only, like `seed-demo`): pure, deterministic generators over a seeded PRNG (e.g. mulberry32 with a fixed seed). Each service regenerates exactly the slice it owns:
   - `restaurant(i)` → id `seedId('blr:restaurant:'+i)`, name, cuisines, locality, location, hours, `pureVeg`, packaging fee, commission, `avgPrepMinutes`
   - `menu(i)` → categories and items with options
   - `consumer(j)`, `partner(k)`, `checkout(n)`
   Orders must be priced with `@thali/pricing.priceCheckout` against the generated menu and fee rule, so orders, payments (ledger) and delivery (distance → `deliveryEarningPaise`) reconcile without reading each other's databases. Keep the existing `seed-demo` story and ids untouched (e2e and smoke depend on TH-DEMOMULTI, the demo phones and the restaurants).
2. **Bulk idempotent writes.** Add `ensureDocsBulk(model, docs, report, {chunk:1000})`: `find({_id:{$in:chunk}},{_id:1})` → `insertMany(missing, {ordered:false, timestamps:false})` (validators still run). Today's `ensureDocs` would take about 260k sequential round trips. Also stream the generation (chunks) to keep memory flat.
3. **Service areas.** Discovery requires the restaurant to be in the **same** area polygon as the drop (`serviceability.ts:62-75`), and `findServiceArea` picks the first area by `createdAt` when areas overlap (`serviceability.ts:32-40`). A city-wide seed therefore needs **one** Bengaluru polygon, not several adjacent zones that fragment discovery. The existing `blr-koramangala` area was created first and would win for Koramangala drops. Because seeds never overwrite, deactivating or reshaping it needs a reset (`stack:down -v`) or an explicit one-off migration script. Do not edit it in place in `seed.ts`.
4. **Ratings must be backed by real rated orders** (honest-data rule): create `ratings` only for generated DELIVERED child orders (unique `childOrderId`), and set `restaurants.ratingSum/ratingCount` to exactly match. Leave ~20% of restaurants under 5 ratings so "New" appears.
5. **Cross-service consistency checklist** for each generated delivered child:
   - **orders:** child (`statusHistory`, timestamps, `customerContact` from the consumer generator, partner snapshot, codes), group, events.
   - **delivery:** a DELIVERED job with `partnerId`, hashed codes, `distanceKm`, `statusHistory`, `deliveredAt`.
   - **payments:** a CAPTURED intent, mock payment, ORDER_EARNING / COMMISSION / PLATFORM COMMISSION / DELIVERY_EARNING entries with the live `dedupeKey` formats (`earning:<childId>`, …).
   - **marketplace:** rating.
   - Rejected or cancelled children: REJECTED / CANCELLED status + SUCCEEDED refund + `refundStatus/refundedPaise` on the child.
   - Coupon `usedCount` = number of REDEEMED `coupon_redemptions`. Membership usage matches the checkouts that used it.
   - Partners and restaurants get weekly PAID payouts with UTRs (and PAYOUT ledger entries) so balances and "last payout" are realistic and `available ≥ 0`.
   - Orders `restaurant_projection` for every restaurant.
6. **Time-relative data.** "Orders today", the KPI tiles and "Opens at 6 PM" depend on the time the seed runs, but the ids must stay stable. Generate history relative to a fixed anchor and add today's slice relative to `now`. Re-seeding cannot refresh existing documents, so provide a separate demo traffic script that places a few live orders **through the public APIs** (cart → checkout → demo-pay → owner accept → partner deliver). This keeps the board, kanban and tracking alive and exercises events. Avoid seeding `pausedUntil` (an absolute time goes stale); show "closed" through hours instead.
7. **Identity at scale.**
   - Demo OTP: replace the `DEMO_PHONES` list with an allowed prefix such as `DEMO_PHONE_PREFIXES=+91900,+91910,+91920` (demo mode only), or keep the list for the named demo accounts and let generated users exist only as data.
   - Phones must not collide with the existing demo numbers.
   - Addresses go inside the city polygon, with `locality`.
8. **Partners:** 250 APPROVED (a few pending or suspended), all `online:false`, `activeJobIds:[]`, `lastLocation` unset, except the 2 demo partners. Each needs a vehicle and registration number (the board shows "Scooter · KA03HX4417").
9. **Performance at this scale:**
   - **Discovery** (MKT-13): today each request does a `$geoWithin` (polygon ∧ 15 km `centerSphere`, `MAX_DELIVERY_RADIUS_KM` default 15, `config.ts:48`), which yields hundreds of candidates. It then runs a `$group` over all their available items, one `estimateDelivery` per candidate (free with the demo adapter, one Google Routes call each in production), sorts everything and slices one page. Add the denormalised `menuStats`, the `{status, location}` index, list-time haversine and a cached ordered id list. Item search uses an unindexed regex on `name/tags` (`discovery.ts:158-166`). Use the existing text index or add a `nameLower` prefix index.
   - **Orders indexes:** `child_orders {placedAt:1}`, `{deliveredAt:1}`, `{refundStatus:1}`, `{restaurantId:1, placedAt:-1}` (owner stats filter on `restaurantId + placedAt`, `domain/stats.ts:36`), `{createdAt:-1,_id:-1}` (unfiltered admin list), `{'customerContact.phoneLast4':1}`. `checkout_groups {placedAt:-1,_id:-1}` (overview GMV and ORD-1).
   - **Delivery:** `delivery_jobs {partnerUserId:1, createdAt:-1}` for history pagination, `{childOrderCode:1}`.
   - **Payments:** the ledger index exists. `listBalances` does a `distinct` over accountId (850 accounts is fine).
   - **Mongo build:** create indexes **before** bulk inserts (the seeds already call `ensure*Indexes`) and wait for them. Use `insertMany` in 1k chunks inside no transaction, which is safe because seeds own their database and are idempotent by `_id`.

---

## 6. Must-not-lose list (current features with no design board)

These are backed by working APIs today. Rebuild them in the new design system with the same information architecture.

**Consumer**
- Banners carousel (admin-configured, "DEMO" labelled; `GET /banners`). It appears on no board and must still exist on home.
- Search page with matched dishes (`/discovery/search`).
- Location picker: map pin + saved address + browser location, "We don't deliver here yet".
- Cart page and drawer. Guest cart + merge on sign-in.
- Sign-in dialog from cart/checkout (cooldown, attempts, demo hint).
- Checkout: problems list with "Fix cart" links, price-changed confirm, coupon list and errors.
- Razorpay popup and the Demo Pay page (`/demo-pay/:intentId`). Checkout status page (confirming / failed-retry / expired / cancelled).
- Orders list (paginated, refunds).
- Customer cancel (`canCancel`). Rate restaurant (1–5, once).
- Profile and notification preferences, sign out, sign out of all devices.
- Saved addresses CRUD (max 10, default).
- Thali Plus plans, terms, purchase and history.
- Support tickets (create, list, thread, reply). Notifications page with mark-read.

**Restaurant owner**
- Onboarding wizard (Business / Location / Hours / Media / Documents / Settlement / Review), upload progress and errors.
- Persistent status banner incl. "Verify your business email" + Resend cooldown.
- Dashboard (stats unavailable state, rating, menu health).
- Order history with a multi-status filter and a detail dialog.
- Menu management: categories (create, rename, reorder, activate), items, stock with reserved quantity, customisation editor, quick availability toggles.
- Store settings: weekly hours incl. overnight, pause 15/30/60/custom, radius, packaging fee, masked settlement.
- Finance: summary, ledger, payouts with UTR.
- Reject dialog with required reason. Update prep time.

**Delivery partner**
- Onboarding (vehicle, documents per vehicle type, resubmit after rejection).
- History. Earnings (summary, ledger, payouts with UTR).
- Location sharing across partner pages. Tracking-limitations panel.
- Pickup-code dialog, Arrived, Start delivery steps (the board shows only the Deliver step).
- "Taken by another partner" / "Offer expired" states.

**Admin**
- Login with first-time MFA setup (otpauth URI + secret, no QR). Lockout messaging.
- Restaurant and partner approvals plus detail pages (short-lived document links, verify document, status history, approve / reject / suspend / reinstate with reasons).
- Users (search, roles, block/unblock).
- Order search + investigation timeline, admin cancel with refund amount, allowed transitions.
- TMS (unassigned/exception jobs, assign/unassign/fail, demo simulate).
- Catalog: coupons, banners, cuisines, membership plans, service-area polygon editor.
- Support queue and ticket thread.
- Finance: refunds by status + retry, manual refund, balances, payout create / confirm UTR / fail, payment search.
- Audit log. Full Health page incl. the demo notification fail-mode switch.
- Admin sub-role gating with explanations.

**Global**
- Mode banner. Session-expired dialog that returns to the same page.
- "Live updates paused — refreshing every 10 s" realtime fallback notice.
- Loading, empty, error, forbidden states on every data screen.
- Idempotent pay, refund and payout buttons.
- Veg/non-veg shape marks. "Paid only with UTR". Rating hidden under 5.
- Role guards. Responsive table-to-card on mobile.

---

### Top P0 gaps (design visibly broken without them)
1. **MKT-1:** address search, autocomplete and reverse geocoding (landing address box, "Find food", "Use my location").
2. **DLV-1:** "Call" for the assigned partner (contact reveal or proxy; audited; demo-labelled).
3. **DLV-2:** offer shows the drop **area** only ("HAL 2nd Stage · Full address after pickup"). Also fixes today's leak of the customer's name and address to offered partners.
4. **ORD-1:** checkout-level admin recent-orders list (restaurants, checkout status, paid and refund columns, checkout status filter).
5. **DLV-3:** live remaining ETA on tracking ("On the way — about 9 min" from the rider's position, source-labelled).
