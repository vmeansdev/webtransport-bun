use napi::Result;
use napi_derive::napi;

use crate::client_stream::{ClientBidiStreamHandle, ClientUniRecvHandle, ClientUniSendHandle};
use crate::panic_guard;
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

    #[napi]
    pub fn close(&self, code: Option<u32>, reason: Option<String>) -> Result<()> {
        let c = code.unwrap_or(0);
        let r = reason.unwrap_or_default();
        session_registry::close_session(&self.id, c, r.as_bytes());
        Ok(())
    }

    #[napi]
    pub async fn send_datagram(&self, data: napi::bindgen_prelude::Buffer) -> Result<()> {
        let id = self.id.clone();
        let bytes = data.as_ref().to_vec();
        let Some((conn, _, metrics, _, _, _, _)) = session_registry::get(&id) else {
            return Err(napi::Error::from_reason("E_SESSION_CLOSED"));
        };
        let sz = bytes.len();
        if sz > 1200 {
            return Err(napi::Error::from_reason("E_QUEUE_FULL"));
        }
        let timeout = tokio::time::Duration::from_millis(5000);
        let send_fut = RUNTIME.spawn(async move {
            conn.send_datagram(&bytes)
                .map_err(|_| napi::Error::from_reason("E_SESSION_CLOSED"))?;
            metrics
                .datagrams_out
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            Ok(())
        });
        tokio::time::timeout(timeout, send_fut)
            .await
            .map_err(|_| napi::Error::from_reason("E_BACKPRESSURE_TIMEOUT"))?
            .map_err(|e: tokio::task::JoinError| napi::Error::from_reason(e.to_string()))?
    }

    // Usually we would return an async iterator, but napi-rs doesn't strictly have a direct AsyncIterator binding.
    // So we provide a pull-based next() pump that JS can wrap in an AsyncGenerator.
    #[napi]
    pub async fn read_datagram(&self) -> Result<Option<napi::bindgen_prelude::Buffer>> {
        let id = self.id.clone();
        let Some((_, dgram_rx, _, _, _, _, _)) = session_registry::get(&id) else {
            return Ok(None);
        };
        let mut rx = dgram_rx.lock().await;
        Ok(rx.recv().await.map(|v| v.into()))
    }

    // Streams (P0-1: wired to wtransport via session registry)

    #[napi]
    pub async fn create_bidi_stream(&self) -> Result<ClientBidiStreamHandle> {
        let id = self.id.clone();
        RUNTIME
            .spawn(async move {
                let Some((_, _, _, _, _, create_bi_tx, _)) = session_registry::get(&id) else {
                    return Err(napi::Error::from_reason("E_SESSION_CLOSED"));
                };
                let (resp_tx, resp_rx) = tokio::sync::oneshot::channel();
                create_bi_tx
                    .send(resp_tx)
                    .await
                    .map_err(|_| napi::Error::from_reason("E_SESSION_CLOSED"))?;
                resp_rx
                    .await
                    .map_err(|_| napi::Error::from_reason("E_SESSION_CLOSED"))?
                    .map_err(|e| napi::Error::from_reason(e))
            })
            .await
            .map_err(|e| napi::Error::from_reason(e.to_string()))?
    }

    #[napi]
    pub async fn accept_bidi_stream(&self) -> Result<Option<ClientBidiStreamHandle>> {
        let id = self.id.clone();
        let Some((_, _, _, bidi_rx, _, _, _)) = session_registry::get(&id) else {
            return Ok(None);
        };
        let mut rx = bidi_rx.lock().await;
        Ok(rx.recv().await)
    }

    #[napi]
    pub async fn create_uni_stream(&self) -> Result<ClientUniSendHandle> {
        let id = self.id.clone();
        RUNTIME
            .spawn(async move {
                let Some((_, _, _, _, _, _, create_uni_tx)) = session_registry::get(&id) else {
                    return Err(napi::Error::from_reason("E_SESSION_CLOSED"));
                };
                let (resp_tx, resp_rx) = tokio::sync::oneshot::channel();
                create_uni_tx
                    .send(resp_tx)
                    .await
                    .map_err(|_| napi::Error::from_reason("E_SESSION_CLOSED"))?;
                resp_rx
                    .await
                    .map_err(|_| napi::Error::from_reason("E_SESSION_CLOSED"))?
                    .map_err(|e| napi::Error::from_reason(e))
            })
            .await
            .map_err(|e| napi::Error::from_reason(e.to_string()))?
    }

    #[napi]
    pub async fn accept_uni_stream(&self) -> Result<Option<ClientUniRecvHandle>> {
        let id = self.id.clone();
        let Some((_, _, _, _, uni_rx, _, _)) = session_registry::get(&id) else {
            return Ok(None);
        };
        let mut rx = uni_rx.lock().await;
        Ok(rx.recv().await)
    }

    #[napi]
    pub fn metrics_snapshot(&self) -> Result<crate::metrics::SessionMetricsSnapshot> {
        panic_guard::catch_panic(|| {
            Ok(crate::metrics::SessionMetricsSnapshot {
                datagrams_in: 0,
                datagrams_out: 0,
                streams_active: 0,
                queued_bytes: 0,
            })
        })
    }
}
