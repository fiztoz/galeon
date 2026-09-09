// Connection lifecycle: connect (S3 + unified), auto-reconnect, protocol capabilities.

use crate::*;

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn connect_bucket(
    state: tauri::State<'_, GaleonEngine>,
    endpoint: Option<String>,
    region: Option<String>,
    access_key: Option<String>,
    secret_key: Option<String>,
    bucket: String,
    danger_disable_ssl_verification: Option<bool>,
    use_virtual_host_style: Option<bool>,
    storage_class: Option<String>,
    max_bandwidth: Option<u64>,
) -> Result<String, String> {
    let (op, configured) = s3_connect::open_s3_operator(
        s3_connect::S3ConnectParams {
            endpoint,
            region,
            access_key,
            secret_key,
            bucket: Some(bucket),
            use_virtual_host_style,
            storage_class,
            danger_disable_ssl_verification,
        },
        s3_connect::S3LayerConfig {
            max_bandwidth_bytes_per_sec: max_bandwidth.filter(|&l| l > 0),
        },
        "Connection check failed",
    )
    .await?;

    let session_uuid = Uuid::new_v4().to_string();
    let s3_config = build_s3_session_config_parts(
        configured.bucket,
        configured.region,
        configured.endpoint,
        configured
            .access_key
            .ok_or_else(|| "S3 access key is required.".to_string())?,
        configured
            .secret_key
            .ok_or_else(|| "S3 secret key is required.".to_string())?,
        use_virtual_host_style,
        danger_disable_ssl_verification,
    )?;
    let mut sessions = state.active_sessions.write().await;
    sessions.insert(session_uuid.clone(), StorageSession::OpenDAL(op));
    drop(sessions);
    store_s3_session_config(&state, &session_uuid, s3_config).await;

    Ok(session_uuid)
}

