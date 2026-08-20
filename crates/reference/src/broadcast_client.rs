//! G10's subscriber fleet: the role the Mac runs at the far end of the cable.
//!
//! Companion to `tools/load/bench-g10.ts`. Every threshold, clause and falsifier
//! lives in `docs/research/preregistrations/gate-g10-broadcast.md`; this binary
//! holds sessions, records what arrived, and decides nothing. It emits one line
//!
//! ```text
//! broadcast-client: json {…}
//! ```
//!
//! which is the shape the conductor's `OffboxReport` parses.
//!
//! Four things here are the reason this role cannot live in the conductor's own
//! process, and they are worth naming because a co-resident fleet is the exact
//! thing §11a says can never be a G10 result:
//!
//! 1. **The spread is this process's arithmetic** (§6.2). `max(receiveNs) −
//!    min(receiveNs)` per broadcast sequence, across subscribers that share one
//!    `CLOCK_MONOTONIC` because they share one host. Computed in the conductor
//!    it would be the emitter measuring itself through its own event loop.
//! 2. **The probe loop is independent of the broadcast** (§1.8). A probe reading
//!    its own broadcast copy at fan-out position 9,999 would be measuring its
//!    queue position, so probes send their own datagram and read the server's
//!    echo of it.
//! 3. **Arms are read off the wire, never off a clock** (§6.1). Every broadcast
//!    copy and every probe echo carries the version-4 arm byte, so attribution
//!    survives the interleave's block edges — which is what K5 cost G3b.
//! 4. **Per subscriber, never per fleet** (§C2b). A fleet ratio hides forty
//!    starved subscribers behind ten thousand healthy ones, so this process
//!    reports the *distribution* of per-subscriber receive counts and lets the
//!    conductor divide it by the count the emitter actually issued.
//!
//! What this binary deliberately does **not** report is `messagesIssued`. It
//! cannot know it: a broadcast no subscriber received leaves no trace here, and
//! reporting the sequences it happened to see as the denominator would turn a
//! total delivery failure into a completeness success. The conductor's own
//! per-arm `broadcastsIssued` is the denominator, and the field is left absent so
//! that it is used.
//!
//! Two pre-checks §11a step 0b requires are this same binary in a degenerate
//! configuration, which is why the flags below tolerate zeros:
//!
//! ```text
//! V-M  --sessions 10000 --probe-cohort 0 --rate 0 --seconds 60
//! V-F  --sessions 20 --probe-cohort 20 --probe-hz 2 --rate 0 --seconds 60
//! ```

// Shared with the other load binaries so both ends of a stamp are one
// implementation.
#[allow(dead_code)]
mod latency_probe;

use latency_probe::{
    monotonic_ns, read_stamp, write_stamp_v4, AtomicHistogram, ARM_A1, ARM_A2, ARM_A3, ARM_NONE,
    CLASS_BROADCAST, CLASS_PROBE, CLASS_PROBE_ECHO, STAMP_BYTES_V4,
};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use wtransport::{ClientConfig, Endpoint};

const DEFAULT_URL: &str = "https://127.0.0.1:4433";
/// The server's idle timeout for this gate is ten minutes and a subscriber that
/// only ever receives sends nothing, so the client keeps its own side alive.
const KEEP_ALIVE: Duration = Duration::from_secs(5);
const MAX_IDLE: Duration = Duration::from_secs(300);
const MAX_RECORDED_ERRORS: usize = 8;
/// Grace after the conductor's window so a datagram already on the wire is not
/// counted as lost by a report snapshotted the instant the window closed. It
/// also covers the skew between "the conductor saw the fleet establish" and
/// "this process saw its own last session establish".
const DEFAULT_DRAIN_GRACE_SEC: f64 = 10.0;
/// Arm slots: index 0 is `ARM_NONE`, which collects broadcast copies that
/// carried no arm. A non-zero count there is a wire defect, not an arm.
const ARM_SLOTS: usize = 4;

/* -------------------------------------------------------------------------- */
/* Options                                                                     */
/* -------------------------------------------------------------------------- */

#[derive(Debug, Clone)]
struct Options {
    url: String,
    sessions: usize,
    probe_cohort: usize,
    probe_hz: f64,
    payload_bytes: usize,
    /// The broadcast rate the conductor drives, used only to size the
    /// per-sequence table. Nothing is scored against it here.
    rate: f64,
    seconds: f64,
    drain_grace_sec: f64,
    endpoints: usize,
    connect_concurrency: usize,
    json_out: Option<String>,
}

impl Default for Options {
    fn default() -> Self {
        Options {
            url: DEFAULT_URL.to_string(),
            sessions: 100,
            probe_cohort: 0,
            probe_hz: 2.0,
            payload_bytes: 200,
            rate: 5.0,
            seconds: 30.0,
            drain_grace_sec: DEFAULT_DRAIN_GRACE_SEC,
            endpoints: 8,
            connect_concurrency: 64,
            json_out: None,
        }
    }
}

fn parse_or_default<T>(flag: &str, raw: Option<String>, default: T) -> T
where
    T: std::str::FromStr + Copy + std::fmt::Display,
{
    match raw {
        Some(v) => match v.parse::<T>() {
            Ok(parsed) => parsed,
            Err(_) => {
                eprintln!("broadcast-client: bad value for {flag} ('{v}'); using {default}");
                default
            }
        },
        None => default,
    }
}

