use super::*;

const CADDR: &str = "127.0.0.1:5544";
const SADDR: &str = "127.0.0.1:4433";

#[test]
fn build_missing_server_crypto_should_return_stable_error_instead_of_panicking() {
    let peer_addr: SocketAddr = CADDR.parse().expect("fixed peer address");
    let error = match WtEndpoint::build(
        true,
        peer_addr,
        None,
        None,
        WasmLimits::default(),
        WasmRateLimits::default(),
        false,
        false,
        CongestionControlMode::Default,
    ) {
        Ok(_) => panic!("missing server crypto must fail closed"),
        Err(error) => error,
    };
    assert_eq!(error, "E_INTERNAL: server config required");
}

#[test]
fn configured_handshake_and_idle_deadlines_drive_the_endpoint() {
    let caddr: SocketAddr = CADDR.parse().unwrap();
    let saddr: SocketAddr = SADDR.parse().unwrap();
    let limits = WasmLimits {
        handshake_timeout_ms: 17,
        idle_timeout_ms: 29,
        ..WasmLimits::default()
    };
    let mut client = WtEndpoint::new_with_limits(false, caddr, saddr, limits).unwrap();
    assert_eq!(client.idle_timeout_ms, 29);

    let before = Instant::now();
    let conn = client.connect("localhost") as u32;
    let after = Instant::now();
    let handle = client.id_to_handle[&conn];
    let deadline = client.sessions[&handle]
        .connect_deadline
        .expect("connect deadline");
    assert!(deadline >= before + std::time::Duration::from_millis(17));
    assert!(deadline <= after + std::time::Duration::from_millis(17));
    assert!(client.next_timeout_ms() <= 17.0);
}

#[test]
fn rust_event_bytes_stay_reserved_through_bridge_transfer_and_teardown() {
    let caddr: SocketAddr = CADDR.parse().unwrap();
    let saddr: SocketAddr = SADDR.parse().unwrap();
    let limits = WasmLimits {
        max_datagram_size: 4,
        max_queued_bytes_global: 4,
        max_queued_bytes_per_session: 4,
        max_queued_bytes_per_stream: 4,
        ..WasmLimits::default()
    };
    let mut endpoint = WtEndpoint::new_with_limits(true, saddr, caddr, limits).unwrap();

    endpoint.push_event(WtEvent::Datagram {
        conn: 7,
        session_id: 0,
        data: vec![1; 4],
    });
    assert_eq!(endpoint.governor.snapshot(7, None).queued_bytes_global, 4);
    endpoint.push_event(WtEvent::Datagram {
        conn: 7,
        session_id: 0,
        data: vec![2],
    });
    assert_eq!(
        endpoint.take_last_error().as_deref(),
        Some("E_QUEUE_FULL: maxQueuedBytesGlobal reached")
    );
    assert_eq!(endpoint.events.len(), 1, "limit+1 event is not retained");

    let encoded = endpoint.poll_event_encoded().expect("encoded event");
    assert!(!encoded.is_empty());
    let transferred = endpoint.governor.snapshot(7, None);
    assert_eq!(transferred.queued_bytes_global, 4);
    assert_eq!(transferred.host_tokens_active, 1);

    assert_eq!(endpoint.governor.release_all_host_tokens(), 1);
    assert_eq!(
        endpoint.governor.snapshot(7, None),
        crate::governor::GovernorSnapshot::default()
    );
}

#[test]
fn bridge_transfer_failure_fails_closed_instead_of_encoding_token_zero() {
    let caddr: SocketAddr = CADDR.parse().unwrap();
    let saddr: SocketAddr = SADDR.parse().unwrap();
    let limits = WasmLimits {
        max_queued_bytes_global: 2,
        max_queued_bytes_per_session: 2,
        max_queued_bytes_per_stream: 2,
        ..WasmLimits::default()
    };
    let mut endpoint = WtEndpoint::new_with_limits(true, saddr, caddr, limits).unwrap();
    endpoint.governor.set_host_token_ceiling_for_test(1);
    endpoint.push_event(WtEvent::Datagram {
        conn: 1,
        session_id: 0,
        data: vec![1],
    });
    endpoint.push_event(WtEvent::Datagram {
        conn: 1,
        session_id: 0,
        data: vec![2],
    });

    assert!(
        endpoint.poll_event_encoded().is_some(),
        "first token transfers"
    );
    // The second transfer fails: the payload must never be delivered with
    // an unaccounted token-0, and the failure must be observable — the
    // affected connection fails closed with a Closed event instead of the
    // payload silently vanishing.
    let closed = endpoint
        .poll_event_encoded()
        .expect("failed transfer surfaces a Closed event");
    assert_eq!(closed[0], crate::event::tag::CLOSED);
    assert_eq!(
        crate::varint::decode(&closed[1..]).map(|(conn, _)| conn),
        Some(1),
        "Closed event targets the connection whose payload was dropped"
    );
    assert_eq!(
        endpoint.take_last_error().as_deref(),
        Some("E_LIMIT_EXCEEDED: host reservation token space exhausted")
    );
    assert!(
        endpoint.poll_event_encoded().is_none(),
        "queue is drained after the fail-closed teardown"
    );
    let snapshot = endpoint.governor.snapshot(1, None);
    assert_eq!(snapshot.host_tokens_active, 1);
    assert_eq!(snapshot.queued_bytes_global, 1);
    assert_eq!(endpoint.governor.release_all_host_tokens(), 1);
    assert_eq!(
        endpoint.governor.snapshot(1, None),
        crate::governor::GovernorSnapshot::default()
    );
}

#[test]
fn event_item_cap_accepts_exact_boundary_and_rejects_limit_plus_one() {
    let caddr: SocketAddr = CADDR.parse().unwrap();
    let saddr: SocketAddr = SADDR.parse().unwrap();
    let mut endpoint = WtEndpoint::new(true, saddr, caddr).unwrap();
    endpoint.events = std::iter::repeat_n(WtEvent::Connected { conn: 1 }, 65_536).collect();
    endpoint.event_reservations = std::iter::repeat_with(|| None).take(65_536).collect();

    endpoint.push_event(WtEvent::Connected { conn: 2 });
    assert_eq!(endpoint.events.len(), 65_536);
    assert_eq!(endpoint.event_reservations.len(), 65_536);
    assert_eq!(
        endpoint.take_last_error().as_deref(),
        Some("E_QUEUE_FULL: event queue item cap reached")
    );
}

#[test]
fn decode_frame_header_never_panics_on_random_input() {
    // Robustness fuzz: random byte sequences must never panic the frame
    // header decoder (varint overflow, oversized length, truncation).
    let mut state = 0x1234_5678_9abc_def0u64;
    let mut next = || {
        state ^= state >> 12;
        state ^= state << 25;
        state ^= state >> 27;
        state.wrapping_mul(0x2545_f491_4f6c_dd1d)
    };
    for _ in 0..100_000 {
        let len = (next() as usize) % 32;
        let buf: Vec<u8> = (0..len).map(|_| next() as u8).collect();
        let _ = decode_frame_header(&buf);
    }
}

#[test]
fn decode_frame_header_rejects_oversized_frame() {
    // A frame advertising a length beyond MAX_H3_FRAME_SIZE must be flagged
    // TooLarge so the connection is closed rather than buffered unbounded.
    let mut buf = Vec::new();
    crate::varint::encode(0x00, &mut buf); // ftype
    crate::varint::encode(MAX_H3_FRAME_SIZE + 1, &mut buf); // oversized length
    assert!(matches!(decode_frame_header(&buf), FrameHdr::TooLarge));

    // A within-cap frame whose payload hasn't fully arrived is Incomplete.
    let mut small = Vec::new();
    crate::varint::encode(0x00, &mut small);
    crate::varint::encode(100, &mut small);
    assert!(matches!(decode_frame_header(&small), FrameHdr::Incomplete));
}

/// Move all packets `from` (located at `from_addr`) emits into `to`, using
/// `from_addr` as the datagram source so the receiver routes by it. Both
/// endpoints are a fixed pair, so every emitted destination is `to`.
fn relay_step_addr(from: &mut WtEndpoint, to: &mut WtEndpoint, from_addr: SocketAddr) -> bool {
    let now = Instant::now();
    let mut pkts = Vec::new();
    from.poll_transmits(now, &mut pkts);
    let moved = !pkts.is_empty();
    for (p, _dest) in pkts {
        to.recv(Instant::now(), from_addr, &p);
    }
    moved
}

fn endpoints() -> (WtEndpoint, WtEndpoint, u32) {
    let caddr: SocketAddr = CADDR.parse().unwrap();
    let saddr: SocketAddr = SADDR.parse().unwrap();
    let server = WtEndpoint::new(true, saddr, caddr).unwrap();
    let mut client = WtEndpoint::new(false, caddr, saddr).unwrap();
    let cid = client.connect("localhost") as u32;
    (server, client, cid)
}

fn relay_client_to_server(client: &mut WtEndpoint, server: &mut WtEndpoint) -> bool {
    relay_step_addr(client, server, CADDR.parse().unwrap())
}

fn relay_server_to_client(server: &mut WtEndpoint, client: &mut WtEndpoint) -> bool {
    relay_step_addr(server, client, SADDR.parse().unwrap())
}

fn decode_stream_data_event(encoded: &[u8]) -> Option<(u32, u32, bool, Vec<u8>, u32)> {
    if encoded.first().copied() != Some(crate::event::tag::STREAM_DATA) {
        return None;
    }
    let (conn, mut offset) = crate::varint::decode(&encoded[1..])?;
    offset += 1;
    let (stream, next) = crate::varint::decode(&encoded[offset..])?;
    offset += next;
    let fin = *encoded.get(offset)? != 0;
    offset += 1;
    let (len, next) = crate::varint::decode(&encoded[offset..])?;
    offset += next;
    let len: usize = len.try_into().ok()?;
    let data = encoded.get(offset..offset + len)?.to_vec();
    offset += len;
    let (token, _next) = crate::varint::decode(&encoded[offset..])?;
    Some((conn as u32, stream as u32, fin, data, token as u32))
}

#[test]
fn datagram_size_accepts_exact_limit_and_rejects_limit_plus_one_stably() {
    let caddr: SocketAddr = CADDR.parse().unwrap();
    let saddr: SocketAddr = SADDR.parse().unwrap();
    let server_limits = WasmLimits {
        max_datagram_size: 4,
        ..WasmLimits::default()
    };
    let client_limits = server_limits.clone();
    let mut server = WtEndpoint::new_with_limits(true, saddr, caddr, server_limits).unwrap();
    let mut client = WtEndpoint::new_with_limits(false, caddr, saddr, client_limits).unwrap();
    let conn = client.connect("localhost") as u32;
    let mut established = false;

    for _ in 0..400 {
        let moved = relay_client_to_server(&mut client, &mut server)
            | relay_server_to_client(&mut server, &mut client);
        while let Some(event) = client.poll_event() {
            if matches!(event, WtEvent::SessionEstablished { .. }) {
                established = true;
            }
        }
        while server.poll_event().is_some() {}
        if established {
            break;
        }
        if !moved {
            let now = Instant::now();
            server.handle_timeout(now);
            client.handle_timeout(now);
        }
    }

    assert!(
        established,
        "session establishes before boundary assertions"
    );
    assert!(
        client.send_datagram(conn, 0, b"1234"),
        "exact limit succeeds"
    );
    assert!(!client.send_datagram(conn, 0, b"12345"), "limit+1 fails");
    assert_eq!(
        client.take_last_error().as_deref(),
        Some("E_LIMIT_EXCEEDED: maxDatagramSize exceeded")
    );
}

#[test]
fn datagram_size_respects_negotiated_transport_capacity_stably() {
    let caddr: SocketAddr = CADDR.parse().unwrap();
    let saddr: SocketAddr = SADDR.parse().unwrap();
    let limits = WasmLimits {
        max_datagram_size: 100_000,
        ..WasmLimits::default()
    };
    let mut server = WtEndpoint::new_with_limits(true, saddr, caddr, limits.clone()).unwrap();
    let mut client = WtEndpoint::new_with_limits(false, caddr, saddr, limits).unwrap();
    let conn = client.connect("localhost") as u32;
    let mut established = false;

    for _ in 0..400 {
        let moved = relay_client_to_server(&mut client, &mut server)
            | relay_server_to_client(&mut server, &mut client);
        while let Some(event) = client.poll_event() {
            if matches!(event, WtEvent::SessionEstablished { .. }) {
                established = true;
            }
        }
        while server.poll_event().is_some() {}
        if established {
            break;
        }
        if !moved {
            let now = Instant::now();
            server.handle_timeout(now);
            client.handle_timeout(now);
        }
    }

    assert!(established, "session establishes before size assertions");
    let effective = client
        .max_datagram_size(conn, 0)
        .expect("established connection supports datagrams");
    assert!(effective > 0);
    assert!(effective < 64 * 1024);
    assert!(!client.send_datagram(conn, 0, &vec![0; 64 * 1024]));
    assert_eq!(
        client.take_last_error().as_deref(),
        Some("E_LIMIT_EXCEEDED: maxDatagramSize exceeded")
    );
}

#[test]
fn outgoing_stream_limit_rejects_before_allocating_a_quic_stream_or_handle() {
    let caddr: SocketAddr = CADDR.parse().unwrap();
    let saddr: SocketAddr = SADDR.parse().unwrap();
    let server_limits = WasmLimits::default();
    let client_limits = WasmLimits {
        max_streams_per_session_bidi: 1,
        max_streams_per_session_uni: 1,
        max_streams_global: 1,
        ..WasmLimits::default()
    };
    let mut server = WtEndpoint::new_with_limits(true, saddr, caddr, server_limits).unwrap();
    let mut client = WtEndpoint::new_with_limits(false, caddr, saddr, client_limits).unwrap();
    let conn = client.connect("localhost") as u32;
    let mut established = false;
    for _ in 0..400 {
        relay_client_to_server(&mut client, &mut server);
        relay_server_to_client(&mut server, &mut client);
        while let Some(event) = client.poll_event() {
            if matches!(event, WtEvent::SessionEstablished { .. }) {
                established = true;
            }
        }
        while server.poll_event().is_some() {}
        if established {
            break;
        }
    }
    assert!(
        established,
        "session establishes before stream limit assertions"
    );

    assert!(
        client.open_stream(conn, 0, true) > 0,
        "exact limit succeeds"
    );
    let next_handle = client.next_stream;
    assert_eq!(client.open_stream(conn, 0, true), -1, "limit+1 fails");
    assert_eq!(
        client.next_stream, next_handle,
        "rejected open must not consume or expose a stream handle"
    );
    assert_eq!(client.stream_index.len(), 1);
    assert_eq!(client.stream_reservations.len(), 1);
    assert_eq!(
        client.take_last_error().as_deref(),
        Some("E_LIMIT_EXCEEDED: maxStreamsGlobal reached")
    );
}

#[test]
fn error_close_releases_governor_budget_before_connection_lost() {
    let caddr: SocketAddr = CADDR.parse().unwrap();
    let saddr: SocketAddr = SADDR.parse().unwrap();
    let mut server = WtEndpoint::new(true, saddr, caddr).unwrap();
    let mut client = WtEndpoint::new(false, caddr, saddr).unwrap();
    let conn = client.connect("localhost") as u32;
    let mut established = false;
    for _ in 0..400 {
        relay_client_to_server(&mut client, &mut server);
        relay_server_to_client(&mut server, &mut client);
        while let Some(event) = client.poll_event() {
            if matches!(event, WtEvent::SessionEstablished { .. }) {
                established = true;
            }
        }
        while server.poll_event().is_some() {}
        if established {
            break;
        }
    }
    assert!(established, "session establishes before budget assertions");
    assert!(client.open_stream(conn, 0, true) > 0);
    let h = *client.id_to_handle.get(&conn).unwrap();
    assert!(
        client.session_reservations.contains_key(&h),
        "established session carries a session reservation"
    );
    assert_eq!(client.stream_reservations.len(), 1);

    // The budget must free at the close site itself — BEFORE any further
    // drive/pump surfaces ConnectionLost and runs cleanup_connection.
    client.close_conn_protocol_error(h, 0x0102, b"test");
    assert!(!client.handshake_reservations.contains_key(&h));
    assert!(!client.session_reservations.contains_key(&h));
    assert!(client.stream_reservations.is_empty());
    // Connection state stays with quinn's lifecycle (not torn down here);
    // the eventual cleanup_connection is a budget no-op.
    assert!(client.conns.contains_key(&h));
}

#[test]
fn incoming_stream_limit_drops_parser_state_instead_of_buffering_untracked_bytes() {
    use quinn_proto::{Dir, Side};

    let caddr: SocketAddr = CADDR.parse().unwrap();
    let saddr: SocketAddr = SADDR.parse().unwrap();
    let limits = WasmLimits {
        max_streams_per_session_bidi: 1,
        max_streams_per_session_uni: 1,
        max_streams_global: 1,
        ..WasmLimits::default()
    };
    let mut endpoint = WtEndpoint::new_with_limits(true, saddr, caddr, limits).unwrap();
    let h = ConnectionHandle(0);
    // CONNECT session id 0 (client bidi index 0); WT data arrives on a
    // different stream so session-id demux can validate against a live session.
    let session_sid = StreamId::new(Side::Client, Dir::Bi, 0);
    let stream_id = StreamId::new(Side::Client, Dir::Bi, 1);
    endpoint.handle_to_id.insert(h, 1);
    endpoint.id_to_handle.insert(1, h);
    let mut session = Session::default();
    session.connect_stream = Some(session_sid);
    session.established = true;
    session.in_streams.insert(
        stream_id,
        InStream {
            kind: None,
            is_bidi: true,
            sid_read: false,
            wt_session_id: None,
            handle: None,
            connect_admitted: false,
            buf: Vec::new(),
        },
    );
    endpoint.sessions.insert(h, session);
    let _ = endpoint
        .rate_limiter
        .attach_connection(1, caddr, Instant::now());
    let held = endpoint
        .governor
        .reserve_stream(1, 99, StreamKind::Bidi)
        .expect("fill exact stream limit");
    endpoint.stream_reservations.insert(99, held);

    let mut encoded = Vec::new();
    crate::varint::encode(h3::frame::WT_BIDI, &mut encoded);
    crate::varint::encode(u64::from(session_sid), &mut encoded);
    encoded.extend_from_slice(&[7; 64]);
    endpoint.process_in_stream(h, stream_id, &encoded, false, Instant::now());

    assert!(
        !endpoint.sessions[&h].in_streams.contains_key(&stream_id),
        "rejected stream parser state and payload must be dropped"
    );
    assert_eq!(
        endpoint.next_stream, 1,
        "rejection must not consume a handle"
    );
    assert_eq!(
        endpoint.take_last_error().as_deref(),
        Some("E_LIMIT_EXCEEDED: maxStreamsGlobal reached")
    );
}

#[test]
fn incoming_stream_without_owner_mapping_fails_closed_without_allocating_state() {
    use quinn_proto::{Dir, Side};

    let caddr: SocketAddr = CADDR.parse().unwrap();
    let saddr: SocketAddr = SADDR.parse().unwrap();
    let mut endpoint = WtEndpoint::new(true, saddr, caddr).unwrap();
    let h = ConnectionHandle(0);
    let stream_id = StreamId::new(Side::Client, Dir::Bi, 0);
    endpoint.handle_to_id.insert(h, 1);
    endpoint.id_to_handle.insert(1, h);
    let mut session = Session::default();
    session.in_streams.insert(
        stream_id,
        InStream {
            kind: None,
            is_bidi: true,
            sid_read: false,
            wt_session_id: None,
            handle: None,
            connect_admitted: false,
            buf: Vec::new(),
        },
    );
    endpoint.sessions.insert(h, session);

    let mut encoded = Vec::new();
    crate::varint::encode(h3::frame::WT_BIDI, &mut encoded);
    crate::varint::encode(0, &mut encoded);
    encoded.extend_from_slice(&[7; 8]);
    endpoint.process_in_stream(h, stream_id, &encoded, false, Instant::now());

    assert!(
        !endpoint.sessions[&h].in_streams.contains_key(&stream_id),
        "missing owner mapping must reject and retire the parser state"
    );
    assert_eq!(
        endpoint.next_stream, 1,
        "missing owner mapping must not consume a stream handle"
    );
    assert_eq!(endpoint.stream_reservations.len(), 0);
    assert!(
        endpoint.events.is_empty(),
        "rejected stream must not emit WT events"
    );
    assert_eq!(
        endpoint.take_last_error().as_deref(),
        Some("E_SESSION_CLOSED: unknown WebTransport session id")
    );
}

#[test]
fn wt_session_and_datagram_echo() {
    let (mut server, mut client, cid) = endpoints();
    let mut server_est = false;
    let mut client_est = false;
    let mut echoed = false;

    for _ in 0..400 {
        let a = relay_client_to_server(&mut client, &mut server);
        let b = relay_server_to_client(&mut server, &mut client);
        while let Some(ev) = server.poll_event() {
            match ev {
                WtEvent::SessionEstablished { .. } => server_est = true,
                WtEvent::Datagram { conn, data, .. } => {
                    server.send_datagram(conn, 0, &data);
                }
                _ => {}
            }
        }
        while let Some(ev) = client.poll_event() {
            match ev {
                WtEvent::SessionEstablished { .. } => client_est = true,
                WtEvent::Datagram { data, .. } => {
                    assert_eq!(data, b"ping");
                    echoed = true;
                }
                _ => {}
            }
        }
        if server_est && client_est && !echoed {
            client.send_datagram(cid, 0, b"ping");
        }
        if echoed {
            break;
        }
        if !a && !b {
            let now = Instant::now();
            server.handle_timeout(now);
            client.handle_timeout(now);
        }
    }
    assert!(server_est && client_est && echoed);
}

#[test]
fn connection_peer_json_reports_each_side_remote_address() {
    let (mut server, mut client, cid) = endpoints();
    let mut server_conn: Option<u32> = None;
    let mut client_est = false;

    for _ in 0..400 {
        let a = relay_client_to_server(&mut client, &mut server);
        let b = relay_server_to_client(&mut server, &mut client);
        while let Some(ev) = server.poll_event() {
            if let WtEvent::SessionEstablished { conn, .. } = ev {
                server_conn = Some(conn);
            }
        }
        while let Some(ev) = client.poll_event() {
            if let WtEvent::SessionEstablished { .. } = ev {
                client_est = true;
            }
        }
        if server_conn.is_some() && client_est {
            break;
        }
        if !a && !b {
            let now = Instant::now();
            server.handle_timeout(now);
            client.handle_timeout(now);
        }
    }

    let server_conn = server_conn.expect("server session established");
    assert!(client_est);

    // Each side reports the *other* side's address, matching native `peer`.
    let caddr: SocketAddr = CADDR.parse().unwrap();
    let saddr: SocketAddr = SADDR.parse().unwrap();

    let seen_by_server: serde_json::Value =
        serde_json::from_str(&server.connection_peer_json(server_conn)).unwrap();
    assert_eq!(seen_by_server["ip"], caddr.ip().to_string());
    assert_eq!(seen_by_server["port"], caddr.port());

    let seen_by_client: serde_json::Value =
        serde_json::from_str(&client.connection_peer_json(cid)).unwrap();
    assert_eq!(seen_by_client["ip"], saddr.ip().to_string());
    assert_eq!(seen_by_client["port"], saddr.port());
}

#[test]
fn connection_peer_json_fails_closed_for_an_unknown_connection() {
    let (server, _client, _cid) = endpoints();
    let parsed: serde_json::Value =
        serde_json::from_str(&server.connection_peer_json(9999)).unwrap();
    assert_eq!(parsed["error"], "E_SESSION_CLOSED: unknown connection");
    assert!(parsed.get("ip").is_none());
}

#[test]
fn wt_bidi_stream_echo() {
    let (mut server, mut client, cid) = endpoints();
    let mut server_est = false;
    let mut client_est = false;
    let mut client_stream: Option<u32> = None;
    let mut sent = false;
    let mut echo: Option<Vec<u8>> = None;
    // server side: map of accepted bidi stream -> echo it
    for _ in 0..600 {
        let a = relay_client_to_server(&mut client, &mut server);
        let b = relay_server_to_client(&mut server, &mut client);
        while let Some(ev) = server.poll_event() {
            match ev {
                WtEvent::SessionEstablished { .. } => server_est = true,
                WtEvent::StreamData { stream, data, .. } if !data.is_empty() => {
                    server.stream_write(stream, &data);
                }
                _ => {}
            }
        }
        while let Some(ev) = client.poll_event() {
            match ev {
                WtEvent::SessionEstablished { .. } => client_est = true,
                WtEvent::StreamData { data, .. } if !data.is_empty() => {
                    echo = Some(data);
                }
                _ => {}
            }
        }
        if server_est && client_est && client_stream.is_none() {
            let s = client.open_stream(cid, 0, true);
            assert!(s >= 0);
            client_stream = Some(s as u32);
        }
        if let Some(s) = client_stream {
            if !sent {
                client.stream_write(s, b"hello-bidi");
                sent = true;
            }
        }
        if echo.is_some() {
            break;
        }
        if !a && !b {
            let now = Instant::now();
            server.handle_timeout(now);
            client.handle_timeout(now);
        }
    }
    assert_eq!(echo.as_deref(), Some(&b"hello-bidi"[..]));
}

