//! Native SFTP implementation
//! Uses ssh2 crate for fallback auth

use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NativeSftpConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub credential: Option<String>,
    pub key_path: Option<String>,
    #[serde(default)]
    pub known_host: Option<String>,
    #[serde(default)]
    pub known_host_port: Option<u16>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SftpEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub last_modified: Option<String>,
}

pub struct NativeSftpSession {
    pub session: ssh2::Session,
    _tcp: std::net::TcpStream,
}

/// Collapse duplicate slashes; preserve a single leading slash for absolute paths.
pub fn collapse_slashes(path: &str) -> String {
    if path.is_empty() {
        return String::new();
    }
    let is_abs = path.starts_with('/');
    let parts: Vec<&str> = path.split('/').filter(|p| !p.is_empty()).collect();
    if parts.is_empty() {
        return if is_abs {
            "/".to_string()
        } else {
            String::new()
        };
    }
    let mut out = parts.join("/");
    if is_abs {
        out.insert(0, '/');
    }
    out
}

/// Last path segment — readdir may return a full path instead of a bare name.
pub fn entry_basename(raw: &str) -> String {
    raw.rsplit('/')
        .find(|s| !s.is_empty())
        .unwrap_or(raw)
        .to_string()
}

/// Join a directory and entry name without duplicating path segments.
pub fn join_fs_path(base: &str, name: &str) -> String {
    let base = collapse_slashes(base.trim_end_matches('/'));
    let name = entry_basename(name);
    if name.is_empty() {
        return base;
    }
    if base.is_empty() || base == "/" {
        collapse_slashes(&format!("/{}", name))
    } else {
        collapse_slashes(&format!("{}/{}", base, name))
    }
}

unsafe impl Send for NativeSftpSession {}
unsafe impl Sync for NativeSftpSession {}

impl NativeSftpSession {
    pub fn connect(config: &NativeSftpConfig) -> Result<Self, String> {
        let addr = format!("{}:{}", config.host, config.port);
        let addresses = addr
            .to_socket_addrs()
            .map_err(|e| format!("Could not resolve SFTP host {}: {}", config.host, e))?;
        let mut tcp = None;
        let mut last_error = None;
        for socket_address in addresses {
            match TcpStream::connect_timeout(&socket_address, std::time::Duration::from_secs(15)) {
                Ok(stream) => {
                    tcp = Some(stream);
                    break;
                }
                Err(error) => last_error = Some(error),
            }
        }
        let tcp = tcp.ok_or_else(|| {
            format!(
                "Could not connect to SFTP host {}:{}: {}",
                config.host,
                config.port,
                last_error
                    .map(|error| error.to_string())
                    .unwrap_or_else(|| "no network address was available".to_string())
            )
        })?;
        let mut session = ssh2::Session::new().map_err(|e| format!("SSH session fail: {}", e))?;
        session.set_tcp_stream(tcp.try_clone().map_err(|e| e.to_string())?);
        session
            .handshake()
            .map_err(|e| format!("SSH handshake fail: {}", e))?;
        crate::ssh_known_hosts::verify(
            &session,
            config.known_host.as_deref().unwrap_or(&config.host),
            config.known_host_port.unwrap_or(config.port),
            "SFTP server",
        )?;
        if let Some(ref c) = config.credential {
            session
                .userauth_password(&config.username, c)
                .map_err(|_| {
                    "SFTP password authentication failed. Check the username and password."
                        .to_string()
                })?;
        } else if let Some(ref kp) = config.key_path {
            let kf = Path::new(kp);
            if !kf.exists() {
                return Err(format!("Key file not found: {}", kp));
            }
            session
                .userauth_pubkey_file(&config.username, None, kf, None)
                .map_err(|e| format!("Key auth fail: {}", e))?;
        } else {
            return Err("No auth method. Provide credential or key_path.".to_string());
        }
        if !session.authenticated() {
            return Err("Auth failed after login attempt".to_string());
        }
        Ok(Self { session, _tcp: tcp })
    }

    pub fn file_size(&self, path: &str) -> Result<u64, String> {
        let sftp = self
            .session
            .sftp()
            .map_err(|e| format!("SFTP init: {}", e))?;
        let st = sftp
            .stat(Path::new(path))
            .map_err(|e| format!("stat {}: {}", path, e))?;
        st.size.ok_or_else(|| format!("No size for {}", path))
    }

    pub fn exists(&self, path: &str) -> bool {
        self.session
            .sftp()
            .and_then(|s| s.stat(Path::new(path)))
            .is_ok()
    }

    /// Get the current working directory from the SFTP server
    pub fn pwd(&self) -> Result<String, String> {
        let sftp = self
            .session
            .sftp()
            .map_err(|e| format!("SFTP init: {}", e))?;
        sftp.realpath(Path::new("."))
            .map(|p| p.to_string_lossy().to_string())
            .map_err(|e| format!("realpath failed: {}", e))
    }

