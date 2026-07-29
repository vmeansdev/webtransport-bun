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
    create_uni_stream_for_session, read_datagram_for_session, send_datagram_for_session,
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
                .spawn(async move { Ok(read_datagram_for_session(&id).await?.map(Buffer::from)) })
                .await
                .map_err(wt_from_upstream_error)?
        })
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
