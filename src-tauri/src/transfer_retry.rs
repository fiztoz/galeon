//! Transient-error detection and backoff for transfers (Sloop / friend reliability).
//!
//! Permanent failures (auth, 404, checksum, cancel) fail immediately.
//! Network blips get a few attempts with exponential backoff.

use std::time::Duration;

/// Whole-transfer attempts after a transient failure (e.g. connection died mid-stream).
pub const TRANSFER_MAX_ATTEMPTS: u32 = 4;
/// Retries for a single range-read or write chunk before failing the transfer attempt.
pub const CHUNK_MAX_ATTEMPTS: u32 = 3;

/// True when the error looks like a temporary network/server blip worth retrying.
pub fn is_transient_transfer_error(err: &str) -> bool {
    if err == "Transfer cancelled" || err.is_empty() {
        return false;
    }
    let e = err.to_ascii_lowercase();

    // Permanent / user-actionable — do not retry.
    let permanent = [
        "permission denied",
        "access denied",
        "forbidden",
        "unauthorized",
        "authentication",
        "invalid credentials",
        "access key",
        "secret key",
        "path traversal",
        "checksum mismatch",
        "not found",
        "no such file",
        "nosuchkey",
        "404",
        "403",
        "401",
        "invalid bucket",
        "no such bucket",
        "already exists", // conflict policy is UI-side; don't loop
    ];
    if permanent.iter().any(|p| e.contains(p)) {
        return false;
    }

    // Transient network / gateway / throttling.
    let transient = [
        "timeout",
        "timed out",
        "connection reset",
        "connection refused",
        "broken pipe",
        "reset by peer",
        "network",
        "temporarily",
        "temporary",
        "unavailable",
        "try again",
        "would block",
        "slow down",
        "throttl",
        "too many requests",
        "rate limit",
        "503",
        "502",
        "500",
        "504",
        "eof",
        "i/o error",
        "io error",
        "os error 32",  // EPIPE
        "os error 54",  // ECONNRESET (macOS)
        "os error 60",  // ETIMEDOUT (macOS)
        "os error 104", // ECONNRESET (Linux)
        "os error 110", // ETIMEDOUT (Linux)
        "incomplete message",
        "hyper::error",
        "reqwest",
        "error sending request",
        "connection closed",
        "closed before message completed",
    ];
    transient.iter().any(|t| e.contains(t))
}

/// Exponential backoff: 1s, 2s, 4s, … capped at 15s. `attempt` is 0-based.
pub fn transfer_backoff(attempt: u32) -> Duration {
    let ms = (1000u64 << attempt.min(4)).min(15_000);
    Duration::from_millis(ms)
}

/// Convert a panic inside a transfer body into an ordinary `Err`.
///
/// Transfer jobs run in `tokio::spawn`, where a panic unwinds the task and is
/// silently discarded: no `transfer-failed` event, and the queue entry stays
/// `active` until `restore_transfers` reconciles it on the *next* app launch.
/// Wrapping the body here means `finalize_transfer_job` always runs and the UI
/// sees a failed transfer instead of a row that spins forever.
///
/// The panic payload itself is intentionally not surfaced: it can contain
/// backend internals, and the default panic hook still prints it to stderr.
///
/// This guard does not box the body — callers that need the state off the stack
/// box it themselves (see `run_transfer_with_retries`).
pub async fn catch_transfer_panic<F, T>(body: F) -> Result<T, String>
where
    F: std::future::Future<Output = Result<T, String>>,
{
    use futures_util::FutureExt;
    match std::panic::AssertUnwindSafe(body).catch_unwind().await {
        Ok(result) => result,
        Err(_) => Err(TRANSFER_PANIC_MESSAGE.to_string()),
    }
}

/// Message shown when a transfer body panicked rather than returning an error.
pub const TRANSFER_PANIC_MESSAGE: &str = "Transfer failed unexpectedly";

