//! Crate-root unit tests, split out of lib.rs.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use uuid::Uuid;

use super::*;

#[test]
fn test_chunk_range_math() {
    let total_bytes: u64 = 100 * 1024 * 1024; // 100 MB
    let chunks = compute_chunk_ranges(0, total_bytes, CHUNK_SIZE as u64);

    // Should have 13 chunks (12 full 8MB + 1 partial 4MB)
    assert_eq!(chunks.len(), 13);

    // First chunk: 0..8388608
    assert_eq!(chunks[0], 0..8388608);

    // Last chunk should end at total_bytes
    assert_eq!(chunks.last().unwrap().end, total_bytes);

    // Verify no gaps
    for i in 1..chunks.len() {
        assert_eq!(
            chunks[i].start,
            chunks[i - 1].end,
            "Gap detected at chunk {}",
            i
        );
    }
}

#[test]
fn test_chunk_range_small_file() {
    let total_bytes: u64 = 5 * 1024 * 1024; // 5 MB (below threshold)
    let chunks = compute_chunk_ranges(0, total_bytes, CHUNK_SIZE as u64);

    // Should have 1 chunk
    assert_eq!(chunks.len(), 1);
    assert_eq!(chunks[0], 0..total_bytes);
}

#[test]
fn test_sanitize_s3_strips_whitespace_and_quotes() {
    let (ep, region, ak, sk, bucket) = s3_connect::sanitize_s3_connection(
        Some("  \"https://s3.example.com/my-bucket\"  ".to_string()),
        Some(" us-east-1\n".to_string()),
        Some("  AKIAEXAMPLE  ".to_string()),
        Some("  secret  ".to_string()),
        Some("  my-bucket  ".to_string()),
    )
    .unwrap();
    assert_eq!(ep.as_deref(), Some("https://s3.example.com"));
    assert_eq!(region.as_deref(), Some("us-east-1"));
    assert_eq!(ak.as_deref(), Some("AKIAEXAMPLE"));
    assert_eq!(sk.as_deref(), Some("secret"));
    assert_eq!(bucket, "my-bucket");
}

#[test]
fn test_sanitize_s3_rejects_internal_endpoint_whitespace() {
    let err = s3_connect::sanitize_s3_connection(
        Some("https://s3.example.com /my-bucket".to_string()),
        None,
        Some("ak".to_string()),
        Some("sk".to_string()),
        Some("my-bucket".to_string()),
    )
    .unwrap_err();
    assert!(err.to_lowercase().contains("whitespace"), "err={err}");
}

#[test]
fn test_format_s3_connect_error_invalid_uri_hint() {
    let msg = s3_connect::format_s3_connect_error(
        "S3 connection check failed",
        "building http request, source: invalid uri character",
    );
    assert!(msg.contains("endpoint or bucket"), "msg={msg}");
}

#[test]
fn test_chunk_range_resume_offset() {
    let total_bytes: u64 = 20 * 1024 * 1024;
    let resume_from: u64 = 10 * 1024 * 1024;
    let chunks = compute_chunk_ranges(resume_from, total_bytes, CHUNK_SIZE as u64);

    // 10 MB remaining → one full 8 MiB chunk + one 2 MiB tail
    assert_eq!(chunks.len(), 2);
    assert_eq!(chunks[0].start, resume_from);
    assert_eq!(chunks.last().unwrap().end, total_bytes);

    // Already complete (or remote shrank) → nothing to fetch
    assert!(compute_chunk_ranges(total_bytes, total_bytes, CHUNK_SIZE as u64).is_empty());
}

