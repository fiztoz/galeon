// profile_io unit tests.

use super::*;

fn sample_s3(id: &str, name: &str) -> ConnectionProfile {
    ConnectionProfile {
        id: id.to_string(),
        name: name.to_string(),
        protocol: Some("s3".to_string()),
        endpoint: Some("https://s3.example.com".to_string()),
        region: Some("us-east-1".to_string()),
        access_key: Some("AKIA".to_string()),
        secret_key: Some("secret".to_string()),
        bucket: Some("my-bucket".to_string()),
        danger_disable_ssl_verification: Some(false),
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
        has_saved_credentials: Some(true),
    }
}

fn sample_sftp(id: &str, name: &str) -> ConnectionProfile {
    ConnectionProfile {
        id: id.to_string(),
        name: name.to_string(),
        protocol: Some("sftp".to_string()),
        endpoint: None,
        region: None,
        access_key: None,
        secret_key: Some("sftp-password".to_string()),
        bucket: None,
        danger_disable_ssl_verification: None,
        use_virtual_host_style: None,
        storage_class: None,
        max_bandwidth: None,
        host: Some("ssh.example.com".to_string()),
        port: Some(22),
        username: Some("deploy".to_string()),
        key_path: None,
        passive_mode: None,
        encrypt: None,
        bandwidth_rules: None,
        ssh_tunnel: None,
        ssh_tunnel_profile_id: None,
        has_saved_credentials: Some(true),
    }
}

#[test]
fn import_drops_machine_local_tunnel_profile_reference() {
    let mut profile = sample_s3("p1", "Prod");
    profile.ssh_tunnel_profile_id = Some("local-tunnel".to_string());

    let sanitized = sanitize_imported_profile(profile).unwrap();

    assert!(sanitized.ssh_tunnel_profile_id.is_none());
}

#[test]
fn export_strips_secrets_by_default() {
    let profiles = vec![sample_s3("p1", "Prod")];
    let mut secrets = HashMap::new();
    secrets.insert(
        "p1".to_string(),
        credentials::StoredCredentials {
            access_key: Some("AKIA".to_string()),
            secret_key: Some("secret".to_string()),
            ssh_tunnel_password: None,
        },
    );
    let exported = build_export_profiles(&profiles, &secrets, false);
    assert!(exported[0].access_key.is_none());
    assert!(exported[0].secret_key.is_none());
    assert!(exported[0].has_saved_credentials.is_none());
    assert_eq!(exported[0].bucket.as_deref(), Some("my-bucket"));
}

#[test]
fn export_includes_secrets_when_requested() {
    let profiles = vec![sample_s3("p1", "Prod")];
    let mut secrets = HashMap::new();
    secrets.insert(
        "p1".to_string(),
        credentials::StoredCredentials {
            access_key: Some("AKIA".to_string()),
            secret_key: Some("secret".to_string()),
            ssh_tunnel_password: None,
        },
    );
    let exported = build_export_profiles(&profiles, &secrets, true);
    assert_eq!(exported[0].access_key.as_deref(), Some("AKIA"));
    assert_eq!(exported[0].secret_key.as_deref(), Some("secret"));
}

#[test]
fn tunnel_password_is_exported_only_when_secrets_are_requested() {
    let mut profile = sample_sftp("p1", "Tunneled");
    profile.ssh_tunnel = Some(crate::ssh_tunnel::SshTunnelConfig {
        host: "bastion.example.com".to_string(),
        port: 22,
        username: "deploy".to_string(),
        key_path: None,
        password: None,
    });
    let mut secrets = HashMap::new();
    secrets.insert(
        "p1".to_string(),
        credentials::StoredCredentials {
            access_key: None,
            secret_key: Some("storage-password".to_string()),
            ssh_tunnel_password: Some("tunnel-password".to_string()),
        },
    );

    let without = build_export_profiles(&[profile.clone()], &secrets, false);
    assert!(without[0]
        .ssh_tunnel
        .as_ref()
        .and_then(|tunnel| tunnel.password.as_ref())
        .is_none());

    let with = build_export_profiles(&[profile], &secrets, true);
    assert_eq!(
        with[0]
            .ssh_tunnel
            .as_ref()
            .and_then(|tunnel| tunnel.password.as_deref()),
        Some("tunnel-password")
    );
}

