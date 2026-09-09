# Security

Galeon is a desktop client whose whole job is holding credentials for other
people's storage. This page states what it actually does, and how to report a
problem.

## How secrets are handled

- **The OS keychain is the store.** Access keys, secret keys, SFTP/FTP passwords,
  and SSH tunnel passphrases go to the system keyring
  (`src-tauri/src/credentials.rs`, service id `com.fizto.galeon`). Config JSON on
  disk holds profile *metadata* only.
- **A short-lived session cache** exists so macOS does not prompt on every action.
  It is in-memory, and Settings has **Lock credentials now** to drop it immediately.
- **Startup does not read secrets.** The profile list returns metadata; secrets are
  loaded lazily when you connect or edit.
- **Export is opt-in and explicit.** Exporting *with* secrets is a deliberate
  action, and importing with secrets requires an explicit confirmation plus a
  **content hash** check, so a file cannot be swapped between preview and apply
  (TOCTOU).
- **Re-importing a changed connection clears its vault.** If a profile's connection
  identity (host/bucket/user) changes and no new secrets are supplied, the stored
  secrets for that profile id are deleted rather than being rebound to a different
  host.

## TLS verification

`danger_disable_ssl_verification` exists for self-signed lab endpoints (e.g. a local
MinIO). It is off by default, is forced **off** when a profile is imported, and must
be re-enabled deliberately by the user. Treat it as a lab escape hatch, not a
setting to live with.

## What is not in scope

- No telemetry, analytics, crash reporting, or usage tracking, and no update feed
  or account system. **A launch makes no third-party network request at all:** the
  three UI fonts are vendored in `public/fonts/` under their own OFL licenses, and
  the Content-Security-Policy allows no external host. Verified by replaying the
  shipped CSP against the built output and counting outbound requests: zero.
  Everything that leaves the machine is a request you initiated, to an endpoint you
  configured.
- Galeon is not a sandbox. It is a normal user-level desktop app: anything with your
  user permissions can read what you can read. It does not defend against a machine
  that is already compromised.
- Distribution is by build-from-source or a CI-built `.dmg`. The default is
  **ad-hoc signed, not notarized**: no developer identity is authenticated, and
  Gatekeeper may block first launch. CI verifies the artifact before describing
  its signing status. Developer ID and notarization are optional; see
  [docs/RELEASE_MACOS.md](docs/RELEASE_MACOS.md).

## Reporting a vulnerability

Open a **private** security advisory on the repository rather than a public issue,
so the report is not exposed before it is fixed. Include:

- the version (`Galeon → Settings → About`, or `package.json`)
- the protocol and endpoint type involved (S3 / SFTP / FTP / FTPS, and whether an
  SSH tunnel was in use)
- steps to reproduce, ideally against a local MinIO rather than real storage
- whether credentials could be read, leaked, or rebound

Please do not open a public issue describing an exploitable secret-handling or
path-traversal flaw. Path traversal in sync/import is covered by tests
(`test_tier2_b14_path_traversal_safety`); if you find a way past it, that is worth a
private report.

## Dependency and secret scanning

CI scans the fetched Git history with checksum-pinned Gitleaks and redacts matches.
The separate **Dependency security** workflow runs weekly and on demand, with
RustSec (`cargo audit`) and `bun audit`. It fails visibly on advisories; passing
application tests is not a clean security audit, and no blanket ignore list is used.
Dependabot proposes updates but never merges them automatically.

### Dismissed: glib VariantStrIter unsoundness (2026-09-09, tolerable risk)

Dependabot alert #1 (medium, no CVE): `glib` 0.18.5, vulnerable range
`>=0.15, <0.20`. Dismissed because no version bump can fix it: glib arrives
only transitively via `tauri -> wry -> webkit2gtk 2.0.2 -> gtk 0.18`, Galeon
source has no direct `glib`/`webkit`/`gtk` use, and the newest upstream
(tauri 2.11.5, wry 0.57.0) still pins `webkit2gtk =2.0.2`, so `glib >= 0.20`
is unresolvable until Tauri/wry migrate the Linux webview stack. Those
dependencies are target-gated to Linux/BSD and never compile on macOS.
Re-evaluate when upstream moves; Dependabot re-alerts on new advisories.

The older OpenDAL/reqsign XML stack and Linux GTK dependencies still need upstream
advisory review. Do not interpret platform-specific maintenance warnings as macOS
exploits, or dismiss XML-parser findings merely because the application compiles.
Review the latest advisory output and actual call paths before shipping a release.

## Expectations

This is a single-maintainer hobby project. Reports are welcome and will be read, but
there is no SLA, no bug bounty, and no formal disclosure program.
