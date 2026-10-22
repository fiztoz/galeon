//! Native FTP / FTPS transfer loops.
//!
//! Same shape as the SFTP module: a blocking-thread move with the shared
//! transfer events, because the FTP transport is synchronous too.

use crate::*;

/// Perform an FTP download with progress reporting.
pub(crate) async fn perform_ftp_download(
    app_handle: AppHandleType,
    ftp_session: Arc<std::sync::Mutex<ftp_native::FtpSession>>,
    remote_key: String,
    local_path: String,
    control: Option<TransferControl>,
) -> Result<(), String> {
    use std::sync::atomic::Ordering;
    use tauri::Emitter;

    let total_bytes = {
        let mut ftp = ftp_session.lock().map_err(|e| format!("Lock: {}", e))?;
        ftp.file_size(&remote_key)?
    };

    let part_path = format!("{}.part", local_path);
    let part_path_inner = part_path.clone();
    let handle = app_handle.clone();
    let rk = remote_key.clone();
    let lp = local_path.clone();
    let ftp_clone = ftp_session.clone();
    let ctrl = control.clone();

    // Spawn blocking task for synchronous I/O
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        use std::io::Write;
        let mut ftp = ftp_clone.lock().map_err(|e| format!("Lock: {}", e))?;

        // Check cancellation before starting
        if let Some(ref c) = ctrl {
            if c.cancel.is_cancelled() {
                return Err("Transfer cancelled".to_string());
            }
        }

        let total = ftp.file_size(&rk)?;

        // Create parent directories
        if let Some(parent) = std::path::Path::new(&lp).parent() {
            let _ = std::fs::create_dir_all(parent);
        }

        let mut lf = std::fs::File::create(&part_path_inner)
            .map_err(|e| format!("create {}: {}", part_path_inner, e))?;

        // Use retr_as_buffer which loads the file into memory
        let cursor = ftp
            .stream
            .retr_as_buffer(&rk)
            .map_err(|e| format!("RETR {}: {}", rk, e))?;
        let data = cursor.into_inner();

        // Write data in chunks with progress reporting
        let buf_size = 65536usize;
        let mut xfer = 0u64;
        let mut last_emit = std::time::Instant::now();
        let mut speed_tracker = crate::SpeedTracker::new(1000);
        speed_tracker.add_sample(0);

        for chunk in data.chunks(buf_size) {
            // Check cancellation
            if let Some(ref c) = ctrl {
                if c.cancel.is_cancelled() {
                    return Err("Transfer cancelled".to_string());
                }
                while c.paused.load(Ordering::SeqCst) {
                    std::thread::sleep(std::time::Duration::from_millis(100));
                    if c.cancel.is_cancelled() {
                        return Err("Transfer cancelled".to_string());
                    }
                }
            }

            lf.write_all(chunk).map_err(|e| format!("write: {}", e))?;
            xfer += chunk.len() as u64;
            speed_tracker.add_sample(xfer);

            if last_emit.elapsed() >= std::time::Duration::from_millis(200) {
                let pct = if total > 0 {
                    (xfer as f64 / total as f64 * 100.0).min(100.0)
                } else {
                    100.0
                };
                let _ = handle.emit(
                    "transfer-progress",
                    TransferProgressPayload {
                        remote_key: rk.clone(),
                        bytes_transferred: xfer,
                        total_bytes: total,
                        percentage: pct,
                        bytes_per_second: speed_tracker.speed(),
                        direction: "download".to_string(),
                    },
                );
                last_emit = std::time::Instant::now();
            }
        }

        // Final progress
        let _ = handle.emit(
            "transfer-progress",
            TransferProgressPayload {
                remote_key: rk.clone(),
                bytes_transferred: xfer,
                total_bytes: total,
                percentage: 100.0,
                bytes_per_second: speed_tracker.speed(),
                direction: "download".to_string(),
            },
        );

        Ok(())
    })
    .await
    .map_err(|e| format!("Blocking task panicked: {}", e))??;

    // Atomic rename .part to final
    tokio::fs::rename(&part_path, &local_path)
        .await
        .map_err(|e| format!("Rename failed: {}", e))?;

    let _ = app_handle.emit("transfer-verifying", &remote_key);

    // Size verification (no checksum for FTP)
    let local_meta = tokio::fs::metadata(&local_path)
        .await
        .map_err(|e| format!("Failed to read local file: {}", e))?;
    if local_meta.len() != total_bytes {
        let _ = tokio::fs::remove_file(&local_path).await;
        return Err(format!(
            "Size mismatch: expected {}, got {}",
            total_bytes,
            local_meta.len()
        ));
    }

    let _ = app_handle.emit("transfer-complete", remote_key);

    Ok(())
}

/// Perform an FTP upload with progress reporting.
pub(crate) async fn perform_ftp_upload(
    app_handle: AppHandleType,
    ftp_session: Arc<std::sync::Mutex<ftp_native::FtpSession>>,
    local_path: String,
    remote_key: String,
    control: Option<TransferControl>,
) -> Result<(), String> {
    use tauri::Emitter;

    let total_bytes = tokio::fs::metadata(&local_path)
        .await
        .map_err(|e| format!("Failed to read local file: {}", e))?
        .len();

    let handle = app_handle.clone();
    let rk = remote_key.clone();
    let lp = local_path.clone();
    let ftp_clone = ftp_session.clone();
    let ctrl = control.clone();

    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let mut ftp = ftp_clone.lock().map_err(|e| format!("Lock: {}", e))?;

        // Check cancellation before starting
        if let Some(ref c) = ctrl {
            if c.cancel.is_cancelled() {
                return Err("Transfer cancelled".to_string());
            }
        }

        // Create parent directories on remote if needed
        if let Some(parent) = std::path::Path::new(&rk).parent() {
            let _ = ftp.mkdir(&parent.to_string_lossy());
        }

        let mut lf = std::fs::File::open(&lp).map_err(|e| format!("open {}: {}", lp, e))?;

        let _bytes_written = ftp
            .stream
            .put_file(&rk, &mut lf)
            .map_err(|e| format!("STOR {}: {}", rk, e))?;

        let _ = handle.emit(
            "transfer-progress",
            TransferProgressPayload {
                remote_key: rk.clone(),
                bytes_transferred: total_bytes,
                total_bytes,
                percentage: 100.0,
                bytes_per_second: 0,
                direction: "upload".to_string(),
            },
        );

        Ok(())
    })
    .await
    .map_err(|e| format!("Blocking task panicked: {}", e))??;

    let _ = app_handle.emit("transfer-complete", remote_key);

    Ok(())
}
