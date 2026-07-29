//! Server instance spawn/bind helpers (excluded from risk-module coverage floors).
//! Floors target `server.rs` for TLS rotation and close-drain logic.

use std::sync::Arc;
use std::time::Duration;
use tokio::sync::watch;

use crate::limits::Limits;
use crate::rate_limit::RateLimits;
use crate::server_metrics::ServerMetrics;
use crate::{LogEvent, SessionEvent};

pub(crate) fn is_addr_in_use_error(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("address already in use") || lower.contains("addrinuse")
}

pub(crate) fn should_retry_startup_error(
    message: &str,
    attempt: usize,
    max_retries: usize,
) -> bool {
    is_addr_in_use_error(message) && attempt + 1 < max_retries
}

pub(crate) fn map_startup_recv_timeout_error(err: std::sync::mpsc::RecvTimeoutError) -> String {
    match err {
        std::sync::mpsc::RecvTimeoutError::Timeout => "server startup timed out".to_string(),
        std::sync::mpsc::RecvTimeoutError::Disconnected => {
            "server startup channel disconnected".to_string()
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn spawn_server_instance(
    server_id: u64,
    metrics: Arc<ServerMetrics>,
    limits: &Limits,
    rate_limits: &RateLimits,
    host: &str,
    port: u16,
    session_tx: &Option<tokio::sync::mpsc::Sender<SessionEvent>>,
    log_tx: &Option<tokio::sync::mpsc::Sender<LogEvent>>,
    tls_resolver: Arc<crate::server_tls::LiveServerCertResolver>,
    congestion_control: crate::client::CongestionControlMode,
    debug: bool,
    max_retries: usize,
) -> std::result::Result<(watch::Sender<()>, u16), String> {
    const RETRY_DELAY: Duration = Duration::from_millis(100);

    let mut last_err: Option<String> = None;

    for attempt in 0..max_retries {
        let (shutdown_tx, shutdown_rx) = watch::channel(());
        let (startup_tx, startup_rx) =
            std::sync::mpsc::channel::<std::result::Result<u16, String>>();

        crate::spawn_wtransport_server(
            server_id,
            Arc::clone(&metrics),
            limits.clone(),
            rate_limits.clone(),
            host.to_string(),
            port,
            shutdown_rx,
            session_tx.clone(),
            log_tx.clone(),
            Arc::clone(&tls_resolver),
            congestion_control,
            debug,
            startup_tx,
        );

        match startup_rx.recv_timeout(Duration::from_secs(5)) {
            Ok(Ok(bound_port)) => return Ok((shutdown_tx, bound_port)),
            Ok(Err(msg)) => {
                if should_retry_startup_error(&msg, attempt, max_retries) {
                    last_err = Some(msg);
                    drop(shutdown_tx);
                    std::thread::sleep(RETRY_DELAY);
                    continue;
                }
                return Err(msg);
            }
            Err(err) => return Err(map_startup_recv_timeout_error(err)),
        }
    }

    Err(last_err.unwrap_or_else(|| "server startup failed".to_string()))
}

/// Sends shutdown when dropped so panic/early-return paths still stop the accept loop.
#[cfg(test)]
pub(crate) struct ShutdownOnDrop(pub Option<watch::Sender<()>>);

#[cfg(test)]
impl Drop for ShutdownOnDrop {
    fn drop(&mut self) {
        if let Some(tx) = self.0.take() {
            let _ = tx.send(());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        is_addr_in_use_error, map_startup_recv_timeout_error, should_retry_startup_error,
        spawn_server_instance, ShutdownOnDrop,
    };
    use crate::limits::Limits;
    use crate::rate_limit::RateLimits;
    use crate::server::wait_for_server_drain;
    use crate::server::CloseDrainTiming;
    use crate::server_metrics::ServerMetrics;
    use crate::server_tls::build_default_dev_resolver;
    use std::sync::Arc;
    use std::time::Duration;

    #[test]
    fn startup_recv_helpers_cover_retry_and_timeout_branches() {
        assert!(should_retry_startup_error("Address already in use", 0, 2));
        assert!(!should_retry_startup_error("Address already in use", 1, 2));
        assert!(!should_retry_startup_error("connection refused", 0, 2));
        assert_eq!(
            map_startup_recv_timeout_error(std::sync::mpsc::RecvTimeoutError::Timeout),
            "server startup timed out"
        );
        assert_eq!(
            map_startup_recv_timeout_error(std::sync::mpsc::RecvTimeoutError::Disconnected),
            "server startup channel disconnected"
        );
    }

    #[test]
    fn is_addr_in_use_error_matches_common_os_phrasing() {
        assert!(is_addr_in_use_error("Address already in use (os error 48)"));
        assert!(is_addr_in_use_error("bind: AddrInUse"));
        assert!(!is_addr_in_use_error("connection refused"));
    }

    #[test]
    fn spawn_server_instance_binds_ephemeral_port_and_shuts_down() {
        let server_id = u64::MAX - 20;
        let metrics = Arc::new(ServerMetrics::default());
        let limits = Limits::default();
        let rate_limits = RateLimits::default();
        let resolver = build_default_dev_resolver().expect("dev resolver");
        // Bind port 0 and use the OS-reported port (no probe/drop TOCTOU).
        let (shutdown_tx, bound_port) = spawn_server_instance(
            server_id,
            Arc::clone(&metrics),
            &limits,
            &rate_limits,
            "127.0.0.1",
            0,
            &None,
            &None,
            resolver,
            crate::client::CongestionControlMode::Default,
            false,
            3,
        )
        .expect("server should start");
        assert_ne!(bound_port, 0, "OS must assign a non-zero ephemeral port");
        let _shutdown = ShutdownOnDrop(Some(shutdown_tx));
        // Drain must observe idle after shutdown signal (no sessions accepted).
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("rt");
        drop(_shutdown);
        let drain = rt.block_on(wait_for_server_drain(
            &metrics,
            server_id,
            CloseDrainTiming {
                grace_period: Duration::from_millis(500),
                abort_period: Duration::from_millis(200),
                poll_interval: Duration::from_millis(10),
            },
        ));
        assert!(drain.is_none(), "unexpected drain diagnostic: {drain:?}");
    }

    #[test]
    fn spawn_server_instance_reports_addr_in_use() {
        let held = std::net::UdpSocket::bind("127.0.0.1:0").expect("hold port");
        let port = held.local_addr().expect("addr").port();
        let server_id = u64::MAX - 21;
        let metrics = Arc::new(ServerMetrics::default());
        let err = spawn_server_instance(
            server_id,
            metrics,
            &Limits::default(),
            &RateLimits::default(),
            "127.0.0.1",
            port,
            &None,
            &None,
            build_default_dev_resolver().expect("dev resolver"),
            crate::client::CongestionControlMode::Default,
            false,
            1,
        )
        .expect_err("port held by UDP socket should fail QUIC bind");
        assert!(
            is_addr_in_use_error(&err) || err.contains("failed to create endpoint"),
            "unexpected bind error: {err}"
        );
    }

    #[test]
    fn spawn_server_instance_retries_then_fails_on_addr_in_use() {
        let held = std::net::UdpSocket::bind("127.0.0.1:0").expect("hold port");
        let port = held.local_addr().expect("addr").port();
        let server_id = u64::MAX - 22;
        let err = spawn_server_instance(
            server_id,
            Arc::new(ServerMetrics::default()),
            &Limits::default(),
            &RateLimits::default(),
            "127.0.0.1",
            port,
            &None,
            &None,
            build_default_dev_resolver().expect("dev resolver"),
            crate::client::CongestionControlMode::Default,
            false,
            2,
        )
        .expect_err("held port must fail after retry");
        assert!(
            is_addr_in_use_error(&err) || err.contains("failed to create endpoint"),
            "unexpected bind error: {err}"
        );
    }

    #[test]
    fn spawn_server_instance_zero_retries_fails_immediately() {
        let err = spawn_server_instance(
            u64::MAX - 23,
            Arc::new(ServerMetrics::default()),
            &Limits::default(),
            &RateLimits::default(),
            "127.0.0.1",
            1,
            &None,
            &None,
            build_default_dev_resolver().expect("dev resolver"),
            crate::client::CongestionControlMode::Default,
            false,
            0,
        )
        .expect_err("zero retries must fail without attempting bind");
        assert!(err.contains("server startup failed"));
    }
}
