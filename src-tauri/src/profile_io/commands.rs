// The three Tauri commands. Thin: validate, call the domain fn, map errors.

use super::*;

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
