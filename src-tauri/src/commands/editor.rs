// Edit-in-external-editor sessions: open, watch for saves, stop, list.

use crate::*;

/// Emitted (camelCase) each time a watched external edit is saved and queued
/// for re-upload, so the frontend can refresh its Active Editors list.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct EditorSavedPayload {
    pub editor_id: String,
    pub remote_key: String,
    pub filename: String,
    pub save_count: u64,
}

/// Summary of an active external-edit session for the Active Editors UI.
/// Field names are serialized as camelCase JSON keys.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct EditSessionInfo {
    pub editor_id: String,
    pub session_id: String,
    pub remote_key: String,
    pub filename: String,
    pub started_at: String,            // rfc3339
    pub last_saved_at: Option<String>, // rfc3339, None until first save
    pub save_count: u64,
}

/// Open a remote object in the OS default editor and watch the local temp copy;
/// any save is re-uploaded back to `remote_key`. Returns an `editor_id`.
#[tauri::command]
pub async fn edit_remote_file(
    state: tauri::State<'_, GaleonEngine>,
    app_handle: AppHandleType,
    session_id: String,
    remote_key: String,
    profile_id: Option<String>,
) -> Result<String, String> {
    let _ = profile_id; // currently unused; reserved for parity with upload API

    if remote_key.contains("..") {
        return Err("Path traversal detected".to_string());
    }

    let sessions = state.active_sessions.read().await;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| "Session not found".to_string())?
        .clone();
    drop(sessions);

    // External edit is only supported for OpenDAL (S3) Operator-based sessions.
    let op = match session {
        StorageSession::OpenDAL(op) => op,
        StorageSession::NativeSFTP(_) | StorageSession::FTP(_) => {
            return Err("External edit is only supported for S3 right now".to_string());
        }
    };

    // Build temp location: <temp>/galeon-edits/<uuid>/<filename>
    let edit_uuid = Uuid::new_v4().to_string();
    let filename = remote_key
        .split('/')
        .next_back()
        .filter(|s| !s.is_empty())
        .unwrap_or("file")
        .to_string();
    let temp_path = edit_temp_dir(&edit_uuid, &filename);
    let temp_dir = temp_path
        .parent()
        .ok_or_else(|| "Failed to derive temp directory".to_string())?
        .to_path_buf();

    std::fs::create_dir_all(&temp_dir).map_err(|e| format!("Failed to create temp dir: {}", e))?;

    let temp_path_string = temp_path.to_string_lossy().to_string();

    // Download remote object into the temp path (reuse the chunked downloader).
    perform_download(
        app_handle.clone(),
        op.clone(),
        remote_key.clone(),
        temp_path_string.clone(),
        None,
    )
    .await?;

    // Open with the OS default application.
    {
        use tauri_plugin_opener::OpenerExt;
        app_handle
            .opener()
            .open_path(temp_path_string.clone(), None::<&str>)
            .map_err(|e| format!("Failed to open file in editor: {}", e))?;
    }

    let editor_id = Uuid::new_v4().to_string();
    let stop = Arc::new(AtomicBool::new(false));

    // Lifecycle metadata shared with the watcher thread: bumped on every save so
    // the Active Editors UI and the idle janitor can observe progress.
    let started_at_ms = now_ms();
    let last_saved_ms = Arc::new(AtomicU64::new(0));
    let save_count = Arc::new(AtomicU64::new(0));

    // Capture the current tokio runtime handle so the (sync) watcher thread can
    // bridge file events into async re-uploads.
    let runtime = tokio::runtime::Handle::current();

    let thread_stop = stop.clone();
    let watch_dir = temp_dir.clone();
    let watch_target = temp_path.clone();
    let upload_app = app_handle.clone();
    let upload_op = op.clone();
    let upload_remote_key = remote_key.clone();
    let upload_path_string = temp_path_string.clone();
    let watch_editor_id = editor_id.clone();
    let watch_filename = filename.clone();
    let watch_last_saved = last_saved_ms.clone();
    let watch_save_count = save_count.clone();

    let watcher_thread = std::thread::spawn(move || {
        use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
        use std::sync::mpsc::channel;
        use std::time::{Duration, Instant};
        use tauri::Emitter;

        let (tx, rx) = channel::<notify::Result<notify::Event>>();

        let mut watcher: RecommendedWatcher = match notify::recommended_watcher(move |res| {
            let _ = tx.send(res);
        }) {
            Ok(w) => w,
            Err(_) => return,
        };

        if watcher
            .watch(&watch_dir, RecursiveMode::NonRecursive)
            .is_err()
        {
            return;
        }

        // Debounce: ignore events within ~500ms of the last handled save.
        let debounce = Duration::from_millis(500);
        let mut last_handled: Option<Instant> = None;

        // Canonicalize the watch target so symlink /private/var vs /var mismatches
        // don't prevent the re-upload branch from firing.
        let watch_target_canonical =
            std::fs::canonicalize(&watch_target).unwrap_or_else(|_| watch_target.clone());
        let watch_target_name = watch_target_canonical.file_name().map(|n| n.to_owned());

        loop {
            if thread_stop.load(Ordering::SeqCst) {
                break;
            }

            match rx.recv_timeout(Duration::from_millis(200)) {
                Ok(Ok(event)) => {
                    if thread_stop.load(Ordering::SeqCst) {
                        break;
                    }

                    let is_write =
                        matches!(event.kind, EventKind::Modify(_) | EventKind::Create(_));
                    if !is_write {
                        continue;
                    }

                    // Only react to events touching our specific temp file.
                    // Use canonicalized path comparison plus a filename fallback
                    // to handle macOS /var vs /private/var symlinks and atomic
                    // editors that write to a sibling temp file then rename().
                    let touches_target = event.paths.iter().any(|p| {
                        std::fs::canonicalize(p).ok().as_deref()
                            == Some(watch_target_canonical.as_path())
                            || watch_target_name
                                .as_deref()
                                .map(|name| p.file_name() == Some(name))
                                .unwrap_or(false)
                    });
                    if !touches_target {
                        continue;
                    }

                    let now = Instant::now();
                    if let Some(prev) = last_handled {
                        if now.duration_since(prev) < debounce {
                            continue;
                        }
                    }
                    last_handled = Some(now);

                    // Record the save for the Active Editors UI / idle janitor,
                    // then notify the frontend so it can refresh its list.
                    let saves = watch_save_count.fetch_add(1, Ordering::SeqCst) + 1;
                    watch_last_saved.store(now_ms(), Ordering::SeqCst);
                    let _ = upload_app.emit(
                        "editor-saved",
                        EditorSavedPayload {
                            editor_id: watch_editor_id.clone(),
                            remote_key: upload_remote_key.clone(),
                            filename: watch_filename.clone(),
                            save_count: saves,
                        },
                    );

                    // Spawn the re-upload on the tokio runtime; emits the same
                    // transfer-progress/transfer-complete/transfer-failed events.
                    let app = upload_app.clone();
                    let op = upload_op.clone();
                    let r_key = upload_remote_key.clone();
                    let local = upload_path_string.clone();
                    runtime.spawn(async move {
                        if let Err(e) =
                            perform_upload(app.clone(), op, local, r_key.clone(), None).await
                        {
                            let _ = app.emit(
                                "transfer-failed",
                                transfer_error_payload(r_key, e, None, "upload"),
                            );
                        }
                    });
                }
                Ok(Err(_)) => continue,
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }

        // Dropping the watcher here stops filesystem notifications.
        drop(watcher);
    });

    let edit_session = EditSession {
        stop,
        temp_dir,
        watcher_thread: Some(watcher_thread),
        session_id: session_id.clone(),
        remote_key: remote_key.clone(),
        filename,
        started_at_ms,
        last_saved_ms,
        save_count,
    };

    state
        .editors
        .write()
        .await
        .insert(editor_id.clone(), edit_session);

    // Lazily start the idle-editor janitor the first time anything is edited.
    if state
        .editor_janitor_started
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
    {
        tokio::spawn(run_editor_janitor(
            state.editors.clone(),
            app_handle.clone(),
        ));
    }

    Ok(editor_id)
}

