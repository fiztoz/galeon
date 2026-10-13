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

    // Keyring first: the identity guard inside may CLEAR this profile's vault
    // entry, and `has_saved_credentials` / the cache below must reflect what
    // is left afterwards.
    let existing = config.profiles.iter().find(|p| p.id == profile.id);
    persist_save_profile_secrets(
        existing,
        &profile,
        password.as_deref(),
        ssh_tunnel_password.as_deref(),
    )?;

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

/// Which keyring action a manual `save_profile` must take for this payload.
///
/// Mirrors the import overwrite policy in `profile_io/merge.rs`: an identity
/// change without genuinely new secrets queues a vault delete (its `delete_ids`)
/// instead of rebinding old secrets to the new target — see the "Avoid
/// rebinding old vault secrets to a new host/endpoint/protocol" branch.
///
/// The connection form pre-fills access key, secret key and bastion password
/// from the keyring (`Connection.tsx`, `setAccessKey(creds[`), so on a manual
/// edit "the payload contains secrets" normally means the OLD secrets are
/// riding along to a new host; they are never "genuinely new" from this
/// path's point of view. Option B: still save the profile, but CLEAR the whole
/// vault entry for the id so the user re-enters credentials for the new
/// target. A later save with a stable identity stores them normally.
#[derive(Debug, PartialEq, Eq)]
enum SaveSecretsAction {
    /// Identity changed — clear the vault entry (storage secret + bastion
    /// password + legacy) for this profile id instead of writing the payload.
    ClearVault,
    /// Same identity, or a brand-new profile id — write the payload as before.
    WritePayload,
}

/// Pure policy for [`persist_save_profile_secrets`]: stored profile (if any)
/// vs a sanitized, secret-stripped copy of the incoming profile — the same two
/// shapes the import path compares
/// (`connection_identity_changed(&profiles[idx], &sanitized)` in merge.rs) —
/// so paste junk or whitespace in the form fields does not read as a target
/// change. Runs no keyring I/O; the caller applies the outcome.
fn save_secrets_action(
    existing: Option<&ConnectionProfile>,
    profile: &ConnectionProfile,
) -> SaveSecretsAction {
    let mut incoming_meta = profile.clone();
    incoming_meta.access_key = None;
    incoming_meta.secret_key = None;
    if let Some(tunnel) = incoming_meta.ssh_tunnel.as_mut() {
        tunnel.password = None;
    }
    s3_connect::sanitize_profile_for_storage(&mut incoming_meta);

    let identity_changed = existing
        .is_some_and(|stored| profile_io::connection_identity_changed(stored, &incoming_meta));
    if identity_changed {
        SaveSecretsAction::ClearVault
    } else {
        SaveSecretsAction::WritePayload
    }
}

