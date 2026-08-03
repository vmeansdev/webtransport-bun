#![no_main]

use std::net::SocketAddr;

use libfuzzer_sys::fuzz_target;
use web_time::Instant;
use webtransport_wasm::{
    endpoint::WtEndpoint,
    event::tag,
    governor::{WasmLimits, WasmRateLimits},
    varint,
};

fn bounded_limits(data: &[u8]) -> WasmLimits {
    let byte = |index: usize, default: u8| usize::from(*data.get(index).unwrap_or(&default));
    WasmLimits {
        max_sessions: byte(0, 4).max(1),
        max_handshakes_in_flight: byte(1, 8).max(1),
        max_streams_per_session_bidi: byte(2, 8).max(1),
        max_streams_per_session_uni: byte(3, 8).max(1),
        max_streams_global: byte(4, 32).max(8),
        max_datagram_size: byte(5, 32).max(1),
        max_queued_bytes_global: byte(6, 128).max(32),
        max_queued_bytes_per_session: byte(7, 64).max(16),
        max_queued_bytes_per_stream: byte(8, 32).max(8),
        backpressure_timeout_ms: u64::from(*data.get(9).unwrap_or(&10)).max(1),
        handshake_timeout_ms: u64::from(*data.get(10).unwrap_or(&10)).max(1),
        idle_timeout_ms: u64::from(*data.get(11).unwrap_or(&30)).max(1),
    }
}

fn payload(data: &[u8], offset: usize) -> &[u8] {
    data.get(offset..offset.saturating_add(32))
        .unwrap_or_default()
}

fn take_varint(buf: &[u8], offset: &mut usize) -> Option<u64> {
    let (value, consumed) = varint::decode(buf.get(*offset..)?)?;
    *offset = offset.checked_add(consumed)?;
    Some(value)
}

fn maybe_release_host_token(endpoint: &mut WtEndpoint, encoded: &[u8]) {
    let Some(tag_value) = encoded.first().copied() else {
        return;
    };
    let mut offset = 1_usize;
    match tag_value {
        tag::DATAGRAM => {
            let _ = take_varint(encoded, &mut offset);
            let Some(length) =
                take_varint(encoded, &mut offset).and_then(|value| usize::try_from(value).ok())
            else {
                return;
            };
            offset = offset.saturating_add(length).min(encoded.len());
            let Some(token) =
                take_varint(encoded, &mut offset).and_then(|value| u32::try_from(value).ok())
            else {
                return;
            };
            if token != 0 {
                let _ = endpoint.release_host_token(token);
            }
        }
        tag::STREAM_DATA => {
            let _ = take_varint(encoded, &mut offset);
            let _ = take_varint(encoded, &mut offset);
            offset = offset.saturating_add(1).min(encoded.len());
            let Some(length) =
                take_varint(encoded, &mut offset).and_then(|value| usize::try_from(value).ok())
            else {
                return;
            };
            offset = offset.saturating_add(length).min(encoded.len());
            let Some(token) =
                take_varint(encoded, &mut offset).and_then(|value| u32::try_from(value).ok())
            else {
                return;
            };
            if token != 0 {
                let _ = endpoint.release_host_token(token);
            }
        }
        _ => {}
    }
}

fn extract_conn(encoded: &[u8]) -> Option<u32> {
    let mut offset = 1_usize;
    take_varint(encoded, &mut offset).and_then(|value| u32::try_from(value).ok())
}

/// SESSION_ESTABLISHED wire: tag, conn varint, session_id varint.
fn extract_session(encoded: &[u8]) -> Option<(u32, u64)> {
    if encoded.first().copied() != Some(tag::SESSION_ESTABLISHED) {
        return None;
    }
    let mut offset = 1_usize;
    let conn = take_varint(encoded, &mut offset).and_then(|value| u32::try_from(value).ok())?;
    let session_id = take_varint(encoded, &mut offset)?;
    Some((conn, session_id))
}

fn pump(from: &mut WtEndpoint, source: SocketAddr, to: &mut WtEndpoint, now: Instant) {
    let mut packets = Vec::new();
    from.poll_transmits(now, &mut packets);
    for (packet, _) in packets {
        to.recv(now, source, &packet);
    }
}

fn drain_events(
    endpoint: &mut WtEndpoint,
    observed_conn: &mut Option<u32>,
    observed_session: &mut Option<(u32, u64)>,
) {
    for _ in 0..64 {
        let Some(encoded) = endpoint.poll_event_encoded() else {
            break;
        };
        if observed_conn.is_none() {
            *observed_conn = extract_conn(&encoded);
        }
        if observed_session.is_none() {
            *observed_session = extract_session(&encoded);
        }
        maybe_release_host_token(endpoint, &encoded);
    }
}

fuzz_target!(|data: &[u8]| {
    let limits = bounded_limits(data);
    let rate_limits = WasmRateLimits::default();
    let server_addr = SocketAddr::from(([127, 0, 0, 1], 4433));
    let client_addr = SocketAddr::from(([127, 0, 0, 1], 5544));
    let Ok(mut server) = WtEndpoint::new_with_limits_and_rate_limits(
        true,
        server_addr,
        client_addr,
        limits.clone(),
        rate_limits.clone(),
    ) else {
        return;
    };
    let Ok(mut client) = WtEndpoint::new_with_limits_and_rate_limits(
        false,
        client_addr,
        server_addr,
        limits,
        rate_limits,
    ) else {
        return;
    };

    let client_conn = client.connect("https://localhost:4433");
    if client_conn < 0 {
        return;
    }
    let client_conn = client_conn as u32;
    let mut server_conn = None;
    let mut client_session: Option<(u32, u64)> = None;
    let mut server_session: Option<(u32, u64)> = None;
    let mut offset = 12_usize;

    for _ in 0..32 {
        let now = Instant::now();
        pump(&mut client, client_addr, &mut server, now);
        pump(&mut server, server_addr, &mut client, now);
        drain_events(&mut client, &mut None, &mut client_session);
        drain_events(&mut server, &mut server_conn, &mut server_session);

        match data.get(offset).copied().unwrap_or(0) % 5 {
            0 => {
                if let Some((_, session_id)) = client_session {
                    let _ =
                        client.send_datagram(client_conn, session_id, payload(data, offset + 1));
                }
            }
            1 => {
                if let Some((_, session_id)) = client_session {
                    let stream = client.open_stream(client_conn, session_id, true);
                    if stream >= 0 {
                        let stream = stream as u32;
                        let _ = client.stream_write(stream, payload(data, offset + 1));
                        client.stream_finish(stream);
                    }
                }
            }
            2 => {
                if let Some((conn, session_id)) = server_session {
                    let _ = server.send_datagram(conn, session_id, payload(data, offset + 1));
                }
            }
            3 => {
                if let Some((conn, session_id)) = server_session {
                    let stream = server.open_stream(conn, session_id, true);
                    if stream >= 0 {
                        let stream = stream as u32;
                        let _ = server.stream_write(stream, payload(data, offset + 1));
                        server.stream_finish(stream);
                    }
                }
            }
            _ => {
                if let Some(conn) = server_conn {
                    server.close_conn(conn, 0, b"fuzz", Instant::now());
                }
            }
        }

        if client.next_timeout_ms() >= 0.0 {
            client.handle_timeout(Instant::now());
        }
        if server.next_timeout_ms() >= 0.0 {
            server.handle_timeout(Instant::now());
        }
        offset = offset.saturating_add(33);
    }
});