#[test]
fn test_transfer_queue_serialization_round_trip() {
    let queue = TransferQueue {
        entries: vec![
            TransferQueueEntry {
                id: "test-id-1".to_string(),
                direction: "download".to_string(),
                remote_key: "folder/file.txt".to_string(),
                local_path: "/Users/test/Downloads/file.txt".to_string(),
                profile_id: "profile-1".to_string(),
                status: "active".to_string(),
                bytes_transferred: 1024,
                total_bytes: 4096,
                created_at: "2024-01-01T00:00:00Z".to_string(),
                updated_at: "2024-01-01T00:01:00Z".to_string(),
                error: None,
            },
            TransferQueueEntry {
                id: "test-id-2".to_string(),
                direction: "upload".to_string(),
                remote_key: "uploads/document.pdf".to_string(),
                local_path: "/Users/test/Documents/document.pdf".to_string(),
                profile_id: "profile-1".to_string(),
                status: "failed".to_string(),
                bytes_transferred: 0,
                total_bytes: 1048576,
                created_at: "2024-01-01T00:00:00Z".to_string(),
                updated_at: "2024-01-01T00:00:05Z".to_string(),
                error: Some("Connection timeout".to_string()),
            },
        ],
    };

    // Serialize
    let json = serde_json::to_string_pretty(&queue).unwrap();

    // Deserialize
    let deserialized: TransferQueue = serde_json::from_str(&json).unwrap();

    // Verify
    assert_eq!(deserialized.entries.len(), 2);
    assert_eq!(deserialized.entries[0].id, "test-id-1");
    assert_eq!(deserialized.entries[0].direction, "download");
    assert_eq!(deserialized.entries[0].bytes_transferred, 1024);
    assert_eq!(deserialized.entries[0].error, None);

    assert_eq!(deserialized.entries[1].id, "test-id-2");
    assert_eq!(deserialized.entries[1].status, "failed");
    assert_eq!(
        deserialized.entries[1].error,
        Some("Connection timeout".to_string())
    );
}

#[test]
fn test_transfer_queue_empty() {
    let queue = TransferQueue::default();
    assert!(queue.entries.is_empty());

    let json = serde_json::to_string_pretty(&queue).unwrap();
    let deserialized: TransferQueue = serde_json::from_str(&json).unwrap();
    assert!(deserialized.entries.is_empty());
}

#[test]
fn test_galeon_config_serialization_round_trip() {
    let config = GaleonConfig {
        profiles: vec![ConnectionProfile {
            id: "profile-1".to_string(),
            name: "My S3 Bucket".to_string(),
            endpoint: Some("https://s3.amazonaws.com".to_string()),
            region: Some("us-east-1".to_string()),
            access_key: Some("test-access-key".to_string()),
            secret_key: Some("test-secret-key".to_string()),
            bucket: Some("my-bucket".to_string()),
            danger_disable_ssl_verification: Some(false),
            use_virtual_host_style: Some(false),
            storage_class: None,
            max_bandwidth: None,
            protocol: None,
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
        }],
        presign_history: vec![],
    };

    let json = serde_json::to_string_pretty(&config).unwrap();

    // Debug: print the JSON to see what's happening
    // println!("JSON:\n{}", json);

    // Note: skip_serializing_if only works when the value is None
    // Since we're setting Some(...), the values will be serialized
    // The actual skipping happens in save_profile which uses a different struct
    // For this test, we verify the round-trip works correctly

    // Deserialize
    let deserialized: GaleonConfig = serde_json::from_str(&json).unwrap();
    assert_eq!(deserialized.profiles.len(), 1);
    assert_eq!(deserialized.profiles[0].name, "My S3 Bucket");
    assert_eq!(
        deserialized.profiles[0].access_key,
        Some("test-access-key".to_string())
    );
    assert_eq!(
        deserialized.profiles[0].secret_key,
        Some("test-secret-key".to_string())
    );
}

#[test]
fn test_speed_tracker() {
    let mut tracker = SpeedTracker::new(100);

    // No samples yet
    assert_eq!(tracker.speed(), 0);

    // Add a sample
    tracker.add_sample(1000);
    // Speed should be non-zero (depends on time elapsed)
    // We can't test exact speed without mocking time, but we can test it doesn't panic
    let _ = tracker.speed();
}

#[tokio::test]
async fn test_check_file_exists() {
    // Test with a file that should exist (this test file)
    let result = check_file_exists(file!().to_string()).await.unwrap();
    assert!(result, "This test file should exist");

    // Test with a file that shouldn't exist
    let result = check_file_exists("/nonexistent/path/file.txt".to_string())
        .await
        .unwrap();
    assert!(!result, "Nonexistent file should not exist");
}

#[test]
fn test_reconnect_result_serialization() {
    let result = ReconnectResult {
        session_id: "session-123".to_string(),
        bucket: "my-bucket".to_string(),
        profile_id: "profile-456".to_string(),
    };

    let json = serde_json::to_string(&result).unwrap();
    let deserialized: ReconnectResult = serde_json::from_str(&json).unwrap();

    assert_eq!(deserialized.session_id, "session-123");
    assert_eq!(deserialized.bucket, "my-bucket");
    assert_eq!(deserialized.profile_id, "profile-456");
}