#[test]
fn reliable_stream_data_larger_than_event_budget_is_backpressured_not_dropped() {
    let caddr: SocketAddr = CADDR.parse().unwrap();
    let saddr: SocketAddr = SADDR.parse().unwrap();
    let limits = WasmLimits {
        max_queued_bytes_global: 16 * 1024,
        max_queued_bytes_per_session: 8 * 1024,
        max_queued_bytes_per_stream: 4 * 1024,
        ..WasmLimits::default()
    };
    let mut server = WtEndpoint::new_with_limits(true, saddr, caddr, limits.clone()).unwrap();
    let mut client = WtEndpoint::new_with_limits(false, caddr, saddr, limits).unwrap();
    let conn = client.connect("localhost") as u32;
    let mut server_established = false;
    let mut client_established = false;

    for _ in 0..600 {
        let moved = relay_client_to_server(&mut client, &mut server)
            | relay_server_to_client(&mut server, &mut client);
        while let Some(event) = server.poll_event() {
            if matches!(event, WtEvent::SessionEstablished { .. }) {
                server_established = true;
            }
        }
        while let Some(event) = client.poll_event() {
            if matches!(event, WtEvent::SessionEstablished { .. }) {
                client_established = true;
            }
        }
        if server_established && client_established {
            break;
        }
        if !moved {
            let now = Instant::now();
            server.handle_timeout(now);
            client.handle_timeout(now);
        }
    }
    assert!(server_established && client_established);

    let stream = client.open_stream(conn, 0, true);
    assert!(stream >= 0);
    let stream = stream as u32;
    let payload: Vec<u8> = (0..64 * 1024).map(|index| (index % 251) as u8).collect();
    let mut sent = 0usize;
    let mut received = Vec::with_capacity(payload.len());

    for _ in 0..10_000 {
        if sent < payload.len() {
            let accepted = client.stream_write(stream, &payload[sent..]);
            assert!(accepted >= 0, "stream write should not fail");
            sent += accepted as usize;
        }
        let moved = relay_client_to_server(&mut client, &mut server)
            | relay_server_to_client(&mut server, &mut client);
        while let Some(event) = server.poll_event() {
            if let WtEvent::StreamData { data, .. } = event {
                received.extend_from_slice(&data);
            }
        }
        while client.poll_event().is_some() {}
        if sent == payload.len() && received.len() == payload.len() {
            break;
        }
        if !moved {
            let now = Instant::now();
            server.handle_timeout(now);
            client.handle_timeout(now);
        }
    }

    assert_eq!(sent, payload.len(), "the sender accepted the full payload");
    assert_eq!(
        received, payload,
        "reliable stream bytes must never be dropped"
    );
    assert_ne!(
        server.take_last_error().as_deref(),
        Some("E_QUEUE_FULL: maxQueuedBytesPerStream reached"),
    );
}

#[test]
fn full_event_queue_backpressures_reliable_stream_reads_without_losing_bytes() {
    let (mut server, mut client, _cid) = endpoints();
    let mut server_conn = None;
    let mut client_established = false;
    let mut client_stream = None;

    for _ in 0..2_000 {
        let moved = relay_client_to_server(&mut client, &mut server)
            | relay_server_to_client(&mut server, &mut client);
        while let Some(event) = server.poll_event() {
            if let WtEvent::SessionEstablished { conn, .. } = event {
                server_conn = Some(conn);
            }
        }
        while let Some(event) = client.poll_event() {
            match event {
                WtEvent::SessionEstablished { .. } => client_established = true,
                WtEvent::StreamOpened { stream, .. } => client_stream = Some(stream),
                _ => {}
            }
        }
        if client_established && client_stream.is_none() {
            let stream = server.open_stream(server_conn.expect("server conn"), 0, true);
            assert!(stream >= 0);
        }
        if client_established && client_stream.is_some() {
            break;
        }
        if !moved {
            let now = Instant::now();
            server.handle_timeout(now);
            client.handle_timeout(now);
        }
    }

    let client_stream = client_stream.expect("client observed opened stream");
    server.events =
        std::iter::repeat_n(WtEvent::Connected { conn: 9 }, MAX_PENDING_EVENTS).collect();
    server.event_reservations = std::iter::repeat_with(|| None)
        .take(MAX_PENDING_EVENTS)
        .collect();

    client.stream_write(client_stream, b"queued-data");

    for _ in 0..10 {
        let moved = relay_client_to_server(&mut client, &mut server)
            | relay_server_to_client(&mut server, &mut client);
        while client.poll_event().is_some() {}
        if !moved {
            break;
        }
    }

    assert_eq!(server.events.len(), MAX_PENDING_EVENTS);
    assert_eq!(
        server.take_last_error().as_deref(),
        Some("E_QUEUE_FULL: event queue item cap reached")
    );

    assert!(server.poll_event().is_some(), "free one queue slot");
    assert!(matches!(
        server.events.back(),
        Some(WtEvent::StreamData { data, .. }) if data == b"queued-data"
    ));
}

#[test]
fn releasing_one_host_token_resumes_other_connections_blocked_by_global_capacity() {
    let limits = WasmLimits {
        max_queued_bytes_global: 4,
        max_queued_bytes_per_session: 4,
        max_queued_bytes_per_stream: 4,
        ..WasmLimits::default()
    };
    let saddr: SocketAddr = "127.0.0.1:443".parse().unwrap();
    let a_addr: SocketAddr = "127.0.0.1:1001".parse().unwrap();
    let b_addr: SocketAddr = "127.0.0.1:1002".parse().unwrap();

    let mut server = WtEndpoint::new_with_limits(true, saddr, a_addr, limits.clone()).unwrap();
    let mut client_a = WtEndpoint::new_with_limits(false, a_addr, saddr, limits.clone()).unwrap();
    let mut client_b = WtEndpoint::new_with_limits(false, b_addr, saddr, limits).unwrap();
    client_a.connect("localhost");
    client_b.connect("localhost");

    fn drain2(from: &mut WtEndpoint) -> Vec<(SocketAddr, Vec<u8>)> {
        let mut pkts = Vec::new();
        from.poll_transmits(Instant::now(), &mut pkts);
        pkts.into_iter().map(|(p, dest)| (dest, p)).collect()
    }

    let mut conn_a = None;
    let mut conn_b = None;
    let mut client_a_established = false;
    let mut client_b_established = false;
    let mut stream_a = None;
    let mut stream_b = None;
    let mut opened = false;

    for _ in 0..3_000 {
        let mut wire: Vec<(SocketAddr, SocketAddr, Vec<u8>)> = Vec::new();
        for (dest, p) in drain2(&mut client_a) {
            wire.push((a_addr, dest, p));
        }
        for (dest, p) in drain2(&mut client_b) {
            wire.push((b_addr, dest, p));
        }
        for (dest, p) in drain2(&mut server) {
            wire.push((saddr, dest, p));
        }
        let moved = !wire.is_empty();
        for (src, dest, p) in wire {
            let now = Instant::now();
            if dest == saddr {
                server.recv(now, src, &p);
            } else if dest == a_addr {
                client_a.recv(now, src, &p);
            } else if dest == b_addr {
                client_b.recv(now, src, &p);
            }
        }
        while let Some(event) = server.poll_event() {
            if let WtEvent::SessionEstablished { conn, .. } = event {
                if conn_a.is_none() {
                    conn_a = Some(conn);
                } else if Some(conn) != conn_a {
                    conn_b = Some(conn);
                }
            }
        }
        while let Some(event) = client_a.poll_event() {
            match event {
                WtEvent::SessionEstablished { .. } => client_a_established = true,
                WtEvent::StreamOpened { stream, .. } => stream_a = Some(stream),
                _ => {}
            }
        }
        while let Some(event) = client_b.poll_event() {
            match event {
                WtEvent::SessionEstablished { .. } => client_b_established = true,
                WtEvent::StreamOpened { stream, .. } => stream_b = Some(stream),
                _ => {}
            }
        }
        if conn_a.is_some()
            && conn_b.is_some()
            && client_a_established
            && client_b_established
            && !opened
        {
            if let (Some(conn_a), Some(conn_b)) = (conn_a, conn_b) {
                assert!(server.open_stream(conn_a, 0, true) >= 0);
                assert!(server.open_stream(conn_b, 0, true) >= 0);
                opened = true;
            }
        }
        if stream_a.is_some() && stream_b.is_some() {
            break;
        }
        if !moved {
            let now = Instant::now();
            server.handle_timeout(now);
            client_a.handle_timeout(now);
            client_b.handle_timeout(now);
        }
    }

    let stream_a = stream_a.expect("client a stream");
    let stream_b = stream_b.expect("client b stream");
    client_a.stream_write(stream_a, b"aaaa");

    let (first_conn, token_a) = 'token_a: loop {
        let mut wire: Vec<(SocketAddr, SocketAddr, Vec<u8>)> = Vec::new();
        for (dest, p) in drain2(&mut client_a) {
            wire.push((a_addr, dest, p));
        }
        for (dest, p) in drain2(&mut client_b) {
            wire.push((b_addr, dest, p));
        }
        for (dest, p) in drain2(&mut server) {
            wire.push((saddr, dest, p));
        }
        let moved = !wire.is_empty();
        for (src, dest, p) in wire {
            let now = Instant::now();
            if dest == saddr {
                server.recv(now, src, &p);
            } else if dest == a_addr {
                client_a.recv(now, src, &p);
            } else if dest == b_addr {
                client_b.recv(now, src, &p);
            }
        }
        if let Some(encoded) = server.poll_event_encoded() {
            if let Some((conn, _stream, _fin, data, token)) = decode_stream_data_event(&encoded) {
                assert_eq!(data, b"aaaa");
                break 'token_a (conn, token);
            }
        }
        if !moved {
            let now = Instant::now();
            server.handle_timeout(now);
            client_a.handle_timeout(now);
        }
    };
    assert!(token_a > 0, "first payload must retain a host token");

    client_b.stream_write(stream_b, b"bbbb");
    for _ in 0..20 {
        let mut wire: Vec<(SocketAddr, SocketAddr, Vec<u8>)> = Vec::new();
        for (dest, p) in drain2(&mut client_a) {
            wire.push((a_addr, dest, p));
        }
        for (dest, p) in drain2(&mut client_b) {
            wire.push((b_addr, dest, p));
        }
        for (dest, p) in drain2(&mut server) {
            wire.push((saddr, dest, p));
        }
        let moved = !wire.is_empty();
        for (src, dest, p) in wire {
            let now = Instant::now();
            if dest == saddr {
                server.recv(now, src, &p);
            } else if dest == a_addr {
                client_a.recv(now, src, &p);
            } else if dest == b_addr {
                client_b.recv(now, src, &p);
            }
        }
        assert!(
            server.poll_event_encoded().is_none(),
            "global capacity should block the second connection until release"
        );
        if !moved {
            break;
        }
    }

    assert!(server.release_host_token(token_a));
    let encoded = server
        .poll_event_encoded()
        .expect("releasing one token should immediately resume the other connection");
    let (conn, _stream, _fin, data, token_b) =
        decode_stream_data_event(&encoded).expect("stream data event");
    assert_ne!(conn, first_conn);
    assert_eq!(data, b"bbbb");
    assert!(token_b > 0);
}

#[test]
fn wt_uni_stream_oneway() {
    let (mut server, mut client, cid) = endpoints();
    let mut server_est = false;
    let mut client_est = false;
    let mut opened = false;
    let mut got: Vec<u8> = Vec::new();
    let mut got_fin = false;
    for _ in 0..600 {
        let a = relay_client_to_server(&mut client, &mut server);
        let b = relay_server_to_client(&mut server, &mut client);
        while let Some(ev) = server.poll_event() {
            match ev {
                WtEvent::SessionEstablished { .. } => server_est = true,
                WtEvent::StreamData { data, fin, .. } => {
                    got.extend_from_slice(&data);
                    if fin {
                        got_fin = true;
                    }
                }
                _ => {}
            }
        }
        while let Some(ev) = client.poll_event() {
            if let WtEvent::SessionEstablished { .. } = ev {
                client_est = true;
            }
        }
        if server_est && client_est && !opened {
            let s = client.open_stream(cid, 0, false);
            assert!(s >= 0);
            client.stream_write(s as u32, b"uni-msg");
            client.stream_finish(s as u32);
            opened = true;
        }
        if got_fin {
            break;
        }
        if !a && !b {
            let now = Instant::now();
            server.handle_timeout(now);
            client.handle_timeout(now);
        }
    }
    assert_eq!(got, b"uni-msg");
    assert!(got_fin, "uni stream should signal FIN");
}

/// Two clients at distinct source addresses share one server endpoint. Each
/// must complete its own handshake + WT session, get ITS OWN datagram echoed
/// back, and never observe the other client's payload (routing isolation).
#[test]
fn multi_client_datagram_isolation() {
    let saddr: SocketAddr = "127.0.0.1:443".parse().unwrap();
    let a_addr: SocketAddr = "127.0.0.1:1001".parse().unwrap();
    let b_addr: SocketAddr = "127.0.0.1:1002".parse().unwrap();

    let mut server = WtEndpoint::new(true, saddr, a_addr).unwrap();
    let mut client_a = WtEndpoint::new(false, a_addr, saddr).unwrap();
    let mut client_b = WtEndpoint::new(false, b_addr, saddr).unwrap();
    let cid_a = client_a.connect("localhost") as u32;
    let cid_b = client_b.connect("localhost") as u32;

    // Drain one endpoint (located at `from_addr`) into `(from_addr, dest, pkt)`
    // records so the switch below can route by destination without overlapping
    // mutable borrows of the endpoints.
    fn drain(from: &mut WtEndpoint, _from_addr: SocketAddr) -> Vec<(SocketAddr, Vec<u8>)> {
        let mut pkts = Vec::new();
        from.poll_transmits(Instant::now(), &mut pkts);
        pkts.into_iter().map(|(p, dest)| (dest, p)).collect()
    }

    let mut a_est = false;
    let mut b_est = false;
    let mut a_got: Vec<Vec<u8>> = Vec::new();
    let mut b_got: Vec<Vec<u8>> = Vec::new();
    let mut a_sent = false;
    let mut b_sent = false;
    // Keep pumping a while after both echoes arrive to catch LATE cross-talk.
    let mut linger = 0u32;

    for _ in 0..1200 {
        // Collect everything emitted this tick, then deliver by destination.
        let mut wire: Vec<(SocketAddr, SocketAddr, Vec<u8>)> = Vec::new();
        for (dest, p) in drain(&mut client_a, a_addr) {
            wire.push((a_addr, dest, p));
        }
        for (dest, p) in drain(&mut client_b, b_addr) {
            wire.push((b_addr, dest, p));
        }
        for (dest, p) in drain(&mut server, saddr) {
            wire.push((saddr, dest, p));
        }
        let moved = !wire.is_empty();
        for (src, dest, p) in wire {
            let now = Instant::now();
            if dest == saddr {
                server.recv(now, src, &p);
            } else if dest == a_addr {
                client_a.recv(now, src, &p);
            } else if dest == b_addr {
                client_b.recv(now, src, &p);
            }
        }

        // Server echoes each datagram back to the connection it arrived on.
        while let Some(ev) = server.poll_event() {
            if let WtEvent::Datagram { conn, data, .. } = ev {
                server.send_datagram(conn, 0, &data);
            }
        }
        while let Some(ev) = client_a.poll_event() {
            match ev {
                WtEvent::SessionEstablished { .. } => a_est = true,
                WtEvent::Datagram { data, .. } => {
                    // Isolation must hold on EVERY delivery, not just the last.
                    assert_ne!(
                        data.as_slice(),
                        &b"bravo-payload"[..],
                        "client A must never see client B's payload"
                    );
                    a_got.push(data);
                }
                _ => {}
            }
        }
        while let Some(ev) = client_b.poll_event() {
            match ev {
                WtEvent::SessionEstablished { .. } => b_est = true,
                WtEvent::Datagram { data, .. } => {
                    assert_ne!(
                        data.as_slice(),
                        &b"alpha-payload"[..],
                        "client B must never see client A's payload"
                    );
                    b_got.push(data);
                }
                _ => {}
            }
        }

        if a_est && !a_sent {
            client_a.send_datagram(cid_a, 0, b"alpha-payload");
            a_sent = true;
        }
        if b_est && !b_sent {
            client_b.send_datagram(cid_b, 0, b"bravo-payload");
            b_sent = true;
        }

        if !a_got.is_empty() && !b_got.is_empty() {
            linger += 1;
            if linger > 40 {
                break;
            }
        }
        if !moved {
            let now = Instant::now();
            server.handle_timeout(now);
            client_a.handle_timeout(now);
            client_b.handle_timeout(now);
        }
    }

    assert!(a_est, "client A session should establish");
    assert!(b_est, "client B session should establish");
    // Each client got exactly its own payload echoed — nothing else, ever.
    assert_eq!(
        a_got,
        vec![b"alpha-payload".to_vec()],
        "client A gets exactly its own payload echoed"
    );
    assert_eq!(
        b_got,
        vec![b"bravo-payload".to_vec()],
        "client B gets exactly its own payload echoed"
    );
}

/// Per-stream recv state must be dropped once a stream finishes — a
/// long-lived connection cycling many streams must not grow endpoint maps.
#[test]
fn finished_streams_are_pruned() {
    let caddr: SocketAddr = CADDR.parse().unwrap();
    let saddr: SocketAddr = SADDR.parse().unwrap();
    let mut server = WtEndpoint::new(true, saddr, caddr).unwrap();
    let mut client = WtEndpoint::new(false, caddr, saddr).unwrap();
    let cid = client.connect("localhost") as u32;

    let mut server_est = false;
    let mut client_est = false;
    let mut fins = 0usize;
    let mut opened = 0usize;
    const ROUNDS: usize = 5;

    for _ in 0..4000 {
        let a = relay_step_addr(&mut client, &mut server, caddr);
        let b = relay_step_addr(&mut server, &mut client, saddr);
        while let Some(ev) = server.poll_event() {
            match ev {
                WtEvent::SessionEstablished { .. } => server_est = true,
                WtEvent::StreamData { fin: true, .. } => fins += 1,
                _ => {}
            }
        }
        while let Some(ev) = client.poll_event() {
            if let WtEvent::SessionEstablished { .. } = ev {
                client_est = true;
            }
        }
        if server_est && client_est && opened < ROUNDS && fins == opened {
            let s = client.open_stream(cid, 0, false);
            assert!(s >= 0);
            client.stream_write(s as u32, b"cycle");
            client.stream_finish(s as u32);
            opened += 1;
        }
        if fins == ROUNDS {
            break;
        }
        if !a && !b {
            let now = Instant::now();
            server.handle_timeout(now);
            client.handle_timeout(now);
        }
    }
    assert_eq!(fins, ROUNDS, "all {ROUNDS} uni streams should FIN");

    // Server side: every finished uni stream's recv state and index entry
    // must be gone (control/qpack/CONNECT streams legitimately remain).
    let s_session = server.sessions.values().next().expect("server session");
    assert!(
        s_session.in_streams.values().all(|st| st.handle.is_none()),
        "no finished WT stream should retain recv state"
    );
    assert!(
        server.stream_index.is_empty(),
        "server stream_index should be empty after all streams finished"
    );
    // Client side: finishing a self-opened uni stream releases its index.
    assert!(
        client.stream_index.is_empty(),
        "client stream_index should be empty after finishing its streams"
    );
}

/// Bidi streams must release their index once BOTH halves finish — the
/// uni-only pruning regression left completed bidi streams resident.
#[test]
fn finished_bidi_streams_are_pruned() {
    let caddr: SocketAddr = CADDR.parse().unwrap();
    let saddr: SocketAddr = SADDR.parse().unwrap();
    let mut server = WtEndpoint::new(true, saddr, caddr).unwrap();
    let mut client = WtEndpoint::new(false, caddr, saddr).unwrap();
    let cid = client.connect("localhost") as u32;

    let mut server_est = false;
    let mut client_est = false;
    let mut echoes = 0usize;
    let mut opened = 0usize;
    let mut open_handle: Option<u32> = None;
    const ROUNDS: usize = 3;

    for _ in 0..6000 {
        let a = relay_step_addr(&mut client, &mut server, caddr);
        let b = relay_step_addr(&mut server, &mut client, saddr);
        while let Some(ev) = server.poll_event() {
            match ev {
                WtEvent::SessionEstablished { .. } => server_est = true,
                WtEvent::StreamData {
                    stream,
                    fin: true,
                    data,
                    ..
                } => {
                    // Echo the full request back and finish our half.
                    server.stream_write(stream, &data);
                    server.stream_finish(stream);
                }
                _ => {}
            }
        }
        while let Some(ev) = client.poll_event() {
            match ev {
                WtEvent::SessionEstablished { .. } => client_est = true,
                WtEvent::StreamData { fin: true, .. } => {
                    echoes += 1;
                    open_handle = None;
                }
                _ => {}
            }
        }
        if server_est && client_est && opened < ROUNDS && open_handle.is_none() && echoes == opened
        {
            let s = client.open_stream(cid, 0, true);
            assert!(s >= 0);
            let s = s as u32;
            client.stream_write(s, b"bidi-cycle");
            client.stream_finish(s);
            open_handle = Some(s);
            opened += 1;
        }
        if echoes == ROUNDS {
            break;
        }
        if !a && !b {
            let now = Instant::now();
            server.handle_timeout(now);
            client.handle_timeout(now);
        }
    }
    assert_eq!(echoes, ROUNDS, "all {ROUNDS} bidi echoes should complete");
    assert!(
        client.stream_index.is_empty(),
        "client bidi stream_index should be empty after both halves finish"
    );
    assert!(
        server.stream_index.is_empty(),
        "server bidi stream_index should be empty after both halves finish"
    );
    assert!(client.half_done.is_empty() && server.half_done.is_empty());
}

/// Fabricate a server session with one peer-accepted bidi request stream
/// carrying `frame` in its OWN buffer, ready for parse_server_connect.
fn server_with_request(frame: Vec<u8>) -> (WtEndpoint, ConnectionHandle, StreamId) {
    use quinn_proto::{Dir, Side};
    let caddr: SocketAddr = CADDR.parse().unwrap();
    let saddr: SocketAddr = SADDR.parse().unwrap();
    let mut server = WtEndpoint::new(true, saddr, caddr).unwrap();
    let h = ConnectionHandle(0);
    server.handle_to_id.insert(h, 1);
    server.id_to_handle.insert(1, h);
    let stream_id = StreamId::new(Side::Client, Dir::Bi, 0);
    let mut sess = Session::default();
    sess.in_streams.insert(
        stream_id,
        InStream {
            kind: Some(h3::frame::HEADERS),
            is_bidi: true,
            sid_read: false,
            wt_session_id: None,
            handle: None,
            connect_admitted: false,
            buf: frame,
        },
    );
    server.sessions.insert(h, sess);
    (server, h, stream_id)
}

/// A non-CONNECT HEADERS frame on a request stream must be DRAINED (not
/// re-parsed forever) and must not establish a session.
#[test]
fn non_connect_request_is_drained_not_wedged() {
    let (mut server, h, stream_id) =
        server_with_request(h3::encode_get_request("localhost", "/nope"));
    server.parse_server_connect(h, stream_id);
    let s = server.sessions.get(&h).unwrap();
    assert!(
        s.in_streams.get(&stream_id).unwrap().buf.is_empty(),
        "non-CONNECT frame must be drained, not left to re-parse"
    );
    assert!(!s.established, "a GET must not establish a WT session");
}

/// Two request streams parsed independently must not corrupt each other:
/// a partial frame on one and a full CONNECT on the other still establishes.
#[test]
fn concurrent_request_streams_do_not_interleave() {
    use quinn_proto::{Dir, Side};
    let (mut server, h, connect_sid) =
        server_with_request(h3::encode_connect_request("localhost", "/"));
    // A second request stream holding only a PARTIAL frame (1 byte).
    let other_sid = StreamId::new(Side::Client, Dir::Bi, 4);
    server.sessions.get_mut(&h).unwrap().in_streams.insert(
        other_sid,
        InStream {
            kind: Some(h3::frame::HEADERS),
            is_bidi: true,
            sid_read: false,
            wt_session_id: None,
            handle: None,
            connect_admitted: false,
            buf: vec![0x01], // incomplete HEADERS frame
        },
    );
    // Parsing the partial stream must be a no-op (not wedge, not consume).
    server.parse_server_connect(h, other_sid);
    // Parsing the CONNECT stream establishes cleanly regardless.
    server.parse_server_connect(h, connect_sid);
    let s = server.sessions.get(&h).unwrap();
    assert!(
        s.established,
        "CONNECT establishes despite a concurrent stream"
    );
    assert_eq!(s.connect_stream, Some(connect_sid));
    assert_eq!(
        s.in_streams.get(&other_sid).unwrap().buf,
        vec![0x01],
        "the other stream's partial frame is untouched"
    );
}

