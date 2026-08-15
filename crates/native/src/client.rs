//! WebTransport client. Connects to a server and exposes session API.

use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::{Env, JsFunction, JsObject, Result};
use napi_derive::napi;
use once_cell::sync::Lazy;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::{mpsc, oneshot, watch, Mutex as TokioMutex, Notify};

/// Per-client-session atomic metrics.
#[derive(Default)]
pub struct ClientMetrics {
    pub datagrams_in: AtomicU64,
    pub datagrams_out: AtomicU64,
    pub streams_active: AtomicU64,
    pub queued_bytes: AtomicU64,
}

use crate::client_pool::{self, PoolKey, PoolReleaseGuard};
use crate::client_stream::{
    spawn_bidi_bridge_on, spawn_uni_recv_bridge_on, spawn_uni_send_bridge_on,
    ClientBidiStreamHandle, ClientUniRecvHandle, ClientUniSendHandle, StreamBudget,
};
use crate::error::{from_upstream_error as wt_from_upstream_error, WtResult};
use crate::server_metrics::ServerMetrics;
use crate::session_registry::SessionMetrics;
use crate::CLIENT_RUNTIME;

static CLIENT_SESSION_ID_COUNTER: AtomicU64 = AtomicU64::new(0);
static CLIENT_SESSION_ID_SEED: Lazy<u64> = Lazy::new(|| {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut h = DefaultHasher::new();
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
        .hash(&mut h);
    std::process::id().hash(&mut h);
    // Mix in a client-specific discriminator so client and server seeds differ
    "client".hash(&mut h);
    h.finish()
});
static CLIENT_HANDLE_REGISTRY: Lazy<Mutex<HashMap<String, ClientSessionHandle>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static CLIENT_POOL: Lazy<std::sync::Arc<client_pool::ClientPoolManager>> =
    Lazy::new(|| std::sync::Arc::new(client_pool::ClientPoolManager::new()));

struct RegistryMutation<T> {
    value: T,
    poison_recovered: bool,
}

fn remove_registry_entry(
    registry: &Mutex<HashMap<String, ClientSessionHandle>>,
    handle_id: &str,
) -> RegistryMutation<Option<ClientSessionHandle>> {
    match registry.lock() {
        Ok(mut guard) => RegistryMutation {
            value: guard.remove(handle_id),
            poison_recovered: false,
        },
        Err(poisoned) => {
            let mut guard = poisoned.into_inner();
            RegistryMutation {
                value: guard.remove(handle_id),
                poison_recovered: true,
            }
        }
    }
}

fn insert_registry_entry(
    registry: &Mutex<HashMap<String, ClientSessionHandle>>,
    handle: ClientSessionHandle,
) -> RegistryMutation<()> {
    match registry.lock() {
        Ok(mut guard) => {
            guard.insert(handle.id.clone(), handle);
            RegistryMutation {
                value: (),
                poison_recovered: false,
            }
        }
        Err(poisoned) => {
            let mut guard = poisoned.into_inner();
            guard.insert(handle.id.clone(), handle);
            RegistryMutation {
                value: (),
                poison_recovered: true,
            }
        }
    }
}

fn report_client_registry_recovery(context: &str, handle_id: &str) {
    eprintln!(
        "webtransport-native: {} client handle registry mutex was poisoned; recovered entry mutation for {}",
        context, handle_id
    );
}

fn remove_client_registry_entry(handle_id: &str) -> RegistryMutation<Option<ClientSessionHandle>> {
    remove_registry_entry(&CLIENT_HANDLE_REGISTRY, handle_id)
}

fn finalize_client_terminal_state(
    handle_id: &str,
    closed_flag: &AtomicBool,
    lifecycle_notify: &Notify,
    close_code: Option<u32>,
    close_reason: Option<String>,
    on_closed: Option<&ThreadsafeFunction<ClientSessionClosed, ErrorStrategy::Fatal>>,
) {
    mark_client_closed_and_notify(closed_flag, lifecycle_notify);
    let removal = remove_client_registry_entry(handle_id);
    if removal.poison_recovered {
        report_client_registry_recovery("finalize", handle_id);
    }
    if let Some(tsfn) = on_closed {
        let status = tsfn.call(
            ClientSessionClosed {
                id: handle_id.to_string(),
                code: close_code,
                reason: close_reason,
            },
            ThreadsafeFunctionCallMode::NonBlocking,
        );
        crate::report_tsfn_status("on_closed", status);
    }
}

fn handle_connect_callback_status(success_id: Option<&str>, status: napi::Status) {
    crate::report_tsfn_status("connect", status);
    if status == napi::Status::Ok {
        return;
    }
    if let Some(handle_id) = success_id {
        let removal = remove_client_registry_entry(handle_id);
        if removal.poison_recovered {
            report_client_registry_recovery("connect callback cleanup", handle_id);
        }
        if let Some(handle) = removal.value {
            handle.initiate_close(
                0,
                format!("E_INTERNAL: connect callback delivery failed: {:?}", status),
            );
        }
    }
}

fn map_connecting_error(
    err: wtransport::error::ConnectingError,
) -> Box<dyn std::error::Error + Send + Sync> {
    match err {
        wtransport::error::ConnectingError::SessionRejected => {
            std::io::Error::other("E_RATE_LIMITED: server rejected WebTransport session request")
                .into()
        }
        other => other.into(),
    }
}

/// Result for connect callback to avoid napi::Result type confusion.
#[derive(Clone)]
enum ConnectResult {
    Ok(String),
    Err(String),
}

/// Client session closed event for JS callback.
#[derive(Clone, Debug)]
pub struct ClientSessionClosed {
    pub id: String,
    pub code: Option<u32>,
    pub reason: Option<String>,
}

/// Request to open a bidi stream. Response sent via oneshot.
type OpenBiReq = oneshot::Sender<std::result::Result<ClientBidiStreamHandle, String>>;
type OpenUniReq = oneshot::Sender<std::result::Result<ClientUniSendHandle, String>>;
type AcceptBiReq = oneshot::Sender<std::result::Result<ClientBidiStreamHandle, String>>;
type AcceptUniReq = oneshot::Sender<std::result::Result<ClientUniRecvHandle, String>>;

fn try_reserve_client_queued_bytes(metrics: &ClientMetrics, budget_bytes: u64, n: u64) -> bool {
    metrics
        .queued_bytes
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |current| {
            current
                .checked_add(n)
                .and_then(|next| (next <= budget_bytes).then_some(next))
        })
        .is_ok()
}

/// Slots in the client's receive datagram channel. Named because the batch
/// path's capacity conservation is asserted against it: a held batch must
/// release exactly its own slots back to the forwarder and no more.
pub(crate) const CLIENT_DATAGRAM_RECV_CAPACITY: usize = 256;

/// Largest batch one client delivery call may carry. Matches the server cap:
/// the N-API round-trip win is flat well before here, and a larger cap only
/// widens the window in which dequeued payloads sit outside the byte
/// reservation.
const CLIENT_DATAGRAM_BATCH_MAX: u32 = 256;

/// How long the terminal task waits for the receive forwarder to signal exit
/// before running its final drain anyway. With the forwarder's interruptible
/// enqueue, a live forwarder always exits well inside this; expiry therefore
/// means the task panicked or was killed by panic containment, and a dead
/// forwarder cannot charge. This is panic insurance, not the mechanism.
const FORWARDER_EXIT_WAIT: tokio::time::Duration = tokio::time::Duration::from_secs(1);

/// Clamp a caller-supplied batch size into range. Out-of-range values are
/// corrected silently: a rejected async N-API call leaks its self-reference
/// under Bun, so user input must never become an `Err`.
fn clamp_client_batch_max(max: u32) -> usize {
    max.clamp(1, CLIENT_DATAGRAM_BATCH_MAX) as usize
}

/// Store the sticky close flag and wake every parked datagram reader and the
/// receive forwarder. The `Release` store is paired with the `Acquire` loads
/// in the read routine and the forwarder, so a waker that observes the flag
/// also observes everything that led to the close.
fn mark_client_closed_and_notify(closed: &AtomicBool, lifecycle_notify: &Notify) {
    closed.store(true, Ordering::Release);
    lifecycle_notify.notify_waiters();
}

/// Drop every datagram still queued and give its reserved bytes back.
///
/// The receive reservation is charged at enqueue and refunded on reader take;
/// there is no `DatagramSlot` whose `Drop` could refund a discarded one, so a
/// dropped datagram would otherwise strand its bytes in `queued_bytes` on a
/// live handle. Holding the receiver mutex is what makes this safe to call
/// from several places: each item is removable exactly once by exactly one
/// holder, and the remover is the refunder, so a double refund is
/// structurally impossible.
fn drain_and_refund_queued_datagrams(
    rx: &mut mpsc::Receiver<Vec<u8>>,
    metrics: &ClientMetrics,
) -> usize {
    let mut drained = 0;
    while let Ok(bytes) = rx.try_recv() {
        metrics
            .queued_bytes
            .fetch_sub(bytes.len() as u64, Ordering::Relaxed);
        drained += 1;
    }
    drained
}

async fn lock_drain_and_refund(
    rx: &TokioMutex<mpsc::Receiver<Vec<u8>>>,
    metrics: &ClientMetrics,
) -> usize {
    let mut guard = rx.lock().await;
    drain_and_refund_queued_datagrams(&mut guard, metrics)
}

/// Outcome of waiting for the first datagram of a batch.
enum FirstDatagram {
    Item(Vec<u8>),
    /// The session closed. Whatever is still queued is dropped, not drained.
    Closed,
    /// Every sender is gone and nothing is left.
    Disconnected,
}

/// Wait for one datagram, waking on session close rather than only on the
/// senders being dropped.
///
/// An already-queued datagram is returned without touching the `Notify` at
/// all: registering a waiter costs two waiter-list lock acquisitions, which
/// the batch path amortizes over up to 256 payloads but the max=1 lane would
/// pay per datagram. The sticky flag is still read first, so a read entered
/// after a close reports EOF instead of draining the remainder.
///
/// Once the queue is empty the registration order matters: the `Notified` is
/// created and `enable()`d before the sticky flag is re-read, so a close
/// landing in that window is still delivered as a wake (tokio's `Notify`
/// stores no permit for a future that has not registered). The select is
/// `biased` so a close racing a queued datagram wins deterministically rather
/// than by coin flip.
async fn recv_first_datagram(
    rx: &mut mpsc::Receiver<Vec<u8>>,
    closed: &AtomicBool,
    lifecycle_notify: &Notify,
) -> FirstDatagram {
    if closed.load(Ordering::Acquire) {
        return FirstDatagram::Closed;
    }
    match rx.try_recv() {
        Ok(bytes) => return FirstDatagram::Item(bytes),
        Err(mpsc::error::TryRecvError::Disconnected) => return FirstDatagram::Disconnected,
        Err(mpsc::error::TryRecvError::Empty) => {}
    }

    loop {
        let notified = lifecycle_notify.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();

        if closed.load(Ordering::Acquire) {
            return FirstDatagram::Closed;
        }
        tokio::select! {
            biased;
            // A spurious wake loops and rechecks; only the sticky flag ends
            // the wait.
            _ = notified => {}
            received = rx.recv() => {
                return match received {
                    Some(bytes) => FirstDatagram::Item(bytes),
                    None => FirstDatagram::Disconnected,
                };
            }
        }
    }
}

/// Everything a datagram read needs, cloned out of the handle so a parked read
/// never holds an exclusive napi borrow of it.
#[derive(Clone)]
pub(crate) struct ClientDatagramReadState {
    rx: Arc<TokioMutex<mpsc::Receiver<Vec<u8>>>>,
    metrics: Arc<ClientMetrics>,
    closed: Arc<AtomicBool>,
    lifecycle_notify: Arc<Notify>,
}

impl ClientDatagramReadState {
    /// Read up to `max` datagrams with one blocking wait: park for the first,
    /// then take whatever else is already queued. Never yields an empty batch —
    /// the result is a non-empty batch or `None` for EOF/close.
    pub(crate) async fn read_batch(&self, max: u32) -> Option<Vec<Vec<u8>>> {
        let cap = clamp_client_batch_max(max);
        let mut rx = self.rx.lock().await;

        let first = match recv_first_datagram(&mut rx, &self.closed, &self.lifecycle_notify).await {
            FirstDatagram::Item(bytes) => bytes,
            FirstDatagram::Closed => {
                // Reader-owned drain: still holding the guard, so nothing can
                // slip between observing the close and settling the bytes.
                drain_and_refund_queued_datagrams(&mut rx, &self.metrics);
                return None;
            }
            FirstDatagram::Disconnected => return None,
        };

        let mut batch = Vec::with_capacity(cap);
        self.refund(&first);
        batch.push(first);
        while batch.len() < cap {
            let Ok(bytes) = rx.try_recv() else {
                break;
            };
            self.refund(&bytes);
            batch.push(bytes);
        }
        Some(batch)
    }

    /// The legacy single-datagram lane, expressed as the max=1 extraction over
    /// the same routine so both lanes share one close and accounting path.
    pub(crate) async fn read_one(&self) -> Option<Vec<u8>> {
        self.read_batch(1).await?.into_iter().next()
    }

    fn refund(&self, bytes: &[u8]) {
        self.metrics
            .queued_bytes
            .fetch_sub(bytes.len() as u64, Ordering::Relaxed);
    }
}

/// Signals that the receive forwarder's body has finished.
///
/// `spawn_quic_task_scoped` consumes the `JoinHandle` inside its watchdog, so
/// there is no handle to await and swapping in a bare `tokio::spawn` would
/// lose `PanicScope::Conn` containment. A guard held for the whole body fires
/// on normal exit *and* on panic unwind, which is what makes the terminal
/// task's wait panic-safe.
struct ForwarderDoneGuard(Option<oneshot::Sender<()>>);

impl ForwarderDoneGuard {
    fn new() -> (Self, oneshot::Receiver<()>) {
        let (tx, rx) = oneshot::channel();
        (Self(Some(tx)), rx)
    }
}

impl Drop for ForwarderDoneGuard {
    fn drop(&mut self) {
        if let Some(tx) = self.0.take() {
            let _ = tx.send(());
        }
    }
}

