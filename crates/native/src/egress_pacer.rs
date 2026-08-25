//! Smooth egress pacing for the mirror fan-out — prototype, knob-gated, off by
//! default.
//!
//! The design and the measurements behind it are in `crates/native/docs/egress-pacer.md`.
//! In one paragraph: the fan-out loop in `session.rs` hands the kernel an
//! N-packet train in a few hundred microseconds, and the measured path sheds
//! above ~100 k pps instantaneous while taking a smooth 75 k pps whole. This
//! module spreads that train over an earliest-departure-time schedule — one
//! continuous schedule per server, one departure timestamp per clump, a clump
//! sized to be one GSO super-buffer — on a dedicated OS thread, so the JS thread
//! pays only the submission.
//!
//! Nothing here reimplements a send: the pacer thread calls the same
//! `try_send_datagram_on_state` the inline loop does.

use std::collections::{BTreeMap, VecDeque};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::json;

use crate::datagram_mirror::MirrorOutcome;
use crate::session::WOULD_BLOCK;

/// Largest clump the schedule will pace as one unit.
///
/// quinn coalesces at most 64 segments into one GSO super-buffer. A clump above
/// that spans more than one `sendmsg` and the pacer would be pacing something
/// other than the burst unit it thinks it is.
const CLUMP_MAX: usize = 64;

/// Datagrams per burst unit when `WEBTRANSPORT_PACER_CLUMP` is unset.
const CLUMP_DEFAULT: usize = 32;

/// Milliseconds of scheduled work the admission bound allows by default.
const QUEUE_MS_DEFAULT: u64 = 250;

/// How many clumps of lateness the schedule will pay back at once before it
/// gives up on the debt and restarts the cadence at `now`.
///
/// Measured in clumps, not in wall time, and small. A wall-time horizon looks
/// harmless and is not: at the target shape a 200 ms horizon lets a descheduled
/// pacer settle its debt as ~468 back-to-back clumps — 15 000 packets with no
/// spacing, which is precisely the train the pacer exists to remove, arriving
/// under the name of catch-up. The first microbench run on this branch showed
/// it directly (p1 spacing 292 ns after a 13 ms stall).
///
/// The trade this makes is deliberate: a stalled pacer loses the packets it did
/// not send rather than bursting them. For a pacer the rate is a ceiling, not a
/// quota, and `scheduleResets` counts every time the choice was made.
const CATCHUP_CLUMPS: u32 = 2;

/// How long the pacer thread waits on an empty queue before exiting.
const IDLE_EXIT: Duration = Duration::from_secs(5);

/// Sleep stops this far short of a departure time and the rest is spun.
///
/// `thread::sleep` granularity is ~50–100 µs on both target platforms, which at
/// a 427 µs cadence would land directly in the inter-clump jitter the residual
/// 5 % loss was attributed to.
const SPIN_SLACK: Duration = Duration::from_micros(150);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct PacerConfig {
    pub(crate) pps: u64,
    pub(crate) clump: usize,
    pub(crate) queue_ms: u64,
}

impl PacerConfig {
    /// Datagrams the queue may hold before admission starts refusing.
    ///
    /// The knob is named in milliseconds but the bound is a **target count**,
    /// and the conversion uses the *configured* rate. So `queue_ms` is the time
    /// a full queue represents only while the pacer achieves `pps`: at half the
    /// achieved rate the same 18 750 targets are 500 ms of work, not 250. Read
    /// `queue_ms` as "milliseconds at the configured rate", and read the real
    /// queue latency off the windowed stats as `pendingTargets ÷ achieved pps`
    /// (`window.clumps × clump ÷ window seconds`).
    ///
    /// The bound is not a latency guarantee and cannot become one without
    /// timestamping admissions, which would put a clock read on the JS thread's
    /// per-target path to bound something the drain already bounds.
    fn max_pending(&self) -> u64 {
        // At least one clump, whatever the arithmetic says: a bound that admits
        // nothing would turn the knob into a black hole.
        (self.pps.saturating_mul(self.queue_ms) / 1_000).max(self.clump as u64)
    }

    fn interval(&self) -> Duration {
        Duration::from_nanos(
            (self.clump as u64)
                .saturating_mul(1_000_000_000)
                .checked_div(self.pps)
                .unwrap_or(0)
                .max(1),
        )
    }
}

/// Read the knobs once. `None` means the pacer is off and the mirror send runs
/// its inline loop unchanged.
///
/// Every malformed or out-of-range value is clamped or read as off. This path
/// must never throw: it runs inside a synchronous N-API method whose whole
/// contract is that it does not.
pub(crate) fn config() -> Option<&'static PacerConfig> {
    static CONFIG: OnceLock<Option<PacerConfig>> = OnceLock::new();
    CONFIG
        .get_or_init(|| {
            let pps = env_u64("WEBTRANSPORT_PACER_PPS").unwrap_or(0);
            if pps == 0 {
                return None;
            }
            Some(PacerConfig {
                pps,
                clump: env_u64("WEBTRANSPORT_PACER_CLUMP")
                    .map(|v| (v as usize).clamp(1, CLUMP_MAX))
                    .unwrap_or(CLUMP_DEFAULT),
                queue_ms: env_u64("WEBTRANSPORT_PACER_QUEUE_MS")
                    .unwrap_or(QUEUE_MS_DEFAULT)
                    .max(1),
            })
        })
        .as_ref()
}

fn env_u64(name: &str) -> Option<u64> {
    std::env::var(name).ok()?.trim().parse::<u64>().ok()
}

/// Scheduling priority the pacer thread should ask the kernel for.
///
/// Both knobs default to unset, which is today's behaviour: no syscall is made
/// and the thread runs at whatever the runtime gave it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct PriorityRequest {
    /// `WEBTRANSPORT_PACER_NICE`, clamped to the portable `-20..=19`.
    nice: Option<i32>,
    /// `WEBTRANSPORT_PACER_SCHED=rr:<prio>`, clamped to `1..=99`.
    rr_priority: Option<i32>,
    /// A knob was set to something neither form could be read from. Disclosed
    /// rather than defaulted, so a typo in a sweep cell is visible in the
    /// artifact instead of quietly producing a nice-level run.
    malformed: bool,
}

/// Read both priority knobs. Pure, so the parse rules are testable without the
/// process-wide memoization `priority_request` adds.
pub(crate) fn parse_priority(nice: Option<&str>, sched: Option<&str>) -> PriorityRequest {
    let mut request = PriorityRequest::default();
    if let Some(raw) = nice {
        match raw.trim().parse::<i32>() {
            Ok(value) => request.nice = Some(value.clamp(-20, 19)),
            Err(_) => request.malformed = true,
        }
    }
    if let Some(raw) = sched {
        match raw.trim().to_ascii_lowercase().strip_prefix("rr:") {
            Some(prio) => match prio.trim().parse::<i32>() {
                Ok(value) => request.rr_priority = Some(value.clamp(1, 99)),
                Err(_) => request.malformed = true,
            },
            None => request.malformed = true,
        }
    }
    request
}

