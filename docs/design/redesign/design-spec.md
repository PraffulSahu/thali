# Thali UI redesign — binding design specification

Source of truth: the Claude Design export in `design/` (10 boards: `NN-*.html` markup/CSS + `screens/*.png`).
Screenshot ↔ board map: `board-00.png` (+ `b00-0/1/2.png`) = 00 public · `board-01` = 01 sign-in · `board-02` = 02
foundations · `board-03` = 10 discover · `board-04` = 11 restaurant (customizer open) · `board-05` = 12 checkout ·
`board-06` = 13 tracking · `board-07` = 20 owner live · `board-08` = 30 partner home · `board-09` = 40 admin overview.

How to read this document:
- Values are copied literally from the export CSS. Anything not in the export is marked **(derived)** or
  **(extrapolated)**. Derived values were chosen to fit the system; do not treat them as design-approved.
- "Board NN" = the HTML file `design/NN-*.html`.
- Component names map to `apps/web/src/components/ui/*` and `features/*` where a match exists (§3.0).
- **Token layering in the export (important):** every app board (01, 10–40) declares three token layers. Layer 1 is a
  zinc/ink prototype (`--pri:#09090b`), layer 2 (identical in all app boards) is the final "Masala" override.
  **Only layer 2 is canonical.** Boards 00 and 02 use a slightly different naming (`--sun`, `--leaf`, `--pri-ink`)
  for the same palette. §1 unifies both into one token set.
- App boards also carry global overrides that change what the inline styles say. These are binding:
  - `.thali h1,.thali h2,.thali h3{font-family:'Bricolage Grotesque','Figtree',sans-serif!important;font-weight:800!important;letter-spacing:-.025em!important}` (so every h1–h3 is Bricolage 800, whatever the inline `font:600 … 'Figtree'` says; inline **size and line-height still apply**).
  - `.thali h1.mono{font-family:'JetBrains Mono',monospace!important;font-weight:600!important;letter-spacing:0!important}` (order-code titles).
  - `.thali .serif{font-family:'Bricolage Grotesque'…!important;font-style:normal!important;font-weight:800!important;color:var(--acc)}` → the "accent word" pattern (`<span class="serif" style="font-size:1.1em">`), see §2.
  - `.thali .btn{font-weight:700!important}`, `.thali .chip{font-weight:700!important}`.
  - `.thali .demo{background:#141414;color:#ffc145;border-bottom:0}` (demo strip).
  - `.thali th{background:var(--side)!important}` (admin tables).

---

## 1. Tokens

### 1.1 Semantic colour tokens (runtime CSS custom properties)

Canonical names are the export's names so the HTML can be cross-read 1:1. Light = `:root` /
`[data-theme="light"]`; dark = `[data-theme="dark"]`.

| Token | Light | Dark | Role |
|---|---|---|---|
| `--bg` | `#ffffff` | `#0d0c0c` | Page base (under `--glow`) |
| `--bg2` | `#f7f7f7` | `#141312` | Recessed fill: bill footer, modal footer, info boxes, code boxes, table header (legacy), skeleton highlight |
| `--card` | `#ffffff` | `#1a1817` | Cards, inputs on marketing, dialogs |
| `--muted` | `#f2f2f2` | `#242120` | Neutral fill: avatars, segmented track, chips (neutral), progress/ring tracks, skeleton base, ghost hover |
| `--line` | `#e9e6e3` | `#2e2a28` | Default 1px borders and dividers |
| `--line2` | `#dad5d0` | `#3e3936` | Strong border (marketing inputs/outline buttons, dashed empties), switch off-track, unchecked radio/checkbox ring |
| `--fg` | `#141414` | `#f5f5f5` | Primary text ("Ink"); also timeline "done" bars, selected radio/checkbox fill |
| `--fg2` | `#3d3d3d` | `#d4d4d4` | Secondary text, nav links, meta rows |
| `--fg3` | `#6b6b6b` | `#a3a3a3` | Tertiary text (`.muted`), labels (`.lbl`), placeholders |
| `--neu` | `#a3a3a3` | `#57534e` | Neutral data colour (stacked-bar "Cancelled") |
| `--side` | `rgba(255,255,255,.55)` | `rgba(255,255,255,.025)` | Translucent band: sidebars, cuisine band, restaurant hero band, sign-in aside, table header (with `backdrop-filter:blur(6–8px)`) |
| `--band` | `rgba(255,255,255,.62)` | `rgba(255,255,255,.03)` | Public-page bands (utility bar, cuisines band, promise band, footer) + `backdrop-filter:blur(8px)` |
| `--pri` | `#d23f11` | `#ff7445` | Chili primary: primary buttons, selected pills, logo disc, rider marker, status pill on cards |
| `--pri-h` | `#b8360d` | `#ff8a60` | Primary hover |
| `--pri-fg` | `#ffffff` | `#121212` | Text/icon on `--pri` |
| `--acc` | `#d23f11` | `#ff7445` | Accent (== `--pri` in final palette): accent words, focus ring, live pulse, countdown ring, current-step bar, nav badges, map route |
| `--acc-fg` | `#a8320b` | `#ff9a73` | Accent-coloured **text** on light/soft surfaces (export: `--pri-ink`) |
| `--acc-soft` | `#ffede5` | `rgba(255,116,69,.15)` | Accent tint: selected option/address bg, "brand" chip bg, KPI highlight (export: `--pri-soft`) |
| `--sun` | `#ffb020` | `#ffc145` | Turmeric: offers, hero art panel, focus ring on coloured blocks |
| `--sun-soft` | `#fff1d6` | `rgba(255,193,69,.14)` | Turmeric tint (== `--warn-bg`) |
| `--sun-ink` | `#9a5b00` | `#ffc145` | Turmeric text (== `--warn`) |
| `--ok` | `#0e7a3b` | `#6ee79a` | Success text/fill (export: `--leaf-ink`) |
| `--ok-bg` | `#e8f6ec` | `rgba(74,222,128,.13)` | Success tint (export: `--leaf-soft`) |
| `--leaf` | `#12813f` | `#4ade80` | Leaf solid (switch on-state uses `--ok`; door icon tile, rating badge solid) |
| `--warn` | `#9a5b00` | `#ffc145` | Warning text |
| `--warn-bg` | `#fff1d6` | `rgba(255,193,69,.14)` | Warning tint (EST. badge, notes, REQUIRED tag) |
| `--bad` | `#b42318` | `#ff8a80` | Danger text/fill |
| `--bad-bg` | `#fdecea` | `rgba(255,138,128,.14)` | Danger tint |
| `--info` | `#1d4ed8` | `#7aa7ff` | Sky: live/in-transit/info text |
| `--info-bg` | `#eaf1ff` | `rgba(122,167,255,.14)` | Sky tint |
| `--veg` | `#12813f` | `#4ade80` | Veg mark |
| `--nveg` | `#9b2c0e` | `#ff8a65` | Non-veg mark (Clove) |
| `--map` | `#f4efe9` | `#171514` | Map placeholder ground |
| `--road` | `#ffffff` | `#2a2725` | Map placeholder roads |
| `--blk` | `#ebe3d9` | `#1f1c1a` | Map placeholder blocks |
| `--grid` | `rgba(20,20,20,.035)` | `rgba(255,255,255,.03)` | 56px grid on sign-in aside (`.gridbg`) |
| `--overlay` | `rgba(9,9,11,.55)` | `rgba(9,9,11,.55)` | Modal scrim (+ `backdrop-filter:blur(2px)`) |
| `--strip-bg` | `#141414` | `#141414` | Demo strip background (both themes) |
| `--strip-fg` | `#ffc145` | `#ffc145` | Demo strip text (both themes) |

Fixed literal colours that do **not** flip (used on coloured marketing blocks / art): `#d23f11` restaurants promo block,
`#141414` riders promo block, `#ffb020` CTA block, `#ffd7c7` (eyebrow on chili), `#ffe6dc` (paragraph on chili),
`#c9c9c9` (paragraph on ink), `#3d2a00` (paragraph on turmeric), `#ff9d1a`/`#ffcf5c` (hero blobs), `#ffc145` (logo
yellow dot), `#12813f` + `#fff` (solid rating badge, marketing/foundations only), `#fff` (hero dish discs).

**Board 00/02 variance (resolved):** board 00/02 light neutrals are `--bg2 #f6f6f6`, `--muted #f1f1f1`,
`--line #e8e8e8`, `--line2 #d9d9d9`; dark `--bg #121212 --bg2 #171717 --muted #262626 --line #2e2e2e --line2 #3d3d3d
--card #1a1817 (02 override; 00 has #1c1c1c)`. These are ≤1–2 RGB steps from the app layer. **Use the app layer
values above everywhere**, including the public page. Board 02 also uses a warmer shadow (`rgba(60,30,10,…)`); ignore
it in favour of §1.4.

### 1.2 Palette scales (static; for illustration, charts, one-off fills)

Values marked *src* are in the export; others are **(derived)** interpolations — use sparingly.

| Scale | Steps |
|---|---|
| **Chili** | 50 `#ffede5` *src* · 100 `#ffe6dc` *src* · 200 `#ffd7c7` *src* · 300 `#ff9a73` *src* · 400 `#ff7445` *src* · 450 `#ff8a60` *src (dark hover)* · 500 `#ff7a45` *src (glow rgba(255,122,69))* · 550 `#ff6a33` *src (dark glow rgba(255,106,51))* · 600 `#d23f11` *src* · 700 `#b8360d` *src* · 800 `#a8320b` *src* |
| **Turmeric** | 50 `#fff1d6` *src* · 100 `#fff3cc` *src* · 200 `#ffcf5c` *src* · 300 `#ffc145` *src* · 400 `#ffb020` *src* · 500 `#ff9d1a` *src* · 800 `#9a5b00` *src* · 900 `#3d2a00` *src* |
| **Leaf** | 50 `#e8f6ec` *src* · 100 `#e3f4e6` *src* · 300 `#6ee79a` *src* · 400 `#4ade80` *src* · 700 `#12813f` *src* · 800 `#0e7a3b` *src* |
| **Clove** | 300 `#ff8a65` *src* · 800 `#9b2c0e` *src* · 900 `#be4614` **(derived)** — prefer 800 |
| **Sky** | 50 `#eaf1ff` *src* · 300 `#7aa7ff` *src* · 700 `#1d4ed8` *src* |
| **Red (bad)** | 50 `#fdecea` *src* · 300 `#ff8a80` *src* · 700 `#b42318` *src* |
| **Ink** (light neutrals, warm) | 0 `#ffffff` · 25 `#fff9f4` (glow base) · 30 `#fffaf6` (public glow mid) · 50 `#f7f7f7` · 100 `#f2f2f2` · 200 `#e9e6e3` · 300 `#dad5d0` · 400 `#a3a3a3` · 500 `#6b6b6b` · 700 `#3d3d3d` · 900 `#141414` — all *src* |
| **Ember** (dark surfaces) | 500 `#57534e` · 600 `#3e3936` · 700 `#2e2a28` · 800 `#242120` · 850 `#1a1817` · 900 `#141312` · 950 `#0d0c0c` — all *src*; dark text uses `#f5f5f5 / #d4d4d4 / #a3a3a3` |

Restaurant identity hues (cover/logo tiles when there is no image; from board 10 data):
`#c2410c` (Spice Route) · `#15803d` (Green Leaf) · `#a16207` (Nandi Tiffins) · `#0e7490` (Coastal Curry) ·
`#7c3aed` (Tandoor Tales) · `#be185d` (Kettle & Bun). Use this 6-hue list, picked deterministically from the restaurant
id (`hash(id) % 6`) when the API provides no image. Cuisine hues: §4.

### 1.3 Ember-glow page backgrounds

Applied to the page root (`.page{background:var(--glow)}`); cards stay solid.

```css
/* App pages (boards 01, 10–40) */
--glow: radial-gradient(1000px 700px at 88% -120px, rgba(255,122,69,.2), transparent 70%),
        radial-gradient(800px 700px at -150px 380px, rgba(255,176,32,.18), transparent 70%),
        radial-gradient(900px 800px at 110% 1300px, rgba(255,122,69,.11), transparent 70%),
        linear-gradient(180deg, #fff9f4 0, #ffffff 900px);
/* dark */
--glow: radial-gradient(1000px 700px at 88% -120px, rgba(255,106,51,.26), transparent 70%),
        radial-gradient(800px 700px at -150px 380px, rgba(190,70,20,.24), transparent 70%),
        radial-gradient(900px 800px at 110% 1300px, rgba(255,106,51,.12), transparent 70%),
        #0d0c0c;

/* Long marketing page (board 00, ~3300px tall) */
--glow-long: radial-gradient(1000px 700px at 88% -120px, rgba(255,122,69,.22), transparent 70%),
             radial-gradient(800px 700px at -150px 380px, rgba(255,176,32,.2), transparent 70%),
             radial-gradient(900px 800px at 110% 1500px, rgba(255,122,69,.13), transparent 70%),
             radial-gradient(900px 800px at -150px 2300px, rgba(255,176,32,.15), transparent 70%),
             radial-gradient(900px 700px at 90% 3150px, rgba(255,122,69,.12), transparent 70%),
             linear-gradient(180deg, #fff9f4 0, #ffffff 900px, #fffaf6 2200px, #ffffff 100%);
/* dark */
--glow-long: radial-gradient(1000px 700px at 88% -120px, rgba(255,106,51,.28), transparent 70%),
             radial-gradient(800px 700px at -150px 380px, rgba(190,70,20,.26), transparent 70%),
             radial-gradient(900px 800px at 110% 1500px, rgba(255,106,51,.13), transparent 70%),
             radial-gradient(900px 800px at -150px 2300px, rgba(255,160,40,.1), transparent 70%),
             radial-gradient(900px 700px at 90% 3150px, rgba(255,106,51,.13), transparent 70%),
             #0d0c0c;
```
Other gradients: sign-in aside spot `radial-gradient(60% 55% at 75% 15%, var(--acc-soft), transparent 70%)`;
offer-badge cover `linear-gradient(135deg,#ffb020,#d23f11)` (dark `linear-gradient(135deg,#ffc145,#ff7445)`);
skeleton `linear-gradient(90deg,var(--muted) 0,var(--bg2) 50%,var(--muted) 100%)` / `background-size:600px 100%`;
demo hatch (unused prototype variant) `repeating-linear-gradient(135deg,var(--warn-bg) 0 12px,transparent 12px 24px)`;
cart-train fade mask `linear-gradient(90deg,#000 92%,transparent)`.
The glow is `background` on the root element of each shell (not `background-attachment:fixed`); sticky headers use
`background:color-mix(in srgb,var(--bg) 85%,transparent);backdrop-filter:blur(12px)` (public: 80% / blur(16px)).

### 1.4 Shadows

| Token | Light | Dark | Use |
|---|---|---|---|
| `--shadow` (utility `shadow-card`) | `0 1px 2px rgba(20,20,20,.05),0 12px 32px -14px rgba(20,20,20,.22)` | `0 1px 2px rgba(0,0,0,.5),0 12px 32px -14px rgba(0,0,0,.8)` | Hovered cards, sticky bill, hero search pill, toasts |
| `--shadow-lg` (`shadow-float`) | `0 2px 6px rgba(20,20,20,.06),0 30px 60px -24px rgba(20,20,20,.35)` | `0 2px 6px rgba(0,0,0,.5),0 30px 60px -24px rgba(0,0,0,.9)` | Cart dock + tray, hero cart card, dish discs, door hover |
| `--shadow-modal` | `0 1px 2px rgba(20,20,20,.05),0 24px 64px -24px rgba(20,20,20,.35)` | `0 1px 2px rgba(0,0,0,.5),0 24px 64px -24px rgba(0,0,0,.9)` | Dialogs (board 11 overrides `--shadow` to this inside the modal) |
| `--shadow-pri` | `0 8px 18px -8px color-mix(in srgb,var(--pri) 70%,transparent)` | same formula | Primary button glow |
| `--shadow-seg` | `0 1px 2px rgba(0,0,0,.08),0 0 0 1px var(--line)` | same | Selected segmented tab |
| `--shadow-knob` | `0 1px 2px rgba(0,0,0,.3)` (44px switch) / `0 1px 3px rgba(0,0,0,.3)` (64px switch) | same | Switch knob |
| `--shadow-chip-btn` | `0 2px 6px rgba(0,0,0,.08)` | same | "Add +" button overlapping dish image |
| Hairline-ring | `box-shadow:0 0 0 1px var(--line)` | same | Current nav item, selected tab, cuisine circle ring (`0 0 0 1.5px var(--line)`) |

### 1.5 Radii

| Token | Value | Used by |
|---|---|---|
| `--radius-tag` | `5px` | EST. badge, DEFAULT tag, role tag (KITCHEN/PARTNER/OPS), kbd |
| `--radius-xs` | `6px` | Rating badge (app), demo pill (public), app segmented inner (`.tseg button`) |
| `--radius-badge` | `8px` | Rating badge (marketing), % OFF badge, SIMULATED tag, cart initials tile, tseg track |
| `--radius-item` | `10px` | Sidebar nav item (admin 9px), menu category link, note box, 34–36px icon tiles, admin search button |
| `--radius-control` | `12px` | App inputs, option rows, code boxes, prep pills, select, card block buttons (Accept/Mark ready), info boxes, sign-in inputs |
| `--radius-field` | `14px` | Marketing inputs, header search, cart button, address cards, dish image, banners/notices, admin cards, swatches |
| `--radius-card` | `16px` | App cards (consumer, owner, partner), cart tray, door icon tile, dashed empties |
| `--radius-card-lg` | `20px` | Marketing cards, restaurant logo tile (96px) |
| `--radius-panel` | `24px` | Theme preview panels (board 02) |
| `--radius-block` | `28px` | Promo blocks, CTA block |
| `--radius-art` | `40px` | Hero art panel |
| `--radius-pill` | `999px` | Buttons, chips, filter pills, segmented track, live pill, cart dock |

### 1.6 Spacing & layout

- Base unit 4px; the export also uses 2px half-steps (6, 10, 14, 18, 22, 26). Tailwind v4's `--spacing:0.25rem` covers
  all (`p-3.5` = 14px, `gap-4.5` = 18px).
- Common gaps: 2 (nav list), 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 28, 32, 36, 40, 48.
- Content containers: public `max-width:1240px` · discover `1360px` · restaurant page & tracking `1200px` · checkout
  `1160px`; all with `padding:0 24px`. Sign-in form column `max-width:400px`; sign-in aside content `440px`.
  Modal `max-width:520px`. Role shells: sidebar `232px` (admin `224px`), main
  `padding:22px clamp(16px,2.4vw,32px) 40px` (admin `24px …`).
- Section padding (public): hero `72px 24px 88px`; bands `48px 24px`; sections `72–88px 24px`.
- Grids use `repeat(auto-fit|auto-fill,minmax(min(Npx,100%),1fr))`: restaurant cards 260 · doors 260 · how-it-works
  320 · promise 230 · promo 460 · KPI (owner) 170 · KPI (admin) 150 · kanban 300 · admin panels 440 · checkout
  addresses 220 · review cards 280 · cart tray slots 300 · footer 170.

### 1.7 Focus rings

- Default (all app shells): `:focus-visible{outline:2px solid var(--acc);outline-offset:2px}`.
- Marketing (board 00): `outline:3px solid var(--sun);outline-offset:2px`. **Binding rule:** use the 2px `--acc` ring
  everywhere **except** on chili- or ink-filled surfaces (promo blocks, cart dock, primary buttons inside the dock,
  demo strip), where the ring is `3px solid var(--sun)` (`--ring-on-color`).
- Text fields: `:focus{border-color:var(--fg3);box-shadow:0 0 0 4px var(--muted)}` (app inputs, code entry).
  Header search (marketing): `:focus-within{border-color:var(--pri);box-shadow:0 0 0 4px var(--pri-soft)}`.

### 1.8 Motion

- Easing: `--ease-out: cubic-bezier(.2,.8,.2,1)` (every entrance, knob, hover-lift); `ease-out` for pulses;
  `linear` for spinners/shimmer/countdowns; `ease-in-out` for bobbing/blinks.
- Durations: `.12s` row hover · `.15s` buttons/pills/borders · `.2s` card hover, switch track, accordion chevron ·
  `.25s` cuisine ring, knob (`.28s` partner) · `.3s` theme colour swap · `.35s` dish svg wobble, dialog pop, form swap ·
  `.45–.7s` entrances · `1s linear` countdown stroke step.
