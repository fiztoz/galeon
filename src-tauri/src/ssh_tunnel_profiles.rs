//! Persistent, reusable SSH tunnel profiles.
//!
//! Tunnel metadata is stored separately from storage connection profiles.
//! Passwords are keyed by tunnel-profile id in the OS credential vault.

use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::ssh_tunnel::{self, SshTunnelConfig};
use crate::AppHandleType;

const STORE_FILE: &str = "ssh_tunnel_profiles.json";
const CREDENTIAL_ID_PREFIX: &str = "ssh-tunnel:";

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SshTunnelProfile {
    pub id: String,
    pub name: String,
    pub host: String,
    #[serde(default = "default_ssh_port")]
    pub port: u16,
    pub username: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_path: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub has_saved_password: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
struct SshTunnelProfilesStore {
    #[serde(default)]
    profiles: Vec<SshTunnelProfile>,
}

fn default_ssh_port() -> u16 {
    22
}

pub fn credential_id(profile_id: &str) -> String {
    format!("{CREDENTIAL_ID_PREFIX}{profile_id}")
}

fn store_path(app_handle: &AppHandleType) -> Result<std::path::PathBuf, String> {
    let config_dir = app_handle
        .path()
        .app_config_dir()
        .map_err(|e| format!("Failed to get config dir: {e}"))?;
    if !config_dir.exists() {
        std::fs::create_dir_all(&config_dir)
            .map_err(|e| format!("Failed to create config dir: {e}"))?;
    }
    Ok(config_dir.join(STORE_FILE))
}

fn read_store(app_handle: &AppHandleType) -> Result<SshTunnelProfilesStore, String> {
    let path = store_path(app_handle)?;
    if !path.exists() {
        return Ok(SshTunnelProfilesStore::default());
    }
    let raw = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read SSH tunnel profiles: {e}"))?;
    serde_json::from_str(&raw).map_err(|e| format!("Failed to parse SSH tunnel profiles: {e}"))
}

fn write_store(app_handle: &AppHandleType, store: &SshTunnelProfilesStore) -> Result<(), String> {
    let path = store_path(app_handle)?;
    let raw = serde_json::to_string_pretty(store)
        .map_err(|e| format!("Failed to serialize SSH tunnel profiles: {e}"))?;
    std::fs::write(path, raw).map_err(|e| format!("Failed to write SSH tunnel profiles: {e}"))
}

fn sanitize_profile(mut profile: SshTunnelProfile) -> Result<SshTunnelProfile, String> {
    profile.name = profile.name.trim().to_string();
    if profile.id.trim().is_empty() {
        return Err("SSH tunnel profile id is required.".to_string());
    }
    if profile.name.is_empty() {
        return Err("SSH tunnel profile name is required.".to_string());
    }

    let config = ssh_tunnel::sanitize_config(profile.as_config());
    ssh_tunnel::validate_config(&config)?;
    profile.host = config.host;
    profile.port = config.port;
    profile.username = config.username;
    profile.key_path = config.key_path;
    Ok(profile)
}

fn upsert_profile(
    profiles: &mut Vec<SshTunnelProfile>,
    profile: SshTunnelProfile,
) -> Result<(), String> {
    if profiles.iter().any(|existing| {
        existing.id != profile.id && existing.name.eq_ignore_ascii_case(&profile.name)
    }) {
        return Err("An SSH tunnel profile with that name already exists.".to_string());
    }
    if let Some(existing) = profiles
        .iter_mut()
        .find(|existing| existing.id == profile.id)
    {
        *existing = profile;
    } else {
        profiles.push(profile);
    }
    Ok(())
}

impl SshTunnelProfile {
    pub fn as_config(&self) -> SshTunnelConfig {
        SshTunnelConfig {
            host: self.host.clone(),
            port: self.port,
            username: self.username.clone(),
            key_path: self.key_path.clone(),
            password: None,
        }
    }
}

pub fn get_profile(
    app_handle: &AppHandleType,
    profile_id: &str,
) -> Result<SshTunnelProfile, String> {
    read_store(app_handle)?
        .profiles
        .into_iter()
        .find(|profile| profile.id == profile_id)
        .ok_or_else(|| {
            format!("SSH tunnel profile not found: {profile_id}. Choose another tunnel profile.")
        })
}

#[tauri::command]
pub async fn get_ssh_tunnel_profiles(
    app_handle: AppHandleType,
) -> Result<Vec<SshTunnelProfile>, String> {
    Ok(read_store(&app_handle)?.profiles)
}

#[tauri::command]
pub async fn save_ssh_tunnel_profile(
    app_handle: AppHandleType,
    state: tauri::State<'_, crate::GaleonEngine>,
    profile: SshTunnelProfile,
    password: Option<String>,
    clear_password: bool,
) -> Result<(), String> {
    let mut store = read_store(&app_handle)?;
    let existing_has_password = store
        .profiles
        .iter()
        .find(|existing| existing.id == profile.id)
        .is_some_and(|existing| existing.has_saved_password);
    let password = password.filter(|value| !value.is_empty());
    let mut profile = sanitize_profile(profile)?;
    profile.has_saved_password = if clear_password {
        false
    } else {
        password.is_some() || existing_has_password
    };

    upsert_profile(&mut store.profiles, profile.clone())?;

    let credential_id = credential_id(&profile.id);
    if clear_password {
        crate::credentials::delete_ssh_tunnel_password_from_keyring(&credential_id)?;
        state.credential_cache.remove(&credential_id);
    } else if let Some(password) = password.as_deref() {
        crate::credentials::save_ssh_tunnel_password_to_keyring(&credential_id, password)?;
        crate::credentials::update_cache_after_save(
            &state.credential_cache,
            &credential_id,
            None,
            None,
            Some(password),
            crate::now_ms(),
        );
    }

    write_store(&app_handle, &store)
}

pub fn delete_profile(
    app_handle: &AppHandleType,
    state: &crate::GaleonEngine,
    profile_id: &str,
) -> Result<(), String> {
    let mut store = read_store(app_handle)?;
    let original_len = store.profiles.len();
    store.profiles.retain(|profile| profile.id != profile_id);
    if store.profiles.len() == original_len {
        return Err("SSH tunnel profile not found.".to_string());
    }

    let credential_id = credential_id(profile_id);
    crate::credentials::delete_credentials_from_keyring(&credential_id)?;
    state.credential_cache.remove(&credential_id);
    write_store(app_handle, &store)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(id: &str, name: &str) -> SshTunnelProfile {
        SshTunnelProfile {
            id: id.to_string(),
            name: name.to_string(),
            host: " bastion.example.com ".to_string(),
            port: 22,
            username: " deploy ".to_string(),
            key_path: Some(" /tmp/id_ed25519 ".to_string()),
            has_saved_password: false,
        }
    }

    #[test]
    fn sanitize_profile_cleans_connection_fields() {
        let cleaned = sanitize_profile(profile("t1", " Production ")).unwrap();

        assert_eq!(cleaned.name, "Production");
        assert_eq!(cleaned.host, "bastion.example.com");
        assert_eq!(cleaned.username, "deploy");
        assert_eq!(cleaned.key_path.as_deref(), Some("/tmp/id_ed25519"));
    }

    #[test]
    fn upsert_rejects_case_insensitive_duplicate_names() {
        let mut profiles = vec![profile("t1", "Production")];

        let error = upsert_profile(&mut profiles, profile("t2", "production")).unwrap_err();

        assert!(error.contains("already exists"));
    }

    #[test]
    fn upsert_updates_by_id_without_reordering() {
        let mut profiles = vec![profile("t1", "Old"), profile("t2", "Other")];
        let updated = profile("t1", "New");

        upsert_profile(&mut profiles, updated.clone()).unwrap();

        assert_eq!(profiles, vec![updated, profile("t2", "Other")]);
    }

    #[test]
    fn credential_ids_are_namespaced_from_connection_profiles() {
        assert_eq!(credential_id("abc"), "ssh-tunnel:abc");
    }
}
