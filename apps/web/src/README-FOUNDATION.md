# Thali web foundation

Read this before building a role area. Everything here is shared, so use it instead of re-implementing it.
Each module's file header has more examples.

> **UI redesign (Masala):** components, shells, theme, tokens and responsive rules are documented in
> [`README-DESIGN-SYSTEM.md`](./README-DESIGN-SYSTEM.md). Where it disagrees with §10–§12 below (component props,
> shells, design tokens), the design-system guide wins. Sign-in is now `/signin?role=…` (`/admin/login`
> redirects there); `/` shows the public landing until a delivery location is chosen.

- Stack: React 19, react-router 7 (data router, `createBrowserRouter`), TanStack Query 5, Tailwind v4 (CSS-first tokens in `styles.css`), Leaflet.
- Imports from contracts: root only (`import { formatINR, ChildOrderStatus } from '@thali/contracts'`). Never import `@thali/contracts/seed`.
- Error codes are open strings. Compare with `err.code === 'PRICE_CHANGED'`, but never `switch` exhaustively; the server may send new codes.

## Contents
1. [Role areas: what you own](#1-role-areas-what-you-own)
2. [API client `lib/api.ts`](#2-api-client)
3. [Errors `lib/errors.ts`](#3-errors)
4. [Auth `lib/auth.tsx`](#4-auth)
5. [Guest cart `lib/guest.ts`](#5-guest-cart)
6. [Realtime `useRealtime`](#6-realtime)
7. [Data fetching conventions](#7-data-fetching-conventions)
8. [Hooks](#8-hooks)
9. [Formatting `lib/format.ts`, `lib/geo.ts`](#9-formatting-and-geo)
10. [UI components](#10-ui-components)
11. [Layout and guards](#11-layout-and-guards)
12. [Design tokens](#12-design-tokens)
13. [Testing](#13-testing)
14. [Checklist for every screen](#14-checklist-for-every-screen)

---

## 1. Role areas: what you own

| Area | Your folder | Mounted at | Guard (applied for you) |
|---|---|---|---|
| Consumer (Task 17) | `src/features/consumer/` | `/*` | none (guests browse); wrap private pages in `<RequireAuth>` |
| Restaurant (Task 18) | `src/features/restaurant/` | `/restaurant/*` | `RESTAURANT_OWNER`; **`/restaurant/onboarding*` only needs sign-in** |
| Partner (Task 19) | `src/features/partner/` | `/partner/*` | `DELIVERY_PARTNER`; **`/partner/onboarding*` only needs sign-in** |
| Admin (Task 20) | `src/features/admin/` | `/admin/*` | `ADMIN` + MFA (`amr` has `mfa`); **`/admin/login*` is public** |

Only edit your own folder (plus your own tests under `apps/web/test/<area>/`). If you need a foundation change, report it; don't patch shared files.

Your `features/<area>/routes.tsx` is lazy-loaded and must export:

```tsx
import type { RouteObject } from 'react-router';
import type { NavItem } from '../../components/layout/RoleNav';
import { NotFoundPage } from '../../components/layout/ErrorBoundary';

// Paths are RELATIVE to the area root. Index = area home. Keep a '*' NotFound.
// Lazy-load each page so the area chunk stays small (route `lazy` or React.lazy both work):
export const routes: RouteObject[] = [
  { index: true, lazy: () => import('./DashboardPage').then((m) => ({ Component: m.default })) },
  { path: 'orders', lazy: () => import('./OrdersBoard').then((m) => ({ Component: m.default })) },
  { path: 'orders/:childId', lazy: () => import('./OrderDetail').then((m) => ({ Component: m.default })) },
  { path: '*', element: <NotFoundPage home="/restaurant" /> },
];

// Shell navigation (absolute paths). Mobile bottom bar shows the first 5 (consumer, partner).
export const nav: NavItem[] = [
  { to: '/restaurant', label: 'Dashboard', icon: 'chart', end: true },
  { to: '/restaurant/orders', label: 'Orders', icon: 'receipt', Badge: NewOrdersBadge },
];

export const HeaderActions = CartButton;   // optional: extra header controls (consumer: location chip + cart)
export const wide = false;                 // optional: full-bleed main column (maps, boards)
```

How it works: there is ONE data router (`createAppRouter()` in `src/routes.tsx`). Each area is a pathless layout route (`AreaLayout` = `AppShell` + area guard + `<Suspense>` + `<Outlet/>`). The first time the user navigates into an area, its module is imported and its `routes` are patched in as real child routes (`patchRoutesOnNavigation`), so area modules stay code-split. Non-consumer areas are mounted under their base path (`/restaurant`, `/partner`, `/admin`); consumer routes sit at the root. Because area routes are genuine data-router children, everything works inside them:
- **route-object `lazy`** (recommended for pages; the previous page stays visible while the chunk loads),
- **React.lazy elements** (an area-level `<Suspense>` fallback is provided; you may add your own),
- nested layout routes with `<Outlet/>`, `errorElement` / `ErrorBoundary`, `handle`, and loaders/actions (prefer TanStack Query for data).
Errors that escape your routes render `AreaRouteError` inside the area shell. Use relative or absolute links (`<Link to="orders">` or `<Link to="/restaurant/orders">`).

In tests, mount the real tree with `const cfg = createAppRouterConfig(); createMemoryRouter(cfg.routes, { initialEntries: [path], patchRoutesOnNavigation: cfg.patchRoutesOnNavigation })` (see `test/routing.areas.test.tsx`).

Reserved shared paths:
- `/signin?next=...`: shared phone-OTP sign-in page (consumers, owners, partners). Guards and the session-expired dialog send users here.
- `/admin/login`: the admin implementer builds this (password, then MFA). The guard and the session-expired dialog point admins there with `?next=`.
- The consumer account menu links to `/account` and `/orders`; the consumer area should provide both.

Pages render content only (the shell provides header, nav, `<main>`). Start every page with `<PageHeader>` (the page's single `<h1>`, which also sets `document.title`).

## 2. API client

```ts
import { api, type Paginated } from '../../lib/api';

const page = await api<Paginated<Order>>('/orders', { query: { limit: 20, cursor } });
await api('/owner/orders/' + id + '/accept', { method: 'POST', body: { prepMinutes: 20 } });
await api('/checkouts', { method: 'POST', body, idempotencyKey: idem.key });
await api('/cart/items', { method: 'POST', body: line, guest: true });
```

`api<T>(path, options): Promise<T>`
- `path`: relative to `/api/v1` (`'/orders'` becomes `/api/v1/orders`). Paths already starting with `/api/` are used as-is.
- `options`: `method` (default GET), `body` (JSON unless FormData/Blob/URLSearchParams/string), `query` (undefined/null/'' skipped, arrays repeat the key), `idempotencyKey`, `guest`, `auth` (default true), `headers`, `signal`, `credentials`.
- Returns parsed JSON, or `undefined` for 204.
- Throws `ApiError` (see §3); an aborted request throws the native `AbortError`.
- Sends `X-Requested-With: thali-web` on every call and `Authorization: Bearer <token>` when signed in.
- **401 handling:** one shared `POST /auth/refresh` (cookie, `credentials: 'include'`), then one retry with the new token. If refresh fails and a session existed, the token is cleared, `onSessionExpired` fires and the global dialog shows "Session expired — sign in again" (keeps the route). You never handle token refresh yourself.
- Uploads to S3 presigned URLs: use plain `fetch(url, { method: 'PUT', body: file, headers: { 'Content-Type': file.type } })`. That is not the API, so don't use `api()`.

Other exports: `getAccessToken()`, `setAccessToken()`, `onAccessTokenChange(cb)`, `onSessionExpired(cb)`, `refreshSession()`, `apiUrl(path, query)`, `API_BASE`.

## 3. Errors

```ts
import { ApiError, errorMessage, fieldErrors, otpErrorInfo, isForbidden } from '../../lib/errors';

try { await api(...) } catch (e) {
  if (e instanceof ApiError && e.code === 'PRICE_CHANGED') showDiff(e.details);
  else toast({ title: "Couldn't place order", description: errorMessage(e), tone: 'danger' });
}
setErrors(fieldErrors(e));           // { phone: 'Invalid phone', 'address.pincode': 'Required' }
```

- `ApiError { code, status, message, details, requestId, retryAfterSec }`. `status` 0 with `code: 'NETWORK_ERROR'` means offline or connection lost. A non-JSON 502/503 becomes `UPSTREAM_UNAVAILABLE`, and 504 becomes `UPSTREAM_TIMEOUT`.
- `errorMessage(e)`: user-facing copy. Friendly text for network, 5xx and auth/OTP codes; otherwise the server's specific 4xx message.
- `fieldErrors(e)`: from `VALIDATION_FAILED` `details.issues[{path,message}]`, with the `body.`/`query.`/`params.` prefix stripped. Use `validationIssues(e)` for the raw list.
- `otpErrorInfo(e)`: `{ retryAfterSec?, needsNewCode }`. Cooldown from `Retry-After` or `details.retryAfterSec`; `needsNewCode` is true for OTP_EXPIRED and OTP_ATTEMPTS_EXCEEDED. The server does not report attempts remaining, so show a generic "Incorrect code" for OTP_INVALID.
- Predicates: `isApiError`, `isUnauthenticated` (401), `isForbidden` (403), `isNotFound`, `isNetworkError`, `isRetryable`.
- Show `requestId` in error UIs. `<ErrorState>` does this for you ("Reference: ...").

## 4. Auth

```tsx
const auth = useAuth();
auth.status            // 'loading' | 'authenticated' | 'anonymous' (loading = restoring the session on boot)
auth.user              // { id, name?, phone?, email?, roles?, ... } | null
auth.roles / auth.adminRoles / auth.amr / auth.hasMfa
auth.hasRole('RESTAURANT_OWNER')
```

Roles, adminRoles and amr come from the access token claims (`roles`, `adm`, `amr`), which is what the server checks.

| Method | Calls | Notes |
|---|---|---|
| `requestOtp(phone)` | `POST /auth/otp/request` | returns `{ resendAfterSec (default 30), expiresInSec?, demo, raw }`; errors carry the cooldown (`otpErrorInfo`) |
| `signInWithOtp(phone, code, guestCartToken?)` | `POST /auth/otp/verify` | guest token defaults to the stored one; merges the guest cart (falls back to `POST /cart/merge` if the server reports `guestCartMerged: false`), clears it, invalidates all queries |
| `adminLogin(email, password)` | `POST /auth/admin/login` | resolves to `{kind:'mfaRequired', mfaToken}` or `{kind:'mfaSetupRequired', user}` (a password-only token is stored so the setup calls work) or `{kind:'signedIn', user}` |
| `adminVerifyMfa(mfaToken, code)` | `POST /auth/admin/mfa` | full admin session (`amr` includes `mfa`) |
| `adminSetupMfa()` | `POST /auth/admin/mfa/setup` | returns `{ otpauthUri, secret? }` (secret parsed from the URI if absent) |
| `adminEnableMfa(code)` | `POST /auth/admin/mfa/enable` | `{ signedIn: true }` if the server returned a token, else `{ signedIn: false }`: call `adminLogin` again (it will now ask for MFA) |
| `refreshUser()` | `POST /auth/refresh` (+ `GET /me` if needed) | **call after onboarding grants a role** (`POST /owner/restaurants`, `POST /partner/profile`) so the new role is in the token |
| `signOut()` / `signOutEverywhere()` | `POST /auth/logout` / `/auth/logout-all` | clears the session and the query cache even if the call fails |

Tolerance (LLD §5.3 is loose about shapes): user objects are read from `res.user`, or `GET /me` (`{...}` or `{user:{...}}`); ids from `id | _id | userId | sub`. Tokens must be in `accessToken`.

Ready-made UI: `components/auth/OtpSignInForm` (`<OtpSignInForm onSuccess={...} heading?>`): phone (normalized with `tryNormalizePhone`, region IN), resend countdown, generic "Incorrect code", Resend enabled on expired/too-many-attempts, demo hint. The consumer `LoginDialog` should wrap it in a `<Dialog>`. The admin login is yours to build with `adminLogin` / `adminVerifyMfa` / `adminSetupMfa` / `adminEnableMfa`.

## 5. Guest cart

`lib/guest.ts`: the token lives in localStorage `thali.guestCart` and is sent as `X-Guest-Cart`.
- `api(path, { guest: true })`: signed in sends no guest header; signed out GET attaches the token if one exists (never creates one just to read); signed out mutations create it first (`POST /cart/guest`, single-flight).
- `hasGuestCart()`, `getGuestCartToken()`, `ensureGuestCartToken()`, `clearGuestCartToken()`.
- Signed-out cart page: if `!isAuthenticated && !hasGuestCart()`, show the empty cart without calling the API.

## 6. Realtime

```tsx
import { useRealtime } from '../../hooks/useRealtime';
import { RealtimeStatus } from '../../components/ui/RealtimeStatus';

const orders = useQuery({ queryKey: ['owner', 'orders', restaurantId], queryFn: ... });
const { status } = useRealtime<{ childOrderId: string; restaurantId: string; status: string }>(
  ['owner.order'],
  (e) => { if (e.data.restaurantId === restaurantId) void orders.refetch(); },
  { fallbackRefetch: orders.refetch },
);
<RealtimeStatus status={status} />   // "Live", or "Live updates paused — refreshing every 10 s"
```

- One shared SSE connection per tab: `POST /realtime/ticket` returns `{ticket}` (`id`/`token` also accepted), then `EventSource('/api/v1/realtime/stream?ticket=...')`. It opens with the first subscriber and closes with the last.
- Event names (LLD §11): `order.updated`, `owner.order`, `delivery.location`, `partner.offer`, `notification`. `e.data` is the parsed JSON.
- `status`: `'connecting' | 'live' | 'reconnecting' | 'polling'`. On error the stream closes, reconnects with exponential backoff (1 s up to a 30 s cap, jittered, new ticket each time) and stays `polling` until it is live again. Signed out means `polling` without a stream.
- `fallbackRefetch` runs every 10 s while not live, once immediately when a live stream drops, and once on recovery. Always pass it; that is the polling fallback the HLD requires.
- Options: `{ fallbackRefetch, pollIntervalMs = 10000, enabled = true }`. `events` and `onEvent` can be inline.

## 7. Data fetching conventions

- TanStack Query everywhere. The client (`lib/query.ts`) retries queries only for network/408/429/5xx (max 2), never 4xx; `staleTime` is 15 s; mutations never auto-retry.
- Query keys: `['me']`, `['cart']`, `['orders', ...]`, `['order', checkoutId]`, `['owner', ...]`, `['partner', ...]`, `['admin', section, ...]`, `['meta']`. After a mutation, invalidate what changed.
- Render queries with `<QueryState>` (§10) so loading, empty, error, forbidden and session-expired states are never forgotten.
- Money is integer paise in and out. Never use floats; for rupee input, convert with integer math (`Math.round(Number(rupees) * 100)` only at the input boundary, then validate it's an integer).
- Idempotent POSTs (`/checkouts`, `/memberships/purchase`, admin refunds and payouts) use `useIdempotencyKey()`.

## 8. Hooks

| Hook | Use |
|---|---|
| `useRealtime(events, onEvent, opts)` | §6 |
| `useIdempotencyKey()` | `{ key, renew }`: same key across retries and double clicks of one attempt; call `renew()` on success or when the payload changes |
| `usePolling(cb, ms, { enabled, immediate, pauseWhenHidden })` | interval while enabled (e.g. checkout status every 3 s while `AWAITING_PAYMENT`) |
| `useMeta()` | `{ meta, mode, isDemo, isSandbox, isProduction }` from `GET /meta` (cached). Use for "demo estimate" labels and the demo-only buttons |
| `useGeolocation({ timeoutMs, highAccuracy })` | `{ status, position, permission, request, message }`; status `idle, locating, success, denied, unavailable, timeout, unsupported`; `message` is ready-to-show copy for failures |
| `useNow(ms)` | shared ticking clock |
| `useCountdown(to)` | seconds left (0 when passed, null when no deadline) |
| `useMediaQuery(q)` / `MQ_DESKTOP` | `(min-width: 768px)`; defaults to true where matchMedia is missing (tests) |
| `useCursorPages()` | cursor stack for Previous/Next tables (see `Pagination`) |
| `useDocumentTitle(title)` | `PageHeader` calls it for you |
| `useSignInHref(path?)` | `/signin?next=<current>` |

## 9. Formatting and geo

`lib/format.ts` (all dates in **Asia/Kolkata**, en-IN): `formatDate`, `formatTime`, `formatDateTime`, `formatRelative(iso, now?)` ("12s ago"), `formatDuration(sec)` ("4:59"), `formatMinutes`, `formatDistanceKm`, `formatPhone` ("+91 98765 43210"), `formatBps` ("5%"), `plural(n, 'item')`, `formatINR` (re-export), `istFormatter(options)`.

`lib/geo.ts`: `DEFAULT_CENTER` (Bengaluru), `isValidGeoPoint`, `haversineKm` (display only), `googleMapsDirectionsUrl(dest, origin?)`, `roundGeo`.

## 10. UI components

Import from the barrel `components/ui` (everything except the Map), or from the individual file.

| Component | Key props / notes |
|---|---|
| `Button` | `variant: primary, secondary, ghost, danger, link`; `size: sm, md, lg` (md = 44px); `icon`, `iconRight`, `loading` (spinner + aria-busy + disabled), `fullWidth` |
| `ButtonLink` | Link styled as a button (same props + `to`) |
| `IconButton` | `icon`, **`label` (required)**, 44x44 |
| `Field` | `label`, `hint`, `error`, `required`, `optional`, `hideLabel`. Wraps one control and wires `id`, `aria-describedby`, `aria-invalid`, `required` automatically |
| `Input`, `Textarea` | inside `Field`; `Input` has `icon`, `prefix` ("+91"), `suffix` ("min") |
| `Select` | native select; `options=[{value,label}]`, `placeholder` |
| `Checkbox`, `Switch` | `label`, `description`; 44px rows; `Switch` = role="switch" |
| `RadioGroup` | fieldset + legend; `options=[{value,label,description?,aside?}]`, `variant: plain, cards`, `error` |
| `Dialog` | `open`, `onClose`, `title`, `description`, `footer`, `size`, `dismissible`, `initialFocusRef`, `role`. Focus trap, Escape, focus restore, scroll lock; bottom sheet on phones |
| `Sheet` | drawer: `side: bottom, right, left` |
| `ConfirmDialog` | `title`, `description`, `confirmLabel`, `tone: danger`, `reason={{ label, options?, minLength }}`, async `onConfirm(reason)` (spinner, inline error, stays open on failure) |
| `FormActions` | button row; stacks on phones; `sticky`, `start` (opposite side) |
| `Badge` | `tone: neutral, brand, success, warn, danger, info`; `variant: soft, solid`; `icon`, `dot` |
| `StatusPill` | `kind` + `status` gives the human label and tone for **childOrder, checkout, payment, refund, childRefund, delivery, restaurant, partner, ticket, payout, offer, notification, membership, user, health**; `statusLabel(kind, s)`, `statusTone(kind, s)` |
| `Card`, `CardHeader`, `CardSection` | surfaces; `interactive`, `tone`; never nest cards |
| `PageHeader` | `title` (h1), `description`, `back={{to,label}}`, `status`, `actions` |
| `DataTable` | `columns=[{key,header,cell,primary?,secondary?,align?,hideOnMobile?}]`, `rows`, `getRowId`, `caption`, `loading`, `error`, `onRetry`, `empty`, `rowHref`, `rowActions`, `footer`. Table on desktop, cards on mobile |
| `QueryState` | `query`, `children(data)`, `isEmpty`, `empty`, `loading`. Covers pending, 401, 403, error + retry, empty, and stale-data-with-warning |
| `Skeleton`, `SkeletonText`, `SkeletonList` | layout-stable loading (aria-hidden; QueryState adds role="status") |
| `EmptyState` | `icon`, `title`, `description`, `action`, `compact` |
| `ErrorState`, `ForbiddenState`, `SessionExpiredState`, `InlineError` | failure states with recovery paths |
| `Toast` | `const { toast } = useToast(); toast({ title, description?, tone, action?, duration? })`: role="status" (danger: role="alert") |
| `Tabs` | `label`, `tabs=[{id,label,content,count?}]`, controlled or uncontrolled; arrow keys |
| `Price` | `paise`, `was?`, `freeLabel?`, `size`, `tone`; `formatPaise()` never throws |
| `Countdown` | `to`, `onExpire`, `expiredLabel`, `warnBelowSec`, `label`; role="timer" |
| `RelativeTime` | `value`, `prefix="updated"`, `staleAfterSec={60}`: "updated 12s ago (stale)" |
| `Pagination`, `LoadMore` | cursor pagination (see file header for useQuery/useInfiniteQuery recipes) |
| `RealtimeStatus` | `status` from useRealtime |
| `Spinner` | inline only; prefer skeletons for content |
| `Icon`, `FoodMarker` | `<Icon name="cart" />` (decorative) or `label="..."` (meaningful). Names: search, location, cart, user, chevron-left/right/up/down, check, x, clock, bike, store, shield, alert, info, plus, minus, menu, home, receipt, wallet, logout, refresh, phone, star, external, filter, trash, edit, list, map, bell, settings, chart, users, ticket, heart, crosshair, activity. `<FoodMarker veg />` gives the green square-with-dot; `veg={false}` gives the brown square-with-triangle (labelled for screen readers) |

**Map** (`components/ui/Map`, not in the barrel, so Leaflet only loads with map pages):

```tsx
import { MapView } from '../../components/ui/Map';
<MapView center={drop} markers={[{ id: 'p', position: partner, kind: 'partner', label: 'Arjun' }]} className="h-80" />
<MapView center={pin ?? DEFAULT_CENTER} picked={pin} onPick={setPin} ariaLabel="Choose delivery location" />
<MapView polygons={[{ id: 'area', points, tone: 'brand', open: editing }]} onPick={addVertex} />
```

Props: `center`, `zoom` (14), `markers [{id, position:{lat,lng}, kind: restaurant|home|partner|pin|point, label}]`, `picked`, `onPick` (click/tap plus a keyboard-accessible "Pin map centre" button), `polygons`, `fitToMarkers` (true), `followCenter` (true), `ariaLabel`, `className` (sets height; default `h-72`), `children` (raw react-leaflet layers; use `markerIcon(kind)` for icons). OSM tiles with attribution. `Map` is also exported as an alias, but prefer `MapView` so you don't shadow the global `Map`. In jsdom tests, mock the module: `vi.mock('../../src/components/ui/Map', () => ({ MapView: () => <div data-testid="map" /> }))`.

## 11. Layout and guards

- `RequireAuth` / `RequireRole` (`components/layout/RequireRole`): `role` (one or an array, any-of), `signInPath`, `requireMfa`, `forbiddenAction={{label,to}}`, `forbiddenTitle`, `forbiddenMessage`, `signInMessage`. States: "Checking your session..." while loading, then the sign-in prompt (route preserved), then Forbidden. Area guards are already applied (§1); use these for page-level needs (e.g. consumer `/orders`).
- `AppShell` variants, `RoleNav`, `NavCount` (badge bubble for `NavItem.Badge`), `ModeBanner` (DEMO/SANDBOX from `/meta`, hidden in production), `SessionExpiredDialog`, `NotFoundPage`, and the area error view (`AreaRouteError`) are mounted for you. `PageLoading` is the default Suspense fallback; `CrashView` and `AreaErrorBoundary` are available for custom error UIs.
- Focus moves to `<main id="main">` on navigation; a skip link exists. Don't add another `<main>`.

## 12. Design tokens

**Superseded** — see README-DESIGN-SYSTEM.md §3. The legacy names below still compile (bridged to the new
semantic tokens) but must not be used in rebuilt screens.

Defined in `src/styles.css` (`@theme`). Use the tokens rather than raw hex values.
- Brand saffron: `brand-500 #E8590C` (marks, focus rings, accents; **not for text**), `brand-600` (primary button fill, white text 5.2:1), `brand-700` (brand text and links), `brand-50/100` (selected/tinted backgrounds).
- Neutrals: Tailwind `slate`. Body text `slate-900`, secondary `slate-600`, borders `slate-200/300`. Surfaces: `bg-canvas` (page), `bg-surface` (cards), `bg-surface-muted`.
- Semantic: `success | warn | danger | info` at `-50 -100 -600 -700 -800`. Use 800 for text on tints, 700 for solid fills and text on white, 600 only for icons, dots and borders.
- `text-veg` / `text-nonveg`; `rounded-control` (inputs, buttons), `rounded-card`, `rounded-pill`; `shadow-raised`, `shadow-overlay`; `min-h-touch` / `size-touch` (44px); `max-w-content` (72rem), `max-w-prose`.
- Motion: `animate-fade-in`, `animate-pop-in`, `animate-sheet-up/left/right` (150–220 ms ease-out; reduced-motion respected globally).
- Type: system sans. Page title `text-2xl font-bold` (PageHeader), section `text-lg font-semibold`, body `text-[0.9375rem]`, meta `text-sm text-slate-600`. Use `tabular-nums` for money, times and counters.
- Copy: short and specific; tell the user what happened and what to do next. Label demo data clearly (`isDemo`, `estimateSource`, `simulated` gives a `<Badge tone="info">Demo</Badge>`).

## 13. Testing

Web tests live in `apps/web/test/**` (`*.test.ts` / `*.test.tsx`, jsdom). Run them with `npx vitest run --project @thali/web`.

```tsx
import '../setup';                                     // REQUIRED first line: jest-dom matchers + cleanup
import { renderWithProviders, makeAuth, makeJwt, makeQueryClient } from '../utils';

renderWithProviders(<OrdersBoard />, {
  route: '/restaurant/orders?tab=new',
  path: '/restaurant/orders',                          // pattern, so useParams works
  auth: makeAuth({ roles: ['CONSUMER', 'RESTAURANT_OWNER'] }),
});
```

- `makeAuth(overrides)`: a fake `useAuth()` value (anonymous by default; giving `roles` or `user` signs in; methods are `vi.fn()`).
- Mock the network with `vi.stubGlobal('fetch', vi.fn(...))` and return `new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })`. Create a new Response per call (a body can only be read once). Errors use the envelope `{ error: { code, message, details, requestId } }`.
- Realtime: wrap in `<RealtimeProvider client={createRealtimeClient({ fetchTicket, EventSource: Fake, canConnect: () => true })}>` (see `test/useRealtime.test.ts` for a fake EventSource), or just test that `fallbackRefetch` behaviour is wired.
- `useMediaQuery` returns desktop in jsdom (no matchMedia), so DataTable renders a `<table>`.

## 14. Checklist for every screen

- [ ] Loading (skeleton), empty (with a next action), error (retry + reference), forbidden, session-expired: use `QueryState` / `DataTable`.
- [ ] Every button calls a real API, shows `loading`, and surfaces errors (`InlineError` or toast). No fake counters or hardcoded success.
- [ ] Forms: every control in a `Field`; server `fieldErrors` mapped back; submit disabled only with a visible reason.
- [ ] Money via `<Price paise>`, times via `format*` / `<RelativeTime>` / `<Countdown>`, statuses via `<StatusPill>`.
- [ ] Live screens: `useRealtime` with `fallbackRefetch` + `<RealtimeStatus>`.
- [ ] Idempotency keys on checkout, membership, refund and payout POSTs.
- [ ] Keyboard: everything reachable, focus visible, dialogs trap focus; 44px targets; works at 360px wide.
- [ ] Demo/simulated data visibly labelled.
