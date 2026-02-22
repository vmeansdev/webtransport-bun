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
pub mod client_stream;
pub mod limits;
pub mod metrics;
pub mod panic_guard;
pub mod rate_limit;
pub mod server;
pub mod server_metrics;
pub mod session;
pub mod session_registry;
pub mod spawn_tracked;


// ---------------------------------------------------------------------------
// Global Tokio runtime singleton
// ---------------------------------------------------------------------------

/// Server runtime: drives the WebTransport server and all server-side stream bridges.
pub(crate) static RUNTIME: Lazy<Runtime> = Lazy::new(|| {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .enable_all()
        .thread_name("wt-server")
        .build()
        .expect("failed to create server Tokio runtime")
});

/// Client runtime: drives client connections and client-side stream bridges.
/// Isolated from server to avoid same-process deadlock when client+server share a process.
pub(crate) static CLIENT_RUNTIME: Lazy<Runtime> = Lazy::new(|| {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .enable_all()
        .thread_name("wt-client")
        .build()
        .expect("failed to create client Tokio runtime")
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
    handshakes_burst_per_prefix: u64,
    port: u16,
    mut shutdown_rx: watch::Receiver<()>,
    on_session_tsfn: Option<
        napi::threadsafe_function::ThreadsafeFunction<
            SessionEvent,
            napi::threadsafe_function::ErrorStrategy::Fatal,
        >,
    >,
    cert_pem: String,
    key_pem: String,
) {
    use std::io::Write;
    use std::sync::atomic::Ordering;
    use tokio::io::AsyncReadExt;
    use tokio::io::AsyncWriteExt;
    use wtransport::{Endpoint, Identity, ServerConfig, VarInt};

    RUNTIME.spawn(async move {
        panic_guard::spawn_quic_task(async move {
            let identity = if !cert_pem.trim().is_empty() && !key_pem.trim().is_empty() {
                let mut cert_file = match tempfile::Builder::new()
                    .prefix("wt-cert-")
                    .suffix(".pem")
                    .tempfile()
                {
                    Ok(f) => f,
                    Err(e) => {
                        eprintln!("webtransport-native: failed to create temp cert file: {:?}", e);
                        return;
                    }
                };
                let _ = cert_file.write_all(cert_pem.as_bytes());
                let _ = cert_file.flush();
                let cert_path = cert_file.path().to_path_buf();
                let mut key_file = match tempfile::Builder::new()
                    .prefix("wt-key-")
                    .suffix(".pem")
                    .tempfile()
                {
                    Ok(f) => f,
                    Err(e) => {
                        eprintln!("webtransport-native: failed to create temp key file: {:?}", e);
                        return;
                    }
                };
                let _ = key_file.write_all(key_pem.as_bytes());
                let _ = key_file.flush();
                let key_path = key_file.path().to_path_buf();
                match Identity::load_pemfiles(&cert_path, &key_path).await {
                    Ok(i) => {
                        drop(cert_file);
                        drop(key_file);
                        i
                    }
                    Err(e) => {
                        eprintln!("webtransport-native: failed to load PEM identity: {:?}", e);
                        return;
                    }
                }
            } else {
                match Identity::self_signed(&["localhost", "127.0.0.1", "::1"]) {
                    Ok(i) => i,
                    Err(e) => {
                        eprintln!("webtransport-native: failed to create identity: {:?}", e);
                        return;
                    }
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
                                    Ok(r) => {
                                        eprintln!(
                                            "webtransport-native: CONNECT received authority={:?}",
                                            r.authority()
                                        );
                                        r
                                    }
                                    Err(e) => {
                                        metrics.handshakes_in_flight.fetch_sub(1, Ordering::Relaxed);
                                        let mut chain = String::new();
                                        let mut src: &dyn std::error::Error = &e;
                                        chain.push_str(&src.to_string());
                                        while let Some(s) = src.source() {
                                            chain.push_str(" <- ");
                                            chain.push_str(&s.to_string());
                                            src = s;
                                        }
                                        eprintln!(
                                            "webtransport-native: handshake failed (incoming_session): {}",
                                            chain
                                        );
                                        return;
                                    }
                                };
                                // 4.4.1: Shed at session accept
                                if metrics.sessions_active.load(Ordering::Relaxed) >= limits.max_sessions {
                                    metrics.handshakes_in_flight.fetch_sub(1, Ordering::Relaxed);
                                    metrics.limit_exceeded_count.fetch_add(1, Ordering::Relaxed);
                                    return;
                                }
                                let authority = session_request.authority().to_string();
                                match session_request.accept().await {
                                    Ok(connection) => {
                                        let peer_ip = connection.remote_address().ip().to_string();
                                        let peer_port = connection.remote_address().port() as u32;
                                        eprintln!(
                                            "webtransport-native: session accepted peer={}:{} authority={:?}",
                                            peer_ip,
                                            peer_port,
                                            authority
                                        );
                                        if !rate_limit::try_acquire_per_ip_session_with_prefix(
                                            &peer_ip,
                                            handshakes_burst_per_ip,
                                            handshakes_burst_per_prefix,
                                        ) {
                                            metrics.handshakes_in_flight.fetch_sub(1, Ordering::Relaxed);
                                            metrics.rate_limited_count.fetch_add(1, Ordering::Relaxed);
                                            return;
                                        }
                                        metrics.handshakes_in_flight.fetch_sub(1, Ordering::Relaxed);
                                        metrics.sessions_active.fetch_add(1, Ordering::Relaxed);

                                        let id = format!(
                                            "sess-{}",
                                            SESSION_ID_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
                                        );

                                        // P0-1: Register session BEFORE emitting to JS so acceptBidiStream etc. find it
                                        let (dgram_tx, bidi_accept_tx, uni_accept_tx, create_bi_rx, create_uni_rx) =
                                            session_registry::insert(
                                                id.clone(),
                                                connection.clone(),
                                                metrics.clone(),
                                            );

                                        // P0-A: Emit session-accepted to JS
                                        if let Some(ref tsfn) = on_session {
                                            let accepted = SessionAccepted {
                                                id: id.clone(),
                                                peer_ip: peer_ip.clone(),
                                                peer_port: peer_port,
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

                                        // P1-4: Per-session queued byte budget
                                        let session_queued =
                                            Arc::new(std::sync::atomic::AtomicU64::new(0));

                                        // Bidi stream accept loop: forward to JS via channel (4.4.2: shed if over limits)
                                        let peer_ip_bidi = peer_ip.clone();
                                        spawn_tracked::spawn_tracked(
                                            m_bidi.clone(),
                                            spawn_tracked::TaskKind::Stream,
                                            async move {
                                                loop {
                                                    tokio::select! {
                                                        _ = conn_bidi.closed() => break,
                                                        res = conn_bidi.accept_bi() => {
                                                            let Ok((mut send, recv)) = res else { break };
                                                            if !rate_limit::try_acquire_stream_open(&peer_ip_bidi) {
                                                                m_bidi.rate_limited_count.fetch_add(1, Ordering::Relaxed);
                                                                let _ = send.reset(0u32.into());
                                                                continue;
                                                            }
                                                            if m_bidi.streams_active.load(Ordering::Relaxed) >= lim_bidi.max_streams_global {
                                                                m_bidi.limit_exceeded_count.fetch_add(1, Ordering::Relaxed);
                                                                let _ = send.reset(0u32.into());
                                                                continue;
                                                            }
                                                            m_bidi.streams_active.fetch_add(1, Ordering::Relaxed);
                                                            let (read_rx, write_tx, stop_tx) = crate::client_stream::spawn_bidi_bridge(send, recv);
                                                            let handle = crate::client_stream::ClientBidiStreamHandle::new(read_rx, write_tx, stop_tx);
                                                            let _ = bidi_accept_tx.send(handle).await;
                                                            m_bidi.streams_active.fetch_sub(1, Ordering::Relaxed);
                                                        }
                                                    }
                                                }
                                            },
                                        );
                                        // Uni stream accept loop: forward to JS via channel (4.4.2; P1-5)
                                        let peer_ip_uni = peer_ip.clone();
                                        spawn_tracked::spawn_tracked(
                                            m_uni.clone(),
                                            spawn_tracked::TaskKind::Stream,
                                            async move {
                                                loop {
                                                    tokio::select! {
                                                        _ = conn_uni.closed() => break,
                                                        res = conn_uni.accept_uni() => {
                                                            let Ok(recv) = res else { break };
                                                            if !rate_limit::try_acquire_stream_open(&peer_ip_uni) {
                                                                m_uni.rate_limited_count.fetch_add(1, Ordering::Relaxed);
                                                                let _ = recv.stop(0u32.into());
                                                                continue;
                                                            }
                                                            if m_uni.streams_active.load(Ordering::Relaxed) >= lim_uni.max_streams_global {
                                                                m_uni.limit_exceeded_count.fetch_add(1, Ordering::Relaxed);
                                                                let _ = recv.stop(0u32.into());
                                                                continue;
                                                            }
                                                            m_uni.streams_active.fetch_add(1, Ordering::Relaxed);
                                                            let (read_rx, stop_tx) = crate::client_stream::spawn_uni_recv_bridge(recv);
                                                            let handle = crate::client_stream::ClientUniRecvHandle::new(read_rx, stop_tx);
                                                            let _ = uni_accept_tx.send(handle).await;
                                                            m_uni.streams_active.fetch_sub(1, Ordering::Relaxed);
                                                        }
                                                    }
                                                }
                                            },
                                        );
                                        // Create-bidi handler: respond to SessionHandle.create_bidi_stream
                                        let conn_create_bi = connection.clone();
                                        let m_create_bi = Arc::clone(&metrics);
                                        spawn_tracked::spawn_tracked(
                                            m_create_bi,
                                            spawn_tracked::TaskKind::Stream,
                                            async move {
                                                let mut rx = create_bi_rx;
                                                while let Some(resp_tx) = rx.recv().await {
                                                    let r = match conn_create_bi.open_bi().await {
                                                        Ok(opening) => match opening.await {
                                                            Ok((send, recv)) => {
                                                                let (read_rx, write_tx, stop_tx) =
                                                                    crate::client_stream::spawn_bidi_bridge(send, recv);
                                                                Ok(crate::client_stream::ClientBidiStreamHandle::new(
                                                                    read_rx, write_tx, stop_tx,
                                                                ))
                                                            }
                                                            Err(e) => Err(e.to_string()),
                                                        },
                                                        Err(e) => Err(e.to_string()),
                                                    };
                                                    let _ = resp_tx.send(r);
                                                }
                                            },
                                        );
                                        // Create-uni handler: respond to SessionHandle.create_uni_stream
                                        let conn_create_uni = connection.clone();
                                        let m_create_uni = Arc::clone(&metrics);
                                        spawn_tracked::spawn_tracked(
                                            m_create_uni,
                                            spawn_tracked::TaskKind::Stream,
                                            async move {
                                                let mut rx = create_uni_rx;
                                                while let Some(resp_tx) = rx.recv().await {
                                                    match conn_create_uni.open_uni().await {
                                                        Ok(opening) => {
                                                            match opening.await {
                                                                Ok(send) => {
                                                                    let write_tx = crate::client_stream::spawn_uni_send_bridge(send);
                                                                    let handle = crate::client_stream::ClientUniSendHandle::new(write_tx);
                                                                    let _ = resp_tx.send(Ok(handle));
                                                                }
                                                                Err(e) => {
                                                                    let _ = resp_tx.send(Err(e.to_string()));
                                                                }
                                                            }
                                                        }
                                                        Err(e) => {
                                                            let _ = resp_tx.send(Err(e.to_string()));
                                                        }
                                                    }
                                                }
                                            },
                                        );
                                        // Datagram forward to channel (4.4.3: drop if over max_datagram_size; 4.3.2: budget)
                                        // JS echo via SessionHandle.send_datagram
                                        let on_session_closed = on_session.clone();
                                        let peer_ip_for_release = peer_ip.clone();
                                        let session_queued_dgram = Arc::clone(&session_queued);
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
                                                            if !rate_limit::try_acquire_datagram_ingress(&peer_ip_for_release) {
                                                                m_dgram.rate_limited_count.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                                                                m_dgram.datagrams_dropped.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                                                                continue;
                                                            }
                                                            if dgram.len() > lim_dgram.max_datagram_size {
                                                                m_dgram.datagrams_dropped.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                                                                continue;
                                                            }
                                                            let sz = dgram.len() as u64;
                                                            if !m_dgram.try_reserve_queued_bytes_with_session(
                                                                &session_queued_dgram,
                                                                sz,
                                                                lim_dgram.max_queued_bytes_global,
                                                                lim_dgram.max_queued_bytes_per_session,
                                                            ) {
                                                                m_dgram.datagrams_dropped.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                                                                continue;
                                                            }
                                                            // Forward to channel; JS reads via SessionHandle.read_datagram
                                                            // (datagrams_out incremented in SessionHandle.send_datagram when JS echoes)
                                                            let payload = dgram.as_ref().to_vec();
                                                            let _ = dgram_tx.send(payload).await;
                                                            crate::server_metrics::ServerMetrics::release_session_queued_bytes(
                                                                &session_queued_dgram,
                                                                &m_dgram,
                                                                sz,
                                                            );
                                                        }
                                                        _ = conn_dgram.closed() => break,
                                                    }
                                                }
                                                session_registry::remove(&id);
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
                                    Err(e) => {
                                        metrics.handshakes_in_flight.fetch_sub(1, Ordering::Relaxed);
                                        let mut chain = String::new();
                                        let mut src: &dyn std::error::Error = &e;
                                        chain.push_str(&src.to_string());
                                        while let Some(s) = src.source() {
                                            chain.push_str(" <- ");
                                            chain.push_str(&s.to_string());
                                            src = s;
                                        }
                                        eprintln!(
                                            "webtransport-native: session accept failed authority={:?} error={}",
                                            authority,
                                            chain
                                        );
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