fn parse_args() -> Options {
    let mut args = std::env::args().skip(1);
    let mut o = Options::default();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--url" => o.url = args.next().unwrap_or_else(|| DEFAULT_URL.to_string()),
            "--sessions" => o.sessions = parse_or_default("--sessions", args.next(), o.sessions),
            "--probe-cohort" => {
                o.probe_cohort = parse_or_default("--probe-cohort", args.next(), o.probe_cohort)
            }
            "--probe-hz" => o.probe_hz = parse_or_default("--probe-hz", args.next(), o.probe_hz),
            "--payload-bytes" => {
                o.payload_bytes = parse_or_default("--payload-bytes", args.next(), o.payload_bytes)
                    .max(STAMP_BYTES_V4)
            }
            "--rate" => o.rate = parse_or_default("--rate", args.next(), o.rate),
            "--seconds" => o.seconds = parse_or_default("--seconds", args.next(), o.seconds),
            "--drain-grace-sec" => {
                o.drain_grace_sec =
                    parse_or_default("--drain-grace-sec", args.next(), o.drain_grace_sec)
            }
            "--endpoints" => {
                o.endpoints = parse_or_default("--endpoints", args.next(), o.endpoints).clamp(1, 64)
            }
            "--connect-concurrency" => {
                o.connect_concurrency =
                    parse_or_default("--connect-concurrency", args.next(), o.connect_concurrency)
                        .max(1)
            }
            "--json-out" => o.json_out = args.next(),
            other => eprintln!("broadcast-client: ignoring unknown flag '{other}'"),
        }
    }
    o.probe_cohort = o.probe_cohort.min(o.sessions);
    o
}

/* -------------------------------------------------------------------------- */
/* Accounting                                                                  */
/* -------------------------------------------------------------------------- */

/// One broadcast, as this host saw it. The spread is `max − min` across the
/// subscribers that received *this* sequence number, which is why the slot
/// carries extremes rather than samples.
struct MessageSlot {
    received: AtomicU64,
    first_ns: AtomicU64,
    last_ns: AtomicU64,
    /// The arm byte the copies carried. Copies of one sequence all come from one
    /// pass, so a disagreement here is a wire defect and is counted as one.
    arm: AtomicU64,
    arm_conflicts: AtomicU64,
}

impl MessageSlot {
    fn new() -> MessageSlot {
        MessageSlot {
            received: AtomicU64::new(0),
            first_ns: AtomicU64::new(u64::MAX),
            last_ns: AtomicU64::new(0),
            arm: AtomicU64::new(u64::MAX),
            arm_conflicts: AtomicU64::new(0),
        }
    }

    fn record(&self, arm: usize, at_ns: u64) {
        self.received.fetch_add(1, Ordering::Relaxed);
        self.first_ns.fetch_min(at_ns, Ordering::Relaxed);
        self.last_ns.fetch_max(at_ns, Ordering::Relaxed);
        let arm = arm as u64;
        match self
            .arm
            .compare_exchange(u64::MAX, arm, Ordering::Relaxed, Ordering::Relaxed)
        {
            Ok(_) => {}
            Err(existing) if existing == arm => {}
            Err(_) => {
                self.arm_conflicts.fetch_add(1, Ordering::Relaxed);
            }
        }
    }
}

/// Per-arm receive-side aggregates. Every percentile this gate reads from the
/// Mac is one of these histograms.
struct ArmAgg {
    received: AtomicU64,
    spread: AtomicHistogram,
    rtt: AtomicHistogram,
    probe_lag: AtomicHistogram,
    probe_echoes: AtomicU64,
    messages_observed: AtomicU64,
    messages_complete: AtomicU64,
}

impl ArmAgg {
    fn new() -> ArmAgg {
        ArmAgg {
            received: AtomicU64::new(0),
            spread: AtomicHistogram::new(),
            rtt: AtomicHistogram::new(),
            probe_lag: AtomicHistogram::new(),
            probe_echoes: AtomicU64::new(0),
            messages_observed: AtomicU64::new(0),
            messages_complete: AtomicU64::new(0),
        }
    }
}

struct Shared {
    arms: Vec<ArmAgg>,
    slots: Vec<MessageSlot>,
    /// `[session][arm]` broadcast copies. The distribution of this is what C2b
    /// is actually about; the conductor divides it by what the emitter issued.
    per_subscriber: Vec<[AtomicU64; ARM_SLOTS]>,
    sessions_opened: AtomicU64,
    sessions_failed: AtomicU64,
    sessions_lost: AtomicU64,
    /// Arrivals with no decodable stamp. Counted, never dropped: an unstamped
    /// fraction that is not zero means the two ends disagree about the payload.
    undecodable: AtomicU64,
    /// Decodable but not a class this role expects.
    unexpected_class: AtomicU64,
    /// Sequence numbers past the table this rung sized. Never silently folded
    /// into the last slot.
    sequence_overflow: AtomicU64,
    probe_sent: AtomicU64,
    probe_intended: AtomicU64,
    probe_skipped: AtomicU64,
    probe_errors: AtomicU64,
    /// Echoes whose upstream send this process no longer has a lag for — an
    /// echo that outlived its own window, or a duplicate.
    probe_unmatched: AtomicU64,
    stop: AtomicBool,
    errors: Mutex<Vec<String>>,
}

impl Shared {
    fn new(sessions: usize, slots: usize) -> Shared {
        Shared {
            arms: (0..ARM_SLOTS).map(|_| ArmAgg::new()).collect(),
            slots: (0..slots).map(|_| MessageSlot::new()).collect(),
            per_subscriber: (0..sessions)
                .map(|_| std::array::from_fn(|_| AtomicU64::new(0)))
                .collect(),
            sessions_opened: AtomicU64::new(0),
            sessions_failed: AtomicU64::new(0),
            sessions_lost: AtomicU64::new(0),
            undecodable: AtomicU64::new(0),
            unexpected_class: AtomicU64::new(0),
            sequence_overflow: AtomicU64::new(0),
            probe_sent: AtomicU64::new(0),
            probe_intended: AtomicU64::new(0),
            probe_skipped: AtomicU64::new(0),
            probe_errors: AtomicU64::new(0),
            probe_unmatched: AtomicU64::new(0),
            stop: AtomicBool::new(false),
            errors: Mutex::new(Vec::new()),
        }
    }