#[test]
fn serialize_deserialize_round_trip() {
    let profiles = build_export_profiles(&[sample_s3("p1", "Prod")], &HashMap::new(), false);
    let file = build_export_file(profiles, false, "2026-01-01T00:00:00Z".to_string());
    let json = serialize_export(&file).unwrap();
    assert!(json.contains("galeon.profiles"));
    // Secrets must not appear as values (field names may still be omitted via skip_serializing_if).
    assert!(!json.contains("AKIA"));
    assert!(!json.contains("\"secret\""));
    let parsed = parse_export_json(&json).unwrap();
    assert_eq!(parsed.format, EXPORT_FORMAT);
    assert_eq!(parsed.profiles.len(), 1);
    assert_eq!(parsed.profiles[0].name, "Prod");
    assert!(parsed.profiles[0].access_key.is_none());
    assert!(parsed.profiles[0].secret_key.is_none());
}

#[test]
fn parse_bare_profiles_array() {
    let json = r#"[{"id":"x","name":"From Array","protocol":"s3","bucket":"b"}]"#;
    let parsed = parse_export_json(json).unwrap();
    assert_eq!(parsed.profiles.len(), 1);
    assert_eq!(parsed.profiles[0].name, "From Array");
}

#[test]
fn parse_config_like_object() {
    let json = r#"{"profiles":[{"id":"x","name":"Cfg","protocol":"s3","bucket":"b"}],"presignHistory":[]}"#;
    let parsed = parse_export_json(json).unwrap();
    assert_eq!(parsed.profiles[0].name, "Cfg");
}

#[test]
fn parse_rejects_empty_and_garbage() {
    assert!(parse_export_json("").is_err());
    assert!(parse_export_json("   ").is_err());
    assert!(parse_export_json("not-json").is_err());
    assert!(parse_export_json(r#"{"foo":1}"#).is_err());
}

#[test]
fn parse_rejects_unknown_format() {
    let json = r#"{"format":"other","version":1,"profiles":[]}"#;
    assert!(parse_export_json(json).is_err());
}

#[test]
fn parse_rejects_unknown_format_on_fallback_path() {
    // Missing version so ProfileExportFile deserialize may fail; format must still be enforced.
    let json =
        r#"{"format":"evil.app","profiles":[{"id":"x","name":"X","protocol":"s3","bucket":"b"}]}"#;
    let err = parse_export_json(json).unwrap_err();
    assert!(err.to_lowercase().contains("format"), "err={err}");
}

#[test]
fn merge_skip_on_name_collision() {
    let existing = vec![sample_s3("e1", "Prod")];
    let imported = vec![sample_s3("i1", "Prod"), sample_s3("i2", "Staging")];
    let (merged, result, pending, delete_ids) =
        merge_imported_profiles(existing, imported, CollisionStrategy::Skip);
    assert_eq!(merged.len(), 2);
    assert_eq!(result.skipped, 1);
    assert_eq!(result.imported, 1);
    assert_eq!(pending.len(), 1); // only Staging
    assert!(delete_ids.is_empty());
    assert_eq!(merged[1].name, "Staging");
    assert_ne!(merged[1].id, "i2"); // fresh id
}

#[test]
fn merge_overwrite_keeps_existing_id() {
    let existing = vec![sample_s3("e1", "Prod")];
    let mut imported = sample_s3("i1", "Prod");
    imported.bucket = Some("new-bucket".to_string());
    imported.access_key = Some("NEWAK".to_string());
    imported.secret_key = Some("newsecret".to_string());
    let (merged, result, pending, delete_ids) =
        merge_imported_profiles(existing, vec![imported], CollisionStrategy::Overwrite);
    assert_eq!(merged.len(), 1);
    assert_eq!(result.overwritten, 1);
    assert_eq!(result.imported, 0); // overwrite is not counted as imported
    assert_eq!(merged[0].id, "e1");
    assert_eq!(merged[0].bucket.as_deref(), Some("new-bucket"));
    assert!(merged[0].access_key.is_none()); // stripped for config
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].profile_id, "e1");
    assert_eq!(pending[0].access_key.as_deref(), Some("NEWAK"));
    // Replace = delete-then-insert so a failed persist cannot rebind old secrets.
    assert_eq!(delete_ids, vec!["e1".to_string()]);
}

