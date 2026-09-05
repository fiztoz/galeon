//! Open-in-external-editor support: temp paths, idle detection, janitor.

use crate::*;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::RwLock;

/// Tracks an active "edit remote file" session: a temp copy of a remote object
/// that is being watched for local modifications and re-uploaded on save.
pub struct EditSession {
    /// Set to true to signal the watcher thread to stop and exit.
    pub stop: Arc<AtomicBool>,
    /// Temp directory holding the downloaded file; removed on stop.
    pub temp_dir: std::path::PathBuf,
    /// Join handle for the watcher thread (so stop can join it).
    pub watcher_thread: Option<std::thread::JoinHandle<()>>,
    /// Storage session this editor belongs to (lets the UI scope its list and
    /// the janitor drop editors when their session goes away).
    pub session_id: String,
    /// Remote object key being edited.
    pub remote_key: String,
    /// Display filename (last path segment of `remote_key`).
    pub filename: String,
    /// When the edit session started, as unix epoch milliseconds.
    pub started_at_ms: u64,
    /// Unix epoch millis of the most recent save/re-upload (0 = never saved).
    /// Shared with the watcher thread so it can record activity on each save.
    pub last_saved_ms: Arc<AtomicU64>,
    /// Number of times the file has been saved and re-uploaded.
    pub save_count: Arc<AtomicU64>,
}

/// How long an edit session may sit idle (no saves) before the background
/// janitor auto-stops its watcher and removes the temp directory.
const EDIT_IDLE_TIMEOUT_MS: u64 = 2 * 60 * 60 * 1000; // 2 hours
/// How often the janitor scans for idle edit sessions.
const EDIT_JANITOR_INTERVAL_SECS: u64 = 60;
/// Pure helper (unit-tested): an edit session is idle when its most recent
/// activity — the last save, or the start time if it has never been saved — is
/// at least `timeout_ms` in the past.
pub(crate) fn edit_session_is_idle(
    now: u64,
    started_at_ms: u64,
    last_saved_ms: u64,
    timeout_ms: u64,
) -> bool {
    let last_activity = last_saved_ms.max(started_at_ms);
    now.saturating_sub(last_activity) >= timeout_ms
}

/// Background task: every `EDIT_JANITOR_INTERVAL_SECS`, stop and clean up any
/// edit sessions that have been idle past `EDIT_IDLE_TIMEOUT_MS`, emitting
/// `editor-closed` so the UI can drop them from its list.
pub(crate) async fn run_editor_janitor(
    editors: Arc<RwLock<HashMap<String, EditSession>>>,
    app: AppHandleType,
) {
    use tauri::Emitter;
    loop {
        tokio::time::sleep(std::time::Duration::from_secs(EDIT_JANITOR_INTERVAL_SECS)).await;
        let now = now_ms();

        // Collect idle ids under a read lock, then drop it before mutating.
        let idle_ids: Vec<String> = {
            let guard = editors.read().await;
            guard
                .iter()
                .filter(|(_, s)| {
                    edit_session_is_idle(
                        now,
                        s.started_at_ms,
                        s.last_saved_ms.load(Ordering::SeqCst),
                        EDIT_IDLE_TIMEOUT_MS,
                    )
                })
                .map(|(id, _)| id.clone())
                .collect()
        };

        for id in idle_ids {
            let removed = { editors.write().await.remove(&id) };
            if let Some(mut session) = removed {
                session.stop.store(true, Ordering::SeqCst);
                if let Some(handle) = session.watcher_thread.take() {
                    let _ = tokio::task::spawn_blocking(move || {
                        let _ = handle.join();
                    })
                    .await;
                }
                let _ = std::fs::remove_dir_all(&session.temp_dir);
                let _ = app.emit("editor-closed", serde_json::json!({ "editorId": id }));
            }
        }
    }
}

/// Pure helper: build the temp path used for an external edit.
/// Layout: <system temp>/galeon-edits/<uuid>/<filename>.
pub(crate) fn edit_temp_dir(uuid: &str, filename: &str) -> std::path::PathBuf {
    std::env::temp_dir()
        .join("galeon-edits")
        .join(uuid)
        .join(filename)
}

/// Temp path for a one-shot external preview (e.g. PDF in macOS Preview).
/// Layout: <system temp>/galeon-previews/<uuid>/<filename>.
pub(crate) fn preview_temp_dir(uuid: &str, filename: &str) -> std::path::PathBuf {
    std::env::temp_dir()
        .join("galeon-previews")
        .join(uuid)
        .join(filename)
}

/// Remove preview temp folders older than `max_age`. Called before each preview
/// open so stale copies don't accumulate. We can't delete immediately after
/// opening — Preview.app keeps the file mapped while it's open.
pub(crate) fn cleanup_stale_previews(max_age: std::time::Duration) {
    let base = std::env::temp_dir().join("galeon-previews");
    if !base.is_dir() {
        return;
    }
    let cutoff = std::time::SystemTime::now()
        .checked_sub(max_age)
        .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
    let entries = match std::fs::read_dir(&base) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let modified = entry.metadata().ok().and_then(|m| m.modified().ok());
        if modified.is_some_and(|t| t < cutoff) {
            let _ = std::fs::remove_dir_all(&path);
        }
    }
}
