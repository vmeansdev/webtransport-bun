//! Server instance spawn/bind helpers (excluded from risk-module coverage floors).
//! Floors target `server.rs` for TLS rotation and close-drain logic.

use std::sync::Arc;
use std::time::Duration;
use tokio::sync::watch;

use crate::limits::Limits;
use crate::rate_limit::RateLimits;
use crate::server_metrics::ServerMetrics;
use crate::{LogEvent, SessionEvent};

/// Endpoint-construction options for one server instance: everything decided
/// once, at bind time, that the running server cannot change. The default
/// reproduces the plain `with_bind_address` path with quinn's own CIDs.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct BindOptions {
    /// Set `SO_REUSEPORT` on the bind socket so sibling processes can share the
    /// port. Unix only; the caller rejects it elsewhere.
    pub reuse_port: bool,
    /// Issue QUIC-LB connection IDs carrying this instance's server ID, so an
    /// L4 balancer can route by CID instead of by 4-tuple. `None` leaves
    /// quinn's default random 8-octet CIDs in place.
    pub quic_lb: Option<crate::quic_lb::QuicLbConfig>,
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
            bind.clone(),
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
        let bind = BindOptions {
            reuse_port: true,
            ..Default::default()
        };
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
            bind.clone(),
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

    /// The generator only proves itself against a real handshake: quinn's
    /// `new_cid` loops until it draws an unused CID, and `validate()` is
    /// consulted on every packet whose destination CID the endpoint does not
    /// already know. A deterministic nonce or an over-strict validate would
    /// show up here as a hang or a failed connect, not as a unit-test failure.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_client_handshakes_against_an_endpoint_issuing_quic_lb_cids() {
        use crate::quic_lb::QuicLbConfig;

        let server_id = vec![0x51, 0x1b];
        let bind = BindOptions {
            reuse_port: false,
            quic_lb: Some(QuicLbConfig::new(server_id.clone(), 8, 2).expect("valid config")),
        };
        let (session_tx, mut session_rx) = tokio::sync::mpsc::channel(4);
        let (shutdown_tx, port) = spawn_server_instance(
            u64::MAX - 28,
            Arc::new(ServerMetrics::default()),
            &Limits::default(),
            &RateLimits::default(),
            "127.0.0.1",
            0,
            &Some(session_tx),
            &None,
            build_default_dev_resolver().expect("dev resolver"),
            crate::client::CongestionControlMode::Default,
            false,
            false,
            false,
            0,
            bind,
            3,
        )
        .expect("QUIC-LB server should start");
        let _shutdown = ShutdownOnDrop(Some(shutdown_tx));

        // Nothing in quinn's or wtransport's API hands back the CID the server
        // issued, so the wire is read directly: a UDP relay between client and
        // server keeps the first packet the server sends, whose long-header
        // Source Connection ID is exactly the CID under test.
        let (relay_port, first_server_packet) = spawn_capturing_relay(port).await;

        let client_cfg = crate::client::insecure_loopback_client_config().expect("client cfg");
        let endpoint = wtransport::Endpoint::client(client_cfg).expect("client endpoint");
        let _conn = tokio::time::timeout(
            Duration::from_secs(10),
            endpoint.connect(format!("https://127.0.0.1:{relay_port}/")),
        )
        .await
        .expect("handshake must not hang on CID generation")
        .expect("connect");
        let accepted = tokio::time::timeout(Duration::from_secs(5), session_rx.recv())
            .await
            .expect("accept timeout")
            .expect("session event");
        assert!(
            matches!(accepted, crate::SessionEvent::Accepted(_)),
            "the WebTransport session must establish over QUIC-LB CIDs"
        );

        let packet = first_server_packet
            .lock()
            .expect("relay capture")
            .clone()
            .expect("the server must have sent at least one packet");
        let cid = long_header_source_cid(&packet).expect("server's first packet is a long header");
        assert_eq!(
            cid.len(),
            11,
            "1 first octet + 2 server-ID octets + 8 nonce octets, got {cid:02x?}"
        );
        assert_eq!(crate::quic_lb::decode_config_rotation(&cid), Some(2));
        assert_eq!(
            crate::quic_lb::decode_server_id(&cid, server_id.len()),
            Some(server_id.as_slice()),
            "a balancer must read this instance's server ID out of the CID"
        );
    }

    /// Forwards UDP between one client and `server_port`, keeping a copy of the
    /// first datagram the server sends. Returns the port clients should use and
    /// the capture slot.
    #[cfg(test)]
    async fn spawn_capturing_relay(
        server_port: u16,
    ) -> (u16, Arc<std::sync::Mutex<Option<Vec<u8>>>>) {
        let socket = tokio::net::UdpSocket::bind("127.0.0.1:0")
            .await
            .expect("relay bind");
        let relay_port = socket.local_addr().expect("relay addr").port();
        let server_addr: std::net::SocketAddr = format!("127.0.0.1:{server_port}")
            .parse()
            .expect("server addr");
        let captured = Arc::new(std::sync::Mutex::new(None::<Vec<u8>>));
        let sink = Arc::clone(&captured);

        tokio::spawn(async move {
            let mut buf = vec![0u8; 2048];
            let mut client_addr: Option<std::net::SocketAddr> = None;
            loop {
                let Ok((n, from)) = socket.recv_from(&mut buf).await else {
                    return;
                };
                if from == server_addr {
                    {
                        let mut slot = sink.lock().expect("relay capture");
                        if slot.is_none() {
                            *slot = Some(buf[..n].to_vec());
                        }
                    }
                    if let Some(client) = client_addr {
                        let _ = socket.send_to(&buf[..n], client).await;
                    }
                } else {
                    client_addr = Some(from);
                    let _ = socket.send_to(&buf[..n], server_addr).await;
                }
            }
        });

        (relay_port, captured)
    }

    /// Reads the Source Connection ID out of a QUIC long-header packet
    /// (RFC 9000 §17.2): header byte, 4-octet version, then each CID prefixed
    /// by its own length octet.
    #[cfg(test)]
    fn long_header_source_cid(packet: &[u8]) -> Option<Vec<u8>> {
        if packet.first()? & 0x80 == 0 {
            return None;
        }
        let dcid_len = *packet.get(5)? as usize;
        let scid_len_at = 6 + dcid_len;
        let scid_len = *packet.get(scid_len_at)? as usize;
        packet
            .get(scid_len_at + 1..scid_len_at + 1 + scid_len)
            .map(<[u8]>::to_vec)
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
            BindOptions {
                reuse_port: true,
                ..Default::default()
            },
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
