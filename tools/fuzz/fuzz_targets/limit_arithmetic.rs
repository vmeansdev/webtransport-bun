#![no_main]

use libfuzzer_sys::fuzz_target;
use webtransport_wasm::governor::{Governor, StreamKind, WasmLimits};

fn u16_at(data: &[u8], offset: usize) -> usize {
    let lo = usize::from(*data.get(offset).unwrap_or(&0));
    let hi = usize::from(*data.get(offset + 1).unwrap_or(&0));
    lo | (hi << 8)
}

fuzz_target!(|data: &[u8]| {
    let stream_budget = u16_at(data, 0).saturating_add(1);
    let session_budget = stream_budget.saturating_add(u16_at(data, 2));
    let global_budget = session_budget.saturating_add(u16_at(data, 4));
    let limits = WasmLimits {
        max_sessions: u16_at(data, 6).min(128).saturating_add(1),
        max_handshakes_in_flight: u16_at(data, 8).min(128).saturating_add(1),
        max_streams_per_session_bidi: u16_at(data, 10).min(128).saturating_add(1),
        max_streams_per_session_uni: u16_at(data, 12).min(128).saturating_add(1),
        max_streams_global: u16_at(data, 14).min(256).saturating_add(129),
        max_datagram_size: u16_at(data, 16).max(1),
        max_queued_bytes_global: global_budget,
        max_queued_bytes_per_session: session_budget,
        max_queued_bytes_per_stream: stream_budget,
        backpressure_timeout_ms: u16_at(data, 18) as u64,
        handshake_timeout_ms: u16_at(data, 20) as u64,
        idle_timeout_ms: u16_at(data, 22) as u64,
    };
    let Ok(governor) = Governor::new(limits) else {
        return;
    };

    let conn = u32::try_from(u16_at(data, 24)).unwrap_or(0);
    let stream = u32::try_from(u16_at(data, 26)).unwrap_or(0);
    let bytes = u16_at(data, 28);
    let _handshake = governor.reserve_handshake();
    let _session = governor.reserve_session(conn);
    let _bidi = governor.reserve_stream(conn, stream, StreamKind::Bidi);
    let _uni = governor.reserve_stream(conn, stream.wrapping_add(1), StreamKind::Uni);
    if let Ok(reservation) = governor.reserve_event_bytes(conn, Some(stream), bytes) {
        if data.get(30).copied().unwrap_or(0) & 1 == 1 {
            if let Ok(token) = governor.transfer_to_host(reservation) {
                let _ = governor.release_host_token(token);
            }
        }
    }
    let _ = governor.snapshot(conn, Some(stream));
    let _ = governor.release_all_host_tokens();
});
