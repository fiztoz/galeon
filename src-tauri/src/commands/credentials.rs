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

#[tauri::command]
pub async fn lock_credentials_now(state: tauri::State<'_, GaleonEngine>) -> Result<(), String> {
    state.credential_cache.clear();
    Ok(())
}

#[tauri::command]
pub async fn get_credential_unlock_status(
    state: tauri::State<'_, GaleonEngine>,
) -> Result<credentials::CredentialUnlockStatus, String> {
    Ok(state.credential_cache.status())
}
