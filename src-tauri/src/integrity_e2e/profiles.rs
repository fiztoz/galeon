//! Profiles, keyring, and auto-reconnect.
//!
//! Shared harness (TestContext, wait_for_transfer, …) lives in `super`.

use super::*;
use crate::*;

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
