// Object mutations: create folder, delete (single + bulk), rename, copy.

use crate::*;

#[tauri::command]
pub async fn create_folder(
    state: tauri::State<'_, GaleonEngine>,
    session_id: String,
    prefix: String,
    folder_name: String,
) -> Result<(), String> {
    let sessions = state.active_sessions.read().await;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| "Session not found".to_string())?
        .clone();
    drop(sessions);

    match session {
        StorageSession::OpenDAL(op) => {
            let folder_key = if prefix.is_empty() {
                format!("{}/", folder_name)
            } else if prefix.ends_with('/') {
                format!("{}{}", prefix, folder_name)
            } else {
                format!("{}/{}", prefix, folder_name)
            };
            let folder_key = if folder_key.ends_with('/') {
                folder_key
            } else {
                format!("{}/", folder_key)
            };

            op.create_dir(&folder_key)
                .await
                .map_err(|e| format!("Failed to create folder: {}", e))?;
            invalidate_prefix_size_cache_for_session(&state, &session_id).await;
            Ok(())
        }
        StorageSession::NativeSFTP(sftp_arc) => {
            let sftp = sftp_arc.lock().map_err(|e| format!("Lock: {}", e))?;
            let dir_path = if prefix.is_empty() {
                folder_name
            } else {
                format!("{}/{}", prefix, folder_name)
            };
            let dir_path = dir_path.trim_end_matches('/');
            sftp.mkdir(dir_path)
        }
        StorageSession::FTP(ftp_arc) => {
            let mut ftp = ftp_arc.lock().map_err(|e| format!("Lock: {}", e))?;
            let dir_path = if prefix.is_empty() {
                folder_name
            } else {
                format!("{}/{}", prefix, folder_name)
            };
            let dir_path = dir_path.trim_end_matches('/');
            ftp.mkdir(dir_path)
        }
    }
}

pub(crate) async fn perform_delete_object(
    session: &StorageSession,
    key: String,
    is_folder: bool,
) -> Result<(), String> {
    match session {
        StorageSession::OpenDAL(op) => {
            if is_folder {
                let folder_key = if key.ends_with('/') {
                    key
                } else {
                    format!("{}/", key)
                };
                op.delete_with(&folder_key)
                    .recursive(true)
                    .await
                    .map_err(|e| format!("Failed to delete folder: {}", e))?;
            } else {
                op.delete_iter(vec![key])
                    .await
                    .map_err(|e| format!("Failed to delete file: {}", e))?;
            }
            Ok(())
        }
        StorageSession::NativeSFTP(sftp_arc) => {
            let sftp = sftp_arc.lock().map_err(|e| format!("Lock: {}", e))?;
            if is_folder {
                sftp.remove_all(&key)
            } else {
                sftp.remove(&key, false)
            }
        }
        StorageSession::FTP(ftp_arc) => {
            let mut ftp = ftp_arc.lock().map_err(|e| format!("Lock: {}", e))?;
            ftp.remove(&key, is_folder)
        }
    }
}

