// Building and serializing an export, and the guards a file must pass.

use super::*;

/// Build export profiles from config rows + optional keyring secrets.
pub fn build_export_profiles(
    profiles: &[ConnectionProfile],
    secrets: &HashMap<String, credentials::StoredCredentials>,
    include_secrets: bool,
) -> Vec<ConnectionProfile> {
    profiles
        .iter()
        .map(|p| {
            let mut out = p.clone();
            // Runtime-only flag; not meaningful in a portable file.
            out.has_saved_credentials = None;
            if include_secrets {
                if let Some(stored) = secrets.get(&p.id) {
                    out.access_key = stored.access_key.clone().filter(|s| !s.is_empty());
                    out.secret_key = stored.secret_key.clone().filter(|s| !s.is_empty());
                    if let Some(tunnel) = out.ssh_tunnel.as_mut() {
                        tunnel.password =
                            stored.ssh_tunnel_password.clone().filter(|s| !s.is_empty());
                    }
                } else {
                    out.access_key = None;
                    out.secret_key = None;
                    if let Some(tunnel) = out.ssh_tunnel.as_mut() {
                        tunnel.password = None;
                    }
                }
            } else {
                out.access_key = None;
                out.secret_key = None;
                if let Some(tunnel) = out.ssh_tunnel.as_mut() {
                    tunnel.password = None;
                }
            }
            out
        })
        .collect()
}

pub fn build_export_file(
    profiles: Vec<ConnectionProfile>,
    include_secrets: bool,
    exported_at: String,
) -> ProfileExportFile {
    let includes = include_secrets
        && profiles
            .iter()
            .any(|p| p.access_key.is_some() || p.secret_key.is_some());
    ProfileExportFile {
        format: EXPORT_FORMAT.to_string(),
        version: EXPORT_VERSION,
        exported_at,
        includes_secrets: includes,
        profiles,
    }
}

/// Serialize an export file to pretty JSON.
pub fn serialize_export(file: &ProfileExportFile) -> Result<String, String> {
    serde_json::to_string_pretty(file).map_err(|e| format!("Failed to serialize export: {}", e))
}

pub(crate) fn profiles_have_secrets(profiles: &[ConnectionProfile]) -> bool {
    profiles.iter().any(profile_has_exportable_secrets)
}

pub(crate) fn profile_has_exportable_secrets(p: &ConnectionProfile) -> bool {
    let protocol = p.protocol.as_deref().unwrap_or("s3").to_ascii_lowercase();
    let ak = p
        .access_key
        .as_ref()
        .map(|s| !s.is_empty())
        .unwrap_or(false);
    let sk = p
        .secret_key
        .as_ref()
        .map(|s| !s.is_empty())
        .unwrap_or(false);
    let tunnel_password = p
        .ssh_tunnel
        .as_ref()
        .and_then(|tunnel| tunnel.password.as_ref())
        .map(|s| !s.is_empty())
        .unwrap_or(false);
    if protocol == "s3" {
        (ak && sk) || tunnel_password
    } else {
        sk || tunnel_password
    }
}

pub(crate) fn validate_export_envelope(file: &ProfileExportFile) -> Result<(), String> {
    if !file.format.is_empty() && file.format != EXPORT_FORMAT {
        return Err(format!(
            "Unsupported export format {:?}. Expected {:?}.",
            file.format, EXPORT_FORMAT
        ));
    }
    if file.version > EXPORT_VERSION {
        return Err(format!(
            "Export file version {} is newer than this app supports ({}).",
            file.version, EXPORT_VERSION
        ));
    }
    if file.profiles.len() > MAX_IMPORT_PROFILES {
        return Err(format!(
            "Import contains too many profiles ({}). Maximum is {}.",
            file.profiles.len(),
            MAX_IMPORT_PROFILES
        ));
    }
    Ok(())
}

pub(crate) fn normalize_export_file(mut file: ProfileExportFile) -> ProfileExportFile {
    if file.format.is_empty() {
        file.format = EXPORT_FORMAT.to_string();
    }
    if file.version == 0 {
        file.version = EXPORT_VERSION;
    }
    if !file.includes_secrets {
        file.includes_secrets = profiles_have_secrets(&file.profiles);
    }
    file
}

pub(crate) fn validate_export_path(path: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Export path is required.".to_string());
    }
    let p = PathBuf::from(trimmed);
    if p.is_dir() {
        return Err("Export path must be a file, not a directory.".to_string());
    }
    if let Some(parent) = p.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            return Err(format!(
                "Export directory does not exist: {}",
                parent.display()
            ));
        }
    }
    Ok(p)
}
