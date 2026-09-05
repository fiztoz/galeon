# Galeon — Agent & Contributor Conventions

This file is the **single source of direction** for coding agents (Grok, Claude, Cursor, etc.) and humans changing this repo. Follow it unless the user explicitly overrides.

Product intent lives in [`docs/DIRECTION.md`](docs/DIRECTION.md). UI tokens and anti-patterns live in [`DESIGN.md`](DESIGN.md). Brand assets live in [`branding/BRANDING.md`](branding/BRANDING.md).

---

## 1. What Galeon is

- Desktop **object / remote storage client** (S3-compatible first; SFTP/FTP/FTPS also).
- Stack: **Tauri v2 + Rust (OpenDAL, tokio) + React/TypeScript + Tailwind + Bun**.
- Pillars: lightweight, fast, keyring-backed secrets, keyboard-first, progressive disclosure.
- **Not** Electron/JVM. Do not add heavy webview frameworks or telemetry by default.

---

## 2. Read before you edit

| Area | Canonical home |
|------|----------------|
| Product / non-goals | `docs/DIRECTION.md` |
| Roadmap | `docs/ROADMAP.md` |
| UI system (Stitch-style semantic) | `DESIGN.md` (repo root — keep this name) |
| Brand / logo | `branding/BRANDING.md` |
| macOS ship / notarization | `docs/RELEASE_MACOS.md` |
| S3 connect, sanitize, SSL, OpenDAL operator | `src-tauri/src/s3_connect.rs` |
| Profile export/import | `src-tauri/src/profile_io.rs` |
| S3 metadata (AWS SDK) | `src-tauri/src/s3_metadata.rs` |
| Credentials / keyring / cache | `src-tauri/src/credentials.rs` |
| **Tauri command layer** (thin) | `src-tauri/src/commands/<feature>.rs` |
| Runtime state (`GaleonEngine`, sessions, controls) | `src-tauri/src/engine.rs` |
| Frontend wire contracts (camelCase payloads) | `src-tauri/src/types.rs` |
| Listing / prefix sizes / editing / bandwidth | `src-tauri/src/{listing,prefix_size,editing,bandwidth}.rs` |
| Sync domain (plan, trees, schedules, store) | `src-tauri/src/sync_{plan,tree,types,store}.rs`, `schedule.rs` |
| SSH tunnels / config / known hosts | `src-tauri/src/ssh_*.rs` |
| App bootstrap + `invoke_handler` only | `src-tauri/src/lib.rs` (~180 lines) |
| Profile import/export UI | `src/components/ProfileImportExport.tsx` |
| Connection form / connect flow | `src/components/Connection.tsx` |
| Local filesystem pane (dual-pane) | `src/components/LocalPane.tsx` |
| App shell / profiles state | `src/App.tsx` |
| Theme CSS variables | `src/index.css` |

**Do not re-introduce** S3 builder + sanitize + SSL wiring inlined into `connect_bucket` / `connect_storage` / `auto_reconnect`. Use `s3_connect::open_s3_operator` (or the smaller helpers in that module).

**Do not** grow `Connection.tsx` with export/import modals again — that lives in `ProfileImportExport.tsx`.

---

## 3. Code quality bar (from review practice)

Agents must treat these as **default blockers**, not optional nits.

### 3.1 Prefer deletion of complexity over rearrangement

- Look for a **code-judo** move: one helper, one state model, one sanitize path — not three copies.
- Prefer pure functions + thin Tauri commands over logic buried in UI or mega-`lib.rs` blocks.
- If a change only moves spaghetti around, restructure until branches disappear.

### 3.2 File size

- **Do not** push a focused module/component from under ~1000 lines to over ~1000 lines without extracting first.
- Soft targets:
  - React components: extract when a feature (modals, IO, wizards) can stand alone.
  - Rust: new domain logic → new `src-tauri/src/<domain>.rs` module; register in `lib.rs` with `pub mod …`.
- `lib.rs` is the app root only (~180 lines: module decls, the shared `use`
  prelude, `run()` + `invoke_handler`). **Keep it there** — new behavior goes in a
  domain module or a `commands/<feature>.rs`, never back into `lib.rs`.

### 3.3 No special-case spaghetti

- Do not bolt feature flags / one-off `if protocol == …` into unrelated paths when a helper or policy object fits.
- Import/export, SSL bypass, credential rebinding rules belong in `profile_io` / `s3_connect` / `credentials`, not scattered in the UI.

### 3.4 Types and contracts

- Prefer explicit structs over `any` / loose JSON.
- Optional params that paper over invariants are bad (example: secrets import **must** pass `expectedContentHash` / `expected_content_hash` — do not make that skippable for the secrets path).
- Frontend invoke payloads must match Rust `#[serde(rename_all = "camelCase")]` fields.

### 3.5 Canonical helpers — reuse them

