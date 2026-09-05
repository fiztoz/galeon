# macOS Release Guide

> **Audience:** anyone building or releasing Galeon. The repo is public and
> **CI builds the macOS `.dmg` on a `v*` tag** (`.github/workflows/release.yml`) —
> prefer tagging over hand-running these scripts. Paid **Developer ID +
> notarization** is the remaining v1.0 step and is optional today; until then
> releases are published unsigned/dev-signed and the Gatekeeper step is documented
> rather than hidden. See [ROADMAP.md](ROADMAP.md).

Releases today are built with local / Apple Development signing (or unsigned). Users of a downloaded `.dmg` need **right-click → Open** once; say so in the release notes instead of letting people discover it.

### Release checklist (no notarization)

1. On your Mac: `./scripts/build-dmg-silicon.sh` (or `./scripts/build-dmg.sh` for universal).  
2. Find the DMG under `src-tauri/target/...` / script output path.  
3. Share **privately** (AirDrop, chat, Drive restricted link) — not a public Release.  
4. In the release notes: open DMG → Applications → **right-click Galeon → Open** once.  
5. New version: send a new DMG; they replace the app (no auto-update).

Paid Developer ID + notarization steps below are for **v1.0 public ship** only.

---

Galeon can ship as a signed, notarized universal `.dmg` built locally on a Mac. There is no CI pipeline — credentials stay on your machine.

## Prerequisites

1. **Apple Developer account** with a **Developer ID Application** certificate installed in your login keychain.
2. **Rust target** for Apple Silicon builds:

   ```sh
   rustup target add aarch64-apple-darwin
   ```

   For universal (Intel + Apple Silicon) builds, also add `x86_64-apple-darwin`.

3. **Bun** and project dependencies (`bun install`).

## Signing identity

No certificate is baked into the repo — `tauri.conf.json` leaves `signingIdentity`
unset, so the identity comes from the environment at build time. This keeps the
maintainer's signing identity out of a public tree, and lets anyone build with
their own key or none at all.

Set it before building:

```sh
export APPLE_SIGNING_IDENTITY="Apple Development: you@example.com (TEAMID)"
# unsigned local build:
export APPLE_SIGNING_IDENTITY=-
```

To list available identities on your Mac:

```sh
security find-identity -v -p codesigning
```

Override the configured identity at build time with:

```sh
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"
```

For unsigned local builds (no certificate):

```sh
export APPLE_SIGNING_IDENTITY=-
```

### `errSecInternalComponent` / "unable to build chain to self-signed root"

This usually means the **Apple WWDR G3 intermediate certificate** is missing or expired in your keychain. The build scripts run a preflight that downloads and installs it automatically; you can also install it manually:

```sh
curl -fsSL -o /tmp/AppleWWDRCAG3.cer https://www.apple.com/certificateauthority/AppleWWDRCAG3.cer
security import /tmp/AppleWWDRCAG3.cer -k ~/Library/Keychains/login.keychain-db -T /usr/bin/codesign
security find-identity -v -p codesigning
```

> **Note:** An *Apple Development* certificate (used for `tauri dev`) signs local builds but cannot be notarized for distribution. For shipping `.dmg` files to other Macs, you need a **Developer ID Application** certificate.

## Notarization environment variables

Export these before building. **Do not commit credentials to the repo.**

| Variable | Description |
|---|---|
| `APPLE_ID` | Apple developer account email |
| `APPLE_PASSWORD` | App-specific password from [appleid.apple.com](https://appleid.apple.com) |
| `APPLE_TEAM_ID` | 10-character Developer Team ID |
| `APPLE_SIGNING_IDENTITY` | (optional) Overrides `tauri.conf.json` signing identity |

When these variables are set, `bun tauri build` automatically submits the bundle for notarization and staples the ticket.

If notarization fails, inspect Apple's response:

```sh
xcrun notarytool log <submission-id> --apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID"
```

## Build

**Apple Silicon only** (recommended on M-series Macs):

```sh
./scripts/build-dmg-silicon.sh
```

Output:

```
src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/
```

**Universal** (Intel + Apple Silicon):

```sh
./scripts/build-dmg.sh
```

Output:

```
src-tauri/target/universal-apple-darwin/release/bundle/dmg/
```

Both scripts validate that `package.json`, `Cargo.toml`, and `tauri.conf.json` share the same version before building.

## Verify a release build

1. Open the `.dmg`, drag Galeon to Applications, and launch.
2. Confirm the bundle identifier and the version shown in `package.json`
   (`bun -e 'console.log(require("./package.json").version)'`) match what you built.
3. If signed and notarized:

   ```sh
   codesign -dv --verbose=4 /Applications/Galeon.app
   spctl -a -vv /Applications/Galeon.app
   ```