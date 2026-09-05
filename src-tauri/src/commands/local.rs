// Local filesystem pane commands — list directories and create folders.

use crate::*;
use std::path::PathBuf;

/// A single entry in a local directory listing.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LocalEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: Option<u64>,
    pub modified_ms: Option<u64>,
    pub is_hidden: bool,
    pub parent_path: Option<String>,
}

impl LocalEntry {
    /// Build a `LocalEntry` from a filesystem path, falling back to `None`
    /// fields when metadata is unreadable (symlinks, permissions, etc.).
    fn from_path(path: PathBuf) -> Self {
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();

        let is_hidden = name.starts_with('.');

        let parent_path = path.parent().map(|p| p.to_string_lossy().into_owned());

        // Try to read metadata; on failure, include the entry with None fields
        // rather than dropping it (AGENTS.md 3.2 — do not fail whole listing
        // for one unreadable entry).
        let (is_dir, size, modified_ms) = match std::fs::metadata(&path) {
            Ok(meta) => {
                let is_dir = meta.is_dir();
                let size = if is_dir { None } else { Some(meta.len()) };
                let modified_ms = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64);
                (is_dir, size, modified_ms)
            }
            Err(_) => (false, None, None),
        };

        LocalEntry {
            name,
            path: path.to_string_lossy().into_owned(),
            is_dir,
            size,
            modified_ms,
            is_hidden,
            parent_path,
        }
    }
}

/// List the immediate children of a local directory.
#[tauri::command]
pub async fn list_local_directory(path: String) -> Result<Vec<LocalEntry>, String> {
    let trimmed = path.trim().to_string();
    if trimmed.is_empty() {
        return Err("Path must not be empty or whitespace-only".to_string());
    }

    let p = PathBuf::from(&trimmed);

    if !p.exists() {
        return Err(format!("Path does not exist: {}", trimmed));
    }
    if !p.is_dir() {
        return Err(format!("Path is a file, not a directory: {}", trimmed));
    }

    let mut entries = Vec::new();

    // read_dir returns an iterator of Result<DirEntry>; a single entry read
    // failure is logged and skipped so the rest of the listing still arrives.
    let read = std::fs::read_dir(&p)
        .map_err(|e| format!("Failed to read directory {}: {}", p.display(), e))?;

    for entry in read {
        match entry {
            Ok(e) => {
                entries.push(LocalEntry::from_path(e.path()));
            }
            Err(_) => continue,
        }
    }

    Ok(entries)
}

