//! Optional SSH local-port forwarding for storage connections.
//!
//! The tunnel is owned by the backend session and uses the platform OpenSSH
//! client for key/agent authentication. Password authentication uses the
//! in-process `ssh2` client so the password never appears in process arguments,
//! environment variables, or profile JSON. Both paths enforce known-host checks.

use crate::s3_connect::{clean_connection_field, clean_connection_opt, normalize_endpoint};
use crate::ConnectionProfile;
use serde::{Deserialize, Serialize};
use std::io::{ErrorKind, Read, Write};
use std::net::{TcpListener, TcpStream, ToSocketAddrs};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

const DEFAULT_SSH_PORT: u16 = 22;
const STARTUP_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SshTunnelConfig {
    pub host: String,
    #[serde(default = "default_ssh_port")]
    pub port: u16,
    pub username: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_path: Option<String>,
    /// Import/export-only secret. Runtime callers pass this separately and
    /// persisted profile config always clears it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
}

fn default_ssh_port() -> u16 {
    DEFAULT_SSH_PORT
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct TunnelDestination {
    host: String,
    port: u16,
}

enum SshTunnelRuntime {
    OpenSsh(Child),
    Password {
        shutdown: Arc<AtomicBool>,
        listener_thread: Option<JoinHandle<()>>,
    },
}

/// Live tunnel runtime. Dropping the session-owned handle closes the listener.
pub struct SshTunnel {
    runtime: SshTunnelRuntime,
    local_port: u16,
    destination: TunnelDestination,
}

impl SshTunnel {
    pub fn local_port(&self) -> u16 {
        self.local_port
    }

    pub fn destination_host(&self) -> &str {
        &self.destination.host
    }

    pub fn destination_port(&self) -> u16 {
        self.destination.port
    }
}

impl Drop for SshTunnel {
    fn drop(&mut self) {
        match &mut self.runtime {
            SshTunnelRuntime::OpenSsh(child) => {
                let _ = child.kill();
                let _ = child.wait();
            }
            SshTunnelRuntime::Password {
                shutdown,
                listener_thread,
            } => {
                shutdown.store(true, Ordering::SeqCst);
                if let Some(thread) = listener_thread.take() {
                    let _ = thread.join();
                }
            }
        }
    }
}

pub fn sanitize_config(mut config: SshTunnelConfig) -> SshTunnelConfig {
    config.host = clean_connection_field(&config.host);
    config.username = clean_connection_field(&config.username);
    config.key_path = clean_connection_opt(config.key_path);
    config
}

pub fn validate_config(config: &SshTunnelConfig) -> Result<(), String> {
    if config.host.is_empty() {
        return Err("SSH tunnel server is required.".to_string());
    }
    if config.username.is_empty() {
        return Err("SSH tunnel username is required.".to_string());
    }
    if config.port == 0 {
        return Err("SSH tunnel port must be between 1 and 65535.".to_string());
    }
    if invalid_ssh_name(&config.host) || config.host.contains('@') {
        return Err("SSH tunnel server contains invalid characters.".to_string());
    }
    if invalid_ssh_name(&config.username) || config.username.contains('@') {
        return Err("SSH tunnel username contains invalid characters.".to_string());
    }
    Ok(())
}

fn invalid_ssh_name(value: &str) -> bool {
    value.starts_with('-') || value.chars().any(|c| c.is_control() || c.is_whitespace())
}

fn invalid_forward_host(value: &str) -> bool {
    invalid_ssh_name(value)
        || value
            .chars()
            .any(|c| matches!(c, '[' | ']' | ',' | '/' | '\\'))
}

/// Open a tunnel when the profile requests one, returning a runtime-only profile
/// whose destination points at the ephemeral loopback listener.
pub async fn open_for_profile(
    profile: ConnectionProfile,
    password: Option<String>,
) -> Result<(ConnectionProfile, Option<SshTunnel>), String> {
    if profile.ssh_tunnel.is_none() {
        return Ok((profile, None));
    }

    tokio::task::spawn_blocking(move || open_for_profile_blocking(profile, password))
        .await
        .map_err(|e| format!("SSH tunnel task failed: {}", e))?
}

fn open_for_profile_blocking(
    mut profile: ConnectionProfile,
    password: Option<String>,
) -> Result<(ConnectionProfile, Option<SshTunnel>), String> {
    let mut config = sanitize_config(
        profile
            .ssh_tunnel
            .clone()
            .ok_or_else(|| "SSH tunnel configuration is missing.".to_string())?,
    );
    let password = password
        .filter(|value| !value.is_empty())
        .or_else(|| config.password.take().filter(|value| !value.is_empty()));
    validate_config(&config)?;
    if password.is_none() {
        if let Some(key_path) = config.key_path.as_deref() {
            if !Path::new(key_path).is_file() {
                return Err(format!(
                    "SSH tunnel private key not found: {}. Choose an existing key or enter the bastion password.",
                    key_path
                ));
            }
        }
    }
    profile.ssh_tunnel = Some(config.clone());

    let destination = destination_for_profile(&mut profile)?;
    let tunnel = open_tunnel(&config, &destination, password.as_deref())?;
    rewrite_profile_for_local_port(&mut profile, tunnel.local_port())?;
    Ok((profile, Some(tunnel)))
}

fn destination_for_profile(profile: &mut ConnectionProfile) -> Result<TunnelDestination, String> {
    match profile.protocol.as_deref().unwrap_or("s3").to_ascii_lowercase().as_str() {
        "s3" => {
            if profile.use_virtual_host_style == Some(true) {
                return Err(
                    "SSH tunneling does not support S3 virtual-host style. Turn off Virtual Host Style so every request uses the forwarded endpoint."
                        .to_string(),
                );
            }
            let bucket = profile.bucket.as_deref().unwrap_or("");
            let mut endpoint = clean_connection_opt(profile.endpoint.take()).ok_or_else(|| {
                "SSH tunneling for S3 requires a custom endpoint so Galeon knows which target host and port to forward."
                    .to_string()
            })?;
            normalize_endpoint(&mut endpoint, bucket)?;
            let url = reqwest::Url::parse(&endpoint)
                .map_err(|e| format!("S3 endpoint is not a valid URL: {}", e))?;
            if url.scheme() == "https"
                && profile.danger_disable_ssl_verification != Some(true)
            {
                return Err(
                    "An HTTPS S3 endpoint forwarded to loopback will not match its TLS hostname. Use an HTTP endpoint inside the encrypted SSH tunnel, or explicitly enable Disable SSL Verify for this profile."
                        .to_string(),
                );
            }
            let host = url
                .host_str()
                .ok_or_else(|| "S3 endpoint host is missing.".to_string())?
                .to_string();
            let port = url
                .port_or_known_default()
                .ok_or_else(|| "S3 endpoint port could not be determined.".to_string())?;
            profile.endpoint = Some(endpoint);
            Ok(TunnelDestination { host, port })
        }
        "sftp" => {
            let host = clean_connection_opt(profile.host.take())
                .ok_or_else(|| "SFTP target host is required.".to_string())?;
            if invalid_forward_host(&host) {
                return Err("SFTP target host contains invalid characters.".to_string());
            }
            let port = profile.port.unwrap_or(DEFAULT_SSH_PORT);
            if port == 0 {
                return Err("SFTP target port must be between 1 and 65535.".to_string());
            }
            profile.host = Some(host.clone());
            profile.port = Some(port);
            Ok(TunnelDestination { host, port })
        }
        "ftp" | "ftps" => Err(
            "SSH tunneling is not available for FTP/FTPS because forwarding only the control port would leave passive data connections outside the tunnel. Use S3 or SFTP."
                .to_string(),
        ),
        other => Err(format!("SSH tunneling is not supported for protocol {}.", other)),
    }
}

fn rewrite_profile_for_local_port(
    profile: &mut ConnectionProfile,
    local_port: u16,
) -> Result<(), String> {
    match profile
        .protocol
        .as_deref()
        .unwrap_or("s3")
        .to_ascii_lowercase()
        .as_str()
    {
        "s3" => {
            let endpoint = profile
                .endpoint
                .as_deref()
                .ok_or_else(|| "S3 endpoint is missing.".to_string())?;
            let mut url = reqwest::Url::parse(endpoint)
                .map_err(|e| format!("S3 endpoint is not a valid URL: {}", e))?;
            url.set_host(Some("127.0.0.1"))
                .map_err(|_| "Could not rewrite S3 endpoint for SSH tunnel.".to_string())?;
            url.set_port(Some(local_port))
                .map_err(|_| "Could not set SSH tunnel port on S3 endpoint.".to_string())?;
            let mut runtime_endpoint = url.to_string();
            if url.path() == "/" && url.query().is_none() && url.fragment().is_none() {
                runtime_endpoint = runtime_endpoint.trim_end_matches('/').to_string();
            }
            profile.endpoint = Some(runtime_endpoint);
        }
        "sftp" => {
            profile.host = Some("127.0.0.1".to_string());
            profile.port = Some(local_port);
        }
        _ => return Err("Unsupported SSH tunnel destination protocol.".to_string()),
    }
    Ok(())
}

fn open_tunnel(
    config: &SshTunnelConfig,
    destination: &TunnelDestination,
    password: Option<&str>,
) -> Result<SshTunnel, String> {
    if let Some(password) = password.filter(|value| !value.is_empty()) {
        return open_password_tunnel(config, destination, password);
    }
    open_openssh_tunnel(config, destination)
}

fn open_openssh_tunnel(
    config: &SshTunnelConfig,
    destination: &TunnelDestination,
) -> Result<SshTunnel, String> {
    let local_port = reserve_ephemeral_port()?;
    let forward = forward_spec(local_port, &destination.host, destination.port);
    let destination_arg = format!("{}@{}", config.username, config.host);

    let mut command = Command::new("ssh");
    command
        .arg("-N")
        .arg("-T")
        .arg("-o")
        .arg("BatchMode=yes")
        .arg("-o")
        .arg("PasswordAuthentication=no")
        .arg("-o")
        .arg("KbdInteractiveAuthentication=no")
        .arg("-o")
        .arg("StrictHostKeyChecking=yes")
        .arg("-o")
        .arg("ExitOnForwardFailure=yes")
        .arg("-o")
        .arg("ConnectTimeout=15")
        .arg("-o")
        .arg("ServerAliveInterval=30")
        .arg("-o")
        .arg("ServerAliveCountMax=3")
        .arg("-p")
        .arg(config.port.to_string())
        .arg("-L")
        .arg(forward);

    if let Some(key_path) = config.key_path.as_deref() {
        command.arg("-i").arg(key_path);
    }

    let mut child = command
        .arg("--")
        .arg(destination_arg)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| {
            format!(
                "Could not start the OpenSSH client: {}. Install or enable the `ssh` command and try again.",
                e
            )
        })?;

    let deadline = Instant::now() + STARTUP_TIMEOUT;
    loop {
        if let Some(status) = match child.try_wait() {
            Ok(status) => status,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("Could not inspect SSH tunnel process: {}", error));
            }
        } {
            return Err(format!(
                "SSH tunnel exited before it was ready ({}). Verify the server, username, key or ssh-agent, and ensure the server key is already trusted in ~/.ssh/known_hosts.",
                status
            ));
        }

        if TcpStream::connect_timeout(
            &std::net::SocketAddr::from(([127, 0, 0, 1], local_port)),
            Duration::from_millis(100),
        )
        .is_ok()
        {
            return Ok(SshTunnel {
                runtime: SshTunnelRuntime::OpenSsh(child),
                local_port,
                destination: destination.clone(),
            });
        }

        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(
                "SSH tunnel did not become ready within 5 seconds. Check SSH connectivity and host-key trust."
                    .to_string(),
            );
        }
        std::thread::sleep(Duration::from_millis(75));
    }
}

