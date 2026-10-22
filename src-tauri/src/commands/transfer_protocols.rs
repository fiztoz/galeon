//! The OpenDAL transfer engine.
//!
//! Chunked download/upload for every OpenDAL protocol (S3, WebDAV, Azure Blob,
//! GCS), the whole-transfer retry loop, and the verify-then-swap download.
//! The native SFTP and FTP loops live beside this in `sftp_transfers` and
//! `ftp_transfers`.

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
///
/// Always returns `Result`, never unwinds: callers run this inside `tokio::spawn`,
/// where a panic would be discarded silently and leave the queue entry stuck at
/// `active`. `catch_transfer_panic` turns that into a normal failure so
/// `finalize_transfer_job` always emits `transfer-failed`.
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
    // Boxed deliberately: transfer futures carry an 8 MiB chunk buffer
    // (`CHUNK_SIZE`) in their async state machine. Unboxed, the whole
    // retry-and-finalize chain is laid out in this caller's stack frame, which
    // overflows a 2 MiB thread stack (the libtest default) in the boundary
    // tests. Boxing keeps that state on the heap.
    transfer_retry::catch_transfer_panic(Box::pin(transfer_retry::with_transient_retries(
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
    )))
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

    let _ = app_handle.emit("transfer-verifying", &remote_key);
    finalize_download(&part_path, &local_path, total_bytes, meta.etag()).await?;

    let _ = app_handle.emit("transfer-complete", remote_key);

    Ok(())
}

/// Verify a completed `.part`, then swap it into place atomically.
///
/// ORDERING IS THE POINT: the destination must not be touched until the new
/// bytes are proven good. Renaming first and verifying second meant a checksum
/// or size mismatch destroyed the user's existing file and then left a corrupt
/// one in its place, with the only trace being a transfer-failed event and the
/// previous good copy unrecoverable.
///
/// Verifying the `.part` first keeps both properties that made the rename worth
/// having: the destination is swapped in atomically, and a failure leaves the
/// `.part` on disk so the next attempt resumes from it.
///
/// Extracted from `perform_download` so the ordering is directly testable —
/// an end-to-end run cannot induce a verification failure deterministically.
pub(crate) async fn finalize_download(
    part_path: &str,
    local_path: &str,
    expected_size: u64,
    expected_etag: Option<&str>,
) -> Result<(), String> {
    verify_integrity(part_path, expected_size, expected_etag).await?;

    tokio::fs::rename(part_path, local_path)
        .await
        .map_err(|e| e.to_string())
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

#[cfg(test)]
mod tests {
    use super::finalize_download;

    fn tmp(tag: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("galeon-finalize-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[tokio::test]
    async fn a_failed_verification_leaves_the_existing_file_untouched() {
        // THE regression guard: verify first, rename second. Before this ordering
        // existed, a mismatch destroyed the user's file and left a corrupt one
        // behind.
        let dir = tmp("mismatch");
        let part = dir.join("a.bin.part");
        let dest = dir.join("a.bin");

        std::fs::write(&part, b"corrupted payload").unwrap();
        std::fs::write(&dest, b"THE PREVIOUS GOOD COPY").unwrap();

        let err = finalize_download(
            part.to_str().unwrap(),
            dest.to_str().unwrap(),
            999, // expected size, deliberately wrong
            None,
        )
        .await;

        assert!(err.is_err(), "verification must fail");
        assert_eq!(
            std::fs::read_to_string(&dest).unwrap(),
            "THE PREVIOUS GOOD COPY",
            "a failed verification must not have replaced the destination"
        );
        assert!(
            part.exists(),
            "the .part must survive so the next attempt can resume"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn a_verified_part_is_swapped_into_place() {
        let dir = tmp("ok");
        let part = dir.join("b.bin.part");
        let dest = dir.join("b.bin");

        std::fs::write(&part, b"fresh payload").unwrap();
        std::fs::write(&dest, b"old").unwrap();

        finalize_download(
            part.to_str().unwrap(),
            dest.to_str().unwrap(),
            b"fresh payload".len() as u64,
            None,
        )
        .await
        .unwrap();

        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "fresh payload");
        assert!(!part.exists(), "the .part is consumed by the rename");

        std::fs::remove_dir_all(&dir).ok();
    }
}
