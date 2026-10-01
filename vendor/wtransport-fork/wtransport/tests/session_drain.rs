//! End-to-end coverage for winding a session down without ending it.

#![cfg(all(feature = "dangerous-configuration", feature = "self-signed"))]

mod session_server;

use anyhow::Result;
use session_server::connected;
use session_server::connected_with;
use std::time::Duration;
use wtransport::Connection;

async fn echo_once(client: &Connection, peer: &Connection, message: &[u8]) -> Result<Vec<u8>> {
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

/// Draining is a warning, not an ending: the peer learns the session is winding down
/// while everything about it keeps working.
#[tokio::test]
async fn draining_notifies_the_peer_without_closing_the_session() -> Result<()> {
    let (_server, client, session) = connected().await?;

    session.drain_session();

    tokio::time::timeout(Duration::from_secs(5), client.draining())
        .await
        .expect("the drain must reach the peer");

    assert_eq!(
        echo_once(&client, &session, b"still here").await?,
        b"still here"
    );

    Ok(())
}

/// `GOAWAY` reaches the peer as the same warning, over the control stream rather than
/// the session's own.
#[tokio::test]
async fn goaway_notifies_the_peer_without_closing_the_session() -> Result<()> {
    let (_server, client, session) = connected().await?;

    session.send_goaway();

    tokio::time::timeout(Duration::from_secs(5), client.draining())
        .await
        .expect("the GOAWAY must reach the peer");

    assert_eq!(
        echo_once(&client, &session, b"still here").await?,
        b"still here"
    );

    Ok(())
}

/// The identifier has to name the request after this session, whenever the `GOAWAY` is
/// asked for. Sending one the instant the session arrives is the case that catches the
/// CONNECT stream still in flight to the worker, where an identifier of zero would tell
/// the client the session it is running was never processed.
///
/// The race is decided by which side of a `select!` wins, so one round proves little;
/// the loop is what makes an unlucky ordering show up.
#[tokio::test]
async fn a_prompt_goaway_still_names_the_request_after_this_session() -> Result<()> {
    for _ in 0..16 {
        let (_server, client, session) = connected_with(|session| session.send_goaway()).await?;

        tokio::time::timeout(Duration::from_secs(5), client.draining())
            .await
            .expect("the GOAWAY must reach the peer");

        let expected = session.session_id().into_varint().into_inner() + 4;

        assert_eq!(
            client.peer_goaway_id().map(|id| id.into_inner()),
            Some(expected),
            "the GOAWAY must refuse only requests after this session"
        );
    }

    Ok(())
}

/// Asking twice changes nothing. A second `GOAWAY` may only lower the identifier, so
/// repeating one this endpoint has already sent is not something to put on the wire: a
/// client that saw a higher identifier arrive would be right to end the connection.
#[tokio::test]
async fn goaway_asked_for_twice_is_sent_once() -> Result<()> {
    for _ in 0..16 {
        let (_server, client, session) = connected_with(|session| {
            session.send_goaway();
            session.send_goaway();
        })
        .await?;

        tokio::time::timeout(Duration::from_secs(5), client.draining())
            .await
            .expect("the GOAWAY must reach the peer");

        let expected = session.session_id().into_varint().into_inner() + 4;

        // Long enough for a second GOAWAY to have arrived and, being higher than the
        // first, to have taken the connection down with it.
        tokio::time::sleep(Duration::from_millis(100)).await;

        assert_eq!(
            client.peer_goaway_id().map(|id| id.into_inner()),
            Some(expected)
        );

        assert_eq!(
            echo_once(&client, &session, b"still here").await?,
            b"still here"
        );
    }

    Ok(())
}

/// Waiting on a session that is already draining resolves at once rather than waiting
/// for a second notification that will never come.
#[tokio::test]
async fn draining_resolves_immediately_once_notified() -> Result<()> {
    let (_server, client, session) = connected().await?;

    session.drain_session();

    tokio::time::timeout(Duration::from_secs(5), client.draining())
        .await
        .expect("the drain must reach the peer");

    tokio::time::timeout(Duration::from_millis(100), client.draining())
        .await
        .expect("a session already draining must not wait again");

    Ok(())
}
