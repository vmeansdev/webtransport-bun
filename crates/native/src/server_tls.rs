use std::collections::HashMap;
use std::io::BufReader;
use std::sync::{Arc, RwLock};

use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use rustls::server::{ClientHello, ResolvesServerCert};
use rustls::sign::CertifiedKey;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum UnknownSniPolicy {
    Reject,
    Default,
}

#[derive(Clone, Debug)]
pub(crate) struct SniCertConfig {
    pub(crate) server_name: String,
    pub(crate) cert_pem: String,
    pub(crate) key_pem: String,
}

#[derive(Clone, Debug)]
pub(crate) struct ResolverConfig {
    pub(crate) default_cert_pem: String,
    pub(crate) default_key_pem: String,
    pub(crate) sni_certs: Vec<SniCertConfig>,
    pub(crate) unknown_sni_policy: UnknownSniPolicy,
}

type ParsedResolverConfig = (
    Arc<CertifiedKey>,
    HashMap<String, Arc<CertifiedKey>>,
    UnknownSniPolicy,
);

#[derive(Clone)]
struct ResolverSnapshot {
    default_cert: Arc<CertifiedKey>,
    certs_by_name: HashMap<String, Arc<CertifiedKey>>,
    unknown_sni_policy: UnknownSniPolicy,
}

impl std::fmt::Debug for ResolverSnapshot {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ResolverSnapshot")
            .field("default_cert", &"<redacted>")
            .field(
                "certs_by_name",
                &self.certs_by_name.keys().collect::<Vec<_>>(),
            )
            .finish()
    }
}

#[derive(Debug)]
pub(crate) struct LiveServerCertResolver {
    inner: RwLock<ResolverSnapshot>,
}

impl LiveServerCertResolver {
    pub(crate) fn new(
        default_cert: Arc<CertifiedKey>,
        certs_by_name: HashMap<String, Arc<CertifiedKey>>,
        unknown_sni_policy: UnknownSniPolicy,
    ) -> Self {
        Self {
            inner: RwLock::new(ResolverSnapshot {
                default_cert,
                certs_by_name,
                unknown_sni_policy,
            }),
        }
    }

    pub(crate) fn replace_default(
        &self,
        default_cert: Arc<CertifiedKey>,
    ) -> std::result::Result<(), String> {
        let mut inner = self
            .inner
            .write()
            .map_err(|_| "server cert resolver lock poisoned".to_string())?;
        inner.default_cert = default_cert;
        Ok(())
    }

    #[allow(dead_code)]
    pub(crate) fn replace_all(
        &self,
        default_cert: Arc<CertifiedKey>,
        certs_by_name: HashMap<String, Arc<CertifiedKey>>,
        unknown_sni_policy: UnknownSniPolicy,
    ) -> std::result::Result<(), String> {
        let mut inner = self
            .inner
            .write()
            .map_err(|_| "server cert resolver lock poisoned".to_string())?;
        inner.default_cert = default_cert;
        inner.certs_by_name = certs_by_name;
        inner.unknown_sni_policy = unknown_sni_policy;
        Ok(())
    }
}

impl ResolvesServerCert for LiveServerCertResolver {
    fn resolve(&self, client_hello: ClientHello<'_>) -> Option<Arc<CertifiedKey>> {
        let inner = self.inner.read().ok()?;
        if let Some(server_name) = client_hello.server_name() {
            let key = server_name.trim_end_matches('.').to_ascii_lowercase();
            if let Some(cert) = inner.certs_by_name.get(&key) {
                return Some(Arc::clone(cert));
            }
            if !inner.certs_by_name.is_empty()
                && inner.unknown_sni_policy == UnknownSniPolicy::Reject
            {
                return None;
            }
        }
        Some(Arc::clone(&inner.default_cert))
    }
}

fn normalize_server_name(server_name: &str) -> std::result::Result<String, String> {
    let normalized = server_name
        .trim()
        .trim_end_matches('.')
        .to_ascii_lowercase();
    if normalized.is_empty() {
        return Err("serverName must be non-empty".to_string());
    }
    Ok(normalized)
}

fn parse_cert_chain(cert_pem: &str) -> std::result::Result<Vec<CertificateDer<'static>>, String> {
    let mut reader = BufReader::new(cert_pem.as_bytes());
    let certs = rustls_pemfile::certs(&mut reader)
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|e| format!("failed to parse certificate PEM: {}", e))?;
    if certs.is_empty() {
        return Err("certificate PEM contained no certificates".to_string());
    }
    Ok(certs)
}

fn parse_private_key(key_pem: &str) -> std::result::Result<PrivateKeyDer<'static>, String> {
    let mut reader = BufReader::new(key_pem.as_bytes());
    match rustls_pemfile::private_key(&mut reader)
        .map_err(|e| format!("failed to parse private key PEM: {}", e))?
    {
        Some(key) => Ok(key),
        None => Err("private key PEM contained no private key".to_string()),
    }
}

