//! OpenDAL connection construction for the HTTP storage protocols — WebDAV,
//! Azure Blob, and Google Cloud Storage.
//!
//! Mirrors `s3_connect` for non-S3 services: sanitize profile fields → build the
//! service operator → shared retry/throttle layers → TLS bypass → `check()` for a
//! friendly early error. All three ride the existing `StorageSession::OpenDAL`
//! arm, so browse, transfers, preview, and edit need no per-protocol branches.
//!
//! Profile fields are reused rather than invented: WebDAV/Azure keep their
//! username in `username` (Azure's account name) and their secret in the keyring
//! password slot; Azure's container and GCS's bucket live in `bucket`; GCS's
//! service-account JSON path lives in `credential_path`.

use opendal::services::{Azblob, Gcs, Webdav};
use opendal::{Builder, Operator};

use crate::s3_connect::{
    apply_operator_layers, apply_tls_bypass, clean_connection_field, clean_connection_opt,
    format_connect_error, normalize_endpoint, validate_bucket_name, OperatorLayerConfig,
};

/// Reject the classic spreadsheet paste: a secret that spans multiple lines.
fn require_single_line(value: &str, field: &str) -> Result<(), String> {
    if value.chars().any(|c| c == '\n' || c == '\r') {
        return Err(format!(
            "{} contains line breaks. Re-copy the value as a single line.",
            field
        ));
    }
    Ok(())
}

/// Default Azure endpoint for an account name (sovereign clouds pass a custom URL).
fn default_azure_endpoint(account_name: &str) -> String {
    format!("https://{}.blob.core.windows.net", account_name)
}

/// Shared opener tail: build → layer → TLS bypass → connectivity check.
async fn finish_operator<B: Builder>(
    builder: B,
    service_label: &str,
    layers: OperatorLayerConfig,
    danger_disable_ssl_verification: Option<bool>,
    check_error_prefix: &str,
) -> Result<Operator, String> {
    let op = Operator::new(builder)
        .map_err(|e| format!("Failed to create {} builder: {}", service_label, e))?;
    let op = apply_operator_layers(op, &layers);
    let op = apply_tls_bypass(op, danger_disable_ssl_verification)?;
    op.check()
        .await
        .map_err(|e| format_connect_error(check_error_prefix, e))?;
    Ok(op)
}

// ---------------------------------------------------------------------------
// WebDAV
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub struct WebdavConnectParams {
    /// Full DAV root URL, e.g. `https://cloud.example.com/remote.php/dav/files/me`.
    pub endpoint: Option<String>,
    /// Optional — anonymous WebDAV shares leave it empty.
    pub username: Option<String>,
    pub password: Option<String>,
    pub danger_disable_ssl_verification: Option<bool>,
}

/// Cleaned `(endpoint, username, password)`; endpoint keeps its path (DAV roots
/// live under one, unlike S3 endpoints).
pub fn sanitize_webdav_connection(
    endpoint: Option<String>,
    username: Option<String>,
    password: Option<String>,
) -> Result<(String, Option<String>, Option<String>), String> {
    let mut endpoint = clean_connection_opt(endpoint).ok_or_else(|| {
        "WebDAV server URL is required (e.g. https://cloud.example.com/remote.php/dav).".to_string()
    })?;
    normalize_endpoint(&mut endpoint, "")?;

    let username = clean_connection_opt(username);
    let password = clean_connection_opt(password);
    if let Some(ref pw) = password {
        require_single_line(pw, "Password")?;
    }

    Ok((endpoint, username, password))
}

pub async fn open_webdav_operator(
    params: WebdavConnectParams,
    layers: OperatorLayerConfig,
    check_error_prefix: &str,
) -> Result<Operator, String> {
    let (endpoint, username, password) = sanitize_webdav_connection(
        params.endpoint.clone(),
        params.username.clone(),
        params.password.clone(),
    )?;

    let mut builder = Webdav::default();
    builder = builder.endpoint(&endpoint);
    if let Some(ref user) = username {
        builder = builder.username(user);
    }
    if let Some(ref pw) = password {
        builder = builder.password(pw);
    }

    finish_operator(
        builder,
        "WebDAV",
        layers,
        params.danger_disable_ssl_verification,
        check_error_prefix,
    )
    .await
}

