//! Session capacity, datagram, and stream helpers (NAPI-free).
//! NAPI bindings live in `session_napi.rs`. Coverage floors target this module.

use napi::Result;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tokio::sync::Notify;
use tokio::time::{Duration, Instant};

use crate::client_stream::{ClientBidiStreamHandle, ClientUniRecvHandle, ClientUniSendHandle};
use crate::error::from_upstream_error as wt_from_upstream_error;
use crate::session_registry;
use crate::session_registry::SessionMetrics;

pub(crate) struct StreamCapacityView {
    pub global_active: u64,
    pub max_global: u64,
    pub bidi_active: u64,
    pub uni_active: u64,
    pub max_bidi: u64,
    pub max_uni: u64,
    pub notify: Arc<Notify>,
}

/// Pure capacity predicate used by stream-open waiters.
#[cfg(test)]
pub(crate) fn stream_kind_has_capacity(
    kind: &str,
    global_active: u64,
    max_global: u64,
    session_metrics: &SessionMetrics,
    max_bidi: u64,
    max_uni: u64,
) -> bool {
    stream_kind_view_has_capacity(
        kind,
        global_active,
        max_global,
        session_metrics.streams_bidi_active.load(Ordering::Relaxed),
        session_metrics.streams_uni_active.load(Ordering::Relaxed),
        max_bidi,
        max_uni,
    )
}

pub(crate) fn stream_kind_view_has_capacity(
    kind: &str,
    global_active: u64,
    max_global: u64,
    bidi_active: u64,
    uni_active: u64,
    max_bidi: u64,
    max_uni: u64,
) -> bool {
    let global_ok = global_active < max_global;
    let kind_ok = match kind {
        "bidi" => bidi_active < max_bidi,
        "uni" => uni_active < max_uni,
        _ => false,
    };
    global_ok && kind_ok
}

/// Async wait loop shared by `wait_bidi_capacity` / `wait_uni_capacity`.
/// `load` returns `None` when the session is gone (`E_SESSION_CLOSED`).
pub(crate) async fn wait_stream_kind_capacity_with_timeout<F>(
    timeout_ms: u32,
    kind: &'static str,
    mut load: F,
) -> Result<()>
where
    F: FnMut() -> Option<StreamCapacityView>,
{
    let deadline = Instant::now() + Duration::from_millis(timeout_ms as u64);
    loop {
        let Some(view) = load() else {
            return Err(napi::Error::from_reason("E_SESSION_CLOSED"));
        };
        // Register the wakeup BEFORE re-checking capacity so a
        // `notify_waiters()` fired by a StreamGuard drop between the check
        // and the await is not lost (tokio Notify stores no permit). Without
        // this, a stream freed in that window leaves the waiter sleeping the
        // full timeout and yielding a spurious E_BACKPRESSURE_TIMEOUT.
        // `enable()` enrolls the future in the waiter list NOW — a pinned
        // Notified does not register until its first poll, so without this
        // the window the ordering is meant to close stays open.
        let notified = view.notify.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();

        if stream_kind_view_has_capacity(
            kind,
            view.global_active,
            view.max_global,
            view.bidi_active,
            view.uni_active,
            view.max_bidi,
            view.max_uni,
        ) {
            return Ok(());
        }
        let now = Instant::now();
        if now >= deadline {
            return Err(napi::Error::from_reason("E_BACKPRESSURE_TIMEOUT"));
        }
        let remain = deadline.saturating_duration_since(now);
        tokio::time::timeout(remain, notified)
            .await
            .map_err(|_| napi::Error::from_reason("E_BACKPRESSURE_TIMEOUT"))?;
    }
}

pub(crate) fn session_metrics_snapshot_from(
    sm: Option<&SessionMetrics>,
) -> crate::metrics::SessionMetricsSnapshot {
    if let Some(sm) = sm {
        crate::metrics::SessionMetricsSnapshot {
            datagrams_in: sm.datagrams_in.load(Ordering::Relaxed) as f64,
            datagrams_out: sm.datagrams_out.load(Ordering::Relaxed) as f64,
            streams_active: sm.streams_active() as u32,
            queued_bytes: sm.queued_bytes.load(Ordering::Relaxed) as f64,
        }
    } else {
        crate::metrics::SessionMetricsSnapshot {
            datagrams_in: 0.0,
            datagrams_out: 0.0,
            streams_active: 0,
            queued_bytes: 0.0,
        }
    }
}

pub(crate) async fn send_datagram_for_session(id: &str, bytes: &[u8]) -> Result<()> {
    let Some((conn, metrics, sm, limits, datagram_capacity_notify, lifecycle_closed)) =
        session_registry::get_datagram_send_state(id)
    else {
        return Err(napi::Error::from_reason("E_SESSION_CLOSED"));
    };
    let sz = bytes.len();
    if sz > limits.max_datagram_size {
        return Err(napi::Error::from_reason("E_QUEUE_FULL"));
    }
    let sz_u64 = sz as u64;
    let deadline = Instant::now() + Duration::from_millis(limits.backpressure_timeout_ms);
    session_registry::reserve_datagram_capacity(
        &metrics,
        &sm,
        &datagram_capacity_notify,
        &lifecycle_closed,
        &limits,
        sz_u64,
        deadline,
    )
    .await
    .map_err(|err| match err {
        session_registry::DatagramCapacityError::Closed => {
            napi::Error::from_reason("E_SESSION_CLOSED")
        }
        session_registry::DatagramCapacityError::Timeout => {
            napi::Error::from_reason("E_BACKPRESSURE_TIMEOUT")
        }
    })?;
    let start = std::time::Instant::now();
    let result = conn
        .send_datagram(bytes)
        .map_err(|_| napi::Error::from_reason("E_SESSION_CLOSED"));
    metrics.release_datagram_capacity(&sm.queued_bytes, &datagram_capacity_notify, sz_u64);
    result?;
    metrics.datagram_enqueue_histogram.observe(start.elapsed());
    metrics.datagrams_out.fetch_add(1, Ordering::Relaxed);
    sm.datagrams_out.fetch_add(1, Ordering::Relaxed);
    Ok(())
}

/// Largest batch one delivery call may carry.
///
/// The point of batching is amortizing the N-API round trip, and the win is
/// already flat well before here; a larger cap only widens the window in which
/// dequeued payloads are held outside the queue's byte reservation.
const DATAGRAM_BATCH_MAX: u32 = 256;

/// Clamp a caller-supplied batch size into range. Out-of-range values are
/// corrected silently: a rejected async N-API call leaks its self-reference
/// under Bun, so user input must never become an `Err`.
fn clamp_batch_max(max: u32) -> usize {
    max.clamp(1, DATAGRAM_BATCH_MAX) as usize
}

/// Wait for one datagram, waking on session close rather than only on the
/// sender being dropped.
///
/// The registration order matters: the `Notified` future is created and
/// `enable()`d before the sticky flag is re-read, so a close landing in that
/// window is still delivered as a wake (tokio's `Notify` stores no permit for
/// a future that has not registered). A spurious wake loops and rechecks; only
/// the sticky flag ends the wait.
async fn recv_datagram_slot(
    rx: &mut tokio::sync::mpsc::Receiver<session_registry::DatagramSlot>,
    lifecycle_closed: &std::sync::atomic::AtomicBool,
    lifecycle_notify: &Notify,
) -> Option<session_registry::DatagramSlot> {
    loop {
        let notified = lifecycle_notify.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();

        if lifecycle_closed.load(Ordering::Acquire) {
            return None;
        }
        tokio::select! {
            // Biased so a close that races a queued datagram wins
            // deterministically: a closed session discards what is still
            // queued instead of draining it first.
            biased;
            _ = notified => {}
            slot = rx.recv() => return slot,
        }
    }
}

/// Read up to `max` datagrams with one blocking wait: park for the first, then
/// take whatever else is already queued. Never yields an empty batch — the
/// result is a non-empty batch or `None` for EOF/close.
async fn read_datagram_batch_from_state(
    dgram_rx: &tokio::sync::Mutex<tokio::sync::mpsc::Receiver<session_registry::DatagramSlot>>,
    lifecycle_closed: &std::sync::atomic::AtomicBool,
    lifecycle_notify: &Notify,
    max: u32,
) -> Option<Vec<Vec<u8>>> {
    let cap = clamp_batch_max(max);
    let mut rx = dgram_rx.lock().await;
    let first = recv_datagram_slot(&mut rx, lifecycle_closed, lifecycle_notify).await?;

    let mut batch = Vec::with_capacity(cap);
    batch.push(first.take());
    while batch.len() < cap {
        let Ok(slot) = rx.try_recv() else {
            break;
        };
        batch.push(slot.take());
    }
    Some(batch)
}

pub(crate) async fn read_datagram_batch_for_session(
    id: &str,
    max: u32,
) -> Result<Option<Vec<Vec<u8>>>> {
    let Some((dgram_rx, lifecycle_closed, lifecycle_notify)) =
        session_registry::get_datagram_read_state(id)
    else {
        return Ok(None);
    };
    Ok(read_datagram_batch_from_state(&dgram_rx, &lifecycle_closed, &lifecycle_notify, max).await)
}