    fn record_error(&self, e: String) {
        if let Ok(mut recorded) = self.errors.lock() {
            if recorded.len() < MAX_RECORDED_ERRORS {
                recorded.push(e);
            }
        }
    }

    fn note_broadcast(&self, session: usize, sequence: u64, arm: u8, at_ns: u64) {
        let arm = arm_slot(arm);
        self.arms[arm].received.fetch_add(1, Ordering::Relaxed);
        if let Some(counts) = self.per_subscriber.get(session) {
            counts[arm].fetch_add(1, Ordering::Relaxed);
        }
        // Sequence numbers start at 1 (the conductor increments before it
        // stamps), so slot 0 is sequence 1.
        match sequence
            .checked_sub(1)
            .and_then(|i| usize::try_from(i).ok())
            .and_then(|i| self.slots.get(i))
        {
            Some(slot) => slot.record(arm, at_ns),
            None => {
                self.sequence_overflow.fetch_add(1, Ordering::Relaxed);
            }
        }
    }

    /// Fold the per-sequence extremes into the per-arm spread histograms. Run
    /// once, after the window, because a spread is only a spread when the
    /// broadcast it belongs to has finished arriving.
    fn seal_spreads(&self, subscribers: usize, completeness_floor: f64) {
        for slot in &self.slots {
            let received = slot.received.load(Ordering::Relaxed);
            if received == 0 {
                continue;
            }
            let arm = match slot.arm.load(Ordering::Relaxed) {
                a if a < ARM_SLOTS as u64 => a as usize,
                _ => 0,
            };
            self.arms[arm]
                .messages_observed
                .fetch_add(1, Ordering::Relaxed);
            if subscribers == 0 {
                continue;
            }
            let completeness = received as f64 / subscribers as f64;
            if completeness < completeness_floor {
                // §C1: an incomplete broadcast has a *narrower* spread than a
                // complete one, so letting it into the percentile would let a
                // delivery failure read as a latency success.
                continue;
            }
            self.arms[arm]
                .messages_complete
                .fetch_add(1, Ordering::Relaxed);
            let first = slot.first_ns.load(Ordering::Relaxed);
            let last = slot.last_ns.load(Ordering::Relaxed);
            self.arms[arm].spread.record(last.saturating_sub(first));
        }
    }
}

fn arm_slot(arm: u8) -> usize {
    match arm {
        ARM_A1 => 1,
        ARM_A2 => 2,
        ARM_A3 => 3,
        _ => 0,
    }
}

fn arm_name(slot: usize) -> &'static str {
    match slot {
        1 => "A1",
        2 => "A2",
        3 => "A3",
        _ => "NONE",
    }
}

/* -------------------------------------------------------------------------- */
/* Report                                                                      */
/* -------------------------------------------------------------------------- */

fn ms(ns: Option<u64>) -> String {
    match ns {
        Some(v) => format!("{:.6}", v as f64 / 1e6),
        None => "null".to_string(),
    }
}

/// The distribution of per-subscriber receive counts for one arm, as
/// `{"<count>": <subscribers>}`. Every session has an entry, including the ones
/// that received nothing — a subscriber that vanished from the report would be a
/// subscriber C2b cannot fail on.
fn subscriber_count_json(shared: &Shared, arm: usize) -> String {
    let mut buckets: HashMap<u64, u64> = HashMap::new();
    for counts in &shared.per_subscriber {
        *buckets
            .entry(counts[arm].load(Ordering::Relaxed))
            .or_insert(0) += 1;
    }
    let mut pairs: Vec<(u64, u64)> = buckets.into_iter().collect();
    pairs.sort_unstable();
    let body = pairs
        .iter()
        .map(|(received, subscribers)| format!("\"{received}\":{subscribers}"))
        .collect::<Vec<_>>()
        .join(",");
    format!("{{{body}}}")
}

