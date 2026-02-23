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

static HANDSHAKE_BUCKETS: Lazy<DashMap<String, BucketEntry>> = Lazy::new(DashMap::new);
static STREAM_BUCKETS: Lazy<DashMap<String, BucketEntry>> = Lazy::new(DashMap::new);
static DGRAM_BUCKETS: Lazy<DashMap<String, BucketEntry>> = Lazy::new(DashMap::new);

const DEFAULT_HANDSHAKES_BURST_PER_IP: u64 = 40;
const DEFAULT_HANDSHAKES_BURST_PER_PREFIX: u64 = 100;
const DEFAULT_HANDSHAKES_PER_SEC: f64 = 20.0;
const DEFAULT_HANDSHAKES_BURST: f64 = 40.0;
const DEFAULT_STREAMS_PER_SEC: f64 = 200.0;
const DEFAULT_STREAMS_BURST: f64 = 400.0;
const DEFAULT_DATAGRAMS_PER_SEC: f64 = 2000.0;
const DEFAULT_DATAGRAMS_BURST: f64 = 5000.0;

/// Parsed rate limit configuration from JS options.
#[derive(Clone, Debug)]
pub struct RateLimits {
    pub handshakes_burst_per_ip: u64,
    pub handshakes_burst_per_prefix: u64,
    pub handshakes_per_sec: f64,
    pub handshakes_burst: f64,
    pub streams_per_sec: f64,
    pub streams_burst: f64,
    pub datagrams_per_sec: f64,
    pub datagrams_burst: f64,
}

impl Default for RateLimits {
    fn default() -> Self {
        Self {
            handshakes_burst_per_ip: DEFAULT_HANDSHAKES_BURST_PER_IP,
            handshakes_burst_per_prefix: DEFAULT_HANDSHAKES_BURST_PER_PREFIX,
            handshakes_per_sec: DEFAULT_HANDSHAKES_PER_SEC,
            handshakes_burst: DEFAULT_HANDSHAKES_BURST,
            streams_per_sec: DEFAULT_STREAMS_PER_SEC,
            streams_burst: DEFAULT_STREAMS_BURST,
            datagrams_per_sec: DEFAULT_DATAGRAMS_PER_SEC,
            datagrams_burst: DEFAULT_DATAGRAMS_BURST,
        }
    }
}

