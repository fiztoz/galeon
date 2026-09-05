// Read-only remote previews for images, text, and media.

use crate::*;

/// Download a remote file to a temp path and open it in the system viewer.
/// On macOS, PDFs are opened in Preview.app so zoom works reliably (WKWebView's
/// embedded PDF plugin has broken zoom controls in Tauri).
#[tauri::command]
pub async fn preview_remote_file(
    state: tauri::State<'_, GaleonEngine>,
    app_handle: AppHandleType,
    session_id: String,
    key: String,
) -> Result<(), String> {
    if key.contains("..") {
        return Err("Path traversal detected".to_string());
    }

    let sessions = state.active_sessions.read().await;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| "Session not found".to_string())?
        .clone();
    drop(sessions);

    let op = match session {
        StorageSession::OpenDAL(op) => op,
        StorageSession::NativeSFTP(_) | StorageSession::FTP(_) => {
            return Err("Preview is only available for S3 objects".to_string());
        }
    };

    // Preview keeps the file open — delete stale copies (1 h+) on each new preview.
    cleanup_stale_previews(std::time::Duration::from_secs(3600));

    let preview_uuid = Uuid::new_v4().to_string();
    let filename = key
        .split('/')
        .next_back()
        .filter(|s| !s.is_empty())
        .unwrap_or("file")
        .to_string();
    let temp_path = preview_temp_dir(&preview_uuid, &filename);
    let temp_dir = temp_path
        .parent()
        .ok_or_else(|| "Failed to derive temp directory".to_string())?
        .to_path_buf();

    std::fs::create_dir_all(&temp_dir).map_err(|e| format!("Failed to create temp dir: {}", e))?;

    let temp_path_string = temp_path.to_string_lossy().to_string();

    perform_download(app_handle.clone(), op, key, temp_path_string.clone(), None).await?;

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-a", "Preview", &temp_path_string])
            .spawn()
            .map_err(|e| format!("Failed to open Preview: {}", e))?;
    }

    #[cfg(not(target_os = "macos"))]
    {
        use tauri_plugin_opener::OpenerExt;
        app_handle
            .opener()
            .open_path(temp_path_string, None::<&str>)
            .map_err(|e| format!("Failed to open file in viewer: {}", e))?;
    }

    Ok(())
}

/// Read up to `max_bytes` from the start of an object so the Properties
/// Inspector can render an inline preview. Returns the raw bytes; the frontend
/// builds a Blob using the content type it already resolved, so no base64
/// round-trip is needed. Preview is offered only for common, previewable types
/// (images, text/code, PDF) — gated frontend-side on the object's content-type
/// metadata — and only for S3/OpenDAL sessions, the only protocol that exposes
/// that metadata. Native SFTP/FTP fall through to a clear error.
#[tauri::command]
pub async fn read_object_preview(
    state: tauri::State<'_, GaleonEngine>,
    session_id: String,
    key: String,
    max_bytes: u64,
) -> Result<tauri::ipc::Response, String> {
    if key.contains("..") {
        return Err("Path traversal detected".to_string());
    }

    // Hard ceiling so a malformed caller can never pull an unbounded object into
    // memory regardless of what `max_bytes` is requested.
    const PREVIEW_CEILING: u64 = 25 * 1024 * 1024;
    let limit = max_bytes.min(PREVIEW_CEILING);

    let sessions = state.active_sessions.read().await;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| "Session not found".to_string())?
        .clone();
    drop(sessions);

    match session {
        StorageSession::OpenDAL(op) => {
            let meta = op.stat(&key).await.map_err(|e| e.to_string())?;
            let end = meta.content_length().min(limit);
            if end == 0 {
                return Ok(tauri::ipc::Response::new(Vec::<u8>::new()));
            }
            let buf = op
                .read_with(&key)
                .range(0..end)
                .await
                .map_err(|e| e.to_string())?;
            Ok(tauri::ipc::Response::new(buf.to_bytes().to_vec()))
        }
        StorageSession::NativeSFTP(_) | StorageSession::FTP(_) => {
            Err("Preview is only available for S3 objects".to_string())
        }
    }
}
