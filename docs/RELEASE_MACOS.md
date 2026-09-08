# macOS Release Guide

**CI builds releases from `v*` tags. Ad-hoc signing is the default.** No Apple
account, certificate, or notarization secrets are required for this mode. Public
source and downloadable releases do not require a paid Apple developer account.
There is no auto-update feed; users download and replace the app manually.

## Install a downloaded release

1. Download the `.dmg` from [Releases](https://github.com/fiztoz/galeon/releases).
2. Open it and drag **Galeon** into **Applications**.
3. For an unnotarized build, try **right-click Galeon → Open** once. If macOS still
   blocks it, after the blocked attempt use **System Settings → Privacy & Security
   → Open Anyway**, only if you trust the download. Managed Macs may forbid this.
4. Later launches of that approved build normally use double-click. A replacement
   build may require approval again.

Ad-hoc signatures verify code integrity but **do not identify a trusted developer**.
They do not make Gatekeeper accept the app and are not notarization. Do not disable
Gatekeeper or bypass a malware/damaged-app warning. See
[Apple's guidance](https://support.apple.com/en-us/102445).

## Release checklist

1. Land the change on `main` through a green CI run. Review outstanding dependency
   findings in the **Dependency security** workflow before shipping an installer.
2. Keep `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json` at
   exactly the same version. Commit that version change before tagging.
3. Create and push an annotated tag matching the version, for example:

   ```sh
   git tag -a v1.0.0-alpha.3 -m 'Galeon 1.0.0-alpha.3'
   git push origin v1.0.0-alpha.3
   ```

   Use a new version for a new release; do not move an existing release tag.
4. `.github/workflows/release.yml` checks out that exact tag, validates all three
   versions, runs unit/frontend/tooling tests, and builds a universal macOS DMG.
5. CI verifies the app's signature, publishes the DMG plus `SHA256SUMS`, and records
   the **checked-out commit**, not the workflow dispatch commit. Alpha/beta/RC tags
   become GitHub prereleases and do not replace the latest stable release.
6. Test the downloaded installer on a clean Mac. CI signature verification is not
   a substitute for testing Gatekeeper and the first-connect experience.

A manual **Release → Run workflow** rebuilds an **existing** tag. It does not create
a tag or change the repository's visibility. Rebuilding replaces that tag's release
assets, so prefer a new version when the code changes.

## Signing modes

Set the repository **Actions variable** `MACOS_SIGNING_MODE` (not a secret):

```sh
gh variable set MACOS_SIGNING_MODE --body adhoc
```

| Mode | Requirements | Release label |
|---|---|---|
| `adhoc` (also the unset default) | None; CI sets `APPLE_SIGNING_IDENTITY=-` | Ad-hoc signed, not notarized |
| `developer-id` | Developer ID certificate, password, and signing identity | Developer ID signed, not notarized |
| `developer-id` with all notarization secrets | Same plus Apple ID, app-specific password, and Team ID | Developer ID signed and notarized, only after validation |

Ad-hoc mode does not read Apple secrets or create a signing keychain. Developer ID
mode rejects incomplete signing configuration instead of silently falling back.
An **Apple Development** certificate is not a distribution identity and is rejected
by this release mode.

### Optional Developer ID and notarization setup

Configure these as **GitHub Actions secrets**, never in tracked files or logs:

| Secret | Purpose |
|---|---|
| `APPLE_CERTIFICATE` | Base64-encoded exported Developer ID Application `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | Password protecting that `.p12` |
| `APPLE_SIGNING_IDENTITY` | Full Developer ID Application identity |
| `APPLE_ID` | Apple account used for notarization |
| `APPLE_PASSWORD` | App-specific password for that account |
| `APPLE_TEAM_ID` | Developer Team ID |

The first three are required in `developer-id` mode. The last three are optional
**as a group**: configure all or none. Tauri submits and staples when configured;
CI checks the stapled ticket and Gatekeeper assessment before claiming notarization.
Only then switch `MACOS_SIGNING_MODE` to `developer-id`. Do not paste secrets into
CLI command arguments or commit exported certificates.

## GitHub repository safeguards

Before making the repository public:

- Enable Dependabot alerts/security-fix PRs. `.github/dependabot.yml` also schedules
  weekly Actions, Cargo, and Bun updates once merged into the default branch.
- Keep default Actions token permissions **read-only** and disallow Actions from
  approving PR reviews. Only the isolated publication job requests `contents: write`;
  the build job has no repository write token.
- Review the clean, redacted Gitleaks history scan in CI. `.gitignore` prevents
  common accidental additions but is not a substitute for scanning/review.

Some controls are unavailable on a free private repository. **After intentionally
changing visibility**, enable and verify:

- Private vulnerability reporting, as promised in `SECURITY.md`.
- Secret scanning and push protection where available, without opting into paid
  features unintentionally.
- Protection for `main`: required CI checks, no force pushes/deletion, and PR-based
  changes. A solo maintainer can require zero approving reviews while still requiring
  green checks. Required check names: `Lint (fmt + types)`, `Rust suite (Linux + MinIO
  e2e)`, `Rust suite (macOS)`, `Frontend build`, and `Secret scan (history)`.
- Protect `v*` tags against unauthorized creation, updates, and deletion. The workflow
  also requires annotated tags whose commits are already on `main`, but repository
  rules protect the workflow itself from modification by an untrusted tag writer.
- Approval for **all external contributors'** fork workflows.
- Full-SHA pinning enforcement **after** the pinned workflows are on `main`; enabling
  it while older tag-based Actions references remain would block those runs.

These settings are repository administration, not files in Git. Changing the repo's
visibility or transferring it is a separate, explicit action. Keep the bundle id
`com.fizto.galeon` unchanged: it also names existing users' keyring/config storage.

## Local builds (development verification, not the release publishing path)

Requirements: macOS, Xcode Command Line Tools, Rust **1.94.1+** with Cargo, Bun,
Node.js **22.12+** (or a compatible newer release), and Python **3.11+** for release
tooling tests. See [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).
When using rustup, install the targets needed for your build:

```sh
rustup target add aarch64-apple-darwin
# Universal builds also need:
rustup target add x86_64-apple-darwin
```

```sh
./scripts/build-dmg-silicon.sh   # Apple Silicon
./scripts/build-dmg.sh           # universal Intel + Apple Silicon
```

Both scripts default to ad-hoc signing, install from the lockfile, validate version
alignment, and do not modify your keychain. An explicitly supplied signing identity
can override the local default. Public artifacts still come from tag-driven CI.

Output: `src-tauri/target/<target>/release/bundle/dmg/`.
For an ad-hoc Apple Silicon build, verify it without accessing a keychain:

```sh
bash scripts/verify-macos-release.sh \
  src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Galeon.app adhoc false
```
