use napi_derive::napi;
use napi::{Env, JsFunction, Result};

use crate::panic_guard;

#[napi]
pub struct ServerHandle {
    // We will hold the background task handle here later
    port: u32,
}

#[napi]
impl ServerHandle {
    #[napi(constructor)]
    pub fn new(
        _env: Env,
        port: u32,
        _cert_pem: String,
        _key_pem: String,
        _limits_json: String,
        _rate_limits_json: String,
        _on_session: JsFunction
    ) -> Result<Self> {
        panic_guard::catch_panic(|| {
            // Validate cert and key
            // Note: For real we would spawn a wtransport server
            Ok(Self { port })
        })
    }

    #[napi(getter)]
    pub fn port(&self) -> u32 {
        panic_guard::catch_panic(|| Ok(self.port)).unwrap_or(0)
    }

    #[napi]
    pub async fn close(&self) -> Result<()> {
        panic_guard::catch_panic(|| Ok(()))
    }

    #[napi]
    pub fn metrics_snapshot(&self) -> Result<crate::metrics::ServerMetricsSnapshot> {
        panic_guard::catch_panic(|| Ok(crate::metrics::ServerMetricsSnapshot {
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
        }))
    }
}
