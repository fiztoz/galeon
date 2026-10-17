//! Tier 4: the scheduled delete budget.
//!
//! `run_sync_profile_internal` is the full pipeline the scheduler drives, so
//! these tests drive it the same way: a profile with `delete_extraneous` and a
//! schedule allowance, against real MinIO objects. The cap is enforced on the
//! FINAL plan — all-or-nothing — and manual runs never consult it.

use super::*;
use crate::*;

/// Seed config.json + the credential cache + one sync profile for `ctx`, the
/// way the app persists them. Returns the sync profile.
///
/// The connection profile mirrors what `TestContext` connects with (MinIO
/// galeon/galeon-dev-secret on localhost:9000), so
/// `build_connection_for_sync` + `connect_storage` open a real session.
async fn seed_profile(
    ctx: &TestContext,
    bucket_prefix: &str,
    max_scheduled_deletes: u32,
) -> crate::SyncProfile {
    let state = ctx.app.state::<crate::GaleonEngine>();

    // config.json: a connection profile the sync profile references by id.
    let mut config = crate::read_config(&ctx.handle).unwrap();
    config.profiles.push(crate::ConnectionProfile {
        id: "c-minio".to_string(),
        name: "MinIO".to_string(),
        protocol: Some("s3".to_string()),
        endpoint: Some("http://localhost:9000".to_string()),
        region: Some("us-east-1".to_string()),
        access_key: None,
        secret_key: None,
        bucket: Some("galeon-test".to_string()),
        danger_disable_ssl_verification: Some(false),
        use_virtual_host_style: None,
        storage_class: None,
        max_bandwidth: None,
        host: None,
        port: None,
        username: None,
        key_path: None,
        credential_path: None,
        passive_mode: None,
        encrypt: None,
        bandwidth_rules: None,
        ssh_tunnel: None,
        ssh_tunnel_profile_id: None,
        has_saved_credentials: None,
    });
    crate::write_config(&ctx.handle, &config).unwrap();

    // Credentials: the sync code path loads through the session cache first,
    // so seed it instead of touching the OS keyring.
    state.credential_cache.insert(
        "c-minio",
        Some("galeon".to_string()),
        Some("galeon-dev-secret".to_string()),
        Some(String::new()),
        crate::now_ms(),
    );

    // The local source folder with one file that always survives.
    let src = ctx.temp_dir.join("src");
    std::fs::create_dir_all(&src).unwrap();
    std::fs::write(src.join("keep.txt"), b"keep me").unwrap();

    let profile = crate::SyncProfile {
        id: format!("sp-{}", bucket_prefix),
        name: bucket_prefix.to_string(),
        connection_profile_id: "c-minio".to_string(),
        local_path: src.to_string_lossy().to_string(),
        remote_prefix: format!("{}/", bucket_prefix),
        direction: crate::DIR_LOCAL_TO_REMOTE.to_string(),
        verify_checksum: false,
        delete_extraneous: true,
        max_scheduled_deletes,
        last_run_ms: None,
        schedule: Some(crate::SyncSchedule {
            enabled: true,
            frequency: "hourly".to_string(),
            at_hour: 3,
            at_minute: 30,
            day_of_week: None,
            next_run_ms: Some(1),
        }),
    };

    // Persist the way the UI does, so post-run bookkeeping
    // (`update_sync_profile`) has a store entry to mutate.
    crate::save_sync_profile(ctx.handle.clone(), profile.clone())
        .await
        .unwrap();
    profile
}

