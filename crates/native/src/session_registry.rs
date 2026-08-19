//! Session registry mapping session IDs to live session state.
//!
//! Used by SessionHandle to send/recv datagrams and streams via the wtransport Connection.
//! Sessions are removed when the connection closes.

use dashmap::DashMap;
use once_cell::sync::Lazy;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use tokio::sync::{mpsc, oneshot, Mutex, Notify};
use tokio::time::Instant;
use wtransport::Connection;

use crate::client_stream::{ClientBidiStreamHandle, ClientUniRecvHandle, ClientUniSendHandle};
use crate::server_metrics::ServerMetrics;

/// Per-session metrics for `metricsSnapshot()` and per-session stream caps.
#[derive(Default)]
pub struct SessionMetrics {
    pub datagrams_in: AtomicU64,
    pub datagrams_out: AtomicU64,
    pub streams_bidi_active: AtomicU64,
    pub streams_uni_active: AtomicU64,
    pub queued_bytes: AtomicU64,
}

impl SessionMetrics {
    pub fn streams_active(&self) -> u64 {
        self.streams_bidi_active.load(Ordering::Relaxed)
            + self.streams_uni_active.load(Ordering::Relaxed)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DatagramCapacityError {
    Closed,
    Timeout,
}

/// Reserve datagram queue credit without losing capacity or lifecycle wakes.
pub async fn reserve_datagram_capacity(
    metrics: &Arc<ServerMetrics>,
    session_metrics: &Arc<SessionMetrics>,
    session_notify: &Arc<Notify>,
    lifecycle_closed: &Arc<AtomicBool>,
    limits: &crate::limits::Limits,
    reserved: u64,
    deadline: Instant,
) -> std::result::Result<(), DatagramCapacityError> {
    loop {
        let session_notified = session_notify.notified();
        tokio::pin!(session_notified);
        session_notified.as_mut().enable();
        let owner_notified = metrics.datagram_capacity_notify.notified();
        tokio::pin!(owner_notified);
        owner_notified.as_mut().enable();

        if lifecycle_closed.load(Ordering::Acquire) {
            return Err(DatagramCapacityError::Closed);
        }

        if metrics
            .try_reserve_queued_bytes_with_session(
                &session_metrics.queued_bytes,
                reserved,
                limits.max_queued_bytes_global,
                limits.max_queued_bytes_per_session,
            )
            .is_ok()
        {
            if lifecycle_closed.load(Ordering::Acquire) {
                metrics.release_datagram_capacity(
                    &session_metrics.queued_bytes,
                    session_notify,
                    reserved,
                );
                return Err(DatagramCapacityError::Closed);
            }
            return Ok(());
        }

        metrics
            .backpressure_wait_count
            .fetch_add(1, Ordering::Relaxed);

        let now = Instant::now();
        if now >= deadline {
            metrics
                .backpressure_timeout_count
                .fetch_add(1, Ordering::Relaxed);
            return Err(DatagramCapacityError::Timeout);
        }

        let remain = deadline.saturating_duration_since(now);
        if tokio::time::timeout(remain, async {
            tokio::select! {
                _ = &mut session_notified => {},
                _ = &mut owner_notified => {},
            }
        })
        .await
        .is_err()
        {
            if lifecycle_closed.load(Ordering::Acquire) {
                return Err(DatagramCapacityError::Closed);
            }
            metrics
                .backpressure_timeout_count
                .fetch_add(1, Ordering::Relaxed);
            return Err(DatagramCapacityError::Timeout);
        }
    }
}

/// Owns a datagram byte-budget reservation from the instant it is acquired.
///
/// Keeping this guard separate from the queued payload closes the teardown
/// window between reservation and channel-slot construction: every early exit
/// releases credit and wakes the correct session/server waiters.
#[must_use = "dropping the guard releases the datagram byte-budget reservation"]
pub struct DatagramReservation {
    session_metrics: Arc<SessionMetrics>,
    server_metrics: Arc<ServerMetrics>,
    datagram_capacity_notify: Arc<Notify>,
    reserved: u64,
}

impl DatagramReservation {
    pub fn new(
        session_metrics: Arc<SessionMetrics>,
        server_metrics: Arc<ServerMetrics>,
        datagram_capacity_notify: Arc<Notify>,
        reserved: u64,
    ) -> Self {
        Self {
            session_metrics,
            server_metrics,
            datagram_capacity_notify,
            reserved,
        }
    }

    pub fn into_slot(self, data: Vec<u8>) -> DatagramSlot {
        DatagramSlot {
            data: DatagramPayload::Owned(data),
            _reservation: self,
        }
    }

    /// Keep the transport-owned datagram buffer until a consumer actually
    /// reads it. The old ingress path copied every payload into a second
    /// `Vec<u8>` before enqueueing, which amplified allocator churn under a
    /// high-rate drain-all workload.
    ///
    /// Small payloads are copied out instead: a `wtransport::datagram::Datagram`
    /// holds the whole received QUIC datagram as `Bytes` and exposes the payload
    /// as a subslice of it, so queueing a 1-byte payload can pin a full-MTU
    /// allocation that the byte reservation never accounts for.
    pub fn into_transport_slot(self, data: wtransport::datagram::Datagram) -> DatagramSlot {
        if retains_transport_buffer(data.len()) {
            DatagramSlot {
                data: DatagramPayload::Transport(data),
                _reservation: self,
            }
        } else {
            DatagramSlot {
                data: DatagramPayload::Owned(data.to_vec()),
                _reservation: self,
            }
        }
    }
}

/// Assumed size of the QUIC datagram buffer a transport-owned payload pins.
///
/// `wtransport::datagram::Datagram` keeps the full received datagram and does
/// not expose its length (`payload()` only yields the subslice, and `Bytes`
/// hides the underlying allocation), so the retained size is not observable.
/// A standard 1500-byte Ethernet MTU is the practical worst case for a single
/// received QUIC datagram.
const TRANSPORT_DATAGRAM_BACKING_ESTIMATE: usize = 1500;

/// Payload length at or above which the zero-copy path is kept.
///
/// At half the assumed backing size the unaccounted transport overhead is at
/// most 2x the reserved byte budget, which keeps `maxQueuedBytes*` meaningful
/// while leaving the high-throughput echo path (near-MTU datagrams) zero-copy.
pub(crate) const TRANSPORT_ZERO_COPY_MIN_PAYLOAD: usize = TRANSPORT_DATAGRAM_BACKING_ESTIMATE / 2;

/// Whether a queued payload of this size may keep the transport buffer alive.
fn retains_transport_buffer(payload_len: usize) -> bool {
    payload_len >= TRANSPORT_ZERO_COPY_MIN_PAYLOAD
}

impl Drop for DatagramReservation {
    fn drop(&mut self) {
        if self.reserved > 0 {
            self.server_metrics.release_datagram_capacity(
                &self.session_metrics.queued_bytes,
                &self.datagram_capacity_notify,
                self.reserved,
            );
        }
    }
}

/// A queued datagram whose reservation is released on dequeue or teardown.
pub struct DatagramSlot {
    data: DatagramPayload,
    _reservation: DatagramReservation,
}

enum DatagramPayload {
    Owned(Vec<u8>),
    Transport(wtransport::datagram::Datagram),
}

impl DatagramSlot {
    pub fn new(
        data: Vec<u8>,
        session_metrics: Arc<SessionMetrics>,
        server_metrics: Arc<ServerMetrics>,
        datagram_capacity_notify: Arc<Notify>,
        reserved: u64,
    ) -> Self {
        DatagramReservation::new(
            session_metrics,
            server_metrics,
            datagram_capacity_notify,
            reserved,
        )
        .into_slot(data)
    }

    /// Move the payload out. The reservation is still released when the slot is
    /// dropped at the end of the caller's scope. A transport-retained payload
    /// leaves as the refcounted slice it arrived as; the napi arraybuffer copy
    /// downstream is the only copy it ever pays.
    pub fn take(mut self) -> bytes::Bytes {
        match std::mem::replace(&mut self.data, DatagramPayload::Owned(Vec::new())) {
            DatagramPayload::Owned(data) => bytes::Bytes::from(data),
            DatagramPayload::Transport(data) => data.payload(),
        }
    }

    /// Consume the slot without materializing a payload for a black-hole
    /// consumer. Dropping the slot still releases the reserved byte budget.
    pub fn discard(self) {}
}

/// Channel capacity for datagrams per session (bounded to prevent unbounded buffering).
pub(crate) const DGRAM_CHANNEL_CAPACITY: usize = 2048;
const STREAM_ACCEPT_CAPACITY: usize = 256;

/// Shared result state for one native black-hole stream drain direction.
///
/// Keep the completion counter, first error, and waiter notification in one
/// allocation. The accept loop and the N-API waiter both clone the enclosing
/// state for every session; splitting these fields into separate `Arc`s made
/// short-lived load streams needlessly fragment the process allocator.
struct StreamDiscardShared {
    completed: AtomicU64,
    error: StdMutex<Option<String>>,
    notify: Notify,
}

/// Native black-hole stream state used by bounded load/evidence drains.
///
/// Enabling this state lets the QUIC accept loop consume future streams
/// directly instead of allocating a N-API handle and an accept-queue entry for
/// every stream. The state is session-owned and disappears with the registry
/// entry; it is not part of the public WebTransport API.
#[derive(Clone)]
pub struct StreamDiscardState {
    enabled: Arc<AtomicBool>,
    shared: Arc<StreamDiscardShared>,
    closed: Arc<AtomicBool>,
}

impl StreamDiscardState {
    fn new(closed: Arc<AtomicBool>) -> Self {
        Self {
            enabled: Arc::new(AtomicBool::new(false)),
            shared: Arc::new(StreamDiscardShared {
                completed: AtomicU64::new(0),
                error: StdMutex::new(None),
                notify: Notify::new(),
            }),
            closed,
        }
    }

    pub fn enable(&self) {
        self.enabled.store(true, Ordering::Release);
        self.shared.notify.notify_waiters();
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled.load(Ordering::Acquire)
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Acquire)
    }

    pub fn completed(&self) -> u64 {
        self.shared.completed.load(Ordering::Acquire)
    }

    pub fn error(&self) -> Option<String> {
        self.shared.error.lock().ok().and_then(|slot| slot.clone())
    }

    pub fn record(&self, result: std::result::Result<(), String>) {
        self.record_inner(result, true);
    }

    /// Record a stream consumed by the native accept loop without waking a
    /// parked N-API drain task for every stream. Direct discard callers read
    /// the cumulative counter at their bounded deadline; wrapper drains still
    /// use `record` so their queued-handle waiter remains responsive.
    pub fn record_direct(&self, result: std::result::Result<(), String>) {
        self.record_inner(result, false);
    }

    fn record_inner(&self, result: std::result::Result<(), String>, notify: bool) {
        match result {
            Ok(()) => {
                self.shared.completed.fetch_add(1, Ordering::AcqRel);
            }
            Err(error) => {
                if let Ok(mut slot) = self.shared.error.lock() {
                    if slot.is_none() {
                        *slot = Some(error);
                    }
                }
            }
        }
        if notify {
            self.shared.notify.notify_waiters();
        }
    }

    pub(crate) fn wake(&self) {
        self.shared.notify.notify_waiters();
    }

    /// Standalone state for tests that exercise drain behaviour without a
    /// registered session.
    #[cfg(test)]
    pub(crate) fn for_test() -> Self {
        Self::new(Arc::new(AtomicBool::new(false)))
    }
}

/// Request to create a bidi stream. Response via oneshot.
pub type CreateBiReq = oneshot::Sender<std::result::Result<ClientBidiStreamHandle, String>>;
/// Request to create a uni stream. Response via oneshot.
pub type CreateUniReq = oneshot::Sender<std::result::Result<ClientUniSendHandle, String>>;

/// Live state for an open session.
pub struct SessionState {
    /// Owning server instance id for isolated shutdown/rotation.
    pub owner_server_id: u64,
    /// Connection handle for sending datagrams and opening streams.
    pub conn: Connection,
    /// Receiver for datagrams forwarded from the connection.
    pub dgram_rx: Arc<Mutex<mpsc::Receiver<DatagramSlot>>>,
    /// Server metrics (for datagrams_out when send_datagram succeeds).
    pub metrics: Arc<ServerMetrics>,
    /// Per-session metrics for stream caps and metricsSnapshot.
    pub session_metrics: Arc<SessionMetrics>,
    /// Receiver for accepted bidi streams (forwarded from accept loop).
    pub bidi_accept_rx: Arc<Mutex<mpsc::Receiver<Box<ClientBidiStreamHandle>>>>,
    /// Receiver for accepted uni streams.
    pub uni_accept_rx: Arc<Mutex<mpsc::Receiver<Box<ClientUniRecvHandle>>>>,
    /// Sender for create-bidi requests.
    pub create_bi_tx: mpsc::Sender<CreateBiReq>,
    /// Sender for create-uni requests.
    pub create_uni_tx: mpsc::Sender<CreateUniReq>,
    /// Notifies waiters when stream capacity may have changed.
    pub stream_capacity_notify: Arc<Notify>,
    /// Notifies waiters when datagram queued-byte capacity or lifecycle may have changed.
    pub datagram_capacity_notify: Arc<Notify>,
    /// Wakes datagram readers when the session closes, and nothing else.
    ///
    /// Deliberately not `datagram_capacity_notify`: that one fires on every
    /// send-capacity release, so a parked reader sharing it would wake and
    /// re-arm proportionally to the send rate on the datagram hot path.
    pub datagram_lifecycle_notify: Arc<Notify>,
    /// Sticky lifecycle state closes the lost-wake window around registry removal.
    pub datagram_lifecycle_closed: Arc<AtomicBool>,
    /// Native-only direct-consume state for accepted bidi streams.
    pub bidi_discard: StreamDiscardState,
    /// Native-only direct-consume state for accepted uni streams.
    pub uni_discard: StreamDiscardState,
    /// Effective limits for this session (captured from owning server).
    pub limits: crate::limits::Limits,
    /// Whether the session request arrived as 0-RTT early data (replayable).
    pub is_0rtt: bool,
    /// Whether the TLS handshake has completed. Initialized true for non-0-RTT
    /// sessions (accept resolves post-handshake); for 0-RTT sessions the
    /// accept-loop watcher flips it at handshake completion.
    pub handshake_confirmed: Arc<AtomicBool>,
}

static REGISTRY: Lazy<DashMap<String, SessionState>> = Lazy::new(DashMap::new);

/// Number of registry entries still owned by one server instance.
/// This is diagnostic-only and intentionally scoped to the owner so a
/// concurrent server cannot hide a retained session from close evidence.
/// Which server owns a session, if it is still registered. Read once when a
/// `SessionHandle` is built so per-call async-op accounting needs no lookup.
pub fn owner_of(session_id: &str) -> Option<u64> {
    REGISTRY.get(session_id).map(|entry| entry.owner_server_id)
}

pub fn owner_entry_count(owner_server_id: u64) -> usize {
    REGISTRY
        .iter()
        .filter(|entry| entry.value().owner_server_id == owner_server_id)
        .count()
}

/// Insert a new session into the registry.
/// Returns the bounded channel endpoints plus session metrics and the datagram
/// capacity notifier captured by the ingress task before any teardown race.
/// Caller must spawn: dgram forward, bidi accept forward, uni accept forward, create_bi handler, create_uni handler.
#[allow(clippy::type_complexity)]
pub fn insert(
    session_id: String,
    owner_server_id: u64,
    conn: Connection,
    metrics: Arc<ServerMetrics>,
    limits: crate::limits::Limits,
    is_0rtt: bool,
) -> (
    mpsc::Sender<DatagramSlot>,
    mpsc::Sender<Box<ClientBidiStreamHandle>>,
    mpsc::Sender<Box<ClientUniRecvHandle>>,
    mpsc::Receiver<CreateBiReq>,
    mpsc::Receiver<CreateUniReq>,
    Arc<SessionMetrics>,
    Arc<Notify>,
) {
    let (dgram_tx, dgram_rx) = mpsc::channel(DGRAM_CHANNEL_CAPACITY);
    let (bidi_accept_tx, bidi_accept_rx) = mpsc::channel(STREAM_ACCEPT_CAPACITY);
    let (uni_accept_tx, uni_accept_rx) = mpsc::channel(STREAM_ACCEPT_CAPACITY);
    let (create_bi_tx, create_bi_rx) = mpsc::channel(64);
    let (create_uni_tx, create_uni_rx) = mpsc::channel(64);
    let session_metrics = Arc::new(SessionMetrics::default());
    let stream_capacity_notify = Arc::new(Notify::new());
    let datagram_capacity_notify = Arc::new(Notify::new());
    let datagram_lifecycle_notify = Arc::new(Notify::new());
    let datagram_lifecycle_closed = Arc::new(AtomicBool::new(false));
    let bidi_discard = StreamDiscardState::new(Arc::clone(&datagram_lifecycle_closed));
    let uni_discard = StreamDiscardState::new(Arc::clone(&datagram_lifecycle_closed));
    let state = SessionState {
        owner_server_id,
        conn,
        dgram_rx: Arc::new(Mutex::new(dgram_rx)),
        metrics,
        session_metrics: Arc::clone(&session_metrics),
        bidi_accept_rx: Arc::new(Mutex::new(bidi_accept_rx)),
        uni_accept_rx: Arc::new(Mutex::new(uni_accept_rx)),
        create_bi_tx,
        create_uni_tx,
        stream_capacity_notify,
        datagram_capacity_notify: Arc::clone(&datagram_capacity_notify),
        datagram_lifecycle_notify,
        datagram_lifecycle_closed,
        bidi_discard,
        uni_discard,
        limits,
        is_0rtt,
        handshake_confirmed: Arc::new(AtomicBool::new(!is_0rtt)),
    };
    REGISTRY.insert(session_id, state);
    (
        dgram_tx,
        bidi_accept_tx,
        uni_accept_tx,
        create_bi_rx,
        create_uni_rx,
        session_metrics,
        datagram_capacity_notify,
    )
}

/// 0-RTT status of a session: (is_0rtt, handshake_confirmed flag).
pub fn zero_rtt_state(session_id: &str) -> Option<(bool, Arc<AtomicBool>)> {
    REGISTRY
        .get(session_id)
        .map(|entry| (entry.is_0rtt, Arc::clone(&entry.handshake_confirmed)))
}

pub fn get_stream_capacity_notify(session_id: &str) -> Option<Arc<Notify>> {
    REGISTRY
        .get(session_id)
        .map(|entry| Arc::clone(&entry.stream_capacity_notify))
}

pub fn enable_bidi_discard(session_id: &str) -> Option<StreamDiscardState> {
    REGISTRY.get(session_id).map(|entry| {
        entry.bidi_discard.enable();
        entry.bidi_discard.clone()
    })
}

pub fn bidi_discard_state(session_id: &str) -> Option<StreamDiscardState> {
    REGISTRY
        .get(session_id)
        .map(|entry| entry.bidi_discard.clone())
}

pub fn enable_uni_discard(session_id: &str) -> Option<StreamDiscardState> {
    REGISTRY.get(session_id).map(|entry| {
        entry.uni_discard.enable();
        entry.uni_discard.clone()
    })
}

pub fn uni_discard_state(session_id: &str) -> Option<StreamDiscardState> {
    REGISTRY
        .get(session_id)
        .map(|entry| entry.uni_discard.clone())
}

/// Everything one datagram send needs from the registry. Resolved once per
/// N-API call — a batch shares the lookup across its elements, and looking it
/// up per element would put a registry hit back on the hot path batching exists
/// to relieve.
pub type DatagramSendState = (
    Connection,
    Arc<ServerMetrics>,
    Arc<SessionMetrics>,
    crate::limits::Limits,
    Arc<Notify>,
    Arc<AtomicBool>,
);

pub fn get_datagram_send_state(session_id: &str) -> Option<DatagramSendState> {
    REGISTRY.get(session_id).map(send_state_of)
}

/// Same lookup, but only for a session this server owns.
///
/// The mirror send resolves a caller-supplied list of ids, so an id belonging
/// to another server in the same process — the `__TESTING__` suites and the
/// client pool both create more than one — must not become a send. A foreign
/// id is `None`, which the caller reports as `E_SESSION_CLOSED`: from this
/// server's point of view a session it does not own and a session that is gone
/// are the same thing.
pub fn get_datagram_send_state_for_owner(
    session_id: &str,
    owner_server_id: u64,
) -> Option<DatagramSendState> {
    REGISTRY
        .get(session_id)
        .filter(|entry| entry.owner_server_id == owner_server_id)
        .map(send_state_of)
}

fn send_state_of(entry: dashmap::mapref::one::Ref<'_, String, SessionState>) -> DatagramSendState {
    (
        entry.conn.clone(),
        Arc::clone(&entry.metrics),
        Arc::clone(&entry.session_metrics),
        entry.limits.clone(),
        Arc::clone(&entry.datagram_capacity_notify),
        Arc::clone(&entry.datagram_lifecycle_closed),
    )
}

pub fn get_limits(session_id: &str) -> Option<crate::limits::Limits> {
    REGISTRY.get(session_id).map(|entry| entry.limits.clone())
}

/// Look up session state by id. Returns None if not found or session closed.
#[allow(clippy::type_complexity)]
pub fn get(
    session_id: &str,
) -> Option<(
    Connection,
    Arc<Mutex<mpsc::Receiver<DatagramSlot>>>,
    Arc<ServerMetrics>,
    Arc<Mutex<mpsc::Receiver<Box<ClientBidiStreamHandle>>>>,
    Arc<Mutex<mpsc::Receiver<Box<ClientUniRecvHandle>>>>,
    mpsc::Sender<CreateBiReq>,
    mpsc::Sender<CreateUniReq>,
)> {
    REGISTRY.get(session_id).map(|entry| {
        (
            entry.conn.clone(),
            Arc::clone(&entry.dgram_rx),
            Arc::clone(&entry.metrics),
            Arc::clone(&entry.bidi_accept_rx),
            Arc::clone(&entry.uni_accept_rx),
            entry.create_bi_tx.clone(),
            entry.create_uni_tx.clone(),
        )
    })
}

/// Return the accepted-stream queues plus the close signal used to interrupt
/// a JS accept pull that is parked while the session is being removed.
#[allow(clippy::type_complexity)]
pub fn get_stream_accept_state(
    session_id: &str,
) -> Option<(
    Arc<Mutex<mpsc::Receiver<Box<ClientBidiStreamHandle>>>>,
    Arc<Mutex<mpsc::Receiver<Box<ClientUniRecvHandle>>>>,
    Arc<AtomicBool>,
    Arc<Notify>,
)> {
    REGISTRY.get(session_id).map(|entry| {
        (
            Arc::clone(&entry.bidi_accept_rx),
            Arc::clone(&entry.uni_accept_rx),
            Arc::clone(&entry.datagram_lifecycle_closed),
            Arc::clone(&entry.datagram_capacity_notify),
        )
    })
}

/// Return the datagram queue plus the signals a parked read waits on.
///
/// The sticky flag and the dedicated lifecycle notifier travel together so a
/// reader that captured this state before registry removal still observes the
/// close: the flag is stored with `Release` before the notify fires.
#[allow(clippy::type_complexity)]
pub fn get_datagram_read_state(
    session_id: &str,
) -> Option<(
    Arc<Mutex<mpsc::Receiver<DatagramSlot>>>,
    Arc<AtomicBool>,
    Arc<Notify>,
)> {
    REGISTRY.get(session_id).map(|entry| {
        (
            Arc::clone(&entry.dgram_rx),
            Arc::clone(&entry.datagram_lifecycle_closed),
            Arc::clone(&entry.datagram_lifecycle_notify),
        )
    })
}

/// Remove session from registry. Call when connection closes.
pub fn remove(session_id: &str) {
    mark_closed_and_notify_capacity_waiters(session_id);
    if let Some((_, state)) = REGISTRY.remove(session_id) {
        mark_state_closed_and_notify(&state);
    }
}

/// Get per-session metrics by session id. Returns None if session not found.
pub fn get_session_metrics(session_id: &str) -> Option<Arc<SessionMetrics>> {
    REGISTRY
        .get(session_id)
        .map(|entry| Arc::clone(&entry.session_metrics))
}

/// End a WebTransport session, telling the peer why.
///
/// The code and reason reach the peer as a `CLOSE_WEBTRANSPORT_SESSION` capsule
/// on the CONNECT stream — a QUIC `CONNECTION_CLOSE` carries neither. Delivery
/// is best-effort and off the caller's critical path; the connection is torn
/// down once the capsule is out. Local state is marked closed first, so pending
/// reads/writes fail immediately either way and iterators and bridge tasks
/// unblock without waiting on the wire.
pub fn close_session(session_id: &str, code: u32, reason: &str) {
    mark_closed_and_notify_capacity_waiters(session_id);
    if let Some((_, state)) = REGISTRY.remove(session_id) {
        mark_state_closed_and_notify(&state);
        state.conn.close_session(code, reason);
    }
}

/// Tell the peer the session is going away soon, leaving it usable.
///
/// Sends a `WT_DRAIN_SESSION` capsule. The session stays in the registry: a
/// drain is a warning, not an ending.
pub fn drain_session(session_id: &str) {
    if let Some(entry) = REGISTRY.get(session_id) {
        entry.conn.drain_session();
    }
}

/// Tell the peer not to open any further session on this connection (H3 `GOAWAY`).
///
/// `GOAWAY` is connection-scoped, not session-scoped, so this is a
/// server-initiated graceful-shutdown signal: "I'm going away, don't start new
/// sessions." The session stays in the registry and fully usable — like a drain,
/// this is a warning, not an ending. Native is single-session-per-connection, so
/// the "refuse a second session" enforcement is not exercisable through the
/// public API; the observable effect is the peer's `draining` settling.
pub fn send_goaway(session_id: &str) {
    if let Some(entry) = REGISTRY.get(session_id) {
        entry.conn.send_goaway();
    }
}

/// Tear a session down at the QUIC level without a close capsule.
///
/// For teardowns that are not an application close — a contained panic, an
/// internal invariant failure — where the peer only needs the connection gone.
pub fn abort_session(session_id: &str, code: u32, reason: &[u8]) {
    mark_closed_and_notify_capacity_waiters(session_id);
    if let Some((_, state)) = REGISTRY.remove(session_id) {
        mark_state_closed_and_notify(&state);
        state.conn.close(wtransport::VarInt::from_u32(code), reason);
    }
}

/// Close all sessions. Called during server shutdown for deterministic cleanup.
pub fn close_all(code: u32, reason: &[u8]) {
    let keys: Vec<String> = REGISTRY.iter().map(|e| e.key().clone()).collect();
    for key in keys {
        mark_closed_and_notify_capacity_waiters(&key);
        if let Some((_, state)) = REGISTRY.remove(&key) {
            mark_state_closed_and_notify(&state);
            state.conn.close(wtransport::VarInt::from_u32(code), reason);
        }
    }
}

/// Close all sessions owned by a specific server instance.
pub fn close_all_for_owner(owner_server_id: u64, code: u32, reason: &[u8]) {
    let keys: Vec<String> = REGISTRY
        .iter()
        .filter(|entry| entry.value().owner_server_id == owner_server_id)
        .map(|entry| entry.key().clone())
        .collect();
    for key in keys {
        mark_closed_and_notify_capacity_waiters(&key);
        if let Some((_, state)) = REGISTRY.remove(&key) {
            mark_state_closed_and_notify(&state);
            // Counted here, not at teardown: a locally closed connection
            // reports no application code, so this is the only place that
            // knows the session was reaped rather than lost.
            state.metrics.record_session_reaped();
            state.conn.close(wtransport::VarInt::from_u32(code), reason);
        }
    }
}

fn mark_closed_and_notify_capacity_waiters(session_id: &str) {
    if let Some(entry) = REGISTRY.get(session_id) {
        mark_state_closed_and_notify(&entry);
    }
}

fn mark_state_closed_and_notify(state: &SessionState) {
    state
        .datagram_lifecycle_closed
        .store(true, Ordering::Release);
    state.stream_capacity_notify.notify_waiters();
    state.datagram_capacity_notify.notify_waiters();
    state.datagram_lifecycle_notify.notify_waiters();
    state.metrics.datagram_capacity_notify.notify_waiters();
    state.bidi_discard.wake();
    state.uni_discard.wake();
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::time::{timeout, Duration};

    const GLOBAL_MAX: u64 = 1 << 20;
    const SESSION_MAX: u64 = 1 << 18;

    fn reserve(metrics: &Arc<ServerMetrics>, sm: &Arc<SessionMetrics>, n: u64) {
        assert!(metrics
            .try_reserve_queued_bytes_with_session(&sm.queued_bytes, n, GLOBAL_MAX, SESSION_MAX,)
            .is_ok());
    }

    // Dropping a queued datagram without dequeuing it (session teardown path)
    // must release its global + per-session reservation. This is the P0 leak.
    #[test]
    fn datagram_slot_drop_releases_reservation() {
        let metrics = Arc::new(ServerMetrics::default());
        let sm = Arc::new(SessionMetrics::default());
        let notify = Arc::new(Notify::new());
        reserve(&metrics, &sm, 500);
        assert_eq!(metrics.queued_bytes_global.load(Ordering::Relaxed), 500);

        let slot = DatagramSlot::new(
            vec![0u8; 500],
            Arc::clone(&sm),
            Arc::clone(&metrics),
            notify,
            500,
        );
        drop(slot);

        assert_eq!(metrics.queued_bytes_global.load(Ordering::Relaxed), 0);
        assert_eq!(sm.queued_bytes.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn datagram_reservation_teardown_before_slot_creation_balances_counters() {
        let metrics = Arc::new(ServerMetrics::default());
        let sm = Arc::new(SessionMetrics::default());
        let notify = Arc::new(Notify::new());
        reserve(&metrics, &sm, 500);

        let reservation = DatagramReservation::new(
            Arc::clone(&sm),
            Arc::clone(&metrics),
            Arc::clone(&notify),
            500,
        );
        drop(reservation);

        assert_eq!(metrics.queued_bytes_global.load(Ordering::Relaxed), 0);
        assert_eq!(sm.queued_bytes.load(Ordering::Relaxed), 0);
    }

    // The normal dequeue path: take() hands the payload to JS, and the
    // reservation is still released exactly once when the slot drops.
    #[test]
    fn datagram_slot_take_then_drop_releases_once() {
        let metrics = Arc::new(ServerMetrics::default());
        let sm = Arc::new(SessionMetrics::default());
        let notify = Arc::new(Notify::new());
        reserve(&metrics, &sm, 500);

        let slot = DatagramSlot::new(
            vec![7u8; 500],
            Arc::clone(&sm),
            Arc::clone(&metrics),
            notify,
            500,
        );
        let data = slot.take();
        assert_eq!(data.len(), 500);
        assert_eq!(data[0], 7);
        assert_eq!(metrics.queued_bytes_global.load(Ordering::Relaxed), 0);
    }

    // Many sessions abandoning queued datagrams must not accumulate the global
    // budget (the attacker-accelerable exhaustion the audit flagged).
    #[test]
    fn churn_with_abandonment_keeps_global_bounded() {
        let metrics = Arc::new(ServerMetrics::default());
        for _ in 0..10_000 {
            let sm = Arc::new(SessionMetrics::default());
            let notify = Arc::new(Notify::new());
            reserve(&metrics, &sm, 1000);
            let slot = DatagramSlot::new(vec![0u8; 1000], sm, Arc::clone(&metrics), notify, 1000);
            drop(slot); // session torn down with data still queued
        }
        assert_eq!(metrics.queued_bytes_global.load(Ordering::Relaxed), 0);
    }

    // A transport-owned slot pins the whole received QUIC datagram, so small
    // payloads must be copied out or the retained bytes escape the reservation.
    #[test]
    fn small_payload_does_not_retain_transport_buffer() {
        assert!(!retains_transport_buffer(0));
        assert!(!retains_transport_buffer(1));
        assert!(!retains_transport_buffer(
            TRANSPORT_ZERO_COPY_MIN_PAYLOAD - 1
        ));
    }

    // The high-throughput echo path sends near-MTU datagrams and must stay
    // zero-copy.
    #[test]
    fn large_payload_stays_zero_copy() {
        assert!(retains_transport_buffer(TRANSPORT_ZERO_COPY_MIN_PAYLOAD));
        assert!(retains_transport_buffer(
            TRANSPORT_DATAGRAM_BACKING_ESTIMATE
        ));
        assert!(retains_transport_buffer(64 * 1024));
    }

    // The threshold is what bounds unaccounted transport overhead to 2x the
    // reserved budget; a laxer value silently reopens the accounting hole.
    #[test]
    fn zero_copy_threshold_bounds_backing_overhead_to_two_x() {
        assert!(TRANSPORT_ZERO_COPY_MIN_PAYLOAD * 2 >= TRANSPORT_DATAGRAM_BACKING_ESTIMATE);
    }

    // `into_transport_slot` cannot be exercised directly (`Datagram` has no
    // public constructor), so pin its branch to the tested predicate.
    #[test]
    fn into_transport_slot_uses_the_backing_retention_policy() {
        let source = include_str!("session_registry.rs");
        let fn_source = source
            .split("pub fn into_transport_slot(")
            .nth(1)
            .and_then(|body| body.split("\n}\n").next())
            .expect("into_transport_slot definition must be parseable");
        assert_eq!(
            fn_source
                .matches("retains_transport_buffer(data.len())")
                .count(),
            1,
            "the copy-out branch must stay driven by retains_transport_buffer"
        );
        assert_eq!(
            fn_source
                .matches("DatagramPayload::Owned(data.to_vec())")
                .count(),
            1,
            "small payloads must be copied into an exact-size allocation"
        );
    }

    // Session close drops every still-queued slot; each reservation must be
    // released exactly once, never twice and never leaked.
    #[tokio::test(flavor = "current_thread")]
    async fn queued_slots_release_once_when_channel_closes() {
        let metrics = Arc::new(ServerMetrics::default());
        let sm = Arc::new(SessionMetrics::default());
        let notify = Arc::new(Notify::new());
        let (tx, rx) = mpsc::channel::<DatagramSlot>(8);

        for _ in 0..4 {
            reserve(&metrics, &sm, 250);
            tx.send(DatagramSlot::new(
                vec![1u8; 250],
                Arc::clone(&sm),
                Arc::clone(&metrics),
                Arc::clone(&notify),
                250,
            ))
            .await
            .expect("channel has capacity");
        }
        assert_eq!(metrics.queued_bytes_global.load(Ordering::Relaxed), 1000);

        drop(tx);
        drop(rx);

        assert_eq!(metrics.queued_bytes_global.load(Ordering::Relaxed), 0);
        assert_eq!(sm.queued_bytes.load(Ordering::Relaxed), 0);
    }

    fn limits() -> crate::limits::Limits {
        crate::limits::Limits {
            max_queued_bytes_global: GLOBAL_MAX,
            max_queued_bytes_per_session: SESSION_MAX,
            backpressure_timeout_ms: 500,
            ..crate::limits::Limits::default()
        }
    }

    async fn wait_for_datagram_backpressure_slot(
        metrics: Arc<ServerMetrics>,
        sm: Arc<SessionMetrics>,
        session_notify: Arc<Notify>,
        reserved: u64,
        deadline: Instant,
        lifecycle_closed: Arc<std::sync::atomic::AtomicBool>,
    ) -> std::result::Result<(), &'static str> {
        reserve_datagram_capacity(
            &metrics,
            &sm,
            &session_notify,
            &lifecycle_closed,
            &limits(),
            reserved,
            deadline,
        )
        .await
        .map_err(|err| match err {
            DatagramCapacityError::Closed => "closed",
            DatagramCapacityError::Timeout => "timeout",
        })
    }

    async fn await_backpressure_waiter(
        metrics: Arc<ServerMetrics>,
        target_count: u64,
    ) -> std::result::Result<(), &'static str> {
        timeout(Duration::from_millis(200), async {
            while metrics.backpressure_wait_count.load(Ordering::Relaxed) < target_count {
                tokio::task::yield_now().await;
            }
        })
        .await
        .map_err(|_| "timeout")
    }

    #[test]
    fn datagram_backpressure_tests_do_not_reimplement_reserve_datagram_capacity() {
        let source = include_str!("session_registry.rs");
        let fn_source = source
            .split("pub async fn reserve_datagram_capacity(")
            .nth(1)
            .and_then(|body| {
                body.split("/// Owns a datagram byte-budget reservation")
                    .next()
            })
            .expect(
                "reserve_datagram_capacity definition must include following doc-commented section",
            );
        assert_eq!(
            fn_source
                .matches("let session_notified = session_notify.notified();")
                .count(),
            1,
            "test-local copies of waiter registration must not be reintroduced"
        );
        assert_eq!(
            fn_source
                .matches("let owner_notified = metrics.datagram_capacity_notify.notified();")
                .count(),
            1,
            "production-path tests must call reserve_datagram_capacity directly"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn datagram_backpressure_multiple_waiters_do_not_strand() {
        let metrics = Arc::new(ServerMetrics::default());
        let sm = Arc::new(SessionMetrics::default());
        let notify = Arc::new(Notify::new());
        reserve(&metrics, &sm, 100);
        let initial_slot = DatagramSlot::new(
            vec![0u8; 100],
            Arc::clone(&sm),
            Arc::clone(&metrics),
            Arc::clone(&notify),
            100,
        );

        let waiter = |metrics: Arc<ServerMetrics>, sm: Arc<SessionMetrics>, notify: Arc<Notify>| async move {
            wait_for_datagram_backpressure_slot(
                Arc::clone(&metrics),
                Arc::clone(&sm),
                Arc::clone(&notify),
                100,
                Instant::now() + Duration::from_millis(500),
                Arc::new(std::sync::atomic::AtomicBool::new(false)),
            )
            .await
            .expect("waiter should acquire released capacity");
            metrics.release_datagram_capacity(&sm.queued_bytes, &notify, 100);
        };

        let waiter_one = waiter(Arc::clone(&metrics), Arc::clone(&sm), Arc::clone(&notify));
        let waiter_two = waiter(Arc::clone(&metrics), Arc::clone(&sm), Arc::clone(&notify));

        drop(initial_slot);

        timeout(Duration::from_secs(1), async {
            tokio::join!(waiter_one, waiter_two);
        })
        .await
        .expect("all datagram waiters should be woken by successive releases");

        assert_eq!(metrics.queued_bytes_global.load(Ordering::Relaxed), 0);
        assert_eq!(sm.queued_bytes.load(Ordering::Relaxed), 0);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn datagram_backpressure_pre_notify_race_does_not_lose_wake() {
        let metrics = Arc::new(ServerMetrics::default());
        let sm = Arc::new(SessionMetrics::default());
        let notify = Arc::new(Notify::new());
        reserve(&metrics, &sm, 100);

        let waiter = tokio::spawn(wait_for_datagram_backpressure_slot(
            Arc::clone(&metrics),
            Arc::clone(&sm),
            Arc::clone(&notify),
            100,
            Instant::now() + Duration::from_millis(250),
            Arc::new(std::sync::atomic::AtomicBool::new(false)),
        ));
        let releaser = tokio::spawn({
            let metrics = Arc::clone(&metrics);
            let sm = Arc::clone(&sm);
            let notify = Arc::clone(&notify);
            async move {
                tokio::time::sleep(Duration::from_millis(10)).await;
                metrics.release_datagram_capacity(&sm.queued_bytes, &notify, 100);
            }
        });

        let _ = timeout(Duration::from_millis(100), waiter)
            .await
            .expect("waiter should consume a single release without timeout")
            .expect("waiter should reserve capacity");
        releaser.await.expect("releaser task should run");

        assert_eq!(metrics.queued_bytes_global.load(Ordering::Relaxed), 100);
        assert_eq!(sm.queued_bytes.load(Ordering::Relaxed), 100);

        metrics.release_datagram_capacity(&sm.queued_bytes, &notify, 100);

        assert_eq!(metrics.queued_bytes_global.load(Ordering::Relaxed), 0);
        assert_eq!(sm.queued_bytes.load(Ordering::Relaxed), 0);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn datagram_backpressure_global_release_wakes_other_session_waiter() {
        let metrics = Arc::new(ServerMetrics::default());
        let blocker_sm = Arc::new(SessionMetrics::default());
        let blocker_notify = Arc::new(Notify::new());
        reserve(&metrics, &blocker_sm, 100);
        let blocker_slot = DatagramSlot::new(
            vec![0u8; 100],
            Arc::clone(&blocker_sm),
            Arc::clone(&metrics),
            Arc::clone(&blocker_notify),
            100,
        );

        let waiter_sm = Arc::new(SessionMetrics::default());
        let waiter_notify = Arc::new(Notify::new());

        let waiter = wait_for_datagram_backpressure_slot(
            Arc::clone(&metrics),
            Arc::clone(&waiter_sm),
            Arc::clone(&waiter_notify),
            100,
            Instant::now() + Duration::from_millis(500),
            Arc::new(std::sync::atomic::AtomicBool::new(false)),
        );

        drop(blocker_slot);

        timeout(Duration::from_secs(1), waiter)
            .await
            .expect("global release should wake other-session waiters")
            .expect("other-session waiter should reserve released global capacity");

        metrics.release_datagram_capacity(&waiter_sm.queued_bytes, &waiter_notify, 100);

        assert_eq!(metrics.queued_bytes_global.load(Ordering::Relaxed), 0);
        assert_eq!(blocker_sm.queued_bytes.load(Ordering::Relaxed), 0);
        assert_eq!(waiter_sm.queued_bytes.load(Ordering::Relaxed), 0);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn datagram_backpressure_direct_outbound_release_wakes_second_send() {
        let metrics = Arc::new(ServerMetrics::default());
        let sm = Arc::new(SessionMetrics::default());
        let session_notify = Arc::new(Notify::new());
        reserve(&metrics, &sm, SESSION_MAX);

        let second_send = tokio::spawn(wait_for_datagram_backpressure_slot(
            Arc::clone(&metrics),
            Arc::clone(&sm),
            Arc::clone(&session_notify),
            1,
            Instant::now() + Duration::from_millis(500),
            Arc::new(std::sync::atomic::AtomicBool::new(false)),
        ));
        await_backpressure_waiter(Arc::clone(&metrics), 1)
            .await
            .expect("second send should register as parked");
        tokio::task::yield_now().await;

        metrics.release_datagram_capacity(&sm.queued_bytes, &session_notify, SESSION_MAX);

        let _ = timeout(Duration::from_millis(100), second_send)
            .await
            .expect("the first outbound send's direct release must wake the second")
            .expect("second send task must not panic")
            .expect("second send should reserve the released one-datagram budget");

        metrics.release_datagram_capacity(&sm.queued_bytes, &session_notify, 1);
        assert_eq!(metrics.queued_bytes_global.load(Ordering::Relaxed), 0);
        assert_eq!(sm.queued_bytes.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn datagram_backpressure_global_notifier_is_scoped_to_server_owner() {
        let owner_a = ServerMetrics::default();
        let owner_b = ServerMetrics::default();

        assert!(
            !Arc::ptr_eq(
                &owner_a.datagram_capacity_notify,
                &owner_b.datagram_capacity_notify,
            ),
            "independent server owners must not share datagram-capacity wakeups"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn datagram_backpressure_close_before_wait_registration_returns_closed() {
        let metrics = Arc::new(ServerMetrics::default());
        let sm = Arc::new(SessionMetrics::default());
        let notify = Arc::new(Notify::new());
        let closed = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let limits = crate::limits::Limits {
            max_queued_bytes_global: 1,
            max_queued_bytes_per_session: 1,
            backpressure_timeout_ms: 500,
            ..crate::limits::Limits::default()
        };

        let result = timeout(
            Duration::from_millis(50),
            reserve_datagram_capacity(
                &metrics,
                &sm,
                &notify,
                &closed,
                &limits,
                1,
                Instant::now() + Duration::from_millis(500),
            ),
        )
        .await
        .expect("a close that preceded waiter registration must be observed promptly");

        assert_eq!(result, Err(DatagramCapacityError::Closed));
        assert_eq!(metrics.queued_bytes_global.load(Ordering::Relaxed), 0);
        assert_eq!(sm.queued_bytes.load(Ordering::Relaxed), 0);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn datagram_send_backpressure_timeout_does_not_count_as_drop() {
        let metrics = Arc::new(ServerMetrics::default());
        let sm = Arc::new(SessionMetrics::default());
        let notify = Arc::new(Notify::new());
        let closed = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let limits = crate::limits::Limits {
            max_queued_bytes_global: 100,
            max_queued_bytes_per_session: 100,
            backpressure_timeout_ms: 20,
            ..crate::limits::Limits::default()
        };
        assert!(metrics
            .try_reserve_queued_bytes_with_session(&sm.queued_bytes, 100, 100, 100)
            .is_ok());

        let result = reserve_datagram_capacity(
            &metrics,
            &sm,
            &notify,
            &closed,
            &limits,
            1,
            Instant::now() + Duration::from_millis(20),
        )
        .await;

        assert_eq!(result, Err(DatagramCapacityError::Timeout));
        assert_eq!(metrics.datagrams_dropped.load(Ordering::Relaxed), 0);
        assert_eq!(
            metrics
                .datagrams_dropped_queue_session
                .load(Ordering::Relaxed),
            0
        );
        assert_eq!(
            metrics
                .datagrams_dropped_queue_global
                .load(Ordering::Relaxed),
            0
        );
        assert_eq!(
            metrics.datagrams_dropped_too_large.load(Ordering::Relaxed),
            0
        );
        assert_eq!(
            metrics
                .datagrams_dropped_rate_limited
                .load(Ordering::Relaxed),
            0
        );
        assert!(metrics.backpressure_timeout_count.load(Ordering::Relaxed) >= 1);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn datagram_send_global_budget_wait_does_not_count_as_drop() {
        let metrics = Arc::new(ServerMetrics::default());
        let filled = Arc::new(SessionMetrics::default());
        let waiter_sm = Arc::new(SessionMetrics::default());
        let notify = Arc::new(Notify::new());
        let closed = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let limits = crate::limits::Limits {
            max_queued_bytes_global: 50,
            max_queued_bytes_per_session: 100,
            backpressure_timeout_ms: 20,
            ..crate::limits::Limits::default()
        };
        assert!(metrics
            .try_reserve_queued_bytes_with_session(&filled.queued_bytes, 50, 50, 100)
            .is_ok());

        let result = reserve_datagram_capacity(
            &metrics,
            &waiter_sm,
            &notify,
            &closed,
            &limits,
            1,
            Instant::now() + Duration::from_millis(20),
        )
        .await;

        assert_eq!(result, Err(DatagramCapacityError::Timeout));
        assert_eq!(metrics.datagrams_dropped.load(Ordering::Relaxed), 0);
        assert_eq!(
            metrics
                .datagrams_dropped_queue_global
                .load(Ordering::Relaxed),
            0
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn datagram_backpressure_unrelated_server_release_does_not_retry_waiter() {
        let owner_a = Arc::new(ServerMetrics::default());
        let owner_a_sm = Arc::new(SessionMetrics::default());
        let owner_a_notify = Arc::new(Notify::new());
        reserve(&owner_a, &owner_a_sm, SESSION_MAX);

        let owner_a_waiter = tokio::spawn(wait_for_datagram_backpressure_slot(
            Arc::clone(&owner_a),
            Arc::clone(&owner_a_sm),
            Arc::clone(&owner_a_notify),
            1,
            Instant::now() + Duration::from_millis(500),
            Arc::new(std::sync::atomic::AtomicBool::new(false)),
        ));
        await_backpressure_waiter(Arc::clone(&owner_a), 1)
            .await
            .expect("owner A waiter must reach the parked state");
        tokio::task::yield_now().await;
        assert_eq!(owner_a.backpressure_wait_count.load(Ordering::Relaxed), 1);

        let owner_b = Arc::new(ServerMetrics::default());
        let owner_b_sm = Arc::new(SessionMetrics::default());
        let owner_b_notify = Arc::new(Notify::new());
        reserve(&owner_b, &owner_b_sm, 1);
        owner_b.release_datagram_capacity(&owner_b_sm.queued_bytes, &owner_b_notify, 1);

        tokio::time::sleep(Duration::from_millis(25)).await;
        assert_eq!(
            owner_a.backpressure_wait_count.load(Ordering::Relaxed),
            1,
            "an unrelated server release must not wake and retry owner A"
        );
        assert!(!owner_a_waiter.is_finished());

        owner_a.release_datagram_capacity(&owner_a_sm.queued_bytes, &owner_a_notify, SESSION_MAX);
        timeout(Duration::from_millis(100), owner_a_waiter)
            .await
            .expect("the owning server release must wake its waiter")
            .expect("owner A waiter must not panic")
            .expect("owner A waiter must reserve capacity");
        owner_a.release_datagram_capacity(&owner_a_sm.queued_bytes, &owner_a_notify, 1);

        assert_eq!(owner_a.queued_bytes_global.load(Ordering::Relaxed), 0);
        assert_eq!(owner_a_sm.queued_bytes.load(Ordering::Relaxed), 0);
        assert_eq!(owner_b.queued_bytes_global.load(Ordering::Relaxed), 0);
        assert_eq!(owner_b_sm.queued_bytes.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn unknown_session_has_no_datagram_read_state() {
        assert!(get_datagram_read_state("missing-read-state").is_none());
    }

    // The read-side lifecycle wait gets its own notifier on purpose:
    // `release_datagram_capacity` fires the capacity notifier on every send, so
    // sharing it would wake a parked reader proportionally to the send rate on
    // the exact hot path the batch read exists to speed up.
    #[test]
    fn every_close_path_fires_the_dedicated_datagram_lifecycle_notify() {
        let source = include_str!("session_registry.rs");
        let body = source
            .split("fn mark_state_closed_and_notify(")
            .nth(1)
            .and_then(|body| body.split("\n}\n").next())
            .expect("mark_state_closed_and_notify must be parseable");
        assert_eq!(
            body.matches("datagram_lifecycle_notify.notify_waiters()")
                .count(),
            1,
            "the single close funnel must wake read-side lifecycle waiters"
        );
    }
}
