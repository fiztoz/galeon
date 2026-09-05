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
  or account system. **One caveat, stated plainly:** the stylesheet pulls Inter,
  Space Grotesk and JetBrains Mono from Google Fonts, so a launch with network
  access makes one third-party font request that reveals your IP to Google. It is
  not tracking, but it is not fully offline either. The app degrades to system
  fonts without it, and self-hosting the three families is the open fix
  (tracked in the roadmap) if you want that request gone.
- Galeon is not a sandbox. It is a normal user-level desktop app: anything with your
  user permissions can read what you can read. It does not defend against a machine
  that is already compromised.
- Distribution is by build-from-source or a downloaded `.dmg`. Builds that are only
  signed with an *Apple Development* certificate are not notarized, so Gatekeeper
  will prompt on first launch. That is a consequence of not paying for the Apple
  Developer Program, not a vulnerability to report. See
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

## Expectations

This is a single-maintainer hobby project. Reports are welcome and will be read, but
there is no SLA, no bug bounty, and no formal disclosure program.