pub(crate) fn parse_certified_key(
    cert_pem: &str,
    key_pem: &str,
) -> std::result::Result<Arc<CertifiedKey>, String> {
    let cert_chain = parse_cert_chain(cert_pem)?;
    let key_der = parse_private_key(key_pem)?;
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let certified_key = CertifiedKey::from_der(cert_chain, key_der, &provider)
        .map_err(|e| format!("failed to build certified key: {}", e))?;
    Ok(Arc::new(certified_key))
}

pub(crate) fn build_server_tls_config(
    resolver: Arc<LiveServerCertResolver>,
) -> std::result::Result<rustls::ServerConfig, String> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut tls_config = rustls::ServerConfig::builder_with_provider(provider)
        .with_protocol_versions(&[&rustls::version::TLS13])
        .map_err(|e| format!("failed to build TLS versions: {}", e))?
        .with_no_client_auth()
        .with_cert_resolver(resolver);
    tls_config.alpn_protocols = vec![wtransport::proto::WEBTRANSPORT_ALPN.to_vec()];
    Ok(tls_config)
}

pub(crate) fn build_live_resolver_from_pem(
    cert_pem: &str,
    key_pem: &str,
) -> std::result::Result<Arc<LiveServerCertResolver>, String> {
    let default_cert = parse_certified_key(cert_pem, key_pem)?;
    Ok(Arc::new(LiveServerCertResolver::new(
        default_cert,
        HashMap::new(),
        UnknownSniPolicy::Reject,
    )))
}

pub(crate) fn parse_resolver_config(
    config: &ResolverConfig,
) -> std::result::Result<ParsedResolverConfig, String> {
    let default_cert = parse_certified_key(&config.default_cert_pem, &config.default_key_pem)?;
    let mut certs_by_name = HashMap::new();
    for sni_cert in &config.sni_certs {
        let server_name = normalize_server_name(&sni_cert.server_name)?;
        if certs_by_name.contains_key(&server_name) {
            return Err(format!("duplicate serverName entry: {}", server_name));
        }
        let certified_key = parse_certified_key(&sni_cert.cert_pem, &sni_cert.key_pem)?;
        certs_by_name.insert(server_name, certified_key);
    }
    Ok((default_cert, certs_by_name, config.unknown_sni_policy))
}

pub(crate) fn build_live_resolver_from_config(
    config: &ResolverConfig,
) -> std::result::Result<Arc<LiveServerCertResolver>, String> {
    let (default_cert, certs_by_name, unknown_sni_policy) = parse_resolver_config(config)?;
    Ok(Arc::new(LiveServerCertResolver::new(
        default_cert,
        certs_by_name,
        unknown_sni_policy,
    )))
}

pub(crate) fn build_default_dev_resolver(
) -> std::result::Result<Arc<LiveServerCertResolver>, String> {
    let identity = wtransport::Identity::self_signed(["localhost", "127.0.0.1", "::1"])
        .map_err(|e| format!("failed to create identity: {:?}", e))?;
    let cert_pem = identity
        .certificate_chain()
        .as_slice()
        .iter()
        .map(wtransport::tls::Certificate::to_pem)
        .collect::<Vec<_>>()
        .join("");
    build_live_resolver_from_pem(&cert_pem, &identity.private_key().to_secret_pem())
}

#[cfg(test)]
mod tests {
    use super::{
        build_default_dev_resolver, build_server_tls_config, parse_certified_key,
        parse_resolver_config, ResolverConfig, SniCertConfig, UnknownSniPolicy,
    };

    #[test]
    fn parse_certified_key_rejects_missing_certificates() {
        let err = parse_certified_key("", "").expect_err("expected parse error");
        assert!(err.contains("certificate PEM contained no certificates"));
    }

    #[test]
    fn default_dev_resolver_produces_cert() {
        let resolver = build_default_dev_resolver().expect("resolver");
        let tls_config = build_server_tls_config(resolver).expect("tls config");
        assert_eq!(
            tls_config.alpn_protocols,
            vec![wtransport::proto::WEBTRANSPORT_ALPN.to_vec()]
        );
    }

    #[test]
    fn parse_resolver_config_rejects_duplicate_server_name() {
        let identity = wtransport::Identity::self_signed(["localhost"]).expect("identity");
        let cert_pem = identity
            .certificate_chain()
            .as_slice()
            .iter()
            .map(wtransport::tls::Certificate::to_pem)
            .collect::<Vec<_>>()
            .join("");
        let key_pem = identity.private_key().to_secret_pem();
        let err = parse_resolver_config(&ResolverConfig {
            default_cert_pem: cert_pem.clone(),
            default_key_pem: key_pem.clone(),
            sni_certs: vec![
                SniCertConfig {
                    server_name: "foo.test".into(),
                    cert_pem: cert_pem.clone(),
                    key_pem: key_pem.clone(),
                },
                SniCertConfig {
                    server_name: "FOO.test".into(),
                    cert_pem,
                    key_pem,
                },
            ],
            unknown_sni_policy: UnknownSniPolicy::Reject,
        })
        .expect_err("expected duplicate serverName error");
        assert!(err.contains("duplicate serverName"));
    }
}
