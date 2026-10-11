# Thali — UI Redesign Context

> **Status (2026-10-11): the redesign described by this brief has been implemented.** This file is kept as the
> original brief, so it describes the screens and data *before* the redesign; where it differs from the app, the
> app, [LLD section 10.1](03-LLD.md) and ADR-034 to ADR-041 in [04-ADR.md](04-ADR.md) are authoritative.
> Where to look now:
> - Design sources (design export, per-board element tables, overrides) and the backend gap analysis:
>   [docs/design/redesign/](design/redesign/README.md) (`design-spec.md`, `design-spec-overrides.md`, `gap-analysis.md`,
>   board screenshots and illustrations).
> - Component library, shells, tokens and theme: `apps/web/src/README-DESIGN-SYSTEM.md`.
> - New and changed APIs: [09-api.md](09-api.md) section 11; operations for the demo dataset: [07-runbook.md](07-runbook.md) section 14.
> - Notable changes against this brief: paused restaurants are listed as "Not accepting orders" (ADR-034); admin
>   sign-in is `/signin?role=admin` and `/admin/login` redirects there; partners see only the drop area until pickup
>   (ADR-038); per-restaurant checkout (ADR-037); light, dark and system themes (ADR-041).


> Purpose: give a designer / design AI everything needed to redesign the **entire web UI** of Thali end to end, without reading the code. It describes the product, users, every screen, the data each screen shows, the actions, the states, the business rules the UI must communicate, and the constraints that must not break.
>
> The backend and APIs already exist and work. A redesign changes **presentation, layout, IA and interaction**, not the data contracts. Where a screen depends on specific API data, it is listed so the new design shows real data only.

---

## 1. Product in one page

**Thali** is a food-delivery marketplace for India (pilot: one city, Bengaluru). Currency INR (₹), timezone Asia/Kolkata (IST), English UI.

Four user groups, one web app (responsive, mobile-first):

| Role | Who | Core job |
|---|---|---|
| **Consumer** | Hungry customer | Find restaurants that actually deliver to my address, order from **multiple restaurants in one checkout**, pay once, track each delivery. |
| **Restaurant owner** | Restaurant / cloud-kitchen | Get listed (onboarding + approval), manage menu & stock, accept/reject orders fast, see earnings & payouts. |
| **Delivery partner** | Rider (bike/scooter/bicycle/car) | Go online, take delivery offers (sometimes 2 at once — "batching"), prove pickup & drop with codes, see earnings. |
| **Admin** | Marketplace ops / finance / support | Approve restaurants & riders, fix stuck orders/deliveries, refunds & payouts, support tickets, catalog config, audit logs, system health. |

**The signature feature: multi-restaurant ordering.** One cart can hold items from several restaurants. One payment. The system splits it into one **child order per restaurant**; each restaurant accepts/rejects independently, each is delivered separately with its own tracking. If one restaurant rejects, only that part is refunded and the rest continues. The UI must make this split obvious and calm, before and after payment.

**Honesty principle (product rule):** never fabricate ratings, ETAs, availability, metrics or "healthy" indicators. Demo values must be visibly labelled. A redesign must keep these labels and must not invent decorative data.

---

## 2. App structure & navigation (current routes)

One SPA, four areas. URLs below are current and can be kept or remapped, but each screen must exist.

### Consumer (public + signed-in) — `/`
| Route | Screen |
|---|---|
| `/` | Home / discovery (location, banners, cuisines, restaurant list, filters, sort) |
| `/search` | Search restaurants + dishes |
| `/restaurants/:idOrSlug` | Restaurant page (menu, item customizer) |
| `/cart` | Cart (grouped by restaurant) — also a cart drawer from anywhere |
| `/checkout` | Checkout (address, coupon, membership, price breakdown, pay) |
| `/checkout/status/:checkoutId` | Payment confirmation / checkout status |
| `/demo-pay/:intentId` | Demo payment page (demo mode only) |
| `/orders` | Order history |
| `/orders/:checkoutId` | Order detail + live tracking per restaurant |
| `/account` | Profile & notification preferences, sign out |
| `/account/addresses` | Saved addresses |
| `/membership` | Membership plans, status, history |
| `/support`, `/support/:ticketId` | Support tickets |
| `/notifications` | In-app notifications |
| `/signin` | Sign-in (phone OTP); also opens as a dialog from cart/checkout |

