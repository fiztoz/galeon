// The transfer engine itself: chunked S3 / native SFTP / FTP move loops.

use crate::*;

// Speed Tracker for smooth speed reporting
pub(crate) struct SpeedTracker {
    samples: Vec<(std::time::Instant, u64)>,
    window_duration: std::time::Duration,
}

impl SpeedTracker {
    pub(crate) fn new(window_duration_ms: u64) -> Self {
        Self {
            samples: vec![(std::time::Instant::now(), 0)],
            window_duration: std::time::Duration::from_millis(window_duration_ms),
        }
    }

    pub(crate) fn add_sample(&mut self, bytes: u64) {
        let now = std::time::Instant::now();
        self.samples.push((now, bytes));
        self.samples
            .retain(|(t, _)| now.duration_since(*t) <= self.window_duration);
    }

    pub(crate) fn speed(&self) -> u64 {
        if self.samples.len() < 2 {
            return 0;
        }

        let window_start = self.samples.first().unwrap().0;
        let window_end = self.samples.last().unwrap().0;
        let elapsed = window_end.duration_since(window_start).as_secs_f64();

        if elapsed < 0.001 {
            return 0;
        }

        let bytes_in_window = self.samples.last().unwrap().1 - self.samples.first().unwrap().1;
        (bytes_in_window as f64 / elapsed) as u64
    }
}

// Constants for parallel transfers
pub(crate) const CHUNK_SIZE: usize = 8 * 1024 * 1024; // 8 MiB
pub(crate) const CONCURRENCY: usize = 4;
pub(crate) const MULTIPART_THRESHOLD: u64 = 8 * 1024 * 1024; // 8 MiB

/// Contiguous chunk ranges covering `start..total`, each at most `chunk_size` long.
pub(crate) fn compute_chunk_ranges(
    start: u64,
    total: u64,
    chunk_size: u64,
) -> Vec<std::ops::Range<u64>> {
    let mut ranges = Vec::new();
    let mut pos = start;
    while pos < total {
        let end = std::cmp::min(pos + chunk_size, total);
        ranges.push(pos..end);
        pos = end;
    }
    ranges
}

/// Whole-transfer retries with backoff + UI `transfer-retrying` events.
/// Downloads already resume from `.part`; uploads restart (OpenDAL multipart has no mid-resume).
pub(crate) async fn run_transfer_with_retries<F, Fut>(
    handle: AppHandleType,
    remote_key: String,
    control: TransferControl,
    mut op: F,
) -> Result<(), String>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<(), String>>,
{
    use tauri::Emitter;
    transfer_retry::with_transient_retries(
        transfer_retry::TRANSFER_MAX_ATTEMPTS,
        |attempt, delay, err| {
            if control.cancel.is_cancelled() {
                return;
            }
            let _ = handle.emit(
                "transfer-retrying",
                TransferRetryingPayload {
                    remote_key: remote_key.clone(),
                    attempt: attempt + 1,
                    max_attempts: transfer_retry::TRANSFER_MAX_ATTEMPTS,
                    next_delay_ms: delay.as_millis() as u64,
                    message: err.to_string(),
                },
            );
        },
        || {
            let fut = op();
            let cancel = control.cancel.clone();
            async move {
                if cancel.is_cancelled() {
                    return Err("Transfer cancelled".to_string());
                }
                fut.await
            }
        },
    )
    .await
}

