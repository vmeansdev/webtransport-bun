//! End-to-end coverage for 0-RTT session establishment.

#![cfg(all(feature = "dangerous-configuration", feature = "self-signed"))]

mod utils;

use anyhow::Result;
use std::sync::Arc;
use std::time::Duration;
use utils::echo_server;
use utils::echo_server_with;
use utils::replay_relay;
use utils::EchoServer;
use utils::ReplayableStore;
use utils::ServerOptions;
use wtransport::config::TlsClientConfig;
use wtransport::tls::client::build_default_tls_config;
use wtransport::tls::client::NoServerVerification;
use wtransport::tls::rustls::RootCertStore;
use wtransport::ClientConfig;
use wtransport::Endpoint;

/// A server that accepts 0-RTT must still serve a client that has no session to resume:
/// the first connection of any client is always a full handshake.
#[tokio::test]
async fn fresh_client_falls_back_to_full_handshake() -> Result<()> {
    let server = echo_server(true).await?;

    let connection = Endpoint::client(client_config())?
        .connect(server.url())
        .await?;

    assert!(!server.next_request_was_0rtt().await);
    assert_eq!(echo(&connection, b"hello").await?, b"hello");

    Ok(())
}

/// Enabling 0-RTT must not disturb anything about an ordinary connection.
#[tokio::test]
async fn enabling_0rtt_leaves_1rtt_behaviour_intact() -> Result<()> {
    let with_0rtt = echo_server(true).await?;
    let without_0rtt = echo_server(false).await?;

    for server in [&with_0rtt, &without_0rtt] {
        let endpoint = Endpoint::client(client_config())?;

        for i in 0..3u8 {
            let connection = endpoint.connect(server.url()).await?;
            let payload = [i; 16];

            assert_eq!(echo(&connection, &payload).await?, payload);

            // A connection whose handshake completed before the session was established
            // is confirmed the moment it is asked.
            tokio::time::timeout(Duration::from_secs(1), connection.handshake_confirmed())
                .await
                .expect("handshake already complete");

            connection.close(0u32.into(), b"");
        }
    }

    Ok(())
}

/// `is_0rtt` is sampled when the request is read, so a plain client always reports `false`
/// even against a 0-RTT-enabled server.
#[tokio::test]
async fn plain_client_never_reports_0rtt() -> Result<()> {
    let server = echo_server(true).await?;
    let endpoint = Endpoint::client(client_config())?;

    for _ in 0..3 {
        let connection = endpoint.connect(server.url()).await?;
        assert!(!server.next_request_was_0rtt().await);
        connection.close(0u32.into(), b"");
    }

    Ok(())
}

/// The point of the whole exercise: a second connection resumes the first and carries the
/// session request in its opening flight.
#[tokio::test]
async fn resumed_connection_establishes_the_session_in_0rtt() -> Result<()> {
    let server = echo_server(true).await?;
    let tls = shared_tls_config();

    // First connection: nothing to resume, and it leaves a ticket behind.
    let endpoint = Endpoint::client(zero_rtt_client_config(&tls))?;
    let connection = endpoint.connect_0rtt(server.url()).await?;

    assert!(!server.next_request_was_0rtt().await);
    assert_eq!(echo(&connection, b"first").await?, b"first");

    // Give the server's session tickets time to arrive and land in the store.
    connection.handshake_confirmed().await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    connection.close(0u32.into(), b"");

    // Second connection, through a separately built configuration and a separate socket:
    // the cloned TLS configuration is the only thing carrying the ticket across.
    let endpoint = Endpoint::client(zero_rtt_client_config(&tls))?;
    let connection = endpoint.connect_0rtt(server.url()).await?;

    assert!(
        server.next_request_was_0rtt().await,
        "server should have read the session request before the handshake completed"
    );
    assert!(
        connection.handshake_confirmed().await,
        "server should have accepted the early data"
    );
    assert_eq!(echo(&connection, b"second").await?, b"second");

    Ok(())
}

