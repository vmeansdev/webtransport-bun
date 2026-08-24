//! G6's MMO realm generator: a realm of players, a raid publisher, a raid
//! audience, and the reconnect storm.
//!
//! Companion to `tools/load/bench-g6.ts`; the ladder, the clauses and every
//! falsifier are in `docs/research/preregistrations/gate-g6-mmo.md`. This binary
//! offers load and measures the client half; it decides nothing.
//!
//! Three roles, because the fan-out arm needs three processes (ticket 14's
//! registered shape — an in-process publisher is how the retracted run produced
//! a 9–31 µs "ingest" path that never contained a network):
//!
//! * `realm`           — N players. Movement upstream at `--move-interval-ms`,
//!   every `--action-every`-th tick flagged `ACTION`, and a
//!   sink for the server's snapshot and ack classes. The
//!   ack's reflected token is what makes the round trip
//!   measurable on **one** clock, which is the only kind of
//!   latency statement an off-box generator can make.
//! * `publisher` — one raid event source.
//! * `raid-subscriber` — the 40 raid members, receive-only.
//!
//! The storm is here rather than in the harness for the reason ticket 30 gives:
//! the client is where a severed connection and its retry live. What the harness
//! must never do is *infer* the accept rate from this process's pacing — the
//! four-axes retraction showed `acceptsPerSec × mean accept latency ≈ 500` was
//! Little's law on this generator's own permit pool at every rung. So the storm
//! reconnects with **no permit pool at all** (`--storm-concurrency 0`), and the
//! accept series the gate reads is the server's own.

// Shared with the other load binaries so both ends of a stamp are one
// implementation. This binary writes v3 upstream and reads v3 downstream, so
// unlike `scale_client` it uses both halves.
#[allow(dead_code)]
mod latency_probe;

use latency_probe::{
    monotonic_ns, read_stamp, write_stamp_v3, AtomicHistogram, CLASS_ACK, CLASS_ACTION, CLASS_MOVE,
    CLASS_RAID, CLASS_RAID_JOIN, CLASS_SNAPSHOT, STAMP_BYTES_V3,
};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::{watch, Semaphore};
use wtransport::quinn;
use wtransport::{ClientConfig, Endpoint};

const DEFAULT_URL: &str = "https://127.0.0.1:4433";
const G6_CLOSEOUT_SPEC_ID: &str = "g6-mmo-closeout/1";
const G6_CLOSEOUT_SPEC_PATH: &str = "docs/research/preregistrations/gate-g6-mmo-closeout.md";
const KEEP_ALIVE: Duration = Duration::from_secs(15);
const MAX_IDLE: Duration = Duration::from_secs(60);
const MAX_RECORDED_ERRORS: usize = 5;
const JOIN_TIMEOUT: Duration = Duration::from_secs(20);
/// Grace for every session task to observe a phase change before counters are
/// snapshotted at that boundary. Carried from `scale_client`, same reason: a
/// session whose `select!` picked its ticker over the phase change would send a
/// datagram the server counts and this snapshot does not.
const PHASE_SETTLE: Duration = Duration::from_millis(250);
/// Self-guard ceiling for this process's own RSS. A generator that takes the
/// host down leaves no evidence behind; aborting costs one arm.
const CLIENT_RSS_LIMIT_MB: f64 = 12_288.0;
const RSS_GUARD_INTERVAL: Duration = Duration::from_secs(2);
const EXIT_RSS_GUARD: i32 = 91;
/// Application close code the severed cohort uses. Models a client-side
/// disconnect; the silent black-hole storm is registered as NOT covered
/// (gate-g6-mmo.md §1.8) because at a 60 s idle timeout the server's reaper
/// would dominate the window.
const SEVER_CLOSE_CODE: u32 = 0;

const PHASE_CONNECT: u8 = 0;
const PHASE_STEADY: u8 = 1;
const PHASE_STORM: u8 = 2;
const PHASE_POST: u8 = 3;
const PHASE_IDLE: u8 = 4;
const PHASE_STOP: u8 = 5;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Role {
    Realm,
    Publisher,
    RaidSubscriber,
}

impl Role {
    fn parse(raw: &str) -> Option<Role> {
        match raw {
            "realm" => Some(Role::Realm),
            "publisher" => Some(Role::Publisher),
            "raid-subscriber" | "raid" => Some(Role::RaidSubscriber),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Role::Realm => "realm",
            Role::Publisher => "publisher",
            Role::RaidSubscriber => "raid-subscriber",
        }
    }
}

#[derive(Clone)]
struct Options {
    role: Role,
    url: String,
    sessions: usize,
    endpoints: usize,
    connect_concurrency: usize,
    steady: Duration,
    idle: Duration,
    /// Upstream movement interval. 250 ms = the registered 4 pps (§1.2).
    send_interval: Duration,
    /// Every Nth upstream tick carries `ACTION` and draws an ack (§1.4).
    action_every: u64,
    payload_bytes: usize,
    connect_timeout: Duration,
    json_out: Option<String>,
    pre_registration_sha256: Option<String>,
    /// Session *i* of *N* phase-offsets by `i/N` of one interval. On for the
    /// steady realm (G1's registered process, T02's reason); the storm's
    /// alignment is a separate, deliberate thing and lives in the storm phase.
    stagger_sends: bool,
    /// Sessions severed when the storm fires. Zero disables the storm arm.
    storm_cohort: usize,
    storm_reconnect_delay: Duration,
    storm_window: Duration,
    /// Post-storm steady window, so the realm is seen to re-stabilize.
    post_storm: Duration,
    /// Permits the reconnect may use. **Zero means no pool**, which is the
    /// registered configuration: a pool is a semaphore, and a semaphore is what
    /// the retracted accept-rate figures were actually measuring.
    storm_concurrency: usize,
}

impl Options {
    fn defaults() -> Options {
        Options {
            role: Role::Realm,
            url: DEFAULT_URL.to_string(),
            sessions: 100,
            endpoints: 1,
            connect_concurrency: 500,
            steady: Duration::from_secs(120),
            idle: Duration::from_secs(30),
            send_interval: Duration::from_millis(250),
            action_every: 8,
            payload_bytes: 64,
            connect_timeout: Duration::from_secs(300),
            json_out: None,
            pre_registration_sha256: None,
            stagger_sends: true,
            storm_cohort: 0,
            storm_reconnect_delay: Duration::from_millis(1000),
            storm_window: Duration::from_secs(120),
            post_storm: Duration::from_secs(60),
            storm_concurrency: 0,
        }
    }
}

/* -------------------------------------------------------------------------- */
/* Pure helpers — everything a unit test can reach without a network           */
/* -------------------------------------------------------------------------- */

/// Offset of a session's first tick: half an interval, plus its share of the
/// staggered arrival process.
///
/// Half rather than a whole interval so no tick shares a timer slot with a phase
/// boundary — the window then holds `steady / interval` ticks exactly and the
/// offered-rate label is the nominal rate rather than one tick short of it.
/// Ported from `scale_client` deliberately: two generators that disagree about
/// their own denominator cannot be compared.
fn first_tick_offset(interval: Duration, phase_offset: f64) -> Duration {
    interval / 2 + interval.mul_f64(phase_offset.clamp(0.0, 1.0))
}