/// Run `op` up to `max_attempts` times when errors are transient.
/// `on_retry(attempt, delay, error)` is called before sleeping (attempt is 0-based, next try is attempt+1).
pub async fn with_transient_retries<T, F, Fut, R>(
    max_attempts: u32,
    mut on_retry: R,
    mut op: F,
) -> Result<T, String>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T, String>>,
    R: FnMut(u32, Duration, &str),
{
    let attempts = max_attempts.max(1);
    let mut last_err = String::from("transfer failed");
    for attempt in 0..attempts {
        match op().await {
            Ok(v) => return Ok(v),
            Err(e) => {
                if e == "Transfer cancelled" {
                    return Err(e);
                }
                let retryable = is_transient_transfer_error(&e) && attempt + 1 < attempts;
                if !retryable {
                    return Err(e);
                }
                let delay = transfer_backoff(attempt);
                on_retry(attempt, delay, &e);
                tokio::time::sleep(delay).await;
                last_err = e;
            }
        }
    }
    Err(last_err)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancel_is_not_transient() {
        assert!(!is_transient_transfer_error("Transfer cancelled"));
    }

    #[test]
    fn auth_and_not_found_are_permanent() {
        assert!(!is_transient_transfer_error("Access Denied: 403 Forbidden"));
        assert!(!is_transient_transfer_error(
            "NoSuchKey: The specified key does not exist"
        ));
        assert!(!is_transient_transfer_error(
            "Checksum mismatch: expected a, got b"
        ));
        assert!(!is_transient_transfer_error("Path traversal detected"));
    }

    #[test]
    fn network_blips_are_transient() {
        assert!(is_transient_transfer_error("connection reset by peer"));
        assert!(is_transient_transfer_error(
            "error sending request for url: timeout"
        ));
        assert!(is_transient_transfer_error("os error 54"));
        assert!(is_transient_transfer_error("HTTP 503 Service Unavailable"));
        assert!(is_transient_transfer_error("broken pipe"));
    }

    #[test]
    fn backoff_grows_and_caps() {
        assert_eq!(transfer_backoff(0).as_millis(), 1000);
        assert_eq!(transfer_backoff(1).as_millis(), 2000);
        assert_eq!(transfer_backoff(2).as_millis(), 4000);
        assert_eq!(transfer_backoff(10).as_millis(), 15_000);
    }

    #[tokio::test]
    async fn panic_becomes_an_err_instead_of_unwinding() {
        // The whole point: a panicking transfer body must still produce a
        // Result so the caller can finalize the queue entry.
        let result: Result<(), String> = catch_transfer_panic(async { panic!("boom") }).await;
        assert_eq!(result, Err(TRANSFER_PANIC_MESSAGE.to_string()));
    }

    #[tokio::test]
    async fn success_and_ordinary_errors_pass_through() {
        let ok: Result<u32, String> = catch_transfer_panic(async { Ok(7) }).await;
        assert_eq!(ok, Ok(7));

        let err: Result<u32, String> =
            catch_transfer_panic(async { Err("Transfer cancelled".to_string()) }).await;
        assert_eq!(err, Err("Transfer cancelled".to_string()));
    }

    #[tokio::test]
    async fn retries_still_apply_to_transient_errors() {
        // The guard wraps the retry loop, it does not replace it: transient
        // *errors* still get TRANSFER_MAX_ATTEMPTS tries.
        use std::sync::atomic::{AtomicU32, Ordering};
        let attempts = AtomicU32::new(0);
        let result: Result<(), String> = with_transient_retries(
            TRANSFER_MAX_ATTEMPTS,
            |_, _, _| {},
            || {
                attempts.fetch_add(1, Ordering::SeqCst);
                async { Err("connection reset by peer".to_string()) }
            },
        )
        .await;
        assert!(result.is_err());
        assert_eq!(attempts.load(Ordering::SeqCst), TRANSFER_MAX_ATTEMPTS);
    }

    #[tokio::test]
    async fn retries_then_succeeds() {
        use std::sync::atomic::{AtomicU32, Ordering};
        let n = AtomicU32::new(0);
        let result = with_transient_retries(
            4,
            |_, _, _| {},
            || {
                let attempt = n.fetch_add(1, Ordering::SeqCst);
                async move {
                    if attempt < 2 {
                        Err("connection reset by peer".to_string())
                    } else {
                        Ok(42)
                    }
                }
            },
        )
        .await;
        assert_eq!(result.unwrap(), 42);
        assert_eq!(n.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn permanent_fails_immediately() {
        use std::sync::atomic::{AtomicU32, Ordering};
        let n = AtomicU32::new(0);
        let result: Result<(), String> = with_transient_retries(
            4,
            |_, _, _| {},
            || {
                n.fetch_add(1, Ordering::SeqCst);
                async { Err::<(), _>("403 Forbidden".to_string()) }
            },
        )
        .await;
        assert!(result.unwrap_err().contains("403"));
        assert_eq!(n.load(Ordering::SeqCst), 1);
    }
}
