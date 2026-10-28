use crate::config::MAX_QPACK_TABLE_CAPACITY;
use crate::datagram::Datagram;
use crate::driver::streams::biremote::StreamBiRemoteH3;
use crate::driver::streams::biremote::StreamBiRemoteWT;
use crate::driver::streams::session::StreamSession;
use crate::driver::streams::uniremote::StreamUniRemoteWT;
use crate::driver::streams::Stream;
use crate::driver::utils::bichannel;
use crate::driver::utils::shared_result;
use crate::driver::utils::SendError;
use crate::driver::utils::SharedResultGet;
use crate::driver::utils::SharedResultSet;
use crate::error::ApplicationClose;
use crate::error::SendDatagramError;
use crate::stream::OpeningBiStream;
use crate::stream::OpeningUniStream;
use crate::zerortt::ZeroRtt;
use crate::SessionId;
use crate::VarInt;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::sync::OnceLock;
use tokio::sync::mpsc;
use tokio::sync::watch;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tracing::debug;
use tracing::debug_span;
use tracing::instrument;
use tracing::trace;
use tracing::Instrument;
use utils::BiChannelEndpoint;

static PUMPS_SPAWNED: AtomicU64 = AtomicU64::new(0);
static PUMPS_LIVE: AtomicU64 = AtomicU64::new(0);

/// Decrements the live-pump gauge when a pump task ends or is aborted.
struct PumpLiveGuard;

impl Drop for PumpLiveGuard {
    fn drop(&mut self) {
        PUMPS_LIVE.fetch_sub(1, Ordering::Relaxed);
    }
}

/// Whether drivers read datagrams in a dedicated task (the default) or inline in
/// the driver's select loop (`WTRANSPORT_DATAGRAM_PUMP=0`). Read once per process.
fn datagram_pump_enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| std::env::var("WTRANSPORT_DATAGRAM_PUMP").as_deref() != Ok("0"))
}

/// Which datagram read path this process's drivers use, and how many pump tasks
/// were spawned and are still running.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DatagramDriverStats {
    /// `true` when datagrams are read by a dedicated per-connection task.
    pub pump: bool,
    /// Pump tasks spawned since process start (restarts included).
    pub pumps_spawned: u64,
    /// Pump tasks currently alive.
    pub pumps_live: u64,
}

/// Effective datagram read path and pump task counters for this process.
pub fn datagram_driver_stats() -> DatagramDriverStats {
    DatagramDriverStats {
        pump: datagram_pump_enabled(),
        pumps_spawned: PUMPS_SPAWNED.load(Ordering::Relaxed),
        pumps_live: PUMPS_LIVE.load(Ordering::Relaxed),
    }
}
use wtransport_proto::error::ErrorCode;
use wtransport_proto::frame::Frame;
use wtransport_proto::session::SessionRequest;
use wtransport_proto::settings::Settings;

#[derive(Clone, Debug)]
pub enum DriverError {
    Proto(ErrorCode),
    ApplicationClosed(ApplicationClose),
    LocallyClosed,
    NotConnected,
}

/// Something the application asked the driver to send on the session's behalf.
#[derive(Debug)]
pub enum SessionCommand {
    /// Terminate the session, telling the peer why.
    Close { error_code: u32, reason: String },

    /// Tell the peer the session is going away soon, without ending it.
    Drain,

    /// Tell the peer not to open any further session on this connection.
    GoAway,
}

#[derive(Debug)]
pub struct Driver {
    quic_connection: quinn::Connection,
    qpack_decoder_state: qpack::QpackDecoderState,
    qpack_encoder_state: qpack::QpackEncoderState,
    ready_settings: Mutex<(mpsc::Receiver<Settings>, Option<Settings>)>,
    ready_sessions: BiChannelEndpoint<StreamSession>,
    ready_uni_wt_streams: Mutex<mpsc::Receiver<StreamUniRemoteWT>>,
    ready_bi_wt_streams: Mutex<mpsc::Receiver<StreamBiRemoteWT>>,
    ready_datagrams: Mutex<mpsc::Receiver<Datagram>>,
    session_commands: mpsc::Sender<SessionCommand>,
    draining: watch::Receiver<bool>,
    peer_goaway_id: watch::Receiver<Option<VarInt>>,
    driver_result: SharedResultGet<DriverError>,
    _worker: JoinHandle<()>,
}

impl Driver {
    pub fn init(
        quic_connection: quinn::Connection,
        zero_rtt: ZeroRtt,
        qpack_max_table_capacity: u64,
    ) -> Self {
        let ready_settings = mpsc::channel(1);
        let ready_sessions = bichannel(1);
        let ready_uni_wt_streams = mpsc::channel(4);
        let ready_bi_wt_streams = mpsc::channel(1);
        let ready_datagrams = mpsc::channel(1);
        let session_commands = mpsc::channel(4);
        let draining = Arc::new(watch::channel(false).0);
        let peer_goaway_id = Arc::new(watch::channel(None).0);
        let driver_result = shared_result();
        let (qpack_decoder_state, qpack_decoder_instructions) =
            qpack::QpackDecoderState::new(qpack_max_table_capacity);
        let (qpack_encoder_state, qpack_encoder_instructions) = qpack::QpackEncoderState::new();

        let worker = tokio::spawn(
            worker::Worker::new(
                quic_connection.clone(),
                worker::Ready {
                    settings: ready_settings.0,
                    sessions: ready_sessions.0,
                    uni_wt_streams: ready_uni_wt_streams.0,
                    bi_wt_streams: ready_bi_wt_streams.0,
                    datagrams: ready_datagrams.0,
                },
                session_commands.1,
                worker::Draining {
                    notified: Arc::clone(&draining),
                    goaway_id: Arc::clone(&peer_goaway_id),
                },
                driver_result.0,
                zero_rtt,
                worker::Qpack {
                    max_table_capacity: qpack_max_table_capacity,
                    decoder_state: qpack_decoder_state.clone(),
                    decoder_instructions: qpack_decoder_instructions,
                    encoder_state: qpack_encoder_state.clone(),
                    encoder_instructions: qpack_encoder_instructions,
                },
            )
            .run()
            .instrument(debug_span!("Driver", quic_id = quic_connection.stable_id())),
        );

        Self {
            quic_connection,
            qpack_decoder_state,
            qpack_encoder_state,
            ready_settings: Mutex::new((ready_settings.1, None)),
            ready_sessions: ready_sessions.1,
            ready_uni_wt_streams: Mutex::new(ready_uni_wt_streams.1),
            ready_bi_wt_streams: Mutex::new(ready_bi_wt_streams.1),
            ready_datagrams: Mutex::new(ready_datagrams.1),
            session_commands: session_commands.0,
            draining: draining.subscribe(),
            peer_goaway_id: peer_goaway_id.subscribe(),
            driver_result: driver_result.1,
            _worker: worker,
        }
    }