#[tauri::command]
pub async fn delete_object(
    state: tauri::State<'_, GaleonEngine>,
    session_id: String,
    key: String,
    is_folder: bool,
) -> Result<(), String> {
    let sessions = state.active_sessions.read().await;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| "Session not found".to_string())?
        .clone();
    drop(sessions);

    let is_opendal = matches!(session, StorageSession::OpenDAL(_));
    perform_delete_object(&session, key, is_folder).await?;
    if is_opendal {
        invalidate_prefix_size_cache_for_session(&state, &session_id).await;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn emit_delete_progress(
    app_handle: &AppHandleType,
    job_id: &str,
    done: u64,
    total: u64,
    current_key: &str,
    complete: bool,
    cancelled: bool,
    failures: &[String],
    error: Option<String>,
) {
    use tauri::Emitter;
    let _ = app_handle.emit(
        "delete-progress",
        DeleteProgressPayload {
            job_id: job_id.to_string(),
            done,
            total,
            current_key: current_key.to_string(),
            complete,
            cancelled,
            failures: failures.to_vec(),
            error,
        },
    );
}

/// Delete multiple objects in the background. Returns a `job_id` immediately;
/// progress and completion are delivered via `delete-progress` events.
#[tauri::command]
pub async fn delete_objects(
    app_handle: AppHandleType,
    state: tauri::State<'_, GaleonEngine>,
    session_id: String,
    items: Vec<DeleteObjectItem>,
) -> Result<DeleteObjectsResponse, String> {
    if items.is_empty() {
        return Err("No items to delete".to_string());
    }

    let sessions = state.active_sessions.read().await;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| "Session not found".to_string())?
        .clone();
    drop(sessions);

    let is_opendal = matches!(session, StorageSession::OpenDAL(_));
    let job_id = Uuid::new_v4().to_string();
    let cancel = Arc::new(AtomicBool::new(false));
    state
        .delete_jobs
        .write()
        .await
        .insert(job_id.clone(), cancel.clone());

    let total = items.len() as u64;
    let handle = app_handle.clone();
    let engine = state.inner().clone();
    let job_id_spawn = job_id.clone();
    let session_id_spawn = session_id.clone();

    emit_delete_progress(
        &handle,
        &job_id_spawn,
        0,
        total,
        &items[0].key,
        false,
        false,
        &[],
        None,
    );

    tauri::async_runtime::spawn(async move {
        let mut done: u64 = 0;
        let mut failures: Vec<String> = Vec::new();
        let mut cancelled = false;

        for item in &items {
            if cancel.load(Ordering::SeqCst) {
                cancelled = true;
                break;
            }

            emit_delete_progress(
                &handle,
                &job_id_spawn,
                done,
                total,
                &item.key,
                false,
                false,
                &failures,
                None,
            );

            match perform_delete_object(&session, item.key.clone(), item.is_folder).await {
                Ok(()) => {}
                Err(e) => failures.push(format!("{}: {}", item.key, e)),
            }

            done += 1;
            emit_delete_progress(
                &handle,
                &job_id_spawn,
                done,
                total,
                &item.key,
                false,
                false,
                &failures,
                None,
            );
        }

        if is_opendal && done > 0 && !cancelled {
            invalidate_prefix_size_cache_for_session(&engine, &session_id_spawn).await;
        }

        emit_delete_progress(
            &handle,
            &job_id_spawn,
            done,
            total,
            "",
            true,
            cancelled,
            &failures,
            None,
        );

        engine.delete_jobs.write().await.remove(&job_id_spawn);
    });

    Ok(DeleteObjectsResponse { job_id })
}

/// Cancel an in-flight bulk delete started by `delete_objects`.
#[tauri::command]
pub async fn cancel_delete_job(
    state: tauri::State<'_, GaleonEngine>,
    job_id: String,
) -> Result<(), String> {
    if let Some(cancel) = state.delete_jobs.read().await.get(&job_id) {
        cancel.store(true, Ordering::SeqCst);
    }
    Ok(())
}

