//! Why a stream half failed, in the shape JavaScript receives it.
//!
//! A peer's RESET_STREAM and STOP_SENDING carry a WebTransport application
//! error code. Stream failures used to travel as bare `&'static str` codes, so
//! the code was dropped at the first match arm and the JS layer reported
//! `streamErrorCode: null`. A [`StreamFault`] keeps it until the failure is
//! rendered into the wire message, which the TS layer parses back out.

use wtransport::error::{StreamReadError, StreamWriteError};
use wtransport::proto::application_error;
use wtransport::VarInt;

const E_STREAM_RESET: &str = "E_STREAM_RESET";
const E_STOP_SENDING: &str = "E_STOP_SENDING";
const E_SESSION_CLOSED: &str = "E_SESSION_CLOSED";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum StreamFault {
    /// A failure without a peer code: local aborts, budgets, session loss.
    Code(&'static str),
    /// The peer reset its sending half with this application code.
    PeerReset(u32),
    /// The peer asked this side to stop sending, with this application code.
    PeerStopped(u32),
}

impl StreamFault {
    /// The failure from quinn's chunk-level reads (deferred-direct lane).
    pub fn from_quic_read(err: &wtransport::quinn::ReadError) -> Self {
        match err {
            wtransport::quinn::ReadError::Reset(code) => {
                Self::PeerReset(peer_app_code(code.into_inner()))
            }
            wtransport::quinn::ReadError::ConnectionLost(_)
            | wtransport::quinn::ReadError::ClosedStream
            | wtransport::quinn::ReadError::IllegalOrderedRead
            | wtransport::quinn::ReadError::ZeroRttRejected => Self::Code(E_SESSION_CLOSED),
        }
    }

    /// The failure from wtransport's coalescing reads (bridge lane).
    pub fn from_read(err: &StreamReadError) -> Self {
        match err {
            StreamReadError::Reset(code) => Self::PeerReset(peer_app_code(code.into_inner())),
            StreamReadError::NotConnected | StreamReadError::QuicProto => {
                Self::Code(E_SESSION_CLOSED)
            }
        }
    }

    /// The failure from a write or finish on the send half.
    pub fn from_write(err: &StreamWriteError) -> Self {
        match err {
            StreamWriteError::Stopped(code) => Self::PeerStopped(peer_app_code(code.into_inner())),
            _ => Self::Code(E_STREAM_RESET),
        }
    }

    /// The stable `E_*` code.
    pub fn code(self) -> &'static str {
        match self {
            Self::Code(code) => code,
            Self::PeerReset(_) => E_STREAM_RESET,
            Self::PeerStopped(_) => E_STOP_SENDING,
        }
    }

    /// The wire message: `E_CODE: detail`. A peer code is rendered exactly as
    /// the wasm backend renders it, so one TS parser serves both backends.
    pub fn message(self) -> String {
        match self {
            Self::Code(code) => format!("{code}: {code}"),
            Self::PeerReset(app) => format!("{E_STREAM_RESET}: stream reset by peer (code {app})"),
            Self::PeerStopped(app) => {
                format!("{E_STOP_SENDING}: stream stopped by peer (code {app})")
            }
        }
    }

    pub fn into_napi(self) -> napi::Error {
        match self {
            Self::Code(code) => crate::error::from_static_code(code),
            _ => napi::Error::from_reason(self.message()),
        }
    }
}