fn priority_request() -> &'static PriorityRequest {
    static REQUEST: OnceLock<PriorityRequest> = OnceLock::new();
    REQUEST.get_or_init(|| {
        parse_priority(
            std::env::var("WEBTRANSPORT_PACER_NICE").ok().as_deref(),
            std::env::var("WEBTRANSPORT_PACER_SCHED").ok().as_deref(),
        )
    })
}

/// What the kernel says the pacer thread actually got, read back after the
/// calls rather than inferred from them.
///
/// Every field here is an answer to `sched_getscheduler`/`getpriority`, so a
/// `setpriority` that failed for want of `CAP_SYS_NICE` shows the level the
/// thread is really running at and an errno beside it. A failed call is
/// disclosed as the fallback it produced; it is never reported as the level
/// that was asked for.
#[derive(Debug, Clone, Copy, Default)]
struct PriorityAchieved {
    policy: &'static str,
    rt_priority: i32,
    nice: Option<i32>,
    nice_errno: Option<i32>,
    sched_errno: Option<i32>,
    /// Value of `threadStarts` when this was recorded, so a reader can tell
    /// which pacer thread the disclosure belongs to.
    at_thread_start: u64,
}

fn priority_achieved() -> &'static Mutex<Option<PriorityAchieved>> {
    static ACHIEVED: OnceLock<Mutex<Option<PriorityAchieved>>> = OnceLock::new();
    ACHIEVED.get_or_init(|| Mutex::new(None))
}

fn priority_json() -> serde_json::Value {
    let request = priority_request();
    let achieved = priority_achieved()
        .lock()
        .ok()
        .and_then(|slot| *slot)
        .map(|a| {
            json!({
                "policy": a.policy,
                "rtPriority": a.rt_priority,
                "nice": a.nice,
                "niceErrno": a.nice_errno,
                "schedErrno": a.sched_errno,
                "atThreadStart": a.at_thread_start,
            })
        });
    json!({
        "requestedNice": request.nice,
        "requestedSchedRrPriority": request.rr_priority,
        "knobMalformed": request.malformed,
        // `null` until a pacer thread has run: nothing has been asked of the
        // kernel yet, so there is nothing to disclose.
        "achieved": achieved,
    })
}

/// Ask for the requested priority on the calling thread, then read back what it
/// got. Called at every pacer-thread spawn, because a respawned thread starts at
/// the runtime's default again.
#[cfg(target_os = "linux")]
fn apply_priority(request: &PriorityRequest) -> PriorityAchieved {
    fn errno() -> i32 {
        // SAFETY: reading the thread-local errno slot through the libc accessor.
        unsafe { *libc::__errno_location() }
    }

    let mut achieved = PriorityAchieved {
        policy: "unknown",
        at_thread_start: THREAD_STARTS.load(Ordering::Relaxed),
        ..Default::default()
    };
    // SAFETY: every call below targets the calling thread (`0`) and reads or
    // writes only scheduling attributes; `sched_param` is a plain POD the kernel
    // fills in.
    unsafe {
        if let Some(prio) = request.rr_priority {
            let param = libc::sched_param {
                sched_priority: prio,
            };
            if libc::sched_setscheduler(0, libc::SCHED_RR, &param) != 0 {
                achieved.sched_errno = Some(errno());
            }
        }
        if let Some(nice) = request.nice {
            // `PRIO_PROCESS` with `who == 0` is the *calling thread* on Linux:
            // nice is a per-thread attribute there, which is the whole reason
            // this knob is Linux-only.
            *libc::__errno_location() = 0;
            if libc::setpriority(libc::PRIO_PROCESS as u32, 0, nice) != 0 && errno() != 0 {
                achieved.nice_errno = Some(errno());
            }
        }
        achieved.policy = match libc::sched_getscheduler(0) {
            libc::SCHED_OTHER => "other",
            libc::SCHED_RR => "rr",
            libc::SCHED_FIFO => "fifo",
            libc::SCHED_BATCH => "batch",
            libc::SCHED_IDLE => "idle",
            _ => "unknown",
        };
        let mut param = libc::sched_param { sched_priority: 0 };
        if libc::sched_getparam(0, &mut param) == 0 {
            achieved.rt_priority = param.sched_priority;
        }
        // `-1` is a legal nice level, so errno is the only way to tell a real
        // answer from a failure.
        *libc::__errno_location() = 0;
        let nice = libc::getpriority(libc::PRIO_PROCESS as u32, 0);
        achieved.nice = if nice == -1 && errno() != 0 {
            None
        } else {
            Some(nice)
        };
    }
    achieved
}

/// Off Linux the knobs are read and disclosed but never applied.
///
/// `setpriority(PRIO_PROCESS, 0, …)` is process-wide on macOS rather than
/// thread-scoped, so honouring `WEBTRANSPORT_PACER_NICE` there would renice the
/// entire runtime under a name that says "pacer thread" — a measurement lie
/// costlier than the missing lever. `SCHED_RR` has no portable equivalent.
#[cfg(not(target_os = "linux"))]
fn apply_priority(_request: &PriorityRequest) -> PriorityAchieved {
    PriorityAchieved {
        policy: "unsupported",
        at_thread_start: THREAD_STARTS.load(Ordering::Relaxed),
        ..Default::default()
    }
}

/// The schedule, with no thread, no socket and no clock of its own.
///
/// Every timing decision the pacer makes is this one function, so the schedule
/// can be tested by feeding it instants.
#[derive(Debug)]
pub(crate) struct PacerCore {
    interval: Duration,
    horizon: Duration,
    cursor: Option<Instant>,
}

impl PacerCore {
    pub(crate) fn new(cfg: &PacerConfig) -> Self {
        let interval = cfg.interval();
        Self {
            interval,
            horizon: interval * CATCHUP_CLUMPS,
            cursor: None,
        }
    }

    /// Departure time for the next clump, advancing the cursor by one interval.
    ///
    /// The cursor carries across calls and across submissions, which is what
    /// makes two overlapping broadcasts interleave on one schedule instead of
    /// each starting a fresh train.
    pub(crate) fn next_txtime(&mut self, now: Instant) -> Instant {
        let tx = match self.cursor {
            // Ahead of now, or behind it by less than the horizon: keep the
            // schedule. Slightly-behind means "send at once and carry on", not
            // "reset", or a single descheduled tick would restart the cadence.
            Some(cursor) if cursor + self.horizon >= now => cursor,
            _ => {
                if self.cursor.is_some() {
                    RESETS.fetch_add(1, Ordering::Relaxed);
                }
                now
            }
        };
        self.cursor = Some(tx + self.interval);
        tx
    }
}

/// Sleep until `txtime`, coarsely then precisely.
fn wait_until(txtime: Instant) {
    let now = Instant::now();
    if txtime <= now {
        return;
    }
    let remaining = txtime - now;
    if remaining > SPIN_SLACK {
        std::thread::sleep(remaining - SPIN_SLACK);
    }
    while Instant::now() < txtime {
        std::hint::spin_loop();
    }
}

struct Job {
    owner_server_id: u64,
    targets: Vec<String>,
    /// One copy of the payload for the whole fan-out, exactly as the inline
    /// path holds one — `Arc` only because the job outlives the JS call.
    payload: Arc<Vec<u8>>,
}