/// A server that cannot resume the offered ticket rejects the early data. The client must
/// hand back a working connection over the same QUIC connection rather than a dead one.
///
/// This is what a restarted or load-balanced server looks like from the client's side: the
/// ticket is keyed by server name, not by port, so a second server with an empty session
/// store rejects it.
#[tokio::test]
async fn rejected_0rtt_falls_back_on_the_same_connection() -> Result<()> {
    let known_server = echo_server(true).await?;
    let restarted_server = echo_server(true).await?;
    let tls = shared_tls_config();

    // Collect a ticket from one server.
    let endpoint = Endpoint::client(zero_rtt_client_config(&tls))?;
    let connection = endpoint.connect_0rtt(known_server.url()).await?;

    connection.handshake_confirmed().await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    connection.close(0u32.into(), b"");

    // Offer it to a server that has never seen it.
    let endpoint = Endpoint::client(zero_rtt_client_config(&tls))?;
    let connection = endpoint.connect_0rtt(restarted_server.url()).await?;

    assert!(
        !connection.handshake_confirmed().await,
        "the early data should have been rejected"
    );
    assert!(
        !restarted_server.next_request_was_0rtt().await,
        "the rejected request should have been read after the handshake"
    );

    // The connection survived the rejection and is fully usable.
    assert_eq!(
        echo(&connection, b"after rejection").await?,
        b"after rejection"
    );
    if let Ok(reason) = tokio::time::timeout(Duration::from_millis(200), connection.closed()).await
    {
        panic!("connection closed after the fallback: {reason}");
    }

    Ok(())
}

/// A rejection must not leave the connection closed by the abandoned driver, and the
/// recovered connection must keep working for more than the one exchange above.
#[tokio::test]
async fn connection_survives_repeated_rejections() -> Result<()> {
    let _ = tracing_subscriber::fmt()
        .with_test_writer()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .try_init();
    let known_server = echo_server(true).await?;
    let tls = shared_tls_config();

    let endpoint = Endpoint::client(zero_rtt_client_config(&tls))?;
    let connection = endpoint.connect_0rtt(known_server.url()).await?;
    connection.handshake_confirmed().await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    connection.close(0u32.into(), b"");

    for i in 0..3u8 {
        let stranger = echo_server(true).await?;
        let endpoint = Endpoint::client(zero_rtt_client_config(&tls))?;
        let connection = anyhow::Context::context(
            endpoint.connect_0rtt(stranger.url()).await,
            format!("connect iteration {i}"),
        )?;

        assert!(!connection.handshake_confirmed().await);

        let payload = [i; 32];
        let got = anyhow::Context::context(
            echo(&connection, &payload).await,
            format!("echo iteration {i}"),
        )?;
        assert_eq!(got, payload);

        connection.close(0u32.into(), b"");
    }

    Ok(())
}

/// Replay the client's captured 0-RTT flight at the server and assert it buys the attacker
/// nothing: the session store hands each secret out once, so the copy cannot be decrypted
/// and no second session reaches the application.
///
/// The control below runs the identical attack against a store without that property and
/// shows the session being delivered twice, so a pass here is not just the replay
/// machinery failing to do anything.
#[tokio::test]
async fn replayed_0rtt_flight_does_not_establish_a_second_session() -> Result<()> {
    let server = echo_server(true).await?;
    let flight = capture_0rtt_flight(&server).await?;

    assert_eq!(
        server.sessions_established(),
        2,
        "warm-up should have established exactly two sessions"
    );

    let relay = replay_relay(server.port()).await?;
    relay.replay(&flight).await?;

    tokio::time::sleep(Duration::from_secs(1)).await;

    assert_eq!(
        server.sessions_established(),
        2,
        "the replayed flight must not establish another session"
    );

    Ok(())
}

/// The control for the test above: without the take-once store the same replay is accepted
/// and the application sees the session a second time.
#[tokio::test]
async fn replay_control_a_store_without_take_once_accepts_the_copy() -> Result<()> {
    let server = echo_server_with(ServerOptions {
        zero_rtt: true,
        session_storage: Some(ReplayableStore::new()),
        ..Default::default()
    })
    .await?;

    let flight = capture_0rtt_flight(&server).await?;
    assert_eq!(server.sessions_established(), 2);

    let relay = replay_relay(server.port()).await?;
    relay.replay(&flight).await?;

    tokio::time::sleep(Duration::from_secs(1)).await;

    assert_eq!(
        server.sessions_established(),
        3,
        "a store that re-serves a secret lets the captured flight through again — \
         this is what the take-once store prevents"
    );

    Ok(())
}