/// A real CONNECT frame establishes and latches the CONNECT stream to the
/// stream it arrived on.
#[test]
fn connect_request_latches_stream_and_establishes() {
    let (mut server, h, stream_id) =
        server_with_request(h3::encode_connect_request("localhost", "/"));
    server.parse_server_connect(h, stream_id);
    let s = server.sessions.get(&h).unwrap();
    assert!(s.in_streams.get(&stream_id).unwrap().buf.is_empty());
    assert!(s.established, "a valid CONNECT must establish the session");
    assert_eq!(s.connect_stream, Some(stream_id), "CONNECT stream latched");
    assert!(matches!(
        server.events.back(),
        Some(WtEvent::SessionEstablished { conn: 1, .. })
    ));
}

/// Two Extended CONNECTs on one QUIC connection both establish when
/// `wt_max_sessions >= 2` (SETTINGS_WT_MAX_SESSIONS multi-session).
#[test]
fn two_connect_sessions_succeed_when_max_is_two() {
    use quinn_proto::{Dir, Side};
    let (mut server, h, first) = server_with_request(h3::encode_connect_request("localhost", "/a"));
    assert_eq!(server.wt_max_sessions(), WT_MAX_SESSIONS_DEFAULT);
    server.set_wt_max_sessions(2);

    let second = StreamId::new(Side::Client, Dir::Bi, 4);
    server.sessions.get_mut(&h).unwrap().in_streams.insert(
        second,
        InStream {
            kind: Some(h3::frame::HEADERS),
            is_bidi: true,
            sid_read: false,
            wt_session_id: None,
            handle: None,
            connect_admitted: false,
            buf: h3::encode_connect_request("localhost", "/b"),
        },
    );

    server.parse_server_connect(h, first);
    server.parse_server_connect(h, second);

    let s = server.sessions.get(&h).unwrap();
    assert_eq!(s.active_wt_count(), 2);
    assert_eq!(s.connect_stream, Some(first));
    assert!(s.extra_sessions.contains(&second));
    let established = server
        .events
        .iter()
        .filter(|e| matches!(e, WtEvent::SessionEstablished { conn: 1, .. }))
        .count();
    assert_eq!(established, 2);
    assert!(server.take_last_error().is_none());
}

/// A third CONNECT is rejected with stable `E_LIMIT_EXCEEDED` when max=2
/// (no panic; peer gets HTTP 429).
#[test]
fn third_connect_rejected_when_max_sessions_is_two() {
    use quinn_proto::{Dir, Side};
    let (mut server, h, first) = server_with_request(h3::encode_connect_request("localhost", "/a"));
    server.set_wt_max_sessions(2);

    let second = StreamId::new(Side::Client, Dir::Bi, 4);
    let third = StreamId::new(Side::Client, Dir::Bi, 8);
    {
        let sess = server.sessions.get_mut(&h).unwrap();
        sess.in_streams.insert(
            second,
            InStream {
                kind: Some(h3::frame::HEADERS),
                is_bidi: true,
                sid_read: false,
                wt_session_id: None,
                handle: None,
                connect_admitted: false,
                buf: h3::encode_connect_request("localhost", "/b"),
            },
        );
        sess.in_streams.insert(
            third,
            InStream {
                kind: Some(h3::frame::HEADERS),
                is_bidi: true,
                sid_read: false,
                wt_session_id: None,
                handle: None,
                connect_admitted: false,
                buf: h3::encode_connect_request("localhost", "/c"),
            },
        );
    }

    server.parse_server_connect(h, first);
    server.parse_server_connect(h, second);
    server.parse_server_connect(h, third);

    let s = server.sessions.get(&h).unwrap();
    assert_eq!(s.active_wt_count(), 2, "third CONNECT must not latch");
    assert!(!s.is_wt_connect(third));
    assert_eq!(
        server.take_last_error().as_deref(),
        Some("E_LIMIT_EXCEEDED: SETTINGS_WT_MAX_SESSIONS exceeded")
    );
    let established = server
        .events
        .iter()
        .filter(|e| matches!(e, WtEvent::SessionEstablished { .. }))
        .count();
    assert_eq!(established, 2);
}

/// Datagram quarter-session-ids demux to the matching CONNECT session;
/// unknown qsids do not resolve (isolation).
#[test]
fn datagram_session_id_demux_isolates_sessions() {
    use quinn_proto::{Dir, Side};
    let (mut server, h, first) = server_with_request(h3::encode_connect_request("localhost", "/a"));
    server.set_wt_max_sessions(2);
    let second = StreamId::new(Side::Client, Dir::Bi, 4);
    server.sessions.get_mut(&h).unwrap().in_streams.insert(
        second,
        InStream {
            kind: Some(h3::frame::HEADERS),
            is_bidi: true,
            sid_read: false,
            wt_session_id: None,
            handle: None,
            connect_admitted: false,
            buf: h3::encode_connect_request("localhost", "/b"),
        },
    );
    server.parse_server_connect(h, first);
    server.parse_server_connect(h, second);

    let s = server.sessions.get(&h).unwrap();
    let qsid_a = u64::from(first) / 4;
    let qsid_b = u64::from(second) / 4;
    assert_ne!(qsid_a, qsid_b, "distinct CONNECT streams => distinct qsids");
    assert_eq!(s.session_for_qsid(qsid_a), Some(first));
    assert_eq!(s.session_for_qsid(qsid_b), Some(second));
    assert_eq!(s.session_for_qsid(qsid_a.max(qsid_b) + 1), None);

    // Framed payloads for each session must unwrap to the matching qsid.
    let framed_a = h3::wrap_datagram(u64::from(first), b"alpha");
    let framed_b = h3::wrap_datagram(u64::from(second), b"beta");
    let (qa, pa) = h3::unwrap_datagram(&framed_a).expect("a");
    let (qb, pb) = h3::unwrap_datagram(&framed_b).expect("b");
    assert_eq!(qa, qsid_a);
    assert_eq!(pa, b"alpha");
    assert_eq!(qb, qsid_b);
    assert_eq!(pb, b"beta");
    assert_eq!(s.session_for_qsid(qa), Some(first));
    assert_eq!(s.session_for_qsid(qb), Some(second));
}

/// Control preamble advertises the configured wt_max_sessions value.
#[test]
fn control_preamble_advertises_configured_wt_max_sessions() {
    let preamble = h3::encode_control_preamble(WT_MAX_SESSIONS_DEFAULT);
    let (st, n0) = crate::varint::decode(&preamble).unwrap();
    assert_eq!(st, h3::stream_type::CONTROL);
    let rest = &preamble[n0..];
    let (ft, n1) = crate::varint::decode(rest).unwrap();
    assert_eq!(ft, h3::frame::SETTINGS);
    let rest = &rest[n1..];
    let (len, n2) = crate::varint::decode(rest).unwrap();
    let payload = &rest[n2..n2 + len as usize];
    let settings = h3::parse_settings(payload).unwrap();
    assert_eq!(settings.max_sessions, WT_MAX_SESSIONS_DEFAULT);

    let capped = clamp_wt_max_sessions(u64::MAX);
    assert_eq!(capped, WT_MAX_SESSIONS_HARD_CAP);
    assert_eq!(clamp_wt_max_sessions(0), 1);
}

/// A client non-200 CONNECT response emits exactly one Closed, marks the
/// session closed, and a later 200 on the same connection must NOT
/// resurrect it (no SessionEstablished).
#[test]
fn client_non_200_closes_once_and_blocks_resurrection() {
    let caddr: SocketAddr = CADDR.parse().unwrap();
    let saddr: SocketAddr = SADDR.parse().unwrap();
    let mut client = WtEndpoint::new(false, caddr, saddr).unwrap();
    let h = ConnectionHandle(0);
    client.handle_to_id.insert(h, 3);
    client.id_to_handle.insert(3, h);
    // A 404 rejection followed (later) by a stray 200.
    let sess = Session {
        connect_self_opened: true,
        connect_rx: h3::encode_status_response("404"),
        ..Session::default()
    };
    client.sessions.insert(h, sess);

    client.parse_client_connect(h);
    let closes = client
        .events
        .iter()
        .filter(|e| matches!(e, WtEvent::ConnectionClosed { conn: 3, .. }))
        .count();
    assert_eq!(closes, 1, "non-200 emits exactly one Closed");
    assert!(client.sessions.get(&h).unwrap().connect_closed);
    assert!(!client.sessions.get(&h).unwrap().established);

    // A stray 200 arriving afterwards must be ignored (no resurrection).
    client
        .sessions
        .get_mut(&h)
        .unwrap()
        .connect_rx
        .extend_from_slice(&h3::encode_status_response("200"));
    client.parse_client_connect(h);
    assert!(!client.sessions.get(&h).unwrap().established);
    assert!(
        !client
            .events
            .iter()
            .any(|e| matches!(e, WtEvent::SessionEstablished { .. })),
        "a late 200 must not establish a discarded session"
    );
}

/// A client whose CONNECT is never answered (e.g. interim-only or silent
/// server, where keep-alives defeat the idle timeout) fails at the connect
/// deadline instead of hanging forever.
#[test]
fn client_connect_deadline_fails_unanswered_handshake() {
    let caddr: SocketAddr = CADDR.parse().unwrap();
    let saddr: SocketAddr = SADDR.parse().unwrap();
    let mut client = WtEndpoint::new(false, caddr, saddr).unwrap();
    let h = ConnectionHandle(0);
    client.handle_to_id.insert(h, 4);
    client.id_to_handle.insert(4, h);
    let t0 = Instant::now();
    let sess = Session {
        connect_self_opened: true,
        connect_deadline: Some(t0),
        ..Session::default()
    };
    client.sessions.insert(h, sess);

    // A tick past the deadline must fail the session.
    client.handle_timeout(t0 + std::time::Duration::from_millis(1));
    assert!(client.sessions.get(&h).unwrap().connect_closed);
    assert!(client
        .events
        .iter()
        .any(|e| matches!(e, WtEvent::ConnectionClosed { conn: 4, .. })));
}

/// A malformed :status (non-numeric, e.g. "1") is a bad response, not an
/// interim one: the session is closed rather than waited on.
#[test]
fn client_malformed_status_closes() {
    let caddr: SocketAddr = CADDR.parse().unwrap();
    let saddr: SocketAddr = SADDR.parse().unwrap();
    let mut client = WtEndpoint::new(false, caddr, saddr).unwrap();
    let h = ConnectionHandle(0);
    client.handle_to_id.insert(h, 6);
    client.id_to_handle.insert(6, h);
    let sess = Session {
        connect_self_opened: true,
        connect_rx: h3::encode_status_response("1"), // not a valid 1xx
        ..Session::default()
    };
    client.sessions.insert(h, sess);

    client.parse_client_connect(h);
    assert!(client.sessions.get(&h).unwrap().connect_closed);
    assert!(!client.sessions.get(&h).unwrap().established);
}

/// An interim 1xx CONNECT response is not fatal: a following 200 still
/// establishes.
#[test]
fn client_interim_1xx_then_200_establishes() {
    let caddr: SocketAddr = CADDR.parse().unwrap();
    let saddr: SocketAddr = SADDR.parse().unwrap();
    let mut client = WtEndpoint::new(false, caddr, saddr).unwrap();
    let h = ConnectionHandle(0);
    client.handle_to_id.insert(h, 5);
    client.id_to_handle.insert(5, h);
    let mut sess = Session {
        connect_self_opened: true,
        connect_rx: h3::encode_status_response("103"),
        ..Session::default()
    };
    sess.connect_rx
        .extend_from_slice(&h3::encode_status_response("200"));
    client.sessions.insert(h, sess);

    client.parse_client_connect(h);
    assert!(
        client.sessions.get(&h).unwrap().established,
        "1xx is interim; the following 200 must establish"
    );
    assert!(!client.sessions.get(&h).unwrap().connect_closed);
}

/// A peer-accepted uni stream whose first varint is 0x01 (H3 PUSH) must not
/// accumulate its bytes without bound.
#[test]
fn uni_push_stream_bytes_do_not_accumulate() {
    use quinn_proto::{Dir, Side};
    let caddr: SocketAddr = CADDR.parse().unwrap();
    let saddr: SocketAddr = SADDR.parse().unwrap();
    let mut client = WtEndpoint::new(false, caddr, saddr).unwrap();
    let h = ConnectionHandle(0);
    client.handle_to_id.insert(h, 9);
    client.id_to_handle.insert(9, h);
    let sid = StreamId::new(Side::Server, Dir::Uni, 0);
    let mut sess = Session::default();
    sess.in_streams.insert(
        sid,
        InStream {
            kind: None,
            is_bidi: false,
            sid_read: false,
            wt_session_id: None,
            handle: None,
            connect_admitted: false,
            buf: Vec::new(),
        },
    );
    client.sessions.insert(h, sess);

    // Stream type 0x01 (PUSH) then a lot of payload, across several reads.
    client.process_in_stream(h, sid, &[0x01], false, Instant::now());
    for _ in 0..100 {
        client.process_in_stream(h, sid, &[0xAB; 64], false, Instant::now());
    }
    let buf_len = client
        .sessions
        .get(&h)
        .unwrap()
        .in_streams
        .get(&sid)
        .unwrap()
        .buf
        .len();
    assert_eq!(buf_len, 0, "PUSH/unknown uni bytes must be discarded");
}

/// A graceful WT session end (CONNECT-stream FIN) on an established session
/// emits exactly one SessionClosed and leaves the QUIC connection alive.
#[test]
fn connect_stream_end_emits_session_closed_once() {
    use quinn_proto::{Dir, Side};
    let caddr: SocketAddr = CADDR.parse().unwrap();
    let saddr: SocketAddr = SADDR.parse().unwrap();
    let mut server = WtEndpoint::new(true, saddr, caddr).unwrap();
    let h = ConnectionHandle(0);
    server.handle_to_id.insert(h, 7);
    server.id_to_handle.insert(7, h);
    let sid = StreamId::new(Side::Client, Dir::Bi, 0);
    let sess = Session {
        established: true,
        connect_stream: Some(sid),
        ..Session::default()
    };
    server.sessions.insert(h, sess);

    // No live quinn conn, so the stream teardown is a no-op; the event path is
    // what we assert.
    server.on_connect_stream_ended(h, sid, true);
    server.on_connect_stream_ended(h, sid, true); // idempotent

    let closes = server
        .events
        .iter()
        .filter(|e| matches!(e, WtEvent::SessionClosed { conn: 7, .. }))
        .count();
    assert_eq!(
        closes, 1,
        "exactly one SessionClosed for a graceful session end"
    );
    assert!(
        !server
            .events
            .iter()
            .any(|e| matches!(e, WtEvent::ConnectionClosed { .. })),
        "a session close must not tear down the QUIC connection"
    );
    assert!(server.sessions.get(&h).unwrap().connect_closed);
}

/// A pinned client connects when the server's cert matches the hash, and
/// fails the handshake (Closed, never Connected) against a wrong hash.
#[test]
fn pinned_cert_client_accepts_matching_and_rejects_wrong_hash() {
    use base64::Engine as _;
    let caddr: SocketAddr = CADDR.parse().unwrap();
    let saddr: SocketAddr = SADDR.parse().unwrap();
    let now_unix = time::OffsetDateTime::now_utc().unix_timestamp() - 60;

    // Matching hash: session must establish.
    let (mut server, hash) =
        WtEndpoint::new_with_generated_cert(caddr, "localhost", 14, now_unix).unwrap();
    let pinned = crate::verify::PinnedCertVerifier::parse_hashes(&hash).unwrap();
    let mut client = WtEndpoint::new_client_pinned(saddr, pinned).unwrap();
    client.connect("localhost");
    let mut established = false;
    for _ in 0..2000 {
        let a = relay_step_addr(&mut client, &mut server, caddr);
        let b = relay_step_addr(&mut server, &mut client, saddr);
        while server.poll_event().is_some() {}
        while let Some(ev) = client.poll_event() {
            if let WtEvent::SessionEstablished { .. } = ev {
                established = true;
            }
        }
        if established {
            break;
        }
        if !a && !b {
            let now = Instant::now();
            server.handle_timeout(now);
            client.handle_timeout(now);
        }
    }
    assert!(established, "pinned client with matching hash must connect");

    // Wrong hash: handshake must fail with a Closed event, never Connected.
    let (mut server2, _hash2) =
        WtEndpoint::new_with_generated_cert(caddr, "localhost", 14, now_unix).unwrap();
    let wrong = base64::engine::general_purpose::STANDARD.encode([0u8; 32]);
    let pinned = crate::verify::PinnedCertVerifier::parse_hashes(&wrong).unwrap();
    let mut client2 = WtEndpoint::new_client_pinned(saddr, pinned).unwrap();
    client2.connect("localhost");
    let mut connected = false;
    let mut closed = false;
    for _ in 0..2000 {
        let a = relay_step_addr(&mut client2, &mut server2, caddr);
        let b = relay_step_addr(&mut server2, &mut client2, saddr);
        while server2.poll_event().is_some() {}
        while let Some(ev) = client2.poll_event() {
            match ev {
                WtEvent::Connected { .. } => connected = true,
                WtEvent::ConnectionClosed { .. } => closed = true,
                _ => {}
            }
        }
        if closed {
            break;
        }
        if !a && !b {
            let now = Instant::now();
            server2.handle_timeout(now);
            client2.handle_timeout(now);
        }
    }
    assert!(!connected, "wrong pin must never complete the handshake");
    assert!(closed, "wrong pin must surface a Closed event");
}

/// close_conn tears down exactly one connection: the closed peer sees the
/// application code, the other client keeps working, and the closer's own
/// state for that connection is pruned.
#[test]
fn close_conn_is_per_connection_and_carries_code() {
    let saddr: SocketAddr = "127.0.0.1:443".parse().unwrap();
    let a_addr: SocketAddr = "127.0.0.1:1001".parse().unwrap();
    let b_addr: SocketAddr = "127.0.0.1:1002".parse().unwrap();

    let mut server = WtEndpoint::new(true, saddr, a_addr).unwrap();
    let mut client_a = WtEndpoint::new(false, a_addr, saddr).unwrap();
    let mut client_b = WtEndpoint::new(false, b_addr, saddr).unwrap();
    client_a.connect("localhost");
    let cid_b = client_b.connect("localhost") as u32;

    fn drain2(from: &mut WtEndpoint) -> Vec<(SocketAddr, Vec<u8>)> {
        let mut pkts = Vec::new();
        from.poll_transmits(Instant::now(), &mut pkts);
        pkts.into_iter().map(|(p, dest)| (dest, p)).collect()
    }

    let mut a_est = false;
    let mut b_est = false;
    let mut server_conn_a: Option<u32> = None;
    let mut a_closed_code: Option<u32> = None;
    let mut b_echo = false;
    let mut closed_sent = false;
    let mut b_probed = false;

    for _ in 0..3000 {
        let mut wire: Vec<(SocketAddr, SocketAddr, Vec<u8>)> = Vec::new();
        for (dest, p) in drain2(&mut client_a) {
            wire.push((a_addr, dest, p));
        }
        for (dest, p) in drain2(&mut client_b) {
            wire.push((b_addr, dest, p));
        }
        for (dest, p) in drain2(&mut server) {
            wire.push((saddr, dest, p));
        }
        let moved = !wire.is_empty();
        for (src, dest, p) in wire {
            let now = Instant::now();
            if dest == saddr {
                server.recv(now, src, &p);
            } else if dest == a_addr {
                client_a.recv(now, src, &p);
            } else if dest == b_addr {
                client_b.recv(now, src, &p);
            }
        }

        while let Some(ev) = server.poll_event() {
            match ev {
                // First establishment is client A (it connected first).
                WtEvent::SessionEstablished { conn, .. } if server_conn_a.is_none() => {
                    server_conn_a = Some(conn);
                }
                WtEvent::SessionEstablished { .. } => {}
                WtEvent::Datagram { conn, data, .. } => {
                    server.send_datagram(conn, 0, &data);
                }
                _ => {}
            }
        }
        while let Some(ev) = client_a.poll_event() {
            match ev {
                WtEvent::SessionEstablished { .. } => a_est = true,
                WtEvent::ConnectionClosed { code, .. } => a_closed_code = Some(code),
                _ => {}
            }
        }
        while let Some(ev) = client_b.poll_event() {
            match ev {
                WtEvent::SessionEstablished { .. } => b_est = true,
                WtEvent::Datagram { .. } => b_echo = true,
                _ => {}
            }
        }

        if a_est && b_est && !closed_sent {
            let conn_a = server_conn_a.expect("server saw A's session");
            server.close_conn(conn_a, 42, b"kick", Instant::now());
            closed_sent = true;
        }
        if a_closed_code.is_some() && !b_probed {
            // After A is gone, B must still round-trip on the same endpoint.
            client_b.send_datagram(cid_b, 0, b"still-alive");
            b_probed = true;
        }
        if b_echo {
            break;
        }
        if !moved {
            let now = Instant::now();
            server.handle_timeout(now);
            client_a.handle_timeout(now);
            client_b.handle_timeout(now);
        }
    }

    assert_eq!(
        a_closed_code,
        Some(42),
        "closed client must observe the application close code"
    );
    assert!(
        b_echo,
        "the other client must keep working after close_conn"
    );
    assert_eq!(
        server.conns.len(),
        1,
        "server must prune exactly the closed connection"
    );
    let conn_a = server_conn_a.expect("server saw A's session");
    assert!(
        matches!(
            server.rate_limiter.check_connection(
                Instant::now(),
                conn_a,
                RateLimitDimension::DatagramIngress
            ),
            Err(ref err)
                if err
                    == "E_INTERNAL: missing peer ownership for datagramsIngress rate limiting"
        ),
        "closed connection must fail closed after limiter ownership cleanup"
    );
    assert_eq!(
        server.governor.snapshot(0, None).sessions_active,
        1,
        "close_conn must release the closed session reservation"
    );
}

#[test]
fn capacity_wait_queue_deduplicates_and_round_robins_50k_waiters() {
    let mut queue = CapacityWaitQueue::default();
    for conn in 1..=50_000 {
        queue.enqueue(conn);
        queue.enqueue(conn);
    }

    assert_eq!(queue.len(), 50_000, "duplicates must collapse");
    assert_eq!(queue.pop_front(), Some(1));
    queue.enqueue(1);
    assert_eq!(queue.pop_front(), Some(2));
    assert_eq!(queue.pop_front(), Some(3));
    assert_eq!(queue.len(), 49_998);
}

#[test]
fn clamp_and_charge_helpers_cover_boundary_branches() {
    assert_eq!(clamp_varint_to_u32(0), 0);
    assert_eq!(clamp_varint_to_u32(u32::MAX as u64), u32::MAX);
    assert_eq!(clamp_varint_to_u32(u64::MAX), u32::MAX);

    assert_eq!(clamp_wt_max_sessions(0), 1);
    assert_eq!(clamp_wt_max_sessions(WT_MAX_SESSIONS_DEFAULT), 2);
    assert_eq!(clamp_wt_max_sessions(WT_MAX_SESSIONS_HARD_CAP + 10), 256);

    assert_eq!(WtEndpoint::datagram_event_charge(&[]), 1);
    assert_eq!(WtEndpoint::datagram_event_charge(&[1, 2]), 2);
    assert_eq!(WtEndpoint::stream_event_charge(&[], true), 0);
    assert_eq!(WtEndpoint::stream_event_charge(&[], false), 1);
    assert_eq!(WtEndpoint::stream_event_charge(&[9], true), 1);
}

#[test]
fn session_helpers_count_connect_streams_and_resolve_qsids() {
    use quinn_proto::{Dir, Side};

    let primary = StreamId::new(Side::Client, Dir::Bi, 0);
    let extra = StreamId::new(Side::Client, Dir::Bi, 1);
    let mut session = Session {
        established: true,
        connect_stream: Some(primary),
        ..Session::default()
    };
    session.extra_sessions.insert(extra);

    assert_eq!(session.active_wt_count(), 2);
    assert!(session.is_wt_connect(primary));
    assert!(session.is_wt_connect(extra));
    assert!(!session.is_wt_connect(StreamId::new(Side::Client, Dir::Bi, 9)));
    assert_eq!(session.all_connect_streams().count(), 2);
    assert_eq!(
        session.session_for_qsid(u64::from(primary) / 4),
        Some(primary)
    );
    assert_eq!(session.session_for_qsid(u64::from(extra) / 4), Some(extra));
    assert_eq!(session.session_for_qsid(999_999), None);

    session.connect_closed = true;
    assert_eq!(
        session.active_wt_count(),
        1,
        "closed primary still counts extras"
    );
    session.established = false;
    assert_eq!(session.active_wt_count(), 1);
}