    /// The connection's QPACK decoder state, for decoding a field section read
    /// outside the worker.
    pub fn qpack_decoder_state(&self) -> &qpack::QpackDecoderState {
        &self.qpack_decoder_state
    }

    /// The connection's QPACK encoder state, for encoding a field section written
    /// outside the worker.
    pub fn qpack_encoder_state(&self) -> &qpack::QpackEncoderState {
        &self.qpack_encoder_state
    }

    /// Terminates the session, telling the peer why.
    ///
    /// Returns without waiting for anything to reach the peer: the capsule and the
    /// stream teardown are handed to the worker, which flushes them before the QUIC
    /// connection goes away.
    pub fn close_session(&self, error_code: u32, reason: &str) {
        self.terminate_pending_streams();

        let _ = self.session_commands.try_send(SessionCommand::Close {
            error_code,
            reason: reason.to_owned(),
        });
    }

    /// Tells the peer the session is going away soon, leaving it usable.
    pub fn drain_session(&self) {
        let _ = self.session_commands.try_send(SessionCommand::Drain);
    }

    /// Tells the peer not to open any further session on this connection.
    pub fn send_goaway(&self) {
        let _ = self.session_commands.try_send(SessionCommand::GoAway);
    }

    /// The identifier of the last `GOAWAY` the peer sent, if it sent one.
    pub fn peer_goaway_id(&self) -> Option<VarInt> {
        *self.peer_goaway_id.borrow()
    }

    /// Resolves once the peer has said this session is going away.
    pub async fn draining(&self) {
        let mut draining = self.draining.clone();

        while !*draining.borrow_and_update() {
            // A dropped sender means the driver is gone, which is as final as draining.
            if draining.changed().await.is_err() {
                return;
            }
        }
    }

    /// Tears down the session's streams that arrived but were never accepted.
    ///
    /// Streams the application already holds, and any it is concurrently waiting on,
    /// are left to the connection teardown that follows the close.
    fn terminate_pending_streams(&self) {
        let session_gone = ErrorCode::SessionGone.to_code();

        if let Ok(mut streams) = self.ready_uni_wt_streams.try_lock() {
            while let Ok(stream) = streams.try_recv() {
                let _ = stream.into_stream().stop(session_gone);
            }
        }

        if let Ok(mut streams) = self.ready_bi_wt_streams.try_lock() {
            while let Ok(stream) = streams.try_recv() {
                let (mut send, mut recv) = stream.into_stream();
                let _ = send.reset(session_gone);
                let _ = recv.stop(session_gone);
            }
        }
    }

    /// Waits for the peer's settings.
    ///
    /// The peer sends them once, but a connection whose 0-RTT data was rejected asks twice
    /// — once optimistically and once after rebuilding — so the answer is remembered.
    pub async fn accept_settings(&self) -> Result<Settings, DriverError> {
        let mut lock = self.ready_settings.lock().await;

        if let Some(settings) = &lock.1 {
            return Ok(settings.clone());
        }

        match lock.0.recv().await {
            Some(settings) => {
                lock.1 = Some(settings.clone());
                Ok(settings)
            }
            None => Err(self.result().await),
        }
    }

    pub async fn accept_session(&self) -> Result<StreamSession, DriverError> {
        match self.ready_sessions.recv().await {
            Some(session) => Ok(session),
            None => Err(self.result().await),
        }
    }

    pub async fn open_session(
        &self,
        session_request: SessionRequest,
    ) -> Result<StreamSession, DriverError> {
        let stream = Stream::open_bi(&self.quic_connection)
            .await
            .ok_or(DriverError::NotConnected)?
            .upgrade()
            .into_session(session_request);

        Ok(stream)
    }

    pub async fn register_session(&self, stream_session: StreamSession) -> Result<(), DriverError> {
        match self.ready_sessions.send(stream_session).await {
            Ok(()) => Ok(()),
            Err(SendError) => Err(self.result().await),
        }
    }

    pub async fn accept_uni(
        &self,
        session_id: SessionId,
    ) -> Result<StreamUniRemoteWT, DriverError> {
        let mut lock = self.ready_uni_wt_streams.lock().await;

        loop {
            let Some(stream) = lock.recv().await else {
                return Err(self.result().await);
            };

            if stream.session_id() == session_id {
                return Ok(stream);
            }

            debug!(
                "Discarding WT stream (stream_id: {}, session_id: {})",
                stream.id(),
                stream.session_id()
            );

            stream
                .into_stream()
                .stop(ErrorCode::BufferedStreamRejected.to_code())
                .expect("Stream not already stopped");
        }
    }