#[test]
fn merge_overwrite_with_secrets_queues_delete_even_when_identity_same() {
    // Same host/bucket; secrets present → still queue delete so replace is atomic.
    let existing = sample_s3("e1", "Prod");
    let imported = sample_s3("i1", "Prod");
    let (merged, result, pending, delete_ids) =
        merge_imported_profiles(vec![existing], vec![imported], CollisionStrategy::Overwrite);
    assert_eq!(result.overwritten, 1);
    assert_eq!(merged[0].id, "e1");
    assert_eq!(pending.len(), 1);
    assert_eq!(delete_ids, vec!["e1".to_string()]);
    assert_eq!(merged[0].has_saved_credentials, Some(true));
}

#[test]
fn merge_overwrite_without_secrets_preserves_flag_when_identity_same() {
    let mut existing = sample_s3("e1", "Prod");
    existing.access_key = None;
    existing.secret_key = None;
    existing.has_saved_credentials = Some(true);

    let mut imported = sample_s3("i1", "Prod");
    imported.access_key = None;
    imported.secret_key = None;
    // same identity fields; only region metadata changes
    imported.region = Some("eu-west-1".to_string());

    let (merged, result, pending, delete_ids) =
        merge_imported_profiles(vec![existing], vec![imported], CollisionStrategy::Overwrite);
    assert_eq!(result.overwritten, 1);
    assert!(pending.is_empty());
    assert!(delete_ids.is_empty());
    assert_eq!(merged[0].has_saved_credentials, Some(true));
    assert_eq!(merged[0].region.as_deref(), Some("eu-west-1"));
    assert_eq!(merged[0].id, "e1");
}

#[test]
fn merge_overwrite_without_secrets_deletes_vault_when_identity_changes() {
    let mut existing = sample_s3("e1", "Prod");
    existing.access_key = None;
    existing.secret_key = None;
    existing.has_saved_credentials = Some(true);

    let mut imported = sample_s3("i1", "Prod");
    imported.access_key = None;
    imported.secret_key = None;
    imported.endpoint = Some("https://evil.example.com".to_string());
    imported.bucket = Some("other-bucket".to_string());

    let (merged, result, pending, delete_ids) =
        merge_imported_profiles(vec![existing], vec![imported], CollisionStrategy::Overwrite);
    assert_eq!(result.overwritten, 1);
    assert!(pending.is_empty());
    assert_eq!(delete_ids, vec!["e1".to_string()]);
    assert_eq!(merged[0].has_saved_credentials, Some(false));
    assert_eq!(
        merged[0].endpoint.as_deref(),
        Some("https://evil.example.com")
    );
}

#[test]
fn merge_overwrite_protocol_change_without_secrets_clears_vault() {
    let mut existing = sample_s3("e1", "Prod");
    existing.access_key = None;
    existing.secret_key = None;
    existing.has_saved_credentials = Some(true);

    let mut imported = sample_sftp("i1", "Prod");
    imported.secret_key = None; // no password in file

    let (merged, _result, pending, delete_ids) =
        merge_imported_profiles(vec![existing], vec![imported], CollisionStrategy::Overwrite);
    assert!(pending.is_empty());
    assert_eq!(delete_ids, vec!["e1".to_string()]);
    assert_eq!(merged[0].has_saved_credentials, Some(false));
    assert_eq!(merged[0].protocol.as_deref(), Some("sftp"));
}

#[test]
fn partial_s3_secrets_are_not_pending() {
    let mut p = sample_s3("x", "Partial");
    p.secret_key = None;
    assert!(extract_pending_credentials(&p).is_none());
    p.secret_key = Some("sk".to_string());
    p.access_key = None;
    assert!(extract_pending_credentials(&p).is_none());
    p.access_key = Some("ak".to_string());
    assert!(extract_pending_credentials(&p).is_some());
}

#[test]
fn merge_rename_on_collision() {
    let existing = vec![sample_s3("e1", "Prod")];
    let imported = vec![sample_s3("i1", "Prod")];
    let (merged, result, _pending, _delete_ids) =
        merge_imported_profiles(existing, imported, CollisionStrategy::Rename);
    assert_eq!(merged.len(), 2);
    assert_eq!(result.renamed, 1);
    assert_eq!(result.imported, 1);
    assert_eq!(merged[1].name, "Prod (imported)");
    assert_ne!(merged[1].id, "i1");
    assert_ne!(merged[1].id, "e1");
}