fn report_json(shared: &Shared, options: &Options, alive: u64) -> String {
    let mut per_arm = Vec::new();
    for slot in 1..ARM_SLOTS {
        let agg = &shared.arms[slot];
        per_arm.push(format!(
            concat!(
                "\"{}\":{{",
                "\"messagesObserved\":{},\"messagesComplete\":{},\"received\":{},",
                "\"spreadP99Ms\":{},\"spreadHistogram\":{},",
                "\"rttP99Ms\":{},\"rttHistogram\":{},",
                "\"probeEchoes\":{},\"probeLagP99Ms\":{},\"probeLagHistogram\":{},",
                "\"negativeSamples\":{},",
                "\"subscriberReceivedCounts\":{}",
                "}}"
            ),
            arm_name(slot),
            agg.messages_observed.load(Ordering::Relaxed),
            agg.messages_complete.load(Ordering::Relaxed),
            agg.received.load(Ordering::Relaxed),
            ms(agg.spread.percentile_ns(0.99)),
            agg.spread.to_json(),
            ms(agg.rtt.percentile_ns(0.99)),
            agg.rtt.to_json(),
            agg.probe_echoes.load(Ordering::Relaxed),
            ms(agg.probe_lag.percentile_ns(0.99)),
            agg.probe_lag.to_json(),
            // Disclosed per arm as well as inside each histogram, because V-N
            // reads "any spread or RTT histogram" and a reader should not have
            // to parse three fragments to answer it.
            agg.spread.negative_count() + agg.rtt.negative_count(),
            subscriber_count_json(shared, slot),
        ));
    }
    let intended = shared.probe_intended.load(Ordering::Relaxed);
    let sent = shared.probe_sent.load(Ordering::Relaxed);
    let offered = if intended == 0 {
        "null".to_string()
    } else {
        format!("{:.6}", sent as f64 / intended as f64)
    };
    let errors = shared
        .errors
        .lock()
        .map(|e| {
            e.iter()
                .map(|s| format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\"")))
                .collect::<Vec<_>>()
                .join(",")
        })
        .unwrap_or_default();
    format!(
        concat!(
            "{{\"role\":\"broadcast-subscriber\",",
            "\"sessions\":{},\"sessionsFailed\":{},\"sessionsLost\":{},\"sessionsAliveAtEnd\":{},",
            "\"subscribers\":{},\"probeCohort\":{},\"windowSeconds\":{:.3},",
            "\"undecodable\":{},\"unexpectedClass\":{},\"sequenceOverflow\":{},",
            "\"unattributedReceived\":{},\"unattributedProbeEchoes\":{},",
            "\"probeSent\":{},\"probeIntended\":{},\"probeSkipped\":{},\"probeErrors\":{},",
            "\"probeUnmatched\":{},\"offeredRatio\":{},",
            "\"perArm\":{{{}}},\"errors\":[{}]}}"
        ),
        shared.sessions_opened.load(Ordering::Relaxed),
        shared.sessions_failed.load(Ordering::Relaxed),
        shared.sessions_lost.load(Ordering::Relaxed),
        alive,
        options.sessions,
        options.probe_cohort,
        options.seconds,
        shared.undecodable.load(Ordering::Relaxed),
        shared.unexpected_class.load(Ordering::Relaxed),
        shared.sequence_overflow.load(Ordering::Relaxed),
        shared.arms[0].received.load(Ordering::Relaxed),
        // Echoes the server stamped `ARM_NONE` because no arm was emitting when
        // it answered — the establish ramp and the drain grace. No per-arm
        // percentile reads them; the count is here so the size of that window is
        // visible rather than merely excluded.
        shared.arms[0].probe_echoes.load(Ordering::Relaxed),
        sent,
        intended,
        shared.probe_skipped.load(Ordering::Relaxed),
        shared.probe_errors.load(Ordering::Relaxed),
        shared.probe_unmatched.load(Ordering::Relaxed),
        offered,
        per_arm.join(","),
        errors,
    )
}

/* -------------------------------------------------------------------------- */
/* Entry                                                                       */
/* -------------------------------------------------------------------------- */

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let options = parse_args();
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    runtime.block_on(run(options))
}

/// The per-sequence table. Sized from the rung's own rate and window with a 2x
/// margin, floored so a `--rate 0` pre-check still has somewhere to put a stray
/// broadcast rather than reporting it as an overflow.
fn slot_capacity(rate: f64, seconds: f64, grace: f64) -> usize {
    let expected = (rate.max(0.0) * (seconds.max(0.0) + grace.max(0.0)) * 2.0).ceil();
    (expected as usize).clamp(4_096, 4_000_000)
}

type ClientEndpoint = Endpoint<wtransport::endpoint::endpoint_side::Client>;

fn build_endpoints(count: usize) -> Result<Vec<Arc<ClientEndpoint>>, Box<dyn std::error::Error>> {
    let mut endpoints = Vec::with_capacity(count);
    for _ in 0..count {
        let config = ClientConfig::builder()
            .with_bind_default()
            .with_no_cert_validation()
            .keep_alive_interval(Some(KEEP_ALIVE))
            .max_idle_timeout(Some(MAX_IDLE))?
            .build();
        endpoints.push(Arc::new(Endpoint::client(config)?));
    }
    Ok(endpoints)
}

async fn run(options: Options) -> Result<(), Box<dyn std::error::Error>> {
    println!(
        "broadcast-client: url={} sessions={} probeCohort={} probeHz={} payloadBytes={} rate={} seconds={}",
        options.url,
        options.sessions,
        options.probe_cohort,
        options.probe_hz,
        options.payload_bytes,
        options.rate,
        options.seconds
    );

    let capacity = slot_capacity(options.rate, options.seconds, options.drain_grace_sec);
    let shared = Arc::new(Shared::new(options.sessions, capacity));
    let endpoints = build_endpoints(options.endpoints)?;

    let mut handles = Vec::with_capacity(options.sessions);
    let established = Arc::new(tokio::sync::Semaphore::new(0));
    let gate = Arc::new(tokio::sync::Semaphore::new(options.connect_concurrency));

    for index in 0..options.sessions {
        let endpoint = Arc::clone(&endpoints[index % endpoints.len()]);
        let shared = Arc::clone(&shared);
        let established = Arc::clone(&established);
        let gate = Arc::clone(&gate);
        let url = options.url.clone();
        let options = options.clone();
        handles.push(tokio::spawn(async move {
            let permit = gate.acquire_owned().await.ok();
            let conn = match endpoint.connect(&url).await {
                Ok(conn) => {
                    shared.sessions_opened.fetch_add(1, Ordering::Relaxed);
                    conn
                }
                Err(e) => {
                    shared.sessions_failed.fetch_add(1, Ordering::Relaxed);
                    shared.record_error(format!("connect {index}: {e}"));
                    return;
                }
            };
            drop(permit);
            established.add_permits(1);
            let probes = index < options.probe_cohort;
            if probes {
                run_probe_session(index, conn, &options, Arc::clone(&shared)).await;
            } else {
                run_subscriber_session(index, conn, shared.as_ref()).await;
            }
        }));
    }

    // The establish barrier. The conductor has its own — it waits on the
    // server's `sessionsActive` — but this process must not start its window
    // before its own last session exists either, or the early part of the
    // window would be a smaller fleet reported as this one.
    let establish_deadline = Instant::now() + Duration::from_secs(600);
    let mut ready = 0usize;
    while ready < options.sessions && Instant::now() < establish_deadline {
        match tokio::time::timeout(Duration::from_secs(5), established.acquire()).await {
            Ok(Ok(permit)) => {
                permit.forget();
                ready += 1;
                if ready.is_multiple_of(1_000) || ready == options.sessions {
                    println!("broadcast-client: established {ready}/{}", options.sessions);
                }
            }
            Ok(Err(_)) => break,
            Err(_) => {
                let failed = shared.sessions_failed.load(Ordering::Relaxed) as usize;
                println!(
                    "broadcast-client: establishing {ready}/{} (failed {failed})",
                    options.sessions
                );
                if ready + failed >= options.sessions {
                    break;
                }
            }
        }
    }
    println!(
        "broadcast-client: fleet {} established, {} failed — window {}s + {}s drain",
        shared.sessions_opened.load(Ordering::Relaxed),
        shared.sessions_failed.load(Ordering::Relaxed),
        options.seconds,
        options.drain_grace_sec
    );

    tokio::time::sleep(Duration::from_secs_f64(
        options.seconds.max(0.0) + options.drain_grace_sec.max(0.0),
    ))
    .await;
    shared.stop.store(true, Ordering::Relaxed);

    let alive = shared
        .sessions_opened
        .load(Ordering::Relaxed)
        .saturating_sub(shared.sessions_lost.load(Ordering::Relaxed));
    shared.seal_spreads(options.sessions, COMPLETENESS_FLOOR);

    let json = report_json(shared.as_ref(), &options, alive);
    if let Some(path) = options.json_out.as_deref() {
        if let Err(e) = std::fs::write(path, format!("{json}\n")) {
            eprintln!("broadcast-client: could not write {path}: {e}");
        }
    }
    println!("broadcast-client: json {json}");
    let _ = std::io::Write::flush(&mut std::io::stdout());

    for handle in &handles {
        handle.abort();
    }
    Ok(())
}

