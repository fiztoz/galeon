//! Runtime state: the session registry, transfer controls, and the
//! GaleonEngine managed by Tauri.

use crate::*;
use opendal::Operator;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tokio::sync::Notify;
use tokio::sync::RwLock;
use tokio_util::sync::CancellationToken;

#[cfg(test)]
pub type AppHandleType = tauri::AppHandle<tauri::test::MockRuntime>;
#[cfg(not(test))]
pub type AppHandleType = tauri::AppHandle;

#[cfg(test)]
pub type AppType = tauri::App<tauri::test::MockRuntime>;
#[cfg(not(test))]
pub type AppType = tauri::App;

// 1. Thread-Safe Global State
#[derive(Clone)]
pub struct TransferControl {
    pub id: String,
    pub cancel: CancellationToken,
    pub paused: Arc<AtomicBool>,
    pub resume_notify: Arc<Notify>,
}

// Persistent transfer queue entry
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransferQueueEntry {
    pub id: String,
    pub direction: String, // "upload" or "download"
    pub remote_key: String,
    pub local_path: String,
    pub profile_id: String,
    pub status: String, // "queued", "active", "paused", "completed", "failed"
    pub bytes_transferred: u64,
    pub total_bytes: u64,
    pub created_at: String,
    pub updated_at: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TransferQueue {
    pub entries: Vec<TransferQueueEntry>,
}

/// Storage session - either OpenDAL operator or native SFTP session
///
/// NativeSFTP uses `std::sync::Mutex` because `ssh2::Session` is !Send
/// and synchronous I/O requires blocking access; we never hold the lock
/// across `.await` points in async contexts and use `spawn_blocking` for
/// long-running transfers.
#[derive(Clone)]
pub enum StorageSession {
    OpenDAL(Operator),
    NativeSFTP(Arc<std::sync::Mutex<sftp_native::NativeSftpSession>>),
    FTP(Arc<std::sync::Mutex<ftp_native::FtpSession>>),
}

pub struct GaleonEngine {
    pub active_sessions: Arc<RwLock<HashMap<String, StorageSession>>>,
    /// Live SSH forwarding processes keyed by the storage session they serve.
    pub ssh_tunnels: Arc<RwLock<HashMap<String, ssh_tunnel::SshTunnel>>>,
    /// S3 connection details keyed by session id (for metadata mutations).
    pub s3_configs: Arc<RwLock<HashMap<String, s3_metadata::S3SessionConfig>>>,
    pub transfers: Arc<RwLock<HashMap<String, TransferControl>>>,
    pub editors: Arc<RwLock<HashMap<String, EditSession>>>,
    /// Session-only cache for saved profile credentials (cleared on quit or lock).
    pub credential_cache: credentials::CredentialCache,
    /// Set once the background idle-editor janitor has been spawned, so we only
    /// ever run a single janitor for the lifetime of the app.
    pub editor_janitor_started: Arc<AtomicBool>,
    /// Set once the background sync scheduler has been spawned, so we only
    /// ever run a single scheduler for the lifetime of the app.
    pub sync_scheduler_started: Arc<AtomicBool>,
    /// Cancellation flags for in-flight prefix size computations, keyed by job id.
    pub prefix_size_jobs: Arc<RwLock<HashMap<String, Arc<AtomicBool>>>>,
    /// Cancellation flags for in-flight bulk delete jobs, keyed by job id.
    pub delete_jobs: Arc<RwLock<HashMap<String, Arc<AtomicBool>>>>,
    /// Bounded LRU cache of S3 prefix size scans (session + prefix → totals).
    /// `pub(crate)` rather than private: `prefix_size` owns the cache logic and
    /// the command layer seeds it, now that both live outside this module.
    pub(crate) prefix_size_cache: Arc<RwLock<PrefixSizeCache>>,
}

impl Default for GaleonEngine {
    fn default() -> Self {
        Self {
            active_sessions: Arc::new(RwLock::new(HashMap::new())),
            ssh_tunnels: Arc::new(RwLock::new(HashMap::new())),
            s3_configs: Arc::new(RwLock::new(HashMap::new())),
            transfers: Arc::new(RwLock::new(HashMap::new())),
            editors: Arc::new(RwLock::new(HashMap::new())),
            credential_cache: credentials::CredentialCache::new(),
            editor_janitor_started: Arc::new(AtomicBool::new(false)),
            sync_scheduler_started: Arc::new(AtomicBool::new(false)),
            prefix_size_jobs: Arc::new(RwLock::new(HashMap::new())),
            delete_jobs: Arc::new(RwLock::new(HashMap::new())),
            prefix_size_cache: Arc::new(RwLock::new(PrefixSizeCache::new())),
        }
    }
}

impl Clone for GaleonEngine {
    fn clone(&self) -> Self {
        Self {
            active_sessions: Arc::clone(&self.active_sessions),
            ssh_tunnels: Arc::clone(&self.ssh_tunnels),
            s3_configs: Arc::clone(&self.s3_configs),
            transfers: Arc::clone(&self.transfers),
            editors: Arc::clone(&self.editors),
            credential_cache: self.credential_cache.clone(),
            editor_janitor_started: Arc::clone(&self.editor_janitor_started),
            sync_scheduler_started: Arc::clone(&self.sync_scheduler_started),
            prefix_size_jobs: Arc::clone(&self.prefix_size_jobs),
            delete_jobs: Arc::clone(&self.delete_jobs),
            prefix_size_cache: Arc::clone(&self.prefix_size_cache),
        }
    }
}

/// Current unix epoch time in milliseconds (0 if the clock is before the epoch).
pub(crate) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Format unix epoch milliseconds as an RFC3339 string (empty on overflow).
pub(crate) fn ms_to_rfc3339(ms: u64) -> String {
    use chrono::{TimeZone, Utc};
    Utc.timestamp_millis_opt(ms as i64)
        .single()
        .map(|dt| dt.to_rfc3339())
        .unwrap_or_default()
}

impl GaleonEngine {
    pub async fn register_transfer(&self, id: String) -> TransferControl {
        let control = TransferControl {
            id: id.clone(),
            cancel: CancellationToken::new(),
            paused: Arc::new(AtomicBool::new(false)),
            resume_notify: Arc::new(Notify::new()),
        };
        self.transfers.write().await.insert(id, control.clone());
        control
    }

    pub async fn remove_transfer(&self, id: &str) {
        self.transfers.write().await.remove(id);
    }

    pub async fn get_transfer(&self, id: &str) -> Option<TransferControl> {
        self.transfers.read().await.get(id).cloned()
    }
}