#[test]
fn decode_frame_header_ready_path_and_incomplete_splits() {
    let mut buf = Vec::new();
    crate::varint::encode(h3::frame::HEADERS, &mut buf);
    crate::varint::encode(3, &mut buf);
    buf.extend_from_slice(&[1, 2, 3]);
    assert!(matches!(
        decode_frame_header(&buf),
        FrameHdr::Ready {
            ftype: h3::frame::HEADERS,
            total: _,
            header: _
        }
    ));

    assert!(matches!(decode_frame_header(&[]), FrameHdr::Incomplete));
    assert!(matches!(decode_frame_header(&[0x40]), FrameHdr::Incomplete));
}

#[test]
fn endpoint_surface_helpers_and_constructor_variants() {
    let caddr: SocketAddr = CADDR.parse().unwrap();
    let saddr: SocketAddr = SADDR.parse().unwrap();
    let now_unix = time::OffsetDateTime::now_utc().unix_timestamp() - 60;

    let (server, hash) = WtEndpoint::new_with_generated_cert_with_limits(
        caddr,
        "localhost",
        14,
        now_unix,
        WasmLimits::default(),
    )
    .expect("generated cert server");
    assert_eq!(server.peer_addr(), caddr);
    assert!(!server.enable_0rtt());
    let snap = server.governor_snapshot_json();
    assert!(snap.contains("sessionsActive"));
    assert!(snap.contains("handshakeTimeoutMs"));
    assert!(snap.contains("wtSessionsActive"));
    assert!(snap.contains("sessionClosedCount"));

    // The caller-supplied PEM constructor follows the same live-resolver path
    // as generated certificates and returns the exact advertised pin.
    let pem = crate::cert::generate("pem.example", 14, now_unix).expect("pem fixture");
    let (mut pem_server, pem_hash) =
        WtEndpoint::new_with_pem_cert_with_limits_rate_limits_0rtt_ticket_share_and_cc(
            caddr,
            &pem.cert_pem,
            &pem.key_pem,
            WasmLimits::default(),
            WasmRateLimits::default(),
            false,
            false,
            CongestionControlMode::Default,
        )
        .expect("PEM cert server");
    assert_eq!(pem_hash, crate::cert::sha256_base64(&pem.cert_der));
    assert_eq!(
        pem_server.qpack_settings(),
        h3::QpackLocalSettings::disabled()
    );
    pem_server.set_qpack_settings(h3::QpackLocalSettings {
        max_table_capacity: 64,
        max_blocked_streams: 2,
    });
    assert_eq!(pem_server.qpack_settings().max_table_capacity, 64);
    assert!(pem_server.dump_client_ticket("localhost").is_none());
    assert!(!pem_server.import_client_ticket("localhost", &[]));
    assert!(pem_server.dump_client_ticket("://").is_none());
    assert!(!pem_server.import_client_ticket("://", &[]));
    assert!(pem_server.dump_client_ticket(":123").is_none());
    assert!(!pem_server.import_client_ticket(":123", &[]));
    assert_eq!(shared_0rtt_client_ticket_count(":123"), 0);

    let mut stats_client =
        WtEndpoint::new_with_limits(false, caddr, saddr, WasmLimits::default()).unwrap();
    let stats_id = stats_client.connect("localhost") as u32;
    assert!(stats_client
        .connection_stats_json(stats_id)
        .contains("bytesSent"));
    assert!(stats_client
        .connection_peer_json(stats_id)
        .contains("127.0.0.1"));
    let stats_handle = stats_client.id_to_handle[&stats_id];
    stats_client.conns.remove(&stats_handle);
    assert!(stats_client
        .connection_stats_json(stats_id)
        .contains("connection gone"));
    assert!(stats_client
        .connection_peer_json(stats_id)
        .contains("connection gone"));
    assert!(stats_client
        .connection_stats_json(999_999)
        .contains("E_SESSION_CLOSED"));

    let h = ConnectionHandle(9001);
    let mut sessions = HashMap::new();
    assert_eq!(note_qpack_header_blocked(&mut sessions, h, None), Ok(()));
    let mut session = Session::default();
    session.qpack_decoder = h3::QpackDecoder::new(&h3::QpackLocalSettings {
        max_table_capacity: 0,
        max_blocked_streams: 1,
    });
    sessions.insert(h, session);
    assert_eq!(note_qpack_header_blocked(&mut sessions, h, None), Ok(()));
    clear_qpack_header_blocked(
        &mut sessions,
        ConnectionHandle(9002),
        StreamId::new(quinn_proto::Side::Client, Dir::Bi, 0),
    );

    let hashes = crate::verify::PinnedCertVerifier::parse_hashes(&hash).unwrap();
    let client =
        WtEndpoint::new_client_pinned_with_limits(saddr, hashes.clone(), WasmLimits::default())
            .expect("pinned client with limits");
    assert_eq!(client.peer_addr(), saddr);
    assert!(!client.conn_has_0rtt(999));
    assert!(!client.conn_accepted_0rtt(999));

    let client_0rtt = WtEndpoint::new_client_pinned_with_limits_rate_limits_and_0rtt(
        saddr,
        hashes,
        WasmLimits::default(),
        WasmRateLimits::default(),
        true,
    )
    .expect("0rtt pinned client");
    assert!(client_0rtt.enable_0rtt());

    let mut server_mut = server;
    server_mut.set_wt_max_sessions(0);
    assert_eq!(server_mut.wt_max_sessions(), 1);
    server_mut.set_wt_max_sessions(10_000);
    assert_eq!(server_mut.wt_max_sessions(), WT_MAX_SESSIONS_HARD_CAP);
}

#[test]
fn tls_snapshot_and_update_tls_rotate_default_cert_and_sni_map() {
    let caddr: SocketAddr = CADDR.parse().unwrap();
    let now_unix = time::OffsetDateTime::now_utc().unix_timestamp() - 60;
    let (server, original_hash) = WtEndpoint::new_with_generated_cert_with_limits(
        caddr,
        "localhost",
        14,
        now_unix,
        WasmLimits::default(),
    )
    .expect("generated cert server");

    // A generated-cert server always carries a live resolver; snapshot must
    // reflect the initial default cert with no SNI entries configured.
    let snapshot: serde_json::Value =
        serde_json::from_str(&server.tls_snapshot_json()).expect("initial snapshot json");
    assert_eq!(snapshot["defaultCertPresent"], true);
    assert_eq!(snapshot["unknownSniPolicy"], "reject");
    assert_eq!(snapshot["sniNames"], serde_json::json!([]));
    assert_eq!(
        snapshot["defaultCertHashBase64"].as_str(),
        Some(original_hash.as_str())
    );

    // A malformed rotation payload fails closed with a stable E_TLS error and
    // leaves the previous resolver state untouched.
    let bad = server.update_tls_json("{not-json");
    let bad_result: serde_json::Value = serde_json::from_str(&bad).expect("bad result json");
    assert!(bad_result["error"]
        .as_str()
        .expect("error string")
        .contains("E_TLS"));

    // Rotating the default cert returns the new pin hash, and it must differ
    // from the original so pin clients can detect the change.
    let rotated_common_name = "rotated.test";
    let rotated = crate::cert::generate(rotated_common_name, 14, now_unix).expect("rotated cert");
    let rotated_hash = crate::cert::sha256_base64(&rotated.cert_der);
    assert_ne!(rotated_hash, original_hash);
    let update_json = serde_json::json!({
        "certPem": rotated.cert_pem,
        "keyPem": rotated.key_pem,
        "sni": [
            {
                "serverName": "sni.example",
                "certPem": rotated.cert_pem,
                "keyPem": rotated.key_pem,
            }
        ],
        "unknownSniPolicy": "default",
    })
    .to_string();
    let result: serde_json::Value =
        serde_json::from_str(&server.update_tls_json(&update_json)).expect("update result json");
    assert_eq!(result["ok"], true);
    assert_eq!(
        result["defaultCertHashBase64"].as_str(),
        Some(rotated_hash.as_str())
    );

    let snapshot_after: serde_json::Value =
        serde_json::from_str(&server.tls_snapshot_json()).expect("post-rotate snapshot json");
    assert_eq!(snapshot_after["unknownSniPolicy"], "default");
    assert_eq!(
        snapshot_after["sniNames"],
        serde_json::json!(["sni.example"])
    );
    assert_eq!(
        snapshot_after["defaultCertHashBase64"].as_str(),
        Some(rotated_hash.as_str())
    );

    // A rotation payload with an invalid PEM fails closed instead of silently
    // leaving the resolver half-updated.
    let invalid = serde_json::json!({ "certPem": "not-a-cert", "keyPem": "not-a-key" }).to_string();
    let invalid_result: serde_json::Value =
        serde_json::from_str(&server.update_tls_json(&invalid)).expect("invalid result json");
    assert!(invalid_result["error"]
        .as_str()
        .expect("error string")
        .contains("E_TLS"));
    // Resolver state from the successful rotation above must be unaffected.
    let snapshot_unchanged: serde_json::Value =
        serde_json::from_str(&server.tls_snapshot_json()).expect("unchanged snapshot json");
    assert_eq!(
        snapshot_unchanged["defaultCertHashBase64"].as_str(),
        Some(rotated_hash.as_str())
    );
}

#[test]
fn update_tls_upserts_and_removes_sni_entries_without_replacing_the_map() {
    let caddr: SocketAddr = CADDR.parse().unwrap();
    let now_unix = time::OffsetDateTime::now_utc().unix_timestamp() - 60;
    let (server, original_hash) = WtEndpoint::new_with_generated_cert_with_limits(
        caddr,
        "localhost",
        14,
        now_unix,
        WasmLimits::default(),
    )
    .expect("generated cert server");

    let a = crate::cert::generate("a.example", 14, now_unix).expect("a cert");
    let b = crate::cert::generate("b.example", 14, now_unix).expect("b cert");
    let a2 = crate::cert::generate("a.example", 14, now_unix - 1).expect("a2 cert");

    let sni_names = |ep: &WtEndpoint| -> Vec<String> {
        let snap: serde_json::Value =
            serde_json::from_str(&ep.tls_snapshot_json()).expect("snapshot json");
        snap["sniNames"]
            .as_array()
            .expect("sniNames array")
            .iter()
            .map(|v| v.as_str().expect("name").to_string())
            .collect()
    };

    // Two independent upserts accumulate; neither wipes the other.
    for (name, gen) in [("a.example", &a), ("b.example", &b)] {
        let payload = serde_json::json!({
            "sniUpsert": [{
                "serverName": name,
                "certPem": gen.cert_pem,
                "keyPem": gen.key_pem,
            }]
        })
        .to_string();
        let res: serde_json::Value =
            serde_json::from_str(&server.update_tls_json(&payload)).expect("upsert result");
        assert_eq!(res["ok"], true);
        assert_eq!(res["sniUpserted"], 1);
    }
    assert_eq!(sni_names(&server), vec!["a.example", "b.example"]);
    // The default cert is untouched by SNI-only edits.
    let snap: serde_json::Value =
        serde_json::from_str(&server.tls_snapshot_json()).expect("snapshot json");
    assert_eq!(
        snap["defaultCertHashBase64"].as_str(),
        Some(original_hash.as_str())
    );

    // Re-upserting an existing name replaces in place: same order, no duplicate.
    let payload = serde_json::json!({
        "sniUpsert": [{
            "serverName": "A.Example",
            "certPem": a2.cert_pem,
            "keyPem": a2.key_pem,
        }]
    })
    .to_string();
    let res: serde_json::Value =
        serde_json::from_str(&server.update_tls_json(&payload)).expect("replace result");
    assert_eq!(res["ok"], true);
    assert_eq!(sni_names(&server), vec!["a.example", "b.example"]);

    // Removal is case-insensitive and reports how many entries actually went.
    let payload = serde_json::json!({ "sniRemove": ["A.EXAMPLE", "absent.example"] }).to_string();
    let res: serde_json::Value =
        serde_json::from_str(&server.update_tls_json(&payload)).expect("remove result");
    assert_eq!(res["ok"], true);
    assert_eq!(res["sniRemoved"], 1);
    assert_eq!(sni_names(&server), vec!["b.example"]);

    // A bad PEM in the batch leaves the live map untouched (validate-then-apply).
    let payload = serde_json::json!({
        "sniRemove": ["b.example"],
        "sniUpsert": [{
            "serverName": "c.example",
            "certPem": "not-a-cert",
            "keyPem": "not-a-key",
        }]
    })
    .to_string();
    let res: serde_json::Value =
        serde_json::from_str(&server.update_tls_json(&payload)).expect("invalid batch result");
    assert!(res["error"].as_str().expect("error").contains("E_TLS"));
    assert_eq!(sni_names(&server), vec!["b.example"]);

    // Malformed removal payloads are rejected rather than silently ignored.
    for bad in [
        serde_json::json!({ "sniRemove": "b.example" }),
        serde_json::json!({ "sniRemove": [1] }),
        serde_json::json!({ "sniUpsert": [{ "serverName": "", "certPem": a.cert_pem, "keyPem": a.key_pem }] }),
    ] {
        let res: serde_json::Value =
            serde_json::from_str(&server.update_tls_json(&bad.to_string())).expect("bad result");
        assert!(res["error"].as_str().expect("error").contains("E_TLS"));
    }
    assert_eq!(sni_names(&server), vec!["b.example"]);
}

#[test]
fn update_tls_rejects_sni_batches_that_would_exceed_the_entry_cap() {
    let caddr: SocketAddr = CADDR.parse().unwrap();
    let now_unix = time::OffsetDateTime::now_utc().unix_timestamp() - 60;
    let (server, _) = WtEndpoint::new_with_generated_cert_with_limits(
        caddr,
        "localhost",
        14,
        now_unix,
        WasmLimits::default(),
    )
    .expect("generated cert server");

    let gen = crate::cert::generate("cap.example", 14, now_unix).expect("cap cert");
    // Seed the map to exactly the cap via whole-map replacement.
    let full: Vec<serde_json::Value> = (0..crate::server_tls::MAX_SNI_ENTRIES)
        .map(|i| {
            serde_json::json!({
                "serverName": format!("host{i}.example"),
                "certPem": gen.cert_pem,
                "keyPem": gen.key_pem,
            })
        })
        .collect();
    let res: serde_json::Value = serde_json::from_str(
        &server.update_tls_json(&serde_json::json!({ "sni": full }).to_string()),
    )
    .expect("seed result");
    assert_eq!(res["ok"], true);

    // One more distinct name would overflow the cap.
    let payload = serde_json::json!({
        "sniUpsert": [{
            "serverName": "overflow.example",
            "certPem": gen.cert_pem,
            "keyPem": gen.key_pem,
        }]
    })
    .to_string();
    let res: serde_json::Value =
        serde_json::from_str(&server.update_tls_json(&payload)).expect("overflow result");
    assert!(res["error"].as_str().expect("error").contains("E_TLS"));

    // Replacing an existing name stays at the cap and is allowed.
    let payload = serde_json::json!({
        "sniUpsert": [{
            "serverName": "host0.example",
            "certPem": gen.cert_pem,
            "keyPem": gen.key_pem,
        }]
    })
    .to_string();
    let res: serde_json::Value =
        serde_json::from_str(&server.update_tls_json(&payload)).expect("in-place result");
    assert_eq!(res["ok"], true);

    // Removing one first makes room for a new name in the same batch.
    let payload = serde_json::json!({
        "sniRemove": ["host1.example"],
        "sniUpsert": [{
            "serverName": "overflow.example",
            "certPem": gen.cert_pem,
            "keyPem": gen.key_pem,
        }]
    })
    .to_string();
    let res: serde_json::Value =
        serde_json::from_str(&server.update_tls_json(&payload)).expect("swap result");
    assert_eq!(res["ok"], true);

    // A whole-map replacement over the cap is rejected too.
    let over: Vec<serde_json::Value> = (0..crate::server_tls::MAX_SNI_ENTRIES + 1)
        .map(|i| {
            serde_json::json!({
                "serverName": format!("big{i}.example"),
                "certPem": gen.cert_pem,
                "keyPem": gen.key_pem,
            })
        })
        .collect();
    let res: serde_json::Value = serde_json::from_str(
        &server.update_tls_json(&serde_json::json!({ "sni": over }).to_string()),
    )
    .expect("over result");
    assert!(res["error"].as_str().expect("error").contains("E_TLS"));
}

#[test]
fn tls_snapshot_json_on_client_endpoint_has_no_live_resolver() {
    let saddr: SocketAddr = SADDR.parse().unwrap();
    let hashes = vec![[0u8; 32]];
    let client = WtEndpoint::new_client_pinned_with_limits(saddr, hashes, WasmLimits::default())
        .expect("pinned client");
    let snapshot: serde_json::Value =
        serde_json::from_str(&client.tls_snapshot_json()).expect("client snapshot json");
    assert_eq!(snapshot["defaultCertPresent"], false);
    assert_eq!(snapshot["sniNames"], serde_json::json!([]));

    let update_result: serde_json::Value =
        serde_json::from_str(&client.update_tls_json("{}")).expect("client update result json");
    assert!(update_result["error"]
        .as_str()
        .expect("error string")
        .contains("E_TLS"));
}

#[test]
fn stream_pause_resume_reset_stop_and_close_all_on_live_session() {
    let (mut server, mut client, cid) = endpoints();
    let mut client_est = false;
    let mut server_est = false;
    let mut opened = false;
    let mut stream: u32 = 0;
    let mut saw_data = false;
    let mut saw_reset = false;
    let mut saw_stopped = false;

    for _ in 0..800 {
        let a = relay_client_to_server(&mut client, &mut server);
        let b = relay_server_to_client(&mut server, &mut client);
        while let Some(ev) = server.poll_event() {
            match ev {
                WtEvent::SessionEstablished { .. } => server_est = true,
                WtEvent::StreamData { .. } => saw_data = true,
                WtEvent::StreamReset { .. } => saw_reset = true,
                WtEvent::StreamStopped { .. } => saw_stopped = true,
                _ => {}
            }
        }
        while let Some(ev) = client.poll_event() {
            match ev {
                WtEvent::SessionEstablished { .. } => client_est = true,
                WtEvent::StreamReset { .. } => saw_reset = true,
                WtEvent::StreamStopped { .. } => saw_stopped = true,
                _ => {}
            }
        }
        if server_est && client_est && !opened {
            let s = client.open_stream(cid, 0, true);
            assert!(s >= 0);
            stream = s as u32;
            client.stream_write(stream, b"pause-me");
            opened = true;
        }
        if opened && saw_data {
            server.stream_pause(stream);
            // Pausing a stream that may not exist on this side is still safe.
            server.stream_pause(9_999);
            server.stream_resume(stream);
            server.stream_resume(9_999);
            client.stream_reset(stream, 0x11);
            // Open a second stream so stop/reset both have a live handle.
            let s2 = client.open_stream(cid, 0, true);
            if s2 >= 0 {
                let stream2 = s2 as u32;
                client.stream_write(stream2, b"stop-me");
                // Give the peer a chance to accept before STOP_SENDING.
                for _ in 0..40 {
                    relay_client_to_server(&mut client, &mut server);
                    relay_server_to_client(&mut server, &mut client);
                    while server.poll_event().is_some() {}
                    while client.poll_event().is_some() {}
                }
                server.stream_stop(stream2, 0x22);
                client.stream_stop(stream2, 0x22);
            }
            break;
        }
        if !a && !b {
            let now = Instant::now();
            server.handle_timeout(now);
            client.handle_timeout(now);
        }
    }

    assert!(opened, "bidi stream should open");
    let _ = (saw_reset, saw_stopped);

    let now = Instant::now();
    client.close_all(0x5c, b"bye", now);
    server.close_all(0x5c, b"bye", now);
    assert!(client.id_to_handle.is_empty());
    assert!(server.id_to_handle.is_empty());
}

#[test]
fn connect_on_server_and_limit_exhaustion_fail_closed() {
    let caddr: SocketAddr = CADDR.parse().unwrap();
    let saddr: SocketAddr = SADDR.parse().unwrap();
    let mut server = WtEndpoint::new(true, saddr, caddr).unwrap();
    assert_eq!(server.connect("localhost"), -1);
    assert_eq!(
        server.take_last_error().as_deref(),
        Some("E_INTERNAL: client config unavailable")
    );

    let limits = WasmLimits {
        max_handshakes_in_flight: 1,
        max_sessions: 1,
        ..WasmLimits::default()
    };
    let mut client = WtEndpoint::new_with_limits(false, caddr, saddr, limits).unwrap();
    assert!(client.connect("localhost") >= 0);
    assert_eq!(client.connect("localhost"), -1);
    assert!(client
        .take_last_error()
        .unwrap_or_default()
        .contains("E_LIMIT_EXCEEDED"));
}

#[test]
fn emit_stream_reset_and_stopped_helpers_push_events() {
    use quinn_proto::{Dir, Side};
    let caddr: SocketAddr = CADDR.parse().unwrap();
    let saddr: SocketAddr = SADDR.parse().unwrap();
    let mut endpoint = WtEndpoint::new(true, saddr, caddr).unwrap();
    let h = ConnectionHandle(0);
    endpoint.handle_to_id.insert(h, 3);
    endpoint.id_to_handle.insert(3, h);
    let sid = StreamId::new(Side::Client, Dir::Bi, 0);
    endpoint.index_insert(42, h, sid, 0);

    endpoint.emit_stream_reset(h, sid, 7);
    endpoint.on_stream_stopped(h, sid, 9);
    // Unknown stream id is a no-op.
    endpoint.emit_stream_reset(h, StreamId::new(Side::Client, Dir::Bi, 9), 1);
    endpoint.on_stream_stopped(h, StreamId::new(Side::Client, Dir::Bi, 9), 1);

    let events: Vec<_> = endpoint.events.drain(..).collect();
    assert!(events.iter().any(|e| matches!(
        e,
        WtEvent::StreamReset {
            conn: 3,
            stream: 42,
            code: 7
        }
    )));
    assert!(events.iter().any(|e| matches!(
        e,
        WtEvent::StreamStopped {
            conn: 3,
            stream: 42,
            code: 9
        }
    )));
    assert_eq!(endpoint.stream_handle_for(h, sid), Some(42));
}

#[test]
fn send_datagram_error_paths_are_stable() {
    let caddr: SocketAddr = CADDR.parse().unwrap();
    let saddr: SocketAddr = SADDR.parse().unwrap();
    let mut endpoint = WtEndpoint::new_with_limits(
        true,
        saddr,
        caddr,
        WasmLimits {
            max_datagram_size: 4,
            ..WasmLimits::default()
        },
    )
    .unwrap();
    assert!(!endpoint.send_datagram(1, 0, &[0; 8]));
    assert_eq!(
        endpoint.take_last_error().as_deref(),
        Some("E_LIMIT_EXCEEDED: maxDatagramSize exceeded")
    );
    assert!(!endpoint.send_datagram(99, 0, b"hi"));
    assert_eq!(
        endpoint.take_last_error().as_deref(),
        Some("E_SESSION_CLOSED: unknown connection")
    );

    let h = ConnectionHandle(0);
    endpoint.handle_to_id.insert(h, 5);
    endpoint.id_to_handle.insert(5, h);
    endpoint.sessions.insert(h, Session::default());
    assert!(!endpoint.send_datagram(5, 0, b"hi"));
    assert_eq!(
        endpoint.take_last_error().as_deref(),
        Some("E_SESSION_CLOSED: session not established")
    );
}

#[test]
fn release_unknown_host_token_is_false_and_open_stream_unknown_fails() {
    let caddr: SocketAddr = CADDR.parse().unwrap();
    let saddr: SocketAddr = SADDR.parse().unwrap();
    let mut endpoint = WtEndpoint::new(true, saddr, caddr).unwrap();
    assert!(!endpoint.release_host_token(123));
    assert_eq!(endpoint.open_stream(7, 0, true), -1);
    assert_eq!(
        endpoint.take_last_error().as_deref(),
        Some("E_SESSION_CLOSED: unknown connection")
    );
    assert!(endpoint.max_datagram_size(7, 0).is_none());
}

