# Galeon — Brand Guidelines

## The name

**Galeon** = **Gale** × **Galleon**.

- A **gale** is wind at force — lightweight, invisible, fast.
- A **galleon** was the heavy-cargo workhorse of the age of sail — built to carry treasure across oceans, reliably.

Together: *a vessel built to move heavy cargo at the speed of wind.* That is exactly the product promise — a featherweight client (Rust + Tauri) that moves serious data.

**Tagline:** `Sail your cloud.`

Alternates (for stores/landing pages): *"Heavy cargo. Light as a gale."* · *"Fast as a gale, built like a galleon."*

---

## The mark: "Gale Sail"

A galleon reduced to its essence — mast, two wind-filled sails, hull — pushed by three gale strokes. The pennant flying at the masthead is **Doubloon gold**: the nod to treasure ships.

### Design Philosophy

The mark follows **geometric essentialism** — each element is a primitive shape (triangles, rectangles, curves) that composes into a recognizable vessel at any size. The 2025-2026 design language favors "restrained dimension": subtle gradients that suggest tactile depth without full skeuomorphism.

What it encodes:

- **Gale strokes (gold, left):** speed, throughput, data in motion.
- **Sails (teal gradient):** the cloud harnessed — wind doing the work. The 3-stop gradient (light → mid → deep) suggests fabric catching light, adding tactile depth.
- **Hull (dark, wide):** the cargo hold — robustness, capacity.
- **Pennant (gold):** the treasure ship heritage — Doubloon gold persists across all modes.
- The waterline gap between sails and hull keeps the mark light and lets it float on any background.

### Logo System (Adaptive Hierarchy)

Modern desktop apps require a **logo system**, not a single static mark. Galeon uses three tiers:

| Tier | File | Use Case | Size Range |
|------|------|----------|------------|
| **Primary** | `galeon-mark.svg` | App icon source, splash screens, marketing, README | 128px+ |
| **Compact** | `galeon-mark-compact.svg` | Dock icons, sidebar, toolbar, status indicators | 32–64px |
| **Micro** | `galeon-glyph.svg` | Favicon, menu bar, 16px contexts, tiny badges | 16–24px |

**Compact mark:** Drops the jib sail and reduces gale strokes to 2 — maintains the mast + main sail + gold accent silhouette.

**Micro mark:** Absolute minimum — single sail + mast + gold accent. Reads as "ship" even at 16px.

### Files

| File | Use |
|---|---|
| [galeon-mark.svg](logo/galeon-mark.svg) | Primary mark on **light** backgrounds |
| [galeon-mark-dark.svg](logo/galeon-mark-dark.svg) | Primary mark on **dark** backgrounds |
| [galeon-mark-compact.svg](logo/galeon-mark-compact.svg) | Compact mark for 32–64px contexts |
| [galeon-glyph.svg](logo/galeon-glyph.svg) | Micro mark for 16–24px contexts |
| [galeon-logo-horizontal.svg](logo/galeon-logo-horizontal.svg) | Full lockup (mark + wordmark) for README, site, docs |
| [galeon-app-icon.svg](logo/galeon-app-icon.svg) | App icon source — feed to `bun run tauri icon` |

---

## macOS Liquid Glass Compatibility (2025-2026)

Apple's WWDC 2025 introduced **Liquid Glass** — a translucent, light-refracting design language for macOS Tahoe 26 and iOS 26. App icons must work in four appearance modes:

| Mode | Description | Galeon Strategy |
|------|-------------|-----------------|
| **Light** | Standard light background | Use `galeon-mark.svg` — Abyss hull/mast on light |
| **Dark** | Dark background | Use `galeon-mark-dark.svg` — Foam hull/mast on dark |
| **Tint** | Color tint overlay | Mark silhouette persists; teal sails tint naturally |
| **Clear** | Translucent/glass | Mark on transparent background; foreground silhouette must be crisp |

### Liquid Glass Design Rules

