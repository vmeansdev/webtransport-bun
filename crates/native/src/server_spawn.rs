//! Server instance spawn/bind helpers (excluded from risk-module coverage floors).
//! Floors target `server.rs` for TLS rotation and close-drain logic.

use std::sync::Arc;
use std::time::Duration;
use tokio::sync::watch;

use crate::limits::Limits;
use crate::rate_limit::RateLimits;
use crate::server_metrics::ServerMetrics;
use crate::{LogEvent, SessionEvent};

/// Socket-level bind behavior for one server instance. The default reproduces
/// the plain `with_bind_address` path.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct BindOptions {
    /// Set `SO_REUSEPORT` on the bind socket so sibling processes can share the
    /// port. Unix only; the caller rejects it elsewhere.
    pub reuse_port: bool,
}

/// Builds the server's UDP socket with `SO_REUSEPORT` set before `bind()`.
///
/// This mirrors what the fork's `BindAddressConfig::bind_socket` does for a
/// plain address bind (`Ipv6DualStackConfig::OsDefault`: `IPV6_V6ONLY` is left
/// at the OS default, never forced either way), because `with_bind_socket`
/// hands the socket straight through and skips that path entirely.
///
/// Nonblocking mode and GSO/GRO are deliberately not touched here: quinn-udp's
/// `UdpSocketState::new` configures both when the endpoint wraps the socket.
#[cfg(unix)]
pub(crate) fn bind_reuse_port_socket(
    addr: std::net::SocketAddr,
) -> std::io::Result<std::net::UdpSocket> {
    use socket2::{Domain, Protocol, Socket, Type};

    let domain = match addr {
        std::net::SocketAddr::V4(_) => Domain::IPV4,
        std::net::SocketAddr::V6(_) => Domain::IPV6,
    };
    let socket = Socket::new(domain, Type::DGRAM, Some(Protocol::UDP))?;
    socket.set_reuse_port(true)?;
    socket.bind(&addr.into())?;
    Ok(std::net::UdpSocket::from(socket))
}

#[cfg(not(unix))]
pub(crate) fn bind_reuse_port_socket(
    _addr: std::net::SocketAddr,
) -> std::io::Result<std::net::UdpSocket> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        REUSE_PORT_UNSUPPORTED,
    ))
}

/// Rejection message for `reusePort` on platforms without `SO_REUSEPORT`.
pub(crate) const REUSE_PORT_UNSUPPORTED: &str =
    "reusePort requires SO_REUSEPORT, which this platform does not provide";

/// True when this build can honor `reusePort`.
pub(crate) const fn reuse_port_supported() -> bool {
    cfg!(unix)
}

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
    enable_0rtt: bool,
    allow_early_session: bool,
    qpack_max_table_capacity: u64,
    bind: BindOptions,
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
            enable_0rtt,
            allow_early_session,
            qpack_max_table_capacity,
            bind,
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
        spawn_server_instance, BindOptions, ShutdownOnDrop,
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
            false,
            false,
            0,
            BindOptions::default(),
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
            false,
            false,
            0,
            BindOptions::default(),
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
            false,
            false,
            0,
            BindOptions::default(),
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
            false,
            false,
            0,
            BindOptions::default(),
            0,
        )
        .expect_err("zero retries must fail without attempting bind");
        assert!(err.contains("server startup failed"));
    }

    /// SO_REUSEPORT lets a second socket join the port. What the kernel then
    /// does with arriving packets is platform-owned (Linux hashes across the
    /// group, BSD/macOS delivers to the last binder), so nothing here asserts
    /// distribution — only that the group forms.
    #[cfg(unix)]
    #[test]
    fn reuse_port_sockets_share_one_port() {
        let first = super::bind_reuse_port_socket("127.0.0.1:0".parse().expect("addr"))
            .expect("first reusePort bind");
        let addr = first.local_addr().expect("bound addr");
        let second = super::bind_reuse_port_socket(addr).expect("second reusePort bind");
        assert_eq!(second.local_addr().expect("bound addr"), addr);
    }

    #[cfg(unix)]
    #[test]
    fn plain_bind_cannot_join_a_reuse_port_group() {
        let held = super::bind_reuse_port_socket("127.0.0.1:0".parse().expect("addr"))
            .expect("reusePort bind");
        let addr = held.local_addr().expect("bound addr");
        let err = std::net::UdpSocket::bind(addr)
            .expect_err("a socket without SO_REUSEPORT must not join the group");
        assert_eq!(err.kind(), std::io::ErrorKind::AddrInUse);
    }

    /// `with_bind_socket` skips the fork's own socket construction, so the
    /// reusePort path has to land on the same dual-stack default the plain
    /// `with_bind_address` path produces: IPV6_V6ONLY untouched.
    #[cfg(unix)]
    #[test]
    fn reuse_port_v6_bind_matches_the_os_default_dual_stack_setting() {
        use socket2::{Domain, Protocol, Socket, Type};

        let reference =
            Socket::new(Domain::IPV6, Type::DGRAM, Some(Protocol::UDP)).expect("reference socket");
        let os_default = reference.only_v6().expect("reference only_v6");

        let bound = super::bind_reuse_port_socket("[::1]:0".parse().expect("addr"))
            .expect("v6 reusePort bind");
        assert!(bound.local_addr().expect("bound addr").is_ipv6());
        assert_eq!(
            Socket::from(bound).only_v6().expect("only_v6"),
            os_default,
            "reusePort must not change IPV6_V6ONLY away from the OS default"
        );
    }

    #[cfg(unix)]
    #[test]
    fn two_server_instances_bind_the_same_port_with_reuse_port() {
        let bind = BindOptions { reuse_port: true };
        let (first_tx, port) = spawn_server_instance(
            u64::MAX - 24,
            Arc::new(ServerMetrics::default()),
            &Limits::default(),
            &RateLimits::default(),
            "127.0.0.1",
            0,
            &None,
            &None,
            build_default_dev_resolver().expect("dev resolver"),
            crate::client::CongestionControlMode::Default,
            false,
            false,
            false,
            0,
            bind,
            1,
        )
        .expect("first reusePort server should start");
        let _first = ShutdownOnDrop(Some(first_tx));

        let (second_tx, second_port) = spawn_server_instance(
            u64::MAX - 25,
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
            false,
            false,
            0,
            bind,
            1,
        )
        .expect("second reusePort server should share the port");
        let _second = ShutdownOnDrop(Some(second_tx));
        assert_eq!(second_port, port);
    }

    #[cfg(unix)]
    #[test]
    fn second_instance_without_reuse_port_still_reports_addr_in_use() {
        let (first_tx, port) = spawn_server_instance(
            u64::MAX - 26,
            Arc::new(ServerMetrics::default()),
            &Limits::default(),
            &RateLimits::default(),
            "127.0.0.1",
            0,
            &None,
            &None,
            build_default_dev_resolver().expect("dev resolver"),
            crate::client::CongestionControlMode::Default,
            false,
            false,
            false,
            0,
            BindOptions { reuse_port: true },
            1,
        )
        .expect("reusePort server should start");
        let _first = ShutdownOnDrop(Some(first_tx));

        let err = spawn_server_instance(
            u64::MAX - 27,
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
            false,
            false,
            0,
            BindOptions::default(),
            1,
        )
        .expect_err("a plain bind must not join the reusePort group");
        assert!(
            is_addr_in_use_error(&err) || err.contains("failed to create endpoint"),
            "unexpected bind error: {err}"
        );
    }
}
