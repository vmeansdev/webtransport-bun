//! WebTransport native addon for Bun (napi-rs).
//!
//! This is the Rust side of the webtransport-bun project.
//! It owns a dedicated Tokio runtime thread and communicates
//! with JS via bounded channels + ThreadsafeFunction.

use crate::error::from_upstream_error as wt_from_upstream_error;
use napi_derive::napi;

/// Route this dylib's Rust allocations through mimalloc. The macOS system
/// malloc keeps freed small-zone pages resident forever (pressure relief is a
/// measured no-op on macOS 26), so transport/session churn left
/// load-proportional RSS behind after fully drained closes. mimalloc purges
/// freed pages back to the OS within its purge delay, letting post-close RSS
/// actually recover. See crates/native/src/native_memory.rs for the recorded
/// diagnosis.
#[global_allocator]
static GLOBAL_ALLOCATOR: mimalloc::MiMalloc = mimalloc::MiMalloc;
use once_cell::sync::Lazy;
use std::sync::atomic::AtomicU64;
use std::sync::Arc;
use tokio::runtime::Runtime;
use tokio::sync::watch;

pub mod client;
pub mod client_pool;
pub mod client_stream;
pub mod error;
pub mod histogram;
pub mod limits;
pub mod metrics;
pub mod native_memory;
pub mod panic_guard;
pub mod payload_buffer;
pub mod rate_limit;
pub mod server;
pub mod server_metrics;
pub mod server_napi;
pub mod server_spawn;
pub mod server_tls;
pub mod session;
pub mod session_napi;
pub mod session_registry;
pub mod spawn_tracked;
pub mod transport_memory;
pub mod zero_rtt;

// ---------------------------------------------------------------------------
// Global Tokio runtime singleton
// ---------------------------------------------------------------------------

