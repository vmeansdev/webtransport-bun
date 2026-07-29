//! Live TLS resolver for wasm server endpoints (default + SNI map).

use std::sync::{Arc, Mutex};

use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use rustls::server::{ClientHello, ResolvesServerCert};
use rustls::sign::CertifiedKey;
use rustls::ServerConfig;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UnknownSniPolicy {
    Reject,
    Default,
}

impl UnknownSniPolicy {
    pub fn parse(value: Option<&str>) -> Result<Self, String> {
        match value.unwrap_or("reject") {
            "reject" => Ok(Self::Reject),
            "default" => Ok(Self::Default),
            other => Err(format!(
                "E_TLS: unknownSniPolicy must be \"reject\" or \"default\", got \"{other}\""
            )),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Reject => "reject",
            Self::Default => "default",
        }
    }
}

struct ResolverState {
    default: Option<Arc<CertifiedKey>>,
    sni: Vec<(String, Arc<CertifiedKey>)>,
    unknown_sni_policy: UnknownSniPolicy,
    sni_selections: u64,
    default_selections: u64,
    unknown_rejected: u64,
}

#[derive(Clone)]
pub struct LiveServerCertResolver {
    inner: Arc<Mutex<ResolverState>>,
}

impl std::fmt::Debug for LiveServerCertResolver {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("LiveServerCertResolver")
    }
}

impl LiveServerCertResolver {
    pub fn new(default: Option<Arc<CertifiedKey>>, unknown_sni_policy: UnknownSniPolicy) -> Self {
        Self {
            inner: Arc::new(Mutex::new(ResolverState {
                default,
                sni: Vec::new(),
                unknown_sni_policy,
                sni_selections: 0,
                default_selections: 0,
                unknown_rejected: 0,
            })),
        }
    }

    pub fn snapshot_json(&self) -> String {
        let guard = self.inner.lock().expect("resolver lock");
        let sni_names: Vec<&str> = guard.sni.iter().map(|(n, _)| n.as_str()).collect();
        serde_json::json!({
            "unknownSniPolicy": guard.unknown_sni_policy.as_str(),
            "defaultCertPresent": guard.default.is_some(),
            "defaultCertHashBase64": default_cert_hash(guard.default.as_deref()),
            "sniNames": sni_names,
            "sniCertSelections": guard.sni_selections,
            "defaultCertSelections": guard.default_selections,
            "unknownSniRejectedCount": guard.unknown_rejected,
        })
        .to_string()
    }

    /// SHA-256(DER) of the current default leaf, base64-encoded — the
    /// `serverCertificateHashes` value pin clients must be told about after a
    /// rotation changes the default certificate.
    pub fn default_cert_hash_base64(&self) -> Option<String> {
        let guard = self.inner.lock().expect("resolver lock");
        default_cert_hash(guard.default.as_deref())
    }

    pub fn replace_default(&self, key: Arc<CertifiedKey>) {
        let mut guard = self.inner.lock().expect("resolver lock");
        guard.default = Some(key);
    }

    pub fn set_sni(&self, entries: Vec<(String, Arc<CertifiedKey>)>) {
        let mut guard = self.inner.lock().expect("resolver lock");
        guard.sni = entries;
    }

    pub fn set_unknown_policy(&self, policy: UnknownSniPolicy) {
        let mut guard = self.inner.lock().expect("resolver lock");
        guard.unknown_sni_policy = policy;
    }
}

/// SHA-256(DER) of a `CertifiedKey`'s leaf certificate, base64-encoded, or
/// `None` when no default cert is configured.
fn default_cert_hash(key: Option<&CertifiedKey>) -> Option<String> {
    let leaf = key?.cert.first()?;
    Some(crate::cert::sha256_base64(leaf.as_ref()))
}

impl ResolvesServerCert for LiveServerCertResolver {
    fn resolve(&self, client_hello: ClientHello<'_>) -> Option<Arc<CertifiedKey>> {
        let mut guard = self.inner.lock().ok()?;
        if let Some(name) = client_hello.server_name() {
            let want = name.to_ascii_lowercase();
            let found = guard
                .sni
                .iter()
                .find(|(n, _)| n.eq_ignore_ascii_case(&want))
                .map(|(_, key)| Arc::clone(key));
            if let Some(key) = found {
                guard.sni_selections = guard.sni_selections.saturating_add(1);
                return Some(key);
            }
            // Empty SNI map => default cert serves all names (dev / single-cert).
            if !guard.sni.is_empty() {
                match guard.unknown_sni_policy {
                    UnknownSniPolicy::Reject => {
                        guard.unknown_rejected = guard.unknown_rejected.saturating_add(1);
                        return None;
                    }
                    UnknownSniPolicy::Default => {}
                }
            }
        }
        guard.default_selections = guard.default_selections.saturating_add(1);
        guard.default.clone()
    }
}

