//! Per-IP and per-prefix rate limiting for abuse resistance (P0-D, Phase 3).
//! P1-5: Stream-open and datagram ingress token buckets.

use dashmap::DashMap;
use once_cell::sync::Lazy;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

/// Rate-limit map key scoped to an owning server instance, so two
/// `ServerHandle`s in one process never share per-IP/per-prefix budgets (a
/// burst against one server must not throttle or exhaust the other's limits).
/// Keyed by `IpAddr` (Copy) so per-datagram lookups never allocate.
type ScopedKey = (u64, IpAddr);

static PER_IP_SESSIONS: Lazy<DashMap<ScopedKey, AtomicU64>> = Lazy::new(DashMap::new);
static PER_PREFIX_SESSIONS: Lazy<DashMap<ScopedKey, AtomicU64>> = Lazy::new(DashMap::new);

/// Token bucket entry: (mutex(tokens, last_refill), rate_per_sec, burst).
type BucketEntry = (std::sync::Mutex<(f64, Instant)>, f64, f64);

static HANDSHAKE_BUCKETS: Lazy<DashMap<ScopedKey, BucketEntry>> = Lazy::new(DashMap::new);
static STREAM_BUCKETS: Lazy<DashMap<ScopedKey, BucketEntry>> = Lazy::new(DashMap::new);
static DGRAM_BUCKETS: Lazy<DashMap<ScopedKey, BucketEntry>> = Lazy::new(DashMap::new);

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

/// Accept a rate/burst float only if it is finite and non-negative. NaN,
/// Infinity, and negatives from malformed config would otherwise silently
/// hard-block all traffic (NaN comparisons) or disable the limiter (Infinity);
/// fall back to the caller's current (default) value instead.
fn sane_rate(v: Option<f64>, current: f64) -> f64 {
    match v {
        Some(n) if n.is_finite() && n >= 0.0 => n,
        _ => current,
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
            rl.streams_per_sec = sane_rate(
                v.get("streamsPerSec").and_then(|x| x.as_f64()),
                rl.streams_per_sec,
            );
            rl.streams_burst = sane_rate(
                v.get("streamsBurst").and_then(|x| x.as_f64()),
                rl.streams_burst,
            );
            rl.datagrams_per_sec = sane_rate(
                v.get("datagramsPerSec").and_then(|x| x.as_f64()),
                rl.datagrams_per_sec,
            );
            rl.datagrams_burst = sane_rate(
                v.get("datagramsBurst").and_then(|x| x.as_f64()),
                rl.datagrams_burst,
            );
            rl.handshakes_per_sec = sane_rate(
                v.get("handshakesPerSec").and_then(|x| x.as_f64()),
                rl.handshakes_per_sec,
            );
            // Public API: handshakesBurst drives the token-bucket burst.
            // Compat: handshakesBurstTokens accepted as fallback.
            if v.get("handshakesBurst").is_some() {
                rl.handshakes_burst = sane_rate(
                    v.get("handshakesBurst").and_then(|x| x.as_f64()),
                    rl.handshakes_burst,
                );
            } else if v.get("handshakesBurstTokens").is_some() {
                rl.handshakes_burst = sane_rate(
                    v.get("handshakesBurstTokens").and_then(|x| x.as_f64()),
                    rl.handshakes_burst,
                );
            }
        }
        rl
    }
}

/// The /24 (IPv4) or /64 (IPv6) prefix as a masked address, allocation-free.
/// Prefixes live only as `PER_PREFIX_SESSIONS` keys (a separate map), so a
/// masked address can never collide with a literal peer address.
pub fn ip_prefix(peer_ip: IpAddr) -> IpAddr {
    match peer_ip {
        IpAddr::V4(a) => {
            let o = a.octets();
            IpAddr::V4(Ipv4Addr::new(o[0], o[1], o[2], 0))
        }
        IpAddr::V6(a) => {
            let s = a.segments();
            IpAddr::V6(Ipv6Addr::new(s[0], s[1], s[2], s[3], 0, 0, 0, 0))
        }
    }
}

/// Check if this IP (and its prefix) can accept a new session. Returns true if allowed.
/// Increments both per-IP and per-prefix counters; caller must call release_per_ip_session when session closes.
pub fn try_acquire_per_ip_session(server_id: u64, peer_ip: IpAddr, burst_limit: u64) -> bool {
    try_acquire_per_ip_session_with_prefix(
        server_id,
        peer_ip,
        burst_limit,
        DEFAULT_HANDSHAKES_BURST_PER_PREFIX,
    )
}

