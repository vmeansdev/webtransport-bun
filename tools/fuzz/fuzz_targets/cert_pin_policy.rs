#![no_main]

use libfuzzer_sys::fuzz_target;
use webtransport_wasm::verify::certificate_satisfies_pin_policy_at;

// Fuzz the security-critical certificate pin policy (14-day validity window,
// P-256 / ECDSA-SHA256 gating) end to end: the first 8 bytes select the
// verification time so the validity-window arithmetic is exercised alongside
// the DER parsing, the rest is the candidate certificate.
fuzz_target!(|data: &[u8]| {
    let (now_unix_secs, der) = match data.split_first_chunk::<8>() {
        Some((secs, rest)) => (u64::from_le_bytes(*secs), rest),
        None => (0, data),
    };
    let _ = certificate_satisfies_pin_policy_at(der, now_unix_secs);
});