/// §C1's completeness guard, mirrored from `MESSAGE_COMPLETENESS_FLOOR` in
/// `tools/load/g10-plan.ts`. It lives on both sides because the spread is
/// computed here and the exclusion fraction is judged there, and V-X compares
/// them.
const COMPLETENESS_FLOOR: f64 = 0.999;

/// A receive-only subscriber: 9,900 of the 10,000. No ticker, no `select!` —
/// just the datagram path, because every branch this task does not have is a
/// branch that cannot delay a receive instant the spread is computed from.
async fn run_subscriber_session(index: usize, conn: wtransport::Connection, shared: &Shared) {
    loop {
        match conn.receive_datagram().await {
            Ok(datagram) => {
                let at_ns = monotonic_ns();
                consume(index, datagram.as_ref(), at_ns, shared, None);
            }
            Err(_) => {
                if !shared.stop.load(Ordering::Relaxed) {
                    shared.sessions_lost.fetch_add(1, Ordering::Relaxed);
                }
                return;
            }
        }
    }
}

/// A probe-cohort subscriber: everything above, plus its own upstream datagram
/// on a cumulative-deadline grid and the server's echo of it.
///
/// The grid is cumulative — the n-th deadline is `start + phase + n × period`,
/// never `previous + period` — so a late send cannot walk the whole schedule
/// forward, and a deadline already more than a period in the past is skipped and
/// counted rather than caught up. Catching up would emit a burst this role never
/// offers and would report a lag it created itself.
/// How far ahead of a probe deadline the coarse sleep hands over to spinning.
/// Every async-runtime timer on this rig wakes milliseconds late (measured on
/// an idle Mac, launchd Background context: tokio `sleep_until` p99 7.2 ms,
/// bare `thread::sleep` p99 3.1 ms — `crates/reference/tests/timer_precision.rs`
/// re-measures it), which is §7 V-F's exact failure. Sleeping to the window's
/// edge and spinning the rest measured p99 1.25 ms on the same rig.
// 10 ms, not 4: even at user-interactive QoS this Mac's coarse sleep still
// wakes >4 ms late about 1% of the time (cable floor arm read scheduleLag
// p99 3.76 ms with a 4 ms window — every miss past the window is raw lag).
// The widened window prices at ~2 core-seconds/s at the gate's 100 × 2 Hz
// cadence, phased, on a 10-core generator; the floor arm's 20 × 2 Hz is a
// fifth of that.
const PROBE_SPIN_WINDOW: Duration = Duration::from_millis(10);

/// Cross `deadline - now`, arriving on time: coarse `thread::sleep` to the
/// spin window's edge, then spin to the instant. Only ever runs on a probe
/// timing thread, never on a runtime worker.
fn sleep_until_precise(deadline: Instant) {
    let coarse = deadline - PROBE_SPIN_WINDOW;
    let now = Instant::now();
    if coarse > now {
        std::thread::sleep(coarse - now);
    }
    while Instant::now() < deadline {
        std::hint::spin_loop();
    }
}