#[tokio::test]
async fn test_calculate_file_md5_correctness() {
    use std::io::Write;

    let content = b"hello world";
    let temp_dir = std::path::Path::new("target").join("test_temp");
    std::fs::create_dir_all(&temp_dir).unwrap();
    let file_path = temp_dir.join("hello_world.txt");
    {
        let mut file = std::fs::File::create(&file_path).unwrap();
        file.write_all(content).unwrap();
    }

    let path_str = file_path.to_str().unwrap();
    let res = calculate_file_md5(path_str).await.unwrap();

    let _ = std::fs::remove_file(&file_path);

    assert_eq!(res, "5eb63bbbe01eeed093cb22bb8f5acdc3");
}

#[tokio::test]
async fn test_calculate_multipart_etag_small() {
    use std::io::Write;

    let content = b"hello world";
    let temp_dir = std::path::Path::new("target").join("test_temp");
    std::fs::create_dir_all(&temp_dir).unwrap();
    let file_path = temp_dir.join("hello_world_small.txt");
    {
        let mut file = std::fs::File::create(&file_path).unwrap();
        file.write_all(content).unwrap();
    }

    let path_str = file_path.to_str().unwrap();
    let res = calculate_multipart_etag(path_str, 8 * 1024 * 1024)
        .await
        .unwrap();

    let _ = std::fs::remove_file(&file_path);

    assert_eq!(res, "5eb63bbbe01eeed093cb22bb8f5acdc3");
}

#[tokio::test]
async fn test_calculate_multipart_etag_large() {
    use std::io::Write;

    let size = 17 * 1024 * 1024;
    let mut data = vec![0u8; size];
    for (i, byte) in data.iter_mut().enumerate() {
        *byte = (i % 251) as u8;
    }

    let temp_dir = std::path::Path::new("target").join("test_temp");
    std::fs::create_dir_all(&temp_dir).unwrap();
    let file_path = temp_dir.join("large_test_file.bin");
    {
        let mut file = std::fs::File::create(&file_path).unwrap();
        file.write_all(&data).unwrap();
    }

    let chunk_size = 8 * 1024 * 1024;
    let path_str = file_path.to_str().unwrap();
    let res = calculate_multipart_etag(path_str, chunk_size)
        .await
        .unwrap();

    let _ = std::fs::remove_file(&file_path);

    let part1 = &data[0..chunk_size];
    let part2 = &data[chunk_size..2 * chunk_size];
    let part3 = &data[2 * chunk_size..];

    let h1 = md5::compute(part1);
    let h2 = md5::compute(part2);
    let h3 = md5::compute(part3);

    let mut concat = Vec::new();
    concat.extend_from_slice(&h1.0);
    concat.extend_from_slice(&h2.0);
    concat.extend_from_slice(&h3.0);

    let expected_hash = md5::compute(&concat);
    let expected_etag = format!("{:x}-3", expected_hash);

    assert_eq!(res, expected_etag);
}

#[tokio::test]
async fn test_verify_integrity_success() {
    use std::io::Write;
    let content = b"hello world";
    let temp_dir = std::path::Path::new("target").join("test_temp");
    std::fs::create_dir_all(&temp_dir).unwrap();
    let file_path = temp_dir.join("verify_success.txt");
    {
        let mut file = std::fs::File::create(&file_path).unwrap();
        file.write_all(content).unwrap();
    }

    let path_str = file_path.to_str().unwrap();

    // Match size, no etag
    let res = verify_integrity(path_str, 11, None).await;
    assert!(res.is_ok());

    // Match size, match etag
    let res = verify_integrity(path_str, 11, Some("5eb63bbbe01eeed093cb22bb8f5acdc3")).await;
    assert!(res.is_ok());

    // Match size, match quoted etag
    let res = verify_integrity(path_str, 11, Some("\"5eb63bbbe01eeed093cb22bb8f5acdc3\"")).await;
    assert!(res.is_ok());

    let _ = std::fs::remove_file(&file_path);
}

#[tokio::test]
async fn test_verify_integrity_size_mismatch() {
    use std::io::Write;
    let content = b"hello world";
    let temp_dir = std::path::Path::new("target").join("test_temp");
    std::fs::create_dir_all(&temp_dir).unwrap();
    let file_path = temp_dir.join("verify_size_mismatch.txt");
    {
        let mut file = std::fs::File::create(&file_path).unwrap();
        file.write_all(content).unwrap();
    }

    let path_str = file_path.to_str().unwrap();

    let res = verify_integrity(path_str, 10, None).await;
    assert!(res.is_err());
    let err_msg = res.unwrap_err();
    assert!(
        err_msg.contains("Size mismatch: expected 10, got 11"),
        "Error was: {}",
        err_msg
    );

    let _ = std::fs::remove_file(&file_path);
}

