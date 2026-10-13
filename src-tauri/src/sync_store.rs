//! Persisted sync profiles and the background scheduler that runs them.

use crate::*;

lazy_static::lazy_static! {
    /// Serializes read-modify-write cycles on `sync_profiles.json`. Mirrors
    /// `QUEUE_FILE_LOCK` in `commands/transfer_queue.rs`.
    pub(crate) static ref SYNC_STORE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::new(());
}

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
                    let _ = update_sync_profile(&app_handle, &profile_id, |p| {
                        advance_schedule_after_run(p, now_ms())
                    })
                    .await;
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
                    let _ = update_sync_profile(&app_handle, &profile_id, |p| {
                        apply_failed_run(p, &e, now_ms())
                    })
                    .await;
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
///
/// Atomic: the bytes land in a temp file in the same directory and are then
/// renamed over the target. `rename` is atomic within a filesystem, so a reader
/// sees either the old store or the new one — never a half-written one. The
/// previous `std::fs::write` could leave unparseable JSON after a crash or a
/// full disk, and since the scheduler logs and continues on a read error, that
/// permanently and silently killed every scheduled sync and lost the user's
/// saved profiles.
pub(crate) fn write_sync_profiles(
    app_handle: &AppHandleType,
    store: &SyncProfilesStore,
) -> Result<(), String> {
    let path = get_sync_profiles_path(app_handle)?;
    let s = serde_json::to_string_pretty(store)
        .map_err(|e| format!("Failed to serialize sync profiles: {}", e))?;
    write_atomic(&path, &s)
}

/// Write `contents` to `path` via a same-directory temp file + rename.
fn write_atomic(path: &std::path::Path, contents: &str) -> Result<(), String> {
    use std::io::Write;

    let dir = path
        .parent()
        .ok_or_else(|| "Store path has no parent".to_string())?;
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("store.json");
    // Same directory so the rename stays within one filesystem, which is what
    // makes it atomic; a temp file in /tmp would degrade to a copy.
    let tmp = dir.join(format!("{file_name}.tmp"));

    let write_result = (|| -> std::io::Result<()> {
        // Owner-only temp file (0600): after the rename it *is* the store, so
        // the mode travels with the atomic swap.
        let mut f = store_io::create_private_file(&tmp)?;
        f.write_all(contents.as_bytes())?;
        // Flush to the OS before the rename so a crash cannot leave the renamed
        // file present but empty.
        f.sync_all()?;
        Ok(())
    })();

    if let Err(e) = write_result {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("Failed to write sync profiles: {}", e));
    }

    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("Failed to replace sync profiles: {}", e));
    }
    Ok(())
}

/// Read-modify-write one profile while holding the store lock.
///
/// The scheduler and the UI both write this store. Without a lock, a
/// read-modify-write pair could interleave: the scheduler re-reads, mutates one
/// profile, and writes back a store that was stale by the time it hit disk —
/// reverting a user's edit, or worse, restoring an already-due `next_run_ms` and
/// making the profile fire again on the very next tick, unattended.
///
/// The lock is held ONLY for this short critical section. It is deliberately
/// never held across `run_sync_profile_internal`, which can run for minutes.
pub(crate) async fn update_sync_profile<F>(
    app_handle: &AppHandleType,
    profile_id: &str,
    mutate: F,
) -> Result<(), String>
where
    F: FnOnce(&mut SyncProfile),
{
    let _lock = SYNC_STORE_LOCK.lock().await;
    let mut store = read_sync_profiles(app_handle)?;
    match store.profiles.iter_mut().find(|p| p.id == profile_id) {
        Some(profile) => {
            mutate(profile);
            write_sync_profiles(app_handle, &store)
        }
        // The profile was deleted while its run was in flight; nothing to record.
        None => Ok(()),
    }
}

/// Advance a profile's schedule after a run completed. Pure — unit-tested.
pub(crate) fn advance_schedule_after_run(profile: &mut SyncProfile, now_ms: u64) {
    profile.last_run_ms = Some(now_ms);
    if let Some(sched) = profile.schedule.as_mut() {
        if sched.frequency == "once" {
            sched.enabled = false;
            sched.next_run_ms = None;
        } else {
            sched.next_run_ms = Some(compute_next_run_ms(now_ms, sched));
        }
    }
}