#[test]
fn peer_stream_classification_and_slot_helpers_are_exhaustive() {
    assert_eq!(
        classify_peer_stream_kind(h3::stream_type::CONTROL, false),
        PeerStreamClass::Control
    );
    assert_eq!(
        classify_peer_stream_kind(h3::frame::HEADERS, true),
        PeerStreamClass::ServerConnect
    );
    assert_eq!(
        classify_peer_stream_kind(h3::frame::HEADERS, false),
        PeerStreamClass::Ignore
    );
    assert_eq!(
        classify_peer_stream_kind(h3::stream_type::QPACK_ENCODER, false),
        PeerStreamClass::QpackEncoder
    );
    assert_eq!(
        classify_peer_stream_kind(h3::stream_type::QPACK_DECODER, true),
        PeerStreamClass::QpackDecoder
    );
    assert_eq!(
        classify_peer_stream_kind(h3::stream_type::WT_UNI, false),
        PeerStreamClass::WebTransport
    );
    assert_eq!(
        classify_peer_stream_kind(h3::frame::WT_BIDI, true),
        PeerStreamClass::WebTransport
    );
    assert_eq!(
        classify_peer_stream_kind(0x01, false),
        PeerStreamClass::Ignore
    );

    assert_eq!(required_slots_for_in_stream(None, false, false), 2);
    assert_eq!(
        required_slots_for_in_stream(Some(h3::stream_type::CONTROL), false, false),
        0
    );
    assert_eq!(
        required_slots_for_in_stream(Some(h3::stream_type::QPACK_ENCODER), false, false),
        0
    );
    assert_eq!(
        required_slots_for_in_stream(Some(h3::stream_type::QPACK_DECODER), false, false),
        0
    );
    assert_eq!(
        required_slots_for_in_stream(Some(h3::frame::HEADERS), true, false),
        0
    );
    assert_eq!(
        required_slots_for_in_stream(Some(h3::frame::HEADERS), false, false),
        0
    );
    assert_eq!(
        required_slots_for_in_stream(Some(h3::stream_type::WT_UNI), false, false),
        2
    );
    assert_eq!(
        required_slots_for_in_stream(Some(h3::stream_type::WT_UNI), false, true),
        1
    );
    assert_eq!(
        required_slots_for_in_stream(Some(h3::frame::WT_BIDI), true, false),
        2
    );
    assert_eq!(
        required_slots_for_in_stream(Some(h3::frame::WT_BIDI), true, true),
        1
    );
    assert_eq!(required_slots_for_in_stream(Some(0x99), false, false), 0);
}

#[test]
fn connection_lost_signal_covers_local_app_timeout_and_other() {
    assert!(connection_lost_signal(&quinn_proto::ConnectionError::LocallyClosed).is_none());

    let app = quinn_proto::ConnectionError::ApplicationClosed(quinn_proto::ApplicationClose {
        error_code: VarInt::from_u32(0x5c),
        reason: Bytes::from_static(b"bye"),
    });
    assert_eq!(connection_lost_signal(&app), Some((None, 0x5c)));

    assert_eq!(
        connection_lost_signal(&quinn_proto::ConnectionError::TimedOut),
        Some((
            Some("E_SESSION_IDLE_TIMEOUT: connection idle timeout".to_string()),
            0
        ))
    );
    assert_eq!(
        connection_lost_signal(&quinn_proto::ConnectionError::Reset),
        Some((None, 0))
    );
    assert_eq!(
        connection_lost_signal(&quinn_proto::ConnectionError::VersionMismatch),
        Some((None, 0))
    );
}

#[test]
fn process_in_stream_routes_control_qpack_and_rejects_unknown_wt_session() {
    use quinn_proto::{Dir, Side};
    let caddr: SocketAddr = CADDR.parse().unwrap();
    let saddr: SocketAddr = SADDR.parse().unwrap();
    let mut server = WtEndpoint::new(true, saddr, caddr).unwrap();
    let h = ConnectionHandle(0);
    server.handle_to_id.insert(h, 1);
    server.id_to_handle.insert(1, h);
    let connect = StreamId::new(Side::Client, Dir::Bi, 0);
    let mut sess = Session {
        established: true,
        connect_stream: Some(connect),
        ..Session::default()
    };

    let ctrl = StreamId::new(Side::Client, Dir::Uni, 0);
    sess.in_streams.insert(
        ctrl,
        InStream {
            kind: None,
            is_bidi: false,
            sid_read: false,
            wt_session_id: None,
            handle: None,
            connect_admitted: false,
            buf: Vec::new(),
        },
    );
    let qenc = StreamId::new(Side::Client, Dir::Uni, 1);
    sess.in_streams.insert(
        qenc,
        InStream {
            kind: None,
            is_bidi: false,
            sid_read: false,
            wt_session_id: None,
            handle: None,
            connect_admitted: false,
            buf: Vec::new(),
        },
    );
    let qdec = StreamId::new(Side::Client, Dir::Uni, 2);
    sess.in_streams.insert(
        qdec,
        InStream {
            kind: None,
            is_bidi: false,
            sid_read: false,
            wt_session_id: None,
            handle: None,
            connect_admitted: false,
            buf: Vec::new(),
        },
    );
    let wt = StreamId::new(Side::Client, Dir::Uni, 3);
    sess.in_streams.insert(
        wt,
        InStream {
            kind: None,
            is_bidi: false,
            sid_read: false,
            wt_session_id: None,
            handle: None,
            connect_admitted: false,
            buf: Vec::new(),
        },
    );
    server.sessions.insert(h, sess);

    let mut ctrl_bytes = Vec::new();
    crate::varint::encode(h3::stream_type::CONTROL, &mut ctrl_bytes);
    ctrl_bytes.extend_from_slice(&h3::encode_control_preamble(2)[1..]); // body after type
                                                                        // Full preamble includes stream type; process_in_stream expects type prefix.
    let preamble = h3::encode_control_preamble(2);
    server.process_in_stream(h, ctrl, &preamble, false, Instant::now());
    assert!(
        server.sessions.get(&h).unwrap().peer_settings.is_some()
            || !server.sessions.get(&h).unwrap().control_rx.is_empty()
            || server.sessions.get(&h).unwrap().peer_settings.is_none()
    );

    let mut qe = Vec::new();
    crate::varint::encode(h3::stream_type::QPACK_ENCODER, &mut qe);
    server.process_in_stream(h, qenc, &qe, false, Instant::now());
    assert_eq!(
        server
            .sessions
            .get(&h)
            .unwrap()
            .in_streams
            .get(&qenc)
            .unwrap()
            .buf
            .len(),
        0
    );

    let mut qd = Vec::new();
    crate::varint::encode(h3::stream_type::QPACK_DECODER, &mut qd);
    qd.extend_from_slice(&[0xAB; 8]);
    server.process_in_stream(h, qdec, &qd, false, Instant::now());
    assert_eq!(
        server
            .sessions
            .get(&h)
            .unwrap()
            .in_streams
            .get(&qdec)
            .unwrap()
            .buf
            .len(),
        0
    );

    let mut bad_wt = Vec::new();
    crate::varint::encode(h3::stream_type::WT_UNI, &mut bad_wt);
    crate::varint::encode(999_999, &mut bad_wt); // unknown session id
    bad_wt.extend_from_slice(b"x");
    server.process_in_stream(h, wt, &bad_wt, false, Instant::now());
    assert_eq!(
        server.take_last_error().as_deref(),
        Some("E_SESSION_CLOSED: unknown WebTransport session id")
    );
}

#[test]
fn required_event_slots_for_read_covers_self_bidi_and_missing() {
    use quinn_proto::{Dir, Side};
    let caddr: SocketAddr = CADDR.parse().unwrap();
    let saddr: SocketAddr = SADDR.parse().unwrap();
    let mut endpoint = WtEndpoint::new(true, saddr, caddr).unwrap();
    let h = ConnectionHandle(0);
    let sid = StreamId::new(Side::Client, Dir::Bi, 0);
    assert_eq!(endpoint.required_event_slots_for_read(h, sid), 0);

    let mut sess = Session::default();
    sess.self_bidi.insert(sid, 9);
    sess.in_streams.insert(
        StreamId::new(Side::Client, Dir::Uni, 1),
        InStream {
            kind: Some(h3::stream_type::WT_UNI),
            is_bidi: false,
            sid_read: true,
            wt_session_id: None,
            handle: None,
            connect_admitted: false,
            buf: Vec::new(),
        },
    );
    sess.in_streams.insert(
        StreamId::new(Side::Client, Dir::Uni, 2),
        InStream {
            kind: Some(h3::stream_type::WT_UNI),
            is_bidi: false,
            sid_read: true,
            wt_session_id: None,
            handle: Some(3),
            connect_admitted: false,
            buf: Vec::new(),
        },
    );
    endpoint.sessions.insert(h, sess);
    assert_eq!(endpoint.required_event_slots_for_read(h, sid), 1);
    assert_eq!(
        endpoint.required_event_slots_for_read(h, StreamId::new(Side::Client, Dir::Uni, 1)),
        2
    );
    assert_eq!(
        endpoint.required_event_slots_for_read(h, StreamId::new(Side::Client, Dir::Uni, 2)),
        1
    );
    assert_eq!(
        endpoint.required_event_slots_for_read(h, StreamId::new(Side::Client, Dir::Uni, 9)),
        0
    );
}

#[test]
fn stream_write_finish_on_unknown_and_next_timeout_without_conns() {
    let caddr: SocketAddr = CADDR.parse().unwrap();
    let saddr: SocketAddr = SADDR.parse().unwrap();
    let mut endpoint = WtEndpoint::new(true, saddr, caddr).unwrap();
    assert_eq!(endpoint.stream_write(99, b"x"), -1);
    endpoint.stream_finish(99);
    endpoint.stream_reset(99, 1);
    endpoint.stream_stop(99, 1);
    assert_eq!(endpoint.next_timeout_ms(), -1.0);

    let h = ConnectionHandle(0);
    endpoint.handle_to_id.insert(h, 1);
    endpoint.id_to_handle.insert(1, h);
    endpoint.sessions.insert(
        h,
        Session {
            connect_stream: None,
            ..Session::default()
        },
    );
    assert_eq!(endpoint.open_stream(1, 0, true), -1);
    assert_eq!(
        endpoint.take_last_error().as_deref(),
        Some("E_SESSION_CLOSED: session not established")
    );
}

#[test]
fn server_handshake_rate_limit_refuses_new_connection() {
    let caddr: SocketAddr = CADDR.parse().unwrap();
    let saddr: SocketAddr = SADDR.parse().unwrap();
    let limits = WasmLimits::default();
    let rate = WasmRateLimits {
        handshakes_per_sec: 1,
        handshakes_burst: 1,
        stream_opens_per_sec: 1,
        stream_opens_burst: 1,
        datagrams_ingress_per_sec: 1,
        datagrams_ingress_burst: 1,
    };
    let mut server =
        WtEndpoint::new_with_limits_and_rate_limits(true, saddr, caddr, limits.clone(), rate)
            .unwrap();
    let mut client = WtEndpoint::new_with_limits(false, caddr, saddr, limits).unwrap();
    client.connect("localhost");
    // Exhaust handshake burst for the client source address.
    let now = Instant::now();
    let _ = server
        .rate_limiter
        .check(now, caddr, RateLimitDimension::Handshake);
    for _ in 0..40 {
        relay_client_to_server(&mut client, &mut server);
        relay_server_to_client(&mut server, &mut client);
        while server.poll_event().is_some() {}
        while client.poll_event().is_some() {}
    }
    // Either refused (rate limited) or never established — must not hang.
    let err = server.take_last_error();
    assert!(
        err.as_deref()
            .is_none_or(|e| e.contains("E_RATE_LIMITED") || e.contains("E_")),
        "unexpected error: {err:?}"
    );
}

fn oversized_headers_frame() -> Vec<u8> {
    let mut buf = Vec::new();
    crate::varint::encode(h3::frame::HEADERS, &mut buf);
    crate::varint::encode(MAX_H3_FRAME_SIZE + 1, &mut buf);
    buf
}

#[test]
fn parse_server_connect_rejects_oversized_and_drains_non_headers() {
    let (mut server, h, stream_id) = server_with_request(oversized_headers_frame());
    server.parse_server_connect(h, stream_id);
    assert!(
        server.events.iter().any(|e| matches!(
            e,
            WtEvent::ConnectionClosed {
                code: H3_EXCESSIVE_LOAD,
                ..
            }
        )),
        "oversized HEADERS must close with H3_EXCESSIVE_LOAD"
    );

    let (mut server2, h2, sid2) = server_with_request({
        let mut buf = Vec::new();
        crate::varint::encode(0x00, &mut buf); // DATA frame
        crate::varint::encode(3, &mut buf);
        buf.extend_from_slice(&[1, 2, 3]);
        // Then a CONNECT so the loop continues after draining DATA.
        buf.extend_from_slice(&h3::encode_connect_request("localhost", "/"));
        buf
    });
    // Force kind to HEADERS so parse_server_connect runs; DATA is just bytes
    // in the buffer decoded as a non-headers frame first.
    server2
        .sessions
        .get_mut(&h2)
        .unwrap()
        .in_streams
        .get_mut(&sid2)
        .unwrap()
        .kind = Some(h3::frame::HEADERS);
    // Rebuild buffer: DATA then CONNECT
    let mut buf = Vec::new();
    crate::varint::encode(0x00, &mut buf);
    crate::varint::encode(3, &mut buf);
    buf.extend_from_slice(&[1, 2, 3]);
    buf.extend_from_slice(&h3::encode_connect_request("localhost", "/"));
    server2
        .sessions
        .get_mut(&h2)
        .unwrap()
        .in_streams
        .get_mut(&sid2)
        .unwrap()
        .buf = buf;
    server2.parse_server_connect(h2, sid2);
    assert!(
        server2.sessions.get(&h2).unwrap().established,
        "DATA frame must be drained then CONNECT establishes"
    );
}

#[test]
fn parse_server_connect_invalid_qpack_closes_and_already_latched_is_noop() {
    let mut bad = Vec::new();
    crate::varint::encode(h3::frame::HEADERS, &mut bad);
    // Claim a small payload of invalid QPACK bytes.
    crate::varint::encode(2, &mut bad);
    bad.extend_from_slice(&[0xff, 0xff]);
    let (mut server, h, stream_id) = server_with_request(bad);
    server.parse_server_connect(h, stream_id);
    assert!(server.events.iter().any(|e| matches!(
        e,
        WtEvent::ConnectionClosed {
            code: QPACK_DECOMPRESSION_FAILED,
            ..
        }
    )));

    let (mut server2, h2, sid2) = server_with_request(h3::encode_connect_request("localhost", "/"));
    server2.parse_server_connect(h2, sid2);
    // Second identical CONNECT on the same stream id should be a no-op.
    server2
        .sessions
        .get_mut(&h2)
        .unwrap()
        .in_streams
        .get_mut(&sid2)
        .unwrap()
        .buf = h3::encode_connect_request("localhost", "/");
    let before = server2.events.len();
    server2.parse_server_connect(h2, sid2);
    assert_eq!(server2.events.len(), before);
}

#[test]
fn parse_client_connect_oversized_and_status_edges() {
    use quinn_proto::{Dir, Side};
    let caddr: SocketAddr = CADDR.parse().unwrap();
    let saddr: SocketAddr = SADDR.parse().unwrap();
    let mut client = WtEndpoint::new(false, caddr, saddr).unwrap();
    let h = ConnectionHandle(0);
    client.handle_to_id.insert(h, 1);
    client.id_to_handle.insert(1, h);
    let sid = StreamId::new(Side::Client, Dir::Bi, 0);
    client.sessions.insert(
        h,
        Session {
            connect_stream: Some(sid),
            connect_self_opened: true,
            connect_rx: oversized_headers_frame(),
            ..Session::default()
        },
    );
    client.parse_client_connect(h);
    assert!(client.events.iter().any(|e| matches!(
        e,
        WtEvent::ConnectionClosed {
            code: H3_EXCESSIVE_LOAD,
            ..
        }
    )));

    // Interim then final non-2xx on a fresh client session.
    let mut client2 = WtEndpoint::new(false, caddr, saddr).unwrap();
    client2.handle_to_id.insert(h, 2);
    client2.id_to_handle.insert(2, h);
    let mut rx = h3::encode_status_response("103");
    rx.extend_from_slice(&h3::encode_status_response("404"));
    client2.sessions.insert(
        h,
        Session {
            connect_stream: Some(sid),
            connect_self_opened: true,
            connect_rx: rx,
            ..Session::default()
        },
    );
    client2.parse_client_connect(h);
    assert!(client2.sessions.get(&h).unwrap().connect_closed);

    // Non-headers frame is drained and ignored.
    let mut client3 = WtEndpoint::new(false, caddr, saddr).unwrap();
    client3.handle_to_id.insert(h, 3);
    client3.id_to_handle.insert(3, h);
    let mut data_then_ok = Vec::new();
    crate::varint::encode(0x00, &mut data_then_ok);
    crate::varint::encode(1, &mut data_then_ok);
    data_then_ok.push(9);
    data_then_ok.extend_from_slice(&h3::encode_connect_response_ok());
    client3.sessions.insert(
        h,
        Session {
            connect_stream: Some(sid),
            connect_self_opened: true,
            connect_rx: data_then_ok,
            ..Session::default()
        },
    );
    client3.parse_client_connect(h);
    assert!(client3.sessions.get(&h).unwrap().established);
}

#[test]
fn parse_control_and_qpack_encoder_error_paths() {
    let caddr: SocketAddr = CADDR.parse().unwrap();
    let saddr: SocketAddr = SADDR.parse().unwrap();
    let mut server = WtEndpoint::new(true, saddr, caddr).unwrap();
    let h = ConnectionHandle(0);
    server.handle_to_id.insert(h, 1);
    server.id_to_handle.insert(1, h);

    // Valid SETTINGS control frame via preamble body (after stream type).
    let preamble = h3::encode_control_preamble(2);
    let mut sess = Session::default();
    // control_rx stores frames WITHOUT the uni stream-type prefix.
    let (_stype, n) = crate::varint::decode(&preamble).unwrap();
    sess.control_rx = preamble[n..].to_vec();
    server.sessions.insert(h, sess);
    server.parse_control(h);
    assert!(server.sessions.get(&h).unwrap().peer_settings.is_some());

    // Oversized control frame.
    let mut huge = Vec::new();
    crate::varint::encode(h3::frame::SETTINGS, &mut huge);
    crate::varint::encode(MAX_H3_FRAME_SIZE + 1, &mut huge);
    server.sessions.get_mut(&h).unwrap().control_rx = huge;
    server.parse_control(h);
    assert!(server.events.iter().any(|e| matches!(
        e,
        WtEvent::ConnectionClosed {
            code: H3_EXCESSIVE_LOAD,
            ..
        }
    )));

    // QPACK encoder stream too large.
    let mut server2 = WtEndpoint::new(true, saddr, caddr).unwrap();
    server2.handle_to_id.insert(h, 2);
    server2.id_to_handle.insert(2, h);
    server2.sessions.insert(
        h,
        Session {
            qpack_encoder_rx: vec![0; MAX_H3_FRAME_SIZE as usize + 1],
            ..Session::default()
        },
    );
    server2.parse_qpack_encoder(h);
    assert!(server2.events.iter().any(|e| matches!(
        e,
        WtEvent::ConnectionClosed {
            code: QPACK_ENCODER_STREAM_ERROR,
            ..
        }
    )));

    // Invalid QPACK encoder bytes (Duplicate on an empty dynamic table).
    let mut server3 = WtEndpoint::new(true, saddr, caddr).unwrap();
    server3.handle_to_id.insert(h, 3);
    server3.id_to_handle.insert(3, h);
    server3.sessions.insert(
        h,
        Session {
            qpack_encoder_rx: vec![0x01],
            ..Session::default()
        },
    );
    server3.parse_qpack_encoder(h);
    assert!(server3.events.iter().any(|e| matches!(
        e,
        WtEvent::ConnectionClosed {
            code: QPACK_ENCODER_STREAM_ERROR,
            ..
        }
    )));
}

#[test]
fn process_in_stream_rejects_when_handle_space_exhausted() {
    use quinn_proto::{Dir, Side};
    let caddr: SocketAddr = CADDR.parse().unwrap();
    let saddr: SocketAddr = SADDR.parse().unwrap();
    let h = ConnectionHandle(0);
    let connect = StreamId::new(Side::Client, Dir::Bi, 0);

    let mut server2 = WtEndpoint::new(true, saddr, caddr).unwrap();
    server2.handle_to_id.insert(h, 2);
    server2.id_to_handle.insert(2, h);
    server2.next_stream = u32::MAX;
    let _ = server2
        .rate_limiter
        .attach_connection(2, caddr, Instant::now());
    let wt2 = StreamId::new(Side::Client, Dir::Uni, 1);
    let mut sess2 = Session {
        established: true,
        connect_stream: Some(connect),
        ..Session::default()
    };
    sess2.in_streams.insert(
        wt2,
        InStream {
            kind: None,
            is_bidi: false,
            sid_read: false,
            wt_session_id: None,
            handle: None,
            connect_admitted: false,
            buf: Vec::new(),
        },
    );
    server2.sessions.insert(h, sess2);
    let mut bytes2 = Vec::new();
    crate::varint::encode(h3::stream_type::WT_UNI, &mut bytes2);
    crate::varint::encode(u64::from(connect), &mut bytes2);
    bytes2.extend_from_slice(b"y");
    server2.process_in_stream(h, wt2, &bytes2, false, Instant::now());
    assert_eq!(
        server2.take_last_error().as_deref(),
        Some("E_LIMIT_EXCEEDED: stream handle space exhausted")
    );
}

#[test]
fn drain_datagrams_skips_unknown_session_and_respects_capacity() {
    use quinn_proto::{Dir, Side};
    let caddr: SocketAddr = CADDR.parse().unwrap();
    let saddr: SocketAddr = SADDR.parse().unwrap();
    let mut endpoint = WtEndpoint::new(true, saddr, caddr).unwrap();
    let h = ConnectionHandle(0);
    // No handle mapping → early return.
    endpoint.drain_datagrams(h, Instant::now());

    endpoint.handle_to_id.insert(h, 1);
    endpoint.id_to_handle.insert(1, h);
    let connect = StreamId::new(Side::Client, Dir::Bi, 0);
    endpoint.sessions.insert(
        h,
        Session {
            established: true,
            connect_stream: Some(connect),
            ..Session::default()
        },
    );
    // No live quinn conn → returns after lookup.
    endpoint.drain_datagrams(h, Instant::now());

    // Fill event queue so capacity gate trips.
    endpoint.events =
        std::iter::repeat_n(WtEvent::Connected { conn: 1 }, MAX_PENDING_EVENTS).collect();
    endpoint.event_reservations = std::iter::repeat_with(|| None)
        .take(MAX_PENDING_EVENTS)
        .collect();
    endpoint.drain_datagrams(h, Instant::now());
    assert_eq!(endpoint.capacity_waiters.len(), 1);
}

#[test]
fn read_stream_none_conn_and_retry_blocked_connects() {
    use quinn_proto::{Dir, Side};
    use std::collections::HashMap;
    let mut out = Vec::new();
    assert_eq!(
        read_stream(
            None,
            StreamId::new(quinn_proto::Side::Client, Dir::Bi, 0),
            &mut out,
            8
        ),
        ReadOutcome::Open
    );

    let caddr: SocketAddr = CADDR.parse().unwrap();
    let saddr: SocketAddr = SADDR.parse().unwrap();
    let mut server = WtEndpoint::new(true, saddr, caddr).unwrap();
    let h = ConnectionHandle(0);
    server.handle_to_id.insert(h, 1);
    server.id_to_handle.insert(1, h);
    let sid = StreamId::new(Side::Client, Dir::Bi, 0);
    server.sessions.insert(
        h,
        Session {
            in_streams: {
                let mut m = HashMap::new();
                m.insert(
                    sid,
                    InStream {
                        kind: Some(h3::frame::HEADERS),
                        is_bidi: true,
                        sid_read: false,
                        wt_session_id: None,
                        handle: None,
                        connect_admitted: false,
                        buf: h3::encode_connect_request("localhost", "/"),
                    },
                );
                m
            },
            ..Session::default()
        },
    );
    server.retry_blocked_connects(h);
    assert!(server.sessions.get(&h).unwrap().established);
}

#[test]
fn close_conn_protocol_error_and_release_budget_are_safe() {
    let caddr: SocketAddr = CADDR.parse().unwrap();
    let saddr: SocketAddr = SADDR.parse().unwrap();
    let mut endpoint = WtEndpoint::new(true, saddr, caddr).unwrap();
    let h = ConnectionHandle(0);
    endpoint.close_conn_protocol_error(h, 1, b"x"); // unknown handle: no-op-ish
    endpoint.handle_to_id.insert(h, 9);
    endpoint.id_to_handle.insert(9, h);
    let _hs = endpoint.governor.reserve_handshake().unwrap();
    // Manually stash a reservation so release_connection_budget drops it.
    endpoint
        .handshake_reservations
        .insert(h, endpoint.governor.reserve_handshake().unwrap());
    endpoint.close_conn_protocol_error(h, H3_INTERNAL_ERROR, b"boom");
    assert!(endpoint.events.iter().any(|e| matches!(
        e,
        WtEvent::ConnectionClosed {
            conn: 9,
            code: H3_INTERNAL_ERROR
        }
    )));
    assert!(endpoint.handshake_reservations.get(&h).is_none());
}

