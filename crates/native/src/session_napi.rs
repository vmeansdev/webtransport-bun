//! NAPI bindings for SessionHandle. Risk-module coverage floors target `session.rs` logic.
use napi::bindgen_prelude::{Buffer, Uint8Array};
use napi::{Env, JsObject, Result};
use napi_derive::napi;

use crate::async_ops::{AsyncOpGuard, AsyncOpKind};
use crate::error::{
    from_reason as wt_from_reason, from_upstream_error as wt_from_upstream_error, WtResult,
};
use crate::panic_guard;
use crate::session::{
    accept_bidi_stream_for_session, accept_uni_stream_for_session, create_bidi_stream_for_session,
    create_uni_stream_for_session, discard_bidi_streams_for_session, discard_datagram_for_session,
    discard_datagrams_for_session, discard_uni_streams_for_session, handle_bidi_probe_for_session,
    handle_uni_probe_for_session, read_datagram_batch_for_session, read_datagram_for_session,
    send_datagram_batch_for_session, send_datagram_for_session, session_metrics_snapshot_from,
    wait_session_stream_capacity,
};
use crate::session_registry;
use crate::RUNTIME;

#[napi]
pub struct SessionHandle {
    id: std::sync::Arc<str>,
    peer_ip: String,
    peer_port: u32,
    /// This session's owner counter block, resolved once at construction.
    ops: std::sync::Arc<crate::async_ops::OwnerAsyncOps>,
}

#[napi]
impl SessionHandle {
    #[napi(constructor)]
    pub fn new(id: String, peer_ip: String, peer_port: u32) -> Self {
        let ops = match session_registry::owner_of(&id) {
            Some(owner) => crate::async_ops::owner_ops(owner),
            None => crate::async_ops::orphan_ops(),
        };
        Self {
            id: id.into(),
            peer_ip,
            peer_port,
            ops,
        }
    }

    /// Spawn an N-API future that counts itself against this session's owner
    /// for as long as it is unsettled. Every async method on this handle goes
    /// through here: an operation invisible to the counters is an operation
    /// that can pin the event loop past `server.close()` with no evidence.
    fn spawn_counted<T, F>(&self, env: Env, kind: AsyncOpKind, fut: F) -> Result<JsObject>
    where
        T: 'static + Send + napi::bindgen_prelude::ToNapiValue,
        F: 'static + Send + std::future::Future<Output = Result<T>>,
    {
        let guard = AsyncOpGuard::new(&self.ops, kind);
        env.spawn_future(async move {
            let _guard = guard;
            fut.await
        })
    }

    #[napi(getter)]
    pub fn id(&self) -> String {
        self.id.to_string()
    }

    #[napi(getter)]
    pub fn peer_ip(&self) -> String {
        self.peer_ip.clone()
    }

    #[napi(getter)]
    pub fn peer_port(&self) -> u32 {
        self.peer_port
    }

    /// Whether this session's CONNECT arrived as replayable 0-RTT early data.
    /// False for closed/unknown sessions and whenever the server did not
    /// enable 0-RTT.
    #[napi(getter, js_name = "has0Rtt")]
    pub fn has_0rtt(&self) -> bool {
        session_registry::zero_rtt_state(&self.id).is_some_and(|(is_0rtt, _)| is_0rtt)
    }

    /// Whether this process accepted the client's early data. On the server
    /// this equals has0Rtt: a request that was readable from early data was
    /// by definition accepted; a refused flight is retried by the client as
    /// 1-RTT and arrives with has0Rtt=false.
    #[napi(getter, js_name = "accepted0Rtt")]
    pub fn accepted_0rtt(&self) -> bool {
        self.has_0rtt()
    }

    /// Whether the TLS handshake has completed for this session. Always true
    /// for non-0-RTT sessions; for 0-RTT sessions it flips once the client is
    /// authenticated and the session request is no longer replayable.
    #[napi(getter, js_name = "handshakeConfirmed")]
    pub fn handshake_confirmed(&self) -> bool {
        session_registry::zero_rtt_state(&self.id)
            .is_some_and(|(_, confirmed)| confirmed.load(std::sync::atomic::Ordering::Acquire))
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
        session_registry::close_session(&self.id, c, &r);
        Ok(())
    }

