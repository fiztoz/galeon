//! S3 connection construction: field cleaning, sanitization, SSL, and OpenDAL operator setup.
//!
//! Shared by `connect_bucket`, `connect_storage` (S3 arm), `auto_reconnect`, profile import,
//! and profile save paths.

use opendal::{services::S3, Operator};

/// Strip BOM / zero-width paste junk and surrounding whitespace.
pub fn clean_connection_field(raw: &str) -> String {
    raw.trim()
        .trim_start_matches('\u{feff}') // BOM
        .trim_matches(|c: char| {
            matches!(
                c,
                '\u{200b}' // zero-width space
                    | '\u{200c}' // ZWNJ
                    | '\u{200d}' // ZWJ
                    | '\u{2060}' // word joiner
                    | '\u{00a0}' // nbsp
                    | '\u{2028}'
                    | '\u{2029}'
            )
        })
        .trim()
        // Common copy-paste wrappers from chat/email
        .trim_matches(|c: char| matches!(c, '"' | '\'' | '`' | '“' | '”' | '‘' | '’' | '«' | '»'))
        .trim()
        .to_string()
}

/// Normalize optional string fields used in connection URLs/signing.
pub fn clean_connection_opt(raw: Option<String>) -> Option<String> {
    raw.map(|s| clean_connection_field(&s))
        .filter(|s| !s.is_empty())
}

/// Validate an S3 bucket name (non-empty, no whitespace, DNS-safe charset).
pub fn validate_bucket_name(bucket: &str) -> Result<(), String> {
    if bucket.is_empty() {
        return Err("S3 bucket is required.".to_string());
    }
    if bucket.chars().any(|c| c.is_whitespace()) {
        return Err(format!(
            "Bucket name contains whitespace (got {:?}). Remove spaces/newlines and try again.",
            bucket
        ));
    }
    // Path-style S3 access tolerates a broader charset than DNS-safe virtual-hosted
    // naming. Legacy buckets often use underscores, so allow them (plus hyphens/dots)
    // while still rejecting characters that break URI building.
    if bucket
        .chars()
        .any(|c| !(c.is_ascii_alphanumeric() || c == '-' || c == '.' || c == '_'))
    {
        return Err(format!(
            "Bucket name contains invalid characters (got {:?}). Use only letters, digits, hyphens, dots, and underscores.",
            bucket
        ));
    }
    Ok(())
}

/// Normalize endpoint URL in place: strip trailing slashes, drop trailing `/{bucket}`,
/// ensure http(s) scheme, reject whitespace / invalid URI characters.
pub fn normalize_endpoint(endpoint: &mut String, bucket: &str) -> Result<(), String> {
    // Drop trailing slashes — OpenDAL path-style appends /{bucket}.
    while endpoint.ends_with('/') {
        endpoint.pop();
    }
    // If someone pasted endpoint+bucket (e.g. https://host/my-bucket) and also
    // filled bucket=my-bucket, strip the duplicate path segment.
    if !bucket.is_empty() {
        let suffix = format!("/{}", bucket);
        if endpoint.ends_with(&suffix) {
            endpoint.truncate(endpoint.len() - suffix.len());
            while endpoint.ends_with('/') {
                endpoint.pop();
            }
        }
    }
    // Allow host-only paste; OpenDAL also prefixes https, but we normalize here.
    if !endpoint.starts_with("http://") && !endpoint.starts_with("https://") {
        *endpoint = format!("https://{}", endpoint);
    }
    // Reject whitespace inside the URL (causes http::Uri "invalid uri character").
    if endpoint.chars().any(|c| c.is_whitespace()) {
        return Err(format!(
            "Endpoint contains whitespace (got {:?}). Paste the URL without spaces or line breaks.",
            endpoint
        ));
    }
    // Host must be present and free of characters that break request URI building.
    let without_scheme = endpoint
        .strip_prefix("https://")
        .or_else(|| endpoint.strip_prefix("http://"))
        .unwrap_or(endpoint.as_str());
    let host = without_scheme.split('/').next().unwrap_or("");
    if host.is_empty() || host.contains(' ') {
        return Err(format!(
            "Endpoint is not a valid URL (got {:?}). Expected e.g. https://s3.example.com",
            endpoint
        ));
    }
    // Disallow characters that `http::Uri` rejects in the authority/path.
    if endpoint.chars().any(|c| {
        c.is_control()
            || !c.is_ascii()
            || matches!(c, '<' | '>' | '"' | '{' | '}' | '|' | '\\' | '^' | '`')
    }) {
        return Err(format!(
            "Endpoint contains invalid URI characters (got {:?}). Re-type the URL in plain ASCII — copy-paste from chat apps often inserts smart quotes or hidden characters.",
            endpoint
        ));
    }
    Ok(())
}

