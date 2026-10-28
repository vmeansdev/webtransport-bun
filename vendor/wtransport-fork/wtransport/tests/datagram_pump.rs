//! Default mode: datagrams are read by a dedicated per-connection pump task.

#![cfg(all(
    feature = "dangerous-configuration",
    feature = "self-signed",
    feature = "quinn"
))]

mod datagram_driver;
mod session_server;

use anyhow::Result;

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn pump_mode_delivers_in_order_closes_on_malformed_and_cleans_up() -> Result<()> {
    std::env::remove_var("WTRANSPORT_DATAGRAM_PUMP");
    datagram_driver::echo_in_order(300).await?;
    datagram_driver::malformed_datagram_closes_with_datagram_error().await?;
    datagram_driver::no_pump_outlives_its_connection().await;
    let stats = wtransport::datagram_driver_stats();
    assert!(stats.pump, "default mode must be the pump");
    assert!(
        stats.pumps_spawned >= 4,
        "both endpoints of both connections spawn a pump: {stats:?}"
    );
    Ok(())
}
