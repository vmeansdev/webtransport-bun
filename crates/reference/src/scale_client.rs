//! Session-scale load generator.
//!
//! Holds a large number of concurrent WebTransport sessions at a deliberately
//! low per-session datagram rate, so that *session count* is the only variable.
//! Companion to `tools/load/bench-session-scale.ts`; see
//! `docs/research/preregistrations/session-scale.md` for the pre-registered
//! ladder, buckets and STOP conditions.
//!
//! Three phases per run, driven by a watch channel so every session switches at
//! the same instant:
//!   1. connect — establish `--sessions` sessions, `--connect-concurrency` at a
//!      time, recording per-handshake latency.
//!   2. steady  — every session sends one `--payload-bytes` datagram every
//!      `--datagram-interval-ms`.
//!   3. idle    — no application sends; only QUIC keep-alive runs. Isolates the
//!      per-session idle cost the server pays for doing nothing.
//!
//! Counters are snapshotted at each phase boundary and emitted as JSON, so the
//! harness can attribute steady-state delivery without idle-phase contamination.

// Ported verbatim from `probe/latency-01` so both axes share one instrument;
// this binary only writes stamps (the server reads them from Bun), so the
// decode half is unused here and stays rather than fork the file.
#[allow(dead_code)]
mod latency_probe;

use latency_probe::{monotonic_ns, write_stamp, AtomicHistogram, STAMP_BYTES};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::{watch, Semaphore};
use wtransport::quinn;
use wtransport::{ClientConfig, Endpoint};

const DEFAULT_URL: &str = "https://127.0.0.1:4433";
const DEFAULT_SESSIONS: usize = 100;
const DEFAULT_ENDPOINTS: usize = 1;
const DEFAULT_CONNECT_CONCURRENCY: usize = 200;
const DEFAULT_STEADY_SECS: u64 = 120;
const DEFAULT_IDLE_SECS: u64 = 30;
const DEFAULT_DATAGRAM_INTERVAL_MS: u64 = 5_000;
const DEFAULT_PAYLOAD_BYTES: usize = 100;
const DEFAULT_CONNECT_TIMEOUT_SECS: u64 = 300;
const KEEP_ALIVE: Duration = Duration::from_secs(15);
const MAX_IDLE: Duration = Duration::from_secs(60);
const MAX_RECORDED_ERRORS: usize = 5;
const JOIN_TIMEOUT: Duration = Duration::from_secs(20);
/// Grace for every session task to observe a phase change before counters are
/// snapshotted at that boundary.
const PHASE_SETTLE: Duration = Duration::from_millis(250);
/// Self-guard ceiling for this process's own RSS. Above it the generator has
/// stopped being a measurement instrument and started being the thing that
/// takes the host down — run 32168754965 swap-killed an 8 GB runner and left
/// zero evidence behind. Aborting here costs one rung; not aborting cost a run.
const CLIENT_RSS_LIMIT_MB: f64 = 3584.0;
const RSS_GUARD_INTERVAL: Duration = Duration::from_secs(2);
/// Distinct exit code for the self-guard, paired with the stdout marker the
/// harness matches on.
const EXIT_RSS_GUARD: i32 = 91;

const PHASE_CONNECT: u8 = 0;
const PHASE_STEADY: u8 = 1;
const PHASE_IDLE: u8 = 2;
const PHASE_STOP: u8 = 3;

#[derive(Clone)]
struct Options {
    url: String,
    sessions: usize,
    endpoints: usize,
    connect_concurrency: usize,
    steady: Duration,
    idle: Duration,
    datagram_interval: Duration,
    payload_bytes: usize,
    connect_timeout: Duration,
    json_out: Option<String>,
    /// Spread each session's send schedule across one interval instead of
    /// releasing every session on the same phase signal. Off reproduces the
    /// session-scale ladder's original arrival process exactly; on is what
    /// `docs/research/preregistrations/gate-g1.md` §2 registers for G1, because
    /// a wall-clock-aligned fleet turns `sessions/interval` per second into one
    /// `sessions`-packet impulse per interval and measures the runner's UDP
    /// receive buffer rather than this server.
    stagger_sends: bool,
}

/// Per-window QUIC tap, summed over live connections at the instant of the
/// snapshot; the harness reports differences between snapshots.
///
/// `frame_tx_datagram` is G1 clause C4's tap 2: the gap between it and
/// `datagrams_sent` is quinn's silent send-buffer eviction, which is the only
/// way a datagram can vanish between this generator and the wire.
#[derive(Clone, Copy, Default)]
struct QuicTap {
    connections: u64,
    frame_tx_datagram: u64,
    udp_tx_datagrams: u64,
    sent_packets: u64,
    lost_packets: u64,
    congestion_events: u64,
}