pub(crate) async fn read_datagram_for_session(id: &str) -> Result<Option<Vec<u8>>> {
    Ok(read_datagram_batch_for_session(id, 1)
        .await?
        .and_then(|batch| batch.into_iter().next()))
}

pub(crate) async fn discard_datagram_for_session(
    id: &str,
    timeout: Option<Duration>,
) -> Result<Option<bool>> {
    let Some((_, dgram_rx, _, _, _, _, _)) = session_registry::get(id) else {
        return Ok(None);
    };
    let mut rx = dgram_rx.lock().await;
    let next = match timeout {
        Some(limit) => match tokio::time::timeout(limit, rx.recv()).await {
            Ok(slot) => slot,
            Err(_) => return Ok(Some(false)),
        },
        None => rx.recv().await,
    };
    match next {
        Some(slot) => {
            slot.discard();
            Ok(Some(true))
        }
        None => Ok(None),
    }
}

/// Consume queued datagrams until the session closes or the bounded deadline
/// expires, without crossing the NAPI boundary once per payload.
///
/// The load/evidence drain is a black-hole consumer: it needs delivery counts,
/// not payload bytes. Keeping this loop on the native runtime avoids creating a
/// Tokio task and JavaScript promise for every low-rate datagram while retaining
/// the same channel ownership and reservation-release semantics as the single
/// item helper above.
pub(crate) async fn discard_datagrams_for_session(
    id: &str,
    timeout: Option<Duration>,
) -> Result<Option<u64>> {
    let Some((_, dgram_rx, _, _, _, _, _)) = session_registry::get(id) else {
        return Ok(None);
    };
    let mut rx = dgram_rx.lock().await;
    let deadline = timeout.map(|limit| tokio::time::Instant::now() + limit);
    let mut discarded = 0u64;
    loop {
        let next = match deadline {
            Some(deadline) => match tokio::time::timeout_at(deadline, rx.recv()).await {
                Ok(slot) => slot,
                Err(_) => return Ok(Some(discarded)),
            },
            None => rx.recv().await,
        };
        match next {
            Some(slot) => {
                slot.discard();
                discarded = discarded.saturating_add(1);
            }
            None => {
                return Ok(if discarded == 0 {
                    None
                } else {
                    Some(discarded)
                })
            }
        }
    }
}

/// How long the queued-handle phase waits for the next already-accepted stream
/// before concluding the mode-switch window is drained.
const STREAM_DISCARD_QUEUE_IDLE: Duration = Duration::from_millis(100);
/// Poll interval for the native direct-consume wait phase.
const STREAM_DISCARD_POLL: Duration = Duration::from_millis(50);

/// Delivery accounting for one bounded native stream drain.
///
/// The count is the evidence the caller asked for, so it is never replaced by
/// an error: stream failures are counted separately and the first error is
/// carried alongside as diagnostic metadata.
#[derive(Default)]
pub(crate) struct StreamDiscardOutcome {
    pub completed: u64,
    pub errored: u64,
    pub timed_out: bool,
    pub diagnostic: Option<String>,
}

impl StreamDiscardOutcome {
    fn observe_error(&mut self, error: String) {
        self.errored = self.errored.saturating_add(1);
        if self.diagnostic.is_none() {
            self.diagnostic = Some(error);
        }
    }
}

/// A connection-close race ends the drain but is not a drain failure: no more
/// streams can arrive, so the count collected so far is the final answer.
fn discard_error_is_terminal(error: &str) -> bool {
    error.starts_with("E_SESSION_CLOSED")
}

/// Close and reset races are expected while a black-hole drain runs against a
/// peer that is tearing down. Anything else is worth a stderr note.
fn discard_error_is_expected(error: &str) -> bool {
    discard_error_is_terminal(error) || error.starts_with("E_STREAM_RESET")
}

/// Accounting sink for a drain. Implemented by the session-owned discard state;
/// the indirection keeps the drain loops unit-testable without a live session.
pub(crate) trait StreamDiscardSink {
    fn record(&self, result: std::result::Result<(), String>);
    fn completed(&self) -> u64;
    fn error(&self) -> Option<String>;
    fn is_closed(&self) -> bool;
}

impl StreamDiscardSink for session_registry::StreamDiscardState {
    fn record(&self, result: std::result::Result<(), String>) {
        session_registry::StreamDiscardState::record(self, result);
    }

    fn completed(&self) -> u64 {
        session_registry::StreamDiscardState::completed(self)
    }

    fn error(&self) -> Option<String> {
        session_registry::StreamDiscardState::error(self)
    }

    fn is_closed(&self) -> bool {
        session_registry::StreamDiscardState::is_closed(self)
    }
}

/// A stream that can be consumed to EOF without materializing payload bytes.
pub(crate) trait DiscardableStream {
    fn discard_stream(
        &mut self,
        scratch: &mut [u8],
    ) -> impl std::future::Future<Output = std::result::Result<(), String>> + Send;
}

impl DiscardableStream for ClientBidiStreamHandle {
    fn discard_stream(
        &mut self,
        scratch: &mut [u8],
    ) -> impl std::future::Future<Output = std::result::Result<(), String>> + Send {
        self.discard_incoming(scratch)
    }
}

impl DiscardableStream for ClientUniRecvHandle {
    fn discard_stream(
        &mut self,
        scratch: &mut [u8],
    ) -> impl std::future::Future<Output = std::result::Result<(), String>> + Send {
        self.discard_incoming(scratch)
    }
}

/// Acquire the accept-queue lock under the caller deadline. A parked JS accept
/// pull holds this lock, so an unbounded wait here would hang the discard
/// promise regardless of the caller timeout.
async fn lock_with_deadline<T>(
    lock: &tokio::sync::Mutex<T>,
    deadline: Option<Instant>,
) -> Option<tokio::sync::MutexGuard<'_, T>> {
    match deadline {
        Some(deadline) => tokio::time::timeout_at(deadline, lock.lock()).await.ok(),
        None => Some(lock.lock().await),
    }
}

/// Drain stream handles already queued at the mode switch. Returns `false` when
/// the drain hit its deadline or a connection-close race, meaning there is no
/// point waiting for further native direct streams.
async fn drain_queued_discard_streams<T, S>(
    rx: &mut tokio::sync::mpsc::Receiver<Box<T>>,
    state: &S,
    deadline: Option<Instant>,
    outcome: &mut StreamDiscardOutcome,
) -> bool
where
    T: DiscardableStream,
    S: StreamDiscardSink,
{
    let mut scratch = None;
    loop {
        let wait = match deadline {
            Some(deadline) => {
                let now = Instant::now();
                if now >= deadline {
                    outcome.timed_out = true;
                    return false;
                }
                (deadline - now).min(STREAM_DISCARD_QUEUE_IDLE)
            }
            None => STREAM_DISCARD_QUEUE_IDLE,
        };
        let Ok(next) = tokio::time::timeout(wait, rx.recv()).await else {
            // Either the queue went idle (mode-switch window drained) or the
            // caller deadline cut the wait short.
            outcome.timed_out = deadline.is_some_and(|deadline| Instant::now() >= deadline);
            return !outcome.timed_out;
        };
        let Some(mut stream) = next else {
            return true;
        };
        let scratch = scratch
            .get_or_insert_with(|| vec![0u8; crate::client_stream::STREAM_READ_BUFFER_BYTES]);
        let result = stream.discard_stream(scratch).await;
        state.record(result.clone());
        if let Err(error) = result {
            let terminal = discard_error_is_terminal(&error);
            outcome.observe_error(error);
            if terminal {
                return false;
            }
        }
    }
}

/// Wait for native direct-consume state until the session closes or the
/// bounded deadline expires. The completed count is authoritative; an error
/// recorded by the accept loop never ends the wait or replaces the count.
async fn wait_for_stream_discard<S: StreamDiscardSink>(
    state: &S,
    deadline: Option<Instant>,
    outcome: &mut StreamDiscardOutcome,
) {
    loop {
        outcome.completed = state.completed();
        if outcome.diagnostic.is_none() {
            outcome.diagnostic = state.error();
        }
        if state.is_closed() {
            return;
        }
        match deadline {
            Some(deadline) => {
                let now = Instant::now();
                if now >= deadline {
                    outcome.timed_out = true;
                    return;
                }
                let poll = (deadline - now).min(STREAM_DISCARD_POLL);
                tokio::time::sleep(poll).await;
            }
            None => tokio::time::sleep(STREAM_DISCARD_POLL).await,
        }
    }
}

/// Project a drain outcome onto the N-API contract (`number | null`). `None`
/// means the drain saw nothing at all; every other case reports the delivered
/// count, including close races and deadline expiry.
fn finish_stream_discard(kind: &str, outcome: StreamDiscardOutcome) -> Option<u64> {
    if let Some(error) = outcome.diagnostic.as_deref() {
        if !discard_error_is_expected(error) {
            eprintln!(
                "webtransport-native: {} discard completed {} stream(s) with {} error(s); first: {}",
                kind, outcome.completed, outcome.errored, error
            );
        }
    }
    if outcome.completed == 0
        && outcome.errored == 0
        && !outcome.timed_out
        && outcome.diagnostic.is_none()
    {
        None
    } else {
        Some(outcome.completed)
    }
}

