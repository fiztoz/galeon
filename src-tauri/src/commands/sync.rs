// One-way sync: diff, plan, execute, and scheduled profiles.

use crate::*;

/// Compute a one-way sync plan between a local directory and a remote prefix.
/// READ-ONLY: walks both trees and runs the pure planner; performs NO transfers.
///
/// `direction` ∈ { "localToRemote", "remoteToLocal" }.
///
/// Checksum refinement: when `options.verify_checksum` is set on an **S3**
/// session, same-size candidates the size+mtime pass treated as `identical` or
/// `newer` are re-decided against the remote ETag via `verify_integrity` (no
/// download — the ETag is the checksum). SFTP/FTP expose no server checksum, so
/// they keep the size+mtime decision (documented on `compute_sync_plan`).
#[tauri::command]
pub async fn compute_sync_diff(
    state: tauri::State<'_, GaleonEngine>,
    session_id: String,
    local_path: String,
    remote_prefix: String,
    direction: String,
    options: SyncOptions,
) -> Result<Vec<SyncPlanEntry>, String> {
    if direction != DIR_LOCAL_TO_REMOTE && direction != DIR_REMOTE_TO_LOCAL {
        return Err(format!("Invalid sync direction: {}", direction));
    }
    if local_path.contains("..") || remote_prefix.contains("..") {
        return Err("Path traversal detected".to_string());
    }

    let sessions = state.active_sessions.read().await;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| "Active session not found".to_string())?
        .clone();
    drop(sessions);

    let local = walk_local_tree(std::path::Path::new(&local_path)).await?;
    let remote = walk_remote_tree(&session, &remote_prefix).await?;

    let mut plan = compute_sync_plan(&local, &remote, &direction, &options);

    // Deepen ambiguous same-size decisions with a real checksum compare (S3 only).
    if options.verify_checksum {
        if let StorageSession::OpenDAL(op) = &session {
            refine_plan_with_checksums(op, &mut plan, &local_path, &remote_prefix, &direction)
                .await;
        }
    }

    Ok(plan)
}