impl QuicTap {
    fn add(&mut self, s: &quinn::ConnectionStats) {
        self.connections += 1;
        self.frame_tx_datagram += s.frame_tx.datagram;
        self.udp_tx_datagrams += s.udp_tx.datagrams;
        self.sent_packets += s.path.sent_packets;
        self.lost_packets += s.path.lost_packets;
        self.congestion_events += s.path.congestion_events;
    }

    fn delta(&self, base: &QuicTap) -> QuicTap {
        QuicTap {
            // A connection count is a level, not a flow: report the later one.
            connections: self.connections,
            frame_tx_datagram: self
                .frame_tx_datagram
                .saturating_sub(base.frame_tx_datagram),
            udp_tx_datagrams: self.udp_tx_datagrams.saturating_sub(base.udp_tx_datagrams),
            sent_packets: self.sent_packets.saturating_sub(base.sent_packets),
            lost_packets: self.lost_packets.saturating_sub(base.lost_packets),
            congestion_events: self
                .congestion_events
                .saturating_sub(base.congestion_events),
        }
    }

    fn to_json(self) -> String {
        format!(
            concat!(
                "{{\"connections\":{},\"frameTxDatagram\":{},\"udpTxDatagrams\":{},",
                "\"sentPackets\":{},\"lostPackets\":{},\"congestionEvents\":{}}}"
            ),
            self.connections,
            self.frame_tx_datagram,
            self.udp_tx_datagrams,
            self.sent_packets,
            self.lost_packets,
            self.congestion_events,
        )
    }
}

/// Live QUIC connections, registered as each session finishes its handshake.
/// `quinn::Connection` is an `Arc` handle, so one per session costs a pointer
/// and keeps no extra transport state alive.
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

#[derive(Default)]
struct Counters {
    sessions_ok: AtomicU64,
    sessions_err: AtomicU64,
    connect_done: AtomicU64,
    datagrams_sent: AtomicU64,
    datagrams_err: AtomicU64,
    datagrams_received: AtomicU64,
    sessions_lost: AtomicU64,
    /// Ticks the steady schedule actually became due for, summed over sessions.
    /// Each session computes its own from the clock its ticker runs on, at the
    /// instant it leaves the steady phase — so the boundary tick is counted as
    /// due exactly when it fired, instead of being predicted by a formula that
    /// has to guess how a coin came down.
    steady_ticks_due: AtomicU64,
}

#[derive(Clone, Copy, Default)]
struct CounterSnapshot {
    sent: u64,
    err: u64,
    received: u64,
    lost: u64,
    ticks_due: u64,
}

impl Counters {
    fn snapshot(&self) -> CounterSnapshot {
        CounterSnapshot {
            sent: self.datagrams_sent.load(Ordering::Relaxed),
            err: self.datagrams_err.load(Ordering::Relaxed),
            received: self.datagrams_received.load(Ordering::Relaxed),
            lost: self.sessions_lost.load(Ordering::Relaxed),
            ticks_due: self.steady_ticks_due.load(Ordering::Relaxed),
        }
    }
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
                eprintln!("scale-client: invalid value for {flag} ('{v}'): {e}; using default");
                default
            }
        },
        None => default,
    }
}

/// Process RSS in MiB. Linux only; the local macOS smoke reports null.
fn self_rss_mb() -> Option<f64> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    let line = status.lines().find(|l| l.starts_with("VmRSS:"))?;
    let kb: f64 = line.split_whitespace().nth(1)?.parse().ok()?;
    Some(kb / 1024.0)
}

/// Process CPU time in ms (utime+stime). Linux only.
fn self_cpu_ms() -> Option<f64> {
    let stat = std::fs::read_to_string("/proc/self/stat").ok()?;
    let close = stat.rfind(')')?;
    let fields: Vec<&str> = stat[close + 1..].split_whitespace().collect();
    // After the comm field, index 0 is `state`; utime/stime are fields 14/15
    // of the full record, i.e. offsets 11/12 here.
    let utime: f64 = fields.get(11)?.parse().ok()?;
    let stime: f64 = fields.get(12)?.parse().ok()?;
    let hz = 100.0; // USER_HZ is 100 on every Linux target this runs on.
    Some((utime + stime) * 1000.0 / hz)
}

