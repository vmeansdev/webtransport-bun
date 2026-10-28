//! A server that hands every session it establishes back to the test, untouched.

#![allow(dead_code)]

use anyhow::Result;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio::sync::Mutex;
use wtransport::endpoint::endpoint_side::Client;
use wtransport::endpoint::endpoint_side::Server;
use wtransport::ClientConfig;
use wtransport::Connection;
use wtransport::Endpoint;
use wtransport::Identity;
use wtransport::ServerConfig;

pub struct SessionServer {
    _endpoint: Arc<Endpoint<Server>>,
    port: u16,
    sessions: Mutex<mpsc::UnboundedReceiver<Connection>>,
}

impl SessionServer {
    pub async fn spawn() -> Result<Self> {
        Self::spawn_with(|_| {}).await
    }

    /// A server that runs `on_accept` on every session the instant it is established.
    ///
    /// Nothing is awaited in between, so a command issued from the hook reaches the
    /// driver while the CONNECT stream is still on its way there.
    pub async fn spawn_with<F>(on_accept: F) -> Result<Self>
    where
        F: Fn(&Connection) + Send + Sync + 'static,
    {
        let on_accept = Arc::new(on_accept);
        let config = ServerConfig::builder()
            .with_bind_default(0)
            .with_identity(Identity::self_signed(["localhost", "127.0.0.1", "::1"])?)
            .keep_alive_interval(Some(Duration::from_secs(3)))
            .build();

        let endpoint = Arc::new(Endpoint::server(config)?);
        let port = endpoint.local_addr()?.port();
        let (sender, receiver) = mpsc::unbounded_channel();

        tokio::spawn({
            let endpoint = Arc::clone(&endpoint);

            async move {
                loop {
                    let incoming = endpoint.accept().await;
                    let sender = sender.clone();
                    let on_accept = Arc::clone(&on_accept);

                    tokio::spawn(async move {
                        if let Ok(request) = incoming.await {
                            if let Ok(connection) = request.accept().await {
                                on_accept(&connection);
                                let _ = sender.send(connection);
                            }
                        }
                    });
                }
            }
        });

        Ok(Self {
            _endpoint: endpoint,
            port,
            sessions: Mutex::new(receiver),
        })
    }

    pub fn url(&self) -> String {
        format!("https://localhost:{}", self.port)
    }

    pub async fn next_session(&self) -> Connection {
        self.sessions
            .lock()
            .await
            .recv()
            .await
            .expect("server task is alive")
    }
}

pub fn client_endpoint() -> Result<Endpoint<Client>> {
    Ok(Endpoint::client(
        ClientConfig::builder()
            .with_bind_default()
            .with_no_cert_validation()
            .build(),
    )?)
}

/// A server, a client connection, and the server's side of the same session.
pub async fn connected() -> Result<(SessionServer, Connection, Connection)> {
    connected_with(|_| {}).await
}

/// The same, with `on_accept` run on the server's session before anything else can.
pub async fn connected_with<F>(on_accept: F) -> Result<(SessionServer, Connection, Connection)>
where
    F: Fn(&Connection) + Send + Sync + 'static,
{
    let server = SessionServer::spawn_with(on_accept).await?;
    let client = client_endpoint()?.connect(server.url()).await?;
    let session = server.next_session().await;

    Ok((server, client, session))
}
