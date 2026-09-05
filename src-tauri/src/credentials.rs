use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

pub const KEYRING_SERVICE: &str = "com.fizto.galeon";
const KEYRING_VAULT_ACCOUNT: &str = "__galeon_credentials_v1";

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
pub struct StoredCredentials {
    pub access_key: Option<String>,
    pub secret_key: Option<String>,
    /// Password for the optional SSH bastion. Kept separate so SFTP/FTP and
    /// tunnel passwords can coexist for the same profile.
    #[serde(default)]
    pub ssh_tunnel_password: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
struct CredentialVault {
    profiles: HashMap<String, StoredCredentials>,
}

#[derive(Clone, Debug)]
pub struct CachedSecret {
    pub access_key: Option<String>,
    pub secret_key: Option<String>,
    pub ssh_tunnel_password: Option<String>,
    pub loaded_at_ms: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CredentialUnlockStatus {
    pub cached_secret_count: usize,
    pub unlocked_for_session: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct CredentialMigrationResult {
    pub migrated_profile_count: usize,
    pub skipped_profile_count: usize,
    pub missing_profile_count: usize,
}

/// Session-only in-memory cache for profile credentials.
#[derive(Clone)]
pub struct CredentialCache {
    secrets: Arc<Mutex<HashMap<String, CachedSecret>>>,
    vault_loaded: Arc<AtomicBool>,
    vault_load_lock: Arc<Mutex<()>>,
}

impl Default for CredentialCache {
    fn default() -> Self {
        Self {
            secrets: Arc::new(Mutex::new(HashMap::new())),
            vault_loaded: Arc::new(AtomicBool::new(false)),
            vault_load_lock: Arc::new(Mutex::new(())),
        }
    }
}

impl CredentialCache {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn get(&self, profile_id: &str) -> Option<CachedSecret> {
        self.secrets
            .lock()
            .ok()
            .and_then(|guard| guard.get(profile_id).cloned())
    }

    pub fn insert(
        &self,
        profile_id: &str,
        access_key: Option<String>,
        secret_key: Option<String>,
        ssh_tunnel_password: Option<String>,
        loaded_at_ms: u64,
    ) {
        if let Ok(mut guard) = self.secrets.lock() {
            guard.insert(
                profile_id.to_string(),
                CachedSecret {
                    access_key,
                    secret_key,
                    ssh_tunnel_password,
                    loaded_at_ms,
                },
            );
        }
    }

    pub fn remove(&self, profile_id: &str) {
        if let Ok(mut guard) = self.secrets.lock() {
            guard.remove(profile_id);
        }
    }

    pub fn clear(&self) {
        if let Ok(mut guard) = self.secrets.lock() {
            guard.clear();
        }
        self.vault_loaded.store(false, Ordering::SeqCst);
    }

    pub fn status(&self) -> CredentialUnlockStatus {
        let count = self.secrets.lock().map(|guard| guard.len()).unwrap_or(0);
        CredentialUnlockStatus {
            cached_secret_count: count,
            unlocked_for_session: count > 0,
        }
    }

    fn has_loaded_vault(&self) -> bool {
        self.vault_loaded.load(Ordering::SeqCst)
    }

    fn mark_vault_loaded(&self) {
        self.vault_loaded.store(true, Ordering::SeqCst);
    }
}

#[cfg(test)]
lazy_static::lazy_static! {
    pub static ref MOCK_KEYRING: Mutex<HashMap<String, String>> = Mutex::new(HashMap::new());
}

#[cfg(not(test))]
fn keyring_entry(account: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, account)
        .map_err(|e| format!("Failed to create keyring entry: {}", e))
}

#[cfg(not(test))]
fn read_keyring_password(account: &str, label: &str) -> Result<Option<String>, String> {
    match keyring_entry(account)?.get_password() {
        Ok(password) => Ok(Some(password)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("Failed to load {}: {}", label, e)),
    }
}

#[cfg(not(test))]
fn write_keyring_password(account: &str, password: &str, label: &str) -> Result<(), String> {
    keyring_entry(account)?
        .set_password(password)
        .map_err(|e| format!("Failed to save {}: {}", label, e))?;
    Ok(())
}

#[cfg(not(test))]
fn delete_keyring_password(account: &str) -> Result<(), String> {
    match keyring_entry(account)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("Failed to delete keyring entry: {}", e)),
    }
}

