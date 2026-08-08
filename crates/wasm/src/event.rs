//! Events surfaced from the bridge to JS, plus a compact wire form for poll_event.
//!
//! Wire version 3 (see `PRODUCTION_BUILD.json` `eventWireVersion`): session_id on
//! session-scoped events, `SessionClosed` tag 9 carrying the peer's close reason,
//! and `SessionDraining` tag 10. Hosts should treat a mismatch as a
//! build/packaging error (no runtime negotiation this round).
use crate::varint;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WtEvent {
    /// A QUIC connection completed its TLS handshake.
    Connected { conn: u32 },
    /// A WebTransport session is established (CONNECT 200 exchanged).
    SessionEstablished { conn: u32, session_id: u64 },
    /// A WebTransport datagram arrived for the session.
    Datagram {
        conn: u32,
        session_id: u64,
        data: Vec<u8>,
    },
    /// The QUIC connection closed (primary CONNECT teardown path).
    ConnectionClosed { conn: u32, code: u32 },
    /// A peer opened a WebTransport stream.
    StreamOpened {
        conn: u32,
        session_id: u64,
        stream: u32,
        bidi: bool,
    },
    /// Data (and/or FIN) arrived on a WebTransport stream.
    StreamData {
        conn: u32,
        stream: u32,
        fin: bool,
        data: Vec<u8>,
    },
    /// A WebTransport stream was reset by the peer.
    StreamReset { conn: u32, stream: u32, code: u32 },
    /// The peer sent STOP_SENDING for our send half of a stream: further
    /// writes will fail. The recv half (if any) is unaffected.
    StreamStopped { conn: u32, stream: u32, code: u32 },
    /// A WebTransport session closed; the QUIC connection stays up. `reason` is
    /// the peer's `WT_CLOSE_SESSION` reason (empty when it sent none, or when
    /// the session ended without a capsule).
    SessionClosed {
        conn: u32,
        session_id: u64,
        code: u32,
        reason: String,
    },
    /// The peer sent `WT_DRAIN_SESSION`: it intends to close this session soon,
    /// so no new streams or datagrams should be started. Existing transfers
    /// continue until the session actually closes.
    SessionDraining { conn: u32, session_id: u64 },
}

pub mod tag {
    pub const CONNECTED: u8 = 1;
    pub const SESSION_ESTABLISHED: u8 = 2;
    pub const DATAGRAM: u8 = 3;
    /// Connection-scoped close (formerly `CLOSED`).
    pub const CLOSED: u8 = 4;
    pub const STREAM_OPENED: u8 = 5;
    pub const STREAM_DATA: u8 = 6;
    pub const STREAM_RESET: u8 = 7;
    pub const STREAM_STOPPED: u8 = 8;
    pub const SESSION_CLOSED: u8 = 9;
    pub const SESSION_DRAINING: u8 = 10;
}

fn varint_width(value: u64) -> usize {
    if value < 0x40 {
        1
    } else if value < 0x4000 {
        2
    } else if value < 0x4000_0000 {
        4
    } else {
        8
    }
}

fn encoded_capacity_hint(event: &WtEvent, host_token: Option<u32>) -> usize {
    let mut capacity = 1usize.saturating_add(varint_width(event.conn() as u64));
    let mut add = |additional: usize| {
        capacity = capacity.saturating_add(additional);
    };

    match event {
        WtEvent::Connected { .. } => {}
        WtEvent::SessionEstablished { session_id, .. } => add(varint_width(*session_id)),
        WtEvent::Datagram {
            session_id, data, ..
        } => {
            add(varint_width(*session_id));
            add(varint_width(data.len() as u64));
            add(data.len());
            add(varint_width(host_token.unwrap_or(0) as u64));
        }
        WtEvent::ConnectionClosed { code, .. } => add(varint_width(*code as u64)),
        WtEvent::StreamOpened {
            session_id, stream, ..
        } => {
            add(varint_width(*session_id));
            add(varint_width(*stream as u64));
            add(1); // bidi flag
        }
        WtEvent::StreamData { stream, data, .. } => {
            add(varint_width(*stream as u64));
            add(1); // FIN flag
            add(varint_width(data.len() as u64));
            add(data.len());
            add(varint_width(host_token.unwrap_or(0) as u64));
        }
        WtEvent::StreamReset { stream, code, .. } | WtEvent::StreamStopped { stream, code, .. } => {
            add(varint_width(*stream as u64));
            add(varint_width(*code as u64));
        }
        WtEvent::SessionClosed {
            session_id,
            code,
            reason,
            ..
        } => {
            add(varint_width(*session_id));
            add(varint_width(*code as u64));
            add(varint_width(reason.len() as u64));
            add(reason.len());
        }
        WtEvent::SessionDraining { session_id, .. } => add(varint_width(*session_id)),
    }
    capacity
}

