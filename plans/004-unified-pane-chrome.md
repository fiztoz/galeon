# Plan 004: Collapse each file pane to one chrome row and quiet the titlebar

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 1036155..HEAD -- src/App.tsx src/components/Explorer.tsx src/components/LocalPane.tsx src/index.css src-tauri/src/menu_bar.rs src/components/ConnectionSwitcher.tsx`
> This plan assumes 003, 005, and 006 have landed. STOP if any assumption in
> Step 1 is false.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: `plans/003-pane-navigation-history.md`, `plans/005-connection-switcher.md`, `plans/006-native-menu-actions.md`
- **Category**: direction
- **Planned at**: commit `1036155`, 2026-10-20

## Why this matters

A connected window stacks three chrome bands before the first file: the window titlebar, a path bar, and a toolbar. Dual pane doubles the last two. The titlebar also repeats Commands, Sync, Links, and Settings as text buttons after those actions already live in the native menu. After this plan each pane has one chrome row, and the window titlebar keeps only the connection switcher, the local-pane toggle, and live editor state.

## Current state

Before the earlier plans, the connected shell was:

- `src/App.tsx` header: Galeon word, bucket/protocol span, Local, Commands, ActiveEditors, Sync, Links, Settings, Disconnect.
- `src/components/Explorer.tsx`: `renderBreadcrumbs()` in `.pane-path`, then a `.pane-toolbar` with Upload, New folder, Refresh, search (`aria-label="Search remote files"`), and All/Folders/Files filters.
- `src/components/LocalPane.tsx`: the same two regions. Search label is `Search local files`. Primary action is `Upload selected`.
- `src/index.css`: `.pane-toolbar` has padding and `.pane-toolbar-row` plus a filters row. Below 640px container width, search goes full width and the date column hides. That compact behavior must survive.

After the dependency plans, also expect:
- Plan 003: buttons `aria-label="Back"`, `aria-label="Forward"`, and remote `aria-label="Go up"` in the path bars. Local already had Go up.
- Plan 005: `ConnectionSwitcher` mounted in the connected header.
- Plan 006: `menu_bar.rs` emits `menu://upload`, `menu://new-folder`, `menu://disconnect`, `menu://toggle-local-pane`, `menu://command-palette`, `menu://sync`, `menu://links`, and `menu://preferences`.

`DESIGN.md` rules:
- Density over decoration. One row, not a card around the table.
- Teal remains the primary action (Upload). Navigation buttons stay ghost.
- Do not use Space Grotesk / `font-display` on this working row.
- Do not add blur, gradients, or a new accent.
- Selection actions stay inside the pane. Do not move Upload into the window titlebar.
- The transfer drawer is a separate surface. Do not merge it into the pane chrome.

`AGENTS.md` file-size cap: extract the shared row into a new component instead of growing `Explorer.tsx`.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Typecheck | `bun run --bun tsc --noEmit` | exit 0 |
| Frontend | `bun run test:frontend` | exit 0 |

Run from the repo root. No new dependency.

## Scope

**In scope**:
- `src/components/PaneChrome.tsx` (create)
- `src/components/Explorer.tsx`
- `src/components/LocalPane.tsx`
- `src/App.tsx` (connected header buttons only)
- `src/index.css`
- `plans/README.md` (status row only)

**Out of scope**:
- `ConnectionSwitcher.tsx` behavior. Mount it; do not redesign it.
- `menu_bar.rs`. Do not add or remove menu items.
- Filter logic, search logic, upload handlers, history helpers.
- The transfer drawer, sync panel, settings panel, and connection screen.
- Row selection and the file table.

## Git workflow

- Branch: `advisor/004-unified-pane-chrome`
- Commit: `feat: use one chrome row per file pane`
- Do not push or open a PR.

## Steps

### Step 1: Refuse to start if the dependencies are missing

Run these and STOP if any check fails:

```bash
rg -n "aria-label=\"Back\"" src/components/Explorer.tsx src/components/LocalPane.tsx
rg -n "ConnectionSwitcher" src/App.tsx
rg -n "menu://sync" src-tauri/src/menu_bar.rs
rg -n "menu://command-palette" src-tauri/src/menu_bar.rs
rg -n "menu://disconnect" src-tauri/src/menu_bar.rs
```

Each command must print at least one match. If plan 003 used different aria-labels, STOP and report the labels you found. Do not invent a second set of navigation buttons.

### Step 2: Add PaneChrome

Create `src/components/PaneChrome.tsx`. It is a layout shell, not a data hook.

```tsx
export function PaneChrome(props: {
  navigation: React.ReactNode;
  path: React.ReactNode;
  search: React.ReactNode;
  actions: React.ReactNode;
  filters?: React.ReactNode;
})
```

Render one `div.pane-chrome`:
- `navigation`, then `path` (flex, min-width 0, overflow hidden), then `search`, then `actions`, then `filters`.
- Do not wrap this in a bordered card.
- Do not own button behavior. Callers pass the existing buttons.

