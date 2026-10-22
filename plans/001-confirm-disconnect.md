# Plan 001: Confirm disconnect when an external editor is still open

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 1036155..HEAD -- src/App.tsx src/components/Dialogs.tsx`
> If either in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `1036155`, 2026-10-20

## Why this matters

Switching profiles already warns when files are open in an external editor, because unsaved editor changes will not be re-uploaded. The Disconnect button and the command-palette Disconnect action skip that warning and tear the session down immediately. The switch warning itself is a hand-rolled overlay with no focus trap, so keyboard users can tab into the explorer behind it. After this plan, every disconnect path confirms when editors are open, and both that dialog and the switch dialog use the existing modal.

## Current state

- `src/App.tsx` — connected shell. Disconnect and profile-switch live here.
- `src/components/Dialogs.tsx` — shared `ConfirmDialog`. Already uses `ModalSurface` (focus trap, Escape, focus return).
- `src/components/ModalSurface.tsx` — do not edit. `ConfirmDialog` already wraps it.

Disconnect today (`src/App.tsx`, `handleDisconnect`):

```tsx
const handleDisconnect = useCallback(() => {
  editSessionsRef.current.forEach((s) => { invoke('stop_editing_file', { editorId: s.editorId }).catch(() => {}); });
  editSessionsRef.current = [];
  setEditSessions([]);
  setInspectorOpen(false);
  setPaletteOpen(false);
  setRecentPaths([]);
  setSession(null);
}, []);
```

The titlebar button and the palette both call that function directly:

```tsx
{ id: 'disconnect', label: 'Disconnect', keywords: 'logout exit close', run: handleDisconnect },
```

```tsx
<button onClick={handleDisconnect} className="ui-button ui-button-ghost ml-1">
  Disconnect
</button>
```

Profile switch already defers when `editSessionsRef.current.length > 0`, then renders this overlay (no `ConfirmDialog`, no `ModalSurface`):

```tsx
{pendingSwitchProfile && (
  <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 w-[480px] max-h-[80vh] shadow-2xl flex flex-col">
      <h3 className="text-lg font-semibold mb-2">Switch connection?</h3>
      ...
      <button onClick={confirmSwitchProfile} className="px-4 py-2 text-sm rounded-lg bg-rose-600 text-white hover:bg-rose-500">
        Switch anyway
      </button>
    </div>
  </div>
)}
```

`ConfirmDialog` contract (`src/components/Dialogs.tsx`):

```tsx
export interface ConfirmDialogProps {
  title: React.ReactNode;
  children?: React.ReactNode;
  cancelLabel?: string;
  confirmLabel: string;
  tone?: 'primary' | 'danger';
  onCancel: () => void;
  onConfirm: () => void;
}
```

Design constraint, from `DESIGN.md`: destructive actions are danger, not teal. Do not invent a rose/pink button. Use `tone="danger"`. Do not restyle `Dialogs.tsx`.

Frontend tests are Bun tests under `tests/frontend/`, run by `bun run test:frontend`. Pure functions are imported directly. See `tests/frontend/multiSelect.test.ts` only as a file-location example; this plan does not need the hook harness.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Tests | `bun run test:frontend` | exit 0 |
| Typecheck | `bun run --bun tsc --noEmit` | exit 0 |

Run both from the repo root the repo root. Do not run `bun install`. `node_modules` is already present.

## Scope

**In scope**:
- `src/App.tsx`
- `src/disconnectGuard.ts` (create)
- `tests/frontend/disconnectGuard.test.ts` (create)
- `plans/README.md` (status row only)

**Out of scope**:
- `src/components/Dialogs.tsx` and `src/components/ModalSurface.tsx` — reuse them, do not restyle them.
- `src-tauri/**` — no backend change. Disconnect still only clears frontend session state and stops editor watchers.
- Titlebar layout, menus, connection switcher, explorer. Later plans own those.
- Transfer cancellation on disconnect. Do not add it.

## Git workflow

- Branch: `advisor/001-confirm-disconnect`
- Commit style matches the repo: `fix: confirm disconnect while editors are open`
- Do not push or open a PR.

## Steps

### Step 1: Add the guard function

Create `src/disconnectGuard.ts`:

```ts
/** Disconnect must warn only when an external editor watch is still open. */
export function disconnectNeedsConfirm(openEditorCount: number): boolean {
  return openEditorCount > 0;
}
```

Create `tests/frontend/disconnectGuard.test.ts`:

```ts
import { test, expect } from 'bun:test';
import { disconnectNeedsConfirm } from '../../src/disconnectGuard';