/// Cleaned S3 connection fields, in argument order:
/// `(endpoint, region, access_key, secret_key, bucket)`.
///
/// Kept as a tuple rather than a struct so callers destructure exactly what
/// they passed in; the alias exists only to name the positions and keep the
/// signature readable.
pub type SanitizedS3Connection = (
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    String,
);

/// Sanitize S3 connection fields before OpenDAL builds the request URI.
///
/// "invalid uri character" almost always means invisible whitespace or a
/// trailing path in endpoint/bucket from copy-paste — common when sharing
/// a DMG and the recipient retypes or pastes credentials.
pub fn sanitize_s3_connection(
    endpoint: Option<String>,
    region: Option<String>,
    access_key: Option<String>,
    secret_key: Option<String>,
    bucket: Option<String>,
) -> Result<SanitizedS3Connection, String> {
    let bucket = clean_connection_field(bucket.as_deref().unwrap_or(""));
    validate_bucket_name(&bucket)?;

    let mut endpoint = clean_connection_opt(endpoint);
    if let Some(ref mut ep) = endpoint {
        normalize_endpoint(ep, &bucket)?;
    }

    let region = clean_connection_opt(region);
    if let Some(ref r) = region {
        if r.chars().any(|c| c.is_whitespace()) {
            return Err(format!(
                "Region contains whitespace (got {:?}). Example: us-east-1",
                r
            ));
        }
    }

    let access_key = clean_connection_opt(access_key);
    let secret_key = clean_connection_opt(secret_key);
    // Secrets may contain special chars; only strip outer whitespace (already done).
    // Reject if key fields still contain newlines (classic spreadsheet paste).
    if let Some(ref ak) = access_key {
        if ak.chars().any(|c| c == '\n' || c == '\r' || c == '\t') {
            return Err(
                "Access Key contains line breaks or tabs. Re-copy the key as a single line."
                    .to_string(),
            );
        }
    }
    if let Some(ref sk) = secret_key {
        if sk.chars().any(|c| c == '\n' || c == '\r') {
            return Err(
                "Secret Key contains line breaks. Re-copy the secret as a single line.".to_string(),
            );
        }
    }

    Ok((endpoint, region, access_key, secret_key, bucket))
}