fn open_password_tunnel(
    config: &SshTunnelConfig,
    destination: &TunnelDestination,
    password: &str,
) -> Result<SshTunnel, String> {
    // Fail before returning a storage session: verify the bastion credentials,
    // known-host entry, and target forwarding permission once up front.
    let probe = connect_password_session(config, password)?;
    let mut probe_channel = probe
        .channel_direct_tcpip(&destination.host, destination.port, None)
        .map_err(|e| format!("SSH tunnel could not reach the target: {}", e))?;
    let _ = probe_channel.close();
    let _ = probe.disconnect(None, "Galeon tunnel probe complete", None);

    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|e| format!("Could not open a local SSH tunnel port: {}", e))?;
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("Could not configure the local SSH tunnel: {}", e))?;
    let local_port = listener
        .local_addr()
        .map_err(|e| format!("Could not read the local SSH tunnel port: {}", e))?
        .port();

    let shutdown = Arc::new(AtomicBool::new(false));
    let thread_shutdown = Arc::clone(&shutdown);
    let config = config.clone();
    let stored_destination = destination.clone();
    let worker_destination_seed = destination.clone();
    let password = password.to_string();
    let listener_thread = std::thread::spawn(move || {
        while !thread_shutdown.load(Ordering::SeqCst) {
            match listener.accept() {
                Ok((stream, _)) => {
                    let worker_config = config.clone();
                    let worker_destination = worker_destination_seed.clone();
                    let worker_password = password.clone();
                    let worker_shutdown = Arc::clone(&thread_shutdown);
                    std::thread::spawn(move || {
                        let _ = relay_password_connection(
                            stream,
                            &worker_config,
                            &worker_destination,
                            &worker_password,
                            &worker_shutdown,
                        );
                    });
                }
                Err(error) if error.kind() == ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(20));
                }
                Err(_) => break,
            }
        }
    });

    Ok(SshTunnel {
        runtime: SshTunnelRuntime::Password {
            shutdown,
            listener_thread: Some(listener_thread),
        },
        local_port,
        destination: stored_destination,
    })
}

