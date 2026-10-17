// Transfer commands: start, pause, resume, cancel, and job finalization.

use crate::*;

#[tauri::command]
pub async fn initiate_download(
    state: tauri::State<'_, GaleonEngine>,
    app_handle: AppHandleType,
    session_id: String,
    remote_key: String,
    local_path: String,
    profile_id: Option<String>,
) -> Result<String, String> {
    if remote_key.contains("..") || local_path.contains("..") {
        return Err("Path traversal detected".to_string());
    }

    let sessions = state.active_sessions.read().await;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| "Session not found".to_string())?
        .clone();
    drop(sessions);

    let transfer_id = Uuid::new_v4().to_string();
    let control = state.register_transfer(transfer_id.clone()).await;

    // Get file size (differs by session type) and determine the download path
    let total_bytes = match &session {
        StorageSession::OpenDAL(op) => op
            .stat(&remote_key)
            .await
            .map(|m| m.content_length())
            .unwrap_or(0),
        StorageSession::NativeSFTP(sftp_arc) => {
            let sftp = sftp_arc.lock().map_err(|e| format!("Lock: {}", e))?;
            sftp.file_size(&remote_key).unwrap_or(0)
        }
        StorageSession::FTP(ftp_arc) => {
            let mut ftp = ftp_arc.lock().map_err(|e| format!("Lock: {}", e))?;
            ftp.file_size(&remote_key).unwrap_or(0)
        }
    };

    // Add to persistent queue
    let queue_entry = TransferQueueEntry {
        id: transfer_id.clone(),
        direction: "download".to_string(),
        remote_key: remote_key.clone(),
        local_path: local_path.clone(),
        profile_id: profile_id.clone().unwrap_or_default(),
        session_id: Some(session_id.clone()),
        status: "active".to_string(),
        bytes_transferred: 0,
        total_bytes,
        created_at: chrono::Utc::now().to_rfc3339(),
        updated_at: chrono::Utc::now().to_rfc3339(),
        error: None,
    };
    let _ = add_to_transfer_queue(app_handle.clone(), queue_entry).await;

    {
        use tauri::Emitter;
        let _ = app_handle.emit(
            "transfer-started",
            TransferStartedPayload {
                id: transfer_id.clone(),
                remote_key: remote_key.clone(),
                local_path: local_path.clone(),
                direction: "download".to_string(),
                total_bytes,
                profile_id: profile_id.clone().unwrap_or_default(),
            },
        );
    }

    let r_key = remote_key.clone();
    let handle = app_handle.clone();
    let ctrl = control.clone();
    let tid = transfer_id.clone();
    let registry = state.transfers.clone();
    let local_path_q = local_path.clone();
    let profile_id_q = profile_id.clone().unwrap_or_default();

    match session {
        StorageSession::OpenDAL(op) => {
            tokio::spawn(async move {
                let result =
                    run_transfer_with_retries(handle.clone(), r_key.clone(), ctrl.clone(), || {
                        let app = app_handle.clone();
                        let op = op.clone();
                        let rk = remote_key.clone();
                        let lp = local_path.clone();
                        let c = ctrl.clone();
                        async move { perform_download(app, op, rk, lp, Some(c)).await }
                    })
                    .await;
                finalize_transfer_job(
                    handle,
                    registry,
                    tid,
                    "download",
                    r_key,
                    local_path_q,
                    profile_id_q,
                    result,
                )
                .await;
            });
        }
        StorageSession::NativeSFTP(sftp_arc) => {
            tokio::spawn(async move {
                let result =
                    run_transfer_with_retries(handle.clone(), r_key.clone(), ctrl.clone(), || {
                        let app = app_handle.clone();
                        let s = sftp_arc.clone();
                        let rk = remote_key.clone();
                        let lp = local_path.clone();
                        let c = ctrl.clone();
                        async move { perform_native_sftp_download(app, s, rk, lp, Some(c)).await }
                    })
                    .await;
                finalize_transfer_job(
                    handle,
                    registry,
                    tid,
                    "download",
                    r_key,
                    local_path_q,
                    profile_id_q,
                    result,
                )
                .await;
            });
        }
        StorageSession::FTP(ftp_arc) => {
            tokio::spawn(async move {
                let result =
                    run_transfer_with_retries(handle.clone(), r_key.clone(), ctrl.clone(), || {
                        let app = app_handle.clone();
                        let f = ftp_arc.clone();
                        let rk = remote_key.clone();
                        let lp = local_path.clone();
                        let c = ctrl.clone();
                        async move { perform_ftp_download(app, f, rk, lp, Some(c)).await }
                    })
                    .await;
                finalize_transfer_job(
                    handle,
                    registry,
                    tid,
                    "download",
                    r_key,
                    local_path_q,
                    profile_id_q,
                    result,
                )
                .await;
            });
        }
    }

    Ok(transfer_id)
}

