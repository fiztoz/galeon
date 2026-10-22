# Plan 002: Make file lists select and move like a desktop list

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 1036155..HEAD -- src/hooks/useMultiSelect.ts src/components/Explorer.tsx src/components/LocalPane.tsx src/index.css tests/frontend/multiSelect.test.ts`
> If any in-scope file changed, compare the "Current state" excerpts against
> the live code before proceeding. On a mismatch, STOP.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: direction
- **Planned at**: commit `1036155`, 2026-10-20

## Why this matters

`DESIGN.md` says lists are arrow-navigable and that selection is instant. The file tables do not listen for arrows. A plain click toggles the row off again, which is checkbox behavior, not a file manager. The remote table also spends a column on a per-row kebab even though right-click already opens the same menu. After this plan, click replaces the selection, Cmd/Ctrl-click toggles, Shift extends, arrows move the cursor inside the virtualized window, and the kebab column is gone.

## Current state

- `src/hooks/useMultiSelect.ts` — remote selection. Plain click toggles.
- `src/components/LocalPane.tsx` — duplicates that toggle logic inline around the `handleSelectItem` at line 201. It does not use the hook. It has no Actions column.
- `src/components/Explorer.tsx` — remote table. Row has `onDoubleClick` and `onContextMenu`, but no `onClick`. Selection happens only on the checkbox and the name button. The fifth column is Actions.
- `src/hooks/useWindowedRows.ts` — only the visible slice is mounted. Rows carry `data-row-index`. Do not render every row to make keyboard nav easier.
- `src/components/ObjectContextMenu.tsx` — right-click menu. Keep it. Do not add shortcut labels in this plan.
- `src/index.css` — column widths assume five remote columns. `.file-table th:nth-child(5)` is the Actions column. Compact layout also hides that column's label.

Current toggle (`src/hooks/useMultiSelect.ts`):

```ts
} else {
  if (newSelected.has(key)) {
    newSelected.delete(key);
  } else {
    newSelected.add(key);
  }
}
```

Remote Actions header (`src/components/Explorer.tsx`):

```tsx
<th className="px-6 py-3 w-20 text-center">Actions</th>
```

Empty and spacer rows use `colSpan={5}`. Local pane already uses `colSpan={4}`.

Existing test `tests/frontend/multiSelect.test.ts` calls `handleSelectItem('z', 0)` then `handleSelectItem('a', 2, true)` and expects a shift-range of three keys. You will update this test. Do not preserve boolean-as-shift.

`DESIGN.md` rules to obey:
- Selection is Gale Teal tint. Do not add purple, a new accent, or a fade animation.
- Focus uses the existing `--focus-ring` / `:focus-visible` outline. Do not stack a second ring.
- Do not set table text in Space Grotesk (`font-display`).

`AGENTS.md` says not to push a component that is already over ~1000 lines further up. `Explorer.tsx` is already 1005 lines. New keyboard logic goes in a new hook, not inline in `Explorer.tsx`.

Tests use `bun:test`. Hook tests use `hookHarness()` from `tests/frontend/harness.ts`. Prefer a pure function so the new cases do not need the harness.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Focused tests | `bun test tests/frontend/multiSelect.test.ts tests/frontend/fileListKeyboard.test.ts` | all pass, exit 0 |
| Typecheck | `bun run --bun tsc --noEmit` | exit 0 |
| Full frontend | `bun run test:frontend` | exit 0 |

Run from the repo root. Do not `bun install`.

## Scope

**In scope**:
- `src/hooks/useMultiSelect.ts`
- `src/hooks/useFileListKeyboard.ts` (create)
- `src/hooks/useWindowedRows.ts` (add `scrollToIndex` only)
- `src/components/Explorer.tsx`
- `src/components/LocalPane.tsx`
- `src/index.css`
- `tests/frontend/multiSelect.test.ts`
- `tests/frontend/fileListKeyboard.test.ts` (create)
- `plans/README.md` (status row only)

**Out of scope**:
- Path bars, Up/Back/Forward, window titlebar, native menus, sync, transfers.
- `ObjectContextMenu.tsx` behavior. Right-click must keep working.
- Removing the checkbox column. Header "select all" stays.
- Changing double-click. Folders still navigate. Files still do not download on double-click or Enter.
- `src-tauri/**`.

## Git workflow

- Branch: `advisor/002-desktop-list-selection`
- Commit: `feat: select file rows like a desktop list`
- Do not push or open a PR.

## Steps

### Step 1: Replace the selection gesture

In `src/hooks/useMultiSelect.ts`, export this type and pure function, and make the hook call the function:

```ts
export type SelectGesture = { shift?: boolean; toggle?: boolean };

export function applySelection(
  selected: ReadonlySet<string>,
  anchor: number | null,
  items: readonly { fullKey: string }[],
  key: string,
  index: number,
  gesture: SelectGesture,
): { selected: Set<string>; anchor: number } {
  if (gesture.shift && anchor !== null && items.length > 0) {
    const next = new Set(selected);
    const start = Math.min(anchor, index);
    const end = Math.max(anchor, index);
    for (let i = start; i <= end; i++) {
      if (items[i]) next.add(items[i].fullKey);
    }
    return { selected: next, anchor };
  }
  if (gesture.toggle) {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return { selected: next, anchor: index };
  }
  return { selected: new Set([key]), anchor: index };
}
```

Hook rules:
- `handleSelectItem(key, index, gesture: SelectGesture = {})` calls `applySelection` and stores both returned fields. `selected` becomes `selectedItems`. `anchor` becomes `lastSelectedIndex`. Do not set the anchor to `index` yourself; a shift gesture must keep the previous anchor, which is what `applySelection` returns.
- Also store `cursorIndex`, initially `null`. Every `handleSelectItem` sets `cursorIndex` to `index`.
- `clearSelection` sets cursor and anchor to `null`.
- `handleSelectAll` does not change the cursor.
- Return `cursorIndex` and `setCursorIndex`.

Update `tests/frontend/multiSelect.test.ts`:
- `handleSelectItem('z', 0)` then `handleSelectItem('a', 2)` leaves only `a` selected (replace, not toggle).
- `handleSelectItem('z', 0)` then `handleSelectItem('a', 2, { shift: true })` still selects all three, and a later plain click replaces.
- `handleSelectItem('z', 0, { toggle: true })` twice leaves the set empty.
- Shift with no anchor selects only the clicked key.
- `clearSelection` then shift-click selects only the clicked key (the old test's anchor-reset case).

**Verify**: `bun test tests/frontend/multiSelect.test.ts` → exit 0.

### Step 2: Pure keyboard actions

Create `src/hooks/useFileListKeyboard.ts` with a pure function. No DOM in the function.

```ts
export type ListKeyAction =
  | { type: 'none' }
  | { type: 'move'; index: number; extend: boolean }
  | { type: 'open'; index: number }
  | { type: 'selectAll' }
  | { type: 'clear' };

export function fileListKeyAction(
  event: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; defaultPrevented?: boolean },
  state: { count: number; cursor: number | null },
  typing: boolean,
): ListKeyAction
```

Rules when `typing` is true or `count === 0` or `defaultPrevented`: return `{ type: 'none' }`, except `count === 0` still returns `selectAll`/`clear` as `none`.
- `ArrowDown` / `ArrowUp`: move one row, clamped to `0..count-1`. If cursor is null, Down lands on 0 and Up lands on `count - 1`. `extend` is `event.shiftKey`.
- `Home` / `End`: 0 and `count - 1`, same `extend` rule.
- `Enter`: `{ type: 'open', index: cursor }` when cursor is not null. Otherwise `none`.
- `Escape`: `{ type: 'clear' }`.
- `a` or `A` with `metaKey || ctrlKey`, and not `altKey`: `{ type: 'selectAll' }`.
- Anything else, including bare letters: `none`.

Create `tests/frontend/fileListKeyboard.test.ts` covering: typing ignores arrows; empty list; first Down from null; clamp at both ends; Shift+Down sets `extend`; Enter with and without cursor; Cmd/Ctrl+A; Alt+A is `none`; Escape clears.

**Verify**: `bun test tests/frontend/fileListKeyboard.test.ts` → exit 0.

### Step 3: Scroll the virtual window

In `src/hooks/useWindowedRows.ts`, add `scrollToIndex(index: number)` to the returned object. Use the offsets already computed in that hook:
- top of row = `offsets[index] ?? index * DEFAULT_ROW_HEIGHT`
- height = `rowHeights[index] || DEFAULT_ROW_HEIGHT`
- if the row is above `scrollRef.current.scrollTop`, scroll to top
- if the row bottom is below `scrollTop + clientHeight`, scroll so the bottom is visible
- no-op if the ref is missing or the index is out of range

Do not change `computeWindow` or the spacer math. Do not add a test that needs a DOM.

### Step 4: Wire both panes

Remote (`Explorer.tsx`) and local (`LocalPane.tsx`):

1. Delete LocalPane's inline `handleSelectItem`, `handleSelectAll`, and `clearSelection`. Map `filteredEntries` to `{ fullKey: entry.path }` and use `useMultiSelect`. Keep using `entry.path` as the key. Do not change upload/download payloads.
2. On each data row `onClick`: if the event target is inside `input, button, a`, return. Otherwise `handleSelectItem(key, index, { shift: event.shiftKey, toggle: event.metaKey || event.ctrlKey })`.
3. Checkbox `onClick` keeps `stopPropagation` and calls `handleSelectItem(key, index, { toggle: !event.shiftKey, shift: event.shiftKey })`.
4. Name button `onClick` uses the same gesture as the row and `stopPropagation`. Enter on the name button still calls the existing double-click handler.
5. Put `tabIndex={0}` on the pane root that already has `className="file-pane ..."`. Add `onKeyDown`:
   - `typing` is true when `event.target` is an `input`, `textarea`, `select`, or `[contenteditable="true"]`.
   - Dispatch `fileListKeyAction`.
   - `move` without `extend`: replace selection with that row and set cursor.
   - `move` with `extend`: `handleSelectItem(key, newIndex, { shift: true })`. That keeps the anchor because `applySelection` returns the old anchor. Do not also set `lastSelectedIndex` to `newIndex`.
   - `open`: call the existing double-click handler for that row.
   - `selectAll`: `handleSelectAll` only if not already all selected; if already all selected, leave it (Cmd+A should not toggle off).
   - `clear`: `clearSelection`.
   - For every non-`none` action, `preventDefault`.
   - After `move` or `open`, call `scrollToIndex`.
6. Add `aria-selected={selected}` on each data row. Add class `is-cursor` when `index === cursorIndex`.
7. In `src/index.css` only:

```css
.file-table tr.is-cursor { box-shadow: inset 2px 0 0 var(--focus-ring); }
```

Do not add a background color. Selected rows already use `bg-gale-teal/10`.

**Verify**: `bun run --bun tsc --noEmit` → exit 0.

### Step 5: Remove the remote Actions column

In `Explorer.tsx` only:
- Remove the Actions `<th>` and the kebab `<td>` (`MoreVertical`, `openItemMenu` from that button).
- Keep `onContextMenu` and `ObjectContextMenu`.
- Change every remote `colSpan={5}` to `colSpan={4}`.
- If `MoreVertical` becomes unused, remove the import.

In `src/index.css`:
- Delete `.file-table th:nth-child(5)` and both compact-mode `nth-child(5)` rules.
- Do not renumber columns 3 and 4. Size and date stay where they are.

**Verify**: `rg -n "Actions for |MoreVertical|colSpan=\{5\}|nth-child\\(5\\)" src/components/Explorer.tsx src/index.css` → no matches.

### Step 6: Full frontend gate

**Verify**: `bun run test:frontend` → exit 0.

## Test plan

- Update `tests/frontend/multiSelect.test.ts` for replace vs toggle vs shift, including the old anchor-reset case.
- New `tests/frontend/fileListKeyboard.test.ts` for the key function only.
- Do not mount Explorer. There is no component renderer in this repo.
- Model the new test on a direct `bun:test` import, not `hookHarness`, except the updated hook test which already uses the harness.

## Done criteria

- [ ] `bun run --bun tsc --noEmit` exits 0
- [ ] `bun run test:frontend` exits 0
- [ ] `rg -n "colSpan=\{5\}|MoreVertical" src/components/Explorer.tsx` returns no matches
- [ ] `rg -n "nth-child\\(5\\)" src/index.css` returns no matches
- [ ] `src/components/LocalPane.tsx` no longer declares its own `const handleSelectItem`
- [ ] `git status --short` shows only the in-scope files
- [ ] `plans/README.md` row 002 is `DONE`

## STOP conditions

- `useWindowedRows` no longer windows by `data-row-index` spacers. Do not turn the list into a full render.
- Local pane keys are not `entry.path`, or remote keys are not `fullKey`.
- Arrow handling seems to require listening on `window` (that would steal keys from dialogs and the command palette). The listener stays on the pane.
- A verification fails twice.

## Maintenance notes

- Cmd+A in the native Edit menu is still text "Select All". Do not bind file select-all to that menu in a later plan. File select-all is the pane keydown only.
- If a third file list is added, it must use `useMultiSelect` and `fileListKeyAction` rather than copying the old toggle.
- Reviewer: shift-arrow must not move the anchor; a following shift-click still ranges from the original click.
