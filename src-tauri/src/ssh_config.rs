//! Read named SSH destinations from the user's OpenSSH configuration.
//!
//! Galeon imports the connection fields it already understands instead of
//! creating a second SSH connection path. OpenSSH options such as `ProxyJump`
//! are reported to the SFTP UI, while tunnel imports only expose entries that
//! can be represented safely as a Galeon tunnel profile.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

const MAX_INCLUDE_DEPTH: usize = 16;

/// A concrete, selectable `Host` entry resolved from `~/.ssh/config`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfigConnection {
    pub alias: String,
    pub host: String,
    pub port: u16,
    pub username: Option<String>,
    pub key_path: Option<String>,
    pub proxy_jump: Option<String>,
}

#[derive(Clone, Debug)]
struct Directive {
    patterns: Vec<String>,
    key: String,
    value: String,
}

#[derive(Default)]
struct ParsedConfig {
    aliases: Vec<String>,
    directives: Vec<Directive>,
}

struct ParseContext<'a> {
    home_dir: &'a Path,
    current_patterns: Vec<String>,
    active_files: HashSet<PathBuf>,
    config: ParsedConfig,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ConnectionFilter {
    AllNamedHosts,
    TunnelProfiles,
}

/// List concrete OpenSSH host aliases that Galeon can import into its SFTP form.
///
/// A missing `~/.ssh/config` is treated as an empty list. Malformed individual
/// entries are skipped, while file read failures are returned with their path.
///
/// # Errors
///
/// Returns an error when the home directory cannot be found or an existing SSH
/// config (including an included file) cannot be read.
#[tauri::command]
pub fn list_ssh_config_connections() -> Result<Vec<SshConfigConnection>, String> {
    list_connections(ConnectionFilter::AllNamedHosts)
}

/// List OpenSSH aliases that contain every field needed by a tunnel profile.
///
/// Eligible entries resolve configured `HostName`, `User`, and `IdentityFile`
/// directives and do not use `ProxyJump`, which Galeon tunnel profiles cannot
/// represent. No private-key contents or SSH secrets are read.
///
/// # Errors
///
/// Returns an error when the home directory cannot be found or an existing SSH
/// config (including an included file) cannot be read.
#[tauri::command]
pub fn list_ssh_tunnel_config_connections() -> Result<Vec<SshConfigConnection>, String> {
    list_connections(ConnectionFilter::TunnelProfiles)
}

fn list_connections(filter: ConnectionFilter) -> Result<Vec<SshConfigConnection>, String> {
    let home_dir = dirs::home_dir()
        .ok_or_else(|| "Could not locate your home directory for ~/.ssh/config.".to_string())?;
    let config_path = home_dir.join(".ssh").join("config");
    let local_username = local_username();
    load_connections(&config_path, &home_dir, local_username.as_deref(), filter)
}

fn load_connections(
    config_path: &Path,
    home_dir: &Path,
    local_username: Option<&str>,
    filter: ConnectionFilter,
) -> Result<Vec<SshConfigConnection>, String> {
    if !config_path.exists() {
        return Ok(Vec::new());
    }

    let mut context = ParseContext {
        home_dir,
        current_patterns: vec!["*".to_string()],
        active_files: HashSet::new(),
        config: ParsedConfig::default(),
    };
    parse_file(config_path, 0, &mut context)?;

    let default_identity = default_identity_file(home_dir);
    let mut connections = context
        .config
        .aliases
        .iter()
        .filter_map(|alias| {
            resolve_alias(
                alias,
                &context.config.directives,
                home_dir,
                local_username,
                default_identity.as_deref(),
                filter,
            )
        })
        .collect::<Vec<_>>();
    connections.sort_by(|left, right| {
        left.alias
            .to_ascii_lowercase()
            .cmp(&right.alias.to_ascii_lowercase())
    });
    Ok(connections)
}