### Restaurant owner — `/restaurant`
| Route | Screen |
|---|---|
| `/restaurant/onboarding`, `/restaurant/onboarding/:restaurantId` | Onboarding wizard |
| `/restaurant` | Dashboard |
| `/restaurant/orders` | Live orders board |
| `/restaurant/orders/history` | Order history |
| `/restaurant/menu` | Menu management |
| `/restaurant/settings` | Store settings (hours, pause, profile) |
| `/restaurant/finance` | Earnings, ledger, payouts |

Owners can have multiple restaurants → a **restaurant switcher** is needed in the shell.

### Delivery partner — `/partner`
| Route | Screen |
|---|---|
| `/partner` | Home: online toggle, offers, active deliveries |
| `/partner/onboarding` | Partner onboarding |
| `/partner/history` | Delivery history |
| `/partner/earnings` | Earnings & payouts |

### Admin — `/admin`
| Route | Screen |
|---|---|
| `/admin/login` | Email + password, then TOTP (MFA) |
| `/admin` | Overview / metrics |
| `/admin/restaurants`, `/admin/restaurants/:id` | Restaurant approvals & management |
| `/admin/partners`, `/admin/partners/:id` | Partner approvals & management |
| `/admin/users` | Users & roles |
| `/admin/orders`, `/admin/orders/:checkoutId` | Order search & investigation |
| `/admin/tms` | Delivery operations (TMS) |
| `/admin/catalog` | Coupons, banners, cuisines, membership plans, service areas |
| `/admin/support`, `/admin/support/:id` | Support queue |
| `/admin/finance` | Refunds, balances, payouts, payments |
| `/admin/audit` | Audit log |
| `/admin/health` | System & integration health, dead letters, failed notifications |

**Guards:** consumer browsing is public; ordering requires sign-in. Restaurant area requires the owner role (onboarding start is open to any signed-in user). Partner area requires the partner role (onboarding start open). Admin requires admin + MFA. Server enforces everything; the UI shows "sign in" or "no access" states rather than hiding silently.

---

## 3. Global UX rules (must hold on every screen)

1. **Every data screen handles:** loading (skeletons), empty (helpful empty state + next action), validation errors (inline, per field), API failure (message + Retry), permission denied (explain + link), expired session (dialog "Session expired — sign in again", returns to the same page).
2. **Money:** always rupees with Indian grouping: `₹1,23,456.50`. Values come from the API in paise (integer); never round differently from the server. Negative amounts (refunds/discounts) shown with `−₹`.
3. **Time:** shown in IST. Relative times for live data ("updated 12s ago"). Countdowns for deadlines (restaurant accept window, partner offer expiry).
4. **Veg / non-veg markers (Indian FSSAI convention):** green square with green dot = veg; brown/red square with triangle = non-veg. Required on every dish and on "Pure veg" restaurants. Never colour-only — keep shape difference.
5. **Status chips:** every lifecycle status has a human label and a tone (see §8). Use consistently everywhere.
6. **Realtime with fallback:** live screens (order tracking, restaurant orders board, partner offers, notifications) update via server push. If the live connection drops, show a subtle notice "Live updates paused — refreshing every 10 s" and keep polling. Never pretend data is live when it isn't.
7. **Demo mode banner:** when the backend reports `mode = demo` or `sandbox`, a persistent, clearly visible banner ("DEMO MODE — no real money, SMS or deliveries" / "SANDBOX") is shown. Hidden in production. Demo data carries labels (e.g. "Demo estimate", "SIMULATED location", "DEMO PAYMENT").
8. **No dead UI:** no button without a real action, no fake counters, no hardcoded success messages. Success comes only from the server response.
9. **Accessibility (WCAG 2.1 AA intent):** labelled inputs, visible focus, keyboard navigation, 44px minimum touch targets, dialogs trap focus and close on Escape, status changes announced (aria-live), contrast ≥ 4.5:1 for text.
10. **Mobile-first:** consumers and partners are mostly on phones; restaurant owners on tablets/phones at the counter; admins on desktop (tables must collapse to cards on small screens).
11. **Idempotent actions:** pay / place order / refund / payout buttons must prevent double submission (disable + spinner) — the backend also protects it.

---

## 4. Consumer experience — screen by screen

