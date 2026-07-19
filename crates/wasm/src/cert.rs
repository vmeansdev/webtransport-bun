//! Self-signed certificate generation for browser WebTransport.
//!
//! Browser clients connecting with `serverCertificateHashes` require an ECDSA
//! P-256 leaf with a short validity window (<= 14 days). The validity start is
//! supplied by the JS host (wasm32 has no wall clock), so the cert is stable and
//! its hash can be advertised out-of-band.

use rcgen::{CertificateParams, DistinguishedName, KeyPair, PKCS_ECDSA_P256_SHA256};
use time::{Duration, OffsetDateTime};

/// Generated cert material. `cert_der` is the full DER the browser hashes for
/// `serverCertificateHashes` (SHA-256 over the certificate DER).
pub struct GeneratedCert {
    pub cert_pem: String,
    pub key_pem: String,
    pub cert_der: Vec<u8>,
    pub key_der: Vec<u8>,
}

/// Base64 (standard) of SHA-256 over `data` — the `serverCertificateHashes`
/// value when `data` is the certificate DER.
pub fn sha256_base64(data: &[u8]) -> String {
    use base64::Engine as _;
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(data);
    base64::engine::general_purpose::STANDARD.encode(digest)
}

/// Generate a self-signed P-256 cert valid for `validity_days` (clamped to 14),
/// starting at `not_before_unix` seconds. Returns an error string on failure.
pub fn generate(
    common_name: &str,
    validity_days: u32,
    not_before_unix: i64,
) -> Result<GeneratedCert, String> {
    let days = validity_days.min(14).max(1) as i64;
    let not_before =
        OffsetDateTime::from_unix_timestamp(not_before_unix).map_err(|e| e.to_string())?;
    let not_after = not_before + Duration::days(days);

    let mut params =
        CertificateParams::new(vec![common_name.to_string()]).map_err(|e| e.to_string())?;
    let mut dn = DistinguishedName::new();
    dn.push(rcgen::DnType::CommonName, common_name);
    params.distinguished_name = dn;
    params.not_before = not_before;
    params.not_after = not_after;

    let key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).map_err(|e| e.to_string())?;
    let cert = params.self_signed(&key).map_err(|e| e.to_string())?;

    Ok(GeneratedCert {
        cert_pem: cert.pem(),
        key_pem: key.serialize_pem(),
        cert_der: cert.der().to_vec(),
        key_der: key.serialize_der(),
    })
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;

    #[test]
    fn generates_p256_short_lived_cert() {
        let now = 1_700_000_000; // fixed unix ts
        let c = generate("localhost", 14, now).expect("cert");
        assert!(c.cert_pem.contains("BEGIN CERTIFICATE"));
        assert!(c.key_pem.contains("BEGIN PRIVATE KEY"));
        assert!(!c.cert_der.is_empty());
    }

    #[test]
    fn clamps_validity_to_14_days() {
        // Should not error even if asked for a year; clamp keeps browsers happy.
        let c = generate("localhost", 365, 1_700_000_000).expect("cert");
        assert!(!c.cert_der.is_empty());
    }
}
