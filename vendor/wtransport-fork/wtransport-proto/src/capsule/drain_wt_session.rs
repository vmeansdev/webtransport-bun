use crate::capsule::Capsule;
use crate::capsule::CapsuleKind;
use std::borrow::Cow;

/// Capsule announcing that a WebTransport session is being drained.
///
/// A drained session stays usable; the peer is being told not to rely on it for
/// much longer and to avoid opening new streams on it.
#[derive(Debug, Default, Copy, Clone, Eq, PartialEq)]
pub struct DrainWebTransportSession;

impl DrainWebTransportSession {
    /// Creates the capsule payload.
    pub const fn new() -> Self {
        Self
    }

    /// Parses from [`Capsule`].
    ///
    /// # Panics
    ///
    /// Panics if `capsule` is not
    /// [`DrainWebTransportSession`](CapsuleKind::DrainWebTransportSession) type.
    pub fn with_capsule(capsule: &Capsule) -> Self {
        assert!(matches!(
            capsule.kind(),
            CapsuleKind::DrainWebTransportSession
        ));

        // The capsule carries no payload; anything present is ignored so that a
        // future revision can extend it without breaking this parser.
        Self
    }

    /// Builds the [`Capsule`] carrying this drain notification.
    pub fn to_capsule(&self) -> Capsule<'static> {
        Capsule::new(
            CapsuleKind::DrainWebTransportSession,
            Cow::Owned(Vec::new()),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip() {
        let frame = DrainWebTransportSession::new().to_capsule().into_frame();
        let capsule = Capsule::with_frame(&frame).expect("Should parse capsule");

        assert_eq!(capsule.kind(), CapsuleKind::DrainWebTransportSession);
        assert_eq!(
            DrainWebTransportSession::with_capsule(&capsule),
            DrainWebTransportSession
        );
    }

    #[test]
    fn encoding_is_the_registered_capsule_type() {
        let mut encoded = Vec::new();
        DrainWebTransportSession::new()
            .to_capsule()
            .write(&mut encoded)
            .unwrap();

        // 0x78ae as a four-byte varint, then a zero-length payload.
        assert_eq!(encoded, vec![0x80, 0x00, 0x78, 0xae, 0x00]);
    }
}