pub fn try_acquire_per_ip_session_with_prefix(
    server_id: u64,
    peer_ip: IpAddr,
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
    let prefix = ip_prefix(peer_ip);

    let ip_ok = PER_IP_SESSIONS
        .entry((server_id, peer_ip))
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
        .entry((server_id, prefix))
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
        release_per_ip_session_inner(server_id, peer_ip);
        return false;
    }
    true
}

fn release_per_ip_session_inner(server_id: u64, peer_ip: IpAddr) {
    let key = (server_id, peer_ip);
    if let Some(entry) = PER_IP_SESSIONS.get(&key) {
        let prev = entry
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| {
                Some(n.saturating_sub(1))
            })
            .unwrap_or(0);
        if prev <= 1 {
            drop(entry);
            // Only remove if still zero: a concurrent acquire may have
            // incremented between the decrement above and here — removing then
            // would drop a live counter (undercount = permissive limit).
            PER_IP_SESSIONS.remove_if(&key, |_, v| v.load(Ordering::SeqCst) == 0);
        }
    }
}

fn release_per_prefix_session_inner(server_id: u64, prefix: IpAddr) {
    let key = (server_id, prefix);
    if let Some(entry) = PER_PREFIX_SESSIONS.get(&key) {
        let prev = entry
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| {
                Some(n.saturating_sub(1))
            })
            .unwrap_or(0);
        if prev <= 1 {
            drop(entry);
            PER_PREFIX_SESSIONS.remove_if(&key, |_, v| v.load(Ordering::SeqCst) == 0);
        }
    }
}

/// Release a session for this IP. Call when session closes.
pub fn release_per_ip_session(server_id: u64, peer_ip: IpAddr) {
    let prefix = ip_prefix(peer_ip);
    release_per_ip_session_inner(server_id, peer_ip);
    release_per_prefix_session_inner(server_id, prefix);
}

