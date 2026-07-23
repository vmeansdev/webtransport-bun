use std::cell::RefCell;
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::rc::Rc;

use web_time::{Duration, Instant};

const HOST_TIMER_MAX_MS: u64 = i32::MAX as u64;
const RATE_LIMIT_FP_SCALE: u128 = 1_000_000;
const MIN_RATE_LIMIT_BUCKET_CAP: usize = 64;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WasmLimits {
    pub max_sessions: usize,
    pub max_handshakes_in_flight: usize,
    pub max_streams_per_session_bidi: usize,
    pub max_streams_per_session_uni: usize,
    pub max_streams_global: usize,
    pub max_datagram_size: usize,
    pub max_queued_bytes_global: usize,
    pub max_queued_bytes_per_session: usize,
    pub max_queued_bytes_per_stream: usize,
    pub backpressure_timeout_ms: u64,
    pub handshake_timeout_ms: u64,
    pub idle_timeout_ms: u64,
}

impl Default for WasmLimits {
    fn default() -> Self {
        Self {
            max_sessions: 2000,
            max_handshakes_in_flight: 200,
            max_streams_per_session_bidi: 200,
            max_streams_per_session_uni: 200,
            max_streams_global: 50_000,
            max_datagram_size: 1200,
            max_queued_bytes_global: 512 * 1024 * 1024,
            max_queued_bytes_per_session: 2 * 1024 * 1024,
            max_queued_bytes_per_stream: 256 * 1024,
            backpressure_timeout_ms: 5_000,
            handshake_timeout_ms: 10_000,
            idle_timeout_ms: 60_000,
        }
    }
}

