//! A minimal echo server used by the integration tests.

#![allow(dead_code)]

use anyhow::Result;
use std::net::Ipv6Addr;
use std::net::SocketAddr;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::time::Duration;
use tokio::net::UdpSocket;
use tokio::sync::mpsc;
use tokio::sync::Mutex;
use wtransport::endpoint::endpoint_side::Server;
use wtransport::endpoint::SessionRequest;
use wtransport::tls::rustls::server::ServerSessionMemoryCache;
use wtransport::tls::rustls::server::StoresServerSessions;
use wtransport::tls::server::build_default_tls_config;
use wtransport::Endpoint;
use wtransport::Identity;
use wtransport::ServerConfig;

/// How a session request is handled before the session is established.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AcceptPolicy {
    /// Accept immediately, even if the request arrived as replayable 0-RTT data.
    Immediate,

    /// Wait for the handshake to complete before accepting.
    AfterHandshake,
}

/// An echo server reporting, for each session it establishes, whether the request that
/// opened it arrived as 0-RTT data.
pub struct EchoServer {
    endpoint: Arc<Endpoint<Server>>,
    port: u16,
    requests: Mutex<mpsc::UnboundedReceiver<bool>>,
    established: Arc<AtomicUsize>,
}

impl EchoServer {
    pub fn url(&self) -> String {
        format!("https://localhost:{}", self.port)
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// Whether the request that opened the next established session arrived as 0-RTT data.
    pub async fn observed_0rtt(&self) -> bool {
        self.requests
            .lock()
            .await
            .recv()
            .await
            .expect("server task is alive")
    }

    /// How many sessions the server has handed to the application so far.
    pub fn sessions_established(&self) -> usize {
        self.established.load(Ordering::SeqCst)
    }

    /// Whether the server has established a session that has not been observed yet.
    pub fn has_pending_session(&self) -> bool {
        !self
            .requests
            .try_lock()
            .expect("no concurrent observer")
            .is_empty()
    }
}

/// How an echo server is set up.
pub struct ServerOptions {
    pub zero_rtt: bool,
    pub policy: AcceptPolicy,

    /// Replaces the session store. Used to model a store without the take-once property,
    /// which is what stops a captured 0-RTT flight from being accepted twice.
    pub session_storage: Option<Arc<dyn StoresServerSessions>>,
}

impl Default for ServerOptions {
    fn default() -> Self {
        Self {
            zero_rtt: false,
            policy: AcceptPolicy::Immediate,
            session_storage: None,
        }
    }
}

/// A session store that hands each secret out as many times as it is asked for.
#[derive(Debug)]
pub struct ReplayableStore(Arc<dyn StoresServerSessions>);

impl ReplayableStore {
    pub fn new() -> Arc<Self> {
        Arc::new(Self(ServerSessionMemoryCache::new(32)))
    }
}

impl StoresServerSessions for ReplayableStore {
    fn put(&self, key: Vec<u8>, value: Vec<u8>) -> bool {
        self.0.put(key, value)
    }

    fn get(&self, key: &[u8]) -> Option<Vec<u8>> {
        self.0.get(key)
    }

    fn take(&self, key: &[u8]) -> Option<Vec<u8>> {
        // Deliberately not `take`: this is the property whose absence the replay test
        // demonstrates.
        self.0.get(key)
    }

