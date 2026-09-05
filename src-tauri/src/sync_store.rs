//! Persisted sync profiles and the background scheduler that runs them.

use crate::*;

/// How often the sync scheduler scans for due profiles.
/// Only reachable from `run()`, which is itself `#[cfg(not(test))]`.
#[cfg(not(test))]
const SYNC_SCHEDULER_INTERVAL_SECS: u64 = 60;

/// Background task: every `SYNC_SCHEDULER_INTERVAL_SECS`, run any sync profile
/// whose schedule is enabled and `next_run_ms` is due.
#[cfg(not(test))]
pub(crate) async fn run_sync_scheduler(app_handle: AppHandleType, _state: Arc<GaleonEngine>) {
    use tauri::Emitter;
    loop {
        tokio::time::sleep(std::time::Duration::from_secs(SYNC_SCHEDULER_INTERVAL_SECS)).await;
        let now = now_ms();

        let due_profiles: Vec<SyncProfile> = match read_sync_profiles(&app_handle) {
            Ok(store) => store
                .profiles
                .into_iter()
                .filter(|p| {
                    p.schedule
                        .as_ref()
                        .is_some_and(|s| s.enabled && s.next_run_ms.is_some_and(|n| n <= now))
                })
                .collect(),
            Err(e) => {
                eprintln!("sync scheduler: failed to read profiles: {}", e);
                continue;
            }
        };

        for profile in due_profiles {
            let profile_id = profile.id.clone();
            match commands::run_sync_profile_internal(&app_handle, &profile).await {
                Ok(failures) => {
                    if let Ok(mut store) = read_sync_profiles(&app_handle) {
                        if let Some(p) = store.profiles.iter_mut().find(|p| p.id == profile_id) {
                            p.last_run_ms = Some(now_ms());
                            if let Some(ref mut sched) = p.schedule {
                                if sched.frequency == "once" {
                                    sched.enabled = false;
                                    sched.next_run_ms = None;
                                } else {
                                    sched.next_run_ms = Some(compute_next_run_ms(now_ms(), sched));
                                }
                            }
                            let _ = write_sync_profiles(&app_handle, &store);
                        }
                    }
                    let _ = app_handle.emit(
                        "schedule-run-complete",
                        serde_json::json!({
                            "profileId": profile_id,
                            "success": failures == 0,
                            "failures": failures,
                            "completedAtMs": now_ms(),
                        }),
                    );
                }
                Err(e) => {
                    eprintln!("sync scheduler: profile {} failed: {}", profile_id, e);
                    if let Ok(mut store) = read_sync_profiles(&app_handle) {
                        if let Some(p) = store.profiles.iter_mut().find(|p| p.id == profile_id) {
                            if let Some(ref mut sched) = p.schedule {
                                // Only disable the schedule for permanent errors.
                                // Transient errors (network issues, temporary auth failures, etc.)
                                // should retry on the next scheduled window.
                                let is_permanent = e.contains("Connection profile not found")
                                    || e.contains("Local path does not exist")
                                    || e.contains("SSH key file not found");
                                if is_permanent {
                                    sched.enabled = false;
                                } else {
                                    // Recompute next_run_ms so the scheduler retries on the next interval.
                                    sched.next_run_ms = Some(compute_next_run_ms(now_ms(), sched));
                                }
                            }
                            let _ = write_sync_profiles(&app_handle, &store);
                        }
                    }
                    let _ = app_handle.emit(
                        "schedule-run-complete",
                        serde_json::json!({
                            "profileId": profile_id,
                            "success": false,
                            "failures": 0,
                            "completedAtMs": now_ms(),
                        }),
                    );
                }
            }
        }
    }
}

/// Path to the sync-profiles JSON store, mirroring `get_config_path`'s location
/// (the app config dir) but in its own `sync_profiles.json` file.
fn get_sync_profiles_path(app_handle: &AppHandleType) -> Result<std::path::PathBuf, String> {
    let config_dir = app_handle
        .path()
        .app_config_dir()
        .map_err(|e| format!("Failed to get config dir: {}", e))?;
    if !config_dir.exists() {
        std::fs::create_dir_all(&config_dir)
            .map_err(|e| format!("Failed to create config dir: {}", e))?;
    }
    Ok(config_dir.join("sync_profiles.json"))
}

/// Read the sync-profiles store from disk (empty store if the file is absent).
pub(crate) fn read_sync_profiles(app_handle: &AppHandleType) -> Result<SyncProfilesStore, String> {
    let path = get_sync_profiles_path(app_handle)?;
    if !path.exists() {
        return Ok(SyncProfilesStore::default());
    }
    let s = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read sync profiles: {}", e))?;
    serde_json::from_str(&s).map_err(|e| format!("Failed to parse sync profiles: {}", e))
}

/// Write the sync-profiles store to disk (pretty JSON, matching `write_config`).
pub(crate) fn write_sync_profiles(
    app_handle: &AppHandleType,
    store: &SyncProfilesStore,
) -> Result<(), String> {
    let path = get_sync_profiles_path(app_handle)?;
    let s = serde_json::to_string_pretty(store)
        .map_err(|e| format!("Failed to serialize sync profiles: {}", e))?;
    std::fs::write(&path, s).map_err(|e| format!("Failed to write sync profiles: {}", e))
}
