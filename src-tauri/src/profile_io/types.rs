// Data shapes for the `galeon.profiles` envelope and import results.

use super::*;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProfileExportFile {
    pub format: String,
    pub version: u32,
    #[serde(default)]
    pub exported_at: String,
    #[serde(default)]
    pub includes_secrets: bool,
    pub profiles: Vec<ConnectionProfile>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CollisionStrategy {
    Skip,
    Overwrite,
    Rename,
}

impl CollisionStrategy {
    pub fn parse(raw: &str) -> Result<Self, String> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "skip" => Ok(Self::Skip),
            "overwrite" => Ok(Self::Overwrite),
            "rename" => Ok(Self::Rename),
            other => Err(format!(
                "Unknown collision strategy {:?}. Use skip, overwrite, or rename.",
                other
            )),
        }
    }
}

/// Counters are non-overlapping so the UI can say "Imported X, Y overwritten"
/// without double-counting:
/// - `imported`: newly inserted profiles only
/// - `overwritten`: replaced existing profiles (not also counted in `imported`)
/// - `renamed`: subset of inserts that needed a unique name
/// - `skipped`: collision skips + validation errors
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub imported: usize,
    pub skipped: usize,
    pub renamed: usize,
    pub overwritten: usize,
    pub total_in_file: usize,
    pub messages: Vec<String>,
}

/// Pre-import summary (no config or keyring writes).
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    pub includes_secrets: bool,
    pub total: usize,
    pub profile_names: Vec<String>,
    pub danger_ssl_bypass_count: usize,
    pub profiles_with_secrets: usize,
    /// Fingerprint of the file bytes read for this preview (md5 hex).
    /// Pass back on import to detect TOCTOU replacement between preview and confirm.
    pub content_hash: String,
}

/// Credentials to persist after a successful merge (never logged).
#[derive(Clone, Debug)]
pub struct PendingCredentials {
    pub profile_id: String,
    pub access_key: Option<String>,
    pub secret_key: Option<String>,
    pub ssh_tunnel_password: Option<String>,
    pub protocol: String,
}