// Download implementation
pub(crate) async fn perform_download(
    app_handle: AppHandleType,
    op: Operator,
    remote_key: String,
    local_path: String,
    control: Option<TransferControl>,
) -> Result<(), String> {
    use std::io::SeekFrom;
    use tauri::Emitter;
    use tokio::io::{AsyncSeekExt, AsyncWriteExt};

    let meta = op.stat(&remote_key).await.map_err(|e| e.to_string())?;
    let total_bytes = meta.content_length();

    // Create .part file for resume support
    let part_path = format!("{}.part", local_path);
    let mut bytes_transferred = 0u64;

    // Check if .part file exists for resume
    if let Ok(metadata) = tokio::fs::metadata(&part_path).await {
        bytes_transferred = metadata.len();
    }

    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(false) // keep existing bytes: resume seeks past them
        .open(&part_path)
        .await
        .map_err(|e| e.to_string())?;

    // Remote object shrank since the .part was written: restart clean
    if bytes_transferred > total_bytes {
        file.set_len(0).await.map_err(|e| e.to_string())?;
        bytes_transferred = 0;
    }

    // Seek to the current position for resume
    file.seek(SeekFrom::Start(bytes_transferred))
        .await
        .map_err(|e| e.to_string())?;

    let mut speed_tracker = SpeedTracker::new(1000);

    // Fetch up to CONCURRENCY chunks in parallel but consume them in order,
    // so the .part file always holds a contiguous prefix and the
    // resume-from-offset logic above stays valid.
    use futures_util::StreamExt;
    let op_c = op.clone();
    let key_c = remote_key.clone();
    let mut chunks = futures_util::stream::iter(
        compute_chunk_ranges(bytes_transferred, total_bytes, CHUNK_SIZE as u64)
            .into_iter()
            .map(move |range| {
                let op = op_c.clone();
                let key = key_c.clone();
                async move { read_range_with_retry(&op, &key, range).await }
            }),
    )
    .buffered(CONCURRENCY);

    loop {
        // Await the next in-order chunk; cancel stays responsive meanwhile
        let next = if let Some(ref ctrl) = control {
            tokio::select! {
                _ = ctrl.cancel.cancelled() => {
                    drop(file);
                    let _ = tokio::fs::remove_file(&part_path).await;
                    return Err("Transfer cancelled".to_string());
                },
                n = chunks.next() => n,
            }
        } else {
            chunks.next().await
        };

        let Some(result) = next else { break };

        // Pause gate: re-check the flag after each wake so a stale
        // notify permit can't resume a still-paused transfer.
        // In-flight fetches simply drain into the stream buffer.
        if let Some(ref ctrl) = control {
            while ctrl.paused.load(Ordering::SeqCst) {
                tokio::select! {
                    _ = ctrl.resume_notify.notified() => {},
                    _ = ctrl.cancel.cancelled() => {
                        drop(file);
                        let _ = tokio::fs::remove_file(&part_path).await;
                        return Err("Transfer cancelled".to_string());
                    },
                }
            }
        }

        // On failure the .part file is kept: the contiguous prefix is valid
        let chunk_data = result?;
        let chunk_len = chunk_data.len() as u64;
        let bytes = chunk_data.to_bytes();

        file.write_all(&bytes).await.map_err(|e| e.to_string())?;
        bytes_transferred += chunk_len;
        speed_tracker.add_sample(bytes_transferred);

        let percentage = if total_bytes > 0 {
            (bytes_transferred as f64 / total_bytes as f64 * 100.0).min(100.0)
        } else {
            100.0
        };

        let _ = app_handle.emit(
            "transfer-progress",
            TransferProgressPayload {
                remote_key: remote_key.clone(),
                bytes_transferred,
                total_bytes,
                percentage,
                bytes_per_second: speed_tracker.speed(),
                direction: "download".to_string(),
            },
        );
    }

    file.flush().await.map_err(|e| e.to_string())?;
    drop(file);

    // Atomic rename from .part to final
    tokio::fs::rename(&part_path, &local_path)
        .await
        .map_err(|e| e.to_string())?;

    let _ = app_handle.emit("transfer-verifying", &remote_key);

    verify_integrity(&local_path, total_bytes, meta.etag()).await?;

    let _ = app_handle.emit("transfer-complete", remote_key);

    Ok(())
}