fn connect_password_session(
    config: &SshTunnelConfig,
    password: &str,
) -> Result<ssh2::Session, String> {
    let address = format!("{}:{}", config.host, config.port);
    let addresses = address
        .to_socket_addrs()
        .map_err(|e| format!("Could not resolve SSH tunnel server {}: {}", config.host, e))?;
    let mut tcp = None;
    let mut last_error = None;
    for socket_address in addresses {
        match TcpStream::connect_timeout(&socket_address, Duration::from_secs(15)) {
            Ok(stream) => {
                tcp = Some(stream);
                break;
            }
            Err(error) => last_error = Some(error),
        }
    }
    let tcp = tcp.ok_or_else(|| {
        format!(
            "Could not connect to SSH tunnel server {}:{}: {}",
            config.host,
            config.port,
            last_error
                .map(|error| error.to_string())
                .unwrap_or_else(|| "no network address was available".to_string())
        )
    })?;
    tcp.set_read_timeout(Some(Duration::from_secs(20)))
        .map_err(|e| format!("Could not configure SSH read timeout: {}", e))?;
    tcp.set_write_timeout(Some(Duration::from_secs(20)))
        .map_err(|e| format!("Could not configure SSH write timeout: {}", e))?;

    let mut session =
        ssh2::Session::new().map_err(|e| format!("Could not create SSH tunnel session: {}", e))?;
    session.set_tcp_stream(tcp);
    session
        .handshake()
        .map_err(|e| format!("SSH tunnel handshake failed: {}", e))?;
    crate::ssh_known_hosts::verify(&session, &config.host, config.port, "SSH tunnel server")?;
    session
        .userauth_password(&config.username, password)
        .map_err(|_| {
            "SSH tunnel password authentication failed. Check the username and password."
                .to_string()
        })?;
    if !session.authenticated() {
        return Err("SSH tunnel password authentication failed.".to_string());
    }
    Ok(session)
}

