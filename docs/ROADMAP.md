# Galeon — Roadmap

Releases are codenamed after sailing ships, smallest to largest — the fleet grows with the product. Versions are intentions, not promises; this is a hobby project and the pillars in [DIRECTION.md](DIRECTION.md) decide ties.

```
v0.1 Skiff ──▶ v0.2 Sloop ──▶ v0.3 Brigantine ──▶ v0.4 Frigate ──▶ v0.5 Carrack ──▶ v0.9 Tender ──▶ v1.0 Galleon
                                                                                    public ship     store-grade
                                                                                    (v0.9 done → next: v1.0)
```

---

## Current distribution posture

Galeon is a **public repository with CI-built releases**. Source, issues, and the
macOS `.dmg` artifacts produced by `.github/workflows/release.yml` are all public.

| Do now | Still deferred |
|--------|----------------|
| Public repo; CI builds `.dmg` on a `v*` tag → GitHub Release | Auto-update (`tauri-plugin-updater`) — needs a trusted signing story and an availability commitment |
| Ad-hoc signed builds, explicitly labelled **not notarized** | Paid **Developer ID** + **notarization** — optional, enabled by signing mode and CI secrets |
| One-time Gatekeeper step documented: right-click → **Open** | "Double-click and it just works" for strangers |
| Product polish users actually feel | Windows/Linux public installers, docs site, benchmark PR |

**The honest constraint:** a build that is not notarized still trips Gatekeeper on
first launch for anyone who didn't build it themselves. Publishing the source and
the artifact doesn't change that, and auto-update doesn't fix it. Until Apple
notarization is configured, release copy explains the per-app Gatekeeper approval
flow in [RELEASE_MACOS.md](RELEASE_MACOS.md), rather than implying a store-grade install.

Install story: download the `.dmg` from Releases → drag Galeon to Applications →
**right-click → Open** the first time → replace the app for each new release.

Technical notes: [RELEASE_MACOS.md](RELEASE_MACOS.md). Agent rules: [AGENTS.md](../AGENTS.md) §6.

---

## ✅ v0.1 — Skiff *(Phases 1–5 complete)*

The smallest thing that floats. Already done:

- S3-compatible engine on OpenDAL (path-style + virtual-host, custom endpoints, storage class)
- Streaming uploads/downloads with live speed/progress events; drag-and-drop in
- Full object management: folders, rename, recursive delete, batch select/delete/download
- Saved connection profiles with secrets in the **OS keyring**
- Presigned URL sharing with history log
- Search, quick filters, column sorting
- Verified: 60 fps under load, < 150 MB RAM, no binary data over IPC

## ✅ v0.2 — Sloop · *Bulletproof transfers*

The transfer engine grew up before anything widened. All landed:

- ✅ **Multipart / parallel-chunk** uploads & downloads (concurrent chunks)
- ✅ **Pause / resume / cancel** per transfer; auto-**retry with backoff** on network blips
- ✅ **Persistent queue** — transfers survive app restart
- ✅ Conflict policy on collision: overwrite / skip / rename, with "apply to all"
- ✅ Copy & move objects between folders; Move/Copy share one destination dialog
- ✅ Checksum verification after transfer (MD5 + multipart ETag reconstruction)
- ✅ Bandwidth rules, including off-peak schedules

*Definition of done:* yank the Wi-Fi mid-100GB-upload, reconnect, and the queue finishes without user action.

## v0.3 — Brigantine · *Every sea*

Cash in the OpenDAL bet — generalize the connection model from "S3 profile" to "storage profile."

- ✅ **SFTP** and **FTP/FTPS** (the Cyberduck-parity must-haves) — in tree, with native password/key session tests and `~/.ssh/config` import
- **WebDAV**, **Azure Blob**, **Google Cloud Storage**, **Backblaze B2 native** — still open
- **Provider presets**: AWS / Cloudflare R2 / MinIO / Wasabi / B2 pre-fill endpoint quirks — still open
- ✅ Protocol-agnostic capabilities model (`ProtocolCapabilities` travels with the profile)

*Definition of done:* a Cyberduck user can migrate their five most-used bookmarks in five minutes.

## ✅ v0.4 — Frigate · *Power UX* *(complete except in-pane drag — see v0.9 notes)*

The release that makes people switch and stay.

- ✅ **Edit in external editor**: open remote file, watch for saves, auto re-upload
- ✅ **Quick preview** pane: images, text, PDFs inline, plus object metadata in the inspector
- ✅ **Command palette** (⌘K): jump to profile, path, or action
- ✅ **Dual-pane mode**: local ⇄ remote side by side — `LocalPane` beside the remote Explorer (⌥⌘L / toolbar / ⌘K), local→remote upload and remote→local "Download here", toggle + last directory persisted in `app_settings.json`, **resizable split** (`SplitPane`: pointer drag, keyboard-operable separator, snap-to-collapse, double-click reset, ratio persisted). Still open: drag *between* the panes (deliberately not built — see v0.9).
- ✅ Light theme (System / Dark / Light, follows macOS live) — see DESIGN.md §2
- ✅ Keyboard navigation; object properties inspector

## ✅ v0.5 — Carrack · *Sync & integrity* *(Phases 11–12 complete)*

- **One-way sync** with dry-run diff ✅
- Checksum-based comparison; re-runnable sync profiles ✅
- **Transfer scheduling** for sync profiles ✅
- **Off-peak bandwidth rules** on connection profiles ✅

