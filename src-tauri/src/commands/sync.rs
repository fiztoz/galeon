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

    // `walk_local_tree` treats a missing root as an empty tree so a first-time
    // remoteToLocal download into a new folder works. That is only ever correct
    // when the LOCAL side is the destination. For localToRemote the local root
    // is the source: a missing one means an unmounted volume or a typo, and
    // reporting "0 files to upload" would hide a broken profile until a
    // scheduled run tried to delete the whole remote prefix.
    if direction == DIR_LOCAL_TO_REMOTE && !std::path::Path::new(&local_path).exists() {
        return Err(format!("Local folder does not exist: {}", local_path));
    }

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
/// What a sync run actually did, as opposed to what it was asked to do.
///
/// Returned instead of a bare failure count so the caller can record a run log:
/// the deletion count and the deleted paths are the part a user needs if a
/// scheduled run surprises them.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncRunOutcome {
    pub uploads: u32,
    pub downloads: u32,
    /// Permanent, unrecoverable deletions performed.
    pub deletes: u32,
    /// The relative paths that were deleted, so the caller can write a run log
    /// entry. On the outcome rather than in engine state: the caller already
    /// receives it, and a second channel through shared state is one more thing
    /// to get right when two syncs can overlap.
    pub deleted_paths: Vec<String>,
    /// One entry per failed item, "<relative path>: <error>".
    pub failures: Vec<String>,
}

/// On success, returns what the run actually did. `failures` empty means the
/// whole plan completed; non-empty means it ran to completion with individual
/// items failing.
///
/// Manual runs record themselves to the sync run history (trigger "manual")
/// with the outcome they got. `sync_profile_id` / `sync_profile_name` carry
/// the saved profile the panel attributes the run to, as sent by the UI when
/// the form still matches the loaded profile; the internal profile pipeline
/// must NOT pass them — it records its own run. Ad-hoc manual runs (no
/// attribution) record under the generic name "Manual sync". A plan with no
/// entries executes nothing, changes nothing, and is not recorded.
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
    sync_profile_id: Option<String>,
    sync_profile_name: Option<String>,
) -> Result<SyncRunOutcome, String> {
    use tauri::Emitter;

    let started_at_ms = now_ms();

    if is_unsafe_root_path(&local_path) || is_unsafe_root_path(&remote_prefix) {
        return Err("Path traversal detected".to_string());
    }

    // The plan arrives from the frontend. Every entry carries the direction it
    // was computed for; a plan whose entries disagree was not produced by our
    // planner, so refuse it rather than resolving deletes against mismatched
    // roots. Cheap coherence check — it is not a substitute for re-deriving the
    // plan from the two trees, but it catches a plan assembled from two diffs.
    // An empty plan is directionless; it also produces no history row below.
    let plan_direction = match plan_coherent_direction(&plan) {
        Some(Some(direction)) => Some(direction),
        Some(None) => {
            return Err("Sync plan mixes directions; recompute the diff.".to_string());
        }
        None => None,
    };

    let total = plan.iter().filter(|e| e.action != "skip").count() as u64;
    let mut done: u64 = 0;
    let mut failures: Vec<String> = Vec::new();
    // Recorded so the caller can build a run log entry: deletions are permanent
    // and unrecoverable, so the user needs to know which paths went.
    let mut deleted_paths: Vec<String> = Vec::new();
    let mut uploads = 0u32;
    let mut downloads = 0u32;
    let mut deletes = 0u32;
    // Transfers started by this run, as (id, relative path, direction).
    //
    // `initiate_upload` / `initiate_download` spawn and return immediately, so
    // without collecting these the command would report success before a single
    // byte moved. The path and direction are kept so a failure surfaced by
    // `await_transfers` can be attributed back to the right counter: counting an
    // upload as done at ENQUEUE time would report a failed upload as a success,
    // because enqueueing succeeds for a file that turns out to be unreadable.
    let mut started: Vec<(String, String, &'static str)> = Vec::new();

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
            .map(|id| started.push((id, entry.relative_path.clone(), "upload"))),
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
                .map(|id| started.push((id, entry.relative_path.clone(), "download")))
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

        match result {
            Ok(()) => match entry.action.as_str() {
                // Counted provisionally; a transfer that later fails is
                // subtracted by the attribution below.
                "upload" => uploads += 1,
                "download" => downloads += 1,
                // Only count a delete that actually ran: with
                // `delete_extraneous` off these are no-ops that return Ok.
                "deleteRemote" | "deleteLocal" if delete_extraneous => {
                    deletes += 1;
                    deleted_paths.push(entry.relative_path.clone());
                }
                _ => {}
            },
            Err(e) => failures.push(format!("{}: {}", entry.relative_path, e)),
        }

        done += 1;
        let _ = app_handle.emit(
            "sync-progress",
            serde_json::json!({ "done": done, "total": total }),
        );
    }

    // Everything above only proves the transfers were QUEUED. Wait for the real
    // outcomes so the returned failure count — and the schedule-run record the
    // caller derives from it — reflects what actually happened.
    //
    // The transfers themselves already run concurrently (each was spawned by
    // `initiate_*`), so awaiting them here costs no throughput; it only delays
    // the report until the work is done.
    let ids: Vec<String> = started.iter().map(|(id, _, _)| id.clone()).collect();
    for failed_id in await_transfers(&app_handle, ids).await {
        let (_, rel_path, dir) = started
            .iter()
            .find(|(id, _, _)| *id == failed_id.0)
            .map(|(_, p, d)| (failed_id.0.clone(), p.clone(), *d))
            .unwrap_or((failed_id.0.clone(), String::from("?"), "unknown"));
        // The upload was counted when enqueued; it did not succeed.
        match dir {
            "upload" => uploads = uploads.saturating_sub(1),
            "download" => downloads = downloads.saturating_sub(1),
            _ => {}
        }
        failures.push(format!("{}: transfer failed ({})", rel_path, failed_id.1));
    }

    let outcome = SyncRunOutcome {
        uploads,
        downloads,
        deletes,
        deleted_paths,
        failures,
    };

    // The manual run's history row — the same record the internal profile
    // pipeline would write, with the trigger this run actually had. A failed
    // run also records: the question "what did that run do to my destination"
    // matters more when something went wrong, not less.
    if let Some(direction) = plan_direction {
        let record = sync_log::build_run_record(
            sync_profile_id.as_deref().unwrap_or_default(),
            sync_profile_name.as_deref().unwrap_or("Manual sync"),
            &direction,
            "manual",
            started_at_ms,
            now_ms(),
            &outcome,
            outcome.deleted_paths.clone(),
            None,
        );
        if let Err(e) = sync_log::record_sync_run(&app_handle, record).await {
            // Never fail a completed run because its history could not be written.
            eprintln!("sync: failed to record manual run log: {}", e);
        }
    }

    Ok(outcome)
}

