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

/// Map an underlying crypto/time error into a stable string for the JS host.
fn format_cert_error(err: impl std::fmt::Display) -> String {
    err.to_string()
}

fn validity_end_out_of_range() -> String {
    "certificate validity end is outside the supported time range".to_string()
}

/// Clamp requested validity into the browser-accepted `1..=14` day window.
pub(crate) fn clamp_validity_days(validity_days: u32) -> i64 {
    i64::from(validity_days.clamp(1, 14))
}

/// Generate a self-signed P-256 cert valid for `validity_days` (clamped to 14),
/// starting at `not_before_unix` seconds. Returns an error string on failure.
pub fn generate(
    common_name: &str,
    validity_days: u32,
    not_before_unix: i64,
) -> Result<GeneratedCert, String> {
    let days = clamp_validity_days(validity_days);
    let not_before =
        OffsetDateTime::from_unix_timestamp(not_before_unix).map_err(format_cert_error)?;
    let not_after = not_before
        .checked_add(Duration::days(days))
        .ok_or_else(validity_end_out_of_range)?;

    let mut params =
        CertificateParams::new(vec![common_name.to_string()]).map_err(format_cert_error)?;
    let mut dn = DistinguishedName::new();
    dn.push(rcgen::DnType::CommonName, common_name);
    params.distinguished_name = dn;
    params.not_before = not_before;
    params.not_after = not_after;

    let key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).map_err(format_cert_error)?;
    let cert = params.self_signed(&key).map_err(format_cert_error)?;

    Ok(GeneratedCert {
        cert_pem: cert.pem(),
        key_pem: key.serialize_pem(),
        cert_der: cert.der().to_vec(),
        key_der: key.serialize_der(),
    })
}

/// A CA cert plus a leaf issued by it — the shape `caPem` client trust needs,
/// which `generate` cannot produce (a self-signed leaf is not a trust anchor).
///
/// TEST/DEV ONLY, gated exactly like the accept-any client verifier: a shipped
/// (`wasm-dist`) build compiles this out entirely. Production servers get their
/// chain from a real CA; the wasm backend never mints one.
#[cfg(any(feature = "dev-insecure", all(test, not(target_arch = "wasm32"))))]
pub struct GeneratedChain {
    pub ca_pem: String,
    pub leaf: GeneratedCert,
}

