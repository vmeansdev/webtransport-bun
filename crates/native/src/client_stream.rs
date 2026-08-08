//! Stream handles: bridge wtransport QUIC streams to napi async read/write.
//!
//! Architecture:
//! - Write bridge: receives StreamCmd (Data/Finish/Reset) from a bounded mpsc channel.
//! - Read bridge: sends Vec<u8> to a bounded mpsc channel; selects on a stop_sending oneshot.
//! - read() awaits directly on the napi runtime (cross-runtime channel waker).

use crate::error::{from_reason as wt_from_reason, WtResult};
use napi::Result;
use napi_derive::napi;
use once_cell::sync::Lazy;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::sync::Mutex;
use tokio::sync::{mpsc, oneshot, Mutex as TokioMutex, Notify, OwnedSemaphorePermit, Semaphore};
use wtransport::error::{StreamReadError, StreamWriteError};

use crate::RUNTIME;

/// Deliver a control command (Finish/Reset) without loss: try_send fast path,
/// falling back to an async send when the write channel is momentarily full.
/// Dropping these silently turns a graceful FIN into a data-truncating RESET.
fn send_ctrl_lossless(tx: &Option<mpsc::Sender<StreamCmd>>, cmd: StreamCmd) {
    let Some(tx) = tx.as_ref() else { return };
    match tx.try_send(cmd) {
        Ok(()) => {}
        Err(mpsc::error::TrySendError::Full(cmd)) => {
            let tx = tx.clone();
            RUNTIME.spawn(async move {
                let _ = tx.send(cmd).await;
            });
        }
        // Channel closed: bridge already gone, stream is finished/reset anyway.
        Err(mpsc::error::TrySendError::Closed(_)) => {}
    }
}

/// Commands sent from JS to the write bridge task.
pub enum StreamCmd {
    /// Outbound stream data carrying its own byte-budget reservation, so a
    /// buffered write released on teardown cannot leak the budget.
    Data(StreamChunk),
    Finish,
    FinishWithAck(oneshot::Sender<std::result::Result<(), String>>),
    Reset(u32),
}

/// Drop action for a stream bridge.
///
/// The hot accept path creates one guard per stream. Keeping the action as a
/// small enum avoids boxing a unique closure (and its allocation) for every
/// short-lived accepted stream.
enum StreamGuardAction {
    Client {
        metrics: Arc<crate::client::ClientMetrics>,
    },
    Server {
        metrics: Arc<crate::server_metrics::ServerMetrics>,
        session: Arc<crate::session_registry::SessionMetrics>,
        bidi: bool,
        capacity_notify: Option<Arc<Notify>>,
    },
}

/// Holds the accounting action that runs when a bridge-owned stream is dropped.
pub struct StreamGuard {
    action: Option<StreamGuardAction>,
}

impl StreamGuard {
    pub fn client(metrics: Arc<crate::client::ClientMetrics>) -> Self {
        Self {
            action: Some(StreamGuardAction::Client { metrics }),
        }
    }

    pub fn server(
        metrics: Arc<crate::server_metrics::ServerMetrics>,
        session: Arc<crate::session_registry::SessionMetrics>,
        bidi: bool,
        capacity_notify: Option<Arc<Notify>>,
    ) -> Self {
        Self {
            action: Some(StreamGuardAction::Server {
                metrics,
                session,
                bidi,
                capacity_notify,
            }),
        }
    }
}

impl Drop for StreamGuard {
    fn drop(&mut self) {
        let Some(action) = self.action.take() else {
            return;
        };
        match action {
            StreamGuardAction::Client { metrics } => {
                metrics.streams_active.fetch_sub(1, Ordering::Relaxed);
            }
            StreamGuardAction::Server {
                metrics,
                session,
                bidi,
                capacity_notify,
            } => {
                metrics.streams_active.fetch_sub(1, Ordering::Relaxed);
                let counter = if bidi {
                    &session.streams_bidi_active
                } else {
                    &session.streams_uni_active
                };
                counter.fetch_sub(1, Ordering::Relaxed);
                if let Some(notify) = capacity_notify {
                    notify.notify_waiters();
                }
            }
        }
    }
}

/// Byte-accounted budget for stream data in transit through channels.
/// Three-level reservation: global → session → stream.
/// Reserve before enqueue, release after dequeue.
#[derive(Clone)]
pub struct StreamBudget {
    pub server_metrics: Arc<crate::server_metrics::ServerMetrics>,
    pub session_metrics: Arc<crate::session_registry::SessionMetrics>,
    pub stream_queued: Arc<AtomicU64>,
    pub max_global: u64,
    pub max_session: u64,
    pub max_stream: u64,
    /// Notified whenever budget is released, so a recv loop parked on a full
    /// budget can wake and retry instead of resetting the stream (lossless
    /// backpressure). Defaults via `StreamBudget::new_notify()`.
    pub capacity_notify: Arc<tokio::sync::Notify>,
    /// Max time a send may park waiting for budget headroom before yielding
    /// E_BACKPRESSURE_TIMEOUT (reliable-stream backpressure bound).
    pub backpressure_timeout_ms: u64,
}

/// Configuration retained by an accepted stream before JS consumes it.
///
/// Accepted server streams can be created and released without ever starting
/// a read/write bridge. Keep only the shared metrics and scalar limits in that
/// deferred state; the per-stream counter and notifier are allocated when the
/// first bridge actually starts.
#[derive(Clone)]
pub struct DeferredStreamBudgetConfig {
    server_metrics: Arc<crate::server_metrics::ServerMetrics>,
    session_metrics: Arc<crate::session_registry::SessionMetrics>,
    max_global: u64,
    max_session: u64,
    max_stream: u64,
    backpressure_timeout_ms: u64,
}

impl DeferredStreamBudgetConfig {
    pub fn new(
        server_metrics: Arc<crate::server_metrics::ServerMetrics>,
        session_metrics: Arc<crate::session_registry::SessionMetrics>,
        max_global: u64,
        max_session: u64,
        max_stream: u64,
        backpressure_timeout_ms: u64,
    ) -> Self {
        Self {
            server_metrics,
            session_metrics,
            max_global,
            max_session,
            max_stream,
            backpressure_timeout_ms,
        }
    }

    fn materialize(self) -> StreamBudget {
        StreamBudget {
            server_metrics: self.server_metrics,
            session_metrics: self.session_metrics,
            stream_queued: Arc::new(AtomicU64::new(0)),
            max_global: self.max_global,
            max_session: self.max_session,
            max_stream: self.max_stream,
            capacity_notify: StreamBudget::new_notify(),
            backpressure_timeout_ms: self.backpressure_timeout_ms,
        }
    }
}

/// Fallback re-check interval for budget waits: bounds how long a stream can
/// stay parked when a *sibling* stream freed shared global/session budget (whose
/// release notifies its own per-stream notifier, not the waiter's).
const BUDGET_POLL_INTERVAL: tokio::time::Duration = tokio::time::Duration::from_millis(50);
// Read streams in bounded chunks. A per-bridge scratch buffer is retained for
// the lifetime of each accepted stream, so keep it below the app-level queue
// budget while preserving arbitrary payload delivery through repeated reads.
pub(crate) const STREAM_READ_BUFFER_BYTES: usize = 4 * 1024;

/// Consume a QUIC receive stream without allocating a bridge or copying the
/// payload into a JS-visible buffer. The caller owns the stream accounting
/// guard and decides how to report the result.
pub(crate) async fn discard_recv_stream(
    mut recv_stream: wtransport::RecvStream,
    scratch: &mut [u8],
) -> std::result::Result<(), String> {
    loop {
        match recv_stream.read(scratch).await {
            Ok(Some(_)) => {}
            Ok(None) => return Ok(()),
            Err(error) => return Err(read_error_code(&error).to_string()),
        }
    }
}

/// Consume a native black-hole stream to EOF without copying payload bytes
/// into an application buffer. Quinn's chunk API hands out the received bytes
/// for the duration of the loop iteration; dropping each chunk immediately
/// preserves full delivery/error accounting while avoiding a temporary copy.
pub(crate) async fn discard_recv_stream_zero_copy(
    mut recv_stream: wtransport::RecvStream,
) -> std::result::Result<(), String> {
    loop {
        match recv_stream
            .quic_stream_mut()
            .read_chunk(STREAM_READ_BUFFER_BYTES, true)
            .await
        {
            Ok(Some(_)) => {}
            Ok(None) => return Ok(()),
            Err(error) => {
                return Err(match error {
                    wtransport::quinn::ReadError::Reset(_) => "E_STREAM_RESET",
                    wtransport::quinn::ReadError::ConnectionLost(_)
                    | wtransport::quinn::ReadError::ClosedStream
                    | wtransport::quinn::ReadError::IllegalOrderedRead
                    | wtransport::quinn::ReadError::ZeroRttRejected => "E_SESSION_CLOSED",
                }
                .to_string());
            }
        }
    }
}

const STREAM_CHANNEL_CAPACITY: usize = 256;

// Accepted server streams are exposed lazily, but a probe or application can
// still call `read()` on many of them at once. Keep the native receive bridge
// fan-out bounded so that each concurrent stream cannot create an unbounded
// burst of Tokio tasks, channels, and scratch buffers. Streams beyond this
// limit remain in their deferred state and naturally apply QUIC backpressure
// until an earlier bridge completes or is disposed.
const DEFERRED_READ_BRIDGE_CAPACITY: usize = 64;
static DEFERRED_READ_BRIDGES: Lazy<Arc<Semaphore>> =
    Lazy::new(|| Arc::new(Semaphore::new(DEFERRED_READ_BRIDGE_CAPACITY)));

// These counters intentionally track the NAPI stream-handle objects, not the
// Tokio bridge tasks.  The server drain metrics already prove that bridge
// owners and their task guards have gone away; these counters tell us whether
// the JS-visible native handles are still retained after the facade closes.
static LIVE_BIDI_HANDLES: AtomicUsize = AtomicUsize::new(0);
static LIVE_UNI_SEND_HANDLES: AtomicUsize = AtomicUsize::new(0);
static LIVE_UNI_RECV_HANDLES: AtomicUsize = AtomicUsize::new(0);

pub(crate) fn live_native_stream_handles() -> (usize, usize, usize) {
    (
        LIVE_BIDI_HANDLES.load(Ordering::Relaxed),
        LIVE_UNI_SEND_HANDLES.load(Ordering::Relaxed),
        LIVE_UNI_RECV_HANDLES.load(Ordering::Relaxed),
    )
}

impl StreamBudget {
    /// Fresh capacity notifier for a new stream budget.
    pub fn new_notify() -> Arc<tokio::sync::Notify> {
        Arc::new(tokio::sync::Notify::new())
    }