/// Ticks whose deadline has passed, `elapsed` into a phase using that offset.
fn ticks_due_after(elapsed: Duration, interval: Duration, phase_offset: f64) -> u64 {
    let interval_ns = interval.as_nanos();
    if interval_ns == 0 {
        return 0;
    }
    let first = first_tick_offset(interval, phase_offset);
    if elapsed < first {
        return 0;
    }
    u64::try_from((elapsed - first).as_nanos() / interval_ns + 1).unwrap_or(u64::MAX)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct TickObservation {
    intended_ns: u64,
    lag_ns: u64,
    skipped_ticks: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct ScheduleAccounting {
    due: u64,
    fired: u64,
    skipped: u64,
}

impl ScheduleAccounting {
    fn reconciled(self) -> bool {
        self.due == self.fired.saturating_add(self.skipped)
    }
}

fn saturating_u128_to_u64(value: u128) -> u64 {
    u64::try_from(value).unwrap_or(u64::MAX)
}

/// Convert a resolved Tokio tick into a monotonic intended timestamp and an
/// explicit count of skipped periods. With `MissedTickBehavior::Skip`, Tokio
/// already tells us which deadline fired; all that remains is to measure how
/// late that particular deadline was observed.
fn observe_tick(
    scheduled: tokio::time::Instant,
    observed: tokio::time::Instant,
    actual_ns: u64,
    interval: Duration,
) -> TickObservation {
    let lag = observed.saturating_duration_since(scheduled);
    let lag_ns = saturating_u128_to_u64(lag.as_nanos());
    let skipped_ticks = if interval.is_zero() {
        0
    } else {
        saturating_u128_to_u64(lag.as_nanos() / interval.as_nanos())
    };
    TickObservation {
        intended_ns: actual_ns.saturating_sub(lag_ns),
        lag_ns,
        skipped_ticks,
    }
}

#[cfg(test)]
fn schedule_accounting(
    elapsed: Duration,
    interval: Duration,
    phase_offset: f64,
    fired: u64,
    skipped: u64,
) -> ScheduleAccounting {
    ScheduleAccounting {
        due: ticks_due_after(elapsed, interval, phase_offset),
        fired,
        skipped,
    }
}

/// Class this tick carries. Every `action_every`-th movement tick is an action,
/// so the action rate falls out of one schedule instead of a second timer — one
/// schedule, one schedule-lag figure.
fn class_for_tick(sequence: u64, action_every: u64) -> u8 {
    if action_every > 0 && sequence.is_multiple_of(action_every) {
        CLASS_ACTION
    } else {
        CLASS_MOVE
    }
}

/// Whether session `index` is in the severed cohort. The cohort is the *first*
/// `cohort` indices and nothing about a session's behaviour depends on its
/// index otherwise, so "severed" and "survivor" are decided before the run and
/// cannot be chosen after it.
fn is_severed(index: usize, cohort: usize) -> bool {
    index < cohort
}

fn parse_or_default<T>(flag: &str, raw: Option<String>, default: T) -> T
where
    T: std::str::FromStr + Copy,
    <T as std::str::FromStr>::Err: std::fmt::Display,
{
    match raw {
        Some(v) => match v.parse::<T>() {
            Ok(parsed) => parsed,
            Err(e) => {
                eprintln!("mmo-client: invalid value for {flag} ('{v}'): {e}; using default");
                default
            }
        },
        None => default,
    }
}

fn self_rss_mb() -> Option<f64> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    let line = status.lines().find(|l| l.starts_with("VmRSS:"))?;
    let kb: f64 = line.split_whitespace().nth(1)?.parse().ok()?;
    Some(kb / 1024.0)
}

fn self_cpu_ms() -> Option<f64> {
    let stat = std::fs::read_to_string("/proc/self/stat").ok()?;
    let close = stat.rfind(')')?;
    let fields: Vec<&str> = stat[close + 1..].split_whitespace().collect();
    let utime: f64 = fields.get(11)?.parse().ok()?;
    let stime: f64 = fields.get(12)?.parse().ok()?;
    Some((utime + stime) * 1000.0 / 100.0)
}

fn percentile(sorted: &[u64], p: f64) -> Option<u64> {
    if sorted.is_empty() {
        return None;
    }
    let idx = ((sorted.len() as f64 - 1.0) * p).round() as usize;
    sorted.get(idx).copied()
}

fn json_num(v: Option<f64>) -> String {
    match v {
        Some(n) if n.is_finite() => format!("{n:.3}"),
        _ => "null".to_string(),
    }
}

fn json_u64(v: Option<u64>) -> String {
    match v {
        Some(n) => n.to_string(),
        None => "null".to_string(),
    }
}

fn json_string(v: Option<&str>) -> String {
    match v {
        Some(value) => format!("\"{}\"", escape(value)),
        None => "null".to_string(),
    }
}

fn escape(s: &str) -> String {
    s.chars()
        .flat_map(|c| match c {
            '"' => vec!['\\', '"'],
            '\\' => vec!['\\', '\\'],
            '\n' | '\r' | '\t' => vec![' '],
            c if (c as u32) < 0x20 => vec![' '],
            c => vec![c],
        })
        .collect()
}

/* -------------------------------------------------------------------------- */
/* Counters                                                                    */
/* -------------------------------------------------------------------------- */

/// One set of counters. Two instances exist during the storm: the realm's, and
/// the survivors' alone — §5.3 requires the survivor clause to be computed over
/// the survivor cohort and never over a realm-wide aggregate the reconnecting
/// cohort's own traffic would contaminate.
#[derive(Default)]
struct Counters {
    sent: AtomicU64,
    send_err: AtomicU64,
    ticks_due: AtomicU64,
    rx_snapshot: AtomicU64,
    rx_ack: AtomicU64,
    rx_raid: AtomicU64,
    rx_other: AtomicU64,
    rx_unstamped: AtomicU64,
    /// Acks whose reflected token was zero — a server that forgot to reflect.
    /// Counted rather than recorded as a round trip measured from the epoch.
    ack_unreflected: AtomicU64,
}

impl Counters {
    fn to_json(&self) -> String {
        format!(
            concat!(
                "{{\"sent\":{},\"sendErr\":{},\"ticksDue\":{},",
                "\"rxSnapshot\":{},\"rxAck\":{},\"rxRaid\":{},\"rxOther\":{},",
                "\"rxUnstamped\":{},\"ackUnreflected\":{}}}"
            ),
            self.sent.load(Ordering::Relaxed),
            self.send_err.load(Ordering::Relaxed),
            self.ticks_due.load(Ordering::Relaxed),
            self.rx_snapshot.load(Ordering::Relaxed),
            self.rx_ack.load(Ordering::Relaxed),
            self.rx_raid.load(Ordering::Relaxed),
            self.rx_other.load(Ordering::Relaxed),
            self.rx_unstamped.load(Ordering::Relaxed),
            self.ack_unreflected.load(Ordering::Relaxed),
        )
    }
}

#[derive(Default)]
struct SessionCounters {
    ok: AtomicU64,
    err: AtomicU64,
    lost: AtomicU64,
    connect_done: AtomicU64,
    /// Severed sessions that got back in. The *client's* view; the gate's accept
    /// series is the server's, and these two are never conflated.
    reconnect_ok: AtomicU64,
    reconnect_err: AtomicU64,
}

/// Per-window QUIC tap, summed over live connections. `frame_tx_datagram` is the
/// stage-ledger tap between "the client enqueued it" and "the wire carried it";
/// the gap is quinn's silent send-buffer eviction and is the only way a datagram
/// can vanish before the kernel sees it.
#[derive(Clone, Copy, Default)]
struct QuicTap {
    connections: u64,
    frame_tx_datagram: u64,
    frame_rx_datagram: u64,
    sent_packets: u64,
    lost_packets: u64,
}

impl QuicTap {
    fn add(&mut self, s: &quinn::ConnectionStats) {
        self.connections += 1;
        self.frame_tx_datagram += s.frame_tx.datagram;
        self.frame_rx_datagram += s.frame_rx.datagram;
        self.sent_packets += s.path.sent_packets;
        self.lost_packets += s.path.lost_packets;
    }

    fn delta(&self, base: &QuicTap) -> QuicTap {
        QuicTap {
            connections: self.connections,
            frame_tx_datagram: self
                .frame_tx_datagram
                .saturating_sub(base.frame_tx_datagram),
            frame_rx_datagram: self
                .frame_rx_datagram
                .saturating_sub(base.frame_rx_datagram),
            sent_packets: self.sent_packets.saturating_sub(base.sent_packets),
            lost_packets: self.lost_packets.saturating_sub(base.lost_packets),
        }
    }

    fn to_json(self) -> String {
        format!(
            concat!(
                "{{\"connections\":{},\"frameTxDatagram\":{},\"frameRxDatagram\":{},",
                "\"sentPackets\":{},\"lostPackets\":{}}}"
            ),
            self.connections,
            self.frame_tx_datagram,
            self.frame_rx_datagram,
            self.sent_packets,
            self.lost_packets,
        )
    }
}

type ConnRegistry = Arc<Mutex<Vec<quinn::Connection>>>;

fn sample_quic(registry: &ConnRegistry) -> QuicTap {
    let mut tap = QuicTap::default();
    let conns = match registry.lock() {
        Ok(c) => c,
        Err(poisoned) => poisoned.into_inner(),
    };
    for conn in conns.iter() {
        tap.add(&conn.stats());
    }
    tap
}

/// Everything a session task shares with the run.
struct Shared {
    realm: Counters,
    survivors: Counters,
    schedule_ticks_due: AtomicU64,
    schedule_ticks_fired: AtomicU64,
    schedule_ticks_skipped: AtomicU64,
    sessions: SessionCounters,
    /// Round trip on the ack class, all sessions, steady phase.
    rtt_steady: AtomicHistogram,
    /// Round trip on the ack class, survivors only, storm window (§5.3).
    rtt_storm_survivors: AtomicHistogram,
    /// One-way publisher→subscriber, raid subscribers only (§3).
    one_way: AtomicHistogram,
    /// Server dwell as the server reported it, for disclosure beside C3 (§6.3).
    server_hold: AtomicHistogram,
    /// This generator's own lag against its own schedule (§6.4).
    schedule_lag: AtomicHistogram,
    registry: ConnRegistry,
    errors: Mutex<Vec<String>>,
    latencies: Mutex<Vec<u64>>,
    reconnect_latencies: Mutex<Vec<u64>>,
}

impl Shared {
    fn new(capacity: usize) -> Shared {
        Shared {
            realm: Counters::default(),
            survivors: Counters::default(),
            schedule_ticks_due: AtomicU64::new(0),
            schedule_ticks_fired: AtomicU64::new(0),
            schedule_ticks_skipped: AtomicU64::new(0),
            sessions: SessionCounters::default(),
            rtt_steady: AtomicHistogram::new(),
            rtt_storm_survivors: AtomicHistogram::new(),
            one_way: AtomicHistogram::new(),
            server_hold: AtomicHistogram::new(),
            schedule_lag: AtomicHistogram::new(),
            registry: Arc::new(Mutex::new(Vec::with_capacity(capacity))),
            errors: Mutex::new(Vec::new()),
            latencies: Mutex::new(Vec::with_capacity(capacity)),
            reconnect_latencies: Mutex::new(Vec::new()),
        }
    }

    fn record_error(&self, e: String) {
        if let Ok(mut recorded) = self.errors.lock() {
            if recorded.len() < MAX_RECORDED_ERRORS {
                recorded.push(e);
            }
        }
    }
}

/* -------------------------------------------------------------------------- */
/* Endpoints                                                                   */
/* -------------------------------------------------------------------------- */

type ClientEndpoint = Endpoint<wtransport::endpoint::endpoint_side::Client>;

struct EndpointPool {
    endpoints: Vec<Arc<ClientEndpoint>>,
    distinct_source_ips: usize,
}

fn build_endpoints(count: usize) -> Result<EndpointPool, Box<dyn std::error::Error>> {
    let mut endpoints = Vec::with_capacity(count);
    let mut distinct_source_ips = 0usize;
    for k in 0..count {
        let mut endpoint = None;
        if count > 1 {
            let octet = u8::try_from(1 + (k % 250)).unwrap_or(1);
            let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::new(127, 0, octet, 1)), 0);
            let config = ClientConfig::builder()
                .with_bind_address(addr)
                .with_no_cert_validation()
                .keep_alive_interval(Some(KEEP_ALIVE))
                .max_idle_timeout(Some(MAX_IDLE))?
                .build();
            match Endpoint::client(config) {
                Ok(e) => {
                    distinct_source_ips += 1;
                    endpoint = Some(e);
                }
                Err(e) => eprintln!("mmo-client: bind {addr} failed ({e}); using default bind"),
            }
        }
        let endpoint = match endpoint {
            Some(e) => e,
            None => {
                let config = ClientConfig::builder()
                    .with_bind_default()
                    .with_no_cert_validation()
                    .keep_alive_interval(Some(KEEP_ALIVE))
                    .max_idle_timeout(Some(MAX_IDLE))?
                    .build();
                Endpoint::client(config)?
            }
        };
        endpoints.push(Arc::new(endpoint));
    }
    Ok(EndpointPool {
        endpoints,
        distinct_source_ips,
    })
}

