//! WebTransport client. Connects to a server and exposes session API.

use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::{JsFunction, Result};
use napi_derive::napi;
use once_cell::sync::Lazy;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::{mpsc, oneshot, Mutex as TokioMutex};

use crate::client_stream::{
    spawn_bidi_bridge, spawn_uni_recv_bridge, spawn_uni_send_bridge,
    ClientBidiStreamHandle, ClientUniRecvHandle, ClientUniSendHandle,
};
use crate::RUNTIME;

static CLIENT_SESSION_ID_COUNTER: AtomicU64 = AtomicU64::new(0);
static CLIENT_HANDLE_REGISTRY: Lazy<Mutex<HashMap<String, ClientSessionHandle>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Result for connect callback to avoid napi::Result type confusion.
#[derive(Clone)]
enum ConnectResult {
    Ok(String),
    Err(String),
}

/// Client session closed event for JS callback.
#[derive(Clone, Debug)]
pub struct ClientSessionClosed {
    pub id: String,
    pub code: Option<u32>,
    pub reason: Option<String>,
}

const DEFAULT_BACKPRESSURE_TIMEOUT_MS: u64 = 5000;
const DEFAULT_MAX_DATAGRAM_SIZE: usize = 1200;

/// Request to open a bidi stream. Response sent via oneshot.
type OpenBiReq = oneshot::Sender<std::result::Result<ClientBidiStreamHandle, String>>;
type OpenUniReq = oneshot::Sender<std::result::Result<ClientUniSendHandle, String>>;
type AcceptBiReq = oneshot::Sender<std::result::Result<ClientBidiStreamHandle, String>>;
type AcceptUniReq = oneshot::Sender<std::result::Result<ClientUniRecvHandle, String>>;

#[napi]
#[derive(Clone)]
pub struct ClientSessionHandle {
    id: String,
    peer_ip: String,
    peer_port: u32,
    dgram_send_tx: Option<mpsc::Sender<Vec<u8>>>,
    dgram_recv_rx: Arc<TokioMutex<mpsc::Receiver<Vec<u8>>>>,
    backpressure_timeout_ms: u64,
    max_datagram_size: usize,
    stream_open_bi_tx: Option<mpsc::Sender<OpenBiReq>>,
    stream_open_uni_tx: Option<mpsc::Sender<OpenUniReq>>,
    stream_accept_bi_tx: Option<mpsc::Sender<AcceptBiReq>>,
    stream_accept_uni_tx: Option<mpsc::Sender<AcceptUniReq>>,
}

#[napi]
impl ClientSessionHandle {
    #[napi(getter)]
    pub fn id(&self) -> String {
        self.id.clone()
    }

    #[napi(getter)]
    pub fn peer_ip(&self) -> String {
        self.peer_ip.clone()
    }

    #[napi(getter)]
    pub fn peer_port(&self) -> u32 {
        self.peer_port
    }

    #[napi]
    pub async fn send_datagram(&self, data: napi::bindgen_prelude::Buffer) -> Result<()> {
        let Some(ref tx) = self.dgram_send_tx else {
            return Err(napi::Error::from_reason("session closed"));
        };
        let bytes = data.to_vec();
        if bytes.len() > self.max_datagram_size {
            return Err(napi::Error::from_reason(format!(
                "datagram size {} exceeds max {}",
                bytes.len(),
                self.max_datagram_size
            )));
        }
        let timeout = tokio::time::Duration::from_millis(self.backpressure_timeout_ms);
        tokio::time::timeout(timeout, tx.send(bytes))
            .await
            .map_err(|_| napi::Error::from_reason("E_BACKPRESSURE_TIMEOUT"))?
            .map_err(|_| napi::Error::from_reason("channel closed"))?;
        Ok(())
    }

    #[napi]
    pub async fn read_datagram(&self) -> Result<Option<napi::bindgen_prelude::Buffer>> {
        let mut rx = self.dgram_recv_rx.lock().await;
        match rx.recv().await {
            Some(bytes) => Ok(Some(bytes.into())),
            None => Ok(None),
        }
    }

