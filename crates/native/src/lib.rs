//! WebTransport native addon for Bun (napi-rs).
//!
//! This is the Rust side of the webtransport-bun project.
//! It owns a dedicated Tokio runtime thread and communicates
//! with JS via bounded channels + ThreadsafeFunction.

use napi_derive::napi;
use once_cell::sync::Lazy;
use std::sync::atomic::AtomicU64;
use std::sync::Arc;
use tokio::runtime::Runtime;
use tokio::sync::{mpsc, watch};

pub mod client;
pub mod limits;
pub mod metrics;
pub mod panic_guard;
pub mod rate_limit;
pub mod server;
pub mod server_metrics;
pub mod session;
pub mod spawn_tracked;
pub mod stream;

// ---------------------------------------------------------------------------
// Global Tokio runtime singleton
// ---------------------------------------------------------------------------

/// Dedicated Tokio runtime running on its own thread.
/// All wtransport objects are driven on this runtime.
pub(crate) static RUNTIME: Lazy<Runtime> = Lazy::new(|| {
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

/// Data passed to on_session callback when a session is accepted (P0-A).
#[derive(Clone, Debug)]
pub struct SessionAccepted {
    pub id: String,
    pub peer_ip: String,
    pub peer_port: u32,
}

/// Session lifecycle event: accepted or closed.
#[derive(Clone, Debug)]
pub enum SessionEvent {
    Accepted(SessionAccepted),
    Closed {
        id: String,
        code: Option<u32>,
        reason: Option<String>,
    },
}

static SESSION_ID_COUNTER: AtomicU64 = AtomicU64::new(0);

// ---------------------------------------------------------------------------
// Smoke-test export (trivial function to verify .node loads in Bun)
// ---------------------------------------------------------------------------

/// Returns a greeting string. Use this to verify the native addon loads.
#[napi]
pub fn smoke_test() -> String {
    panic_guard::catch_panic(|| {
        let _ = &*RUNTIME;
        Ok("webtransport-native is alive!".to_string())
    })
    .unwrap_or_else(|_| "webtransport-native (panic recovered)".to_string())
}

/// Returns the number of Tokio worker threads (should be 1).
#[napi]
pub fn runtime_worker_count() -> u32 {
    panic_guard::catch_panic(|| {
        let _ = &*RUNTIME;
        Ok(1u32)
    })
    .unwrap_or(0)
}

/// Initialize the runtime communication channels and wire the JS callback.
#[napi]
pub fn init_runtime(env: Env, callback: JsFunction) -> Result<()> {
    panic_guard::catch_panic(|| init_runtime_inner(env, callback))
}

/// Spawn the wtransport server loop on the dedicated runtime.
pub(crate) fn spawn_wtransport_server(
    metrics: Arc<server_metrics::ServerMetrics>,
    limits: limits::Limits,
    handshakes_burst_per_ip: u64,
    port: u16,
    mut shutdown_rx: watch::Receiver<()>,
    on_session_tsfn: Option<
        napi::threadsafe_function::ThreadsafeFunction<
            SessionEvent,
            napi::threadsafe_function::ErrorStrategy::Fatal,
        >,
    >,
) {
    use std::sync::atomic::Ordering;
    use tokio::io::AsyncReadExt;
    use tokio::io::AsyncWriteExt;
    use wtransport::{Endpoint, Identity, ServerConfig, VarInt};

    RUNTIME.spawn(async move {
        panic_guard::spawn_quic_task(async move {
            let identity = match Identity::self_signed(&["localhost", "127.0.0.1", "::1"]) {
                Ok(i) => i,
                Err(e) => {
                    eprintln!("webtransport-native: failed to create identity: {:?}", e);
                    return;
                }
            };
            let config = ServerConfig::builder()
                .with_bind_default(port)
                .with_identity(identity)
                .build();
            let server = match Endpoint::server(config) {
                Ok(s) => {
                    eprintln!("webtransport-native: endpoint created for port {}", port);
                    s
                }
                Err(e) => {
                    eprintln!("webtransport-native: failed to create endpoint: {:?}", e);
                    return;
                }
            };

            loop {
                let incoming = server.accept();
                tokio::select! {
                    _ = shutdown_rx.changed() => {
                        server.close(VarInt::from_u32(0), b"server closing");
                        break;
                    }
                    incoming_session = incoming => {
                        let metrics = Arc::clone(&metrics);
                        let limits = limits.clone();
                        let on_session = on_session_tsfn.clone();
                        spawn_tracked::spawn_tracked(
                            metrics.clone(),
                            spawn_tracked::TaskKind::Session,
                            async move {
                                metrics.handshakes_in_flight.fetch_add(1, Ordering::Relaxed);
                                let session_request = match incoming_session.await {
                                    Ok(r) => r,
                                    Err(_) => {
                                        metrics.handshakes_in_flight.fetch_sub(1, Ordering::Relaxed);
                                        return;
                                    }
                                };
                                // 4.4.1: Shed at session accept
                                if metrics.sessions_active.load(Ordering::Relaxed) >= limits.max_sessions {
                                    metrics.handshakes_in_flight.fetch_sub(1, Ordering::Relaxed);
                                    metrics.limit_exceeded_count.fetch_add(1, Ordering::Relaxed);
                                    return;
                                }
                                match session_request.accept().await {
                                    Ok(connection) => {
                                        let peer_ip = connection.remote_address().ip().to_string();
                                        if !rate_limit::try_acquire_per_ip_session(&peer_ip, handshakes_burst_per_ip) {
                                            metrics.handshakes_in_flight.fetch_sub(1, Ordering::Relaxed);
                                            metrics.rate_limited_count.fetch_add(1, Ordering::Relaxed);
                                            return;
                                        }
                                        metrics.handshakes_in_flight.fetch_sub(1, Ordering::Relaxed);
                                        metrics.sessions_active.fetch_add(1, Ordering::Relaxed);

                                        // P0-A: Emit session-accepted to JS
                                        let id = format!(
                                            "sess-{}",
                                            SESSION_ID_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
                                        );
                                        if let Some(ref tsfn) = on_session {
                                            let peer_port = connection.remote_address().port() as u32;
                                            let accepted = SessionAccepted {
                                                id: id.clone(),
                                                peer_ip: peer_ip.clone(),
                                                peer_port,
                                            };
                                            tsfn.call(
                                                SessionEvent::Accepted(accepted),
                                                napi::threadsafe_function::ThreadsafeFunctionCallMode::NonBlocking,
                                            );
                                        }

                                        let conn_bidi = connection.clone();
                                        let conn_uni = connection.clone();
                                        let conn_dgram = connection.clone();
                                        let m_bidi = Arc::clone(&metrics);
                                        let m_uni = Arc::clone(&metrics);
                                        let m_dgram = Arc::clone(&metrics);
                                        let lim_bidi = limits.clone();
                                        let lim_uni = limits.clone();
                                        let lim_dgram = limits.clone();

                                        // Bidi stream echo (4.4.2: shed if over max_streams_global)
                                        spawn_tracked::spawn_tracked(
                                            m_bidi.clone(),
                                            spawn_tracked::TaskKind::Stream,
                                            async move {
                                                if let Ok((mut send, mut recv)) = conn_bidi.accept_bi().await {
                                                    if m_bidi.streams_active.load(Ordering::Relaxed) >= lim_bidi.max_streams_global {
                                                        m_bidi.limit_exceeded_count.fetch_add(1, Ordering::Relaxed);
                                                        return;
                                                    }
                                                    m_bidi.streams_active.fetch_add(1, Ordering::Relaxed);
                                                    let mut buf = vec![0u8; 1024];
                                                    if let Ok(Some(n)) = recv.read(&mut buf).await {
                                                        let sz = n as u64;
                                                        if m_bidi.try_reserve_queued_bytes(sz, lim_bidi.max_queued_bytes_global) {
                                                            let _ = send.write_all(&buf[..n]).await;
                                                            m_bidi.release_queued_bytes(sz);
                                                        }
                                                    }
                                                    m_bidi.streams_active.fetch_sub(1, Ordering::Relaxed);
                                                }
                                            },
                                        );
                                        // Uni stream echo (4.4.2)
                                        spawn_tracked::spawn_tracked(
                                            m_uni.clone(),
                                            spawn_tracked::TaskKind::Stream,
                                            async move {
                                                if let Ok(mut recv) = conn_uni.accept_uni().await {
                                                    if m_uni.streams_active.load(Ordering::Relaxed) >= lim_uni.max_streams_global {
                                                        m_uni.limit_exceeded_count.fetch_add(1, Ordering::Relaxed);
                                                        let _ = recv.stop(0u32.into());
                                                        return;
                                                    }
                                                    m_uni.streams_active.fetch_add(1, Ordering::Relaxed);
                                                    let mut buf = vec![0u8; 1024];
                                                    if let Ok(Some(n)) = recv.read(&mut buf).await {
                                                        let sz = n as u64;
                                                        if m_uni.try_reserve_queued_bytes(sz, lim_uni.max_queued_bytes_global) {
                                                            if let Ok(opening) = conn_uni.open_uni().await {
                                                                if let Ok(mut send) = opening.await {
                                                                    let _ = send.write_all(&buf[..n]).await;
                                                                }
                                                            }
                                                            m_uni.release_queued_bytes(sz);
                                                        }
                                                    }
                                                    m_uni.streams_active.fetch_sub(1, Ordering::Relaxed);
                                                }
                                            },
                                        );
                                        // Datagram echo (4.4.3: drop if over max_datagram_size; 4.3.2: budget)
                                        let on_session_closed = on_session.clone();
                                        let peer_ip_for_release = peer_ip.clone();
                                        spawn_tracked::spawn_tracked(
                                            m_dgram.clone(),
                                            spawn_tracked::TaskKind::Stream,
                                            async move {
                                                loop {
                                                    tokio::select! {
                                                        res = conn_dgram.receive_datagram() => {
                                                            let dgram = match res {
                                                                Ok(d) => d,
                                                                Err(_) => break,
                                                            };
                                                            m_dgram.datagrams_in.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                                                            if dgram.len() > lim_dgram.max_datagram_size {
                                                                m_dgram.datagrams_dropped.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                                                                continue;
                                                            }
                                                            let sz = dgram.len() as u64;
                                                            if !m_dgram.try_reserve_queued_bytes(sz, lim_dgram.max_queued_bytes_global) {
                                                                m_dgram.datagrams_dropped.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                                                                continue;
                                                            }
                                                            if conn_dgram.send_datagram(dgram.as_ref()).is_ok() {
                                                                m_dgram.datagrams_out.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                                                            }
                                                            m_dgram.release_queued_bytes(sz);
                                                        }
                                                        _ = conn_dgram.closed() => break,
                                                    }
                                                }
                                                rate_limit::release_per_ip_session(&peer_ip_for_release);
                                                m_dgram.sessions_active.fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
                                                if let Some(ref tsfn) = on_session_closed {
                                                    tsfn.call(
                                                        SessionEvent::Closed { id: id.clone(), code: None, reason: None },
                                                        napi::threadsafe_function::ThreadsafeFunctionCallMode::NonBlocking,
                                                    );
                                                }
                                            },
                                        );
                                    }
                                    Err(_) => {
                                        metrics.handshakes_in_flight.fetch_sub(1, Ordering::Relaxed);
                                    }
                                }
                            },
                        );
                    }
                }
            }
        });
    });
}

fn init_runtime_inner(env: Env, callback: JsFunction) -> Result<()> {
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

    // Spawn a Tokio task to drain evt_rx and notify JS (panic-safe)
    RUNTIME.spawn(async move {
        panic_guard::spawn_quic_task(async move {
            while let Some(_evt) = evt_rx.recv().await {
                let mut batch = vec![];
                batch.push(JsEvent {
                    name: "pong".to_string(),
                    session_id: None,
                });
                while let Ok(Event::Pong) = evt_rx.try_recv() {
                    batch.push(JsEvent {
                        name: "pong".to_string(),
                        session_id: None,
                    });
                }
                tsfn.call(batch, ThreadsafeFunctionCallMode::NonBlocking);
            }
        });
    });

    Ok(())
}
