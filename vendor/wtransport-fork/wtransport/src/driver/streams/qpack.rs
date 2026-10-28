use crate::driver::qpack::QpackDecoderState;
use crate::driver::qpack::QpackEncoderState;
use crate::driver::streams::unilocal::StreamUniLocalH3;
use crate::driver::streams::uniremote::StreamUniRemoteH3;
use crate::driver::DriverError;
use crate::error::StreamReadError;
use crate::error::StreamWriteError;
use std::future::pending;
use tokio::sync::mpsc;
use wtransport_proto::error::ErrorCode;
use wtransport_proto::qpack::Encoder;
use wtransport_proto::stream_header::StreamKind;

/// How much of the peer's encoder stream is read at a time.
const READ_CHUNK: usize = 1024;

/// Upper bound on an instruction held back waiting for the rest of it.
///
/// An encoder stream instruction is a couple of prefixed integers and two strings, so
/// anything beyond this is a peer trying to make an endpoint buffer without limit
/// rather than a legitimately split instruction.
const MAX_PENDING: usize = 64 * 1024;

pub struct RemoteQPackEncStream {
    stream: Option<StreamUniRemoteH3>,
    decoder_state: QpackDecoderState,
    buffer: Box<[u8]>,
    /// Bytes of an instruction that has not arrived in full yet.
    pending: Vec<u8>,
}

impl RemoteQPackEncStream {
    pub fn empty(decoder_state: QpackDecoderState) -> Self {
        Self {
            stream: None,
            decoder_state,
            buffer: vec![0; READ_CHUNK].into_boxed_slice(),
            pending: Vec::new(),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.stream.is_none()
    }

    pub fn set_stream(&mut self, stream: StreamUniRemoteH3) {
        assert!(matches!(stream.kind(), StreamKind::QPackEncoder));
        self.stream = Some(stream);
    }

    pub async fn run(&mut self) -> DriverError {
        let stream = match self.stream.as_mut() {
            Some(stream) => stream,
            None => pending().await,
        };

        loop {
            let read = match stream.stream_mut().read(&mut self.buffer).await {
                Ok(Some(read)) => read,
                // The encoder stream is critical: the peer must not close it.
                Ok(None) => return DriverError::Proto(ErrorCode::ClosedCriticalStream),
                Err(StreamReadError::NotConnected) => return DriverError::NotConnected,
                Err(StreamReadError::Reset(_)) | Err(StreamReadError::QuicProto) => {
                    return DriverError::Proto(ErrorCode::ClosedCriticalStream);
                }
            };

            self.pending.extend_from_slice(&self.buffer[..read]);

            let consumed = match self.decoder_state.feed_encoder_stream(&self.pending) {
                Ok(consumed) => consumed,
                Err(error_code) => return DriverError::Proto(error_code),
            };

            self.pending.drain(..consumed);

            if self.pending.len() > MAX_PENDING {
                return DriverError::Proto(ErrorCode::EncoderStream);
            }
        }
    }
}

pub struct RemoteQPackDecStream {
    stream: Option<StreamUniRemoteH3>,
    encoder_state: QpackEncoderState,
    buffer: Box<[u8]>,
    pending: Vec<u8>,
}

impl RemoteQPackDecStream {
    pub fn empty(encoder_state: QpackEncoderState) -> Self {
        Self {
            stream: None,
            encoder_state,
            buffer: vec![0; READ_CHUNK].into_boxed_slice(),
            pending: Vec::new(),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.stream.is_none()
    }

    pub fn set_stream(&mut self, stream: StreamUniRemoteH3) {
        assert!(matches!(stream.kind(), StreamKind::QPackDecoder));
        self.stream = Some(stream);
    }

    /// Reads the peer's acknowledgements and hands them to the encoder.
    ///
    /// Until an insert is acknowledged the encoder cannot reference it, so this is what
    /// eventually lets outgoing field sections index the dynamic table.
    pub async fn run(&mut self) -> DriverError {
        let stream = match self.stream.as_mut() {
            Some(stream) => stream,
            None => pending().await,
        };

        loop {
            let read = match stream.stream_mut().read(&mut self.buffer).await {
                Ok(Some(read)) => read,
                Ok(None) => return DriverError::Proto(ErrorCode::ClosedCriticalStream),
                Err(StreamReadError::NotConnected) => return DriverError::NotConnected,
                Err(StreamReadError::Reset(_)) | Err(StreamReadError::QuicProto) => {
                    return DriverError::Proto(ErrorCode::ClosedCriticalStream);
                }
            };

            self.pending.extend_from_slice(&self.buffer[..read]);

            let Ok((consumed, instructions)) = Encoder::feed_decoder_stream(&self.pending) else {
                return DriverError::Proto(ErrorCode::DecoderStream);
            };

            self.encoder_state.note_peer_instructions(&instructions);
            self.pending.drain(..consumed);

            if self.pending.len() > MAX_PENDING {
                return DriverError::Proto(ErrorCode::DecoderStream);
            }
        }
    }
}

/// This endpoint's encoder stream.
///
/// Carries the inserts that let the peer's decoder resolve the dynamic references in
/// later field sections. Opened whenever this endpoint takes part in dynamic QPACK,
/// though nothing is written until the peer's settings say it offers a table.
pub struct LocalQPackEncStream {
    stream: Option<StreamUniLocalH3>,
    instructions: mpsc::UnboundedReceiver<Vec<u8>>,
}

impl LocalQPackEncStream {
    pub fn empty(instructions: mpsc::UnboundedReceiver<Vec<u8>>) -> Self {
        Self {
            stream: None,
            instructions,
        }
    }

