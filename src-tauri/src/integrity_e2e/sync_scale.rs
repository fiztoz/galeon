//! Tier 4 scale and directory transfers.
//!
//! Shared harness (TestContext, wait_for_transfer, …) lives in `super`.

use super::*;
use crate::*;

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