/// The probe role, split across two executors on purpose. The async half is a
/// pure receiver — identical shape to `run_subscriber_session`, so a probe's
/// receive instants carry no branch a subscriber's do not. The timing half is
/// a dedicated OS thread per probe session: `send_datagram` is synchronous in
/// wtransport, so the send leaves from the thread that kept the deadline, and
/// the probe's cadence never rides the async runtime's timer wheel (whose
/// wakeup tail is what V-F bounds — see `PROBE_SPIN_WINDOW`).
///
/// The window is sized to the host's own wake tail, not to elegance: ~1% of
/// thread wakes on the bench Mac arrive ≥9 ms late whatever primitive armed
/// them, so a window under that keeps V-F's p99 exactly where the tail is.
/// Up to `PROBE_SPIN_WINDOW` — 10 ms — of spinning per probe per period is the
/// disclosed price of a p99 the scheduler cannot write; at the gate's
/// 100 × 2 Hz cadence that is ~2 core-seconds per second on a 10-core
/// generator, phased so at most a few spin at once. (This paragraph and
/// `PROBE_SPIN_WINDOW`'s own comment quoted 16 ms and ≤3.2 core-seconds/s
/// from the pre-widening revision; both now quote the constant.)
async fn run_probe_session(
    index: usize,
    conn: wtransport::Connection,
    options: &Options,
    shared: Arc<Shared>,
) {
    let pending: Arc<Mutex<HashMap<u64, u64>>> = Arc::new(Mutex::new(HashMap::new()));

    let sender = {
        let conn = conn.clone();
        let pending = Arc::clone(&pending);
        let shared = Arc::clone(&shared);
        let payload_bytes = options.payload_bytes.max(STAMP_BYTES_V4);
        let probe_hz = options.probe_hz;
        let probe_cohort = options.probe_cohort;
        std::thread::spawn(move || {
            if probe_hz <= 0.0 {
                return;
            }
            // An ssh session's threads run at background QoS on macOS, where
            // the scheduler wakes them 5–10 ms late — past the spin window, so
            // the spin never runs and §7 V-F reads pure scheduler latency
            // (measured over the cable: p99 7.15 ms against the 2 ms floor).
            // User-interactive QoS is this thread asking for the wake latency
            // its deadline grid actually needs; it holds no lock and runs at
            // probe_hz, so the priority costs nobody anything.
            #[cfg(target_os = "macos")]
            unsafe {
                libc::pthread_set_qos_class_self_np(
                    libc::qos_class_t::QOS_CLASS_USER_INTERACTIVE,
                    0,
                );
            }
            let mut payload = vec![0u8; payload_bytes];
            let mut sequence = 0u64;
            let period = Duration::from_secs_f64(1.0 / probe_hz);
            // Phase the cohort across one period so a hundred probes do not
            // leave as one burst that the server would answer as one burst.
            let phase = if probe_cohort > 0 {
                period.mul_f64(index as f64 / probe_cohort as f64)
            } else {
                Duration::ZERO
            };
            let mut deadline = Instant::now() + phase;
            while !shared.stop.load(Ordering::Relaxed) {
                sleep_until_precise(deadline);
                shared.probe_intended.fetch_add(1, Ordering::Relaxed);
                let now = Instant::now();
                let lag = now.saturating_duration_since(deadline);
                deadline += period;
                if lag > period {
                    // Skipped and counted. `probe_intended` already counted it,
                    // so the offered ratio carries the miss.
                    shared.probe_skipped.fetch_add(1, Ordering::Relaxed);
                    while deadline < now {
                        deadline += period;
                    }
                    continue;
                }
                sequence += 1;
                let actual_ns = monotonic_ns();
                write_stamp_v4(
                    &mut payload,
                    actual_ns.saturating_sub(lag.as_nanos() as u64),
                    actual_ns,
                    sequence,
                    CLASS_PROBE,
                    // The probe does not know which arm is emitting; the arm on
                    // the echo is the server's answer, and it is the one the
                    // sample is attributed to.
                    ARM_NONE,
                );
                match conn.send_datagram(&payload) {
                    Ok(()) => {
                        shared.probe_sent.fetch_add(1, Ordering::Relaxed);
                        pending
                            .lock()
                            .expect("probe pending map poisoned")
                            .insert(sequence, lag.as_nanos() as u64);
                    }
                    Err(e) => {
                        // A dead connection will not recover; one record, not
                        // one per period until the window ends.
                        if !shared.stop.load(Ordering::Relaxed) {
                            shared.probe_errors.fetch_add(1, Ordering::Relaxed);
                            shared.record_error(format!("probe send {index}: {e}"));
                        }
                        return;
                    }
                }
            }
        })
    };

    loop {
        match conn.receive_datagram().await {
            Ok(datagram) => {
                let at_ns = monotonic_ns();
                let mut map = pending.lock().expect("probe pending map poisoned");
                consume(index, datagram.as_ref(), at_ns, &shared, Some(&mut map));
            }
            Err(_) => {
                if !shared.stop.load(Ordering::Relaxed) {
                    shared.sessions_lost.fetch_add(1, Ordering::Relaxed);
                }
                break;
            }
        }
    }
    // The timing thread exits on the stop flag or on its send failing after
    // the connection died; joining keeps the counters it writes ahead of the
    // report that reads them.
    let _ = tokio::task::spawn_blocking(move || {
        let _ = sender.join();
    })
    .await;
}