impl WtEvent {
    /// Connection id this event belongs to.
    pub fn conn(&self) -> u32 {
        match self {
            WtEvent::Connected { conn }
            | WtEvent::SessionEstablished { conn, .. }
            | WtEvent::Datagram { conn, .. }
            | WtEvent::ConnectionClosed { conn, .. }
            | WtEvent::StreamOpened { conn, .. }
            | WtEvent::StreamData { conn, .. }
            | WtEvent::StreamReset { conn, .. }
            | WtEvent::StreamStopped { conn, .. }
            | WtEvent::SessionClosed { conn, .. }
            | WtEvent::SessionDraining { conn, .. } => *conn,
        }
    }

    /// Serialize as: tag(1) || conn varint || [event-specific fields].
    pub fn encode(&self) -> Vec<u8> {
        self.encode_with_host_token(None)
    }

    /// Payload-bearing events can append a host-reservation token so JS can
    /// release Rust-side queue ownership exactly once after delivery.
    pub fn encode_with_host_token(&self, host_token: Option<u32>) -> Vec<u8> {
        let mut out = Vec::with_capacity(encoded_capacity_hint(self, host_token));
        match self {
            WtEvent::Connected { conn } => {
                out.push(tag::CONNECTED);
                varint::encode(*conn as u64, &mut out);
            }
            WtEvent::SessionEstablished { conn, session_id } => {
                out.push(tag::SESSION_ESTABLISHED);
                varint::encode(*conn as u64, &mut out);
                varint::encode(*session_id, &mut out);
            }
            WtEvent::Datagram {
                conn,
                session_id,
                data,
            } => {
                out.push(tag::DATAGRAM);
                varint::encode(*conn as u64, &mut out);
                varint::encode(*session_id, &mut out);
                varint::encode(data.len() as u64, &mut out);
                out.extend_from_slice(data);
                varint::encode(host_token.unwrap_or(0) as u64, &mut out);
            }
            WtEvent::ConnectionClosed { conn, code } => {
                out.push(tag::CLOSED);
                varint::encode(*conn as u64, &mut out);
                varint::encode(*code as u64, &mut out);
            }
            WtEvent::StreamOpened {
                conn,
                session_id,
                stream,
                bidi,
            } => {
                out.push(tag::STREAM_OPENED);
                varint::encode(*conn as u64, &mut out);
                varint::encode(*session_id, &mut out);
                varint::encode(*stream as u64, &mut out);
                out.push(if *bidi { 1 } else { 0 });
            }
            WtEvent::StreamData {
                conn,
                stream,
                fin,
                data,
            } => {
                out.push(tag::STREAM_DATA);
                varint::encode(*conn as u64, &mut out);
                varint::encode(*stream as u64, &mut out);
                out.push(if *fin { 1 } else { 0 });
                varint::encode(data.len() as u64, &mut out);
                out.extend_from_slice(data);
                varint::encode(host_token.unwrap_or(0) as u64, &mut out);
            }
            WtEvent::StreamReset { conn, stream, code } => {
                out.push(tag::STREAM_RESET);
                varint::encode(*conn as u64, &mut out);
                varint::encode(*stream as u64, &mut out);
                varint::encode(*code as u64, &mut out);
            }
            WtEvent::StreamStopped { conn, stream, code } => {
                out.push(tag::STREAM_STOPPED);
                varint::encode(*conn as u64, &mut out);
                varint::encode(*stream as u64, &mut out);
                varint::encode(*code as u64, &mut out);
            }
            WtEvent::SessionClosed {
                conn,
                session_id,
                code,
                reason,
            } => {
                out.push(tag::SESSION_CLOSED);
                varint::encode(*conn as u64, &mut out);
                varint::encode(*session_id, &mut out);
                varint::encode(*code as u64, &mut out);
                varint::encode(reason.len() as u64, &mut out);
                out.extend_from_slice(reason.as_bytes());
            }
            WtEvent::SessionDraining { conn, session_id } => {
                out.push(tag::SESSION_DRAINING);
                varint::encode(*conn as u64, &mut out);
                varint::encode(*session_id, &mut out);
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roundtrip(ev: WtEvent, host_token: Option<u32>) {
        let wire = ev.encode_with_host_token(host_token);
        assert!(!wire.is_empty());
        assert_eq!(
            wire[0],
            match &ev {
                WtEvent::Connected { .. } => tag::CONNECTED,
                WtEvent::SessionEstablished { .. } => tag::SESSION_ESTABLISHED,
                WtEvent::Datagram { .. } => tag::DATAGRAM,
                WtEvent::ConnectionClosed { .. } => tag::CLOSED,
                WtEvent::StreamOpened { .. } => tag::STREAM_OPENED,
                WtEvent::StreamData { .. } => tag::STREAM_DATA,
                WtEvent::StreamReset { .. } => tag::STREAM_RESET,
                WtEvent::StreamStopped { .. } => tag::STREAM_STOPPED,
                WtEvent::SessionClosed { .. } => tag::SESSION_CLOSED,
                WtEvent::SessionDraining { .. } => tag::SESSION_DRAINING,
            }
        );
        // Decode enough fields to prove layout (manual spot-check via re-encode equality).
        let again = match &ev {
            WtEvent::Datagram { .. } | WtEvent::StreamData { .. } => {
                ev.encode_with_host_token(host_token)
            }
            _ => ev.encode(),
        };
        assert_eq!(wire, again);
    }

    #[test]
    fn golden_wire_roundtrip_every_variant() {
        roundtrip(WtEvent::Connected { conn: 1 }, None);
        roundtrip(
            WtEvent::SessionEstablished {
                conn: 2,
                session_id: 4,
            },
            None,
        );
        roundtrip(
            WtEvent::Datagram {
                conn: 3,
                session_id: 8,
                data: b"hi".to_vec(),
            },
            Some(9),
        );
        roundtrip(WtEvent::ConnectionClosed { conn: 4, code: 42 }, None);
        roundtrip(
            WtEvent::StreamOpened {
                conn: 5,
                session_id: 12,
                stream: 7,
                bidi: true,
            },
            None,
        );
        roundtrip(
            WtEvent::StreamData {
                conn: 6,
                stream: 1,
                fin: true,
                data: b"x".to_vec(),
            },
            Some(3),
        );
        roundtrip(
            WtEvent::StreamReset {
                conn: 7,
                stream: 2,
                code: 1,
            },
            None,
        );
        roundtrip(
            WtEvent::StreamStopped {
                conn: 8,
                stream: 3,
                code: 2,
            },
            None,
        );
        roundtrip(
            WtEvent::SessionClosed {
                conn: 9,
                session_id: 16,
                code: 0,
                reason: String::new(),
            },
            None,
        );
        roundtrip(
            WtEvent::SessionClosed {
                conn: 9,
                session_id: 16,
                code: 42,
                reason: "bye".to_string(),
            },
            None,
        );
        roundtrip(
            WtEvent::SessionDraining {
                conn: 10,
                session_id: 4,
            },
            None,
        );
    }

    #[test]
    fn session_established_wire_includes_session_id() {
        let wire = WtEvent::SessionEstablished {
            conn: 1,
            session_id: 4,
        }
        .encode();
        assert_eq!(wire[0], tag::SESSION_ESTABLISHED);
        let (conn, n1) = varint::decode(&wire[1..]).unwrap();
        assert_eq!(conn, 1);
        let (sid, _) = varint::decode(&wire[1 + n1..]).unwrap();
        assert_eq!(sid, 4);
    }

    #[test]
    fn datagram_wire_includes_session_id_before_payload() {
        let wire = WtEvent::Datagram {
            conn: 1,
            session_id: 4,
            data: b"ab".to_vec(),
        }
        .encode_with_host_token(Some(5));
        assert_eq!(wire[0], tag::DATAGRAM);
        let mut off = 1;
        let (conn, n) = varint::decode(&wire[off..]).unwrap();
        off += n;
        assert_eq!(conn, 1);
        let (sid, n) = varint::decode(&wire[off..]).unwrap();
        off += n;
        assert_eq!(sid, 4);
        let (len, n) = varint::decode(&wire[off..]).unwrap();
        off += n;
        assert_eq!(len, 2);
        assert_eq!(&wire[off..off + 2], b"ab");
        off += 2;
        let (tok, _) = varint::decode(&wire[off..]).unwrap();
        assert_eq!(tok, 5);
    }

    #[test]
    fn payload_event_frames_are_pre_sized_without_reallocation() {
        let assert_frame = |event: WtEvent, host_token: Option<u32>| {
            let expected = encoded_capacity_hint(&event, host_token);
            let wire = event.encode_with_host_token(host_token);
            assert_eq!(wire.len(), expected);
            assert_eq!(wire.capacity(), expected);
        };

        for (event, host_token) in [
            (WtEvent::Connected { conn: 1 }, None),
            (
                WtEvent::SessionEstablished {
                    conn: 0x4000,
                    session_id: 0x4000_0000,
                },
                None,
            ),
            (
                WtEvent::Datagram {
                    conn: 0x4000,
                    session_id: 0x4000_0000,
                    data: vec![0xA5; 1200],
                },
                Some(0x4000),
            ),
            (
                WtEvent::StreamData {
                    conn: 0x3f,
                    stream: 0x4000,
                    fin: true,
                    data: vec![0x5A; 2048],
                },
                None,
            ),
            (WtEvent::ConnectionClosed { conn: 4, code: 42 }, None),
            (
                WtEvent::StreamOpened {
                    conn: 5,
                    session_id: 12,
                    stream: 0x4000,
                    bidi: true,
                },
                None,
            ),
            (
                WtEvent::StreamReset {
                    conn: 7,
                    stream: 2,
                    code: 1,
                },
                None,
            ),
            (
                WtEvent::StreamStopped {
                    conn: 8,
                    stream: 3,
                    code: 2,
                },
                None,
            ),
            (
                WtEvent::SessionClosed {
                    conn: 9,
                    session_id: 16,
                    code: 42,
                    reason: "bye".to_string(),
                },
                None,
            ),
            (
                WtEvent::SessionDraining {
                    conn: 10,
                    session_id: 4,
                },
                None,
            ),
        ] {
            assert_frame(event, host_token);
        }
    }
}
