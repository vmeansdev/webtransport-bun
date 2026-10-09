use super::*;
use std::future::Future;
use std::pin::Pin;
use std::task::{Context, Poll, Waker};

struct Fragmented {
    bytes: Vec<u8>,
    offset: usize,
    available: usize,
}

impl AsyncRead for Fragmented {
    fn poll_read(
        mut self: Pin<&mut Self>,
        _: &mut Context<'_>,
        out: &mut [u8],
    ) -> Poll<std::io::Result<usize>> {
        if self.offset == self.available && self.offset < self.bytes.len() {
            return Poll::Pending;
        }
        let count = out.len().min(self.available - self.offset);
        out[..count].copy_from_slice(&self.bytes[self.offset..self.offset + count]);
        self.offset += count;
        Poll::Ready(Ok(count))
    }
}

type ReaderState = FrameReader;

fn complete<F: Future>(future: F) -> F::Output {
    match Box::pin(future)
        .as_mut()
        .poll(&mut Context::from_waker(Waker::noop()))
    {
        Poll::Ready(result) => result,
        Poll::Pending => panic!("fully available input must complete in one poll"),
    }
}

fn cancellation_sweep(bytes: &[u8]) {
    let expected = Frame::read(&mut &bytes[..]).unwrap().unwrap();
    for cut in 0..bytes.len() {
        let mut reader = Fragmented {
            bytes: bytes.to_vec(),
            offset: 0,
            available: cut,
        };
        let mut state = ReaderState::default();
        let mut cx = Context::from_waker(Waker::noop());
        {
            let mut future = Box::pin(state.read(&mut reader));
            assert!(future.as_mut().poll(&mut cx).is_pending(), "cut={cut}");
        }
        assert_eq!(reader.offset, cut);
        reader.available = bytes.len();
        let result = Box::pin(state.read(&mut reader)).as_mut().poll(&mut cx);
        let Poll::Ready(Ok(frame)) = result else {
            panic!("cut={cut}: {result:?}");
        };
        assert_eq!(frame.payload(), expected.payload(), "cut={cut}");
        assert_eq!(frame.session_id(), expected.session_id(), "cut={cut}");
        assert_eq!(
            format!("{:?}", frame.kind()),
            format!("{:?}", expected.kind())
        );
        assert_eq!(reader.offset, bytes.len());
    }
}

#[test]
fn data_survives_every_cancellation_boundary() {
    cancellation_sweep(&[0, 5, 0, 0x50, 1, 0, 0]);
}

#[test]
fn settings_survives_every_cancellation_boundary() {
    cancellation_sweep(&[
        0x04, 0x16, 0xc0, 0, 0, 0, 0xc6, 0x71, 0x70, 0x6a, 1, 7, 0, 8, 1, 1, 0, 0xab, 0x60, 0x37,
        0x42, 1, 0x33, 1,
    ]);
}

fn poll_read<R: AsyncRead + Unpin>(
    state: &mut FrameReader,
    reader: &mut R,
) -> Poll<Result<FrameOwned, IoReadError>> {
    Box::pin(state.read(reader))
        .as_mut()
        .poll(&mut Context::from_waker(Waker::noop()))
}

fn wire(frame: Frame<'_>) -> Vec<u8> {
    let mut bytes = Vec::new();
    frame.write(&mut bytes).unwrap();
    bytes
}

fn varint_width(value: u64, width: usize) -> Vec<u8> {
    let mut bytes = value.to_be_bytes()[8 - width..].to_vec();
    bytes[0] |= match width {
        1 => 0,
        2 => 0x40,
        4 => 0x80,
        8 => 0xc0,
        _ => unreachable!(),
    };
    bytes
}

#[test]
fn every_header_varint_width_survives_cancellation() {
    for kind_width in [1, 2, 4, 8] {
        for length_width in [1, 2, 4, 8] {
            let mut bytes = varint_width(0, kind_width);
            bytes.extend(varint_width(3, length_width));
            bytes.extend([0x50, 1, 0xff]);
            cancellation_sweep(&bytes);
        }
    }
}