// ---------------------------------------------------------------------------
// Azure Blob
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub struct AzureConnectParams {
    /// Account URL. `None` derives `https://<account>.blob.core.windows.net`;
    /// sovereign clouds (Azure Stack, China) pass their own.
    pub endpoint: Option<String>,
    /// Container name, stored in the `bucket` profile field.
    pub container: Option<String>,
    /// Account name, stored in the `username` profile field.
    pub account_name: Option<String>,
    /// Base64 account key (shared key).
    pub account_key: Option<String>,
    pub danger_disable_ssl_verification: Option<bool>,
}

/// Azure container names: 3–63 chars, lowercase letters/digits/hyphens, starting
/// and ending with a letter or digit (consecutive-hyphen rules are server-side).
fn validate_container_name(container: &str) -> Result<(), String> {
    let valid_len = (3..=63).contains(&container.chars().count());
    let valid_chars = container
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    let valid_edges = container
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_alphanumeric())
        && container
            .chars()
            .last()
            .is_some_and(|c| c.is_ascii_alphanumeric());
    if !valid_len || !valid_chars || !valid_edges {
        return Err(format!(
            "Container name is invalid (got {:?}). Use 3–63 lowercase letters, digits, or hyphens, starting and ending with a letter or digit.",
            container
        ));
    }
    Ok(())
}

/// Azure account names: 3–24 lowercase letters or digits (case is normalized).
fn validate_account_name(account_name: &str) -> Result<(), String> {
    let valid_len = (3..=24).contains(&account_name.chars().count());
    let valid_chars = account_name
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit());
    if !valid_len || !valid_chars {
        return Err(format!(
            "Azure account name is invalid (got {:?}). Use 3–24 lowercase letters or digits (e.g. mystorageaccount).",
            account_name
        ));
    }
    Ok(())
}

/// Cleaned `(endpoint, container, account_name, account_key)`.
pub fn sanitize_azure_connection(
    endpoint: Option<String>,
    container: Option<String>,
    account_name: Option<String>,
    account_key: Option<String>,
) -> Result<(String, String, String, String), String> {
    let account_name =
        clean_connection_field(account_name.as_deref().unwrap_or("")).to_ascii_lowercase();
    validate_account_name(&account_name)?;

    let container = clean_connection_field(container.as_deref().unwrap_or("")).to_ascii_lowercase();
    validate_container_name(&container)?;

    // A pasted account URL may carry the container as its path; drop it, and
    // fall back to the standard URL when the field is left blank.
    let mut endpoint = match clean_connection_opt(endpoint) {
        Some(ep) => ep,
        None => default_azure_endpoint(&account_name),
    };
    normalize_endpoint(&mut endpoint, &container)?;

    let account_key = clean_connection_opt(account_key)
        .ok_or_else(|| "Azure account key is required (Account name + Access key).".to_string())?;
    require_single_line(&account_key, "Account key")?;

    Ok((endpoint, container, account_name, account_key))
}

pub async fn open_azblob_operator(
    params: AzureConnectParams,
    layers: OperatorLayerConfig,
    check_error_prefix: &str,
) -> Result<Operator, String> {
    let (endpoint, container, account_name, account_key) = sanitize_azure_connection(
        params.endpoint.clone(),
        params.container.clone(),
        params.account_name.clone(),
        params.account_key.clone(),
    )?;

    let mut builder = Azblob::default();
    builder = builder.endpoint(&endpoint);
    builder = builder.account_name(&account_name);
    builder = builder.container(&container);
    builder = builder.account_key(&account_key);

    finish_operator(
        builder,
        "Azure Blob",
        layers,
        params.danger_disable_ssl_verification,
        check_error_prefix,
    )
    .await
}