/// Unified connect command supporting S3, SFTP, FTP, and FTPS protocols.
#[tauri::command]
pub async fn connect_storage(
    app_handle: AppHandleType,
    state: tauri::State<'_, GaleonEngine>,
    profile: ConnectionProfile,
    password: Option<String>,
    ssh_tunnel_password: Option<String>,
) -> Result<String, String> {
    let protocol = profile
        .protocol
        .as_deref()
        .unwrap_or("s3")
        .trim()
        .to_ascii_lowercase();
    let (profile, ssh_tunnel_password) =
        resolve_ssh_tunnel_profile(&app_handle, state.inner(), profile, ssh_tunnel_password)?;
    let (profile, ssh_tunnel) = ssh_tunnel::open_for_profile(profile, ssh_tunnel_password).await?;

    match protocol.as_str() {
        "s3" => {
            let mut profile = profile;
            let (op, configured) = s3_connect::open_s3_operator(
                s3_connect::S3ConnectParams {
                    endpoint: profile.endpoint.clone(),
                    region: profile.region.clone(),
                    access_key: profile.access_key.clone(),
                    secret_key: profile.secret_key.clone(),
                    bucket: profile.bucket.clone(),
                    use_virtual_host_style: profile.use_virtual_host_style,
                    storage_class: profile.storage_class.clone(),
                    danger_disable_ssl_verification: profile.danger_disable_ssl_verification,
                },
                s3_connect::S3LayerConfig {
                    max_bandwidth_bytes_per_sec: resolve_bandwidth_limit_bytes_per_sec(
                        &profile,
                        now_ms(),
                    ),
                },
                "S3 connection check failed",
            )
            .await?;

            profile.endpoint = configured.endpoint.clone();
            profile.region = configured.region.clone();
            profile.access_key = configured.access_key.clone();
            profile.secret_key = configured.secret_key.clone();
            profile.bucket = Some(configured.bucket.clone());

            let session_uuid = Uuid::new_v4().to_string();
            let s3_config = build_s3_session_config(
                &profile,
                configured
                    .access_key
                    .ok_or_else(|| "S3 access key is required.".to_string())?,
                configured
                    .secret_key
                    .ok_or_else(|| "S3 secret key is required.".to_string())?,
            )?;
            let mut sessions = state.active_sessions.write().await;
            sessions.insert(session_uuid.clone(), StorageSession::OpenDAL(op));
            drop(sessions);
            store_s3_session_config(&state, &session_uuid, s3_config).await;
            if let Some(tunnel) = ssh_tunnel {
                state
                    .ssh_tunnels
                    .write()
                    .await
                    .insert(session_uuid.clone(), tunnel);
            }
            Ok(session_uuid)
        }
        "sftp" => {
            let host = profile
                .host
                .as_deref()
                .ok_or_else(|| "SFTP requires a host".to_string())?;
            let port = profile.port.unwrap_or(22);
            let username = profile.username.as_deref().unwrap_or("");
            let tunneled_known_host = ssh_tunnel
                .as_ref()
                .map(|tunnel| tunnel.destination_host().to_string());
            let tunneled_known_host_port =
                ssh_tunnel.as_ref().map(|tunnel| tunnel.destination_port());

            // A supplied password is authoritative even when an older profile still
            // carries a key path. This makes password auth an explicit first-class path.
            match (&password, &profile.key_path) {
                // Password-based auth: use native ssh2.
                (Some(pw), _) if !pw.is_empty() => {
                    let config = sftp_native::NativeSftpConfig {
                        host: host.to_string(),
                        port,
                        username: username.to_string(),
                        credential: Some(pw.clone()),
                        key_path: None,
                        known_host: tunneled_known_host,
                        known_host_port: tunneled_known_host_port,
                    };

                    let session = tokio::task::spawn_blocking(move || {
                        sftp_native::NativeSftpSession::connect(&config)
                    })
                    .await
                    .map_err(|e| format!("Task join error: {}", e))??;

                    let session_uuid = Uuid::new_v4().to_string();
                    let mut sessions = state.active_sessions.write().await;
                    sessions.insert(
                        session_uuid.clone(),
                        StorageSession::NativeSFTP(Arc::new(std::sync::Mutex::new(session))),
                    );
                    drop(sessions);
                    if let Some(tunnel) = ssh_tunnel {
                        state
                            .ssh_tunnels
                            .write()
                            .await
                            .insert(session_uuid.clone(), tunnel);
                    }
                    Ok(session_uuid)
                }
                // Key-based auth: use OpenDAL.
                (_, Some(key_path)) => {
                    if !std::path::Path::new(key_path).exists() {
                        return Err(format!(
                            "SSH key file not found: {}. Please verify the key path.",
                            key_path
                        ));
                    }

                    let mut builder = Sftp::default();
                    builder = builder.endpoint(&format!("{}:{}", host, port));
                    builder = builder.user(username);
                    builder = builder.key(key_path);

                    let op = Operator::new(builder)
                        .map_err(|e| format!("Failed to create SFTP operator: {}", e))?;

                    use opendal::layers::TimeoutLayer;
                    let op = op.layer(
                        TimeoutLayer::new()
                            .with_timeout(std::time::Duration::from_secs(60))
                            .with_io_timeout(std::time::Duration::from_secs(30)),
                    );

                    use opendal::layers::RetryLayer;
                    let mut op = op.layer(RetryLayer::new().with_max_times(3));

                    if let Some(limit) = resolve_bandwidth_limit_bytes_per_sec(&profile, now_ms()) {
                        op = apply_throttle_layer(op, limit);
                    }

                    op.check().await.map_err(|e| {
                        format!("SFTP connection check failed: {}. Verify key path and server accessibility.", e)
                    })?;

                    let session_uuid = Uuid::new_v4().to_string();
                    let mut sessions = state.active_sessions.write().await;
                    sessions.insert(session_uuid.clone(), StorageSession::OpenDAL(op));
                    drop(sessions);
                    if let Some(tunnel) = ssh_tunnel {
                        state
                            .ssh_tunnels
                            .write()
                            .await
                            .insert(session_uuid.clone(), tunnel);
                    }
                    Ok(session_uuid)
                }
                // No credentials
                _ => Err(
                    "SFTP requires either an SSH key path or password. Please provide credentials."
                        .to_string(),
                ),
            }
        }
        "ftp" | "ftps" => {
            // NOTE: Bandwidth rules (throttling) are NOT applied to FTP/FTPS sessions
            // because FtpSession uses native Rust FTP, not OpenDAL's ThrottleLayer.
            // Bandwidth rules only apply to S3 and OpenDAL-based (key-auth) SFTP.
            let host = profile
                .host
                .as_deref()
                .ok_or_else(|| "FTP/FTPS requires a host".to_string())?;
            let username = profile.username.as_deref().unwrap_or("anonymous");
            let secure = protocol == "ftps";
            let port = profile
                .port
                .unwrap_or_else(|| ftp_native::default_port(secure));

            let config = ftp_native::FtpConfig {
                host: host.to_string(),
                port,
                username: username.to_string(),
                credential: password.clone(),
                secure,
                passive: true,
            };

            let session =
                tokio::task::spawn_blocking(move || ftp_native::FtpSession::connect(&config))
                    .await
                    .map_err(|e| format!("Task join error: {}", e))??;

            let session_uuid = uuid::Uuid::new_v4().to_string();
            let mut sessions = state.active_sessions.write().await;
            sessions.insert(
                session_uuid.clone(),
                StorageSession::FTP(Arc::new(std::sync::Mutex::new(session))),
            );
            drop(sessions);
            if let Some(tunnel) = ssh_tunnel {
                state
                    .ssh_tunnels
                    .write()
                    .await
                    .insert(session_uuid.clone(), tunnel);
            }
            Ok(session_uuid)
        }
        other => Err(format!(
            "Unsupported protocol: {}. Use 's3', 'sftp', 'ftp', or 'ftps'.",
            other
        )),
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ReconnectResult {
    pub session_id: String,
    pub bucket: String,
    pub profile_id: String,
}

#[tauri::command]
pub async fn auto_reconnect(
    app_handle: AppHandleType,
    state: tauri::State<'_, GaleonEngine>,
) -> Result<Option<ReconnectResult>, String> {
    let queue = read_transfer_queue(&app_handle).await?;
    // Find the first active transfer that has a profile_id
    let active_entry = queue
        .entries
        .iter()
        .find(|e| e.status == "active" && !e.profile_id.is_empty());

    if let Some(entry) = active_entry {
        let profile_id = &entry.profile_id;
        let config = read_config(&app_handle)?;
        if let Some(profile) = config.profiles.iter().find(|p| &p.id == profile_id) {
            // Load credentials from session cache or keyring (lazy, on-demand)
            let cache = &state.credential_cache;
            let (access_key, secret_key) =
                credentials::load_credentials_cached(cache, profile_id, now_ms())?;

            let tunnel_password = if profile.ssh_tunnel_profile_id.is_none() {
                credentials::load_ssh_tunnel_password_cached(cache, profile_id, now_ms())?
            } else {
                None
            };
            let (profile, tunnel_password) = resolve_ssh_tunnel_profile(
                &app_handle,
                state.inner(),
                profile.clone(),
                tunnel_password,
            )?;
            let (mut profile, ssh_tunnel) =
                ssh_tunnel::open_for_profile(profile, tunnel_password).await?;
            let (op, configured) = s3_connect::open_s3_operator(
                s3_connect::S3ConnectParams {
                    endpoint: profile.endpoint.clone(),
                    region: profile.region.clone(),
                    access_key,
                    secret_key,
                    bucket: profile.bucket.clone(),
                    use_virtual_host_style: profile.use_virtual_host_style,
                    storage_class: profile.storage_class.clone(),
                    danger_disable_ssl_verification: profile.danger_disable_ssl_verification,
                },
                // Auto-reconnect: retry only (no bandwidth throttle).
                s3_connect::S3LayerConfig {
                    max_bandwidth_bytes_per_sec: None,
                },
                "Auto-reconnect connection check failed",
            )
            .await?;

            profile.endpoint = configured.endpoint.clone();
            profile.region = configured.region.clone();
            profile.access_key = configured.access_key.clone();
            profile.secret_key = configured.secret_key.clone();
            profile.bucket = Some(configured.bucket.clone());
            let bucket = configured.bucket.clone();

            let session_uuid = Uuid::new_v4().to_string();
            let s3_config = build_s3_session_config(
                &profile,
                configured
                    .access_key
                    .ok_or_else(|| "S3 access key is required.".to_string())?,
                configured
                    .secret_key
                    .ok_or_else(|| "S3 secret key is required.".to_string())?,
            )?;
            let mut sessions = state.active_sessions.write().await;
            sessions.insert(session_uuid.clone(), StorageSession::OpenDAL(op));
            drop(sessions);
            store_s3_session_config(&state, &session_uuid, s3_config).await;
            if let Some(tunnel) = ssh_tunnel {
                state
                    .ssh_tunnels
                    .write()
                    .await
                    .insert(session_uuid.clone(), tunnel);
            }

            return Ok(Some(ReconnectResult {
                session_id: session_uuid,
                bucket,
                profile_id: profile_id.clone(),
            }));
        }
    }

    Ok(None)
}

#[tauri::command]
pub async fn get_protocol_capabilities(protocol: String) -> Result<ProtocolCapabilities, String> {
    match protocol.as_str() {
        "s3" => Ok(ProtocolCapabilities {
            supports_presigned_urls: true,
            supports_multipart: true,
            supports_storage_class: true,
            supports_virtual_host_style: true,
            supports_bucket_concept: true,
            supports_bulk_delete: true,
        }),
        "sftp" => Ok(ProtocolCapabilities {
            supports_presigned_urls: false,
            supports_multipart: false,
            supports_storage_class: false,
            supports_virtual_host_style: false,
            supports_bucket_concept: false,
            supports_bulk_delete: false,
        }),
        "ftp" | "ftps" => Ok(ProtocolCapabilities {
            supports_presigned_urls: false,
            supports_multipart: false,
            supports_storage_class: false,
            supports_virtual_host_style: false,
            supports_bucket_concept: false,
            supports_bulk_delete: false,
        }),
        _ => Err(format!("Unknown protocol: {}", protocol)),
    }
}

// ===========================================================================
// Phase 9: External edit (open-in-editor + watch + reupload), object metadata
// ===========================================================================