/// Keyring writes for one `save_profile` call — the manual-edit counterpart of
/// the import overwrite path in `profile_io/merge.rs`.
///
/// `existing` is the stored profile sharing `profile.id`, if any (None when
/// creating).
fn persist_save_profile_secrets(
    existing: Option<&ConnectionProfile>,
    profile: &ConnectionProfile,
    password: Option<&str>,
    ssh_tunnel_password: Option<&str>,
) -> Result<(), String> {
    match save_secrets_action(existing, profile) {
        // Option B — the same semantic merge.rs applies to an overwrite whose
        // identity changed: the profile is still saved by the caller, but the
        // whole vault entry for the id is CLEARED rather than rewritten from
        // the payload, so host A's credentials never end up serving host B.
        SaveSecretsAction::ClearVault => credentials::delete_credentials_from_keyring(&profile.id),
        SaveSecretsAction::WritePayload => {
            // Save storage credentials independently from the optional bastion password.
            // Every non-S3 protocol keeps a single secret in the password slot — the
            // same rule profile_io/secrets.rs uses on import.
            let protocol = profile.protocol.as_deref().unwrap_or("s3");
            if protocol == "s3" {
                if let (Some(ak), Some(sk)) = (&profile.access_key, &profile.secret_key) {
                    if !ak.is_empty() && !sk.is_empty() {
                        credentials::save_credentials_to_keyring(&profile.id, ak, sk)?;
                    }
                }
            } else if let Some(pw) = password.filter(|value| !value.is_empty()) {
                credentials::save_password_to_keyring(&profile.id, pw)?;
            } else {
                credentials::delete_password_from_keyring(&profile.id)?;
            }

            if profile.ssh_tunnel.is_some() {
                if let Some(pw) = ssh_tunnel_password.filter(|value| !value.is_empty()) {
                    credentials::save_ssh_tunnel_password_to_keyring(&profile.id, pw)?;
                } else {
                    credentials::delete_ssh_tunnel_password_from_keyring(&profile.id)?;
                }
            } else {
                credentials::delete_ssh_tunnel_password_from_keyring(&profile.id)?;
            }

            Ok(())
        }
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    /// A stored config profile — as `save_profile` would have persisted it
    /// (sanitized), which is the shape `existing` has in real saves.
    fn stored_s3(id: &str, endpoint: &str) -> ConnectionProfile {
        let mut p = ConnectionProfile {
            id: id.to_string(),
            name: "Prod".to_string(),
            protocol: Some("s3".to_string()),
            endpoint: Some(endpoint.to_string()),
            region: Some("us-east-1".to_string()),
            access_key: None,
            secret_key: None,
            bucket: Some("my-bucket".to_string()),
            danger_disable_ssl_verification: Some(false),
            use_virtual_host_style: None,
            storage_class: None,
            max_bandwidth: None,
            host: None,
            port: None,
            username: None,
            key_path: None,
            credential_path: None,
            passive_mode: None,
            encrypt: None,
            bandwidth_rules: None,
            ssh_tunnel: None,
            ssh_tunnel_profile_id: None,
            has_saved_credentials: Some(true),
        };
        s3_connect::sanitize_profile_for_storage(&mut p);
        p
    }

    /// The reported bug: the form carries the keyring-prefilled old keys while
    /// the endpoint moves to a different host. The save must take the
    /// `ClearVault` action — `persist_save_profile_secrets` maps it to
    /// `delete_credentials_from_keyring`, so the old secret does not survive
    /// under this id to serve the new host (Option B, the same semantic
    /// `profile_io/merge.rs` applies to identity-changing overwrites).
    #[test]
    fn save_with_changed_endpoint_clears_vault_instead_of_rebinding() {
        let existing = stored_s3(
            "manual-save-endpoint-change",
            "https://s3.us-east-1.amazonaws.com",
        );
        let mut incoming = stored_s3(
            "manual-save-endpoint-change",
            "https://s3.eu-west-1.amazonaws.com",
        );
        incoming.access_key = Some("AKIA_OLD".to_string());
        incoming.secret_key = Some("SECRET_OLD".to_string());

        assert_eq!(
            save_secrets_action(Some(&existing), &incoming),
            SaveSecretsAction::ClearVault
        );
    }

    /// Same hole with an empty payload: doing nothing would leave the OLD
    /// vault entry bound to the new host — merge.rs clears in that case too.
    #[test]
    fn save_with_changed_endpoint_clears_even_without_payload_secrets() {
        let existing = stored_s3(
            "manual-save-empty-payload",
            "https://s3.us-east-1.amazonaws.com",
        );
        let incoming = stored_s3(
            "manual-save-empty-payload",
            "https://s3.eu-west-1.amazonaws.com",
        );

        assert_eq!(
            save_secrets_action(Some(&existing), &incoming),
            SaveSecretsAction::ClearVault
        );
    }

    /// Positive control: an unchanged identity still writes the payload's
    /// secrets, so the guard only fires on a real target change.
    #[test]
    fn save_with_unchanged_identity_writes_secrets() {
        let existing = stored_s3(
            "manual-save-same-identity",
            "https://s3.us-east-1.amazonaws.com",
        );
        let mut incoming = existing.clone();
        incoming.access_key = Some("AKIA_NEW".to_string());
        incoming.secret_key = Some("SECRET_NEW".to_string());

        assert_eq!(
            save_secrets_action(Some(&existing), &incoming),
            SaveSecretsAction::WritePayload
        );
    }

    /// Creating a profile (no stored id yet) must never be treated as an
    /// identity change — there is no old secret to protect.
    #[test]
    fn save_of_new_profile_writes_secrets() {
        let incoming = stored_s3(
            "manual-save-new-profile",
            "https://s3.us-east-1.amazonaws.com",
        );

        assert_eq!(
            save_secrets_action(None, &incoming),
            SaveSecretsAction::WritePayload
        );
    }
}