/// The application code a peer sent, recovered from the HTTP/3 error space.
///
/// Browsers and both of this project's engines map codes into the
/// `WT_APPLICATION_ERROR` range; wtransport unmaps them on some paths (`read`,
/// `stopped`) and not on others (`write_all`, `finish`, quinn's `read_chunk`).
/// Unmapping here makes every path agree, and is a no-op for a code that is
/// already unmapped. A code outside the range is clamped to `u32`, matching the
/// wasm engine's `unmap_wt_app_error`.
pub(crate) fn peer_app_code(raw: u64) -> u32 {
    VarInt::try_from_u64(raw)
        .ok()
        .and_then(application_error::unmap)
        .unwrap_or_else(|| u32::try_from(raw).unwrap_or(u32::MAX))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn peer_app_code_unmaps_the_wt_application_range() {
        for app in [0u32, 1, 29, 30, 42, 44, 0xffff, u32::MAX] {
            assert_eq!(
                peer_app_code(application_error::remap(app).into_inner()),
                app
            );
        }
    }

    #[test]
    fn peer_app_code_leaves_already_unmapped_codes_alone() {
        assert_eq!(peer_app_code(42), 42);
        assert_eq!(peer_app_code(u64::from(u32::MAX)), u32::MAX);
    }

    #[test]
    fn peer_app_code_clamps_codes_outside_the_range() {
        let below_range = application_error::WT_APPLICATION_ERROR_FIRST - 1;
        assert_eq!(peer_app_code(below_range), u32::MAX);
        assert_eq!(peer_app_code(0x100), 0x100);
    }

    #[test]
    fn quic_reset_carries_the_unmapped_peer_code() {
        let mapped = application_error::remap(42).into_inner();
        let err = wtransport::quinn::ReadError::Reset(
            wtransport::quinn::VarInt::from_u64(mapped).expect("mapped code is a varint"),
        );
        let fault = StreamFault::from_quic_read(&err);
        assert_eq!(fault, StreamFault::PeerReset(42));
        assert_eq!(fault.code(), "E_STREAM_RESET");
        assert_eq!(
            fault.message(),
            "E_STREAM_RESET: stream reset by peer (code 42)"
        );
    }

    #[test]
    fn quic_connection_errors_have_no_peer_code() {
        let fault = StreamFault::from_quic_read(&wtransport::quinn::ReadError::ClosedStream);
        assert_eq!(fault, StreamFault::Code("E_SESSION_CLOSED"));
        assert_eq!(fault.message(), "E_SESSION_CLOSED: E_SESSION_CLOSED");
    }

    #[test]
    fn wtransport_reset_carries_the_peer_code() {
        let fault = StreamFault::from_read(&StreamReadError::Reset(VarInt::from_u32(42)));
        assert_eq!(fault, StreamFault::PeerReset(42));
        assert_eq!(
            StreamFault::from_read(&StreamReadError::NotConnected),
            StreamFault::Code("E_SESSION_CLOSED")
        );
    }

    #[test]
    fn write_stopped_carries_the_unmapped_peer_code() {
        let fault =
            StreamFault::from_write(&StreamWriteError::Stopped(application_error::remap(44)));
        assert_eq!(fault, StreamFault::PeerStopped(44));
        assert_eq!(fault.code(), "E_STOP_SENDING");
        assert_eq!(
            fault.message(),
            "E_STOP_SENDING: stream stopped by peer (code 44)"
        );
        assert_eq!(
            StreamFault::from_write(&StreamWriteError::NotConnected),
            StreamFault::Code("E_STREAM_RESET")
        );
    }

    #[test]
    fn peer_fault_messages_keep_the_code_prefix_the_parsers_read() {
        // `E_CODE:` is what WtCode::parse, the TS `E_CODE_RE` and the
        // `starts_with("E_STREAM_RESET")` checks in session.rs key on.
        for fault in [StreamFault::PeerReset(7), StreamFault::PeerStopped(7)] {
            assert!(fault.message().starts_with(&format!("{}: ", fault.code())));
        }
    }

    #[test]
    fn into_napi_preserves_the_bare_code_message() {
        assert_eq!(
            StreamFault::Code("E_STREAM_RESET").into_napi().reason,
            "E_STREAM_RESET: E_STREAM_RESET"
        );
        assert_eq!(
            StreamFault::PeerReset(42).into_napi().reason,
            "E_STREAM_RESET: stream reset by peer (code 42)"
        );
    }
}
