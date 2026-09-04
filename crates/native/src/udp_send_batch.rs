//! Cross-connection UDP send batching for the server endpoint.
//!
//! quinn sends every transmit from the connection driver that produced it:
//! one `sendmsg` per connection per transmit, because GSO only batches
//! segments bound for one destination. At 40k sessions on c-48 that was
//! ~200k `sendmsg` calls per second per box for snapshots alone, issued from
//! the shared worker pool, while the two other levers tried on that rig
//! (pacing, r102; thinner ACKs, r103) both made the ack tail worse. This
//! module attacks the syscall count instead: connection drivers hand their
//! transmits to a per-socket ring, and one flusher thread per socket drains
//! the ring with `sendmmsg`, up to [`configured_batch`] datagrams per call.
//!
//! Contract with quinn (`AsyncUdpSocket::try_send`): the driver treats any
//! error other than `WouldBlock` as fatal for the connection, and `WouldBlock`
//! as "poll writable and retry". This wrapper therefore never returns an
//! error: a full ring drops the transmit and counts it, exactly what a full
//! kernel socket buffer would do, and quinn's loss recovery takes it from
//! there. Ordering per connection is preserved by the single flusher.
//!
//! `WEBTRANSPORT_NATIVE_UDP_SEND_BATCH` selects the batch size (2..=1024);
//! unset or 0 leaves the socket untouched, byte-for-byte today's behaviour.
//! Linux only for the batched path; elsewhere the flusher sends one at a time
//! through the inner socket and counts every datagram as a fallback.

use std::io;
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, OnceLock};

use wtransport::quinn::udp::{EcnCodepoint, RecvMeta, Transmit};
use wtransport::quinn::{AsyncUdpSocket, UdpPoller};

/// Transmits queued per socket before the flusher drains them; at ~1.3 KB
/// each this bounds the ring at a few MB per shard.
const RING_CAPACITY: usize = 4096;
const MIN_BATCH: usize = 2;
const MAX_BATCH: usize = 1024;

/// Parse `WEBTRANSPORT_NATIVE_UDP_SEND_BATCH`: unset, empty or `0` means off;
/// `2..=1024` is a batch size; anything else is an error the caller turns
/// into a fail-closed abort, like the other campaign knobs.
pub(crate) fn parse_batch(raw: Option<&str>) -> Result<Option<usize>, String> {
    match raw.map(str::trim) {
        None | Some("") | Some("0") => Ok(None),
        Some(text) => match text.parse::<usize>() {
            Ok(n) if (MIN_BATCH..=MAX_BATCH).contains(&n) => Ok(Some(n)),
            _ => Err(format!(
                "WEBTRANSPORT_NATIVE_UDP_SEND_BATCH must be 0 or {MIN_BATCH}..={MAX_BATCH}, got '{text}'"
            )),
        },
    }
}