fn relay_password_connection(
    mut local: TcpStream,
    config: &SshTunnelConfig,
    destination: &TunnelDestination,
    password: &str,
    shutdown: &AtomicBool,
) -> Result<(), String> {
    let session = connect_password_session(config, password)?;
    let mut channel = session
        .channel_direct_tcpip(&destination.host, destination.port, None)
        .map_err(|e| format!("SSH tunnel could not open the target channel: {}", e))?;
    session.set_blocking(false);
    local
        .set_nonblocking(true)
        .map_err(|e| format!("Could not configure local tunnel connection: {}", e))?;

    let mut local_open = true;
    let mut local_eof_sent = false;
    let mut remote_open = true;
    let mut to_remote = Vec::<u8>::new();
    let mut to_local = Vec::<u8>::new();
    let mut buffer = [0_u8; 32 * 1024];

    while !shutdown.load(Ordering::SeqCst) {
        let mut progressed = false;

        if local_open && to_remote.len() < 64 * 1024 {
            match local.read(&mut buffer) {
                Ok(0) => {
                    local_open = false;
                    progressed = true;
                }
                Ok(read) => {
                    to_remote.extend_from_slice(&buffer[..read]);
                    progressed = true;
                }
                Err(error) if error.kind() == ErrorKind::WouldBlock => {}
                Err(error) => return Err(format!("Local SSH tunnel read failed: {}", error)),
            }
        }

        if !to_remote.is_empty() {
            match channel.write(&to_remote) {
                Ok(written) => {
                    to_remote.drain(..written);
                    progressed = written > 0 || progressed;
                }
                Err(error) if error.kind() == ErrorKind::WouldBlock => {}
                Err(error) => return Err(format!("SSH tunnel write failed: {}", error)),
            }
        }

        if !local_open && to_remote.is_empty() && !local_eof_sent && channel.send_eof().is_ok() {
            local_eof_sent = true;
            progressed = true;
        }

        if remote_open && to_local.len() < 64 * 1024 {
            match channel.read(&mut buffer) {
                Ok(0) => {
                    remote_open = false;
                    progressed = true;
                }
                Ok(read) => {
                    to_local.extend_from_slice(&buffer[..read]);
                    progressed = true;
                }
                Err(error) if error.kind() == ErrorKind::WouldBlock => {}
                Err(error) => return Err(format!("SSH tunnel read failed: {}", error)),
            }
        }

        if !to_local.is_empty() {
            match local.write(&to_local) {
                Ok(written) => {
                    to_local.drain(..written);
                    progressed = written > 0 || progressed;
                }
                Err(error) if error.kind() == ErrorKind::WouldBlock => {}
                Err(error) => return Err(format!("Local SSH tunnel write failed: {}", error)),
            }
        }

        if !remote_open && to_local.is_empty() {
            break;
        }
        if !progressed {
            std::thread::sleep(Duration::from_millis(2));
        }
    }

    let _ = channel.close();
    let _ = session.disconnect(None, "Galeon tunnel closed", None);
    Ok(())
}