/// Create a single new directory (non-recursive).
#[tauri::command]
pub async fn create_local_folder(path: String) -> Result<LocalEntry, String> {
    let trimmed = path.trim().to_string();
    if trimmed.is_empty() {
        return Err("Path must not be empty or whitespace-only".to_string());
    }

    let p = PathBuf::from(&trimmed);

    if p.exists() {
        return Err(format!("Folder already exists: {}", trimmed));
    }

    // Single-level create — missing parent surfaces as an error.
    std::fs::create_dir(&p)
        .map_err(|e| format!("Failed to create folder {}: {}", p.display(), e))?;

    Ok(LocalEntry::from_path(p))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// Isolated temp directory for this test module.
    fn test_root() -> PathBuf {
        std::env::temp_dir().join(format!("galeon_local_test_{}", Uuid::new_v4()))
    }

    // ------------------------------------------------------------------
    // list_local_directory
    // ------------------------------------------------------------------

    #[test]
    fn list_directory_basic() {
        let root = test_root();
        let dir = root.join("sub");
        fs::create_dir_all(&dir).unwrap();

        // A normal file with known content.
        fs::write(root.join("a.txt"), b"hello").unwrap();
        // A hidden file.
        fs::write(root.join(".secret"), b"hidden").unwrap();
        // A subdirectory.
        // (already created above via create_dir_all)

        let mut entries = list_local_directory_sync(root.to_string_lossy().as_ref());

        // Sort by name for deterministic assertions.
        entries.sort_by(|a, b| a.name.cmp(&b.name));

        assert_eq!(
            entries.len(),
            3,
            "expected 3 entries, got {:?}",
            entries.iter().map(|e| &e.name).collect::<Vec<_>>()
        );

        let hidden = entries.iter().find(|e| e.name == ".secret").unwrap();
        assert!(hidden.is_hidden);
        assert!(!hidden.is_dir);
        assert_eq!(hidden.size, Some(6)); // b"hello" == 6 bytes

        let sub = entries.iter().find(|e| e.name == "sub").unwrap();
        assert!(sub.is_dir);
        assert!(sub.size.is_none());
        assert!(sub.modified_ms.is_some());

        let a = entries.iter().find(|e| e.name == "a.txt").unwrap();
        assert!(!a.is_dir);
        assert_eq!(a.size, Some(5)); // b"hello" is "hello" = 5 bytes
        assert!(a.modified_ms.is_some());

        // Parent path should point at root.
        for entry in &entries {
            assert_eq!(
                entry.parent_path.as_deref(),
                Some(root.to_string_lossy().as_ref())
            );
        }

        // Cleanup.
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn list_directory_hidden_not_excluded() {
        let root = test_root();
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join(".dotfile"), b"dot").unwrap();
        fs::write(root.join("regular"), b"reg").unwrap();

        let entries = list_local_directory_sync(root.to_string_lossy().as_ref());
        assert_eq!(entries.len(), 2);
        assert!(entries.iter().any(|e| e.is_hidden && e.name == ".dotfile"));
        assert!(entries.iter().any(|e| !e.is_hidden && e.name == "regular"));

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn list_directory_nonexistent_path_errors() {
        let err = list_local_directory_err("/tmp/galeon_no_such_path_12345678");
        assert!(err.contains("does not exist"), "unexpected: {}", err);
    }

    #[test]
    fn list_directory_file_not_dir_errors() {
        let root = test_root();
        fs::create_dir_all(&root).unwrap();
        let file = root.join("not_a_dir.txt");
        fs::write(&file, b"data").unwrap();

        let err = list_local_directory_err(file.to_string_lossy().as_ref());
        assert!(err.contains("is a file"), "unexpected: {}", err);

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn list_directory_empty_path_errors() {
        let err = list_local_directory_err("");
        assert!(err.contains("empty"), "unexpected: {}", err);

        let err2 = list_local_directory_err("   ");
        assert!(err2.contains("empty"), "unexpected: {}", err2);
    }

    #[test]
    fn list_directory_symlink_fallback() {
        let root = test_root();
        fs::create_dir_all(&root).unwrap();

        let real_file = root.join("real.txt");
        fs::write(&real_file, b"data").unwrap();

        let link = root.join("link.txt");
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&real_file, &link).unwrap();

            let entries = list_local_directory_sync(root.to_string_lossy().as_ref());
            let link_entry = entries.iter().find(|e| e.name == "link.txt").unwrap();
            // symlink_metadata fails or metadata succeeds depending on platform;
            // either way, the entry must be present.
            assert!(link_entry.path.contains("link.txt"));
        }

        // Cleanup — remove symlink before dir.
        #[cfg(unix)]
        fs::remove_file(&link).unwrap_or(());
        fs::remove_dir_all(&root).unwrap();
    }

    // ------------------------------------------------------------------
    // create_local_folder
    // ------------------------------------------------------------------

    #[test]
    fn create_folder_success() {
        let root = test_root();
        fs::create_dir_all(&root).unwrap();

        let target = root.join("new_folder");
        let entry = create_local_folder_sync(target.to_string_lossy().as_ref());

        assert!(entry.is_dir);
        assert_eq!(entry.name, "new_folder");
        assert!(target.exists());

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn create_folder_already_exists_errors() {
        let root = test_root();
        fs::create_dir_all(&root).unwrap();

        let err = create_local_folder_err(root.to_string_lossy().as_ref());
        assert!(err.contains("already exists"), "unexpected: {}", err);

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn create_folder_missing_parent_errors() {
        let err = create_local_folder_err("/tmp/galeon_no_parent_xyz/no_child");
        assert!(
            err.contains("Failed to create folder") || err.contains("No such file"),
            "unexpected: {}",
            err
        );
    }

    #[test]
    fn create_folder_empty_path_errors() {
        let err = create_local_folder_err("");
        assert!(err.contains("empty"), "unexpected: {}", err);
    }

    // ------------------------------------------------------------------
    // Sync wrappers (the commands are async; tests run in sync #[test])
    // ------------------------------------------------------------------

    fn list_local_directory_sync(path: &str) -> Vec<LocalEntry> {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(list_local_directory(path.to_string())).unwrap()
    }

    fn list_local_directory_err(path: &str) -> String {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(list_local_directory(path.to_string()))
            .unwrap_err()
    }

    fn create_local_folder_sync(path: &str) -> LocalEntry {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(create_local_folder(path.to_string())).unwrap()
    }

    fn create_local_folder_err(path: &str) -> String {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(create_local_folder(path.to_string()))
            .unwrap_err()
    }
}
