# Thali UI Redesign + Backend Alignment + Bengaluru Seed — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Re-implement the whole web app in the "Masala" design system from the Claude Design export, give every button in it a working backend, and replace the 4-restaurant demo with a realistic Bengaluru dataset (~600 restaurants, ~15k dishes with real CC-licensed photos, ~1,000 consumers, ~250 partners, thousands of historical orders).

**Architecture:** Same MERN microservices (7 services + gateway, Redis Streams outbox, MongoDB per service). Shared-package changes land first, then one agent per service extends its own routes/models in parallel, while a frontend foundation agent rebuilds tokens/shells/components. Then a deterministic generator seeds Bengaluru across all service DBs consistently, while four role-area agents rebuild their screens on the new foundation. Finish with e2e, docs and a whole-branch review.

**Tech Stack:** Node 22, TS 5.9, Express 5, Mongoose 8, ioredis, Zod 4, vitest 4; React 19, Vite 7, Tailwind v4, React Router 7, TanStack Query; Playwright.

**Spec (binding, in priority order):**
1. Design: `.superpowers/sdd/2026-10-11-ui-redesign/design-spec.md` + `design/` (boards, screenshots, fonts).
2. Backend contracts: `.superpowers/sdd/2026-10-11-ui-redesign/gap-analysis.md` §2 (gap ids MKT-n, ORD-n, DLV-n, PAY-n, NTF-n, IDN-n, GW-n), §3 (model additions, image handling), §5 (seed), §6 (must-not-lose).
3. Existing contracts: `docs/03-LLD.md`, `docs/04-ADR.md`, `docs/ui-redesign-context.md`.
4. Seed data: `scripts/seed-data/*.json` + `scripts/seed-data/README.md`.