#[tokio::test]
async fn test_verify_integrity_checksum_mismatch() {
    use std::io::Write;
    let content = b"hello world";
    let temp_dir = std::path::Path::new("target").join("test_temp");
    std::fs::create_dir_all(&temp_dir).unwrap();
    let file_path = temp_dir.join("verify_checksum_mismatch.txt");
    {
        let mut file = std::fs::File::create(&file_path).unwrap();
        file.write_all(content).unwrap();
    }

    let path_str = file_path.to_str().unwrap();

    let res = verify_integrity(path_str, 11, Some("wrong_hash")).await;
    assert!(res.is_err());
    let err_msg = res.unwrap_err();
    assert!(
        err_msg.contains(
            "Checksum mismatch: expected wrong_hash, got 5eb63bbbe01eeed093cb22bb8f5acdc3"
        ),
        "Error was: {}",
        err_msg
    );

    let _ = std::fs::remove_file(&file_path);
}

#[test]
fn test_edit_temp_dir_structure() {
    let uuid = "abc-123";
    let filename = "report.txt";
    let path = edit_temp_dir(uuid, filename);

    let expected = std::env::temp_dir()
        .join("galeon-edits")
        .join(uuid)
        .join(filename);
    assert_eq!(path, expected);

    // file lives under <temp>/galeon-edits/<uuid>/<filename>
    assert_eq!(path.file_name().unwrap().to_str().unwrap(), filename);
    let parent = path.parent().unwrap();
    assert_eq!(parent.file_name().unwrap().to_str().unwrap(), uuid);
    let grandparent = parent.parent().unwrap();
    assert_eq!(
        grandparent.file_name().unwrap().to_str().unwrap(),
        "galeon-edits"
    );
}

#[tokio::test]
async fn test_edit_session_register_and_stop_removes_entry() {
    let engine = GaleonEngine::default();

    // Build a real temp dir to mirror what edit_remote_file creates.
    let editor_id = Uuid::new_v4().to_string();
    let temp_path = edit_temp_dir(&editor_id, "file.txt");
    let temp_dir = temp_path.parent().unwrap().to_path_buf();
    std::fs::create_dir_all(&temp_dir).unwrap();
    std::fs::write(&temp_path, b"hello").unwrap();
    assert!(temp_dir.exists());

    let session = EditSession {
        stop: Arc::new(AtomicBool::new(false)),
        temp_dir: temp_dir.clone(),
        watcher_thread: None,
        session_id: "sess-1".to_string(),
        remote_key: "dir/file.txt".to_string(),
        filename: "file.txt".to_string(),
        started_at_ms: now_ms(),
        last_saved_ms: Arc::new(AtomicU64::new(0)),
        save_count: Arc::new(AtomicU64::new(0)),
    };
    engine
        .editors
        .write()
        .await
        .insert(editor_id.clone(), session);

    // Registered.
    assert!(engine.editors.read().await.contains_key(&editor_id));

    // Simulate stop_editing_file's core effect: remove entry + cleanup dir.
    let removed = engine.editors.write().await.remove(&editor_id).unwrap();
    removed.stop.store(true, Ordering::SeqCst);
    let _ = std::fs::remove_dir_all(&removed.temp_dir);

    assert!(!engine.editors.read().await.contains_key(&editor_id));
    assert!(!temp_dir.exists());
}

#[test]
fn test_edit_session_idle_detection() {
    let timeout = 2 * 60 * 60 * 1000; // 2h in ms
    let now = 10_000_000_000u64;

    // Never saved (last_saved = 0): idle is measured from start time.
    assert!(edit_session_is_idle(now, now - timeout, 0, timeout));
    assert!(!edit_session_is_idle(now, now - 1000, 0, timeout));

    // A recent save keeps it alive even if it started long ago.
    assert!(!edit_session_is_idle(
        now,
        now - timeout * 2,
        now - 1000,
        timeout
    ));

    // An old save past the timeout makes it idle.
    assert!(edit_session_is_idle(
        now,
        now - timeout * 2,
        now - timeout,
        timeout
    ));

    // Clock skew (activity "in the future") must never report idle.
    assert!(!edit_session_is_idle(now, now + 5000, 0, timeout));
}

