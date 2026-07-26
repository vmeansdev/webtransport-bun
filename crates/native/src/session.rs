use napi::bindgen_prelude::Buffer;
use napi::{Env, JsObject, Result};
use napi_derive::napi;
use std::sync::atomic::Ordering;

use crate::error::{
    from_reason as wt_from_reason, from_upstream_error as wt_from_upstream_error, WtResult,
};
use crate::panic_guard;
use crate::session_registry;
use crate::RUNTIME;
use tokio::time::{Duration, Instant};

#[napi]
pub struct SessionHandle {
    id: String,
    peer_ip: String,
    peer_port: u32,
}

#[napi]
impl SessionHandle {
    async fn wait_capacity_with_timeout(
        id: String,
        timeout_ms: u32,
        kind: &'static str,
    ) -> Result<()> {
        let deadline = Instant::now() + Duration::from_millis(timeout_ms as u64);
        loop {
            let Some((_, _, metrics, _, _, _, _)) = session_registry::get(&id) else {
                return Err(napi::Error::from_reason("E_SESSION_CLOSED"));
            };
            let Some(sm) = session_registry::get_session_metrics(&id) else {
                return Err(napi::Error::from_reason("E_SESSION_CLOSED"));
            };
            let Some(limits) = session_registry::get_limits(&id) else {
                return Err(napi::Error::from_reason("E_SESSION_CLOSED"));
            };
            let Some(notify) = session_registry::get_stream_capacity_notify(&id) else {
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
            let notified = notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();

            let global_ok =
                metrics.streams_active.load(Ordering::Relaxed) < limits.max_streams_global;
            let kind_ok = match kind {
                "bidi" => {
                    sm.streams_bidi_active.load(Ordering::Relaxed)
                        < limits.max_streams_per_session_bidi
                }
                "uni" => {
                    sm.streams_uni_active.load(Ordering::Relaxed)
                        < limits.max_streams_per_session_uni
                }
                _ => false,
            };
            if global_ok && kind_ok {
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

    #[napi(constructor)]
    pub fn new(id: String, peer_ip: String, peer_port: u32) -> Self {
        Self {
            id,
            peer_ip,
            peer_port,
        }
    }

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

    /// Real QUIC transport stats (rtt, wire bytes, packet counts) for this session.
    #[napi]
    pub fn connection_stats(&self) -> WtResult<Option<crate::metrics::QuicConnectionStats>> {
        let Some((conn, _, _, _, _, _, _)) = session_registry::get(&self.id) else {
            return Ok(None);
        };
        Ok(Some(crate::metrics::quic_stats_from_conn(&conn)))
    }

    #[napi]
    pub fn close(&self, code: Option<u32>, reason: Option<String>) -> WtResult<()> {
        let c = code.unwrap_or(0);
        let r = reason.unwrap_or_default();
        session_registry::close_session(&self.id, c, r.as_bytes());
        Ok(())
    }

    /// Spawn on the addon runtime without holding an exclusive napi borrow of
    /// `self` across `.await` (Bun rejects concurrent `async fn &self` calls).
    #[napi(ts_return_type = "Promise<void>")]
    pub fn send_datagram(&self, env: Env, data: Buffer) -> Result<JsObject> {
        let id = self.id.clone();
        let bytes = data.as_ref().to_vec();
        env.spawn_future(async move {
            RUNTIME
                .spawn(async move {
                    let Some((
                        conn,
                        metrics,
                        sm,
                        limits,
                        datagram_capacity_notify,
                        lifecycle_closed,
                    )) = session_registry::get_datagram_send_state(&id)
                    else {
                        return Err(napi::Error::from_reason("E_SESSION_CLOSED"));
                    };
                    let sz = bytes.len();
                    if sz > limits.max_datagram_size {
                        return Err(napi::Error::from_reason("E_QUEUE_FULL"));
                    }
                    let sz_u64 = sz as u64;
                    let deadline =
                        Instant::now() + Duration::from_millis(limits.backpressure_timeout_ms);
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
                        .send_datagram(&bytes)
                        .map_err(|_| napi::Error::from_reason("E_SESSION_CLOSED"));
                    metrics.release_datagram_capacity(
                        &sm.queued_bytes,
                        &datagram_capacity_notify,
                        sz_u64,
                    );
                    result?;
                    metrics.datagram_enqueue_histogram.observe(start.elapsed());
                    metrics.datagrams_out.fetch_add(1, Ordering::Relaxed);
                    sm.datagrams_out.fetch_add(1, Ordering::Relaxed);
                    Ok(())
                })
                .await
                .map_err(wt_from_upstream_error)?
        })
    }

    #[napi(ts_return_type = "Promise<Buffer | null>")]
    pub fn read_datagram(&self, env: Env) -> Result<JsObject> {
        let id = self.id.clone();
        env.spawn_future(async move {
            RUNTIME
                .spawn(async move {
                    let Some((_, dgram_rx, _, _, _, _, _)) = session_registry::get(&id) else {
                        return Ok(None);
                    };
                    let mut rx = dgram_rx.lock().await;
                    match rx.recv().await {
                        Some(slot) => Ok(Some(Buffer::from(slot.take()))),
                        None => Ok(None),
                    }
                })
                .await
                .map_err(wt_from_upstream_error)?
        })
    }

    #[napi(ts_return_type = "Promise<ClientBidiStreamHandle>")]
    pub fn create_bidi_stream(&self, env: Env) -> Result<JsObject> {
        let id = self.id.clone();
        env.spawn_future(async move {
            RUNTIME
                .spawn(async move {
                    let Some((_, _, metrics, _, _, create_bi_tx, _)) = session_registry::get(&id)
                    else {
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
                })
                .await
                .map_err(wt_from_upstream_error)?
        })
    }

    #[napi(ts_return_type = "Promise<void>")]
    pub fn wait_bidi_capacity(&self, env: Env, timeout_ms: u32) -> Result<JsObject> {
        let id = self.id.clone();
        env.spawn_future(async move {
            RUNTIME
                .spawn(
                    async move { Self::wait_capacity_with_timeout(id, timeout_ms, "bidi").await },
                )
                .await
                .map_err(wt_from_upstream_error)?
        })
    }

    #[napi(ts_return_type = "Promise<ClientBidiStreamHandle | null>")]
    pub fn accept_bidi_stream(&self, env: Env) -> Result<JsObject> {
        let id = self.id.clone();
        env.spawn_future(async move {
            RUNTIME
                .spawn(async move {
                    let Some((_, _, _, bidi_rx, _, _, _)) = session_registry::get(&id) else {
                        return Ok(None);
                    };
                    let mut rx = bidi_rx.lock().await;
                    Ok(rx.recv().await)
                })
                .await
                .map_err(wt_from_upstream_error)?
        })
    }

    #[napi(ts_return_type = "Promise<ClientUniSendHandle>")]
    pub fn create_uni_stream(&self, env: Env) -> Result<JsObject> {
        let id = self.id.clone();
        env.spawn_future(async move {
            RUNTIME
                .spawn(async move {
                    let Some((_, _, metrics, _, _, _, create_uni_tx)) = session_registry::get(&id)
                    else {
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
                })
                .await
                .map_err(wt_from_upstream_error)?
        })
    }

    #[napi(ts_return_type = "Promise<void>")]
    pub fn wait_uni_capacity(&self, env: Env, timeout_ms: u32) -> Result<JsObject> {
        let id = self.id.clone();
        env.spawn_future(async move {
            RUNTIME
                .spawn(async move { Self::wait_capacity_with_timeout(id, timeout_ms, "uni").await })
                .await
                .map_err(wt_from_upstream_error)?
        })
    }

    #[napi(ts_return_type = "Promise<ClientUniRecvHandle | null>")]
    pub fn accept_uni_stream(&self, env: Env) -> Result<JsObject> {
        let id = self.id.clone();
        env.spawn_future(async move {
            RUNTIME
                .spawn(async move {
                    let Some((_, _, _, _, uni_rx, _, _)) = session_registry::get(&id) else {
                        return Ok(None);
                    };
                    let mut rx = uni_rx.lock().await;
                    Ok(rx.recv().await)
                })
                .await
                .map_err(wt_from_upstream_error)?
        })
    }

    #[napi]
    pub fn metrics_snapshot(&self) -> WtResult<crate::metrics::SessionMetricsSnapshot> {
        panic_guard::catch_panic(|| {
            if let Some(sm) = session_registry::get_session_metrics(&self.id) {
                Ok(crate::metrics::SessionMetricsSnapshot {
                    datagrams_in: sm.datagrams_in.load(Ordering::Relaxed) as f64,
                    datagrams_out: sm.datagrams_out.load(Ordering::Relaxed) as f64,
                    streams_active: sm.streams_active() as u32,
                    queued_bytes: sm.queued_bytes.load(Ordering::Relaxed) as f64,
                })
            } else {
                Ok(crate::metrics::SessionMetricsSnapshot {
                    datagrams_in: 0.0,
                    datagrams_out: 0.0,
                    streams_active: 0,
                    queued_bytes: 0.0,
                })
            }
        })
        .map_err(wt_from_reason)
    }
}