impl RateLimits {
    pub fn from_json(json: &str) -> Self {
        let mut rl = Self::default();
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(json) {
            if let Some(n) = v.get("handshakesBurst").and_then(|x| x.as_u64()) {
                rl.handshakes_burst_per_ip = n;
            }
            if let Some(n) = v.get("handshakesBurstPerPrefix").and_then(|x| x.as_u64()) {
                rl.handshakes_burst_per_prefix = n;
            }
            if let Some(n) = v.get("streamsPerSec").and_then(|x| x.as_f64()) {
                rl.streams_per_sec = n;
            }
            if let Some(n) = v.get("streamsBurst").and_then(|x| x.as_f64()) {
                rl.streams_burst = n;
            }
            if let Some(n) = v.get("datagramsPerSec").and_then(|x| x.as_f64()) {
                rl.datagrams_per_sec = n;
            }
            if let Some(n) = v.get("datagramsBurst").and_then(|x| x.as_f64()) {
                rl.datagrams_burst = n;
            }
            if let Some(n) = v.get("handshakesPerSec").and_then(|x| x.as_f64()) {
                rl.handshakes_per_sec = n;
            }
            // Public API: handshakesBurst drives the token-bucket burst.
            // Compat: handshakesBurstTokens accepted as fallback.
            if let Some(n) = v.get("handshakesBurst").and_then(|x| x.as_f64()) {
                rl.handshakes_burst = n;
            } else if let Some(n) = v.get("handshakesBurstTokens").and_then(|x| x.as_f64()) {
                rl.handshakes_burst = n;
            }
        }
        rl
    }
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
    try_acquire_per_ip_session_with_prefix(
        peer_ip,
        burst_limit,
        DEFAULT_HANDSHAKES_BURST_PER_PREFIX,
    )
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
    let entry = buckets.entry(key).or_insert_with(|| {
        (
            std::sync::Mutex::new((burst, Instant::now())),
            rate_per_sec,
            burst,
        )
    });
    let mut guard = entry.0.lock().unwrap_or_else(|e| e.into_inner());
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
pub fn try_acquire_stream_open(peer_ip: &str, rate: f64, burst: f64) -> bool {
    try_acquire_token(&STREAM_BUCKETS, peer_ip, rate, burst)
}

/// Try to acquire one token for datagram ingress from this IP. Returns false if rate limited.
pub fn try_acquire_datagram_ingress(peer_ip: &str, rate: f64, burst: f64) -> bool {
    try_acquire_token(&DGRAM_BUCKETS, peer_ip, rate, burst)
}

/// Try to acquire one token for a handshake from this IP. Returns false if rate limited.
pub fn try_acquire_handshake(peer_ip: &str, rate: f64, burst: f64) -> bool {
    try_acquire_token(&HANDSHAKE_BUCKETS, peer_ip, rate, burst)
}

/// Reset all rate limiter state. Only used for tests.
#[cfg(test)]
pub fn reset_all() {
    PER_IP_SESSIONS.clear();
    PER_PREFIX_SESSIONS.clear();
    HANDSHAKE_BUCKETS.clear();
    STREAM_BUCKETS.clear();
    DGRAM_BUCKETS.clear();
}

/// Remove stale entries from token buckets and zero-count session counters.
/// Call periodically (e.g. every 60s) to prevent unbounded memory growth.
pub fn cleanup_stale_entries(max_idle_secs: f64) {
    let now = Instant::now();
    let retain_bucket = |v: &BucketEntry| -> bool {
        let guard = v.0.lock().unwrap_or_else(|e| e.into_inner());
        now.duration_since(guard.1).as_secs_f64() < max_idle_secs
    };
    HANDSHAKE_BUCKETS.retain(|_, v| retain_bucket(v));
    STREAM_BUCKETS.retain(|_, v| retain_bucket(v));
    DGRAM_BUCKETS.retain(|_, v| retain_bucket(v));
    PER_IP_SESSIONS.retain(|_, v| v.load(Ordering::Relaxed) > 0);
    PER_PREFIX_SESSIONS.retain(|_, v| v.load(Ordering::Relaxed) > 0);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU32;

    static TEST_COUNTER: AtomicU32 = AtomicU32::new(100);

    fn unique_ip() -> String {
        let n = TEST_COUNTER.fetch_add(1, Ordering::SeqCst);
        format!("100.{}.{}.{}", (n >> 16) & 0xFF, (n >> 8) & 0xFF, n & 0xFF)
    }

    #[test]
    fn test_ip_to_prefix_v4() {
        assert_eq!(ip_to_prefix("192.168.1.42"), "192.168.1.0/24");
        assert_eq!(ip_to_prefix("10.0.0.1"), "10.0.0.0/24");
    }

    #[test]
    fn test_ip_to_prefix_v6() {
        let prefix = ip_to_prefix("2001:db8:85a3::8a2e:370:7334");
        assert_eq!(prefix, "2001:db8:85a3:0::/64");
    }

    #[test]
    fn test_per_ip_session_burst() {
        let ip = unique_ip();
        let limit = 3u64;
        for _ in 0..3 {
            assert!(try_acquire_per_ip_session(&ip, limit));
        }
        assert!(!try_acquire_per_ip_session(&ip, limit));
        release_per_ip_session(&ip);
        assert!(try_acquire_per_ip_session(&ip, limit));
    }

    #[test]
    fn test_per_prefix_burst() {
        let base = TEST_COUNTER.fetch_add(10, Ordering::SeqCst);
        let ip1 = format!("200.{}.0.1", base);
        let ip2 = format!("200.{}.0.2", base);
        let ip3 = format!("200.{}.0.3", base);
        let ip_burst = 100u64;
        let prefix_burst = 2u64;
        assert!(try_acquire_per_ip_session_with_prefix(
            &ip1,
            ip_burst,
            prefix_burst
        ));
        assert!(try_acquire_per_ip_session_with_prefix(
            &ip2,
            ip_burst,
            prefix_burst
        ));
        assert!(!try_acquire_per_ip_session_with_prefix(
            &ip3,
            ip_burst,
            prefix_burst
        ));
    }

    #[test]
    fn test_stream_token_bucket() {
        let ip = unique_ip();
        let rate = 10.0;
        let burst = 5.0;
        for _ in 0..5 {
            assert!(try_acquire_stream_open(&ip, rate, burst));
        }
        assert!(!try_acquire_stream_open(&ip, rate, burst));
    }

    #[test]
    fn test_datagram_token_bucket() {
        let ip = unique_ip();
        // Deterministic test: no refill during assertions.
        let rate = 0.0;
        let burst = 10.0;
        for _ in 0..10 {
            assert!(try_acquire_datagram_ingress(&ip, rate, burst));
        }
        assert!(!try_acquire_datagram_ingress(&ip, rate, burst));
    }

    #[test]
    fn test_different_ips_independent() {
        let ip_a = unique_ip();
        let ip_b = unique_ip();
        let limit = 2u64;
        assert!(try_acquire_per_ip_session(&ip_a, limit));
        assert!(try_acquire_per_ip_session(&ip_a, limit));
        assert!(!try_acquire_per_ip_session(&ip_a, limit));
        assert!(try_acquire_per_ip_session(&ip_b, limit));
    }

    #[test]
    fn test_cleanup_removes_zero_sessions() {
        let ip = unique_ip();
        let limit = 5u64;
        assert!(try_acquire_per_ip_session(&ip, limit));
        release_per_ip_session(&ip);
        cleanup_stale_entries(0.0);
        assert!(!PER_IP_SESSIONS.contains_key(&ip));
    }

    #[test]
    fn test_rate_limits_from_json() {
        let json = r#"{"handshakesBurst":50,"streamsPerSec":300,"streamsBurst":600,"datagramsPerSec":3000,"datagramsBurst":6000}"#;
        let rl = RateLimits::from_json(json);
        assert_eq!(rl.handshakes_burst_per_ip, 50);
        assert!((rl.handshakes_burst - 50.0).abs() < f64::EPSILON);
        assert!((rl.streams_per_sec - 300.0).abs() < f64::EPSILON);
        assert!((rl.streams_burst - 600.0).abs() < f64::EPSILON);
        assert!((rl.datagrams_per_sec - 3000.0).abs() < f64::EPSILON);
        assert!((rl.datagrams_burst - 6000.0).abs() < f64::EPSILON);
    }

    #[test]
    fn test_rate_limits_defaults() {
        let rl = RateLimits::from_json("{}");
        assert_eq!(rl.handshakes_burst_per_ip, 40);
        assert!((rl.streams_per_sec - 200.0).abs() < f64::EPSILON);
        assert!((rl.handshakes_per_sec - 20.0).abs() < f64::EPSILON);
        assert!((rl.handshakes_burst - 40.0).abs() < f64::EPSILON);
    }

    #[test]
    fn test_handshake_token_bucket() {
        let ip = unique_ip();
        let rate = 5.0;
        let burst = 3.0;
        for _ in 0..3 {
            assert!(try_acquire_handshake(&ip, rate, burst));
        }
        assert!(!try_acquire_handshake(&ip, rate, burst));
    }

    #[test]
    fn test_handshake_token_bucket_refill() {
        let ip = unique_ip();
        let rate = 1000.0;
        let burst = 1.0;
        assert!(try_acquire_handshake(&ip, rate, burst));
        assert!(!try_acquire_handshake(&ip, rate, burst));
        std::thread::sleep(std::time::Duration::from_millis(5));
        assert!(try_acquire_handshake(&ip, rate, burst));
    }

    #[test]
    fn test_handshakes_burst_public_api() {
        let json = r#"{"handshakesPerSec":50,"handshakesBurst":100}"#;
        let rl = RateLimits::from_json(json);
        assert!((rl.handshakes_per_sec - 50.0).abs() < f64::EPSILON);
        assert!((rl.handshakes_burst - 100.0).abs() < f64::EPSILON);
        assert_eq!(rl.handshakes_burst_per_ip, 100);
    }

    #[test]
    fn test_handshakes_burst_compat_fallback() {
        let json = r#"{"handshakesPerSec":50,"handshakesBurstTokens":80}"#;
        let rl = RateLimits::from_json(json);
        assert!((rl.handshakes_burst - 80.0).abs() < f64::EPSILON);
    }

    #[test]
    fn test_handshakes_burst_public_takes_precedence() {
        let json = r#"{"handshakesBurst":60,"handshakesBurstTokens":999}"#;
        let rl = RateLimits::from_json(json);
        assert!((rl.handshakes_burst - 60.0).abs() < f64::EPSILON);
    }
}
