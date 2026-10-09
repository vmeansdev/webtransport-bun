use tracing::debug;
use wtransport_proto::bytes::IoReadError;
use wtransport_proto::capsule::capsules;
use wtransport_proto::capsule::Capsule;
use wtransport_proto::capsule::{self};
use wtransport_proto::error::ErrorCode;
use wtransport_proto::frame::FrameKind;
use wtransport_proto::varint::VarInt;

use super::session::StreamSession;
use super::ProtoReadError;
use crate::driver::DriverError;
use crate::error::ApplicationClose;
use std::future::pending;
use std::sync::Arc;
use tokio::sync::watch;

pub struct ConnectStream {
    stream: Option<StreamSession>,
    frame_reader: wtransport_proto::frame::FrameReader,
    draining: Arc<watch::Sender<bool>>,
}

#[cfg(all(test, feature = "self-signed", feature = "dangerous-configuration"))]
mod tests {
    use super::*;
    use crate::driver::streams::test_support::{bounded, pair, partial, session};

    #[tokio::test]
    async fn replacement_discards_partial_connect_frame_state() {
        let (_server, _client, server, client) = pair().await;
        bounded(async {
            let (mut sender, _receiver) = client.open_bi().await.unwrap();
            // DATA containing CLOSE_WEBTRANSPORT_SESSION(code=42, reason="ok").
            sender
                .write_all(&[0, 9, 0x68, 0x43, 6, 0, 0, 0, 42, b'o', b'k'])
                .await
                .unwrap();
            let (send, recv) = server.accept_bi().await.unwrap();
            let mut owner = ConnectStream::empty(Arc::new(watch::channel(false).0));
            partial(&mut owner.frame_reader, &[0, 5, 0]);
            owner.set_stream(session(send, recv));
            match owner.run().await {
                DriverError::ApplicationClosed(close) => {
                    assert_eq!(close.code(), VarInt::from_u32(42));
                    assert_eq!(close.reason(), b"ok");
                }
                error => panic!("expected close capsule: {error:?}"),
            }
        })
        .await;
    }
}

impl ConnectStream {
    pub fn empty(draining: Arc<watch::Sender<bool>>) -> Self {
        Self {
            stream: None,
            frame_reader: wtransport_proto::frame::FrameReader::default(),
            draining,
        }
    }

    pub fn is_empty(&self) -> bool {
        self.stream.is_none()
    }

    pub fn set_stream(&mut self, stream: StreamSession) {
        self.frame_reader = wtransport_proto::frame::FrameReader::default();
        self.stream = Some(stream);
    }

    pub fn stream_mut(&mut self) -> Option<&mut StreamSession> {
        self.stream.as_mut()
    }

    pub async fn run(&mut self) -> DriverError {
        let stream = match self.stream.as_mut() {
            Some(stream) => stream,
            None => pending().await,
        };

        loop {
            return match stream.read_frame_with(&mut self.frame_reader).await {
                Ok(frame) => {
                    if !matches!(frame.kind(), FrameKind::Data) {
                        debug!("Skipping non-data frame of kind {:?}", frame.kind());
                        continue;
                    }

                    let Some(capsule) = Capsule::with_frame(&frame) else {
                        debug!("Unknown capsule of {}B", frame.payload().len());
                        continue;
                    };

                    if matches!(
                        capsule.kind(),
                        capsule::CapsuleKind::DrainWebTransportSession
                    ) {
                        // Draining says the session is going away soon, not that it has:
                        // everything already open stays usable.
                        debug!("Peer is draining the session");
                        self.draining.send_replace(true);
                        continue;
                    }

                    let close_session =
                        match capsules::CloseWebTransportSession::with_capsule(&capsule) {
                            Ok(close_session) => close_session,
                            Err(error_code) => return DriverError::Proto(error_code),
                        };

                    // reset right away to avoid receiving additional data which requires resetting with ErrorCode::Message.
                    self.stream
                        .take()
                        .unwrap()
                        .reset(ErrorCode::NoError.to_code());

                    DriverError::ApplicationClosed(ApplicationClose::new(
                        close_session.error_code(),
                        close_session
                            .reason()
                            .as_bytes()
                            .to_vec()
                            .into_boxed_slice(),
                    ))
                }
                Err(ProtoReadError::H3(error_code)) => DriverError::Proto(error_code),
                Err(ProtoReadError::IO(io_error)) => match io_error {
                    // Cleanly terminating a CONNECT stream without a CLOSE_WEBTRANSPORT_SESSION
                    // capsule SHALL be semantically equivalent to terminating it with a
                    // CLOSE_WEBTRANSPORT_SESSION capsule that has an error code of 0 and an empty error string.
                    IoReadError::ImmediateFin => DriverError::ApplicationClosed(
                        ApplicationClose::new(VarInt::from_u32(0), Box::new([])),
                    ),
                    IoReadError::UnexpectedFin | IoReadError::Reset => {
                        DriverError::Proto(ErrorCode::ClosedCriticalStream)
                    }
                    IoReadError::NotConnected => DriverError::NotConnected,
                },
            };
        }
    }
}