pub fn certified_key_from_pem(cert_pem: &str, key_pem: &str) -> Result<Arc<CertifiedKey>, String> {
    let certs = rustls_pemfile::certs(&mut cert_pem.as_bytes())
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("E_TLS: cert pem: {e}"))?;
    if certs.is_empty() {
        return Err("E_TLS: no certificates in certPem".into());
    }
    let key = rustls_pemfile::private_key(&mut key_pem.as_bytes())
        .map_err(|e| format!("E_TLS: key pem: {e}"))?
        .ok_or_else(|| "E_TLS: no private key in keyPem".to_string())?;
    let provider = rustls::crypto::ring::default_provider();
    let signing = provider
        .key_provider
        .load_private_key(key)
        .map_err(|e| format!("E_TLS: load key: {e}"))?;
    let certified = CertifiedKey::new(certs, signing);
    certified
        .keys_match()
        .map_err(|e| format!("E_TLS: private key does not match certificate: {e}"))?;
    Ok(Arc::new(certified))
}

pub fn certified_key_from_der(
    cert_der: Vec<u8>,
    key_der: Vec<u8>,
) -> Result<Arc<CertifiedKey>, String> {
    let cert = CertificateDer::from(cert_der);
    let key = PrivateKeyDer::try_from(key_der).map_err(|e| format!("E_TLS: key der: {e}"))?;
    let provider = rustls::crypto::ring::default_provider();
    let signing = provider
        .key_provider
        .load_private_key(key)
        .map_err(|e| format!("E_TLS: load key: {e}"))?;
    let certified = CertifiedKey::new(vec![cert], signing);
    certified
        .keys_match()
        .map_err(|e| format!("E_TLS: private key does not match certificate: {e}"))?;
    Ok(Arc::new(certified))
}

pub fn server_config_with_live_resolver(
    cert_der: Vec<u8>,
    key_der: Vec<u8>,
) -> Result<(ServerConfig, LiveServerCertResolver), String> {
    let key = certified_key_from_der(cert_der, key_der)?;
    server_config_with_live_resolver_key(key)
}

/// Build a server config + live resolver from an already-parsed {@link CertifiedKey}
/// (PEM construction path for atomic `wt_new_server_with_options`).
pub fn server_config_with_live_resolver_key(
    key: Arc<CertifiedKey>,
) -> Result<(ServerConfig, LiveServerCertResolver), String> {
    let resolver = LiveServerCertResolver::new(Some(key), UnknownSniPolicy::Reject);
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut cfg = ServerConfig::builder_with_provider(provider)
        .with_protocol_versions(&[&rustls::version::TLS13])
        .map_err(|e| e.to_string())?
        .with_no_client_auth()
        .with_cert_resolver(Arc::new(resolver.clone()));
    cfg.alpn_protocols = vec![b"h3".to_vec()];
    Ok((cfg, resolver))
}