#[tauri::command]
pub async fn initiate_upload(
    state: tauri::State<'_, GaleonEngine>,
    app_handle: AppHandleType,
    session_id: String,
    local_path: String,
    remote_key: String,
    profile_id: Option<String>,
) -> Result<String, String> {
    if remote_key.contains("..") || local_path.contains("..") {
        return Err("Path traversal detected".to_string());
    }

    let sessions = state.active_sessions.read().await;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| "Session not found".to_string())?
        .clone();
    drop(sessions);

    let transfer_id = Uuid::new_v4().to_string();
    let control = state.register_transfer(transfer_id.clone()).await;

    // Get file size for queue entry
    let total_bytes = tokio::fs::metadata(&local_path)
        .await
        .map(|m| m.len())
        .unwrap_or(0);

    // Add to persistent queue
    let queue_entry = TransferQueueEntry {
        id: transfer_id.clone(),
        direction: "upload".to_string(),
        remote_key: remote_key.clone(),
        local_path: local_path.clone(),
        profile_id: profile_id.clone().unwrap_or_default(),
        session_id: Some(session_id.clone()),
        status: "active".to_string(),
        bytes_transferred: 0,
        total_bytes,
        created_at: chrono::Utc::now().to_rfc3339(),
        updated_at: chrono::Utc::now().to_rfc3339(),
        error: None,
    };
    let _ = add_to_transfer_queue(app_handle.clone(), queue_entry).await;

    {
        use tauri::Emitter;
        let _ = app_handle.emit(
            "transfer-started",
            TransferStartedPayload {
                id: transfer_id.clone(),
                remote_key: remote_key.clone(),
                local_path: local_path.clone(),
                direction: "upload".to_string(),
                total_bytes,
                profile_id: profile_id.clone().unwrap_or_default(),
            },
        );
    }

    let r_key = remote_key.clone();
    let handle = app_handle.clone();
    let ctrl = control.clone();
    let tid = transfer_id.clone();
    let registry = state.transfers.clone();
    let local_path_q = local_path.clone();
    let profile_id_q = profile_id.clone().unwrap_or_default();

    match session {
        StorageSession::OpenDAL(op) => {
            tokio::spawn(async move {
                let result =
                    run_transfer_with_retries(handle.clone(), r_key.clone(), ctrl.clone(), || {
                        let app = app_handle.clone();
                        let op = op.clone();
                        let lp = local_path.clone();
                        let rk = remote_key.clone();
                        let c = ctrl.clone();
                        async move { perform_upload(app, op, lp, rk, Some(c)).await }
                    })
                    .await;
                finalize_transfer_job(
                    handle,
                    registry,
                    tid,
                    "upload",
                    r_key,
                    local_path_q,
                    profile_id_q,
                    result,
                )
                .await;
            });
        }
        StorageSession::NativeSFTP(sftp_arc) => {
            tokio::spawn(async move {
                let result =
                    run_transfer_with_retries(handle.clone(), r_key.clone(), ctrl.clone(), || {
                        let app = app_handle.clone();
                        let s = sftp_arc.clone();
                        let lp = local_path.clone();
                        let rk = remote_key.clone();
                        let c = ctrl.clone();
                        async move { perform_native_sftp_upload(app, s, lp, rk, Some(c)).await }
                    })
                    .await;
                finalize_transfer_job(
                    handle,
                    registry,
                    tid,
                    "upload",
                    r_key,
                    local_path_q,
                    profile_id_q,
                    result,
                )
                .await;
            });
        }
        StorageSession::FTP(ftp_arc) => {
            tokio::spawn(async move {
                let result =
                    run_transfer_with_retries(handle.clone(), r_key.clone(), ctrl.clone(), || {
                        let app = app_handle.clone();
                        let f = ftp_arc.clone();
                        let lp = local_path.clone();
                        let rk = remote_key.clone();
                        let c = ctrl.clone();
                        async move { perform_ftp_upload(app, f, lp, rk, Some(c)).await }
                    })
                    .await;
                finalize_transfer_job(
                    handle,
                    registry,
                    tid,
                    "upload",
                    r_key,
                    local_path_q,
                    profile_id_q,
                    result,
                )
                .await;
            });
        }
    }

    Ok(transfer_id)
}