### Step 3: Use it in both panes

In `Explorer.tsx` and `LocalPane.tsx`:
- Delete the separate `.pane-path` wrapper and the `.pane-toolbar` wrapper.
- Pass the existing Back, Forward, and Up buttons as `navigation`. Do not duplicate them.
- Pass the existing breadcrumb `<nav>` as `path`. Keep the nav `aria-label` (`Remote path` / `Local path`).
- Pass the existing search field as `search`. Do not change its aria-label.
- Pass Upload / New folder / Refresh as `actions`.
- Pass the filter buttons as `filters`.
- Leave the file table, selection bar, dialogs, and drag overlays where they are.

The pane root is still `file-pane` so the container query keeps working.

**Verify**: `rg -n "className=\"pane-path|className=\"pane-toolbar" src/components/Explorer.tsx src/components/LocalPane.tsx` → no matches. `rg -n "PaneChrome" src/components/Explorer.tsx src/components/LocalPane.tsx` → one match each. `rg -n "Search remote files|Search local files" src/components` → both labels still present.

### Step 4: CSS for one row, still wrapping when narrow

In `src/index.css`:
- Add `.pane-chrome` as a flex row, `align-items: center`, `gap: 8px`, `padding: 8px 12px`, `min-width: 0`.
- `.pane-chrome` children that are the path must be able to shrink. Use a class on the path wrapper, `pane-chrome-path`, with `flex: 1`, `min-width: 0`, `overflow: hidden`.
- Keep `.pane-search` flexible but do not force it onto its own row above 640px.
- Under the existing `@container file-pane (max-width: 640px)` rule, set `.pane-chrome { flex-wrap: wrap; }` and keep `.pane-search { flex-basis: 100%; }`.
- Delete `.pane-toolbar`'s `space`/padding rules only if nothing else references them. `rg` first.
- Do not change `.file-table` column rules from plan 002.

**Verify**: `rg -n "pane-chrome" src/index.css` → at least one match. `bun run --bun tsc --noEmit` → exit 0.

### Step 5: Quiet the connected titlebar

In the connected header of `src/App.tsx` only:
- Keep the drag region, the Galeon label, `ConnectionSwitcher`, the Local toggle, and `ActiveEditors`.
- Remove the Commands, Sync, Links, and Settings buttons, and the Disconnect button if it is still a sibling of those buttons.
- Disconnect must remain reachable inside `ConnectionSwitcher` (`onDisconnect`) and through `menu://disconnect`. Do not delete `requestDisconnect`.
- Do not remove the command palette component, sync panel, settings panel, or presign history modal. They still open from the menu and from `⌘K`.

Do not edit the disconnected `Connection` screen header.

**Verify**: `rg -n ">Commands<|>Sync<|>Links<" src/App.tsx` → no matches. `rg -n "ConnectionSwitcher|ActiveEditors" src/App.tsx` → both still match. `rg -n "menu://sync" src-tauri/src/menu_bar.rs` → still matches.

### Step 6: Frontend gate

**Verify**: `bun run test:frontend` → exit 0.

## Test plan

- No new unit test. This plan is layout wiring. The history and switcher tests from plans 003 and 005 must still pass inside `bun run test:frontend`.
- Do not add a snapshot test.
- Do not launch the Tauri window.

## Done criteria

- [ ] Step 1's five `rg` checks matched before you edited
- [ ] `bun run --bun tsc --noEmit` exits 0
- [ ] `bun run test:frontend` exits 0
- [ ] `rg -n "className=\"pane-path|className=\"pane-toolbar" src/components/Explorer.tsx src/components/LocalPane.tsx` returns no matches
- [ ] `rg -n ">Commands<|>Sync<|>Links<" src/App.tsx` returns no matches
- [ ] `rg -n "ConnectionSwitcher" src/App.tsx` still matches
- [ ] `rg -n "aria-label=\"Back\"" src/components/Explorer.tsx src/components/LocalPane.tsx` still matches
- [ ] `git status --short` shows only the in-scope files
- [ ] `plans/README.md` row 004 is `DONE`

## STOP conditions

- Step 1 fails. Do not remove titlebar buttons if the menu events or the switcher are absent. Users would lose Sync, Links, Settings, or Disconnect.
- The compact container query cannot keep search usable below 640px without a permanent second row on wide panes. Stop and report. Do not delete the container query.
- `ConnectionSwitcher` is not in the connected header.
- A verification fails twice.

## Maintenance notes

- New pane actions belong in that pane's `PaneChrome` `actions` slot, not in the window titlebar.
- Window-level actions belong in `menu_bar.rs` plus the command palette. Do not put them back as titlebar text buttons.
- Reviewer: dual pane must still have two independent path rows and two histories. This plan does not make one global path bar.
