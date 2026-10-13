// Presigned URL issuance and its local history.

use crate::*;

/// Cap on persisted presign history entries (after pruning).
const MAX_PRESIGN_HISTORY: usize = 50;

/// Drop history entries whose presigned URL has passed its validity window.
///
/// A SigV4 presigned URL is a bearer token for its object until it expires —
/// the credential, signature and expiry all live in the query string — so an
/// entry that outlives that window is a dead credential sitting in plaintext
/// in `config.json`. Pure so it can be unit-tested: `now` is injected.
///
/// Conservative on doubt: if `created_at` does not parse as RFC3339, the entry
/// is **kept**. Guessing in the delete direction loses a URL the user may
/// still be able to use; guessing in the keep direction only delays cleanup.
/// The single exception is `expires_in_seconds == 0`, which means the URL was
/// valid for no time at all — that cannot be live under any clock, so it is
/// pruned even if `created_at` is missing or garbage.
pub(crate) fn prune_expired_presign_history(
    entries: Vec<PresignHistoryEntry>,
    now: chrono::DateTime<chrono::Utc>,
) -> Vec<PresignHistoryEntry> {
    entries
        .into_iter()
        .filter(|entry| !presign_entry_expired(entry, now))
        .collect()
}

fn presign_entry_expired(entry: &PresignHistoryEntry, now: chrono::DateTime<chrono::Utc>) -> bool {
    if entry.expires_in_seconds == 0 {
        return true;
    }
    let Ok(created_at) = chrono::DateTime::parse_from_rfc3339(&entry.created_at) else {
        // Unparseable `created_at`: keep the entry (see doc comment above).
        return false;
    };
    // A window so large it does not fit the time arithmetic cannot be shown to
    // have ended — keep, same conservative rule.
    let Some(window) = i64::try_from(entry.expires_in_seconds)
        .ok()
        .and_then(chrono::TimeDelta::try_seconds)
    else {
        return false;
    };
    match created_at
        .with_timezone(&chrono::Utc)
        .checked_add_signed(window)
    {
        // `<=` so a URL whose window closed exactly at `now` counts as expired.
        Some(expires_at) => expires_at <= now,
        None => false,
    }
}

/// Prune expired entries, apply the cap, and persist. Shared by both
/// presign commands so the bookkeeping lives in one place.
fn record_presign_entry(
    app_handle: &AppHandleType,
    history_entry: PresignHistoryEntry,
) -> Result<(), String> {
    let mut config = read_config(app_handle)?;
    config.presign_history.insert(0, history_entry);
    config.presign_history =
        prune_expired_presign_history(config.presign_history, chrono::Utc::now());
    if config.presign_history.len() > MAX_PRESIGN_HISTORY {
        config.presign_history.truncate(MAX_PRESIGN_HISTORY);
    }
    write_config(app_handle, &config)
}

#[tauri::command]
pub async fn generate_presigned_url(
    state: tauri::State<'_, GaleonEngine>,
    app_handle: AppHandleType,
    session_id: String,
    key: String,
    expires_in_seconds: u64,
) -> Result<String, String> {
    let sessions = state.active_sessions.read().await;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| "Session not found".to_string())?
        .clone();
    drop(sessions);

    match session {
        StorageSession::OpenDAL(op) => {
            use std::time::Duration;
            let duration = Duration::from_secs(expires_in_seconds);

            let signed_req = op
                .presign_read(&key, duration)
                .await
                .map_err(|e| format!("Failed to presign: {}", e))?;

            let url = signed_req.uri().to_string();

            let file_name = key.split('/').next_back().unwrap_or(&key).to_string();
            let history_entry = PresignHistoryEntry {
                id: Uuid::new_v4().to_string(),
                file_key: key,
                file_name,
                url: url.clone(),
                expires_in_seconds,
                created_at: chrono::Utc::now().to_rfc3339(),
                operation: "download".to_string(),
            };

            record_presign_entry(&app_handle, history_entry)?;

            Ok(url)
        }
        StorageSession::NativeSFTP(_) => {
            Err("Presigned URLs are not supported for native SFTP sessions".to_string())
        }
        StorageSession::FTP(_) => {
            Err("Presigned URLs are not supported for FTP/FTPS sessions".to_string())
        }
    }
}

