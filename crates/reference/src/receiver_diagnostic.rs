//! Opt-in, bounded Linux receiver-observation channel. No packet-path work.

use std::io;
use std::net::SocketAddr;

const MAX_ENDPOINTS: usize = 128;
#[cfg(any(target_os = "linux", test))]
const MAX_ACK: usize = 16384;
#[cfg(any(target_os = "linux", test))]
const MAX_READY: usize = MAX_ACK - 6;
#[cfg(any(target_os = "linux", test))]
const MAX_FRAMES: usize = 10;
#[cfg(any(target_os = "linux", test))]
const MAX_BYTES: usize = 32768;

fn invalid(message: &str) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        format!("receiver diagnostic: {message}"),
    )
}

fn valid_options(fd: Option<i32>, token: Option<&str>, endpoints: usize) -> io::Result<()> {
    match (fd, token) {
        (None, None) => Ok(()),
        (Some(fd), Some(token))
            if fd >= 3 && valid_token(token) && (1..=MAX_ENDPOINTS).contains(&endpoints) =>
        {
            Ok(())
        }
        _ => Err(invalid(
            "requires paired fd>=3 and 64 lowercase hex token, with 1..=128 endpoints",
        )),
    }
}

fn valid_token(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

#[derive(Clone, Default)]
pub(crate) struct Config {
    fd: Option<i32>,
    token: Option<String>,
}

impl Config {
    pub(crate) fn set_fd(&mut self, value: Option<String>) -> io::Result<()> {
        if self.fd.is_some() {
            return Err(invalid("duplicate fd option"));
        }
        self.fd = Some(
            value
                .ok_or_else(|| invalid("missing fd"))?
                .parse()
                .map_err(|_| invalid("invalid fd"))?,
        );
        Ok(())
    }

    pub(crate) fn set_token(&mut self, value: Option<String>) -> io::Result<()> {
        if self.token.is_some() {
            return Err(invalid("duplicate token option"));
        }
        self.token = Some(value.ok_or_else(|| invalid("missing token"))?);
        Ok(())
    }

    pub(crate) fn validate(&self, endpoints: usize) -> io::Result<()> {
        valid_options(self.fd, self.token.as_deref(), endpoints)
    }
}

// Framing/state is independent of the socket transport for exact byte tests.
#[cfg(any(target_os = "linux", test))]
struct Protocol {
    token: String,
    ready: bool,
    ended: bool,
    storm: bool,
    phase: usize,
    last_ns: u64,
    frames: usize,
    bytes: usize,
}

#[cfg(any(target_os = "linux", test))]
impl Protocol {
    fn new(token: String, storm: bool) -> Self {
        Self {
            token,
            ready: false,
            ended: false,
            storm,
            phase: 0,
            last_ns: 0,
            frames: 0,
            bytes: 0,
        }
    }

    fn bounded(&mut self, frame: String, cap: usize) -> io::Result<Vec<u8>> {
        if frame.len() > cap
            || self.frames >= MAX_FRAMES
            || frame.len() > MAX_BYTES.saturating_sub(self.bytes)
        {
            return Err(invalid("outbound frame/byte cap"));
        }
        self.frames += 1;
        self.bytes += frame.len();
        Ok(frame.into_bytes())
    }

    fn ready(&mut self, addresses: &[SocketAddr], pid: u32, ns: u64) -> io::Result<Vec<u8>> {
        if self.ready
            || !valid_token(&self.token)
            || pid == 0
            || ns == 0
            || !(1..=MAX_ENDPOINTS).contains(&addresses.len())
        {
            return Err(invalid("invalid READY state/map"));
        }
        let mut unique = std::collections::HashSet::new();
        let mut frame = format!(
            "G6RD1\tREADY\t{}\t{pid}\t{ns}\t{}\n",
            self.token,
            addresses.len()
        );
        for (index, address) in addresses.iter().enumerate() {
            if address.port() == 0 || !unique.insert(*address) {
                return Err(invalid("duplicate or unbound endpoint"));
            }
            frame.push_str(&format!("{index}\t{address}\n"));
        }
        let result = self.bounded(frame, MAX_READY)?;
        self.ready = true;
        self.last_ns = ns;
        Ok(result)
    }

    fn phases(&self) -> &'static [&'static str] {
        if self.storm {
            &[
                "connect",
                "steady",
                "drain",
                "storm",
                "post-storm",
                "idle",
                "stop",
            ]
        } else {
            &["connect", "steady", "drain", "idle", "stop"]
        }
    }

    fn phase(&mut self, name: &str, before: u64, after: u64) -> io::Result<Vec<u8>> {
        if !self.ready
            || self.ended
            || self.phases().get(self.phase) != Some(&name)
            || before == 0
            || before < self.last_ns
            || after < before
        {
            return Err(invalid("phase order/clock regression"));
        }
        let result = self.bounded(
            format!(
                "G6RD1\tPHASE\t{}\t{}\t{name}\t{before}\t{after}\n",
                self.token,
                self.phase + 1
            ),
            512,
        )?;
        self.phase += 1;
        self.last_ns = after;
        Ok(result)
    }

    fn end(&mut self, ns: u64) -> io::Result<Vec<u8>> {
        if !self.ready
            || self.ended
            || self.phase != self.phases().len()
            || ns == 0
            || ns < self.last_ns
        {
            return Err(invalid("premature/duplicate END or clock regression"));
        }
        let result = self.bounded(
            format!("G6RD1\tEND\t{}\t{}\t{ns}\n", self.token, self.phase + 1),
            512,
        )?;
        self.ended = true;
        Ok(result)
    }
}

