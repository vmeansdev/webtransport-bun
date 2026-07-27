//! Sans-IO WebTransport endpoint: quinn-proto QUIC + a minimal H3/WT session
//! layer. JS owns UDP, timers, and event pumping; this type is pure protocol.

use std::collections::{HashMap, HashSet, VecDeque};
use std::net::SocketAddr;
use std::sync::Arc;

use bytes::{Bytes, BytesMut};
use quinn_proto::{
    ClientConfig, Connection, ConnectionHandle, DatagramEvent, Dir, Endpoint, EndpointConfig,
    Event as QuicEvent, IdleTimeout, SendDatagramError, ServerConfig, StreamEvent, StreamId,
    VarInt,
};
use web_time::Instant;

use crate::event::WtEvent;
use crate::governor::{
    Governor, PeerRateLimiter, RateLimitDimension, RateLimitSnapshot, Reservation, StreamKind,
    WasmLimits, WasmRateLimits,
};
use crate::h3;
use crate::spike;
use crate::ticket_store::{
    configure_client_early_data, configure_server_early_data, InMemoryTicketStore,
};

/// A peer-accepted stream being classified and read.
struct InStream {
    /// First varint on the stream: H3 stream/frame type. None until decoded.
    kind: Option<u64>,
    is_bidi: bool,
    /// For WT streams: whether the session-id varint has been consumed.
    sid_read: bool,
    /// WT stream handle once classified as a WebTransport stream.
    handle: Option<u32>,
    buf: Vec<u8>,
}

#[derive(Default)]
struct Session {
    authority: String,
    peer_settings: Option<h3::PeerSettings>,
    control_send_stream: Option<StreamId>,
    /// Primary CONNECT bidi stream id (client: self-opened; server: first
    /// accepted). Session id for datagrams/streams is this stream's id.
    connect_stream: Option<StreamId>,
    /// Additional established CONNECT stream ids (multi-session). Together with
    /// `connect_stream` these are the live WT sessions on this QUIC connection.
    extra_sessions: HashSet<StreamId>,
    /// True when we (client) opened the primary CONNECT stream ourselves.
    connect_self_opened: bool,
    established: bool,
    /// Set once the *primary* WT session has been closed (graceful CONNECT-stream
    /// end), so Closed is emitted exactly once for the connection teardown path.
    connect_closed: bool,
    /// Client only: deadline by which the CONNECT must be answered, or the
    /// session is failed. Bounds a handshake that would otherwise hang forever
    /// because QUIC keep-alives defeat the idle timeout. Cleared on establish.
    connect_deadline: Option<Instant>,
    connect_rx: Vec<u8>,
    control_rx: Vec<u8>,
    /// Inbound QPACK encoder-stream bytes awaiting instruction parse.
    qpack_encoder_rx: Vec<u8>,
    /// Decoder-side dynamic QPACK table (matches advertised SETTINGS; default 0).
    qpack_decoder: h3::QpackDecoder,
    /// Peer-accepted streams (uni + bidi) being classified/read.
    in_streams: HashMap<StreamId, InStream>,
    /// Self-opened bidi WT streams: id -> handle (inbound is raw WT data).
    self_bidi: HashMap<StreamId, u32>,
}

impl Session {
    /// Count of live WebTransport sessions on this QUIC connection.
    fn active_wt_count(&self) -> usize {
        let primary = if primary_wt_session_live(
            self.established,
            self.connect_closed,
            self.connect_stream.is_some(),
        ) {
            1
        } else {
            0
        };
        primary + self.extra_sessions.len()
    }

    fn is_wt_connect(&self, id: StreamId) -> bool {
        self.connect_stream == Some(id) || self.extra_sessions.contains(&id)
    }

    fn all_connect_streams(&self) -> impl Iterator<Item = StreamId> + '_ {
        self.connect_stream
            .into_iter()
            .chain(self.extra_sessions.iter().copied())
    }

    /// Resolve a datagram quarter-session-id to its CONNECT stream (session id).
    fn session_for_qsid(&self, qsid: u64) -> Option<StreamId> {
        self.all_connect_streams()
            .find(|sid| u64::from(*sid) / 4 == qsid)
    }
}

pub struct WtEndpoint {
    inner: Endpoint,
    is_server: bool,
    peer_addr: SocketAddr,
    conns: HashMap<ConnectionHandle, Connection>,
    sessions: HashMap<ConnectionHandle, Session>,
    handle_to_id: HashMap<ConnectionHandle, u32>,
    id_to_handle: HashMap<u32, ConnectionHandle>,
    next_id: u32,
    /// WT stream handle -> (connection, quinn stream id).
    stream_index: HashMap<u32, (ConnectionHandle, StreamId)>,
    /// Reverse of `stream_index`: (connection, quinn stream id) -> handle, so
    /// resolving a StreamId to its WT handle is O(1) (kept in sync via
    /// `index_insert`/`index_remove`).
    rev_index: HashMap<(ConnectionHandle, StreamId), u32>,
    /// WT stream handles the consumer paused: their recv data stays in quinn's
    /// buffer (exerting QUIC flow control on the sender) until resumed.
    paused: HashSet<u32>,
    /// Per-handle completion bits (HALF_RECV/HALF_SEND). A stream's index
    /// entry is released only when BOTH halves are done, so bidi streams do
    /// not leak and uni streams release as soon as their single half ends.
    half_done: HashMap<u32, u8>,
    next_stream: u32,
    events: VecDeque<WtEvent>,
    event_reservations: VecDeque<Option<Reservation>>,
    client_config: Option<ClientConfig>,
    endpoint_tx: Vec<(Vec<u8>, SocketAddr)>,
    governor: Governor,
    rate_limiter: PeerRateLimiter,
    handshake_reservations: HashMap<ConnectionHandle, Reservation>,
    session_reservations: HashMap<ConnectionHandle, Reservation>,
    stream_reservations: HashMap<u32, Reservation>,
    capacity_waiters: CapacityWaitQueue,
    handshake_timeout_ms: u64,
    idle_timeout_ms: u64,
    /// SETTINGS_WT_MAX_SESSIONS advertised and enforced per QUIC connection.
    /// Default is ≥ 2 for multi-session proof; clamped to
    /// `1..=WT_MAX_SESSIONS_HARD_CAP`. Independent of governor `maxSessions`
    /// (global concurrent admission).
    wt_max_sessions: u64,
    /// Opt-in QUIC TLS 1.3 early data (0-RTT). When true, client/server rustls
    /// configs accept/offer early data and share an [`InMemoryTicketStore`].
    enable_0rtt: bool,
    last_error: Option<String>,
}

fn clamp_varint_to_u32(value: u64) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

/// Default SETTINGS_WT_MAX_SESSIONS (≥ 2 for multi-session proof). JS bridge
/// may override via optional `wtMaxSessions`; otherwise this Rust default applies.
const WT_MAX_SESSIONS_DEFAULT: u64 = 2;
/// Hard upper bound for per-connection WT sessions (DoS / resource cap).
const WT_MAX_SESSIONS_HARD_CAP: u64 = 256;

fn clamp_wt_max_sessions(value: u64) -> u64 {
    value.clamp(1, WT_MAX_SESSIONS_HARD_CAP)
}

/// Whether the primary CONNECT session still counts as live.
fn primary_wt_session_live(
    established: bool,
    connect_closed: bool,
    has_connect_stream: bool,
) -> bool {
    established && !connect_closed && has_connect_stream
}

/// Client sessions awaiting CONNECT answers contribute a deadline.
fn should_track_connect_deadline(established: bool, connect_closed: bool) -> bool {
    !established && !connect_closed
}

/// Pick the sooner of two deadlines (used by `next_timeout_ms`).
fn sooner_deadline(current: Option<Instant>, candidate: Instant) -> Option<Instant> {
    Some(match current {
        Some(s) if s <= candidate => s,
        _ => candidate,
    })
}

/// Push a buffered UDP payload only when both a destination and bytes exist.
fn push_transmit_if_ready(
    out: &mut Vec<(Vec<u8>, SocketAddr)>,
    buf: Vec<u8>,
    dest: Option<SocketAddr>,
) {
    if let Some(destination) = dest {
        if !buf.is_empty() {
            out.push((buf, destination));
        }
    }
}

/// Backpressure when the byte budget is exhausted and the stream made no
/// progress (still open). Shared by peer-accepted and self-bidi read pumps.
fn should_backpressure_zero_progress_read(
    read_limit: usize,
    made_progress: bool,
    outcome_open: bool,
) -> bool {
    read_limit == 0 && !made_progress && outcome_open
}

/// Emit StreamData when there is payload or a FIN/terminal signal.
fn should_emit_stream_payload(payload_empty: bool, finished: bool) -> bool {
    !payload_empty || finished
}

/// Emit a self-bidi chunk when bytes arrived or the half finished.
fn should_emit_self_bidi_chunk(made_progress: bool, finished: bool) -> bool {
    made_progress || finished
}

/// Convert a soonest-deadline instant into the JS-facing timeout ms value.
fn next_timeout_value(now: Instant, soonest: Option<Instant>) -> f64 {
    match soonest {
        Some(t) if t > now => (t - now).as_secs_f64() * 1000.0,
        Some(_) => 0.0,
        None => -1.0,
    }
}

/// Client CONNECT deadline has elapsed without establish/close.
fn connect_deadline_expired(
    established: bool,
    connect_closed: bool,
    deadline: Option<Instant>,
    now: Instant,
) -> bool {
    !established && !connect_closed && deadline.is_some_and(|d| d <= now)
}

/// Whether an outbound datagram exceeds local and/or negotiated size caps.
fn datagram_payload_exceeds_caps(
    payload_len: usize,
    local_limit: usize,
    negotiated: Option<usize>,
) -> bool {
    payload_len > local_limit || negotiated.is_some_and(|max| payload_len > max)
}

/// Stop pumping a stream once it is no longer open or made no progress.
fn should_stop_read_batch(outcome_open: bool, made_progress: bool) -> bool {
    if !outcome_open {
        true
    } else if !made_progress {
        true
    } else {
        false
    }
}

/// Wait when a read needs host event slots that are currently unavailable.
fn should_wait_for_event_slots(required_slots: usize, has_capacity: bool) -> bool {
    if required_slots == 0 {
        false
    } else if has_capacity {
        false
    } else {
        true
    }
}

/// Rejected WT bidi streams need their local send half reset as well.
fn should_reset_send_on_wt_reject(bidi: bool) -> bool {
    if bidi {
        true
    } else {
        false
    }
}

/// SETTINGS_QPACK_BLOCKED_STREAMS = 0 forbids waiting on encoder inserts.
fn qpack_blocking_forbidden(max_blocked_streams: u64) -> bool {
    if max_blocked_streams == 0 {
        true
    } else {
        false
    }
}

/// Pure decision helper for capacity / admission style guards (unit-tested).
fn endpoint_guard_decision(
    is_server: bool,
    rate_limited: bool,
    queue_full: bool,
    established: bool,
) -> u8 {
    if rate_limited {
        1
    } else if queue_full {
        2
    } else if is_server {
        if established {
            3
        } else {
            4
        }
    } else if established {
        5
    } else {
        6
    }
}

/// Whether a quinn read chunk carried application bytes.
fn chunk_carries_payload(byte_len: usize) -> bool {
    if byte_len == 0 {
        false
    } else {
        true
    }
}

/// How many pending host events a read of this classified stream may enqueue.
fn required_slots_for_in_stream(kind: Option<u64>, is_bidi: bool, has_handle: bool) -> usize {
    match kind {
        Some(h3::stream_type::CONTROL)
        | Some(h3::stream_type::QPACK_ENCODER)
        | Some(h3::stream_type::QPACK_DECODER) => 0,
        Some(h3::frame::HEADERS) if is_bidi => 0,
        Some(h3::stream_type::WT_UNI) | Some(h3::frame::WT_BIDI) if has_handle => 1,
        Some(h3::stream_type::WT_UNI) | Some(h3::frame::WT_BIDI) => 2,
        Some(_) => 0,
        None => 2,
    }
}

