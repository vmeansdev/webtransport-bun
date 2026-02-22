//! Per-IP and per-prefix rate limiting for abuse resistance (P0-D, Phase 3).
//! P1-5: Stream-open and datagram ingress token buckets.

use dashmap::DashMap;
use once_cell::sync::Lazy;
use std::net::IpAddr;
use std::str::FromStr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

static PER_IP_SESSIONS: Lazy<DashMap<String, AtomicU64>> = Lazy::new(DashMap::new);
static PER_PREFIX_SESSIONS: Lazy<DashMap<String, AtomicU64>> = Lazy::new(DashMap::new);

/// Token bucket entry: (mutex(tokens, last_refill), rate_per_sec, burst).
type BucketEntry = (std::sync::Mutex<(f64, Instant)>, f64, f64);

static STREAM_BUCKETS: Lazy<DashMap<String, BucketEntry>> = Lazy::new(DashMap::new);
static DGRAM_BUCKETS: Lazy<DashMap<String, BucketEntry>> = Lazy::new(DashMap::new);

const DEFAULT_HANDSHAKES_BURST_PER_IP: u64 = 40;
const DEFAULT_HANDSHAKES_BURST_PER_PREFIX: u64 = 100;
const DEFAULT_STREAMS_PER_SEC: f64 = 200.0;
const DEFAULT_STREAMS_BURST: f64 = 400.0;
const DEFAULT_DATAGRAMS_PER_SEC: f64 = 2000.0;
const DEFAULT_DATAGRAMS_BURST: f64 = 5000.0;

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
    if let Some(entry) = PER_IP_SESSIONS.get(peer_ip) {
        let prev = entry
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| {
                Some(n.saturating_sub(1))
            })
            .unwrap_or(0);
        if prev <= 1 {
            drop(entry);
            PER_IP_SESSIONS.remove(peer_ip);
        }
    }
}

fn release_per_prefix_session_inner(prefix: &str) {
    if let Some(entry) = PER_PREFIX_SESSIONS.get(prefix) {
        let prev = entry
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| {
                Some(n.saturating_sub(1))
            })
            .unwrap_or(0);
        if prev <= 1 {
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

fn try_acquire_token(
    buckets: &DashMap<String, BucketEntry>,
    peer_ip: &str,
    rate_per_sec: f64,
    burst: f64,
) -> bool {
    let key = peer_ip.to_string();
    buckets
        .entry(key.clone())
        .or_insert_with(|| {
            (
                std::sync::Mutex::new((burst, Instant::now())),
                rate_per_sec,
                burst,
            )
        });
    let entry = buckets.get(&key).unwrap();
    let mut guard = entry.0.lock().unwrap();
    let (tokens, last) = *guard;
    let now = Instant::now();
    let elapsed = now.duration_since(last).as_secs_f64();
    let refill = rate_per_sec * elapsed;
    let tokens = (tokens + refill).min(burst);
    if tokens >= 1.0 {
        *guard = (tokens - 1.0, now);
        true
    } else {
        false
    }
}

/// Try to acquire one token for opening a stream from this IP. Returns false if rate limited.
pub fn try_acquire_stream_open(peer_ip: &str) -> bool {
    try_acquire_token(
        &STREAM_BUCKETS,
        peer_ip,
        DEFAULT_STREAMS_PER_SEC,
        DEFAULT_STREAMS_BURST,
    )
}

/// Try to acquire one token for datagram ingress from this IP. Returns false if rate limited.
pub fn try_acquire_datagram_ingress(peer_ip: &str) -> bool {
    try_acquire_token(
        &DGRAM_BUCKETS,
        peer_ip,
        DEFAULT_DATAGRAMS_PER_SEC,
        DEFAULT_DATAGRAMS_BURST,
    )
}

/// Remove stale entries from token buckets and zero-count session counters.
/// Call periodically (e.g. every 60s) to prevent unbounded memory growth.
pub fn cleanup_stale_entries(max_idle_secs: f64) {
    let now = Instant::now();
    STREAM_BUCKETS.retain(|_, v| {
        let guard = v.0.lock().unwrap();
        now.duration_since(guard.1).as_secs_f64() < max_idle_secs
    });
    DGRAM_BUCKETS.retain(|_, v| {
        let guard = v.0.lock().unwrap();
        now.duration_since(guard.1).as_secs_f64() < max_idle_secs
    });
    PER_IP_SESSIONS.retain(|_, v| v.load(Ordering::Relaxed) > 0);
    PER_PREFIX_SESSIONS.retain(|_, v| v.load(Ordering::Relaxed) > 0);
}
