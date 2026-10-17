## [Unreleased]

### Added

- **Queue remainder + ETA in the transfer drawer header.** While transfers run, the header
  now answers "how long will this take?" beside the aggregate speed: bytes still owed by
  every unfinished transfer (queued, active, paused, retrying, verifying) rendered as
  "1.8 GB left", plus "~2m 14s" computed from the current active throughput only. A fully
  paused queue shows the remainder without fabricating an ETA; a drained queue shows
  neither. The math lives in one pure helper (`queueDrain`), unit-tested over the awkward
  mixes — terminal rows owing nothing, a retried counter briefly reporting more bytes than
  the total, and minute-boundary rounding.

## [1.0.0-alpha.7] - 2026-10-17

### Added

- **Scheduled-delete budget.** A saved sync profile with "Delete extraneous at destination"
  now carries a separate `maxScheduledDeletes` limit: the most destination objects a
  *scheduled* run may permanently delete. `0` (the default) means a scheduled run never
  deletes. This closes the unattended hole in `delete_extraneous`: until now, a stale or
  emptied source folder mirrored itself onto the destination on a timer and erased everything
  that had gone missing from the source, with no diff, no confirmation, and no number anywhere.
  Manual runs are unaffected — they preview the diff and confirm before anything is removed.
  The budget is all-or-nothing: a scheduled run whose plan needs more deletions than its limit
  allows performs **none** of them (uploads still happen) rather than stopping partway, so
  "scheduled deletes at most N" stays literally true and the destination can never be stranded
  half-mirrored by a run nobody was watching. Existing scheduled profiles load with the safe
  default of `0` and must opt back into deletions deliberately.

### Changed

- The scheduler event and run history now say *why* nothing was deleted: a budget-refused
  run carries `deletesBlocked` (planned/cap) in the `schedule-run-complete` event, the profile
  badge, and the run row ("deletes withheld") with the two numbers spelled out in the detail.
  The run still records as a success — the refusals are a policy flag, not a failure.
- The previous profile-runner command (`run_sync_profile_now`) executed a saved profile's
  `delete_extraneous` deletions directly with no diff preview and no confirmation. It had no
  remaining caller after the delete-confirmation flow landed, so it has been removed rather
  than kept as an unreviewed path.

### Fixed

- Manual sync runs executed from the panel are now in the run history. Until this ships,
  only scheduled (profile-pipeline) runs were recorded — the panel's apply ran
  `execute_sync_plan` and its work vanished from the history. A manual run now writes the
  same kind of record with trigger `manual`, attributed to the loaded sync profile as long
  as the settings it executed still match it (editing what the run does — source,
  destination, direction, checksum, or delete behavior — records it ad-hoc under
  "Manual sync" instead: the log never blames a profile for settings it did not have), with
  its deletions listed even when the run had failures. Empty plans (nothing to do) record
  nothing — with no deletions, the panel's own "0 changes" view is the whole story.
- The sync panel's "Apply" read `execute_sync_plan`'s answer as a raw failure count, but the
  backend (since alpha.6) returns a run summary object — so the panel could have mis-typed the
  response and mishandled partial runs. It now reads the summary's failure list directly.

## [1.0.0-alpha.6] - 2026-10-17

### Added

- A failed or cancelled transfer can be retried from the transfer list. `finalize_transfer_job`
  removes a transfer's in-memory control when it *ends*, so a failed transfer was unreachable
  afterwards and resuming it answered "Transfer not found" — the only recovery was starting the
  transfer again by hand. Retrying rebuilds it from its queue entry; a download resumes from its
  `.part` file rather than re-fetching what already arrived.
- **Sync run history.** Every run — scheduled or manual — is recorded to `sync_runs.json` with
  what it uploaded, downloaded, **deleted**, and failed, plus the paths it removed. Previously a
  scheduled run's only trace was a transient event, so if the app was closed there was no way to
  answer "did that job delete my files last Tuesday?". Runs that deleted anything are flagged
  prominently, and unattended runs are distinguished from manual ones. Keep the last 100 runs;
  per-run detail lists are capped so one large deletion cannot bloat the file.