/// Watches this process's own RSS and aborts the run if it crosses the ceiling.
/// The marker is flushed to stdout before exiting so the harness can record that
/// the guard fired even though no run JSON was produced.
fn spawn_rss_guard() {
    match self_rss_mb() {
        Some(rss) => println!(
            "scale-client: rss guard armed limitMb={CLIENT_RSS_LIMIT_MB:.0} sampleMs={} rssMb={rss:.1}",
            RSS_GUARD_INTERVAL.as_millis()
        ),
        // No /proc (the local macOS smoke). Say so rather than let a silent
        // no-op read as a guard that was watching.
        None => println!("scale-client: rss guard inactive (no /proc/self/status)"),
    }
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(RSS_GUARD_INTERVAL).await;
            let Some(rss) = self_rss_mb() else { continue };
            if rss > CLIENT_RSS_LIMIT_MB {
                println!(
                    "scale-client: abort client-rss-guard rssMb={rss:.1} limitMb={CLIENT_RSS_LIMIT_MB:.0}"
                );
                let _ = std::io::Write::flush(&mut std::io::stdout());
                std::process::exit(EXIT_RSS_GUARD);
            }
        }
    });
}

/// Offset of a session's first steady tick: half an interval, not a whole one.
///
/// The window edge is where `offeredRatio` used to break. With the first tick
/// one full interval in, the last tick's deadline lands exactly on the phase
/// change, so whether it fires is a coin flip between two timers in the same
/// slot — the local smoke read 1.16 and 0.90 out of the same schedule depending
/// only on which side of that flip the count was taken. Half an interval of
/// phase offset moves every tick to the middle of its slot: the window holds
/// `steady / interval` ticks exactly, none of them within half an interval of
/// either edge, and the offered rate label is the nominal rate rather than one
/// tick short of it. Window length and per-session rate are unchanged.
///
/// `phase_offset` adds this session's share of the staggered arrival process
/// (gate-g1 pre-registration §6, amending the axis pre-registration's Amendment
/// 2 §1): session *i* of *N* offsets by `i/N` of one interval on top of the half
/// interval, so the same mean rate arrives smoothly instead of as one impulse.
/// It is zero for every session when stagger is off, which is the original rule
/// exactly.
fn first_tick_offset(interval: Duration, phase_offset: f64) -> Duration {
    interval / 2 + interval.mul_f64(phase_offset.clamp(0.0, 1.0))
}

/// Ticks whose deadline has passed, `elapsed` into a steady phase using the
/// offset above. Shared by the per-session denominator and the nominal figure,
/// so the two can never drift apart.
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

/// Nominal ticks per session under the configured schedule. A diagnostic: the
/// `offeredRatio` denominator is measured per session (see `account_steady`),
/// and this figure is reported beside it so a reader can see the generator's
/// sessions kept their own clocks.
fn expected_ticks(steady: Duration, interval: Duration) -> u64 {
    ticks_due_after(steady, interval, 0.0)
}

fn open_fd_count() -> Option<u64> {
    Some(std::fs::read_dir("/proc/self/fd").ok()?.count() as u64)
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
        Some(n) if n.is_finite() => format!("{n:.2}"),
        _ => "null".to_string(),
    }
}

