//! Tauri command layer.
//!
//! Commands are grouped by feature. Each module starts with `use crate::*;`,
//! which — through the crate root's `pub use commands::*;` — also exposes
//! every sibling module's `pub`/`pub(crate)` items, so helpers move between
//! files without an import churn chase.
//!
//! Keep command bodies thin: validate, call the domain module, map the error
//! to a string. Domain logic belongs in `s3_connect`, `credentials`,
//! `profile_io`, `transfer_retry`, ... (AGENTS.md 4.4).

pub use browse::*;
pub(crate) use config_store::*;
pub use connect::*;
pub use credentials::*;
pub use editor::*;
pub use local::*;
pub use metadata::*;
pub use objects::*;
pub use prefix_size::*;
pub use presign::*;
pub use preview::*;
pub use profiles::*;
pub use sync::*;
pub use transfer_integrity::*;
pub(crate) use transfer_protocols::*;
pub use transfer_queue::*;
pub use transfers::*;
pub use tunnels::*;

mod browse;
mod config_store;
mod connect;
mod credentials;
mod editor;
mod local;
mod metadata;
mod objects;
mod prefix_size;
mod presign;
mod preview;
mod profiles;
mod sync;
mod transfer_integrity;
mod transfer_protocols;
mod transfer_queue;
mod transfers;
mod tunnels;
