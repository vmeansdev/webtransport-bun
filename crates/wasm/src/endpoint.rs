//! Sans-IO WebTransport endpoint: quinn-proto QUIC + a minimal H3/WT session
//! layer. JS owns UDP, timers, and event pumping; this type is pure protocol.

use std::collections::{HashMap, HashSet, VecDeque};
use std::net::SocketAddr;
use std::sync::{Arc, OnceLock};

use bytes::{Bytes, BytesMut};
use quinn_proto::{
    ClientConfig, Connection, ConnectionHandle, DatagramEvent, Dir, Endpoint, EndpointConfig,
    Event as QuicEvent, IdleTimeout, SendDatagramError, ServerConfig, StreamEvent, StreamId,
    VarInt,
};
use web_time::Instant;

use crate::congestion::CongestionControlMode;
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

/// Opt-in process-local shared ticket store for Bun loopback client+server
/// (`shareProcess0RttTicketStore: true`). Default is per-endpoint isolation.
fn shared_0rtt_ticket_store() -> Arc<InMemoryTicketStore> {
    static STORE: OnceLock<Arc<InMemoryTicketStore>> = OnceLock::new();
    STORE
        .get_or_init(|| Arc::new(InMemoryTicketStore::new(256)))
        .clone()
}

/// TLS SNI / ticket-store key from a WebTransport authority.
///
/// Strips a trailing `:port` (including bracketed IPv6). Quinn `connect` and
/// ticket hydrate/dump must use the same host so 0-RTT tickets key correctly
/// for non-localhost authorities.
pub(crate) fn tls_server_name_from_authority(authority: &str) -> Option<String> {
    let authority = authority.trim();
    if authority.is_empty() {
        return None;
    }
    let host = if let Some(rest) = authority.strip_prefix('[') {
        match rest.find(']') {
            Some(end) => &rest[..end],
            None => authority,
        }
    } else if let Some((h, port)) = authority.rsplit_once(':') {
        if !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) {
            h
        } else {
            authority
        }
    } else {
        authority
    };
    let host = host.trim();
    if host.is_empty() {
        None
    } else {
        Some(host.to_string())
    }
}

#[cfg(test)]
pub(crate) fn shared_0rtt_client_ticket_count(server_name: &str) -> usize {
    let Some(host) = tls_server_name_from_authority(server_name) else {
        return 0;
    };
    shared_0rtt_ticket_store().client_ticket_count(&host)
}

fn ticket_store_for_0rtt(share_process: bool) -> Arc<InMemoryTicketStore> {
    if share_process {
        shared_0rtt_ticket_store()
    } else {
        Arc::new(InMemoryTicketStore::new(256))
    }
}

/// Process-shared quinn [`ClientConfig`] for `shareProcess0RttTicketStore`.
/// Reusing the same config (not only the ticket store) is required for a fresh
/// endpoint to offer 0-RTT from tickets minted by a prior endpoint.
fn shared_0rtt_accept_any_client_config() -> Result<ClientConfig, String> {
    static CFG: OnceLock<ClientConfig> = OnceLock::new();
    if let Some(cfg) = CFG.get() {
        return Ok(cfg.clone());
    }
    let mut crypto = spike::client_crypto()
        .map_err(|error| format!("E_INTERNAL: client crypto config: {error}"))?;
    configure_client_early_data(&mut crypto, true, shared_0rtt_ticket_store());
    let qcc = quinn_proto::crypto::rustls::QuicClientConfig::try_from(crypto)
        .map_err(|error| format!("E_INTERNAL: invalid QUIC client config: {error}"))?;
    let mut client_config = ClientConfig::new(Arc::new(qcc));
    let mut tc = quinn_proto::TransportConfig::default();
    let idle = IdleTimeout::try_from(std::time::Duration::from_millis(30_000))
        .map_err(|_| "E_INTERNAL: shared 0-RTT idle timeout".to_string())?;
    tc.max_idle_timeout(Some(idle));
    tc.keep_alive_interval(Some(std::time::Duration::from_millis(
        KEEP_ALIVE_INTERVAL_MS,
    )));
    CongestionControlMode::Default.apply(&mut tc);
    client_config.transport_config(Arc::new(tc));
    let _ = CFG.set(client_config.clone());
    Ok(client_config)
}

/// A peer-accepted stream being classified and read.
struct InStream {
    /// First varint on the stream: H3 stream/frame type. None until decoded.
    kind: Option<u64>,
    is_bidi: bool,
    /// For WT streams: whether the session-id varint has been consumed.
    sid_read: bool,
    /// WT session id (CONNECT stream id) once the sid varint is read.
    wt_session_id: Option<u64>,
    /// WT stream handle once classified as a WebTransport stream.
    handle: Option<u32>,
    /// Server request/CONNECT stream passed admission (cap + rate limit).
    connect_admitted: bool,
    buf: Vec<u8>,
}

/// Client secondary CONNECT awaiting a 200 response.
struct PendingClientConnect {
    rx: Vec<u8>,
    deadline: Option<Instant>,
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
    /// Client: secondary CONNECTs awaiting SETTINGS/200 (keyed by stream id).
    pending_client_connects: HashMap<StreamId, PendingClientConnect>,
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
    /// Inbound QPACK decoder-stream bytes (peer ACKs / ICI).
    qpack_decoder_rx: Vec<u8>,
    /// Our outbound QPACK decoder stream (for section acks / ICI).
    qpack_decoder_send: Option<StreamId>,
    /// Our outbound QPACK encoder stream (capacity / inserts).
    qpack_encoder_send: Option<StreamId>,
    /// Decoder-side dynamic QPACK table (matches advertised SETTINGS; default 0).
    qpack_decoder: h3::QpackDecoder,
    /// Encoder-side dynamic QPACK table for outbound HEADERS when capacity > 0.
    qpack_encoder: h3::QpackEncoder,
    /// Header streams currently waiting on QPACK inserts (Blocked). Counted
    /// against SETTINGS_QPACK_BLOCKED_STREAMS.
    qpack_blocked_streams: HashSet<StreamId>,
    /// Stream id → Required Insert Count for sections we emitted (section-ack → KRC).
    pending_section_ric: HashMap<u64, u64>,
    /// Peer-accepted streams (uni + bidi) being classified/read.
    in_streams: HashMap<StreamId, InStream>,
    /// Self-opened bidi WT streams: id -> handle (inbound is raw WT data).
    self_bidi: HashMap<StreamId, u32>,
}

impl Session {
    /// Count of live + pending WebTransport sessions on this QUIC connection.
    /// Pending client CONNECTs count toward `SETTINGS_WT_MAX_SESSIONS` so
    /// callers cannot open unbounded secondary streams while waiting on 200.
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
        primary + self.extra_sessions.len() + self.pending_client_connects.len()
    }

    fn is_wt_connect(&self, id: StreamId) -> bool {
        self.connect_stream == Some(id) || self.extra_sessions.contains(&id)
    }

    fn all_connect_streams(&self) -> impl Iterator<Item = StreamId> + '_ {
        self.connect_stream
            .into_iter()
            .chain(self.extra_sessions.iter().copied())
    }

    /// Established or pending client CONNECT stream ids (for close/abort).
    fn resolve_wt_session(&self, session_id: u64) -> Option<StreamId> {
        self.all_connect_streams()
            .chain(self.pending_client_connects.keys().copied())
            .find(|sid| u64::from(*sid) == session_id)
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
    /// WT stream handle -> session_id (for session-scoped teardown).
    stream_sessions: HashMap<u32, u64>,
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
    /// configs accept/offer early data with an [`InMemoryTicketStore`].
    enable_0rtt: bool,
    /// Hot-path ticket store when `enable_0rtt` (shared or per-endpoint).
    /// Retained so JS can dump/hydrate opaque client tickets across endpoints.
    ticket_store: Option<Arc<InMemoryTicketStore>>,
    /// Remaining local drive rounds after Connected so NewSessionTicket can
    /// be emitted/consumed (mirrors the unit-harness 64-iteration flush).
    nst_flush_remaining: HashMap<ConnectionHandle, u8>,
    /// Cumulative SessionClosed events (extra-session or timed-out CONNECT).
    session_closed_count: u64,
    /// Local QPACK SETTINGS (advertised + decoder bound). Default disabled (0).
    qpack_settings: h3::QpackLocalSettings,
    last_error: Option<String>,
    /// Live TLS resolver when the server was built with rotatable certs.
    tls_resolver: Option<crate::server_tls::LiveServerCertResolver>,
}