/// One arrival, classified. Split out so the probe and the receive-only session
/// classify by exactly one implementation — the alternative is two, and the one
/// that drifts is the one nobody reads.
fn consume(
    index: usize,
    bytes: &[u8],
    at_ns: u64,
    shared: &Shared,
    pending: Option<&mut HashMap<u64, u64>>,
) {
    let Some(stamp) = read_stamp(bytes) else {
        shared.undecodable.fetch_add(1, Ordering::Relaxed);
        return;
    };
    match stamp.class {
        CLASS_BROADCAST => shared.note_broadcast(index, stamp.sequence, stamp.arm, at_ns),
        CLASS_PROBE_ECHO => {
            let arm = arm_slot(stamp.arm);
            shared.arms[arm]
                .probe_echoes
                .fetch_add(1, Ordering::Relaxed);
            // Both instants are this process's own `CLOCK_MONOTONIC`: the echo
            // carries the client's earlier `actual` back in `echoActual`, which
            // is the only client-clock quantity on a downstream datagram.
            shared.arms[arm]
                .rtt
                .record_signed(at_ns as i64 - stamp.echo_actual_ns as i64);
            match pending.and_then(|p| p.remove(&stamp.sequence)) {
                Some(lag) => shared.arms[arm].probe_lag.record(lag),
                None => {
                    shared.probe_unmatched.fetch_add(1, Ordering::Relaxed);
                }
            }
        }
        _ => {
            shared.unexpected_class.fetch_add(1, Ordering::Relaxed);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shared_of(sessions: usize, slots: usize) -> Shared {
        Shared::new(sessions, slots)
    }

    fn broadcast_payload(sequence: u64, arm: u8) -> Vec<u8> {
        let mut buf = vec![0u8; 200];
        write_stamp_v4(&mut buf, 0, 0, sequence, CLASS_BROADCAST, arm);
        buf
    }

    fn echo_payload(sequence: u64, arm: u8, echo_actual_ns: u64) -> Vec<u8> {
        let mut buf = vec![0u8; 200];
        write_stamp_v4(&mut buf, 0, 0, sequence, CLASS_PROBE_ECHO, arm);
        buf[28..36].copy_from_slice(&echo_actual_ns.to_le_bytes());
        buf
    }

    #[test]
    fn arm_slots_map_the_wire_byte_and_nothing_else() {
        assert_eq!(arm_slot(ARM_A1), 1);
        assert_eq!(arm_slot(ARM_A2), 2);
        assert_eq!(arm_slot(ARM_A3), 3);
        // Anything else — including a version-3 payload's zero — lands in the
        // unattributed slot rather than in an arm's samples.
        assert_eq!(arm_slot(ARM_NONE), 0);
        assert_eq!(arm_slot(9), 0);
    }

    /// The spread is per sequence number across subscribers, which is the whole
    /// reason this role exists on the far host.
    #[test]
    fn spread_is_the_extremes_of_one_sequence() {
        let shared = shared_of(4, 16);
        for (session, at) in [
            (0, 1_000_000u64),
            (1, 2_000_000),
            (2, 3_000_000),
            (3, 9_000_000),
        ] {
            shared.note_broadcast(session, 1, ARM_A2, at);
        }
        shared.seal_spreads(4, 0.999);
        let p99 = shared.arms[2].spread.percentile_ns(0.99).expect("spread");
        // 9 ms − 1 ms, inside the histogram's own quantization.
        assert!((7_960_000..8_040_000).contains(&p99), "spread {p99}");
        assert_eq!(shared.arms[2].messages_complete.load(Ordering::Relaxed), 1);
        assert_eq!(shared.arms[2].messages_observed.load(Ordering::Relaxed), 1);
    }

    /// §C1's guard, and the reason it exists: an incomplete broadcast has a
    /// *narrower* spread, so admitting it would let a delivery failure read as a
    /// latency success.
    #[test]
    fn an_incomplete_broadcast_is_observed_but_never_measured() {
        let shared = shared_of(1_000, 16);
        for session in 0..500 {
            shared.note_broadcast(session, 1, ARM_A1, 1_000_000 + session as u64);
        }
        shared.seal_spreads(1_000, 0.999);
        assert_eq!(shared.arms[1].messages_observed.load(Ordering::Relaxed), 1);
        assert_eq!(shared.arms[1].messages_complete.load(Ordering::Relaxed), 0);
        assert_eq!(shared.arms[1].spread.count(), 0);
    }

    /// V-D, on this side of the wire: the spread histogram's own count has to be
    /// the number of messages the report calls complete, or the percentile spans
    /// a different set than the counter beside it claims.
    #[test]
    fn spread_histogram_count_equals_messages_complete() {
        let shared = shared_of(10, 64);
        for sequence in 1..=5u64 {
            for session in 0..10 {
                shared.note_broadcast(session, sequence, ARM_A3, 1_000_000 + sequence * 1_000);
            }
        }
        // One more that only half the fleet got.
        for session in 0..5 {
            shared.note_broadcast(session, 6, ARM_A3, 2_000_000);
        }
        shared.seal_spreads(10, 0.999);
        assert_eq!(shared.arms[3].messages_observed.load(Ordering::Relaxed), 6);
        assert_eq!(shared.arms[3].messages_complete.load(Ordering::Relaxed), 5);
        assert_eq!(shared.arms[3].spread.count(), 5);
    }

    /// A sequence past the table this rung sized is counted, never folded into
    /// the last slot — a fold would attach one broadcast's arrivals to another's
    /// extremes and produce a spread out of two different messages.
    #[test]
    fn sequences_past_the_table_are_counted_not_folded() {
        let shared = shared_of(2, 4);
        shared.note_broadcast(0, 4, ARM_A1, 1_000);
        shared.note_broadcast(0, 5, ARM_A1, 2_000);
        assert_eq!(shared.sequence_overflow.load(Ordering::Relaxed), 1);
        assert_eq!(shared.slots[3].received.load(Ordering::Relaxed), 1);
        // The overflowed copy still counts as received: it arrived.
        assert_eq!(shared.arms[1].received.load(Ordering::Relaxed), 2);
    }

    /// C2b is about the distribution, not the fleet ratio: the report has to
    /// carry every subscriber, including the ones that received nothing.
    #[test]
    fn subscriber_counts_include_the_starved_ones() {
        let shared = shared_of(3, 16);
        shared.note_broadcast(0, 1, ARM_A2, 10);
        shared.note_broadcast(1, 1, ARM_A2, 20);
        shared.note_broadcast(0, 2, ARM_A2, 30);
        let json = subscriber_count_json(&shared, 2);
        // subscriber 0 got 2, subscriber 1 got 1, subscriber 2 got none.
        assert_eq!(json, "{\"0\":1,\"1\":1,\"2\":1}");
    }

    /// An arm the wire never named must not become A1 by default.
    #[test]
    fn unattributed_copies_stay_unattributed() {
        let shared = shared_of(2, 16);
        shared.note_broadcast(0, 1, ARM_NONE, 10);
        assert_eq!(shared.arms[0].received.load(Ordering::Relaxed), 1);
        assert_eq!(shared.arms[1].received.load(Ordering::Relaxed), 0);
    }

    /// One sequence number carrying two arms is a wire defect, and it is counted
    /// rather than resolved by whichever copy happened to arrive first.
    #[test]
    fn a_sequence_that_claims_two_arms_is_counted_as_a_conflict() {
        let shared = shared_of(2, 16);
        shared.note_broadcast(0, 1, ARM_A1, 10);
        shared.note_broadcast(1, 1, ARM_A2, 20);
        assert_eq!(shared.slots[0].arm_conflicts.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn undecodable_arrivals_are_counted_never_dropped() {
        let shared = shared_of(1, 16);
        consume(0, &[0u8; 200], 0, &shared, None);
        assert_eq!(shared.undecodable.load(Ordering::Relaxed), 1);
        consume(0, &broadcast_payload(1, ARM_A1), 5_000, &shared, None);
        assert_eq!(shared.undecodable.load(Ordering::Relaxed), 1);
        assert_eq!(shared.arms[1].received.load(Ordering::Relaxed), 1);
    }

    /// RTT is `receive − echoActual`, both on this host's clock, and the sample
    /// is attributed to the arm the *echo* carried.
    #[test]
    fn an_echo_lands_its_rtt_and_its_lag_on_the_echos_arm() {
        let shared = shared_of(1, 16);
        let mut pending: HashMap<u64, u64> = HashMap::new();
        pending.insert(7, 400_000);
        consume(
            0,
            &echo_payload(7, ARM_A3, 1_000_000),
            4_000_000,
            &shared,
            Some(&mut pending),
        );
        assert_eq!(shared.arms[3].probe_echoes.load(Ordering::Relaxed), 1);
        let rtt = shared.arms[3].rtt.percentile_ns(0.99).expect("rtt");
        assert!((2_985_000..3_015_000).contains(&rtt), "rtt {rtt}");
        let lag = shared.arms[3].probe_lag.percentile_ns(0.99).expect("lag");
        assert!((398_000..402_000).contains(&lag), "lag {lag}");
        assert!(pending.is_empty());
        assert_eq!(shared.probe_unmatched.load(Ordering::Relaxed), 0);
    }

    /// An echo whose upstream send this process no longer has is counted, not
    /// given a lag of zero — a zero would flatter the very percentile V-A reads.
    #[test]
    fn an_unmatched_echo_contributes_no_lag_sample() {
        let shared = shared_of(1, 16);
        let mut pending: HashMap<u64, u64> = HashMap::new();
        consume(
            0,
            &echo_payload(7, ARM_A1, 1_000_000),
            4_000_000,
            &shared,
            Some(&mut pending),
        );
        assert_eq!(shared.probe_unmatched.load(Ordering::Relaxed), 1);
        assert_eq!(shared.arms[1].probe_lag.count(), 0);
        assert_eq!(shared.arms[1].rtt.count(), 1);
    }

    /// A clock that ran backwards is a broken assumption, not a fast round trip.
    #[test]
    fn a_negative_rtt_is_counted_apart() {
        let shared = shared_of(1, 16);
        let mut pending: HashMap<u64, u64> = HashMap::new();
        consume(
            0,
            &echo_payload(1, ARM_A2, 9_000_000),
            1_000_000,
            &shared,
            Some(&mut pending),
        );
        assert_eq!(shared.arms[2].rtt.count(), 0);
        assert!(shared.arms[2].rtt.to_json().contains("\"negative\":1"));
    }

    /// The conductor parses exactly one line shape. A report with a newline in
    /// it is a report the conductor does not see.
    #[test]
    fn the_report_is_one_line_and_parses_as_the_conductors_shape() {
        let shared = shared_of(2, 16);
        shared.note_broadcast(0, 1, ARM_A2, 10);
        shared.note_broadcast(1, 1, ARM_A2, 20);
        shared.seal_spreads(2, 0.999);
        let options = Options {
            sessions: 2,
            probe_cohort: 1,
            ..Options::default()
        };
        let json = report_json(&shared, &options, 2);
        assert!(!json.contains('\n'), "{json}");
        assert!(json.starts_with('{') && json.ends_with('}'), "{json}");
        for key in [
            "\"perArm\"",
            "\"A1\"",
            "\"A2\"",
            "\"A3\"",
            "\"spreadP99Ms\"",
            "\"spreadHistogram\"",
            "\"rttHistogram\"",
            "\"messagesComplete\"",
            "\"received\"",
            "\"subscriberReceivedCounts\"",
            "\"offeredRatio\"",
            "\"probeEchoes\"",
            "\"probeLagP99Ms\"",
        ] {
            assert!(json.contains(key), "missing {key} in {json}");
        }
        // The one field this role must never report, because it cannot know it.
        assert!(!json.contains("\"messagesIssued\""), "{json}");
    }

    /// The offered ratio is the probe grid's own honesty, and it is absent
    /// rather than 1.0 when no probe ever ran.
    #[test]
    fn offered_ratio_is_absent_when_no_probe_ran() {
        let shared = shared_of(1, 16);
        let json = report_json(&shared, &Options::default(), 1);
        assert!(json.contains("\"offeredRatio\":null"), "{json}");
        shared.probe_intended.store(100, Ordering::Relaxed);
        shared.probe_sent.store(98, Ordering::Relaxed);
        let json = report_json(&shared, &Options::default(), 1);
        assert!(json.contains("\"offeredRatio\":0.980000"), "{json}");
    }

    #[test]
    fn slot_capacity_covers_the_rung_and_floors_a_zero_rate() {
        assert_eq!(slot_capacity(0.0, 60.0, 10.0), 4_096);
        assert!(slot_capacity(20.0, 120.0, 10.0) >= 20 * 130);
        assert!(slot_capacity(1e9, 120.0, 10.0) <= 4_000_000);
    }

    #[test]
    fn probe_cohort_never_exceeds_the_fleet() {
        let mut o = Options {
            sessions: 10,
            probe_cohort: 50,
            ..Options::default()
        };
        o.probe_cohort = o.probe_cohort.min(o.sessions);
        assert_eq!(o.probe_cohort, 10);
    }
}
