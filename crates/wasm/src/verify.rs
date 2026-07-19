//! Client-side certificate verification for the wasm backend.
//!
//! Mirrors the browser's `serverCertificateHashes` trust model: the server's
//! end-entity certificate is pinned by the SHA-256 of its DER encoding instead
//! of chain/name/time validation. TLS 1.3 handshake signatures are still
//! verified with the provider's real algorithms, so possession of the pinned
//! certificate's private key is proven — this is NOT an accept-anything path.

use std::sync::Arc;

/// Pin the server certificate by SHA-256(DER). Connection fails with a
/// certificate error unless the presented end-entity cert matches one of the
/// expected hashes.
#[derive(Debug)]
pub(crate) struct PinnedCertVerifier {
    hashes: Vec<[u8; 32]>,
}

impl PinnedCertVerifier {
    pub(crate) fn new(hashes: Vec<[u8; 32]>) -> Self {
        Self { hashes }
    }

    /// Parse a comma-separated list of base64 SHA-256 hashes (the same string
    /// `wt_generate_cert` / `wt_new_server` hand out as `hashBase64`).
    // Called from the wasm-only bridge and from tests; unused in the native
    // non-test lib build.
    #[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
    pub(crate) fn parse_hashes(csv: &str) -> Result<Vec<[u8; 32]>, String> {
        use base64::Engine as _;
        let mut out = Vec::new();
        for part in csv.split(',') {
            let part = part.trim();
            if part.is_empty() {
                continue;
            }
            let raw = base64::engine::general_purpose::STANDARD
                .decode(part)
                .map_err(|e| format!("invalid base64 cert hash: {e}"))?;
            let arr: [u8; 32] = raw
                .try_into()
                .map_err(|_| "cert hash must be 32 bytes (SHA-256)".to_string())?;
            out.push(arr);
        }
        if out.is_empty() {
            return Err("at least one cert hash is required".to_string());
        }
        Ok(out)
    }
}

impl rustls::client::danger::ServerCertVerifier for PinnedCertVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &rustls::pki_types::CertificateDer<'_>,
        _intermediates: &[rustls::pki_types::CertificateDer<'_>],
        _server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        use sha2::{Digest, Sha256};
        let digest: [u8; 32] = Sha256::digest(end_entity.as_ref()).into();
        if self.hashes.iter().any(|h| *h == digest) {
            Ok(rustls::client::danger::ServerCertVerified::assertion())
        } else {
            Err(rustls::Error::InvalidCertificate(
                rustls::CertificateError::ApplicationVerificationFailure,
            ))
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &rustls::crypto::ring::default_provider().signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &rustls::crypto::ring::default_provider().signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        rustls::crypto::ring::default_provider()
            .signature_verification_algorithms
            .supported_schemes()
    }
}

/// Build a TLS 1.3 / h3 client config that pins the server cert by hash.
pub(crate) fn client_crypto_pinned(hashes: Vec<[u8; 32]>) -> Result<rustls::ClientConfig, String> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut cfg = rustls::ClientConfig::builder_with_provider(provider)
        .with_protocol_versions(&[&rustls::version::TLS13])
        .map_err(|e| e.to_string())?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(PinnedCertVerifier::new(hashes)))
        .with_no_client_auth();
    cfg.alpn_protocols = vec![b"h3".to_vec()];
    Ok(cfg)
}