#[derive(Default)]
struct Queue {
    jobs: VecDeque<Job>,
    pending_targets: u64,
    thread_running: bool,
}

struct Pacer {
    queue: Mutex<Queue>,
    wake: Condvar,
}

fn pacer() -> &'static Pacer {
    static PACER: OnceLock<Pacer> = OnceLock::new();
    PACER.get_or_init(|| Pacer {
        queue: Mutex::new(Queue::default()),
        wake: Condvar::new(),
    })
}

static SUBMITS: AtomicU64 = AtomicU64::new(0);
static ADMITTED: AtomicU64 = AtomicU64::new(0);
static REFUSED: AtomicU64 = AtomicU64::new(0);
static CLUMPS: AtomicU64 = AtomicU64::new(0);
static LATE_CLUMPS: AtomicU64 = AtomicU64::new(0);
static LATE_NANOS_MAX: AtomicU64 = AtomicU64::new(0);
/// Max lateness since the most recent `snapshot()`, which zeroes it.
///
/// A separate register rather than a derived number: a maximum is not
/// invertible, so unlike every other counter here a windowed max cannot be
/// computed as the difference of two cumulative reads.
static LATE_NANOS_MAX_WINDOW: AtomicU64 = AtomicU64::new(0);
static RESETS: AtomicU64 = AtomicU64::new(0);
static DEFERRED_FAILURES: AtomicU64 = AtomicU64::new(0);
static THREAD_STARTS: AtomicU64 = AtomicU64::new(0);
static THREAD_START_FAILURES: AtomicU64 = AtomicU64::new(0);

/// One consistent-enough read of every cumulative counter.
///
/// "Consistent enough" is the honest word: the loads are relaxed and unordered,
/// so a snapshot taken while the pacer thread is mid-clump can show `clumps`
/// incremented and `lateClumps` not yet. At a window's scale — thousands of
/// clumps — that is one clump of slop, and the alternative is a lock on the
/// send path to make a diagnostic exact.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct Counters {
    submits: u64,
    admitted: u64,
    refused: u64,
    clumps: u64,
    late_clumps: u64,
    resets: u64,
    deferred_failures: u64,
    /// Deferred failures whose identity the ring could not keep. Carried here so
    /// `drained + reports_dropped == deferred_failures` can be checked over a
    /// window as well as over the process.
    reports_dropped: u64,
    thread_starts: u64,
    thread_start_failures: u64,
}

impl Counters {
    fn load() -> Self {
        Self {
            submits: SUBMITS.load(Ordering::Relaxed),
            admitted: ADMITTED.load(Ordering::Relaxed),
            refused: REFUSED.load(Ordering::Relaxed),
            clumps: CLUMPS.load(Ordering::Relaxed),
            late_clumps: LATE_CLUMPS.load(Ordering::Relaxed),
            resets: RESETS.load(Ordering::Relaxed),
            deferred_failures: DEFERRED_FAILURES.load(Ordering::Relaxed),
            reports_dropped: REPORTS_DROPPED.load(Ordering::Relaxed),
            thread_starts: THREAD_STARTS.load(Ordering::Relaxed),
            thread_start_failures: THREAD_START_FAILURES.load(Ordering::Relaxed),
        }
    }

    /// Counters advanced since `earlier`.
    ///
    /// Saturating: a counter that appears to have moved backwards — which the
    /// unordered loads above make possible by one increment — reports zero
    /// rather than eighteen quintillion.
    fn since(self, earlier: Self) -> Self {
        Self {
            submits: self.submits.saturating_sub(earlier.submits),
            admitted: self.admitted.saturating_sub(earlier.admitted),
            refused: self.refused.saturating_sub(earlier.refused),
            clumps: self.clumps.saturating_sub(earlier.clumps),
            late_clumps: self.late_clumps.saturating_sub(earlier.late_clumps),
            resets: self.resets.saturating_sub(earlier.resets),
            deferred_failures: self
                .deferred_failures
                .saturating_sub(earlier.deferred_failures),
            reports_dropped: self.reports_dropped.saturating_sub(earlier.reports_dropped),
            thread_starts: self.thread_starts.saturating_sub(earlier.thread_starts),
            thread_start_failures: self
                .thread_start_failures
                .saturating_sub(earlier.thread_start_failures),
        }
    }

    fn to_json(self) -> serde_json::Value {
        json!({
            "submits": self.submits,
            "admittedTargets": self.admitted,
            "refusedTargets": self.refused,
            "clumps": self.clumps,
            "lateClumps": self.late_clumps,
            "scheduleResets": self.resets,
            "deferredFailures": self.deferred_failures,
            "mirrorReportsDropped": self.reports_dropped,
            "threadStarts": self.thread_starts,
            "threadStartFailures": self.thread_start_failures,
        })
    }
}

/// How many open snapshot marks are kept before the oldest is dropped.
///
/// A caller that takes marks and never reads them would otherwise grow this map
/// without limit. The bench takes one per rung, so this is two orders of
/// magnitude of headroom over the intended use.
const MARKS_MAX: usize = 64;

fn marks() -> &'static Mutex<BTreeMap<u32, Counters>> {
    static MARKS: OnceLock<Mutex<BTreeMap<u32, Counters>>> = OnceLock::new();
    MARKS.get_or_init(|| Mutex::new(BTreeMap::new()))
}

static NEXT_MARK: AtomicU32 = AtomicU32::new(1);

/// Open a stats window: record every counter now, and return the token that
/// reads the delta at window close. `0` means the pacer is off — there is
/// nothing to window and no token was stored.
///
/// Reading a token does not consume it, so a caller may sample the same window
/// repeatedly; the mark is released by eviction once `MARKS_MAX` newer marks
/// exist.
pub(crate) fn snapshot() -> u32 {
    if config().is_none() {
        return 0;
    }
    let counters = Counters::load();
    // Zeroed here rather than at read: the window's max belongs to the window
    // that just opened, and every clump after this point contributes to it.
    LATE_NANOS_MAX_WINDOW.store(0, Ordering::Relaxed);
    take_mark(counters)
}

/// Store one mark and name it. Split from `snapshot` only so the token and
/// eviction rules are reachable from a test binary, where `config()` is
/// permanently off and `snapshot` can only ever return `0`.
fn take_mark(counters: Counters) -> u32 {
    let mut token = NEXT_MARK.fetch_add(1, Ordering::Relaxed);
    if token == 0 {
        // Wrapped. `0` is the "no window" answer and must never name a real
        // mark, so skip it rather than hand back an ambiguous token.
        token = NEXT_MARK.fetch_add(1, Ordering::Relaxed);
    }
    if let Ok(mut marks) = marks().lock() {
        while marks.len() >= MARKS_MAX {
            marks.pop_first();
        }
        marks.insert(token, counters);
    }
    token
}

fn read_mark(token: u32) -> Option<Counters> {
    marks().lock().ok()?.get(&token).copied()
}