    pub async fn accept_bi(&self, session_id: SessionId) -> Result<StreamBiRemoteWT, DriverError> {
        let mut lock = self.ready_bi_wt_streams.lock().await;

        loop {
            let Some(stream) = lock.recv().await else {
                return Err(self.result().await);
            };

            if stream.session_id() == session_id {
                return Ok(stream);
            }

            debug!(
                "Discarding WT stream (stream_id: {}, session_id: {})",
                stream.id(),
                stream.session_id()
            );

            stream
                .into_stream()
                .1
                .stop(ErrorCode::BufferedStreamRejected.to_code())
                .expect("Stream not already stopped");
        }
    }

    pub async fn receive_datagram(&self, session_id: SessionId) -> Result<Datagram, DriverError> {
        let mut lock = self.ready_datagrams.lock().await;

        loop {
            let Some(datagram) = lock.recv().await else {
                return Err(self.result().await);
            };

            if datagram.session_id() == session_id {
                return Ok(datagram);
            }

            debug!(
                "Incoming datagram discarded (session_id: {})",
                datagram.session_id()
            );
        }
    }

    pub async fn open_uni(&self, session_id: SessionId) -> Result<OpeningUniStream, DriverError> {
        let quic_stream = Stream::open_uni(&self.quic_connection)
            .await
            .ok_or(DriverError::NotConnected)?;

        Ok(OpeningUniStream::new(session_id, quic_stream))
    }

    pub async fn open_bi(&self, session_id: SessionId) -> Result<OpeningBiStream, DriverError> {
        let quic_stream = Stream::open_bi(&self.quic_connection)
            .await
            .ok_or(DriverError::NotConnected)?;

        Ok(OpeningBiStream::new(session_id, quic_stream))
    }

    pub fn send_datagram(
        &self,
        session_id: SessionId,
        payload: &[u8],
    ) -> Result<(), SendDatagramError> {
        let quic_datagram = Datagram::write(session_id, payload).into_quic_bytes();

        match self.quic_connection.send_datagram(quic_datagram) {
            Ok(()) => Ok(()),
            Err(quinn::SendDatagramError::UnsupportedByPeer) => {
                Err(SendDatagramError::UnsupportedByPeer)
            }
            Err(quinn::SendDatagramError::Disabled) => {
                unreachable!()
            }

            Err(quinn::SendDatagramError::TooLarge) => Err(SendDatagramError::TooLarge),
            Err(quinn::SendDatagramError::ConnectionLost(_)) => {
                Err(SendDatagramError::NotConnected)
            }
        }
    }

    async fn result(&self) -> DriverError {
        match self.driver_result.result().await {
            Some(error) => error,
            None => panic!("Driver worker panic!"),
        }
    }
}

mod worker {
    use super::*;
    use crate::driver::qpack::QpackDecoderState;
    use crate::driver::qpack::QpackEncoderState;
    use crate::driver::streams::qpack::LocalQPackDecStream;
    use crate::driver::streams::qpack::LocalQPackEncStream;
    use crate::driver::streams::qpack::RemoteQPackDecStream;
    use crate::driver::streams::qpack::RemoteQPackEncStream;
    use crate::driver::streams::settings::LocalSettingsStream;
    use crate::driver::streams::settings::RemoteSettingsStream;
    use crate::driver::streams::unilocal::StreamUniLocalH3;
    use crate::driver::streams::uniremote::StreamUniRemoteH3;
    use crate::driver::streams::ProtoReadError;
    use crate::driver::streams::ProtoWriteError;
    use crate::driver::utils::TrySendError;
    use std::time::Duration;
    use streams::connect::ConnectStream;
    use tokio::time::timeout;
    use utils::varint_w2q;
    use wtransport_proto::capsule::capsules::CloseWebTransportSession;
    use wtransport_proto::capsule::capsules::DrainWebTransportSession;
    use wtransport_proto::frame::FrameKind;
    use wtransport_proto::frame::FrameOwned;
    use wtransport_proto::session::HeadersParseError;
    use wtransport_proto::settings::SettingId;
    use wtransport_proto::stream_header::StreamHeader;
    use wtransport_proto::stream_header::StreamKind;
    use wtransport_proto::varint::VarInt;

    /// Owns one connection's datagram reader task. Dropping it (with the worker)
    /// aborts the task, so no reader outlives its driver.
    pub(super) struct DatagramPump {
        handle: JoinHandle<DriverError>,
    }

    impl DatagramPump {
        fn spawn(
            quic_connection: &quinn::Connection,
            ready_datagrams: &mpsc::Sender<Datagram>,
        ) -> Self {
            let quic_connection = quic_connection.clone();
            let ready_datagrams = ready_datagrams.clone();
            PUMPS_SPAWNED.fetch_add(1, Ordering::Relaxed);
            PUMPS_LIVE.fetch_add(1, Ordering::Relaxed);
            // Owned by the future, so it is dropped (and the gauge decremented) even
            // when the task is aborted before its first poll.
            let live = PumpLiveGuard;
            let handle = tokio::spawn(async move {
                let _live = live;
                loop {
                    if let Err(error) =
                        Worker::accept_datagram(&quic_connection, &ready_datagrams).await
                    {
                        return error;
                    }
                }
            });
            Self { handle }
        }

        /// Resolves with the pump's error; never resolves when there is no pump.
        /// A panic inside the pump is re-raised here rather than turned into an
        /// ordinary disconnect.
        pub(super) async fn join(pump: &mut Option<Self>) -> DriverError {
            let Some(pump) = pump.as_mut() else {
                return std::future::pending().await;
            };
            Self::outcome((&mut pump.handle).await)
        }

        pub(super) fn outcome(result: Result<DriverError, tokio::task::JoinError>) -> DriverError {
            match result {
                Ok(error) => error,
                Err(join_error) if join_error.is_panic() => {
                    std::panic::resume_unwind(join_error.into_panic())
                }
                Err(_cancelled) => DriverError::NotConnected,
            }
        }
    }

