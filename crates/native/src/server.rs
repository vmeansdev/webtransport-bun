//! Server TLS rotation, drain, and spawn helpers (NAPI-free).
//! NAPI bindings live in `server_napi.rs`. Coverage floors target this module.

use napi::Result;
use serde::Deserialize;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::watch;

use crate::server_metrics::ServerMetrics;

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

pub(crate) fn parse_unknown_sni_policy(
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

pub(crate) fn parse_tls_resolver_config(
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

pub(crate) fn parse_sni_entries_json(
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

pub(crate) struct ServerRuntimeState {
    pub(crate) shutdown_tx: Option<watch::Sender<()>>,
    pub(crate) tls_resolver: Arc<crate::server_tls::LiveServerCertResolver>,
    pub(crate) explicit_default_cert: bool,
    pub(crate) closed: bool,
}

pub(crate) fn ensure_explicit_default_cert(state: &ServerRuntimeState) -> Result<()> {
    if state.explicit_default_cert {
        return Ok(());
    }
    Err(napi::Error::from_reason(
        "E_INTERNAL: tls rotation failed: SNI management requires a non-empty default certPem/keyPem",
    ))
}

pub(crate) fn ensure_server_open(state: &ServerRuntimeState) -> Result<()> {
    if state.closed {
        return Err(napi::Error::from_reason(
            "E_SESSION_CLOSED: server is closed",
        ));
    }
    Ok(())
}

pub(crate) fn map_internal_error(detail: impl std::fmt::Display) -> napi::Error {
    napi::Error::from_reason(format!("E_INTERNAL: {}", detail))
}

pub(crate) fn map_tls_rotation_error(detail: impl std::fmt::Display) -> napi::Error {
    napi::Error::from_reason(format!("E_INTERNAL: tls rotation failed: {}", detail))
}

pub(crate) fn map_certificate_rotation_error(detail: impl std::fmt::Display) -> napi::Error {
    napi::Error::from_reason(format!(
        "E_INTERNAL: certificate rotation failed: {}",
        detail
    ))
}

pub(crate) fn rotate_default_cert(
    state: &mut ServerRuntimeState,
    cert_pem: &str,
    key_pem: &str,
) -> Result<()> {
    ensure_server_open(state)?;
    let certified_key = crate::server_tls::parse_certified_key(cert_pem, key_pem)
        .map_err(map_certificate_rotation_error)?;
    state
        .tls_resolver
        .replace_default(certified_key)
        .map_err(map_internal_error)?;
    state.explicit_default_cert = true;
    Ok(())
}

pub(crate) fn rotate_tls_config(
    state: &mut ServerRuntimeState,
    tls_config_json: &str,
) -> Result<()> {
    ensure_server_open(state)?;
    let tls_config = parse_tls_resolver_config(tls_config_json).map_err(map_tls_rotation_error)?;
    let (default_cert, certs_by_name, unknown_sni_policy) =
        crate::server_tls::parse_resolver_config(&tls_config).map_err(map_tls_rotation_error)?;
    state
        .tls_resolver
        .replace_all(default_cert, certs_by_name, unknown_sni_policy)
        .map_err(map_internal_error)?;
    state.explicit_default_cert = true;
    Ok(())
}

pub(crate) fn replace_sni_certs_state(state: &ServerRuntimeState, sni_json: &str) -> Result<()> {
    ensure_server_open(state)?;
    ensure_explicit_default_cert(state)?;
    let sni_certs = parse_sni_entries_json(sni_json).map_err(map_tls_rotation_error)?;
    let mut certs_by_name = std::collections::HashMap::new();
    let mut original_names_by_normalized = std::collections::HashMap::new();
    for sni_cert in sni_certs {
        let server_name = crate::server_tls::normalize_server_name(&sni_cert.server_name)
            .map_err(map_tls_rotation_error)?;
        if let Some(existing_original) = original_names_by_normalized.get(&server_name) {
            return Err(napi::Error::from_reason(format!(
                "E_INTERNAL: tls rotation failed: duplicate serverName entry after normalization: \"{}\" conflicts with \"{}\" as \"{}\"",
                sni_cert.server_name, existing_original, server_name
            )));
        }
        let certified_key =
            crate::server_tls::parse_certified_key(&sni_cert.cert_pem, &sni_cert.key_pem)
                .map_err(map_tls_rotation_error)?;
        original_names_by_normalized.insert(server_name.clone(), sni_cert.server_name);
        certs_by_name.insert(server_name, certified_key);
    }
    state
        .tls_resolver
        .replace_sni_certs(certs_by_name)
        .map_err(map_internal_error)?;
    Ok(())
}

pub(crate) fn upsert_sni_cert_state(
    state: &ServerRuntimeState,
    server_name: &str,
    cert_pem: &str,
    key_pem: &str,
) -> Result<()> {
    ensure_server_open(state)?;
    ensure_explicit_default_cert(state)?;
    let certified_key = crate::server_tls::parse_certified_key(cert_pem, key_pem)
        .map_err(map_tls_rotation_error)?;
    state
        .tls_resolver
        .upsert_sni_cert(server_name, certified_key)
        .map_err(map_internal_error)?;
    Ok(())
}

pub(crate) fn remove_sni_cert_state(state: &ServerRuntimeState, server_name: &str) -> Result<()> {
    ensure_server_open(state)?;
    ensure_explicit_default_cert(state)?;
    let removed = state
        .tls_resolver
        .remove_sni_cert(server_name)
        .map_err(map_internal_error)?;
    if !removed {
        return Err(napi::Error::from_reason(format!(
            "E_INTERNAL: tls rotation failed: unknown serverName entry: {}",
            server_name
        )));
    }
    Ok(())
}

pub(crate) fn set_unknown_sni_policy_state(state: &ServerRuntimeState, policy: &str) -> Result<()> {
    ensure_server_open(state)?;
    ensure_explicit_default_cert(state)?;
    let policy = parse_unknown_sni_policy(Some(policy)).map_err(map_tls_rotation_error)?;
    state
        .tls_resolver
        .set_unknown_sni_policy(policy)
        .map_err(map_internal_error)?;
    Ok(())
}

pub(crate) fn tls_snapshot_from_state(
    state: &ServerRuntimeState,
) -> Result<crate::metrics::ServerTlsSnapshot> {
    let snapshot = state
        .tls_resolver
        .tls_snapshot()
        .map_err(map_internal_error)?;
    Ok(crate::metrics::ServerTlsSnapshot {
        sni_server_names: snapshot.sni_server_names,
        unknown_sni_policy: match snapshot.unknown_sni_policy {
            crate::server_tls::UnknownSniPolicy::Reject => "reject".to_string(),
            crate::server_tls::UnknownSniPolicy::Default => "default".to_string(),
        },
    })
}

#[derive(Clone, Copy)]
pub(crate) struct CloseDrainTiming {
    pub(crate) grace_period: Duration,
    pub(crate) abort_period: Duration,
    pub(crate) poll_interval: Duration,
}

impl CloseDrainTiming {
    pub(crate) const fn production() -> Self {
        Self {
            grace_period: Duration::from_secs(5),
            abort_period: Duration::from_secs(5),
            poll_interval: Duration::from_millis(50),
        }
    }
}

pub(crate) fn server_runtime_is_idle(
    session_tasks: u64,
    stream_tasks: u64,
    sessions_active: u64,
    tracked_tasks: usize,
) -> bool {
    session_tasks == 0 && stream_tasks == 0 && sessions_active == 0 && tracked_tasks == 0
}

pub(crate) async fn wait_for_server_drain(
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
        if server_runtime_is_idle(session_tasks, stream_tasks, sessions_active, tracked_tasks) {
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

#[cfg(test)]
mod tests {
    use super::{
        ensure_explicit_default_cert, map_certificate_rotation_error, map_internal_error,
        map_tls_rotation_error, parse_sni_entries_json, parse_tls_resolver_config,
        parse_unknown_sni_policy, remove_sni_cert_state, replace_sni_certs_state,
        rotate_default_cert, rotate_tls_config, server_runtime_is_idle,
        set_unknown_sni_policy_state, tls_snapshot_from_state, upsert_sni_cert_state,
        wait_for_server_drain, CloseDrainTiming, ServerRuntimeState,
    };
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
    fn server_runtime_is_idle_requires_all_gauges_clear() {
        assert!(server_runtime_is_idle(0, 0, 0, 0));
        assert!(!server_runtime_is_idle(1, 0, 0, 0));
        assert!(!server_runtime_is_idle(0, 1, 0, 0));
        assert!(!server_runtime_is_idle(0, 0, 1, 0));
        assert!(!server_runtime_is_idle(0, 0, 0, 1));
        assert!(!server_runtime_is_idle(1, 1, 1, 1));
    }

    #[test]
    fn tls_error_mappers_preserve_stable_prefixes() {
        assert!(map_internal_error("lock poisoned")
            .reason
            .starts_with("E_INTERNAL:"));
        assert!(map_tls_rotation_error("bad json")
            .reason
            .contains("tls rotation failed"));
        assert!(map_certificate_rotation_error("bad pem")
            .reason
            .contains("certificate rotation failed"));
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

        let empty_with_policy = parse_tls_resolver_config(
            r#"{"certPem":"","keyPem":"","sni":[],"unknownSniPolicy":"reject"}"#,
        )
        .unwrap_err();
        assert!(empty_with_policy.contains("require non-empty default certPem/keyPem"));

        let empty_key_with_sni = parse_tls_resolver_config(
            r#"{"certPem":"CERT","keyPem":"","sni":[{"serverName":"a.example","certPem":"C2","keyPem":"K2"}]}"#,
        )
        .unwrap_err();
        assert!(empty_key_with_sni.contains("require non-empty default certPem/keyPem"));
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
    fn tls_helper_error_paths_surface_stable_codes() {
        let (cert_pem, key_pem) = self_signed_pem();
        let mut state = open_state(true);

        let bad_cert = rotate_default_cert(&mut state, "not-a-cert", "not-a-key").unwrap_err();
        assert!(bad_cert.reason.contains("certificate rotation failed"));

        let bad_tls = rotate_tls_config(&mut state, "{not-json").unwrap_err();
        assert!(bad_tls.reason.contains("tls rotation failed"));

        let bad_sni_json = replace_sni_certs_state(&state, "null").unwrap_err();
        assert!(bad_sni_json.reason.contains("tls rotation failed"));

        let bad_wildcard = format!(
            r#"[{{"serverName":"*","certPem":{},"keyPem":{}}}]"#,
            serde_json::to_string(&cert_pem).unwrap(),
            serde_json::to_string(&key_pem).unwrap()
        );
        let wildcard_err = replace_sni_certs_state(&state, &bad_wildcard).unwrap_err();
        assert!(wildcard_err.reason.contains("tls rotation failed"));

        let dup = format!(
            r#"[{{"serverName":"A.example","certPem":{},"keyPem":{}}},{{"serverName":"a.example","certPem":{},"keyPem":{}}}]"#,
            serde_json::to_string(&cert_pem).unwrap(),
            serde_json::to_string(&key_pem).unwrap(),
            serde_json::to_string(&cert_pem).unwrap(),
            serde_json::to_string(&key_pem).unwrap()
        );
        let dup_err = replace_sni_certs_state(&state, &dup).unwrap_err();
        assert!(dup_err.reason.contains("duplicate serverName"));

        let bad_upsert =
            upsert_sni_cert_state(&state, "z.example", "not-a-cert", "not-a-key").unwrap_err();
        assert!(bad_upsert.reason.contains("tls rotation failed"));

        let bad_policy = set_unknown_sni_policy_state(&state, "allow").unwrap_err();
        assert!(bad_policy.reason.contains("tls rotation failed"));
    }

    #[test]
    fn replace_sni_rejects_invalid_pem_for_valid_names() {
        let state = open_state(true);
        let err = replace_sni_certs_state(
            &state,
            r#"[{"serverName":"ok.example","certPem":"nope","keyPem":"nope"}]"#,
        )
        .unwrap_err();
        assert!(err.reason.contains("tls rotation failed"));
    }

    #[test]
    fn rotate_tls_config_rejects_invalid_pem_after_json_parse() {
        let mut state = open_state(false);
        let err = rotate_tls_config(
            &mut state,
            r#"{"certPem":"nope","keyPem":"nope","sni":[],"unknownSniPolicy":"reject"}"#,
        )
        .unwrap_err();
        assert!(err.reason.contains("tls rotation failed"));
    }

    #[test]
    fn sni_helpers_reject_closed_server() {
        let (cert_pem, key_pem) = self_signed_pem();
        let mut state = open_state(true);
        state.closed = true;
        assert!(replace_sni_certs_state(&state, "[]")
            .unwrap_err()
            .reason
            .contains("E_SESSION_CLOSED"));
        assert!(
            upsert_sni_cert_state(&state, "a.example", &cert_pem, &key_pem)
                .unwrap_err()
                .reason
                .contains("E_SESSION_CLOSED")
        );
        assert!(remove_sni_cert_state(&state, "a.example")
            .unwrap_err()
            .reason
            .contains("E_SESSION_CLOSED"));
        assert!(set_unknown_sni_policy_state(&state, "reject")
            .unwrap_err()
            .reason
            .contains("E_SESSION_CLOSED"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn wait_for_server_drain_aborts_tracked_tasks() {
        use crate::spawn_tracked::{spawn_tracked, TaskKind};
        let server_id = u64::MAX - 24;
        let metrics = Arc::new(ServerMetrics::default());
        spawn_tracked(
            Arc::clone(&metrics),
            server_id,
            TaskKind::Session,
            crate::panic_guard::PanicScope::Server(server_id),
            async {
                tokio::time::sleep(Duration::from_secs(30)).await;
            },
        );
        // Give the tracked task a moment to register.
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(crate::spawn_tracked::server_task_count(server_id) >= 1);
        // Keep a stale sessions gauge so abort alone cannot clear idle.
        metrics.sessions_active.store(1, Ordering::SeqCst);
        let result = wait_for_server_drain(
            &metrics,
            server_id,
            CloseDrainTiming {
                grace_period: Duration::ZERO,
                abort_period: Duration::ZERO,
                poll_interval: Duration::from_millis(1),
            },
        )
        .await
        .expect("stale gauge after abort must time out");
        assert!(result.contains("abortedTasks="));
        assert!(result.contains("sessionsActive=1"));
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
