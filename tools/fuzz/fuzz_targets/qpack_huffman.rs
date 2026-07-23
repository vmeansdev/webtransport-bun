#![no_main]

use libfuzzer_sys::fuzz_target;
use webtransport_wasm::h3;

fuzz_target!(|data: &[u8]| {
    let _ = h3::decode_literal_headers(data);
});