#[tokio::test]
async fn test_list_edit_sessions_filters_by_session() {
    let engine = GaleonEngine::default();

    let mk = |session_id: &str, filename: &str, saved_ms: u64, saves: u64| EditSession {
        stop: Arc::new(AtomicBool::new(false)),
        temp_dir: std::env::temp_dir()
            .join("galeon-edits")
            .join(Uuid::new_v4().to_string()),
        watcher_thread: None,
        session_id: session_id.to_string(),
        remote_key: format!("dir/{}", filename),
        filename: filename.to_string(),
        started_at_ms: now_ms(),
        last_saved_ms: Arc::new(AtomicU64::new(saved_ms)),
        save_count: Arc::new(AtomicU64::new(saves)),
    };

    {
        let mut w = engine.editors.write().await;
        w.insert("a".into(), mk("sess-1", "one.txt", 0, 0));
        w.insert("b".into(), mk("sess-1", "two.txt", now_ms(), 3));
        w.insert("c".into(), mk("sess-2", "other.txt", 0, 0));
    }

    let editors = engine.editors.read().await;

    // Scoped to sess-1 → two entries, never-saved one has no last_saved_at.
    let scoped = collect_edit_sessions(&editors, Some("sess-1"));
    assert_eq!(scoped.len(), 2);
    assert!(scoped.iter().all(|s| s.session_id == "sess-1"));
    let saved = scoped.iter().find(|s| s.filename == "two.txt").unwrap();
    assert_eq!(saved.save_count, 3);
    assert!(saved.last_saved_at.is_some());
    let unsaved = scoped.iter().find(|s| s.filename == "one.txt").unwrap();
    assert!(unsaved.last_saved_at.is_none());

    // Unscoped → all three.
    let all = collect_edit_sessions(&editors, None);
    assert_eq!(all.len(), 3);
}

// ── Phase 11: sync planner (pure) ──────────────────────────────────────

fn entry(path: &str, size: u64, mtime_ms: u64) -> SyncFileEntry {
    (path.to_string(), size, Some(mtime_ms))
}

/// Find a plan entry by relative path and assert its action + reason.
fn assert_plan(plan: &[SyncPlanEntry], rel: &str, action: &str, reason: &str) {
    let e = plan
        .iter()
        .find(|e| e.relative_path == rel)
        .unwrap_or_else(|| panic!("no plan entry for {}", rel));
    assert_eq!(e.action, action, "action for {}", rel);
    assert_eq!(e.reason, reason, "reason for {}", rel);
}

#[test]
fn test_sync_plan_upload_new_and_changed() {
    let local = vec![
        entry("new.txt", 100, 1000),
        entry("changed.txt", 200, 3000),
        entry("newer.txt", 50, 9000),
        entry("same.txt", 10, 1000),
    ];
    let remote = vec![
        entry("changed.txt", 150, 3000), // same mtime, different size
        entry("newer.txt", 50, 1000),    // same size, local mtime newer
        entry("same.txt", 10, 1000),     // identical
    ];
    let opts = SyncOptions {
        verify_checksum: false,
        delete_extraneous: false,
    };
    let plan = compute_sync_plan(&local, &remote, DIR_LOCAL_TO_REMOTE, &opts);

    assert_plan(&plan, "new.txt", "upload", "new");
    assert_plan(&plan, "changed.txt", "upload", "size differs");
    assert_plan(&plan, "newer.txt", "upload", "newer");
    assert_plan(&plan, "same.txt", "skip", "identical");
    assert_eq!(plan.iter().filter(|e| e.action == "upload").count(), 3);
    // Sizes/mtimes are populated from both sides for the UI.
    let changed = plan
        .iter()
        .find(|e| e.relative_path == "changed.txt")
        .unwrap();
    assert_eq!(changed.local_size, Some(200));
    assert_eq!(changed.remote_size, Some(150));
}

#[test]
fn test_sync_plan_download_newer_remote() {
    // remoteToLocal: remote is the source.
    let remote = vec![entry("r.txt", 100, 5000), entry("n.txt", 10, 1)];
    let local = vec![entry("r.txt", 100, 1000)]; // older local copy
    let opts = SyncOptions {
        verify_checksum: false,
        delete_extraneous: false,
    };
    let plan = compute_sync_plan(&local, &remote, DIR_REMOTE_TO_LOCAL, &opts);

    assert_plan(&plan, "r.txt", "download", "newer");
    assert_plan(&plan, "n.txt", "download", "new");
    assert!(plan.iter().all(|e| e.action == "download"));
}

