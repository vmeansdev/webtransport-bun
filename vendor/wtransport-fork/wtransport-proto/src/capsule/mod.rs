use crate::bytes::BytesReader;
use crate::bytes::BytesWriter;
use crate::bytes::EndOfBuffer;
use crate::frame::Frame;
use crate::frame::FrameKind;
use crate::frame::FrameOwned;
use crate::varint::VarInt;
use std::borrow::Cow;

/// An HTTP3 [`Capsule`] type.
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum CapsuleKind {
    /// Close WebTransport Capsule type.
    CloseWebTransportSession,

    /// Drain WebTransport Capsule type.
    DrainWebTransportSession,
}

impl CapsuleKind {
    const fn parse(id: VarInt) -> Option<Self> {
        match id {
            capsule_types::CAPSULE_TYPE_CLOSE_WEBTRANSPORT_SESSION => {
                Some(CapsuleKind::CloseWebTransportSession)
            }
            capsule_types::CAPSULE_TYPE_DRAIN_WEBTRANSPORT_SESSION => {
                Some(CapsuleKind::DrainWebTransportSession)
            }
            _ => None,
        }
    }

    /// The capsule type identifier on the wire.
    pub const fn id(self) -> VarInt {
        match self {
            CapsuleKind::CloseWebTransportSession => {
                capsule_types::CAPSULE_TYPE_CLOSE_WEBTRANSPORT_SESSION
            }
            CapsuleKind::DrainWebTransportSession => {
                capsule_types::CAPSULE_TYPE_DRAIN_WEBTRANSPORT_SESSION
            }
        }
    }
}

/// An HTTP3 Capsule.
#[derive(Debug)]
pub struct Capsule<'a> {
    kind: CapsuleKind,
    payload: Cow<'a, [u8]>,
}

impl<'a> Capsule<'a> {
    /// Creates a capsule of the given `kind` carrying `payload`.
    pub fn new(kind: CapsuleKind, payload: Cow<'a, [u8]>) -> Self {
        Self { kind, payload }
    }

    /// Parses a capsule from an HTTP3 frame.
    ///
    /// # Panics
    ///
    /// Panics if `frame` is not [`Data`](`FrameKind::Data`) type.
    pub fn with_frame(frame: &'a Frame<'a>) -> Option<Self> {
        assert!(matches!(frame.kind(), FrameKind::Data));

        let mut payload = frame.payload();
        let kind = CapsuleKind::parse(payload.get_varint()?)?;
        let payload_length = payload.get_varint()?;
        let payload = payload.get_bytes(payload_length.into_inner() as usize)?;

        Some(Self {
            kind,
            payload: Cow::Borrowed(payload),
        })
    }

    /// The [`CapsuleKind`] of this capsule.
    pub fn kind(&self) -> CapsuleKind {
        self.kind
    }

    /// Returns the payload of this `Capsule`.
    pub fn payload(&self) -> &[u8] {
        &self.payload
    }

    /// Writes this capsule into a [`BytesWriter`].
    ///
    /// It returns [`Err`] if `bytes_writer` does not have enough capacity; see
    /// [`Self::write_size`]. In that case `bytes_writer` might be partially written.
    pub fn write<W>(&self, bytes_writer: &mut W) -> Result<(), EndOfBuffer>
    where
        W: BytesWriter,
    {
        bytes_writer.put_varint(self.kind.id())?;
        bytes_writer.put_varint(self.payload_length())?;
        bytes_writer.put_bytes(&self.payload)?;

        Ok(())
    }

    /// Returns the capacity needed to write this capsule.
    pub fn write_size(&self) -> usize {
        self.kind.id().size() + self.payload_length().size() + self.payload.len()
    }

    /// Wraps this capsule into the HTTP3 `DATA` frame that carries it.
    pub fn into_frame(self) -> FrameOwned {
        let mut payload = Vec::with_capacity(self.write_size());

        self.write(&mut payload)
            .expect("a vector always has capacity");

        Frame::new_data(Cow::Owned(payload))
    }

    fn payload_length(&self) -> VarInt {
        VarInt::try_from(self.payload.len() as u64).expect("capsule payload fits a varint")
    }
}

mod capsule_types {
    use crate::varint::VarInt;

    pub const CAPSULE_TYPE_CLOSE_WEBTRANSPORT_SESSION: VarInt = VarInt::from_u32(0x2843);
    pub const CAPSULE_TYPE_DRAIN_WEBTRANSPORT_SESSION: VarInt = VarInt::from_u32(0x78ae);
}

/// Capsules types implementations.
pub mod capsules {
    pub use super::close_wt_session::CloseWebTransportSession;
    pub use super::close_wt_session::MAX_REASON_LEN;
    pub use super::drain_wt_session::DrainWebTransportSession;
}

mod close_wt_session;
mod drain_wt_session;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capsule_close_wt_session() {
        let frame = Frame::new_data(vec![104, 67, 4, 0, 0, 0, 0u8].into());
        let capsule = Capsule::with_frame(&frame).unwrap();
        let close =
            capsules::CloseWebTransportSession::with_capsule(&capsule).expect("Should parse");
        assert_eq!(close.error_code(), VarInt::from_u32(0));
        assert_eq!(close.reason(), "");
    }

    #[test]
    fn write_matches_the_legacy_parse_vector() {
        let capsule = Capsule::new(
            CapsuleKind::CloseWebTransportSession,
            Cow::Owned(vec![0, 0, 0, 0]),
        );

        let mut encoded = Vec::new();
        capsule.write(&mut encoded).unwrap();

        assert_eq!(encoded, vec![104, 67, 4, 0, 0, 0, 0u8]);
        assert_eq!(capsule.write_size(), encoded.len());
    }

    #[test]
    fn frame_round_trip() {
        let frame = Capsule::new(
            CapsuleKind::DrainWebTransportSession,
            Cow::Owned(Vec::new()),
        )
        .into_frame();

        let capsule = Capsule::with_frame(&frame).expect("Should parse");

        assert_eq!(capsule.kind(), CapsuleKind::DrainWebTransportSession);
        assert!(capsule.payload().is_empty());
    }
}
