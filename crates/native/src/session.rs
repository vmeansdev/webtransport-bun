use napi::Result;
use napi_derive::napi;

use crate::panic_guard;

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
    pub async fn send_datagram(&self, _data: napi::bindgen_prelude::Buffer) -> Result<()> {
        panic_guard::catch_panic(|| Ok(()))
    }

    // Usually we would return an async iterator, but napi-rs doesn't strictly have a direct AsyncIterator binding.
    // So we provide a pull-based next() pump that JS can wrap in an AsyncGenerator.
    #[napi]
    pub async fn read_datagram(&self) -> Result<Option<napi::bindgen_prelude::Buffer>> {
        panic_guard::catch_panic(|| Ok(None))
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
