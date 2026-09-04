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
//! as "poll writable and retry". The ring holds one batch; when it is full
//! this wrapper returns `WouldBlock` and the driver parks on the socket's
//! poller until the flusher has drained. That is deliberate backpressure: a
//! parked driver builds its next transmit from everything that queued
//! meanwhile, so packets leave fuller. The first cut of this module returned
//! `Ok` unconditionally and dropped on a full ring; at 2875 sessions on the
//! home rig that sent 12% more packets for the same frames and cost 4.6%
//! more CPU, because a driver whose sends never block packs nothing.
//! Ordering per connection is preserved by the single flusher.
//! `WEBTRANSPORT_NATIVE_UDP_SEND_EAGAIN_MODE=drop` is a campaign-only escape
//! hatch: if Linux `sendmmsg` reports `EAGAIN`, the flusher drops only the
//! unsent suffix and wakes parked drivers instead of waiting on that socket.
//! Unset, empty, or `wait` preserves the production behavior above.
//!
//! `WEBTRANSPORT_NATIVE_UDP_SEND_BATCH` selects the batch size (2..=1024);
//! unset or 0 leaves the socket untouched, byte-for-byte today's behaviour.
//! `WEBTRANSPORT_NATIVE_UDP_SEND_BATCH_WAIT_US` (0..=5000, default 0) is how
//! long the flusher waits for a batch to fill before sending what it has. The
//! backpressure is what buys the packing, not the wait: at 2875 sessions the
//! 250 us wait and no wait both cut ack p99 from 26.6 to 8.5 ms, and no wait
//! did it with less CPU and a cleaner ingest, so the default is 0.
//! Linux only for the batched path; elsewhere the flusher sends one at a time
//! through the inner socket and counts every datagram as a fallback.

use std::io;
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Mutex, OnceLock};
use std::task::{Context, Poll, Waker};
use std::time::{Duration, Instant};

use crate::send_path_diagnostics::{Component, GaugeKind, Interval, IntervalKind, Reservation};
use wtransport::quinn::udp::{EcnCodepoint, RecvMeta, Transmit};
use wtransport::quinn::{AsyncUdpSocket, UdpPoller};

const MIN_BATCH: usize = 2;
const MAX_BATCH: usize = 1024;
const DEFAULT_WAIT_US: u64 = 0;
const MAX_WAIT_US: u64 = 5000;
// Linux EIO. libc exposes the value on every supported target, but this
// helper is also compiled by non-Linux unit tests where libc is not imported.
#[cfg(any(target_os = "linux", test))]
const EIO_RAW_OS_ERROR: i32 = 5;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SendEagainMode {
    Wait,
    Drop,
}

impl SendEagainMode {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Wait => "wait",
            Self::Drop => "drop",
        }
    }
}

pub(crate) fn parse_eagain_mode(raw: Option<&str>) -> Result<SendEagainMode, String> {
    match raw.map(str::trim) {
        None | Some("") | Some("wait") => Ok(SendEagainMode::Wait),
        Some("drop") => Ok(SendEagainMode::Drop),
        Some(text) => Err(format!(
            "WEBTRANSPORT_NATIVE_UDP_SEND_EAGAIN_MODE must be wait or drop, got '{text}'"
        )),
    }
}

