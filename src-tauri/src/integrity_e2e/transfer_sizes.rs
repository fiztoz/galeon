//! Transfer sizes (tier 1: 1B–15MB up/down).
//!
//! Shared harness (TestContext, wait_for_transfer, …) lives in `super`.

use super::*;
use crate::*;

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
