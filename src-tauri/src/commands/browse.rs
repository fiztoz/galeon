// Directory listing for a live session, plus existence probes.

use crate::*;

#[tauri::command]
pub async fn list_directory(
    state: tauri::State<'_, GaleonEngine>,
    session_id: String,
    prefix: String,
) -> Result<Vec<GaleonObject>, String> {
    let sessions = state.active_sessions.read().await;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| "Active session not found".to_string())?
        .clone();
    drop(sessions);

    // One listing implementation lives in `listing::list_remote_dir`; the sync
    // tree walker shares it. Do not re-inline the protocol match here.
    list_remote_dir(&session, &prefix).await
}

// 4. File System Helpers
#[tauri::command]
pub async fn check_file_exists(path: String) -> Result<bool, String> {
    Ok(std::path::Path::new(&path).exists())
}

#[tauri::command]
pub async fn check_remote_exists(
    state: tauri::State<'_, GaleonEngine>,
    session_id: String,
    key: String,
) -> Result<bool, String> {
    let sessions = state.active_sessions.read().await;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| "Session not found".to_string())?
        .clone();
    drop(sessions);

    match session {
        StorageSession::OpenDAL(op) => match op.stat(&key).await {
            Ok(_) => Ok(true),
            Err(e) if e.kind() == opendal::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(e.to_string()),
        },
        StorageSession::NativeSFTP(sftp_arc) => {
            let sftp = sftp_arc.lock().map_err(|e| format!("Lock: {}", e))?;
            Ok(sftp.exists(&key))
        }
        StorageSession::FTP(ftp_arc) => {
            let mut ftp = ftp_arc.lock().map_err(|e| format!("Lock: {}", e))?;
            Ok(ftp.exists(&key))
        }
    }
}

// 5. Transfer Queue Persistence
