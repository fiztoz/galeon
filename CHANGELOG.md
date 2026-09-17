# Changelog

All notable changes to Galeon are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Fixed

- Connection forms scroll safely in short windows. File-pane toolbars and tables
  adapt to pane width, selection bars stay within their pane, and the transfer
  drawer no longer covers the listing. Resizing preserves usable split widths.
- Saved profiles, form fields, sorting, and file actions have keyboard-accessible
  controls and labels. Shared dialogs contain focus and support Escape; hidden
  panes and the closed inspector cannot receive keyboard focus.
- Improved light-theme accent contrast, dark secondary-text contrast, focus
  indicators, and reduced-motion behavior.

- Loading an S3 profile refreshes its provider selection and R2 account field
  without overwriting saved connection settings. A previously selected provider
  no longer rewrites another profile's endpoint when its region is edited.
- S3 region presets now offer suggestions while allowing free-text entry, so
  saved and newly entered regions outside the suggestion list remain usable.

### Changed

- JavaScript patch group: lucide-react 1.45, React 19.3, Vite 8.3, and matching
  types.
- Rust patch group in `Cargo.lock`; `dirs` 5.0.1 → 6.0.0; `rcgen` 0.13 → 0.14.10
  (`CertifiedKey::signing_key` in the TLS test fixture).

## [1.0.0-alpha.4]

### Added

- **S3 provider presets.** The connect form offers AWS, Cloudflare R2, Backblaze B2,
  MinIO, Wasabi, DigitalOcean Spaces, and Custom. Picking a preset prefills endpoint,
  region, and virtual-host vs path-style conventions (R2 also takes an account ID).
  Saved profiles reopen on the matching preset via the stored endpoint.
- **Presigned upload URLs.** Share dialog can mint a time-limited PUT grant as well
  as a download link; history entries carry an `operation` badge so uploads are
  distinguishable. Covered by `test_tier2_b26_presign_upload_url_roundtrip`.
- **Cross-pane drag-and-drop.** Local → remote and remote → local drags use custom
  MIME types so Tauri's native Finder/Explorer drop path is left alone.
- **Linux release packages.** CI builds a `.deb` and an AppImage on tag, Sigstore
  signs them with the macOS/Windows artifacts, and they land on the GitHub Release.
- **Benchmark harness.** `scripts/benchmarks/` plus `docs/BENCHMARKS.md` for MinIO
  throughput, 50k-key seed, cold-start, and RSS sampling. Public rival comparisons
  still wait for v1.0.

### Changed

- Transfer-integrity e2e lives in `src-tauri/src/integrity_e2e/` (one module per
  tier) so the 2,815-line file is under the size ceiling. 207 tests (141 unit + 66
  e2e).
- Windows CI runs the unit tier instead of compile-gating. The harness used to
  die at process start (`STATUS_ENTRYPOINT_NOT_FOUND`) because Tauri stamps the
  Common Controls v6 manifest on the app binary only; `build.rs` now embeds the
  same manifest on test binaries.

## [1.0.0-alpha.3]

These notes lived under `[Unreleased]` when the tag was cut and are recorded here
so the section matches what the `v1.0.0-alpha.3` tree actually shipped.

### Added

- **Dual-pane browser (first increment)** — `src/components/LocalPane.tsx` shows the
  local filesystem beside the remote Explorer. Toggle from the header, the command
  palette ("Show Local Pane"), or ⌥⌘L. Selecting files locally and choosing "Upload
  to remote" pushes them into the remote pane's current folder; with dual-pane on,
  the remote side gains "Download here" (context menu) and batch downloads land in
  the visible local directory instead of opening an OS dialog. The toggle and last
  browsed directory persist in `app_settings.json`, and both default so that
  existing settings files keep loading unchanged.
- Two local-FS commands: `list_local_directory` (entries with `isDir`, `size`,
  `modifiedMs`, `isHidden`, `parentPath`; one unreadable entry never fails the
  listing) and `create_local_folder` (single level, so a missing parent errors
  instead of silently building a tree).
