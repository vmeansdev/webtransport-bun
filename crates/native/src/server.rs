//! WebTransport server via wtransport. Updates ServerMetrics for Phase 4.3.1.

use napi_derive::napi;
use napi::{Env, JsFunction, Result};
use std::sync::{Arc, Mutex};
use tokio::sync::watch;

use crate::panic_guard;
use crate::server_metrics::ServerMetrics;

#[napi]
pub struct ServerHandle {
    port: u32,
    metrics: Arc<ServerMetrics>,
    shutdown_tx: Mutex<Option<watch::Sender<()>>>,
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
        _on_session: JsFunction,
    ) -> Result<Self> {
        panic_guard::catch_panic(|| {
            let metrics = Arc::new(ServerMetrics::default());
            let limits = crate::limits::Limits::from_json(&_limits_json);
            let (shutdown_tx, shutdown_rx) = watch::channel(());
            let metrics_clone = Arc::clone(&metrics);
            let port_u16 = port.min(65535) as u16;
            crate::spawn_wtransport_server(metrics_clone, limits, port_u16, shutdown_rx);
            Ok(Self {
                port,
                metrics,
                shutdown_tx: Mutex::new(Some(shutdown_tx)),
            })
        })
    }

    #[napi(getter)]
    pub fn port(&self) -> u32 {
        panic_guard::catch_panic(|| Ok(self.port)).unwrap_or(0)
    }

    #[napi]
    pub async fn close(&self) -> Result<()> {
        panic_guard::catch_panic(|| {
            let _ = self.shutdown_tx.lock().ok().and_then(|mut g| g.take());
            Ok(())
        })
    }

    #[napi]
    pub fn metrics_snapshot(&self) -> Result<crate::metrics::ServerMetricsSnapshot> {
        panic_guard::catch_panic(|| Ok(self.metrics.snapshot()))
    }
}
