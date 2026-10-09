//! The wtransport driver's datagram read path, as seen by this addon.
//!
//! The vendored driver reads each connection's datagrams in a dedicated task
//! (`"pump"`, the default) or inline in its select loop (`"legacy"`, selected
//! by `WTRANSPORT_DATAGRAM_PUMP=0` for paired campaign measurement). The mode
//! is resolved once per process; this module only reports it.

/// `"pump"` or `"legacy"`: the path this process's drivers actually use.
pub(crate) fn effective_mode() -> &'static str {
    mode_name(wtransport::datagram_driver_stats().pump)
}

fn mode_name(pump: bool) -> &'static str {
    if pump {
        "pump"
    } else {
        "legacy"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use wtransport::{ClientConfig, Endpoint, Identity, ServerConfig, VarInt};

    #[test]
    fn mode_names_are_the_campaign_vocabulary() {
        assert_eq!(mode_name(true), "pump");
        assert_eq!(mode_name(false), "legacy");
    }

    /// Run with `--test-threads=1` (the capacity proof argv): the live-pump gauge
    /// is process-wide, so this asserts it returns to its baseline once both
    /// connections it opened are closed — no pump outlives its driver.
    #[tokio::test]
    async fn pump_tasks_end_with_their_connections() {
        assert_eq!(effective_mode(), "pump", "default process mode is the pump");
        let before = wtransport::datagram_driver_stats();
        let identity = Identity::self_signed(["localhost", "127.0.0.1"]).expect("identity");
        let server = Endpoint::server(
            ServerConfig::builder()
                .with_bind_default(0)
                .with_identity(identity)
                .build(),
        )
        .expect("server endpoint");
        let port = server.local_addr().expect("server addr").port();
        let accept = tokio::spawn(async move {
            let request = server.accept().await.await.expect("incoming");
            let session = request.accept().await.expect("session");
            (server, session)
        });
        let client = Endpoint::client(
            ClientConfig::builder()
                .with_bind_default()
                .with_no_cert_validation()
                .build(),
        )
        .expect("client endpoint");
        let connection = tokio::time::timeout(
            Duration::from_secs(10),
            client.connect(format!("https://127.0.0.1:{port}")),
        )
        .await
        .expect("connect within 10s")
        .expect("connect");
        let (server, session) = accept.await.expect("accept task");

        connection.send_datagram(b"ping").expect("send");
        let got = tokio::time::timeout(Duration::from_secs(5), session.receive_datagram())
            .await
            .expect("datagram within 5s")
            .expect("datagram");
        assert_eq!(&got.payload()[..], b"ping");
        let during = wtransport::datagram_driver_stats();
        assert!(
            during.pumps_spawned >= before.pumps_spawned + 2,
            "client and server drivers each spawn a pump: {before:?} -> {during:?}"
        );

        connection.close(VarInt::from_u32(0), b"done");
        tokio::time::timeout(Duration::from_secs(5), session.closed())
            .await
            .expect("peer observes close within 5s");
        drop((connection, session, server, client));

        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            let live = wtransport::datagram_driver_stats().pumps_live;
            if live <= before.pumps_live {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "{live} pump task(s) still live (baseline {}) 10s after close",
                before.pumps_live
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
}
