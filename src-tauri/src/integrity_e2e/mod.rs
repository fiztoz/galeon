use lazy_static::lazy_static;
use std::path::PathBuf;
use tauri::Manager;
use tokio::sync::Mutex;

use crate::{
    connect_bucket, get_transfer_queue, AppHandleType, AppType, GaleonEngine, StorageSession,
    TransferQueueEntry,
};

lazy_static! {
    pub(super) static ref TEST_SERIAL_MUTEX: Mutex<()> = Mutex::new(());
}

struct TestGuard {
    handle: Option<AppHandleType>,
    pub(super) temp_dir: PathBuf,
    pub(super) session_id: String,
    pub(super) test_name: String,
}

impl Drop for TestGuard {
    fn drop(&mut self) {
        if let Some(ref handle_val) = self.handle {
            let state = handle_val.state::<GaleonEngine>();
            let active_sessions = state.active_sessions.clone();
            let transfers_map = state.transfers.clone();
            let session_id = self.session_id.clone();
            let test_name = self.test_name.clone();

            let handle = std::thread::spawn(move || {
                let rt = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .unwrap();
                rt.block_on(async {
                    let transfers = {
                        let t = transfers_map.read().await;
                        t.values().cloned().collect::<Vec<_>>()
                    };

                    for ctrl in transfers {
                        ctrl.cancel.cancel();
                    }

                    // Await background tasks termination
                    let start = std::time::Instant::now();
                    loop {
                        let is_empty = transfers_map.read().await.is_empty();
                        if is_empty || start.elapsed().as_secs() > 10 {
                            break;
                        }
                        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                    }

                    // Explicit S3 Prefix Cleanup
                    let sftp_op = {
                        let sessions = active_sessions.read().await;
                        sessions.get(&session_id).cloned()
                    };

                    if let Some(StorageSession::OpenDAL(op)) = sftp_op {
                        let prefix = format!("{}/", test_name);
                        let _ = op.delete_with(&prefix).recursive(true).await;
                    }
                });
            });
            let _ = handle.join();
        }
        let _ = std::fs::remove_dir_all(&self.temp_dir);
    }
}

pub(super) struct TestContext {
    pub(super) app: AppType,
    pub(super) handle: AppHandleType,
    pub(super) session_id: String,
    pub(super) temp_dir: PathBuf,
    pub(super) test_name: String,
    guard: TestGuard,
}

impl TestContext {
    pub(super) async fn setup(test_name: &str) -> Self {
        // Environment Isolation
        std::env::remove_var("XDG_CONFIG_HOME");
        std::env::remove_var("XDG_DATA_HOME");

        // Run ID Isolation
        let run_id = uuid::Uuid::new_v4().to_string();
        let temp_dir = std::env::current_dir()
            .unwrap()
            .join("target")
            .join("test-runs")
            .join(&run_id)
            .join(test_name);

        if temp_dir.exists() {
            let _ = std::fs::remove_dir_all(&temp_dir);
        }
        std::fs::create_dir_all(&temp_dir).unwrap();

        std::env::set_var("HOME", &temp_dir);
        std::env::set_var("APPDATA", &temp_dir);
        std::env::set_var("USERPROFILE", &temp_dir);

        let app = tauri::test::mock_app();
        app.manage(GaleonEngine::default());
        let handle = app.handle().clone();

        let state = app.state::<GaleonEngine>();
        let session_id = connect_bucket(
            state,
            Some("http://localhost:9000".to_string()),
            Some("us-east-1".to_string()),
            Some("galeon".to_string()),
            Some("galeon-dev-secret".to_string()),
            "galeon-test".to_string(),
            None,
            Some(false),
            None,
            None, // max_bandwidth
        )
        .await
        .expect("Failed to connect to MinIO. Is it running?");

        let guard = TestGuard {
            handle: Some(handle.clone()),
            temp_dir: temp_dir.clone(),
            session_id: session_id.clone(),
            test_name: test_name.to_string(),
        };

        TestContext {
            app,
            handle,
            session_id,
            temp_dir,
            test_name: test_name.to_string(),
            guard,
        }
    }

    pub(super) fn operator(&self) -> opendal::Operator {
        let state = self.app.state::<GaleonEngine>();
        let sessions = state
            .active_sessions
            .try_read()
            .expect("Failed to try_read active_sessions");
        let session = sessions
            .get(&self.session_id)
            .expect("Session operator not found")
            .clone();
        match session {
            StorageSession::OpenDAL(op) => op,
            StorageSession::NativeSFTP(_) => {
                panic!("E2E tests require OpenDAL session, got NativeSFTP")
            }
            StorageSession::FTP(_) => panic!("E2E tests require OpenDAL session, got FTP"),
        }
    }

    pub(super) async fn cleanup(mut self) {
        // Disarm guard so double cleanup is avoided
        self.guard.handle.take();

        let state = self.app.state::<GaleonEngine>();

        // Cancel active transfers
        let transfers = state.transfers.read().await;
        for ctrl in transfers.values() {
            ctrl.cancel.cancel();
        }
        drop(transfers);

        // Await background tasks termination
        let start = std::time::Instant::now();
        loop {
            let is_empty = state.transfers.read().await.is_empty();
            if is_empty || start.elapsed().as_secs() > 10 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }

        // Explicit S3 Prefix Cleanup
        let sessions = state.active_sessions.read().await;
        if let Some(StorageSession::OpenDAL(ref op)) = sessions.get(&self.session_id) {
            let prefix = format!("{}/", self.test_name);
            let _ = op.delete_with(&prefix).recursive(true).await;
        }

        let _ = std::fs::remove_dir_all(self.temp_dir);
    }
}

pub(super) async fn wait_for_transfer(
    handle: &AppHandleType,
    transfer_id: &str,
    timeout_secs: u64,
) -> Result<TransferQueueEntry, String> {
    let start = std::time::Instant::now();
    loop {
        if start.elapsed().as_secs() > timeout_secs {
            return Err("Timeout waiting for transfer".to_string());
        }
        let queue = get_transfer_queue(handle.clone()).await?;
        if let Some(entry) = queue.entries.iter().find(|e| e.id == transfer_id) {
            if entry.status == "completed"
                || entry.status == "failed"
                || entry.status == "cancelled"
            {
                return Ok(entry.clone());
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
}

pub(super) fn generate_dummy_file(path: &std::path::Path, size: usize, pattern_byte: Option<u8>) {
    use std::io::Write;
    let mut file = std::fs::File::create(path).unwrap();
    let byte = pattern_byte.unwrap_or(0x41);
    let chunk_size = 1024 * 1024;
    let chunk = vec![byte; chunk_size];
    let mut remaining = size;
    while remaining > 0 {
        let write_sz = std::cmp::min(remaining, chunk.len());
        file.write_all(&chunk[..write_sz]).unwrap();
        remaining -= write_sz;
    }
}

// ==========================================
// TIER 1: FEATURE COVERAGE (25 Tests)
// ==========================================

// Split by tier so no file grows past the AGENTS.md ~1000-line ceiling.
mod boundaries;
mod profiles;
mod resume_conflicts;
mod sync_scale;
mod transfer_integrity;
mod transfer_sizes;