## Global Constraints
- Branch `feat/ui-redesign`. Path-scoped commits only (`git commit -m ... -- <paths>`), message ends `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Honest-data rule stays: ratings only from real rated delivered orders, "New" under 5 ratings; estimates labelled `EST.`/source; simulated things labelled; payouts "Paid" only with UTR; demo-only behaviour 404s outside `APP_MODE=demo`.
- Money integer paise; IST display; all existing tests must stay green (update tests only where a contract intentionally changed, and say so).
- Every new public route: zod-validated, OpenAPI-registered (coverage test), auth/roles per gap-analysis, audited if privileged, rate-limited where gap-analysis says.
- Existing demo story stays intact: demo accounts, TH-DEMOMULTI/TH-DEMODONE/TH-DEMOCNCL, spice-route/green-leaf etc. (smoke + e2e depend on them). Bengaluru data is additive (ids `seedId('blr:...')`).
- No dead buttons: every interactive element in design-spec §5 tables must do the thing described, or be removed with a ledger ruling.
- Frontend: mobile-first responsive, light + dark themes, accessible (labels, keyboard, focus, aria-live), loading/empty/error/forbidden/session-expired states on every data screen.

## Rulings already made (from gap-analysis open questions)
- Paused restaurants are shown as "Not accepting orders" (MKT-3) — design overrules PRD C-2; record ADR-34.
- Scope = all P0 + P1 + these P2: MKT-8 (scoped coupon badge), MKT-9 (recommended), MKT-11 (facets), MKT-12 (closesAt), MKT-14 (ratings/mine), NTF-2, NTF-3, ORD-7, IDN-3 (avatars — user asked for real profile photos), GW-3. Skipped: GW-2 (show consumerLag/outbox age instead of "webhook p95"), DLV-9, ORD-8 (cart dock reuses discovery ETA).
- IDN-1: email reset link + TOTP (not super-admin reset).
- Images: seed mirrors the CC image pool + avatars into the MinIO public bucket under `images/pool/` and `images/avatars/` (download cache `.cache/seed-images/`, gitignored) and references them as keys; `resolveImageUrl` also accepts allowlisted absolute https URLs (fallback when offline, and admin catalog).
- City-wide data needs one Bengaluru service-area polygon; switching requires `npm run stack:down -- -v` (fresh volumes) before seeding — documented in README/runbook.

---

### Task 1: Shared packages (contracts, service-kit, pricing)
**Owner paths:** `packages/**`
- [ ] contracts: `EventDrop.area`, `EventDrop.label`; `order.accepted` += `childOrderCode`, `checkoutCode`, `pickup.phone?`; new event `delivery.arrived` (DeliveryAtPayload) in catalog; `RestaurantAddressSchema.locality`; address schemas `locality`/`formattedAddress`; cart preview + checkout request `restaurantIds?: string[]` (1–10); new error codes `PURE_VEG_VIOLATION`; DiscoveryItem/PublicMenuItem shared types if they live in contracts.
- [ ] service-kit: `resolveImageUrl(storage, ref, allowHosts)` + `EXTERNAL_IMAGE_HOSTS` config parsing; `recordProviderError(..., message?)` storing scrubbed last message + `healthDetails.lastProviderErrors`; `ensureDocsBulk(model, docs, report, {chunk})`; `GeoProvider` optional `autocomplete`, `placeDetails`, `reverse` (Google adapter implements via Places (New)/Geocoding; demo adapter leaves them undefined — marketplace falls back to its gazetteer); consumer-side handled-latency is NOT needed (GW-2 skipped).
- [ ] pricing: coupon with `restaurantIds` allocates only across eligible children; `NOT_APPLICABLE` when none (MKT-8).
- [ ] Tests for each (TDD), `npm run build` for packages green, all package tests green.

### Task 2: marketplace — MKT-1…MKT-14
**Owner paths:** `services/marketplace/**` (not `src/seed.ts` — Task 8 owns it)
- [ ] MKT-1 places/autocomplete/details/reverse with `localities` collection (+ indexes) and Redis caching, gazetteer fallback labelled; a small gazetteer seed loader reading `scripts/seed-data/localities.json` exported as a function Task 8 calls.
- [ ] MKT-2 counts, MKT-11 facets, MKT-3 paused shown + `closedReason/pausedUntil/acceptingOrders`, MKT-12 `closesAt`.
- [ ] MKT-4 `pureVeg` + violations, MKT-5 `address.locality` everywhere, MKT-6 `unavailableReason/stockLeft`, MKT-7 guest offers + `offerHeadline`/`eligibility`, MKT-8 scoped coupons + `badgeLabel` + discovery `offer`, MKT-9 `featured` + `recommended[]`, MKT-10 `resolveImageUrl` at all view call sites, MKT-13 `menuStats` denormalised + `{status,location}` index + list-time haversine ETA + cached ordered ids + indexed item search, MKT-14 `ratings/mine`.
- [ ] Admin endpoints needed by the design: restaurants list `status` counts for sidebar badges if not present.
- [ ] OpenAPI + tests; `npx vitest run --project @thali/marketplace` green.

### Task 3: orders — ORD-1,2,3,4,5,7
**Owner paths:** `services/orders/**` (not `src/seed.ts`)
- [ ] ORD-1 `/admin/orders/checkouts` + `customerContact` on groups + indexes; ORD-2 overview `today.byStatus/refundedPaise/refundPendingPaise/support`; ORD-3 `restaurantIds` subset checkout + `restaurantSetKey` index migration (create new, drop old in `ensureIndexes`); ORD-4 restaurant point in customer view; ORD-5 consume `delivery.arrived` → `AT_PICKUP` + realtime; ORD-7 `phoneLast4` + phone search; emit new `order.accepted` fields (codes, `drop.area/label`, `pickup.phone`) and copy `locality` into snapshots; indexes from gap-analysis §5.2.9.
- [ ] OpenAPI + tests green.

### Task 4: delivery — DLV-1…DLV-7
**Owner paths:** `services/delivery/**` (not `src/seed.ts`)
- [ ] DLV-1 contact endpoint (DIRECT/DEMO modes, audited, rate-limited); DLV-2 offer privacy (area only) + `drop.label`; DLV-3 `remaining` ETA with 30 s cache + `remainingMinutes` on realtime; DLV-4 codes on jobs + search; DLV-5 overview counts; DLV-6 emit `delivery.arrived`; DLV-7 assign picker filters/sort by distance to pickup; history index.
- [ ] OpenAPI + tests green.

### Task 5: payments + notifications — PAY-1, NTF-1, NTF-2, NTF-3
**Owner paths:** `services/payments/**`, `services/notifications/**` (not seeds)
- [ ] PAY-1 windowed earnings on partner + restaurant summaries (default today IST).
- [ ] NTF-1 summary, NTF-2 bulk retry (audited), NTF-3 bulk dead-letter replay fan-out.
- [ ] OpenAPI + tests green.

### Task 6: identity + gateway — IDN-1, IDN-2, IDN-3, GW-1, GW-3, demo phone prefixes
**Owner paths:** `services/identity/**`, `services/gateway/**` (not seeds)
- [ ] IDN-1 forgot/reset (token hashed, 30 min, TOTP required, sessions revoked, audited, rate-limited, email template via notifications send); IDN-2 address `locality/formattedAddress`; IDN-3 `avatarKey` (+ absolute allowlisted URL support via `resolveImageUrl`), `PATCH /me`, presign `/me/uploads`, `avatarUrl` in views and in `/internal/users/:id`; `DEMO_PHONE_PREFIXES` (demo mode only) so generated Bengaluru users can sign in with the demo OTP.
- [ ] GW-1 health `degradedReasons/summary/providers`; GW-3 `/meta.city`.
- [ ] If notifications needs a new template for the reset email, coordinate: Task 6 adds the template name to the brief's list; Task 5 owns notifications templates — put the template in Task 5's scope (`ADMIN_PASSWORD_RESET`).
- [ ] OpenAPI + tests green.

### Task 7: Frontend foundation — design system, shells, public site, sign-in
**Owner paths:** `apps/web/src/styles.css`, `apps/web/src/components/**`, `apps/web/src/lib/**`, `apps/web/src/hooks/**`, `apps/web/src/routes.tsx`, `apps/web/src/main.tsx`, `apps/web/src/App*.tsx`, new `apps/web/src/features/public/**`, `apps/web/test/foundation/**` (+ existing foundation tests), `apps/web/package.json` (fonts only), `apps/web/public/**`.
- [ ] Tokens light/dark (design-spec §1) in Tailwind v4 `@theme`; theme provider (localStorage + prefers-color-scheme, toggle); self-hosted fonts.
- [ ] Rebuild every shared UI component to design-spec §3 keeping existing exported names/props where possible (so feature code keeps compiling), add new ones (CountdownRing, CodeDigits, Stepper, KpiTile, StackedBar, RestaurantCard, CuisineCircle, CartDock, StatusPill tones, VegMark, EstBadge, LiveIndicator, Avatar with photo, Skeleton, Toggle, SegmentedTabs, PhoneInput, Sidebar shell with badges/role tag, Top navs).
- [ ] Shells: public/consumer top nav (location chip, search, Orders, bell, theme, avatar), checkout nav, role sidebar shell (KITCHEN/PARTNER/OPS) with bottom user block + theme toggle, demo banner variants; responsive rules (§6).
- [ ] Public landing (board 00) at `/` for signed-out visitors (address autocomplete via MKT-1 `places`, Use my location via `reverse`, Find food → sets location and goes to discover), static Terms/Privacy/Refunds/Help pages, Partner-with-us and Ride-with-Thali pages linking to onboarding sign-in.
- [ ] Unified sign-in (board 01) with 4 role tabs (OTP for customer/restaurant/partner, email+password+MFA for admin, admin Forgot? → IDN-1 pages), right-side role panel copy.
- [ ] Tests + `npm run build -w @thali/web` green (feature areas may still look old — fine at this point).

### Task 8: Bengaluru seed generator + image mirror + live traffic script
**Owner paths:** `packages/contracts/src/seed-blr*.ts` (+ export entry), `services/*/src/seed.ts` (+ new `services/*/src/seed-blr.ts`), `scripts/seed.ts`, `scripts/seed-images.ts`, `scripts/demo-traffic.ts`, `.gitignore` (`.cache/`), root `package.json` scripts (only adding `seed:images`, `demo:traffic`).
- [ ] Deterministic PRNG generators per gap-analysis §5.2 over `scripts/seed-data`: ~600 restaurants across localities (≈18% pure veg, owners some with 2–3 restaurants, hours incl. some closed-now/opens-later, `pureVeg`, `locality`, packaging fee, prep minutes, covers from pool, featured items), menus (~25 items each from dishes.json with photos, variants/addons, a few sold-out/unavailable), ~1,000 consumers (avatars, 1–3 addresses with locality), ~250 partners (vehicles, KA plates, avatars; mostly approved; some pending/suspended), ~5k historical checkouts priced with `priceCheckout`, consistent delivery jobs, payments/ledger/refunds, ratings (≈20% restaurants under 5), weekly payouts with UTRs, scoped coupons with badges, notifications.
- [ ] One city-wide Bengaluru service area; localities gazetteer seeded (Task 2 loader).
- [ ] `ensureDocsBulk` everywhere for scale; whole seed < 3 min on a laptop; idempotent re-run.
- [ ] `scripts/seed-images.ts`: download pool + avatars (concurrency 8, cache), upload to MinIO public bucket; seed references keys; falls back to absolute URLs.
- [ ] `scripts/demo-traffic.ts`: places N live orders through public APIs and walks some through accept/ready/pickup/deliver so boards are alive.
- [ ] Verify: fresh `stack:down -v && stack:up && seed` then counts per collection, smoke 26/26 still passing.

### Task 9: Consumer screens
**Owner paths:** `apps/web/src/features/consumer/**`, `apps/web/test/consumer/**`
- [ ] Boards 10–13 exactly (discover with filters/sort/counts/facets/offers badges/paused cards + cart dock; restaurant page with recommended + sections + customizer; checkout incl. per-restaurant checkout via `restaurantIds`; tracking with remaining ETA, map with restaurant point, timeline, rider, code, refund progress, payment card, Get help, Reorder, rate after delivery via ratings/mine) + all must-not-lose consumer screens restyled; Offers page (guest), avatar in header.

### Task 10: Restaurant owner screens
**Owner paths:** `apps/web/src/features/restaurant/**`, `apps/web/test/restaurant/**`
- [ ] Board 20 exactly (switcher, KPIs, Chime, Pause, kanban New/Preparing/Ready with countdown, prep choice, progress, rider at restaurant, pickup code) + dashboard/history/menu (featured toggle, pureVeg)/settings (locality)/finance (today window)/onboarding restyled.

### Task 11: Delivery partner screens
**Owner paths:** `apps/web/src/features/partner/**`, `apps/web/test/partner/**`
- [ ] Board 30 exactly (online toggle + heartbeat, offer card with area-only drop/countdown/2nd-delivery/fit list, active delivery stepper incl. pickup steps, Navigate, Call via DLV-1, code entry with attempts, Can't deliver, Today window via PAY-1, last payout UTR, tips panel) + history/earnings/profile-documents/onboarding restyled.

### Task 12: Admin screens
**Owner paths:** `apps/web/src/features/admin/**`, `apps/web/test/admin/**`
- [ ] Board 40 exactly (KPIs incl. partners online/on delivery/unassigned/approvals/failed refunds, status bar, Needs attention with Assign (DLV-7 picker)/Approve/Review, system health with reasons, dead letters Replay (NTF-3), failed notifications Retry (NTF-2), recent orders via ORD-1 with filters, ⌘K global search orders/phones/users, sidebar badges) + every other admin page restyled.

### Task 13: e2e, docs, verification
**Owner paths:** `e2e/**`, `docs/**`, `README.md`, `scripts/smoke.ts`
- [ ] Update Playwright specs for new markup; add specs for landing→address→discover, per-restaurant checkout, partner call (demo), admin retry/replay.
- [ ] Docs: ADR-34 (paused shown), ADR-35 (external image refs + mirrored pool), ADR-36 (Bengaluru seed generator), LLD amendments for every new route/field/event, 09-api, runbook (fresh-volume reseed), CREDITS link, README demo section.
- [ ] Full verification on fresh volumes: build, all unit/integration tests, seed, smoke, e2e.

## Review Focus
1. Offer payload privacy: an offered (not assigned) partner must never receive customer name, full address or exact drop point (DLV-2) — test it.
2. Subset checkout: checking out one restaurant must leave other cart groups intact and allow a second checkout on the same cart version (ORD-3).
3. Seed consistency: every rating maps to a delivered child; restaurant ratingCount == ratings count; ledger balances ≥ 0; coupon usedCount == redemptions.
4. Discovery at scale: a drop in central Bengaluru returns pages fast (<300 ms p95 locally) and counts/facets stable across pages.
5. Dark mode: every screen legible (no hard-coded light colours), contrast per design-spec.
