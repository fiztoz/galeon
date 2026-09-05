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

    match session {
        StorageSession::OpenDAL(op) => {
            let prefix_str = if prefix.is_empty() {
                String::new()
            } else if prefix.ends_with('/') {
                prefix.clone()
            } else {
                format!("{}/", prefix)
            };

            let mut lister = op
                .lister_with(&prefix_str)
                .await
                .map_err(|e| format!("Lister error: {}", e))?;

            let mut list = Vec::new();
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
                let is_dir = meta.mode().is_dir();
                let name = if is_dir {
                    path.trim_end_matches('/')
                        .split('/')
                        .next_back()
                        .unwrap_or("")
                        .to_string()
                } else {
                    path.split('/').next_back().unwrap_or("").to_string()
                };

                let (size_bytes, last_modified) = if is_dir {
                    (None, None)
                } else {
                    let size = meta.content_length();
                    let last_mod = meta.last_modified().map(|t| t.to_rfc3339());
                    (Some(size), last_mod)
                };

                list.push(GaleonObject {
                    name,
                    full_key: path,
                    object_type: if is_dir {
                        ObjectType::Folder
                    } else {
                        ObjectType::File
                    },
                    size_bytes,
                    last_modified,
                });
            }

            Ok(list)
        }
        StorageSession::NativeSFTP(sftp_arc) => {
            let sftp = sftp_arc.lock().map_err(|e| format!("Lock error: {}", e))?;
            // For empty prefix, use pwd to get current directory
            let dir_path = if prefix.is_empty() {
                sftp.pwd().unwrap_or_else(|_| "/".to_string())
            } else {
                prefix.clone()
            };
            let dir_path = sftp_native::collapse_slashes(&dir_path);
            let entries = sftp.list_dir(&dir_path)?;
            Ok(entries
                .into_iter()
                .map(|e| GaleonObject {
                    name: e.name,
                    full_key: e.path,
                    object_type: if e.is_dir {
                        ObjectType::Folder
                    } else {
                        ObjectType::File
                    },
                    size_bytes: Some(e.size),
                    last_modified: e.last_modified,
                })
                .collect())
        }
        StorageSession::FTP(ftp_arc) => {
            let mut ftp = ftp_arc.lock().map_err(|e| format!("Lock error: {}", e))?;
            let dir_path = if prefix.is_empty() {
                ftp.pwd().unwrap_or_else(|_| "/".to_string())
            } else {
                prefix.clone()
            };
            let dir_path = sftp_native::collapse_slashes(&dir_path);
            let entries = ftp.list_dir(&dir_path)?;
            Ok(entries
                .into_iter()
                .map(|e| GaleonObject {
                    name: e.name,
                    full_key: e.path,
                    object_type: if e.is_dir {
                        ObjectType::Folder
                    } else {
                        ObjectType::File
                    },
                    size_bytes: Some(e.size),
                    last_modified: e.last_modified,
                })
                .collect())
        }
    }
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
