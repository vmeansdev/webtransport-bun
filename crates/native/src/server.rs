//! WebTransport server via wtransport. Updates ServerMetrics for Phase 4.3.1.

use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction};
use napi::{Env, JsFunction, Result};
use napi_derive::napi;
use serde::Deserialize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::watch;

use crate::error::{from_reason as wt_from_reason, WtResult};
use crate::limits::Limits;
use crate::panic_guard;
use crate::rate_limit::RateLimits;
use crate::server_metrics::ServerMetrics;
use crate::{LogEvent, SessionEvent};

static SERVER_ID_COUNTER: AtomicU64 = AtomicU64::new(1);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServerTlsSniEntry {
    server_name: String,
    cert_pem: String,
    key_pem: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServerTlsConfigInput {
    cert_pem: String,
    key_pem: String,
    #[serde(default)]
    ca_pem: String,
    #[serde(default)]
    sni: Vec<ServerTlsSniEntry>,
    #[serde(default)]
    unknown_sni_policy: Option<String>,
}

fn parse_unknown_sni_policy(
    value: Option<&str>,
) -> std::result::Result<crate::server_tls::UnknownSniPolicy, String> {
    match value.unwrap_or("reject") {
        "reject" => Ok(crate::server_tls::UnknownSniPolicy::Reject),
        "default" => Ok(crate::server_tls::UnknownSniPolicy::Default),
        other => Err(format!(
            "unknownSniPolicy must be \"reject\" or \"default\", got \"{}\"",
            other
        )),
    }
}

fn parse_tls_resolver_config(
    tls_config_json: &str,
) -> std::result::Result<crate::server_tls::ResolverConfig, String> {
    let input: ServerTlsConfigInput = serde_json::from_str(tls_config_json)
        .map_err(|e| format!("invalid server tls JSON: {}", e))?;
    if !input.ca_pem.trim().is_empty() {
        return Err("server tls.caPem is not supported yet".to_string());
    }
    if (input.cert_pem.trim().is_empty() || input.key_pem.trim().is_empty())
        && (!input.sni.is_empty() || input.unknown_sni_policy.is_some())
    {
        return Err(
            "server tls.sni and unknownSniPolicy require non-empty default certPem/keyPem"
                .to_string(),
        );
    }
    Ok(crate::server_tls::ResolverConfig {
        default_cert_pem: input.cert_pem,
        default_key_pem: input.key_pem,
        sni_certs: input
            .sni
            .into_iter()
            .map(|entry| crate::server_tls::SniCertConfig {
                server_name: entry.server_name,
                cert_pem: entry.cert_pem,
                key_pem: entry.key_pem,
            })
            .collect(),
        unknown_sni_policy: parse_unknown_sni_policy(input.unknown_sni_policy.as_deref())?,
    })
}

fn parse_sni_entries_json(
    sni_json: &str,
) -> std::result::Result<Vec<crate::server_tls::SniCertConfig>, String> {
    let entries: Vec<ServerTlsSniEntry> =
        serde_json::from_str(sni_json).map_err(|e| format!("invalid server SNI JSON: {}", e))?;
    Ok(entries
        .into_iter()
        .map(|entry| crate::server_tls::SniCertConfig {
            server_name: entry.server_name,
            cert_pem: entry.cert_pem,
            key_pem: entry.key_pem,
        })
        .collect())
}

struct ServerRuntimeState {
    shutdown_tx: Option<watch::Sender<()>>,
    tls_resolver: Arc<crate::server_tls::LiveServerCertResolver>,
    explicit_default_cert: bool,
    closed: bool,
}

fn ensure_explicit_default_cert(state: &ServerRuntimeState) -> Result<()> {
    if state.explicit_default_cert {
        return Ok(());
    }
    Err(napi::Error::from_reason(
        "E_INTERNAL: tls rotation failed: SNI management requires a non-empty default certPem/keyPem",
    ))
}

fn is_addr_in_use_error(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("address already in use") || lower.contains("addrinuse")
}

#[derive(Clone, Copy)]
struct CloseDrainTiming {
    grace_period: Duration,
    abort_period: Duration,
    poll_interval: Duration,
}

impl CloseDrainTiming {
    const fn production() -> Self {
        Self {
            grace_period: Duration::from_secs(5),
            abort_period: Duration::from_secs(5),
            poll_interval: Duration::from_millis(50),
        }
    }
}

async fn wait_for_server_drain(
    metrics: &ServerMetrics,
    server_id: u64,
    timing: CloseDrainTiming,
) -> Option<String> {
    let mut aborted_tasks = 0usize;
    let mut abort_attempted = false;
    let mut phase_deadline = tokio::time::Instant::now() + timing.grace_period;
    loop {
        let session_tasks = metrics.session_tasks_active.load(Ordering::Relaxed);
        let stream_tasks = metrics.stream_tasks_active.load(Ordering::Relaxed);
        let sessions_active = metrics.sessions_active.load(Ordering::SeqCst);
        let tracked_tasks = crate::spawn_tracked::server_task_count(server_id);
        if session_tasks == 0 && stream_tasks == 0 && sessions_active == 0 && tracked_tasks == 0 {
            return None;
        }

        let now = tokio::time::Instant::now();
        if now >= phase_deadline {
            if !abort_attempted {
                aborted_tasks = crate::spawn_tracked::abort_server_tasks(server_id);
                crate::session_registry::close_all_for_owner(server_id, 0, b"server closing");
                abort_attempted = true;
                phase_deadline = now + timing.abort_period;
            } else {
                return Some(format!(
                    "E_BACKPRESSURE_TIMEOUT: server close abort timed out sessionsActive={} sessionTasksActive={} streamTasksActive={} trackedTasksActive={} abortedTasks={}",
                    sessions_active,
                    session_tasks,
                    stream_tasks,
                    tracked_tasks,
                    aborted_tasks,
                ));
            }
        }
        tokio::time::sleep(timing.poll_interval).await;
    }
}

#[allow(clippy::too_many_arguments)]
fn spawn_server_instance(
    server_id: u64,
    metrics: Arc<ServerMetrics>,
    limits: &Limits,
    rate_limits: &RateLimits,
    host: &str,
    port: u16,
    session_tx: &Option<tokio::sync::mpsc::Sender<SessionEvent>>,
    log_tx: &Option<tokio::sync::mpsc::Sender<LogEvent>>,
    tls_resolver: Arc<crate::server_tls::LiveServerCertResolver>,
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
            server_id,
            Arc::clone(&metrics),
            limits.clone(),
            rate_limits.clone(),
            host.to_string(),
            port,
            shutdown_rx,
            session_tx.clone(),
            log_tx.clone(),
            Arc::clone(&tls_resolver),
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
    server_id: u64,
    port: u32,
    metrics: Arc<ServerMetrics>,
    session_tx: Mutex<Option<tokio::sync::mpsc::Sender<SessionEvent>>>,
    log_tx: Mutex<Option<tokio::sync::mpsc::Sender<LogEvent>>>,
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
        tls_config_json: String,
        _limits_json: String,
        _rate_limits_json: String,
        on_session: JsFunction,
        log_fn: JsFunction,
    ) -> Result<Self> {
        panic_guard::catch_panic(|| {
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

            let server_id = SERVER_ID_COUNTER.fetch_add(1, Ordering::Relaxed);
            let tls_config = parse_tls_resolver_config(&tls_config_json)
                .map_err(|msg| napi::Error::from_reason(format!("E_TLS: {}", msg)))?;
            let tls_resolver = if !tls_config.default_cert_pem.trim().is_empty()
                && !tls_config.default_key_pem.trim().is_empty()
            {
                crate::server_tls::build_live_resolver_from_config(&tls_config)
            } else {
                crate::server_tls::build_default_dev_resolver()
            }
            .map_err(|msg| napi::Error::from_reason(format!("E_TLS: {}", msg)))?;
            let shutdown_tx = spawn_server_instance(
                server_id,
                Arc::clone(&metrics),
                &limits,
                &rate_limits,
                &host,
                port_u16,
                &session_tx,
                &log_tx,
                Arc::clone(&tls_resolver),
                debug,
                1,
            )
            .map_err(|msg| {
                napi::Error::from_reason(format!("E_INTERNAL: server startup failed: {}", msg))
            })?;

            Ok(Self {
                server_id,
                port,
                metrics,
                session_tx: Mutex::new(session_tx),
                log_tx: Mutex::new(log_tx),
                state: Mutex::new(ServerRuntimeState {
                    shutdown_tx: Some(shutdown_tx),
                    tls_resolver,
                    explicit_default_cert: !tls_config.default_cert_pem.trim().is_empty()
                        && !tls_config.default_key_pem.trim().is_empty(),
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
            let certified_key = crate::server_tls::parse_certified_key(&cert_pem, &key_pem)
                .map_err(|e| {
                    napi::Error::from_reason(format!(
                        "E_INTERNAL: certificate rotation failed: {}",
                        e
                    ))
                })?;
            state
                .tls_resolver
                .replace_default(certified_key)
                .map_err(|e| napi::Error::from_reason(format!("E_INTERNAL: {}", e)))?;
            state.explicit_default_cert = true;
            Ok(())
        })
    }

    #[napi]
    pub async fn update_tls(&self, tls_config_json: String) -> Result<()> {
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
            let tls_config = parse_tls_resolver_config(&tls_config_json).map_err(|e| {
                napi::Error::from_reason(format!("E_INTERNAL: tls rotation failed: {}", e))
            })?;
            let (default_cert, certs_by_name, unknown_sni_policy) =
                crate::server_tls::parse_resolver_config(&tls_config).map_err(|e| {
                    napi::Error::from_reason(format!("E_INTERNAL: tls rotation failed: {}", e))
                })?;
            state
                .tls_resolver
                .replace_all(default_cert, certs_by_name, unknown_sni_policy)
                .map_err(|e| napi::Error::from_reason(format!("E_INTERNAL: {}", e)))?;
            state.explicit_default_cert = true;
            Ok(())
        })
    }

    #[napi]
    pub async fn replace_sni_certs(&self, sni_json: String) -> Result<()> {
        panic_guard::catch_panic(|| {
            let state = self
                .state
                .lock()
                .map_err(|_| napi::Error::from_reason("E_INTERNAL: server state lock poisoned"))?;
            if state.closed {
                return Err(napi::Error::from_reason(
                    "E_SESSION_CLOSED: server is closed",
                ));
            }
            ensure_explicit_default_cert(&state)?;
            let sni_certs = parse_sni_entries_json(&sni_json).map_err(|e| {
                napi::Error::from_reason(format!("E_INTERNAL: tls rotation failed: {}", e))
            })?;
            let mut certs_by_name = std::collections::HashMap::new();
            let mut original_names_by_normalized = std::collections::HashMap::new();
            for sni_cert in sni_certs {
                let server_name = crate::server_tls::normalize_server_name(&sni_cert.server_name)
                    .map_err(|e| {
                    napi::Error::from_reason(format!("E_INTERNAL: tls rotation failed: {}", e))
                })?;
                if let Some(existing_original) = original_names_by_normalized.get(&server_name) {
                    return Err(napi::Error::from_reason(format!(
                        "E_INTERNAL: tls rotation failed: duplicate serverName entry after normalization: \"{}\" conflicts with \"{}\" as \"{}\"",
                        sni_cert.server_name, existing_original, server_name
                    )));
                }
                let certified_key =
                    crate::server_tls::parse_certified_key(&sni_cert.cert_pem, &sni_cert.key_pem)
                        .map_err(|e| {
                        napi::Error::from_reason(format!("E_INTERNAL: tls rotation failed: {}", e))
                    })?;
                original_names_by_normalized.insert(server_name.clone(), sni_cert.server_name);
                certs_by_name.insert(server_name, certified_key);
            }
            state
                .tls_resolver
                .replace_sni_certs(certs_by_name)
                .map_err(|e| napi::Error::from_reason(format!("E_INTERNAL: {}", e)))?;
            Ok(())
        })
    }

    #[napi]
    pub async fn upsert_sni_cert(
        &self,
        server_name: String,
        cert_pem: String,
        key_pem: String,
    ) -> Result<()> {
        panic_guard::catch_panic(|| {
            let state = self
                .state
                .lock()
                .map_err(|_| napi::Error::from_reason("E_INTERNAL: server state lock poisoned"))?;
            if state.closed {
                return Err(napi::Error::from_reason(
                    "E_SESSION_CLOSED: server is closed",
                ));
            }
            ensure_explicit_default_cert(&state)?;
            let certified_key = crate::server_tls::parse_certified_key(&cert_pem, &key_pem)
                .map_err(|e| {
                    napi::Error::from_reason(format!("E_INTERNAL: tls rotation failed: {}", e))
                })?;
            state
                .tls_resolver
                .upsert_sni_cert(&server_name, certified_key)
                .map_err(|e| napi::Error::from_reason(format!("E_INTERNAL: {}", e)))?;
            Ok(())
        })
    }

    #[napi]
    pub async fn remove_sni_cert(&self, server_name: String) -> Result<()> {
        panic_guard::catch_panic(|| {
            let state = self
                .state
                .lock()
                .map_err(|_| napi::Error::from_reason("E_INTERNAL: server state lock poisoned"))?;
            if state.closed {
                return Err(napi::Error::from_reason(
                    "E_SESSION_CLOSED: server is closed",
                ));
            }
            ensure_explicit_default_cert(&state)?;
            let removed = state
                .tls_resolver
                .remove_sni_cert(&server_name)
                .map_err(|e| napi::Error::from_reason(format!("E_INTERNAL: {}", e)))?;
            if !removed {
                return Err(napi::Error::from_reason(format!(
                    "E_INTERNAL: tls rotation failed: unknown serverName entry: {}",
                    server_name
                )));
            }
            Ok(())
        })
    }

    #[napi]
    pub async fn set_unknown_sni_policy(&self, policy: String) -> Result<()> {
        panic_guard::catch_panic(|| {
            let state = self
                .state
                .lock()
                .map_err(|_| napi::Error::from_reason("E_INTERNAL: server state lock poisoned"))?;
            if state.closed {
                return Err(napi::Error::from_reason(
                    "E_SESSION_CLOSED: server is closed",
                ));
            }
            ensure_explicit_default_cert(&state)?;
            let policy = parse_unknown_sni_policy(Some(policy.as_str())).map_err(|e| {
                napi::Error::from_reason(format!("E_INTERNAL: tls rotation failed: {}", e))
            })?;
            state
                .tls_resolver
                .set_unknown_sni_policy(policy)
                .map_err(|e| napi::Error::from_reason(format!("E_INTERNAL: {}", e)))?;
            Ok(())
        })
    }

    #[napi]
    pub fn tls_snapshot(&self) -> WtResult<crate::metrics::ServerTlsSnapshot> {
        panic_guard::catch_panic(|| {
            let state = self
                .state
                .lock()
                .map_err(|_| napi::Error::from_reason("E_INTERNAL: server state lock poisoned"))?;
            let snapshot = state
                .tls_resolver
                .tls_snapshot()
                .map_err(|e| napi::Error::from_reason(format!("E_INTERNAL: {}", e)))?;
            Ok(crate::metrics::ServerTlsSnapshot {
                sni_server_names: snapshot.sni_server_names,
                unknown_sni_policy: match snapshot.unknown_sni_policy {
                    crate::server_tls::UnknownSniPolicy::Reject => "reject".to_string(),
                    crate::server_tls::UnknownSniPolicy::Default => "default".to_string(),
                },
            })
        })
        .map_err(wt_from_reason)
    }

    #[napi]
    pub async fn close(&self) -> Result<()> {
        panic_guard::catch_panic(|| {
            let mut state = self
                .state
                .lock()
                .map_err(|_| napi::Error::from_reason("E_INTERNAL: server state lock poisoned"))?;
            state.closed = true;
            if let Some(tx) = state.shutdown_tx.take() {
                let _ = tx.send(());
            }
            crate::rate_limit::cleanup_server_entries(self.server_id);
            crate::session_registry::close_all_for_owner(self.server_id, 0, b"server closing");
            self.session_tx
                .lock()
                .map_err(|_| napi::Error::from_reason("E_INTERNAL: session tx lock poisoned"))?
                .take();
            self.log_tx
                .lock()
                .map_err(|_| napi::Error::from_reason("E_INTERNAL: log tx lock poisoned"))?
                .take();
            Ok(())
        })?;
        let metrics = Arc::clone(&self.metrics);
        let close_err =
            wait_for_server_drain(&metrics, self.server_id, CloseDrainTiming::production()).await;
        if let Some(msg) = close_err {
            return Err(napi::Error::from_reason(msg));
        }
        Ok(())
    }

    #[napi]
    pub fn metrics_snapshot(&self) -> WtResult<crate::metrics::ServerMetricsSnapshot> {
        panic_guard::catch_panic(|| {
            let state = self
                .state
                .lock()
                .map_err(|_| napi::Error::from_reason("E_INTERNAL: server state lock poisoned"))?;
            Ok(self
                .metrics
                .snapshot(Some(state.tls_resolver.metrics_snapshot())))
        })
        .map_err(wt_from_reason)
    }
}

#[cfg(test)]
mod tests {
    use super::{wait_for_server_drain, CloseDrainTiming};
    use crate::server_metrics::ServerMetrics;
    use std::sync::atomic::Ordering;
    use std::time::Duration;

    #[tokio::test(flavor = "current_thread")]
    async fn stale_gauges_without_tracked_tasks_time_out_after_abort_phase() {
        let server_id = u64::MAX - 1;
        let metrics = ServerMetrics::default();
        metrics.session_tasks_active.store(1, Ordering::Relaxed);
        metrics.stream_tasks_active.store(2, Ordering::Relaxed);
        metrics.sessions_active.store(3, Ordering::Relaxed);
        assert_eq!(crate::spawn_tracked::server_task_count(server_id), 0);

        let result = tokio::time::timeout(
            Duration::from_millis(100),
            wait_for_server_drain(
                &metrics,
                server_id,
                CloseDrainTiming {
                    grace_period: Duration::ZERO,
                    abort_period: Duration::ZERO,
                    poll_interval: Duration::from_millis(1),
                },
            ),
        )
        .await
        .expect("close drain must have a bounded abort phase")
        .expect("stale gauges must return a stable timeout diagnostic");

        assert!(result.starts_with("E_BACKPRESSURE_TIMEOUT:"));
        assert!(result.contains("sessionsActive=3"));
        assert!(result.contains("sessionTasksActive=1"));
        assert!(result.contains("streamTasksActive=2"));
        assert!(result.contains("trackedTasksActive=0"));
        assert!(result.contains("abortedTasks=0"));
    }
}
