//! WTRANSPORT_DATAGRAM_PUMP=0: datagrams are read inline by the driver select loop.

#![cfg(all(
    feature = "dangerous-configuration",
    feature = "self-signed",
    feature = "quinn"
))]

mod datagram_driver;
mod session_server;

use anyhow::Result;

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn legacy_mode_delivers_in_order_closes_on_malformed_and_spawns_no_pump() -> Result<()> {
    // Read once per process, before the first connection exists.
    std::env::set_var("WTRANSPORT_DATAGRAM_PUMP", "0");
    datagram_driver::echo_in_order(300).await?;
    datagram_driver::malformed_datagram_closes_with_datagram_error().await?;
    let stats = wtransport::datagram_driver_stats();
    assert!(!stats.pump, "selector 0 must select the inline path");
    assert_eq!(
        stats.pumps_spawned, 0,
        "legacy mode never spawns a pump: {stats:?}"
    );
    assert_eq!(stats.pumps_live, 0);
    Ok(())
}
