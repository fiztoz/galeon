# Design System: Galeon

> **Tagline:** Sail your cloud.  
> **Product:** Dense desktop storage client (Rust + Tauri) — a cockpit-style explorer for S3, SFTP, and FTP, not a marketing landing page.  
> **Audience for this file:** Coding agents and humans implementing UI. Prefer tokens and roles over implementation dumps. Brand assets and logo system live in [`branding/BRANDING.md`](branding/BRANDING.md); CSS variables live in `src/index.css`.

---

## 1. Visual Theme & Atmosphere

Galeon is a **utility desktop cockpit**, not a SaaS marketing site. The UI should feel like a calm instrument panel on a night bridge: dark zinc chrome, one clear accent for “what you can act on,” and gold only when something is *in motion*.

**Mood:** Confident, calm, precise. Oceanic depth without costume-nautical chrome. No pirate fonts, no rope textures, no wave illustrations in the app chrome.

**Density:** High. Explorer tables, transfer queues, and inspector panes must pack information. Prefer compact row heights, tight sidebars, and progressive disclosure over generous marketing whitespace.

**Variance:** Moderate. Surfaces stay in the zinc scale; interaction and motion use a deliberately small accent set so status is readable at a glance.

**Light model:** Flat-to-subtle dark UI. No glassmorphism soup, no multi-stop rainbow gradients on chrome. Sail gradients belong on the **logo mark**, not on panels and buttons.

**Platform posture:** Keyboard-first desktop app. Every primary action has a keyboard path; mouse is enhancement. Instant feedback under ~100 ms for local UI; long work lives in the transfer drawer, never blocking the explorer.

**What “premium” means here:** Quiet restraint — correct contrast, stable columns (`tabular-nums`), zero decorative noise, one accent doing real work.

---

## 2. Color Palette & Roles

### Brand accents (semantic)

| Token | Hex | Role |
|---|---|---|
| **Abyss** | `#0C2233` | Brand dark — hull/wordmark territory, marketing surfaces, occasional branded panels. Not the default app canvas. |
| **Gale Teal** | `#2DD4BF` | **Primary accent (max one).** Interactive: primary buttons, links, selection, focus rings, “connected,” healthy/ready states. |
| **Deep Current** | `#0E7490` | Teal’s pressed/hover depth; gradient endpoint with Gale Teal on brand mark sails only. |
| **Doubloon** | `#F5A524` | **Motion & metrics only.** Active transfer progress, speed readouts, “in progress” badges. Not general CTAs. |
| **Foam** | `#F8FAFC` | High-contrast light text/icons on dark panels when zinc-100 is not enough. |

### App chrome (utility desktop)

| Token | Hex | Tailwind | Role |
|---|---|---|---|
| **Chrome bg** | `#09090b` | `zinc-950` | App shell / body background. Prefer this over pure black. |
| **Chrome sidebar** | `#18181b` | `zinc-900` | Side rails, drawers, secondary panes. |
| **Chrome border** | `#27272a` | `zinc-800` | Dividers, input borders, panel seams. |
| **Chrome elevated** | `#27272a` → `#3f3f46` | `zinc-800` / `zinc-700` | Hover rows, raised controls, scrollbar thumb. |
| **Primary text** | `#fafafa` / `#f4f4f5` | `zinc-50` / `zinc-100` | Body copy on dark chrome. |
| **Muted text** | `#a1a1aa` | `zinc-400` | Secondary labels, timestamps, empty-state hints. |
| **Disabled** | `#52525b` | `zinc-600` | Inactive controls and placeholder chrome. |

### System semantics

| State | Hex | Role |
|---|---|---|
| **Success** | `#34D399` (`emerald-400`) | Verification done, copy success, non-destructive completion. |
| **Warning** | `#F59E0B` (`amber-500`) | Overwrite risk, SSL bypass, caution — distinct from Doubloon progress. |
| **Danger** | `#EF4444` (`red-500`) | Failed transfers, destructive confirmations, validation errors. |

### Theme modes (dark / light)

Dark is the default and is expressed by the **absence** of `data-theme` on
`<html>`; light is `html[data-theme='light']`. Mode is `system | dark | light`,
persisted in `app_settings.json`, defaulting to `system` (which follows
`prefers-color-scheme` live). An unknown stored value resolves to `system`, so a
settings file from a newer build can never produce an unrenderable state.

Mechanism: components style surfaces with raw Tailwind `zinc-*` utilities, and v4
compiles each one to `var(--color-zinc-N)` — including alpha forms, which land
inside `@supports (color: color-mix(...))` and so also read the variable. The
light theme therefore re-skins the whole app by re-declaring the scale once, and
hover/raised/hairline *ordering* survives because the tiers stay monotonic.

