# Thali "Masala" design system — usage guide

For role-area implementers (consumer, restaurant, partner, admin). Read with `README-FOUNDATION.md` (API client,
auth, realtime, data conventions) and the binding visual spec
[`docs/design/redesign/design-spec.md`](../../../docs/design/redesign/design-spec.md) (§ numbers below refer to it).

Contents: [1 Rules](#1-rules) · [2 Theme](#2-theme) · [3 Tokens & utilities](#3-tokens--utilities) ·
[4 Typography](#4-typography) · [5 Shells](#5-shells) · [6 Components](#6-components) ·
[7 Illustrations](#7-illustrations) · [8 Responsive](#8-responsive) · [9 Routes & sign-in](#9-routes--sign-in) ·
[10 Testing tips](#10-testing-tips)

---

## 1. Rules

- **No hard-coded hex in feature code.** Use the semantic utilities (`bg-card`, `text-fg-3`, `border-line`,
  `bg-acc-soft`, `text-ok` …). They flip with the theme. The only literal colours allowed are the fixed
  marketing blocks listed in spec §1.1 (chili/ink/turmeric promo blocks) and data hues (restaurant/cuisine
  identity hues come from `hueFor()` / `CUISINES`, never typed by hand).
- Legacy utilities (`slate-*`, `brand-*`, `success-*`, `warn-*`, `danger-*`, `info-*`, `bg-surface`,
  `bg-canvas`) are **bridged** to the new tokens so old screens follow the theme. Don't use them in rebuilt
  screens.
- One colour = one meaning: chili/`acc` = in the kitchen / needs your action · sky/`info` = moving or waiting on
  someone else · turmeric/`warn` = needs attention, money pending · leaf/`ok` = done · red/`bad` = failed ·
  grey/`neu` = ended. Status pills already follow this (`StatusPill`).
- Honest data: ratings only with ≥ 5 (`RatingBadge` shows "New"), estimates get `EstBadge`, simulated things
  get a label (`SimulatedTag`, `DemoPill`), "Paid" only with a UTR.
- Import components from the barrel: `import { Button, StatusPill, KpiTile } from '../../components/ui';`
  (Leaflet `MapView` stays a separate import from `components/ui/Map`).
- `cn()` (`lib/cn`) merges Tailwind classes with **tailwind-merge** configured for our tokens: the later class wins
  (`cn('border-line', 'border-acc')` → `border-acc`, `shadow-pri` + `shadow-none` → `shadow-none`, `rounded-pill` +
  `rounded-control` → `rounded-control`, `min-h-10` + `min-h-touch`), while size and colour never conflict
  (`text-sm text-pri-fg`). So override component defaults through `className` — no `!` needed. Custom `@utility`
  classes (`lbl`, `eyebrow`, `glass`…) are not merged; override their properties with `!` as before.

## 2. Theme

`lib/theme.tsx` — module-level store, works with or without the provider (`<ThemeProvider>` is mounted in `App`).

```tsx
import { useTheme } from '../../lib/theme';
const { preference, resolved, setPreference, toggle } = useTheme(); // 'light'|'dark'|'system', 'light'|'dark'
<ThemeToggle />                 // ghost icon button (moon/sun), every shell already has one
<ThemeToggle variant="outline" />
<ThemeSegmented />              // "Light | Dark" radiogroup (public utility bar); iconOnly for phones
```

- Persisted in `localStorage['thali.theme']`; written to `<html data-theme>` + `color-scheme`. `index.html`
  applies it before first paint (no flash).
- Dark-only tweaks in classes: `dark:` variant (`dark:border dark:border-line-2`). Prefer tokens over `dark:`.
- Leaflet tiles are dimmed automatically in dark.

## 3. Tokens & utilities

All defined in `src/styles.css`.

| Purpose | Utilities |
|---|---|
| Surfaces | `bg-bg` page base · `bg-bg-2` recessed (bill footer, code boxes) · `bg-card` cards/inputs · `bg-fill` neutral fill (avatars, tracks, segmented) · `bg-side` translucent sidebar · `bg-band` public bands |
| Lines | `border-line` default · `border-line-2` strong (dashed empties, switch off) |
| Text | `text-fg` · `text-fg-2` secondary · `text-fg-3` tertiary/labels · `text-neu` |
| Brand | `bg-pri text-pri-fg` primary fill · `hover:bg-pri-h` · `text-acc` accent words · `text-acc-fg` accent text on light · `bg-acc-soft` tint |
| Turmeric | `bg-sun` · `bg-sun-soft` · `text-sun-ink` |
| Status | `text-ok bg-ok-bg` · `text-warn bg-warn-bg` · `text-bad bg-bad-bg` · `text-info bg-info-bg` |
| Food | `text-veg` · `text-nveg` |
| Map | `bg-map`, `--road`, `--blk` |
| Shadows | `shadow-card` (hover cards, toasts) · `shadow-float` (dock, tray) · `shadow-modal` · `shadow-pri` · `shadow-seg` |
| Radii | `rounded-tag` 5 · `rounded-xs` 6 · `rounded-badge` 8 · `rounded-item` 10 · `rounded-control` 12 · `rounded-field` 14 · `rounded-card` 16 · `rounded-card-lg` 20 · `rounded-panel` 24 · `rounded-block` 28 · `rounded-art` 40 · `rounded-pill` |
| Backgrounds | `page-glow` (app pages) · `page-glow-long` (marketing) · `grid-bg` (sign-in aside) · `glass` (sticky headers) |
| Labels | `lbl` (mono 11.5 uppercase) · `eyebrow` (marketing) · `accent-word` |
| Loading | `skeleton` (shimmer) |
| Motion | `animate-rise` `animate-pop` `animate-fade` `animate-open` `animate-swap` `animate-arrive` `animate-slidein` `animate-in` `animate-urgent` `animate-grow` `animate-blink` `animate-pulse-live` `animate-pulse-ok` `animate-dock` `animate-tray` `animate-bump` `animate-bob` `animate-split` `animate-dash` (reduced-motion disables all) |
| Containers | `max-w-[1240px]` public · `[1360px]` discover · `[1200px]` page · `[1160px]` checkout |
| Focus | global `:focus-visible` 2px `--acc` ring; on chili/ink surfaces wrap with `.on-color` (3px turmeric ring) |
| Variant `rail:` | inside the RoleSidebarShell aside while it is the 72px tablet rail (640–1023) — for context-slot blocks |
| Palette (art/charts only) | `chili-*`, `turmeric-*`, `leaf-*`, `clove-*`, `sky-*`, `red-*`, `ink-*`, `ember-*` |

## 4. Typography

Fonts: Bricolage Grotesque (display), Figtree (body), JetBrains Mono (data) — self-hosted.

- Every `h1`–`h3` is Bricolage 800, −0.025em (base style). Size it with classes; don't set a weight.
  For Figtree headings in cards use `font-sans font-semibold tracking-normal`.
- Accent word: `<h1>Today at a <AccentWord>glance</AccentWord></h1>`.
- Mono data: `font-mono` (order codes, UTRs, counts, timeline times). Money/KPIs: `tabular-nums`.
- Role-shell page title: `<PageHeader title=… />` (24→28px); consumer page: `<PageHeader size="page" />`.

## 5. Shells

All shells include: skip link, demo/sandbox strip (`GET /meta`), `<main id="main">`, theme toggle, account menu.
Each renders `<Outlet/>` when given no children, so it can be a layout route.

### How a role area gets its shell

By default `AreaLayout` (components/layout/RoleArea.tsx) wraps your routes in the right shell and reads these
optional exports from `features/<area>/routes.tsx`:

```tsx
export const nav: NavItem[] = [...];                 // sidebar / tab bar items
export const shell: RoleShellConfig | ConsumerShellConfig = {...};   // slots (below)
export const wide = true;                            // full-bleed main
export const chrome: 'auto' | 'none' = 'auto';       // 'none' = you mount shells yourself
```

With `chrome = 'none'` mount shells as layout routes (guards still apply):

```tsx
export const chrome = 'none';
export const routes: RouteObject[] = [
  { element: <ConsumerShell container="discover" />, children: [{ index: true, element: page(HomePage) }, …] },
  { element: <CheckoutShell backTo="/cart" />, children: [{ path: 'checkout', element: page(CheckoutPage) }] },
];
```

### `RoleSidebarShell` — restaurant (KITCHEN) · partner (PARTNER) · admin (OPS)

`import { RoleSidebarShell, SidebarSwitcher, SidebarProfileCard, SidebarSearchButton } from '../../components/layout/RoleSidebarShell'`

| Prop / `shell` slot | Use |
|---|---|
| `role` | `'restaurant' \| 'partner' \| 'admin'` (tag, widths, labels) |
| `nav: NavItem[]` | `{ to, label, shortLabel?, icon, end?, Badge?, section?, primary? }` — `section` prints admin section labels; `shortLabel` is used in the phone tab bar |
| `tabs` | phone tab bar, ordered `RoleTab[]` `{ to, label?, icon?, end?, Badge? }` (icon/Badge/end come from the nav item with the same path). Defaults `ROLE_TABS` (spec §6.5): restaurant **Live orders · Dashboard · Menu · Finance**; partner **Home · History · Earnings · Profile**; admin **Overview · Orders · Deliveries · Approvals** (`/admin/restaurants?status=APPROVAL_PENDING`). "More" appears when nav items are left over. `tabs: false` = legacy `primary` / first-4 rule |
| `roleTag` | text or component for the tag next to the logo (default KITCHEN / PARTNER; admin = the session sub-role SUPER · OPS · FINANCE · SUPPORT) |
| `Context` | sidebar context block: `<SidebarSwitcher name area menu={(close) => …}>` / `<SidebarProfileCard name detail avatarUrl>` / `<SidebarSearchButton onClick>` |
| `railContext` | `true` = also show `Context` in the 72px tablet rail; the three blocks above collapse there (switcher → initials tile whose menu opens to the right, search → icon, profile → avatar). Leave false for custom blocks that don't use `rail:` |
| `MobileContext` | compact context in the ≤640 top bar (restaurant name, online pill…) |
| `Footer` | replaces the user block (partner: status chip); a "⋯" account-menu button + theme toggle are added. Without `Footer` the user block (avatar · name · subtitle) **is** the account-menu trigger |
| `userSubtitle` | under the name ("Owner"; admin defaults to "<Sub-role> admin · MFA on" from the session) |
| `signOutAll` | account menu gets "Sign out of all devices" (confirm → `/auth/logout-all` → area sign-in) |
| `AccountExtras` | `({ close }) => <AccountMenuItem icon to|onClick>…</AccountMenuItem>` extra menu rows above Sign out |
| `wide` | full-bleed main |

Nav badges (`NavItem.Badge`, a component so it can use hooks):
`() => <NavCount count={n} label="new orders" />` (chili urgent) · `<NavPlainCount>` (mono grey) ·
`<NavDot tone="bad"|"warn" label="services down" />` (health).

Layout: ≥1024 sidebar 232px (admin 224, dense rows) · 641–1023 72px icon rail · ≤640 56px top bar + bottom tab
bar + "More" sheet. On ≥641 the main column scrolls (it resets to top on navigation). The aside is not a scroll
container (the nav scrolls inside it), so popovers and the account menu can overflow onto the page.

`SidebarSwitcher` spreads extra props onto its `<button>` (`aria-label`, `onClick`, `data-*`), takes `dot` (accent
dot on the tile) and, with `menu` + `menuLabel`, owns an anchored `Popover` (dialog) — the restaurant switcher is
built this way.

### `ConsumerShell` — boards 10/11/13

`import { ConsumerShell, NotificationBell, CONSUMER_ACCOUNT_NAV } from …/layout/ConsumerShell` (bell from ShellParts)

```tsx
export const shell: ConsumerShellConfig = {
  Location: LocationChip,                         // your chip that opens the location picker
  Actions: CartButton,                            // extra right-cluster controls
  Bell: () => <NotificationBell unread={useUnreadNotifications()} />,
  accountRoutes: ['/orders', '/account', '/membership', '/support', '/notifications'],
};
```

Props: `variant` (`discover` | `account`; default from `accountRoutes`), `breadcrumb` (restaurant page),
`hideSearch`, `searchPlaceholder`, `container` (`discover` 1360 · `page` 1200 · `checkout` 1160 · `none` = no max width
· `bleed` = no wrapper at all, pages own widths/padding), `tabs` (≤640 tab bar; default Home · Search · Orders ·
Account), `accountLinks` (account-menu links after Profile · Your orders, e.g. Addresses · Thali Plus · Support ·
Notifications). Pages set the breadcrumb from inside the shell:
`useShellBreadcrumb(<Breadcrumb items={[{ label: 'Restaurants', to: '/discover' }, { label: name }]} />, [name])`.
Search has the `/` shortcut and submits to `/search?q=`. If you only export the legacy `HeaderActions`, it is rendered in the right cluster (no default chip).
The cart dock is page content: render `<CartDock>` at the end of the page.

### `CheckoutShell` — board 12

`<CheckoutShell backTo="/cart" title="Checkout" />` — back button · logo · "/ Checkout" · lock "Secure checkout" ·
theme. No search, no cart.

### `PublicShell` — board 00

Used by the landing, static and marketing pages (mounted by `routes.tsx`). Exports `roleEntryHref(role, signedIn)`
(onboarding or sign-in with the right tab) and `useFocusAddress()`.

### Shell parts (`components/layout/ShellParts`)

`AccountMenu` (`area`, `trigger: 'avatar' | 'more' | 'user'`, `subtitle`, `placement`, `links`, `extra`,
`signOutAll`, `themeOption`) — consumer order is Profile · Your orders · your `links` · other areas, plus a "Dark
mode / Light mode" row on phones (`themeOption: 'phone'`, consumer default) · `AccountMenuItem` · `HeaderSearch`
(`density`, `onSearch`, `hotkey`) · `NotificationBell` (`unread`: boolean or a count → "Notifications, 3 unread") ·
`Breadcrumb` (`items`) + `useShellBreadcrumb` · `SkipLink`, `MainRegion`, `signInHref(area, next)`, `useDisplayName()`. `ModeBanner` / `DemoBanner` (strip) and `DemoPill` live in `layout/ModeBanner`.
`Logo` (`size: public | app | sidebar | footer`, `markOnly`, `subtitle` = screen-reader name).

## 6. Components

All from `components/ui` (barrel). Examples are minimal; each file header has more.
Icons: `<Icon name=… label? size? />` (inline set, `iconNames` lists them; includes `bell-off` for "Chime off").

### Actions & inputs

| Component | Props / example |
|---|---|
| `Button` | `variant`: `primary` · `tonal` · `outline` (`secondary` alias) · `ghost` · `dark` · `on-chili` · `on-chili-outline` · `on-ink` · `on-ink-outline` · `danger` · `danger-outline` · `link` · `link-accent`; `size`: `xs 30` `sm 36` `md 40` `lg 48` `xl 54`; `shape="block"` (12px radius card actions); `icon`, `iconRight`, `loading`, `fullWidth`. `<Button shape="block" size="lg" fullWidth>Accept · 20 min</Button>` |
| `ButtonLink` | same props + `to` |
| `IconButton` | `icon`, `label` (required), `variant`, `size` (`xs 32` · `sm 36` · `md 40` · `lg 44`), `dot`. It is `position:relative`; to position it absolutely wrap it in a span |
| `Field` + `Input` / `Textarea` / `Select` | `<Field label hint error required><Input density="app|compact|marketing" icon prefix suffix /></Field>` |
| `PhoneInput` | `<Field label="Mobile number"><PhoneInput value onChange /></Field>`; helpers `toE164India`, `nationalMobile`, `formatMobileGroups` |
| `Checkbox`, `Switch` | labelled rows (44px); `Switch` = settings row with 44×26 track |
| `Toggle` | bare switch: `<Toggle size="md|lg" checked onChange label pending />` |
| `RadioGroup` | `variant="plain|cards"` |
| `OptionCard` | `<OptionCard type="radio|checkbox" label aside="+₹30" checked onChange disabled disabledReason="Max 2" />` (default suffix " · Unavailable"; `null` = none) |
| `Popover` | `<Popover label="Pause new orders" panelClassName="w-[320px] p-3" placement="down|up|right" align="end|start" trigger={(p) => <Button {...p}>Pause</Button>}>{(close) => …}</Popover>` — focus moves into the panel, Esc returns it to the trigger, outside click / Tab-out closes; `panelClassName` merges over `min-w-56 p-2` |
| `PillSelect` | 30px outline pill over a native select: `<PillSelect label="Status" prefix="Status:" value options onChange />` |
| `FilterPills` | single-select pill row with counts: `<FilterPills label="Status" value onChange options={[{ value, label, count }]} />` |
| `SegmentedTabs` | `<SegmentedTabs label options value onChange semantics="pressed|tabs|radio" size="md|sm" fullWidth idPrefix />` |
| `Tabs` | WAI-ARIA tabs with panels; `variant="underline|segmented"` |
| `FilterPill`, `PriceChips`, `ChoicePills` | `<FilterPill pressed veg>Veg only</FilterPill>` · `<PriceChips value={[2]} onChange />` · `<ChoicePills label="Prep time" columns={4} options value onChange />` |
| `QtyStepper` | `<QtyStepper value onChange itemName size="md|lg" tone="default|primary" />` (0 = remove) |
| `CodeEntry` | 4-box delivery/pickup code entry: `<CodeEntry length={4} value onChange onComplete label error hint />` (auto-advance, paste, backspace) |
| `OtpInput` | sign-in style 6-box code backed by one input (SMS autofill): `<OtpInput label="6-digit code" value onChange onComplete invalid />` |

### Status & data

| Component | Props / example |
|---|---|
| `StatusPill` | `<StatusPill kind="childOrder" status={s} density="marketing|app|dense" />`; `statusLabel`, `statusTone` |
| `Badge` | `<Badge tone="ok|warn|bad|info|acc|neu" dot density variant="soft|solid" icon />` (legacy tone names work) |
| `VegMark`, `PureVegBadge` | `<VegMark veg size={14} withLabel onColor />` |
| `EstBadge`, `EstLegend` | `32 min <EstBadge />` · `<EstLegend demo />` |
| `RatingBadge` | `<RatingBadge avg count solid />` → "New" under 5 ratings |
| `LiveIndicator` | `<LiveIndicator status={realtimeStatus} variant="pill|inline" tone="acc|ok" text updatedAt updatedPrefix />` (`RealtimeStatus` = inline variant) |
| `CountdownRing` | `<CountdownRing to={acceptBy} totalSec={300} variant="accept|offer|sample" label="left to accept" onExpire />` (red ≤60 s accept, ≤10 s offer + pulse) |
| `Countdown` / `useCountdown` | text countdown / hook |
| `CodeDigits` | `<CodeDigits code="4719" label="Delivery code" size="md|lg" />` |
| `Stepper` | `<Stepper label steps={ORDER_STEPS|PARTNER_STEPS|REFUND_STEPS or {label,time}[]} current tone="order|refund" terminal={{label,tone}} />`; `StepNumber` |
| `ProgressBar` | `<ProgressBar value max label left right overdue tone />` |
| `KpiTile`, `KpiStrip` | `<KpiTile label value secondary sub subTone highlight loading unavailable onRetry />` (`highlight` = acc-soft fill, works standalone and in the strip); wrap in `<KpiStrip>` for the admin strip |
| `HistoryTimeline` | vertical status history: `<HistoryTimeline items={[{ title, at, detail }]} label="Status history" />` (newest first) |
| `StackedStatusBar` | `<StackedStatusBar title segments={[{key,label,count,tone,hideWhenZero}]} />` |
| `Price` | `<Price paise size="sm|md|lg|xl|total" tone="default|muted|ok|info|acc|bad" was freeLabel />` |
| `DataTable` | unchanged API; restyled (mono headers, row hover, cards ≤768) |
| `RelativeTime`, `Pagination`, `LoadMore` | unchanged |

### Cards & composites

| Component | Props / example |
|---|---|
| `Card`, `CardHeader`, `CardSection` | `interactive` hover lift; `tone`; `padding` |
| `SectionCard`, `SectionRow` | `<SectionCard title="Needs attention" count={3} meta="checked 14s ago" actions>…<SectionRow>…</SectionRow></SectionCard>` |
| `RestaurantCard` | `<RestaurantCard to id name imageUrl cuisines priceBand rating etaMin distanceKm deliveryFeePaise open stateLabel pureVeg offer variant="app|marketing" index />` |
| `CuisineCircle`, `CuisineTrain` | `<CuisineTrain label header={<h2>…</h2>} controls>{circles}</CuisineTrain>` (prev/next disabled at the ends, "Scroll <label> left/right") · `<CuisineCircle slug label imageUrl selected onClick|to variant="app|marketing|small" />` |
| `CartDock`, `CartTray`, `CartSlot` | presentational multi-cart bar (see file header for the full wiring example); `onChipClick(id)` makes the per-cart chips buttons |
| `DetailColumns` | detail-page layout: `<DetailColumns main={…} aside={…} />` (main 560+ · aside 320–380, wraps) |
| `BillBreakdown`, `BillRow` | `<BillBreakdown groups={[{id,name,totalPaise,rows:[{label,paise,discount}]}]} totalPaise action footnote />` |
| `AddressCard`, `AddAddressCard` | radio cards: `<AddressCard name label address isDefault checked onSelect disabledReason actions />` |
| `KanbanColumn`, `KanbanEmpty` | `<KanbanColumn title count live="assertive" empty={{title, sub}}>{cards}</KanbanColumn>` |
| `Avatar` | `<Avatar name src={user.avatarUrl} size={36} bordered hue shape="circle|tile" />`; `initials()`, `hueFor(id)`, `RESTAURANT_HUES` |
| `MapFrame`, `MapPlaceholder`, `SimulatedTag` | `<MapFrame simulated ariaLabel>{coords ? <MapView className="h-full" …/> : <MapPlaceholder />}</MapFrame>` |
| `InfoNotice`, `StatusBanner`, `ExplanationBox` | notices (spec §3.35) |
| `Dialog` (`Modal` alias), `Sheet`, `ConfirmDialog` | dialogs become bottom sheets on phones (drag handle, `--bg2` footer) |
| `EmptyState`, `ErrorState`, `ForbiddenState`, `SessionExpiredState`, `InlineError`, `QueryState` | spec §3.32 frames; `EmptyState illustration={<CuisineArt slug="all" />}` |
| `Skeleton`, `SkeletonText`, `SkeletonList`, `SkeletonCard`, `SkeletonKpi`, `SkeletonAvatar`, `SkeletonChip`, `SkeletonTable` | layout-matching placeholders |
| `Toast` (`useToast`), `ToastPill` | toasts; `ToastPill` for the inline pill under the cart dock |
| `AccentWord`, `Eyebrow`, `Lbl`, `RoleTag`, `Kbd` | typography primitives |
| `ThemeToggle`, `ThemeSegmented` | §2 |

Location helpers (foundation): `components/location/AddressAutocomplete` (MKT-1 combobox, reusable in the
location picker), `lib/places` (`searchPlaces`, `getPlace`, `reverseGeocode`), `lib/location`
(`useChosenLocation`, `setChosenLocation` — the same `thali.location` store the consumer area uses).

## 7. Illustrations

`components/illustrations`: `CuisineArt slug` (+ `CUISINES`, `cuisineMeta`, `hasCuisineArt`), `HeroBiryani`,
`HeroDosa`, `HeroGulabJamun`, `HeroNoodles`, `HeroSunBlobs`, `LogoMark`, `PromoRestaurantsMark`,
`PromoRidersBike`, `RestaurantCoverArt` / `RestaurantLogoArt` (colour = `currentColor`, pass the hue via
`style={{ color: hueFor(id) }}`), `MapRouteArt`. Decorative (`aria-hidden`).

## 8. Responsive

Breakpoints: phone `max-sm` (<640), tablet `sm`–`lg`, desktop `lg` (≥1024), wide `xl`.
- Page padding 24px (`px-6`), 16px on phones (`max-sm:px-4`). Shells already pad `main`.
- Grids: `grid-cols-[repeat(auto-fit,minmax(min(260px,100%),1fr))]` (cards 260 · KPI 170/150 · kanban 300 ·
  panels 440 · addresses 220).
- Touch: every button/control grows to 44px on `pointer:coarse` (built in).
- Dialogs become bottom sheets on phones; tables become cards ≤768; sticky bottom bars must add
  `pb-[env(safe-area-inset-bottom)]`. Phone tab bars are 56px — leave `max-sm:pb-24` (shells do it for `main`).
- Kanban ≤640 → `SegmentedTabs semantics="tabs"`; partner offer ≤640 → `Sheet side="bottom"` (spec §6.5).

## 9. Routes & sign-in

| Route | Notes |
|---|---|
| `/` | public landing, **always** (user decision 2026-10-11; no location gate) |
| `/welcome` | alias of `/` (landing) |
| `/discover` | consumer home (Discover). Consumer logo, Home tab, "Restaurants" links, empty states and the landing's address pick / "Find food" / cuisines go here |
| `/terms` `/privacy` `/refunds` `/help` `/partner-with-us` `/ride-with-thali` | public pages |
| `/signin?role=customer\|restaurant\|partner\|admin&next=` | unified sign-in. After sign-in: customer → `next`‖`/discover`; restaurant → `next`‖`/restaurant` (no owner role → `/restaurant/onboarding`); partner likewise; admin → admin `next`‖`/admin` (`lib/signin.destinationAfterSignIn`) |
| `/admin/login` | redirects to `/signin?role=admin` (keeps `next`) |
| `/admin/forgot`, `/admin/reset-password?token=` | IDN-1 reset |
| `/offers` | linked from the public header — **the consumer area provides it** (MKT-7) |

Landing cuisine circles link to `/discover?cuisine=<slug>` (consumer discover reads it). Reuse `OtpSignInForm`
(unchanged props; now has `onStepChange`) in the consumer `LoginDialog`.

## 10. Testing tips

- Shells render phone and desktop navigation in the DOM at once (CSS hides one), so use `getAllByRole` for logo /
  nav links in jsdom, or scope with `within(screen.getByRole('main'))`.
- `ModeBanner` / `DemoPill` fetch `/meta`; route your fetch mock by URL and create a new `Response` per call.
- The theme store is module-level: call `__resetThemeForTests()` between tests that change it.
- Foundation tests live in `test/foundation/` (theme, components, countdown/code entry, landing flow, sign-in
  routing + page, shells, `cn` merge rules, polish: Popover / shell slots / tab bars).
- Phone tab bar: `screen.getAllByRole('navigation', { name: 'Restaurant' }).at(-1)` is the bottom bar (sidebar and
  rail navs come first in the DOM).
