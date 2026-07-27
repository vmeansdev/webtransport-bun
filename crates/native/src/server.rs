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

fn ensure_server_open(state: &ServerRuntimeState) -> Result<()> {
    if state.closed {
        return Err(napi::Error::from_reason(
            "E_SESSION_CLOSED: server is closed",
        ));
    }
    Ok(())
}

fn rotate_default_cert(
    state: &mut ServerRuntimeState,
    cert_pem: &str,
    key_pem: &str,
) -> Result<()> {
    ensure_server_open(state)?;
    let certified_key = crate::server_tls::parse_certified_key(cert_pem, key_pem).map_err(|e| {
        napi::Error::from_reason(format!("E_INTERNAL: certificate rotation failed: {}", e))
    })?;
    state
        .tls_resolver
        .replace_default(certified_key)
        .map_err(|e| napi::Error::from_reason(format!("E_INTERNAL: {}", e)))?;
    state.explicit_default_cert = true;
    Ok(())
}

fn rotate_tls_config(state: &mut ServerRuntimeState, tls_config_json: &str) -> Result<()> {
    ensure_server_open(state)?;
    let tls_config = parse_tls_resolver_config(tls_config_json)
        .map_err(|e| napi::Error::from_reason(format!("E_INTERNAL: tls rotation failed: {}", e)))?;
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
}

fn replace_sni_certs_state(state: &ServerRuntimeState, sni_json: &str) -> Result<()> {
    ensure_server_open(state)?;
    ensure_explicit_default_cert(state)?;
    let sni_certs = parse_sni_entries_json(sni_json)
        .map_err(|e| napi::Error::from_reason(format!("E_INTERNAL: tls rotation failed: {}", e)))?;
    let mut certs_by_name = std::collections::HashMap::new();
    let mut original_names_by_normalized = std::collections::HashMap::new();
    for sni_cert in sni_certs {
        let server_name =
            crate::server_tls::normalize_server_name(&sni_cert.server_name).map_err(|e| {
                napi::Error::from_reason(format!("E_INTERNAL: tls rotation failed: {}", e))
            })?;
        if let Some(existing_original) = original_names_by_normalized.get(&server_name) {
            return Err(napi::Error::from_reason(format!(
                "E_INTERNAL: tls rotation failed: duplicate serverName entry after normalization: \"{}\" conflicts with \"{}\" as \"{}\"",
                sni_cert.server_name, existing_original, server_name
            )));
        }
        let certified_key =
            crate::server_tls::parse_certified_key(&sni_cert.cert_pem, &sni_cert.key_pem).map_err(
                |e| napi::Error::from_reason(format!("E_INTERNAL: tls rotation failed: {}", e)),
            )?;
        original_names_by_normalized.insert(server_name.clone(), sni_cert.server_name);
        certs_by_name.insert(server_name, certified_key);
    }
    state
        .tls_resolver
        .replace_sni_certs(certs_by_name)
        .map_err(|e| napi::Error::from_reason(format!("E_INTERNAL: {}", e)))?;
    Ok(())
}

fn upsert_sni_cert_state(
    state: &ServerRuntimeState,
    server_name: &str,
    cert_pem: &str,
    key_pem: &str,
) -> Result<()> {
    ensure_server_open(state)?;
    ensure_explicit_default_cert(state)?;
    let certified_key = crate::server_tls::parse_certified_key(cert_pem, key_pem)
        .map_err(|e| napi::Error::from_reason(format!("E_INTERNAL: tls rotation failed: {}", e)))?;
    state
        .tls_resolver
        .upsert_sni_cert(server_name, certified_key)
        .map_err(|e| napi::Error::from_reason(format!("E_INTERNAL: {}", e)))?;
    Ok(())
}

fn remove_sni_cert_state(state: &ServerRuntimeState, server_name: &str) -> Result<()> {
    ensure_server_open(state)?;
    ensure_explicit_default_cert(state)?;
    let removed = state
        .tls_resolver
        .remove_sni_cert(server_name)
        .map_err(|e| napi::Error::from_reason(format!("E_INTERNAL: {}", e)))?;
    if !removed {
        return Err(napi::Error::from_reason(format!(
            "E_INTERNAL: tls rotation failed: unknown serverName entry: {}",
            server_name
        )));
    }
    Ok(())
}

