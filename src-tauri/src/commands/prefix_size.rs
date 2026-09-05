// Background prefix-size scans with cancellation and progress events.

use crate::*;

/// Start a background recursive S3 size scan for `prefix` (bucket root when empty).
/// Returns a `job_id` immediately; progress and completion are delivered via
/// `prefix-size-progress` events so the UI is never blocked. Recent results are
/// served from a small in-memory LRU cache (64 entries, 10 min TTL).
#[tauri::command]
pub async fn compute_prefix_size(
    app_handle: AppHandleType,
    state: tauri::State<'_, GaleonEngine>,
    session_id: String,
    prefix: String,
) -> Result<ComputePrefixSizeResponse, String> {
    let sessions = state.active_sessions.read().await;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| "Active session not found".to_string())?
        .clone();
    drop(sessions);

    let job_id = Uuid::new_v4().to_string();

    if let Some((total_bytes, file_count)) = state
        .prefix_size_cache
        .write()
        .await
        .get(&session_id, &prefix)
    {
        return Ok(ComputePrefixSizeResponse {
            job_id,
            cached: true,
            total_bytes: Some(total_bytes),
            file_count: Some(file_count),
        });
    }

    let cancel = Arc::new(AtomicBool::new(false));
    state
        .prefix_size_jobs
        .write()
        .await
        .insert(job_id.clone(), cancel.clone());

    let handle = app_handle.clone();
    let engine = state.inner().clone();
    let job_id_spawn = job_id.clone();
    let prefix_spawn = prefix.clone();
    let session_id_spawn = session_id.clone();
    tauri::async_runtime::spawn(async move {
        let result =
            compute_prefix_size_inner(&handle, &job_id_spawn, &prefix_spawn, &session, &cancel)
                .await;

        match result {
            Ok((total_bytes, file_count)) => {
                engine.prefix_size_cache.write().await.insert(
                    &session_id_spawn,
                    &prefix_spawn,
                    total_bytes,
                    file_count,
                );
                emit_prefix_size_progress(
                    &handle,
                    &job_id_spawn,
                    &prefix_spawn,
                    total_bytes,
                    file_count,
                    true,
                    false,
                    None,
                );
            }
            Err(e) if e == "cancelled" => {
                emit_prefix_size_progress(
                    &handle,
                    &job_id_spawn,
                    &prefix_spawn,
                    0,
                    0,
                    true,
                    true,
                    None,
                );
            }
            Err(e) => {
                emit_prefix_size_progress(
                    &handle,
                    &job_id_spawn,
                    &prefix_spawn,
                    0,
                    0,
                    true,
                    false,
                    Some(e),
                );
            }
        }

        engine.prefix_size_jobs.write().await.remove(&job_id_spawn);
    });

    Ok(ComputePrefixSizeResponse {
        job_id,
        cached: false,
        total_bytes: None,
        file_count: None,
    })
}

/// Cancel an in-flight prefix size scan started by `compute_prefix_size`.
#[tauri::command]
pub async fn cancel_prefix_size(
    state: tauri::State<'_, GaleonEngine>,
    job_id: String,
) -> Result<(), String> {
    if let Some(cancel) = state.prefix_size_jobs.read().await.get(&job_id) {
        cancel.store(true, Ordering::SeqCst);
    }
    Ok(())
}