    pub fn set_stream(&mut self, stream: StreamUniLocalH3) {
        assert!(matches!(stream.kind(), StreamKind::QPackEncoder));
        self.stream = Some(stream);
    }

    pub async fn run(&mut self) -> DriverError {
        loop {
            let Some(instruction) = self.instructions.recv().await else {
                return pending().await;
            };

            let Some(stream) = self.stream.as_mut() else {
                // Nothing takes up a peer's offer without a stream to insert on.
                return DriverError::Proto(ErrorCode::EncoderStream);
            };

            match stream.stream_mut().write_all(&instruction).await {
                Ok(()) => {}
                Err(StreamWriteError::NotConnected) => return DriverError::NotConnected,
                Err(StreamWriteError::Closed)
                | Err(StreamWriteError::Stopped(_))
                | Err(StreamWriteError::QuicProto) => {
                    return DriverError::Proto(ErrorCode::ClosedCriticalStream);
                }
            }
        }
    }
}

/// This endpoint's decoder stream.
///
/// Opened whenever a dynamic table is offered: the peer's encoder cannot evict an entry
/// until the section using it is acknowledged, nor reuse an insert until it knows the
/// insert arrived, so with nothing written here its table fills up and stays full.
pub struct LocalQPackDecStream {
    stream: Option<StreamUniLocalH3>,
    instructions: mpsc::UnboundedReceiver<Vec<u8>>,
}

impl LocalQPackDecStream {
    pub fn empty(instructions: mpsc::UnboundedReceiver<Vec<u8>>) -> Self {
        Self {
            stream: None,
            instructions,
        }
    }

    pub fn set_stream(&mut self, stream: StreamUniLocalH3) {
        assert!(matches!(stream.kind(), StreamKind::QPackDecoder));
        self.stream = Some(stream);
    }

    pub async fn run(&mut self) -> DriverError {
        loop {
            let Some(instruction) = self.instructions.recv().await else {
                return pending().await;
            };

            let Some(stream) = self.stream.as_mut() else {
                // Nothing offered the peer a table, so nothing should be queued for it.
                return DriverError::Proto(ErrorCode::DecoderStream);
            };

            match stream.stream_mut().write_all(&instruction).await {
                Ok(()) => {}
                Err(StreamWriteError::NotConnected) => return DriverError::NotConnected,
                Err(StreamWriteError::Closed)
                | Err(StreamWriteError::Stopped(_))
                | Err(StreamWriteError::QuicProto) => {
                    return DriverError::Proto(ErrorCode::ClosedCriticalStream);
                }
            }
        }
    }
}
