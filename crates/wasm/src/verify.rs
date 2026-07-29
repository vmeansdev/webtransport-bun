//! Client-side certificate verification for the wasm backend.
//!
//! Mirrors the browser's `serverCertificateHashes` trust model: the server's
//! end-entity certificate is pinned by the SHA-256 of its DER encoding instead
//! of chain/name validation. The short-lived X.509 metadata policy and TLS 1.3
//! handshake signature are still verified, so this is NOT an accept-anything
//! path.

use std::collections::HashMap;
use std::sync::Arc;

use x509_parser::oid_registry::{
    OID_EC_P256, OID_KEY_TYPE_EC_PUBLIC_KEY, OID_SIG_ECDSA_WITH_SHA256,
};
use x509_parser::x509::X509Version;

const MAX_PINNED_CERT_VALIDITY_SECS: i64 = 14 * 24 * 60 * 60;
const INVALID_CERT_HASH: &str = "E_TLS: invalid server certificate hash";

fn application_verification_failure() -> rustls::Error {
    rustls::Error::InvalidCertificate(rustls::CertificateError::ApplicationVerificationFailure)
}

fn format_verify_error(err: impl std::fmt::Display) -> String {
    err.to_string()
}

fn ensure_p256_signature_scheme(scheme: rustls::SignatureScheme) -> Result<(), rustls::Error> {
    if scheme != rustls::SignatureScheme::ECDSA_NISTP256_SHA256 {
        return Err(application_verification_failure());
    }
    Ok(())
}

fn certificate_satisfies_pin_policy(der: &[u8], now: rustls::pki_types::UnixTime) -> bool {
    let Ok((remaining, cert)) = x509_parser::parse_x509_certificate(der) else {
        return false;
    };
    if !remaining.is_empty() || cert.version() != X509Version::V3 {
        return false;
    }

    let validity = cert.validity();
    let not_before = validity.not_before.timestamp();
    let not_after = validity.not_after.timestamp();
    let Ok(now) = i64::try_from(now.as_secs()) else {
        return false;
    };
    let Some(validity_secs) = not_after.checked_sub(not_before) else {
        return false;
    };
    if now < not_before
        || now > not_after
        || !(0..=MAX_PINNED_CERT_VALIDITY_SECS).contains(&validity_secs)
    {
        return false;
    }

    let public_key_algorithm = &cert.public_key().algorithm;
    let is_p256 = public_key_algorithm.algorithm == OID_KEY_TYPE_EC_PUBLIC_KEY
        && public_key_algorithm
            .parameters
            .as_ref()
            .and_then(|parameters| parameters.as_oid().ok())
            .is_some_and(|curve| curve == OID_EC_P256);
    if !is_p256 {
        return false;
    }

    let outer_signature = &cert.signature_algorithm;
    let tbs_signature = &cert.tbs_certificate.signature;
    outer_signature.algorithm == OID_SIG_ECDSA_WITH_SHA256
        && outer_signature.parameters.is_none()
        && tbs_signature == outer_signature
}

/// Fuzzing entry point for the pin-policy check (the `cert_pin_policy` target
/// in `tools/fuzz`): same code path as `verify_server_cert`, with the
/// verification time taken as raw Unix seconds so the fuzz crate does not need
/// a rustls dependency. Not used by production callers.
pub fn certificate_satisfies_pin_policy_at(der: &[u8], now_unix_secs: u64) -> bool {
    certificate_satisfies_pin_policy(
        der,
        rustls::pki_types::UnixTime::since_unix_epoch(std::time::Duration::from_secs(
            now_unix_secs,
        )),
    )
}

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
                .map_err(|_| INVALID_CERT_HASH.to_string())?;
            let arr: [u8; 32] = raw.try_into().map_err(|_| INVALID_CERT_HASH.to_string())?;
            out.push(arr);
        }
        if out.is_empty() {
            return Err(INVALID_CERT_HASH.to_string());
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
        now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        use sha2::{Digest, Sha256};
        let digest: [u8; 32] = Sha256::digest(end_entity.as_ref()).into();
        if !self.hashes.contains(&digest)
            || !certificate_satisfies_pin_policy(end_entity.as_ref(), now)
        {
            return Err(application_verification_failure());
        }
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        ensure_p256_signature_scheme(dss.scheme)?;
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
        ensure_p256_signature_scheme(dss.scheme)?;
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &rustls::crypto::ring::default_provider().signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        vec![rustls::SignatureScheme::ECDSA_NISTP256_SHA256]
    }
}

