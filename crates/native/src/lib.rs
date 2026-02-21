//! WebTransport native addon for Bun (napi-rs).
//!
//! This is the Rust side of the webtransport-bun project.
//! It owns a dedicated Tokio runtime thread and communicates
//! with JS via bounded channels + ThreadsafeFunction.

use napi_derive::napi;
use once_cell::sync::Lazy;
use tokio::runtime::Runtime;
use tokio::sync::mpsc;

// ---------------------------------------------------------------------------
// Global Tokio runtime singleton
// ---------------------------------------------------------------------------

/// Dedicated Tokio runtime running on its own thread.
/// All wtransport objects are driven on this runtime.
static RUNTIME: Lazy<Runtime> = Lazy::new(|| {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1) // single dedicated thread as per ARCHITECTURE.md
        .enable_all()
        .thread_name("wt-tokio")
        .build()
        .expect("failed to create Tokio runtime")
});

// ---------------------------------------------------------------------------
// Command / Event channel skeleton
// ---------------------------------------------------------------------------

/// Commands sent from JS → Rust runtime.
#[derive(Debug)]
pub enum Command {
    /// Placeholder — will be replaced with real commands (CreateServer, SendDatagram, etc.)
    Ping,
}

/// Events sent from Rust runtime → JS.
#[derive(Debug)]
pub enum Event {
    /// Placeholder
    Pong,
}

/// Channel capacity for command queue (bounded to prevent unbounded buffering).
const CMD_CHANNEL_CAPACITY: usize = 4096;

/// Channel capacity for event queue.
const EVENT_CHANNEL_CAPACITY: usize = 4096;

/// Create a bounded command/event channel pair.
pub fn create_channels() -> (
    mpsc::Sender<Command>,
    mpsc::Receiver<Command>,
    mpsc::Sender<Event>,
    mpsc::Receiver<Event>,
) {
    let (cmd_tx, cmd_rx) = mpsc::channel::<Command>(CMD_CHANNEL_CAPACITY);
    let (evt_tx, evt_rx) = mpsc::channel::<Event>(EVENT_CHANNEL_CAPACITY);
    (cmd_tx, cmd_rx, evt_tx, evt_rx)
}

// ---------------------------------------------------------------------------
// Smoke-test export (trivial function to verify .node loads in Bun)
// ---------------------------------------------------------------------------

/// Returns a greeting string. Use this to verify the native addon loads.
#[napi]
pub fn smoke_test() -> String {
    // Verify the runtime is initialized as a side effect
    let _ = &*RUNTIME;
    "webtransport-native is alive!".to_string()
}

/// Returns the number of Tokio worker threads (should be 1).
#[napi]
pub fn runtime_worker_count() -> u32 {
    // The runtime is lazily initialized; this call ensures it exists.
    let _ = &*RUNTIME;
    1
}