/// Execute a previously-computed (and user-confirmed) sync plan. For each
/// non-skip entry it reuses the existing transfer pipeline:
///   - `upload`       → `initiate_upload`
///   - `download`     → `initiate_download`
///   - `deleteRemote` → `delete_object` (only when `delete_extraneous`)
///   - `deleteLocal`  → `std::fs::remove_file` (only when `delete_extraneous`)
///
/// Emits `sync-progress` with `{ done, total }` (camelCase) after each item.
///
/// CONTRACT NOTE: `SyncPlanEntry` carries only a `relative_path`, so to turn it
/// into an absolute local path and a remote key the roots must travel too. This
/// command therefore takes `local_path` and `remote_prefix` (the same values
/// passed to `compute_sync_diff`) in addition to the documented
/// `(session_id, plan, delete_extraneous)`. The frontend MUST pass them.
///
/// Error handling: CONTINUE-ON-ERROR. Each item's failure is collected and the
/// run proceeds to completion; successful items remain applied. Note that
/// `upload`/`download` are enqueued asynchronously via the existing transfer
/// pipeline (so the TransferManager UI, pause/resume/cancel, retry, and the
/// integrity-verify step all apply); a per-item "error" here only reflects
/// failure to ENQUEUE, not the eventual transfer outcome (which surfaces via the
/// usual `transfer-failed` events). Deletes are synchronous and their failures
/// are reported directly.
///
/// On success, returns the number of sync items that failed (0 if everything
/// succeeded). A non-zero success value means the plan ran to completion but
/// individual transfers failed; the caller can surface the count without
/// parsing an error string.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn execute_sync_plan(
    app_handle: AppHandleType,
    state: tauri::State<'_, GaleonEngine>,
    session_id: String,
    plan: Vec<SyncPlanEntry>,
    delete_extraneous: bool,
    local_path: String,
    remote_prefix: String,
    profile_id: Option<String>,
) -> Result<u32, String> {
    use tauri::Emitter;

    if is_unsafe_root_path(&local_path) || is_unsafe_root_path(&remote_prefix) {
        return Err("Path traversal detected".to_string());
    }

    let total = plan.iter().filter(|e| e.action != "skip").count() as u64;
    let mut done: u64 = 0;
    let mut failures: Vec<String> = Vec::new();

    for entry in &plan {
        if entry.action == "skip" {
            continue;
        }
        if is_unsafe_relative_path(&entry.relative_path) {
            failures.push(format!("{}: path traversal detected", entry.relative_path));
            done += 1;
            let _ = app_handle.emit(
                "sync-progress",
                serde_json::json!({ "done": done, "total": total }),
            );
            continue;
        }

        let abs_local = std::path::Path::new(&local_path)
            .join(&entry.relative_path)
            .to_string_lossy()
            .to_string();
        let remote_key = join_remote_key(&remote_prefix, &entry.relative_path);

        let result: Result<(), String> = match entry.action.as_str() {
            "upload" => initiate_upload(
                state.clone(),
                app_handle.clone(),
                session_id.clone(),
                abs_local,
                remote_key,
                profile_id.clone(),
            )
            .await
            .map(|_| ()),
            "download" => {
                // Ensure the destination directory exists before downloading.
                if let Some(parent) = std::path::Path::new(&abs_local).parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                initiate_download(
                    state.clone(),
                    app_handle.clone(),
                    session_id.clone(),
                    remote_key,
                    abs_local,
                    profile_id.clone(),
                )
                .await
                .map(|_| ())
            }
            "deleteRemote" => {
                if delete_extraneous {
                    delete_object(state.clone(), session_id.clone(), remote_key, false).await
                } else {
                    Ok(())
                }
            }
            "deleteLocal" => {
                if delete_extraneous {
                    std::fs::remove_file(&abs_local)
                        .map_err(|e| format!("Failed to delete local file: {}", e))
                } else {
                    Ok(())
                }
            }
            other => Err(format!("Unknown sync action: {}", other)),
        };

        if let Err(e) = result {
            failures.push(format!("{}: {}", entry.relative_path, e));
        }

        done += 1;
        let _ = app_handle.emit(
            "sync-progress",
            serde_json::json!({ "done": done, "total": total }),
        );
    }

    Ok(failures.len() as u32)
}

/// List saved sync profiles.
#[tauri::command]
pub async fn get_sync_profiles(app_handle: AppHandleType) -> Result<Vec<SyncProfile>, String> {
    Ok(read_sync_profiles(&app_handle)?.profiles)
}

/// Create or update a sync profile (matched by id).
#[tauri::command]
pub async fn save_sync_profile(
    app_handle: AppHandleType,
    mut profile: SyncProfile,
) -> Result<(), String> {
    if let Some(ref mut sched) = profile.schedule {
        // Always recompute next_run_ms when the schedule is enabled,
        // so parameter changes (frequency, at_hour, at_minute, day_of_week)
        // take effect on the next save rather than waiting until the old
        // next_run_ms expires.
        if sched.enabled {
            sched.next_run_ms = Some(compute_next_run_ms(now_ms(), sched));
        }
    }
    let mut store = read_sync_profiles(&app_handle)?;
    if let Some(existing) = store.profiles.iter_mut().find(|p| p.id == profile.id) {
        *existing = profile;
    } else {
        store.profiles.push(profile);
    }
    write_sync_profiles(&app_handle, &store)
}

/// Run a saved sync profile immediately (same pipeline as the scheduler).
#[tauri::command]
pub async fn run_sync_profile_now(
    app_handle: AppHandleType,
    profile_id: String,
) -> Result<(), String> {
    let store = read_sync_profiles(&app_handle)?;
    let profile = store
        .profiles
        .iter()
        .find(|p| p.id == profile_id)
        .ok_or_else(|| format!("Sync profile not found: {}", profile_id))?
        .clone();

    let failures = run_sync_profile_internal(&app_handle, &profile).await?;

    let mut store = read_sync_profiles(&app_handle)?;
    if let Some(p) = store.profiles.iter_mut().find(|p| p.id == profile_id) {
        p.last_run_ms = Some(now_ms());
    }
    write_sync_profiles(&app_handle, &store)?;

    if failures > 0 {
        return Err(format!("{} sync item(s) failed", failures));
    }
    Ok(())
}