/// Move received datagrams onto the handle's receive channel, charging their
/// bytes at enqueue and refunding anything charged but not handed over.
///
/// `next_datagram` yields wire payloads until the connection ends. Two
/// properties make close teardown bounded:
///
/// * the sticky flag is checked with `Acquire` before each charge, which
///   shrinks — but does not close — the window in which a charge lands after a
///   drain, because check → charge → send straddles an `.await`;
/// * the enqueue is interruptible. A full channel is an ordinary backpressure
///   state (256 slots x ~1150 B fills long before the per-session byte budget
///   binds) and closing the QUIC connection neither frees a slot nor drops the
///   receiver, so an uninterruptible `send().await` would park forever and
///   deadlock the terminal task's wait against the only task that can free a
///   slot.
///
/// On exit, and only if the session is already closed, the forwarder takes the
/// receiver mutex and drains once itself. That runs in its own task strictly
/// after its last possible charge, so it settles the residual case of a
/// descheduled-but-live forwarder charging after the terminal task's final
/// drain. Drains are idempotent under the mutex, so this strengthens rather
/// than replaces the terminal sequence.
async fn run_client_datagram_forwarder<S, F>(
    mut next_datagram: S,
    tx: mpsc::Sender<Vec<u8>>,
    rx: Arc<TokioMutex<mpsc::Receiver<Vec<u8>>>>,
    metrics: Arc<ClientMetrics>,
    budget_bytes: u64,
    closed: Arc<AtomicBool>,
    lifecycle_notify: Arc<Notify>,
) where
    S: FnMut() -> F,
    F: std::future::Future<Output = Option<Vec<u8>>>,
{
    loop {
        let Some(bytes) = next_datagram().await else {
            break;
        };
        if closed.load(Ordering::Acquire) {
            break;
        }
        let sz = bytes.len() as u64;
        if !try_reserve_client_queued_bytes(&metrics, budget_bytes, sz) {
            continue;
        }

        let notified = lifecycle_notify.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if closed.load(Ordering::Acquire) {
            metrics.queued_bytes.fetch_sub(sz, Ordering::Relaxed);
            break;
        }
        let handed_over = tokio::select! {
            biased;
            // `Sender::send` is cancel-safe: a cancelled send delivers
            // nothing, so refunding here cannot double-count.
            _ = notified => false,
            result = tx.send(bytes) => result.is_ok(),
        };
        if !handed_over {
            metrics.queued_bytes.fetch_sub(sz, Ordering::Relaxed);
            break;
        }
        // Counted only once the datagram is actually in the reader's queue, so
        // a handover cancelled by a close is not reported as received.
        metrics.datagrams_in.fetch_add(1, Ordering::Relaxed);
    }

    // Release the last sender before contending for the receiver mutex. On an
    // ordinary end-of-connection exit there is no close to wake a parked
    // reader, and that reader holds the mutex; the disconnect is what lets it
    // finish, and it is also what turns the drained-empty queue into EOF.
    drop(tx);

    // Only a closed session discards what is still queued. On a clean
    // end-of-connection exit the sticky flag is still false — the terminal task
    // has not run yet — and a reader is fully entitled to the remainder, so
    // draining here would silently destroy up to a full channel of deliverable
    // datagrams. The close case still cannot strand bytes: the terminal task
    // always runs on connection end and drains after setting the flag.
    if closed.load(Ordering::Acquire) {
        lock_drain_and_refund(&rx, &metrics).await;
    }
}

/// Settle every receive-side byte after a session ends, in the one order that
/// leaves no charge outstanding.
///
/// 1. Store the sticky flag and fire the lifecycle notify, so parked readers
///    return EOF and a send-parked forwarder unparks.
/// 2. Drain immediately. This is the primary deadlock breaker: it frees
///    channel capacity for a forwarder parked on a full channel. It must come
///    before the wait — a `Notified` created after `notify_waiters()` has
///    already fired receives no permit, so the notify alone is not a
///    guaranteed unpark path.
/// 3. `after_first_drain` runs here rather than after the wait, so the
///    JS-visible close callback keeps its current latency even when the
///    forwarder has panicked and the wait must time out.
/// 4. Wait, bounded, for the forwarder to signal exit.
/// 5. Drain again. The forwarder is the sole receive-side charger, so once it
///    has exited no further charge or enqueue is possible and this drain is
///    genuinely final.
async fn settle_client_receive_accounting_after_close(
    rx: &TokioMutex<mpsc::Receiver<Vec<u8>>>,
    metrics: &ClientMetrics,
    closed: &AtomicBool,
    lifecycle_notify: &Notify,
    forwarder_done: oneshot::Receiver<()>,
    after_first_drain: impl FnOnce(),
) {
    mark_client_closed_and_notify(closed, lifecycle_notify);
    // LOAD-BEARING INVARIANT: every holder of the `dgram_recv_rx` mutex must
    // observe the sticky flag and release promptly. This lock is untimed, and
    // the JS-visible close callback below sits behind it — unlike the
    // forwarder wait, there is no timeout to catch a holder that parks
    // indefinitely after the flag is set. Today the only holders are the read
    // routine (whose wait ends on the flag) and the two drains (which never
    // await while holding it). Do not add a holder that can outlive the flag.
    lock_drain_and_refund(rx, metrics).await;
    after_first_drain();
    if tokio::time::timeout(FORWARDER_EXIT_WAIT, forwarder_done)
        .await
        .is_err()
    {
        eprintln!(
            "webtransport-native: client receive forwarder did not signal exit within {:?}; \
             draining anyway",
            FORWARDER_EXIT_WAIT
        );
    }
    lock_drain_and_refund(rx, metrics).await;
}

fn parse_client_limits(opts_json: &str) -> std::result::Result<crate::limits::Limits, String> {
    let parsed: serde_json::Value = serde_json::from_str(opts_json)
        .map_err(|e| format!("E_INTERNAL: invalid client options JSON: {}", e))?;
    if let Some(limits) = parsed.get("limits") {
        let s = serde_json::to_string(limits)
            .map_err(|e| format!("E_INTERNAL: invalid limits payload: {}", e))?;
        Ok(crate::limits::Limits::from_json(&s))
    } else {
        Ok(crate::limits::Limits::default())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CongestionControlMode {
    Default,
    Throughput,
    LowLatency,
}

pub(crate) fn parse_congestion_control(
    opts: &serde_json::Value,
) -> std::result::Result<CongestionControlMode, String> {
    match opts
        .get("congestionControl")
        .and_then(|v| v.as_str())
        .unwrap_or("default")
    {
        "default" => Ok(CongestionControlMode::Default),
        "throughput" => Ok(CongestionControlMode::Throughput),
        "low-latency" => Ok(CongestionControlMode::LowLatency),
        other => Err(format!(
            "E_INTERNAL: congestionControl must be \"default\", \"throughput\", or \"low-latency\", got \"{}\"",
            other
        )),
    }
}

/// Hard cap on the advertised QPACK dynamic-table capacity, mirroring the
/// fork's `MAX_QPACK_TABLE_CAPACITY` (64 KiB). We clamp here too so a bogus
/// option never reaches the builder.
pub(crate) const MAX_QPACK_TABLE_CAPACITY: u64 = 65_536;

/// Capacity the `enableDynamicQpack` boolean preset expands to. Deliberately
/// diverges from the wasm backend's blocked-streams default: native never
/// advertises blocked_streams > 0 (the fork hardcodes it to 0), so the preset
/// is capacity-only.
pub(crate) const QPACK_DYNAMIC_PRESET_CAPACITY: u64 = 4096;

/// Resolve the QPACK dynamic-table capacity to advertise from server/client
/// options. `qpackMaxTableCapacity` (a number) wins when present — including an
/// explicit `0` to force static-only — otherwise the `enableDynamicQpack`
/// boolean expands to the preset. Absent both, the result is `0` (static-only,
/// unchanged wire behavior). The value is clamped to
/// [`MAX_QPACK_TABLE_CAPACITY`]. `qpackBlockedStreams` is intentionally not a
/// settable option: the fork always advertises zero.
///
/// A `qpackMaxTableCapacity` that is present but not a non-negative integer is
/// an error rather than an absent value. The facade already rejects one, so
/// reaching here means an internal caller bypassed it, and falling through to
/// the preset would answer a malformed request with a dynamic table nobody
/// asked for.
pub(crate) fn parse_qpack_max_table_capacity(
    opts: &serde_json::Value,
) -> std::result::Result<u64, String> {
    match opts.get("qpackMaxTableCapacity") {
        Some(serde_json::Value::Null) | None => {}
        Some(value) => {
            let n = value.as_u64().ok_or_else(|| {
                "E_INVALID_ARGUMENT: qpackMaxTableCapacity must be a non-negative integer"
                    .to_string()
            })?;
            return Ok(n.min(MAX_QPACK_TABLE_CAPACITY));
        }
    }

    if opts
        .get("enableDynamicQpack")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        return Ok(QPACK_DYNAMIC_PRESET_CAPACITY);
    }

    Ok(0)
}

/// Default client idle timeout. quinn's default is `None` (never), which leaves
/// a client on a dead path (NAT rebind, network drop, server power loss) hung
/// forever with `closed` never resolving. A bounded default guarantees liveness.
pub const DEFAULT_CLIENT_IDLE_TIMEOUT_MS: u64 = 30_000;

pub(crate) fn apply_congestion_controller(
    config: &mut wtransport::config::QuicTransportConfig,
    mode: CongestionControlMode,
) {
    let factory: Arc<dyn wtransport::quinn::congestion::ControllerFactory + Send + Sync + 'static> =
        match mode {
            CongestionControlMode::Default => {
                Arc::new(wtransport::quinn::congestion::CubicConfig::default())
            }
            CongestionControlMode::Throughput => {
                Arc::new(wtransport::quinn::congestion::BbrConfig::default())
            }
            CongestionControlMode::LowLatency => {
                Arc::new(wtransport::quinn::congestion::NewRenoConfig::default())
            }
        };
    config.congestion_controller_factory(factory);
}

fn build_quic_transport_config(
    mode: CongestionControlMode,
    idle_timeout_ms: u64,
    keep_alive_interval_ms: u64,
    limits: &crate::limits::Limits,
) -> wtransport::config::QuicTransportConfig {
    let mut config = wtransport::config::QuicTransportConfig::default();
    let memory_policy = crate::transport_memory::TransportMemoryPolicy::from_limits(limits)
        .with_h1b_datagram_buffers(limits);
    memory_policy.apply_flow_control(&mut config);
    memory_policy.apply_datagram_buffers(&mut config);
    apply_congestion_controller(&mut config, mode);

    // Liveness: bound how long a silent (possibly dead) connection lingers, and
    // send keep-alive pings so a live-but-quiet connection is not idle-killed.
    // `idle_timeout_ms == 0` opts out (unbounded), matching quinn's raw default.
    if idle_timeout_ms > 0 {
        match wtransport::quinn::IdleTimeout::try_from(std::time::Duration::from_millis(
            idle_timeout_ms,
        )) {
            Ok(timeout) => {
                config.max_idle_timeout(Some(timeout));
            }
            // Out of range: fall back to no idle timeout rather than panicking.
            Err(_) => {
                config.max_idle_timeout(None);
            }
        }
        // Keep-alive must stay strictly below the idle timeout, or a quiet but
        // live connection gets idle-killed before a ping can refresh it. Clamp
        // to at most idle/2 (tolerates one lost ping) regardless of the caller's
        // value; 0 (after clamping) disables keep-alive, still bounded by idle.
        let keep_alive_ms = keep_alive_interval_ms.min(idle_timeout_ms / 2);
        if keep_alive_ms > 0 {
            config.keep_alive_interval(Some(std::time::Duration::from_millis(keep_alive_ms)));
        }
    }
    config
}

#[cfg(test)]
pub(crate) fn congestion_controller_label(mode: CongestionControlMode) -> &'static str {
    match mode {
        CongestionControlMode::Default => "cubic",
        CongestionControlMode::Throughput => "bbr",
        CongestionControlMode::LowLatency => "new_reno",
    }
}

/// Build a fresh rustls client TLS config from trust inputs. For 0-RTT
/// connects, do NOT call this per connect — resumption requires one shared
/// config per identity (see `zero_rtt::shared_tls_for_identity`).
pub(crate) fn build_client_tls_parts(
    insecure_skip_verify: bool,
    ca_pem: Option<&str>,
    pinned_hashes: &[[u8; 32]],
) -> std::result::Result<rustls::ClientConfig, String> {
    if insecure_skip_verify {
        build_client_tls_config(Arc::new(rustls::RootCertStore::empty()), true, &[])
    } else if ca_pem.is_some() || !pinned_hashes.is_empty() {
        let root_store = build_root_cert_store(ca_pem)?;
        build_client_tls_config(root_store, false, pinned_hashes)
    } else {
        let root_store = build_root_cert_store(None)?;
        build_client_tls_config(root_store, false, &[])
    }
}

#[allow(clippy::too_many_arguments)]
fn build_wtransport_client_config(
    insecure_skip_verify: bool,
    ca_pem: Option<&str>,
    pinned_hashes: &[[u8; 32]],
    congestion_control: CongestionControlMode,
    idle_timeout_ms: u64,
    keep_alive_interval_ms: u64,
    qpack_max_table_capacity: u64,
    limits: &crate::limits::Limits,
) -> std::result::Result<wtransport::ClientConfig, Box<dyn std::error::Error + Send + Sync>> {
    let transport_config = build_quic_transport_config(
        congestion_control,
        idle_timeout_ms,
        keep_alive_interval_ms,
        limits,
    );

    let tls_config = build_client_tls_parts(insecure_skip_verify, ca_pem, pinned_hashes)
        .map_err(std::io::Error::other)?;
    Ok(wtransport::ClientConfig::builder()
        .with_bind_default()
        .with_custom_tls_and_transport(tls_config, transport_config)
        .qpack_max_table_capacity(qpack_max_table_capacity)
        .build())
}

/// Insecure client config for Rust loopback coverage tests only.
#[cfg(test)]
pub(crate) fn insecure_loopback_client_config(
) -> std::result::Result<wtransport::ClientConfig, Box<dyn std::error::Error + Send + Sync>> {
    build_wtransport_client_config(
        true,
        None,
        &[],
        CongestionControlMode::Default,
        60_000,
        10_000,
        0,
        &crate::limits::Limits::default(),
    )
}

#[napi]
#[derive(Clone)]
pub struct ClientSessionHandle {
    id: String,
    peer_ip: String,
    peer_port: u32,
    dgram_send_tx: Option<mpsc::Sender<Vec<u8>>>,
    dgram_recv_rx: Arc<TokioMutex<mpsc::Receiver<Vec<u8>>>>,
    datagram_budget_bytes: u64,
    backpressure_timeout_ms: u64,
    max_datagram_size: usize,
    stream_open_bi_tx: Option<mpsc::Sender<OpenBiReq>>,
    stream_open_uni_tx: Option<mpsc::Sender<OpenUniReq>>,
    stream_accept_bi_tx: Option<mpsc::Sender<AcceptBiReq>>,
    stream_accept_uni_tx: Option<mpsc::Sender<AcceptUniReq>>,
    close_tx: Option<Arc<watch::Sender<(u32, String)>>>,
    client_metrics: Arc<ClientMetrics>,
    closed: Arc<AtomicBool>,
    /// Fired once, on either close origin, right after the sticky `closed`
    /// store. Dedicated to datagram lifecycle: a shared capacity notify would
    /// wake parked readers proportionally to send rate on the exact hot path
    /// batching exists to relieve.
    datagram_lifecycle_notify: Arc<Notify>,
    /// Connection handle for wire-level stats (None for detached/test handles).
    conn: Option<wtransport::Connection>,
    /// 0-RTT status for this connect (None when enable0Rtt was off).
    zero_rtt: Option<crate::zero_rtt::ZeroRttHandleState>,
}