### Changed

- A sync run now reports what actually happened instead of what it queued. `execute_sync_plan`
  returned as soon as every transfer had been handed to the transfer pipeline, so a run whose
  transfers then failed reported success — and the scheduler recorded `success: true` and advanced
  the schedule for a run that never completed. It now waits for its transfers to finish. The
  transfers already ran concurrently, so this delays the report rather than slowing the work.
- The sync diff now warns when applying it would overwrite a *newer* file at the destination.
  One-way sync means the source wins by design, and the plan's "size differs" reason gave no hint
  that something newer was about to be replaced. Nothing about the decision changed.

### Fixed

- A sync plan whose entries disagree about direction is now rejected instead of executed.
  Every entry carries the direction it was computed for; a mixed plan can only come from two
  diffs being combined or a plan edited in flight, and its deletes would resolve against the
  wrong roots.
- A profile export containing secrets is now written owner-only (0600) instead of at the umask
  default. It is plaintext credentials on disk in the user's Downloads folder.
- A failed download no longer destroys the file it was replacing. The finished `.part` is
  verified before it is renamed over the destination; previously the rename happened first, so
  a checksum or size mismatch left a corrupt file where a good one had been, with the only trace
  being a failed-transfer event. A failed verification also leaves the `.part` behind, so the
  retry can still resume.
- Expired presigned URLs are pruned from the history instead of lingering until the 50-entry
  cap. They are bearer tokens for the object, and `config.json` kept them past their validity
  window. An unparseable timestamp keeps the entry — losing a live URL the user still needs
  costs more than keeping a stale one.
- The app's on-disk state stores (`config.json`, `app_settings.json`, `transfers.json`,
  `sync_profiles.json`, `ssh_tunnel_profiles.json`) are written owner-only (0600 on unix)
  instead of at the umask default, and pre-existing loose files are tightened on their next
  write. Credentials are not in these files — they stay in the OS keyring — so this is
  defence-in-depth for the presigned URLs, local paths and remote prefixes they do contain.
- A scheduled sync profile with delete-extraneous enabled could erase an entire remote
  prefix. An unmounted volume, a renamed folder, or a typo makes the local tree walk return
  empty, every remote object then looks "extraneous", and they were deleted unattended on a
  timer and reported as a successful run. The planner now never deletes from an empty source
  in either direction and says why it skipped.
- "Run sync profile now" in the command palette no longer executes a profile directly. It
  performed the profile's deletions with no diff preview and no confirmation, and a failure
  only reached the console. It now opens the Sync panel, previews the diff, and routes Apply
  through the existing delete confirmation.
- A sync diff can no longer be applied against settings it was not computed for. Back-editing
  the form left the old plan in place, so Apply could delete files resolved against a different
  folder than the one reviewed — while the confirmation banner counted deletions from the stale
  plan. The diff is now marked stale when any input that feeds it changes, and Apply is blocked
  until it is recomputed.
- A corrupt or half-written `sync_profiles.json` no longer silently kills every scheduled sync
  forever. The store is written via a same-directory temp file and an atomic rename.
- Concurrent writes to the sync-profiles store no longer lose updates, which could revert
  `next_run_ms` to an already-due value and re-fire a profile unattended on the next tick.
- Saving a profile after changing its endpoint, bucket, or protocol no longer rebinds the old
  secrets to the new host. The form pre-fills keys from the keyring, so editing the target
  silently sent credentials intended for one host to another. Manual saves now clear the vault
  entry on an identity change, matching what the import path already did.
