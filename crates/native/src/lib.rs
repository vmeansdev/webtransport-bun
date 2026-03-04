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
use tokio::sync::watch;

pub mod client;
pub mod client_pool;
pub mod client_stream;
pub mod histogram;
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
        .unwrap_or_else(|e| {
            eprintln!(
                "webtransport-native: FATAL E_INTERNAL: failed to create server Tokio runtime: {}",
                e
            );
            std::process::abort();
        })
});

/// Client runtime: drives client connections and client-side stream bridges.
/// Isolated from server to avoid same-process deadlock when client+server share a process.
pub(crate) static CLIENT_RUNTIME: Lazy<Runtime> = Lazy::new(|| {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .enable_all()
        .thread_name("wt-client")
        .build()
        .unwrap_or_else(|e| {
            eprintln!(
                "webtransport-native: FATAL E_INTERNAL: failed to create client Tokio runtime: {}",
                e
            );
            std::process::abort();
        })
});

/// Data passed to on_session callback when a session is accepted.
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

/// Structured log event forwarded to JS log callback.
#[derive(Clone, Debug)]
pub struct LogEvent {
    pub level: String,
    pub msg: String,
    pub session_id: Option<String>,
    pub peer_ip: Option<String>,
    pub peer_port: Option<u32>,
}

static SESSION_ID_COUNTER: AtomicU64 = AtomicU64::new(0);
static RATE_LIMIT_CLEANUP_ONCE: std::sync::Once = std::sync::Once::new();
#[cfg(test)]
static TSFN_DELIVERY_FAILURE_COUNT: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(0);
#[cfg(test)]
static CHANNEL_DELIVERY_FAILURE_COUNT: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(0);

fn emit_log(
    tx: &Option<tokio::sync::mpsc::Sender<LogEvent>>,
    redact: bool,
    level: &str,
    msg: &str,
    session_id: Option<&str>,
    peer_ip: Option<&str>,
    peer_port: Option<u32>,
) {
    // Keep stderr quiet by default to avoid log floods during load/soak runs.
    // Full structured details still go through the optional JS log callback.
    if matches!(level, "error") {
        eprintln!("webtransport-native: [{}]", level);
    }
    let out_msg = if redact {
        match level {
            "error" => "native error (redacted)",
            "warn" => "native warning (redacted)",
            "info" => "native info",
            "debug" => "native debug",
            _ => "native event",
        }
        .to_string()
    } else {
        msg.to_string()
    };
    if let Some(tx) = tx {
        if tx
            .try_send(LogEvent {
                level: level.to_string(),
                msg: out_msg,
                session_id: if redact {
                    None
                } else {
                    session_id.map(String::from)
                },
                peer_ip: if redact {
                    None
                } else {
                    peer_ip.map(String::from)
                },
                peer_port: if redact { None } else { peer_port },
            })
            .is_err()
        {
            eprintln!("webtransport-native: log event dropped (queue full or closed)");
        }
    }
}

pub(crate) fn report_tsfn_status(context: &str, status: napi::Status) {
    if status != napi::Status::Ok {
        #[cfg(test)]
        {
            TSFN_DELIVERY_FAILURE_COUNT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
        eprintln!(
            "webtransport-native: {} callback delivery failed: {:?}",
            context, status
        );
    }
}

pub(crate) fn report_channel_failure(context: &str) {
    #[cfg(test)]
    {
        CHANNEL_DELIVERY_FAILURE_COUNT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    }
    eprintln!("webtransport-native: {} channel delivery failed", context);
}

pub(crate) fn report_channel_closed(context: &str) {
    #[cfg(test)]
    {
        CHANNEL_DELIVERY_FAILURE_COUNT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    }
    if std::env::var("WEBTRANSPORT_LOG_EXPECTED_CHANNEL_CLOSES")
        .ok()
        .as_deref()
        == Some("1")
    {
        eprintln!("webtransport-native: {} channel closed (expected)", context);
    }
}

fn send_startup_result(
    startup_tx: &mut Option<std::sync::mpsc::Sender<std::result::Result<(), String>>>,
    res: std::result::Result<(), String>,
) {
    if let Some(tx) = startup_tx.take() {
        if tx.send(res).is_err() {
            report_channel_failure("startup result");
        }
    }
}

fn write_and_flush_pem<W: std::io::Write>(
    writer: &mut W,
    pem: &str,
    what: &str,
) -> std::result::Result<(), String> {
    writer
        .write_all(pem.as_bytes())
        .map_err(|e| format!("failed to write temp {} file: {:?}", what, e))?;
    writer
        .flush()
        .map_err(|e| format!("failed to flush temp {} file: {:?}", what, e))?;
    Ok(())
}

/// Spawn a background task that batches events from a channel and delivers
/// them to a ThreadsafeFunction in groups (max_batch items or every flush_ms).
pub(crate) fn spawn_event_batcher<T: Send + 'static>(
    tsfn: napi::threadsafe_function::ThreadsafeFunction<
        Vec<T>,
        napi::threadsafe_function::ErrorStrategy::Fatal,
    >,
    max_batch: usize,
    flush_ms: u64,
) -> tokio::sync::mpsc::Sender<T> {
    let (tx, mut rx) = tokio::sync::mpsc::channel::<T>(512);
    RUNTIME.spawn(async move {
        let mut batch = Vec::with_capacity(max_batch);
        loop {
            if batch.is_empty() {
                match rx.recv().await {
                    Some(e) => batch.push(e),
                    None => break,
                }
            }
            let deadline = tokio::time::Instant::now()
                + tokio::time::Duration::from_millis(flush_ms);
            loop {
                if batch.len() >= max_batch {
                    break;
                }
                tokio::select! {
                    event = rx.recv() => {
                        match event {
                            Some(e) => batch.push(e),
                            None => {
                                let status = tsfn.call(
                                    std::mem::take(&mut batch),
                                    napi::threadsafe_function::ThreadsafeFunctionCallMode::NonBlocking,
                                );
                                report_tsfn_status("event batch", status);
                                return;
                            }
                        }
                    }
                    _ = tokio::time::sleep_until(deadline) => break,
                }
            }
            if !batch.is_empty() {
                let status = tsfn.call(
                    std::mem::take(&mut batch),
                    napi::threadsafe_function::ThreadsafeFunctionCallMode::NonBlocking,
                );
                report_tsfn_status("event batch", status);
                batch = Vec::with_capacity(max_batch);
            }
        }
        if !batch.is_empty() {
            let status = tsfn.call(
                batch,
                napi::threadsafe_function::ThreadsafeFunctionCallMode::NonBlocking,
            );
            report_tsfn_status("event batch", status);
        }
    });
    tx
}

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