    /// Normalize a path to be absolute (starting with /)
    fn normalize_path(&self, path: &str, cwd: &str) -> String {
        let cwd = collapse_slashes(cwd);
        let path = path.trim();
        if path.is_empty() {
            return cwd;
        }
        if path.starts_with('/') {
            return collapse_slashes(path);
        }
        if path.starts_with("./") || path == "." {
            let relative = path.strip_prefix("./").unwrap_or("");
            if relative.is_empty() {
                return cwd;
            }
            return join_fs_path(&cwd, relative);
        }
        join_fs_path(&cwd, path)
    }

    pub fn list_dir(&self, path: &str) -> Result<Vec<SftpEntry>, String> {
        let sftp = self
            .session
            .sftp()
            .map_err(|e| format!("SFTP init: {}", e))?;

        // Get current working directory for path normalization
        let cwd = collapse_slashes(&self.pwd()?);

        // Normalize the input path
        let normalized_path = self.normalize_path(path, &cwd);

        let dir = sftp
            .readdir(Path::new(&normalized_path))
            .map_err(|e| format!("readdir {}: {}", normalized_path, e))?;
        let mut entries = Vec::new();
        for (fname, fs) in dir {
            let raw = fname.to_string_lossy();
            let name = entry_basename(&raw);
            if name == "." || name == ".." {
                continue;
            }
            let fp = join_fs_path(&normalized_path, &name);
            entries.push(SftpEntry {
                name,
                path: fp,
                is_dir: fs.is_dir(),
                size: fs.size.unwrap_or(0),
                last_modified: fs.mtime.map(|t| {
                    chrono::DateTime::from_timestamp(t as i64, 0)
                        .map(|dt| dt.to_rfc3339())
                        .unwrap_or_default()
                }),
            });
        }
        Ok(entries)
    }

    pub fn download(&self, remote: &str, local: &str) -> Result<(), String> {
        use std::io::Write;
        let sftp = self
            .session
            .sftp()
            .map_err(|e| format!("SFTP init: {}", e))?;
        let mut rf = sftp
            .open(Path::new(remote))
            .map_err(|e| format!("open remote {}: {}", remote, e))?;
        let mut lf =
            std::fs::File::create(local).map_err(|e| format!("create local {}: {}", local, e))?;
        let mut buf = vec![0u8; 65536];
        loop {
            let n = rf.read(&mut buf).map_err(|e| format!("read: {}", e))?;
            if n == 0 {
                break;
            }
            lf.write_all(&buf[..n])
                .map_err(|e| format!("write: {}", e))?;
        }
        Ok(())
    }

    pub fn download_with_progress<F>(
        &self,
        remote: &str,
        local: &str,
        mut cb: F,
    ) -> Result<(), String>
    where
        F: FnMut(u64, u64),
    {
        use std::io::Write;
        let sftp = self
            .session
            .sftp()
            .map_err(|e| format!("SFTP init: {}", e))?;
        let st = sftp
            .stat(Path::new(remote))
            .map_err(|e| format!("stat {}: {}", remote, e))?;
        let total = st.size.unwrap_or(0);
        let mut rf = sftp
            .open(Path::new(remote))
            .map_err(|e| format!("open {}: {}", remote, e))?;
        let mut lf =
            std::fs::File::create(local).map_err(|e| format!("create {}: {}", local, e))?;
        let mut buf = vec![0u8; 65536];
        let mut xfer = 0u64;
        loop {
            let n = rf.read(&mut buf).map_err(|e| format!("read: {}", e))?;
            if n == 0 {
                break;
            }
            lf.write_all(&buf[..n])
                .map_err(|e| format!("write: {}", e))?;
            xfer += n as u64;
            cb(xfer, total);
        }
        Ok(())
    }

    pub fn upload(&self, local: &str, remote: &str) -> Result<(), String> {
        use std::io::Read;
        let sftp = self
            .session
            .sftp()
            .map_err(|e| format!("SFTP init: {}", e))?;
        let mut lf =
            std::fs::File::open(local).map_err(|e| format!("open local {}: {}", local, e))?;
        let mut rf = sftp
            .create(Path::new(remote))
            .map_err(|e| format!("create remote {}: {}", remote, e))?;
        let mut buf = vec![0u8; 65536];
        loop {
            let n = lf.read(&mut buf).map_err(|e| format!("read: {}", e))?;
            if n == 0 {
                break;
            }
            rf.write_all(&buf[..n])
                .map_err(|e| format!("write: {}", e))?;
        }
        Ok(())
    }

    pub fn upload_with_progress<F>(
        &self,
        local: &str,
        remote: &str,
        mut cb: F,
    ) -> Result<(), String>
    where
        F: FnMut(u64, u64),
    {
        use std::io::Read;
        let total = std::fs::metadata(local)
            .map_err(|e| format!("meta {}: {}", local, e))?
            .len();
        let sftp = self
            .session
            .sftp()
            .map_err(|e| format!("SFTP init: {}", e))?;
        let mut lf = std::fs::File::open(local).map_err(|e| format!("open {}: {}", local, e))?;
        let mut rf = sftp
            .create(Path::new(remote))
            .map_err(|e| format!("create {}: {}", remote, e))?;
        let mut buf = vec![0u8; 65536];
        let mut xfer = 0u64;
        loop {
            let n = lf.read(&mut buf).map_err(|e| format!("read: {}", e))?;
            if n == 0 {
                break;
            }
            rf.write_all(&buf[..n])
                .map_err(|e| format!("write: {}", e))?;
            xfer += n as u64;
            cb(xfer, total);
        }
        Ok(())
    }