The light scale is **not** a mirror of the dark one. Tiers 100–600 are used only
as text in this codebase, so they receive real dark values that hold WCAG AA on a
light page (4.63:1–19.06:1); 700–950 are surfaces and borders.

Two roles a variable swap cannot separate, so they are named tokens that do not
flip with the scale:

| Token | Value | Why it must not flip |
|---|---|---|
| `--color-on-accent` | `#09090b` | Text sitting **on** Gale Teal / Doubloon. Near-white on Gale Teal is 0.56:1 — unreadable. Use `text-on-accent` on any accent-filled control; do **not** reuse `text-zinc-950`, which is the page background and *has* to flip. |
| `--color-raised` / `--color-raised-hover` | `#3f3f46` / `#52525b` | Secondary buttons. Their hover lift cannot ride the zinc 700/600 steps, because those same steps are the dim *text* tiers — inverting them for text makes hover go dark instead of light. |

Modal scrims stay `bg-black/50` in both themes (a dark scrim is correct over a
light page). `color-scheme` is set per theme so inputs, scrollbars, and native
selects follow.

Requires `color-mix` (WebKit 16.2+). On an older WebKit the alpha utilities fall
back to their baked dark literal — light mode degrades to dark-tinted panels over
a light page, still legible.

### Functional rules (agents must obey)

1. **One primary interactive accent:** Gale Teal. Do not invent a second “brand purple” or neon secondary CTA.
2. **Doubloon ≠ CTA.** Gold means throughput / progress / live metrics. A gold solid button for “Connect” is wrong; a gold progress bar for an active upload is right.
3. **Chrome stays zinc.** Resist new hue families on panels. Abyss is brand ink, not a free-for-all navy theme.
4. **Never pure black `#000000`** for UI surfaces — in dark use `zinc-950` (`#09090b`). Prefer a semantic token (`bg-raised`, `--app-bg`) over a raw step when the element is a surface, so it follows the theme.
5. **Never violet / fuchsia / neon purple** for accents, focus, or selection (legacy Cyberduck-adjacent habits are banned).
6. **Teal = interactive or healthy. Gold = in motion.** Keep that mental model in every screen.
7. Text contrast: WCAG AA (4.5:1) for body text in **both** themes. In dark prefer Foam/zinc-100 on zinc-900+; in light the same utilities resolve to near-black on `#fafafa`. Never hardcode a text color that assumes one theme — and use `text-on-accent` for text on an accent fill.
8. **Only use real Tailwind steps.** `zinc-850` / `zinc-750` are not steps; v4 emits no CSS for them and the styling silently disappears.

---

## 3. Typography Rules

Product fonts (already in the app — do not invent substitutes):

| Role | Family | Weight / features | Use |
|---|---|---|---|
| **Display** | **Space Grotesk** | 600, tracking ~`0.06em` on wordmark | App title, empty-state brand moments, connect-screen headers. Prefer for display, not dense table body. |
| **UI body** | **Inter** | 400 / 500 / 600 | Default product UI: labels, menus, forms, explorer chrome. This is product reality — keep it. |
| **Mono / technical** | **JetBrains Mono** | Regular | Endpoints, keys, ETags, presigned URLs, logs, metadata keys. |

### Rules

1. **Space Grotesk for display identity; Inter for the working surface.** Do not set entire dense explorers in display type.
2. **Metrics must not jitter.** Speeds, percentages, sizes, counts, durations → `tabular-nums` (`.metric-text` or equivalent). Prefer Inter with `"tnum" 1`; mono is acceptable for technical strings.
3. **Wordmark:** title case “Galeon”, never ALL CAPS or pirate script.
4. **Hierarchy in dense UI:** section headers ~14–16px medium; body ~13–14px; table cells slightly tighter; captions muted zinc-400. Avoid oversized marketing H1s inside the explorer shell.
5. **No serif, script, or “nautical costume” fonts** anywhere in product UI.

---

## 4. Component Stylings

Styling intent, not a component API dump. Implement with Tailwind + tokens in `src/index.css`.

### Buttons

- **Primary:** Gale Teal fill (`#2DD4BF`), dark text or deep-contrast label; hover/pressed deepen toward Deep Current (`#0E7490`). One primary per view region.
- **Secondary / ghost:** Transparent or zinc-800 fill, zinc border, zinc text; teal only on hover border/text if interactive emphasis is needed.
- **Destructive:** Red-500 fill or outline; never teal for delete.
- **In-progress affordances:** Doubloon on progress UI, not on the button that *started* the job (that button stays teal or neutral).

### Inputs & forms

- Zinc-900/800 fields, zinc-800 borders, teal focus ring.
- **Progressive disclosure:** default connection forms stay short; advanced protocol options expand on demand.
- Validation: danger text + border; no rainbow error themes.

