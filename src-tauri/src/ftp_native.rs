//! Native FTP/FTPS implementation using suppaftp with native-tls
//!
//! suppaftp v8 uses native-tls for FTPS (no OpenSSL dependency).
//! FTP is synchronous I/O and runs on blocking threads via spawn_blocking.

use serde::{Deserialize, Serialize};
use suppaftp::native_tls::TlsConnector;
use suppaftp::NativeTlsFtpStream;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FtpConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub credential: Option<String>,
    pub secure: bool,
    pub passive: bool,
}

/// Control-channel port to use when a profile does not pin one.
///
/// `FtpSession::connect` always opens the control channel in plaintext and, for
/// `secure`, upgrades it with `into_secure` — that is AUTH TLS, i.e. *explicit*
/// FTPS, which lives on 21 alongside plain FTP. Implicit FTPS (990) expects a TLS
/// handshake before the greeting and is not what this client speaks, so both
/// modes share a default. Mirrored by `defaultPortFor` in `src/components/Connection.tsx`.
pub fn default_port(_secure: bool) -> u16 {
    21
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FtpEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub last_modified: Option<String>,
}

pub struct FtpSession {
    pub stream: NativeTlsFtpStream,
    pub current_dir: String,
}

impl FtpSession {
    pub fn connect(config: &FtpConfig) -> Result<Self, String> {
        let addr = format!("{}:{}", config.host, config.port);

        let mut ftp_stream = NativeTlsFtpStream::connect(&addr)
            .map_err(|e| format!("FTP connect to {} failed: {}", addr, e))?;

        if config.secure {
            let tls =
                TlsConnector::new().map_err(|e| format!("TLS connector create failed: {}", e))?;
            ftp_stream = ftp_stream
                .into_secure(suppaftp::NativeTlsConnector::from(tls), &config.host)
                .map_err(|e| format!("TLS upgrade failed: {}", e))?;
        }

        let cred = config.credential.as_deref().unwrap_or("");
        ftp_stream
            .login(config.username.as_str(), cred)
            .map_err(|e| format!("FTP login failed: {}", e))?;

        let current_dir = ftp_stream.pwd().map_err(|e| format!("PWD failed: {}", e))?;

        Ok(Self {
            stream: ftp_stream,
            current_dir,
        })
    }

    pub fn list_dir(&mut self, path: &str) -> Result<Vec<FtpEntry>, String> {
        let path = crate::sftp_native::collapse_slashes(path);
        self.stream
            .cwd(&path)
            .map_err(|e| format!("CWD {}: {}", path, e))?;

        let cwd = crate::sftp_native::collapse_slashes(
            &self.stream.pwd().map_err(|e| format!("PWD: {}", e))?,
        );

        let names = self.stream.nlst(None).map_err(|e| format!("NLST: {}", e))?;

        let mut result = Vec::new();
        for raw_name in names {
            let name = crate::sftp_native::entry_basename(&raw_name);
            if name == "." || name == ".." || name.is_empty() {
                continue;
            }

            let full_path = crate::sftp_native::join_fs_path(&cwd, &name);

            // Try SIZE command to get file size
            let file_size = self.stream.size(&name).ok();

            // Determine if directory by trying to CWD into it
            let is_dir = self.stream.cwd(&name).is_ok();
            if is_dir {
                let _ = self.stream.cwd(&cwd);
            }

            result.push(FtpEntry {
                name,
                path: full_path,
                is_dir,
                size: file_size.unwrap_or(0) as u64,
                last_modified: None,
            });
        }

        let _ = self.stream.cwd(&self.current_dir);
        Ok(result)
    }

    pub fn download(&mut self, remote: &str, local: &str) -> Result<(), String> {
        let reader = self
            .stream
            .retr_as_buffer(remote)
            .map_err(|e| format!("RETR {}: {}", remote, e))?;

        if let Some(parent) = std::path::Path::new(local).parent() {
            let _ = std::fs::create_dir_all(parent);
        }

        let mut file =
            std::fs::File::create(local).map_err(|e| format!("Create local {}: {}", local, e))?;

        use std::io::Write;
        let data = reader.into_inner();
        file.write_all(&data).map_err(|e| format!("Write: {}", e))?;

        Ok(())
    }

    pub fn upload(&mut self, local: &str, remote: &str) -> Result<(), String> {
        let mut file =
            std::fs::File::open(local).map_err(|e| format!("Open local {}: {}", local, e))?;

        self.stream
            .put_file(remote, &mut file)
            .map_err(|e| format!("STOR {}: {}", remote, e))?;
        Ok(())
    }