fn reserve_ephemeral_port() -> Result<u16, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|e| format!("Could not reserve a local SSH tunnel port: {}", e))?;
    listener
        .local_addr()
        .map(|addr| addr.port())
        .map_err(|e| format!("Could not read the local SSH tunnel port: {}", e))
}

fn forward_spec(local_port: u16, target_host: &str, target_port: u16) -> String {
    let target = if target_host.contains(':') && !target_host.starts_with('[') {
        format!("[{}]", target_host)
    } else {
        target_host.to_string()
    };
    format!("127.0.0.1:{}:{}:{}", local_port, target, target_port)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base_profile(protocol: &str) -> ConnectionProfile {
        ConnectionProfile {
            id: "p1".to_string(),
            name: "Tunnel".to_string(),
            protocol: Some(protocol.to_string()),
            endpoint: None,
            region: None,
            access_key: None,
            secret_key: None,
            bucket: None,
            danger_disable_ssl_verification: None,
            use_virtual_host_style: None,
            storage_class: None,
            max_bandwidth: None,
            host: None,
            port: None,
            username: None,
            key_path: None,
            passive_mode: None,
            encrypt: None,
            bandwidth_rules: None,
            ssh_tunnel: None,
            ssh_tunnel_profile_id: None,
            has_saved_credentials: None,
        }
    }

    #[test]
    fn derives_and_rewrites_sftp_destination() {
        let mut profile = base_profile("sftp");
        profile.host = Some("db.internal".to_string());
        profile.port = Some(2222);
        let destination = destination_for_profile(&mut profile).unwrap();
        assert_eq!(destination.host, "db.internal");
        assert_eq!(destination.port, 2222);

        rewrite_profile_for_local_port(&mut profile, 49152).unwrap();
        assert_eq!(profile.host.as_deref(), Some("127.0.0.1"));
        assert_eq!(profile.port, Some(49152));
    }

    #[test]
    fn rewrites_http_s3_endpoint_and_preserves_path() {
        let mut profile = base_profile("s3");
        profile.bucket = Some("bucket".to_string());
        profile.endpoint = Some("http://minio.internal:9000/api".to_string());
        let destination = destination_for_profile(&mut profile).unwrap();
        assert_eq!(destination.host, "minio.internal");
        assert_eq!(destination.port, 9000);

        rewrite_profile_for_local_port(&mut profile, 49153).unwrap();
        assert_eq!(
            profile.endpoint.as_deref(),
            Some("http://127.0.0.1:49153/api")
        );
    }

    #[test]
    fn rejects_https_without_explicit_ssl_bypass() {
        let mut profile = base_profile("s3");
        profile.bucket = Some("bucket".to_string());
        profile.endpoint = Some("https://minio.internal".to_string());
        let err = destination_for_profile(&mut profile).unwrap_err();
        assert!(err.contains("HTTPS"));
        assert!(err.contains("Disable SSL Verify"));
    }

    #[test]
    fn rejects_ftp_instead_of_leaking_passive_data_connections() {
        let mut profile = base_profile("ftp");
        let err = destination_for_profile(&mut profile).unwrap_err();
        assert!(err.contains("passive data connections"));
    }

    #[test]
    fn brackets_ipv6_forward_targets() {
        assert_eq!(
            forward_spec(40000, "2001:db8::5", 22),
            "127.0.0.1:40000:[2001:db8::5]:22"
        );
    }

    #[test]
    fn deserialization_defaults_missing_ssh_port() {
        let config: SshTunnelConfig =
            serde_json::from_str(r#"{"host":"bastion.example.com","username":"deploy"}"#).unwrap();
        assert_eq!(config.port, 22);
    }

    #[test]
    fn validation_rejects_zero_port_and_option_like_host() {
        let mut config = SshTunnelConfig {
            host: "bastion.example.com".to_string(),
            port: 0,
            username: "deploy".to_string(),
            key_path: None,
            password: None,
        };
        assert!(validate_config(&config).unwrap_err().contains("port"));
        config.port = 22;
        config.host = "-oProxyCommand=bad".to_string();
        assert!(validate_config(&config).unwrap_err().contains("server"));
    }
}
