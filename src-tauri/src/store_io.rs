//! Owner-only file permissions for the app's on-disk state stores.
//!
//! `config.json`, `app_settings.json`, `transfers.json`, `sync_profiles.json`
//! and `ssh_tunnel_profiles.json` used to be written with plain
//! `std::fs::write`, which creates files at the umask default (0644 on most
//! systems) — readable by every account on the machine. Real credentials live
//! in the OS keyring, not in these files, so this is defence-in-depth rather
//! than an active leak; the stores still carry presigned URLs, local paths and
//! remote prefixes that should not be world-readable.
//!
//! Permissions are asserted only when a store is **opened for writing**: one
//! extra `fchmod` rides along with a write that already happens, and files
//! created before this hardening get fixed on their next rewrite. Reads — the
//! hot path, since every command touches these stores — are deliberately left
//! untouched so they gain no extra syscall.
//!
//! On non-unix platforms POSIX mode bits do not exist, so behaviour is
//! unchanged (and no dependency is pulled in for this).

use std::io::Write;
use std::path::Path;

/// Create or truncate `path` for writing with owner-only permissions (0600).
#[cfg(unix)]
pub(crate) fn create_private_file(path: &Path) -> std::io::Result<std::fs::File> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        // Applies only when the file is newly created…
        .mode(0o600)
        .open(path)?;
    // …so re-assert unconditionally: a store written before this hardening
    // may already exist at 0644, and `std::fs::write`/`tokio::fs::write` on a
    // temp file do not change an existing file's mode either. One `fchmod` per
    // write is negligible next to the write itself.
    file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    Ok(file)
}

/// Create or truncate `path` for writing. No POSIX mode bits on non-unix
/// platforms — same behaviour as the old `std::fs::write`.
#[cfg(not(unix))]
pub(crate) fn create_private_file(path: &Path) -> std::io::Result<std::fs::File> {
    std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(path)
}

/// Write `contents` to `path`, creating/replacing it as an owner-only file.
///
/// Drop-in replacement for `std::fs::write` on the state stores.
pub(crate) fn write_private(path: &Path, contents: impl AsRef<[u8]>) -> std::io::Result<()> {
    let mut file = create_private_file(path)?;
    file.write_all(contents.as_ref())
}

/// Re-assert owner-only permissions on an existing file. For write paths that
/// do their own temp-file/rename dance (`tokio::fs::write` in
/// `transfer_queue`) and cannot use [`create_private_file`] directly.
#[cfg(unix)]
pub(crate) fn tighten_owner_only(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
}

#[cfg(not(unix))]
pub(crate) fn tighten_owner_only(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn tmp_dir(tag: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("galeon-store-io-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn write_private_creates_a_0600_file_and_tightens_a_loose_one() {
        let dir = tmp_dir("modes");
        let path = dir.join("store.json");

        write_private(&path, "one").unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600, "new store must be owner-only");

        // Simulate a store written before this hardening (umask default 0644):
        // the next write must tighten it, not preserve the loose mode.
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        write_private(&path, "two").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "two");
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(
            mode & 0o777,
            0o600,
            "pre-existing loose store must be tightened"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn tighten_owner_only_fixes_an_existing_file() {
        let dir = tmp_dir("tighten");
        let path = dir.join("store.json");
        std::fs::write(&path, "x").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();

        tighten_owner_only(&path).unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);

        std::fs::remove_dir_all(&dir).ok();
    }
}
