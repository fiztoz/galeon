//! Remote directory listing and prefix-relative key projection.

use crate::*;

/// Derive a forward-slash relative path for a remote `full_key` under `base`
/// (a prefix with no trailing slash). Returns "" if the key is the base itself.
pub(crate) fn remote_key_relative_to(full_key: &str, base: &str) -> String {
    let key = full_key.trim_end_matches('/');
    let rel = if base.is_empty() {
        key
    } else if let Some(stripped) = key.strip_prefix(base) {
        stripped.trim_start_matches('/')
    } else {
        // Key isn't under base (shouldn't happen) — fall back to the last segment.
        key.rsplit('/').next().unwrap_or(key)
    };
    normalize_rel_path(rel)
}

/// List a single remote directory, reusing the exact per-protocol logic from
/// `list_directory` (kept as a free fn so the recursive walker and the command
/// share one code path).
pub(crate) async fn list_remote_dir(
    session: &StorageSession,
    prefix: &str,
) -> Result<Vec<GaleonObject>, String> {
    match session {
        StorageSession::OpenDAL(op) => {
            let prefix_str = if prefix.is_empty() {
                String::new()
            } else if prefix.ends_with('/') {
                prefix.to_string()
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
                    (
                        Some(meta.content_length()),
                        meta.last_modified().map(|t| t.into_inner().to_string()),
                    )
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
            let dir_path = if prefix.is_empty() {
                sftp.pwd().unwrap_or_else(|_| "/".to_string())
            } else {
                prefix.to_string()
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
                prefix.to_string()
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
