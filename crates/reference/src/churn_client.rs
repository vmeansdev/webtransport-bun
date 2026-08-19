//! G9's generator: a cumulative-deadline arrival clock for short-lived
//! request/response sessions, and the long-lived base tier they arrive on top
//! of.
//!
//! Companion to `tools/load/bench-g9.ts`; the ladder, the clauses and every
//! falsifier live in `docs/research/preregistrations/gate-g9-churn.md`. This
//! binary offers load and measures the client half. It decides nothing.
//!
//! **The one thing this file exists to get right.** The four-axes accept-rate
//! figures were retracted because `acceptsPerSec × mean accept latency ≈ 500` at
//! every rung — Little's law on the generator's own connect semaphore. So there
//! is **no semaphore anywhere in the arrival path**. Arrivals are owed to an
//! absolute clock:
//!
//! > shard `s` owes its `n`-th arrival at `t0 + (s/S + n) · S/R`
//!
//! and the shard sleeps to that deadline, **spawns** the cycle detached, and
//! goes straight to `n+1`. Nothing in the arrival path ever awaits a connect, a
//! handshake, a stream or a close. If the server slows, cycles pile up in
//! flight, the pile-up is reported, and it is the finding — it is never absorbed
//! into the arrival rate. `connectConcurrency` is emitted as `null` rather than
//! `0`, because "no pool" and "a pool of some size" are exactly the two states
//! the Little's-law falsifier has to tell apart.
//!
//! **The honesty stamp is taken before any await** (ticket 26): `arrivalLag` is
//! deadline → the shard being ready to hand over, recorded on the line before
//! the spawn. `connectDuration` — the product's own cost — is a separate
//! instrument. Phase 1 of G3 measured one across the other and produced a 3.6×
//! artifact; that mistake is structurally unavailable here.
//!
//! Two roles, run as separate processes so the two tiers' CPU can be attributed
//! separately:
//!
//! * `churn` — the arrival clock and the connect → exchange → close cycles.
//! * `base`  — long-lived sessions on a fixed datagram cadence, echoed, so the
//!   base tier carries a round trip on one clock and C4 has an instrument.

// Shared with the other load binaries so both ends of a stamp are one
// implementation.
#[allow(dead_code)]
mod latency_probe;

use latency_probe::{
    monotonic_ns, read_stamp, write_stamp_v3, AtomicHistogram, CLASS_ACK, CLASS_MOVE,
    STAMP_BYTES_V3,
};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use wtransport::{ClientConfig, Endpoint};

const DEFAULT_URL: &str = "https://127.0.0.1:4433";
/// The base tier is long-lived and must survive the whole arm without the idle
/// timeout reaping it; the churn tier never lives long enough to care.
const KEEP_ALIVE: Duration = Duration::from_secs(15);
const MAX_IDLE: Duration = Duration::from_secs(60);
const MAX_RECORDED_ERRORS: usize = 6;
/// Self-guard ceiling for this process's own RSS. A generator that takes the
/// host down leaves no evidence behind; aborting costs one cell.
const CLIENT_RSS_LIMIT_MB: f64 = 12_288.0;
const RSS_GUARD_INTERVAL: Duration = Duration::from_secs(2);
const EXIT_RSS_GUARD: i32 = 91;
/// §3.1's safety abort. Distinct exit code so the conductor can bucket the cell
/// `generator-overrun` (INCOMPLETE) rather than reading it as a miss.
const EXIT_ABORT_CEILING: i32 = 92;

/* -------------------------------------------------------------------------- */
/* Options                                                                     */
/* -------------------------------------------------------------------------- */

#[derive(Clone, Debug)]
struct Options {
    role: String,
    url: String,
    /// Distinct source endpoints. Each binds its own `<prefix>.k.1` address, so
    /// each is its own /24 and the shipped per-prefix cap is not engaged.
    source_endpoints: usize,
    /// First two octets of the source-address pool. `127.0` on-box; the cable
    /// run passes the Mac's alias base (§8 of the registration).
    bind_prefix: (u8, u8),
    /* churn role */
    churn_rate_per_sec: f64,
    arrival_shards: usize,
    request_bytes: usize,
    response_bytes: usize,
    abort_ceiling: u64,
    /* base role */
    base_sessions: usize,
    base_interval: Duration,
    base_payload_bytes: usize,
    /* windows */
    ramp: Duration,
    steady: Duration,
    settle: Duration,
    /// Bound on how long the process waits for in-flight cycles after the last
    /// arrival. Never a permit: it cannot delay an arrival, only the report.
    drain_grace: Duration,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            role: "churn".to_string(),
            url: DEFAULT_URL.to_string(),
            source_endpoints: 64,
            bind_prefix: (127, 0),
            churn_rate_per_sec: 0.0,
            arrival_shards: 8,
            request_bytes: 256,
            response_bytes: 1024,
            abort_ceiling: 5_600,
            base_sessions: 0,
            base_interval: Duration::from_millis(100),
            base_payload_bytes: 200,
            ramp: Duration::from_secs(30),
            steady: Duration::from_secs(120),
            settle: Duration::from_secs(30),
            drain_grace: Duration::from_secs(15),
        }
    }
}