async fn discard_streams_for_session<T, S>(
    kind: &str,
    accept_rx: Arc<tokio::sync::Mutex<tokio::sync::mpsc::Receiver<Box<T>>>>,
    state: S,
    deadline: Option<Instant>,
) -> Option<u64>
where
    T: DiscardableStream,
    S: StreamDiscardSink,
{
    let mut outcome = StreamDiscardOutcome::default();
    match lock_with_deadline(&accept_rx, deadline).await {
        Some(mut rx) => {
            let keep_waiting =
                drain_queued_discard_streams(&mut rx, &state, deadline, &mut outcome).await;
            // The accept queue is empty after the mode-switch window. Do not
            // retain the guard (or a scratch allocation) while waiting for
            // native direct streams.
            drop(rx);
            if keep_waiting {
                wait_for_stream_discard(&state, deadline, &mut outcome).await;
            } else {
                outcome.completed = state.completed();
            }
        }
        None => {
            // A parked accept pull still owns the queue; report what the accept
            // loop consumed directly rather than hanging past the deadline.
            outcome.timed_out = true;
            outcome.completed = state.completed();
        }
    }
    finish_stream_discard(kind, outcome)
}

/// Consume accepted bidi streams without materializing N-API stream handles.
/// Native direct mode drains future streams in the QUIC accept loop; only
/// handles already queued at the mode switch cross this function.
pub(crate) async fn discard_bidi_streams_for_session(
    id: &str,
    timeout: Option<Duration>,
) -> Result<Option<u64>> {
    let deadline = timeout.map(|limit| Instant::now() + limit);
    let Some(state) = session_registry::enable_bidi_discard(id) else {
        return Ok(None);
    };
    let Some((bidi_rx, _, _, _)) = session_registry::get_stream_accept_state(id) else {
        return Ok(None);
    };
    Ok(discard_streams_for_session("bidi", bidi_rx, state, deadline).await)
}

/// Consume accepted uni streams without crossing the N-API wrapper boundary.
pub(crate) async fn discard_uni_streams_for_session(
    id: &str,
    timeout: Option<Duration>,
) -> Result<Option<u64>> {
    let deadline = timeout.map(|limit| Instant::now() + limit);
    let Some(state) = session_registry::enable_uni_discard(id) else {
        return Ok(None);
    };
    let Some((_, uni_rx, _, _)) = session_registry::get_stream_accept_state(id) else {
        return Ok(None);
    };
    Ok(discard_streams_for_session("uni", uni_rx, state, deadline).await)
}

pub(crate) async fn create_bidi_stream_for_session(id: &str) -> Result<ClientBidiStreamHandle> {
    let Some((_, _, metrics, _, _, create_bi_tx, _)) = session_registry::get(id) else {
        return Err(napi::Error::from_reason("E_SESSION_CLOSED"));
    };
    let start = std::time::Instant::now();
    let (resp_tx, resp_rx) = tokio::sync::oneshot::channel();
    create_bi_tx
        .send(resp_tx)
        .await
        .map_err(|_| napi::Error::from_reason("E_SESSION_CLOSED"))?;
    let result = resp_rx
        .await
        .map_err(|_| napi::Error::from_reason("E_SESSION_CLOSED"))?
        .map_err(wt_from_upstream_error);
    if result.is_ok() {
        metrics.stream_open_histogram.observe(start.elapsed());
    }
    result
}

pub(crate) async fn accept_bidi_stream_for_session(
    id: &str,
) -> Result<Option<ClientBidiStreamHandle>> {
    let Some((bidi_rx, _, lifecycle_closed, lifecycle_notify)) =
        session_registry::get_stream_accept_state(id)
    else {
        return Ok(None);
    };
    if lifecycle_closed.load(Ordering::Acquire) {
        return Ok(None);
    }
    let mut rx = bidi_rx.lock().await;
    loop {
        if lifecycle_closed.load(Ordering::Acquire) {
            return Ok(None);
        }
        tokio::select! {
            value = rx.recv() => return Ok(value.map(|stream| *stream)),
            _ = lifecycle_notify.notified() => {}
        }
    }
}

/// Handle one ordered bidi probe without materializing an N-API stream object.
/// The load/evidence harness calls this only for the two protocol probes that
/// precede its steady-state stream workload.
pub(crate) async fn handle_bidi_probe_for_session(id: &str) -> Result<bool> {
    let Some(stream) = accept_bidi_stream_for_session(id).await? else {
        return Ok(false);
    };
    stream.handle_native_probe().await?;
    Ok(true)
}

pub(crate) async fn create_uni_stream_for_session(id: &str) -> Result<ClientUniSendHandle> {
    let Some((_, _, metrics, _, _, _, create_uni_tx)) = session_registry::get(id) else {
        return Err(napi::Error::from_reason("E_SESSION_CLOSED"));
    };
    let start = std::time::Instant::now();
    let (resp_tx, resp_rx) = tokio::sync::oneshot::channel();
    create_uni_tx
        .send(resp_tx)
        .await
        .map_err(|_| napi::Error::from_reason("E_SESSION_CLOSED"))?;
    let result = resp_rx
        .await
        .map_err(|_| napi::Error::from_reason("E_SESSION_CLOSED"))?
        .map_err(wt_from_upstream_error);
    if result.is_ok() {
        metrics.stream_open_histogram.observe(start.elapsed());
    }
    result
}

pub(crate) async fn accept_uni_stream_for_session(id: &str) -> Result<Option<ClientUniRecvHandle>> {
    let Some((_, uni_rx, lifecycle_closed, lifecycle_notify)) =
        session_registry::get_stream_accept_state(id)
    else {
        return Ok(None);
    };
    if lifecycle_closed.load(Ordering::Acquire) {
        return Ok(None);
    }
    let mut rx = uni_rx.lock().await;
    loop {
        if lifecycle_closed.load(Ordering::Acquire) {
            return Ok(None);
        }
        tokio::select! {
            value = rx.recv() => return Ok(value.map(|stream| *stream)),
            _ = lifecycle_notify.notified() => {}
        }
    }
}

/// Handle one ordered uni probe without crossing the N-API stream-wrapper
/// boundary. The return value is `0` when no stream was accepted, `1` when an
/// incoming probe was handled, and `2` when it also emitted the uni echo.
pub(crate) async fn handle_uni_probe_for_session(id: &str) -> Result<u32> {
    let Some(stream) = accept_uni_stream_for_session(id).await? else {
        return Ok(0);
    };
    let payload = stream.read_native_probe().await?;
    let result = if let Some(payload) = payload {
        if payload.as_ref().starts_with(b"probe:uni-echo:") {
            let send = create_uni_stream_for_session(id).await?;
            send.write_inner(payload.into_vec().into()).await?;
            send.finish_wait_inner().await?;
            let _ = send.dispose();
            2
        } else {
            let _ = stream.stop_sending(0);
            1
        }
    } else {
        let _ = stream.stop_sending(0);
        1
    };
    let _ = stream.dispose();
    Ok(result)
}

