//! The pure sync planner: size+mtime decisions, optionally refined by checksum.

use crate::*;
use opendal::Operator;

/// PURE planner (no IO / no network) over two flattened trees. For each relative
/// path it decides the sync action by comparing size and modified time:
///   - source-only path           → copy (`upload`/`download`), reason "new"
///   - both present, sizes differ → copy, reason "size differs"
///   - both present, source newer → copy, reason "newer"
///   - both present, equal        → `skip`, reason "identical"
///   - dest-only path             → `skip` (reason "extraneous") unless
///     `delete_extraneous`, then delete dest.
///
/// For `localToRemote`, local is source and copies are `upload`; dest-only
/// deletes are `deleteRemote`. For `remoteToLocal`, remote is source and copies
/// are `download`; dest-only deletes are `deleteLocal`.
///
/// This planner stays pure (size + mtime only). When `options.verify_checksum`
/// is set, `compute_sync_diff` runs a follow-up checksum pass over the
/// ambiguous same-size entries (`refine_plan_with_checksums`, S3 only), since
/// byte-exact comparison needs network IO that doesn't belong here.
pub fn compute_sync_plan(
    local: &[SyncFileEntry],
    remote: &[SyncFileEntry],
    direction: &str,
    options: &SyncOptions,
) -> Vec<SyncPlanEntry> {
    use std::collections::BTreeMap;

    // Index by relative path for O(1) lookups; BTreeMap gives deterministic
    // ordering which keeps the plan (and its unit tests) stable.
    let local_map: BTreeMap<&str, &SyncFileEntry> =
        local.iter().map(|e| (e.0.as_str(), e)).collect();
    let remote_map: BTreeMap<&str, &SyncFileEntry> =
        remote.iter().map(|e| (e.0.as_str(), e)).collect();

    let local_to_remote = direction == DIR_LOCAL_TO_REMOTE;
    let copy_action = if local_to_remote {
        "upload"
    } else {
        "download"
    };
    let delete_dest_action = if local_to_remote {
        "deleteRemote"
    } else {
        "deleteLocal"
    };

    // (source, dest) maps depend on direction.
    let (source_map, dest_map) = if local_to_remote {
        (&local_map, &remote_map)
    } else {
        (&remote_map, &local_map)
    };

    let mut out: Vec<SyncPlanEntry> = Vec::new();

    // Pass 1: every source path → copy or skip.
    for (rel, src) in source_map.iter() {
        let dest = dest_map.get(rel).copied();
        let (action, reason) = match dest {
            None => (copy_action, "new"),
            Some(d) => {
                if src.1 != d.1 {
                    (copy_action, "size differs")
                } else if source_newer(src.2, d.2) {
                    (copy_action, "newer")
                } else {
                    ("skip", "identical")
                }
            }
        };
        out.push(make_entry(
            rel,
            action,
            reason,
            &local_map,
            &remote_map,
            direction,
        ));
    }

    // Pass 2: dest-only paths (extraneous on the destination).
    for rel in dest_map.keys() {
        if source_map.contains_key(rel) {
            continue;
        }
        let (action, reason) = if options.delete_extraneous {
            (delete_dest_action, "extraneous")
        } else {
            ("skip", "extraneous")
        };
        out.push(make_entry(
            rel,
            action,
            reason,
            &local_map,
            &remote_map,
            direction,
        ));
    }

    out.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
    out
}

/// True when the source mtime is meaningfully newer than the dest mtime. If
/// either timestamp is missing we conservatively treat the source as NOT newer
/// (so size becomes the deciding factor and we don't copy on a hunch).
fn source_newer(src_ms: Option<u64>, dest_ms: Option<u64>) -> bool {
    match (src_ms, dest_ms) {
        (Some(s), Some(d)) => s > d.saturating_add(SYNC_MTIME_SLACK_MS),
        _ => false,
    }
}

/// Build a `SyncPlanEntry`, pulling sizes/mtimes from whichever side has the
/// path so the UI can show both columns regardless of action.
fn make_entry(
    rel: &str,
    action: &str,
    reason: &str,
    local_map: &std::collections::BTreeMap<&str, &SyncFileEntry>,
    remote_map: &std::collections::BTreeMap<&str, &SyncFileEntry>,
    direction: &str,
) -> SyncPlanEntry {
    let local = local_map.get(rel).copied();
    let remote = remote_map.get(rel).copied();
    SyncPlanEntry {
        relative_path: rel.to_string(),
        action: action.to_string(),
        reason: reason.to_string(),
        local_size: local.map(|e| e.1),
        remote_size: remote.map(|e| e.1),
        local_modified: local.and_then(|e| e.2).map(ms_to_rfc3339),
        remote_modified: remote.and_then(|e| e.2).map(ms_to_rfc3339),
        direction: direction.to_string(),
    }
}

/// Whether a plan entry is an ambiguous same-size candidate worth a checksum
/// comparison: both sides present, equal size, and decided only by size/mtime
/// (`identical` or `newer`). Pure — unit-tested.
pub(crate) fn entry_needs_checksum_refine(entry: &SyncPlanEntry) -> bool {
    matches!((entry.local_size, entry.remote_size), (Some(l), Some(r)) if l == r)
        && (entry.reason == "identical" || entry.reason == "newer")
}

/// Apply a checksum-comparison result to an ambiguous entry in place: identical
/// content collapses to `skip`, differing content becomes a copy. Pure —
/// unit-tested.
pub(crate) fn apply_checksum_result(entry: &mut SyncPlanEntry, identical: bool, direction: &str) {
    if identical {
        entry.action = "skip".to_string();
        entry.reason = "identical (checksum)".to_string();
    } else {
        entry.action = if direction == DIR_LOCAL_TO_REMOTE {
            "upload"
        } else {
            "download"
        }
        .to_string();
        entry.reason = "content differs".to_string();
    }
}

/// For each ambiguous same-size entry, compare the local file against the remote
/// object's ETag (the S3 checksum) via `verify_integrity` and re-decide the
/// action. No object download: we only need the ETag from `stat`. Entries whose
/// ETag can't be read are left on their size+mtime decision.
pub(crate) async fn refine_plan_with_checksums(
    op: &Operator,
    plan: &mut [SyncPlanEntry],
    local_root: &str,
    remote_prefix: &str,
    direction: &str,
) {
    for entry in plan.iter_mut() {
        if !entry_needs_checksum_refine(entry) {
            continue;
        }
        let remote_key = join_remote_key(remote_prefix, &entry.relative_path);
        // The ETag is the only thing we need; skip refinement if it's absent.
        let etag = match op.stat(&remote_key).await {
            Ok(meta) => match meta.etag() {
                Some(e) => e.to_string(),
                None => continue,
            },
            Err(_) => continue,
        };
        let abs_local = std::path::Path::new(local_root)
            .join(&entry.relative_path)
            .to_string_lossy()
            .to_string();
        let size = entry.remote_size.unwrap_or(0);
        let identical = verify_integrity(&abs_local, size, Some(&etag))
            .await
            .is_ok();
        apply_checksum_result(entry, identical, direction);
    }
}