impl WasmLimits {
    pub fn validate(&self) -> Result<(), String> {
        let positive_usize = [
            ("maxSessions", self.max_sessions),
            ("maxHandshakesInFlight", self.max_handshakes_in_flight),
            (
                "maxStreamsPerSessionBidi",
                self.max_streams_per_session_bidi,
            ),
            ("maxStreamsPerSessionUni", self.max_streams_per_session_uni),
            ("maxStreamsGlobal", self.max_streams_global),
            ("maxDatagramSize", self.max_datagram_size),
            ("maxQueuedBytesGlobal", self.max_queued_bytes_global),
            (
                "maxQueuedBytesPerSession",
                self.max_queued_bytes_per_session,
            ),
            ("maxQueuedBytesPerStream", self.max_queued_bytes_per_stream),
        ];
        for (name, value) in positive_usize {
            if value == 0 {
                return Err(format!("E_INTERNAL: {name} must be a positive integer"));
            }
        }
        let positive_u64 = [
            ("backpressureTimeoutMs", self.backpressure_timeout_ms),
            ("handshakeTimeoutMs", self.handshake_timeout_ms),
            ("idleTimeoutMs", self.idle_timeout_ms),
        ];
        for (name, value) in positive_u64 {
            if value == 0 {
                return Err(format!("E_INTERNAL: {name} must be a positive integer"));
            }
            if value > HOST_TIMER_MAX_MS {
                return Err(format!(
                    "E_INTERNAL: {name} exceeds the supported host timer range"
                ));
            }
        }
        if self.max_queued_bytes_per_stream > self.max_queued_bytes_per_session {
            return Err(
                "E_INTERNAL: maxQueuedBytesPerStream must be <= maxQueuedBytesPerSession"
                    .to_string(),
            );
        }
        if self.max_queued_bytes_per_session > self.max_queued_bytes_global {
            return Err(
                "E_INTERNAL: maxQueuedBytesPerSession must be <= maxQueuedBytesGlobal".to_string(),
            );
        }
        if self.max_streams_per_session_bidi > self.max_streams_global {
            return Err(
                "E_INTERNAL: maxStreamsPerSessionBidi must be <= maxStreamsGlobal".to_string(),
            );
        }
        if self.max_streams_per_session_uni > self.max_streams_global {
            return Err(
                "E_INTERNAL: maxStreamsPerSessionUni must be <= maxStreamsGlobal".to_string(),
            );
        }
        if self.handshake_timeout_ms > self.idle_timeout_ms {
            return Err("E_INTERNAL: handshakeTimeoutMs must be <= idleTimeoutMs".to_string());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WasmRateLimits {
    pub handshakes_per_sec: u32,
    pub handshakes_burst: u32,
    pub stream_opens_per_sec: u32,
    pub stream_opens_burst: u32,
    pub datagrams_ingress_per_sec: u32,
    pub datagrams_ingress_burst: u32,
}

impl Default for WasmRateLimits {
    fn default() -> Self {
        Self {
            handshakes_per_sec: 20,
            handshakes_burst: 40,
            stream_opens_per_sec: 200,
            stream_opens_burst: 400,
            datagrams_ingress_per_sec: 2000,
            datagrams_ingress_burst: 5000,
        }
    }
}

impl WasmRateLimits {
    pub fn validate(&self) -> Result<(), String> {
        let positive = [
            ("rateLimits.handshakesPerSec", self.handshakes_per_sec),
            ("rateLimits.handshakesBurst", self.handshakes_burst),
            ("rateLimits.streamOpensPerSec", self.stream_opens_per_sec),
            ("rateLimits.streamOpensBurst", self.stream_opens_burst),
            (
                "rateLimits.datagramsIngressPerSec",
                self.datagrams_ingress_per_sec,
            ),
            (
                "rateLimits.datagramsIngressBurst",
                self.datagrams_ingress_burst,
            ),
        ];
        for (name, value) in positive {
            if value == 0 {
                return Err(format!("E_INTERNAL: {name} must be a positive integer"));
            }
        }
        if self.handshakes_burst < self.handshakes_per_sec {
            return Err(
                "E_INTERNAL: rateLimits.handshakesBurst must be >= rateLimits.handshakesPerSec"
                    .to_string(),
            );
        }
        if self.stream_opens_burst < self.stream_opens_per_sec {
            return Err(
                "E_INTERNAL: rateLimits.streamOpensBurst must be >= rateLimits.streamOpensPerSec"
                    .to_string(),
            );
        }
        if self.datagrams_ingress_burst < self.datagrams_ingress_per_sec {
            return Err(
                "E_INTERNAL: rateLimits.datagramsIngressBurst must be >= rateLimits.datagramsIngressPerSec"
                    .to_string(),
            );
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum RateLimitDimension {
    Handshake,
    StreamOpen,
    DatagramIngress,
}

impl RateLimitDimension {
    fn error_label(self) -> &'static str {
        match self {
            Self::Handshake => "handshakes",
            Self::StreamOpen => "streamOpens",
            Self::DatagramIngress => "datagramsIngress",
        }
    }

    fn bucket_config(self, limits: &WasmRateLimits) -> TokenBucketConfig {
        match self {
            Self::Handshake => TokenBucketConfig {
                rate_per_sec: limits.handshakes_per_sec,
                burst: limits.handshakes_burst,
            },
            Self::StreamOpen => TokenBucketConfig {
                rate_per_sec: limits.stream_opens_per_sec,
                burst: limits.stream_opens_burst,
            },
            Self::DatagramIngress => TokenBucketConfig {
                rate_per_sec: limits.datagrams_ingress_per_sec,
                burst: limits.datagrams_ingress_burst,
            },
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RateLimitSnapshot {
    pub bucket_count: usize,
    pub rate_limited_handshake_count: u64,
    pub rate_limited_stream_open_count: u64,
    pub rate_limited_datagram_ingress_count: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
struct PeerKey(IpAddr);

impl PeerKey {
    fn from_socket_addr(addr: SocketAddr) -> Self {
        match addr.ip() {
            IpAddr::V4(ip) => Self(IpAddr::V4(ip)),
            IpAddr::V6(ip) => match ip.to_ipv4_mapped() {
                Some(mapped) => Self(IpAddr::V4(mapped)),
                None => Self(IpAddr::V6(ip)),
            },
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct TokenBucketConfig {
    rate_per_sec: u32,
    burst: u32,
}

#[derive(Clone, Debug)]
struct TokenBucketState {
    tokens_fp: u128,
    last_refill: Instant,
}

impl TokenBucketState {
    fn new(now: Instant, config: TokenBucketConfig) -> Self {
        Self {
            tokens_fp: u128::from(config.burst) * RATE_LIMIT_FP_SCALE,
            last_refill: now,
        }
    }

    fn try_consume(&mut self, now: Instant, config: TokenBucketConfig) -> bool {
        self.refill(now, config);
        if self.tokens_fp < RATE_LIMIT_FP_SCALE {
            return false;
        }
        self.tokens_fp -= RATE_LIMIT_FP_SCALE;
        true
    }

    fn refill(&mut self, now: Instant, config: TokenBucketConfig) {
        let elapsed = now
            .checked_duration_since(self.last_refill)
            .unwrap_or_default();
        if elapsed.is_zero() {
            return;
        }
        let elapsed_nanos = elapsed.as_nanos();
        let refill_fp = elapsed_nanos
            .saturating_mul(u128::from(config.rate_per_sec))
            .saturating_mul(RATE_LIMIT_FP_SCALE)
            / 1_000_000_000;
        if refill_fp == 0 {
            return;
        }
        let max_tokens = u128::from(config.burst) * RATE_LIMIT_FP_SCALE;
        self.tokens_fp = self.tokens_fp.saturating_add(refill_fp).min(max_tokens);
        self.last_refill = now;
    }
}

#[derive(Clone, Debug)]
struct PeerBucket {
    handshakes: TokenBucketState,
    stream_opens: TokenBucketState,
    datagrams_ingress: TokenBucketState,
    owner_count: usize,
    last_touched: Instant,
}

impl PeerBucket {
    fn new(now: Instant, rate_limits: &WasmRateLimits) -> Self {
        Self {
            handshakes: TokenBucketState::new(
                now,
                RateLimitDimension::Handshake.bucket_config(rate_limits),
            ),
            stream_opens: TokenBucketState::new(
                now,
                RateLimitDimension::StreamOpen.bucket_config(rate_limits),
            ),
            datagrams_ingress: TokenBucketState::new(
                now,
                RateLimitDimension::DatagramIngress.bucket_config(rate_limits),
            ),
            owner_count: 0,
            last_touched: now,
        }
    }

    fn bucket_mut(&mut self, dimension: RateLimitDimension) -> &mut TokenBucketState {
        match dimension {
            RateLimitDimension::Handshake => &mut self.handshakes,
            RateLimitDimension::StreamOpen => &mut self.stream_opens,
            RateLimitDimension::DatagramIngress => &mut self.datagrams_ingress,
        }
    }
}

#[derive(Debug)]
pub struct PeerRateLimiter {
    rate_limits: WasmRateLimits,
    idle_ttl: Duration,
    max_buckets: usize,
    buckets: HashMap<PeerKey, PeerBucket>,
    connection_owners: HashMap<u32, PeerKey>,
    rate_limited_handshake_count: u64,
    rate_limited_stream_open_count: u64,
    rate_limited_datagram_ingress_count: u64,
}

impl PeerRateLimiter {
    pub fn new(rate_limits: WasmRateLimits, limits: &WasmLimits) -> Result<Self, String> {
        limits.validate()?;
        rate_limits.validate()?;
        Ok(Self {
            rate_limits,
            idle_ttl: Duration::from_millis(limits.idle_timeout_ms),
            max_buckets: Self::bucket_cap(limits),
            buckets: HashMap::new(),
            connection_owners: HashMap::new(),
            rate_limited_handshake_count: 0,
            rate_limited_stream_open_count: 0,
            rate_limited_datagram_ingress_count: 0,
        })
    }

    pub fn check(
        &mut self,
        now: Instant,
        source: SocketAddr,
        dimension: RateLimitDimension,
    ) -> Result<(), String> {
        self.check_peer(now, PeerKey::from_socket_addr(source), dimension)
    }

    pub fn check_connection(
        &mut self,
        now: Instant,
        conn: u32,
        dimension: RateLimitDimension,
    ) -> Result<(), String> {
        let Some(peer) = self.connection_owners.get(&conn).copied() else {
            return Err(format!(
                "E_INTERNAL: missing peer ownership for {} rate limiting",
                dimension.error_label()
            ));
        };
        self.check_peer(now, peer, dimension)
    }

    pub fn attach_connection(
        &mut self,
        conn: u32,
        source: SocketAddr,
        now: Instant,
    ) -> Result<(), String> {
        if let Some(previous) = self.connection_owners.remove(&conn) {
            self.decrement_owner(previous, now);
        }
        let peer = PeerKey::from_socket_addr(source);
        let bucket = self.ensure_bucket(now, peer, RateLimitDimension::Handshake)?;
        bucket.owner_count = bucket.owner_count.saturating_add(1);
        bucket.last_touched = now;
        self.connection_owners.insert(conn, peer);
        Ok(())
    }

    pub fn release_connection(&mut self, conn: u32, now: Instant) {
        if let Some(peer) = self.connection_owners.remove(&conn) {
            self.decrement_owner(peer, now);
        }
    }

    pub fn snapshot(&self) -> RateLimitSnapshot {
        RateLimitSnapshot {
            bucket_count: self.buckets.len(),
            rate_limited_handshake_count: self.rate_limited_handshake_count,
            rate_limited_stream_open_count: self.rate_limited_stream_open_count,
            rate_limited_datagram_ingress_count: self.rate_limited_datagram_ingress_count,
        }
    }

    pub fn clear(&mut self) {
        self.buckets.clear();
        self.connection_owners.clear();
    }

    fn bucket_cap(limits: &WasmLimits) -> usize {
        limits
            .max_sessions
            .saturating_mul(2)
            .max(limits.max_handshakes_in_flight.saturating_mul(2))
            .max(MIN_RATE_LIMIT_BUCKET_CAP)
    }

    fn check_peer(
        &mut self,
        now: Instant,
        peer: PeerKey,
        dimension: RateLimitDimension,
    ) -> Result<(), String> {
        let config = dimension.bucket_config(&self.rate_limits);
        let bucket = self.ensure_bucket(now, peer, dimension)?;
        bucket.last_touched = now;
        if bucket.bucket_mut(dimension).try_consume(now, config) {
            return Ok(());
        }
        self.bump_counter(dimension);
        Err(format!(
            "E_RATE_LIMITED: {} rate limit reached",
            dimension.error_label()
        ))
    }

    fn ensure_bucket(
        &mut self,
        now: Instant,
        peer: PeerKey,
        dimension: RateLimitDimension,
    ) -> Result<&mut PeerBucket, String> {
        self.evict_idle_zero_owner(now);
        if !self.buckets.contains_key(&peer) && self.buckets.len() >= self.max_buckets {
            self.bump_counter(dimension);
            return Err("E_RATE_LIMITED: peer rate limit bucket capacity reached".to_string());
        }
        Ok(self
            .buckets
            .entry(peer)
            .or_insert_with(|| PeerBucket::new(now, &self.rate_limits)))
    }

    fn decrement_owner(&mut self, peer: PeerKey, now: Instant) {
        if let Some(bucket) = self.buckets.get_mut(&peer) {
            bucket.owner_count = bucket.owner_count.saturating_sub(1);
            bucket.last_touched = now;
        }
        self.evict_idle_zero_owner(now);
    }

    fn evict_idle_zero_owner(&mut self, now: Instant) {
        let idle_ttl = self.idle_ttl;
        self.buckets.retain(|_, bucket| {
            bucket.owner_count > 0
                || now
                    .checked_duration_since(bucket.last_touched)
                    .unwrap_or_default()
                    < idle_ttl
        });
    }

    fn bump_counter(&mut self, dimension: RateLimitDimension) {
        match dimension {
            RateLimitDimension::Handshake => {
                self.rate_limited_handshake_count =
                    self.rate_limited_handshake_count.saturating_add(1);
            }
            RateLimitDimension::StreamOpen => {
                self.rate_limited_stream_open_count =
                    self.rate_limited_stream_open_count.saturating_add(1);
            }
            RateLimitDimension::DatagramIngress => {
                self.rate_limited_datagram_ingress_count =
                    self.rate_limited_datagram_ingress_count.saturating_add(1);
            }
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StreamKind {
    Bidi,
    Uni,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct GovernorSnapshot {
    pub sessions_active: usize,
    pub handshakes_in_flight: usize,
    pub streams_active_global: usize,
    pub queued_bytes_global: usize,
    pub queued_bytes_for_session: usize,
    pub queued_bytes_for_stream: usize,
    pub host_tokens_active: usize,
}

#[derive(Clone)]
pub struct Governor {
    inner: Rc<RefCell<GovernorInner>>,
}

pub struct Reservation {
    inner: Option<Rc<RefCell<GovernorInner>>>,
    kind: Option<ReservationKind>,
}

#[derive(Clone, Debug)]
struct HostToken {
    kind: ReservationKind,
}

#[derive(Clone, Debug)]
enum ReservationKind {
    Handshake,
    Session {
        conn: u32,
    },
    Stream {
        conn: u32,
        kind: StreamKind,
    },
    QueuedBytes {
        conn: u32,
        stream: Option<u32>,
        bytes: usize,
    },
}

#[derive(Debug)]
struct GovernorInner {
    limits: WasmLimits,
    sessions_active: usize,
    handshakes_in_flight: usize,
    streams_active_global: usize,
    streams_bidi_per_session: HashMap<u32, usize>,
    streams_uni_per_session: HashMap<u32, usize>,
    queued_bytes_global: usize,
    queued_bytes_per_session: HashMap<u32, usize>,
    queued_bytes_per_stream: HashMap<(u32, u32), usize>,
    next_host_token: u32,
    host_token_ceiling: u32,
    host_tokens: HashMap<u32, HostToken>,
}

impl Governor {
    pub fn new(limits: WasmLimits) -> Result<Self, String> {
        limits.validate()?;
        Ok(Self {
            inner: Rc::new(RefCell::new(GovernorInner {
                limits,
                sessions_active: 0,
                handshakes_in_flight: 0,
                streams_active_global: 0,
                streams_bidi_per_session: HashMap::new(),
                streams_uni_per_session: HashMap::new(),
                queued_bytes_global: 0,
                queued_bytes_per_session: HashMap::new(),
                queued_bytes_per_stream: HashMap::new(),
                next_host_token: 1,
                host_token_ceiling: u32::MAX,
                host_tokens: HashMap::new(),
            })),
        })
    }

    pub fn limits(&self) -> WasmLimits {
        self.inner.borrow().limits.clone()
    }

    pub fn reserve_handshake(&self) -> Result<Reservation, String> {
        let mut inner = self.inner.borrow_mut();
        if inner.handshakes_in_flight >= inner.limits.max_handshakes_in_flight {
            return Err("E_LIMIT_EXCEEDED: maxHandshakesInFlight reached".to_string());
        }
        inner.handshakes_in_flight += 1;
        Ok(Reservation::new(
            self.inner.clone(),
            ReservationKind::Handshake,
        ))
    }

    pub fn reserve_session(&self, conn: u32) -> Result<Reservation, String> {
        let mut inner = self.inner.borrow_mut();
        if inner.sessions_active >= inner.limits.max_sessions {
            return Err("E_LIMIT_EXCEEDED: maxSessions reached".to_string());
        }
        inner.sessions_active += 1;
        Ok(Reservation::new(
            self.inner.clone(),
            ReservationKind::Session { conn },
        ))
    }

    pub fn reserve_stream(
        &self,
        conn: u32,
        _stream: u32,
        kind: StreamKind,
    ) -> Result<Reservation, String> {
        let mut inner = self.inner.borrow_mut();
        if inner.streams_active_global >= inner.limits.max_streams_global {
            return Err("E_LIMIT_EXCEEDED: maxStreamsGlobal reached".to_string());
        }
        let per_session_limit = match kind {
            StreamKind::Bidi => inner.limits.max_streams_per_session_bidi,
            StreamKind::Uni => inner.limits.max_streams_per_session_uni,
        };
        let map = match kind {
            StreamKind::Bidi => &mut inner.streams_bidi_per_session,
            StreamKind::Uni => &mut inner.streams_uni_per_session,
        };
        let per_session = map.get(&conn).copied().unwrap_or(0);
        if per_session >= per_session_limit {
            let name = match kind {
                StreamKind::Bidi => "maxStreamsPerSessionBidi",
                StreamKind::Uni => "maxStreamsPerSessionUni",
            };
            return Err(format!("E_LIMIT_EXCEEDED: {name} reached"));
        }
        map.insert(conn, per_session + 1);
        inner.streams_active_global += 1;
        Ok(Reservation::new(
            self.inner.clone(),
            ReservationKind::Stream { conn, kind },
        ))
    }

    pub fn reserve_event_bytes(
        &self,
        conn: u32,
        stream: Option<u32>,
        bytes: usize,
    ) -> Result<Reservation, String> {
        let mut inner = self.inner.borrow_mut();
        let next_global = inner
            .queued_bytes_global
            .checked_add(bytes)
            .ok_or_else(|| "E_QUEUE_FULL: queued byte counter overflow".to_string())?;
        if next_global > inner.limits.max_queued_bytes_global {
            return Err("E_QUEUE_FULL: maxQueuedBytesGlobal reached".to_string());
        }
        let session_current = inner
            .queued_bytes_per_session
            .get(&conn)
            .copied()
            .unwrap_or(0);
        let next_session = session_current
            .checked_add(bytes)
            .ok_or_else(|| "E_QUEUE_FULL: session queued byte counter overflow".to_string())?;
        if next_session > inner.limits.max_queued_bytes_per_session {
            return Err("E_QUEUE_FULL: maxQueuedBytesPerSession reached".to_string());
        }
        if let Some(stream_id) = stream {
            let key = (conn, stream_id);
            let stream_current = inner
                .queued_bytes_per_stream
                .get(&key)
                .copied()
                .unwrap_or(0);
            let next_stream = stream_current
                .checked_add(bytes)
                .ok_or_else(|| "E_QUEUE_FULL: stream queued byte counter overflow".to_string())?;
            if next_stream > inner.limits.max_queued_bytes_per_stream {
                return Err("E_QUEUE_FULL: maxQueuedBytesPerStream reached".to_string());
            }
            inner.queued_bytes_per_stream.insert(key, next_stream);
        }
        inner.queued_bytes_global = next_global;
        inner.queued_bytes_per_session.insert(conn, next_session);
        Ok(Reservation::new(
            self.inner.clone(),
            ReservationKind::QueuedBytes {
                conn,
                stream,
                bytes,
            },
        ))
    }

    /// Remaining reliable-event capacity for one connection/stream. Callers
    /// use this before consuming QUIC stream bytes so a full host queue applies
    /// backpressure instead of forcing `reserve_event_bytes` to drop data.
    pub fn available_event_bytes(&self, conn: u32, stream: Option<u32>) -> usize {
        let inner = self.inner.borrow();
        let global = inner
            .limits
            .max_queued_bytes_global
            .saturating_sub(inner.queued_bytes_global);
        let session = inner.limits.max_queued_bytes_per_session.saturating_sub(
            inner
                .queued_bytes_per_session
                .get(&conn)
                .copied()
                .unwrap_or(0),
        );
        let stream = stream.map_or(usize::MAX, |stream| {
            inner.limits.max_queued_bytes_per_stream.saturating_sub(
                inner
                    .queued_bytes_per_stream
                    .get(&(conn, stream))
                    .copied()
                    .unwrap_or(0),
            )
        });
        global.min(session).min(stream)
    }

    pub fn transfer_to_host(&self, mut reservation: Reservation) -> Result<u32, String> {
        let Some(kind) = reservation.kind.take() else {
            return Err("E_INTERNAL: reservation already consumed".to_string());
        };
        let Some(inner_rc) = reservation.inner.take() else {
            return Err("E_INTERNAL: reservation missing governor".to_string());
        };
        match kind {
            ReservationKind::QueuedBytes { .. } => {
                let mut inner = inner_rc.borrow_mut();
                let token = match Self::allocate_host_token(&mut inner) {
                    Ok(token) => token,
                    Err(error) => {
                        GovernorInner::release_kind(&mut inner, &kind);
                        return Err(error);
                    }
                };
                inner.host_tokens.insert(token, HostToken { kind });
                Ok(token)
            }
            other => {
                drop(Reservation {
                    inner: Some(inner_rc),
                    kind: Some(other),
                });
                Err("E_INTERNAL: only queued-byte reservations can transfer to host".to_string())
            }
        }
    }

    pub fn release_host_token(&self, token: u32) -> bool {
        self.release_host_token_with_context(token).is_some()
    }

    /// Release a host token and return the queue it freed so the endpoint can
    /// resume any reliable streams parked behind that capacity.
    pub(crate) fn release_host_token_with_context(&self, token: u32) -> Option<(u32, Option<u32>)> {
        let host = self.inner.borrow_mut().host_tokens.remove(&token)?;
        let context = match &host.kind {
            ReservationKind::QueuedBytes { conn, stream, .. } => Some((*conn, *stream)),
            _ => None,
        };
        GovernorInner::release_kind(&mut self.inner.borrow_mut(), &host.kind);
        context
    }

    /// Release every payload reservation currently owned by the JS host.
    /// Endpoint teardown uses this as a last-resort safety net after the host
    /// has released its individual leases. Returning the count makes repeated
    /// close/churn behavior directly verifiable.
    pub fn release_all_host_tokens(&self) -> usize {
        let mut inner = self.inner.borrow_mut();
        let hosts = std::mem::take(&mut inner.host_tokens);
        let count = hosts.len();
        for host in hosts.values() {
            GovernorInner::release_kind(&mut inner, &host.kind);
        }
        count
    }

    fn allocate_host_token(inner: &mut GovernorInner) -> Result<u32, String> {
        let ceiling = inner.host_token_ceiling.max(1);
        let start = inner.next_host_token.clamp(1, ceiling);
        let mut candidate = start;
        loop {
            if !inner.host_tokens.contains_key(&candidate) {
                inner.next_host_token = if candidate >= ceiling {
                    1
                } else {
                    candidate + 1
                };
                return Ok(candidate);
            }
            candidate = if candidate >= ceiling {
                1
            } else {
                candidate + 1
            };
            if candidate == start {
                return Err("E_LIMIT_EXCEEDED: host reservation token space exhausted".to_string());
            }
        }
    }

    #[cfg(test)]
    pub(crate) fn set_host_token_ceiling_for_test(&self, ceiling: u32) {
        let mut inner = self.inner.borrow_mut();
        inner.host_token_ceiling = ceiling.max(1);
        inner.next_host_token = inner.next_host_token.clamp(1, inner.host_token_ceiling);
    }

    pub fn snapshot(&self, conn: u32, stream: Option<u32>) -> GovernorSnapshot {
        let inner = self.inner.borrow();
        GovernorSnapshot {
            sessions_active: inner.sessions_active,
            handshakes_in_flight: inner.handshakes_in_flight,
            streams_active_global: inner.streams_active_global,
            queued_bytes_global: inner.queued_bytes_global,
            queued_bytes_for_session: inner
                .queued_bytes_per_session
                .get(&conn)
                .copied()
                .unwrap_or(0),
            queued_bytes_for_stream: stream
                .and_then(|stream_id| {
                    inner
                        .queued_bytes_per_stream
                        .get(&(conn, stream_id))
                        .copied()
                })
                .unwrap_or(0),
            host_tokens_active: inner.host_tokens.len(),
        }
    }
}

impl GovernorInner {
    fn release_kind(&mut self, kind: &ReservationKind) {
        match kind {
            ReservationKind::Handshake => {
                self.handshakes_in_flight = self.handshakes_in_flight.saturating_sub(1);
            }
            ReservationKind::Session { conn } => {
                let _ = conn;
                self.sessions_active = self.sessions_active.saturating_sub(1);
            }
            ReservationKind::Stream { conn, kind, .. } => {
                self.streams_active_global = self.streams_active_global.saturating_sub(1);
                let map = match kind {
                    StreamKind::Bidi => &mut self.streams_bidi_per_session,
                    StreamKind::Uni => &mut self.streams_uni_per_session,
                };
                Self::decrement_map(map, *conn);
            }
            ReservationKind::QueuedBytes {
                conn,
                stream,
                bytes,
            } => {
                self.queued_bytes_global = self.queued_bytes_global.saturating_sub(*bytes);
                Self::decrement_bytes_map(&mut self.queued_bytes_per_session, *conn, *bytes);
                if let Some(stream_id) = stream {
                    Self::decrement_bytes_map(
                        &mut self.queued_bytes_per_stream,
                        (*conn, *stream_id),
                        *bytes,
                    );
                }
            }
        }
    }

    fn decrement_map(map: &mut HashMap<u32, usize>, key: u32) {
        if let Some(value) = map.get_mut(&key) {
            if *value <= 1 {
                map.remove(&key);
            } else {
                *value -= 1;
            }
        }
    }

    fn decrement_bytes_map<K: Eq + std::hash::Hash + Copy>(
        map: &mut HashMap<K, usize>,
        key: K,
        bytes: usize,
    ) {
        if let Some(value) = map.get_mut(&key) {
            if *value <= bytes {
                map.remove(&key);
            } else {
                *value -= bytes;
            }
        }
    }
}

impl Reservation {
    fn new(inner: Rc<RefCell<GovernorInner>>, kind: ReservationKind) -> Self {
        Self {
            inner: Some(inner),
            kind: Some(kind),
        }
    }
}

impl Drop for Reservation {
    fn drop(&mut self) {
        let Some(inner) = self.inner.take() else {
            return;
        };
        let Some(kind) = self.kind.take() else {
            return;
        };
        GovernorInner::release_kind(&mut inner.borrow_mut(), &kind);
    }
}

#[cfg(test)]
mod tests {
    use std::net::{IpAddr, Ipv4Addr, SocketAddr};
    use std::time::Duration;

    use web_time::Instant;

    use super::{
        Governor, PeerRateLimiter, RateLimitDimension, StreamKind, WasmLimits, WasmRateLimits,
    };

    #[test]
    fn defaults_match_authoritative_v1_limits() {
        let limits = WasmLimits::default();
        assert_eq!(limits.max_sessions, 2000);
        assert_eq!(limits.max_handshakes_in_flight, 200);
        assert_eq!(limits.max_streams_per_session_bidi, 200);
        assert_eq!(limits.max_streams_per_session_uni, 200);
        assert_eq!(limits.max_streams_global, 50_000);
        assert_eq!(limits.max_datagram_size, 1200);
        assert_eq!(limits.max_queued_bytes_global, 512 * 1024 * 1024);
        assert_eq!(limits.max_queued_bytes_per_session, 2 * 1024 * 1024);
        assert_eq!(limits.max_queued_bytes_per_stream, 256 * 1024);
        assert_eq!(limits.backpressure_timeout_ms, 5_000);
        assert_eq!(limits.handshake_timeout_ms, 10_000);
        assert_eq!(limits.idle_timeout_ms, 60_000);
    }

    #[test]
    fn rate_limit_defaults_match_authoritative_v1_limits() {
        let limits = WasmRateLimits::default();
        assert_eq!(limits.handshakes_per_sec, 20);
        assert_eq!(limits.handshakes_burst, 40);
        assert_eq!(limits.stream_opens_per_sec, 200);
        assert_eq!(limits.stream_opens_burst, 400);
        assert_eq!(limits.datagrams_ingress_per_sec, 2000);
        assert_eq!(limits.datagrams_ingress_burst, 5000);
    }

    #[test]
    fn rate_limit_validation_rejects_zero_and_burst_below_rate() {
        let limits = WasmRateLimits {
            handshakes_per_sec: 0,
            ..WasmRateLimits::default()
        };
        assert_eq!(
            limits.validate(),
            Err("E_INTERNAL: rateLimits.handshakesPerSec must be a positive integer".to_string())
        );

        let base = WasmRateLimits::default();
        let limits = WasmRateLimits {
            stream_opens_burst: base.stream_opens_per_sec - 1,
            ..base
        };
        assert_eq!(
            limits.validate(),
            Err(
                "E_INTERNAL: rateLimits.streamOpensBurst must be >= rateLimits.streamOpensPerSec"
                    .to_string()
            )
        );
    }

    #[test]
    fn rate_limit_boundary_plus_one_and_refill_are_deterministic() {
        let now = Instant::now();
        let mut limiter = PeerRateLimiter::new(
            WasmRateLimits {
                handshakes_per_sec: 2,
                handshakes_burst: 2,
                stream_opens_per_sec: 1,
                stream_opens_burst: 1,
                datagrams_ingress_per_sec: 1,
                datagrams_ingress_burst: 1,
            },
            &WasmLimits {
                max_sessions: 2,
                max_handshakes_in_flight: 2,
                handshake_timeout_ms: 25,
                idle_timeout_ms: 1000,
                ..WasmLimits::default()
            },
        )
        .expect("rate limiter");
        let peer = SocketAddr::from((Ipv4Addr::new(127, 0, 0, 1), 4433));

        assert!(
            limiter
                .check(now, peer, RateLimitDimension::Handshake)
                .is_ok(),
            "burst item 1 should pass"
        );
        assert!(
            limiter
                .check(now, peer, RateLimitDimension::Handshake)
                .is_ok(),
            "burst item 2 should pass"
        );
        assert_eq!(
            limiter
                .check(now, peer, RateLimitDimension::Handshake)
                .err()
                .as_deref(),
            Some("E_RATE_LIMITED: handshakes rate limit reached")
        );

        assert_eq!(
            limiter
                .check(
                    now + Duration::from_millis(499),
                    peer,
                    RateLimitDimension::Handshake
                )
                .err()
                .as_deref(),
            Some("E_RATE_LIMITED: handshakes rate limit reached")
        );
        assert!(
            limiter
                .check(
                    now + Duration::from_millis(500),
                    peer,
                    RateLimitDimension::Handshake
                )
                .is_ok(),
            "one token should refill after 500ms at 2/s"
        );
    }

    #[test]
    fn rate_limit_normalizes_ip_and_bounds_source_port_churn() {
        let now = Instant::now();
        let mut limiter = PeerRateLimiter::new(
            WasmRateLimits {
                handshakes_per_sec: 1,
                handshakes_burst: 1,
                stream_opens_per_sec: 1,
                stream_opens_burst: 1,
                datagrams_ingress_per_sec: 1,
                datagrams_ingress_burst: 1,
            },
            &WasmLimits {
                max_sessions: 4,
                max_handshakes_in_flight: 2,
                handshake_timeout_ms: 25,
                idle_timeout_ms: 1000,
                ..WasmLimits::default()
            },
        )
        .expect("rate limiter");
        let ipv4_a = SocketAddr::from((Ipv4Addr::new(127, 0, 0, 1), 4000));
        let ipv4_b = SocketAddr::from((Ipv4Addr::new(127, 0, 0, 1), 4999));
        let mapped = SocketAddr::new(
            IpAddr::from("::ffff:127.0.0.1".parse::<std::net::Ipv6Addr>().unwrap()),
            5001,
        );

        assert!(limiter
            .check(now, ipv4_a, RateLimitDimension::Handshake)
            .is_ok());
        assert_eq!(
            limiter
                .check(now, ipv4_b, RateLimitDimension::Handshake)
                .err()
                .as_deref(),
            Some("E_RATE_LIMITED: handshakes rate limit reached"),
            "same IPv4 with another source port must share one bucket"
        );
        assert_eq!(
            limiter
                .check(now, mapped, RateLimitDimension::Handshake)
                .err()
                .as_deref(),
            Some("E_RATE_LIMITED: handshakes rate limit reached"),
            "IPv4-mapped IPv6 must normalize to the same bucket"
        );
        assert_eq!(limiter.snapshot().bucket_count, 1);
    }

    #[test]
    fn rate_limit_idle_eviction_cleanup_and_cross_peer_isolation_hold() {
        let now = Instant::now();
        let mut limiter = PeerRateLimiter::new(
            WasmRateLimits {
                handshakes_per_sec: 1,
                handshakes_burst: 1,
                stream_opens_per_sec: 1,
                stream_opens_burst: 1,
                datagrams_ingress_per_sec: 1,
                datagrams_ingress_burst: 1,
            },
            &WasmLimits {
                max_sessions: 1,
                max_handshakes_in_flight: 1,
                handshake_timeout_ms: 10,
                idle_timeout_ms: 25,
                ..WasmLimits::default()
            },
        )
        .expect("rate limiter");
        let peer_a = SocketAddr::from((Ipv4Addr::new(127, 0, 0, 1), 4000));
        let peer_b = SocketAddr::from((Ipv4Addr::new(127, 0, 0, 2), 4000));

        assert!(limiter
            .check(now, peer_a, RateLimitDimension::Handshake)
            .is_ok());
        limiter
            .attach_connection(10, peer_a, now)
            .expect("attach connection A");
        assert!(
            limiter
                .check(now, peer_b, RateLimitDimension::Handshake)
                .is_ok(),
            "peer B must remain isolated from peer A exhaustion"
        );
        limiter
            .attach_connection(20, peer_b, now)
            .expect("attach connection B");

        limiter.release_connection(10, now + Duration::from_millis(1));
        limiter.release_connection(20, now + Duration::from_millis(1));
        assert_eq!(limiter.snapshot().bucket_count, 2);

        assert!(
            limiter
                .check(
                    now + Duration::from_millis(30),
                    SocketAddr::from((Ipv4Addr::new(127, 0, 0, 3), 4000)),
                    RateLimitDimension::Handshake
                )
                .is_ok(),
            "idle zero-owner buckets should be evicted before admitting a new peer"
        );
        assert_eq!(limiter.snapshot().bucket_count, 1);

        limiter.clear();
        assert_eq!(limiter.snapshot().bucket_count, 0);
    }

    #[test]
    fn rate_limit_unknown_connection_fails_closed_and_cleanup_removes_ownership() {
        let now = Instant::now();
        let mut limiter = PeerRateLimiter::new(
            WasmRateLimits {
                handshakes_per_sec: 1,
                handshakes_burst: 1,
                stream_opens_per_sec: 1,
                stream_opens_burst: 1,
                datagrams_ingress_per_sec: 1,
                datagrams_ingress_burst: 1,
            },
            &WasmLimits {
                max_sessions: 2,
                max_handshakes_in_flight: 2,
                handshake_timeout_ms: 10,
                idle_timeout_ms: 25,
                ..WasmLimits::default()
            },
        )
        .expect("rate limiter");
        let peer = SocketAddr::from((Ipv4Addr::new(127, 0, 0, 1), 4000));

        limiter
            .attach_connection(10, peer, now)
            .expect("attach connection");
        assert!(limiter
            .check_connection(now, 10, RateLimitDimension::StreamOpen)
            .is_ok());

        limiter.release_connection(10, now + Duration::from_millis(1));
        assert_eq!(
            limiter
                .check_connection(
                    now + Duration::from_millis(2),
                    10,
                    RateLimitDimension::DatagramIngress
                )
                .err()
                .as_deref(),
            Some("E_INTERNAL: missing peer ownership for datagramsIngress rate limiting")
        );

        limiter.clear();
        assert_eq!(limiter.snapshot().bucket_count, 0);
        assert_eq!(
            limiter
                .check_connection(
                    now + Duration::from_millis(3),
                    10,
                    RateLimitDimension::StreamOpen
                )
                .err()
                .as_deref(),
            Some("E_INTERNAL: missing peer ownership for streamOpens rate limiting")
        );
    }

    #[test]
    fn exact_limit_and_limit_plus_one_reservations_are_enforced_and_released() {
        let governor = Governor::new(WasmLimits {
            max_sessions: 1,
            max_handshakes_in_flight: 1,
            max_streams_per_session_bidi: 1,
            max_streams_per_session_uni: 1,
            max_streams_global: 1,
            max_datagram_size: 8,
            max_queued_bytes_global: 8,
            max_queued_bytes_per_session: 8,
            max_queued_bytes_per_stream: 8,
            backpressure_timeout_ms: 5,
            handshake_timeout_ms: 7,
            idle_timeout_ms: 11,
        })
        .expect("governor");

        let handshake = governor.reserve_handshake().expect("limit");
        assert!(
            governor.reserve_handshake().is_err(),
            "limit+1 handshake must fail"
        );

        let session = governor.reserve_session(1).expect("session");
        assert!(
            governor.reserve_session(2).is_err(),
            "limit+1 session must fail"
        );

        let stream = governor
            .reserve_stream(1, 1, StreamKind::Bidi)
            .expect("stream");
        assert!(
            governor.reserve_stream(1, 2, StreamKind::Bidi).is_err(),
            "limit+1 stream must fail"
        );

        let bytes = governor
            .reserve_event_bytes(1, Some(1), 8)
            .expect("queued bytes at limit");
        assert!(
            governor.reserve_event_bytes(1, Some(1), 1).is_err(),
            "limit+1 queued bytes must fail"
        );

        drop(bytes);
        drop(stream);
        drop(session);
        drop(handshake);

        let snapshot = governor.snapshot(1, Some(1));
        assert_eq!(snapshot.handshakes_in_flight, 0);
        assert_eq!(snapshot.sessions_active, 0);
        assert_eq!(snapshot.streams_active_global, 0);
        assert_eq!(snapshot.queued_bytes_global, 0);
    }

    #[test]
    fn host_transfer_keeps_bytes_reserved_until_released_once() {
        let governor = Governor::new(WasmLimits {
            max_queued_bytes_global: 64,
            max_queued_bytes_per_session: 64,
            max_queued_bytes_per_stream: 64,
            ..WasmLimits::default()
        })
        .expect("governor");

        let reservation = governor
            .reserve_event_bytes(9, Some(4), 32)
            .expect("queued");
        let token = governor.transfer_to_host(reservation).expect("token");
        assert!(token > 0, "host transfer must mint an opaque token");

        let snapshot = governor.snapshot(9, Some(4));
        assert_eq!(snapshot.queued_bytes_global, 32);
        assert_eq!(snapshot.host_tokens_active, 1);

        assert!(governor.release_host_token(token), "first release works");
        assert!(
            !governor.release_host_token(token),
            "second release is idempotent and must report false"
        );

        let snapshot = governor.snapshot(9, Some(4));
        assert_eq!(snapshot.queued_bytes_global, 0);
        assert_eq!(snapshot.host_tokens_active, 0);
    }

    #[test]
    fn bidi_uni_and_global_stream_limits_are_counted_independently() {
        let governor = Governor::new(WasmLimits {
            max_sessions: 4,
            max_handshakes_in_flight: 4,
            max_streams_per_session_bidi: 1,
            max_streams_per_session_uni: 1,
            max_streams_global: 2,
            max_datagram_size: 8,
            max_queued_bytes_global: 64,
            max_queued_bytes_per_session: 64,
            max_queued_bytes_per_stream: 64,
            backpressure_timeout_ms: 5,
            handshake_timeout_ms: 7,
            idle_timeout_ms: 11,
        })
        .expect("governor");

        let bidi = governor
            .reserve_stream(7, 10, StreamKind::Bidi)
            .expect("first bidi within limit");
        assert!(
            governor.reserve_stream(7, 11, StreamKind::Bidi).is_err(),
            "second bidi on same session must trip maxStreamsPerSessionBidi"
        );

        let uni = governor
            .reserve_stream(7, 12, StreamKind::Uni)
            .expect("first uni within limit");
        assert!(
            governor.reserve_stream(7, 13, StreamKind::Uni).is_err(),
            "second uni on same session must trip maxStreamsPerSessionUni"
        );
        assert!(
            governor.reserve_stream(8, 14, StreamKind::Bidi).is_err(),
            "third concurrent stream must trip maxStreamsGlobal"
        );

        drop(uni);
        drop(bidi);

        let snapshot = governor.snapshot(7, Some(10));
        assert_eq!(snapshot.streams_active_global, 0);
    }

    #[test]
    fn queued_byte_limits_enforce_stream_then_session_then_global_boundaries() {
        let governor = Governor::new(WasmLimits {
            max_sessions: 4,
            max_handshakes_in_flight: 4,
            max_streams_per_session_bidi: 4,
            max_streams_per_session_uni: 4,
            max_streams_global: 8,
            max_datagram_size: 8,
            max_queued_bytes_global: 10,
            max_queued_bytes_per_session: 6,
            max_queued_bytes_per_stream: 4,
            backpressure_timeout_ms: 5,
            handshake_timeout_ms: 7,
            idle_timeout_ms: 11,
        })
        .expect("governor");

        let stream_full = governor
            .reserve_event_bytes(1, Some(1), 4)
            .expect("stream bytes at exact limit");
        assert!(
            governor.reserve_event_bytes(1, Some(1), 1).is_err(),
            "limit+1 on one stream must trip maxQueuedBytesPerStream"
        );

        let session_full = governor
            .reserve_event_bytes(1, Some(2), 2)
            .expect("session bytes at exact limit");
        assert!(
            governor.reserve_event_bytes(1, Some(3), 1).is_err(),
            "limit+1 on one session must trip maxQueuedBytesPerSession"
        );

        let global_full = governor
            .reserve_event_bytes(2, Some(1), 4)
            .expect("global bytes at exact limit");
        assert!(
            governor.reserve_event_bytes(3, Some(1), 1).is_err(),
            "limit+1 across sessions must trip maxQueuedBytesGlobal"
        );

        drop(global_full);
        drop(session_full);
        drop(stream_full);

        let snapshot_a = governor.snapshot(1, Some(1));
        let snapshot_b = governor.snapshot(2, Some(1));
        assert_eq!(snapshot_a.queued_bytes_global, 0);
        assert_eq!(snapshot_a.queued_bytes_for_session, 0);
        assert_eq!(snapshot_a.queued_bytes_for_stream, 0);
        assert_eq!(snapshot_b.queued_bytes_global, 0);
        assert_eq!(snapshot_b.queued_bytes_for_session, 0);
        assert_eq!(snapshot_b.queued_bytes_for_stream, 0);
    }

    #[test]
    fn accounted_zero_byte_event_reservations_charge_one_logical_byte_and_recover() {
        let governor = Governor::new(WasmLimits {
            max_queued_bytes_global: 2,
            max_queued_bytes_per_session: 2,
            max_queued_bytes_per_stream: 2,
            ..WasmLimits::default()
        })
        .expect("governor");

        let first = governor
            .reserve_event_bytes(1, None, 1)
            .expect("first zero-byte datagram");
        let second = governor
            .reserve_event_bytes(1, Some(7), 1)
            .expect("second zero-byte stream item");
        assert_eq!(
            governor
                .reserve_event_bytes(1, Some(8), 1)
                .err()
                .expect("limit+1 zero-byte reservation"),
            "E_QUEUE_FULL: maxQueuedBytesGlobal reached"
        );

        let snapshot = governor.snapshot(1, Some(7));
        assert_eq!(snapshot.queued_bytes_global, 2);
        assert_eq!(snapshot.queued_bytes_for_session, 2);
        assert_eq!(snapshot.queued_bytes_for_stream, 1);

        drop(second);
        drop(first);
        assert_eq!(
            governor.snapshot(1, Some(7)),
            super::GovernorSnapshot::default()
        );
    }

    #[test]
    fn every_count_limit_accepts_exact_boundary_rejects_limit_plus_one_and_recovers() {
        let governor = Governor::new(WasmLimits {
            max_sessions: 2,
            max_handshakes_in_flight: 2,
            max_streams_per_session_bidi: 2,
            max_streams_per_session_uni: 2,
            max_streams_global: 4,
            ..WasmLimits::default()
        })
        .expect("governor");

        for _ in 0..32 {
            let handshakes = [
                governor.reserve_handshake().expect("handshake 1"),
                governor
                    .reserve_handshake()
                    .expect("handshake 2 exact limit"),
            ];
            assert_eq!(
                governor.reserve_handshake().err().expect("limit+1 error"),
                "E_LIMIT_EXCEEDED: maxHandshakesInFlight reached"
            );

            let sessions = [
                governor.reserve_session(1).expect("session 1"),
                governor.reserve_session(2).expect("session 2 exact limit"),
            ];
            assert_eq!(
                governor.reserve_session(3).err().expect("limit+1 error"),
                "E_LIMIT_EXCEEDED: maxSessions reached"
            );

            let streams = [
                governor
                    .reserve_stream(1, 1, StreamKind::Bidi)
                    .expect("bidi 1"),
                governor
                    .reserve_stream(1, 2, StreamKind::Bidi)
                    .expect("bidi 2 exact session limit"),
                governor
                    .reserve_stream(2, 3, StreamKind::Uni)
                    .expect("uni 1"),
                governor
                    .reserve_stream(2, 4, StreamKind::Uni)
                    .expect("uni 2 exact global limit"),
            ];
            assert_eq!(
                governor
                    .reserve_stream(1, 5, StreamKind::Bidi)
                    .err()
                    .expect("limit+1 error"),
                "E_LIMIT_EXCEEDED: maxStreamsGlobal reached"
            );

            drop(streams);
            let bidi = [
                governor
                    .reserve_stream(1, 6, StreamKind::Bidi)
                    .expect("bidi 1 after recovery"),
                governor
                    .reserve_stream(1, 7, StreamKind::Bidi)
                    .expect("bidi 2 exact per-session limit"),
            ];
            assert_eq!(
                governor
                    .reserve_stream(1, 8, StreamKind::Bidi)
                    .err()
                    .expect("limit+1 error"),
                "E_LIMIT_EXCEEDED: maxStreamsPerSessionBidi reached"
            );
            drop(bidi);

            let uni = [
                governor
                    .reserve_stream(1, 9, StreamKind::Uni)
                    .expect("uni 1 after recovery"),
                governor
                    .reserve_stream(1, 10, StreamKind::Uni)
                    .expect("uni 2 exact per-session limit"),
            ];
            assert_eq!(
                governor
                    .reserve_stream(1, 11, StreamKind::Uni)
                    .err()
                    .expect("limit+1 error"),
                "E_LIMIT_EXCEEDED: maxStreamsPerSessionUni reached"
            );

            drop(uni);
            drop(sessions);
            drop(handshakes);
            assert_eq!(
                governor.snapshot(1, None),
                super::GovernorSnapshot::default()
            );
        }
    }

    #[test]
    fn every_byte_limit_has_stable_boundary_error_and_multi_session_isolation() {
        let governor = Governor::new(WasmLimits {
            max_queued_bytes_global: 12,
            max_queued_bytes_per_session: 8,
            max_queued_bytes_per_stream: 4,
            ..WasmLimits::default()
        })
        .expect("governor");

        for _ in 0..32 {
            let stream_exact = governor
                .reserve_event_bytes(1, Some(10), 4)
                .expect("stream exact limit");
            assert_eq!(
                governor
                    .reserve_event_bytes(1, Some(10), 1)
                    .err()
                    .expect("limit+1 error"),
                "E_QUEUE_FULL: maxQueuedBytesPerStream reached"
            );

            let session_exact = governor
                .reserve_event_bytes(1, Some(11), 4)
                .expect("session exact limit");
            assert_eq!(
                governor
                    .reserve_event_bytes(1, Some(12), 1)
                    .err()
                    .expect("limit+1 error"),
                "E_QUEUE_FULL: maxQueuedBytesPerSession reached"
            );

            let other_session = governor
                .reserve_event_bytes(2, Some(20), 4)
                .expect("other session remains isolated until global limit");
            assert_eq!(
                governor
                    .reserve_event_bytes(3, Some(30), 1)
                    .err()
                    .expect("limit+1 error"),
                "E_QUEUE_FULL: maxQueuedBytesGlobal reached"
            );

            drop(other_session);
            drop(session_exact);
            drop(stream_exact);
            assert_eq!(
                governor.snapshot(1, Some(10)),
                super::GovernorSnapshot::default()
            );
            assert_eq!(
                governor.snapshot(2, Some(20)),
                super::GovernorSnapshot::default()
            );
        }
    }

    #[test]
    fn transferred_host_tokens_can_be_dropped_as_one_teardown_operation() {
        let governor = Governor::new(WasmLimits {
            max_queued_bytes_global: 8,
            max_queued_bytes_per_session: 8,
            max_queued_bytes_per_stream: 8,
            ..WasmLimits::default()
        })
        .expect("governor");

        for stream in 1..=8 {
            let reservation = governor
                .reserve_event_bytes(7, Some(stream), 1)
                .expect("event byte");
            governor
                .transfer_to_host(reservation)
                .expect("host transfer");
        }
        assert_eq!(governor.snapshot(7, None).queued_bytes_global, 8);
        assert_eq!(governor.snapshot(7, None).host_tokens_active, 8);

        assert_eq!(governor.release_all_host_tokens(), 8);
        assert_eq!(governor.release_all_host_tokens(), 0);
        assert_eq!(
            governor.snapshot(7, None),
            super::GovernorSnapshot::default()
        );
    }

    #[test]
    fn configured_deadlines_preserve_exact_millisecond_values() {
        let limits = WasmLimits {
            backpressure_timeout_ms: 13,
            handshake_timeout_ms: 17,
            idle_timeout_ms: 29,
            ..WasmLimits::default()
        };
        let governor = Governor::new(limits.clone()).expect("governor");
        assert_eq!(governor.limits().backpressure_timeout_ms, 13);
        assert_eq!(governor.limits().handshake_timeout_ms, 17);
        assert_eq!(governor.limits().idle_timeout_ms, 29);
        assert_eq!(governor.limits(), limits);
    }

    #[test]
    fn timer_limits_reject_values_the_js_host_cannot_schedule() {
        let too_large = (i32::MAX as u64) + 1;
        for limits in [
            WasmLimits {
                backpressure_timeout_ms: too_large,
                ..WasmLimits::default()
            },
            WasmLimits {
                handshake_timeout_ms: too_large,
                idle_timeout_ms: too_large,
                ..WasmLimits::default()
            },
            WasmLimits {
                idle_timeout_ms: too_large,
                ..WasmLimits::default()
            },
        ] {
            assert!(Governor::new(limits)
                .err()
                .expect("timer overflow must be rejected")
                .contains("host timer range"));
        }
    }

    #[test]
    fn host_token_allocation_wraps_without_overwriting_live_reservations() {
        let governor = Governor::new(WasmLimits {
            max_queued_bytes_global: 8,
            max_queued_bytes_per_session: 8,
            max_queued_bytes_per_stream: 8,
            ..WasmLimits::default()
        })
        .expect("governor");
        governor.inner.borrow_mut().next_host_token = u32::MAX - 1;

        let transfer = |stream| {
            governor
                .transfer_to_host(
                    governor
                        .reserve_event_bytes(1, Some(stream), 1)
                        .expect("reservation"),
                )
                .expect("collision-free token")
        };
        let before_wrap = transfer(1);
        let at_wrap = transfer(2);
        let after_wrap = transfer(3);
        assert_eq!(before_wrap, u32::MAX - 1);
        assert_eq!(at_wrap, u32::MAX);
        assert_eq!(after_wrap, 1);

        // Force allocation to revisit a live token. It must probe to the next
        // free token rather than replace token 1's reservation in the map.
        governor.inner.borrow_mut().next_host_token = 1;
        let collision_probe = transfer(4);
        assert_eq!(collision_probe, 2);
        let snapshot = governor.snapshot(1, None);
        assert_eq!(snapshot.host_tokens_active, 4);
        assert_eq!(snapshot.queued_bytes_global, 4);

        for token in [before_wrap, at_wrap, after_wrap, collision_probe] {
            assert!(governor.release_host_token(token));
        }
        assert_eq!(
            governor.snapshot(1, None),
            super::GovernorSnapshot::default()
        );
    }

    #[test]
    fn exhausted_host_token_namespace_fails_stably_and_releases_failed_transfer() {
        let governor = Governor::new(WasmLimits {
            max_queued_bytes_global: 2,
            max_queued_bytes_per_session: 2,
            max_queued_bytes_per_stream: 2,
            ..WasmLimits::default()
        })
        .expect("governor");
        governor.set_host_token_ceiling_for_test(1);

        let first = governor
            .transfer_to_host(
                governor
                    .reserve_event_bytes(1, Some(1), 1)
                    .expect("first reservation"),
            )
            .expect("only token");
        let error = governor
            .transfer_to_host(
                governor
                    .reserve_event_bytes(1, Some(2), 1)
                    .expect("second reservation"),
            )
            .expect_err("namespace exhaustion must not overwrite token 1");
        assert_eq!(
            error,
            "E_LIMIT_EXCEEDED: host reservation token space exhausted"
        );
        let snapshot = governor.snapshot(1, None);
        assert_eq!(snapshot.host_tokens_active, 1);
        assert_eq!(snapshot.queued_bytes_global, 1);

        assert!(governor.release_host_token(first));
        assert_eq!(
            governor.snapshot(1, None),
            super::GovernorSnapshot::default()
        );
    }
}