fn parse_file(path: &Path, depth: usize, context: &mut ParseContext<'_>) -> Result<(), String> {
    if depth > MAX_INCLUDE_DEPTH {
        return Err(format!(
            "SSH config includes are nested more than {MAX_INCLUDE_DEPTH} levels deep near {}.",
            path.display()
        ));
    }

    let canonical_path = path.canonicalize().map_err(|error| {
        format!(
            "Could not resolve SSH config file {}: {error}",
            path.display()
        )
    })?;
    if !context.active_files.insert(canonical_path.clone()) {
        return Ok(());
    }

    let contents = fs::read_to_string(&canonical_path).map_err(|error| {
        format!(
            "Could not read SSH config file {}: {error}",
            canonical_path.display()
        )
    })?;

    for line in contents.lines() {
        let Some((key, values)) = parse_line(line) else {
            continue;
        };
        if values.is_empty() {
            continue;
        }

        match key.as_str() {
            "host" => {
                context.current_patterns = values;
                for alias in &context.current_patterns {
                    if is_concrete_alias(alias)
                        && !context
                            .config
                            .aliases
                            .iter()
                            .any(|existing| existing.eq_ignore_ascii_case(alias))
                    {
                        context.config.aliases.push(alias.clone());
                    }
                }
            }
            // Match conditions can depend on runtime state (`exec`, canonical host,
            // local network). Do not leak directives from an unevaluated Match block
            // into the preceding Host block; the next Host starts normal parsing again.
            "match" => context.current_patterns.clear(),
            "include" => {
                for pattern in values {
                    for included_path in include_paths(&pattern, &canonical_path, context.home_dir)?
                    {
                        parse_file(&included_path, depth + 1, context)?;
                    }
                }
            }
            "hostname" | "user" | "port" | "identityfile" | "proxyjump" => {
                context.config.directives.push(Directive {
                    patterns: context.current_patterns.clone(),
                    key,
                    value: values.join(" "),
                });
            }
            _ => {}
        }
    }

    context.active_files.remove(&canonical_path);
    Ok(())
}

fn include_paths(
    pattern: &str,
    source_file: &Path,
    home_dir: &Path,
) -> Result<Vec<PathBuf>, String> {
    let expanded = expand_home(pattern, home_dir);
    let absolute_pattern = if expanded.is_absolute() {
        expanded
    } else {
        source_file.parent().unwrap_or(home_dir).join(expanded)
    };
    let pattern_text = absolute_pattern.to_string_lossy();
    let mut paths = Vec::new();
    for path in glob::glob(&pattern_text)
        .map_err(|error| format!("Invalid SSH Include pattern {pattern}: {error}"))?
    {
        let path = path.map_err(|error| {
            format!("Could not read a path matched by SSH Include {pattern}: {error}")
        })?;
        if path.is_file() {
            paths.push(path);
        }
    }
    paths.sort();
    Ok(paths)
}

fn parse_line(line: &str) -> Option<(String, Vec<String>)> {
    let line = strip_comment(line).trim();
    if line.is_empty() {
        return None;
    }

    let split_at = line.find(|character: char| character.is_whitespace() || character == '=');
    let (key, rest) = split_at.map_or((line, ""), |index| {
        let rest = line[index..]
            .trim_start_matches(|character: char| character.is_whitespace() || character == '=')
            .trim();
        (&line[..index], rest)
    });
    Some((key.to_ascii_lowercase(), tokenize(rest)))
}

fn strip_comment(line: &str) -> &str {
    let mut quote = None;
    let mut escaped = false;
    for (index, character) in line.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if character == '\\' {
            escaped = true;
            continue;
        }
        match character {
            '\'' | '"' if quote == Some(character) => quote = None,
            '\'' | '"' if quote.is_none() => quote = Some(character),
            '#' if quote.is_none() => return &line[..index],
            _ => {}
        }
    }
    line
}