### 4.1 Location selection (entry point, also a header control)
- Options: "Use my current location" (browser permission) or **drop a pin on a map**, or pick a **saved address** (signed-in).
- States: permission denied → explain + map fallback; outside service area → "We don't deliver here yet" (with map, try another location).
- Selected location persists across visits. Header always shows current delivery location; tapping changes it.

### 4.2 Home / discovery
Shows only restaurants that **can deliver to the selected address** (not merely nearby).
- **Banners** (admin-configured promos, may link to a restaurant/cuisine/coupon). Demo banners are labelled "DEMO".
- **Cuisine chips/carousel** (image + name) → filter.
- **Restaurant list/cards.** Each card data:
  - name, cover image/logo, cuisines, **Pure veg** badge or mixed
  - open/closed state (closed: "Opens at 6:00 PM" from `nextOpenAt`; paused: "Temporarily not accepting orders")
  - distance (km), **ETA in minutes** + source label ("estimate" / "demo estimate"), **delivery fee**
  - rating: `average (count)` **only if count ≥ 5**, otherwise "New" — never fake stars
  - price band (₹ / ₹₹ / ₹₹₹)
- **Filters:** veg only, cuisine, price band, open now. **Sort:** distance, delivery fee, ETA, rating.
- Empty state when nothing deliverable; error/retry.

### 4.3 Search
- Query searches restaurants **and dishes**. Results: restaurants (with matched dishes listed under each), deliverable only. Same card data as home.

### 4.4 Restaurant page
- Header: cover, name, cuisines, rating (or "New"), open state/hours, ETA, delivery fee, distance, description, "Pure veg" if applicable.
- Not deliverable to the current address → clear notice (reason: outside area / too far / closed), browsing still allowed, adding disabled.
- **Menu:** category navigation (sticky), items with name, description, price, image, veg marker, "Unavailable" (greyed, not addable), limited-stock items may show sold-out.
- **Item customizer (sheet/dialog):** customization groups — each has name, min/max selections (e.g. "Choose size — required, pick 1", "Add-ons — up to 3"), options with name, extra price (+₹40), veg marker, availability. Live total price. "Add" disabled until required groups are satisfied. Quantity stepper (max 20). Optional single-choice groups must be clearable.
- Same dish with different customizations becomes **separate cart lines**.
- Adding from a second restaurant is **allowed** (multi-restaurant cart) — no "replace cart?" prompt.

### 4.5 Cart (page + drawer)
- **Grouped by restaurant.** Each group: restaurant name, lines (name, selected options, qty stepper, line price, remove), group subtotal, note "Delivered separately" when more than one restaurant.
- Guest users can build a cart (stored server-side with a guest token) — it is **preserved after sign-in** (merged into the account).
- Empty cart state with "Browse restaurants".
- CTA: "Proceed to checkout" → requires sign-in (opens sign-in dialog, then continues).

### 4.6 Sign-in (phone OTP) — dialog or page
1. Enter Indian mobile number (accepts `98765 43210`, `+91…`, `0…`).
2. Receive 6-digit OTP (SMS). Enter code.
- Resend cooldown (30 s countdown); limits (too many requests → "Try again in N s").
- Wrong code → "Incorrect code". Too many attempts / expired → message + "Resend code".
- Demo mode: note "Demo: use 123456 for demo numbers".
- After success: return to where the user was; guest cart merged.

### 4.7 Checkout
- **Delivery address:** choose saved/default, or add new (map pin + line1, line2, landmark, city, pincode, label Home/Work/Other).
- **Coupon:** input + apply; available coupons list; errors (expired, min order ₹X, limit reached, first order only).
- **Membership:** toggle "Use Thali Plus benefits" if active (free deliveries left: X of Y; extra discount).
- **Price breakdown — per restaurant and total** (server-calculated):
  - Per restaurant: items subtotal, coupon share, membership discount share, packaging fee, delivery fee (and "free delivery" discount if applicable), platform fee, taxes (food GST, fees GST), **restaurant total**.
  - Overall total = sum of restaurant totals. Show clearly that each restaurant delivers separately.
- **Pre-payment validation results** (from server): restaurant closed, item unavailable, out of stock, address not serviceable, invalid customization → list problems with "Fix cart" links.
- **Price changed** → show old vs new total and ask to confirm.
- CTA: **"Pay ₹X"** (single tap protected against double submit).
- Payment: Razorpay hosted checkout popup (real) **or** the Demo Pay page (demo mode).