- Keyframes (copy verbatim):
```css
@keyframes rise{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}           /* .55–.7s; 18px on public, 8px admin */
@keyframes pulse{0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--acc) 55%,transparent)}100%{box-shadow:0 0 0 10px transparent}} /* 1.8s ease-out infinite; ok-variant uses var(--ok) 50%, 8–10px */
@keyframes shimmer{from{background-position:-300px 0}to{background-position:300px 0}}             /* 1.5s linear infinite */
@keyframes drain{from{stroke-dashoffset:0}to{stroke-dashoffset:113}}                                /* foundations demo only */
@keyframes bob{0%,100%{transform:translateY(0) rotate(0)}50%{transform:translateY(-10px) rotate(4deg)}}  /* 5s */
@keyframes bob2{0%,100%{transform:translateY(0) rotate(0)}50%{transform:translateY(8px) rotate(-5deg)}}  /* 6s */
@keyframes split{0%,25%{transform:translateX(0)}45%,80%{transform:translateX(14px)}100%{transform:translateX(0)}} /* 4.5s */
@keyframes dockin{0%{opacity:0;transform:translateY(40px) scale(.96)}60%{opacity:1}100%{transform:none}} /* .6s .3s */
@keyframes trayin{from{opacity:0;transform:translateY(14px) scale(.98)}to{opacity:1;transform:none}}     /* .28s, origin bottom center */
@keyframes bump{0%,100%{transform:none}40%{transform:scale(1.06)}}                                     /* .5s on count change */
@keyframes toast{0%{opacity:0;transform:translateY(6px)}12%,70%{opacity:1;transform:none}100%{opacity:0}} /* 4.5s */
@keyframes pop{from{opacity:0;transform:translateY(16px) scale(.98)}to{opacity:1;transform:none}}       /* .35s dialog */
@keyframes fade{from{opacity:0}to{opacity:1}}                                                          /* .25s scrim */
@keyframes open{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}                 /* .25s accordion/inline reveal */
@keyframes spin{to{transform:rotate(360deg)}}                                                          /* .8s linear */
@keyframes dash{to{stroke-dashoffset:-24}}                                                             /* map route 1.2s linear */
@keyframes ride{from{offset-distance:30%}to{offset-distance:74%}}                                     /* rider on offset-path, 10s ease-in-out infinite alternate */
@keyframes arrive{0%{opacity:0;transform:translateY(-14px)}100%{opacity:1;transform:none}}              /* new order .5s */
@keyframes ring{0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--acc) 45%,transparent)}100%{box-shadow:0 0 0 14px transparent}} /* 1.8s ×3 after arrive */
@keyframes slidein{from{opacity:0;transform:translateX(-18px)}to{opacity:1;transform:none}}            /* .45s card moved column */
@keyframes in{from{opacity:0;transform:translateY(14px) scale(.98)}to{opacity:1;transform:none}}        /* .45s offer card */
@keyframes urgent{0%,100%{box-shadow:0 0 0 0 transparent}50%{box-shadow:0 0 0 4px color-mix(in srgb,var(--bad) 30%,transparent)}} /* 1s, ring ≤10s */
@keyframes grow{from{transform:scaleX(0)}to{transform:none}}                                           /* .9s .15s stacked bar, origin left */
@keyframes blink{0%,100%{opacity:1}50%{opacity:.35}}                                                   /* 1.4s health dot */
@keyframes swap{from{opacity:0;transform:translateX(10px)}to{opacity:1;transform:none}}                /* .35s sign-in step/role swap */
@keyframes slide{from{transform:translateX(0)}to{transform:translateX(-50%)}}                         /* declared, unused */
```
- Staggers: lists use `animation-delay: i*.04–.05s` (cuisines `.04s`, restaurant cards `.05s`, admin KPIs `.04s`).
- Reduced motion (binding): `@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}`
  and the tracking rider sits at `offset-distance:58%`. Pulses become static dots; countdown text still updates.
- Theme switch: root `transition:background .3s,color .3s`.

### 1.9 Ready-to-paste Tailwind v4 block (`apps/web/src/styles.css`)

Replace the current `@theme` block. Legacy scales (`brand-*`, `success-*`, `warn-*`, `danger-*`, `info-*`, `slate-*`)
may be kept temporarily for untouched screens; new/rebuilt components must use only the utilities below.
Dark mode is attribute-driven: set `document.documentElement.dataset.theme = 'light' | 'dark'`
(initial value from `localStorage['thali-theme']`, else `prefers-color-scheme`; persist on change).

```css
@import "tailwindcss";
@import "@fontsource-variable/bricolage-grotesque";
@import "@fontsource-variable/figtree";
@import "@fontsource-variable/jetbrains-mono";

@custom-variant dark (&:where([data-theme="dark"], [data-theme="dark"] *));

/* ---------- 1. Runtime semantic tokens ---------- */
:root, [data-theme="light"] {
  color-scheme: light;
  --bg:#ffffff; --bg2:#f7f7f7; --card:#ffffff; --muted:#f2f2f2; --line:#e9e6e3; --line2:#dad5d0;
  --fg:#141414; --fg2:#3d3d3d; --fg3:#6b6b6b; --neu:#a3a3a3;
  --side:rgba(255,255,255,.55); --band:rgba(255,255,255,.62);
  --pri:#d23f11; --pri-h:#b8360d; --pri-fg:#ffffff;
  --acc:#d23f11; --acc-fg:#a8320b; --acc-soft:#ffede5;
  --sun:#ffb020; --sun-soft:#fff1d6; --sun-ink:#9a5b00; --leaf:#12813f;
  --ok:#0e7a3b; --ok-bg:#e8f6ec; --warn:#9a5b00; --warn-bg:#fff1d6;
  --bad:#b42318; --bad-bg:#fdecea; --info:#1d4ed8; --info-bg:#eaf1ff;
  --veg:#12813f; --nveg:#9b2c0e;
  --map:#f4efe9; --road:#ffffff; --blk:#ebe3d9; --grid:rgba(20,20,20,.035);
  --overlay:rgba(9,9,11,.55); --strip-bg:#141414; --strip-fg:#ffc145;
  --shadow:0 1px 2px rgba(20,20,20,.05),0 12px 32px -14px rgba(20,20,20,.22);
  --shadow-lg:0 2px 6px rgba(20,20,20,.06),0 30px 60px -24px rgba(20,20,20,.35);
  --shadow-modal:0 1px 2px rgba(20,20,20,.05),0 24px 64px -24px rgba(20,20,20,.35);
  --shadow-pri:0 8px 18px -8px color-mix(in srgb,var(--pri) 70%,transparent);
  --ring:var(--acc); --ring-on-color:var(--sun);
  --glow:radial-gradient(1000px 700px at 88% -120px,rgba(255,122,69,.2),transparent 70%),radial-gradient(800px 700px at -150px 380px,rgba(255,176,32,.18),transparent 70%),radial-gradient(900px 800px at 110% 1300px,rgba(255,122,69,.11),transparent 70%),linear-gradient(180deg,#fff9f4 0,#ffffff 900px);
  --glow-long:radial-gradient(1000px 700px at 88% -120px,rgba(255,122,69,.22),transparent 70%),radial-gradient(800px 700px at -150px 380px,rgba(255,176,32,.2),transparent 70%),radial-gradient(900px 800px at 110% 1500px,rgba(255,122,69,.13),transparent 70%),radial-gradient(900px 800px at -150px 2300px,rgba(255,176,32,.15),transparent 70%),radial-gradient(900px 700px at 90% 3150px,rgba(255,122,69,.12),transparent 70%),linear-gradient(180deg,#fff9f4 0,#ffffff 900px,#fffaf6 2200px,#ffffff 100%);
}
[data-theme="dark"] {
  color-scheme: dark;
  --bg:#0d0c0c; --bg2:#141312; --card:#1a1817; --muted:#242120; --line:#2e2a28; --line2:#3e3936;
  --fg:#f5f5f5; --fg2:#d4d4d4; --fg3:#a3a3a3; --neu:#57534e;
  --side:rgba(255,255,255,.025); --band:rgba(255,255,255,.03);
  --pri:#ff7445; --pri-h:#ff8a60; --pri-fg:#121212;
  --acc:#ff7445; --acc-fg:#ff9a73; --acc-soft:rgba(255,116,69,.15);
  --sun:#ffc145; --sun-soft:rgba(255,193,69,.14); --sun-ink:#ffc145; --leaf:#4ade80;
  --ok:#6ee79a; --ok-bg:rgba(74,222,128,.13); --warn:#ffc145; --warn-bg:rgba(255,193,69,.14);
  --bad:#ff8a80; --bad-bg:rgba(255,138,128,.14); --info:#7aa7ff; --info-bg:rgba(122,167,255,.14);
  --veg:#4ade80; --nveg:#ff8a65;
  --map:#171514; --road:#2a2725; --blk:#1f1c1a; --grid:rgba(255,255,255,.03);
  --shadow:0 1px 2px rgba(0,0,0,.5),0 12px 32px -14px rgba(0,0,0,.8);
  --shadow-lg:0 2px 6px rgba(0,0,0,.5),0 30px 60px -24px rgba(0,0,0,.9);
  --shadow-modal:0 1px 2px rgba(0,0,0,.5),0 24px 64px -24px rgba(0,0,0,.9);
  --glow:radial-gradient(1000px 700px at 88% -120px,rgba(255,106,51,.26),transparent 70%),radial-gradient(800px 700px at -150px 380px,rgba(190,70,20,.24),transparent 70%),radial-gradient(900px 800px at 110% 1300px,rgba(255,106,51,.12),transparent 70%),#0d0c0c;
  --glow-long:radial-gradient(1000px 700px at 88% -120px,rgba(255,106,51,.28),transparent 70%),radial-gradient(800px 700px at -150px 380px,rgba(190,70,20,.26),transparent 70%),radial-gradient(900px 800px at 110% 1500px,rgba(255,106,51,.13),transparent 70%),radial-gradient(900px 800px at -150px 2300px,rgba(255,160,40,.1),transparent 70%),radial-gradient(900px 700px at 90% 3150px,rgba(255,106,51,.13),transparent 70%),#0d0c0c;
}

/* ---------- 2. Static theme (fonts, palette, radii, motion) ---------- */
@theme {
  --font-display: "Bricolage Grotesque Variable", "Bricolage Grotesque", "Figtree Variable", system-ui, sans-serif;
  --font-sans: "Figtree Variable", "Figtree", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --font-mono: "JetBrains Mono Variable", "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;

  --color-chili-50:#ffede5; --color-chili-100:#ffe6dc; --color-chili-200:#ffd7c7; --color-chili-300:#ff9a73;
  --color-chili-400:#ff7445; --color-chili-500:#ff7a45; --color-chili-600:#d23f11; --color-chili-700:#b8360d; --color-chili-800:#a8320b;
  --color-turmeric-50:#fff1d6; --color-turmeric-100:#fff3cc; --color-turmeric-200:#ffcf5c; --color-turmeric-300:#ffc145;
  --color-turmeric-400:#ffb020; --color-turmeric-500:#ff9d1a; --color-turmeric-800:#9a5b00; --color-turmeric-900:#3d2a00;
  --color-leaf-50:#e8f6ec; --color-leaf-100:#e3f4e6; --color-leaf-300:#6ee79a; --color-leaf-400:#4ade80; --color-leaf-700:#12813f; --color-leaf-800:#0e7a3b;
  --color-clove-300:#ff8a65; --color-clove-800:#9b2c0e;
  --color-sky-50:#eaf1ff; --color-sky-300:#7aa7ff; --color-sky-700:#1d4ed8;
  --color-red-50:#fdecea; --color-red-300:#ff8a80; --color-red-700:#b42318;
  --color-ink-0:#ffffff; --color-ink-25:#fff9f4; --color-ink-50:#f7f7f7; --color-ink-100:#f2f2f2; --color-ink-200:#e9e6e3;
  --color-ink-300:#dad5d0; --color-ink-400:#a3a3a3; --color-ink-500:#6b6b6b; --color-ink-700:#3d3d3d; --color-ink-900:#141414;
  --color-ember-500:#57534e; --color-ember-600:#3e3936; --color-ember-700:#2e2a28; --color-ember-800:#242120;
  --color-ember-850:#1a1817; --color-ember-900:#141312; --color-ember-950:#0d0c0c;

  --radius-tag:5px; --radius-xs:6px; --radius-badge:8px; --radius-item:10px; --radius-control:12px;
  --radius-field:14px; --radius-card:16px; --radius-card-lg:20px; --radius-panel:24px; --radius-block:28px;
  --radius-art:40px; --radius-pill:9999px;

  --container-public:1240px; --container-discover:1360px; --container-page:1200px; --container-checkout:1160px;
  --spacing-touch:2.75rem;

  --ease-out:cubic-bezier(.2,.8,.2,1);
  --animate-rise:rise .55s cubic-bezier(.2,.8,.2,1) both;
  --animate-pulse-live:pulse 1.8s ease-out infinite;
  --animate-shimmer:shimmer 1.5s linear infinite;
  --animate-pop:pop .35s cubic-bezier(.2,.8,.2,1) both;
  --animate-fade:fade .25s ease-out both;
  --animate-open:open .25s cubic-bezier(.2,.8,.2,1) both;
  --animate-spin-btn:spin .8s linear infinite;
  --animate-dock:dockin .6s .3s cubic-bezier(.2,.8,.2,1) both;
  --animate-tray:trayin .28s cubic-bezier(.2,.8,.2,1) both;
  --animate-arrive:arrive .5s cubic-bezier(.2,.8,.2,1) both, ring 1.8s .5s ease-out 3;
  --animate-slidein:slidein .45s cubic-bezier(.2,.8,.2,1) both;
  --animate-in:in .45s cubic-bezier(.2,.8,.2,1) both;
  --animate-urgent:urgent 1s ease-in-out infinite;
  --animate-grow:grow .9s .15s cubic-bezier(.2,.8,.2,1) both;
  --animate-blink:blink 1.4s ease-in-out infinite;
  --animate-swap:swap .35s cubic-bezier(.2,.8,.2,1) both;
  --animate-bob:bob 5s ease-in-out infinite;
  --animate-bob2:bob2 6s ease-in-out infinite;
  --animate-toast:toast 4.5s ease-out both;
  --animate-bump:bump .5s ease-out both;
  /* keyframes: paste the §1.8 block here */
}

/* ---------- 3. Semantic utilities (bg-card, text-fg-3, border-line, shadow-card …) ---------- */
@theme inline {
  --color-bg:var(--bg); --color-bg-2:var(--bg2); --color-card:var(--card); --color-fill:var(--muted);
  --color-line:var(--line); --color-line-2:var(--line2);
  --color-fg:var(--fg); --color-fg-2:var(--fg2); --color-fg-3:var(--fg3); --color-neu:var(--neu);
  --color-side:var(--side); --color-band:var(--band);
  --color-pri:var(--pri); --color-pri-h:var(--pri-h); --color-pri-fg:var(--pri-fg);
  --color-acc:var(--acc); --color-acc-fg:var(--acc-fg); --color-acc-soft:var(--acc-soft);
  --color-sun:var(--sun); --color-sun-soft:var(--sun-soft); --color-sun-ink:var(--sun-ink); --color-leaf:var(--leaf);
  --color-ok:var(--ok); --color-ok-bg:var(--ok-bg); --color-warn:var(--warn); --color-warn-bg:var(--warn-bg);
  --color-bad:var(--bad); --color-bad-bg:var(--bad-bg); --color-info:var(--info); --color-info-bg:var(--info-bg);
  --color-veg:var(--veg); --color-nveg:var(--nveg);
  --color-map:var(--map); --color-road:var(--road); --color-blk:var(--blk);
  --color-strip:var(--strip-bg); --color-strip-fg:var(--strip-fg);
  --shadow-card:var(--shadow); --shadow-float:var(--shadow-lg); --shadow-modal:var(--shadow-modal); --shadow-pri:var(--shadow-pri);
}

@layer base {
  html { -webkit-text-size-adjust:100%; }
  body { background:var(--bg); color:var(--fg); font-family:var(--font-sans); -webkit-font-smoothing:antialiased; transition:background .3s,color .3s; }
  h1, h2, h3 { font-family:var(--font-display); font-weight:800; letter-spacing:-.025em; text-wrap:balance; }
  :focus-visible { outline:2px solid var(--ring); outline-offset:2px; }
  ::selection { background:var(--acc-soft); }
}
@utility page-glow { background:var(--glow); }
@utility page-glow-long { background:var(--glow-long); }
@utility lbl { font:500 11.5px/1 var(--font-mono); text-transform:uppercase; letter-spacing:.08em; color:var(--fg3); }
@utility eyebrow { display:inline-flex; align-items:center; gap:8px; font:800 12.5px/1 var(--font-sans); text-transform:uppercase; letter-spacing:.1em; color:var(--acc-fg); }
@utility skeleton { background:linear-gradient(90deg,var(--muted) 0,var(--bg2) 50%,var(--muted) 100%); background-size:600px 100%; animation:shimmer 1.5s linear infinite; border-radius:8px; }
@utility grid-bg { background-image:linear-gradient(var(--grid) 1px,transparent 1px),linear-gradient(90deg,var(--grid) 1px,transparent 1px); background-size:56px 56px; }
@media (prefers-reduced-motion:reduce){ *,*::before,*::after{animation:none!important;transition:none!important} }
```
Token count: 47 runtime semantic tokens (41 re-declared for dark; `--overlay`, `--strip-*`, `--shadow-pri`, `--ring*` are
theme-invariant), 48 palette steps in `@theme` (§1.2 lists a few extra reference values), 12 radii, 4 containers,
1 easing + 20 animation tokens + 26 keyframes, 4 shadow utilities.

---

## 2. Typography

### 2.1 Families and packages (verified on npm, 2026-10-11)

| Family | Package (version) | Import | `font-family` name | Weights used |
|---|---|---|---|---|
| Bricolage Grotesque (display) | `@fontsource-variable/bricolage-grotesque@5.3.0` | `import '@fontsource-variable/bricolage-grotesque';` (wght axis; other axes at default, matching the Google CSS the export used, `font-stretch:100%`) | `'Bricolage Grotesque Variable'` | 800 (all headings, wordmark, accent words); 600/700 loaded but unused |
| Figtree (body/UI) | `@fontsource-variable/figtree@5.3.0` | `import '@fontsource-variable/figtree';` | `'Figtree Variable'` | 400, 450 (sidebar nav), 500, 600, 700, 800 |
| JetBrains Mono (data) | `@fontsource-variable/jetbrains-mono@5.3.0` | `import '@fontsource-variable/jetbrains-mono';` | `'JetBrains Mono Variable'` | 400, 500, 600 |

