use napi_derive::napi;
use napi::{Env, JsFunction, Result};
use wtransport::ServerConfig;
use wtransport::tls::Certificate;

#[napi]
pub struct ServerHandle {
    // We will hold the background task handle here later
    port: u32,
}

#[napi]
impl ServerHandle {
    #[napi(constructor)]
    pub fn new(env: Env, port: u32, cert_pem: String, key_pem: String, on_session: JsFunction) -> Result<Self> {
        // Validate cert and key
        // Note: For real we would spawn a wtransport server
        // Let's just create a dummy for now to verify bindings
        
        Ok(Self {
            port,
        })
    }

    #[napi(getter)]
    pub fn port(&self) -> u32 {
        self.port
    }

    #[napi]
    pub async fn close(&self) -> Result<()> {
        Ok(())
    }

    #[napi]
    pub fn metrics_snapshot(&self) -> Result<crate::metrics::ServerMetricsSnapshot> {
        Ok(crate::metrics::ServerMetricsSnapshot {
            now_ms: 0.0,
            sessions_active: 0,
            handshakes_in_flight: 0,
            streams_active: 0,
            datagrams_in: 0,
            datagrams_out: 0,
            datagrams_dropped: 0,
            queued_bytes_global: 0,
            backpressure_wait_count: 0,
            backpressure_timeout_count: 0,
            rate_limited_count: 0,
            limit_exceeded_count: 0,
        })
    }
}
