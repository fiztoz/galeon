//! Galeon — library root.
//!
//! Structure (AGENTS.md 2 / 4):
//! - `commands/` — the thin Tauri command layer, grouped by feature
//! - `engine`, `types`, `listing`, `editing`, `prefix_size`, `bandwidth`,
//!   `connect_config` — shared runtime state and wire contracts
//! - `sync_*`, `schedule` — the one-way sync domain
//! - `s3_connect`, `credentials`, `profile_io`, `s3_metadata`, `ssh_*`,
//!   `sftp_native`, `ftp_native`, `transfer_retry` — protocol + secret domains
//!
//! New behavior belongs in a domain module, not in a command body.

// Shared prelude for the crate's modules.
//
// `commands/*.rs` and the domain modules open with `use crate::*;`, so these
// non-pub `use` lines resolve names like `Operator`, `Arc`, and the serde derive
// macros for every descendant module. Rust lets descendants see an ancestor's
// private imports, which keeps 30 files from each repeating the same nine lines.
// Trade-off: deleting one here breaks the crate somewhere else, not here.
use futures_util::TryStreamExt;
use opendal::{services::Sftp, Operator};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use tauri::Manager;
use tokio::sync::RwLock;
use uuid::Uuid;

// Protocol and credential domains — these own their own behavior.

pub mod credentials;
pub mod ftp_native;
pub mod menu_bar;
pub mod profile_io;
pub mod s3_connect;
pub mod s3_metadata;
pub mod sftp_native;
pub mod ssh_config;
pub mod ssh_known_hosts;
pub mod ssh_tunnel;
pub mod ssh_tunnel_profiles;
pub mod transfer_retry;

// Shared runtime state, wire contracts, and the sync domain.

pub mod bandwidth;
pub mod connect_config;
pub mod editing;
pub mod engine;
pub mod listing;
pub mod prefix_size;
pub mod schedule;
pub mod sync_plan;
pub mod sync_store;
pub mod sync_tree;
pub mod sync_types;
pub mod types;

// Re-exported so `crate::<name>` keeps resolving for the command layer and
// integrity_e2e.

pub use bandwidth::*;
pub(crate) use connect_config::*;
pub use editing::*;
pub use engine::*;
pub(crate) use listing::*;
pub(crate) use prefix_size::*;
pub use schedule::*;
pub use sync_plan::*;
pub(crate) use sync_store::*;
pub use sync_tree::*;
pub use sync_types::*;
pub use types::*;

#[cfg(test)]
mod tests;

pub mod commands;

// Lets `commands/*.rs` siblings call each other through `use crate::*;` and
// feeds `integrity_e2e`'s `use crate::{connect_bucket, ...}`.
pub use commands::*;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
#[cfg(not(test))]
pub fn run() {
    tauri::Builder::default()
        .manage(GaleonEngine::default())
        .setup(|app| {
            if let Err(err) = menu_bar::install(app.handle()) {
                eprintln!("Failed to install app menu: {err}");
            }

            let handle = app.handle().clone();
            let engine = app.state::<GaleonEngine>();
            if engine
                .sync_scheduler_started
                .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok()
            {
                let state = Arc::new(engine.inner().clone());
                // setup() runs on the main thread before a tokio handle is
                // available — use Tauri's runtime bridge, not tokio::spawn.
                tauri::async_runtime::spawn(run_sync_scheduler(handle, state));
            }
            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            connect_bucket,
            connect_storage,
            list_directory,
            initiate_download,
            initiate_upload,
            check_remote_exists,
            pause_transfer,
            resume_transfer,
            cancel_transfer,
            create_folder,
            delete_object,
            delete_objects,
            cancel_delete_job,
            rename_object,
            copy_object,
            generate_presigned_url,
            get_presign_history,
            clear_presign_history,
            delete_presign_history_entry,
            check_file_exists,
            list_local_directory,
            create_local_folder,
            get_transfer_queue,
            clear_completed_transfers,
            restore_transfers,
            add_to_transfer_queue,
            update_transfer_queue_entry,
            get_profiles,
            save_profile,
            delete_profile,
            get_profile_credentials,
            get_profile_ssh_tunnel_password,
            ssh_tunnel_profiles::get_ssh_tunnel_profiles,
            ssh_tunnel_profiles::save_ssh_tunnel_profile,
            delete_ssh_tunnel_profile,
            migrate_legacy_credentials_to_vault,
            profile_io::export_profiles,
            profile_io::import_profiles,
            profile_io::preview_profile_import,
            auto_reconnect,
            generate_ssh_key,
            get_home_dir,
            ssh_config::list_ssh_config_connections,
            ssh_config::list_ssh_tunnel_config_connections,
            get_protocol_capabilities,
            edit_remote_file,
            stop_editing_file,
            list_edit_sessions,
            get_object_metadata,
            compute_prefix_size,
            cancel_prefix_size,
            preview_remote_file,
            read_object_preview,
            update_object_metadata,
            verify_local_matches_remote,
            compute_sync_diff,
            execute_sync_plan,
            get_sync_profiles,
            save_sync_profile,
            delete_sync_profile,
            run_sync_profile_now,
            get_app_settings,
            save_app_settings,
            reset_onboarding,
            get_app_metadata,
            lock_credentials_now,
            get_credential_unlock_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod integrity_e2e;