#[napi]
impl ClientSessionHandle {
    #[napi(getter)]
    pub fn id(&self) -> String {
        self.id.clone()
    }

    #[napi(getter)]
    pub fn peer_ip(&self) -> String {
        self.peer_ip.clone()
    }

    #[napi(getter)]
    pub fn peer_port(&self) -> u32 {
        self.peer_port
    }

    /// Whether this connect offered early data (a 0-RTT-capable resumption
    /// ticket was consumed for it). False when enable0Rtt was off or there
    /// was nothing to resume.
    #[napi(getter, js_name = "has0Rtt")]
    pub fn has_0rtt(&self) -> bool {
        self.zero_rtt.as_ref().is_some_and(|z| z.has_0rtt)
    }

    /// Whether the server accepted this connect's early data. False until the
    /// handshake completes; stays false when early data was refused (the
    /// session then completed over a normal 1-RTT recovery).
    #[napi(getter, js_name = "accepted0Rtt")]
    pub fn accepted_0rtt(&self) -> bool {
        self.zero_rtt
            .as_ref()
            .is_some_and(|z| z.has_0rtt && z.accepted.get().copied() == Some(true))
    }

    /// Whether the TLS handshake has completed. Always true for non-0-RTT
    /// connects (connect resolves post-handshake); for 0-RTT connects this
    /// flips once full cryptographic guarantees are in place.
    #[napi(getter, js_name = "handshakeConfirmed")]
    pub fn handshake_confirmed(&self) -> bool {
        match self.zero_rtt.as_ref() {
            Some(z) => z.accepted.get().is_some(),
            None => true,
        }
    }

    /// Real QUIC transport stats (rtt, wire bytes, packet counts).
    #[napi]
    pub fn connection_stats(&self) -> WtResult<Option<crate::metrics::QuicConnectionStats>> {
        if self.closed.load(Ordering::Relaxed) {
            return Ok(None);
        }
        Ok(self.conn.as_ref().map(crate::metrics::quic_stats_from_conn))
    }

    /// Current max datagram payload size for the path (MTU-derived), if known.
    #[napi]
    pub fn path_max_datagram_size(&self) -> WtResult<Option<u32>> {
        Ok(self
            .conn
            .as_ref()
            .and_then(|c| c.max_datagram_size())
            .map(|n| n as u32))
    }

    /// Never rejects: rejected async napi calls leak a strong self-ref on
    /// this SESSION handle under Bun, so errors resolve as their code
    /// string (null on success) and the TS layer throws.
    #[napi]
    pub async fn send_datagram(&self, data: napi::bindgen_prelude::Buffer) -> Option<String> {
        match self.send_datagram_inner(data).await {
            Ok(()) => None,
            Err(error) => Some(error.reason.clone()),
        }
    }

    async fn send_datagram_inner(&self, data: napi::bindgen_prelude::Buffer) -> Result<()> {
        if self.closed.load(Ordering::Relaxed) {
            return Err(napi::Error::from_reason("E_SESSION_CLOSED"));
        }
        let Some(ref tx) = self.dgram_send_tx else {
            return Err(napi::Error::from_reason("E_SESSION_CLOSED"));
        };
        let bytes = data.to_vec();
        if bytes.len() > self.max_datagram_size {
            return Err(napi::Error::from_reason("E_QUEUE_FULL"));
        }
        let sz = bytes.len() as u64;
        if !try_reserve_client_queued_bytes(&self.client_metrics, self.datagram_budget_bytes, sz) {
            return Err(napi::Error::from_reason("E_QUEUE_FULL"));
        }
        let timeout = tokio::time::Duration::from_millis(self.backpressure_timeout_ms);
        let result = tokio::time::timeout(timeout, tx.send(bytes)).await;
        match result {
            Ok(Ok(())) => Ok(()),
            Ok(Err(_send_err)) => {
                self.client_metrics
                    .queued_bytes
                    .fetch_sub(sz, Ordering::Relaxed);
                crate::report_channel_failure("client datagram enqueue");
                Err(napi::Error::from_reason("E_SESSION_CLOSED"))
            }
            Err(_elapsed) => {
                self.client_metrics
                    .queued_bytes
                    .fetch_sub(sz, Ordering::Relaxed);
                Err(napi::Error::from_reason("E_BACKPRESSURE_TIMEOUT"))
            }
        }
    }

    /// Read one datagram, or `null` on EOF or close.
    ///
    /// Spawned rather than written as `async fn(&self)` for two reasons: a
    /// parked read must not hold an exclusive napi borrow of the handle (Bun
    /// rejects concurrent `async fn &self` calls, so a concurrent `close()`
    /// could not reach the direct wake path), and a rejected async napi method
    /// leaks its self-reference under Bun, so no data, EOF, or closure may
    /// become an `Err`.
    #[napi(ts_return_type = "Promise<Uint8Array | null>")]
    pub fn read_datagram(&self, env: Env) -> Result<JsObject> {
        let state = self.datagram_read_state();
        env.spawn_future(async move {
            CLIENT_RUNTIME
                .spawn(async move {
                    Ok(state
                        .read_one()
                        .await
                        .map(crate::payload_buffer::PayloadBuffer::from))
                })
                .await
                .map_err(wt_from_upstream_error)?
        })
    }

    /// Read up to `max` datagrams with a single delivery call.
    ///
    /// Blocks for the first datagram, then takes whatever else is already
    /// queued, which amortizes the N-API round trip across the batch. `max` is
    /// clamped into 1..=256 silently, and a closed session or a closed queue
    /// resolves `null` — never a rejection and never an empty array.
    #[napi(ts_return_type = "Promise<Uint8Array[] | null>")]
    pub fn read_datagram_batch(&self, env: Env, max: u32) -> Result<JsObject> {
        let state = self.datagram_read_state();
        env.spawn_future(async move {
            CLIENT_RUNTIME
                .spawn(async move {
                    Ok(state.read_batch(max).await.map(|batch| {
                        batch
                            .into_iter()
                            .map(crate::payload_buffer::PayloadBuffer::from)
                            .collect::<Vec<_>>()
                    }))
                })
                .await
                .map_err(wt_from_upstream_error)?
        })
    }

    #[napi]
    pub fn close(&self, code: Option<u32>, reason: Option<String>) -> WtResult<()> {
        self.initiate_close(code.unwrap_or(0), reason.unwrap_or_default());
        Ok(())
    }

    /// Tell the peer this session is going away soon, without ending it.
    ///
    /// Sends a `WT_DRAIN_SESSION` capsule; the session stays fully usable.
    #[napi]
    pub fn drain(&self) -> WtResult<()> {
        if let Some(ref conn) = self.conn {
            conn.drain_session();
        }
        Ok(())
    }

    /// Resolves once the peer says this session is going away.
    ///
    /// Settles on a received `WT_DRAIN_SESSION` or `GOAWAY`, and immediately if
    /// one already arrived. The session stays usable: this is a warning, not an
    /// ending. Spawned rather than written as `async fn(&self)` so a wait that
    /// may never settle does not hold an exclusive napi borrow of the handle and
    /// block every other call on it.
    #[napi(ts_return_type = "Promise<void>")]
    pub fn wait_draining(&self, env: Env) -> Result<JsObject> {
        let conn = self.conn.clone();
        env.spawn_future(async move {
            let Some(conn) = conn else { return Ok(()) };
            CLIENT_RUNTIME
                .spawn(async move { conn.draining().await })
                .await
                .map_err(wt_from_upstream_error)?;
            Ok(())
        })
    }

    #[napi]
    pub fn metrics_snapshot(&self) -> WtResult<crate::metrics::SessionMetricsSnapshot> {
        Ok(crate::metrics::SessionMetricsSnapshot {
            datagrams_in: self.client_metrics.datagrams_in.load(Ordering::Relaxed) as f64,
            datagrams_out: self.client_metrics.datagrams_out.load(Ordering::Relaxed) as f64,
            streams_active: self.client_metrics.streams_active.load(Ordering::Relaxed) as u32,
            queued_bytes: self.client_metrics.queued_bytes.load(Ordering::Relaxed) as f64,
        })
    }

    /// Never rejects (see send_datagram): resolves the handle, or the error
    /// code string.
    #[napi]
    pub async fn create_bidi_stream(
        &self,
    ) -> napi::bindgen_prelude::Either<ClientBidiStreamHandle, String> {
        use napi::bindgen_prelude::Either;
        match self.create_bidi_stream_inner().await {
            Ok(handle) => Either::A(handle),
            Err(error) => Either::B(error.reason.clone()),
        }
    }

    async fn create_bidi_stream_inner(&self) -> Result<ClientBidiStreamHandle> {
        let Some(ref tx) = self.stream_open_bi_tx else {
            return Err(napi::Error::from_reason("E_SESSION_CLOSED"));
        };
        let (resp_tx, resp_rx) = oneshot::channel();
        tx.send(resp_tx)
            .await
            .map_err(|_| napi::Error::from_reason("E_SESSION_CLOSED"))?;
        resp_rx
            .await
            .map_err(|_| napi::Error::from_reason("E_SESSION_CLOSED"))?
            .map_err(wt_from_upstream_error)
    }

    /// Never rejects (see send_datagram): resolves the handle, or the error
    /// code string.
    #[napi]
    pub async fn create_uni_stream(
        &self,
    ) -> napi::bindgen_prelude::Either<ClientUniSendHandle, String> {
        use napi::bindgen_prelude::Either;
        match self.create_uni_stream_inner().await {
            Ok(handle) => Either::A(handle),
            Err(error) => Either::B(error.reason.clone()),
        }
    }

    async fn create_uni_stream_inner(&self) -> Result<ClientUniSendHandle> {
        let Some(ref tx) = self.stream_open_uni_tx else {
            return Err(napi::Error::from_reason("E_SESSION_CLOSED"));
        };
        let (resp_tx, resp_rx) = oneshot::channel();
        tx.send(resp_tx)
            .await
            .map_err(|_| napi::Error::from_reason("E_SESSION_CLOSED"))?;
        resp_rx
            .await
            .map_err(|_| napi::Error::from_reason("E_SESSION_CLOSED"))?
            .map_err(wt_from_upstream_error)
    }

    #[napi]
    pub async fn accept_bidi_stream(&self) -> Result<Option<ClientBidiStreamHandle>> {
        let Some(ref tx) = self.stream_accept_bi_tx else {
            return Err(napi::Error::from_reason("E_SESSION_CLOSED"));
        };
        let (resp_tx, resp_rx) = oneshot::channel();
        tx.send(resp_tx)
            .await
            .map_err(|_| napi::Error::from_reason("E_SESSION_CLOSED"))?;
        match resp_rx
            .await
            .map_err(|_| napi::Error::from_reason("E_SESSION_CLOSED"))?
        {
            Ok(h) => Ok(Some(h)),
            Err(e) if e == "E_SESSION_CLOSED" => Ok(None),
            Err(e) => Err(wt_from_upstream_error(e)),
        }
    }

    #[napi]
    pub async fn accept_uni_stream(&self) -> Result<Option<ClientUniRecvHandle>> {
        let Some(ref tx) = self.stream_accept_uni_tx else {
            return Err(napi::Error::from_reason("E_SESSION_CLOSED"));
        };
        let (resp_tx, resp_rx) = oneshot::channel();
        tx.send(resp_tx)
            .await
            .map_err(|_| napi::Error::from_reason("E_SESSION_CLOSED"))?;
        match resp_rx
            .await
            .map_err(|_| napi::Error::from_reason("E_SESSION_CLOSED"))?
        {
            Ok(h) => Ok(Some(h)),
            Err(e) if e == "E_SESSION_CLOSED" => Ok(None),
            Err(e) => Err(wt_from_upstream_error(e)),
        }
    }
}

impl ClientSessionHandle {
    /// Clone everything a read needs out of the handle, so the wait itself
    /// borrows nothing from it.
    pub(crate) fn datagram_read_state(&self) -> ClientDatagramReadState {
        ClientDatagramReadState {
            rx: Arc::clone(&self.dgram_recv_rx),
            metrics: Arc::clone(&self.client_metrics),
            closed: Arc::clone(&self.closed),
            lifecycle_notify: Arc::clone(&self.datagram_lifecycle_notify),
        }
    }