Static alternatives exist at the same version (`@fontsource/bricolage-grotesque`, `@fontsource/figtree`,
`@fontsource/jetbrains-mono`, all `5.3.0`; import per weight, e.g. `@fontsource/figtree/600.css`). Prefer the variable
packages (one file per subset; Figtree's 450 nav weight needs the variable font). The export's own woff2 files in
the export (not copied here; the app uses the @fontsource-variable packages) are Google variable subsets (`asset-7571809c…` Bricolage latin, `asset-461a6188…` Bricolage latin-ext,
`asset-c78bfa4b…` Figtree latin, `asset-6d0f0ee0…` Figtree latin-ext, `asset-b5891161…` JetBrains Mono latin); keep
them only as a reference, do not commit them. Install: `npm i -w @thali/web @fontsource-variable/bricolage-grotesque@5.3.0 @fontsource-variable/figtree@5.3.0 @fontsource-variable/jetbrains-mono@5.3.0` (only by the agent whose brief allows installs).

### 2.2 Type roles

Display = Bricolage 800. All h1–h3 are display (global rule). Letter-spacing −.025em unless noted. `text-wrap:balance`
on headings, `pretty` on paragraphs.

| Role | Family / weight | Size / line-height | Tracking | Where |
|---|---|---|---|---|
| Display XL (hero) | Bricolage 800 | `clamp(48px,6.4vw,84px)` / `.95` | −.025em | Public hero h1 |
| Display L | Bricolage 800 | `clamp(34px,4vw,48px)` / `1.02` (CTA `clamp(34px,4vw,50px)`/1; promise `clamp(32px,3.6vw,44px)`/1.04) | −.025em | Public section h2 |
| Foundations h1 | Bricolage 800 | 56px / .98 | −.02em | Board 02 only |
| Display M | Bricolage 800 | 34px / 1.05 | −.025em | Promo block h3; sign-in aside h2 `clamp(32px,3.4vw,44px)/1.05` (−.04em in markup, −.025 by rule) |
| H1 page — consumer hero | Bricolage 800 | 40px / 1 | −.025em | Restaurant name |
| H1 page — marketing-in-app | Bricolage 800 | 34px / 1.05 (checkout) · 32px / 1.1 (sign-in) · 30px / 1.1 (discover) | −.025em | |
| H1 page — role shells | Bricolage 800 | 28px (owner) · 26px (partner, admin) / normal | −.025em | |
| H1 order code | JetBrains Mono 600 | 30px / normal | 0 | Tracking title `TH-DEMOMULTI` |
| H2 section | Bricolage 800 | 32px (public cuisines) · 22px (menu section, modal title lh 1.15) · 20px (discover "What are you craving?") · 17px (checkout steps) · 14.5px (admin card titles) | −.025em | |
| H3 / card display title | Bricolage 800 | 21px (door) · 20px (how-it-works, theme panel) · 18px (hero cart "Your cart", restaurant name in marketing card) | −.025em (`.disp`) | Marketing only |
| Status headline (Figtree) | Figtree 600 | 26px / 1.1, −.03em (tracking live; partner offer "3.2 km · ~18 min") · 22px / 1.15, −.025em (rejected card) · 20px −.02em (partner customer name) | | Not h-tags → stays Figtree |
| Accent word | Bricolage 800 in `var(--acc)` | `font-size:1.1em` of its parent | inherits | "craving?", "Home", "one payment.", "about 9 min", "~18 min", "glance", "with you." |
| Card title | Figtree 600 | 16px (restaurant card name, −.015em; bill header) · 15px (column heads, payment card, checkout review) · 14.5px (cart slot) | | |
| Body lead (marketing) | Figtree 500 | 19px / 1.55 (hero) · 17px / 1.55 (section lead) · 16.5px / 1.6 · 16px / 1.6 (promo) | | color `--fg2` / `--fg3` |
| Body | Figtree 400 | 15px / 1.5 (default text, subtitles) · 14.5px (options, list text) · 14px (meta, table text) | | |
| Small | Figtree 400–500 | 13.5px (cuisines line, td in admin, notes) · 13px (helper, subs) | | |
| Caption | Figtree 400–600 | 12.5px (timeline labels, legends, meta) · 12px (KPI sub, footnotes) | | |
| Button label | Figtree 700, lh 1 | 16px (lg) · 15px (marketing md, block CTAs) · 14px (app) · 13.5px (dense) · 12.5–13px (xs) | | |
| Chip label | Figtree 700, lh 1 | 13px (marketing) · 12px (app) · 11.5px (dense) | | |
| Eyebrow (marketing) | Figtree 800 | 12.5px / 1 | .1em uppercase | `--acc-fg`; on chili `#ffd7c7`; on ink `#ffc145` |
| Label `.lbl` (app) | JetBrains Mono 500 (02: 600) | 11.5px / 1 (admin 11px) | .08em uppercase | `--fg3` |
| Table header | JetBrains Mono 500 | 11px | .06em uppercase | `--fg3` |
| Mono data | JetBrains Mono 500 | 14px (order code in cards) · 13px (admin needs-attention code) · 12–12.5px (UTR, error text, batching checks) · 11px (timeline times, DELIVERY n tags, counts) · 10.5px (EST., role tags, DEFAULT 10px) | | |
| Code digits | JetBrains Mono 500 | 26px (display 44×52, entry 52×60) · 28px (owner pickup 46×56) · 22px (OTP 56px tall) | | |
| KPI value | Figtree 600 | 26px (−.03em) · 24px (partner today) · secondary part 15–16px 400 `--fg3` | | |
| Money total | Figtree 600 | 28px −.03em (checkout "To pay") · 22px −.02em (tracking net) · Bricolage 800 24px (marketing cart) | | |
| Wordmark "thali" | Bricolage 800 | 25px (public header) · 23px (app headers) · 22px (sidebars, footer) | −.03em | Next to the logo mark (34/26/24/28px) |

Numbers: use `font-variant-numeric: tabular-nums` on money columns, KPI values and countdowns (derived; the export
uses proportional Figtree but tables right-align).

---

## 3. Component inventory

### 3.0 Mapping to existing code

| Spec component | Existing file → action |
|---|---|
| Button / ButtonLink / IconButton | `ui/Button.tsx` → restyle; variants `primary · tonal · outline · ghost · dark · on-color · danger-outline · link`; sizes `xs · sm · md · lg · block` |
| StatusPill / Badge | `ui/StatusPill.tsx`, `ui/Badge.tsx` → restyle tones, apply §3.12 mapping changes |
| Input, Field, Textarea | `ui/Input.tsx`, `ui/Field.tsx` |
| PhoneInput (+91) | `components/auth/OtpSignInForm.tsx` → extract `ui/PhoneInput.tsx` (new) |
| SegmentedControl (role tabs, theme seg, tray tabs) | `ui/Tabs.tsx` → add `variant="segmented"` |
| FilterPill / PriceChips | `features/consumer/DiscoveryFilters.tsx` + new `ui/FilterPill.tsx` |
| Select | `ui/Select.tsx` |
| Switch | `ui/Checkbox.tsx` (`Switch`) |
| Checkbox / Radio / OptionCard | `ui/Checkbox.tsx`, `ui/Radio.tsx` → add `OptionCard` |
| VegMark | `ui/Icon.tsx` `FoodMarker` → change to export geometry (§3.13) |
| EstBadge, RoleTag, Avatar, CodeBoxes, CodeEntry, CountdownRing, Stepper, ProgressBar, KpiTile, StackedBar, CuisineCircle, CartDock, BillAccordion, AddressCard, KanbanColumn, LiveIndicator, ThemeToggle | **new** in `ui/` (LiveIndicator replaces `ui/RealtimeStatus.tsx`; CountdownRing wraps `ui/Countdown.tsx` `useCountdown`) |
| DemoBanner | `layout/ModeBanner.tsx` → restyle |
| Restaurant card | `features/consumer/RestaurantCard.tsx` |
| Customizer modal | `features/consumer/ItemCustomizer.tsx` + `ui/Dialog.tsx` |
| Cart dock/tray | `features/consumer/CartDrawer.tsx` (+ new `CartDock`) |
| Order card (owner) | `features/restaurant/OrderCard.tsx`, `OrdersBoard.tsx`, `RejectDialog.tsx` |
| Offer card / active delivery | `features/partner/OfferCard.tsx`, `ActiveDelivery.tsx`, `OnlineToggle.tsx`, `CodeEntryDialog.tsx`, `TrackingLimitations.tsx` |
| Shells / navs | `layout/AppShell.tsx`, `RoleNav.tsx`, `RoleArea.tsx`, `Logo.tsx`, `features/*/…Layout.tsx`, `features/consumer/HeaderActions.tsx` |
| Map | `ui/Map.tsx` (Leaflet) + `features/consumer/TrackingMap.tsx` |
| DataTable, Skeleton, EmptyState, ErrorState, Toast, Dialog/Sheet, Price, RelativeTime, PageHeader, Pagination | same files → restyle |

**Density tiers** (one component, three sizes; pick by shell): `marketing` (board 00/02), `app` (01, 10–30),
`dense` (40 admin and other admin pages).

### 3.1 Buttons

Anatomy: `[icon?] label [icon?]`, `display:inline-flex;align-items:center;justify-content:center;gap:8px;
border-radius:999px;font-family:Figtree;font-weight:700;line-height:1;white-space:nowrap;border:1px solid transparent`
(marketing border `1.5px`); `transition:transform .15s,background .15s,border-color .15s,box-shadow .15s`.

| Size | Height | Padding | Font | Notes |
|---|---|---|---|---|
| `lg` | 54px | 0 26px | 16px | Marketing CTA ("Find food near me →") |
| `md` marketing | 44px | 0 20px | 15px | Public page; hero form buttons 48px (`Find food` padding 0 24px) |
| `md` app | 40px | 0 16px | 14px | Default app size |
| `sm` dense | 36px | 0 14px | 13.5px | Admin; also icon-buttons and cart "Checkout only…" (36px, 13px) |
| `xs` | 30px | 0 12px | 12.5px | Table filter buttons ("Status: All", "Today", "View all →") |
| `block` | 44–50px, `border-radius:12px` | full width or grid cell | 14–15px | Card actions: Accept 48 · Reject 48 · Mark ready 44 · Accept offer/Decline 50 · Mark delivered 48 · sign-in submit 46 (pill) · Pay 50 (pill) · customizer CTA 46 (pill) |
| `icon` | 40×40 app · 44×44 marketing · 36×36 dense · 32×32 tray close | 0 | — | `aria-label` required |

Touch: on `pointer:coarse`, every button min-height 44px (keep `--spacing-touch`).

| Variant | Light | Dark | Hover / active |
|---|---|---|---|
| `primary` (`.btn-pri`, also `.btn-acc`) | bg `#d23f11`, text `#fff`, `box-shadow:var(--shadow-pri)` | bg `#ff7445`, text `#121212` | hover bg `--pri-h`; marketing also `transform:translateY(-1px)`; active: no lift **(derived)** |
| `tonal` (`.btn-soft`) | bg `--acc-soft` `#ffede5`, text `--acc-fg` `#a8320b` | bg `rgba(255,116,69,.15)`, text `#ff9a73` | hover bg `color-mix(in srgb,var(--acc-soft),var(--acc) 8%)` **(derived)** |
| `outline` (`.btn-out`) | bg `--card`, text `--fg`, border `1px --line` (marketing `1.5px --line2`) | same tokens | hover border `--line2` (marketing `--fg3`) |
| `ghost` | transparent, text `--fg2` | same | hover bg `--muted`, text `--fg`; `aria-current="page"` → bg `--muted`, text `--fg` (consumer top nav) |
| `dark` | bg `#141414`, text `#fff` (on turmeric CTA block) | unchanged | lift −1px |
| `on-chili` | white: bg `#fff`, text `#a8320b`; outline: border `rgba(255,255,255,.5)`, text `#fff` | unchanged (block colour is fixed) | |
| `on-ink` | turmeric: bg `#ffc145`, text `#141414`; outline: border `rgba(255,255,255,.35)`, text `#fff` | unchanged | |
| `danger-outline` | outline + text `--bad` ("Reject") | | |
| `link` | text `--fg` 500 underline (sign-in foot), or `--acc-fg` 700–800 no underline + `→` (public "See all restaurants →", door CTAs, `.arr` moves `translateX(5px)` on card hover) | | |

States: **disabled** `opacity:.45;cursor:not-allowed` (customizer CTA `.4`), keeps label; **loading** = 16px spinner
(`<svg viewBox="0 0 24 24" stroke-width="3"><path d="M21 12a9 9 0 0 0-9-9" stroke-linecap="round"/></svg>`,
`spin .8s linear infinite`) before the label, label may change ("Opening secure payment…"), `disabled` +
`aria-busy="true"`; **focus** §1.7; **pressed toggles** (`aria-pressed`, e.g. Chime) change icon+label, not colour.

### 3.2 Text input

| Density | Spec |
|---|---|
| marketing (`.input`, board 02) | `height:48px;border:1.5px solid var(--line2);border-radius:14px;background:var(--card);color:var(--fg);padding:0 16px;font:500 15px Figtree` |
| app (`.input`, board 01) | `height:46px;border:1px solid var(--line);border-radius:12px;background:var(--bg);padding:0 14px;font:400 15px Figtree;outline:none` — focus `border-color:var(--fg3);box-shadow:0 0 0 4px var(--muted)`; placeholder `--fg3` |
| app compact (board 12) | same, `height:44px` |
| Header search (marketing `.hsearch`) | label wrapper `height:48px;padding:0 10px 0 14px;border:1.5px solid var(--line2);border-radius:14px;background:var(--card)`, 18px search icon `--fg3`, input `font:500 15px`, kbd `/` (mono 11px, `border:1px solid var(--line2);border-bottom-width:2px;border-radius:6px;padding:2px 7px`); focus-within `border-color:var(--pri);box-shadow:0 0 0 4px var(--pri-soft)` |
| Header search (app) | `height:40px;padding:0 14px;border:1px solid var(--line);border-radius:999px;background:var(--bg2)`, 16px icon, input `400 14px`, kbd mono 11px `border:1px solid var(--line);border-radius:5px;padding:2px 6px` |
| Hero address pill | form `padding:8px;border:1.5px solid var(--line2);border-radius:999px;background:var(--card);box-shadow:var(--shadow);max-width:580px`; 20px pin icon stroke `--pri`; input `500 16px`, height 48 |

Label: `font:500 14px Figtree`, 8px above. Helper: 13px `--fg3`. **Error (extrapolated):** border `--bad`,
focus ring `0 0 0 4px var(--bad-bg)`, message 13px `--bad` with `aria-describedby`. Disabled: `opacity:.45`.

### 3.3 +91 phone input

Row `display:flex;gap:8px`: prefix box = `.input` + mono, `width:auto;display:flex;align-items:center;color:var(--fg2);
background:var(--bg2)` text `+91` (not focusable); field = `.input` `inputmode="tel" autocomplete="tel"
placeholder="98765 43210"`. Helper "We'll text a 6-digit code. Standard SMS rates may apply." 13px `--fg3`. Accepts
`98765 43210`, `+91…`, `0…`; formats as `5 5` digits on blur **(derived)**. Error: "Enter a 10-digit mobile number".

### 3.4 Segmented control (role tabs and kin)

- **Role tabs (board 01):** `role="group"`, grid `repeat(4,minmax(0,1fr))`, `gap:2px;padding:3px;border-radius:999px;
  background:var(--muted)`. Segment `.seg`: `height:36px;border-radius:999px;border:0;background:transparent;
  color:var(--fg3);font:500 13.5px Figtree;transition:background .2s,color .2s`; selected (`aria-pressed="true"`)
  `background:var(--card);color:var(--fg);box-shadow:0 1px 2px rgba(0,0,0,.08),0 0 0 1px var(--line)`. Labels:
  Customer · Restaurant · Partner · Admin. Content below swaps with `swap .35s`.
- **Theme segmented (public `.tseg`):** track `display:flex;gap:2px;padding:2px;border-radius:8px;background:var(--muted)`;
  button `height:26px;padding:0 9px;border-radius:6px;font:700 12px Figtree;color:var(--fg3)` with 13px sun/moon icon;
  checked `background:var(--card);color:var(--fg);box-shadow:0 1px 2px rgba(0,0,0,.12)`; `role="radiogroup"` / `role="radio"`.
- **Cart tray tabs (`.tab`):** track `gap:4px;padding:3px;border-radius:999px;background:var(--muted)`; tab `height:30px;
  padding:0 12px;border-radius:999px;color:var(--fg3);font:500 13px`; 8px square swatch `border-radius:2px` in cart hue;
  count mono 11px `opacity:.7`; selected `background:var(--card);color:var(--fg);box-shadow:0 0 0 1px var(--line)`;
  `role="tablist"/"tab"`, `aria-selected`.

### 3.5 Filter pills & price chips

`.pill` (board 10): `height:36px;padding:0 14px;border-radius:999px;border:1px solid var(--line);background:var(--card);
color:var(--fg2);font:500 13.5px Figtree;gap:6px;transition:all .15s`; pressed (`aria-pressed="true"`)
`background:var(--pri);color:var(--pri-fg);border-color:var(--pri)`. Veg-only pill carries a 13px veg mark (stays
`--veg`; when pressed the export uses `#22c55e` for contrast on chili — **use `#ffffff` mark on pressed** (derived,
legible in both themes)). Price chips: three pills `₹ · ₹₹ · ₹₹₹` in a `gap:6px` row, multi-select.
**Prep-time pills (board 20):** `height:44px;border-radius:12px;border:1px solid var(--line);background:var(--card);
color:var(--fg);font:500 14px`, pressed = primary fill; 4-column grid `gap:6px`. Reject-reason pills reuse them
in a 2-column grid. Focus ring §1.7.

### 3.6 Select

Native `<select>`: `height:40px;border:1px solid var(--line);border-radius:12px;background:var(--card);color:var(--fg);
padding:0 12px;font:400 14px Figtree`, label `.lbl` above (8px). Options for discovery sort: Distance · Delivery fee ·
Delivery time · Rating. Focus: app input focus style.

### 3.7 Toggle switch

`role="switch" aria-checked`. Two sizes:
- **md (checkout Thali Plus):** track `44×26`, `padding:3px;border-radius:999px;border:0`; knob `20×20` `#fff`,
  `box-shadow:0 1px 2px rgba(0,0,0,.3)`; on: track `var(--ok)`, knob `translateX(18px)`; off: track `var(--line2)`.
  `transition:background .2s` / knob `transform .25s var(--ease-out)`.
- **lg (partner online):** track `64×36`, `padding:4px`; knob `28×28`, `box-shadow:0 1px 3px rgba(0,0,0,.3)`, on
  `translateX(28px)`; knob transition `.28s`.
Disabled `opacity:.45`; pending (server call) keeps position, shows 14px spinner left of the switch **(extrapolated)**.

### 3.8 Checkbox & radio cards (`OptionCard`)

`.opt`: `display:flex;align-items:center;gap:12px;min-height:52px;padding:0 14px;border-radius:12px;border:1px solid var(--line);
background:var(--card);font:400 14.5px Figtree;width:100%;text-align:left;transition:border-color .15s,background .15s`.
Selected (`aria-pressed="true"`, implement as real `input` inside a `label`): `border-color:var(--pri);background:var(--acc-soft)`.
Disabled: `opacity:.45;cursor:not-allowed`, label suffix " · Unavailable". Trailing price `--fg3` (`₹249`, `+₹30`).
- Radio glyph: `18×18` circle `border:1.5px solid var(--line2)`; selected ring `var(--fg)` + inner dot `8×8 var(--fg)`.
- Checkbox glyph: `18×18`, `border-radius:5px`, `border:1.5px solid var(--line2)`; checked `background:var(--fg);border-color:var(--fg)`
  with 11px check (`<path d="m5 12 5 5 9-10"/>`, stroke-width 3.5) in `var(--pri-fg)`.
- Plain checkbox (filters `.check`, unused in markup): `min-height:36px;gap:10px;font-size:14px;color:var(--fg2)`,
  input `16×16;accent-color:var(--fg)`.
Address card variant: §3.24.

### 3.9 Status pill (chip)

`.chip`: `display:inline-flex;align-items:center;gap:6px;border-radius:999px;font-weight:700;line-height:1;white-space:nowrap`
+ leading dot `::before{content:"";border-radius:50%;background:currentColor}`.

| Density | Height | Padding | Font | Dot |
|---|---|---|---|---|
| marketing | 28px | 0 11px | 13px | 7px |
| app | 24px | 0 9px | 12px | 6px |
| dense | 22px | 0 8px | 11.5px | 6px |

Tones: `ok` (`color:var(--ok);background:var(--ok-bg)`) · `warn` (`--warn`/`--warn-bg`) · `bad` (`--bad`/`--bad-bg`)
· `info` (`--info`/`--info-bg`) · `acc` (`--acc-fg`/`--acc-soft`) · `neu` (`--fg3`/`--muted`).
`Badge` `Tone` mapping: `success→ok · warn→warn · danger→bad · info→info · brand→acc · neutral→neu`. Remove the current
ring-inset border (export has none).

**Status → tone (binding).** ⇄ marks a change from today's `StatusPill.tsx`; everything else is unchanged.

| Kind | Status → label · tone |
|---|---|
| childOrder | AWAITING_PAYMENT Awaiting payment · warn — PLACED Placed · info — ACCEPTED Accepted · acc — PREPARING Preparing · acc — READY_FOR_PICKUP Ready for pickup · acc — PICKED_UP Picked up · info — OUT_FOR_DELIVERY Out for delivery · info — DELIVERED Delivered · ok — DELIVERY_FAILED Delivery failed · bad — PAYMENT_FAILED Payment failed · bad — EXPIRED Expired · neu — REJECTED Rejected by restaurant · bad — CANCELLED Cancelled · neu |
| checkout | AWAITING_PAYMENT Awaiting payment · warn — PAID_PLACED Order placed · info — IN_PROGRESS In progress · acc — COMPLETED Completed · ok — PARTIALLY_COMPLETED Partially completed · warn — CANCELLED Cancelled · neu — PAYMENT_FAILED Payment failed · bad — EXPIRED Expired · neu |
| payment | CREATED Pending · warn — AUTHORIZED Authorized · info — CAPTURED Paid · ok — FAILED Failed · bad — PARTIALLY_REFUNDED Partially refunded · info — REFUNDED Refunded · neu |
| refund | REQUESTED Refund initiated · info — PROCESSING Refund processing · info — SUCCEEDED Refunded · ok — FAILED Refund failed · bad |
| childRefund | NONE No refund · neu + refund map |
| delivery | PENDING_ASSIGNMENT Finding a partner · warn — OFFERED Offered to partner · warn — ASSIGNED Partner assigned · info — AT_PICKUP At restaurant · info — PICKED_UP Picked up · **info ⇄ (was brand)** — OUT_FOR_DELIVERY On the way · **info ⇄ (was brand)** — DELIVERED Delivered · ok — FAILED Delivery failed · bad — CANCELLED Cancelled · neu |
| restaurant | DRAFT Draft · neu — VERIFICATION_PENDING Email verification pending · warn — APPROVAL_PENDING Awaiting approval · **info ⇄ (was warn)** — APPROVED Approved · ok — REJECTED Rejected · bad — SUSPENDED Suspended · bad |
| partner | DRAFT Draft · neu — APPROVAL_PENDING Awaiting approval · **info ⇄ (was warn)** — APPROVED Approved · ok — REJECTED Rejected · bad — SUSPENDED Suspended · bad |
| ticket | OPEN Open · warn — IN_PROGRESS In progress · info — RESOLVED Resolved · ok — CLOSED Closed · neu |
| payout | REQUESTED Requested · warn — PROCESSING Processing · info — PAID Paid · ok (render only with UTR; without UTR show Processing) — FAILED Failed · bad — CANCELLED Cancelled · neu |
| offer | OFFERED New offer · acc — ACCEPTED Accepted · ok — REJECTED Declined · neu — EXPIRED Expired · neu — CANCELLED Withdrawn · neu |
| notification | QUEUED Queued · neu — SENDING Sending · info — SENT Sent · ok — DELIVERED Delivered · ok — FAILED Failed, retrying · warn — DEAD Gave up · bad — SKIPPED Skipped · neu |
| membership | PENDING_PAYMENT Awaiting payment · warn — ACTIVE Active · ok — EXPIRED Expired · neu — CANCELLED Cancelled · neu |
| user | ACTIVE Active · ok — BLOCKED Blocked · bad |
| health | up / ok **Up ⇄ (label was "Healthy")** · ok — degraded Degraded · warn — down Down · bad |

Rationale: one colour = one meaning. Chili = in the kitchen / needs your action; Sky = moving, live, or waiting on
someone else (board 02 shows "On the way" as info; board 40 shows "Awaiting approval" as info; board 20's
awaiting-approval banner uses `--info-bg`); Turmeric = needs attention / money pending; Leaf = done; Red = failed; grey = ended.
Unknown values: humanized label, `neu`.

### 3.10 Veg / non-veg mark

SVG `viewBox="0 0 14 14"`, sizes 12 (card badge), 13 (lists), 14 (dish rows, modal), 16 (foundations).
Veg: `<rect x=".75" y=".75" width="12.5" height="12.5" rx="2" fill="none" stroke="var(--veg)" stroke-width="1.5"/>
<circle cx="7" cy="7" r="3.3" fill="var(--veg)"/>`. Non-veg: same rect in `var(--nveg)` +
`<path d="M7 3.4 10.4 10H3.6Z" fill="var(--nveg)"/>`. `role="img" aria-label="Veg" | "Non-veg"`. Fill **none** (not
white) so it works on dark. With label: `gap:6px;font:600 14px`. "Pure veg" badge: §3.20.

### 3.11 `EST.` badge

`<span class="mono">EST.</span>`: `font-size:10.5px;padding:2px 6px;border-radius:5px;background:var(--warn-bg);color:var(--warn)`
(legend variant `padding:3px 6px`; restaurant stat `10px / 2px 5px / 4px`; marketing "ESTIMATE" `11px / 4px 7px / 6px`).
Placed right after the time ("32 min EST."); lists may write "32 min est." in plain text with one legend
"EST. times are demo estimates" per page. Copy rule: "demo estimates" when the API says the estimate is a demo
(`isDemoEstimate`), otherwise "estimates".

### 3.12 Demo / environment banner

- **App strip (boards 01, 10–40):** full-width, `height:32px;display:flex;align-items:center;justify-content:center;
  padding:0 16px;background:#141414;color:#ffc145;font:500 12px/1 'JetBrains Mono';letter-spacing:.04em`,
  text `DEMO MODE — no real money, SMS or deliveries`, `role="status"`. Not dismissible. Same in dark.
- **Public pill (board 00 utility bar):** inline `height:24px;padding:0 9px;border-radius:6px;background:var(--sun-soft);
  color:var(--sun-ink);font:600 11px 'JetBrains Mono';letter-spacing:.03em;gap:7px` + 6px dot `currentColor`, text
  `DEMO MODE · no real money, SMS or deliveries`.
- **Sandbox (extrapolated):** same shapes; strip `background:#141414;color:#7aa7ff`, text
  `SANDBOX — real providers in test mode, no real charges`; pill `background:var(--info-bg);color:var(--info)`.
- Shown only when `GET /meta` returns `mode` `demo` / `sandbox`; hidden while loading, on error and in production
  (keep `ModeBanner` logic; the provider list moves to a `title`/tooltip).

### 3.13 Live indicator

| Variant | Spec |
|---|---|
| Live pill (consumer, board 13) | `display:flex;gap:8px;font-size:13px;padding:8px 12px;border:1px solid var(--line);border-radius:999px`; 7px dot `var(--acc)` with `pulse`; text `Live · updated 3s ago` (relative time from last event); `aria-live="polite"` |
| Live inline (owner, board 20) | `--fg3` 13px, `gap:7px`, 7px dot `var(--ok)` pulsing (ok-variant keyframe), text `Live` |
| Partner location (board 30) | 7px `--ok` pulse + `Location sharing active · last sent 3s ago` 13.5px `--fg3` |
| Paused / polling (all) | Same pill/inline shape, dot static `var(--warn)` (no pulse), bg `var(--warn-bg)`, text `var(--warn)`, copy `Live updates paused — refreshing every 10 s` (exact, from `REALTIME_PAUSED_MESSAGE`) |
| Connecting | render nothing (avoid flash) |
| Stale tracking (>60 s since rider update) | Rider line text becomes `Location last updated 2 min ago` in `--warn` + 14px alert icon **(extrapolated)** |

### 3.14 Countdown ring

SVG ring + centred mono number. Track `stroke:var(--muted)`, progress `stroke:var(--acc)` →
`var(--bad)` under threshold, `stroke-linecap:round`, `transform:rotate(-90 c c)`, `stroke-dasharray=C`,
`stroke-dashoffset=C*(1-remaining/total)`, `transition:stroke-dashoffset 1s linear` (`.cd`).

| Use | Box | r / stroke | C | Text | Threshold |
|---|---|---|---|---|---|
| Restaurant accept window (5 min) | 56×56 | 24 / 5 | 150.8 | mono 500 13px `m:ss` | red at ≤ 60 s |
| Partner offer (45 s) | 64×64 | 28 / 5 | 175.9 | mono 500 17px seconds | red at ≤ 10 s + `urgent` pulse on the wrapper (`border-radius:50%`) |
| Foundations sample | 40×40 | 18 / 4 | 113 | mono 600 19px next to ring | red < 60 s |

`aria-label="4 minutes 1 seconds left to accept"` on the number; drains to the server's `acceptBy` / `expiresAt`
(`useCountdown`). At 0 → card switches to its expired state (§5.20, §5.30).

### 3.15 Code digit boxes

- **Display** (`.code`): `width:44px;height:52px;border-radius:12px;border:1px solid var(--line);background:var(--bg2);
  display:flex;align-items:center;justify-content:center;font:500 26px 'JetBrains Mono'`; owner pickup variant
  `46×56`, `28px`. Group `display:flex;gap:6px` with `aria-label="Delivery code 4 7 1 9"`.
- **Entry** (`.codein`, partner): `width:52px;height:60px;border-radius:12px;border:1px solid var(--line);background:var(--bg);
  text-align:center;font:500 26px 'JetBrains Mono';outline:none`; focus `border-color:var(--fg3);box-shadow:0 0 0 4px var(--muted)`;
  `gap:8px`; `maxlength=1 inputmode=numeric aria-label="Digit n"`; auto-advance, paste-to-fill, backspace-to-previous.
  Error (extrapolated): borders `--bad`, helper "Wrong code · 4 attempts left" `--bad`; locked: inputs disabled +
  "Locked after 5 wrong tries — contact Thali ops".
- **OTP** (6 boxes, sign-in): app `.input` + `height:56px;text-align:center;font:500 22px 'JetBrains Mono';padding:0`,
  grid `repeat(6,minmax(0,1fr));gap:8px`, legend `500 14px` "Enter the 6-digit code" / "Code from your authenticator app".

### 3.16 Stepper / timeline

Segmented bar list (`<ol>`), `display:grid;grid-template-columns:repeat(N,minmax(0,1fr));gap:6px`. Each `li`:
`flex-direction:column;gap:8px` (partner/refund `6px`): bar `height:4px;border-radius:2px` + label 12.5px + optional
time mono 11px `--fg3`.
- done: bar `var(--fg)`, label 500 `--fg`.
- current: bar `var(--acc)` + `pulse`, label 600 `var(--acc-fg)`, time "now".
- future: bar `var(--line)`, label `--fg3`, time "—".
Order timeline (7): Placed · Accepted · Preparing · Ready · Picked up · On the way · Delivered. Partner (4): At restaurant ·
Picked up · On the way · Deliver. Refund (3): Initiated (done bar `var(--ok)`) · Processing (current bar `var(--info)`,
label 600 `--info`) · Refunded; failed (extrapolated) = current bar `--bad`, label "Refund failed".
Terminal error on order timeline (rejected/cancelled/failed): stop at the last reached step and replace remaining
steps with one `--bad` (rejected/failed) or `--neu` (cancelled) bar labelled with the status **(extrapolated)**.
**Checkout step number** (`.step`): `26×26` circle `border:1px solid var(--line)`, mono 500 12px `--fg2`, before the h2.

### 3.17 Progress bar

Track `height:6px;border-radius:3px;background:var(--muted);overflow:hidden`; fill `height:6px;border-radius:3px;background:var(--acc);width:%`.
Meta row below `display:flex;justify-content:space-between;font-size:12px;color:var(--fg3)` ("13 of 20 min" · "Finding partner").
Overdue (elapsed > prep, extrapolated): fill `--bad`, left text "4 min over".

### 3.18 KPI tile

- **Standalone (owner):** `.card` `padding:14px 16px;gap:8px`: `.lbl` + value `600 26px Figtree;letter-spacing:-.03em`
  (+ secondary ` / ₹8,151` `16px 400 --fg3`).
- **Strip (admin):** one `.card` (`radius 14px`, overflow hidden) with grid `repeat(auto-fit,minmax(min(150px,100%),1fr))`;
  each cell `padding:16px 18px;gap:8px;border-right:1px solid var(--line)` (last none): `.lbl` (11px) + value 26px +
  sub `12px --fg3` (or link 12px). Highlight cell: `background:var(--acc-soft)`, label + value `color:var(--acc-fg)`,
  sub link `color:var(--acc-fg)` ("Open deliveries →"). Positive sub: `color:var(--ok)` ("Nothing to retry").
- Unavailable: value `—` `--fg3` + sub "Stats unavailable · Retry" (button-link) — never zeros.
- Loading: `.lbl` + 26px skeleton bar (60% width).

### 3.19 Stacked status bar

Card `padding:16px 18px;gap:12px`: header row (500 14px title + mono 12px total `--fg3`); bar `display:flex;height:10px;gap:3px`
with segments `flex:<count>;border-radius:3px` in `--ok` (Delivered) · `--acc` (In progress) · `--info` (Placed) ·
`--bad` (Rejected) · `--neu` (Cancelled); `role="img"` with full `aria-label`; `grow` animation. Legend
`flex-wrap;gap:16px;font-size:12.5px;--fg3`, 8px squares `border-radius:2px`. Zero-count segments omitted; legend keeps
them with 0 **(derived)**.

### 3.20 Restaurant card

- **App (board 10)** `.card.rcard` (radius 16, `overflow:hidden`, `text-decoration:none`; hover `translateY(-3px)`,
  `box-shadow:var(--shadow)`, `border-color:var(--line2)`, transition `.2s`):
  1. Cover `height:150px;position:relative;background:color-mix(in srgb,<hue> 16%,var(--card));border-bottom:1px solid var(--line)`.
     Real image if the API has one (`object-fit:cover`); else `illustrations/restaurant-cover-placeholder.svg` in `color:<hue>`.
  2. Badge row `position:absolute;left:12px;top:12px;gap:6px`:
     - **Pure veg**: `height:24px;padding:0 9px;border-radius:999px;background:var(--card);border:1px solid var(--line);
       font:500 12px;color:var(--veg);gap:6px` + 12px veg mark.
     - **State badge** (Opens at 6:00 PM / Not accepting orders / Temporarily not accepting orders): `height:24px;padding:0 9px;
       border-radius:999px;background:var(--pri);color:var(--pri-fg);font:500 12px` (keep 500; the `.chip` 700 rule does not apply).
     - **% OFF** (only if the API returns a restaurant offer; no dead UI): bottom-left of cover `left:10px;bottom:10px`,
       `background:#fff;color:#141414;border-radius:8px;padding:5px 8px;font:800 11px` (dark: `#121212`/`#f5f5f5`), e.g. "20% OFF".
  3. Body `padding:14px 16px 16px;gap:8px`: row name (`600 16px`, −.015em) + rating badge
     (`height:24px;padding:0 8px;border-radius:6px;font:600 12px;gap:4px`): rated (count ≥ 5) `★ 4.3 (126)` on
     `--ok-bg`/`--ok`; **New** (count < 5 or none) on `--muted`/`--fg3`. Cuisines `13.5px --fg3` ("Biryani · Mughlai · ₹₹").
     Meta `13px --fg2`, items separated by `·` in `--fg3`, `gap:6px 10px`: `32 min est.` | `Closed now` · `2.1 km` · `₹29 delivery`.
  4. Closed/paused card: `opacity:.62` (still a link; browsing allowed).
- **Marketing horizontal (board 02):** `.card` (radius 20) `display:flex;overflow:hidden`: left 150px gradient cover with
  % OFF badge; body `padding:14px 16px;gap:7px`: name `Bricolage 800 18px` + solid rating `background:var(--leaf)`
  (dark `#12813f`) `color:#fff;border-radius:8px;padding:5px 8px;font:800 12.5px`; cuisines 14px `--fg3`; meta
  `600 13.5px --fg2` with EST. badge. Use for promos/banners only.

### 3.21 Cuisine circle

- **App (board 10)** `.cz` button `width:96px;gap:8px;color:var(--fg2)`; `.ring` `88×88` circle
  `border:1px solid var(--line);background:color-mix(in srgb,<hue> <pct>%,var(--card))` holding a 72px illustration;
  label `.czl` 13px. Hover ring `translateY(-3px)` + `--shadow`, svg `rotate(-8deg) scale(1.06)`. Selected
  (`aria-pressed="true"`): ring `border-color:var(--pri);box-shadow:0 0 0 2px var(--pri)`, label `--fg` 600.
- **Marketing (board 00)** `<a class="cz">` `width:110px;gap:10px;font:700 14px;color:var(--fg)`; disc `100×100`,
  `border:3px solid var(--card);box-shadow:0 0 0 1.5px var(--line)`, 78px svg; hover disc `translateY(-4px)` +
  `box-shadow:0 0 0 2px var(--pri),var(--shadow)`, svg `rotate(-8deg) scale(1.08)`. Board 02 small: 64px disc, 40px svg,
  `2px` border, 12.5px 600 `--fg2`.
- Backgrounds: use the app formula `color-mix(in srgb,<hue> <pct>%,var(--card))` everywhere (works in both themes).
  Marketing light literals for reference: biryani `#fde6d6`, south indian `#fff1d6`, north indian `#fbe3cf`, chinese
  `#fde2e2`, coastal `#dff1f4`, pizza `#fff3cc`, healthy `#e3f4e6`, desserts `#f9dfe8`, chai `#f3e6dc`; dark (02):
  biryani `#3a2418`, dosa `#3a2e14`, healthy `#1d3324`.
- Train (`.train`): `display:flex;gap:18px;overflow-x:auto;scroll-snap-type:x mandatory;padding:4px 2px 6px;scrollbar-width:none;
  mask-image:linear-gradient(90deg,#000 92%,transparent)`; items `scroll-snap-align:start`. Scroll buttons: outline icon
  buttons 36×36.

### 3.22 Floating multi-cart bar (dock + tray)

Wrapper `position:sticky;bottom:20px;z-index:20;display:flex;justify-content:center;padding:0 16px 20px;pointer-events:none`;
inner `max-width:760px;width:100%;flex-direction:column;gap:10px;pointer-events:auto`.
- **Dock:** `display:flex;align-items:center;gap:10px;padding:8px 8px 8px 10px;border-radius:999px;box-shadow:var(--shadow-lg)`;
  light `background:var(--fg);color:var(--bg)`; **dark `background:var(--card);border:1px solid var(--line2);color:var(--fg)`**
  (board 02 dark sample). Entrance `dockin`.
  - Summary button (`aria-expanded`, `aria-controls="cart-tray"`, `height:44px;padding:0 6px;gap:12px`): stacked avatars
    (`32×32` circles, `margin-left:-8px`, `border:2px solid var(--fg)` (dark: `var(--card)`), `background:<hue>`, `#fff`
    initials `600 11px`); title `600 14.5px` "2 carts · 3 items" (`bump` on change); sub `12px;opacity:.65` "2 deliveries,
    one payment" / "Delivered by Spice Route"; 16px chevron `opacity:.7`, rotates 180° when open.
  - Per-cart chips (hidden ≤720px): `height:34px;padding:0 12px;border-radius:999px;border:1px solid color-mix(in srgb,var(--bg) 28%,transparent);
    background:transparent;font:500 12.5px;gap:6px`, 7px hue square, "Spice Route · ₹378".
  - Checkout link: `height:44px;padding:0 18px;border-radius:999px;background:var(--pri);color:var(--pri-fg);font:600 14px;gap:8px`
    "Checkout · ₹558" + 15px arrow.
- **Tray** (`.card.tray`, `box-shadow:var(--shadow-lg)`, `trayin`): header `padding:12px 14px;border-bottom` = tray tabs
  (§3.4) + "Each cart is delivered separately" `12.5px --fg3` + close icon (32×32). Body `max-height:340px;overflow:auto;
  grid repeat(auto-fit,minmax(min(300px,100%),1fr))`; slot `padding:14px 16px;gap:12px;border-right/bottom:1px solid var(--line)`:
  head (28×28 `radius 8` initials tile `color-mix(<hue> 18%,card)`/`<hue>` `600 11px`; name `600 14.5px`; mono 11px
  `DELIVERY 1 · ~32 MIN EST.`; subtotal `600 14.5px`); lines (veg mark 13, name 13.5px, options 12px `--fg3`, qty stepper);
  "Checkout only Spice Route →" outline 36px 13px. Footer `padding:10px 16px;background:var(--bg2);12.5px --fg3` with
  14px info icon: "Fees and taxes are shown per restaurant at checkout. One payment covers every cart."
- **Qty stepper (`.qty`):** `height:32px;border:1px solid var(--line);border-radius:999px`; buttons `30×30;font:500 16px;border-radius:999px`
  (− / +); count 13px `min-width:14px`, `aria-live="polite"`. Large variant (customizer) `height:46px;background:var(--card)`,
  buttons `42×44;font:500 18px`, count `600 15px`.
- Behaviour: hover opens tray on fine pointers (not pinned); click pins/unpins; Esc/close unpins. Hidden when the cart is empty.
- Toast under dock: §3.33.

### 3.23 Item row (menu dish)

`.dish` `display:flex;gap:16px;padding:18px 0;border-bottom:1px solid var(--line)`.
Left column `flex:1;gap:6px`: veg mark 14 · name `600 16px` · price `14px` ("from ₹249" when a required size group sets the
price) · description `13.5px/1.5 --fg3;max-width:520px`.
Right column (`flex:none;align-items:center`): image `128×104;border-radius:14px;border:1px solid var(--line);
background:color-mix(in srgb,<hue> 14%,var(--card))` (real image `object-fit:cover`), button overlapping
`margin-top:-18px;height:36px`:
- **Add +**: outline + `box-shadow:0 2px 6px rgba(0,0,0,.08)`.
- **In cart · N**: primary. Behaviour (extrapolated): non-customizable item → becomes the `.qty` stepper styled primary
  (`background:var(--pri);color:var(--pri-fg)`, 36px); customizable item → "In cart · N" opens the customizer to add
  another configuration.
- **Unavailable**: outline `disabled`; whole row `opacity:.55`; sub-text `500 13px` "Sold out today" (stock 0) or
  "Unavailable" (toggled off); image bg `var(--muted)`.
- Restaurant not deliverable / closed: buttons disabled with the reason in a page notice (§5.11).

### 3.24 Address card

`.addr` button: `display:flex;gap:12px;align-items:flex-start;padding:14px 16px;border:1px solid var(--line);border-radius:14px;
background:var(--card);text-align:left;transition:border-color .15s,background .15s`. Radio glyph 18px (`margin-top:2px`).
Content: label `600 14.5px` + `DEFAULT` tag (mono 10px, `padding:2px 6px;border-radius:5px;background:var(--muted);color:var(--fg3)`);
address `13px/1.45 --fg3`. Selected (`aria-pressed`/radio checked): `border-color:var(--pri);background:var(--acc-soft)`.
**Add new** variant: same box, `border-style:dashed;align-items:center;justify-content:center;color:var(--fg2)` + 16px plus.
Grid `repeat(auto-fit,minmax(min(220px,100%),1fr));gap:10px`. Not serviceable address (extrapolated): disabled,
sub-line `--bad` "Outside delivery area".

### 3.25 Bill breakdown accordion

Aside `.card` (`max-width:400px;position:sticky;top:24px;overflow:hidden;box-shadow:var(--shadow)`).
Header `padding:18px 20px;border-bottom` "Bill, per restaurant" `600 16px` + tag mono 11px `padding:4px 8px;border-radius:999px;
background:var(--acc-soft);color:var(--acc-fg)` "2 DELIVERIES". Per restaurant: button `aria-expanded`
`min-height:54px;padding:0 20px;gap:10px` (name `500 14.5px`, total `600 14.5px`, 14px chevron `--fg3` rotating 180°,
`.2s`); panel (`open` anim) `padding:0 20px 14px;gap:8px`, rows `13px` key `--fg3` / value `--fg` (discounts
`--ok` with `−₹`). Row order: Items · Coupon share · Membership discount share (if any) · Packaging · Delivery fee ·
Free delivery (−, if any) · Platform fee · GST on food · GST on fees. Footer `padding:18px 20px;gap:14px;background:var(--bg2)`:
"To pay" `500 15px` + amount `600 28px −.03em`; Pay button (pill primary `height:50px;width:100%;15px`); footnote
`12px/1.5 --fg3`. First restaurant expanded by default.

### 3.26 Kanban column + owner order cards

Columns grid `repeat(auto-fit,minmax(min(300px,100%),1fr));gap:14px;align-items:start`. Column = `section`
(`aria-label`) `gap:10px`; header `600 15px` + mono 12px count `--fg3`.
Card base `.card` `padding:16px;gap:12–14px`; header row: code mono `500 14px` + meta `12.5px --fg3`
("8:14 PM · Ananya · +91 ••••• •3210" / customer first name).
- **New** (PLACED): `border-color:var(--acc)`, `arrive` + `ring ×3`, `aria-live="assertive"` region; countdown ring 56px top-right;
  items list `14.5px gap:8px` (qty mono 600 `min-width:24px` "2×", name 500, options 12.5px `--fg3`); note box
  `padding:8px 10px;border-radius:10px;background:var(--warn-bg);color:var(--warn);13px` "Note: less spicy please";
  "Prep time" 12.5px `--fg3` + 4 prep pills; action grid `1fr 2fr;gap:8px`: Reject (outline block 48, text `--bad`) /
  Accept · 20 min (primary block 48, 15px). Reject mode: "Reason (required)" `500 14px` + 2×2 reason pills
  (Out of stock · Kitchen busy · Closing soon · Other…) + ghost "Back".
- **Preparing** (ACCEPTED/PREPARING): items one line `14px/1.45`; progress bar (§3.17); primary block 44 "Mark ready"
  (or "Start preparing" when the server only allows PREPARING). Moved-in card animates `slidein`.
- **Ready** (READY_FOR_PICKUP): items line; pickup-code panel `padding:14px;border-radius:12px;background:var(--bg2);
  border:1px solid var(--line);gap:10px;align-items:center` (12.5px `--fg3` "Pickup code — the rider tells you this" + 4 display boxes 46×56);
  rider row `13.5px gap:10px` (30px initial avatar, "Ravi · at restaurant", delivery chip).
- **Empty column / ended**: dashed box `border:1px dashed var(--line2);border-radius:16px;padding:28px 18px;text-align:center;gap:6px`,
  title `500 14.5px` ("No new orders" / "Auto-rejected — the accept window passed" / "Rejected · the customer is being refunded"),
  sub 13px `--fg3` "New orders appear here with a chime." (`slidein`).

### 3.27 Sidebar nav (role shells)

`aside` `flex:1 1 232px` (admin 224) · `background:var(--side);border-right:1px solid var(--line);padding:18px 14px`
(admin `18px 12px`) · `flex-direction:column;gap:18px` (admin 16).
1. Brand row (`padding:0 6px`): 24px logo mark + wordmark `800 22px` + **role tag** `margin-left:auto`, mono `10.5px`,
   `--fg3`, `border:1px solid var(--line);border-radius:5px;padding:2px 5px`: `KITCHEN` (restaurant) · `PARTNER` · `OPS` (admin).
2. Context block: restaurant switcher (outline btn `height:52px;border-radius:12px;padding:0 10px;gap:10px` → 30px `radius 8`
   initials tile `--acc-soft`/`--acc-fg` `600 12px`, name `500 14px`, area 12px `--fg3`, 14px up-down chevrons) · partner
   profile card (`.card padding:12px;gap:10px`: 36px avatar, name `500 14px`, mono 11.5px "Scooter · KA03HX4417") · admin
   search button (outline `height:36px;border-radius:10px;color:var(--fg3)`, 14px icon, "Search orders, phones…", kbd mono
   10.5px `⌘K` `border:1px solid var(--line);border-radius:4px;padding:1px 5px`).
3. Nav (`.nav`, gap 2 / admin 1): link `display:flex;justify-content:space-between;gap:8px;min-height:38px;padding:0 10px;
   border-radius:10px;color:var(--fg2);font:450 14px Figtree` (admin `min-height:34px;border-radius:9px;13.5px`); hover
   `background:var(--muted);color:var(--fg)`; current (`aria-current="page"`) `background:var(--card);color:var(--fg);
   box-shadow:0 0 0 1px var(--line);font-weight:500`. Section labels (admin) `.lbl` `padding:14px 10px 6px`.
   Trailing badges: **urgent count** mono 11px `padding:2px 7px` (admin `1px 7px`) `border-radius:999px;background:var(--acc);color:var(--pri-fg)`
   (export uses `#fff` in both themes; `--pri-fg` gives readable `#121212` on dark chili — derived) · **plain count** `.cnt` mono 500 11px `--fg3` · **health dot** 7px `--bad` `blink`
   (degraded: `--warn`, static).
4. Footer `margin-top:auto;padding:10px 6px 0;border-top:1px solid var(--line);gap:10px`: avatar (32px; admin 30px initials
   `600 12px`) + name `500 13.5px` (admin 13px) + role 12px `--fg3` ("Owner" / "Ops admin · MFA on") + theme icon button.
   Partner footer: partner status chip (`Approved` ok) + theme button.

### 3.28 Top navs

- **Public (board 00), sticky:** (a) utility bar `.band`, `border-bottom:1px solid var(--line)`, container 1240,
  `min-height:40px;gap:8px 18px`: demo pill · "Bengaluru · pilot city" (14px pin, `600 13px --fg3`) · secondary nav
  (`margin-left:auto;gap:20px`, links `600 13px --fg2`, hover `--acc-fg`) · 1×16px divider `--line2` · theme segmented.
  (b) main bar `background:color-mix(in srgb,var(--bg) 80%,transparent);backdrop-filter:blur(16px);border-bottom`,
  `padding:12px 24px;gap:12px 18px`: logo (34px ringed mark + 25px wordmark) · 1×32px divider · location button
  (`.loc`: `padding:6px 10px 6px 6px;border-radius:12px`, hover `--muted`; 34px `radius 10` tile `--pri-soft`/`--pri-ink`
  with 17px pin; "DELIVER TO" `700 11px` uppercase .08em `--fg3`; value `800 15px` + chevron) · header search (§3.2) ·
  nav links (`.navlink` `600 15px --fg2;padding:10px 12px;border-radius:10px;gap:7px` 17px icon; hover `--muted`/`--fg`):
  Offers, Sign in · cart button (`.cartbtn` `height:48px;padding:0 12px 0 16px;border-radius:14px;border:1.5px solid var(--line2);
  700 15px;gap:8px`, count bubble mono 11px `min-width:20px;height:20px;border-radius:999px;background:var(--muted);color:var(--fg3)`;
  non-zero count (extrapolated) `background:var(--pri);color:var(--pri-fg)`).
- **Consumer app (boards 10, 11, 13):** sticky (10) `border-bottom:1px solid var(--line);background:color-mix(in srgb,var(--bg) 85%,transparent);
  backdrop-filter:blur(12px)`, `padding:10px 24px;gap:12px 16px`. Logo (26px mark + 23px wordmark) · then per page:
  discover = location button (outline, `max-width:280px;gap:10px`, 16px pin `--acc`, label 600 + address `--fg3`
  ellipsis + chevron) + app search + right cluster (`margin-left:auto;gap:6px`: ghost "Orders", bell icon button with 7px `--acc`
  unread dot at `top:9px;right:10px`, theme, 36px avatar `background:var(--muted);border:1px solid var(--line);600 14px`);
  restaurant = breadcrumb (14px `--fg3`, current `--fg`) + right (theme, primary "Cart · 3"); account pages (13) = ghost
  nav "Restaurants · Orders · Thali Plus · Support" (current `background:var(--muted);color:var(--fg)`) + theme + avatar.
  **Binding:** all consumer pages use the discover header (location + search + Orders/bell/theme/avatar) except the
  restaurant page (breadcrumb variant, location still shown ≥1024px) and checkout. Account-area pages add the 4-link
  ghost nav (board 13) under the logo row on ≥1024px.
- **Checkout (board 12):** not sticky, `max-width:1160px;padding:12px 24px;gap:16px`: back icon button (chevron-left) ·
  logo · "/ Checkout" 14px `--fg3` · right: lock icon + "Secure checkout" 13px `--fg3` · theme. No search, no cart.
- **Sign-in (board 01):** in-column header: logo (26px + 23px) · right: outline theme icon button + ghost "← Back to site".

### 3.29 Map placeholder + SIMULATED LOCATION tag

Container `position:relative;height:280px;background:var(--map);border-top/bottom:1px solid var(--line);overflow:hidden`,
`role="img"` with a sentence `aria-label` ("Map showing the rider between Spice Route and your home. Location is simulated.").
- Placeholder art: `illustrations/map-placeholder-route.svg` (blocks `--blk`, roads `--road` 14px, dashed route `--acc` 4px
  `stroke-dasharray:10 6` with `dash` animation, restaurant = 10px `--fg` dot with 4px `--bg` centre, home = `--acc` pin,
  rider = 17px `--pri` circle with 3px `--bg` stroke + bike glyph in `--pri-fg`, moving along `offset-path` 10s
  `ease-in-out infinite alternate`).
- **Real map (binding):** use Leaflet `MapView` in the same frame; markers restyled to the placeholder glyphs; route line
  `--acc` dashed. Dark theme: tile pane `filter:invert(1) hue-rotate(180deg) brightness(.85) contrast(.9)` **(derived)**.
  Placeholder art is the fallback when tiles fail or no coordinates yet.
- Tag: `position:absolute;left:14px;top:14px;font:11px 'JetBrains Mono';letter-spacing:.06em;padding:6px 9px;border-radius:8px;
  background:var(--pri);color:var(--pri-fg)` text `SIMULATED LOCATION` — only when the tracking payload says simulated.

### 3.30 Data table

`table{width:100%;border-collapse:collapse}` inside `overflow-x:auto`. `th`: `font:500 11px 'JetBrains Mono';text-transform:uppercase;
letter-spacing:.06em;color:var(--fg3);text-align:left;padding:10px 14px;border-bottom:1px solid var(--line);white-space:nowrap;
background:var(--side)`. `td`: `padding:11px 14px;border-bottom:1px solid var(--line);font-size:13.5px;vertical-align:middle;
white-space:nowrap`. Row hover `background:var(--bg2)` `.12s`; clickable rows are links (whole row, `cursor:pointer`,
focusable first cell link). Money right-aligned; codes mono; times `--fg3`; refund cell coloured (`--info` pending,
`--ok` refunded, `—` `--fg3`). Health table: no header, first cell 500, error text mono 12px in tone colour.
≤640px: rows collapse to cards (label/value pairs) — existing `DataTable` behaviour, restyled.

### 3.31 Skeletons

`.sk`/`skeleton` utility (§1.9) — `border-radius:8px`, shimmer 1.5s. Must match the final layout: text lines 12px tall
(widths 90/60/75%), card covers 150px block, KPI value 26px × 60%, avatar circles, chip 24×80 pill. Spinners only inside
buttons. Loading regions get `aria-busy="true"`.

### 3.32 Empty & error states

- **Empty (board 10):** `.card` with `border-style:dashed;padding:40px 24px;align-items:center;gap:12px;text-align:center`;
  title `600 17px`; body `14px --fg3`; one action (outline button) e.g. "Clear filters". Compact (board 20 column): §3.26.
- **Error (extrapolated, same frame):** solid border `--line`, 36px `radius 10` icon tile `--bad-bg`/`--bad` with alert
  icon, title `600 17px` "Couldn't load restaurants", body = server message (`14px --fg3`), primary-outline "Retry"
  (loading state while refetching). Inline error (field/section): 13px `--bad` with 14px alert icon.
- **Forbidden / session expired:** same frame; actions "Sign in" (primary) / "Go home" (ghost).

### 3.33 Toasts

Pill: `font-size:12px;padding:5px 10px;border-radius:999px;background:var(--card);border:1px solid var(--line);color:var(--fg2);
box-shadow:var(--shadow)`; `aria-live="polite"`; `toast` 4.5s keyframe (enter, hold, fade). Placement: consumer —
centred directly under/above the cart dock (or bottom-centre 20px when no dock); role shells — bottom-right 20px
**(extrapolated)**. Variants (extrapolated): success = 6px `--ok` dot prefix; error = `--bad` dot, persistent until
dismissed (× 20px ghost) and `role="alert"`; never show success before the server confirms.

### 3.34 Avatar

Circle, `background:var(--muted);display:flex;align-items:center;justify-content:center;font-weight:600;color:var(--fg)`.
Sizes: 30 (admin sidebar, 12px text, 2 initials "NK") · 32 (owner sidebar, 13px) · 36 (header with `border:1px solid var(--line)`,
14px; partner card) · 40 (rider row, 15px). Photo variant (extrapolated): same box, `<img>` `object-fit:cover;border-radius:50%`
+ `box-shadow:0 0 0 1px var(--line)`; on error fall back to initials. Initials = first letter of first + last name
(single letter when one name). Cart/brand avatars: hue fill + `#fff` text (§3.22). Restaurant tiles are rounded squares (8px).

### 3.35 Logo, theme toggle, misc

- Logo mark: `illustrations/logo-mark.svg` (32 viewBox: chili disc `var(--pri)`, white dots at (12,13) r3.2 and (16,20.5)
  r3.6, `#ffc145` dot at (20.5,13) r3.2). Public header uses `logo-mark-ring.svg` (adds a `#fff` 1.5px ring r11.5 at
  `opacity:.55`). Wordmark "thali" lower-case, Bricolage 800. Logo link → role home (`/`, `/restaurant`, `/partner`, `/admin`).
- Theme toggle (app): ghost icon button (sign-in: outline), moon icon in light / sun in dark, `aria-label="Switch to dark mode"`.
- Info notice (partner browser limits): `padding:14px 16px;border-radius:14px;border:1px solid var(--line);background:var(--warn-bg);
  gap:10px;13px/1.5 --fg2` + 16px info icon `--warn`.
- Status banner (owner): `display:flex;gap:12px;padding:14px 16px;border-radius:14px;border:1px solid var(--line);background:<tone-bg>`;
  8px dot `<tone>`; title `500 14.5px` + text 13px `--fg3`; outline CTA. Tones per state: draft `--muted`/`--fg3`,
  email-pending warn, awaiting-approval info, rejected bad, suspended bad, paused warn.
- Section card header (admin): `padding:14px 16px;border-bottom:1px solid var(--line)` + h2 `14.5px` + count `.cnt` or
  "checked 14s ago" 12px `--fg3`. List rows `padding:12px 16px;gap:12px;border-bottom`.
- Explanation box (rejected child): `margin:0 20px;padding:14px 16px;border-radius:12px;background:var(--bg2);border:1px solid var(--line);
  gap:6px`; sentence `500 15px/1.5`; reassurance `13.5px --fg3`.
- Batching box (partner): `padding:12px 14px;border-radius:12px;background:var(--ok-bg);gap:6px`; title `500 13px --ok`;
  lines mono 12.5px `--ok` "✓ pickup 0.8 km ≤ 1.5 km".

Component count: 35 sections (§3.1–3.35) covering ~75 named components/variants.

---

## 4. Illustrations

All dish art is inline SVG (no raster). Extracted to `.superpowers/sdd/2026-10-11-ui-reillustrations/`
(viewBox kept, outer width/height removed; port as React components or `?react` SVG imports into
`apps/web/src/components/illustrations/`). Colours inside dish art are fixed literals (they read on both themes because
they sit on tinted discs).

| File | Source | Disc hue (app formula `color-mix(in srgb,<hue> <pct>%,var(--card))`) |
|---|---|---|
| `cuisine-all.svg` | board 10 | `#71717a` 14% |
| `cuisine-biryani.svg` | board 10 (richest version) | `#c2410c` 16% |
| `cuisine-south-indian.svg` (dosa) | board 10 | `#a16207` 16% |
| `cuisine-north-indian.svg` | board 10 | `#b45309` 16% |
| `cuisine-chinese.svg` (noodle bowl) | board 10 | `#b91c1c` 14% |
| `cuisine-coastal.svg` (fish on leaf) | board 10 | `#0e7490` 15% |
| `cuisine-rolls.svg` | board 10 | `#a16207` 13% |
| `cuisine-pizza.svg` | board 10 | `#ca8a04` 14% |
| `cuisine-healthy.svg` (salad bowl) | board 10 | `#15803d` 14% |
| `cuisine-desserts.svg` (gulab jamun) | board 10 | `#be185d` 13% |
| `cuisine-chai-snacks.svg` | board 10 | `#7c2d12` 13% |
| `hero-biryani.svg` | board 00 hero disc 120px (svg 100px), `bob` | white disc |
| `hero-dosa.svg` | board 00 hero disc 132px (svg 112px), `bob2` | white disc |
| `hero-gulab-jamun.svg` | board 00 hero disc 90px (svg 74px), `bob` delay 1.2s | white disc |
| `hero-noodles.svg` | board 00 CTA disc 110px (svg 88px), `opacity:.95` | white disc |
| `hero-sun-blobs.svg` | board 00 hero art panel (`#ff9d1a` .6 + `#ffcf5c` .7 circles on `var(--sun)`, `radius 40px`, `inset:20px 0`) | — |
| `logo-mark.svg`, `logo-mark-ring.svg` | boards 01 / 00 | uses `var(--pri)`; standalone use: replace with `#d23f11` |
| `promo-restaurants-mark.svg` | board 00 restaurants block (220px, `right:-50px;bottom:-60px;opacity:.18`, white) | — |
| `promo-riders-bike.svg` | board 00 riders block (240×200, `right:-30px;bottom:-40px;opacity:.16`, `#ffc145`) | — |
| `map-placeholder-route.svg` | board 13 (uses `var(--blk/--road/--acc/--fg/--bg/--pri/--pri-fg)`) | — |
| `restaurant-cover-placeholder.svg` | board 10 cover (uses `currentColor` = restaurant hue) | `16%` |
| `restaurant-logo-placeholder.svg` | board 11 96px logo tile (64px svg, `currentColor`) | `18%`, tile `radius 20px`, `border:1px solid var(--line)` |

Cuisine ↔ data: map `GET /cuisines` slugs to these files (`biryani`, `south-indian`, `north-indian`, `chinese`,
`coastal`, `rolls`, `pizza`, `healthy`, `desserts`, `chai-snacks`); unknown slug → `cuisine-all.svg` + `#71717a`. The
board-00 and board-02 variants of the same dishes are simplified (fewer strokes); use the board-10 files everywhere.
Role door icons (board 00) are 26px stroke icons (2.2 stroke) on 52px `radius 16px` tiles: Order food (bowl, tile `--pri`,
icon `#fff`), Run a restaurant (store, `--sun`/`#141414`), Deliver (bike, `--leaf`/`#fff`), Operations (shield-check,
`--fg`/`--bg`) — add the missing glyphs (`bowl`, `shield-check`) to `ui/Icon.tsx`; the rest exist (`store`, `bike`).

---
## 5. Per-board screen specs

Conventions for the tables: **Behaviour** names the route (`→ /path`), the API call (`GET/POST …` — paths are the
gateway paths already used in `apps/web/src/features/*/api.ts`), or "client" (no backend). **Gap** = the design asks
for something the current backend/web code does not provide; resolve before wiring (listed again in §8).
Every page also has the global states (loading skeleton, empty, error + Retry, forbidden, session expired) from §3.31–3.32.

### 5.00 Public landing — board 00 (`b00-0/1/2.png`)

**Route:** `/` when the visitor has **no delivery location set** (signed in or not); once a location is set, `/` renders
Discover (§5.10). Also reachable always at `/welcome` (new alias) so role doors/"Back to site" have a stable target.
**Layout:** shell = public sticky 2-tier header (§3.28), root `page-glow-long`; container 1240px; sections in order:
1 Hero (2 columns: copy `flex:1 1 480px` / art `flex:1 1 440px;min-height:500px`, gap 48, `padding:72px 24px 88px`) ·
2 Cuisines band (`.band`, borders top/bottom, `padding:48px 24px`) · 3 "Pick your door" (4 cards, `padding:88px 24px 40px`) ·
4 "How it works" (3 cards, `padding:72px 24px`) · 5 "Our promise" band (2 columns, `padding:80px 24px`) · 6 Promo pair
(2 blocks `radius 28`, `min-height:320px;padding:40px`) · 7 CTA block (turmeric `#ffb020`, `padding:52px 44px`, `radius 28`) ·
8 Footer (`.band`, 4 columns + legal row).

| # | Element | Behaviour | Data / states |
|---|---|---|---|
| 00-01 | Demo pill (utility bar) | client | `GET /meta` → `mode`; hidden unless demo/sandbox (§3.12) |
| 00-02 | "Bengaluru · pilot city" | static copy | — |
| 00-03 | Partner with us | scroll to `#restaurants` (promo block) | — |
| 00-04 | Ride with Thali | scroll to `#riders` | — |
| 00-05 | Help & support | → `/support` (sign-in gate → `/signin?returnTo=/support`) | — |
| 00-06 | Theme segmented Light / Dark | client: set `data-theme`, persist `localStorage['thali-theme']` | `role=radiogroup`; initial = stored or system |
| 00-07 | Logo | → `/` | — |
| 00-08 | Location button "Deliver to · Set your location" | opens `LocationPicker` (dialog ≥640 / bottom sheet <640): use current location, drop pin on map, saved addresses (signed-in, `GET /me/addresses`) → `GET /discovery/serviceability?lat&lng` → save → `/` (Discover) | Unset: "Set your location"; set: label + address line; not serviceable: "We don't deliver here yet" in picker |
| 00-09 | Header search + `/` shortcut | `/` focuses; submit → `/search?q=` (if no location: open picker first, then continue) | placeholder "Search for biryani, dosa or a restaurant" |
| 00-10 | Offers | → `/search?offers=1` **Gap:** no public offers page; options: (a) open a sheet listing `GET /coupons/available` (check it is public), (b) remove link. Default: (a) if public, else hide | — |
| 00-11 | Sign in | → `/signin?returnTo=<current>`; when signed in replaced by avatar menu (Account `/account`, Orders `/orders`, Sign out `POST /auth/logout`) | — |
| 00-12 | Cart button + count | opens `CartDrawer` (guest carts supported) | count = total items from `GET /cart`; 0 → muted bubble; >0 → chili bubble |
| 00-13 | "Now delivering across Bengaluru" pill | static (pulse decorative) | — |
| 00-14 | Address field "Enter your delivery address" | focus/click opens `LocationPicker` with the typed text as hint. **Gap:** no geocoding API (only `/discovery/serviceability` by lat/lng) — free-text address search not possible; field is a picker trigger | — |
| 00-15 | Use my location | `navigator.geolocation` → `GET /discovery/serviceability` → if serviceable save + → `/` Discover; denied → inline "Location blocked — drop a pin instead" + opens picker; not serviceable → inline message | loading spinner in button |
| 00-16 | Find food | if location set → `/`; else open picker | — |
| 00-17 | Trust ticks ×2 | static | — |
| 00-18 | Hero cart card (Your cart, Split order, items, ₹646.20, "Pay once") | **static illustration** — `aria-hidden="true"`, not interactive (`pointer-events:none`); `split` animation on the two kitchen boxes | — |
| 00-19 | Hero dish discs ×3 | decorative (`aria-hidden`), `bob/bob2` | — |
| 00-20 | See all restaurants → | → `/` Discover (picker first if no location) | — |
| 00-21…00-29 | Cuisine circles: Biryani, South Indian, North Indian, Chinese, Coastal, Pizza, Healthy, Desserts, Chai & Snacks | → `/?cuisine=<slug>` (picker first if no location) | list from `GET /cuisines` (show those with art; order by API); horizontal scroll ≤ viewport |
| 00-30 | Door: Order food / Start browsing | → `/` (picker if needed) | — |
| 00-31 | Door: Run a restaurant / Restaurant sign in | → `/signin?role=restaurant` | — |
| 00-32 | Door: Deliver with Thali / Partner sign in | → `/signin?role=partner` | — |
| 00-33 | Door: Thali operations / Admin sign in | → `/admin/login` | — |
| 00-34 | How it works cards ×3 | static (inline sample chips: Delivered ok, Refunded ₹218.10 info) | — |
| 00-35 | Promise cards ×4 (New vs ★ 4.3 (126) · 32 min ESTIMATE · UTR · Net after refund ₹428.10) | static explainer samples | — |
| 00-36 | List your restaurant (white on chili) | → `/restaurant/onboarding` (sign-in gate) | — |
| 00-37 | See the console (outline on chili) | → `/signin?role=restaurant` | — |
| 00-38 | Apply to ride (turmeric on ink) | → `/partner/onboarding` (sign-in gate) | — |
| 00-39 | See the partner app (outline on ink) | → `/signin?role=partner` | — |
| 00-40 | Find food near me → (dark, lg) | same as 00-15 (geolocate) with picker fallback | — |
| 00-41 | Footer: Restaurants | → `/` | — |
| 00-42 | Footer: Thali Plus | → `/membership` | — |
| 00-43 | Footer: Your orders | → `/orders` (gate) | — |
| 00-44 | Footer: List a restaurant | → `/restaurant/onboarding` | — |
| 00-45 | Footer: Ride with Thali | → `/partner/onboarding` | — |
| 00-46 | Footer: Ops sign in | → `/admin/login` | — |
| 00-47 | Footer: Support | → `/support` | — |
| 00-48 | Footer: Refunds | → `/support?new=1&category=PAYMENT` (prefilled ticket) | — |
| 00-49 | Footer: Terms | → `/terms` **Gap:** page does not exist — add static page | — |
| 00-50 | Footer: Privacy | → `/privacy` **Gap:** add static page | — |
| 00-51 | Legal row "© 2026 Thali · Prices in INR · Times in IST" | static | — |

### 5.01 Sign-in — board 01

**Routes:** `/signin` (`?role=customer|restaurant|partner`, `?returnTo=`) and `/admin/login` (same screen, Admin tab
preselected; Admin tab on `/signin` navigates to `/admin/login`). Also opened as a dialog from cart/checkout
(`LoginDialog`) — dialog = left column only, 440px wide.
**Layout:** demo strip; two columns `flex:1 1 520px` each: left (`padding:24px clamp(20px,4vw,48px)`: header row, centred
form `max-width:400px;gap:24px`, legal line at bottom 12.5px) · right aside (`grid-bg` + `background-color:var(--side)` +
`backdrop-filter:blur(6px)` + acc-soft radial spot, `border-left:1px solid var(--line)`, content `max-width:440px;gap:28px`).
Role copy (binding, from the board script):

| Role | Title / subtitle | Foot text + link | Aside tag · headline (accent) · 3 points |
|---|---|---|---|
| Customer | "Welcome back" / "Sign in to check out, track orders and manage addresses." | "Just browsing? You don't need an account." **Explore restaurants →** `/` | CUSTOMER · "Your cart comes **with you.**" · 01 Cart kept on sign-in — Anything you added as a guest is merged into your account. · 02 Track every kitchen — Each restaurant has its own status, rider and delivery code. · 03 Refunds to the rupee — Paid, refunded and pending are always shown separately. |
| Restaurant | "Restaurant sign in" / "Use the phone number registered as the restaurant owner." | "New to Thali?" **List your restaurant →** `/restaurant/onboarding` | RESTAURANT OWNER · "Run the counter **from here.**" · Live orders — Chime + countdown on every new order. Accept with a prep time. · Menu and stock — Toggle availability in one tap. Stock can't go below reserved. · Earnings and payouts — Every payout marked Paid carries its bank UTR. |
| Partner | "Partner sign in" / "Use the phone number on your partner profile." | "Want to deliver with Thali?" **Apply to ride →** `/partner/onboarding` | DELIVERY PARTNER · "Ready when **you are.**" · Go online in one tap — Location is shared only while you're online. · Offers you can judge — Distance, time and why a second order fits — before you accept. · Codes at each handover — Pickup code at the restaurant, delivery code at the door. |
| Admin | "Operations sign in" / "Email and password, then a code from your authenticator app." | "Lost your authenticator?" **Contact a super admin** (static text, no link) | RESTRICTED · "Thali **operations.**" · MFA required — Every session needs a fresh 6-digit TOTP code. · Everything is audited — Approvals, refunds and payouts are logged with who, when and IP. · Role-based actions — Ops, Finance and Support see only the actions they can take. |

| # | Element | Behaviour | Data / states |
|---|---|---|---|
| 01-01 | Demo strip | client (`/meta`) | §3.12 |
| 01-02 | Logo | → `/` | — |
| 01-03 | Theme icon button | client toggle | — |
| 01-04 | ← Back to site | → `returnTo` if it is a public page, else `/` | — |
| 01-05…01-08 | Role tabs Customer / Restaurant / Partner / Admin | client: switch copy + form, reset to step 1, update `?role=`; Admin → `/admin/login` | `aria-pressed`; `swap` animation |
| 01-09 | +91 prefix | static | — |
| 01-10 | Mobile number input | client validation (10 digits; strips +91/0/spaces) | error "Enter a 10-digit mobile number" |
| 01-11 | Send code | `POST /auth/otp/request {phone}` → step 2 | loading; 429 → "Too many requests. Try again in N s" (server `retryAfter`) |
| 01-12 | Work email (admin) | client validation | — |
| 01-13 | Password (admin) | — | show/hide toggle (extrapolated, 40px icon button inside field) |
| 01-14 | Forgot? (admin) | **Gap:** no password-reset endpoint → render as `--fg3` text "Forgot? Ask a super admin" (not a link) | — |
| 01-15 | Continue (admin) | `POST /auth/admin/login {email,password}` → step 2 (TOTP); not enrolled → MFA setup (`POST /auth/admin/mfa/setup` → `MfaSetup` screen: otpauth URI + manual key + confirm `POST /auth/admin/mfa/enable`, then sign in again) | errors inline; lockout message from server |
| 01-16 | "Sent to +91 98765 43210" / "admin@thali.demo" + Change | Change → step 1 (keeps phone/email) | — |
| 01-17 | 6 code boxes | client: auto-advance, paste fills, backspace back; auto-submit on 6th digit | wrong → boxes `--bad` + "Incorrect code"; exhausted/expired → "Code expired — resend" |
| 01-18 | "Resend code in 0:30" / Resend code | countdown from server cooldown; Resend → `POST /auth/otp/request` again | phone flow only |
| 01-19 | `DEMO: 123456` badge | client, only when `/meta` mode = demo | mono 11.5px `--warn-bg`/`--warn`, `padding:4px 8px;radius 6px` |
| 01-20 | Verify & continue | customer/restaurant/partner: `POST /auth/otp/verify {phone,code}` (server merges guest cart) → redirect: customer `returnTo`‖`/`; restaurant `/restaurant` (no owner role → `/restaurant/onboarding`); partner `/partner` (no partner profile → `/partner/onboarding`). Admin: `POST /auth/admin/mfa {code}` → `/admin` | loading; errors as 01-17 |
| 01-21 | Foot link (per role) | see role table | — |
| 01-22 | Terms | → `/terms` (Gap 00-49) | — |
| 01-23 | Privacy Policy | → `/privacy` (Gap 00-50) | — |
| 01-24 | Aside panel (tag, headline, 3 points) | static per role | `aria-hidden` not needed (real copy) |

### 5.02 Foundations — board 02

Not a product screen. It is the token/visual reference used in §1–§3 (palette swatches, light/dark panels, sample
restaurant card, buttons, chips, input, veg marks, cart bar light/dark, live/deadline/loading/contrast cards). Optional:
build it as a dev-only route `/__ui` (excluded from production builds) that renders every component in both themes —
recommended as the visual QA page. Contrast claims on the board (binding acceptance criteria): white on chili 4.7:1, ink on
white 18:1, muted text 5.3:1, charcoal on chili (dark) 7:1; every text pair passes WCAG AA. Interactive elements: none
(0); if `/__ui` is built, its controls are client-only.

### 5.10 Consumer discover + floating multi-cart bar — board 10 (`board-03.png`)

**Route:** `/` (location set). Also the frame for `/search?q=` (same grid; header search filled; results grouped
"Restaurants" then restaurants with matched dishes listed under each card: 13.5px lines "Matches: Chicken Dum Biryani · ₹279").
**Layout:** demo strip · sticky consumer header (container 1360) · cuisine band (`background:var(--side)`, `padding:22px 24px 18px`,
h2 20px + scroll buttons + train) · body container 1360 `padding:28px 24px 40px;gap:28px`: filters aside `flex:1 1 200px;max-width:240px;gap:24px`
+ main `flex:999 1 560px;gap:22px` (title row + card grid `auto-fill minmax(260px)` gap 16) · sticky cart dock.

| # | Element | Behaviour | Data / states |
|---|---|---|---|
| 10-01 | Demo strip | `/meta` | — |
| 10-02 | Logo | → `/` | — |
| 10-03 | Location button (Home · 12th Main, Indiranagar) | opens `LocationPicker`; change → refetch discovery | label = saved address label or "Pinned location"; text ellipsis |
| 10-04 | Search + `/` | → `/search?q=`; debounced suggestions not required | — |
| 10-05 | Orders | → `/orders` (gate) | hidden for guests (show "Sign in" ghost instead) |
| 10-06 | Notifications bell + unread dot | → `/notifications` | unread from `GET /notifications` (count of unread); dot hidden at 0; `aria-label="Notifications, N unread"` |
| 10-07 | Theme toggle | client | — |
| 10-08 | Account avatar "P" | menu: Account `/account`, Addresses `/account/addresses`, Thali Plus `/membership`, Support `/support`, Sign out (`POST /auth/logout`) | initial from `GET /me` name; guest → "Sign in" button |
| 10-09 | Scroll cuisines left | client scroll by visible width | disabled at start |
| 10-10 | Scroll cuisines right | client | disabled at end |
| 10-11…10-21 | Cuisine circles: All, Biryani, South Indian, North Indian, Chinese, Coastal, Rolls, Pizza, Healthy, Desserts, Chai & Snacks | set `?cuisine=` → `GET /discovery/restaurants?lat&lng&cuisine=…` | `aria-pressed`; list from `GET /cuisines` + "All" |
| 10-22 | Veg only pill | toggles `?veg=1` → refetch (`pureVeg` filter) | pressed state |
| 10-23 | Open now pill | toggles `?open=1` → refetch | — |
| 10-24…10-26 | Price ₹ / ₹₹ / ₹₹₹ | multi-select `priceBand=1,2,3` → refetch | design shows ₹₹ pressed |
| 10-27 | Sort by select | `sort` = `distance` / `deliveryFee` / `eta` / `rating` → refetch; rating note "Rated restaurants (5+ real ratings) first; others are marked "New"" | — |
| 10-28 | H1 "Delivering to **Home**" | data | accent = address label (fallback area name) |
| 10-29 | Count line "4 open now · 6 restaurants deliver here" | data (response totals), `aria-live="polite"`; prefixed with cuisine name when filtered | — |
| 10-30 | EST. legend "times are demo estimates" | data: show when any ETA is an estimate; "demo estimates" when `isDemoEstimate` | — |
| 10-31 | Restaurant card (×N) | → `/restaurants/:slug` | name, cover/hue, Pure veg, state badge (`nextOpenAt` → "Opens at 6:00 PM"; paused → "Not accepting orders"), rating or New (≥5 rule), cuisines + price band, ETA est./"Closed now", km, delivery fee; closed `opacity:.62` |
| 10-32 | Empty state + Clear filters | Clear → reset cuisine/veg/open/price to defaults | "No Biryani restaurants deliver to Home right now." |
| 10-33 | Dock summary button | client: toggle tray (`aria-expanded`); hover opens on fine pointer | "2 carts · 3 items" / "2 deliveries, one payment" from `GET /cart` grouped by restaurant |
| 10-34 | Dock per-cart chips | open tray on that cart's tab | "Spice Route · ₹378" (group items subtotal) |
| 10-35 | Checkout · ₹558 → | → `/checkout` (guest → sign-in dialog, then continue) | amount = cart items subtotal from server cart (fees at checkout) |
| 10-36 | Tray tabs (All carts / per restaurant) | client filter | counts per group |
| 10-37 | Tray close | client unpin/close | — |
| 10-38 | Line qty − | `PATCH /cart/items/:lineId {quantity}`; 1→0 = `DELETE /cart/items/:lineId` | optimistic with rollback; `aria-live` count |
| 10-39 | Line qty + | `PATCH /cart/items/:lineId` (max 20) | disabled at 20 |
| 10-40 | Checkout only {restaurant} → | → `/checkout?restaurant=<id>` **Gap:** checkout API takes the whole cart; needs a restaurant subset param in `POST /cart/preview` + `POST /checkouts`, else hide this link | — |
| 10-41 | Tray footnote | static | — |
| 10-42 | Toast "Added Double ka Meetha to Spice Route · hover to see all carts" | client after successful `POST /cart/items` (from restaurant page/search) | 4.5s; touch devices: "tap to see all carts" |
| 10-43 | Restaurant card pre-states (not drawn) | loading: 6 skeleton cards; no location: prompt card "Set your delivery location" + button (→ picker); not serviceable: "We don't deliver here yet" + "Try another location"; error: §3.32 + Retry | — |

### 5.11 Restaurant menu + item customizer — board 11 (`board-04.png`)

**Route:** `/restaurants/:idOrSlug`; customizer = dialog over the page (≥640) / bottom sheet full-height (<640).
**Layout:** demo strip · consumer header (breadcrumb variant, container 1200) · hero band (`background:var(--side)`,
`padding:36px 24px`; 96px logo tile + h1 40px + meta line 15px `--fg3`; right: 4 stat cards `padding:10px 14px;gap:4px`
with `.lbl` + `600 15px`) · body container 1200 `padding:28px 24px 64px;gap:40px`: sticky category nav (`flex:1 1 180px;max-width:220px;top:20px`)
+ main (`flex:999 1 560px`) with section h2 22px + dish rows.

| # | Element | Behaviour | Data / states |
|---|---|---|---|
| 11-01 | Logo | → `/` | — |
| 11-02 | Breadcrumb "Restaurants" | → `/` | current = restaurant name |
| 11-03 | Theme toggle | client | — |
| 11-04 | Cart · 3 (primary) | opens `CartDrawer` (≥640 right sheet, <640 bottom sheet); `/cart` on no-JS fallback | count = total items; hidden/outline "Cart" at 0 |
| 11-05 | Restaurant header (logo tile, name, "Biryani · Mughlai · Indiranagar · Open till 11:30 PM") | data `GET /restaurants/:idOrSlug` | open state text: "Open till …" / "Opens at 6:00 PM" / "Temporarily not accepting orders"; Pure veg badge if applicable; description (not drawn) 14px `--fg2` under meta |
| 11-06…11-09 | Stat cards Rating · Delivery (EST.) · Distance · Fee | data | rating "★ 4.3 (126)" or "New"; ETA with EST.; distance from selected location; fee |
| 11-10 | Not-deliverable notice (not drawn) | data: serviceability for current location | `--warn-bg` banner (§3.35 shape): "Spice Route doesn't deliver to Home (too far). You can still browse." + "Change location" (→ picker); all Add buttons disabled |
| 11-11 | Category links (Recommended 4, Biryani 6, Kebabs 5, Breads 4, Desserts 3) | client: scroll to section; scroll-spy sets `aria-current` | counts = items per category |
| 11-12 | Dish row "Add +" | no groups → `POST /cart/items {restaurantId,itemId,quantity:1,selections:[]}` + toast; with groups → open customizer | loading spinner in button |
| 11-13 | "In cart · N" | see §3.23 (stepper for simple items → `PATCH /cart/items/:lineId`; customizable → open customizer) | N = sum of lines for that item |
| 11-14 | "Unavailable" (disabled) | none | "Sold out today" (stock 0) vs "Unavailable" |
| 11-15 | Customizer close (×), Esc, scrim click | client close (focus returns to trigger) | — |
| 11-16 | Size radio options (Half · serves 1 ₹249 / Full · serves 2 ₹399) | client select | group tag `REQUIRED · PICK 1` → `DONE`; optional single-choice groups get a "None" option (clearable) |
| 11-17 | Add-on checkboxes (Extra raita +₹30, Mirchi ka salan +₹40, Boiled egg +₹25, Extra leg piece · Unavailable +₹90) | client toggle; disables unselected options when max reached | counter "1 of 3"; unavailable disabled |
| 11-18 | Quantity − / + | client 1…20 | − disabled at 1, + at 20 |
| 11-19 | CTA "Choose a size" / "Add to cart" + total | `POST /cart/items {itemId, quantity, selections:[{groupId, optionIds}]}` → close, toast, refresh cart | disabled (`opacity:.4`) until required groups satisfied; total = (base + add-ons) × qty (display; server is truth); error inline above footer |

### 5.12 Checkout — board 12 (`board-05.png`)

**Route:** `/checkout` (sign-in required). After pay: Razorpay popup or `/demo-pay/:intentId` → `/checkout/status/:checkoutId`.
**Layout:** demo strip · checkout header (1160) · container `padding:36px 24px 72px;gap:32px`: main `flex:999 1 520px;gap:28px`
(h1 34px + sub; 3 numbered sections) + sticky bill aside `flex:1 1 340px;max-width:400px;top:24px`.
H1 copy: ≥2 restaurants "Two kitchens, **one payment.**" (number word: Two…Five, then digits); 1 restaurant "One kitchen,
**one payment.**" **(extrapolated)**. Sub: "Each restaurant cooks and delivers on its own. If one can't, only that part is refunded." (≥2) /
hidden (1).

| # | Element | Behaviour | Data / states |
|---|---|---|---|
| 12-01 | Back (chevron) | history back; fallback → `/` | — |
| 12-02 | Logo | → `/` | — |
| 12-03 | "/ Checkout" | static | — |
| 12-04 | "Secure checkout" | static | — |
| 12-05 | Theme toggle | client | — |
| 12-06 | Address cards (radio) | select → `POST /cart/preview {addressId,…}` (fees depend on address) | `GET /me/addresses`; DEFAULT tag; unserviceable disabled with reason |
| 12-07 | Add new address | opens address form dialog (map pin + line1, line2, landmark, city, pincode, label Home/Work/Other) → `POST /me/addresses` → auto-select → re-preview | max 10 → button disabled "Address limit reached" |
| 12-08 | Coupon row (applied): code + "Applied · −₹45.00, split across both restaurants" | data from preview `coupon` | — |
| 12-09 | Remove coupon | `DELETE /cart/coupon` (or `POST /cart/coupon {code:null}` per API) → re-preview | — |
| 12-10 | Coupon entry (not drawn, when none applied) | input + "Apply" → `POST /cart/coupon {code}`; "View offers" toggles list `GET /coupons/available` (each "Apply") | errors inline (expired, min order ₹X, limit reached, first order only) |
| 12-11 | Thali Plus switch | toggles `useMembership` → `POST /cart/preview` | only when `GET /memberships/me` is ACTIVE; sub "3 of 5 free deliveries left this month"; pending strip "Recalculating totals with the server…" (`--warn-bg`); inactive → row "Get Thali Plus →" `/membership` |
| 12-12 | Edit cart | opens `CartDrawer` (or → `/cart`) | — |
| 12-13 | Review cards per restaurant | data | lines "1 × Chicken Dum Biryani · Half, Extra raita ₹279", veg marks, mono "DELIVERY 1 · ~32 MIN EST." |
| 12-14 | "2 DELIVERIES" tag | data (restaurant count) | — |
| 12-15 | Bill accordion headers (per restaurant) | client expand/collapse | totals per restaurant from preview |
| 12-16 | Bill rows | data (preview breakdown per restaurant) | discount rows `--ok` with `−₹` |
| 12-17 | To pay | data (sum of restaurant totals from server) | — |
| 12-18 | Pay ₹646.20 | `POST /checkouts` (idempotency key; disable + spinner "Opening secure payment…") → Razorpay or `/demo-pay/:intentId` | problems from server → list above button with "Fix cart" links (→ restaurant page / drawer); price changed → dialog "Total changed from ₹X to ₹Y" + Confirm / Cancel |
| 12-19 | Footnote "Totals come from Thali's server…" | static | — |
| 12-20 | Pre-states (not drawn) | empty cart → empty state "Your cart is empty" + "Browse restaurants" `/`; preview loading → bill skeleton; preview error → §3.32 | — |

### 5.13 Order tracking — board 13 (`board-06.png`)

**Route:** `/orders/:checkoutId`. Realtime (order + tracking events) with 10 s polling fallback.
**Layout:** demo strip · consumer header with account nav (1200) · container `padding:28px 24px 72px;gap:24px`: title row
(breadcrumb 13px, h1 mono 30px + checkout pill, meta 14px `--fg3`; right live pill) · 2 columns: child cards `flex:999 1 560px;gap:16px`
+ aside `flex:1 1 320px;max-width:380px;gap:16px`.
Child headline copy by status (extrapolated except drawn ones): PLACED "Waiting for {R} to accept" · ACCEPTED/PREPARING
"Being prepared — **ready in about N min**" · READY_FOR_PICKUP "Ready — waiting for pickup" · PICKED_UP/OUT_FOR_DELIVERY
"On the way — **about 9 min**" (drawn) · DELIVERED "Delivered at 8:21 PM" · REJECTED "Couldn't be prepared" (drawn) ·
CANCELLED "Cancelled" · DELIVERY_FAILED "Delivery failed" · EXPIRED "Expired".

| # | Element | Behaviour | Data / states |
|---|---|---|---|
| 13-01 | Logo | → `/` | — |
| 13-02 | Nav Restaurants | → `/` | — |
| 13-03 | Nav Orders (current) | → `/orders` | `aria-current` on `/orders*` |
| 13-04 | Nav Thali Plus | → `/membership` | — |
| 13-05 | Nav Support | → `/support` | — |
| 13-06 | Theme toggle | client | — |
| 13-07 | Avatar | account menu (10-08) | — |
| 13-08 | Breadcrumb "Orders" | → `/orders` | — |
| 13-09 | H1 order code + checkout status pill | data `GET /orders/:checkoutId` | checkout map (In progress acc) |
| 13-10 | Meta "Placed today, 7:42 PM · 2 restaurants · Home, Indiranagar" | data | IST, relative day |
| 13-11 | Live pill | realtime status | live / paused (§3.13) |
| 13-12 | Child label "Delivery 1 · Spice Route" + headline + ETA source line | data | ETA from tracking/order; "Arrival time is a demo estimate" when demo |
| 13-13 | Child status pill | data | childOrder map |
| 13-14 | Map + SIMULATED LOCATION tag | `GET /deliveries/tracking/:childId` (+ realtime) | shown from partner assigned → delivered; tag when simulated; stale >60 s warning |
| 13-15 | Timeline (7 steps + times) | data (child status history) | done/current/future; terminal variants §3.16 |
| 13-16 | Rider row "Ravi · Scooter", "Location updated 3s ago" | data (tracking) | hidden until assigned; relative time ticks |
| 13-17 | Delivery code (4 boxes) | data (child `deliveryCode`) | shown while assigned/picked up/out for delivery; hidden after delivery |
| 13-18 | Cancel order (not drawn) | `POST /orders/child/:childId/cancel` after confirm dialog | only when server marks child cancellable (before accept); ghost-danger button in card header row |
| 13-19 | Rejected card explanation | data (server sentence + reason) | — |
| 13-20 | Refund progress (Initiated / Processing / Refunded) | data (child refund status) | failed → bad variant + "Refund failed — we're retrying" |
| 13-21 | Struck items "1 × Ghee Podi Masala Dosa · ₹180" | data | — |
| 13-22 | Payment card (Paid, Refunded, Refund pending, Net paid, Net after pending refund) | data (order totals) | "Net after pending refund" only while pending |
| 13-23 | Delivering to card | data (address snapshot) | — |
| 13-24 | Get help | → `/support?new=1&orderId=<checkoutId>` (ticket prefilled) | — |
| 13-25 | Reorder | `POST /orders/:checkoutId/reorder` → dialog listing changes (price changes, unavailable, closed) → "Go to cart" | loading |
| 13-26 | Rate hint → Rate control | before delivery: hint text; after DELIVERED: 5 star buttons (24px, `aria-label="Rate 4 of 5"`) → `POST /restaurants/:id/ratings {stars}`; once (then "You rated 4 ★") | per delivered child |

### 5.20 Restaurant owner live orders (kanban) — board 20 (`board-07.png`)

**Route:** `/restaurant/orders`. Shell: restaurant sidebar (KITCHEN). Realtime `owner.order` + polling fallback; chime on new order.
**Layout:** demo strip · row: sidebar + main (`gap:20px`): status banner (conditional) · title row · KPI grid
(`auto-fit minmax(170px)`, gap 10) · kanban (3 columns).

| # | Element | Behaviour | Data / states |
|---|---|---|---|
| 20-01 | Logo + KITCHEN tag | → `/restaurant` | — |
| 20-02 | Restaurant switcher | menu of `GET /owner/restaurants` (name, area, status chip) → set selection (`selection.ts`), refetch; last item "+ Add restaurant" → `/restaurant/onboarding` | initials tile, name, area |
| 20-03 | Nav Dashboard | → `/restaurant` | — |
| 20-04 | Nav Live orders + badge | → `/restaurant/orders` | badge = count of PLACED orders (hidden at 0) |
| 20-05 | Nav Order history | → `/restaurant/orders/history` | — |
| 20-06 | Nav Menu | → `/restaurant/menu` | — |
| 20-07 | Nav Store settings | → `/restaurant/settings` | — |
| 20-08 | Nav Finance | → `/restaurant/finance` | — |
| 20-09 | User row (avatar, "Arjun M.", "Owner") | menu: Account `/account`, Sign out `POST /auth/logout`, Sign out of all devices `POST /auth/logout-all` | `GET /me` |
| 20-10 | Theme toggle | client | — |
| 20-11 | Status banner + CTA | per state: Draft "Continue setup" → `/restaurant/onboarding/:id` · Email pending "Resend email" → `POST /owner/restaurants/:id/resend-verification` (60 s cooldown, daily cap) · Awaiting approval "View submission" → onboarding review step · Rejected "Edit and resubmit" → onboarding · Suspended "Contact support" → `/support?new=1` · Paused "Resume now" → `POST /owner/restaurants/:id/resume` | copy from §3.35 / board script; hidden when approved & open |
| 20-12 | H1 Live orders + open-state chip | data `GET /owner/restaurants/:id/dashboard` `restaurant` | "Open · accepting" ok · "Paused until 3:30 PM" warn · "Closed · opens 6:00 PM" neu |
| 20-13 | Live indicator | realtime status | §3.13 |
| 20-14 | Chime on / off | client preference (localStorage); first enable plays a test chime (unlocks audio) | `aria-pressed`; icon bell / bell-off |
| 20-15 | Pause orders | popover: 15 / 30 / 60 min / custom → `POST /owner/restaurants/:id/pause {minutes}`; when paused label "Resume orders" → `POST …/resume` | loading |
| 20-16…20-19 | KPI: Orders today · Acceptance · Avg. time to accept · Revenue gross / net | `GET /owner/restaurants/:id/dashboard` (`orders.ordersTotal`, `acceptanceRate`, `avgAcceptSeconds` → "1m 12s", `grossPaise`/`netRevenuePaise`) | null/unavailable → "—" + "Stats unavailable · Retry" |
| 20-20 | Column headers + counts | data | New = PLACED; Preparing = ACCEPTED + PREPARING; Ready for pickup = READY_FOR_PICKUP |
| 20-21 | New card header (code, time, customer, masked phone) | data `GET /owner/orders` | — |
| 20-22 | Accept countdown ring | data `acceptBy` | red ≤60 s; at 0 → card replaced by "Auto-rejected — the accept window passed" |
| 20-23 | Items + options + note | data | **Gap:** owner view returns selection ids only (`selections` ids) — needs option names ("Full · Extra raita"); `addOns` names exist |
| 20-24…20-27 | Prep pills 10 / 15 / 20 / 30 min | client select (default = restaurant default or 20) | + "Other…" select with remaining `PREP_TIME_OPTIONS` (25, 40, 45, 60, 90) **(extrapolated)** |
| 20-28 | Reject | client: switch card to reason mode | text `--bad` |
| 20-29…20-32 | Reasons Out of stock / Kitchen busy / Closing soon / Other… | `POST /owner/orders/:id/reject {reason}`; Other → inline textarea (required) + "Reject order" | card → "Rejected · the customer is being refunded" |
| 20-33 | Back (reason mode) | client → normal mode | — |
| 20-34 | Accept · 20 min | `POST /owner/orders/:id/accept {prepMinutes}` → card slides to Preparing | loading; 409 (expired/taken) → toast + refetch |
| 20-35 | Preparing card (code, customer, items, progress "13 of 20 min", partner text) | data (`acceptedAt`, `prepMinutes`/`readyEta`, `deliveryStatus`) | partner text: "Finding partner" / "{Name} assigned" — **Gap:** owner order has `deliveryStatus` but no partner first name |
| 20-36 | Start preparing / Mark ready | first allowed of `allowedTransitions`: PREPARING → `POST /owner/orders/:id/preparing`; READY_FOR_PICKUP → `POST …/ready` | loading |
| 20-37 | Change prep time (not drawn) | ghost xs "Change time" in progress meta → pills popover → `POST /owner/orders/:id/prep-time {minutes}` | ACCEPTED/PREPARING only |
| 20-38 | Ready card pickup code (4 boxes) | data `pickupCode` | — |
| 20-39 | Rider row + delivery chip ("Ravi · at restaurant", Partner assigned) | data `deliveryStatus` (delivery map) | name Gap as 20-35 |
| 20-40 | Card click (not drawn) | opens order detail dialog `GET /owner/orders/:id` (all lines, totals, timeline) | — |
| 20-41 | Empty / ended column states | data | §3.26 |

### 5.30 Delivery partner home — board 30 (`board-08.png`)

**Route:** `/partner`. Shell: partner sidebar (PARTNER). Realtime offers + polling; location posting every ~5 s while online.
**Layout:** demo strip · sidebar + main (`gap:18px`): online card · 2 columns: left `flex:999 1 420px;gap:18px` (offer card,
accepted strip, active delivery card(s)) + aside `flex:1 1 280px;max-width:360px;gap:14px` (Today, Last payout, browser notice).

| # | Element | Behaviour | Data / states |
|---|---|---|---|
| 30-01 | Logo + PARTNER tag | → `/partner` | — |
| 30-02 | Profile card (Ravi Kumar, Scooter · KA03HX4417) | → `/partner/onboarding` (profile & documents) | `GET /partner/profile` |
| 30-03 | Nav Home | → `/partner` | — |
| 30-04 | Nav Delivery history | → `/partner/history` | — |
| 30-05 | Nav Earnings & payouts | → `/partner/earnings` | — |
| 30-06 | Nav Profile & documents | → `/partner/onboarding` | — |
| 30-07 | Partner status chip (Approved) | data (partner map) | non-approved → links to onboarding; home shows a status banner instead of the online card (§7) |
| 30-08 | Theme toggle | client | — |
| 30-09 | Online title + sub | data (`useLocationTracking`) | "You're online" / "Location sharing active · last sent 3s ago" · paused: "Location paused — keep Thali open" (`--warn`) · offline: "You're offline" / "Go online to receive offers. We'll ask for location permission." |
| 30-10 | Online switch (lg) | on: request geolocation → `POST /partner/online` → start posting `POST /partner/location`; off: `POST /partner/offline` | denied → inline explanation; offline blocked with active delivery → message "Complete it, or ask Thali ops to reassign it" (switch stays on) |
| 30-11 | Offer tag "New offer · would be your 2nd delivery" | data `GET /partner/offers` (+ realtime) | "New offer" when not batched; "Offer closed" after end |
| 30-12 | Distance · ~minutes | data | — |
| 30-13 | Offer countdown ring (45 s) | data `expiresAt` | red ≤10 s + urgent; 0 → "Offer expired" |
| 30-14 | Pickup / Drop lines | data (pickup restaurant + area; drop area, "Full address after pickup") | — |
| 30-15 | Batching box | data (batching rules) | only for a 2nd simultaneous delivery |
| 30-16 | Decline | `POST /deliveries/offers/:offerId/reject` | → closed state "Declined" |
| 30-17 | Accept offer | `POST /deliveries/offers/:offerId/accept` | 409 → closed "Taken by another partner"; success → accepted strip + new active delivery |
| 30-18 | Closed offer bar (Offer expired / Declined / Taken by another partner) | data | muted 50px bar |
| 30-19 | Accepted strip: chip + "Added as delivery 2 · head to Green Leaf after your current drop" + Navigate | Navigate → `navigationUrl(lat,lng)` (Google Maps, new tab) | — |
| 30-20 | Active delivery header "Active delivery 1 of N" + code | data `GET /deliveries/active` | 2 deliveries → two cards (or tabs <640) |
| 30-21 | 4-step progress | data (job status → step) | — |
| 30-22 | Destination block (name · label, address, masked phone) | data | pickup phase shows restaurant name/address |
| 30-23 | Navigate | `navigationUrl` to current destination | — |
| 30-24 | Call | `tel:` link **Gap:** only a masked phone is returned — needs a callable/proxy number from the API; hide until provided (restaurant phone for pickup phase likewise) | — |
| 30-25 | Code entry (4 boxes) | pickup phase: "Restaurant's pickup code"; deliver phase: "Customer's delivery code" | attempts left from server; locked after 5 |
| 30-26 | Primary action | by status: "I've arrived" `POST /deliveries/:jobId/arrived` · "Confirm pickup" `POST …/pickup {code}` · "Start delivery" `POST …/start` · "Mark delivered" `POST …/deliver {code}` | disabled until 4 digits; wrong code → attempts message |
| 30-27 | Can't deliver | reason dialog (Customer unreachable / Address not found / Other + text) → `POST /deliveries/:jobId/fail {reason}` | confirm required |
| 30-28 | Today card (6 deliveries · ₹642 earned) | `GET /finance/partner/summary` (today IST) | — |
| 30-29 | Earnings & payouts → | → `/partner/earnings` | — |
| 30-30 | Last payout (₹3,410.00, Paid, UTR · date) | `GET /finance/partner/payouts` (latest) | "Paid" only with UTR; none → "No payouts yet" |
| 30-31 | Browser limits notice | static (`TrackingLimitations`) | — |

### 5.40 Admin overview — board 40 (`board-09.png`)

**Route:** `/admin`. Shell: admin sidebar (OPS). Dense tier. No realtime; "refreshed Ns ago" + Refresh, auto-refresh 30 s **(derived)**.
**Layout:** demo strip · sidebar 224 + main (`padding:24px clamp(16px,2.4vw,32px) 40px;gap:18px`): title row · KPI strip ·
stacked bar card · 2-column panels (`auto-fit minmax(440px)`, gap 14): Needs attention / System health · Recent orders table.

| # | Element | Behaviour | Data / states |
|---|---|---|---|
| 40-01 | Logo + role tag | → `/admin` | tag = sub-role (`SUPER`, `OPS`, `FINANCE`, `SUPPORT`); board shows OPS |
| 40-02 | Search "Search orders, phones…" ⌘K | opens command palette (dialog): query → `GET /admin/orders?q=` (code / phone) results → `/admin/orders/:checkoutId`; "Search users" → `/admin/users?q=` | ⌘K / Ctrl+K shortcut |
| 40-03 | Nav Overview | → `/admin` | — |
| 40-04 | Nav Restaurants + count | → `/admin/restaurants` | count = APPROVAL_PENDING restaurants (`/admin/marketplace/overview`) |
| 40-05 | Nav Partners + count | → `/admin/partners` | pending partners |
| 40-06 | Nav Users | → `/admin/users` | — |
| 40-07 | Nav Catalog | → `/admin/catalog` | — |
| 40-08 | Nav Orders | → `/admin/orders` | — |
| 40-09 | Nav Deliveries + urgent badge | → `/admin/tms` | badge = unassigned jobs (`/admin/delivery/overview`) |
| 40-10 | Nav Support + count | → `/admin/support` | open tickets |
| 40-11 | Nav Finance | → `/admin/finance` | — |
| 40-12 | Nav Audit log | → `/admin/audit` | — |
| 40-13 | Nav Health + dot | → `/admin/health` | red blinking dot if any service down; amber if degraded; none if all up (`GET /admin/health`) |
| 40-14 | User row (NK, Nisha K., "Ops admin · MFA on") | menu: Sign out `POST /auth/logout` | role label from session |
| 40-15 | Theme toggle | client | — |
| 40-16 | H1 "Today at a **glance**" + "Sun, 11 Oct · IST · refreshed 14s ago" | data timestamp of last fetch | — |
| 40-17 | Refresh | refetch all overview queries | icon spins while fetching |
| 40-18 | KPI Orders (42 · 51 child orders) | `GET /admin/orders/overview` | — |
| 40-19 | KPI GMV (₹28,416 · ₹1,204.20 refunded) | `GET /admin/orders/overview` | — |
| 40-20 | KPI Partners online (2 / 2 · 1 on a delivery) | `GET /admin/delivery/overview` | — |
| 40-21 | KPI Unassigned (1 · Open deliveries →) | same; link → `/admin/tms?filter=unassigned` | highlighted (acc-soft) only when > 0 |
| 40-22 | KPI Approvals (3 · 2 restaurants · 1 partner) | `GET /admin/marketplace/overview` + partners; tile click → `/admin/restaurants?status=APPROVAL_PENDING` | — |
| 40-23 | KPI Failed refunds (0 · Nothing to retry) | `GET /admin/finance/refunds?status=FAILED` (count) | >0 → sub link "Retry →" `/admin/finance?tab=refunds&status=FAILED`, value `--bad` |
| 40-24 | Child orders by status bar + legend | `GET /admin/orders/overview` `byStatus` grouped | groups: Delivered · In progress (ACCEPTED…OUT_FOR_DELIVERY) · Placed · Rejected · Cancelled (+ Failed/Expired folded into Cancelled — **ambiguity**, see §8) |
| 40-25 | Needs attention count | data (rows shown) | — |
| 40-26 | Row: Finding a partner · TH-K7Z2MP4Q · "Spice Route · no partner after 3 rounds · 6 min" · **Assign** | Assign → partner picker dialog (online approved partners with distance, `GET /admin/delivery/partners`) → `POST /admin/delivery/jobs/:id/assign {partnerId}` | from `GET /admin/delivery/jobs?status=unassigned` |
| 40-27 | Row: Awaiting approval · Tandoor Tales · "Approve unlocks after business email is verified" · **Approve** (disabled) | enabled when email verified → `restaurantAction(id,'approve')` (`POST /admin/marketplace/restaurants/:id/approve`) with confirm | disabled reason shown in `--warn` text |
| 40-28 | Row: Awaiting approval · Imran K. · Bike · "ID, licence and RC uploaded" · **Review** | → `/admin/partners/:id` | — |
| 40-29 | System health rows (notifications Down + error · payments Degraded + lag · orders/delivery/marketplace Up · identity/gateway/db/redis Up) | `GET /admin/health` | real error text, never a decorative "all healthy" |
| 40-30 | "checked 14s ago" | data | — |
| 40-31 | 3 dead letters · Replay | → `/admin/health#dead-letters` (panel lists items with per-item Replay `POST /admin/notifications/dead-letters/:id/replay`) — **ambiguity:** no bulk replay API | count from `GET /admin/notifications/dead-letters`; hidden at 0 |
| 40-32 | 12 failed notifications · Retry | → `/admin/health#failed-notifications` (per-item retry via `retryNotification`) — same ambiguity | count `GET /admin/notifications?status=FAILED`; hidden at 0 |
| 40-33 | Recent orders: Status: All | dropdown of checkout statuses → refetch `GET /admin/orders?status&from&to&limit=5` | — |
| 40-34 | Recent orders: Today | dropdown Today / Yesterday / Last 7 days | — |
| 40-35 | View all → | → `/admin/orders` with the same filters | — |
| 40-36 | Order rows (×5) | row → `/admin/orders/:checkoutId` | code, customer "Prafful · ••3210", restaurants, checkout pill, paid, refund (pending info / refunded ok / —), placed IST |
| 40-37 | Role gating | FINANCE / SUPPORT: Assign & Approve disabled with tooltip "Your role can't assign deliveries" | from session sub-role |

**Interactive / data-bearing elements catalogued: 292 element IDs in 257 table rows** — per board (IDs / rows): 00 51/43 · 01 24/21 · 02 0 · 10 43/31 · 11 19/16 · 12 20/20 · 13 26/26 · 20 41/32 · 30 31/31 · 40 37/37. Ranged rows (e.g. 10-11…10-21) cover one control per ID.

---
## 6. Responsive rules

Boards are drawn at 1440px. The markup already uses `flex-wrap` + `auto-fit` grids, so most sections reflow naturally;
the rules below are binding where behaviour must change.

Breakpoints (Tailwind defaults): **mobile ≤ 640px** (`max-sm`), **tablet 641–1023px** (`sm`–`md`), **desktop ≥ 1024px**
(`lg`), wide ≥ 1280px (`xl`). Touch targets ≥ 44px on `pointer:coarse` everywhere.

### 6.1 Global
- Page horizontal padding: 24px desktop/tablet, 16px mobile. Containers keep their max-widths.
- Type: clamp()s already scale display sizes. Fixed sizes step down on mobile: page h1 40/34/32/30 → 28px; role-shell
  h1 28/26 → 24px; KPI values 26 → 22px; tracking status headline 26 → 22px; checkout total 28 → 24px.
- Demo strip stays 32px; text may wrap to two lines at ≤360px (allow `height:auto;min-height:32px;padding:6px 16px`).
- Dialogs → bottom sheets on mobile (`Sheet side="bottom"`, `max-height:92dvh`, 16px top radius, drag handle 36×4
  `--line2`), footer actions sticky inside the sheet. Customizer follows this.
- Tables (admin/finance) collapse to stacked cards ≤ 640 (`DataTable` card mode); ≤ 1023 keep horizontal scroll.
- Sticky elements respect `env(safe-area-inset-bottom)`.

### 6.2 Public landing (00)
- Utility bar: ≤ 1023 hide the secondary nav links (move into a footer-like "More" list in the mobile menu); ≤ 640 hide
  "Bengaluru · pilot city", keep demo pill + theme toggle (icon-only segmented: 26px buttons without text).
- Main bar: ≤ 1023 search moves to a full-width second row; ≤ 640 location button collapses to the 34px pin tile +
  truncated value, Offers/Sign in collapse into a 44px menu icon button (sheet), cart button keeps icon + count.
- Hero: columns stack (copy first); hero art `min-height:360px` on tablet, hidden dish discs except the big one on
  mobile, art panel `inset:12px 0`. Address pill wraps: input full row, "Use my location" + "Find food" side by side
  (each `flex:1`).
- Cuisines: single scroll row (already), snap, 16px gap; circles 84px on mobile.
- Doors 4 → 2 (tablet) → 1 (mobile); how-it-works 3 → 1; promise grid 2 → 1; promo pair stacks, `padding:28px`; CTA
  block stacks, button full width.
- Footer 4 → 2 → 1 columns.

### 6.3 Sign-in (01)
- ≤ 1023: the aside moves **below** the form (or is hidden on mobile; show only its 3 points as a compact list under
  the form divider). Form column full width, `max-width:400px` centred.
- Role tabs stay 4 equal segments; at ≤ 360px label font 12.5px.
- OTP boxes: `gap:6px`, height 52px on mobile.

### 6.4 Consumer shell (10–13)
- Header ≤ 1023: row 1 = logo · location (truncated) · bell · avatar; row 2 = full-width search. Orders/theme move into
  the avatar menu ≤ 640. Account ghost nav (board 13) becomes a **bottom tab bar** ≤ 640: Home `/` · Search `/search` ·
  Orders `/orders` · Account `/account` (56px + safe area, `background:var(--card)`, `border-top:1px solid var(--line)`,
  icons 20px + 11px labels, active `--acc-fg`). The cart dock sits **above** the tab bar.
- Discover: filters aside becomes a horizontal pill row under the cuisine band (Veg only · Open now · ₹ ₹₹ ₹₹₹ · Sort
  select as a pill) on ≤ 1023, scrollable; restaurant grid 2 columns tablet, 1 column mobile (cover 140px).
- **Cart dock ≤ 640:** full-width bar pinned to the bottom (`border-radius:16px 16px 0 0` when flush, or 999px floating
  with 12px side margin), per-cart chips hidden (already `hide-sm` ≤ 720), summary + Checkout only. Tapping the summary
  opens the tray as a **bottom sheet** (tabs on top, carts stacked, sticky Checkout button at the bottom of the sheet).
  No hover-open on touch.
- Restaurant page: hero stat cards wrap into a 2×2 grid; category nav becomes a sticky horizontal chip scroller under the
  header (`aria-current` chip = filled `--fg`/`--bg`); dish image 96×80 on mobile, Add button overlaps the same way.
- Checkout ≤ 1023: bill aside drops below the main column and loses `position:sticky`; a **sticky bottom pay bar**
  appears (card bg, top border, `padding:12px 16px + safe area`): "To pay ₹646.20" + Pay button (50px). Address cards
  1 column on mobile; review cards 1 column.
- Tracking ≤ 1023: aside cards move below the child cards; Get help / Reorder stay a 2-column grid. Map height 220px
  mobile. Timeline: 7 columns become a vertical list ≤ 640 (bar → 4px vertical rail on the left, label + time on the
  right, current step bold). Rider row stacks above the delivery code; code boxes stay 44×52.

### 6.5 Role shells (20, 30, 40) — sidebar adaptation
- **≥ 1024:** sidebar as drawn (232 / 224px).
- **641–1023 (tablet, typical counter tablet):** sidebar collapses to a 72px icon rail (logo mark only, nav icons with
  tooltips, badges as 8px dots on the icon, role tag hidden; switcher becomes the restaurant initials tile opening the
  switcher menu). Footer: avatar + theme.
- **≤ 640:** no sidebar. Top bar 56px: logo mark + role tag + context (restaurant name with switcher chevron / partner
  online pill / admin search icon) + avatar menu. Navigation = **bottom tab bar** with the 4–5 primary destinations:
  restaurant: Live orders · Dashboard · Menu · Finance · More (history, settings); partner: Home · History · Earnings ·
  Profile; admin (desktop-first; mobile is best-effort): Overview · Orders · Deliveries · Approvals · More.
- **Kanban (20):** ≥ 1024 three columns; 641–1023 three columns at `minmax(260px)` with horizontal scroll if needed;
  **≤ 640 kanban → segmented tabs** "New (1) · Preparing (2) · Ready (1)" (segmented control §3.4, sticky under the top
  bar); the New tab auto-selects when an order arrives and the tab label pulses. Card actions stay full width; prep pills
  4 columns (44px tall). KPI tiles 2×2.
- **Partner (30):** phone-first — single column; the online card becomes a sticky top block (switch right); offer card
  appears as a **bottom sheet** that slides up over the active delivery when a new offer arrives (countdown visible,
  Decline / Accept full-width 50px), and collapses after action; aside cards (Today, Last payout, notice) move below the
  active delivery. Code entry boxes 52×60 keep size (thumb-friendly); primary action becomes a sticky bottom button.
- **Admin (40):** KPI strip 6 → 3 (tablet) → 2 (mobile) columns (borders: right + bottom); panels stack; tables →
  cards ≤ 640.

---

## 7. Extrapolation guide — undrawn screens

Rule: keep today's information architecture (routes and content from `docs/ui-redesign-context.md` §2–§7) and rebuild
each screen from the patterns below. Never invent data; every number comes from the API, every action has an endpoint.

### 7.1 Shared page patterns
- **Page header (role shells):** h1 (Bricolage 800, 26–28px) + optional accent word + inline status chip + live indicator;
  right-aligned actions (outline buttons, 40px; primary for the single main action). Sub-line 13px `--fg3` (date, IST,
  "refreshed Ns ago"). Map to `PageHeader`.
- **Section card:** `.card` with header row (`padding:14px 16px;border-bottom`), title (h2 14.5–15px) + count/meta, body
  list rows `padding:12px 16px` or a table. Consumer cards use `padding:18px 20px` and 16px radius.
- **List row:** status chip (left) · primary text 500 13.5–14.5px + secondary 12.5–13px `--fg3` · right: amount or one
  action button. Rows link to detail.
- **Forms:** single column `max-width:560px` (consumer) / two-column grid at ≥ 1024 for admin editors; labels 500 14px;
  inputs app tier; helper 13px; sticky `FormActions` bar on long forms (card bg, top border). Validation inline per field.
- **Filters:** filter pills row + select(s) + date range, above lists; selected filters reflected in the URL.
- **Detail pages:** breadcrumb (13px) → title row (mono code for orders/tickets, display name otherwise) + status chip →
  two columns (main `flex:999 1 560px`, aside `flex:1 1 320px;max-width:380px`) like board 13.
- **Money panels:** label/value rows (`.row` 14px, label `--fg3`), divider, emphasised total (600 22px). Negative values
  `−₹` in `--ok` (discounts) or `--info` (pending refunds).
- **Wizards (onboarding):** stepper bar (§3.16, N columns) at top with step labels; one card per step; footer actions
  Back (ghost) / Save & continue (primary); review step lists missing fields as rows with "Fix" link-buttons.
- **Empty / error / loading:** §3.31–3.32 in the same footprint as the content.

### 7.2 Consumer (shell: consumer header + account nav; glow background)
| Screen | Build from |
|---|---|
| `/search` | Board 10 grid + header search filled; results = restaurant cards with matched dish lines; empty: "No matches for "…" that deliver to Home". |
| `/cart` (page) & cart drawer | Tray slot pattern (§3.22) per restaurant as `.card`s, stacked; "Delivered separately" note; group subtotal; footer = items subtotal + "Proceed to checkout" primary (50px pill). Drawer = right sheet 440px (bottom sheet mobile). Empty: illustration `cuisine-all.svg` 72px + "Your cart is empty" + "Browse restaurants". |
| `/checkout/status/:id` | Centered card (`max-width:560px`) on glow: pending "Confirming your payment…" with spinner + skeleton child list; Placed → h1 "Order placed" (accent "placed."), per-restaurant child rows with chips + "Track order" primary → `/orders/:id`; Failed retryable → `--bad` explanation box + "Try payment again"; Expired → neutral box "This checkout expired — your cart is still saved" + "Back to cart"; Cancelled → neutral "This order was cancelled". |
| `/demo-pay/:intentId` | Centered card; demo strip + big label "DEMO PAYMENT — no real money" (mono, `--warn-bg`/`--warn` pill); amount (600 28px) + order ref mono; buttons "Simulate success" (primary) / "Simulate failure" (danger-outline). |
| `/orders` | List of order cards (`.card`, padding 16–18px): mono code + date (IST) + checkout chip; restaurants with per-child chips (app tier); right: total paid (600 15px) + refund line (`--info` pending / `--ok` refunded); item count; row → `/orders/:id`; Load more (`Pagination`). |
| `/account` | Section cards: Profile (name input, phone read-only mono with "Verified" ok chip, email optional), Notifications (4 `Switch` rows md), Sessions ("Sign out" ghost, "Sign out of all devices" danger-outline with confirm). |
| `/account/addresses` | Address cards (§3.24) in a grid, each with "Edit" / "Set default" / "Delete" ghost xs actions; "Add new address" dashed card; form dialog with Leaflet pin + fields; limit 10. |
| `/membership` | Plan cards (marketing-like `.card` radius 16, `padding:24px`): name (Bricolage 20), price (600 28px), duration, benefits list with ok ticks, terms (visible, 13px) + "Buy" primary; current membership card at top (Active chip, valid till, "3 of 5 free deliveries left" progress bar §3.17); Buy disabled with reason while active; history table. |
| `/support`, `/support/:ticketId` | List rows (ticket chip, subject, last update); create form (subject, category select, message textarea, optional order select); thread = message bubbles (customer: `--acc-soft` right-aligned; support: `--card` with border, left), reply box sticky bottom. |
| `/notifications` | List rows: unread 8px `--acc` dot + title 500 + body 13px + relative time; row links to target; "Mark as read" ghost xs; "Mark all as read" header action. |
| Location picker | Dialog/sheet: "Use my current location" outline button (40px, crosshair icon) · Leaflet map with centre pin (chili pin glyph) · saved addresses as address cards · confirm primary. Outside area: `--warn-bg` notice "We don't deliver here yet". |

### 7.3 Restaurant owner (shell: KITCHEN sidebar; status banner always on top of main)
| Screen | Build from |
|---|---|
| `/restaurant` Dashboard | Title "Today at **Spice Route**"; KPI tiles (owner style) for orders, acceptance, avg accept, revenue; cards: Rating (★ avg (count) or "New"), Menu health (items, unavailable count, low-stock list rows with "Update stock"), Open state card with Pause/Resume. Stats unavailable → "Order stats unavailable" + Retry (never zeros). |
| `/restaurant/orders/history` | Filter pills (Delivered · Rejected or cancelled · Delivery failed · In progress) + date; dense table (code mono, date, child chip, total, refund chip); row → order detail dialog (kanban card content, read-only). |
| `/restaurant/menu` | Two columns: category list (like board 11 `.cat` links with counts + reorder up/down icon buttons + active switch) | items list rows (veg mark, name, price, stock "12 left · 3 reserved" mono, availability `Switch` md, Edit). Item editor = sheet/dialog: fields + image picker + customization group editor (group cards with min/max inputs and option rows). |
| `/restaurant/settings` | Section cards: Hours (weekly editor rows: day, open/close time inputs, "+ add slot", overnight hint), Pause (15/30/60 pills + custom), Profile fields, Delivery radius, Packaging fee, Settlement (masked "Account ending 9012", "Update" opens form). |
| `/restaurant/finance` | KPI tiles (Earnings, Commission, Refunds/adjustments, Balance, Available for payout highlighted acc-soft); Ledger table (type chip-less text, order code mono, amount ± coloured); Payouts table (status chip, UTR mono — "Paid" only with UTR). |
| `/restaurant/onboarding[/:id]` | Wizard pattern (§7.1) with 7 steps; uploads show progress bars (§3.17) and file chips; settlement step shows only last-4 after save; review lists missing items with Fix links. Uses sign-in glow page without sidebar until the restaurant exists. |

### 7.4 Delivery partner (shell: PARTNER sidebar / mobile bottom tabs)
| Screen | Build from |
|---|---|
| `/partner/history` | List rows: date (IST), restaurant, distance mono, delivery chip, earning (600, right); filter by date range; Load more. |
| `/partner/earnings` | Today/This week KPI tiles; ledger table; payouts table (UTR rule) — same as restaurant finance. |
| `/partner/onboarding` | Wizard: Profile → Vehicle (type as 4 option cards bike/scooter/bicycle/car + registration input) → Documents (upload rows: ID, licence, RC per vehicle) → Submit; status banner pattern for Awaiting approval / Rejected (reason, Resubmit) / Suspended; vehicle locked under review (disabled with reason). Non-approved partners see this banner on `/partner` instead of the online card. |

### 7.5 Admin (shell: OPS sidebar, dense tier)
| Screen | Build from |
|---|---|
| `/admin/login` | Board 01 with Admin tab; MFA setup screen = same left column: steps card with mono otpauth URI (copy button), manual secret key (mono, grouped by 4), 6-box code entry, "Enable MFA". |
| `/admin/restaurants`, `/admin/partners` | Filter pills by status (with counts) + search; dense table (name, area, status chip, email verified ok/warn chip, submitted IST); detail page: two columns — onboarding data cards + documents list (file rows with "Open" via short-lived link, "Verify" outline xs, preview dialog) | aside: status history timeline (vertical list), actions card (Approve primary — disabled with reason before email verification; Reject / Suspend danger-outline with reason dialog; Reinstate outline). |
| `/admin/users` | Search + table (name, phone mono, roles as neu chips, status chip, Block/Unblock with reason dialog); create admin user dialog (SUPER only). |
| `/admin/orders`, `/admin/orders/:id` | Search bar (code/phone/restaurant) + status/date filters + table like board 40 "Recent orders"; investigation = board 13 layout in dense tier: per-child cards with timeline + events list (mono timestamps), payment & refunds cards, delivery card; actions "Cancel child with refund" (dialog with amount ≤ refundable, validated) and "Change status" (reason). |
| `/admin/tms` | Tabs (segmented): Unassigned · Exceptions · Active; table of jobs (code, restaurant, age, rounds, status chip) with Assign/Reassign (partner picker dialog: online approved partners sorted by distance, km mono), Unassign, Mark failed (reason); demo-only "Simulate movement" button labelled DEMO. |
| `/admin/catalog` | Segmented tabs: Coupons · Banners · Cuisines · Plans · Service areas; each a table + editor sheet. Service areas: Leaflet polygon editor (corner markers, "Add corner at map centre", lat/lng inputs), fee rule fields (base fee, base km, per-km, max, minimum order). |
| `/admin/support[/:id]` | Queue table (status chip, priority chip warn/bad, assignee, age) + ticket thread page (board-7.2 thread pattern) with status select and reply. |
| `/admin/finance` | Segmented tabs: Refunds (status filter, Retry on failed) · Manual refund (pick payment → amount ≤ refundable) · Balances · Payouts (Create → Confirm with UTR input mono validated by `UTR_PATTERN` → Paid; Mark failed) · Payments search. |
| `/admin/audit` | Filters (actor, action, target, date) + dense table (time IST mono, actor, action, target link, summary, IP mono). |
| `/admin/health` | Board 40 "System health" card full width (per service rows with real error text, DB/Redis, event lag), then panels: Dead letters (rows + Replay outline xs), Failed notifications (rows + Retry), provider error counts, "last checked" + Refresh; demo-only fail-mode switch labelled DEMO. Never a decorative "All systems healthy". |

---

## 8. Ambiguities, gaps and decisions taken

1. **Two token dialects in the export** (boards 00/02 vs app layer) — resolved: app layer values are canonical (§1.1).
2. **Status tones** differ from today's `StatusPill.tsx` for delivery PICKED_UP/OUT_FOR_DELIVERY (→ info),
   restaurant/partner APPROVAL_PENDING (→ info) and health label ("Up"). Board 00 shows "Refunded ₹218.10" as an info
   chip while refund SUCCEEDED is success elsewhere — kept **success**; treat board 00's chip as a sample.
3. **Countdown red threshold:** board 02 says "<60 s"; board 30 code uses ≤10 s for the 45 s partner offer. Decision:
   60 s for restaurant accept windows, 10 s for partner offers.
4. **`/` routing** (landing vs discover) — decision: landing when no location, discover when set; `/welcome` alias added.
5. **Backend gaps** (wire or hide; no dead UI): no geocoding for free-text address (00-14); public offers page/coupon
   list visibility (00-10); `/terms`, `/privacy` pages (00-49/50); partial checkout "Checkout only {restaurant}"
   (10-40); owner order view lacks option names (20-23) and partner first name (20-35/39); partner "Call" needs a
   callable/proxy number (30-24); admin password reset (01-14); bulk dead-letter replay / bulk notification retry
   (40-31/32 → navigate to Health panels instead).
6. **Stacked bar groups** (40-24): design shows 5 groups; statuses DELIVERY_FAILED / EXPIRED / PAYMENT_FAILED are folded
   into "Cancelled" unless product wants a 6th "Failed" (`--bad`, would duplicate Rejected's colour).
7. **% OFF badge and "New" restaurant** — "% OFF" renders only if the API exposes a restaurant-level offer (none today);
   "New" = rating count < 5 (existing server rule).
8. **"In cart · N" behaviour** on the dish row is not specified by the board (static span) — decision in §3.23.
9. **Dark dock colour:** board 10 inverts (`--fg` bg) which turns light in dark mode; board 02 dark sample uses a card
   bar — decision: card bar in dark (§3.22).
10. **Sandbox banner** is not drawn — extrapolated in §3.12.
11. **Fonts:** the export loads Bricolage 600/700/800 and Figtree 400–800 from Google; only Bricolage 800 is used. The
    variable fontsource packages cover all weights in one file each.