    #[napi]
    pub fn close(&self) -> Result<()> {
        if let Some(ref tx) = self.dgram_send_tx {
            let _ = tx.try_send(vec![]);
        }
        Ok(())
    }

    #[napi]
    pub fn metrics_snapshot(&self) -> Result<crate::metrics::SessionMetricsSnapshot> {
        Ok(crate::metrics::SessionMetricsSnapshot {
            datagrams_in: 0,
            datagrams_out: 0,
            streams_active: 0,
            queued_bytes: 0,
        })
    }

    #[napi]
    pub async fn create_bidi_stream(&self) -> Result<ClientBidiStreamHandle> {
        let Some(ref tx) = self.stream_open_bi_tx else {
            return Err(napi::Error::from_reason("session closed"));
        };
        let (resp_tx, resp_rx) = oneshot::channel();
        tx.send(resp_tx).await.map_err(|_| {
            napi::Error::from_reason("session closed")
        })?;
        resp_rx.await.map_err(|_| napi::Error::from_reason("session closed"))?
            .map_err(|e| napi::Error::from_reason(e))
    }

    #[napi]
    pub async fn create_uni_stream(&self) -> Result<ClientUniSendHandle> {
        let Some(ref tx) = self.stream_open_uni_tx else {
            return Err(napi::Error::from_reason("session closed"));
        };
        let (resp_tx, resp_rx) = oneshot::channel();
        tx.send(resp_tx).await.map_err(|_| {
            napi::Error::from_reason("session closed")
        })?;
        resp_rx.await.map_err(|_| napi::Error::from_reason("session closed"))?
            .map_err(|e| napi::Error::from_reason(e))
    }

    #[napi]
    pub async fn accept_bidi_stream(&self) -> Result<Option<ClientBidiStreamHandle>> {
        let Some(ref tx) = self.stream_accept_bi_tx else {
            return Err(napi::Error::from_reason("session closed"));
        };
        let (resp_tx, resp_rx) = oneshot::channel();
        tx.send(resp_tx).await.map_err(|_| {
            napi::Error::from_reason("session closed")
        })?;
        match resp_rx.await.map_err(|_| napi::Error::from_reason("session closed"))? {
            Ok(h) => Ok(Some(h)),
            Err(_) => Ok(None),
        }
    }

    #[napi]
    pub async fn accept_uni_stream(&self) -> Result<Option<ClientUniRecvHandle>> {
        let Some(ref tx) = self.stream_accept_uni_tx else {
            return Err(napi::Error::from_reason("session closed"));
        };
        let (resp_tx, resp_rx) = oneshot::channel();
        tx.send(resp_tx).await.map_err(|_| {
            napi::Error::from_reason("session closed")
        })?;
        match resp_rx.await.map_err(|_| napi::Error::from_reason("session closed"))? {
            Ok(h) => Ok(Some(h)),
            Err(_) => Ok(None),
        }
    }
}