    pub fn mkdir(&self, path: &str) -> Result<(), String> {
        let sftp = self
            .session
            .sftp()
            .map_err(|e| format!("SFTP init: {}", e))?;
        sftp.mkdir(Path::new(path), 0o755)
            .map_err(|e| format!("mkdir {}: {}", path, e))
    }

    pub fn remove(&self, path: &str, is_dir: bool) -> Result<(), String> {
        let sftp = self
            .session
            .sftp()
            .map_err(|e| format!("SFTP init: {}", e))?;
        if is_dir {
            sftp.rmdir(Path::new(path))
                .map_err(|e| format!("rmdir {}: {}", path, e))
        } else {
            sftp.unlink(Path::new(path))
                .map_err(|e| format!("unlink {}: {}", path, e))
        }
    }

    pub fn rename(&self, from: &str, to: &str) -> Result<(), String> {
        let sftp = self
            .session
            .sftp()
            .map_err(|e| format!("SFTP init: {}", e))?;
        sftp.rename(Path::new(from), Path::new(to), None)
            .map_err(|e| format!("rename {} -> {}: {}", from, to, e))
    }

    pub fn remove_all(&self, path: &str) -> Result<(), String> {
        for e in self.list_dir(path)? {
            if e.is_dir {
                self.remove_all(&e.path)?;
            } else {
                self.remove(&e.path, false)?;
            }
        }
        self.remove(path, true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_config_roundtrip() {
        let c = NativeSftpConfig {
            host: "host.example".into(),
            port: 22,
            username: "usr".into(),
            credential: Some("tok_xyz".into()),
            key_path: None,
            known_host: None,
            known_host_port: None,
        };
        let j = serde_json::to_string_pretty(&c).unwrap();
        let d: NativeSftpConfig = serde_json::from_str(&j).unwrap();
        assert_eq!(d.host, "host.example");
        assert_eq!(d.port, 22);
        assert_eq!(d.credential, Some("tok_xyz".into()));
    }

    #[test]
    fn test_config_key_only() {
        let c = NativeSftpConfig {
            host: "host.example".into(),
            port: 2222,
            username: "admin".into(),
            credential: None,
            key_path: Some("/tmp/id_rsa".into()),
            known_host: None,
            known_host_port: None,
        };
        let j = serde_json::to_string_pretty(&c).unwrap();
        let d: NativeSftpConfig = serde_json::from_str(&j).unwrap();
        assert_eq!(d.port, 2222);
        assert!(d.credential.is_none());
        assert_eq!(d.key_path.unwrap(), "/tmp/id_rsa");
    }

    #[test]
    fn test_config_no_auth() {
        let c = NativeSftpConfig {
            host: "host.example".into(),
            port: 22,
            username: "usr".into(),
            credential: None,
            key_path: None,
            known_host: None,
            known_host_port: None,
        };
        let j = serde_json::to_string_pretty(&c).unwrap();
        let d: NativeSftpConfig = serde_json::from_str(&j).unwrap();
        assert!(d.credential.is_none() && d.key_path.is_none());
    }

    #[test]
    fn test_entry_file() {
        let e = SftpEntry {
            name: "f.txt".into(),
            path: "/a/f.txt".into(),
            is_dir: false,
            size: 999,
            last_modified: Some("2024-06-01T00:00:00Z".into()),
        };
        let j = serde_json::to_string_pretty(&e).unwrap();
        let d: SftpEntry = serde_json::from_str(&j).unwrap();
        assert_eq!(d.name, "f.txt");
        assert!(!d.is_dir);
        assert_eq!(d.size, 999);
    }

    #[test]
    fn test_entry_dir() {
        let e = SftpEntry {
            name: "docs".into(),
            path: "/a/docs".into(),
            is_dir: true,
            size: 0,
            last_modified: None,
        };
        let j = serde_json::to_string_pretty(&e).unwrap();
        let d: SftpEntry = serde_json::from_str(&j).unwrap();
        assert!(d.is_dir);
        assert!(d.last_modified.is_none());
    }

    #[test]
    fn test_collapse_slashes() {
        assert_eq!(collapse_slashes("//home///admin"), "/home/admin");
        assert_eq!(collapse_slashes("/home/"), "/home");
        assert_eq!(collapse_slashes(""), "");
    }

    #[test]
    fn test_entry_basename() {
        assert_eq!(entry_basename("/home/testuser"), "testuser");
        assert_eq!(entry_basename("testuser"), "testuser");
        assert_eq!(entry_basename("//home/admin"), "admin");
    }

    #[test]
    fn test_join_fs_path() {
        assert_eq!(join_fs_path("/home", "/home/testuser"), "/home/testuser");
        assert_eq!(join_fs_path("//home", "admin"), "/home/admin");
        assert_eq!(join_fs_path("/home", "admin"), "/home/admin");
    }
}
