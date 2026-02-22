//! Stream handles: bridge wtransport QUIC streams to napi async read/write.
//!
//! Architecture:
//! - Write bridge: receives StreamCmd (Data/Finish/Reset) from a bounded mpsc channel.
//! - Read bridge: sends Vec<u8> to a bounded mpsc channel; selects on a stop_sending oneshot.
//! - read() awaits directly on the napi runtime (cross-runtime channel waker).

use napi::Result;
use napi_derive::napi;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::{mpsc, oneshot, Mutex as TokioMutex};
use wtransport::VarInt;

use crate::RUNTIME;

/// Commands sent from JS to the write bridge task.
pub enum StreamCmd {
    Data(Vec<u8>),
    Finish,
    Reset(u32),
}

/// Holds a closure that runs on drop to decrement stream counters.
/// Used by bridge tasks to properly track stream lifecycle.
pub struct StreamGuard {
    on_drop: Option<Box<dyn FnOnce() + Send>>,
}

impl StreamGuard {
    pub fn new(f: impl FnOnce() + Send + 'static) -> Self {
        Self {
            on_drop: Some(Box::new(f)),
        }
    }
}

impl Drop for StreamGuard {
    fn drop(&mut self) {
        if let Some(f) = self.on_drop.take() {
            f();
        }
    }
}

/// Byte-accounted budget for stream data in transit through channels.
/// Three-level reservation: global → session → stream.
/// Reserve before enqueue, release after dequeue.
#[derive(Clone)]
pub struct StreamBudget {
    pub server_metrics: Arc<crate::server_metrics::ServerMetrics>,
    pub session_metrics: Arc<crate::session_registry::SessionMetrics>,
    pub stream_queued: Arc<AtomicU64>,
    pub max_global: u64,
    pub max_session: u64,
    pub max_stream: u64,
}

impl StreamBudget {
    pub fn try_reserve(&self, n: u64) -> bool {
        if !self
            .server_metrics
            .try_reserve_queued_bytes(n, self.max_global)
        {
            return false;
        }
        let session_ok = self
            .session_metrics
            .queued_bytes
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |c| {
                if c + n <= self.max_session {
                    Some(c + n)
                } else {
                    None
                }
            })
            .is_ok();
        if !session_ok {
            self.server_metrics.release_queued_bytes(n);
            return false;
        }
        let stream_ok = self
            .stream_queued
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |c| {
                if c + n <= self.max_stream {
                    Some(c + n)
                } else {
                    None
                }
            })
            .is_ok();
        if !stream_ok {
            self.session_metrics
                .queued_bytes
                .fetch_sub(n, Ordering::Relaxed);
            self.server_metrics.release_queued_bytes(n);
            return false;
        }
        true
    }

    pub fn release(&self, n: u64) {
        self.stream_queued.fetch_sub(n, Ordering::Relaxed);
        self.session_metrics
            .queued_bytes
            .fetch_sub(n, Ordering::Relaxed);
        self.server_metrics.release_queued_bytes(n);
    }
}

// ---------------------------------------------------------------------------
// Bidi stream handle
// ---------------------------------------------------------------------------

#[napi]
pub struct ClientBidiStreamHandle {
    read_rx: Arc<TokioMutex<mpsc::Receiver<Vec<u8>>>>,
    write_tx: Option<mpsc::Sender<StreamCmd>>,
    stop_tx: std::sync::Mutex<Option<oneshot::Sender<u32>>>,
    budget: Option<StreamBudget>,
}

impl ClientBidiStreamHandle {
    pub fn new(
        read_rx: mpsc::Receiver<Vec<u8>>,
        write_tx: mpsc::Sender<StreamCmd>,
        stop_tx: oneshot::Sender<u32>,
    ) -> Self {
        Self {
            read_rx: Arc::new(TokioMutex::new(read_rx)),
            write_tx: Some(write_tx),
            stop_tx: std::sync::Mutex::new(Some(stop_tx)),
            budget: None,
        }
    }

    pub fn new_with_budget(
        read_rx: mpsc::Receiver<Vec<u8>>,
        write_tx: mpsc::Sender<StreamCmd>,
        stop_tx: oneshot::Sender<u32>,
        budget: Option<StreamBudget>,
    ) -> Self {
        Self {
            read_rx: Arc::new(TokioMutex::new(read_rx)),
            write_tx: Some(write_tx),
            stop_tx: std::sync::Mutex::new(Some(stop_tx)),
            budget,
        }
    }

