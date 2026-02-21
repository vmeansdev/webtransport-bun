//! Per-IP rate limiting for abuse resistance (P0-D).

use dashmap::DashMap;
use once_cell::sync::Lazy;
use std::sync::atomic::{AtomicU64, Ordering};

static PER_IP_SESSIONS: Lazy<DashMap<String, AtomicU64>> = Lazy::new(DashMap::new);

const DEFAULT_HANDSHAKES_BURST_PER_IP: u64 = 40;

pub fn handshakes_burst_from_json(json: &str) -> u64 {
    serde_json::from_str::<serde_json::Value>(json)
        .ok()
        .and_then(|v| v.get("handshakesBurst").and_then(|x| x.as_u64()))
        .unwrap_or(DEFAULT_HANDSHAKES_BURST_PER_IP)
}

/// Check if this IP can accept a new session. Returns true if allowed.
/// Increments the per-IP counter; caller must call release_per_ip_session when session closes.
pub fn try_acquire_per_ip_session(peer_ip: &str, burst_limit: u64) -> bool {
    let burst = if burst_limit > 0 {
        burst_limit
    } else {
        DEFAULT_HANDSHAKES_BURST_PER_IP
    };
    PER_IP_SESSIONS
        .entry(peer_ip.to_string())
        .or_insert_with(|| AtomicU64::new(0))
        .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| {
            if n < burst {
                Some(n + 1)
            } else {
                None
            }
        })
        .is_ok()
}

/// Release a session for this IP. Call when session closes.
pub fn release_per_ip_session(peer_ip: &str) {
    if let Some(entry) = PER_IP_SESSIONS.get_mut(peer_ip) {
        let n = entry.fetch_sub(1, Ordering::SeqCst);
        if n <= 1 {
            drop(entry);
            PER_IP_SESSIONS.remove(peer_ip);
        }
    }
}