| Need | Use |
|------|-----|
| Clean paste junk / quotes / ZWSP | `s3_connect::clean_connection_field` / `clean_connection_opt` |
| Validate bucket / normalize endpoint | `s3_connect::validate_bucket_name` / `normalize_endpoint` / `sanitize_s3_connection` |
| Soft-clean profile before config write | `s3_connect::sanitize_profile_for_storage` |
| Open S3 OpenDAL operator + layers | `s3_connect::open_s3_operator` |
| TLS bypass for OpenDAL | `s3_connect::apply_s3_ssl_settings` (via open path) |
| TLS bypass for AWS metadata client | `s3_metadata::build_s3_client` honors `danger_disable_ssl_verification` |
| Profile merge / import / export | `profile_io` |
| Keyring load/save/delete | `credentials` |

If you need “clean a string for connection fields,” **do not** invent `clean_s3_*` again under another name without updating call sites to the canonical API.

### 3.6 Security & secrets

- Secrets live in the **OS keyring** (and short-lived cache), never in committed config or logs.
- Never log access keys, secret keys, passwords, or export files that include secrets.
- Export with secrets is opt-in; import with secrets requires explicit confirm + content hash (TOCTOU).
- `danger_disable_ssl_verification` is dangerous: force off on profile **import**; user must re-enable deliberately.
- Overwrite import: if connection identity changes without new secrets, **clear vault** for that profile id (no rebinding old secrets to a new host).

### 3.7 Commits & diffs

- **Do not** mix pure rustfmt/prettier of unrelated files with feature work in the same commit.
- Keep versions in sync when bumping: `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json` (build scripts enforce this).
- Commit style in this repo: short imperative subject (`feat:`, `fix:`, `refactor:`, `docs:`), body explains why when non-obvious.
- Do not commit secrets, app-specific passwords, or notarization credentials.

### 3.8 Tests

- Domain logic in Rust should have unit tests next to the module (`#[cfg(test)]`) when behavior is non-trivial (merge strategies, sanitize, identity change).
- Prefer `cargo test --manifest-path src-tauri/Cargo.toml --lib <filter>` for focused checks.
- Frontend: keep TypeScript clean (`tsc --noEmit`); no new deps without a clear need.

---

## 4. Architecture conventions

### 4.1 S3 connection path

All live S3 sessions go through **`s3_connect`**:

1. Sanitize fields  
2. Build OpenDAL `S3` service  
3. Apply SSL settings if requested  
4. Operator + retry (+ optional throttle)  
5. `check()` with `format_s3_connect_error` (TLS hints only when cert/ssl/tls keywords appear — not every network error)

`S3SessionConfig` must keep `danger_disable_ssl_verification` consistent with OpenDAL **and** AWS SDK metadata client.

### 4.2 Profiles

- Config JSON stores **metadata only** (no long-lived secrets).
- `has_saved_credentials` is runtime/config flag, not something to export as truth without care.
- Profile IO file format: `galeon.profiles` envelope (`profile_io::EXPORT_FORMAT` / `EXPORT_VERSION`).

### 4.3 Frontend structure

- `App.tsx`: shell, session, profile list load/save orchestration.
- Feature UI: one component file per major surface (`Explorer`, `TransferManager`, `ProfileImportExport`, …).
- Prefer a small **discriminated union** for multi-step modals over many boolean `useState`s.
- Match existing zinc + Gale Teal UI; follow `DESIGN.md` (no violet/fuchsia, Doubloon only for progress/metrics).

### 4.4 Tauri commands

- Commands stay thin: validate → call module → map errors to strings for the UI.
- Commands live in `src-tauri/src/commands/<feature>.rs`, one file per feature
  (`connect`, `browse`, `transfers`, `objects`, `sync`, `editor`, …). They open
  with `use crate::*;`, which reaches the crate root and every sibling command
  module — so a helper can move between files without an import chase.
- Register new commands in `lib.rs` `invoke_handler` when adding them.
- A shared item one command module needs from another must be at least
  `pub(crate)`; a plain private `fn` will not cross the file boundary.

---

## 5. Docs conventions

### Keep

| Path | Role |
|------|------|
| `AGENTS.md` | This file — agent/engineering direction |
| `DESIGN.md` | Semantic design system (Stitch-style structure) |
| `README.md` | Human entry + links |
| `docs/DIRECTION.md` | Product pillars / non-goals |
| `docs/ROADMAP.md` | Release milestones |
| `docs/QUICK_START.md` | End-user first launch |
| `docs/RELEASE_MACOS.md` | Signing / notarization / DMG |
| `docs/SFTP_SETUP_GUIDE.md` | SFTP setup |
| `docs/TEST_INFRA.md` | MinIO / tests |
| `branding/BRANDING.md` | Logo & brand |

### Do not

