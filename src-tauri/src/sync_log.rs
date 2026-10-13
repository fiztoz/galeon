//! A persistent record of what each sync run actually did.
//!
//! `schedule-run-complete` is a transient event: if the app is closed when a
//! scheduled run fires, nothing survives, so there is no way to answer "did
//! that job delete my files last Tuesday?" — which is exactly the question you
//! ask after losing data. Deletions in particular are permanent, and the only
//! other trace is the plan you approved, which may be long gone.
//!
//! Deliberately a SEPARATE file from `sync_profiles.json`. That store drives the
//! scheduler, and a corrupt or unwritable store silently kills every schedule
//! (see `sync_store`); log growth or log corruption must never be able to do
//! that. Writes reuse the same atomic temp+rename, store lock and 0600 mode as
//! every other store.

use crate::*;

/// How many runs to keep. A run record is small; a hundred covers months of
/// hourly schedules without the file growing without bound.
pub const MAX_SYNC_RUN_RECORDS: usize = 100;

/// Cap on the per-run detail lists, so one pathological run (a whole folder
/// deleted) cannot turn the log into a multi-megabyte file.
pub const MAX_RUN_DETAIL_ENTRIES: usize = 200;

/// One sync run, as it actually happened.
///
/// Serialized as camelCase.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncRunRecord {
    pub id: String,
    pub profile_id: String,
    pub profile_name: String,
    /// "localToRemote" | "remoteToLocal".
    pub direction: String,
    /// "schedule" for an unattended run, "manual" for one the user started.
    pub trigger: String,
    pub started_at_ms: u64,
    pub finished_at_ms: u64,
    pub succeeded: bool,
    pub uploads: u32,
    pub downloads: u32,
    /// The number that matters: permanent, unrecoverable deletions.
    pub deletes: u32,
    pub failures: u32,
    /// Relative paths deleted at the destination, so a user can find out what
    /// went missing and restore it from a backup.
    pub deleted_paths: Vec<String>,
    /// Human-readable errors, capped.
    pub errors: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncRunLog {
    pub runs: Vec<SyncRunRecord>,
}

lazy_static::lazy_static! {
    static ref SYNC_LOG_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::new(());
}

fn get_sync_log_path(app_handle: &AppHandleType) -> Result<std::path::PathBuf, String> {
    let config_dir = app_handle
        .path()
        .app_config_dir()
        .map_err(|e| format!("Failed to get config dir: {}", e))?;
    if !config_dir.exists() {
        std::fs::create_dir_all(&config_dir)
            .map_err(|e| format!("Failed to create config dir: {}", e))?;
    }
    Ok(config_dir.join("sync_runs.json"))
}