fn parse_or<T: std::str::FromStr>(flag: &str, raw: Option<String>, fallback: T) -> T {
    match raw {
        Some(v) => v.parse().unwrap_or_else(|_| {
            eprintln!("churn-client: could not parse {flag}, using the default");
            fallback
        }),
        None => fallback,
    }
}

fn parse_prefix(raw: Option<String>, fallback: (u8, u8)) -> (u8, u8) {
    let Some(v) = raw else { return fallback };
    let mut parts = v.split('.');
    match (
        parts.next().and_then(|p| p.parse::<u8>().ok()),
        parts.next().and_then(|p| p.parse::<u8>().ok()),
    ) {
        (Some(a), Some(b)) => (a, b),
        _ => {
            eprintln!("churn-client: could not parse --bind-prefix, using the default");
            fallback
        }
    }
}

fn parse_args() -> Options {
    let mut o = Options::default();
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--role" => o.role = args.next().unwrap_or(o.role),
            "--url" => o.url = args.next().unwrap_or(o.url),
            "--source-endpoints" => {
                o.source_endpoints =
                    parse_or("--source-endpoints", args.next(), o.source_endpoints).max(1)
            }
            "--bind-prefix" => o.bind_prefix = parse_prefix(args.next(), o.bind_prefix),
            "--churn-rate" => {
                o.churn_rate_per_sec = parse_or("--churn-rate", args.next(), o.churn_rate_per_sec)
            }
            "--arrival-shards" => {
                o.arrival_shards =
                    parse_or("--arrival-shards", args.next(), o.arrival_shards).max(1)
            }
            "--request-bytes" => {
                o.request_bytes =
                    parse_or("--request-bytes", args.next(), o.request_bytes).max(STAMP_BYTES_V3)
            }
            "--response-bytes" => {
                o.response_bytes = parse_or("--response-bytes", args.next(), o.response_bytes)
            }
            "--abort-ceiling" => {
                o.abort_ceiling = parse_or("--abort-ceiling", args.next(), o.abort_ceiling)
            }
            "--base-sessions" => {
                o.base_sessions = parse_or("--base-sessions", args.next(), o.base_sessions)
            }
            "--base-interval-ms" => {
                o.base_interval = Duration::from_millis(parse_or(
                    "--base-interval-ms",
                    args.next(),
                    o.base_interval.as_millis() as u64,
                ))
            }
            "--base-payload-bytes" => {
                o.base_payload_bytes =
                    parse_or("--base-payload-bytes", args.next(), o.base_payload_bytes)
                        .max(STAMP_BYTES_V3)
            }
            "--ramp-secs" => {
                o.ramp = Duration::from_secs(parse_or("--ramp-secs", args.next(), o.ramp.as_secs()))
            }
            "--steady-secs" => {
                o.steady =
                    Duration::from_secs(parse_or("--steady-secs", args.next(), o.steady.as_secs()))
            }
            "--settle-secs" => {
                o.settle =
                    Duration::from_secs(parse_or("--settle-secs", args.next(), o.settle.as_secs()))
            }
            "--drain-grace-secs" => {
                o.drain_grace = Duration::from_secs(parse_or(
                    "--drain-grace-secs",
                    args.next(),
                    o.drain_grace.as_secs(),
                ))
            }
            other => eprintln!("churn-client: ignoring unknown flag {other}"),
        }
    }
    o
}

/* -------------------------------------------------------------------------- */
/* Counters and histograms                                                     */
/* -------------------------------------------------------------------------- */

#[derive(Default)]
struct Errors {
    connect: AtomicU64,
    open: AtomicU64,
    write: AtomicU64,
    read: AtomicU64,
    close: AtomicU64,
    samples: std::sync::Mutex<Vec<String>>,
}

