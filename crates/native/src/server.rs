//! WebTransport server via wtransport. Updates ServerMetrics for Phase 4.3.1.

use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction};
use napi::{Env, JsFunction, Result};
use napi_derive::napi;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::watch;

use crate::limits::Limits;
use crate::panic_guard;
use crate::rate_limit::RateLimits;
use crate::server_metrics::ServerMetrics;
use crate::{LogEvent, SessionEvent};

struct ServerRuntimeState {
    shutdown_tx: Option<watch::Sender<()>>,
    cert_pem: String,
    key_pem: String,
    closed: bool,
}

fn is_addr_in_use_error(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("address already in use") || lower.contains("addrinuse")
}

#[allow(clippy::too_many_arguments)]
fn spawn_server_instance(
    metrics: Arc<ServerMetrics>,
    limits: &Limits,
    rate_limits: &RateLimits,
    host: &str,
    port: u16,
    session_tx: &Option<tokio::sync::mpsc::Sender<SessionEvent>>,
    log_tx: &Option<tokio::sync::mpsc::Sender<LogEvent>>,
    cert_pem: &str,
    key_pem: &str,
    debug: bool,
    max_retries: usize,
) -> std::result::Result<watch::Sender<()>, String> {
    const RETRY_DELAY: Duration = Duration::from_millis(100);

    let mut last_err: Option<String> = None;

    for attempt in 0..max_retries {
        let (shutdown_tx, shutdown_rx) = watch::channel(());
        let (startup_tx, startup_rx) =
            std::sync::mpsc::channel::<std::result::Result<(), String>>();

        crate::spawn_wtransport_server(
            Arc::clone(&metrics),
            limits.clone(),
            rate_limits.clone(),
            host.to_string(),
            port,
            shutdown_rx,
            session_tx.clone(),
            log_tx.clone(),
            cert_pem.to_string(),
            key_pem.to_string(),
            debug,
            startup_tx,
        );

        match startup_rx.recv_timeout(Duration::from_secs(5)) {
            Ok(Ok(())) => return Ok(shutdown_tx),
            Ok(Err(msg)) => {
                let should_retry = is_addr_in_use_error(&msg) && attempt + 1 < max_retries;
                if should_retry {
                    last_err = Some(msg);
                    drop(shutdown_tx);
                    std::thread::sleep(RETRY_DELAY);
                    continue;
                }
                return Err(msg);
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                return Err("server startup timed out".to_string());
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                return Err("server startup channel disconnected".to_string());
            }
        }
    }

    Err(last_err.unwrap_or_else(|| "server startup failed".to_string()))
}

#[napi]
pub struct ServerHandle {
    port: u32,
    host: String,
    debug: bool,
    metrics: Arc<ServerMetrics>,
    limits: Limits,
    rate_limits: RateLimits,
    session_tx: Option<tokio::sync::mpsc::Sender<SessionEvent>>,
    log_tx: Option<tokio::sync::mpsc::Sender<LogEvent>>,
    state: Mutex<ServerRuntimeState>,
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
            let session_tsfn: ThreadsafeFunction<Vec<SessionEvent>, ErrorStrategy::Fatal> =
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
                    .map_err(|e| {
                        napi::Error::from_reason(format!(
                            "E_INTERNAL: failed to create onSession callback bridge: {}",
                            e
                        ))
                    })?;

            let log_tsfn: ThreadsafeFunction<Vec<LogEvent>, ErrorStrategy::Fatal> = log_fn
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
                .map_err(|e| {
                    napi::Error::from_reason(format!(
                        "E_INTERNAL: failed to create log callback bridge: {}",
                        e
                    ))
                })?;

            let session_tx = Some(crate::spawn_event_batcher(session_tsfn, 64, 5));
            let log_tx = Some(crate::spawn_event_batcher(log_tsfn, 128, 10));

            let metrics = Arc::new(ServerMetrics::default());
            let limits = crate::limits::Limits::from_json(&_limits_json);
            let rate_limits = crate::rate_limit::RateLimits::from_json(&_rate_limits_json);
            crate::panic_guard::set_panic_log_verbose(debug);
            let port_u16 = port.min(65535) as u16;

