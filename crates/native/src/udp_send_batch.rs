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
//! The single flusher preserves ring order. The experimental peer hint can
//! bypass queued output; it has no connection or ACK identity and must never
//! change the ring-full readiness predicate.
//! Accepted output remains owned until kernel acceptance or a sticky terminal
//! error. The historical `WEBTRANSPORT_NATIVE_UDP_SEND_EAGAIN_MODE=drop`
//! setting is rejected by this path; unset, empty, or `wait` retains the
//! scheduling above. Shutdown publishes cancellation before releasing output.
//!
//! `WEBTRANSPORT_NATIVE_UDP_SEND_BATCH` selects the batch size (2..=1024);
//! unset or 0 leaves the socket untouched, byte-for-byte today's behaviour.
//! `WEBTRANSPORT_NATIVE_UDP_SEND_BATCH_WAIT_US` (0..=5000, default 0) is how
//! long the flusher waits for a batch to fill before sending what it has. The
//! backpressure is what buys the packing, not the wait: at 2875 sessions the
//! 250 us wait and no wait both cut ack p99 from 26.6 to 8.5 ms, and no wait
//! did it with less CPU and a cleaner ingest, so the default is 0.
//! Linux only for the batched path; elsewhere the flusher sends one at a time
//! through quinn-udp's fallible send primitive and counts each fallback.

use std::collections::BTreeMap;
use std::io;
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::task::{Context, Poll, Waker};
use std::time::{Duration, Instant};

use crate::send_path_diagnostics::{Component, GaugeKind, Interval, IntervalKind, Reservation};
use wtransport::quinn::udp::{EcnCodepoint, RecvMeta, Transmit};
use wtransport::quinn::{AsyncUdpSocket, UdpPoller};

const MIN_BATCH: usize = 2;
const MAX_BATCH: usize = 1024;
const DEFAULT_WAIT_US: u64 = 0;
const MAX_WAIT_US: u64 = 5000;
// Quinn 0.11.11 caps one connection-driver transmit at ten UDP segments;
// its protocol MTU is u16. Bound bytes before copying, including GSO buffers.
const MAX_TRANSMIT_BYTES: usize = 10 * u16::MAX as usize;
const CONTROL_POLL: Duration = Duration::from_millis(100);
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