fn spawn_rss_guard() {
    match self_rss_mb() {
        Some(rss) => {
            println!("mmo-client: rss guard armed limitMb={CLIENT_RSS_LIMIT_MB:.0} rssMb={rss:.1}")
        }
        None => println!("mmo-client: rss guard inactive (no /proc/self/status)"),
    }
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(RSS_GUARD_INTERVAL).await;
            let Some(rss) = self_rss_mb() else { continue };
            if rss > CLIENT_RSS_LIMIT_MB {
                println!(
                    "mmo-client: abort client-rss-guard rssMb={rss:.1} limitMb={CLIENT_RSS_LIMIT_MB:.0}"
                );
                let _ = std::io::Write::flush(&mut std::io::stdout());
                std::process::exit(EXIT_RSS_GUARD);
            }
        }
    });
}

/* -------------------------------------------------------------------------- */
/* Entry                                                                       */
/* -------------------------------------------------------------------------- */

fn parse_args() -> Options {
    let mut args = std::env::args().skip(1);
    let mut o = Options::defaults();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--role" => {
                let raw = args.next().unwrap_or_default();
                match Role::parse(&raw) {
                    Some(r) => o.role = r,
                    None => eprintln!("mmo-client: unknown --role '{raw}'; using realm"),
                }
            }
            "--url" => o.url = args.next().unwrap_or_else(|| DEFAULT_URL.to_string()),
            "--sessions" => o.sessions = parse_or_default("--sessions", args.next(), o.sessions),
            "--endpoints" => {
                o.endpoints =
                    parse_or_default("--endpoints", args.next(), o.endpoints).clamp(1, 250)
            }
            "--connect-concurrency" => {
                o.connect_concurrency =
                    parse_or_default("--connect-concurrency", args.next(), o.connect_concurrency)
                        .max(1)
            }
            "--steady-secs" => {
                o.steady = Duration::from_secs(parse_or_default(
                    "--steady-secs",
                    args.next(),
                    o.steady.as_secs(),
                ))
            }
            "--idle-secs" => {
                o.idle = Duration::from_secs(parse_or_default(
                    "--idle-secs",
                    args.next(),
                    o.idle.as_secs(),
                ))
            }
            "--send-interval-ms" => {
                o.send_interval = Duration::from_millis(
                    parse_or_default(
                        "--send-interval-ms",
                        args.next(),
                        o.send_interval.as_millis() as u64,
                    )
                    .max(1),
                )
            }
            "--action-every" => {
                o.action_every = parse_or_default("--action-every", args.next(), o.action_every)
            }
            "--payload-bytes" => {
                o.payload_bytes = parse_or_default("--payload-bytes", args.next(), o.payload_bytes)
                    // Every upstream datagram carries a version-3 stamp; a
                    // payload too short to hold one is not a smaller
                    // measurement, it is no measurement.
                    .max(STAMP_BYTES_V3)
            }
            "--connect-timeout-secs" => {
                o.connect_timeout = Duration::from_secs(parse_or_default(
                    "--connect-timeout-secs",
                    args.next(),
                    o.connect_timeout.as_secs(),
                ))
            }
            "--json-out" => o.json_out = args.next(),
            "--preregistration-sha256" => o.pre_registration_sha256 = args.next(),
            "--no-stagger" => o.stagger_sends = false,
            "--storm-cohort" => {
                o.storm_cohort = parse_or_default("--storm-cohort", args.next(), o.storm_cohort)
            }
            "--storm-reconnect-delay-ms" => {
                o.storm_reconnect_delay = Duration::from_millis(parse_or_default(
                    "--storm-reconnect-delay-ms",
                    args.next(),
                    o.storm_reconnect_delay.as_millis() as u64,
                ))
            }
            "--storm-window-secs" => {
                o.storm_window = Duration::from_secs(parse_or_default(
                    "--storm-window-secs",
                    args.next(),
                    o.storm_window.as_secs(),
                ))
            }
            "--post-storm-secs" => {
                o.post_storm = Duration::from_secs(parse_or_default(
                    "--post-storm-secs",
                    args.next(),
                    o.post_storm.as_secs(),
                ))
            }
            "--storm-concurrency" => {
                o.storm_concurrency =
                    parse_or_default("--storm-concurrency", args.next(), o.storm_concurrency)
            }
            _ => {}
        }
    }
    o
}

