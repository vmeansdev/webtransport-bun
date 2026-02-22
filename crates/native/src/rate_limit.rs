//! Per-IP and per-prefix rate limiting for abuse resistance (P0-D, Phase 3).

use dashmap::DashMap;
use once_cell::sync::Lazy;
use std::net::IpAddr;
use std::str::FromStr;
use std::sync::atomic::{AtomicU64, Ordering};

static PER_IP_SESSIONS: Lazy<DashMap<String, AtomicU64>> = Lazy::new(DashMap::new);
static PER_PREFIX_SESSIONS: Lazy<DashMap<String, AtomicU64>> = Lazy::new(DashMap::new);

const DEFAULT_HANDSHAKES_BURST_PER_IP: u64 = 40;
const DEFAULT_HANDSHAKES_BURST_PER_PREFIX: u64 = 100;

pub fn handshakes_burst_from_json(json: &str) -> u64 {
    serde_json::from_str::<serde_json::Value>(json)
        .ok()
        .and_then(|v| v.get("handshakesBurst").and_then(|x| x.as_u64()))
        .unwrap_or(DEFAULT_HANDSHAKES_BURST_PER_IP)
}

pub fn handshakes_burst_per_prefix_from_json(json: &str) -> u64 {
    serde_json::from_str::<serde_json::Value>(json)
        .ok()
        .and_then(|v| v.get("handshakesBurstPerPrefix").and_then(|x| x.as_u64()))
        .unwrap_or(DEFAULT_HANDSHAKES_BURST_PER_PREFIX)
}

/// Extract /24 (IPv4) or /64 (IPv6) prefix from peer IP string.
pub fn ip_to_prefix(peer_ip: &str) -> String {
    if let Ok(ip) = IpAddr::from_str(peer_ip) {
        match ip {
            IpAddr::V4(a) => {
                let octets = a.octets();
                format!("{}.{}.{}.0/24", octets[0], octets[1], octets[2])
            }
            IpAddr::V6(a) => {
                let segs = a.segments();
                format!(
                    "{:x}:{:x}:{:x}:{:x}::/64",
                    segs[0], segs[1], segs[2], segs[3]
                )
            }
        }
    } else {
        peer_ip.to_string()
    }
}

/// Check if this IP (and its prefix) can accept a new session. Returns true if allowed.
/// Increments both per-IP and per-prefix counters; caller must call release_per_ip_session when session closes.
pub fn try_acquire_per_ip_session(peer_ip: &str, burst_limit: u64) -> bool {
    try_acquire_per_ip_session_with_prefix(peer_ip, burst_limit, DEFAULT_HANDSHAKES_BURST_PER_PREFIX)
}

pub fn try_acquire_per_ip_session_with_prefix(
    peer_ip: &str,
    burst_limit: u64,
    prefix_burst_limit: u64,
) -> bool {
    let burst = if burst_limit > 0 {
        burst_limit
    } else {
        DEFAULT_HANDSHAKES_BURST_PER_IP
    };
    let prefix_burst = if prefix_burst_limit > 0 {
        prefix_burst_limit
    } else {
        DEFAULT_HANDSHAKES_BURST_PER_PREFIX
    };
    let prefix = ip_to_prefix(peer_ip);

    let ip_ok = PER_IP_SESSIONS
        .entry(peer_ip.to_string())
        .or_insert_with(|| AtomicU64::new(0))
        .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| {
            if n < burst {
                Some(n + 1)
            } else {
                None
            }
        })
        .is_ok();
    if !ip_ok {
        return false;
    }

    let prefix_ok = PER_PREFIX_SESSIONS
        .entry(prefix.clone())
        .or_insert_with(|| AtomicU64::new(0))
        .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| {
            if n < prefix_burst {
                Some(n + 1)
            } else {
                None
            }
        })
        .is_ok();
    if !prefix_ok {
        release_per_ip_session_inner(peer_ip);
        return false;
    }
    true
}

fn release_per_ip_session_inner(peer_ip: &str) {
    if let Some(entry) = PER_IP_SESSIONS.get_mut(peer_ip) {
        let n = entry.fetch_sub(1, Ordering::SeqCst);
        if n <= 1 {
            drop(entry);
            PER_IP_SESSIONS.remove(peer_ip);
        }
    }
}

fn release_per_prefix_session_inner(prefix: &str) {
    if let Some(entry) = PER_PREFIX_SESSIONS.get_mut(prefix) {
        let n = entry.fetch_sub(1, Ordering::SeqCst);
        if n <= 1 {
            drop(entry);
            PER_PREFIX_SESSIONS.remove(prefix);
        }
    }
}

/// Release a session for this IP. Call when session closes.
pub fn release_per_ip_session(peer_ip: &str) {
    let prefix = ip_to_prefix(peer_ip);
    release_per_ip_session_inner(peer_ip);
    release_per_prefix_session_inner(&prefix);
}
