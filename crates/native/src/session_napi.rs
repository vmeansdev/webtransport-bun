//! NAPI bindings for SessionHandle. Risk-module coverage floors target `session.rs` logic.
use napi::bindgen_prelude::Buffer;
use napi::{Env, JsObject, Result};
use napi_derive::napi;

use crate::error::{
    from_reason as wt_from_reason, from_upstream_error as wt_from_upstream_error, WtResult,
};
use crate::panic_guard;
use crate::session::{
    accept_bidi_stream_for_session, accept_uni_stream_for_session, create_bidi_stream_for_session,
    create_uni_stream_for_session, discard_bidi_streams_for_session, discard_datagram_for_session,
    discard_datagrams_for_session, discard_uni_streams_for_session, handle_bidi_probe_for_session,
    handle_uni_probe_for_session, read_datagram_for_session, send_datagram_for_session,
    session_metrics_snapshot_from, wait_session_stream_capacity,
};
use crate::session_registry;
use crate::RUNTIME;

#[napi]
pub struct SessionHandle {
    id: String,
    peer_ip: String,
    peer_port: u32,
}

#[napi]
impl SessionHandle {
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
        env.spawn_future(async move {
            let Some((conn, ..)) = session_registry::get(&id) else {
                return Ok(());
            };
            RUNTIME
                .spawn(async move { conn.draining().await })
                .await
                .map_err(wt_from_upstream_error)?;
            Ok(())
        })
    }

    /// Spawn on the addon runtime without holding an exclusive napi borrow of
    /// `self` across `.await` (Bun rejects concurrent `async fn &self` calls).
    #[napi(ts_return_type = "Promise<void>")]
    pub fn send_datagram(&self, env: Env, data: Buffer) -> Result<JsObject> {
        let id = self.id.clone();
        let bytes = data.as_ref().to_vec();
        env.spawn_future(async move {
            RUNTIME
                .spawn(async move { send_datagram_for_session(&id, &bytes).await })
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
                    Ok(read_datagram_for_session(&id)
                        .await?
                        .map(crate::payload_buffer::PayloadBuffer::from))
                })
                .await
                .map_err(wt_from_upstream_error)?
        })
    }

    /// Consume one queued datagram without allocating a JavaScript payload.
    /// This is used by bounded load/evidence drains that intentionally count
    /// delivery but do not need to inspect every payload after the probe.
    #[napi(ts_return_type = "Promise<boolean | null>")]
    pub fn discard_datagram(&self, env: Env, timeout_ms: Option<u32>) -> Result<JsObject> {
        let id = self.id.clone();
        env.spawn_future(async move {
            RUNTIME
                .spawn(async move {
                    let timeout = timeout_ms.map(|ms| std::time::Duration::from_millis(ms.into()));
                    discard_datagram_for_session(&id, timeout).await
                })
                .await
                .map_err(wt_from_upstream_error)?
        })
    }

    /// Consume queued datagrams until the session closes or the deadline
    /// expires without allocating a JavaScript payload per datagram.
    #[napi(ts_return_type = "Promise<number | null>")]
    pub fn discard_datagrams(&self, env: Env, timeout_ms: Option<u32>) -> Result<JsObject> {
        let id = self.id.clone();
        env.spawn_future(async move {
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
        env.spawn_future(async move {
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
        env.spawn_future(async move {
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
        env.spawn_future(async move {
            RUNTIME
                .spawn(async move { create_bidi_stream_for_session(&id).await })
                .await
                .map_err(wt_from_upstream_error)?
        })
    }

    #[napi(ts_return_type = "Promise<void>")]
    pub fn wait_bidi_capacity(&self, env: Env, timeout_ms: u32) -> Result<JsObject> {
        let id = self.id.clone();
        env.spawn_future(async move {
            RUNTIME
                .spawn(async move { wait_session_stream_capacity(id, timeout_ms, "bidi").await })
                .await
                .map_err(wt_from_upstream_error)?
        })
    }

    #[napi(ts_return_type = "Promise<ClientBidiStreamHandle | null>")]
    pub fn accept_bidi_stream(&self, env: Env) -> Result<JsObject> {
        let id = self.id.clone();
        env.spawn_future(async move {
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
        env.spawn_future(async move {
            RUNTIME
                .spawn(async move { handle_bidi_probe_for_session(&id).await })
                .await
                .map_err(wt_from_upstream_error)?
        })
    }

    #[napi(ts_return_type = "Promise<ClientUniSendHandle>")]
    pub fn create_uni_stream(&self, env: Env) -> Result<JsObject> {
        let id = self.id.clone();
        env.spawn_future(async move {
            RUNTIME
                .spawn(async move { create_uni_stream_for_session(&id).await })
                .await
                .map_err(wt_from_upstream_error)?
        })
    }

    #[napi(ts_return_type = "Promise<void>")]
    pub fn wait_uni_capacity(&self, env: Env, timeout_ms: u32) -> Result<JsObject> {
        let id = self.id.clone();
        env.spawn_future(async move {
            RUNTIME
                .spawn(async move { wait_session_stream_capacity(id, timeout_ms, "uni").await })
                .await
                .map_err(wt_from_upstream_error)?
        })
    }

    #[napi(ts_return_type = "Promise<ClientUniRecvHandle | null>")]
    pub fn accept_uni_stream(&self, env: Env) -> Result<JsObject> {
        let id = self.id.clone();
        env.spawn_future(async move {
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
        env.spawn_future(async move {
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
