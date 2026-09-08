//! Direct S3 metadata mutations via `aws-sdk-s3`.
//!
//! OpenDAL 0.50's `copy` ignores metadata overrides, so content-type and
//! storage-class edits use a server-side self-copy with the appropriate
//! `MetadataDirective`.

#[cfg(test)]
use std::sync::Arc;
use std::time::Duration;

use aws_config::BehaviorVersion;
use aws_credential_types::Credentials;
use aws_sdk_s3::config::SharedHttpClient;
use aws_sdk_s3::types::MetadataDirective;
use aws_sdk_s3::Client;
use aws_smithy_runtime_api::client::http::{
    http_client_fn, HttpConnector, HttpConnectorFuture, SharedHttpConnector,
};
use aws_smithy_runtime_api::client::orchestrator::{HttpRequest, HttpResponse};
use aws_smithy_runtime_api::client::result::ConnectorError;
use aws_smithy_runtime_api::http::StatusCode;
use aws_smithy_types::body::SdkBody;
use futures_util::StreamExt;

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

/// Minimal Smithy connector for metadata-only requests.
///
/// Metadata HEAD and server-side COPY requests have empty request bodies and
/// small responses, so buffering here does not affect Galeon's transfer path.
#[derive(Clone, Debug)]
struct ReqwestMetadataConnector {
    client: reqwest::Client,
}

const METADATA_RESPONSE_LIMIT: usize = 1024 * 1024;
const METADATA_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const METADATA_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

impl HttpConnector for ReqwestMetadataConnector {
    fn call(&self, request: HttpRequest) -> HttpConnectorFuture {
        let Some(body) = request.body().bytes() else {
            return HttpConnectorFuture::ready(Err(ConnectorError::user(
                "streaming bodies are unsupported by the metadata HTTP adapter".into(),
            )));
        };

        let method = match reqwest::Method::from_bytes(request.method().as_bytes()) {
            Ok(method) => method,
            Err(error) => {
                return HttpConnectorFuture::ready(Err(ConnectorError::user(error.into())));
            }
        };

        let mut builder = self
            .client
            .request(method, request.uri())
            .body(body.to_vec());
        for (name, value) in request.headers().iter() {
            builder = builder.header(name, value);
        }

        HttpConnectorFuture::new(async move {
            let response = builder
                .send()
                .await
                .map_err(|error| ConnectorError::io(error.into()))?;
            let status = StatusCode::try_from(response.status().as_u16())
                .map_err(|error| ConnectorError::other(error.into(), None))?;
            if response
                .content_length()
                .is_some_and(|length| length > METADATA_RESPONSE_LIMIT as u64)
            {
                return Err(ConnectorError::user(
                    "metadata response exceeds the 1 MiB limit".into(),
                ));
            }
            let headers = response.headers().clone();
            let mut body = Vec::new();
            let mut stream = response.bytes_stream();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|error| ConnectorError::io(error.into()))?;
                if body.len().saturating_add(chunk.len()) > METADATA_RESPONSE_LIMIT {
                    return Err(ConnectorError::user(
                        "metadata response exceeds the 1 MiB limit".into(),
                    ));
                }
                body.extend_from_slice(&chunk);
            }
            let mut response = HttpResponse::new(status, SdkBody::from(body));

            for (name, value) in &headers {
                let value = value
                    .to_str()
                    .map_err(|error| ConnectorError::other(error.into(), None))?;
                response
                    .headers_mut()
                    .try_append(name.as_str().to_owned(), value.to_owned())
                    .map_err(|error| ConnectorError::other(error.into(), None))?;
            }

            Ok(response)
        })
    }
}

fn build_reqwest_metadata_connector(
    danger_disable_ssl_verification: bool,
) -> Result<ReqwestMetadataConnector, String> {
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(danger_disable_ssl_verification)
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(METADATA_CONNECT_TIMEOUT)
        .timeout(METADATA_REQUEST_TIMEOUT)
        .build()
        .map_err(|error| format!("Failed to build metadata HTTP client: {error}"))?;
    Ok(ReqwestMetadataConnector { client })
}

