use napi_derive::napi;
use napi::Result;

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
        Ok(())
    }

    #[napi]
    pub async fn send_datagram(&self, data: napi::bindgen_prelude::Buffer) -> Result<()> {
        // Phase 6.1: In a real implementation we push to mpsc channel bounded by maxQueuedBytes
        Ok(())
    }

    // Usually we would return an async iterator, but napi-rs doesn't strictly have a direct AsyncIterator binding.
    // So we provide a pull-based next() pump that JS can wrap in an AsyncGenerator.
    #[napi]
    pub async fn read_datagram(&self) -> Result<Option<napi::bindgen_prelude::Buffer>> {
        // Phase 6.2: Read from unbounded/bounded channel linked to wtransport incoming datagrams
        // Return Ok(None) when closed
        Ok(None)
    }
}