/// Counters as a JSON string. `"{}"` when the knob is off.
///
/// A string rather than a typed snapshot on purpose: the prototype commits to no
/// schema, and this is read by the microbench and the cable validation, not by
/// user code.
///
/// `since` is a token from [`snapshot`]. With one, `window` carries the deltas
/// over that window beside the raw cumulative values; without one — or with a
/// token already evicted — `window` is `null` and the caller can tell the
/// difference between "no window" and "a window in which nothing happened".
///
/// `cumulative.maxLatenessUsSinceProcessStart` is exactly what its name says and
/// must not be read as a property of any window. The windowed variant lives
/// under `window.maxLatenessUsSinceSnapshot` and is measured from the most
/// recent [`snapshot`] call, whichever token that was.
pub(crate) fn stats_json(since: Option<u32>) -> String {
    let Some(cfg) = config() else {
        return "{}".to_string();
    };
    let pending = pacer().queue.lock().map(|q| q.pending_targets).unwrap_or(0);
    let now = Counters::load();
    let window = since.and_then(|token| {
        let earlier = read_mark(token)?;
        let mut window = now.since(earlier).to_json();
        window["token"] = json!(token);
        window["maxLatenessUsSinceSnapshot"] =
            json!(LATE_NANOS_MAX_WINDOW.load(Ordering::Relaxed) / 1_000);
        Some(window)
    });
    let mut cumulative = now.to_json();
    cumulative["maxLatenessUsSinceProcessStart"] =
        json!(LATE_NANOS_MAX.load(Ordering::Relaxed) / 1_000);
    json!({
        "pps": cfg.pps,
        "clump": cfg.clump,
        "queueMs": cfg.queue_ms,
        // The admission bound as the code actually holds it: a target count.
        // See `max_pending` for why the millisecond knob is nominal.
        "maxPendingTargets": cfg.max_pending(),
        "pendingTargets": pending,
        // Reports waiting to be drained, all servers in this process together.
        "pendingReports": reports().lock().map(|ring| ring.len()).unwrap_or(0),
        "priority": priority_json(),
        "cumulative": cumulative,
        "window": window,
    })
    .to_string()
}

/// How many of `wanted` targets the queue will take right now.
///
/// Pure so the admission rule is testable without a thread: the tail past the
/// bound becomes `E_WOULD_BLOCK`, which is the code a caller already handles for
/// a target with no byte budget.
pub(crate) fn admit_count(pending: u64, wanted: usize, max_pending: u64) -> usize {
    let room = max_pending.saturating_sub(pending);
    (wanted as u64).min(room) as usize
}

/// The same rule as [`admit_count`], answered **per index**.
///
/// The mirror envelope is a *set, not a prefix* — design M4,
/// `tools/bench/mirror-send/mirror-send-design.md:203-214`: subscriber 4 being
/// refused says nothing about subscriber 5, so every target carries its own
/// decision and a refusal is reported at its own index. The earlier
/// `targets[..admitted]` slice reintroduced exactly the prefix shape M4
/// rejected: which targets travelled was decided by position, and the job held a
/// range rather than a set.
///
/// The bound itself stays one number — there is one queue and one count of room
/// in it — but the *decision* is per index, and [`submit`] gathers the job from
/// the admitted indices and reports each refusal at its own. That is the whole
/// difference from the `targets[..admitted]` slice, and it is the difference
/// between a set and a prefix: a per-target rule added here (a duplicate
/// suppressor, a per-session bound) changes only this map, and the envelope
/// stays a set without anything downstream moving.
pub(crate) fn admit_per_index(pending: u64, wanted: usize, max_pending: u64) -> Vec<bool> {
    let room = admit_count(pending, wanted, max_pending);
    (0..wanted).map(|index| index < room).collect()
}

/// Fixed capacity of the deferred-report ring.
///
/// Bounded by construction rather than by caller discipline: a caller that never
/// polls `readMirrorReports` costs this constant, not a growth path. The ring is
/// process-wide because the pacer is — one schedule per process — and each entry
/// is scoped to the server that submitted the job, so a drain only ever sees its
/// own targets.
const MIRROR_REPORTS_CAP: usize = 4_096;

/// One deferred per-target failure, waiting to be drained.
struct Report {
    owner_server_id: u64,
    target: Arc<str>,
    /// `crate::datagram_mirror::MirrorFailure` as its wire `u8`, so the paced
    /// path and the synchronous path decode through the same table.
    code: u8,
}

fn reports() -> &'static Mutex<VecDeque<Report>> {
    static REPORTS: OnceLock<Mutex<VecDeque<Report>>> = OnceLock::new();
    REPORTS.get_or_init(|| Mutex::new(VecDeque::with_capacity(MIRROR_REPORTS_CAP)))
}

static REPORTS_DROPPED: AtomicU64 = AtomicU64::new(0);

/// Record one deferred failure: count it, and keep its identity if the ring has
/// room.
///
/// `DEFERRED_FAILURES` and the ring move together on every path through here,
/// including the ones that lose the entry, which is what makes
/// `drained + mirrorReportsDropped == deferredFailures` a falsifier for the
/// reporting path rather than a hope.
fn record_report(owner_server_id: u64, target: &str, code: &'static str) {
    DEFERRED_FAILURES.fetch_add(1, Ordering::Relaxed);
    let failure = crate::datagram_mirror::MirrorFailure::from_code(code);
    let Ok(mut ring) = reports().lock() else {
        // A poisoned ring loses the entry; saying so keeps the identity above
        // true instead of quietly breaking it.
        REPORTS_DROPPED.fetch_add(1, Ordering::Relaxed);
        return;
    };
    while ring.len() >= MIRROR_REPORTS_CAP {
        ring.pop_front();
        REPORTS_DROPPED.fetch_add(1, Ordering::Relaxed);
    }
    ring.push_back(Report {
        owner_server_id,
        target: Arc::from(target),
        code: failure as u8,
    });
}

/// Take up to `max` of this server's pending reports, oldest first.
///
/// Entries belonging to another server in the process are stepped over and left
/// where they are, so two servers sharing one pacer never drain each other's
/// subscriber ids and neither can starve the other by not polling.
pub(crate) fn drain_reports(owner_server_id: u64, max: usize) -> Vec<(String, u8)> {
    let mut drained = Vec::new();
    if max == 0 {
        return drained;
    }
    let Ok(mut ring) = reports().lock() else {
        return drained;
    };
    let mut index = 0;
    while index < ring.len() && drained.len() < max {
        if ring[index].owner_server_id == owner_server_id {
            let report = ring.remove(index).expect("index is in range");
            drained.push((report.target.to_string(), report.code));
        } else {
            index += 1;
        }
    }
    drained
}

/// Reports lost to ring overflow since process start. Process-wide, like the
/// ring itself.
pub(crate) fn reports_dropped() -> u64 {
    REPORTS_DROPPED.load(Ordering::Relaxed)
}

