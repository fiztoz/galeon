//! Native SFTP transfer loops.
//!
//! `ssh2` is a synchronous client, so each file moves on a blocking thread
//! while progress, pause, and cancel travel through the same Tauri events as
//! the OpenDAL path. Nothing here touches OpenDAL.

use crate::*;

/// Perform a native SFTP download with progress reporting.
/// Runs synchronous I/O on a blocking thread pool.
pub(crate) async fn perform_native_sftp_download(
    app_handle: AppHandleType,
    sftp_session: Arc<std::sync::Mutex<sftp_native::NativeSftpSession>>,
    remote_key: String,
    local_path: String,
    control: Option<TransferControl>,
) -> Result<(), String> {
    use std::sync::atomic::Ordering;
    use tauri::Emitter;

    let total_bytes = {
        let sftp = sftp_session.lock().map_err(|e| format!("Lock: {}", e))?;
        sftp.file_size(&remote_key)?
    };

    let part_path = format!("{}.part", local_path);
    let part_path_inner = part_path.clone();
    let handle = app_handle.clone();
    let rk = remote_key.clone();
    let lp = local_path.clone();
    let sftp_clone = sftp_session.clone();
    let ctrl = control.clone();

    // Spawn blocking task for synchronous I/O
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        use std::io::{Read, Write};
        let sftp = sftp_clone.lock().map_err(|e| format!("Lock: {}", e))?;

        // Check cancellation before starting
        if let Some(ref c) = ctrl {
            if c.cancel.is_cancelled() {
                return Err("Transfer cancelled".to_string());
            }
        }

        let sftp_subsys = sftp
            .session
            .sftp()
            .map_err(|e| format!("SFTP init: {}", e))?;

        let st = sftp_subsys
            .stat(std::path::Path::new(&rk))
            .map_err(|e| format!("stat {}: {}", rk, e))?;
        let total = st.size.unwrap_or(0);

        let mut rf = sftp_subsys
            .open(std::path::Path::new(&rk))
            .map_err(|e| format!("open {}: {}", rk, e))?;

        // Create parent directories
        if let Some(parent) = std::path::Path::new(&lp).parent() {
            let _ = std::fs::create_dir_all(parent);
        }

        let mut lf = std::fs::File::create(&part_path_inner)
            .map_err(|e| format!("create {}: {}", part_path_inner, e))?;

        let mut buf = vec![0u8; 65536];
        let mut xfer = 0u64;
        let mut last_emit = std::time::Instant::now();
        let mut speed_tracker = crate::SpeedTracker::new(1000);
        speed_tracker.add_sample(0);

        loop {
            // Check cancellation
            if let Some(ref c) = ctrl {
                if c.cancel.is_cancelled() {
                    return Err("Transfer cancelled".to_string());
                }
                // Check pause
                while c.paused.load(Ordering::SeqCst) {
                    std::thread::sleep(std::time::Duration::from_millis(100));
                    if c.cancel.is_cancelled() {
                        return Err("Transfer cancelled".to_string());
                    }
                }
            }

            let n = rf.read(&mut buf).map_err(|e| format!("read: {}", e))?;
            if n == 0 {
                break;
            }
            lf.write_all(&buf[..n])
                .map_err(|e| format!("write: {}", e))?;
            xfer += n as u64;
            speed_tracker.add_sample(xfer);

            // Emit progress every ~200ms
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

    // Size verification (no checksum for native SFTP)
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

/// Perform a native SFTP upload with progress reporting.
pub(crate) async fn perform_native_sftp_upload(
    app_handle: AppHandleType,
    sftp_session: Arc<std::sync::Mutex<sftp_native::NativeSftpSession>>,
    local_path: String,
    remote_key: String,
    control: Option<TransferControl>,
) -> Result<(), String> {
    use std::sync::atomic::Ordering;
    use tauri::Emitter;

    let total_bytes = tokio::fs::metadata(&local_path)
        .await
        .map_err(|e| format!("Failed to read local file: {}", e))?
        .len();

    let handle = app_handle.clone();
    let rk = remote_key.clone();
    let lp = local_path.clone();
    let sftp_clone = sftp_session.clone();
    let ctrl = control.clone();

    tokio::task::spawn_blocking(move || -> Result<(), String> {
        use std::io::{Read, Write};
        let sftp = sftp_clone.lock().map_err(|e| format!("Lock: {}", e))?;

        // Check cancellation before starting
        if let Some(ref c) = ctrl {
            if c.cancel.is_cancelled() {
                return Err("Transfer cancelled".to_string());
            }
        }

        let sftp_subsys = sftp
            .session
            .sftp()
            .map_err(|e| format!("SFTP init: {}", e))?;

        // Create parent directories on remote if needed
        if let Some(parent) = std::path::Path::new(&rk).parent() {
            let _ = sftp_subsys.mkdir(parent, 0o755);
        }

        let mut lf = std::fs::File::open(&lp).map_err(|e| format!("open {}: {}", lp, e))?;
        let mut rf = sftp_subsys
            .create(std::path::Path::new(&rk))
            .map_err(|e| format!("create {}: {}", rk, e))?;

        let mut buf = vec![0u8; 65536];
        let mut xfer = 0u64;
        let mut last_emit = std::time::Instant::now();
        let mut speed_tracker = crate::SpeedTracker::new(1000);
        speed_tracker.add_sample(0);

        loop {
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

            let n = lf.read(&mut buf).map_err(|e| format!("read: {}", e))?;
            if n == 0 {
                break;
            }
            rf.write_all(&buf[..n])
                .map_err(|e| format!("write: {}", e))?;
            xfer += n as u64;
            speed_tracker.add_sample(xfer);

            if last_emit.elapsed() >= std::time::Duration::from_millis(200) {
                let pct = if total_bytes > 0 {
                    (xfer as f64 / total_bytes as f64 * 100.0).min(100.0)
                } else {
                    100.0
                };
                let _ = handle.emit(
                    "transfer-progress",
                    TransferProgressPayload {
                        remote_key: rk.clone(),
                        bytes_transferred: xfer,
                        total_bytes,
                        percentage: pct,
                        bytes_per_second: speed_tracker.speed(),
                        direction: "upload".to_string(),
                    },
                );
                last_emit = std::time::Instant::now();
            }
        }

        let _ = handle.emit(
            "transfer-progress",
            TransferProgressPayload {
                remote_key: rk.clone(),
                bytes_transferred: xfer,
                total_bytes,
                percentage: 100.0,
                bytes_per_second: speed_tracker.speed(),
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
