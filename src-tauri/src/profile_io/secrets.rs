// The keyring side of export/import: pull secrets out, or apply them.

use super::*;

/// Extract complete credentials only.
/// S3 requires both access_key and secret_key; partial pairs are ignored.
pub(crate) fn extract_pending_credentials(
    profile: &ConnectionProfile,
) -> Option<PendingCredentials> {
    let protocol = profile
        .protocol
        .as_deref()
        .unwrap_or("s3")
        .to_ascii_lowercase();
    let ak = profile.access_key.clone().filter(|s| !s.is_empty());
    let sk = profile.secret_key.clone().filter(|s| !s.is_empty());
    let ssh_tunnel_password = profile
        .ssh_tunnel
        .as_ref()
        .and_then(|tunnel| tunnel.password.clone())
        .filter(|s| !s.is_empty());
    let (access_key, secret_key) = if protocol == "s3" {
        match (ak, sk) {
            (Some(access_key), Some(secret_key)) => (Some(access_key), Some(secret_key)),
            _ => (None, None),
        }
    } else {
        (None, sk)
    };

    if access_key.is_none() && secret_key.is_none() && ssh_tunnel_password.is_none() {
        return None;
    }
    Some(PendingCredentials {
        profile_id: profile.id.clone(),
        access_key,
        secret_key,
        ssh_tunnel_password,
        protocol,
    })
}

pub(crate) fn persist_pending_credentials(
    state: &GaleonEngine,
    pending: &[PendingCredentials],
) -> Result<(), String> {
    let loaded_at = now_ms();
    for creds in pending {
        if creds.protocol == "s3" {
            // Only complete S3 pairs reach here from extract_pending_credentials.
            if let (Some(ak), Some(sk)) = (&creds.access_key, &creds.secret_key) {
                credentials::save_credentials_to_keyring(&creds.profile_id, ak, sk)?;
            }
        } else if let Some(pw) = creds.secret_key.as_ref() {
            credentials::save_password_to_keyring(&creds.profile_id, pw)?;
        }
        if let Some(pw) = creds.ssh_tunnel_password.as_ref() {
            credentials::save_ssh_tunnel_password_to_keyring(&creds.profile_id, pw)?;
        }

        let stored = credentials::load_stored_credentials_from_keyring(&creds.profile_id)?;
        credentials::update_cache_after_save(
            &state.credential_cache,
            &creds.profile_id,
            stored.access_key.as_deref(),
            stored.secret_key.as_deref(),
            stored.ssh_tunnel_password.as_deref(),
            loaded_at,
        );
    }
    Ok(())
}

pub(crate) fn delete_profile_credentials(
    state: &GaleonEngine,
    profile_ids: &[String],
) -> Result<(), String> {
    for id in profile_ids {
        credentials::delete_credentials_from_keyring(id)?;
        state.credential_cache.remove(id);
    }
    Ok(())
}