    impl Drop for DatagramPump {
        fn drop(&mut self) {
            self.handle.abort();
        }
    }

    pub struct Worker {
        quic_connection: quinn::Connection,
        ready_settings: mpsc::Sender<Settings>,
        ready_sessions: BiChannelEndpoint<StreamSession>,
        ready_uni_wt_streams: mpsc::Sender<StreamUniRemoteWT>,
        ready_bi_wt_streams: mpsc::Sender<StreamBiRemoteWT>,
        ready_datagrams: mpsc::Sender<Datagram>,
        driver_result: SharedResultSet<DriverError>,
        zero_rtt: ZeroRtt,
        local_settings_stream: LocalSettingsStream,
        remote_settings_stream: RemoteSettingsStream,
        remote_qpack_enc_stream: RemoteQPackEncStream,
        remote_qpack_dec_stream: RemoteQPackDecStream,
        local_qpack_dec_stream: LocalQPackDecStream,
        local_qpack_enc_stream: LocalQPackEncStream,
        qpack_decoder_state: QpackDecoderState,
        qpack_encoder_state: QpackEncoderState,
        connect_stream: ConnectStream,
        session_commands: mpsc::Receiver<SessionCommand>,
        goaway_sent: bool,
        qpack_max_table_capacity: u64,
    }

    /// The connection's QPACK state, shared with the [`Driver`].
    pub struct Qpack {
        /// Dynamic table capacity to advertise in SETTINGS.
        pub max_table_capacity: u64,

        /// Decoder state, also used by whoever decodes outside the worker.
        pub decoder_state: QpackDecoderState,

        /// Instructions waiting to go out on this endpoint's decoder stream.
        pub decoder_instructions: mpsc::UnboundedReceiver<Vec<u8>>,

        /// Encoder state, also used by whoever encodes outside the worker.
        pub encoder_state: QpackEncoderState,

        /// Instructions waiting to go out on this endpoint's encoder stream.
        pub encoder_instructions: mpsc::UnboundedReceiver<Vec<u8>>,
    }

    /// What the worker publishes about the peer winding the session down.
    pub struct Draining {
        /// Set once the peer has said the session is going away.
        pub notified: Arc<watch::Sender<bool>>,

        /// The identifier of the peer's `GOAWAY`, once it has sent one.
        pub goaway_id: Arc<watch::Sender<Option<VarInt>>>,
    }

    /// The sending halves of everything the worker hands back to the [`Driver`].
    pub struct Ready {
        pub settings: mpsc::Sender<Settings>,
        pub sessions: BiChannelEndpoint<StreamSession>,
        pub uni_wt_streams: mpsc::Sender<StreamUniRemoteWT>,
        pub bi_wt_streams: mpsc::Sender<StreamBiRemoteWT>,
        pub datagrams: mpsc::Sender<Datagram>,
    }

    impl Worker {
        pub fn new(
            quic_connection: quinn::Connection,
            ready: Ready,
            session_commands: mpsc::Receiver<SessionCommand>,
            draining: Draining,
            driver_result: SharedResultSet<DriverError>,
            zero_rtt: ZeroRtt,
            qpack: Qpack,
        ) -> Self {
            Self {
                quic_connection,
                ready_settings: ready.settings,
                ready_sessions: ready.sessions,
                ready_uni_wt_streams: ready.uni_wt_streams,
                ready_bi_wt_streams: ready.bi_wt_streams,
                ready_datagrams: ready.datagrams,
                driver_result,
                zero_rtt,
                local_settings_stream: LocalSettingsStream::empty(qpack.max_table_capacity),
                remote_settings_stream: RemoteSettingsStream::empty(
                    Arc::clone(&draining.notified),
                    draining.goaway_id,
                ),
                remote_qpack_enc_stream: RemoteQPackEncStream::empty(qpack.decoder_state.clone()),
                remote_qpack_dec_stream: RemoteQPackDecStream::empty(qpack.encoder_state.clone()),
                local_qpack_dec_stream: LocalQPackDecStream::empty(qpack.decoder_instructions),
                local_qpack_enc_stream: LocalQPackEncStream::empty(qpack.encoder_instructions),
                qpack_decoder_state: qpack.decoder_state,
                qpack_encoder_state: qpack.encoder_state,
                connect_stream: ConnectStream::empty(draining.notified),
                session_commands,
                goaway_sent: false,
                qpack_max_table_capacity: qpack.max_table_capacity,
            }
        }

        pub async fn run(mut self) {
            debug!("Started");

            let error = self
                .run_impl()
                .await
                .expect_err("Worker must return an error");

            debug!("Ended with error: {:?}", error);

            let close_code = match &error {
                // The session is already torn down by the time either of these reaches
                // here: `close_session` does it for a local close, and a peer's close
                // capsule means the peer has done its own. All that is left is the
                // connection itself, which this endpoint no longer has a session for.
                DriverError::ApplicationClosed(_) | DriverError::LocallyClosed => {
                    Some(ErrorCode::NoError)
                }
                DriverError::Proto(error_code) => Some(*error_code),
                DriverError::NotConnected => None,
            };

            let locally_closed = matches!(&error, DriverError::LocallyClosed);

            // The application learns the session ended as soon as the reason is
            // known: the wait below is about the peer's view of the wire, not
            // this endpoint's.
            self.driver_result.set(error);

            if let Some(error_code) = close_code {
                // A driver whose 0-RTT data was rejected fails on streams the peer never
                // saw. The connection itself is healthy and completing an ordinary
                // handshake, so closing it here would destroy something that only needs
                // its H3 state rebuilt. `confirmed` returns true for every connection that
                // did not use early data, leaving the ordinary path untouched. A close the
                // application asked for is never a failure to explain away.
                if !locally_closed && self.zero_rtt.explains_failure().await {
                    debug!("Connection left open: its 0-RTT data was rejected");
                } else {
                    // A transport acknowledgement of the close capsule only proves
                    // the peer's QUIC layer took the bytes, not that its application
                    // read them. A `CONNECTION_CLOSE` sent right afterwards can still
                    // be handled first, and the peer then reports a bare connection
                    // loss with no code or reason (Chromium: "Connection lost."). A
                    // peer that has processed the capsule tears the connection down
                    // itself, so wait for that before closing; the bound keeps a
                    // peer that never answers from holding the connection open.
                    if locally_closed {
                        const PEER_CLOSE_TIMEOUT: Duration = Duration::from_secs(1);
                        let _ = timeout(PEER_CLOSE_TIMEOUT, self.quic_connection.closed()).await;
                    }
                    self.quic_connection
                        .close(varint_w2q(error_code.to_code()), b"");
                }
            }
        }

