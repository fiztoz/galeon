//! Tier 2 boundary and adversarial cases.
//!
//! Shared harness (TestContext, wait_for_transfer, …) lives in `super`.

use super::*;
use crate::*;

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

#[tokio::test]
async fn test_tier2_b26_presign_upload_url_roundtrip() {
    let _guard = TEST_SERIAL_MUTEX.lock().await;
    let ctx = TestContext::setup("tier2_b26").await;
    let state = ctx.app.state::<GaleonEngine>();

    // presign_write must succeed for a key that does not exist yet — the
    // whole point of an upload grant is creating the object.
    let url = generate_presigned_upload_url(
        state,
        ctx.handle.clone(),
        ctx.session_id.clone(),
        "tier2_b26/upload-target.txt".to_string(),
        3600,
    )
    .await
    .unwrap();
    assert!(url.contains("tier2_b26/upload-target.txt"));

    // History records the upload newest-first with operation "upload".
    let history = get_presign_history(ctx.handle.clone()).await.unwrap();
    assert_eq!(history.len(), 1);
    assert_eq!(history[0].operation, "upload");
    assert_eq!(history[0].file_key, "tier2_b26/upload-target.txt");

    // The URL is a real PUT grant: upload through plain HTTP (MinIO dev
    // endpoint is http, so no TLS stack needed) and read the object back
    // through the operator.
    let resp = reqwest::Client::new()
        .put(&url)
        .body("presigned upload body")
        .send()
        .await
        .unwrap();
    assert!(
        resp.status().is_success(),
        "presigned PUT status: {}",
        resp.status()
    );

    let op = ctx.operator();
    let content = op
        .read("tier2_b26/upload-target.txt")
        .await
        .unwrap()
        .to_vec();
    assert_eq!(content, b"presigned upload body");
    ctx.cleanup().await;
}
