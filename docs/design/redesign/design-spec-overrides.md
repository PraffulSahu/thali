# Overrides to design-spec.md (controller rulings — these win over design-spec §8 fallbacks)

Backend work in the plan replaces every "hide it / link to Health instead" fallback in design-spec §8. Build the real control against these contracts (gap-analysis.md §2):

| Design element | Build it against |
|---|---|
| Landing/header typed address, "Find food", "Use my location" | MKT-1 `GET /api/v1/discovery/places?q=`, `/places/:placeId`, `/reverse?lat&lng` |
| Offers page (guest + signed-in) | MKT-7 `GET /api/v1/coupons/available` (optional auth; `offerHeadline`, `eligibility`) |
| Restaurant card "20% OFF" badge | MKT-8 discovery item `offer:{label, code}|null` — show only when non-null |
| "Checkout only <restaurant>" / per-restaurant checkout | ORD-3 `restaurantIds` on `POST /api/v1/cart/preview` and `POST /api/v1/checkouts` |
| Terms / Privacy / Refunds / Help pages | static pages built in Task 7 (`/terms`, `/privacy`, `/refunds`, `/help`) |
| Owner card option names + rider name | already available (`lines[].addOns[].name`, `partner.name`); "at restaurant" via ORD-5 `deliveryStatus='AT_PICKUP'` |
| Partner "Call" | DLV-1 `POST /api/v1/deliveries/:jobId/contact {target}` → `{mode, telUrl, displayNumber}`; DEMO mode shows "Calling is simulated in demo" |
| Admin "Forgot?" | IDN-1 `POST /api/v1/auth/admin/password/forgot`, `/reset` (+ `/admin/reset-password?token=` page) |
| Admin "N dead letters · Replay" | NTF-3 `POST /api/v1/admin/notifications/dead-letters/replay` |
| Admin "N failed notifications · Retry" | NTF-1 summary for N + NTF-2 `POST /api/v1/admin/notifications/retry` |
| Admin recent orders table | ORD-1 `GET /api/v1/admin/orders/checkouts` |
| Admin status bar groups | five groups as drawn (Delivered, In progress, Placed, Rejected, Cancelled); FAILED delivery children count under Cancelled-tone "Failed" only if >0 (sixth chip appears only when non-zero) |
| Tracking "about 9 min" | DLV-3 `remaining.minutes` (fallback static child `eta`), label from `source` |
| Avatars | IDN-3 `avatarUrl` (photo) with initials fallback |

Other rulings:
- Countdown red threshold: 60 s for restaurant accept window, 10 s for partner offer — as design-spec proposes.
- Routing: `/` = landing when no location chosen, discover once a location is set; `/welcome` always the landing.
- Status tone changes listed in design-spec §3 (Picked up/On the way → info, Awaiting approval → info, Healthy → "Up") are accepted.
- Canonical tokens = final "Masala" app-board layer, as design-spec chose.
