//! Session registry mapping session IDs to live session state.
//!
//! Used by SessionHandle to send/recv datagrams and streams via the wtransport Connection.
//! Sessions are removed when the connection closes.

use dashmap::DashMap;
use once_cell::sync::Lazy;
use std::sync::Arc;
use tokio::sync::{mpsc, oneshot, Mutex};
use wtransport::Connection;

use crate::client_stream::{ClientBidiStreamHandle, ClientUniRecvHandle, ClientUniSendHandle};
use crate::server_metrics::ServerMetrics;

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
    /// Receiver for accepted bidi streams (forwarded from accept loop).
    pub bidi_accept_rx: Arc<Mutex<mpsc::Receiver<ClientBidiStreamHandle>>>,
    /// Receiver for accepted uni streams.
    pub uni_accept_rx: Arc<Mutex<mpsc::Receiver<ClientUniRecvHandle>>>,
    /// Sender for create-bidi requests.
    pub create_bi_tx: mpsc::Sender<CreateBiReq>,
    /// Sender for create-uni requests.
    pub create_uni_tx: mpsc::Sender<CreateUniReq>,
}

static REGISTRY: Lazy<DashMap<String, SessionState>> = Lazy::new(DashMap::new);

/// Insert a new session into the registry.
/// Returns (dgram_tx, bidi_accept_tx, uni_accept_tx) for the caller to use in spawn tasks.
/// Caller must spawn: dgram forward, bidi accept forward, uni accept forward, create_bi handler, create_uni handler.
pub fn insert(
    session_id: String,
    conn: Connection,
    metrics: Arc<ServerMetrics>,
) -> (
    mpsc::Sender<Vec<u8>>,
    mpsc::Sender<ClientBidiStreamHandle>,
    mpsc::Sender<ClientUniRecvHandle>,
    mpsc::Receiver<CreateBiReq>,
    mpsc::Receiver<CreateUniReq>,
) {
    let (dgram_tx, dgram_rx) = mpsc::channel(DGRAM_CHANNEL_CAPACITY);
    let (bidi_accept_tx, bidi_accept_rx) = mpsc::channel(STREAM_ACCEPT_CAPACITY);
    let (uni_accept_tx, uni_accept_rx) = mpsc::channel(STREAM_ACCEPT_CAPACITY);
    let (create_bi_tx, create_bi_rx) = mpsc::channel(64);
    let (create_uni_tx, create_uni_rx) = mpsc::channel(64);
    let state = SessionState {
        conn,
        dgram_rx: Arc::new(Mutex::new(dgram_rx)),
        metrics,
        bidi_accept_rx: Arc::new(Mutex::new(bidi_accept_rx)),
        uni_accept_rx: Arc::new(Mutex::new(uni_accept_rx)),
        create_bi_tx,
        create_uni_tx,
    };
    REGISTRY.insert(session_id, state);
    (dgram_tx, bidi_accept_tx, uni_accept_tx, create_bi_rx, create_uni_rx)
}

/// Look up session state by id. Returns None if not found or session closed.
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
    REGISTRY.remove(session_id);
}