#[cfg(test)]
fn read_keyring_password(account: &str, _label: &str) -> Result<Option<String>, String> {
    let mock = MOCK_KEYRING.lock().unwrap();
    Ok(mock.get(account).cloned())
}

#[cfg(test)]
fn write_keyring_password(account: &str, password: &str, _label: &str) -> Result<(), String> {
    let mut mock = MOCK_KEYRING.lock().unwrap();
    mock.insert(account.to_string(), password.to_string());
    Ok(())
}

#[cfg(test)]
fn delete_keyring_password(account: &str) -> Result<(), String> {
    let mut mock = MOCK_KEYRING.lock().unwrap();
    mock.remove(account);
    Ok(())
}

fn legacy_access_account(profile_id: &str) -> String {
    format!("{}_access", profile_id)
}

fn legacy_secret_account(profile_id: &str) -> String {
    format!("{}_secret", profile_id)
}

fn read_credential_vault() -> Result<CredentialVault, String> {
    let Some(raw) = read_keyring_password(KEYRING_VAULT_ACCOUNT, "credential vault")? else {
        return Ok(CredentialVault::default());
    };

    if raw.trim().is_empty() {
        return Ok(CredentialVault::default());
    }

    serde_json::from_str(&raw).map_err(|e| format!("Failed to parse credential vault: {}", e))
}

fn write_credential_vault(vault: &CredentialVault) -> Result<(), String> {
    let raw = serde_json::to_string(vault)
        .map_err(|e| format!("Failed to serialize credential vault: {}", e))?;
    write_keyring_password(KEYRING_VAULT_ACCOUNT, &raw, "credential vault")
}

fn persist_credential_vault(vault: &CredentialVault) -> Result<(), String> {
    if vault.profiles.is_empty() {
        delete_keyring_password(KEYRING_VAULT_ACCOUNT)
    } else {
        write_credential_vault(vault)
    }
}

fn delete_legacy_credentials(profile_id: &str) -> Result<(), String> {
    delete_keyring_password(&legacy_access_account(profile_id))?;
    delete_keyring_password(&legacy_secret_account(profile_id))?;
    Ok(())
}

fn load_legacy_credentials(profile_id: &str) -> Result<(Option<String>, Option<String>), String> {
    let access_key = read_keyring_password(&legacy_access_account(profile_id), "access key")?;
    let secret_key = read_keyring_password(&legacy_secret_account(profile_id), "secret key")?;
    Ok((access_key, secret_key))
}

fn cache_vault(cache: &CredentialCache, vault: &CredentialVault, loaded_at_ms: u64) {
    for (profile_id, credentials) in &vault.profiles {
        if credentials.access_key.is_some()
            || credentials.secret_key.is_some()
            || credentials.ssh_tunnel_password.is_some()
        {
            cache.insert(
                profile_id,
                credentials.access_key.clone(),
                credentials.secret_key.clone(),
                credentials.ssh_tunnel_password.clone(),
                loaded_at_ms,
            );
        }
    }
}

fn load_vault_once(cache: &CredentialCache, loaded_at_ms: u64) -> Result<(), String> {
    if cache.has_loaded_vault() {
        return Ok(());
    }

    let _guard = cache
        .vault_load_lock
        .lock()
        .map_err(|_| "Credential cache lock poisoned".to_string())?;

    if !cache.has_loaded_vault() {
        let vault = read_credential_vault()?;
        cache_vault(cache, &vault, loaded_at_ms);
        cache.mark_vault_loaded();
    }

    Ok(())
}

fn migrate_legacy_credentials(
    profile_id: &str,
    access_key: Option<String>,
    secret_key: Option<String>,
) -> Result<(), String> {
    if access_key.is_none() && secret_key.is_none() {
        return Ok(());
    }

    let mut vault = read_credential_vault()?;
    let stored = vault.profiles.entry(profile_id.to_string()).or_default();
    stored.access_key = access_key;
    stored.secret_key = secret_key;
    write_credential_vault(&vault)
}