- **CI** — `.github/workflows/ci.yml`: `cargo fmt --check`, `clippy --lib --tests
  -D warnings`, the Rust suite, `tsc --noEmit`, and the Vite build. The 64
  transfer-integrity e2e tests run on Linux driven by `scripts/dev-minio.sh`
  (reusing the dev loop rather than re-declaring a service container keeps CI and
  local runs from drifting); macOS runs the unit tier.
- **Light theme.** Settings → Appearance gains a System / Dark / Light control and
  the command palette can cycle the three ("Theme: …"). System follows
  `prefers-color-scheme` live while Galeon is open. The choice persists in
  `app_settings.json`; an unrecognised stored value falls back to system, so a
  settings file from a newer build can never produce an unrenderable state. Dark
  stays the default stylesheet (light is `html[data-theme='light']`), and because
  Tailwind v4 compiles every `zinc-*` utility — alpha ones included, via
  `@supports (color: color-mix(...))` — to `var(--color-zinc-N)`, re-declaring the
  scale re-skins all 916 usages at once while preserving hover/raised ordering.
  The light scale is tuned rather than mirrored: its text tiers hold WCAG AA
  (4.63:1–19.06:1) on the light page.

- **Resizable dual-pane split.** A new `SplitPane` component replaces the fixed 50/50
  layout: drag the divider with the pointer, nudge it with the keyboard
  (`←`/`→`, Shift for a bigger step, `Home`/`End` to fully collapse, `Enter` to
  re-center), double-click to reset to 50/50, and drag firmly past the minimum to
  snap a pane fully shut so either side can take the whole width without reaching
  for the toggle. The separator is a real `role="separator"` with an accessible name
  and `aria-valuenow/min/max`, and its arrow keys stop propagation so a focused
  divider never drives the list behind it. The ratio persists in
  `app_settings.json` next to the other layout preferences.
- Drag *between* the panes was evaluated and deliberately not built: Tauri's
  `dragDropEnabled` is on by default, its config docs state HTML5 drag and drop
  needs it off, and it is the mechanism the Explorer uses to accept Finder drops
  today. Both transfer directions are already available as explicit actions.
  (In-app drag landed later, in 1.0.0-alpha.4.)
- `AppSettings.split_ratio` (`Option<f64>`; absent means 50/50), so the split rides
  the same backward-compatible settings path as the rest.

- **Fonts are vendored; a launch now makes zero third-party requests.** Inter,
  JetBrains Mono and Space Grotesk were fetched from Google Fonts on every start,
  which leaked the user's IP to Google and made "offline by design" only partly
  true. The roman variable faces now ship in `public/fonts/` with their SIL OFL
  license and copyright texts (the license requires them to travel with the font),
  plus a provenance/refresh note. Only the latin + latin-ext subsets are included —
  the rest roughly tripled the payload for no UI string that needs them — and each
  `@font-face` carries a `unicode-range`, so a browser reads only the file it
  actually needs. 304 KB total, italic omitted because the UI has none.
- `Content-Security-Policy` tightened accordingly: `style-src` and `font-src` no
  longer name any external host, so the policy now allows nothing off-machine.

- **Release CI** — `.github/workflows/release.yml`: pushing a `v<version>` tag builds
  the universal macOS `.dmg` and an unsigned Windows NSIS `.exe` and publishes them
  to GitHub Releases with SHA-256 checksums, Sigstore signatures, and a provenance
  footer. The tag must match `package.json`, `Cargo.toml`, and `tauri.conf.json` or
  the job fails, so a release can't be built from a tree that disagrees with its own
  version. Signing is opportunistic: with `APPLE_CERTIFICATE` configured CI imports a
  Developer ID and signs (and notarizes when the notarization secrets are present);
  without it CI publishes an ad-hoc signed build and the release notes say so and
  give the right-click → Open step. An unsigned artifact is never described as
  notarized.