    /// Tell the peer this session is going away soon, without ending it.
    ///
    /// Sends a `WT_DRAIN_SESSION` capsule. Streams already open keep working and
    /// new ones can still be opened; this only asks the peer to start winding
    /// down. Returns immediately — the capsule goes out in the background.
    #[napi]
    pub fn drain(&self) -> WtResult<()> {
        session_registry::drain_session(&self.id);
        Ok(())
    }

    /// Tell the peer not to open any further session on this connection.
    ///
    /// Sends an H3 `GOAWAY`. `GOAWAY` is connection-scoped: it asks the peer to
    /// stop starting new WebTransport sessions on this connection, a
    /// server-initiated graceful-shutdown signal. The current session keeps
    /// working — new refusals are not exercisable here because native is
    /// single-session-per-connection. Returns immediately; the frame goes out in
    /// the background. The peer observes it as its `draining` settling.
    #[napi(js_name = "goAway")]
    pub fn go_away(&self) -> WtResult<()> {
        session_registry::send_goaway(&self.id);
        Ok(())
    }

    /// Resolves once the peer says this session is going away.
    ///
    /// Settles on a received `WT_DRAIN_SESSION` or `GOAWAY`, and immediately if
    /// one already arrived. The session stays usable: this is a warning, not an
    /// ending. A session that is gone resolves too, so no caller is left waiting
    /// on a peer that can no longer speak.
    #[napi(ts_return_type = "Promise<void>")]
    pub fn wait_draining(&self, env: Env) -> Result<JsObject> {
        let id = self.id.clone();
        self.spawn_counted(env, AsyncOpKind::Lifecycle, async move {
            let Some((conn, ..)) = session_registry::get(&id) else {
                return Ok(());
            };
            RUNTIME
                .spawn(async move {
                    // A peer that never drains and then goes away must not
                    // leave this promise unsettled: an unsettled N-API promise
                    // keeps the host event loop referenced for the life of the
                    // process. The connection ending is an answer too.
                    tokio::select! {
                        _ = conn.draining() => {}
                        _ = conn.closed() => {}
                    }
                })
                .await
                .map_err(wt_from_upstream_error)?;
            Ok(())
        })
    }

    /// Send one datagram without creating an N-API promise.
    ///
    /// Every async N-API method is backed by a ThreadsafeFunction, and a live
    /// TSFN is a reference on the *host* event loop — one per datagram on the
    /// old send path, released by the host after the Rust future is already
    /// gone. That release is outside anything this addon can observe: the
    /// async-op counters, the task gauges and the session registry all read
    /// clean while the loop stays referenced. The only reliable answer is not
    /// to take the reference: quinn's send is synchronous, so a send with
    /// budget needs no promise at all.
    ///
    /// Resolves `null` when the datagram was queued, `"E_WOULD_BLOCK"` when the
    /// caller should retry on {@link SessionHandle::send_datagram} (the only
    /// path allowed to wait), or an error code. Never throws.
    #[napi(js_name = "trySendDatagram")]
    pub fn try_send_datagram(&self, data: Buffer) -> Option<String> {
        crate::session::try_send_datagram_for_session(&self.id, data.as_ref())
            .map(|code| code.to_string())
    }

    /// Spawn on the addon runtime without holding an exclusive napi borrow of
    /// `self` across `.await` (Bun rejects concurrent `async fn &self` calls).
    ///
    /// Do NOT wrap this in `RUNTIME.spawn`. Same injection-queue collapse as
    /// `read_datagram`: under echo at one worker, sends sat at 5,213/s with the
    /// hop and rose to 55,306/s (100% echo) without it. `send_datagram_for_session`
    /// awaits a Notify plus a timer deadline, then makes a synchronous quinn
    /// call — no server-runtime IO-driver affinity. napi-rs's current_thread
    /// runtime already has a time driver.
    #[napi(ts_return_type = "Promise<void>")]
    pub fn send_datagram(&self, env: Env, data: Buffer) -> Result<JsObject> {
        let id = self.id.clone();
        let bytes = data.as_ref().to_vec();
        self.spawn_counted(env, AsyncOpKind::Datagram, async move {
            send_datagram_for_session(&id, &bytes).await
        })
    }