fn clamp_varint_to_u32(value: u64) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

/// Remap an outbound WebTransport application error code onto its QUIC
/// stream-error code per draft §4.4. The image is always < 2^62, so the VarInt
/// conversion never fails; `VarInt::MAX` is an unreachable safety fallback.
fn remap_wt_app_error(code: u32) -> VarInt {
    VarInt::from_u64(crate::wt_error::remap_application_error(code)).unwrap_or(VarInt::MAX)
}

/// Recover the 32-bit application error code from an inbound WT-stream QUIC
/// error code (§4.4 inverse). Codes outside the WT application range — e.g. H3
/// control/CONNECT protocol codes — are passed through clamped to u32.
fn unmap_wt_app_error(value: u64) -> u32 {
    crate::wt_error::unmap_application_error(value).unwrap_or_else(|| clamp_varint_to_u32(value))
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
    max_blocked_streams == 0
}

/// Record a Blocked header stream, or close the connection when over the
/// advertised SETTINGS_QPACK_BLOCKED_STREAMS cap (including max=0).
/// When `stream_id` is `None` (primary CONNECT not yet indexed), only the
/// max=0 fail-closed check applies.
fn note_qpack_header_blocked(
    sessions: &mut HashMap<ConnectionHandle, Session>,
    h: ConnectionHandle,
    stream_id: Option<StreamId>,
) -> Result<(), &'static [u8]> {
    let Some(s) = sessions.get_mut(&h) else {
        return Ok(());
    };
    let max_blocked = s.qpack_decoder.max_blocked_streams();
    if qpack_blocking_forbidden(max_blocked) {
        return Err(b"QPACK blocked streams not permitted");
    }
    let Some(stream_id) = stream_id else {
        return Ok(());
    };
    let max = usize::try_from(max_blocked).unwrap_or(usize::MAX);
    let already = s.qpack_blocked_streams.contains(&stream_id);
    if !already && s.qpack_blocked_streams.len() >= max {
        return Err(b"QPACK blocked stream limit exceeded");
    }
    s.qpack_blocked_streams.insert(stream_id);
    Ok(())
}