    pub fn file_size(&mut self, path: &str) -> Result<u64, String> {
        self.stream
            .size(path)
            .map_err(|e| format!("SIZE {}: {}", path, e))
            .map(|s| s as u64)
    }

    pub fn exists(&mut self, path: &str) -> bool {
        self.stream.size(path).is_ok() || self.stream.cwd(path).is_ok()
    }

    pub fn mkdir(&mut self, path: &str) -> Result<(), String> {
        self.stream
            .mkdir(path)
            .map_err(|e| format!("MKD {}: {}", path, e))
    }

    pub fn remove(&mut self, path: &str, is_dir: bool) -> Result<(), String> {
        if is_dir {
            self.stream
                .rmdir(path)
                .map_err(|e| format!("RMD {}: {}", path, e))
        } else {
            self.stream
                .rm(path)
                .map_err(|e| format!("DELE {}: {}", path, e))
        }
    }

    pub fn rename(&mut self, from: &str, to: &str) -> Result<(), String> {
        self.stream
            .rename(from, to)
            .map_err(|e| format!("RNFR {} -> {}: {}", from, to, e))
    }

    pub fn pwd(&mut self) -> Result<String, String> {
        self.stream.pwd().map_err(|e| format!("PWD: {}", e))
    }

    pub fn quit(&mut self) -> Result<(), String> {
        self.stream
            .quit()
            .map_err(|e| format!("QUIT failed: {}", e))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ftp_config_roundtrip() {
        let c = FtpConfig {
            host: "ftp.test.org".into(),
            port: 21,
            username: "test_user".into(),
            credential: Some("dummy_val".into()),
            secure: false,
            passive: true,
        };
        let j = serde_json::to_string_pretty(&c).unwrap();
        let d: FtpConfig = serde_json::from_str(&j).unwrap();
        assert_eq!(d.host, "ftp.test.org");
        assert_eq!(d.port, 21);
        assert!(!d.secure);
        assert!(d.credential.is_some());
    }

    #[test]
    fn test_ftps_config() {
        let c = FtpConfig {
            host: "ftps.test.org".into(),
            port: default_port(true),
            username: "admin".into(),
            credential: None,
            secure: true,
            passive: true,
        };
        let j = serde_json::to_string_pretty(&c).unwrap();
        let d: FtpConfig = serde_json::from_str(&j).unwrap();
        assert!(d.secure);
        assert_eq!(d.port, 21);
        assert!(d.credential.is_none());
    }

    /// `connect` upgrades a plaintext control channel with `into_secure` (AUTH TLS),
    /// so FTPS must default to the explicit-FTPS port. 990 is implicit FTPS, where the
    /// server never sends a plaintext greeting and this client would hang or fail.
    #[test]
    fn test_default_port_is_explicit_ftps() {
        assert_eq!(default_port(false), 21);
        assert_eq!(default_port(true), 21);
        assert_ne!(default_port(true), 990);
    }

    #[test]
    fn test_ftp_entry_file() {
        let e = FtpEntry {
            name: "readme.txt".into(),
            path: "/pub/readme.txt".into(),
            is_dir: false,
            size: 2048,
            last_modified: None,
        };
        let j = serde_json::to_string_pretty(&e).unwrap();
        let d: FtpEntry = serde_json::from_str(&j).unwrap();
        assert_eq!(d.name, "readme.txt");
        assert!(!d.is_dir);
        assert_eq!(d.size, 2048);
    }

    #[test]
    fn test_ftp_entry_dir() {
        let e = FtpEntry {
            name: "subdir".into(),
            path: "/pub/subdir".into(),
            is_dir: true,
            size: 0,
            last_modified: Some("2024-06-01T00:00:00Z".into()),
        };
        let j = serde_json::to_string_pretty(&e).unwrap();
        let d: FtpEntry = serde_json::from_str(&j).unwrap();
        assert!(d.is_dir);
        assert!(d.last_modified.is_some());
    }

    #[test]
    fn test_ftp_anon_config() {
        let c = FtpConfig {
            host: "public.ftp.test".into(),
            port: 21,
            username: "anonymous".into(),
            credential: None,
            secure: false,
            passive: true,
        };
        let j = serde_json::to_string_pretty(&c).unwrap();
        let d: FtpConfig = serde_json::from_str(&j).unwrap();
        assert_eq!(d.username, "anonymous");
        assert!(d.credential.is_none());
    }
}