    /// Send up to 256 datagrams across one N-API crossing.
    ///
    /// Resolves `{sent, code?}` and never rejects: `sent = k` means elements
    /// `0..k` went out in order, `code` is why element `k` failed, and elements
    /// after `k` were not attempted. A partial send is normal on an unreliable
    /// transport, so the caller drops element `k` and re-calls with the rest.
    ///
    /// Every payload is copied here, synchronously, before `spawn_future` — the
    /// caller may reuse its arrays the moment this returns. More than 256
    /// elements resolves `{sent: <=256, code: "E_BATCH_TOO_LARGE"}` rather than
    /// silently dropping the tail; the TypeScript wrapper chunks so no ordinary
    /// caller sees it.
    ///
    /// Same no-hop contract as `send_datagram`.
    #[napi(ts_return_type = "Promise<DatagramBatchResult>")]
    pub fn send_datagram_batch(&self, env: Env, data: Vec<Uint8Array>) -> Result<JsObject> {
        let id = self.id.clone();
        let prepared = crate::datagram_batch::prepare_batch(&data);
        env.spawn_future(async move { Ok(send_datagram_batch_for_session(&id, prepared).await) })
    }

    /// Reads on the N-API runtime `spawn_future` already provides. Do NOT
    /// reintroduce a `RUNTIME.spawn` hop here: spawning into the server runtime
    /// from the N-API runtime is a spawn from *outside* it, so the task lands
    /// in the server runtime's injection queue. A worker whose local queue
    /// never runs dry only services that queue on a tick, one task per
    /// `global_queue_interval` polls, and tokio tunes that interval to one
    /// check per 200µs of work — capping delivery at ~5,000/s whatever the
    /// platform or the load. That was the measured collapse: 5,266 delivered/s
    /// with 95% of datagrams dropped, against 84,823/s with none dropped once
    /// the hop is gone.
    ///
    /// The hop bought nothing. `read_datagram_for_session` only locks a Tokio
    /// mutex and receives from a Tokio mpsc — no timers, no IO driver, no
    /// server-runtime context of any kind. `scripts/check-doc-truth.ts` pins
    /// this against the documented delivery path in `docs/ARCHITECTURE.md`.
    #[napi(ts_return_type = "Promise<Buffer | null>")]
    pub fn read_datagram(&self, env: Env) -> Result<JsObject> {
        let id = self.id.clone();
        self.spawn_counted(env, AsyncOpKind::Datagram, async move {
            Ok(read_datagram_for_session(&id)
                .await?
                .map(crate::payload_buffer::PayloadBuffer::from))
        })
    }

    /// Read up to `max` datagrams with a single delivery call.
    ///
    /// Blocks for the first datagram, then takes whatever else is already
    /// queued, which amortizes the N-API round trip across the batch. `max` is
    /// clamped into 1..=256 silently, and a closed session or a closed queue
    /// resolves `null` — never a rejection and never an empty array.
    ///
    /// Same no-hop contract as `read_datagram`. A `RUNTIME.spawn` here would
    /// put one injection-queue task per batch and reopen the ~5,000/s cliff
    /// at fill 1, or cap batches at that cadence.
    #[napi(ts_return_type = "Promise<Uint8Array[] | null>")]
    pub fn read_datagram_batch(&self, env: Env, max: u32) -> Result<JsObject> {
        let id = self.id.clone();
        self.spawn_counted(env, AsyncOpKind::Datagram, async move {
            Ok(read_datagram_batch_for_session(&id, max)
                .await?
                .map(|batch| {
                    batch
                        .into_iter()
                        .map(crate::payload_buffer::PayloadBuffer::from)
                        .collect::<Vec<_>>()
                }))
        })
    }