/// Delete a sync profile by id.
#[tauri::command]
pub async fn delete_sync_profile(
    app_handle: AppHandleType,
    profile_id: String,
) -> Result<(), String> {
    let mut store = read_sync_profiles(&app_handle)?;
    store.profiles.retain(|p| p.id != profile_id);
    write_sync_profiles(&app_handle, &store)
}

/// Build a connection profile with credentials loaded from the session cache or
/// keyring for a scheduled or manual sync run.
pub(crate) fn build_connection_for_sync(
    cache: &credentials::CredentialCache,
    conn_template: &ConnectionProfile,
) -> Result<(ConnectionProfile, Option<String>), String> {
    let protocol = conn_template.protocol.as_deref().unwrap_or("s3");
    let (access, secret) =
        credentials::load_credentials_cached(cache, &conn_template.id, now_ms())?;

    match protocol {
        "s3" => {
            let mut p = conn_template.clone();
            p.access_key = access;
            p.secret_key = secret;
            Ok((p, None))
        }
        "sftp" => {
            if conn_template
                .key_path
                .as_ref()
                .is_some_and(|k| !k.is_empty())
            {
                Ok((conn_template.clone(), None))
            } else {
                Ok((conn_template.clone(), secret.or(access)))
            }
        }
        "ftp" | "ftps" => Ok((conn_template.clone(), secret.or(access))),
        other => Err(format!(
            "Unsupported protocol: {}. Use 's3', 'sftp', 'ftp', or 'ftps'.",
            other
        )),
    }
}

/// Run a sync profile end-to-end: connect, diff, execute. Returns the number
/// of failed sync items (0 on full success).
pub(crate) async fn run_sync_profile_internal(
    app_handle: &AppHandleType,
    profile: &SyncProfile,
) -> Result<u32, String> {
    let state = app_handle.state::<GaleonEngine>();

    let config = read_config(app_handle)?;
    let conn_template = config
        .profiles
        .iter()
        .find(|p| p.id == profile.connection_profile_id)
        .ok_or_else(|| {
            format!(
                "Connection profile not found: {}",
                profile.connection_profile_id
            )
        })?;

    let (conn_profile, password) =
        build_connection_for_sync(&state.credential_cache, conn_template)?;
    let ssh_tunnel_password = credentials::load_ssh_tunnel_password_cached(
        &state.credential_cache,
        &conn_template.id,
        now_ms(),
    )?;
    let session_id = connect_storage(
        app_handle.clone(),
        state.clone(),
        conn_profile,
        password,
        ssh_tunnel_password,
    )
    .await?;

    let options = SyncOptions {
        verify_checksum: profile.verify_checksum,
        delete_extraneous: profile.delete_extraneous,
    };
    let plan = compute_sync_diff(
        state.clone(),
        session_id.clone(),
        profile.local_path.clone(),
        profile.remote_prefix.clone(),
        profile.direction.clone(),
        options,
    )
    .await?;

    // Execute the sync plan; ensure the session is removed from active_sessions
    // on both success and error paths to avoid a session leak.
    let failure_count = execute_sync_plan(
        app_handle.clone(),
        state.clone(),
        session_id.clone(),
        plan,
        profile.delete_extraneous,
        profile.local_path.clone(),
        profile.remote_prefix.clone(),
        Some(profile.connection_profile_id.clone()),
    )
    .await?;

    // Clean up the session from active_sessions to prevent leaks.
    state.active_sessions.write().await.remove(&session_id);
    remove_s3_session_config(&state, &session_id).await;

    Ok(failure_count)
}
