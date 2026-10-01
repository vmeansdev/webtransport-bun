//! Shared end-to-end scenarios for the driver's datagram path, run once per mode.
//!
//! The mode is chosen once per process, so each mode has its own test binary.

#![allow(dead_code)]

use crate::session_server::connected;
use anyhow::Result;
use std::time::Duration;
use wtransport::error::ConnectionError;
use wtransport::VarInt;

const H3_DATAGRAM_ERROR: u32 = 0x33;

/// Ping-pong keeps exactly one datagram in flight, so delivery is deterministic and
/// order is checked end to end in both directions with idle control streams.
pub async fn echo_in_order(count: u32) -> Result<()> {
    let (_server, client, session) = connected().await?;
    for i in 0..count {
        client.send_datagram(i.to_be_bytes())?;
        let got = tokio::time::timeout(Duration::from_secs(5), session.receive_datagram())
            .await
            .expect("server receives within 5s")?;
        assert_eq!(&got.payload()[..], &i.to_be_bytes(), "server order at {i}");
        session.send_datagram(got.payload())?;
        let back = tokio::time::timeout(Duration::from_secs(5), client.receive_datagram())
            .await
            .expect("client receives within 5s")?;
        assert_eq!(&back.payload()[..], &i.to_be_bytes(), "client order at {i}");
    }
    // End the connection explicitly so both drivers (and their pumps) finish.
    client.close(VarInt::from_u32(0), b"done");
    tokio::time::timeout(Duration::from_secs(5), session.closed())
        .await
        .expect("peer observes the close within 5s");
    Ok(())
}

/// A datagram without a valid quarter-stream-id is an H3 datagram error: the server
/// driver must close the connection with H3_DATAGRAM_ERROR, whichever path read it.
pub async fn malformed_datagram_closes_with_datagram_error() -> Result<()> {
    let (_server, client, _session) = connected().await?;
    client
        .quic_connection()
        .send_datagram(bytes::Bytes::new())?;
    let error = tokio::time::timeout(Duration::from_secs(5), client.closed())
        .await
        .expect("connection closes within 5s");
    match error {
        ConnectionError::ApplicationClosed(close) => {
            assert_eq!(close.code(), VarInt::from_u32(H3_DATAGRAM_ERROR))
        }
        other => panic!("expected H3_DATAGRAM_ERROR close, got {other:?}"),
    }
    Ok(())
}

/// Every pump task ends once its connection is gone: nothing outlives the driver.
pub async fn no_pump_outlives_its_connection() {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let live = wtransport::datagram_driver_stats().pumps_live;
        if live == 0 {
            return;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "{live} datagram pump task(s) still live 10s after all connections dropped"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}
