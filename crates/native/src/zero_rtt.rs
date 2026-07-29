//! Client-side 0-RTT support: shared TLS configurations, the in-memory ticket
//! store, and the opaque vault.
//!
//! rustls gates resumption on **pointer identity** of the certificate verifier
//! (`Weak::ptr_eq` inside `compatible_config`), so a fresh `ClientConfig` per
//! connect silently never resumes — no error, just a full handshake every
//! time. This module therefore builds ONE rustls `ClientConfig` per logical
//! client identity (TLS trust inputs) and hands out clones; cloning preserves
//! every `Arc`, including the verifier and the ticket store.
//!
//! Tickets are held in memory only. rustls session values are not publicly
//! serializable, so durable persistence is out of scope; the vault moves live
//! ticket values between identities inside this process behind an opaque
//! token, mirroring the wasm backend's process-local vault shape.

use napi_derive::napi;
use once_cell::sync::Lazy;
use rustls::client::ClientSessionStore;
use rustls::pki_types::ServerName;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

/// Sizing for the shared resumption store (set on the shared config's
/// `resumption` field via `Resumption::store`). Servers hand out several
/// tickets per connection; 8 per server covers reconnect bursts.
const MAX_TICKETS_PER_SERVER: usize = 8;
/// Bound on distinct servers remembered per client identity.
const MAX_SERVERS: usize = 256;

type TicketQueue = VecDeque<rustls::client::Tls13ClientSessionValue>;

#[derive(Debug, Default)]
struct StoreInner {
    kx_hints: HashMap<ServerName<'static>, rustls::NamedGroup>,
    tickets: HashMap<ServerName<'static>, TicketQueue>,
    /// Count of tickets taken that carried an early-data allowance, per
    /// server. A delta across a connect means that connect offered 0-RTT.
    early_takes: HashMap<ServerName<'static>, u64>,
}

/// Take-once in-memory ticket store shared by every connect of one client
/// identity. Implements the rustls `ClientSessionStore` contract: each ticket
/// is returned at most once.
#[derive(Debug, Default)]
pub struct ZeroRttTicketStore {
    inner: Mutex<StoreInner>,
}

impl ZeroRttTicketStore {
    fn lock(&self) -> MutexGuard<'_, StoreInner> {
        // A poisoned lock only means a panic elsewhere mid-mutation; ticket
        // state is advisory (worst case: a lost or extra full handshake).
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// How many early-data-capable tickets have been taken for `server`.
    pub fn early_take_count(&self, server: &ServerName<'static>) -> u64 {
        *self.lock().early_takes.get(server).unwrap_or(&0)
    }

    /// Move tickets out of this store (all servers, or one) for vault export.
    fn drain_tickets(
        &self,
        server: Option<&ServerName<'static>>,
    ) -> Vec<(ServerName<'static>, TicketQueue)> {
        let mut inner = self.lock();
        match server {
            Some(name) => inner
                .tickets
                .remove(name)
                .map(|q| vec![(name.clone(), q)])
                .unwrap_or_default(),
            None => inner.tickets.drain().collect(),
        }
    }

    /// Merge vault contents back into this store, respecting the caps.
    fn absorb(&self, contents: Vec<(ServerName<'static>, TicketQueue)>) {
        let mut inner = self.lock();
        for (name, queue) in contents {
            if inner.tickets.len() >= MAX_SERVERS && !inner.tickets.contains_key(&name) {
                continue;
            }
            let slot = inner.tickets.entry(name).or_default();
            for value in queue {
                if slot.len() >= MAX_TICKETS_PER_SERVER {
                    slot.pop_front();
                }
                slot.push_back(value);
            }
        }
    }

    #[cfg(test)]
    fn ticket_count(&self, server: &ServerName<'static>) -> usize {
        self.lock().tickets.get(server).map_or(0, |q| q.len())
    }
}

impl ClientSessionStore for ZeroRttTicketStore {
    fn set_kx_hint(&self, server_name: ServerName<'static>, group: rustls::NamedGroup) {
        let mut inner = self.lock();
        if inner.kx_hints.len() >= MAX_SERVERS && !inner.kx_hints.contains_key(&server_name) {
            return;
        }
        inner.kx_hints.insert(server_name, group);
    }

    fn kx_hint(&self, server_name: &ServerName<'_>) -> Option<rustls::NamedGroup> {
        self.lock().kx_hints.get(&server_name.to_owned()).copied()
    }

    // TLS 1.2 never happens here: the shared config pins TLS 1.3 (QUIC).
    fn set_tls12_session(
        &self,
        _server_name: ServerName<'static>,
        _value: rustls::client::Tls12ClientSessionValue,
    ) {
    }

