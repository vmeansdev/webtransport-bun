//! Stream handles: bridge wtransport QUIC streams to napi async read/write.
//!
//! Architecture:
//! - Write bridge: receives StreamCmd (Data/Finish/Reset) from a bounded mpsc channel.
//! - Read bridge: sends Vec<u8> to a bounded mpsc channel; selects on a stop_sending oneshot.
//! - read() awaits directly on the napi runtime (cross-runtime channel waker).

use crate::error::{from_reason as wt_from_reason, WtResult};
use napi::Result;
use napi_derive::napi;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::sync::Mutex;
use tokio::sync::{mpsc, oneshot, Mutex as TokioMutex};
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

/// Holds a closure that runs on drop to decrement stream counters.
/// Used by bridge tasks to properly track stream lifecycle.
pub struct StreamGuard {
    on_drop: Option<Box<dyn FnOnce() + Send>>,
}

impl StreamGuard {
    pub fn new(f: impl FnOnce() + Send + 'static) -> Self {
        Self {
            on_drop: Some(Box::new(f)),
        }
    }
}

impl Drop for StreamGuard {
    fn drop(&mut self) {
        if let Some(f) = self.on_drop.take() {
            f();
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

/// Fallback re-check interval for budget waits: bounds how long a stream can
/// stay parked when a *sibling* stream freed shared global/session budget (whose
/// release notifies its own per-stream notifier, not the waiter's).
const BUDGET_POLL_INTERVAL: tokio::time::Duration = tokio::time::Duration::from_millis(50);

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

fn read_error_code(err: &StreamReadError) -> &'static str {
    match err {
        StreamReadError::Reset(_) => "E_STREAM_RESET",
        StreamReadError::NotConnected | StreamReadError::QuicProto => "E_SESSION_CLOSED",
    }
}

fn should_reset_on_oversized_chunk(sz: u64, budget: &Option<StreamBudget>) -> bool {
    budget.as_ref().is_some_and(|b| sz > b.max_stream)
}

#[napi]
pub struct ClientBidiStreamHandle {
    read_rx: Arc<TokioMutex<mpsc::Receiver<StreamChunk>>>,
    write_tx: Option<mpsc::Sender<StreamCmd>>,
    stop_tx: std::sync::Mutex<Option<oneshot::Sender<u32>>>,
    budget: Option<StreamBudget>,
    write_error_slot: Option<WriteErrorSlot>,
    read_error_slot: Option<ReadErrorSlot>,
    /// Set once finish/reset is issued so a subsequent write is rejected
    /// deterministically (a closed stream never accepts more data), instead of
    /// racing into the channel behind the FIN.
    finished: Arc<std::sync::atomic::AtomicBool>,
}

impl ClientBidiStreamHandle {
    pub fn new(
        read_rx: mpsc::Receiver<StreamChunk>,
        write_tx: mpsc::Sender<StreamCmd>,
        stop_tx: oneshot::Sender<u32>,
    ) -> Self {
        Self {
            read_rx: Arc::new(TokioMutex::new(read_rx)),
            write_tx: Some(write_tx),
            stop_tx: std::sync::Mutex::new(Some(stop_tx)),
            budget: None,
            write_error_slot: None,
            read_error_slot: None,
            finished: Arc::new(std::sync::atomic::AtomicBool::new(false)),
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
        Self {
            read_rx: Arc::new(TokioMutex::new(read_rx)),
            write_tx: Some(write_tx),
            stop_tx: std::sync::Mutex::new(Some(stop_tx)),
            budget,
            write_error_slot,
            read_error_slot,
            finished: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        }
    }

    pub fn new_client_stream(
        read_rx: mpsc::Receiver<StreamChunk>,
        write_tx: mpsc::Sender<StreamCmd>,
        stop_tx: oneshot::Sender<u32>,
    ) -> Self {
        Self::new(read_rx, write_tx, stop_tx)
    }
}

#[napi]
impl ClientBidiStreamHandle {
    #[napi]
    pub async fn read(&self) -> Result<Option<napi::bindgen_prelude::Buffer>> {
        let read_rx = Arc::clone(&self.read_rx);
        let mut rx = read_rx.lock().await;
        match rx.recv().await {
            // `chunk.take()` moves the payload out; the reservation is released
            // when the chunk drops at the end of this scope (see StreamChunk).
            Some(chunk) => Ok(Some(chunk.take().into())),
            None => {
                if let Some(ref slot) = self.read_error_slot {
                    if let Ok(guard) = slot.lock() {
                        if let Some(ref code) = *guard {
                            return Err(wt_from_reason(code.clone()));
                        }
                    }
                }
                Ok(None)
            }
        }
    }

    #[napi]
    pub async fn write(&self, chunk: napi::bindgen_prelude::Buffer) -> Result<()> {
        // A finished/reset stream never accepts more data: reject deterministically
        // rather than letting a late write race into the channel behind the FIN.
        if self.finished.load(Ordering::Acquire) {
            return Err(wt_from_reason("E_STREAM_RESET"));
        }
        if let Some(ref slot) = self.write_error_slot {
            if let Ok(guard) = slot.lock() {
                if let Some(ref code) = *guard {
                    return Err(wt_from_reason(code.clone()));
                }
            }
        }
        let Some(ref tx) = self.write_tx else {
            return Err(wt_from_reason("E_STREAM_RESET"));
        };
        let bytes = chunk.to_vec();
        if bytes.is_empty() {
            return Ok(());
        }
        let sz = bytes.len() as u64;
        if let Some(ref b) = self.budget {
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
        let chunk = StreamChunk::new(bytes, self.budget.clone(), sz);
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
        send_ctrl_lossless(&self.write_tx, StreamCmd::Reset(code));
        Ok(())
    }

    #[napi]
    pub fn stop_sending(&self, code: u32) -> WtResult<()> {
        if let Ok(mut guard) = self.stop_tx.lock() {
            if let Some(tx) = guard.take() {
                if tx.send(code).is_err() {
                    return Err(wt_from_reason("E_SESSION_CLOSED"));
                }
            }
        }
        Ok(())
    }

    #[napi]
    pub fn finish(&self) -> WtResult<()> {
        self.finished.store(true, Ordering::Release);
        send_ctrl_lossless(&self.write_tx, StreamCmd::Finish);
        Ok(())
    }

    #[napi]
    pub async fn finish_wait(&self) -> Result<()> {
        self.finished.store(true, Ordering::Release);
        let Some(ref tx) = self.write_tx else {
            return Err(napi::Error::from_reason("E_STREAM_RESET"));
        };
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
}

// ---------------------------------------------------------------------------
// Outgoing uni stream handle (write-only)
// ---------------------------------------------------------------------------

#[napi]
pub struct ClientUniSendHandle {
    write_tx: Option<mpsc::Sender<StreamCmd>>,
    budget: Option<StreamBudget>,
    write_error_slot: Option<WriteErrorSlot>,
    /// See `ClientBidiStreamHandle::finished`.
    finished: Arc<std::sync::atomic::AtomicBool>,
}

impl ClientUniSendHandle {
    pub fn new(write_tx: mpsc::Sender<StreamCmd>) -> Self {
        Self {
            write_tx: Some(write_tx),
            budget: None,
            write_error_slot: None,
            finished: Arc::new(std::sync::atomic::AtomicBool::new(false)),
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
        Self {
            write_tx: Some(write_tx),
            budget,
            write_error_slot,
            finished: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        }
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
        let Some(ref tx) = self.write_tx else {
            return Err(napi::Error::from_reason("E_STREAM_RESET"));
        };
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
        send_ctrl_lossless(&self.write_tx, StreamCmd::Reset(code));
        Ok(())
    }

    #[napi]
    pub fn finish(&self) -> WtResult<()> {
        self.finished.store(true, Ordering::Release);
        send_ctrl_lossless(&self.write_tx, StreamCmd::Finish);
        Ok(())
    }

    #[napi]
    pub async fn finish_wait(&self) -> Result<()> {
        self.finished.store(true, Ordering::Release);
        let Some(ref tx) = self.write_tx else {
            return Err(napi::Error::from_reason("E_STREAM_RESET"));
        };
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
}

// ---------------------------------------------------------------------------
// Incoming uni stream handle (read-only)
// ---------------------------------------------------------------------------

#[napi]
pub struct ClientUniRecvHandle {
    read_rx: Arc<TokioMutex<mpsc::Receiver<StreamChunk>>>,
    stop_tx: std::sync::Mutex<Option<oneshot::Sender<u32>>>,
    read_error_slot: Option<ReadErrorSlot>,
}

impl ClientUniRecvHandle {
    // Read-only handle: the recv bridge owns the budget and each buffered
    // StreamChunk carries its own reservation, so the handle does not retain one.
    pub fn new(read_rx: mpsc::Receiver<StreamChunk>, stop_tx: oneshot::Sender<u32>) -> Self {
        Self {
            read_rx: Arc::new(TokioMutex::new(read_rx)),
            stop_tx: std::sync::Mutex::new(Some(stop_tx)),
            read_error_slot: None,
        }
    }

    pub fn new_with_slot(
        read_rx: mpsc::Receiver<StreamChunk>,
        stop_tx: oneshot::Sender<u32>,
        read_error_slot: Option<ReadErrorSlot>,
    ) -> Self {
        Self {
            read_rx: Arc::new(TokioMutex::new(read_rx)),
            stop_tx: std::sync::Mutex::new(Some(stop_tx)),
            read_error_slot,
        }
    }
}

#[napi]
impl ClientUniRecvHandle {
    #[napi]
    pub async fn read(&self) -> Result<Option<napi::bindgen_prelude::Buffer>> {
        let read_rx = Arc::clone(&self.read_rx);
        let mut rx = read_rx.lock().await;
        match rx.recv().await {
            // `chunk.take()` moves the payload out; the reservation is released
            // when the chunk drops at the end of this scope (see StreamChunk).
            Some(chunk) => Ok(Some(chunk.take().into())),
            None => {
                if let Some(ref slot) = self.read_error_slot {
                    if let Ok(guard) = slot.lock() {
                        if let Some(ref code) = *guard {
                            return Err(napi::Error::from_reason(code.clone()));
                        }
                    }
                }
                Ok(None)
            }
        }
    }

    #[napi]
    pub fn stop_sending(&self, code: u32) -> WtResult<()> {
        if let Ok(mut guard) = self.stop_tx.lock() {
            if let Some(tx) = guard.take() {
                if tx.send(code).is_err() {
                    return Err(wt_from_reason("E_SESSION_CLOSED"));
                }
            }
        }
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

/// Spawn bridge on a specific runtime (use CLIENT_RUNTIME for client streams).
pub fn spawn_bidi_bridge_on(
    rt: &tokio::runtime::Runtime,
    mut send_stream: wtransport::SendStream,
    mut recv_stream: wtransport::RecvStream,
    guard: Option<StreamGuard>,
    budget: Option<StreamBudget>,
) -> BidiBridgeParts {
    let (read_tx, read_rx) = mpsc::channel::<StreamChunk>(256);
    let (write_tx, mut write_rx) = mpsc::channel::<StreamCmd>(256);
    let (stop_tx, stop_rx) = oneshot::channel::<u32>();
    let write_error_slot: WriteErrorSlot = Arc::new(Mutex::new(None));
    let read_error_slot: ReadErrorSlot = Arc::new(Mutex::new(None));

    let read_budget = budget.clone();
    let read_error_slot_clone = Arc::clone(&read_error_slot);
    rt.spawn(async move {
        let _guard = guard;
        let mut buf = vec![0u8; 64 * 1024];
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
                    if let Err(e) = send_stream.finish().await {
                        let code = match &e {
                            StreamWriteError::Stopped(_) => "E_STOP_SENDING",
                            _ => "E_STREAM_RESET",
                        };
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
                    if let Err(e) = send_stream.finish().await {
                        let code = match &e {
                            StreamWriteError::Stopped(_) => "E_STOP_SENDING",
                            _ => "E_STREAM_RESET",
                        };
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
    let (write_tx, mut write_rx) = mpsc::channel::<StreamCmd>(256);
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
                    if let Err(e) = send_stream.finish().await {
                        let code = match &e {
                            StreamWriteError::Stopped(_) => "E_STOP_SENDING",
                            _ => "E_STREAM_RESET",
                        };
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
                    if let Err(e) = send_stream.finish().await {
                        let code = match &e {
                            StreamWriteError::Stopped(_) => "E_STOP_SENDING",
                            _ => "E_STREAM_RESET",
                        };
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
    mut recv_stream: wtransport::RecvStream,
    guard: Option<StreamGuard>,
    budget: Option<StreamBudget>,
) -> (
    mpsc::Receiver<StreamChunk>,
    oneshot::Sender<u32>,
    Option<ReadErrorSlot>,
) {
    let (read_tx, read_rx) = mpsc::channel::<StreamChunk>(256);
    let (stop_tx, stop_rx) = oneshot::channel::<u32>();
    let read_error_slot: ReadErrorSlot = Arc::new(Mutex::new(None));

    let read_error_slot_clone = Arc::clone(&read_error_slot);
    rt.spawn(async move {
        let _guard = guard;
        let mut buf = vec![0u8; 64 * 1024];
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
