#![no_main]

use libfuzzer_sys::fuzz_target;
use webtransport_wasm::{h3, varint};

fuzz_target!(|data: &[u8]| {
    let _ = varint::decode(data);
    let _ = h3::parse_settings(data);
    let _ = h3::unwrap_datagram(data);

    let frame_type = varint::decode(data).map(|(value, _)| value).unwrap_or(0);
    let payload = data.get(..4096).unwrap_or(data);
    let encoded = h3::frame_wrap(frame_type, payload);
    let _ = varint::decode(&encoded);
});
