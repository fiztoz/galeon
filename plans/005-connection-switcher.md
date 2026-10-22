# Plan 005: Switch saved connections without leaving the explorer

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 1036155..HEAD -- src/App.tsx src/types.ts`
> Plans 001 and 006 also edit `src/App.tsx`. That is expected. STOP if
> `connectProfile` no longer exists, or if the connected header no longer
> shows `session.bucket` / the protocol label described below.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: `plans/001-confirm-disconnect.md`
- **Category**: direction
- **Planned at**: commit `1036155`, 2026-10-20

## Why this matters

The connected window shows a bucket name or a protocol label and a Disconnect button. Choosing another saved connection means disconnecting, landing on the connection form, and connecting again — or knowing that the command palette can do it. The palette path already exists (`connectProfile`) and already confirms when editors are open. After this plan the titlebar identity is a menu of saved profiles that uses that same function.

## Current state

- `src/App.tsx` connected header shows the word Galeon, then a protocol or bucket label, then Local / Commands / editors / Sync / Links / Settings / Disconnect.
- `connectProfile(profile)` connects in place. If `editSessionsRef` is non-empty it sets `pendingSwitchProfile` instead of connecting. Do not write a second connect path and do not call `connect_storage` from the new component.
- `requestDisconnect` is the confirming disconnect entry point after plan 001. The Disconnect item in the switcher must call that, not `setSession(null)`.
- Session shape in `App.tsx`:

```tsx
const [session, setSession] = useState<{
  sessionId: string;
  bucket: string;
  profileId?: string;
  protocol?: StorageProtocol;
  capabilities?: ProtocolCapabilities;
} | null>(null);
```

- `profiles` is `ConnectionProfile[]` already loaded in `App`. Fields used for labels: `id`, `name`, `protocol`, `username`, `host`, `port`, `bucket`, `endpoint`. See `src/types.ts` if you need the exact optional fields. Do not display passwords, key paths, or keyring material.
- `ProfileSidebar.tsx` already formats a subtitle. Do not import that component into the connected shell. Copy the small label rule into the new pure helper so the connection screen does not become a dependency of the explorer.
- `App.tsx` is just under the 1000-line cap in `AGENTS.md`. The popover must be a new component file.

Design constraints from `DESIGN.md`:
- Popover surface is zinc-900, border zinc-800, selected row teal text or a teal bar. No blur, no shadow soup beyond the existing `shadow-xl` used by the schedule toast.
- One primary accent. The current connection is indicated with teal text, not a second hue.
- The control sits in the overlay titlebar. The button and menu need `data-no-drag` so they do not drag the window. See `.app-titlebar [data-no-drag]` in `src/index.css`.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Focused tests | `bun test tests/frontend/connectionSwitcher.test.ts` | all pass, exit 0 |
| Typecheck | `bun run --bun tsc --noEmit` | exit 0 |
| Frontend | `bun run test:frontend` | exit 0 |

Run from the repo root.

## Scope

**In scope**:
- `src/connectionSwitcher.ts` (create, pure helpers)
- `src/components/ConnectionSwitcher.tsx` (create)
- `tests/frontend/connectionSwitcher.test.ts` (create)
- `src/App.tsx` (mount the switcher in place of the bucket/protocol span only)
- `plans/README.md` (status row only)

**Out of scope**:
- Removing Commands, Sync, Links, Settings, or the Local toggle. Plan 004 does the titlebar slim-down.
- Editing `connectProfile`, `doConnectProfile`, or the switch confirmation dialog. Reuse them.
- Connecting to an unsaved form. The switcher lists saved profiles only. "New connection" is not an item. The user still uses Disconnect, then the connection screen.
- Search/filter inside the switcher. Profiles are a short list. If there are more than 12, the menu scrolls; do not add a search input.
- `src-tauri/**`.

## Git workflow

- Branch: `advisor/005-connection-switcher`
- Commit: `feat: switch saved connections from the explorer`
- Do not push or open a PR.

## Steps

### Step 1: Pure labels

Create `src/connectionSwitcher.ts`:

```ts
export type SwitcherProfile = {
  id: string;
  name: string;
  protocol?: string;
  username?: string;
  host?: string;
  port?: string;
  bucket?: string;
  endpoint?: string;
};

export function switcherSubtitle(profile: SwitcherProfile): string {
  const protocol = profile.protocol ?? 's3';
  if (protocol === 'sftp' || protocol === 'ftp' || protocol === 'ftps') {
    const host = profile.host || 'host';
    const user = profile.username ? `${profile.username}@` : '';
    const port = profile.port ? `:${profile.port}` : '';
    return `${protocol.toUpperCase()} · ${user}${host}${port}`;
  }
  const target = profile.bucket || profile.endpoint || protocol.toUpperCase();
  return `${protocol.toUpperCase()} · ${target}`;
}

export function isCurrentProfile(profileId: string, sessionProfileId: string | undefined): boolean {
  return sessionProfileId !== undefined && profileId === sessionProfileId;
}
```

Do not include tunnel hostnames. That detail is not needed to switch, and it would duplicate `ProfileSidebar`.

Tests in `tests/frontend/connectionSwitcher.test.ts`:
- SFTP subtitle contains `SFTP`, the user, the host, and the port
- S3 subtitle contains `S3` and the bucket
- missing session profile id is never current
- matching ids are current
- a different id is not current

**Verify**: `bun test tests/frontend/connectionSwitcher.test.ts` → exit 0.

### Step 2: Build the popover

Create `src/components/ConnectionSwitcher.tsx`.

Props:

```tsx
type Props = {
  profiles: SwitcherProfile[];
  sessionProfileId?: string;
  fallbackLabel: string;
  onConnect: (profileId: string) => void;
  onDisconnect: () => void;
};
```

Behavior:
- Button label is the current profile's `name`, or `fallbackLabel` when no profile id matches (ad-hoc connection).
- `aria-haspopup="menu"`, `aria-expanded`, `aria-label="Switch connection"`.
- Click opens and closes. It must not call `onConnect`.
- Escape closes and returns focus to the button.
- ArrowUp / ArrowDown move a highlighted index inside the open menu. Enter activates it.
- Click outside closes. Use `mousedown` on `document` in an effect, and clean the listener up.
- A profile row calls `onConnect(profile.id)` then closes. If `isCurrentProfile`, the row is `aria-current="true"` and the click only closes.
- Last row is Disconnect. It calls `onDisconnect` and closes. Visually zinc text, not teal. Do not use a red fill; disconnect confirmation owns the danger color.
- Menu is `role="menu"` and rows are `role="menuitem"`.
- Root element has `data-no-drag`.
- Empty profile list still shows the fallback label and the Disconnect row.
- Cap the menu height with `max-h-80 overflow-y-auto galeon-scrollbar`.

Class names: `ui-button ui-button-ghost` on the trigger; menu panel `absolute z-50 mt-1 min-w-64 rounded-lg border border-zinc-800 bg-zinc-900 py-1 shadow-xl`. Current row `text-gale-teal`. Do not add `backdrop-blur` or a new color.

### Step 3: Mount it

In the connected header of `src/App.tsx`, replace the protocol/bucket `<span>` (the one that shows `SFTP` / `FTP` / `FTPS` or `session.bucket`) with `ConnectionSwitcher`.

- `fallbackLabel` is the same string that span shows today.
- `onConnect` looks up the profile in `profiles` and calls `connectProfile(profile)`. Unknown id: no-op.
- `onDisconnect` calls `requestDisconnect`.
- Leave the Galeon word, the Local toggle, ActiveEditors, and the other titlebar buttons in place.
- The header keeps `data-tauri-drag-region`. The switcher root has `data-no-drag`.

Do not mount the switcher on the disconnected connection screen.

**Verify**: `rg -n "ConnectionSwitcher" src/App.tsx` → at least one match. `bun run --bun tsc --noEmit` → exit 0.

### Step 4: Frontend gate

**Verify**: `bun run test:frontend` → exit 0.

## Test plan

- `tests/frontend/connectionSwitcher.test.ts` covers subtitle and current-profile identity only.
- Do not mount the popover. There is no component renderer.
- Model the test on `tests/frontend/presets.test.ts` (direct import, `bun:test`).

## Done criteria

- [ ] `bun test tests/frontend/connectionSwitcher.test.ts` exits 0
- [ ] `bun run --bun tsc --noEmit` exits 0
- [ ] `bun run test:frontend` exits 0
- [ ] `rg -n "connect_storage" src/components/ConnectionSwitcher.tsx src/connectionSwitcher.ts` returns no matches
- [ ] `rg -n "data-no-drag" src/components/ConnectionSwitcher.tsx` returns a match
- [ ] `git status --short` shows only the in-scope files
- [ ] `plans/README.md` row 005 is `DONE`

## STOP conditions

- `connectProfile` no longer accepts a `ConnectionProfile`, or editor confirmation no longer happens inside it. Stop. Do not reimplement confirmation in the switcher.
- The confirming disconnect function from plan 001 cannot be found. Stop. Do not call `setSession(null)` from the switcher.
- Implementing the menu seems to require a Tauri command or a new dependency.
- A verification fails twice.

## Maintenance notes

- Plan 004 must keep this switcher in the titlebar when it removes the extra text buttons.
- If profiles later need tunnel subtitles, extend `switcherSubtitle` and its tests. Do not import `ProfileSidebar`.
- Reviewer: clicking the current profile must not call `connect_storage` again. Clicking another profile must go through `connectProfile` so the editor warning still appears.