### 4.8 Demo Pay page (demo mode only)
- Big label "DEMO PAYMENT — no real money". Amount, order reference. Buttons: **Simulate success** / **Simulate failure**. Requires the same signed-in customer.

### 4.9 Checkout status (after payment)
- Never trusts the browser: shows **"Confirming your payment…"** until the server confirms.
- Outcomes:
  - **Placed** → "Order placed" + per-restaurant child orders + "Track order".
  - **Payment failed (retryable)** → "Payment failed — try again" (reopens payment for the same order; cart and stock hold kept until expiry ~15 min).
  - **Expired / payment failed (final)** → "This checkout expired — your cart is still saved".
  - **Cancelled** → neutral "This order was cancelled" (never "Order placed").
- Safe to leave and come back (status resumes).

### 4.10 Orders list
- Each order (one checkout): order code (e.g. `TH-6Q2HBCW6`), date/time, overall status, total paid, refunded amount / "refund pending", restaurants with per-restaurant status chips, item count. Paginated.

### 4.11 Order detail + tracking (key screen)
- Header: order code, overall status, placed time, delivery address.
- **One card per restaurant (child order):**
  - restaurant name, items with options, child total
  - **status timeline:** Placed → Accepted → Preparing → Ready → Picked up → On the way → Delivered (with times)
  - **delivery code** (4 digits) the customer gives the rider at the door
  - **live tracking map** (when assigned): rider marker, rider first name + vehicle type, "updated Xs ago", **stale warning** if no update > 60 s, "SIMULATED" label if demo simulation; ETA if available
  - rejection / cancellation / delivery failure → **explanation sentence from server**, e.g. "Green Leaf declined your order (Out of stock). ₹218.10 refund initiated." + reason
  - refund chip: "Refund initiated" / "Refund processing" / **"Refunded ₹X"** / "Refund failed"
  - **Cancel** button only when the server says it's cancellable (before restaurant accepts)
- **Totals card:** Paid, Refunded, Refund pending, **Net paid**, and "Net after pending refund" while a refund is pending.
- Actions: Reorder (adds available items to cart; shows what changed — price changes, unavailable items, closed restaurant), Get help (support ticket for this order), Rate restaurant (1–5 stars, after delivery, once).

### 4.12 Profile / account
- Name, phone (read-only), optional email; notification preferences (order SMS, order email, marketing SMS, marketing email); sign out; sign out of all devices.

### 4.13 Saved addresses
- List (max 10), default badge, add/edit (map pin + fields), delete, set default.

### 4.14 Membership ("Thali Plus")
- Plans: name, price, duration (days), benefits (free deliveries per period above min order, extra discount % with cap), **terms** (must be visible before buying).
- Current membership: status (Active / Awaiting payment / Expired), valid till, free deliveries remaining. Buy disabled while one is active (explain why).
- Purchase uses the same payment flow (Razorpay / demo pay). Purchase history.

### 4.15 Support
- Create ticket: subject, category (Order issue, Payment, Delivery, Account, Other), message, optional linked order. Ticket list with status; ticket thread (customer ↔ support messages), reply box.

### 4.16 Notifications
- In-app list: title, body, time, read/unread, link to the related order/ticket/membership. Mark as read.

---

## 5. Restaurant owner experience

### 5.1 Onboarding wizard (multi-step, saves each step)
Steps: **Business** (business name, restaurant name, owner contact, phone, business email, cuisines, description) → **Location** (address + map pin, delivery radius) → **Hours** (weekly, per day; overnight allowed e.g. 18:00–02:00) → **Media** (cover, logo; JPG/PNG/WebP ≤ 2 MB) → **Documents** (FSSAI, GST, PAN; PDF/JPG/PNG ≤ 5 MB; private) → **Settlement** (account holder, bank account number, IFSC; after save only "ending 9012" is ever shown) → **Review & submit** (lists missing fields with "Fix" links).
Uploads: progress, file-type/size errors, server rejection of fake files.

**Status banner (always visible in the restaurant area):**
| State | Banner |
|---|---|
| Draft | "Finish setting up your restaurant" |
| Email verification pending | "Verify your business email" + **Resend** (60 s cooldown; daily cap) |
| Awaiting approval | "Our team is reviewing your restaurant" |
| Rejected | Reason + "Edit and resubmit" |
| Suspended | Reason + contact support |
| Approved but paused | "Not accepting orders until 3:30 PM" + Resume |

