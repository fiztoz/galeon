//! Directory walkers and path helpers shared by the sync planner.

use crate::*;
use opendal::{Operator, Scheme};

/// Normalize a path component to forward slashes and strip any leading slash so
/// local and remote relative keys compare cleanly.
pub(crate) fn normalize_rel_path(rel: &str) -> String {
    rel.replace('\\', "/").trim_start_matches('/').to_string()
}

/// Reject relative paths that are absolute, Windows-drive rooted, or contain `..`
/// segments before they are joined onto a local root (path-traversal guard).
pub(crate) fn is_unsafe_relative_path(rel: &str) -> bool {
    let normalized = rel.replace('\\', "/");
    if normalized.starts_with('/') {
        return true;
    }
    let bytes = normalized.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return true;
    }
    normalized.split('/').any(|part| part == "..")
}

/// Reject root/prefix paths that contain `..` segments.
/// Unlike `is_unsafe_relative_path`, this allows absolute Unix paths and Windows
/// drive letters because sync roots are chosen folder paths / remote prefixes.
pub(crate) fn is_unsafe_root_path(path: &str) -> bool {
    path.replace('\\', "/").split('/').any(|part| part == "..")
}

/// Parse an RFC3339 timestamp string into unix epoch milliseconds.
fn rfc3339_to_ms(s: &str) -> Option<u64> {
    use chrono::DateTime;
    DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|dt| dt.timestamp_millis().max(0) as u64)
}

/// Recursively walk a local directory tree, returning one entry per regular
/// file as (relative forward-slash path, size, modified-ms). Symlinks are
/// skipped (we follow neither symlinked files nor symlinked directories) to
/// avoid cycles and surprising out-of-tree copies. Runs the blocking walk on a
/// `spawn_blocking` worker.
pub async fn walk_local_tree(root: &std::path::Path) -> Result<Vec<SyncFileEntry>, String> {
    let root = root.to_path_buf();
    tokio::task::spawn_blocking(move || walk_local_tree_blocking(&root))
        .await
        .map_err(|e| format!("Local walk task failed: {}", e))?
}

/// Blocking implementation of `walk_local_tree`, using a manual stack so we
/// never recurse unbounded on deep trees.
fn walk_local_tree_blocking(root: &std::path::Path) -> Result<Vec<SyncFileEntry>, String> {
    let mut out: Vec<SyncFileEntry> = Vec::new();
    if !root.exists() {
        // A non-existent local root is treated as an empty tree so a first-time
        // remoteToLocal sync (downloading into a new folder) still works.
        return Ok(out);
    }
    let mut stack: Vec<std::path::PathBuf> = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = std::fs::read_dir(&dir)
            .map_err(|e| format!("Failed to read dir {}: {}", dir.display(), e))?;
        for entry in entries {
            let entry = entry.map_err(|e| format!("Dir entry error: {}", e))?;
            let path = entry.path();
            // Skip symlinks entirely (do not follow them).
            let meta = match std::fs::symlink_metadata(&path) {
                Ok(m) => m,
                Err(_) => continue,
            };
            if meta.file_type().is_symlink() {
                continue;
            }
            if meta.is_dir() {
                stack.push(path);
            } else if meta.is_file() {
                let rel = match path.strip_prefix(root) {
                    Ok(r) => r.to_string_lossy().replace('\\', "/"),
                    Err(_) => continue,
                };
                let size = meta.len();
                let modified_ms = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64);
                out.push((normalize_rel_path(&rel), size, modified_ms));
            }
        }
    }
    Ok(out)
}

/// Flat recursive S3 listing via OpenDAL's `recursive(true)` lister — one stream
/// instead of per-directory BFS roundtrips.
async fn walk_remote_tree_s3(op: &Operator, prefix: &str) -> Result<Vec<SyncFileEntry>, String> {
    let base = prefix.trim_end_matches('/').to_string();
    let prefix_str = if prefix.is_empty() {
        String::new()
    } else if prefix.ends_with('/') {
        prefix.to_string()
    } else {
        format!("{}/", prefix)
    };

    let mut lister = op
        .lister_with(&prefix_str)
        .recursive(true)
        .await
        .map_err(|e| format!("Lister error: {}", e))?;

    let mut out: Vec<SyncFileEntry> = Vec::new();
    while let Some(entry) = lister
        .try_next()
        .await
        .map_err(|e| format!("Stream error: {}", e))?
    {
        let path = entry.path().to_string();
        if path == prefix_str {
            continue;
        }
        let meta = entry.metadata();
        if meta.mode().is_dir() {
            continue;
        }
        let rel = remote_key_relative_to(&path, &base);
        if rel.is_empty() {
            continue;
        }
        let size = meta.content_length();
        let modified_ms = meta
            .last_modified()
            .map(|t| t.timestamp_millis().max(0) as u64);
        out.push((rel, size, modified_ms));
    }
    Ok(out)
}

/// BFS directory walk used for SFTP, FTP/FTPS, and non-S3 OpenDAL sessions.
async fn walk_remote_tree_bfs(
    session: &StorageSession,
    prefix: &str,
) -> Result<Vec<SyncFileEntry>, String> {
    let mut out: Vec<SyncFileEntry> = Vec::new();
    let base = prefix.trim_end_matches('/').to_string();
    let mut queue: Vec<String> = vec![prefix.to_string()];
    while let Some(dir) = queue.pop() {
        let objects = list_remote_dir(session, &dir).await?;
        for obj in objects {
            match obj.object_type {
                ObjectType::Folder => {
                    if obj.full_key.trim_end_matches('/') != dir.trim_end_matches('/') {
                        queue.push(obj.full_key);
                    }
                }
                ObjectType::File => {
                    let rel = remote_key_relative_to(&obj.full_key, &base);
                    if rel.is_empty() {
                        continue;
                    }
                    let size = obj.size_bytes.unwrap_or(0);
                    let modified_ms = obj.last_modified.as_deref().and_then(rfc3339_to_ms);
                    out.push((rel, size, modified_ms));
                }
            }
        }
    }
    Ok(out)
}

/// Recursively walk a remote tree under `prefix`, descending into folders via
/// the same per-protocol listing `list_directory` uses, and flatten to file
/// entries with paths relative to `prefix`. S3 OpenDAL sessions use a flat
/// recursive lister; SFTP/FTP and other backends use BFS.
pub async fn walk_remote_tree(
    session: &StorageSession,
    prefix: &str,
) -> Result<Vec<SyncFileEntry>, String> {
    if let StorageSession::OpenDAL(op) = session {
        if op.info().scheme() == Scheme::S3 {
            return walk_remote_tree_s3(op, prefix).await;
        }
    }
    walk_remote_tree_bfs(session, prefix).await
}

/// Join a base prefix/path with a forward-slash relative path, for remote keys.
pub(crate) fn join_remote_key(prefix: &str, rel: &str) -> String {
    let base = prefix.trim_end_matches('/');
    if base.is_empty() {
        rel.to_string()
    } else {
        format!("{}/{}", base, rel)
    }
}

// ============================================================================
// Phase 12 — Sync scheduling & off-peak bandwidth (pure helpers)
// ============================================================================
