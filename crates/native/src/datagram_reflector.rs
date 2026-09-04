//! Per-server datagram reflector: match a datagram by byte ranges and answer
//! it in native with a rewritten copy of its first bytes. Protocol-agnostic;
//! the caller expresses its stamp layout as a rule.
//!
//! Matching and reply building still happen on the connection's read task, but
//! the send itself is handed to a single process-wide sender thread through a
//! bounded queue. That keeps a slow `send_datagram` from lengthening the read
//! task, which at 30k sessions let quinn's per-connection receive buffer
//! overflow and silently drop the oldest inbound datagrams.

use napi_derive::napi;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::panic::AssertUnwindSafe;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::time::{Duration, Instant};

pub const MAX_REPLY_LENGTH: u32 = 1200;
pub const MAX_MATCHES: usize = 8;
pub const MAX_OPS: usize = 16;
const PRIORITY_CAPACITY: usize = 50_000;
const PRIORITY_TTL: Duration = Duration::from_secs(1);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ReflectRingBypassMode {
    Off,
    On,
}

impl ReflectRingBypassMode {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::On => "on",
        }
    }
}

pub(crate) fn parse_ring_bypass_mode(raw: Option<&str>) -> Result<ReflectRingBypassMode, String> {
    match raw.map(str::trim) {
        None | Some("") | Some("0") => Ok(ReflectRingBypassMode::Off),
        Some("1") => Ok(ReflectRingBypassMode::On),
        Some(text) => Err(format!(
            "WEBTRANSPORT_NATIVE_REFLECT_RING_BYPASS must be 0 or 1, got '{text}'"
        )),
    }
}

