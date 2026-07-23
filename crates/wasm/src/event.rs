//! Events surfaced from the bridge to JS, plus a compact wire form for poll_event.
use crate::varint;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WtEvent {
    /// A QUIC connection completed its TLS handshake.
    Connected { conn: u32 },
    /// A WebTransport session is established (CONNECT 200 exchanged).
    SessionEstablished { conn: u32 },
    /// A WebTransport datagram arrived for the session.
    Datagram { conn: u32, data: Vec<u8> },
    /// The connection/session closed.
    Closed { conn: u32, code: u32 },
    /// A peer opened a WebTransport stream.
    StreamOpened { conn: u32, stream: u32, bidi: bool },
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
}

pub mod tag {
    pub const CONNECTED: u8 = 1;
    pub const SESSION_ESTABLISHED: u8 = 2;
    pub const DATAGRAM: u8 = 3;
    pub const CLOSED: u8 = 4;
    pub const STREAM_OPENED: u8 = 5;
    pub const STREAM_DATA: u8 = 6;
    pub const STREAM_RESET: u8 = 7;
    pub const STREAM_STOPPED: u8 = 8;
}

impl WtEvent {
    /// Serialize as: tag(1) || conn varint || [event-specific fields]. Stream
    /// events carry conn first, then stream, then their payload.
    pub fn encode(&self) -> Vec<u8> {
        self.encode_with_host_token(None)
    }

    /// Payload-bearing events can append a host-reservation token so JS can
    /// release Rust-side queue ownership exactly once after delivery.
    pub fn encode_with_host_token(&self, host_token: Option<u32>) -> Vec<u8> {
        let mut out = Vec::new();
        match self {
            WtEvent::Connected { conn } => {
                out.push(tag::CONNECTED);
                varint::encode(*conn as u64, &mut out);
            }
            WtEvent::SessionEstablished { conn } => {
                out.push(tag::SESSION_ESTABLISHED);
                varint::encode(*conn as u64, &mut out);
            }
            WtEvent::Datagram { conn, data } => {
                out.push(tag::DATAGRAM);
                varint::encode(*conn as u64, &mut out);
                varint::encode(data.len() as u64, &mut out);
                out.extend_from_slice(data);
                varint::encode(host_token.unwrap_or(0) as u64, &mut out);
            }
            WtEvent::Closed { conn, code } => {
                out.push(tag::CLOSED);
                varint::encode(*conn as u64, &mut out);
                varint::encode(*code as u64, &mut out);
            }
            WtEvent::StreamOpened { conn, stream, bidi } => {
                out.push(tag::STREAM_OPENED);
                varint::encode(*conn as u64, &mut out);
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
        }
        out
    }
}
