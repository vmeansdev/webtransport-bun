use crate::capsule::Capsule;
use crate::capsule::CapsuleKind;
use crate::error::ErrorCode;
use crate::varint::VarInt;
use std::borrow::Cow;

/// Maximum length, in bytes, of a session close reason.
pub const MAX_REASON_LEN: usize = 1024;

/// Capsules for WebTransport session termination.
#[derive(Debug)]
pub struct CloseWebTransportSession {
    error_code: u32,
    reason: String,
}

impl CloseWebTransportSession {
    /// Creates a capsule closing a session with `error_code` and `reason`.
    ///
    /// A reason longer than [`MAX_REASON_LEN`] is truncated on a character
    /// boundary, as required when sending.
    pub fn new(error_code: u32, reason: &str) -> Self {
        let mut length = reason.len().min(MAX_REASON_LEN);

        while !reason.is_char_boundary(length) {
            length -= 1;
        }

        Self {
            error_code,
            reason: reason[..length].to_string(),
        }
    }

    /// Parses from [`Capsule`].
    ///
    /// # Panics
    ///
    /// Panics if `capsule` is not
    /// [`CloseWebTransportSession`](CapsuleKind::CloseWebtransportsession) type.
    pub fn with_capsule(capsule: &Capsule) -> Result<Self, ErrorCode> {
        assert!(matches!(
            capsule.kind(),
            CapsuleKind::CloseWebTransportSession
        ));

        let payload = capsule.payload();

        if payload.len() < 4 || payload.len() > 4 + MAX_REASON_LEN {
            return Err(ErrorCode::Datagram);
        }

        let error_code =
            u32::from_be_bytes(payload[..4].try_into().expect("4B to u32 should succeed"));
        let reason = std::str::from_utf8(&payload[4..])
            .map_err(|_| ErrorCode::Datagram)?
            .to_string();

        Ok(Self { error_code, reason })
    }

    /// Builds the [`Capsule`] carrying this session close.
    pub fn to_capsule(&self) -> Capsule<'static> {
        let mut payload = Vec::with_capacity(4 + self.reason.len());
        payload.extend_from_slice(&self.error_code.to_be_bytes());
        payload.extend_from_slice(self.reason.as_bytes());

        Capsule::new(CapsuleKind::CloseWebTransportSession, Cow::Owned(payload))
    }

    /// Returns the error code sent over this capsule.
    pub fn error_code(&self) -> VarInt {
        VarInt::from_u32(self.error_code)
    }

    /// Returns the reason sent over this capsule.
    pub fn reason(&self) -> &str {
        &self.reason
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn round_trip(error_code: u32, reason: &str) -> CloseWebTransportSession {
        let frame = CloseWebTransportSession::new(error_code, reason)
            .to_capsule()
            .into_frame();

        let capsule = Capsule::with_frame(&frame).expect("Should parse capsule");

        CloseWebTransportSession::with_capsule(&capsule).expect("Should parse close")
    }

    #[test]
    fn round_trip_preserves_code_and_reason() {
        let close = round_trip(0xdead_beef, "goodbye");
        assert_eq!(close.error_code(), VarInt::from_u32(0xdead_beef));
        assert_eq!(close.reason(), "goodbye");
    }

    #[test]
    fn round_trip_empty_reason() {
        let close = round_trip(0, "");
        assert_eq!(close.error_code(), VarInt::from_u32(0));
        assert_eq!(close.reason(), "");
    }

    #[test]
    fn round_trip_maximum_reason() {
        let reason = "a".repeat(MAX_REASON_LEN);
        let close = round_trip(1, &reason);
        assert_eq!(close.reason().len(), MAX_REASON_LEN);
        assert_eq!(close.reason(), reason);
    }

    #[test]
    fn over_long_reason_is_truncated_on_a_character_boundary() {
        // A three-byte character straddling the limit must be dropped whole.
        let reason = format!("{}{}", "a".repeat(MAX_REASON_LEN - 1), "€");
        let close = CloseWebTransportSession::new(7, &reason);

        assert_eq!(close.reason().len(), MAX_REASON_LEN - 1);
        assert!(close.reason().chars().all(|c| c == 'a'));

        let parsed = round_trip(7, &reason);
        assert_eq!(parsed.reason(), close.reason());
    }

    #[test]
    fn multi_byte_reason_survives_intact() {
        let reason = "セッションを閉じます";
        assert_eq!(round_trip(42, reason).reason(), reason);
    }

    #[test]
    fn parse_rejects_an_over_long_reason() {
        let mut payload = vec![0u8; 4];
        payload.extend(std::iter::repeat_n(b'a', MAX_REASON_LEN + 1));

        let frame =
            Capsule::new(CapsuleKind::CloseWebTransportSession, Cow::Owned(payload)).into_frame();
        let capsule = Capsule::with_frame(&frame).expect("Should parse capsule");

        assert!(CloseWebTransportSession::with_capsule(&capsule).is_err());
    }

    #[test]
    fn parse_rejects_invalid_utf8() {
        let payload = vec![0, 0, 0, 0, 0xff, 0xfe];

        let frame =
            Capsule::new(CapsuleKind::CloseWebTransportSession, Cow::Owned(payload)).into_frame();
        let capsule = Capsule::with_frame(&frame).expect("Should parse capsule");

        assert!(CloseWebTransportSession::with_capsule(&capsule).is_err());
    }
}