// Upload implementation with parallel chunking for large files
pub(crate) async fn perform_upload(
    app_handle: AppHandleType,
    op: Operator,
    local_path: String,
    remote_key: String,
    control: Option<TransferControl>,
) -> Result<(), String> {
    use tauri::Emitter;
    use tokio::io::AsyncReadExt;

    // Get file metadata for total size
    let file_metadata = tokio::fs::metadata(&local_path)
        .await
        .map_err(|e| format!("Failed to read file metadata: {}", e))?;
    let total_bytes = file_metadata.len();

    // Open local file for reading
    let mut file = tokio::fs::File::open(&local_path)
        .await
        .map_err(|e| format!("Failed to open file: {}", e))?;

    let mut bytes_transferred = 0u64;
    let mut speed_tracker = SpeedTracker::new(1000);

    // Use parallel chunked upload for large files
    if total_bytes >= MULTIPART_THRESHOLD {
        let mut writer = op
            .writer_with(&remote_key)
            .chunk(CHUNK_SIZE)
            .concurrent(CONCURRENCY)
            .await
            .map_err(|e| format!("Failed to create multipart writer: {}", e))?;

        let mut buffer = vec![0u8; CHUNK_SIZE];

        loop {
            // Check for cancellation; abort so S3 drops the uploaded parts
            // instead of keeping an orphaned (billed) multipart upload.
            if let Some(ref ctrl) = control {
                if ctrl.cancel.is_cancelled() {
                    let _ = writer.abort().await;
                    return Err("Transfer cancelled".to_string());
                }
                // Pause gate: re-check the flag after each wake (see download)
                while ctrl.paused.load(Ordering::SeqCst) {
                    tokio::select! {
                        _ = ctrl.resume_notify.notified() => {},
                        _ = ctrl.cancel.cancelled() => {
                            let _ = writer.abort().await;
                            return Err("Transfer cancelled".to_string());
                        },
                    }
                }
            }

            let n = match file.read(&mut buffer).await {
                Ok(n) => n,
                Err(e) => {
                    let _ = writer.abort().await;
                    return Err(format!("Read error: {}", e));
                }
            };
            if n == 0 {
                break;
            }

            let chunk = buffer[..n].to_vec();
            if let Err(e) = write_chunk_with_retry(&mut writer, chunk).await {
                let _ = writer.abort().await;
                return Err(format!("Write error: {}", e));
            }

            bytes_transferred += n as u64;
            speed_tracker.add_sample(bytes_transferred);

            let percentage = if total_bytes > 0 {
                (bytes_transferred as f64 / total_bytes as f64 * 100.0).min(100.0)
            } else {
                100.0
            };

            let _ = app_handle.emit(
                "transfer-progress",
                TransferProgressPayload {
                    remote_key: remote_key.clone(),
                    bytes_transferred,
                    total_bytes,
                    percentage,
                    bytes_per_second: speed_tracker.speed(),
                    direction: "upload".to_string(),
                },
            );
        }

        // Close the writer to finalize the multipart upload
        writer
            .close()
            .await
            .map_err(|e| format!("Failed to close writer: {}", e))?;
    } else {
        // Single-stream upload for small files
        let mut writer = op
            .writer_with(&remote_key)
            .chunk(CHUNK_SIZE)
            .await
            .map_err(|e| format!("Failed to create writer: {}", e))?;

        let mut buffer = vec![0u8; 128 * 1024]; // 128KB buffer

        loop {
            // Check for cancellation
            if let Some(ref ctrl) = control {
                if ctrl.cancel.is_cancelled() {
                    return Err("Transfer cancelled".to_string());
                }
                // Pause gate: re-check the flag after each wake (see download)
                while ctrl.paused.load(Ordering::SeqCst) {
                    tokio::select! {
                        _ = ctrl.resume_notify.notified() => {},
                        _ = ctrl.cancel.cancelled() => return Err("Transfer cancelled".to_string()),
                    }
                }
            }

            let n = file
                .read(&mut buffer)
                .await
                .map_err(|e| format!("Read error: {}", e))?;
            if n == 0 {
                break;
            }

            let chunk = buffer[..n].to_vec();
            write_chunk_with_retry(&mut writer, chunk)
                .await
                .map_err(|e| format!("Write error: {}", e))?;

            bytes_transferred += n as u64;
            speed_tracker.add_sample(bytes_transferred);

            let percentage = if total_bytes > 0 {
                (bytes_transferred as f64 / total_bytes as f64 * 100.0).min(100.0)
            } else {
                100.0
            };

            let _ = app_handle.emit(
                "transfer-progress",
                TransferProgressPayload {
                    remote_key: remote_key.clone(),
                    bytes_transferred,
                    total_bytes,
                    percentage,
                    bytes_per_second: speed_tracker.speed(),
                    direction: "upload".to_string(),
                },
            );
        }

        writer
            .close()
            .await
            .map_err(|e| format!("Failed to close writer: {}", e))?;
    }

    let remote_meta = op
        .stat(&remote_key)
        .await
        .map_err(|e| format!("Failed to stat remote object: {}", e))?;
    if remote_meta.content_length() != total_bytes {
        let _ = op.delete(&remote_key).await;
        return Err(format!(
            "Size mismatch: expected {}, got {}",
            total_bytes,
            remote_meta.content_length()
        ));
    }
    if let Err(e) = verify_integrity(&local_path, total_bytes, remote_meta.etag()).await {
        let _ = op.delete(&remote_key).await;
        return Err(e);
    }

    let _ = app_handle.emit("transfer-complete", remote_key);

    Ok(())
}

// ==========================================
// Native SFTP Transfer Functions
// ==========================================

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

// ==========================================
// FTP Transfer Functions
// ==========================================

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
