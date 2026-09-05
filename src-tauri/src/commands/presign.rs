// Presigned URL issuance and its local history.

use crate::*;

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
            };

            let mut config = read_config(&app_handle)?;
            config.presign_history.insert(0, history_entry);
            if config.presign_history.len() > 50 {
                config.presign_history.truncate(50);
            }
            write_config(&app_handle, &config)?;

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
    let config = read_config(&app_handle)?;
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
