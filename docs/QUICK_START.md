# Galeon Quick Start

Get from install to your first connection in a few minutes.

## Install (downloaded `.dmg`)

Galeon is currently shared **privately** (not a public store download). Builds may be signed with a local development certificate, so macOS Gatekeeper can warn on first open.

1. Open the DMG you were sent and drag **Galeon** to **Applications**.
2. In **Applications**, **right-click** Galeon → **Open** → confirm **Open**.
3. After that, normal double-click usually works for **this** install.

When a new version arrives, replace the app the same way (no automatic updater yet).

## First launch

On a fresh install, Galeon shows a short onboarding wizard:

1. **Welcome** — what Galeon is
2. **Choose your isle** — pick S3-compatible, SFTP, or FTP/FTPS
3. **Secure by default** — saved credentials live in your Mac's secure password system
4. **Offline by design** — no tracking, telemetry, or crash-report upload
5. **Start sailing** — create your first profile or skip for now

You can reopen onboarding anytime from **Settings → Show onboarding again**.

Existing users who already have saved profiles skip onboarding automatically on first launch after upgrading.

## Create a storage profile

1. Open the connection screen (shown when disconnected).
2. Select a protocol and fill in host/bucket details.
3. Enter credentials. SFTP, FTP/FTPS, and SSH tunnels use password authentication by default; SFTP can also use an SSH key.
4. Click the save icon or **Save as new profile** to persist the connection.

Saved credentials are stored in the macOS secure password system — not in Galeon's config files. Galeon may ask for your Mac login password or Touch ID the first time it reads a secret in a session.

### Use an existing SSH config host

For SFTP, click **Use a host from ~/.ssh/config** and choose a named `Host` entry. Galeon follows `Include` files and fills the resolved host, port, username, and identity-file path into the normal connection form. Review the fields, then connect or save them as a Galeon profile.

Galeon does not run OpenSSH or import secrets from the config. Runtime-only `Match` rules are skipped. If an entry uses `ProxyJump`, Galeon warns you to choose an equivalent saved SSH tunnel before connecting. Custom SSH options outside the displayed fields are not applied, and the server must still be trusted in `~/.ssh/known_hosts`.

## Connect

- **Single-click** a saved profile to load its settings.
- **Double-click** to connect immediately.
- Or use **Quick Connect** with unsaved credentials.

## Connect through an SSH tunnel

S3 custom endpoints and SFTP servers can connect through an SSH bastion:

1. Fill in the normal S3 endpoint or SFTP server — this is the destination seen from the bastion.
2. In **SSH tunnel**, click **Set up** (or **Manage** for an existing choice) to open the separate tunnel-profile dialog.
3. Choose a saved tunnel profile, or click **New profile**. You can import an eligible `Host` from `~/.ssh/config`, or enter the bastion details manually. The picker shows only entries with `HostName`, `User`, and `IdentityFile`; entries using `ProxyJump` are excluded.
4. Review the imported fields. Enter a bastion password for password authentication, or leave it blank to use the imported private-key path / `ssh-agent`.
5. Save the tunnel profile, click **Done**, then connect or save the storage connection as usual.

A storage profile remembers which tunnel profile to use, while the tunnel's SSH server settings and password are saved once, separately. This lets several storage profiles reuse the same bastion without mixing storage and tunnel passwords. Passwords stay under separate identities in the macOS secure password system and are never placed in process arguments, environment variables, or Galeon's config files. Importing from `~/.ssh/config` copies only connection fields and the private-key path; Galeon never reads or copies the private-key contents.

For security, Galeon only connects to a bastion your computer already trusts. Its server fingerprint (host key) must already be listed in `~/.ssh/known_hosts`, usually after you connect with your normal SSH client and approve the fingerprint once. FTP/FTPS tunneling remains excluded because forwarding only its control port would leave passive data connections outside the tunnel. For S3, use an HTTP endpoint inside the encrypted tunnel when possible; HTTPS requires the explicit **Disable SSL Verify** option because the local forwarded hostname will not match the endpoint certificate.

## Settings

Open **Settings** from the connection screen header or the connected-session header (or ⌘K → Open Settings).

| Section | What it shows |
|---|---|
| About Galeon | Version, bundle ID, platform |
| Privacy | Offline-by-design trust copy |
| Credentials | Session lock status; **Lock credentials now** clears in-memory secrets |
| Onboarding | Reset and replay the first-run wizard |

**Lock credentials now** clears only the in-memory cache for this app session. It does not delete saved credentials from your Mac's secure password system.

## Credential prompts (macOS)

Expected behavior with many saved profiles:

1. **Launch** — no password prompt just to list profiles.
2. **Connect** to a saved profile — macOS may prompt once.
3. **Switch profiles** in the same session — cached secrets avoid repeat prompts.
4. **Lock credentials now** — cache cleared; next connect may prompt again.
5. **Quit and relaunch** — no prompt on startup; first credential use may prompt.

Unsigned or dev builds may prompt more often than a signed release build. See [RELEASE_MACOS.md](RELEASE_MACOS.md) for distribution builds.

## Privacy

Galeon is an offline desktop app. It connects only to storage locations you configure. It does not track usage, phone home, or upload crash reports.

## Development

```sh
bun install
bun run tauri dev
```

See the main [README](../README.md) and [RELEASE_MACOS.md](RELEASE_MACOS.md) for build and distribution steps.