impl Errors {
    fn record(&self, counter: &AtomicU64, what: &str, e: impl std::fmt::Display) {
        counter.fetch_add(1, Ordering::Relaxed);
        if let Ok(mut s) = self.samples.lock() {
            if s.len() < MAX_RECORDED_ERRORS {
                s.push(format!("{what}: {e}"));
            }
        }
    }
    fn samples_json(&self) -> String {
        let s = self.samples.lock().map(|v| v.clone()).unwrap_or_default();
        let quoted: Vec<String> = s
            .iter()
            .map(|m| format!("\"{}\"", m.replace('\\', "\\\\").replace('"', "\\\"")))
            .collect();
        format!("[{}]", quoted.join(","))
    }
}

struct Shared {
    stop_arrivals: AtomicBool,
    aborted: AtomicBool,
    /* the arrival clock's own accounting */
    arrivals_issued: AtomicU64,
    arrivals_in_graded_window: AtomicU64,
    in_flight: AtomicU64,
    in_flight_high_water: AtomicU64,
    /* cycles */
    cycles_completed: AtomicU64,
    cycles_completed_graded: AtomicU64,
    request_bytes_sent: AtomicU64,
    response_bytes_read: AtomicU64,
    /* base */
    base_sent: AtomicU64,
    base_echoes: AtomicU64,
    base_sessions_lost: AtomicU64,
    /* histograms — the graded window only, so a ramp sample can never
     * contaminate a percentile the gate reads */
    arrival_lag: AtomicHistogram,
    connect_duration: AtomicHistogram,
    exchange_rtt: AtomicHistogram,
    close_duration: AtomicHistogram,
    cycle_duration: AtomicHistogram,
    base_rtt: AtomicHistogram,
    /* cumulative cycle time, for the mean V-M and V-P read */
    cycle_ns_sum: AtomicU64,
    errors: Errors,
}

impl Shared {
    fn new() -> Self {
        Self {
            stop_arrivals: AtomicBool::new(false),
            aborted: AtomicBool::new(false),
            arrivals_issued: AtomicU64::new(0),
            arrivals_in_graded_window: AtomicU64::new(0),
            in_flight: AtomicU64::new(0),
            in_flight_high_water: AtomicU64::new(0),
            cycles_completed: AtomicU64::new(0),
            cycles_completed_graded: AtomicU64::new(0),
            request_bytes_sent: AtomicU64::new(0),
            response_bytes_read: AtomicU64::new(0),
            base_sent: AtomicU64::new(0),
            base_echoes: AtomicU64::new(0),
            base_sessions_lost: AtomicU64::new(0),
            arrival_lag: AtomicHistogram::new(),
            connect_duration: AtomicHistogram::new(),
            exchange_rtt: AtomicHistogram::new(),
            close_duration: AtomicHistogram::new(),
            cycle_duration: AtomicHistogram::new(),
            base_rtt: AtomicHistogram::new(),
            cycle_ns_sum: AtomicU64::new(0),
            errors: Errors::default(),
        }
    }

