//! End-to-end coverage for closing a session at the WebTransport layer.

#![cfg(all(feature = "dangerous-configuration", feature = "self-signed"))]

mod session_server;

use anyhow::Result;
use session_server::connected;
use std::time::Duration;
use wtransport::error::ConnectionError;
use wtransport::Connection;

/// The peer reports the end of a session through whatever session operation it is in;
/// `closed` only ever reports the fate of the QUIC connection underneath.
async fn peer_close(connection: &Connection) -> ConnectionError {
    tokio::time::timeout(Duration::from_secs(5), connection.accept_bi())
        .await
        .expect("the close must reach the peer")
        .expect_err("the session has ended")
}

/// Closing at the session layer has to reach the peer as an application close carrying
/// the code and reason, not as a bare connection teardown.
///
/// This is also the ordering test: the close capsule travels on the CONNECT stream while
/// the connection close is a QUIC frame that overtakes buffered stream data. If the
/// connection were closed first, the peer would see either a plain connection close or —
/// if only the FIN survived — an application close with code 0 and no reason.
#[tokio::test]
async fn server_close_reaches_the_client_with_code_and_reason() -> Result<()> {
    let (_server, client, session) = connected().await?;

    session.close_session(42, "shutting down");

    match peer_close(&client).await {
        ConnectionError::ApplicationClosed(close) => {
            assert_eq!(close.code().into_inner(), 42);
            assert_eq!(close.reason(), b"shutting down");
        }
        other => panic!("expected an application close, got {other:?}"),
    }

    Ok(())
}

/// The same in the other direction: a client can end the session too.
#[tokio::test]
async fn client_close_reaches_the_server_with_code_and_reason() -> Result<()> {
    let (_server, client, session) = connected().await?;

    client.close_session(7, "done");

    match peer_close(&session).await {
        ConnectionError::ApplicationClosed(close) => {
            assert_eq!(close.code().into_inner(), 7);
            assert_eq!(close.reason(), b"done");
        }
        other => panic!("expected an application close, got {other:?}"),
    }

    Ok(())
}

/// A reason the wire format cannot carry is truncated rather than dropped or rejected.
#[tokio::test]
async fn an_over_long_reason_is_truncated() -> Result<()> {
    let (_server, client, session) = connected().await?;

    session.close_session(1, &"x".repeat(2000));

    match peer_close(&client).await {
        ConnectionError::ApplicationClosed(close) => {
            assert_eq!(close.reason().len(), 1024);
        }
        other => panic!("expected an application close, got {other:?}"),
    }

    Ok(())
}

/// The local side must not be left waiting on the peer: closing resolves the local
/// connection promptly whether or not the peer ever answers.
#[tokio::test]
async fn the_local_side_closes_promptly() -> Result<()> {
    let (_server, client, session) = connected().await?;

    session.close_session(3, "bye");

    let closed = tokio::time::timeout(Duration::from_secs(5), session.closed())
        .await
        .expect("the local close must not wait on the peer");

    assert!(matches!(closed, ConnectionError::LocallyClosed));

    drop(client);

    Ok(())
}

/// Streams the peer opened but the application never accepted are torn down with
/// `WEBTRANSPORT_SESSION_GONE`, rather than being left for the connection teardown.
#[tokio::test]
async fn unaccepted_streams_are_reset_with_session_gone() -> Result<()> {
    const SESSION_GONE: u64 = 0x170d_7b68;

    let (_server, client, session) = connected().await?;

    let mut stream = client.open_uni().await?.await?;
    stream.write_all(b"never read").await?;

    // Give the server's driver time to take the stream off the wire and queue it.
    tokio::time::sleep(Duration::from_millis(200)).await;

    session.close_session(0, "");

    let stopped = tokio::time::timeout(Duration::from_secs(5), stream.stopped())
        .await
        .expect("the stream must be stopped by the close");

    // A stop code at all tells us the session tore the stream down itself; had it been
    // left to the connection teardown, this would be `NotConnected`.
    match stopped {
        wtransport::error::StreamWriteError::Stopped(code) => {
            assert_eq!(code.into_inner(), SESSION_GONE);
        }
        other => panic!("expected the stream to be stopped, got {other:?}"),
    }

    Ok(())
}
