//! NAPI bindings for ServerHandle. Risk-module coverage floors target `server.rs` logic.
use napi::bindgen_prelude::Uint8Array;
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
            let enable_0rtt = server_opts
                .get("enable0Rtt")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            // Replay-safety opt-out: surface 0-RTT sessions before the
            // handshake is confirmed. Off by default (session establishment
            // is the replayable unit).
            let allow_early_session = server_opts
                .get("allowEarlySession")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            // QPACK dynamic-table capacity to advertise (0 = static-only default).
            let qpack_max_table_capacity =
                crate::client::parse_qpack_max_table_capacity(&server_opts)
                    .map_err(napi::Error::from_reason)?;
            // SO_REUSEPORT on the bind socket. Kernel steering is 4-tuple
            // hashed, so this is for eBPF-steered and bench topologies, not a
            // general balancing answer (docs/OPERATIONS.md).
            let reuse_port = server_opts
                .get("reusePort")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            if reuse_port && !crate::server_spawn::reuse_port_supported() {
                return Err(napi::Error::from_reason(format!(
                    "E_UNSUPPORTED_ARGUMENT: {}",
                    crate::server_spawn::REUSE_PORT_UNSUPPORTED
                )));
            }
            // QUIC-LB connection IDs: this instance's server ID in the clear so
            // an L4 balancer routes by CID rather than by 4-tuple. Absent leaves
            // quinn's default CIDs (docs/OPERATIONS.md).
            let quic_lb = crate::quic_lb::parse_quic_lb_options(&server_opts)
                .map_err(|msg| napi::Error::from_reason(format!("E_INVALID_ARGUMENT: {}", msg)))?;
            // CID steering for the reuseport group. Steering without reusePort
            // has no group to steer, and steering without quicLb is 100%
            // hash-fallback while looking configured — both are refused rather
            // than half-honored.
            let steering = crate::reuseport_steering::parse_steering_options(&server_opts)
                .map_err(|msg| napi::Error::from_reason(format!("E_INVALID_ARGUMENT: {}", msg)))?;
            if steering.is_some() {
                if !crate::reuseport_steering::steering_supported() {
                    return Err(napi::Error::from_reason(format!(
                        "E_UNSUPPORTED_ARGUMENT: {}",
                        crate::reuseport_steering::STEERING_UNSUPPORTED
                    )));
                }
                if !reuse_port {
                    return Err(napi::Error::from_reason(
                        "E_INVALID_ARGUMENT: reusePortSteering requires reusePort: true"
                            .to_string(),
                    ));
                }
                if quic_lb.is_none() {
                    return Err(napi::Error::from_reason(
                        "E_INVALID_ARGUMENT: reusePortSteering requires quicLb — \
                         without QUIC-LB CIDs every packet falls back to the \
                         kernel hash and the steering program steers nothing"
                            .to_string(),
                    ));
                }
            }
            let limits = crate::limits::Limits::from_json(&_limits_json);
            let rate_limits = crate::rate_limit::RateLimits::from_json(&_rate_limits_json);
            crate::panic_guard::set_panic_log_verbose(debug);
            let port_u16 = port.min(65535) as u16;
            if reuse_port && port_u16 == 0 {
                return Err(napi::Error::from_reason(
                    "E_INVALID_ARGUMENT: reusePort requires an explicit port; \
                     port 0 asks the OS for a fresh ephemeral port per instance, \
                     so nothing shares a port"
                        .to_string(),
                ));
            }

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
                enable_0rtt,
                allow_early_session,
                qpack_max_table_capacity,
                crate::server_spawn::BindOptions {
                    reuse_port,
                    quic_lb,
                    steering,
                },
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
            crate::datagram_reflector::clear_owner(self.server_id);
            crate::session_registry::close_all_for_owner(
                self.server_id,
                crate::SERVER_CLOSING_CLOSE_CODE,
                crate::SERVER_CLOSING_CLOSE_REASON.as_bytes(),
            );
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

    /// Send one payload to many of this server's sessions across one crossing.
    ///
    /// Synchronous and promise-free, because it is the fan-out of
    /// `trySendDatagram` rather than of `sendDatagram`: one N-API promise costs
    /// more than the whole fan-out below ~1,000 targets, a serial parking
    /// fan-out would let one slow subscriber hold the rest, a concurrent one
    /// would allocate N futures, and either would take a ThreadsafeFunction —
    /// the host-loop reference the non-parking send exists to avoid — per
    /// broadcast.
    ///
    /// Returns `{sent, failed, codes}` and never throws for a transport
    /// condition. `failed` holds indices into `targets` and `codes` is parallel
    /// to it, so a healthy broadcast to 10,000 subscribers allocates nothing to
    /// report that nothing failed. A missing, closed or foreign-owned target is
    /// a failure entry, never an exception: at this scale reaping is normal and
    /// the failure list *is* the reap list.
    ///
    /// Targets past `DATAGRAM_MIRROR_MAX` are reported as failures rather than
    /// attempted or dropped; the TypeScript wrapper throws `RangeError` before
    /// the crossing, so only a raw-addon caller ever sees that code.
    #[napi(js_name = "sendDatagramMirror")]
    pub fn send_datagram_mirror(
        &self,
        targets: Vec<String>,
        payload: Uint8Array,
    ) -> crate::datagram_mirror::DatagramMirrorResult {
        // Copied once, before the loop, and shared by reference with every
        // target: N copies out of JS become one. The call is synchronous, so
        // the caller cannot mutate its array before this returns — the copy
        // makes that a contract rather than an accident of the current shape.
        let payload = payload.as_ref().to_vec();
        crate::session::send_datagram_mirror_for_owner(
            self.server_id,
            &targets,
            &payload,
            &self.metrics,
        )
        .into_napi()
    }

    /// Install, replace, or clear (`null`) this server's datagram reflector.
    ///
    /// The rule is validated here again even though the TypeScript wrapper
    /// already checked it: a raw-addon caller must not be able to hand the
    /// hot path an unchecked offset. Shape errors are `TypeError`, bound
    /// errors `RangeError`, both raised before any state changes. Takes
    /// effect on the next datagram of every session this server owns.
    #[napi(js_name = "setDatagramReflector")]
    pub fn set_datagram_reflector(
        &self,
        rule: Option<crate::datagram_reflector::DatagramReflectorRuleInput>,
    ) -> Result<()> {
        let compiled = match rule {
            None => None,
            Some(input) => match crate::datagram_reflector::compile(&input) {
                Ok(rule) => Some(std::sync::Arc::new(rule)),
                Err(crate::datagram_reflector::RuleError::Shape(message)) => {
                    return Err(napi::Error::new(
                        napi::Status::InvalidArg,
                        format!("TypeError: {message}"),
                    ));
                }
                Err(crate::datagram_reflector::RuleError::Range(message)) => {
                    return Err(napi::Error::new(
                        napi::Status::InvalidArg,
                        format!("RangeError: {message}"),
                    ));
                }
            },
        };
        crate::datagram_reflector::set_rule(self.server_id, compiled);
        Ok(())
    }

    /// Hand one payload and many targets to the egress pacer's schedule.
    ///
    /// The sibling of [`Self::send_datagram_mirror`], and a separate method
    /// rather than a mode of it, because the envelope means something else.
    /// `admitted` is targets accepted onto the schedule: nothing has been
    /// resolved, owner-checked or budget-checked when this returns, and calling
    /// that number `sent` is the lie this API exists to avoid. Per-target
    /// outcomes are drained afterwards through [`Self::read_mirror_reports`].
    ///
    /// Synchronous and promise-free, exactly as the mirror is — the JS thread
    /// pays one lock, one payload copy and one target gather, independent of the
    /// schedule's depth. Never throws for a transport condition.
    ///
    /// `paced: false` says the pacer knob (`WEBTRANSPORT_PACER_PPS`) is off and
    /// nothing was offered; the wrapper raises `E_UNSUPPORTED_ARGUMENT` for it.
    /// That is a configuration error, not a transport condition: a caller that
    /// asked for the schedule by name and silently got the inline burst instead
    /// would have no way to tell.
    #[napi(js_name = "sendDatagramMirrorPaced")]
    pub fn send_datagram_mirror_paced(
        &self,
        targets: Vec<String>,
        payload: Uint8Array,
    ) -> crate::datagram_mirror::DatagramMirrorAdmission {
        // One copy for the whole fan-out, as on the synchronous path — and here
        // it is load-bearing rather than merely contractual: the job outlives
        // the call, so the JS-owned buffer cannot be the one the pacer sends.
        let payload = payload.as_ref().to_vec();
        crate::session::send_datagram_mirror_paced_for_owner(
            self.server_id,
            &targets,
            &payload,
            &self.metrics,
        )
        .map(crate::datagram_mirror::MirrorOutcome::into_admission_napi)
        .unwrap_or_else(crate::datagram_mirror::DatagramMirrorAdmission::unpaced)
    }

    /// Drain up to `max` of this server's deferred mirror reports, oldest first.
    ///
    /// Failures only. A paced broadcast reports nothing for the targets that
    /// took the payload, so the delivered count is `admitted` minus the failures
    /// that arrive here — the same "cost proportional to what went wrong" shape
    /// the synchronous envelope has.
    ///
    /// Synchronous, promise-free and never throwing, in the drain-on-poll style
    /// `readDatagramBatch` already uses. An empty result means nothing is
    /// pending, including on an addon with no pacer at all; the pacer's presence
    /// is told apart by whether `sendDatagramMirrorPaced` exists.
    ///
    /// The backing ring is fixed at 4,096 entries and drops oldest on overflow,
    /// counting every drop in `mirrorReportsDropped`, so a caller that never
    /// polls costs a constant rather than a growth path.
    #[napi(js_name = "readMirrorReports")]
    pub fn read_mirror_reports(
        &self,
        max: Option<u32>,
    ) -> Vec<crate::datagram_mirror::MirrorReportEntry> {
        let max = max.unwrap_or(u32::MAX) as usize;
        crate::egress_pacer::drain_reports(self.server_id, max)
            .into_iter()
            .map(|(target, code)| crate::datagram_mirror::MirrorReportEntry { target, code })
            .collect()
    }

    /// Open an egress-pacer stats window. Returns the token to pass to
    /// [`Self::pacer_stats_json`] at window close, or `0` when the pacer knob is
    /// off and there is nothing to window.
    ///
    /// Named with the double underscore for the same reason
    /// `__pacerStatsJson` is: diagnostic, unstable, and outside the public API
    /// this package commits to.
    #[napi(js_name = "__pacerStatsSnapshot")]
    pub fn pacer_stats_snapshot(&self) -> u32 {
        crate::egress_pacer::snapshot()
    }

    /// Egress-pacer counters as a JSON string, `"{}"` when the pacer knob is
    /// off. Prototype instrumentation for the microbench and the cable
    /// validation (`crates/native/docs/egress-pacer.md`); deliberately untyped,
    /// because the prototype commits to no schema.
    ///
    /// With a token from `__pacerStatsSnapshot()` the result carries a `window`
    /// object of deltas over that window beside the raw `cumulative` values;
    /// without one, `window` is `null`. Process-global by construction — the
    /// pacer is one schedule per process, not one per server — so a second
    /// `Server` in the same process reads the same counters.
    /// Effective Tokio worker count of the server runtime for this process.
    /// Default 2; overridden only by `WEBTRANSPORT_NATIVE_SERVER_WORKERS` for
    /// campaign A/B measurement. Exposed so a load harness can prove the shard
    /// it started is running the worker count it asked for.
    #[napi]
    pub fn server_worker_threads(&self) -> u32 {
        panic_guard::catch_panic(|| Ok(crate::server_worker_threads() as u32)).unwrap_or(0)
    }

    /// Where quinn's endpoint driver runs for servers in this process:
    /// `"shared"` (the server runtime) or `"dedicated"` (its own thread).
    /// Memoised with the runtime choice so a shard can attest the mode it
    /// actually started with.
    #[napi]
    pub fn server_recv_runtime(&self) -> String {
        panic_guard::catch_panic(|| {
            Ok(crate::quic_runtime::server_recv_runtime_mode()
                .as_str()
                .to_string())
        })
        .unwrap_or_default()
    }

    #[napi(js_name = "__pacerStatsJson")]
    pub fn pacer_stats_json(&self, since: Option<u32>) -> String {
        crate::egress_pacer::stats_json(since)
    }

    #[napi]
    pub fn metrics_snapshot(&self) -> WtResult<crate::metrics::ServerMetricsSnapshot> {
        panic_guard::catch_panic(|| {
            let state = self
                .state
                .lock()
                .map_err(|_| napi::Error::from_reason("E_INTERNAL: server state lock poisoned"))?;
            let mut snapshot = self
                .metrics
                .snapshot(Some(state.tls_resolver.metrics_snapshot()));
            snapshot.native_session_registry_entries =
                crate::session_registry::owner_entry_count(self.server_id) as u32;
            snapshot.native_tracked_tasks =
                crate::spawn_tracked::server_task_count(self.server_id) as u32;
            snapshot.native_rate_limit_entries =
                crate::rate_limit::owner_entry_count(self.server_id) as u32;
            snapshot.native_async_ops_pending =
                crate::async_ops::owner_pending(self.server_id).min(u32::MAX as u64) as u32;
            let (bidi, uni_send, uni_recv) = crate::client_stream::live_native_stream_handles();
            snapshot.native_bidi_handles_live = bidi as u32;
            snapshot.native_uni_send_handles_live = uni_send as u32;
            snapshot.native_uni_recv_handles_live = uni_recv as u32;
            let quic = crate::session_registry::owner_quic_aggregate(self.server_id);
            snapshot.quic_sessions = Some(quic.sessions as f64);
            snapshot.quic_udp_datagrams_received = Some(quic.udp_datagrams_received as f64);
            snapshot.quic_udp_datagrams_sent = Some(quic.udp_datagrams_sent as f64);
            snapshot.quic_datagram_frames_received = Some(quic.datagram_frames_received as f64);
            snapshot.quic_datagram_frames_sent = Some(quic.datagram_frames_sent as f64);
            snapshot.quic_packets_sent = Some(quic.packets_sent as f64);
            snapshot.quic_packets_lost = Some(quic.packets_lost as f64);
            Ok(snapshot)
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