#[tauri::command]
pub async fn pause_transfer(
    app_handle: AppHandleType,
    state: tauri::State<'_, GaleonEngine>,
    transfer_id: String,
) -> Result<(), String> {
    if let Some(control) = state.get_transfer(&transfer_id).await {
        control.paused.store(true, Ordering::SeqCst);
        use tauri::Emitter;
        let _ = app_handle.emit("transfer-paused", &transfer_id);
        Ok(())
    } else {
        Err("Transfer not found".to_string())
    }
}

#[tauri::command]
pub async fn resume_transfer(
    app_handle: AppHandleType,
    state: tauri::State<'_, GaleonEngine>,
    transfer_id: String,
) -> Result<(), String> {
    if let Some(control) = state.get_transfer(&transfer_id).await {
        control.paused.store(false, Ordering::SeqCst);
        control.resume_notify.notify_one();
        use tauri::Emitter;
        let _ = app_handle.emit("transfer-resumed", &transfer_id);
        return Ok(());
    }

    // Not in the in-memory registry. `finalize_transfer_job` removes the
    // control when a transfer ENDS, so a failed transfer lands here and used to
    // get "Transfer not found" — the only recovery was starting the transfer
    // again by hand. Rebuild it from the queue entry instead.
    //
    // The rebuild needs the storage session the transfer was started against,
    // which is why the queue entry records one.
    retry_failed_transfer(&app_handle, &state, &transfer_id).await
}

/// Re-enqueue a failed (or cancelled) transfer from its queue entry.
///
/// Returns the new transfer id. A download resumes from its `.part` file, so a
/// retry after a late failure does not re-transfer what already arrived.
async fn retry_failed_transfer(
    app_handle: &AppHandleType,
    state: &tauri::State<'_, GaleonEngine>,
    transfer_id: &str,
) -> Result<(), String> {
    let queue = get_transfer_queue(app_handle.clone()).await?;
    let entry = queue
        .entries
        .iter()
        .find(|e| e.id == transfer_id)
        .cloned()
        .ok_or_else(|| "Transfer not found".to_string())?;

    if !matches!(entry.status.as_str(), "failed" | "cancelled") {
        return Err(format!(
            "Transfer is {} and cannot be retried",
            entry.status
        ));
    }

    let session_id = entry
        .session_id
        .clone()
        // Older queue files predate this field, so a transfer recorded before
        // the upgrade cannot be rebuilt. Say so rather than guessing a session.
        .ok_or_else(|| {
            "This transfer is too old to retry — start it again from the file list.".to_string()
        })?;

    if !state.active_sessions.read().await.contains_key(&session_id) {
        return Err(
            "That connection is no longer open — reconnect and start the transfer again."
                .to_string(),
        );
    }

    let profile_id = if entry.profile_id.is_empty() {
        None
    } else {
        Some(entry.profile_id.clone())
    };

    // Clone the fields the two arms need so `entry` stays whole for the
    // bookkeeping below.
    let direction = entry.direction.clone();
    let local_path = entry.local_path.clone();
    let remote_key = entry.remote_key.clone();

    match direction.as_str() {
        "upload" => {
            initiate_upload(
                state.clone(),
                app_handle.clone(),
                session_id,
                local_path,
                remote_key,
                profile_id,
            )
            .await?;
        }
        "download" => {
            initiate_download(
                state.clone(),
                app_handle.clone(),
                session_id,
                remote_key,
                local_path,
                profile_id,
            )
            .await?;
        }
        other => return Err(format!("Unknown transfer direction: {}", other)),
    }

    // The old row would otherwise sit in the list next to its replacement.
    let mut old = entry;
    old.status = "retried".to_string();
    let _ = update_transfer_queue_entry(app_handle.clone(), old).await;
    Ok(())
}

