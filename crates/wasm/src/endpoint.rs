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
    /// CONNECT bidi stream id (client: self-opened; server: discovered).
    connect_stream: Option<StreamId>,
    /// True when we (client) opened the CONNECT stream ourselves.
    connect_self_opened: bool,
    established: bool,
    /// Set once the WT session has been closed (graceful CONNECT-stream end),
    /// so Closed is emitted exactly once.
    connect_closed: bool,
    /// Client only: deadline by which the CONNECT must be answered, or the
    /// session is failed. Bounds a handshake that would otherwise hang forever
    /// because QUIC keep-alives defeat the idle timeout. Cleared on establish.
    connect_deadline: Option<Instant>,
    connect_rx: Vec<u8>,
    control_rx: Vec<u8>,
    /// Peer-accepted streams (uni + bidi) being classified/read.
    in_streams: HashMap<StreamId, InStream>,
    /// Self-opened bidi WT streams: id -> handle (inbound is raw WT data).
    self_bidi: HashMap<StreamId, u32>,
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
    last_error: Option<String>,
}

// This endpoint models exactly ONE WebTransport session per QUIC connection
// (a second CONNECT is rejected with 404), so advertise that honestly.
const WT_MAX_SESSIONS: u64 = 1;
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
        let server_cfg = if is_server {
            Some(spike::server_crypto()?.0)
        } else {
            None
        };
        Self::build(is_server, peer_addr, server_cfg, None, limits, rate_limits)
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
        let crypto = crate::verify::client_crypto_pinned(hashes)?;
        Self::build(false, peer_addr, None, Some(crypto), limits, rate_limits)
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
        let gen = crate::cert::generate(common_name, validity_days, not_before_unix)?;
        let hash = crate::cert::sha256_base64(&gen.cert_der);
        let cfg = spike::server_config_from_der(gen.cert_der, gen.key_der)?;
        Ok((
            Self::build(true, peer_addr, Some(cfg), None, limits, rate_limits)?,
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
        let (inner, client_config) = if is_server {
            let cfg = server_cfg.ok_or_else(|| "E_INTERNAL: server config required".to_string())?;
            let qsc = quinn_proto::crypto::rustls::QuicServerConfig::try_from(cfg)
                .map_err(|error| format!("E_INTERNAL: invalid QUIC server config: {error}"))?;
            let mut server_config = ServerConfig::with_crypto(Arc::new(qsc));
            server_config.transport = transport;
            (
                Endpoint::new(ep_cfg, Some(Arc::new(server_config)), true, None),
                None,
            )
        } else {
            let crypto = match client_crypto {
                Some(crypto) => crypto,
                None => spike::client_crypto()
                    .map_err(|error| format!("E_INTERNAL: client crypto config: {error}"))?,
            };
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
        let handshake = match self.governor.reserve_handshake() {
            Ok(reservation) => reservation,
            Err(err) => {
                self.set_last_error(err);
                return -1;
            }
        };
        let session_reservation = match self.governor.reserve_session(0) {
            Ok(reservation) => reservation,
            Err(err) => {
                self.set_last_error(err);
                return -1;
            }
        };
        let now = Instant::now();
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
        match stream.kind {
            Some(h3::stream_type::CONTROL)
            | Some(h3::stream_type::QPACK_ENCODER)
            | Some(h3::stream_type::QPACK_DECODER) => 0,
            Some(h3::frame::HEADERS) if stream.is_bidi => 0,
            Some(h3::stream_type::WT_UNI) | Some(h3::frame::WT_BIDI) if stream.handle.is_some() => {
                1
            }
            Some(h3::stream_type::WT_UNI) | Some(h3::frame::WT_BIDI) => 2,
            Some(_) => 0,
            None => 2,
        }
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
                    if self.is_server {
                        if let Err(err) =
                            self.rate_limiter
                                .check(now, source, RateLimitDimension::Handshake)
                        {
                            self.set_last_error(err);
                            let transmit = self.inner.refuse(incoming, &mut accept_buf);
                            self.endpoint_tx.push((accept_buf, transmit.destination));
                            return;
                        }
                    }
                    let handshake = match self.governor.reserve_handshake() {
                        Ok(reservation) => reservation,
                        Err(err) => {
                            self.set_last_error(err);
                            let transmit = self.inner.refuse(incoming, &mut accept_buf);
                            self.endpoint_tx.push((accept_buf, transmit.destination));
                            return;
                        }
                    };
                    let session = match self.governor.reserve_session(0) {
                        Ok(reservation) => reservation,
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
                            if let Some(t) = err.response {
                                if !accept_buf.is_empty() {
                                    self.endpoint_tx.push((accept_buf, t.destination));
                                }
                            }
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
                    if !resp.is_empty() {
                        self.endpoint_tx.push((resp, t.destination));
                    }
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
                    self.on_stream_stopped(h, id, error_code.into_inner() as u32);
                }
                QuicEvent::DatagramReceived => {
                    self.drain_datagrams(h, now);
                }
                QuicEvent::ConnectionLost { reason } => {
                    let Some(&id) = self.handle_to_id.get(&h) else {
                        return;
                    };
                    // Surface any recv data/FIN buffered at loss time BEFORE
                    // tearing down — otherwise a final payload that arrives in
                    // the same packet as CONNECTION_CLOSE (or on a paused
                    // stream) is silently dropped. Unpause only THIS
                    // connection's streams so a final drain runs.
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
                    // Surface the peer's application close code; transport-level
                    // losses (idle timeout, protocol error) report 0. A locally
                    // initiated close already emitted its Closed event in
                    // `close_conn`, so don't emit a second one.
                    match &reason {
                        quinn_proto::ConnectionError::LocallyClosed => {}
                        quinn_proto::ConnectionError::ApplicationClosed(app) => {
                            let code = u64::from(app.error_code).try_into().unwrap_or(u32::MAX);
                            self.push_event(WtEvent::Closed { conn: id, code });
                        }
                        quinn_proto::ConnectionError::TimedOut => {
                            self.set_last_error("E_SESSION_IDLE_TIMEOUT: connection idle timeout");
                            self.push_event(WtEvent::Closed { conn: id, code: 0 });
                        }
                        _ => {
                            self.push_event(WtEvent::Closed { conn: id, code: 0 });
                        }
                    }
                    // Flush any final frames (e.g. our own CONNECTION_CLOSE)
                    // before the connection state is dropped.
                    self.flush_conn_transmits(h, now);
                    self.cleanup_connection(h, now);
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
            let preamble = h3::encode_control_preamble(WT_MAX_SESSIONS);
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

    /// Read every non-paused readable stream on a connection. The CONNECT
    /// stream is processed LAST: a FIN on it ends the session (emitting Closed),
    /// and any WT stream data co-arriving in the same flight must be surfaced
    /// first so a final payload is not dropped behind the Closed event.
    fn read_streams(&mut self, h: ConnectionHandle, now: Instant) {
        let connect_stream = self.sessions.get(&h).and_then(|s| s.connect_stream);
        let ids: Vec<StreamId> = {
            let Some(s) = self.sessions.get(&h) else {
                return;
            };
            let mut ids: Vec<StreamId> = s
                .in_streams
                .iter()
                .filter(|(id, st)| {
                    Some(**id) != connect_stream
                        && st.handle.is_none_or(|hd| !self.paused.contains(&hd))
                })
                .map(|(id, _)| *id)
                .collect();
            ids.extend(
                s.self_bidi
                    .iter()
                    .filter(|(id, hd)| Some(**id) != connect_stream && !self.paused.contains(hd))
                    .map(|(id, _)| *id),
            );
            ids
        };
        for id in ids {
            self.read_one(h, id, now);
        }
        // CONNECT stream last (server: in in_streams; client: self-opened).
        if let Some(cid) = connect_stream {
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
                if outcome != ReadOutcome::Open || !made_progress {
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
                .map(|s| s.connect_stream == Some(id))
                .unwrap_or(false);
            let mut final_outcome = ReadOutcome::Open;
            for _ in 0..MAX_READ_BATCHES_PER_PUMP {
                if required_slots > 0 && !self.has_event_slot_capacity(required_slots) {
                    self.set_last_error("E_QUEUE_FULL: event queue item cap reached");
                    self.enqueue_capacity_waiter(h);
                    return;
                }
                let read_limit = self.in_stream_read_limit(h, id);
                let mut data = Vec::new();
                let outcome = read_stream(self.conns.get_mut(&h), id, &mut data, read_limit);
                let made_progress = !data.is_empty();
                if read_limit == 0 && !made_progress && outcome == ReadOutcome::Open {
                    self.enqueue_capacity_waiter(h);
                    return;
                }
                self.process_in_stream(h, id, &data, outcome == ReadOutcome::Finished, now);
                final_outcome = outcome;
                if outcome != ReadOutcome::Open || !made_progress {
                    break;
                }
            }
            match final_outcome {
                ReadOutcome::Finished => self.retire_in_stream(h, id),
                ReadOutcome::Reset(code) => {
                    self.emit_stream_reset(h, id, code as u32);
                    self.retire_in_stream(h, id);
                }
                ReadOutcome::Open => {}
            }
            // Server side: the peer ending the CONNECT stream ends the session.
            if is_connect_stream
                && matches!(final_outcome, ReadOutcome::Finished | ReadOutcome::Reset(_))
            {
                self.close_session_on_connect_end(h);
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
                if read_limit == 0 && !made_progress && outcome == ReadOutcome::Open {
                    self.enqueue_capacity_waiter(h);
                    return;
                }
                let finished = outcome == ReadOutcome::Finished;
                if made_progress || finished {
                    self.push_event(WtEvent::StreamData {
                        conn,
                        stream: handle,
                        fin: finished,
                        data,
                    });
                }
                final_outcome = outcome;
                if outcome != ReadOutcome::Open || !made_progress {
                    break;
                }
            }
            match final_outcome {
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
                        code: code as u32,
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
        }
        self.push_event(WtEvent::Closed { conn: id, code: 0 });
        // Tear down the QUIC connection too (drive() will surface
        // ConnectionLost::LocallyClosed, which is suppressed as a duplicate).
        if let Some(c) = self.conns.get_mut(&h) {
            c.close(Instant::now(), VarInt::from_u32(0), Bytes::new());
        }
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
                Some(h3::stream_type::CONTROL) => {
                    let drained = std::mem::take(&mut st.buf);
                    s.control_rx.extend_from_slice(&drained);
                    Route::Control
                }
                // Only a BIDI request stream carries a HEADERS frame. A uni
                // stream whose type varint is 0x01 (H3 PUSH) also equals
                // frame::HEADERS numerically — the is_bidi guard keeps it out of
                // the CONNECT path so a push stream can't pollute parsing.
                Some(h3::frame::HEADERS) if st.is_bidi => {
                    // Bytes stay in this stream's OWN buf; parsed per-stream.
                    Route::ServerConnect { id }
                }
                Some(h3::stream_type::QPACK_ENCODER) | Some(h3::stream_type::QPACK_DECODER) => {
                    st.buf.clear();
                    Route::Ignore
                }
                Some(h3::stream_type::WT_UNI) | Some(h3::frame::WT_BIDI) => {
                    // Consume the session-id varint once, then stream is raw data.
                    if !st.sid_read {
                        if let Some((_sid, n)) = crate::varint::decode(&st.buf) {
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
                            let reservation =
                                match self.governor.reserve_stream(conn_id, handle, stream_kind) {
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
                // Unknown/unsupported stream (incl. a uni whose type == 0x01,
                // e.g. H3 PUSH): discard its bytes so the buffer can't grow
                // without bound (a remote memory-exhaustion vector otherwise).
                _ => {
                    st.buf.clear();
                    Route::Ignore
                }
            }
        };

        match route {
            Route::Control => self.parse_control(h),
            Route::ServerConnect { id } => self.parse_server_connect(h, id),
            Route::WtData {
                handle,
                payload,
                opened,
            } => {
                if let Some((conn, stream, bidi)) = opened {
                    self.push_event(WtEvent::StreamOpened { conn, stream, bidi });
                }
                if !payload.is_empty() || finished {
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
                    if bidi {
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

    /// Server: parse HEADERS frames from a request stream's OWN buffer
    /// (`in_streams[stream_id].buf`). Every complete frame is drained (a
    /// non-CONNECT request can never wedge), a real WebTransport CONNECT is
    /// answered with 200 and establishes the session (latching the CONNECT
    /// stream to `stream_id`), and any other request is rejected with 404.
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
            let payload_and_drain = |ep: &mut Self| -> Option<Vec<u8>> {
                let st = ep.sessions.get_mut(&h)?.in_streams.get_mut(&stream_id)?;
                let payload = if is_headers {
                    st.buf[header..total].to_vec()
                } else {
                    Vec::new()
                };
                st.buf.drain(..total);
                Some(payload)
            };
            let Some(payload) = payload_and_drain(self) else {
                return;
            };
            if !is_headers {
                continue; // skip non-HEADERS frame
            }

            let headers = h3::decode_literal_headers(&payload);
            let is_connect = headers
                .as_ref()
                .map(|hs| {
                    hs.iter().any(|(k, v)| k == ":method" && v == "CONNECT")
                        && hs
                            .iter()
                            .any(|(k, v)| k == ":protocol" && v == "webtransport")
                })
                .unwrap_or(false);
            // Only the FIRST CONNECT establishes: this endpoint models one WT
            // session per QUIC connection, so a second CONNECT is rejected.
            let already = self.sessions.get(&h).map(|s| s.established).unwrap_or(true);
            if is_connect && !already {
                if let Some(conn) = self.conns.get_mut(&h) {
                    let resp = h3::encode_connect_response_ok();
                    let _ = conn.send_stream(stream_id).write(&resp);
                }
                if let Some(s) = self.sessions.get_mut(&h) {
                    s.connect_stream = Some(stream_id);
                    s.established = true;
                }
                self.handshake_reservations.remove(&h);
                self.push_event(WtEvent::SessionEstablished { conn: id });
            } else {
                // Reject (404 + FIN) so the peer fails fast rather than hanging.
                if let Some(conn) = self.conns.get_mut(&h) {
                    let resp = h3::encode_status_response("404");
                    let _ = conn.send_stream(stream_id).write(&resp);
                    let _ = conn.send_stream(stream_id).finish();
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
            let payload = if is_headers {
                match self.sessions.get(&h) {
                    Some(s) => s.connect_rx[header..total].to_vec(),
                    None => return,
                }
            } else {
                Vec::new()
            };
            if let Some(s) = self.sessions.get_mut(&h) {
                s.connect_rx.drain(..total);
            }
            if !is_headers {
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
                continue;
            }
            let headers = h3::decode_literal_headers(&payload);
            // Strictly parse the numeric :status (a malformed value is a bad
            // response, not an interim one).
            let status: Option<u16> = headers.as_ref().and_then(|hs| {
                hs.iter()
                    .find(|(k, _)| k == ":status")
                    .and_then(|(_, v)| v.parse().ok())
            });
            match status {
                // 2xx establishes the WebTransport session.
                Some(200..=299) => {
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
                Some(100..=199) => {}
                // Any other final status, or an unparseable/missing one: the
                // session will never establish. Route through the graceful-close
                // helper (exactly one Closed, QUIC torn down, FIN then a no-op).
                _ => {
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
            if let Some((_qsid, payload)) = h3::unwrap_datagram(&dg) {
                if self.is_server {
                    if let Err(err) = self.rate_limiter.check_connection(
                        now,
                        id,
                        RateLimitDimension::DatagramIngress,
                    ) {
                        self.set_last_error(err);
                        self.close_conn(id, 0, b"rate limited", now);
                        break;
                    }
                }
                if let Err(err) = self.try_push_event(WtEvent::Datagram {
                    conn: id,
                    data: payload.to_vec(),
                }) {
                    self.set_last_error(err);
                    self.close_conn(id, 0, b"inbound datagram budget exhausted", now);
                    break;
                }
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
        if payload.len() > self.governor.limits().max_datagram_size
            || self
                .max_datagram_size(conn_id)
                .is_some_and(|max| payload.len() > max)
        {
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
        let consider = |t: Instant, soonest: &mut Option<Instant>| {
            *soonest = Some(match *soonest {
                Some(s) if s <= t => s,
                _ => t,
            });
        };
        for conn in self.conns.values_mut() {
            if let Some(t) = conn.poll_timeout() {
                consider(t, &mut soonest);
            }
        }
        // Pending CONNECT deadlines (unestablished client sessions).
        for s in self.sessions.values() {
            if !s.established && !s.connect_closed {
                if let Some(t) = s.connect_deadline {
                    consider(t, &mut soonest);
                }
            }
        }
        match soonest {
            Some(t) if t > now => (t - now).as_secs_f64() * 1000.0,
            Some(_) => 0.0,
            None => -1.0,
        }
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
                !s.established && !s.connect_closed && s.connect_deadline.is_some_and(|d| d <= now)
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
        let event = self.events.pop_front()?;
        let token = match self.event_reservations.pop_front().flatten() {
            Some(reservation) => match self.governor.transfer_to_host(reservation) {
                Ok(token) => Some(token),
                Err(error) => {
                    self.set_last_error(error);
                    return None;
                }
            },
            None => None,
        };
        self.resume_waiting_after_capacity_change();
        Some(event.encode_with_host_token(token))
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

#[derive(Clone, Copy, PartialEq, Eq)]
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
                if chunk.bytes.is_empty() {
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

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;

    const CADDR: &str = "127.0.0.1:5544";
    const SADDR: &str = "127.0.0.1:4433";

    #[test]
    fn build_missing_server_crypto_should_return_stable_error_instead_of_panicking() {
        let peer_addr: SocketAddr = CADDR.parse().expect("fixed peer address");
        let error = match WtEndpoint::build(
            true,
            peer_addr,
            None,
            None,
            WasmLimits::default(),
            WasmRateLimits::default(),
        ) {
            Ok(_) => panic!("missing server crypto must fail closed"),
            Err(error) => error,
        };
        assert_eq!(error, "E_INTERNAL: server config required");
    }

    #[test]
    fn configured_handshake_and_idle_deadlines_drive_the_endpoint() {
        let caddr: SocketAddr = CADDR.parse().unwrap();
        let saddr: SocketAddr = SADDR.parse().unwrap();
        let limits = WasmLimits {
            handshake_timeout_ms: 17,
            idle_timeout_ms: 29,
            ..WasmLimits::default()
        };
        let mut client = WtEndpoint::new_with_limits(false, caddr, saddr, limits).unwrap();
        assert_eq!(client.idle_timeout_ms, 29);

        let before = Instant::now();
        let conn = client.connect("localhost") as u32;
        let after = Instant::now();
        let handle = client.id_to_handle[&conn];
        let deadline = client.sessions[&handle]
            .connect_deadline
            .expect("connect deadline");
        assert!(deadline >= before + std::time::Duration::from_millis(17));
        assert!(deadline <= after + std::time::Duration::from_millis(17));
        assert!(client.next_timeout_ms() <= 17.0);
    }

    #[test]
    fn rust_event_bytes_stay_reserved_through_bridge_transfer_and_teardown() {
        let caddr: SocketAddr = CADDR.parse().unwrap();
        let saddr: SocketAddr = SADDR.parse().unwrap();
        let limits = WasmLimits {
            max_datagram_size: 4,
            max_queued_bytes_global: 4,
            max_queued_bytes_per_session: 4,
            max_queued_bytes_per_stream: 4,
            ..WasmLimits::default()
        };
        let mut endpoint = WtEndpoint::new_with_limits(true, saddr, caddr, limits).unwrap();

        endpoint.push_event(WtEvent::Datagram {
            conn: 7,
            data: vec![1; 4],
        });
        assert_eq!(endpoint.governor.snapshot(7, None).queued_bytes_global, 4);
        endpoint.push_event(WtEvent::Datagram {
            conn: 7,
            data: vec![2],
        });
        assert_eq!(
            endpoint.take_last_error().as_deref(),
            Some("E_QUEUE_FULL: maxQueuedBytesGlobal reached")
        );
        assert_eq!(endpoint.events.len(), 1, "limit+1 event is not retained");

        let encoded = endpoint.poll_event_encoded().expect("encoded event");
        assert!(!encoded.is_empty());
        let transferred = endpoint.governor.snapshot(7, None);
        assert_eq!(transferred.queued_bytes_global, 4);
        assert_eq!(transferred.host_tokens_active, 1);

        assert_eq!(endpoint.governor.release_all_host_tokens(), 1);
        assert_eq!(
            endpoint.governor.snapshot(7, None),
            crate::governor::GovernorSnapshot::default()
        );
    }

    #[test]
    fn bridge_transfer_failure_drops_payload_instead_of_encoding_token_zero() {
        let caddr: SocketAddr = CADDR.parse().unwrap();
        let saddr: SocketAddr = SADDR.parse().unwrap();
        let limits = WasmLimits {
            max_queued_bytes_global: 2,
            max_queued_bytes_per_session: 2,
            max_queued_bytes_per_stream: 2,
            ..WasmLimits::default()
        };
        let mut endpoint = WtEndpoint::new_with_limits(true, saddr, caddr, limits).unwrap();
        endpoint.governor.set_host_token_ceiling_for_test(1);
        endpoint.push_event(WtEvent::Datagram {
            conn: 1,
            data: vec![1],
        });
        endpoint.push_event(WtEvent::Datagram {
            conn: 1,
            data: vec![2],
        });

        assert!(
            endpoint.poll_event_encoded().is_some(),
            "first token transfers"
        );
        assert!(
            endpoint.poll_event_encoded().is_none(),
            "failed transfer must drop, never deliver an unaccounted token-0 payload"
        );
        assert_eq!(
            endpoint.take_last_error().as_deref(),
            Some("E_LIMIT_EXCEEDED: host reservation token space exhausted")
        );
        let snapshot = endpoint.governor.snapshot(1, None);
        assert_eq!(snapshot.host_tokens_active, 1);
        assert_eq!(snapshot.queued_bytes_global, 1);
        assert_eq!(endpoint.governor.release_all_host_tokens(), 1);
        assert_eq!(
            endpoint.governor.snapshot(1, None),
            crate::governor::GovernorSnapshot::default()
        );
    }

    #[test]
    fn event_item_cap_accepts_exact_boundary_and_rejects_limit_plus_one() {
        let caddr: SocketAddr = CADDR.parse().unwrap();
        let saddr: SocketAddr = SADDR.parse().unwrap();
        let mut endpoint = WtEndpoint::new(true, saddr, caddr).unwrap();
        endpoint.events = std::iter::repeat_n(WtEvent::Connected { conn: 1 }, 65_536).collect();
        endpoint.event_reservations = std::iter::repeat_with(|| None).take(65_536).collect();

        endpoint.push_event(WtEvent::Connected { conn: 2 });
        assert_eq!(endpoint.events.len(), 65_536);
        assert_eq!(endpoint.event_reservations.len(), 65_536);
        assert_eq!(
            endpoint.take_last_error().as_deref(),
            Some("E_QUEUE_FULL: event queue item cap reached")
        );
    }

    #[test]
    fn decode_frame_header_never_panics_on_random_input() {
        // Robustness fuzz: random byte sequences must never panic the frame
        // header decoder (varint overflow, oversized length, truncation).
        let mut state = 0x1234_5678_9abc_def0u64;
        let mut next = || {
            state ^= state >> 12;
            state ^= state << 25;
            state ^= state >> 27;
            state.wrapping_mul(0x2545_f491_4f6c_dd1d)
        };
        for _ in 0..100_000 {
            let len = (next() as usize) % 32;
            let buf: Vec<u8> = (0..len).map(|_| next() as u8).collect();
            let _ = decode_frame_header(&buf);
        }
    }

    #[test]
    fn decode_frame_header_rejects_oversized_frame() {
        // A frame advertising a length beyond MAX_H3_FRAME_SIZE must be flagged
        // TooLarge so the connection is closed rather than buffered unbounded.
        let mut buf = Vec::new();
        crate::varint::encode(0x00, &mut buf); // ftype
        crate::varint::encode(MAX_H3_FRAME_SIZE + 1, &mut buf); // oversized length
        assert!(matches!(decode_frame_header(&buf), FrameHdr::TooLarge));

        // A within-cap frame whose payload hasn't fully arrived is Incomplete.
        let mut small = Vec::new();
        crate::varint::encode(0x00, &mut small);
        crate::varint::encode(100, &mut small);
        assert!(matches!(decode_frame_header(&small), FrameHdr::Incomplete));
    }

    /// Move all packets `from` (located at `from_addr`) emits into `to`, using
    /// `from_addr` as the datagram source so the receiver routes by it. Both
    /// endpoints are a fixed pair, so every emitted destination is `to`.
    fn relay_step_addr(from: &mut WtEndpoint, to: &mut WtEndpoint, from_addr: SocketAddr) -> bool {
        let now = Instant::now();
        let mut pkts = Vec::new();
        from.poll_transmits(now, &mut pkts);
        let moved = !pkts.is_empty();
        for (p, _dest) in pkts {
            to.recv(Instant::now(), from_addr, &p);
        }
        moved
    }

    fn endpoints() -> (WtEndpoint, WtEndpoint, u32) {
        let caddr: SocketAddr = CADDR.parse().unwrap();
        let saddr: SocketAddr = SADDR.parse().unwrap();
        let server = WtEndpoint::new(true, saddr, caddr).unwrap();
        let mut client = WtEndpoint::new(false, caddr, saddr).unwrap();
        let cid = client.connect("localhost") as u32;
        (server, client, cid)
    }

    fn relay_client_to_server(client: &mut WtEndpoint, server: &mut WtEndpoint) -> bool {
        relay_step_addr(client, server, CADDR.parse().unwrap())
    }

    fn relay_server_to_client(server: &mut WtEndpoint, client: &mut WtEndpoint) -> bool {
        relay_step_addr(server, client, SADDR.parse().unwrap())
    }

    fn decode_stream_data_event(encoded: &[u8]) -> Option<(u32, u32, bool, Vec<u8>, u32)> {
        if encoded.first().copied() != Some(crate::event::tag::STREAM_DATA) {
            return None;
        }
        let (conn, mut offset) = crate::varint::decode(&encoded[1..])?;
        offset += 1;
        let (stream, next) = crate::varint::decode(&encoded[offset..])?;
        offset += next;
        let fin = *encoded.get(offset)? != 0;
        offset += 1;
        let (len, next) = crate::varint::decode(&encoded[offset..])?;
        offset += next;
        let len: usize = len.try_into().ok()?;
        let data = encoded.get(offset..offset + len)?.to_vec();
        offset += len;
        let (token, _next) = crate::varint::decode(&encoded[offset..])?;
        Some((conn as u32, stream as u32, fin, data, token as u32))
    }

    #[test]
    fn datagram_size_accepts_exact_limit_and_rejects_limit_plus_one_stably() {
        let caddr: SocketAddr = CADDR.parse().unwrap();
        let saddr: SocketAddr = SADDR.parse().unwrap();
        let server_limits = WasmLimits {
            max_datagram_size: 4,
            ..WasmLimits::default()
        };
        let client_limits = server_limits.clone();
        let mut server = WtEndpoint::new_with_limits(true, saddr, caddr, server_limits).unwrap();
        let mut client = WtEndpoint::new_with_limits(false, caddr, saddr, client_limits).unwrap();
        let conn = client.connect("localhost") as u32;
        let mut established = false;

        for _ in 0..400 {
            let moved = relay_client_to_server(&mut client, &mut server)
                | relay_server_to_client(&mut server, &mut client);
            while let Some(event) = client.poll_event() {
                if matches!(event, WtEvent::SessionEstablished { .. }) {
                    established = true;
                }
            }
            while server.poll_event().is_some() {}
            if established {
                break;
            }
            if !moved {
                let now = Instant::now();
                server.handle_timeout(now);
                client.handle_timeout(now);
            }
        }

        assert!(
            established,
            "session establishes before boundary assertions"
        );
        assert!(client.send_datagram(conn, b"1234"), "exact limit succeeds");
        assert!(!client.send_datagram(conn, b"12345"), "limit+1 fails");
        assert_eq!(
            client.take_last_error().as_deref(),
            Some("E_LIMIT_EXCEEDED: maxDatagramSize exceeded")
        );
    }

    #[test]
    fn datagram_size_respects_negotiated_transport_capacity_stably() {
        let caddr: SocketAddr = CADDR.parse().unwrap();
        let saddr: SocketAddr = SADDR.parse().unwrap();
        let limits = WasmLimits {
            max_datagram_size: 100_000,
            ..WasmLimits::default()
        };
        let mut server = WtEndpoint::new_with_limits(true, saddr, caddr, limits.clone()).unwrap();
        let mut client = WtEndpoint::new_with_limits(false, caddr, saddr, limits).unwrap();
        let conn = client.connect("localhost") as u32;
        let mut established = false;

        for _ in 0..400 {
            let moved = relay_client_to_server(&mut client, &mut server)
                | relay_server_to_client(&mut server, &mut client);
            while let Some(event) = client.poll_event() {
                if matches!(event, WtEvent::SessionEstablished { .. }) {
                    established = true;
                }
            }
            while server.poll_event().is_some() {}
            if established {
                break;
            }
            if !moved {
                let now = Instant::now();
                server.handle_timeout(now);
                client.handle_timeout(now);
            }
        }

        assert!(established, "session establishes before size assertions");
        let effective = client
            .max_datagram_size(conn)
            .expect("established connection supports datagrams");
        assert!(effective > 0);
        assert!(effective < 64 * 1024);
        assert!(!client.send_datagram(conn, &vec![0; 64 * 1024]));
        assert_eq!(
            client.take_last_error().as_deref(),
            Some("E_LIMIT_EXCEEDED: maxDatagramSize exceeded")
        );
    }

    #[test]
    fn outgoing_stream_limit_rejects_before_allocating_a_quic_stream_or_handle() {
        let caddr: SocketAddr = CADDR.parse().unwrap();
        let saddr: SocketAddr = SADDR.parse().unwrap();
        let server_limits = WasmLimits::default();
        let client_limits = WasmLimits {
            max_streams_per_session_bidi: 1,
            max_streams_per_session_uni: 1,
            max_streams_global: 1,
            ..WasmLimits::default()
        };
        let mut server = WtEndpoint::new_with_limits(true, saddr, caddr, server_limits).unwrap();
        let mut client = WtEndpoint::new_with_limits(false, caddr, saddr, client_limits).unwrap();
        let conn = client.connect("localhost") as u32;
        let mut established = false;
        for _ in 0..400 {
            relay_client_to_server(&mut client, &mut server);
            relay_server_to_client(&mut server, &mut client);
            while let Some(event) = client.poll_event() {
                if matches!(event, WtEvent::SessionEstablished { .. }) {
                    established = true;
                }
            }
            while server.poll_event().is_some() {}
            if established {
                break;
            }
        }
        assert!(
            established,
            "session establishes before stream limit assertions"
        );

        assert!(client.open_stream(conn, true) > 0, "exact limit succeeds");
        let next_handle = client.next_stream;
        assert_eq!(client.open_stream(conn, true), -1, "limit+1 fails");
        assert_eq!(
            client.next_stream, next_handle,
            "rejected open must not consume or expose a stream handle"
        );
        assert_eq!(client.stream_index.len(), 1);
        assert_eq!(client.stream_reservations.len(), 1);
        assert_eq!(
            client.take_last_error().as_deref(),
            Some("E_LIMIT_EXCEEDED: maxStreamsGlobal reached")
        );
    }

    #[test]
    fn incoming_stream_limit_drops_parser_state_instead_of_buffering_untracked_bytes() {
        use quinn_proto::{Dir, Side};

        let caddr: SocketAddr = CADDR.parse().unwrap();
        let saddr: SocketAddr = SADDR.parse().unwrap();
        let limits = WasmLimits {
            max_streams_per_session_bidi: 1,
            max_streams_per_session_uni: 1,
            max_streams_global: 1,
            ..WasmLimits::default()
        };
        let mut endpoint = WtEndpoint::new_with_limits(true, saddr, caddr, limits).unwrap();
        let h = ConnectionHandle(0);
        let stream_id = StreamId::new(Side::Client, Dir::Bi, 0);
        endpoint.handle_to_id.insert(h, 1);
        endpoint.id_to_handle.insert(1, h);
        let mut session = Session::default();
        session.in_streams.insert(
            stream_id,
            InStream {
                kind: None,
                is_bidi: true,
                sid_read: false,
                handle: None,
                buf: Vec::new(),
            },
        );
        endpoint.sessions.insert(h, session);
        let _ = endpoint
            .rate_limiter
            .attach_connection(1, caddr, Instant::now());
        let held = endpoint
            .governor
            .reserve_stream(1, 99, StreamKind::Bidi)
            .expect("fill exact stream limit");
        endpoint.stream_reservations.insert(99, held);

        let mut encoded = Vec::new();
        crate::varint::encode(h3::frame::WT_BIDI, &mut encoded);
        crate::varint::encode(0, &mut encoded);
        encoded.extend_from_slice(&[7; 64]);
        endpoint.process_in_stream(h, stream_id, &encoded, false, Instant::now());

        assert!(
            !endpoint.sessions[&h].in_streams.contains_key(&stream_id),
            "rejected stream parser state and payload must be dropped"
        );
        assert_eq!(
            endpoint.next_stream, 1,
            "rejection must not consume a handle"
        );
        assert_eq!(
            endpoint.take_last_error().as_deref(),
            Some("E_LIMIT_EXCEEDED: maxStreamsGlobal reached")
        );
    }

    #[test]
    fn incoming_stream_without_owner_mapping_fails_closed_without_allocating_state() {
        use quinn_proto::{Dir, Side};

        let caddr: SocketAddr = CADDR.parse().unwrap();
        let saddr: SocketAddr = SADDR.parse().unwrap();
        let mut endpoint = WtEndpoint::new(true, saddr, caddr).unwrap();
        let h = ConnectionHandle(0);
        let stream_id = StreamId::new(Side::Client, Dir::Bi, 0);
        endpoint.handle_to_id.insert(h, 1);
        endpoint.id_to_handle.insert(1, h);
        let mut session = Session::default();
        session.in_streams.insert(
            stream_id,
            InStream {
                kind: None,
                is_bidi: true,
                sid_read: false,
                handle: None,
                buf: Vec::new(),
            },
        );
        endpoint.sessions.insert(h, session);

        let mut encoded = Vec::new();
        crate::varint::encode(h3::frame::WT_BIDI, &mut encoded);
        crate::varint::encode(0, &mut encoded);
        encoded.extend_from_slice(&[7; 8]);
        endpoint.process_in_stream(h, stream_id, &encoded, false, Instant::now());

        assert!(
            !endpoint.sessions[&h].in_streams.contains_key(&stream_id),
            "missing owner mapping must reject and retire the parser state"
        );
        assert_eq!(
            endpoint.next_stream, 1,
            "missing owner mapping must not consume a stream handle"
        );
        assert_eq!(endpoint.stream_reservations.len(), 0);
        assert!(
            endpoint.events.is_empty(),
            "rejected stream must not emit WT events"
        );
        assert_eq!(
            endpoint.take_last_error().as_deref(),
            Some("E_INTERNAL: missing peer ownership for streamOpens rate limiting")
        );
    }

    #[test]
    fn wt_session_and_datagram_echo() {
        let (mut server, mut client, cid) = endpoints();
        let mut server_est = false;
        let mut client_est = false;
        let mut echoed = false;

        for _ in 0..400 {
            let a = relay_client_to_server(&mut client, &mut server);
            let b = relay_server_to_client(&mut server, &mut client);
            while let Some(ev) = server.poll_event() {
                match ev {
                    WtEvent::SessionEstablished { .. } => server_est = true,
                    WtEvent::Datagram { conn, data } => {
                        server.send_datagram(conn, &data);
                    }
                    _ => {}
                }
            }
            while let Some(ev) = client.poll_event() {
                match ev {
                    WtEvent::SessionEstablished { .. } => client_est = true,
                    WtEvent::Datagram { data, .. } => {
                        assert_eq!(data, b"ping");
                        echoed = true;
                    }
                    _ => {}
                }
            }
            if server_est && client_est && !echoed {
                client.send_datagram(cid, b"ping");
            }
            if echoed {
                break;
            }
            if !a && !b {
                let now = Instant::now();
                server.handle_timeout(now);
                client.handle_timeout(now);
            }
        }
        assert!(server_est && client_est && echoed);
    }

    #[test]
    fn wt_bidi_stream_echo() {
        let (mut server, mut client, cid) = endpoints();
        let mut server_est = false;
        let mut client_est = false;
        let mut client_stream: Option<u32> = None;
        let mut sent = false;
        let mut echo: Option<Vec<u8>> = None;
        // server side: map of accepted bidi stream -> echo it
        for _ in 0..600 {
            let a = relay_client_to_server(&mut client, &mut server);
            let b = relay_server_to_client(&mut server, &mut client);
            while let Some(ev) = server.poll_event() {
                match ev {
                    WtEvent::SessionEstablished { .. } => server_est = true,
                    WtEvent::StreamData { stream, data, .. } if !data.is_empty() => {
                        server.stream_write(stream, &data);
                    }
                    _ => {}
                }
            }
            while let Some(ev) = client.poll_event() {
                match ev {
                    WtEvent::SessionEstablished { .. } => client_est = true,
                    WtEvent::StreamData { data, .. } if !data.is_empty() => {
                        echo = Some(data);
                    }
                    _ => {}
                }
            }
            if server_est && client_est && client_stream.is_none() {
                let s = client.open_stream(cid, true);
                assert!(s >= 0);
                client_stream = Some(s as u32);
            }
            if let Some(s) = client_stream {
                if !sent {
                    client.stream_write(s, b"hello-bidi");
                    sent = true;
                }
            }
            if echo.is_some() {
                break;
            }
            if !a && !b {
                let now = Instant::now();
                server.handle_timeout(now);
                client.handle_timeout(now);
            }
        }
        assert_eq!(echo.as_deref(), Some(&b"hello-bidi"[..]));
    }

    #[test]
    fn reliable_stream_data_larger_than_event_budget_is_backpressured_not_dropped() {
        let caddr: SocketAddr = CADDR.parse().unwrap();
        let saddr: SocketAddr = SADDR.parse().unwrap();
        let limits = WasmLimits {
            max_queued_bytes_global: 16 * 1024,
            max_queued_bytes_per_session: 8 * 1024,
            max_queued_bytes_per_stream: 4 * 1024,
            ..WasmLimits::default()
        };
        let mut server = WtEndpoint::new_with_limits(true, saddr, caddr, limits.clone()).unwrap();
        let mut client = WtEndpoint::new_with_limits(false, caddr, saddr, limits).unwrap();
        let conn = client.connect("localhost") as u32;
        let mut server_established = false;
        let mut client_established = false;

        for _ in 0..600 {
            let moved = relay_client_to_server(&mut client, &mut server)
                | relay_server_to_client(&mut server, &mut client);
            while let Some(event) = server.poll_event() {
                if matches!(event, WtEvent::SessionEstablished { .. }) {
                    server_established = true;
                }
            }
            while let Some(event) = client.poll_event() {
                if matches!(event, WtEvent::SessionEstablished { .. }) {
                    client_established = true;
                }
            }
            if server_established && client_established {
                break;
            }
            if !moved {
                let now = Instant::now();
                server.handle_timeout(now);
                client.handle_timeout(now);
            }
        }
        assert!(server_established && client_established);

        let stream = client.open_stream(conn, true);
        assert!(stream >= 0);
        let stream = stream as u32;
        let payload: Vec<u8> = (0..64 * 1024).map(|index| (index % 251) as u8).collect();
        let mut sent = 0usize;
        let mut received = Vec::with_capacity(payload.len());

        for _ in 0..10_000 {
            if sent < payload.len() {
                let accepted = client.stream_write(stream, &payload[sent..]);
                assert!(accepted >= 0, "stream write should not fail");
                sent += accepted as usize;
            }
            let moved = relay_client_to_server(&mut client, &mut server)
                | relay_server_to_client(&mut server, &mut client);
            while let Some(event) = server.poll_event() {
                if let WtEvent::StreamData { data, .. } = event {
                    received.extend_from_slice(&data);
                }
            }
            while client.poll_event().is_some() {}
            if sent == payload.len() && received.len() == payload.len() {
                break;
            }
            if !moved {
                let now = Instant::now();
                server.handle_timeout(now);
                client.handle_timeout(now);
            }
        }

        assert_eq!(sent, payload.len(), "the sender accepted the full payload");
        assert_eq!(
            received, payload,
            "reliable stream bytes must never be dropped"
        );
        assert_ne!(
            server.take_last_error().as_deref(),
            Some("E_QUEUE_FULL: maxQueuedBytesPerStream reached"),
        );
    }

    #[test]
    fn full_event_queue_backpressures_reliable_stream_reads_without_losing_bytes() {
        let (mut server, mut client, _cid) = endpoints();
        let mut server_conn = None;
        let mut client_established = false;
        let mut client_stream = None;

        for _ in 0..2_000 {
            let moved = relay_client_to_server(&mut client, &mut server)
                | relay_server_to_client(&mut server, &mut client);
            while let Some(event) = server.poll_event() {
                if let WtEvent::SessionEstablished { conn } = event {
                    server_conn = Some(conn);
                }
            }
            while let Some(event) = client.poll_event() {
                match event {
                    WtEvent::SessionEstablished { .. } => client_established = true,
                    WtEvent::StreamOpened { stream, .. } => client_stream = Some(stream),
                    _ => {}
                }
            }
            if client_established && client_stream.is_none() {
                let stream = server.open_stream(server_conn.expect("server conn"), true);
                assert!(stream >= 0);
            }
            if client_established && client_stream.is_some() {
                break;
            }
            if !moved {
                let now = Instant::now();
                server.handle_timeout(now);
                client.handle_timeout(now);
            }
        }

        let client_stream = client_stream.expect("client observed opened stream");
        server.events =
            std::iter::repeat_n(WtEvent::Connected { conn: 9 }, MAX_PENDING_EVENTS).collect();
        server.event_reservations = std::iter::repeat_with(|| None)
            .take(MAX_PENDING_EVENTS)
            .collect();

        client.stream_write(client_stream, b"queued-data");

        for _ in 0..10 {
            let moved = relay_client_to_server(&mut client, &mut server)
                | relay_server_to_client(&mut server, &mut client);
            while client.poll_event().is_some() {}
            if !moved {
                break;
            }
        }

        assert_eq!(server.events.len(), MAX_PENDING_EVENTS);
        assert_eq!(
            server.take_last_error().as_deref(),
            Some("E_QUEUE_FULL: event queue item cap reached")
        );

        assert!(server.poll_event().is_some(), "free one queue slot");
        assert!(matches!(
            server.events.back(),
            Some(WtEvent::StreamData { data, .. }) if data == b"queued-data"
        ));
    }

    #[test]
    fn releasing_one_host_token_resumes_other_connections_blocked_by_global_capacity() {
        let limits = WasmLimits {
            max_queued_bytes_global: 4,
            max_queued_bytes_per_session: 4,
            max_queued_bytes_per_stream: 4,
            ..WasmLimits::default()
        };
        let saddr: SocketAddr = "127.0.0.1:443".parse().unwrap();
        let a_addr: SocketAddr = "127.0.0.1:1001".parse().unwrap();
        let b_addr: SocketAddr = "127.0.0.1:1002".parse().unwrap();

        let mut server = WtEndpoint::new_with_limits(true, saddr, a_addr, limits.clone()).unwrap();
        let mut client_a =
            WtEndpoint::new_with_limits(false, a_addr, saddr, limits.clone()).unwrap();
        let mut client_b = WtEndpoint::new_with_limits(false, b_addr, saddr, limits).unwrap();
        client_a.connect("localhost");
        client_b.connect("localhost");

        fn drain2(from: &mut WtEndpoint) -> Vec<(SocketAddr, Vec<u8>)> {
            let mut pkts = Vec::new();
            from.poll_transmits(Instant::now(), &mut pkts);
            pkts.into_iter().map(|(p, dest)| (dest, p)).collect()
        }

        let mut conn_a = None;
        let mut conn_b = None;
        let mut client_a_established = false;
        let mut client_b_established = false;
        let mut stream_a = None;
        let mut stream_b = None;
        let mut opened = false;

        for _ in 0..3_000 {
            let mut wire: Vec<(SocketAddr, SocketAddr, Vec<u8>)> = Vec::new();
            for (dest, p) in drain2(&mut client_a) {
                wire.push((a_addr, dest, p));
            }
            for (dest, p) in drain2(&mut client_b) {
                wire.push((b_addr, dest, p));
            }
            for (dest, p) in drain2(&mut server) {
                wire.push((saddr, dest, p));
            }
            let moved = !wire.is_empty();
            for (src, dest, p) in wire {
                let now = Instant::now();
                if dest == saddr {
                    server.recv(now, src, &p);
                } else if dest == a_addr {
                    client_a.recv(now, src, &p);
                } else if dest == b_addr {
                    client_b.recv(now, src, &p);
                }
            }
            while let Some(event) = server.poll_event() {
                if let WtEvent::SessionEstablished { conn } = event {
                    if conn_a.is_none() {
                        conn_a = Some(conn);
                    } else if Some(conn) != conn_a {
                        conn_b = Some(conn);
                    }
                }
            }
            while let Some(event) = client_a.poll_event() {
                match event {
                    WtEvent::SessionEstablished { .. } => client_a_established = true,
                    WtEvent::StreamOpened { stream, .. } => stream_a = Some(stream),
                    _ => {}
                }
            }
            while let Some(event) = client_b.poll_event() {
                match event {
                    WtEvent::SessionEstablished { .. } => client_b_established = true,
                    WtEvent::StreamOpened { stream, .. } => stream_b = Some(stream),
                    _ => {}
                }
            }
            if conn_a.is_some()
                && conn_b.is_some()
                && client_a_established
                && client_b_established
                && !opened
            {
                if let (Some(conn_a), Some(conn_b)) = (conn_a, conn_b) {
                    assert!(server.open_stream(conn_a, true) >= 0);
                    assert!(server.open_stream(conn_b, true) >= 0);
                    opened = true;
                }
            }
            if stream_a.is_some() && stream_b.is_some() {
                break;
            }
            if !moved {
                let now = Instant::now();
                server.handle_timeout(now);
                client_a.handle_timeout(now);
                client_b.handle_timeout(now);
            }
        }

        let stream_a = stream_a.expect("client a stream");
        let stream_b = stream_b.expect("client b stream");
        client_a.stream_write(stream_a, b"aaaa");

        let (first_conn, token_a) = 'token_a: loop {
            let mut wire: Vec<(SocketAddr, SocketAddr, Vec<u8>)> = Vec::new();
            for (dest, p) in drain2(&mut client_a) {
                wire.push((a_addr, dest, p));
            }
            for (dest, p) in drain2(&mut client_b) {
                wire.push((b_addr, dest, p));
            }
            for (dest, p) in drain2(&mut server) {
                wire.push((saddr, dest, p));
            }
            let moved = !wire.is_empty();
            for (src, dest, p) in wire {
                let now = Instant::now();
                if dest == saddr {
                    server.recv(now, src, &p);
                } else if dest == a_addr {
                    client_a.recv(now, src, &p);
                } else if dest == b_addr {
                    client_b.recv(now, src, &p);
                }
            }
            if let Some(encoded) = server.poll_event_encoded() {
                if let Some((conn, _stream, _fin, data, token)) = decode_stream_data_event(&encoded)
                {
                    assert_eq!(data, b"aaaa");
                    break 'token_a (conn, token);
                }
            }
            if !moved {
                let now = Instant::now();
                server.handle_timeout(now);
                client_a.handle_timeout(now);
            }
        };
        assert!(token_a > 0, "first payload must retain a host token");

        client_b.stream_write(stream_b, b"bbbb");
        for _ in 0..20 {
            let mut wire: Vec<(SocketAddr, SocketAddr, Vec<u8>)> = Vec::new();
            for (dest, p) in drain2(&mut client_a) {
                wire.push((a_addr, dest, p));
            }
            for (dest, p) in drain2(&mut client_b) {
                wire.push((b_addr, dest, p));
            }
            for (dest, p) in drain2(&mut server) {
                wire.push((saddr, dest, p));
            }
            let moved = !wire.is_empty();
            for (src, dest, p) in wire {
                let now = Instant::now();
                if dest == saddr {
                    server.recv(now, src, &p);
                } else if dest == a_addr {
                    client_a.recv(now, src, &p);
                } else if dest == b_addr {
                    client_b.recv(now, src, &p);
                }
            }
            assert!(
                server.poll_event_encoded().is_none(),
                "global capacity should block the second connection until release"
            );
            if !moved {
                break;
            }
        }

        assert!(server.release_host_token(token_a));
        let encoded = server
            .poll_event_encoded()
            .expect("releasing one token should immediately resume the other connection");
        let (conn, _stream, _fin, data, token_b) =
            decode_stream_data_event(&encoded).expect("stream data event");
        assert_ne!(conn, first_conn);
        assert_eq!(data, b"bbbb");
        assert!(token_b > 0);
    }

    #[test]
    fn wt_uni_stream_oneway() {
        let (mut server, mut client, cid) = endpoints();
        let mut server_est = false;
        let mut client_est = false;
        let mut opened = false;
        let mut got: Vec<u8> = Vec::new();
        let mut got_fin = false;
        for _ in 0..600 {
            let a = relay_client_to_server(&mut client, &mut server);
            let b = relay_server_to_client(&mut server, &mut client);
            while let Some(ev) = server.poll_event() {
                match ev {
                    WtEvent::SessionEstablished { .. } => server_est = true,
                    WtEvent::StreamData { data, fin, .. } => {
                        got.extend_from_slice(&data);
                        if fin {
                            got_fin = true;
                        }
                    }
                    _ => {}
                }
            }
            while let Some(ev) = client.poll_event() {
                if let WtEvent::SessionEstablished { .. } = ev {
                    client_est = true;
                }
            }
            if server_est && client_est && !opened {
                let s = client.open_stream(cid, false);
                assert!(s >= 0);
                client.stream_write(s as u32, b"uni-msg");
                client.stream_finish(s as u32);
                opened = true;
            }
            if got_fin {
                break;
            }
            if !a && !b {
                let now = Instant::now();
                server.handle_timeout(now);
                client.handle_timeout(now);
            }
        }
        assert_eq!(got, b"uni-msg");
        assert!(got_fin, "uni stream should signal FIN");
    }

    /// Two clients at distinct source addresses share one server endpoint. Each
    /// must complete its own handshake + WT session, get ITS OWN datagram echoed
    /// back, and never observe the other client's payload (routing isolation).
    #[test]
    fn multi_client_datagram_isolation() {
        let saddr: SocketAddr = "127.0.0.1:443".parse().unwrap();
        let a_addr: SocketAddr = "127.0.0.1:1001".parse().unwrap();
        let b_addr: SocketAddr = "127.0.0.1:1002".parse().unwrap();

        let mut server = WtEndpoint::new(true, saddr, a_addr).unwrap();
        let mut client_a = WtEndpoint::new(false, a_addr, saddr).unwrap();
        let mut client_b = WtEndpoint::new(false, b_addr, saddr).unwrap();
        let cid_a = client_a.connect("localhost") as u32;
        let cid_b = client_b.connect("localhost") as u32;

        // Drain one endpoint (located at `from_addr`) into `(from_addr, dest, pkt)`
        // records so the switch below can route by destination without overlapping
        // mutable borrows of the endpoints.
        fn drain(from: &mut WtEndpoint, _from_addr: SocketAddr) -> Vec<(SocketAddr, Vec<u8>)> {
            let mut pkts = Vec::new();
            from.poll_transmits(Instant::now(), &mut pkts);
            pkts.into_iter().map(|(p, dest)| (dest, p)).collect()
        }

        let mut a_est = false;
        let mut b_est = false;
        let mut a_got: Vec<Vec<u8>> = Vec::new();
        let mut b_got: Vec<Vec<u8>> = Vec::new();
        let mut a_sent = false;
        let mut b_sent = false;
        // Keep pumping a while after both echoes arrive to catch LATE cross-talk.
        let mut linger = 0u32;

        for _ in 0..1200 {
            // Collect everything emitted this tick, then deliver by destination.
            let mut wire: Vec<(SocketAddr, SocketAddr, Vec<u8>)> = Vec::new();
            for (dest, p) in drain(&mut client_a, a_addr) {
                wire.push((a_addr, dest, p));
            }
            for (dest, p) in drain(&mut client_b, b_addr) {
                wire.push((b_addr, dest, p));
            }
            for (dest, p) in drain(&mut server, saddr) {
                wire.push((saddr, dest, p));
            }
            let moved = !wire.is_empty();
            for (src, dest, p) in wire {
                let now = Instant::now();
                if dest == saddr {
                    server.recv(now, src, &p);
                } else if dest == a_addr {
                    client_a.recv(now, src, &p);
                } else if dest == b_addr {
                    client_b.recv(now, src, &p);
                }
            }

            // Server echoes each datagram back to the connection it arrived on.
            while let Some(ev) = server.poll_event() {
                if let WtEvent::Datagram { conn, data } = ev {
                    server.send_datagram(conn, &data);
                }
            }
            while let Some(ev) = client_a.poll_event() {
                match ev {
                    WtEvent::SessionEstablished { .. } => a_est = true,
                    WtEvent::Datagram { data, .. } => {
                        // Isolation must hold on EVERY delivery, not just the last.
                        assert_ne!(
                            data.as_slice(),
                            &b"bravo-payload"[..],
                            "client A must never see client B's payload"
                        );
                        a_got.push(data);
                    }
                    _ => {}
                }
            }
            while let Some(ev) = client_b.poll_event() {
                match ev {
                    WtEvent::SessionEstablished { .. } => b_est = true,
                    WtEvent::Datagram { data, .. } => {
                        assert_ne!(
                            data.as_slice(),
                            &b"alpha-payload"[..],
                            "client B must never see client A's payload"
                        );
                        b_got.push(data);
                    }
                    _ => {}
                }
            }

            if a_est && !a_sent {
                client_a.send_datagram(cid_a, b"alpha-payload");
                a_sent = true;
            }
            if b_est && !b_sent {
                client_b.send_datagram(cid_b, b"bravo-payload");
                b_sent = true;
            }

            if !a_got.is_empty() && !b_got.is_empty() {
                linger += 1;
                if linger > 40 {
                    break;
                }
            }
            if !moved {
                let now = Instant::now();
                server.handle_timeout(now);
                client_a.handle_timeout(now);
                client_b.handle_timeout(now);
            }
        }

        assert!(a_est, "client A session should establish");
        assert!(b_est, "client B session should establish");
        // Each client got exactly its own payload echoed — nothing else, ever.
        assert_eq!(
            a_got,
            vec![b"alpha-payload".to_vec()],
            "client A gets exactly its own payload echoed"
        );
        assert_eq!(
            b_got,
            vec![b"bravo-payload".to_vec()],
            "client B gets exactly its own payload echoed"
        );
    }

    /// Per-stream recv state must be dropped once a stream finishes — a
    /// long-lived connection cycling many streams must not grow endpoint maps.
    #[test]
    fn finished_streams_are_pruned() {
        let caddr: SocketAddr = CADDR.parse().unwrap();
        let saddr: SocketAddr = SADDR.parse().unwrap();
        let mut server = WtEndpoint::new(true, saddr, caddr).unwrap();
        let mut client = WtEndpoint::new(false, caddr, saddr).unwrap();
        let cid = client.connect("localhost") as u32;

        let mut server_est = false;
        let mut client_est = false;
        let mut fins = 0usize;
        let mut opened = 0usize;
        const ROUNDS: usize = 5;

        for _ in 0..4000 {
            let a = relay_step_addr(&mut client, &mut server, caddr);
            let b = relay_step_addr(&mut server, &mut client, saddr);
            while let Some(ev) = server.poll_event() {
                match ev {
                    WtEvent::SessionEstablished { .. } => server_est = true,
                    WtEvent::StreamData { fin: true, .. } => fins += 1,
                    _ => {}
                }
            }
            while let Some(ev) = client.poll_event() {
                if let WtEvent::SessionEstablished { .. } = ev {
                    client_est = true;
                }
            }
            if server_est && client_est && opened < ROUNDS && fins == opened {
                let s = client.open_stream(cid, false);
                assert!(s >= 0);
                client.stream_write(s as u32, b"cycle");
                client.stream_finish(s as u32);
                opened += 1;
            }
            if fins == ROUNDS {
                break;
            }
            if !a && !b {
                let now = Instant::now();
                server.handle_timeout(now);
                client.handle_timeout(now);
            }
        }
        assert_eq!(fins, ROUNDS, "all {ROUNDS} uni streams should FIN");

        // Server side: every finished uni stream's recv state and index entry
        // must be gone (control/qpack/CONNECT streams legitimately remain).
        let s_session = server.sessions.values().next().expect("server session");
        assert!(
            s_session.in_streams.values().all(|st| st.handle.is_none()),
            "no finished WT stream should retain recv state"
        );
        assert!(
            server.stream_index.is_empty(),
            "server stream_index should be empty after all streams finished"
        );
        // Client side: finishing a self-opened uni stream releases its index.
        assert!(
            client.stream_index.is_empty(),
            "client stream_index should be empty after finishing its streams"
        );
    }

    /// Bidi streams must release their index once BOTH halves finish — the
    /// uni-only pruning regression left completed bidi streams resident.
    #[test]
    fn finished_bidi_streams_are_pruned() {
        let caddr: SocketAddr = CADDR.parse().unwrap();
        let saddr: SocketAddr = SADDR.parse().unwrap();
        let mut server = WtEndpoint::new(true, saddr, caddr).unwrap();
        let mut client = WtEndpoint::new(false, caddr, saddr).unwrap();
        let cid = client.connect("localhost") as u32;

        let mut server_est = false;
        let mut client_est = false;
        let mut echoes = 0usize;
        let mut opened = 0usize;
        let mut open_handle: Option<u32> = None;
        const ROUNDS: usize = 3;

        for _ in 0..6000 {
            let a = relay_step_addr(&mut client, &mut server, caddr);
            let b = relay_step_addr(&mut server, &mut client, saddr);
            while let Some(ev) = server.poll_event() {
                match ev {
                    WtEvent::SessionEstablished { .. } => server_est = true,
                    WtEvent::StreamData {
                        stream,
                        fin: true,
                        data,
                        ..
                    } => {
                        // Echo the full request back and finish our half.
                        server.stream_write(stream, &data);
                        server.stream_finish(stream);
                    }
                    _ => {}
                }
            }
            while let Some(ev) = client.poll_event() {
                match ev {
                    WtEvent::SessionEstablished { .. } => client_est = true,
                    WtEvent::StreamData { fin: true, .. } => {
                        echoes += 1;
                        open_handle = None;
                    }
                    _ => {}
                }
            }
            if server_est
                && client_est
                && opened < ROUNDS
                && open_handle.is_none()
                && echoes == opened
            {
                let s = client.open_stream(cid, true);
                assert!(s >= 0);
                let s = s as u32;
                client.stream_write(s, b"bidi-cycle");
                client.stream_finish(s);
                open_handle = Some(s);
                opened += 1;
            }
            if echoes == ROUNDS {
                break;
            }
            if !a && !b {
                let now = Instant::now();
                server.handle_timeout(now);
                client.handle_timeout(now);
            }
        }
        assert_eq!(echoes, ROUNDS, "all {ROUNDS} bidi echoes should complete");
        assert!(
            client.stream_index.is_empty(),
            "client bidi stream_index should be empty after both halves finish"
        );
        assert!(
            server.stream_index.is_empty(),
            "server bidi stream_index should be empty after both halves finish"
        );
        assert!(client.half_done.is_empty() && server.half_done.is_empty());
    }

    /// Fabricate a server session with one peer-accepted bidi request stream
    /// carrying `frame` in its OWN buffer, ready for parse_server_connect.
    fn server_with_request(frame: Vec<u8>) -> (WtEndpoint, ConnectionHandle, StreamId) {
        use quinn_proto::{Dir, Side};
        let caddr: SocketAddr = CADDR.parse().unwrap();
        let saddr: SocketAddr = SADDR.parse().unwrap();
        let mut server = WtEndpoint::new(true, saddr, caddr).unwrap();
        let h = ConnectionHandle(0);
        server.handle_to_id.insert(h, 1);
        server.id_to_handle.insert(1, h);
        let stream_id = StreamId::new(Side::Client, Dir::Bi, 0);
        let mut sess = Session::default();
        sess.in_streams.insert(
            stream_id,
            InStream {
                kind: Some(h3::frame::HEADERS),
                is_bidi: true,
                sid_read: false,
                handle: None,
                buf: frame,
            },
        );
        server.sessions.insert(h, sess);
        (server, h, stream_id)
    }

    /// A non-CONNECT HEADERS frame on a request stream must be DRAINED (not
    /// re-parsed forever) and must not establish a session.
    #[test]
    fn non_connect_request_is_drained_not_wedged() {
        let (mut server, h, stream_id) =
            server_with_request(h3::encode_get_request("localhost", "/nope"));
        server.parse_server_connect(h, stream_id);
        let s = server.sessions.get(&h).unwrap();
        assert!(
            s.in_streams.get(&stream_id).unwrap().buf.is_empty(),
            "non-CONNECT frame must be drained, not left to re-parse"
        );
        assert!(!s.established, "a GET must not establish a WT session");
    }

    /// Two request streams parsed independently must not corrupt each other:
    /// a partial frame on one and a full CONNECT on the other still establishes.
    #[test]
    fn concurrent_request_streams_do_not_interleave() {
        use quinn_proto::{Dir, Side};
        let (mut server, h, connect_sid) =
            server_with_request(h3::encode_connect_request("localhost", "/"));
        // A second request stream holding only a PARTIAL frame (1 byte).
        let other_sid = StreamId::new(Side::Client, Dir::Bi, 4);
        server.sessions.get_mut(&h).unwrap().in_streams.insert(
            other_sid,
            InStream {
                kind: Some(h3::frame::HEADERS),
                is_bidi: true,
                sid_read: false,
                handle: None,
                buf: vec![0x01], // incomplete HEADERS frame
            },
        );
        // Parsing the partial stream must be a no-op (not wedge, not consume).
        server.parse_server_connect(h, other_sid);
        // Parsing the CONNECT stream establishes cleanly regardless.
        server.parse_server_connect(h, connect_sid);
        let s = server.sessions.get(&h).unwrap();
        assert!(
            s.established,
            "CONNECT establishes despite a concurrent stream"
        );
        assert_eq!(s.connect_stream, Some(connect_sid));
        assert_eq!(
            s.in_streams.get(&other_sid).unwrap().buf,
            vec![0x01],
            "the other stream's partial frame is untouched"
        );
    }

    /// A real CONNECT frame establishes and latches the CONNECT stream to the
    /// stream it arrived on.
    #[test]
    fn connect_request_latches_stream_and_establishes() {
        let (mut server, h, stream_id) =
            server_with_request(h3::encode_connect_request("localhost", "/"));
        server.parse_server_connect(h, stream_id);
        let s = server.sessions.get(&h).unwrap();
        assert!(s.in_streams.get(&stream_id).unwrap().buf.is_empty());
        assert!(s.established, "a valid CONNECT must establish the session");
        assert_eq!(s.connect_stream, Some(stream_id), "CONNECT stream latched");
        assert!(matches!(
            server.events.back(),
            Some(WtEvent::SessionEstablished { conn: 1 })
        ));
    }

    /// A client non-200 CONNECT response emits exactly one Closed, marks the
    /// session closed, and a later 200 on the same connection must NOT
    /// resurrect it (no SessionEstablished).
    #[test]
    fn client_non_200_closes_once_and_blocks_resurrection() {
        let caddr: SocketAddr = CADDR.parse().unwrap();
        let saddr: SocketAddr = SADDR.parse().unwrap();
        let mut client = WtEndpoint::new(false, caddr, saddr).unwrap();
        let h = ConnectionHandle(0);
        client.handle_to_id.insert(h, 3);
        client.id_to_handle.insert(3, h);
        // A 404 rejection followed (later) by a stray 200.
        let sess = Session {
            connect_self_opened: true,
            connect_rx: h3::encode_status_response("404"),
            ..Session::default()
        };
        client.sessions.insert(h, sess);

        client.parse_client_connect(h);
        let closes = client
            .events
            .iter()
            .filter(|e| matches!(e, WtEvent::Closed { conn: 3, .. }))
            .count();
        assert_eq!(closes, 1, "non-200 emits exactly one Closed");
        assert!(client.sessions.get(&h).unwrap().connect_closed);
        assert!(!client.sessions.get(&h).unwrap().established);

        // A stray 200 arriving afterwards must be ignored (no resurrection).
        client
            .sessions
            .get_mut(&h)
            .unwrap()
            .connect_rx
            .extend_from_slice(&h3::encode_status_response("200"));
        client.parse_client_connect(h);
        assert!(!client.sessions.get(&h).unwrap().established);
        assert!(
            !client
                .events
                .iter()
                .any(|e| matches!(e, WtEvent::SessionEstablished { .. })),
            "a late 200 must not establish a discarded session"
        );
    }

    /// A client whose CONNECT is never answered (e.g. interim-only or silent
    /// server, where keep-alives defeat the idle timeout) fails at the connect
    /// deadline instead of hanging forever.
    #[test]
    fn client_connect_deadline_fails_unanswered_handshake() {
        let caddr: SocketAddr = CADDR.parse().unwrap();
        let saddr: SocketAddr = SADDR.parse().unwrap();
        let mut client = WtEndpoint::new(false, caddr, saddr).unwrap();
        let h = ConnectionHandle(0);
        client.handle_to_id.insert(h, 4);
        client.id_to_handle.insert(4, h);
        let t0 = Instant::now();
        let sess = Session {
            connect_self_opened: true,
            connect_deadline: Some(t0),
            ..Session::default()
        };
        client.sessions.insert(h, sess);

        // A tick past the deadline must fail the session.
        client.handle_timeout(t0 + std::time::Duration::from_millis(1));
        assert!(client.sessions.get(&h).unwrap().connect_closed);
        assert!(client
            .events
            .iter()
            .any(|e| matches!(e, WtEvent::Closed { conn: 4, .. })));
    }

    /// A malformed :status (non-numeric, e.g. "1") is a bad response, not an
    /// interim one: the session is closed rather than waited on.
    #[test]
    fn client_malformed_status_closes() {
        let caddr: SocketAddr = CADDR.parse().unwrap();
        let saddr: SocketAddr = SADDR.parse().unwrap();
        let mut client = WtEndpoint::new(false, caddr, saddr).unwrap();
        let h = ConnectionHandle(0);
        client.handle_to_id.insert(h, 6);
        client.id_to_handle.insert(6, h);
        let sess = Session {
            connect_self_opened: true,
            connect_rx: h3::encode_status_response("1"), // not a valid 1xx
            ..Session::default()
        };
        client.sessions.insert(h, sess);

        client.parse_client_connect(h);
        assert!(client.sessions.get(&h).unwrap().connect_closed);
        assert!(!client.sessions.get(&h).unwrap().established);
    }

    /// An interim 1xx CONNECT response is not fatal: a following 200 still
    /// establishes.
    #[test]
    fn client_interim_1xx_then_200_establishes() {
        let caddr: SocketAddr = CADDR.parse().unwrap();
        let saddr: SocketAddr = SADDR.parse().unwrap();
        let mut client = WtEndpoint::new(false, caddr, saddr).unwrap();
        let h = ConnectionHandle(0);
        client.handle_to_id.insert(h, 5);
        client.id_to_handle.insert(5, h);
        let mut sess = Session {
            connect_self_opened: true,
            connect_rx: h3::encode_status_response("103"),
            ..Session::default()
        };
        sess.connect_rx
            .extend_from_slice(&h3::encode_status_response("200"));
        client.sessions.insert(h, sess);

        client.parse_client_connect(h);
        assert!(
            client.sessions.get(&h).unwrap().established,
            "1xx is interim; the following 200 must establish"
        );
        assert!(!client.sessions.get(&h).unwrap().connect_closed);
    }

    /// A peer-accepted uni stream whose first varint is 0x01 (H3 PUSH) must not
    /// accumulate its bytes without bound.
    #[test]
    fn uni_push_stream_bytes_do_not_accumulate() {
        use quinn_proto::{Dir, Side};
        let caddr: SocketAddr = CADDR.parse().unwrap();
        let saddr: SocketAddr = SADDR.parse().unwrap();
        let mut client = WtEndpoint::new(false, caddr, saddr).unwrap();
        let h = ConnectionHandle(0);
        client.handle_to_id.insert(h, 9);
        client.id_to_handle.insert(9, h);
        let sid = StreamId::new(Side::Server, Dir::Uni, 0);
        let mut sess = Session::default();
        sess.in_streams.insert(
            sid,
            InStream {
                kind: None,
                is_bidi: false,
                sid_read: false,
                handle: None,
                buf: Vec::new(),
            },
        );
        client.sessions.insert(h, sess);

        // Stream type 0x01 (PUSH) then a lot of payload, across several reads.
        client.process_in_stream(h, sid, &[0x01], false, Instant::now());
        for _ in 0..100 {
            client.process_in_stream(h, sid, &[0xAB; 64], false, Instant::now());
        }
        let buf_len = client
            .sessions
            .get(&h)
            .unwrap()
            .in_streams
            .get(&sid)
            .unwrap()
            .buf
            .len();
        assert_eq!(buf_len, 0, "PUSH/unknown uni bytes must be discarded");
    }

    /// A graceful WT session end (CONNECT-stream FIN) emits exactly one Closed
    /// event, even though the QUIC connection was still alive.
    #[test]
    fn connect_stream_end_emits_closed_once() {
        use quinn_proto::{Dir, Side};
        let caddr: SocketAddr = CADDR.parse().unwrap();
        let saddr: SocketAddr = SADDR.parse().unwrap();
        let mut server = WtEndpoint::new(true, saddr, caddr).unwrap();
        let h = ConnectionHandle(0);
        server.handle_to_id.insert(h, 7);
        server.id_to_handle.insert(7, h);
        let sid = StreamId::new(Side::Client, Dir::Bi, 0);
        let sess = Session {
            established: true,
            connect_stream: Some(sid),
            ..Session::default()
        };
        server.sessions.insert(h, sess);

        // No live quinn conn, so the conn.close() is a no-op; the event path is
        // what we assert.
        server.close_session_on_connect_end(h);
        server.close_session_on_connect_end(h); // idempotent

        let closes = server
            .events
            .iter()
            .filter(|e| matches!(e, WtEvent::Closed { conn: 7, .. }))
            .count();
        assert_eq!(closes, 1, "exactly one Closed for a graceful session end");
        assert!(server.sessions.get(&h).unwrap().connect_closed);
    }

    /// A pinned client connects when the server's cert matches the hash, and
    /// fails the handshake (Closed, never Connected) against a wrong hash.
    #[test]
    fn pinned_cert_client_accepts_matching_and_rejects_wrong_hash() {
        use base64::Engine as _;
        let caddr: SocketAddr = CADDR.parse().unwrap();
        let saddr: SocketAddr = SADDR.parse().unwrap();
        let now_unix = time::OffsetDateTime::now_utc().unix_timestamp() - 60;

        // Matching hash: session must establish.
        let (mut server, hash) =
            WtEndpoint::new_with_generated_cert(caddr, "localhost", 14, now_unix).unwrap();
        let pinned = crate::verify::PinnedCertVerifier::parse_hashes(&hash).unwrap();
        let mut client = WtEndpoint::new_client_pinned(saddr, pinned).unwrap();
        client.connect("localhost");
        let mut established = false;
        for _ in 0..2000 {
            let a = relay_step_addr(&mut client, &mut server, caddr);
            let b = relay_step_addr(&mut server, &mut client, saddr);
            while server.poll_event().is_some() {}
            while let Some(ev) = client.poll_event() {
                if let WtEvent::SessionEstablished { .. } = ev {
                    established = true;
                }
            }
            if established {
                break;
            }
            if !a && !b {
                let now = Instant::now();
                server.handle_timeout(now);
                client.handle_timeout(now);
            }
        }
        assert!(established, "pinned client with matching hash must connect");

        // Wrong hash: handshake must fail with a Closed event, never Connected.
        let (mut server2, _hash2) =
            WtEndpoint::new_with_generated_cert(caddr, "localhost", 14, now_unix).unwrap();
        let wrong = base64::engine::general_purpose::STANDARD.encode([0u8; 32]);
        let pinned = crate::verify::PinnedCertVerifier::parse_hashes(&wrong).unwrap();
        let mut client2 = WtEndpoint::new_client_pinned(saddr, pinned).unwrap();
        client2.connect("localhost");
        let mut connected = false;
        let mut closed = false;
        for _ in 0..2000 {
            let a = relay_step_addr(&mut client2, &mut server2, caddr);
            let b = relay_step_addr(&mut server2, &mut client2, saddr);
            while server2.poll_event().is_some() {}
            while let Some(ev) = client2.poll_event() {
                match ev {
                    WtEvent::Connected { .. } => connected = true,
                    WtEvent::Closed { .. } => closed = true,
                    _ => {}
                }
            }
            if closed {
                break;
            }
            if !a && !b {
                let now = Instant::now();
                server2.handle_timeout(now);
                client2.handle_timeout(now);
            }
        }
        assert!(!connected, "wrong pin must never complete the handshake");
        assert!(closed, "wrong pin must surface a Closed event");
    }

    /// close_conn tears down exactly one connection: the closed peer sees the
    /// application code, the other client keeps working, and the closer's own
    /// state for that connection is pruned.
    #[test]
    fn close_conn_is_per_connection_and_carries_code() {
        let saddr: SocketAddr = "127.0.0.1:443".parse().unwrap();
        let a_addr: SocketAddr = "127.0.0.1:1001".parse().unwrap();
        let b_addr: SocketAddr = "127.0.0.1:1002".parse().unwrap();

        let mut server = WtEndpoint::new(true, saddr, a_addr).unwrap();
        let mut client_a = WtEndpoint::new(false, a_addr, saddr).unwrap();
        let mut client_b = WtEndpoint::new(false, b_addr, saddr).unwrap();
        client_a.connect("localhost");
        let cid_b = client_b.connect("localhost") as u32;

        fn drain2(from: &mut WtEndpoint) -> Vec<(SocketAddr, Vec<u8>)> {
            let mut pkts = Vec::new();
            from.poll_transmits(Instant::now(), &mut pkts);
            pkts.into_iter().map(|(p, dest)| (dest, p)).collect()
        }

        let mut a_est = false;
        let mut b_est = false;
        let mut server_conn_a: Option<u32> = None;
        let mut a_closed_code: Option<u32> = None;
        let mut b_echo = false;
        let mut closed_sent = false;
        let mut b_probed = false;

        for _ in 0..3000 {
            let mut wire: Vec<(SocketAddr, SocketAddr, Vec<u8>)> = Vec::new();
            for (dest, p) in drain2(&mut client_a) {
                wire.push((a_addr, dest, p));
            }
            for (dest, p) in drain2(&mut client_b) {
                wire.push((b_addr, dest, p));
            }
            for (dest, p) in drain2(&mut server) {
                wire.push((saddr, dest, p));
            }
            let moved = !wire.is_empty();
            for (src, dest, p) in wire {
                let now = Instant::now();
                if dest == saddr {
                    server.recv(now, src, &p);
                } else if dest == a_addr {
                    client_a.recv(now, src, &p);
                } else if dest == b_addr {
                    client_b.recv(now, src, &p);
                }
            }

            while let Some(ev) = server.poll_event() {
                match ev {
                    // First establishment is client A (it connected first).
                    WtEvent::SessionEstablished { conn } if server_conn_a.is_none() => {
                        server_conn_a = Some(conn);
                    }
                    WtEvent::SessionEstablished { .. } => {}
                    WtEvent::Datagram { conn, data } => {
                        server.send_datagram(conn, &data);
                    }
                    _ => {}
                }
            }
            while let Some(ev) = client_a.poll_event() {
                match ev {
                    WtEvent::SessionEstablished { .. } => a_est = true,
                    WtEvent::Closed { code, .. } => a_closed_code = Some(code),
                    _ => {}
                }
            }
            while let Some(ev) = client_b.poll_event() {
                match ev {
                    WtEvent::SessionEstablished { .. } => b_est = true,
                    WtEvent::Datagram { .. } => b_echo = true,
                    _ => {}
                }
            }

            if a_est && b_est && !closed_sent {
                let conn_a = server_conn_a.expect("server saw A's session");
                server.close_conn(conn_a, 42, b"kick", Instant::now());
                closed_sent = true;
            }
            if a_closed_code.is_some() && !b_probed {
                // After A is gone, B must still round-trip on the same endpoint.
                client_b.send_datagram(cid_b, b"still-alive");
                b_probed = true;
            }
            if b_echo {
                break;
            }
            if !moved {
                let now = Instant::now();
                server.handle_timeout(now);
                client_a.handle_timeout(now);
                client_b.handle_timeout(now);
            }
        }

        assert_eq!(
            a_closed_code,
            Some(42),
            "closed client must observe the application close code"
        );
        assert!(
            b_echo,
            "the other client must keep working after close_conn"
        );
        assert_eq!(
            server.conns.len(),
            1,
            "server must prune exactly the closed connection"
        );
        let conn_a = server_conn_a.expect("server saw A's session");
        assert!(
            matches!(
                server.rate_limiter.check_connection(
                    Instant::now(),
                    conn_a,
                    RateLimitDimension::DatagramIngress
                ),
                Err(ref err)
                    if err
                        == "E_INTERNAL: missing peer ownership for datagramsIngress rate limiting"
            ),
            "closed connection must fail closed after limiter ownership cleanup"
        );
        assert_eq!(
            server.governor.snapshot(0, None).sessions_active,
            1,
            "close_conn must release the closed session reservation"
        );
    }

    #[test]
    fn capacity_wait_queue_deduplicates_and_round_robins_50k_waiters() {
        let mut queue = CapacityWaitQueue::default();
        for conn in 1..=50_000 {
            queue.enqueue(conn);
            queue.enqueue(conn);
        }

        assert_eq!(queue.len(), 50_000, "duplicates must collapse");
        assert_eq!(queue.pop_front(), Some(1));
        queue.enqueue(1);
        assert_eq!(queue.pop_front(), Some(2));
        assert_eq!(queue.pop_front(), Some(3));
        assert_eq!(queue.len(), 49_998);
    }
}