fn try_acquire_token(
    buckets: &DashMap<ScopedKey, BucketEntry>,
    server_id: u64,
    peer_ip: IpAddr,
    rate_per_sec: f64,
    burst: f64,
) -> bool {
    let key = (server_id, peer_ip);
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
pub fn try_acquire_stream_open(server_id: u64, peer_ip: IpAddr, rate: f64, burst: f64) -> bool {
    try_acquire_token(&STREAM_BUCKETS, server_id, peer_ip, rate, burst)
}

/// Try to acquire one token for datagram ingress from this IP. Returns false if rate limited.
pub fn try_acquire_datagram_ingress(
    server_id: u64,
    peer_ip: IpAddr,
    rate: f64,
    burst: f64,
) -> bool {
    try_acquire_token(&DGRAM_BUCKETS, server_id, peer_ip, rate, burst)
}

/// Try to acquire one token for a handshake from this IP. Returns false if rate limited.
pub fn try_acquire_handshake(server_id: u64, peer_ip: IpAddr, rate: f64, burst: f64) -> bool {
    try_acquire_token(&HANDSHAKE_BUCKETS, server_id, peer_ip, rate, burst)
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
    PER_IP_SESSIONS.retain(|_, v| v.load(Ordering::SeqCst) > 0);
    PER_PREFIX_SESSIONS.retain(|_, v| v.load(Ordering::SeqCst) > 0);
}

/// Remove **all** rate-limiter entries owned by `server_id`.
/// Call when a server is closed so no stale entries linger in global maps.
pub fn cleanup_server_entries(server_id: u64) {
    PER_IP_SESSIONS.retain(|k, _| k.0 != server_id);
    PER_PREFIX_SESSIONS.retain(|k, _| k.0 != server_id);
    HANDSHAKE_BUCKETS.retain(|k, _| k.0 != server_id);
    STREAM_BUCKETS.retain(|k, _| k.0 != server_id);
    DGRAM_BUCKETS.retain(|k, _| k.0 != server_id);
}

/// Count all rate-limit entries still owned by one server instance.
/// The count is diagnostic-only; cleanup remains the authoritative close path.
pub fn owner_entry_count(server_id: u64) -> usize {
    PER_IP_SESSIONS
        .iter()
        .filter(|entry| entry.key().0 == server_id)
        .count()
        + PER_PREFIX_SESSIONS
            .iter()
            .filter(|entry| entry.key().0 == server_id)
            .count()
        + HANDSHAKE_BUCKETS
            .iter()
            .filter(|entry| entry.key().0 == server_id)
            .count()
        + STREAM_BUCKETS
            .iter()
            .filter(|entry| entry.key().0 == server_id)
            .count()
        + DGRAM_BUCKETS
            .iter()
            .filter(|entry| entry.key().0 == server_id)
            .count()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU32;

    static TEST_COUNTER: AtomicU32 = AtomicU32::new(100);

    fn unique_ip() -> IpAddr {
        let n = TEST_COUNTER.fetch_add(1, Ordering::SeqCst);
        IpAddr::V4(Ipv4Addr::new(
            100,
            ((n >> 16) & 0xFF) as u8,
            ((n >> 8) & 0xFF) as u8,
            (n & 0xFF) as u8,
        ))
    }

    #[test]
    fn test_ip_prefix_v4() {
        let ip: IpAddr = "192.168.1.42".parse().unwrap();
        assert_eq!(ip_prefix(ip), "192.168.1.0".parse::<IpAddr>().unwrap());
        let ip: IpAddr = "10.0.0.1".parse().unwrap();
        assert_eq!(ip_prefix(ip), "10.0.0.0".parse::<IpAddr>().unwrap());
    }

    #[test]
    fn test_ip_prefix_v6() {
        let ip: IpAddr = "2001:db8:85a3::8a2e:370:7334".parse().unwrap();
        assert_eq!(ip_prefix(ip), "2001:db8:85a3::".parse::<IpAddr>().unwrap());
    }

    #[test]
    fn test_per_ip_session_burst() {
        let ip = unique_ip();
        let limit = 3u64;
        for _ in 0..3 {
            assert!(try_acquire_per_ip_session(1, ip, limit));
        }
        assert!(!try_acquire_per_ip_session(1, ip, limit));
        release_per_ip_session(1, ip);
        assert!(try_acquire_per_ip_session(1, ip, limit));
    }

    #[test]
    fn test_per_prefix_burst() {
        let base = (TEST_COUNTER.fetch_add(10, Ordering::SeqCst) & 0xFF) as u8;
        let ip1 = IpAddr::V4(Ipv4Addr::new(200, base, 0, 1));
        let ip2 = IpAddr::V4(Ipv4Addr::new(200, base, 0, 2));
        let ip3 = IpAddr::V4(Ipv4Addr::new(200, base, 0, 3));
        let ip_burst = 100u64;
        let prefix_burst = 2u64;
        assert!(try_acquire_per_ip_session_with_prefix(
            1,
            ip1,
            ip_burst,
            prefix_burst
        ));
        assert!(try_acquire_per_ip_session_with_prefix(
            1,
            ip2,
            ip_burst,
            prefix_burst
        ));
        assert!(!try_acquire_per_ip_session_with_prefix(
            1,
            ip3,
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
            assert!(try_acquire_stream_open(1, ip, rate, burst));
        }
        assert!(!try_acquire_stream_open(1, ip, rate, burst));
    }

    #[test]
    fn test_datagram_token_bucket() {
        let ip = unique_ip();
        // Deterministic test: no refill during assertions.
        let rate = 0.0;
        let burst = 10.0;
        for _ in 0..10 {
            assert!(try_acquire_datagram_ingress(1, ip, rate, burst));
        }
        assert!(!try_acquire_datagram_ingress(1, ip, rate, burst));
    }

    #[test]
    fn test_different_ips_independent() {
        let ip_a = unique_ip();
        let ip_b = unique_ip();
        let limit = 2u64;
        assert!(try_acquire_per_ip_session(1, ip_a, limit));
        assert!(try_acquire_per_ip_session(1, ip_a, limit));
        assert!(!try_acquire_per_ip_session(1, ip_a, limit));
        assert!(try_acquire_per_ip_session(1, ip_b, limit));
    }

    // Two ServerHandles (distinct server_id) must not share per-IP budgets: a
    // burst exhausting one server's limit for an IP must leave the other's
    // budget for the same IP fully intact (no cross-server DoS amplification).
    #[test]
    fn test_per_server_isolation() {
        let ip = unique_ip();
        let limit = 2u64;
        let server_a = 7000;
        let server_b = 7001;
        // Exhaust server A's per-IP session budget for this IP.
        assert!(try_acquire_per_ip_session(server_a, ip, limit));
        assert!(try_acquire_per_ip_session(server_a, ip, limit));
        assert!(!try_acquire_per_ip_session(server_a, ip, limit));
        // Server B's budget for the same IP is untouched.
        assert!(try_acquire_per_ip_session(server_b, ip, limit));
        assert!(try_acquire_per_ip_session(server_b, ip, limit));
        assert!(!try_acquire_per_ip_session(server_b, ip, limit));

        // Token buckets are likewise isolated.
        let rate = 0.0;
        let burst = 1.0;
        assert!(try_acquire_stream_open(server_a, ip, rate, burst));
        assert!(!try_acquire_stream_open(server_a, ip, rate, burst));
        assert!(try_acquire_stream_open(server_b, ip, rate, burst));
    }

    // Malformed rate/burst floats (NaN/Infinity/negative) must not slip into the
    // limiter (NaN would hard-block all traffic, Infinity would disable it).
    #[test]
    fn test_rate_limit_float_sanitization() {
        let d = RateLimits::default();
        let nan = RateLimits::from_json(r#"{"streamsPerSec": null, "streamsBurst": -5}"#);
        assert_eq!(nan.streams_burst, d.streams_burst); // negative rejected
        let bad =
            RateLimits::from_json(r#"{"datagramsPerSec": "not-a-number", "handshakesPerSec": -1}"#);
        assert_eq!(bad.datagrams_per_sec, d.datagrams_per_sec); // non-numeric rejected
        assert_eq!(bad.handshakes_per_sec, d.handshakes_per_sec); // negative rejected
        let ok = RateLimits::from_json(r#"{"streamsPerSec": 123.0}"#);
        assert_eq!(ok.streams_per_sec, 123.0); // finite non-negative accepted
    }

    #[test]
    fn test_cleanup_removes_zero_sessions() {
        let ip = unique_ip();
        let limit = 5u64;
        assert!(try_acquire_per_ip_session(1, ip, limit));
        release_per_ip_session(1, ip);
        // Keep bucket entries intact to avoid interfering with other tests that
        // share global token-bucket state and run in parallel.
        cleanup_stale_entries(f64::MAX);
        assert!(!PER_IP_SESSIONS.contains_key(&(1, ip)));
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
            assert!(try_acquire_handshake(1, ip, rate, burst));
        }
        assert!(!try_acquire_handshake(1, ip, rate, burst));
    }

    #[test]
    fn test_handshake_token_bucket_refill() {
        let ip = unique_ip();
        let rate = 1000.0;
        let burst = 1.0;
        assert!(try_acquire_handshake(1, ip, rate, burst));
        assert!(!try_acquire_handshake(1, ip, rate, burst));
        std::thread::sleep(std::time::Duration::from_millis(5));
        assert!(try_acquire_handshake(1, ip, rate, burst));
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

    #[test]
    fn test_cleanup_server_entries_removes_all() {
        let ip = unique_ip();
        let sid_a: u64 = 9000;
        let sid_b: u64 = 9001;

        // Populate all 5 maps for server 9000.
        assert!(try_acquire_per_ip_session(sid_a, ip, 100));
        assert!(try_acquire_handshake(sid_a, ip, 10.0, 10.0));
        assert!(try_acquire_stream_open(sid_a, ip, 10.0, 10.0));
        assert!(try_acquire_datagram_ingress(sid_a, ip, 10.0, 10.0));

        // Populate server 9001 to prove isolation.
        assert!(try_acquire_per_ip_session(sid_b, ip, 100));

        // Cleanup server 9000.
        cleanup_server_entries(sid_a);

        // All 9000 entries must be gone.
        assert!(!PER_IP_SESSIONS.contains_key(&(sid_a, ip)));
        let prefix = ip_prefix(ip);
        assert!(!PER_PREFIX_SESSIONS.contains_key(&(sid_a, prefix)));
        assert!(!HANDSHAKE_BUCKETS.contains_key(&(sid_a, ip)));
        assert!(!STREAM_BUCKETS.contains_key(&(sid_a, ip)));
        assert!(!DGRAM_BUCKETS.contains_key(&(sid_a, ip)));

        // 9001 entry must still be present.
        assert!(PER_IP_SESSIONS.contains_key(&(sid_b, ip)));
    }
}