pub fn save_credentials_to_keyring(
    profile_id: &str,
    access_key: &str,
    secret_key: &str,
) -> Result<(), String> {
    let mut vault = read_credential_vault()?;
    let stored = vault.profiles.entry(profile_id.to_string()).or_default();
    stored.access_key = Some(access_key.to_string());
    stored.secret_key = Some(secret_key.to_string());
    write_credential_vault(&vault)
}

pub fn save_password_to_keyring(profile_id: &str, password: &str) -> Result<(), String> {
    let mut vault = read_credential_vault()?;
    let stored = vault.profiles.entry(profile_id.to_string()).or_default();
    stored.access_key = None;
    stored.secret_key = Some(password.to_string());
    write_credential_vault(&vault)
}

pub fn save_ssh_tunnel_password_to_keyring(profile_id: &str, password: &str) -> Result<(), String> {
    let mut vault = read_credential_vault()?;
    let needs_legacy = vault
        .profiles
        .get(profile_id)
        .map(|stored| stored.access_key.is_none() && stored.secret_key.is_none())
        .unwrap_or(true);
    let legacy = if needs_legacy {
        Some(load_legacy_credentials(profile_id)?)
    } else {
        None
    };
    let stored = vault.profiles.entry(profile_id.to_string()).or_default();
    if let Some((legacy_access, legacy_secret)) = legacy {
        stored.access_key = legacy_access;
        stored.secret_key = legacy_secret;
    }
    stored.ssh_tunnel_password = Some(password.to_string());
    write_credential_vault(&vault)
}

pub fn delete_password_from_keyring(profile_id: &str) -> Result<(), String> {
    let mut vault = read_credential_vault()?;
    if let Some(stored) = vault.profiles.get_mut(profile_id) {
        stored.access_key = None;
        stored.secret_key = None;
        if stored.ssh_tunnel_password.is_none() {
            vault.profiles.remove(profile_id);
        }
    }
    persist_credential_vault(&vault)?;
    delete_legacy_credentials(profile_id)
}

pub fn delete_ssh_tunnel_password_from_keyring(profile_id: &str) -> Result<(), String> {
    let mut vault = read_credential_vault()?;
    if let Some(stored) = vault.profiles.get_mut(profile_id) {
        stored.ssh_tunnel_password = None;
        if stored.access_key.is_none() && stored.secret_key.is_none() {
            vault.profiles.remove(profile_id);
        }
    }
    persist_credential_vault(&vault)
}

pub fn load_credentials_from_keyring(
    profile_id: &str,
) -> Result<(Option<String>, Option<String>), String> {
    let vault = read_credential_vault()?;
    if let Some(credentials) = vault.profiles.get(profile_id) {
        if credentials.access_key.is_some() || credentials.secret_key.is_some() {
            return Ok((
                credentials.access_key.clone(),
                credentials.secret_key.clone(),
            ));
        }
    }

    let creds = load_legacy_credentials(profile_id)?;
    if creds.0.is_some() || creds.1.is_some() {
        migrate_legacy_credentials(profile_id, creds.0.clone(), creds.1.clone())?;
    }
    Ok(creds)
}

pub fn load_stored_credentials_from_keyring(profile_id: &str) -> Result<StoredCredentials, String> {
    let (access_key, secret_key) = load_credentials_from_keyring(profile_id)?;
    let ssh_tunnel_password = read_credential_vault()?
        .profiles
        .get(profile_id)
        .and_then(|credentials| credentials.ssh_tunnel_password.clone());
    Ok(StoredCredentials {
        access_key,
        secret_key,
        ssh_tunnel_password,
    })
}

pub fn migrate_legacy_profiles_to_vault(
    cache: &CredentialCache,
    profile_ids: &[String],
    loaded_at_ms: u64,
) -> Result<CredentialMigrationResult, String> {
    let mut vault = read_credential_vault()?;
    let mut result = CredentialMigrationResult::default();

    for profile_id in profile_ids {
        if vault
            .profiles
            .get(profile_id)
            .is_some_and(|stored| stored.access_key.is_some() || stored.secret_key.is_some())
        {
            result.skipped_profile_count += 1;
            continue;
        }

        let (access_key, secret_key) = load_legacy_credentials(profile_id)?;
        if access_key.is_none() && secret_key.is_none() {
            if vault.profiles.contains_key(profile_id) {
                result.skipped_profile_count += 1;
            } else {
                result.missing_profile_count += 1;
            }
            continue;
        }

        let stored = vault.profiles.entry(profile_id.clone()).or_default();
        stored.access_key = access_key.clone();
        stored.secret_key = secret_key.clone();
        cache.insert(
            profile_id,
            access_key,
            secret_key,
            stored.ssh_tunnel_password.clone(),
            loaded_at_ms,
        );
        result.migrated_profile_count += 1;
    }

    if result.migrated_profile_count > 0 {
        write_credential_vault(&vault)?;
    }
    cache_vault(cache, &vault, loaded_at_ms);
    cache.mark_vault_loaded();

    Ok(result)
}