#[test]
fn test_sync_plan_skip_identical() {
    let local = vec![entry("a.bin", 42, 1234)];
    let remote = vec![entry("a.bin", 42, 1234)];
    let opts = SyncOptions {
        verify_checksum: false,
        delete_extraneous: false,
    };
    let plan = compute_sync_plan(&local, &remote, DIR_LOCAL_TO_REMOTE, &opts);
    assert_eq!(plan.len(), 1);
    assert_plan(&plan, "a.bin", "skip", "identical");
    // mtime slack: remote 1s behind should still be "identical", not "newer".
    let remote2 = vec![entry("a.bin", 42, 1000)];
    let local2 = vec![entry("a.bin", 42, 1500)]; // 500ms newer < 2s slack
    let plan2 = compute_sync_plan(&local2, &remote2, DIR_LOCAL_TO_REMOTE, &opts);
    assert_plan(&plan2, "a.bin", "skip", "identical");
}

#[test]
fn test_sync_plan_delete_extraneous_off_by_default() {
    let local = vec![entry("keep.txt", 1, 1)];
    let remote = vec![entry("keep.txt", 1, 1), entry("extra.txt", 5, 5)];
    let opts = SyncOptions {
        verify_checksum: false,
        delete_extraneous: false,
    };
    let plan = compute_sync_plan(&local, &remote, DIR_LOCAL_TO_REMOTE, &opts);

    assert_plan(&plan, "extra.txt", "skip", "extraneous");
    assert!(
        !plan.iter().any(|e| e.action.starts_with("delete")),
        "no deletes when delete_extraneous is off"
    );
}

#[test]
fn test_sync_plan_delete_extraneous_on() {
    let opts = SyncOptions {
        verify_checksum: false,
        delete_extraneous: true,
    };

    // localToRemote: a remote-only file is extraneous on the remote.
    let local = vec![entry("keep.txt", 1, 1)];
    let remote = vec![entry("keep.txt", 1, 1), entry("gone.txt", 5, 5)];
    let plan = compute_sync_plan(&local, &remote, DIR_LOCAL_TO_REMOTE, &opts);
    assert_plan(&plan, "gone.txt", "deleteRemote", "extraneous");

    // remoteToLocal: a local-only file is extraneous on local.
    let local2 = vec![entry("keep.txt", 1, 1), entry("stale.txt", 9, 9)];
    let remote2 = vec![entry("keep.txt", 1, 1)];
    let plan2 = compute_sync_plan(&local2, &remote2, DIR_REMOTE_TO_LOCAL, &opts);
    assert_plan(&plan2, "stale.txt", "deleteLocal", "extraneous");
}

fn plan_entry(reason: &str, local_size: Option<u64>, remote_size: Option<u64>) -> SyncPlanEntry {
    SyncPlanEntry {
        relative_path: "x".into(),
        action: "skip".into(),
        reason: reason.into(),
        local_size,
        remote_size,
        local_modified: None,
        remote_modified: None,
        direction: DIR_LOCAL_TO_REMOTE.into(),
    }
}

#[test]
fn test_checksum_refine_targeting() {
    // Same-size + heuristic outcome → eligible.
    assert!(entry_needs_checksum_refine(&plan_entry(
        "identical",
        Some(10),
        Some(10)
    )));
    assert!(entry_needs_checksum_refine(&plan_entry(
        "newer",
        Some(10),
        Some(10)
    )));
    // Decisive or one-sided cases → not eligible.
    assert!(!entry_needs_checksum_refine(&plan_entry(
        "size differs",
        Some(10),
        Some(20)
    )));
    assert!(!entry_needs_checksum_refine(&plan_entry(
        "new",
        Some(10),
        None
    )));
    assert!(!entry_needs_checksum_refine(&plan_entry(
        "extraneous",
        None,
        Some(10)
    )));
    // Defensive: mismatched sizes never eligible even with a soft reason.
    assert!(!entry_needs_checksum_refine(&plan_entry(
        "identical",
        Some(10),
        Some(20)
    )));
}

#[test]
fn test_checksum_refine_apply() {
    // Identical content collapses to skip regardless of prior reason.
    let mut e = plan_entry("newer", Some(10), Some(10));
    apply_checksum_result(&mut e, true, DIR_LOCAL_TO_REMOTE);
    assert_eq!(e.action, "skip");
    assert_eq!(e.reason, "identical (checksum)");

    // Differing content becomes a copy in the right direction.
    let mut up = plan_entry("identical", Some(10), Some(10));
    apply_checksum_result(&mut up, false, DIR_LOCAL_TO_REMOTE);
    assert_eq!(up.action, "upload");
    assert_eq!(up.reason, "content differs");

    let mut down = plan_entry("identical", Some(10), Some(10));
    apply_checksum_result(&mut down, false, DIR_REMOTE_TO_LOCAL);
    assert_eq!(down.action, "download");
    assert_eq!(down.reason, "content differs");
}

