//! Building the per-session S3 config that metadata and reconnect reuse.

use crate::*;

/// Build an `S3SessionConfig` from connection fields and resolved credentials.
pub(crate) fn build_s3_session_config_parts(
    bucket: String,
    region: Option<String>,
    endpoint: Option<String>,
    access_key: String,
    secret_key: String,
    use_virtual_host_style: Option<bool>,
    danger_disable_ssl_verification: Option<bool>,
) -> Result<s3_metadata::S3SessionConfig, String> {
    if bucket.is_empty() {
        return Err("S3 bucket is required.".to_string());
    }
    Ok(s3_metadata::S3SessionConfig {
        bucket,
        region: region.unwrap_or_else(|| "us-east-1".to_string()),
        endpoint,
        access_key_id: access_key,
        secret_access_key: secret_key,
        force_path_style: !use_virtual_host_style.unwrap_or(false),
        danger_disable_ssl_verification: danger_disable_ssl_verification.unwrap_or(false),
    })
}

pub(crate) fn build_s3_session_config(
    profile: &ConnectionProfile,
    access_key: String,
    secret_key: String,
) -> Result<s3_metadata::S3SessionConfig, String> {
    build_s3_session_config_parts(
        profile.bucket.clone().unwrap_or_default(),
        profile.region.clone(),
        profile.endpoint.clone(),
        access_key,
        secret_key,
        profile.use_virtual_host_style,
        profile.danger_disable_ssl_verification,
    )
}

pub(crate) async fn store_s3_session_config(
    state: &GaleonEngine,
    session_id: &str,
    config: s3_metadata::S3SessionConfig,
) {
    state
        .s3_configs
        .write()
        .await
        .insert(session_id.to_string(), config);
}

pub(crate) async fn remove_s3_session_config(state: &GaleonEngine, session_id: &str) {
    state.s3_configs.write().await.remove(session_id);
}

/// Resolve a reusable SSH tunnel reference into the runtime-only embedded config.
/// Explicit passwords are used for quick-connect overrides; otherwise the tunnel
/// profile's own keyring entry is loaded.
pub(crate) fn resolve_ssh_tunnel_profile(
    app_handle: &AppHandleType,
    state: &GaleonEngine,
    mut profile: ConnectionProfile,
    explicit_password: Option<String>,
) -> Result<(ConnectionProfile, Option<String>), String> {
    let Some(profile_id) = profile
        .ssh_tunnel_profile_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
    else {
        return Ok((profile, explicit_password));
    };

    let tunnel_profile = ssh_tunnel_profiles::get_profile(app_handle, profile_id)?;
    let password = match explicit_password.filter(|value| !value.is_empty()) {
        Some(password) => Some(password),
        None => credentials::load_ssh_tunnel_password_cached(
            &state.credential_cache,
            &ssh_tunnel_profiles::credential_id(profile_id),
            now_ms(),
        )?,
    };
    profile.ssh_tunnel = Some(tunnel_profile.as_config());
    Ok((profile, password))
}