impl ClientSessionHandle {
    pub fn spawn_session_task(
        id: String,
        peer_ip: String,
        peer_port: u32,
        conn: wtransport::Connection,
        on_closed: Option<ThreadsafeFunction<ClientSessionClosed, ErrorStrategy::Fatal>>,
    ) -> Self {
        let (dgram_send_tx, mut dgram_send_rx) = mpsc::channel::<Vec<u8>>(256);
        let (dgram_recv_tx, dgram_recv_rx) = mpsc::channel::<Vec<u8>>(256);
        let (open_bi_tx, mut open_bi_rx) = mpsc::channel::<OpenBiReq>(8);
        let (open_uni_tx, mut open_uni_rx) = mpsc::channel::<OpenUniReq>(8);
        let (accept_bi_tx, accept_bi_rx) = mpsc::channel::<AcceptBiReq>(8);
        let (accept_uni_tx, accept_uni_rx) = mpsc::channel::<AcceptUniReq>(8);

        let handle = Self {
            id: id.clone(),
            peer_ip: peer_ip.clone(),
            peer_port,
            dgram_send_tx: Some(dgram_send_tx.clone()),
            dgram_recv_rx: Arc::new(TokioMutex::new(dgram_recv_rx)),
            backpressure_timeout_ms: DEFAULT_BACKPRESSURE_TIMEOUT_MS,
            max_datagram_size: DEFAULT_MAX_DATAGRAM_SIZE,
            stream_open_bi_tx: Some(open_bi_tx),
            stream_open_uni_tx: Some(open_uni_tx),
            stream_accept_bi_tx: Some(accept_bi_tx),
            stream_accept_uni_tx: Some(accept_uni_tx),
        };

        let conn_bi = conn.clone();
        let conn_uni = conn.clone();
        let conn_accept_bi = conn.clone();
        let conn_accept_uni = conn.clone();

        RUNTIME.spawn(async move {
            let conn_dgram_send = conn.clone();
            let conn_dgram_recv = conn.clone();
            let conn_closed = conn.clone();

            tokio::spawn(async move {
                while let Some(bytes) = dgram_send_rx.recv().await {
                    if bytes.is_empty() {
                        conn.close(0u32.into(), b"client close");
                        break;
                    }
                    let _ = conn_dgram_send.send_datagram(bytes.as_slice());
                }
            });

            tokio::spawn(async move {
                while let Ok(dgram) = conn_dgram_recv.receive_datagram().await {
                    if dgram_recv_tx.send(dgram.as_ref().to_vec()).await.is_err() {
                        break;
                    }
                }
            });

            tokio::spawn(async move {
                while let Some(resp_tx) = open_bi_rx.recv().await {
                    let r = match conn_bi.open_bi().await {
                        Ok(opening) => match opening.await {
                            Ok((send, recv)) => {
                                let (read_rx, write_tx) = spawn_bidi_bridge(send, recv);
                                Ok(ClientBidiStreamHandle::new(read_rx, write_tx))
                            }
                            Err(e) => Err(e.to_string()),
                        },
                        Err(e) => Err(e.to_string()),
                    };
                    let _ = resp_tx.send(r);
                }
            });

            tokio::spawn(async move {
                while let Some(resp_tx) = open_uni_rx.recv().await {
                    let r = match conn_uni.open_uni().await {
                        Ok(opening) => match opening.await {
                            Ok(send) => {
                                let write_tx = spawn_uni_send_bridge(send);
                                Ok(ClientUniSendHandle::new(write_tx))
                            }
                            Err(e) => Err(e.to_string()),
                        },
                        Err(e) => Err(e.to_string()),
                    };
                    let _ = resp_tx.send(r);
                }
            });

            let mut accept_bi_rx = accept_bi_rx;
            tokio::spawn(async move {
                while let Some(resp_tx) = accept_bi_rx.recv().await {
                    let r = match conn_accept_bi.accept_bi().await {
                        Ok((send, recv)) => {
                            let (read_rx, write_tx) = spawn_bidi_bridge(send, recv);
                            Ok(ClientBidiStreamHandle::new(read_rx, write_tx))
                        }
                        Err(e) => Err(e.to_string()),
                    };
                    let _ = resp_tx.send(r);
                }
            });

            let mut accept_uni_rx_local = accept_uni_rx;
            tokio::spawn(async move {
                while let Some(resp_tx) = accept_uni_rx_local.recv().await {
                    let r = match conn_accept_uni.accept_uni().await {
                        Ok(recv) => {
                            let read_rx = spawn_uni_recv_bridge(recv);
                            Ok(ClientUniRecvHandle::new(read_rx))
                        }
                        Err(e) => Err(e.to_string()),
                    };
                    let _ = resp_tx.send(r);
                }
            });

            conn_closed.closed().await;
            if let Some(ref tsfn) = on_closed {
                tsfn.call(
                    ClientSessionClosed {
                        id: id.clone(),
                        code: None,
                        reason: None,
                    },
                    ThreadsafeFunctionCallMode::NonBlocking,
                );
            }
        });

        handle
    }
}

