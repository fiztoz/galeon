//! Profile export / import — the `galeon.profiles` envelope.
//!
//! Config JSON holds profile *metadata*; secrets live in the OS keyring, so an
//! export carries secrets only when explicitly asked, and importing secrets back
//! requires a confirmation plus the preview content hash (TOCTOU). Identity
//! changes without new secrets must clear the vault rather than rebind old
//! secrets to a different host. See AGENTS.md 3.6.
//!
//! Submodules: `types` (wire shapes), `export`, `parse`, `merge` (policy),
//! `secrets` (keyring bridge), `commands` (the Tauri surface).

use crate::s3_connect::{clean_connection_field, clean_connection_opt, validate_bucket_name};
use crate::{credentials, ConnectionProfile, GaleonEngine};
use crate::{now_ms, read_config, write_config, AppHandleType};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use uuid::Uuid;

pub const EXPORT_FORMAT: &str = "galeon.profiles";
pub const EXPORT_VERSION: u32 = 1;
/// Hard cap on import file size (defense-in-depth against huge payloads).
pub const MAX_IMPORT_FILE_BYTES: u64 = 5 * 1024 * 1024;
/// Hard cap on number of profiles in a single import.
pub const MAX_IMPORT_PROFILES: usize = 500;

mod commands;
mod export;
mod merge;
mod parse;
mod secrets;
mod types;
pub use commands::*;
pub use export::*;
pub use merge::*;
pub use parse::*;
// Every item here is pub(crate) — this module is the keyring bridge, not a
// public API surface, so the re-export must not claim wider visibility.
pub(crate) use secrets::*;
pub use types::*;

#[cfg(test)]
mod tests;