#[test]
fn sanitize_rejects_empty_name_and_bad_bucket() {
    let mut p = sample_s3("x", "  ");
    assert!(sanitize_imported_profile(p.clone()).is_err());
    p.name = "Ok".to_string();
    p.bucket = Some("bad bucket".to_string());
    assert!(sanitize_imported_profile(p.clone()).is_err());
    p.bucket = None;
    assert!(sanitize_imported_profile(p).is_err());
}

#[test]
fn sanitize_sftp_requires_host() {
    let mut p = sample_sftp("x", "Box");
    p.host = None;
    assert!(sanitize_imported_profile(p).is_err());
}

#[test]
fn sanitize_cleans_s3_paste_junk() {
    let mut p = sample_s3("x", "  Prod  ");
    p.endpoint = Some("  \"https://s3.example.com\"  ".to_string());
    p.bucket = Some("  my-bucket  ".to_string());
    p.access_key = Some("  AKIA  ".to_string());
    let clean = sanitize_imported_profile(p).unwrap();
    assert_eq!(clean.name, "Prod");
    assert_eq!(clean.endpoint.as_deref(), Some("https://s3.example.com"));
    assert_eq!(clean.bucket.as_deref(), Some("my-bucket"));
    assert_eq!(clean.access_key.as_deref(), Some("AKIA"));
}

#[test]
fn sanitize_clears_ssl_bypass_on_import() {
    let mut p = sample_s3("x", "Insecure");
    p.danger_disable_ssl_verification = Some(true);
    let clean = sanitize_imported_profile(p).unwrap();
    assert_eq!(clean.danger_disable_ssl_verification, Some(false));
}

#[test]
fn collision_strategy_parse() {
    assert_eq!(
        CollisionStrategy::parse("rename").unwrap(),
        CollisionStrategy::Rename
    );
    assert!(CollisionStrategy::parse("explode").is_err());
}

#[test]
fn connection_identity_detects_endpoint_change() {
    let a = sample_s3("a", "P");
    let mut b = sample_s3("b", "P");
    b.endpoint = Some("https://other.example.com".to_string());
    assert!(connection_identity_changed(&a, &b));
    assert!(!connection_identity_changed(&a, &a));
}

#[test]
fn connection_identity_detects_ssh_bastion_change() {
    let mut a = sample_s3("a", "P");
    a.ssh_tunnel = Some(crate::ssh_tunnel::SshTunnelConfig {
        host: "bastion-a.example.com".to_string(),
        port: 22,
        username: "deploy".to_string(),
        key_path: None,
        password: None,
    });
    let mut b = a.clone();
    b.ssh_tunnel.as_mut().unwrap().host = "bastion-b.example.com".to_string();
    assert!(connection_identity_changed(&a, &b));
}

#[test]
fn sanitize_imported_profile_cleans_ssh_tunnel_metadata() {
    let mut p = sample_sftp("x", "Box");
    p.ssh_tunnel = Some(crate::ssh_tunnel::SshTunnelConfig {
        host: "  bastion.example.com  ".to_string(),
        port: 22,
        username: "  deploy  ".to_string(),
        key_path: None,
        password: None,
    });
    let clean = sanitize_imported_profile(p).unwrap();
    let tunnel = clean.ssh_tunnel.unwrap();
    assert_eq!(tunnel.host, "bastion.example.com");
    assert_eq!(tunnel.username, "deploy");
}

#[test]
fn sanitize_imported_profile_rejects_ftp_tunnel() {
    let mut p = sample_sftp("x", "Box");
    p.protocol = Some("ftp".to_string());
    p.ssh_tunnel = Some(crate::ssh_tunnel::SshTunnelConfig {
        host: "bastion.example.com".to_string(),
        port: 22,
        username: "deploy".to_string(),
        key_path: None,
        password: None,
    });
    let err = sanitize_imported_profile(p).unwrap_err();
    assert!(err.contains("not supported for FTP/FTPS"));
}