/// `Some(None)` when a plan's entries disagree about direction, `Some(Some(d))`
/// when they agree, `None` for an empty plan. Pure — unit-tested.
fn plan_coherent_direction(plan: &[SyncPlanEntry]) -> Option<Option<String>> {
    let mut iter = plan.iter().map(|e| e.direction.as_str());
    let first = iter.next()?;
    Some(if iter.all(|d| d == first) {
        Some(first.to_string())
    } else {
        None
    })
}

/// How long to wait for this run's transfers before giving up and reporting
/// whatever is still outstanding as a failure.
const SYNC_TRANSFER_WAIT_TIMEOUT_SECS: u64 = 60 * 60; // an hour for a whole sync

/// Wait for every transfer started by this run to reach a terminal state.
///
/// The transfer queue is the correlation point: `initiate_*` returns a transfer
/// id and `finalize_transfer_job` moves that id's queue entry to
/// completed/failed/cancelled. Event correlation by remote key is not used here
/// because a background transfer on the same key would be indistinguishable.
///
/// Returns `(id, remote_key)` for each transfer that failed, was cancelled, or
/// never finished before the timeout.
async fn await_transfers(app_handle: &AppHandleType, ids: Vec<String>) -> Vec<(String, String)> {
    if ids.is_empty() {
        return Vec::new();
    }
    let mut outstanding: std::collections::HashSet<String> = ids.iter().cloned().collect();
    let mut failed: Vec<(String, String)> = Vec::new();
    let start = std::time::Instant::now();

    while !outstanding.is_empty() {
        if start.elapsed().as_secs() > SYNC_TRANSFER_WAIT_TIMEOUT_SECS {
            for id in outstanding {
                failed.push((id, String::from("timed out")));
            }
            break;
        }
        let queue = match get_transfer_queue(app_handle.clone()).await {
            Ok(q) => q,
            Err(e) => {
                failed.push((
                    String::from("-"),
                    format!("transfer queue unreadable: {}", e),
                ));
                break;
            }
        };
        for entry in &queue.entries {
            if !outstanding.contains(&entry.id) {
                continue;
            }
            match entry.status.as_str() {
                "completed" => {
                    outstanding.remove(&entry.id);
                }
                "failed" | "cancelled" => {
                    outstanding.remove(&entry.id);
                    failed.push((
                        entry.id.clone(),
                        entry.error.clone().unwrap_or_else(|| entry.status.clone()),
                    ));
                }
                _ => {}
            }
        }
        if !outstanding.is_empty() {
            tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        }
    }

    failed
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
    // Under the store lock so a scheduler write landing mid-run cannot revert
    // this edit (see `update_sync_profile`). The lock is released before this
    // command returns; nothing long-running happens under it.
    let _lock = sync_store::SYNC_STORE_LOCK.lock().await;
    let mut store = read_sync_profiles(&app_handle)?;
    if let Some(existing) = store.profiles.iter_mut().find(|p| p.id == profile.id) {
        *existing = profile;
    } else {
        store.profiles.push(profile);
    }
    write_sync_profiles(&app_handle, &store)
}

