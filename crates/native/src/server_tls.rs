use std::collections::HashMap;
use std::io::BufReader;
use std::sync::{Arc, RwLock};

use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use rustls::server::{ClientHello, ResolvesServerCert};
use rustls::sign::CertifiedKey;

#[derive(Clone)]
struct ResolverSnapshot {
    default_cert: Arc<CertifiedKey>,
    certs_by_name: HashMap<String, Arc<CertifiedKey>>,
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
    pub(crate) fn new(default_cert: Arc<CertifiedKey>) -> Self {
        Self {
            inner: RwLock::new(ResolverSnapshot {
                default_cert,
                certs_by_name: HashMap::new(),
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
    ) -> std::result::Result<(), String> {
        let mut inner = self
            .inner
            .write()
            .map_err(|_| "server cert resolver lock poisoned".to_string())?;
        inner.default_cert = default_cert;
        inner.certs_by_name = certs_by_name;
        Ok(())
    }
}

impl ResolvesServerCert for LiveServerCertResolver {
    fn resolve(&self, client_hello: ClientHello<'_>) -> Option<Arc<CertifiedKey>> {
        let inner = self.inner.read().ok()?;
        if let Some(server_name) = client_hello.server_name() {
            let key = server_name.to_ascii_lowercase();
            if let Some(cert) = inner.certs_by_name.get(&key) {
                return Some(Arc::clone(cert));
            }
        }
        Some(Arc::clone(&inner.default_cert))
    }
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
    Ok(Arc::new(LiveServerCertResolver::new(default_cert)))
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
    use super::{build_default_dev_resolver, build_server_tls_config, parse_certified_key};

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
}