    fn can_cache(&self) -> bool {
        self.0.can_cache()
    }
}

/// Spawns an echo server on an ephemeral port, optionally accepting 0-RTT.
pub async fn echo_server(zero_rtt: bool) -> Result<EchoServer> {
    echo_server_with(ServerOptions {
        zero_rtt,
        ..Default::default()
    })
    .await
}

pub async fn echo_server_with(options: ServerOptions) -> Result<EchoServer> {
    let ServerOptions {
        zero_rtt,
        policy,
        session_storage,
    } = options;

    let identity = Identity::self_signed(["localhost", "127.0.0.1", "::1"])?;
    let mut tls_config = build_default_tls_config(identity);

    if let Some(session_storage) = session_storage {
        tls_config.session_storage = session_storage;
    }

    let config = ServerConfig::builder()
        .with_bind_default(0)
        .with_custom_tls(tls_config)
        .keep_alive_interval(Some(Duration::from_secs(3)))
        .enable_0rtt(zero_rtt)
        .build();

    let endpoint = Arc::new(Endpoint::server(config)?);
    let port = endpoint.local_addr()?.port();
    let (sender, receiver) = mpsc::unbounded_channel();
    let established = Arc::new(AtomicUsize::new(0));

    tokio::spawn({
        let endpoint = Arc::clone(&endpoint);
        let established = Arc::clone(&established);

        async move {
            loop {
                let incoming = endpoint.accept().await;
                let sender = sender.clone();
                let established = Arc::clone(&established);

                tokio::spawn(async move {
                    if let Ok(request) = incoming.await {
                        let _ = serve_session(request, policy, sender, established).await;
                    }
                });
            }
        }
    });

    Ok(EchoServer {
        endpoint,
        port,
        requests: Mutex::new(receiver),
        established,
    })
}

/// A UDP relay that records the client's opening flight so it can be replayed later,
/// standing in for an attacker who captured it off the wire.
pub struct ReplayRelay {
    port: u16,
    server: SocketAddr,
    opening_flight: Arc<StdMutex<Vec<Vec<u8>>>>,
}

impl ReplayRelay {
    pub fn url(&self) -> String {
        format!("https://localhost:{}", self.port)
    }

    /// The datagrams the client sent before hearing anything back, which for a resumed
    /// connection carry the Initial and the 0-RTT data.
    pub fn opening_flight(&self) -> Vec<Vec<u8>> {
        self.opening_flight.lock().unwrap().clone()
    }

    /// Sends a previously captured opening flight to the server from a fresh socket.
    pub async fn replay(&self, flight: &[Vec<u8>]) -> Result<()> {
        let socket = UdpSocket::bind((Ipv6Addr::LOCALHOST, 0)).await?;

        for datagram in flight {
            socket.send_to(datagram, self.server).await?;
        }

        Ok(())
    }
}

/// Starts a relay in front of `server_port` on an ephemeral port.
pub async fn replay_relay(server_port: u16) -> Result<ReplayRelay> {
    let socket = Arc::new(UdpSocket::bind((Ipv6Addr::LOCALHOST, 0)).await?);
    let port = socket.local_addr()?.port();
    let server = SocketAddr::from((Ipv6Addr::LOCALHOST, server_port));
    let opening_flight = Arc::new(StdMutex::new(Vec::new()));

    tokio::spawn({
        let socket = Arc::clone(&socket);
        let opening_flight = Arc::clone(&opening_flight);

        async move {
            let mut buffer = vec![0u8; 2048];
            let mut client = None;
            let mut server_replied = false;

            loop {
                let Ok((read, from)) = socket.recv_from(&mut buffer).await else {
                    return;
                };

                let datagram = &buffer[..read];

                if from == server {
                    server_replied = true;

                    if let Some(client) = client {
                        let _ = socket.send_to(datagram, client).await;
                    }
                } else {
                    client = Some(from);

                    if !server_replied {
                        opening_flight.lock().unwrap().push(datagram.to_vec());
                    }

                    let _ = socket.send_to(datagram, server).await;
                }
            }
        }
    });

    Ok(ReplayRelay {
        port,
        server,
        opening_flight,
    })
}

async fn serve_session(
    request: SessionRequest,
    policy: AcceptPolicy,
    sender: mpsc::UnboundedSender<bool>,
    established: Arc<AtomicUsize>,
) -> Result<()> {
    let is_0rtt = request.is_0rtt();

    if policy == AcceptPolicy::AfterHandshake {
        request.handshake_confirmed().await;
    }

    let connection = request.accept().await?;
    established.fetch_add(1, Ordering::SeqCst);
    let _ = sender.send(is_0rtt);

    loop {
        // Per-stream failures must not end the session: a client that stops reading as
        // soon as it has its echo can make `finish` fail, and that says nothing about the
        // health of the connection.
        let Ok((mut send, mut recv)) = connection.accept_bi().await else {
            return Ok(());
        };

        tokio::spawn(async move {
            let mut buffer = vec![0; 8192];

            while let Ok(Some(read)) = recv.read(&mut buffer).await {
                if send.write_all(&buffer[..read]).await.is_err() {
                    return;
                }
            }

            let _ = send.finish().await;
        });
    }
}
