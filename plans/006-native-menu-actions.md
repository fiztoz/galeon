# Plan 006: Put the working actions in the native menu bar

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 1036155..HEAD -- src-tauri/src/menu_bar.rs src/App.tsx`
> Plan 001 edits `src/App.tsx`. That is expected. STOP if the preferences
> listener or `menu_bar.rs` event pattern below is gone, or if plan 001 did
> not leave a disconnect function the titlebar still calls.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: `plans/001-confirm-disconnect.md` (Disconnect in the menu must use the confirming entry point, not the raw session clear)
- **Category**: direction
- **Planned at**: commit `1036155`, 2026-10-20

## Why this matters

The macOS menu has File, Edit, View, and Window, but View is only Full Screen and File is only Close Window. Dual pane, command palette, sync, shared links, upload, and disconnect exist as titlebar buttons or as a hidden shortcut. A desktop app shows those actions in the menu, with the shortcut visible beside them. After this plan the menu emits events and the existing frontend handlers run. Titlebar buttons stay until plan 004; this plan does not remove them.

## Current state

- `src-tauri/src/menu_bar.rs` — builds the menu and emits one event. Pattern to copy:

```rust
pub const PREFERENCES_ID: &str = "preferences";
pub const PREFERENCES_EVENT: &str = "menu://preferences";

let preferences =
    MenuItem::with_id(app, PREFERENCES_ID, "Settings…", true, Some("CmdOrCtrl+,"))?;
```

```rust
app.on_menu_event(|app, event| {
    if event.id().as_ref() == PREFERENCES_ID {
        let _ = app.emit(PREFERENCES_EVENT, ());
    }
});
```

View exists only on macOS and only contains fullscreen:

```rust
#[cfg(target_os = "macos")]
let view_submenu = Submenu::with_items(
    app,
    "View",
    true,
    &[&PredefinedMenuItem::fullscreen(app, None)?],
)?;
```

- `src/App.tsx` listens with `@tauri-apps/api/event` `listen('menu://preferences', ...)`.
- Dual pane shortcut is a window listener, not a menu item:

```tsx
if (e.altKey && e.metaKey && e.key.toLowerCase() === 'l') {
  e.preventDefault();
  toggleDualPane();
}
```

That listener is mac-only (`metaKey`) and would toggle twice if the menu accelerator also fired. Delete it in this plan after the menu item exists.

- Command palette opens on Cmd/Ctrl+K inside `src/components/CommandPalette.tsx`. Leave that listener. The menu item must call `setPaletteOpen(true)`, never toggle. Double delivery is then harmless.
- Remote commands are already registered on `explorerCmdsRef` as `{ refresh, newFolder, upload }` via `handleRegisterCommands`. Local commands are `localPaneCmdsRef` as `{ refresh, newFolder }`.
- `toggleDualPane` comes from `useLayoutPreferences`. It is safe to call from a stale closure because it only uses the stable `setDualPaneEnabled` setter.
- After plan 001, the titlebar Disconnect button calls `requestDisconnect`. Use that symbol. If the live name differs, use the function the Disconnect button's `onClick` calls. Do not call `performDisconnect` or `setSession(null)` from the menu.

Do not bind Refresh to `CmdOrCtrl+R`. In dev the webview treats that as reload.

Do not add Back/Forward menu items. Plan 003 kept those per pane because dual pane has two histories.

`DESIGN.md`: menu labels are sentence case. Settings already uses an ellipsis because it opens a surface. Match that for actions that open a dialog.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Rust check | `cargo check --locked --manifest-path src-tauri/Cargo.toml` | exit 0 |
| Menu unit test | `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib menu_events_are_unique -- --skip integrity_e2e` | 1 passed, exit 0 |
| Typecheck | `bun run --bun tsc --noEmit` | exit 0 |
| Frontend | `bun run test:frontend` | exit 0 |

Run from the repo root. `cargo check` writes to `src-tauri/target/`, which is gitignored. Do not commit that directory.

## Scope

**In scope**:
- `src-tauri/src/menu_bar.rs`
- `src/App.tsx`
- `plans/README.md` (status row only)

**Out of scope**:
- Removing titlebar buttons. Plan 004 does that after this menu exists.
- `CommandPalette.tsx` shortcut listener.
- Explorer upload/new-folder implementation. Call the registered refs.
- Edit menu Select All. That is text selection. File select-all stays in plan 002's pane keydown.
- Accelerators for Back, Forward, Refresh, or Disconnect.

## Git workflow

- Branch: `advisor/006-native-menu-actions`
- Commit: `feat: add working actions to the native menu`
- Do not push or open a PR.

## Steps

### Step 1: Add menu items and events

In `src-tauri/src/menu_bar.rs`, add id and event constants. Event strings must be exactly:

| Id | Label | Accelerator | Event |
|----|-------|-------------|-------|
| `upload` | `Upload…` | `CmdOrCtrl+Shift+U` | `menu://upload` |
| `new-folder` | `New Folder…` | `CmdOrCtrl+Shift+N` | `menu://new-folder` |
| `disconnect` | `Disconnect` | none (`None`) | `menu://disconnect` |
| `view-local-pane` | `Toggle Local Pane` | `Alt+CmdOrCtrl+L` | `menu://toggle-local-pane` |
| `command-palette` | `Command Palette` | `CmdOrCtrl+K` | `menu://command-palette` |
| `sync` | `Sync…` | none | `menu://sync` |
| `links` | `Shared Links` | none | `menu://links` |