    /// Consume one queued datagram without allocating a JavaScript payload.
    /// This is used by bounded load/evidence drains that intentionally count
    /// delivery but do not need to inspect every payload after the probe.
    ///
    /// Same no-hop contract as `read_datagram`. A per-call JS loop with the hop
    /// collapsed to 5,374/s and 94.5% dropped; without it, 83,479/s and zero
    /// drops. The optional `tokio::time::timeout` runs on the N-API runtime's
    /// time driver. Bulk `discard_datagrams` is a different site and keeps its
    /// hop — one spawn then a native loop, so it does not pin that runtime.
    #[napi(ts_return_type = "Promise<boolean | null>")]
    pub fn discard_datagram(&self, env: Env, timeout_ms: Option<u32>) -> Result<JsObject> {
        let id = self.id.clone();
        let timeout = timeout_ms.map(|ms| std::time::Duration::from_millis(ms.into()));
        self.spawn_counted(env, AsyncOpKind::Datagram, async move {
            discard_datagram_for_session(&id, timeout).await
        })
    }

    /// Consume queued datagrams until the session closes or the deadline
    /// expires without allocating a JavaScript payload per datagram.
    ///
    /// The hop stays. This is one injected task that then loops on the server
    /// runtime; moving it onto napi-rs's current_thread runtime would monopolise
    /// the JS thread for the whole drain.
    #[napi(ts_return_type = "Promise<number | null>")]
    pub fn discard_datagrams(&self, env: Env, timeout_ms: Option<u32>) -> Result<JsObject> {
        let id = self.id.clone();
        self.spawn_counted(env, AsyncOpKind::Datagram, async move {
            RUNTIME
                .spawn(async move {
                    let timeout = timeout_ms.map(|ms| std::time::Duration::from_millis(ms.into()));
                    discard_datagrams_for_session(&id, timeout).await
                })
                .await
                .map_err(wt_from_upstream_error)?
                .map(|count| count.map(|value| value.min(u32::MAX as u64) as u32))
        })
    }

    /// Consume accepted server bidi streams without creating JS stream wrappers.
    #[napi(ts_return_type = "Promise<number | null>")]
    pub fn discard_bidi_streams(&self, env: Env, timeout_ms: Option<u32>) -> Result<JsObject> {
        let id = self.id.clone();
        self.spawn_counted(env, AsyncOpKind::Stream, async move {
            RUNTIME
                .spawn(async move {
                    let timeout = timeout_ms.map(|ms| std::time::Duration::from_millis(ms.into()));
                    discard_bidi_streams_for_session(&id, timeout).await
                })
                .await
                .map_err(wt_from_upstream_error)?
                .map(|count| count.map(|value| value.min(u32::MAX as u64) as u32))
        })
    }

    /// Consume accepted server uni streams without creating JS stream wrappers.
    #[napi(ts_return_type = "Promise<number | null>")]
    pub fn discard_uni_streams(&self, env: Env, timeout_ms: Option<u32>) -> Result<JsObject> {
        let id = self.id.clone();
        self.spawn_counted(env, AsyncOpKind::Stream, async move {
            RUNTIME
                .spawn(async move {
                    let timeout = timeout_ms.map(|ms| std::time::Duration::from_millis(ms.into()));
                    discard_uni_streams_for_session(&id, timeout).await
                })
                .await
                .map_err(wt_from_upstream_error)?
                .map(|count| count.map(|value| value.min(u32::MAX as u64) as u32))
        })
    }

    /// Enable native consumption for subsequent accepted bidi streams. This
    /// keeps bounded load/evidence drains out of the N-API wrapper path.
    #[napi(js_name = "enableBidiDiscard")]
    pub fn enable_bidi_discard(&self) {
        let _ = session_registry::enable_bidi_discard(&self.id);
    }

    /// Enable native consumption for subsequent accepted uni streams. This
    /// keeps bounded load/evidence drains out of the N-API wrapper path.
    #[napi(js_name = "enableUniDiscard")]
    pub fn enable_uni_discard(&self) {
        let _ = session_registry::enable_uni_discard(&self.id);
    }

