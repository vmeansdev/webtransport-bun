//! End-to-end coverage for offering a QPACK dynamic table.
//!
//! Offering one adds two things to a connection: this endpoint opens a decoder stream,
//! and it reads the peer's encoder stream instead of discarding it. Both are critical
//! streams, so getting either wrong takes the connection down rather than degrading
//! quietly — which is what these tests watch for.

#![cfg(all(feature = "dangerous-configuration", feature = "self-signed"))]

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

struct QpackServer {
    _endpoint: Arc<Endpoint<Server>>,
    port: u16,
    sessions: Mutex<mpsc::UnboundedReceiver<Connection>>,
}

impl QpackServer {
    async fn spawn(qpack_max_table_capacity: u64) -> Result<Self> {
        let config = ServerConfig::builder()
            .with_bind_default(0)
            .with_identity(Identity::self_signed(["localhost", "127.0.0.1", "::1"])?)
            .qpack_max_table_capacity(qpack_max_table_capacity)
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

                    tokio::spawn(async move {
                        if let Ok(request) = incoming.await {
                            if let Ok(connection) = request.accept().await {
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

    fn url(&self) -> String {
        format!("https://localhost:{}", self.port)
    }

    async fn next_session(&self) -> Connection {
        self.sessions
            .lock()
            .await
            .recv()
            .await
            .expect("server task is alive")
    }
}

fn client_endpoint(qpack_max_table_capacity: u64) -> Result<Endpoint<Client>> {
    Ok(Endpoint::client(
        ClientConfig::builder()
            .with_bind_default()
            .with_no_cert_validation()
            .qpack_max_table_capacity(qpack_max_table_capacity)
            .build(),
    )?)
}

async fn echo(client: &Connection, peer: &Connection, message: &[u8]) -> Result<Vec<u8>> {
    let (mut send, mut recv) = client.open_bi().await?.await?;
    send.write_all(message).await?;
    send.finish().await?;

    let (mut peer_send, mut peer_recv) = peer.accept_bi().await?;
    let mut buffer = vec![0; 64];
    let read = peer_recv.read(&mut buffer).await?.unwrap_or(0);
    peer_send.write_all(&buffer[..read]).await?;
    peer_send.finish().await?;

    let mut echoed = vec![0; 64];
    let read = recv.read(&mut echoed).await?.unwrap_or(0);
    echoed.truncate(read);

    Ok(echoed)
}

/// A session established between two endpoints that both offer a table, with the extra
/// QPACK streams open on either side, behaves exactly like one that offers none.
#[tokio::test]
async fn a_session_works_with_a_dynamic_table_on_both_sides() -> Result<()> {
    let server = QpackServer::spawn(4096).await?;
    let client = client_endpoint(4096)?.connect(server.url()).await?;
    let session = server.next_session().await;

    assert_eq!(echo(&client, &session, b"hello").await?, b"hello");

    // The connection is still healthy a moment later: nothing on the new streams has
    // taken it down in the background.
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(echo(&client, &session, b"still here").await?, b"still here");

    Ok(())
}

/// An endpoint offering a table interoperates with one that does not, in either
/// direction: the offer is not a requirement on the peer.
#[tokio::test]
async fn a_dynamic_table_interoperates_with_a_peer_without_one() -> Result<()> {
    let server = QpackServer::spawn(4096).await?;
    let client = client_endpoint(0)?.connect(server.url()).await?;
    let session = server.next_session().await;

    assert_eq!(echo(&client, &session, b"hello").await?, b"hello");

    let server = QpackServer::spawn(0).await?;
    let client = client_endpoint(4096)?.connect(server.url()).await?;
    let session = server.next_session().await;

    assert_eq!(echo(&client, &session, b"hello").await?, b"hello");

    Ok(())
}

/// An encoder must size its table from what the *peer* advertised, not from its own
/// settings, and this is what proves it over the wire.
///
/// The server offers 64 KiB and the client 4 KiB. By the time the server encodes its
/// response the client's settings have arrived, so it inserts into its encoder table and
/// replicates those inserts on its encoder stream — starting with a *Set Dynamic Table
/// Capacity*. Sized from the server's own settings that instruction would ask for 64 KiB,
/// and the client, having offered 4 KiB, would be obliged to fail the connection with
/// `QPACK_ENCODER_STREAM_ERROR`. A session that keeps working afterwards is therefore
/// evidence the server asked for the client's capacity rather than its own.
///
/// Only the server's direction is observable here: the client sends its `CONNECT` before
/// the server's settings arrive, so it never gets to insert anything.
#[tokio::test]
async fn an_encoder_sizes_its_table_from_the_peers_capacity() -> Result<()> {
    let server = QpackServer::spawn(65536).await?;
    let client = client_endpoint(4096)?.connect(server.url()).await?;
    let session = server.next_session().await;

    // The response has been encoded and its inserts written by now. Give the client a
    // moment to read them, then confirm it did not object to any of it.
    assert_eq!(echo(&client, &session, b"hello").await?, b"hello");

    tokio::time::sleep(Duration::from_millis(200)).await;

    assert_eq!(echo(&client, &session, b"still here").await?, b"still here");

    Ok(())
}

/// The same, with the smaller table on the server, so neither ordering of the two
/// capacities is the one that happens to work.
#[tokio::test]
async fn peers_may_offer_tables_of_different_sizes() -> Result<()> {
    let server = QpackServer::spawn(4096).await?;
    let client = client_endpoint(65536)?.connect(server.url()).await?;
    let session = server.next_session().await;

    assert_eq!(echo(&client, &session, b"hello").await?, b"hello");

    tokio::time::sleep(Duration::from_millis(200)).await;

    assert_eq!(echo(&client, &session, b"still here").await?, b"still here");

    Ok(())
}