fn json_u64(v: Option<u64>) -> String {
    match v {
        Some(n) => n.to_string(),
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

type ClientEndpoint = Endpoint<wtransport::endpoint::endpoint_side::Client>;

struct EndpointPool {
    endpoints: Vec<Arc<ClientEndpoint>>,
    /// How many endpoints actually got their own source address.
    distinct_source_ips: usize,
}

/// One client endpoint per distinct loopback source IP (`127.0.<k>.1`), so the
/// server sees several distinct `IpAddr` rate-limit keys and distinct `/24`
/// prefixes. With `endpoints == 1` it binds the default address instead, which
/// is what the local macOS smoke can do without interface aliases.
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
                // A platform that will not hand out loopback aliases must not
                // cost a 50-minute run: fall back to the default bind and
                // report the shortfall instead of aborting the ladder.
                Err(e) => eprintln!("scale-client: bind {addr} failed ({e}); using default bind"),
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

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let mut options = Options {
        url: DEFAULT_URL.to_string(),
        sessions: DEFAULT_SESSIONS,
        endpoints: DEFAULT_ENDPOINTS,
        connect_concurrency: DEFAULT_CONNECT_CONCURRENCY,
        steady: Duration::from_secs(DEFAULT_STEADY_SECS),
        idle: Duration::from_secs(DEFAULT_IDLE_SECS),
        datagram_interval: Duration::from_millis(DEFAULT_DATAGRAM_INTERVAL_MS),
        payload_bytes: DEFAULT_PAYLOAD_BYTES,
        connect_timeout: Duration::from_secs(DEFAULT_CONNECT_TIMEOUT_SECS),
        json_out: None,
        stagger_sends: false,
    };

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--url" => options.url = args.next().unwrap_or_else(|| DEFAULT_URL.to_string()),
            "--sessions" => {
                options.sessions = parse_or_default("--sessions", args.next(), DEFAULT_SESSIONS)
            }
            "--endpoints" => {
                options.endpoints =
                    parse_or_default("--endpoints", args.next(), DEFAULT_ENDPOINTS).clamp(1, 250)
            }
            "--connect-concurrency" => {
                options.connect_concurrency = parse_or_default(
                    "--connect-concurrency",
                    args.next(),
                    DEFAULT_CONNECT_CONCURRENCY,
                )
                .max(1)
            }
            "--steady-secs" => {
                options.steady = Duration::from_secs(parse_or_default(
                    "--steady-secs",
                    args.next(),
                    DEFAULT_STEADY_SECS,
                ))
            }
            "--idle-secs" => {
                options.idle = Duration::from_secs(parse_or_default(
                    "--idle-secs",
                    args.next(),
                    DEFAULT_IDLE_SECS,
                ))
            }
            "--datagram-interval-ms" => {
                options.datagram_interval = Duration::from_millis(
                    parse_or_default(
                        "--datagram-interval-ms",
                        args.next(),
                        DEFAULT_DATAGRAM_INTERVAL_MS,
                    )
                    .max(1),
                )
            }
            "--payload-bytes" => {
                options.payload_bytes =
                    parse_or_default("--payload-bytes", args.next(), DEFAULT_PAYLOAD_BYTES)
                        // Every steady datagram carries the latency stamp, so a
                        // payload too short to hold one is not a smaller
                        // measurement, it is no measurement.
                        .max(STAMP_BYTES)
            }
            "--connect-timeout-secs" => {
                options.connect_timeout = Duration::from_secs(parse_or_default(
                    "--connect-timeout-secs",
                    args.next(),
                    DEFAULT_CONNECT_TIMEOUT_SECS,
                ))
            }
            "--json-out" => options.json_out = args.next(),
            "--stagger-sends" => options.stagger_sends = true,
            _ => {}
        }
    }

    println!(
        "scale-client: url={} sessions={} endpoints={} connect_concurrency={} steady={}s idle={}s interval={}ms payload={}B stagger_sends={}",
        options.url,
        options.sessions,
        options.endpoints,
        options.connect_concurrency,
        options.steady.as_secs(),
        options.idle.as_secs(),
        options.datagram_interval.as_millis(),
        options.payload_bytes,
        options.stagger_sends,
    );

    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    rt.block_on(run(options))
}