    /// Synchronous by necessity — it is called from napi entrypoints and from
    /// callback-failure cleanup, neither of which can await. It therefore only
    /// stores the flag and wakes; the byte drain belongs to the reader and to
    /// the terminal task, which can.
    fn initiate_close(&self, code: u32, reason: String) {
        mark_client_closed_and_notify(&self.closed, &self.datagram_lifecycle_notify);
        if let Some(ref tx) = self.close_tx {
            if tx.send((code, reason.clone())).is_err() {
                crate::report_channel_closed("client close signal");
            }
        }
        if let Some(ref conn) = self.conn {
            conn.close_session(code, &reason);
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn spawn_session_task(
        id: String,
        peer_ip: String,
        peer_port: u32,
        conn: wtransport::Connection,
        _release_guard: Option<PoolReleaseGuard>,
        on_closed: Option<ThreadsafeFunction<ClientSessionClosed, ErrorStrategy::Fatal>>,
        backpressure_timeout_ms: u64,
        limits: crate::limits::Limits,
        zero_rtt: Option<crate::zero_rtt::ZeroRttHandleState>,
    ) -> Self {
        let (dgram_send_tx, mut dgram_send_rx) = mpsc::channel::<Vec<u8>>(256);
        let (dgram_recv_tx, dgram_recv_rx) =
            mpsc::channel::<Vec<u8>>(CLIENT_DATAGRAM_RECV_CAPACITY);
        let dgram_recv_rx = Arc::new(TokioMutex::new(dgram_recv_rx));
        let (open_bi_tx, mut open_bi_rx) = mpsc::channel::<OpenBiReq>(8);
        let (open_uni_tx, mut open_uni_rx) = mpsc::channel::<OpenUniReq>(8);
        let (accept_bi_tx, accept_bi_rx) = mpsc::channel::<AcceptBiReq>(8);
        let (accept_uni_tx, accept_uni_rx) = mpsc::channel::<AcceptUniReq>(8);
        let (close_tx, mut close_rx) = watch::channel((0u32, String::new()));
        let cm = Arc::new(ClientMetrics::default());
        let closed_flag = Arc::new(AtomicBool::new(false));
        let lifecycle_notify = Arc::new(Notify::new());

        let budget_metrics = Arc::new(ServerMetrics::default());
        let session_metrics = Arc::new(SessionMetrics::default());
        let max_global = limits.max_queued_bytes_global;
        let max_session = limits.max_queued_bytes_per_session;
        let max_stream = limits.max_queued_bytes_per_stream;
        let datagram_budget_bytes = std::cmp::min(max_global, max_session);

        let handle = Self {
            id: id.clone(),
            peer_ip: peer_ip.clone(),
            peer_port,
            dgram_send_tx: Some(dgram_send_tx.clone()),
            dgram_recv_rx: Arc::clone(&dgram_recv_rx),
            datagram_budget_bytes,
            backpressure_timeout_ms,
            max_datagram_size: limits.max_datagram_size,
            stream_open_bi_tx: Some(open_bi_tx),
            stream_open_uni_tx: Some(open_uni_tx),
            stream_accept_bi_tx: Some(accept_bi_tx),
            stream_accept_uni_tx: Some(accept_uni_tx),
            close_tx: Some(Arc::new(close_tx)),
            client_metrics: Arc::clone(&cm),
            closed: Arc::clone(&closed_flag),
            datagram_lifecycle_notify: Arc::clone(&lifecycle_notify),
            conn: Some(conn.clone()),
            zero_rtt,
        };

        let conn_bi = conn.clone();
        let conn_uni = conn.clone();
        let conn_accept_bi = conn.clone();
        let conn_accept_uni = conn.clone();
        let make_budget = {
            let bm = Arc::clone(&budget_metrics);
            let sm = Arc::clone(&session_metrics);
            move || StreamBudget {
                server_metrics: Arc::clone(&bm),
                session_metrics: Arc::clone(&sm),
                stream_queued: Arc::new(AtomicU64::new(0)),
                max_global,
                max_session,
                max_stream,
                capacity_notify: StreamBudget::new_notify(),
                backpressure_timeout_ms,
            }
        };

        CLIENT_RUNTIME.spawn(async move {
            let _guard = _release_guard;
            let conn_dgram_send = conn.clone();
            let conn_dgram_recv = conn.clone();
            let conn_closed = conn.clone();

            let cm_send = Arc::clone(&cm);
            crate::panic_guard::spawn_quic_task_scoped(crate::panic_guard::PanicScope::Conn(conn.clone()), async move {
                while let Some(bytes) = dgram_send_rx.recv().await {
                    let sz = bytes.len() as u64;
                    cm_send.queued_bytes.fetch_sub(sz, Ordering::Relaxed);
                    match conn_dgram_send.send_datagram(bytes.as_slice()) {
                        Ok(_) => {
                            cm_send.datagrams_out.fetch_add(1, Ordering::Relaxed);
                        }
                        Err(wtransport::error::SendDatagramError::NotConnected) => break,
                        Err(wtransport::error::SendDatagramError::UnsupportedByPeer) => break,
                        Err(wtransport::error::SendDatagramError::TooLarge) => break,
                    }
                }
                // The loop can break with datagrams still buffered; release
                // their reserved bytes so the reservation is not stranded in
                // `queued_bytes` until the handle is dropped.
                while let Ok(bytes) = dgram_send_rx.try_recv() {
                    cm_send
                        .queued_bytes
                        .fetch_sub(bytes.len() as u64, Ordering::Relaxed);
                }
            });

            let cm_recv = Arc::clone(&cm);
            let recv_budget_bytes = datagram_budget_bytes;
            let recv_rx = Arc::clone(&dgram_recv_rx);
            let recv_closed = Arc::clone(&closed_flag);
            let recv_notify = Arc::clone(&lifecycle_notify);
            let (forwarder_done, forwarder_exited) = ForwarderDoneGuard::new();
            crate::panic_guard::spawn_quic_task_scoped(crate::panic_guard::PanicScope::Conn(conn.clone()), async move {
                let _done = forwarder_done;
                let source = &conn_dgram_recv;
                run_client_datagram_forwarder(
                    move || async move {
                        source
                            .receive_datagram()
                            .await
                            .ok()
                            .map(|dgram| dgram.as_ref().to_vec())
                    },
                    dgram_recv_tx,
                    recv_rx,
                    cm_recv,
                    recv_budget_bytes,
                    recv_closed,
                    recv_notify,
                )
                .await;
            });

            let cm_bi = Arc::clone(&cm);
            let make_budget_bi = make_budget.clone();
            crate::panic_guard::spawn_quic_task_scoped(crate::panic_guard::PanicScope::Conn(conn.clone()), async move {
                while let Some(resp_tx) = open_bi_rx.recv().await {
                    let r = match conn_bi.open_bi().await {
                        Ok(opening) => match opening.await {
                            Ok((send, recv)) => {
                                cm_bi.streams_active.fetch_add(1, Ordering::Relaxed);
                                let guard = crate::client_stream::StreamGuard::client(
                                    Arc::clone(&cm_bi),
                                );
                                let budget = make_budget_bi();
                                let (read_rx, write_tx, stop_tx, write_err_slot, read_err_slot) =
                                    spawn_bidi_bridge_on(
                                        &CLIENT_RUNTIME,
                                        send,
                                        recv,
                                        Some(guard),
                                        Some(budget.clone()),
                                    );
                                Ok(ClientBidiStreamHandle::new_with_budget_and_slot(
                                    read_rx,
                                    write_tx,
                                    stop_tx,
                                    Some(budget),
                                    write_err_slot,
                                    read_err_slot,
                                ))
                            }
                            Err(e) => Err(wt_from_upstream_error(e.to_string()).to_string()),
                        },
                        Err(e) => Err(wt_from_upstream_error(e.to_string()).to_string()),
                    };
                    if resp_tx.send(r).is_err() {
                        crate::report_channel_failure("client open_bidi response");
                    }
                }
            });

            let cm_uni = Arc::clone(&cm);
            let make_budget_uni = make_budget.clone();
            crate::panic_guard::spawn_quic_task_scoped(crate::panic_guard::PanicScope::Conn(conn.clone()), async move {
                while let Some(resp_tx) = open_uni_rx.recv().await {
                    let r = match conn_uni.open_uni().await {
                        Ok(opening) => match opening.await {
                            Ok(send) => {
                                cm_uni.streams_active.fetch_add(1, Ordering::Relaxed);
                                let guard = crate::client_stream::StreamGuard::client(
                                    Arc::clone(&cm_uni),
                                );
                                let budget = make_budget_uni();
                                let (write_tx, write_err_slot) = spawn_uni_send_bridge_on(
                                    &CLIENT_RUNTIME,
                                    send,
                                    Some(guard),
                                    Some(budget.clone()),
                                );
                                Ok(ClientUniSendHandle::new_with_budget_and_slot(
                                    write_tx,
                                    Some(budget),
                                    write_err_slot,
                                ))
                            }
                            Err(e) => Err(wt_from_upstream_error(e.to_string()).to_string()),
                        },
                        Err(e) => Err(wt_from_upstream_error(e.to_string()).to_string()),
                    };
                    if resp_tx.send(r).is_err() {
                        crate::report_channel_failure("client open_uni response");
                    }
                }
            });

            let mut accept_bi_rx = accept_bi_rx;
            let cm_accept_bi = Arc::clone(&cm);
            let make_budget_accept_bi = make_budget.clone();
            crate::panic_guard::spawn_quic_task_scoped(crate::panic_guard::PanicScope::Conn(conn.clone()), async move {
                while let Some(resp_tx) = accept_bi_rx.recv().await {
                    let r = match conn_accept_bi.accept_bi().await {
                        Ok((send, recv)) => {
                            cm_accept_bi.streams_active.fetch_add(1, Ordering::Relaxed);
                            let guard = crate::client_stream::StreamGuard::client(
                                Arc::clone(&cm_accept_bi),
                            );
                            let budget = make_budget_accept_bi();
                            let (read_rx, write_tx, stop_tx, write_err_slot, read_err_slot) =
                                spawn_bidi_bridge_on(
                                    &CLIENT_RUNTIME,
                                    send,
                                    recv,
                                    Some(guard),
                                    Some(budget.clone()),
                                );
                            Ok(ClientBidiStreamHandle::new_with_budget_and_slot(
                                read_rx,
                                write_tx,
                                stop_tx,
                                Some(budget),
                                write_err_slot,
                                read_err_slot,
                            ))
                        }
                        Err(e) => Err(wt_from_upstream_error(e.to_string()).to_string()),
                    };
                    if resp_tx.send(r).is_err() {
                        crate::report_channel_failure("client accept_bidi response");
                    }
                }
            });

            let mut accept_uni_rx_local = accept_uni_rx;
            let cm_accept_uni = Arc::clone(&cm);
            let make_budget_accept_uni = make_budget.clone();
            crate::panic_guard::spawn_quic_task_scoped(crate::panic_guard::PanicScope::Conn(conn.clone()), async move {
                while let Some(resp_tx) = accept_uni_rx_local.recv().await {
                    let r = match conn_accept_uni.accept_uni().await {
                        Ok(recv) => {
                            cm_accept_uni.streams_active.fetch_add(1, Ordering::Relaxed);
                            let guard = crate::client_stream::StreamGuard::client(
                                Arc::clone(&cm_accept_uni),
                            );
                            let budget = make_budget_accept_uni();
                            let (read_rx, stop_tx, read_err_slot) = spawn_uni_recv_bridge_on(
                                &CLIENT_RUNTIME,
                                recv,
                                Some(guard),
                                Some(budget),
                            );
                            Ok(ClientUniRecvHandle::new_with_slot(
                                read_rx,
                                stop_tx,
                                read_err_slot,
                            ))
                        }
                        Err(e) => Err(wt_from_upstream_error(e.to_string()).to_string()),
                    };
                    if resp_tx.send(r).is_err() {
                        crate::report_channel_failure("client accept_uni response");
                    }
                }
            });

            let (close_code, close_reason) = tokio::select! {
                close_err = conn_closed.closed() => {
                    crate::resolve_close_info(&conn_closed, &close_err).await
                }
                _ = close_rx.changed() => {
                    let (code, reason) = close_rx.borrow().clone();
                    conn_closed.close_session(code, &reason);
                    (Some(code), Some(reason))
                }
            };
            settle_client_receive_accounting_after_close(
                &dgram_recv_rx,
                &cm,
                &closed_flag,
                &lifecycle_notify,
                forwarder_exited,
                || {
                    finalize_client_terminal_state(
                        &id,
                        &closed_flag,
                        &lifecycle_notify,
                        close_code,
                        close_reason,
                        on_closed.as_ref(),
                    );
                },
            )
            .await;
        });

        handle
    }
}

/// Connect to a WebTransport server. Calls callback(err, handleId) when done.
/// On success, use takeClientSession(handleId) to get the handle.
#[napi]
pub fn connect(
    url: String,
    opts_json: String,
    on_closed: JsFunction,
    callback: JsFunction,
) -> Result<()> {
    crate::panic_guard::catch_panic(|| connect_inner(url, opts_json, on_closed, callback))
}

fn connect_inner(
    url: String,
    opts_json: String,
    on_closed: JsFunction,
    callback: JsFunction,
) -> Result<()> {
    let on_closed_tsfn: ThreadsafeFunction<ClientSessionClosed, ErrorStrategy::Fatal> = on_closed
        .create_threadsafe_function(
            0,
            |ctx: napi::threadsafe_function::ThreadSafeCallContext<ClientSessionClosed>| {
                let v = &ctx.value;
                let mut evt = ctx.env.create_object()?;
                evt.set("name", "session_closed")?;
                evt.set("id", v.id.as_str())?;
                if let Some(c) = v.code {
                    evt.set("code", c)?;
                }
                if let Some(r) = &v.reason {
                    evt.set("reason", r.as_str())?;
                }
                let mut arr = ctx.env.create_array_with_length(1)?;
                arr.set_element(0, evt)?;
                Ok(vec![arr])
            },
        )
        .map_err(|e| {
            napi::Error::from_reason(format!(
                "E_INTERNAL: failed to create client onClosed callback bridge: {}",
                e
            ))
        })?;

    let callback_tsfn: ThreadsafeFunction<ConnectResult, ErrorStrategy::Fatal> = callback
        .create_threadsafe_function(
            0,
            |ctx: napi::threadsafe_function::ThreadSafeCallContext<ConnectResult>| match &ctx.value
            {
                ConnectResult::Ok(handle_id) => {
                    let null = ctx.env.get_null()?.into_unknown();
                    let id_val = ctx.env.create_string(handle_id)?.into_unknown();
                    Ok(vec![null, id_val])
                }
                ConnectResult::Err(msg) => {
                    let err_str = ctx.env.create_string(msg)?.into_unknown();
                    let undef = ctx.env.get_undefined()?.into_unknown();
                    Ok(vec![err_str, undef])
                }
            },
        )?;

    let client_limits = parse_client_limits(&opts_json).map_err(napi::Error::from_reason)?;
    let bp_timeout_ms = client_limits.backpressure_timeout_ms;

    CLIENT_RUNTIME.spawn(async move {
        let result = match run_connect(&url, opts_json)
            .await
            .map_err(|e| wt_from_upstream_error(e.to_string()))
            .map(|(id, peer_ip, peer_port, conn, release_guard, zero_rtt)| {
                let handle = ClientSessionHandle::spawn_session_task(
                    id.clone(),
                    peer_ip,
                    peer_port,
                    conn,
                    release_guard,
                    Some(on_closed_tsfn),
                    bp_timeout_ms,
                    client_limits,
                    zero_rtt,
                );
                let insertion = insert_registry_entry(&CLIENT_HANDLE_REGISTRY, handle);
                if insertion.poison_recovered {
                    report_client_registry_recovery("connect registry insert", &id);
                }
                id
            }) {
            std::result::Result::Ok(id) => ConnectResult::Ok(id),
            std::result::Result::Err(msg) => ConnectResult::Err(msg.to_string()),
        };
        let success_id = match &result {
            ConnectResult::Ok(id) => Some(id.clone()),
            ConnectResult::Err(_) => None,
        };
        let status = callback_tsfn.call(result, ThreadsafeFunctionCallMode::NonBlocking);
        handle_connect_callback_status(success_id.as_deref(), status);
    });

    Ok(())
}

/// Take the client session handle from the registry. Call after connect callback succeeds.
#[napi]
pub fn take_client_session(handle_id: String) -> Result<Option<ClientSessionHandle>> {
    crate::panic_guard::catch_panic(|| take_client_session_inner(handle_id))
}

fn take_client_session_inner(handle_id: String) -> Result<Option<ClientSessionHandle>> {
    let mut reg = CLIENT_HANDLE_REGISTRY
        .lock()
        .map_err(|_| napi::Error::from_reason("registry lock poisoned"))?;
    Ok(reg.remove(&handle_id))
}

const DEFAULT_HANDSHAKE_TIMEOUT_MS: u64 = 10_000;

/// Resolver that returns a fixed SocketAddr, used when serverName overrides an IP host
/// so we connect to the original IP while using serverName for TLS SNI.
#[derive(Clone, Debug)]
struct StaticSocketResolver(std::net::SocketAddr);

impl wtransport::config::DnsResolver for StaticSocketResolver {
    fn resolve(&self, _host: &str) -> std::pin::Pin<Box<dyn wtransport::config::DnsLookupFuture>> {
        let addr = self.0;
        Box::pin(async move { Ok(Some(addr)) })
    }
}

/// Build (connect_url, optional custom resolver). When serverName is provided and the
/// original URL host is an IP, we use a custom resolver so we connect to that IP
/// while using serverName for TLS SNI (avoids DNS resolution of serverName which can
/// return ::1 and cause connection failures).
fn connect_url_and_resolver(
    url: &str,
    server_name: Option<&str>,
) -> std::result::Result<(String, Option<StaticSocketResolver>), String> {
    let parsed = url::Url::parse(url).map_err(|e| format!("E_TLS: invalid URL: {}", e))?;
    let port = parsed.port().unwrap_or(443);
    let path = parsed.path();
    let path_query = if path.is_empty() {
        "/".to_string()
    } else {
        format!(
            "{}{}",
            path,
            parsed.query().map(|q| format!("?{q}")).unwrap_or_default()
        )
    };

    let (connect_url, resolver) = match (parsed.host_str(), server_name) {
        (Some(host), Some(sni)) if !sni.is_empty() => {
            if let Ok(ip) = host.parse::<std::net::IpAddr>() {
                let addr = SocketAddr::new(ip, port);
                let connect_url = format!("https://{sni}:{port}{path_query}");
                (connect_url, Some(StaticSocketResolver(addr)))
            } else {
                let mut p = parsed.clone();
                p.set_host(Some(sni))
                    .map_err(|_| format!("E_TLS: invalid serverName for SNI: {}", sni))?;
                (p.to_string(), None)
            }
        }
        _ => (url.to_string(), None),
    };

    Ok((connect_url, resolver))
}

/// Build a RootCertStore from native certs plus optional caPem.
fn build_root_cert_store(
    ca_pem: Option<&str>,
) -> std::result::Result<std::sync::Arc<rustls::RootCertStore>, String> {
    use rustls::pki_types::pem::PemObject;

    let mut root_store = rustls::RootCertStore::empty();

    // Add platform native certs (best-effort)
    let native = rustls_native_certs::load_native_certs();
    for cert in native.certs {
        let _ = root_store.add(cert);
    }

    // Add custom CA(s) from caPem
    if let Some(pem) = ca_pem {
        let mut parsed = 0u32;
        let mut added = 0u32;
        for item in rustls::pki_types::CertificateDer::pem_slice_iter(pem.as_bytes()) {
            match item {
                Ok(der) => {
                    parsed += 1;
                    if root_store.add(der).is_ok() {
                        added += 1;
                    }
                }
                Err(e) => return Err(format!("E_TLS: invalid CA PEM: {}", e)),
            }
        }
        if added == 0 {
            if parsed == 0 {
                return Err("E_TLS: no valid CA certificate found in caPem".to_string());
            }
            return Err("E_TLS: CA PEM parsed but no certificates were accepted".to_string());
        }
    }

    Ok(std::sync::Arc::new(root_store))
}

/// Build a rustls ClientConfig for WebTransport with the given root store.
fn build_client_tls_config(
    root_store: std::sync::Arc<rustls::RootCertStore>,
    insecure_skip_verify: bool,
    pinned_hashes: &[[u8; 32]],
) -> std::result::Result<rustls::ClientConfig, String> {
    use std::sync::Arc;

    let provider = Arc::new(rustls::crypto::ring::default_provider());

    let mut config = rustls::ClientConfig::builder_with_provider(Arc::clone(&provider))
        .with_protocol_versions(&[&rustls::version::TLS13])
        .map_err(|e| format!("E_TLS: failed to configure TLS versions: {}", e))?
        .with_root_certificates(Arc::clone(&root_store))
        .with_no_client_auth();

    if insecure_skip_verify {
        config
            .dangerous()
            .set_certificate_verifier(Arc::new(InsecureVerifier));
    } else if !pinned_hashes.is_empty() {
        config
            .dangerous()
            .set_certificate_verifier(Arc::new(PinnedCertVerifier {
                pins: pinned_hashes.to_vec(),
                provider,
            }));
    }

    config.alpn_protocols = vec![wtransport::proto::WEBTRANSPORT_ALPN.to_vec()];
    Ok(config)
}

/// Insecure verifier for dev-only insecureSkipVerify.
#[derive(Debug)]
struct InsecureVerifier;

impl rustls::client::danger::ServerCertVerifier for InsecureVerifier {
    fn verify_server_cert(
        &self,
        _end_entity: &rustls::pki_types::CertificateDer<'_>,
        _intermediates: &[rustls::pki_types::CertificateDer<'_>],
        _server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> std::result::Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> std::result::Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &rustls::crypto::ring::default_provider().signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> std::result::Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &rustls::crypto::ring::default_provider().signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        rustls::crypto::ring::default_provider()
            .signature_verification_algorithms
            .supported_schemes()
    }
}

/// W3C serverCertificateHashes semantics: the pin REPLACES chain/hostname
/// verification (its purpose is accepting self-signed certs). Guardrails kept
/// from the spec's custom-verification rules: the cert must be currently valid
/// and its total validity window must not exceed 14 days.
#[derive(Debug)]
struct PinnedCertVerifier {
    pins: Vec<[u8; 32]>,
    provider: Arc<rustls::crypto::CryptoProvider>,
}

const MAX_PINNED_CERT_VALIDITY_SECS: i64 = 14 * 24 * 60 * 60;

impl rustls::client::danger::ServerCertVerifier for PinnedCertVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &rustls::pki_types::CertificateDer<'_>,
        _intermediates: &[rustls::pki_types::CertificateDer<'_>],
        _server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp_response: &[u8],
        now: rustls::pki_types::UnixTime,
    ) -> std::result::Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        let mut hasher = Sha256::new();
        hasher.update(end_entity.as_ref());
        let actual: [u8; 32] = hasher.finalize().into();
        if !self.pins.iter().any(|p| p == &actual) {
            return Err(rustls::Error::General(
                "E_TLS: server certificate hash mismatch".to_string(),
            ));
        }
        // W3C custom-verification guardrails: currently valid, validity <= 14 days.
        let (_, cert) = x509_parser::parse_x509_certificate(end_entity.as_ref())
            .map_err(|_| rustls::Error::General("E_TLS: pinned certificate unparsable".into()))?;
        let now_secs = now.as_secs() as i64;
        let not_before = cert.validity().not_before.timestamp();
        let not_after = cert.validity().not_after.timestamp();
        if now_secs < not_before || now_secs > not_after {
            return Err(rustls::Error::General(
                "E_TLS: pinned certificate expired or not yet valid".to_string(),
            ));
        }
        if not_after - not_before > MAX_PINNED_CERT_VALIDITY_SECS {
            return Err(rustls::Error::General(
                "E_TLS: pinned certificate validity exceeds 14 days (W3C limit)".to_string(),
            ));
        }
        // W3C serverCertificateHashes requires the certificate use ECDSA over
        // NIST P-256. Enforce id-ecPublicKey (1.2.840.10045.2.1) with the
        // secp256r1/prime256v1 curve (1.2.840.10045.3.1.7); otherwise a
        // Chromium client would reject a cert our pin path would accept.
        let spki = &cert.public_key().algorithm;
        let is_ec = spki.algorithm.to_id_string() == "1.2.840.10045.2.1";
        let is_p256 = spki
            .parameters
            .as_ref()
            .and_then(|p| p.as_oid().ok())
            .map(|oid| oid.to_id_string() == "1.2.840.10045.3.1.7")
            .unwrap_or(false);
        if !is_ec || !is_p256 {
            return Err(rustls::Error::General(
                "E_TLS: pinned certificate must use ECDSA P-256 (W3C serverCertificateHashes)"
                    .to_string(),
            ));
        }
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> std::result::Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> std::result::Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

pub(crate) fn parse_server_certificate_hashes(
    opts: &serde_json::Value,
) -> std::result::Result<Vec<[u8; 32]>, String> {
    let mut out = Vec::new();
    let Some(arr) = opts
        .get("serverCertificateHashes")
        .and_then(|v| v.as_array())
    else {
        return Ok(out);
    };
    for entry in arr {
        let algorithm = entry
            .get("algorithm")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        if algorithm != "sha-256" {
            return Err(format!(
                "E_INTERNAL: serverCertificateHashes only supports algorithm \"sha-256\", got \"{}\"",
                algorithm
            ));
        }
        let value = entry
            .get("value")
            .and_then(|v| v.as_array())
            .ok_or_else(|| {
                "E_INTERNAL: serverCertificateHashes entry value must be a byte-array".to_string()
            })?;
        if value.len() != 32 {
            return Err(
                "E_INTERNAL: serverCertificateHashes value must be 32-byte SHA-256".to_string(),
            );
        }
        let mut pin = [0u8; 32];
        for (i, entry) in value.iter().enumerate() {
            let byte = entry
                .as_u64()
                .and_then(|v| u8::try_from(v).ok())
                .ok_or_else(|| {
                    "E_INTERNAL: serverCertificateHashes entry value must be a byte-array"
                        .to_string()
                })?;
            pin[i] = byte;
        }
        out.push(pin);
    }
    Ok(out)
}

/// Result of run_connect: session id, peer info, connection, optional pool
/// release guard, and 0-RTT status (None when enable0Rtt was off).
pub type RunConnectResult = (
    String,
    String,
    u32,
    wtransport::Connection,
    Option<PoolReleaseGuard>,
    Option<crate::zero_rtt::ZeroRttHandleState>,
);

async fn run_connect(
    url: &str,
    opts_json: String,
) -> std::result::Result<RunConnectResult, Box<dyn std::error::Error + Send + Sync>> {
    let opts = serde_json::from_str::<serde_json::Value>(&opts_json).unwrap_or_default();
    let client_limits = parse_client_limits(&opts_json).map_err(std::io::Error::other)?;

    let tls_opts = opts.get("tls");
    let insecure_skip_verify = tls_opts
        .and_then(|t| t.get("insecureSkipVerify")?.as_bool())
        .unwrap_or(false);

    let ca_pem = tls_opts
        .and_then(|t| t.get("caPem")?.as_str())
        .filter(|s| !s.is_empty());

    let server_name = tls_opts
        .and_then(|t| t.get("serverName")?.as_str())
        .filter(|s| !s.is_empty());
    let pinned_hashes = parse_server_certificate_hashes(&opts).map_err(std::io::Error::other)?;

    let allow_pooling = opts
        .get("allowPooling")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let require_unreliable = opts
        .get("requireUnreliable")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    if allow_pooling && !pinned_hashes.is_empty() {
        return Err(
            "E_INTERNAL: serverCertificateHashes cannot be used with allowPooling=true".into(),
        );
    }

    let enable_0rtt = opts
        .get("enable0Rtt")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    // Pooling reuses live connections; 0-RTT is about new-connection latency
    // and its has0Rtt/accepted0Rtt reporting is per-handshake. Combining the
    // two would silently report nothing, so reject loudly instead.
    if enable_0rtt && allow_pooling {
        return Err("E_INTERNAL: enable0Rtt cannot be used with allowPooling=true".into());
    }

    // QPACK dynamic-table capacity to advertise (0 = static-only, the default).
    let qpack_max_table_capacity =
        parse_qpack_max_table_capacity(&opts).map_err(napi::Error::from_reason)?;

    let handshake_timeout_ms = opts
        .get("limits")
        .and_then(|l| l.get("handshakeTimeoutMs")?.as_u64())
        .unwrap_or(DEFAULT_HANDSHAKE_TIMEOUT_MS);
    let idle_timeout_ms = opts
        .get("limits")
        .and_then(|l| l.get("idleTimeoutMs")?.as_u64())
        .unwrap_or(DEFAULT_CLIENT_IDLE_TIMEOUT_MS);
    // Keep-alive interval defaults to idle/3 so a live-but-quiet connection
    // survives (up to two lost pings) while a dead path still times out.
    let keep_alive_interval_ms = opts
        .get("limits")
        .and_then(|l| l.get("keepAliveIntervalMs")?.as_u64())
        .unwrap_or(idle_timeout_ms / 3);
    let congestion_control = parse_congestion_control(&opts).map_err(std::io::Error::other)?;

    let (connect_url, custom_resolver) =
        connect_url_and_resolver(url, server_name).map_err(std::io::Error::other)?;

    let id = format!(
        "client-{:016x}",
        CLIENT_SESSION_ID_COUNTER.fetch_add(1, Ordering::Relaxed) ^ *CLIENT_SESSION_ID_SEED
    );

    if allow_pooling {
        let parsed = url::Url::parse(url).map_err(|e| format!("E_TLS: invalid URL: {}", e))?;
        let pool_key = PoolKey {
            scheme: parsed.scheme().to_string(),
            host: parsed.host_str().unwrap_or("").to_string(),
            port: parsed.port().unwrap_or(443),
            sni: server_name.map(String::from),
            insecure_skip_verify,
            has_pinned_hashes: !pinned_hashes.is_empty(),
            ca_pem_fingerprint: client_pool::ca_pem_fingerprint(ca_pem),
            require_unreliable,
            congestion: opts
                .get("congestionControl")
                .and_then(|v| v.as_str())
                .unwrap_or("default")
                .to_string(),
        };
        let ca_pem_owned = ca_pem.map(String::from);
        let pinned_hashes_clone = pinned_hashes.clone();
        let client_limits_for_endpoint = client_limits.clone();
        let create_endpoint = move || {
            let mut config = build_wtransport_client_config(
                insecure_skip_verify,
                ca_pem_owned.as_deref(),
                pinned_hashes_clone.as_slice(),
                congestion_control,
                idle_timeout_ms,
                keep_alive_interval_ms,
                qpack_max_table_capacity,
                &client_limits_for_endpoint,
            )?;
            if let Some(resolver) = custom_resolver {
                config.set_dns_resolver(resolver);
            }
            wtransport::Endpoint::client(config).map_err(|e| e.into())
        };

        let (conn, release_guard, _was_hit) = CLIENT_POOL
            .acquire_connect(
                pool_key,
                &connect_url,
                handshake_timeout_ms,
                create_endpoint,
            )
            .await?;

        let addr = conn.remote_address();
        let peer_ip = addr.ip().to_string();
        let peer_port = addr.port() as u32;
        return Ok((id, peer_ip, peer_port, conn, Some(release_guard), None));
    }

    if enable_0rtt {
        return run_connect_0rtt(
            id,
            &connect_url,
            custom_resolver,
            insecure_skip_verify,
            ca_pem,
            pinned_hashes.as_slice(),
            server_name,
            congestion_control,
            idle_timeout_ms,
            keep_alive_interval_ms,
            handshake_timeout_ms,
            qpack_max_table_capacity,
            &client_limits,
        )
        .await;
    }

    let mut config = build_wtransport_client_config(
        insecure_skip_verify,
        ca_pem,
        pinned_hashes.as_slice(),
        congestion_control,
        idle_timeout_ms,
        keep_alive_interval_ms,
        qpack_max_table_capacity,
        &client_limits,
    )?;

    if let Some(resolver) = custom_resolver {
        config.set_dns_resolver(resolver);
    }

    let endpoint = wtransport::Endpoint::client(config)?;
    let conn = tokio::time::timeout(
        tokio::time::Duration::from_millis(handshake_timeout_ms),
        endpoint.connect(&connect_url),
    )
    .await
    .map_err(|_| "E_HANDSHAKE_TIMEOUT")?
    .map_err(map_connecting_error)?;

    let addr = conn.remote_address();
    let peer_ip = addr.ip().to_string();
    let peer_port = addr.port() as u32;

    Ok((id, peer_ip, peer_port, conn, None, None))
}

/// 0-RTT connect path. Differs from the plain path in exactly two ways bound
/// by the fork's contract: the TLS config comes from the per-identity shared
/// cache (rustls resumes only under the SAME verifier Arc — a fresh config
/// per connect would silently never resume), and `connect_0rtt` is used so a
/// resumed session request rides in the first flight.
///
/// Timeout audit (0-RTT changes what "connected" means): `handshakeTimeoutMs`
/// still bounds `connect_0rtt`, which resolves when the session request is
/// answered — possibly BEFORE the TLS handshake completes. The remaining
/// confirmation is tracked by a watcher task whose future resolves at
/// handshake completion or connection loss, both bounded by the idle timeout,
/// so no timer waits on a weaker event than it did before.
#[allow(clippy::too_many_arguments)]
async fn run_connect_0rtt(
    id: String,
    connect_url: &str,
    custom_resolver: Option<StaticSocketResolver>,
    insecure_skip_verify: bool,
    ca_pem: Option<&str>,
    pinned_hashes: &[[u8; 32]],
    server_name: Option<&str>,
    congestion_control: CongestionControlMode,
    idle_timeout_ms: u64,
    keep_alive_interval_ms: u64,
    handshake_timeout_ms: u64,
    qpack_max_table_capacity: u64,
    limits: &crate::limits::Limits,
) -> std::result::Result<RunConnectResult, Box<dyn std::error::Error + Send + Sync>> {
    let key = crate::zero_rtt::TlsIdentityKey::new(insecure_skip_verify, ca_pem, pinned_hashes);
    let (tls_config, store) = crate::zero_rtt::shared_tls_for_identity(&key, ca_pem, pinned_hashes)
        .map_err(std::io::Error::other)?;

    let transport_config = build_quic_transport_config(
        congestion_control,
        idle_timeout_ms,
        keep_alive_interval_ms,
        limits,
    );
    let mut config = wtransport::ClientConfig::builder()
        .with_bind_default()
        .with_custom_tls_and_transport(tls_config, transport_config)
        .enable_0rtt(true)
        .qpack_max_table_capacity(qpack_max_table_capacity)
        .build();
    if let Some(resolver) = custom_resolver {
        config.set_dns_resolver(resolver);
    }

    // The name rustls sees is the SNI host: an explicit serverName override,
    // else the URL host of the (possibly rewritten) connect URL.
    let sni_host = match server_name {
        Some(sni) if !sni.is_empty() => sni.to_string(),
        _ => url::Url::parse(connect_url)
            .ok()
            .and_then(|u| u.host_str().map(String::from))
            .unwrap_or_default(),
    };
    let sni_name = rustls::pki_types::ServerName::try_from(sni_host.clone()).ok();

    let endpoint = wtransport::Endpoint::client(config)?;
    let early_takes_before = sni_name
        .as_ref()
        .map(|n| store.early_take_count(n))
        .unwrap_or(0);
    let conn = tokio::time::timeout(
        tokio::time::Duration::from_millis(handshake_timeout_ms),
        endpoint.connect_0rtt(connect_url),
    )
    .await
    .map_err(|_| "E_HANDSHAKE_TIMEOUT")?
    .map_err(map_connecting_error)?;
    let has_0rtt = sni_name
        .as_ref()
        .map(|n| store.early_take_count(n) > early_takes_before)
        .unwrap_or(false);

    let accepted: Arc<std::sync::OnceLock<bool>> = Arc::new(std::sync::OnceLock::new());
    let accepted_writer = Arc::clone(&accepted);
    let conn_watch = conn.clone();
    CLIENT_RUNTIME.spawn(async move {
        let result = conn_watch.handshake_confirmed().await;
        let _ = accepted_writer.set(result);
    });

    let addr = conn.remote_address();
    let peer_ip = addr.ip().to_string();
    let peer_port = addr.port() as u32;

    Ok((
        id,
        peer_ip,
        peer_port,
        conn,
        None,
        Some(crate::zero_rtt::ZeroRttHandleState { has_0rtt, accepted }),
    ))
}

#[cfg(test)]
mod tests {
    use super::{
        build_client_tls_config, build_quic_transport_config, build_root_cert_store,
        clamp_client_batch_max, congestion_controller_label, handle_connect_callback_status,
        insert_registry_entry, mark_client_closed_and_notify, parse_client_limits,
        parse_congestion_control, parse_qpack_max_table_capacity, remove_registry_entry,
        run_client_datagram_forwarder, settle_client_receive_accounting_after_close,
        try_reserve_client_queued_bytes, ClientDatagramReadState, ClientMetrics,
        ClientSessionHandle, CongestionControlMode, ForwarderDoneGuard, CLIENT_DATAGRAM_BATCH_MAX,
        CLIENT_DATAGRAM_RECV_CAPACITY, CLIENT_HANDLE_REGISTRY, MAX_QPACK_TABLE_CAPACITY,
        QPACK_DYNAMIC_PRESET_CAPACITY,
    };
    use serde_json::json;
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use tokio::sync::{mpsc, watch, Mutex as TokioMutex, Notify};
    use tokio::time::{timeout, Duration};

    /// Every wait in these tests is bounded; a hang is a failure, not a stall.
    const BOUND: Duration = Duration::from_secs(1);
    /// Comfortably past the terminal task's own 1s forwarder wait, so a test
    /// that exercises the full teardown sequence still fails rather than hangs.
    const TEARDOWN_BOUND: Duration = Duration::from_secs(5);
    const PAYLOAD: usize = 8;

    /// A detached handle plus the plumbing a datagram test needs. Handles built
    /// here have `conn: None`, so `initiate_close` exercises exactly the local
    /// close origin: sticky flag, lifecycle notify, close watch.
    struct DatagramTestHarness {
        handle: ClientSessionHandle,
        /// `Option` so a test can drop every sender and turn the empty queue
        /// into a genuine EOF.
        dgram_recv_tx: Option<mpsc::Sender<Vec<u8>>>,
        rx: Arc<TokioMutex<mpsc::Receiver<Vec<u8>>>>,
        metrics: Arc<ClientMetrics>,
        closed: Arc<AtomicBool>,
        lifecycle_notify: Arc<Notify>,
        budget_bytes: u64,
        _close_rx: watch::Receiver<(u32, String)>,
    }

    impl DatagramTestHarness {
        fn new(id: &str, recv_capacity: usize, budget_bytes: u64) -> Self {
            let (dgram_send_tx, _dgram_send_rx) = mpsc::channel::<Vec<u8>>(recv_capacity);
            let (dgram_recv_tx, dgram_recv_rx) = mpsc::channel::<Vec<u8>>(recv_capacity);
            let (open_bi_tx, _open_bi_rx) = mpsc::channel(1);
            let (open_uni_tx, _open_uni_rx) = mpsc::channel(1);
            let (accept_bi_tx, _accept_bi_rx) = mpsc::channel(1);
            let (accept_uni_tx, _accept_uni_rx) = mpsc::channel(1);
            let (close_tx, close_rx) = watch::channel((0u32, String::new()));
            let rx = Arc::new(TokioMutex::new(dgram_recv_rx));
            let metrics = Arc::new(ClientMetrics::default());
            let closed = Arc::new(AtomicBool::new(false));
            let lifecycle_notify = Arc::new(Notify::new());
            let handle = ClientSessionHandle {
                id: id.to_string(),
                peer_ip: "127.0.0.1".to_string(),
                peer_port: 4433,
                dgram_send_tx: Some(dgram_send_tx),
                dgram_recv_rx: Arc::clone(&rx),
                datagram_budget_bytes: budget_bytes,
                backpressure_timeout_ms: 50,
                max_datagram_size: 1200,
                stream_open_bi_tx: Some(open_bi_tx),
                stream_open_uni_tx: Some(open_uni_tx),
                stream_accept_bi_tx: Some(accept_bi_tx),
                stream_accept_uni_tx: Some(accept_uni_tx),
                close_tx: Some(Arc::new(close_tx)),
                client_metrics: Arc::clone(&metrics),
                closed: Arc::clone(&closed),
                datagram_lifecycle_notify: Arc::clone(&lifecycle_notify),
                conn: None,
                zero_rtt: None,
            };
            Self {
                handle,
                dgram_recv_tx: Some(dgram_recv_tx),
                rx,
                metrics,
                closed,
                lifecycle_notify,
                budget_bytes,
                _close_rx: close_rx,
            }
        }

        fn read_state(&self) -> ClientDatagramReadState {
            self.handle.datagram_read_state()
        }

        fn sender(&self) -> &mpsc::Sender<Vec<u8>> {
            self.dgram_recv_tx.as_ref().expect("sender still held")
        }

        /// Drop every sender, which is what makes an empty queue report EOF.
        fn close_senders(&mut self) {
            self.dgram_recv_tx = None;
        }

        fn queued_bytes(&self) -> u64 {
            self.metrics.queued_bytes.load(Ordering::Relaxed)
        }

        /// Enqueue exactly as the forwarder does: charge, then hand over.
        fn charge_and_enqueue(&self, bytes: Vec<u8>) {
            assert!(
                try_reserve_client_queued_bytes(
                    &self.metrics,
                    self.budget_bytes,
                    bytes.len() as u64
                ),
                "test budget too small to charge {} bytes",
                bytes.len()
            );
            self.sender()
                .try_send(bytes)
                .expect("test receive channel had a free slot");
        }

        /// `queued_bytes` is one counter shared with the send direction, so
        /// settle assertions poll within a bound rather than reading once.
        async fn assert_queued_bytes_settles_to(&self, expected: u64) {
            let deadline = tokio::time::Instant::now() + BOUND;
            loop {
                let observed = self.queued_bytes();
                if observed == expected {
                    return;
                }
                assert!(
                    tokio::time::Instant::now() < deadline,
                    "queued_bytes settled at {observed}, expected {expected}"
                );
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        }
    }

    fn payload(tag: u8) -> Vec<u8> {
        vec![tag; PAYLOAD]
    }

    // serverCertificateHashes replaces PKI chain validation, so its verifier
    // must build even when the platform root store is empty. Handshake
    // signatures are still verified directly by the explicit ring provider.
    #[test]
    fn pinned_hash_tls_config_builds_without_default_provider() {
        let root_store = std::sync::Arc::new(rustls::RootCertStore::empty());
        let cfg = build_client_tls_config(root_store, false, &[[0u8; 32]])
            .expect("pinned-hash TLS config must build without a provider panic");
        assert!(!cfg.alpn_protocols.is_empty());
    }

    // Liveness config must be panic-safe across the full input range, including
    // the out-of-range fallback (an idle timeout larger than the varint bound).
    #[test]
    fn build_quic_transport_config_is_panic_safe() {
        let limits = crate::limits::Limits::default();
        // Normal: 30s idle, 10s keep-alive.
        let _ =
            build_quic_transport_config(CongestionControlMode::Default, 30_000, 10_000, &limits);
        // Opt-out: unbounded idle, no keep-alive.
        let _ = build_quic_transport_config(CongestionControlMode::Throughput, 0, 0, &limits);
        // Out-of-range idle must fall back to no timeout, not panic.
        let _ = build_quic_transport_config(
            CongestionControlMode::LowLatency,
            u64::MAX,
            u64::MAX,
            &limits,
        );
        // Keep-alive with no idle bound is ignored (guarded).
        let _ = build_quic_transport_config(CongestionControlMode::Default, 0, 5_000, &limits);
    }

    #[test]
    fn build_root_cert_store_rejects_parseable_but_unaccepted_cert() {
        let pem =
            "-----BEGIN CERTIFICATE-----\nAQIDBAUGBwgJCgsMDQ4PEA==\n-----END CERTIFICATE-----";
        let err = build_root_cert_store(Some(pem))
            .expect_err("expected parseable but unaccepted cert to fail");
        assert!(err.contains("E_TLS: CA PEM parsed but no certificates were accepted"));
    }

    #[test]
    fn build_root_cert_store_rejects_no_valid_cert_entries() {
        let pem = "-----BEGIN NOT-A-CERT-----\nAQIDBAUGBwgJCgsMDQ4PEA==\n-----END NOT-A-CERT-----";
        let err = build_root_cert_store(Some(pem)).expect_err("expected no valid cert entries");
        assert!(err.contains("E_TLS: no valid CA certificate found in caPem"));
    }

    #[test]
    fn build_root_cert_store_rejects_malformed_cert_pem() {
        let pem = "-----BEGIN CERTIFICATE-----\n!!not-base64!!\n-----END CERTIFICATE-----";
        let err = build_root_cert_store(Some(pem)).expect_err("expected malformed PEM failure");
        assert!(err.contains("E_TLS: invalid CA PEM"));
    }

    #[test]
    fn parse_client_limits_rejects_invalid_json() {
        let err = parse_client_limits("{").expect_err("expected invalid JSON");
        assert!(err.contains("E_INTERNAL: invalid client options JSON"));
    }

    #[test]
    fn parse_congestion_control_maps_supported_values() {
        let throughput = parse_congestion_control(&json!({ "congestionControl": "throughput" }))
            .expect("throughput should parse");
        assert_eq!(throughput, CongestionControlMode::Throughput);
        assert_eq!(congestion_controller_label(throughput), "bbr");

        let low_latency = parse_congestion_control(&json!({ "congestionControl": "low-latency" }))
            .expect("low-latency should parse");
        assert_eq!(low_latency, CongestionControlMode::LowLatency);
        assert_eq!(congestion_controller_label(low_latency), "new_reno");

        let default_mode = parse_congestion_control(&json!({})).expect("default should parse");
        assert_eq!(default_mode, CongestionControlMode::Default);
        assert_eq!(congestion_controller_label(default_mode), "cubic");
    }

    fn qpack_capacity(opts: serde_json::Value) -> u64 {
        parse_qpack_max_table_capacity(&opts).expect("options should be accepted")
    }

    #[test]
    fn parse_qpack_capacity_defaults_to_static_only() {
        assert_eq!(qpack_capacity(json!({})), 0);
        assert_eq!(qpack_capacity(json!({ "enableDynamicQpack": false })), 0);
    }

    #[test]
    fn parse_qpack_capacity_preset_expands_to_4096() {
        assert_eq!(
            qpack_capacity(json!({ "enableDynamicQpack": true })),
            QPACK_DYNAMIC_PRESET_CAPACITY
        );
    }

    #[test]
    fn parse_qpack_capacity_explicit_wins_over_preset() {
        // Explicit capacity beats the boolean preset in both directions.
        assert_eq!(
            qpack_capacity(json!({ "qpackMaxTableCapacity": 1024, "enableDynamicQpack": true })),
            1024
        );
        assert_eq!(
            qpack_capacity(json!({ "qpackMaxTableCapacity": 0, "enableDynamicQpack": true })),
            0
        );
    }

    #[test]
    fn parse_qpack_capacity_clamps_to_max() {
        assert_eq!(
            qpack_capacity(json!({ "qpackMaxTableCapacity": 1_000_000 })),
            MAX_QPACK_TABLE_CAPACITY
        );
    }

    /// A capacity that is present but unusable is rejected, rather than falling
    /// through to a preset the caller never asked for.
    #[test]
    fn parse_qpack_capacity_rejects_a_value_that_is_not_a_count() {
        for value in [json!(-1), json!(1.5), json!("4096"), json!(true), json!([])] {
            let error = parse_qpack_max_table_capacity(
                &json!({ "qpackMaxTableCapacity": value, "enableDynamicQpack": true }),
            )
            .expect_err("a non-integer capacity should be rejected");

            assert!(
                error.starts_with("E_INVALID_ARGUMENT: qpackMaxTableCapacity"),
                "unexpected error: {error}"
            );
        }

        // An explicit null is absence, not a malformed value.
        assert_eq!(
            qpack_capacity(json!({ "qpackMaxTableCapacity": null, "enableDynamicQpack": true })),
            QPACK_DYNAMIC_PRESET_CAPACITY
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn delivery_failure_removes_registry_entry_and_signals_close() {
        let handle_id = "delivery-failure-client".to_string();
        let (dgram_send_tx, dgram_recv_rx) = mpsc::channel::<Vec<u8>>(1);
        let (open_bi_tx, _open_bi_rx) = mpsc::channel(1);
        let (open_uni_tx, _open_uni_rx) = mpsc::channel(1);
        let (accept_bi_tx, _accept_bi_rx) = mpsc::channel(1);
        let (accept_uni_tx, _accept_uni_rx) = mpsc::channel(1);
        let (close_tx, mut close_rx) = watch::channel((0u32, String::new()));
        let closed_flag = Arc::new(AtomicBool::new(false));
        let handle = ClientSessionHandle {
            id: handle_id.clone(),
            peer_ip: "127.0.0.1".to_string(),
            peer_port: 4433,
            dgram_send_tx: Some(dgram_send_tx),
            dgram_recv_rx: Arc::new(TokioMutex::new(dgram_recv_rx)),
            datagram_budget_bytes: 1024,
            backpressure_timeout_ms: 50,
            max_datagram_size: 1200,
            stream_open_bi_tx: Some(open_bi_tx),
            stream_open_uni_tx: Some(open_uni_tx),
            stream_accept_bi_tx: Some(accept_bi_tx),
            stream_accept_uni_tx: Some(accept_uni_tx),
            close_tx: Some(Arc::new(close_tx)),
            client_metrics: Arc::new(ClientMetrics::default()),
            closed: Arc::clone(&closed_flag),
            datagram_lifecycle_notify: Arc::new(Notify::new()),
            conn: None,
            zero_rtt: None,
        };
        let insertion = insert_registry_entry(&CLIENT_HANDLE_REGISTRY, handle);
        assert!(!insertion.poison_recovered);

        handle_connect_callback_status(Some(&handle_id), napi::Status::Closing);

        assert!(closed_flag.load(Ordering::Relaxed));
        assert!(CLIENT_HANDLE_REGISTRY
            .lock()
            .expect("registry lock")
            .get(&handle_id)
            .is_none());
        close_rx.changed().await.expect("close signal");
        let (code, reason) = close_rx.borrow().clone();
        assert_eq!(code, 0);
        assert!(reason.contains("E_INTERNAL: connect callback delivery failed"));
        assert!(reason.contains("Closing"));
    }

    #[test]
    fn remove_registry_entry_recovers_poison_and_removes_entry() {
        let local_registry = Mutex::new(HashMap::<String, ClientSessionHandle>::new());
        let handle_id = "poisoned-entry".to_string();
        let (dgram_send_tx, dgram_recv_rx) = mpsc::channel::<Vec<u8>>(1);
        let (open_bi_tx, _open_bi_rx) = mpsc::channel(1);
        let (open_uni_tx, _open_uni_rx) = mpsc::channel(1);
        let (accept_bi_tx, _accept_bi_rx) = mpsc::channel(1);
        let (accept_uni_tx, _accept_uni_rx) = mpsc::channel(1);
        let (close_tx, _close_rx) = watch::channel((0u32, String::new()));
        local_registry.lock().expect("seed local registry").insert(
            handle_id.clone(),
            ClientSessionHandle {
                id: handle_id.clone(),
                peer_ip: "127.0.0.1".to_string(),
                peer_port: 4433,
                dgram_send_tx: Some(dgram_send_tx),
                dgram_recv_rx: Arc::new(TokioMutex::new(dgram_recv_rx)),
                datagram_budget_bytes: 1024,
                backpressure_timeout_ms: 50,
                max_datagram_size: 1200,
                stream_open_bi_tx: Some(open_bi_tx),
                stream_open_uni_tx: Some(open_uni_tx),
                stream_accept_bi_tx: Some(accept_bi_tx),
                stream_accept_uni_tx: Some(accept_uni_tx),
                close_tx: Some(Arc::new(close_tx)),
                client_metrics: Arc::new(ClientMetrics::default()),
                closed: Arc::new(AtomicBool::new(false)),
                datagram_lifecycle_notify: Arc::new(Notify::new()),
                conn: None,
                zero_rtt: None,
            },
        );
        let _ = std::panic::catch_unwind(|| {
            let _guard = local_registry.lock().expect("lock local registry");
            panic!("poison local registry");
        });

        let removal = remove_registry_entry(&local_registry, &handle_id);
        assert!(removal.poison_recovered);
        assert!(removal.value.is_some());
        let remaining = local_registry
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        assert!(remaining.get(&handle_id).is_none());
    }

    // --- batch datagram read -------------------------------------------

    #[test]
    fn batch_max_is_clamped_into_range_silently() {
        assert_eq!(clamp_client_batch_max(0), 1);
        assert_eq!(clamp_client_batch_max(1), 1);
        assert_eq!(clamp_client_batch_max(64), 64);
        assert_eq!(clamp_client_batch_max(CLIENT_DATAGRAM_BATCH_MAX), 256);
        assert_eq!(clamp_client_batch_max(CLIENT_DATAGRAM_BATCH_MAX + 1), 256);
        assert_eq!(clamp_client_batch_max(u32::MAX), 256);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_batch_drains_in_order_up_to_its_cap_and_leaves_the_rest_queued() {
        let h = DatagramTestHarness::new("batch-order", 16, 1 << 20);
        for tag in 0..6u8 {
            h.charge_and_enqueue(payload(tag));
        }

        let batch = timeout(BOUND, h.read_state().read_batch(4))
            .await
            .expect("batch read is bounded")
            .expect("a queued batch");
        assert_eq!(batch.len(), 4, "the cap is exact");
        for (index, item) in batch.iter().enumerate() {
            assert_eq!(item, &payload(index as u8), "batches keep queue order");
        }
        // Exactly the drained items were refunded, and only those.
        assert_eq!(h.queued_bytes(), 2 * PAYLOAD as u64);

        let rest = timeout(BOUND, h.read_state().read_batch(32))
            .await
            .expect("bounded")
            .expect("the remainder");
        assert_eq!(rest, vec![payload(4), payload(5)]);
        assert_eq!(h.queued_bytes(), 0);
    }

    /// A batch never resolves empty: with nothing queued it parks for the first
    /// item and returns it alone.
    #[tokio::test(flavor = "current_thread")]
    async fn a_batch_parks_for_its_first_item_and_never_resolves_empty() {
        let h = DatagramTestHarness::new("batch-first-item", 8, 1 << 20);
        let state = h.read_state();
        let parked = tokio::spawn(async move { state.read_batch(16).await });

        tokio::task::yield_now().await;
        assert!(
            !parked.is_finished(),
            "an empty queue must park, not return"
        );

        h.charge_and_enqueue(payload(7));
        let batch = timeout(BOUND, parked)
            .await
            .expect("bounded")
            .expect("join")
            .expect("one item");
        assert_eq!(batch, vec![payload(7)]);
        assert_eq!(h.queued_bytes(), 0);
    }

    /// Partial-then-EOF: the queued remainder is delivered as a short batch,
    /// and only the next call reports EOF.
    #[tokio::test(flavor = "current_thread")]
    async fn a_partial_batch_precedes_eof_when_every_sender_is_gone() {
        let mut h = DatagramTestHarness::new("batch-partial-eof", 8, 1 << 20);
        h.charge_and_enqueue(payload(1));
        h.charge_and_enqueue(payload(2));
        h.close_senders();

        let batch = timeout(BOUND, h.read_state().read_batch(64))
            .await
            .expect("bounded")
            .expect("the queued remainder arrives before EOF");
        assert_eq!(batch, vec![payload(1), payload(2)]);
        assert_eq!(h.queued_bytes(), 0);

        // Only the next call reports EOF.
        assert!(timeout(BOUND, h.read_state().read_batch(64))
            .await
            .expect("bounded")
            .is_none());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn eof_with_no_items_resolves_null_on_both_lanes() {
        for lane in ["batch", "single"] {
            let mut h = DatagramTestHarness::new("batch-eof", 8, 1 << 20);
            h.close_senders();
            let empty = match lane {
                "batch" => timeout(BOUND, h.read_state().read_batch(8))
                    .await
                    .expect("bounded")
                    .is_none(),
                _ => timeout(BOUND, h.read_state().read_one())
                    .await
                    .expect("bounded")
                    .is_none(),
            };
            assert!(empty, "{lane}: EOF with nothing queued resolves null");
        }
    }

    /// One decrement per drained item, never per call and never per byte twice.
    #[tokio::test(flavor = "current_thread")]
    async fn each_drained_item_decrements_queued_bytes_exactly_once() {
        let h = DatagramTestHarness::new("batch-accounting", 64, 1 << 20);
        for tag in 0..10u8 {
            h.charge_and_enqueue(payload(tag));
        }
        assert_eq!(h.queued_bytes(), 10 * PAYLOAD as u64);

        let batch = timeout(BOUND, h.read_state().read_batch(10))
            .await
            .expect("bounded")
            .expect("ten items");
        assert_eq!(batch.len(), 10);
        assert_eq!(h.queued_bytes(), 0);

        // A second read on an empty-but-open queue parks; it must not refund.
        let state = h.read_state();
        let parked = tokio::spawn(async move { state.read_batch(4).await });
        tokio::task::yield_now().await;
        assert_eq!(h.queued_bytes(), 0);
        mark_client_closed_and_notify(&h.closed, &h.lifecycle_notify);
        assert!(timeout(BOUND, parked)
            .await
            .expect("bounded")
            .expect("join")
            .is_none());
        assert_eq!(h.queued_bytes(), 0);
    }

    /// Capacity conservation at the real channel size: a held batch releases
    /// exactly its own slots back, and byte accounting covers only what is
    /// actually queued natively.
    #[tokio::test(flavor = "current_thread")]
    async fn a_held_batch_releases_exactly_its_own_slots() {
        let budget = (CLIENT_DATAGRAM_RECV_CAPACITY as u64 + 512) * PAYLOAD as u64;
        let h = DatagramTestHarness::new("batch-capacity", CLIENT_DATAGRAM_RECV_CAPACITY, budget);
        for _ in 0..CLIENT_DATAGRAM_RECV_CAPACITY {
            h.charge_and_enqueue(payload(1));
        }
        assert!(
            h.sender().try_send(payload(2)).is_err(),
            "the channel is full at its named capacity"
        );

        let batch_len = 64usize;
        let held = timeout(BOUND, h.read_state().read_batch(batch_len as u32))
            .await
            .expect("bounded")
            .expect("a full batch");
        assert_eq!(held.len(), batch_len);

        for _ in 0..batch_len {
            h.charge_and_enqueue(payload(3));
        }
        assert!(
            h.sender().try_send(payload(4)).is_err(),
            "a held batch releases its own slots and not one more"
        );

        let native_queued = CLIENT_DATAGRAM_RECV_CAPACITY;
        assert_eq!(
            native_queued + held.len(),
            CLIENT_DATAGRAM_RECV_CAPACITY + batch_len,
            "native-plus-held items"
        );
        assert_eq!(
            h.queued_bytes(),
            (native_queued * PAYLOAD) as u64,
            "reservation covers the refilled native queue only, not the held batch"
        );
    }

    // --- close semantics: drop-not-drain, both lanes, both origins ------

    /// Documented deviation 3: a close discards what is still queued instead of
    /// draining it first, on both lanes and from both close origins — and the
    /// bytes those discarded datagrams reserved come back.
    #[tokio::test(flavor = "current_thread")]
    async fn a_close_drops_queued_datagrams_instead_of_draining_them() {
        for lane in ["batch", "single"] {
            for origin in ["local", "terminal"] {
                let h = DatagramTestHarness::new("batch-drop-not-drain", 16, 1 << 20);
                let state = h.read_state();
                let parked = match lane {
                    "batch" => tokio::spawn(async move { state.read_batch(8).await }),
                    _ => tokio::spawn(async move { state.read_one().await.map(|one| vec![one]) }),
                };
                tokio::task::yield_now().await;
                assert!(
                    !parked.is_finished(),
                    "{lane}/{origin}: read must be parked"
                );

                // Queue three datagrams and close without letting the reader
                // run in between, so the biased select — not scheduling luck —
                // decides the outcome.
                for tag in 0..3u8 {
                    h.charge_and_enqueue(payload(tag));
                }
                assert_eq!(h.queued_bytes(), 3 * PAYLOAD as u64);
                match origin {
                    "local" => h.handle.initiate_close(0, "test".to_string()),
                    _ => mark_client_closed_and_notify(&h.closed, &h.lifecycle_notify),
                }

                let result = timeout(BOUND, parked)
                    .await
                    .unwrap_or_else(|_| panic!("{lane}/{origin}: close must wake the read"))
                    .expect("join");
                assert!(
                    result.is_none(),
                    "{lane}/{origin}: a closed session reports EOF, it does not drain"
                );
                h.assert_queued_bytes_settles_to(0).await;
            }
        }
    }

    /// A read entered after the close reports EOF straight away and settles the
    /// bytes of whatever the close left behind.
    #[tokio::test(flavor = "current_thread")]
    async fn a_read_entered_after_a_close_reports_eof_and_settles_the_remainder() {
        let h = DatagramTestHarness::new("batch-post-close-read", 16, 1 << 20);
        for tag in 0..4u8 {
            h.charge_and_enqueue(payload(tag));
        }
        h.handle.initiate_close(0, "test".to_string());

        assert!(timeout(BOUND, h.read_state().read_batch(8))
            .await
            .expect("bounded")
            .is_none());
        h.assert_queued_bytes_settles_to(0).await;
    }

    // --- teardown accounting -------------------------------------------

    /// The terminal sequence settles the queue when no reader is attached and
    /// none ever re-enters, and it fires the close callback along the way.
    #[tokio::test(flavor = "current_thread")]
    async fn the_terminal_sequence_settles_a_queue_no_reader_will_ever_take() {
        let h = DatagramTestHarness::new("batch-terminal-drain", 16, 1 << 20);
        for tag in 0..5u8 {
            h.charge_and_enqueue(payload(tag));
        }
        let (done_guard, forwarder_exited) = ForwarderDoneGuard::new();
        drop(done_guard); // stand-in for a forwarder that has already exited

        let closed_callback = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&closed_callback);
        timeout(
            TEARDOWN_BOUND,
            settle_client_receive_accounting_after_close(
                &h.rx,
                &h.metrics,
                &h.closed,
                &h.lifecycle_notify,
                forwarder_exited,
                move || flag.store(true, Ordering::Relaxed),
            ),
        )
        .await
        .expect("teardown is bounded");

        assert!(
            closed_callback.load(Ordering::Relaxed),
            "close callback fired"
        );
        assert!(h.closed.load(Ordering::Acquire));
        assert_eq!(h.queued_bytes(), 0);
    }

    /// A forwarder that never signals must not wedge teardown: the bounded wait
    /// expires, the final drain still runs, and the callback already fired.
    #[tokio::test(flavor = "current_thread")]
    async fn a_forwarder_that_never_signals_cannot_wedge_teardown() {
        let h = DatagramTestHarness::new("batch-terminal-timeout", 16, 1 << 20);
        h.charge_and_enqueue(payload(1));
        // Held for the whole test: this stands in for a forwarder that panicked
        // in a way that never runs its guard, so the wait can only expire.
        let (done_guard, forwarder_exited) = ForwarderDoneGuard::new();

        let closed_callback = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&closed_callback);
        let started = tokio::time::Instant::now();
        timeout(
            TEARDOWN_BOUND,
            settle_client_receive_accounting_after_close(
                &h.rx,
                &h.metrics,
                &h.closed,
                &h.lifecycle_notify,
                forwarder_exited,
                move || flag.store(true, Ordering::Relaxed),
            ),
        )
        .await
        .expect("the wait is bounded, not indefinite");
        assert!(
            started.elapsed() >= super::FORWARDER_EXIT_WAIT,
            "the wait really did run to its bound"
        );
        drop(done_guard);

        assert!(closed_callback.load(Ordering::Relaxed));
        assert_eq!(h.queued_bytes(), 0);
    }

    /// The required interleaving: the receive channel is FULL, no reader is
    /// attached, and the forwarder is parked mid-enqueue when the session
    /// closes. Teardown must still complete, fire the callback, and settle the
    /// bytes. Note that this passes on either design — the first drain frees
    /// the slot the forwarder is waiting for, so it unparks even without the
    /// select. `the_forwarder_refunds_everything_it_charged_on_its_own_exit` is
    /// the strict discriminator: it wedges the forwarder identically with no
    /// terminal drain at all, and an uninterruptible send hangs it forever.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_close_unparks_a_forwarder_blocked_on_a_full_receive_channel() {
        let capacity = CLIENT_DATAGRAM_RECV_CAPACITY;
        let budget = (capacity as u64 + 1024) * PAYLOAD as u64;
        let h = DatagramTestHarness::new("batch-full-channel-close", capacity, budget);
        let wire = Arc::new(TokioMutex::new({
            let (wire_tx, wire_rx) = mpsc::channel::<Vec<u8>>(capacity * 2);
            for tag in 0..(capacity as u32 + 8) {
                wire_tx.try_send(payload(tag as u8)).expect("wire slot");
            }
            drop(wire_tx);
            wire_rx
        }));

        let (done_guard, forwarder_exited) = ForwarderDoneGuard::new();
        let forwarder = {
            let tx = h.sender().clone();
            let rx = Arc::clone(&h.rx);
            let metrics = Arc::clone(&h.metrics);
            let closed = Arc::clone(&h.closed);
            let notify = Arc::clone(&h.lifecycle_notify);
            let wire = Arc::clone(&wire);
            tokio::spawn(async move {
                let _done = done_guard;
                let source = &wire;
                run_client_datagram_forwarder(
                    move || async move { source.lock().await.recv().await },
                    tx,
                    rx,
                    metrics,
                    budget,
                    closed,
                    notify,
                )
                .await;
            })
        };

        // Wait until the forwarder is genuinely wedged: the channel is full and
        // it has charged the payload it cannot hand over.
        let full_at = (capacity as u64 + 1) * PAYLOAD as u64;
        let deadline = tokio::time::Instant::now() + TEARDOWN_BOUND;
        while h.queued_bytes() < full_at {
            assert!(
                tokio::time::Instant::now() < deadline,
                "forwarder never filled the channel (queued {})",
                h.queued_bytes()
            );
            tokio::time::sleep(Duration::from_millis(2)).await;
        }

        let closed_callback = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&closed_callback);
        timeout(
            TEARDOWN_BOUND,
            settle_client_receive_accounting_after_close(
                &h.rx,
                &h.metrics,
                &h.closed,
                &h.lifecycle_notify,
                forwarder_exited,
                move || flag.store(true, Ordering::Relaxed),
            ),
        )
        .await
        .expect("teardown must not deadlock against a send-parked forwarder");

        timeout(TEARDOWN_BOUND, forwarder)
            .await
            .expect("the forwarder exits after the close")
            .expect("forwarder task");
        assert!(closed_callback.load(Ordering::Relaxed));
        h.assert_queued_bytes_settles_to(0).await;
    }

    /// The same teardown while the forwarder is actively delivering onto a
    /// non-full channel with a reader parked on it.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_close_while_the_forwarder_is_actively_delivering_settles_cleanly() {
        let h =
            DatagramTestHarness::new("batch-active-close", CLIENT_DATAGRAM_RECV_CAPACITY, 1 << 22);
        let (wire_tx, wire_rx) = mpsc::channel::<Vec<u8>>(8);
        let wire = Arc::new(TokioMutex::new(wire_rx));

        let (done_guard, forwarder_exited) = ForwarderDoneGuard::new();
        let forwarder = {
            let tx = h.sender().clone();
            let rx = Arc::clone(&h.rx);
            let metrics = Arc::clone(&h.metrics);
            let closed = Arc::clone(&h.closed);
            let notify = Arc::clone(&h.lifecycle_notify);
            let wire = Arc::clone(&wire);
            tokio::spawn(async move {
                let _done = done_guard;
                let source = &wire;
                run_client_datagram_forwarder(
                    move || async move { source.lock().await.recv().await },
                    tx,
                    rx,
                    metrics,
                    1 << 22,
                    closed,
                    notify,
                )
                .await;
            })
        };

        let feeder = tokio::spawn(async move {
            for tag in 0..2_000u32 {
                if wire_tx.send(payload(tag as u8)).await.is_err() {
                    break;
                }
            }
        });

        let reader = {
            let state = h.read_state();
            tokio::spawn(async move {
                let mut seen = 0usize;
                while let Some(batch) = state.read_batch(32).await {
                    seen += batch.len();
                }
                seen
            })
        };

        // Let real delivery get going before closing.
        let deadline = tokio::time::Instant::now() + TEARDOWN_BOUND;
        while h.metrics.datagrams_in.load(Ordering::Relaxed) < 64 {
            assert!(
                tokio::time::Instant::now() < deadline,
                "the forwarder never started delivering"
            );
            tokio::time::sleep(Duration::from_millis(2)).await;
        }

        let closed_callback = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&closed_callback);
        timeout(
            TEARDOWN_BOUND,
            settle_client_receive_accounting_after_close(
                &h.rx,
                &h.metrics,
                &h.closed,
                &h.lifecycle_notify,
                forwarder_exited,
                move || flag.store(true, Ordering::Relaxed),
            ),
        )
        .await
        .expect("teardown is bounded while delivery is in flight");

        timeout(TEARDOWN_BOUND, forwarder)
            .await
            .expect("the forwarder exits")
            .expect("forwarder task");
        let delivered = timeout(TEARDOWN_BOUND, reader)
            .await
            .expect("the reader sees EOF")
            .expect("reader task");
        assert!(delivered > 0, "the test must observe real delivery");
        feeder.abort();
        assert!(closed_callback.load(Ordering::Relaxed));
        h.assert_queued_bytes_settles_to(0).await;
    }

    /// The forwarder's own exit-refund: whatever it charged but could not hand
    /// over comes back, without any terminal task running at all.
    ///
    /// This is the strict falsifier for both the interruptible enqueue (an
    /// uninterruptible `send().await` on the full channel never returns, so the
    /// forwarder never exits) and the forwarder's self-drain (without it the
    /// four datagrams left in the channel strand their reservation).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_forwarder_refunds_everything_it_charged_on_its_own_exit() {
        let h = DatagramTestHarness::new("batch-forwarder-refund", 4, 1 << 20);
        let wire = Arc::new(TokioMutex::new({
            let (wire_tx, wire_rx) = mpsc::channel::<Vec<u8>>(16);
            for tag in 0..12u8 {
                wire_tx.try_send(payload(tag)).expect("wire slot");
            }
            drop(wire_tx);
            wire_rx
        }));

        let tx = h.sender().clone();
        let rx = Arc::clone(&h.rx);
        let metrics = Arc::clone(&h.metrics);
        let closed = Arc::clone(&h.closed);
        let notify = Arc::clone(&h.lifecycle_notify);
        let forwarder = tokio::spawn(async move {
            let source = &wire;
            run_client_datagram_forwarder(
                move || async move { source.lock().await.recv().await },
                tx,
                rx,
                metrics,
                1 << 20,
                closed,
                notify,
            )
            .await;
        });

        // Wedge it on a full 4-slot channel, then close with no reader and no
        // terminal drain: only the forwarder's own exit path can settle this.
        let deadline = tokio::time::Instant::now() + TEARDOWN_BOUND;
        while h.queued_bytes() < 5 * PAYLOAD as u64 {
            assert!(tokio::time::Instant::now() < deadline, "never filled");
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
        mark_client_closed_and_notify(&h.closed, &h.lifecycle_notify);

        timeout(TEARDOWN_BOUND, forwarder)
            .await
            .expect("the forwarder exits on close")
            .expect("forwarder task");
        assert_eq!(
            h.queued_bytes(),
            0,
            "the forwarder's own drain settles the queue"
        );
    }

    /// A clean end of connection is not a close. When the forwarder runs its
    /// source to exhaustion with datagrams still queued and the sticky flag
    /// still false, a reader is entitled to every one of them: the forwarder's
    /// exit must not drain them away. Only the disconnect-driven EOF follows.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_clean_connection_end_delivers_the_remainder_instead_of_discarding_it() {
        let mut h =
            DatagramTestHarness::new("batch-clean-eof", CLIENT_DATAGRAM_RECV_CAPACITY, 1 << 20);
        let queued = 40usize;
        let wire = Arc::new(TokioMutex::new({
            let (wire_tx, wire_rx) = mpsc::channel::<Vec<u8>>(queued);
            for tag in 0..queued {
                wire_tx.try_send(payload(tag as u8)).expect("wire slot");
            }
            // Dropping the wire sender is what makes the source run dry, which
            // is how a cleanly ended connection reaches the forwarder.
            drop(wire_tx);
            wire_rx
        }));

        let tx = h.sender().clone();
        let rx = Arc::clone(&h.rx);
        let metrics = Arc::clone(&h.metrics);
        let closed = Arc::clone(&h.closed);
        let notify = Arc::clone(&h.lifecycle_notify);
        let forwarder = tokio::spawn(async move {
            let source = &wire;
            run_client_datagram_forwarder(
                move || async move { source.lock().await.recv().await },
                tx,
                rx,
                metrics,
                1 << 20,
                closed,
                notify,
            )
            .await;
        });
        timeout(TEARDOWN_BOUND, forwarder)
            .await
            .expect("the forwarder finishes when its source runs dry")
            .expect("forwarder task");

        // No close happened, so nothing may have been discarded.
        assert!(!h.closed.load(Ordering::Acquire), "this is not a close");
        h.close_senders();

        let mut delivered = Vec::new();
        while let Some(batch) = timeout(TEARDOWN_BOUND, h.read_state().read_batch(16))
            .await
            .expect("bounded")
        {
            delivered.extend(batch);
        }
        assert_eq!(
            delivered.len(),
            queued,
            "every datagram the forwarder accepted must still be deliverable"
        );
        for (index, item) in delivered.iter().enumerate() {
            assert_eq!(item, &payload(index as u8), "and in order");
        }
        assert_eq!(h.queued_bytes(), 0, "and their bytes settle on delivery");
    }

    /// A oneshot, not a notify: the guard fires even if the waiter registers
    /// after the forwarder has already finished, so there is no lost wake.
    #[tokio::test(flavor = "current_thread")]
    async fn the_forwarder_done_signal_cannot_be_lost() {
        let (guard, exited) = ForwarderDoneGuard::new();
        drop(guard);
        assert!(timeout(BOUND, exited).await.expect("bounded").is_ok());
    }

    /// The signal fires on panic unwind too, which is what makes the bounded
    /// wait panic insurance rather than a hang.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_forwarder_done_signal_fires_on_panic_unwind() {
        let (guard, exited) = ForwarderDoneGuard::new();
        let panicked = tokio::spawn(async move {
            let _guard = guard;
            panic!("forwarder body panicked");
        });
        assert!(timeout(BOUND, exited).await.expect("bounded").is_ok());
        assert!(panicked.await.is_err());
    }

    /// The napi read lanes both go through one routine, so `read_one` is the
    /// max=1 extraction over `read_batch` and shares its close path.
    #[tokio::test(flavor = "current_thread")]
    async fn the_single_read_lane_is_the_max_one_extraction() {
        let h = DatagramTestHarness::new("batch-single-lane", 8, 1 << 20);
        h.charge_and_enqueue(payload(1));
        h.charge_and_enqueue(payload(2));

        let one = timeout(BOUND, h.read_state().read_one())
            .await
            .expect("bounded")
            .expect("one item");
        assert_eq!(one, payload(1));
        assert_eq!(
            h.queued_bytes(),
            PAYLOAD as u64,
            "the single lane takes exactly one item's bytes"
        );
    }
}