/// The batch size this process resolved, once, so the socket wrapper and the
/// `serverUdpSendBatch` getter can never disagree.
pub(crate) fn configured_batch() -> Option<usize> {
    static RESOLVED: OnceLock<Option<usize>> = OnceLock::new();
    *RESOLVED.get_or_init(|| {
        match parse_batch(
            std::env::var("WEBTRANSPORT_NATIVE_UDP_SEND_BATCH")
                .ok()
                .as_deref(),
        ) {
            Ok(value) => value,
            Err(message) => {
                eprintln!("webtransport-native: FATAL E_INTERNAL: {message}");
                std::process::abort();
            }
        }
    })
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct Stats {
    pub calls: u64,
    pub messages: u64,
    pub fallback: u64,
    pub dropped: u64,
    pub errors: u64,
    pub max_batch: u64,
}

static CALLS: AtomicU64 = AtomicU64::new(0);
static MESSAGES: AtomicU64 = AtomicU64::new(0);
static FALLBACK: AtomicU64 = AtomicU64::new(0);
static DROPPED: AtomicU64 = AtomicU64::new(0);
static ERRORS: AtomicU64 = AtomicU64::new(0);
static MAX_BATCH_SEEN: AtomicU64 = AtomicU64::new(0);

pub(crate) fn stats() -> Stats {
    Stats {
        calls: CALLS.load(Ordering::Relaxed),
        messages: MESSAGES.load(Ordering::Relaxed),
        fallback: FALLBACK.load(Ordering::Relaxed),
        dropped: DROPPED.load(Ordering::Relaxed),
        errors: ERRORS.load(Ordering::Relaxed),
        max_batch: MAX_BATCH_SEEN.load(Ordering::Relaxed),
    }
}

/// A transmit copied out of quinn's send buffer so it can outlive the
/// driver's poll.
#[derive(Debug, Clone)]
pub(crate) struct OwnedTransmit {
    pub destination: SocketAddr,
    pub ecn: Option<EcnCodepoint>,
    pub contents: Vec<u8>,
    pub segment_size: Option<usize>,
    pub src_ip: Option<IpAddr>,
}

impl OwnedTransmit {
    fn from_transmit(transmit: &Transmit<'_>) -> Self {
        Self {
            destination: transmit.destination,
            ecn: transmit.ecn,
            contents: transmit.contents.to_vec(),
            segment_size: transmit.segment_size,
            src_ip: transmit.src_ip,
        }
    }

    fn as_transmit(&self) -> Transmit<'_> {
        Transmit {
            destination: self.destination,
            ecn: self.ecn,
            contents: &self.contents,
            segment_size: self.segment_size,
            src_ip: self.src_ip,
        }
    }
}

/// Wrap `inner` so its transmits go through a flusher thread owning
/// `flusher_socket`, a second handle to the same UDP socket.
pub(crate) fn wrap(
    inner: Arc<dyn AsyncUdpSocket>,
    flusher_socket: std::net::UdpSocket,
) -> Arc<dyn AsyncUdpSocket> {
    let batch = configured_batch().unwrap_or(MIN_BATCH);
    Arc::new(BatchedUdpSocket::spawn(inner, flusher_socket, batch))
}

/// A quinn runtime that batches the sockets it wraps; everything else is
/// the inner runtime's. The shared-mode server path hands quinn the plain
/// Tokio runtime, so this is how the knob reaches that path (the dedicated
/// path wraps inside `SplitRuntime::wrap_udp_socket`).
pub(crate) struct BatchedRuntime<R> {
    inner: R,
}

impl<R> BatchedRuntime<R> {
    pub(crate) fn new(inner: R) -> Self {
        Self { inner }
    }
}

impl<R: std::fmt::Debug> std::fmt::Debug for BatchedRuntime<R> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BatchedRuntime")
            .field("inner", &self.inner)
            .finish()
    }
}

impl<R: wtransport::quinn::Runtime> wtransport::quinn::Runtime for BatchedRuntime<R> {
    fn new_timer(
        &self,
        instant: std::time::Instant,
    ) -> std::pin::Pin<Box<dyn wtransport::quinn::AsyncTimer>> {
        self.inner.new_timer(instant)
    }

    fn spawn(&self, future: std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>) {
        self.inner.spawn(future)
    }

    fn wrap_udp_socket(&self, sock: std::net::UdpSocket) -> io::Result<Arc<dyn AsyncUdpSocket>> {
        let flusher_socket = match configured_batch() {
            Some(_) => Some(sock.try_clone()?),
            None => None,
        };
        let inner = self.inner.wrap_udp_socket(sock)?;
        Ok(match flusher_socket {
            Some(raw) => wrap(inner, raw),
            None => inner,
        })
    }

    fn now(&self) -> std::time::Instant {
        self.inner.now()
    }
}

pub(crate) struct BatchedUdpSocket {
    inner: Arc<dyn AsyncUdpSocket>,
    tx: SyncSender<OwnedTransmit>,
}