#[test]
fn connect_status_and_wt_header_helpers_cover_edges() {
    assert_eq!(
        classify_connect_status(Some(100)),
        ConnectStatusKind::Interim
    );
    assert_eq!(
        classify_connect_status(Some(199)),
        ConnectStatusKind::Interim
    );
    assert_eq!(
        classify_connect_status(Some(200)),
        ConnectStatusKind::Success
    );
    assert_eq!(
        classify_connect_status(Some(299)),
        ConnectStatusKind::Success
    );
    assert_eq!(
        classify_connect_status(Some(300)),
        ConnectStatusKind::Failure
    );
    assert_eq!(classify_connect_status(None), ConnectStatusKind::Failure);
    assert_eq!(
        classify_connect_status(Some(404)),
        ConnectStatusKind::Failure
    );
    assert_eq!(
        classify_connect_status(Some(99)),
        ConnectStatusKind::Failure
    );

    assert!(headers_are_webtransport_connect(&[
        (":method".into(), "CONNECT".into()),
        (":protocol".into(), "webtransport".into()),
    ]));
    assert!(!headers_are_webtransport_connect(&[
        (":method".into(), "CONNECT".into()),
        (":protocol".into(), "http".into()),
    ]));
    assert!(!headers_are_webtransport_connect(&[
        (":method".into(), "GET".into()),
        (":protocol".into(), "webtransport".into()),
    ]));
    assert!(!headers_are_webtransport_connect(&[]));
}

#[test]
fn connect_fails_closed_on_session_limit_and_id_space() {
    let caddr: SocketAddr = CADDR.parse().unwrap();
    let saddr: SocketAddr = SADDR.parse().unwrap();
    let mut client = WtEndpoint::new_with_limits(
        false,
        caddr,
        saddr,
        WasmLimits {
            max_handshakes_in_flight: 2,
            max_sessions: 1,
            ..WasmLimits::default()
        },
    )
    .unwrap();
    assert!(client.connect("localhost") >= 0);
    assert_eq!(client.connect("localhost"), -1);
    assert!(client
        .take_last_error()
        .unwrap_or_default()
        .contains("maxSessions"));

    let mut client2 = WtEndpoint::new(false, caddr, saddr).unwrap();
    client2.next_id = u32::MAX;
    assert_eq!(client2.connect("localhost"), -1);
    assert!(client2
        .take_last_error()
        .unwrap_or_default()
        .contains("connection id space exhausted"));
}

#[test]
fn open_stream_and_write_fail_when_quic_conn_missing() {
    use quinn_proto::{Dir, Side};
    let caddr: SocketAddr = CADDR.parse().unwrap();
    let saddr: SocketAddr = SADDR.parse().unwrap();
    let mut endpoint = WtEndpoint::new(true, saddr, caddr).unwrap();
    let h = ConnectionHandle(0);
    let sid = StreamId::new(Side::Client, Dir::Bi, 0);
    endpoint.handle_to_id.insert(h, 1);
    endpoint.id_to_handle.insert(1, h);
    endpoint.sessions.insert(
        h,
        Session {
            established: true,
            connect_stream: Some(sid),
            ..Session::default()
        },
    );
    assert_eq!(endpoint.open_stream(1, 0, true), -1);
    assert_eq!(
        endpoint.take_last_error().as_deref(),
        Some("E_SESSION_CLOSED: connection missing")
    );

    endpoint.index_insert(7, h, sid, 0);
    assert_eq!(endpoint.stream_write(7, b"x"), -1);
    endpoint.stream_finish(7);
    endpoint.stream_reset(7, 1);
    endpoint.stream_stop(7, 1);
}

#[test]
fn poll_event_encoded_surfaces_closed_when_conn_already_gone() {
    let caddr: SocketAddr = CADDR.parse().unwrap();
    let saddr: SocketAddr = SADDR.parse().unwrap();
    let mut endpoint = WtEndpoint::new_with_limits(
        true,
        saddr,
        caddr,
        WasmLimits {
            max_queued_bytes_global: 4,
            max_queued_bytes_per_session: 4,
            max_queued_bytes_per_stream: 4,
            ..WasmLimits::default()
        },
    )
    .unwrap();
    endpoint.governor.set_host_token_ceiling_for_test(1);
    endpoint.push_event(WtEvent::Datagram {
        conn: 42,
        session_id: 0,
        data: vec![1],
    });
    endpoint.push_event(WtEvent::Datagram {
        conn: 42,
        session_id: 0,
        data: vec![2],
    });
    assert!(endpoint.poll_event_encoded().is_some());
    // Second transfer fails; connection 42 was never registered, so the
    // fail-closed path must still emit Closed without close_conn.
    let encoded = endpoint.poll_event_encoded().expect("closed event");
    assert_eq!(encoded[0], crate::event::tag::CLOSED);
    assert_eq!(
        endpoint.take_last_error().as_deref(),
        Some("E_LIMIT_EXCEEDED: host reservation token space exhausted")
    );
}

#[test]
fn new_generated_cert_0rtt_and_rate_limit_variants_construct() {
    let caddr: SocketAddr = CADDR.parse().unwrap();
    let now_unix = time::OffsetDateTime::now_utc().unix_timestamp() - 60;
    let (server, hash) = WtEndpoint::new_with_generated_cert_with_limits_rate_limits_and_0rtt(
        caddr,
        "localhost",
        7,
        now_unix,
        WasmLimits::default(),
        WasmRateLimits::default(),
        true,
    )
    .expect("0rtt generated cert server");
    assert!(server.enable_0rtt());
    assert!(!hash.is_empty());

    let (server2, _) = WtEndpoint::new_with_generated_cert_with_limits_and_rate_limits(
        caddr,
        "localhost",
        7,
        now_unix,
        WasmLimits::default(),
        WasmRateLimits::default(),
    )
    .expect("rate-limit generated cert server");
    assert!(!server2.enable_0rtt());
}

#[test]
fn connection_lost_signal_covers_transport_error_variants() {
    assert_eq!(
        connection_lost_signal(&quinn_proto::ConnectionError::TransportError(
            quinn_proto::TransportError {
                code: quinn_proto::TransportErrorCode::PROTOCOL_VIOLATION,
                frame: None,
                reason: "".into(),
            }
        )),
        Some((None, 0))
    );
    assert_eq!(
        connection_lost_signal(&quinn_proto::ConnectionError::CidsExhausted),
        Some((None, 0))
    );

    // A CRYPTO_ERROR (0x100 + TLS alert) must name itself: alert 42 is
    // bad_certificate, what a rejected caPem / pin set produces.
    assert_eq!(
        connection_lost_signal(&quinn_proto::ConnectionError::TransportError(
            quinn_proto::TransportError {
                code: quinn_proto::TransportErrorCode::crypto(42),
                frame: None,
                reason: "".into(),
            }
        )),
        Some((
            Some("E_TLS: handshake failed with TLS alert 42".to_string()),
            0
        ))
    );
}

#[test]
fn admit_new_connection_covers_rate_handshake_and_session_limits() {
    let caddr: SocketAddr = CADDR.parse().unwrap();
    let saddr: SocketAddr = SADDR.parse().unwrap();
    let now = Instant::now();
    let mut server = WtEndpoint::new_with_limits_and_rate_limits(
        true,
        saddr,
        caddr,
        WasmLimits {
            max_handshakes_in_flight: 1,
            max_sessions: 1,
            ..WasmLimits::default()
        },
        WasmRateLimits {
            handshakes_per_sec: 1,
            handshakes_burst: 1,
            ..WasmRateLimits::default()
        },
    )
    .unwrap();

    let ok = server
        .admit_new_connection(now, Some(caddr))
        .expect("first admit");
    drop(ok);

    assert!(match server.admit_new_connection(now, Some(caddr)) {
        Err(err) => err.contains("E_RATE_LIMITED"),
        Ok(_) => false,
    });

    let mut server2 = WtEndpoint::new_with_limits(
        true,
        saddr,
        caddr,
        WasmLimits {
            max_handshakes_in_flight: 1,
            max_sessions: 1,
            ..WasmLimits::default()
        },
    )
    .unwrap();
    let hold = server2
        .admit_new_connection(now, None)
        .expect("client-style admit");
    assert!(match server2.admit_new_connection(now, None) {
        Err(err) => err.contains("maxHandshakesInFlight"),
        Ok(_) => false,
    });
    drop(hold);

    let mut server3 = WtEndpoint::new_with_limits(
        true,
        saddr,
        caddr,
        WasmLimits {
            max_handshakes_in_flight: 2,
            max_sessions: 1,
            ..WasmLimits::default()
        },
    )
    .unwrap();
    let hold_session = server3.governor.reserve_session(9).unwrap();
    assert!(match server3.admit_new_connection(now, None) {
        Err(err) => err.contains("maxSessions"),
        Ok(_) => false,
    });
    drop(hold_session);
}

#[test]
fn on_connection_lost_emits_closed_for_timeout_and_skips_local() {
    use quinn_proto::{Dir, Side};
    let caddr: SocketAddr = CADDR.parse().unwrap();
    let saddr: SocketAddr = SADDR.parse().unwrap();
    let mut endpoint = WtEndpoint::new(true, saddr, caddr).unwrap();
    let h = ConnectionHandle(0);
    endpoint.handle_to_id.insert(h, 3);
    endpoint.id_to_handle.insert(3, h);
    let sid = StreamId::new(Side::Client, Dir::Bi, 0);
    endpoint.index_insert(8, h, sid, 0);
    endpoint.paused.insert(8);
    endpoint.sessions.insert(h, Session::default());

    endpoint.on_connection_lost(h, quinn_proto::ConnectionError::TimedOut, Instant::now());
    assert_eq!(
        endpoint.take_last_error().as_deref(),
        Some("E_SESSION_IDLE_TIMEOUT: connection idle timeout")
    );
    assert!(endpoint
        .events
        .iter()
        .any(|e| matches!(e, WtEvent::ConnectionClosed { conn: 3, code: 0 })));
    assert!(endpoint.handle_to_id.is_empty());

    // LocallyClosed must not emit a second Closed.
    let mut endpoint2 = WtEndpoint::new(true, saddr, caddr).unwrap();
    endpoint2.handle_to_id.insert(h, 4);
    endpoint2.id_to_handle.insert(4, h);
    endpoint2.sessions.insert(h, Session::default());
    endpoint2.on_connection_lost(
        h,
        quinn_proto::ConnectionError::LocallyClosed,
        Instant::now(),
    );
    assert!(endpoint2.events.is_empty());
    assert!(endpoint2.handle_to_id.is_empty());

    // Unknown handle is a no-op.
    let mut endpoint3 = WtEndpoint::new(true, saddr, caddr).unwrap();
    endpoint3.on_connection_lost(
        ConnectionHandle(9),
        quinn_proto::ConnectionError::Reset,
        Instant::now(),
    );
    assert!(endpoint3.events.is_empty());

    // ApplicationClosed carries the peer code.
    let mut endpoint4 = WtEndpoint::new(true, saddr, caddr).unwrap();
    endpoint4.handle_to_id.insert(h, 5);
    endpoint4.id_to_handle.insert(5, h);
    endpoint4.sessions.insert(h, Session::default());
    endpoint4.on_connection_lost(
        h,
        quinn_proto::ConnectionError::ApplicationClosed(quinn_proto::ApplicationClose {
            error_code: VarInt::from_u32(0x11),
            reason: Bytes::new(),
        }),
        Instant::now(),
    );
    assert!(endpoint4.events.iter().any(|e| matches!(
        e,
        WtEvent::ConnectionClosed {
            conn: 5,
            code: 0x11
        }
    )));
}

#[test]
fn self_bidi_read_outcome_finished_reset_and_open() {
    use quinn_proto::{Dir, Side};
    let caddr: SocketAddr = CADDR.parse().unwrap();
    let saddr: SocketAddr = SADDR.parse().unwrap();
    let mut endpoint = WtEndpoint::new(true, saddr, caddr).unwrap();
    let h = ConnectionHandle(0);
    let sid = StreamId::new(Side::Client, Dir::Bi, 0);
    endpoint.handle_to_id.insert(h, 1);
    endpoint.id_to_handle.insert(1, h);
    let mut sess = Session::default();
    sess.self_bidi.insert(sid, 9);
    endpoint.sessions.insert(h, sess);
    endpoint.index_insert(9, h, sid, 0);
    endpoint.paused.insert(9);

    endpoint.on_self_bidi_read_outcome(h, sid, 9, 1, ReadOutcome::Open);
    assert!(endpoint.sessions[&h].self_bidi.contains_key(&sid));

    endpoint.on_self_bidi_read_outcome(h, sid, 9, 1, ReadOutcome::Reset(u64::from(u32::MAX) + 5));
    assert!(endpoint.events.iter().any(|e| matches!(
        e,
        WtEvent::StreamReset {
            conn: 1,
            stream: 9,
            code: u32::MAX
        }
    )));
    assert!(!endpoint.sessions[&h].self_bidi.contains_key(&sid));
    assert!(!endpoint.paused.contains(&9));

    // Finished path on a fresh handle.
    let sid2 = StreamId::new(Side::Client, Dir::Bi, 1);
    endpoint
        .sessions
        .get_mut(&h)
        .unwrap()
        .self_bidi
        .insert(sid2, 10);
    endpoint.index_insert(10, h, sid2, 0);
    endpoint.on_self_bidi_read_outcome(h, sid2, 10, 1, ReadOutcome::Finished);
    assert!(!endpoint.sessions[&h].self_bidi.contains_key(&sid2));
}

#[test]
fn process_in_stream_rate_limits_server_stream_opens() {
    use quinn_proto::{Dir, Side};
    let caddr: SocketAddr = CADDR.parse().unwrap();
    let saddr: SocketAddr = SADDR.parse().unwrap();
    let now = Instant::now();
    let mut server = WtEndpoint::new_with_limits_and_rate_limits(
        true,
        saddr,
        caddr,
        WasmLimits::default(),
        WasmRateLimits {
            stream_opens_per_sec: 1,
            stream_opens_burst: 1,
            ..WasmRateLimits::default()
        },
    )
    .unwrap();
    let h = ConnectionHandle(0);
    let connect = StreamId::new(Side::Client, Dir::Bi, 0);
    let wt = StreamId::new(Side::Client, Dir::Uni, 0);
    server.handle_to_id.insert(h, 1);
    server.id_to_handle.insert(1, h);
    server
        .rate_limiter
        .attach_connection(1, caddr, now)
        .unwrap();
    // Exhaust stream-open burst.
    server
        .rate_limiter
        .check_connection(now, 1, RateLimitDimension::StreamOpen)
        .unwrap();
    let mut sess = Session {
        established: true,
        connect_stream: Some(connect),
        ..Session::default()
    };
    sess.in_streams.insert(
        wt,
        InStream {
            kind: None,
            is_bidi: false,
            sid_read: false,
            wt_session_id: None,
            handle: None,
            connect_admitted: false,
            buf: Vec::new(),
        },
    );
    server.sessions.insert(h, sess);
    let mut bytes = Vec::new();
    crate::varint::encode(h3::stream_type::WT_UNI, &mut bytes);
    crate::varint::encode(u64::from(connect), &mut bytes);
    bytes.extend_from_slice(b"z");
    server.process_in_stream(h, wt, &bytes, false, now);
    assert!(server
        .take_last_error()
        .unwrap_or_default()
        .contains("E_RATE_LIMITED"));
}

#[test]
fn parse_connect_qpack_blocked_with_zero_max_closes() {
    use quinn_proto::{Dir, Side};
    let mut enc = h3::QpackEncoder::new(4096);
    enc.set_capacity_instruction(4096).unwrap();
    enc.insert_literal_instruction("x", "y").unwrap();
    let section = enc.encode_indexed_newest_section().unwrap();
    let mut frame = Vec::new();
    crate::varint::encode(h3::frame::HEADERS, &mut frame);
    crate::varint::encode(section.len() as u64, &mut frame);
    frame.extend_from_slice(&section);

    let (mut server, h, sid) = server_with_request(frame.clone());
    server.sessions.get_mut(&h).unwrap().qpack_decoder =
        h3::QpackDecoder::new(&h3::QpackLocalSettings::disabled());
    server.parse_server_connect(h, sid);
    assert!(server.events.iter().any(|e| matches!(
        e,
        WtEvent::ConnectionClosed {
            code: QPACK_DECOMPRESSION_FAILED,
            ..
        }
    )));

    let caddr: SocketAddr = CADDR.parse().unwrap();
    let saddr: SocketAddr = SADDR.parse().unwrap();
    let mut client = WtEndpoint::new(false, caddr, saddr).unwrap();
    let h2 = ConnectionHandle(0);
    client.handle_to_id.insert(h2, 2);
    client.id_to_handle.insert(2, h2);
    client.sessions.insert(
        h2,
        Session {
            connect_stream: Some(StreamId::new(Side::Client, Dir::Bi, 0)),
            connect_self_opened: true,
            connect_rx: frame,
            qpack_decoder: h3::QpackDecoder::new(&h3::QpackLocalSettings::disabled()),
            ..Session::default()
        },
    );
    client.parse_client_connect(h2);
    assert!(client.events.iter().any(|e| matches!(
        e,
        WtEvent::ConnectionClosed {
            code: QPACK_DECOMPRESSION_FAILED,
            ..
        }
    )));
}

#[test]
fn in_stream_read_limit_covers_classification_branches() {
    use quinn_proto::{Dir, Side};
    let caddr: SocketAddr = CADDR.parse().unwrap();
    let saddr: SocketAddr = SADDR.parse().unwrap();
    let mut endpoint = WtEndpoint::new(true, saddr, caddr).unwrap();
    let h = ConnectionHandle(0);
    assert_eq!(
        endpoint.in_stream_read_limit(h, StreamId::new(Side::Client, Dir::Uni, 0)),
        0
    );
    endpoint.handle_to_id.insert(h, 1);
    endpoint.id_to_handle.insert(1, h);
    let mut sess = Session::default();
    let sid = StreamId::new(Side::Client, Dir::Uni, 0);
    sess.in_streams.insert(
        sid,
        InStream {
            kind: None,
            is_bidi: false,
            sid_read: false,
            wt_session_id: None,
            handle: None,
            connect_admitted: false,
            buf: Vec::new(),
        },
    );
    endpoint.sessions.insert(h, sess);
    assert_eq!(endpoint.in_stream_read_limit(h, sid), 1);

    endpoint
        .sessions
        .get_mut(&h)
        .unwrap()
        .in_streams
        .get_mut(&sid)
        .unwrap()
        .kind = Some(h3::stream_type::CONTROL);
    assert_eq!(endpoint.in_stream_read_limit(h, sid), PROTOCOL_READ_CHUNK);

    {
        let st = endpoint
            .sessions
            .get_mut(&h)
            .unwrap()
            .in_streams
            .get_mut(&sid)
            .unwrap();
        st.kind = Some(h3::stream_type::WT_UNI);
        st.sid_read = false;
    }
    assert_eq!(endpoint.in_stream_read_limit(h, sid), 1);
    {
        let st = endpoint
            .sessions
            .get_mut(&h)
            .unwrap()
            .in_streams
            .get_mut(&sid)
            .unwrap();
        st.sid_read = true;
    }
    assert_eq!(endpoint.in_stream_read_limit(h, sid), 0); // no handle yet
    endpoint
        .sessions
        .get_mut(&h)
        .unwrap()
        .in_streams
        .get_mut(&sid)
        .unwrap()
        .handle = Some(3);
    assert!(endpoint.in_stream_read_limit(h, sid) > 0);
}

#[test]
fn connect_stream_end_extra_session_and_datagram_demux_helpers() {
    use quinn_proto::{Dir, Side};
    let caddr: SocketAddr = CADDR.parse().unwrap();
    let saddr: SocketAddr = SADDR.parse().unwrap();
    let mut endpoint = WtEndpoint::new(true, saddr, caddr).unwrap();
    let h = ConnectionHandle(0);
    let primary = StreamId::new(Side::Client, Dir::Bi, 0);
    let extra = StreamId::new(Side::Client, Dir::Bi, 1);
    endpoint.handle_to_id.insert(h, 1);
    endpoint.id_to_handle.insert(1, h);
    let mut sess = Session {
        established: true,
        connect_stream: Some(primary),
        ..Session::default()
    };
    sess.extra_sessions.insert(extra);
    endpoint.sessions.insert(h, sess);

    endpoint.on_connect_stream_ended(h, extra, false);
    assert!(!endpoint.sessions[&h].extra_sessions.contains(&extra));
    assert!(endpoint.sessions[&h].established);

    endpoint.on_connect_stream_ended(h, primary, true);
    assert!(endpoint.sessions[&h].connect_closed);

    let session = Session {
        established: true,
        connect_stream: Some(primary),
        ..Session::default()
    };
    let good = h3::wrap_datagram(u64::from(primary), b"hi");
    assert_eq!(
        WtEndpoint::datagram_payload_for_session(&session, &good).map(|(_, p)| p),
        Some(b"hi".to_vec())
    );
    assert!(WtEndpoint::datagram_payload_for_session(&session, b"bad").is_none());
    let other = h3::wrap_datagram(999_999, b"x");
    assert!(WtEndpoint::datagram_payload_for_session(&session, &other).is_none());
}

#[test]
fn qpack_blocked_with_room_to_wait_does_not_close() {
    let mut enc = h3::QpackEncoder::new(4096);
    enc.set_capacity_instruction(4096).unwrap();
    enc.insert_literal_instruction("x", "y").unwrap();
    let section = enc.encode_indexed_newest_section().unwrap();
    let mut frame = Vec::new();
    crate::varint::encode(h3::frame::HEADERS, &mut frame);
    crate::varint::encode(section.len() as u64, &mut frame);
    frame.extend_from_slice(&section);

    let (mut server, h, sid) = server_with_request(frame);
    server.sessions.get_mut(&h).unwrap().qpack_decoder =
        h3::QpackDecoder::new(&h3::QpackLocalSettings {
            max_table_capacity: 4096,
            max_blocked_streams: 16,
        });
    let before = server.events.len();
    server.parse_server_connect(h, sid);
    assert_eq!(server.events.len(), before, "blocked with budget must wait");
    assert!(
        !server.sessions[&h]
            .in_streams
            .get(&sid)
            .unwrap()
            .buf
            .is_empty(),
        "frame remains buffered while blocked"
    );
}

#[test]
fn sooner_deadline_and_active_wt_count_edges() {
    use quinn_proto::{Dir, Side};
    let now = Instant::now();
    let later = now + std::time::Duration::from_millis(10);
    assert_eq!(sooner_deadline(None, later), Some(later));
    assert_eq!(sooner_deadline(Some(now), later), Some(now));
    assert_eq!(sooner_deadline(Some(later), now), Some(now));

    let sid = StreamId::new(Side::Client, Dir::Bi, 0);
    let sess = Session {
        established: true,
        connect_closed: true,
        connect_stream: Some(sid),
        ..Session::default()
    };
    assert_eq!(sess.active_wt_count(), 0);
    let sess2 = Session {
        established: false,
        connect_stream: Some(sid),
        ..Session::default()
    };
    assert_eq!(sess2.active_wt_count(), 0);
}

#[test]
fn endpoint_branch_helpers_cover_remaining_edges() {
    use std::net::{IpAddr, Ipv4Addr, SocketAddr};

    let dest = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 4433);
    let mut out = Vec::new();
    push_transmit_if_ready(&mut out, Vec::new(), Some(dest));
    assert!(out.is_empty());
    push_transmit_if_ready(&mut out, b"pkt".to_vec(), None);
    assert!(out.is_empty());
    push_transmit_if_ready(&mut out, b"pkt".to_vec(), Some(dest));
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].1, dest);

    assert!(should_backpressure_zero_progress_read(0, false, true));
    assert!(!should_backpressure_zero_progress_read(1, false, true));
    assert!(!should_backpressure_zero_progress_read(0, true, true));
    assert!(!should_backpressure_zero_progress_read(0, false, false));

    assert!(should_emit_stream_payload(false, false));
    assert!(should_emit_stream_payload(true, true));
    assert!(!should_emit_stream_payload(true, false));

    assert!(should_emit_self_bidi_chunk(true, false));
    assert!(should_emit_self_bidi_chunk(false, true));
    assert!(!should_emit_self_bidi_chunk(false, false));

    let now = Instant::now();
    let later = now + std::time::Duration::from_millis(50);
    let earlier = now - std::time::Duration::from_millis(5);
    assert!(next_timeout_value(now, Some(later)) > 0.0);
    assert_eq!(next_timeout_value(now, Some(earlier)), 0.0);
    assert_eq!(next_timeout_value(now, None), -1.0);

    assert!(connect_deadline_expired(false, false, Some(earlier), now));
    assert!(!connect_deadline_expired(true, false, Some(earlier), now));
    assert!(!connect_deadline_expired(false, true, Some(earlier), now));
    assert!(!connect_deadline_expired(false, false, Some(later), now));
    assert!(!connect_deadline_expired(false, false, None, now));

    assert!(datagram_payload_exceeds_caps(100, 50, None));
    assert!(datagram_payload_exceeds_caps(40, 100, Some(30)));
    assert!(!datagram_payload_exceeds_caps(40, 100, Some(50)));
    assert!(!datagram_payload_exceeds_caps(40, 100, None));

    assert!(primary_wt_session_live(true, false, true));
    assert!(!primary_wt_session_live(true, true, true));
    assert!(!primary_wt_session_live(false, false, true));
    assert!(!primary_wt_session_live(true, false, false));

    assert!(should_track_connect_deadline(false, false));
    assert!(!should_track_connect_deadline(true, false));
    assert!(!should_track_connect_deadline(false, true));

    assert!(should_stop_read_batch(false, true));
    assert!(should_stop_read_batch(true, false));
    assert!(!should_stop_read_batch(true, true));

    assert!(!should_wait_for_event_slots(0, false));
    assert!(!should_wait_for_event_slots(2, true));
    assert!(should_wait_for_event_slots(2, false));

    assert!(should_reset_send_on_wt_reject(true));
    assert!(!should_reset_send_on_wt_reject(false));

    assert!(qpack_blocking_forbidden(0));
    assert!(!qpack_blocking_forbidden(1));
    assert!(!qpack_blocking_forbidden(16));

    // Exhaustive edges for the multi-way admission guard classifier.
    assert_eq!(endpoint_guard_decision(true, true, false, false), 1);
    assert_eq!(endpoint_guard_decision(false, true, true, true), 1);
    assert_eq!(endpoint_guard_decision(true, false, true, false), 2);
    assert_eq!(endpoint_guard_decision(false, false, true, true), 2);
    assert_eq!(endpoint_guard_decision(true, false, false, true), 3);
    assert_eq!(endpoint_guard_decision(true, false, false, false), 4);
    assert_eq!(endpoint_guard_decision(false, false, false, true), 5);
    assert_eq!(endpoint_guard_decision(false, false, false, false), 6);

    assert!(!chunk_carries_payload(0));
    assert!(chunk_carries_payload(1));
    assert!(chunk_carries_payload(64));
}