        async fn run_impl(&mut self) -> Result<(), DriverError> {
            let mut remote_settings_watcher = self.remote_settings_stream.subscribe();
            let mut ready_uni_h3_streams = mpsc::channel(4);
            let mut ready_bi_h3_streams = mpsc::channel(1);
            let mut rebuilt = false;

            if let Err(error) = self.open_and_send_settings().await {
                self.rebuild_or(error, &mut rebuilt).await?;
            }

            // Datagrams are read by their own task unless WTRANSPORT_DATAGRAM_PUMP=0:
            // a datagram then wakes only that task instead of this select, whose
            // every pass re-polls the accept and control-stream futures under the
            // connection lock.
            let pump_enabled = datagram_pump_enabled();
            let mut datagram_pump = pump_enabled
                .then(|| DatagramPump::spawn(&self.quic_connection, &self.ready_datagrams));

            loop {
                let step: Result<(), DriverError> = tokio::select! {
                    result = Self::accept_uni(&self.quic_connection,
                                              &ready_uni_h3_streams.0,
                                              &self.ready_uni_wt_streams) => {
                        result
                    }

                    result = Self::accept_bi(&self.quic_connection,
                                             self.qpack_decoder_state.clone(),
                                             &ready_bi_h3_streams.0,
                                             &self.ready_bi_wt_streams) => {
                        result
                    }

                    result = Self::accept_datagram(&self.quic_connection,
                                                   &self.ready_datagrams), if !pump_enabled => {
                        result
                    }

                    error = DatagramPump::join(&mut datagram_pump), if pump_enabled => {
                        // The pump ended: hand its error to the same rebuild path the
                        // inline accept uses, and restart it so a recovered connection
                        // keeps reading exactly where the inline accept would retry.
                        datagram_pump = Some(DatagramPump::spawn(&self.quic_connection, &self.ready_datagrams));
                        Err(error)
                    }

                    uni_h3_stream = ready_uni_h3_streams.1.recv() => {
                        uni_h3_stream
                            .expect("Sender cannot be dropped")
                            .and_then(|stream| self.handle_uni_h3_stream(stream))
                    }

                    bi_h3_stream = ready_bi_h3_streams.1.recv() => {
                        bi_h3_stream
                            .expect("Sender cannot be dropped")
                            .and_then(|(stream, first_frame)| {
                                self.handle_bi_h3_stream(stream, first_frame)
                            })
                    }


                    settings = remote_settings_watcher.accept_settings() => {
                        let settings = settings.expect("Channel cannot be dropped");
                        self.handle_remote_settings(settings)
                    }

                    stream_session = self.ready_sessions.recv() => {
                        match stream_session {
                            Some(stream_session) => {
                                if self.connect_stream.is_empty() {
                                    self.connect_stream.set_stream(stream_session);
                                }
                                Ok(())
                            }
                            None => Err(DriverError::NotConnected),
                        }
                    }

                    error = Self::run_control_streams(&mut self.local_settings_stream,
                                                      &mut self.remote_settings_stream,
                                                      &mut self.remote_qpack_enc_stream,
                                                      &mut self.remote_qpack_dec_stream,
                                                      &mut self.local_qpack_dec_stream,
                                                      &mut self.local_qpack_enc_stream,
                                                      &mut self.connect_stream) => {
                        Err(error)
                    }

                    session_command = self.session_commands.recv() => {
                        match session_command {
                            Some(session_command) => self.run_session_command(session_command).await,
                            None => Err(DriverError::NotConnected),
                        }
                    }

                    () = self.driver_result.closed() => {
                        return Err(DriverError::NotConnected);
                    }
                };

                if let Err(error) = step {
                    self.rebuild_or(error, &mut rebuilt).await?;
                }
            }
        }

        /// Terminates the session by telling the peer why, then ends the worker.
        ///
        /// The capsule has to be on the wire before anything closes the connection: a
        /// `CONNECTION_CLOSE` frame overtakes buffered stream data, so a close sent
        /// first would leave the peer with a bare connection teardown and no error code
        /// or reason. `finish` waits for the peer to acknowledge the capsule, and the
        /// connection close in `run` happens only afterwards.
        ///
        /// A peer that has stopped acknowledging anything must not hold a close open
        /// forever, so the wait is bounded; the connection teardown that follows
        /// delivers the close either way, just without the detail.
        async fn run_session_command(
            &mut self,
            session_command: SessionCommand,
        ) -> Result<(), DriverError> {
            match session_command {
                SessionCommand::Close { error_code, reason } => {
                    self.close_session(error_code, &reason).await
                }
                SessionCommand::Drain => {
                    self.write_capsule(DrainWebTransportSession::new().to_capsule().into_frame())
                        .await;
                    Ok(())
                }
                SessionCommand::GoAway => self.send_goaway().await,
            }
        }

