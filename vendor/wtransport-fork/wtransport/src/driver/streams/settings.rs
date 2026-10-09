use crate::driver::streams::unilocal::StreamUniLocalH3;
use crate::driver::streams::uniremote::StreamUniRemoteH3;
use crate::driver::streams::ProtoReadError;
use crate::driver::streams::ProtoWriteError;
use crate::driver::DriverError;
use crate::error::StreamWriteError;
use crate::VarInt;
use std::future::pending;
use std::sync::Arc;
use tokio::sync::watch;
use tracing::debug;
use wtransport_proto::bytes;
use wtransport_proto::error::ErrorCode;
use wtransport_proto::frame::Frame;
use wtransport_proto::frame::FrameKind;
use wtransport_proto::settings::Settings;
use wtransport_proto::stream_header::StreamKind;

pub struct LocalSettingsStream {
    stream: Option<StreamUniLocalH3>,
    settings: Settings,
}

impl LocalSettingsStream {
    /// Builds the local settings, offering the peer a QPACK dynamic table of
    /// `qpack_max_table_capacity` bytes.
    ///
    /// `SETTINGS_QPACK_BLOCKED_STREAMS` is always zero: this endpoint decodes field
    /// sections as they arrive and never parks one waiting for an insert, so a peer
    /// must only reference entries it knows have been received.
    pub fn empty(qpack_max_table_capacity: u64) -> Self {
        let settings = Settings::builder()
            .qpack_max_table_capacity(
                VarInt::try_from_u64(qpack_max_table_capacity).unwrap_or(VarInt::MAX),
            )
            .qpack_blocked_streams(VarInt::from_u32(0))
            .enable_connect_protocol() // TODO(biagio): it would be nice to have this only for server
            .enable_webtransport()
            .enable_h3_datagrams()
            .webtransport_max_sessions(VarInt::from_u32(1))
            .build();

        Self {
            stream: None,
            settings,
        }
    }

    pub fn is_empty(&self) -> bool {
        self.stream.is_none()
    }

    pub fn set_stream(&mut self, stream: StreamUniLocalH3) {
        assert!(matches!(stream.kind(), StreamKind::Control));
        self.stream = Some(stream);
    }

    /// Tells the peer not to expect anything past `id` to be processed.
    pub async fn send_goaway(&mut self, id: VarInt) -> Result<(), DriverError> {
        let stream = self.stream.as_mut().expect("Cannot write on empty stream");
        Self::write_frame(stream, Frame::new_goaway(id)).await
    }

    pub async fn send_settings(&mut self) -> Result<(), DriverError> {
        let stream = self.stream.as_mut().expect("Cannot write on empty stream");
        Self::write_frame(stream, self.settings.generate_frame()).await
    }

    async fn write_frame(
        stream: &mut StreamUniLocalH3,
        frame: Frame<'_>,
    ) -> Result<(), DriverError> {
        match stream.write_frame(frame).await {
            Ok(()) => Ok(()),
            Err(ProtoWriteError::NotConnected) => Err(DriverError::NotConnected),
            Err(ProtoWriteError::Stopped) => {
                Err(DriverError::Proto(ErrorCode::ClosedCriticalStream))
            }
        }
    }

    pub async fn run(&mut self) -> DriverError {
        match self.stream.as_mut() {
            Some(stream) => match stream.stopped().await {
                StreamWriteError::NotConnected => DriverError::NotConnected,
                StreamWriteError::Closed | StreamWriteError::Stopped(_) => {
                    DriverError::Proto(ErrorCode::ClosedCriticalStream)
                }
                StreamWriteError::QuicProto => DriverError::Proto(ErrorCode::ClosedCriticalStream),
            },
            None => pending().await,
        }
    }
}

pub struct RemoteSettingsStream {
    stream: Option<StreamUniRemoteH3>,
    frame_reader: wtransport_proto::frame::FrameReader,
    settings: watch::Sender<Option<Settings>>,
    draining: Arc<watch::Sender<bool>>,
    goaway_id: Arc<watch::Sender<Option<VarInt>>>,
}

impl RemoteSettingsStream {
    pub fn empty(
        draining: Arc<watch::Sender<bool>>,
        goaway_id: Arc<watch::Sender<Option<VarInt>>>,
    ) -> Self {
        Self {
            stream: None,
            settings: watch::channel(None).0,
            frame_reader: wtransport_proto::frame::FrameReader::default(),
            draining,
            goaway_id,
        }
    }

    pub fn is_empty(&self) -> bool {
        self.stream.is_none()
    }

    pub fn set_stream(&mut self, stream: StreamUniRemoteH3) {
        assert!(matches!(stream.kind(), StreamKind::Control));
        self.frame_reader = wtransport_proto::frame::FrameReader::default();
        self.stream = Some(stream);
    }

    pub fn subscribe(&self) -> RemoteSettingsWatcher {
        RemoteSettingsWatcher(self.settings.subscribe())
    }