    #[napi(ts_return_type = "Promise<ClientBidiStreamHandle>")]
    pub fn create_bidi_stream(&self, env: Env) -> Result<JsObject> {
        let id = self.id.clone();
        self.spawn_counted(env, AsyncOpKind::Stream, async move {
            RUNTIME
                .spawn(async move { create_bidi_stream_for_session(&id).await })
                .await
                .map_err(wt_from_upstream_error)?
        })
    }

    #[napi(ts_return_type = "Promise<void>")]
    pub fn wait_bidi_capacity(&self, env: Env, timeout_ms: u32) -> Result<JsObject> {
        let id = self.id.clone();
        self.spawn_counted(env, AsyncOpKind::Stream, async move {
            RUNTIME
                .spawn(async move { wait_session_stream_capacity(id, timeout_ms, "bidi").await })
                .await
                .map_err(wt_from_upstream_error)?
        })
    }

    #[napi(ts_return_type = "Promise<ClientBidiStreamHandle | null>")]
    pub fn accept_bidi_stream(&self, env: Env) -> Result<JsObject> {
        let id = self.id.clone();
        self.spawn_counted(env, AsyncOpKind::Stream, async move {
            RUNTIME
                .spawn(async move { accept_bidi_stream_for_session(&id).await })
                .await
                .map_err(wt_from_upstream_error)?
        })
    }

    /// Internal load/evidence path: handle one ordered bidi probe in Rust.
    #[napi(js_name = "handleBidiProbe", ts_return_type = "Promise<boolean>")]
    pub fn handle_bidi_probe(&self, env: Env) -> Result<JsObject> {
        let id = self.id.clone();
        self.spawn_counted(env, AsyncOpKind::Stream, async move {
            RUNTIME
                .spawn(async move { handle_bidi_probe_for_session(&id).await })
                .await
                .map_err(wt_from_upstream_error)?
        })
    }

    #[napi(ts_return_type = "Promise<ClientUniSendHandle>")]
    pub fn create_uni_stream(&self, env: Env) -> Result<JsObject> {
        let id = self.id.clone();
        self.spawn_counted(env, AsyncOpKind::Stream, async move {
            RUNTIME
                .spawn(async move { create_uni_stream_for_session(&id).await })
                .await
                .map_err(wt_from_upstream_error)?
        })
    }

    #[napi(ts_return_type = "Promise<void>")]
    pub fn wait_uni_capacity(&self, env: Env, timeout_ms: u32) -> Result<JsObject> {
        let id = self.id.clone();
        self.spawn_counted(env, AsyncOpKind::Stream, async move {
            RUNTIME
                .spawn(async move { wait_session_stream_capacity(id, timeout_ms, "uni").await })
                .await
                .map_err(wt_from_upstream_error)?
        })
    }

    #[napi(ts_return_type = "Promise<ClientUniRecvHandle | null>")]
    pub fn accept_uni_stream(&self, env: Env) -> Result<JsObject> {
        let id = self.id.clone();
        self.spawn_counted(env, AsyncOpKind::Stream, async move {
            RUNTIME
                .spawn(async move { accept_uni_stream_for_session(&id).await })
                .await
                .map_err(wt_from_upstream_error)?
        })
    }

    /// Internal load/evidence path: handle one ordered uni probe in Rust.
    #[napi(js_name = "handleUniProbe", ts_return_type = "Promise<number>")]
    pub fn handle_uni_probe(&self, env: Env) -> Result<JsObject> {
        let id = self.id.clone();
        self.spawn_counted(env, AsyncOpKind::Stream, async move {
            RUNTIME
                .spawn(async move { handle_uni_probe_for_session(&id).await })
                .await
                .map_err(wt_from_upstream_error)?
        })
    }

    #[napi]
    pub fn metrics_snapshot(&self) -> WtResult<crate::metrics::SessionMetricsSnapshot> {
        panic_guard::catch_panic(|| {
            Ok(session_metrics_snapshot_from(
                session_registry::get_session_metrics(&self.id).as_deref(),
            ))
        })
        .map_err(wt_from_reason)
    }
}