    pub fn new_client_stream(
        read_rx: mpsc::Receiver<Vec<u8>>,
        write_tx: mpsc::Sender<StreamCmd>,
        stop_tx: oneshot::Sender<u32>,
    ) -> Self {
        Self::new(read_rx, write_tx, stop_tx)
    }
}

#[napi]
impl ClientBidiStreamHandle {
    #[napi]
    pub async fn read(&self) -> Result<Option<napi::bindgen_prelude::Buffer>> {
        let read_rx = Arc::clone(&self.read_rx);
        let mut rx = read_rx.lock().await;
        match rx.recv().await {
            Some(bytes) => {
                if let Some(ref b) = self.budget {
                    b.release(bytes.len() as u64);
                }
                Ok(Some(bytes.into()))
            }
            None => Ok(None),
        }
    }

    #[napi]
    pub async fn write(&self, chunk: napi::bindgen_prelude::Buffer) -> Result<()> {
        let Some(ref tx) = self.write_tx else {
            return Err(napi::Error::from_reason("E_STREAM_RESET"));
        };
        let bytes = chunk.to_vec();
        if bytes.is_empty() {
            return Ok(());
        }
        let sz = bytes.len() as u64;
        if let Some(ref b) = self.budget {
            if !b.try_reserve(sz) {
                return Err(napi::Error::from_reason("E_QUEUE_FULL"));
            }
        }
        if tx.send(StreamCmd::Data(bytes)).await.is_err() {
            if let Some(ref b) = self.budget {
                b.release(sz);
            }
            return Err(napi::Error::from_reason("E_STREAM_RESET"));
        }
        Ok(())
    }

    #[napi]
    pub fn reset(&self, code: u32) -> Result<()> {
        let _ = self
            .write_tx
            .as_ref()
            .map(|tx| tx.try_send(StreamCmd::Reset(code)));
        Ok(())
    }

    #[napi]
    pub fn stop_sending(&self, code: u32) -> Result<()> {
        if let Ok(mut guard) = self.stop_tx.lock() {
            if let Some(tx) = guard.take() {
                let _ = tx.send(code);
            }
        }
        Ok(())
    }

