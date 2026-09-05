// Reading an import file: bounded read, envelope validation, preview.

use super::*;

/// Parse a profile export JSON document.
///
/// Accepts:
/// - Canonical `ProfileExportFile`
/// - Bare array of profiles
/// - Object with a `profiles` array (e.g. a config.json snapshot)
pub fn parse_export_json(raw: &str) -> Result<ProfileExportFile, String> {
    let raw = raw.trim().trim_start_matches('\u{feff}');
    if raw.is_empty() {
        return Err("Export file is empty.".to_string());
    }

    if let Ok(file) = serde_json::from_str::<ProfileExportFile>(raw) {
        validate_export_envelope(&file)?;
        return Ok(normalize_export_file(file));
    }

    if let Ok(profiles) = serde_json::from_str::<Vec<ConnectionProfile>>(raw) {
        if profiles.len() > MAX_IMPORT_PROFILES {
            return Err(format!(
                "Import contains too many profiles ({}). Maximum is {}.",
                profiles.len(),
                MAX_IMPORT_PROFILES
            ));
        }
        return Ok(ProfileExportFile {
            format: EXPORT_FORMAT.to_string(),
            version: EXPORT_VERSION,
            exported_at: String::new(),
            includes_secrets: profiles_have_secrets(&profiles),
            profiles,
        });
    }

    // Last resort: object with a profiles key (config.json-like).
    let value: serde_json::Value =
        serde_json::from_str(raw).map_err(|e| format!("Invalid profile export file: {}", e))?;

    // If a format key is present, enforce it even on the fallback path.
    if let Some(fmt) = value.get("format").and_then(|v| v.as_str()) {
        if !fmt.is_empty() && fmt != EXPORT_FORMAT {
            return Err(format!(
                "Unsupported export format {:?}. Expected {:?}.",
                fmt, EXPORT_FORMAT
            ));
        }
    }
    if let Some(ver) = value.get("version").and_then(|v| v.as_u64()) {
        if ver > EXPORT_VERSION as u64 {
            return Err(format!(
                "Export file version {} is newer than this app supports ({}).",
                ver, EXPORT_VERSION
            ));
        }
    }

    let profiles_val = value.get("profiles").ok_or_else(|| {
        "Invalid profile export file: expected galeon.profiles document or a profiles array."
            .to_string()
    })?;
    let profiles: Vec<ConnectionProfile> = serde_json::from_value(profiles_val.clone())
        .map_err(|e| format!("Invalid profiles array in export file: {}", e))?;
    if profiles.len() > MAX_IMPORT_PROFILES {
        return Err(format!(
            "Import contains too many profiles ({}). Maximum is {}.",
            profiles.len(),
            MAX_IMPORT_PROFILES
        ));
    }
    Ok(ProfileExportFile {
        format: EXPORT_FORMAT.to_string(),
        version: EXPORT_VERSION,
        exported_at: String::new(),
        includes_secrets: profiles_have_secrets(&profiles),
        profiles,
    })
}

pub(crate) fn validate_import_path(path: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Import path is required.".to_string());
    }
    let p = PathBuf::from(trimmed);
    if !p.exists() {
        return Err(format!("Import file not found: {}", p.display()));
    }
    if !p.is_file() {
        return Err("Import path must be a regular file.".to_string());
    }
    Ok(p)
}

/// Read import file in one pass; enforce size on the buffer (not a separate stat).
pub(crate) fn read_import_file_limited(path: &Path) -> Result<String, String> {
    use std::io::Read;
    let file =
        std::fs::File::open(path).map_err(|e| format!("Failed to open import file: {}", e))?;
    // Read at most MAX+1 so we can reject oversized files without loading unbounded data.
    let mut buf = Vec::new();
    let mut limited = file.take(MAX_IMPORT_FILE_BYTES.saturating_add(1));
    limited
        .read_to_end(&mut buf)
        .map_err(|e| format!("Failed to read import file: {}", e))?;
    if (buf.len() as u64) > MAX_IMPORT_FILE_BYTES {
        return Err(format!(
            "Import file is too large. Maximum is {} bytes.",
            MAX_IMPORT_FILE_BYTES
        ));
    }
    String::from_utf8(buf).map_err(|e| format!("Import file is not valid UTF-8: {}", e))
}

pub(crate) fn content_hash(raw: &str) -> String {
    format!("{:x}", md5::compute(raw.as_bytes()))
}

pub(crate) fn build_import_preview(
    export: &ProfileExportFile,
    content_hash: String,
) -> ImportPreview {
    let mut profile_names = Vec::with_capacity(export.profiles.len());
    let mut profiles_with_secrets = 0usize;
    let mut danger_ssl_bypass_count = 0usize;
    for p in &export.profiles {
        profile_names.push(p.name.clone());
        if profile_has_exportable_secrets(p) {
            profiles_with_secrets += 1;
        }
        if p.danger_disable_ssl_verification.unwrap_or(false) {
            danger_ssl_bypass_count += 1;
        }
    }
    ImportPreview {
        includes_secrets: export.includes_secrets || profiles_with_secrets > 0,
        total: export.profiles.len(),
        profile_names,
        danger_ssl_bypass_count,
        profiles_with_secrets,
        content_hash,
    }
}