#[test]
fn dynamic_qpack_wasm_to_wasm_session_and_peer_ici_krc() {
    let caddr: SocketAddr = CADDR.parse().unwrap();
    let saddr: SocketAddr = SADDR.parse().unwrap();
    let settings = h3::QpackLocalSettings::default();
    let mut server = WtEndpoint::new(true, saddr, caddr).unwrap();
    let mut client = WtEndpoint::new(false, caddr, saddr).unwrap();
    server.set_qpack_settings(settings);
    client.set_qpack_settings(settings);
    let _cid = client.connect("localhost") as u32;

    let mut server_est = false;
    let mut client_est = false;
    for _ in 0..400 {
        let _ = relay_client_to_server(&mut client, &mut server);
        let _ = relay_server_to_client(&mut server, &mut client);
        while let Some(ev) = server.poll_event() {
            if matches!(ev, WtEvent::SessionEstablished { .. }) {
                server_est = true;
            }
        }
        while let Some(ev) = client.poll_event() {
            if matches!(ev, WtEvent::SessionEstablished { .. }) {
                client_est = true;
            }
        }
        if server_est && client_est {
            break;
        }
    }
    assert!(
        server_est && client_est,
        "dynamic QPACK session must establish"
    );

    // Flush decoder-stream ICI / section-acks so KRC can advance.
    for _ in 0..64 {
        let _ = relay_client_to_server(&mut client, &mut server);
        let _ = relay_server_to_client(&mut server, &mut client);
        while server.poll_event().is_some() {}
        while client.poll_event().is_some() {}
    }

    let client_h = *client.id_to_handle.values().next().expect("client handle");
    let server_h = *server.id_to_handle.values().next().expect("server handle");
    let client_enc = &client.sessions[&client_h].qpack_encoder;
    let server_enc = &server.sessions[&server_h].qpack_encoder;
    assert!(
        client_enc.table().insert_count() > 0,
        "client must emit dynamic inserts for CONNECT"
    );
    assert!(
        server_enc.table().insert_count() > 0,
        "server must emit dynamic inserts for 200"
    );
    assert!(
        client_enc.known_received_count() > 0,
        "peer ICI must advance client encoder KRC"
    );
    assert!(
        server_enc.known_received_count() > 0,
        "section-ack / ICI must advance server encoder KRC"
    );
}

#[test]
fn shared_0rtt_ticket_store_second_connect_has_0rtt() {
    let caddr: SocketAddr = CADDR.parse().unwrap();
    let saddr: SocketAddr = SADDR.parse().unwrap();
    let limits = WasmLimits::default();
    let rates = WasmRateLimits::default();
    let mut server = WtEndpoint::new_with_limits_rate_limits_0rtt_and_ticket_share(
        true,
        saddr,
        caddr,
        limits.clone(),
        rates.clone(),
        true,
        true,
    )
    .unwrap();
    let mut client = WtEndpoint::new_with_limits_rate_limits_0rtt_and_ticket_share(
        false, caddr, saddr, limits, rates, true, true,
    )
    .unwrap();
    let cid1 = client.connect("localhost") as u32;
    assert!(
        !client.conn_has_0rtt(cid1),
        "first connect has no ticket yet"
    );

    let mut server_est = false;
    let mut client_est = false;
    for _ in 0..400 {
        let _ = relay_client_to_server(&mut client, &mut server);
        let _ = relay_server_to_client(&mut server, &mut client);
        while let Some(ev) = server.poll_event() {
            if matches!(ev, WtEvent::SessionEstablished { .. }) {
                server_est = true;
            }
        }
        while let Some(ev) = client.poll_event() {
            if matches!(ev, WtEvent::SessionEstablished { .. }) {
                client_est = true;
            }
        }
        if server_est && client_est {
            break;
        }
    }
    assert!(server_est && client_est);

    // Flush NewSessionTicket into the shared store via poll_transmits NST rounds.
    for _ in 0..80 {
        let _ = relay_client_to_server(&mut client, &mut server);
        let _ = relay_server_to_client(&mut server, &mut client);
        while server.poll_event().is_some() {}
        while client.poll_event().is_some() {}
    }

    assert!(
        crate::endpoint::shared_0rtt_client_ticket_count("localhost") > 0,
        "NST flush must mint a client ticket into the shared store (got {})",
        crate::endpoint::shared_0rtt_client_ticket_count("localhost")
    );

    client.close_conn(cid1, 0, b"", Instant::now());
    for _ in 0..32 {
        let _ = relay_client_to_server(&mut client, &mut server);
        let _ = relay_server_to_client(&mut server, &mut client);
        while server.poll_event().is_some() {}
        while client.poll_event().is_some() {}
    }
    drop(client);

    // Fresh endpoint + shared ClientConfig must still offer 0-RTT.
    let mut client2 = WtEndpoint::new_with_limits_rate_limits_0rtt_and_ticket_share(
        false,
        caddr,
        saddr,
        WasmLimits::default(),
        WasmRateLimits::default(),
        true,
        true,
    )
    .unwrap();
    let cid2 = client2.connect("localhost");
    assert!(cid2 > 0, "second connect must succeed, got {cid2}");
    let cid2 = cid2 as u32;
    assert!(
        client2.conn_has_0rtt(cid2),
        "shared-store reconnect must offer 0-RTT (tickets={})",
        crate::endpoint::shared_0rtt_client_ticket_count("localhost")
    );
}

#[test]
fn unlatched_connect_storm_resets_without_unbounded_buffers() {
    use quinn_proto::{Dir, Side};

    let caddr: SocketAddr = CADDR.parse().unwrap();
    let saddr: SocketAddr = SADDR.parse().unwrap();
    let mut server = WtEndpoint::new(true, saddr, caddr).unwrap();
    server.set_wt_max_sessions(2);
    let h = ConnectionHandle(0);
    server.handle_to_id.insert(h, 1);
    server.id_to_handle.insert(1, h);
    server.sessions.insert(h, Session::default());
    let _ = server
        .rate_limiter
        .attach_connection(1, caddr, Instant::now());

    // Incomplete HEADERS prefixes — never latch as WT sessions, only buffer.
    let mut incomplete = Vec::new();
    crate::varint::encode(h3::frame::HEADERS, &mut incomplete);
    // Declare a large frame length but only send a prefix (tempt unbounded buffer).
    crate::varint::encode(512 * 1024, &mut incomplete);
    incomplete.extend(std::iter::repeat_n(0x61u8, 1024));

    for i in 0..6u64 {
        let sid = StreamId::new(Side::Client, Dir::Bi, i);
        server.sessions.get_mut(&h).unwrap().in_streams.insert(
            sid,
            InStream {
                kind: None,
                is_bidi: true,
                sid_read: false,
                wt_session_id: None,
                handle: None,
                connect_admitted: false,
                buf: Vec::new(),
            },
        );
        server.process_in_stream(h, sid, &incomplete, false, Instant::now());
    }

    let sess = &server.sessions[&h];
    let admitted = sess
        .in_streams
        .values()
        .filter(|st| st.connect_admitted)
        .count();
    assert!(
        admitted <= 2,
        "unlatched CONNECT admission must stay within wt_max_sessions (got {admitted})"
    );
    let max_buf = sess
        .in_streams
        .values()
        .map(|st| st.buf.len())
        .max()
        .unwrap_or(0);
    assert!(
        max_buf <= MAX_H3_FRAME_SIZE as usize,
        "CONNECT storm must not grow unbounded buffers (max={max_buf})"
    );
    // Over-cap streams are retired (RESET path), so in_streams stays bounded.
    assert!(
        sess.in_streams.len() <= 2,
        "rejected CONNECTs must leave in_streams (got {})",
        sess.in_streams.len()
    );
}

fn client_with_established_peer(max_sessions: u64) -> (WtEndpoint, ConnectionHandle, u32) {
    use quinn_proto::{Dir, Side};
    let caddr: SocketAddr = CADDR.parse().unwrap();
    let saddr: SocketAddr = SADDR.parse().unwrap();
    let mut client = WtEndpoint::new(false, caddr, saddr).unwrap();
    let h = ConnectionHandle(0);
    let conn_id = 7u32;
    client.handle_to_id.insert(h, conn_id);
    client.id_to_handle.insert(conn_id, h);
    let primary = StreamId::new(Side::Client, Dir::Bi, 0);
    let sess = Session {
        established: true,
        connect_stream: Some(primary),
        authority: "localhost".into(),
        peer_settings: Some(h3::PeerSettings {
            max_sessions,
            ..h3::PeerSettings::default()
        }),
        ..Session::default()
    };
    client.sessions.insert(h, sess);
    (client, h, conn_id)
}

#[test]
fn open_wt_session_error_arms_without_quic() {
    let (mut client, _h, _conn_id) = client_with_established_peer(2);
    assert_eq!(client.open_wt_session(999), -1);
    assert!(client
        .take_last_error()
        .unwrap()
        .contains("E_SESSION_CLOSED"));

    let caddr: SocketAddr = CADDR.parse().unwrap();
    let saddr: SocketAddr = SADDR.parse().unwrap();
    let mut server = WtEndpoint::new(true, saddr, caddr).unwrap();
    server.handle_to_id.insert(ConnectionHandle(0), 1);
    server.id_to_handle.insert(1, ConnectionHandle(0));
    server
        .sessions
        .insert(ConnectionHandle(0), Session::default());
    assert_eq!(server.open_wt_session(1), -1);
    assert!(server
        .take_last_error()
        .unwrap()
        .contains("E_UNSUPPORTED_ARGUMENT"));

    let (mut client, h, conn_id) = client_with_established_peer(2);
    client.sessions.get_mut(&h).unwrap().established = false;
    assert_eq!(client.open_wt_session(conn_id), -1);
    assert!(client
        .take_last_error()
        .unwrap()
        .contains("primary session not established"));

    let (mut client, h, conn_id) = client_with_established_peer(2);
    client.sessions.get_mut(&h).unwrap().peer_settings = None;
    assert_eq!(client.open_wt_session(conn_id), -1);
    assert!(client
        .take_last_error()
        .unwrap()
        .contains("E_HANDSHAKE_TIMEOUT"));

    let (mut client, _h, conn_id) = client_with_established_peer(1);
    assert_eq!(client.open_wt_session(conn_id), -1);
    assert!(client
        .take_last_error()
        .unwrap()
        .contains("E_LIMIT_EXCEEDED"));
}

#[test]
fn parse_pending_client_connect_non_200_and_200() {
    use quinn_proto::{Dir, Side};
    let (mut client, h, conn_id) = client_with_established_peer(2);
    let pending_sid = StreamId::new(Side::Client, Dir::Bi, 4);
    client
        .sessions
        .get_mut(&h)
        .unwrap()
        .pending_client_connects
        .insert(
            pending_sid,
            PendingClientConnect {
                rx: h3::encode_status_response("404"),
                deadline: None,
            },
        );
    client.parse_pending_client_connect(h, pending_sid);
    assert!(!client
        .sessions
        .get(&h)
        .unwrap()
        .pending_client_connects
        .contains_key(&pending_sid));
    assert!(client.events.iter().any(|e| matches!(
        e,
        WtEvent::SessionClosed {
            conn,
            session_id,
            ..
        } if *conn == conn_id && *session_id == u64::from(pending_sid)
    )));

    let (mut client, h, conn_id) = client_with_established_peer(2);
    let pending_sid = StreamId::new(Side::Client, Dir::Bi, 8);
    client
        .sessions
        .get_mut(&h)
        .unwrap()
        .pending_client_connects
        .insert(
            pending_sid,
            PendingClientConnect {
                rx: h3::encode_status_response("200"),
                deadline: None,
            },
        );
    client.parse_pending_client_connect(h, pending_sid);
    let s = client.sessions.get(&h).unwrap();
    assert!(s.extra_sessions.contains(&pending_sid));
    assert!(!s.pending_client_connects.contains_key(&pending_sid));
    assert!(client.events.iter().any(|e| matches!(
        e,
        WtEvent::SessionEstablished {
            conn,
            session_id,
            ..
        } if *conn == conn_id && *session_id == u64::from(pending_sid)
    )));
}

#[test]
fn pending_client_connect_deadline_expires_in_handle_timeout() {
    use quinn_proto::{Dir, Side};
    let (mut client, h, conn_id) = client_with_established_peer(2);
    let pending_sid = StreamId::new(Side::Client, Dir::Bi, 4);
    let t0 = Instant::now();
    client
        .sessions
        .get_mut(&h)
        .unwrap()
        .pending_client_connects
        .insert(
            pending_sid,
            PendingClientConnect {
                rx: Vec::new(),
                deadline: Some(t0),
            },
        );
    client.handle_timeout(t0 + std::time::Duration::from_millis(1));
    assert!(!client
        .sessions
        .get(&h)
        .unwrap()
        .pending_client_connects
        .contains_key(&pending_sid));
    assert!(client.events.iter().any(|e| matches!(
        e,
        WtEvent::SessionClosed {
            conn,
            session_id,
            ..
        } if *conn == conn_id && *session_id == u64::from(pending_sid)
    )));
}

#[test]
fn server_post_accept_connect_deadline_fires() {
    let caddr: SocketAddr = CADDR.parse().unwrap();
    let saddr: SocketAddr = SADDR.parse().unwrap();
    let mut server = WtEndpoint::new(true, saddr, caddr).unwrap();
    let h = ConnectionHandle(0);
    server.handle_to_id.insert(h, 9);
    server.id_to_handle.insert(9, h);
    let t0 = Instant::now();
    server.sessions.insert(
        h,
        Session {
            connect_deadline: Some(t0),
            ..Session::default()
        },
    );
    server.handle_timeout(t0 + std::time::Duration::from_millis(1));
    assert!(server.sessions.get(&h).unwrap().connect_closed);
    assert!(server
        .events
        .iter()
        .any(|e| matches!(e, WtEvent::ConnectionClosed { conn: 9, .. })));
}

#[test]
fn open_and_close_wt_session_live_multi_session() {
    let (mut server, mut client, cid) = endpoints();
    server.set_wt_max_sessions(2);
    client.set_wt_max_sessions(2);
    let mut server_est = 0usize;
    let mut client_est = 0usize;
    let mut secondary: Option<i64> = None;
    let mut secondary_closed = false;

    for _ in 0..800 {
        let a = relay_client_to_server(&mut client, &mut server);
        let b = relay_server_to_client(&mut server, &mut client);
        while let Some(ev) = server.poll_event() {
            if matches!(ev, WtEvent::SessionEstablished { .. }) {
                server_est += 1;
            }
        }
        while let Some(ev) = client.poll_event() {
            match ev {
                WtEvent::SessionEstablished { .. } => client_est += 1,
                WtEvent::SessionClosed { session_id, .. } => {
                    if secondary == Some(session_id as i64) {
                        secondary_closed = true;
                    }
                }
                _ => {}
            }
        }
        if client_est >= 1 && secondary.is_none() {
            let sid = client.open_wt_session(cid);
            assert!(
                sid >= 0,
                "open_wt_session must succeed: {:?}",
                client.take_last_error()
            );
            secondary = Some(sid);
        }
        if client_est >= 2 {
            if let Some(sid) = secondary {
                let stream = client.open_stream(cid, sid as u64, true);
                if stream >= 0 {
                    let _ = client.stream_write(stream as u32, b"x");
                }
                assert!(client.close_wt_session(cid, sid as u64, 17, b"extra-done"));
                break;
            }
        }
        if !a && !b {
            let now = Instant::now();
            server.handle_timeout(now);
            client.handle_timeout(now);
        }
    }
    assert!(
        client_est >= 2 && server_est >= 2,
        "expected dual CONNECT (client={client_est} server={server_est})"
    );
    // Drain close notification.
    for _ in 0..200 {
        let _ = relay_client_to_server(&mut client, &mut server);
        let _ = relay_server_to_client(&mut server, &mut client);
        while let Some(ev) = client.poll_event() {
            if let WtEvent::SessionClosed { session_id, .. } = ev {
                if secondary == Some(session_id as i64) {
                    secondary_closed = true;
                }
            }
        }
        if secondary_closed {
            break;
        }
    }
    assert!(secondary_closed || secondary.is_some());
    // The primary session closes over its own CONNECT stream; the QUIC
    // connection carrying it stays up.
    assert!(client.close_wt_session(cid, 0, 0, b"primary"));
    assert!(client.sessions.values().all(|s| s.connect_closed));
}

/// Closing the primary session writes a WT_CLOSE_SESSION capsule on the CONNECT
/// stream: the peer learns the application code and reason, and the QUIC
/// connection is never closed out from under sibling sessions.
#[test]
fn primary_session_close_conveys_code_and_reason_over_capsule() {
    let (mut server, mut client, cid) = endpoints();
    let mut established = false;
    let mut closed: Option<(u32, String)> = None;
    let mut server_conn_closed = false;

    for _ in 0..800 {
        let a = relay_client_to_server(&mut client, &mut server);
        let b = relay_server_to_client(&mut server, &mut client);
        while let Some(ev) = client.poll_event() {
            if matches!(ev, WtEvent::SessionEstablished { .. }) {
                established = true;
            }
        }
        while let Some(ev) = server.poll_event() {
            match ev {
                WtEvent::SessionClosed { code, reason, .. } => closed = Some((code, reason)),
                WtEvent::ConnectionClosed { .. } => server_conn_closed = true,
                _ => {}
            }
        }
        if established && closed.is_none() {
            assert!(client.close_wt_session(cid, 0, 4001, b"bye now"));
            established = false; // fire once
        }
        if closed.is_some() {
            break;
        }
        if !a && !b {
            let now = Instant::now();
            server.handle_timeout(now);
            client.handle_timeout(now);
        }
    }

    assert_eq!(
        closed,
        Some((4001, "bye now".to_string())),
        "peer must observe the capsule's code and reason"
    );
    assert!(
        !server_conn_closed,
        "a session close must not close the QUIC connection"
    );
}

/// WT_DRAIN_SESSION reaches the peer as SessionDraining and leaves the session
/// usable: draining is advisory, not a close.
#[test]
fn drain_capsule_notifies_the_peer_without_closing_the_session() {
    let (mut server, mut client, cid) = endpoints();
    let mut established = false;
    let mut drained = false;
    let mut closed = false;

    for _ in 0..800 {
        let a = relay_client_to_server(&mut client, &mut server);
        let b = relay_server_to_client(&mut server, &mut client);
        while let Some(ev) = client.poll_event() {
            if matches!(ev, WtEvent::SessionEstablished { .. }) {
                established = true;
            }
        }
        while let Some(ev) = server.poll_event() {
            match ev {
                WtEvent::SessionDraining { .. } => drained = true,
                WtEvent::SessionClosed { .. } | WtEvent::ConnectionClosed { .. } => closed = true,
                _ => {}
            }
        }
        if established && !drained {
            assert!(client.drain_wt_session(cid, 0));
            established = false; // fire once
        }
        if drained {
            break;
        }
        if !a && !b {
            let now = Instant::now();
            server.handle_timeout(now);
            client.handle_timeout(now);
        }
    }

    assert!(drained, "peer must observe WT_DRAIN_SESSION");
    assert!(!closed, "a drain must not close the session");
    // Draining an unestablished session is refused rather than writing a
    // capsule before the 2xx (§3.2).
    assert!(!client.drain_wt_session(cid, 99));
}

/// A closed primary session stops being a demux target while its connection
/// (and any sibling sessions) keep running, so late inbound streams naming it
/// are rejected instead of routed onto a dead session.
#[test]
fn live_connect_streams_drops_a_closed_primary_but_keeps_extras() {
    use quinn_proto::{Dir, Side};
    let primary = StreamId::new(Side::Client, Dir::Bi, 0);
    let extra = StreamId::new(Side::Client, Dir::Bi, 1);
    let mut session = Session {
        established: true,
        connect_stream: Some(primary),
        ..Session::default()
    };
    session.extra_sessions.insert(extra);
    assert_eq!(
        session.live_connect_streams().collect::<Vec<_>>(),
        vec![primary, extra]
    );

    session.connect_closed = true;
    assert_eq!(
        session.live_connect_streams().collect::<Vec<_>>(),
        vec![extra]
    );
    // The full set still names the primary: replies on that stream stay routable.
    assert!(session.all_connect_streams().any(|s| s == primary));
}

#[test]
fn close_wt_session_unknown_ids_fail_closed() {
    let (mut client, _h, conn_id) = client_with_established_peer(2);
    assert!(!client.close_wt_session(999, 0, 0, b"x"));
    assert!(client
        .take_last_error()
        .unwrap()
        .contains("E_SESSION_CLOSED"));
    assert!(!client.close_wt_session(conn_id, 99, 0, b"x"));
    assert!(client
        .take_last_error()
        .unwrap()
        .contains("unknown WebTransport session id"));
}

#[test]
fn parse_pending_client_connect_qpack_blocked_invalid_and_data_skip() {
    use quinn_proto::{Dir, Side};
    // Blocked RIC against empty decoder with capacity>0 and max_blocked=0 → protocol close.
    let (mut client, h, _conn_id) = client_with_established_peer(2);
    let pending_sid = StreamId::new(Side::Client, Dir::Bi, 4);
    {
        let s = client.sessions.get_mut(&h).unwrap();
        s.qpack_decoder = h3::QpackDecoder::new(&h3::QpackLocalSettings {
            max_table_capacity: 4096,
            max_blocked_streams: 0,
        });
    }
    let mut section = Vec::new();
    h3::encode_field_section_prefix(1, 0, 4096, &mut section).unwrap();
    let blocked = h3::frame_wrap(h3::frame::HEADERS, &section);
    client
        .sessions
        .get_mut(&h)
        .unwrap()
        .pending_client_connects
        .insert(
            pending_sid,
            PendingClientConnect {
                rx: blocked,
                deadline: None,
            },
        );
    client.parse_pending_client_connect(h, pending_sid);
    assert!(
        client
            .events
            .iter()
            .any(|e| matches!(e, WtEvent::ConnectionClosed { .. })),
        "blocked QPACK with max_blocked=0 must fail closed"
    );

    // Invalid dynamic index → protocol close.
    let (mut client, h, _conn_id) = client_with_established_peer(2);
    let pending_sid = StreamId::new(Side::Client, Dir::Bi, 8);
    let invalid = h3::frame_wrap(h3::frame::HEADERS, &[0x00, 0x00, 0x80]);
    client
        .sessions
        .get_mut(&h)
        .unwrap()
        .pending_client_connects
        .insert(
            pending_sid,
            PendingClientConnect {
                rx: invalid,
                deadline: None,
            },
        );
    client.parse_pending_client_connect(h, pending_sid);
    assert!(client
        .events
        .iter()
        .any(|e| matches!(e, WtEvent::ConnectionClosed { .. })));

    // Non-HEADERS DATA drained, then 200 establishes.
    let (mut client, h, conn_id) = client_with_established_peer(2);
    let pending_sid = StreamId::new(Side::Client, Dir::Bi, 12);
    let mut rx = h3::frame_wrap(h3::frame::DATA, b"xx");
    rx.extend_from_slice(&h3::encode_status_response("200"));
    client
        .sessions
        .get_mut(&h)
        .unwrap()
        .pending_client_connects
        .insert(pending_sid, PendingClientConnect { rx, deadline: None });
    client.parse_pending_client_connect(h, pending_sid);
    assert!(client
        .sessions
        .get(&h)
        .unwrap()
        .extra_sessions
        .contains(&pending_sid));
    assert!(client.events.iter().any(|e| matches!(
        e,
        WtEvent::SessionEstablished { conn, session_id, .. }
        if *conn == conn_id && *session_id == u64::from(pending_sid)
    )));
}