    pub async fn run(&mut self) -> DriverError {
        loop {
            let frame = match self.read_frame().await {
                Ok(frame) => frame,
                Err(driver_error) => return driver_error,
            };

            if self.settings.borrow().is_none() {
                if !matches!(frame.kind(), FrameKind::Settings) {
                    return DriverError::Proto(ErrorCode::MissingSettings);
                }

                let settings = match Settings::with_frame(&frame) {
                    Ok(settings) => settings,
                    Err(error_code) => return DriverError::Proto(error_code),
                };

                self.settings.send_replace(Some(settings));
            } else if matches!(frame.kind(), FrameKind::Goaway) {
                // The peer will not take on new sessions. The ones already running are
                // unaffected, so this is a notification rather than a failure.
                let id = frame.goaway_id();
                debug!("Peer sent GOAWAY (id: {:?})", id);

                // RFC 9114 section 5.2: a repeated GOAWAY may only shrink the range of
                // requests the peer is still willing to handle. Raising the identifier
                // would take back a promise already made about what went unprocessed.
                if let (Some(id), Some(previous)) = (id, *self.goaway_id.borrow()) {
                    if id > previous {
                        return DriverError::Proto(ErrorCode::Id);
                    }
                }

                self.goaway_id.send_replace(id);
                self.draining.send_replace(true);
            } else if !matches!(frame.kind(), FrameKind::Exercise(_)) {
                return DriverError::Proto(ErrorCode::FrameUnexpected);
            }
        }
    }

    async fn read_frame<'a>(&mut self) -> Result<Frame<'a>, DriverError> {
        let Some(stream) = self.stream.as_mut() else {
            return pending().await;
        };

        match stream.read_frame_with(&mut self.frame_reader).await {
            Ok(frame) => Ok(frame),
            Err(ProtoReadError::H3(error_code)) => Err(DriverError::Proto(error_code)),
            Err(ProtoReadError::IO(io_error)) => match io_error {
                bytes::IoReadError::ImmediateFin
                | bytes::IoReadError::UnexpectedFin
                | bytes::IoReadError::Reset => {
                    Err(DriverError::Proto(ErrorCode::ClosedCriticalStream))
                }
                bytes::IoReadError::NotConnected => Err(DriverError::NotConnected),
            },
        }
    }
}

pub struct RemoteSettingsWatcher(watch::Receiver<Option<Settings>>);

impl RemoteSettingsWatcher {
    pub async fn accept_settings(&mut self) -> Option<Settings> {
        self.0.changed().await.ok()?;

        Some(
            self.0
                .borrow()
                .clone()
                .expect("On change settings must be set"),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wtransport_proto::settings::SettingId;

    #[cfg(all(feature = "self-signed", feature = "dangerous-configuration"))]
    #[tokio::test]
    async fn replacement_discards_partial_settings_frame_state() {
        use crate::driver::streams::test_support::{bounded, pair, partial};
        use crate::driver::streams::uniremote::StreamUniRemoteQuic;
        let (_server, _client, server, client) = pair().await;
        bounded(async {
            let mut sender = client.open_uni().await.unwrap();
            // Control stream header followed by a complete SETTINGS frame.
            sender.write_all(&[0, 4, 2, 1, 0]).await.unwrap();
            let stream = StreamUniRemoteQuic::accept_uni(&server).await.unwrap().upgrade().await.unwrap();
            let mut owner = RemoteSettingsStream::empty(Arc::new(watch::channel(false).0), Arc::new(watch::channel(None).0));
            partial(&mut owner.frame_reader, &[4, 2, 1]);
            owner.set_stream(stream);
            let mut watcher = owner.subscribe();
            tokio::select! {
                error = owner.run() => panic!("SETTINGS unexpectedly ended: {error:?}"),
                settings = watcher.accept_settings() => assert_eq!(settings.unwrap().get(SettingId::QPackMaxTableCapacity), Some(VarInt::from_u32(0))),
            }
            // Cancelling run after publication must not reset the protocol's
            // duplicate-SETTINGS validation.
            sender.write_all(&[4, 0]).await.unwrap();
            assert!(matches!(owner.run().await, DriverError::Proto(ErrorCode::FrameUnexpected)));
        }).await;
    }

    #[test]
    fn local_settings_advertise_the_configured_qpack_capacity() {
        let stream = LocalSettingsStream::empty(4096);

        assert_eq!(
            stream.settings.get(SettingId::QPackMaxTableCapacity),
            Some(VarInt::from_u32(4096))
        );

        // Blocked streams is never offered: a section that cannot be decoded on
        // arrival is a connection error, not something to park.
        assert_eq!(
            stream.settings.get(SettingId::QPackBlockedStreams),
            Some(VarInt::from_u32(0))
        );
    }

    #[test]
    fn local_settings_disable_the_dynamic_table_by_default() {
        let stream = LocalSettingsStream::empty(0);

        assert_eq!(
            stream.settings.get(SettingId::QPackMaxTableCapacity),
            Some(VarInt::from_u32(0))
        );
    }
}
