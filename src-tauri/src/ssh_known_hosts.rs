//! Strict OpenSSH known-host verification shared by native SSH clients.

use std::path::PathBuf;

fn known_hosts_path() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|home| home.join(".ssh").join("known_hosts"))
        .ok_or_else(|| "Could not locate ~/.ssh/known_hosts for SSH host verification.".to_string())
}

pub fn verify(session: &ssh2::Session, host: &str, port: u16, subject: &str) -> Result<(), String> {
    let path = known_hosts_path()?;
    if !path.is_file() {
        return Err(format!(
            "{} is not trusted yet. Connect once with OpenSSH to add it to ~/.ssh/known_hosts.",
            subject
        ));
    }

    let mut known_hosts = session
        .known_hosts()
        .map_err(|e| format!("Could not initialize SSH known-host verification: {}", e))?;
    known_hosts
        .read_file(&path, ssh2::KnownHostFileKind::OpenSSH)
        .map_err(|e| format!("Could not read ~/.ssh/known_hosts: {}", e))?;
    let (host_key, _) = session
        .host_key()
        .ok_or_else(|| format!("{} did not provide a host key.", subject))?;

    match known_hosts.check_port(host, port, host_key) {
        ssh2::CheckResult::Match => Ok(()),
        ssh2::CheckResult::Mismatch => Err(format!(
            "{} host key changed. Refusing to connect; verify the server and update ~/.ssh/known_hosts deliberately.",
            subject
        )),
        ssh2::CheckResult::NotFound => Err(format!(
            "{} is not trusted yet. Connect once with OpenSSH to add it to ~/.ssh/known_hosts.",
            subject
        )),
        ssh2::CheckResult::Failure => {
            Err(format!("Could not verify the {} host key.", subject.to_lowercase()))
        }
    }
}
