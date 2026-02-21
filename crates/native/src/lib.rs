//! WebTransport native addon for Bun (napi-rs).
//!
//! This is the Rust side of the webtransport-bun project.
//! It owns a dedicated Tokio runtime thread and communicates
//! with JS via bounded channels + ThreadsafeFunction.

use napi_derive::napi;
use once_cell::sync::Lazy;
use tokio::runtime::Runtime;
use tokio::sync::mpsc;

pub mod server;
pub mod session;
pub mod stream;
pub mod metrics;

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

use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::{Env, JsFunction, Result};

// ---------------------------------------------------------------------------
// TSFN / Javascript Event mapping
// ---------------------------------------------------------------------------

#[napi(object)]
#[derive(Clone, Debug)]
pub struct JsEvent {
    pub name: String,
    pub session_id: Option<u32>,
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
    let _ = &*RUNTIME;
    1
}

/// Initialize the runtime communication channels and wire the JS callback.
#[napi]
pub fn init_runtime(env: Env, callback: JsFunction) -> Result<()> {
    let (cmd_tx, mut cmd_rx, evt_tx, mut evt_rx) = create_channels();

    let tsfn: ThreadsafeFunction<Vec<JsEvent>, ErrorStrategy::Fatal> = callback
        .create_threadsafe_function(
            0,
            |ctx: napi::threadsafe_function::ThreadSafeCallContext<Vec<JsEvent>>| {
                let mut js_array = ctx.env.create_array_with_length(ctx.value.len())?;
                for (i, evt) in ctx.value.iter().enumerate() {
                    let mut obj = ctx.env.create_object()?;
                    obj.set("name", evt.name.clone())?;
                    if let Some(id) = evt.session_id {
                        obj.set("session_id", id)?;
                    } else {
                        obj.set("session_id", ctx.env.get_null()?)?;
                    }
                    js_array.set_element(i as u32, obj)?;
                }
                Ok(vec![js_array])
            },
        )?;

    // Spawn a Tokio task to drain evt_rx and notify JS
    RUNTIME.spawn(async move {
        while let Some(evt) = evt_rx.recv().await {
            let mut batch = vec![];
            batch.push(JsEvent { name: "pong".to_string(), session_id: None });
            
            // Drain queue
            while let Ok(Event::Pong) = evt_rx.try_recv() {
                batch.push(JsEvent { name: "pong".to_string(), session_id: None });
            }
            
            tsfn.call(batch, ThreadsafeFunctionCallMode::NonBlocking);
        }
    });

    Ok(())
}