fn tokenize(value: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut current = String::new();
    let mut quote = None;
    let mut escaped = false;

    for character in value.chars() {
        if escaped {
            current.push(character);
            escaped = false;
            continue;
        }
        if character == '\\' {
            escaped = true;
            continue;
        }
        match character {
            '\'' | '"' if quote == Some(character) => quote = None,
            '\'' | '"' if quote.is_none() => quote = Some(character),
            character if character.is_whitespace() && quote.is_none() => {
                if !current.is_empty() {
                    words.push(std::mem::take(&mut current));
                }
            }
            _ => current.push(character),
        }
    }
    if escaped {
        current.push('\\');
    }
    if !current.is_empty() {
        words.push(current);
    }
    words
}

fn is_concrete_alias(pattern: &str) -> bool {
    !pattern.starts_with('!')
        && !pattern.is_empty()
        && !pattern
            .chars()
            .any(|character| matches!(character, '*' | '?' | '['))
}

fn resolve_alias(
    alias: &str,
    directives: &[Directive],
    home_dir: &Path,
    local_username: Option<&str>,
    default_identity: Option<&Path>,
    filter: ConnectionFilter,
) -> Option<SshConfigConnection> {
    let matching = directives
        .iter()
        .filter(|directive| patterns_match(&directive.patterns, alias));
    let mut host = None;
    let mut port = None;
    let mut username = None;
    let mut identities = Vec::new();
    let mut identity_files_disabled = false;
    let mut proxy_jump = None;

    for directive in matching {
        match directive.key.as_str() {
            "hostname" if host.is_none() => host = Some(directive.value.clone()),
            "port" if port.is_none() => port = directive.value.parse::<u16>().ok(),
            "user" if username.is_none() => username = Some(directive.value.clone()),
            "identityfile" if directive.value.eq_ignore_ascii_case("none") => {
                identity_files_disabled = true;
                identities.clear();
            }
            "identityfile" if !identity_files_disabled => identities.push(directive.value.clone()),
            "proxyjump"
                if proxy_jump.is_none() && !directive.value.eq_ignore_ascii_case("none") =>
            {
                proxy_jump = Some(directive.value.clone());
            }
            _ => {}
        }
    }

    let has_configured_host = host.is_some();
    let has_configured_username = username.is_some();
    let has_configured_identity = !identity_files_disabled && !identities.is_empty();
    if filter == ConnectionFilter::TunnelProfiles
        && (!has_configured_host
            || !has_configured_username
            || !has_configured_identity
            || proxy_jump.is_some())
    {
        return None;
    }

    let port = port.unwrap_or(22);
    let username = username
        .or_else(|| local_username.map(str::to_owned))
        .map(|user| {
            expand_tokens(
                &user,
                alias,
                local_username,
                Some(&user),
                None,
                port,
                home_dir,
            )
        });
    let remote_username = username.as_deref().or(local_username);
    let host = expand_tokens(
        host.as_deref().unwrap_or(alias),
        alias,
        local_username,
        remote_username,
        None,
        port,
        home_dir,
    );
    if host.trim().is_empty() {
        return None;
    }
    let key_path = if identity_files_disabled {
        None
    } else {
        identities
            .iter()
            .map(|identity| {
                let expanded = expand_tokens(
                    identity,
                    alias,
                    local_username,
                    remote_username,
                    Some(&host),
                    port,
                    home_dir,
                );
                expand_home(&expanded, home_dir)
            })
            .find(|path| path.is_file())
            .or_else(|| {
                identities.first().map(|identity| {
                    let expanded = expand_tokens(
                        identity,
                        alias,
                        local_username,
                        remote_username,
                        Some(&host),
                        port,
                        home_dir,
                    );
                    expand_home(&expanded, home_dir)
                })
            })
            .or_else(|| default_identity.map(Path::to_path_buf))
            .map(|path| path.to_string_lossy().into_owned())
    };

    Some(SshConfigConnection {
        alias: alias.to_string(),
        host,
        port,
        username,
        key_path,
        proxy_jump,
    })
}