    /// Reserve `n` bytes, parking (lossless backpressure) until capacity frees
    /// or the backpressure deadline elapses. Returns true iff reserved.
    ///
    /// `capacity_notify` is per-stream, but the global/session tiers of the
    /// budget are shared across sibling streams whose releases notify their own
    /// notifier, not this one. So each wait is also capped at
    /// `BUDGET_POLL_INTERVAL` to re-check the shared tiers even when only a
    /// sibling freed capacity — the own-notify fast path still wakes
    /// immediately for the common case.
    pub async fn reserve_or_wait(&self, n: u64) -> bool {
        let deadline = tokio::time::Instant::now()
            + tokio::time::Duration::from_millis(self.backpressure_timeout_ms);
        loop {
            if self.try_reserve(n) {
                return true;
            }
            let now = tokio::time::Instant::now();
            if now >= deadline {
                return false;
            }
            // Register wakeup before re-checking so a release() between the
            // failed try_reserve and the await cannot be lost.
            let notified = self.capacity_notify.notified();
            tokio::pin!(notified);
            if self.try_reserve(n) {
                return true;
            }
            let wait = (deadline - now).min(BUDGET_POLL_INTERVAL);
            let _ = tokio::time::timeout(wait, notified).await;
        }
    }
}

impl StreamBudget {
    pub fn try_reserve(&self, n: u64) -> bool {
        if !self
            .server_metrics
            .try_reserve_queued_bytes(n, self.max_global)
        {
            return false;
        }
        let session_ok = self
            .session_metrics
            .queued_bytes
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |c| {
                c.checked_add(n)
                    .and_then(|next| (next <= self.max_session).then_some(next))
            })
            .is_ok();
        if !session_ok {
            self.server_metrics.release_queued_bytes(n);
            return false;
        }
        let stream_ok = self
            .stream_queued
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |c| {
                c.checked_add(n)
                    .and_then(|next| (next <= self.max_stream).then_some(next))
            })
            .is_ok();
        if !stream_ok {
            self.session_metrics
                .queued_bytes
                .fetch_sub(n, Ordering::Relaxed);
            self.server_metrics.release_queued_bytes(n);
            return false;
        }
        true
    }

    pub fn release(&self, n: u64) {
        self.stream_queued.fetch_sub(n, Ordering::Relaxed);
        self.session_metrics
            .queued_bytes
            .fetch_sub(n, Ordering::Relaxed);
        self.server_metrics.release_queued_bytes(n);
        // Wake any recv loop parked waiting for budget headroom.
        self.capacity_notify.notify_waiters();
    }
}

/// A queued inbound stream chunk that owns its byte-budget reservation.
///
/// Mirrors `DatagramSlot`: the three-tier (global/session/stream) reservation
/// is released exactly once — when the consumer drops the chunk after dequeue,
/// or when the read channel is dropped on stream/session teardown (buffered
/// chunks release their own bytes). This makes the reservation impossible to
/// leak on any teardown path.
pub struct StreamChunk {
    data: Vec<u8>,
    budget: Option<StreamBudget>,
    reserved: u64,
}

impl StreamChunk {
    pub fn new(data: Vec<u8>, budget: Option<StreamBudget>, reserved: u64) -> Self {
        Self {
            data,
            budget,
            reserved,
        }
    }

    /// Move the payload out. The reservation is still released when the chunk is
    /// dropped at the end of the caller's scope.
    pub fn take(mut self) -> Vec<u8> {
        std::mem::take(&mut self.data)
    }

    /// Borrow the payload while keeping the reservation held (write bridge: the
    /// budget stays reserved until the write completes and the chunk drops).
    pub fn as_bytes(&self) -> &[u8] {
        &self.data
    }
}

