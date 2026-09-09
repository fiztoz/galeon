//! Bounded LRU cache and scanning machinery for recursive prefix sizes.

use crate::*;
use opendal::services::S3_SCHEME;
use opendal::Operator;
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};

/// Cached S3 prefix size totals. Capped at 64 entries (~few KB); entries expire after 10 min.
const PREFIX_SIZE_CACHE_MAX: usize = 64;
const PREFIX_SIZE_CACHE_TTL_MS: u64 = 10 * 60 * 1000;

#[derive(Clone, Debug)]
struct PrefixSizeCacheEntry {
    total_bytes: u64,
    file_count: u64,
    cached_at_ms: u64,
}

type PrefixSizeCacheKey = (String, String);

#[derive(Debug, Default)]
pub(crate) struct PrefixSizeCache {
    entries: HashMap<PrefixSizeCacheKey, PrefixSizeCacheEntry>,
    order: VecDeque<PrefixSizeCacheKey>,
}

impl PrefixSizeCache {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    pub(crate) fn normalize_prefix(prefix: &str) -> String {
        let trimmed = prefix.trim_end_matches('/');
        if trimmed.is_empty() {
            String::new()
        } else {
            format!("{}/", trimmed)
        }
    }

    pub(crate) fn touch(&mut self, key: &PrefixSizeCacheKey) {
        self.order.retain(|k| k != key);
        self.order.push_back(key.clone());
    }

    pub(crate) fn get(&mut self, session_id: &str, prefix: &str) -> Option<(u64, u64)> {
        let key = (session_id.to_string(), Self::normalize_prefix(prefix));
        let entry = self.entries.get(&key)?;
        if now_ms().saturating_sub(entry.cached_at_ms) > PREFIX_SIZE_CACHE_TTL_MS {
            self.remove_key(&key);
            return None;
        }
        let total_bytes = entry.total_bytes;
        let file_count = entry.file_count;
        self.touch(&key);
        Some((total_bytes, file_count))
    }

    pub(crate) fn insert(
        &mut self,
        session_id: &str,
        prefix: &str,
        total_bytes: u64,
        file_count: u64,
    ) {
        let key = (session_id.to_string(), Self::normalize_prefix(prefix));
        while self.entries.len() >= PREFIX_SIZE_CACHE_MAX {
            if let Some(oldest) = self.order.pop_front() {
                self.entries.remove(&oldest);
            } else {
                break;
            }
        }
        self.entries.insert(
            key.clone(),
            PrefixSizeCacheEntry {
                total_bytes,
                file_count,
                cached_at_ms: now_ms(),
            },
        );
        self.touch(&key);
    }

    pub(crate) fn remove_key(&mut self, key: &PrefixSizeCacheKey) {
        self.entries.remove(key);
        self.order.retain(|k| k != key);
    }

    pub(crate) fn remove_session(&mut self, session_id: &str) {
        self.entries.retain(|(sid, _), _| sid != session_id);
        self.order.retain(|(sid, _)| sid != session_id);
    }
}

pub(crate) async fn invalidate_prefix_size_cache_for_session(
    state: &GaleonEngine,
    session_id: &str,
) {
    state
        .prefix_size_cache
        .write()
        .await
        .remove_session(session_id);
}

const PREFIX_SIZE_PROGRESS_INTERVAL: u64 = 50;

#[allow(clippy::too_many_arguments)]
pub(crate) fn emit_prefix_size_progress(
    app_handle: &AppHandleType,
    job_id: &str,
    prefix: &str,
    total_bytes: u64,
    file_count: u64,
    complete: bool,
    cancelled: bool,
    error: Option<String>,
) {
    use tauri::Emitter;
    let _ = app_handle.emit(
        "prefix-size-progress",
        PrefixSizeProgressPayload {
            job_id: job_id.to_string(),
            prefix: prefix.to_string(),
            total_bytes,
            file_count,
            complete,
            cancelled,
            error,
        },
    );
}

async fn compute_prefix_size_s3(
    app_handle: &AppHandleType,
    job_id: &str,
    prefix: &str,
    op: &Operator,
    cancel: &AtomicBool,
) -> Result<(u64, u64), String> {
    let prefix_str = if prefix.is_empty() {
        String::new()
    } else if prefix.ends_with('/') {
        prefix.to_string()
    } else {
        format!("{}/", prefix)
    };

    let mut lister = op
        .lister_with(&prefix_str)
        .recursive(true)
        .await
        .map_err(|e| format!("Lister error: {}", e))?;

    let mut total_bytes = 0u64;
    let mut file_count = 0u64;
    let mut since_emit = 0u64;

    while let Some(entry) = lister
        .try_next()
        .await
        .map_err(|e| format!("Stream error: {}", e))?
    {
        if cancel.load(Ordering::SeqCst) {
            return Err("cancelled".to_string());
        }
        let path = entry.path().to_string();
        if path == prefix_str {
            continue;
        }
        let meta = entry.metadata();
        if meta.mode().is_dir() {
            continue;
        }
        total_bytes = total_bytes.saturating_add(meta.content_length());
        file_count += 1;
        since_emit += 1;
        if since_emit >= PREFIX_SIZE_PROGRESS_INTERVAL {
            emit_prefix_size_progress(
                app_handle,
                job_id,
                prefix,
                total_bytes,
                file_count,
                false,
                false,
                None,
            );
            since_emit = 0;
        }
    }

    Ok((total_bytes, file_count))
}

pub(crate) async fn compute_prefix_size_inner(
    app_handle: &AppHandleType,
    job_id: &str,
    prefix: &str,
    session: &StorageSession,
    cancel: &AtomicBool,
) -> Result<(u64, u64), String> {
    let StorageSession::OpenDAL(op) = session else {
        return Err("Prefix size calculation is only supported for S3.".to_string());
    };
    if op.info().scheme() != S3_SCHEME {
        return Err("Prefix size calculation is only supported for S3.".to_string());
    }
    compute_prefix_size_s3(app_handle, job_id, prefix, op, cancel).await
}
