//! Session registry mapping session IDs to live session state.
//!
//! Used by SessionHandle to send/recv datagrams and streams via the wtransport Connection.
//! Sessions are removed when the connection closes.

use dashmap::DashMap;
use once_cell::sync::Lazy;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::{mpsc, oneshot, Mutex, Notify};
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

/// Channel capacity for datagrams per session (bounded to prevent unbounded buffering).
const DGRAM_CHANNEL_CAPACITY: usize = 2048;
const STREAM_ACCEPT_CAPACITY: usize = 256;

/// Request to create a bidi stream. Response via oneshot.
pub type CreateBiReq = oneshot::Sender<std::result::Result<ClientBidiStreamHandle, String>>;
/// Request to create a uni stream. Response via oneshot.
pub type CreateUniReq = oneshot::Sender<std::result::Result<ClientUniSendHandle, String>>;

/// Live state for an open session.
pub struct SessionState {
    /// Connection handle for sending datagrams and opening streams.
    pub conn: Connection,
    /// Receiver for datagrams forwarded from the connection.
    pub dgram_rx: Arc<Mutex<mpsc::Receiver<Vec<u8>>>>,
    /// Server metrics (for datagrams_out when send_datagram succeeds).
    pub metrics: Arc<ServerMetrics>,
    /// Per-session metrics for stream caps and metricsSnapshot.
    pub session_metrics: Arc<SessionMetrics>,
    /// Receiver for accepted bidi streams (forwarded from accept loop).
    pub bidi_accept_rx: Arc<Mutex<mpsc::Receiver<ClientBidiStreamHandle>>>,
    /// Receiver for accepted uni streams.
    pub uni_accept_rx: Arc<Mutex<mpsc::Receiver<ClientUniRecvHandle>>>,
    /// Sender for create-bidi requests.
    pub create_bi_tx: mpsc::Sender<CreateBiReq>,
    /// Sender for create-uni requests.
    pub create_uni_tx: mpsc::Sender<CreateUniReq>,
    /// Notifies waiters when stream capacity may have changed.
    pub stream_capacity_notify: Arc<Notify>,
    /// Effective limits for this session (captured from owning server).
    pub limits: crate::limits::Limits,
}

static REGISTRY: Lazy<DashMap<String, SessionState>> = Lazy::new(DashMap::new);

/// Insert a new session into the registry.
/// Returns (dgram_tx, bidi_accept_tx, uni_accept_tx, create_bi_rx, create_uni_rx, session_metrics).
/// Caller must spawn: dgram forward, bidi accept forward, uni accept forward, create_bi handler, create_uni handler.
#[allow(clippy::type_complexity)]
pub fn insert(
    session_id: String,
    conn: Connection,
    metrics: Arc<ServerMetrics>,
    limits: crate::limits::Limits,
) -> (
    mpsc::Sender<Vec<u8>>,
    mpsc::Sender<ClientBidiStreamHandle>,
    mpsc::Sender<ClientUniRecvHandle>,
    mpsc::Receiver<CreateBiReq>,
    mpsc::Receiver<CreateUniReq>,
    Arc<SessionMetrics>,
) {
    let (dgram_tx, dgram_rx) = mpsc::channel(DGRAM_CHANNEL_CAPACITY);
    let (bidi_accept_tx, bidi_accept_rx) = mpsc::channel(STREAM_ACCEPT_CAPACITY);
    let (uni_accept_tx, uni_accept_rx) = mpsc::channel(STREAM_ACCEPT_CAPACITY);
    let (create_bi_tx, create_bi_rx) = mpsc::channel(64);
    let (create_uni_tx, create_uni_rx) = mpsc::channel(64);
    let session_metrics = Arc::new(SessionMetrics::default());
    let stream_capacity_notify = Arc::new(Notify::new());
    let state = SessionState {
        conn,
        dgram_rx: Arc::new(Mutex::new(dgram_rx)),
        metrics,
        session_metrics: Arc::clone(&session_metrics),
        bidi_accept_rx: Arc::new(Mutex::new(bidi_accept_rx)),
        uni_accept_rx: Arc::new(Mutex::new(uni_accept_rx)),
        create_bi_tx,
        create_uni_tx,
        stream_capacity_notify,
        limits,
    };
    REGISTRY.insert(session_id, state);
    (
        dgram_tx,
        bidi_accept_tx,
        uni_accept_tx,
        create_bi_rx,
        create_uni_rx,
        session_metrics,
    )
}

pub fn get_stream_capacity_notify(session_id: &str) -> Option<Arc<Notify>> {
    REGISTRY
        .get(session_id)
        .map(|entry| Arc::clone(&entry.stream_capacity_notify))
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
    Arc<Mutex<mpsc::Receiver<Vec<u8>>>>,
    Arc<ServerMetrics>,
    Arc<Mutex<mpsc::Receiver<ClientBidiStreamHandle>>>,
    Arc<Mutex<mpsc::Receiver<ClientUniRecvHandle>>>,
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

/// Remove session from registry. Call when connection closes.
pub fn remove(session_id: &str) {
    if let Some((_, state)) = REGISTRY.remove(session_id) {
        state.stream_capacity_notify.notify_waiters();
    }
}

/// Get per-session metrics by session id. Returns None if session not found.
pub fn get_session_metrics(session_id: &str) -> Option<Arc<SessionMetrics>> {
    REGISTRY
        .get(session_id)
        .map(|entry| Arc::clone(&entry.session_metrics))
}

/// Close a session: close the QUIC connection and remove from registry.
/// Closing the connection causes all pending reads/writes to fail,
/// which unblocks iterators and bridge tasks.
pub fn close_session(session_id: &str, code: u32, reason: &[u8]) {
    if let Some((_, state)) = REGISTRY.remove(session_id) {
        state.stream_capacity_notify.notify_waiters();
        state.conn.close(wtransport::VarInt::from_u32(code), reason);
    }
}

/// Close all sessions. Called during server shutdown for deterministic cleanup.
pub fn close_all(code: u32, reason: &[u8]) {
    let keys: Vec<String> = REGISTRY.iter().map(|e| e.key().clone()).collect();
    for key in keys {
        if let Some((_, state)) = REGISTRY.remove(&key) {
            state.stream_capacity_notify.notify_waiters();
            state.conn.close(wtransport::VarInt::from_u32(code), reason);
        }
    }
}
