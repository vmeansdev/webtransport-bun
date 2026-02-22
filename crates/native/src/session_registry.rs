//! Session registry mapping session IDs to live session state.
//!
//! Used by SessionHandle to send/recv datagrams via the wtransport Connection.
//! Sessions are removed when the connection closes.

use dashmap::DashMap;
use once_cell::sync::Lazy;
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};
use wtransport::Connection;

use crate::server_metrics::ServerMetrics;

/// Channel capacity for datagrams per session (bounded to prevent unbounded buffering).
const DGRAM_CHANNEL_CAPACITY: usize = 2048;

/// Live state for an open session.
pub struct SessionState {
    /// Connection handle for sending datagrams.
    pub conn: Connection,
    /// Receiver for datagrams forwarded from the connection.
    /// Wrapped in Arc<Mutex<_>> so SessionHandle can recv from any thread.
    pub dgram_rx: Arc<Mutex<mpsc::Receiver<Vec<u8>>>>,
    /// Server metrics (for datagrams_out when send_datagram succeeds).
    pub metrics: Arc<ServerMetrics>,
}

static REGISTRY: Lazy<DashMap<String, SessionState>> = Lazy::new(DashMap::new);

/// Insert a new session into the registry.
/// Returns the sender for the datagram channel; the caller must spawn a task
/// that receives from `conn` and forwards to this sender.
pub fn insert(
    session_id: String,
    conn: Connection,
    metrics: Arc<ServerMetrics>,
) -> mpsc::Sender<Vec<u8>> {
    let (dgram_tx, dgram_rx) = mpsc::channel(DGRAM_CHANNEL_CAPACITY);
    let state = SessionState {
        conn,
        dgram_rx: Arc::new(Mutex::new(dgram_rx)),
        metrics,
    };
    REGISTRY.insert(session_id, state);
    dgram_tx
}

/// Look up session state by id. Returns None if not found or session closed.
pub fn get(
    session_id: &str,
) -> Option<(Connection, Arc<Mutex<mpsc::Receiver<Vec<u8>>>>, Arc<ServerMetrics>)> {
    REGISTRY.get(session_id).map(|entry| {
        (
            entry.conn.clone(),
            Arc::clone(&entry.dgram_rx),
            Arc::clone(&entry.metrics),
        )
    })
}

/// Remove session from registry. Call when connection closes.
pub fn remove(session_id: &str) {
    REGISTRY.remove(session_id);
}
