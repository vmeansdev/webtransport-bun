//! WebTransport client. Connects to a server and exposes session API.

use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::{JsFunction, Result};
use napi_derive::napi;
use once_cell::sync::Lazy;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::{mpsc, oneshot, watch, Mutex as TokioMutex};

/// Per-client-session atomic metrics.
#[derive(Default)]
pub struct ClientMetrics {
    pub datagrams_in: AtomicU64,
    pub datagrams_out: AtomicU64,
    pub streams_active: AtomicU64,
    pub queued_bytes: AtomicU64,
}

use crate::client_stream::{
    spawn_bidi_bridge_on, spawn_uni_recv_bridge_on, spawn_uni_send_bridge_on,
    ClientBidiStreamHandle, ClientUniRecvHandle, ClientUniSendHandle, StreamBudget,
};
use crate::server_metrics::ServerMetrics;
use crate::session_registry::SessionMetrics;
use crate::CLIENT_RUNTIME;

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
    close_tx: Option<Arc<watch::Sender<(u32, String)>>>,
    client_metrics: Arc<ClientMetrics>,
    closed: Arc<std::sync::atomic::AtomicBool>,
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
        if self.closed.load(Ordering::Relaxed) {
            return Err(napi::Error::from_reason("E_SESSION_CLOSED"));
        }
        let Some(ref tx) = self.dgram_send_tx else {
            return Err(napi::Error::from_reason("E_SESSION_CLOSED"));
        };
        let bytes = data.to_vec();
        if bytes.len() > self.max_datagram_size {
            return Err(napi::Error::from_reason("E_QUEUE_FULL"));
        }
        let sz = bytes.len() as u64;
        let timeout = tokio::time::Duration::from_millis(self.backpressure_timeout_ms);
        self.client_metrics
            .queued_bytes
            .fetch_add(sz, Ordering::Relaxed);
        let result = tokio::time::timeout(timeout, tx.send(bytes)).await;
        match result {
            Ok(Ok(())) => Ok(()),
            Ok(Err(_)) => {
                self.client_metrics
                    .queued_bytes
                    .fetch_sub(sz, Ordering::Relaxed);
                Err(napi::Error::from_reason("E_SESSION_CLOSED"))
            }
            Err(_) => {
                self.client_metrics
                    .queued_bytes
                    .fetch_sub(sz, Ordering::Relaxed);
                Err(napi::Error::from_reason("E_BACKPRESSURE_TIMEOUT"))
            }
        }
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
    pub fn close(&self, code: Option<u32>, reason: Option<String>) -> Result<()> {
        self.closed.store(true, Ordering::Relaxed);
        let c = code.unwrap_or(0);
        let r = reason.unwrap_or_default();
        if let Some(ref tx) = self.close_tx {
            let _ = tx.send((c, r));
        }
        Ok(())
    }

    #[napi]
    pub fn metrics_snapshot(&self) -> Result<crate::metrics::SessionMetricsSnapshot> {
        Ok(crate::metrics::SessionMetricsSnapshot {
            datagrams_in: self.client_metrics.datagrams_in.load(Ordering::Relaxed) as u32,
            datagrams_out: self.client_metrics.datagrams_out.load(Ordering::Relaxed) as u32,
            streams_active: self.client_metrics.streams_active.load(Ordering::Relaxed) as u32,
            queued_bytes: self.client_metrics.queued_bytes.load(Ordering::Relaxed) as u32,
        })
    }

    #[napi]
    pub async fn create_bidi_stream(&self) -> Result<ClientBidiStreamHandle> {
        let Some(ref tx) = self.stream_open_bi_tx else {
            return Err(napi::Error::from_reason("E_SESSION_CLOSED"));
        };
        let (resp_tx, resp_rx) = oneshot::channel();
        tx.send(resp_tx)
            .await
            .map_err(|_| napi::Error::from_reason("E_SESSION_CLOSED"))?;
        resp_rx
            .await
            .map_err(|_| napi::Error::from_reason("E_SESSION_CLOSED"))?
            .map_err(napi::Error::from_reason)
    }

    #[napi]
    pub async fn create_uni_stream(&self) -> Result<ClientUniSendHandle> {
        let Some(ref tx) = self.stream_open_uni_tx else {
            return Err(napi::Error::from_reason("E_SESSION_CLOSED"));
        };
        let (resp_tx, resp_rx) = oneshot::channel();
        tx.send(resp_tx)
            .await
            .map_err(|_| napi::Error::from_reason("E_SESSION_CLOSED"))?;
        resp_rx
            .await
            .map_err(|_| napi::Error::from_reason("E_SESSION_CLOSED"))?
            .map_err(napi::Error::from_reason)
    }

    #[napi]
    pub async fn accept_bidi_stream(&self) -> Result<Option<ClientBidiStreamHandle>> {
        let Some(ref tx) = self.stream_accept_bi_tx else {
            return Err(napi::Error::from_reason("E_SESSION_CLOSED"));
        };
        let (resp_tx, resp_rx) = oneshot::channel();
        tx.send(resp_tx)
            .await
            .map_err(|_| napi::Error::from_reason("E_SESSION_CLOSED"))?;
        match resp_rx
            .await
            .map_err(|_| napi::Error::from_reason("E_SESSION_CLOSED"))?
        {
            Ok(h) => Ok(Some(h)),
            Err(_) => Ok(None),
        }
    }

    #[napi]
    pub async fn accept_uni_stream(&self) -> Result<Option<ClientUniRecvHandle>> {
        let Some(ref tx) = self.stream_accept_uni_tx else {
            return Err(napi::Error::from_reason("E_SESSION_CLOSED"));
        };
        let (resp_tx, resp_rx) = oneshot::channel();
        tx.send(resp_tx)
            .await
            .map_err(|_| napi::Error::from_reason("E_SESSION_CLOSED"))?;
        match resp_rx
            .await
            .map_err(|_| napi::Error::from_reason("E_SESSION_CLOSED"))?
        {
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
        backpressure_timeout_ms: u64,
        limits: crate::limits::Limits,
    ) -> Self {
        let (dgram_send_tx, mut dgram_send_rx) = mpsc::channel::<Vec<u8>>(256);
        let (dgram_recv_tx, dgram_recv_rx) = mpsc::channel::<Vec<u8>>(256);
        let (open_bi_tx, mut open_bi_rx) = mpsc::channel::<OpenBiReq>(8);
        let (open_uni_tx, mut open_uni_rx) = mpsc::channel::<OpenUniReq>(8);
        let (accept_bi_tx, accept_bi_rx) = mpsc::channel::<AcceptBiReq>(8);
        let (accept_uni_tx, accept_uni_rx) = mpsc::channel::<AcceptUniReq>(8);
        let (close_tx, mut close_rx) = watch::channel((0u32, String::new()));
        let cm = Arc::new(ClientMetrics::default());
        let closed_flag = Arc::new(std::sync::atomic::AtomicBool::new(false));

        let budget_metrics = Arc::new(ServerMetrics::default());
        let session_metrics = Arc::new(SessionMetrics::default());
        let max_global = limits.max_queued_bytes_global;
        let max_session = limits.max_queued_bytes_per_session;
        let max_stream = limits.max_queued_bytes_per_stream;

        let handle = Self {
            id: id.clone(),
            peer_ip: peer_ip.clone(),
            peer_port,
            dgram_send_tx: Some(dgram_send_tx.clone()),
            dgram_recv_rx: Arc::new(TokioMutex::new(dgram_recv_rx)),
            backpressure_timeout_ms,
            max_datagram_size: limits.max_datagram_size,
            stream_open_bi_tx: Some(open_bi_tx),
            stream_open_uni_tx: Some(open_uni_tx),
            stream_accept_bi_tx: Some(accept_bi_tx),
            stream_accept_uni_tx: Some(accept_uni_tx),
            close_tx: Some(Arc::new(close_tx)),
            client_metrics: Arc::clone(&cm),
            closed: Arc::clone(&closed_flag),
        };

        let conn_bi = conn.clone();
        let conn_uni = conn.clone();
        let conn_accept_bi = conn.clone();
        let conn_accept_uni = conn.clone();

        let make_budget = {
            let bm = Arc::clone(&budget_metrics);
            let sm = Arc::clone(&session_metrics);
            move || StreamBudget {
                server_metrics: Arc::clone(&bm),
                session_metrics: Arc::clone(&sm),
                stream_queued: Arc::new(AtomicU64::new(0)),
                max_global,
                max_session,
                max_stream,
            }
        };

        CLIENT_RUNTIME.spawn(async move {
            let conn_dgram_send = conn.clone();
            let conn_dgram_recv = conn.clone();
            let conn_closed = conn.clone();

            let cm_send = Arc::clone(&cm);
            crate::panic_guard::spawn_quic_task(async move {
                while let Some(bytes) = dgram_send_rx.recv().await {
                    let sz = bytes.len() as u64;
                    cm_send.queued_bytes.fetch_sub(sz, Ordering::Relaxed);
                    match conn_dgram_send.send_datagram(bytes.as_slice()) {
                        Ok(_) => {
                            cm_send.datagrams_out.fetch_add(1, Ordering::Relaxed);
                        }
                        Err(_) => break,
                    }
                }
            });

            let cm_recv = Arc::clone(&cm);
            crate::panic_guard::spawn_quic_task(async move {
                while let Ok(dgram) = conn_dgram_recv.receive_datagram().await {
                    cm_recv.datagrams_in.fetch_add(1, Ordering::Relaxed);
                    if dgram_recv_tx.send(dgram.as_ref().to_vec()).await.is_err() {
                        break;
                    }
                }
            });

            let cm_bi = Arc::clone(&cm);
            let make_budget_bi = make_budget.clone();
            crate::panic_guard::spawn_quic_task(async move {
                while let Some(resp_tx) = open_bi_rx.recv().await {
                    let r = match conn_bi.open_bi().await {
                        Ok(opening) => match opening.await {
                            Ok((send, recv)) => {
                                cm_bi.streams_active.fetch_add(1, Ordering::Relaxed);
                                let cm_guard = Arc::clone(&cm_bi);
                                let guard = crate::client_stream::StreamGuard::new(move || {
                                    cm_guard.streams_active.fetch_sub(1, Ordering::Relaxed);
                                });
                                let budget = make_budget_bi();
                                let (read_rx, write_tx, stop_tx, write_err_slot) =
                                    spawn_bidi_bridge_on(
                                        &CLIENT_RUNTIME,
                                        send,
                                        recv,
                                        Some(guard),
                                        Some(budget.clone()),
                                    );
                                Ok(ClientBidiStreamHandle::new_with_budget_and_slot(
                                    read_rx,
                                    write_tx,
                                    stop_tx,
                                    Some(budget),
                                    write_err_slot,
                                ))
                            }
                            Err(e) => Err(e.to_string()),
                        },
                        Err(e) => Err(e.to_string()),
                    };
                    let _ = resp_tx.send(r);
                }
            });

            let cm_uni = Arc::clone(&cm);
            let make_budget_uni = make_budget.clone();
            crate::panic_guard::spawn_quic_task(async move {
                while let Some(resp_tx) = open_uni_rx.recv().await {
                    let r = match conn_uni.open_uni().await {
                        Ok(opening) => match opening.await {
                            Ok(send) => {
                                cm_uni.streams_active.fetch_add(1, Ordering::Relaxed);
                                let cm_guard = Arc::clone(&cm_uni);
                                let guard = crate::client_stream::StreamGuard::new(move || {
                                    cm_guard.streams_active.fetch_sub(1, Ordering::Relaxed);
                                });
                                let budget = make_budget_uni();
                                let (write_tx, write_err_slot) = spawn_uni_send_bridge_on(
                                    &CLIENT_RUNTIME,
                                    send,
                                    Some(guard),
                                    Some(budget.clone()),
                                );
                                Ok(ClientUniSendHandle::new_with_budget_and_slot(
                                    write_tx,
                                    Some(budget),
                                    write_err_slot,
                                ))
                            }
                            Err(e) => Err(e.to_string()),
                        },
                        Err(e) => Err(e.to_string()),
                    };
                    let _ = resp_tx.send(r);
                }
            });

            let mut accept_bi_rx = accept_bi_rx;
            let cm_accept_bi = Arc::clone(&cm);
            let make_budget_accept_bi = make_budget.clone();
            crate::panic_guard::spawn_quic_task(async move {
                while let Some(resp_tx) = accept_bi_rx.recv().await {
                    let r = match conn_accept_bi.accept_bi().await {
                        Ok((send, recv)) => {
                            cm_accept_bi.streams_active.fetch_add(1, Ordering::Relaxed);
                            let cm_guard = Arc::clone(&cm_accept_bi);
                            let guard = crate::client_stream::StreamGuard::new(move || {
                                cm_guard.streams_active.fetch_sub(1, Ordering::Relaxed);
                            });
                            let budget = make_budget_accept_bi();
                            let (read_rx, write_tx, stop_tx, write_err_slot) = spawn_bidi_bridge_on(
                                &CLIENT_RUNTIME,
                                send,
                                recv,
                                Some(guard),
                                Some(budget.clone()),
                            );
                            Ok(ClientBidiStreamHandle::new_with_budget_and_slot(
                                read_rx,
                                write_tx,
                                stop_tx,
                                Some(budget),
                                write_err_slot,
                            ))
                        }
                        Err(e) => Err(e.to_string()),
                    };
                    let _ = resp_tx.send(r);
                }
            });

            let mut accept_uni_rx_local = accept_uni_rx;
            let cm_accept_uni = Arc::clone(&cm);
            let make_budget_accept_uni = make_budget.clone();
            crate::panic_guard::spawn_quic_task(async move {
                while let Some(resp_tx) = accept_uni_rx_local.recv().await {
                    let r = match conn_accept_uni.accept_uni().await {
                        Ok(recv) => {
                            cm_accept_uni.streams_active.fetch_add(1, Ordering::Relaxed);
                            let cm_guard = Arc::clone(&cm_accept_uni);
                            let guard = crate::client_stream::StreamGuard::new(move || {
                                cm_guard.streams_active.fetch_sub(1, Ordering::Relaxed);
                            });
                            let budget = make_budget_accept_uni();
                            let (read_rx, stop_tx) = spawn_uni_recv_bridge_on(
                                &CLIENT_RUNTIME,
                                recv,
                                Some(guard),
                                Some(budget.clone()),
                            );
                            Ok(ClientUniRecvHandle::new_with_budget(
                                read_rx,
                                stop_tx,
                                Some(budget),
                            ))
                        }
                        Err(e) => Err(e.to_string()),
                    };
                    let _ = resp_tx.send(r);
                }
            });

            let (close_code, close_reason) = tokio::select! {
                close_err = conn_closed.closed() => {
                    crate::extract_close_info(&close_err)
                }
                _ = close_rx.changed() => {
                    let (code, reason) = close_rx.borrow().clone();
                    conn_closed.close(wtransport::VarInt::from_u32(code), reason.as_bytes());
                    (Some(code), Some(reason))
                }
            };
            closed_flag.store(true, Ordering::Relaxed);

            if let Some(ref tsfn) = on_closed {
                tsfn.call(
                    ClientSessionClosed {
                        id: id.clone(),
                        code: close_code,
                        reason: close_reason,
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
    crate::panic_guard::catch_panic(|| connect_inner(url, opts_json, on_closed, callback))
}

fn connect_inner(
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

    let client_limits = serde_json::from_str::<serde_json::Value>(&opts_json)
        .ok()
        .and_then(|v| {
            let l = v.get("limits")?;
            serde_json::to_string(l).ok()
        })
        .map(|s| crate::limits::Limits::from_json(&s))
        .unwrap_or_default();
    let bp_timeout_ms = client_limits.backpressure_timeout_ms;

    CLIENT_RUNTIME.spawn(async move {
        let result = match run_connect(&url, opts_json)
            .await
            .map_err(|e| e.to_string())
            .map(|(id, peer_ip, peer_port, conn)| {
                let handle = ClientSessionHandle::spawn_session_task(
                    id.clone(),
                    peer_ip,
                    peer_port,
                    conn,
                    on_closed_tsfn,
                    bp_timeout_ms,
                    client_limits,
                );
                if let Ok(mut reg) = CLIENT_HANDLE_REGISTRY.lock() {
                    reg.insert(id.clone(), handle);
                }
                id
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
    crate::panic_guard::catch_panic(|| take_client_session_inner(handle_id))
}

fn take_client_session_inner(handle_id: String) -> Result<Option<ClientSessionHandle>> {
    let mut reg = CLIENT_HANDLE_REGISTRY
        .lock()
        .map_err(|_| napi::Error::from_reason("registry lock poisoned"))?;
    Ok(reg.remove(&handle_id))
}

const DEFAULT_HANDSHAKE_TIMEOUT_MS: u64 = 10_000;

/// Resolver that returns a fixed SocketAddr, used when serverName overrides an IP host
/// so we connect to the original IP while using serverName for TLS SNI.
#[derive(Debug)]
struct StaticSocketResolver(std::net::SocketAddr);

impl wtransport::config::DnsResolver for StaticSocketResolver {
    fn resolve(&self, _host: &str) -> std::pin::Pin<Box<dyn wtransport::config::DnsLookupFuture>> {
        let addr = self.0;
        Box::pin(async move { Ok(Some(addr)) })
    }
}

/// Build (connect_url, optional custom resolver). When serverName is provided and the
/// original URL host is an IP, we use a custom resolver so we connect to that IP
/// while using serverName for TLS SNI (avoids DNS resolution of serverName which can
/// return ::1 and cause connection failures).
fn connect_url_and_resolver(
    url: &str,
    server_name: Option<&str>,
) -> std::result::Result<(String, Option<StaticSocketResolver>), String> {
    let parsed = url::Url::parse(url).map_err(|e| format!("E_TLS: invalid URL: {}", e))?;
    let port = parsed.port().unwrap_or(443);
    let path = parsed.path();
    let path_query = if path.is_empty() {
        "/".to_string()
    } else {
        format!(
            "{}{}",
            path,
            parsed.query().map(|q| format!("?{q}")).unwrap_or_default()
        )
    };

    let (connect_url, resolver) = match (parsed.host_str(), server_name) {
        (Some(host), Some(sni)) if !sni.is_empty() => {
            if let Ok(ip) = host.parse::<std::net::IpAddr>() {
                let addr = SocketAddr::new(ip, port);
                let connect_url = format!("https://{sni}:{port}{path_query}");
                (connect_url, Some(StaticSocketResolver(addr)))
            } else {
                let mut p = parsed.clone();
                p.set_host(Some(sni))
                    .map_err(|_| format!("E_TLS: invalid serverName for SNI: {}", sni))?;
                (p.to_string(), None)
            }
        }
        _ => (url.to_string(), None),
    };

    Ok((connect_url, resolver))
}

/// Build a RootCertStore from native certs plus optional caPem.
fn build_root_cert_store(
    ca_pem: Option<&str>,
) -> std::result::Result<std::sync::Arc<rustls::RootCertStore>, String> {
    let mut root_store = rustls::RootCertStore::empty();

    // Add platform native certs (best-effort)
    let native = rustls_native_certs::load_native_certs();
    for cert in native.certs {
        let _ = root_store.add(cert);
    }

    // Add custom CA(s) from caPem
    if let Some(pem) = ca_pem {
        let pem_bytes = pem.as_bytes();
        let mut cursor = std::io::Cursor::new(pem_bytes);
        let mut added = 0u32;
        for item in rustls_pemfile::certs(&mut cursor) {
            match item {
                Ok(der) => {
                    let _ = root_store.add(der);
                    added += 1;
                }
                Err(e) => return Err(format!("E_TLS: invalid CA PEM: {}", e)),
            }
        }
        if added == 0 {
            return Err("E_TLS: no valid CA certificate found in caPem".to_string());
        }
    }

    Ok(std::sync::Arc::new(root_store))
}

/// Build a rustls ClientConfig for WebTransport with the given root store.
fn build_client_tls_config(
    root_store: std::sync::Arc<rustls::RootCertStore>,
    insecure_skip_verify: bool,
) -> rustls::ClientConfig {
    use std::sync::Arc;

    let provider = Arc::new(rustls::crypto::ring::default_provider());

    let mut config = rustls::ClientConfig::builder_with_provider(provider)
        .with_protocol_versions(&[&rustls::version::TLS13])
        .expect("TLS 1.3 supported")
        .with_root_certificates(root_store)
        .with_no_client_auth();

    if insecure_skip_verify {
        config
            .dangerous()
            .set_certificate_verifier(Arc::new(InsecureVerifier));
    }

    config.alpn_protocols = vec![wtransport::proto::WEBTRANSPORT_ALPN.to_vec()];
    config
}

/// Insecure verifier for dev-only insecureSkipVerify.
#[derive(Debug)]
struct InsecureVerifier;

impl rustls::client::danger::ServerCertVerifier for InsecureVerifier {
    fn verify_server_cert(
        &self,
        _end_entity: &rustls::pki_types::CertificateDer<'_>,
        _intermediates: &[rustls::pki_types::CertificateDer<'_>],
        _server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> std::result::Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> std::result::Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &rustls::crypto::ring::default_provider().signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> std::result::Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &rustls::crypto::ring::default_provider().signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        rustls::crypto::ring::default_provider()
            .signature_verification_algorithms
            .supported_schemes()
    }
}

async fn run_connect(
    url: &str,
    opts_json: String,
) -> std::result::Result<
    (String, String, u32, wtransport::Connection),
    Box<dyn std::error::Error + Send + Sync>,
> {
    let opts = serde_json::from_str::<serde_json::Value>(&opts_json).unwrap_or_default();

    let tls_opts = opts.get("tls");
    let insecure_skip_verify = tls_opts
        .and_then(|t| t.get("insecureSkipVerify")?.as_bool())
        .unwrap_or(false);

    let ca_pem = tls_opts
        .and_then(|t| t.get("caPem")?.as_str())
        .filter(|s| !s.is_empty());

    let server_name = tls_opts
        .and_then(|t| t.get("serverName")?.as_str())
        .filter(|s| !s.is_empty());

    let handshake_timeout_ms = opts
        .get("limits")
        .and_then(|l| l.get("handshakeTimeoutMs")?.as_u64())
        .unwrap_or(DEFAULT_HANDSHAKE_TIMEOUT_MS);

    let (connect_url, custom_resolver) =
        connect_url_and_resolver(url, server_name).map_err(|e| std::io::Error::other(e))?;

    let mut config = if insecure_skip_verify {
        wtransport::ClientConfig::builder()
            .with_bind_default()
            .with_no_cert_validation()
            .build()
    } else if ca_pem.is_some() {
        let root_store = build_root_cert_store(ca_pem).map_err(|e| std::io::Error::other(e))?;
        let tls_config = build_client_tls_config(root_store, false);
        wtransport::ClientConfig::builder()
            .with_bind_default()
            .with_custom_tls(tls_config)
            .build()
    } else {
        wtransport::ClientConfig::builder()
            .with_bind_default()
            .with_native_certs()
            .build()
    };

    if let Some(resolver) = custom_resolver {
        config.set_dns_resolver(resolver);
    }

    let endpoint = wtransport::Endpoint::client(config)?;
    let conn = tokio::time::timeout(
        tokio::time::Duration::from_millis(handshake_timeout_ms),
        endpoint.connect(&connect_url),
    )
    .await
    .map_err(|_| "E_HANDSHAKE_TIMEOUT")??;

    let id = format!(
        "client-{}",
        CLIENT_SESSION_ID_COUNTER.fetch_add(1, Ordering::Relaxed)
    );
    let addr = conn.remote_address();
    let peer_ip = addr.ip().to_string();
    let peer_port = addr.port() as u32;

    Ok((id, peer_ip, peer_port, conn))
}
