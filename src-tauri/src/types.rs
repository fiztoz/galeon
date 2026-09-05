//! Wire contracts shared with the frontend. Field names serialize as
//! camelCase JSON keys — see AGENTS.md 3.4.

use crate::*;
use serde::{Deserialize, Serialize};

// 2. Data Models
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub enum ObjectType {
    Folder,
    File,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GaleonObject {
    pub name: String,
    pub full_key: String,
    pub object_type: ObjectType,
    pub size_bytes: Option<u64>,
    pub last_modified: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TransferProgressPayload {
    pub remote_key: String,
    pub bytes_transferred: u64,
    pub total_bytes: u64,
    pub percentage: f64,
    pub bytes_per_second: u64,
    pub direction: String, // "upload" or "download"
}

// 3. Connection Profile Models
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionProfile {
    pub id: String,
    pub name: String,
    // Protocol: s3 (default) or sftp
    #[serde(skip_serializing_if = "Option::is_none")]
    pub protocol: Option<String>,
    // S3 fields
    pub endpoint: Option<String>,
    pub region: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub access_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub secret_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bucket: Option<String>,
    pub danger_disable_ssl_verification: Option<bool>,
    pub use_virtual_host_style: Option<bool>,
    pub storage_class: Option<String>,
    pub max_bandwidth: Option<u64>,
    // SFTP fields
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key_path: Option<String>,
    // FTP/FTPS fields
    #[serde(skip_serializing_if = "Option::is_none")]
    pub passive_mode: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub encrypt: Option<bool>,
    /// Time-of-day/day-of-week bandwidth caps (Phase 12).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bandwidth_rules: Option<Vec<BandwidthRule>>,
    /// Optional bastion used to forward this profile's target port over SSH.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ssh_tunnel: Option<ssh_tunnel::SshTunnelConfig>,
    /// Reusable SSH tunnel profile. New saves use this instead of embedding tunnel metadata.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ssh_tunnel_profile_id: Option<String>,
    /// Whether saved credentials exist for this profile (metadata only, no keyring read).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub has_saved_credentials: Option<bool>,
}

/// Off-peak bandwidth rule for a connection profile. Serialized as camelCase.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BandwidthRule {
    pub enabled: bool,
    /// Start of window in 24h "HH:MM" local time (inclusive).
    pub start_time: String,
    /// End of window in 24h "HH:MM" local time (exclusive; wrap-around supported).
    pub end_time: String,
    /// Days the rule applies: 0=Mon..6=Sun.
    pub days: Vec<u8>,
    /// Cap in KB/s; 0 = unlimited within the window.
    pub limit_kbps: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PresignHistoryEntry {
    pub id: String,
    pub file_key: String,
    pub file_name: String,
    pub url: String,
    pub expires_in_seconds: u64,
    pub created_at: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GaleonConfig {
    pub profiles: Vec<ConnectionProfile>,
    #[serde(default)]
    pub presign_history: Vec<PresignHistoryEntry>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct AppSettings {
    pub onboarding_complete: bool,
    /// Show the local filesystem pane beside the remote explorer (dual-pane).
    /// `#[serde(default)]` on the container means users whose `app_settings.json`
    /// predates this field simply get `false` instead of a parse failure.
    pub dual_pane_enabled: bool,
    /// Last directory the local pane was viewing. `None` until the user navigates.
    pub local_pane_path: Option<String>,
    /// `"system"` | `"dark"` | `"light"`. `None` (or an unknown value) means
    /// system, so the field can never put the app into an unrenderable state.
    pub theme: Option<String>,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AppMetadata {
    pub product_name: String,
    pub version: String,
    pub identifier: String,
    pub platform: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TransferErrorPayload {
    pub remote_key: String,
    pub error: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub direction: Option<String>,
}

pub(crate) fn transfer_error_payload(
    remote_key: impl Into<String>,
    error: impl Into<String>,
    local_path: Option<String>,
    direction: &str,
) -> TransferErrorPayload {
    TransferErrorPayload {
        remote_key: remote_key.into(),
        error: error.into(),
        local_path,
        direction: Some(direction.to_string()),
    }
}

/// Emitted when a transfer is queued so the UI has id + local path for retry.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TransferStartedPayload {
    pub id: String,
    pub remote_key: String,
    pub local_path: String,
    pub direction: String,
    pub total_bytes: u64,
    pub profile_id: String,
}

/// Emitted before sleeping for a transient-error retry.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TransferRetryingPayload {
    pub remote_key: String,
    pub attempt: u32,
    pub max_attempts: u32,
    pub next_delay_ms: u64,
    pub message: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PrefixSizeProgressPayload {
    pub job_id: String,
    pub prefix: String,
    pub total_bytes: u64,
    pub file_count: u64,
    pub complete: bool,
    pub cancelled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ComputePrefixSizeResponse {
    pub job_id: String,
    pub cached: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_count: Option<u64>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DeleteObjectItem {
    pub key: String,
    pub is_folder: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DeleteObjectsResponse {
    pub job_id: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DeleteProgressPayload {
    pub job_id: String,
    pub done: u64,
    pub total: u64,
    pub current_key: String,
    pub complete: bool,
    pub cancelled: bool,
    pub failures: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProtocolCapabilities {
    pub supports_presigned_urls: bool,
    pub supports_multipart: bool,
    pub supports_storage_class: bool,
    pub supports_virtual_host_style: bool,
    pub supports_bucket_concept: bool,
    pub supports_bulk_delete: bool,
}

// ============================================================================
// Phase 11 — One-Way Sync & Diff ("Carrack")
// ============================================================================
