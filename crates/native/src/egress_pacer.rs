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

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

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
static RESETS: AtomicU64 = AtomicU64::new(0);
static DEFERRED_FAILURES: AtomicU64 = AtomicU64::new(0);
static THREAD_STARTS: AtomicU64 = AtomicU64::new(0);
static THREAD_START_FAILURES: AtomicU64 = AtomicU64::new(0);

/// Counters as a JSON string. `"{}"` when the knob is off.
///
/// A string rather than a typed snapshot on purpose: the prototype commits to no
/// schema, and this is read by the microbench and the cable validation, not by
/// user code.
pub(crate) fn stats_json() -> String {
    let Some(cfg) = config() else {
        return "{}".to_string();
    };
    let pending = pacer().queue.lock().map(|q| q.pending_targets).unwrap_or(0);
    format!(
        "{{\"pps\":{},\"clump\":{},\"queueMs\":{},\"submits\":{},\"admittedTargets\":{},\
\"refusedTargets\":{},\"clumps\":{},\"lateClumps\":{},\"maxLatenessUs\":{},\
\"scheduleResets\":{},\"deferredFailures\":{},\"threadStarts\":{},\
\"threadStartFailures\":{},\"pendingTargets\":{}}}",
        cfg.pps,
        cfg.clump,
        cfg.queue_ms,
        SUBMITS.load(Ordering::Relaxed),
        ADMITTED.load(Ordering::Relaxed),
        REFUSED.load(Ordering::Relaxed),
        CLUMPS.load(Ordering::Relaxed),
        LATE_CLUMPS.load(Ordering::Relaxed),
        LATE_NANOS_MAX.load(Ordering::Relaxed) / 1_000,
        RESETS.load(Ordering::Relaxed),
        DEFERRED_FAILURES.load(Ordering::Relaxed),
        THREAD_STARTS.load(Ordering::Relaxed),
        THREAD_START_FAILURES.load(Ordering::Relaxed),
        pending,
    )
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

/// Hand a fan-out to the schedule instead of running it inline.
///
/// Returns the same envelope shape the inline path does, but `sent` means
/// *admitted to the schedule* — see the note's "open API question". Per-target
/// transport failures happen later, on the pacer thread, and land in
/// `deferredFailures`.
pub(crate) fn submit(
    cfg: &PacerConfig,
    owner_server_id: u64,
    targets: &[String],
    payload: &[u8],
) -> MirrorOutcome {
    SUBMITS.fetch_add(1, Ordering::Relaxed);
    let in_cap = crate::datagram_mirror::split_at_cap(targets.len());
    let pacer = pacer();

    let admitted = {
        let mut queue = match pacer.queue.lock() {
            Ok(queue) => queue,
            // A poisoned pacer must not take the broadcast down: refuse
            // everything and let the caller fall back per target.
            Err(_) => return crate::datagram_mirror::fan_out(targets.len(), |_| Some(WOULD_BLOCK)),
        };
        let admitted = admit_count(queue.pending_targets, in_cap, cfg.max_pending());
        if admitted > 0 {
            queue.pending_targets += admitted as u64;
            queue.jobs.push_back(Job {
                owner_server_id,
                targets: targets[..admitted].to_vec(),
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
        admitted
    };
    pacer.wake.notify_one();

    ADMITTED.fetch_add(admitted as u64, Ordering::Relaxed);
    REFUSED.fetch_add((in_cap - admitted) as u64, Ordering::Relaxed);
    crate::datagram_mirror::fan_out(targets.len(), |index| {
        if index < admitted {
            None
        } else {
            Some(WOULD_BLOCK)
        }
    })
}

/// The pacer thread: pop a job, split it into clumps, and give each clump one
/// departure time.
fn run(cfg: PacerConfig) {
    let pacer = pacer();
    let mut core = PacerCore::new(&cfg);
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
                    DEFERRED_FAILURES.fetch_add(1, Ordering::Relaxed);
                    return;
                };
                if crate::session::try_send_datagram_on_state(&state, &job.payload).is_some() {
                    DEFERRED_FAILURES.fetch_add(1, Ordering::Relaxed);
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

    #[test]
    fn admission_refuses_only_the_tail_past_the_bound() {
        assert_eq!(admit_count(0, 10_000, 18_750), 10_000);
        assert_eq!(admit_count(15_000, 10_000, 18_750), 3_750);
        assert_eq!(admit_count(18_750, 10_000, 18_750), 0);
        assert_eq!(admit_count(99_999, 10, 18_750), 0);
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
        assert_eq!(stats_json(), "{}");
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
            stats_json(),
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