Keep the existing preferences item and `menu://preferences`.

File submenu, all platforms, in this order:
1. Upload…
2. New Folder…
3. separator
4. Disconnect
5. separator
6. existing Close Window
7. existing non-mac Quit

View submenu on macOS:
1. Toggle Local Pane
2. Command Palette
3. Sync…
4. Shared Links
5. separator
6. existing Full Screen

View submenu on other platforms: the same four product items, no fullscreen item. Include `&view_submenu` in `Menu::with_items` on every platform. Today the include is `#[cfg(target_os = "macos")]`. Remove that cfg from the include only.

`on_menu_event` must emit the matching event for every id above, including preferences. Do not call transfer, connect, or filesystem code from this file.

Add this unit test at the bottom of `menu_bar.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn menu_events_are_unique() {
        let events = [
            PREFERENCES_EVENT,
            "menu://upload",
            "menu://new-folder",
            "menu://disconnect",
            "menu://toggle-local-pane",
            "menu://command-palette",
            "menu://sync",
            "menu://links",
        ];
        let mut seen = std::collections::BTreeSet::new();
        for event in events {
            assert!(event.starts_with("menu://"), "{event}");
            assert!(seen.insert(event), "duplicate {event}");
        }
    }
}
```

Use the real constants in that array if you named them. The test must not construct a `Menu` or an `AppHandle`.

**Verify**: `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib menu_events_are_unique -- --skip integrity_e2e` → `1 passed`, exit 0.

### Step 2: Handle the events once

In `src/App.tsx`, extend the existing preferences listener effect. Do not add seven separate effects.

- Keep a `cancelled` flag so an unlisten that resolves after cleanup is called immediately.
- `menu://preferences` → `setSettingsOpen(true)` (existing behavior).
- `menu://command-palette` → `setPaletteOpen(true)`.
- `menu://toggle-local-pane` → `toggleDualPane()`.
- `menu://sync` → the same calls as the Sync button: clear sync prefill, `setSyncRunNow(false)`, `setSyncPanelOpen(true)`. If there is no session, no-op.
- `menu://links` → `loadPresignHistory()` then `setShowHistory(true)`. If there is no session, no-op.
- `menu://upload` → `explorerCmdsRef.current?.upload()`. No-op if the ref is empty.
- `menu://new-folder` → `explorerCmdsRef.current?.newFolder()`.
- `menu://disconnect` → the confirming disconnect function from plan 001.

Read session and refs from refs if the effect would otherwise capture a stale session. `explorerCmdsRef` is already a ref. For "is there a session?", mirror `session` into a ref the same way `editSessionsRef` is mirrored, or put `session` in the effect deps and re-subscribe. Re-subscribe is acceptable if every listen is cleaned up.

Delete the `⌥⌘L` window keydown effect. The menu accelerator replaces it. Do not delete the command palette's own keydown.

Do not remove titlebar buttons in this plan.

**Verify**: `rg -n "altKey && e.metaKey" src/App.tsx` → no matches. `rg -n "menu://upload|menu://disconnect|menu://toggle-local-pane" src/App.tsx` → at least one match each.

### Step 3: Gates

**Verify**: `cargo check --locked --manifest-path src-tauri/Cargo.toml` → exit 0. `bun run --bun tsc --noEmit` → exit 0. `bun run test:frontend` → exit 0.

## Test plan

- `menu_events_are_unique` is the only new test. It guards duplicate or mis-prefixed event names without starting Tauri.
- Do not add a frontend test that mocks `@tauri-apps/api/event` unless one already exists. None does.
- Manual check is not part of the done criteria. Do not launch the app.

## Done criteria

- [ ] `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib menu_events_are_unique -- --skip integrity_e2e` exits 0
- [ ] `cargo check --locked --manifest-path src-tauri/Cargo.toml` exits 0
- [ ] `bun run --bun tsc --noEmit` exits 0
- [ ] `bun run test:frontend` exits 0
- [ ] `rg -n "CmdOrCtrl\\+R|menu://refresh|menu://back" src-tauri/src/menu_bar.rs` returns no matches
- [ ] `rg -n "altKey && e.metaKey" src/App.tsx` returns no matches
- [ ] Titlebar still contains the Sync button (`rg -n ">Sync<" src/App.tsx` still matches). Plan 004 removes it.
- [ ] `git status --short` shows only `src-tauri/src/menu_bar.rs`, `src/App.tsx`, and `plans/README.md`
- [ ] `plans/README.md` row 006 is `DONE`

## STOP conditions

- Tauri rejects an accelerator at compile time. Drop only that accelerator to `None` and report which one. Do not invent a different shortcut.
- Plan 001's confirming disconnect function cannot be found. Stop. Do not wire the menu to `setSession(null)`.
- Handling an event seems to require a new Tauri command or an edit outside `menu_bar.rs` and `App.tsx`.
- A verification fails twice.

## Maintenance notes

- New window actions should get a `menu://` event and a constant in `menu_bar.rs`, not a Rust-side call into the transfer engine.
- Plan 004 is allowed to remove the titlebar Commands/Sync/Links/Settings/Disconnect buttons only because this menu now exposes them.
- Reviewer: Toggle Local Pane must be one event, not a keydown plus a menu event. Command Palette may still have its own keydown because it sets open to true.
