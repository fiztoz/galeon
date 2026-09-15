//! Transfer integrity (tier 1: hashes, multipart, queue, commands, throttle, copy).
//!
//! Shared harness (TestContext, wait_for_transfer, …) lives in `super`.

use super::*;
use crate::*;

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