## ✅ v0.9 — Tender · *Public-ship readiness* *(complete)*

Stability and UX good enough to publish.

**Landed:**

- macOS `.dmg` build path, now driven by **CI** on tag rather than by hand
- First-run onboarding + offline trust messaging (Phase 14) ✅
- Credential session cache, lazy keyring reads, Lock credentials now (Phase 14) ✅
- Native-feeling macOS chrome (overlay titlebar, system menu) ✅
- Profile import/export, SSL bypass path for lab MinIO ✅
- Transfer auto-retry + backoff; conflict skip/overwrite/rename; multipart concurrent chunks ✅
- Explorer / connection polish: neutral S3 defaults, reliable double-click connect, empty-state CTAs, clearer errors ✅
- **CI gate** — fmt, clippy `-D warnings`, the Rust suite, tsc, Vite build ✅
- **Architecture pass** — `lib.rs` 7,176 → ~180 lines; commands split into 18 feature modules ✅
- **Dual-pane browser** (local ⇄ remote) first increment ✅
- **Light theme** (system / dark / light) ✅
- **Resizable dual-pane split** (`SplitPane`) — pointer drag, keyboard-operable
  separator, snap-to-collapse so one pane can take the full width, double-click to
  reset, ratio persisted in `app_settings.json` ✅
- MIT license, SECURITY.md, public-facing README, CSP, release CI ✅

**Open follow-ups:**

- ~~Self-host the UI fonts so a launch makes no third-party request~~ ✅ vendored
  under OFL in `public/fonts/`; CSP now allows no external host at all
- CSP is set and verified against the built assets, but still wants a `tauri dev`
  pass to confirm Tauri's injected bootstrap and real IPC
- Drag **between** the panes. Deliberately not built: Tauri's
  `dragDropEnabled` defaults to true and its own config docs say HTML5 drag and
  drop requires turning it off, which is exactly how the Explorer receives drops
  from Finder today. In-app drag would trade a working feature for a convenience.
  Both directions already have explicit, keyboard-reachable actions — "Upload to
  remote" in the local pane, "Download here" plus dialog-free batch download in the
  remote pane. Revisit only with a plan to keep OS drops (e.g. route internal drags
  through app state instead of HTML5 DnD).
- Dual-pane is done except drag *between* the panes (see above). Revisit only with a plan to keep OS drops.

*Definition of done:* a stranger can clone or download, use Galeon for real work,
and the repo states its install friction honestly.

## 🧊 v1.0 — Galleon · *Store-grade install*

The public repo and CI releases already exist; what is left here is removing the
install friction, not opening the doors.

- **Developer ID** sign + **notarize** + staple macOS `.dmg` (Gatekeeper clean) — opt into `MACOS_SIGNING_MODE=developer-id` with the documented secrets
- One stable public download name/link + short install copy (download → open → Applications → launch)
- **Auto-updates** (`tauri-plugin-updater`) via **public** release assets *or* a private bucket/proxy — never a PAT baked into the app
- Windows `.msi`, Linux AppImage/`.deb` if cross-platform still matters
- Docs site; i18n scaffolding
- Published **benchmark suite** vs Cyberduck & FileZilla

*Definition of done:* a stranger downloads Galeon and installs without Terminal folklore.

> Opt-in crash reporting was dropped from this list: it contradicts DIRECTION.md's
> no-telemetry pillar and nobody has asked for it.

---

## 🌅 Beyond the horizon (post–public-1.0 candidates)

- **Mount as local drive** (FUSE / WinFsp) — deliberately deferred  
- **`galeon` CLI** sharing the Rust core crate  
- **Encrypted vaults** (Cryptomator-compatible)  
- Plugin / extension API for community protocols  

---

## Cross-cutting workstreams (every phase)

- **CI:** ✅ in place — `.github/workflows/ci.yml` gates `cargo fmt --check`,
  `clippy --lib --tests -D warnings`, the Rust suite, `tsc --noEmit`, and the Vite
  build. Linux runs the full suite against MinIO via `scripts/dev-minio.sh`;
  macOS runs the unit tier. Details: [TEST_INFRA.md](TEST_INFRA.md)  
- **Repo hygiene:** keep `docs/` operational — direction, roadmap, setup, release notes. Code + this roadmap are source of truth for “what’s next.”  
- **Benchmarks:** optional scripts for regressions; **public** comparison marketing waits for v1.0  

---

## Decision log (distribution)

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Audience | **Public** | Source repo, issues, and CI-built release artifacts are public; install friction is documented honestly rather than papered over |
| Public installer releases | **Yes — built by CI on tag** | Supersedes the earlier "deferred" call. Artifacts come from `.github/workflows/release.yml`, never from a hand-run local script |
| Apple paid program | Deferred, optional | Ad-hoc signed, unnotarized builds publish by default; verified Developer ID/notarization is opt-in |
| Auto-update | Deferred | Needs trusted signatures + a feed; no update server planned. Manual download per release |
| Update hosting later | Prefer public Releases *or* object storage | No GitHub PAT inside the app |
| Bundle identifier | Keep `com.fizto.galeon` | It is also the keyring namespace and `app_config_dir`; renaming orphans existing users' credentials and profiles without a migration (AGENTS.md §6) |
| Third-party runtime requests | **None** | UI fonts are vendored under OFL in `public/fonts/` and the CSP names no external host, so a launch makes zero outbound requests. Verified, not asserted |