/// How a client decides whether to trust the server's certificate.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ClientTrust {
    /// Pin by SHA-256(DER) — the browser's `serverCertificateHashes` model and
    /// the default, since a wasm client has no system trust store to fall back on.
    Pinned(Vec<[u8; 32]>),
    /// Verify a normal certificate chain against caller-supplied CA roots.
    /// Nothing is trusted beyond these roots: there is no bundled root store.
    CaRoots(String),
}

impl ClientTrust {
    /// Read the trust model out of a client config object.
    ///
    /// Hash pinning stays the default; `caPem` opts into normal chain
    /// verification. Supplying both is an error rather than a silent
    /// preference, since that combination always means a misconfiguration.
    pub fn from_config(parsed: &serde_json::Value) -> Result<Self, String> {
        let field = |name: &str| {
            parsed
                .get(name)
                .and_then(|v| v.as_str())
                .filter(|s| !s.trim().is_empty())
        };
        match (field("certHashesBase64"), field("caPem")) {
            (Some(_), Some(_)) => {
                Err("E_TLS: certHashesBase64 and caPem are mutually exclusive".to_string())
            }
            (None, None) => Err("certHashesBase64 missing".to_string()),
            (Some(csv), None) => Ok(Self::Pinned(PinnedCertVerifier::parse_hashes(csv)?)),
            (None, Some(pem)) => Ok(Self::CaRoots(pem.to_string())),
        }
    }
}

/// Build a TLS 1.3 / h3 client config for the given trust model.
pub fn client_crypto(trust: ClientTrust) -> Result<rustls::ClientConfig, String> {
    match trust {
        ClientTrust::Pinned(hashes) => client_crypto_pinned(hashes),
        ClientTrust::CaRoots(pem) => client_crypto_ca_roots(&pem),
    }
}

/// Build a TLS 1.3 / h3 client config that verifies the server chain against
/// `ca_pem`, a PEM bundle of trust anchors supplied by the caller.
///
/// Certificate lifetimes are checked against `UnixTime::now()`. On wasm32 that
/// resolves through `rustls-pki-types`' `web` feature to `web-time`, i.e. the
/// browser's `Date.now()` — no custom `TimeProvider` is required.
pub fn client_crypto_ca_roots(ca_pem: &str) -> Result<rustls::ClientConfig, String> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let verifier = ca_roots_verifier(ca_pem, provider.clone())?;
    let mut cfg = rustls::ClientConfig::builder_with_provider(provider)
        .with_protocol_versions(&[&rustls::version::TLS13])
        .map_err(format_verify_error)?
        .with_webpki_verifier(verifier)
        .with_no_client_auth();
    cfg.alpn_protocols = vec![b"h3".to_vec()];
    Ok(cfg)
}

/// Build the webpki chain verifier for a PEM bundle of trust anchors.
fn ca_roots_verifier(
    ca_pem: &str,
    provider: Arc<rustls::crypto::CryptoProvider>,
) -> Result<Arc<rustls::client::WebPkiServerVerifier>, String> {
    let anchors = rustls_pemfile::certs(&mut ca_pem.as_bytes())
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("E_TLS: caPem: {e}"))?;
    if anchors.is_empty() {
        return Err("E_TLS: no certificates in caPem".to_string());
    }
    let mut roots = rustls::RootCertStore::empty();
    for anchor in anchors {
        roots
            .add(anchor)
            .map_err(|e| format!("E_TLS: caPem: {e}"))?;
    }

    rustls::client::WebPkiServerVerifier::builder_with_provider(Arc::new(roots), provider)
        .build()
        .map_err(|e| format!("E_TLS: caPem: {e}"))
}

