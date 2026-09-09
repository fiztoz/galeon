//! Scheduled bandwidth limit resolution for connections and transfers.

use crate::*;

/// Return the `limit_kbps` of the first matching enabled bandwidth rule at
/// `now_ms`, or `None` when no rule matches.
pub fn current_bandwidth_limit_kbps(rules: &[BandwidthRule], now_ms: u64) -> Option<u64> {
    use chrono::{Datelike, Local, TimeZone, Timelike};

    let now = Local.timestamp_millis_opt(now_ms as i64).single()?;
    let dow = now.weekday().num_days_from_monday() as u8;
    let now_minutes = now.hour() * 60 + now.minute();

    for rule in rules {
        if !rule.enabled || !rule.days.contains(&dow) {
            continue;
        }
        let (sh, sm) = parse_hhmm(&rule.start_time)?;
        let (eh, em) = parse_hhmm(&rule.end_time)?;
        let start_minutes = sh * 60 + sm;
        let end_minutes = eh * 60 + em;
        if time_in_window(now_minutes, start_minutes, end_minutes) {
            return Some(rule.limit_kbps);
        }
    }
    None
}

/// Resolve the effective bandwidth cap in bytes/s for a connection at
/// `now_ms`. Matching rule with `limit_kbps > 0` wins; `limit_kbps == 0` means
/// unlimited (`None`); otherwise falls back to `profile.max_bandwidth`.
pub fn resolve_bandwidth_limit_bytes_per_sec(
    profile: &ConnectionProfile,
    now_ms: u64,
) -> Option<u64> {
    let rules = profile.bandwidth_rules.as_deref().unwrap_or_default();
    if let Some(kbps) = current_bandwidth_limit_kbps(rules, now_ms) {
        if kbps == 0 {
            return None;
        }
        return Some(kbps.saturating_mul(1024));
    }
    profile.max_bandwidth.filter(|&limit| limit > 0)
}