fn validate_pre_registration_sha256(
    value: Option<&str>,
) -> Result<String, Box<dyn std::error::Error>> {
    let Some(sha) = value else {
        return Err(
            "mmo-client: --preregistration-sha256 is required for mmo-client/2 reports".into(),
        );
    };
    if sha.len() != 64 || !sha.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(format!(
            "mmo-client: --preregistration-sha256 must be 64 hex chars, got '{sha}'"
        )
        .into());
    }
    Ok(sha.to_string())
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let options = parse_args();
    let pre_registration_sha256 =
        validate_pre_registration_sha256(options.pre_registration_sha256.as_deref())?;
    println!(
        "mmo-client: role={} url={} sessions={} endpoints={} interval={}ms actionEvery={} payload={}B steady={}s storm={}@{}s window={}s concurrency={} stagger={}",
        options.role.as_str(),
        options.url,
        options.sessions,
        options.endpoints,
        options.send_interval.as_millis(),
        options.action_every,
        options.payload_bytes,
        options.steady.as_secs(),
        options.storm_cohort,
        options.steady.as_secs(),
        options.storm_window.as_secs(),
        options.storm_concurrency,
        options.stagger_sends,
    );
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    rt.block_on(run(options, pre_registration_sha256))
}

async fn run(
    options: Options,
    pre_registration_sha256: String,
) -> Result<(), Box<dyn std::error::Error>> {
    spawn_rss_guard();
    let EndpointPool {
        endpoints,
        distinct_source_ips,
    } = build_endpoints(options.endpoints)?;
    let shared = Arc::new(Shared::new(options.sessions));
    let permits = Arc::new(Semaphore::new(options.connect_concurrency));
    // Zero means no pool. `Semaphore::new(usize::MAX >> 3)` is tokio's own
    // effectively-unbounded value; using it rather than skipping the acquire
    // keeps one code path, so the storm cannot accidentally take a different
    // one from the connect phase.
    let storm_permits = Arc::new(Semaphore::new(if options.storm_concurrency == 0 {
        Semaphore::MAX_PERMITS
    } else {
        options.storm_concurrency
    }));
    let (phase_tx, phase_rx) = watch::channel(PHASE_CONNECT);

    let cpu0 = self_cpu_ms();
    let connect_started = Instant::now();
    let mut handles = Vec::with_capacity(options.sessions);
    for i in 0..options.sessions {
        let endpoint = Arc::clone(&endpoints[i % endpoints.len()]);
        let shared = Arc::clone(&shared);
        let permits = Arc::clone(&permits);
        let storm_permits = Arc::clone(&storm_permits);
        let mut phase = phase_rx.clone();
        let options = options.clone();
        let phase_offset = if options.stagger_sends {
            i as f64 / options.sessions.max(1) as f64
        } else {
            0.0
        };
        handles.push(tokio::spawn(async move {
            let permit = match permits.acquire_owned().await {
                Ok(p) => p,
                Err(_) => return,
            };
            let started = Instant::now();
            let connected = endpoint.connect(&options.url).await;
            let elapsed_ms = started.elapsed().as_millis() as u64;
            drop(permit);
            let conn = match connected {
                Ok(conn) => {
                    shared.sessions.ok.fetch_add(1, Ordering::Relaxed);
                    if let Ok(mut l) = shared.latencies.lock() {
                        l.push(elapsed_ms);
                    }
                    conn
                }
                Err(e) => {
                    shared.sessions.err.fetch_add(1, Ordering::Relaxed);
                    shared.record_error(e.to_string());
                    shared.sessions.connect_done.fetch_add(1, Ordering::Relaxed);
                    return;
                }
            };
            if let Ok(mut live) = shared.registry.lock() {
                live.push(conn.quic_connection().clone());
            }
            shared.sessions.connect_done.fetch_add(1, Ordering::Relaxed);
            hold_session(
                i,
                conn,
                endpoint,
                storm_permits,
                &mut phase,
                &options,
                phase_offset,
                shared.as_ref(),
            )
            .await;
        }));
    }

    let connect_deadline = Instant::now() + options.connect_timeout;
    let mut connect_timed_out = false;
    loop {
        if shared.sessions.connect_done.load(Ordering::Relaxed) as usize >= options.sessions {
            break;
        }
        if Instant::now() >= connect_deadline {
            connect_timed_out = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let connect_wall = connect_started.elapsed();
    let cpu_after_connect = self_cpu_ms();
    println!(
        "mmo-client: connect phase done ok={} err={} wall={:.1}s timed_out={}",
        shared.sessions.ok.load(Ordering::Relaxed),
        shared.sessions.err.load(Ordering::Relaxed),
        connect_wall.as_secs_f64(),
        connect_timed_out
    );

    let quic_after_connect = sample_quic(&shared.registry);
    let _ = phase_tx.send(PHASE_STEADY);
    // Phase markers are line-buffered onto stdout so the harness snapshots
    // server-side counters at exactly the boundaries this process uses.
    println!("mmo-client: phase steady");
    tokio::time::sleep(options.steady).await;

    let storm_ran = options.storm_cohort > 0;
    if storm_ran {
        let _ = phase_tx.send(PHASE_STORM);
        println!("mmo-client: phase storm cohort={}", options.storm_cohort);
        tokio::time::sleep(options.storm_window).await;
        let _ = phase_tx.send(PHASE_POST);
        println!("mmo-client: phase post-storm");
        tokio::time::sleep(options.post_storm).await;
    }

    let _ = phase_tx.send(PHASE_IDLE);
    tokio::time::sleep(PHASE_SETTLE).await;
    let quic_after_drive = sample_quic(&shared.registry);
    let cpu_after_drive = self_cpu_ms();
    let rss_drive = self_rss_mb();
    println!("mmo-client: phase idle");
    tokio::time::sleep(options.idle.saturating_sub(PHASE_SETTLE)).await;
    let cpu_after_idle = self_cpu_ms();
    let rss_idle = self_rss_mb();

    let _ = phase_tx.send(PHASE_STOP);
    println!("mmo-client: phase stop");
    let join_deadline = Instant::now() + JOIN_TIMEOUT;
    while Instant::now() < join_deadline && handles.iter().any(|h| !h.is_finished()) {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    for h in &handles {
        if !h.is_finished() {
            h.abort();
        }
    }

    let mut accepts = shared
        .latencies
        .lock()
        .map(|l| l.clone())
        .unwrap_or_default();
    accepts.sort_unstable();
    let mut reconnects = shared
        .reconnect_latencies
        .lock()
        .map(|l| l.clone())
        .unwrap_or_default();
    reconnects.sort_unstable();
    let recorded_errors = shared.errors.lock().map(|e| e.clone()).unwrap_or_default();

    let window_ms = |from: Option<f64>, to: Option<f64>| match (from, to) {
        (Some(a), Some(b)) => Some(b - a),
        _ => None,
    };
    let schedule_due = shared.schedule_ticks_due.load(Ordering::Relaxed);
    let schedule_fired = shared.schedule_ticks_fired.load(Ordering::Relaxed);
    let schedule_skipped = shared.schedule_ticks_skipped.load(Ordering::Relaxed);
    let schedule_accounting = ScheduleAccounting {
        due: schedule_due,
        fired: schedule_fired,
        skipped: schedule_skipped,
    };
    let schedule_reconciled = schedule_accounting.reconciled();

    let json = format!(
        concat!(
            "{{",
            "\"schema\":\"mmo-client/2\",",
            "\"preRegistration\":{{\"id\":\"{}\",\"path\":\"{}\",\"sha256\":{}}},",
            "\"role\":\"{}\",",
            "\"staggerSends\":{},",
            "\"sessionsRequested\":{},",
            "\"sessionsOk\":{},",
            "\"sessionsErr\":{},",
            "\"sessionsLost\":{},",
            "\"connectWallSec\":{:.3},",
            "\"connectTimedOut\":{},",
            "\"connectConcurrency\":{},",
            "\"stormConcurrency\":{},",
            "\"stormCohort\":{},",
            "\"stormRan\":{},",
            "\"reconnectOk\":{},",
            "\"reconnectErr\":{},",
            "\"acceptMs\":{{\"p50\":{},\"p90\":{},\"p99\":{},\"max\":{}}},",
            "\"reconnectMs\":{{\"p50\":{},\"p90\":{},\"p99\":{},\"max\":{}}},",
            "\"scheduleTicksDue\":{},",
            "\"scheduleTicksFired\":{},",
            "\"scheduleTicksSkipped\":{},",
            "\"scheduleTicksReconciled\":{},",
            "\"realm\":{},",
            "\"survivors\":{},",
            "\"rttSteady\":{},",
            "\"rttStormSurvivors\":{},",
            "\"oneWay\":{},",
            "\"serverHold\":{},",
            "\"scheduleLag\":{},",
            "\"lifetime\":{{\"realm\":{},\"survivors\":{},\"rttSteady\":{},\"rttStormSurvivors\":{},\"oneWay\":{},\"serverHold\":{},\"scheduleLag\":{}}},",
            "\"quicDrive\":{},",
            "\"client\":{{\"rssMbDrive\":{},\"rssMbIdle\":{},\"cpuMsConnect\":{},\"cpuMsDrive\":{},\"cpuMsIdle\":{},\"endpoints\":{},\"distinctSourceIps\":{}}},",
            "\"config\":{{\"sendIntervalMs\":{},\"actionEvery\":{},\"payloadBytes\":{},\"steadySec\":{},\"stormWindowSec\":{},\"postStormSec\":{},\"idleSec\":{}}},",
            "\"connectErrorsSample\":[{}]",
            "}}"
        ),
        G6_CLOSEOUT_SPEC_ID,
        G6_CLOSEOUT_SPEC_PATH,
        json_string(Some(pre_registration_sha256.as_str())),
        options.role.as_str(),
        options.stagger_sends,
        options.sessions,
        shared.sessions.ok.load(Ordering::Relaxed),
        shared.sessions.err.load(Ordering::Relaxed),
        shared.sessions.lost.load(Ordering::Relaxed),
        connect_wall.as_secs_f64(),
        connect_timed_out,
        options.connect_concurrency,
        // Emitted as null when there was no pool, because "no permit pool" and
        // "a pool of some size" are the two states the Little's-law falsifier
        // distinguishes, and a zero would read as the second.
        if options.storm_concurrency == 0 {
            "null".to_string()
        } else {
            options.storm_concurrency.to_string()
        },
        options.storm_cohort,
        storm_ran,
        shared.sessions.reconnect_ok.load(Ordering::Relaxed),
        shared.sessions.reconnect_err.load(Ordering::Relaxed),
        json_u64(percentile(&accepts, 0.50)),
        json_u64(percentile(&accepts, 0.90)),
        json_u64(percentile(&accepts, 0.99)),
        json_u64(accepts.last().copied()),
        json_u64(percentile(&reconnects, 0.50)),
        json_u64(percentile(&reconnects, 0.90)),
        json_u64(percentile(&reconnects, 0.99)),
        json_u64(reconnects.last().copied()),
        schedule_due,
        schedule_fired,
        schedule_skipped,
        schedule_reconciled,
        shared.realm.to_json(),
        shared.survivors.to_json(),
        shared.rtt_steady.to_json(),
        shared.rtt_storm_survivors.to_json(),
        shared.one_way.to_json(),
        shared.server_hold.to_json(),
        shared.schedule_lag.to_json(),
        shared.realm.to_json(),
        shared.survivors.to_json(),
        shared.rtt_steady.to_json(),
        shared.rtt_storm_survivors.to_json(),
        shared.one_way.to_json(),
        shared.server_hold.to_json(),
        shared.schedule_lag.to_json(),
        quic_after_drive.delta(&quic_after_connect).to_json(),
        json_num(rss_drive),
        json_num(rss_idle),
        json_num(window_ms(cpu0, cpu_after_connect)),
        json_num(window_ms(cpu_after_connect, cpu_after_drive)),
        json_num(window_ms(cpu_after_drive, cpu_after_idle)),
        options.endpoints,
        distinct_source_ips,
        options.send_interval.as_millis(),
        options.action_every,
        options.payload_bytes,
        options.steady.as_secs(),
        options.storm_window.as_secs(),
        options.post_storm.as_secs(),
        options.idle.as_secs(),
        recorded_errors
            .iter()
            .map(|e| format!("\"{}\"", escape(e)))
            .collect::<Vec<_>>()
            .join(",")
    );

    if let Some(path) = &options.json_out {
        std::fs::write(path, format!("{json}\n"))?;
    }
    println!("mmo-client: json {json}");
    Ok(())
}

/* -------------------------------------------------------------------------- */
/* Session task                                                                */
/* -------------------------------------------------------------------------- */

/// Book this session's share of the offered denominator, once, at the instant it
/// stops sending. Measured from this session's own clock, so a session that
/// entered late or died early is charged for exactly the ticks its own schedule
/// reached — a shortfall against it is a generator that failed to source the
/// load and nothing else.
fn account_ticks(
    shared: &Shared,
    track_schedule: bool,
    started_at: tokio::time::Instant,
    interval: Duration,
    phase_offset: f64,
    accounted: &mut bool,
) {
    if !track_schedule {
        return;
    }
    if *accounted {
        return;
    }
    *accounted = true;
    let due = ticks_due_after(started_at.elapsed(), interval, phase_offset);
    shared.realm.ticks_due.fetch_add(due, Ordering::Relaxed);
    shared.schedule_ticks_due.fetch_add(due, Ordering::Relaxed);
}

fn record_reconnect_failure(
    shared: &Shared,
    track_schedule: bool,
    started_at: tokio::time::Instant,
    interval: Duration,
    phase_offset: f64,
    accounted: &mut bool,
    error: String,
) {
    account_ticks(
        shared,
        track_schedule,
        started_at,
        interval,
        phase_offset,
        accounted,
    );
    shared
        .sessions
        .reconnect_err
        .fetch_add(1, Ordering::Relaxed);
    shared.record_error(error);
}

/// Fold one received datagram into the right counters and the right histogram.
///
/// Split out of the session loop so the classification — which class was this,
/// does the ack carry a usable token, whose clock is the token on — is one
/// place, and so the "record a round trip measured from zero" mistake has to be
/// made deliberately rather than by omission.
fn record_arrival(
    payload: &[u8],
    now_ns: u64,
    severed: bool,
    phase: u8,
    shared: &Shared,
    realm: &Counters,
    survivors: &Counters,
) {
    let count_in = |c: &Counters, class: u8| match class {
        CLASS_SNAPSHOT => c.rx_snapshot.fetch_add(1, Ordering::Relaxed),
        CLASS_ACK => c.rx_ack.fetch_add(1, Ordering::Relaxed),
        CLASS_RAID => c.rx_raid.fetch_add(1, Ordering::Relaxed),
        _ => c.rx_other.fetch_add(1, Ordering::Relaxed),
    };
    let Some(stamp) = read_stamp(payload) else {
        realm.rx_unstamped.fetch_add(1, Ordering::Relaxed);
        if !severed && phase == PHASE_STORM {
            survivors.rx_unstamped.fetch_add(1, Ordering::Relaxed);
        }
        return;
    };
    count_in(realm, stamp.class);
    if !severed && phase == PHASE_STORM {
        count_in(survivors, stamp.class);
    }

    if stamp.class == CLASS_RAID {
        // Publisher and subscriber are two processes on ONE host, so `actual`
        // is a client-clock instant here and the one-way is honest. It is the
        // only one-way this gate can make; the client↔server legs are RTT-only.
        shared
            .one_way
            .record_signed(now_ns as i64 - stamp.actual_ns as i64);
        return;
    }

    if stamp.class != CLASS_ACK {
        return;
    }
    if stamp.echo_actual_ns == 0 {
        // The server did not reflect. Counted, never recorded: a round trip
        // measured from the epoch is not a small number, it is a wrong one.
        realm.ack_unreflected.fetch_add(1, Ordering::Relaxed);
        return;
    }
    let rtt = now_ns as i64 - stamp.echo_actual_ns as i64;
    if stamp.hold_ns > 0 {
        shared.server_hold.record(stamp.hold_ns);
    }
    match phase {
        PHASE_STEADY => shared.rtt_steady.record_signed(rtt),
        PHASE_STORM if !severed => shared.rtt_storm_survivors.record_signed(rtt),
        _ => {}
    }
}

#[allow(clippy::too_many_arguments)]
async fn hold_session(
    index: usize,
    conn: wtransport::Connection,
    endpoint: Arc<ClientEndpoint>,
    storm_permits: Arc<Semaphore>,
    phase: &mut watch::Receiver<u8>,
    options: &Options,
    phase_offset: f64,
    shared: &Shared,
) {
    while *phase.borrow() == PHASE_CONNECT {
        if phase.changed().await.is_err() {
            return;
        }
    }

    let severed = is_severed(index, options.storm_cohort);
    let receive_only = options.role == Role::RaidSubscriber;
    let track_schedule = !receive_only;
    let mut conn = conn;
    let mut payload = vec![b'x'; options.payload_bytes];
    let mut sequence: u64 = 0;
    let mut severed_yet = false;

    // The server has no path or authority to key a role off, so a receive-only
    // session says what it is exactly once. One datagram per subscriber, sent
    // before any measurement window opens, and excluded from every rate.
    if receive_only {
        let now = monotonic_ns();
        write_stamp_v3(&mut payload, now, now, 0, CLASS_RAID_JOIN);
        if conn.send_datagram(&payload).is_err() {
            shared.realm.send_err.fetch_add(1, Ordering::Relaxed);
        }
    }

    let started_at = tokio::time::Instant::now();
    let offset = first_tick_offset(options.send_interval, phase_offset);
    let mut ticker = tokio::time::interval_at(started_at + offset, options.send_interval);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut accounted = false;

    loop {
        let current = *phase.borrow();
        if current == PHASE_STOP {
            account_ticks(
                shared,
                track_schedule,
                started_at,
                options.send_interval,
                phase_offset,
                &mut accounted,
            );
            break;
        }

        // The storm, from this session's side: sever, wait the retry delay,
        // reconnect. The reconnect goes through a permit pool only if one was
        // configured; the registered configuration has none, so there is no
        // semaphore for Little's law to be measuring.
        if current == PHASE_STORM && severed && !severed_yet {
            severed_yet = true;
            conn.close(SEVER_CLOSE_CODE.into(), b"g6 storm sever");
            tokio::time::sleep(options.storm_reconnect_delay).await;
            let permit = storm_permits.clone().acquire_owned().await.ok();
            let started = Instant::now();
            let reconnected = endpoint.connect(&options.url).await;
            let elapsed_ms = started.elapsed().as_millis() as u64;
            drop(permit);
            match reconnected {
                Ok(fresh) => {
                    shared.sessions.reconnect_ok.fetch_add(1, Ordering::Relaxed);
                    if let Ok(mut l) = shared.reconnect_latencies.lock() {
                        l.push(elapsed_ms);
                    }
                    if let Ok(mut live) = shared.registry.lock() {
                        live.push(fresh.quic_connection().clone());
                    }
                    conn = fresh;
                }
                Err(e) => {
                    record_reconnect_failure(
                        shared,
                        track_schedule,
                        started_at,
                        options.send_interval,
                        phase_offset,
                        &mut accounted,
                        e.to_string(),
                    );
                    return;
                }
            }
            continue;
        }

        if current == PHASE_IDLE {
            account_ticks(
                shared,
                track_schedule,
                started_at,
                options.send_interval,
                phase_offset,
                &mut accounted,
            );
            tokio::select! {
                changed = phase.changed() => {
                    if changed.is_err() { break; }
                }
                received = conn.receive_datagram() => {
                    match received {
                        Ok(d) => record_arrival(
                            d.as_ref(), monotonic_ns(), severed, current,
                            shared, &shared.realm, &shared.survivors,
                        ),
                        Err(_) => {
                            shared.sessions.lost.fetch_add(1, Ordering::Relaxed);
                            return;
                        }
                    }
                }
            }
            continue;
        }

        if receive_only {
            tokio::select! {
                changed = phase.changed() => {
                    if changed.is_err() { break; }
                }
                received = conn.receive_datagram() => {
                    match received {
                        Ok(d) => record_arrival(
                            d.as_ref(), monotonic_ns(), severed, current,
                            shared, &shared.realm, &shared.survivors,
                        ),
                        Err(_) => {
                            shared.sessions.lost.fetch_add(1, Ordering::Relaxed);
                            return;
                        }
                    }
                }
            }
            continue;
        }

        tokio::select! {
            changed = phase.changed() => {
                if changed.is_err() {
                    account_ticks(
                        shared,
                        track_schedule,
                        started_at,
                        options.send_interval,
                        phase_offset,
                        &mut accounted,
                    );
                    break;
                }
            }
            scheduled = ticker.tick() => {
                sequence = sequence.wrapping_add(1);
                // The stamp goes in immediately before the send, so the instant
                // it carries is the actual send instant and nothing this
                // generator does afterwards is charged to the server.
                let observed = tokio::time::Instant::now();
                let actual_ns = monotonic_ns();
                let observation =
                    observe_tick(scheduled, observed, actual_ns, options.send_interval);
                shared.schedule_ticks_fired.fetch_add(1, Ordering::Relaxed);
                shared
                    .schedule_ticks_skipped
                    .fetch_add(observation.skipped_ticks, Ordering::Relaxed);
                shared
                    .schedule_lag
                    .record(observation.lag_ns);
                let class = if options.role == Role::Publisher {
                    CLASS_RAID
                } else {
                    class_for_tick(sequence, options.action_every)
                };
                write_stamp_v3(
                    &mut payload,
                    observation.intended_ns,
                    actual_ns,
                    sequence,
                    class,
                );
                match conn.send_datagram(&payload) {
                    Ok(()) => {
                        shared.realm.sent.fetch_add(1, Ordering::Relaxed);
                        if !severed && current == PHASE_STORM {
                            shared.survivors.sent.fetch_add(1, Ordering::Relaxed);
                        }
                    }
                    Err(_) => {
                        shared.realm.send_err.fetch_add(1, Ordering::Relaxed);
                        if !severed && current == PHASE_STORM {
                            shared.survivors.send_err.fetch_add(1, Ordering::Relaxed);
                        }
                    }
                }
            }
            received = conn.receive_datagram() => {
                match received {
                    Ok(d) => record_arrival(
                        d.as_ref(), monotonic_ns(), severed, current,
                        shared, &shared.realm, &shared.survivors,
                    ),
                    Err(_) => {
                        // A session lost mid-drive still offered whatever its
                        // schedule had made due; not accounting for it would
                        // quietly forgive the shortfall. A severed session in
                        // the storm phase is expected to see this and is not
                        // counted as lost.
                        account_ticks(
                            shared,
                            track_schedule,
                            started_at,
                            options.send_interval,
                            phase_offset,
                            &mut accounted,
                        );
                        if !(severed && current == PHASE_STORM) {
                            shared.sessions.lost.fetch_add(1, Ordering::Relaxed);
                        }
                        return;
                    }
                }
            }
        }
    }

    conn.close(0u32.into(), b"g6 run complete");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ticks_due_is_stable_across_the_window_edge() {
        // The half-interval offset puts the boundary in the middle of a slot, so
        // a snapshot taken slightly early or late books the same count.
        let interval = Duration::from_millis(250);
        for skew_ms in [-100i64, -1, 0, 1, 100] {
            let elapsed = Duration::from_millis((120_000 + skew_ms) as u64);
            assert_eq!(
                ticks_due_after(elapsed, interval, 0.0),
                480,
                "skew {skew_ms}"
            );
        }
    }

    #[test]
    fn the_registered_upstream_rate_is_what_the_schedule_produces() {
        // 4 pps over a 120 s window, which is the §1.2 figure.
        let due = ticks_due_after(Duration::from_secs(120), Duration::from_millis(250), 0.0);
        assert_eq!(due, 480);
        assert_eq!(due as f64 / 120.0, 4.0);
    }

    #[test]
    fn stagger_spreads_first_ticks_over_one_interval() {
        let interval = Duration::from_millis(250);
        assert_eq!(first_tick_offset(interval, 0.0), Duration::from_millis(125));
        assert_eq!(first_tick_offset(interval, 0.5), Duration::from_millis(250));
        // Fractions outside [0,1] cannot pull a tick before the window.
        assert_eq!(
            first_tick_offset(interval, -1.0),
            Duration::from_millis(125)
        );
        assert_eq!(first_tick_offset(interval, 9.0), Duration::from_millis(375));
    }

    #[test]
    fn every_eighth_tick_is_an_action() {
        // 4 pps movement, one action every 8 ticks = the registered 0.5 pps.
        let actions = (1..=800u64)
            .filter(|s| class_for_tick(*s, 8) == CLASS_ACTION)
            .count();
        assert_eq!(actions, 100);
        assert_eq!(class_for_tick(8, 8), CLASS_ACTION);
        assert_eq!(class_for_tick(9, 8), CLASS_MOVE);
        // Zero disables actions rather than making every tick one.
        assert_eq!(class_for_tick(8, 0), CLASS_MOVE);
    }

    #[test]
    fn the_severed_cohort_is_decided_before_the_run() {
        assert!(is_severed(0, 1000));
        assert!(is_severed(999, 1000));
        assert!(!is_severed(1000, 1000));
        // A cohort of zero severs nobody: the storm arm is off.
        assert!(!is_severed(0, 0));
    }

    #[test]
    fn observe_tick_reports_nonnegative_lag_without_future_deadlines() {
        let interval = Duration::from_millis(250);
        let scheduled = tokio::time::Instant::now();

        let exact = observe_tick(scheduled, scheduled, 1_000_000_000, interval);
        assert_eq!(
            exact,
            TickObservation {
                intended_ns: 1_000_000_000,
                lag_ns: 0,
                skipped_ticks: 0,
            }
        );

        let late_3ms = observe_tick(
            scheduled,
            scheduled + Duration::from_millis(3),
            1_003_000_000,
            interval,
        );
        assert_eq!(late_3ms.lag_ns, 3_000_000);
        assert_eq!(late_3ms.intended_ns, 1_000_000_000);
        assert_eq!(late_3ms.skipped_ticks, 0);

        let half_plus = observe_tick(
            scheduled,
            scheduled + Duration::from_millis(126),
            2_126_000_000,
            interval,
        );
        assert_eq!(half_plus.lag_ns, 126_000_000);
        assert_eq!(half_plus.intended_ns, 2_000_000_000);
        assert_eq!(half_plus.skipped_ticks, 0);

        let two_exact = observe_tick(
            scheduled,
            scheduled + Duration::from_millis(500),
            3_500_000_000,
            interval,
        );
        assert_eq!(two_exact.lag_ns, 500_000_000);
        assert_eq!(two_exact.intended_ns, 3_000_000_000);
        assert_eq!(two_exact.skipped_ticks, 2);

        let two_plus = observe_tick(
            scheduled,
            scheduled + Duration::from_millis(503),
            4_503_000_000,
            interval,
        );
        assert_eq!(two_plus.lag_ns, 503_000_000);
        assert_eq!(two_plus.intended_ns, 4_000_000_000);
        assert_eq!(two_plus.skipped_ticks, 2);

        let saturated = observe_tick(
            scheduled,
            scheduled + Duration::from_secs(1),
            400_000_000,
            interval,
        );
        assert_eq!(saturated.lag_ns, 1_000_000_000);
        assert_eq!(saturated.intended_ns, 0);
        assert_eq!(saturated.skipped_ticks, 4);
    }

    #[test]
    fn schedule_accounting_respects_phase_offset_and_reconciles() {
        let interval = Duration::from_millis(250);
        let aligned = schedule_accounting(Duration::from_millis(600), interval, 0.0, 2, 0);
        assert_eq!(
            aligned,
            ScheduleAccounting {
                due: 2,
                fired: 2,
                skipped: 0,
            }
        );
        assert!(aligned.reconciled());

        let offset = schedule_accounting(Duration::from_millis(600), interval, 1.0, 1, 0);
        assert_eq!(
            offset,
            ScheduleAccounting {
                due: 1,
                fired: 1,
                skipped: 0,
            }
        );
        assert!(offset.reconciled());

        let skipped = schedule_accounting(Duration::from_millis(875), interval, 1.0, 2, 1);
        assert_eq!(
            skipped,
            ScheduleAccounting {
                due: 3,
                fired: 2,
                skipped: 1,
            }
        );
        assert!(skipped.reconciled());
    }

    #[test]
    fn reconnect_failure_books_schedule_before_returning() {
        let shared = Shared::new(1);
        shared.schedule_ticks_fired.store(3, Ordering::Relaxed);
        shared.schedule_ticks_skipped.store(1, Ordering::Relaxed);
        let mut accounted = false;
        let started_at = tokio::time::Instant::now() - Duration::from_millis(3600);
        let interval = Duration::from_secs(1);

        record_reconnect_failure(
            &shared,
            true,
            started_at,
            interval,
            0.0,
            &mut accounted,
            "storm reconnect failed".to_string(),
        );

        assert!(accounted);
        assert_eq!(shared.sessions.reconnect_err.load(Ordering::Relaxed), 1);
        assert_eq!(
            shared.errors.lock().unwrap().as_slice(),
            ["storm reconnect failed"]
        );
        let accounting = ScheduleAccounting {
            due: shared.schedule_ticks_due.load(Ordering::Relaxed),
            fired: shared.schedule_ticks_fired.load(Ordering::Relaxed),
            skipped: shared.schedule_ticks_skipped.load(Ordering::Relaxed),
        };
        assert_eq!(
            accounting,
            ScheduleAccounting {
                due: 4,
                fired: 3,
                skipped: 1,
            }
        );
        assert!(accounting.reconciled());
    }

    #[test]
    fn preregistration_sha256_is_required() {
        let err = validate_pre_registration_sha256(None).unwrap_err();
        assert_eq!(
            err.to_string(),
            "mmo-client: --preregistration-sha256 is required for mmo-client/2 reports"
        );
    }

    #[test]
    fn preregistration_sha256_rejects_malformed_values() {
        for raw in [
            "",
            "abc",
            "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdeg",
        ] {
            let err = validate_pre_registration_sha256(Some(raw)).unwrap_err();
            assert_eq!(
                err.to_string(),
                format!("mmo-client: --preregistration-sha256 must be 64 hex chars, got '{raw}'")
            );
        }
    }

    #[test]
    fn preregistration_sha256_accepts_valid_and_is_json_safe() {
        let sha = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        let parsed = validate_pre_registration_sha256(Some(sha)).unwrap();
        assert_eq!(parsed, sha);
        assert_eq!(json_string(Some(parsed.as_str())), format!("\"{sha}\""));
    }

    /// The classification the round trip depends on, exercised without a
    /// network: an ack the server forgot to reflect must be *counted*, never
    /// recorded as a round trip measured from the epoch.
    #[test]
    fn an_unreflected_ack_is_counted_and_not_measured() {
        let shared = Shared::new(1);
        let realm = Counters::default();
        let survivors = Counters::default();
        let mut buf = [0u8; STAMP_BYTES_V3];
        write_stamp_v3(&mut buf, 0, 0, 1, CLASS_ACK);
        record_arrival(
            &buf,
            monotonic_ns(),
            false,
            PHASE_STEADY,
            &shared,
            &realm,
            &survivors,
        );
        assert_eq!(realm.rx_ack.load(Ordering::Relaxed), 1);
        assert_eq!(realm.ack_unreflected.load(Ordering::Relaxed), 1);
        assert!(shared.rtt_steady.to_json().contains("\"count\":0"));
    }

    #[test]
    fn a_reflected_ack_produces_exactly_one_round_trip_sample() {
        let shared = Shared::new(1);
        let realm = Counters::default();
        let survivors = Counters::default();
        let sent_ns = monotonic_ns();
        let mut buf = [0u8; STAMP_BYTES_V3];
        write_stamp_v3(&mut buf, 0, 0, 1, CLASS_ACK);
        // The server's half: reflect the client's instant and report its dwell.
        buf[28..36].copy_from_slice(&sent_ns.to_le_bytes());
        buf[36..44].copy_from_slice(&3_000_000u64.to_le_bytes());
        record_arrival(
            &buf,
            sent_ns + 12_000_000,
            false,
            PHASE_STEADY,
            &shared,
            &realm,
            &survivors,
        );
        let json = shared.rtt_steady.to_json();
        assert!(json.contains("\"count\":1"), "{json}");
        assert!(json.contains("\"negative\":0"), "{json}");
        assert!(shared.server_hold.to_json().contains("\"count\":1"));
        assert_eq!(realm.ack_unreflected.load(Ordering::Relaxed), 0);
    }

    /// §5.3: the survivor clause is computed over the survivor cohort alone.
    /// A severed session's arrivals must not reach the survivor histogram, and a
    /// survivor's must not reach it outside the storm window.
    #[test]
    fn survivor_accounting_excludes_the_severed_cohort() {
        let shared = Shared::new(1);
        let realm = Counters::default();
        let survivors = Counters::default();
        let sent_ns = monotonic_ns();
        let mut buf = [0u8; STAMP_BYTES_V3];
        write_stamp_v3(&mut buf, 0, 0, 1, CLASS_ACK);
        buf[28..36].copy_from_slice(&sent_ns.to_le_bytes());

        record_arrival(
            &buf,
            sent_ns + 1_000_000,
            true,
            PHASE_STORM,
            &shared,
            &realm,
            &survivors,
        );
        assert!(shared.rtt_storm_survivors.to_json().contains("\"count\":0"));
        assert_eq!(survivors.rx_ack.load(Ordering::Relaxed), 0);

        record_arrival(
            &buf,
            sent_ns + 1_000_000,
            false,
            PHASE_STORM,
            &shared,
            &realm,
            &survivors,
        );
        assert!(shared.rtt_storm_survivors.to_json().contains("\"count\":1"));
        assert_eq!(survivors.rx_ack.load(Ordering::Relaxed), 1);

        // Outside the storm window a survivor's ack belongs to the steady
        // histogram, not the survivor one.
        record_arrival(
            &buf,
            sent_ns + 1_000_000,
            false,
            PHASE_STEADY,
            &shared,
            &realm,
            &survivors,
        );
        assert!(shared.rtt_storm_survivors.to_json().contains("\"count\":1"));
        assert!(shared.rtt_steady.to_json().contains("\"count\":1"));
    }

    #[test]
    fn a_snapshot_is_counted_but_never_timed() {
        // Snapshots are interpolated client-side; the gate's latency clause is
        // on the ack class alone, and mixing them would measure tick wait.
        let shared = Shared::new(1);
        let realm = Counters::default();
        let survivors = Counters::default();
        let mut buf = [0u8; STAMP_BYTES_V3];
        write_stamp_v3(&mut buf, 0, monotonic_ns(), 1, CLASS_SNAPSHOT);
        record_arrival(
            &buf,
            monotonic_ns(),
            false,
            PHASE_STEADY,
            &shared,
            &realm,
            &survivors,
        );
        assert_eq!(realm.rx_snapshot.load(Ordering::Relaxed), 1);
        assert!(shared.rtt_steady.to_json().contains("\"count\":0"));
    }

    #[test]
    fn a_foreign_payload_is_counted_as_unstamped() {
        let shared = Shared::new(1);
        let realm = Counters::default();
        let survivors = Counters::default();
        record_arrival(
            &[0u8; 64],
            monotonic_ns(),
            false,
            PHASE_STEADY,
            &shared,
            &realm,
            &survivors,
        );
        assert_eq!(realm.rx_unstamped.load(Ordering::Relaxed), 1);
        assert_eq!(realm.rx_other.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn roles_parse_and_round_trip() {
        assert_eq!(Role::parse("realm"), Some(Role::Realm));
        assert_eq!(Role::parse("publisher"), Some(Role::Publisher));
        assert_eq!(Role::parse("raid-subscriber"), Some(Role::RaidSubscriber));
        assert_eq!(Role::parse("nope"), None);
        assert_eq!(Role::Realm.as_str(), "realm");
    }

    #[test]
    fn json_helpers_emit_null_for_missing_values() {
        assert_eq!(json_num(None), "null");
        assert_eq!(json_num(Some(f64::NAN)), "null");
        assert_eq!(json_u64(None), "null");
        assert_eq!(escape("a\"b\\c\nd"), "a\\\"b\\\\c d");
    }

    #[test]
    fn percentile_picks_expected_ranks() {
        let sorted = [1u64, 2, 3, 4, 5, 6, 7, 8, 9, 10];
        assert_eq!(percentile(&sorted, 0.50), Some(6));
        assert_eq!(percentile(&sorted, 0.99), Some(10));
        assert_eq!(percentile(&[], 0.5), None);
    }
}