/// Stop watching/editing a remote file: terminate the watcher thread and clean
/// up the temp directory.
#[tauri::command]
pub async fn stop_editing_file(
    state: tauri::State<'_, GaleonEngine>,
    editor_id: String,
) -> Result<(), String> {
    let mut editor = {
        let mut editors = state.editors.write().await;
        editors
            .remove(&editor_id)
            .ok_or_else(|| "Editor session not found".to_string())?
    };

    // Signal the watcher thread to stop and wait for it to exit.
    editor.stop.store(true, Ordering::SeqCst);
    if let Some(handle) = editor.watcher_thread.take() {
        let _ = handle.join();
    }

    // Best-effort cleanup of the temp directory.
    let _ = std::fs::remove_dir_all(&editor.temp_dir);

    Ok(())
}

/// Pure (unit-tested) projection of the editor registry into UI summaries,
/// optionally scoped to a single storage session and sorted by start time.
pub fn collect_edit_sessions(
    editors: &HashMap<String, EditSession>,
    session_id: Option<&str>,
) -> Vec<EditSessionInfo> {
    let mut out: Vec<EditSessionInfo> = editors
        .iter()
        .filter(|(_, s)| session_id.map(|sid| s.session_id == sid).unwrap_or(true))
        .map(|(id, s)| {
            let last_ms = s.last_saved_ms.load(Ordering::SeqCst);
            EditSessionInfo {
                editor_id: id.clone(),
                session_id: s.session_id.clone(),
                remote_key: s.remote_key.clone(),
                filename: s.filename.clone(),
                started_at: ms_to_rfc3339(s.started_at_ms),
                last_saved_at: if last_ms == 0 {
                    None
                } else {
                    Some(ms_to_rfc3339(last_ms))
                },
                save_count: s.save_count.load(Ordering::SeqCst),
            }
        })
        .collect();
    out.sort_by(|a, b| a.started_at.cmp(&b.started_at));
    out
}

/// List active external-edit sessions for the Active Editors UI. When
/// `session_id` is provided, only sessions belonging to that storage session
/// are returned; otherwise all sessions are listed. Sorted by start time.
#[tauri::command]
pub async fn list_edit_sessions(
    state: tauri::State<'_, GaleonEngine>,
    session_id: Option<String>,
) -> Result<Vec<EditSessionInfo>, String> {
    let editors = state.editors.read().await;
    Ok(collect_edit_sessions(&editors, session_id.as_deref()))
}

// ========================================================================
// Phase 11 — Sync commands
// ========================================================================