pub fn delete_credentials_from_keyring(profile_id: &str) -> Result<(), String> {
    let mut vault = read_credential_vault()?;
    vault.profiles.remove(profile_id);
    persist_credential_vault(&vault)?;
    delete_legacy_credentials(profile_id)?;
    Ok(())
}

/// Load credentials, preferring the in-memory session cache when available.
pub fn load_credentials_cached(
    cache: &CredentialCache,
    profile_id: &str,
    loaded_at_ms: u64,
) -> Result<(Option<String>, Option<String>), String> {
    if let Some(cached) = cache.get(profile_id) {
        if cached.access_key.is_some() || cached.secret_key.is_some() {
            return Ok((cached.access_key.clone(), cached.secret_key.clone()));
        }
        return load_legacy_credentials_into_cache(cache, profile_id, cached, loaded_at_ms);
    }

    if !cache.has_loaded_vault() {
        load_vault_once(cache, loaded_at_ms)?;
        if let Some(cached) = cache.get(profile_id) {
            if cached.access_key.is_some() || cached.secret_key.is_some() {
                return Ok((cached.access_key.clone(), cached.secret_key.clone()));
            }
            return load_legacy_credentials_into_cache(cache, profile_id, cached, loaded_at_ms);
        }
    }

    let creds = load_legacy_credentials(profile_id)?;
    if creds.0.is_some() || creds.1.is_some() {
        migrate_legacy_credentials(profile_id, creds.0.clone(), creds.1.clone())?;
        cache.insert(
            profile_id,
            creds.0.clone(),
            creds.1.clone(),
            None,
            loaded_at_ms,
        );
    }
    Ok(creds)
}

fn load_legacy_credentials_into_cache(
    cache: &CredentialCache,
    profile_id: &str,
    cached: CachedSecret,
    loaded_at_ms: u64,
) -> Result<(Option<String>, Option<String>), String> {
    let creds = load_legacy_credentials(profile_id)?;
    if creds.0.is_some() || creds.1.is_some() {
        migrate_legacy_credentials(profile_id, creds.0.clone(), creds.1.clone())?;
        cache.insert(
            profile_id,
            creds.0.clone(),
            creds.1.clone(),
            cached.ssh_tunnel_password,
            loaded_at_ms,
        );
    }
    Ok(creds)
}

pub fn update_cache_after_save(
    cache: &CredentialCache,
    profile_id: &str,
    access_key: Option<&str>,
    secret_key: Option<&str>,
    ssh_tunnel_password: Option<&str>,
    loaded_at_ms: u64,
) {
    cache.insert(
        profile_id,
        access_key.map(str::to_string),
        secret_key.map(str::to_string),
        ssh_tunnel_password.map(str::to_string),
        loaded_at_ms,
    );
}

pub fn load_stored_credentials_cached(
    cache: &CredentialCache,
    profile_id: &str,
    loaded_at_ms: u64,
) -> Result<StoredCredentials, String> {
    let (access_key, secret_key) = load_credentials_cached(cache, profile_id, loaded_at_ms)?;
    let ssh_tunnel_password = load_ssh_tunnel_password_cached(cache, profile_id, loaded_at_ms)?;
    Ok(StoredCredentials {
        access_key,
        secret_key,
        ssh_tunnel_password,
    })
}