// ---------------------------------------------------------------------------
// Google Cloud Storage
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub struct GcsConnectParams {
    /// Optional — blank uses the default `storage.googleapis.com` endpoint.
    pub endpoint: Option<String>,
    pub bucket: Option<String>,
    /// Path to a service-account JSON file. Preferred over pasting the JSON:
    /// the secret stays on disk and only the path is stored in the profile.
    pub credential_path: Option<String>,
    /// Pasted service-account JSON contents (keyed to the profile like any
    /// other protocol password). Ignored when `credential_path` is set.
    pub credential: Option<String>,
    pub danger_disable_ssl_verification: Option<bool>,
}

/// Cleaned `(endpoint, bucket, credential_path, credential)`.
///
/// A named alias rather than four parallel `Option<String>` return values, in
/// the same spirit as `s3_connect::SanitizedS3Connection`.
pub type SanitizedGcsConnection = (Option<String>, String, Option<String>, Option<String>);

/// Cleaned `(endpoint, bucket, credential_path, credential)`.
pub fn sanitize_gcs_connection(
    endpoint: Option<String>,
    bucket: Option<String>,
    credential_path: Option<String>,
    credential: Option<String>,
) -> Result<SanitizedGcsConnection, String> {
    let bucket = clean_connection_field(bucket.as_deref().unwrap_or(""));
    if bucket.is_empty() {
        return Err("Bucket is required for Google Cloud Storage.".to_string());
    }
    // validate_bucket_name's wording mentions S3; the rule itself (letters,
    // digits, hyphens, dots, underscores) is a superset of GCS's.
    validate_bucket_name(&bucket)?;

    let endpoint = match clean_connection_opt(endpoint) {
        Some(mut ep) => {
            normalize_endpoint(&mut ep, "")?;
            Some(ep)
        }
        None => None,
    };

    let credential_path = clean_connection_opt(credential_path);
    let credential = if credential_path.is_some() {
        // The file on disk wins; a stale keyring paste must not shadow it.
        None
    } else {
        let credential = clean_connection_opt(credential);
        if let Some(ref cred) = credential {
            require_single_line(cred, "Service account JSON")?;
            if !cred.trim_start().starts_with('{') {
                return Err(
                    "Service account credential must be the JSON key contents (it starts with '{'). For a file path, use the JSON file picker."
                        .to_string(),
                );
            }
        }
        credential
    };

    if let Some(ref path) = credential_path {
        if !std::path::Path::new(path).exists() {
            return Err(format!(
                "Service account file not found: {}. Check the path and try again.",
                path
            ));
        }
    }

    Ok((endpoint, bucket, credential_path, credential))
}

