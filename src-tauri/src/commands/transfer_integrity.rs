// Content verification: MD5, multipart ETag reconstruction, integrity checks.

use crate::*;

pub async fn calculate_file_md5(local_path: &str) -> Result<String, String> {
    use tokio::io::AsyncReadExt;
    let mut file = tokio::fs::File::open(local_path)
        .await
        .map_err(|e| format!("Failed to open file for MD5 calculation: {}", e))?;

    let mut context = md5::Context::new();
    let mut buffer = [0u8; 65536];
    loop {
        let n = file
            .read(&mut buffer)
            .await
            .map_err(|e| format!("Failed to read file for MD5 calculation: {}", e))?;
        if n == 0 {
            break;
        }
        context.consume(&buffer[..n]);
    }
    let digest = context.finalize();
    Ok(format!("{:x}", digest))
}

pub async fn calculate_multipart_etag(
    local_path: &str,
    chunk_size: usize,
) -> Result<String, String> {
    calculate_multipart_etag_impl(local_path, chunk_size, true).await
}

pub async fn calculate_multipart_etag_impl(
    local_path: &str,
    chunk_size: usize,
    allow_fallback: bool,
) -> Result<String, String> {
    use tokio::io::AsyncReadExt;
    let metadata = tokio::fs::metadata(local_path)
        .await
        .map_err(|e| format!("Failed to read file metadata for ETag calculation: {}", e))?;
    let file_size = metadata.len();

    // Fall back to standard MD5 if file size is below MULTIPART_THRESHOLD (8 MiB),
    // matching OpenDAL's simple-PUT path which yields a plain MD5 ETag.
    if allow_fallback && file_size < MULTIPART_THRESHOLD {
        return calculate_file_md5(local_path).await;
    }

    let mut file = tokio::fs::File::open(local_path)
        .await
        .map_err(|e| format!("Failed to open file for ETag calculation: {}", e))?;

    let mut chunk_hashes = Vec::new();
    let mut buffer = vec![0u8; chunk_size];

    loop {
        let mut bytes_read = 0;
        while bytes_read < chunk_size {
            let n = file
                .read(&mut buffer[bytes_read..])
                .await
                .map_err(|e| format!("Failed to read chunk from file: {}", e))?;
            if n == 0 {
                break;
            }
            bytes_read += n;
        }

        if bytes_read == 0 {
            break;
        }

        let chunk_md5 = md5::compute(&buffer[..bytes_read]);
        chunk_hashes.extend_from_slice(&chunk_md5.0);
    }

    let final_md5 = md5::compute(&chunk_hashes);
    let num_parts = chunk_hashes.len() / 16;
    Ok(format!("{:x}-{}", final_md5, num_parts))
}

/// Derive the part size used in a multipart upload from the ETag's part count and file size.
/// Returns `Some(part_size)` if the part size can be reliably determined, `None` otherwise.
///
/// The S3 multipart ETag format is `"{md5_digest}-{N}"` where N is the number of parts.
/// Given file_size and N, we compute `part_size = file_size / N` (integer division).
/// If the file divides evenly into exactly N parts of that size, the derivation is valid.
///
/// When the derivation fails (non-divisible sizes), we return `None` so the caller can
/// skip checksum verification gracefully rather than computing with the wrong part size.
fn derive_part_size_from_etag(etag: &str, file_size: u64) -> Option<usize> {
    // Parse the part count N from the ETag suffix (e.g., "abc123-3" -> 3)
    let n: u64 = etag.rsplit('-').next()?.parse().ok()?;

    // Verify: file_size >= N and N > 0
    if n == 0 || file_size < n {
        return None;
    }

    // Try common chunk sizes first to avoid false positives (e.g. 10MB file in 2 parts
    // where actual upload used 8MB + 2MB parts, but simple division guesses 5MB + 5MB).
    // 1. Galeon's default CHUNK_SIZE (8 MiB)
    // 2. S3 minimum part size (5 MiB)
    // 3. Other common chunk sizes: 16 MiB, 32 MiB, 64 MiB
    let common_sizes = [
        8 * 1024 * 1024,
        5 * 1024 * 1024,
        16 * 1024 * 1024,
        32 * 1024 * 1024,
        64 * 1024 * 1024,
    ];
    for &size in &common_sizes {
        if size >= file_size as usize {
            continue;
        }
        let remainder = file_size % size as u64;
        let computed_parts = file_size / size as u64 + if remainder > 0 { 1 } else { 0 };
        if computed_parts == n {
            return Some(size);
        }
    }

    let part_size = file_size / n;
    if part_size == 0 {
        return None;
    }

    // Verify: the derived part size must split the file into exactly N chunks.
    // i.e., ceil(file_size / part_size) == N
    let remainder = file_size % part_size;
    let computed_parts = file_size / part_size + if remainder > 0 { 1 } else { 0 };
    if computed_parts != n {
        return None;
    }

    Some(part_size as usize)
}

pub async fn verify_integrity(
    local_path: &str,
    expected_size: u64,
    expected_etag: Option<&str>,
) -> Result<(), String> {
    let metadata = tokio::fs::metadata(local_path)
        .await
        .map_err(|e| format!("Failed to read file metadata: {}", e))?;
    let local_size = metadata.len();
    if local_size != expected_size {
        return Err(format!(
            "Size mismatch: expected {}, got {}",
            expected_size, local_size
        ));
    }

    if let Some(raw_etag) = expected_etag {
        let remote_etag = raw_etag.trim_matches('"');
        let local_checksum = if remote_etag.contains('-') {
            // Derive the part size from the ETag's part count and file size,
            // falling back to skipping checksum verification if the derivation fails.
            match derive_part_size_from_etag(remote_etag, local_size) {
                Some(part_size) => {
                    calculate_multipart_etag_impl(local_path, part_size, false).await?
                }
                None => {
                    eprintln!(
                    "[galeon] Warning: could not derive part size from ETag '{}' for {} byte file, skipping checksum verification",
                    remote_etag, local_size
                );
                    return Ok(());
                }
            }
        } else {
            calculate_file_md5(local_path).await?
        };

        if local_checksum != remote_etag {
            return Err(format!(
                "Checksum mismatch: expected {}, got {}",
                remote_etag, local_checksum
            ));
        }
    }

    Ok(())
}

/// Result of comparing a local file against a remote object (Properties
/// Inspector "Verify against local file"). Serialized as camelCase.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct VerifyResult {
    pub matches: bool,
    pub detail: String,
    /// True only when a remote checksum (ETag) was available to compare
    /// (S3); for SFTP/FTP only the size is compared.
    pub checked_checksum: bool,
}