/// Issue a P-256 leaf for `common_name` under a freshly minted P-256 CA. The
/// leaf honours the same `1..=14` day clamp as [`generate`]; the CA shares the
/// leaf's window so the whole chain is valid over exactly that period.
#[cfg(any(feature = "dev-insecure", all(test, not(target_arch = "wasm32"))))]
pub fn generate_ca_signed(
    common_name: &str,
    validity_days: u32,
    not_before_unix: i64,
) -> Result<GeneratedChain, String> {
    use rcgen::{BasicConstraints, ExtendedKeyUsagePurpose, IsCa, Issuer, KeyUsagePurpose};

    let days = clamp_validity_days(validity_days);
    let not_before =
        OffsetDateTime::from_unix_timestamp(not_before_unix).map_err(format_cert_error)?;
    let not_after = not_before
        .checked_add(Duration::days(days))
        .ok_or_else(validity_end_out_of_range)?;

    let mut ca_params = CertificateParams::new(Vec::<String>::new()).map_err(format_cert_error)?;
    let mut ca_dn = DistinguishedName::new();
    ca_dn.push(rcgen::DnType::CommonName, format!("{common_name} test ca"));
    ca_params.distinguished_name = ca_dn;
    ca_params.not_before = not_before;
    ca_params.not_after = not_after;
    ca_params.is_ca = IsCa::Ca(BasicConstraints::Constrained(0));
    ca_params.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
    let ca_key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).map_err(format_cert_error)?;
    let ca_cert = ca_params.self_signed(&ca_key).map_err(format_cert_error)?;

    let mut leaf_params =
        CertificateParams::new(vec![common_name.to_string()]).map_err(format_cert_error)?;
    let mut leaf_dn = DistinguishedName::new();
    leaf_dn.push(rcgen::DnType::CommonName, common_name);
    leaf_params.distinguished_name = leaf_dn;
    leaf_params.not_before = not_before;
    leaf_params.not_after = not_after;
    leaf_params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];

    let leaf_key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).map_err(format_cert_error)?;
    let issuer = Issuer::from_params(&ca_params, &ca_key);
    let leaf = leaf_params
        .signed_by(&leaf_key, &issuer)
        .map_err(format_cert_error)?;

    Ok(GeneratedChain {
        ca_pem: ca_cert.pem(),
        leaf: GeneratedCert {
            cert_pem: leaf.pem(),
            key_pem: leaf_key.serialize_pem(),
            cert_der: leaf.der().to_vec(),
            key_der: leaf_key.serialize_der(),
        },
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
        assert!(!c.key_der.is_empty());
        assert_eq!(sha256_base64(&c.cert_der).len(), 44);
    }

    #[test]
    fn clamps_validity_to_14_days() {
        // Should not error even if asked for a year; clamp keeps browsers happy.
        assert_eq!(clamp_validity_days(0), 1);
        assert_eq!(clamp_validity_days(14), 14);
        assert_eq!(clamp_validity_days(365), 14);
        let c = generate("localhost", 365, 1_700_000_000).expect("cert");
        assert!(!c.cert_der.is_empty());
    }

    #[test]
    fn ca_signed_chain_has_a_real_anchor_and_a_clamped_leaf() {
        let now = 1_700_000_000;
        let chain = generate_ca_signed("localhost", 365, now).expect("chain");
        assert!(chain.ca_pem.contains("BEGIN CERTIFICATE"));
        assert!(chain.leaf.cert_pem.contains("BEGIN CERTIFICATE"));

        let ca_der = pem_to_der(&chain.ca_pem);
        let (_, ca) = x509_parser::parse_x509_certificate(&ca_der).expect("ca der");
        assert!(
            ca.basic_constraints()
                .expect("bc")
                .expect("present")
                .value
                .ca
        );

        let (_, leaf) =
            x509_parser::parse_x509_certificate(&chain.leaf.cert_der).expect("leaf der");
        assert!(leaf
            .basic_constraints()
            .expect("bc")
            .is_none_or(|bc| !bc.value.ca));
        assert_eq!(leaf.issuer(), ca.subject(), "leaf must chain to the CA");
        assert_ne!(
            leaf.issuer(),
            leaf.subject(),
            "leaf must not be self-issued"
        );

        let validity = leaf.validity();
        assert_eq!(validity.not_before.timestamp(), now);
        assert_eq!(
            validity.not_after.timestamp() - validity.not_before.timestamp(),
            14 * 24 * 60 * 60,
            "leaf validity must stay inside the 14-day browser window"
        );
    }

    fn pem_to_der(pem: &str) -> Vec<u8> {
        rustls_pemfile::certs(&mut pem.as_bytes())
            .next()
            .expect("one certificate")
            .expect("valid pem")
            .to_vec()
    }

    #[test]
    fn generate_near_maximum_timestamp_should_return_error_instead_of_panicking() {
        let error = match generate("localhost", 14, 253_402_300_799) {
            Ok(_) => panic!("validity arithmetic must fail closed"),
            Err(error) => error,
        };
        assert_eq!(error, validity_end_out_of_range());
    }

    #[test]
    fn generate_rejects_out_of_range_unix_timestamp() {
        let error = match generate("localhost", 1, i64::MIN) {
            Ok(_) => panic!("invalid unix time must fail"),
            Err(error) => error,
        };
        assert!(!error.is_empty());
        assert_eq!(format_cert_error("boom"), "boom");
    }
}