#[tauri::command]
pub async fn rename_object(
    state: tauri::State<'_, GaleonEngine>,
    session_id: String,
    old_key: String,
    new_key: String,
    is_folder: bool,
) -> Result<(), String> {
    let sessions = state.active_sessions.read().await;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| "Session not found".to_string())?
        .clone();
    drop(sessions);

    match session {
        StorageSession::OpenDAL(op) => {
            use futures_util::TryStreamExt;

            if is_folder {
                let source_prefix = if old_key.ends_with('/') {
                    old_key.clone()
                } else {
                    format!("{}/", old_key)
                };
                let dest_prefix = if new_key.ends_with('/') {
                    new_key.clone()
                } else {
                    format!("{}/", new_key)
                };

                op.create_dir(&dest_prefix)
                    .await
                    .map_err(|e| format!("Failed to create destination folder: {}", e))?;

                let mut lister = op
                    .lister_with(&source_prefix)
                    .await
                    .map_err(|e| format!("Failed to list source folder: {}", e))?;

                let mut keys_to_copy: Vec<String> = Vec::new();
                while let Some(entry) = lister
                    .try_next()
                    .await
                    .map_err(|e| format!("List error: {}", e))?
                {
                    let path = entry.path().to_string();
                    if path != source_prefix && !path.ends_with('/') {
                        keys_to_copy.push(path);
                    }
                }

                for old_path in &keys_to_copy {
                    let relative_path = old_path.strip_prefix(&source_prefix).unwrap_or(old_path);
                    let new_path = format!("{}{}", dest_prefix, relative_path);
                    op.copy(old_path, &new_path)
                        .await
                        .map_err(|e| format!("Failed to copy {}: {}", old_path, e))?;
                }

                if !keys_to_copy.is_empty() {
                    op.delete_iter(keys_to_copy)
                        .await
                        .map_err(|e| format!("Failed to delete originals: {}", e))?;
                }
                let _ = op.delete_iter(vec![source_prefix]).await;
            } else {
                op.copy(&old_key, &new_key)
                    .await
                    .map_err(|e| format!("Failed to copy: {}", e))?;
                op.delete_iter(vec![old_key])
                    .await
                    .map_err(|e| format!("Failed to remove original: {}", e))?;
            }
            invalidate_prefix_size_cache_for_session(&state, &session_id).await;
            Ok(())
        }
        StorageSession::NativeSFTP(sftp_arc) => {
            let sftp = sftp_arc.lock().map_err(|e| format!("Lock: {}", e))?;
            sftp.rename(&old_key, &new_key)
        }
        StorageSession::FTP(ftp_arc) => {
            let mut ftp = ftp_arc.lock().map_err(|e| format!("Lock: {}", e))?;
            ftp.rename(&old_key, &new_key)
        }
    }
}

#[tauri::command]
pub async fn copy_object(
    state: tauri::State<'_, GaleonEngine>,
    session_id: String,
    old_key: String,
    new_key: String,
    is_folder: bool,
) -> Result<(), String> {
    let sessions = state.active_sessions.read().await;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| "Session not found".to_string())?
        .clone();
    drop(sessions);

    match session {
        StorageSession::OpenDAL(op) => {
            use futures_util::TryStreamExt;

            if is_folder {
                let source_prefix = if old_key.ends_with('/') {
                    old_key.clone()
                } else {
                    format!("{}/", old_key)
                };
                let dest_prefix = if new_key.ends_with('/') {
                    new_key.clone()
                } else {
                    format!("{}/", new_key)
                };

                op.create_dir(&dest_prefix)
                    .await
                    .map_err(|e| format!("Failed to create destination folder: {}", e))?;

                let mut lister = op
                    .lister_with(&source_prefix)
                    .await
                    .map_err(|e| format!("Failed to list source folder: {}", e))?;

                let mut keys_to_copy: Vec<String> = Vec::new();
                while let Some(entry) = lister
                    .try_next()
                    .await
                    .map_err(|e| format!("List error: {}", e))?
                {
                    let path = entry.path().to_string();
                    if path != source_prefix && !path.ends_with('/') {
                        keys_to_copy.push(path);
                    }
                }

                for old_path in &keys_to_copy {
                    let relative_path = old_path.strip_prefix(&source_prefix).unwrap_or(old_path);
                    let new_path = format!("{}{}", dest_prefix, relative_path);
                    op.copy(old_path, &new_path)
                        .await
                        .map_err(|e| format!("Failed to copy {}: {}", old_path, e))?;
                }
            } else {
                op.copy(&old_key, &new_key)
                    .await
                    .map_err(|e| format!("Failed to copy: {}", e))?;
            }
            invalidate_prefix_size_cache_for_session(&state, &session_id).await;
            Ok(())
        }
        StorageSession::NativeSFTP(_) => {
            Err("Server-side copy is not supported for native SFTP sessions".to_string())
        }
        StorageSession::FTP(_) => {
            Err("Server-side copy is not supported for FTP/FTPS sessions".to_string())
        }
    }
}