#[test]
fn generated_settings_and_other_frame_kinds_survive_cancellation() {
    let settings = crate::settings::Settings::builder()
        .qpack_max_table_capacity(VarInt::from_u32(0))
        .qpack_blocked_streams(VarInt::from_u32(0))
        .enable_connect_protocol()
        .enable_webtransport()
        .enable_h3_datagrams()
        .webtransport_max_sessions(VarInt::from_u32(1))
        .build();
    cancellation_sweep(&wire(settings.generate_frame()));
    cancellation_sweep(&wire(Frame::new_headers(Cow::Borrowed(b"headers"))));
    cancellation_sweep(&wire(Frame::new_goaway(VarInt::from_u32(65536))));
    cancellation_sweep(&wire(Frame::new_exercise(
        VarInt::from_u32(0x21),
        Cow::Borrowed(b"exercise"),
    )));
    for width in [1, 2, 4, 8] {
        let mut bytes = varint_width(0x41, 2);
        bytes.extend(varint_width(4, width));
        cancellation_sweep(&bytes);
    }
}

#[test]
fn repeated_single_byte_cancellations_keep_all_progress() {
    let bytes = wire(Frame::new_headers(Cow::Owned(vec![0x50; 256])));
    let mut reader = Fragmented {
        bytes: bytes.clone(),
        offset: 0,
        available: 0,
    };
    let mut state = FrameReader::default();
    for available in 0..bytes.len() {
        reader.available = available;
        assert!(poll_read(&mut state, &mut reader).is_pending());
        assert_eq!(reader.offset, available);
    }
    reader.available = bytes.len();
    let Poll::Ready(Ok(frame)) = poll_read(&mut state, &mut reader) else {
        panic!("complete frame must be ready");
    };
    assert_eq!(frame.payload(), vec![0x50; 256]);
}

#[test]
fn consecutive_frames_are_not_overread_or_replayed() {
    let first = wire(Frame::new_data(Cow::Borrowed(b"one")));
    let second = wire(Frame::new_data(Cow::Borrowed(b"two")));
    let bytes = [first.clone(), second].concat();
    let mut reader = Fragmented {
        available: bytes.len(),
        bytes,
        offset: 0,
    };
    let mut state = FrameReader::default();
    for (payload, offset) in [(b"one", first.len()), (b"two", reader.bytes.len())] {
        let Poll::Ready(Ok(frame)) = poll_read(&mut state, &mut reader) else {
            panic!("frame must be ready");
        };
        assert_eq!(frame.payload(), payload);
        assert_eq!(reader.offset, offset);
    }
    assert!(matches!(
        poll_read(&mut state, &mut reader),
        Poll::Ready(Err(IoReadError::IO(bytes::IoReadError::ImmediateFin)))
    ));
}

#[test]
fn payload_limit_is_checked_before_body_read() {
    cancellation_sweep(&wire(Frame::new_data(Cow::Owned(vec![42; 4096]))));
    for length in [4097, u32::MAX as u64 + 1, VarInt::MAX.into_inner()] {
        let mut bytes = vec![0];
        bytes.extend(varint_width(length, 8));
        let mut reader = Fragmented {
            available: bytes.len(),
            bytes,
            offset: 0,
        };
        assert!(matches!(
            poll_read(&mut FrameReader::default(), &mut reader),
            Poll::Ready(Err(IoReadError::Parse(ParseError::PayloadTooBig)))
        ));
        assert_eq!(reader.offset, 9);
    }
    // Empty DATA must complete at its header, without an unnecessary EOF read.
    let mut reader = Fragmented {
        bytes: vec![0, 0],
        available: 2,
        offset: 0,
    };
    assert!(matches!(
        poll_read(&mut FrameReader::default(), &mut reader),
        Poll::Ready(Ok(_))
    ));
}