1. **Transparent backgrounds preferred** — The mark should float, not sit on an opaque rectangle
2. **Clear foreground silhouette** — Sails/mast must read against unpredictable backdrops
3. **Doubloon gold persists** — The pennant and gale strokes maintain brand recognition across all modes
4. **Specular highlight** — A subtle white-to-transparent gradient on sails suggests light refraction
5. **No drop shadows** — macOS provides its own depth; flat or subtly dimensional marks work best

### App Icon Generation

```sh
# Generate full Tauri icon set from the source SVG
bun run tauri icon branding/logo/galeon-app-icon.svg

# For Liquid Glass variants, export with transparent background:
# 1. Export galeon-mark.svg as PNG at 1024px
# 2. Use macOS Icon Composer to generate .icns with appearance variants
```

---

## Color

Brand colors are chosen to sit on the existing zinc-dark UI (the app already uses `zinc-800/900` surfaces with a `teal-400` accent — the brand formalizes that).

### Brand Palette

| Name | Hex | Tailwind | Role |
|---|---|---|---|
| **Abyss** | `#0C2233` | custom | Brand dark — hull, wordmark, marketing backgrounds |
| **Gale Teal** | `#2DD4BF` | `teal-400` | Primary accent — actions, links, selection, "connected" |
| **Deep Current** | `#0E7490` | `cyan-700` | Secondary accent — hover/pressed states, gradients |
| **Doubloon** | `#F5A524` | ~`amber-500` | The treasure color — active transfers, speed metrics, highlights |
| **Foam** | `#F8FAFC` | `slate-50` | Light surfaces / text on dark |
| **Ink** | `#091520` | custom | True black for text on light, maximum contrast |
| **Parchment** | `#FAF8F5` | custom | Warm paper white — tactile warmth, complements Doubloon |
| **Zinc scale** | — | `zinc-100…950` | App chrome, exactly as today |

### Semantic System Colors

| State | Tailwind | Hex | Role |
|---|---|---|---|
| **Success** | `emerald-400` | `#34D399` | Verification completed, success toasts |
| **Warning** | `amber-500` | `#F59E0B` | Overwrite warnings, SSL bypass |
| **Danger** | `red-500` | `#EF4444` | Failed transfers, delete confirmations |
| **In Motion** | `doubloon` | `#F5A524` | Active transfers, progress bars, speed readouts |

### Color Guidance

- **Teal** means *interactive or healthy*: buttons, links, connected profiles, success.
- **Gold** means *in motion*: progress bars, transfer speed readouts, the transfer drawer badge. (A gold progress bar is the brand showing up where it matters most.)
- **Ink** for text on light backgrounds — deeper than Abyss, maximum WCAG contrast.
- **Parchment** for warm light surfaces — subtle warmth that complements Doubloon gold.
- Keep zinc for chrome. Resist adding more hues; two accents is the brand.

### Palette Differentiation vs. Competitors

| Product | Palette | Galeon Advantage |
|---------|---------|------------------|
| Dropbox | Blue + chaotic accents | Galeon is cohesive, not chaotic |
| Cyberduck | Bright yellow-green | Galeon is sophisticated, not playful |
| Mountain Duck | Green + earth tones | Galeon's oceanic depth is more premium |
| Transmit | Red truck (mascot) | Galeon's mark is geometric, not illustrative |
| iCloud | Blue gradient (generic) | Galeon's teal+gold is distinctive |

**Galeon's palette is more sophisticated and cohesive than all competitors** — the oceanic depth + gold accent is genuinely distinctive in the cloud storage category.

---

## Typography

| Role | Font | Notes |
|---|---|---|
| Wordmark / display | **Space Grotesk** | Geometric but warm; 600 weight, slight tracking (+6%) |
| UI | **Inter** | Enable `tabular-nums` for sizes/speeds so columns don't jitter |
| Data / mono | **JetBrains Mono** | Keys, endpoints, logs, presigned URLs |

All three are open (OFL) — bundle-safe for a desktop app.

### Typography Rules

