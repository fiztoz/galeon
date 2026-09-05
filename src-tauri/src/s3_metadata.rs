//! Direct S3 metadata mutations via `aws-sdk-s3`.
//!
//! OpenDAL 0.50's `copy` ignores metadata overrides, so content-type and
//! storage-class edits use a server-side self-copy with the appropriate
//! `MetadataDirective`.

use std::sync::Arc;
use std::time::SystemTime;

use aws_config::BehaviorVersion;
use aws_credential_types::Credentials;
use aws_sdk_s3::config::SharedHttpClient;
use aws_sdk_s3::types::MetadataDirective;
use aws_sdk_s3::Client;
#[allow(deprecated)]
use aws_smithy_runtime::client::http::hyper_014::HyperClientBuilder;
use rustls::{Certificate, ServerName};

/// Connection details captured at S3 connect time for metadata mutations.
#[derive(Clone, Debug)]
pub struct S3SessionConfig {
    pub bucket: String,
    pub region: String,
    pub endpoint: Option<String>,
    pub access_key_id: String,
    pub secret_access_key: String,
    /// When `true`, requests use path-style URLs (`endpoint/bucket/key`).
    pub force_path_style: bool,
    /// When `true`, TLS certificate verification is skipped (self-signed MinIO, etc.).
    pub danger_disable_ssl_verification: bool,
}

/// Fields the Properties Inspector may update. `None` means "leave unchanged".
#[derive(Clone, Debug, Default)]
pub struct MetadataUpdate {
    pub content_type: Option<String>,
    pub storage_class: Option<String>,
}

/// Server cert verifier that accepts any certificate (self-signed MinIO, private CA).
///
/// Used only when the user explicitly enables "Disable SSL Verify" on a profile —
/// same intent as OpenDAL's `reqwest::danger_accept_invalid_certs(true)`.
#[derive(Debug)]
struct InsecureServerCertVerifier;

impl rustls::client::ServerCertVerifier for InsecureServerCertVerifier {
    fn verify_server_cert(
        &self,
        _end_entity: &Certificate,
        _intermediates: &[Certificate],
        _server_name: &ServerName,
        _scts: &mut dyn Iterator<Item = &[u8]>,
        _ocsp_response: &[u8],
        _now: SystemTime,
    ) -> Result<rustls::client::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::ServerCertVerified::assertion())
    }
}

/// Build an AWS SDK HTTP client that accepts invalid / self-signed TLS certs.
///
/// Uses the hyper 0.14 connector path already pulled in by `aws-sdk-s3`'s
/// `rustls` / `connector-hyper-0-14-x` features, with a custom rustls verifier.
fn build_insecure_http_client() -> Result<SharedHttpClient, String> {
    // Do not pre-set alpn_protocols — hyper-rustls sets them via enable_http1/http2.
    let tls_config = rustls::ClientConfig::builder()
        .with_safe_defaults()
        .with_custom_certificate_verifier(Arc::new(InsecureServerCertVerifier))
        .with_no_client_auth();

    let https = hyper_rustls::HttpsConnectorBuilder::new()
        .with_tls_config(tls_config)
        // Allow plain http:// custom endpoints as well as https://
        .https_or_http()
        .enable_http1()
        .enable_http2()
        .build();

    // hyper_014 is deprecated upstream in favor of aws-smithy-http-client 1.x,
    // but it is still the supported path for a custom connector without adding
    // heavier smithy-http-client feature wiring.
    #[allow(deprecated)]
    let http_client = HyperClientBuilder::new().build(https);
    Ok(http_client)
}