/// Drives a warm-up connection and then a resumed one through a relay, returning the
/// resumed connection's opening flight.
async fn capture_0rtt_flight(server: &EchoServer) -> Result<Vec<Vec<u8>>> {
    let tls = shared_tls_config();

    // Warm-up: obtain a ticket.
    let endpoint = Endpoint::client(zero_rtt_client_config(&tls))?;
    let connection = endpoint.connect_0rtt(server.url()).await?;
    connection.handshake_confirmed().await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    connection.close(0u32.into(), b"");

    // The real thing, through a relay that records what goes past.
    let relay = replay_relay(server.port()).await?;
    let endpoint = Endpoint::client(zero_rtt_client_config(&tls))?;
    let connection = endpoint.connect_0rtt(relay.url()).await?;

    assert!(
        connection.handshake_confirmed().await,
        "the captured flight must be one the server actually accepted"
    );

    let flight = relay.opening_flight();
    assert!(!flight.is_empty(), "nothing was captured");

    connection.close(0u32.into(), b"");
    tokio::time::sleep(Duration::from_millis(200)).await;

    Ok(flight)
}

/// A client that rebuilds its TLS configuration each time has nothing to resume.
/// `connect_0rtt` must degrade to an ordinary connection rather than fail.
#[tokio::test]
async fn connect_0rtt_without_a_shared_tls_config_falls_back() -> Result<()> {
    let server = echo_server(true).await?;

    for _ in 0..2 {
        let config = ClientConfig::builder()
            .with_bind_default()
            .with_no_cert_validation()
            .enable_0rtt(true)
            .build();

        let connection = Endpoint::client(config)?.connect_0rtt(server.url()).await?;

        assert!(!server.next_request_was_0rtt().await);
        assert_eq!(echo(&connection, b"hi").await?, b"hi");

        tokio::time::sleep(Duration::from_millis(200)).await;
        connection.close(0u32.into(), b"");
    }

    Ok(())
}

/// `connect` never sends early data, even from a configuration that has a ticket to resume.
#[tokio::test]
async fn plain_connect_never_sends_early_data() -> Result<()> {
    let server = echo_server(true).await?;
    let tls = shared_tls_config();
    let endpoint = Endpoint::client(zero_rtt_client_config(&tls))?;

    for _ in 0..3 {
        let connection = endpoint.connect(server.url()).await?;

        assert!(!server.next_request_was_0rtt().await);
        assert_eq!(echo(&connection, b"hi").await?, b"hi");

        tokio::time::sleep(Duration::from_millis(200)).await;
        connection.close(0u32.into(), b"");
    }

    Ok(())
}

fn client_config() -> ClientConfig {
    ClientConfig::builder()
        .with_bind_default()
        .with_no_cert_validation()
        .build()
}

/// A TLS configuration built once and cloned into every client configuration, which is
/// what rustls requires for resumption across configurations.
fn shared_tls_config() -> TlsClientConfig {
    build_default_tls_config(
        Arc::new(RootCertStore::empty()),
        Some(Arc::new(NoServerVerification::new())),
    )
}

fn zero_rtt_client_config(tls: &TlsClientConfig) -> ClientConfig {
    ClientConfig::builder()
        .with_bind_default()
        .with_custom_tls(tls.clone())
        .enable_0rtt(true)
        .build()
}

async fn echo(connection: &wtransport::Connection, payload: &[u8]) -> Result<Vec<u8>> {
    let (mut send, mut recv) = connection.open_bi().await?.await?;

    send.write_all(payload).await?;
    send.finish().await?;

    let mut buffer = vec![0; payload.len()];
    recv.read_exact(&mut buffer).await?;

    Ok(buffer)
}

impl EchoServer {
    /// Whether the next session request the server sees arrives as 0-RTT data.
    async fn next_request_was_0rtt(&self) -> bool {
        tokio::time::timeout(Duration::from_secs(5), self.observed_0rtt())
            .await
            .expect("server observed a session request")
    }
}