async fn run(options: Options) -> Result<(), Box<dyn std::error::Error>> {
    spawn_rss_guard();
    let EndpointPool {
        endpoints,
        distinct_source_ips,
    } = build_endpoints(options.endpoints)?;
    let counters = Arc::new(Counters::default());
    let permits = Arc::new(Semaphore::new(options.connect_concurrency));
    let latencies: Arc<Mutex<Vec<u64>>> =
        Arc::new(Mutex::new(Vec::with_capacity(options.sessions)));
    let errors: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let registry: ConnRegistry = Arc::new(Mutex::new(Vec::with_capacity(options.sessions)));
    let schedule_lag = Arc::new(AtomicHistogram::new());
    let (phase_tx, phase_rx) = watch::channel(PHASE_CONNECT);

    let cpu0 = self_cpu_ms();
    let connect_started = Instant::now();
    let mut handles = Vec::with_capacity(options.sessions);
    for i in 0..options.sessions {
        let endpoint = Arc::clone(&endpoints[i % endpoints.len()]);
        let counters = Arc::clone(&counters);
        let permits = Arc::clone(&permits);
        let latencies = Arc::clone(&latencies);
        let errors = Arc::clone(&errors);
        let registry = Arc::clone(&registry);
        let schedule_lag = Arc::clone(&schedule_lag);
        let url = options.url.clone();
        let mut phase = phase_rx.clone();
        let interval = options.datagram_interval;
        let payload_bytes = options.payload_bytes;
        // Deterministic, evenly spaced, and independent of connect order, so the
        // staggered arm differs from the aligned one in exactly one thing.
        let phase_offset = if options.stagger_sends {
            i as f64 / options.sessions as f64
        } else {
            0.0
        };
        handles.push(tokio::spawn(async move {
            let permit = match permits.acquire_owned().await {
                Ok(p) => p,
                Err(_) => return,
            };
            let started = Instant::now();
            let connected = endpoint.connect(&url).await;
            let elapsed_ms = started.elapsed().as_millis() as u64;
            drop(permit);
            let conn = match connected {
                Ok(conn) => {
                    counters.sessions_ok.fetch_add(1, Ordering::Relaxed);
                    if let Ok(mut l) = latencies.lock() {
                        l.push(elapsed_ms);
                    }
                    conn
                }
                Err(e) => {
                    counters.sessions_err.fetch_add(1, Ordering::Relaxed);
                    if let Ok(mut recorded) = errors.lock() {
                        if recorded.len() < MAX_RECORDED_ERRORS {
                            recorded.push(e.to_string());
                        }
                    }
                    counters.connect_done.fetch_add(1, Ordering::Relaxed);
                    return;
                }
            };
            if let Ok(mut live) = registry.lock() {
                live.push(conn.quic_connection().clone());
            }
            counters.connect_done.fetch_add(1, Ordering::Relaxed);
            hold_session(
                conn,
                &mut phase,
                interval,
                payload_bytes,
                phase_offset,
                schedule_lag.as_ref(),
                counters.as_ref(),
            )
            .await;
        }));
    }

    // Connect phase ends when every task has reported, or the timeout fires.
    let connect_deadline = Instant::now() + options.connect_timeout;
    let mut connect_timed_out = false;
    loop {
        if counters.connect_done.load(Ordering::Relaxed) as usize >= options.sessions {
            break;
        }
        if Instant::now() >= connect_deadline {
            connect_timed_out = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let connect_wall = connect_started.elapsed();
    // CPU is reported as a windowed rate per phase, never as a cumulative
    // average: the connect ramp is by far the most CPU-hungry part of a rung, so
    // folding it into the steady number would make steady CPU decay with window
    // length instead of describing the steady phase.
    let cpu_after_connect = self_cpu_ms();
    let sessions_ok = counters.sessions_ok.load(Ordering::Relaxed);
    let sessions_err = counters.sessions_err.load(Ordering::Relaxed);
    println!(
        "scale-client: connect phase done ok={} err={} wall={:.1}s timed_out={}",
        sessions_ok,
        sessions_err,
        connect_wall.as_secs_f64(),
        connect_timed_out
    );

    let after_connect = counters.snapshot();
    let quic_after_connect = sample_quic(&registry);
    let _ = phase_tx.send(PHASE_STEADY);
    let steady_started = Instant::now();
    // Phase markers are line-buffered onto stdout so the harness can snapshot
    // server-side counters at the exact same boundaries this process uses.
    println!("scale-client: phase steady");
    tokio::time::sleep(options.steady).await;

    // Order matters: switch the sessions to idle and let every one of them
    // observe it BEFORE snapshotting sends. A session whose select! picked its
    // ticker over the phase change would otherwise send a datagram the server
    // counts but this snapshot does not, pushing the harness's delivery ratio
    // above 1.0. The marker is printed after the snapshot for the same reason.
    let _ = phase_tx.send(PHASE_IDLE);
    let steady_wall = steady_started.elapsed();
    tokio::time::sleep(PHASE_SETTLE).await;
    let after_steady = counters.snapshot();
    // Sampled inside the same settle grace as the counters, so the wire-tx tap
    // and the enqueue counter describe the same window. The gate's C4a residual
    // is a difference between them; a boundary skew between the two reads would
    // show up as unattributed loss that never happened.
    let quic_after_steady = sample_quic(&registry);
    let lag_steady = schedule_lag.to_json();
    let rss_steady = self_rss_mb();
    let cpu_after_steady = self_cpu_ms();
    println!("scale-client: phase idle");
    tokio::time::sleep(options.idle.saturating_sub(PHASE_SETTLE)).await;
    let after_idle = counters.snapshot();
    let rss_idle = self_rss_mb();
    let cpu_after_idle = self_cpu_ms();
    let fds = open_fd_count();

    let _ = phase_tx.send(PHASE_STOP);
    println!("scale-client: phase stop");
    let join_deadline = Instant::now() + JOIN_TIMEOUT;
    while Instant::now() < join_deadline && handles.iter().any(|h| !h.is_finished()) {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    for h in &handles {
        if !h.is_finished() {
            h.abort();
        }
    }

    let mut sorted = latencies.lock().map(|l| l.clone()).unwrap_or_default();
    sorted.sort_unstable();
    // Measured, not predicted: every session books the ticks its own schedule
    // made due. `ticks_per_session` is the schedule's nominal figure, reported
    // beside it so a reader can see the two agree (or see by how much the
    // generator's sessions fell behind their own clocks).
    let ticks_per_session = expected_ticks(options.steady, options.datagram_interval);
    let expected_steady_sends = after_steady
        .ticks_due
        .saturating_sub(after_connect.ticks_due);
    let steady_sent = after_steady.sent.saturating_sub(after_connect.sent);
    let recorded_errors = errors.lock().map(|e| e.clone()).unwrap_or_default();

    let window_ms = |from: Option<f64>, to: Option<f64>| match (from, to) {
        (Some(a), Some(b)) => Some(b - a),
        _ => None,
    };
    let cpu_connect_ms = window_ms(cpu0, cpu_after_connect);
    let cpu_steady_ms = window_ms(cpu_after_connect, cpu_after_steady);
    let cpu_idle_ms = window_ms(cpu_after_steady, cpu_after_idle);

    let json = format!(
        concat!(
            "{{",
            "\"schema\":\"scale-client/3\",",
            "\"staggerSends\":{},",
            "\"sessionsRequested\":{},",
            "\"sessionsOk\":{},",
            "\"sessionsErr\":{},",
            "\"sessionsLost\":{},",
            "\"connectWallSec\":{:.3},",
            "\"connectTimedOut\":{},",
            "\"acceptsPerSec\":{},",
            "\"acceptMs\":{{\"p50\":{},\"p90\":{},\"p99\":{},\"max\":{}}},",
            "\"steady\":{{\"sent\":{},\"err\":{},\"received\":{},\"expectedSends\":{},\"expectedTicksPerSession\":{},\"wallSec\":{:.3}}},",
            "\"idle\":{{\"sent\":{},\"err\":{},\"received\":{}}},",
            "\"client\":{{\"rssMbSteady\":{},\"rssMbIdle\":{},\"cpuMsConnect\":{},\"cpuMsSteady\":{},\"cpuMsIdle\":{},\"fdCount\":{},\"endpoints\":{},\"distinctSourceIps\":{}}},",
            "\"quicSteady\":{},",
            "\"scheduleLagSteady\":{},",
            "\"connectErrorsSample\":[{}]",
            "}}"
        ),
        options.stagger_sends,
        options.sessions,
        sessions_ok,
        sessions_err,
        after_idle.lost,
        connect_wall.as_secs_f64(),
        connect_timed_out,
        json_num(if connect_wall.as_secs_f64() > 0.0 {
            Some(sessions_ok as f64 / connect_wall.as_secs_f64())
        } else {
            None
        }),
        json_u64(percentile(&sorted, 0.50)),
        json_u64(percentile(&sorted, 0.90)),
        json_u64(percentile(&sorted, 0.99)),
        json_u64(sorted.last().copied()),
        steady_sent,
        after_steady.err.saturating_sub(after_connect.err),
        after_steady.received.saturating_sub(after_connect.received),
        expected_steady_sends,
        ticks_per_session,
        steady_wall.as_secs_f64(),
        after_idle.sent.saturating_sub(after_steady.sent),
        after_idle.err.saturating_sub(after_steady.err),
        after_idle.received.saturating_sub(after_steady.received),
        json_num(rss_steady),
        json_num(rss_idle),
        json_num(cpu_connect_ms),
        json_num(cpu_steady_ms),
        json_num(cpu_idle_ms),
        json_u64(fds),
        options.endpoints,
        distinct_source_ips,
        quic_after_steady.delta(&quic_after_connect).to_json(),
        lag_steady,
        recorded_errors
            .iter()
            .map(|e| format!("\"{}\"", escape(e)))
            .collect::<Vec<_>>()
            .join(",")
    );

    if let Some(path) = &options.json_out {
        std::fs::write(path, format!("{json}\n"))?;
    }
    println!("scale-client: json {json}");
    Ok(())
}

/// Books this session's share of the steady-phase denominator, once, at the
/// instant it stops sending.
///
/// The count comes from this session's own elapsed steady time on the clock its
/// ticker runs on, not from the configured window, so a session that entered
/// steady late or died early is charged for exactly the ticks its own schedule
/// reached. Combined with the half-interval offset, every counted tick is one
/// whose deadline passed comfortably inside the window, so a shortfall against
/// this denominator is a generator that failed to source the load and nothing
/// else.
fn account_steady(
    counters: &Counters,
    started_at: tokio::time::Instant,
    interval: Duration,
    phase_offset: f64,
    accounted: &mut bool,
) {
    if *accounted {
        return;
    }
    *accounted = true;
    let due = ticks_due_after(started_at.elapsed(), interval, phase_offset);
    counters.steady_ticks_due.fetch_add(due, Ordering::Relaxed);
}

/// The scheduled deadline nearest `actual_ns`, for a schedule that started at
/// `started_ns` and fires every `interval` after `offset`.
///
/// Derived from the instant rather than from a tick counter because
/// `MissedTickBehavior::Skip` drops missed ticks silently: counting fires would
/// make a generator that fell a whole interval behind report zero lag. Nearest
/// deadline is what "how late was this send against its own schedule" means.
fn nearest_deadline_ns(
    started_ns: u64,
    offset: Duration,
    interval: Duration,
    actual_ns: u64,
) -> u64 {
    let interval_ns = interval.as_nanos() as u64;
    let first = started_ns.saturating_add(offset.as_nanos() as u64);
    if interval_ns == 0 || actual_ns <= first {
        return first;
    }
    let k = ((actual_ns - first) as f64 / interval_ns as f64).round() as u64;
    first.saturating_add(k.saturating_mul(interval_ns))
}

async fn hold_session(
    conn: wtransport::Connection,
    phase: &mut watch::Receiver<u8>,
    interval: Duration,
    payload_bytes: usize,
    phase_offset: f64,
    schedule_lag: &AtomicHistogram,
    counters: &Counters,
) {
    // Wait for the steady signal so every session starts sending together;
    // otherwise early sessions would offer more load than late ones.
    while *phase.borrow() == PHASE_CONNECT {
        if phase.changed().await.is_err() {
            return;
        }
    }

    let mut payload = vec![b'x'; payload_bytes];
    let mut sequence: u64 = 0;
    // Half an interval in, not immediately: tokio's first tick fires at once,
    // which would put one extra send in every session and inflate the harness's
    // offeredRatio above 1.0 — exactly the ratio that detects a saturated
    // generator, so it must not run rich. Half rather than a whole interval so
    // no tick shares a timer slot with a phase boundary (see first_tick_offset).
    let steady_started_at = tokio::time::Instant::now();
    let steady_started_ns = monotonic_ns();
    let offset = first_tick_offset(interval, phase_offset);
    let mut ticker = tokio::time::interval_at(steady_started_at + offset, interval);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut steady_accounted = false;

    loop {
        let current = *phase.borrow();
        if current == PHASE_STOP {
            account_steady(
                counters,
                steady_started_at,
                interval,
                phase_offset,
                &mut steady_accounted,
            );
            break;
        }
        if current == PHASE_IDLE {
            account_steady(
                counters,
                steady_started_at,
                interval,
                phase_offset,
                &mut steady_accounted,
            );
            // Idle phase: no application sends. Stay alive so the server pays
            // whatever an idle session costs, and notice if it drops us.
            tokio::select! {
                changed = phase.changed() => {
                    if changed.is_err() { break; }
                }
                received = conn.receive_datagram() => {
                    match received {
                        Ok(_) => { counters.datagrams_received.fetch_add(1, Ordering::Relaxed); }
                        Err(_) => {
                            counters.sessions_lost.fetch_add(1, Ordering::Relaxed);
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
                    account_steady(
                counters,
                steady_started_at,
                interval,
                phase_offset,
                &mut steady_accounted,
            );
                    break;
                }
            }
            _ = ticker.tick() => {
                sequence = sequence.wrapping_add(1);
                // The stamp goes in immediately before the send, so the instant
                // it carries is the actual send instant and nothing this
                // generator does afterwards can be charged to the server's
                // ingest latency. `intended` is the scheduled deadline nearest
                // that instant; their difference is the schedule-lag floor the
                // gate reports beside every ingest percentile.
                let actual_ns = monotonic_ns();
                let intended_ns =
                    nearest_deadline_ns(steady_started_ns, offset, interval, actual_ns);
                schedule_lag.record_signed(actual_ns as i64 - intended_ns as i64);
                write_stamp(&mut payload, intended_ns, actual_ns, sequence);
                match conn.send_datagram(&payload) {
                    Ok(()) => { counters.datagrams_sent.fetch_add(1, Ordering::Relaxed); }
                    Err(_) => { counters.datagrams_err.fetch_add(1, Ordering::Relaxed); }
                }
            }
            received = conn.receive_datagram() => {
                match received {
                    Ok(_) => { counters.datagrams_received.fetch_add(1, Ordering::Relaxed); }
                    Err(_) => {
                        // A session lost mid-steady still offered whatever its
                        // schedule had made due up to the moment it died; not
                        // accounting for it would quietly forgive the shortfall.
                        account_steady(
                counters,
                steady_started_at,
                interval,
                phase_offset,
                &mut steady_accounted,
            );
                        counters.sessions_lost.fetch_add(1, Ordering::Relaxed);
                        return;
                    }
                }
            }
        }
    }

    conn.close(0u32.into(), b"scale run complete");
}

#[cfg(test)]
mod tests {
    use super::{
        escape, expected_ticks, first_tick_offset, json_num, json_u64, nearest_deadline_ns,
        parse_or_default, percentile, ticks_due_after,
    };
    use std::time::Duration;

    #[test]
    fn expected_ticks_matches_the_nominal_rate() {
        // Pre-registered profile: 120 s window, 5 s interval, ticks at
        // 2.5, 7.5 .. 117.5 s. Exactly 24 — the nominal 0.2/s — with no tick
        // within half an interval of either edge.
        assert_eq!(
            expected_ticks(Duration::from_secs(120), Duration::from_secs(5)),
            24
        );
        assert_eq!(
            expected_ticks(Duration::from_secs(121), Duration::from_secs(5)),
            24
        );
    }

    #[test]
    fn ticks_due_is_stable_across_the_window_edge() {
        let interval = Duration::from_secs(5);
        // The half-interval offset puts the boundary in the middle of a slot, so
        // a snapshot taken slightly early or slightly late books the same count.
        for skew_ms in [-100i64, -1, 0, 1, 100] {
            let elapsed = Duration::from_millis((120_000 + skew_ms) as u64);
            assert_eq!(
                ticks_due_after(elapsed, interval, 0.0),
                24,
                "skew {skew_ms}ms"
            );
        }
    }

    #[test]
    fn stagger_spreads_first_ticks_over_one_interval_and_is_off_by_default() {
        let interval = Duration::from_secs(5);
        // Off: every session's first tick is the registered half interval, so
        // the aligned arrival process is byte-for-byte the original rule.
        assert_eq!(
            first_tick_offset(interval, 0.0),
            Duration::from_millis(2500)
        );
        // On: session i of N adds i/N of an interval, so N sessions present a
        // smooth arrival instead of one N-packet impulse per interval.
        assert_eq!(
            first_tick_offset(interval, 0.25),
            Duration::from_millis(3750)
        );
        assert_eq!(
            first_tick_offset(interval, 0.5),
            Duration::from_millis(5000)
        );
        // Fractions outside [0,1] cannot pull a tick before the window.
        assert_eq!(
            first_tick_offset(interval, -1.0),
            Duration::from_millis(2500)
        );
        assert_eq!(
            first_tick_offset(interval, 9.0),
            Duration::from_millis(7500)
        );
    }

    #[test]
    fn staggered_sessions_are_charged_their_own_ticks() {
        let interval = Duration::from_secs(5);
        let window = Duration::from_secs(120);
        // A session offset by nearly a whole interval loses the tick that no
        // longer fits, and is charged for exactly that — the denominator is the
        // session's own schedule, never the nominal one.
        assert_eq!(ticks_due_after(window, interval, 0.0), 24);
        assert_eq!(ticks_due_after(window, interval, 0.5), 24);
        assert_eq!(ticks_due_after(window, interval, 0.9), 23);
        // Nominal stays the un-staggered figure, reported beside the measured one.
        assert_eq!(expected_ticks(window, interval), 24);
    }

    #[test]
    fn schedule_lag_survives_a_skipped_tick() {
        let interval = Duration::from_secs(5);
        let offset = Duration::from_millis(2500);
        let start = 1_000_000_000u64;
        let deadline = |ns: u64| nearest_deadline_ns(start, offset, interval, ns);
        // On time: the deadline is the tick's own.
        assert_eq!(deadline(start + 2_500_000_000), start + 2_500_000_000);
        // 3 ms late against the third deadline, not 5.003 s late against the
        // second — a `Skip` ticker that dropped a tick must not be reported as
        // an interval of lag it never had.
        assert_eq!(deadline(start + 12_503_000_000), start + 12_500_000_000);
        // Before the first deadline the schedule has not started; clamp there
        // rather than book a negative lag as a shared-clock violation.
        assert_eq!(deadline(start), start + 2_500_000_000);
    }

    #[test]
    fn expected_ticks_is_zero_when_no_tick_fits() {
        // Half an interval in, so a window shorter than that holds no tick.
        assert_eq!(
            expected_ticks(Duration::from_secs(2), Duration::from_secs(5)),
            0
        );
        assert_eq!(expected_ticks(Duration::ZERO, Duration::from_secs(5)), 0);
        assert_eq!(expected_ticks(Duration::from_secs(5), Duration::ZERO), 0);
    }

    #[test]
    fn parse_or_default_falls_back_on_garbage() {
        let parsed: usize = parse_or_default("--sessions", Some("nope".to_string()), 100);
        assert_eq!(parsed, 100);
    }

    #[test]
    fn percentile_picks_expected_ranks() {
        let sorted = [1u64, 2, 3, 4, 5, 6, 7, 8, 9, 10];
        assert_eq!(percentile(&sorted, 0.50), Some(6));
        assert_eq!(percentile(&sorted, 0.99), Some(10));
        assert_eq!(percentile(&[], 0.5), None);
    }

    #[test]
    fn json_helpers_emit_null_for_missing_values() {
        assert_eq!(json_num(None), "null");
        assert_eq!(json_num(Some(f64::NAN)), "null");
        assert_eq!(json_u64(None), "null");
        assert_eq!(json_num(Some(1.5)), "1.50");
    }

    #[test]
    fn escape_neutralizes_quotes_and_control_chars() {
        assert_eq!(escape("a\"b\\c\nd"), "a\\\"b\\\\c d");
    }
}