    #[napi]
    pub fn finish(&self) -> Result<()> {
        let _ = self
            .write_tx
            .as_ref()
            .map(|tx| tx.try_send(StreamCmd::Finish));
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Outgoing uni stream handle (write-only)
// ---------------------------------------------------------------------------

#[napi]
pub struct ClientUniSendHandle {
    write_tx: Option<mpsc::Sender<StreamCmd>>,
    budget: Option<StreamBudget>,
}

impl ClientUniSendHandle {
    pub fn new(write_tx: mpsc::Sender<StreamCmd>) -> Self {
        Self {
            write_tx: Some(write_tx),
            budget: None,
        }
    }

    pub fn new_with_budget(
        write_tx: mpsc::Sender<StreamCmd>,
        budget: Option<StreamBudget>,
    ) -> Self {
        Self {
            write_tx: Some(write_tx),
            budget,
        }
    }
}

#[napi]
impl ClientUniSendHandle {
    #[napi]
    pub async fn write(&self, chunk: napi::bindgen_prelude::Buffer) -> Result<()> {
        let Some(ref tx) = self.write_tx else {
            return Err(napi::Error::from_reason("E_STREAM_RESET"));
        };
        let bytes = chunk.to_vec();
        if bytes.is_empty() {
            return Ok(());
        }
        let sz = bytes.len() as u64;
        if let Some(ref b) = self.budget {
            if !b.try_reserve(sz) {
                return Err(napi::Error::from_reason("E_QUEUE_FULL"));
            }
        }
        if tx.send(StreamCmd::Data(bytes)).await.is_err() {
            if let Some(ref b) = self.budget {
                b.release(sz);
            }
            return Err(napi::Error::from_reason("E_STREAM_RESET"));
        }
        Ok(())
    }

    #[napi]
    pub fn reset(&self, code: u32) -> Result<()> {
        let _ = self
            .write_tx
            .as_ref()
            .map(|tx| tx.try_send(StreamCmd::Reset(code)));
        Ok(())
    }

    #[napi]
    pub fn finish(&self) -> Result<()> {
        let _ = self
            .write_tx
            .as_ref()
            .map(|tx| tx.try_send(StreamCmd::Finish));
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Incoming uni stream handle (read-only)
// ---------------------------------------------------------------------------

#[napi]
pub struct ClientUniRecvHandle {
    read_rx: Arc<TokioMutex<mpsc::Receiver<Vec<u8>>>>,
    stop_tx: std::sync::Mutex<Option<oneshot::Sender<u32>>>,
    budget: Option<StreamBudget>,
}

impl ClientUniRecvHandle {
    pub fn new(read_rx: mpsc::Receiver<Vec<u8>>, stop_tx: oneshot::Sender<u32>) -> Self {
        Self {
            read_rx: Arc::new(TokioMutex::new(read_rx)),
            stop_tx: std::sync::Mutex::new(Some(stop_tx)),
            budget: None,
        }
    }

    pub fn new_with_budget(
        read_rx: mpsc::Receiver<Vec<u8>>,
        stop_tx: oneshot::Sender<u32>,
        budget: Option<StreamBudget>,
    ) -> Self {
        Self {
            read_rx: Arc::new(TokioMutex::new(read_rx)),
            stop_tx: std::sync::Mutex::new(Some(stop_tx)),
            budget,
        }
    }
}

#[napi]
impl ClientUniRecvHandle {
    #[napi]
    pub async fn read(&self) -> Result<Option<napi::bindgen_prelude::Buffer>> {
        let read_rx = Arc::clone(&self.read_rx);
        let mut rx = read_rx.lock().await;
        match rx.recv().await {
            Some(bytes) => {
                if let Some(ref b) = self.budget {
                    b.release(bytes.len() as u64);
                }
                Ok(Some(bytes.into()))
            }
            None => Ok(None),
        }
    }

    #[napi]
    pub fn stop_sending(&self, code: u32) -> Result<()> {
        if let Ok(mut guard) = self.stop_tx.lock() {
            if let Some(tx) = guard.take() {
                let _ = tx.send(code);
            }
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Bridge spawn functions
// ---------------------------------------------------------------------------

/// Spawn bridge tasks for a bidi stream on the server runtime.
pub fn spawn_bidi_bridge(
    send_stream: wtransport::SendStream,
    recv_stream: wtransport::RecvStream,
    guard: Option<StreamGuard>,
    budget: Option<StreamBudget>,
) -> (
    mpsc::Receiver<Vec<u8>>,
    mpsc::Sender<StreamCmd>,
    oneshot::Sender<u32>,
) {
    spawn_bidi_bridge_on(&RUNTIME, send_stream, recv_stream, guard, budget)
}

/// Spawn bridge on a specific runtime (use CLIENT_RUNTIME for client streams).
pub fn spawn_bidi_bridge_on(
    rt: &tokio::runtime::Runtime,
    mut send_stream: wtransport::SendStream,
    mut recv_stream: wtransport::RecvStream,
    guard: Option<StreamGuard>,
    budget: Option<StreamBudget>,
) -> (
    mpsc::Receiver<Vec<u8>>,
    mpsc::Sender<StreamCmd>,
    oneshot::Sender<u32>,
) {
    let (read_tx, read_rx) = mpsc::channel::<Vec<u8>>(256);
    let (write_tx, mut write_rx) = mpsc::channel::<StreamCmd>(256);
    let (stop_tx, stop_rx) = oneshot::channel::<u32>();

    let read_budget = budget.clone();
    rt.spawn(async move {
        let _guard = guard;
        let mut buf = vec![0u8; 64 * 1024];
        let mut stop_rx = stop_rx;
        loop {
            tokio::select! {
                res = recv_stream.read(&mut buf) => {
                    match res {
                        Ok(Some(n)) => {
                            let sz = n as u64;
                            if let Some(ref b) = read_budget {
                                if !b.try_reserve(sz) {
                                    continue;
                                }
                            }
                            if read_tx.send(buf[..n].to_vec()).await.is_err() {
                                if let Some(ref b) = read_budget {
                                    b.release(sz);
                                }
                                break;
                            }
                        }
                        Ok(None) => break,
                        Err(_) => break,
                    }
                }
                code = &mut stop_rx => {
                    if let Ok(c) = code {
                        recv_stream.stop(VarInt::from_u32(c));
                    }
                    break;
                }
            }
        }
    });

    let write_budget = budget;
    rt.spawn(async move {
        while let Some(cmd) = write_rx.recv().await {
            match cmd {
                StreamCmd::Data(chunk) => {
                    let sz = chunk.len() as u64;
                    if send_stream.write_all(&chunk).await.is_err() {
                        if let Some(ref b) = write_budget {
                            b.release(sz);
                        }
                        break;
                    }
                    if let Some(ref b) = write_budget {
                        b.release(sz);
                    }
                }
                StreamCmd::Finish => {
                    let _ = send_stream.finish().await;
                    break;
                }
                StreamCmd::Reset(code) => {
                    let _ = send_stream.reset(VarInt::from_u32(code));
                    break;
                }
            }
        }
    });

    (read_rx, write_tx, stop_tx)
}

/// Spawn bridge for an outgoing uni stream.
pub fn spawn_uni_send_bridge(
    send_stream: wtransport::SendStream,
    guard: Option<StreamGuard>,
    budget: Option<StreamBudget>,
) -> mpsc::Sender<StreamCmd> {
    spawn_uni_send_bridge_on(&RUNTIME, send_stream, guard, budget)
}

pub fn spawn_uni_send_bridge_on(
    rt: &tokio::runtime::Runtime,
    mut send_stream: wtransport::SendStream,
    guard: Option<StreamGuard>,
    budget: Option<StreamBudget>,
) -> mpsc::Sender<StreamCmd> {
    let (write_tx, mut write_rx) = mpsc::channel::<StreamCmd>(256);

    rt.spawn(async move {
        let _guard = guard;
        while let Some(cmd) = write_rx.recv().await {
            match cmd {
                StreamCmd::Data(chunk) => {
                    let sz = chunk.len() as u64;
                    if send_stream.write_all(&chunk).await.is_err() {
                        if let Some(ref b) = budget {
                            b.release(sz);
                        }
                        break;
                    }
                    if let Some(ref b) = budget {
                        b.release(sz);
                    }
                }
                StreamCmd::Finish => {
                    let _ = send_stream.finish().await;
                    break;
                }
                StreamCmd::Reset(code) => {
                    let _ = send_stream.reset(VarInt::from_u32(code));
                    break;
                }
            }
        }
    });

    write_tx
}

/// Spawn bridge for an incoming uni stream.
pub fn spawn_uni_recv_bridge(
    recv_stream: wtransport::RecvStream,
    guard: Option<StreamGuard>,
    budget: Option<StreamBudget>,
) -> (mpsc::Receiver<Vec<u8>>, oneshot::Sender<u32>) {
    spawn_uni_recv_bridge_on(&RUNTIME, recv_stream, guard, budget)
}

pub fn spawn_uni_recv_bridge_on(
    rt: &tokio::runtime::Runtime,
    mut recv_stream: wtransport::RecvStream,
    guard: Option<StreamGuard>,
    budget: Option<StreamBudget>,
) -> (mpsc::Receiver<Vec<u8>>, oneshot::Sender<u32>) {
    let (read_tx, read_rx) = mpsc::channel::<Vec<u8>>(256);
    let (stop_tx, stop_rx) = oneshot::channel::<u32>();

    rt.spawn(async move {
        let _guard = guard;
        let mut buf = vec![0u8; 64 * 1024];
        let mut stop_rx = stop_rx;
        loop {
            tokio::select! {
                res = recv_stream.read(&mut buf) => {
                    match res {
                        Ok(Some(n)) => {
                            let sz = n as u64;
                            if let Some(ref b) = budget {
                                if !b.try_reserve(sz) {
                                    continue;
                                }
                            }
                            if read_tx.send(buf[..n].to_vec()).await.is_err() {
                                if let Some(ref b) = budget {
                                    b.release(sz);
                                }
                                break;
                            }
                        }
                        Ok(None) => break,
                        Err(_) => break,
                    }
                }
                code = &mut stop_rx => {
                    if let Ok(c) = code {
                        recv_stream.stop(VarInt::from_u32(c));
                    }
                    break;
                }
            }
        }
    });

    (read_rx, stop_tx)
}
