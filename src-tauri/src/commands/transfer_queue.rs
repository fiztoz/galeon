// The persisted transfer queue on disk: read, write, restore, prune.

use crate::*;
use tokio::sync::Mutex as TokioMutex;

lazy_static::lazy_static! {
    static ref QUEUE_FILE_LOCK: TokioMutex<()> = TokioMutex::new(());
}

fn get_transfer_queue_path(app_handle: &AppHandleType) -> Result<std::path::PathBuf, String> {
    let config_dir = app_handle
        .path()
        .app_config_dir()
        .map_err(|e| format!("Failed to get config dir: {}", e))?;

    if !config_dir.exists() {
        std::fs::create_dir_all(&config_dir)
            .map_err(|e| format!("Failed to create config dir: {}", e))?;
    }

    Ok(config_dir.join("transfers.json"))
}

pub(crate) async fn read_transfer_queue_locked(
    app_handle: &AppHandleType,
) -> Result<TransferQueue, String> {
    let path = get_transfer_queue_path(app_handle)?;

    if !path.exists() {
        return Ok(TransferQueue::default());
    }

    let data = tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| format!("Failed to read transfers.json: {}", e))?;

    serde_json::from_str(&data).map_err(|e| format!("Failed to parse transfers.json: {}", e))
}

pub(crate) async fn write_transfer_queue_locked(
    app_handle: &AppHandleType,
    queue: &TransferQueue,
) -> Result<(), String> {
    let path = get_transfer_queue_path(app_handle)?;
    let data = serde_json::to_string_pretty(queue)
        .map_err(|e| format!("Failed to serialize transfer queue: {}", e))?;

    // Write to temp file first, then rename for atomicity
    let temp_path = path.with_extension("json.tmp");
    tokio::fs::write(&temp_path, &data)
        .await
        .map_err(|e| format!("Failed to write transfers.json.tmp: {}", e))?;
    tokio::fs::rename(&temp_path, &path)
        .await
        .map_err(|e| format!("Failed to rename transfers.json: {}", e))
}

pub(crate) async fn read_transfer_queue(
    app_handle: &AppHandleType,
) -> Result<TransferQueue, String> {
    let _lock = QUEUE_FILE_LOCK.lock().await;
    read_transfer_queue_locked(app_handle).await
}

#[tauri::command]
pub async fn get_transfer_queue(app_handle: AppHandleType) -> Result<TransferQueue, String> {
    read_transfer_queue(&app_handle).await
}

#[tauri::command]
pub async fn clear_completed_transfers(app_handle: AppHandleType) -> Result<(), String> {
    let _lock = QUEUE_FILE_LOCK.lock().await;
    let mut queue = read_transfer_queue_locked(&app_handle).await?;
    queue
        .entries
        .retain(|e| e.status != "completed" && e.status != "cancelled");
    write_transfer_queue_locked(&app_handle, &queue).await
}

#[tauri::command]
pub async fn restore_transfers(
    app_handle: AppHandleType,
    _state: tauri::State<'_, GaleonEngine>,
) -> Result<Vec<TransferQueueEntry>, String> {
    let _lock = QUEUE_FILE_LOCK.lock().await;
    let mut queue = read_transfer_queue_locked(&app_handle).await?;
    let mut restored = Vec::new();
    let mut to_remove = Vec::new();

    for (idx, entry) in queue.entries.iter().enumerate() {
        // Only restore active transfers (not completed/failed/cancelled/queued)
        if entry.status == "active" {
            let mut entry = entry.clone();
            if entry.direction == "download" {
                // Check if .part file exists for download resume
                let part_path = format!("{}.part", entry.local_path);
                if let Ok(metadata) = std::fs::metadata(&part_path) {
                    entry.bytes_transferred = metadata.len();
                    entry.status = "paused".to_string();
                } else {
                    // No .part file - transfer was interrupted before any data written
                    entry.status = "failed".to_string();
                    entry.error = Some("Transfer interrupted".to_string());
                }
            } else {
                // For uploads, check if local file still exists
                if std::fs::metadata(&entry.local_path).is_ok() {
                    entry.status = "queued".to_string();
                } else {
                    // Local file gone, mark as failed
                    entry.status = "failed".to_string();
                    entry.error = Some("Source file no longer available".to_string());
                }
            }
            restored.push(entry);
            to_remove.push(idx);
        }
    }

    // Remove restored entries from queue (they'll be re-added when user retries)
    for idx in to_remove.into_iter().rev() {
        queue.entries.remove(idx);
    }
    let _ = write_transfer_queue_locked(&app_handle, &queue).await;

    Ok(restored)
}

#[tauri::command]
pub async fn add_to_transfer_queue(
    app_handle: AppHandleType,
    entry: TransferQueueEntry,
) -> Result<(), String> {
    let _lock = QUEUE_FILE_LOCK.lock().await;
    let mut queue = read_transfer_queue_locked(&app_handle).await?;

    // Remove existing entry with same ID if present
    queue.entries.retain(|e| e.id != entry.id);
    queue.entries.push(entry);

    write_transfer_queue_locked(&app_handle, &queue).await
}

#[tauri::command]
pub async fn update_transfer_queue_entry(
    app_handle: AppHandleType,
    entry: TransferQueueEntry,
) -> Result<(), String> {
    let _lock = QUEUE_FILE_LOCK.lock().await;
    let mut queue = read_transfer_queue_locked(&app_handle).await?;

    if let Some(existing) = queue.entries.iter_mut().find(|e| e.id == entry.id) {
        // Merge: only update fields that are non-empty/non-default
        if !entry.remote_key.is_empty() {
            existing.remote_key = entry.remote_key;
        }
        if !entry.local_path.is_empty() {
            existing.local_path = entry.local_path;
        }
        if !entry.profile_id.is_empty() {
            existing.profile_id = entry.profile_id;
        }
        // Always update status and timestamp; keep existing byte counts when the
        // caller has none (completion/failure updates pass zeros)
        let completed = entry.status == "completed";
        existing.status = entry.status;
        if entry.bytes_transferred > 0 || entry.total_bytes > 0 {
            existing.bytes_transferred = entry.bytes_transferred;
            existing.total_bytes = entry.total_bytes;
        }
        if completed && existing.total_bytes > 0 {
            existing.bytes_transferred = existing.total_bytes;
        }
        existing.updated_at = entry.updated_at;
        if entry.error.is_some() {
            existing.error = entry.error;
        }
    }

    write_transfer_queue_locked(&app_handle, &queue).await
}