/// Load the SSH bastion password without conflating it with the storage secret.
pub fn load_ssh_tunnel_password_cached(
    cache: &CredentialCache,
    profile_id: &str,
    loaded_at_ms: u64,
) -> Result<Option<String>, String> {
    if let Some(cached) = cache.get(profile_id) {
        return Ok(cached.ssh_tunnel_password);
    }

    if !cache.has_loaded_vault() {
        load_vault_once(cache, loaded_at_ms)?;
        if let Some(cached) = cache.get(profile_id) {
            return Ok(cached.ssh_tunnel_password);
        }
    }

    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    lazy_static::lazy_static! {
        static ref CRED_TEST_MUTEX: Mutex<()> = Mutex::new(());
    }

    fn fresh_cache() -> CredentialCache {
        MOCK_KEYRING.lock().unwrap().clear();
        CredentialCache::new()
    }

    #[test]
    fn credential_cache_insert_read_clear() {
        let _guard = CRED_TEST_MUTEX.lock().unwrap();
        let cache = fresh_cache();
        cache.insert("p1", Some("ak".into()), Some("sk".into()), None, 1000);
        let got = cache.get("p1").unwrap();
        assert_eq!(got.access_key.as_deref(), Some("ak"));
        assert_eq!(got.secret_key.as_deref(), Some("sk"));

        let status = cache.status();
        assert_eq!(status.cached_secret_count, 1);
        assert!(status.unlocked_for_session);

        cache.clear();
        assert!(cache.get("p1").is_none());
        assert!(!cache.status().unlocked_for_session);
    }

    #[test]
    fn load_credentials_cached_uses_keyring_once() {
        let _guard = CRED_TEST_MUTEX.lock().unwrap();
        let cache = fresh_cache();
        save_credentials_to_keyring("p2", "access", "secret").unwrap();

        let first = load_credentials_cached(&cache, "p2", 1).unwrap();
        assert_eq!(first.0.as_deref(), Some("access"));
        assert_eq!(first.1.as_deref(), Some("secret"));

        MOCK_KEYRING.lock().unwrap().clear();

        let second = load_credentials_cached(&cache, "p2", 2).unwrap();
        assert_eq!(second.0.as_deref(), Some("access"));
        assert_eq!(second.1.as_deref(), Some("secret"));
    }

    #[test]
    fn load_credentials_cached_hydrates_all_vault_profiles() {
        let _guard = CRED_TEST_MUTEX.lock().unwrap();
        let cache = fresh_cache();
        save_credentials_to_keyring("p1", "access-1", "secret-1").unwrap();
        save_credentials_to_keyring("p2", "access-2", "secret-2").unwrap();

        let first = load_credentials_cached(&cache, "p1", 1).unwrap();
        assert_eq!(first.0.as_deref(), Some("access-1"));
        assert_eq!(first.1.as_deref(), Some("secret-1"));

        MOCK_KEYRING.lock().unwrap().clear();

        let second = load_credentials_cached(&cache, "p2", 2).unwrap();
        assert_eq!(second.0.as_deref(), Some("access-2"));
        assert_eq!(second.1.as_deref(), Some("secret-2"));
    }

    #[test]
    fn load_credentials_cached_migrates_legacy_profile_to_vault() {
        let _guard = CRED_TEST_MUTEX.lock().unwrap();
        let cache = fresh_cache();
        {
            let mut mock = MOCK_KEYRING.lock().unwrap();
            mock.insert(legacy_access_account("legacy"), "legacy-access".to_string());
            mock.insert(legacy_secret_account("legacy"), "legacy-secret".to_string());
        }

        let creds = load_credentials_cached(&cache, "legacy", 1).unwrap();
        assert_eq!(creds.0.as_deref(), Some("legacy-access"));
        assert_eq!(creds.1.as_deref(), Some("legacy-secret"));

        let vault_raw = {
            let mock = MOCK_KEYRING.lock().unwrap();
            mock.get(KEYRING_VAULT_ACCOUNT).cloned().unwrap()
        };
        let vault: CredentialVault = serde_json::from_str(&vault_raw).unwrap();
        assert_eq!(
            vault.profiles.get("legacy"),
            Some(&StoredCredentials {
                access_key: Some("legacy-access".to_string()),
                secret_key: Some("legacy-secret".to_string()),
                ssh_tunnel_password: None,
            })
        );
    }

    #[test]
    fn migrate_legacy_profiles_to_vault_copies_all_saved_profiles() {
        let _guard = CRED_TEST_MUTEX.lock().unwrap();
        let cache = fresh_cache();
        {
            let mut mock = MOCK_KEYRING.lock().unwrap();
            mock.insert(legacy_access_account("p1"), "access-1".to_string());
            mock.insert(legacy_secret_account("p1"), "secret-1".to_string());
            mock.insert(legacy_secret_account("p2"), "secret-2".to_string());
        }

        save_credentials_to_keyring("already-vault", "access-v", "secret-v").unwrap();

        let profile_ids = vec![
            "p1".to_string(),
            "p2".to_string(),
            "missing".to_string(),
            "already-vault".to_string(),
        ];
        let result = migrate_legacy_profiles_to_vault(&cache, &profile_ids, 1).unwrap();

        assert_eq!(result.migrated_profile_count, 2);
        assert_eq!(result.missing_profile_count, 1);
        assert_eq!(result.skipped_profile_count, 1);

        assert_eq!(
            cache.get("p1").unwrap().secret_key.as_deref(),
            Some("secret-1")
        );
        assert_eq!(
            cache.get("p2").unwrap().secret_key.as_deref(),
            Some("secret-2")
        );

        let vault = read_credential_vault().unwrap();
        assert_eq!(
            vault.profiles.get("p1"),
            Some(&StoredCredentials {
                access_key: Some("access-1".to_string()),
                secret_key: Some("secret-1".to_string()),
                ssh_tunnel_password: None,
            })
        );
        assert_eq!(
            vault.profiles.get("p2"),
            Some(&StoredCredentials {
                access_key: None,
                secret_key: Some("secret-2".to_string()),
                ssh_tunnel_password: None,
            })
        );
        assert!(vault.profiles.contains_key("already-vault"));
    }

    #[test]
    fn adding_tunnel_password_preserves_legacy_storage_credentials() {
        let _guard = CRED_TEST_MUTEX.lock().unwrap();
        let cache = fresh_cache();
        {
            let mut mock = MOCK_KEYRING.lock().unwrap();
            mock.insert(
                legacy_access_account("legacy-dual"),
                "legacy-access".to_string(),
            );
            mock.insert(
                legacy_secret_account("legacy-dual"),
                "legacy-secret".to_string(),
            );
        }

        save_ssh_tunnel_password_to_keyring("legacy-dual", "tunnel-password").unwrap();
        let stored = load_stored_credentials_cached(&cache, "legacy-dual", 1).unwrap();
        assert_eq!(stored.access_key.as_deref(), Some("legacy-access"));
        assert_eq!(stored.secret_key.as_deref(), Some("legacy-secret"));
        assert_eq!(
            stored.ssh_tunnel_password.as_deref(),
            Some("tunnel-password")
        );
    }

    #[test]
    fn storage_and_tunnel_passwords_are_independent() {
        let _guard = CRED_TEST_MUTEX.lock().unwrap();
        let cache = fresh_cache();

        save_password_to_keyring("dual", "storage-password").unwrap();
        save_ssh_tunnel_password_to_keyring("dual", "tunnel-password").unwrap();
        let storage = load_credentials_cached(&cache, "dual", 1).unwrap();
        let tunnel = load_ssh_tunnel_password_cached(&cache, "dual", 1).unwrap();
        assert_eq!(storage.1.as_deref(), Some("storage-password"));
        assert_eq!(tunnel.as_deref(), Some("tunnel-password"));

        delete_password_from_keyring("dual").unwrap();
        cache.clear();
        assert_eq!(
            load_credentials_cached(&cache, "dual", 2).unwrap(),
            (None, None)
        );
        assert_eq!(
            load_ssh_tunnel_password_cached(&cache, "dual", 2)
                .unwrap()
                .as_deref(),
            Some("tunnel-password")
        );
    }

    #[test]
    fn lock_credentials_clears_only_memory_cache() {
        let _guard = CRED_TEST_MUTEX.lock().unwrap();
        let cache = fresh_cache();
        save_credentials_to_keyring("p3", "a", "b").unwrap();
        load_credentials_cached(&cache, "p3", 1).unwrap();
        assert_eq!(cache.status().cached_secret_count, 1);

        cache.clear();
        assert_eq!(cache.status().cached_secret_count, 0);

        let from_keyring = load_credentials_from_keyring("p3").unwrap();
        assert_eq!(from_keyring.0.as_deref(), Some("a"));
        assert_eq!(from_keyring.1.as_deref(), Some("b"));
    }
}