pub(crate) fn configured_ring_bypass_mode() -> ReflectRingBypassMode {
    static RESOLVED: OnceLock<ReflectRingBypassMode> = OnceLock::new();
    *RESOLVED.get_or_init(|| {
        match parse_ring_bypass_mode(
            std::env::var("WEBTRANSPORT_NATIVE_REFLECT_RING_BYPASS")
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PriorityMark {
    Inserted,
    Refreshed,
    Refused,
}

struct PriorityRegistry {
    peers: HashMap<SocketAddr, Instant>,
    capacity: usize,
    ttl: Duration,
    expired: u64,
}

impl PriorityRegistry {
    fn new(capacity: usize, ttl: Duration) -> Self {
        Self {
            peers: HashMap::with_capacity(capacity.min(1024)),
            capacity,
            ttl,
            expired: 0,
        }
    }

    fn prune_expired(&mut self, now: Instant) {
        let before = self.peers.len();
        self.peers
            .retain(|_, marked_at| now.duration_since(*marked_at) <= self.ttl);
        self.expired += (before - self.peers.len()) as u64;
    }

    fn mark_at(&mut self, peer: SocketAddr, now: Instant) -> PriorityMark {
        if let Some(marked_at) = self.peers.get_mut(&peer) {
            *marked_at = now;
            return PriorityMark::Refreshed;
        }
        if self.peers.len() >= self.capacity {
            self.prune_expired(now);
        }
        if self.peers.len() >= self.capacity {
            return PriorityMark::Refused;
        }
        self.peers.insert(peer, now);
        PriorityMark::Inserted
    }

    fn take_at(&mut self, peer: SocketAddr, now: Instant) -> bool {
        match self.peers.remove(&peer) {
            Some(marked_at) if now.duration_since(marked_at) <= self.ttl => true,
            Some(_) => {
                self.expired += 1;
                false
            }
            None => false,
        }
    }

    fn restore_at(&mut self, peer: SocketAddr, now: Instant) -> PriorityMark {
        self.mark_at(peer, now)
    }

    fn cancel(&mut self, peer: SocketAddr) {
        self.peers.remove(&peer);
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct RingBypassStats {
    pub marked: u64,
    pub refreshed: u64,
    pub refused: u64,
    pub expired: u64,
    pub bypassed: u64,
    pub direct_blocked: u64,
    pub direct_errors: u64,
    pub gso_fallback: u64,
}

static PRIORITY_MARKED: AtomicU64 = AtomicU64::new(0);
static PRIORITY_REFRESHED: AtomicU64 = AtomicU64::new(0);
static PRIORITY_REFUSED: AtomicU64 = AtomicU64::new(0);
static PRIORITY_BYPASSED: AtomicU64 = AtomicU64::new(0);
static PRIORITY_DIRECT_BLOCKED: AtomicU64 = AtomicU64::new(0);
static PRIORITY_DIRECT_ERRORS: AtomicU64 = AtomicU64::new(0);
static PRIORITY_GSO_FALLBACK: AtomicU64 = AtomicU64::new(0);

fn priority_registry() -> &'static Mutex<PriorityRegistry> {
    static REGISTRY: OnceLock<Mutex<PriorityRegistry>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(PriorityRegistry::new(PRIORITY_CAPACITY, PRIORITY_TTL)))
}

pub(crate) fn mark_ring_bypass(peer: SocketAddr) {
    if configured_ring_bypass_mode() == ReflectRingBypassMode::Off {
        return;
    }
    let outcome = priority_registry()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .mark_at(peer, Instant::now());
    match outcome {
        PriorityMark::Inserted => PRIORITY_MARKED.fetch_add(1, Ordering::Relaxed),
        PriorityMark::Refreshed => PRIORITY_REFRESHED.fetch_add(1, Ordering::Relaxed),
        PriorityMark::Refused => PRIORITY_REFUSED.fetch_add(1, Ordering::Relaxed),
    };
}

pub(crate) fn take_ring_bypass(peer: SocketAddr) -> bool {
    configured_ring_bypass_mode() == ReflectRingBypassMode::On
        && priority_registry()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take_at(peer, Instant::now())
}

pub(crate) fn restore_ring_bypass(peer: SocketAddr) {
    let _ = priority_registry()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .restore_at(peer, Instant::now());
}

pub(crate) fn cancel_ring_bypass(peer: SocketAddr) {
    if configured_ring_bypass_mode() == ReflectRingBypassMode::Off {
        return;
    }
    priority_registry()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .cancel(peer);
}

pub(crate) fn record_ring_bypassed() {
    PRIORITY_BYPASSED.fetch_add(1, Ordering::Relaxed);
}

pub(crate) fn record_ring_direct_blocked() {
    PRIORITY_DIRECT_BLOCKED.fetch_add(1, Ordering::Relaxed);
}

pub(crate) fn record_ring_direct_error() {
    PRIORITY_DIRECT_ERRORS.fetch_add(1, Ordering::Relaxed);
}

pub(crate) fn record_ring_gso_fallback() {
    PRIORITY_GSO_FALLBACK.fetch_add(1, Ordering::Relaxed);
}

pub(crate) fn ring_bypass_stats() -> RingBypassStats {
    let expired = priority_registry()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .expired;
    RingBypassStats {
        marked: PRIORITY_MARKED.load(Ordering::Relaxed),
        refreshed: PRIORITY_REFRESHED.load(Ordering::Relaxed),
        refused: PRIORITY_REFUSED.load(Ordering::Relaxed),
        expired,
        bypassed: PRIORITY_BYPASSED.load(Ordering::Relaxed),
        direct_blocked: PRIORITY_DIRECT_BLOCKED.load(Ordering::Relaxed),
        direct_errors: PRIORITY_DIRECT_ERRORS.load(Ordering::Relaxed),
        gso_fallback: PRIORITY_GSO_FALLBACK.load(Ordering::Relaxed),
    }
}

/// One equality check: the datagram bytes at `offset` must equal `bytes`.
#[napi(object)]
pub struct ReflectorMatchInput {
    pub offset: u32,
    pub bytes: Vec<u8>,
}

/// One rewrite. `op` selects which of the optional fields are read:
/// `copy` uses `from`, `to`, `length`; `nowNs` and `holdNs` use `at`;
/// `zero` uses `at`, `length`; `set` uses `at`, `value`.
#[napi(object)]
pub struct ReflectorOpInput {
    pub op: String,
    pub at: Option<u32>,
    pub from: Option<u32>,
    pub to: Option<u32>,
    pub length: Option<u32>,
    pub value: Option<u32>,
}

#[napi(object)]
pub struct DatagramReflectorRuleInput {
    pub min_length: u32,
    pub reply_length: u32,
    pub matches: Vec<ReflectorMatchInput>,
    pub rewrite: Vec<ReflectorOpInput>,
}

#[derive(Debug)]
pub enum RuleError {
    /// Wrong shape: unknown op, missing field, empty or oversized lists.
    Shape(String),
    /// Right shape, out-of-bound offsets, lengths, or values.
    Range(String),
}

impl RuleError {
    pub fn message(&self) -> &str {
        match self {
            RuleError::Shape(m) | RuleError::Range(m) => m,
        }
    }
}

#[derive(Debug, Clone)]
enum Op {
    Copy {
        from: usize,
        to: usize,
        length: usize,
    },
    NowNs {
        at: usize,
    },
    HoldNs {
        at: usize,
    },
    Zero {
        at: usize,
        length: usize,
    },
    Set {
        at: usize,
        value: u8,
    },
}

#[derive(Debug, Clone)]
struct Match {
    offset: usize,
    bytes: Vec<u8>,
}

/// A rule whose every offset has been checked against `reply_length` and
/// `min_length`, so `matches` and `apply` index without bounds checks.
#[derive(Debug, Clone)]
pub struct CompiledRule {
    min_length: usize,
    reply_length: usize,
    matches: Vec<Match>,
    ops: Vec<Op>,
}

fn range_in(
    label: &str,
    start: u32,
    length: u32,
    bound: usize,
) -> Result<(usize, usize), RuleError> {
    let start = start as usize;
    let length = length as usize;
    if length == 0 {
        return Err(RuleError::Range(format!(
            "{label} length must be at least 1"
        )));
    }
    match start.checked_add(length) {
        Some(end) if end <= bound => Ok((start, length)),
        _ => Err(RuleError::Range(format!(
            "{label} range {start}..{} exceeds {bound}",
            start.saturating_add(length)
        ))),
    }
}

fn required(field: Option<u32>, op: &str, name: &str) -> Result<u32, RuleError> {
    field.ok_or_else(|| RuleError::Shape(format!("op {op} requires {name}")))
}

pub fn compile(input: &DatagramReflectorRuleInput) -> Result<CompiledRule, RuleError> {
    if input.reply_length == 0 {
        return Err(RuleError::Range(
            "replyLength must be at least 1".to_string(),
        ));
    }
    if input.reply_length > input.min_length {
        return Err(RuleError::Range(
            "replyLength must not exceed minLength".to_string(),
        ));
    }
    if input.min_length > MAX_REPLY_LENGTH {
        return Err(RuleError::Range(format!(
            "minLength must not exceed {MAX_REPLY_LENGTH}"
        )));
    }
    if input.matches.is_empty() || input.matches.len() > MAX_MATCHES {
        return Err(RuleError::Shape(format!(
            "match needs 1..={MAX_MATCHES} entries"
        )));
    }
    if input.rewrite.len() > MAX_OPS {
        return Err(RuleError::Shape(format!(
            "rewrite allows at most {MAX_OPS} ops"
        )));
    }
    let min_length = input.min_length as usize;
    let reply_length = input.reply_length as usize;
    let mut matches = Vec::with_capacity(input.matches.len());
    for m in &input.matches {
        let (offset, _) = range_in("match", m.offset, m.bytes.len() as u32, min_length)?;
        matches.push(Match {
            offset,
            bytes: m.bytes.clone(),
        });
    }
    let mut ops = Vec::with_capacity(input.rewrite.len());
    for op in &input.rewrite {
        let compiled = match op.op.as_str() {
            "copy" => {
                let length = required(op.length, "copy", "length")?;
                let (from, _) = range_in(
                    "copy.from",
                    required(op.from, "copy", "from")?,
                    length,
                    reply_length,
                )?;
                let (to, length) = range_in(
                    "copy.to",
                    required(op.to, "copy", "to")?,
                    length,
                    reply_length,
                )?;
                Op::Copy { from, to, length }
            }
            "nowNs" => {
                let (at, _) = range_in("nowNs", required(op.at, "nowNs", "at")?, 8, reply_length)?;
                Op::NowNs { at }
            }
            "holdNs" => {
                let (at, _) =
                    range_in("holdNs", required(op.at, "holdNs", "at")?, 8, reply_length)?;
                Op::HoldNs { at }
            }
            "zero" => {
                let (at, length) = range_in(
                    "zero",
                    required(op.at, "zero", "at")?,
                    required(op.length, "zero", "length")?,
                    reply_length,
                )?;
                Op::Zero { at, length }
            }
            "set" => {
                let value = required(op.value, "set", "value")?;
                if value > 255 {
                    return Err(RuleError::Range("set.value must be 0..=255".to_string()));
                }
                let (at, _) = range_in("set", required(op.at, "set", "at")?, 1, reply_length)?;
                Op::Set {
                    at,
                    value: value as u8,
                }
            }
            other => return Err(RuleError::Shape(format!("unknown op {other}"))),
        };
        ops.push(compiled);
    }
    Ok(CompiledRule {
        min_length,
        reply_length,
        matches,
        ops,
    })
}

impl CompiledRule {
    pub fn reply_length(&self) -> usize {
        self.reply_length
    }

    pub fn matches(&self, datagram: &[u8]) -> bool {
        if datagram.len() < self.min_length {
            return false;
        }
        self.matches
            .iter()
            .all(|m| &datagram[m.offset..m.offset + m.bytes.len()] == m.bytes.as_slice())
    }

    /// Build the reply: the datagram's first `reply_length` bytes with the ops
    /// applied in order. The caller guarantees `matches` returned true.
    pub fn apply(&self, datagram: &[u8], now_ns: u64, hold_ns: u64) -> Vec<u8> {
        let mut reply = datagram[..self.reply_length].to_vec();
        for op in &self.ops {
            match *op {
                Op::Copy { from, to, length } => reply.copy_within(from..from + length, to),
                Op::NowNs { at } => reply[at..at + 8].copy_from_slice(&now_ns.to_le_bytes()),
                Op::HoldNs { at } => reply[at..at + 8].copy_from_slice(&hold_ns.to_le_bytes()),
                Op::Zero { at, length } => reply[at..at + length].fill(0),
                Op::Set { at, value } => reply[at] = value,
            }
        }
        reply
    }
}

/// Monotonic nanoseconds since this process's reflector origin, which is
/// established no later than the first `set_rule`. The client never compares
/// this clock with its own; it is written for the peer's one-way estimates and
/// must only be monotonic. Anchoring the origin at rule installation rather
/// than at the first reflected datagram keeps the very first reply from
/// carrying a zero instant.
pub fn monotonic_ns() -> u64 {
    static ORIGIN: OnceLock<std::time::Instant> = OnceLock::new();
    let origin = ORIGIN.get_or_init(std::time::Instant::now);
    origin.elapsed().as_nanos().min(u64::MAX as u128) as u64
}

pub fn reason_for(
    error: &wtransport::error::SendDatagramError,
) -> crate::server_metrics::ReflectSendErrorReason {
    use crate::server_metrics::ReflectSendErrorReason as R;
    match error {
        wtransport::error::SendDatagramError::NotConnected => R::NotConnected,
        wtransport::error::SendDatagramError::UnsupportedByPeer => R::UnsupportedByPeer,
        wtransport::error::SendDatagramError::TooLarge => R::TooLarge,
    }
}

/// One reflected send, already built by the read task: running it performs the
/// `send_datagram` and records the metrics.
pub type ReflectJob = Box<dyn FnOnce() + Send + 'static>;

/// Depth of the queue between the read tasks and the sender thread. Full means
/// the sender cannot keep up; the reply is dropped rather than queued forever.
const REFLECT_QUEUE_CAPACITY: usize = 65_536;

/// Why a reflected send could not be handed to the sender thread. Either way
/// the reply is dropped, never retried.
#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub enum ReflectQueueError {
    /// The sender thread is behind by a full queue.
    Full,
    /// The sender thread is gone. Unreachable while the queue lives in a
    /// process-global `OnceLock` and the drain loop catches job panics.
    Disconnected,
}

/// The producer half of the reflect sender queue.
struct ReflectQueue {
    tx: SyncSender<ReflectJob>,
}

impl ReflectQueue {
    /// The queue without its draining thread; the caller owns the receiver.
    fn detached(capacity: usize) -> (Self, Receiver<ReflectJob>) {
        let (tx, rx) = sync_channel(capacity);
        (Self { tx }, rx)
    }

    fn spawn(capacity: usize) -> Self {
        let (queue, rx) = Self::detached(capacity);
        std::thread::Builder::new()
            .name("wt-reflect-sender".to_string())
            .spawn(move || {
                for job in rx {
                    // One panicking reply must not silence every later one.
                    if std::panic::catch_unwind(AssertUnwindSafe(job)).is_err() {
                        static REPORTED: std::sync::Once = std::sync::Once::new();
                        REPORTED.call_once(|| {
                            eprintln!(
                                "webtransport-native: a reflected datagram send panicked; \
                                 the reply was dropped and the sender thread keeps draining"
                            );
                        });
                    }
                }
            })
            .expect("spawn wt-reflect-sender thread");
        queue
    }

    fn enqueue(&self, job: ReflectJob) -> Result<(), ReflectQueueError> {
        self.tx.try_send(job).map_err(|error| match error {
            TrySendError::Full(_) => ReflectQueueError::Full,
            TrySendError::Disconnected(_) => ReflectQueueError::Disconnected,
        })
    }
}

/// Started on the first reflected datagram, so a process with no rule installed
/// never pays for the thread.
fn sender() -> &'static ReflectQueue {
    static SENDER: OnceLock<ReflectQueue> = OnceLock::new();
    SENDER.get_or_init(|| ReflectQueue::spawn(REFLECT_QUEUE_CAPACITY))
}

/// Hand one reflected send to the sender thread. On `Err` the caller must drop
/// the reply.
pub fn enqueue(job: ReflectJob) -> Result<(), ReflectQueueError> {
    sender().enqueue(job)
}

fn store() -> &'static RwLock<HashMap<u64, Arc<CompiledRule>>> {
    static STORE: OnceLock<RwLock<HashMap<u64, Arc<CompiledRule>>>> = OnceLock::new();
    STORE.get_or_init(|| RwLock::new(HashMap::new()))
}

/// Number of owners that currently have a rule. Read on the datagram hot path
/// so a process with no reflector installed pays one relaxed load instead of a
/// process-global `RwLock` read plus a `HashMap` lookup on every datagram.
static INSTALLED: AtomicUsize = AtomicUsize::new(0);

/// True when at least one server has a rule installed. Cheap enough to guard
/// the hot path with.
#[inline]
pub fn any_installed() -> bool {
    INSTALLED.load(Ordering::Relaxed) > 0
}

pub fn set_rule(owner_server_id: u64, rule: Option<Arc<CompiledRule>>) {
    let _ = monotonic_ns();
    let mut map = store()
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    match rule {
        Some(rule) => {
            if map.insert(owner_server_id, rule).is_none() {
                INSTALLED.fetch_add(1, Ordering::Relaxed);
            }
        }
        None => {
            if map.remove(&owner_server_id).is_some() {
                INSTALLED.fetch_sub(1, Ordering::Relaxed);
            }
        }
    }
}

pub fn rule_for(owner_server_id: u64) -> Option<Arc<CompiledRule>> {
    let map = store()
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    map.get(&owner_server_id).cloned()
}

pub fn clear_owner(owner_server_id: u64) {
    set_rule(owner_server_id, None);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::SocketAddr;
    use std::time::{Duration, Instant};

    #[test]
    fn parses_reflect_ring_bypass_mode_fail_closed() {
        assert_eq!(parse_ring_bypass_mode(None), Ok(ReflectRingBypassMode::Off));
        assert_eq!(
            parse_ring_bypass_mode(Some("")),
            Ok(ReflectRingBypassMode::Off)
        );
        assert_eq!(
            parse_ring_bypass_mode(Some("0")),
            Ok(ReflectRingBypassMode::Off)
        );
        assert_eq!(
            parse_ring_bypass_mode(Some("1")),
            Ok(ReflectRingBypassMode::On)
        );
        assert!(parse_ring_bypass_mode(Some("on")).is_err());
        assert!(parse_ring_bypass_mode(Some("true")).is_err());
    }

    #[test]
    fn priority_registry_is_bounded_single_use_and_expiring() {
        let now = Instant::now();
        let a: SocketAddr = "127.0.0.1:1001".parse().unwrap();
        let b: SocketAddr = "127.0.0.1:1002".parse().unwrap();
        let mut registry = PriorityRegistry::new(1, Duration::from_millis(10));

        assert_eq!(registry.mark_at(a, now), PriorityMark::Inserted);
        assert_eq!(registry.mark_at(a, now), PriorityMark::Refreshed);
        assert_eq!(registry.mark_at(b, now), PriorityMark::Refused);
        assert!(!registry.take_at(b, now));
        assert!(registry.take_at(a, now));
        assert!(!registry.take_at(a, now));

        assert_eq!(registry.mark_at(a, now), PriorityMark::Inserted);
        assert!(!registry.take_at(a, now + Duration::from_millis(11)));
        assert_eq!(registry.expired, 1);
    }

    #[test]
    fn priority_registry_restores_only_the_consumed_peer() {
        let now = Instant::now();
        let a: SocketAddr = "127.0.0.1:2001".parse().unwrap();
        let b: SocketAddr = "127.0.0.1:2002".parse().unwrap();
        let mut registry = PriorityRegistry::new(2, Duration::from_secs(1));
        assert_eq!(registry.mark_at(a, now), PriorityMark::Inserted);
        assert!(registry.take_at(a, now));
        assert!(!registry.take_at(b, now));
        assert_eq!(registry.restore_at(a, now), PriorityMark::Inserted);
        assert!(registry.take_at(a, now));
    }

    #[test]
    fn priority_registry_is_peer_isolated_and_cancels_failed_reflections() {
        let now = Instant::now();
        let a: SocketAddr = "127.0.0.1:3001".parse().unwrap();
        let b: SocketAddr = "127.0.0.1:3002".parse().unwrap();
        let mut registry = PriorityRegistry::new(2, Duration::from_secs(1));
        assert_eq!(registry.mark_at(a, now), PriorityMark::Inserted);
        assert!(
            !registry.take_at(b, now),
            "another peer cannot consume a's token"
        );
        registry.cancel(a);
        assert!(
            !registry.take_at(a, now),
            "failed reflection leaves no live token"
        );
    }

    fn g6_rule() -> DatagramReflectorRuleInput {
        DatagramReflectorRuleInput {
            min_length: 48,
            reply_length: 48,
            matches: vec![
                ReflectorMatchInput {
                    offset: 0,
                    bytes: vec![0x54, 0x4c],
                },
                ReflectorMatchInput {
                    offset: 2,
                    bytes: vec![3, 0],
                },
                ReflectorMatchInput {
                    offset: 44,
                    bytes: vec![1],
                },
            ],
            rewrite: vec![
                op("copy", None, Some(12), Some(28), Some(8), None),
                op("zero", Some(4), None, None, Some(8), None),
                op("nowNs", Some(12), None, None, None, None),
                op("holdNs", Some(36), None, None, None, None),
                op("set", Some(44), None, None, None, Some(2)),
            ],
        }
    }

    fn op(
        name: &str,
        at: Option<u32>,
        from: Option<u32>,
        to: Option<u32>,
        length: Option<u32>,
        value: Option<u32>,
    ) -> ReflectorOpInput {
        ReflectorOpInput {
            op: name.to_string(),
            at,
            from,
            to,
            length,
            value,
        }
    }

    /// A version-3 action stamp exactly as tools/load/latency-stamp.ts writes it.
    fn action_stamp(intended: u64, actual: u64, sequence: u64) -> Vec<u8> {
        let mut bytes = vec![0u8; 64];
        bytes[0..2].copy_from_slice(&0x4c54u16.to_le_bytes());
        bytes[2..4].copy_from_slice(&3u16.to_le_bytes());
        bytes[4..12].copy_from_slice(&intended.to_le_bytes());
        bytes[12..20].copy_from_slice(&actual.to_le_bytes());
        bytes[20..28].copy_from_slice(&sequence.to_le_bytes());
        bytes[44] = 1;
        bytes
    }

    /// The reflected ack exactly as crates/reference/src/g6_protocol.rs
    /// `encode_reflected_ack(echo_actual_ns, server_send_ns, hold_ns, sequence)`
    /// lays it out: version 3, intended 0, actual = server send, sequence kept,
    /// echoActual at 28, hold at 36, class 2 at 44.
    fn expected_ack(echo_actual: u64, server_send: u64, hold: u64, sequence: u64) -> Vec<u8> {
        let mut bytes = vec![0u8; 48];
        bytes[0..2].copy_from_slice(&0x4c54u16.to_le_bytes());
        bytes[2..4].copy_from_slice(&3u16.to_le_bytes());
        bytes[12..20].copy_from_slice(&server_send.to_le_bytes());
        bytes[20..28].copy_from_slice(&sequence.to_le_bytes());
        bytes[28..36].copy_from_slice(&echo_actual.to_le_bytes());
        bytes[36..44].copy_from_slice(&hold.to_le_bytes());
        bytes[44] = 2;
        bytes
    }

    #[test]
    fn g6_rule_reproduces_the_reference_reflected_ack_byte_for_byte() {
        let rule = compile(&g6_rule()).expect("valid rule");
        let datagram = action_stamp(10, 20, 30);
        assert!(rule.matches(&datagram));
        let reply = rule.apply(&datagram, 125, 35);
        assert_eq!(reply, expected_ack(20, 125, 35, 30));
    }

    #[test]
    fn non_matching_datagrams_are_not_reflected() {
        let rule = compile(&g6_rule()).expect("valid rule");
        let mut snapshot_class = action_stamp(1, 2, 3);
        snapshot_class[44] = 3;
        assert!(!rule.matches(&snapshot_class));
        let mut wrong_magic = action_stamp(1, 2, 3);
        wrong_magic[0] = 0;
        assert!(!rule.matches(&wrong_magic));
        assert!(!rule.matches(&action_stamp(1, 2, 3)[..47]));
        assert!(!rule.matches(&[]));
    }

    #[test]
    fn reply_is_exactly_reply_length_bytes() {
        let rule = compile(&g6_rule()).expect("valid rule");
        let reply = rule.apply(&action_stamp(1, 2, 3), 0, 0);
        assert_eq!(reply.len(), 48);
    }

    #[test]
    fn validation_refuses_every_out_of_bound_shape() {
        let mut bad_reply_len = g6_rule();
        bad_reply_len.reply_length = 49;
        assert!(matches!(compile(&bad_reply_len), Err(RuleError::Range(_))));

        let mut zero_reply = g6_rule();
        zero_reply.reply_length = 0;
        assert!(matches!(compile(&zero_reply), Err(RuleError::Range(_))));

        let mut too_long = g6_rule();
        too_long.min_length = MAX_REPLY_LENGTH + 1;
        too_long.reply_length = MAX_REPLY_LENGTH + 1;
        assert!(matches!(compile(&too_long), Err(RuleError::Range(_))));

        let mut match_past_min = g6_rule();
        match_past_min.matches.push(ReflectorMatchInput {
            offset: 47,
            bytes: vec![1, 2],
        });
        assert!(matches!(compile(&match_past_min), Err(RuleError::Range(_))));

        let mut empty_match = g6_rule();
        empty_match.matches.clear();
        assert!(matches!(compile(&empty_match), Err(RuleError::Shape(_))));

        let mut too_many_matches = g6_rule();
        for _ in 0..MAX_MATCHES {
            too_many_matches.matches.push(ReflectorMatchInput {
                offset: 0,
                bytes: vec![0x54],
            });
        }
        assert!(matches!(
            compile(&too_many_matches),
            Err(RuleError::Shape(_))
        ));

        let mut op_past_reply = g6_rule();
        op_past_reply
            .rewrite
            .push(op("nowNs", Some(41), None, None, None, None));
        assert!(matches!(compile(&op_past_reply), Err(RuleError::Range(_))));

        let mut copy_past_reply = g6_rule();
        copy_past_reply
            .rewrite
            .push(op("copy", None, Some(44), Some(0), Some(8), None));
        assert!(matches!(
            compile(&copy_past_reply),
            Err(RuleError::Range(_))
        ));

        let mut zero_length_copy = g6_rule();
        zero_length_copy
            .rewrite
            .push(op("copy", None, Some(0), Some(8), Some(0), None));
        assert!(matches!(
            compile(&zero_length_copy),
            Err(RuleError::Range(_))
        ));

        let mut bad_value = g6_rule();
        bad_value
            .rewrite
            .push(op("set", Some(0), None, None, None, Some(256)));
        assert!(matches!(compile(&bad_value), Err(RuleError::Range(_))));

        let mut unknown_op = g6_rule();
        unknown_op
            .rewrite
            .push(op("xor", Some(0), None, None, None, Some(1)));
        assert!(matches!(compile(&unknown_op), Err(RuleError::Shape(_))));

        let mut missing_field = g6_rule();
        missing_field
            .rewrite
            .push(op("set", Some(0), None, None, None, None));
        assert!(matches!(compile(&missing_field), Err(RuleError::Shape(_))));

        let mut too_many_ops = g6_rule();
        for _ in 0..MAX_OPS {
            too_many_ops
                .rewrite
                .push(op("set", Some(0), None, None, None, Some(0)));
        }
        assert!(matches!(compile(&too_many_ops), Err(RuleError::Shape(_))));
    }

    #[test]
    fn overlapping_copy_behaves_like_memmove() {
        let input = DatagramReflectorRuleInput {
            min_length: 8,
            reply_length: 8,
            matches: vec![ReflectorMatchInput {
                offset: 0,
                bytes: vec![1],
            }],
            rewrite: vec![op("copy", None, Some(0), Some(2), Some(4), None)],
        };
        let rule = compile(&input).expect("valid rule");
        let reply = rule.apply(&[1, 2, 3, 4, 5, 6, 7, 8], 0, 0);
        assert_eq!(reply, vec![1, 2, 1, 2, 3, 4, 7, 8]);
    }

    /// The rule store and the `INSTALLED` counter are process-global, so the
    /// tests that mutate them must not interleave.
    fn store_guard() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    #[test]
    fn installed_tracks_owners_with_a_rule() {
        let _guard = store_guard();
        let rule = Arc::new(compile(&g6_rule()).expect("valid rule"));
        assert!(!any_installed());
        set_rule(8001, Some(Arc::clone(&rule)));
        assert!(any_installed());
        // Replacing an existing owner's rule leaves the count unchanged.
        set_rule(8001, Some(Arc::clone(&rule)));
        assert!(any_installed());
        set_rule(8002, Some(Arc::clone(&rule)));
        clear_owner(8002);
        assert!(any_installed());
        // Clearing an owner that never had a rule must not underflow.
        clear_owner(8003);
        assert!(any_installed());
        clear_owner(8001);
        assert!(!any_installed());
        clear_owner(8004);
        assert!(!any_installed());
    }

    #[test]
    fn enqueue_refuses_once_the_queue_is_full() {
        let (queue, _rx) = ReflectQueue::detached(2);
        assert!(queue.enqueue(Box::new(|| {})).is_ok());
        assert!(queue.enqueue(Box::new(|| {})).is_ok());
        assert_eq!(queue.enqueue(Box::new(|| {})), Err(ReflectQueueError::Full));
    }

    #[test]
    fn a_panicking_job_does_not_stop_later_jobs() {
        let queue = ReflectQueue::spawn(4);
        let (done_tx, done_rx) = std::sync::mpsc::channel::<u8>();
        queue
            .enqueue(Box::new(|| panic!("reflected send blew up")))
            .expect("queue has room");
        queue
            .enqueue(Box::new(move || {
                let _ = done_tx.send(7);
            }))
            .expect("queue has room");
        assert_eq!(
            done_rx
                .recv_timeout(std::time::Duration::from_secs(5))
                .expect("the job after the panic still runs"),
            7
        );
    }

    #[test]
    fn queued_jobs_reach_the_drain_in_order() {
        let queue = ReflectQueue::spawn(8);
        let (done_tx, done_rx) = std::sync::mpsc::channel::<u8>();
        for n in 0..4u8 {
            let done_tx = done_tx.clone();
            queue
                .enqueue(Box::new(move || {
                    let _ = done_tx.send(n);
                }))
                .expect("queue has room");
        }
        drop(done_tx);
        let seen: Vec<u8> = done_rx.iter().collect();
        assert_eq!(seen, vec![0, 1, 2, 3]);
    }

    #[test]
    fn store_is_per_owner_and_clearable() {
        let _guard = store_guard();
        let rule = Arc::new(compile(&g6_rule()).expect("valid rule"));
        set_rule(7001, Some(Arc::clone(&rule)));
        assert!(rule_for(7001).is_some());
        assert!(rule_for(7002).is_none());
        set_rule(7001, None);
        assert!(rule_for(7001).is_none());
        set_rule(7003, Some(rule));
        clear_owner(7003);
        assert!(rule_for(7003).is_none());
    }
}