fn validate_batch_eagain_mode(batch: Option<usize>, mode: SendEagainMode) -> Result<(), String> {
    if batch.is_some() && mode != SendEagainMode::Wait {
        return Err("WEBTRANSPORT_NATIVE_UDP_SEND_EAGAIN_MODE must be wait when WEBTRANSPORT_NATIVE_UDP_SEND_BATCH is enabled, got 'drop'".to_string());
    }
    Ok(())
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
    Complete {
        sent: usize,
    },
    CongestionDropped {
        sent: usize,
        dropped: usize,
    },
    Fallback {
        sent: usize,
        offset: usize,
    },
    Error {
        sent: usize,
        remaining: usize,
        error: StoredError,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct StoredError {
    kind: io::ErrorKind,
    raw: Option<i32>,
}

impl StoredError {
    fn capture(error: &io::Error) -> Self {
        Self {
            kind: error.kind(),
            raw: error.raw_os_error(),
        }
    }
    fn to_io(self) -> io::Error {
        self.raw
            .map(io::Error::from_raw_os_error)
            .unwrap_or_else(|| io::Error::new(self.kind, "UDP batch output terminated"))
    }
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
    W: FnMut() -> io::Result<()>,
{
    let mut offset = 0usize;
    while offset < total {
        match send(offset, total - offset) {
            Ok(sent) if sent == 0 || sent > total - offset => {
                return SendBatchOutcome::Error {
                    sent: offset,
                    remaining: total - offset,
                    error: StoredError::capture(&io::ErrorKind::WriteZero.into()),
                };
            }
            Ok(sent) => offset += sent,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => match mode {
                SendEagainMode::Wait => {
                    if let Err(error) = wait_writable() {
                        return SendBatchOutcome::Error {
                            sent: offset,
                            remaining: total - offset,
                            error: StoredError::capture(&error),
                        };
                    }
                }
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
            Err(error) => {
                return SendBatchOutcome::Error {
                    sent: offset,
                    remaining: total - offset,
                    error: StoredError::capture(&error),
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

/// Refuse an unsupported combination before starting the endpoint. Malformed
/// individual environment knobs keep their existing fatal-parser diagnostics;
/// this known combination uses the server's recoverable startup-error path.
pub(crate) fn validate_configured_output_mode() -> Result<(), String> {
    let batch = configured_batch();
    if batch.is_some() {
        validate_batch_eagain_mode(batch, configured_eagain_mode())
    } else {
        // Batch 0 leaves the stock socket untouched and preserves legacy mode
        // parsing for archived campaign receipts/getters.
        Ok(())
    }
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
    _capacity: Option<OutputCredit>,
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
            _capacity: None,
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

/// The channel and flusher can each retain one batch. Credits cover both,
/// including producers between reservation and enqueue; no payload is copied
/// until both a count and byte credit have been acquired.
struct OutputBudget {
    max_count: usize,
    max_bytes: usize,
    usage: Mutex<(usize, usize)>,
}

impl OutputBudget {
    fn new(batch: usize) -> Arc<Self> {
        Arc::new(Self {
            max_count: 2 * batch,
            max_bytes: 2 * batch * MAX_TRANSMIT_BYTES,
            usage: Mutex::new((0, 0)),
        })
    }

    fn reserve(self: &Arc<Self>, bytes: usize) -> io::Result<OutputCredit> {
        if bytes > MAX_TRANSMIT_BYTES {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        let mut usage = self.usage.lock().expect("output credits");
        if usage.0 >= self.max_count || bytes > self.max_bytes - usage.1 {
            return Err(io::ErrorKind::WouldBlock.into());
        }
        usage.0 += 1;
        usage.1 += bytes;
        Ok(OutputCredit {
            budget: Arc::clone(self),
            bytes,
        })
    }
}

struct OutputCredit {
    budget: Arc<OutputBudget>,
    bytes: usize,
}

impl Drop for OutputCredit {
    fn drop(&mut self) {
        let mut usage = self.budget.usage.lock().expect("output credits");
        usage.0 -= 1;
        usage.1 -= self.bytes;
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
    next_waiter: AtomicU64,
    wakers: Mutex<BTreeMap<u64, Waker>>,
    diagnostics: Option<Arc<Component>>,
    blocked_interval: Mutex<Option<Interval>>,
    failed: AtomicBool,
    terminal: Mutex<Option<StoredError>>,
    control: Condvar,
    recv_waker: Mutex<Option<Waker>>,
}

impl Backpressure {
    fn check(&self) -> io::Result<()> {
        if !self.failed.load(Ordering::Acquire) {
            return Ok(());
        }
        Err(self
            .terminal
            .lock()
            .expect("terminal error")
            .expect("published terminal error")
            .to_io())
    }

    fn fail(&self, error: io::Error) {
        {
            let mut terminal = self.terminal.lock().expect("terminal error");
            if terminal.is_some() {
                return;
            }
            *terminal = Some(StoredError::capture(&error));
            self.failed.store(true, Ordering::Release);
        }
        self.control.notify_all();
        self.drained();
        let recv = self.recv_waker.lock().expect("receive waker").take();
        if let Some(waker) = recv {
            waker.wake();
        }
    }

    fn wait_control(&self, duration: Duration) -> io::Result<()> {
        let terminal = self.terminal.lock().expect("terminal error");
        let (terminal, _) = self
            .control
            .wait_timeout_while(terminal, duration, |terminal| terminal.is_none())
            .expect("UDP control wait");
        match *terminal {
            Some(error) => Err(error.to_io()),
            None => Ok(()),
        }
    }

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
        self.state
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |state| {
                Some(((state >> 1).wrapping_add(1)) << 1)
            })
            .expect("drain always advances the generation");
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
        for (_, waker) in wakers {
            waker.wake();
        }
    }

    fn unregister(&self, id: u64) {
        let removed = {
            let mut registered = self.wakers.lock().expect("wakers");
            let removed = registered.remove(&id);
            if removed.is_some() {
                if let Some(diag) = &self.diagnostics {
                    diag.change_gauge(GaugeKind::WaiterRegistrations, -1);
                }
            }
            removed
        };
        drop(removed);
    }

    fn poll_writable(&self, id: u64, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        if let Err(error) = self.check() {
            self.unregister(id);
            return Poll::Ready(Err(error));
        }
        if !self.is_full() {
            self.unregister(id);
            return Poll::Ready(Ok(()));
        }
        // Waker vtables can re-enter the readiness machinery. Clone and drop
        // outside the registry lock just as wake notifications are outside it.
        let waker = cx.waker().clone();
        let replaced = {
            let mut registered = self.wakers.lock().expect("wakers");
            match registered.entry(id) {
                std::collections::btree_map::Entry::Occupied(mut entry) => {
                    Some(entry.insert(waker))
                }
                std::collections::btree_map::Entry::Vacant(entry) => {
                    entry.insert(waker);
                    if let Some(diag) = &self.diagnostics {
                        diag.change_gauge(GaugeKind::WaiterRegistrations, 1);
                    }
                    None
                }
            }
        };
        drop(replaced);
        // Re-check after registration so a drain between the initial full
        // check and insertion cannot strand this driver, including a refill.
        if let Err(error) = self.check() {
            self.unregister(id);
            Poll::Ready(Err(error))
        } else if self.is_full() {
            Poll::Pending
        } else {
            self.unregister(id);
            Poll::Ready(Ok(()))
        }
    }
}

/// Replaces the inner socket's poller: the kernel socket is nearly always
/// writable, so polling it would spin a driver that the ring just refused.
struct RingPoller {
    backpressure: Arc<Backpressure>,
    registration: u64,
}

impl RingPoller {
    fn new(backpressure: Arc<Backpressure>) -> Self {
        let registration = backpressure.next_waiter.fetch_add(1, Ordering::Relaxed);
        Self {
            backpressure,
            registration,
        }
    }
}

impl Drop for RingPoller {
    fn drop(&mut self) {
        self.backpressure.unregister(self.registration);
    }
}

impl std::fmt::Debug for RingPoller {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RingPoller").finish()
    }
}

impl UdpPoller for RingPoller {
    fn poll_writable(self: std::pin::Pin<&mut Self>, cx: &mut Context) -> Poll<io::Result<()>> {
        self.backpressure.poll_writable(self.registration, cx)
    }
}

pub(crate) struct BatchedUdpSocket {
    inner: Arc<dyn AsyncUdpSocket>,
    direct_socket: std::net::UdpSocket,
    tx: SyncSender<QueuedTransmit>,
    backpressure: Arc<Backpressure>,
    budget: Arc<OutputBudget>,
    flusher: Option<std::thread::JoinHandle<()>>,
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
        assert!((MIN_BATCH..=MAX_BATCH).contains(&batch));
        let direct_socket = flusher_socket
            .try_clone()
            .expect("clone UDP socket for reflector ring bypass");
        let (tx, rx) = sync_channel::<QueuedTransmit>(batch);
        let backpressure = Arc::new(Backpressure {
            diagnostics: crate::send_path_diagnostics::register("udp-socket"),
            ..Backpressure::default()
        });
        // Historical drop-mode parsing remains for archived campaign receipts,
        // but it cannot enter the retaining-output path used by the new arms.
        if configured_eagain_mode() != SendEagainMode::Wait {
            backpressure.fail(io::Error::new(
                io::ErrorKind::InvalidInput,
                "UDP batch output requires EAGAIN wait mode",
            ));
        }
        let flusher_backpressure = Arc::clone(&backpressure);
        let flusher = std::thread::Builder::new()
            .name("wt-udp-send-batch".to_string())
            .spawn(move || {
                let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    flusher_loop(rx, flusher_socket, batch, wait, &flusher_backpressure)
                }));
                if outcome.is_err() {
                    flusher_backpressure.fail(io::Error::other("UDP flusher panicked"));
                }
            })
            .expect("spawn wt-udp-send-batch thread");
        Self {
            inner,
            direct_socket,
            tx,
            backpressure,
            budget: OutputBudget::new(batch),
            flusher: Some(flusher),
        }
    }
}

impl Drop for BatchedUdpSocket {
    fn drop(&mut self) {
        // A poller may outlive its socket on rebind. Publish cancellation before
        // releasing accepted output, wake that poller, and join the owned thread.
        self.backpressure.fail(io::Error::new(
            io::ErrorKind::ConnectionAborted,
            "UDP batch socket closed",
        ));
        if let Some(flusher) = self.flusher.take() {
            // Waking a cancelled task can release its last socket reference on
            // this very flusher. It is already cancelled and will return from
            // the control-checked loop; joining ourselves would panic/deadlock.
            if flusher.thread().id() != std::thread::current().id() {
                let _ = flusher.join();
            }
        }
    }
}

impl AsyncUdpSocket for BatchedUdpSocket {
    fn create_io_poller(self: Arc<Self>) -> std::pin::Pin<Box<dyn UdpPoller>> {
        Box::pin(RingPoller::new(Arc::clone(&self.backpressure)))
    }

    fn try_send(&self, transmit: &Transmit) -> io::Result<()> {
        self.backpressure.check()?;
        if transmit.contents.len() > MAX_TRANSMIT_BYTES
            || transmit
                .segment_size
                .is_some_and(|segment| segment == 0 || segment > u16::MAX as usize)
        {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        let peer = transmit.destination;
        let seen = self.backpressure.generation();
        let result = dispatch_priority_or_ring(
            crate::datagram_reflector::take_ring_bypass(peer),
            || try_send_priority(&self.direct_socket, transmit),
            || {
                let credit = match self.budget.reserve(transmit.contents.len()) {
                    Ok(credit) => credit,
                    Err(_) => return RingEnqueue::Full,
                };
                let mut queued =
                    QueuedTransmit::new(transmit, self.backpressure.diagnostics.as_ref());
                queued._capacity = Some(credit);
                match self.tx.try_send(queued) {
                    Ok(()) => RingEnqueue::Accepted,
                    Err(TrySendError::Full(queued)) => {
                        queued.rejected();
                        RingEnqueue::Full
                    }
                    Err(TrySendError::Disconnected(queued)) => {
                        queued.rejected();
                        RingEnqueue::Disconnected
                    }
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
        );
        if let Err(error) = &result {
            if error.kind() != io::ErrorKind::WouldBlock {
                self.backpressure.fail(StoredError::capture(error).to_io());
            }
        }
        // A flusher failure racing an enqueue is sticky: even if the ring took
        // the allocation, this call must not hide the terminal disposition.
        self.backpressure.check()?;
        result
    }

    fn poll_recv(
        &self,
        cx: &mut std::task::Context,
        bufs: &mut [io::IoSliceMut<'_>],
        meta: &mut [RecvMeta],
    ) -> std::task::Poll<io::Result<usize>> {
        if let Err(error) = self.backpressure.check() {
            return Poll::Ready(Err(error));
        }
        let waker = cx.waker().clone();
        let previous = self
            .backpressure
            .recv_waker
            .lock()
            .expect("receive waker")
            .replace(waker);
        drop(previous);
        let result = self.inner.poll_recv(cx, bufs, meta);
        // The endpoint can be waiting only for input after accepting output.
        // Register/recheck closes the asynchronous send-failure wakeup race.
        if let Err(error) = self.backpressure.check() {
            let removed = self
                .backpressure
                .recv_waker
                .lock()
                .expect("receive waker")
                .take();
            drop(removed);
            return Poll::Ready(Err(error));
        }
        if result.is_ready() {
            let removed = self
                .backpressure
                .recv_waker
                .lock()
                .expect("receive waker")
                .take();
            drop(removed);
        }
        result
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
            Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "UDP flusher disconnected",
            ))
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
    socket: std::net::UdpSocket,
    batch: usize,
    wait: Duration,
    backpressure: &Backpressure,
) {
    let state = match wtransport::quinn::udp::UdpSocketState::new((&socket).into()) {
        Ok(state) => state,
        Err(error) => {
            backpressure.fail(error);
            return;
        }
    };
    run_flusher(rx, batch, wait, backpressure, |pending| {
        flush(&socket, &state, pending, backpressure)
    });
}

fn run_flusher<F>(
    rx: Receiver<QueuedTransmit>,
    batch: usize,
    wait: Duration,
    backpressure: &Backpressure,
    mut flush_batch: F,
) where
    F: FnMut(&[QueuedTransmit]) -> io::Result<()>,
{
    let mut pending: Vec<QueuedTransmit> = Vec::with_capacity(batch);
    loop {
        if backpressure.check().is_err() {
            return;
        }
        let mut first = match rx.recv_timeout(CONTROL_POLL) {
            Ok(first) => first,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                backpressure.fail(io::ErrorKind::BrokenPipe.into());
                return;
            }
        };
        first.dequeued();
        pending.push(first);
        let deadline = Instant::now() + wait;
        while pending.len() < batch {
            let remaining = deadline.saturating_duration_since(Instant::now());
            let next = if remaining.is_zero() {
                rx.try_recv().ok()
            } else {
                rx.recv_timeout(remaining.min(CONTROL_POLL)).ok()
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
        let outcome =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| flush_batch(&pending)))
                .unwrap_or_else(|_| Err(io::Error::other("UDP flusher panicked")));
        if let Err(error) = outcome {
            // Publish the terminal disposition before either accepted storage
            // owner (pending or rx) is dropped.
            backpressure.fail(error);
            ERRORS.fetch_add(pending.len() as u64, Ordering::Relaxed);
            return;
        }
        pending.clear();
        backpressure.drained();
    }
}

/// Retain each unsent segment across EAGAIN. In particular, do not call the
/// inner Tokio socket here: quinn-udp's `send` converts hard errors to Ok.
/// Its fallible `try_send` preserves ancillary metadata without hiding loss.
fn send_one_fallback(
    socket: &std::net::UdpSocket,
    state: &wtransport::quinn::udp::UdpSocketState,
    transmit: &OwnedTransmit,
    backpressure: &Backpressure,
) -> io::Result<()> {
    FALLBACK.fetch_add(1, Ordering::Relaxed);
    let interval = std::cell::RefCell::new(None::<Interval>);
    drive_fallback(
        transmit,
        |segment| {
            backpressure.check()?;
            let result = state.try_send(socket.into(), segment);
            if result.is_ok() {
                if let Some(wait) = interval.borrow_mut().take() {
                    wait.finish();
                }
            }
            result
        },
        || {
            if interval.borrow().is_none() {
                *interval.borrow_mut() = backpressure
                    .diagnostics
                    .as_ref()
                    .and_then(|diag| diag.start(IntervalKind::FlusherEagain));
            }
            wait_writable(socket, backpressure)
        },
    )
}

fn drive_fallback<S, W>(transmit: &OwnedTransmit, mut send: S, mut wait: W) -> io::Result<()>
where
    S: FnMut(&Transmit<'_>) -> io::Result<()>,
    W: FnMut() -> io::Result<()>,
{
    let segment_size = transmit
        .segment_size
        .unwrap_or(transmit.contents.len())
        .max(1);
    let mut offset = 0;
    loop {
        let end = transmit.contents.len().min(offset + segment_size);
        let mut segment = transmit.as_transmit();
        segment.contents = &transmit.contents[offset..end];
        segment.segment_size = None;
        match send(&segment) {
            Ok(()) => offset = end,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                wait()?;
                continue;
            }
            Err(error) => return Err(error),
        }
        if offset == transmit.contents.len() {
            return Ok(());
        }
    }
}

#[cfg(not(target_os = "linux"))]
fn wait_writable(_socket: &std::net::UdpSocket, backpressure: &Backpressure) -> io::Result<()> {
    // No platform reactor is owned by this thread. A bounded control wait is
    // cancellable and avoids retrying a nonblocking send in a tight loop.
    backpressure.wait_control(Duration::from_millis(1))
}

#[cfg(not(target_os = "linux"))]
fn flush(
    socket: &std::net::UdpSocket,
    state: &wtransport::quinn::udp::UdpSocketState,
    pending: &[QueuedTransmit],
    backpressure: &Backpressure,
) -> io::Result<()> {
    for transmit in pending {
        send_one_fallback(socket, state, transmit, backpressure)?;
    }
    Ok(())
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
        state: &wtransport::quinn::udp::UdpSocketState,
        pending: &[QueuedTransmit],
        backpressure: &Backpressure,
    ) -> io::Result<()> {
        let diagnostics = backpressure.diagnostics.as_ref();
        let batched: Vec<&OwnedTransmit> = pending.iter().map(|queued| &queued.transmit).collect();
        if batched.is_empty() {
            return Ok(());
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
            SendEagainMode::Wait,
            |offset, remaining| {
                backpressure.check()?;
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
            || wait_writable(socket, backpressure),
        );
        match outcome {
            SendBatchOutcome::Complete { .. } => {}
            SendBatchOutcome::CongestionDropped { dropped, .. } => {
                CONGESTION_DROPPED.fetch_add(dropped as u64, Ordering::Relaxed);
                return Err(io::ErrorKind::ConnectionAborted.into());
            }
            // EINVAL/EIO on a GSO transmit is how the kernel refuses
            // segmentation; retain the unsent suffix and send its individual
            // segments through quinn-udp's error-preserving primitive.
            SendBatchOutcome::Fallback { offset, .. } => {
                for transmit in &batched[offset..] {
                    send_one_fallback(socket, state, transmit, backpressure)?;
                }
                if let Some(interval) = eagain_interval.borrow_mut().take() {
                    interval.finish();
                }
            }
            SendBatchOutcome::Error { error, .. } => {
                return Err(error.to_io());
            }
        }
        Ok(())
    }

    pub(super) fn wait_writable(
        socket: &std::net::UdpSocket,
        backpressure: &Backpressure,
    ) -> io::Result<()> {
        let started = Instant::now();
        loop {
            backpressure.check()?;
            let mut pfd = libc::pollfd {
                fd: socket.as_raw_fd(),
                events: libc::POLLOUT,
                revents: 0,
            };
            let result =
                unsafe { libc::poll(&mut pfd, 1, CONTROL_POLL.as_millis() as libc::c_int) };
            backpressure.check()?;
            if result < 0 {
                let error = io::Error::last_os_error();
                if error.kind() == io::ErrorKind::Interrupted {
                    continue;
                }
                return Err(error);
            }
            if pfd.revents & (libc::POLLERR | libc::POLLHUP | libc::POLLNVAL) != 0 {
                return Err(socket
                    .take_error()?
                    .unwrap_or_else(|| io::ErrorKind::BrokenPipe.into()));
            }
            if pfd.revents & libc::POLLOUT != 0 {
                // POLLOUT can stay set when a large UDP/GSO write still gets
                // EAGAIN. Bound that retry rate without releasing ring waiters.
                return backpressure
                    .wait_control(Duration::from_millis(1).saturating_sub(started.elapsed()));
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

        #[test]
        fn linux_encoder_preserves_gso_size_ecn_and_source_values() {
            let transmit = OwnedTransmit {
                destination: "127.0.0.1:4433".parse().unwrap(),
                ecn: Some(EcnCodepoint::Ce),
                contents: vec![1; 2400],
                segment_size: Some(1200),
                src_ip: Some("127.0.0.2".parse().unwrap()),
            };
            let mut ctrl = Ctrl([0u8; CTRL_LEN]);
            let mut hdr: libc::msghdr = unsafe { std::mem::zeroed() };
            let used = encode_ctrl(&transmit, &mut ctrl, &mut hdr);
            assert!(used <= CTRL_LEN);
            unsafe {
                let ecn = libc::CMSG_FIRSTHDR(&hdr);
                assert_eq!((*ecn).cmsg_type, libc::IP_TOS);
                assert_eq!(
                    std::ptr::read_unaligned(libc::CMSG_DATA(ecn) as *const libc::c_int),
                    3
                );
                let gso = libc::CMSG_NXTHDR(&hdr, ecn);
                assert_eq!((*gso).cmsg_type, libc::UDP_SEGMENT);
                assert_eq!(
                    std::ptr::read_unaligned(libc::CMSG_DATA(gso) as *const u16),
                    1200
                );
                let source = libc::CMSG_NXTHDR(&hdr, gso);
                assert_eq!((*source).cmsg_type, libc::IP_PKTINFO);
                let info =
                    std::ptr::read_unaligned(libc::CMSG_DATA(source) as *const libc::in_pktinfo);
                assert_eq!(info.ipi_spec_dst.s_addr.to_ne_bytes(), [127, 0, 0, 2]);
                assert!(libc::CMSG_NXTHDR(&hdr, source).is_null());
            }
        }

        #[test]
        fn linux_sendmmsg_and_segmented_fallback_reach_loopback_without_duplication() {
            let receiver = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
            receiver
                .set_read_timeout(Some(Duration::from_secs(1)))
                .unwrap();
            let sender = std::net::UdpSocket::bind("0.0.0.0:0").unwrap();
            sender.set_nonblocking(true).unwrap();
            let state = wtransport::quinn::udp::UdpSocketState::new((&sender).into()).unwrap();
            let control = Backpressure::default();
            let mut transmit = OwnedTransmit {
                destination: receiver.local_addr().unwrap(),
                ecn: Some(EcnCodepoint::Ect0),
                contents: vec![0, 1],
                segment_size: None,
                src_ip: Some("127.0.0.2".parse().unwrap()),
            };
            let pending = vec![
                QueuedTransmit::new(&transmit.as_transmit(), None),
                QueuedTransmit::new(&transmit.as_transmit(), None),
            ];
            flush(&sender, &state, &pending, &control).unwrap();
            transmit.contents = vec![2, 3, 4, 5, 6];
            transmit.segment_size = Some(2);
            send_one_fallback(&sender, &state, &transmit, &control).unwrap();
            let mut buf = [0; 32];
            for expected in [&[0, 1][..], &[0, 1], &[2, 3], &[4, 5], &[6]] {
                let (length, source) = receiver.recv_from(&mut buf).unwrap();
                assert_eq!(&buf[..length], expected);
                assert_eq!(source.ip(), transmit.src_ip.unwrap());
            }
            receiver.set_nonblocking(true).unwrap();
            assert_eq!(
                receiver.recv(&mut buf).unwrap_err().kind(),
                io::ErrorKind::WouldBlock
            );
        }

        #[test]
        fn linux_writable_wait_checks_shutdown_and_bounds_false_ready_retries() {
            let socket = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
            socket.set_nonblocking(true).unwrap();
            let control = Backpressure::default();
            let started = Instant::now();
            wait_writable(&socket, &control).unwrap();
            assert!(started.elapsed() >= Duration::from_millis(1));
            control.fail(io::ErrorKind::ConnectionAborted.into());
            let started = Instant::now();
            assert_eq!(
                wait_writable(&socket, &control).unwrap_err().kind(),
                io::ErrorKind::ConnectionAborted
            );
            assert!(started.elapsed() < Duration::from_secs(1));
        }

        #[test]
        fn linux_hard_fallback_error_is_not_converted_to_success() {
            let socket = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
            socket.set_nonblocking(true).unwrap();
            let state = wtransport::quinn::udp::UdpSocketState::new((&socket).into()).unwrap();
            let transmit = OwnedTransmit {
                destination: "[::1]:4433".parse().unwrap(),
                ecn: None,
                contents: vec![1],
                segment_size: None,
                src_ip: None,
            };
            assert!(
                send_one_fallback(&socket, &state, &transmit, &Backpressure::default()).is_err()
            );
        }
    }
}

#[cfg(target_os = "linux")]
use linux::flush;
#[cfg(target_os = "linux")]
use linux::try_send_priority;
#[cfg(target_os = "linux")]
use linux::wait_writable;

#[cfg(test)]
mod tests {
    struct WakeCounter(std::sync::atomic::AtomicUsize);
    impl std::task::Wake for WakeCounter {
        fn wake(self: Arc<Self>) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }

    #[test]
    fn repoll_replaces_the_waker_and_ready_removes_registration() {
        let backpressure = Arc::new(Backpressure::default());
        backpressure.block(backpressure.generation());
        let mut poller = Box::pin(RingPoller::new(Arc::clone(&backpressure)));
        let old = Arc::new(WakeCounter(0.into()));
        let replacement = Arc::new(WakeCounter(0.into()));
        let old_waker = Waker::from(Arc::clone(&old));
        let new_waker = Waker::from(Arc::clone(&replacement));
        assert!(poller
            .as_mut()
            .poll_writable(&mut Context::from_waker(&old_waker))
            .is_pending());
        assert!(poller
            .as_mut()
            .poll_writable(&mut Context::from_waker(&new_waker))
            .is_pending());
        backpressure.drained();
        assert_eq!(old.0.load(Ordering::SeqCst), 0);
        assert_eq!(replacement.0.load(Ordering::SeqCst), 1);
        assert!(poller
            .as_mut()
            .poll_writable(&mut Context::from_waker(&new_waker))
            .is_ready());
        assert!(backpressure.wakers.lock().unwrap().is_empty());
    }

    #[test]
    fn independent_waiters_cancel_and_rebind_without_retained_storage() {
        let old_socket = Arc::new(Backpressure::default());
        let new_socket = Arc::new(Backpressure::default());
        old_socket.block(old_socket.generation());
        new_socket.block(new_socket.generation());
        let mut cx = Context::from_waker(Waker::noop());
        let mut pollers: Vec<_> = (0..512)
            .map(|_| Box::pin(RingPoller::new(Arc::clone(&old_socket))))
            .collect();
        for poller in &mut pollers {
            assert!(poller.as_mut().poll_writable(&mut cx).is_pending());
        }
        assert_eq!(old_socket.wakers.lock().unwrap().len(), 512);
        pollers.truncate(256);
        assert_eq!(old_socket.wakers.lock().unwrap().len(), 256);
        // Quinn handles Rebind by replacing its socket and io_poller.
        for poller in &mut pollers {
            *poller = Box::pin(RingPoller::new(Arc::clone(&new_socket)));
            assert!(poller.as_mut().poll_writable(&mut cx).is_pending());
        }
        assert!(old_socket.wakers.lock().unwrap().is_empty());
        assert_eq!(new_socket.wakers.lock().unwrap().len(), 256);
        drop(pollers);
        assert!(new_socket.wakers.lock().unwrap().is_empty());
    }

    #[test]
    fn drain_refill_and_stale_full_mark_leave_current_waiters_armed() {
        let backpressure = Arc::new(Backpressure::default());
        let stale = backpressure.generation();
        backpressure.block(stale);
        let counter = Arc::new(WakeCounter(0.into()));
        let waker = Waker::from(Arc::clone(&counter));
        let mut cx = Context::from_waker(&waker);
        let mut poller = Box::pin(RingPoller::new(Arc::clone(&backpressure)));
        assert!(poller.as_mut().poll_writable(&mut cx).is_pending());
        backpressure.drained();
        backpressure.block(backpressure.generation());
        // A wake for the earlier drain does not mean the refilled ring is ready.
        assert!(poller.as_mut().poll_writable(&mut cx).is_pending());
        backpressure.block(stale);
        assert_eq!(backpressure.wakers.lock().unwrap().len(), 1);
        backpressure.drained();
        assert_eq!(counter.0.load(Ordering::SeqCst), 2);
        backpressure.block(stale);
        assert!(poller.as_mut().poll_writable(&mut cx).is_ready());
        assert!(backpressure.wakers.lock().unwrap().is_empty());
    }

    #[test]
    fn drain_between_full_check_and_registration_is_rechecked_with_and_without_refill() {
        struct DrainOnClone {
            backpressure: Arc<Backpressure>,
            refill: bool,
            fired: AtomicBool,
        }
        unsafe fn clone_hook(data: *const ()) -> std::task::RawWaker {
            let state = std::mem::ManuallyDrop::new(Arc::<DrainOnClone>::from_raw(data.cast()));
            if !state.fired.swap(true, Ordering::SeqCst) {
                state.backpressure.drained();
                if state.refill {
                    state.backpressure.block(state.backpressure.generation());
                }
            }
            std::task::RawWaker::new(Arc::into_raw(Arc::clone(&state)).cast(), &VTABLE)
        }
        unsafe fn wake(data: *const ()) {
            drop(Arc::<DrainOnClone>::from_raw(data.cast()));
        }
        unsafe fn wake_by_ref(_data: *const ()) {}
        unsafe fn drop_hook(data: *const ()) {
            drop(Arc::<DrainOnClone>::from_raw(data.cast()));
        }
        const VTABLE: std::task::RawWakerVTable =
            std::task::RawWakerVTable::new(clone_hook, wake, wake_by_ref, drop_hook);

        for refill in [false, true] {
            let (done_tx, done_rx) = sync_channel(1);
            let worker = std::thread::spawn(move || {
                let backpressure = Arc::new(Backpressure::default());
                backpressure.block(backpressure.generation());
                let state = Arc::new(DrainOnClone {
                    backpressure: Arc::clone(&backpressure),
                    refill,
                    fired: false.into(),
                });
                let waker = unsafe {
                    Waker::from_raw(std::task::RawWaker::new(
                        Arc::into_raw(state).cast(),
                        &VTABLE,
                    ))
                };
                let mut poller = Box::pin(RingPoller::new(Arc::clone(&backpressure)));
                let result = poller
                    .as_mut()
                    .poll_writable(&mut Context::from_waker(&waker));
                assert_eq!(result.is_pending(), refill);
                assert_eq!(
                    backpressure.wakers.lock().unwrap().len(),
                    usize::from(refill)
                );
                backpressure.drained();
                assert!(poller
                    .as_mut()
                    .poll_writable(&mut Context::from_waker(&waker))
                    .is_ready());
                drop(poller);
                assert!(backpressure.wakers.lock().unwrap().is_empty());
                done_tx.send(()).unwrap();
            });
            done_rx
                .recv_timeout(Duration::from_secs(1))
                .expect("registration race deadlocked");
            worker.join().unwrap();
        }
    }

    #[test]
    fn drain_wakes_outside_the_registry_lock() {
        struct LockCheckingWake(std::sync::Weak<Backpressure>);
        impl std::task::Wake for LockCheckingWake {
            fn wake(self: Arc<Self>) {
                assert!(self.0.upgrade().unwrap().wakers.try_lock().is_ok());
            }
        }
        let backpressure = Arc::new(Backpressure::default());
        backpressure.block(backpressure.generation());
        let waker = Waker::from(Arc::new(LockCheckingWake(Arc::downgrade(&backpressure))));
        let mut poller = Box::pin(RingPoller::new(Arc::clone(&backpressure)));
        assert!(poller
            .as_mut()
            .poll_writable(&mut Context::from_waker(&waker))
            .is_pending());
        backpressure.drained();
    }

    #[test]
    fn partial_batch_eagain_resume_never_resends_the_accepted_prefix() {
        let mut accepted = Vec::new();
        let mut calls = 0;
        let mut waits = 0;
        let outcome = drive_send_batch(
            5,
            SendEagainMode::Wait,
            |offset, remaining| {
                calls += 1;
                match calls {
                    1 => {
                        accepted.extend(offset..offset + 2);
                        Ok(2)
                    }
                    2 | 3 => {
                        assert_eq!((offset, remaining), (2, 3));
                        Err(io::ErrorKind::WouldBlock.into())
                    }
                    4 => {
                        accepted.extend(offset..offset + remaining);
                        Ok(remaining)
                    }
                    _ => panic!("unbounded send retry"),
                }
            },
            || {
                waits += 1;
                Ok(())
            },
        );
        assert_eq!(outcome, SendBatchOutcome::Complete { sent: 5 });
        assert_eq!(accepted, vec![0, 1, 2, 3, 4]);
        assert_eq!(waits, 2);
    }

    #[test]
    fn batch_wait_failure_and_zero_progress_are_terminal() {
        let outcome = drive_send_batch(
            3,
            SendEagainMode::Wait,
            |_, _| Err(io::ErrorKind::WouldBlock.into()),
            || Err(io::ErrorKind::ConnectionAborted.into()),
        );
        assert!(
            matches!(outcome, SendBatchOutcome::Error { sent: 0, remaining: 3, error }
            if error.kind == io::ErrorKind::ConnectionAborted)
        );
        let outcome = drive_send_batch(
            3,
            SendEagainMode::Wait,
            |_, _| Ok(0),
            || panic!("zero progress is terminal"),
        );
        assert!(matches!(outcome, SendBatchOutcome::Error { error, .. }
            if error.kind == io::ErrorKind::WriteZero));
    }

    fn segmented_output() -> OwnedTransmit {
        OwnedTransmit {
            destination: "127.0.0.1:1234".parse().unwrap(),
            ecn: Some(EcnCodepoint::Ect0),
            contents: vec![0, 1, 2, 3, 4],
            segment_size: Some(2),
            src_ip: Some("127.0.0.1".parse().unwrap()),
        }
    }

    #[test]
    fn gso_fallback_retains_each_segment_and_metadata_until_accepted() {
        let owned = segmented_output();
        let mut accepted = Vec::new();
        let mut calls = 0;
        let mut waits = 0;
        drive_fallback(
            &owned,
            |segment| {
                calls += 1;
                assert_eq!(segment.destination, owned.destination);
                assert_eq!(segment.ecn, owned.ecn);
                assert_eq!(segment.src_ip, owned.src_ip);
                assert_eq!(segment.segment_size, None);
                if calls == 2 || calls == 3 {
                    assert_eq!(segment.contents, &[2, 3]);
                    return Err(io::ErrorKind::WouldBlock.into());
                }
                accepted.push(segment.contents.to_vec());
                Ok(())
            },
            || {
                waits += 1;
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(accepted, vec![vec![0, 1], vec![2, 3], vec![4]]);
        assert_eq!(waits, 2);
    }

    #[test]
    fn fallback_hard_error_and_cancelled_wait_stop_without_accepting_suffix() {
        let owned = segmented_output();
        let mut calls = 0;
        let error = drive_fallback(
            &owned,
            |_| {
                calls += 1;
                if calls == 1 {
                    Ok(())
                } else {
                    Err(io::ErrorKind::PermissionDenied.into())
                }
            },
            || panic!("hard error cannot wait"),
        )
        .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        assert_eq!(calls, 2);
        let error = drive_fallback(
            &owned,
            |_| Err(io::ErrorKind::WouldBlock.into()),
            || Err(io::ErrorKind::ConnectionAborted.into()),
        )
        .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::ConnectionAborted);
    }

    #[test]
    fn count_and_byte_credits_cover_pending_storage_and_release_on_drop() {
        let count_budget = OutputBudget::new(2);
        let credits: Vec<_> = (0..4).map(|_| count_budget.reserve(1).unwrap()).collect();
        assert!(
            matches!(count_budget.reserve(1), Err(error) if error.kind() == io::ErrorKind::WouldBlock)
        );
        assert_eq!(*count_budget.usage.lock().unwrap(), (4, 4));
        drop(credits);
        assert_eq!(*count_budget.usage.lock().unwrap(), (0, 0));
        let byte_budget = Arc::new(OutputBudget {
            max_count: 4,
            max_bytes: 5,
            usage: Mutex::new((0, 0)),
        });
        let first = byte_budget.reserve(3).unwrap();
        assert!(
            matches!(byte_budget.reserve(3), Err(error) if error.kind() == io::ErrorKind::WouldBlock)
        );
        let second = byte_budget.reserve(2).unwrap();
        assert_eq!(*byte_budget.usage.lock().unwrap(), (2, 5));
        drop((first, second));
        assert_eq!(*byte_budget.usage.lock().unwrap(), (0, 0));
    }

    fn local_socket() -> (tokio::runtime::Runtime, Arc<BatchedUdpSocket>) {
        use super::*;
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let guard = runtime.enter();
        let raw = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
        raw.set_nonblocking(true).unwrap();
        let inner = wtransport::quinn::Runtime::wrap_udp_socket(
            &wtransport::quinn::TokioRuntime,
            raw.try_clone().unwrap(),
        )
        .unwrap();
        let socket = Arc::new(BatchedUdpSocket::spawn(inner, raw, 2, Duration::ZERO));
        drop(guard);
        (runtime, socket)
    }

    fn controlled_socket<F>(flush: F) -> (tokio::runtime::Runtime, Arc<BatchedUdpSocket>)
    where
        F: Fn(&Backpressure, &[QueuedTransmit]) -> io::Result<()> + Send + 'static,
    {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let guard = runtime.enter();
        let raw = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
        raw.set_nonblocking(true).unwrap();
        let inner = wtransport::quinn::Runtime::wrap_udp_socket(
            &wtransport::quinn::TokioRuntime,
            raw.try_clone().unwrap(),
        )
        .unwrap();
        let (tx, rx) = sync_channel(2);
        let backpressure = Arc::new(Backpressure {
            diagnostics: Some(Component::test_armed("udp-socket")),
            ..Backpressure::default()
        });
        let worker = Arc::clone(&backpressure);
        let flusher = std::thread::spawn(move || {
            run_flusher(rx, 2, Duration::ZERO, &worker, |pending| {
                flush(&worker, pending)
            });
        });
        let socket = Arc::new(BatchedUdpSocket {
            inner,
            direct_socket: raw,
            tx,
            backpressure,
            budget: OutputBudget::new(2),
            flusher: Some(flusher),
        });
        drop(guard);
        (runtime, socket)
    }

    #[test]
    fn quinn_poll_before_send_blocks_full_ring_before_any_peer_hint_is_inspected() {
        let (entered_tx, entered_rx) = sync_channel(1);
        let (_runtime, socket) = controlled_socket(move |control, pending| {
            entered_tx.send(pending.len()).unwrap();
            control.wait_control(Duration::from_secs(2))
        });
        let transmit = segmented_output();
        socket.try_send(&transmit.as_transmit()).unwrap();
        assert_eq!(entered_rx.recv_timeout(Duration::from_secs(1)).unwrap(), 1);
        socket.try_send(&transmit.as_transmit()).unwrap();
        socket.try_send(&transmit.as_transmit()).unwrap();
        assert_eq!(
            socket.try_send(&transmit.as_transmit()).unwrap_err().kind(),
            io::ErrorKind::WouldBlock
        );
        let mut hinted_peer = Arc::clone(&socket).create_io_poller();
        let mut unrelated_peer = Arc::clone(&socket).create_io_poller();
        let mut cx = Context::from_waker(Waker::noop());
        let mut hint_inspections = 0;
        for _ in 0..1000 {
            for poller in [&mut hinted_peer, &mut unrelated_peer] {
                // Quinn 0.11.11 connection.rs:1031 polls before socket.try_send.
                if poller.as_mut().poll_writable(&mut cx).is_ready() {
                    hint_inspections += 1;
                    let _ = socket.try_send(&transmit.as_transmit());
                }
            }
        }
        assert_eq!(
            hint_inspections, 0,
            "no peer may release socket-wide ring pressure"
        );
        assert_eq!(socket.backpressure.wakers.lock().unwrap().len(), 2);
    }

    #[test]
    fn shutdown_while_fallback_waits_joins_and_releases_only_after_terminal_error() {
        let (entered_tx, entered_rx) = sync_channel(1);
        let (_runtime, socket) = controlled_socket(move |control, pending| {
            let entered = std::cell::Cell::new(false);
            drive_fallback(
                &pending[0],
                |_| Err(io::ErrorKind::WouldBlock.into()),
                || {
                    if !entered.replace(true) {
                        entered_tx.send(()).unwrap();
                    }
                    control.wait_control(Duration::from_secs(2))
                },
            )
        });
        let transmit = segmented_output();
        socket.try_send(&transmit.as_transmit()).unwrap();
        entered_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        socket.try_send(&transmit.as_transmit()).unwrap();
        let control = Arc::clone(&socket.backpressure);
        let budget = Arc::clone(&socket.budget);
        assert_eq!(*budget.usage.lock().unwrap(), (2, 10));
        let mut poller = Arc::clone(&socket).create_io_poller();
        control.block(control.generation());
        let counter = Arc::new(WakeCounter(0.into()));
        let waker = Waker::from(Arc::clone(&counter));
        let mut cx = Context::from_waker(&waker);
        assert!(poller.as_mut().poll_writable(&mut cx).is_pending());
        let (closed_tx, closed_rx) = sync_channel(1);
        let closer = std::thread::spawn(move || {
            drop(socket);
            closed_tx.send(()).unwrap();
        });
        closed_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("owned flusher did not join within the shutdown bound");
        closer.join().unwrap();
        assert_eq!(
            control.check().unwrap_err().kind(),
            io::ErrorKind::ConnectionAborted
        );
        assert_eq!(*budget.usage.lock().unwrap(), (0, 0));
        assert_eq!(counter.0.load(Ordering::SeqCst), 1);
        assert!(
            matches!(poller.as_mut().poll_writable(&mut cx), Poll::Ready(Err(error))
            if error.kind() == io::ErrorKind::ConnectionAborted)
        );
        let snap = control.diagnostics.as_ref().unwrap().test_snapshot();
        for index in 1..=3 {
            assert_eq!(snap["gauges"][index]["gauge"]["current"], 0);
        }
    }

    #[test]
    fn dropping_last_socket_from_a_flusher_wakeup_cannot_join_its_own_thread() {
        struct DropSocketOnWake {
            socket: Mutex<Option<Arc<BatchedUdpSocket>>>,
            done: SyncSender<()>,
        }
        impl std::task::Wake for DropSocketOnWake {
            fn wake(self: Arc<Self>) {
                let socket = self.socket.lock().unwrap().take();
                drop(socket);
                self.done.send(()).unwrap();
            }
        }
        let (release_tx, release_rx) = sync_channel(1);
        let (_runtime, socket) = controlled_socket(move |_, _| {
            release_rx.recv_timeout(Duration::from_secs(1)).unwrap();
            Ok(())
        });
        let control = Arc::clone(&socket.backpressure);
        let (done_tx, done_rx) = sync_channel(1);
        let waker = Waker::from(Arc::new(DropSocketOnWake {
            socket: Mutex::new(Some(Arc::clone(&socket))),
            done: done_tx,
        }));
        socket.try_send(&segmented_output().as_transmit()).unwrap();
        control.block(control.generation());
        let mut poller = Arc::clone(&socket).create_io_poller();
        assert!(poller
            .as_mut()
            .poll_writable(&mut Context::from_waker(&waker))
            .is_pending());
        drop(waker);
        drop(socket);
        release_tx.send(()).unwrap();
        done_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("wakeup could not finish socket close");
        assert_eq!(
            control.check().unwrap_err().kind(),
            io::ErrorKind::ConnectionAborted
        );
    }

    #[test]
    fn receive_waker_removal_drops_outside_lock_on_ready_and_terminal_race() {
        struct Probe {
            control: Arc<Backpressure>,
            locked_drops: AtomicU64,
        }
        unsafe fn clone_probe(data: *const ()) -> std::task::RawWaker {
            Arc::increment_strong_count(data.cast::<Probe>());
            std::task::RawWaker::new(data, &VTABLE)
        }
        unsafe fn drop_probe(data: *const ()) {
            let probe = Arc::from_raw(data.cast::<Probe>());
            if probe.control.recv_waker.try_lock().is_err() {
                probe.locked_drops.fetch_add(1, Ordering::SeqCst);
            }
        }
        unsafe fn wake_probe(data: *const ()) {
            drop_probe(data);
        }
        unsafe fn wake_by_ref_probe(_: *const ()) {}
        const VTABLE: std::task::RawWakerVTable =
            std::task::RawWakerVTable::new(clone_probe, wake_probe, wake_by_ref_probe, drop_probe);
        #[derive(Debug)]
        struct ReceiveFixture {
            control: std::sync::Weak<Backpressure>,
            terminal: bool,
        }
        impl AsyncUdpSocket for ReceiveFixture {
            fn create_io_poller(self: Arc<Self>) -> std::pin::Pin<Box<dyn UdpPoller>> {
                Box::pin(RingPoller::new(self.control.upgrade().unwrap()))
            }
            fn try_send(&self, _: &Transmit<'_>) -> io::Result<()> {
                unreachable!()
            }
            fn poll_recv(
                &self,
                _: &mut Context<'_>,
                _: &mut [io::IoSliceMut<'_>],
                _: &mut [RecvMeta],
            ) -> Poll<io::Result<usize>> {
                if self.terminal {
                    // Deterministic publication window before fail() can wake
                    // the receive waiter: poll_recv's recheck owns removal.
                    let control = self.control.upgrade().unwrap();
                    *control.terminal.lock().unwrap() =
                        Some(StoredError::capture(&io::ErrorKind::BrokenPipe.into()));
                    control.failed.store(true, Ordering::Release);
                    Poll::Pending
                } else {
                    Poll::Ready(Ok(0))
                }
            }
            fn local_addr(&self) -> io::Result<SocketAddr> {
                Ok("127.0.0.1:0".parse().unwrap())
            }
        }
        for terminal in [false, true] {
            let (_runtime, mut socket) = local_socket();
            let control = Arc::clone(&socket.backpressure);
            Arc::get_mut(&mut socket).unwrap().inner = Arc::new(ReceiveFixture {
                control: Arc::downgrade(&control),
                terminal,
            });
            let probe = Arc::new(Probe {
                control,
                locked_drops: AtomicU64::new(0),
            });
            let waker = unsafe {
                Waker::from_raw(std::task::RawWaker::new(
                    Arc::into_raw(Arc::clone(&probe)).cast(),
                    &VTABLE,
                ))
            };
            let mut bytes = [0; 8];
            let mut bufs = [io::IoSliceMut::new(&mut bytes)];
            let mut meta = [RecvMeta::default()];
            assert!(socket
                .poll_recv(&mut Context::from_waker(&waker), &mut bufs, &mut meta)
                .is_ready());
            assert_eq!(
                probe.locked_drops.load(Ordering::SeqCst),
                0,
                "receive removal executed a drop callback under its lock (terminal={terminal})"
            );
            assert!(probe.control.recv_waker.lock().unwrap().is_none());
        }
    }

    #[test]
    fn terminal_error_wakes_receive_waiter_and_surfaces_on_all_io_paths() {
        let (_runtime, socket) = local_socket();
        let recv_count = Arc::new(WakeCounter(0.into()));
        let recv_waker = Waker::from(Arc::clone(&recv_count));
        let mut cx = Context::from_waker(&recv_waker);
        let mut bytes = [0; 128];
        let mut bufs = [io::IoSliceMut::new(&mut bytes)];
        let mut meta = [RecvMeta::default()];
        assert!(socket.poll_recv(&mut cx, &mut bufs, &mut meta).is_pending());
        socket
            .backpressure
            .fail(io::ErrorKind::PermissionDenied.into());
        assert_eq!(recv_count.0.load(Ordering::SeqCst), 1);
        socket
            .backpressure
            .fail(io::ErrorKind::ConnectionAborted.into());
        assert_eq!(
            socket
                .try_send(&segmented_output().as_transmit())
                .unwrap_err()
                .kind(),
            io::ErrorKind::PermissionDenied
        );
        let mut poller = Arc::clone(&socket).create_io_poller();
        assert!(
            matches!(poller.as_mut().poll_writable(&mut cx), Poll::Ready(Err(error))
            if error.kind() == io::ErrorKind::PermissionDenied)
        );
        assert!(
            matches!(socket.poll_recv(&mut cx, &mut bufs, &mut meta), Poll::Ready(Err(error))
            if error.kind() == io::ErrorKind::PermissionDenied)
        );
    }

    #[test]
    fn batch_zero_runtime_returns_the_stock_quinn_socket_and_poller() {
        // This test does not mutate process-wide knobs. The native test process
        // starts with the documented default, and other tests pass batch sizes
        // directly to spawn rather than changing the environment.
        assert_eq!(configured_batch(), None);
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let guard = runtime.enter();
        let raw = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
        let socket = wtransport::quinn::Runtime::wrap_udp_socket(
            &BatchedRuntime::new(wtransport::quinn::TokioRuntime),
            raw,
        )
        .unwrap();
        assert!(!format!("{socket:?}").contains("BatchedUdpSocket"));
        let poller = socket.create_io_poller();
        assert!(!format!("{poller:?}").contains("RingPoller"));
        drop(guard);
    }

    #[test]
    fn accepted_hard_failure_is_sticky_on_the_socket() {
        use super::*;
        let (entered_tx, entered_rx) = sync_channel(1);
        let (release_tx, release_rx) = sync_channel(1);
        let (_runtime, socket) = controlled_socket(move |_, pending| {
            assert_eq!(pending.len(), 1);
            entered_tx.send(()).unwrap();
            // Initial ownership transfer must complete before the injected
            // failure; try_send legitimately reports a concurrent failure.
            release_rx.recv_timeout(Duration::from_secs(2)).unwrap();
            Err(io::ErrorKind::PermissionDenied.into())
        });
        let transmit = Transmit {
            destination: "[::1]:1234".parse().unwrap(),
            ecn: None,
            contents: &[1],
            segment_size: None,
            src_ip: None,
        };
        assert!(socket.try_send(&transmit).is_ok());
        entered_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(*socket.budget.usage.lock().unwrap(), (1, 1));
        release_tx.send(()).unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        while !socket.backpressure.failed.load(Ordering::Acquire) {
            assert!(
                Instant::now() < deadline,
                "flusher did not publish the injected failure"
            );
            std::thread::yield_now();
        }
        assert_eq!(
            socket.try_send(&transmit).unwrap_err().kind(),
            io::ErrorKind::PermissionDenied
        );
        while socket.budget.usage.lock().unwrap().0 != 0 {
            assert!(
                Instant::now() < deadline,
                "failed output ownership was not released"
            );
            std::thread::yield_now();
        }
        assert_eq!(*socket.budget.usage.lock().unwrap(), (0, 0));
    }

    #[test]
    fn oversized_transmit_is_rejected_before_ownership_transfer() {
        use super::*;
        let (_runtime, socket) = local_socket();
        // Quinn 0.11.11 limits a transmit to ten u16-sized UDP segments.
        let contents = vec![0; 10 * u16::MAX as usize + 1];
        let error = socket
            .try_send(&Transmit {
                destination: "127.0.0.1:1234".parse().unwrap(),
                ecn: None,
                contents: &contents,
                segment_size: Some(1200),
                src_ip: None,
            })
            .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
    }

    #[test]
    fn repeated_pending_polls_keep_one_owned_registration_and_drop_cancels_it() {
        use super::*;
        let backpressure = Arc::new(Backpressure::default());
        backpressure.block(backpressure.generation());
        let mut poller = Box::pin(RingPoller::new(Arc::clone(&backpressure)));
        let mut cx = Context::from_waker(Waker::noop());
        for _ in 0..100_000 {
            assert!(poller.as_mut().poll_writable(&mut cx).is_pending());
        }
        assert_eq!(backpressure.wakers.lock().unwrap().len(), 1);
        drop(poller);
        assert!(backpressure.wakers.lock().unwrap().is_empty());
    }

    #[test]
    fn disconnected_enqueue_is_a_terminal_error_not_success() {
        use super::*;
        let result = dispatch_priority_or_ring(
            false,
            || panic!("no hint"),
            || RingEnqueue::Disconnected,
            || {},
            || {},
            || {},
        );
        assert_eq!(result.unwrap_err().kind(), io::ErrorKind::BrokenPipe);
    }

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
        assert!(backpressure.poll_writable(0, &mut cx).is_pending());
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
    fn batched_startup_rejects_legacy_drop_mode() {
        for batch in [MIN_BATCH, 64, MAX_BATCH] {
            assert_eq!(
                validate_batch_eagain_mode(Some(batch), SendEagainMode::Drop),
                Err("WEBTRANSPORT_NATIVE_UDP_SEND_EAGAIN_MODE must be wait when WEBTRANSPORT_NATIVE_UDP_SEND_BATCH is enabled, got 'drop'".to_string())
            );
        }
    }

    #[test]
    fn startup_preserves_wait_defaults_and_unbatched_legacy_modes() {
        for raw_mode in [None, Some(""), Some("wait"), Some(" wait ")] {
            let mode = parse_eagain_mode(raw_mode).expect("wait mode");
            for batch in [None, Some(MIN_BATCH), Some(64), Some(MAX_BATCH)] {
                assert_eq!(validate_batch_eagain_mode(batch, mode), Ok(()));
            }
        }
        assert_eq!(
            validate_batch_eagain_mode(None, SendEagainMode::Drop),
            Ok(())
        );
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
            || {
                waits += 1;
                Ok(())
            },
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
            || {
                waits += 1;
                Ok(())
            },
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

        assert!(backpressure.poll_writable(0, &mut cx).is_ready());
        let seen = backpressure.generation();
        backpressure.block(seen);
        assert!(backpressure.poll_writable(0, &mut cx).is_pending());
        assert_eq!(counter.0.load(Ordering::SeqCst), 0);
        backpressure.drained();
        assert_eq!(counter.0.load(Ordering::SeqCst), 1, "parked driver woken");
        assert!(backpressure.poll_writable(0, &mut cx).is_ready());
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
            backpressure.poll_writable(0, &mut cx).is_ready(),
            "stale block on an empty ring must not park drivers"
        );
        let seen = backpressure.generation();
        backpressure.block(seen);
        assert!(backpressure.poll_writable(0, &mut cx).is_pending());
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
        let send_deadline = Instant::now() + Duration::from_secs(5);
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
                        assert!(Instant::now() < send_deadline, "batch send deadline");
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
        assert!(socket.backpressure.check().is_ok());
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
