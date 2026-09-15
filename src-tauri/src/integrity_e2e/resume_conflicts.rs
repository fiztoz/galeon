//! Tier 3 resume, pause, cancel, and concurrency.
//!
//! Shared harness (TestContext, wait_for_transfer, …) lives in `super`.

use super::*;
use crate::*;

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
