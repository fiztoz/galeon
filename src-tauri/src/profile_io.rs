//! Connection profile export/import (JSON).
//!
//! Secrets are optional in exports. When present on import they are stored via
//! the keyring through the Tauri commands in this module — never logged.
//!
//! ## Path / webview residual risk
//! Path arguments still originate from the frontend dialog (not a Rust-side
//! file picker). We apply defense-in-depth (existence, size-on-read, parent
//! dir, content hash between preview and import, confirmSecrets gate), but a
//! compromised webview could still pass arbitrary paths and invoke export with
//! `include_secrets`. Full Rust-side dialog is out of scope; keep secrets
//! export opt-in and treat profile JSON as sensitive.

use crate::s3_connect::{clean_connection_field, clean_connection_opt, validate_bucket_name};
use crate::{credentials, ConnectionProfile, GaleonEngine};
use crate::{now_ms, read_config, write_config, AppHandleType};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use uuid::Uuid;

pub const EXPORT_FORMAT: &str = "galeon.profiles";
pub const EXPORT_VERSION: u32 = 1;
/// Hard cap on import file size (defense-in-depth against huge payloads).
pub const MAX_IMPORT_FILE_BYTES: u64 = 5 * 1024 * 1024;
/// Hard cap on number of profiles in a single import.
pub const MAX_IMPORT_PROFILES: usize = 500;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProfileExportFile {
    pub format: String,
    pub version: u32,
    #[serde(default)]
    pub exported_at: String,
    #[serde(default)]
    pub includes_secrets: bool,
    pub profiles: Vec<ConnectionProfile>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CollisionStrategy {
    Skip,
    Overwrite,
    Rename,
}

impl CollisionStrategy {
    pub fn parse(raw: &str) -> Result<Self, String> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "skip" => Ok(Self::Skip),
            "overwrite" => Ok(Self::Overwrite),
            "rename" => Ok(Self::Rename),
            other => Err(format!(
                "Unknown collision strategy {:?}. Use skip, overwrite, or rename.",
                other
            )),
        }
    }
}

/// Counters are non-overlapping so the UI can say "Imported X, Y overwritten"
/// without double-counting:
/// - `imported`: newly inserted profiles only
/// - `overwritten`: replaced existing profiles (not also counted in `imported`)
/// - `renamed`: subset of inserts that needed a unique name
/// - `skipped`: collision skips + validation errors
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub imported: usize,
    pub skipped: usize,
    pub renamed: usize,
    pub overwritten: usize,
    pub total_in_file: usize,
    pub messages: Vec<String>,
}

/// Pre-import summary (no config or keyring writes).
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    pub includes_secrets: bool,
    pub total: usize,
    pub profile_names: Vec<String>,
    pub danger_ssl_bypass_count: usize,
    pub profiles_with_secrets: usize,
    /// Fingerprint of the file bytes read for this preview (md5 hex).
    /// Pass back on import to detect TOCTOU replacement between preview and confirm.
    pub content_hash: String,
}

/// Credentials to persist after a successful merge (never logged).
#[derive(Clone, Debug)]
pub struct PendingCredentials {
    pub profile_id: String,
    pub access_key: Option<String>,
    pub secret_key: Option<String>,
    pub ssh_tunnel_password: Option<String>,
    pub protocol: String,
}

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

/// Parse a profile export JSON document.
///
/// Accepts:
/// - Canonical `ProfileExportFile`
/// - Bare array of profiles
/// - Object with a `profiles` array (e.g. a config.json snapshot)
pub fn parse_export_json(raw: &str) -> Result<ProfileExportFile, String> {
    let raw = raw.trim().trim_start_matches('\u{feff}');
    if raw.is_empty() {
        return Err("Export file is empty.".to_string());
    }

    if let Ok(file) = serde_json::from_str::<ProfileExportFile>(raw) {
        validate_export_envelope(&file)?;
        return Ok(normalize_export_file(file));
    }

    if let Ok(profiles) = serde_json::from_str::<Vec<ConnectionProfile>>(raw) {
        if profiles.len() > MAX_IMPORT_PROFILES {
            return Err(format!(
                "Import contains too many profiles ({}). Maximum is {}.",
                profiles.len(),
                MAX_IMPORT_PROFILES
            ));
        }
        return Ok(ProfileExportFile {
            format: EXPORT_FORMAT.to_string(),
            version: EXPORT_VERSION,
            exported_at: String::new(),
            includes_secrets: profiles_have_secrets(&profiles),
            profiles,
        });
    }

    // Last resort: object with a profiles key (config.json-like).
    let value: serde_json::Value =
        serde_json::from_str(raw).map_err(|e| format!("Invalid profile export file: {}", e))?;

    // If a format key is present, enforce it even on the fallback path.
    if let Some(fmt) = value.get("format").and_then(|v| v.as_str()) {
        if !fmt.is_empty() && fmt != EXPORT_FORMAT {
            return Err(format!(
                "Unsupported export format {:?}. Expected {:?}.",
                fmt, EXPORT_FORMAT
            ));
        }
    }
    if let Some(ver) = value.get("version").and_then(|v| v.as_u64()) {
        if ver > EXPORT_VERSION as u64 {
            return Err(format!(
                "Export file version {} is newer than this app supports ({}).",
                ver, EXPORT_VERSION
            ));
        }
    }

    let profiles_val = value.get("profiles").ok_or_else(|| {
        "Invalid profile export file: expected galeon.profiles document or a profiles array."
            .to_string()
    })?;
    let profiles: Vec<ConnectionProfile> = serde_json::from_value(profiles_val.clone())
        .map_err(|e| format!("Invalid profiles array in export file: {}", e))?;
    if profiles.len() > MAX_IMPORT_PROFILES {
        return Err(format!(
            "Import contains too many profiles ({}). Maximum is {}.",
            profiles.len(),
            MAX_IMPORT_PROFILES
        ));
    }
    Ok(ProfileExportFile {
        format: EXPORT_FORMAT.to_string(),
        version: EXPORT_VERSION,
        exported_at: String::new(),
        includes_secrets: profiles_have_secrets(&profiles),
        profiles,
    })
}

