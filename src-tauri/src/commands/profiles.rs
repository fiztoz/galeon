// Profile CRUD and app settings / metadata commands.

use crate::*;

#[tauri::command]
pub async fn get_profiles(app_handle: AppHandleType) -> Result<Vec<ConnectionProfile>, String> {
    let config = read_config(&app_handle)?;
    // Note: credentials are not loaded here for security
    // They will be loaded when connecting
    Ok(config.profiles)
}

#[tauri::command]
pub async fn save_profile(
    app_handle: AppHandleType,
    state: tauri::State<'_, GaleonEngine>,
    profile: ConnectionProfile,
    password: Option<String>,
    ssh_tunnel_password: Option<String>,
) -> Result<(), String> {
    let mut config = read_config(&app_handle)?;

    if let Some(tunnel_profile_id) = profile.ssh_tunnel_profile_id.as_deref() {
        ssh_tunnel_profiles::get_profile(&app_handle, tunnel_profile_id)?;
    }

    // Extract credentials before saving to config
    let access_key = profile.access_key.clone();
    let secret_key = profile.secret_key.clone();
    let protocol = profile.protocol.as_deref().unwrap_or("s3");
    // Save storage credentials independently from the optional bastion password.
    if protocol == "s3" {
        if let (Some(ak), Some(sk)) = (&access_key, &secret_key) {
            if !ak.is_empty() && !sk.is_empty() {
                credentials::save_credentials_to_keyring(&profile.id, ak, sk)?;
            }
        }
    } else if protocol == "sftp" || protocol == "ftp" || protocol == "ftps" {
        if let Some(pw) = password.as_ref().filter(|value| !value.is_empty()) {
            credentials::save_password_to_keyring(&profile.id, pw)?;
        } else {
            credentials::delete_password_from_keyring(&profile.id)?;
        }
    }

    if profile.ssh_tunnel.is_some() {
        if let Some(pw) = ssh_tunnel_password
            .as_ref()
            .filter(|value| !value.is_empty())
        {
            credentials::save_ssh_tunnel_password_to_keyring(&profile.id, pw)?;
        } else {
            credentials::delete_ssh_tunnel_password_from_keyring(&profile.id)?;
        }
    } else {
        credentials::delete_ssh_tunnel_password_from_keyring(&profile.id)?;
    }

    let stored = credentials::load_stored_credentials_from_keyring(&profile.id)?;
    let has_saved_credentials = stored.access_key.is_some()
        || stored.secret_key.is_some()
        || stored.ssh_tunnel_password.is_some();
    credentials::update_cache_after_save(
        &state.credential_cache,
        &profile.id,
        stored.access_key.as_deref(),
        stored.secret_key.as_deref(),
        stored.ssh_tunnel_password.as_deref(),
        now_ms(),
    );

    // Create profile without credentials for config file
    let mut profile_for_config = profile.clone();
    profile_for_config.access_key = None;
    profile_for_config.secret_key = None;
    if let Some(tunnel) = profile_for_config.ssh_tunnel.as_mut() {
        tunnel.password = None;
    }
    profile_for_config.has_saved_credentials = Some(has_saved_credentials);
    // Clean non-secret connection fields (endpoint/region/bucket/host/…) before persist.
    s3_connect::sanitize_profile_for_storage(&mut profile_for_config);

    // Find and update existing profile or add new one
    if let Some(existing) = config.profiles.iter_mut().find(|p| p.id == profile.id) {
        *existing = profile_for_config;
    } else {
        config.profiles.push(profile_for_config);
    }

    write_config(&app_handle, &config)
}

#[tauri::command]
pub async fn delete_profile(
    app_handle: AppHandleType,
    state: tauri::State<'_, GaleonEngine>,
    profile_id: String,
) -> Result<(), String> {
    let mut config = read_config(&app_handle)?;

    credentials::delete_credentials_from_keyring(&profile_id)?;
    state.credential_cache.remove(&profile_id);

    config.profiles.retain(|p| p.id != profile_id);

    write_config(&app_handle, &config)
}

#[tauri::command]
pub async fn get_app_settings(app_handle: AppHandleType) -> Result<AppSettings, String> {
    read_app_settings(&app_handle)
}

#[tauri::command]
pub async fn save_app_settings(
    app_handle: AppHandleType,
    settings: AppSettings,
) -> Result<(), String> {
    let mut settings = settings;
    settings.updated_at_ms = now_ms();
    write_app_settings(&app_handle, &settings)
}

#[tauri::command]
pub async fn reset_onboarding(app_handle: AppHandleType) -> Result<(), String> {
    let mut settings = read_app_settings(&app_handle)?;
    settings.onboarding_complete = false;
    settings.updated_at_ms = now_ms();
    write_app_settings(&app_handle, &settings)
}

#[tauri::command]
pub fn get_app_metadata() -> AppMetadata {
    AppMetadata {
        product_name: "Galeon".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        identifier: "com.fizto.galeon".to_string(),
        platform: std::env::consts::OS.to_string(),
    }
}
