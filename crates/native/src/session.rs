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

pub(crate) async fn read_datagram_for_session(id: &str) -> Result<Option<Vec<u8>>> {
    let Some((_, dgram_rx, _, _, _, _, _)) = session_registry::get(id) else {
        return Ok(None);
    };
    let mut rx = dgram_rx.lock().await;
    match rx.recv().await {
        Some(slot) => Ok(Some(slot.take())),
        None => Ok(None),
    }
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

/// Wait for native direct-consume state until the session closes or the
/// bounded deadline expires.
async fn wait_for_stream_discard(
    state: session_registry::StreamDiscardState,
    timeout: Option<Duration>,
) -> Result<Option<u64>> {
    let deadline = timeout.map(|limit| tokio::time::Instant::now() + limit);
    loop {
        if let Some(error) = state.error() {
            return Err(napi::Error::from_reason(error));
        }
        let completed = state.completed();
        if state.is_closed() {
            return Ok(if completed == 0 {
                None
            } else {
                Some(completed)
            });
        }
        match deadline {
            Some(deadline) => {
                let now = tokio::time::Instant::now();
                if now >= deadline {
                    return Ok(Some(completed));
                }
                let poll = (deadline - now).min(Duration::from_millis(50));
                tokio::time::sleep(poll).await;
            }
            None => tokio::time::sleep(Duration::from_millis(50)).await,
        }
    }
}

/// Consume accepted bidi streams without materializing N-API stream handles.
/// Native direct mode drains future streams in the QUIC accept loop; only
/// handles already queued at the mode switch cross this function.
pub(crate) async fn discard_bidi_streams_for_session(
    id: &str,
    timeout: Option<Duration>,
) -> Result<Option<u64>> {
    let Some(state) = session_registry::enable_bidi_discard(id) else {
        return Ok(None);
    };
    let Some((bidi_rx, _, _, _)) = session_registry::get_stream_accept_state(id) else {
        return Ok(None);
    };
    let mut rx = bidi_rx.lock().await;
    let mut scratch = None;
    loop {
        let next = tokio::time::timeout(Duration::from_millis(100), rx.recv()).await;
        let Some(mut stream) = (match next {
            Ok(value) => value,
            Err(_) => break,
        }) else {
            break;
        };
        let scratch = scratch
            .get_or_insert_with(|| vec![0u8; crate::client_stream::STREAM_READ_BUFFER_BYTES]);
        let result = stream.discard_incoming(scratch).await;
        state.record(result.clone());
        if let Err(error) = result {
            return Err(napi::Error::from_reason(error));
        }
    }
    drop(rx);
    // The accept queue is empty after the mode-switch window. Do not retain a
    // per-session scratch allocation while waiting for native direct streams.
    drop(scratch);
    wait_for_stream_discard(state, timeout).await
}

/// Consume accepted uni streams without crossing the N-API wrapper boundary.
pub(crate) async fn discard_uni_streams_for_session(
    id: &str,
    timeout: Option<Duration>,
) -> Result<Option<u64>> {
    let Some(state) = session_registry::enable_uni_discard(id) else {
        return Ok(None);
    };
    let Some((_, uni_rx, _, _)) = session_registry::get_stream_accept_state(id) else {
        return Ok(None);
    };
    let mut rx = uni_rx.lock().await;
    let mut scratch = None;
    loop {
        let next = tokio::time::timeout(Duration::from_millis(100), rx.recv()).await;
        let Some(mut stream) = (match next {
            Ok(value) => value,
            Err(_) => break,
        }) else {
            break;
        };
        let scratch = scratch
            .get_or_insert_with(|| vec![0u8; crate::client_stream::STREAM_READ_BUFFER_BYTES]);
        let result = stream.discard_incoming(scratch).await;
        state.record(result.clone());
        if let Err(error) = result {
            return Err(napi::Error::from_reason(error));
        }
    }
    drop(rx);
    // The accept queue is empty after the mode-switch window. Do not retain a
    // per-session scratch allocation while waiting for native direct streams.
    drop(scratch);
    wait_for_stream_discard(state, timeout).await
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
            send.write(payload).await?;
            send.finish_wait().await?;
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
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use tokio::sync::Notify;

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
}