#[test]
fn test_is_unsafe_relative_path() {
    assert!(is_unsafe_relative_path("/etc/passwd"));
    assert!(is_unsafe_relative_path("C:\\windows\\file.txt"));
    assert!(is_unsafe_relative_path("foo/..\\bar"));
    assert!(is_unsafe_relative_path("../foo"));
    assert!(!is_unsafe_relative_path("foo/bar.txt"));
    assert!(!is_unsafe_relative_path("foo\\bar.txt"));
}

#[test]
fn test_is_unsafe_root_path_allows_absolute_roots() {
    // Sync roots are chosen folder paths / remote prefixes and may be absolute.
    assert!(!is_unsafe_root_path("/Users/alice/sync"));
    assert!(!is_unsafe_root_path("C:\\Users\\alice\\sync"));
    assert!(!is_unsafe_root_path("s3://bucket/prefix"));
    assert!(is_unsafe_root_path("/Users/alice/../bob"));
    assert!(is_unsafe_root_path("C:\\Users\\alice\\..\\bob"));
}

// ── Phase 12: scheduler + bandwidth rules (pure) ─────────────────────────

fn local_ms(year: i32, month: u32, day: u32, hour: u32, minute: u32) -> u64 {
    use chrono::{Local, TimeZone};
    Local
        .with_ymd_and_hms(year, month, day, hour, minute, 0)
        .single()
        .expect("valid local datetime")
        .timestamp_millis() as u64
}

#[test]
fn test_compute_next_run_ms_hourly() {
    let now = local_ms(2026, 6, 16, 10, 15);
    let schedule = SyncSchedule {
        enabled: true,
        frequency: "hourly".into(),
        at_hour: 0,
        at_minute: 30,
        day_of_week: None,
        next_run_ms: None,
    };
    let next = compute_next_run_ms(now, &schedule);
    assert_eq!(next, local_ms(2026, 6, 16, 10, 30));

    let past_target = local_ms(2026, 6, 16, 10, 45);
    let next = compute_next_run_ms(past_target, &schedule);
    assert_eq!(next, local_ms(2026, 6, 16, 11, 30));
}

#[test]
fn test_compute_next_run_ms_daily() {
    let schedule = SyncSchedule {
        enabled: true,
        frequency: "daily".into(),
        at_hour: 14,
        at_minute: 0,
        day_of_week: None,
        next_run_ms: None,
    };
    let before = local_ms(2026, 6, 16, 10, 0);
    assert_eq!(
        compute_next_run_ms(before, &schedule),
        local_ms(2026, 6, 16, 14, 0)
    );

    let after = local_ms(2026, 6, 16, 15, 0);
    assert_eq!(
        compute_next_run_ms(after, &schedule),
        local_ms(2026, 6, 17, 14, 0)
    );
}

#[test]
fn test_compute_next_run_ms_weekly() {
    // 2026-06-16 is a Tuesday (dow 1); target Monday (dow 0) at 09:00.
    let schedule = SyncSchedule {
        enabled: true,
        frequency: "weekly".into(),
        at_hour: 9,
        at_minute: 0,
        day_of_week: Some(0),
        next_run_ms: None,
    };
    let now = local_ms(2026, 6, 16, 8, 0);
    assert_eq!(
        compute_next_run_ms(now, &schedule),
        local_ms(2026, 6, 22, 9, 0)
    );
}

#[test]
fn test_compute_next_run_ms_once() {
    let schedule = SyncSchedule {
        enabled: true,
        frequency: "once".into(),
        at_hour: 18,
        at_minute: 30,
        day_of_week: None,
        next_run_ms: None,
    };
    let before = local_ms(2026, 6, 16, 12, 0);
    assert_eq!(
        compute_next_run_ms(before, &schedule),
        local_ms(2026, 6, 16, 18, 30)
    );

    let after = local_ms(2026, 6, 16, 19, 0);
    // "once" means today only: if time already passed, return now_ms
    assert_eq!(compute_next_run_ms(after, &schedule), after);
}

#[test]
fn test_bandwidth_rule_match_simple() {
    // 2026-06-16 is Tuesday (dow 1).
    let rules = vec![BandwidthRule {
        enabled: true,
        start_time: "09:00".into(),
        end_time: "17:00".into(),
        days: vec![1],
        limit_kbps: 500,
    }];
    let now = local_ms(2026, 6, 16, 12, 0);
    assert_eq!(current_bandwidth_limit_kbps(&rules, now), Some(500));
}