    fn note_in_flight(&self, now: u64) {
        self.in_flight_high_water.fetch_max(now, Ordering::Relaxed);
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

/// One endpoint per source address. Each address sits in its own /24, which is
/// what keeps the shipped per-prefix concurrency cap (100) off the arm while the
/// per-IP caps (40 concurrent, 20/s) are the ceilings the ladder is derived
/// from. A bind that fails falls back to the default and is **counted**, because
/// silently collapsing the pool would move the derived ceiling without saying so.
fn build_endpoints(
    count: usize,
    prefix: (u8, u8),
) -> Result<EndpointPool, Box<dyn std::error::Error>> {
    let mut endpoints = Vec::with_capacity(count);
    let mut distinct_source_ips = 0usize;
    for k in 0..count {
        let mut endpoint = None;
        if count > 1 {
            let octet = u8::try_from(1 + (k % 250)).unwrap_or(1);
            let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::new(prefix.0, prefix.1, octet, 1)), 0);
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
                Err(e) => eprintln!("churn-client: bind {addr} failed ({e}); using default bind"),
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

/* -------------------------------------------------------------------------- */
/* Self-observation                                                            */
/* -------------------------------------------------------------------------- */

fn self_rss_mb() -> Option<f64> {
    let text = std::fs::read_to_string("/proc/self/status").ok()?;
    let line = text.lines().find(|l| l.starts_with("VmRSS:"))?;
    let kb: f64 = line.split_whitespace().nth(1)?.parse().ok()?;
    Some(kb / 1024.0)
}

/// utime + stime in seconds. V-G reads this against the generator's own cores,
/// because a generator that saturated is INCOMPLETE and never a miss.
///
/// Parsed from the **last** `)`, not the first: field 2 of `/proc/self/stat` is
/// the executable name in parentheses and may itself contain them.
fn self_cpu_secs() -> Option<f64> {
    const CLOCK_TICKS_PER_SEC: f64 = 100.0;
    let text = std::fs::read_to_string("/proc/self/stat").ok()?;
    let after_comm = text.rfind(')')?;
    let fields: Vec<&str> = text.get(after_comm + 1..)?.split_whitespace().collect();
    // The first field after `)` is `state` (field 3), so utime (field 14) and
    // stime (field 15) sit at offsets 11 and 12.
    let utime: f64 = fields.get(11)?.parse().ok()?;
    let stime: f64 = fields.get(12)?.parse().ok()?;
    Some((utime + stime) / CLOCK_TICKS_PER_SEC)
}

fn spawn_rss_guard() {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(RSS_GUARD_INTERVAL).await;
            let Some(rss) = self_rss_mb() else { continue };
            if rss > CLIENT_RSS_LIMIT_MB {
                println!(
                    "churn-client: abort client-rss-guard rssMb={rss:.1} limitMb={CLIENT_RSS_LIMIT_MB:.0}"
                );
                let _ = std::io::Write::flush(&mut std::io::stdout());
                std::process::exit(EXIT_RSS_GUARD);
            }
        }
    });
}

/* -------------------------------------------------------------------------- */
/* The arrival clock                                                           */
/* -------------------------------------------------------------------------- */

/// One cumulative-deadline shard. See the module header for why there is no
/// permit anywhere in here.
async fn arrival_shard(
    shard: usize,
    options: Arc<Options>,
    shared: Arc<Shared>,
    endpoints: Arc<Vec<Arc<ClientEndpoint>>>,
    t0: Instant,
) {
    let shards = options.arrival_shards as f64;
    let per_shard = Duration::from_secs_f64(shards / options.churn_rate_per_sec);
    let phase_offset = per_shard.mul_f64(shard as f64 / shards);
    let graded_from = options.ramp;
    let graded_to = options.ramp + options.steady;
    let mut n: u64 = 0;

    loop {
        // The deadline this arrival is owed, measured from step start. An
        // oversleep shortens the next sleep instead of accumulating; the arm
        // cannot run ahead of the clock, so the only possible error direction is
        // under-offering.
        let due = phase_offset + per_shard.mul_f64(n as f64);
        if due >= graded_to + options.drain_grace {
            break;
        }
        let elapsed = t0.elapsed();
        if due > elapsed {
            tokio::time::sleep(due - elapsed).await;
        }
        n += 1;
        if shared.stop_arrivals.load(Ordering::Relaxed) {
            break;
        }
        if t0.elapsed() >= graded_to {
            break;
        }

        // The honesty stamp, taken here — before anything is awaited. Ticket 26:
        // recording this across the product call is what produced G3 phase 1's
        // 3.6x artifact.
        let ready = Instant::now();
        let deadline_instant = t0 + due;
        let lag_ns = ready.saturating_duration_since(deadline_instant).as_nanos() as u64;
        let graded = due >= graded_from && due < graded_to;
        if graded {
            shared.arrival_lag.record(lag_ns);
            shared
                .arrivals_in_graded_window
                .fetch_add(1, Ordering::Relaxed);
        }
        shared.arrivals_issued.fetch_add(1, Ordering::Relaxed);

        let now_in_flight = shared.in_flight.fetch_add(1, Ordering::Relaxed) + 1;
        shared.note_in_flight(now_in_flight);
        if now_in_flight > options.abort_ceiling {
            shared.aborted.store(true, Ordering::Relaxed);
            println!(
                "churn-client: abort generator-overrun inFlight={now_in_flight} ceiling={}",
                options.abort_ceiling
            );
            let _ = std::io::Write::flush(&mut std::io::stdout());
            std::process::exit(EXIT_ABORT_CEILING);
        }

        let endpoint = Arc::clone(&endpoints[(n as usize) % endpoints.len()]);
        let opts = Arc::clone(&options);
        let sh = Arc::clone(&shared);
        // Detached. The clock never waits on this.
        tokio::spawn(async move {
            run_cycle(endpoint, opts, sh, ready, graded).await;
        });
    }
}