impl Drop for StreamChunk {
    fn drop(&mut self) {
        if self.reserved > 0 {
            if let Some(ref b) = self.budget {
                b.release(self.reserved);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Bidi stream handle
// ---------------------------------------------------------------------------

/// Shared slot for write failure error code (E_STOP_SENDING, E_STREAM_RESET).
type WriteErrorSlot = Arc<Mutex<Option<String>>>;
/// Shared slot for read failure error code (E_STREAM_RESET, E_SESSION_CLOSED).
type ReadErrorSlot = Arc<Mutex<Option<String>>>;
type BidiBridgeParts = (
    mpsc::Receiver<StreamChunk>,
    mpsc::Sender<StreamCmd>,
    oneshot::Sender<u32>,
    Option<WriteErrorSlot>,
    Option<ReadErrorSlot>,
);
type ReadBridgeParts = (
    mpsc::Receiver<StreamChunk>,
    oneshot::Sender<u32>,
    Option<ReadErrorSlot>,
);

fn read_error_code(err: &StreamReadError) -> &'static str {
    match err {
        StreamReadError::Reset(_) => "E_STREAM_RESET",
        StreamReadError::NotConnected | StreamReadError::QuicProto => "E_SESSION_CLOSED",
    }
}

fn should_reset_on_oversized_chunk(sz: u64, budget: &Option<StreamBudget>) -> bool {
    budget.as_ref().is_some_and(|b| sz > b.max_stream)
}

/// Budget in force for a deferred stream, materializing the retained config on
/// first use. Whichever half of the stream is touched first — a read or a write
/// — installs the budget, and both then share the same per-stream counter.
fn installed_budget(
    budget: &Mutex<Option<StreamBudget>>,
    deferred: &Mutex<Option<DeferredStreamBudgetConfig>>,
) -> Result<Option<StreamBudget>> {
    let mut budget_guard = budget
        .lock()
        .map_err(|_| napi::Error::from_reason("E_INTERNAL: stream budget lock poisoned"))?;
    if let Some(existing) = budget_guard.as_ref() {
        return Ok(Some(existing.clone()));
    }
    let materialized = deferred
        .lock()
        .map_err(|_| napi::Error::from_reason("E_INTERNAL: deferred budget lock poisoned"))?
        .take()
        .map(DeferredStreamBudgetConfig::materialize);
    if let Some(ref value) = materialized {
        *budget_guard = Some(value.clone());
    }
    Ok(materialized)
}

async fn acquire_deferred_read_bridge_permit(
    read_abort: &Notify,
    read_aborted: &AtomicBool,
) -> Result<OwnedSemaphorePermit> {
    if read_aborted.load(Ordering::Acquire) {
        return Err(wt_from_reason("E_STREAM_RESET"));
    }
    let notified = read_abort.notified();
    tokio::pin!(notified);
    tokio::select! {
        permit = DEFERRED_READ_BRIDGES.clone().acquire_owned() => permit
            .map_err(|_| wt_from_reason("E_SESSION_CLOSED")),
        _ = &mut notified => Err(wt_from_reason("E_STREAM_RESET")),
    }
}

/// Accepted server streams start in a deferred state. Once JS actually reads
/// or writes one, the corresponding bridge is started lazily so unread streams
/// do not retain a task, channel, or scratch buffer for their whole lifetime.
#[napi]
pub struct ClientBidiStreamHandle {
    read_rx: Mutex<Option<Arc<TokioMutex<mpsc::Receiver<StreamChunk>>>>>,
    write_tx: Mutex<Option<mpsc::Sender<StreamCmd>>>,
    lazy_send_stream: Mutex<Option<wtransport::SendStream>>,
    deferred_recv: Mutex<Option<(wtransport::RecvStream, StreamGuard)>>,
    stop_tx: std::sync::Mutex<Option<oneshot::Sender<u32>>>,
    budget: Mutex<Option<StreamBudget>>,
    deferred_budget: Mutex<Option<DeferredStreamBudgetConfig>>,
    write_error_slot: Mutex<Option<WriteErrorSlot>>,
    read_error_slot: Option<ReadErrorSlot>,
    deferred_read_error_slot: Mutex<Option<ReadErrorSlot>>,
    /// Wakes a pending napi `read()` when JS resets/stops the readable half.
    /// The channel receiver alone is insufficient here: the bridge can still
    /// own its sender while the native handle is retained by the async napi
    /// method future.
    read_abort: Notify,
    read_aborted: AtomicBool,
    /// Set once finish/reset is issued so a subsequent write is rejected
    /// deterministically (a closed stream never accepts more data), instead of
    /// racing into the channel behind the FIN.
    finished: AtomicBool,
    /// Set once `dispose()` releases the native resources. The N-API wrapper
    /// can outlive its transport use until JS finalization, so resource release
    /// and the live-handle diagnostic must be idempotent.
    released: AtomicBool,
}

impl ClientBidiStreamHandle {
    pub fn new(
        read_rx: mpsc::Receiver<StreamChunk>,
        write_tx: mpsc::Sender<StreamCmd>,
        stop_tx: oneshot::Sender<u32>,
    ) -> Self {
        LIVE_BIDI_HANDLES.fetch_add(1, Ordering::Relaxed);
        Self {
            read_rx: Mutex::new(Some(Arc::new(TokioMutex::new(read_rx)))),
            write_tx: Mutex::new(Some(write_tx)),
            lazy_send_stream: Mutex::new(None),
            deferred_recv: Mutex::new(None),
            stop_tx: std::sync::Mutex::new(Some(stop_tx)),
            budget: Mutex::new(None),
            deferred_budget: Mutex::new(None),
            write_error_slot: Mutex::new(None),
            read_error_slot: None,
            deferred_read_error_slot: Mutex::new(None),
            read_abort: Notify::new(),
            read_aborted: AtomicBool::new(false),
            finished: AtomicBool::new(false),
            released: AtomicBool::new(false),
        }
    }

    pub fn new_with_budget(
        read_rx: mpsc::Receiver<StreamChunk>,
        write_tx: mpsc::Sender<StreamCmd>,
        stop_tx: oneshot::Sender<u32>,
        budget: Option<StreamBudget>,
    ) -> Self {
        Self::new_with_budget_and_slot(read_rx, write_tx, stop_tx, budget, None, None)
    }

    pub fn new_with_budget_and_slot(
        read_rx: mpsc::Receiver<StreamChunk>,
        write_tx: mpsc::Sender<StreamCmd>,
        stop_tx: oneshot::Sender<u32>,
        budget: Option<StreamBudget>,
        write_error_slot: Option<WriteErrorSlot>,
        read_error_slot: Option<ReadErrorSlot>,
    ) -> Self {
        LIVE_BIDI_HANDLES.fetch_add(1, Ordering::Relaxed);
        Self {
            read_rx: Mutex::new(Some(Arc::new(TokioMutex::new(read_rx)))),
            write_tx: Mutex::new(Some(write_tx)),
            lazy_send_stream: Mutex::new(None),
            deferred_recv: Mutex::new(None),
            stop_tx: std::sync::Mutex::new(Some(stop_tx)),
            budget: Mutex::new(budget),
            deferred_budget: Mutex::new(None),
            write_error_slot: Mutex::new(write_error_slot),
            read_error_slot,
            deferred_read_error_slot: Mutex::new(None),
            read_abort: Notify::new(),
            read_aborted: AtomicBool::new(false),
            finished: AtomicBool::new(false),
            released: AtomicBool::new(false),
        }
    }

    pub fn new_lazy_with_budget_and_slot(
        read_rx: mpsc::Receiver<StreamChunk>,
        send_stream: wtransport::SendStream,
        stop_tx: oneshot::Sender<u32>,
        budget: Option<StreamBudget>,
        read_error_slot: Option<ReadErrorSlot>,
    ) -> Self {
        LIVE_BIDI_HANDLES.fetch_add(1, Ordering::Relaxed);
        Self {
            read_rx: Mutex::new(Some(Arc::new(TokioMutex::new(read_rx)))),
            write_tx: Mutex::new(None),
            lazy_send_stream: Mutex::new(Some(send_stream)),
            deferred_recv: Mutex::new(None),
            stop_tx: std::sync::Mutex::new(Some(stop_tx)),
            budget: Mutex::new(budget),
            deferred_budget: Mutex::new(None),
            write_error_slot: Mutex::new(None),
            read_error_slot,
            deferred_read_error_slot: Mutex::new(None),
            read_abort: Notify::new(),
            read_aborted: AtomicBool::new(false),
            finished: AtomicBool::new(false),
            released: AtomicBool::new(false),
        }
    }

    /// Construct an accepted server bidi stream without starting its receive
    /// bridge. The bridge starts on the first `read()` call, so unread streams
    /// remain a small bounded handle rather than retaining a task and scratch
    /// buffer for their entire transport lifetime.
    pub fn new_deferred(
        recv_stream: wtransport::RecvStream,
        send_stream: wtransport::SendStream,
        guard: StreamGuard,
        budget: Option<DeferredStreamBudgetConfig>,
    ) -> Self {
        LIVE_BIDI_HANDLES.fetch_add(1, Ordering::Relaxed);
        Self {
            read_rx: Mutex::new(None),
            write_tx: Mutex::new(None),
            lazy_send_stream: Mutex::new(Some(send_stream)),
            deferred_recv: Mutex::new(Some((recv_stream, guard))),
            stop_tx: std::sync::Mutex::new(None),
            budget: Mutex::new(None),
            deferred_budget: Mutex::new(budget),
            write_error_slot: Mutex::new(None),
            read_error_slot: None,
            deferred_read_error_slot: Mutex::new(None),
            read_abort: Notify::new(),
            read_aborted: AtomicBool::new(false),
            finished: AtomicBool::new(false),
            released: AtomicBool::new(false),
        }
    }

    pub fn new_client_stream(
        read_rx: mpsc::Receiver<StreamChunk>,
        write_tx: mpsc::Sender<StreamCmd>,
        stop_tx: oneshot::Sender<u32>,
    ) -> Self {
        Self::new(read_rx, write_tx, stop_tx)
    }

    /// Consume a deferred server receive stream to EOF without creating a
    /// JavaScript stream bridge. This is used by bounded load/evidence drains
    /// that need acceptance and delivery accounting but do not need payloads.
    /// Reading to EOF is important: dropping the QUIC handle early resets the
    /// peer and turns an otherwise successful stream into a delivery error.
    pub async fn discard_incoming(
        &mut self,
        scratch: &mut [u8],
    ) -> std::result::Result<(), String> {
        let pending = self
            .deferred_recv
            .lock()
            .map_err(|_| "E_INTERNAL: deferred stream lock poisoned".to_string())?
            .take();
        let mut result = Ok(());
        if let Some((recv_stream, _guard)) = pending {
            result = discard_recv_stream(recv_stream, scratch).await;
        }
        self.dispose_resources();
        self.release_live_counter();
        result
    }

    /// Read deferred server streams directly until a bridge is needed. The
    /// common accepted-stream path reads a small number of chunks and then
    /// cancels/resets; materializing a Tokio task, channel, and scratch-buffer
    /// allocation for that path creates avoidable allocator churn. The receive
    /// stream stays deferred after each successful read, so normal multi-read
    /// consumers retain the same semantics without a per-stream bridge.
    async fn read_deferred_direct(&self) -> Result<Option<Option<napi::bindgen_prelude::Buffer>>> {
        let pending = self
            .deferred_recv
            .lock()
            .map_err(|_| napi::Error::from_reason("E_INTERNAL: deferred stream lock poisoned"))?
            .take();
        let Some((mut recv_stream, guard)) = pending else {
            return Ok(None);
        };
        if self.read_aborted.load(Ordering::Acquire) {
            recv_stream.stop(0);
            drop(guard);
            return Err(wt_from_reason("E_STREAM_RESET"));
        }

        let notified = self.read_abort.notified();
        tokio::pin!(notified);
        let mut buf = [0u8; STREAM_READ_BUFFER_BYTES];
        let result = tokio::select! {
            value = recv_stream.read(&mut buf) => value,
            _ = &mut notified => {
                recv_stream.stop(0);
                drop(guard);
                return Err(wt_from_reason("E_STREAM_RESET"));
            }
        };
        let read_result = match result {
            Ok(value) => value,
            Err(error) => {
                drop(guard);
                return Err(wt_from_reason(read_error_code(&error)));
            }
        };
        let Some(n) = read_result else {
            drop(guard);
            return Ok(Some(None));
        };
        let budget = installed_budget(&self.budget, &self.deferred_budget)?;
        if let Some(ref b) = budget {
            if should_reset_on_oversized_chunk(n as u64, &Some(b.clone())) {
                recv_stream.stop(0);
                drop(guard);
                return Err(wt_from_reason("E_STREAM_RESET"));
            }
            if !b.reserve_or_wait(n as u64).await {
                recv_stream.stop(0);
                drop(guard);
                return Err(wt_from_reason("E_BACKPRESSURE_TIMEOUT"));
            }
        }
        if self.read_aborted.load(Ordering::Acquire) {
            if let Some(ref b) = budget {
                b.release(n as u64);
            }
            recv_stream.stop(0);
            drop(guard);
            return Err(wt_from_reason("E_STREAM_RESET"));
        }
        let chunk = StreamChunk::new(buf[..n].to_vec(), budget, n as u64);
        let value = chunk.take().into();
        let mut deferred = self
            .deferred_recv
            .lock()
            .map_err(|_| napi::Error::from_reason("E_INTERNAL: deferred stream lock poisoned"))?;
        if self.read_aborted.load(Ordering::Acquire) {
            recv_stream.stop(0);
            drop(guard);
        } else {
            *deferred = Some((recv_stream, guard));
        }
        Ok(Some(Some(value)))
    }

    fn ensure_write_tx(&self) -> Result<mpsc::Sender<StreamCmd>> {
        let mut tx_guard = self
            .write_tx
            .lock()
            .map_err(|_| napi::Error::from_reason("E_INTERNAL: stream write lock poisoned"))?;
        if let Some(tx) = tx_guard.as_ref() {
            return Ok(tx.clone());
        }
        let send_stream = self
            .lazy_send_stream
            .lock()
            .map_err(|_| napi::Error::from_reason("E_INTERNAL: lazy stream lock poisoned"))?
            .take()
            .ok_or_else(|| napi::Error::from_reason("E_STREAM_RESET"))?;
        let write_error_slot = {
            let mut slot = self
                .write_error_slot
                .lock()
                .map_err(|_| napi::Error::from_reason("E_INTERNAL: write error lock poisoned"))?;
            if let Some(existing) = slot.as_ref() {
                existing.clone()
            } else {
                let created = Arc::new(Mutex::new(None));
                *slot = Some(created.clone());
                created
            }
        };
        let (write_tx, write_rx) = mpsc::channel::<StreamCmd>(STREAM_CHANNEL_CAPACITY);
        spawn_bidi_write_bridge_on(&RUNTIME, send_stream, write_rx, write_error_slot);
        *tx_guard = Some(write_tx.clone());
        Ok(write_tx)
    }

    /// Handle one ordered load/evidence bidi probe without crossing the N-API
    /// stream-wrapper boundary. The public stream methods remain unchanged;
    /// this helper is only used by the internal native probe harness.
    pub(crate) async fn handle_native_probe(&self) -> Result<()> {
        let result = async {
            let payload = self.read_deferred_direct().await?.flatten();
            let Some(payload) = payload else {
                self.reset(0)?;
                return Ok(());
            };
            if payload.as_ref().starts_with(b"probe:bidi-reset:") {
                self.reset(42)?;
            } else if payload.as_ref().starts_with(b"probe:bidi-echo:") {
                self.write(payload).await?;
                self.finish_wait().await?;
            } else {
                self.reset(0)?;
            }
            Ok(())
        }
        .await;
        let _ = self.dispose();
        result
    }

    fn abort_read(&self) {
        self.read_aborted.store(true, Ordering::Release);
        self.read_abort.notify_waiters();
    }

    async fn ensure_deferred_read_bridge(&self) -> Result<()> {
        let has_pending = self
            .deferred_recv
            .lock()
            .map_err(|_| napi::Error::from_reason("E_INTERNAL: deferred stream lock poisoned"))?
            .is_some();
        if !has_pending {
            return Ok(());
        }

        let permit =
            acquire_deferred_read_bridge_permit(&self.read_abort, &self.read_aborted).await?;
        let pending = self
            .deferred_recv
            .lock()
            .map_err(|_| napi::Error::from_reason("E_INTERNAL: deferred stream lock poisoned"))?
            .take();
        let Some((recv_stream, guard)) = pending else {
            drop(permit);
            return Ok(());
        };
        let budget = self
            .deferred_budget
            .lock()
            .map_err(|_| napi::Error::from_reason("E_INTERNAL: deferred budget lock poisoned"))?
            .take()
            .map(DeferredStreamBudgetConfig::materialize);
        let (read_rx, stop_tx, read_error_slot) = spawn_recv_bridge_on_with_permit(
            &RUNTIME,
            recv_stream,
            Some(guard),
            budget,
            Some(permit),
        );
        self.read_rx
            .lock()
            .map_err(|_| napi::Error::from_reason("E_INTERNAL: stream read lock poisoned"))?
            .replace(Arc::new(TokioMutex::new(read_rx)));
        self.stop_tx
            .lock()
            .map_err(|_| napi::Error::from_reason("E_INTERNAL: stream stop lock poisoned"))?
            .replace(stop_tx);
        self.deferred_read_error_slot
            .lock()
            .map_err(|_| napi::Error::from_reason("E_INTERNAL: deferred error lock poisoned"))?
            .replace(read_error_slot.expect("receive bridge always has an error slot"));
        Ok(())
    }

    fn dispose_resources(&self) {
        self.finished.store(true, Ordering::Release);
        self.abort_read();
        if let Ok(mut stop) = self.stop_tx.lock() {
            if let Some(tx) = stop.take() {
                let _ = tx.send(0);
            }
        }
        if let Ok(mut write) = self.write_tx.lock() {
            write.take();
        }
        if let Ok(mut lazy) = self.lazy_send_stream.lock() {
            lazy.take();
        }
        if let Ok(mut deferred) = self.deferred_recv.lock() {
            deferred.take();
        }
        if let Ok(mut budget) = self.deferred_budget.lock() {
            budget.take();
        }
        if let Ok(mut budget) = self.budget.lock() {
            budget.take();
        }
        if let Ok(mut read) = self.read_rx.lock() {
            read.take();
        }
    }

    fn release_live_counter(&self) {
        if !self.released.swap(true, Ordering::AcqRel) {
            LIVE_BIDI_HANDLES.fetch_sub(1, Ordering::Relaxed);
        }
    }
}

impl Drop for ClientBidiStreamHandle {
    fn drop(&mut self) {
        self.release_live_counter();
    }
}

#[napi]
impl ClientBidiStreamHandle {
    #[napi]
    pub async fn read(&self) -> Result<Option<napi::bindgen_prelude::Buffer>> {
        if let Some(result) = self.read_deferred_direct().await? {
            return Ok(result);
        }
        self.ensure_deferred_read_bridge().await?;
        let read_rx = self
            .read_rx
            .lock()
            .map_err(|_| napi::Error::from_reason("E_INTERNAL: stream read lock poisoned"))?
            .as_ref()
            .cloned()
            .ok_or_else(|| wt_from_reason("E_STREAM_RESET"))?;
        let mut rx = read_rx.lock().await;
        let read_abort = self.read_abort.notified();
        tokio::pin!(read_abort);
        if self.read_aborted.load(Ordering::Acquire) {
            return Err(wt_from_reason("E_STREAM_RESET"));
        }
        let result = match tokio::select! {
            value = rx.recv() => value,
            _ = &mut read_abort => {
                return Err(wt_from_reason("E_STREAM_RESET"));
            }
        } {
            // `chunk.take()` moves the payload out; the reservation is released
            // when the chunk drops at the end of this scope (see StreamChunk).
            Some(chunk) => Some(chunk.take().into()),
            None => {
                let deferred_slot = self
                    .deferred_read_error_slot
                    .lock()
                    .ok()
                    .and_then(|guard| guard.clone());
                if let Some(slot) = self.read_error_slot.as_ref().or(deferred_slot.as_ref()) {
                    if let Ok(guard) = slot.lock() {
                        if let Some(ref code) = *guard {
                            return Err(wt_from_reason(code.clone()));
                        }
                    }
                }
                None
            }
        };
        Ok(result)
    }

    #[napi]
    pub async fn write(&self, chunk: napi::bindgen_prelude::Buffer) -> Result<()> {
        self.write_bytes(chunk.to_vec()).await
    }

    async fn write_bytes(&self, bytes: Vec<u8>) -> Result<()> {
        // A finished/reset stream never accepts more data: reject deterministically
        // rather than letting a late write race into the channel behind the FIN.
        if self.finished.load(Ordering::Acquire) {
            return Err(wt_from_reason("E_STREAM_RESET"));
        }
        if let Ok(slot) = self.write_error_slot.lock() {
            if let Some(slot) = slot.as_ref() {
                if let Ok(guard) = slot.lock() {
                    if let Some(ref code) = *guard {
                        return Err(wt_from_reason(code.clone()));
                    }
                }
            }
        }
        if bytes.is_empty() {
            return Ok(());
        }
        let tx = self.ensure_write_tx()?;
        let sz = bytes.len() as u64;
        // An accepted stream that is only ever written keeps its budget deferred
        // until here: materialize it on this side too, otherwise a push-style
        // server bypasses the queue limits entirely.
        let budget = installed_budget(&self.budget, &self.deferred_budget)?;
        if let Some(ref b) = budget {
            // Reliable-stream backpressure: park until budget frees (lossless)
            // instead of erroring, bounded by the backpressure timeout.
            if !b.reserve_or_wait(sz).await {
                return Err(wt_from_reason("E_BACKPRESSURE_TIMEOUT"));
            }
        }
        // Build the chunk NOW, immediately after reserving, so it owns the
        // reservation: every early return below (the finish re-check, a send
        // failure) drops it and releases the global/session/stream bytes.
        // Building it *after* the re-check would strand the bytes reserved by
        // reserve_or_wait when the re-check returns early — a budget leak.
        let chunk = StreamChunk::new(bytes, budget, sz);
        // Re-check after the (awaited) reservation: finish/reset issued during
        // the park must still win — `chunk` is dropped here (releasing its
        // bytes) instead of being written after the FIN.
        //
        // Deterministic under the single-runtime execution model: finish()/reset()
        // set `finished` synchronously *before* enqueuing their control command,
        // so a write issued after them is rejected above, and a write concurrent
        // with them (its future parked here) is rejected by this re-check. If the
        // send below parks on a full channel, tokio wakes waiters FIFO, so this
        // Data (registered first) is enqueued ahead of a later FIN — no reorder.
        // (WHATWG serializes write/close through the facade; this covers the raw
        // handle.)
        if self.finished.load(Ordering::Acquire) {
            return Err(wt_from_reason("E_STREAM_RESET"));
        }
        // On send failure the chunk drops here, releasing its reservation.
        if tx.send(StreamCmd::Data(chunk)).await.is_err() {
            return Err(wt_from_reason("E_STREAM_RESET"));
        }
        Ok(())
    }

    #[napi]
    pub fn reset(&self, code: u32) -> WtResult<()> {
        self.finished.store(true, Ordering::Release);
        // Reset must terminate the receive bridge too. The JS facade normally
        // sends STOP_SENDING first, but native callers and delayed wrapper
        // teardown must not leave a recv task holding the transport stream.
        let _ = self.stop_sending(code);
        // Accepted server bidi streams keep their send half lazy until JS writes.
        // Resetting such a stream must not materialize a write bridge just to send
        // one terminal control frame: that bridge can outlive the JS wrapper during
        // session teardown and retain the native handle. Reset the transport-owned
        // send stream directly while it is still lazy.
        if let Ok(mut lazy) = self.lazy_send_stream.lock() {
            if let Some(mut send_stream) = lazy.take() {
                let _ = send_stream.reset(code);
                return Ok(());
            }
        }
        if let Ok(tx) = self.ensure_write_tx() {
            send_ctrl_lossless(&Some(tx), StreamCmd::Reset(code));
        }
        Ok(())
    }

    #[napi]
    pub fn stop_sending(&self, code: u32) -> WtResult<()> {
        self.abort_read();
        if let Ok(mut guard) = self.stop_tx.lock() {
            if let Some(tx) = guard.take() {
                if tx.send(code).is_err() {
                    return Err(wt_from_reason("E_SESSION_CLOSED"));
                }
            }
        }
        if let Ok(mut deferred) = self.deferred_recv.lock() {
            if let Some((recv_stream, _guard)) = deferred.take() {
                recv_stream.stop(code);
            }
        }
        Ok(())
    }

    #[napi]
    pub fn finish(&self) -> WtResult<()> {
        self.finished.store(true, Ordering::Release);
        if let Ok(tx) = self.ensure_write_tx() {
            send_ctrl_lossless(&Some(tx), StreamCmd::Finish);
        }
        Ok(())
    }

    #[napi]
    pub async fn finish_wait(&self) -> Result<()> {
        self.finished.store(true, Ordering::Release);
        let tx = self.ensure_write_tx()?;
        let (done_tx, done_rx) = oneshot::channel::<std::result::Result<(), String>>();
        tx.send(StreamCmd::FinishWithAck(done_tx))
            .await
            .map_err(|_| napi::Error::from_reason("E_STREAM_RESET"))?;
        match done_rx.await {
            Ok(Ok(())) => Ok(()),
            Ok(Err(code)) => Err(napi::Error::from_reason(code)),
            Err(_) => Err(napi::Error::from_reason("E_STREAM_RESET")),
        }
    }

    /// Release transport channels and bridge ownership immediately. N-API
    /// finalization may be delayed by the JS runtime, so stream wrappers call
    /// this during deterministic teardown instead of relying on GC.
    #[napi]
    pub fn dispose(&self) -> WtResult<()> {
        self.dispose_resources();
        self.release_live_counter();
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Outgoing uni stream handle (write-only)
// ---------------------------------------------------------------------------

#[napi]
pub struct ClientUniSendHandle {
    write_tx: Mutex<Option<mpsc::Sender<StreamCmd>>>,
    budget: Option<StreamBudget>,
    write_error_slot: Option<WriteErrorSlot>,
    /// See `ClientBidiStreamHandle::finished`.
    finished: AtomicBool,
    released: AtomicBool,
}

impl ClientUniSendHandle {
    pub fn new(write_tx: mpsc::Sender<StreamCmd>) -> Self {
        LIVE_UNI_SEND_HANDLES.fetch_add(1, Ordering::Relaxed);
        Self {
            write_tx: Mutex::new(Some(write_tx)),
            budget: None,
            write_error_slot: None,
            finished: AtomicBool::new(false),
            released: AtomicBool::new(false),
        }
    }

    pub fn new_with_budget(
        write_tx: mpsc::Sender<StreamCmd>,
        budget: Option<StreamBudget>,
    ) -> Self {
        Self::new_with_budget_and_slot(write_tx, budget, None)
    }

    pub fn new_with_budget_and_slot(
        write_tx: mpsc::Sender<StreamCmd>,
        budget: Option<StreamBudget>,
        write_error_slot: Option<WriteErrorSlot>,
    ) -> Self {
        LIVE_UNI_SEND_HANDLES.fetch_add(1, Ordering::Relaxed);
        Self {
            write_tx: Mutex::new(Some(write_tx)),
            budget,
            write_error_slot,
            finished: AtomicBool::new(false),
            released: AtomicBool::new(false),
        }
    }

    fn dispose_resources(&self) {
        self.finished.store(true, Ordering::Release);
        if let Ok(mut write) = self.write_tx.lock() {
            write.take();
        }
    }

    fn release_live_counter(&self) {
        if !self.released.swap(true, Ordering::AcqRel) {
            LIVE_UNI_SEND_HANDLES.fetch_sub(1, Ordering::Relaxed);
        }
    }
}

impl Drop for ClientUniSendHandle {
    fn drop(&mut self) {
        self.release_live_counter();
    }
}

#[napi]
impl ClientUniSendHandle {
    #[napi]
    pub async fn write(&self, chunk: napi::bindgen_prelude::Buffer) -> Result<()> {
        if self.finished.load(Ordering::Acquire) {
            return Err(napi::Error::from_reason("E_STREAM_RESET"));
        }
        if let Some(ref slot) = self.write_error_slot {
            if let Ok(guard) = slot.lock() {
                if let Some(ref code) = *guard {
                    return Err(napi::Error::from_reason(code.clone()));
                }
            }
        }
        let tx = self
            .write_tx
            .lock()
            .map_err(|_| napi::Error::from_reason("E_INTERNAL: stream write lock poisoned"))?
            .as_ref()
            .cloned()
            .ok_or_else(|| napi::Error::from_reason("E_STREAM_RESET"))?;
        let bytes = chunk.to_vec();
        if bytes.is_empty() {
            return Ok(());
        }
        let sz = bytes.len() as u64;
        if let Some(ref b) = self.budget {
            // Reliable-stream backpressure: park until budget frees (lossless)
            // instead of erroring, bounded by the backpressure timeout.
            if !b.reserve_or_wait(sz).await {
                return Err(napi::Error::from_reason("E_BACKPRESSURE_TIMEOUT"));
            }
        }
        // Build the chunk immediately after reserving so it owns the reservation:
        // the finish re-check (and a send failure) below then drop it and release
        // the bytes. Building it after the re-check would leak the reservation.
        let chunk = StreamChunk::new(bytes, self.budget.clone(), sz);
        if self.finished.load(Ordering::Acquire) {
            return Err(napi::Error::from_reason("E_STREAM_RESET"));
        }
        // On send failure the chunk drops here, releasing its reservation.
        if tx.send(StreamCmd::Data(chunk)).await.is_err() {
            return Err(napi::Error::from_reason("E_STREAM_RESET"));
        }
        Ok(())
    }

    #[napi]
    pub fn reset(&self, code: u32) -> WtResult<()> {
        self.finished.store(true, Ordering::Release);
        let tx = self
            .write_tx
            .lock()
            .ok()
            .and_then(|guard| guard.as_ref().cloned());
        send_ctrl_lossless(&tx, StreamCmd::Reset(code));
        Ok(())
    }

    #[napi]
    pub fn finish(&self) -> WtResult<()> {
        self.finished.store(true, Ordering::Release);
        let tx = self
            .write_tx
            .lock()
            .ok()
            .and_then(|guard| guard.as_ref().cloned());
        send_ctrl_lossless(&tx, StreamCmd::Finish);
        Ok(())
    }

    #[napi]
    pub async fn finish_wait(&self) -> Result<()> {
        self.finished.store(true, Ordering::Release);
        let tx = self
            .write_tx
            .lock()
            .map_err(|_| napi::Error::from_reason("E_INTERNAL: stream write lock poisoned"))?
            .as_ref()
            .cloned()
            .ok_or_else(|| napi::Error::from_reason("E_STREAM_RESET"))?;
        let (done_tx, done_rx) = oneshot::channel::<std::result::Result<(), String>>();
        tx.send(StreamCmd::FinishWithAck(done_tx))
            .await
            .map_err(|_| napi::Error::from_reason("E_STREAM_RESET"))?;
        match done_rx.await {
            Ok(Ok(())) => Ok(()),
            Ok(Err(code)) => Err(napi::Error::from_reason(code)),
            Err(_) => Err(napi::Error::from_reason("E_STREAM_RESET")),
        }
    }

    /// Release transport channels and bridge ownership immediately. N-API
    /// finalization may be delayed by the JS runtime, so stream wrappers call
    /// this during deterministic teardown instead of relying on GC.
    #[napi]
    pub fn dispose(&self) -> WtResult<()> {
        self.dispose_resources();
        self.release_live_counter();
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Incoming uni stream handle (read-only)
// ---------------------------------------------------------------------------

#[napi]
pub struct ClientUniRecvHandle {
    read_rx: Mutex<Option<Arc<TokioMutex<mpsc::Receiver<StreamChunk>>>>>,
    stop_tx: std::sync::Mutex<Option<oneshot::Sender<u32>>>,
    read_error_slot: Option<ReadErrorSlot>,
    deferred_recv: Mutex<Option<(wtransport::RecvStream, StreamGuard)>>,
    budget: Mutex<Option<StreamBudget>>,
    deferred_budget: Mutex<Option<DeferredStreamBudgetConfig>>,
    deferred_read_error_slot: Mutex<Option<ReadErrorSlot>>,
    read_abort: Notify,
    read_aborted: AtomicBool,
    released: AtomicBool,
}

impl ClientUniRecvHandle {
    // Read-only handle: the recv bridge owns the budget and each buffered
    // StreamChunk carries its own reservation, so the handle does not retain one.
    pub fn new(read_rx: mpsc::Receiver<StreamChunk>, stop_tx: oneshot::Sender<u32>) -> Self {
        LIVE_UNI_RECV_HANDLES.fetch_add(1, Ordering::Relaxed);
        Self {
            read_rx: Mutex::new(Some(Arc::new(TokioMutex::new(read_rx)))),
            stop_tx: std::sync::Mutex::new(Some(stop_tx)),
            read_error_slot: None,
            deferred_recv: Mutex::new(None),
            budget: Mutex::new(None),
            deferred_budget: Mutex::new(None),
            deferred_read_error_slot: Mutex::new(None),
            read_abort: Notify::new(),
            read_aborted: AtomicBool::new(false),
            released: AtomicBool::new(false),
        }
    }

    pub fn new_with_slot(
        read_rx: mpsc::Receiver<StreamChunk>,
        stop_tx: oneshot::Sender<u32>,
        read_error_slot: Option<ReadErrorSlot>,
    ) -> Self {
        LIVE_UNI_RECV_HANDLES.fetch_add(1, Ordering::Relaxed);
        Self {
            read_rx: Mutex::new(Some(Arc::new(TokioMutex::new(read_rx)))),
            stop_tx: std::sync::Mutex::new(Some(stop_tx)),
            read_error_slot,
            deferred_recv: Mutex::new(None),
            budget: Mutex::new(None),
            deferred_budget: Mutex::new(None),
            deferred_read_error_slot: Mutex::new(None),
            read_abort: Notify::new(),
            read_aborted: AtomicBool::new(false),
            released: AtomicBool::new(false),
        }
    }

    /// Construct an accepted server uni stream without starting its receive
    /// bridge. The bridge starts only when the application calls `read()`.
    pub fn new_deferred(
        recv_stream: wtransport::RecvStream,
        guard: StreamGuard,
        budget: Option<DeferredStreamBudgetConfig>,
    ) -> Self {
        LIVE_UNI_RECV_HANDLES.fetch_add(1, Ordering::Relaxed);
        Self {
            read_rx: Mutex::new(None),
            stop_tx: std::sync::Mutex::new(None),
            read_error_slot: None,
            deferred_recv: Mutex::new(Some((recv_stream, guard))),
            budget: Mutex::new(None),
            deferred_budget: Mutex::new(budget),
            deferred_read_error_slot: Mutex::new(None),
            read_abort: Notify::new(),
            read_aborted: AtomicBool::new(false),
            released: AtomicBool::new(false),
        }
    }

    /// Consume a deferred server receive stream to EOF without creating a
    /// JavaScript stream bridge. See `ClientBidiStreamHandle::discard_incoming`.
    pub async fn discard_incoming(
        &mut self,
        scratch: &mut [u8],
    ) -> std::result::Result<(), String> {
        let pending = self
            .deferred_recv
            .lock()
            .map_err(|_| "E_INTERNAL: deferred stream lock poisoned".to_string())?
            .take();
        let mut result = Ok(());
        if let Some((recv_stream, _guard)) = pending {
            result = discard_recv_stream(recv_stream, scratch).await;
        }
        self.dispose_resources();
        self.release_live_counter();
        result
    }

    /// Read a deferred receive stream without creating a bridge task or
    /// channel. Accepted streams commonly deliver only one chunk before the
    /// JS facade cancels them, so keeping the transport receive state deferred
    /// avoids per-stream allocator churn while preserving repeated reads.
    async fn read_deferred_direct(&self) -> Result<Option<Option<napi::bindgen_prelude::Buffer>>> {
        let pending = self
            .deferred_recv
            .lock()
            .map_err(|_| napi::Error::from_reason("E_INTERNAL: deferred stream lock poisoned"))?
            .take();
        let Some((mut recv_stream, guard)) = pending else {
            return Ok(None);
        };
        if self.read_aborted.load(Ordering::Acquire) {
            recv_stream.stop(0);
            drop(guard);
            return Err(wt_from_reason("E_STREAM_RESET"));
        }

        let notified = self.read_abort.notified();
        tokio::pin!(notified);
        let mut buf = [0u8; STREAM_READ_BUFFER_BYTES];
        let result = tokio::select! {
            value = recv_stream.read(&mut buf) => value,
            _ = &mut notified => {
                recv_stream.stop(0);
                drop(guard);
                return Err(wt_from_reason("E_STREAM_RESET"));
            }
        };
        let read_result = match result {
            Ok(value) => value,
            Err(error) => {
                drop(guard);
                return Err(wt_from_reason(read_error_code(&error)));
            }
        };
        let Some(n) = read_result else {
            drop(guard);
            return Ok(Some(None));
        };
        let budget = installed_budget(&self.budget, &self.deferred_budget)?;
        if let Some(ref b) = budget {
            if should_reset_on_oversized_chunk(n as u64, &Some(b.clone())) {
                recv_stream.stop(0);
                drop(guard);
                return Err(wt_from_reason("E_STREAM_RESET"));
            }
            if !b.reserve_or_wait(n as u64).await {
                recv_stream.stop(0);
                drop(guard);
                return Err(wt_from_reason("E_BACKPRESSURE_TIMEOUT"));
            }
        }
        if self.read_aborted.load(Ordering::Acquire) {
            if let Some(ref b) = budget {
                b.release(n as u64);
            }
            recv_stream.stop(0);
            drop(guard);
            return Err(wt_from_reason("E_STREAM_RESET"));
        }
        let chunk = StreamChunk::new(buf[..n].to_vec(), budget, n as u64);
        let value = chunk.take().into();
        let mut deferred = self
            .deferred_recv
            .lock()
            .map_err(|_| napi::Error::from_reason("E_INTERNAL: deferred stream lock poisoned"))?;
        if self.read_aborted.load(Ordering::Acquire) {
            recv_stream.stop(0);
            drop(guard);
        } else {
            *deferred = Some((recv_stream, guard));
        }
        Ok(Some(Some(value)))
    }

    fn dispose_resources(&self) {
        self.read_aborted.store(true, Ordering::Release);
        self.read_abort.notify_waiters();
        if let Ok(mut stop) = self.stop_tx.lock() {
            if let Some(tx) = stop.take() {
                let _ = tx.send(0);
            }
        }
        if let Ok(mut read) = self.read_rx.lock() {
            read.take();
        }
        if let Ok(mut deferred) = self.deferred_recv.lock() {
            deferred.take();
        }
        if let Ok(mut budget) = self.budget.lock() {
            budget.take();
        }
        if let Ok(mut budget) = self.deferred_budget.lock() {
            budget.take();
        }
    }

    async fn ensure_deferred_read_bridge(&self) -> Result<()> {
        let has_pending = self
            .deferred_recv
            .lock()
            .map_err(|_| napi::Error::from_reason("E_INTERNAL: deferred stream lock poisoned"))?
            .is_some();
        if !has_pending {
            return Ok(());
        }

        let permit =
            acquire_deferred_read_bridge_permit(&self.read_abort, &self.read_aborted).await?;
        let pending = self
            .deferred_recv
            .lock()
            .map_err(|_| napi::Error::from_reason("E_INTERNAL: deferred stream lock poisoned"))?
            .take();
        let Some((recv_stream, guard)) = pending else {
            drop(permit);
            return Ok(());
        };
        let budget = self
            .deferred_budget
            .lock()
            .map_err(|_| napi::Error::from_reason("E_INTERNAL: deferred budget lock poisoned"))?
            .take()
            .map(DeferredStreamBudgetConfig::materialize);
        let (read_rx, stop_tx, read_error_slot) = spawn_uni_recv_bridge_on_with_permit(
            &RUNTIME,
            recv_stream,
            Some(guard),
            budget,
            Some(permit),
        );
        self.read_rx
            .lock()
            .map_err(|_| napi::Error::from_reason("E_INTERNAL: stream read lock poisoned"))?
            .replace(Arc::new(TokioMutex::new(read_rx)));
        self.stop_tx
            .lock()
            .map_err(|_| napi::Error::from_reason("E_INTERNAL: stream stop lock poisoned"))?
            .replace(stop_tx);
        self.deferred_read_error_slot
            .lock()
            .map_err(|_| napi::Error::from_reason("E_INTERNAL: deferred error lock poisoned"))?
            .replace(read_error_slot.expect("receive bridge always has an error slot"));
        Ok(())
    }

    /// Read one ordered load/evidence uni probe without creating a JS wrapper.
    pub(crate) async fn read_native_probe(&self) -> Result<Option<napi::bindgen_prelude::Buffer>> {
        Ok(self.read_deferred_direct().await?.flatten())
    }

    fn release_live_counter(&self) {
        if !self.released.swap(true, Ordering::AcqRel) {
            LIVE_UNI_RECV_HANDLES.fetch_sub(1, Ordering::Relaxed);
        }
    }
}

impl Drop for ClientUniRecvHandle {
    fn drop(&mut self) {
        self.release_live_counter();
    }
}

#[napi]
impl ClientUniRecvHandle {
    #[napi]
    pub async fn read(&self) -> Result<Option<napi::bindgen_prelude::Buffer>> {
        if let Some(result) = self.read_deferred_direct().await? {
            return Ok(result);
        }
        self.ensure_deferred_read_bridge().await?;
        let read_rx = self
            .read_rx
            .lock()
            .map_err(|_| napi::Error::from_reason("E_INTERNAL: stream read lock poisoned"))?
            .as_ref()
            .cloned()
            .ok_or_else(|| wt_from_reason("E_STREAM_RESET"))?;
        let mut rx = read_rx.lock().await;
        let read_abort = self.read_abort.notified();
        tokio::pin!(read_abort);
        if self.read_aborted.load(Ordering::Acquire) {
            return Err(wt_from_reason("E_STREAM_RESET"));
        }
        let result = match tokio::select! {
            value = rx.recv() => value,
            _ = &mut read_abort => {
                return Err(wt_from_reason("E_STREAM_RESET"));
            }
        } {
            // `chunk.take()` moves the payload out; the reservation is released
            // when the chunk drops at the end of this scope (see StreamChunk).
            Some(chunk) => Some(chunk.take().into()),
            None => {
                let deferred_slot = self
                    .deferred_read_error_slot
                    .lock()
                    .ok()
                    .and_then(|guard| guard.clone());
                if let Some(slot) = self.read_error_slot.as_ref().or(deferred_slot.as_ref()) {
                    if let Ok(guard) = slot.lock() {
                        if let Some(ref code) = *guard {
                            return Err(napi::Error::from_reason(code.clone()));
                        }
                    }
                }
                None
            }
        };
        Ok(result)
    }

    #[napi]
    pub fn stop_sending(&self, code: u32) -> WtResult<()> {
        self.read_aborted.store(true, Ordering::Release);
        self.read_abort.notify_waiters();
        if let Ok(mut guard) = self.stop_tx.lock() {
            if let Some(tx) = guard.take() {
                if tx.send(code).is_err() {
                    return Err(wt_from_reason("E_SESSION_CLOSED"));
                }
            }
        }
        if let Ok(mut deferred) = self.deferred_recv.lock() {
            if let Some((recv_stream, _guard)) = deferred.take() {
                recv_stream.stop(code);
            }
        }
        Ok(())
    }

    /// Release transport channels and bridge ownership immediately. N-API
    /// finalization may be delayed by the JS runtime, so stream wrappers call
    /// this during deterministic teardown instead of relying on GC.
    #[napi]
    pub fn dispose(&self) -> WtResult<()> {
        self.dispose_resources();
        self.release_live_counter();
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Bridge spawn functions
// ---------------------------------------------------------------------------

/// Spawn bridge tasks for a bidi stream on the server runtime.
/// Returns (read_rx, write_tx, stop_tx, write_error_slot) where write_error_slot
/// is set to E_STOP_SENDING or E_STREAM_RESET when write fails.
pub fn spawn_bidi_bridge(
    send_stream: wtransport::SendStream,
    recv_stream: wtransport::RecvStream,
    guard: Option<StreamGuard>,
    budget: Option<StreamBudget>,
) -> BidiBridgeParts {
    spawn_bidi_bridge_on(&RUNTIME, send_stream, recv_stream, guard, budget)
}

async fn finish_send_stream(
    send_stream: &mut wtransport::SendStream,
) -> std::result::Result<(), &'static str> {
    match send_stream.finish().await {
        Ok(()) => Ok(()),
        Err(StreamWriteError::Stopped(_)) => Err("E_STOP_SENDING"),
        Err(_) => Err("E_STREAM_RESET"),
    }
}

fn spawn_bidi_write_bridge_on(
    rt: &tokio::runtime::Runtime,
    mut send_stream: wtransport::SendStream,
    mut write_rx: mpsc::Receiver<StreamCmd>,
    write_error_slot: WriteErrorSlot,
) {
    let write_error_slot_clone = Arc::clone(&write_error_slot);
    rt.spawn(async move {
        while let Some(cmd) = write_rx.recv().await {
            match cmd {
                StreamCmd::Data(chunk) => match send_stream.write_all(chunk.as_bytes()).await {
                    Ok(()) => {}
                    Err(e) => {
                        let code = match &e {
                            StreamWriteError::Stopped(_) => "E_STOP_SENDING",
                            _ => "E_STREAM_RESET",
                        };
                        if let Ok(mut guard) = write_error_slot_clone.lock() {
                            if guard.is_none() {
                                *guard = Some(code.to_string());
                            }
                        }
                        break;
                    }
                },
                StreamCmd::Finish => {
                    if let Err(code) = finish_send_stream(&mut send_stream).await {
                        if let Ok(mut guard) = write_error_slot_clone.lock() {
                            if guard.is_none() {
                                *guard = Some(code.to_string());
                            }
                        }
                    }
                    break;
                }
                StreamCmd::FinishWithAck(done_tx) => {
                    let mut ret: std::result::Result<(), String> = Ok(());
                    if let Err(code) = finish_send_stream(&mut send_stream).await {
                        if let Ok(mut guard) = write_error_slot_clone.lock() {
                            if guard.is_none() {
                                *guard = Some(code.to_string());
                            }
                        }
                        ret = Err(code.to_string());
                    }
                    let _ = done_tx.send(ret);
                    break;
                }
                StreamCmd::Reset(code) => {
                    let _ = send_stream.reset(code);
                    break;
                }
            }
        }
    });
}

pub fn spawn_lazy_bidi_bridge(
    send_stream: wtransport::SendStream,
    recv_stream: wtransport::RecvStream,
    guard: Option<StreamGuard>,
    budget: Option<StreamBudget>,
) -> (
    mpsc::Receiver<StreamChunk>,
    oneshot::Sender<u32>,
    wtransport::SendStream,
    Option<ReadErrorSlot>,
) {
    spawn_lazy_bidi_bridge_on(&RUNTIME, send_stream, recv_stream, guard, budget)
}

pub fn spawn_lazy_bidi_bridge_on(
    rt: &tokio::runtime::Runtime,
    send_stream: wtransport::SendStream,
    recv_stream: wtransport::RecvStream,
    guard: Option<StreamGuard>,
    budget: Option<StreamBudget>,
) -> (
    mpsc::Receiver<StreamChunk>,
    oneshot::Sender<u32>,
    wtransport::SendStream,
    Option<ReadErrorSlot>,
) {
    let (read_rx, stop_tx, read_error_slot) = spawn_recv_bridge_on(rt, recv_stream, guard, budget);
    (read_rx, stop_tx, send_stream, read_error_slot)
}

/// Spawn only the receive half of a stream bridge. Accepted server streams use
/// this from a deferred handle so an application that never calls `read()`
/// does not allocate a Tokio task, channel, or scratch buffer for every stream.
fn spawn_recv_bridge_on(
    rt: &tokio::runtime::Runtime,
    recv_stream: wtransport::RecvStream,
    guard: Option<StreamGuard>,
    budget: Option<StreamBudget>,
) -> ReadBridgeParts {
    spawn_recv_bridge_on_with_permit(rt, recv_stream, guard, budget, None)
}

fn spawn_recv_bridge_on_with_permit(
    rt: &tokio::runtime::Runtime,
    mut recv_stream: wtransport::RecvStream,
    guard: Option<StreamGuard>,
    budget: Option<StreamBudget>,
    bridge_permit: Option<OwnedSemaphorePermit>,
) -> ReadBridgeParts {
    let (read_tx, read_rx) = mpsc::channel::<StreamChunk>(STREAM_CHANNEL_CAPACITY);
    let (stop_tx, stop_rx) = oneshot::channel::<u32>();
    let read_error_slot: ReadErrorSlot = Arc::new(Mutex::new(None));
    let read_budget = budget;
    let read_error_slot_clone = Arc::clone(&read_error_slot);
    rt.spawn(async move {
        let _bridge_permit = bridge_permit;
        let _guard = guard;
        let mut buf = vec![0u8; STREAM_READ_BUFFER_BYTES];
        let mut stop_rx = stop_rx;
        loop {
            tokio::select! {
                res = recv_stream.read(&mut buf) => {
                    match res {
                        Ok(Some(n)) => {
                            let sz = n as u64;
                            if let Some(ref b) = read_budget {
                                if should_reset_on_oversized_chunk(sz, &read_budget) {
                                    recv_stream.stop(0);
                                    if let Ok(mut g) = read_error_slot_clone.lock() {
                                        if g.is_none() {
                                            *g = Some("E_STREAM_RESET".to_string());
                                        }
                                    }
                                    break;
                                }
                                let mut abort_stop: Option<Option<u32>> = None;
                                while !b.try_reserve(sz) {
                                    let notified = b.capacity_notify.notified();
                                    tokio::pin!(notified);
                                    if b.try_reserve(sz) {
                                        break;
                                    }
                                    tokio::select! {
                                        _ = &mut notified => {}
                                        _ = tokio::time::sleep(BUDGET_POLL_INTERVAL) => {}
                                        code = &mut stop_rx => {
                                            abort_stop = Some(code.ok());
                                            break;
                                        }
                                    }
                                }
                                if let Some(stop_code) = abort_stop {
                                    if let Some(c) = stop_code {
                                        recv_stream.stop(c);
                                    }
                                    break;
                                }
                            }
                            let chunk = StreamChunk::new(buf[..n].to_vec(), read_budget.clone(), sz);
                            if read_tx.send(chunk).await.is_err() {
                                break;
                            }
                        }
                        Ok(None) => break,
                        Err(e) => {
                            if let Ok(mut guard) = read_error_slot_clone.lock() {
                                if guard.is_none() {
                                    *guard = Some(read_error_code(&e).to_string());
                                }
                            }
                            break;
                        }
                    }
                }
                code = &mut stop_rx => {
                    if let Ok(c) = code {
                        recv_stream.stop(c);
                    }
                    break;
                }
            }
        }
    });
    (read_rx, stop_tx, Some(read_error_slot))
}

/// Spawn bridge on a specific runtime (use CLIENT_RUNTIME for client streams).
pub fn spawn_bidi_bridge_on(
    rt: &tokio::runtime::Runtime,
    mut send_stream: wtransport::SendStream,
    mut recv_stream: wtransport::RecvStream,
    guard: Option<StreamGuard>,
    budget: Option<StreamBudget>,
) -> BidiBridgeParts {
    let (read_tx, read_rx) = mpsc::channel::<StreamChunk>(STREAM_CHANNEL_CAPACITY);
    let (write_tx, mut write_rx) = mpsc::channel::<StreamCmd>(STREAM_CHANNEL_CAPACITY);
    let (stop_tx, stop_rx) = oneshot::channel::<u32>();
    let write_error_slot: WriteErrorSlot = Arc::new(Mutex::new(None));
    let read_error_slot: ReadErrorSlot = Arc::new(Mutex::new(None));

    let read_budget = budget.clone();
    let read_error_slot_clone = Arc::clone(&read_error_slot);
    rt.spawn(async move {
        let _guard = guard;
        let mut buf = vec![0u8; STREAM_READ_BUFFER_BYTES];
        let mut stop_rx = stop_rx;
        loop {
            tokio::select! {
                res = recv_stream.read(&mut buf) => {
                    match res {
                        Ok(Some(n)) => {
                            let sz = n as u64;
                            if let Some(ref b) = read_budget {
                                // A chunk larger than the per-stream budget can
                                // NEVER be reserved: parking would wedge the
                                // stream forever. Stop it so the reader unblocks
                                // with an error instead of hanging.
                                if should_reset_on_oversized_chunk(sz, &read_budget) {
                                    recv_stream.stop(0);
                                    if let Ok(mut g) = read_error_slot_clone.lock() {
                                        if g.is_none() {
                                            *g = Some("E_STREAM_RESET".to_string());
                                        }
                                    }
                                    break;
                                }
                                // Lossless backpressure (see uni recv bridge): park
                                // on a full budget instead of resetting the stream,
                                // letting QUIC flow control push back on the sender.
                                let mut abort_stop: Option<Option<u32>> = None;
                                while !b.try_reserve(sz) {
                                    let notified = b.capacity_notify.notified();
                                    tokio::pin!(notified);
                                    if b.try_reserve(sz) {
                                        break;
                                    }
                                    tokio::select! {
                                        _ = &mut notified => {}
                                        // Periodic re-check: shared session/global
                                        // budget freed by a sibling stream notifies
                                        // its own notifier, not ours, so poll to
                                        // avoid an indefinite stall (stays lossless).
                                        _ = tokio::time::sleep(BUDGET_POLL_INTERVAL) => {}
                                        code = &mut stop_rx => {
                                            abort_stop = Some(code.ok());
                                            break;
                                        }
                                    }
                                }
                                if let Some(stop_code) = abort_stop {
                                    if let Some(c) = stop_code {
                                        recv_stream.stop(c);
                                    }
                                    break;
                                }
                            }
                            let chunk =
                                StreamChunk::new(buf[..n].to_vec(), read_budget.clone(), sz);
                            // On send failure the chunk is dropped here, releasing
                            // its reservation via Drop — no manual release needed.
                            if read_tx.send(chunk).await.is_err() {
                                break;
                            }
                        }
                        Ok(None) => break,
                        Err(e) => {
                            if let Ok(mut guard) = read_error_slot_clone.lock() {
                                if guard.is_none() {
                                    *guard = Some(read_error_code(&e).to_string());
                                }
                            }
                            break;
                        }
                    }
                }
                code = &mut stop_rx => {
                    if let Ok(c) = code {
                        recv_stream.stop(c);
                    }
                    break;
                }
            }
        }
    });

    // `budget` is dropped here: each StreamCmd::Data now carries its own
    // reservation via StreamChunk, releasing on write completion or teardown.
    drop(budget);
    let write_error_slot_clone = Arc::clone(&write_error_slot);
    rt.spawn(async move {
        while let Some(cmd) = write_rx.recv().await {
            match cmd {
                StreamCmd::Data(chunk) => {
                    // The chunk holds the byte reservation until it drops at the
                    // end of this arm (after the write completes or fails).
                    match send_stream.write_all(chunk.as_bytes()).await {
                        Ok(()) => {}
                        Err(e) => {
                            let code = match &e {
                                StreamWriteError::Stopped(_) => "E_STOP_SENDING",
                                _ => "E_STREAM_RESET",
                            };
                            if let Ok(mut guard) = write_error_slot_clone.lock() {
                                if guard.is_none() {
                                    *guard = Some(code.to_string());
                                }
                            }
                            break;
                        }
                    }
                }
                StreamCmd::Finish => {
                    if let Err(code) = finish_send_stream(&mut send_stream).await {
                        if let Ok(mut guard) = write_error_slot_clone.lock() {
                            if guard.is_none() {
                                *guard = Some(code.to_string());
                            }
                        }
                    }
                    break;
                }
                StreamCmd::FinishWithAck(done_tx) => {
                    let mut ret: std::result::Result<(), String> = Ok(());
                    if let Err(code) = finish_send_stream(&mut send_stream).await {
                        if let Ok(mut guard) = write_error_slot_clone.lock() {
                            if guard.is_none() {
                                *guard = Some(code.to_string());
                            }
                        }
                        ret = Err(code.to_string());
                    }
                    let _ = done_tx.send(ret);
                    break;
                }
                StreamCmd::Reset(code) => {
                    let _ = send_stream.reset(code);
                    break;
                }
            }
        }
    });

    (
        read_rx,
        write_tx,
        stop_tx,
        Some(write_error_slot),
        Some(read_error_slot),
    )
}

/// Spawn bridge for an outgoing uni stream.
/// Returns (write_tx, write_error_slot) where write_error_slot is set on write failure.
pub fn spawn_uni_send_bridge(
    send_stream: wtransport::SendStream,
    guard: Option<StreamGuard>,
    budget: Option<StreamBudget>,
) -> (mpsc::Sender<StreamCmd>, Option<WriteErrorSlot>) {
    spawn_uni_send_bridge_on(&RUNTIME, send_stream, guard, budget)
}

pub fn spawn_uni_send_bridge_on(
    rt: &tokio::runtime::Runtime,
    mut send_stream: wtransport::SendStream,
    guard: Option<StreamGuard>,
    budget: Option<StreamBudget>,
) -> (mpsc::Sender<StreamCmd>, Option<WriteErrorSlot>) {
    let (write_tx, mut write_rx) = mpsc::channel::<StreamCmd>(STREAM_CHANNEL_CAPACITY);
    let write_error_slot: WriteErrorSlot = Arc::new(Mutex::new(None));

    let write_error_slot_clone = Arc::clone(&write_error_slot);
    rt.spawn(async move {
        let _guard = guard;
        // Each StreamCmd::Data carries its own reservation via StreamChunk.
        drop(budget);
        while let Some(cmd) = write_rx.recv().await {
            match cmd {
                StreamCmd::Data(chunk) => {
                    // The chunk holds the byte reservation until it drops at the
                    // end of this arm (after the write completes or fails).
                    match send_stream.write_all(chunk.as_bytes()).await {
                        Ok(()) => {}
                        Err(e) => {
                            let code = match &e {
                                StreamWriteError::Stopped(_) => "E_STOP_SENDING",
                                _ => "E_STREAM_RESET",
                            };
                            if let Ok(mut guard) = write_error_slot_clone.lock() {
                                if guard.is_none() {
                                    *guard = Some(code.to_string());
                                }
                            }
                            break;
                        }
                    }
                }
                StreamCmd::Finish => {
                    if let Err(code) = finish_send_stream(&mut send_stream).await {
                        if let Ok(mut guard) = write_error_slot_clone.lock() {
                            if guard.is_none() {
                                *guard = Some(code.to_string());
                            }
                        }
                    }
                    break;
                }
                StreamCmd::FinishWithAck(done_tx) => {
                    let mut ret: std::result::Result<(), String> = Ok(());
                    if let Err(code) = finish_send_stream(&mut send_stream).await {
                        if let Ok(mut guard) = write_error_slot_clone.lock() {
                            if guard.is_none() {
                                *guard = Some(code.to_string());
                            }
                        }
                        ret = Err(code.to_string());
                    }
                    let _ = done_tx.send(ret);
                    break;
                }
                StreamCmd::Reset(code) => {
                    let _ = send_stream.reset(code);
                    break;
                }
            }
        }
    });

    (write_tx, Some(write_error_slot))
}

/// Spawn bridge for an incoming uni stream.
pub fn spawn_uni_recv_bridge(
    recv_stream: wtransport::RecvStream,
    guard: Option<StreamGuard>,
    budget: Option<StreamBudget>,
) -> (
    mpsc::Receiver<StreamChunk>,
    oneshot::Sender<u32>,
    Option<ReadErrorSlot>,
) {
    spawn_uni_recv_bridge_on(&RUNTIME, recv_stream, guard, budget)
}

pub fn spawn_uni_recv_bridge_on(
    rt: &tokio::runtime::Runtime,
    recv_stream: wtransport::RecvStream,
    guard: Option<StreamGuard>,
    budget: Option<StreamBudget>,
) -> (
    mpsc::Receiver<StreamChunk>,
    oneshot::Sender<u32>,
    Option<ReadErrorSlot>,
) {
    spawn_uni_recv_bridge_on_with_permit(rt, recv_stream, guard, budget, None)
}

fn spawn_uni_recv_bridge_on_with_permit(
    rt: &tokio::runtime::Runtime,
    mut recv_stream: wtransport::RecvStream,
    guard: Option<StreamGuard>,
    budget: Option<StreamBudget>,
    bridge_permit: Option<OwnedSemaphorePermit>,
) -> (
    mpsc::Receiver<StreamChunk>,
    oneshot::Sender<u32>,
    Option<ReadErrorSlot>,
) {
    let (read_tx, read_rx) = mpsc::channel::<StreamChunk>(STREAM_CHANNEL_CAPACITY);
    let (stop_tx, stop_rx) = oneshot::channel::<u32>();
    let read_error_slot: ReadErrorSlot = Arc::new(Mutex::new(None));

    let read_error_slot_clone = Arc::clone(&read_error_slot);
    rt.spawn(async move {
        let _bridge_permit = bridge_permit;
        let _guard = guard;
        let mut buf = vec![0u8; STREAM_READ_BUFFER_BYTES];
        let mut stop_rx = stop_rx;
        loop {
            tokio::select! {
                res = recv_stream.read(&mut buf) => {
                    match res {
                        Ok(Some(n)) => {
                            let sz = n as u64;
                            if let Some(ref b) = budget {
                                // A chunk larger than the per-stream budget can
                                // never be reserved: stop the stream instead of
                                // parking forever (see bidi recv bridge).
                                if should_reset_on_oversized_chunk(sz, &budget) {
                                    recv_stream.stop(0);
                                    if let Ok(mut g) = read_error_slot_clone.lock() {
                                        if g.is_none() {
                                            *g = Some("E_STREAM_RESET".to_string());
                                        }
                                    }
                                    break;
                                }
                                // Lossless backpressure: if the byte budget is
                                // momentarily full (slow consumer), park until a
                                // read() releases capacity rather than resetting
                                // the stream. While parked we stop pulling from
                                // quinn, so QUIC flow control pushes back on the
                                // sender — no data is dropped. `stop_rx` still
                                // aborts promptly. On loop exit the budget is
                                // reserved exactly once.
                                let mut abort_stop: Option<Option<u32>> = None;
                                while !b.try_reserve(sz) {
                                    // Register the wakeup BEFORE re-checking so a
                                    // release() between the failed try_reserve and
                                    // the await cannot be lost.
                                    let notified = b.capacity_notify.notified();
                                    tokio::pin!(notified);
                                    if b.try_reserve(sz) {
                                        break;
                                    }
                                    tokio::select! {
                                        _ = &mut notified => {}
                                        // Periodic re-check: shared session/global
                                        // budget freed by a sibling stream notifies
                                        // its own notifier, not ours, so poll to
                                        // avoid an indefinite stall (stays lossless).
                                        _ = tokio::time::sleep(BUDGET_POLL_INTERVAL) => {}
                                        code = &mut stop_rx => {
                                            abort_stop = Some(code.ok());
                                            break;
                                        }
                                    }
                                }
                                if let Some(stop_code) = abort_stop {
                                    if let Some(c) = stop_code {
                                        recv_stream.stop(c);
                                    }
                                    break;
                                }
                            }
                            let chunk = StreamChunk::new(buf[..n].to_vec(), budget.clone(), sz);
                            // On send failure the chunk is dropped here, releasing
                            // its reservation via Drop — no manual release needed.
                            if read_tx.send(chunk).await.is_err() {
                                break;
                            }
                        }
                        Ok(None) => break,
                        Err(e) => {
                            if let Ok(mut guard) = read_error_slot_clone.lock() {
                                if guard.is_none() {
                                    *guard = Some(read_error_code(&e).to_string());
                                }
                            }
                            break;
                        }
                    }
                }
                code = &mut stop_rx => {
                    if let Ok(c) = code {
                        recv_stream.stop(c);
                    }
                    break;
                }
            }
        }
    });

    (read_rx, stop_tx, Some(read_error_slot))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn budget(stream_queued: &Arc<AtomicU64>) -> StreamBudget {
        StreamBudget {
            server_metrics: Arc::new(crate::server_metrics::ServerMetrics::default()),
            session_metrics: Arc::new(crate::session_registry::SessionMetrics::default()),
            stream_queued: Arc::clone(stream_queued),
            max_global: 1 << 20,
            max_session: 1 << 18,
            max_stream: 1 << 16,
            capacity_notify: StreamBudget::new_notify(),
            backpressure_timeout_ms: 1000,
        }
    }

    // A buffered inbound chunk dropped on stream/session teardown must release
    // its three-tier reservation — the stream half of the P0 leak.
    #[test]
    fn stream_chunk_drop_releases_all_tiers() {
        let stream_queued = Arc::new(AtomicU64::new(0));
        let b = budget(&stream_queued);
        assert!(b.try_reserve(400));
        assert_eq!(
            b.server_metrics.queued_bytes_global.load(Ordering::Relaxed),
            400
        );
        assert_eq!(b.session_metrics.queued_bytes.load(Ordering::Relaxed), 400);
        assert_eq!(stream_queued.load(Ordering::Relaxed), 400);

        let chunk = StreamChunk::new(vec![0u8; 400], Some(b.clone()), 400);
        drop(chunk);

        assert_eq!(
            b.server_metrics.queued_bytes_global.load(Ordering::Relaxed),
            0
        );
        assert_eq!(b.session_metrics.queued_bytes.load(Ordering::Relaxed), 0);
        assert_eq!(stream_queued.load(Ordering::Relaxed), 0);
    }

    // take() (dequeue path) yields the payload and still releases exactly once.
    #[test]
    fn stream_chunk_take_then_drop_releases_once() {
        let stream_queued = Arc::new(AtomicU64::new(0));
        let b = budget(&stream_queued);
        assert!(b.try_reserve(400));
        let chunk = StreamChunk::new(vec![9u8; 400], Some(b.clone()), 400);
        let data = chunk.take();
        assert_eq!(data.len(), 400);
        assert_eq!(data[0], 9);
        assert_eq!(
            b.server_metrics.queued_bytes_global.load(Ordering::Relaxed),
            0
        );
        assert_eq!(stream_queued.load(Ordering::Relaxed), 0);
    }

    // No budget configured → no reservation, no release, no panic.
    #[test]
    fn stream_chunk_without_budget_is_noop() {
        let chunk = StreamChunk::new(vec![1u8; 10], None, 0);
        drop(chunk);
    }

    fn deferred_config() -> DeferredStreamBudgetConfig {
        DeferredStreamBudgetConfig::new(
            Arc::new(crate::server_metrics::ServerMetrics::default()),
            Arc::new(crate::session_registry::SessionMetrics::default()),
            1 << 20,
            1 << 18,
            1 << 16,
            1000,
        )
    }

    /// An accepted stream that is only ever written to (push-style server) must
    /// still install its byte budget: the deferred config is otherwise dropped
    /// on the floor and the documented queue limits go unenforced.
    #[tokio::test(flavor = "current_thread")]
    async fn write_path_materializes_deferred_budget() {
        let (write_tx, _write_rx) = mpsc::channel::<StreamCmd>(STREAM_CHANNEL_CAPACITY);
        let (_read_tx, read_rx) = mpsc::channel::<StreamChunk>(STREAM_CHANNEL_CAPACITY);
        let (stop_tx, _stop_rx) = oneshot::channel::<u32>();
        let handle = ClientBidiStreamHandle::new(read_rx, write_tx, stop_tx);
        *handle.deferred_budget.lock().unwrap() = Some(deferred_config());

        handle
            .write_bytes(vec![7u8; 128])
            .await
            .expect("write must succeed");

        let installed = handle.budget.lock().unwrap().clone();
        let installed = installed.expect("write path must materialize the deferred budget");
        assert!(
            handle.deferred_budget.lock().unwrap().is_none(),
            "deferred config must be consumed exactly once"
        );
        assert_eq!(installed.stream_queued.load(Ordering::Relaxed), 128);
        assert_eq!(
            installed
                .server_metrics
                .queued_bytes_global
                .load(Ordering::Relaxed),
            128
        );
        assert_eq!(
            installed
                .session_metrics
                .queued_bytes
                .load(Ordering::Relaxed),
            128
        );
    }

    /// Repeated writes must accumulate against the same materialized budget
    /// rather than minting a fresh (empty) one per call.
    #[tokio::test(flavor = "current_thread")]
    async fn repeated_writes_share_one_materialized_budget() {
        let (write_tx, _write_rx) = mpsc::channel::<StreamCmd>(STREAM_CHANNEL_CAPACITY);
        let (_read_tx, read_rx) = mpsc::channel::<StreamChunk>(STREAM_CHANNEL_CAPACITY);
        let (stop_tx, _stop_rx) = oneshot::channel::<u32>();
        let handle = ClientBidiStreamHandle::new(read_rx, write_tx, stop_tx);
        *handle.deferred_budget.lock().unwrap() = Some(deferred_config());

        for _ in 0..3 {
            handle
                .write_bytes(vec![1u8; 64])
                .await
                .expect("write must succeed");
        }

        let installed = handle.budget.lock().unwrap().clone().expect("budget");
        assert_eq!(installed.stream_queued.load(Ordering::Relaxed), 192);
    }

    #[test]
    fn recv_bridge_oversized_chunk_guard_matches_budget_limit() {
        let stream_queued = Arc::new(AtomicU64::new(0));
        let b = budget(&stream_queued);
        assert!(
            should_reset_on_oversized_chunk(b.max_stream + 1, &Some(b.clone())),
            "chunks above max_stream must request stream reset"
        );
        assert!(
            !should_reset_on_oversized_chunk(b.max_stream, &Some(b.clone())),
            "chunks at max_stream must be buffered"
        );
        assert!(
            !should_reset_on_oversized_chunk(b.max_stream + 1, &None),
            "chunks without a budget must not trigger the oversized guard"
        );
    }
}