1. **Wordmark / Brand Displays:** Set in **Space Grotesk** (Medium, 600 weight, `tracking-wide` / `tracking-[0.06em]`). Used for lockups, headers on landing/connect states, and main app title branding.
2. **Global UI Interface:** Set in **Inter** (Regular 400, Medium 500, Semi-bold 600).
3. **Metrics & Dynamic Strings (MANDATORY):** Any transfer speed, percentages, file sizes, folder counts, or timestamps **must** be rendered with `tabular-nums` (`font-feature-settings: "tnum" 1` in CSS, or `font-mono` where preferred). This eliminates horizontal jitter as values refresh.
4. **Developer Code & Keys:** Set in **JetBrains Mono**. Used for SSH Key helper blocks, presigned URLs, S3 user-defined metadata keys, and S3 ETag values.

### Wordmark Usage

- Use **title case** ("Galeon") not all-caps or all-lowercase
- Title case conveys confidence without shouting
- The capital G can become a design feature with a distinctive ear/terminal
- Convert text to outlines before using the lockup outside the repo

---

## Voice & tone

Confident, calm, precise — with the nautical theme **on a leash**:

- Nautical naming is for **release codenames** (ship classes, see [ROADMAP.md](../docs/ROADMAP.md)) and marketing copy only.
- Core UI stays literal: a file is a *file*, a bucket is a *bucket*, never "cargo" or "the hold." Users in the middle of a 40 GB transfer don't want whimsy.
- Error messages: state what happened, what to try, nothing cute.
- Numbers over adjectives: "saturates a 1 Gbps line" beats "blazingly fast."

---

## Usage Rules

### Clear Space
- Minimum clear space around the mark: at least the height of the hull on all sides.
- Minimum size: 16px (the gale strokes stay legible; below that, drop them and use the micro mark).

### Don'ts
- Don't rotate the ship, recolor the sails, or remove the pennant.
- Don't put the light-background mark on dark UI — use the dark variant.
- Don't use the full mark below 32px — switch to compact or micro.
- Don't add drop shadows (macOS Liquid Glass provides its own depth).
- Don't use fully opaque rectangular backgrounds for the app icon.
- Don't use script, serif, or decorative fonts for the wordmark.
- Don't use stock "nautical" fonts (anchor, rope, pirate-style) — that's costume, not brand.

### Do's
- Use the appropriate mark tier for the context size.
- Test marks at target size before committing.
- Ensure WCAG AA contrast (4.5:1) for all text.
- Use the dark variant on dark backgrounds and vice versa.
- Keep the gold pennant visible — it's the brand's signature accent.

---

## Brand Anti-Patterns (What to Avoid)

### Category Clichés

| Cliché | Why It Fails | Galeon Advantage |
|--------|-------------|-----------------|
| ☁️ Generic cloud shape | Used by hundreds of tools; legally untrademarkable | Galeon's nautical concept sidesteps this entirely |
| ↗️ Upload/download arrows | Universal default; zero brand memory | Use gale strokes for implied motion instead |
| 🔄 Circular sync arrows | Overused by sync tools; becomes visual white noise | A ship under sail already implies movement/sync |
| 🌐 Globe/world map | "We're global" = every company claims this | Not relevant to Galeon's story |
| Overlapping transparent circles | Mastercard owns this territory | N/A |

### Design Anti-Patterns

1. **"Logo too easy to understand"** (Fluency Trap): If it's instantly decoded, it's instantly forgotten. The Galeon galleon concept has natural "desirable difficulty" — keep that.
2. **Full skeuomorphism**: Detailed ship illustration with rigging, waves, etc. Looks like a cruise line, not a dev tool. Reduce to geometric essentials.
3. **Gradient soup**: Multi-color gradient backgrounds behind the mark. Keep gradients subtle (sail surfaces) or avoid entirely on the icon.
4. **Mascot treatment**: A cute character galleon would undermine the professional credibility needed for an S3/SFTP tool used by developers.
5. **Stock "nautical" fonts**: Anchor, rope, or pirate-style typefaces are costume, not brand. Keep typography clean and geometric.

---

## Design System Reference

Product UI rules for coding agents and contributors — theme, color roles, typography, density, motion, and anti-patterns — live in the semantic design system: [DESIGN.md](../DESIGN.md).

Logo tiers and file paths are documented above; prefer `<img>` for brand marks and Lucide for functional UI icons. Do not invent alternate marks or recolor sails outside these assets.
