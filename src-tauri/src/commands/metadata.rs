// Object metadata inspection and updates.

use crate::*;

/// Object metadata contract shared with the frontend Properties Inspector.
/// Field names are serialized as camelCase JSON keys.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ObjectMetadataInfo {
    pub content_type: Option<String>,
    pub content_length: Option<u64>,
    pub last_modified: Option<String>, // rfc3339
    pub etag: Option<String>,
    pub cache_control: Option<String>,
    pub content_encoding: Option<String>,
    pub content_disposition: Option<String>,
    pub storage_class: Option<String>,
    pub user_metadata: Option<std::collections::HashMap<String, String>>,
}

/// Fetch object metadata for the Properties Inspector.
#[tauri::command]
pub async fn get_object_metadata(
    state: tauri::State<'_, GaleonEngine>,
    session_id: String,
    key: String,
) -> Result<ObjectMetadataInfo, String> {
    let sessions = state.active_sessions.read().await;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| "Session not found".to_string())?
        .clone();
    drop(sessions);

    match session {
        StorageSession::OpenDAL(op) => {
            let meta = op.stat(&key).await.map_err(|e| e.to_string())?;
            Ok(ObjectMetadataInfo {
                content_type: meta.content_type().map(|s| s.to_string()),
                content_length: Some(meta.content_length()),
                last_modified: meta.last_modified().map(|d| d.into_inner().to_string()),
                etag: meta.etag().map(|s| s.to_string()),
                cache_control: meta.cache_control().map(|s| s.to_string()),
                content_encoding: None, // not exposed by opendal stat
                content_disposition: meta.content_disposition().map(|s| s.to_string()),
                storage_class: None, // not exposed by opendal stat
                user_metadata: meta.user_metadata().map(|m| {
                    m.into_iter()
                        .map(|(k, v)| (k.to_owned(), v.to_owned()))
                        .collect()
                }),
            })
        }
        StorageSession::NativeSFTP(sftp_arc) => {
            let size = {
                let guard = sftp_arc.lock().map_err(|e| e.to_string())?;
                guard.file_size(&key).ok()
            };
            Ok(ObjectMetadataInfo {
                content_type: None,
                content_length: size,
                last_modified: None,
                etag: None,
                cache_control: None,
                content_encoding: None,
                content_disposition: None,
                storage_class: None,
                user_metadata: None,
            })
        }
        StorageSession::FTP(ftp_arc) => {
            let size = {
                let mut guard = ftp_arc.lock().map_err(|e| e.to_string())?;
                guard.file_size(&key).ok()
            };
            Ok(ObjectMetadataInfo {
                content_type: None,
                content_length: size,
                last_modified: None,
                etag: None,
                cache_control: None,
                content_encoding: None,
                content_disposition: None,
                storage_class: None,
                user_metadata: None,
            })
        }
    }
}

/// Verify that a local file matches the selected remote object by size and
/// (for S3) checksum, reusing the same `verify_integrity` path the transfer
/// pipeline uses post-download. Returns a structured pass/fail; an `Err` is
/// reserved for failures obtaining the remote metadata, not a clean mismatch.
#[tauri::command]
pub async fn verify_local_matches_remote(
    state: tauri::State<'_, GaleonEngine>,
    session_id: String,
    key: String,
    local_path: String,
) -> Result<VerifyResult, String> {
    let sessions = state.active_sessions.read().await;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| "Session not found".to_string())?
        .clone();
    drop(sessions);

    // Obtain the remote size and (S3-only) ETag.
    let (size, etag): (u64, Option<String>) = match session {
        StorageSession::OpenDAL(op) => {
            let meta = op.stat(&key).await.map_err(|e| e.to_string())?;
            (meta.content_length(), meta.etag().map(|s| s.to_string()))
        }
        StorageSession::NativeSFTP(sftp_arc) => {
            let size = {
                let guard = sftp_arc.lock().map_err(|e| e.to_string())?;
                guard.file_size(&key).map_err(|e| e.to_string())?
            };
            (size, None)
        }
        StorageSession::FTP(ftp_arc) => {
            let size = {
                let mut guard = ftp_arc.lock().map_err(|e| e.to_string())?;
                guard.file_size(&key).map_err(|e| e.to_string())?
            };
            (size, None)
        }
    };

    let checked_checksum = etag.is_some();
    match verify_integrity(&local_path, size, etag.as_deref()).await {
        Ok(()) => Ok(VerifyResult {
            matches: true,
            detail: if checked_checksum {
                "Size and checksum match the remote object.".to_string()
            } else {
                "Size matches (no remote checksum available for this protocol).".to_string()
            },
            checked_checksum,
        }),
        Err(detail) => Ok(VerifyResult {
            matches: false,
            detail,
            checked_checksum,
        }),
    }
}

/// Update S3 object metadata via a server-side self-copy.
///
/// Supported fields: `content_type`, `storage_class`. At least one must be set.
/// Non-S3 sessions return an error.
#[tauri::command]
pub async fn update_object_metadata(
    state: tauri::State<'_, GaleonEngine>,
    session_id: String,
    key: String,
    content_type: Option<String>,
    storage_class: Option<String>,
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

    if !matches!(session, StorageSession::OpenDAL(_)) {
        return Err("Metadata updates are only supported for S3 objects.".to_string());
    }

    let s3_config = state
    .s3_configs
    .read()
    .await
    .get(&session_id)
    .cloned()
    .ok_or_else(|| {
        "S3 metadata updates are unavailable for this session. Reconnect to the bucket and try again.".to_string()
    })?;

    let mut update = s3_metadata::MetadataUpdate::default();
    if let Some(raw) = content_type {
        update.content_type = Some(s3_metadata::normalize_content_type(&raw)?);
    }
    if let Some(sc) = storage_class {
        let trimmed = sc.trim();
        if trimmed.is_empty() {
            return Err("Storage class cannot be empty.".to_string());
        }
        update.storage_class = Some(trimmed.to_string());
    }

    let client = s3_metadata::build_s3_client(&s3_config).await?;
    s3_metadata::apply_metadata_update(&client, &s3_config.bucket, &key, &update).await
}