/// Hand a fan-out to the schedule instead of running it inline.
///
/// The envelope's `sent` field means **admitted to the schedule** here, which is
/// why nothing above this reports it under that name: the paced binding reads it
/// as `admitted`. Per-target transport failures happen later, on the pacer
/// thread, and land in the reports ring and in `deferredFailures`.
pub(crate) fn submit(
    cfg: &PacerConfig,
    owner_server_id: u64,
    targets: &[String],
    payload: &[u8],
) -> MirrorOutcome {
    SUBMITS.fetch_add(1, Ordering::Relaxed);
    let in_cap = crate::datagram_mirror::split_at_cap(targets.len());
    let pacer = pacer();

    let (decisions, admitted) = {
        let mut queue = match pacer.queue.lock() {
            Ok(queue) => queue,
            // A poisoned pacer must not take the broadcast down: refuse
            // everything and let the caller fall back per target.
            Err(_) => return crate::datagram_mirror::fan_out(targets.len(), |_| Some(WOULD_BLOCK)),
        };
        let decisions = admit_per_index(queue.pending_targets, in_cap, cfg.max_pending());
        let accepted: Vec<String> = decisions
            .iter()
            .enumerate()
            .filter(|(_, admit)| **admit)
            .map(|(index, _)| targets[index].clone())
            .collect();
        let admitted = accepted.len();
        if admitted > 0 {
            queue.pending_targets += admitted as u64;
            queue.jobs.push_back(Job {
                owner_server_id,
                targets: accepted,
                payload: Arc::new(payload.to_vec()),
            });
        }
        if !queue.thread_running && admitted > 0 {
            let cfg = *cfg;
            match std::thread::Builder::new()
                .name("wt-egress-pacer".to_string())
                .spawn(move || run(cfg))
            {
                Ok(_) => {
                    queue.thread_running = true;
                    THREAD_STARTS.fetch_add(1, Ordering::Relaxed);
                }
                // Out of threads is not a reason to take the broadcast down
                // from inside a synchronous N-API method. The job stays queued
                // and the next submission tries the spawn again.
                Err(_) => {
                    THREAD_START_FAILURES.fetch_add(1, Ordering::Relaxed);
                }
            }
        }
        (decisions, admitted)
    };
    pacer.wake.notify_one();

    ADMITTED.fetch_add(admitted as u64, Ordering::Relaxed);
    REFUSED.fetch_add((in_cap - admitted) as u64, Ordering::Relaxed);
    crate::datagram_mirror::fan_out(targets.len(), |index| {
        if decisions[index] {
            None
        } else {
            Some(WOULD_BLOCK)
        }
    })
}

/// Clears `thread_running` if the pacer thread leaves any way other than the
/// idle exit — a panic in a send, or a poisoned lock.
///
/// Without it `thread_running` stays `true` for a thread that is gone, no
/// submission ever respawns one, and the queue wedges permanently with every
/// subsequent target refused. The idle exit clears the flag itself, under the
/// lock and in the same critical section that observed the queue empty, and
/// sets `clean` so this guard leaves it alone: clearing it a second time from
/// outside that section is what would let a second pacer thread start while the
/// first still holds a schedule, and two cursors is two paces.
struct ExitGuard {
    clean: bool,
}

impl Drop for ExitGuard {
    fn drop(&mut self) {
        if self.clean {
            return;
        }
        // A poisoned queue is exactly the case this exists for, so the poison is
        // stepped over rather than propagated.
        let mut queue = match pacer().queue.lock() {
            Ok(queue) => queue,
            Err(poisoned) => poisoned.into_inner(),
        };
        queue.thread_running = false;
    }
}

/// The pacer thread: pop a job, split it into clumps, and give each clump one
/// departure time.
fn run(cfg: PacerConfig) {
    let pacer = pacer();
    let mut core = PacerCore::new(&cfg);
    let mut guard = ExitGuard { clean: false };
    // Every respawn starts at the runtime's default priority, so the request is
    // re-applied here rather than once per process.
    let achieved = apply_priority(priority_request());
    if let Ok(mut slot) = priority_achieved().lock() {
        *slot = Some(achieved);
    }
    loop {
        let job = {
            let mut queue = match pacer.queue.lock() {
                Ok(queue) => queue,
                Err(_) => return,
            };
            loop {
                if let Some(job) = queue.jobs.pop_front() {
                    break Some(job);
                }
                let (next, timeout) = match pacer.wake.wait_timeout(queue, IDLE_EXIT) {
                    Ok((next, timeout)) => (next, timeout.timed_out()),
                    Err(_) => return,
                };
                queue = next;
                if timeout && queue.jobs.is_empty() {
                    // Exit rather than hold a thread for a server that has
                    // stopped broadcasting; the next submission respawns.
                    queue.thread_running = false;
                    guard.clean = true;
                    break None;
                }
            }
        };
        let Some(job) = job else { return };
        drain_paced(
            &cfg,
            &mut core,
            &job.targets,
            |id| {
                let Some(state) = crate::session_registry::get_datagram_send_state_for_owner(
                    id,
                    job.owner_server_id,
                ) else {
                    record_report(job.owner_server_id, id, "E_SESSION_CLOSED");
                    return;
                };
                if let Some(code) = crate::session::try_send_datagram_on_state(&state, &job.payload)
                {
                    record_report(job.owner_server_id, id, code);
                }
            },
            // Released clump by clump, not job by job: the bound is "how much
            // scheduled work is outstanding", and a 10 000-target job that has
            // already sent 9 000 is 1 000 targets of outstanding work. Holding
            // the whole job's count until it finished would make a 250 ms bound
            // behave like a much smaller one for exactly the fan-out sizes this
            // is for.
            |done| {
                if let Ok(mut queue) = pacer.queue.lock() {
                    queue.pending_targets = queue.pending_targets.saturating_sub(done as u64);
                }
            },
        );
    }
}

/// Spread one target list over the schedule, one clump per departure time.
///
/// The send is a closure so the paced drain can be tested for its *shape* —
/// clump boundaries, ordering, spacing — without a registry, a socket or the
/// knob, which `config()` memoizes per process and so cannot be flipped inside
/// a test binary.
fn drain_paced<F, G>(
    cfg: &PacerConfig,
    core: &mut PacerCore,
    targets: &[String],
    mut send_one: F,
    mut clump_done: G,
) where
    F: FnMut(&str),
    G: FnMut(usize),
{
    for clump in targets.chunks(cfg.clump) {
        let txtime = core.next_txtime(Instant::now());
        wait_until(txtime);
        record_clump(txtime);
        // One clump is one burst unit: quinn coalesces at most this many
        // datagrams into one GSO super-buffer, and then the thread stops until
        // the next departure time.
        for id in clump {
            send_one(id);
        }
        clump_done(clump.len());
    }
}

