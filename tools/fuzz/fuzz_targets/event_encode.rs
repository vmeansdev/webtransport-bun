#![no_main]

use libfuzzer_sys::fuzz_target;
use webtransport_wasm::event::WtEvent;

fn u32_at(data: &[u8], offset: usize) -> u32 {
    let mut bytes = [0_u8; 4];
    if let Some(input) = data.get(offset..offset.saturating_add(4)) {
        bytes[..input.len()].copy_from_slice(input);
    }
    u32::from_le_bytes(bytes)
}

fn u64_at(data: &[u8], offset: usize) -> u64 {
    let mut bytes = [0_u8; 8];
    if let Some(input) = data.get(offset..offset.saturating_add(8)) {
        bytes[..input.len()].copy_from_slice(input);
    }
    u64::from_le_bytes(bytes)
}

fuzz_target!(|data: &[u8]| {
    let conn = u32_at(data, 0);
    let stream = u32_at(data, 4);
    let code = u32_at(data, 8);
    let token = u32_at(data, 12);
    let session_id = u64_at(data, 16);
    let payload = data.get(24..).unwrap_or_default().to_vec();

    let events = [
        WtEvent::Connected { conn },
        WtEvent::SessionEstablished { conn, session_id },
        WtEvent::Datagram {
            conn,
            session_id,
            data: payload.clone(),
        },
        WtEvent::ConnectionClosed { conn, code },
        WtEvent::SessionClosed {
            conn,
            session_id,
            code,
        },
        WtEvent::StreamOpened {
            conn,
            session_id,
            stream,
            bidi: code & 1 == 1,
        },
        WtEvent::StreamData {
            conn,
            stream,
            fin: code & 1 == 1,
            data: payload,
        },
        WtEvent::StreamReset { conn, stream, code },
        WtEvent::StreamStopped { conn, stream, code },
    ];

    for event in events {
        let _ = event.encode_with_host_token(Some(token));
    }
});