pub(crate) async fn wait_session_stream_capacity(
    id: String,
    timeout_ms: u32,
    kind: &'static str,
) -> Result<()> {
    wait_stream_kind_capacity_with_timeout(timeout_ms, kind, || {
        let (_, _, metrics, _, _, _, _) = session_registry::get(&id)?;
        let sm = session_registry::get_session_metrics(&id)?;
        let limits = session_registry::get_limits(&id)?;
        let notify = session_registry::get_stream_capacity_notify(&id)?;
        Some(StreamCapacityView {
            global_active: metrics.streams_active.load(Ordering::Relaxed),
            max_global: limits.max_streams_global,
            bidi_active: sm.streams_bidi_active.load(Ordering::Relaxed),
            uni_active: sm.streams_uni_active.load(Ordering::Relaxed),
            max_bidi: limits.max_streams_per_session_bidi,
            max_uni: limits.max_streams_per_session_uni,
            notify,
        })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session_napi::SessionHandle;
    use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
    use std::sync::Arc;
    use tokio::sync::Notify;

    /// Test double for the session-owned discard state.
    #[derive(Default)]
    struct FakeDiscardSink {
        completed: AtomicU64,
        error: std::sync::Mutex<Option<String>>,
        closed: AtomicBool,
    }

    impl StreamDiscardSink for FakeDiscardSink {
        fn record(&self, result: std::result::Result<(), String>) {
            match result {
                Ok(()) => {
                    self.completed.fetch_add(1, Ordering::AcqRel);
                }
                Err(error) => {
                    let mut slot = self.error.lock().unwrap();
                    if slot.is_none() {
                        *slot = Some(error);
                    }
                }
            }
        }

        fn completed(&self) -> u64 {
            self.completed.load(Ordering::Acquire)
        }

        fn error(&self) -> Option<String> {
            self.error.lock().unwrap().clone()
        }

        fn is_closed(&self) -> bool {
            self.closed.load(Ordering::Acquire)
        }
    }

    struct FakeDiscardStream(std::result::Result<(), String>);

    impl DiscardableStream for FakeDiscardStream {
        fn discard_stream(
            &mut self,
            _scratch: &mut [u8],
        ) -> impl std::future::Future<Output = std::result::Result<(), String>> + Send {
            let result = self.0.clone();
            async move { result }
        }
    }

    fn queued_streams(
        results: Vec<std::result::Result<(), String>>,
    ) -> tokio::sync::mpsc::Receiver<Box<FakeDiscardStream>> {
        let (tx, rx) = tokio::sync::mpsc::channel(results.len().max(1));
        for result in results {
            tx.try_send(Box::new(FakeDiscardStream(result)))
                .expect("queue capacity");
        }
        rx
    }

    #[tokio::test(flavor = "current_thread")]
    async fn queued_discard_preserves_completed_count_when_a_stream_errors() {
        let sink = FakeDiscardSink::default();
        let mut rx = queued_streams(vec![
            Ok(()),
            Ok(()),
            Err("E_SESSION_CLOSED".to_string()),
            Ok(()),
        ]);
        let mut outcome = StreamDiscardOutcome::default();
        let deadline = Some(Instant::now() + Duration::from_millis(500));
        let keep_waiting =
            drain_queued_discard_streams(&mut rx, &sink, deadline, &mut outcome).await;

        assert!(!keep_waiting, "a session-closed race ends the drain");
        assert_eq!(sink.completed(), 2);
        assert_eq!(outcome.errored, 1);
        assert!(!outcome.timed_out);
        assert_eq!(outcome.diagnostic.as_deref(), Some("E_SESSION_CLOSED"));

        outcome.completed = sink.completed();
        assert_eq!(finish_stream_discard("bidi", outcome), Some(2));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn close_race_does_not_mark_the_drain_failed() {
        let outcome = StreamDiscardOutcome {
            completed: 7,
            errored: 1,
            timed_out: false,
            diagnostic: Some("E_SESSION_CLOSED".to_string()),
        };
        assert_eq!(finish_stream_discard("uni", outcome), Some(7));

        // A reset race is non-terminal: it is diagnostic only and must not
        // shrink or replace the delivered count.
        let sink = FakeDiscardSink::default();
        let mut rx = queued_streams(vec![Err("E_STREAM_RESET".to_string()), Ok(()), Ok(())]);
        let mut outcome = StreamDiscardOutcome::default();
        let deadline = Some(Instant::now() + Duration::from_millis(500));
        drain_queued_discard_streams(&mut rx, &sink, deadline, &mut outcome).await;
        assert_eq!(sink.completed(), 2, "drain continues past a reset");
        assert_eq!(outcome.errored, 1);
        assert_eq!(outcome.diagnostic.as_deref(), Some("E_STREAM_RESET"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn queued_drain_keeps_the_first_diagnostic_and_counts_every_error() {
        let sink = FakeDiscardSink::default();
        let mut rx = queued_streams(vec![
            Err("E_STREAM_RESET: first".to_string()),
            Err("E_STREAM_RESET: second".to_string()),
            Ok(()),
        ]);
        let mut outcome = StreamDiscardOutcome::default();
        drain_queued_discard_streams(
            &mut rx,
            &sink,
            Some(Instant::now() + Duration::from_millis(500)),
            &mut outcome,
        )
        .await;

        assert_eq!(outcome.errored, 2, "every failure is counted");
        assert_eq!(
            outcome.diagnostic.as_deref(),
            Some("E_STREAM_RESET: first"),
            "the first error is kept, not the last"
        );
        assert_eq!(outcome.completed, 0, "the wait phase owns the count");
        assert_eq!(sink.completed(), 1);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn queued_drain_without_a_deadline_stops_when_the_queue_goes_idle() {
        let (tx, mut rx) = tokio::sync::mpsc::channel::<Box<FakeDiscardStream>>(1);
        tx.try_send(Box::new(FakeDiscardStream(Ok(())))).unwrap();
        let sink = FakeDiscardSink::default();
        let mut outcome = StreamDiscardOutcome::default();

        let started = std::time::Instant::now();
        let keep_waiting = drain_queued_discard_streams(&mut rx, &sink, None, &mut outcome).await;
        let elapsed = started.elapsed();

        // The sender is still open: the loop must end on the idle window, not
        // on channel close, and must not be treated as a timeout.
        assert!(keep_waiting, "an idle queue hands off to the wait phase");
        assert!(!outcome.timed_out);
        assert_eq!(sink.completed(), 1);
        assert!(
            elapsed >= STREAM_DISCARD_QUEUE_IDLE,
            "idle window must be observed, took {elapsed:?}"
        );
        drop(tx);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn queued_drain_reports_an_expired_deadline_without_touching_the_queue() {
        let sink = FakeDiscardSink::default();
        let mut rx = queued_streams(vec![Ok(())]);
        let mut outcome = StreamDiscardOutcome::default();

        let keep_waiting = drain_queued_discard_streams(
            &mut rx,
            &sink,
            Some(Instant::now() - Duration::from_millis(1)),
            &mut outcome,
        )
        .await;

        assert!(!keep_waiting);
        assert!(outcome.timed_out);
        assert_eq!(sink.completed(), 0, "an expired deadline consumes nothing");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn wait_phase_without_a_deadline_returns_once_the_session_closes() {
        let sink = Arc::new(FakeDiscardSink::default());
        let closer = Arc::clone(&sink);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(20)).await;
            closer.record(Ok(()));
            closer.closed.store(true, Ordering::Release);
        });

        let mut outcome = StreamDiscardOutcome::default();
        wait_for_stream_discard(sink.as_ref(), None, &mut outcome).await;

        assert_eq!(outcome.completed, 1);
        assert!(!outcome.timed_out, "a close is not a deadline expiry");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn unexpected_discard_errors_are_reported_but_never_shrink_the_count() {
        let outcome = StreamDiscardOutcome {
            completed: 4,
            errored: 1,
            timed_out: false,
            diagnostic: Some("E_INTERNAL: poisoned".to_string()),
        };
        assert_eq!(finish_stream_discard("bidi", outcome), Some(4));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn discard_streams_drains_the_queue_then_reports_the_session_count() {
        let sink = FakeDiscardSink::default();
        sink.closed.store(true, Ordering::Release);
        let rx = Arc::new(tokio::sync::Mutex::new(queued_streams(vec![
            Ok(()),
            Ok(()),
        ])));

        let count = discard_streams_for_session(
            "bidi",
            rx,
            sink,
            Some(Instant::now() + Duration::from_millis(500)),
        )
        .await;

        assert_eq!(count, Some(2));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn discard_streams_reports_the_count_when_a_close_race_ends_the_drain() {
        let sink = FakeDiscardSink::default();
        let rx = Arc::new(tokio::sync::Mutex::new(queued_streams(vec![
            Ok(()),
            Err("E_SESSION_CLOSED".to_string()),
            Ok(()),
        ])));

        let started = std::time::Instant::now();
        let count = discard_streams_for_session(
            "uni",
            rx,
            sink,
            Some(Instant::now() + Duration::from_secs(5)),
        )
        .await;

        assert_eq!(count, Some(1), "the close race keeps what was delivered");
        assert!(
            started.elapsed() < Duration::from_secs(4),
            "a terminal error must skip the wait phase"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn discard_streams_is_bounded_by_a_parked_accept_pull() {
        let rx = Arc::new(tokio::sync::Mutex::new(queued_streams(vec![Ok(())])));
        let held = Arc::clone(&rx);
        let guard = held.lock().await;
        let sink = FakeDiscardSink::default();
        sink.record(Ok(()));

        let started = std::time::Instant::now();
        let count = discard_streams_for_session(
            "bidi",
            rx,
            sink,
            Some(Instant::now() + Duration::from_millis(40)),
        )
        .await;
        let elapsed = started.elapsed();

        assert_eq!(
            count,
            Some(1),
            "a held queue still reports what the accept loop consumed"
        );
        assert!(
            elapsed < Duration::from_secs(2),
            "the lock phase must honour the deadline, took {elapsed:?}"
        );
        drop(guard);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn native_helpers_are_null_for_an_unknown_session() {
        assert_eq!(
            discard_bidi_streams_for_session("missing-discard", None)
                .await
                .unwrap(),
            None
        );
        assert_eq!(
            discard_uni_streams_for_session("missing-discard", Some(Duration::from_millis(10)))
                .await
                .unwrap(),
            None
        );
        assert_eq!(
            discard_datagram_for_session("missing-discard", None)
                .await
                .unwrap(),
            None
        );
        assert_eq!(
            discard_datagrams_for_session("missing-discard", None)
                .await
                .unwrap(),
            None
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn wait_phase_reports_completed_count_on_deadline() {
        let sink = FakeDiscardSink::default();
        sink.record(Ok(()));
        sink.record(Err("E_STREAM_RESET".to_string()));
        let mut outcome = StreamDiscardOutcome::default();
        wait_for_stream_discard(
            &sink,
            Some(Instant::now() + Duration::from_millis(60)),
            &mut outcome,
        )
        .await;
        assert_eq!(outcome.completed, 1);
        assert!(outcome.timed_out);
        assert_eq!(outcome.diagnostic.as_deref(), Some("E_STREAM_RESET"));
        assert_eq!(finish_stream_discard("bidi", outcome), Some(1));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn wait_phase_returns_count_when_session_closes() {
        let sink = FakeDiscardSink::default();
        sink.record(Ok(()));
        sink.closed.store(true, Ordering::Release);
        let mut outcome = StreamDiscardOutcome::default();
        wait_for_stream_discard(&sink, None, &mut outcome).await;
        assert_eq!(outcome.completed, 1);
        assert!(!outcome.timed_out);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn discard_deadline_bounds_the_accept_lock_phase() {
        let lock = Arc::new(tokio::sync::Mutex::new(0u8));
        let held = Arc::clone(&lock);
        let guard = held.lock_owned().await;
        let started = std::time::Instant::now();
        let acquired =
            lock_with_deadline(&lock, Some(Instant::now() + Duration::from_millis(40))).await;
        let elapsed = started.elapsed();
        assert!(acquired.is_none(), "held lock must not be acquired");
        assert!(
            elapsed < Duration::from_millis(2000),
            "lock phase must honour the caller deadline, took {:?}",
            elapsed
        );
        drop(guard);
        assert!(lock_with_deadline(&lock, None).await.is_some());
    }

    #[test]
    fn discard_error_classification_separates_terminal_and_expected() {
        assert!(discard_error_is_terminal("E_SESSION_CLOSED"));
        assert!(!discard_error_is_terminal("E_STREAM_RESET"));
        assert!(discard_error_is_expected("E_STREAM_RESET"));
        assert!(!discard_error_is_expected("E_INTERNAL: poisoned"));
    }

    #[test]
    fn empty_discard_still_reports_nothing() {
        assert_eq!(
            finish_stream_discard("bidi", StreamDiscardOutcome::default()),
            None
        );
    }

    #[test]
    fn session_handle_exposes_constructor_identity() {
        let handle = SessionHandle::new("sess-1".into(), "127.0.0.1".into(), 4433);
        assert_eq!(handle.id(), "sess-1");
        assert_eq!(handle.peer_ip(), "127.0.0.1");
        assert_eq!(handle.peer_port(), 4433);
    }

    #[test]
    fn connection_stats_and_close_are_safe_for_unknown_session() {
        let handle = SessionHandle::new("missing-session".into(), "10.0.0.1".into(), 9);
        assert!(handle.connection_stats().unwrap().is_none());
        assert!(handle.close(Some(3990), Some("gone".into())).is_ok());
    }

    #[test]
    fn metrics_snapshot_returns_zeros_for_unknown_session() {
        let handle = SessionHandle::new("missing-metrics".into(), "::1".into(), 1);
        let snap = handle.metrics_snapshot().unwrap();
        assert_eq!(snap.datagrams_in, 0.0);
        assert_eq!(snap.datagrams_out, 0.0);
        assert_eq!(snap.streams_active, 0);
        assert_eq!(snap.queued_bytes, 0.0);
    }

    #[test]
    fn session_metrics_snapshot_from_reads_atomics() {
        let sm = SessionMetrics::default();
        sm.datagrams_in.store(3, Ordering::Relaxed);
        sm.datagrams_out.store(5, Ordering::Relaxed);
        sm.streams_bidi_active.store(2, Ordering::Relaxed);
        sm.streams_uni_active.store(1, Ordering::Relaxed);
        sm.queued_bytes.store(99, Ordering::Relaxed);
        let snap = session_metrics_snapshot_from(Some(&sm));
        assert_eq!(snap.datagrams_in, 3.0);
        assert_eq!(snap.datagrams_out, 5.0);
        assert_eq!(snap.streams_active, 3);
        assert_eq!(snap.queued_bytes, 99.0);
        let empty = session_metrics_snapshot_from(None);
        assert_eq!(empty.streams_active, 0);
    }

    #[test]
    fn stream_kind_has_capacity_respects_global_and_per_kind_caps() {
        let sm = SessionMetrics::default();
        assert!(stream_kind_has_capacity("bidi", 0, 10, &sm, 2, 2));
        assert!(stream_kind_has_capacity("uni", 0, 10, &sm, 2, 2));
        assert!(!stream_kind_has_capacity("other", 0, 10, &sm, 2, 2));

        sm.streams_bidi_active.store(2, Ordering::Relaxed);
        assert!(!stream_kind_has_capacity("bidi", 0, 10, &sm, 2, 2));
        assert!(stream_kind_has_capacity("uni", 0, 10, &sm, 2, 2));

        sm.streams_uni_active.store(2, Ordering::Relaxed);
        assert!(!stream_kind_has_capacity("uni", 0, 10, &sm, 2, 2));

        // Global cap blocks even when per-kind still has room.
        sm.streams_bidi_active.store(0, Ordering::Relaxed);
        sm.streams_uni_active.store(0, Ordering::Relaxed);
        assert!(!stream_kind_has_capacity("bidi", 10, 10, &sm, 2, 2));
        assert!(stream_kind_has_capacity("bidi", 9, 10, &sm, 2, 2));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn wait_capacity_with_timeout_unknown_session_is_closed() {
        let err = wait_session_stream_capacity("no-such-session".into(), 30, "bidi")
            .await
            .unwrap_err();
        assert!(err.reason.contains("E_SESSION_CLOSED"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn wait_capacity_returns_closed_when_snapshot_missing() {
        let err = wait_stream_kind_capacity_with_timeout(50, "bidi", || None)
            .await
            .unwrap_err();
        assert!(err.reason.contains("E_SESSION_CLOSED"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn wait_capacity_succeeds_when_already_under_cap() {
        let notify = Arc::new(Notify::new());
        wait_stream_kind_capacity_with_timeout(50, "bidi", || {
            Some(StreamCapacityView {
                global_active: 0,
                max_global: 10,
                bidi_active: 0,
                uni_active: 0,
                max_bidi: 2,
                max_uni: 2,
                notify: Arc::clone(&notify),
            })
        })
        .await
        .expect("under cap must succeed immediately");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn wait_capacity_times_out_when_cap_never_frees() {
        let notify = Arc::new(Notify::new());
        let err = wait_stream_kind_capacity_with_timeout(20, "uni", || {
            Some(StreamCapacityView {
                global_active: 0,
                max_global: 10,
                bidi_active: 0,
                uni_active: 2,
                max_bidi: 2,
                max_uni: 2,
                notify: Arc::clone(&notify),
            })
        })
        .await
        .unwrap_err();
        assert!(err.reason.contains("E_BACKPRESSURE_TIMEOUT"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn wait_capacity_wakes_when_notify_fires() {
        let notify = Arc::new(Notify::new());
        let polls = Arc::new(AtomicUsize::new(0));
        let polls_c = Arc::clone(&polls);
        let notify_c = Arc::clone(&notify);
        let waiter = tokio::spawn(async move {
            wait_stream_kind_capacity_with_timeout(500, "bidi", || {
                let n = polls_c.fetch_add(1, Ordering::Relaxed);
                Some(StreamCapacityView {
                    global_active: 0,
                    max_global: 10,
                    // first poll blocked, later polls free
                    bidi_active: if n == 0 { 2 } else { 0 },
                    uni_active: 0,
                    max_bidi: 2,
                    max_uni: 2,
                    notify: Arc::clone(&notify_c),
                })
            })
            .await
        });
        // Let waiter enroll on Notify before waking.
        tokio::task::yield_now().await;
        tokio::time::sleep(Duration::from_millis(5)).await;
        notify.notify_waiters();
        waiter
            .await
            .expect("join")
            .expect("notify must unblock capacity wait");
        assert!(polls.load(Ordering::Relaxed) >= 2);
    }

    struct LoopbackSession {
        id: String,
        conn: wtransport::Connection,
        metrics: Arc<crate::server_metrics::ServerMetrics>,
        _endpoint: wtransport::Endpoint<wtransport::endpoint::endpoint_side::Client>,
        _shutdown: crate::server_spawn::ShutdownOnDrop,
    }

    /// Start a loopback server, connect a real client, and return the accepted
    /// server-side session. Callers drive real QUIC streams through it.
    async fn start_loopback_session(server_id: u64) -> LoopbackSession {
        use crate::client::insecure_loopback_client_config;
        use crate::limits::Limits;
        use crate::rate_limit::RateLimits;
        use crate::server_metrics::ServerMetrics;
        use crate::server_spawn::{spawn_server_instance, ShutdownOnDrop};
        use crate::server_tls::build_default_dev_resolver;
        use crate::SessionEvent;

        let metrics = Arc::new(ServerMetrics::default());
        let (session_tx, mut session_rx) = tokio::sync::mpsc::channel(8);
        let (shutdown_tx, port) = spawn_server_instance(
            server_id,
            Arc::clone(&metrics),
            &Limits::default(),
            &RateLimits::default(),
            "127.0.0.1",
            0,
            &Some(session_tx),
            &None,
            build_default_dev_resolver().expect("resolver"),
            crate::client::CongestionControlMode::Default,
            false,
            false,
            false,
            0,
            3,
        )
        .expect("server start");
        let shutdown = ShutdownOnDrop(Some(shutdown_tx));

        let client_cfg = insecure_loopback_client_config().expect("client cfg");
        let endpoint = wtransport::Endpoint::client(client_cfg).expect("client endpoint");
        let conn = endpoint
            .connect(format!("https://127.0.0.1:{port}/"))
            .await
            .expect("connect");
        let event = tokio::time::timeout(Duration::from_secs(5), session_rx.recv())
            .await
            .expect("accept timeout")
            .expect("session event");
        let SessionEvent::Accepted(accepted) = event else {
            panic!("expected an accepted session");
        };
        LoopbackSession {
            id: accepted.id,
            conn,
            metrics,
            _endpoint: endpoint,
            _shutdown: shutdown,
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn loopback_stream_discard_drains_real_streams_and_unblocks_parked_accepts() {
        let session = start_loopback_session(u64::MAX - 32).await;
        let id = session.id.clone();
        let conn = &session.conn;

        for tag in [b"drain-a".as_slice(), b"drain-b".as_slice()] {
            let (mut tx, _rx) = conn.open_bi().await.expect("open bi").await.expect("bi");
            tx.write_all(tag).await.expect("write");
            tx.finish().await.expect("finish");
        }
        assert_eq!(
            discard_bidi_streams_for_session(&id, Some(Duration::from_millis(1000)))
                .await
                .expect("bidi discard"),
            Some(2),
            "both queued bidi streams are consumed without N-API handles"
        );

        for tag in [b"uni-a".as_slice(), b"uni-b".as_slice()] {
            let mut tx = conn.open_uni().await.expect("open uni").await.expect("uni");
            tx.write_all(tag).await.expect("write");
            tx.finish().await.expect("finish");
        }
        assert_eq!(
            discard_uni_streams_for_session(&id, Some(Duration::from_millis(1000)))
                .await
                .expect("uni discard"),
            Some(2),
            "both queued uni streams are consumed without N-API handles"
        );

        // A parked accept must observe the lifecycle close signal, not hang.
        let (_, _, lifecycle_closed, lifecycle_notify) =
            session_registry::get_stream_accept_state(&id).expect("accept state");
        let parked_id = id.clone();
        let parked_bidi =
            tokio::spawn(async move { accept_bidi_stream_for_session(&parked_id).await });
        let parked_id = id.clone();
        let parked_uni =
            tokio::spawn(async move { accept_uni_stream_for_session(&parked_id).await });
        tokio::time::sleep(Duration::from_millis(30)).await;
        lifecycle_closed.store(true, Ordering::Release);
        lifecycle_notify.notify_waiters();
        assert!(tokio::time::timeout(Duration::from_secs(5), parked_bidi)
            .await
            .expect("parked bidi accept must wake")
            .expect("join")
            .expect("accept")
            .is_none());
        assert!(tokio::time::timeout(Duration::from_secs(5), parked_uni)
            .await
            .expect("parked uni accept must wake")
            .expect("join")
            .expect("accept")
            .is_none());

        // Once closed, further accepts return immediately.
        assert!(accept_bidi_stream_for_session(&id).await.unwrap().is_none());
        assert!(accept_uni_stream_for_session(&id).await.unwrap().is_none());

        session_registry::close_session(&id, 0, "done");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn loopback_datagram_discard_and_dead_connection_sends() {
        use crate::limits::Limits;

        let session = start_loopback_session(u64::MAX - 33).await;
        let server_id = u64::MAX - 33;
        let id = session.id.clone();
        let metrics = Arc::clone(&session.metrics);

        let queue_id = format!("{id}-queue");
        let (dgram_tx, _bidi_tx, _uni_tx, _create_bi_rx, _create_uni_rx, sm, dgram_notify) =
            session_registry::insert(
                queue_id.clone(),
                server_id,
                session.conn.clone(),
                Arc::clone(&metrics),
                Limits::default(),
                false,
            );
        let enqueue = |payload: &[u8]| {
            dgram_tx.try_send(session_registry::DatagramSlot::new(
                payload.to_vec(),
                Arc::clone(&sm),
                Arc::clone(&metrics),
                Arc::clone(&dgram_notify),
                0,
            ))
        };

        enqueue(b"single").expect("enqueue single");
        assert_eq!(
            discard_datagram_for_session(&queue_id, Some(Duration::from_millis(500)))
                .await
                .expect("bounded discard"),
            Some(true),
            "a bounded discard reports the datagram it dropped"
        );

        enqueue(b"batch-a").expect("enqueue batch-a");
        enqueue(b"batch-b").expect("enqueue batch-b");
        drop(dgram_tx);
        assert_eq!(
            discard_datagrams_for_session(&queue_id, None)
                .await
                .expect("unbounded batch discard"),
            Some(2),
            "an unbounded drain returns the count when the channel closes"
        );
        assert_eq!(sm.queued_bytes.load(Ordering::Relaxed), 0);
        assert_eq!(
            discard_datagram_for_session(&queue_id, None)
                .await
                .expect("closed single discard"),
            None,
            "a closed queue reports null, not a false drop"
        );
        assert_eq!(
            discard_datagrams_for_session(&queue_id, None)
                .await
                .expect("closed batch discard"),
            None,
            "a closed empty queue reports null, not zero"
        );

        // A session marked closed fails the capacity reservation before the wire.
        let closed_id = format!("{id}-closed");
        session_registry::insert(
            closed_id.clone(),
            server_id,
            session.conn.clone(),
            Arc::clone(&metrics),
            Limits::default(),
            false,
        );
        let (_, _, lifecycle_closed, _) =
            session_registry::get_stream_accept_state(&closed_id).expect("accept state");
        lifecycle_closed.store(true, Ordering::Release);
        let err = send_datagram_for_session(&closed_id, b"x")
            .await
            .unwrap_err();
        assert!(err.reason.contains("E_SESSION_CLOSED"));

        // A dead connection surfaces as a closed session and is never counted.
        let dead_id = format!("{id}-dead");
        let (_, _, _, _, _, dead_sm, _) = session_registry::insert(
            dead_id.clone(),
            server_id,
            session.conn.clone(),
            Arc::clone(&metrics),
            Limits::default(),
            false,
        );
        session.conn.close(wtransport::VarInt::from_u32(0), b"bye");
        let err = send_datagram_for_session(&dead_id, b"x").await.unwrap_err();
        assert!(err.reason.contains("E_SESSION_CLOSED"));
        assert_eq!(
            dead_sm.datagrams_out.load(Ordering::Relaxed),
            0,
            "a failed send is not counted as delivered"
        );
        assert_eq!(
            dead_sm.queued_bytes.load(Ordering::Relaxed),
            0,
            "a failed send still releases its reservation"
        );

        session_registry::remove(&queue_id);
        session_registry::remove(&closed_id);
        session_registry::remove(&dead_id);
        session_registry::remove(&id);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn loopback_covers_datagram_stream_and_stats_paths() {
        use crate::client::insecure_loopback_client_config;
        use crate::limits::Limits;
        use crate::rate_limit::RateLimits;
        use crate::server_metrics::ServerMetrics;
        use crate::server_spawn::{spawn_server_instance, ShutdownOnDrop};
        use crate::server_tls::build_default_dev_resolver;
        use crate::session_registry;
        use crate::SessionEvent;

        let server_id = u64::MAX - 30;
        let metrics = Arc::new(ServerMetrics::default());
        let (session_tx, mut session_rx) = tokio::sync::mpsc::channel(8);

        let (shutdown_tx, port) = spawn_server_instance(
            server_id,
            Arc::clone(&metrics),
            &Limits::default(),
            &RateLimits::default(),
            "127.0.0.1",
            0,
            &Some(session_tx),
            &None,
            build_default_dev_resolver().expect("resolver"),
            crate::client::CongestionControlMode::Default,
            false,
            false,
            false,
            0,
            3,
        )
        .expect("server start");
        assert_ne!(port, 0, "OS must assign a non-zero ephemeral port");
        let _shutdown = ShutdownOnDrop(Some(shutdown_tx));

        let client_cfg = insecure_loopback_client_config().expect("client cfg");
        let endpoint = wtransport::Endpoint::client(client_cfg).expect("client endpoint");
        let url = format!("https://127.0.0.1:{}/", port);
        let client_conn = endpoint.connect(url).await.expect("connect");

        let event = tokio::time::timeout(Duration::from_secs(5), session_rx.recv())
            .await
            .expect("accept timeout")
            .expect("session event");
        let SessionEvent::Accepted(accepted) = event else {
            panic!("expected Accepted, got {event:?}");
        };
        let id = accepted.id.clone();
        let handle = SessionHandle::new(id.clone(), accepted.peer_ip, accepted.peer_port);

        assert!(handle.connection_stats().unwrap().is_some());
        let snap = handle.metrics_snapshot().unwrap();
        assert_eq!(snap.streams_active, 0);

        send_datagram_for_session(&id, b"ping")
            .await
            .expect("send datagram");
        let oversized = vec![0u8; 10_000];
        let queue_err = send_datagram_for_session(&id, &oversized)
            .await
            .unwrap_err();
        assert!(queue_err.reason.contains("E_QUEUE_FULL"));

        wait_session_stream_capacity(id.clone(), 200, "bidi")
            .await
            .expect("bidi capacity");
        wait_session_stream_capacity(id.clone(), 200, "uni")
            .await
            .expect("uni capacity");

        let _bidi = create_bidi_stream_for_session(&id)
            .await
            .expect("create bidi");
        let _uni = create_uni_stream_for_session(&id)
            .await
            .expect("create uni");

        // Missing-session paths for accept/read helpers.
        assert!(read_datagram_for_session("missing-loopback")
            .await
            .unwrap()
            .is_none());
        assert!(accept_bidi_stream_for_session("missing-loopback")
            .await
            .unwrap()
            .is_none());
        assert!(accept_uni_stream_for_session("missing-loopback")
            .await
            .unwrap()
            .is_none());
        let closed = send_datagram_for_session("missing-loopback", b"x")
            .await
            .unwrap_err();
        assert!(closed.reason.contains("E_SESSION_CLOSED"));

        // Client-side registry insert exercises read/create error + datagram dequeue.
        let client_id = format!("{id}-client");
        let mut tight = Limits::default();
        tight.max_queued_bytes_global = 1;
        tight.max_queued_bytes_per_session = 1;
        tight.backpressure_timeout_ms = 1;
        let (
            dgram_tx,
            _bidi_accept_tx,
            _uni_accept_tx,
            create_bi_rx,
            create_uni_rx,
            sm,
            dgram_notify,
        ) = session_registry::insert(
            client_id.clone(),
            server_id,
            client_conn.clone(),
            Arc::clone(&metrics),
            tight,
            false,
        );
        drop(create_bi_rx);
        drop(create_uni_rx);
        assert!(
            create_bidi_stream_for_session(&client_id).await.is_err(),
            "create_bidi without handler must fail"
        );
        assert!(
            create_uni_stream_for_session(&client_id).await.is_err(),
            "create_uni without handler must fail"
        );
        assert!(
            create_bidi_stream_for_session("missing-create")
                .await
                .is_err(),
            "missing session create_bidi must fail"
        );
        assert!(
            create_uni_stream_for_session("missing-create")
                .await
                .is_err(),
            "missing session create_uni must fail"
        );

        // Zero timeout while over capacity hits the deadline branch before sleep.
        let notify = Arc::new(Notify::new());
        let deadline_err = wait_stream_kind_capacity_with_timeout(0, "bidi", || {
            Some(StreamCapacityView {
                global_active: 0,
                max_global: 10,
                bidi_active: 2,
                uni_active: 0,
                max_bidi: 2,
                max_uni: 2,
                notify: Arc::clone(&notify),
            })
        })
        .await
        .unwrap_err();
        assert!(deadline_err.reason.contains("E_BACKPRESSURE_TIMEOUT"));

        let timeout_err = send_datagram_for_session(&client_id, b"ab")
            .await
            .unwrap_err();
        assert!(timeout_err.reason.contains("E_BACKPRESSURE_TIMEOUT"));

        let slot = session_registry::DatagramSlot::new(
            b"queued".to_vec(),
            Arc::clone(&sm),
            Arc::clone(&metrics),
            Arc::clone(&dgram_notify),
            0,
        );
        dgram_tx.send(slot).await.expect("enqueue datagram");
        let got = read_datagram_for_session(&client_id)
            .await
            .expect("read")
            .expect("payload");
        assert_eq!(got, b"queued");

        let discard_slot = session_registry::DatagramSlot::new(
            b"discard".to_vec(),
            Arc::clone(&sm),
            Arc::clone(&metrics),
            Arc::clone(&dgram_notify),
            0,
        );
        dgram_tx
            .send(discard_slot)
            .await
            .expect("enqueue discard datagram");
        assert_eq!(
            discard_datagram_for_session(&client_id, None)
                .await
                .expect("discard")
                .expect("discard result"),
            true
        );
        assert_eq!(sm.queued_bytes.load(Ordering::Relaxed), 0);

        for data in [b"batch-a".to_vec(), b"batch-b".to_vec()] {
            dgram_tx
                .send(session_registry::DatagramSlot::new(
                    data,
                    Arc::clone(&sm),
                    Arc::clone(&metrics),
                    Arc::clone(&dgram_notify),
                    0,
                ))
                .await
                .expect("enqueue batch datagram");
        }
        assert_eq!(
            discard_datagrams_for_session(&client_id, Some(Duration::from_millis(1)))
                .await
                .expect("batch discard")
                .expect("batch discard result"),
            2
        );
        assert_eq!(sm.queued_bytes.load(Ordering::Relaxed), 0);

        assert_eq!(
            discard_datagram_for_session(&client_id, Some(Duration::from_millis(1)))
                .await
                .expect("bounded discard"),
            Some(false)
        );

        // Closed-session path for reserve: mark closed then attempt send.
        session_registry::abort_session(&client_id, 0, b"closed");
        // Re-insert for read/accept closed-channel paths.
        let loose = Limits::default();
        let (
            dgram_tx,
            bidi_accept_tx,
            uni_accept_tx,
            create_bi_rx,
            create_uni_rx,
            _sm2,
            _dgram_notify2,
        ) = session_registry::insert(
            client_id.clone(),
            server_id,
            client_conn.clone(),
            Arc::clone(&metrics),
            loose,
            false,
        );
        drop(create_bi_rx);
        drop(create_uni_rx);
        drop(bidi_accept_tx);
        drop(uni_accept_tx);
        assert!(accept_bidi_stream_for_session(&client_id)
            .await
            .unwrap()
            .is_none());
        assert!(accept_uni_stream_for_session(&client_id)
            .await
            .unwrap()
            .is_none());
        drop(dgram_tx);
        assert!(read_datagram_for_session(&client_id)
            .await
            .unwrap()
            .is_none());

        handle.close(Some(0), Some("done".into())).unwrap();
        drop(_shutdown);
        drop(client_conn);
        session_registry::remove(&client_id);
    }

    /// A read parked on an empty datagram queue must observe the sticky close
    /// flag, not sit there until the ingress task happens to drop its sender.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn close_while_parked_wakes_the_legacy_datagram_read() {
        use crate::limits::Limits;

        let session = start_loopback_session(u64::MAX - 40).await;
        let id = format!("{}-legacy-parked", session.id);
        // Holding the sender for the whole test is the point: the read must
        // wake from the lifecycle signal alone.
        let (_dgram_tx, _b, _u, _cb, _cu, _sm, _notify) = session_registry::insert(
            id.clone(),
            u64::MAX - 40,
            session.conn.clone(),
            Arc::clone(&session.metrics),
            Limits::default(),
            false,
        );

        let parked_id = id.clone();
        let parked = tokio::spawn(async move { read_datagram_for_session(&parked_id).await });
        tokio::time::sleep(Duration::from_millis(50)).await;
        session_registry::remove(&id);

        let got = tokio::time::timeout(Duration::from_secs(1), parked)
            .await
            .expect("parked legacy read must wake within 1s of session close")
            .expect("join")
            .expect("read");
        assert!(got.is_none(), "a closed session reads as EOF");

        session_registry::close_session(&session.id, 0, "done");
    }

    /// A datagram queue plus the lifecycle signals a reader parks on, without
    /// a live QUIC session behind it.
    #[derive(Clone)]
    struct TestDatagramQueue {
        tx: tokio::sync::mpsc::Sender<session_registry::DatagramSlot>,
        rx: Arc<tokio::sync::Mutex<tokio::sync::mpsc::Receiver<session_registry::DatagramSlot>>>,
        closed: Arc<AtomicBool>,
        lifecycle_notify: Arc<Notify>,
        capacity_notify: Arc<Notify>,
        metrics: Arc<crate::server_metrics::ServerMetrics>,
        session_metrics: Arc<SessionMetrics>,
    }

    impl TestDatagramQueue {
        fn new(capacity: usize) -> Self {
            let (tx, rx) = tokio::sync::mpsc::channel(capacity);
            Self {
                tx,
                rx: Arc::new(tokio::sync::Mutex::new(rx)),
                closed: Arc::new(AtomicBool::new(false)),
                lifecycle_notify: Arc::new(Notify::new()),
                capacity_notify: Arc::new(Notify::new()),
                metrics: Arc::new(crate::server_metrics::ServerMetrics::default()),
                session_metrics: Arc::new(SessionMetrics::default()),
            }
        }

        fn slot(&self, data: Vec<u8>, reserved: u64) -> session_registry::DatagramSlot {
            session_registry::DatagramSlot::new(
                data,
                Arc::clone(&self.session_metrics),
                Arc::clone(&self.metrics),
                Arc::clone(&self.capacity_notify),
                reserved,
            )
        }

        fn queue(&self, data: &[u8]) {
            assert!(
                self.tx.try_send(self.slot(data.to_vec(), 0)).is_ok(),
                "test queue must accept the datagram"
            );
        }

        async fn read(&self, max: u32) -> Option<Vec<Vec<u8>>> {
            read_datagram_batch_from_state(&self.rx, &self.closed, &self.lifecycle_notify, max)
                .await
        }
    }

    #[test]
    fn batch_max_is_clamped_into_range() {
        assert_eq!(clamp_batch_max(0), 1);
        assert_eq!(clamp_batch_max(1), 1);
        assert_eq!(clamp_batch_max(64), 64);
        assert_eq!(clamp_batch_max(256), 256);
        assert_eq!(clamp_batch_max(257), 256);
        assert_eq!(clamp_batch_max(u32::MAX), 256);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn batch_read_blocks_for_the_first_item_then_drains_the_queue_in_order() {
        let queue = TestDatagramQueue::new(8);
        let parked = queue.clone();
        let task = tokio::spawn(async move { parked.read(8).await });
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(
            !task.is_finished(),
            "an empty queue must park the batch read"
        );

        for tag in [b"a".as_slice(), b"b".as_slice(), b"c".as_slice()] {
            queue.queue(tag);
        }
        let batch = tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .expect("the batch read must wake on the first item")
            .expect("join")
            .expect("a queued batch is never null");
        assert_eq!(
            batch,
            vec![b"a".to_vec(), b"b".to_vec(), b"c".to_vec()],
            "the drain preserves arrival order"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn batch_read_stops_at_the_clamped_cap_and_leaves_the_rest_queued() {
        let queue = TestDatagramQueue::new(16);
        for i in 0..10u8 {
            queue.queue(&[i]);
        }

        let first = queue.read(4).await.expect("a queued batch is never null");
        assert_eq!(first, (0..4u8).map(|i| vec![i]).collect::<Vec<_>>());
        let rest = queue.read(64).await.expect("a queued batch is never null");
        assert_eq!(rest, (4..10u8).map(|i| vec![i]).collect::<Vec<_>>());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn batch_read_delivers_a_partial_batch_before_reporting_eof() {
        let queue = TestDatagramQueue::new(8);
        queue.queue(b"x");
        queue.queue(b"y");

        let TestDatagramQueue {
            tx,
            rx,
            closed,
            lifecycle_notify,
            ..
        } = queue;
        drop(tx);

        let batch = read_datagram_batch_from_state(&rx, &closed, &lifecycle_notify, 8)
            .await
            .expect("the queued remainder is delivered before EOF");
        assert_eq!(batch, vec![b"x".to_vec(), b"y".to_vec()]);
        assert!(
            read_datagram_batch_from_state(&rx, &closed, &lifecycle_notify, 8)
                .await
                .is_none(),
            "EOF with no items is null, never an empty array"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn batch_read_is_null_for_a_missing_session() {
        assert!(read_datagram_batch_for_session("missing-batch", 8)
            .await
            .unwrap()
            .is_none());
        assert!(read_datagram_batch_for_session("missing-batch", 0)
            .await
            .unwrap()
            .is_none());
    }

    // A batch handed to JavaScript is memory that the queue no longer accounts
    // for: its reservations are released the moment the slots are taken. Pin
    // the resulting in-flight bound at one channel plus one batch.
    #[tokio::test(flavor = "current_thread")]
    async fn a_held_batch_bounds_in_flight_datagrams_to_one_channel_plus_one_batch() {
        const PAYLOAD: u64 = 1000;
        const GLOBAL_MAX: u64 = 1 << 24;
        const SESSION_MAX: u64 = 1 << 24;

        let capacity = session_registry::DGRAM_CHANNEL_CAPACITY;
        assert_eq!(capacity, 2048, "the in-flight bound is stated against 2048");
        let queue = TestDatagramQueue::new(capacity);
        let reserve = || {
            assert!(queue.metrics.try_reserve_queued_bytes_with_session(
                &queue.session_metrics.queued_bytes,
                PAYLOAD,
                GLOBAL_MAX,
                SESSION_MAX,
            ));
        };
        let full_slot = || queue.slot(vec![0u8; PAYLOAD as usize], PAYLOAD);

        for _ in 0..capacity {
            reserve();
            assert!(queue.tx.try_send(full_slot()).is_ok());
        }
        reserve();
        assert!(
            queue.tx.try_send(full_slot()).is_err(),
            "the channel is full at capacity"
        );

        let batch = queue.read(512).await.expect("a full queue yields a batch");
        assert_eq!(batch.len(), 256, "512 clamps to the 256-item cap");
        for _ in 0..batch.len() {
            reserve();
            assert!(queue.tx.try_send(full_slot()).is_ok());
        }
        reserve();
        assert!(
            queue.tx.try_send(full_slot()).is_err(),
            "the refilled channel is full again"
        );

        assert_eq!(
            capacity + batch.len(),
            2048 + 256,
            "at most one channel plus one held batch is in flight"
        );
        assert_eq!(
            queue.session_metrics.queued_bytes.load(Ordering::Relaxed),
            capacity as u64 * PAYLOAD,
            "reservations cover only the refilled native queue, not the held batch"
        );
    }

    /// The batch read must park on the lifecycle signal for the same reason the
    /// legacy read does: nothing else wakes it when the session goes away.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn close_while_parked_wakes_the_batch_datagram_read() {
        use crate::limits::Limits;

        let session = start_loopback_session(u64::MAX - 41).await;
        let id = format!("{}-batch-parked", session.id);
        let (_dgram_tx, _b, _u, _cb, _cu, _sm, _notify) = session_registry::insert(
            id.clone(),
            u64::MAX - 41,
            session.conn.clone(),
            Arc::clone(&session.metrics),
            Limits::default(),
            false,
        );

        let parked_id = id.clone();
        let parked =
            tokio::spawn(async move { read_datagram_batch_for_session(&parked_id, 32).await });
        tokio::time::sleep(Duration::from_millis(50)).await;
        session_registry::remove(&id);

        let got = tokio::time::timeout(Duration::from_secs(1), parked)
            .await
            .expect("parked batch read must wake within 1s of session close")
            .expect("join")
            .expect("read");
        assert!(got.is_none(), "a closed session reads as EOF");

        session_registry::close_session(&session.id, 0, "done");
    }

    /// Documented semantic deviation: a closed session discards whatever is
    /// still queued instead of draining it first. Both read lanes must agree.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_closed_session_drops_queued_datagrams_instead_of_draining_them() {
        use crate::limits::Limits;

        let session = start_loopback_session(u64::MAX - 42).await;

        let legacy_id = format!("{}-legacy-drop", session.id);
        let (legacy_tx, .., legacy_sm, legacy_notify) = session_registry::insert(
            legacy_id.clone(),
            u64::MAX - 42,
            session.conn.clone(),
            Arc::clone(&session.metrics),
            Limits::default(),
            false,
        );
        let (legacy_rx, legacy_closed, _) =
            session_registry::get_datagram_read_state(&legacy_id).expect("read state");
        for i in 0..3u8 {
            assert!(legacy_tx
                .try_send(session_registry::DatagramSlot::new(
                    vec![i],
                    Arc::clone(&legacy_sm),
                    Arc::clone(&session.metrics),
                    Arc::clone(&legacy_notify),
                    0,
                ))
                .is_ok());
        }
        // The registry entry is still present: this is the window in which a
        // reader finds the state after the close signal is already stored.
        legacy_closed.store(true, Ordering::Release);
        let got = tokio::time::timeout(
            Duration::from_secs(1),
            read_datagram_for_session(&legacy_id),
        )
        .await
        .expect("a closed session must not park the legacy read")
        .expect("read");
        assert!(
            got.is_none(),
            "the legacy read reports EOF instead of draining the remainder"
        );
        let mut remaining = 0;
        while legacy_rx.lock().await.try_recv().is_ok() {
            remaining += 1;
        }
        assert_eq!(
            remaining, 3,
            "every queued datagram was dropped, not delivered"
        );

        let batch_id = format!("{}-batch-drop", session.id);
        let (batch_tx, .., batch_sm, batch_notify) = session_registry::insert(
            batch_id.clone(),
            u64::MAX - 42,
            session.conn.clone(),
            Arc::clone(&session.metrics),
            Limits::default(),
            false,
        );
        let (batch_rx, batch_closed, _) =
            session_registry::get_datagram_read_state(&batch_id).expect("read state");
        for i in 0..3u8 {
            assert!(batch_tx
                .try_send(session_registry::DatagramSlot::new(
                    vec![i],
                    Arc::clone(&batch_sm),
                    Arc::clone(&session.metrics),
                    Arc::clone(&batch_notify),
                    0,
                ))
                .is_ok());
        }
        batch_closed.store(true, Ordering::Release);
        let got = tokio::time::timeout(
            Duration::from_secs(1),
            read_datagram_batch_for_session(&batch_id, 8),
        )
        .await
        .expect("a closed session must not park the batch read")
        .expect("read");
        assert!(
            got.is_none(),
            "the batch read reports EOF instead of draining the remainder"
        );
        let mut remaining = 0;
        while batch_rx.lock().await.try_recv().is_ok() {
            remaining += 1;
        }
        assert_eq!(
            remaining, 3,
            "every queued datagram was dropped, not delivered"
        );

        session_registry::remove(&legacy_id);
        session_registry::remove(&batch_id);
        session_registry::close_session(&session.id, 0, "done");
    }
}