/// Map a quinn connection-loss reason to an optional last-error + close code.
/// `None` means the Closed event was already emitted by a local close.
fn connection_lost_signal(
    reason: &quinn_proto::ConnectionError,
) -> Option<(Option<&'static str>, u32)> {
    match reason {
        quinn_proto::ConnectionError::LocallyClosed => None,
        quinn_proto::ConnectionError::ApplicationClosed(app) => {
            let code = u64::from(app.error_code).try_into().unwrap_or(u32::MAX);
            Some((None, code))
        }
        quinn_proto::ConnectionError::TimedOut => {
            Some((Some("E_SESSION_IDLE_TIMEOUT: connection idle timeout"), 0))
        }
        _ => Some((None, 0)),
    }
}

/// Classify the first H3/WT stream-type varint for peer-accepted streams.
fn classify_peer_stream_kind(kind: u64, is_bidi: bool) -> PeerStreamClass {
    match kind {
        h3::stream_type::CONTROL => PeerStreamClass::Control,
        h3::frame::HEADERS if is_bidi => PeerStreamClass::ServerConnect,
        h3::stream_type::QPACK_ENCODER => PeerStreamClass::QpackEncoder,
        h3::stream_type::QPACK_DECODER => PeerStreamClass::QpackDecoder,
        h3::stream_type::WT_UNI | h3::frame::WT_BIDI => PeerStreamClass::WebTransport,
        _ => PeerStreamClass::Ignore,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PeerStreamClass {
    Control,
    ServerConnect,
    QpackEncoder,
    QpackDecoder,
    WebTransport,
    Ignore,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ConnectStatusKind {
    Success,
    Interim,
    Failure,
}

fn classify_connect_status(status: Option<u16>) -> ConnectStatusKind {
    match status {
        Some(200..=299) => ConnectStatusKind::Success,
        Some(100..=199) => ConnectStatusKind::Interim,
        _ => ConnectStatusKind::Failure,
    }
}

fn headers_are_webtransport_connect(headers: &[(String, String)]) -> bool {
    headers
        .iter()
        .any(|(k, v)| k == ":method" && v == "CONNECT")
        && headers
            .iter()
            .any(|(k, v)| k == ":protocol" && v == "webtransport")
}
/// Stream-half completion bits for `WtEndpoint::half_done`.
const HALF_RECV: u8 = 1;
const HALF_SEND: u8 = 2;
/// Keep-alive ping cadence — well under the idle timeout so healthy sessions
/// never idle out.
const KEEP_ALIVE_INTERVAL_MS: u64 = 3_000;

/// Maximum size of a single buffered H3 control/CONNECT/HEADERS frame. A peer
/// advertising a larger frame length is closed with H3_EXCESSIVE_LOAD rather
/// than allowed to force unbounded per-connection buffering (memory-exhaustion
/// DoS). Also keeps the `flen as usize` cast safe on wasm32 (32-bit usize): the
/// length is checked against this cap (well below u32::MAX) before the cast.
const MAX_H3_FRAME_SIZE: u64 = 1 << 20; // 1 MiB
/// Bound non-application protocol parsing work per read batch.
const PROTOCOL_READ_CHUNK: usize = 64 * 1024;
/// Prevent one busy connection from monopolizing a host pump.
const MAX_READ_BATCHES_PER_PUMP: usize = 64;
/// Prevent one capacity change from waking every blocked connection at once.
const MAX_WAITERS_WOKEN_PER_CAPACITY_CHANGE: usize = 64;
/// H3_EXCESSIVE_LOAD (RFC 9114 §8.1).
const H3_EXCESSIVE_LOAD: u32 = 0x0107;

/// H3_INTERNAL_ERROR (RFC 9114 §8.1): used when the endpoint itself can no
/// longer service a connection (e.g. host reservation token space exhausted)
/// and fails closed instead of silently dropping payloads.
const H3_INTERNAL_ERROR: u32 = 0x0102;
/// QPACK_DECOMPRESSION_FAILED (RFC 9204 §7.4).
const QPACK_DECOMPRESSION_FAILED: u32 = 0x0200;
/// QPACK_ENCODER_STREAM_ERROR (RFC 9204 §7.4).
const QPACK_ENCODER_STREAM_ERROR: u32 = 0x0201;
const MAX_PENDING_EVENTS: usize = 65_536;

#[derive(Default)]
struct CapacityWaitQueue {
    order: VecDeque<u32>,
    present: HashSet<u32>,
}

impl CapacityWaitQueue {
    fn enqueue(&mut self, conn: u32) {
        if self.present.insert(conn) {
            self.order.push_back(conn);
        }
    }

    fn pop_front(&mut self) -> Option<u32> {
        let conn = self.order.pop_front()?;
        self.present.remove(&conn);
        Some(conn)
    }

    fn len(&self) -> usize {
        self.order.len()
    }
}

/// Result of trying to read one H3 frame header from a buffer.
enum FrameHdr {
    /// Not enough bytes buffered yet — wait for more.
    Incomplete,
    /// Advertised length exceeds `MAX_H3_FRAME_SIZE`; the connection must close.
    TooLarge,
    Ready {
        header: usize,
        total: usize,
        is_headers: bool,
    },
}

impl WtEndpoint {
    fn datagram_event_charge(data: &[u8]) -> usize {
        data.len().max(1)
    }

    fn stream_event_charge(data: &[u8], fin: bool) -> usize {
        if data.is_empty() && fin {
            0
        } else {
            data.len().max(1)
        }
    }

    /// Test/dev constructor. CLIENT endpoints built this way accept ANY server
    /// certificate — production clients must use [`Self::new_client_pinned`].
    pub fn new(is_server: bool, _addr: SocketAddr, peer_addr: SocketAddr) -> Result<Self, String> {
        Self::new_with_limits_and_rate_limits(
            is_server,
            _addr,
            peer_addr,
            WasmLimits::default(),
            WasmRateLimits::default(),
        )
    }

    pub fn new_with_limits(
        is_server: bool,
        _addr: SocketAddr,
        peer_addr: SocketAddr,
        limits: WasmLimits,
    ) -> Result<Self, String> {
        Self::new_with_limits_and_rate_limits(
            is_server,
            _addr,
            peer_addr,
            limits,
            WasmRateLimits::default(),
        )
    }

    pub fn new_with_limits_and_rate_limits(
        is_server: bool,
        _addr: SocketAddr,
        peer_addr: SocketAddr,
        limits: WasmLimits,
        rate_limits: WasmRateLimits,
    ) -> Result<Self, String> {
        Self::new_with_limits_rate_limits_and_0rtt(
            is_server,
            _addr,
            peer_addr,
            limits,
            rate_limits,
            false,
        )
    }

    /// Same as [`Self::new_with_limits_and_rate_limits`] with opt-in 0-RTT.
    pub fn new_with_limits_rate_limits_and_0rtt(
        is_server: bool,
        _addr: SocketAddr,
        peer_addr: SocketAddr,
        limits: WasmLimits,
        rate_limits: WasmRateLimits,
        enable_0rtt: bool,
    ) -> Result<Self, String> {
        let server_cfg = if is_server {
            Some(spike::server_crypto()?.0)
        } else {
            None
        };
        Self::build(
            is_server,
            peer_addr,
            server_cfg,
            None,
            limits,
            rate_limits,
            enable_0rtt,
        )
    }

    /// Production client: pins the server certificate by SHA-256 of its DER
    /// (the browser's `serverCertificateHashes` trust model). The handshake
    /// fails unless the server presents a cert matching one of `hashes`.
    pub fn new_client_pinned(peer_addr: SocketAddr, hashes: Vec<[u8; 32]>) -> Result<Self, String> {
        Self::new_client_pinned_with_limits_and_rate_limits(
            peer_addr,
            hashes,
            WasmLimits::default(),
            WasmRateLimits::default(),
        )
    }

    pub fn new_client_pinned_with_limits(
        peer_addr: SocketAddr,
        hashes: Vec<[u8; 32]>,
        limits: WasmLimits,
    ) -> Result<Self, String> {
        Self::new_client_pinned_with_limits_and_rate_limits(
            peer_addr,
            hashes,
            limits,
            WasmRateLimits::default(),
        )
    }

    pub fn new_client_pinned_with_limits_and_rate_limits(
        peer_addr: SocketAddr,
        hashes: Vec<[u8; 32]>,
        limits: WasmLimits,
        rate_limits: WasmRateLimits,
    ) -> Result<Self, String> {
        Self::new_client_pinned_with_limits_rate_limits_and_0rtt(
            peer_addr,
            hashes,
            limits,
            rate_limits,
            false,
        )
    }

    /// Pinned client with opt-in 0-RTT / early data.
    pub fn new_client_pinned_with_limits_rate_limits_and_0rtt(
        peer_addr: SocketAddr,
        hashes: Vec<[u8; 32]>,
        limits: WasmLimits,
        rate_limits: WasmRateLimits,
        enable_0rtt: bool,
    ) -> Result<Self, String> {
        let crypto = crate::verify::client_crypto_pinned(hashes)?;
        Self::build(
            false,
            peer_addr,
            None,
            Some(crypto),
            limits,
            rate_limits,
            enable_0rtt,
        )
    }

    /// Build a server endpoint with a freshly generated P-256 cert; returns the
    /// endpoint and the base64 SHA-256 of the cert DER for `serverCertificateHashes`.
    pub fn new_with_generated_cert(
        peer_addr: SocketAddr,
        common_name: &str,
        validity_days: u32,
        not_before_unix: i64,
    ) -> Result<(Self, String), String> {
        Self::new_with_generated_cert_with_limits(
            peer_addr,
            common_name,
            validity_days,
            not_before_unix,
            WasmLimits::default(),
        )
    }

    pub fn new_with_generated_cert_with_limits(
        peer_addr: SocketAddr,
        common_name: &str,
        validity_days: u32,
        not_before_unix: i64,
        limits: WasmLimits,
    ) -> Result<(Self, String), String> {
        Self::new_with_generated_cert_with_limits_and_rate_limits(
            peer_addr,
            common_name,
            validity_days,
            not_before_unix,
            limits,
            WasmRateLimits::default(),
        )
    }

    pub fn new_with_generated_cert_with_limits_and_rate_limits(
        peer_addr: SocketAddr,
        common_name: &str,
        validity_days: u32,
        not_before_unix: i64,
        limits: WasmLimits,
        rate_limits: WasmRateLimits,
    ) -> Result<(Self, String), String> {
        Self::new_with_generated_cert_with_limits_rate_limits_and_0rtt(
            peer_addr,
            common_name,
            validity_days,
            not_before_unix,
            limits,
            rate_limits,
            false,
        )
    }

    /// Generated-cert server with opt-in 0-RTT / early data.
    pub fn new_with_generated_cert_with_limits_rate_limits_and_0rtt(
        peer_addr: SocketAddr,
        common_name: &str,
        validity_days: u32,
        not_before_unix: i64,
        limits: WasmLimits,
        rate_limits: WasmRateLimits,
        enable_0rtt: bool,
    ) -> Result<(Self, String), String> {
        let gen = crate::cert::generate(common_name, validity_days, not_before_unix)?;
        let hash = crate::cert::sha256_base64(&gen.cert_der);
        let cfg = spike::server_config_from_der(gen.cert_der, gen.key_der)?;
        Ok((
            Self::build(
                true,
                peer_addr,
                Some(cfg),
                None,
                limits,
                rate_limits,
                enable_0rtt,
            )?,
            hash,
        ))
    }

    fn build(
        is_server: bool,
        peer_addr: SocketAddr,
        server_cfg: Option<rustls::ServerConfig>,
        client_crypto: Option<rustls::ClientConfig>,
        limits: WasmLimits,
        rate_limits: WasmRateLimits,
        enable_0rtt: bool,
    ) -> Result<Self, String> {
        limits.validate()?;
        rate_limits.validate()?;
        let governor = Governor::new(limits.clone())?;
        let rate_limiter = PeerRateLimiter::new(rate_limits, &limits)?;
        let handshake_timeout_ms = limits.handshake_timeout_ms;
        let idle_timeout_ms = limits.idle_timeout_ms;
        let ep_cfg = Arc::new(EndpointConfig::default());
        // Without an idle timeout a dead peer is NEVER detected and readers
        // hang forever; keep-alives stop healthy-but-quiet sessions from
        // idling out. Timeouts surface through `next_timeout_ms`, which the JS
        // driver already schedules.
        let mut tc = quinn_proto::TransportConfig::default();
        let idle_timeout = IdleTimeout::try_from(std::time::Duration::from_millis(idle_timeout_ms))
            .map_err(|_| "E_INTERNAL: idleTimeoutMs exceeds QUIC varint range".to_string())?;
        tc.max_idle_timeout(Some(idle_timeout));
        tc.keep_alive_interval(Some(std::time::Duration::from_millis(
            KEEP_ALIVE_INTERVAL_MS.min((idle_timeout_ms / 3).max(1)),
        )));
        let transport = Arc::new(tc);
        let ticket_store = Arc::new(InMemoryTicketStore::new(256));
        let (inner, client_config) = if is_server {
            let mut cfg =
                server_cfg.ok_or_else(|| "E_INTERNAL: server config required".to_string())?;
            configure_server_early_data(&mut cfg, enable_0rtt, ticket_store);
            let qsc = quinn_proto::crypto::rustls::QuicServerConfig::try_from(cfg)
                .map_err(|error| format!("E_INTERNAL: invalid QUIC server config: {error}"))?;
            let mut server_config = ServerConfig::with_crypto(Arc::new(qsc));
            server_config.transport = transport;
            (
                Endpoint::new(ep_cfg, Some(Arc::new(server_config)), true, None),
                None,
            )
        } else {
            let mut crypto = match client_crypto {
                Some(crypto) => crypto,
                None => spike::client_crypto()
                    .map_err(|error| format!("E_INTERNAL: client crypto config: {error}"))?,
            };
            configure_client_early_data(&mut crypto, enable_0rtt, ticket_store);
            let qcc = quinn_proto::crypto::rustls::QuicClientConfig::try_from(crypto)
                .map_err(|error| format!("E_INTERNAL: invalid QUIC client config: {error}"))?;
            let mut client_config = ClientConfig::new(Arc::new(qcc));
            client_config.transport_config(transport);
            (Endpoint::new(ep_cfg, None, true, None), Some(client_config))
        };
        Ok(Self {
            inner,
            is_server,
            peer_addr,
            conns: HashMap::new(),
            sessions: HashMap::new(),
            handle_to_id: HashMap::new(),
            id_to_handle: HashMap::new(),
            next_id: 1,
            stream_index: HashMap::new(),
            rev_index: HashMap::new(),
            paused: HashSet::new(),
            half_done: HashMap::new(),
            next_stream: 1,
            events: VecDeque::new(),
            event_reservations: VecDeque::new(),
            client_config,
            endpoint_tx: Vec::new(),
            governor,
            rate_limiter,
            handshake_reservations: HashMap::new(),
            session_reservations: HashMap::new(),
            stream_reservations: HashMap::new(),
            capacity_waiters: CapacityWaitQueue::default(),
            handshake_timeout_ms,
            idle_timeout_ms,
            wt_max_sessions: WT_MAX_SESSIONS_DEFAULT,
            enable_0rtt,
            last_error: None,
        })
    }

    /// Client: start a QUIC connection to the peer. Returns the connection id,
    /// or -1 if this is a server endpoint or quinn rejects the connect params
    /// (never panics — a wasm panic would poison the whole registry).
    pub fn connect(&mut self, authority: &str) -> i64 {
        let Some(cfg) = self.client_config.clone() else {
            self.set_last_error("E_INTERNAL: client config unavailable");
            return -1;
        };
        let now = Instant::now();
        let (handshake, session_reservation) = match self.admit_new_connection(now, None) {
            Ok(pair) => pair,
            Err(err) => {
                self.set_last_error(err);
                return -1;
            }
        };
        let (handle, conn) = match self.inner.connect(now, cfg, self.peer_addr, "localhost") {
            Ok(pair) => pair,
            Err(_) => {
                self.set_last_error("E_INTERNAL: quic connect rejected");
                return -1;
            }
        };
        let id = match self.register(handle) {
            Ok(id) => id,
            Err(err) => {
                self.set_last_error(err);
                return -1;
            }
        };
        self.conns.insert(handle, conn);
        let mut session = Session::default();
        authority.clone_into(&mut session.authority);
        session.connect_deadline =
            Some(now + std::time::Duration::from_millis(self.handshake_timeout_ms));
        self.sessions.insert(handle, session);
        self.handshake_reservations.insert(handle, handshake);
        self.session_reservations
            .insert(handle, session_reservation);
        i64::from(id)
    }

    fn register(&mut self, handle: ConnectionHandle) -> Result<u32, String> {
        let id = self.next_id;
        self.next_id = self
            .next_id
            .checked_add(1)
            .ok_or_else(|| "E_LIMIT_EXCEEDED: connection id space exhausted".to_string())?;
        self.handle_to_id.insert(handle, id);
        self.id_to_handle.insert(id, handle);
        Ok(id)
    }

    pub(crate) fn set_last_error(&mut self, error: impl Into<String>) {
        self.last_error = Some(error.into());
    }

    pub fn take_last_error(&mut self) -> Option<String> {
        self.last_error.take()
    }

    /// Configure SETTINGS_WT_MAX_SESSIONS (per QUIC connection). Clamped to
    /// `1..=WT_MAX_SESSIONS_HARD_CAP`. Must be called before the peer handshake
    /// completes so the control preamble advertises the intended value.
    pub fn set_wt_max_sessions(&mut self, max_sessions: u64) {
        self.wt_max_sessions = clamp_wt_max_sessions(max_sessions);
    }

    pub fn wt_max_sessions(&self) -> u64 {
        self.wt_max_sessions
    }

    /// Whether this endpoint was built with `enable0Rtt` / early data enabled.
    pub fn enable_0rtt(&self) -> bool {
        self.enable_0rtt
    }

    /// Client: whether the connection currently has 0-RTT keys (ticket present).
    /// Does not imply the peer accepted early data.
    pub fn conn_has_0rtt(&self, conn_id: u32) -> bool {
        self.id_to_handle
            .get(&conn_id)
            .and_then(|h| self.conns.get(h))
            .is_some_and(|c| c.has_0rtt())
    }

    /// Client: whether the peer accepted 0-RTT data for this connection.
    pub fn conn_accepted_0rtt(&self, conn_id: u32) -> bool {
        self.id_to_handle
            .get(&conn_id)
            .and_then(|h| self.conns.get(h))
            .is_some_and(|c| c.accepted_0rtt())
    }

    pub fn release_host_token(&mut self, token: u32) -> bool {
        let Some((_conn, _stream)) = self.governor.release_host_token_with_context(token) else {
            return false;
        };
        self.resume_waiting_after_capacity_change();
        true
    }

    fn enqueue_capacity_waiter(&mut self, h: ConnectionHandle) {
        if let Some(&conn) = self.handle_to_id.get(&h) {
            self.capacity_waiters.enqueue(conn);
        }
    }

    fn resume_waiting_after_capacity_change(&mut self) {
        if self.capacity_waiters.len() == 0 {
            return;
        }
        let now = Instant::now();
        for _ in 0..MAX_WAITERS_WOKEN_PER_CAPACITY_CHANGE {
            let Some(conn) = self.capacity_waiters.pop_front() else {
                break;
            };
            let Some(&handle) = self.id_to_handle.get(&conn) else {
                continue;
            };
            self.drain_datagrams(handle, now);
            self.read_streams(handle, now);
            if self.events.len() >= MAX_PENDING_EVENTS {
                break;
            }
        }
    }

    fn has_event_slot_capacity(&self, slots: usize) -> bool {
        self.events.len().saturating_add(slots) <= MAX_PENDING_EVENTS
    }

    fn required_event_slots_for_read(&self, h: ConnectionHandle, id: StreamId) -> usize {
        if self
            .sessions
            .get(&h)
            .and_then(|s| s.self_bidi.get(&id))
            .is_some()
        {
            return 1;
        }
        let Some(session) = self.sessions.get(&h) else {
            return 0;
        };
        let Some(stream) = session.in_streams.get(&id) else {
            return 0;
        };
        required_slots_for_in_stream(stream.kind, stream.is_bidi, stream.handle.is_some())
    }

    pub fn governor_snapshot_json(&self) -> String {
        let snapshot = self.governor.snapshot(0, None);
        let rate_limit_snapshot: RateLimitSnapshot = self.rate_limiter.snapshot();
        serde_json::json!({
            "sessionsActive": snapshot.sessions_active,
            "handshakesInFlight": snapshot.handshakes_in_flight,
            "streamsActiveGlobal": snapshot.streams_active_global,
            "queuedBytesGlobal": snapshot.queued_bytes_global,
            "hostTokensActive": snapshot.host_tokens_active,
            "rateLimitBucketCount": rate_limit_snapshot.bucket_count,
            "rateLimitedHandshakeCount": rate_limit_snapshot.rate_limited_handshake_count,
            "rateLimitedStreamOpenCount": rate_limit_snapshot.rate_limited_stream_open_count,
            "rateLimitedDatagramIngressCount": rate_limit_snapshot.rate_limited_datagram_ingress_count,
            "handshakeTimeoutMs": self.handshake_timeout_ms,
            "idleTimeoutMs": self.idle_timeout_ms,
        })
        .to_string()
    }

    /// The configured peer address (single-server target for clients, or the
    /// fallback source for callers that cannot supply a real datagram source).
    pub fn peer_addr(&self) -> SocketAddr {
        self.peer_addr
    }

    /// Feed an inbound UDP datagram into the QUIC endpoint. `source` is the real
    /// remote address the datagram came from; quinn-proto routes by it.
    pub fn recv(&mut self, now: Instant, source: SocketAddr, data: &[u8]) {
        let mut resp = Vec::new();
        let buf = BytesMut::from(data);
        // Drive only the connection this packet belongs to — quinn names it —
        // rather than every connection on a multi-client endpoint.
        let mut affected: Option<ConnectionHandle> = None;
        if let Some(ev) = self.inner.handle(now, source, None, None, buf, &mut resp) {
            match ev {
                DatagramEvent::NewConnection(incoming) => {
                    let mut accept_buf = Vec::new();
                    let source_for_admit = self.is_server.then_some(source);
                    let (handshake, session) =
                        match self.admit_new_connection(now, source_for_admit) {
                            Ok(pair) => pair,
                            Err(err) => {
                                self.set_last_error(err);
                                let transmit = self.inner.refuse(incoming, &mut accept_buf);
                                self.endpoint_tx.push((accept_buf, transmit.destination));
                                return;
                            }
                        };
                    match self.inner.accept(incoming, now, &mut accept_buf, None) {
                        Ok((handle, conn)) => {
                            let id = match self.register(handle) {
                                Ok(id) => id,
                                Err(err) => {
                                    self.set_last_error(err);
                                    return;
                                }
                            };
                            self.conns.insert(handle, conn);
                            self.sessions.insert(handle, Session::default());
                            if self.is_server {
                                if let Err(err) =
                                    self.rate_limiter.attach_connection(id, source, now)
                                {
                                    self.set_last_error(err);
                                    self.close_conn(id, 0, b"rate limited", now);
                                    return;
                                }
                            }
                            self.handshake_reservations.insert(handle, handshake);
                            self.session_reservations.insert(handle, session);
                            affected = Some(handle);
                        }
                        Err(err) => {
                            // Deliver the rejection (CONNECTION_CLOSE / retry) so
                            // the client fails fast instead of timing out.
                            push_transmit_if_ready(
                                &mut self.endpoint_tx,
                                accept_buf,
                                err.response.map(|t| t.destination),
                            );
                        }
                    }
                }
                DatagramEvent::ConnectionEvent(handle, ce) => {
                    if let Some(conn) = self.conns.get_mut(&handle) {
                        conn.handle_event(ce);
                        affected = Some(handle);
                    }
                }
                DatagramEvent::Response(t) => {
                    push_transmit_if_ready(&mut self.endpoint_tx, resp, Some(t.destination));
                }
            }
        }
        match affected {
            Some(h) => self.drive(h, now),
            None => self.drive_all(now),
        }
    }

    fn drive_all(&mut self, now: Instant) {
        let handles: Vec<ConnectionHandle> = self.conns.keys().copied().collect();
        for h in handles {
            self.drive(h, now);
        }
    }

    fn try_push_event(&mut self, ev: WtEvent) -> Result<(), String> {
        if self.events.len() >= MAX_PENDING_EVENTS {
            return Err("E_QUEUE_FULL: event queue item cap reached".to_string());
        }
        let reservation = match &ev {
            WtEvent::Datagram { conn, data } => self
                .governor
                .reserve_event_bytes(*conn, None, Self::datagram_event_charge(data))
                .map(Some),
            WtEvent::StreamData {
                conn,
                stream,
                fin,
                data,
            } => self
                .governor
                .reserve_event_bytes(*conn, Some(*stream), Self::stream_event_charge(data, *fin))
                .map(Some),
            _ => Ok(None),
        };
        match reservation {
            Ok(host_reservation) => {
                self.events.push_back(ev);
                self.event_reservations.push_back(host_reservation);
                Ok(())
            }
            Err(err) => Err(err),
        }
    }

    fn push_event(&mut self, ev: WtEvent) {
        if let Err(err) = self.try_push_event(ev) {
            self.set_last_error(err);
        }
    }

    fn drive(&mut self, h: ConnectionHandle, now: Instant) {
        loop {
            let ev = match self.conns.get_mut(&h) {
                Some(c) => c.poll(),
                None => return,
            };
            let Some(ev) = ev else { break };
            match ev {
                QuicEvent::Connected => {
                    let Some(&id) = self.handle_to_id.get(&h) else {
                        return;
                    };
                    self.push_event(WtEvent::Connected { conn: id });
                    self.on_connected(h);
                }
                QuicEvent::Stream(StreamEvent::Opened { dir }) => {
                    self.accept_streams(h, dir);
                }
                // quinn's Readable is edge-triggered and not reliably emitted for
                // freshly accepted streams here, so reads are driven by the scan
                // below rather than by this event.
                QuicEvent::Stream(StreamEvent::Readable { .. }) => {}
                QuicEvent::Stream(StreamEvent::Stopped { id, error_code }) => {
                    // Peer STOP_SENDING on OUR send half: writes will fail from
                    // now on. The recv half (if any) is untouched — this is NOT
                    // an inbound reset.
                    self.on_stream_stopped(h, id, clamp_varint_to_u32(error_code.into_inner()));
                }
                QuicEvent::DatagramReceived => {
                    self.drain_datagrams(h, now);
                }
                QuicEvent::ConnectionLost { reason } => {
                    self.on_connection_lost(h, reason, now);
                    return;
                }
                _ => {}
            }
        }
        self.accept_streams(h, Dir::Uni);
        self.accept_streams(h, Dir::Bi);
        // Drain datagrams BEFORE reading streams: read_streams may end the
        // session (CONNECT-stream FIN -> Closed), and a final datagram must be
        // surfaced ahead of that Closed rather than after it.
        self.drain_datagrams(h, now);
        self.read_streams(h, now);
    }

    /// Tear down one connection after quinn reports `ConnectionLost`.
    fn on_connection_lost(
        &mut self,
        h: ConnectionHandle,
        reason: quinn_proto::ConnectionError,
        now: Instant,
    ) {
        let Some(&id) = self.handle_to_id.get(&h) else {
            return;
        };
        // Surface any recv data/FIN buffered at loss time BEFORE tearing down —
        // otherwise a final payload that arrives in the same packet as
        // CONNECTION_CLOSE (or on a paused stream) is silently dropped. Unpause
        // only THIS connection's streams so a final drain runs.
        let unpause: Vec<u32> = self
            .stream_index
            .iter()
            .filter(|(_, &(sh, _))| sh == h)
            .map(|(&handle, _)| handle)
            .collect();
        for handle in unpause {
            self.paused.remove(&handle);
        }
        self.read_streams(h, now);
        // Surface the peer's application close code; transport-level losses
        // (idle timeout, protocol error) report 0. A locally initiated close
        // already emitted its Closed event in `close_conn`, so don't emit a
        // second one.
        if let Some((error, code)) = connection_lost_signal(&reason) {
            if let Some(error) = error {
                self.set_last_error(error);
            }
            self.push_event(WtEvent::Closed { conn: id, code });
        }
        // Flush any final frames (e.g. our own CONNECTION_CLOSE) before the
        // connection state is dropped.
        self.flush_conn_transmits(h, now);
        self.cleanup_connection(h, now);
    }

    /// Admission checks for a brand-new inbound QUIC connection (server) or the
    /// local connect path's mirrored budgets.
    fn admit_new_connection(
        &mut self,
        now: Instant,
        source: Option<SocketAddr>,
    ) -> Result<(Reservation, Reservation), String> {
        if let Some(source) = source {
            self.rate_limiter
                .check(now, source, RateLimitDimension::Handshake)?;
        }
        let handshake = self.governor.reserve_handshake()?;
        let session = self.governor.reserve_session(0)?;
        Ok((handshake, session))
    }

    /// Drop all per-connection state so a multi-client server does not leak.
    fn cleanup_connection(&mut self, h: ConnectionHandle, now: Instant) {
        self.conns.remove(&h);
        self.sessions.remove(&h);
        self.handshake_reservations.remove(&h);
        self.session_reservations.remove(&h);
        if let Some(id) = self.handle_to_id.remove(&h) {
            self.id_to_handle.remove(&id);
            self.rate_limiter.release_connection(id, now);
        }
        let paused = &mut self.paused;
        let half_done = &mut self.half_done;
        let rev_index = &mut self.rev_index;
        let stream_reservations = &mut self.stream_reservations;
        self.stream_index.retain(|handle, &mut (sh, sid)| {
            if sh == h {
                paused.remove(handle);
                half_done.remove(handle);
                rev_index.remove(&(sh, sid));
                stream_reservations.remove(handle);
                false
            } else {
                true
            }
        });
    }

    /// Close ONE connection with an application code + reason: the peer gets a
    /// CONNECTION_CLOSE frame (surfaced via `poll_transmits`) and the local
    /// side gets its Closed event. Other connections on the endpoint are
    /// untouched.
    pub fn close_conn(&mut self, conn_id: u32, code: u32, reason: &[u8], now: Instant) {
        let Some(&h) = self.id_to_handle.get(&conn_id) else {
            return;
        };
        if let Some(c) = self.conns.get_mut(&h) {
            c.close(now, VarInt::from_u32(code), Bytes::copy_from_slice(reason));
        }
        self.push_event(WtEvent::Closed {
            conn: conn_id,
            code,
        });
        // Flush the CONNECTION_CLOSE frame, then drop state immediately: a
        // sans-IO driver has no reason to sit in quinn's draining state — the
        // peer has its close frame (and the idle timeout covers its loss).
        self.flush_conn_transmits(h, now);
        self.cleanup_connection(h, now);
    }

    /// Close every connection (endpoint shutdown). Callers should pump
    /// transmits afterwards so the CONNECTION_CLOSE frames reach the wire.
    pub fn close_all(&mut self, code: u32, reason: &[u8], now: Instant) {
        let ids: Vec<u32> = self.id_to_handle.keys().copied().collect();
        for id in ids {
            self.close_conn(id, code, reason, now);
        }
        self.rate_limiter.clear();
    }

    /// Drain a single connection's pending transmits into `endpoint_tx` (used
    /// on the close path, where the connection is about to be dropped).
    fn flush_conn_transmits(&mut self, h: ConnectionHandle, now: Instant) {
        if let Some(conn) = self.conns.get_mut(&h) {
            drain_conn_transmits(conn, now, &mut self.endpoint_tx);
        }
    }

    /// Open our control stream + QPACK streams, and (client) the CONNECT stream.
    fn on_connected(&mut self, h: ConnectionHandle) {
        let Some(conn) = self.conns.get_mut(&h) else {
            return;
        };
        if let Some(ctrl) = conn.streams().open(Dir::Uni) {
            let preamble = h3::encode_control_preamble(self.wt_max_sessions);
            let _ = conn.send_stream(ctrl).write(&preamble);
            if let Some(s) = self.sessions.get_mut(&h) {
                s.control_send_stream = Some(ctrl);
            }
        }
        for st in [
            h3::stream_type::QPACK_ENCODER,
            h3::stream_type::QPACK_DECODER,
        ] {
            if let Some(id) = conn.streams().open(Dir::Uni) {
                let mut b = Vec::new();
                crate::varint::encode(st, &mut b);
                let _ = conn.send_stream(id).write(&b);
            }
        }
        if !self.is_server {
            if let Some(bidi) = conn.streams().open(Dir::Bi) {
                let authority = self
                    .sessions
                    .get(&h)
                    .map(|s| s.authority.clone())
                    .unwrap_or_default();
                let req = h3::encode_connect_request(&authority, "/");
                let _ = conn.send_stream(bidi).write(&req);
                if let Some(s) = self.sessions.get_mut(&h) {
                    s.connect_stream = Some(bidi);
                    s.connect_self_opened = true;
                }
            }
        }
    }

    fn accept_streams(&mut self, h: ConnectionHandle, dir: Dir) {
        loop {
            let id = match self.conns.get_mut(&h) {
                Some(c) => c.streams().accept(dir),
                None => return,
            };
            let Some(id) = id else { break };
            if let Some(s) = self.sessions.get_mut(&h) {
                s.in_streams.entry(id).or_insert(InStream {
                    kind: None,
                    is_bidi: dir == Dir::Bi,
                    sid_read: false,
                    handle: None,
                    buf: Vec::new(),
                });
            }
        }
    }

    /// Read every non-paused readable stream on a connection. CONNECT streams
    /// are processed LAST: a FIN on the primary ends the connection session
    /// (emitting Closed), and any WT stream data co-arriving in the same flight
    /// must be surfaced first so a final payload is not dropped behind Closed.
    fn read_streams(&mut self, h: ConnectionHandle, now: Instant) {
        let connect_ids: HashSet<StreamId> = self
            .sessions
            .get(&h)
            .map(|s| s.all_connect_streams().collect())
            .unwrap_or_default();
        let ids: Vec<StreamId> = {
            let Some(s) = self.sessions.get(&h) else {
                return;
            };
            let mut ids: Vec<StreamId> = s
                .in_streams
                .iter()
                .filter(|(id, st)| {
                    !connect_ids.contains(id)
                        && st.handle.is_none_or(|hd| !self.paused.contains(&hd))
                })
                .map(|(id, _)| *id)
                .collect();
            ids.extend(
                s.self_bidi
                    .iter()
                    .filter(|(id, hd)| !connect_ids.contains(id) && !self.paused.contains(hd))
                    .map(|(id, _)| *id),
            );
            ids
        };
        for id in ids {
            self.read_one(h, id, now);
        }
        // CONNECT streams last (server: in in_streams; client: self-opened).
        for cid in connect_ids {
            self.read_one(h, cid, now);
        }
    }

    /// Read and route one readable stream, dispatching by its category
    /// (peer-accepted control/qpack/CONNECT/WT, client self-opened CONNECT, or
    /// self-opened bidi WT reply half).
    fn read_one(&mut self, h: ConnectionHandle, id: StreamId, now: Instant) {
        // Client's self-opened CONNECT stream.
        let is_connect_self = self
            .sessions
            .get(&h)
            .map(|s| s.connect_self_opened && s.connect_stream == Some(id))
            .unwrap_or(false);
        if is_connect_self {
            let mut final_outcome = ReadOutcome::Open;
            for _ in 0..MAX_READ_BATCHES_PER_PUMP {
                let mut data = Vec::new();
                let outcome =
                    read_stream(self.conns.get_mut(&h), id, &mut data, PROTOCOL_READ_CHUNK);
                let made_progress = !data.is_empty();
                if made_progress {
                    if let Some(s) = self.sessions.get_mut(&h) {
                        s.connect_rx.extend_from_slice(&data);
                    }
                    self.parse_client_connect(h);
                }
                final_outcome = outcome;
                if should_stop_read_batch(outcome == ReadOutcome::Open, made_progress) {
                    break;
                }
            }
            // The peer FINning/resetting the CONNECT stream ends the WT session
            // (graceful close) even though the QUIC connection stays alive.
            if matches!(final_outcome, ReadOutcome::Finished | ReadOutcome::Reset(_)) {
                self.close_session_on_connect_end(h);
            }
            return;
        }

        // Peer-accepted streams (control / qpack / CONNECT / WT).
        let in_stream = self
            .sessions
            .get(&h)
            .map(|s| s.in_streams.contains_key(&id))
            .unwrap_or(false);
        if in_stream {
            let required_slots = self.required_event_slots_for_read(h, id);
            let is_connect_stream = self
                .sessions
                .get(&h)
                .map(|s| s.is_wt_connect(id))
                .unwrap_or(false);
            let is_primary_connect = self
                .sessions
                .get(&h)
                .map(|s| s.connect_stream == Some(id))
                .unwrap_or(false);
            let mut final_outcome = ReadOutcome::Open;
            for _ in 0..MAX_READ_BATCHES_PER_PUMP {
                if should_wait_for_event_slots(
                    required_slots,
                    self.has_event_slot_capacity(required_slots),
                ) {
                    self.set_last_error("E_QUEUE_FULL: event queue item cap reached");
                    self.enqueue_capacity_waiter(h);
                    return;
                }
                let read_limit = self.in_stream_read_limit(h, id);
                let mut data = Vec::new();
                let outcome = read_stream(self.conns.get_mut(&h), id, &mut data, read_limit);
                let made_progress = !data.is_empty();
                if should_backpressure_zero_progress_read(
                    read_limit,
                    made_progress,
                    outcome == ReadOutcome::Open,
                ) {
                    self.enqueue_capacity_waiter(h);
                    return;
                }
                self.process_in_stream(h, id, &data, outcome == ReadOutcome::Finished, now);
                final_outcome = outcome;
                if should_stop_read_batch(outcome == ReadOutcome::Open, made_progress) {
                    break;
                }
            }
            match final_outcome {
                ReadOutcome::Finished => self.retire_in_stream(h, id),
                ReadOutcome::Reset(code) => {
                    self.emit_stream_reset(h, id, clamp_varint_to_u32(code));
                    self.retire_in_stream(h, id);
                }
                ReadOutcome::Open => {}
            }
            // Primary CONNECT end tears down the QUIC connection session.
            // Extra-session CONNECT end only retires that WT session.
            if is_connect_stream
                && matches!(final_outcome, ReadOutcome::Finished | ReadOutcome::Reset(_))
            {
                self.on_connect_stream_ended(h, id, is_primary_connect);
            }
            return;
        }

        // Self-opened bidi WT stream (peer's reply half).
        let handle = self
            .sessions
            .get(&h)
            .and_then(|s| s.self_bidi.get(&id).copied());
        if let Some(handle) = handle {
            let Some(&conn) = self.handle_to_id.get(&h) else {
                return;
            };
            let mut final_outcome = ReadOutcome::Open;
            for _ in 0..MAX_READ_BATCHES_PER_PUMP {
                if !self.has_event_slot_capacity(1) {
                    self.set_last_error("E_QUEUE_FULL: event queue item cap reached");
                    self.enqueue_capacity_waiter(h);
                    return;
                }
                let read_limit = self.governor.available_event_bytes(conn, Some(handle));
                let mut data = Vec::new();
                let outcome = read_stream(self.conns.get_mut(&h), id, &mut data, read_limit);
                let made_progress = !data.is_empty();
                if should_backpressure_zero_progress_read(
                    read_limit,
                    made_progress,
                    outcome == ReadOutcome::Open,
                ) {
                    self.enqueue_capacity_waiter(h);
                    return;
                }
                let finished = outcome == ReadOutcome::Finished;
                if should_emit_self_bidi_chunk(made_progress, finished) {
                    self.push_event(WtEvent::StreamData {
                        conn,
                        stream: handle,
                        fin: finished,
                        data,
                    });
                }
                final_outcome = outcome;
                if should_stop_read_batch(outcome == ReadOutcome::Open, made_progress) {
                    break;
                }
            }
            match final_outcome {
                outcome => self.on_self_bidi_read_outcome(h, id, handle, conn, outcome),
            }
        }
    }

    fn on_self_bidi_read_outcome(
        &mut self,
        h: ConnectionHandle,
        id: StreamId,
        handle: u32,
        conn: u32,
        outcome: ReadOutcome,
    ) {
        match outcome {
            ReadOutcome::Finished => {
                if let Some(s) = self.sessions.get_mut(&h) {
                    s.self_bidi.remove(&id);
                }
                self.paused.remove(&handle);
                self.mark_stream_half_done(handle, HALF_RECV);
            }
            ReadOutcome::Reset(code) => {
                self.push_event(WtEvent::StreamReset {
                    conn,
                    stream: handle,
                    code: clamp_varint_to_u32(code),
                });
                if let Some(s) = self.sessions.get_mut(&h) {
                    s.self_bidi.remove(&id);
                }
                self.paused.remove(&handle);
                self.mark_stream_half_done(handle, HALF_RECV);
            }
            ReadOutcome::Open => {}
        }
    }

    fn on_connect_stream_ended(
        &mut self,
        h: ConnectionHandle,
        id: StreamId,
        is_primary_connect: bool,
    ) {
        if is_primary_connect {
            self.close_session_on_connect_end(h);
        } else if let Some(s) = self.sessions.get_mut(&h) {
            s.extra_sessions.remove(&id);
        }
    }

    /// Decide whether an inbound QUIC datagram payload should be delivered to
    /// the host for this session (quarter-session-id demux).
    fn datagram_payload_for_session(session: &Session, dg: &[u8]) -> Option<Vec<u8>> {
        let (qsid, payload) = h3::unwrap_datagram(dg)?;
        session.session_for_qsid(qsid)?;
        Some(payload.to_vec())
    }

    /// Maximum bytes this peer-accepted stream may consume right now. Stream
    /// type/session-id varints are classified one byte at a time so even a
    /// caller-configured one-byte queue limit cannot accidentally pull an
    /// unaccounted application payload into the parser buffer.
    fn in_stream_read_limit(&self, h: ConnectionHandle, id: StreamId) -> usize {
        let Some(session) = self.sessions.get(&h) else {
            return 0;
        };
        let Some(stream) = session.in_streams.get(&id) else {
            return 0;
        };
        let Some(kind) = stream.kind else {
            return 1;
        };
        if matches!(kind, h3::stream_type::WT_UNI | h3::frame::WT_BIDI) {
            if !stream.sid_read {
                return 1;
            }
            let Some(handle) = stream.handle else {
                return 0;
            };
            let Some(&conn) = self.handle_to_id.get(&h) else {
                return 0;
            };
            return self.governor.available_event_bytes(conn, Some(handle));
        }
        PROTOCOL_READ_CHUNK
    }

    /// Drop the read-side state of a finished/reset peer-accepted stream so it
    /// is no longer polled. Recv-only (uni) WT streams also release their
    /// write-side index entry — there is nothing left to address.
    fn retire_in_stream(&mut self, h: ConnectionHandle, id: StreamId) {
        let Some(s) = self.sessions.get_mut(&h) else {
            return;
        };
        if let Some(st) = s.in_streams.remove(&id) {
            if let Some(hd) = st.handle {
                self.paused.remove(&hd);
                self.mark_stream_half_done(hd, HALF_RECV);
            }
        }
    }

    /// Record that one half of a WT stream is done; when both halves are done
    /// the handle's index/pause/tracking state is released. Uni streams have
    /// their missing half pre-marked at registration, so they release on their
    /// single half's completion.
    fn mark_stream_half_done(&mut self, handle: u32, bit: u8) {
        let bits = self.half_done.entry(handle).or_insert(0);
        *bits |= bit;
        if *bits == HALF_RECV | HALF_SEND {
            self.half_done.remove(&handle);
            self.index_remove(handle);
            self.paused.remove(&handle);
            self.stream_reservations.remove(&handle);
        }
    }

    /// Insert a WT stream handle <-> (connection, quinn stream id) mapping into
    /// both the forward and reverse indexes.
    fn index_insert(&mut self, handle: u32, h: ConnectionHandle, sid: StreamId) {
        self.stream_index.insert(handle, (h, sid));
        self.rev_index.insert((h, sid), handle);
    }

    /// Remove a WT stream handle from both indexes.
    fn index_remove(&mut self, handle: u32) {
        if let Some((h, sid)) = self.stream_index.remove(&handle) {
            self.rev_index.remove(&(h, sid));
        }
    }

    /// Resolve a quinn StreamId to the WT stream handle it is surfaced as (O(1)).
    fn stream_handle_for(&self, h: ConnectionHandle, id: StreamId) -> Option<u32> {
        self.sessions
            .get(&h)
            .and_then(|s| {
                s.in_streams
                    .get(&id)
                    .and_then(|st| st.handle)
                    .or_else(|| s.self_bidi.get(&id).copied())
            })
            // Self-opened uni streams have no recv-side entry, only the index.
            .or_else(|| self.rev_index.get(&(h, id)).copied())
    }

    /// A graceful WebTransport session end (FIN/reset on the CONNECT stream)
    /// while the QUIC connection stays alive. Emit Closed once so awaiting
    /// `closed`/`ready` promises settle, and close the QUIC connection so the
    /// session + connection are reclaimed instead of lingering under keep-alive.
    /// Close a connection on a protocol violation (e.g. an oversized H3 frame).
    /// Emits `Closed` and tears down the QUIC connection. Uses graceful lookups
    /// — never panics / never poisons the registry.
    fn close_conn_protocol_error(&mut self, h: ConnectionHandle, code: u32, reason: &[u8]) {
        if let Some(&id) = self.handle_to_id.get(&h) {
            self.push_event(WtEvent::Closed { conn: id, code });
        }
        if let Some(c) = self.conns.get_mut(&h) {
            c.close(
                Instant::now(),
                VarInt::from_u32(code),
                Bytes::copy_from_slice(reason),
            );
        }
        self.release_connection_budget(h);
    }

    /// Release this connection's governor byte-budget NOW, without touching
    /// its state machine: quinn owns the connection until it surfaces
    /// `ConnectionLost`, but a burst of error-closes must not pin budget that
    /// admission decisions are made against across that window. Reservations
    /// release exactly once on drop, so the eventual `cleanup_connection` is a
    /// budget no-op. Rate-limiter connection counts are deliberately NOT
    /// released here — the connection still exists until quinn retires it, and
    /// freeing its per-host slot early would over-admit.
    fn release_connection_budget(&mut self, h: ConnectionHandle) {
        self.handshake_reservations.remove(&h);
        self.session_reservations.remove(&h);
        let stream_index = &self.stream_index;
        let stream_reservations = &mut self.stream_reservations;
        for (handle, &(sh, _)) in stream_index.iter() {
            if sh == h {
                stream_reservations.remove(handle);
            }
        }
    }

    fn close_session_on_connect_end(&mut self, h: ConnectionHandle) {
        let Some(&id) = self.handle_to_id.get(&h) else {
            return;
        };
        let already = self
            .sessions
            .get(&h)
            .map(|s| s.connect_closed)
            .unwrap_or(true);
        if already {
            return;
        }
        if let Some(s) = self.sessions.get_mut(&h) {
            s.connect_closed = true;
            s.extra_sessions.clear();
        }
        self.push_event(WtEvent::Closed { conn: id, code: 0 });
        // Tear down the QUIC connection too (drive() will surface
        // ConnectionLost::LocallyClosed, which is suppressed as a duplicate).
        if let Some(c) = self.conns.get_mut(&h) {
            c.close(Instant::now(), VarInt::from_u32(0), Bytes::new());
        }
        self.release_connection_budget(h);
    }

    /// Peer STOP_SENDING on our send half: surface the code and retire the
    /// send half. The recv half keeps flowing.
    fn on_stream_stopped(&mut self, h: ConnectionHandle, id: StreamId, code: u32) {
        if let Some(stream) = self.stream_handle_for(h, id) {
            let Some(&conn) = self.handle_to_id.get(&h) else {
                return;
            };
            self.push_event(WtEvent::StreamStopped { conn, stream, code });
            self.mark_stream_half_done(stream, HALF_SEND);
        }
    }

    /// Pause reading a WT stream: inbound data stays in quinn's recv buffer,
    /// letting QUIC flow control throttle the sender.
    pub fn stream_pause(&mut self, stream: u32) {
        self.paused.insert(stream);
    }

    /// Resume a paused WT stream and immediately drain what buffered.
    pub fn stream_resume(&mut self, stream: u32) {
        if self.paused.remove(&stream) {
            if let Some(&(h, _)) = self.stream_index.get(&stream) {
                self.read_streams(h, Instant::now());
            }
        }
    }

    /// Classify and process bytes on a peer-accepted stream.
    fn process_in_stream(
        &mut self,
        h: ConnectionHandle,
        id: StreamId,
        data: &[u8],
        finished: bool,
        now: Instant,
    ) {
        // Append, decode the leading stream/frame type, and route by kind.
        enum Route {
            Control,
            /// Peer QPACK encoder stream — feed dynamic-table inserts.
            QpackEncoder,
            /// A server-side H3 request (CONNECT) stream; parsed per-stream from
            /// its own InStream::buf so concurrent request streams never share a
            /// buffer and cannot interleave.
            ServerConnect {
                id: StreamId,
            },
            Ignore,
            WtData {
                handle: u32,
                payload: Vec<u8>,
                opened: Option<(u32, u32, bool)>,
            },
            RejectWt {
                error: String,
                bidi: bool,
            },
            None,
        }
        let route = 'route: {
            let Some(s) = self.sessions.get_mut(&h) else {
                return;
            };
            // Snapshot known WT session ids before borrowing `in_streams` mutably.
            let known_session_ids: HashSet<u64> = s.all_connect_streams().map(u64::from).collect();
            let Some(st) = s.in_streams.get_mut(&id) else {
                return;
            };
            st.buf.extend_from_slice(data);
            if st.kind.is_none() {
                if let Some((k, n)) = crate::varint::decode(&st.buf) {
                    st.kind = Some(k);
                    // A BIDI request stream (CONNECT) has no stream-type prefix —
                    // its first varint IS the HEADERS frame type, so keep it for
                    // the frame parser. Everything else (control/QPACK/WT stream
                    // type, or a uni whose first varint just happens to equal
                    // 0x01 == HEADERS, e.g. H3 PUSH) carries a type prefix we
                    // consume here.
                    if !(k == h3::frame::HEADERS && st.is_bidi) {
                        st.buf.drain(..n);
                    }
                } else {
                    return;
                }
            }
            match st.kind {
                Some(kind) => match classify_peer_stream_kind(kind, st.is_bidi) {
                    PeerStreamClass::Control => {
                        let drained = std::mem::take(&mut st.buf);
                        s.control_rx.extend_from_slice(&drained);
                        Route::Control
                    }
                    PeerStreamClass::ServerConnect => {
                        // Bytes stay in this stream's OWN buf; parsed per-stream.
                        Route::ServerConnect { id }
                    }
                    PeerStreamClass::QpackEncoder => {
                        let drained = std::mem::take(&mut st.buf);
                        s.qpack_encoder_rx.extend_from_slice(&drained);
                        Route::QpackEncoder
                    }
                    PeerStreamClass::QpackDecoder => {
                        // Decoder stream carries our peer's ACKs; we don't emit
                        // inserts that require acking yet — discard safely.
                        st.buf.clear();
                        Route::Ignore
                    }
                    PeerStreamClass::WebTransport => {
                        // Consume the session-id varint once, then stream is raw data.
                        // Reject streams that name an unknown / closed WT session.
                        if !st.sid_read {
                            if let Some((sid, n)) = crate::varint::decode(&st.buf) {
                                if !known_session_ids.contains(&sid) {
                                    st.buf.clear();
                                    break 'route Route::RejectWt {
                                        error: "E_SESSION_CLOSED: unknown WebTransport session id"
                                            .to_string(),
                                        bidi: st.is_bidi,
                                    };
                                }
                                st.sid_read = true;
                                st.buf.drain(..n);
                            } else if !finished {
                                return;
                            }
                        }
                        if st.sid_read {
                            let mut opened: Option<(u32, u32, bool)> = None;
                            if st.handle.is_none() {
                                let handle = self.next_stream;
                                let Some(next_stream) = self.next_stream.checked_add(1) else {
                                    st.buf.clear();
                                    break 'route Route::RejectWt {
                                        error: "E_LIMIT_EXCEEDED: stream handle space exhausted"
                                            .to_string(),
                                        bidi: st.is_bidi,
                                    };
                                };
                                let Some(&conn_id) = self.handle_to_id.get(&h) else {
                                    return;
                                };
                                let stream_kind = if st.is_bidi {
                                    StreamKind::Bidi
                                } else {
                                    StreamKind::Uni
                                };
                                if self.is_server {
                                    if let Err(err) = self.rate_limiter.check_connection(
                                        now,
                                        conn_id,
                                        RateLimitDimension::StreamOpen,
                                    ) {
                                        st.buf.clear();
                                        break 'route Route::RejectWt {
                                            error: err,
                                            bidi: st.is_bidi,
                                        };
                                    }
                                }
                                let reservation = match self.governor.reserve_stream(
                                    conn_id,
                                    handle,
                                    stream_kind,
                                ) {
                                    Ok(reservation) => reservation,
                                    Err(err) => {
                                        st.buf.clear();
                                        break 'route Route::RejectWt {
                                            error: err,
                                            bidi: st.is_bidi,
                                        };
                                    }
                                };
                                self.next_stream = next_stream;
                                st.handle = Some(handle);
                                // Inline (not index_insert): `st` still borrows
                                // self.sessions here, so we touch only the disjoint
                                // index fields directly.
                                self.stream_index.insert(handle, (h, id));
                                self.rev_index.insert((h, id), handle);
                                self.stream_reservations.insert(handle, reservation);
                                // Peer-opened uni has no send half on our side.
                                self.half_done
                                    .insert(handle, if st.is_bidi { 0 } else { HALF_SEND });
                                opened = Some((conn_id, handle, st.is_bidi));
                            }
                            // st.handle is Some here (set above or on a prior pass);
                            // fall back to Route::None rather than panicking if not.
                            match st.handle {
                                Some(handle) => {
                                    let payload = std::mem::take(&mut st.buf);
                                    Route::WtData {
                                        handle,
                                        payload,
                                        opened,
                                    }
                                }
                                None => Route::None,
                            }
                        } else {
                            Route::None
                        }
                    }
                    PeerStreamClass::Ignore => {
                        // Unknown/unsupported stream (incl. a uni whose type == 0x01,
                        // e.g. H3 PUSH): discard its bytes so the buffer can't grow
                        // without bound (a remote memory-exhaustion vector otherwise).
                        st.buf.clear();
                        Route::Ignore
                    }
                },
                None => Route::None,
            }
        };

        match route {
            Route::Control => self.parse_control(h),
            Route::QpackEncoder => {
                self.parse_qpack_encoder(h);
                // Inserts may unblock HEADERS waiting on Required Insert Count.
                self.retry_blocked_connects(h);
            }
            Route::ServerConnect { id } => self.parse_server_connect(h, id),
            Route::WtData {
                handle,
                payload,
                opened,
            } => {
                if let Some((conn, stream, bidi)) = opened {
                    self.push_event(WtEvent::StreamOpened { conn, stream, bidi });
                }
                if should_emit_stream_payload(payload.is_empty(), finished) {
                    let Some(&conn) = self.handle_to_id.get(&h) else {
                        return;
                    };
                    self.push_event(WtEvent::StreamData {
                        conn,
                        stream: handle,
                        fin: finished,
                        data: payload,
                    });
                }
            }
            Route::RejectWt { error, bidi } => {
                self.set_last_error(error);
                if let Some(conn) = self.conns.get_mut(&h) {
                    let _ = conn.recv_stream(id).stop(VarInt::from_u32(0));
                    if should_reset_send_on_wt_reject(bidi) {
                        let _ = conn.send_stream(id).reset(VarInt::from_u32(0));
                    }
                }
                self.retire_in_stream(h, id);
            }
            Route::Ignore | Route::None => {}
        }
    }

    fn parse_control(&mut self, h: ConnectionHandle) {
        let mut oversized = false;
        if let Some(s) = self.sessions.get_mut(&h) {
            loop {
                let buf = &s.control_rx;
                let Some((ftype, n1)) = crate::varint::decode(buf) else {
                    break;
                };
                let Some((flen, n2)) = crate::varint::decode(&buf[n1..]) else {
                    break;
                };
                // Bound the buffered frame: a peer advertising a huge length and
                // dribbling bytes would otherwise grow control_rx without limit.
                if flen > MAX_H3_FRAME_SIZE {
                    oversized = true;
                    break;
                }
                let header = n1 + n2;
                // Safe cast: flen <= MAX_H3_FRAME_SIZE (< usize::MAX on wasm32).
                let total = header + flen as usize;
                if buf.len() < total {
                    break;
                }
                if ftype == h3::frame::SETTINGS {
                    if let Some(ps) = h3::parse_settings(&buf[header..total]) {
                        s.peer_settings = Some(ps);
                    }
                }
                s.control_rx.drain(..total);
            }
        }
        if oversized {
            self.close_conn_protocol_error(h, H3_EXCESSIVE_LOAD, b"H3 control frame too large");
        }
    }

    /// Feed peer QPACK encoder-stream instructions into the dynamic table.
    fn parse_qpack_encoder(&mut self, h: ConnectionHandle) {
        let err = {
            let Some(s) = self.sessions.get_mut(&h) else {
                return;
            };
            if s.qpack_encoder_rx.len() > MAX_H3_FRAME_SIZE as usize {
                Some((
                    QPACK_ENCODER_STREAM_ERROR,
                    b"QPACK encoder stream too large".as_slice(),
                ))
            } else {
                match h3::feed_encoder_stream(&mut s.qpack_decoder, &s.qpack_encoder_rx) {
                    Ok(n) => {
                        s.qpack_encoder_rx.drain(..n);
                        None
                    }
                    Err(_) => Some((
                        QPACK_ENCODER_STREAM_ERROR,
                        b"QPACK encoder stream error".as_slice(),
                    )),
                }
            }
        };
        if let Some((code, reason)) = err {
            self.close_conn_protocol_error(h, code, reason);
        }
    }

    /// After encoder-stream inserts, retry request/CONNECT streams that may
    /// have been waiting on Required Insert Count.
    fn retry_blocked_connects(&mut self, h: ConnectionHandle) {
        let ids: Vec<StreamId> = self
            .sessions
            .get(&h)
            .map(|s| {
                s.in_streams
                    .iter()
                    .filter(|(_, st)| st.kind == Some(h3::frame::HEADERS) && st.is_bidi)
                    .map(|(id, _)| *id)
                    .collect()
            })
            .unwrap_or_default();
        for id in ids {
            self.parse_server_connect(h, id);
        }
        if self
            .sessions
            .get(&h)
            .map(|s| s.connect_self_opened && !s.connect_rx.is_empty())
            .unwrap_or(false)
        {
            self.parse_client_connect(h);
        }
    }

    /// Server: parse HEADERS frames from a request stream's OWN buffer
    /// (`in_streams[stream_id].buf`). Every complete frame is drained (a
    /// non-CONNECT request can never wedge), a real WebTransport CONNECT is
    /// answered with 200 and establishes a session (latching the CONNECT
    /// stream to `stream_id`) up to `wt_max_sessions`, and any other request
    /// is rejected with 404. Over-cap CONNECT is rejected with 429 +
    /// `E_LIMIT_EXCEEDED` (stable, no panic).
    fn parse_server_connect(&mut self, h: ConnectionHandle, stream_id: StreamId) {
        let Some(&id) = self.handle_to_id.get(&h) else {
            return;
        };
        loop {
            let hdr = {
                let Some(st) = self
                    .sessions
                    .get(&h)
                    .and_then(|s| s.in_streams.get(&stream_id))
                else {
                    return;
                };
                decode_frame_header(&st.buf)
            };
            let (header, total, is_headers) = match hdr {
                FrameHdr::Ready {
                    header,
                    total,
                    is_headers,
                } => (header, total, is_headers),
                FrameHdr::Incomplete => return,
                FrameHdr::TooLarge => {
                    self.close_conn_protocol_error(h, H3_EXCESSIVE_LOAD, b"H3 frame too large");
                    return;
                }
            };

            if !is_headers {
                if let Some(st) = self
                    .sessions
                    .get_mut(&h)
                    .and_then(|s| s.in_streams.get_mut(&stream_id))
                {
                    st.buf.drain(..total);
                }
                continue;
            }

            let decode_result = {
                let Some(s) = self.sessions.get(&h) else {
                    return;
                };
                let Some(st) = s.in_streams.get(&stream_id) else {
                    return;
                };
                h3::decode_field_section(&st.buf[header..total], &s.qpack_decoder)
            };
            match decode_result {
                Err(h3::QpackError::Blocked) => {
                    // Wait for encoder-stream inserts unless we advertised
                    // SETTINGS_QPACK_BLOCKED_STREAMS = 0 (no blocking allowed).
                    let max_blocked = self
                        .sessions
                        .get(&h)
                        .map(|s| s.qpack_decoder.max_blocked_streams())
                        .unwrap_or(0);
                    if qpack_blocking_forbidden(max_blocked) {
                        self.close_conn_protocol_error(
                            h,
                            QPACK_DECOMPRESSION_FAILED,
                            b"QPACK blocked streams not permitted",
                        );
                    }
                    return;
                }
                Err(h3::QpackError::Invalid) => {
                    self.close_conn_protocol_error(
                        h,
                        QPACK_DECOMPRESSION_FAILED,
                        b"QPACK decompression failed",
                    );
                    return;
                }
                Ok(headers) => {
                    if let Some(s) = self.sessions.get_mut(&h) {
                        if let Some(st) = s.in_streams.get_mut(&stream_id) {
                            st.buf.drain(..total);
                        }
                    }

                    let is_connect = headers_are_webtransport_connect(&headers);
                    if !is_connect {
                        if let Some(conn) = self.conns.get_mut(&h) {
                            let resp = h3::encode_status_response("404");
                            let _ = conn.send_stream(stream_id).write(&resp);
                            let _ = conn.send_stream(stream_id).finish();
                        }
                        continue;
                    }

                    let already_this = self
                        .sessions
                        .get(&h)
                        .map(|s| s.is_wt_connect(stream_id))
                        .unwrap_or(false);
                    if already_this {
                        continue;
                    }

                    let active = self
                        .sessions
                        .get(&h)
                        .map(|s| s.active_wt_count())
                        .unwrap_or(0);
                    if active >= self.wt_max_sessions as usize {
                        self.set_last_error("E_LIMIT_EXCEEDED: SETTINGS_WT_MAX_SESSIONS exceeded");
                        if let Some(conn) = self.conns.get_mut(&h) {
                            let resp = h3::encode_status_response("429");
                            let _ = conn.send_stream(stream_id).write(&resp);
                            let _ = conn.send_stream(stream_id).finish();
                        }
                        continue;
                    }

                    if let Some(conn) = self.conns.get_mut(&h) {
                        let resp = h3::encode_connect_response_ok();
                        let _ = conn.send_stream(stream_id).write(&resp);
                    }
                    if let Some(s) = self.sessions.get_mut(&h) {
                        if !s.established || s.connect_stream.is_none() {
                            s.connect_stream = Some(stream_id);
                            s.established = true;
                            s.connect_closed = false;
                        } else {
                            s.extra_sessions.insert(stream_id);
                        }
                    }
                    self.handshake_reservations.remove(&h);
                    self.push_event(WtEvent::SessionEstablished { conn: id });
                }
            }
        }
    }

    /// Client: parse the server's CONNECT response from `connect_rx` (the one
    /// self-opened CONNECT stream — never shared, so no interleaving). A 200
    /// establishes; any other final status closes the session so `ready`
    /// rejects instead of hanging.
    fn parse_client_connect(&mut self, h: ConnectionHandle) {
        let Some(&id) = self.handle_to_id.get(&h) else {
            return;
        };
        loop {
            let hdr = {
                let Some(s) = self.sessions.get(&h) else {
                    return;
                };
                decode_frame_header(&s.connect_rx)
            };
            let (header, total, is_headers) = match hdr {
                FrameHdr::Ready {
                    header,
                    total,
                    is_headers,
                } => (header, total, is_headers),
                FrameHdr::Incomplete => return,
                FrameHdr::TooLarge => {
                    self.close_conn_protocol_error(h, H3_EXCESSIVE_LOAD, b"H3 frame too large");
                    return;
                }
            };
            if !is_headers {
                if let Some(s) = self.sessions.get_mut(&h) {
                    s.connect_rx.drain(..total);
                }
                continue;
            }
            let (established, closed) = self
                .sessions
                .get(&h)
                .map(|s| (s.established, s.connect_closed))
                .unwrap_or((true, true));
            if closed {
                // Session already failed/closed; ignore further CONNECT frames
                // (a late 200 must not resurrect a discarded session).
                if let Some(s) = self.sessions.get_mut(&h) {
                    s.connect_rx.drain(..total);
                }
                continue;
            }
            let decode_result = {
                let Some(s) = self.sessions.get(&h) else {
                    return;
                };
                h3::decode_field_section(&s.connect_rx[header..total], &s.qpack_decoder)
            };
            let headers = match decode_result {
                Err(h3::QpackError::Blocked) => {
                    let max_blocked = self
                        .sessions
                        .get(&h)
                        .map(|s| s.qpack_decoder.max_blocked_streams())
                        .unwrap_or(0);
                    if qpack_blocking_forbidden(max_blocked) {
                        self.close_conn_protocol_error(
                            h,
                            QPACK_DECOMPRESSION_FAILED,
                            b"QPACK blocked streams not permitted",
                        );
                    }
                    return;
                }
                Err(h3::QpackError::Invalid) => {
                    self.close_conn_protocol_error(
                        h,
                        QPACK_DECOMPRESSION_FAILED,
                        b"QPACK decompression failed",
                    );
                    return;
                }
                Ok(headers) => {
                    if let Some(s) = self.sessions.get_mut(&h) {
                        s.connect_rx.drain(..total);
                    }
                    headers
                }
            };
            // Strictly parse the numeric :status (a malformed value is a bad
            // response, not an interim one).
            let status: Option<u16> = headers
                .iter()
                .find(|(k, _)| k == ":status")
                .and_then(|(_, v)| v.parse().ok());
            match classify_connect_status(status) {
                // 2xx establishes the WebTransport session.
                ConnectStatusKind::Success => {
                    if !established {
                        if let Some(s) = self.sessions.get_mut(&h) {
                            s.established = true;
                            s.connect_deadline = None; // handshake done
                        }
                        self.handshake_reservations.remove(&h);
                        self.push_event(WtEvent::SessionEstablished { conn: id });
                    }
                }
                // 1xx interim informational — wait for the final response (the
                // connect deadline still bounds an interim-only / silent server).
                ConnectStatusKind::Interim => {}
                // Any other final status, or an unparseable/missing one: the
                // session will never establish. Route through the graceful-close
                // helper (exactly one Closed, QUIC torn down, FIN then a no-op).
                ConnectStatusKind::Failure => {
                    if !established {
                        self.close_session_on_connect_end(h);
                        return;
                    }
                }
            }
        }
    }

    fn drain_datagrams(&mut self, h: ConnectionHandle, now: Instant) {
        let Some(&id) = self.handle_to_id.get(&h) else {
            return;
        };
        loop {
            if !self.has_event_slot_capacity(1) {
                self.enqueue_capacity_waiter(h);
                return;
            }
            if self.governor.available_event_bytes(id, None) == 0 {
                self.enqueue_capacity_waiter(h);
                return;
            }
            let dg = match self.conns.get_mut(&h) {
                Some(c) => c.datagrams().recv(),
                None => return,
            };
            let Some(dg) = dg else { break };
            // Demux by quarter-session-id: only deliver datagrams that map to a
            // live WT session on this connection (isolation between sessions).
            let Some(session) = self.sessions.get(&h) else {
                continue;
            };
            let Some(payload) = Self::datagram_payload_for_session(session, &dg) else {
                continue;
            };
            if self.is_server {
                if let Err(err) =
                    self.rate_limiter
                        .check_connection(now, id, RateLimitDimension::DatagramIngress)
                {
                    self.set_last_error(err);
                    self.close_conn(id, 0, b"rate limited", now);
                    break;
                }
            }
            if let Err(err) = self.try_push_event(WtEvent::Datagram {
                conn: id,
                data: payload,
            }) {
                self.set_last_error(err);
                self.close_conn(id, 0, b"inbound datagram budget exhausted", now);
                break;
            }
        }
    }

    fn emit_stream_reset(&mut self, h: ConnectionHandle, id: StreamId, code: u32) {
        if let Some(stream) = self.stream_handle_for(h, id) {
            let Some(&conn) = self.handle_to_id.get(&h) else {
                return;
            };
            self.push_event(WtEvent::StreamReset { conn, stream, code });
        }
    }

    /// Send a WebTransport datagram on the session's CONNECT context.
    pub fn send_datagram(&mut self, conn_id: u32, payload: &[u8]) -> bool {
        if datagram_payload_exceeds_caps(
            payload.len(),
            self.governor.limits().max_datagram_size,
            self.max_datagram_size(conn_id),
        ) {
            self.set_last_error("E_LIMIT_EXCEEDED: maxDatagramSize exceeded");
            return false;
        }
        let Some(&h) = self.id_to_handle.get(&conn_id) else {
            self.set_last_error("E_SESSION_CLOSED: unknown connection");
            return false;
        };
        let Some(connect_stream_id) = self
            .sessions
            .get(&h)
            .and_then(|s| s.connect_stream)
            .map(u64::from)
        else {
            self.set_last_error("E_SESSION_CLOSED: session not established");
            return false;
        };
        let framed = h3::wrap_datagram(connect_stream_id, payload);
        match self.conns.get_mut(&h) {
            Some(c) => match c.datagrams().send(Bytes::from(framed), true) {
                Ok(_) => true,
                Err(SendDatagramError::TooLarge) => {
                    self.set_last_error("E_LIMIT_EXCEEDED: maxDatagramSize exceeded");
                    false
                }
                Err(_) => {
                    self.set_last_error("E_QUEUE_FULL: datagram send queue blocked");
                    false
                }
            },
            None => {
                self.set_last_error("E_SESSION_CLOSED: connection missing");
                false
            }
        }
    }

    /// Effective WebTransport application payload cap for the current path.
    /// Quinn reports the full QUIC DATAGRAM payload cap, so remove the encoded
    /// quarter-session-id prefix before exposing it to callers.
    pub fn max_datagram_size(&mut self, conn_id: u32) -> Option<usize> {
        let configured = self.governor.limits().max_datagram_size;
        let &h = self.id_to_handle.get(&conn_id)?;
        let connect_stream_id = self.sessions.get(&h)?.connect_stream?;
        let context_len = h3::wrap_datagram(u64::from(connect_stream_id), &[]).len();
        let transport = self.conns.get_mut(&h)?.datagrams().max_size()?;
        Some(configured.min(transport.saturating_sub(context_len)))
    }

    /// Open a WebTransport stream. `bidi` selects bidirectional vs unidirectional.
    /// Returns the stream handle, or -1 on failure.
    pub fn open_stream(&mut self, conn_id: u32, bidi: bool) -> i32 {
        let Some(&h) = self.id_to_handle.get(&conn_id) else {
            self.set_last_error("E_SESSION_CLOSED: unknown connection");
            return -1;
        };
        let session_id = match self.sessions.get(&h).and_then(|s| s.connect_stream) {
            Some(id) => u64::from(id),
            None => {
                self.set_last_error("E_SESSION_CLOSED: session not established");
                return -1;
            }
        };
        let stream_kind = if bidi {
            StreamKind::Bidi
        } else {
            StreamKind::Uni
        };
        let dir = if bidi { Dir::Bi } else { Dir::Uni };
        let handle = self.next_stream;
        let Some(next_stream) = self.next_stream.checked_add(1) else {
            self.set_last_error("E_LIMIT_EXCEEDED: stream handle space exhausted");
            return -1;
        };
        // Reserve the application-visible capacity before opening the QUIC
        // stream. A rejected limit+1 open must not leave an untracked QUIC
        // stream (and its already-written WT header) alive behind the facade.
        let reservation = match self.governor.reserve_stream(conn_id, handle, stream_kind) {
            Ok(reservation) => reservation,
            Err(err) => {
                self.set_last_error(err);
                return -1;
            }
        };
        let Some(conn) = self.conns.get_mut(&h) else {
            self.set_last_error("E_SESSION_CLOSED: connection missing");
            return -1;
        };
        let Some(sid) = conn.streams().open(dir) else {
            self.set_last_error("E_LIMIT_EXCEEDED: stream capacity unavailable");
            return -1;
        };
        // WT stream header: signal type + session id.
        let mut header = Vec::new();
        let signal = if bidi {
            h3::frame::WT_BIDI
        } else {
            h3::stream_type::WT_UNI
        };
        crate::varint::encode(signal, &mut header);
        crate::varint::encode(session_id, &mut header);
        let _ = conn.send_stream(sid).write(&header);

        self.next_stream = next_stream;
        self.index_insert(handle, h, sid);
        // Self-opened uni has no recv half on our side.
        self.half_done
            .insert(handle, if bidi { 0 } else { HALF_RECV });
        if bidi {
            if let Some(s) = self.sessions.get_mut(&h) {
                s.self_bidi.insert(sid, handle);
            }
        }
        self.stream_reservations.insert(handle, reservation);
        handle as i32
    }

    /// Write to a WebTransport stream. Returns bytes accepted (possibly 0 when
    /// the flow-control window is closed — retry after a pump), or -1 on error.
    pub fn stream_write(&mut self, stream: u32, data: &[u8]) -> i64 {
        let Some(&(h, sid)) = self.stream_index.get(&stream) else {
            self.set_last_error("E_STREAM_RESET: unknown stream");
            return -1;
        };
        match self.conns.get_mut(&h) {
            Some(c) => match c.send_stream(sid).write(data) {
                Ok(n) => n as i64,
                Err(quinn_proto::WriteError::Blocked) => {
                    self.set_last_error("E_BACKPRESSURE_TIMEOUT: stream write blocked");
                    0
                }
                Err(_) => {
                    self.set_last_error("E_STREAM_RESET: stream write failed");
                    -1
                }
            },
            None => {
                self.set_last_error("E_SESSION_CLOSED: connection missing");
                -1
            }
        }
    }

    pub fn stream_finish(&mut self, stream: u32) {
        if let Some(&(h, sid)) = self.stream_index.get(&stream) {
            if let Some(c) = self.conns.get_mut(&h) {
                let _ = c.send_stream(sid).finish();
            }
            self.mark_stream_half_done(stream, HALF_SEND);
        }
    }

    pub fn stream_reset(&mut self, stream: u32, code: u32) {
        if let Some(&(h, sid)) = self.stream_index.get(&stream) {
            if let Some(c) = self.conns.get_mut(&h) {
                let _ = c.send_stream(sid).reset(VarInt::from_u32(code));
            }
            self.mark_stream_half_done(stream, HALF_SEND);
        }
    }

    /// STOP_SENDING on the recv half: tell the peer to stop sending on this
    /// stream (the WebTransport equivalent of cancelling a ReadableStream).
    pub fn stream_stop(&mut self, stream: u32, code: u32) {
        if let Some(&(h, sid)) = self.stream_index.get(&stream) {
            if let Some(c) = self.conns.get_mut(&h) {
                let _ = c.recv_stream(sid).stop(VarInt::from_u32(code));
            }
            self.paused.remove(&stream);
            self.mark_stream_half_done(stream, HALF_RECV);
        }
    }

    /// Drain outbound QUIC datagrams for all connections into `out`, each paired
    /// with the destination address quinn-proto chose for the packet.
    pub fn poll_transmits(&mut self, now: Instant, out: &mut Vec<(Vec<u8>, SocketAddr)>) {
        out.append(&mut self.endpoint_tx);
        let handles: Vec<ConnectionHandle> = self.conns.keys().copied().collect();
        for h in handles {
            if let Some(conn) = self.conns.get_mut(&h) {
                drain_conn_transmits(conn, now, out);
            }
        }
    }

    /// Milliseconds until the soonest connection timer, or -1 if none.
    pub fn next_timeout_ms(&mut self) -> f64 {
        let now = Instant::now();
        let mut soonest: Option<Instant> = None;
        for conn in self.conns.values_mut() {
            if let Some(t) = conn.poll_timeout() {
                soonest = sooner_deadline(soonest, t);
            }
        }
        // Pending CONNECT deadlines (unestablished client sessions).
        for s in self.sessions.values() {
            if should_track_connect_deadline(s.established, s.connect_closed) {
                if let Some(t) = s.connect_deadline {
                    soonest = sooner_deadline(soonest, t);
                }
            }
        }
        next_timeout_value(now, soonest)
    }

    pub fn handle_timeout(&mut self, now: Instant) {
        let handles: Vec<ConnectionHandle> = self.conns.keys().copied().collect();
        for h in &handles {
            let fire = self
                .conns
                .get_mut(h)
                .and_then(|c| c.poll_timeout())
                .map(|t| t <= now)
                .unwrap_or(false);
            if fire {
                if let Some(c) = self.conns.get_mut(h) {
                    c.handle_timeout(now);
                }
            }
        }
        // Fail any client session whose CONNECT deadline has passed unanswered.
        let expired: Vec<ConnectionHandle> = self
            .sessions
            .iter()
            .filter(|(_, s)| {
                connect_deadline_expired(s.established, s.connect_closed, s.connect_deadline, now)
            })
            .map(|(h, _)| *h)
            .collect();
        for h in expired {
            self.set_last_error("E_HANDSHAKE_TIMEOUT: WebTransport CONNECT timed out");
            self.close_session_on_connect_end(h);
        }
        self.drive_all(now);
    }

    pub fn poll_event(&mut self) -> Option<WtEvent> {
        let event = self.events.pop_front()?;
        let reservation = self.event_reservations.pop_front().flatten();
        drop(reservation);
        self.resume_waiting_after_capacity_change();
        Some(event)
    }

    pub fn poll_event_encoded(&mut self) -> Option<Vec<u8>> {
        loop {
            let event = self.events.pop_front()?;
            let token = match self.event_reservations.pop_front().flatten() {
                Some(reservation) => match self.governor.transfer_to_host(reservation) {
                    Ok(token) => Some(token),
                    Err(error) => {
                        // The payload can no longer reach the host (host-token
                        // space exhausted), so silently dropping it would
                        // desync the stream/datagram flow. Fail closed: tear
                        // down the affected connection so the loss surfaces as
                        // a Closed event instead of quiet data corruption.
                        self.set_last_error(error);
                        let conn = event.conn();
                        if self.id_to_handle.contains_key(&conn) {
                            self.close_conn(
                                conn,
                                H3_INTERNAL_ERROR,
                                b"host reservation token space exhausted",
                                Instant::now(),
                            );
                        } else {
                            // Connection state is already gone; still surface
                            // the dropped payload rather than staying silent.
                            self.push_event(WtEvent::Closed {
                                conn,
                                code: H3_INTERNAL_ERROR,
                            });
                        }
                        self.resume_waiting_after_capacity_change();
                        continue;
                    }
                },
                None => None,
            };
            self.resume_waiting_after_capacity_change();
            return Some(event.encode_with_host_token(token));
        }
    }
}