test('disconnect confirms only while an editor watch is open', () => {
  expect(disconnectNeedsConfirm(0)).toBe(false);
  expect(disconnectNeedsConfirm(1)).toBe(true);
  expect(disconnectNeedsConfirm(3)).toBe(true);
});
```

**Verify**: `bun test tests/frontend/disconnectGuard.test.ts` → 1 pass, exit 0.

### Step 2: Split perform vs request

In `src/App.tsx`:

1. Rename the current `handleDisconnect` body to `performDisconnect`. Keep the same watcher-stop and `setSession(null)` behavior. Do not add transfer cancellation.
2. Add `requestDisconnect`:
   - If `disconnectNeedsConfirm(editSessionsRef.current.length)` is true, set a new `pendingDisconnect` boolean and return.
   - Otherwise call `performDisconnect`.
3. Point the titlebar button and the palette action at `requestDisconnect`, not `performDisconnect`.
4. Confirming the new dialog calls `performDisconnect` and clears `pendingDisconnect`. Cancel only clears the flag and leaves the session and editor watches running.

**Verify**: `rg -n "onClick=\{handleDisconnect\}|run: handleDisconnect" src/App.tsx` → no matches.

### Step 3: Render both warnings with ConfirmDialog

Import `ConfirmDialog` from `./components/Dialogs`.

Replace the raw `pendingSwitchProfile` overlay with `ConfirmDialog`:
- title `Switch connection?`
- `tone="danger"`
- `confirmLabel="Switch anyway"`
- `onCancel={cancelSwitchProfile}`
- `onConfirm={confirmSwitchProfile}`
- children: the existing sentence about editor watches, plus the existing filename list. Keep the pluralization (`file` / `files`).

Add a second `ConfirmDialog` when `pendingDisconnect` is true:
- title `Disconnect?`
- `tone="danger"`
- `confirmLabel="Disconnect"`
- `cancelLabel="Stay connected"`
- children: same editor warning and filename list, saying disconnect stops watching and unsaved editor changes will not be re-uploaded.
- `onConfirm` performs disconnect and clears the flag.
- `onCancel` only clears the flag.

If both flags could be set, clear `pendingDisconnect` when opening the switch dialog and clear `pendingSwitchProfile` when opening the disconnect dialog. Only one dialog is mounted.

Do not copy the `rose-600` button or the `fixed inset-0` markup.

**Verify**: `rg -n "fixed inset-0 bg-black/50|bg-rose-600" src/App.tsx` → no matches. `rg -n "ConfirmDialog" src/App.tsx` → at least 2 matches.

### Step 4: Typecheck and the frontend suite

**Verify**: `bun run --bun tsc --noEmit` → exit 0. Then `bun run test:frontend` → exit 0.

## Test plan

- `tests/frontend/disconnectGuard.test.ts` covers 0, 1, and many open editors.
- There is no App mount harness. Do not add React Testing Library. The dialog wiring is gated by the `rg` checks above.
- Pattern for the new test: a direct import, like `tests/frontend/presets.test.ts`, not the hook harness.

## Done criteria

- [ ] `bun run --bun tsc --noEmit` exits 0
- [ ] `bun run test:frontend` exits 0 and `disconnectGuard.test.ts` passes
- [ ] `rg -n "onClick=\{handleDisconnect\}|run: handleDisconnect" src/App.tsx` returns no matches
- [ ] `rg -n "fixed inset-0 bg-black/50|bg-rose-600" src/App.tsx` returns no matches
- [ ] `git status --short` shows only `src/App.tsx`, `src/disconnectGuard.ts`, `tests/frontend/disconnectGuard.test.ts`, and `plans/README.md`
- [ ] `plans/README.md` status row for 001 is `DONE`

## STOP conditions

- `handleDisconnect` no longer only stops editor watches and clears session state (for example it now cancels transfers or calls a backend disconnect you were not told about). Stop. Do not invent a backend command.
- `ConfirmDialog` no longer renders through `ModalSurface`.
- Making the dialog work seems to require editing `Dialogs.tsx` or `ModalSurface.tsx`.
- A verification command fails twice after a reasonable fix.

## Maintenance notes

- Later plans must call `requestDisconnect`, not `performDisconnect`, from menus and the connection switcher.
- Reviewer: confirm cancel leaves `editSessions` untouched and does not call `stop_editing_file`.
- Deferred: disconnect does not cancel the transfer queue. That is intentional.