        /// Tells the peer not to open any further session on this connection.
        ///
        /// The identifier leaves the session already running untouched: it is the one
        /// past this session's CONNECT stream, so only later requests are refused. That
        /// makes the CONNECT stream a prerequisite rather than an optional detail: an
        /// identifier computed without it would be zero, which tells the peer the
        /// session it is running was never processed.
        ///
        /// Only the first `GOAWAY` goes out. RFC 9114 section 5.2 lets a second one only
        /// lower the identifier, and there is nothing lower to say here, so a repeat is
        /// silently nothing rather than a protocol violation.
        async fn send_goaway(&mut self) -> Result<(), DriverError> {
            if self.goaway_sent {
                return Ok(());
            }

            self.collect_registered_session();

            let next_request = self
                .connect_stream
                .stream_mut()
                .map(|stream| stream.session_id().into_varint().into_inner() + 4)
                .unwrap_or(0);

            let id = VarInt::try_from_u64(next_request).unwrap_or(VarInt::MAX);

            self.goaway_sent = true;
            self.local_settings_stream.send_goaway(id).await
        }

        /// Writes a capsule on the CONNECT stream, if there is one to write it on.
        ///
        /// A `Connection` only exists once the session request has been answered with a
        /// 2xx, so a capsule written here is never one the peer has to discard.
        async fn write_capsule(&mut self, capsule: FrameOwned) -> bool {
            self.collect_registered_session();

            match self.connect_stream.stream_mut() {
                Some(stream) => stream.write_frame(capsule).await.is_ok(),
                None => false,
            }
        }

        /// Collects a session that has been registered but not yet installed.
        ///
        /// Registering returns as soon as the hand-off is buffered, so a command issued
        /// right after connecting can arrive before the CONNECT stream is in place.
        fn collect_registered_session(&mut self) {
            if self.connect_stream.is_empty() {
                if let Some(stream_session) = self.ready_sessions.try_recv() {
                    self.connect_stream.set_stream(stream_session);
                }
            }
        }

        async fn close_session(
            &mut self,
            error_code: u32,
            reason: &str,
        ) -> Result<(), DriverError> {
            const FLUSH_TIMEOUT: Duration = Duration::from_secs(3);

            let capsule = CloseWebTransportSession::new(error_code, reason)
                .to_capsule()
                .into_frame();

            if self.write_capsule(capsule).await {
                if let Some(stream) = self.connect_stream.stream_mut() {
                    let _ = timeout(FLUSH_TIMEOUT, stream.finish()).await;
                }
            }

            Err(DriverError::LocallyClosed)
        }

        /// Reopens the H3 streams this endpoint had opened, when the failure is explained
        /// by the peer refusing our early data.
        ///
        /// Those streams were discarded before the peer's application ever saw them, while
        /// the QUIC connection itself carried on into an ordinary handshake and everything
        /// the peer opened remains valid. Rebuilding is therefore all that is needed, and
        /// it happens at most once: a second failure is a real one. A close the
        /// application asked for is not a failure at all and is never rebuilt around.
        async fn rebuild_or(
            &mut self,
            error: DriverError,
            rebuilt: &mut bool,
        ) -> Result<(), DriverError> {
            if matches!(error, DriverError::LocallyClosed)
                || *rebuilt
                || !self.zero_rtt.explains_failure().await
            {
                return Err(error);
            }

            debug!("Reopening the H3 control stream: our 0-RTT data was rejected");

            *rebuilt = true;
            self.local_settings_stream = LocalSettingsStream::empty(self.qpack_max_table_capacity);

            self.open_and_send_settings().await
        }

        async fn open_and_send_settings(&mut self) -> Result<(), DriverError> {
            assert!(self.local_settings_stream.is_empty());

            let stream = match Stream::open_uni(&self.quic_connection)
                .await
                .ok_or(DriverError::NotConnected)?
                .upgrade(StreamHeader::new_control())
                .await
            {
                Ok(h3_stream) => h3_stream,
                Err(ProtoWriteError::NotConnected) => return Err(DriverError::NotConnected),
                Err(ProtoWriteError::Stopped) => {
                    return Err(DriverError::Proto(ErrorCode::ClosedCriticalStream));
                }
            };

            self.local_settings_stream.set_stream(stream);
            self.local_settings_stream.send_settings().await?;

            self.open_qpack_streams().await
        }

        /// Opens this endpoint's QPACK streams, when it takes part in dynamic QPACK.
        ///
        /// The decoder stream is where the peer's inserts are acknowledged; without it a
        /// peer that took up the offer would fill its table and never reuse it. The
        /// encoder stream is where this endpoint's own inserts go, and stays silent
        /// until the peer's settings say it offers a table of its own.
        async fn open_qpack_streams(&mut self) -> Result<(), DriverError> {
            if !self.qpack_decoder_state.is_enabled() {
                return Ok(());
            }

            let stream = self
                .open_qpack_stream(StreamHeader::new_qpack_decoder())
                .await?;
            self.local_qpack_dec_stream.set_stream(stream);

            let stream = self
                .open_qpack_stream(StreamHeader::new_qpack_encoder())
                .await?;
            self.local_qpack_enc_stream.set_stream(stream);

            Ok(())
        }

        async fn open_qpack_stream(
            &mut self,
            header: StreamHeader,
        ) -> Result<StreamUniLocalH3, DriverError> {
            match Stream::open_uni(&self.quic_connection)
                .await
                .ok_or(DriverError::NotConnected)?
                .upgrade(header)
                .await
            {
                Ok(h3_stream) => Ok(h3_stream),
                Err(ProtoWriteError::NotConnected) => Err(DriverError::NotConnected),
                Err(ProtoWriteError::Stopped) => {
                    Err(DriverError::Proto(ErrorCode::ClosedCriticalStream))
                }
            }
        }