- Recreate `docs/archive/` dumps of phase tasks, old code reviews, or agent chat logs.
- Add long “implementation plan” markdown for every change unless the user asks for a design doc.
- Rename `DESIGN.md` to `design.md` / `DESIGN_SYSTEM.md` — root **`DESIGN.md`** is intentional.
- Document the Rust/TS architecture by pasting huge outdated specs; **code is source of truth** for protocols and modules. Point agents here and to the modules table above.

When docs go stale, **delete or fix links** — do not leave broken `docs/archive/...` references.

---

## 6. Distribution & releases

Galeon is a **public, MIT-licensed repository**. Source, issues, and CI-built
release artifacts are all public. There is no private-distribution tier and no
separate internal channel.

**Releases are built in CI, not by hand.** Pushing a `v*` tag runs
`.github/workflows/release.yml`, which builds the macOS `.dmg` bundle and attaches
it to a GitHub Release. Don't ship by running a local script and pasting a file
somewhere; tag it and let CI produce the artifact.

### Reality check (macOS)

- A build signed only with an **Apple Development** certificate is **rejected by
  Gatekeeper** on a clean first open (`spctl` → `rejected`, `origin=Apple
  Development`). This is Apple's policy, not a Galeon bug — don't "fix" it by
  disabling verification somewhere in the app.
- **Developer ID + notarization is optional and gated on secrets.** If
  `RELEASE_MACOS.md`'s notarization variables are present, CI signs and
  notarizes; if not, it still publishes the artifact and labels it unsigned, and
  users get the one-time **right-click → Open** step. Never make an unsigned build
  claim to be notarized.
- **Auto-update is deliberately not implemented.** It needs a trusted signing
  story plus a feed; the feed is also where a hobby project becomes an
  availability obligation. Releases are manual download until someone owns that.
- "Allow once" on one machine does **not** make every future build frictionless
  under local-only signing.

### Bundle identifier

`com.fizto.galeon` is both the bundle id and the **keyring service namespace**
(`credentials.rs`). Renaming it orphans every existing user's stored credentials
and their config directory (`app_config_dir` is derived from it) — the profiles
appear deleted when they are merely unreadable. Do not rename it casually; if it
ever changes, ship a one-time migration that copies keyring items and the config
directory, and land it a release before the rename.

### Agent defaults

1. **Do not** add auto-update, an update feed, or a GitHub-token update client unless asked.
2. **Do not** treat Apple Developer Program enrollment as a blocker for publishing — document it, don't invent unsigned workarounds as permanent behavior.
3. **Do not** tell users to run Terminal or disable Gatekeeper as the normal path.
4. Release-facing copy: download the `.dmg` from Releases → drag to Applications → **right-click → Open** once (unless the build is notarized).
5. Prefer user-visible polish (transfers, explorer, protocols) over distribution infrastructure.

Details: [`docs/ROADMAP.md`](docs/ROADMAP.md), [`docs/RELEASE_MACOS.md`](docs/RELEASE_MACOS.md).

---

## 7. How to take a change from idea → done

1. **Locate the canonical module** (table in §2). Extend it; don’t fork logic into `lib.rs` or a random component.  
2. **Keep UI thin** — invoke backend for merge/sanitize/secrets.  
3. **Extract early** if a file will cross ~1k lines or a feature has its own state machine.  
4. **Test** the pure logic you touched.  
5. **Update docs only if** behavior users/agents must know changed (QUICK_START, RELEASE, DESIGN, this file).  
6. **Commit** focused; no drive-by reformat.  

---

## 8. Explicit non-goals for agents (unless asked)

- Public marketing site rebuilds inside the app chrome.  
- Telemetry / analytics.  
- Electron migration.  
- Recreating deleted archive docs.  
- "Magic" generic abstraction layers that hide a simple data shape.  
- Paying or automating Apple Developer enrollment for the user — document the requirement; don't invent unsigned workarounds as permanent product behavior.
- Renaming the bundle identifier / keyring service without a migration (§6).

---

## 9. Quick “before you PR / finish” checklist

- [ ] Logic lives in the right module (`s3_connect` / `profile_io` / `credentials` / feature component).  
- [ ] No second S3 operator construction path.  
- [ ] No secrets in logs or config JSON.  
- [ ] SSL bypass stays explicit and import-safe.  
- [ ] File size / extraction considered.  
- [ ] Feature not mixed with unrelated formatting.  
- [ ] Versions still aligned if bumped.  
- [ ] `DESIGN.md` / zinc + Gale Teal respected for UI.  
- [ ] Release story not made harder (no Dev-cert-only "ship it" claims; CI builds the artifact).  
- [ ] Nothing added that phones home, and no third-party request claimed away in docs.  
- [ ] No employer/personal infrastructure, hostnames, usernames, or signing identities in code, tests, docs, or fixtures.

---

*Last aligned with post-review structure: `s3_connect`, `ProfileImportExport`, Stitch-style `DESIGN.md`, lean `docs/` (no archive).*