/// Server runtime: drives the WebTransport server and all server-side stream bridges.
///
/// Two workers, not one. The ~5,300/s delivery cliff was tokio's injection
/// queue: per-datagram N-API methods used to `RUNTIME.spawn` from outside this
/// runtime, and a busy worker only drains that queue one task per ~200µs of
/// work. Those hops are gone (`read_datagram`, `send_datagram`,
/// `discard_datagram`); hop removal is the cliff fix, two workers is leftover
/// headroom. After hops-gone, two workers at 80k offered delivered with 0% JS
/// drop on the Linux heavy runner (run 31951922171). The leftover drop% at
/// 160k offered on that host is not injection-queue starvation: delivery is
/// not pinned near 5,300/s, and datagram rate-limit is not the binder.
/// Ingest drop reasons are counted separately so a later artifact can name
/// session queue vs global queue vs size. Higher worker counts measured worse
/// (macOS: 89k/s at two, 82k/s at four, 48k/s at ten), so this is a fixed
/// constant rather than `available_parallelism()`, and
/// `scripts/check-doc-truth.ts` pins it.
pub(crate) static RUNTIME: Lazy<Runtime> = Lazy::new(|| {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
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
///
/// Stays at one worker: the starvation measurements covered the server receive
/// path only, and nothing in them says anything about the client. Raising this
/// for symmetry would be an unmeasured change.
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
static SESSION_ID_SEED: Lazy<u64> = Lazy::new(|| {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut h = DefaultHasher::new();
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
        .hash(&mut h);
    std::process::id().hash(&mut h);
    h.finish()
});
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

/// How many accepted streams may be black-hole drained at once, per session
/// and direction. Draining inline in the accept loop lets one stalled peer
/// stream block acceptance of every stream behind it, so each drain runs as its
/// own tracked task; this bound keeps the number of streams actively reading
/// (and holding quinn chunk buffers) small. Streams past the bound sit idle and
/// apply QUIC backpressure until a permit frees up. Task count itself is
/// already bounded by the per-session and global stream caps checked before the
/// spawn.
const DISCARD_DRAIN_CONCURRENCY: usize = 16;

/// Wall-clock bound for one black-hole drain once it holds a permit. The N-API
/// caller only polls the cumulative completion counter against its own
/// deadline, so nothing else would ever release the permit held by a peer that
/// opens a stream and then stops sending. On expiry the receive stream is
/// dropped, which makes quinn send STOP_SENDING, and the stream is left
/// uncounted — the existing "discarded but incomplete" outcome.
const DISCARD_DRAIN_STREAM_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// Run one black-hole drain under the concurrency bound and a per-stream
/// deadline. Kept separate from the accept loops so the permit and timeout
/// behaviour is testable without a live QUIC session.
async fn run_bounded_discard<F>(
    permits: Arc<tokio::sync::Semaphore>,
    discard: session_registry::StreamDiscardState,
    timeout: std::time::Duration,
    drain: F,
) where
    F: std::future::Future<Output = std::result::Result<(), String>>,
{
    let Ok(_permit) = permits.acquire().await else {
        return;
    };
    // Start the deadline once the permit is held: a stream should not be
    // charged for the time it spent queued behind other drains.
    let deadline = tokio::time::Instant::now() + timeout;
    if let Ok(result) = tokio::time::timeout_at(deadline, drain).await {
        discard.record_direct(result);
    }
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
    startup_tx: &mut Option<std::sync::mpsc::Sender<std::result::Result<u16, String>>>,
    res: std::result::Result<u16, String>,
) {
    if let Some(tx) = startup_tx.take() {
        if tx.send(res).is_err() {
            report_channel_failure("startup result");
        }
    }
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

/// Client pool metrics snapshot (hits, misses, evictions), for observability.
/// Wrapped in `catch_panic` like every other `#[napi]` export: a panic (e.g. a
/// poisoned pool mutex) must not unwind across the FFI boundary (UB).
#[napi]
pub fn client_pool_metrics_snapshot() -> napi::Result<metrics::ClientPoolMetricsSnapshot> {
    panic_guard::catch_panic(|| {
        let s = client_pool::pool_metrics_snapshot();
        Ok(metrics::ClientPoolMetricsSnapshot {
            hits: s.hits as u32,
            misses: s.misses as u32,
            evict_idle: s.evict_idle as u32,
            evict_broken: s.evict_broken as u32,
        })
    })
}

/// Returns the server runtime's worker-thread count, read from the live runtime
/// rather than restated as a literal, so callers observe what was actually
/// built. Expected to be 2; see the `RUNTIME` constructor.
#[napi]
pub fn runtime_worker_count() -> u32 {
    panic_guard::catch_panic(|| Ok(RUNTIME.metrics().num_workers() as u32)).unwrap_or(0)
}

/// Read process-wide native stream-handle ownership without retaining a
/// ServerHandle. The release harness uses this after dropping JS server
/// closures so finalizer timing cannot make the post-close sample stale.
#[napi]
pub fn native_stream_handles_snapshot() -> metrics::NativeStreamHandlesSnapshot {
    let (bidi, uni_send, uni_recv) = client_stream::live_native_stream_handles();
    metrics::NativeStreamHandlesSnapshot {
        bidi_handles_live: bidi as u32,
        uni_send_handles_live: uni_send as u32,
        uni_recv_handles_live: uni_recv as u32,
    }
}

/// Which delivery path payloads actually took this process: `"arraybuffer"`
/// (default) or `"buffer-copy"` (the `WEBTRANSPORT_PAYLOAD_DELIVERY` escape
/// hatch). Read-only — it reports the already-resolved decision and neither
/// rereads nor mutates the environment, so it can never disagree with the
/// conversion that payloads are getting.
#[napi]
pub fn native_payload_delivery_mode() -> &'static str {
    payload_buffer::payload_delivery_mode().as_str()
}

/// The inclusive payload size at or below which delivery stays engine-owned.
/// Larger payloads take the accounted external handover. Diagnostic only.
#[napi]
pub fn native_payload_engine_owned_max_bytes() -> f64 {
    payload_buffer::ENGINE_OWNED_MAX_BYTES as f64
}

/// Internal test seam: materialize a batch of payloads through napi-rs's real
/// per-element array conversion, so the branch a batch delivery takes is the
/// branch under test. It copies its input and hands back `PayloadBuffer`s; it
/// reimplements neither materialization nor accounting, and no production
/// session path calls it.
#[napi]
pub fn materialize_payload_batch_for_tests(
    payloads: Vec<napi::bindgen_prelude::Buffer>,
) -> Vec<payload_buffer::PayloadBuffer> {
    payloads
        .into_iter()
        .map(|buffer| payload_buffer::PayloadBuffer::from(buffer.as_ref().to_vec()))
        .collect()
}

/// Controls whether panic diagnostics include full panic payloads.
/// Default is false (redacted/minimal). Enable only for local debugging.
#[napi]
pub fn set_panic_log_verbose(enabled: bool) {
    panic_guard::set_panic_log_verbose(enabled);
}

/// Force-return freed native allocator memory to the OS.
///
/// mimalloc heaps are per-thread, so the collection runs on the calling
/// thread and is dispatched onto both long-lived runtime threads (each wait
/// bounded to 500 ms; an idle runtime cannot hang the caller). Intended for
/// long-lived servers after load spikes and for the release memory evidence
/// after drain + GC; it is never required for correctness.
/// Leak-forensics: how many futures are currently parked inside each
/// instrumented await (see client_stream::await_probe). Diagnostic only.
#[napi]
pub fn native_await_probe_snapshot() -> std::collections::HashMap<String, i64> {
    client_stream::await_probe::snapshot()
        .into_iter()
        .map(|(name, value)| (name.to_string(), value))
        .collect()
}

#[napi]
pub fn release_native_memory() -> bool {
    panic_guard::catch_panic(|| {
        let relief = native_memory::release_drained_residency(true);
        for rt in [&*RUNTIME, &*CLIENT_RUNTIME] {
            let (tx, rx) = std::sync::mpsc::sync_channel::<()>(1);
            rt.spawn(async move {
                native_memory::release_drained_residency(true);
                let _ = tx.send(());
            });
            let _ = rx.recv_timeout(std::time::Duration::from_millis(500));
        }
        Ok(relief.applied)
    })
    .unwrap_or(false)
}

/// Well-known close codes for stable error semantics (AGENTS.md).
pub(crate) const IDLE_TIMEOUT_CLOSE_CODE: u32 = 3990;
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

/// Close details for a session whose peer ended it, which `closed()` cannot give.
///
/// A peer that ends a session sends a `CLOSE_WEBTRANSPORT_SESSION` capsule and
/// only then closes the QUIC connection, with `H3_NO_ERROR` — a code about the
/// transport that says nothing about the session. The capsule's code and reason
/// reach us on the session operations instead, so ask one of those and fall back
/// to the transport error for every other way a connection can end.
///
/// Bounded: on an already-closed connection the operation returns its error
/// immediately, and the deadline only caps the case where datagrams the peer
/// sent before closing are still queued ahead of it.
pub(crate) async fn resolve_close_info(
    conn: &wtransport::Connection,
    transport_err: &wtransport::error::ConnectionError,
) -> (Option<u32>, Option<String>) {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(50);
    while let Ok(res) = tokio::time::timeout_at(deadline, conn.receive_datagram()).await {
        match res {
            // A datagram left over on a session that is already gone.
            Ok(_) => continue,
            Err(op_err @ wtransport::error::ConnectionError::ApplicationClosed(_)) => {
                return extract_close_info(&op_err);
            }
            Err(_) => break,
        }
    }
    extract_close_info(transport_err)
}

/// Releases per-session lifecycle counters (registry entry, per-IP rate-limit
/// slot, and the `sessions_active` gauge) exactly once — on the normal teardown
/// path via `release()`, or on an unwind via `Drop`. Without this, a panic in
/// the datagram-forward task (the case `panic_guard` exists for) would strand
/// these counters: `sessions_active` inflates → false `maxSessions` rejections,
/// and the peer IP stays permanently blocked from reconnecting.
struct SessionCounters {
    id: String,
    owner_server_id: u64,
    peer_ip: String,
    metrics: Arc<crate::server_metrics::ServerMetrics>,
    released: bool,
}

struct HandshakeAdmission {
    metrics: Arc<crate::server_metrics::ServerMetrics>,
}

impl HandshakeAdmission {
    fn new(metrics: Arc<crate::server_metrics::ServerMetrics>) -> Self {
        Self { metrics }
    }
}

impl Drop for HandshakeAdmission {
    fn drop(&mut self) {
        self.metrics.release_handshake();
    }
}

impl SessionCounters {
    fn release(&mut self) {
        if self.released {
            return;
        }
        self.released = true;
        session_registry::remove(&self.id);
        rate_limit::release_per_ip_session(self.owner_server_id, &self.peer_ip);
        self.metrics
            .sessions_active
            .fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
}

impl Drop for SessionCounters {
    fn drop(&mut self) {
        self.release();
    }
}

/// Spawn the wtransport server loop on the dedicated runtime.
#[allow(clippy::too_many_arguments)]
pub(crate) fn spawn_wtransport_server(
    owner_server_id: u64,
    metrics: Arc<server_metrics::ServerMetrics>,
    limits: limits::Limits,
    rate_limits: rate_limit::RateLimits,
    host: String,
    port: u16,
    mut shutdown_rx: watch::Receiver<()>,
    session_tx: Option<tokio::sync::mpsc::Sender<SessionEvent>>,
    log_tx: Option<tokio::sync::mpsc::Sender<LogEvent>>,
    tls_resolver: Arc<server_tls::LiveServerCertResolver>,
    congestion_control: client::CongestionControlMode,
    debug_logs: bool,
    enable_0rtt: bool,
    allow_early_session: bool,
    qpack_max_table_capacity: u64,
    startup_tx: std::sync::mpsc::Sender<std::result::Result<u16, String>>,
) {
    use std::sync::atomic::Ordering;
    use wtransport::{Endpoint, ServerConfig, VarInt};

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
        panic_guard::spawn_quic_task_scoped(panic_guard::PanicScope::Server(owner_server_id), async move {
            let mut startup_tx = Some(startup_tx);
            let mut report_startup = |res: std::result::Result<u16, String>| {
                send_startup_result(&mut startup_tx, res);
            };
            let tls_config =
                match server_tls::build_server_tls_config(Arc::clone(&tls_resolver)) {
                    Ok(config) => config,
                    Err(msg) => {
                        emit_log(&log_tx, !debug_logs, "error", &msg, None, None, None);
                        report_startup(Err(msg));
                        return;
                    }
                };
            let bind_addr: std::net::SocketAddr = format!("{}:{}", host, port)
                .parse()
                .unwrap_or_else(|_| std::net::SocketAddr::from(([0, 0, 0, 0], port)));
            // Align QUIC transport flow control with the configured app limits so a
            // peer cannot open QUIC-default concurrency (accept/reset churn) or
            // buffer more than the advertised byte budgets. Headroom of 16 streams
            // covers H3 control/QPACK/settings streams outside the app caps.
            let mut transport = wtransport::config::QuicTransportConfig::default();
            let memory_policy = transport_memory::TransportMemoryPolicy::from_limits(&limits)
                .with_h1b_datagram_buffers(&limits);
            let clamp_varint = |n: u64| -> wtransport::quinn::VarInt {
                wtransport::quinn::VarInt::from_u64(
                    n.min(wtransport::quinn::VarInt::MAX.into_inner()),
                )
                .unwrap_or(wtransport::quinn::VarInt::MAX)
            };
            transport.max_concurrent_bidi_streams(clamp_varint(
                limits.max_streams_per_session_bidi.saturating_add(16),
            ));
            transport.max_concurrent_uni_streams(clamp_varint(
                limits.max_streams_per_session_uni.saturating_add(16),
            ));
            memory_policy.apply_flow_control(&mut transport);
            memory_policy.apply_datagram_buffers(&mut transport);
            client::apply_congestion_controller(&mut transport, congestion_control);
            let config_builder = ServerConfig::builder()
            .with_bind_address(bind_addr)
            .with_custom_tls_and_transport(tls_config, transport);
            let config_builder = match config_builder.max_idle_timeout(Some(
                std::time::Duration::from_millis(limits.idle_timeout_ms),
            )) {
                Ok(builder) => builder,
                Err(e) => {
                    let msg = format!("failed to apply idle timeout: {:?}", e);
                    emit_log(&log_tx, !debug_logs, "error", &msg, None, None, None);
                    report_startup(Err(msg));
                    return;
                }
            };
            let config_builder = config_builder.keep_alive_interval(
                limits
                    .effective_keep_alive_interval_ms()
                    .map(std::time::Duration::from_millis),
            );
            // 0-RTT (fork feature): switches rustls to a stateful per-process
            // session store with take-once semantics (single-process
            // anti-replay) and allows the CONNECT request to arrive as
            // replayable early data; sessions report is_0rtt.
            let config_builder = config_builder.enable_0rtt(enable_0rtt);
            // Dynamic QPACK (fork feature): advertises SETTINGS_QPACK_MAX_TABLE_CAPACITY.
            // Zero (the default) keeps static-only, unchanged wire behavior. The
            // fork always advertises SETTINGS_QPACK_BLOCKED_STREAMS = 0, so there
            // is no blocked-streams option to thread.
            let config_builder =
                config_builder.qpack_max_table_capacity(qpack_max_table_capacity);
            let config = config_builder.build();
            let server = match Endpoint::server(config) {
                Ok(s) => match s.local_addr() {
                    Ok(addr) => {
                        let bound_port = addr.port();
                        emit_log(
                            &log_tx,
                            !debug_logs,
                            "info",
                            &format!("endpoint created for port {}", bound_port),
                            None,
                            None,
                            None,
                        );
                        report_startup(Ok(bound_port));
                        s
                    }
                    Err(e) => {
                        let msg = format!("failed to read bound address: {:?}", e);
                        emit_log(&log_tx, !debug_logs, "error", &msg, None, None, None);
                        report_startup(Err(msg));
                        return;
                    }
                },
                Err(e) => {
                    let msg = format!("failed to create endpoint: {:?}", e);
                    emit_log(&log_tx, !debug_logs, "error", &msg, None, None, None);
                    report_startup(Err(msg));
                    return;
                }
            };

            spawn_tracked::spawn_tracked(
                Arc::clone(&metrics),
                owner_server_id,
                spawn_tracked::TaskKind::Accept,
                panic_guard::PanicScope::Server(owner_server_id),
                async move {
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
                                if !metrics.try_acquire_handshake(limits.max_handshakes_in_flight) {
                                    incoming_session.refuse();
                                    metrics.limit_exceeded_count.fetch_add(1, Ordering::Relaxed);
                                    emit_log(&ltx, !debug_logs, "warn", "limit exceeded: maxHandshakesInFlight", None, None, None);
                                    continue;
                                }
                                let handshake_admission = HandshakeAdmission::new(Arc::clone(&metrics));
                                spawn_tracked::spawn_tracked(
                                    metrics.clone(),
                                    owner_server_id,
                                    spawn_tracked::TaskKind::Session,
                                    panic_guard::PanicScope::Server(owner_server_id),
                                    async move {
                                let _handshake_admission = handshake_admission;
                                let session_request = match incoming_session.await {
                                    Ok(r) => {
                                        emit_log(&ltx, !debug_logs, "debug", &format!("CONNECT received authority={:?}", r.authority()), None, None, None);
                                        r
                                    }
                                    Err(e) => {
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
                                // Sampled when the request was read: true means the
                                // CONNECT arrived as replayable 0-RTT early data.
                                let is_0rtt = session_request.is_0rtt();
                                let authority = session_request.authority().to_string();
                                let peer_addr = session_request.remote_address();
                                let peer_ip = peer_addr.ip().to_string();
                                let peer_port = peer_addr.port() as u32;
                                if !rate_limit::try_acquire_handshake(owner_server_id,
                                    &peer_ip,
                                    rate_limits.handshakes_per_sec,
                                    rate_limits.handshakes_burst,
                                ) {
                                    metrics.rate_limited_count.fetch_add(1, Ordering::Relaxed);
                                    emit_log(&ltx, !debug_logs, "warn", "rate limited: handshake token bucket", None, Some(&peer_ip), Some(peer_port));
                                    session_request.too_many_requests().await;
                                    return;
                                }
                                if !rate_limit::try_acquire_per_ip_session_with_prefix(owner_server_id,
                                    &peer_ip,
                                    rate_limits.handshakes_burst_per_ip,
                                    rate_limits.handshakes_burst_per_prefix,
                                ) {
                                    metrics.rate_limited_count.fetch_add(1, Ordering::Relaxed);
                                    emit_log(&ltx, !debug_logs, "warn", "rate limited: per-IP handshake burst", None, Some(&peer_ip), Some(peer_port));
                                    session_request.too_many_requests().await;
                                    return;
                                }
                                let prev_sessions = metrics.sessions_active.fetch_add(1, Ordering::SeqCst);
                                if prev_sessions >= limits.max_sessions {
                                    metrics.sessions_active.fetch_sub(1, Ordering::SeqCst);
                                    metrics.limit_exceeded_count.fetch_add(1, Ordering::Relaxed);
                                    emit_log(&ltx, !debug_logs, "warn", "limit exceeded: maxSessions", None, Some(&peer_ip), Some(peer_port));
                                    let reject_timeout = tokio::time::Duration::from_millis(
                                        limits.handshake_timeout_ms,
                                    );
                                    let reject_result = tokio::time::timeout(
                                        reject_timeout,
                                        session_request.accept(),
                                    )
                                    .await;
                                    rate_limit::release_per_ip_session(owner_server_id, &peer_ip);
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
                                                Some(&peer_ip),
                                                Some(peer_port),
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
                                                Some(&peer_ip),
                                                Some(peer_port),
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
                                        rate_limit::release_per_ip_session(owner_server_id, &peer_ip);
                                        emit_log(&ltx, !debug_logs, "warn", &format!("handshake timed out authority={:?}", authority), None, None, None);
                                        return;
                                    }
                                };
                                match accept_result {
                                    Ok(connection) => {
                                        metrics.handshake_histogram.observe(accept_start.elapsed());
                                        emit_log(&ltx, !debug_logs, "info", &format!("session accepted peer={}:{} authority={:?}", peer_ip, peer_port, authority), None, Some(&peer_ip), Some(peer_port));
                                        drop(_handshake_admission);

                                        let id = format!(
                                            "sess-{:016x}",
                                            SESSION_ID_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
                                                ^ *SESSION_ID_SEED
                                        );

                                        // P0-1: Register session BEFORE emitting to JS so acceptBidiStream etc. find it
                                        let (dgram_tx, bidi_accept_tx, uni_accept_tx, create_bi_rx, create_uni_rx, session_metrics, datagram_capacity_notify) =
                                            session_registry::insert(
                                                id.clone(),
                                                owner_server_id,
                                                connection.clone(),
                                                metrics.clone(),
                                                limits.clone(),
                                                is_0rtt,
                                            );
                                        // Replay-safety gate. The session request is
                                        // the replayable unit of 0-RTT, so by default
                                        // the onSession lifecycle event is deferred
                                        // until the handshake is confirmed (the request
                                        // is then no longer replayable). allowEarlySession
                                        // opts out, surfacing the session immediately
                                        // with is_0rtt observable for apps that only do
                                        // idempotent work pre-confirmation.
                                        //
                                        // Either way the handshake_confirmed flag must
                                        // flip so the session getter reflects reality;
                                        // handshake_confirmed() resolves at completion or
                                        // connection loss (bounded by the idle timeout),
                                        // so neither path can hang forever.
                                        if is_0rtt {
                                            let confirmed_flag = session_registry::zero_rtt_state(&id)
                                                .map(|(_, flag)| flag);
                                            if allow_early_session {
                                                if let Some(flag) = confirmed_flag {
                                                    let conn_confirm = connection.clone();
                                                    panic_guard::spawn_quic_task_scoped(
                                                        panic_guard::PanicScope::Server(owner_server_id),
                                                        async move {
                                                            let _ = conn_confirm
                                                                .handshake_confirmed()
                                                                .await;
                                                            flag.store(
                                                                true,
                                                                std::sync::atomic::Ordering::Release,
                                                            );
                                                        },
                                                    );
                                                }
                                            } else {
                                                // Deferred default: block this session's
                                                // setup until confirmation, then flip the
                                                // flag before the onSession event fires.
                                                let _ = connection.handshake_confirmed().await;
                                                if let Some(flag) = confirmed_flag {
                                                    flag.store(
                                                        true,
                                                        std::sync::atomic::Ordering::Release,
                                                    );
                                                }
                                            }
                                        }
                                        let stream_capacity_notify =
                                            session_registry::get_stream_capacity_notify(&id);

                                        if let Some(ref tx) = stx {
                                            // Lifecycle events must not be lossy: await capacity
                                            // instead of try_send (bounded by maxSessions churn).
                                            if tx
                                                .send(SessionEvent::Accepted(SessionAccepted {
                                                    id: id.clone(),
                                                    peer_ip: peer_ip.clone(),
                                                    peer_port,
                                                }))
                                                .await
                                                .is_err()
                                            {
                                                eprintln!(
                                                    "webtransport-native: session accepted event dropped for id={} (listener gone)",
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
                                        let stream_capacity_notify_bidi = stream_capacity_notify.clone();
                                        // The session can be removed between registry insert and
                                        // this fetch (deferred 0-RTT handshake_confirmed and the
                                        // lifecycle send are real await points; session.close()
                                        // from onSession or server close race them). Treat a
                                        // missing entry as session-already-gone, never panic:
                                        // this task runs under PanicScope::Server and a panic
                                        // here tears down every live session.
                                        let Some(bidi_discard) = session_registry::bidi_discard_state(&id)
                                        else {
                                            return;
                                        };
                                        let discard_permits_bidi =
                                            Arc::new(tokio::sync::Semaphore::new(DISCARD_DRAIN_CONCURRENCY));
                                        let discard_id_bidi = id.clone();
                                        spawn_tracked::spawn_tracked(
                                            m_bidi.clone(),
                                            owner_server_id,
                                            spawn_tracked::TaskKind::Stream,
                                            panic_guard::PanicScope::Session(id.clone()),
                                            async move {
                                                loop {
                                                    tokio::select! {
                                                        _ = conn_bidi.closed() => break,
                                                        res = conn_bidi.accept_bi() => {
                                                            let Ok((mut send, recv)) = res else { break };
                                                            if !rate_limit::try_acquire_stream_open(owner_server_id, &peer_ip_bidi, rl_bidi.streams_per_sec, rl_bidi.streams_burst) {
                                                                m_bidi.rate_limited_count.fetch_add(1, Ordering::Relaxed);
                                                                let _ = send.reset(0);
                                                                continue;
                                                            }
                                                            if m_bidi.streams_active.load(Ordering::Relaxed) >= lim_bidi.max_streams_global {
                                                                m_bidi.limit_exceeded_count.fetch_add(1, Ordering::Relaxed);
                                                                let _ = send.reset(0);
                                                                continue;
                                                            }
                                                            if sm_bidi.streams_bidi_active.load(Ordering::Relaxed) >= lim_bidi.max_streams_per_session_bidi {
                                                                m_bidi.limit_exceeded_count.fetch_add(1, Ordering::Relaxed);
                                                                let _ = send.reset(0);
                                                                continue;
                                                            }
                                                            if bidi_discard.is_enabled() {
                                                                m_bidi.streams_active.fetch_add(1, Ordering::Relaxed);
                                                                sm_bidi.streams_bidi_active.fetch_add(1, Ordering::Relaxed);
                                                                let guard = crate::client_stream::StreamGuard::server(
                                                                    Arc::clone(&m_bidi),
                                                                    Arc::clone(&sm_bidi),
                                                                    true,
                                                                    stream_capacity_notify_bidi.clone(),
                                                                );
                                                                let discard = bidi_discard.clone();
                                                                let permits = Arc::clone(&discard_permits_bidi);
                                                                let conn = conn_bidi.clone();
                                                                spawn_tracked::spawn_tracked(
                                                                    Arc::clone(&m_bidi),
                                                                    owner_server_id,
                                                                    spawn_tracked::TaskKind::Stream,
                                                                    panic_guard::PanicScope::Session(discard_id_bidi.clone()),
                                                                    async move {
                                                                        run_bounded_discard(
                                                                            permits,
                                                                            discard,
                                                                            DISCARD_DRAIN_STREAM_TIMEOUT,
                                                                            async {
                                                                                tokio::select! {
                                                                                    result = crate::client_stream::discard_recv_stream_zero_copy(recv) => result,
                                                                                    _ = conn.closed() => Err("E_SESSION_CLOSED".to_string()),
                                                                                }
                                                                            },
                                                                        )
                                                                        .await;
                                                                        drop(send);
                                                                        drop(guard);
                                                                    },
                                                                );
                                                                continue;
                                                            }
                                                            m_bidi.streams_active.fetch_add(1, Ordering::Relaxed);
                                                            sm_bidi.streams_bidi_active.fetch_add(1, Ordering::Relaxed);
                                                            let guard = crate::client_stream::StreamGuard::server(
                                                                Arc::clone(&m_bidi),
                                                                Arc::clone(&sm_bidi),
                                                                true,
                                                                stream_capacity_notify_bidi.clone(),
                                                            );
                                                            let budget = crate::client_stream::DeferredStreamBudgetConfig::new(
                                                                Arc::clone(&m_bidi),
                                                                Arc::clone(&sm_bidi),
                                                                lim_bidi.max_queued_bytes_global,
                                                                lim_bidi.max_queued_bytes_per_session,
                                                                lim_bidi.max_queued_bytes_per_stream,
                                                                lim_bidi.backpressure_timeout_ms,
                                                            );
                                                            let handle = crate::client_stream::ClientBidiStreamHandle::new_deferred(
                                                                recv,
                                                                send,
                                                                guard,
                                                                Some(budget),
                                                            );
                                                            let send_handle = bidi_accept_tx.send(Box::new(handle));
                                                            tokio::pin!(send_handle);
                                                            tokio::select! {
                                                                result = &mut send_handle => {
                                                                    if result.is_err() {
                                                                        report_channel_closed("bidi accept");
                                                                        break;
                                                                    }
                                                                }
                                                                _ = conn_bidi.closed() => break,
                                                            }
                                                        }
                                                    }
                                                }
                                            },
                                        );
                                        // Uni stream accept loop: forward to JS via channel (4.4.2; P1-5)
                                        let peer_ip_uni = peer_ip.clone();
                                        let rl_uni = rate_limits.clone();
                                        let stream_capacity_notify_uni = stream_capacity_notify.clone();
                                        // Same removal race as the bidi fetch above.
                                        let Some(uni_discard) = session_registry::uni_discard_state(&id)
                                        else {
                                            return;
                                        };
                                        let discard_permits_uni =
                                            Arc::new(tokio::sync::Semaphore::new(DISCARD_DRAIN_CONCURRENCY));
                                        let discard_id_uni = id.clone();
                                        spawn_tracked::spawn_tracked(
                                            m_uni.clone(),
                                            owner_server_id,
                                            spawn_tracked::TaskKind::Stream,
                                            panic_guard::PanicScope::Session(id.clone()),
                                            async move {
                                                loop {
                                                    tokio::select! {
                                                        _ = conn_uni.closed() => break,
                                                        res = conn_uni.accept_uni() => {
                                                            let Ok(recv) = res else { break };
                                                            if !rate_limit::try_acquire_stream_open(owner_server_id, &peer_ip_uni, rl_uni.streams_per_sec, rl_uni.streams_burst) {
                                                                m_uni.rate_limited_count.fetch_add(1, Ordering::Relaxed);
                                                                recv.stop(0);
                                                                continue;
                                                            }
                                                            if m_uni.streams_active.load(Ordering::Relaxed) >= lim_uni.max_streams_global {
                                                                m_uni.limit_exceeded_count.fetch_add(1, Ordering::Relaxed);
                                                                recv.stop(0);
                                                                continue;
                                                            }
                                                            if sm_uni.streams_uni_active.load(Ordering::Relaxed) >= lim_uni.max_streams_per_session_uni {
                                                                m_uni.limit_exceeded_count.fetch_add(1, Ordering::Relaxed);
                                                                recv.stop(0);
                                                                continue;
                                                            }
                                                            if uni_discard.is_enabled() {
                                                                m_uni.streams_active.fetch_add(1, Ordering::Relaxed);
                                                                sm_uni.streams_uni_active.fetch_add(1, Ordering::Relaxed);
                                                                let guard = crate::client_stream::StreamGuard::server(
                                                                    Arc::clone(&m_uni),
                                                                    Arc::clone(&sm_uni),
                                                                    false,
                                                                    stream_capacity_notify_uni.clone(),
                                                                );
                                                                let discard = uni_discard.clone();
                                                                let permits = Arc::clone(&discard_permits_uni);
                                                                let conn = conn_uni.clone();
                                                                spawn_tracked::spawn_tracked(
                                                                    Arc::clone(&m_uni),
                                                                    owner_server_id,
                                                                    spawn_tracked::TaskKind::Stream,
                                                                    panic_guard::PanicScope::Session(discard_id_uni.clone()),
                                                                    async move {
                                                                        run_bounded_discard(
                                                                            permits,
                                                                            discard,
                                                                            DISCARD_DRAIN_STREAM_TIMEOUT,
                                                                            async {
                                                                                tokio::select! {
                                                                                    result = crate::client_stream::discard_recv_stream_zero_copy(recv) => result,
                                                                                    _ = conn.closed() => Err("E_SESSION_CLOSED".to_string()),
                                                                                }
                                                                            },
                                                                        )
                                                                        .await;
                                                                        drop(guard);
                                                                    },
                                                                );
                                                                continue;
                                                            }
                                                            m_uni.streams_active.fetch_add(1, Ordering::Relaxed);
                                                            sm_uni.streams_uni_active.fetch_add(1, Ordering::Relaxed);
                                                            let guard = crate::client_stream::StreamGuard::server(
                                                                Arc::clone(&m_uni),
                                                                Arc::clone(&sm_uni),
                                                                false,
                                                                stream_capacity_notify_uni.clone(),
                                                            );
                                                            let budget = crate::client_stream::DeferredStreamBudgetConfig::new(
                                                                Arc::clone(&m_uni),
                                                                Arc::clone(&sm_uni),
                                                                lim_uni.max_queued_bytes_global,
                                                                lim_uni.max_queued_bytes_per_session,
                                                                lim_uni.max_queued_bytes_per_stream,
                                                                lim_uni.backpressure_timeout_ms,
                                                            );
                                                            let handle = crate::client_stream::ClientUniRecvHandle::new_deferred(
                                                                recv,
                                                                guard,
                                                                Some(budget),
                                                            );
                                                            let send_handle = uni_accept_tx.send(Box::new(handle));
                                                            tokio::pin!(send_handle);
                                                            tokio::select! {
                                                                result = &mut send_handle => {
                                                                    if result.is_err() {
                                                                        report_channel_closed("uni accept");
                                                                        break;
                                                                    }
                                                                }
                                                                _ = conn_uni.closed() => break,
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
                                        let stream_capacity_notify_create_bi = stream_capacity_notify.clone();
                                        spawn_tracked::spawn_tracked(
                                            m_create_bi.clone(),
                                            owner_server_id,
                                            spawn_tracked::TaskKind::Stream,
                                            panic_guard::PanicScope::Session(id.clone()),
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
                                                                let guard = crate::client_stream::StreamGuard::server(
                                                                    Arc::clone(&m_create_bi),
                                                                    Arc::clone(&sm_create_bi),
                                                                    true,
                                                                    stream_capacity_notify_create_bi.clone(),
                                                                );
                                                                let stream_queued = Arc::new(AtomicU64::new(0));
                                                                let budget = crate::client_stream::StreamBudget {
                                                                    server_metrics: Arc::clone(&m_create_bi),
                                                                    session_metrics: Arc::clone(&sm_create_bi),
                                                                    stream_queued: Arc::clone(&stream_queued),
                                                                    max_global: lim_create_bi.max_queued_bytes_global,
                                                                    max_session: lim_create_bi.max_queued_bytes_per_session,
                                                                    max_stream: lim_create_bi.max_queued_bytes_per_stream,
                                                                    capacity_notify: crate::client_stream::StreamBudget::new_notify(),
                                                                    backpressure_timeout_ms: lim_create_bi.backpressure_timeout_ms,
                                                                };
                                                                let (read_rx, write_tx, stop_tx, write_err_slot, read_err_slot) =
                                                                    crate::client_stream::spawn_bidi_bridge(send, recv, Some(guard), Some(budget.clone()));
                                                                Ok(crate::client_stream::ClientBidiStreamHandle::new_with_budget_and_slot(
                                                                    read_rx, write_tx, stop_tx, Some(budget), write_err_slot, read_err_slot,
                                                                ))
                                                            }
                                                            Err(e) => {
                                                                Err(wt_from_upstream_error(e.to_string()).to_string())
                                                            }
                                                        },
                                                        Err(e) => {
                                                            Err(wt_from_upstream_error(e.to_string()).to_string())
                                                        }
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
                                        let stream_capacity_notify_create_uni = stream_capacity_notify.clone();
                                        spawn_tracked::spawn_tracked(
                                            m_create_uni.clone(),
                                            owner_server_id,
                                            spawn_tracked::TaskKind::Stream,
                                            panic_guard::PanicScope::Session(id.clone()),
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
                                                                    let guard = crate::client_stream::StreamGuard::server(
                                                                        Arc::clone(&m_create_uni),
                                                                        Arc::clone(&sm_create_uni),
                                                                        false,
                                                                        stream_capacity_notify_create_uni.clone(),
                                                                    );
                                                                    let stream_queued = Arc::new(AtomicU64::new(0));
                                                                    let budget = crate::client_stream::StreamBudget {
                                                                        server_metrics: Arc::clone(&m_create_uni),
                                                                        session_metrics: Arc::clone(&sm_create_uni),
                                                                        stream_queued: Arc::clone(&stream_queued),
                                                                        max_global: lim_create_uni.max_queued_bytes_global,
                                                                        max_session: lim_create_uni.max_queued_bytes_per_session,
                                                                        max_stream: lim_create_uni.max_queued_bytes_per_stream,
                                                                        capacity_notify: crate::client_stream::StreamBudget::new_notify(),
                                                                        backpressure_timeout_ms: lim_create_uni.backpressure_timeout_ms,
                                                                    };
                                                                    let (write_tx, write_err_slot) = crate::client_stream::spawn_uni_send_bridge(send, Some(guard), Some(budget.clone()));
                                                                    let handle = crate::client_stream::ClientUniSendHandle::new_with_budget_and_slot(write_tx, Some(budget), write_err_slot);
                                                                    if resp_tx.send(Ok(handle)).is_err() {
                                                                        report_channel_failure("create_uni response");
                                                                    }
                                                                }
                                                                Err(e) => {
                                                                    if resp_tx
                                                                        .send(Err(
                                                                            wt_from_upstream_error(e.to_string()).to_string(),
                                                                        ))
                                                                        .is_err()
                                                                    {
                                                                        report_channel_failure("create_uni response");
                                                                    }
                                                                }
                                                            }
                                                        }
                                                        Err(e) => {
                                                            if resp_tx
                                                                .send(Err(wt_from_upstream_error(e.to_string()).to_string()))
                                                                .is_err()
                                                            {
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
                                            owner_server_id,
                                            spawn_tracked::TaskKind::Stream,
                                            panic_guard::PanicScope::Session(id.clone()),
                                            async move {
                                                // Releases session counters on any
                                                // task exit, including a panic
                                                // unwind (Drop). Normal paths call
                                                // `counters.release()` explicitly.
                                                let mut counters = SessionCounters {
                                                    id: id.clone(),
                                                    owner_server_id,
                                                    peer_ip: peer_ip_for_release.clone(),
                                                    metrics: m_dgram.clone(),
                                                    released: false,
                                                };
                                                loop {
                                                    if crate::server_metrics::ServerMetrics::session_queue_cannot_fit(
                                                        &sm_dgram.queued_bytes,
                                                        lim_dgram.max_queued_bytes_per_session,
                                                        lim_dgram.max_datagram_size as u64,
                                                    ) {
                                                        let session_notified =
                                                            datagram_capacity_notify.notified();
                                                        tokio::pin!(session_notified);
                                                        session_notified.as_mut().enable();
                                                        let owner_notified =
                                                            m_dgram.datagram_capacity_notify.notified();
                                                        tokio::pin!(owner_notified);
                                                        owner_notified.as_mut().enable();
                                                        if crate::server_metrics::ServerMetrics::session_queue_cannot_fit(
                                                            &sm_dgram.queued_bytes,
                                                            lim_dgram.max_queued_bytes_per_session,
                                                            lim_dgram.max_datagram_size as u64,
                                                        ) {
                                                            m_dgram.record_datagram_skip_queue_full();
                                                            tokio::select! {
                                                                biased;
                                                                _ = session_notified => {}
                                                                _ = owner_notified => {}
                                                                close_err = conn_dgram.closed() => {
                                                                    let (close_code, close_reason) =
                                                                        resolve_close_info(&conn_dgram, &close_err).await;
                                                                    counters.release();
                                                                    if let Some(ref tx) = closed_tx {
                                                                        if tx
                                                                            .send(SessionEvent::Closed { id: id.clone(), code: close_code, reason: close_reason })
                                                                            .await
                                                                            .is_err()
                                                                        {
                                                                            eprintln!(
                                                                                "webtransport-native: session closed event dropped for id={} (listener gone)",
                                                                                id
                                                                            );
                                                                        }
                                                                    }
                                                                    return;
                                                                }
                                                            }
                                                            continue;
                                                        }
                                                    }
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
                                                                    counters.release();
                                                                    if let Some(ref tx) = closed_tx {
                                                                        if tx
                                                                            .send(SessionEvent::Closed { id: id.clone(), code: close_code, reason: close_reason })
                                                                            .await
                                                                            .is_err()
                                                                        {
                                                                            eprintln!(
                                                                                "webtransport-native: session closed event dropped for id={} (listener gone)",
                                                                                id
                                                                            );
                                                                        }
                                                                    }
                                                                    return;
                                                                }
                                                            };
                                                            m_dgram.datagrams_in.fetch_add(1, Ordering::Relaxed);
                                                            sm_dgram.datagrams_in.fetch_add(1, Ordering::Relaxed);
                                                            if !rate_limit::try_acquire_datagram_ingress(owner_server_id, &peer_ip_for_release, rl_dgram.datagrams_per_sec, rl_dgram.datagrams_burst) {
                                                                m_dgram.record_datagram_drop(crate::server_metrics::DatagramDropReason::RateLimited);
                                                                continue;
                                                            }
                                                            if dgram.len() > lim_dgram.max_datagram_size {
                                                                m_dgram.record_datagram_drop(crate::server_metrics::DatagramDropReason::TooLarge);
                                                                continue;
                                                            }
                                                            let sz = dgram.len() as u64;
                                                            match m_dgram.try_reserve_queued_bytes_with_session(
                                                                &sm_dgram.queued_bytes,
                                                                sz,
                                                                lim_dgram.max_queued_bytes_global,
                                                                lim_dgram.max_queued_bytes_per_session,
                                                            ) {
                                                                crate::server_metrics::ReserveQueuedBytes::Ok => {}
                                                                crate::server_metrics::ReserveQueuedBytes::Global => {
                                                                    m_dgram.record_datagram_drop(crate::server_metrics::DatagramDropReason::QueueGlobal);
                                                                    continue;
                                                                }
                                                                crate::server_metrics::ReserveQueuedBytes::Session => {
                                                                    m_dgram.record_datagram_drop(crate::server_metrics::DatagramDropReason::QueueSession);
                                                                    continue;
                                                                }
                                                            }
                                                            let reservation = crate::session_registry::DatagramReservation::new(
                                                                std::sync::Arc::clone(&sm_dgram),
                                                                std::sync::Arc::clone(&m_dgram),
                                                                datagram_capacity_notify.clone(),
                                                                sz,
                                                            );
                                                            let slot = reservation.into_transport_slot(dgram);
                                                            // On send failure the slot is dropped here, releasing
                                                            // its reservation via Drop — no manual release needed.
                                                            if dgram_tx.send(slot).await.is_err() {
                                                                break;
                                                            }
                                                        }
                                                        close_err = conn_dgram.closed() => {
                                                            let (close_code, close_reason) =
                                                                resolve_close_info(&conn_dgram, &close_err).await;
                                                            counters.release();
                                                            if let Some(ref tx) = closed_tx {
                                                                if tx
                                                                    .send(SessionEvent::Closed { id: id.clone(), code: close_code, reason: close_reason })
                                                                    .await
                                                                    .is_err()
                                                                {
                                                                    eprintln!(
                                                                        "webtransport-native: session closed event dropped for id={} (listener gone)",
                                                                        id
                                                                    );
                                                                }
                                                            }
                                                            return;
                                                        }
                                                    }
                                                }
                                                counters.release();
                                                if let Some(ref tx) = closed_tx {
                                                    if tx
                                                        .send(SessionEvent::Closed { id: id.clone(), code: None, reason: None })
                                                        .await
                                                        .is_err()
                                                    {
                                                        eprintln!(
                                                            "webtransport-native: terminal session event dropped for id={} (listener gone)",
                                                            id
                                                        );
                                                    }
                                                }
                                            },
                                        );
                                    }
                                    Err(e) => {
                                        metrics.sessions_active.fetch_sub(1, Ordering::SeqCst);
                                        rate_limit::release_per_ip_session(owner_server_id, &peer_ip);
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
                },
            );
        });
    });
}

#[cfg(test)]
mod tests {
    use super::{report_channel_failure, send_startup_result, CHANNEL_DELIVERY_FAILURE_COUNT};
    use super::{report_tsfn_status, TSFN_DELIVERY_FAILURE_COUNT};
    use super::{run_bounded_discard, DISCARD_DRAIN_CONCURRENCY};
    use super::{CLIENT_RUNTIME, RUNTIME};
    use crate::session_registry::StreamDiscardState;
    use std::collections::HashSet;
    use std::sync::atomic::Ordering;
    use std::sync::Arc;
    use std::time::Duration;
    use tokio::sync::Semaphore;

    #[test]
    fn server_runtime_has_two_workers() {
        assert_eq!(
            RUNTIME.metrics().num_workers(),
            2,
            "server runtime must keep two workers; at one it drops 80-95% of \
             datagrams under sustained load"
        );
        assert_eq!(super::runtime_worker_count(), 2);
    }

    // num_workers() alone would still pass if the threads never materialised.
    // A *blocking* rendezvous can only be cleared by two OS threads sitting
    // inside it at the same moment, so each task reports the worker thread it
    // actually occupies. On a one-worker runtime the second task is never
    // polled, nothing is reported, and the recv times out.
    #[test]
    fn server_runtime_runs_tasks_on_two_wt_server_threads() {
        let rendezvous = Arc::new(std::sync::Barrier::new(2));
        let (tx, rx) = std::sync::mpsc::channel();

        for _ in 0..2 {
            let rendezvous = Arc::clone(&rendezvous);
            let tx = tx.clone();
            RUNTIME.spawn(async move {
                rendezvous.wait();
                let thread = std::thread::current();
                let _ = tx.send((thread.id(), thread.name().unwrap_or_default().to_string()));
            });
        }
        drop(tx);

        let mut observed = Vec::new();
        for _ in 0..2 {
            observed.push(
                rx.recv_timeout(Duration::from_secs(10))
                    .expect("two worker threads must occupy the rendezvous at once"),
            );
        }

        let distinct: HashSet<_> = observed.iter().map(|(id, _)| *id).collect();
        assert_eq!(distinct.len(), 2, "expected two distinct worker threads");
        for (_, name) in &observed {
            assert!(
                name.starts_with("wt-server"),
                "worker thread named {name:?} must keep the wt-server name"
            );
        }
    }

    // The starvation evidence covers the server receive path only; the client
    // runtime stays at one worker until something measures it.
    #[test]
    fn client_runtime_stays_single_worker() {
        assert_eq!(CLIENT_RUNTIME.metrics().num_workers(), 1);
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
        let (tx, rx) = std::sync::mpsc::channel::<std::result::Result<u16, String>>();
        drop(rx);
        let mut opt = Some(tx);
        send_startup_result(&mut opt, Err("boom".to_string()));
        assert!(opt.is_none());
        assert_eq!(CHANNEL_DELIVERY_FAILURE_COUNT.load(Ordering::Relaxed), 1);
    }

    // A stream that never finishes draining must not hold up the streams
    // accepted after it: that was the head-of-line stall in the inline drain.
    #[tokio::test(flavor = "current_thread")]
    async fn bounded_discard_stall_does_not_block_other_streams() {
        let permits = Arc::new(Semaphore::new(DISCARD_DRAIN_CONCURRENCY));
        let discard = StreamDiscardState::for_test();

        let stalled = tokio::spawn(run_bounded_discard(
            Arc::clone(&permits),
            discard.clone(),
            Duration::from_secs(60),
            std::future::pending(),
        ));

        for _ in 0..8 {
            run_bounded_discard(
                Arc::clone(&permits),
                discard.clone(),
                Duration::from_secs(60),
                std::future::ready(Ok(())),
            )
            .await;
        }

        assert_eq!(discard.completed(), 8);
        assert!(discard.error().is_none());
        assert!(!stalled.is_finished());
        stalled.abort();
    }

    // The per-stream deadline is what returns the permit when a peer opens a
    // stream and then stops sending; an expired drain stays uncounted.
    #[tokio::test(flavor = "current_thread")]
    async fn bounded_discard_timeout_releases_permit_without_counting() {
        let permits = Arc::new(Semaphore::new(1));
        let discard = StreamDiscardState::for_test();

        run_bounded_discard(
            Arc::clone(&permits),
            discard.clone(),
            Duration::from_millis(50),
            std::future::pending(),
        )
        .await;

        assert_eq!(discard.completed(), 0);
        assert!(discard.error().is_none());
        assert_eq!(permits.available_permits(), 1);

        run_bounded_discard(
            permits,
            discard.clone(),
            Duration::from_millis(50),
            std::future::ready(Ok(())),
        )
        .await;
        assert_eq!(discard.completed(), 1);
    }

    // Drain errors still reach the N-API waiter through the shared state.
    #[tokio::test(flavor = "current_thread")]
    async fn bounded_discard_records_drain_error() {
        let permits = Arc::new(Semaphore::new(DISCARD_DRAIN_CONCURRENCY));
        let discard = StreamDiscardState::for_test();

        run_bounded_discard(
            permits,
            discard.clone(),
            Duration::from_secs(60),
            std::future::ready(Err("E_STREAM_RESET".to_string())),
        )
        .await;

        assert_eq!(discard.completed(), 0);
        assert_eq!(discard.error().as_deref(), Some("E_STREAM_RESET"));
    }
}