impl std::fmt::Debug for BatchedUdpSocket {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BatchedUdpSocket").finish()
    }
}

impl BatchedUdpSocket {
    pub(crate) fn spawn(
        inner: Arc<dyn AsyncUdpSocket>,
        flusher_socket: std::net::UdpSocket,
        batch: usize,
    ) -> Self {
        let (tx, rx) = sync_channel::<OwnedTransmit>(RING_CAPACITY);
        let flusher_inner = Arc::clone(&inner);
        std::thread::Builder::new()
            .name("wt-udp-send-batch".to_string())
            .spawn(move || flusher_loop(rx, flusher_inner, flusher_socket, batch))
            .expect("spawn wt-udp-send-batch thread");
        Self { inner, tx }
    }
}

impl AsyncUdpSocket for BatchedUdpSocket {
    fn create_io_poller(self: Arc<Self>) -> std::pin::Pin<Box<dyn UdpPoller>> {
        Arc::clone(&self.inner).create_io_poller()
    }

    fn try_send(&self, transmit: &Transmit) -> io::Result<()> {
        match self.tx.try_send(OwnedTransmit::from_transmit(transmit)) {
            Ok(()) => {}
            // A full ring is a full socket buffer: the datagram is gone and
            // loss recovery will notice. Never an error: the driver would
            // treat one as fatal for the connection.
            Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_)) => {
                DROPPED.fetch_add(1, Ordering::Relaxed);
            }
        }
        Ok(())
    }

    fn poll_recv(
        &self,
        cx: &mut std::task::Context,
        bufs: &mut [io::IoSliceMut<'_>],
        meta: &mut [RecvMeta],
    ) -> std::task::Poll<io::Result<usize>> {
        self.inner.poll_recv(cx, bufs, meta)
    }

    fn local_addr(&self) -> io::Result<SocketAddr> {
        self.inner.local_addr()
    }

    fn max_transmit_segments(&self) -> usize {
        self.inner.max_transmit_segments()
    }

    fn max_receive_segments(&self) -> usize {
        self.inner.max_receive_segments()
    }

    fn may_fragment(&self) -> bool {
        self.inner.may_fragment()
    }
}

/// Drain the ring: block for the first transmit, then take whatever is
/// already queued up to `batch`, and flush the lot.
fn flusher_loop(
    rx: Receiver<OwnedTransmit>,
    inner: Arc<dyn AsyncUdpSocket>,
    socket: std::net::UdpSocket,
    batch: usize,
) {
    let mut pending: Vec<OwnedTransmit> = Vec::with_capacity(batch);
    for first in rx.iter() {
        pending.clear();
        pending.push(first);
        while pending.len() < batch {
            match rx.try_recv() {
                Ok(next) => pending.push(next),
                Err(_) => break,
            }
        }
        MAX_BATCH_SEEN.fetch_max(pending.len() as u64, Ordering::Relaxed);
        flush(&socket, &inner, &pending);
    }
}

/// Send one datagram outside the batched path. A single-datagram transmit
/// goes straight through the flusher's own socket handle (no reactor, no
/// readiness bookkeeping: this thread may block briefly, which is its job);
/// a GSO transmit goes through quinn's wrapper, which owns the segmentation
/// and its halt-on-EINVAL logic. Counted as a fallback either way.
fn send_one_fallback(
    socket: &std::net::UdpSocket,
    inner: &Arc<dyn AsyncUdpSocket>,
    transmit: &OwnedTransmit,
) {
    FALLBACK.fetch_add(1, Ordering::Relaxed);
    let result = match transmit
        .segment_size
        .filter(|segment| *segment < transmit.contents.len())
    {
        None => socket
            .send_to(&transmit.contents, transmit.destination)
            .map(|_| ()),
        Some(_) => inner.try_send(&transmit.as_transmit()),
    };
    if let Err(error) = result {
        if error.kind() == io::ErrorKind::WouldBlock {
            DROPPED.fetch_add(1, Ordering::Relaxed);
        } else {
            ERRORS.fetch_add(1, Ordering::Relaxed);
        }
    }
}