pub async fn open_gcs_operator(
    params: GcsConnectParams,
    layers: OperatorLayerConfig,
    check_error_prefix: &str,
) -> Result<Operator, String> {
    let (endpoint, bucket, credential_path, credential) = sanitize_gcs_connection(
        params.endpoint.clone(),
        params.bucket.clone(),
        params.credential_path.clone(),
        params.credential.clone(),
    )?;

    let mut builder = Gcs::default();
    builder = builder.bucket(&bucket);
    if let Some(ref ep) = endpoint {
        builder = builder.endpoint(ep);
    }
    if let Some(ref path) = credential_path {
        builder = builder.credential_path(path);
    }
    if let Some(ref cred) = credential {
        builder = builder.credential(cred);
    }

    finish_operator(
        builder,
        "GCS",
        layers,
        params.danger_disable_ssl_verification,
        check_error_prefix,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn webdav_keeps_path_adds_scheme_and_allows_empty_auth() {
        let (endpoint, username, password) = sanitize_webdav_connection(
            Some("  \"https://cloud.example.com/remote.php/dav/files/me/\"  ".to_string()),
            None,
            None,
        )
        .unwrap();
        assert_eq!(
            endpoint,
            "https://cloud.example.com/remote.php/dav/files/me"
        );
        assert!(username.is_none());
        assert!(password.is_none());
    }

    #[test]
    fn webdav_requires_endpoint() {
        let err = sanitize_webdav_connection(None, Some("user".into()), None).unwrap_err();
        assert!(err.contains("WebDAV server URL is required"), "err={err}");
    }

    #[test]
    fn webdav_password_rejects_line_breaks() {
        let err = sanitize_webdav_connection(
            Some("https://dav.example.com".to_string()),
            None,
            Some("secret\nwith\nnewlines".to_string()),
        )
        .unwrap_err();
        assert!(err.contains("line breaks"), "err={err}");
    }

    #[test]
    fn webdav_endpoint_rejects_uri_junk() {
        let err =
            sanitize_webdav_connection(Some("https://dav.example.com/a b".to_string()), None, None)
                .unwrap_err();
        assert!(err.to_lowercase().contains("whitespace"), "err={err}");
    }

    #[test]
    fn azure_normalizes_case_and_strips_container_from_endpoint() {
        let (endpoint, container, account, key) = sanitize_azure_connection(
            Some("https://mystorageaccount.blob.core.windows.net/mycontainer".to_string()),
            Some("MyContainer".to_string()),
            Some("MyStorageAccount".to_string()),
            Some("  base64key==  ".to_string()),
        )
        .unwrap();
        assert_eq!(endpoint, "https://mystorageaccount.blob.core.windows.net");
        assert_eq!(container, "mycontainer");
        assert_eq!(account, "mystorageaccount");
        assert_eq!(key, "base64key==");
    }

    #[test]
    fn azure_derives_endpoint_from_account_name() {
        let (endpoint, ..) = sanitize_azure_connection(
            None,
            Some("files".to_string()),
            Some("mystorageaccount".to_string()),
            Some("key".to_string()),
        )
        .unwrap();
        assert_eq!(endpoint, "https://mystorageaccount.blob.core.windows.net");
    }

    #[test]
    fn azure_rejects_bad_names_and_key() {
        let err = sanitize_azure_connection(
            None,
            Some("ok-container".to_string()),
            Some("ab".to_string()), // too short
            Some("key".to_string()),
        )
        .unwrap_err();
        assert!(err.contains("account name"), "err={err}");

        let err = sanitize_azure_connection(
            None,
            Some("Bad_Container".to_string()), // underscore
            Some("mystorageaccount".to_string()),
            Some("key".to_string()),
        )
        .unwrap_err();
        assert!(err.contains("Container name"), "err={err}");

        let err = sanitize_azure_connection(
            None,
            Some("files".to_string()),
            Some("mystorageaccount".to_string()),
            Some("key\nwith\nlines".to_string()),
        )
        .unwrap_err();
        assert!(err.contains("line breaks"), "err={err}");
    }

    #[test]
    fn gcs_requires_bucket_and_optional_endpoint() {
        let err = sanitize_gcs_connection(None, None, None, None).unwrap_err();
        assert!(err.contains("Bucket"), "err={err}");

        let (endpoint, bucket, path, credential) =
            sanitize_gcs_connection(None, Some("my-bucket".to_string()), None, None).unwrap();
        assert!(endpoint.is_none());
        assert_eq!(bucket, "my-bucket");
        assert!(path.is_none());
        assert!(credential.is_none());
    }

    #[test]
    fn gcs_credential_must_be_json_when_not_a_path() {
        let err = sanitize_gcs_connection(
            None,
            Some("my-bucket".to_string()),
            None,
            Some("not-json".to_string()),
        )
        .unwrap_err();
        assert!(err.contains("JSON"), "err={err}");
    }

    #[test]
    fn gcs_credential_path_wins_over_pasted_json() {
        // cwd is the crate root, so Cargo.toml stands in for an existing file.
        let (endpoint, bucket, path, credential) = sanitize_gcs_connection(
            Some("storage.googleapis.com".to_string()),
            Some("my-bucket".to_string()),
            Some("Cargo.toml".to_string()),
            None,
        )
        .unwrap();
        assert_eq!(endpoint.as_deref(), Some("https://storage.googleapis.com"));
        assert_eq!(bucket, "my-bucket");
        assert_eq!(path.as_deref(), Some("Cargo.toml"));
        assert!(
            credential.is_none(),
            "path form must not also send JSON contents"
        );
    }

    #[test]
    fn gcs_missing_credential_file_is_reported() {
        let err = sanitize_gcs_connection(
            None,
            Some("my-bucket".to_string()),
            Some("/definitely/missing/key.json".to_string()),
            None,
        )
        .unwrap_err();
        assert!(err.contains("not found"), "err={err}");
    }
}
