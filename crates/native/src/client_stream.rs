//! Client stream handles: bridge wtransport streams to napi async read/write.

use napi::Result;
use napi_derive::napi;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, Mutex as TokioMutex};

use crate::RUNTIME;


/// Bridge for a bidi stream: read from RecvStream, write to SendStream.
/// JS calls read() / write() which use channels to the bridge tasks.
///
/// read() awaits directly on the napi runtime (no spawn on RUNTIME/CLIENT_RUNTIME).
/// The channel receiver works cross-runtime: the bridge sender runs on RUNTIME or
/// CLIENT_RUNTIME, and the waker mechanism correctly notifies the napi runtime.
/// This avoids the same-process deadlock that occurred when spawning the recv on
/// the same runtime as the bridge tasks.
#[napi]
pub struct ClientBidiStreamHandle {
    read_rx: Arc<TokioMutex<mpsc::Receiver<Vec<u8>>>>,
    write_tx: Option<mpsc::Sender<Vec<u8>>>,
}

impl ClientBidiStreamHandle {
    pub fn new(
        read_rx: mpsc::Receiver<Vec<u8>>,
        write_tx: mpsc::Sender<Vec<u8>>,
    ) -> Self {
        Self {
            read_rx: Arc::new(TokioMutex::new(read_rx)),
            write_tx: Some(write_tx),
        }
    }

    pub fn new_client_stream(
        read_rx: mpsc::Receiver<Vec<u8>>,
        write_tx: mpsc::Sender<Vec<u8>>,
    ) -> Self {
        Self::new(read_rx, write_tx)
    }
}

#[napi]
impl ClientBidiStreamHandle {
    /// Read the next chunk from the QUIC stream (via the bridge channel).
    /// Returns None on EOF / stream close.
    #[napi]
    pub async fn read(&self) -> Result<Option<napi::bindgen_prelude::Buffer>> {
        let read_rx = Arc::clone(&self.read_rx);
        let mut rx = read_rx.lock().await;
        Ok(rx.recv().await.map(|bytes| bytes.into()))
    }

    #[napi]
    pub async fn write(&self, chunk: napi::bindgen_prelude::Buffer) -> Result<()> {
        let Some(ref tx) = self.write_tx else {
            return Err(napi::Error::from_reason("stream closed"));
        };
        let bytes = chunk.to_vec();
        if bytes.is_empty() {
            return Ok(());
        }
        tx.send(bytes).await.map_err(|_| napi::Error::from_reason("stream closed"))
    }

    #[napi]
    pub fn reset(&self, _code: u32) -> Result<()> {
        let _ = self.write_tx.as_ref().map(|tx| tx.try_send(vec![]));
        Ok(())
    }

    #[napi]
    pub fn stop_sending(&self, _code: u32) -> Result<()> {
        Ok(())
    }

    #[napi]
    pub fn finish(&self) -> Result<()> {
        let _ = self.write_tx.as_ref().map(|tx| tx.try_send(vec![]));
        Ok(())
    }
}

/// Bridge for an outgoing uni stream (client opens, writes).
#[napi]
pub struct ClientUniSendHandle {
    write_tx: Option<mpsc::Sender<Vec<u8>>>,
}

impl ClientUniSendHandle {
    pub fn new(write_tx: mpsc::Sender<Vec<u8>>) -> Self {
        Self {
            write_tx: Some(write_tx),
        }
    }
}

#[napi]
impl ClientUniSendHandle {
    #[napi]
    pub async fn write(&self, chunk: napi::bindgen_prelude::Buffer) -> Result<()> {
        let Some(ref tx) = self.write_tx else {
            return Err(napi::Error::from_reason("stream closed"));
        };
        let bytes = chunk.to_vec();
        if bytes.is_empty() {
            return Ok(());
        }
        tx.send(bytes).await.map_err(|_| napi::Error::from_reason("stream closed"))
    }

    #[napi]
    pub fn reset(&self, _code: u32) -> Result<()> {
        let _ = self.write_tx.as_ref().map(|tx| tx.try_send(vec![]));
        Ok(())
    }
}