#[test]
fn test_bandwidth_rule_wrap_around() {
    let rules = vec![BandwidthRule {
        enabled: true,
        start_time: "22:00".into(),
        end_time: "06:00".into(),
        days: vec![0, 1, 2, 3, 4, 5, 6],
        limit_kbps: 256,
    }];
    let late = local_ms(2026, 6, 16, 23, 30);
    assert_eq!(current_bandwidth_limit_kbps(&rules, late), Some(256));

    let early = local_ms(2026, 6, 16, 3, 0);
    assert_eq!(current_bandwidth_limit_kbps(&rules, early), Some(256));

    let midday = local_ms(2026, 6, 16, 12, 0);
    assert_eq!(current_bandwidth_limit_kbps(&rules, midday), None);
}

#[test]
fn test_bandwidth_rule_no_match_falls_back() {
    let rules = vec![BandwidthRule {
        enabled: true,
        start_time: "09:00".into(),
        end_time: "17:00".into(),
        days: vec![1],
        limit_kbps: 500,
    }];
    let now = local_ms(2026, 6, 16, 20, 0);
    assert_eq!(current_bandwidth_limit_kbps(&rules, now), None);

    let profile = ConnectionProfile {
        id: "p1".into(),
        name: "test".into(),
        protocol: Some("s3".into()),
        endpoint: None,
        region: None,
        access_key: None,
        secret_key: None,
        bucket: None,
        danger_disable_ssl_verification: None,
        use_virtual_host_style: None,
        storage_class: None,
        max_bandwidth: Some(2048),
        host: None,
        port: None,
        username: None,
        key_path: None,
        passive_mode: None,
        encrypt: None,
        bandwidth_rules: Some(rules),
        ssh_tunnel: None,
        ssh_tunnel_profile_id: None,
        has_saved_credentials: None,
    };
    assert_eq!(
        resolve_bandwidth_limit_bytes_per_sec(&profile, now),
        Some(2048)
    );
}

#[test]
fn test_default_app_settings_shape() {
    let now = now_ms();
    let settings = AppSettings {
        onboarding_complete: false,
        dual_pane_enabled: false,
        local_pane_path: None,
        theme: None,
        split_ratio: None,
        created_at_ms: now,
        updated_at_ms: now,
    };
    assert!(!settings.onboarding_complete);
    assert!(settings.created_at_ms > 0);
    assert_eq!(settings.created_at_ms, settings.updated_at_ms);
}

#[test]
fn test_app_settings_serialization_round_trip() {
    let settings = AppSettings {
        onboarding_complete: true,
        dual_pane_enabled: true,
        local_pane_path: Some("/Users/example/Downloads".to_string()),
        theme: Some("light".to_string()),
        split_ratio: Some(0.38),
        created_at_ms: 1000,
        updated_at_ms: 2000,
    };
    let json = serde_json::to_string(&settings).unwrap();
    let parsed: AppSettings = serde_json::from_str(&json).unwrap();
    assert!(parsed.onboarding_complete);
    assert!(parsed.dual_pane_enabled);
    assert_eq!(
        parsed.local_pane_path.as_deref(),
        Some("/Users/example/Downloads")
    );
    assert_eq!(parsed.created_at_ms, 1000);
    assert_eq!(parsed.updated_at_ms, 2000);
}

/// An `app_settings.json` written before the dual-pane fields existed must still
/// load. Without `#[serde(default)]` on the struct this parse fails outright and
/// every existing install would break on upgrade with "Failed to parse app
/// settings".
#[test]
fn test_app_settings_parses_legacy_file_without_dual_pane_fields() {
    let legacy = r#"{"onboardingComplete":true,"createdAtMs":1000,"updatedAtMs":2000}"#;
    let parsed: AppSettings =
        serde_json::from_str(legacy).expect("legacy app_settings.json must still deserialize");
    assert!(parsed.onboarding_complete);
    assert!(!parsed.dual_pane_enabled, "dual pane defaults to off");
    assert_eq!(parsed.local_pane_path, None);
    assert_eq!(parsed.theme, None, "theme falls back to system");
    assert_eq!(parsed.split_ratio, None, "unset split means 50/50");
    assert_eq!(parsed.updated_at_ms, 2000, "existing fields survive");
}

#[test]
fn test_app_metadata() {
    let meta = get_app_metadata();
    assert_eq!(meta.product_name, "Galeon");
    assert_eq!(meta.identifier, "com.fizto.galeon");
    assert!(!meta.version.is_empty());
}
