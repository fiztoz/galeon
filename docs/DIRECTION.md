# Galeon — Product Direction

> **Galeon is a fast, lightweight, modern desktop client for cloud and remote storage — a Rust + Tauri alternative to Cyberduck.**

## Why this should exist

The incumbent clients all leave an opening:

| Client | Weakness Galeon exploits |
|---|---|
| **Cyberduck** | Java-based: slow startup, heavy memory, dated UX. The protocol coverage is great; the experience isn't. |
| **FileZilla** | Ancient UI, FTP-era mental model, installer-bundleware reputation. |
| **Transmit** | Excellent — but macOS-only and paid. |
| **WinSCP** | Windows-only. |
| **rclone** | Phenomenal engine, no GUI. Power users keep it in a terminal tab next to a worse GUI app. |

Nobody owns *"cross-platform + fast + modern + open source."* That quadrant is Galeon's.

**Positioning:** for developers and self-hosters who live in S3-compatible storage (AWS, MinIO, R2, B2, Wasabi), Galeon is the client that opens in under a second, idles under 150 MB, and moves data as fast as the line allows — without a JVM, without Electron.

## Product pillars

Every feature decision should trace back to one of these. If it doesn't, it waits.

1. **Weigh nothing, carry everything.** Small binary, instant launch, < 150 MB RAM under load (already verified in Phase 4). Tauri + Rust is the moat — never compromise it with heavy webview dependencies.
2. **Speed is the feature.** Parallel chunked transfers, resumable queues, virtualized 60 fps lists. Publish benchmarks against Cyberduck and FileZilla; make speed a marketing asset, not a vibe.
3. **Trust the hold.** Credentials live in the OS keyring (done), zero telemetry by default, destructive actions always confirmed. The repo and its release artifacts are public; **Developer ID + notarized** installers are the v1.0 goal, and builds that are not notarized must say so honestly rather than imply a store-grade install. Boring and predictable about data safety.
4. **One deck for every sea.** OpenDAL is the second moat: one Rust abstraction already speaks S3, SFTP, WebDAV, Azure, GCS, B2 and more. Protocol breadth is a configuration problem for Galeon, not a rewrite — Cyberduck's main advantage, neutralized.
5. **Keyboard-first, modern UX.** Command palette, full keyboard navigation, sensible defaults, progressive disclosure for advanced S3 knobs (host style, storage class — as Phase 5 already does).

## Target users, in order

1. **Developers / DevOps** — poking at buckets daily, MinIO in CI, R2 in production. They decide with their feet and write the blog posts.
2. **Self-hosters** — MinIO/Garage/SeaweedFS on a NAS; want a native client, not a web console.
3. **Media professionals** — photographers/videographers pushing large assets to B2/Wasabi; care about resumable big-file transfers above all.

## Non-goals

Saying no is the strategy for a hobby-scale project competing with funded ones:

- **Not a sync service.** No accounts, no Galeon cloud, no background daemon (one-way sync as a *feature* comes in v0.5; Dropbox is not the mission).
- **Not a drive mounter** (Mountain Duck's job) — until post-1.0, if ever. FUSE/WinFsp is a support-burden multiplier.
- **No Electron, no JVM** — obviously.
- **No protocol soup before the core is excellent.** S3 flows must be best-in-class before SFTP lands.
- **Not a hosted service.** The source and CI-built releases are public, but there is no Galeon cloud, no account system, no update feed, and no support SLA. Publishing the code is not the same as promising availability. See [ROADMAP.md](ROADMAP.md) for what is deliberately still deferred (auto-update, paid notarization).

## Design principles

- **Instant feedback:** every action acknowledges in < 100 ms; long work goes to the transfer drawer.
- **The list is the product:** browsing must stay 60 fps at 100k objects (virtualize before it hurts).
- **Heavy data never crosses the IPC bridge** — only metadata and progress numbers (the Phase 4 invariant; keep enforcing it).
- **Progressive disclosure:** the connect form is 5 fields; everything else folds away.
- **Keyboard parity:** anything clickable is reachable without a mouse.

## What "winning" looks like

### Public repo (v0.9 Tender) — the bar today

- Cold start → browsable bucket in **< 1 s** on a typical Mac.
- Idle RAM **< 150 MB**, no obvious leak over a long transfer session.
- A non-technical user can complete a real upload/download after **one** guided install (right-click → Open is acceptable and documented as such).
- `git clone` → `bun install` → `bun run tauri dev` works from the README alone, and CI is green on `main`.

### Store-grade install (v1.0 Galleon)

- Same performance bar, plus **Developer ID + notarized** macOS installer.
- A stranger goes from download → first successful transfer in **< 60 s** without Terminal folklore.
- Installer size **< 25 MB**; optional published benchmarks vs Cyberduck / FileZilla.
- Auto-update only with trusted signatures and a feed that does **not** embed a GitHub PAT in the app.