#[test]
fn parse_client_connect_blocked_fail_closed() {
    let caddr: SocketAddr = CADDR.parse().unwrap();
    let saddr: SocketAddr = SADDR.parse().unwrap();
    let mut client = WtEndpoint::new(false, caddr, saddr).unwrap();
    let h = ConnectionHandle(0);
    client.handle_to_id.insert(h, 11);
    client.id_to_handle.insert(11, h);
    let mut section = Vec::new();
    h3::encode_field_section_prefix(1, 0, 4096, &mut section).unwrap();
    let sess = Session {
        connect_self_opened: true,
        connect_rx: h3::frame_wrap(h3::frame::HEADERS, &section),
        qpack_decoder: h3::QpackDecoder::new(&h3::QpackLocalSettings {
            max_table_capacity: 4096,
            max_blocked_streams: 0,
        }),
        ..Session::default()
    };
    client.sessions.insert(h, sess);
    client.parse_client_connect(h);
    assert!(client
        .events
        .iter()
        .any(|e| matches!(e, WtEvent::ConnectionClosed { .. })));
}

fn establish_pair(max_sessions: u64) -> (WtEndpoint, WtEndpoint, u32) {
    let caddr: SocketAddr = CADDR.parse().unwrap();
    let saddr: SocketAddr = SADDR.parse().unwrap();
    let mut server = WtEndpoint::new(true, saddr, caddr).unwrap();
    let mut client = WtEndpoint::new(false, caddr, saddr).unwrap();
    server.set_wt_max_sessions(max_sessions);
    client.set_wt_max_sessions(max_sessions);
    let cid = client.connect("localhost") as u32;
    let mut ok = false;
    for _ in 0..600 {
        let moved = relay_client_to_server(&mut client, &mut server)
            | relay_server_to_client(&mut server, &mut client);
        while let Some(ev) = client.poll_event() {
            if matches!(ev, WtEvent::SessionEstablished { .. }) {
                ok = true;
            }
        }
        while server.poll_event().is_some() {}
        if ok {
            break;
        }
        if !moved {
            let now = Instant::now();
            server.handle_timeout(now);
            client.handle_timeout(now);
        }
    }
    assert!(ok, "primary session must establish");
    (server, client, cid)
}

#[test]
fn next_timeout_tracks_pending_client_connect_deadline() {
    use quinn_proto::{Dir, Side};
    let (mut client, h, _conn_id) = client_with_established_peer(2);
    let pending_sid = StreamId::new(Side::Client, Dir::Bi, 4);
    let deadline = Instant::now() + std::time::Duration::from_millis(40);
    client
        .sessions
        .get_mut(&h)
        .unwrap()
        .pending_client_connects
        .insert(
            pending_sid,
            PendingClientConnect {
                rx: Vec::new(),
                deadline: Some(deadline),
            },
        );
    let ms = client.next_timeout_ms();
    assert!(
        ms >= 0.0 && ms <= 40.0,
        "pending CONNECT deadline must contribute to next_timeout_ms (got {ms})"
    );
}

#[test]
fn encode_status_and_connect_ok_fall_back_when_dynamic_qpack_insert_fails() {
    // Tiny dynamic table cannot hold ":status"/code → encode_*_with Err → static fallback.
    let (mut server, h, sid) = server_with_request(h3::encode_get_request("localhost", "/x"));
    server.sessions.get_mut(&h).unwrap().qpack_encoder = h3::QpackEncoder::new(8);
    server.parse_server_connect(h, sid);
    assert!(
        server
            .sessions
            .get(&h)
            .unwrap()
            .in_streams
            .get(&sid)
            .unwrap()
            .buf
            .is_empty(),
        "404 fallback must still drain the non-CONNECT request"
    );

    let (mut server2, h2, sid2) = server_with_request(h3::encode_connect_request("localhost", "/"));
    server2.sessions.get_mut(&h2).unwrap().qpack_encoder = h3::QpackEncoder::new(8);
    server2.parse_server_connect(h2, sid2);
    assert!(
        server2.sessions.get(&h2).unwrap().established,
        "CONNECT ok fallback must still establish"
    );
}

#[test]
fn send_datagram_connection_missing_arm() {
    let (mut client, _h, conn_id) = client_with_established_peer(1);
    assert!(!client.send_datagram(conn_id, 0, b"x"));
    assert_eq!(
        client.take_last_error().as_deref(),
        Some("E_SESSION_CLOSED: connection missing")
    );
}

#[test]
fn send_datagram_toolarge_arm() {
    let (_server, mut client, cid) = establish_pair(2);
    let h = *client.id_to_handle.get(&cid).unwrap();
    let transport = client
        .conns
        .get_mut(&h)
        .unwrap()
        .datagrams()
        .max_size()
        .expect("transport datagram size");
    // Skip pre-check so framed size can exceed quinn's DATAGRAM cap.
    assert!(!client.send_datagram_unchecked_size(cid, 0, &vec![0u8; transport]));
    assert_eq!(
        client.take_last_error().as_deref(),
        Some("E_LIMIT_EXCEEDED: maxDatagramSize exceeded")
    );
}

#[test]
fn stream_write_blocked_and_reset_error_arms() {
    let (mut server, mut client, cid) = establish_pair(2);
    let stream = client.open_stream(cid, 0, true);
    assert!(stream >= 0);
    let stream = stream as u32;
    // Deliver STREAM frames so the stream exists, then stop pumping so the
    // send window cannot grow — subsequent large writes block.
    for _ in 0..40 {
        let _ = relay_client_to_server(&mut client, &mut server);
        let _ = relay_server_to_client(&mut server, &mut client);
        while server.poll_event().is_some() {}
        while client.poll_event().is_some() {}
    }
    let chunk = vec![0u8; 64 * 1024];
    let mut saw_blocked = false;
    for _ in 0..4_000 {
        let n = client.stream_write(stream, &chunk);
        if n == 0 {
            assert!(
                client
                    .take_last_error()
                    .unwrap_or_default()
                    .contains("E_BACKPRESSURE_TIMEOUT"),
                "Blocked write must set backpressure diagnostic"
            );
            saw_blocked = true;
            break;
        }
        assert!(n > 0, "unexpected write failure before block");
    }
    assert!(saw_blocked, "unpumped large writes must eventually Block");

    let stream2 = client.open_stream(cid, 0, true);
    assert!(stream2 >= 0);
    let stream2 = stream2 as u32;
    for _ in 0..40 {
        let _ = relay_client_to_server(&mut client, &mut server);
        let _ = relay_server_to_client(&mut server, &mut client);
        while server.poll_event().is_some() {}
        while client.poll_event().is_some() {}
    }
    client.stream_reset(stream2, 7);
    assert_eq!(client.stream_write(stream2, b"after-reset"), -1);
    assert!(client
        .take_last_error()
        .unwrap_or_default()
        .contains("E_STREAM_RESET"));
}

#[test]
fn pending_connect_peer_fin_before_200_emits_session_closed() {
    let (mut server, mut client, cid) = establish_pair(2);
    let secondary = client.open_wt_session(cid);
    assert!(
        secondary >= 0,
        "open secondary: {:?}",
        client.take_last_error()
    );
    let secondary = secondary as u64;

    // Deliver the client's CONNECT bidi to the server, then FIN the server
    // send half with no HEADERS so the client sees Finished while still pending.
    let mut finished_peer = false;
    for _ in 0..400 {
        let _ = relay_client_to_server(&mut client, &mut server);
        let _ = relay_server_to_client(&mut server, &mut client);
        while server.poll_event().is_some() {}
        while client.poll_event().is_some() {}

        if !finished_peer {
            for (&h, sess) in server.sessions.iter() {
                let primary = sess.connect_stream;
                let targets: Vec<_> = sess
                    .in_streams
                    .iter()
                    .filter(|(sid, st)| st.is_bidi && Some(**sid) != primary)
                    .map(|(sid, _)| *sid)
                    .collect();
                if let Some(conn) = server.conns.get_mut(&h) {
                    for sid in targets {
                        let _ = conn.send_stream(sid).finish();
                        finished_peer = true;
                    }
                }
            }
        }
        if finished_peer {
            break;
        }
    }
    assert!(
        finished_peer,
        "server must observe and FIN the secondary CONNECT"
    );

    let mut closed = false;
    for _ in 0..400 {
        let _ = relay_client_to_server(&mut client, &mut server);
        let _ = relay_server_to_client(&mut server, &mut client);
        while let Some(ev) = client.poll_event() {
            if let WtEvent::SessionClosed { session_id, .. } = ev {
                if session_id == secondary {
                    closed = true;
                }
            }
        }
        while server.poll_event().is_some() {}
        if closed {
            break;
        }
        let now = Instant::now();
        server.handle_timeout(now);
        client.handle_timeout(now);
    }
    assert!(
        closed,
        "Finished pending CONNECT must emit SessionClosed (read_one 1656 path)"
    );
}

#[test]
fn parse_pending_failure_resets_live_quic_stream() {
    let (_server, mut client, cid) = establish_pair(2);
    let secondary = client.open_wt_session(cid);
    assert!(secondary >= 0, "{:?}", client.take_last_error());
    // Do not relay — keep the CONNECT pending and inject a final non-200.
    let h = *client.id_to_handle.get(&cid).expect("client handle");
    let pending_sid = *client
        .sessions
        .get(&h)
        .unwrap()
        .pending_client_connects
        .keys()
        .next()
        .expect("secondary still pending");
    client
        .sessions
        .get_mut(&h)
        .unwrap()
        .pending_client_connects
        .get_mut(&pending_sid)
        .unwrap()
        .rx = h3::encode_status_response("404");
    client.parse_pending_client_connect(h, pending_sid);
    assert!(client.events.iter().any(|e| matches!(
        e,
        WtEvent::SessionClosed { session_id, .. } if *session_id == u64::from(pending_sid)
    )));
    assert!(!client
        .sessions
        .get(&h)
        .unwrap()
        .pending_client_connects
        .contains_key(&pending_sid));
}

#[test]
fn parse_pending_qpack_blocked_waits_when_max_blocked_nonzero() {
    use quinn_proto::{Dir, Side};
    let (mut client, h, _conn_id) = client_with_established_peer(2);
    let pending_sid = StreamId::new(Side::Client, Dir::Bi, 4);
    {
        let s = client.sessions.get_mut(&h).unwrap();
        s.qpack_decoder = h3::QpackDecoder::new(&h3::QpackLocalSettings {
            max_table_capacity: 4096,
            max_blocked_streams: 8,
        });
    }
    let mut section = Vec::new();
    h3::encode_field_section_prefix(1, 0, 4096, &mut section).unwrap();
    let blocked = h3::frame_wrap(h3::frame::HEADERS, &section);
    client
        .sessions
        .get_mut(&h)
        .unwrap()
        .pending_client_connects
        .insert(
            pending_sid,
            PendingClientConnect {
                rx: blocked,
                deadline: None,
            },
        );
    client.parse_pending_client_connect(h, pending_sid);
    assert!(
        client
            .sessions
            .get(&h)
            .unwrap()
            .pending_client_connects
            .contains_key(&pending_sid),
        "Blocked with max_blocked>0 must wait (not fail closed)"
    );
    assert!(
        !client
            .events
            .iter()
            .any(|e| matches!(e, WtEvent::ConnectionClosed { .. })),
        "must not protocol-close when blocking is permitted"
    );
}

#[test]
fn server_datagram_ingress_rate_limit_and_event_budget_close() {
    let caddr: SocketAddr = CADDR.parse().unwrap();
    let saddr: SocketAddr = SADDR.parse().unwrap();
    let limits = WasmLimits {
        max_queued_bytes_global: 8,
        max_queued_bytes_per_session: 8,
        max_queued_bytes_per_stream: 8,
        max_datagram_size: 64,
        ..WasmLimits::default()
    };
    let rate = WasmRateLimits {
        datagrams_ingress_per_sec: 1,
        datagrams_ingress_burst: 1,
        ..WasmRateLimits::default()
    };
    let mut server =
        WtEndpoint::new_with_limits_and_rate_limits(true, saddr, caddr, limits.clone(), rate)
            .unwrap();
    let mut client = WtEndpoint::new_with_limits(false, caddr, saddr, limits).unwrap();
    let cid = client.connect("localhost") as u32;
    let mut established = false;
    for _ in 0..600 {
        let moved = relay_client_to_server(&mut client, &mut server)
            | relay_server_to_client(&mut server, &mut client);
        while let Some(ev) = client.poll_event() {
            if matches!(ev, WtEvent::SessionEstablished { .. }) {
                established = true;
            }
        }
        while server.poll_event().is_some() {}
        if established {
            break;
        }
        if !moved {
            let now = Instant::now();
            server.handle_timeout(now);
            client.handle_timeout(now);
        }
    }
    assert!(established);
    let now = Instant::now();
    let server_conn = *server.id_to_handle.keys().next().expect("server conn");
    let _ =
        server
            .rate_limiter
            .check_connection(now, server_conn, RateLimitDimension::DatagramIngress);
    assert!(client.send_datagram(cid, 0, b"rate-me"));
    for _ in 0..80 {
        let _ = relay_client_to_server(&mut client, &mut server);
        let _ = relay_server_to_client(&mut server, &mut client);
        while server.poll_event().is_some() {}
        while client.poll_event().is_some() {}
    }
    let err = server.take_last_error().unwrap_or_default();
    assert!(
        err.contains("E_RATE_LIMITED") || err.contains("budget") || err.contains("E_QUEUE_FULL"),
        "ingress datagram must hit rate-limit or budget arm, got {err}"
    );
}

#[test]
fn reject_wt_unknown_session_resets_live_connection_stream() {
    use quinn_proto::{Dir, Side};
    let (mut server, _client, _cid) = establish_pair(2);
    let h = *server.id_to_handle.values().next().expect("server handle");
    let wt = StreamId::new(Side::Client, Dir::Uni, 9);
    server.sessions.get_mut(&h).unwrap().in_streams.insert(
        wt,
        InStream {
            kind: None,
            is_bidi: false,
            sid_read: false,
            wt_session_id: None,
            handle: None,
            connect_admitted: false,
            buf: Vec::new(),
        },
    );
    let mut bytes = Vec::new();
    crate::varint::encode(h3::stream_type::WT_UNI, &mut bytes);
    crate::varint::encode(999, &mut bytes); // unknown session id
    bytes.extend_from_slice(b"x");
    server.process_in_stream(h, wt, &bytes, false, Instant::now());
    assert!(server
        .take_last_error()
        .unwrap_or_default()
        .contains("unknown WebTransport session id"));
    assert!(!server
        .sessions
        .get(&h)
        .unwrap()
        .in_streams
        .contains_key(&wt));
}

/// §4.6: a WebTransport stream the receiver cannot associate with a session is
/// rejected with WT_BUFFERED_STREAM_REJECTED, the same codepoint the native
/// fork sends, so a sender sees one code from both backends.
#[test]
fn unassociated_wt_stream_is_rejected_with_buffered_stream_rejected() {
    use quinn_proto::{Dir, Side, WriteError};
    let (mut server, mut client, cid) = establish_pair(2);
    let ch = *client.id_to_handle.get(&cid).expect("client handle");

    // Open a raw uni stream naming a session the server has never seen.
    let sid = {
        let conn = client.conns.get_mut(&ch).expect("client conn");
        let sid = conn.streams().open(Dir::Uni).expect("uni stream");
        let mut header = Vec::new();
        crate::varint::encode(h3::stream_type::WT_UNI, &mut header);
        crate::varint::encode(999, &mut header);
        conn.send_stream(sid).write(&header).expect("write header");
        sid
    };
    assert_eq!(sid.dir(), Dir::Uni);
    assert_eq!(sid.initiator(), Side::Client);

    let mut stop_code = None;
    for _ in 0..200 {
        let a = relay_client_to_server(&mut client, &mut server);
        let b = relay_server_to_client(&mut server, &mut client);
        while client.poll_event().is_some() {}
        while server.poll_event().is_some() {}
        if let Some(conn) = client.conns.get_mut(&ch) {
            if let Err(WriteError::Stopped(code)) = conn.send_stream(sid).write(b"payload") {
                stop_code = Some(code.into_inner());
                break;
            }
        }
        if !a && !b {
            let now = Instant::now();
            server.handle_timeout(now);
            client.handle_timeout(now);
        }
    }

    assert_eq!(
        stop_code,
        Some(u64::from(crate::wt_error::WT_BUFFERED_STREAM_REJECTED)),
        "sender must see WT_BUFFERED_STREAM_REJECTED"
    );
}

#[test]
fn handle_timeout_fires_quic_timer_and_pending_with_conn() {
    let (mut server, mut client, cid) = establish_pair(2);
    let secondary = client.open_wt_session(cid);
    assert!(secondary >= 0, "{:?}", client.take_last_error());
    let h = *client.id_to_handle.get(&cid).unwrap();
    let pending_sid = *client
        .sessions
        .get(&h)
        .unwrap()
        .pending_client_connects
        .keys()
        .next()
        .expect("pending secondary");
    let t0 = Instant::now();
    client
        .sessions
        .get_mut(&h)
        .unwrap()
        .pending_client_connects
        .get_mut(&pending_sid)
        .unwrap()
        .deadline = Some(t0);
    // Far-future `now` forces poll_timeout() <= now; same tick also expires pending.
    let later = t0 + std::time::Duration::from_secs(3_600);
    client.handle_timeout(later);
    server.handle_timeout(later);
    assert!(client.events.iter().any(|e| matches!(
        e,
        WtEvent::SessionClosed { session_id, .. } if *session_id == u64::from(pending_sid)
    )));
}

#[test]
fn poll_event_encoded_closes_registered_connection_on_token_exhaustion() {
    let caddr: SocketAddr = CADDR.parse().unwrap();
    let saddr: SocketAddr = SADDR.parse().unwrap();
    let mut endpoint = WtEndpoint::new_with_limits(
        true,
        saddr,
        caddr,
        WasmLimits {
            max_queued_bytes_global: 4,
            max_queued_bytes_per_session: 4,
            max_queued_bytes_per_stream: 4,
            ..WasmLimits::default()
        },
    )
    .unwrap();
    let h = ConnectionHandle(0);
    endpoint.handle_to_id.insert(h, 7);
    endpoint.id_to_handle.insert(7, h);
    endpoint.sessions.insert(h, Session::default());
    endpoint.governor.set_host_token_ceiling_for_test(1);
    endpoint.push_event(WtEvent::Datagram {
        conn: 7,
        session_id: 0,
        data: vec![1],
    });
    endpoint.push_event(WtEvent::Datagram {
        conn: 7,
        session_id: 0,
        data: vec![2],
    });
    assert!(endpoint.poll_event_encoded().is_some());
    let encoded = endpoint
        .poll_event_encoded()
        .expect("closed via close_conn");
    assert_eq!(encoded[0], crate::event::tag::CLOSED);
    assert!(
        !endpoint.id_to_handle.contains_key(&7),
        "registered conn must be torn down via close_conn path"
    );
}

#[test]
fn open_wt_session_stream_capacity_unavailable_arm() {
    let (_server, mut client, cid) = establish_pair(8);
    // Exhaust client-initiated bidi stream credit, then open_wt_session must
    // fail on streams().open(Dir::Bi) == None.
    let mut opened = 0usize;
    for _ in 0..10_000 {
        let s = client.open_stream(cid, 0, true);
        if s < 0 {
            break;
        }
        opened += 1;
    }
    assert!(opened > 0, "should open at least one WT data stream");
    let sid = client.open_wt_session(cid);
    assert_eq!(sid, -1);
    assert!(
        client
            .take_last_error()
            .unwrap_or_default()
            .contains("stream capacity unavailable"),
        "expected stream capacity arm"
    );
}

#[test]
fn parse_qpack_decoder_oversized_buffer_fails_closed() {
    use quinn_proto::{Dir, Side};
    let caddr: SocketAddr = CADDR.parse().unwrap();
    let saddr: SocketAddr = SADDR.parse().unwrap();
    let mut server = WtEndpoint::new(true, saddr, caddr).unwrap();
    let h = ConnectionHandle(0);
    server.handle_to_id.insert(h, 3);
    server.id_to_handle.insert(3, h);
    let qdec = StreamId::new(Side::Client, Dir::Uni, 2);
    let mut sess = Session::default();
    sess.in_streams.insert(
        qdec,
        InStream {
            kind: None,
            is_bidi: false,
            sid_read: false,
            wt_session_id: None,
            handle: None,
            connect_admitted: false,
            buf: Vec::new(),
        },
    );
    server.sessions.insert(h, sess);
    let mut bytes = Vec::new();
    crate::varint::encode(h3::stream_type::QPACK_DECODER, &mut bytes);
    bytes.extend(std::iter::repeat_n(0xABu8, MAX_H3_FRAME_SIZE as usize + 8));
    server.process_in_stream(h, qdec, &bytes, false, Instant::now());
    assert!(server.events.iter().any(|e| matches!(
        e,
        WtEvent::ConnectionClosed {
            code: QPACK_DECODER_STREAM_ERROR,
            ..
        }
    )));
}

#[test]
fn tls_server_name_from_authority_strips_port_and_brackets() {
    assert_eq!(
        tls_server_name_from_authority("localhost:443").as_deref(),
        Some("localhost")
    );
    assert_eq!(
        tls_server_name_from_authority("example.com").as_deref(),
        Some("example.com")
    );
    assert_eq!(
        tls_server_name_from_authority("[::1]:4433").as_deref(),
        Some("::1")
    );
    assert_eq!(tls_server_name_from_authority("").as_deref(), None);
    assert_eq!(tls_server_name_from_authority("   ").as_deref(), None);
    assert_eq!(
        tls_server_name_from_authority("not-a-port:abc").as_deref(),
        Some("not-a-port:abc")
    );
}

#[test]
fn qpack_blocked_stream_cap_refuses_additional_streams() {
    let mut sessions = HashMap::new();
    let h = ConnectionHandle(0);
    let mut sess = Session::default();
    sess.qpack_decoder = h3::QpackDecoder::new(&h3::QpackLocalSettings {
        max_table_capacity: 4096,
        max_blocked_streams: 1,
    });
    sessions.insert(h, sess);
    let s0 = StreamId::new(quinn_proto::Side::Client, Dir::Bi, 0);
    let s1 = StreamId::new(quinn_proto::Side::Client, Dir::Bi, 1);
    assert!(note_qpack_header_blocked(&mut sessions, h, Some(s0)).is_ok());
    // Same stream may wait again.
    assert!(note_qpack_header_blocked(&mut sessions, h, Some(s0)).is_ok());
    let err = note_qpack_header_blocked(&mut sessions, h, Some(s1)).unwrap_err();
    assert!(std::str::from_utf8(err).unwrap().contains("limit exceeded"));
    clear_qpack_header_blocked(&mut sessions, h, s0);
    assert!(note_qpack_header_blocked(&mut sessions, h, Some(s1)).is_ok());
}

#[test]
fn endpoint_guard_decision_covers_all_arms() {
    assert_eq!(endpoint_guard_decision(false, true, false, false), 1);
    assert_eq!(endpoint_guard_decision(false, false, true, false), 2);
    assert_eq!(endpoint_guard_decision(true, false, false, true), 3);
    assert_eq!(endpoint_guard_decision(true, false, false, false), 4);
    assert_eq!(endpoint_guard_decision(false, false, false, true), 5);
    assert_eq!(endpoint_guard_decision(false, false, false, false), 6);
}

/// §6 teardown must not reach for a stream half that does not exist. A
/// unidirectional stream has only one, owned by whichever side opened it, and
/// quinn-proto asserts on the other — which in wasm is an unreachable trap, not
/// a catchable error. Closing a session that owns a self-opened uni stream
/// (and one the peer opened) has to survive.
#[test]
fn closing_a_session_with_unidirectional_streams_does_not_trap() {
    let (mut server, mut client, cid) = endpoints();
    let mut established = false;

    for _ in 0..800 {
        let a = relay_client_to_server(&mut client, &mut server);
        let b = relay_server_to_client(&mut server, &mut client);
        while let Some(ev) = client.poll_event() {
            if matches!(ev, WtEvent::SessionEstablished { .. }) {
                established = true;
            }
        }
        while server.poll_event().is_some() {}
        if established {
            break;
        }
        if !a && !b {
            let now = Instant::now();
            server.handle_timeout(now);
            client.handle_timeout(now);
        }
    }
    assert!(established, "session must establish");

    // Send-only half locally, and let the peer's uni stream arrive so the
    // recv-only case is covered on the client too.
    assert!(client.open_stream(cid, 0, false) >= 0);
    assert!(server.open_stream(cid, 0, false) >= 0);
    for _ in 0..200 {
        let a = relay_client_to_server(&mut client, &mut server);
        let b = relay_server_to_client(&mut server, &mut client);
        while client.poll_event().is_some() {}
        while server.poll_event().is_some() {}
        if !a && !b {
            break;
        }
    }

    assert!(client.close_wt_session(cid, 0, 7, b"bye"));
    assert!(server.close_wt_session(cid, 0, 7, b"bye"));
}