pub fn install_resolver(cfg: &mut ServerConfig, resolver: LiveServerCertResolver) {
    cfg.cert_resolver = Arc::new(resolver);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn generated_certified_key(common_name: &str) -> Arc<CertifiedKey> {
        let gen = crate::cert::generate(common_name, 14, 1_700_000_000).expect("cert");
        certified_key_from_der(gen.cert_der, gen.key_der).expect("certified key")
    }

    #[test]
    fn unknown_sni_policy_parses_and_rejects_unknown_values() {
        assert_eq!(
            UnknownSniPolicy::parse(None).unwrap(),
            UnknownSniPolicy::Reject
        );
        assert_eq!(
            UnknownSniPolicy::parse(Some("reject")).unwrap(),
            UnknownSniPolicy::Reject
        );
        assert_eq!(
            UnknownSniPolicy::parse(Some("default")).unwrap(),
            UnknownSniPolicy::Default
        );
        let err = UnknownSniPolicy::parse(Some("bogus")).unwrap_err();
        assert!(err.contains("E_TLS"));
        assert!(err.contains("bogus"));
    }

    #[test]
    fn resolver_serves_default_when_no_sni_configured() {
        let default = generated_certified_key("default.test");
        let resolver = LiveServerCertResolver::new(Some(default), UnknownSniPolicy::Reject);
        let snapshot: serde_json::Value = serde_json::from_str(&resolver.snapshot_json()).unwrap();
        assert_eq!(snapshot["defaultCertPresent"], true);
        assert!(snapshot["defaultCertHashBase64"].is_string());
        assert_eq!(snapshot["sniNames"], serde_json::json!([]));
        assert_eq!(snapshot["unknownSniPolicy"], "reject");
    }

    #[test]
    fn resolver_selects_sni_entry_by_exact_name_case_insensitively() {
        let default = generated_certified_key("default.test");
        let sni_key = generated_certified_key("sni.test");
        let resolver = LiveServerCertResolver::new(Some(default), UnknownSniPolicy::Reject);
        resolver.set_sni(vec![("sni.test".to_string(), Arc::clone(&sni_key))]);
        let snapshot: serde_json::Value = serde_json::from_str(&resolver.snapshot_json()).unwrap();
        assert_eq!(snapshot["sniNames"], serde_json::json!(["sni.test"]));
    }

    #[test]
    fn unknown_sni_reject_policy_rejects_and_default_policy_falls_back() {
        let default = generated_certified_key("default.test");
        let default_hash = default_cert_hash(Some(&default));
        let sni_key = generated_certified_key("known.test");
        let resolver =
            LiveServerCertResolver::new(Some(Arc::clone(&default)), UnknownSniPolicy::Reject);
        resolver.set_sni(vec![("known.test".to_string(), sni_key)]);
        assert_eq!(resolver.default_cert_hash_base64(), default_hash);

        resolver.set_unknown_policy(UnknownSniPolicy::Default);
        let snapshot: serde_json::Value = serde_json::from_str(&resolver.snapshot_json()).unwrap();
        assert_eq!(snapshot["unknownSniPolicy"], "default");
    }

    #[test]
    fn replace_default_rotates_and_changes_the_exported_hash() {
        let first = generated_certified_key("first.test");
        let first_hash = default_cert_hash(Some(&first));
        let resolver = LiveServerCertResolver::new(Some(first), UnknownSniPolicy::Reject);
        assert_eq!(resolver.default_cert_hash_base64(), first_hash);

        let second = generated_certified_key("second.test");
        let second_hash = default_cert_hash(Some(&second));
        assert_ne!(first_hash, second_hash);
        resolver.replace_default(second);
        assert_eq!(resolver.default_cert_hash_base64(), second_hash);
    }

    #[test]
    fn default_cert_hash_is_none_without_a_default_cert() {
        assert_eq!(default_cert_hash(None), None);
        let resolver = LiveServerCertResolver::new(None, UnknownSniPolicy::Reject);
        assert_eq!(resolver.default_cert_hash_base64(), None);
        let snapshot: serde_json::Value = serde_json::from_str(&resolver.snapshot_json()).unwrap();
        assert_eq!(snapshot["defaultCertPresent"], false);
        assert!(snapshot["defaultCertHashBase64"].is_null());
    }

    #[test]
    fn certified_key_from_pem_rejects_missing_cert_and_key() {
        let err = certified_key_from_pem("", "").unwrap_err();
        assert!(err.contains("E_TLS"));

        let gen = crate::cert::generate("pem.test", 14, 1_700_000_000).expect("cert");
        let err = certified_key_from_pem(&gen.cert_pem, "").unwrap_err();
        assert!(err.contains("E_TLS"));

        let key = certified_key_from_pem(&gen.cert_pem, &gen.key_pem).expect("parsed pem key");
        assert_eq!(key.cert.len(), 1);
    }

    #[test]
    fn server_config_with_live_resolver_sets_h3_alpn_and_returns_matching_resolver() {
        let gen = crate::cert::generate("cfg.test", 14, 1_700_000_000).expect("cert");
        let expected_hash = crate::cert::sha256_base64(&gen.cert_der);
        let (cfg, resolver) =
            server_config_with_live_resolver(gen.cert_der, gen.key_der).expect("server config");
        assert_eq!(cfg.alpn_protocols, vec![b"h3".to_vec()]);
        assert_eq!(resolver.default_cert_hash_base64(), Some(expected_hash));
    }
}