#[test]
fn truncated_frames_preserve_fin_classification() {
    let mut bytes = varint_width(0, 8);
    bytes.extend(varint_width(4, 8));
    bytes.extend([1, 2, 3, 4]);
    for end in 0..bytes.len() {
        let mut reader = Fragmented {
            bytes: bytes[..end].to_vec(),
            offset: 0,
            available: end,
        };
        let error = poll_read(&mut FrameReader::default(), &mut reader);
        if end == 0 {
            assert!(matches!(
                error,
                Poll::Ready(Err(IoReadError::IO(bytes::IoReadError::ImmediateFin)))
            ));
        } else {
            assert!(
                matches!(
                    error,
                    Poll::Ready(Err(IoReadError::IO(bytes::IoReadError::UnexpectedFin)))
                ),
                "end={end}: {error:?}"
            );
        }
    }
}

struct ErrorAfter {
    reader: Fragmented,
    error: std::io::ErrorKind,
}

impl AsyncRead for ErrorAfter {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        out: &mut [u8],
    ) -> Poll<std::io::Result<usize>> {
        if self.reader.offset == self.reader.bytes.len() {
            Poll::Ready(Err(self.error.into()))
        } else {
            Pin::new(&mut self.reader).poll_read(cx, out)
        }
    }
}

#[test]
fn io_errors_survive_partial_headers_and_bodies() {
    for end in 0..7 {
        for error in [
            std::io::ErrorKind::ConnectionReset,
            std::io::ErrorKind::NotConnected,
        ] {
            let mut reader = ErrorAfter {
                reader: Fragmented {
                    bytes: [0, 5, 0, 0x50, 1, 0, 0][..end].to_vec(),
                    available: end,
                    offset: 0,
                },
                error,
            };
            let result = poll_read(&mut FrameReader::default(), &mut reader);
            match error {
                std::io::ErrorKind::ConnectionReset => assert!(matches!(
                    result,
                    Poll::Ready(Err(IoReadError::IO(bytes::IoReadError::Reset)))
                )),
                _ => assert!(matches!(
                    result,
                    Poll::Ready(Err(IoReadError::IO(bytes::IoReadError::NotConnected)))
                )),
            }
        }
    }
}

#[test]
fn unknown_type_and_invalid_session_preserve_errors() {
    let mut reader = Fragmented {
        bytes: vec![2, 0, 0],
        available: 3,
        offset: 0,
    };
    let mut state = FrameReader::default();
    assert!(matches!(
        poll_read(&mut state, &mut reader),
        Poll::Ready(Err(IoReadError::Parse(ParseError::UnknownFrame)))
    ));
    assert_eq!(
        reader.offset, 1,
        "legacy unknown-frame behavior consumes only its type"
    );
    // The protocol loop deliberately continues after UnknownFrame.
    assert!(matches!(
        poll_read(&mut state, &mut reader),
        Poll::Ready(Ok(_))
    ));
    let mut reader = Fragmented {
        bytes: vec![0x40, 0x41, 1],
        available: 3,
        offset: 0,
    };
    assert!(matches!(
        poll_read(&mut state, &mut reader),
        Poll::Ready(Err(IoReadError::Parse(ParseError::InvalidSessionId)))
    ));
}

fn control_stream() -> crate::stream::uniremote::StreamUniRemoteH3 {
    let crate::stream::uniremote::MaybeUpgradeH3::H3(stream) = crate::stream::Stream::accept_uni()
        .upgrade(&mut &[0][..])
        .unwrap()
    else {
        panic!("complete control-stream header");
    };
    stream
}

fn session_stream() -> crate::stream::session::StreamSession {
    crate::stream::Stream::accept_bi()
        .upgrade()
        .into_session(crate::session::SessionRequest::new("https://localhost/").unwrap())
}