#[tokio::test]
async fn test_tier4_s06_scheduled_run_withholds_deletes_over_budget() {
    // A scheduled run whose plan needs more deletions than `maxScheduledDeletes`
    // allows performs NONE of them — uploads still happen — and the run record
    // carries planned/cap so history (and the toast) can say why.
    let _guard = TEST_SERIAL_MUTEX.lock().await;
    let ctx = TestContext::setup("tier4_s06").await;
    let op = ctx.operator();

    for key in ["gone-a.bin", "gone-b.bin"] {
        let k = format!("tier4_s06/{}", key);
        op.write(&k, "obsolete data").await.unwrap();
    }

    let profile = seed_profile(&ctx, "tier4_s06", 0).await;
    let record = run_sync_profile_internal(&ctx.handle, &profile, SyncTrigger::Schedule)
        .await
        .unwrap();

    assert_eq!(record.deletes, 0, "over budget: nothing may be deleted");
    assert_eq!(record.deleted_paths.len(), 0);
    assert_eq!(
        record.deletes_blocked,
        Some(BlockedDeletes { planned: 2, cap: 0 })
    );
    assert!(
        record.succeeded,
        "the copies completed; the cap is a flag, not a failure"
    );
    assert_eq!(
        record.uploads, 1,
        "keep.txt must still be uploaded by a capped run"
    );

    // The extraneous objects survived, untouched.
    assert!(
        op.stat("tier4_s06/gone-a.bin").await.is_ok(),
        "gone-a.bin must not be deleted by a capped run"
    );
    assert!(
        op.stat("tier4_s06/gone-b.bin").await.is_ok(),
        "gone-b.bin must not be deleted by a capped run"
    );
    assert!(op.stat("tier4_s06/keep.txt").await.is_ok());

    // And the log the UI reads carries the refusal, persisted.
    let log = sync_log::read_sync_runs(&ctx.handle);
    assert!(
        log.runs
            .iter()
            .any(|r| r.id == record.id && r.deletes_blocked.is_some()),
        "the run log must record the budget refusal"
    );

    ctx.cleanup().await;
}

#[tokio::test]
async fn test_tier4_s07_scheduled_run_deletes_within_budget() {
    // The budget must not neuter the feature: a run whose deletions fit the
    // allowance performs them exactly as an uncapped run does, and the
    // post-run bookkeeping the scheduler does on the profile still applies.
    let _guard = TEST_SERIAL_MUTEX.lock().await;
    let ctx = TestContext::setup("tier4_s07").await;
    let op = ctx.operator();

    op.write("tier4_s07/gone-a.bin", "a").await.unwrap();
    op.write("tier4_s07/gone-b.bin", "b").await.unwrap();

    let profile = seed_profile(&ctx, "tier4_s07", 2).await;
    let record = run_sync_profile_internal(&ctx.handle, &profile, SyncTrigger::Schedule)
        .await
        .unwrap();

    assert_eq!(record.deletes, 2, "two planned deletions, cap 2: they run");
    assert_eq!(record.deletes_blocked, None, "never blocked");
    assert_eq!(
        record.deleted_paths,
        vec!["gone-a.bin".to_string(), "gone-b.bin".to_string()]
    );
    assert!(record.succeeded);

    assert!(
        op.stat("tier4_s07/gone-a.bin").await.is_err(),
        "within budget, the extraneous object is deleted"
    );
    assert!(op.stat("tier4_s07/gone-b.bin").await.is_err());
    assert!(
        op.stat("tier4_s07/keep.txt").await.is_ok(),
        "the surviving source file is uploaded"
    );

    // Mirror the scheduler's post-run write so the profile state the UI reads
    // reflects a finished run.
    update_sync_profile(&ctx.handle, &profile.id, |p| {
        p.last_run_ms = Some(now_ms());
    })
    .await
    .unwrap();
    let store = read_sync_profiles(&ctx.handle).unwrap();
    let saved = store
        .profiles
        .iter()
        .find(|p| p.id == profile.id)
        .expect("the profile must still exist after bookkeeping");
    assert!(saved.last_run_ms.is_some());

    ctx.cleanup().await;
}

#[tokio::test]
async fn test_tier4_s08_manual_trigger_ignores_the_budget() {
    // The budget is a SCHEDULED-run policy. A manual run previews the diff and
    // asks for confirmation in the UI, so the identical profile executed
    // manually still deletes — with cap 0.
    let _guard = TEST_SERIAL_MUTEX.lock().await;
    let ctx = TestContext::setup("tier4_s08").await;
    let op = ctx.operator();

    op.write("tier4_s08/gone-a.bin", "a").await.unwrap();
    op.write("tier4_s08/gone-b.bin", "b").await.unwrap();

    let profile = seed_profile(&ctx, "tier4_s08", 0).await;
    let record = run_sync_profile_internal(&ctx.handle, &profile, SyncTrigger::Manual)
        .await
        .unwrap();

    assert_eq!(record.deletes, 2, "a manual run is not budgeted");
    assert_eq!(record.deletes_blocked, None);
    assert_eq!(record.trigger, "manual", "fixture sanity");
    assert!(
        op.stat("tier4_s08/gone-a.bin").await.is_err(),
        "manual run deletes regardless of the scheduled cap"
    );
    assert!(op.stat("tier4_s08/gone-b.bin").await.is_err());

    ctx.cleanup().await;
}