/// Connect to a WebTransport server. Calls callback(err, handleId) when done.
/// On success, use takeClientSession(handleId) to get the handle.
#[napi]
pub fn connect(
    url: String,
    opts_json: String,
    on_closed: JsFunction,
    callback: JsFunction,
) -> Result<()> {
    let on_closed_tsfn: Option<ThreadsafeFunction<ClientSessionClosed, ErrorStrategy::Fatal>> =
        on_closed
            .create_threadsafe_function(
                0,
                |ctx: napi::threadsafe_function::ThreadSafeCallContext<ClientSessionClosed>| {
                    let v = &ctx.value;
                    let mut evt = ctx.env.create_object()?;
                    evt.set("name", "session_closed")?;
                    evt.set("id", v.id.as_str())?;
                    if let Some(c) = v.code {
                        evt.set("code", c)?;
                    }
                    if let Some(r) = &v.reason {
                        evt.set("reason", r.as_str())?;
                    }
                    let mut arr = ctx.env.create_array_with_length(1)?;
                    arr.set_element(0, evt)?;
                    Ok(vec![arr])
                },
            )
            .ok();

    let callback_tsfn: ThreadsafeFunction<ConnectResult, ErrorStrategy::Fatal> = callback
        .create_threadsafe_function(
            0,
            |ctx: napi::threadsafe_function::ThreadSafeCallContext<ConnectResult>| match &ctx.value
            {
                ConnectResult::Ok(handle_id) => {
                    let null = ctx.env.get_null()?.into_unknown();
                    let id_val = ctx.env.create_string(handle_id)?.into_unknown();
                    Ok(vec![null, id_val])
                }
                ConnectResult::Err(msg) => {
                    let err_str = ctx.env.create_string(msg)?.into_unknown();
                    let undef = ctx.env.get_undefined()?.into_unknown();
                    Ok(vec![err_str, undef])
                }
            },
        )?;

    RUNTIME.spawn(async move {
        let result = match run_connect(&url, opts_json)
            .await
            .map_err(|e| e.to_string())
            .and_then(|(id, peer_ip, peer_port, conn)| {
                let handle = ClientSessionHandle::spawn_session_task(
                    id.clone(),
                    peer_ip,
                    peer_port,
                    conn,
                    on_closed_tsfn,
                );
                if let Ok(mut reg) = CLIENT_HANDLE_REGISTRY.lock() {
                    reg.insert(id.clone(), handle);
                }
                Ok(id)
            }) {
            std::result::Result::Ok(id) => ConnectResult::Ok(id),
            std::result::Result::Err(msg) => ConnectResult::Err(msg),
        };
        callback_tsfn.call(result, ThreadsafeFunctionCallMode::NonBlocking);
    });

    Ok(())
}

/// Take the client session handle from the registry. Call after connect callback succeeds.
#[napi]
pub fn take_client_session(handle_id: String) -> Result<Option<ClientSessionHandle>> {
    let mut reg = CLIENT_HANDLE_REGISTRY
        .lock()
        .map_err(|_| napi::Error::from_reason("registry lock poisoned"))?;
    Ok(reg.remove(&handle_id))
}

async fn run_connect(
    url: &str,
    _opts_json: String,
) -> std::result::Result<
    (String, String, u32, wtransport::Connection),
    Box<dyn std::error::Error + Send + Sync>,
> {
    let config = wtransport::ClientConfig::builder()
        .with_bind_default()
        .with_no_cert_validation()
        .build();

    let endpoint = wtransport::Endpoint::client(config)?;
    let conn = endpoint.connect(url).await?;

    let id = format!(
        "client-{}",
        CLIENT_SESSION_ID_COUNTER.fetch_add(1, Ordering::Relaxed)
    );
    let addr = conn.remote_address();
    let peer_ip = addr.ip().to_string();
    let peer_port = addr.port() as u32;

    Ok((id, peer_ip, peer_port, conn))
}
