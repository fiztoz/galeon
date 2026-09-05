//! Data shapes for one-way sync: options, plan entries, schedules, profiles.

use serde::{Deserialize, Serialize};

/// Options controlling how a sync diff is computed and executed. Serialized as
/// camelCase to match the shared frontend contract.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncOptions {
    /// When true, refine equality with a checksum comparison for ambiguous
    /// same-size entries. Implemented by `refine_plan_with_checksums` on **S3
    /// sessions only** (it needs a server ETag); other protocols fall back to the
    /// size+mtime decision.
    pub verify_checksum: bool,
    /// When true, files that exist only on the destination are scheduled for
    /// deletion (`deleteRemote` / `deleteLocal`) instead of being ignored.
    pub delete_extraneous: bool,
}

/// A single planned sync action for one relative path. Serialized as camelCase.
///
/// `action` ∈ { `upload`, `download`, `skip`, `deleteRemote`, `deleteLocal` }.
/// `direction` ∈ { `localToRemote`, `remoteToLocal` }.
/// `*_modified` are RFC3339 strings.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SyncPlanEntry {
    pub relative_path: String,
    pub action: String,
    pub reason: String,
    pub local_size: Option<u64>,
    pub remote_size: Option<u64>,
    pub local_modified: Option<String>,
    pub remote_modified: Option<String>,
    pub direction: String,
}

/// Schedule for automatic sync profile runs. Serialized as camelCase.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncSchedule {
    pub enabled: bool,
    /// "once" | "hourly" | "daily" | "weekly".
    pub frequency: String,
    /// 0-23, used by daily/weekly/once.
    pub at_hour: u8,
    /// 0-59, used by all frequencies.
    pub at_minute: u8,
    /// 0=Mon..6=Sun, used by weekly.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub day_of_week: Option<u8>,
    /// Unix epoch millis of the next scheduled run (computed by backend).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_run_ms: Option<u64>,
}

/// A saved sync configuration (no secrets — references a `ConnectionProfile` by
/// id). Persisted to `sync_profiles.json` alongside the connection config.
/// Serialized as camelCase.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SyncProfile {
    pub id: String,
    pub name: String,
    pub connection_profile_id: String,
    pub local_path: String,
    pub remote_prefix: String,
    /// "localToRemote" | "remoteToLocal".
    pub direction: String,
    pub verify_checksum: bool,
    pub delete_extraneous: bool,
    /// Unix epoch millis of the last scheduled or manual run.
    pub last_run_ms: Option<u64>,
    /// Optional automatic run schedule (Phase 12).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schedule: Option<SyncSchedule>,
}

/// On-disk store for sync profiles. Mirrors the connection-profile JSON store
/// pattern (`GaleonConfig`), kept in its own file so it never carries secrets.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncProfilesStore {
    pub profiles: Vec<SyncProfile>,
}

/// Direction string constants for the shared contract.
pub(crate) const DIR_LOCAL_TO_REMOTE: &str = "localToRemote";
pub(crate) const DIR_REMOTE_TO_LOCAL: &str = "remoteToLocal";

/// Allowed mtime drift (ms) before two timestamps are considered different.
/// Remote stores (S3/FTP) round timestamps to whole seconds, so a 2s slack
/// avoids spurious "newer" diffs on otherwise-identical files.
pub(crate) const SYNC_MTIME_SLACK_MS: u64 = 2000;

/// One flattened file entry used by the sync planner: (relative forward-slash
/// path, size in bytes, optional modified time in unix epoch ms).
pub(crate) type SyncFileEntry = (String, u64, Option<u64>);