/// Own the inherited FD before endpoint construction/runtime startup can reuse
/// a mistakenly closed descriptor. Disabled mode does no diagnostic I/O or clock work.
pub(crate) struct Diagnostic {
    #[cfg(target_os = "linux")]
    channel: Option<linux::Channel>,
}

impl Diagnostic {
    pub(crate) fn open(config: &Config, storm: bool) -> io::Result<Self> {
        #[cfg(target_os = "linux")]
        {
            let channel = match (config.fd, config.token.as_deref()) {
                (None, None) => None,
                (Some(fd), Some(token)) => {
                    Some(linux::Channel::open(fd, token.to_string(), storm)?)
                }
                _ => return Err(invalid("unpaired options")),
            };
            Ok(Self { channel })
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = storm;
            if config.fd.is_some() || config.token.is_some() {
                return Err(invalid("enabled mode requires Linux"));
            }
            Ok(Self {})
        }
    }

    pub(crate) async fn start(&mut self, addresses: &[SocketAddr]) -> io::Result<()> {
        #[cfg(target_os = "linux")]
        if let Some(channel) = self.channel.as_mut() {
            return channel.start(addresses).await;
        }
        let _ = addresses;
        Ok(())
    }

    pub(crate) fn boundary<T>(&mut self, name: &str, change: impl FnOnce() -> T) -> io::Result<T> {
        #[cfg(target_os = "linux")]
        if let Some(channel) = self.channel.as_mut() {
            return channel.boundary(name, change);
        }
        let _ = name;
        Ok(change())
    }