        async fn accept_uni(
            quic_connection: &quinn::Connection,
            ready_uni_h3_streams: &mpsc::Sender<Result<StreamUniRemoteH3, DriverError>>,
            ready_uni_wt_streams: &mpsc::Sender<StreamUniRemoteWT>,
        ) -> Result<(), DriverError> {
            trace!("H3 uni queue capacity: {}", ready_uni_h3_streams.capacity());
            let h3_slot = ready_uni_h3_streams
                .clone()
                .reserve_owned()
                .await
                .expect("Receiver cannot be dropped");

            let wt_slot = match ready_uni_wt_streams.clone().reserve_owned().await {
                Ok(wt_slot) => wt_slot,
                Err(mpsc::error::SendError(_)) => return Err(DriverError::NotConnected),
            };

            let stream_quic = Stream::accept_uni(quic_connection)
                .await
                .ok_or(DriverError::NotConnected)?;

            let stream_id = stream_quic.id();
            debug!("New incoming uni stream ({})", stream_id);

            tokio::spawn(
                async move {
                    let stream_h3 = match stream_quic.upgrade().await {
                        Ok(stream_h3) => stream_h3,
                        Err(ProtoReadError::H3(error_code)) => {
                            h3_slot.send(Err(DriverError::Proto(error_code)));
                            return;
                        }
                        Err(ProtoReadError::IO(_)) => {
                            return;
                        }
                    };

                    let stream_kind = stream_h3.kind();
                    debug!("Type: {:?}", stream_kind);

                    if matches!(stream_kind, StreamKind::WebTransport) {
                        let stream_wt = stream_h3.upgrade();
                        wt_slot.send(stream_wt);
                    } else {
                        h3_slot.send(Ok(stream_h3));
                    }
                }
                .instrument(debug_span!("Stream", "id={}", stream_id)),
            );

            Ok(())
        }