fn set_unknown_sni_policy_state(state: &ServerRuntimeState, policy: &str) -> Result<()> {
    ensure_server_open(state)?;
    ensure_explicit_default_cert(state)?;
    let policy = parse_unknown_sni_policy(Some(policy))
        .map_err(|e| napi::Error::from_reason(format!("E_INTERNAL: tls rotation failed: {}", e)))?;
    state
        .tls_resolver
        .set_unknown_sni_policy(policy)
        .map_err(|e| napi::Error::from_reason(format!("E_INTERNAL: {}", e)))?;
    Ok(())
}

fn tls_snapshot_from_state(
    state: &ServerRuntimeState,
) -> Result<crate::metrics::ServerTlsSnapshot> {
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
pub(crate) fn spawn_server_instance(
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
    /// Test-only constructor that skips NAPI Env / JS callbacks.
    #[cfg(test)]
    pub(crate) fn for_test(
        server_id: u64,
        port: u32,
        metrics: Arc<ServerMetrics>,
        state: ServerRuntimeState,
    ) -> Self {
        Self {
            server_id,
            port,
            metrics,
            session_tx: Mutex::new(None),
            log_tx: Mutex::new(None),
            state: Mutex::new(state),
        }
    }

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
            rotate_default_cert(&mut state, &cert_pem, &key_pem)
        })
    }

    #[napi]
    pub async fn update_tls(&self, tls_config_json: String) -> Result<()> {
        panic_guard::catch_panic(|| {
            let mut state = self
                .state
                .lock()
                .map_err(|_| napi::Error::from_reason("E_INTERNAL: server state lock poisoned"))?;
            rotate_tls_config(&mut state, &tls_config_json)
        })
    }

    #[napi]
    pub async fn replace_sni_certs(&self, sni_json: String) -> Result<()> {
        panic_guard::catch_panic(|| {
            let state = self
                .state
                .lock()
                .map_err(|_| napi::Error::from_reason("E_INTERNAL: server state lock poisoned"))?;
            replace_sni_certs_state(&state, &sni_json)
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
            upsert_sni_cert_state(&state, &server_name, &cert_pem, &key_pem)
        })
    }

    #[napi]
    pub async fn remove_sni_cert(&self, server_name: String) -> Result<()> {
        panic_guard::catch_panic(|| {
            let state = self
                .state
                .lock()
                .map_err(|_| napi::Error::from_reason("E_INTERNAL: server state lock poisoned"))?;
            remove_sni_cert_state(&state, &server_name)
        })
    }

    #[napi]
    pub async fn set_unknown_sni_policy(&self, policy: String) -> Result<()> {
        panic_guard::catch_panic(|| {
            let state = self
                .state
                .lock()
                .map_err(|_| napi::Error::from_reason("E_INTERNAL: server state lock poisoned"))?;
            set_unknown_sni_policy_state(&state, &policy)
        })
    }

    #[napi]
    pub fn tls_snapshot(&self) -> WtResult<crate::metrics::ServerTlsSnapshot> {
        panic_guard::catch_panic(|| {
            let state = self
                .state
                .lock()
                .map_err(|_| napi::Error::from_reason("E_INTERNAL: server state lock poisoned"))?;
            tls_snapshot_from_state(&state)
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
    use super::{
        ensure_explicit_default_cert, is_addr_in_use_error, parse_sni_entries_json,
        parse_tls_resolver_config, parse_unknown_sni_policy, remove_sni_cert_state,
        replace_sni_certs_state, rotate_default_cert, rotate_tls_config,
        set_unknown_sni_policy_state, spawn_server_instance, tls_snapshot_from_state,
        upsert_sni_cert_state, wait_for_server_drain, CloseDrainTiming, ServerHandle,
        ServerRuntimeState,
    };
    use crate::limits::Limits;
    use crate::rate_limit::RateLimits;
    use crate::server_metrics::ServerMetrics;
    use crate::server_tls::{build_default_dev_resolver, UnknownSniPolicy};
    use std::sync::atomic::Ordering;
    use std::sync::Arc;
    use std::time::Duration;
    use tokio::sync::watch;

    fn self_signed_pem() -> (String, String) {
        let identity = wtransport::Identity::self_signed(["localhost"]).expect("identity");
        let cert_pem = identity
            .certificate_chain()
            .as_slice()
            .iter()
            .map(wtransport::tls::Certificate::to_pem)
            .collect::<Vec<_>>()
            .join("");
        let key_pem = identity.private_key().to_secret_pem();
        (cert_pem, key_pem)
    }

    fn open_state(explicit_default_cert: bool) -> ServerRuntimeState {
        ServerRuntimeState {
            shutdown_tx: None,
            tls_resolver: build_default_dev_resolver().expect("dev resolver"),
            explicit_default_cert,
            closed: false,
        }
    }

    #[test]
    fn parse_unknown_sni_policy_defaults_and_rejects_unknown() {
        assert!(matches!(
            parse_unknown_sni_policy(None).unwrap(),
            UnknownSniPolicy::Reject
        ));
        assert!(matches!(
            parse_unknown_sni_policy(Some("reject")).unwrap(),
            UnknownSniPolicy::Reject
        ));
        assert!(matches!(
            parse_unknown_sni_policy(Some("default")).unwrap(),
            UnknownSniPolicy::Default
        ));
        let err = parse_unknown_sni_policy(Some("allow")).unwrap_err();
        assert!(err.contains("unknownSniPolicy"));
        assert!(err.contains("allow"));
    }

    #[test]
    fn parse_tls_resolver_config_accepts_default_only_and_rejects_bad_shapes() {
        let ok = parse_tls_resolver_config(
            r#"{"certPem":"CERT","keyPem":"KEY","sni":[],"unknownSniPolicy":"reject"}"#,
        )
        .unwrap();
        assert_eq!(ok.default_cert_pem, "CERT");
        assert_eq!(ok.default_key_pem, "KEY");
        assert!(ok.sni_certs.is_empty());
        assert!(matches!(ok.unknown_sni_policy, UnknownSniPolicy::Reject));

        let with_sni = parse_tls_resolver_config(
            r#"{"certPem":"CERT","keyPem":"KEY","sni":[{"serverName":"a.example","certPem":"C2","keyPem":"K2"}],"unknownSniPolicy":"default"}"#,
        )
        .unwrap();
        assert_eq!(with_sni.sni_certs.len(), 1);
        assert_eq!(with_sni.sni_certs[0].server_name, "a.example");
        assert!(matches!(
            with_sni.unknown_sni_policy,
            UnknownSniPolicy::Default
        ));

        let ca_err =
            parse_tls_resolver_config(r#"{"certPem":"CERT","keyPem":"KEY","caPem":"CA","sni":[]}"#)
                .unwrap_err();
        assert!(ca_err.contains("caPem is not supported"));

        let sni_without_default = parse_tls_resolver_config(
            r#"{"certPem":"","keyPem":"","sni":[{"serverName":"a.example","certPem":"C2","keyPem":"K2"}]}"#,
        )
        .unwrap_err();
        assert!(sni_without_default.contains("require non-empty default certPem/keyPem"));

        let bad_json = parse_tls_resolver_config("{not-json").unwrap_err();
        assert!(bad_json.contains("invalid server tls JSON"));
    }

    #[test]
    fn parse_sni_entries_json_round_trips_entries() {
        let entries = parse_sni_entries_json(
            r#"[{"serverName":"one.example","certPem":"C1","keyPem":"K1"},{"serverName":"two.example","certPem":"C2","keyPem":"K2"}]"#,
        )
        .unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].server_name, "one.example");
        assert_eq!(entries[1].key_pem, "K2");

        let err = parse_sni_entries_json("null").unwrap_err();
        assert!(err.contains("invalid server SNI JSON"));
    }

    #[test]
    fn is_addr_in_use_error_matches_common_os_phrasing() {
        assert!(is_addr_in_use_error("Address already in use (os error 48)"));
        assert!(is_addr_in_use_error("bind: AddrInUse"));
        assert!(!is_addr_in_use_error("connection refused"));
    }

    #[test]
    fn ensure_explicit_default_cert_requires_non_empty_default() {
        let (shutdown_tx, _shutdown_rx) = watch::channel(());
        // Gate only checks the explicit_default_cert flag; resolver is unused.
        let resolver = build_default_dev_resolver().expect("dev resolver");
        let missing = ServerRuntimeState {
            shutdown_tx: Some(shutdown_tx),
            tls_resolver: Arc::clone(&resolver),
            explicit_default_cert: false,
            closed: false,
        };
        let err = ensure_explicit_default_cert(&missing).unwrap_err();
        assert!(err.reason.contains("SNI management requires"));

        let present = ServerRuntimeState {
            shutdown_tx: None,
            tls_resolver: resolver,
            explicit_default_cert: true,
            closed: false,
        };
        assert!(ensure_explicit_default_cert(&present).is_ok());
    }

    #[test]
    fn tls_rotation_helpers_manage_sni_and_reject_closed_server() {
        let (cert_pem, key_pem) = self_signed_pem();
        let mut state = open_state(false);

        rotate_default_cert(&mut state, &cert_pem, &key_pem).expect("rotate default");
        assert!(state.explicit_default_cert);

        let tls_json = format!(
            r#"{{"certPem":{},"keyPem":{},"sni":[],"unknownSniPolicy":"default"}}"#,
            serde_json::to_string(&cert_pem).unwrap(),
            serde_json::to_string(&key_pem).unwrap()
        );
        rotate_tls_config(&mut state, &tls_json).expect("rotate tls");

        let sni_json = format!(
            r#"[{{"serverName":"a.example","certPem":{},"keyPem":{}}},{{"serverName":"b.example","certPem":{},"keyPem":{}}}]"#,
            serde_json::to_string(&cert_pem).unwrap(),
            serde_json::to_string(&key_pem).unwrap(),
            serde_json::to_string(&cert_pem).unwrap(),
            serde_json::to_string(&key_pem).unwrap()
        );
        replace_sni_certs_state(&state, &sni_json).expect("replace sni");
        upsert_sni_cert_state(&state, "c.example", &cert_pem, &key_pem).expect("upsert");
        set_unknown_sni_policy_state(&state, "reject").expect("policy");
        let snap = tls_snapshot_from_state(&state).expect("snapshot");
        assert!(snap.sni_server_names.contains(&"a.example".to_string()));
        assert!(snap.sni_server_names.contains(&"c.example".to_string()));
        assert_eq!(snap.unknown_sni_policy, "reject");
        remove_sni_cert_state(&state, "a.example").expect("remove");
        let err = remove_sni_cert_state(&state, "missing.example").unwrap_err();
        assert!(err.reason.contains("unknown serverName"));

        state.closed = true;
        let closed = rotate_default_cert(&mut state, &cert_pem, &key_pem).unwrap_err();
        assert!(closed.reason.contains("E_SESSION_CLOSED"));
    }

    #[test]
    fn replace_sni_without_explicit_default_is_rejected() {
        let (cert_pem, key_pem) = self_signed_pem();
        let state = open_state(false);
        let sni_json = format!(
            r#"[{{"serverName":"a.example","certPem":{},"keyPem":{}}}]"#,
            serde_json::to_string(&cert_pem).unwrap(),
            serde_json::to_string(&key_pem).unwrap()
        );
        let err = replace_sni_certs_state(&state, &sni_json).unwrap_err();
        assert!(err.reason.contains("SNI management requires"));
    }

    #[test]
    fn spawn_server_instance_binds_ephemeral_port_and_shuts_down() {
        let server_id = u64::MAX - 20;
        let metrics = Arc::new(ServerMetrics::default());
        let limits = Limits::default();
        let rate_limits = RateLimits::default();
        let resolver = build_default_dev_resolver().expect("dev resolver");
        // Bind an ephemeral UDP port first so we don't collide with CI siblings.
        let probe = std::net::UdpSocket::bind("127.0.0.1:0").expect("probe bind");
        let port = probe.local_addr().expect("local addr").port();
        drop(probe);

        let shutdown_tx = spawn_server_instance(
            server_id,
            Arc::clone(&metrics),
            &limits,
            &rate_limits,
            "127.0.0.1",
            port,
            &None,
            &None,
            resolver,
            false,
            3,
        )
        .expect("server should start");
        let _ = shutdown_tx.send(());
        // Drain must observe idle after shutdown signal (no sessions accepted).
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("rt");
        let drain = rt.block_on(wait_for_server_drain(
            &metrics,
            server_id,
            CloseDrainTiming {
                grace_period: Duration::from_millis(500),
                abort_period: Duration::from_millis(200),
                poll_interval: Duration::from_millis(10),
            },
        ));
        assert!(drain.is_none(), "unexpected drain diagnostic: {drain:?}");
    }

    #[test]
    fn spawn_server_instance_reports_addr_in_use() {
        let held = std::net::UdpSocket::bind("127.0.0.1:0").expect("hold port");
        let port = held.local_addr().expect("addr").port();
        let server_id = u64::MAX - 21;
        let metrics = Arc::new(ServerMetrics::default());
        let err = spawn_server_instance(
            server_id,
            metrics,
            &Limits::default(),
            &RateLimits::default(),
            "127.0.0.1",
            port,
            &None,
            &None,
            build_default_dev_resolver().expect("dev resolver"),
            false,
            1,
        )
        .expect_err("port held by UDP socket should fail QUIC bind");
        assert!(
            is_addr_in_use_error(&err) || err.contains("failed to create endpoint"),
            "unexpected bind error: {err}"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn server_handle_for_test_covers_tls_close_and_snapshots() {
        let (cert_pem, key_pem) = self_signed_pem();
        let server_id = u64::MAX - 31;
        let metrics = Arc::new(ServerMetrics::default());
        let (shutdown_tx, _shutdown_rx) = watch::channel(());
        let handle = ServerHandle::for_test(
            server_id,
            9,
            Arc::clone(&metrics),
            ServerRuntimeState {
                shutdown_tx: Some(shutdown_tx),
                tls_resolver: build_default_dev_resolver().expect("resolver"),
                explicit_default_cert: true,
                closed: false,
            },
        );
        assert_eq!(handle.port(), 9);
        handle
            .update_cert(cert_pem.clone(), key_pem.clone())
            .await
            .expect("update_cert");
        let tls_json = format!(
            r#"{{"certPem":{},"keyPem":{},"sni":[],"unknownSniPolicy":"reject"}}"#,
            serde_json::to_string(&cert_pem).unwrap(),
            serde_json::to_string(&key_pem).unwrap()
        );
        handle.update_tls(tls_json).await.expect("update_tls");
        let sni_json = format!(
            r#"[{{"serverName":"x.example","certPem":{},"keyPem":{}}}]"#,
            serde_json::to_string(&cert_pem).unwrap(),
            serde_json::to_string(&key_pem).unwrap()
        );
        handle
            .replace_sni_certs(sni_json)
            .await
            .expect("replace_sni");
        handle
            .upsert_sni_cert("y.example".into(), cert_pem.clone(), key_pem.clone())
            .await
            .expect("upsert");
        handle
            .set_unknown_sni_policy("default".into())
            .await
            .expect("policy");
        let snap = handle.tls_snapshot().expect("tls snap");
        assert!(snap.sni_server_names.contains(&"x.example".to_string()));
        assert_eq!(snap.unknown_sni_policy, "default");
        handle
            .remove_sni_cert("x.example".into())
            .await
            .expect("remove");
        let _ = handle.metrics_snapshot().expect("metrics");
        handle.close().await.expect("close");
    }

    #[test]
    fn close_drain_timing_production_values_are_stable() {
        let timing = CloseDrainTiming::production();
        assert_eq!(timing.grace_period, Duration::from_secs(5));
        assert_eq!(timing.abort_period, Duration::from_secs(5));
        assert_eq!(timing.poll_interval, Duration::from_millis(50));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn wait_for_server_drain_returns_immediately_when_already_idle() {
        let server_id = u64::MAX - 2;
        let metrics = ServerMetrics::default();
        let result = wait_for_server_drain(
            &metrics,
            server_id,
            CloseDrainTiming {
                grace_period: Duration::from_secs(5),
                abort_period: Duration::from_secs(5),
                poll_interval: Duration::from_millis(50),
            },
        )
        .await;
        assert!(result.is_none());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn wait_for_server_drain_clears_when_gauges_drop_during_grace() {
        let server_id = u64::MAX - 3;
        let metrics = Arc::new(ServerMetrics::default());
        metrics.sessions_active.store(1, Ordering::SeqCst);
        let metrics_c = Arc::clone(&metrics);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(15)).await;
            metrics_c.sessions_active.store(0, Ordering::SeqCst);
        });
        let result = wait_for_server_drain(
            &metrics,
            server_id,
            CloseDrainTiming {
                grace_period: Duration::from_millis(200),
                abort_period: Duration::from_millis(200),
                poll_interval: Duration::from_millis(5),
            },
        )
        .await;
        assert!(result.is_none());
    }

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