/// Build a TLS 1.3 / h3 client config that pins the server cert by hash.
///
/// Configs for the same pin set share `verifier` / client-auth resolver Arcs
/// (via a process-local cache) so rustls resumption `compatible_config` stays
/// true when tickets are hydrated into a fresh endpoint's ticket store.
pub(crate) fn client_crypto_pinned(hashes: Vec<[u8; 32]>) -> Result<rustls::ClientConfig, String> {
    use std::sync::{Mutex, OnceLock};

    static CACHE: OnceLock<Mutex<HashMap<Vec<[u8; 32]>, rustls::ClientConfig>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let mut key = hashes;
    key.sort();
    {
        let guard = cache.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(cfg) = guard.get(&key) {
            return Ok(cfg.clone());
        }
    }
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut cfg = rustls::ClientConfig::builder_with_provider(provider)
        .with_protocol_versions(&[&rustls::version::TLS13])
        .map_err(format_verify_error)?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(PinnedCertVerifier::new(key.clone())))
        .with_no_client_auth();
    cfg.alpn_protocols = vec![b"h3".to_vec()];
    let mut guard = cache.lock().unwrap_or_else(|e| e.into_inner());
    Ok(guard.entry(key).or_insert(cfg).clone())
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use base64::Engine as _;
    use rustls::client::danger::ServerCertVerifier as _;
    use sha2::{Digest, Sha256};

    use super::PinnedCertVerifier;

    const VALID_P256: &str = "MIIBfzCCASWgAwIBAgIUXwpn6fOSji32DFHnVw7Sky3+hrowCgYIKoZIzj0EAwIwFTETMBEGA1UEAwwKdmFsaWQtcDI1NjAeFw0yNjA3MjIwNTM5NTRaFw0yNjA4MDUwNTM5NTRaMBUxEzARBgNVBAMMCnZhbGlkLXAyNTYwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAAStLKs6zsvjy6KjYyPzc8IR97TPh1KxwrVRh2lYt8bk4YAFgZfQjcjB5tIi7AU0RuNerC8sQhhSU44E4WL9GvFSo1MwUTAdBgNVHQ4EFgQUxEkHWuKQ+toG6v+o5bZsQiTkaKQwHwYDVR0jBBgwFoAUxEkHWuKQ+toG6v+o5bZsQiTkaKQwDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNIADBFAiEA58sCbUYcoBES7NUQq8FlBfXdNB0VLOTk138F4sWX/IICIHxdR+Fu75jRLDe8P80KcuKAgbUA7lA9u0QfYsfffAhq";
    const LONG_P256: &str = "MIIBfjCCASOgAwIBAgIUYq2K9L2ri/TM279Cs/kFIgDhmr8wCgYIKoZIzj0EAwIwFDESMBAGA1UEAwwJbG9uZy1wMjU2MB4XDTI2MDcyMjA1Mzk1NFoXDTI2MDgwNjA1Mzk1NFowFDESMBAGA1UEAwwJbG9uZy1wMjU2MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEBrllLTbdGhpvhNiMgYzcKt5xX+Nqeyu9NGH7WNXdWBv0GqjwTe1ZR5InfFj387Wuc4dQFfcj3eF2e7vLXFfpdqNTMFEwHQYDVR0OBBYEFC6osiqWTugtiZBXm4Lm3+uey2zAMB8GA1UdIwQYMBaAFC6osiqWTugtiZBXm4Lm3+uey2zAMA8GA1UdEwEB/wQFMAMBAf8wCgYIKoZIzj0EAwIDSQAwRgIhAJsxD5Quwbvd8ics+jVhFNRlh+yQDBT7gs5zImVCkHZQAiEAq33qzZuKwl6MIdDtOC8XF2Ff+b0SED2sy4zEYD4dgks=";
    const P384: &str = "MIIBsDCCATagAwIBAgIUGTBQU3N77JyAdKTC3VpK2yAabWkwCgYIKoZIzj0EAwIwDzENMAsGA1UEAwwEcDM4NDAeFw0yNjA3MjIwNTM5NTRaFw0yNjA4MDUwNTM5NTRaMA8xDTALBgNVBAMMBHAzODQwdjAQBgcqhkjOPQIBBgUrgQQAIgNiAASpdNjQtC50U0/cnb/QyyfNLAYDtDmfFxSsnAmUN8Sf/iKkGL4E3NavXqSQbQueWpbLjqX0oIbqalzT7TIdn2CPPYjfPNWXw3LKVQTi6QRoU75oL+vNyDXHlJiJjRu9al+jUzBRMB0GA1UdDgQWBBTOVU2dMZKryDSEMjFv8lxAC7pMzDAfBgNVHSMEGDAWgBTOVU2dMZKryDSEMjFv8lxAC7pMzDAPBgNVHRMBAf8EBTADAQH/MAoGCCqGSM49BAMCA2gAMGUCMCji2YB74VeHUveVaXkOhmcJ8yZUABXOdwZ5M55uPmrjRLaTPXbt73Vv3ALv48HdngIxANvn4DqfYSBc5u/W9UOGzsMcISoNkjDZU+qLSz2jJzYqFH9qehQZPL3ivXB5srH4LQ==";
    const RSA: &str = "MIIC/TCCAeWgAwIBAgIUasJcTmf7Pvmkf8+FX+HX3qSNWsMwDQYJKoZIhvcNAQELBQAwDjEMMAoGA1UEAwwDcnNhMB4XDTI2MDcyMjA1Mzk1NFoXDTI2MDgwNTA1Mzk1NFowDjEMMAoGA1UEAwwDcnNhMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAlwQKsvnOHgMKWdN6HE4rUK/udv6LUC4Pm4e1uEj+VVe0q1tCRTa5KLr4VmPFTLtxnykpuEFxTvCCFHAY0yJY1oUuxVfxHEjGFu0vnxKIujJsTXEMH0WA4BC/aGUL3DY1GF0LHhd5uMEiKl+8GH40z23rZ5X1JN/uNj5y6JGeQKvVnYc8NkfYwF0tLEkBGwUvy5SCu50kEVWIjW71BtKCuwlpuzMizDTxyauCY1L7HStRKhdhKxIgVsNzC9etAlyK0YhWbYgYF5O7g41llQ5kYmBw623a0bHcstKqHVcNl+iIWhoJ4PEzDtWN3BktEUSVPk5I6Bh3paFVpT5xqvdNswIDAQABo1MwUTAdBgNVHQ4EFgQUnvq1ywpJJWTNoVcvjXurW/X5k0YwHwYDVR0jBBgwFoAUnvq1ywpJJWTNoVcvjXurW/X5k0YwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEAJCyNQxLD+EHqb8O4JdQQUmWkSzsbatU+qXyndnqZE0vs83odIeH19QDWmvUWvHqtv/+ra+HLhyiHvZb5FtY7uhQ8Osi/8NTB9vHUZ3Iwt5+Rhwm8u3BJurHk+eAIKCGQmG/oI/s69TSQd6RwecOrAr5U+yU1cjVWFBAij0TOVXGWbMnx/lL+4sduSVcnZbNEabT3lKA0iA5iq86hcuhZTiRs20IlmAdHvC6jaWntxyPXcsX9BT1y+8pJdWbIhH0owpn03qOFWPN+sLUBo4n1Y+DjTDicDK4RJyef93MVfD53BTlioyEfBsuMM0jftO0hPwIgHpxsrPK9eKENgJgwrA==";
    const P256_SHA384: &str = "MIIBgTCCASegAwIBAgIUUKRj4mC7WU3KzPy/h85sSsA74zEwCgYIKoZIzj0EAwMwFjEUMBIGA1UEAwwLcDI1Ni1zaGEzODQwHhcNMjYwNzIyMDU0MDE5WhcNMjYwODA1MDU0MDE5WjAWMRQwEgYDVQQDDAtwMjU2LXNoYTM4NDBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABMbHDgNodow816TwxKOavSAAMGeFkV/WEXpZt22TNR5nKfc1bJ+siCqspFdbHfbBzxHaRQqHOfzjgTnPv9n/EfCjUzBRMB0GA1UdDgQWBBR65S4zSUu19npsOi386HKh70yH1zAfBgNVHSMEGDAWgBR65S4zSUu19npsOi386HKh70yH1zAPBgNVHRMBAf8EBTADAQH/MAoGCCqGSM49BAMDA0gAMEUCIQDja4ysVBu6oRFxKw5DyOlf9AAGHjJEd0bIa2KOz5GM7wIgchRbCtIIx56yJQLVCcY7+p2y6F6SzWHnDroiKUsGEXU=";

    fn fixture(encoded: &str) -> Vec<u8> {
        base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .expect("fixed fixture is valid base64")
    }

    fn validity(der: &[u8]) -> (u64, u64) {
        let (remaining, cert) =
            x509_parser::parse_x509_certificate(der).expect("fixed fixture is valid DER");
        assert!(remaining.is_empty());
        (
            cert.validity().not_before.timestamp() as u64,
            cert.validity().not_after.timestamp() as u64,
        )
    }

    fn verify_with_matching_pin(der: &[u8], now: u64) -> Result<(), rustls::Error> {
        let digest: [u8; 32] = Sha256::digest(der).into();
        let verifier = PinnedCertVerifier::new(vec![digest]);
        let cert = rustls::pki_types::CertificateDer::from(der);
        let server_name =
            rustls::pki_types::ServerName::try_from("localhost").expect("static server name");
        verifier
            .verify_server_cert(
                &cert,
                &[],
                &server_name,
                &[],
                rustls::pki_types::UnixTime::since_unix_epoch(Duration::from_secs(now)),
            )
            .map(|_| ())
    }

    fn assert_application_verification_failure(result: Result<(), rustls::Error>) {
        assert!(matches!(
            result,
            Err(rustls::Error::InvalidCertificate(
                rustls::CertificateError::ApplicationVerificationFailure
            ))
        ));
    }

    fn mutate_sequence(der: &mut [u8], needle: &[u8], offset: usize, value: u8) {
        let index = der
            .windows(needle.len())
            .position(|window| window == needle)
            .expect("fixture contains mutation target");
        der[index + offset] = value;
    }

    #[test]
    fn verify_server_cert_valid_p256_pin_should_pass() {
        let der = fixture(VALID_P256);
        let (not_before, not_after) = validity(&der);
        verify_with_matching_pin(&der, not_before + (not_after - not_before) / 2)
            .expect("valid pinned certificate");
    }

    #[test]
    fn parse_hashes_invalid_input_should_return_stable_tls_error() {
        const EXPECTED: &str = "E_TLS: invalid server certificate hash";
        let wrong_length = base64::engine::general_purpose::STANDARD.encode([0_u8; 31]);

        for input in ["", ",", "not-base64", wrong_length.as_str()] {
            assert_eq!(
                PinnedCertVerifier::parse_hashes(input).expect_err("invalid hash must fail"),
                EXPECTED
            );
        }
    }

    #[test]
    fn verify_server_cert_invalid_metadata_with_matching_pin_should_fail_closed() {
        let valid = fixture(VALID_P256);
        let (not_before, not_after) = validity(&valid);
        assert_application_verification_failure(verify_with_matching_pin(&valid, not_before - 1));
        assert_application_verification_failure(verify_with_matching_pin(&valid, not_after + 1));

        for encoded in [LONG_P256, P384, RSA, P256_SHA384] {
            let der = fixture(encoded);
            let (fixture_start, fixture_end) = validity(&der);
            assert_application_verification_failure(verify_with_matching_pin(
                &der,
                fixture_start + (fixture_end - fixture_start) / 2,
            ));
        }

        let mut v1 = valid.clone();
        mutate_sequence(&mut v1, &[0xa0, 0x03, 0x02, 0x01, 0x02], 4, 0x00);
        assert_application_verification_failure(verify_with_matching_pin(&v1, not_before));

        let mut malformed_oid = valid.clone();
        mutate_sequence(
            &mut malformed_oid,
            &[0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07],
            1,
            0xff,
        );
        assert_application_verification_failure(verify_with_matching_pin(
            &malformed_oid,
            not_before,
        ));

        let mut malformed_time = valid.clone();
        mutate_sequence(&mut malformed_time, &[0x17, 0x0d], 2, b'X');
        assert_application_verification_failure(verify_with_matching_pin(
            &malformed_time,
            not_before,
        ));

        let mut trailing_data = valid;
        trailing_data.push(0);
        assert_application_verification_failure(verify_with_matching_pin(
            &trailing_data,
            not_before,
        ));

        assert_application_verification_failure(verify_with_matching_pin(
            &[0x30, 0x82, 0xff, 0xff],
            not_before,
        ));
    }

    #[test]
    fn verify_server_cert_deterministic_malformed_der_corpus_should_never_panic_or_accept() {
        let mut state = 0x9e37_79b9_u32;
        for case in 0..10_000_u32 {
            let len = 4 + (case as usize % 509);
            let mut der = vec![0_u8; len];
            der[0] = 0x30;
            der[1] = 0x82;
            der[2] = 0xff;
            der[3] = 0xff;
            for byte in &mut der[4..] {
                state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                *byte = (state >> 24) as u8;
            }
            assert_application_verification_failure(verify_with_matching_pin(&der, 0));
        }
    }

    #[test]
    fn certificate_satisfies_pin_policy_at_mirrors_unix_time_helper() {
        let der = fixture(VALID_P256);
        let (not_before, not_after) = validity(&der);
        let mid = not_before + (not_after - not_before) / 2;
        assert!(super::certificate_satisfies_pin_policy_at(&der, mid));
        assert!(!super::certificate_satisfies_pin_policy_at(
            &der,
            not_before.saturating_sub(1)
        ));
        // Seconds that cannot fit in i64 must fail closed (fuzz/host clock safety).
        assert!(!super::certificate_satisfies_pin_policy_at(&der, u64::MAX));
    }

    #[test]
    fn parse_hashes_accepts_csv_and_client_crypto_builds() {
        let der = fixture(VALID_P256);
        let digest: [u8; 32] = Sha256::digest(&der).into();
        let encoded = base64::engine::general_purpose::STANDARD.encode(digest);
        let hashes = PinnedCertVerifier::parse_hashes(&format!(" ,{encoded}, "))
            .expect("trimmed valid hash");
        assert_eq!(hashes, vec![digest]);

        let cfg = super::client_crypto_pinned(hashes).expect("pinned client crypto");
        assert_eq!(cfg.alpn_protocols, vec![b"h3".to_vec()]);

        let verifier = PinnedCertVerifier::new(vec![digest]);
        assert_eq!(
            verifier.supported_verify_schemes(),
            vec![rustls::SignatureScheme::ECDSA_NISTP256_SHA256]
        );
    }

    #[test]
    fn ca_roots_client_crypto_builds_from_a_pem_bundle() {
        let ca = crate::cert::generate("ca.example", 14, 1_700_000_000).expect("ca cert");
        let cfg = super::client_crypto_ca_roots(&ca.cert_pem).expect("ca client crypto");
        assert_eq!(cfg.alpn_protocols, vec![b"h3".to_vec()]);

        // Multiple anchors in one bundle are all installed.
        let second = crate::cert::generate("ca2.example", 14, 1_700_000_000).expect("ca2 cert");
        let bundle = format!("{}\n{}", ca.cert_pem, second.cert_pem);
        super::client_crypto_ca_roots(&bundle).expect("multi-anchor bundle");

        // The trust dispatcher routes to the same builders.
        super::client_crypto(super::ClientTrust::CaRoots(ca.cert_pem.clone()))
            .expect("dispatched ca crypto");
        let digest: [u8; 32] = Sha256::digest(fixture(VALID_P256)).into();
        super::client_crypto(super::ClientTrust::Pinned(vec![digest]))
            .expect("dispatched pinned crypto");
    }

    #[test]
    fn ca_roots_verifier_accepts_a_leaf_issued_by_the_trusted_anchor_only() {
        let now_unix = 1_700_000_000;
        let chain = crate::cert::generate_ca_signed("localhost", 14, now_unix).expect("chain");
        let other =
            crate::cert::generate_ca_signed("other.example", 14, now_unix).expect("other chain");

        let verify_against = |ca_pem: &str| {
            let verifier = super::ca_roots_verifier(
                ca_pem,
                std::sync::Arc::new(rustls::crypto::ring::default_provider()),
            )
            .expect("ca verifier");
            let leaf = rustls::pki_types::CertificateDer::from(chain.leaf.cert_der.clone());
            let server_name =
                rustls::pki_types::ServerName::try_from("localhost").expect("static server name");
            verifier
                .verify_server_cert(
                    &leaf,
                    &[],
                    &server_name,
                    &[],
                    rustls::pki_types::UnixTime::since_unix_epoch(Duration::from_secs(
                        now_unix as u64 + 3600,
                    )),
                )
                .map(|_| ())
        };

        verify_against(&chain.ca_pem).expect("leaf must verify against its own CA");
        let rejected = verify_against(&other.ca_pem).expect_err("foreign CA must not verify");
        assert!(
            matches!(
                rejected,
                rustls::Error::InvalidCertificate(rustls::CertificateError::UnknownIssuer)
            ),
            "unexpected rejection: {rejected}"
        );
    }

    #[test]
    fn client_trust_from_config_picks_pinning_or_ca_roots() {
        use super::ClientTrust;

        let digest: [u8; 32] = Sha256::digest(fixture(VALID_P256)).into();
        let encoded = base64::engine::general_purpose::STANDARD.encode(digest);

        assert_eq!(
            ClientTrust::from_config(&serde_json::json!({ "certHashesBase64": encoded }))
                .expect("pinned trust"),
            ClientTrust::Pinned(vec![digest])
        );
        assert_eq!(
            ClientTrust::from_config(&serde_json::json!({ "caPem": "roots" })).expect("ca trust"),
            ClientTrust::CaRoots("roots".to_string())
        );

        // Blank strings count as absent, so an unset option is not mistaken
        // for an empty trust set.
        assert_eq!(
            ClientTrust::from_config(
                &serde_json::json!({ "certHashesBase64": encoded, "caPem": "  " })
            )
            .expect("blank caPem ignored"),
            ClientTrust::Pinned(vec![digest])
        );

        let err = ClientTrust::from_config(
            &serde_json::json!({ "certHashesBase64": encoded, "caPem": "roots" }),
        )
        .expect_err("both trust models supplied");
        assert!(err.starts_with("E_TLS"), "unexpected error: {err}");
        assert!(err.contains("mutually exclusive"));

        let err =
            ClientTrust::from_config(&serde_json::json!({})).expect_err("no trust model supplied");
        assert!(err.contains("certHashesBase64 missing"));

        // A malformed pin still maps to the pin-specific E_TLS error.
        let err = ClientTrust::from_config(&serde_json::json!({ "certHashesBase64": "!!" }))
            .expect_err("malformed pin");
        assert!(err.starts_with("E_TLS"), "unexpected error: {err}");
    }

    #[test]
    fn ca_roots_reject_malformed_bundles_with_stable_tls_errors() {
        // Every rejection must map to E_TLS, matching how native reports a bad
        // caPem — never a generic internal error.
        for bad in [
            "",
            "   ",
            "not a pem at all",
            "-----BEGIN CERTIFICATE-----\nZm9v\n-----END CERTIFICATE-----",
        ] {
            let err =
                super::client_crypto_ca_roots(bad).expect_err("malformed caPem must be rejected");
            assert!(
                err.starts_with("E_TLS"),
                "unexpected error for {bad:?}: {err}"
            );
        }

        // A PEM carrying a private key rather than a certificate is not a root.
        let gen = crate::cert::generate("key.example", 14, 1_700_000_000).expect("cert");
        let err = super::client_crypto_ca_roots(&gen.key_pem).expect_err("key pem is not a root");
        assert!(err.starts_with("E_TLS"), "unexpected error: {err}");
    }

    #[test]
    fn verify_tls_signatures_reject_non_p256_schemes() {
        assert!(matches!(
            super::ensure_p256_signature_scheme(rustls::SignatureScheme::RSA_PKCS1_SHA256),
            Err(rustls::Error::InvalidCertificate(
                rustls::CertificateError::ApplicationVerificationFailure
            ))
        ));
        assert!(super::ensure_p256_signature_scheme(
            rustls::SignatureScheme::ECDSA_NISTP256_SHA256
        )
        .is_ok());
        assert_eq!(super::format_verify_error("x"), "x");
    }
}