fn patterns_match(patterns: &[String], alias: &str) -> bool {
    let mut positive_match = false;
    for pattern in patterns {
        let (negated, pattern) = pattern
            .strip_prefix('!')
            .map_or((false, pattern.as_str()), |value| (true, value));
        if wildcard_match(pattern, alias) {
            if negated {
                return false;
            }
            positive_match = true;
        }
    }
    positive_match
}

fn wildcard_match(pattern: &str, value: &str) -> bool {
    glob::Pattern::new(pattern).is_ok_and(|pattern| {
        pattern.matches_with(
            value,
            glob::MatchOptions {
                case_sensitive: false,
                require_literal_separator: false,
                require_literal_leading_dot: false,
            },
        )
    })
}

fn expand_home(value: &str, home_dir: &Path) -> PathBuf {
    if value == "~" {
        return home_dir.to_path_buf();
    }
    value
        .strip_prefix("~/")
        .map_or_else(|| PathBuf::from(value), |relative| home_dir.join(relative))
}

fn expand_tokens(
    value: &str,
    original_host: &str,
    local_username: Option<&str>,
    remote_username: Option<&str>,
    resolved_host: Option<&str>,
    port: u16,
    home_dir: &Path,
) -> String {
    value
        .replace("%%", "\0")
        .replace("%h", resolved_host.unwrap_or(original_host))
        .replace("%n", original_host)
        .replace("%p", &port.to_string())
        .replace("%r", remote_username.unwrap_or(""))
        .replace("%u", local_username.unwrap_or(""))
        .replace("%d", &home_dir.to_string_lossy())
        .replace('\0', "%")
}

fn default_identity_file(home_dir: &Path) -> Option<PathBuf> {
    ["id_ed25519", "id_ecdsa", "id_rsa"]
        .into_iter()
        .map(|name| home_dir.join(".ssh").join(name))
        .find(|path| path.is_file())
}