/// Build an AWS SDK HTTP client that honors the explicit TLS bypass.
fn build_insecure_http_client() -> Result<SharedHttpClient, String> {
    let connector = SharedHttpConnector::new(build_reqwest_metadata_connector(true)?);
    Ok(http_client_fn(move |_settings, _components| {
        connector.clone()
    }))
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

    // Use the bounded adapter only for the explicit certificate-verification
    // bypass; otherwise retain the SDK's normal root-store-backed transport.
    if config.danger_disable_ssl_verification {
        loader = loader.http_client(build_insecure_http_client()?);
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

    async fn spawn_self_signed_tls_server() -> (String, tokio::task::JoinHandle<()>) {
        use rcgen::{generate_simple_self_signed, CertifiedKey};
        use rustls::pki_types::{PrivateKeyDer, PrivatePkcs8KeyDer};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::TcpListener;
        use tokio_rustls::TlsAcceptor;

        let CertifiedKey { cert, key_pair } =
            generate_simple_self_signed(vec!["localhost".to_string()]).expect("certificate");
        let provider = rustls::crypto::ring::default_provider();
        let server_config = rustls::ServerConfig::builder_with_provider(Arc::new(provider))
            .with_safe_default_protocol_versions()
            .expect("TLS versions")
            .with_no_client_auth()
            .with_single_cert(
                vec![cert.der().clone()],
                PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key_pair.serialize_der())),
            )
            .expect("server certificate");
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("bind TLS test server");
        let address = listener.local_addr().expect("test server address");
        let acceptor = TlsAcceptor::from(Arc::new(server_config));

        let server = tokio::spawn(async move {
            // The secure attempt reaches TCP but fails during TLS. The bypass
            // attempt completes TLS and receives a small HTTP response.
            for _ in 0..2 {
                let (stream, _) = listener.accept().await.expect("accept connection");
                let Ok(mut stream) = acceptor.accept(stream).await else {
                    continue;
                };
                let mut request = [0_u8; 1024];
                let _ = stream.read(&mut request).await.expect("read request");
                stream
                    .write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok")
                    .await
                    .expect("write response");
            }
        });

        (format!("https://localhost:{}/", address.port()), server)
    }

    async fn call_connector(
        connector: &ReqwestMetadataConnector,
        url: &str,
    ) -> Result<HttpResponse, ConnectorError> {
        use aws_smithy_runtime_api::client::http::HttpConnector;

        let request = HttpRequest::get(url).expect("valid test URL");
        connector.call(request).await
    }

    #[tokio::test]
    async fn metadata_adapter_rejects_oversized_response() {
        use tokio::io::AsyncWriteExt;
        use tokio::net::TcpListener;

        let listener = TcpListener::bind(("127.0.0.1", 0)).await.expect("bind");
        let address = listener.local_addr().expect("address");
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.expect("accept");
            stream
                .write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 1048577\r\n\r\n")
                .await
                .expect("response");
        });

        let connector = build_reqwest_metadata_connector(false).expect("connector");
        assert!(call_connector(&connector, &format!("http://{address}/"))
            .await
            .is_err());
        server.await.expect("server");
    }

    #[tokio::test]
    async fn metadata_adapter_does_not_follow_redirects() {
        use tokio::io::AsyncWriteExt;
        use tokio::net::TcpListener;

        let listener = TcpListener::bind(("127.0.0.1", 0)).await.expect("bind");
        let address = listener.local_addr().expect("address");
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.expect("accept");
            stream
                .write_all(b"HTTP/1.1 302 Found\r\nlocation: http://127.0.0.1:1/\r\ncontent-length: 0\r\n\r\n")
                .await
                .expect("response");
        });

        let connector = build_reqwest_metadata_connector(false).expect("connector");
        let response = call_connector(&connector, &format!("http://{address}/"))
            .await
            .expect("redirect response");
        assert_eq!(response.status().as_u16(), 302);
        server.await.expect("server");
    }

    #[tokio::test]
    async fn metadata_adapter_bounds_chunked_responses() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::TcpListener;

        for size in [METADATA_RESPONSE_LIMIT, METADATA_RESPONSE_LIMIT + 1] {
            let listener = TcpListener::bind(("127.0.0.1", 0)).await.expect("bind");
            let address = listener.local_addr().expect("address");
            let server = tokio::spawn(async move {
                let (mut stream, _) = listener.accept().await.expect("accept");
                let mut request = [0_u8; 4096];
                assert!(stream.read(&mut request).await.expect("request") > 0);
                stream
                    .write_all(b"HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n")
                    .await
                    .expect("response headers");
                let chunk = format!("{size:x}\r\n{}\r\n0\r\n\r\n", "x".repeat(size));
                // The over-limit client may close before the server finishes writing.
                let _ = stream.write_all(chunk.as_bytes()).await;
            });
            let connector = build_reqwest_metadata_connector(false).expect("connector");
            let response = tokio::time::timeout(
                Duration::from_secs(5),
                call_connector(&connector, &format!("http://{address}/")),
            )
            .await
            .expect("bounded response time");
            if size == METADATA_RESPONSE_LIMIT {
                assert_eq!(
                    response
                        .expect("at-limit response")
                        .body()
                        .bytes()
                        .unwrap()
                        .len(),
                    size
                );
            } else {
                assert!(response.is_err());
            }
            tokio::time::timeout(Duration::from_secs(5), server)
                .await
                .expect("bounded server time")
                .expect("server");
        }
    }

    fn without_test_retries(client: Client) -> Client {
        // Keep normal SDK retries in production; only the two-connection TLS
        // fixture disables them, and assert the default has not regressed.
        assert!(client
            .config()
            .retry_config()
            .is_some_and(|config| config.max_attempts() > 1));
        Client::from_conf(
            client
                .config()
                .to_builder()
                .retry_config(aws_config::retry::RetryConfig::disabled())
                .build(),
        )
    }

    #[tokio::test]
    async fn build_s3_client_routes_self_signed_tls_bypass() {
        let (url, server) = spawn_self_signed_tls_server().await;
        let secure_config = S3SessionConfig {
            bucket: "bucket".into(),
            region: "us-east-1".into(),
            endpoint: Some(url.clone()),
            access_key_id: "test-access-key".into(),
            secret_access_key: "test-secret-key".into(),
            force_path_style: true,
            danger_disable_ssl_verification: false,
        };
        let secure = build_s3_client(&secure_config)
            .await
            .expect("secure client");
        let secure = without_test_retries(secure);
        assert!(secure
            .head_object()
            .bucket("bucket")
            .key("object")
            .send()
            .await
            .is_err());

        let insecure_config = S3SessionConfig {
            danger_disable_ssl_verification: true,
            ..secure_config
        };
        let insecure = build_s3_client(&insecure_config)
            .await
            .expect("bypass client");
        let insecure = without_test_retries(insecure);
        assert!(insecure
            .head_object()
            .bucket("bucket")
            .key("object")
            .send()
            .await
            .is_ok());

        server.await.expect("TLS test server");
    }
}