- **Content Security Policy.** `app.security.csp` was `null`, i.e. no policy at all.
  Now a least-privilege map: `default-src 'self'`, `script-src 'self'`, styles from
  self + inline (fonts later vendored; see above), images from self + `data:` +
  `blob:` (the inspector previews object bytes via `createObjectURL`), IPC-only
  `connect-src`, and `object-src 'none'` / `form-action 'none'`. Verified by
  replaying the identical policy as a meta tag over the real built output in a
  headless browser: zero CSP violations, zero failed requests, app rendered.
  Tauri's own injected bootstrap and real IPC still want a `tauri dev` pass.

- Optional **SSH tunnel** forwarding for S3 and SFTP connections
- Password auth for SSH tunnels and SFTP
- Reusable **SSH tunnel profiles**
- Import of `~/.ssh/config` hosts for SFTP connections
- Transfer **auto-retry with backoff** for reliability on network blips
- Native macOS overlay titlebar and application menu
- Profile export/import, S3 SSL bypass for self-signed endpoints, and credential sanitization
- Centralized S3 connect path (`s3_connect::open_s3_operator`)
- Bulk delete with progress tracking and cancellation
- Explorer context menu; URL opening from history and Explorer
- Background S3 prefix-size computation with caching
- S3 metadata read/update via AWS SDK; inline preview in the properties inspector
- Utility script to clean the Rust target directory

### Changed

- **`Explorer.tsx` 1,866 → 1,610 lines** and its eight dialogs no longer repeat themselves.
  `src/components/Dialogs.tsx` is now the app's dialog vocabulary: one `Dialog` shell
  (overlay + card + heading + footer) and the shapes Explorer was re-declaring —
  `TextPromptDialog` (Create Folder and Rename were the same dialog), `DestinationDialog`
  (Move and Copy were the same dialog), `ConfirmDialog` (Delete and Batch Delete were the
  same dialog), plus `ShareLinkDialog` and `ConflictDialog`.
  Transient input a dialog owns — prompt text, chosen destination, expiry, the generated
  URL and its "copied" flash — moved *into* the dialog and is handed back on confirm, which
  deleted seven `useState`s from Explorer and the reset-on-close lines that went with them.
  Handlers now take the value they act on (`handleRename(newName)`, `handleMove(destination)`)
  instead of reading component state.
- **`App.tsx` 1,166 → 937 lines.** It had crept past the ~1k ceiling in AGENTS.md 3.2
  while the dual-pane and theme work landed in it. Three cohesive pieces moved out:
  - `src/types.ts` — `AppSettings`, `ConnectionProfile`, `BandwidthRule`,
    `ProtocolCapabilities`, `PresignHistoryEntry`. Six feature components were importing
    their types from the app shell; they now import from `types`, so the shell is no
    longer a dependency for everyone else's data shapes.
  - `src/components/PresignHistoryModal.tsx` — the Shared Links dialog plus its
    `HistoryItem` row and `formatDuration` helper (only that dialog renders a duration,
    so it stopped being prop-drilled). Derived `createdAt`/`isExpired` moved above the
    handlers that read them.
  - `src/hooks/useLayoutPreferences.ts` — dual-pane flag, local pane path, split ratio
    and theme, with their debounced persistence and the system-theme listener.
- Fixed in passing: the startup settings snapshot was built with `?? ''` on the load
  side but `|| null` on the persist side, so the two never matched and **every launch
  rewrote `app_settings.json` once for no reason**. One `snapshot()` helper now feeds both.

Moves were verified by token-diffing the extracted code against the original: the
modal's only differences are the two intended edits, and the hook's are renames plus
that snapshot fix.

- Replaced 37 `text-zinc-950` usages on accent-filled buttons with a
  `text-on-accent` token, and 5 `bg-zinc-700 hover:bg-zinc-600` secondary-button
  pairs with `bg-raised` / `hover:bg-raised-hover`. Both tokens are seeded with
  the exact values they replaced, so dark mode is pixel-identical — verified by
  screenshotting both themes over CDP.