/// Soft-clean non-secret connection fields before writing a profile to config.
///
/// Does not require access keys or a live connection. When bucket is present,
/// applies the same endpoint normalization as live connect. Leaves vaulted
/// secret handling to the caller (keys should already be stripped).
pub fn sanitize_profile_for_storage(profile: &mut crate::ConnectionProfile) {
    profile.name = clean_connection_field(&profile.name);
    profile.ssh_tunnel_profile_id = clean_connection_opt(profile.ssh_tunnel_profile_id.take());

    let protocol = profile
        .protocol
        .as_deref()
        .unwrap_or("s3")
        .trim()
        .to_ascii_lowercase();

    if protocol == "s3" {
        profile.endpoint = clean_connection_opt(profile.endpoint.take());
        profile.region = clean_connection_opt(profile.region.take());
        profile.bucket = clean_connection_opt(profile.bucket.take());
        profile.storage_class = clean_connection_opt(profile.storage_class.take());

        if let Some(ref r) = profile.region {
            if r.chars().any(|c| c.is_whitespace()) {
                // Soft path: strip internal whitespace rather than failing save.
                profile.region = Some(r.split_whitespace().collect::<String>());
            }
        }

        if let (Some(ref mut ep), Some(ref bucket)) = (&mut profile.endpoint, &profile.bucket) {
            // Best-effort normalization; ignore validation errors so incomplete
            // drafts can still be saved (user may finish the form later).
            let _ = normalize_endpoint(ep, bucket);
        } else if let Some(ref mut ep) = profile.endpoint {
            let _ = normalize_endpoint(ep, "");
        }
    } else {
        // sftp / ftp / ftps
        profile.host = clean_connection_opt(profile.host.take());
        profile.username = clean_connection_opt(profile.username.take());
        profile.key_path = clean_connection_opt(profile.key_path.take());
    }

    profile.ssh_tunnel = profile.ssh_tunnel.take().map(|config| {
        let mut config = crate::ssh_tunnel::sanitize_config(config);
        // Defense in depth: import/export may temporarily attach this secret,
        // but metadata config must never persist it.
        config.password = None;
        config
    });
    if profile.ssh_tunnel_profile_id.is_some() {
        profile.ssh_tunnel = None;
    }
}

/// When `danger_disable_ssl` is true, swap the operator's HTTP transport for one
/// backed by a reqwest client that accepts self-signed / invalid TLS certificates
/// (common on private MinIO endpoints). Matches boto3's `verify=False`.
///
/// OpenDAL 0.56 removed the service-builder `http_client` hook, so the bypass now
/// rides the layered transport API: the operator is rebuilt around a custom
/// `OperationContext` with layers preserved (`with_context` replays them).
/// Kept as a separate step after `apply_s3_operator_layers` so the transport swap
/// never interferes with retry/throttle composition.
pub fn apply_s3_ssl_settings(
    op: Operator,
    danger_disable_ssl: Option<bool>,
) -> Result<Operator, String> {
    if danger_disable_ssl != Some(true) {
        return Ok(op);
    }
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .build()
        .map_err(|e| format!("Failed to build SSL-bypass HTTP client: {}", e))?;
    let transport = opendal::HttpTransporter::new(
        opendal_http_transport_reqwest::ReqwestTransport::new(client),
    );
    Ok(op.with_context(opendal::OperationContext::new().with_http_transport(transport)))
}

/// Humanize OpenDAL connection failures — TLS errors often look like generic
/// transport failures, which users misread as bad credentials.
///
/// TLS advice is only added when the error text mentions certificate/SSL/TLS
/// (or closely related handshake terms). Bare "error sending request" /
/// "client error (connect)" alone do **not** trigger the SSL hint.
pub fn format_s3_connect_error(prefix: &str, err: impl std::fmt::Display) -> String {
    let msg = err.to_string();
    let lower = msg.to_lowercase();
    if lower.contains("invalid uri") || lower.contains("invalid uri character") {
        return format!(
            "{}: {}. This usually means the endpoint or bucket has invalid characters \
             (spaces, quotes, or a full path pasted into Endpoint). Use a clean URL like \
             https://s3.example.com and put only the bucket name in Bucket.",
            prefix, msg
        );
    }
    let tls_related = lower.contains("certificate")
        || lower.contains("ssl")
        || lower.contains("tls")
        || lower.contains("unknownissuer")
        || lower.contains("certificateerror")
        || lower.contains("invalidcertificate")
        || lower.contains("handshake failure")
        || lower.contains("pkix")
        || lower.contains("x509");
    if tls_related {
        format!(
            "{}: {}. If this is a self-signed or private CA endpoint, enable \"Disable SSL Verify\" (same as S3_VERIFY_SSL=false).",
            prefix, msg
        )
    } else {
        format!(
            "{}: {}. Make sure the endpoint is accessible and credentials are correct.",
            prefix, msg
        )
    }
}

