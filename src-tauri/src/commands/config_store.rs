// On-disk config: profiles metadata and app settings (no secrets).

use crate::*;

// 5. Connection Profile Commands
fn get_config_path(app_handle: &AppHandleType) -> Result<std::path::PathBuf, String> {
    let config_dir = app_handle
        .path()
        .app_config_dir()
        .map_err(|e| format!("Failed to get config dir: {}", e))?;

    // Create config directory if it doesn't exist
    if !config_dir.exists() {
        std::fs::create_dir_all(&config_dir)
            .map_err(|e| format!("Failed to create config dir: {}", e))?;
    }

    Ok(config_dir.join("config.json"))
}

pub(crate) fn read_config(app_handle: &AppHandleType) -> Result<GaleonConfig, String> {
    let config_path = get_config_path(app_handle)?;

    if !config_path.exists() {
        return Ok(GaleonConfig {
            profiles: Vec::new(),
            presign_history: Vec::new(),
        });
    }

    let config_str = std::fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read config: {}", e))?;

    let config: GaleonConfig =
        serde_json::from_str(&config_str).map_err(|e| format!("Failed to parse config: {}", e))?;

    Ok(config)
}

pub(crate) fn write_config(
    app_handle: &AppHandleType,
    config: &GaleonConfig,
) -> Result<(), String> {
    let config_path = get_config_path(app_handle)?;

    let config_str = serde_json::to_string_pretty(config)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;

    std::fs::write(&config_path, config_str)
        .map_err(|e| format!("Failed to write config: {}", e))?;

    Ok(())
}

fn get_app_settings_path(app_handle: &AppHandleType) -> Result<std::path::PathBuf, String> {
    let config_dir = app_handle
        .path()
        .app_config_dir()
        .map_err(|e| format!("Failed to get config dir: {}", e))?;
    if !config_dir.exists() {
        std::fs::create_dir_all(&config_dir)
            .map_err(|e| format!("Failed to create config dir: {}", e))?;
    }
    Ok(config_dir.join("app_settings.json"))
}

pub(crate) fn default_app_settings() -> AppSettings {
    let now = now_ms();
    AppSettings {
        onboarding_complete: false,
        dual_pane_enabled: false,
        local_pane_path: None,
        theme: None,
        created_at_ms: now,
        updated_at_ms: now,
    }
}

pub(crate) fn read_app_settings(app_handle: &AppHandleType) -> Result<AppSettings, String> {
    let path = get_app_settings_path(app_handle)?;
    if !path.exists() {
        let mut settings = default_app_settings();
        let config = read_config(app_handle)?;
        if !config.profiles.is_empty() {
            settings.onboarding_complete = true;
            write_app_settings(app_handle, &settings)?;
        }
        return Ok(settings);
    }

    let raw = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read app settings: {}", e))?;
    serde_json::from_str(&raw).map_err(|e| format!("Failed to parse app settings: {}", e))
}

pub(crate) fn write_app_settings(
    app_handle: &AppHandleType,
    settings: &AppSettings,
) -> Result<(), String> {
    let path = get_app_settings_path(app_handle)?;
    let raw = serde_json::to_string_pretty(settings)
        .map_err(|e| format!("Failed to serialize app settings: {}", e))?;
    std::fs::write(&path, raw).map_err(|e| format!("Failed to write app settings: {}", e))
}