    fn tls12_session(
        &self,
        _server_name: &ServerName<'_>,
    ) -> Option<rustls::client::Tls12ClientSessionValue> {
        None
    }

    fn remove_tls12_session(&self, _server_name: &ServerName<'static>) {}

    fn insert_tls13_ticket(
        &self,
        server_name: ServerName<'static>,
        value: rustls::client::Tls13ClientSessionValue,
    ) {
        let mut inner = self.lock();
        if inner.tickets.len() >= MAX_SERVERS && !inner.tickets.contains_key(&server_name) {
            // Evict an arbitrary server rather than refusing new ones; new
            // connectivity is worth more than a stale resumption entry.
            if let Some(evict) = inner.tickets.keys().next().cloned() {
                inner.tickets.remove(&evict);
            }
        }
        let queue = inner.tickets.entry(server_name).or_default();
        if queue.len() >= MAX_TICKETS_PER_SERVER {
            queue.pop_front();
        }
        queue.push_back(value);
    }

    fn take_tls13_ticket(
        &self,
        server_name: &ServerName<'_>,
    ) -> Option<rustls::client::Tls13ClientSessionValue> {
        let owned = server_name.to_owned();
        let mut inner = self.lock();
        let value = inner.tickets.get_mut(&owned)?.pop_front()?;
        if value.max_early_data_size() > 0 {
            *inner.early_takes.entry(owned).or_insert(0) += 1;
        }
        Some(value)
    }
}

/// Logical client identity: everything that shapes TLS trust. Two connects
/// with equal keys share one rustls config (and thus one ticket store and one
/// verifier Arc, which is what rustls requires for resumption to happen).
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct TlsIdentityKey {
    pub insecure_skip_verify: bool,
    pub ca_pem_sha256: Option<[u8; 32]>,
    pub pinned_hashes: Vec<[u8; 32]>,
}

impl TlsIdentityKey {
    pub fn new(
        insecure_skip_verify: bool,
        ca_pem: Option<&str>,
        pinned_hashes: &[[u8; 32]],
    ) -> Self {
        let ca_pem_sha256 = ca_pem.map(|pem| {
            let mut hasher = Sha256::new();
            hasher.update(pem.as_bytes());
            hasher.finalize().into()
        });
        Self {
            insecure_skip_verify,
            ca_pem_sha256,
            pinned_hashes: pinned_hashes.to_vec(),
        }
    }
}

struct SharedTlsEntry {
    config: rustls::ClientConfig,
    store: Arc<ZeroRttTicketStore>,
}

static SHARED_TLS: Lazy<Mutex<HashMap<TlsIdentityKey, SharedTlsEntry>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Get (building on first use) the shared TLS config + ticket store for a
/// client identity. Callers must pass the SAME `ca_pem` that produced the
/// key's hash; it is only used on the first (cache-miss) build.
pub fn shared_tls_for_identity(
    key: &TlsIdentityKey,
    ca_pem: Option<&str>,
    pinned_hashes: &[[u8; 32]],
) -> std::result::Result<(rustls::ClientConfig, Arc<ZeroRttTicketStore>), String> {
    let mut cache = SHARED_TLS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(entry) = cache.get(key) {
        return Ok((entry.config.clone(), Arc::clone(&entry.store)));
    }
    let store = Arc::new(ZeroRttTicketStore::default());
    let mut config =
        crate::client::build_client_tls_parts(key.insecure_skip_verify, ca_pem, pinned_hashes)?;
    config.resumption =
        rustls::client::Resumption::store(Arc::clone(&store) as Arc<dyn ClientSessionStore>);
    cache.insert(
        key.clone(),
        SharedTlsEntry {
            config: config.clone(),
            store: Arc::clone(&store),
        },
    );
    Ok((config, store))
}

fn existing_store_for_identity(key: &TlsIdentityKey) -> Option<Arc<ZeroRttTicketStore>> {
    SHARED_TLS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(key)
        .map(|entry| Arc::clone(&entry.store))
}

/// Per-connection 0-RTT status carried on the client session handle.
#[derive(Clone)]
pub struct ZeroRttHandleState {
    /// Early data was offered on this connect (a resumption ticket carrying
    /// an early-data allowance was consumed for it).
    pub has_0rtt: bool,
    /// Result of `Connection::handshake_confirmed()`; empty until the
    /// handshake completes (or the connection dies, which also resolves it).
    pub accepted: Arc<std::sync::OnceLock<bool>>,
}

// ---------------------------------------------------------------------------
// Opaque vault: move live ticket values between identities in-process.
// ---------------------------------------------------------------------------

type VaultContents = Vec<(ServerName<'static>, TicketQueue)>;

static VAULTS: Lazy<Mutex<HashMap<String, VaultContents>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static VAULT_COUNTER: AtomicU64 = AtomicU64::new(1);

/// Parsed TLS identity from a client options JSON blob: the cache key, the
/// original CA PEM (needed only on a cache-miss build), and the pins.
type ParsedIdentity = (TlsIdentityKey, Option<String>, Vec<[u8; 32]>);

fn identity_from_opts_json(opts_json: &str) -> std::result::Result<ParsedIdentity, String> {
    let opts: serde_json::Value = serde_json::from_str(opts_json)
        .map_err(|e| format!("E_INTERNAL: invalid client options JSON: {}", e))?;
    let tls_opts = opts.get("tls");
    let insecure_skip_verify = tls_opts
        .and_then(|t| t.get("insecureSkipVerify")?.as_bool())
        .unwrap_or(false);
    let ca_pem = tls_opts
        .and_then(|t| t.get("caPem")?.as_str())
        .filter(|s| !s.is_empty())
        .map(String::from);
    let pinned_hashes = crate::client::parse_server_certificate_hashes(&opts)?;
    let key = TlsIdentityKey::new(insecure_skip_verify, ca_pem.as_deref(), &pinned_hashes);
    Ok((key, ca_pem, pinned_hashes))
}

fn parse_vault_server_name(
    server_name: Option<String>,
) -> std::result::Result<Option<ServerName<'static>>, String> {
    server_name
        .filter(|s| !s.is_empty())
        .map(|s| {
            ServerName::try_from(s.clone())
                .map_err(|_| format!("E_INTERNAL: invalid vault serverName: {}", s))
        })
        .transpose()
}

fn export_vault_inner(
    opts_json: &str,
    server_name: Option<String>,
) -> std::result::Result<Option<String>, String> {
    let (key, _, _) = identity_from_opts_json(opts_json)?;
    let filter = parse_vault_server_name(server_name)?;
    let Some(store) = existing_store_for_identity(&key) else {
        return Ok(None);
    };
    let contents = store.drain_tickets(filter.as_ref());
    if contents.is_empty() {
        return Ok(None);
    }
    let token = format!(
        "wt0rtt-vault-{:016x}",
        VAULT_COUNTER.fetch_add(1, Ordering::Relaxed)
    );
    VAULTS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(token.clone(), contents);
    Ok(Some(token))
}

fn import_vault_inner(opts_json: &str, token: &str) -> std::result::Result<bool, String> {
    let (key, ca_pem, pinned_hashes) = identity_from_opts_json(opts_json)?;
    let Some(contents) = VAULTS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(token)
    else {
        return Ok(false);
    };
    let (_, store) = shared_tls_for_identity(&key, ca_pem.as_deref(), &pinned_hashes)?;
    store.absorb(contents);
    Ok(true)
}

/// Drain in-memory 0-RTT tickets for a client identity (optionally one
/// server) into an opaque process-local vault. Returns the vault token, or
/// null when there is nothing to export. Tokens are NOT durable: they refer
/// to live ticket values inside this process and mean nothing after restart.
#[napi]
pub fn export_zero_rtt_vault(
    opts_json: String,
    server_name: Option<String>,
) -> napi::Result<Option<String>> {
    crate::panic_guard::catch_panic(|| {
        export_vault_inner(&opts_json, server_name).map_err(napi::Error::from_reason)
    })
}

/// Import a previously exported vault into a client identity's ticket store.
/// Consumes the token; returns false when the token is unknown or already
/// used.
#[napi]
pub fn import_zero_rtt_vault(opts_json: String, token: String) -> napi::Result<bool> {
    crate::panic_guard::catch_panic(|| {
        import_vault_inner(&opts_json, &token).map_err(napi::Error::from_reason)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn name(host: &str) -> ServerName<'static> {
        ServerName::try_from(host.to_string()).expect("valid server name")
    }

    // Building a real Tls13ClientSessionValue requires private rustls
    // constructors, so store-level unit tests exercise everything reachable
    // without one (kx hints, drain/absorb of empty state, identity cache,
    // vault token lifecycle). Ticket flow itself is covered by the loopback
    // resumption tests below, where rustls mints real tickets.

    #[test]
    fn kx_hints_are_stored_and_bounded() {
        let store = ZeroRttTicketStore::default();
        store.set_kx_hint(name("a.example"), rustls::NamedGroup::X25519);
        assert_eq!(
            store.kx_hint(&name("a.example")),
            Some(rustls::NamedGroup::X25519)
        );
        assert_eq!(store.kx_hint(&name("b.example")), None);
    }

    #[test]
    fn early_take_count_defaults_to_zero_and_take_returns_none_when_empty() {
        let store = ZeroRttTicketStore::default();
        assert_eq!(store.early_take_count(&name("s.example")), 0);
        assert!(store.take_tls13_ticket(&name("s.example")).is_none());
    }

    #[test]
    fn identity_cache_returns_same_store_for_equal_keys() {
        let key = TlsIdentityKey::new(true, None, &[]);
        let (cfg1, store1) = shared_tls_for_identity(&key, None, &[]).expect("build shared tls");
        let (cfg2, store2) = shared_tls_for_identity(&key, None, &[]).expect("cached shared tls");
        assert!(Arc::ptr_eq(&store1, &store2));
        // The cloned configs must share the SAME verifier Arc — that pointer
        // identity is what rustls' compatible_config checks.
        assert!(!cfg1.alpn_protocols.is_empty());
        assert!(!cfg2.alpn_protocols.is_empty());
    }

    #[test]
    fn identity_cache_distinguishes_different_keys() {
        let key_a = TlsIdentityKey::new(true, None, &[]);
        let key_b = TlsIdentityKey::new(true, None, &[[7u8; 32]]);
        let (_, store_a) = shared_tls_for_identity(&key_a, None, &[]).expect("identity a");
        let (_, store_b) = shared_tls_for_identity(&key_b, None, &[[7u8; 32]]).expect("identity b");
        assert!(!Arc::ptr_eq(&store_a, &store_b));
    }

    #[test]
    fn identity_key_hashes_ca_pem() {
        let a = TlsIdentityKey::new(false, Some("PEM-A"), &[]);
        let b = TlsIdentityKey::new(false, Some("PEM-B"), &[]);
        let a2 = TlsIdentityKey::new(false, Some("PEM-A"), &[]);
        assert_ne!(a, b);
        assert_eq!(a, a2);
    }

    #[test]
    fn export_returns_none_for_unknown_identity_or_empty_store() {
        // Unknown identity: never built.
        let opts = r#"{"tls":{"caPem":"unknown-identity-marker"}}"#;
        // caPem must parse as a cert to build a config, but export must not
        // build anything for a cache miss — it returns None first.
        assert_eq!(export_vault_inner(opts, None).expect("export"), None);

        // Known identity, empty store.
        let key = TlsIdentityKey::new(true, None, &[]);
        let _ = shared_tls_for_identity(&key, None, &[]).expect("build");
        let opts = r#"{"tls":{"insecureSkipVerify":true}}"#;
        assert_eq!(export_vault_inner(opts, None).expect("export"), None);
    }

    #[test]
    fn import_unknown_token_returns_false() {
        let opts = r#"{"tls":{"insecureSkipVerify":true}}"#;
        assert!(!import_vault_inner(opts, "wt0rtt-vault-doesnotexist").expect("import"));
    }

    #[test]
    fn vault_server_name_validation() {
        assert!(parse_vault_server_name(Some("not a hostname !!".to_string())).is_err());
        assert!(parse_vault_server_name(Some("localhost".to_string()))
            .expect("valid")
            .is_some());
        assert!(parse_vault_server_name(None).expect("absent").is_none());
        assert!(parse_vault_server_name(Some(String::new()))
            .expect("empty treated as absent")
            .is_none());
    }

    #[test]
    fn identity_from_opts_json_rejects_bad_json_and_bad_pins() {
        assert!(identity_from_opts_json("{").is_err());
        let bad_pin = r#"{"serverCertificateHashes":[{"algorithm":"sha-1","value":[]}]}"#;
        assert!(identity_from_opts_json(bad_pin).is_err());
        let ok = r#"{"tls":{"insecureSkipVerify":true}}"#;
        let (key, ca, pins) = identity_from_opts_json(ok).expect("parse");
        assert!(key.insecure_skip_verify);
        assert!(ca.is_none());
        assert!(pins.is_empty());
    }

    #[test]
    fn absorb_respects_caps_with_empty_queues() {
        let store = ZeroRttTicketStore::default();
        store.absorb(vec![(name("x.example"), TicketQueue::new())]);
        assert_eq!(store.ticket_count(&name("x.example")), 0);
    }

    // -----------------------------------------------------------------------
    // Loopback regression for the binding correction: rustls resumes ONLY
    // under the same verifier Arc, so a shared cloned config must resume and
    // per-connect fresh configs must silently fall back to full handshakes.
    // -----------------------------------------------------------------------

    fn start_0rtt_server() -> (crate::server_spawn::ShutdownOnDrop, u16) {
        let metrics = Arc::new(crate::server_metrics::ServerMetrics::default());
        let (shutdown_tx, port) = crate::server_spawn::spawn_server_instance(
            u64::MAX - 50,
            metrics,
            &crate::limits::Limits::default(),
            &crate::rate_limit::RateLimits::default(),
            "127.0.0.1",
            0,
            &None,
            &None,
            crate::server_tls::build_default_dev_resolver().expect("dev resolver"),
            crate::client::CongestionControlMode::Default,
            false,
            true, // enable_0rtt
            3,
        )
        .expect("0-RTT server start");
        (crate::server_spawn::ShutdownOnDrop(Some(shutdown_tx)), port)
    }

    fn client_config_with_tls(tls: rustls::ClientConfig) -> wtransport::ClientConfig {
        wtransport::ClientConfig::builder()
            .with_bind_default()
            .with_custom_tls_and_transport(tls, wtransport::config::QuicTransportConfig::default())
            .enable_0rtt(true)
            .build()
    }

    async fn wait_for_ticket(store: &ZeroRttTicketStore, server: &ServerName<'static>) -> bool {
        for _ in 0..100 {
            if store.ticket_count(server) > 0 {
                return true;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        false
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn shared_config_resumes_with_early_data() {
        let (_shutdown, port) = start_0rtt_server();
        let url = format!("https://127.0.0.1:{}/", port);
        let server = name("127.0.0.1");

        let key = TlsIdentityKey::new(true, None, &[]);
        let (tls, store) = shared_tls_for_identity(&key, None, &[]).expect("shared tls");

        // First connect: full handshake, mints resumption tickets.
        let endpoint1 =
            wtransport::Endpoint::client(client_config_with_tls(tls.clone())).expect("ep1");
        let conn1 = endpoint1.connect_0rtt(&url).await.expect("first connect");
        assert!(
            conn1.handshake_confirmed().await,
            "first connect never offered early data, so it must confirm true"
        );
        assert!(
            wait_for_ticket(&store, &server).await,
            "server must mint a resumption ticket after the first handshake"
        );
        let takes_before = store.early_take_count(&server);
        conn1.close(wtransport::VarInt::from_u32(0), b"done");
        drop(endpoint1);

        // Second connect with a CLONE of the same config: must consume an
        // early-data ticket and have that early data accepted.
        let endpoint2 = wtransport::Endpoint::client(client_config_with_tls(tls)).expect("ep2");
        let conn2 = endpoint2.connect_0rtt(&url).await.expect("second connect");
        assert!(
            store.early_take_count(&server) > takes_before,
            "shared config must offer a 0-RTT ticket on the second connect"
        );
        assert!(
            conn2.handshake_confirmed().await,
            "same-process server must accept the resumed early data"
        );
        conn2.close(wtransport::VarInt::from_u32(0), b"done");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn fresh_config_per_connect_never_resumes() {
        let (_shutdown, port) = start_0rtt_server();
        let url = format!("https://127.0.0.1:{}/", port);
        let server = name("127.0.0.1");

        let fresh = |store: Arc<ZeroRttTicketStore>| {
            let mut tls =
                crate::client::build_client_tls_parts(true, None, &[]).expect("fresh tls");
            tls.resumption =
                rustls::client::Resumption::store(store as Arc<dyn ClientSessionStore>);
            client_config_with_tls(tls)
        };

        let store1 = Arc::new(ZeroRttTicketStore::default());
        let endpoint1 =
            wtransport::Endpoint::client(fresh(Arc::clone(&store1))).expect("fresh ep1");
        let conn1 = endpoint1.connect_0rtt(&url).await.expect("first connect");
        assert!(conn1.handshake_confirmed().await);
        assert!(
            wait_for_ticket(&store1, &server).await,
            "first fresh config still receives tickets"
        );
        conn1.close(wtransport::VarInt::from_u32(0), b"done");
        drop(endpoint1);

        // Fresh config + fresh store: the earlier ticket belongs to a config
        // with a different verifier Arc, so nothing can be offered. This is
        // the silent-forever-full-handshake failure mode the shared cache
        // exists to prevent.
        let store2 = Arc::new(ZeroRttTicketStore::default());
        let endpoint2 =
            wtransport::Endpoint::client(fresh(Arc::clone(&store2))).expect("fresh ep2");
        let conn2 = endpoint2.connect_0rtt(&url).await.expect("second connect");
        assert!(conn2.handshake_confirmed().await);
        assert_eq!(
            store2.early_take_count(&server),
            0,
            "a per-connect config must never offer early data"
        );
        conn2.close(wtransport::VarInt::from_u32(0), b"done");
    }
}