/// Inputs for building an OpenDAL S3 service.
#[derive(Clone, Debug)]
pub struct S3ConnectParams {
    pub endpoint: Option<String>,
    pub region: Option<String>,
    pub access_key: Option<String>,
    pub secret_key: Option<String>,
    pub bucket: Option<String>,
    pub use_virtual_host_style: Option<bool>,
    pub storage_class: Option<String>,
    pub danger_disable_ssl_verification: Option<bool>,
}

/// Result of sanitizing + configuring the S3 builder (before Operator layers).
#[derive(Clone, Debug)]
pub struct ConfiguredS3 {
    pub endpoint: Option<String>,
    pub region: Option<String>,
    pub access_key: Option<String>,
    pub secret_key: Option<String>,
    pub bucket: String,
}

/// Layer options applied after `Operator::new(...)` (0.58+ returns a finished
/// operator, so there is no `.finish()` step anymore).
///
/// Retry is always applied (3 attempts). Bandwidth throttle is optional
/// (`None` or `0` = unlimited).
#[derive(Clone, Debug, Default)]
pub struct S3LayerConfig {
    pub max_bandwidth_bytes_per_sec: Option<u64>,
}

/// Sanitize fields and configure the OpenDAL S3 service builder (incl. SSL).
pub fn configure_s3_service(params: S3ConnectParams) -> Result<(S3, ConfiguredS3), String> {
    let (endpoint, region, access_key, secret_key, bucket) = sanitize_s3_connection(
        params.endpoint,
        params.region,
        params.access_key,
        params.secret_key,
        params.bucket,
    )?;

    let mut builder = S3::default();
    builder = builder.bucket(&bucket);

    if let Some(ref ep) = endpoint {
        builder = builder.endpoint(ep);
    }
    if let Some(ref r) = region {
        builder = builder.region(r);
    }
    if let Some(ref ak) = access_key {
        builder = builder.access_key_id(ak);
    }
    if let Some(ref sk) = secret_key {
        builder = builder.secret_access_key(sk);
    }
    if let Some(true) = params.use_virtual_host_style {
        builder = builder.enable_virtual_host_style();
    }
    if let Some(ref sc) = params.storage_class {
        builder = builder.default_storage_class(sc);
    }

    Ok((
        builder,
        ConfiguredS3 {
            endpoint,
            region,
            access_key,
            secret_key,
            bucket,
        },
    ))
}

/// Apply RetryLayer and optional ThrottleLayer (matches prior call-site behavior).
pub fn apply_s3_operator_layers(op: Operator, layers: &S3LayerConfig) -> Operator {
    use opendal::layers::RetryLayer;
    let mut op = op.layer(RetryLayer::new().with_max_times(3));

    if let Some(limit) = layers.max_bandwidth_bytes_per_sec {
        if limit > 0 {
            use opendal::layers::ThrottleLayer;
            let burst = std::cmp::max(limit, 8 * 1024 * 1024);
            // ThrottleLayer expects u32 (max ~4 GB/s), clamp to u32::MAX
            let limit_u32 = std::cmp::min(limit, u32::MAX as u64) as u32;
            let burst_u32 = std::cmp::min(burst, u32::MAX as u64) as u32;
            op = op.layer(ThrottleLayer::new(limit_u32, burst_u32));
        }
    }
    op
}