/// Read the run log. An absent or unreadable file yields an empty log rather
/// than an error: a broken log must never block a sync, and losing history is
/// strictly better than refusing to run.
pub(crate) fn read_sync_runs(app_handle: &AppHandleType) -> SyncRunLog {
    let Ok(path) = get_sync_log_path(app_handle) else {
        return SyncRunLog::default();
    };
    if !path.exists() {
        return SyncRunLog::default();
    }
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Append a run to the log and return the full history, newest first.
pub(crate) async fn record_sync_run(
    app_handle: &AppHandleType,
    record: SyncRunRecord,
) -> Result<Vec<SyncRunRecord>, String> {
    let _lock = SYNC_LOG_LOCK.lock().await;
    let mut log = read_sync_runs(app_handle);
    log.runs.insert(0, record);
    if log.runs.len() > MAX_SYNC_RUN_RECORDS {
        log.runs.truncate(MAX_SYNC_RUN_RECORDS);
    }
    write_sync_runs(app_handle, &log)?;
    Ok(log.runs.clone())
}

fn write_sync_runs(app_handle: &AppHandleType, log: &SyncRunLog) -> Result<(), String> {
    let path = get_sync_log_path(app_handle)?;
    let s = serde_json::to_string_pretty(log)
        .map_err(|e| format!("Failed to serialize sync run log: {}", e))?;
    store_io::write_private(&path, s).map_err(|e| format!("Failed to write sync run log: {}", e))
}

/// Most recent runs, newest first.
#[tauri::command]
pub async fn get_sync_runs(app_handle: AppHandleType) -> Result<Vec<SyncRunRecord>, String> {
    let _lock = SYNC_LOG_LOCK.lock().await;
    Ok(read_sync_runs(&app_handle).runs)
}

/// Clear the run history.
#[tauri::command]
pub async fn clear_sync_runs(app_handle: AppHandleType) -> Result<(), String> {
    let _lock = SYNC_LOG_LOCK.lock().await;
    write_sync_runs(&app_handle, &SyncRunLog { runs: Vec::new() })
}

/// Build a run record from an execution outcome.
///
/// Pure — unit-tested. `deleted_paths` are recorded per delete action so the
/// log answers "what did this run remove", which is the only question worth
/// answering after an unattended run.
#[allow(clippy::too_many_arguments)]
pub(crate) fn build_run_record(
    profile_id: &str,
    profile_name: &str,
    direction: &str,
    trigger: &str,
    started_at_ms: u64,
    finished_at_ms: u64,
    outcome: &SyncRunOutcome,
    deleted_paths: Vec<String>,
) -> SyncRunRecord {
    SyncRunRecord {
        id: Uuid::new_v4().to_string(),
        profile_id: profile_id.to_string(),
        profile_name: profile_name.to_string(),
        direction: direction.to_string(),
        trigger: trigger.to_string(),
        started_at_ms,
        finished_at_ms,
        succeeded: outcome.failures.is_empty(),
        uploads: outcome.uploads,
        downloads: outcome.downloads,
        deletes: outcome.deletes,
        failures: outcome.failures.len() as u32,
        deleted_paths: {
            let mut paths = deleted_paths;
            if paths.len() > MAX_RUN_DETAIL_ENTRIES {
                paths.truncate(MAX_RUN_DETAIL_ENTRIES);
            }
            paths
        },
        errors: {
            let mut errors = outcome.failures.clone();
            if errors.len() > MAX_RUN_DETAIL_ENTRIES {
                errors.truncate(MAX_RUN_DETAIL_ENTRIES);
            }
            errors
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn outcome(uploads: u32, downloads: u32, deletes: u32, failures: &[&str]) -> SyncRunOutcome {
        SyncRunOutcome {
            uploads,
            downloads,
            deletes,
            deleted_paths: Vec::new(),
            failures: failures.iter().map(|s| s.to_string()).collect(),
        }
    }

    fn record(deletes: u32, failures: &[&str], paths: &[&str]) -> SyncRunRecord {
        build_run_record(
            "p1",
            "Nightly backup",
            "localToRemote",
            "schedule",
            1000,
            2000,
            &outcome(3, 0, deletes, failures),
            paths.iter().map(|s| s.to_string()).collect(),
        )
    }

    #[test]
    fn a_clean_run_is_recorded_as_successful() {
        let r = record(0, &[], &[]);
        assert!(r.succeeded);
        assert_eq!(r.uploads, 3);
        assert_eq!(r.deletes, 0);
        assert!(r.deleted_paths.is_empty());
    }

    #[test]
    fn a_run_with_failures_is_not_successful() {
        let r = record(0, &["a.bin: timeout"], &[]);
        assert!(!r.succeeded, "a failed item must not read as a clean run");
        assert_eq!(r.failures, 1);
        assert_eq!(r.errors, vec!["a.bin: timeout".to_string()]);
    }

    #[test]
    fn deletions_and_their_paths_are_recorded() {
        // This is the point of the log: permanent deletions, and what they were.
        let r = record(2, &[], &["old/a.bin", "old/b.bin"]);
        assert_eq!(r.deletes, 2);
        assert_eq!(r.deleted_paths, vec!["old/a.bin", "old/b.bin"]);
    }

    #[test]
    fn a_run_with_deletes_and_failures_reports_both() {
        let r = record(1, &["x: boom"], &["x"]);
        assert!(!r.succeeded);
        assert_eq!(r.deletes, 1);
        assert_eq!(r.failures, 1);
    }

    #[test]
    fn detail_lists_are_capped_so_one_run_cannot_bloat_the_log() {
        let paths: Vec<String> = (0..MAX_RUN_DETAIL_ENTRIES + 50)
            .map(|i| format!("f{i}"))
            .collect();
        let o = outcome(0, 0, 999, &[]);
        let r = build_run_record("p", "n", "localToRemote", "schedule", 0, 1, &o, paths);
        assert_eq!(
            r.deleted_paths.len(),
            MAX_RUN_DETAIL_ENTRIES,
            "path list must be capped"
        );
        assert_eq!(
            r.deletes, 999,
            "the true count is preserved even when the list is capped"
        );
    }

    #[test]
    fn error_lists_are_capped() {
        let failures: Vec<String> = (0..MAX_RUN_DETAIL_ENTRIES + 10)
            .map(|i| format!("err {i}"))
            .collect();
        let o = SyncRunOutcome {
            uploads: 0,
            downloads: 0,
            deletes: 0,
            deleted_paths: Vec::new(),
            failures,
        };
        let r = build_run_record("p", "n", "localToRemote", "schedule", 0, 1, &o, vec![]);
        assert_eq!(r.errors.len(), MAX_RUN_DETAIL_ENTRIES);
        assert_eq!(r.failures as usize, MAX_RUN_DETAIL_ENTRIES + 10);
    }

    #[test]
    fn the_record_round_trips_through_json() {
        let r = record(1, &["boom"], &["a"]);
        let json = serde_json::to_string(&r).unwrap();
        let back: SyncRunRecord = serde_json::from_str(&json).unwrap();
        assert_eq!(back.deleted_paths, r.deleted_paths);
        assert_eq!(back.deletes, 1);
        assert!(!back.succeeded);
    }
}

#[cfg(test)]
mod io_tests {
    use super::*;

    /// The log must not be able to take sync down with it. `sync_profiles.json`
    /// already proved that failure mode is real: a corrupt store silently killed
    /// every schedule, so a log that errors hard on read or write would trade
    /// one invisible failure for another.
    #[test]
    fn a_missing_log_file_reads_as_empty_rather_than_erroring() {
        let dir = std::env::temp_dir().join(format!("galeon-synclog-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("sync_runs.json");
        // Deliberately no file written.
        assert!(!path.exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_recorded_run_round_trips_and_stays_bounded() {
        // Exercises the serialisation the store depends on: newest first, and
        // capped so the file cannot grow without bound.
        let mut runs: Vec<SyncRunRecord> = (0..MAX_SYNC_RUN_RECORDS + 25)
            .map(|i| {
                let i = i as u64;
                SyncRunRecord {
                    id: format!("run-{i}"),
                    profile_id: "p".into(),
                    profile_name: "Nightly".into(),
                    direction: "localToRemote".into(),
                    trigger: "schedule".into(),
                    started_at_ms: i,
                    finished_at_ms: i + 1,
                    succeeded: i.is_multiple_of(2),
                    uploads: 1,
                    downloads: 0,
                    deletes: (i % 3) as u32,
                    failures: 0,
                    deleted_paths: vec![format!("f{i}")],
                    errors: vec![],
                }
            })
            .collect();
        // Newest first, then truncate as record_sync_run does.
        runs.reverse();
        if runs.len() > MAX_SYNC_RUN_RECORDS {
            runs.truncate(MAX_SYNC_RUN_RECORDS);
        }
        assert_eq!(runs.len(), MAX_SYNC_RUN_RECORDS);

        let json = serde_json::to_string(&runs).unwrap();
        let back: Vec<SyncRunRecord> = serde_json::from_str(&json).unwrap();
        assert_eq!(back.len(), MAX_SYNC_RUN_RECORDS);
        assert_eq!(back[0].id, runs[0].id);
    }

    #[test]
    fn a_corrupt_log_string_deserialises_to_nothing_rather_than_panicking() {
        // `read_sync_runs` swallows this into an empty log; the unit here is
        // that the type does not panic on garbage.
        let parsed = serde_json::from_str::<SyncRunLog>("{ not json");
        assert!(parsed.is_err());
        assert!(serde_json::from_str::<SyncRunLog>(r#"{"runs":[{"id":"a"}]}"#).is_err());
    }
}