Only Approved restaurants appear to customers.

### 5.2 Dashboard
- Today (IST): orders total, acceptance rate (%), average time to accept, revenue (gross / net) — **real stored data only**; if stats unavailable show "Order stats unavailable" + retry (never zeros).
- Rating (average, count), menu health (items, unavailable count), open/closed/paused state.

### 5.3 Live orders board (most-used screen)
- Columns or sections by status: **New** (Placed) → **Accepted / Preparing** → **Ready for pickup**.
- New order arrives in realtime: highlight + optional chime (enabled after a user tap; respect reduced motion) + aria announcement.
- Order card: order code, time placed, items with options & notes, customer first name + masked phone, total, **accept-by countdown** (default 5 min; after it expires the order is auto-rejected), pickup code (shown once accepted, given to the rider), delivery partner status when assigned.
- Actions (only those the server allows for that status): **Accept** (choose prep time 5–120 min), **Reject** (reason required: out of stock, kitchen busy, closing soon, other + text), **Start preparing**, **Mark ready**, update prep time.
- Realtime + 10 s polling fallback indicator.

### 5.4 Order history
- Filter by status (multi-select); list with code, date, status, total, refund status; order detail dialog.

### 5.5 Menu management
- Categories: create, rename, reorder (up/down), activate/deactivate.
- Items: name, description, price, veg flag, image, category, tags, availability toggle, **stock tracking** (stock qty; reserved qty shown; can't set stock below reserved), customization groups editor (group name, min/max, options with price/veg/availability; validation min ≤ max ≤ options count).
- Quick availability toggles from the list.

### 5.6 Store settings
- Weekly hours editor (multiple days, overnight), temporary pause (15/30/60 min or custom) / resume, profile fields, settlement details (masked), delivery radius, packaging fee.

### 5.7 Finance
- Summary: earnings, commission, refunds/adjustments, balance, **available for payout**.
- Ledger table: date, type (Order earning, Commission, Refund adjustment, Payout, Manual adjustment), order code, amount (+/−), memo.
- Payouts: amount, status (Requested / Processing / Paid / Failed), **UTR** (bank reference). **Never show "Paid" without a UTR.** Payouts are recorded after a manual bank transfer by Thali.

---

## 6. Delivery partner experience

### 6.1 Onboarding
- Profile (name), vehicle (type: bike, scooter, bicycle, car; registration number), documents (ID proof; driving licence + vehicle RC for motorised vehicles), submit. Status: Draft → Awaiting approval → Approved / Rejected (reason, resubmit) / Suspended (reason). Vehicle can't be changed while under review. Demo mode may mark documents "demo-verified" but never auto-approves.

### 6.2 Home (single-screen cockpit, phone-first)
- **Online / Offline toggle.** Going online requires location permission (explain if denied). While online the app shares location every ~5 s: "Location sharing active · last sent 3s ago" / "paused". Cannot go offline while holding an active delivery ("Complete it, or ask Thali ops to reassign it").
- **Offers** (realtime + polling): pickup restaurant + area, drop area, distance, estimated minutes, **countdown** (default 45 s), **batching explanation** when it would be a 2nd simultaneous delivery (e.g. "pickup 0.8 km ≤ 1.5 km ✓", "extra time 8 min ≤ 12 min ✓"), Accept / Decline. If someone else got it: "Taken by another partner"; if timed out: "Offer expired".
- **Active deliveries** (max 2): step flow per delivery
  1. Head to restaurant (address, **navigation link** to Google Maps, call restaurant) → "Arrived"
  2. Pickup: enter the restaurant's **4-digit pickup code** → Picked up
  3. "Start delivery" → head to customer (address, landmark, masked phone, navigation)
  4. Deliver: enter the customer's **4-digit delivery code** → Delivered
  - Wrong code: "X attempts left"; after 5 wrong → locked, contact ops.
  - "Can't deliver" → reason (customer unreachable, address not found, other).
- A panel explaining **browser limits**: location pauses when the app is in the background or the screen is locked; keep it open while delivering.
- Location sharing continues when moving between partner pages.

### 6.3 History & earnings
- Past deliveries (date, restaurant, distance, status, earning). Earnings summary, ledger, payouts (same UTR rule as restaurants).

---

## 7. Admin experience (desktop-first, dense but clear)

- **Login:** email + password → TOTP 6-digit code. First login: MFA setup screen (show otpauth URI + manual secret key; no QR library), confirm code, then sign in again. Lockout after repeated failures.
- **Overview:** today's orders by status, GMV, active/online partners, pending approvals (restaurants, partners), unassigned deliveries, failed refunds — all real numbers.
- **Restaurants:** list filtered by status; detail with all onboarding data, documents (open via short-lived secure link; image/PDF preview), email-verified state, status history; actions **Approve / Reject (reason) / Suspend (reason) / Reinstate**, verify document. Approve is impossible before email verification (show why).
- **Partners:** same pattern (documents, vehicle, approve/reject/suspend/reinstate).
- **Users:** search by phone/name, roles, status, block/unblock (reason).
- **Orders:** search by code / phone / restaurant / status / date; investigation page: full timeline of events, per-child status, payment, refunds, delivery; actions: cancel a child with refund amount (≤ remaining refundable, validated), allowed admin status changes (with reason).
- **TMS (deliveries):** unassigned / exception jobs (no partner found after several rounds), assign / reassign to an online approved partner (picker with distance), unassign, mark failed (reason); demo-only "simulate movement" button.
- **Catalog:** coupons (code, flat/percent, cap, min order, validity, total & per-user limits, first-order-only, active), banners (image, link target, schedule), cuisines, membership plans (price, duration, benefits, terms), **service areas** (polygon drawn on a map — clickable corners, keyboard "add corner at map centre" and lat/lng inputs; delivery fee rule: base fee, base km, per-km fee, max fee; minimum order).
- **Support:** queue (status, priority, assignee), ticket thread, reply, change status.
- **Finance:** refunds by status (retry failed), manual refund (pick exact payment → amount ≤ refundable; optional child order / restaurant charge), balances per restaurant/partner, payouts: create (requested) → confirm with **UTR** → Paid, or mark failed. Payment search.
- **Audit log:** who did what, when, target, summary, IP — filterable.
- **Health:** per service (identity, marketplace, orders, payments, delivery, notifications, gateway): status up/degraded/**down with real error text**, database & Redis status, event backlog/lag, dead-lettered events (with **Replay**), failed notifications (with **Retry**), provider error counts, "last checked" + Refresh. **Never show a decorative "All systems healthy".** Demo-only notification fail-mode switch.

Admin sub-roles (SUPER_ADMIN, OPS, FINANCE, SUPPORT) limit which actions are offered; hide or disable actions the role can't perform, with a short explanation.

---

## 8. Status vocabulary (labels + tone) — use everywhere

Tone meaning: **success** green, **warn** amber, **danger** red, **info** blue, **brand** saffron, **neutral** grey.

| Entity | Status → label (tone) |
|---|---|
| Child order (per restaurant) | Awaiting payment (warn) · Placed (info) · Accepted (brand) · Preparing (brand) · Ready for pickup (brand) · Picked up (info) · Out for delivery (info) · Delivered (success) · Delivery failed (danger) · Payment failed (danger) · Expired (neutral) · Rejected by restaurant (danger) · Cancelled (neutral) |
| Checkout (whole order) | Awaiting payment (warn) · Order placed (info) · In progress (brand) · Completed (success) · Partially completed (warn) · Cancelled (neutral) · Payment failed (danger) · Expired (neutral) |
| Payment | Pending (warn) · Authorized (info) · Paid (success) · Failed (danger) · Partially refunded (info) · Refunded (neutral) |
| Refund | No refund (neutral) · Refund initiated (info) · Refund processing (info) · Refunded (success) · Refund failed (danger) |
| Delivery | Finding a partner (warn) · Offered to partner (warn) · Partner assigned (info) · At restaurant (info) · Picked up (brand) · On the way (brand) · Delivered (success) · Delivery failed (danger) · Cancelled (neutral) |
| Restaurant onboarding | Draft · Email verification pending · Awaiting approval · Approved · Rejected · Suspended |
| Partner | Draft · Awaiting approval · Approved · Rejected · Suspended |
| Offer | New offer · Accepted · Declined · Expired · Withdrawn |
| Payout | Requested · Processing · Paid (only with UTR) · Failed · Cancelled |
| Ticket | Open · In progress · Resolved · Closed |
| Membership | Awaiting payment · Active · Expired · Cancelled |
| Notification (admin) | Queued · Sending · Sent · Delivered · Failed, retrying · Gave up · Skipped |

Overall order status is **derived** from its parts: all delivered → Completed; some delivered + some rejected/cancelled → Partially completed; none delivered and all ended → Cancelled.

---

## 9. Key end-to-end flows to design for

**A. Guest → multi-restaurant order**
Pick location → browse deliverable restaurants → add dishes from Restaurant A and B (customizer) → cart grouped A/B "delivered separately" → sign in with OTP (cart kept) → checkout: address, coupon, membership → per-restaurant breakdown + total → Pay → "Confirming payment…" → Order placed → order detail with two cards.

**B. Partial rejection (must feel calm and clear)**
A accepts, B rejects with reason → B card shows "Green Leaf declined your order (Out of stock)" + "Refund initiated ₹218.10" → later "Refunded ₹218.10"; A continues to delivery; totals card shows Paid ₹646.20, Refunded ₹218.10, Net ₹428.10; overall status "Partially completed" once A is delivered.

**C. Restaurant handles an order**
New order chime + card with 5-min countdown → Accept with prep time → Start preparing → Mark ready (pickup code visible) → rider arrives, gives code.

**D. Partner delivery**
Go online (location permission) → offer with countdown (+ batching reasons) → Accept → navigate → Arrived → enter pickup code → Start delivery → navigate → enter customer's delivery code → Delivered → earnings updated.

**E. Restaurant activation**
Sign up → wizard → submit → verify business email (link in email) → admin approves → banner disappears, restaurant visible to customers.

**F. Payment edge cases the UI must handle**
Payment failed → retry same order; user closes payment window → status page resumes later; price changed before payment → confirm new total; restaurant closed / item sold out during checkout → problems list; stale/duplicate taps → single order.

---

## 10. Data the UI receives (key objects, simplified)

- **Restaurant card:** id, slug, name, cuisines[], imageUrl, pureVeg flag, open, nextOpenAt, distanceKm, deliveryFeePaise, etaMinutes, etaSource (GOOGLE / DEMO_HAVERSINE / HAVERSINE_FALLBACK), rating {average, count} | null, priceBand, isDemo.
- **Menu item:** id, name, description, pricePaise, isVeg, imageUrl, available, trackStock, availableQty, customizationGroups[{name, minSelect, maxSelect, options[{name, pricePaise, isVeg, available}]}].
- **Cart:** lines grouped by restaurant: {lineId, itemId, name, isVeg, unitPricePaise, quantity, selections, addOns}; per-restaurant subtotal; cartVersion.
- **Price breakdown (per restaurant and total):** itemsSubtotal, couponDiscount, membershipDiscount, packagingFee, deliveryFee, deliveryDiscount, platformFee, foodTax, feeTax, total (all paise).
- **Checkout / order:** id, code, status, paymentStatus, expiresAt, deliveryAddress, pricing, children[], adjustedTotals {paidPaise, refundedPaise, refundPendingPaise, netPaise}, explanations[{childOrderId, kind, message, restaurantName, reason, refundPaise}].
- **Child order (customer view):** id, code, restaurantName, status, statusHistory[{to, at}], lines, breakdown, refundStatus, refundRequestedPaise, refundedPaise, deliveryStatus, deliveryCode, canCancel, partner {firstName, vehicleType}.
- **Tracking:** status, partner, location {lat, lng}, lastLocationAt, stale, simulated.
- **Owner order:** id, code, status, acceptBy, prepMinutes, lines, customer {name, phoneMasked}, total, pickupCode, allowedTransitions[], refundStatus.
- **Offer:** id, jobId, expiresAt, pickup {name, address}, drop {area}, distanceKm, estimatedMinutes, batchEvaluation {eligible, reasons[]}.
- **Finance:** summary {earnings, commission, refunds, balance, available}, ledger entries {type, amountPaise, childOrderCode, memo, createdAt}, payouts {amountPaise, status, utr, confirmedAt}.

Server errors arrive as `{ error: { code, message, details } }` — map codes to friendly copy (e.g. `NOT_SERVICEABLE`, `RESTAURANT_CLOSED`, `OUT_OF_STOCK`, `PRICE_CHANGED`, `COUPON_INVALID`, `COUPON_LIMIT_REACHED`, `OTP_INVALID`, `OTP_EXPIRED`, `RATE_LIMITED` (with retry-after), `ORDER_ACCEPT_WINDOW_EXPIRED`, `ASSIGNMENT_TAKEN`, `OFFER_EXPIRED`, `DELIVERY_CODE_INVALID`/`LOCKED`, `PARTNER_HAS_ACTIVE_JOBS`, `REFUND_EXCEEDS_REMAINING`, `FORBIDDEN`, `UNAUTHENTICATED`, `SESSION_REVOKED`). Unknown codes → show the server message.

---

## 11. Current visual system (starting point — may be replaced)

- **Personality:** warm, appetizing, trustworthy, calm; Indian food context without clichés.
- **Brand colour:** saffron — `#E8590C` (accents/focus, non-text), `#C2410C` (primary buttons, white text), `#9A3412` (brand text/links). Neutrals: slate. Warm canvas `#FBF9F7`, surface `#FFFEFD`, muted `#F6F3F0`.
- **Semantic:** success green, warn amber, danger red, info blue (AA-checked shades). Veg `#15803D`, non-veg `#8A3214`.
- **Shape:** control radius 10px, card radius 16px, pills. Low warm shadows. 44px touch targets. Content max width 72rem.
- **Type:** system UI sans; monospace for codes (order codes, pickup/delivery codes, UTR).
- **Existing component set (reusable):** Button, Input, Select, Checkbox, Radio, Field (label/hint/error), Dialog/Sheet, ConfirmDialog (with required reason), Tabs, Card, Badge, StatusPill, Price, Countdown, RelativeTime, Skeleton, Spinner, EmptyState, ErrorState, QueryState (loading/empty/error/forbidden wrapper), DataTable (table on desktop, cards on mobile), Pagination, Toast, Map (Leaflet + OpenStreetMap), Icon set (inline SVG), PageHeader, FormActions, AppShell/RoleNav (per-role shells), ModeBanner, RealtimeStatus, SessionExpired dialog.
- Tech for implementation reference: React 19 + TypeScript, Vite, Tailwind CSS v4 (tokens via `@theme`), React Router 7, TanStack Query, Leaflet maps. No icon or UI kit dependency beyond these (adding one is possible but should be justified).

---

## 12. Redesign constraints & freedoms

**Free to change:** visual language, layout, information architecture, navigation patterns (tabs/bottom nav/sidebars), component styling, illustrations, motion, copy tone, grouping of screens, route names.

**Must keep (functional/compliance):**
- Every screen and action listed above (they are backed by real APIs).
- Multi-restaurant transparency: per-restaurant groups, per-restaurant breakdowns, "delivered separately", per-restaurant tracking and refunds.
- Server is the source of truth for prices, totals, statuses, allowed actions, countdown deadlines.
- Honest data labels (demo estimate, simulated location, demo payment, rating hidden under 5 reviews, "Paid" payouts only with UTR, health shows real down/up).
- Veg/non-veg markers with shape + colour.
- Accessibility rules in §3, mobile-first for consumer/partner.
- Demo/sandbox banner; production shows none.
- Security UX: OTP limits/cooldowns visible, admin MFA, settlement account numbers masked (last 4 only), documents only via secure links.

**Good opportunities for the redesign:**
- A delightful but clear multi-restaurant cart & checkout (visual grouping, "2 deliveries" summary).
- A strong order-tracking experience (timeline + map per restaurant, calm handling of partial rejections/refunds).
- A fast, glanceable restaurant order board for kitchen use (big tap targets, countdown urgency, sound).
- A one-hand partner cockpit (online toggle, offer card with countdown, step-by-step delivery with code entry).
- Data-dense but readable admin tables with good filters and investigation timelines.

---

## 13. Demo accounts (for walkthroughs in demo mode)

- Consumers: phones `9000000001`–`9000000003`, OTP `123456`.
- Restaurant owners: `9100000001` (Spice Route — non-veg biryani), `9100000002` (Green Leaf — pure veg). OTP `123456`.
- Delivery partners: `9200000001`, `9200000002`. OTP `123456`.
- Admin: `admin@thali.demo` / `ThaliDemo#2026` + TOTP secret `THALIDEMOTOTPSECRETKEY234567ABCD`.
- Seeded demo order showing a partial rejection: `TH-DEMOMULTI` (A delivered, B rejected + refunded).
- Local URLs: app `http://localhost:5173`, API docs `http://localhost:8080/api/docs`.
