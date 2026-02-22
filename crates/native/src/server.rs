//! WebTransport server via wtransport. Updates ServerMetrics for Phase 4.3.1.

use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction};
use napi::{Env, JsFunction, Result};
use napi_derive::napi;
use std::sync::{Arc, Mutex};
use tokio::sync::watch;

use crate::panic_guard;
use crate::server_metrics::ServerMetrics;
use crate::SessionEvent;

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
        cert_pem: String,
        key_pem: String,
        _limits_json: String,
        _rate_limits_json: String,
        on_session: JsFunction,
    ) -> Result<Self> {
        panic_guard::catch_panic(|| {
            let on_session_tsfn: Option<ThreadsafeFunction<SessionEvent, ErrorStrategy::Fatal>> =
                on_session
                    .create_threadsafe_function(
                        0,
                        |ctx: napi::threadsafe_function::ThreadSafeCallContext<SessionEvent>| {
                            let mut evt = ctx.env.create_object()?;
                            match &ctx.value {
                                crate::SessionEvent::Accepted(v) => {
                                    evt.set("name", "session")?;
                                    evt.set("id", v.id.as_str())?;
                                    evt.set("peerIp", v.peer_ip.as_str())?;
                                    evt.set("peerPort", v.peer_port)?;
                                }
                                crate::SessionEvent::Closed { id, code, reason } => {
                                    evt.set("name", "session_closed")?;
                                    evt.set("id", id.as_str())?;
                                    if let Some(c) = code {
                                        evt.set("code", *c)?;
                                    }
                                    if let Some(r) = reason {
                                        evt.set("reason", r.as_str())?;
                                    }
                                }
                            }
                            let mut arr = ctx.env.create_array_with_length(1)?;
                            arr.set_element(0, evt)?;
                            Ok(vec![arr])
                        },
                    )
                    .ok();

            let metrics = Arc::new(ServerMetrics::default());
            let limits = crate::limits::Limits::from_json(&_limits_json);
            let handshakes_burst_per_ip =
                crate::rate_limit::handshakes_burst_from_json(&_rate_limits_json);
            let handshakes_burst_per_prefix =
                crate::rate_limit::handshakes_burst_per_prefix_from_json(&_rate_limits_json);
            let (shutdown_tx, shutdown_rx) = watch::channel(());
            let metrics_clone = Arc::clone(&metrics);
            let port_u16 = port.min(65535) as u16;
            crate::spawn_wtransport_server(
                metrics_clone,
                limits,
                handshakes_burst_per_ip,
                handshakes_burst_per_prefix,
                port_u16,
                shutdown_rx,
                on_session_tsfn,
                cert_pem,
                key_pem,
            );
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