/// Apply a failed run: disable the schedule only for permanent errors, and
/// otherwise retry on the next window. Pure — unit-tested.
pub(crate) fn apply_failed_run(profile: &mut SyncProfile, error: &str, now_ms: u64) {
    let Some(sched) = profile.schedule.as_mut() else {
        return;
    };
    let is_permanent = error.contains("Connection profile not found")
        || error.contains("Local path does not exist")
        || error.contains("SSH key file not found");
    if is_permanent {
        sched.enabled = false;
    } else {
        // Transient (network, temporary auth): retry on the next interval.
        sched.next_run_ms = Some(compute_next_run_ms(now_ms, sched));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn tmp_dir(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("galeon-sync-store-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    fn sched(frequency: &str) -> SyncSchedule {
        SyncSchedule {
            enabled: true,
            frequency: frequency.to_string(),
            at_hour: 3,
            at_minute: 30,
            day_of_week: None,
            next_run_ms: Some(1),
        }
    }

    fn profile_with(schedule: Option<SyncSchedule>) -> SyncProfile {
        SyncProfile {
            id: "p1".into(),
            name: "P".into(),
            connection_profile_id: "c1".into(),
            local_path: "/tmp/a".into(),
            remote_prefix: "b/".into(),
            direction: crate::DIR_LOCAL_TO_REMOTE.to_string(),
            verify_checksum: false,
            delete_extraneous: true,
            last_run_ms: None,
            schedule,
        }
    }

    #[test]
    fn atomic_write_replaces_content_and_leaves_no_temp_file() {
        let dir = tmp_dir("atomic-ok");
        let path = dir.join("sync_profiles.json");

        write_atomic(&path, "{\"a\":1}").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\"a\":1}");

        write_atomic(&path, "{\"a\":2}").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\"a\":2}");

        assert!(
            !path.with_file_name("sync_profiles.json.tmp").exists(),
            "temp file must not survive a successful write"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn atomic_write_leaves_the_previous_file_readable_when_the_write_fails() {
        // The whole point of temp+rename: a failure must not destroy the store
        // the scheduler and the UI both depend on.
        let dir = tmp_dir("atomic-fail");
        let path = dir.join("sync_profiles.json");
        write_atomic(&path, "GOOD").unwrap();

        // A directory where the temp file must go makes `File::create` fail.
        let blocked = path.with_file_name("sync_profiles.json.tmp");
        std::fs::create_dir(&blocked).unwrap();

        assert!(write_atomic(&path, "CLOBBER").is_err());
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "GOOD",
            "a failed write must leave the old content intact"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_completed_run_advances_the_schedule() {
        let mut p = profile_with(Some(sched("daily")));
        advance_schedule_after_run(&mut p, 1_700_000_000_000);
        assert_eq!(p.last_run_ms, Some(1_700_000_000_000));
        let next = p.schedule.unwrap().next_run_ms.unwrap();
        assert!(next > 1_700_000_000_000, "next run must move forward");
    }

    #[test]
    fn a_one_off_schedule_disables_itself_after_running() {
        let mut p = profile_with(Some(sched("once")));
        advance_schedule_after_run(&mut p, 1_700_000_000_000);
        let s = p.schedule.unwrap();
        assert!(!s.enabled);
        assert!(s.next_run_ms.is_none());
    }

    #[test]
    fn a_permanent_failure_disables_the_schedule() {
        let mut p = profile_with(Some(sched("daily")));
        apply_failed_run(&mut p, "Connection profile not found", 1_700_000_000_000);
        assert!(!p.schedule.unwrap().enabled);
    }

    #[test]
    fn a_transient_failure_retries_on_the_next_window() {
        let mut p = profile_with(Some(sched("daily")));
        apply_failed_run(&mut p, "connection reset by peer", 1_700_000_000_000);
        let s = p.schedule.unwrap();
        assert!(
            s.enabled,
            "a network blip must not silently kill the schedule"
        );
        assert!(s.next_run_ms.unwrap() > 1_700_000_000_000);
    }

    #[test]
    fn schedule_helpers_tolerate_a_profile_with_no_schedule() {
        let mut p = profile_with(None);
        advance_schedule_after_run(&mut p, 1);
        assert_eq!(p.last_run_ms, Some(1));
        apply_failed_run(&mut p, "boom", 1);
    }
}
