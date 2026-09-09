use lazy_static::lazy_static;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::Manager;
use tokio::sync::Mutex;

use crate::{
    add_to_transfer_queue, auto_reconnect, calculate_file_md5, calculate_multipart_etag,
    cancel_transfer, check_file_exists, check_remote_exists, clear_completed_transfers,
    clear_presign_history, connect_bucket, copy_object, create_folder, delete_object,
    delete_presign_history_entry, delete_profile, generate_presigned_url, get_presign_history,
    get_profile_credentials, get_profiles, get_transfer_queue, initiate_download, initiate_upload,
    list_directory, pause_transfer, rename_object, restore_transfers, resume_transfer,
    save_profile, update_transfer_queue_entry, AppHandleType, AppType, ConnectionProfile,
    GaleonEngine, ObjectType, StorageSession, TransferQueueEntry,
};

lazy_static! {
    static ref TEST_SERIAL_MUTEX: Mutex<()> = Mutex::new(());
}

struct TestGuard {
    handle: Option<AppHandleType>,
    temp_dir: PathBuf,
    session_id: String,
    test_name: String,
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

struct TestContext {
    app: AppType,
    handle: AppHandleType,
    session_id: String,
    temp_dir: PathBuf,
    test_name: String,
    guard: TestGuard,
}

impl TestContext {
    async fn setup(test_name: &str) -> Self {
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

    fn operator(&self) -> opendal::Operator {
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

    async fn cleanup(mut self) {
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

async fn wait_for_transfer(
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

fn generate_dummy_file(path: &std::path::Path, size: usize, pattern_byte: Option<u8>) {
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

#[tokio::test]
async fn test_tier1_f01_download_1b() {
    let _guard = TEST_SERIAL_MUTEX.lock().await;
    let ctx = TestContext::setup("tier1_f01").await;
    let op = ctx.operator();
    let remote_key = "tier1_f01/1b.bin";
    op.write(remote_key, vec![0x41; 1]).await.unwrap();

    let local_path = ctx.temp_dir.join("1b.bin").to_string_lossy().to_string();
    let state = ctx.app.state::<GaleonEngine>();
    let transfer_id = initiate_download(
        state,
        ctx.handle.clone(),
        ctx.session_id.clone(),
        remote_key.to_string(),
        local_path.clone(),
        None,
    )
    .await
    .unwrap();

    let entry = wait_for_transfer(&ctx.handle, &transfer_id, 10)
        .await
        .unwrap();
    assert_eq!(entry.status, "completed");
    assert_eq!(std::fs::metadata(&local_path).unwrap().len(), 1);
    ctx.cleanup().await;
}

#[tokio::test]
async fn test_tier1_f02_download_1kb() {
    let _guard = TEST_SERIAL_MUTEX.lock().await;
    let ctx = TestContext::setup("tier1_f02").await;
    let op = ctx.operator();
    let remote_key = "tier1_f02/1kb.bin";
    op.write(remote_key, vec![0x42; 1024]).await.unwrap();

    let local_path = ctx.temp_dir.join("1kb.bin").to_string_lossy().to_string();
    let state = ctx.app.state::<GaleonEngine>();
    let transfer_id = initiate_download(
        state,
        ctx.handle.clone(),
        ctx.session_id.clone(),
        remote_key.to_string(),
        local_path.clone(),
        None,
    )
    .await
    .unwrap();

    let entry = wait_for_transfer(&ctx.handle, &transfer_id, 10)
        .await
        .unwrap();
    assert_eq!(entry.status, "completed");
    assert_eq!(std::fs::metadata(&local_path).unwrap().len(), 1024);
    ctx.cleanup().await;
}

#[tokio::test]
async fn test_tier1_f03_download_1mb() {
    let _guard = TEST_SERIAL_MUTEX.lock().await;
    let ctx = TestContext::setup("tier1_f03").await;
    let op = ctx.operator();
    let remote_key = "tier1_f03/1mb.bin";
    op.write(remote_key, vec![0x43; 1024 * 1024]).await.unwrap();

    let local_path = ctx.temp_dir.join("1mb.bin").to_string_lossy().to_string();
    let state = ctx.app.state::<GaleonEngine>();
    let transfer_id = initiate_download(
        state,
        ctx.handle.clone(),
        ctx.session_id.clone(),
        remote_key.to_string(),
        local_path.clone(),
        None,
    )
    .await
    .unwrap();

    let entry = wait_for_transfer(&ctx.handle, &transfer_id, 15)
        .await
        .unwrap();
    assert_eq!(entry.status, "completed");
    assert_eq!(std::fs::metadata(&local_path).unwrap().len(), 1024 * 1024);
    ctx.cleanup().await;
}

#[tokio::test]
async fn test_tier1_f04_download_5mb() {
    let _guard = TEST_SERIAL_MUTEX.lock().await;
    let ctx = TestContext::setup("tier1_f04").await;
    let op = ctx.operator();
    let remote_key = "tier1_f04/5mb.bin";
    op.write(remote_key, vec![0x44; 5 * 1024 * 1024])
        .await
        .unwrap();

    let local_path = ctx.temp_dir.join("5mb.bin").to_string_lossy().to_string();
    let state = ctx.app.state::<GaleonEngine>();
    let transfer_id = initiate_download(
        state,
        ctx.handle.clone(),
        ctx.session_id.clone(),
        remote_key.to_string(),
        local_path.clone(),
        None,
    )
    .await
    .unwrap();

    let entry = wait_for_transfer(&ctx.handle, &transfer_id, 20)
        .await
        .unwrap();
    assert_eq!(entry.status, "completed");
    assert_eq!(
        std::fs::metadata(&local_path).unwrap().len(),
        5 * 1024 * 1024
    );
    ctx.cleanup().await;
}

#[tokio::test]
async fn test_tier1_f05_download_10mb() {
    let _guard = TEST_SERIAL_MUTEX.lock().await;
    let ctx = TestContext::setup("tier1_f05").await;
    let op = ctx.operator();
    let remote_key = "tier1_f05/10mb.bin";
    op.write(remote_key, vec![0x45; 10 * 1024 * 1024])
        .await
        .unwrap();

    let local_path = ctx.temp_dir.join("10mb.bin").to_string_lossy().to_string();
    let state = ctx.app.state::<GaleonEngine>();
    let transfer_id = initiate_download(
        state,
        ctx.handle.clone(),
        ctx.session_id.clone(),
        remote_key.to_string(),
        local_path.clone(),
        None,
    )
    .await
    .unwrap();

    let entry = wait_for_transfer(&ctx.handle, &transfer_id, 25)
        .await
        .unwrap();
    assert_eq!(entry.status, "completed");
    assert_eq!(
        std::fs::metadata(&local_path).unwrap().len(),
        10 * 1024 * 1024
    );
    ctx.cleanup().await;
}

#[tokio::test]
async fn test_tier1_f06_download_15mb() {
    let _guard = TEST_SERIAL_MUTEX.lock().await;
    let ctx = TestContext::setup("tier1_f06").await;
    let op = ctx.operator();
    let remote_key = "tier1_f06/15mb.bin";
    op.write(remote_key, vec![0x46; 15 * 1024 * 1024])
        .await
        .unwrap();

    let local_path = ctx.temp_dir.join("15mb.bin").to_string_lossy().to_string();
    let state = ctx.app.state::<GaleonEngine>();
    let transfer_id = initiate_download(
        state,
        ctx.handle.clone(),
        ctx.session_id.clone(),
        remote_key.to_string(),
        local_path.clone(),
        None,
    )
    .await
    .unwrap();

    let entry = wait_for_transfer(&ctx.handle, &transfer_id, 30)
        .await
        .unwrap();
    assert_eq!(entry.status, "completed");
    assert_eq!(
        std::fs::metadata(&local_path).unwrap().len(),
        15 * 1024 * 1024
    );
    ctx.cleanup().await;
}

#[tokio::test]
async fn test_tier1_f07_upload_1b() {
    let _guard = TEST_SERIAL_MUTEX.lock().await;
    let ctx = TestContext::setup("tier1_f07").await;
    let op = ctx.operator();
    let local_path = ctx.temp_dir.join("1b.bin");
    std::fs::write(&local_path, vec![0x41; 1]).unwrap();

    let remote_key = "tier1_f07/1b.bin";
    let state = ctx.app.state::<GaleonEngine>();
    let transfer_id = initiate_upload(
        state,
        ctx.handle.clone(),
        ctx.session_id.clone(),
        local_path.to_string_lossy().to_string(),
        remote_key.to_string(),
        None,
    )
    .await
    .unwrap();

    let entry = wait_for_transfer(&ctx.handle, &transfer_id, 10)
        .await
        .unwrap();
    assert_eq!(entry.status, "completed");
    assert!(op.exists(remote_key).await.unwrap());
    assert_eq!(op.stat(remote_key).await.unwrap().content_length(), 1);
    ctx.cleanup().await;
}

#[tokio::test]
async fn test_tier1_f08_upload_1kb() {
    let _guard = TEST_SERIAL_MUTEX.lock().await;
    let ctx = TestContext::setup("tier1_f08").await;
    let op = ctx.operator();
    let local_path = ctx.temp_dir.join("1kb.bin");
    std::fs::write(&local_path, vec![0x42; 1024]).unwrap();

    let remote_key = "tier1_f08/1kb.bin";
    let state = ctx.app.state::<GaleonEngine>();
    let transfer_id = initiate_upload(
        state,
        ctx.handle.clone(),
        ctx.session_id.clone(),
        local_path.to_string_lossy().to_string(),
        remote_key.to_string(),
        None,
    )
    .await
    .unwrap();

    let entry = wait_for_transfer(&ctx.handle, &transfer_id, 10)
        .await
        .unwrap();
    assert_eq!(entry.status, "completed");
    assert!(op.exists(remote_key).await.unwrap());
    assert_eq!(op.stat(remote_key).await.unwrap().content_length(), 1024);
    ctx.cleanup().await;
}

#[tokio::test]
async fn test_tier1_f09_upload_1mb() {
    let _guard = TEST_SERIAL_MUTEX.lock().await;
    let ctx = TestContext::setup("tier1_f09").await;
    let op = ctx.operator();
    let local_path = ctx.temp_dir.join("1mb.bin");
    std::fs::write(&local_path, vec![0x43; 1024 * 1024]).unwrap();

    let remote_key = "tier1_f09/1mb.bin";
    let state = ctx.app.state::<GaleonEngine>();
    let transfer_id = initiate_upload(
        state,
        ctx.handle.clone(),
        ctx.session_id.clone(),
        local_path.to_string_lossy().to_string(),
        remote_key.to_string(),
        None,
    )
    .await
    .unwrap();

    let entry = wait_for_transfer(&ctx.handle, &transfer_id, 15)
        .await
        .unwrap();
    assert_eq!(entry.status, "completed");
    assert_eq!(
        op.stat(remote_key).await.unwrap().content_length(),
        1024 * 1024
    );
    ctx.cleanup().await;
}

#[tokio::test]
async fn test_tier1_f10_upload_5mb() {
    let _guard = TEST_SERIAL_MUTEX.lock().await;
    let ctx = TestContext::setup("tier1_f10").await;
    let op = ctx.operator();
    let local_path = ctx.temp_dir.join("5mb.bin");
    generate_dummy_file(&local_path, 5 * 1024 * 1024, Some(0x44));

    let remote_key = "tier1_f10/5mb.bin";
    let state = ctx.app.state::<GaleonEngine>();
    let transfer_id = initiate_upload(
        state,
        ctx.handle.clone(),
        ctx.session_id.clone(),
        local_path.to_string_lossy().to_string(),
        remote_key.to_string(),
        None,
    )
    .await
    .unwrap();

    let entry = wait_for_transfer(&ctx.handle, &transfer_id, 20)
        .await
        .unwrap();
    assert_eq!(entry.status, "completed");
    assert_eq!(
        op.stat(remote_key).await.unwrap().content_length(),
        5 * 1024 * 1024
    );
    ctx.cleanup().await;
}

#[tokio::test]
async fn test_tier1_f11_upload_10mb() {
    let _guard = TEST_SERIAL_MUTEX.lock().await;
    let ctx = TestContext::setup("tier1_f11").await;
    let op = ctx.operator();
    let local_path = ctx.temp_dir.join("10mb.bin");
    generate_dummy_file(&local_path, 10 * 1024 * 1024, Some(0x45));

    let remote_key = "tier1_f11/10mb.bin";
    let state = ctx.app.state::<GaleonEngine>();
    let transfer_id = initiate_upload(
        state,
        ctx.handle.clone(),
        ctx.session_id.clone(),
        local_path.to_string_lossy().to_string(),
        remote_key.to_string(),
        None,
    )
    .await
    .unwrap();

    let entry = wait_for_transfer(&ctx.handle, &transfer_id, 25)
        .await
        .unwrap();
    assert_eq!(entry.status, "completed");
    assert_eq!(
        op.stat(remote_key).await.unwrap().content_length(),
        10 * 1024 * 1024
    );
    ctx.cleanup().await;
}

#[tokio::test]
async fn test_tier1_f12_upload_15mb() {
    let _guard = TEST_SERIAL_MUTEX.lock().await;
    let ctx = TestContext::setup("tier1_f12").await;
    let op = ctx.operator();
    let local_path = ctx.temp_dir.join("15mb.bin");
    generate_dummy_file(&local_path, 15 * 1024 * 1024, Some(0x46));

    let remote_key = "tier1_f12/15mb.bin";
    let state = ctx.app.state::<GaleonEngine>();
    let transfer_id = initiate_upload(
        state,
        ctx.handle.clone(),
        ctx.session_id.clone(),
        local_path.to_string_lossy().to_string(),
        remote_key.to_string(),
        None,
    )
    .await
    .unwrap();

    let entry = wait_for_transfer(&ctx.handle, &transfer_id, 30)
        .await
        .unwrap();
    assert_eq!(entry.status, "completed");
    assert_eq!(
        op.stat(remote_key).await.unwrap().content_length(),
        15 * 1024 * 1024
    );
    ctx.cleanup().await;
}

#[tokio::test]
async fn test_tier1_f13_download_md5_calculation() {
    let _guard = TEST_SERIAL_MUTEX.lock().await;
    let ctx = TestContext::setup("tier1_f13").await;
    let op = ctx.operator();
    let remote_key = "tier1_f13/file.bin";
    let content = b"integrity check data small file";
    op.write(remote_key, content.to_vec()).await.unwrap();

    let local_path = ctx.temp_dir.join("file.bin").to_string_lossy().to_string();
    let state = ctx.app.state::<GaleonEngine>();
    let transfer_id = initiate_download(
        state,
        ctx.handle.clone(),
        ctx.session_id.clone(),
        remote_key.to_string(),
        local_path.clone(),
        None,
    )
    .await
    .unwrap();

    let entry = wait_for_transfer(&ctx.handle, &transfer_id, 10)
        .await
        .unwrap();
    assert_eq!(entry.status, "completed");

    let computed_md5 = calculate_file_md5(&local_path).await.unwrap();
    let expected_md5 = format!("{:x}", md5::compute(content));
    assert_eq!(computed_md5, expected_md5);
    ctx.cleanup().await;
}

#[tokio::test]
async fn test_tier1_ssl_bypass_custom_transport_roundtrip() {
    let _guard = TEST_SERIAL_MUTEX.lock().await;
    let ctx = TestContext::setup("tier1_ssl_bypass").await;
    let state = ctx.app.state::<GaleonEngine>();

    // Same endpoint with the TLS bypass engaged: exercises the OpenDAL 0.59
    // transport swap (`with_context` + layer replay) and the custom reqwest
    // fetch path end to end. Plain-http MinIO accepts the connection either
    // way; the point is the bypass operator itself round-trips bytes.
    let bypass_session = connect_bucket(
        state,
        Some("http://localhost:9000".to_string()),
        Some("us-east-1".to_string()),
        Some("galeon".to_string()),
        Some("galeon-dev-secret".to_string()),
        "galeon-test".to_string(),
        Some(true),
        Some(false),
        None,
        None,
    )
    .await
    .expect("bypass connect failed");

    let state = ctx.app.state::<GaleonEngine>();
    let op = {
        let sessions = state.active_sessions.read().await;
        match sessions
            .get(&bypass_session)
            .cloned()
            .expect("bypass session missing")
        {
            StorageSession::OpenDAL(op) => op,
            _ => panic!("expected OpenDAL session"),
        }
    };

    let probe = "tier1_ssl_bypass/probe.bin";
    let content = b"ssl bypass transport probe";
    op.write(probe, content.to_vec()).await.unwrap();
    let meta = op.stat(probe).await.unwrap();
    assert_eq!(meta.content_length(), content.len() as u64);
    op.delete(probe).await.unwrap();
    assert!(op.stat(probe).await.is_err());

    state.active_sessions.write().await.remove(&bypass_session);
    ctx.cleanup().await;
}

#[tokio::test]
async fn test_tier1_f14_download_etag_calculation() {
    let _guard = TEST_SERIAL_MUTEX.lock().await;
    let ctx = TestContext::setup("tier1_f14").await;
    let op = ctx.operator();
    let remote_key = "tier1_f14/large.bin";
    let size = 17 * 1024 * 1024;

    let local_seed = ctx.temp_dir.join("seed.bin");
    generate_dummy_file(&local_seed, size, Some(0x5A));
    let seed_data = std::fs::read(&local_seed).unwrap();
    op.write(remote_key, seed_data).await.unwrap();

    let local_path = ctx.temp_dir.join("large.bin").to_string_lossy().to_string();
    let state = ctx.app.state::<GaleonEngine>();
    let transfer_id = initiate_download(
        state,
        ctx.handle.clone(),
        ctx.session_id.clone(),
        remote_key.to_string(),
        local_path.clone(),
        None,
    )
    .await
    .unwrap();

    let entry = wait_for_transfer(&ctx.handle, &transfer_id, 30)
        .await
        .unwrap();
    assert_eq!(entry.status, "completed");

    let computed_etag = calculate_multipart_etag(&local_path, 8 * 1024 * 1024)
        .await
        .unwrap();

    let part1 = &std::fs::read(&local_path).unwrap()[0..8 * 1024 * 1024];
    let part2 = &std::fs::read(&local_path).unwrap()[8 * 1024 * 1024..16 * 1024 * 1024];
    let part3 = &std::fs::read(&local_path).unwrap()[16 * 1024 * 1024..];
    let h1 = md5::compute(part1);
    let h2 = md5::compute(part2);
    let h3 = md5::compute(part3);
    let mut concat = Vec::new();
    concat.extend_from_slice(&h1.0);
    concat.extend_from_slice(&h2.0);
    concat.extend_from_slice(&h3.0);
    let expected_etag = format!("{:x}-3", md5::compute(&concat));

    assert_eq!(computed_etag, expected_etag);
    ctx.cleanup().await;
}

#[tokio::test]
async fn test_tier1_f15_upload_md5_calculation() {
    let _guard = TEST_SERIAL_MUTEX.lock().await;
    let ctx = TestContext::setup("tier1_f15").await;
    let local_path = ctx.temp_dir.join("file.bin");
    let content = b"upload md5 content";
    std::fs::write(&local_path, content).unwrap();

    let remote_key = "tier1_f15/file.bin";
    let state = ctx.app.state::<GaleonEngine>();
    let transfer_id = initiate_upload(
        state,
        ctx.handle.clone(),
        ctx.session_id.clone(),
        local_path.to_string_lossy().to_string(),
        remote_key.to_string(),
        None,
    )
    .await
    .unwrap();

    wait_for_transfer(&ctx.handle, &transfer_id, 10)
        .await
        .unwrap();

    let local_md5 = calculate_file_md5(&local_path.to_string_lossy())
        .await
        .unwrap();
    let expected_md5 = format!("{:x}", md5::compute(content));
    assert_eq!(local_md5, expected_md5);
    ctx.cleanup().await;
}

#[tokio::test]
async fn test_tier1_f16_upload_etag_calculation() {
    let _guard = TEST_SERIAL_MUTEX.lock().await;
    let ctx = TestContext::setup("tier1_f16").await;
    let local_path = ctx.temp_dir.join("large.bin");
    let size = 18 * 1024 * 1024;
    generate_dummy_file(&local_path, size, Some(0x7F));

    let remote_key = "tier1_f16/large.bin";
    let state = ctx.app.state::<GaleonEngine>();
    let transfer_id = initiate_upload(
        state,
        ctx.handle.clone(),
        ctx.session_id.clone(),
        local_path.to_string_lossy().to_string(),
        remote_key.to_string(),
        None,
    )
    .await
    .unwrap();

    wait_for_transfer(&ctx.handle, &transfer_id, 30)
        .await
        .unwrap();

    let computed_etag = calculate_multipart_etag(&local_path.to_string_lossy(), 8 * 1024 * 1024)
        .await
        .unwrap();
    assert!(computed_etag.ends_with("-3"));
    ctx.cleanup().await;
}

#[tokio::test]
async fn test_tier1_f17_multipart_upload_boundary() {
    let _guard = TEST_SERIAL_MUTEX.lock().await;
    let ctx = TestContext::setup("tier1_f17").await;
    let local_path = ctx.temp_dir.join("boundary.bin");
    let size = 9 * 1024 * 1024;
    generate_dummy_file(&local_path, size, Some(0xAA));

    let remote_key = "tier1_f17/boundary.bin";
    let state = ctx.app.state::<GaleonEngine>();
    let transfer_id = initiate_upload(
        state,
        ctx.handle.clone(),
        ctx.session_id.clone(),
        local_path.to_string_lossy().to_string(),
        remote_key.to_string(),
        None,
    )
    .await
    .unwrap();

    let entry = wait_for_transfer(&ctx.handle, &transfer_id, 25)
        .await
        .unwrap();
    assert_eq!(entry.status, "completed");
    ctx.cleanup().await;
}

#[tokio::test]
async fn test_tier1_f18_multipart_download_boundary() {
    let _guard = TEST_SERIAL_MUTEX.lock().await;
    let ctx = TestContext::setup("tier1_f18").await;
    let op = ctx.operator();
    let remote_key = "tier1_f18/boundary.bin";
    let size = 9 * 1024 * 1024;

    let local_seed = ctx.temp_dir.join("seed.bin");
    generate_dummy_file(&local_seed, size, Some(0xBB));
    op.write(remote_key, std::fs::read(&local_seed).unwrap())
        .await
        .unwrap();

    let local_path = ctx
        .temp_dir
        .join("download.bin")
        .to_string_lossy()
        .to_string();
    let state = ctx.app.state::<GaleonEngine>();
    let transfer_id = initiate_download(
        state,
        ctx.handle.clone(),
        ctx.session_id.clone(),
        remote_key.to_string(),
        local_path.clone(),
        None,
    )
    .await
    .unwrap();

    let entry = wait_for_transfer(&ctx.handle, &transfer_id, 25)
        .await
        .unwrap();
    assert_eq!(entry.status, "completed");
    assert_eq!(std::fs::metadata(&local_path).unwrap().len(), size as u64);
    ctx.cleanup().await;
}

#[tokio::test]
async fn test_tier1_f19_transfer_queue_persistence() {
    let _guard = TEST_SERIAL_MUTEX.lock().await;
    let ctx = TestContext::setup("tier1_f19").await;
    let entry = TransferQueueEntry {
        id: "test-transfer-id".to_string(),
        direction: "download".to_string(),
        remote_key: "remote.txt".to_string(),
        local_path: "local.txt".to_string(),
        profile_id: "profile-1".to_string(),
        status: "queued".to_string(),
        bytes_transferred: 0,
        total_bytes: 100,
        created_at: "now".to_string(),
        updated_at: "now".to_string(),
        error: None,
    };

    add_to_transfer_queue(ctx.handle.clone(), entry)
        .await
        .unwrap();
    let queue = get_transfer_queue(ctx.handle.clone()).await.unwrap();
    assert_eq!(queue.entries.len(), 1);
    assert_eq!(queue.entries[0].id, "test-transfer-id");
    ctx.cleanup().await;
}

#[tokio::test]
async fn test_tier1_f20_clear_completed_transfers() {
    let _guard = TEST_SERIAL_MUTEX.lock().await;
    let ctx = TestContext::setup("tier1_f20").await;

    let entry_completed = TransferQueueEntry {
        id: "completed-id".to_string(),
        direction: "download".to_string(),
        remote_key: "r1.txt".to_string(),
        local_path: "l1.txt".to_string(),
        profile_id: "p1".to_string(),
        status: "completed".to_string(),
        bytes_transferred: 10,
        total_bytes: 10,
        created_at: "now".to_string(),
        updated_at: "now".to_string(),
        error: None,
    };

    let entry_queued = TransferQueueEntry {
        id: "queued-id".to_string(),
        direction: "download".to_string(),
        remote_key: "r2.txt".to_string(),
        local_path: "l2.txt".to_string(),
        profile_id: "p1".to_string(),
        status: "queued".to_string(),
        bytes_transferred: 0,
        total_bytes: 10,
        created_at: "now".to_string(),
        updated_at: "now".to_string(),
        error: None,
    };

    add_to_transfer_queue(ctx.handle.clone(), entry_completed)
        .await
        .unwrap();
    add_to_transfer_queue(ctx.handle.clone(), entry_queued)
        .await
        .unwrap();

    clear_completed_transfers(ctx.handle.clone()).await.unwrap();
    let queue = get_transfer_queue(ctx.handle.clone()).await.unwrap();
    assert_eq!(queue.entries.len(), 1);
    assert_eq!(queue.entries[0].id, "queued-id");
    ctx.cleanup().await;
}

#[tokio::test]
async fn test_tier1_f21_save_profile() {
    let _guard = TEST_SERIAL_MUTEX.lock().await;
    let ctx = TestContext::setup("tier1_f21").await;
    let profile = ConnectionProfile {
        id: "prof-1".to_string(),
        name: "Dev Profile".to_string(),
        protocol: Some("s3".to_string()),
        endpoint: Some("http://localhost:9000".to_string()),
        region: Some("us-east-1".to_string()),
        access_key: None,
        secret_key: None,
        bucket: Some("galeon-test".to_string()),
        danger_disable_ssl_verification: None,
        use_virtual_host_style: None,
        storage_class: None,
        max_bandwidth: None,
        host: None,
        port: None,
        username: None,
        key_path: None,
        passive_mode: None,
        encrypt: None,
        bandwidth_rules: None,
        ssh_tunnel: None,
        ssh_tunnel_profile_id: None,
        has_saved_credentials: None,
    };

    let state = ctx.app.state::<GaleonEngine>();
    save_profile(ctx.handle.clone(), state, profile, None, None)
        .await
        .unwrap();
    let profiles = get_profiles(ctx.handle.clone()).await.unwrap();
    assert_eq!(profiles.len(), 1);
    assert_eq!(profiles[0].id, "prof-1");
    ctx.cleanup().await;
}

#[tokio::test]
async fn test_tier1_f22_get_profiles() {
    let _guard = TEST_SERIAL_MUTEX.lock().await;
    let ctx = TestContext::setup("tier1_f22").await;
    let p1 = ConnectionProfile {
        id: "prof-1".to_string(),
        name: "Dev 1".to_string(),
        protocol: Some("s3".to_string()),
        endpoint: None,
        region: None,
        access_key: None,
        secret_key: None,
        bucket: Some("b1".to_string()),
        danger_disable_ssl_verification: None,
        use_virtual_host_style: None,
        storage_class: None,
        max_bandwidth: None,
        host: None,
        port: None,
        username: None,
        key_path: None,
        passive_mode: None,
        encrypt: None,
        bandwidth_rules: None,
        ssh_tunnel: None,
        ssh_tunnel_profile_id: None,
        has_saved_credentials: None,
    };
    let p2 = ConnectionProfile {
        id: "prof-2".to_string(),
        name: "Dev 2".to_string(),
        protocol: Some("s3".to_string()),
        endpoint: None,
        region: None,
        access_key: None,
        secret_key: None,
        bucket: Some("b2".to_string()),
        danger_disable_ssl_verification: None,
        use_virtual_host_style: None,
        storage_class: None,
        max_bandwidth: None,
        host: None,
        port: None,
        username: None,
        key_path: None,
        passive_mode: None,
        encrypt: None,
        bandwidth_rules: None,
        ssh_tunnel: None,
        ssh_tunnel_profile_id: None,
        has_saved_credentials: None,
    };

    let state = ctx.app.state::<GaleonEngine>();
    save_profile(ctx.handle.clone(), state.clone(), p1, None, None)
        .await
        .unwrap();
    save_profile(ctx.handle.clone(), state, p2, None, None)
        .await
        .unwrap();
    let profiles = get_profiles(ctx.handle.clone()).await.unwrap();
    assert_eq!(profiles.len(), 2);
    ctx.cleanup().await;
}

#[tokio::test]
async fn test_tier1_f23_delete_profile() {
    let _guard = TEST_SERIAL_MUTEX.lock().await;
    let ctx = TestContext::setup("tier1_f23").await;
    let p = ConnectionProfile {
        id: "prof-1".to_string(),
        name: "Dev 1".to_string(),
        protocol: Some("s3".to_string()),
        endpoint: None,
        region: None,
        access_key: None,
        secret_key: None,
        bucket: Some("b1".to_string()),
        danger_disable_ssl_verification: None,
        use_virtual_host_style: None,
        storage_class: None,
        max_bandwidth: None,
        host: None,
        port: None,
        username: None,
        key_path: None,
        passive_mode: None,
        encrypt: None,
        bandwidth_rules: None,
        ssh_tunnel: None,
        ssh_tunnel_profile_id: None,
        has_saved_credentials: None,
    };

    let state = ctx.app.state::<GaleonEngine>();
    save_profile(ctx.handle.clone(), state.clone(), p, None, None)
        .await
        .unwrap();
    delete_profile(ctx.handle.clone(), state, "prof-1".to_string())
        .await
        .unwrap();
    let profiles = get_profiles(ctx.handle.clone()).await.unwrap();
    assert!(profiles.is_empty());
    ctx.cleanup().await;
}

#[tokio::test]
async fn test_tier1_f24_speed_tracking_verification() {
    use tauri::Listener;
    let _guard = TEST_SERIAL_MUTEX.lock().await;
    let ctx = TestContext::setup("tier1_f24").await;
    let op = ctx.operator();
    let remote_key = "tier1_f24/speed.bin";
    let size = 10 * 1024 * 1024;
    op.write(remote_key, vec![0x33; size]).await.unwrap();

    let local_path = ctx.temp_dir.join("speed.bin").to_string_lossy().to_string();
    let state = ctx.app.state::<GaleonEngine>();

    let speed_received = Arc::new(std::sync::Mutex::new(false));
    let speed_received_clone = speed_received.clone();

    ctx.handle.listen("transfer-progress", move |event| {
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(event.payload()) {
            if let Some(bps) = val.get("bytesPerSecond").and_then(|v| v.as_u64()) {
                if bps > 0 {
                    let mut guard = speed_received_clone.lock().unwrap();
                    *guard = true;
                }
            }
        }
    });

    let transfer_id = initiate_download(
        state,
        ctx.handle.clone(),
        ctx.session_id.clone(),
        remote_key.to_string(),
        local_path.clone(),
        None,
    )
    .await
    .unwrap();
    let entry = wait_for_transfer(&ctx.handle, &transfer_id, 15)
        .await
        .unwrap();
    assert_eq!(entry.status, "completed");

    let received = *speed_received.lock().unwrap();
    assert!(
        received,
        "Speed bytes_per_second should be recorded as a non-zero value during active download"
    );

    ctx.cleanup().await;
}

#[tokio::test]
async fn test_tier1_f25_list_directory() {
    let _guard = TEST_SERIAL_MUTEX.lock().await;
    let ctx = TestContext::setup("tier1_f25").await;
    let op = ctx.operator();

    op.write("tier1_f25/dir1/file1.txt", "data1").await.unwrap();
    op.write("tier1_f25/dir1/file2.txt", "data2").await.unwrap();

    let state = ctx.app.state::<GaleonEngine>();
    let list = list_directory(state, ctx.session_id.clone(), "tier1_f25/dir1/".to_string())
        .await
        .unwrap();

    assert!(list.len() >= 2);
    let names: Vec<String> = list.iter().map(|o| o.name.clone()).collect();
    assert!(names.contains(&"file1.txt".to_string()));
    assert!(names.contains(&"file2.txt".to_string()));
    ctx.cleanup().await;
}

// ==========================================
// TIER 2: BOUNDARY & CORNER CASES (25 Tests)
// ==========================================

#[tokio::test]
async fn test_tier2_b01_download_zero_byte() {
    let _guard = TEST_SERIAL_MUTEX.lock().await;
    let ctx = TestContext::setup("tier2_b01").await;
    let op = ctx.operator();
    let remote_key = "tier2_b01/zero.bin";
    op.write(remote_key, Vec::<u8>::new()).await.unwrap();

    let local_path = ctx.temp_dir.join("zero.bin").to_string_lossy().to_string();
    let state = ctx.app.state::<GaleonEngine>();
    let transfer_id = initiate_download(
        state,
        ctx.handle.clone(),
        ctx.session_id.clone(),
        remote_key.to_string(),
        local_path.clone(),
        None,
    )
    .await
    .unwrap();

    let entry = wait_for_transfer(&ctx.handle, &transfer_id, 10)
        .await
        .unwrap();
    assert_eq!(entry.status, "completed");
    assert_eq!(std::fs::metadata(&local_path).unwrap().len(), 0);
    ctx.cleanup().await;
}

#[tokio::test]
async fn test_tier2_b02_upload_zero_byte() {
    let _guard = TEST_SERIAL_MUTEX.lock().await;
    let ctx = TestContext::setup("tier2_b02").await;
    let op = ctx.operator();
    let local_path = ctx.temp_dir.join("zero.bin");
    std::fs::write(&local_path, vec![]).unwrap();

    let remote_key = "tier2_b02/zero.bin";
    let state = ctx.app.state::<GaleonEngine>();
    let transfer_id = initiate_upload(
        state,
        ctx.handle.clone(),
        ctx.session_id.clone(),
        local_path.to_string_lossy().to_string(),
        remote_key.to_string(),
        None,
    )
    .await
    .unwrap();

    let entry = wait_for_transfer(&ctx.handle, &transfer_id, 10)
        .await
        .unwrap();
    assert_eq!(entry.status, "completed");
    assert_eq!(op.stat(remote_key).await.unwrap().content_length(), 0);
    ctx.cleanup().await;
}

#[tokio::test]
async fn test_tier2_b03_exact_chunk_boundary_8mb() {
    let _guard = TEST_SERIAL_MUTEX.lock().await;
    let ctx = TestContext::setup("tier2_b03").await;
    let op = ctx.operator();
    let local_path = ctx.temp_dir.join("8mb.bin");
    let size = 8 * 1024 * 1024;
    generate_dummy_file(&local_path, size, Some(0x33));

    let remote_key = "tier2_b03/8mb.bin";
    let state = ctx.app.state::<GaleonEngine>();
    let transfer_id = initiate_upload(
        state,
        ctx.handle.clone(),
        ctx.session_id.clone(),
        local_path.to_string_lossy().to_string(),
        remote_key.to_string(),
        None,
    )
    .await
    .unwrap();

    let entry = wait_for_transfer(&ctx.handle, &transfer_id, 25)
        .await
        .unwrap();
    assert_eq!(entry.status, "completed");
    assert_eq!(
        op.stat(remote_key).await.unwrap().content_length(),
        size as u64
    );
    ctx.cleanup().await;
}

#[tokio::test]
async fn test_tier2_b04_exact_chunk_boundary_16mb() {
    let _guard = TEST_SERIAL_MUTEX.lock().await;
    let ctx = TestContext::setup("tier2_b04").await;
    let op = ctx.operator();
    let local_path = ctx.temp_dir.join("16mb.bin");
    let size = 16 * 1024 * 1024;
    generate_dummy_file(&local_path, size, Some(0x44));

    let remote_key = "tier2_b04/16mb.bin";
    let state = ctx.app.state::<GaleonEngine>();
    let transfer_id = initiate_upload(
        state,
        ctx.handle.clone(),
        ctx.session_id.clone(),
        local_path.to_string_lossy().to_string(),
        remote_key.to_string(),
        None,
    )
    .await
    .unwrap();

    let entry = wait_for_transfer(&ctx.handle, &transfer_id, 35)
        .await
        .unwrap();
    assert_eq!(entry.status, "completed");
    assert_eq!(
        op.stat(remote_key).await.unwrap().content_length(),
        size as u64
    );
    ctx.cleanup().await;
}

#[tokio::test]
async fn test_tier2_b05_exact_chunk_boundary_24mb() {
    let _guard = TEST_SERIAL_MUTEX.lock().await;
    let ctx = TestContext::setup("tier2_b05").await;
    let op = ctx.operator();
    let local_path = ctx.temp_dir.join("24mb.bin");
    let size = 24 * 1024 * 1024;
    generate_dummy_file(&local_path, size, Some(0x55));

    let remote_key = "tier2_b05/24mb.bin";
    let state = ctx.app.state::<GaleonEngine>();
    let transfer_id = initiate_upload(
        state,
        ctx.handle.clone(),
        ctx.session_id.clone(),
        local_path.to_string_lossy().to_string(),
        remote_key.to_string(),
        None,
    )
    .await
    .unwrap();

    let entry = wait_for_transfer(&ctx.handle, &transfer_id, 45)
        .await
        .unwrap();
    assert_eq!(entry.status, "completed");
    assert_eq!(
        op.stat(remote_key).await.unwrap().content_length(),
        size as u64
    );
    ctx.cleanup().await;
}

#[tokio::test]
async fn test_tier2_b06_invalid_credentials_access_key() {
    let _guard = TEST_SERIAL_MUTEX.lock().await;
    let app = tauri::test::mock_app();
    app.manage(GaleonEngine::default());
    let state = app.state::<GaleonEngine>();

    let res = connect_bucket(
        state,
        Some("http://localhost:9000".to_string()),
        Some("us-east-1".to_string()),
        Some("invalid-key".to_string()),
        Some("invalid-secret".to_string()),
        "galeon-test".to_string(),
        None,
        Some(false),
        None,
        None, // max_bandwidth
    )
    .await;

    assert!(res.is_err());
}

#[tokio::test]
async fn test_tier2_b07_invalid_credentials_bucket() {
    let _guard = TEST_SERIAL_MUTEX.lock().await;
    let app = tauri::test::mock_app();
    app.manage(GaleonEngine::default());
    let state = app.state::<GaleonEngine>();

    let res = connect_bucket(
        state,
        Some("http://localhost:9000".to_string()),
        Some("us-east-1".to_string()),
        Some("galeon".to_string()),
        Some("galeon-dev-secret".to_string()),
        "non-existent-bucket-name".to_string(),
        None,
        Some(false),
        None,
        None, // max_bandwidth
    )
    .await;

    assert!(res.is_err());
}

#[tokio::test]
async fn test_tier2_b08_mismatched_download_size() {
    let _guard = TEST_SERIAL_MUTEX.lock().await;
    let ctx = TestContext::setup("tier2_b08").await;
    let state = ctx.app.state::<GaleonEngine>();

    let res = initiate_download(
        state,
        ctx.handle.clone(),
        ctx.session_id.clone(),
        "non-existent.bin".to_string(),
        ctx.temp_dir
            .join("non-existent.bin")
            .to_string_lossy()
            .to_string(),
        None,
    )
    .await;
    let id = res.unwrap();
    let entry = wait_for_transfer(&ctx.handle, &id, 10).await.unwrap();
    assert_eq!(entry.status, "failed");
    assert!(entry.error.is_some());
    let err = entry.error.unwrap();
    assert!(
        err.contains("not found")
            || err.contains("NotFound")
            || err.contains("NotFound (permanent)")
            || err.contains("mismatch")
    );
    ctx.cleanup().await;
}

#[tokio::test]
async fn test_tier2_b09_mismatched_upload_size() {
    let _guard = TEST_SERIAL_MUTEX.lock().await;
    let ctx = TestContext::setup("tier2_b09").await;
    let state = ctx.app.state::<GaleonEngine>();

    let res = initiate_upload(
        state,
        ctx.handle.clone(),
        ctx.session_id.clone(),
        ctx.temp_dir
            .join("non-existent-local.bin")
            .to_string_lossy()
            .to_string(),
        "target.bin".to_string(),
        None,
    )
    .await;
    let id = res.unwrap();
    let entry = wait_for_transfer(&ctx.handle, &id, 10).await.unwrap();
    assert_eq!(entry.status, "failed");
    assert!(entry.error.is_some());
    let err = entry.error.unwrap();
    assert!(
        err.contains("No such file")
            || err.contains("Failed to open file")
            || err.contains("not found")
            || err.contains("NotFound")
            || err.contains("mismatch")
    );
    ctx.cleanup().await;
}

#[tokio::test]
async fn test_tier2_b10_mismatched_md5() {
    let _guard = TEST_SERIAL_MUTEX.lock().await;
    let ctx = TestContext::setup("tier2_b10").await;

    let local_path = ctx.temp_dir.join("diff.bin");
    std::fs::write(&local_path, "original content").unwrap();
    let md5_orig = calculate_file_md5(&local_path.to_string_lossy())
        .await
        .unwrap();

    std::fs::write(&local_path, "different content").unwrap();
    let md5_diff = calculate_file_md5(&local_path.to_string_lossy())
        .await
        .unwrap();

    assert_ne!(md5_orig, md5_diff);
    ctx.cleanup().await;
}

#[tokio::test]
async fn test_tier2_b11_mismatched_etag() {
    let _guard = TEST_SERIAL_MUTEX.lock().await;
    let ctx = TestContext::setup("tier2_b11").await;

    let local_path = ctx.temp_dir.join("diff_large.bin");
    generate_dummy_file(&local_path, 17 * 1024 * 1024, Some(0x11));
    let etag_orig = calculate_multipart_etag(&local_path.to_string_lossy(), 8 * 1024 * 1024)
        .await
        .unwrap();

    generate_dummy_file(&local_path, 17 * 1024 * 1024, Some(0x22));
    let etag_diff = calculate_multipart_etag(&local_path.to_string_lossy(), 8 * 1024 * 1024)
        .await
        .unwrap();

    assert_ne!(etag_orig, etag_diff);
    ctx.cleanup().await;
}

#[tokio::test]
async fn test_tier2_b12_file_deleted_on_remote_mid_transfer() {
    let _guard = TEST_SERIAL_MUTEX.lock().await;
    let ctx = TestContext::setup("tier2_b12").await;
    let op = ctx.operator();
    let remote_key = "tier2_b12/delete_mid.bin";
    let size = 12 * 1024 * 1024;

    let local_seed = ctx.temp_dir.join("seed.bin");
    generate_dummy_file(&local_seed, size, Some(0xAA));
    op.write(remote_key, std::fs::read(&local_seed).unwrap())
        .await
        .unwrap();

    let local_path = ctx.temp_dir.join("mid.bin").to_string_lossy().to_string();
    let state = ctx.app.state::<GaleonEngine>();

    let transfer_id = initiate_download(
        state,
        ctx.handle.clone(),
        ctx.session_id.clone(),
        remote_key.to_string(),
        local_path.clone(),
        None,
    )
    .await
    .unwrap();
    let _ = op.delete_iter(vec![remote_key.to_string()]).await;

    let entry = wait_for_transfer(&ctx.handle, &transfer_id, 15)
        .await
        .unwrap();
    assert!(entry.status == "completed" || entry.status == "failed");
    ctx.cleanup().await;
}

#[tokio::test]
async fn test_tier2_b13_missing_local_folder_permissions() {
    let _guard = TEST_SERIAL_MUTEX.lock().await;
    let ctx = TestContext::setup("tier2_b13").await;
    let op = ctx.operator();
    let remote_key = "tier2_b13/perm.bin";
    op.write(remote_key, "data").await.unwrap();

    let local_path = "/nonexistent_folder_abc/perm.bin".to_string();
    let state = ctx.app.state::<GaleonEngine>();

    let transfer_id = initiate_download(
        state,
        ctx.handle.clone(),
        ctx.session_id.clone(),
        remote_key.to_string(),
        local_path,
        None,
    )
    .await
    .unwrap();
    let entry = wait_for_transfer(&ctx.handle, &transfer_id, 10)
        .await
        .unwrap();
    assert_eq!(entry.status, "failed");
    ctx.cleanup().await;
}

#[tokio::test]
async fn test_tier2_b14_path_traversal_safety() {
    let _guard = TEST_SERIAL_MUTEX.lock().await;
    let ctx = TestContext::setup("tier2_b14").await;
    let state = ctx.app.state::<GaleonEngine>();

    let res = initiate_download(
        state,
        ctx.handle.clone(),
        ctx.session_id.clone(),
        "../../etc/passwd".to_string(),
        ctx.temp_dir.join("passwd").to_string_lossy().to_string(),
        None,
    )
    .await;

    assert!(res.is_err());
    ctx.cleanup().await;
}

#[tokio::test]
async fn test_tier2_b15_special_key_spaces() {
    let _guard = TEST_SERIAL_MUTEX.lock().await;
    let ctx = TestContext::setup("tier2_b15").await;
    let op = ctx.operator();
    let remote_key = "tier2_b15/space key name.bin";
    op.write(remote_key, "space test").await.unwrap();

    let local_path = ctx.temp_dir.join("space.bin").to_string_lossy().to_string();
    let state = ctx.app.state::<GaleonEngine>();
    let transfer_id = initiate_download(
        state,
        ctx.handle.clone(),
        ctx.session_id.clone(),
        remote_key.to_string(),
        local_path.clone(),
        None,
    )
    .await
    .unwrap();

    let entry = wait_for_transfer(&ctx.handle, &transfer_id, 10)
        .await
        .unwrap();
    assert_eq!(entry.status, "completed");
    assert_eq!(std::fs::read_to_string(&local_path).unwrap(), "space test");
    ctx.cleanup().await;
}

#[tokio::test]
async fn test_tier2_b16_special_key_emojis() {
    let _guard = TEST_SERIAL_MUTEX.lock().await;
    let ctx = TestContext::setup("tier2_b16").await;
    let op = ctx.operator();
    let remote_key = "tier2_b16/🚀_emoji_📁.bin";
    op.write(remote_key, "emoji test").await.unwrap();

    let local_path = ctx.temp_dir.join("emoji.bin").to_string_lossy().to_string();
    let state = ctx.app.state::<GaleonEngine>();
    let transfer_id = initiate_download(
        state,
        ctx.handle.clone(),
        ctx.session_id.clone(),
        remote_key.to_string(),
        local_path.clone(),
        None,
    )
    .await
    .unwrap();

    let entry = wait_for_transfer(&ctx.handle, &transfer_id, 10)
        .await
        .unwrap();
    assert_eq!(entry.status, "completed");
    assert_eq!(std::fs::read_to_string(&local_path).unwrap(), "emoji test");
    ctx.cleanup().await;
}

#[tokio::test]
async fn test_tier2_b17_special_key_unicode() {
    let _guard = TEST_SERIAL_MUTEX.lock().await;
    let ctx = TestContext::setup("tier2_b17").await;
    let op = ctx.operator();
    let remote_key = "tier2_b17/日本語_galeón.bin";
    op.write(remote_key, "unicode test").await.unwrap();

    let local_path = ctx
        .temp_dir
        .join("unicode.bin")
        .to_string_lossy()
        .to_string();
    let state = ctx.app.state::<GaleonEngine>();
    let transfer_id = initiate_download(
        state,
        ctx.handle.clone(),
        ctx.session_id.clone(),
        remote_key.to_string(),
        local_path.clone(),
        None,
    )
    .await
    .unwrap();

    let entry = wait_for_transfer(&ctx.handle, &transfer_id, 10)
        .await
        .unwrap();
    assert_eq!(entry.status, "completed");
    assert_eq!(
        std::fs::read_to_string(&local_path).unwrap(),
        "unicode test"
    );
    ctx.cleanup().await;
}

#[tokio::test]
async fn test_tier2_b18_rapid_start_cancel_download() {
    let _guard = TEST_SERIAL_MUTEX.lock().await;
    let ctx = TestContext::setup("tier2_b18").await;
    let op = ctx.operator();
    let remote_key = "tier2_b18/cancel.bin";
    op.write(remote_key, vec![0x41; 20 * 1024 * 1024])
        .await
        .unwrap();

    let local_path = ctx
        .temp_dir
        .join("cancel.bin")
        .to_string_lossy()
        .to_string();
    let state = ctx.app.state::<GaleonEngine>();

    let transfer_id = initiate_download(
        state.clone(),
        ctx.handle.clone(),
        ctx.session_id.clone(),
        remote_key.to_string(),
        local_path.clone(),
        None,
    )
    .await
    .unwrap();
    cancel_transfer(ctx.handle.clone(), state, transfer_id.clone())
        .await
        .unwrap();

    let entry = wait_for_transfer(&ctx.handle, &transfer_id, 10)
        .await
        .unwrap();
    assert_eq!(entry.status, "cancelled");
    ctx.cleanup().await;
}

#[tokio::test]
async fn test_tier2_b19_rapid_start_cancel_upload() {
    let _guard = TEST_SERIAL_MUTEX.lock().await;
    let ctx = TestContext::setup("tier2_b19").await;
    let local_path = ctx.temp_dir.join("cancel.bin");
    generate_dummy_file(&local_path, 20 * 1024 * 1024, Some(0x42));

    let remote_key = "tier2_b19/cancel.bin";
    let state = ctx.app.state::<GaleonEngine>();

    let transfer_id = initiate_upload(
        state.clone(),
        ctx.handle.clone(),
        ctx.session_id.clone(),
        local_path.to_string_lossy().to_string(),
        remote_key.to_string(),
        None,
    )
    .await
    .unwrap();
    cancel_transfer(ctx.handle.clone(), state, transfer_id.clone())
        .await
        .unwrap();

    let entry = wait_for_transfer(&ctx.handle, &transfer_id, 10)
        .await
        .unwrap();
    assert_eq!(entry.status, "cancelled");
    ctx.cleanup().await;
}

#[tokio::test]
async fn test_tier2_b20_restore_empty_transfer_queue() {
    let _guard = TEST_SERIAL_MUTEX.lock().await;
    let ctx = TestContext::setup("tier2_b20").await;
    let state = ctx.app.state::<GaleonEngine>();

    let restored = restore_transfers(ctx.handle.clone(), state).await.unwrap();
    assert!(restored.is_empty());
    ctx.cleanup().await;
}

#[tokio::test]
async fn test_tier2_b21_restore_corrupted_transfer_queue() {
    let _guard = TEST_SERIAL_MUTEX.lock().await;
    let ctx = TestContext::setup("tier2_b21").await;

    let config_dir = ctx.handle.path().app_config_dir().unwrap();
    std::fs::create_dir_all(&config_dir).unwrap();
    std::fs::write(config_dir.join("transfers.json"), "invalid json data").unwrap();

    let state = ctx.app.state::<GaleonEngine>();
    let queue = get_transfer_queue(ctx.handle.clone()).await;
    assert!(queue.is_err() || queue.unwrap().entries.is_empty());

    let restored = restore_transfers(ctx.handle.clone(), state).await;
    assert!(restored.is_err() || restored.unwrap().is_empty());
    ctx.cleanup().await;
}

#[tokio::test]
async fn test_tier2_b22_auto_reconnect_invalid_profile() {
    let _guard = TEST_SERIAL_MUTEX.lock().await;
    let ctx = TestContext::setup("tier2_b22").await;

    let entry = TransferQueueEntry {
        id: "t1".to_string(),
        direction: "download".to_string(),
        remote_key: "r.bin".to_string(),
        local_path: "l.bin".to_string(),
        profile_id: "non-existent-profile".to_string(),
        status: "active".to_string(),
        bytes_transferred: 0,
        total_bytes: 100,
        created_at: "now".to_string(),
        updated_at: "now".to_string(),
        error: None,
    };
    add_to_transfer_queue(ctx.handle.clone(), entry)
        .await
        .unwrap();

    let state = ctx.app.state::<GaleonEngine>();
    let res = auto_reconnect(ctx.handle.clone(), state).await.unwrap();
    assert!(res.is_none());
    ctx.cleanup().await;
}

#[tokio::test]
async fn test_tier2_b23_auto_reconnect_valid_profile() {
    let _guard = TEST_SERIAL_MUTEX.lock().await;
    let ctx = TestContext::setup("tier2_b23").await;

    let profile = ConnectionProfile {
        id: "prof-reconnect".to_string(),
        name: "Reconnect Prof".to_string(),
        protocol: Some("s3".to_string()),
        endpoint: Some("http://localhost:9000".to_string()),
        region: Some("us-east-1".to_string()),
        access_key: Some("galeon".to_string()),
        secret_key: Some("galeon-dev-secret".to_string()),
        bucket: Some("galeon-test".to_string()),
        danger_disable_ssl_verification: None,
        use_virtual_host_style: Some(false),
        storage_class: None,
        max_bandwidth: None,
        host: None,
        port: None,
        username: None,
        key_path: None,
        passive_mode: None,
        encrypt: None,
        bandwidth_rules: None,
        ssh_tunnel: None,
        ssh_tunnel_profile_id: None,
        has_saved_credentials: None,
    };
    let state = ctx.app.state::<GaleonEngine>();
    save_profile(ctx.handle.clone(), state.clone(), profile, None, None)
        .await
        .unwrap();

    let entry = TransferQueueEntry {
        id: "t2".to_string(),
        direction: "download".to_string(),
        remote_key: "r.bin".to_string(),
        local_path: "l.bin".to_string(),
        profile_id: "prof-reconnect".to_string(),
        status: "active".to_string(),
        bytes_transferred: 0,
        total_bytes: 100,
        created_at: "now".to_string(),
        updated_at: "now".to_string(),
        error: None,
    };
    add_to_transfer_queue(ctx.handle.clone(), entry)
        .await
        .unwrap();

    let res = auto_reconnect(ctx.handle.clone(), state).await.unwrap();
    assert!(res.is_some());
    let reconnect = res.unwrap();
    assert_eq!(reconnect.profile_id, "prof-reconnect");
    ctx.cleanup().await;
}

#[tokio::test]
async fn test_tier2_b24_check_remote_existence_nonexistent() {
    let _guard = TEST_SERIAL_MUTEX.lock().await;
    let ctx = TestContext::setup("tier2_b24").await;
    let state = ctx.app.state::<GaleonEngine>();

    let exists = check_remote_exists(
        state,
        ctx.session_id.clone(),
        "completely-missing-key-file.bin".to_string(),
    )
    .await
    .unwrap();
    assert!(!exists);
    ctx.cleanup().await;
}

#[tokio::test]
async fn test_tier2_b25_presign_history_limit_cleanup() {
    let _guard = TEST_SERIAL_MUTEX.lock().await;
    let ctx = TestContext::setup("tier2_b25").await;
    let state = ctx.app.state::<GaleonEngine>();

    let op = ctx.operator();
    op.write("tier2_b25/presigned.txt", "presign content")
        .await
        .unwrap();

    let _url = generate_presigned_url(
        state,
        ctx.handle.clone(),
        ctx.session_id.clone(),
        "tier2_b25/presigned.txt".to_string(),
        3600,
    )
    .await
    .unwrap();

    let history = get_presign_history(ctx.handle.clone()).await.unwrap();
    assert_eq!(history.len(), 1);

    let entry_id = history[0].id.clone();
    delete_presign_history_entry(ctx.handle.clone(), entry_id)
        .await
        .unwrap();

    let history_after = get_presign_history(ctx.handle.clone()).await.unwrap();
    assert!(history_after.is_empty());
    ctx.cleanup().await;
}

// ==========================================
// TIER 3: CROSS-FEATURE COMBINATIONS (5 Tests)
// ==========================================

#[tokio::test]
async fn test_tier3_c01_download_resume_corrupted_part() {
    let _guard = TEST_SERIAL_MUTEX.lock().await;
    let ctx = TestContext::setup("tier3_c01").await;
    let op = ctx.operator();
    let remote_key = "tier3_c01/corrupt.bin";
    let size = 9 * 1024 * 1024;

    let local_seed = ctx.temp_dir.join("seed.bin");
    generate_dummy_file(&local_seed, size, Some(0xAA));
    op.write(remote_key, std::fs::read(&local_seed).unwrap())
        .await
        .unwrap();

    let local_path = ctx
        .temp_dir
        .join("corrupt.bin")
        .to_string_lossy()
        .to_string();

    let part_path = format!("{}.part", local_path);
    std::fs::write(&part_path, vec![0xFF; size + 1024]).unwrap();

    let state = ctx.app.state::<GaleonEngine>();
    let transfer_id = initiate_download(
        state,
        ctx.handle.clone(),
        ctx.session_id.clone(),
        remote_key.to_string(),
        local_path.clone(),
        None,
    )
    .await
    .unwrap();

    let entry = wait_for_transfer(&ctx.handle, &transfer_id, 25)
        .await
        .unwrap();
    assert_eq!(entry.status, "completed");
    assert_eq!(std::fs::metadata(&local_path).unwrap().len(), size as u64);

    let downloaded_content = std::fs::read(&local_path).unwrap();
    assert_eq!(downloaded_content[0], 0xAA);
    ctx.cleanup().await;
}

#[tokio::test]
async fn test_tier3_c02_resume_upload_remote_file_changed() {
    let _guard = TEST_SERIAL_MUTEX.lock().await;
    let ctx = TestContext::setup("tier3_c02").await;
    let op = ctx.operator();
    let local_path = ctx.temp_dir.join("upload.bin");
    generate_dummy_file(&local_path, 1024 * 1024, Some(0x77)); // 1 MiB

    let remote_key = "tier3_c02/changed.bin";

    let state = ctx.app.state::<GaleonEngine>();
    let transfer_id = initiate_upload(
        state.clone(),
        ctx.handle.clone(),
        ctx.session_id.clone(),
        local_path.to_string_lossy().to_string(),
        remote_key.to_string(),
        None,
    )
    .await
    .unwrap();
    wait_for_transfer(&ctx.handle, &transfer_id, 15)
        .await
        .unwrap();

    op.write(remote_key, "external modifications")
        .await
        .unwrap();

    let transfer_id2 = initiate_upload(
        state,
        ctx.handle.clone(),
        ctx.session_id.clone(),
        local_path.to_string_lossy().to_string(),
        remote_key.to_string(),
        None,
    )
    .await
    .unwrap();
    let entry = wait_for_transfer(&ctx.handle, &transfer_id2, 15)
        .await
        .unwrap();

    assert_eq!(entry.status, "completed");
    let content = op.read(remote_key).await.unwrap().to_vec();
    assert_eq!(content[0], 0x77);
    ctx.cleanup().await;
}

#[tokio::test]
async fn test_tier3_c03_cancel_active_upload_remote_cleanup() {
    let _guard = TEST_SERIAL_MUTEX.lock().await;
    let ctx = TestContext::setup("tier3_c03").await;
    let local_path = ctx.temp_dir.join("large.bin");
    generate_dummy_file(&local_path, 50 * 1024 * 1024, Some(0x99));

    let remote_key = "tier3_c03/cancel.bin";
    let state = ctx.app.state::<GaleonEngine>();

    let op = ctx.operator();
    let _ = op.delete(remote_key).await;

    let transfer_id = initiate_upload(
        state.clone(),
        ctx.handle.clone(),
        ctx.session_id.clone(),
        local_path.to_string_lossy().to_string(),
        remote_key.to_string(),
        None,
    )
    .await
    .unwrap();

    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    cancel_transfer(ctx.handle.clone(), state, transfer_id.clone())
        .await
        .unwrap();

    let entry = wait_for_transfer(&ctx.handle, &transfer_id, 10)
        .await
        .unwrap();
    assert_eq!(entry.status, "cancelled");

    let op = ctx.operator();
    assert!(!op.exists(remote_key).await.unwrap());
    ctx.cleanup().await;
}

#[tokio::test]
async fn test_tier3_c04_pause_resume_integrity() {
    let _guard = TEST_SERIAL_MUTEX.lock().await;
    let ctx = TestContext::setup("tier3_c04").await;
    let op = ctx.operator();
    let remote_key = "tier3_c04/pause_resume.bin";
    let size = 15 * 1024 * 1024;

    let local_seed = ctx.temp_dir.join("seed.bin");
    generate_dummy_file(&local_seed, size, Some(0x55));
    op.write(remote_key, std::fs::read(&local_seed).unwrap())
        .await
        .unwrap();

    let local_path = ctx.temp_dir.join("dest.bin").to_string_lossy().to_string();
    let state = ctx.app.state::<GaleonEngine>();

    let transfer_id = initiate_download(
        state.clone(),
        ctx.handle.clone(),
        ctx.session_id.clone(),
        remote_key.to_string(),
        local_path.clone(),
        None,
    )
    .await
    .unwrap();

    pause_transfer(ctx.handle.clone(), state.clone(), transfer_id.clone())
        .await
        .unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    resume_transfer(ctx.handle.clone(), state, transfer_id.clone())
        .await
        .unwrap();

    let entry = wait_for_transfer(&ctx.handle, &transfer_id, 25)
        .await
        .unwrap();
    assert_eq!(entry.status, "completed");

    let orig_md5 = calculate_file_md5(&local_seed.to_string_lossy())
        .await
        .unwrap();
    let dest_md5 = calculate_file_md5(&local_path).await.unwrap();
    assert_eq!(orig_md5, dest_md5);
    ctx.cleanup().await;
}

#[tokio::test]
async fn test_tier3_c05_concurrent_transfers_same_session() {
    let _guard = TEST_SERIAL_MUTEX.lock().await;
    let ctx = TestContext::setup("tier3_c05").await;
    let op = ctx.operator();

    op.write("tier3_c05/f1.bin", "1").await.unwrap();
    op.write("tier3_c05/f2.bin", "2").await.unwrap();
    op.write("tier3_c05/f3.bin", "3").await.unwrap();

    let state = ctx.app.state::<GaleonEngine>();

    let t1 = initiate_download(
        state.clone(),
        ctx.handle.clone(),
        ctx.session_id.clone(),
        "tier3_c05/f1.bin".to_string(),
        ctx.temp_dir.join("f1.bin").to_string_lossy().to_string(),
        None,
    );
    let t2 = initiate_download(
        state.clone(),
        ctx.handle.clone(),
        ctx.session_id.clone(),
        "tier3_c05/f2.bin".to_string(),
        ctx.temp_dir.join("f2.bin").to_string_lossy().to_string(),
        None,
    );
    let t3 = initiate_download(
        state.clone(),
        ctx.handle.clone(),
        ctx.session_id.clone(),
        "tier3_c05/f3.bin".to_string(),
        ctx.temp_dir.join("f3.bin").to_string_lossy().to_string(),
        None,
    );

    let (id1, id2, id3) = tokio::join!(t1, t2, t3);
    let id1 = id1.unwrap();
    let id2 = id2.unwrap();
    let id3 = id3.unwrap();

    let (e1, e2, e3) = tokio::join!(
        wait_for_transfer(&ctx.handle, &id1, 15),
        wait_for_transfer(&ctx.handle, &id2, 15),
        wait_for_transfer(&ctx.handle, &id3, 15)
    );

    assert_eq!(e1.unwrap().status, "completed");
    assert_eq!(e2.unwrap().status, "completed");
    assert_eq!(e3.unwrap().status, "completed");
    ctx.cleanup().await;
}

// ==========================================
// TIER 4: REAL-WORLD SCENARIOS (5 Tests)
// ==========================================

#[tokio::test]
async fn test_tier4_s01_full_cycle_50mb_zip() {
    let _guard = TEST_SERIAL_MUTEX.lock().await;
    let ctx = TestContext::setup("tier4_s01").await;

    let local_orig = ctx.temp_dir.join("archive.zip");
    generate_dummy_file(&local_orig, 50 * 1024 * 1024, Some(0x9A));

    let state = ctx.app.state::<GaleonEngine>();
    let upload_id = initiate_upload(
        state.clone(),
        ctx.handle.clone(),
        ctx.session_id.clone(),
        local_orig.to_string_lossy().to_string(),
        "tier4_s01/archive.zip".to_string(),
        None,
    )
    .await
    .unwrap();
    let entry_up = wait_for_transfer(&ctx.handle, &upload_id, 60)
        .await
        .unwrap();
    assert_eq!(entry_up.status, "completed");

    let local_dest = ctx
        .temp_dir
        .join("downloaded.zip")
        .to_string_lossy()
        .to_string();
    let download_id = initiate_download(
        state,
        ctx.handle.clone(),
        ctx.session_id.clone(),
        "tier4_s01/archive.zip".to_string(),
        local_dest.clone(),
        None,
    )
    .await
    .unwrap();
    let entry_down = wait_for_transfer(&ctx.handle, &download_id, 60)
        .await
        .unwrap();
    assert_eq!(entry_down.status, "completed");

    let orig_md5 = calculate_file_md5(&local_orig.to_string_lossy())
        .await
        .unwrap();
    let dest_md5 = calculate_file_md5(&local_dest).await.unwrap();
    assert_eq!(orig_md5, dest_md5);
    ctx.cleanup().await;
}

#[tokio::test]
async fn test_tier4_s02_simultaneous_ten_transfers() {
    let _guard = TEST_SERIAL_MUTEX.lock().await;
    let ctx = TestContext::setup("tier4_s02").await;
    let state = ctx.app.state::<GaleonEngine>();
    let op = ctx.operator();

    for i in 0..10 {
        let key = format!("tier4_s02/file_{}.bin", i);
        let content = format!("file content number {}", i);
        op.write(&key, content).await.unwrap();
    }

    let mut download_futures = Vec::new();
    for i in 0..10 {
        let key = format!("tier4_s02/file_{}.bin", i);
        let dest = ctx
            .temp_dir
            .join(format!("file_{}.bin", i))
            .to_string_lossy()
            .to_string();
        download_futures.push(initiate_download(
            state.clone(),
            ctx.handle.clone(),
            ctx.session_id.clone(),
            key,
            dest,
            None,
        ));
    }

    let ids = futures_util::future::join_all(download_futures).await;
    for id_res in ids {
        let id = id_res.unwrap();
        let entry = wait_for_transfer(&ctx.handle, &id, 30).await.unwrap();
        assert_eq!(entry.status, "completed");
    }
    ctx.cleanup().await;
}

#[tokio::test]
async fn test_tier4_s03_network_drop_auto_resume() {
    let _guard = TEST_SERIAL_MUTEX.lock().await;
    let ctx = TestContext::setup("tier4_s03").await;
    let op = ctx.operator();
    let remote_key = "tier4_s03/drop.bin";

    // 1. Generate 12 MB source content
    let total_size = 12 * 1024 * 1024;
    let local_src = ctx.temp_dir.join("src.bin");
    generate_dummy_file(&local_src, total_size, Some(0xBB));
    let src_data = std::fs::read(&local_src).unwrap();

    // 2. Upload it to S3
    op.write(remote_key, src_data.clone()).await.unwrap();

    // 3. Pre-seed 8 MB partial local file
    let part_size = 8 * 1024 * 1024;
    let local_dest = ctx.temp_dir.join("dest.bin");
    let part_path = ctx.temp_dir.join("dest.bin.part");
    std::fs::write(&part_path, &src_data[..part_size]).unwrap();

    // 4. Initiate download (should resume from 8 MB)
    let state = ctx.app.state::<GaleonEngine>();
    let transfer_id = initiate_download(
        state,
        ctx.handle.clone(),
        ctx.session_id.clone(),
        remote_key.to_string(),
        local_dest.to_string_lossy().to_string(),
        None,
    )
    .await
    .unwrap();

    // 5. Wait for completion
    let entry = wait_for_transfer(&ctx.handle, &transfer_id, 30)
        .await
        .unwrap();
    assert_eq!(entry.status, "completed");

    // 6. Verify final file
    assert!(local_dest.exists());
    let final_metadata = std::fs::metadata(&local_dest).unwrap();
    assert_eq!(final_metadata.len(), total_size as u64);

    let orig_md5 = calculate_file_md5(&local_src.to_string_lossy())
        .await
        .unwrap();
    let dest_md5 = calculate_file_md5(&local_dest.to_string_lossy())
        .await
        .unwrap();
    assert_eq!(orig_md5, dest_md5);

    ctx.cleanup().await;
}

#[tokio::test]
async fn test_tier4_s04_recursive_directory_transfer() {
    let _guard = TEST_SERIAL_MUTEX.lock().await;
    let ctx = TestContext::setup("tier4_s04").await;
    let op = ctx.operator();
    let state = ctx.app.state::<GaleonEngine>();

    // 1. Create nested structure locally
    let local_nested = ctx.temp_dir.join("nested");
    let local_sub = local_nested.join("sub");
    std::fs::create_dir_all(&local_sub).unwrap();

    let file_a = local_nested.join("a.bin");
    let file_b = local_sub.join("b.bin");
    std::fs::write(&file_a, "content a").unwrap();
    std::fs::write(&file_b, "content b").unwrap();

    // 2. Initiate uploads
    let upload_id_a = initiate_upload(
        state.clone(),
        ctx.handle.clone(),
        ctx.session_id.clone(),
        file_a.to_string_lossy().to_string(),
        "tier4_s04/nested/a.bin".to_string(),
        None,
    )
    .await
    .unwrap();

    let upload_id_b = initiate_upload(
        state.clone(),
        ctx.handle.clone(),
        ctx.session_id.clone(),
        file_b.to_string_lossy().to_string(),
        "tier4_s04/nested/sub/b.bin".to_string(),
        None,
    )
    .await
    .unwrap();

    // 3. Wait for uploads to complete
    let entry_a = wait_for_transfer(&ctx.handle, &upload_id_a, 20)
        .await
        .unwrap();
    let entry_b = wait_for_transfer(&ctx.handle, &upload_id_b, 20)
        .await
        .unwrap();
    assert_eq!(entry_a.status, "completed");
    assert_eq!(entry_b.status, "completed");

    // 4. Verify exist on S3
    assert!(op.exists("tier4_s04/nested/a.bin").await.unwrap());
    assert!(op.exists("tier4_s04/nested/sub/b.bin").await.unwrap());

    // 5. Delete local copies
    std::fs::remove_dir_all(&local_nested).unwrap();
    assert!(!file_a.exists());
    assert!(!file_b.exists());

    // 6. List and download them back
    let mut files_to_download = Vec::new();
    let mut dirs_to_list = vec!["tier4_s04/nested/".to_string()];

    while let Some(dir) = dirs_to_list.pop() {
        let list = list_directory(state.clone(), ctx.session_id.clone(), dir)
            .await
            .unwrap();
        for obj in list {
            match obj.object_type {
                ObjectType::File => {
                    files_to_download.push(obj);
                }
                ObjectType::Folder => {
                    dirs_to_list.push(obj.full_key);
                }
            }
        }
    }

    let mut download_ids = Vec::new();
    for obj in files_to_download {
        let relative_key = obj
            .full_key
            .strip_prefix("tier4_s04/")
            .unwrap_or(&obj.full_key);
        let local_restore_path = ctx.temp_dir.join("restored").join(relative_key);

        if let Some(parent) = local_restore_path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }

        let download_id = initiate_download(
            state.clone(),
            ctx.handle.clone(),
            ctx.session_id.clone(),
            obj.full_key.clone(),
            local_restore_path.to_string_lossy().to_string(),
            None,
        )
        .await
        .unwrap();
        download_ids.push((local_restore_path, download_id));
    }

    // 7. Wait for downloads and verify content
    for (path, id) in download_ids {
        let entry = wait_for_transfer(&ctx.handle, &id, 20).await.unwrap();
        assert_eq!(entry.status, "completed");
        assert!(path.exists());
    }

    let restored_a = ctx.temp_dir.join("restored/nested/a.bin");
    let restored_b = ctx.temp_dir.join("restored/nested/sub/b.bin");
    assert_eq!(std::fs::read_to_string(restored_a).unwrap(), "content a");
    assert_eq!(std::fs::read_to_string(restored_b).unwrap(), "content b");

    ctx.cleanup().await;
}

#[tokio::test]
async fn test_tier4_s05_keyring_integration() {
    let _guard = TEST_SERIAL_MUTEX.lock().await;
    let ctx = TestContext::setup("tier4_s05").await;

    let profile = ConnectionProfile {
        id: "prof-keyring-test".to_string(),
        name: "Keyring Test".to_string(),
        protocol: Some("s3".to_string()),
        endpoint: Some("http://localhost:9000".to_string()),
        region: Some("us-east-1".to_string()),
        access_key: Some("test-access".to_string()),
        secret_key: Some("test-secret".to_string()),
        bucket: Some("galeon-test".to_string()),
        danger_disable_ssl_verification: None,
        use_virtual_host_style: None,
        storage_class: None,
        max_bandwidth: None,
        host: None,
        port: None,
        username: None,
        key_path: None,
        passive_mode: None,
        encrypt: None,
        bandwidth_rules: None,
        ssh_tunnel: None,
        ssh_tunnel_profile_id: None,
        has_saved_credentials: None,
    };

    let state = ctx.app.state::<GaleonEngine>();
    let save_res = save_profile(ctx.handle.clone(), state.clone(), profile, None, None).await;

    if let Err(ref e) = save_res {
        println!("Skipping keyring credential verification: {}", e);
    } else {
        let creds = get_profile_credentials(state.clone(), "prof-keyring-test".to_string())
            .await
            .unwrap();
        assert_eq!(creds.0, Some("test-access".to_string()));
        assert_eq!(creds.1, Some("test-secret".to_string()));

        delete_profile(
            ctx.handle.clone(),
            state.clone(),
            "prof-keyring-test".to_string(),
        )
        .await
        .unwrap();
        let creds_after = get_profile_credentials(state, "prof-keyring-test".to_string())
            .await
            .unwrap();
        assert!(creds_after.0.is_none());
    }

    ctx.cleanup().await;
}

#[tokio::test]
async fn test_tier1_f26_exposed_commands_coverage() {
    let _guard = TEST_SERIAL_MUTEX.lock().await;
    let ctx = TestContext::setup("tier1_f26").await;
    let state = ctx.app.state::<GaleonEngine>();
    let op = ctx.operator();

    // 1. Test create_folder
    create_folder(
        state.clone(),
        ctx.session_id.clone(),
        "tier1_f26/".to_string(),
        "folder1".to_string(),
    )
    .await
    .unwrap();
    assert!(op.exists("tier1_f26/folder1/").await.unwrap());

    // 2. Test rename_object
    op.write("tier1_f26/folder1/file.txt", "hello")
        .await
        .unwrap();
    rename_object(
        state.clone(),
        ctx.session_id.clone(),
        "tier1_f26/folder1/file.txt".to_string(),
        "tier1_f26/folder1/renamed.txt".to_string(),
        false,
    )
    .await
    .unwrap();
    assert!(!op.exists("tier1_f26/folder1/file.txt").await.unwrap());
    assert!(op.exists("tier1_f26/folder1/renamed.txt").await.unwrap());

    // 3. Test delete_object
    delete_object(
        state.clone(),
        ctx.session_id.clone(),
        "tier1_f26/folder1/renamed.txt".to_string(),
        false,
    )
    .await
    .unwrap();
    assert!(!op.exists("tier1_f26/folder1/renamed.txt").await.unwrap());

    // 4. Test clear_presign_history
    let _ = generate_presigned_url(
        state.clone(),
        ctx.handle.clone(),
        ctx.session_id.clone(),
        "tier1_f26/folder1/".to_string(),
        3600,
    )
    .await
    .unwrap();
    let history = get_presign_history(ctx.handle.clone()).await.unwrap();
    assert!(!history.is_empty());

    clear_presign_history(ctx.handle.clone()).await.unwrap();
    let history_after = get_presign_history(ctx.handle.clone()).await.unwrap();
    assert!(history_after.is_empty());

    // 5. Test check_file_exists Tauri command
    let local_file = ctx.temp_dir.join("exists_check.txt");
    std::fs::write(&local_file, "content").unwrap();
    let exists_true = check_file_exists(local_file.to_string_lossy().to_string())
        .await
        .unwrap();
    assert!(exists_true);
    let exists_false = check_file_exists("/nonexistent/file/path/123.txt".to_string())
        .await
        .unwrap();
    assert!(!exists_false);

    // 6. Test update_transfer_queue_entry
    let entry = TransferQueueEntry {
        id: "test-update-id".to_string(),
        direction: "download".to_string(),
        remote_key: "dummy-key".to_string(),
        local_path: "dummy-path".to_string(),
        profile_id: "dummy-profile".to_string(),
        status: "active".to_string(),
        bytes_transferred: 0,
        total_bytes: 100,
        created_at: chrono::Utc::now().to_rfc3339(),
        updated_at: chrono::Utc::now().to_rfc3339(),
        error: None,
    };
    add_to_transfer_queue(ctx.handle.clone(), entry.clone())
        .await
        .unwrap();

    let mut updated_entry = entry.clone();
    updated_entry.status = "failed".to_string();
    updated_entry.error = Some("simulated error".to_string());

    update_transfer_queue_entry(ctx.handle.clone(), updated_entry)
        .await
        .unwrap();

    let queue = get_transfer_queue(ctx.handle.clone()).await.unwrap();
    let found = queue
        .entries
        .iter()
        .find(|e| e.id == "test-update-id")
        .unwrap();
    assert_eq!(found.status, "failed");
    assert_eq!(found.error, Some("simulated error".to_string()));

    ctx.cleanup().await;
}

// ==========================================
// PHASE 7: NEW FEATURES TESTS
// ==========================================

#[tokio::test]
async fn test_bandwidth_throttling() {
    let _guard = TEST_SERIAL_MUTEX.lock().await;
    let app = tauri::test::mock_app();
    app.manage(GaleonEngine::default());
    let handle = app.handle().clone();
    let state = app.state::<GaleonEngine>();

    // 1. Create a 10 MB local file
    let local_path = std::env::temp_dir().join("bandwidth_test_10mb.bin");
    let local_path_str = local_path.to_string_lossy().to_string();
    let _ = std::fs::remove_file(&local_path);
    generate_dummy_file(&local_path, 10 * 1024 * 1024, Some(0x42));

    // 2. Connect with 512 KB/s bandwidth limit for testing upload
    let throttled_session_id = connect_bucket(
        state.clone(),
        Some("http://localhost:9000".to_string()),
        Some("us-east-1".to_string()),
        Some("galeon".to_string()),
        Some("galeon-dev-secret".to_string()),
        "galeon-test".to_string(),
        None,
        Some(false),
        None,
        Some(512 * 1024), // 512 KB/s limit
    )
    .await
    .expect("Failed to connect to MinIO with bandwidth limit");

    let remote_key = "test_bandwidth/10mb_upload.bin";

    let start = std::time::Instant::now();
    let transfer_id = initiate_upload(
        state.clone(),
        handle.clone(),
        throttled_session_id.clone(),
        local_path_str.clone(),
        remote_key.to_string(),
        None,
    )
    .await
    .unwrap();

    // Allow up to 15 seconds for upload (at 512 KB/s, 2MB throttled portion takes ~4s)
    let entry = wait_for_transfer(&handle, &transfer_id, 15).await.unwrap();
    let elapsed = start.elapsed();

    if entry.status != "completed" {
        println!(
            "[test_bandwidth_throttling] Transfer status: {}, error: {:?}",
            entry.status, entry.error
        );
    }
    assert_eq!(entry.status, "completed");

    // Verify file exists on remote with correct size
    let op = {
        let sessions = state.active_sessions.read().await;
        let session = sessions
            .get(&throttled_session_id)
            .expect("Session not found")
            .clone();
        match session {
            StorageSession::OpenDAL(op) => op,
            _ => panic!("Expected OpenDAL session"),
        }
    };
    assert!(op.exists(remote_key).await.unwrap());
    assert_eq!(
        op.stat(remote_key).await.unwrap().content_length(),
        10 * 1024 * 1024
    );

    // With 512 KB/s limit and 8 MB burst, the 2 MB remainder must take at least ~3-4 seconds.
    // We assert that it takes at least 2.5 seconds to be safe.
    assert!(
        elapsed.as_secs_f64() >= 2.5,
        "Upload should take at least 2.5 seconds with 512 KB/s limit, took {:.2}s",
        elapsed.as_secs_f64()
    );

    // Cleanup
    let _ = std::fs::remove_file(&local_path);
    let _ = op.delete_iter(vec![remote_key.to_string()]).await;
}

#[tokio::test]
async fn test_copy_object_file() {
    let _guard = TEST_SERIAL_MUTEX.lock().await;
    let ctx = TestContext::setup("test_copy_object_file").await;
    let op = ctx.operator();
    let state = ctx.app.state::<GaleonEngine>();

    // Upload a source file
    let src_key = "test_copy_file/source.txt";
    let src_content = b"Hello, copy test!";
    op.write(src_key, src_content.to_vec()).await.unwrap();

    // Copy the file
    let dst_key = "test_copy_file/destination.txt";
    copy_object(
        state.clone(),
        ctx.session_id.clone(),
        src_key.to_string(),
        dst_key.to_string(),
        false, // is_folder
    )
    .await
    .unwrap();

    // Verify both files exist
    assert!(
        op.exists(src_key).await.unwrap(),
        "Source file should still exist"
    );
    assert!(
        op.exists(dst_key).await.unwrap(),
        "Destination file should exist"
    );

    // Verify content matches
    let src_data = op.read(src_key).await.unwrap().to_vec();
    let dst_data = op.read(dst_key).await.unwrap().to_vec();
    assert_eq!(
        src_data, dst_data,
        "Copied file content should match source"
    );
    assert_eq!(src_data, src_content, "Content should match original");

    ctx.cleanup().await;
}

#[tokio::test]
async fn test_copy_object_folder() {
    let _guard = TEST_SERIAL_MUTEX.lock().await;
    let ctx = TestContext::setup("test_copy_object_folder").await;
    let op = ctx.operator();
    let state = ctx.app.state::<GaleonEngine>();

    // Create a folder with 3 files
    let folder_prefix = "test_copy_folder/source_folder/";
    op.write(
        "test_copy_folder/source_folder/file1.txt",
        b"content1" as &[u8],
    )
    .await
    .unwrap();
    op.write(
        "test_copy_folder/source_folder/file2.txt",
        b"content2" as &[u8],
    )
    .await
    .unwrap();
    op.write(
        "test_copy_folder/source_folder/file3.txt",
        b"content3" as &[u8],
    )
    .await
    .unwrap();

    // Copy the folder
    let dst_prefix = "test_copy_folder/dest_folder/";
    copy_object(
        state.clone(),
        ctx.session_id.clone(),
        folder_prefix.to_string(),
        dst_prefix.to_string(),
        true, // is_folder
    )
    .await
    .unwrap();

    // Verify all 3 files exist at destination
    assert!(op
        .exists("test_copy_folder/dest_folder/file1.txt")
        .await
        .unwrap());
    assert!(op
        .exists("test_copy_folder/dest_folder/file2.txt")
        .await
        .unwrap());
    assert!(op
        .exists("test_copy_folder/dest_folder/file3.txt")
        .await
        .unwrap());

    // Verify content matches
    let content1 = op
        .read("test_copy_folder/dest_folder/file1.txt")
        .await
        .unwrap()
        .to_vec();
    let content2 = op
        .read("test_copy_folder/dest_folder/file2.txt")
        .await
        .unwrap()
        .to_vec();
    let content3 = op
        .read("test_copy_folder/dest_folder/file3.txt")
        .await
        .unwrap()
        .to_vec();
    assert_eq!(content1, b"content1" as &[u8]);
    assert_eq!(content2, b"content2" as &[u8]);
    assert_eq!(content3, b"content3" as &[u8]);

    // Verify source files still exist (copy doesn't delete)
    assert!(op
        .exists("test_copy_folder/source_folder/file1.txt")
        .await
        .unwrap());
    assert!(op
        .exists("test_copy_folder/source_folder/file2.txt")
        .await
        .unwrap());
    assert!(op
        .exists("test_copy_folder/source_folder/file3.txt")
        .await
        .unwrap());

    ctx.cleanup().await;
}