#[tauri::command]
pub async fn generate_presigned_upload_url(
    state: tauri::State<'_, GaleonEngine>,
    app_handle: AppHandleType,
    session_id: String,
    key: String,
    expires_in_seconds: u64,
) -> Result<String, String> {
    let sessions = state.active_sessions.read().await;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| "Session not found".to_string())?
        .clone();
    drop(sessions);

    match session {
        StorageSession::OpenDAL(op) => {
            use std::time::Duration;
            let duration = Duration::from_secs(expires_in_seconds);

            let signed_req = op
                .presign_write(&key, duration)
                .await
                .map_err(|e| format!("Failed to presign upload: {}", e))?;

            let url = signed_req.uri().to_string();

            let file_name = key.split('/').next_back().unwrap_or(&key).to_string();
            let history_entry = PresignHistoryEntry {
                id: Uuid::new_v4().to_string(),
                file_key: key,
                file_name,
                url: url.clone(),
                expires_in_seconds,
                created_at: chrono::Utc::now().to_rfc3339(),
                operation: "upload".to_string(),
            };

            record_presign_entry(&app_handle, history_entry)?;

            Ok(url)
        }
        StorageSession::NativeSFTP(_) => {
            Err("Presigned URLs are not supported for native SFTP sessions".to_string())
        }
        StorageSession::FTP(_) => {
            Err("Presigned URLs are not supported for FTP/FTPS sessions".to_string())
        }
    }
}

#[tauri::command]
pub async fn get_presign_history(
    app_handle: AppHandleType,
) -> Result<Vec<PresignHistoryEntry>, String> {
    let mut config = read_config(&app_handle)?;
    let original_len = config.presign_history.len();
    let kept = prune_expired_presign_history(config.presign_history, chrono::Utc::now());
    if kept.len() == original_len {
        // Nothing expired: the read path stays a pure read.
        return Ok(kept);
    }
    // Persist the pruning so dead presigned URLs actually leave the disk and
    // not just this response. If the write fails the next read prunes again,
    // so a failure here is surfaced rather than silently swallowed.
    config.presign_history = kept;
    write_config(&app_handle, &config)?;
    Ok(config.presign_history)
}

#[tauri::command]
pub async fn clear_presign_history(app_handle: AppHandleType) -> Result<(), String> {
    let mut config = read_config(&app_handle)?;
    config.presign_history.clear();
    write_config(&app_handle, &config)
}

#[tauri::command]
pub async fn delete_presign_history_entry(
    app_handle: AppHandleType,
    entry_id: String,
) -> Result<(), String> {
    let mut config = read_config(&app_handle)?;
    config.presign_history.retain(|e| e.id != entry_id);
    write_config(&app_handle, &config)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Fixed `now` for every test: 2026-01-01T12:00:00Z.
    fn now() -> chrono::DateTime<chrono::Utc> {
        chrono::DateTime::parse_from_rfc3339("2026-01-01T12:00:00Z")
            .expect("fixed timestamp is valid RFC3339")
            .with_timezone(&chrono::Utc)
    }

    fn entry(id: &str, created_at: &str, expires_in_seconds: u64) -> PresignHistoryEntry {
        PresignHistoryEntry {
            id: id.to_string(),
            file_key: "path/to/object.txt".to_string(),
            file_name: "object.txt".to_string(),
            url: format!(
                "https://bucket.example.invalid/object.txt?X-Amz-Signature={id}&X-Amz-Expires={expires_in_seconds}"
            ),
            expires_in_seconds,
            created_at: created_at.to_string(),
            operation: "download".to_string(),
        }
    }

    #[test]
    fn expired_entries_are_removed_and_unexpired_kept_in_order() {
        let entries = vec![
            entry("newest", "2026-01-01T11:30:00Z", 3600), // 30 min old, 1 h window → live
            entry("stale", "2026-01-01T10:00:00Z", 3600),  // 2 h old, 1 h window → expired
            entry("older-live", "2026-01-01T11:59:59Z", 60), // expires in 1 s → live
        ];

        let pruned = prune_expired_presign_history(entries, now());

        let ids: Vec<&str> = pruned.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["newest", "older-live"],
            "expired dropped, order kept"
        );
    }

    #[test]
    fn a_window_that_closed_exactly_now_counts_as_expired() {
        let entries = vec![entry("boundary", "2026-01-01T11:00:00Z", 3600)];

        let pruned = prune_expired_presign_history(entries, now());

        assert!(pruned.is_empty(), "expires_at == now means the URL is dead");
    }

    #[test]
    fn zero_expiry_is_pruned_even_when_created_at_is_unparseable() {
        // 0 s window: valid for no time at all — cannot be live under any clock.
        let entries = vec![
            entry("zero", "not-a-timestamp", 0),
            entry("zero-parseable", "2026-01-01T11:59:59Z", 0),
        ];

        let pruned = prune_expired_presign_history(entries, now());

        assert!(pruned.is_empty());
    }

    #[test]
    fn unparseable_created_at_is_kept_conservatively() {
        // Losing a live URL the user might still use is worse than keeping a
        // stale one, so an unreadable timestamp never triggers deletion.
        let entries = vec![
            entry("garbage", "yesterday", 3600),
            entry("empty", "", 3600),
            entry("huge-window", "2026-01-01T11:00:00Z", u64::MAX),
        ];

        let pruned = prune_expired_presign_history(entries, now());

        assert_eq!(pruned.len(), 3);
    }

    #[test]
    fn an_empty_list_stays_empty() {
        let pruned = prune_expired_presign_history(vec![], now());
        assert!(pruned.is_empty());
    }
}
