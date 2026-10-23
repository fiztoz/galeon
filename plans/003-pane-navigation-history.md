# Plan 003: Add Up, Back, and Forward to each file pane

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 1036155..HEAD -- src/components/Explorer.tsx src/components/LocalPane.tsx`
> If either file changed, compare the excerpts below before proceeding. On a
> mismatch, STOP. Plan 002 may already have changed row selection in these
> files. That is expected if 002 has landed. STOP only if the path-bar
> excerpts below are gone or the prefix/path setters have changed meaning.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none. Run after plan 002 if both are in progress, because both edit the pane files. Do not run them in parallel.
- **Category**: direction
- **Planned at**: commit `1036155`, 2026-10-20

## Why this matters

The local pane can go up one folder. The remote pane cannot. Neither pane can go back to the folder it just left. Breadcrumbs jump to ancestors, but they do not restore a sibling folder the user was just in. After this plan each pane has Up, Back, and Forward, and the history is a pure function with tests.

## Current state

- `src/components/LocalPane.tsx` — `navigateUp` derives the parent from `currentPath` and clears selection. The path bar has an Up button labelled by `title="Go up one level"` and no Back/Forward. Root is `/`. Up is disabled when `pathSegments.length === 0`.
- `src/components/Explorer.tsx` — remote path bar is `renderBreadcrumbs()`. Root calls `setPrefix('')`. There is no Up button. Folder double-click does `setPrefix(isFsProtocol ? normalizeFsPath(obj.fullKey) : obj.fullKey)`.
- Command palette navigation sets the prefix through `navRequest` in an effect: `if (navRequest) setPrefix(navRequest.path)`.
- `src-tauri/src/listing.rs` — empty remote prefix means the session root (S3 bucket root, or SFTP/FTP `pwd`). Do not send a new "parent" command. Up is a string change only.

Remote breadcrumb parent shape already used by the UI (`Explorer.tsx`):

```tsx
const parts = prefix.split('/').filter(Boolean);
const breadcrumbPath = (index: number) =>
  isFsProtocol
    ? normalizeFsPath('/' + parts.slice(0, index + 1).join('/'))
    : parts.slice(0, index + 1).join('/') + '/';
```

`isFsProtocol` is true for `sftp`, `ftp`, and `ftps`.

Design constraints from `DESIGN.md`:
- Icon buttons are quiet zinc ghost controls, 14–16px. Teal is not a navigation-button fill.
- Do not add a second path dialect. Store the same strings `setPrefix` / `setCurrentPath` already store.
- Do not bind Alt+Left or Alt+Right. The webview uses those for its own history.

`Explorer.tsx` is already over the ~1000-line soft cap in `AGENTS.md`. History logic goes in a new module.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Focused tests | `bun test tests/frontend/pathHistory.test.ts` | all pass, exit 0 |
| Typecheck | `bun run --bun tsc --noEmit` | exit 0 |
| Full frontend | `bun run test:frontend` | exit 0 |

Run from the repo root.

## Scope

**In scope**:
- `src/pathHistory.ts` (create)
- `tests/frontend/pathHistory.test.ts` (create)
- `src/components/Explorer.tsx`
- `src/components/LocalPane.tsx`
- `plans/README.md` (status row only)

**Out of scope**:
- Merging the path bar into the toolbar. Plan 004 does that. Leave the existing `pane-path` and `pane-toolbar` blocks as two regions.
- Native menu Back/Forward. Dual pane has two histories; a window menu item would be ambiguous.
- Keyboard Alt+Left / Cmd+[. Buttons only.
- Backend listing changes.

## Git workflow

- Branch: `advisor/003-pane-navigation-history`
- Commit: `feat: add back, forward, and up in file panes`
- Do not push or open a PR.

## Steps

### Step 1: Pure history and parent helpers

Create `src/pathHistory.ts`:

```ts
export type PathHistoryState = { past: string[]; current: string; future: string[] };

export function initialPathHistory(current: string): PathHistoryState {
  return { past: [], current, future: [] };
}

export function pushPath(state: PathHistoryState, next: string): PathHistoryState {
  if (next === state.current) return state;
  return { past: [...state.past, state.current].slice(-50), current: next, future: [] };
}

export function backPath(state: PathHistoryState): PathHistoryState | null {
  const previous = state.past[state.past.length - 1];
  if (previous === undefined) return null;
  return { past: state.past.slice(0, -1), current: previous, future: [state.current, ...state.future] };
}

export function forwardPath(state: PathHistoryState): PathHistoryState | null {
  const next = state.future[0];
  if (next === undefined) return null;
  return { past: [...state.past, state.current], current: next, future: state.future.slice(1) };
}