/// Delete a sync profile by id.
#[tauri::command]
pub async fn delete_sync_profile(
    app_handle: AppHandleType,
    profile_id: String,
) -> Result<(), String> {
    let _lock = sync_store::SYNC_STORE_LOCK.lock().await;
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
        // HTTP storage protocols share the single-secret model: WebDAV's password
        // and Azure's account key live in the secret slot; GCS normally needs no
        // secret at all because its credential is a file path (credential_path).
        "webdav" | "azure" | "gcs" => Ok((conn_template.clone(), secret.or(access))),
        other => Err(format!(
            "Unsupported protocol: {}. Use 's3', 'sftp', 'ftp', 'ftps', 'webdav', 'azure', or 'gcs'.",
            other
        )),
    }
}

/// Run a sync profile end-to-end: connect, diff, budget, execute.
///
/// Returns the finished `SyncRunRecord`, so the scheduler can emit the
/// outcome — including a budget refusal — in its `schedule-run-complete`
/// event, exactly as the history now records it.
pub(crate) async fn run_sync_profile_internal(
    app_handle: &AppHandleType,
    profile: &SyncProfile,
    trigger: SyncTrigger,
) -> Result<SyncRunRecord, String> {
    let mut deletes_blocked: Option<BlockedDeletes> = None;
    let state = app_handle.state::<GaleonEngine>();
    let started_at_ms = now_ms();

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
    let mut plan = compute_sync_diff(
        state.clone(),
        session_id.clone(),
        profile.local_path.clone(),
        profile.remote_prefix.clone(),
        profile.direction.clone(),
        options,
    )
    .await?;

    // Unattended runs are bound by the profile's delete budget; nothing else
    // consults it. All-or-nothing by design: a run over budget deletes
    // NOTHING, so "scheduled deletes at most N" stays literally true, and a
    // partially-mirrored destination (which no one could reconstruct from the
    // run result) cannot happen. Manual runs execute the diff as-is.
    let execute_deletes = match trigger {
        SyncTrigger::Manual => profile.delete_extraneous,
        SyncTrigger::Schedule => {
            let (budgeted, blocked) = apply_delete_budget(plan, profile.max_scheduled_deletes);
            plan = budgeted;
            deletes_blocked = blocked;
            profile.delete_extraneous && deletes_blocked.is_none()
        }
    };

    // Execute the sync plan; ensure the session is removed from active_sessions
    // on both success and error paths to avoid a session leak.
    let outcome = execute_sync_plan(
        app_handle.clone(),
        state.clone(),
        session_id.clone(),
        plan,
        execute_deletes,
        profile.local_path.clone(),
        profile.remote_prefix.clone(),
        Some(profile.connection_profile_id.clone()),
        // No manual-run attribution: this pipeline records its own run (the
        // scheduled record carries the budget outcome). Passing one here
        // would double-write the history.
        None,
        None,
    )
    .await?;

    // Clean up the session from active_sessions to prevent leaks.
    state.active_sessions.write().await.remove(&session_id);
    remove_s3_session_config(&state, &session_id).await;

    // Record what actually happened, including every deleted path. An
    // unattended run that removed files is otherwise invisible once the app is
    // closed — and the scheduler is exactly where deletions happen without a
    // user watching.
    let record = sync_log::build_run_record(
        &profile.id,
        &profile.name,
        &profile.direction,
        trigger.as_str(),
        started_at_ms,
        now_ms(),
        &outcome,
        outcome.deleted_paths.clone(),
        deletes_blocked,
    );
    if let Err(e) = sync_log::record_sync_run(app_handle, record.clone()).await {
        // Never fail a completed run because its history could not be written.
        eprintln!("sync: failed to record run log: {}", e);
    }

    Ok(record)
}

#[cfg(test)]
mod tests {
    use super::plan_coherent_direction;
    use crate::{SyncPlanEntry, DIR_LOCAL_TO_REMOTE, DIR_REMOTE_TO_LOCAL};

    fn entry(direction: &str) -> SyncPlanEntry {
        SyncPlanEntry {
            relative_path: "f".into(),
            action: "upload".into(),
            reason: "new".into(),
            local_size: Some(1),
            remote_size: None,
            local_modified: None,
            remote_modified: None,
            direction: direction.into(),
        }
    }

    #[test]
    fn an_empty_plan_has_no_direction() {
        assert!(plan_coherent_direction(&[]).is_none());
    }

    #[test]
    fn a_plan_whose_entries_agree_is_coherent() {
        let plan = vec![entry(DIR_LOCAL_TO_REMOTE), entry(DIR_LOCAL_TO_REMOTE)];
        assert_eq!(
            plan_coherent_direction(&plan),
            Some(Some(DIR_LOCAL_TO_REMOTE.to_string()))
        );
    }

    #[test]
    fn a_plan_that_mixes_directions_is_rejected() {
        // Can only happen if a plan was assembled from two separate diffs, or
        // edited in flight — the roots would then resolve the deletes against
        // the wrong side.
        let plan = vec![entry(DIR_LOCAL_TO_REMOTE), entry(DIR_REMOTE_TO_LOCAL)];
        assert_eq!(plan_coherent_direction(&plan), Some(None));
    }
}