fn local_username() -> Option<String> {
    std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .ok()
        .filter(|value| !value.trim().is_empty())
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    fn test_directory(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("galeon-ssh-config-{name}-{}", std::process::id()))
    }

    fn write(path: &Path, contents: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("test parent directory should be creatable");
        }
        fs::write(path, contents).expect("test SSH config should be writable");
    }

    #[test]
    fn resolves_named_host_with_wildcard_defaults() {
        let home = test_directory("defaults");
        let config = home.join(".ssh/config");
        let key = home.join(".ssh/work key");
        write(&key, "private key placeholder");
        write(
            &config,
            r#"
Host production
  HostName files.example.com
  User deploy
  IdentityFile "~/.ssh/work key" # inline comment

Host *
  Port 2202
"#,
        );

        let connections = load_connections(
            &config,
            &home,
            Some("local"),
            ConnectionFilter::AllNamedHosts,
        )
        .expect("valid config should load");

        assert_eq!(connections.len(), 1);
        assert_eq!(
            connections[0],
            SshConfigConnection {
                alias: "production".to_string(),
                host: "files.example.com".to_string(),
                port: 2202,
                username: Some("deploy".to_string()),
                key_path: Some(key.to_string_lossy().into_owned()),
                proxy_jump: None,
            }
        );
        fs::remove_dir_all(home).expect("test directory should be removable");
    }

    #[test]
    fn expands_includes_and_reports_proxy_jump() {
        let home = test_directory("include");
        let config = home.join(".ssh/config");
        write(&config, "Include config.d/*.conf\n");
        write(
            &home.join(".ssh/config.d/work.conf"),
            r#"
Host work-box
  HostName 10.0.0.8
  ProxyJump bastion
"#,
        );

        let connections = load_connections(
            &config,
            &home,
            Some("captain"),
            ConnectionFilter::AllNamedHosts,
        )
        .expect("included config should load");

        assert_eq!(connections.len(), 1);
        assert_eq!(connections[0].alias, "work-box");
        assert_eq!(connections[0].username.as_deref(), Some("captain"));
        assert_eq!(connections[0].proxy_jump.as_deref(), Some("bastion"));
        fs::remove_dir_all(home).expect("test directory should be removable");
    }

    #[test]
    fn skips_wildcard_only_hosts_and_honors_negation() {
        let home = test_directory("patterns");
        let config = home.join(".ssh/config");
        write(
            &config,
            r#"
Host app*
  User wildcard
Host app !app
  User ignored
Host app
  HostName app.internal
"#,
        );

        let connections = load_connections(
            &config,
            &home,
            Some("local"),
            ConnectionFilter::AllNamedHosts,
        )
        .expect("valid patterns should load");

        assert_eq!(connections.len(), 1);
        assert_eq!(connections[0].host, "app.internal");
        assert_eq!(connections[0].username.as_deref(), Some("wildcard"));
        fs::remove_dir_all(home).expect("test directory should be removable");
    }

    #[test]
    fn earlier_values_win_like_openssh() {
        let directives = vec![
            Directive {
                patterns: vec!["*".to_string()],
                key: "user".to_string(),
                value: "global-first".to_string(),
            },
            Directive {
                patterns: vec!["prod".to_string()],
                key: "user".to_string(),
                value: "specific-later".to_string(),
            },
        ];

        let connection = resolve_alias(
            "prod",
            &directives,
            Path::new("/home/me"),
            None,
            None,
            ConnectionFilter::AllNamedHosts,
        )
        .expect("alias should resolve");

        assert_eq!(connection.username.as_deref(), Some("global-first"));
    }

    #[test]
    fn tunnel_list_requires_configured_host_user_and_identity_without_proxy_jump() {
        let home = test_directory("tunnel-fields");
        let config = home.join(".ssh/config");
        let key = home.join(".ssh/tunnel_key");
        write(&key, "private key placeholder");
        write(
            &config,
            r#"
Host complete
  HostName bastion.example.com
  User deploy
  IdentityFile ~/.ssh/tunnel_key

Host missing-hostname
  User deploy
  IdentityFile ~/.ssh/tunnel_key

Host missing-user
  HostName no-user.example.com
  IdentityFile ~/.ssh/tunnel_key

Host missing-key
  HostName no-key.example.com
  User deploy

Host chained
  HostName chained.example.com
  User deploy
  IdentityFile ~/.ssh/tunnel_key
  ProxyJump gateway
"#,
        );

        let connections = load_connections(
            &config,
            &home,
            Some("local"),
            ConnectionFilter::TunnelProfiles,
        )
        .expect("valid tunnel entries should load");

        assert_eq!(connections.len(), 1);
        assert_eq!(connections[0].alias, "complete");
        assert_eq!(connections[0].host, "bastion.example.com");
        assert_eq!(connections[0].port, 22);
        assert_eq!(connections[0].username.as_deref(), Some("deploy"));
        assert_eq!(
            connections[0].key_path.as_deref(),
            Some(key.to_string_lossy().as_ref())
        );
        fs::remove_dir_all(home).expect("test directory should be removable");
    }

    #[test]
    fn does_not_apply_unevaluated_match_directives() {
        let home = test_directory("match");
        let config = home.join(".ssh/config");
        write(
            &config,
            r#"
Host prod
  HostName prod.example.com
Match host prod.example.com
  User conditional-user
Host backup
  HostName backup.example.com
"#,
        );

        let connections = load_connections(
            &config,
            &home,
            Some("local"),
            ConnectionFilter::AllNamedHosts,
        )
        .expect("valid config should load");

        assert_eq!(connections.len(), 2);
        assert_eq!(connections[0].alias, "backup");
        assert_eq!(connections[0].username.as_deref(), Some("local"));
        assert_eq!(connections[1].alias, "prod");
        assert_eq!(connections[1].username.as_deref(), Some("local"));
        fs::remove_dir_all(home).expect("test directory should be removable");
    }
}