/// Build an S3 client from a stored session config.
///
/// When `danger_disable_ssl_verification` is true, attaches a custom HTTP client
/// that accepts invalid certificates so metadata mutations work against self-signed
/// MinIO the same way OpenDAL list/transfer already does.
pub async fn build_s3_client(config: &S3SessionConfig) -> Result<Client, String> {
    let creds = Credentials::new(
        &config.access_key_id,
        &config.secret_access_key,
        None,
        None,
        "galeon",
    );

    let mut loader = aws_config::defaults(BehaviorVersion::latest())
        .credentials_provider(creds)
        .region(aws_config::Region::new(config.region.clone()));

    if let Some(ref endpoint) = config.endpoint {
        loader = loader.endpoint_url(endpoint);
    }

    if config.danger_disable_ssl_verification {
        let http_client = build_insecure_http_client()?;
        loader = loader.http_client(http_client);
    }

    let sdk_config = loader.load().await;
    let s3_config = aws_sdk_s3::config::Builder::from(&sdk_config)
        .force_path_style(config.force_path_style)
        .build();

    Ok(Client::from_conf(s3_config))
}

/// URL-encode an object key for use in a `CopySource` header value.
pub fn copy_source(bucket: &str, key: &str) -> String {
    format!("{}/{}", bucket, urlencoding::encode(key))
}

/// Normalize and validate a user-supplied content type.
pub fn normalize_content_type(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("Content-Type cannot be empty.".to_string());
    }
    if trimmed.chars().any(|c| c.is_control()) {
        return Err("Content-Type contains invalid characters.".to_string());
    }
    if trimmed.len() > 256 {
        return Err("Content-Type is too long (max 256 characters).".to_string());
    }
    Ok(trimmed.to_string())
}

/// Apply metadata and/or storage-class changes via a server-side self-copy.
pub async fn apply_metadata_update(
    client: &Client,
    bucket: &str,
    key: &str,
    update: &MetadataUpdate,
) -> Result<(), String> {
    if update.content_type.is_none() && update.storage_class.is_none() {
        return Err("No metadata changes requested.".to_string());
    }

    let head = client
        .head_object()
        .bucket(bucket)
        .key(key)
        .send()
        .await
        .map_err(|e| format!("Failed to read object metadata: {e}"))?;

    let source = copy_source(bucket, key);

    let mut req = client
        .copy_object()
        .bucket(bucket)
        .key(key)
        .copy_source(&source);

    if let Some(ref new_ct) = update.content_type {
        req = req
            .metadata_directive(MetadataDirective::Replace)
            .content_type(new_ct);

        if let Some(cc) = head.cache_control() {
            req = req.cache_control(cc);
        }
        if let Some(cd) = head.content_disposition() {
            req = req.content_disposition(cd);
        }
        if let Some(ce) = head.content_encoding() {
            req = req.content_encoding(ce);
        }
        if let Some(meta) = head.metadata() {
            for (k, v) in meta {
                req = req.metadata(k, v);
            }
        }
    } else {
        req = req.metadata_directive(MetadataDirective::Copy);
    }

    if let Some(ref sc) = update.storage_class {
        req = req.storage_class(aws_sdk_s3::types::StorageClass::from(sc.as_str()));
    }

    req.send()
        .await
        .map_err(|e| format!("Failed to update object metadata: {e}"))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copy_source_encodes_spaces_and_slashes() {
        assert_eq!(
            copy_source("my-bucket", "a/b c.txt"),
            "my-bucket/a%2Fb%20c.txt"
        );
    }

    #[test]
    fn normalize_content_type_trims_and_rejects_empty() {
        assert_eq!(
            normalize_content_type("  image/png  ").unwrap(),
            "image/png"
        );
        assert!(normalize_content_type("   ").is_err());
    }

    #[test]
    fn normalize_content_type_rejects_control_chars() {
        assert!(normalize_content_type("text/\x01plain").is_err());
    }

    #[test]
    fn insecure_http_client_builds() {
        // Construction must succeed without network I/O.
        let client = build_insecure_http_client().expect("insecure client");
        // SharedHttpClient is opaque; just ensure Debug works.
        let _ = format!("{:?}", client);
    }
}