- The crate root was decomposed. `src-tauri/src/lib.rs` went from 7,176 lines to
  ~180 (module decls + `run()`); the 58 Tauri commands moved to
  `src-tauri/src/commands/<feature>.rs` (18 files, largest 924 lines); shared
  state, wire contracts, and the sync domain became `engine`, `types`, `listing`,
  `editing`, `prefix_size`, `bandwidth`, `connect_config`, `sync_types`,
  `sync_tree`, `sync_plan`, `sync_store`, `schedule`, `tests`. Moves were verified
  byte-identical modulo indentation, comments, and `pub` → `pub(crate)`
  promotion; no behavior changed.
- Cleared every clippy warning in the lib and test targets, so CI can deny them.

- **Product posture is now public.** The repo publishes source and CI-built
  releases, so AGENTS.md §6/§8, DIRECTION.md, ROADMAP.md, RELEASE_MACOS.md,
  QUICK_START.md and the README were reframed away from private/friend-only
  distribution. The honest macOS constraint is kept and stated instead: an
  un-notarized build still trips Gatekeeper, and that is not something publishing
  the source changes. `com.fizto.galeon` stays as the bundle id on purpose — it is
  also the keyring namespace and config directory, so renaming it would make
  existing users' stored credentials and profiles disappear without a migration.

### Fixed

- Command palette rows had **no hover feedback** and the properties-inspector
  content-type / storage-class inputs had no background or border, because they
  used `zinc-850` / `zinc-750` — not real Tailwind steps, so v4 emitted zero CSS
  for all six usages. Mapped to the intended neighbours and confirmed the rules
  now appear in the built stylesheet.
- `md5` 0.8 compatibility: `md5::Context::compute()` is deprecated in favour of
  `finalize()`, and CI denies warnings — the streaming file-hash helper now
  finalizes the context. Digest values are unchanged.
- **OpenDAL 0.50 → 0.59.** Finished-operator construction (no `.finish()`),
  batch deletes via `delete_iter`, recursive deletes via
  `delete_with(..).recursive(true)`, string-based schemes (`S3_SCHEME`), and
  jiff timestamps (RFC3339 wire strings unchanged). The explicit TLS bypass now
  swaps the operator's HTTP transport (`with_context`, layers preserved) instead
  of the removed builder hook, which also moved our reqwest to 0.13 to match
  `opendal-http-transport-reqwest`. Covered by a new bypass-transport round-trip
  e2e test; no behavior change intended.
- FTPS default port and credential resolution
- Connection/explorer race conditions, with clearer error states
- Underscores allowed in S3 bucket names for legacy compatibility
- Scheduler spawn and sync apply error handling

## [1.0.0-alpha.1]

### Added

- macOS distribution scaffolding: hardened runtime, entitlements, and universal `.dmg` build via `scripts/build-dmg.sh`
- Local Apple Developer ID signing and notarization support (credentials supplied via environment variables)
- Dynamic app version display on the connection screen
- `docs/RELEASE_MACOS.md` with signing, notarization, and build instructions
- First-run onboarding wizard with **Choose your isle** storage-type selection (S3, SFTP, FTP/FTPS)
- Settings panel: app metadata, privacy/trust copy, credential session status, and **Lock credentials now**
- Local app settings (`app_settings.json`) for onboarding completion — no secrets stored
- Session credential cache (`src-tauri/src/credentials.rs`) — lazy keyring reads, fewer macOS password prompts
- Command palette actions: Open Settings, Show Onboarding, Lock Credentials Now
- `docs/QUICK_START.md` for first-launch and credential behavior

### Changed

- Version bumped to `1.0.0-alpha.1` across `package.json`, `Cargo.toml`, and `tauri.conf.json`
- Bundle target narrowed to `.dmg` for the v1.0 macOS-first distribution milestone
- Profile listing returns metadata only; secrets load on connect/edit (not at startup)
- Existing users with saved profiles auto-skip onboarding on first launch after upgrade