#[cfg(not(target_os = "linux"))]
fn flush(socket: &std::net::UdpSocket, inner: &Arc<dyn AsyncUdpSocket>, pending: &[OwnedTransmit]) {
    for transmit in pending {
        send_one_fallback(socket, inner, transmit);
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use super::*;
    use std::os::fd::AsRawFd;

    /// Room for IP_TOS/IPV6_TCLASS (int), UDP_SEGMENT (u16) and
    /// IP_PKTINFO/IPV6_PKTINFO, each CMSG_SPACE-padded; 128 bytes covers all
    /// three with margin (quinn-udp sizes its own buffer at 88).
    const CTRL_LEN: usize = 128;

    #[repr(C, align(8))]
    struct Ctrl([u8; CTRL_LEN]);

    /// Encode the control messages quinn-udp would encode for `transmit`:
    /// ECN as IP_TOS / IPV6_TCLASS and, for a GSO transmit, UDP_SEGMENT.
    /// Returns the number of control bytes used.
    fn encode_ctrl(transmit: &OwnedTransmit, ctrl: &mut Ctrl, hdr: &mut libc::msghdr) -> usize {
        hdr.msg_control = ctrl.0.as_mut_ptr() as *mut libc::c_void;
        hdr.msg_controllen = CTRL_LEN as _;
        let mut used = 0usize;
        let mut cmsg = unsafe { libc::CMSG_FIRSTHDR(hdr) };
        let ecn = transmit.ecn.map_or(0, |x| x as libc::c_int);
        // ECN is always encoded, as quinn-udp does, so a batched and an
        // unbatched packet carry the same TOS bits.
        unsafe {
            if transmit.destination.is_ipv4() {
                (*cmsg).cmsg_level = libc::IPPROTO_IP;
                (*cmsg).cmsg_type = libc::IP_TOS;
                (*cmsg).cmsg_len = libc::CMSG_LEN(std::mem::size_of::<libc::c_int>() as u32) as _;
                std::ptr::write_unaligned(libc::CMSG_DATA(cmsg) as *mut libc::c_int, ecn);
            } else {
                (*cmsg).cmsg_level = libc::IPPROTO_IPV6;
                (*cmsg).cmsg_type = libc::IPV6_TCLASS;
                (*cmsg).cmsg_len = libc::CMSG_LEN(std::mem::size_of::<libc::c_int>() as u32) as _;
                std::ptr::write_unaligned(libc::CMSG_DATA(cmsg) as *mut libc::c_int, ecn);
            }
            used += libc::CMSG_SPACE(std::mem::size_of::<libc::c_int>() as u32) as usize;
            if let Some(segment) = transmit
                .segment_size
                .filter(|segment| *segment < transmit.contents.len())
            {
                cmsg = libc::CMSG_NXTHDR(hdr, cmsg);
                (*cmsg).cmsg_level = libc::SOL_UDP;
                (*cmsg).cmsg_type = libc::UDP_SEGMENT;
                (*cmsg).cmsg_len = libc::CMSG_LEN(std::mem::size_of::<u16>() as u32) as _;
                std::ptr::write_unaligned(libc::CMSG_DATA(cmsg) as *mut u16, segment as u16);
                used += libc::CMSG_SPACE(std::mem::size_of::<u16>() as u32) as usize;
            }
            // A wildcard-bound endpoint stamps every transmit with the
            // address the peer reached it on; quinn-udp sends that as
            // pktinfo so the reply leaves from the same address.
            match transmit.src_ip {
                Some(IpAddr::V4(v4)) => {
                    cmsg = libc::CMSG_NXTHDR(hdr, cmsg);
                    (*cmsg).cmsg_level = libc::IPPROTO_IP;
                    (*cmsg).cmsg_type = libc::IP_PKTINFO;
                    (*cmsg).cmsg_len =
                        libc::CMSG_LEN(std::mem::size_of::<libc::in_pktinfo>() as u32) as _;
                    let info = libc::in_pktinfo {
                        ipi_ifindex: 0,
                        ipi_spec_dst: libc::in_addr {
                            s_addr: u32::from_ne_bytes(v4.octets()),
                        },
                        ipi_addr: libc::in_addr { s_addr: 0 },
                    };
                    std::ptr::write_unaligned(libc::CMSG_DATA(cmsg) as *mut libc::in_pktinfo, info);
                    used +=
                        libc::CMSG_SPACE(std::mem::size_of::<libc::in_pktinfo>() as u32) as usize;
                }
                Some(IpAddr::V6(v6)) => {
                    cmsg = libc::CMSG_NXTHDR(hdr, cmsg);
                    (*cmsg).cmsg_level = libc::IPPROTO_IPV6;
                    (*cmsg).cmsg_type = libc::IPV6_PKTINFO;
                    (*cmsg).cmsg_len =
                        libc::CMSG_LEN(std::mem::size_of::<libc::in6_pktinfo>() as u32) as _;
                    let info = libc::in6_pktinfo {
                        ipi6_addr: libc::in6_addr {
                            s6_addr: v6.octets(),
                        },
                        ipi6_ifindex: 0,
                    };
                    std::ptr::write_unaligned(
                        libc::CMSG_DATA(cmsg) as *mut libc::in6_pktinfo,
                        info,
                    );
                    used +=
                        libc::CMSG_SPACE(std::mem::size_of::<libc::in6_pktinfo>() as u32) as usize;
                }
                None => {}
            }
        }
        hdr.msg_controllen = used as _;
        used
    }

    pub(super) fn flush(
        socket: &std::net::UdpSocket,
        inner: &Arc<dyn AsyncUdpSocket>,
        pending: &[OwnedTransmit],
    ) {
        let batched: Vec<&OwnedTransmit> = pending.iter().collect();
        if batched.is_empty() {
            return;
        }
        let names: Vec<socket2::SockAddr> = batched
            .iter()
            .map(|t| socket2::SockAddr::from(t.destination))
            .collect();
        let mut iovecs: Vec<libc::iovec> = batched
            .iter()
            .map(|t| libc::iovec {
                iov_base: t.contents.as_ptr() as *mut libc::c_void,
                iov_len: t.contents.len(),
            })
            .collect();
        let mut ctrls: Vec<Ctrl> = (0..batched.len()).map(|_| Ctrl([0u8; CTRL_LEN])).collect();
        let mut msgs: Vec<libc::mmsghdr> = Vec::with_capacity(batched.len());
        for (i, transmit) in batched.iter().enumerate() {
            let mut hdr: libc::msghdr = unsafe { std::mem::zeroed() };
            hdr.msg_name = names[i].as_ptr() as *mut libc::c_void;
            hdr.msg_namelen = names[i].len();
            hdr.msg_iov = &mut iovecs[i];
            hdr.msg_iovlen = 1;
            encode_ctrl(transmit, &mut ctrls[i], &mut hdr);
            msgs.push(libc::mmsghdr {
                msg_hdr: hdr,
                msg_len: 0,
            });
        }
        let fd = socket.as_raw_fd();
        let mut offset = 0usize;
        while offset < msgs.len() {
            let remaining = msgs.len() - offset;
            let sent = unsafe {
                libc::sendmmsg(
                    fd,
                    msgs.as_mut_ptr().add(offset),
                    remaining as libc::c_uint,
                    0,
                )
            };
            if sent >= 0 {
                let sent = sent as usize;
                CALLS.fetch_add(1, Ordering::Relaxed);
                MESSAGES.fetch_add(sent as u64, Ordering::Relaxed);
                offset += sent;
                continue;
            }
            let error = io::Error::last_os_error();
            match error.raw_os_error() {
                Some(libc::EINTR) => continue,
                Some(libc::EAGAIN) => {
                    // Socket buffer full: wait for writability rather than
                    // dropping; the ring keeps producers bounded meanwhile.
                    let mut pfd = libc::pollfd {
                        fd,
                        events: libc::POLLOUT,
                        revents: 0,
                    };
                    unsafe { libc::poll(&mut pfd, 1, 100) };
                    continue;
                }
                // EINVAL/EIO on a GSO transmit is how the kernel refuses
                // segmentation; quinn-udp owns the halt-GSO logic, so the
                // rest of the batch goes through it one at a time.
                Some(libc::EINVAL) | Some(libc::EIO) => {
                    for transmit in &batched[offset..] {
                        send_one_fallback(socket, inner, transmit);
                    }
                    return;
                }
                _ => {
                    ERRORS.fetch_add(remaining as u64, Ordering::Relaxed);
                    return;
                }
            }
        }
    }
}

#[cfg(target_os = "linux")]
use linux::flush;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_off_and_the_bounded_range() {
        assert_eq!(parse_batch(None), Ok(None));
        assert_eq!(parse_batch(Some("")), Ok(None));
        assert_eq!(parse_batch(Some("0")), Ok(None));
        assert_eq!(parse_batch(Some("2")), Ok(Some(2)));
        assert_eq!(parse_batch(Some(" 64 ")), Ok(Some(64)));
        assert_eq!(parse_batch(Some("1024")), Ok(Some(1024)));
        assert!(parse_batch(Some("1")).is_err());
        assert!(parse_batch(Some("1025")).is_err());
        assert!(parse_batch(Some("many")).is_err());
    }

    /// Everything the ring accepts reaches the wire, in order per source,
    /// batched or not: bind a receiver, push N datagrams through a wrapped
    /// sender, and read them all back.
    #[test]
    fn batched_sends_arrive_in_order() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        let _guard = runtime.enter();
        let receiver = std::net::UdpSocket::bind("127.0.0.1:0").expect("bind receiver");
        receiver
            .set_read_timeout(Some(std::time::Duration::from_secs(5)))
            .expect("read timeout");
        let destination = receiver.local_addr().expect("receiver addr");
        let sender = std::net::UdpSocket::bind("127.0.0.1:0").expect("bind sender");
        sender.set_nonblocking(true).expect("nonblocking");
        let flusher_socket = sender.try_clone().expect("clone");
        let inner =
            wtransport::quinn::Runtime::wrap_udp_socket(&wtransport::quinn::TokioRuntime, sender)
                .expect("wrap");
        let socket = BatchedUdpSocket::spawn(inner, flusher_socket, 16);
        let count = 200usize;
        for i in 0..count {
            let payload = format!("datagram-{i:04}");
            socket
                .try_send(&Transmit {
                    destination,
                    ecn: None,
                    contents: payload.as_bytes(),
                    segment_size: None,
                    src_ip: None,
                })
                .expect("try_send never errors");
        }
        let mut buf = [0u8; 64];
        for i in 0..count {
            let n = receiver.recv(&mut buf).expect("datagram arrives");
            assert_eq!(&buf[..n], format!("datagram-{i:04}").as_bytes());
        }
        let after = stats();
        assert_eq!(after.dropped, 0);
        assert_eq!(after.errors, 0);
        if cfg!(target_os = "linux") {
            assert!(
                after.messages >= count as u64,
                "sendmmsg carried the datagrams"
            );
            assert!(after.max_batch >= 2, "at least one real batch formed");
        } else {
            assert!(
                after.fallback >= count as u64,
                "non-Linux sends one at a time"
            );
        }
    }
}
