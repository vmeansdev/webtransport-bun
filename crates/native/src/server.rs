//! WebTransport server via wtransport. Updates ServerMetrics for Phase 4.3.1.

use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction};
use napi::{Env, JsFunction, Result};
use napi_derive::napi;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::watch;

use crate::panic_guard;
use crate::server_metrics::ServerMetrics;
use crate::{LogEvent, SessionEvent};

#[napi]
pub struct ServerHandle {
    port: u32,
    metrics: Arc<ServerMetrics>,
    shutdown_tx: Mutex<Option<watch::Sender<()>>>,
}

#[napi]
impl ServerHandle {
    #[napi(constructor)]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        _env: Env,
        port: u32,
        host: String,
        debug: bool,
        cert_pem: String,
        key_pem: String,
        ca_pem: String,
        _limits_json: String,
        _rate_limits_json: String,
        on_session: JsFunction,
        log_fn: JsFunction,
    ) -> Result<Self> {
        panic_guard::catch_panic(|| {
            if !ca_pem.trim().is_empty() {
                return Err(napi::Error::from_reason(
                    "E_TLS: server tls.caPem is not supported yet",
                ));
            }
            let session_tsfn: Option<ThreadsafeFunction<Vec<SessionEvent>, ErrorStrategy::Fatal>> =
                on_session
                    .create_threadsafe_function(
                        0,
                        |ctx: napi::threadsafe_function::ThreadSafeCallContext<
                            Vec<SessionEvent>,
                        >| {
                            let mut arr = ctx.env.create_array_with_length(ctx.value.len())?;
                            for (i, event) in ctx.value.iter().enumerate() {
                                let mut evt = ctx.env.create_object()?;
                                match event {
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
                                arr.set_element(i as u32, evt)?;
                            }
                            Ok(vec![arr])
                        },
                    )
                    .ok();

            let log_tsfn: Option<ThreadsafeFunction<Vec<LogEvent>, ErrorStrategy::Fatal>> = log_fn
                .create_threadsafe_function(
                    0,
                    |ctx: napi::threadsafe_function::ThreadSafeCallContext<Vec<LogEvent>>| {
                        let mut arr = ctx.env.create_array_with_length(ctx.value.len())?;
                        for (i, le) in ctx.value.iter().enumerate() {
                            let mut evt = ctx.env.create_object()?;
                            evt.set("level", le.level.as_str())?;
                            evt.set("msg", le.msg.as_str())?;
                            if let Some(ref sid) = le.session_id {
                                evt.set("sessionId", sid.as_str())?;
                            }
                            if let Some(ref ip) = le.peer_ip {
                                evt.set("peerIp", ip.as_str())?;
                            }
                            if let Some(p) = le.peer_port {
                                evt.set("peerPort", p)?;
                            }
                            arr.set_element(i as u32, evt)?;
                        }
                        Ok(vec![arr])
                    },
                )
                .ok();

            let session_tx = session_tsfn.map(|tsfn| crate::spawn_event_batcher(tsfn, 64, 5));
            let log_tx = log_tsfn.map(|tsfn| crate::spawn_event_batcher(tsfn, 128, 10));

            let metrics = Arc::new(ServerMetrics::default());
            let limits = crate::limits::Limits::from_json(&_limits_json);
            let rate_limits = crate::rate_limit::RateLimits::from_json(&_rate_limits_json);
            crate::panic_guard::set_panic_log_verbose(debug);
            let (shutdown_tx, shutdown_rx) = watch::channel(());
            let (startup_tx, startup_rx) =
                std::sync::mpsc::channel::<std::result::Result<(), String>>();
            let metrics_clone = Arc::clone(&metrics);
            let port_u16 = port.min(65535) as u16;
            crate::spawn_wtransport_server(
                metrics_clone,
                limits,
                rate_limits,
                host,
                port_u16,
                shutdown_rx,
                session_tx,
                log_tx,
                cert_pem,
                key_pem,
                debug,
                startup_tx,
            );
            match startup_rx.recv_timeout(Duration::from_secs(5)) {
                Ok(Ok(())) => {}
                Ok(Err(msg)) => {
                    return Err(napi::Error::from_reason(format!(
                        "E_INTERNAL: server startup failed: {}",
                        msg
                    )));
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    return Err(napi::Error::from_reason(
                        "E_INTERNAL: server startup timed out".to_string(),
                    ));
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(napi::Error::from_reason(
                        "E_INTERNAL: server startup channel disconnected".to_string(),
                    ));
                }
            }
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
            crate::session_registry::close_all(0, b"server closing");
            Ok(())
        })?;
        let metrics = Arc::clone(&self.metrics);
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        crate::RUNTIME.spawn(async move {
            let deadline = tokio::time::Instant::now() + tokio::time::Duration::from_secs(5);
            loop {
                let sessions = metrics
                    .session_tasks_active
                    .load(std::sync::atomic::Ordering::Relaxed);
                let streams = metrics
                    .stream_tasks_active
                    .load(std::sync::atomic::Ordering::Relaxed);
                if sessions == 0 && streams == 0 {
                    break;
                }
                if tokio::time::Instant::now() >= deadline {
                    break;
                }
                tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
            }
            let _ = done_tx.send(());
        });
        let _ = done_rx.recv_timeout(std::time::Duration::from_secs(6));
        Ok(())
    }

    #[napi]
    pub fn metrics_snapshot(&self) -> Result<crate::metrics::ServerMetricsSnapshot> {
        panic_guard::catch_panic(|| Ok(self.metrics.snapshot()))
    }
}
