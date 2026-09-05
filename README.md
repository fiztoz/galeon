<p align="center">
  <img src="branding/logo/galeon-mark.svg" alt="Galeon" width="140">
</p>

<h1 align="center">Galeon</h1>

<p align="center"><em>Sail your cloud.</em></p>

<p align="center">
A fast, lightweight desktop client for object & remote storage —<br>
Rust + Tauri + React, built as a modern alternative to Cyberduck and Transmit.<br>
<strong>MIT licensed</strong> · no telemetry · no account · secrets in your OS keychain.
</p>

---

**Gale** (wind at force) × **Galleon** (the heavy-cargo treasure ship): a vessel built to move heavy cargo at the speed of wind. No JVM, no Electron — cold start in under a second, under 150 MB of RAM while it works.

## Features

**Protocols**

- 🪣 Any S3-compatible storage — AWS, MinIO, Cloudflare R2, Wasabi, B2 (path-style & virtual-host, custom endpoints, storage classes, server-side metadata)
- 📁 SFTP, FTP and FTPS — including password auth and importing hosts straight from `~/.ssh/config`
- 🔌 Optional **SSH tunnel** forwarding for S3 and SFTP, with reusable tunnel profiles

**Transfers**

- ⚡ Parallel chunked uploads/downloads with live speed metrics and bandwidth schedules
- ⏸ Pause / resume / cancel, a persistent queue that survives restarts, and automatic retry with backoff on network blips
- 🧩 Conflict resolution (skip / overwrite / rename) and `.part`-based download resume

**Day-to-day**

- 🧭 First-run onboarding, keyboard-first navigation, and a ⌘K command palette
- 🖥 **Dual-pane mode** — local filesystem beside the remote bucket; upload to the folder you are looking at, or "Download here"
- ☀️ Light, dark, or follow-macOS theme
- ✏️ Open a remote file in your external editor and re-upload on save; preview images, text and PDFs inline
- 🔄 One-way sync between a local folder and a remote prefix, on a schedule or on demand
- 🔗 Presigned URL sharing with expiry control and history
- 🔐 Connection profiles with secrets in the **OS keychain** — never in config files; export/import profiles with an explicit, hash-confirmed opt-in for secrets

## Platform support

**macOS is the shipping, tested target** (Apple Silicon and universal `.dmg`). The code is cross-platform Rust + Tauri and Linux/Windows are not deliberately broken, but they are not built, signed, or regression-tested here — treat them as best-effort until someone steps up to own them. CI runs the Rust suite on both Linux and macOS.

## Development

```sh
bun install
bun run tauri dev    # run the app
bun run tauri build  # production bundle
```

Checks and tests:

```sh
npx tsc --noEmit                                  # types
cargo test --manifest-path src-tauri/Cargo.toml --lib -- --skip integrity_e2e   # unit tier, no network
cargo clippy --manifest-path src-tauri/Cargo.toml --lib --tests -- -D warnings
```

The transfer-integrity tier (64 tests) needs a local MinIO — `./scripts/dev-minio.sh up && ./scripts/dev-minio.sh seed`, then drop the `--skip`. See [docs/TEST_INFRA.md](docs/TEST_INFRA.md).

## Contributing

[AGENTS.md](AGENTS.md) is the engineering contract for humans and coding agents alike: where each piece of logic is allowed to live, the file-size ceiling, the secrets rules, and the commit discipline. [DESIGN.md](DESIGN.md) governs UI. Read both before a non-trivial change.

This is a hobby project on a hobby schedule. Open an issue before taking on anything large.

## License

Galeon is [MIT licensed](LICENSE). It ships with no warranty and no telemetry.

### macOS `.dmg` release build

```sh
./scripts/build-dmg-silicon.sh   # Apple Silicon only (faster)
./scripts/build-dmg.sh           # universal (Intel + Apple Silicon)
```

See [docs/RELEASE_MACOS.md](docs/RELEASE_MACOS.md) for Apple signing, notarization, and verification steps.

Stack: Tauri v2 · Rust (tokio + [OpenDAL](https://opendal.apache.org)) · React + TypeScript · TailwindCSS · Bun.

## Project docs

- [**Agent conventions**](AGENTS.md) — architecture map, code-quality bar, docs/release rules for contributors and coding agents
- [Quick start](docs/QUICK_START.md) — first launch, profiles, credentials, settings
- [Product direction](docs/DIRECTION.md) — what Galeon is, pillars, non-goals
- [Roadmap](docs/ROADMAP.md) — Skiff → … → Carrack → **Tender (public ship, done)** → Galleon (store-grade install)
- [macOS release](docs/RELEASE_MACOS.md) — local DMG builds; notarization when public ship is intentional
- [SFTP setup](docs/SFTP_SETUP_GUIDE.md) — key/password auth and troubleshooting
- [Test infrastructure](docs/TEST_INFRA.md) — MinIO-backed integration/e2e notes
- [Design system](DESIGN.md) — semantic UI rules for agents and contributors
- [Brand guidelines](branding/BRANDING.md) — logo system, palette, typography, voice
- [Security & disclosure](SECURITY.md) — how Galeon handles credentials, and how to report a problem