#[tauri::command]
pub async fn cancel_transfer(
    app_handle: AppHandleType,
    state: tauri::State<'_, GaleonEngine>,
    transfer_id: String,
) -> Result<(), String> {
    if let Some(control) = state.get_transfer(&transfer_id).await {
        control.cancel.cancel();
        use tauri::Emitter;
        let _ = app_handle.emit("transfer-cancelled", &transfer_id);
        state.remove_transfer(&transfer_id).await;
        Ok(())
    } else {
        Err("Transfer not found".to_string())
    }
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn finalize_transfer_job(
    handle: AppHandleType,
    registry: Arc<RwLock<HashMap<String, TransferControl>>>,
    tid: String,
    direction: &str,
    remote_key: String,
    local_path: String,
    profile_id: String,
    result: Result<(), String>,
) {
    use tauri::Emitter;
    match result {
        Err(e) => {
            let _ = handle.emit(
                "transfer-failed",
                transfer_error_payload(
                    remote_key.clone(),
                    e.clone(),
                    Some(local_path.clone()),
                    direction,
                ),
            );
            let status = if e == "Transfer cancelled" {
                "cancelled".to_string()
            } else {
                "failed".to_string()
            };
            let entry = TransferQueueEntry {
                id: tid.clone(),
                direction: direction.to_string(),
                remote_key,
                local_path,
                profile_id,
                // Preserved by update_transfer_queue_entry below; the entry
                // being finalised already carries it from enqueue time.
                session_id: None,
                status,
                bytes_transferred: 0,
                total_bytes: 0,
                created_at: chrono::Utc::now().to_rfc3339(),
                updated_at: chrono::Utc::now().to_rfc3339(),
                error: Some(e),
            };
            let _ = update_transfer_queue_entry(handle, entry).await;
        }
        Ok(()) => {
            let entry = TransferQueueEntry {
                id: tid.clone(),
                direction: direction.to_string(),
                remote_key,
                local_path,
                profile_id,
                // Set at enqueue time and preserved by update_transfer_queue_entry.
                session_id: None,
                status: "completed".to_string(),
                bytes_transferred: 0,
                total_bytes: 0,
                created_at: chrono::Utc::now().to_rfc3339(),
                updated_at: chrono::Utc::now().to_rfc3339(),
                error: None,
            };
            let _ = update_transfer_queue_entry(handle, entry).await;
        }
    }
    registry.write().await.remove(&tid);
}

/// Read one byte range with per-chunk transient retries.
pub(crate) async fn read_range_with_retry(
    op: &Operator,
    key: &str,
    range: std::ops::Range<u64>,
) -> Result<opendal::Buffer, String> {
    transfer_retry::with_transient_retries(
        transfer_retry::CHUNK_MAX_ATTEMPTS,
        |_, _, _| {},
        || {
            let op = op.clone();
            let key = key.to_string();
            let range = range.clone();
            async move {
                op.read_with(&key)
                    .range(range)
                    .await
                    .map_err(|e| e.to_string())
            }
        },
    )
    .await
}

/// Write one buffer to an OpenDAL writer with transient retries.
pub(crate) async fn write_chunk_with_retry(
    writer: &mut opendal::Writer,
    chunk: Vec<u8>,
) -> Result<(), String> {
    // OpenDAL Writer::write consumes the buffer; clone only on retry.
    let mut last_err = String::new();
    for attempt in 0..transfer_retry::CHUNK_MAX_ATTEMPTS {
        match writer.write(chunk.clone()).await {
            Ok(()) => return Ok(()),
            Err(e) => {
                let msg = e.to_string();
                if !transfer_retry::is_transient_transfer_error(&msg)
                    || attempt + 1 >= transfer_retry::CHUNK_MAX_ATTEMPTS
                {
                    return Err(msg);
                }
                last_err = msg;
                tokio::time::sleep(transfer_retry::transfer_backoff(attempt)).await;
            }
        }
    }
    Err(last_err)
}
