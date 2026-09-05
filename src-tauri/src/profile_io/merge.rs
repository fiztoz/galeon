// Merge policy — how imported profiles collide with, replace, or rebind existing ones.

use super::*;

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

pub(crate) fn unique_import_name(base: &str, taken: &HashSet<String>) -> String {
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

pub(crate) fn profile_for_config(
    mut profile: ConnectionProfile,
    has_creds: bool,
) -> ConnectionProfile {
    profile.access_key = None;
    profile.secret_key = None;
    if let Some(tunnel) = profile.ssh_tunnel.as_mut() {
        tunnel.password = None;
    }
    profile.has_saved_credentials = Some(has_creds);
    profile
}

pub(crate) fn queue_credential_delete(delete_ids: &mut Vec<String>, profile_id: &str) {
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
