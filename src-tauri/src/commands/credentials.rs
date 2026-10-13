// Keyring-backed credential commands.

use crate::*;

#[tauri::command]
pub async fn get_profile_credentials(
    state: tauri::State<'_, GaleonEngine>,
    profile_id: String,
) -> Result<(Option<String>, Option<String>), String> {
    credentials::load_credentials_cached(&state.credential_cache, &profile_id, now_ms())
}

#[tauri::command]
pub async fn get_profile_ssh_tunnel_password(
    state: tauri::State<'_, GaleonEngine>,
    profile_id: String,
) -> Result<Option<String>, String> {
    credentials::load_ssh_tunnel_password_cached(&state.credential_cache, &profile_id, now_ms())
}

#[tauri::command]
pub async fn migrate_legacy_credentials_to_vault(
    app_handle: AppHandleType,
    state: tauri::State<'_, GaleonEngine>,
) -> Result<credentials::CredentialMigrationResult, String> {
    let config = read_config(&app_handle)?;
    let profile_ids: Vec<String> = config.profiles.iter().map(|p| p.id.clone()).collect();
    credentials::migrate_legacy_profiles_to_vault(&state.credential_cache, &profile_ids, now_ms())
}

/// Drop every plaintext copy of a credential the process is holding.
///
/// The profile->secret cache was the only thing this cleared, which left the
/// button short of its promise: `s3_configs` holds `S3SessionConfig` with a
/// plaintext `secret_access_key`, and live sessions carry credentials inside
/// their OpenDAL operator / ssh2::Session / FTP stream. Neither is reachable
/// once created, and there is no disconnect command, so those copies lived for
/// the rest of the process no matter what the user did here.
///
/// TRADE-OFF: dropping sessions aborts in-flight transfers and background syncs,
/// and tunnels held by those sessions go down with them. That is the correct
/// behaviour for an explicit "lock" — the user asked for the credentials to stop
/// being resident — but it means Lock is a real action, not a formality.
#[tauri::command]
pub async fn lock_credentials_now(state: tauri::State<'_, GaleonEngine>) -> Result<(), String> {
    // 1. Live sessions first: each holds a credential inside a live backend.
    state.active_sessions.write().await.clear();
    // 2. Plaintext S3 metadata config (access key + secret key) per session.
    state.s3_configs.write().await.clear();
    // 3. SSH tunnels hold a bastion password in the forwarding process.
    state.ssh_tunnels.write().await.clear();
    // 4. The profile -> secret cache, which also resets `vault_loaded` so the
    //    next read comes back from the keyring rather than this cache.
    state.credential_cache.clear();
    Ok(())
}

#[tauri::command]
pub async fn get_credential_unlock_status(
    state: tauri::State<'_, GaleonEngine>,
) -> Result<credentials::CredentialUnlockStatus, String> {
    Ok(state.credential_cache.status())
}