/// Build OpenDAL S3 operator: sanitize → configure → finish → layers → check.
pub async fn open_s3_operator(
    params: S3ConnectParams,
    layers: S3LayerConfig,
    check_error_prefix: &str,
) -> Result<(Operator, ConfiguredS3), String> {
    let (builder, configured) = configure_s3_service(params.clone())?;

    // OpenDAL 0.58+: `Operator::new` returns a finished operator directly.
    let op = Operator::new(builder).map_err(|e| format!("Failed to create S3 builder: {}", e))?;

    let op = apply_s3_operator_layers(op, &layers);
    let op = apply_s3_ssl_settings(op, params.danger_disable_ssl_verification)?;

    op.check()
        .await
        .map_err(|e| format_s3_connect_error(check_error_prefix, e))?;

    Ok((op, configured))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_strips_bom_quotes_and_zwsp() {
        assert_eq!(
            clean_connection_field("  \u{feff}\"hello\"\u{200b}  "),
            "hello"
        );
    }

    #[test]
    fn sanitize_strips_whitespace_and_endpoint_bucket_path() {
        let (ep, region, ak, sk, bucket) = sanitize_s3_connection(
            Some("  \"https://s3.example.com/my-bucket\"  ".to_string()),
            Some(" us-east-1\n".to_string()),
            Some("  AKIAEXAMPLE  ".to_string()),
            Some("  secret  ".to_string()),
            Some("  my-bucket  ".to_string()),
        )
        .unwrap();
        assert_eq!(ep.as_deref(), Some("https://s3.example.com"));
        assert_eq!(region.as_deref(), Some("us-east-1"));
        assert_eq!(ak.as_deref(), Some("AKIAEXAMPLE"));
        assert_eq!(sk.as_deref(), Some("secret"));
        assert_eq!(bucket, "my-bucket");
    }

    #[test]
    fn sanitize_rejects_internal_endpoint_whitespace() {
        let err = sanitize_s3_connection(
            Some("https://s3.example.com /my-bucket".to_string()),
            None,
            Some("ak".to_string()),
            Some("sk".to_string()),
            Some("my-bucket".to_string()),
        )
        .unwrap_err();
        assert!(err.to_lowercase().contains("whitespace"), "err={err}");
    }

    #[test]
    fn format_error_invalid_uri_hint() {
        let msg = format_s3_connect_error(
            "S3 connection check failed",
            "building http request, source: invalid uri character",
        );
        assert!(msg.contains("endpoint or bucket"), "msg={msg}");
    }

    #[test]
    fn format_error_generic_connect_not_ssl_hint() {
        let msg = format_s3_connect_error(
            "Connection check failed",
            "error sending request for url (https://example.com): client error (Connect)",
        );
        assert!(
            !msg.to_lowercase().contains("disable ssl"),
            "generic connect must not suggest SSL bypass: {msg}"
        );
        assert!(msg.contains("accessible"), "msg={msg}");
    }

    #[test]
    fn format_error_certificate_gets_ssl_hint() {
        let msg = format_s3_connect_error(
            "Connection check failed",
            "error sending request: invalid peer certificate: UnknownIssuer",
        );
        assert!(
            msg.to_lowercase().contains("disable ssl"),
            "cert errors should suggest SSL bypass: {msg}"
        );
    }

    #[test]
    fn profile_storage_sanitizer_strips_tunnel_password() {
        let mut profile: crate::ConnectionProfile = serde_json::from_str(
            r#"{
                "id":"p1",
                "name":"Tunneled",
                "protocol":"sftp",
                "host":"storage.example.com",
                "sshTunnel":{
                    "host":"bastion.example.com",
                    "port":22,
                    "username":"deploy",
                    "password":"must-not-persist"
                }
            }"#,
        )
        .unwrap();

        sanitize_profile_for_storage(&mut profile);
        assert!(profile
            .ssh_tunnel
            .as_ref()
            .and_then(|tunnel| tunnel.password.as_ref())
            .is_none());
    }

    #[test]
    fn validate_bucket_rejects_bad_chars() {
        assert!(validate_bucket_name("ok-bucket").is_ok());
        assert!(validate_bucket_name("legacy_bucket").is_ok());
        assert!(validate_bucket_name("bad bucket").is_err());
        assert!(validate_bucket_name("bad/bucket").is_err());
    }
}