fn clear_qpack_header_blocked(
    sessions: &mut HashMap<ConnectionHandle, Session>,
    h: ConnectionHandle,
    stream_id: StreamId,
) {
    if let Some(s) = sessions.get_mut(&h) {
        s.qpack_blocked_streams.remove(&stream_id);
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
fn connection_lost_signal(reason: &quinn_proto::ConnectionError) -> Option<(Option<String>, u32)> {
    match reason {
        quinn_proto::ConnectionError::LocallyClosed => None,
        quinn_proto::ConnectionError::ApplicationClosed(app) => {
            let code = u64::from(app.error_code).try_into().unwrap_or(u32::MAX);
            Some((None, code))
        }
        quinn_proto::ConnectionError::TimedOut => Some((
            Some("E_SESSION_IDLE_TIMEOUT: connection idle timeout".to_string()),
            0,
        )),
        // A rejected certificate arrives as a QUIC CRYPTO_ERROR carrying the
        // TLS alert. Without this it is indistinguishable from any other
        // transport loss: close code 0 and no diagnostic, which is exactly how
        // a bad `caPem`/pin set fails.
        _ => Some((tls_alert_error(reason), 0)),
    }
}

/// QUIC wraps a TLS alert as CRYPTO_ERROR, i.e. `0x100 + alert` (RFC 9001 §4.8).
fn tls_alert_error(reason: &quinn_proto::ConnectionError) -> Option<String> {
    const CRYPTO_ERROR: std::ops::Range<u64> = 0x100..0x200;
    let code = match reason {
        quinn_proto::ConnectionError::TransportError(error) => u64::from(error.code),
        // Covered end-to-end only (the peer rejecting our cert): quinn's
        // `frame::ConnectionClose` is not publicly constructible, so this arm
        // cannot be reached from a unit test.
        quinn_proto::ConnectionError::ConnectionClosed(close) => u64::from(close.error_code),
        _ => return None,
    };
    if !CRYPTO_ERROR.contains(&code) {
        return None;
    }
    Some(format!(
        "E_TLS: handshake failed with TLS alert {}",
        code - CRYPTO_ERROR.start
    ))
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

/// Count server request streams that are admitted but not yet latched as WT sessions.
fn count_unlatched_connect_streams(session: &Session) -> usize {
    session
        .in_streams
        .iter()
        .filter(|(id, st)| {
            st.connect_admitted
                && st.is_bidi
                && st.kind == Some(h3::frame::HEADERS)
                && !session.is_wt_connect(**id)
        })
        .count()
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
/// QPACK_DECODER_STREAM_ERROR (RFC 9204 §7.4).
const QPACK_DECODER_STREAM_ERROR: u32 = 0x0202;
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
        Self::new_with_limits_rate_limits_0rtt_and_ticket_share(
            is_server,
            _addr,
            peer_addr,
            limits,
            rate_limits,
            enable_0rtt,
            false,
        )
    }

    /// Opt-in 0-RTT with optional process-shared ticket store (loopback only).
    pub fn new_with_limits_rate_limits_0rtt_and_ticket_share(
        is_server: bool,
        _addr: SocketAddr,
        peer_addr: SocketAddr,
        limits: WasmLimits,
        rate_limits: WasmRateLimits,
        enable_0rtt: bool,
        share_process_0rtt_ticket_store: bool,
    ) -> Result<Self, String> {
        Self::new_with_limits_rate_limits_0rtt_ticket_share_and_cc(
            is_server,
            _addr,
            peer_addr,
            limits,
            rate_limits,
            enable_0rtt,
            share_process_0rtt_ticket_store,
            CongestionControlMode::Default,
        )
    }

    pub fn new_with_limits_rate_limits_0rtt_ticket_share_and_cc(
        is_server: bool,
        _addr: SocketAddr,
        peer_addr: SocketAddr,
        limits: WasmLimits,
        rate_limits: WasmRateLimits,
        enable_0rtt: bool,
        share_process_0rtt_ticket_store: bool,
        congestion_control: CongestionControlMode,
    ) -> Result<Self, String> {
        if is_server {
            let (cfg, _cert_der, resolver) = spike::server_crypto_with_resolver()?;
            let mut ep = Self::build(
                true,
                peer_addr,
                Some(cfg),
                None,
                limits,
                rate_limits,
                enable_0rtt,
                share_process_0rtt_ticket_store,
                congestion_control,
            )?;
            ep.tls_resolver = Some(resolver);
            Ok(ep)
        } else {
            Self::build(
                false,
                peer_addr,
                None,
                None,
                limits,
                rate_limits,
                enable_0rtt,
                share_process_0rtt_ticket_store,
                congestion_control,
            )
        }
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
        Self::new_client_pinned_with_limits_rate_limits_0rtt_and_ticket_share(
            peer_addr,
            hashes,
            limits,
            rate_limits,
            enable_0rtt,
            false,
        )
    }

    pub fn new_client_pinned_with_limits_rate_limits_0rtt_and_ticket_share(
        peer_addr: SocketAddr,
        hashes: Vec<[u8; 32]>,
        limits: WasmLimits,
        rate_limits: WasmRateLimits,
        enable_0rtt: bool,
        share_process_0rtt_ticket_store: bool,
    ) -> Result<Self, String> {
        Self::new_client_pinned_with_limits_rate_limits_0rtt_ticket_share_and_cc(
            peer_addr,
            hashes,
            limits,
            rate_limits,
            enable_0rtt,
            share_process_0rtt_ticket_store,
            CongestionControlMode::Default,
        )
    }

    pub fn new_client_pinned_with_limits_rate_limits_0rtt_ticket_share_and_cc(
        peer_addr: SocketAddr,
        hashes: Vec<[u8; 32]>,
        limits: WasmLimits,
        rate_limits: WasmRateLimits,
        enable_0rtt: bool,
        share_process_0rtt_ticket_store: bool,
        congestion_control: CongestionControlMode,
    ) -> Result<Self, String> {
        Self::new_client_with_trust(
            peer_addr,
            crate::verify::ClientTrust::Pinned(hashes),
            limits,
            rate_limits,
            enable_0rtt,
            share_process_0rtt_ticket_store,
            congestion_control,
        )
    }

    /// Client endpoint under an explicit trust model: hash pinning (the
    /// default) or verification against caller-supplied CA roots.
    pub fn new_client_with_trust(
        peer_addr: SocketAddr,
        trust: crate::verify::ClientTrust,
        limits: WasmLimits,
        rate_limits: WasmRateLimits,
        enable_0rtt: bool,
        share_process_0rtt_ticket_store: bool,
        congestion_control: CongestionControlMode,
    ) -> Result<Self, String> {
        let crypto = crate::verify::client_crypto(trust)?;
        Self::build(
            false,
            peer_addr,
            None,
            Some(crypto),
            limits,
            rate_limits,
            enable_0rtt,
            share_process_0rtt_ticket_store,
            congestion_control,
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
        Self::new_with_generated_cert_with_limits_rate_limits_0rtt_and_ticket_share(
            peer_addr,
            common_name,
            validity_days,
            not_before_unix,
            limits,
            rate_limits,
            enable_0rtt,
            false,
        )
    }

    pub fn new_with_generated_cert_with_limits_rate_limits_0rtt_and_ticket_share(
        peer_addr: SocketAddr,
        common_name: &str,
        validity_days: u32,
        not_before_unix: i64,
        limits: WasmLimits,
        rate_limits: WasmRateLimits,
        enable_0rtt: bool,
        share_process_0rtt_ticket_store: bool,
    ) -> Result<(Self, String), String> {
        Self::new_with_generated_cert_with_limits_rate_limits_0rtt_ticket_share_and_cc(
            peer_addr,
            common_name,
            validity_days,
            not_before_unix,
            limits,
            rate_limits,
            enable_0rtt,
            share_process_0rtt_ticket_store,
            CongestionControlMode::Default,
        )
    }

    pub fn new_with_generated_cert_with_limits_rate_limits_0rtt_ticket_share_and_cc(
        peer_addr: SocketAddr,
        common_name: &str,
        validity_days: u32,
        not_before_unix: i64,
        limits: WasmLimits,
        rate_limits: WasmRateLimits,
        enable_0rtt: bool,
        share_process_0rtt_ticket_store: bool,
        congestion_control: CongestionControlMode,
    ) -> Result<(Self, String), String> {
        let gen = crate::cert::generate(common_name, validity_days, not_before_unix)?;
        let hash = crate::cert::sha256_base64(&gen.cert_der);
        let (cfg, resolver) =
            crate::server_tls::server_config_with_live_resolver(gen.cert_der, gen.key_der)?;
        let mut ep = Self::build(
            true,
            peer_addr,
            Some(cfg),
            None,
            limits,
            rate_limits,
            enable_0rtt,
            share_process_0rtt_ticket_store,
            congestion_control,
        )?;
        ep.tls_resolver = Some(resolver);
        Ok((ep, hash))
    }

    /// Server endpoint with caller-supplied PEM cert/key (atomic; no generate-then-rotate).
    pub fn new_with_pem_cert_with_limits_rate_limits_0rtt_ticket_share_and_cc(
        peer_addr: SocketAddr,
        cert_pem: &str,
        key_pem: &str,
        limits: WasmLimits,
        rate_limits: WasmRateLimits,
        enable_0rtt: bool,
        share_process_0rtt_ticket_store: bool,
        congestion_control: CongestionControlMode,
    ) -> Result<(Self, String), String> {
        let key = crate::server_tls::certified_key_from_pem(cert_pem, key_pem)?;
        let hash = crate::server_tls::LiveServerCertResolver::new(
            Some(Arc::clone(&key)),
            crate::server_tls::UnknownSniPolicy::Reject,
        )
        .default_cert_hash_base64()
        .ok_or_else(|| "E_TLS: default cert hash missing after PEM parse".to_string())?;
        let (cfg, resolver) = crate::server_tls::server_config_with_live_resolver_key(key)?;
        let mut ep = Self::build(
            true,
            peer_addr,
            Some(cfg),
            None,
            limits,
            rate_limits,
            enable_0rtt,
            share_process_0rtt_ticket_store,
            congestion_control,
        )?;
        ep.tls_resolver = Some(resolver);
        Ok((ep, hash))
    }

    fn build(
        is_server: bool,
        peer_addr: SocketAddr,
        server_cfg: Option<rustls::ServerConfig>,
        client_crypto: Option<rustls::ClientConfig>,
        limits: WasmLimits,
        rate_limits: WasmRateLimits,
        enable_0rtt: bool,
        share_process_0rtt_ticket_store: bool,
        congestion_control: CongestionControlMode,
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
        congestion_control.apply(&mut tc);
        let transport = Arc::new(tc);
        let ticket_store = if enable_0rtt {
            Some(ticket_store_for_0rtt(share_process_0rtt_ticket_store))
        } else {
            None
        };
        let (inner, client_config) = if is_server {
            let mut cfg =
                server_cfg.ok_or_else(|| "E_INTERNAL: server config required".to_string())?;
            let store = ticket_store
                .clone()
                .unwrap_or_else(|| Arc::new(InMemoryTicketStore::new(1)));
            configure_server_early_data(&mut cfg, enable_0rtt, store);
            let qsc = quinn_proto::crypto::rustls::QuicServerConfig::try_from(cfg)
                .map_err(|error| format!("E_INTERNAL: invalid QUIC server config: {error}"))?;
            let mut server_config = ServerConfig::with_crypto(Arc::new(qsc));
            server_config.transport = transport;
            (
                Endpoint::new(ep_cfg, Some(Arc::new(server_config)), true, None),
                None,
            )
        } else if enable_0rtt && share_process_0rtt_ticket_store && client_crypto.is_none() {
            // Accept-any loopback clients share one ClientConfig so reconnect
            // across manager instances can offer has_0rtt from prior NST.
            let client_config = shared_0rtt_accept_any_client_config()?;
            (Endpoint::new(ep_cfg, None, true, None), Some(client_config))
        } else {
            // Clone pinned/accept-any crypto so verifier Arcs stay shared across
            // endpoints (required for rustls compatible_config after hydrate).
            let mut crypto = match client_crypto {
                Some(crypto) => crypto,
                None => spike::client_crypto()
                    .map_err(|error| format!("E_INTERNAL: client crypto config: {error}"))?,
            };
            let store = ticket_store
                .clone()
                .unwrap_or_else(|| Arc::new(InMemoryTicketStore::new(1)));
            configure_client_early_data(&mut crypto, enable_0rtt, store);
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
            stream_sessions: HashMap::new(),
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
            ticket_store,
            nst_flush_remaining: HashMap::new(),
            session_closed_count: 0,
            qpack_settings: h3::QpackLocalSettings::disabled(),
            last_error: None,
            tls_resolver: None,
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
        let Some(server_name) = tls_server_name_from_authority(authority) else {
            self.set_last_error("E_INVALID_ARGUMENT: empty authority host");
            return -1;
        };
        let (handle, conn) = match self.inner.connect(now, cfg, self.peer_addr, &server_name) {
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
        session.qpack_decoder = h3::QpackDecoder::new(&self.qpack_settings);
        let enc_cap = usize::try_from(self.qpack_settings.max_table_capacity).unwrap_or(0);
        session.qpack_encoder = h3::QpackEncoder::new(enc_cap);
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

    /// Quinn connection counters for W3C `getStats()` (JSON).
    pub fn connection_stats_json(&self, conn_id: u32) -> String {
        let Some(handle) = self.id_to_handle.get(&conn_id) else {
            return serde_json::json!({ "error": "E_SESSION_CLOSED: unknown connection" })
                .to_string();
        };
        let Some(conn) = self.conns.get(handle) else {
            return serde_json::json!({ "error": "E_SESSION_CLOSED: connection gone" }).to_string();
        };
        let stats = conn.stats();
        serde_json::json!({
            "bytesSent": stats.udp_tx.bytes,
            "bytesReceived": stats.udp_rx.bytes,
            "packetsSent": stats.udp_tx.datagrams,
            "packetsReceived": stats.udp_rx.datagrams,
            "smoothedRttMs": stats.path.rtt.as_secs_f64() * 1000.0,
            "datagrams": {
                "droppedIncoming": 0,
                "expiredIncoming": 0,
                "expiredOutgoing": 0,
                "lostOutgoing": 0
            }
        })
        .to_string()
    }

    /// Remote address of a live connection for the session `peer` accessor (JSON).
    pub fn connection_peer_json(&self, conn_id: u32) -> String {
        let Some(handle) = self.id_to_handle.get(&conn_id) else {
            return serde_json::json!({ "error": "E_SESSION_CLOSED: unknown connection" })
                .to_string();
        };
        let Some(conn) = self.conns.get(handle) else {
            return serde_json::json!({ "error": "E_SESSION_CLOSED: connection gone" }).to_string();
        };
        let addr = conn.remote_address();
        serde_json::json!({
            "ip": addr.ip().to_string(),
            "port": addr.port(),
        })
        .to_string()
    }

    pub fn tls_snapshot_json(&self) -> String {
        match &self.tls_resolver {
            Some(r) => r.snapshot_json(),
            None => serde_json::json!({
                "unknownSniPolicy": "reject",
                "defaultCertPresent": self.is_server,
                "sniNames": [],
                "sniCertSelections": 0,
                "defaultCertSelections": 0,
                "unknownSniRejectedCount": 0,
            })
            .to_string(),
        }
    }

    pub fn update_tls_json(&self, config_json: &str) -> String {
        let Some(resolver) = &self.tls_resolver else {
            return serde_json::json!({
                "error": "E_TLS: live TLS resolver unavailable on this endpoint"
            })
            .to_string();
        };
        let parsed: serde_json::Value = match serde_json::from_str(config_json) {
            Ok(v) => v,
            Err(e) => {
                return serde_json::json!({ "error": format!("E_TLS: config json: {e}") })
                    .to_string()
            }
        };

        // Validate every field before mutating the live resolver (fail-closed).
        let default_ck = match (
            parsed.get("certPem").and_then(|v| v.as_str()),
            parsed.get("keyPem").and_then(|v| v.as_str()),
        ) {
            (Some(cert), Some(key)) => match crate::server_tls::certified_key_from_pem(cert, key) {
                Ok(ck) => Some(ck),
                Err(e) => return serde_json::json!({ "error": e }).to_string(),
            },
            (None, None) => None,
            _ => {
                return serde_json::json!({
                    "error": "E_TLS: certPem and keyPem must both be set or both omitted"
                })
                .to_string()
            }
        };
        let next_policy =
            if let Some(policy) = parsed.get("unknownSniPolicy").and_then(|v| v.as_str()) {
                match crate::server_tls::UnknownSniPolicy::parse(Some(policy)) {
                    Ok(p) => Some(p),
                    Err(e) => return serde_json::json!({ "error": e }).to_string(),
                }
            } else {
                None
            };
        let next_sni = if parsed.get("sni").and_then(|v| v.as_array()).is_some() {
            let mapped = match parse_sni_entries(parsed.get("sni")) {
                Ok(v) => v,
                Err(e) => return serde_json::json!({ "error": e }).to_string(),
            };
            if mapped.len() > crate::server_tls::MAX_SNI_ENTRIES {
                return serde_json::json!({
                    "error": format!(
                        "E_TLS: sni map exceeds the {} entry cap",
                        crate::server_tls::MAX_SNI_ENTRIES
                    )
                })
                .to_string();
            }
            Some(mapped)
        } else {
            None
        };

        // Incremental map edits. Validated here so a bad PEM or an over-cap
        // insert leaves the live resolver untouched.
        let next_upserts = match parse_sni_entries(parsed.get("sniUpsert")) {
            Ok(v) => v,
            Err(e) => return serde_json::json!({ "error": e }).to_string(),
        };
        let next_removals = match parsed.get("sniRemove") {
            None => Vec::new(),
            Some(serde_json::Value::Array(names)) => {
                let mut out = Vec::with_capacity(names.len());
                for name in names {
                    match name.as_str() {
                        Some(n) => out.push(n.to_string()),
                        None => {
                            return serde_json::json!({
                                "error": "E_TLS: sniRemove entries must be strings"
                            })
                            .to_string()
                        }
                    }
                }
                out
            }
            Some(_) => {
                return serde_json::json!({ "error": "E_TLS: sniRemove must be an array" })
                    .to_string()
            }
        };

        // Simulate the resulting name set before touching anything, so an
        // over-cap batch is rejected wholesale rather than half-applied. Order
        // matches application order: replace, then remove, then upsert.
        if !next_upserts.is_empty() {
            let mut names: Vec<String> = match &next_sni {
                Some(mapped) => mapped.iter().map(|(n, _)| n.clone()).collect(),
                None => resolver.sni_names(),
            };
            names.retain(|n| !next_removals.iter().any(|r| r.eq_ignore_ascii_case(n)));
            for (name, _) in &next_upserts {
                if !names.iter().any(|n| n.eq_ignore_ascii_case(name)) {
                    names.push(name.clone());
                }
            }
            if names.len() > crate::server_tls::MAX_SNI_ENTRIES {
                return serde_json::json!({
                    "error": format!(
                        "E_TLS: sni map would exceed the {} entry cap",
                        crate::server_tls::MAX_SNI_ENTRIES
                    )
                })
                .to_string();
            }
        }

        let mut default_cert_rotated = false;
        if let Some(ck) = default_ck {
            resolver.replace_default(ck);
            default_cert_rotated = true;
        }
        if let Some(p) = next_policy {
            resolver.set_unknown_policy(p);
        }
        if let Some(mapped) = next_sni {
            resolver.set_sni(mapped);
        }
        let mut sni_removed = 0u64;
        for name in &next_removals {
            if resolver.remove_sni(name) {
                sni_removed += 1;
            }
        }
        let sni_upserted = next_upserts.len() as u64;
        for (name, ck) in next_upserts {
            resolver.upsert_sni(&name, ck);
        }
        // Pin clients trust a specific cert hash; when the default cert just
        // changed, hand back the new hash so the caller can redistribute it
        // out-of-band instead of silently breaking existing pinned clients.
        let mut result = serde_json::json!({ "ok": true });
        if default_cert_rotated {
            result["defaultCertHashBase64"] =
                serde_json::json!(resolver.default_cert_hash_base64());
        }
        if sni_upserted > 0 {
            result["sniUpserted"] = serde_json::json!(sni_upserted);
        }
        if !next_removals.is_empty() {
            result["sniRemoved"] = serde_json::json!(sni_removed);
        }
        result.to_string()
    }

    /// Drain client TLS tickets for `server_name` into an opaque vault blob.
    pub fn dump_client_ticket(&self, server_name: &str) -> Option<Vec<u8>> {
        let host = tls_server_name_from_authority(server_name)?;
        self.ticket_store
            .as_ref()
            .and_then(|store| store.export_client_tickets(&host))
    }

    /// Hydrate client TLS tickets from an opaque vault blob before connect.
    pub fn import_client_ticket(&self, server_name: &str, blob: &[u8]) -> bool {
        let Some(host) = tls_server_name_from_authority(server_name) else {
            return false;
        };
        self.ticket_store
            .as_ref()
            .is_some_and(|store| store.import_client_tickets(&host, blob))
    }

    /// Local QPACK SETTINGS (advertised and used to bound the decoder).
    pub fn qpack_settings(&self) -> h3::QpackLocalSettings {
        self.qpack_settings
    }

    /// Configure local QPACK SETTINGS before the peer handshake completes.
    /// Non-zero capacity is only safe once decoder-stream ACK emit is wired
    /// (always true on this build).
    pub fn set_qpack_settings(&mut self, settings: h3::QpackLocalSettings) {
        self.qpack_settings = settings;
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
        let wt_sessions_active: u64 = self
            .sessions
            .values()
            .map(|s| s.active_wt_count() as u64)
            .sum();
        serde_json::json!({
            "sessionsActive": snapshot.sessions_active,
            "handshakesInFlight": snapshot.handshakes_in_flight,
            "streamsActiveGlobal": snapshot.streams_active_global,
            "queuedBytesGlobal": snapshot.queued_bytes_global,
            "hostTokensActive": snapshot.host_tokens_active,
            "rateLimitBucketCount": rate_limit_snapshot.bucket_count,
            "rateLimitPrefixBucketCount": rate_limit_snapshot.prefix_bucket_count,
            "rateLimitedHandshakeCount": rate_limit_snapshot.rate_limited_handshake_count,
            "rateLimitedStreamOpenCount": rate_limit_snapshot.rate_limited_stream_open_count,
            "rateLimitedDatagramIngressCount": rate_limit_snapshot.rate_limited_datagram_ingress_count,
            "rateLimitedByPrefixCount": rate_limit_snapshot.rate_limited_by_prefix_count,
            "handshakeTimeoutMs": self.handshake_timeout_ms,
            "idleTimeoutMs": self.idle_timeout_ms,
            "wtSessionsActive": wt_sessions_active,
            "sessionClosedCount": self.session_closed_count,
        })
        .to_string()
    }

    fn push_session_closed(&mut self, conn: u32, session_id: u64, code: u32) {
        self.session_closed_count = self.session_closed_count.saturating_add(1);
        self.push_event(WtEvent::SessionClosed {
            conn,
            session_id,
            code,
        });
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
                            let mut wt_session = Session::default();
                            wt_session.qpack_decoder = h3::QpackDecoder::new(&self.qpack_settings);
                            let enc_cap = usize::try_from(self.qpack_settings.max_table_capacity)
                                .unwrap_or(0);
                            wt_session.qpack_encoder = h3::QpackEncoder::new(enc_cap);
                            // Bound QUIC-accept → first WT CONNECT: keep-alives
                            // defeat idle timeout, so without this deadline a
                            // CONNECT-less peer can pin handshake/session
                            // reservations until maxHandshakesInFlight exhausts.
                            wt_session.connect_deadline = Some(
                                now + std::time::Duration::from_millis(self.handshake_timeout_ms),
                            );
                            self.sessions.insert(handle, wt_session);
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
            WtEvent::Datagram { conn, data, .. } => self
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
                    if self.enable_0rtt {
                        // Match ticket_store unit harness: keep polling after
                        // Connected so NewSessionTicket can land in the store.
                        self.nst_flush_remaining.insert(h, 64);
                    }
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
                    self.on_stream_stopped(h, id, unmap_wt_app_error(error_code.into_inner()));
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
            self.push_event(WtEvent::ConnectionClosed { conn: id, code });
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
        self.push_event(WtEvent::ConnectionClosed {
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
            let preamble =
                h3::encode_control_preamble_with(self.wt_max_sessions, &self.qpack_settings);
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
                if let Some(s) = self.sessions.get_mut(&h) {
                    if st == h3::stream_type::QPACK_DECODER {
                        s.qpack_decoder_send = Some(id);
                    } else if st == h3::stream_type::QPACK_ENCODER {
                        s.qpack_encoder_send = Some(id);
                    }
                }
            }
        }
        if !self.is_server {
            if let Some(bidi) = self
                .conns
                .get_mut(&h)
                .and_then(|c| c.streams().open(Dir::Bi))
            {
                let authority = self
                    .sessions
                    .get(&h)
                    .map(|s| s.authority.clone())
                    .unwrap_or_default();
                let encoded = self
                    .sessions
                    .get_mut(&h)
                    .and_then(|s| {
                        h3::encode_connect_request_with(&mut s.qpack_encoder, &authority, "/").ok()
                    })
                    .unwrap_or_else(|| h3::EncodedHeaders {
                        headers_frame: h3::encode_connect_request(&authority, "/"),
                        encoder_stream: Vec::new(),
                        ric: 0,
                    });
                self.write_encoded_headers(h, bidi, encoded);
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
                    wt_session_id: None,
                    handle: None,
                    connect_admitted: false,
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
            ids.extend(s.pending_client_connects.keys().copied());
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
        // Client's self-opened primary CONNECT stream.
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

        // Client secondary CONNECT awaiting 200.
        let is_pending = self
            .sessions
            .get(&h)
            .is_some_and(|s| s.pending_client_connects.contains_key(&id));
        if is_pending {
            let mut final_outcome = ReadOutcome::Open;
            for _ in 0..MAX_READ_BATCHES_PER_PUMP {
                let mut data = Vec::new();
                let outcome =
                    read_stream(self.conns.get_mut(&h), id, &mut data, PROTOCOL_READ_CHUNK);
                let made_progress = !data.is_empty();
                if made_progress {
                    if let Some(pending) = self
                        .sessions
                        .get_mut(&h)
                        .and_then(|s| s.pending_client_connects.get_mut(&id))
                    {
                        pending.rx.extend_from_slice(&data);
                    }
                    self.parse_pending_client_connect(h, id);
                }
                final_outcome = outcome;
                if should_stop_read_batch(outcome == ReadOutcome::Open, made_progress) {
                    break;
                }
            }
            if matches!(final_outcome, ReadOutcome::Finished | ReadOutcome::Reset(_)) {
                // Only emit SessionClosed if this CONNECT was still pending
                // (Failure path already closed + reset/stop'd).
                let closed_pending = self
                    .sessions
                    .get_mut(&h)
                    .and_then(|s| s.pending_client_connects.remove(&id))
                    .is_some();
                if closed_pending {
                    if let Some(&conn) = self.handle_to_id.get(&h) {
                        self.push_session_closed(conn, u64::from(id), 0);
                    }
                }
            }
            return;
        }

        // Client secondary CONNECT already latched into extra_sessions.
        let is_extra_self = self
            .sessions
            .get(&h)
            .is_some_and(|s| s.connect_self_opened && s.extra_sessions.contains(&id));
        if is_extra_self {
            let mut final_outcome = ReadOutcome::Open;
            for _ in 0..MAX_READ_BATCHES_PER_PUMP {
                let mut data = Vec::new();
                let outcome =
                    read_stream(self.conns.get_mut(&h), id, &mut data, PROTOCOL_READ_CHUNK);
                let made_progress = !data.is_empty();
                // Post-200 CONNECT bytes are ignored; we only care about FIN/reset.
                final_outcome = outcome;
                if should_stop_read_batch(outcome == ReadOutcome::Open, made_progress) {
                    break;
                }
            }
            if matches!(final_outcome, ReadOutcome::Finished | ReadOutcome::Reset(_)) {
                self.on_connect_stream_ended(h, id, false);
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
                    self.emit_stream_reset(h, id, unmap_wt_app_error(code));
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
                    code: unmap_wt_app_error(code),
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
            return;
        }
        let Some(&conn) = self.handle_to_id.get(&h) else {
            return;
        };
        let removed = self
            .sessions
            .get_mut(&h)
            .is_some_and(|s| s.extra_sessions.remove(&id));
        if removed {
            self.push_session_closed(conn, u64::from(id), 0);
        }
    }

    /// Decide whether an inbound QUIC datagram payload should be delivered to
    /// the host for this session (quarter-session-id demux).
    fn datagram_payload_for_session(session: &Session, dg: &[u8]) -> Option<(u64, Vec<u8>)> {
        let (qsid, payload) = h3::unwrap_datagram(dg)?;
        let sid = session.session_for_qsid(qsid)?;
        Some((u64::from(sid), payload.to_vec()))
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
    /// both the forward and reverse indexes, and record its session id.
    fn index_insert(&mut self, handle: u32, h: ConnectionHandle, sid: StreamId, session_id: u64) {
        self.stream_index.insert(handle, (h, sid));
        self.rev_index.insert((h, sid), handle);
        self.stream_sessions.insert(handle, session_id);
    }

    /// Remove a WT stream handle from both indexes.
    fn index_remove(&mut self, handle: u32) {
        if let Some((h, sid)) = self.stream_index.remove(&handle) {
            self.rev_index.remove(&(h, sid));
        }
        self.stream_sessions.remove(&handle);
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
            self.push_event(WtEvent::ConnectionClosed { conn: id, code });
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
        self.push_event(WtEvent::ConnectionClosed { conn: id, code: 0 });
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
            /// Peer QPACK decoder stream — section acks / ICI.
            QpackDecoder,
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
                opened: Option<(u32, u64, u32, bool)>,
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
            let unlatched_connects = count_unlatched_connect_streams(s);
            let active_wt = s.active_wt_count();
            let connect_cap = self.wt_max_sessions.max(1) as usize;
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
                        // Admit once against concurrent unlatched+active WT sessions.
                        // Do not charge Handshake/StreamOpen here — those buckets
                        // gate UDP handshakes and WT stream opens respectively;
                        // CONNECT storms fail closed via the admission cap + RESET.
                        if !st.connect_admitted {
                            let occupied = unlatched_connects + active_wt;
                            if occupied >= connect_cap {
                                st.buf.clear();
                                break 'route Route::RejectWt {
                                    error: "E_LIMIT_EXCEEDED: unlatched CONNECT admission cap"
                                        .to_string(),
                                    bidi: true,
                                };
                            }
                            st.connect_admitted = true;
                        }
                        if st.buf.len() > MAX_H3_FRAME_SIZE as usize {
                            st.buf.clear();
                            break 'route Route::RejectWt {
                                error: "E_LIMIT_EXCEEDED: CONNECT request buffer exceeded"
                                    .to_string(),
                                bidi: true,
                            };
                        }
                        Route::ServerConnect { id }
                    }
                    PeerStreamClass::QpackEncoder => {
                        let drained = std::mem::take(&mut st.buf);
                        s.qpack_encoder_rx.extend_from_slice(&drained);
                        Route::QpackEncoder
                    }
                    PeerStreamClass::QpackDecoder => {
                        let drained = std::mem::take(&mut st.buf);
                        s.qpack_decoder_rx.extend_from_slice(&drained);
                        Route::QpackDecoder
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
                                st.wt_session_id = Some(sid);
                                st.buf.drain(..n);
                            } else if !finished {
                                return;
                            }
                        }
                        if st.sid_read {
                            let mut opened: Option<(u32, u64, u32, bool)> = None;
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
                                let session_id = st.wt_session_id.unwrap_or(0);
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
                                self.stream_sessions.insert(handle, session_id);
                                self.stream_reservations.insert(handle, reservation);
                                // Peer-opened uni has no send half on our side.
                                self.half_done
                                    .insert(handle, if st.is_bidi { 0 } else { HALF_SEND });
                                opened = Some((conn_id, session_id, handle, st.is_bidi));
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
            Route::QpackDecoder => {
                self.parse_qpack_decoder(h);
            }
            Route::ServerConnect { id } => self.parse_server_connect(h, id),
            Route::WtData {
                handle,
                payload,
                opened,
            } => {
                if let Some((conn, session_id, stream, bidi)) = opened {
                    self.push_event(WtEvent::StreamOpened {
                        conn,
                        session_id,
                        stream,
                        bidi,
                    });
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
        let mut ici: Option<(StreamId, Vec<u8>)> = None;
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
                let before = s.qpack_decoder.table().insert_count();
                match h3::feed_encoder_stream(&mut s.qpack_decoder, &s.qpack_encoder_rx) {
                    Ok(n) => {
                        s.qpack_encoder_rx.drain(..n);
                        let after = s.qpack_decoder.table().insert_count();
                        if after > before {
                            let delta = after - before;
                            s.qpack_decoder.note_insert_count_increment(delta);
                            if let Some(decoder_send) = s.qpack_decoder_send {
                                ici =
                                    Some((decoder_send, h3::encode_insert_count_increment(delta)));
                            }
                        }
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
            return;
        }
        if let Some((sid, bytes)) = ici {
            if let Some(conn) = self.conns.get_mut(&h) {
                let _ = conn.send_stream(sid).write(&bytes);
            }
        }
    }

    /// Consume peer decoder-stream ACKs / ICI and advance encoder Known Received Count.
    fn parse_qpack_decoder(&mut self, h: ConnectionHandle) {
        let err = {
            let Some(s) = self.sessions.get_mut(&h) else {
                return;
            };
            if s.qpack_decoder_rx.len() > MAX_H3_FRAME_SIZE as usize {
                Some((
                    QPACK_DECODER_STREAM_ERROR,
                    b"QPACK decoder stream too large".as_slice(),
                ))
            } else {
                match h3::feed_decoder_stream(&s.qpack_decoder_rx) {
                    Ok((n, ici_delta, section_acks)) => {
                        s.qpack_decoder_rx.drain(..n);
                        if ici_delta > 0 {
                            s.qpack_encoder.note_peer_ici(ici_delta);
                        }
                        for sid in section_acks {
                            if let Some(ric) = s.pending_section_ric.remove(&sid) {
                                s.qpack_encoder.note_section_ack(ric);
                            }
                        }
                        None
                    }
                    Err(_) => Some((
                        QPACK_DECODER_STREAM_ERROR,
                        b"QPACK decoder stream error".as_slice(),
                    )),
                }
            }
        };
        if let Some((code, reason)) = err {
            self.close_conn_protocol_error(h, code, reason);
        }
    }

    /// Write optional encoder-stream inserts then HEADERS; track RIC for section-ack → KRC.
    fn write_encoded_headers(
        &mut self,
        h: ConnectionHandle,
        stream_id: StreamId,
        encoded: h3::EncodedHeaders,
    ) {
        if !encoded.encoder_stream.is_empty() {
            if let Some(enc_sid) = self.sessions.get(&h).and_then(|s| s.qpack_encoder_send) {
                if let Some(conn) = self.conns.get_mut(&h) {
                    let _ = conn.send_stream(enc_sid).write(&encoded.encoder_stream);
                }
            }
        }
        if let Some(conn) = self.conns.get_mut(&h) {
            let _ = conn.send_stream(stream_id).write(&encoded.headers_frame);
        }
        if encoded.ric > 0 {
            if let Some(s) = self.sessions.get_mut(&h) {
                s.pending_section_ric
                    .insert(u64::from(stream_id), encoded.ric);
            }
        }
    }

    fn encode_status_for_session(
        &mut self,
        h: ConnectionHandle,
        status: &str,
    ) -> h3::EncodedHeaders {
        self.sessions
            .get_mut(&h)
            .and_then(|s| h3::encode_status_response_with(&mut s.qpack_encoder, status).ok())
            .unwrap_or_else(|| h3::EncodedHeaders {
                headers_frame: h3::encode_status_response(status),
                encoder_stream: Vec::new(),
                ric: 0,
            })
    }

    fn encode_connect_ok_for_session(&mut self, h: ConnectionHandle) -> h3::EncodedHeaders {
        self.sessions
            .get_mut(&h)
            .and_then(|s| h3::encode_connect_response_ok_with(&mut s.qpack_encoder).ok())
            .unwrap_or_else(|| h3::EncodedHeaders {
                headers_frame: h3::encode_connect_response_ok(),
                encoder_stream: Vec::new(),
                ric: 0,
            })
    }

    fn emit_qpack_section_ack(&mut self, h: ConnectionHandle, stream_id: StreamId, ric: u64) {
        if ric == 0 {
            return;
        }
        let Some(decoder_send) = self.sessions.get(&h).and_then(|s| s.qpack_decoder_send) else {
            return;
        };
        let bytes = h3::encode_section_acknowledgement(u64::from(stream_id));
        if let Some(conn) = self.conns.get_mut(&h) {
            let _ = conn.send_stream(decoder_send).write(&bytes);
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
        let pending_ids: Vec<StreamId> = self
            .sessions
            .get(&h)
            .map(|s| s.pending_client_connects.keys().copied().collect())
            .unwrap_or_default();
        for id in pending_ids {
            self.parse_pending_client_connect(h, id);
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
                    if let Err(reason) =
                        note_qpack_header_blocked(&mut self.sessions, h, Some(stream_id))
                    {
                        self.close_conn_protocol_error(h, QPACK_DECOMPRESSION_FAILED, reason);
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
                Ok((headers, ric)) => {
                    clear_qpack_header_blocked(&mut self.sessions, h, stream_id);
                    if let Some(s) = self.sessions.get_mut(&h) {
                        if let Some(st) = s.in_streams.get_mut(&stream_id) {
                            st.buf.drain(..total);
                        }
                    }
                    self.emit_qpack_section_ack(h, stream_id, ric);

                    let is_connect = headers_are_webtransport_connect(&headers);
                    if !is_connect {
                        let resp = self.encode_status_for_session(h, "404");
                        self.write_encoded_headers(h, stream_id, resp);
                        if let Some(conn) = self.conns.get_mut(&h) {
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
                        let resp = self.encode_status_for_session(h, "429");
                        self.write_encoded_headers(h, stream_id, resp);
                        if let Some(conn) = self.conns.get_mut(&h) {
                            let _ = conn.send_stream(stream_id).finish();
                        }
                        continue;
                    }

                    let resp = self.encode_connect_ok_for_session(h);
                    self.write_encoded_headers(h, stream_id, resp);
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
                    self.push_event(WtEvent::SessionEstablished {
                        conn: id,
                        session_id: u64::from(stream_id),
                    });
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
                    let sid = self.sessions.get(&h).and_then(|s| s.connect_stream);
                    if let Err(reason) = note_qpack_header_blocked(&mut self.sessions, h, sid) {
                        self.close_conn_protocol_error(h, QPACK_DECOMPRESSION_FAILED, reason);
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
                Ok((headers, ric)) => {
                    if let Some(sid) = self.sessions.get(&h).and_then(|s| s.connect_stream) {
                        clear_qpack_header_blocked(&mut self.sessions, h, sid);
                    }
                    if let Some(s) = self.sessions.get_mut(&h) {
                        s.connect_rx.drain(..total);
                    }
                    if let Some(sid) = self.sessions.get(&h).and_then(|s| s.connect_stream) {
                        self.emit_qpack_section_ack(h, sid, ric);
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
                        let session_id = self
                            .sessions
                            .get(&h)
                            .and_then(|s| s.connect_stream)
                            .map(u64::from)
                            .unwrap_or(0);
                        if let Some(s) = self.sessions.get_mut(&h) {
                            s.established = true;
                            s.connect_deadline = None; // handshake done
                        }
                        self.handshake_reservations.remove(&h);
                        self.push_event(WtEvent::SessionEstablished {
                            conn: id,
                            session_id,
                        });
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

    /// Client: parse a secondary CONNECT response from a pending buffer.
    fn parse_pending_client_connect(&mut self, h: ConnectionHandle, stream_id: StreamId) {
        let Some(&conn_id) = self.handle_to_id.get(&h) else {
            return;
        };
        loop {
            let hdr = {
                let Some(pending) = self
                    .sessions
                    .get(&h)
                    .and_then(|s| s.pending_client_connects.get(&stream_id))
                else {
                    return;
                };
                decode_frame_header(&pending.rx)
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
                if let Some(pending) = self
                    .sessions
                    .get_mut(&h)
                    .and_then(|s| s.pending_client_connects.get_mut(&stream_id))
                {
                    pending.rx.drain(..total);
                }
                continue;
            }
            let decode_result = {
                let Some(s) = self.sessions.get(&h) else {
                    return;
                };
                let Some(pending) = s.pending_client_connects.get(&stream_id) else {
                    return;
                };
                h3::decode_field_section(&pending.rx[header..total], &s.qpack_decoder)
            };
            let headers = match decode_result {
                Err(h3::QpackError::Blocked) => {
                    if let Err(reason) =
                        note_qpack_header_blocked(&mut self.sessions, h, Some(stream_id))
                    {
                        self.close_conn_protocol_error(h, QPACK_DECOMPRESSION_FAILED, reason);
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
                Ok((headers, ric)) => {
                    clear_qpack_header_blocked(&mut self.sessions, h, stream_id);
                    if let Some(pending) = self
                        .sessions
                        .get_mut(&h)
                        .and_then(|s| s.pending_client_connects.get_mut(&stream_id))
                    {
                        pending.rx.drain(..total);
                    }
                    self.emit_qpack_section_ack(h, stream_id, ric);
                    headers
                }
            };
            let status: Option<u16> = headers
                .iter()
                .find(|(k, _)| k == ":status")
                .and_then(|(_, v)| v.parse().ok());
            match classify_connect_status(status) {
                ConnectStatusKind::Success => {
                    if let Some(s) = self.sessions.get_mut(&h) {
                        s.pending_client_connects.remove(&stream_id);
                        s.extra_sessions.insert(stream_id);
                    }
                    self.push_event(WtEvent::SessionEstablished {
                        conn: conn_id,
                        session_id: u64::from(stream_id),
                    });
                    return;
                }
                ConnectStatusKind::Interim => {}
                ConnectStatusKind::Failure => {
                    if let Some(s) = self.sessions.get_mut(&h) {
                        s.pending_client_connects.remove(&stream_id);
                    }
                    if let Some(conn) = self.conns.get_mut(&h) {
                        let _ = conn.send_stream(stream_id).reset(VarInt::from_u32(0));
                        let _ = conn.recv_stream(stream_id).stop(VarInt::from_u32(0));
                    }
                    self.push_session_closed(conn_id, u64::from(stream_id), 0);
                    return;
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
            let Some((session_id, payload)) = Self::datagram_payload_for_session(session, &dg)
            else {
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
                session_id,
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

    /// Send a WebTransport datagram on the given session's CONNECT context.
    pub fn send_datagram(&mut self, conn_id: u32, session_id: u64, payload: &[u8]) -> bool {
        if datagram_payload_exceeds_caps(
            payload.len(),
            self.governor.limits().max_datagram_size,
            self.max_datagram_size(conn_id, session_id),
        ) {
            self.set_last_error("E_LIMIT_EXCEEDED: maxDatagramSize exceeded");
            return false;
        }
        self.send_datagram_framed(conn_id, session_id, payload)
    }

    /// Frame + quinn send without the application-size pre-check (test-only).
    /// Used to exercise `SendDatagramError::TooLarge` / queue-full arms that the
    /// production pre-check otherwise makes unreachable.
    #[cfg(test)]
    pub(crate) fn send_datagram_unchecked_size(
        &mut self,
        conn_id: u32,
        session_id: u64,
        payload: &[u8],
    ) -> bool {
        self.send_datagram_framed(conn_id, session_id, payload)
    }

    fn send_datagram_framed(&mut self, conn_id: u32, session_id: u64, payload: &[u8]) -> bool {
        let Some(&h) = self.id_to_handle.get(&conn_id) else {
            self.set_last_error("E_SESSION_CLOSED: unknown connection");
            return false;
        };
        let Some(_connect_stream) = self
            .sessions
            .get(&h)
            .and_then(|s| s.resolve_wt_session(session_id))
        else {
            self.set_last_error("E_SESSION_CLOSED: session not established");
            return false;
        };
        let framed = h3::wrap_datagram(session_id, payload);
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

    /// Effective WebTransport application payload cap for the given session.
    /// Quinn reports the full QUIC DATAGRAM payload cap, so remove the encoded
    /// quarter-session-id prefix before exposing it to callers.
    pub fn max_datagram_size(&mut self, conn_id: u32, session_id: u64) -> Option<usize> {
        let configured = self.governor.limits().max_datagram_size;
        let &h = self.id_to_handle.get(&conn_id)?;
        let _ = self.sessions.get(&h)?.resolve_wt_session(session_id)?;
        let context_len = h3::wrap_datagram(session_id, &[]).len();
        let transport = self.conns.get_mut(&h)?.datagrams().max_size()?;
        Some(configured.min(transport.saturating_sub(context_len)))
    }

    /// Open a WebTransport stream on `session_id`. `bidi` selects bidirectional
    /// vs unidirectional. Returns the stream handle, or -1 on failure.
    pub fn open_stream(&mut self, conn_id: u32, session_id: u64, bidi: bool) -> i32 {
        let Some(&h) = self.id_to_handle.get(&conn_id) else {
            self.set_last_error("E_SESSION_CLOSED: unknown connection");
            return -1;
        };
        if self
            .sessions
            .get(&h)
            .and_then(|s| s.resolve_wt_session(session_id))
            .is_none()
        {
            self.set_last_error("E_SESSION_CLOSED: session not established");
            return -1;
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
        self.index_insert(handle, h, sid, session_id);
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

    /// Client: open an additional WebTransport session (Extended CONNECT) on an
    /// established QUIC connection. Returns the new session_id, or -1 on error.
    pub fn open_wt_session(&mut self, conn_id: u32) -> i64 {
        let Some(&h) = self.id_to_handle.get(&conn_id) else {
            self.set_last_error("E_SESSION_CLOSED: unknown connection");
            return -1;
        };
        if self.is_server {
            self.set_last_error("E_UNSUPPORTED_ARGUMENT: open_wt_session is client-only");
            return -1;
        }
        let Some(session) = self.sessions.get(&h) else {
            self.set_last_error("E_SESSION_CLOSED: session missing");
            return -1;
        };
        if !session.established {
            self.set_last_error("E_SESSION_CLOSED: primary session not established");
            return -1;
        }
        let Some(peer) = session.peer_settings.as_ref() else {
            self.set_last_error("E_HANDSHAKE_TIMEOUT: peer SETTINGS not yet received");
            return -1;
        };
        let peer_max = if peer.max_sessions == 0 {
            1
        } else {
            peer.max_sessions
        };
        if session.active_wt_count() as u64 >= peer_max {
            self.set_last_error("E_LIMIT_EXCEEDED: SETTINGS_WT_MAX_SESSIONS exceeded");
            return -1;
        }
        let authority = session.authority.clone();
        let now = Instant::now();
        let Some(conn) = self.conns.get_mut(&h) else {
            self.set_last_error("E_SESSION_CLOSED: connection missing");
            return -1;
        };
        let Some(bidi) = conn.streams().open(Dir::Bi) else {
            self.set_last_error("E_LIMIT_EXCEEDED: stream capacity unavailable");
            return -1;
        };
        let encoded = self
            .sessions
            .get_mut(&h)
            .and_then(|s| {
                h3::encode_connect_request_with(&mut s.qpack_encoder, &authority, "/").ok()
            })
            .unwrap_or_else(|| h3::EncodedHeaders {
                headers_frame: h3::encode_connect_request(&authority, "/"),
                encoder_stream: Vec::new(),
                ric: 0,
            });
        self.write_encoded_headers(h, bidi, encoded);
        if let Some(s) = self.sessions.get_mut(&h) {
            s.pending_client_connects.insert(
                bidi,
                PendingClientConnect {
                    rx: Vec::new(),
                    deadline: Some(
                        now + std::time::Duration::from_millis(self.handshake_timeout_ms),
                    ),
                },
            );
        }
        i64::try_from(u64::from(bidi)).unwrap_or(-1)
    }

    /// Close one WebTransport session. Primary CONNECT close tears down QUIC;
    /// extra session close only ends that CONNECT and emits SessionClosed.
    pub fn close_wt_session(
        &mut self,
        conn_id: u32,
        session_id: u64,
        code: u32,
        reason: &[u8],
    ) -> bool {
        let Some(&h) = self.id_to_handle.get(&conn_id) else {
            self.set_last_error("E_SESSION_CLOSED: unknown connection");
            return false;
        };
        let Some(session) = self.sessions.get(&h) else {
            self.set_last_error("E_SESSION_CLOSED: session missing");
            return false;
        };
        let Some(sid) = session.resolve_wt_session(session_id) else {
            self.set_last_error("E_SESSION_CLOSED: unknown WebTransport session id");
            return false;
        };
        let is_primary = session.connect_stream == Some(sid);
        if is_primary {
            // Primary close tears down QUIC with the application code/reason so
            // the peer observes ConnectionClosed with the intended close code.
            self.close_conn(conn_id, code, reason, Instant::now());
            return true;
        }
        if let Some(conn) = self.conns.get_mut(&h) {
            let _ = conn.send_stream(sid).reset(VarInt::from_u32(code));
            let _ = conn.recv_stream(sid).stop(VarInt::from_u32(code));
        }
        // Reset/stop every WT stream demuxed to this session.
        let session_streams: Vec<(u32, StreamId)> = self
            .stream_index
            .iter()
            .filter(|(handle, &(sh, _))| {
                sh == h && self.stream_sessions.get(handle) == Some(&session_id)
            })
            .map(|(handle, &(_, quic_sid))| (*handle, quic_sid))
            .collect();
        for (handle, quic_sid) in session_streams {
            if let Some(conn) = self.conns.get_mut(&h) {
                let _ = conn.send_stream(quic_sid).reset(VarInt::from_u32(code));
                let _ = conn.recv_stream(quic_sid).stop(VarInt::from_u32(code));
            }
            if let Some(s) = self.sessions.get_mut(&h) {
                s.self_bidi.remove(&quic_sid);
                s.in_streams.remove(&quic_sid);
            }
            self.paused.remove(&handle);
            self.half_done.remove(&handle);
            self.stream_reservations.remove(&handle);
            self.index_remove(handle);
            self.push_event(WtEvent::StreamReset {
                conn: conn_id,
                stream: handle,
                code,
            });
        }
        if let Some(s) = self.sessions.get_mut(&h) {
            s.extra_sessions.remove(&sid);
            s.pending_client_connects.remove(&sid);
        }
        self.push_session_closed(conn_id, session_id, code);
        true
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
                let _ = c.send_stream(sid).reset(remap_wt_app_error(code));
            }
            self.mark_stream_half_done(stream, HALF_SEND);
        }
    }

    /// STOP_SENDING on the recv half: tell the peer to stop sending on this
    /// stream (the WebTransport equivalent of cancelling a ReadableStream).
    pub fn stream_stop(&mut self, stream: u32, code: u32) {
        if let Some(&(h, sid)) = self.stream_index.get(&stream) {
            if let Some(c) = self.conns.get_mut(&h) {
                let _ = c.recv_stream(sid).stop(remap_wt_app_error(code));
            }
            self.paused.remove(&stream);
            self.mark_stream_half_done(stream, HALF_RECV);
        }
    }

    /// Drain outbound QUIC datagrams for all connections into `out`, each paired
    /// with the destination address quinn-proto chose for the packet.
    pub fn poll_transmits(&mut self, now: Instant, out: &mut Vec<(Vec<u8>, SocketAddr)>) {
        // While NST flush is pending, drive connections so crypto tickets are
        // emitted even when the UDP loop is quiet after SessionEstablished.
        if self.enable_0rtt && !self.nst_flush_remaining.is_empty() {
            let flush_handles: Vec<ConnectionHandle> =
                self.nst_flush_remaining.keys().copied().collect();
            for h in flush_handles {
                if !self.conns.contains_key(&h) {
                    self.nst_flush_remaining.remove(&h);
                    continue;
                }
                self.drive(h, now);
                if let Some(left) = self.nst_flush_remaining.get_mut(&h) {
                    *left = left.saturating_sub(1);
                    if *left == 0 {
                        self.nst_flush_remaining.remove(&h);
                    }
                }
            }
        }
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
        // Pending CONNECT / post-accept handshake deadlines (unestablished).
        for s in self.sessions.values() {
            if should_track_connect_deadline(s.established, s.connect_closed) {
                if let Some(t) = s.connect_deadline {
                    soonest = sooner_deadline(soonest, t);
                }
            }
            for pending in s.pending_client_connects.values() {
                if let Some(t) = pending.deadline {
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
        // Fail any session whose post-accept / client CONNECT deadline passed
        // unanswered (releases handshake+session reservations).
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
        // Fail secondary client CONNECTs whose deadlines elapsed (session-only).
        let mut expired_pending: Vec<(ConnectionHandle, u32, u64)> = Vec::new();
        for (&h, s) in &self.sessions {
            let Some(&conn_id) = self.handle_to_id.get(&h) else {
                continue;
            };
            for (sid, pending) in &s.pending_client_connects {
                if pending.deadline.is_some_and(|d| d <= now) {
                    expired_pending.push((h, conn_id, u64::from(*sid)));
                }
            }
        }
        for (h, conn_id, session_id) in expired_pending {
            self.set_last_error("E_HANDSHAKE_TIMEOUT: WebTransport CONNECT timed out");
            let Some(sid) = self
                .sessions
                .get(&h)
                .and_then(|s| s.resolve_wt_session(session_id))
            else {
                continue;
            };
            if let Some(conn) = self.conns.get_mut(&h) {
                let _ = conn.send_stream(sid).reset(VarInt::from_u32(0));
                let _ = conn.recv_stream(sid).stop(VarInt::from_u32(0));
            }
            if let Some(s) = self.sessions.get_mut(&h) {
                s.pending_client_connects.remove(&sid);
                s.extra_sessions.remove(&sid);
            }
            self.push_session_closed(conn_id, session_id, 0);
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
                            self.push_event(WtEvent::ConnectionClosed {
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

/// Parse a JSON array of `{serverName, certPem, keyPem}` into certified keys.
/// A missing field is `Ok(vec![])`; a malformed one is an `E_TLS` string so the
/// caller can bail before mutating the live resolver.
fn parse_sni_entries(
    value: Option<&serde_json::Value>,
) -> Result<Vec<(String, std::sync::Arc<rustls::sign::CertifiedKey>)>, String> {
    let entries = match value {
        None | Some(serde_json::Value::Null) => return Ok(Vec::new()),
        Some(serde_json::Value::Array(entries)) => entries,
        Some(_) => return Err("E_TLS: sni entries must be an array".into()),
    };
    let mut mapped = Vec::with_capacity(entries.len());
    for entry in entries {
        let name = entry
            .get("serverName")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "E_TLS: sni.serverName missing".to_string())?;
        if name.is_empty() {
            return Err("E_TLS: sni.serverName must not be empty".into());
        }
        let cert = entry
            .get("certPem")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "E_TLS: sni.certPem missing".to_string())?;
        let key = entry
            .get("keyPem")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "E_TLS: sni.keyPem missing".to_string())?;
        let ck = crate::server_tls::certified_key_from_pem(cert, key)?;
        mapped.push((name.to_string(), ck));
    }
    Ok(mapped)
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