/// Client pool metrics snapshot (hits, misses, evictions). For tests and observability.
#[napi]
pub fn client_pool_metrics_snapshot() -> metrics::ClientPoolMetricsSnapshot {
    let s = client_pool::pool_metrics_snapshot();
    metrics::ClientPoolMetricsSnapshot {
        hits: s.hits as u32,
        misses: s.misses as u32,
        evict_idle: s.evict_idle as u32,
        evict_broken: s.evict_broken as u32,
    }
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

/// Controls whether panic diagnostics include full panic payloads.
/// Default is false (redacted/minimal). Enable only for local debugging.
#[napi]
pub fn set_panic_log_verbose(enabled: bool) {
    panic_guard::set_panic_log_verbose(enabled);
}

/// Well-known close codes for stable error semantics (AGENTS.md).
pub(crate) const IDLE_TIMEOUT_CLOSE_CODE: u32 = 3990;
pub(crate) const RATE_LIMITED_CLOSE_CODE: u32 = 3991;
pub(crate) const LIMIT_EXCEEDED_CLOSE_CODE: u32 = 3992;

/// Extract (code, reason) from ConnectionError for CloseInfo.
pub(crate) fn extract_close_info(
    err: &wtransport::error::ConnectionError,
) -> (Option<u32>, Option<String>) {
    match err {
        wtransport::error::ConnectionError::ApplicationClosed(close) => {
            let code = close.code().into_inner() as u32;
            let reason_bytes = close.reason();
            let reason = if reason_bytes.is_empty() {
                None
            } else {
                Some(String::from_utf8_lossy(reason_bytes).to_string())
            };
            (Some(code), reason)
        }
        wtransport::error::ConnectionError::TimedOut => (
            Some(IDLE_TIMEOUT_CLOSE_CODE),
            Some("E_SESSION_IDLE_TIMEOUT".to_string()),
        ),
        _ => (None, None),
    }
}

/// Spawn the wtransport server loop on the dedicated runtime.
#[allow(clippy::too_many_arguments)]
pub(crate) fn spawn_wtransport_server(
    metrics: Arc<server_metrics::ServerMetrics>,
    limits: limits::Limits,
    rate_limits: rate_limit::RateLimits,
    host: String,
    port: u16,
    mut shutdown_rx: watch::Receiver<()>,
    session_tx: Option<tokio::sync::mpsc::Sender<SessionEvent>>,
    log_tx: Option<tokio::sync::mpsc::Sender<LogEvent>>,
    cert_pem: String,
    key_pem: String,
    debug_logs: bool,
    startup_tx: std::sync::mpsc::Sender<std::result::Result<(), String>>,
) {
    use std::sync::atomic::Ordering;
    use wtransport::{Endpoint, Identity, ServerConfig, VarInt};

    session_registry::set_limits(limits.clone());

    RATE_LIMIT_CLEANUP_ONCE.call_once(|| {
        RUNTIME.spawn(async {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(60));
            loop {
                interval.tick().await;
                rate_limit::cleanup_stale_entries(300.0);
            }
        });
    });

    RUNTIME.spawn(async move {
        panic_guard::spawn_quic_task(async move {
            let mut startup_tx = Some(startup_tx);
            let mut report_startup = |res: std::result::Result<(), String>| {
                send_startup_result(&mut startup_tx, res);
            };
            let identity = if !cert_pem.trim().is_empty() && !key_pem.trim().is_empty() {
                let mut cert_file = match tempfile::Builder::new()
                    .prefix("wt-cert-")
                    .suffix(".pem")
                    .tempfile()
                {
                    Ok(f) => f,
                    Err(e) => {
                        let msg = format!("failed to create temp cert file: {:?}", e);
                        emit_log(&log_tx, !debug_logs, "error", &msg, None, None, None);
                        report_startup(Err(msg));
                        return;
                    }
                };
                if let Err(msg) = write_and_flush_pem(&mut cert_file, &cert_pem, "cert") {
                    emit_log(&log_tx, !debug_logs, "error", &msg, None, None, None);
                    report_startup(Err(msg));
                    return;
                }
                let cert_path = cert_file.path().to_path_buf();
                let mut key_file = match tempfile::Builder::new()
                    .prefix("wt-key-")
                    .suffix(".pem")
                    .tempfile()
                {
                    Ok(f) => f,
                    Err(e) => {
                        let msg = format!("failed to create temp key file: {:?}", e);
                        emit_log(&log_tx, !debug_logs, "error", &msg, None, None, None);
                        report_startup(Err(msg));
                        return;
                    }
                };
                if let Err(msg) = write_and_flush_pem(&mut key_file, &key_pem, "key") {
                    emit_log(&log_tx, !debug_logs, "error", &msg, None, None, None);
                    report_startup(Err(msg));
                    return;
                }
                let key_path = key_file.path().to_path_buf();
                match Identity::load_pemfiles(&cert_path, &key_path).await {
                    Ok(i) => {
                        drop(cert_file);
                        drop(key_file);
                        i
                    }
                    Err(e) => {
                        let msg = format!("failed to load PEM identity: {:?}", e);
                        emit_log(&log_tx, !debug_logs, "error", &msg, None, None, None);
                        report_startup(Err(msg));
                        return;
                    }
                }
            } else {
                match Identity::self_signed(["localhost", "127.0.0.1", "::1"]) {
                    Ok(i) => i,
                    Err(e) => {
                        let msg = format!("failed to create identity: {:?}", e);
                        emit_log(&log_tx, !debug_logs, "error", &msg, None, None, None);
                        report_startup(Err(msg));
                        return;
                    }
                }
            };
            let bind_addr: std::net::SocketAddr = format!("{}:{}", host, port)
                .parse()
                .unwrap_or_else(|_| std::net::SocketAddr::from(([0, 0, 0, 0], port)));
            let config_builder = ServerConfig::builder()
                .with_bind_address(bind_addr)
                .with_identity(identity)
                .max_idle_timeout(Some(
                    std::time::Duration::from_millis(limits.idle_timeout_ms),
                ));
            let config = match config_builder {
                Ok(c) => c.build(),
                Err(e) => {
                    let msg = format!("failed to build server config: {:?}", e);
                    emit_log(&log_tx, !debug_logs, "error", &msg, None, None, None);
                    report_startup(Err(msg));
                    return;
                }
            };
            let server = match Endpoint::server(config) {
                Ok(s) => {
                    emit_log(&log_tx, !debug_logs, "info", &format!("endpoint created for port {}", port), None, None, None);
                    report_startup(Ok(()));
                    s
                }
                Err(e) => {
                    let msg = format!("failed to create endpoint: {:?}", e);
                    emit_log(&log_tx, !debug_logs, "error", &msg, None, None, None);
                    report_startup(Err(msg));
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
                        let rate_limits = rate_limits.clone();
                        let stx = session_tx.clone();
                        let ltx = log_tx.clone();
                        spawn_tracked::spawn_tracked(
                            metrics.clone(),
                            spawn_tracked::TaskKind::Session,
                            async move {
                                metrics.handshakes_in_flight.fetch_add(1, Ordering::Relaxed);
                                let session_request = match incoming_session.await {
                                    Ok(r) => {
                                        emit_log(&ltx, !debug_logs, "debug", &format!("CONNECT received authority={:?}", r.authority()), None, None, None);
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
                                        emit_log(&ltx, !debug_logs, "warn", &format!("handshake failed (incoming_session): {}", chain), None, None, None);
                                        return;
                                    }
                                };
                                if metrics.handshakes_in_flight.load(Ordering::Relaxed)
                                    > limits.max_handshakes_in_flight
                                {
                                    metrics.handshakes_in_flight.fetch_sub(1, Ordering::Relaxed);
                                    metrics.limit_exceeded_count.fetch_add(1, Ordering::Relaxed);
                                    emit_log(&ltx, !debug_logs, "warn", "limit exceeded: maxHandshakesInFlight", None, None, None);
                                    return;
                                }
                                let authority = session_request.authority().to_string();
                                let prev_sessions = metrics.sessions_active.fetch_add(1, Ordering::SeqCst);
                                if prev_sessions >= limits.max_sessions {
                                    metrics.sessions_active.fetch_sub(1, Ordering::SeqCst);
                                    metrics.limit_exceeded_count.fetch_add(1, Ordering::Relaxed);
                                    emit_log(&ltx, !debug_logs, "warn", "limit exceeded: maxSessions", None, None, None);
                                    let reject_timeout = tokio::time::Duration::from_millis(
                                        limits.handshake_timeout_ms,
                                    );
                                    let reject_result = tokio::time::timeout(
                                        reject_timeout,
                                        session_request.accept(),
                                    )
                                    .await;
                                    metrics.handshakes_in_flight.fetch_sub(1, Ordering::Relaxed);
                                    match reject_result {
                                        Ok(Ok(connection)) => {
                                            connection.close(
                                                VarInt::from_u32(LIMIT_EXCEEDED_CLOSE_CODE),
                                                b"E_LIMIT_EXCEEDED",
                                            );
                                        }
                                        Ok(Err(e)) => {
                                            emit_log(
                                                &ltx,
                                                !debug_logs,
                                                "debug",
                                                &format!(
                                                    "maxSessions reject accept failed authority={:?} error={}",
                                                    authority, e
                                                ),
                                                None,
                                                None,
                                                None,
                                            );
                                        }
                                        Err(_elapsed) => {
                                            emit_log(
                                                &ltx,
                                                !debug_logs,
                                                "warn",
                                                &format!(
                                                    "maxSessions reject handshake timed out authority={:?}",
                                                    authority
                                                ),
                                                None,
                                                None,
                                                None,
                                            );
                                        }
                                    }
                                    return;
                                }
                                let accept_timeout = tokio::time::Duration::from_millis(
                                    limits.handshake_timeout_ms,
                                );
                                let accept_start = std::time::Instant::now();
                                let accept_result = tokio::time::timeout(
                                    accept_timeout,
                                    session_request.accept(),
                                )
                                .await;
                                let accept_result = match accept_result {
                                    Ok(r) => r,
                                    Err(_elapsed) => {
                                        metrics.sessions_active.fetch_sub(1, Ordering::SeqCst);
                                        metrics.handshakes_in_flight.fetch_sub(1, Ordering::Relaxed);
                                        emit_log(&ltx, !debug_logs, "warn", &format!("handshake timed out authority={:?}", authority), None, None, None);
                                        return;
                                    }
                                };
                                match accept_result {
                                    Ok(connection) => {
                                        metrics.handshake_histogram.observe(accept_start.elapsed());
                                        let peer_ip = connection.remote_address().ip().to_string();
                                        let peer_port = connection.remote_address().port() as u32;
                                        emit_log(&ltx, !debug_logs, "info", &format!("session accepted peer={}:{} authority={:?}", peer_ip, peer_port, authority), None, Some(&peer_ip), Some(peer_port));
                                        if !rate_limit::try_acquire_handshake(
                                            &peer_ip,
                                            rate_limits.handshakes_per_sec,
                                            rate_limits.handshakes_burst,
                                        ) {
                                            metrics.sessions_active.fetch_sub(1, Ordering::SeqCst);
                                            metrics.handshakes_in_flight.fetch_sub(1, Ordering::Relaxed);
                                            metrics.rate_limited_count.fetch_add(1, Ordering::Relaxed);
                                            emit_log(&ltx, !debug_logs, "warn", "rate limited: handshake token bucket", None, Some(&peer_ip), Some(peer_port));
                                            connection.close(VarInt::from_u32(RATE_LIMITED_CLOSE_CODE), b"E_RATE_LIMITED");
                                            return;
                                        }
                                        if !rate_limit::try_acquire_per_ip_session_with_prefix(
                                            &peer_ip,
                                            rate_limits.handshakes_burst_per_ip,
                                            rate_limits.handshakes_burst_per_prefix,
                                        ) {
                                            metrics.sessions_active.fetch_sub(1, Ordering::SeqCst);
                                            metrics.handshakes_in_flight.fetch_sub(1, Ordering::Relaxed);
                                            metrics.rate_limited_count.fetch_add(1, Ordering::Relaxed);
                                            emit_log(&ltx, !debug_logs, "warn", "rate limited: per-IP handshake burst", None, Some(&peer_ip), Some(peer_port));
                                            connection.close(VarInt::from_u32(RATE_LIMITED_CLOSE_CODE), b"E_RATE_LIMITED");
                                            return;
                                        }
                                        metrics.handshakes_in_flight.fetch_sub(1, Ordering::Relaxed);

                                        let id = format!(
                                            "sess-{}",
                                            SESSION_ID_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
                                        );

                                        // P0-1: Register session BEFORE emitting to JS so acceptBidiStream etc. find it
                                        let (dgram_tx, bidi_accept_tx, uni_accept_tx, create_bi_rx, create_uni_rx, session_metrics) =
                                            session_registry::insert(
                                                id.clone(),
                                                connection.clone(),
                                                metrics.clone(),
                                            );

                                        if let Some(ref tx) = stx {
                                            if tx
                                                .try_send(SessionEvent::Accepted(SessionAccepted {
                                                    id: id.clone(),
                                                    peer_ip: peer_ip.clone(),
                                                    peer_port,
                                                }))
                                                .is_err()
                                            {
                                                eprintln!(
                                                    "webtransport-native: session accepted event dropped for id={}",
                                                    id
                                                );
                                            }
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
                                        let sm_bidi = Arc::clone(&session_metrics);
                                        let sm_uni = Arc::clone(&session_metrics);
                                        let sm_dgram = Arc::clone(&session_metrics);

                                        // Bidi stream accept loop: forward to JS via channel (4.4.2: shed if over limits)
                                        let peer_ip_bidi = peer_ip.clone();
                                        let rl_bidi = rate_limits.clone();
                                        spawn_tracked::spawn_tracked(
                                            m_bidi.clone(),
                                            spawn_tracked::TaskKind::Stream,
                                            async move {
                                                loop {
                                                    tokio::select! {
                                                        _ = conn_bidi.closed() => break,
                                                        res = conn_bidi.accept_bi() => {
                                                            let Ok((mut send, recv)) = res else { break };
                                                            if !rate_limit::try_acquire_stream_open(&peer_ip_bidi, rl_bidi.streams_per_sec, rl_bidi.streams_burst) {
                                                                m_bidi.rate_limited_count.fetch_add(1, Ordering::Relaxed);
                                                                let _ = send.reset(0u32.into());
                                                                continue;
                                                            }
                                                            if m_bidi.streams_active.load(Ordering::Relaxed) >= lim_bidi.max_streams_global {
                                                                m_bidi.limit_exceeded_count.fetch_add(1, Ordering::Relaxed);
                                                                let _ = send.reset(0u32.into());
                                                                continue;
                                                            }
                                                            if sm_bidi.streams_bidi_active.load(Ordering::Relaxed) >= lim_bidi.max_streams_per_session_bidi {
                                                                m_bidi.limit_exceeded_count.fetch_add(1, Ordering::Relaxed);
                                                                let _ = send.reset(0u32.into());
                                                                continue;
                                                            }
                                                            m_bidi.streams_active.fetch_add(1, Ordering::Relaxed);
                                                            sm_bidi.streams_bidi_active.fetch_add(1, Ordering::Relaxed);
                                                            let guard_m = Arc::clone(&m_bidi);
                                                            let guard_sm = Arc::clone(&sm_bidi);
                                                            let guard = crate::client_stream::StreamGuard::new(move || {
                                                                guard_m.streams_active.fetch_sub(1, Ordering::Relaxed);
                                                                guard_sm.streams_bidi_active.fetch_sub(1, Ordering::Relaxed);
                                                            });
                                                            let stream_queued = Arc::new(AtomicU64::new(0));
                                                            let budget = crate::client_stream::StreamBudget {
                                                                server_metrics: Arc::clone(&m_bidi),
                                                                session_metrics: Arc::clone(&sm_bidi),
                                                                stream_queued: Arc::clone(&stream_queued),
                                                                max_global: lim_bidi.max_queued_bytes_global,
                                                                max_session: lim_bidi.max_queued_bytes_per_session,
                                                                max_stream: lim_bidi.max_queued_bytes_per_stream,
                                                            };
                                                            let (read_rx, write_tx, stop_tx, write_err_slot, read_err_slot) = crate::client_stream::spawn_bidi_bridge(send, recv, Some(guard), Some(budget.clone()));
                                                            let handle = crate::client_stream::ClientBidiStreamHandle::new_with_budget_and_slot(read_rx, write_tx, stop_tx, Some(budget), write_err_slot, read_err_slot);
                                                            if bidi_accept_tx.send(handle).await.is_err() {
                                                                report_channel_closed("bidi accept");
                                                                break;
                                                            }
                                                        }
                                                    }
                                                }
                                            },
                                        );
                                        // Uni stream accept loop: forward to JS via channel (4.4.2; P1-5)
                                        let peer_ip_uni = peer_ip.clone();
                                        let rl_uni = rate_limits.clone();
                                        spawn_tracked::spawn_tracked(
                                            m_uni.clone(),
                                            spawn_tracked::TaskKind::Stream,
                                            async move {
                                                loop {
                                                    tokio::select! {
                                                        _ = conn_uni.closed() => break,
                                                        res = conn_uni.accept_uni() => {
                                                            let Ok(recv) = res else { break };
                                                            if !rate_limit::try_acquire_stream_open(&peer_ip_uni, rl_uni.streams_per_sec, rl_uni.streams_burst) {
                                                                m_uni.rate_limited_count.fetch_add(1, Ordering::Relaxed);
                                                                recv.stop(0u32.into());
                                                                continue;
                                                            }
                                                            if m_uni.streams_active.load(Ordering::Relaxed) >= lim_uni.max_streams_global {
                                                                m_uni.limit_exceeded_count.fetch_add(1, Ordering::Relaxed);
                                                                recv.stop(0u32.into());
                                                                continue;
                                                            }
                                                            if sm_uni.streams_uni_active.load(Ordering::Relaxed) >= lim_uni.max_streams_per_session_uni {
                                                                m_uni.limit_exceeded_count.fetch_add(1, Ordering::Relaxed);
                                                                recv.stop(0u32.into());
                                                                continue;
                                                            }
                                                            m_uni.streams_active.fetch_add(1, Ordering::Relaxed);
                                                            sm_uni.streams_uni_active.fetch_add(1, Ordering::Relaxed);
                                                            let guard_m = Arc::clone(&m_uni);
                                                            let guard_sm = Arc::clone(&sm_uni);
                                                            let guard = crate::client_stream::StreamGuard::new(move || {
                                                                guard_m.streams_active.fetch_sub(1, Ordering::Relaxed);
                                                                guard_sm.streams_uni_active.fetch_sub(1, Ordering::Relaxed);
                                                            });
                                                            let stream_queued = Arc::new(AtomicU64::new(0));
                                                            let budget = crate::client_stream::StreamBudget {
                                                                server_metrics: Arc::clone(&m_uni),
                                                                session_metrics: Arc::clone(&sm_uni),
                                                                stream_queued: Arc::clone(&stream_queued),
                                                                max_global: lim_uni.max_queued_bytes_global,
                                                                max_session: lim_uni.max_queued_bytes_per_session,
                                                                max_stream: lim_uni.max_queued_bytes_per_stream,
                                                            };
                                                            let (read_rx, stop_tx, read_err_slot) = crate::client_stream::spawn_uni_recv_bridge(recv, Some(guard), Some(budget.clone()));
                                                            let handle = crate::client_stream::ClientUniRecvHandle::new_with_budget_and_slot(read_rx, stop_tx, Some(budget), read_err_slot);
                                                            if uni_accept_tx.send(handle).await.is_err() {
                                                                report_channel_closed("uni accept");
                                                                break;
                                                            }
                                                        }
                                                    }
                                                }
                                            },
                                        );
                                        // Create-bidi handler: respond to SessionHandle.create_bidi_stream
                                        let conn_create_bi = connection.clone();
                                        let m_create_bi = Arc::clone(&metrics);
                                        let sm_create_bi = Arc::clone(&session_metrics);
                                        let lim_create_bi = limits.clone();
                                        spawn_tracked::spawn_tracked(
                                            m_create_bi.clone(),
                                            spawn_tracked::TaskKind::Stream,
                                            async move {
                                                let mut rx = create_bi_rx;
                                                while let Some(resp_tx) = rx.recv().await {
                                                    if m_create_bi.streams_active.load(Ordering::Relaxed) >= lim_create_bi.max_streams_global {
                                                        m_create_bi.limit_exceeded_count.fetch_add(1, Ordering::Relaxed);
                                                        if resp_tx.send(Err("E_LIMIT_EXCEEDED".to_string())).is_err() {
                                                            report_channel_failure("create_bidi response");
                                                        }
                                                        continue;
                                                    }
                                                    if sm_create_bi.streams_bidi_active.load(Ordering::Relaxed) >= lim_create_bi.max_streams_per_session_bidi {
                                                        m_create_bi.limit_exceeded_count.fetch_add(1, Ordering::Relaxed);
                                                        if resp_tx.send(Err("E_LIMIT_EXCEEDED".to_string())).is_err() {
                                                            report_channel_failure("create_bidi response");
                                                        }
                                                        continue;
                                                    }
                                                    let r = match conn_create_bi.open_bi().await {
                                                        Ok(opening) => match opening.await {
                                                            Ok((send, recv)) => {
                                                                m_create_bi.streams_active.fetch_add(1, Ordering::Relaxed);
                                                                sm_create_bi.streams_bidi_active.fetch_add(1, Ordering::Relaxed);
                                                                let guard_m = Arc::clone(&m_create_bi);
                                                                let guard_sm = Arc::clone(&sm_create_bi);
                                                                let guard = crate::client_stream::StreamGuard::new(move || {
                                                                    guard_m.streams_active.fetch_sub(1, Ordering::Relaxed);
                                                                    guard_sm.streams_bidi_active.fetch_sub(1, Ordering::Relaxed);
                                                                });
                                                                let stream_queued = Arc::new(AtomicU64::new(0));
                                                                let budget = crate::client_stream::StreamBudget {
                                                                    server_metrics: Arc::clone(&m_create_bi),
                                                                    session_metrics: Arc::clone(&sm_create_bi),
                                                                    stream_queued: Arc::clone(&stream_queued),
                                                                    max_global: lim_create_bi.max_queued_bytes_global,
                                                                    max_session: lim_create_bi.max_queued_bytes_per_session,
                                                                    max_stream: lim_create_bi.max_queued_bytes_per_stream,
                                                                };
                                                                let (read_rx, write_tx, stop_tx, write_err_slot, read_err_slot) =
                                                                    crate::client_stream::spawn_bidi_bridge(send, recv, Some(guard), Some(budget.clone()));
                                                                Ok(crate::client_stream::ClientBidiStreamHandle::new_with_budget_and_slot(
                                                                    read_rx, write_tx, stop_tx, Some(budget), write_err_slot, read_err_slot,
                                                                ))
                                                            }
                                                            Err(e) => Err(e.to_string()),
                                                        },
                                                        Err(e) => Err(e.to_string()),
                                                    };
                                                    if resp_tx.send(r).is_err() {
                                                        report_channel_failure("create_bidi response");
                                                    }
                                                }
                                            },
                                        );
                                        // Create-uni handler: respond to SessionHandle.create_uni_stream
                                        let conn_create_uni = connection.clone();
                                        let m_create_uni = Arc::clone(&metrics);
                                        let sm_create_uni = Arc::clone(&session_metrics);
                                        let lim_create_uni = limits.clone();
                                        spawn_tracked::spawn_tracked(
                                            m_create_uni.clone(),
                                            spawn_tracked::TaskKind::Stream,
                                            async move {
                                                let mut rx = create_uni_rx;
                                                while let Some(resp_tx) = rx.recv().await {
                                                    if m_create_uni.streams_active.load(Ordering::Relaxed) >= lim_create_uni.max_streams_global {
                                                        m_create_uni.limit_exceeded_count.fetch_add(1, Ordering::Relaxed);
                                                        if resp_tx.send(Err("E_LIMIT_EXCEEDED".to_string())).is_err() {
                                                            report_channel_failure("create_uni response");
                                                        }
                                                        continue;
                                                    }
                                                    if sm_create_uni.streams_uni_active.load(Ordering::Relaxed) >= lim_create_uni.max_streams_per_session_uni {
                                                        m_create_uni.limit_exceeded_count.fetch_add(1, Ordering::Relaxed);
                                                        if resp_tx.send(Err("E_LIMIT_EXCEEDED".to_string())).is_err() {
                                                            report_channel_failure("create_uni response");
                                                        }
                                                        continue;
                                                    }
                                                    match conn_create_uni.open_uni().await {
                                                        Ok(opening) => {
                                                            match opening.await {
                                                                Ok(send) => {
                                                                    m_create_uni.streams_active.fetch_add(1, Ordering::Relaxed);
                                                                    sm_create_uni.streams_uni_active.fetch_add(1, Ordering::Relaxed);
                                                                    let guard_m = Arc::clone(&m_create_uni);
                                                                    let guard_sm = Arc::clone(&sm_create_uni);
                                                                    let guard = crate::client_stream::StreamGuard::new(move || {
                                                                        guard_m.streams_active.fetch_sub(1, Ordering::Relaxed);
                                                                        guard_sm.streams_uni_active.fetch_sub(1, Ordering::Relaxed);
                                                                    });
                                                                    let stream_queued = Arc::new(AtomicU64::new(0));
                                                                    let budget = crate::client_stream::StreamBudget {
                                                                        server_metrics: Arc::clone(&m_create_uni),
                                                                        session_metrics: Arc::clone(&sm_create_uni),
                                                                        stream_queued: Arc::clone(&stream_queued),
                                                                        max_global: lim_create_uni.max_queued_bytes_global,
                                                                        max_session: lim_create_uni.max_queued_bytes_per_session,
                                                                        max_stream: lim_create_uni.max_queued_bytes_per_stream,
                                                                    };
                                                                    let (write_tx, write_err_slot) = crate::client_stream::spawn_uni_send_bridge(send, Some(guard), Some(budget.clone()));
                                                                    let handle = crate::client_stream::ClientUniSendHandle::new_with_budget_and_slot(write_tx, Some(budget), write_err_slot);
                                                                    if resp_tx.send(Ok(handle)).is_err() {
                                                                        report_channel_failure("create_uni response");
                                                                    }
                                                                }
                                                                Err(e) => {
                                                                    if resp_tx.send(Err(e.to_string())).is_err() {
                                                                        report_channel_failure("create_uni response");
                                                                    }
                                                                }
                                                            }
                                                        }
                                                        Err(e) => {
                                                            if resp_tx.send(Err(e.to_string())).is_err() {
                                                                report_channel_failure("create_uni response");
                                                            }
                                                        }
                                                    }
                                                }
                                            },
                                        );
                                        // Datagram forward to channel (4.4.3: drop if over max_datagram_size; 4.3.2: budget)
                                        let closed_tx = stx.clone();
                                        let rl_dgram = rate_limits.clone();
                                        let peer_ip_for_release = peer_ip.clone();
                                        spawn_tracked::spawn_tracked(
                                            m_dgram.clone(),
                                            spawn_tracked::TaskKind::Stream,
                                            async move {
                                                loop {
                                                    tokio::select! {
                                                        biased;
                                                        res = conn_dgram.receive_datagram() => {
                                                            let dgram = match res {
                                                                Ok(d) => d,
                                                                Err(close_err) => {
                                                                    let (mut close_code, mut close_reason) = extract_close_info(&close_err);
                                                                    if close_code.is_none() && close_reason.is_none() {
                                                                        let (code2, reason2) = extract_close_info(&conn_dgram.closed().await);
                                                                        close_code = code2;
                                                                        close_reason = reason2;
                                                                    }
                                                                    session_registry::remove(&id);
                                                                    rate_limit::release_per_ip_session(&peer_ip_for_release);
                                                                    m_dgram.sessions_active.fetch_sub(1, Ordering::Relaxed);
                                                                    if let Some(ref tx) = closed_tx {
                                                                        if tx
                                                                            .try_send(SessionEvent::Closed { id: id.clone(), code: close_code, reason: close_reason })
                                                                            .is_err()
                                                                        {
                                                                            eprintln!(
                                                                                "webtransport-native: session closed event dropped for id={}",
                                                                                id
                                                                            );
                                                                        }
                                                                    }
                                                                    return;
                                                                }
                                                            };
                                                            m_dgram.datagrams_in.fetch_add(1, Ordering::Relaxed);
                                                            sm_dgram.datagrams_in.fetch_add(1, Ordering::Relaxed);
                                                            if !rate_limit::try_acquire_datagram_ingress(&peer_ip_for_release, rl_dgram.datagrams_per_sec, rl_dgram.datagrams_burst) {
                                                                m_dgram.rate_limited_count.fetch_add(1, Ordering::Relaxed);
                                                                m_dgram.datagrams_dropped.fetch_add(1, Ordering::Relaxed);
                                                                continue;
                                                            }
                                                            if dgram.len() > lim_dgram.max_datagram_size {
                                                                m_dgram.datagrams_dropped.fetch_add(1, Ordering::Relaxed);
                                                                continue;
                                                            }
                                                            let sz = dgram.len() as u64;
                                                            if !m_dgram.try_reserve_queued_bytes_with_session(
                                                                &sm_dgram.queued_bytes,
                                                                sz,
                                                                lim_dgram.max_queued_bytes_global,
                                                                lim_dgram.max_queued_bytes_per_session,
                                                            ) {
                                                                m_dgram.datagrams_dropped.fetch_add(1, Ordering::Relaxed);
                                                                continue;
                                                            }
                                                            let payload = dgram.as_ref().to_vec();
                                                            if dgram_tx.send(payload).await.is_err() {
                                                                crate::server_metrics::ServerMetrics::release_session_queued_bytes(
                                                                    &sm_dgram.queued_bytes,
                                                                    &m_dgram,
                                                                    sz,
                                                                );
                                                                break;
                                                            }
                                                        }
                                                        close_err = conn_dgram.closed() => {
                                                            let (mut close_code, mut close_reason) = extract_close_info(&close_err);
                                                            // Prefer driver-level close details when available:
                                                            // conn.closed() can resolve first with transport-level no-error
                                                            // while receive_datagram() still carries ApplicationClosed(code, reason).
                                                            if close_code.is_none() && close_reason.is_none() {
                                                                if let Ok(Err(driver_close_err)) = tokio::time::timeout(
                                                                    std::time::Duration::from_millis(50),
                                                                    conn_dgram.receive_datagram(),
                                                                )
                                                                .await
                                                                {
                                                                    let (code2, reason2) = extract_close_info(&driver_close_err);
                                                                    close_code = code2;
                                                                    close_reason = reason2;
                                                                }
                                                            }
                                                            session_registry::remove(&id);
                                                            rate_limit::release_per_ip_session(&peer_ip_for_release);
                                                            m_dgram.sessions_active.fetch_sub(1, Ordering::Relaxed);
                                                            if let Some(ref tx) = closed_tx {
                                                                if tx
                                                                    .try_send(SessionEvent::Closed { id: id.clone(), code: close_code, reason: close_reason })
                                                                    .is_err()
                                                                {
                                                                    eprintln!(
                                                                        "webtransport-native: session closed event dropped for id={}",
                                                                        id
                                                                    );
                                                                }
                                                            }
                                                            return;
                                                        }
                                                    }
                                                }
                                                session_registry::remove(&id);
                                                rate_limit::release_per_ip_session(&peer_ip_for_release);
                                                m_dgram.sessions_active.fetch_sub(1, Ordering::Relaxed);
                                                if let Some(ref tx) = closed_tx {
                                                    if tx
                                                        .try_send(SessionEvent::Closed { id: id.clone(), code: None, reason: None })
                                                        .is_err()
                                                    {
                                                        eprintln!(
                                                            "webtransport-native: terminal session event dropped for id={}",
                                                            id
                                                        );
                                                    }
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
                                        emit_log(&ltx, !debug_logs, "error", &format!("session accept failed authority={:?} error={}", authority, chain), None, None, None);
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

#[cfg(test)]
mod tests {
    use super::{report_channel_failure, send_startup_result, CHANNEL_DELIVERY_FAILURE_COUNT};
    use super::{report_tsfn_status, write_and_flush_pem, TSFN_DELIVERY_FAILURE_COUNT};
    use std::sync::atomic::Ordering;

    struct FailWriter;

    impl std::io::Write for FailWriter {
        fn write(&mut self, _buf: &[u8]) -> std::io::Result<usize> {
            Err(std::io::Error::other("boom"))
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    struct FlushFailWriter {
        buffer: Vec<u8>,
    }

    impl std::io::Write for FlushFailWriter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.buffer.extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Err(std::io::Error::other("flush-fail"))
        }
    }

    #[test]
    fn write_and_flush_pem_reports_write_failure() {
        let mut writer = FailWriter;
        let err =
            write_and_flush_pem(&mut writer, "abc", "cert").expect_err("expected write failure");
        assert!(err.contains("failed to write temp cert file"));
    }

    #[test]
    fn write_and_flush_pem_reports_flush_failure() {
        let mut writer = FlushFailWriter { buffer: Vec::new() };
        let err =
            write_and_flush_pem(&mut writer, "abc", "key").expect_err("expected flush failure");
        assert!(err.contains("failed to flush temp key file"));
    }

    #[test]
    fn report_tsfn_status_counts_failures_only() {
        TSFN_DELIVERY_FAILURE_COUNT.store(0, Ordering::Relaxed);
        report_tsfn_status("test", napi::Status::Ok);
        assert_eq!(TSFN_DELIVERY_FAILURE_COUNT.load(Ordering::Relaxed), 0);
        report_tsfn_status("test", napi::Status::QueueFull);
        assert_eq!(TSFN_DELIVERY_FAILURE_COUNT.load(Ordering::Relaxed), 1);
        report_tsfn_status("test", napi::Status::Closing);
        assert_eq!(TSFN_DELIVERY_FAILURE_COUNT.load(Ordering::Relaxed), 2);
    }

    #[test]
    fn report_channel_failure_counts_failures() {
        CHANNEL_DELIVERY_FAILURE_COUNT.store(0, Ordering::Relaxed);
        report_channel_failure("test");
        assert_eq!(CHANNEL_DELIVERY_FAILURE_COUNT.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn send_startup_result_handles_disconnected_receiver() {
        CHANNEL_DELIVERY_FAILURE_COUNT.store(0, Ordering::Relaxed);
        let (tx, rx) = std::sync::mpsc::channel::<std::result::Result<(), String>>();
        drop(rx);
        let mut opt = Some(tx);
        send_startup_result(&mut opt, Err("boom".to_string()));
        assert!(opt.is_none());
        assert_eq!(CHANNEL_DELIVERY_FAILURE_COUNT.load(Ordering::Relaxed), 1);
    }
}
