//! Wall-clock schedule maths shared by sync schedules and bandwidth windows.

use crate::*;

/// Parse a 24h "HH:MM" time string into (hour, minute).
pub(crate) fn parse_hhmm(time: &str) -> Option<(u32, u32)> {
    let mut parts = time.split(':');
    let h: u32 = parts.next()?.parse().ok()?;
    let m: u32 = parts.next()?.parse().ok()?;
    if parts.next().is_some() || h >= 24 || m >= 60 {
        return None;
    }
    Some((h, m))
}

/// Whether `now_minutes` (minutes since midnight) falls in `[start, end)` local
/// time. Supports wrap-around windows such as 22:00–06:00.
pub(crate) fn time_in_window(now_minutes: u32, start_minutes: u32, end_minutes: u32) -> bool {
    if start_minutes < end_minutes {
        now_minutes >= start_minutes && now_minutes < end_minutes
    } else if start_minutes > end_minutes {
        now_minutes >= start_minutes || now_minutes < end_minutes
    } else {
        false
    }
}

/// Compute the next scheduled run time (unix epoch ms) after `now_ms` for the
/// given schedule. All times are evaluated in the system's local timezone.
pub fn compute_next_run_ms(now_ms: u64, schedule: &SyncSchedule) -> u64 {
    use chrono::{Datelike, Duration, Local, TimeZone, Timelike};

    let now = Local
        .timestamp_millis_opt(now_ms as i64)
        .single()
        .unwrap_or_else(Local::now);

    let at_hms = |dt: chrono::DateTime<chrono::Local>| {
        dt.with_hour(schedule.at_hour as u32)
            .and_then(|d| d.with_minute(schedule.at_minute as u32))
            .and_then(|d| d.with_second(0))
            .and_then(|d| d.with_nanosecond(0))
            .unwrap_or(dt)
    };

    match schedule.frequency.as_str() {
        "hourly" => {
            let mut target = now
                .with_minute(schedule.at_minute as u32)
                .and_then(|d| d.with_second(0))
                .and_then(|d| d.with_nanosecond(0))
                .unwrap_or(now);
            if target <= now {
                target += Duration::hours(1);
            }
            target.timestamp_millis() as u64
        }
        "daily" => {
            let mut target = at_hms(now);
            if target <= now {
                target += Duration::days(1);
            }
            target.timestamp_millis() as u64
        }
        "once" => {
            // "once" means today only: if the target time has already passed,
            // return now_ms so the scheduler won't schedule another run.
            let target = at_hms(now);
            if target > now {
                target.timestamp_millis() as u64
            } else {
                now_ms
            }
        }
        "weekly" => {
            let target_dow = schedule.day_of_week.unwrap_or(0);
            for offset in 0..8i64 {
                let day = now.date_naive() + Duration::days(offset);
                if day.weekday().num_days_from_monday() as u8 != target_dow {
                    continue;
                }
                let naive = day.and_hms_opt(schedule.at_hour as u32, schedule.at_minute as u32, 0);
                if let Some(naive) = naive {
                    if let Some(target) = Local.from_local_datetime(&naive).single() {
                        if target > now {
                            return target.timestamp_millis() as u64;
                        }
                    }
                }
            }
            at_hms(now + Duration::days(7)).timestamp_millis() as u64
        }
        _ => now_ms.saturating_add(60_000),
    }
}
