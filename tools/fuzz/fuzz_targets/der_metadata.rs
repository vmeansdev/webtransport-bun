#![no_main]

use libfuzzer_sys::fuzz_target;
use webtransport_wasm::cert;
use x509_parser::parse_x509_certificate;

fuzz_target!(|data: &[u8]| {
    let _ = cert::sha256_base64(data);
    if let Ok((remaining, certificate)) = parse_x509_certificate(data) {
        let _ = certificate.validity().not_before.timestamp();
        let _ = certificate.validity().not_after.timestamp();
        let _ = certificate.public_key().algorithm.algorithm.to_id_string();
        let _ = remaining.len();
    }
});