fn record_clump(txtime: Instant) {
    CLUMPS.fetch_add(1, Ordering::Relaxed);
    let lateness = Instant::now().saturating_duration_since(txtime);
    if lateness > SPIN_SLACK {
        LATE_CLUMPS.fetch_add(1, Ordering::Relaxed);
    }
    let nanos = lateness.as_nanos().min(u64::MAX as u128) as u64;
    LATE_NANOS_MAX.fetch_max(nanos, Ordering::Relaxed);
    LATE_NANOS_MAX_WINDOW.fetch_max(nanos, Ordering::Relaxed);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(pps: u64, clump: usize) -> PacerConfig {
        PacerConfig {
            pps,
            clump,
            queue_ms: QUEUE_MS_DEFAULT,
        }
    }

    #[test]
    fn the_interval_is_one_clump_at_the_configured_rate() {
        assert_eq!(cfg(75_000, 32).interval(), Duration::from_nanos(426_666));
        assert_eq!(cfg(1_000, 1).interval(), Duration::from_millis(1));
        // Never zero: a zero interval is a spin loop wearing a schedule's name.
        assert!(cfg(u64::MAX, 1).interval() >= Duration::from_nanos(1));
    }

    #[test]
    fn clumps_depart_exactly_one_interval_apart() {
        let cfg = cfg(75_000, 32);
        let mut core = PacerCore::new(&cfg);
        let start = Instant::now();
        let first = core.next_txtime(start);
        assert_eq!(first, start, "an idle schedule starts now");
        for step in 1..=10u32 {
            // The wall clock advancing does not move the schedule: departures
            // are decided by the cursor, not by when the thread woke up.
            let tx = core.next_txtime(start + Duration::from_micros(step as u64 * 500));
            assert_eq!(tx, start + cfg.interval() * step);
        }
    }

    #[test]
    fn a_schedule_carries_across_submissions_rather_than_restarting() {
        let cfg = cfg(75_000, 32);
        let mut core = PacerCore::new(&cfg);
        let start = Instant::now();
        let first = core.next_txtime(start);
        let second = core.next_txtime(start);
        assert_eq!(
            second - first,
            cfg.interval(),
            "two clumps submitted at the same instant must not depart together"
        );
    }

    #[test]
    fn a_slightly_late_cursor_keeps_the_cadence() {
        let cfg = cfg(75_000, 32);
        let mut core = PacerCore::new(&cfg);
        let start = Instant::now();
        core.next_txtime(start);
        let before = RESETS.load(Ordering::Relaxed);
        // One clump of lateness — inside the catch-up allowance, so the cadence
        // survives instead of restarting on every descheduled tick.
        let tx = core.next_txtime(start + cfg.interval() * 2);
        assert_eq!(tx, start + cfg.interval(), "one late tick is not a reset");
        assert_eq!(RESETS.load(Ordering::Relaxed), before);
    }

    #[test]
    fn a_cursor_past_the_horizon_restarts_instead_of_bursting() {
        let cfg = cfg(75_000, 32);
        let mut core = PacerCore::new(&cfg);
        let start = Instant::now();
        core.next_txtime(start);
        // A 13 ms stall — what the first microbench run on this branch actually
        // hit — is ~30 clumps of debt. Paying it back at once is a 1 000-packet
        // train, so the schedule drops the debt and restarts.
        let resumed = start + Duration::from_millis(13);
        let before = RESETS.load(Ordering::Relaxed);
        assert_eq!(
            core.next_txtime(resumed),
            resumed,
            "a long stall must not owe the schedule a catch-up burst"
        );
        assert_eq!(RESETS.load(Ordering::Relaxed), before + 1);
    }

    /// The paced envelope is a set: every target carries its own decision, and a
    /// refusal is reported at its own index rather than implied by a boundary
    /// the caller has to reconstruct.
    #[test]
    fn admission_answers_per_index_and_agrees_with_the_count() {
        let decisions = admit_per_index(0, 5, 3);
        assert_eq!(decisions, vec![true, true, true, false, false]);
        assert_eq!(
            decisions.len(),
            5,
            "every offered target gets a decision, refused ones included"
        );

        // Refusal in the middle of a list is representable: the gather in
        // `submit` reads this vector, not a range, so index 4 travelling while
        // index 3 does not needs no new machinery.
        let handmade = [true, true, true, false, true];
        let admitted: Vec<usize> = handmade
            .iter()
            .enumerate()
            .filter(|(_, admit)| **admit)
            .map(|(index, _)| index)
            .collect();
        assert_eq!(admitted, vec![0, 1, 2, 4]);

        for (pending, wanted, bound) in [(0u64, 10usize, 4u64), (15, 10, 18_750), (99_999, 10, 8)] {
            let per_index = admit_per_index(pending, wanted, bound);
            assert_eq!(
                per_index.iter().filter(|admit| **admit).count(),
                admit_count(pending, wanted, bound),
                "one bound, two readings of it, which must never disagree"
            );
        }
    }

    /// The ring is the only thing standing between "a caller never polls" and
    /// unbounded growth, so its bound, its FIFO order, its owner scoping, its
    /// drop accounting and the identity that ties them together are pinned here
    /// rather than inferred from a live run.
    ///
    /// One test rather than four: the ring, `DEFERRED_FAILURES` and
    /// `REPORTS_DROPPED` are process-wide, so a sibling test recording reports
    /// in parallel would break any delta the others read — the same reason the
    /// mark-map rules share one test.
    #[test]
    fn the_reports_ring_is_fifo_owner_scoped_bounded_and_accounts_for_every_failure() {
        let failures_before = DEFERRED_FAILURES.load(Ordering::Relaxed);
        let dropped_at_start = reports_dropped();
        // Owner ids unique to this test: the ring is process-wide and the test
        // binary runs in parallel.
        let owner = 0x5eed_0001;
        let other = 0x5eed_0002;

        record_report(owner, "a", "E_SESSION_CLOSED");
        record_report(other, "not-mine", "E_SESSION_CLOSED");
        record_report(owner, "b", WOULD_BLOCK);
        record_report(owner, "c", "E_QUEUE_FULL");

        // Every drain in this test adds to this, whichever owner it was for, so
        // the closing identity counts what actually left the ring.
        let mut drained = 0u64;
        let mut take = |owner: u64, max: usize| {
            let batch = drain_reports(owner, max);
            drained += batch.len() as u64;
            batch
        };

        let first = take(owner, 2);
        assert_eq!(
            first,
            vec![
                (
                    "a".to_string(),
                    crate::datagram_mirror::MirrorFailure::SessionClosed as u8
                ),
                (
                    "b".to_string(),
                    crate::datagram_mirror::MirrorFailure::WouldBlock as u8
                ),
            ],
            "oldest first, another owner's entry stepped over rather than taken"
        );
        let rest = take(owner, 16);
        assert_eq!(rest.len(), 1, "max is respected, the remainder stays");
        assert_eq!(rest[0].0, "c");
        assert!(
            take(owner, 16).is_empty(),
            "a drained ring is empty, and an empty drain is not an error"
        );
        assert_eq!(take(owner, 0).len(), 0, "max 0 takes nothing");

        // The other owner's entry survived every drain above.
        assert_eq!(take(other, 16).len(), 1);

        // Overflow: one past capacity drops exactly one, oldest, and says so.
        let dropped_before = reports_dropped();
        for index in 0..MIRROR_REPORTS_CAP + 1 {
            record_report(owner, &format!("t{index}"), "E_SESSION_CLOSED");
        }
        assert_eq!(
            reports_dropped() - dropped_before,
            1,
            "the ring drops rather than grows, and counts what it dropped"
        );
        let survivors = take(owner, usize::MAX);
        assert_eq!(survivors.len(), MIRROR_REPORTS_CAP);
        assert_eq!(
            survivors[0].0, "t1",
            "the oldest entry is the one that goes"
        );

        // The identity every other number here rests on: a report is either
        // drained or counted as dropped, never neither. The end-to-end version
        // runs from TypeScript against a live pacer thread.
        assert_eq!(
            drained + (reports_dropped() - dropped_at_start),
            DEFERRED_FAILURES.load(Ordering::Relaxed) - failures_before,
            "a report that is neither drained nor counted as dropped is a reporting path that lies"
        );
    }

    #[test]
    fn admission_refuses_only_the_tail_past_the_bound() {
        assert_eq!(admit_count(0, 10_000, 18_750), 10_000);
        assert_eq!(admit_count(15_000, 10_000, 18_750), 3_750);
        assert_eq!(admit_count(18_750, 10_000, 18_750), 0);
        assert_eq!(admit_count(99_999, 10, 18_750), 0);
    }

    /// Replay of the admission rule against a drain that achieves `achieved_pps`.
    ///
    /// This is the submit side and the release side of the real code — the
    /// `admit_count` bound, and the clump-by-clump release the drain performs —
    /// with wall time replaced by a 1 ms step so a 60 s window is a test. It
    /// exists to answer one question with arithmetic instead of a cable run:
    /// what queue latencies are *reachable* at a given refusal count.
    ///
    /// Returns `(refused targets, worst time a target spent queued)`.
    fn replay(
        cfg: &PacerConfig,
        achieved_pps: u64,
        job: usize,
        period_ms: u64,
        seconds: u64,
    ) -> (u64, Duration) {
        let mut queued: VecDeque<(u64, u64)> = VecDeque::new(); // (admitted at ms, targets)
        let mut pending = 0u64;
        let mut refused = 0u64;
        let mut worst_ms = 0u64;
        for ms in 0..seconds * 1_000 {
            if ms % period_ms == 0 {
                let admitted = admit_count(pending, job, cfg.max_pending()) as u64;
                refused += job as u64 - admitted;
                if admitted > 0 {
                    pending += admitted;
                    queued.push_back((ms, admitted));
                }
            }
            let mut budget = achieved_pps / 1_000;
            while budget > 0 {
                let Some((admitted_at, left)) = queued.front_mut() else {
                    break;
                };
                let sent = budget.min(*left);
                *left -= sent;
                budget -= sent;
                pending -= sent;
                worst_ms = worst_ms.max(ms - *admitted_at);
                if *left == 0 {
                    queued.pop_front();
                }
            }
        }
        (refused, Duration::from_millis(worst_ms))
    }

    /// Ticket 18's contradiction, settled: the 250 ms bound is enforced, it is
    /// enforced as a *target count*, and at last night's shape that count is
    /// never approached — so zero refusals is what the bound predicts and the
    /// 2 s spread cannot have been spent in this queue.
    #[test]
    fn a_broadcast_that_is_never_refused_cannot_have_waited_the_bound_in_the_queue() {
        let cfg = PacerConfig {
            pps: 75_000,
            clump: 32,
            queue_ms: QUEUE_MS_DEFAULT,
        };
        assert_eq!(cfg.max_pending(), 18_750);

        // Last night's shape: 10 000 targets per broadcast at 5 Hz — 50 k
        // targets/s offered against a 75 k schedule.
        let (refused, worst) = replay(&cfg, cfg.pps, 10_000, 200, 60);
        assert_eq!(refused, 0, "a drain above the offered rate refuses nothing");
        assert!(
            worst < Duration::from_millis(cfg.queue_ms),
            "queue latency {worst:?} at the configured rate must stay under the bound"
        );

        // The queue can only hold a target for ~2 s if the drain runs at about
        // `max_pending / 2 s` ≈ 9.4 k pps — and that drain refuses most of what
        // it is offered, which is precisely what the measured run did not do.
        let (refused_slow, worst_slow) = replay(&cfg, 9_400, 10_000, 200, 60);
        assert!(
            worst_slow >= Duration::from_millis(1_800),
            "a 9.4 k drain should park targets for ~2 s, saw {worst_slow:?}"
        );
        assert!(
            refused_slow > 2_000_000,
            "reaching a 2 s queue means refusing millions of targets, saw {refused_slow}"
        );
    }

    /// The other half of the answer: `queue_ms` is milliseconds *at the
    /// configured rate*. Half the achieved rate is double the queue latency for
    /// the same bound, which is why the windowed stats have to travel with any
    /// paced number.
    #[test]
    fn the_queue_bound_is_a_target_count_and_only_nominally_a_duration() {
        let cfg = PacerConfig {
            pps: 75_000,
            clump: 32,
            queue_ms: QUEUE_MS_DEFAULT,
        };
        let bound = cfg.max_pending();
        assert_eq!(
            bound * 1_000 / cfg.pps,
            cfg.queue_ms,
            "nominal by construction"
        );
        assert_eq!(
            bound * 1_000 / (cfg.pps / 2),
            cfg.queue_ms * 2,
            "the same bound is twice the wall time at half the achieved rate"
        );
    }

    #[test]
    fn the_admission_bound_is_at_least_one_clump() {
        let tiny = PacerConfig {
            pps: 10,
            clump: 32,
            queue_ms: 1,
        };
        assert_eq!(tiny.max_pending(), 32);
    }

    #[test]
    fn the_knob_defaults_to_off() {
        // `config()` memoizes per process, so this asserts the rule the way it
        // is actually reachable: no `WEBTRANSPORT_PACER_PPS` in the test
        // environment means no pacer and no stats schema.
        assert!(std::env::var("WEBTRANSPORT_PACER_PPS").is_err());
        assert!(config().is_none());
        assert_eq!(stats_json(None), "{}");
        assert_eq!(stats_json(Some(1)), "{}");
        // No token is handed out either: a caller that marks a window on a
        // knob-off server must not be given something that looks like one.
        assert_eq!(snapshot(), 0);
    }

    /// Both mark rules in one test: the global mark map is shared process-wide,
    /// and splitting these would let the eviction half evict the delta half's
    /// token under a parallel test runner.
    #[test]
    fn a_mark_reads_back_as_a_delta_and_the_oldest_marks_are_evicted() {
        let open = Counters {
            submits: 10,
            clumps: 100,
            late_clumps: 3,
            ..Default::default()
        };
        let token = take_mark(open);
        assert_ne!(token, 0, "a real mark never wears the no-window token");
        assert_eq!(read_mark(token), Some(open));

        let close = Counters {
            submits: 14,
            clumps: 400,
            late_clumps: 3,
            thread_starts: 2,
            ..Default::default()
        };
        let window = close.since(open);
        assert_eq!(window.submits, 4);
        assert_eq!(window.clumps, 300);
        assert_eq!(window.late_clumps, 0, "a counter that did not move is zero");
        assert_eq!(window.thread_starts, 2);
        // The unordered relaxed loads can show a counter going backwards by one
        // increment; that must read as nothing happened, not as a wrap.
        assert_eq!(open.since(close).submits, 0);

        for _ in 0..MARKS_MAX {
            take_mark(Counters::default());
        }
        assert_eq!(
            read_mark(token),
            None,
            "a mark held past the cap is dropped rather than growing the map"
        );
    }

    #[test]
    fn the_priority_knobs_parse_clamped_and_disclose_a_typo_instead_of_defaulting() {
        assert_eq!(parse_priority(None, None), PriorityRequest::default());

        let nice = parse_priority(Some(" -10 "), None);
        assert_eq!(nice.nice, Some(-10));
        assert!(!nice.malformed);
        assert_eq!(parse_priority(Some("-99"), None).nice, Some(-20));
        assert_eq!(parse_priority(Some("99"), None).nice, Some(19));

        let rr = parse_priority(None, Some("RR:50"));
        assert_eq!(rr.rr_priority, Some(50));
        assert!(!rr.malformed);
        assert_eq!(parse_priority(None, Some("rr:0")).rr_priority, Some(1));
        assert_eq!(parse_priority(None, Some("rr:400")).rr_priority, Some(99));

        // A typo must never read as "no priority requested": a sweep cell that
        // silently ran unprioritised would be labelled as a priority cell.
        for typo in ["fifo:50", "rr", "50", ""] {
            let bad = parse_priority(None, Some(typo));
            assert!(bad.malformed, "{typo:?} should be disclosed as malformed");
            assert_eq!(bad.rr_priority, None);
        }
        assert!(parse_priority(Some("high"), None).malformed);
    }

    #[test]
    fn priority_is_disclosed_as_unrequested_and_unachieved_until_a_thread_runs() {
        // Neither knob is set in the test environment, and no pacer thread can
        // start with the pacer off — so this is the byte-identical default the
        // lever must not disturb.
        assert!(std::env::var("WEBTRANSPORT_PACER_NICE").is_err());
        assert!(std::env::var("WEBTRANSPORT_PACER_SCHED").is_err());
        let json = priority_json();
        assert!(json["requestedNice"].is_null());
        assert!(json["requestedSchedRrPriority"].is_null());
        assert_eq!(json["knobMalformed"], serde_json::Value::Bool(false));
        assert!(
            json["achieved"].is_null(),
            "achieved is read back from the kernel, so it stays null until there is a thread to read"
        );
    }

    #[test]
    fn the_paced_drain_sends_every_target_once_in_order_one_clump_per_departure() {
        let cfg = cfg(200_000, 8);
        let mut core = PacerCore::new(&cfg);
        let targets: Vec<String> = (0..21).map(|i| format!("s{i}")).collect();

        // Both closures observe one run, so the recording state is shared
        // rather than split between them.
        let clumps = std::cell::RefCell::new(Vec::<Vec<String>>::new());
        let departures = std::cell::RefCell::new(Vec::<Instant>::new());
        let released = std::cell::RefCell::new(Vec::<usize>::new());
        drain_paced(
            &cfg,
            &mut core,
            &targets,
            |id| {
                let mut clumps = clumps.borrow_mut();
                if clumps.len() == released.borrow().len() {
                    clumps.push(Vec::new());
                    departures.borrow_mut().push(Instant::now());
                }
                clumps
                    .last_mut()
                    .expect("a clump is open")
                    .push(id.to_string());
            },
            |done| released.borrow_mut().push(done),
        );

        let clumps = clumps.into_inner();
        assert_eq!(clumps.len(), 3, "21 targets at clump 8 is 8 + 8 + 5");
        assert_eq!(
            released.into_inner(),
            vec![8, 8, 5],
            "the admission bound is released clump by clump, not at job end"
        );
        assert_eq!(
            clumps.concat(),
            targets,
            "every target is sent exactly once, in the caller's order"
        );
        for pair in departures.into_inner().windows(2) {
            let gap = pair[1] - pair[0];
            assert!(
                gap >= cfg.interval() / 2,
                "clumps departed {gap:?} apart, which is not a paced burst unit"
            );
        }
    }

    /// Microbench: schedule overhead and achieved smoothness, no socket.
    ///
    /// Runs the real `PacerCore` and the real `wait_until` at the target shape
    /// and prints the inter-clump spacing distribution. Assertions are generous
    /// on purpose — this is a measurement that must not become a flaky gate;
    /// the numbers are read from `--nocapture`, not from the pass/fail.
    #[test]
    fn microbench_schedule_overhead_and_smoothness() {
        let cfg = cfg(75_000, 32);
        let interval = cfg.interval();
        let clumps = 2_000usize; // ~0.85 s at 75 k pps
        let mut core = PacerCore::new(&cfg);

        let mut departures = Vec::with_capacity(clumps);
        let mut schedule_cost = Duration::ZERO;
        let start = Instant::now();
        for _ in 0..clumps {
            let t0 = Instant::now();
            let txtime = core.next_txtime(t0);
            schedule_cost += t0.elapsed();
            wait_until(txtime);
            departures.push(Instant::now());
        }
        let wall = start.elapsed();

        let ordered: Vec<u64> = departures
            .windows(2)
            .map(|w| (w[1] - w[0]).as_nanos() as u64)
            .collect();
        // The property the catch-up bound buys: a stall may be paid back by at
        // most `CATCHUP_CLUMPS` tight departures before the cadence restarts.
        let tight = interval.as_nanos() as u64 / 2;
        let (mut run, mut worst_run) = (0u32, 0u32);
        for gap in &ordered {
            run = if *gap < tight { run + 1 } else { 0 };
            worst_run = worst_run.max(run);
        }
        // `CATCHUP_CLUMPS` of debt, plus the restart departure itself: after a
        // stall the schedule has to begin somewhere and `now` is the honest
        // answer, so the restart lands tight against the last debt clump. Three
        // clumps — 96 packets — not the ~468 a wall-time horizon allowed.
        let burst_bound = CATCHUP_CLUMPS + 1;
        let mut spacing = ordered.clone();
        spacing.sort_unstable();
        let pct = |p: f64| spacing[((spacing.len() - 1) as f64 * p) as usize];
        let mean = spacing.iter().sum::<u64>() / spacing.len() as u64;

        let cost_per_clump = schedule_cost / clumps as u32;
        println!(
            "pacer microbench: {clumps} clumps of {} at {} pps\n  \
             target interval {:?}, wall {:?} (achieved {:.0} pps)\n  \
             spacing ns  p1 {} p50 {} p90 {} p99 {} max {} mean {}\n  \
             longest run of tight departures {worst_run} (bound {burst_bound})\n  \
             schedule cost {:?} total, {:?}/clump\n  stats {}",
            cfg.clump,
            cfg.pps,
            interval,
            wall,
            (clumps * cfg.clump) as f64 / wall.as_secs_f64(),
            pct(0.01),
            pct(0.50),
            pct(0.90),
            pct(0.99),
            spacing[spacing.len() - 1],
            mean,
            schedule_cost,
            cost_per_clump,
            stats_json(None),
        );

        // The schedule itself must be free relative to the cadence it drives.
        assert!(
            cost_per_clump < interval / 10,
            "next_txtime cost {cost_per_clump:?} is not negligible against a {interval:?} cadence"
        );
        // Mean spacing is the property that matters: the cursor, not the sleep,
        // decides the rate, so drift must not accumulate even on a loaded box.
        // One-sided — a descheduled run is *slower* than the target and that is
        // the pacer behaving, but it must never come out faster.
        assert!(
            mean >= interval.as_nanos() as u64 * 3 / 4,
            "mean spacing {mean} ns ran ahead of the {interval:?} target"
        );
        assert!(
            worst_run <= burst_bound,
            "{worst_run} tight departures in a row is a catch-up burst, bound is {burst_bound}"
        );
    }
}