/** Parent prefix, or null when already at the pane root. */
export function parentPrefix(prefix: string, fsProtocol: boolean): string | null {
  if (fsProtocol && (prefix === '/' || prefix === '')) return null;
  const parts = prefix.split('/').filter(Boolean);
  if (parts.length === 0) return null;
  parts.pop();
  if (!fsProtocol) return parts.length === 0 ? '' : parts.join('/') + '/';
  return parts.length === 0 ? '/' : '/' + parts.join('/');
}
```

Create `tests/frontend/pathHistory.test.ts` with these cases:
- push of the current path returns the same state
- push truncates the future stack
- back then forward restores the path that was current
- back on an empty past returns null
- the 51st push drops the oldest past entry
- `parentPrefix('', false)` is null
- `parentPrefix('a/', false)` is `''`
- `parentPrefix('a/b/', false)` is `'a/'`
- `parentPrefix('a/b', false)` is `'a/'`
- `parentPrefix('/', true)` is null
- `parentPrefix('', true)` is null
- `parentPrefix('/var/log', true)` is `'/var'`
- `parentPrefix('/var', true)` is `'/'`
- `parentPrefix('/', false)` is `''` only if that is what the function actually returns. Non-fs `/` has no segments after filter, so it must return null. Assert `parentPrefix('/', false)` is null.

**Verify**: `bun test tests/frontend/pathHistory.test.ts` → exit 0.

### Step 2: Remote pane

In `Explorer.tsx`:
- Keep one `useState` history initialized from the current prefix, or a ref plus state. Use the pure functions. Do not write a second history algorithm inline.
- Add `goTo(next: string, record: boolean)`:
  - `record` true calls `pushPath` then `setPrefix`
  - `record` false sets the history state to the back/forward result and `setPrefix` to that current value
  - always `clearSelection()` when the prefix changes
- User navigations record history: breadcrumb clicks, root click, folder double-click, and Up.
- `navRequest` effect records history too (palette jump is a new location, not back).
- The prefix-reset scroll effect must still run. Do not remove `scrollRef.current?.scrollTo({ top: 0 })` on prefix change.
- Up calls `parentPrefix(prefix, isFsProtocol)` and `goTo` with record true. Disabled when the helper returns null.
- Back/Forward call `backPath` / `forwardPath`. Disabled when they return null.
- Buttons live in the existing path bar, before the breadcrumb `<nav>`:
  - `aria-label="Back"`, `aria-label="Forward"`, `aria-label="Go up"`
  - `disabled` when unavailable
  - Lucide `ArrowLeft`, `ArrowRight`, `ArrowUp` at 16px
  - class `ui-button ui-button-ghost` plus `disabled:opacity-30`
- Do not add keydown handlers for these buttons.

**Verify**: `rg -n "aria-label=\"Go up\"|aria-label=\"Back\"|aria-label=\"Forward\"" src/components/Explorer.tsx` → one of each.

### Step 3: Local pane

In `LocalPane.tsx`:
- Wrap path changes in the same `pushPath` / `backPath` / `forwardPath` helpers.
- Keep the existing `navigateUp` parent logic for local paths. Do not route local Up through `parentPrefix` unless you first prove `/Users/foo` and a Windows-style path still work. Local Up stays the current string split. Record that parent with `pushPath`.
- Record history for segment clicks, root click, directory double-click, and Up.
- Add Back and Forward buttons beside the existing Up button, with the same aria-labels as the remote pane.
- Do not change local root from `/`.

**Verify**: `rg -n "aria-label=\"Back\"|aria-label=\"Forward\"" src/components/LocalPane.tsx` → one of each. `bun run --bun tsc --noEmit` → exit 0.

### Step 4: Full frontend gate

**Verify**: `bun run test:frontend` → exit 0.

## Test plan

- All history and parent cases live in `tests/frontend/pathHistory.test.ts`.
- Do not mount the panes. There is no component renderer.
- No Rust test. This plan does not change listing.

## Done criteria

- [ ] `bun test tests/frontend/pathHistory.test.ts` exits 0
- [ ] `bun run --bun tsc --noEmit` exits 0
- [ ] `bun run test:frontend` exits 0
- [ ] Both pane files contain `aria-label="Back"` and `aria-label="Forward"`
- [ ] `Explorer.tsx` contains `aria-label="Go up"`
- [ ] `rg -n "Alt\+Arrow|altKey && event.key === 'Arrow'" src/components/Explorer.tsx src/components/LocalPane.tsx` returns no matches
- [ ] `git status --short` shows only the in-scope files
- [ ] `plans/README.md` row 003 is `DONE`

## STOP conditions

- Remote folder `fullKey` values no longer round-trip through `setPrefix` (double-click would already be broken). Do not invent a normalizer beyond `parentPrefix` and the existing `normalizeFsPath`.
- Local paths are not `/`-separated on the machine you are inspecting and the existing `navigateUp` would be wrong if reused. Leave local Up as it is and report that.
- Implementing this requires a Tauri command.
- A verification fails twice.

## Maintenance notes

- Plan 004 will move these three buttons into a shared pane chrome. It finds them by the aria-labels above. Do not rename those labels.
- A window-level Back menu item is deferred because dual pane has two stacks. If it is added later, it must target the pane that last received focus, not always the remote pane.
- Reviewer: palette `navRequest` must push history; Back must not push a second entry.