/// One connect → exchange → close cycle. Every span it records starts at the
/// arrival handoff, so the full setup cost a user would feel is what C3 grades
/// — not the partial span the server's own histogram can see (K25).
async fn run_cycle(
    endpoint: Arc<ClientEndpoint>,
    options: Arc<Options>,
    shared: Arc<Shared>,
    handoff: Instant,
    graded: bool,
) {
    let finish = |sh: &Shared| {
        sh.in_flight.fetch_sub(1, Ordering::Relaxed);
    };

    let conn = match endpoint.connect(&options.url).await {
        Ok(c) => c,
        Err(e) => {
            shared.errors.record(&shared.errors.connect, "connect", e);
            finish(&shared);
            return;
        }
    };
    if graded {
        shared
            .connect_duration
            .record(handoff.elapsed().as_nanos() as u64);
    }

    let exchange_started = Instant::now();
    let mut request = vec![0u8; options.request_bytes];
    let now_ns = monotonic_ns();
    write_stamp_v3(&mut request, now_ns, now_ns, 0, CLASS_MOVE);

    let opened = match conn.open_bi().await {
        Ok(pending) => pending.await,
        Err(e) => {
            shared.errors.record(&shared.errors.open, "open_bi", e);
            conn.close(0u32.into(), b"g9 open failed");
            finish(&shared);
            return;
        }
    };
    let (mut send, mut recv) = match opened {
        Ok(pair) => pair,
        Err(e) => {
            shared.errors.record(&shared.errors.open, "open_bi", e);
            conn.close(0u32.into(), b"g9 open failed");
            finish(&shared);
            return;
        }
    };

    if let Err(e) = send.write_all(&request).await {
        shared.errors.record(&shared.errors.write, "write", e);
        conn.close(0u32.into(), b"g9 write failed");
        finish(&shared);
        return;
    }
    if let Err(e) = send.finish().await {
        shared.errors.record(&shared.errors.write, "finish", e);
        conn.close(0u32.into(), b"g9 finish failed");
        finish(&shared);
        return;
    }
    shared
        .request_bytes_sent
        .fetch_add(request.len() as u64, Ordering::Relaxed);

    let mut read_total = 0usize;
    let mut chunk = vec![0u8; 4096];
    loop {
        match recv.read(&mut chunk).await {
            Ok(Some(n)) => read_total += n,
            Ok(None) => break,
            Err(e) => {
                shared.errors.record(&shared.errors.read, "read", e);
                conn.close(0u32.into(), b"g9 read failed");
                finish(&shared);
                return;
            }
        }
    }
    shared
        .response_bytes_read
        .fetch_add(read_total as u64, Ordering::Relaxed);
    if graded {
        shared
            .exchange_rtt
            .record(exchange_started.elapsed().as_nanos() as u64);
    }

    let close_started = Instant::now();
    conn.close(0u32.into(), b"g9 cycle complete");
    if graded {
        shared
            .close_duration
            .record(close_started.elapsed().as_nanos() as u64);
    }

    let total_ns = handoff.elapsed().as_nanos() as u64;
    shared.cycle_ns_sum.fetch_add(total_ns, Ordering::Relaxed);
    shared.cycles_completed.fetch_add(1, Ordering::Relaxed);
    if graded {
        shared.cycle_duration.record(total_ns);
        shared
            .cycles_completed_graded
            .fetch_add(1, Ordering::Relaxed);
    }
    finish(&shared);
}

/* -------------------------------------------------------------------------- */
/* The base tier                                                               */
/* -------------------------------------------------------------------------- */

