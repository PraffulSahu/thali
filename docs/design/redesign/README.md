# Masala UI redesign — design sources

Tracked copy of the Claude Design export the 2026-10 redesign was built from (implemented on `feat/ui-redesign`).

- `design-spec.md` — tokens, components, per-board element tables (§5), responsive rules, extrapolation for undrawn screens.
- `design-spec-overrides.md` — controller rulings that win over the spec's fallbacks (real backend controls instead of hidden ones).
- `gap-analysis.md` — design element → endpoint matrix and the backend contracts added for the redesign.
- `screens/board-00..09.png` (+ `b00-*.png` crops of the public board) — rendered boards.
- `illustrations/` — the SVG art shipped with the export (also used under `apps/web`).

Where the app differs from these files, the app, [LLD §10.1](../../03-LLD.md) and ADR-034..041 in [04-ADR.md](../../04-ADR.md) are authoritative.