    pub(crate) fn end(&mut self) -> io::Result<()> {
        #[cfg(target_os = "linux")]
        if let Some(channel) = self.channel.as_mut() {
            return channel.end();
        }
        Ok(())
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use super::*;
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::net::UnixDatagram;
    use std::time::Duration;

    pub(super) struct Channel {
        socket: UnixDatagram,
        protocol: Protocol,
        armed: bool,
        failed: bool,
    }

    impl Channel {
        pub(super) fn open(fd: i32, token: String, storm: bool) -> io::Result<Self> {
            // SAFETY: these process identity queries have no pointer arguments.
            Self::with_peer(fd, token, storm, unsafe { libc::getppid() }, unsafe {
                libc::geteuid()
            })
        }

        fn with_peer(
            fd: i32,
            token: String,
            storm: bool,
            pid: libc::pid_t,
            uid: libc::uid_t,
        ) -> io::Result<Self> {
            if fd < 3 || !valid_token(&token) {
                return Err(invalid("invalid descriptor/token"));
            }
            // Check open before taking ownership. The caller relinquishes this FD;
            // there must be no concurrent close/reuse by another owner.
            let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
            if flags < 0 {
                return Err(io::Error::last_os_error());
            }
            // SAFETY: CLI explicitly transfers this open, non-stdio descriptor.
            let socket = unsafe { UnixDatagram::from_raw_fd(fd) };
            fn option<T: Copy>(fd: i32, name: i32, mut value: T) -> io::Result<T> {
                let mut size = std::mem::size_of::<T>() as libc::socklen_t;
                // SAFETY: value/size are valid writable buffers of the declared size.
                let result = unsafe {
                    libc::getsockopt(
                        fd,
                        libc::SOL_SOCKET,
                        name,
                        (&mut value as *mut T).cast(),
                        &mut size,
                    )
                };
                if result < 0 {
                    return Err(io::Error::last_os_error());
                }
                if size as usize != std::mem::size_of::<T>() {
                    return Err(invalid("socket option size"));
                }
                Ok(value)
            }
            if option(fd, libc::SO_DOMAIN, 0i32)? != libc::AF_UNIX
                || option(fd, libc::SO_TYPE, 0i32)? != libc::SOCK_DGRAM
            {
                return Err(invalid("requires AF_UNIX SOCK_DGRAM"));
            }
            socket.peer_addr()?;
            let peer = option(
                fd,
                libc::SO_PEERCRED,
                libc::ucred {
                    pid: 0,
                    uid: 0,
                    gid: 0,
                },
            )?;
            if peer.pid != pid || peer.uid != uid {
                return Err(invalid("peer PID/UID mismatch"));
            }
            if unsafe { libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) } < 0 {
                return Err(io::Error::last_os_error());
            }
            socket.set_nonblocking(true)?;
            Ok(Self {
                socket,
                protocol: Protocol::new(token, storm),
                armed: false,
                failed: false,
            })
        }

        fn send(&mut self, frame: &[u8]) -> io::Result<()> {
            if self.failed {
                return Err(invalid("channel previously failed"));
            }
            match self.socket.send(frame) {
                Ok(count) if count == frame.len() => Ok(()),
                Ok(_) => {
                    self.failed = true;
                    Err(invalid("short datagram send"))
                }
                Err(error) => {
                    self.failed = true;
                    Err(error)
                }
            }
        }

        fn receive(&self, buffer: &mut [u8]) -> io::Result<Option<usize>> {
            // MSG_TRUNC returns the complete datagram length even if the fixed
            // receive buffer is too small; a matching truncated prefix cannot pass.
            let count = unsafe {
                libc::recv(
                    self.socket.as_raw_fd(),
                    buffer.as_mut_ptr().cast(),
                    buffer.len(),
                    libc::MSG_DONTWAIT | libc::MSG_TRUNC,
                )
            };
            if count >= 0 {
                return Ok(Some(count as usize));
            }
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::WouldBlock {
                Ok(None)
            } else {
                Err(error)
            }
        }

        fn no_control(&mut self) -> io::Result<()> {
            if self.failed {
                return Err(invalid("channel previously failed"));
            }
            // Any pending input, including zero-length/oversized input, is invalid.
            match self.receive(&mut [0u8; 1]) {
                Ok(None) => Ok(()),
                Ok(Some(_)) => {
                    self.failed = true;
                    Err(invalid("unexpected/duplicate control input"))
                }
                Err(error) => {
                    self.failed = true;
                    Err(error)
                }
            }
        }

        pub(super) async fn start(&mut self, addresses: &[SocketAddr]) -> io::Result<()> {
            let deadline = tokio::time::Instant::now() + Duration::from_millis(2000);
            let ready =
                self.protocol
                    .ready(addresses, std::process::id(), crate::monotonic_ns())?;
            self.send(&ready)?;
            let mut expected = b"ARMED\n".to_vec();
            expected.extend_from_slice(&ready);
            let mut buffer = [0u8; MAX_ACK];
            loop {
                if tokio::time::Instant::now() >= deadline {
                    self.failed = true;
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "receiver diagnostic: ACK timeout",
                    ));
                }
                if let Some(count) = self.receive(&mut buffer)? {
                    if count != expected.len()
                        || count > buffer.len()
                        || buffer[..count] != expected
                    {
                        self.failed = true;
                        return Err(invalid("nonidentical/truncated ACK"));
                    }
                    self.no_control()?;
                    // Recheck after input validation; never accept a late ACK.
                    if tokio::time::Instant::now() >= deadline {
                        self.failed = true;
                        return Err(invalid("ACK deadline exceeded"));
                    }
                    self.armed = true;
                    return Ok(());
                }
                tokio::time::sleep_until(
                    (tokio::time::Instant::now() + Duration::from_millis(1)).min(deadline),
                )
                .await;
            }
        }

        pub(super) fn boundary<T>(
            &mut self,
            name: &str,
            change: impl FnOnce() -> T,
        ) -> io::Result<T> {
            if !self.armed {
                return Err(invalid("boundary before ACK"));
            }
            self.no_control()?;
            let before = crate::monotonic_ns();
            let result = change();
            let after = crate::monotonic_ns();
            let frame = self.protocol.phase(name, before, after)?;
            self.send(&frame)?;
            Ok(result)
        }

        pub(super) fn end(&mut self) -> io::Result<()> {
            if !self.armed {
                return Err(invalid("END before ACK"));
            }
            self.no_control()?;
            let frame = self.protocol.end(crate::monotonic_ns())?;
            self.send(&frame)
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::os::fd::IntoRawFd;

        fn pair() -> (Channel, UnixDatagram) {
            let (child, parent) = UnixDatagram::pair().unwrap();
            parent.set_nonblocking(true).unwrap();
            let channel = Channel::with_peer(
                child.into_raw_fd(),
                "a".repeat(64),
                false,
                unsafe { libc::getpid() },
                unsafe { libc::geteuid() },
            )
            .unwrap();
            (channel, parent)
        }

        async fn ready(parent: &UnixDatagram) -> Vec<u8> {
            tokio::time::timeout(Duration::from_millis(500), async {
                let mut buffer = [0; MAX_ACK];
                loop {
                    match parent.recv(&mut buffer) {
                        Ok(n) => return buffer[..n].to_vec(),
                        Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                            tokio::time::sleep(Duration::from_millis(1)).await
                        }
                        Err(e) => panic!("{e}"),
                    }
                }
            })
            .await
            .unwrap()
        }

        #[test]
        fn descriptor_flags_peer_validation_and_drop() {
            let (channel, _parent) = pair();
            let fd = channel.socket.as_raw_fd();
            assert_ne!(
                unsafe { libc::fcntl(fd, libc::F_GETFD) } & libc::FD_CLOEXEC,
                0
            );
            assert_ne!(
                unsafe { libc::fcntl(fd, libc::F_GETFL) } & libc::O_NONBLOCK,
                0
            );
            drop(channel);
            assert_eq!(unsafe { libc::fcntl(fd, libc::F_GETFD) }, -1);
            for (pid, uid) in [
                (unsafe { libc::getpid() } + 1, unsafe { libc::geteuid() }),
                (unsafe { libc::getpid() }, unsafe { libc::geteuid() } + 1),
            ] {
                let (child, _parent) = UnixDatagram::pair().unwrap();
                assert!(
                    Channel::with_peer(child.into_raw_fd(), "a".repeat(64), false, pid, uid)
                        .is_err()
                );
            }
            assert!(Channel::open(2, "a".repeat(64), false).is_err());
            assert!(Channel::open(i32::MAX, "a".repeat(64), false).is_err());
            let unconnected = UnixDatagram::unbound().unwrap();
            assert!(Channel::open(unconnected.into_raw_fd(), "a".repeat(64), false).is_err());
            let (stream, _peer) = std::os::unix::net::UnixStream::pair().unwrap();
            assert!(Channel::open(stream.into_raw_fd(), "a".repeat(64), false).is_err());
            let udp = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
            assert!(Channel::open(udp.into_raw_fd(), "a".repeat(64), false).is_err());
        }

        #[tokio::test]
        async fn exact_ack_and_driver_boundaries_complete() {
            let (mut channel, parent) = pair();
            let addresses = ["0.0.0.0:30000".parse().unwrap()];
            let peer = async {
                let frame = ready(&parent).await;
                let mut ack = b"ARMED\n".to_vec();
                ack.extend(frame);
                parent.send(&ack).unwrap();
            };
            let (result, ()) = tokio::join!(channel.start(&addresses), peer);
            result.unwrap();
            for name in ["connect", "steady", "drain", "idle", "stop"] {
                assert_eq!(channel.boundary(name, || 42).unwrap(), 42);
                assert!(String::from_utf8(ready(&parent).await)
                    .unwrap()
                    .contains(&format!("\t{name}\t")));
            }
            channel.end().unwrap();
            assert!(String::from_utf8(ready(&parent).await)
                .unwrap()
                .contains("\tEND\t"));
            assert!(channel.end().is_err());
        }

        #[tokio::test]
        async fn malformed_stale_oversized_and_duplicate_ack_fail() {
            for mode in 0..6 {
                let (mut channel, parent) = pair();
                let addresses = ["0.0.0.0:30000".parse().unwrap()];
                let peer = async {
                    let frame = ready(&parent).await;
                    let mut ack = b"ARMED\n".to_vec();
                    ack.extend(frame);
                    match mode {
                        0 => ack[0] = b'X',
                        1 => ack[20] = b'b',
                        2 => ack.truncate(ack.len() - 1),
                        3 => ack.resize(MAX_ACK + 1, b'x'),
                        4 => {}
                        _ => ack.clear(),
                    }
                    parent.send(&ack).unwrap();
                    if mode == 4 {
                        parent.send(&ack).unwrap();
                    }
                };
                let (result, ()) = tokio::join!(channel.start(&addresses), peer);
                assert!(result.is_err(), "mode {mode}");
                assert!(!channel.armed);
            }
        }

        #[tokio::test]
        async fn ack_timeout_and_cancel_are_bounded() {
            let (mut channel, _parent) = pair();
            let began = std::time::Instant::now();
            let result = tokio::time::timeout(
                Duration::from_secs(3),
                channel.start(&["0.0.0.0:30000".parse().unwrap()]),
            )
            .await
            .unwrap();
            assert_eq!(result.unwrap_err().kind(), io::ErrorKind::TimedOut);
            assert!(began.elapsed() >= Duration::from_millis(2000));
            assert!(!channel.armed);
            let (mut channel, _parent) = pair();
            let fd = channel.socket.as_raw_fd();
            assert!(tokio::time::timeout(
                Duration::from_millis(5),
                channel.start(&["0.0.0.0:30000".parse().unwrap()])
            )
            .await
            .is_err());
            drop(channel);
            assert_eq!(unsafe { libc::fcntl(fd, libc::F_GETFD) }, -1);
        }

        #[test]
        fn closure_saturation_and_unexpected_control_fail_without_retry() {
            let (mut channel, parent) = pair();
            drop(parent);
            assert!(channel.send(b"test").is_err());
            assert!(channel.failed);
            let (mut channel, _parent) = pair();
            let began = std::time::Instant::now();
            let mut failed = false;
            for _ in 0..4096 {
                if channel.send(&[0; 16384]).is_err() {
                    failed = true;
                    break;
                }
            }
            assert!(failed && channel.failed);
            assert!(began.elapsed() < Duration::from_secs(1));
            let (mut channel, parent) = pair();
            parent.send(b"extra").unwrap();
            assert!(channel.no_control().is_err());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paired_options_reject_invalid_descriptors_tokens_and_endpoint_counts() {
        let token = "a".repeat(64);
        assert!(valid_options(None, None, 512).is_ok());
        assert!(valid_options(Some(3), Some(&token), 128).is_ok());
        for (fd, value, count) in [
            (Some(3), None, 1),
            (None, Some(token.as_str()), 1),
            (Some(2), Some(token.as_str()), 1),
            (Some(-1), Some(token.as_str()), 1),
            (Some(3), Some("ABC"), 1),
            (Some(3), Some(token.as_str()), 0),
            (Some(3), Some(token.as_str()), 129),
        ] {
            assert!(
                valid_options(fd, value, count).is_err(),
                "accepted {fd:?}/{value:?}/{count}"
            );
        }
        assert!(valid_options(Some(3), Some(&"A".repeat(64)), 1).is_err());
        assert!(valid_options(Some(3), Some(&"g".repeat(64)), 1).is_err());
    }

    #[test]
    fn option_duplicates_and_missing_values_fail() {
        let mut config = Config::default();
        assert!(config.set_fd(None).is_err());
        assert!(config.set_fd(Some("bad".into())).is_err());
        config.set_fd(Some("3".into())).unwrap();
        assert!(config.set_fd(Some("4".into())).is_err());
        assert!(config.set_token(None).is_err());
        config.set_token(Some("a".repeat(64))).unwrap();
        assert!(config.set_token(Some("b".repeat(64))).is_err());
        config.validate(128).unwrap();
    }

    #[test]
    fn ready_bytes_map_bounds_and_duplicate_rejection() {
        let mut p = Protocol::new("a".repeat(64), false);
        let addresses = [
            "0.0.0.0:30000".parse().unwrap(),
            "[::1]:30001".parse().unwrap(),
        ];
        assert_eq!(
            p.ready(&addresses, 17, 20).unwrap(),
            format!(
                "G6RD1\tREADY\t{}\t17\t20\t2\n0\t0.0.0.0:30000\n1\t[::1]:30001\n",
                "a".repeat(64)
            )
            .as_bytes()
        );
        assert!(p.ready(&addresses, 17, 20).is_err());
        for addresses in [
            vec![],
            vec![addresses[0]; 2],
            vec![addresses[0]; 129],
            vec!["0.0.0.0:0".parse().unwrap()],
        ] {
            assert!(Protocol::new("a".repeat(64), false)
                .ready(&addresses, 17, 20)
                .is_err());
        }
        let large: Vec<SocketAddr> = (30000..30128)
            .map(|port| {
                format!("[ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff%4294967295]:{port}")
                    .parse()
                    .unwrap()
            })
            .collect();
        assert!(
            Protocol::new("a".repeat(64), false)
                .ready(&large, u32::MAX, u64::MAX)
                .unwrap()
                .len()
                <= MAX_READY
        );
    }

    #[test]
    fn phase_order_clocks_end_and_output_budgets() {
        for storm in [false, true] {
            let mut p = Protocol::new("a".repeat(64), storm);
            assert!(p.phase("connect", 1, 2).is_err());
            p.ready(&["0.0.0.0:30000".parse().unwrap()], 1, 10).unwrap();
            assert!(p.end(11).is_err());
            assert!(p.phase("steady", 11, 12).is_err());
            assert!(p.phase("connect", 9, 12).is_err());
            assert!(p.phase("connect", 11, 10).is_err());
            let phases = p.phases();
            for (i, name) in phases.iter().enumerate() {
                let ns = 20 + i as u64 * 2;
                let frame = p.phase(name, ns, ns + 1).unwrap();
                assert_eq!(
                    frame,
                    format!(
                        "G6RD1\tPHASE\t{}\t{}\t{name}\t{ns}\t{}\n",
                        "a".repeat(64),
                        i + 1,
                        ns + 1
                    )
                    .as_bytes()
                );
            }
            p.end(100).unwrap();
            assert!(p.end(101).is_err());
            assert!(p.phase("stop", 101, 102).is_err());
            assert!(p.frames <= MAX_FRAMES && p.bytes <= MAX_BYTES);
        }
        let mut p = Protocol::new("a".repeat(64), false);
        assert!(p.bounded("x".repeat(513), 512).is_err());
        p.frames = MAX_FRAMES;
        assert!(p.bounded("x".into(), 512).is_err());
        p.frames = 0;
        p.bytes = MAX_BYTES;
        assert!(p.bounded("x".into(), 512).is_err());
    }

    #[tokio::test]
    async fn disabled_runs_closure_even_without_subscribers_or_protocol_order() {
        let mut diagnostic = Diagnostic::open(&Config::default(), false).unwrap();
        diagnostic.start(&[]).await.unwrap();
        let (tx, rx) = tokio::sync::watch::channel(0);
        drop(rx);
        assert!(diagnostic
            .boundary("arbitrary", || tx.send(1))
            .unwrap()
            .is_err());
        assert_eq!(diagnostic.boundary("stop", || 7).unwrap(), 7);
        diagnostic.end().unwrap();
    }

    #[cfg(not(target_os = "linux"))]
    #[test]
    fn enabled_mode_is_explicitly_rejected_off_linux() {
        let mut config = Config::default();
        config.set_fd(Some("3".into())).unwrap();
        config.set_token(Some("a".repeat(64))).unwrap();
        let error = match Diagnostic::open(&config, false) {
            Ok(_) => panic!("enabled diagnostic accepted off Linux"),
            Err(error) => error,
        };
        assert!(error.to_string().contains("requires Linux"));
    }
}