/// One long-lived session on a fixed cadence, echoed by the server. Sessions are
/// phase-offset across one interval — G1's registered staggered process, for
/// T02's reason: a synchronized fleet is an impulse, and the impulse case is
/// deliberately out of this gate's scope.
async fn run_base_session(
    index: usize,
    total: usize,
    options: Arc<Options>,
    shared: Arc<Shared>,
    endpoint: Arc<ClientEndpoint>,
    runs_for: Duration,
) {
    let conn = match endpoint.connect(&options.url).await {
        Ok(c) => c,
        Err(e) => {
            shared
                .errors
                .record(&shared.errors.connect, "base connect", e);
            shared.base_sessions_lost.fetch_add(1, Ordering::Relaxed);
            return;
        }
    };

    let offset = options
        .base_interval
        .mul_f64(index as f64 / total.max(1) as f64);
    tokio::time::sleep(offset).await;

    let started = Instant::now();
    let mut ticker = tokio::time::interval(options.base_interval);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut sequence: u64 = 0;
    let mut payload = vec![0u8; options.base_payload_bytes];

    loop {
        if started.elapsed() >= runs_for {
            break;
        }
        tokio::select! {
            _ = ticker.tick() => {
                let now_ns = monotonic_ns();
                write_stamp_v3(&mut payload, now_ns, now_ns, sequence, CLASS_MOVE);
                sequence += 1;
                if conn.send_datagram(&payload).is_ok() {
                    shared.base_sent.fetch_add(1, Ordering::Relaxed);
                }
            }
            received = conn.receive_datagram() => {
                match received {
                    Ok(d) => {
                        // Single clock, both ends of the span taken here: a
                        // legitimate round trip for an off-box generator, which
                        // a one-way stamp could never be.
                        if let Some(stamp) = read_stamp(&d) {
                            if stamp.class == CLASS_MOVE || stamp.class == CLASS_ACK {
                                let rtt = monotonic_ns() as i64 - stamp.actual_ns as i64;
                                shared.base_rtt.record_signed(rtt);
                                shared.base_echoes.fetch_add(1, Ordering::Relaxed);
                            }
                        }
                    }
                    Err(e) => {
                        shared.errors.record(&shared.errors.read, "base session", e);
                        shared.base_sessions_lost.fetch_add(1, Ordering::Relaxed);
                        return;
                    }
                }
            }
        }
    }
    conn.close(0u32.into(), b"g9 base done");
}

/* -------------------------------------------------------------------------- */
/* Report                                                                      */
/* -------------------------------------------------------------------------- */

#[allow(clippy::too_many_lines)]
fn report(
    options: &Options,
    shared: &Shared,
    pool: &EndpointPool,
    cpu_secs: Option<f64>,
) -> String {
    let completed = shared.cycles_completed.load(Ordering::Relaxed);
    let mean_cycle_sec = if completed == 0 {
        "null".to_string()
    } else {
        format!(
            "{:.9}",
            shared.cycle_ns_sum.load(Ordering::Relaxed) as f64 / completed as f64 / 1e9
        )
    };
    let rss = self_rss_mb()
        .map(|v| format!("{v:.1}"))
        .unwrap_or_else(|| "null".to_string());
    let cpu = cpu_secs
        .map(|v| format!("{v:.3}"))
        .unwrap_or_else(|| "null".to_string());

    format!(
        concat!(
            "{{\"role\":\"{}\",",
            // The registered configuration is *no pool*, and `null` says so in a
            // way `0` cannot. V-L's generator reading stands down on `null` and
            // would otherwise have a number to work with.
            "\"connectConcurrency\":null,",
            "\"churnRatePerSec\":{},\"arrivalShards\":{},",
            "\"sourceEndpoints\":{},\"distinctSourceIps\":{},",
            "\"abortCeiling\":{},\"aborted\":{},",
            "\"rampSec\":{},\"steadySec\":{},\"settleSec\":{},",
            "\"arrivalsIssued\":{},\"arrivalsInGradedWindow\":{},",
            "\"cyclesCompleted\":{},\"cyclesCompletedGraded\":{},",
            "\"inFlightHighWater\":{},\"meanCycleSec\":{},",
            "\"requestBytesSent\":{},\"responseBytesRead\":{},",
            "\"baseSessions\":{},\"baseSent\":{},\"baseEchoes\":{},\"baseSessionsLost\":{},",
            "\"errors\":{{\"connect\":{},\"open\":{},\"write\":{},\"read\":{},\"close\":{},\"samples\":{}}},",
            "\"clientCpuSec\":{},\"clientRssMb\":{},\"cores\":{},",
            "\"histograms\":{{\"arrivalLag\":{},\"connectDuration\":{},",
            "\"exchangeRtt\":{},\"closeDuration\":{},\"cycleDuration\":{},\"baseRtt\":{}}}}}"
        ),
        options.role,
        options.churn_rate_per_sec,
        options.arrival_shards,
        options.source_endpoints,
        pool.distinct_source_ips,
        options.abort_ceiling,
        shared.aborted.load(Ordering::Relaxed),
        options.ramp.as_secs(),
        options.steady.as_secs(),
        options.settle.as_secs(),
        shared.arrivals_issued.load(Ordering::Relaxed),
        shared.arrivals_in_graded_window.load(Ordering::Relaxed),
        completed,
        shared.cycles_completed_graded.load(Ordering::Relaxed),
        shared.in_flight_high_water.load(Ordering::Relaxed),
        mean_cycle_sec,
        shared.request_bytes_sent.load(Ordering::Relaxed),
        shared.response_bytes_read.load(Ordering::Relaxed),
        options.base_sessions,
        shared.base_sent.load(Ordering::Relaxed),
        shared.base_echoes.load(Ordering::Relaxed),
        shared.base_sessions_lost.load(Ordering::Relaxed),
        shared.errors.connect.load(Ordering::Relaxed),
        shared.errors.open.load(Ordering::Relaxed),
        shared.errors.write.load(Ordering::Relaxed),
        shared.errors.read.load(Ordering::Relaxed),
        shared.errors.close.load(Ordering::Relaxed),
        shared.errors.samples_json(),
        cpu,
        rss,
        std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(1),
        shared.arrival_lag.to_json(),
        shared.connect_duration.to_json(),
        shared.exchange_rtt.to_json(),
        shared.close_duration.to_json(),
        shared.cycle_duration.to_json(),
        shared.base_rtt.to_json(),
    )
}