pub(crate) fn configured_eagain_mode() -> SendEagainMode {
    static RESOLVED: OnceLock<SendEagainMode> = OnceLock::new();
    *RESOLVED.get_or_init(|| {
        match parse_eagain_mode(
            std::env::var("WEBTRANSPORT_NATIVE_UDP_SEND_EAGAIN_MODE")
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

#[cfg(any(target_os = "linux", test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SendBatchOutcome {
    Complete { sent: usize },
    CongestionDropped { sent: usize, dropped: usize },
    Fallback { sent: usize, offset: usize },
    Error { sent: usize, remaining: usize },
}

#[cfg(any(target_os = "linux", test))]
fn drive_send_batch<S, W>(
    total: usize,
    mode: SendEagainMode,
    mut send: S,
    mut wait_writable: W,
) -> SendBatchOutcome
where
    S: FnMut(usize, usize) -> io::Result<usize>,
    W: FnMut(),
{
    let mut offset = 0usize;
    while offset < total {
        match send(offset, total - offset) {
            Ok(0) => {
                return SendBatchOutcome::Error {
                    sent: offset,
                    remaining: total - offset,
                };
            }
            Ok(sent) => offset += sent.min(total - offset),
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => match mode {
                SendEagainMode::Wait => wait_writable(),
                SendEagainMode::Drop => {
                    return SendBatchOutcome::CongestionDropped {
                        sent: offset,
                        dropped: total - offset,
                    };
                }
            },
            Err(error)
                if error.kind() == io::ErrorKind::InvalidInput
                    || error.raw_os_error() == Some(EIO_RAW_OS_ERROR) =>
            {
                return SendBatchOutcome::Fallback {
                    sent: offset,
                    offset,
                };
            }
            Err(_) => {
                return SendBatchOutcome::Error {
                    sent: offset,
                    remaining: total - offset,
                };
            }
        }
    }
    SendBatchOutcome::Complete { sent: offset }
}

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

/// Parse `WEBTRANSPORT_NATIVE_UDP_SEND_BATCH_WAIT_US`: unset or empty is the
/// default; `0..=5000` microseconds otherwise.
pub(crate) fn parse_wait(raw: Option<&str>) -> Result<Duration, String> {
    match raw.map(str::trim) {
        None | Some("") => Ok(Duration::from_micros(DEFAULT_WAIT_US)),
        Some(text) => match text.parse::<u64>() {
            Ok(n) if n <= MAX_WAIT_US => Ok(Duration::from_micros(n)),
            _ => Err(format!(
                "WEBTRANSPORT_NATIVE_UDP_SEND_BATCH_WAIT_US must be 0..={MAX_WAIT_US}, got '{text}'"
            )),
        },
    }
}

fn configured_wait() -> Duration {
    static RESOLVED: OnceLock<Duration> = OnceLock::new();
    *RESOLVED.get_or_init(|| {
        match parse_wait(
            std::env::var("WEBTRANSPORT_NATIVE_UDP_SEND_BATCH_WAIT_US")
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
    pub blocked: u64,
    pub dropped: u64,
    pub congestion_dropped: u64,
    pub errors: u64,
    pub max_batch: u64,
}

static CALLS: AtomicU64 = AtomicU64::new(0);
static MESSAGES: AtomicU64 = AtomicU64::new(0);
static FALLBACK: AtomicU64 = AtomicU64::new(0);
static BLOCKED: AtomicU64 = AtomicU64::new(0);
static DROPPED: AtomicU64 = AtomicU64::new(0);
static CONGESTION_DROPPED: AtomicU64 = AtomicU64::new(0);
static ERRORS: AtomicU64 = AtomicU64::new(0);
static MAX_BATCH_SEEN: AtomicU64 = AtomicU64::new(0);

pub(crate) fn stats() -> Stats {
    Stats {
        calls: CALLS.load(Ordering::Relaxed),
        messages: MESSAGES.load(Ordering::Relaxed),
        fallback: FALLBACK.load(Ordering::Relaxed),
        blocked: BLOCKED.load(Ordering::Relaxed),
        dropped: DROPPED.load(Ordering::Relaxed),
        congestion_dropped: CONGESTION_DROPPED.load(Ordering::Relaxed),
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

/// Diagnostic ownership travels with the existing bounded channel allocation.
/// Reservations include the enqueue attempt and the flusher's retained storage;
/// they are not an estimate of bytes currently queued in the kernel.
struct QueuedTransmit {
    transmit: OwnedTransmit,
    queue_wait: Option<Interval>,
    _packets: Option<Reservation>,
    _bytes: Option<Reservation>,
}

impl QueuedTransmit {
    fn new(transmit: &Transmit<'_>, diagnostics: Option<&Arc<Component>>) -> Self {
        let transmit = OwnedTransmit::from_transmit(transmit);
        Self {
            queue_wait: diagnostics.and_then(|diag| diag.start(IntervalKind::UdpQueueWait)),
            _packets: diagnostics.and_then(|diag| diag.reserve(GaugeKind::UdpPendingPackets, 1)),
            _bytes: diagnostics
                .filter(|_| !transmit.contents.is_empty())
                .and_then(|diag| {
                    diag.reserve(GaugeKind::UdpPendingBytes, transmit.contents.len() as i64)
                }),
            transmit,
        }
    }
    fn dequeued(&mut self) {
        if let Some(wait) = self.queue_wait.take() {
            wait.finish();
        }
    }
    fn rejected(mut self) {
        if let Some(wait) = self.queue_wait.take() {
            wait.reject();
        }
    }
}
impl std::ops::Deref for QueuedTransmit {
    type Target = OwnedTransmit;
    fn deref(&self) -> &Self::Target {
        &self.transmit
    }
}

/// Wrap `inner` so its transmits go through a flusher thread owning
/// `flusher_socket`, a second handle to the same UDP socket.
pub(crate) fn wrap(
    inner: Arc<dyn AsyncUdpSocket>,
    flusher_socket: std::net::UdpSocket,
) -> Arc<dyn AsyncUdpSocket> {
    let batch = configured_batch().unwrap_or(MIN_BATCH);
    Arc::new(BatchedUdpSocket::spawn(
        inner,
        flusher_socket,
        batch,
        configured_wait(),
    ))
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

/// Ring fullness shared between producers, their pollers and the flusher.
/// One word: bit 0 is "full", the rest is a drain generation. A producer
/// that hit a full ring may only mark it full for the generation it saw
/// before the push; if the flusher drained in between, the ring is empty
/// and marking it full would park every driver with nobody left to clear.
#[derive(Default)]
struct Backpressure {
    state: AtomicU64,
    wakers: Mutex<Vec<Waker>>,
    diagnostics: Option<Arc<Component>>,
    blocked_interval: Mutex<Option<Interval>>,
}

impl Backpressure {
    fn generation(&self) -> u64 {
        self.state.load(Ordering::Acquire) >> 1
    }

    fn is_full(&self) -> bool {
        self.state.load(Ordering::Acquire) & 1 == 1
    }

    /// Mark the ring full unless a drain has happened since `seen`.
    fn block(&self, seen: u64) {
        // Only the armed diagnostic path serializes episode recording with
        // drain. No per-packet registry/global histogram lock is introduced.
        let mut episode = self.diagnostics.as_ref().map(|_| {
            self.blocked_interval
                .lock()
                .expect("blocked diagnostic interval")
        });
        let interval = self
            .diagnostics
            .as_ref()
            .and_then(|diag| diag.start(IntervalKind::RingFull));
        let marked = self
            .state
            .compare_exchange(
                seen << 1,
                (seen << 1) | 1,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .is_ok();
        if marked {
            if let Some(episode) = episode.as_mut() {
                **episode = interval;
            }
        } else if let Some(interval) = interval {
            interval.reject();
        }
    }

    fn drained(&self) {
        let mut episode = self.diagnostics.as_ref().map(|_| {
            self.blocked_interval
                .lock()
                .expect("blocked diagnostic interval")
        });
        let generation = self.generation() + 1;
        self.state.store(generation << 1, Ordering::Release);
        if let Some(episode) = episode.as_mut() {
            if let Some(interval) = episode.take() {
                interval.finish();
            }
        }
        drop(episode);
        let wakers = {
            let mut registered = self.wakers.lock().expect("wakers");
            if let Some(diag) = &self.diagnostics {
                diag.change_gauge(GaugeKind::WaiterRegistrations, -(registered.len() as i64));
            }
            std::mem::take(&mut *registered)
        };
        for waker in wakers {
            waker.wake();
        }
    }

    fn poll_writable(&self, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        if !self.is_full() {
            return Poll::Ready(Ok(()));
        }
        {
            let mut registered = self.wakers.lock().expect("wakers");
            registered.push(cx.waker().clone());
            if let Some(diag) = &self.diagnostics {
                diag.change_gauge(GaugeKind::WaiterRegistrations, 1);
            }
        }
        // Re-check under the registration so a drain between the first
        // check and the push cannot strand this driver.
        if self.is_full() {
            Poll::Pending
        } else {
            Poll::Ready(Ok(()))
        }
    }
}

/// Replaces the inner socket's poller: the kernel socket is nearly always
/// writable, so polling it would spin a driver that the ring just refused.
struct RingPoller {
    backpressure: Arc<Backpressure>,
}

impl std::fmt::Debug for RingPoller {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RingPoller").finish()
    }
}

impl UdpPoller for RingPoller {
    fn poll_writable(self: std::pin::Pin<&mut Self>, cx: &mut Context) -> Poll<io::Result<()>> {
        self.backpressure.poll_writable(cx)
    }
}

pub(crate) struct BatchedUdpSocket {
    inner: Arc<dyn AsyncUdpSocket>,
    direct_socket: std::net::UdpSocket,
    tx: SyncSender<QueuedTransmit>,
    backpressure: Arc<Backpressure>,
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
        wait: Duration,
    ) -> Self {
        let direct_socket = flusher_socket
            .try_clone()
            .expect("clone UDP socket for reflector ring bypass");
        let (tx, rx) = sync_channel::<QueuedTransmit>(batch);
        let backpressure = Arc::new(Backpressure {
            diagnostics: crate::send_path_diagnostics::register("udp-socket"),
            ..Backpressure::default()
        });
        let flusher_inner = Arc::clone(&inner);
        let flusher_backpressure = Arc::clone(&backpressure);
        std::thread::Builder::new()
            .name("wt-udp-send-batch".to_string())
            .spawn(move || {
                flusher_loop(
                    rx,
                    flusher_inner,
                    flusher_socket,
                    batch,
                    wait,
                    flusher_backpressure,
                )
            })
            .expect("spawn wt-udp-send-batch thread");
        Self {
            inner,
            direct_socket,
            tx,
            backpressure,
        }
    }
}

impl AsyncUdpSocket for BatchedUdpSocket {
    fn create_io_poller(self: Arc<Self>) -> std::pin::Pin<Box<dyn UdpPoller>> {
        Box::pin(RingPoller {
            backpressure: Arc::clone(&self.backpressure),
        })
    }

    fn try_send(&self, transmit: &Transmit) -> io::Result<()> {
        let peer = transmit.destination;
        let seen = self.backpressure.generation();
        dispatch_priority_or_ring(
            crate::datagram_reflector::take_ring_bypass(peer),
            || try_send_priority(&self.direct_socket, transmit),
            || match self.tx.try_send(QueuedTransmit::new(
                transmit,
                self.backpressure.diagnostics.as_ref(),
            )) {
                Ok(()) => RingEnqueue::Accepted,
                Err(TrySendError::Full(queued)) => {
                    queued.rejected();
                    RingEnqueue::Full
                }
                Err(TrySendError::Disconnected(queued)) => {
                    queued.rejected();
                    RingEnqueue::Disconnected
                }
            },
            || crate::datagram_reflector::restore_ring_bypass(peer),
            || {
                let _ = crate::datagram_reflector::take_ring_bypass(peer);
            },
            || {
                BLOCKED.fetch_add(1, Ordering::Relaxed);
                self.backpressure.block(seen);
            },
        )
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

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
enum PrioritySend {
    Sent,
    WouldBlock,
    GsoFallback,
    Error(io::Error),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RingEnqueue {
    Accepted,
    Full,
    Disconnected,
}

fn dispatch_priority_or_ring<D, Q, R, C, B>(
    has_priority: bool,
    direct: D,
    enqueue: Q,
    restore: R,
    clear: C,
    block: B,
) -> io::Result<()>
where
    D: FnOnce() -> PrioritySend,
    Q: FnOnce() -> RingEnqueue,
    R: FnOnce(),
    C: FnOnce(),
    B: FnOnce(),
{
    let mut restored = false;
    if has_priority {
        match direct() {
            PrioritySend::Sent => {
                crate::datagram_reflector::record_ring_bypassed();
                return Ok(());
            }
            PrioritySend::WouldBlock => {
                crate::datagram_reflector::record_ring_direct_blocked();
                restore();
                restored = true;
            }
            PrioritySend::GsoFallback => {
                crate::datagram_reflector::record_ring_gso_fallback();
                restore();
                restored = true;
            }
            PrioritySend::Error(error) => {
                crate::datagram_reflector::record_ring_direct_error();
                return Err(error);
            }
        }
    }
    match enqueue() {
        RingEnqueue::Accepted => {
            if restored {
                clear();
            }
            Ok(())
        }
        RingEnqueue::Full => {
            block();
            Err(io::ErrorKind::WouldBlock.into())
        }
        RingEnqueue::Disconnected => {
            if restored {
                clear();
            }
            DROPPED.fetch_add(1, Ordering::Relaxed);
            Ok(())
        }
    }
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn classify_priority_send<F>(
    segment_size: Option<usize>,
    contents_len: usize,
    send: F,
) -> PrioritySend
where
    F: FnOnce() -> io::Result<usize>,
{
    if segment_size.is_some_and(|segment| segment < contents_len) {
        return PrioritySend::GsoFallback;
    }
    match send() {
        Ok(sent) if sent == contents_len => PrioritySend::Sent,
        Ok(_) => PrioritySend::Error(io::Error::new(
            io::ErrorKind::WriteZero,
            "reflector ring bypass sent a partial UDP datagram",
        )),
        Err(error) if error.kind() == io::ErrorKind::WouldBlock => PrioritySend::WouldBlock,
        Err(error) => PrioritySend::Error(error),
    }
}

#[cfg(not(target_os = "linux"))]
fn try_send_priority(_socket: &std::net::UdpSocket, _transmit: &Transmit<'_>) -> PrioritySend {
    PrioritySend::GsoFallback
}

/// Drain the ring: block for the first transmit, gather more for at most
/// `wait` or until the batch is full, flush the lot, then release any driver
/// the full ring parked.
fn flusher_loop(
    rx: Receiver<QueuedTransmit>,
    inner: Arc<dyn AsyncUdpSocket>,
    socket: std::net::UdpSocket,
    batch: usize,
    wait: Duration,
    backpressure: Arc<Backpressure>,
) {
    let mut pending: Vec<QueuedTransmit> = Vec::with_capacity(batch);
    for mut first in rx.iter() {
        pending.clear();
        first.dequeued();
        pending.push(first);
        let deadline = Instant::now() + wait;
        while pending.len() < batch {
            let remaining = deadline.saturating_duration_since(Instant::now());
            let next = if remaining.is_zero() {
                rx.try_recv().ok()
            } else {
                rx.recv_timeout(remaining).ok()
            };
            match next {
                Some(mut next) => {
                    next.dequeued();
                    pending.push(next);
                }
                None => break,
            }
        }
        MAX_BATCH_SEEN.fetch_max(pending.len() as u64, Ordering::Relaxed);
        flush(&socket, &inner, &pending, backpressure.diagnostics.as_ref());
        backpressure.drained();
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
fn flush(
    socket: &std::net::UdpSocket,
    inner: &Arc<dyn AsyncUdpSocket>,
    pending: &[QueuedTransmit],
    _diagnostics: Option<&Arc<Component>>,
) {
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

    pub(super) fn try_send_priority(
        socket: &std::net::UdpSocket,
        transmit: &Transmit<'_>,
    ) -> PrioritySend {
        let owned = OwnedTransmit::from_transmit(transmit);
        let name = socket2::SockAddr::from(owned.destination);
        let mut iovec = libc::iovec {
            iov_base: owned.contents.as_ptr() as *mut libc::c_void,
            iov_len: owned.contents.len(),
        };
        let mut ctrl = Ctrl([0u8; CTRL_LEN]);
        let mut hdr: libc::msghdr = unsafe { std::mem::zeroed() };
        hdr.msg_name = name.as_ptr() as *mut libc::c_void;
        hdr.msg_namelen = name.len();
        hdr.msg_iov = &mut iovec;
        hdr.msg_iovlen = 1;
        encode_ctrl(&owned, &mut ctrl, &mut hdr);
        classify_priority_send(owned.segment_size, owned.contents.len(), || {
            let sent = unsafe { libc::sendmsg(socket.as_raw_fd(), &hdr, 0) };
            if sent < 0 {
                Err(io::Error::last_os_error())
            } else {
                Ok(sent as usize)
            }
        })
    }

    pub(super) fn flush(
        socket: &std::net::UdpSocket,
        inner: &Arc<dyn AsyncUdpSocket>,
        pending: &[QueuedTransmit],
        diagnostics: Option<&Arc<Component>>,
    ) {
        let batched: Vec<&OwnedTransmit> = pending.iter().map(|queued| &queued.transmit).collect();
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
        let eagain_interval = std::cell::RefCell::new(None::<Interval>);
        let outcome = drive_send_batch(
            msgs.len(),
            configured_eagain_mode(),
            |offset, remaining| {
                let sent = unsafe {
                    libc::sendmmsg(
                        fd,
                        msgs.as_mut_ptr().add(offset),
                        remaining as libc::c_uint,
                        0,
                    )
                };
                if sent < 0 {
                    let error = io::Error::last_os_error();
                    if error.kind() == io::ErrorKind::WouldBlock {
                        let mut interval = eagain_interval.borrow_mut();
                        if interval.is_none() {
                            *interval = diagnostics
                                .and_then(|diag| diag.start(IntervalKind::FlusherEagain));
                        }
                    }
                    Err(error)
                } else {
                    let sent = sent as usize;
                    if sent > 0 {
                        if let Some(interval) = eagain_interval.borrow_mut().take() {
                            interval.finish();
                        }
                    }
                    CALLS.fetch_add(1, Ordering::Relaxed);
                    MESSAGES.fetch_add(sent as u64, Ordering::Relaxed);
                    Ok(sent)
                }
            },
            || {
                let mut pfd = libc::pollfd {
                    fd,
                    events: libc::POLLOUT,
                    revents: 0,
                };
                unsafe { libc::poll(&mut pfd, 1, 100) };
            },
        );
        match outcome {
            SendBatchOutcome::Complete { .. } => {}
            SendBatchOutcome::CongestionDropped { dropped, .. } => {
                CONGESTION_DROPPED.fetch_add(dropped as u64, Ordering::Relaxed);
            }
            // EINVAL/EIO on a GSO transmit is how the kernel refuses
            // segmentation; quinn-udp owns the halt-GSO logic, so the
            // unsent suffix goes through it one at a time.
            SendBatchOutcome::Fallback { offset, .. } => {
                for transmit in &batched[offset..] {
                    send_one_fallback(socket, inner, transmit);
                }
            }
            SendBatchOutcome::Error { remaining, .. } => {
                ERRORS.fetch_add(remaining as u64, Ordering::Relaxed);
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn control_kinds(transmit: OwnedTransmit) -> Vec<(libc::c_int, libc::c_int)> {
            let mut ctrl = Ctrl([0u8; CTRL_LEN]);
            let mut hdr: libc::msghdr = unsafe { std::mem::zeroed() };
            encode_ctrl(&transmit, &mut ctrl, &mut hdr);
            let mut kinds = Vec::new();
            let mut cmsg = unsafe { libc::CMSG_FIRSTHDR(&hdr) };
            while !cmsg.is_null() {
                kinds.push(unsafe { ((*cmsg).cmsg_level, (*cmsg).cmsg_type) });
                cmsg = unsafe { libc::CMSG_NXTHDR(&hdr, cmsg) };
            }
            kinds
        }

        #[test]
        fn direct_control_messages_preserve_ipv4_ecn_and_source_pktinfo() {
            let kinds = control_kinds(OwnedTransmit {
                destination: "127.0.0.1:4433".parse().unwrap(),
                ecn: Some(EcnCodepoint::Ect0),
                contents: vec![1; 48],
                segment_size: None,
                src_ip: Some("127.0.0.2".parse().unwrap()),
            });
            assert_eq!(
                kinds,
                vec![
                    (libc::IPPROTO_IP, libc::IP_TOS),
                    (libc::IPPROTO_IP, libc::IP_PKTINFO),
                ]
            );
        }

        #[test]
        fn direct_control_messages_preserve_ipv6_ecn_and_source_pktinfo() {
            let kinds = control_kinds(OwnedTransmit {
                destination: "[::1]:4433".parse().unwrap(),
                ecn: Some(EcnCodepoint::Ce),
                contents: vec![1; 48],
                segment_size: None,
                src_ip: Some("::1".parse().unwrap()),
            });
            assert_eq!(
                kinds,
                vec![
                    (libc::IPPROTO_IPV6, libc::IPV6_TCLASS),
                    (libc::IPPROTO_IPV6, libc::IPV6_PKTINFO),
                ]
            );
        }
    }
}

#[cfg(target_os = "linux")]
use linux::flush;
#[cfg(target_os = "linux")]
use linux::try_send_priority;

#[cfg(test)]
mod tests {
    #[test]
    fn queued_output_diagnostics_keep_residence_separate_from_socket_wait_and_storage() {
        use super::*;
        let diagnostics = Component::test_armed("udp-socket");
        let transmit = Transmit {
            destination: "127.0.0.1:1234".parse().unwrap(),
            ecn: None,
            contents: &[1, 2, 3],
            segment_size: None,
            src_ip: None,
        };
        let mut queued = QueuedTransmit::new(&transmit, Some(&diagnostics));
        QueuedTransmit::new(&transmit, Some(&diagnostics)).rejected();
        assert_eq!(
            diagnostics.test_snapshot()["gauges"][1]["gauge"]["current"],
            1
        );
        assert_eq!(
            diagnostics.test_snapshot()["gauges"][2]["gauge"]["current"],
            3
        );
        std::thread::sleep(Duration::from_millis(8));
        diagnostics.test_advance(2);
        queued.dequeued();
        // The kernel wait starts only after dequeue; storage remains owned.
        diagnostics
            .start(IntervalKind::FlusherEagain)
            .unwrap()
            .finish();
        let snap = diagnostics.test_snapshot();
        let queue_hist = &snap["phases"][0]["intervals"][4]["histogram"];
        assert_eq!(queue_hist["count"], 1);
        assert_eq!(queue_hist["crossedPhase"], 1);
        assert_eq!(queue_hist["rejected"], 1);
        assert!(queue_hist["buckets"].as_array().unwrap()[..13]
            .iter()
            .all(|n| n == 0));
        assert_eq!(snap["phases"][1]["intervals"][3]["histogram"]["count"], 1);
        assert_eq!(snap["gauges"][1]["gauge"]["current"], 1);
        assert_eq!(snap["gauges"][2]["gauge"]["phaseHighWater"][1], 6);
        drop(queued);
        let snap = diagnostics.test_snapshot();
        assert_eq!(snap["gauges"][1]["gauge"]["current"], 0);
        assert_eq!(snap["gauges"][2]["gauge"]["current"], 0);
        assert_eq!(snap["errors"], 0);
    }

    #[test]
    fn ring_episode_and_waiter_gauges_follow_actual_block_drain_lifecycle() {
        use super::*;
        let diagnostics = Component::test_armed("udp-socket");
        let backpressure = Backpressure {
            diagnostics: Some(Arc::clone(&diagnostics)),
            ..Backpressure::default()
        };
        let mut cx = Context::from_waker(Waker::noop());
        let generation = backpressure.generation();
        backpressure.block(generation);
        backpressure.block(generation); // not a second independent full interval
        assert!(backpressure.poll_writable(&mut cx).is_pending());
        diagnostics.test_advance(2);
        backpressure.drained();
        let snap = diagnostics.test_snapshot();
        assert_eq!(snap["phases"][0]["intervals"][2]["histogram"]["count"], 1);
        assert_eq!(
            snap["phases"][0]["intervals"][2]["histogram"]["crossedPhase"],
            1
        );
        assert_eq!(
            snap["phases"][0]["intervals"][2]["histogram"]["rejected"],
            1
        );
        assert_eq!(snap["gauges"][3]["gauge"]["phaseHighWater"][1], 1);
        assert_eq!(snap["gauges"][3]["gauge"]["phaseHighWater"][2], 1);
        assert_eq!(snap["gauges"][3]["gauge"]["current"], 0);
        assert_eq!(snap["errors"], 0);
    }
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

    #[test]
    fn parses_the_gather_wait() {
        assert_eq!(parse_wait(None), Ok(Duration::ZERO));
        assert_eq!(parse_wait(Some("")), Ok(Duration::ZERO));
        assert_eq!(parse_wait(Some("250")), Ok(Duration::from_micros(250)));
        assert_eq!(parse_wait(Some("0")), Ok(Duration::ZERO));
        assert_eq!(parse_wait(Some(" 5000 ")), Ok(Duration::from_micros(5000)));
        assert!(parse_wait(Some("5001")).is_err());
        assert!(parse_wait(Some("-1")).is_err());
    }

    #[test]
    fn parses_the_eagain_mode() {
        assert_eq!(parse_eagain_mode(None), Ok(SendEagainMode::Wait));
        assert_eq!(parse_eagain_mode(Some("")), Ok(SendEagainMode::Wait));
        assert_eq!(parse_eagain_mode(Some("wait")), Ok(SendEagainMode::Wait));
        assert_eq!(parse_eagain_mode(Some(" drop ")), Ok(SendEagainMode::Drop));
        assert!(parse_eagain_mode(Some("retry")).is_err());
        assert!(parse_eagain_mode(Some("DROP")).is_err());
    }

    #[test]
    fn priority_send_classifies_success_would_block_gso_and_hard_error() {
        assert!(matches!(
            classify_priority_send(None, 48, || Ok(48)),
            PrioritySend::Sent
        ));
        assert!(matches!(
            classify_priority_send(None, 48, || Err(io::ErrorKind::WouldBlock.into())),
            PrioritySend::WouldBlock
        ));
        let mut called = false;
        assert!(matches!(
            classify_priority_send(Some(24), 48, || {
                called = true;
                Ok(48)
            }),
            PrioritySend::GsoFallback
        ));
        assert!(!called, "GSO must fall back without attempting direct send");
        assert!(matches!(
            classify_priority_send(None, 48, || Err(io::ErrorKind::PermissionDenied.into())),
            PrioritySend::Error(error) if error.kind() == io::ErrorKind::PermissionDenied
        ));
        assert!(matches!(
            classify_priority_send(None, 48, || Ok(12)),
            PrioritySend::Error(error) if error.kind() == io::ErrorKind::WriteZero
        ));
    }

    #[test]
    fn direct_would_block_restores_for_ring_full_but_clears_after_ring_accepts() {
        use std::cell::Cell;

        let restored = Cell::new(0);
        let cleared = Cell::new(0);
        let blocked = Cell::new(0);
        let accepted = dispatch_priority_or_ring(
            true,
            || PrioritySend::WouldBlock,
            || RingEnqueue::Accepted,
            || restored.set(restored.get() + 1),
            || cleared.set(cleared.get() + 1),
            || blocked.set(blocked.get() + 1),
        );
        assert!(accepted.is_ok());
        assert_eq!((restored.get(), cleared.get(), blocked.get()), (1, 1, 0));

        restored.set(0);
        cleared.set(0);
        let full = dispatch_priority_or_ring(
            true,
            || PrioritySend::WouldBlock,
            || RingEnqueue::Full,
            || restored.set(restored.get() + 1),
            || cleared.set(cleared.get() + 1),
            || blocked.set(blocked.get() + 1),
        );
        assert_eq!(full.unwrap_err().kind(), io::ErrorKind::WouldBlock);
        assert_eq!((restored.get(), cleared.get(), blocked.get()), (1, 0, 1));
    }

    #[test]
    fn direct_success_and_error_never_enter_the_ring() {
        let queued = std::cell::Cell::new(0);
        assert!(dispatch_priority_or_ring(
            true,
            || PrioritySend::Sent,
            || {
                queued.set(queued.get() + 1);
                RingEnqueue::Accepted
            },
            || {},
            || {},
            || {},
        )
        .is_ok());
        assert_eq!(queued.get(), 0);
        let error = dispatch_priority_or_ring(
            true,
            || PrioritySend::Error(io::ErrorKind::PermissionDenied.into()),
            || {
                queued.set(queued.get() + 1);
                RingEnqueue::Accepted
            },
            || {},
            || {},
            || {},
        )
        .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        assert_eq!(queued.get(), 0);
    }

    #[test]
    fn drop_mode_counts_the_whole_unsent_batch_on_eagain() {
        let mut waits = 0;
        let outcome = drive_send_batch(
            4,
            SendEagainMode::Drop,
            |_, _| Err(io::Error::from(io::ErrorKind::WouldBlock)),
            || waits += 1,
        );
        assert_eq!(
            outcome,
            SendBatchOutcome::CongestionDropped {
                sent: 0,
                dropped: 4
            }
        );
        assert_eq!(waits, 0);
    }

    #[test]
    fn drop_mode_counts_only_the_unsent_suffix_after_a_partial_send() {
        let mut calls = 0;
        let outcome = drive_send_batch(
            5,
            SendEagainMode::Drop,
            |offset, remaining| {
                calls += 1;
                if calls == 1 {
                    assert_eq!((offset, remaining), (0, 5));
                    Ok(2)
                } else {
                    assert_eq!((offset, remaining), (2, 3));
                    Err(io::Error::from(io::ErrorKind::WouldBlock))
                }
            },
            || panic!("drop mode must not wait"),
        );
        assert_eq!(
            outcome,
            SendBatchOutcome::CongestionDropped {
                sent: 2,
                dropped: 3
            }
        );
    }

    #[test]
    fn wait_mode_retries_eagain_and_eintr_until_complete() {
        let mut calls = 0;
        let mut waits = 0;
        let outcome = drive_send_batch(
            3,
            SendEagainMode::Wait,
            |offset, remaining| {
                calls += 1;
                match calls {
                    1 => Err(io::Error::from(io::ErrorKind::Interrupted)),
                    2 => Err(io::Error::from(io::ErrorKind::WouldBlock)),
                    3 => {
                        assert_eq!((offset, remaining), (0, 3));
                        Ok(1)
                    }
                    4 => {
                        assert_eq!((offset, remaining), (1, 2));
                        Ok(2)
                    }
                    _ => panic!("unexpected send call"),
                }
            },
            || waits += 1,
        );
        assert_eq!(outcome, SendBatchOutcome::Complete { sent: 3 });
        assert_eq!(waits, 1);
    }

    /// A full ring parks the driver on the poller instead of dropping or
    /// spinning: Pending while full, woken and Ready once the flusher drains.
    #[test]
    fn full_ring_parks_the_driver_until_drained() {
        use std::sync::atomic::AtomicUsize;
        use std::task::{Wake, Waker};

        struct Counter(AtomicUsize);
        impl Wake for Counter {
            fn wake(self: Arc<Self>) {
                self.0.fetch_add(1, Ordering::SeqCst);
            }
        }
        let counter = Arc::new(Counter(AtomicUsize::new(0)));
        let waker = Waker::from(Arc::clone(&counter));
        let mut cx = Context::from_waker(&waker);
        let backpressure = Backpressure::default();

        assert!(backpressure.poll_writable(&mut cx).is_ready());
        let seen = backpressure.generation();
        backpressure.block(seen);
        assert!(backpressure.poll_writable(&mut cx).is_pending());
        assert_eq!(counter.0.load(Ordering::SeqCst), 0);
        backpressure.drained();
        assert_eq!(counter.0.load(Ordering::SeqCst), 1, "parked driver woken");
        assert!(backpressure.poll_writable(&mut cx).is_ready());
    }

    /// A producer that saw a full ring, then lost the race to a drain, must
    /// not mark the now-empty ring full: no driver would ever be woken again.
    #[test]
    fn a_block_that_lost_the_race_to_a_drain_is_ignored() {
        let waker = Waker::noop();
        let mut cx = Context::from_waker(waker);
        let backpressure = Backpressure::default();
        let seen = backpressure.generation();
        backpressure.drained();
        backpressure.block(seen);
        assert!(
            backpressure.poll_writable(&mut cx).is_ready(),
            "stale block on an empty ring must not park drivers"
        );
        let seen = backpressure.generation();
        backpressure.block(seen);
        assert!(backpressure.poll_writable(&mut cx).is_pending());
    }

    /// Everything the ring accepts reaches the wire, in order per source,
    /// batched or not: bind a receiver, push N datagrams through a wrapped
    /// sender (retrying on the WouldBlock a full ring hands back, as quinn
    /// does), and read them all back.
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
        let socket = BatchedUdpSocket::spawn(inner, flusher_socket, 16, Duration::from_micros(250));
        let count = 200usize;
        for i in 0..count {
            let payload = format!("datagram-{i:04}");
            loop {
                let result = socket.try_send(&Transmit {
                    destination,
                    ecn: None,
                    contents: payload.as_bytes(),
                    segment_size: None,
                    src_ip: None,
                });
                match result {
                    Ok(()) => break,
                    Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_micros(50));
                    }
                    Err(e) => panic!("only WouldBlock may surface: {e}"),
                }
            }
        }
        let mut buf = [0u8; 64];
        for i in 0..count {
            let n = receiver.recv(&mut buf).expect("datagram arrives");
            assert_eq!(&buf[..n], format!("datagram-{i:04}").as_bytes());
        }
        let after = stats();
        assert_eq!(after.dropped, 0);
        assert_eq!(after.errors, 0);
        assert!(
            after.blocked > 0,
            "a 16-slot ring fed 200 datagrams pushed back"
        );
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