#[tokio::test]
async fn control_protocol_survives_select_cancellation_and_keeps_validation() {
    let bytes = [4, 2, 1, 0];
    for cut in 0..bytes.len() {
        let mut stream = control_stream();
        let mut state = FrameReader::default();
        let mut reader = Fragmented {
            bytes: bytes.to_vec(),
            offset: 0,
            available: cut,
        };
        // The first branch must be polled and lose after consuming exactly cut
        // bytes. There is no scheduling delay or timing assumption in this race.
        tokio::select! {
            biased;
            result = stream.read_frame_async_with(&mut reader, &mut state) => panic!("unexpected completion: {result:?}"),
            () = std::future::ready(()) => {}
        }
        assert_eq!(reader.offset, cut);
        reader.available = bytes.len();
        let frame = complete(stream.read_frame_async_with(&mut reader, &mut state)).unwrap();
        assert!(matches!(frame.kind(), FrameKind::Settings));
        assert_eq!(frame.payload(), &[1, 0]);
        // DATA remains forbidden on the control stream. Duplicate SETTINGS is
        // enforced by RemoteSettingsStream, not by this protocol wrapper.
        let mut wrong = Fragmented {
            bytes: vec![0, 0],
            offset: 0,
            available: 2,
        };
        let result = complete(stream.read_frame_async_with(&mut wrong, &mut state));
        assert!(matches!(
            result,
            Err(crate::stream::IoReadError::H3(
                crate::error::ErrorCode::FrameUnexpected
            ))
        ));
    }
}

#[tokio::test]
async fn connect_protocol_survives_repeated_select_cancellation() {
    let stream = session_stream();
    let mut state = FrameReader::default();
    let bytes = [0, 5, 0, 0x50, 1, 0, 0];
    let mut reader = Fragmented {
        bytes: bytes.to_vec(),
        offset: 0,
        available: 0,
    };
    for cut in 0..bytes.len() {
        reader.available = cut;
        tokio::select! {
            biased;
            result = stream.read_frame_async_with(&mut reader, &mut state) => panic!("unexpected completion: {result:?}"),
            () = std::future::ready(()) => {}
        }
        assert_eq!(reader.offset, cut);
    }
    reader.available = bytes.len();
    let frame = complete(stream.read_frame_async_with(&mut reader, &mut state)).unwrap();
    assert!(matches!(frame.kind(), FrameKind::Data));
    assert_eq!(frame.payload(), &bytes[2..]);
    let mut wrong = Fragmented {
        bytes: vec![4, 0],
        offset: 0,
        available: 2,
    };
    assert!(matches!(
        complete(stream.read_frame_async_with(&mut wrong, &mut state)),
        Err(crate::stream::IoReadError::H3(
            crate::error::ErrorCode::FrameUnexpected
        ))
    ));
}

#[tokio::test]
async fn protocol_fin_and_oversize_mapping_is_unchanged() {
    use crate::error::ErrorCode;
    use crate::stream::IoReadError as StreamError;
    for (bytes, expected) in [
        (vec![], "ImmediateFin"),
        (vec![0], "Frame"),
        (vec![0, 0x50, 1], "ExcessiveLoad"),
    ] {
        let mut reader = Fragmented {
            available: bytes.len(),
            bytes: bytes.clone(),
            offset: 0,
        };
        let result = complete(
            session_stream().read_frame_async_with(&mut reader, &mut FrameReader::default()),
        );
        match expected {
            "ImmediateFin" => assert!(matches!(
                result,
                Err(StreamError::IO(bytes::IoReadError::ImmediateFin))
            )),
            "Frame" => assert!(matches!(result, Err(StreamError::H3(ErrorCode::Frame)))),
            _ => assert!(matches!(
                result,
                Err(StreamError::H3(ErrorCode::ExcessiveLoad))
            )),
        }
        let mut reader = Fragmented {
            available: bytes.len(),
            bytes,
            offset: 0,
        };
        let result = complete(
            control_stream().read_frame_async_with(&mut reader, &mut FrameReader::default()),
        );
        match expected {
            "ImmediateFin" => assert!(matches!(
                result,
                Err(StreamError::IO(bytes::IoReadError::ImmediateFin))
            )),
            "Frame" => assert!(matches!(result, Err(StreamError::H3(ErrorCode::Frame)))),
            _ => assert!(matches!(
                result,
                Err(StreamError::H3(ErrorCode::ExcessiveLoad))
            )),
        }
    }
}