/* -------------------------------------------------------------------------- */
/* Entry                                                                       */
/* -------------------------------------------------------------------------- */

async fn run(options: Options) -> Result<(), Box<dyn std::error::Error>> {
    let options = Arc::new(options);
    let shared = Arc::new(Shared::new());
    let pool = build_endpoints(options.source_endpoints, options.bind_prefix)?;
    let endpoints = Arc::new(pool.endpoints.clone());
    spawn_rss_guard();
    let cpu_at_start = self_cpu_secs();

    println!(
        "churn-client: role={} url={} rate={}/s shards={} endpoints={} (distinct {}) base={} windows={}s/{}s/{}s",
        options.role,
        options.url,
        options.churn_rate_per_sec,
        options.arrival_shards,
        options.source_endpoints,
        pool.distinct_source_ips,
        options.base_sessions,
        options.ramp.as_secs(),
        options.steady.as_secs(),
        options.settle.as_secs(),
    );

    let t0 = Instant::now();
    let mut handles = Vec::new();

    if options.role == "base" || options.base_sessions > 0 {
        // The base outlives the churn *and* the conductor's settle sample. The
        // leak clause reads `registryEntries == baseSessions` at the end of the
        // settle window, and C4 counts base sessions lost — so a base tier that
        // exits on the same clock as the sample makes both of those read zero
        // base sessions and pass or fail for the wrong reason. A full extra
        // settle window of headroom is the margin; the conductor closes the
        // server, which is what actually ends these sessions.
        let runs_for = options.ramp + options.steady + options.settle * 2;
        for i in 0..options.base_sessions {
            let endpoint = Arc::clone(&endpoints[i % endpoints.len()]);
            handles.push(tokio::spawn(run_base_session(
                i,
                options.base_sessions,
                Arc::clone(&options),
                Arc::clone(&shared),
                endpoint,
                runs_for,
            )));
        }
    }

    if options.role == "churn" && options.churn_rate_per_sec > 0.0 {
        for shard in 0..options.arrival_shards {
            handles.push(tokio::spawn(arrival_shard(
                shard,
                Arc::clone(&options),
                Arc::clone(&shared),
                Arc::clone(&endpoints),
                t0,
            )));
        }
    }

    for h in handles {
        let _ = h.await;
    }
    shared.stop_arrivals.store(true, Ordering::Relaxed);

    // Bounded wait for detached cycles. This is a bound on the *report*, never
    // on an arrival, so it is not a permit under another name.
    let drain_started = Instant::now();
    while shared.in_flight.load(Ordering::Relaxed) > 0
        && drain_started.elapsed() < options.drain_grace
    {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    let cpu_secs = match (cpu_at_start, self_cpu_secs()) {
        (Some(a), Some(b)) => Some(b - a),
        _ => None,
    };
    println!(
        "CHURN_REPORT {}",
        report(&options, &shared, &pool, cpu_secs)
    );
    let _ = std::io::Write::flush(&mut std::io::stdout());
    Ok(())
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let options = parse_args();
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    runtime.block_on(run(options))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The arrival deadline series is the whole design, so it is arithmetic that
    /// can be checked without a server. Shard `s`'s `n`-th arrival is owed at
    /// `(s/S + n) · S/R`, which interleaves the shards into one even train at R.
    fn due_secs(shard: usize, n: u64, shards: usize, rate: f64) -> f64 {
        let per_shard = shards as f64 / rate;
        per_shard * (shard as f64 / shards as f64) + per_shard * n as f64
    }

    #[test]
    fn shards_interleave_into_one_even_train_at_the_offered_rate() {
        let (shards, rate) = (8usize, 600.0);
        let mut all: Vec<f64> = Vec::new();
        for s in 0..shards {
            for n in 0..100u64 {
                all.push(due_secs(s, n, shards, rate));
            }
        }
        all.sort_by(|a, b| a.partial_cmp(b).unwrap());
        for w in all.windows(2) {
            assert!(
                (w[1] - w[0] - 1.0 / rate).abs() < 1e-9,
                "interleaved arrivals must be exactly 1/R apart"
            );
        }
    }

    #[test]
    fn a_shard_owes_its_arrivals_on_the_widened_interval() {
        // 13.333 ms at the gate rung, which is what makes a timer oversleep cost
        // three arrivals on one shard rather than twenty-four globally.
        let interval = due_secs(0, 1, 8, 600.0) - due_secs(0, 0, 8, 600.0);
        assert!((interval - 0.013_333_333).abs() < 1e-6);
    }

    #[test]
    fn deadlines_do_not_accumulate_timer_error() {
        // The n-th deadline is a function of n alone, so an oversleep at k
        // cannot move the deadline at k+1. This is the property that makes the
        // arrival count explainable by the wall clock and nothing else.
        let a = due_secs(3, 1000, 8, 600.0);
        let b = due_secs(3, 0, 8, 600.0) + 1000.0 * (8.0 / 600.0);
        assert!((a - b).abs() < 1e-9);
    }

    #[test]
    fn the_pool_gives_every_endpoint_its_own_slash_24() {
        // 64 endpoints across 64 distinct /24s: the shipped per-prefix cap of
        // 100 concurrent sessions is not engaged, and the per-IP caps are what
        // the ladder is derived from.
        let mut prefixes = std::collections::HashSet::new();
        for k in 0..64usize {
            let octet = u8::try_from(1 + (k % 250)).unwrap();
            prefixes.insert((127u8, 0u8, octet));
        }
        assert_eq!(prefixes.len(), 64);
    }

    #[test]
    fn a_stamped_request_round_trips_through_the_shared_decoder() {
        let mut buf = vec![0u8; 256];
        write_stamp_v3(&mut buf, 11, 22, 33, CLASS_MOVE);
        let s = read_stamp(&buf).expect("request must decode");
        assert_eq!(s.actual_ns, 22);
        assert_eq!(s.sequence, 33);
        assert_eq!(s.version, 3);
    }

    #[test]
    fn a_negative_span_is_counted_and_never_recorded_as_zero() {
        let h = AtomicHistogram::new();
        h.record_signed(-1);
        let json = h.to_json();
        assert!(json.contains("\"negative\":1"), "{json}");
    }

    #[test]
    fn the_abort_ceiling_is_four_times_the_concurrency_budget() {
        // Mirrors `generatorAbortCeiling()` in g9-plan.ts. If the two drift the
        // harness and the registration disagree about what ends a rung.
        assert_eq!(Options::default().abort_ceiling, 4 * 1400);
    }

    #[test]
    fn the_defaults_are_the_registered_shape() {
        let o = Options::default();
        assert_eq!(o.arrival_shards, 8);
        assert_eq!(o.source_endpoints, 64);
        assert_eq!(o.request_bytes, 256);
        assert_eq!(o.response_bytes, 1024);
        assert_eq!(o.base_payload_bytes, 200);
        assert_eq!(o.base_interval, Duration::from_millis(100));
        assert_eq!(o.ramp.as_secs(), 30);
        assert_eq!(o.steady.as_secs(), 120);
        assert_eq!(o.settle.as_secs(), 30);
    }

    #[test]
    fn bind_prefix_parses_and_falls_back_rather_than_panicking() {
        assert_eq!(parse_prefix(Some("10.99".into()), (127, 0)), (10, 99));
        assert_eq!(parse_prefix(Some("nonsense".into()), (127, 0)), (127, 0));
        assert_eq!(parse_prefix(None, (127, 0)), (127, 0));
    }
}