            let shutdown_tx = spawn_server_instance(
                Arc::clone(&metrics),
                &limits,
                &rate_limits,
                &host,
                port_u16,
                &session_tx,
                &log_tx,
                &cert_pem,
                &key_pem,
                debug,
                1,
            )
            .map_err(|msg| {
                napi::Error::from_reason(format!("E_INTERNAL: server startup failed: {}", msg))
            })?;

            Ok(Self {
                port,
                host,
                debug,
                metrics,
                limits,
                rate_limits,
                session_tx,
                log_tx,
                state: Mutex::new(ServerRuntimeState {
                    shutdown_tx: Some(shutdown_tx),
                    cert_pem,
                    key_pem,
                    closed: false,
                }),
            })
        })
    }

    #[napi(getter)]
    pub fn port(&self) -> u32 {
        panic_guard::catch_panic(|| Ok(self.port)).unwrap_or(0)
    }

    #[napi]
    pub async fn update_cert(&self, cert_pem: String, key_pem: String) -> Result<()> {
        panic_guard::catch_panic(|| {
            let mut state = self
                .state
                .lock()
                .map_err(|_| napi::Error::from_reason("E_INTERNAL: server state lock poisoned"))?;
            if state.closed {
                return Err(napi::Error::from_reason(
                    "E_SESSION_CLOSED: server is closed",
                ));
            }

            let old_cert = state.cert_pem.clone();
            let old_key = state.key_pem.clone();
            state.shutdown_tx.take();
            crate::session_registry::close_all(0, b"server cert rotating");

            let port_u16 = self.port.min(65535) as u16;
            match spawn_server_instance(
                Arc::clone(&self.metrics),
                &self.limits,
                &self.rate_limits,
                &self.host,
                port_u16,
                &self.session_tx,
                &self.log_tx,
                &cert_pem,
                &key_pem,
                self.debug,
                30,
            ) {
                Ok(new_shutdown_tx) => {
                    state.shutdown_tx = Some(new_shutdown_tx);
                    state.cert_pem = cert_pem;
                    state.key_pem = key_pem;
                    Ok(())
                }
                Err(update_err) => {
                    let rollback_result = spawn_server_instance(
                        Arc::clone(&self.metrics),
                        &self.limits,
                        &self.rate_limits,
                        &self.host,
                        port_u16,
                        &self.session_tx,
                        &self.log_tx,
                        &old_cert,
                        &old_key,
                        self.debug,
                        30,
                    );
                    match rollback_result {
                        Ok(rollback_shutdown_tx) => {
                            state.shutdown_tx = Some(rollback_shutdown_tx);
                            Err(napi::Error::from_reason(format!(
                                "E_INTERNAL: certificate rotation failed: {}; previous certificate restored",
                                update_err
                            )))
                        }
                        Err(rollback_err) => {
                            state.closed = true;
                            Err(napi::Error::from_reason(format!(
                                "E_INTERNAL: certificate rotation failed: {}; rollback failed: {}",
                                update_err, rollback_err
                            )))
                        }
                    }
                }
            }
        })
    }

    #[napi]
    pub async fn close(&self) -> Result<()> {
        panic_guard::catch_panic(|| {
            let mut state = self
                .state
                .lock()
                .map_err(|_| napi::Error::from_reason("E_INTERNAL: server state lock poisoned"))?;
            state.closed = true;
            state.shutdown_tx.take();
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
            if done_tx.send(()).is_err() {
                crate::report_channel_failure("server close completion");
            }
        });
        match done_rx.recv_timeout(std::time::Duration::from_secs(6)) {
            Ok(()) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                return Err(napi::Error::from_reason(
                    "E_INTERNAL: server close drain timeout".to_string(),
                ));
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                return Err(napi::Error::from_reason(
                    "E_INTERNAL: server close completion channel disconnected".to_string(),
                ));
            }
        }
        Ok(())
    }

    #[napi]
    pub fn metrics_snapshot(&self) -> Result<crate::metrics::ServerMetricsSnapshot> {
        panic_guard::catch_panic(|| Ok(self.metrics.snapshot()))
    }
}