        async fn accept_bi(
            quic_connection: &quinn::Connection,
            qpack_decoder_state: QpackDecoderState,
            ready_bi_h3_streams: &mpsc::Sender<
                Result<(StreamBiRemoteH3, Frame<'static>), DriverError>,
            >,
            ready_bi_wt_streams: &mpsc::Sender<StreamBiRemoteWT>,
        ) -> Result<(), DriverError> {
            trace!("H3 bi queue capacity: {}", ready_bi_h3_streams.capacity());
            let h3_slot = ready_bi_h3_streams
                .clone()
                .reserve_owned()
                .await
                .expect("Receiver cannot be dropped");

            let wt_slot = match ready_bi_wt_streams.clone().reserve_owned().await {
                Ok(wt_slot) => wt_slot,
                Err(mpsc::error::SendError(_)) => return Err(DriverError::NotConnected),
            };

            let stream_quic = Stream::accept_bi(quic_connection)
                .await
                .ok_or(DriverError::NotConnected)?;

            let stream_id = stream_quic.id();
            debug!("New incoming bi stream ({})", stream_id);

            tokio::spawn(
                async move {
                    let mut stream_h3 = stream_quic.upgrade();

                    let frame = loop {
                        match stream_h3.read_frame().await {
                            Ok(frame) => {
                                debug!("Frame kind: {:?}", frame.kind());
                                if !matches!(frame.kind(), FrameKind::Exercise(_)) {
                                    break frame;
                                }
                            }
                            Err(ProtoReadError::H3(error_code)) => {
                                h3_slot.send(Err(DriverError::Proto(error_code)));
                                return;
                            }
                            // The stream went away before its field section could
                            // be read. Whatever the peer encoded on it still holds
                            // entries in its table, so release them.
                            Err(ProtoReadError::IO(_)) => {
                                qpack_decoder_state.cancel_stream(stream_id.into_u64());
                                return;
                            }
                        }
                    };

                    debug!("First frame: {:?}", frame);

                    match frame.session_id() {
                        Some(session_id) => {
                            let stream_wt = stream_h3.upgrade(session_id);
                            wt_slot.send(stream_wt);
                        }
                        None => {
                            h3_slot.send(Ok((stream_h3, frame)));
                        }
                    }
                }
                .instrument(debug_span!("Stream", "id={}", stream_id)),
            );

            Ok(())
        }

        async fn accept_datagram(
            quic_connection: &quinn::Connection,
            ready_datagrams: &mpsc::Sender<Datagram>,
        ) -> Result<(), DriverError> {
            let slot = match ready_datagrams.reserve().await {
                Ok(slot) => slot,
                Err(mpsc::error::SendError(_)) => return Err(DriverError::NotConnected),
            };

            let quic_dgram = quic_connection
                .read_datagram()
                .await
                .map_err(|_| DriverError::NotConnected)?;

            let datagram = match Datagram::read(quic_dgram) {
                Ok(datagram) => datagram,
                Err(error_code) => return Err(DriverError::Proto(error_code)),
            };

            trace!(
                "New incoming datagram (session_id: {})",
                datagram.session_id()
            );

            slot.send(datagram);

            Ok(())
        }

        fn handle_uni_h3_stream(&mut self, stream: StreamUniRemoteH3) -> Result<(), DriverError> {
            match stream.kind() {
                StreamKind::Control => {
                    if !self.remote_settings_stream.is_empty() {
                        return Err(DriverError::Proto(ErrorCode::StreamCreation));
                    }

                    self.remote_settings_stream.set_stream(stream);
                }
                StreamKind::QPackEncoder => {
                    if !self.remote_qpack_enc_stream.is_empty() {
                        return Err(DriverError::Proto(ErrorCode::StreamCreation));
                    }

                    self.remote_qpack_enc_stream.set_stream(stream);
                }
                StreamKind::QPackDecoder => {
                    if !self.remote_qpack_dec_stream.is_empty() {
                        return Err(DriverError::Proto(ErrorCode::StreamCreation));
                    }

                    self.remote_qpack_dec_stream.set_stream(stream);
                }
                StreamKind::WebTransport => unreachable!(),
                StreamKind::Exercise(_) => {}
            }

            Ok(())
        }

        #[instrument(skip_all, name = "Stream", fields(id = %stream.id()))]
        fn handle_bi_h3_stream(
            &mut self,
            mut stream: StreamBiRemoteH3,
            first_frame: Frame<'static>,
        ) -> Result<(), DriverError> {
            match first_frame.kind() {
                FrameKind::Data => {
                    return Err(DriverError::Proto(ErrorCode::FrameUnexpected));
                }
                FrameKind::Headers => {
                    let headers = match self
                        .qpack_decoder_state
                        .decode(&first_frame, stream.id().into_u64())
                    {
                        Ok(headers) => headers,
                        Err(error_code) => return Err(DriverError::Proto(error_code)),
                    };

                    debug!("Headers: {:?}", headers);

                    // Having sent GOAWAY, this endpoint promised to take on nothing more.
                    if self.goaway_sent {
                        debug!("Refusing session request: GOAWAY already sent");
                        stream
                            .stop(ErrorCode::RequestRejected.to_code())
                            .expect("Stream not already stopped");
                        return Ok(());
                    }

                    let stream_session = match SessionRequest::try_from(headers) {
                        Ok(session_request) => stream.into_session(session_request),
                        Err(HeadersParseError::MethodNotConnect) => {
                            stream
                                .stop(ErrorCode::RequestRejected.to_code())
                                .expect("Stream not already stopped");
                            return Ok(());
                        }
                        // TODO(biagio): we might have more granularity with errors
                        Err(_) => {
                            stream
                                .stop(ErrorCode::Message.to_code())
                                .expect("Stream not already stopped");
                            return Ok(());
                        }
                    };

                    match self.ready_sessions.try_send(stream_session) {
                        Ok(()) => {}
                        Err(TrySendError::Full(mut stream)) => {
                            debug!("Discarding session request: sessions queue is full");
                            stream
                                .stop(ErrorCode::RequestRejected.to_code())
                                .expect("Stream not already stopped");
                        }
                        Err(TrySendError::Closed(_)) => return Err(DriverError::NotConnected),
                    }
                }
                FrameKind::Settings => {
                    return Err(DriverError::Proto(ErrorCode::FrameUnexpected));
                }
                FrameKind::WebTransport => unreachable!(),
                FrameKind::Goaway => {
                    return Err(DriverError::Proto(ErrorCode::FrameUnexpected));
                }
                FrameKind::Exercise(_) => {}
            }

            Ok(())
        }

        async fn run_control_streams(
            local_settings: &mut LocalSettingsStream,
            remote_settings: &mut RemoteSettingsStream,
            remote_qpack_enc: &mut RemoteQPackEncStream,
            remote_qpack_dec: &mut RemoteQPackDecStream,
            local_qpack_dec: &mut LocalQPackDecStream,
            local_qpack_enc: &mut LocalQPackEncStream,
            connect_stream: &mut ConnectStream,
        ) -> DriverError {
            tokio::select! {
                error = connect_stream.run() => error,
                error = local_qpack_dec.run() => error,
                error = local_qpack_enc.run() => error,
                error = local_settings.run() => error,
                error = remote_settings.run() => error,
                error = remote_qpack_enc.run() => error,
                error = remote_qpack_dec.run() => error,
            }
        }

        fn handle_remote_settings(&mut self, settings: Settings) -> Result<(), DriverError> {
            debug!("Received: {:?}", settings);

            // Only now is it known whether the peer holds a dynamic table, and how big
            // a one it is willing to hold (RFC 9204 Section 3.2.3). Its offer is taken
            // up only by an endpoint that takes part in dynamic QPACK itself: the same
            // configuration that opened the QPACK streams to insert on.
            if self.qpack_decoder_state.is_enabled() {
                let peer_max_table_capacity = settings
                    .get(SettingId::QPackMaxTableCapacity)
                    .map(|capacity| capacity.into_inner())
                    .unwrap_or(0);

                self.qpack_encoder_state
                    .configure(peer_max_table_capacity, MAX_QPACK_TABLE_CAPACITY);
            }

            match self.ready_settings.try_send(settings) {
                Ok(()) => Ok(()),
                Err(mpsc::error::TrySendError::Closed(_)) => Err(DriverError::NotConnected),
                Err(mpsc::error::TrySendError::Full(_)) => {
                    unreachable!("No more than 1 setting frame can be processed")
                }
            }
        }
    }
}

pub(crate) mod qpack;
pub(crate) mod streams;
pub(crate) mod utils;

#[cfg(test)]
mod datagram_pump_tests {
    use super::worker::DatagramPump;
    use super::DriverError;

    #[tokio::test]
    async fn pump_outcome_reraises_a_panic_instead_of_reporting_a_disconnect() {
        let join = tokio::spawn(async { panic!("pump exploded") }).await;
        let caught = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _: DriverError = DatagramPump::outcome(join.map(|()| DriverError::NotConnected));
        }));
        let payload = caught.expect_err("a pump panic must propagate");
        assert_eq!(payload.downcast_ref::<&str>(), Some(&"pump exploded"));
    }

    #[tokio::test]
    async fn pump_outcome_passes_errors_through_and_maps_cancellation_to_not_connected() {
        let ok = tokio::spawn(async { DriverError::NotConnected }).await;
        assert!(matches!(
            DatagramPump::outcome(ok),
            DriverError::NotConnected
        ));
        let handle = tokio::spawn(std::future::pending::<DriverError>());
        handle.abort();
        assert!(matches!(
            DatagramPump::outcome(handle.await),
            DriverError::NotConnected
        ));
    }

    #[tokio::test]
    async fn join_without_a_pump_never_resolves() {
        let mut none: Option<DatagramPump> = None;
        let joined = tokio::time::timeout(
            std::time::Duration::from_millis(50),
            DatagramPump::join(&mut none),
        )
        .await;
        assert!(joined.is_err());
    }
}
