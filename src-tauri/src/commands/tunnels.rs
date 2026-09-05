// SSH key generation and tunnel helpers exposed to the UI.

use crate::*;

#[tauri::command]
pub async fn delete_ssh_tunnel_profile(
    app_handle: AppHandleType,
    state: tauri::State<'_, GaleonEngine>,
    profile_id: String,
) -> Result<(), String> {
    let config = read_config(&app_handle)?;
    let used_by: Vec<&str> = config
        .profiles
        .iter()
        .filter(|profile| profile.ssh_tunnel_profile_id.as_deref() == Some(profile_id.as_str()))
        .map(|profile| profile.name.as_str())
        .collect();
    if !used_by.is_empty() {
        return Err(format!(
            "SSH tunnel profile is used by: {}. Remove it from those connection profiles first.",
            used_by.join(", ")
        ));
    }
    ssh_tunnel_profiles::delete_profile(&app_handle, state.inner(), &profile_id)
}

#[tauri::command]
pub async fn generate_ssh_key(key_path: String) -> Result<serde_json::Value, String> {
    use std::process::Command;

    // Ensure .ssh directory exists
    let key_dir = std::path::Path::new(&key_path)
        .parent()
        .ok_or("Invalid key path")?;
    std::fs::create_dir_all(key_dir)
        .map_err(|e| format!("Failed to create .ssh directory: {}", e))?;

    // Generate ed25519 key (most secure, short key)
    let output = Command::new("ssh-keygen")
        .args([
            "-t",
            "ed25519",
            "-f",
            &key_path,
            "-N",
            "", // No passphrase for simplicity
            "-C",
            "galeon@localhost",
        ])
        .output()
        .map_err(|e| format!("Failed to run ssh-keygen: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("ssh-keygen failed: {}", stderr));
    }

    // Read public key
    let pub_key_path = format!("{}.pub", key_path);
    let public_key = std::fs::read_to_string(&pub_key_path)
        .map_err(|e| format!("Failed to read public key: {}", e))?;

    Ok(serde_json::json!({
        "privateKey": key_path,
        "publicKey": public_key.trim(),
    }))
}

#[tauri::command]
pub async fn get_home_dir() -> Result<String, String> {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .ok_or("Failed to get home directory".to_string())
}