/// Bridge for an incoming uni stream (client receives, reads).
#[napi]
pub struct ClientUniRecvHandle {
    read_rx: Arc<TokioMutex<mpsc::Receiver<Vec<u8>>>>,
}

impl ClientUniRecvHandle {
    pub fn new(read_rx: mpsc::Receiver<Vec<u8>>) -> Self {
        Self {
            read_rx: Arc::new(TokioMutex::new(read_rx)),
        }
    }
}

#[napi]
impl ClientUniRecvHandle {
    #[napi]
    pub async fn read(&self) -> Result<Option<napi::bindgen_prelude::Buffer>> {
        let read_rx = Arc::clone(&self.read_rx);
        let mut rx = read_rx.lock().await;
        Ok(rx.recv().await.map(|bytes| bytes.into()))
    }

    #[napi]
    pub fn stop_sending(&self, _code: u32) -> Result<()> {
        Ok(())
    }
}

/// Spawn bridge tasks for a bidi stream.
pub fn spawn_bidi_bridge(
    mut send_stream: wtransport::SendStream,
    mut recv_stream: wtransport::RecvStream,
) -> (mpsc::Receiver<Vec<u8>>, mpsc::Sender<Vec<u8>>) {
    spawn_bidi_bridge_on(&RUNTIME, send_stream, recv_stream)
}

/// Spawn bridge on a specific runtime (use CLIENT_RUNTIME for client streams).
pub fn spawn_bidi_bridge_on(
    rt: &tokio::runtime::Runtime,
    mut send_stream: wtransport::SendStream,
    mut recv_stream: wtransport::RecvStream,
) -> (mpsc::Receiver<Vec<u8>>, mpsc::Sender<Vec<u8>>) {
    let (read_tx, read_rx) = mpsc::channel::<Vec<u8>>(256);
    let (write_tx, mut write_rx) = mpsc::channel::<Vec<u8>>(256);

    rt.spawn(async move {
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            match recv_stream.read(&mut buf).await {
                Ok(Some(n)) => {
                    if read_tx.send(buf[..n].to_vec()).await.is_err() {
                        break;
                    }
                }
                Ok(None) => break,
                Err(_) => break,
            }
        }
    });

    rt.spawn(async move {
        while let Some(chunk) = write_rx.recv().await {
            if chunk.is_empty() {
                break;
            }
            if send_stream.write_all(&chunk).await.is_err() {
                break;
            }
        }
    });

    (read_rx, write_tx)
}

/// Spawn bridge task for an outgoing uni stream.
pub fn spawn_uni_send_bridge(
    mut send_stream: wtransport::SendStream,
) -> mpsc::Sender<Vec<u8>> {
    spawn_uni_send_bridge_on(&RUNTIME, send_stream)
}

pub fn spawn_uni_send_bridge_on(
    rt: &tokio::runtime::Runtime,
    mut send_stream: wtransport::SendStream,
) -> mpsc::Sender<Vec<u8>> {
    let (write_tx, mut write_rx) = mpsc::channel::<Vec<u8>>(256);

    rt.spawn(async move {
        while let Some(chunk) = write_rx.recv().await {
            if chunk.is_empty() {
                break;
            }
            if send_stream.write_all(&chunk).await.is_err() {
                break;
            }
        }
    });

    write_tx
}

/// Spawn bridge task for an incoming uni stream.
pub fn spawn_uni_recv_bridge(
    mut recv_stream: wtransport::RecvStream,
) -> mpsc::Receiver<Vec<u8>> {
    spawn_uni_recv_bridge_on(&RUNTIME, recv_stream)
}

pub fn spawn_uni_recv_bridge_on(
    rt: &tokio::runtime::Runtime,
    mut recv_stream: wtransport::RecvStream,
) -> mpsc::Receiver<Vec<u8>> {
    let (read_tx, read_rx) = mpsc::channel::<Vec<u8>>(256);

    rt.spawn(async move {
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            match recv_stream.read(&mut buf).await {
                Ok(Some(n)) => {
                    if read_tx.send(buf[..n].to_vec()).await.is_err() {
                        break;
                    }
                }
                Ok(None) => break, // close channel; reader gets None = EOF
                Err(_) => break,
            }
        }
    });

    read_rx
}