fn profiles_have_secrets(profiles: &[ConnectionProfile]) -> bool {
    profiles.iter().any(profile_has_exportable_secrets)
}

fn profile_has_exportable_secrets(p: &ConnectionProfile) -> bool {
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

fn validate_export_envelope(file: &ProfileExportFile) -> Result<(), String> {
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

fn normalize_export_file(mut file: ProfileExportFile) -> ProfileExportFile {
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

/// True when protocol / host / endpoint / username / bucket / port differ.
/// Used to decide whether stale keyring secrets would rebind to a new target.
pub fn connection_identity_changed(
    existing: &ConnectionProfile,
    incoming: &ConnectionProfile,
) -> bool {
    let proto = |p: &ConnectionProfile| {
        p.protocol
            .as_deref()
            .unwrap_or("s3")
            .trim()
            .to_ascii_lowercase()
    };
    if proto(existing) != proto(incoming) {
        return true;
    }
    let norm = |s: &Option<String>| {
        s.as_deref()
            .map(str::trim)
            .unwrap_or("")
            .to_ascii_lowercase()
    };
    if norm(&existing.endpoint) != norm(&incoming.endpoint) {
        return true;
    }
    if norm(&existing.host) != norm(&incoming.host) {
        return true;
    }
    if norm(&existing.username) != norm(&incoming.username) {
        return true;
    }
    if norm(&existing.bucket) != norm(&incoming.bucket) {
        return true;
    }
    if existing.port != incoming.port {
        return true;
    }
    let tunnel_identity = |p: &ConnectionProfile| {
        p.ssh_tunnel.as_ref().map(|tunnel| {
            (
                tunnel.host.trim().to_ascii_lowercase(),
                tunnel.port,
                tunnel.username.trim().to_string(),
                tunnel
                    .key_path
                    .as_deref()
                    .map(str::trim)
                    .unwrap_or("")
                    .to_string(),
            )
        })
    };
    if tunnel_identity(existing) != tunnel_identity(incoming) {
        return true;
    }
    if existing.ssh_tunnel_profile_id != incoming.ssh_tunnel_profile_id {
        return true;
    }
    false
}

/// Clean and validate a single imported profile (non-secret metadata).
/// Returns the cleaned profile with secrets still attached (caller extracts them).
///
/// `danger_disable_ssl_verification` is forced off on import — the user must
/// re-enable it in Advanced settings after reviewing the endpoint.
pub fn sanitize_imported_profile(
    mut profile: ConnectionProfile,
) -> Result<ConnectionProfile, String> {
    // Tunnel-profile ids are local references. Portable exports embed the tunnel
    // metadata, and raw config snapshots must not import dangling local ids.
    profile.ssh_tunnel_profile_id = None;
    profile.name = clean_connection_field(&profile.name);
    if profile.name.is_empty() {
        return Err("Profile name is required.".to_string());
    }

    let protocol = profile
        .protocol
        .as_deref()
        .unwrap_or("s3")
        .trim()
        .to_ascii_lowercase();
    if !matches!(protocol.as_str(), "s3" | "sftp" | "ftp" | "ftps") {
        return Err(format!(
            "Profile {:?}: unsupported protocol {:?}.",
            profile.name, protocol
        ));
    }
    profile.protocol = Some(protocol.clone());

    if protocol == "s3" {
        profile.endpoint = clean_connection_opt(profile.endpoint.take());
        profile.region = clean_connection_opt(profile.region.take());
        profile.bucket = clean_connection_opt(profile.bucket.take());
        profile.access_key = clean_connection_opt(profile.access_key.take());
        profile.secret_key = clean_connection_opt(profile.secret_key.take());
        profile.storage_class = clean_connection_opt(profile.storage_class.take());

        let bucket = profile.bucket.as_deref().unwrap_or("");
        if bucket.is_empty() {
            return Err(format!(
                "Profile {:?}: S3 bucket is required.",
                profile.name
            ));
        }
        validate_bucket_name(bucket).map_err(|e| format!("Profile {:?}: {}", profile.name, e))?;

        if let Some(ref ep) = profile.endpoint {
            if ep.chars().any(|c| c.is_whitespace()) {
                return Err(format!(
                    "Profile {:?}: endpoint contains whitespace.",
                    profile.name
                ));
            }
            // Reject clearly unparseable schemes / empty hosts without requiring a full URL crate.
            let without_scheme = ep
                .strip_prefix("https://")
                .or_else(|| ep.strip_prefix("http://"))
                .unwrap_or(ep.as_str());
            let host = without_scheme.split('/').next().unwrap_or("");
            if host.is_empty() {
                return Err(format!(
                    "Profile {:?}: endpoint host is empty.",
                    profile.name
                ));
            }
        }

        // Force SSL bypass off on import (MITM risk with untrusted files).
        if profile.danger_disable_ssl_verification.unwrap_or(false) {
            profile.danger_disable_ssl_verification = Some(false);
        }

        // Clear file-protocol fields
        profile.host = None;
        profile.port = None;
        profile.username = None;
        profile.key_path = None;
        profile.passive_mode = None;
        profile.encrypt = None;
    } else {
        profile.host = clean_connection_opt(profile.host.take());
        profile.username = clean_connection_opt(profile.username.take());
        profile.key_path = clean_connection_opt(profile.key_path.take());
        // Password lives in secret_key for SFTP/FTP. Preserve whitespace because it
        // may be part of the password; connection metadata is sanitized separately.
        profile.secret_key = profile.secret_key.take().filter(|s| !s.is_empty());
        profile.access_key = None;

        if profile.host.is_none() {
            return Err(format!(
                "Profile {:?}: host is required for {}.",
                profile.name, protocol
            ));
        }
        // Clear pure-S3 fields that don't apply (keep max_bandwidth / rules)
        profile.endpoint = None;
        profile.region = None;
        profile.bucket = None;
        profile.danger_disable_ssl_verification = None;
        profile.use_virtual_host_style = None;
        profile.storage_class = None;
    }

    if let Some(tunnel) = profile.ssh_tunnel.take() {
        if matches!(protocol.as_str(), "ftp" | "ftps") {
            return Err(format!(
                "Profile {:?}: SSH tunneling is not supported for FTP/FTPS.",
                profile.name
            ));
        }
        if protocol == "s3" && profile.endpoint.is_none() {
            return Err(format!(
                "Profile {:?}: an SSH-tunneled S3 profile requires a custom endpoint.",
                profile.name
            ));
        }
        let tunnel = crate::ssh_tunnel::sanitize_config(tunnel);
        crate::ssh_tunnel::validate_config(&tunnel)
            .map_err(|e| format!("Profile {:?}: {}", profile.name, e))?;
        profile.ssh_tunnel = Some(tunnel);
    }

    profile.has_saved_credentials = None;
    Ok(profile)
}

fn unique_import_name(base: &str, taken: &HashSet<String>) -> String {
    let base_lower = base.to_ascii_lowercase();
    if !taken.contains(&base_lower) {
        return base.to_string();
    }
    let candidate = format!("{} (imported)", base);
    if !taken.contains(&candidate.to_ascii_lowercase()) {
        return candidate;
    }
    for n in 2..10_000 {
        let candidate = format!("{} (imported {})", base, n);
        if !taken.contains(&candidate.to_ascii_lowercase()) {
            return candidate;
        }
    }
    format!("{} (imported {})", base, Uuid::new_v4())
}

/// Extract complete credentials only.
/// S3 requires both access_key and secret_key; partial pairs are ignored.
fn extract_pending_credentials(profile: &ConnectionProfile) -> Option<PendingCredentials> {
    let protocol = profile
        .protocol
        .as_deref()
        .unwrap_or("s3")
        .to_ascii_lowercase();
    let ak = profile.access_key.clone().filter(|s| !s.is_empty());
    let sk = profile.secret_key.clone().filter(|s| !s.is_empty());
    let ssh_tunnel_password = profile
        .ssh_tunnel
        .as_ref()
        .and_then(|tunnel| tunnel.password.clone())
        .filter(|s| !s.is_empty());
    let (access_key, secret_key) = if protocol == "s3" {
        match (ak, sk) {
            (Some(access_key), Some(secret_key)) => (Some(access_key), Some(secret_key)),
            _ => (None, None),
        }
    } else {
        (None, sk)
    };

    if access_key.is_none() && secret_key.is_none() && ssh_tunnel_password.is_none() {
        return None;
    }
    Some(PendingCredentials {
        profile_id: profile.id.clone(),
        access_key,
        secret_key,
        ssh_tunnel_password,
        protocol,
    })
}

fn profile_for_config(mut profile: ConnectionProfile, has_creds: bool) -> ConnectionProfile {
    profile.access_key = None;
    profile.secret_key = None;
    if let Some(tunnel) = profile.ssh_tunnel.as_mut() {
        tunnel.password = None;
    }
    profile.has_saved_credentials = Some(has_creds);
    profile
}

fn queue_credential_delete(delete_ids: &mut Vec<String>, profile_id: &str) {
    if !delete_ids.iter().any(|id| id == profile_id) {
        delete_ids.push(profile_id.to_string());
    }
}

/// Merge imported profiles into the existing list.
///
/// Returns `(profiles, result, pending_saves, credential_ids_to_delete)`.
///
/// - **Skip**: leave existing name alone; drop the import.
/// - **Overwrite**: replace metadata of the name match; keep existing id.
///   - With secrets: queue vault delete for the id (delete-then-insert) then pending save.
///     If persist fails after config write, vault is empty — no rebinding of old secrets.
///   - Without secrets + identity change: delete keyring (avoid rebinding secrets to a new host).
///   - Without secrets + same identity: preserve `has_saved_credentials` / vault.
/// - **Rename**: always insert as a new profile; rename on name collision.
pub fn merge_imported_profiles(
    existing: Vec<ConnectionProfile>,
    imported: Vec<ConnectionProfile>,
    strategy: CollisionStrategy,
) -> (
    Vec<ConnectionProfile>,
    ImportResult,
    Vec<PendingCredentials>,
    Vec<String>,
) {
    let mut result = ImportResult {
        total_in_file: imported.len(),
        ..Default::default()
    };
    let mut pending = Vec::new();
    let mut delete_ids = Vec::new();
    let mut profiles = existing;
    let mut name_index: HashMap<String, usize> = profiles
        .iter()
        .enumerate()
        .map(|(i, p)| (p.name.to_ascii_lowercase(), i))
        .collect();
    let mut taken_names: HashSet<String> = name_index.keys().cloned().collect();

    for raw in imported {
        let had_ssl_bypass = raw.danger_disable_ssl_verification.unwrap_or(false);
        let sanitized = match sanitize_imported_profile(raw) {
            Ok(p) => p,
            Err(e) => {
                result.skipped += 1;
                result.messages.push(e);
                continue;
            }
        };
        if had_ssl_bypass {
            result.messages.push(format!(
                "Profile \"{}\": SSL verification bypass was cleared for safety; re-enable in Advanced if needed.",
                sanitized.name
            ));
        }

        let name_key = sanitized.name.to_ascii_lowercase();
        let secrets = extract_pending_credentials(&sanitized);

        match strategy {
            CollisionStrategy::Skip if name_index.contains_key(&name_key) => {
                result.skipped += 1;
                result
                    .messages
                    .push(format!("Skipped existing profile \"{}\".", sanitized.name));
            }
            CollisionStrategy::Overwrite if name_index.contains_key(&name_key) => {
                let idx = name_index[&name_key];
                let existing_id = profiles[idx].id.clone();
                let prev_has_creds = profiles[idx].has_saved_credentials.unwrap_or(false);
                let identity_changed = connection_identity_changed(&profiles[idx], &sanitized);

                let mut updated = sanitized;
                updated.id = existing_id.clone();

                let has_creds = if let Some(mut creds) = secrets {
                    // Delete-then-insert: clear vault/cache for this id before
                    // write_config/persist so a failed persist cannot leave old
                    // secrets bound to a new host/endpoint under has_saved_credentials=true.
                    queue_credential_delete(&mut delete_ids, &existing_id);
                    creds.profile_id = existing_id.clone();
                    pending.push(creds);
                    true
                } else if identity_changed {
                    // Avoid rebinding old vault secrets to a new host/endpoint/protocol.
                    queue_credential_delete(&mut delete_ids, &existing_id);
                    result.messages.push(format!(
                        "Profile \"{}\": connection target changed without secrets — saved credentials cleared.",
                        updated.name
                    ));
                    false
                } else {
                    // Metadata-only refresh of same target — keep vault + flag.
                    prev_has_creds
                };

                profiles[idx] = profile_for_config(updated, has_creds);
                // Overwrite counts only as overwritten (not also imported) so the UI
                // "Imported X, Y overwritten" is non-overlapping.
                result.overwritten += 1;
            }
            _ => {
                // Insert as new (Rename strategy, or no collision for Skip/Overwrite).
                // `imported` = newly inserted only; `renamed` = subset that were renamed.
                let mut inserted = sanitized;
                let mut was_renamed = false;
                if strategy == CollisionStrategy::Rename && name_index.contains_key(&name_key) {
                    let new_name = unique_import_name(&inserted.name, &taken_names);
                    result
                        .messages
                        .push(format!("Renamed \"{}\" → \"{}\".", inserted.name, new_name));
                    inserted.name = new_name;
                    was_renamed = true;
                } else if strategy == CollisionStrategy::Skip {
                    // no collision — fall through to insert
                }

                // Always mint a fresh id so keyring entries don't clash.
                inserted.id = Uuid::new_v4().to_string();
                let has_creds = if let Some(mut creds) = secrets {
                    creds.profile_id = inserted.id.clone();
                    pending.push(creds);
                    true
                } else {
                    false
                };
                let new_name_key = inserted.name.to_ascii_lowercase();
                taken_names.insert(new_name_key.clone());
                name_index.insert(new_name_key, profiles.len());
                profiles.push(profile_for_config(inserted, has_creds));
                result.imported += 1;
                if was_renamed {
                    result.renamed += 1;
                }
            }
        }
    }

    (profiles, result, pending, delete_ids)
}

fn persist_pending_credentials(
    state: &GaleonEngine,
    pending: &[PendingCredentials],
) -> Result<(), String> {
    let loaded_at = now_ms();
    for creds in pending {
        if creds.protocol == "s3" {
            // Only complete S3 pairs reach here from extract_pending_credentials.
            if let (Some(ak), Some(sk)) = (&creds.access_key, &creds.secret_key) {
                credentials::save_credentials_to_keyring(&creds.profile_id, ak, sk)?;
            }
        } else if let Some(pw) = creds.secret_key.as_ref() {
            credentials::save_password_to_keyring(&creds.profile_id, pw)?;
        }
        if let Some(pw) = creds.ssh_tunnel_password.as_ref() {
            credentials::save_ssh_tunnel_password_to_keyring(&creds.profile_id, pw)?;
        }

        let stored = credentials::load_stored_credentials_from_keyring(&creds.profile_id)?;
        credentials::update_cache_after_save(
            &state.credential_cache,
            &creds.profile_id,
            stored.access_key.as_deref(),
            stored.secret_key.as_deref(),
            stored.ssh_tunnel_password.as_deref(),
            loaded_at,
        );
    }
    Ok(())
}

fn delete_profile_credentials(state: &GaleonEngine, profile_ids: &[String]) -> Result<(), String> {
    for id in profile_ids {
        credentials::delete_credentials_from_keyring(id)?;
        state.credential_cache.remove(id);
    }
    Ok(())
}

fn validate_export_path(path: &str) -> Result<PathBuf, String> {
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

fn validate_import_path(path: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Import path is required.".to_string());
    }
    let p = PathBuf::from(trimmed);
    if !p.exists() {
        return Err(format!("Import file not found: {}", p.display()));
    }
    if !p.is_file() {
        return Err("Import path must be a regular file.".to_string());
    }
    Ok(p)
}

/// Read import file in one pass; enforce size on the buffer (not a separate stat).
fn read_import_file_limited(path: &Path) -> Result<String, String> {
    use std::io::Read;
    let file =
        std::fs::File::open(path).map_err(|e| format!("Failed to open import file: {}", e))?;
    // Read at most MAX+1 so we can reject oversized files without loading unbounded data.
    let mut buf = Vec::new();
    let mut limited = file.take(MAX_IMPORT_FILE_BYTES.saturating_add(1));
    limited
        .read_to_end(&mut buf)
        .map_err(|e| format!("Failed to read import file: {}", e))?;
    if (buf.len() as u64) > MAX_IMPORT_FILE_BYTES {
        return Err(format!(
            "Import file is too large. Maximum is {} bytes.",
            MAX_IMPORT_FILE_BYTES
        ));
    }
    String::from_utf8(buf).map_err(|e| format!("Import file is not valid UTF-8: {}", e))
}

fn content_hash(raw: &str) -> String {
    format!("{:x}", md5::compute(raw.as_bytes()))
}

fn build_import_preview(export: &ProfileExportFile, content_hash: String) -> ImportPreview {
    let mut profile_names = Vec::with_capacity(export.profiles.len());
    let mut profiles_with_secrets = 0usize;
    let mut danger_ssl_bypass_count = 0usize;
    for p in &export.profiles {
        profile_names.push(p.name.clone());
        if profile_has_exportable_secrets(p) {
            profiles_with_secrets += 1;
        }
        if p.danger_disable_ssl_verification.unwrap_or(false) {
            danger_ssl_bypass_count += 1;
        }
    }
    ImportPreview {
        includes_secrets: export.includes_secrets || profiles_with_secrets > 0,
        total: export.profiles.len(),
        profile_names,
        danger_ssl_bypass_count,
        profiles_with_secrets,
        content_hash,
    }
}

/// Preview an import file without writing config or keyring.
#[tauri::command]
pub async fn preview_profile_import(path: String) -> Result<ImportPreview, String> {
    let path = validate_import_path(&path)?;
    let raw = read_import_file_limited(&path)?;
    let hash = content_hash(&raw);
    let export = parse_export_json(&raw)?;
    if export.profiles.is_empty() {
        return Err("Import file contains no profiles.".to_string());
    }
    Ok(build_import_preview(&export, hash))
}

/// Export selected (or all) profiles to a JSON file path.
#[tauri::command]
pub async fn export_profiles(
    app_handle: AppHandleType,
    state: tauri::State<'_, GaleonEngine>,
    path: String,
    profile_ids: Option<Vec<String>>,
    include_secrets: bool,
) -> Result<(), String> {
    let path = validate_export_path(&path)?;

    let config = read_config(&app_handle)?;
    let mut selected: Vec<ConnectionProfile> = match profile_ids {
        Some(ids) if !ids.is_empty() => {
            let set: HashSet<String> = ids.into_iter().collect();
            config
                .profiles
                .into_iter()
                .filter(|p| set.contains(&p.id))
                .collect()
        }
        _ => config.profiles,
    };

    if selected.is_empty() {
        return Err("No profiles to export.".to_string());
    }

    // Connection profiles only persist a local tunnel-profile reference. Embed
    // its metadata in the portable export so importing on another machine works.
    let mut tunnel_profile_ids = HashMap::new();
    for profile in &mut selected {
        let Some(tunnel_profile_id) = profile.ssh_tunnel_profile_id.take() else {
            continue;
        };
        let tunnel_profile =
            crate::ssh_tunnel_profiles::get_profile(&app_handle, &tunnel_profile_id)
                .map_err(|e| format!("Could not export profile {:?}: {e}", profile.name))?;
        profile.ssh_tunnel = Some(tunnel_profile.as_config());
        tunnel_profile_ids.insert(profile.id.clone(), tunnel_profile_id);
    }

    let mut secrets: HashMap<String, credentials::StoredCredentials> = HashMap::new();
    if include_secrets {
        let loaded_at = now_ms();
        for p in &selected {
            // Fail closed: vault/keyring errors must not produce a silent secrets-less export.
            let mut stored = credentials::load_stored_credentials_cached(
                &state.credential_cache,
                &p.id,
                loaded_at,
            )
            .map_err(|e| {
                format!(
                    "Failed to load credentials for profile {:?} while exporting secrets: {}",
                    p.name, e
                )
            })?;
            if let Some(tunnel_profile_id) = tunnel_profile_ids.get(&p.id) {
                stored.ssh_tunnel_password = credentials::load_ssh_tunnel_password_cached(
                    &state.credential_cache,
                    &crate::ssh_tunnel_profiles::credential_id(tunnel_profile_id),
                    loaded_at,
                )
                .map_err(|e| {
                    format!(
                        "Failed to load SSH tunnel password for profile {:?} while exporting secrets: {}",
                        p.name, e
                    )
                })?;
            }
            secrets.insert(p.id.clone(), stored);
        }
    }

    let profiles = build_export_profiles(&selected, &secrets, include_secrets);
    let exported_at = chrono::Utc::now().to_rfc3339();
    let file = build_export_file(profiles, include_secrets, exported_at);
    let json = serialize_export(&file)?;
    std::fs::write(&path, json).map_err(|e| format!("Failed to write export file: {}", e))?;
    Ok(())
}

/// Import profiles from a JSON file path and merge into config.
///
/// When the file contains secrets, `confirm_secrets` must be true (UI confirm step)
/// and `expected_content_hash` is **required** (from preview) so a swapped file
/// between preview and confirm cannot install different secrets.
/// When the file has no secrets, `expected_content_hash` remains optional — if
/// provided it must still match.
#[tauri::command]
pub async fn import_profiles(
    app_handle: AppHandleType,
    state: tauri::State<'_, GaleonEngine>,
    path: String,
    collision_strategy: String,
    confirm_secrets: Option<bool>,
    expected_content_hash: Option<String>,
) -> Result<ImportResult, String> {
    let path = validate_import_path(&path)?;
    let strategy = CollisionStrategy::parse(&collision_strategy)?;

    let raw = read_import_file_limited(&path)?;
    let hash = content_hash(&raw);

    let export = parse_export_json(&raw)?;
    if export.profiles.is_empty() {
        return Err("Import file contains no profiles.".to_string());
    }

    let preview = build_import_preview(&export, hash.clone());
    if preview.includes_secrets && !confirm_secrets.unwrap_or(false) {
        return Err(
            "Import file contains secrets. Confirm storing them in the system keyring first."
                .to_string(),
        );
    }

    // TOCTOU: secrets imports must always bind to the previewed file hash.
    // Non-secret imports keep optional hash verification when the UI supplies one.
    let expected = expected_content_hash
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    if preview.includes_secrets {
        match expected {
            Some(expected) if expected == hash => {}
            Some(_) => {
                return Err(
                    "Import file changed since preview. Choose the file again to continue."
                        .to_string(),
                );
            }
            None => {
                return Err(
                    "Content hash from preview is required when the import file includes secrets."
                        .to_string(),
                );
            }
        }
    } else if let Some(expected) = expected {
        if expected != hash {
            return Err(
                "Import file changed since preview. Choose the file again to continue.".to_string(),
            );
        }
    }

    let mut config = read_config(&app_handle)?;
    let (merged, mut result, pending, delete_ids) =
        merge_imported_profiles(config.profiles, export.profiles, strategy);

    // Order matters for rebinding safety:
    // 1) Delete stale vault entries for identity-changed overwrites FIRST so a
    //    later failure cannot leave old secrets bound to a new host/endpoint.
    // 2) Write config (profiles on disk).
    // 3) Persist any newly imported secrets.
    //
    // If step 3 fails after step 2, return Ok with a warning message so the UI
    // reloads the already-written config instead of leaving a stale form.
    if let Err(e) = delete_profile_credentials(&state, &delete_ids) {
        return Err(format!(
            "Import aborted before saving profiles: failed to clear stale credentials: {}",
            e
        ));
    }

    config.profiles = merged;
    write_config(&app_handle, &config).map_err(|e| {
        format!(
            "Failed to write profiles after clearing stale credentials: {}. Re-enter secrets for affected profiles if needed.",
            e
        )
    })?;

    if let Err(e) = persist_pending_credentials(&state, &pending) {
        result.messages.push(format!(
            "Profiles were saved, but storing some secrets failed: {}. Re-enter credentials for affected profiles.",
            e
        ));
    }

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_s3(id: &str, name: &str) -> ConnectionProfile {
        ConnectionProfile {
            id: id.to_string(),
            name: name.to_string(),
            protocol: Some("s3".to_string()),
            endpoint: Some("https://s3.example.com".to_string()),
            region: Some("us-east-1".to_string()),
            access_key: Some("AKIA".to_string()),
            secret_key: Some("secret".to_string()),
            bucket: Some("my-bucket".to_string()),
            danger_disable_ssl_verification: Some(false),
            use_virtual_host_style: None,
            storage_class: None,
            max_bandwidth: None,
            host: None,
            port: None,
            username: None,
            key_path: None,
            passive_mode: None,
            encrypt: None,
            bandwidth_rules: None,
            ssh_tunnel: None,
            ssh_tunnel_profile_id: None,
            has_saved_credentials: Some(true),
        }
    }

    fn sample_sftp(id: &str, name: &str) -> ConnectionProfile {
        ConnectionProfile {
            id: id.to_string(),
            name: name.to_string(),
            protocol: Some("sftp".to_string()),
            endpoint: None,
            region: None,
            access_key: None,
            secret_key: Some("sftp-password".to_string()),
            bucket: None,
            danger_disable_ssl_verification: None,
            use_virtual_host_style: None,
            storage_class: None,
            max_bandwidth: None,
            host: Some("ssh.example.com".to_string()),
            port: Some(22),
            username: Some("deploy".to_string()),
            key_path: None,
            passive_mode: None,
            encrypt: None,
            bandwidth_rules: None,
            ssh_tunnel: None,
            ssh_tunnel_profile_id: None,
            has_saved_credentials: Some(true),
        }
    }

    #[test]
    fn import_drops_machine_local_tunnel_profile_reference() {
        let mut profile = sample_s3("p1", "Prod");
        profile.ssh_tunnel_profile_id = Some("local-tunnel".to_string());

        let sanitized = sanitize_imported_profile(profile).unwrap();

        assert!(sanitized.ssh_tunnel_profile_id.is_none());
    }

    #[test]
    fn export_strips_secrets_by_default() {
        let profiles = vec![sample_s3("p1", "Prod")];
        let mut secrets = HashMap::new();
        secrets.insert(
            "p1".to_string(),
            credentials::StoredCredentials {
                access_key: Some("AKIA".to_string()),
                secret_key: Some("secret".to_string()),
                ssh_tunnel_password: None,
            },
        );
        let exported = build_export_profiles(&profiles, &secrets, false);
        assert!(exported[0].access_key.is_none());
        assert!(exported[0].secret_key.is_none());
        assert!(exported[0].has_saved_credentials.is_none());
        assert_eq!(exported[0].bucket.as_deref(), Some("my-bucket"));
    }

    #[test]
    fn export_includes_secrets_when_requested() {
        let profiles = vec![sample_s3("p1", "Prod")];
        let mut secrets = HashMap::new();
        secrets.insert(
            "p1".to_string(),
            credentials::StoredCredentials {
                access_key: Some("AKIA".to_string()),
                secret_key: Some("secret".to_string()),
                ssh_tunnel_password: None,
            },
        );
        let exported = build_export_profiles(&profiles, &secrets, true);
        assert_eq!(exported[0].access_key.as_deref(), Some("AKIA"));
        assert_eq!(exported[0].secret_key.as_deref(), Some("secret"));
    }

    #[test]
    fn tunnel_password_is_exported_only_when_secrets_are_requested() {
        let mut profile = sample_sftp("p1", "Tunneled");
        profile.ssh_tunnel = Some(crate::ssh_tunnel::SshTunnelConfig {
            host: "bastion.example.com".to_string(),
            port: 22,
            username: "deploy".to_string(),
            key_path: None,
            password: None,
        });
        let mut secrets = HashMap::new();
        secrets.insert(
            "p1".to_string(),
            credentials::StoredCredentials {
                access_key: None,
                secret_key: Some("storage-password".to_string()),
                ssh_tunnel_password: Some("tunnel-password".to_string()),
            },
        );

        let without = build_export_profiles(&[profile.clone()], &secrets, false);
        assert!(without[0]
            .ssh_tunnel
            .as_ref()
            .and_then(|tunnel| tunnel.password.as_ref())
            .is_none());

        let with = build_export_profiles(&[profile], &secrets, true);
        assert_eq!(
            with[0]
                .ssh_tunnel
                .as_ref()
                .and_then(|tunnel| tunnel.password.as_deref()),
            Some("tunnel-password")
        );
    }

    #[test]
    fn serialize_deserialize_round_trip() {
        let profiles = build_export_profiles(&[sample_s3("p1", "Prod")], &HashMap::new(), false);
        let file = build_export_file(profiles, false, "2026-01-01T00:00:00Z".to_string());
        let json = serialize_export(&file).unwrap();
        assert!(json.contains("galeon.profiles"));
        // Secrets must not appear as values (field names may still be omitted via skip_serializing_if).
        assert!(!json.contains("AKIA"));
        assert!(!json.contains("\"secret\""));
        let parsed = parse_export_json(&json).unwrap();
        assert_eq!(parsed.format, EXPORT_FORMAT);
        assert_eq!(parsed.profiles.len(), 1);
        assert_eq!(parsed.profiles[0].name, "Prod");
        assert!(parsed.profiles[0].access_key.is_none());
        assert!(parsed.profiles[0].secret_key.is_none());
    }

    #[test]
    fn parse_bare_profiles_array() {
        let json = r#"[{"id":"x","name":"From Array","protocol":"s3","bucket":"b"}]"#;
        let parsed = parse_export_json(json).unwrap();
        assert_eq!(parsed.profiles.len(), 1);
        assert_eq!(parsed.profiles[0].name, "From Array");
    }

    #[test]
    fn parse_config_like_object() {
        let json = r#"{"profiles":[{"id":"x","name":"Cfg","protocol":"s3","bucket":"b"}],"presignHistory":[]}"#;
        let parsed = parse_export_json(json).unwrap();
        assert_eq!(parsed.profiles[0].name, "Cfg");
    }

    #[test]
    fn parse_rejects_empty_and_garbage() {
        assert!(parse_export_json("").is_err());
        assert!(parse_export_json("   ").is_err());
        assert!(parse_export_json("not-json").is_err());
        assert!(parse_export_json(r#"{"foo":1}"#).is_err());
    }

    #[test]
    fn parse_rejects_unknown_format() {
        let json = r#"{"format":"other","version":1,"profiles":[]}"#;
        assert!(parse_export_json(json).is_err());
    }

    #[test]
    fn parse_rejects_unknown_format_on_fallback_path() {
        // Missing version so ProfileExportFile deserialize may fail; format must still be enforced.
        let json = r#"{"format":"evil.app","profiles":[{"id":"x","name":"X","protocol":"s3","bucket":"b"}]}"#;
        let err = parse_export_json(json).unwrap_err();
        assert!(err.to_lowercase().contains("format"), "err={err}");
    }

    #[test]
    fn merge_skip_on_name_collision() {
        let existing = vec![sample_s3("e1", "Prod")];
        let imported = vec![sample_s3("i1", "Prod"), sample_s3("i2", "Staging")];
        let (merged, result, pending, delete_ids) =
            merge_imported_profiles(existing, imported, CollisionStrategy::Skip);
        assert_eq!(merged.len(), 2);
        assert_eq!(result.skipped, 1);
        assert_eq!(result.imported, 1);
        assert_eq!(pending.len(), 1); // only Staging
        assert!(delete_ids.is_empty());
        assert_eq!(merged[1].name, "Staging");
        assert_ne!(merged[1].id, "i2"); // fresh id
    }

    #[test]
    fn merge_overwrite_keeps_existing_id() {
        let existing = vec![sample_s3("e1", "Prod")];
        let mut imported = sample_s3("i1", "Prod");
        imported.bucket = Some("new-bucket".to_string());
        imported.access_key = Some("NEWAK".to_string());
        imported.secret_key = Some("newsecret".to_string());
        let (merged, result, pending, delete_ids) =
            merge_imported_profiles(existing, vec![imported], CollisionStrategy::Overwrite);
        assert_eq!(merged.len(), 1);
        assert_eq!(result.overwritten, 1);
        assert_eq!(result.imported, 0); // overwrite is not counted as imported
        assert_eq!(merged[0].id, "e1");
        assert_eq!(merged[0].bucket.as_deref(), Some("new-bucket"));
        assert!(merged[0].access_key.is_none()); // stripped for config
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].profile_id, "e1");
        assert_eq!(pending[0].access_key.as_deref(), Some("NEWAK"));
        // Replace = delete-then-insert so a failed persist cannot rebind old secrets.
        assert_eq!(delete_ids, vec!["e1".to_string()]);
    }

    #[test]
    fn merge_overwrite_with_secrets_queues_delete_even_when_identity_same() {
        // Same host/bucket; secrets present → still queue delete so replace is atomic.
        let existing = sample_s3("e1", "Prod");
        let imported = sample_s3("i1", "Prod");
        let (merged, result, pending, delete_ids) =
            merge_imported_profiles(vec![existing], vec![imported], CollisionStrategy::Overwrite);
        assert_eq!(result.overwritten, 1);
        assert_eq!(merged[0].id, "e1");
        assert_eq!(pending.len(), 1);
        assert_eq!(delete_ids, vec!["e1".to_string()]);
        assert_eq!(merged[0].has_saved_credentials, Some(true));
    }

    #[test]
    fn merge_overwrite_without_secrets_preserves_flag_when_identity_same() {
        let mut existing = sample_s3("e1", "Prod");
        existing.access_key = None;
        existing.secret_key = None;
        existing.has_saved_credentials = Some(true);

        let mut imported = sample_s3("i1", "Prod");
        imported.access_key = None;
        imported.secret_key = None;
        // same identity fields; only region metadata changes
        imported.region = Some("eu-west-1".to_string());

        let (merged, result, pending, delete_ids) =
            merge_imported_profiles(vec![existing], vec![imported], CollisionStrategy::Overwrite);
        assert_eq!(result.overwritten, 1);
        assert!(pending.is_empty());
        assert!(delete_ids.is_empty());
        assert_eq!(merged[0].has_saved_credentials, Some(true));
        assert_eq!(merged[0].region.as_deref(), Some("eu-west-1"));
        assert_eq!(merged[0].id, "e1");
    }

    #[test]
    fn merge_overwrite_without_secrets_deletes_vault_when_identity_changes() {
        let mut existing = sample_s3("e1", "Prod");
        existing.access_key = None;
        existing.secret_key = None;
        existing.has_saved_credentials = Some(true);

        let mut imported = sample_s3("i1", "Prod");
        imported.access_key = None;
        imported.secret_key = None;
        imported.endpoint = Some("https://evil.example.com".to_string());
        imported.bucket = Some("other-bucket".to_string());

        let (merged, result, pending, delete_ids) =
            merge_imported_profiles(vec![existing], vec![imported], CollisionStrategy::Overwrite);
        assert_eq!(result.overwritten, 1);
        assert!(pending.is_empty());
        assert_eq!(delete_ids, vec!["e1".to_string()]);
        assert_eq!(merged[0].has_saved_credentials, Some(false));
        assert_eq!(
            merged[0].endpoint.as_deref(),
            Some("https://evil.example.com")
        );
    }

    #[test]
    fn merge_overwrite_protocol_change_without_secrets_clears_vault() {
        let mut existing = sample_s3("e1", "Prod");
        existing.access_key = None;
        existing.secret_key = None;
        existing.has_saved_credentials = Some(true);

        let mut imported = sample_sftp("i1", "Prod");
        imported.secret_key = None; // no password in file

        let (merged, _result, pending, delete_ids) =
            merge_imported_profiles(vec![existing], vec![imported], CollisionStrategy::Overwrite);
        assert!(pending.is_empty());
        assert_eq!(delete_ids, vec!["e1".to_string()]);
        assert_eq!(merged[0].has_saved_credentials, Some(false));
        assert_eq!(merged[0].protocol.as_deref(), Some("sftp"));
    }

    #[test]
    fn partial_s3_secrets_are_not_pending() {
        let mut p = sample_s3("x", "Partial");
        p.secret_key = None;
        assert!(extract_pending_credentials(&p).is_none());
        p.secret_key = Some("sk".to_string());
        p.access_key = None;
        assert!(extract_pending_credentials(&p).is_none());
        p.access_key = Some("ak".to_string());
        assert!(extract_pending_credentials(&p).is_some());
    }

    #[test]
    fn merge_rename_on_collision() {
        let existing = vec![sample_s3("e1", "Prod")];
        let imported = vec![sample_s3("i1", "Prod")];
        let (merged, result, _pending, _delete_ids) =
            merge_imported_profiles(existing, imported, CollisionStrategy::Rename);
        assert_eq!(merged.len(), 2);
        assert_eq!(result.renamed, 1);
        assert_eq!(result.imported, 1);
        assert_eq!(merged[1].name, "Prod (imported)");
        assert_ne!(merged[1].id, "i1");
        assert_ne!(merged[1].id, "e1");
    }

    #[test]
    fn sanitize_rejects_empty_name_and_bad_bucket() {
        let mut p = sample_s3("x", "  ");
        assert!(sanitize_imported_profile(p.clone()).is_err());
        p.name = "Ok".to_string();
        p.bucket = Some("bad bucket".to_string());
        assert!(sanitize_imported_profile(p.clone()).is_err());
        p.bucket = None;
        assert!(sanitize_imported_profile(p).is_err());
    }

    #[test]
    fn sanitize_sftp_requires_host() {
        let mut p = sample_sftp("x", "Box");
        p.host = None;
        assert!(sanitize_imported_profile(p).is_err());
    }

    #[test]
    fn sanitize_cleans_s3_paste_junk() {
        let mut p = sample_s3("x", "  Prod  ");
        p.endpoint = Some("  \"https://s3.example.com\"  ".to_string());
        p.bucket = Some("  my-bucket  ".to_string());
        p.access_key = Some("  AKIA  ".to_string());
        let clean = sanitize_imported_profile(p).unwrap();
        assert_eq!(clean.name, "Prod");
        assert_eq!(clean.endpoint.as_deref(), Some("https://s3.example.com"));
        assert_eq!(clean.bucket.as_deref(), Some("my-bucket"));
        assert_eq!(clean.access_key.as_deref(), Some("AKIA"));
    }

    #[test]
    fn sanitize_clears_ssl_bypass_on_import() {
        let mut p = sample_s3("x", "Insecure");
        p.danger_disable_ssl_verification = Some(true);
        let clean = sanitize_imported_profile(p).unwrap();
        assert_eq!(clean.danger_disable_ssl_verification, Some(false));
    }

    #[test]
    fn collision_strategy_parse() {
        assert_eq!(
            CollisionStrategy::parse("rename").unwrap(),
            CollisionStrategy::Rename
        );
        assert!(CollisionStrategy::parse("explode").is_err());
    }

    #[test]
    fn connection_identity_detects_endpoint_change() {
        let a = sample_s3("a", "P");
        let mut b = sample_s3("b", "P");
        b.endpoint = Some("https://other.example.com".to_string());
        assert!(connection_identity_changed(&a, &b));
        assert!(!connection_identity_changed(&a, &a));
    }

    #[test]
    fn connection_identity_detects_ssh_bastion_change() {
        let mut a = sample_s3("a", "P");
        a.ssh_tunnel = Some(crate::ssh_tunnel::SshTunnelConfig {
            host: "bastion-a.example.com".to_string(),
            port: 22,
            username: "deploy".to_string(),
            key_path: None,
            password: None,
        });
        let mut b = a.clone();
        b.ssh_tunnel.as_mut().unwrap().host = "bastion-b.example.com".to_string();
        assert!(connection_identity_changed(&a, &b));
    }

    #[test]
    fn sanitize_imported_profile_cleans_ssh_tunnel_metadata() {
        let mut p = sample_sftp("x", "Box");
        p.ssh_tunnel = Some(crate::ssh_tunnel::SshTunnelConfig {
            host: "  bastion.example.com  ".to_string(),
            port: 22,
            username: "  deploy  ".to_string(),
            key_path: None,
            password: None,
        });
        let clean = sanitize_imported_profile(p).unwrap();
        let tunnel = clean.ssh_tunnel.unwrap();
        assert_eq!(tunnel.host, "bastion.example.com");
        assert_eq!(tunnel.username, "deploy");
    }

    #[test]
    fn sanitize_imported_profile_rejects_ftp_tunnel() {
        let mut p = sample_sftp("x", "Box");
        p.protocol = Some("ftp".to_string());
        p.ssh_tunnel = Some(crate::ssh_tunnel::SshTunnelConfig {
            host: "bastion.example.com".to_string(),
            port: 22,
            username: "deploy".to_string(),
            key_path: None,
            password: None,
        });
        let err = sanitize_imported_profile(p).unwrap_err();
        assert!(err.contains("not supported for FTP/FTPS"));
    }
}