/// Read all currently-available ordered bytes from a recv stream into `out`.
/// Returns true when the stream has finished (FIN received).
/// Drain all packets a single connection wants to send into `out`, each paired
/// with the destination address quinn chose. Shared by the normal pump path
/// and the connection-close flush so their behavior can't diverge.
fn drain_conn_transmits(conn: &mut Connection, now: Instant, out: &mut Vec<(Vec<u8>, SocketAddr)>) {
    let mtu = conn.current_mtu() as usize;
    loop {
        let mut buf = Vec::with_capacity(mtu);
        match conn.poll_transmit(now, 1, &mut buf) {
            Some(t) => out.push((buf, t.destination)),
            None => break,
        }
    }
}

/// Decode an HTTP/3 frame header at the front of `buf`, returning
/// `(header_len, total_len, is_headers_frame)` once the WHOLE frame is present,
/// else None (incomplete). Does not consume `buf`.
fn decode_frame_header(buf: &[u8]) -> FrameHdr {
    let Some((ftype, n1)) = crate::varint::decode(buf) else {
        return FrameHdr::Incomplete;
    };
    let Some((flen, n2)) = crate::varint::decode(&buf[n1..]) else {
        return FrameHdr::Incomplete;
    };
    if flen > MAX_H3_FRAME_SIZE {
        return FrameHdr::TooLarge;
    }
    let header = n1 + n2;
    // Safe cast: flen <= MAX_H3_FRAME_SIZE, far below usize::MAX even on wasm32.
    let total = header + flen as usize;
    if buf.len() < total {
        return FrameHdr::Incomplete;
    }
    FrameHdr::Ready {
        header,
        total,
        is_headers: ftype == h3::frame::HEADERS,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ReadOutcome {
    /// Stream still open; more data may follow.
    Open,
    /// FIN reached and all data drained.
    Finished,
    /// Peer reset its send half with this error code.
    Reset(u64),
}

fn read_stream(
    conn: Option<&mut Connection>,
    id: StreamId,
    out: &mut Vec<u8>,
    max_bytes: usize,
) -> ReadOutcome {
    let Some(conn) = conn else {
        return ReadOutcome::Open;
    };
    let mut rs = conn.recv_stream(id);
    let mut chunks = match rs.read(true) {
        Ok(c) => c,
        // Already fully consumed and retired by quinn.
        Err(quinn_proto::ReadableError::ClosedStream) => return ReadOutcome::Finished,
        Err(_) => return ReadOutcome::Open,
    };
    let mut outcome = ReadOutcome::Open;
    // Queue capacity governs payload bytes, not terminal stream state. Probe
    // with a zero-length read when the byte budget is full: quinn reports FIN
    // or RESET without consuming buffered payload, while a pending data chunk
    // yields an empty chunk and remains under transport flow control.
    if max_bytes == 0 {
        outcome = match chunks.next(0) {
            Ok(None) => ReadOutcome::Finished,
            Err(quinn_proto::ReadError::Reset(code)) => ReadOutcome::Reset(code.into_inner()),
            Ok(Some(_)) | Err(_) => ReadOutcome::Open,
        };
        let _ = chunks.finalize();
        return outcome;
    }
    while out.len() < max_bytes {
        let remaining = max_bytes - out.len();
        match chunks.next(remaining) {
            Ok(Some(chunk)) => {
                if !chunk_carries_payload(chunk.bytes.len()) {
                    break;
                }
                out.extend_from_slice(&chunk.bytes);
            }
            Ok(None) => {
                outcome = ReadOutcome::Finished;
                break;
            }
            Err(quinn_proto::ReadError::Reset(code)) => {
                outcome = ReadOutcome::Reset(code.into_inner());
                break;
            }
            Err(_) => break,
        }
    }
    let _ = chunks.finalize();
    outcome
}

#[cfg(test)]
#[path = "endpoint_tests.rs"]
mod tests;
