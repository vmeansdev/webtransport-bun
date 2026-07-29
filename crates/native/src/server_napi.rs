//! NAPI bindings for ServerHandle. Risk-module coverage floors target `server.rs` logic.
use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction};
use napi::{Env, JsFunction, Result};
use napi_derive::napi;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use crate::error::{from_reason as wt_from_reason, WtResult};
use crate::panic_guard;
use crate::server::{
    parse_tls_resolver_config, remove_sni_cert_state, replace_sni_certs_state, rotate_default_cert,
    rotate_tls_config, set_unknown_sni_policy_state, tls_snapshot_from_state,
    upsert_sni_cert_state, wait_for_server_drain, CloseDrainTiming, ServerRuntimeState,
};
use crate::server_metrics::ServerMetrics;
use crate::server_spawn::spawn_server_instance;
use crate::{LogEvent, SessionEvent};

static SERVER_ID_COUNTER: AtomicU64 = AtomicU64::new(1);

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
        server_opts_json: String,
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
            let server_opts: serde_json::Value =
                serde_json::from_str(&server_opts_json).unwrap_or(serde_json::Value::Null);
            let congestion_control = crate::client::parse_congestion_control(&server_opts)
                .map_err(napi::Error::from_reason)?;
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
            let (shutdown_tx, bound_port) = spawn_server_instance(
                server_id,
                Arc::clone(&metrics),
                &limits,
                &rate_limits,
                &host,
                port_u16,
                &session_tx,
                &log_tx,
                Arc::clone(&tls_resolver),
                congestion_control,
                debug,
                1,
            )
            .map_err(|msg| {
                napi::Error::from_reason(format!("E_INTERNAL: server startup failed: {}", msg))
            })?;

            Ok(Self {
                server_id,
                // Prefer OS-reported bind port so port:0 surfaces a real listen port to JS.
                port: u32::from(bound_port),
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
    use super::ServerHandle;
    use crate::server::ServerRuntimeState;
    use crate::server_metrics::ServerMetrics;
    use crate::server_tls::build_default_dev_resolver;
    use std::sync::Arc;
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
    fn server_opts_congestion_control_maps_to_expected_controllers() {
        use crate::client::{
            congestion_controller_label, parse_congestion_control, CongestionControlMode,
        };
        use serde_json::json;

        let cases = [
            (json!({}), CongestionControlMode::Default, "cubic"),
            (
                json!({ "congestionControl": "default" }),
                CongestionControlMode::Default,
                "cubic",
            ),
            (
                json!({ "congestionControl": "throughput" }),
                CongestionControlMode::Throughput,
                "bbr",
            ),
            (
                json!({ "congestionControl": "low-latency" }),
                CongestionControlMode::LowLatency,
                "new_reno",
            ),
        ];
        for (opts, expected_mode, expected_label) in cases {
            let mode = parse_congestion_control(&opts).expect("server opts should parse");
            assert_eq!(mode, expected_mode);
            assert_eq!(congestion_controller_label(mode), expected_label);
        }
    }

    #[test]
    fn server_opts_congestion_control_rejects_unknown_value() {
        use crate::client::parse_congestion_control;
        use serde_json::json;

        let err = parse_congestion_control(&json!({ "congestionControl": "warp-speed" }))
            .expect_err("unknown mode must be rejected");
        assert!(err.contains("E_INTERNAL"), "error must carry code: {err}");
    }
}