- "Lock credentials now" only cleared the profile-secret cache. `S3SessionConfig` holds the
  secret key in plaintext per session, and live sessions carry credentials inside their OpenDAL
  operator or ssh2 session, so those copies survived for the life of the process. Lock now
  clears sessions, S3 configs, and tunnels as well — note that this disconnects open sessions
  and stops in-flight transfers.
- Cached credentials never expired. `loaded_at_ms` was written on every cache entry and never
  read, so plaintext secrets sat in memory for the whole session. Entries now expire after 15
  minutes and the next read re-fetches from the keyring.
- The profile-import TOCTOU hash used MD5, a practical collision primitive. Now SHA-256, and the
  verification policy is extracted into a tested function — it was previously an untested block
  inside the command.
- A render error no longer blanks the window. An error boundary wraps the app and offers Try again
  or Reload, and states that profiles and keychain credentials are untouched.
- A panic inside a transfer body no longer leaves a transfer spinning forever. Transfer jobs run in
  `tokio::spawn`, where an unwinding task is discarded silently — no failure event, and the queue
  entry stayed `active` until the next app launch. Panics are now converted into an ordinary
  failure so the job always finalizes.
- Remote directory listing no longer duplicates its protocol logic: `list_directory` and the sync
  tree walker share one implementation.

### Changed

- The Explorer list is windowed, so a flat prefix with tens of thousands of objects no longer
  mounts every row. Row heights are measured, because the compact layout renders a second date line.
- `list_directory` is capped at 20,000 objects per call and reports `truncated`. The UI shows
  "showing the first N" rather than silently presenting a partial bucket as complete. Sync
  deliberately does not cap — a truncated plan would omit files the user believes are backed up.

### Added

- WebDAV connections: connect to Nextcloud/ownCloud, NAS boxes, and shared-hosting DAV URLs with optional username/password (anonymous shares work too).
- Azure Blob connections: account name + account key, container in the bucket field; the endpoint derives from the account name or is overridden for sovereign clouds.
- Google Cloud Storage: service-account JSON on disk (path stored; key stays outside the keyring) or pasted JSON into the keyring.
- Auto-reconnect resumes queued transfers on app restart for WebDAV, Azure, and GCS (not only S3); the reopened session now reports its protocol.
- Per-protocol capabilities for the three new protocols mirror OpenDAL 0.59's actual service support (multipart, presigned URLs, bulk delete).


## [1.0.0-alpha.5] - 2026-10-07

### Fixed

- Starting a new connection clears pending profile credential reads. Connection
  errors scroll into view, and Connect stays disabled while credentials load.
- Restore Linux integration checks by building the MinIO test fixture from
  pinned official source revisions after public container images became unavailable.

- Unify status colors in both themes, radio and time controls, focus outlines, disclosure/close icons, and older dialog size limits.

- Theme Region autocomplete suggestions while preserving custom regions and keyboard selection.

- Replace native dropdown menus with themed, keyboard-accessible controls throughout the app and unify checkbox styling.
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

- Refine the connection screen with grouped destination and credential fields,
  labelled actions in a persistent footer, and a clear New connection action.
- Give connected remote and local explorers full-width tables, sticky headers,
  aligned size/date columns, quieter filters, and consistent compact controls.
- Update Tauri and its JavaScript API/CLI to 2.12.1, dialog to 2.8.1, opener to
  2.7.0, OpenDAL to 0.59.3, `dirs` to 7.0.0, and `suppaftp` to 12.0.1.
- Refresh JavaScript dependencies including lucide-react 1.50, React 19.3,
  Vite 8.3.2, and matching types; update the Rust dependency lockfile and the
  `rcgen` TLS test fixture to 0.14.10.

### Security

- Update rustls to 0.23.45, addressing RUSTSEC-2026-0285 (TLS 1.3 handshake
  messages accepted across encryption-level boundaries).
- Update the build dependency `source-map-js` to 1.2.2, addressing
  GHSA-68fv-2mgg-jv7q (denial of service from indexed source-map offsets).

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