### Explorer / tables

- Virtualized lists; compact rows; zebra only if it improves scanability without adding hue.
- Selection: Gale Teal tint or left rail — never purple highlight.
- Columns for size/date/speed: right-align + tabular figures.
- Icons: Lucide-style outline set at 14–16px in toolbars; brand mark only where brand identity is intended.

### Navigation chrome

- Sidebar: zinc-900 on zinc-950 shell; active item teal indicator (text or bar).
- Transfer drawer: secondary surface; badge count / live speed in Doubloon when active.
- Command palette: same dark chrome; selected row teal accent; no frosted marketing blur.

### Feedback

- Toasts: quiet zinc panels; success emerald, error red, progress Doubloon.
- Empty states: short copy, one primary teal action, optional Space Grotesk title — no illustrations competing with the mark.

### Brand mark in UI

- Use the adaptive logo tiers from [`branding/BRANDING.md`](branding/BRANDING.md) (primary / compact / glyph).
- Dark UI → dark-background mark variant. Do not recolor sail paths ad hoc in product chrome.

---

## 5. Layout Principles

1. **Cockpit, not canvas.** Fixed app shell: sidebar + main explorer + optional inspector + bottom transfer strip. Content areas scroll; chrome stays put.
2. **Density over decoration.** Prefer information density that power users expect from Cyberduck-class tools. Marketing hero spacing is wrong inside the app.
3. **Progressive disclosure.** Show the minimum to connect and browse; reveal metadata, advanced SSL, storage class, etc., when asked.
4. **Keyboard spatial model.** Focus order follows reading order; lists are arrow-navigable; primary actions have shortcuts; ⌘K-style command palette for power jumps.
5. **Stable geometry.** Avoid layout shift when metrics update (tabular nums, reserved badge widths).
6. **Pane discipline.** Dual-pane / inspector modes split space predictably; no floating card chaos.
7. **Scrollbars:** thin, zinc thumb (`galeon-scrollbar` pattern) — utility, not a design feature.

---

## 6. Motion & Interaction

**Motion budget: restrained.** This is a desktop workhorse, not a consumer social app.

| Interaction | Expectation |
|---|---|
| Click / key local feedback | Immediate (<100 ms visual response) |
| Hover | Subtle zinc lift or teal border — no bounce |
| Selection | Instant teal state, no long fades |
| Panel open/close | Short ease (≈100–200 ms); optional |
| Progress | Doubloon bar/speed updates smoothly; avoid gratuitous shimmer |
| Success | Brief emerald confirm; no confetti |

**Do:** status that communicates throughput and health.  
**Don’t:** parallax, large spring physics, looping gradient animations, attention-stealing loaders on every row.

Transfers and sync are the place motion *earns* its keep — progress, speed, queue state — always in Doubloon/teal semantics above.

---

## 7. Anti-Patterns (Banned)

### Color & chrome

- ❌ Pure black `#000000` app backgrounds (use zinc-950 `#09090b`)
- ❌ Violet, fuchsia, neon purple accents or focus rings
- ❌ Rainbow gradients on panels, buttons, or sidebars
- ❌ Doubloon as primary CTA fill
- ❌ Multiple competing accent hues on one screen
- ❌ Glassmorphism / heavy blur as default chrome

### Typography & brand costume

- ❌ Serif, script, or pirate/nautical display fonts
- ❌ ALL-CAPS wordmark or logo lockups
- ❌ Setting dense tables in Space Grotesk
- ❌ Metrics without tabular figures (jittering columns)

### UX noise

- ❌ Marketing landing layouts inside the explorer (huge heroes, feature cards)
- ❌ Nautical UI copy for core objects (“cargo”, “the hold”) — files are files, buckets are buckets
- ❌ Cute error copy during failures; state what happened and what to try
- ❌ Mouse-only critical paths
- ❌ Blocking modals for long transfers (use the transfer drawer)
- ❌ Decorative illustrations that fight the Gale Sail mark

### Logo misuse

- ❌ Rotating the ship, removing the pennant, or recoloring sails arbitrarily
- ❌ Light mark on dark chrome (use the dark variant)
- ❌ Full primary mark below ~32px (switch compact/glyph)

---

## Reference

| Resource | Purpose |
|---|---|
| [`branding/BRANDING.md`](branding/BRANDING.md) | Name story, logo system, voice, asset files |
| `src/index.css` | Live CSS tokens (`--color-*`, fonts, scrollbar) |
| [`docs/DIRECTION.md`](docs/DIRECTION.md) | Product pillars and non-goals |

When brand identity and UI chrome conflict, **product chrome stays zinc-dark and dense**; brand color shows up as Gale Teal interaction and Doubloon motion — not as a themed skin over every surface.
