use napi::Result;
use napi_derive::napi;

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
    pub fn close(&self) -> Result<()> {
        panic_guard::catch_panic(|| Ok(()))
    }

    #[napi]
    pub async fn send_datagram(&self, data: napi::bindgen_prelude::Buffer) -> Result<()> {
        let id = self.id.clone();
        let bytes = data.as_ref().to_vec();
        let handle = RUNTIME.spawn(async move {
            match session_registry::get(&id) {
                Some((conn, _, metrics)) => {
                    let ok = conn.send_datagram(&bytes).is_ok();
                    if ok {
                        metrics.datagrams_out.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    }
                    if ok {
                        Ok(())
                    } else {
                        Err(napi::Error::from_reason("E_SESSION_CLOSED"))
                    }
                }
                None => Err(napi::Error::from_reason("E_SESSION_CLOSED")),
            }
        });
        match handle.await {
            Ok(Ok(())) => Ok(()),
            Ok(Err(e)) => Err(e),
            Err(e) => Err(napi::Error::from_reason(e.to_string())),
        }
    }

    // Usually we would return an async iterator, but napi-rs doesn't strictly have a direct AsyncIterator binding.
    // So we provide a pull-based next() pump that JS can wrap in an AsyncGenerator.
    #[napi]
    pub async fn read_datagram(&self) -> Result<Option<napi::bindgen_prelude::Buffer>> {
        let id = self.id.clone();
        let result = RUNTIME
            .spawn(async move {
                let Some((_, dgram_rx, _)) = session_registry::get(&id) else {
                    return None;
                };
                let mut rx = dgram_rx.lock().await;
                rx.recv().await
            })
            .await;
        match result {
            Ok(Some(v)) => Ok(Some(v.into())),
            Ok(None) => Ok(None),
            Err(e) => Err(napi::Error::from_reason(e.to_string())),
        }
    }

    // Streams

    #[napi]
    pub async fn create_bidi_stream(&self) -> Result<crate::stream::StreamHandle> {
        panic_guard::catch_panic(|| Ok(crate::stream::StreamHandle::new(0)))
    }

    #[napi]
    pub async fn accept_bidi_stream(&self) -> Result<Option<crate::stream::StreamHandle>> {
        panic_guard::catch_panic(|| Ok(None))
    }

    #[napi]
    pub async fn create_uni_stream(&self) -> Result<crate::stream::StreamHandle> {
        panic_guard::catch_panic(|| Ok(crate::stream::StreamHandle::new(0)))
    }

    #[napi]
    pub async fn accept_uni_stream(&self) -> Result<Option<crate::stream::StreamHandle>> {
        panic_guard::catch_panic(|| Ok(None))
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
