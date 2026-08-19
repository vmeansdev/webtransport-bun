//! G8's many-rooms generator and sink: pooled publishers, pooled subscribers,
//! and the mutual room where a session is both.
//!
//! Companion to `tools/load/bench-g8.ts`; the ladder, every clause and every
//! falsifier live in `docs/research/preregistrations/gate-g8-many-rooms.md`.
//! This binary offers load and measures the client half. It decides nothing.
//!
//! Three roles, because the shape needs at least three processes (ticket 14's
//! registered rule — an in-process publisher is how the retracted fan-out run
//! produced a 9–31 µs "ingest" path that never contained a network):
//!
//! * `publisher`  — a pooled slice of the run's publishers, at most 25 per
//!   process (§3.2). Each one has its own room, its own phase
//!   offset and its own schedule-lag histogram.
//! * `subscriber` — a pooled, *strided* slice of the run's subscribers, so a
//!   room's members are spread across sink processes and room
//!   identity stays independent of sink identity (§3.2).
//! * `mutual`     — arm C. The members publish to each other, so one session is
//!   a publisher and a sink at once and the two pools are one.
//!
//! **Per publisher, never per pool** (§3.3). A pooled aggregate lets twenty-four
//! healthy publishers hide one starved one, which is the negative-denominator
//! defect G3b's invalidation named. Every publisher therefore reports its own
//! counters and its own histogram, and the pool index is recorded beside them as
//! a deployment fact rather than an aggregation key.
//!
//! **The grid is cumulative-deadline** (§6 V-G, carried from G5b): the n-th
//! send's deadline is `start + phase + n × period`, never `previous + period`,
//! so the generator cannot drift. A deadline more than one period in the past is
//! *skipped and counted*, never caught up — catching up would emit exactly the
//! back-to-back burst that §1.6 spreads the publishers to avoid, and would
//! corrupt the per-room cadence the ingest-reality falsifier reads.

// Shared with the other load binaries so both ends of a stamp are one
// implementation.
#[allow(dead_code)]
mod latency_probe;

use latency_probe::{
    monotonic_ns, read_stamp, write_stamp_v3, AtomicHistogram, CLASS_ROOM_JOIN, CLASS_ROOM_MEDIA,
    STAMP_BYTES_V3,
};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use wtransport::{ClientConfig, Endpoint};

const DEFAULT_URL: &str = "https://127.0.0.1:4433";
const KEEP_ALIVE: Duration = Duration::from_secs(15);
const MAX_IDLE: Duration = Duration::from_secs(60);
const MAX_RECORDED_ERRORS: usize = 5;
const JOIN_TIMEOUT: Duration = Duration::from_secs(30);
/// Grace after the last send so a datagram already on the wire is not counted as
/// lost by a report snapshotted the instant the window closed.
const DRAIN_GRACE: Duration = Duration::from_millis(500);
/// Self-guard ceiling for this process's own RSS. A generator that takes the
/// host down leaves no evidence behind; aborting costs one arm.
const CLIENT_RSS_LIMIT_MB: f64 = 12_288.0;
const RSS_GUARD_INTERVAL: Duration = Duration::from_secs(2);
const EXIT_RSS_GUARD: i32 = 91;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Role {
    Publisher,
    Subscriber,
    Mutual,
}

impl Role {
    fn parse(raw: &str) -> Option<Role> {
        match raw {
            "publisher" | "pub" => Some(Role::Publisher),
            "subscriber" | "sub" => Some(Role::Subscriber),
            "mutual" => Some(Role::Mutual),
            _ => None,
        }
    }

    fn label(self) -> &'static str {
        match self {
            Role::Publisher => "publisher",
            Role::Subscriber => "subscriber",
            Role::Mutual => "mutual",
        }
    }

    fn publishes(self) -> bool {
        matches!(self, Role::Publisher | Role::Mutual)
    }

    fn receives(self) -> bool {
        matches!(self, Role::Subscriber | Role::Mutual)
    }
}

#[derive(Debug)]
struct Options {
    role: Role,
    url: String,
    /// Sessions this process owns.
    sessions: usize,
    /// Global index of this process's first session, before striding.
    index_base: usize,
    /// Stride between this process's global session indices. 1 for publishers
    /// (contiguous slices), the sink-process count for subscribers.
    index_stride: usize,
    /// Every publisher in the run, across every process. Phase offsets divide
    /// one frame period by this, so a process cannot spread against its own
    /// slice and call it spread.
    total_publishers: usize,
    /// Every subscriber in the run. Only used to map a global index to a room.
    total_subscribers: usize,
    /// Publishers per room: 1 for the broadcast arms, P for mutual.
    publishers_per_room: usize,
    /// Subscribers per room: K for the broadcast arms, 0 for mutual.
    subscribers_per_room: usize,
    rooms: usize,
    /// Datagrams per second, per publisher.
    rate_per_sec: f64,
    payload_bytes: usize,
    /// Seconds of steady drive. Connect and drain are outside it.
    duration_sec: f64,
    /// This process's index inside its pool. Recorded, never aggregated on.
    process_index: usize,
    endpoints: usize,
    connect_concurrency: usize,
    json_out: Option<String>,
}

impl Default for Options {
    fn default() -> Options {
        Options {
            role: Role::Publisher,
            url: DEFAULT_URL.to_string(),
            sessions: 1,
            index_base: 0,
            index_stride: 1,
            total_publishers: 1,
            total_subscribers: 0,
            publishers_per_room: 1,
            subscribers_per_room: 10,
            rooms: 1,
            rate_per_sec: 50.0,
            payload_bytes: 128,
            duration_sec: 30.0,
            process_index: 0,
            endpoints: 1,
            connect_concurrency: 32,
            json_out: None,
        }
    }
}

/* -------------------------------------------------------------------------- */
/* Pure arithmetic — the pieces `tools/load/g8-plan.ts` also computes           */
/* -------------------------------------------------------------------------- */

/// The global session indices this process owns, from base and stride.
///
/// Publishers take a contiguous slice (stride 1). Subscribers are strided by the
/// sink-process count, which is what makes `sinkProcessFor` in `g8-plan.ts` and
/// this function two readings of one assignment rather than two assignments.
fn global_indices(base: usize, stride: usize, count: usize) -> Vec<usize> {
    let stride = stride.max(1);
    (0..count).map(|i| base + i * stride).collect()
}

/// Deterministic phase offset, in nanoseconds. `gate-g8-many-rooms.md` §1.6.
///
/// M publishers sharing a grid with no offset is an aligned impulse of M
/// datagrams every frame. The aligned case is registered as NOT covered; this is
/// what makes it not the case being measured.
fn phase_offset_ns(index: usize, total: usize, period_ns: u64) -> u64 {
    if total <= 1 {
        return 0;
    }
    ((index % total) as u64 * period_ns) / total as u64
}

/// The cumulative deadline of tick `n`, in monotonic nanoseconds.
fn deadline_ns(start_ns: u64, phase_ns: u64, period_ns: u64, n: u64) -> u64 {
    start_ns + phase_ns + period_ns.saturating_mul(n)
}

/// The first tick at or after `now`, and how many were skipped to reach it.
///
/// A deadline in the past is skipped rather than caught up. Catching up would
/// emit the back-to-back burst §1.6 exists to prevent and would corrupt the
/// per-room cadence V-I reads; skipping makes the same lateness visible in
/// `ticksSkipped`, which is what the honesty rule already keys off.
fn advance_to_now(start_ns: u64, phase_ns: u64, period_ns: u64, n: u64, now_ns: u64) -> (u64, u64) {
    if period_ns == 0 {
        return (n, 0);
    }
    let due = deadline_ns(start_ns, phase_ns, period_ns, n);
    if due >= now_ns {
        return (n, 0);
    }
    // One period of lateness is normal jitter and is not a skip: the send still
    // happens for this tick, late, and the lateness lands in `scheduleLag`.
    let behind = now_ns - due;
    let skipped = behind / period_ns;
    (n + skipped, skipped)
}

/* -------------------------------------------------------------------------- */
/* Per-publisher state — never merged into a pool                              */
/* -------------------------------------------------------------------------- */

struct PublisherState {
    publisher_id: usize,
    room_id: usize,
    sent: AtomicU64,
    send_errors: AtomicU64,
    ticks_skipped: AtomicU64,
    send_events: AtomicU64,
    schedule_lag: AtomicHistogram,
    /// Wall time this publisher actually drove, so its effective rate divides by
    /// its own window and not by the process's.
    drive_ns: AtomicU64,
}

impl PublisherState {
    fn new(publisher_id: usize, room_id: usize) -> PublisherState {
        PublisherState {
            publisher_id,
            room_id,
            sent: AtomicU64::new(0),
            send_errors: AtomicU64::new(0),
            ticks_skipped: AtomicU64::new(0),
            send_events: AtomicU64::new(0),
            schedule_lag: AtomicHistogram::new(),
            drive_ns: AtomicU64::new(0),
        }
    }

    fn to_json(&self, process_index: usize, rate_per_sec: f64) -> String {
        let drive_sec = self.drive_ns.load(Ordering::Relaxed) as f64 / 1e9;
        let sent = self.sent.load(Ordering::Relaxed);
        // The *effective* offered rate, quantisation-corrected: what this
        // publisher's own grid actually asked for over its own window. The spec
        // forbids labelling a rung with a nominal rate.
        let effective = if drive_sec > 0.0 {
            (sent + self.ticks_skipped.load(Ordering::Relaxed)) as f64 / drive_sec
        } else {
            rate_per_sec
        };
        format!(
            "{{\"publisherId\":{},\"roomId\":{},\"processIndex\":{},\"sent\":{},\"sendErrors\":{},\"effectiveRatePerSec\":{:.6},\"driveWindowSec\":{:.6},\"ticksSkipped\":{},\"sendEvents\":{},\"scheduleLag\":{}}}",
            self.publisher_id,
            self.room_id,
            process_index,
            sent,
            self.send_errors.load(Ordering::Relaxed),
            effective,
            drive_sec,
            self.ticks_skipped.load(Ordering::Relaxed),
            self.send_events.load(Ordering::Relaxed),
            self.schedule_lag.to_json(),
        )
    }
}

/// Per-room receive state. Keyed by room so a starved room cannot hide in a
/// pooled histogram — the same reason publishers are per publisher.
struct RoomSink {
    room_id: usize,
    received: AtomicU64,
    /// Arrivals that were not decodable G8 media. Counted, never dropped.
    undecodable: AtomicU64,
    one_way: AtomicHistogram,
}

impl RoomSink {
    fn new(room_id: usize) -> RoomSink {
        RoomSink {
            room_id,
            received: AtomicU64::new(0),
            undecodable: AtomicU64::new(0),
            one_way: AtomicHistogram::new(),
        }
    }

    fn to_json(&self) -> String {
        format!(
            "{{\"roomId\":{},\"received\":{},\"undecodable\":{},\"oneWay\":{}}}",
            self.room_id,
            self.received.load(Ordering::Relaxed),
            self.undecodable.load(Ordering::Relaxed),
            self.one_way.to_json(),
        )
    }
}

struct Shared {
    publishers: Vec<Arc<PublisherState>>,
    /// Indexed by room id. Every room this process touches has a slot, so a room
    /// that received nothing reports a zero rather than being absent.
    rooms: Vec<Arc<RoomSink>>,
    sessions_opened: AtomicU64,
    sessions_failed: AtomicU64,
    hello_errors: AtomicU64,
    errors: Mutex<Vec<String>>,
}

impl Shared {
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

fn build_endpoints(count: usize) -> Result<Vec<Arc<ClientEndpoint>>, Box<dyn std::error::Error>> {
    let mut endpoints = Vec::with_capacity(count);
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
                Ok(e) => endpoint = Some(e),
                Err(e) => eprintln!("rooms-client: bind {addr} failed ({e}); using default bind"),
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
    Ok(endpoints)
}

fn self_rss_mb() -> Option<f64> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    for line in status.lines() {
        if let Some(rest) = line.strip_prefix("VmRSS:") {
            let kb: f64 = rest.split_whitespace().next()?.parse().ok()?;
            return Some(kb / 1024.0);
        }
    }
    None
}

fn self_cpu_ms() -> Option<f64> {
    let stat = std::fs::read_to_string("/proc/self/stat").ok()?;
    let close = stat.rfind(')')?;
    let fields: Vec<&str> = stat[close + 1..].split_whitespace().collect();
    let utime: f64 = fields.get(11)?.parse().ok()?;
    let stime: f64 = fields.get(12)?.parse().ok()?;
    let hz = 100.0;
    Some((utime + stime) / hz * 1000.0)
}

fn spawn_rss_guard() {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(RSS_GUARD_INTERVAL).await;
            let Some(rss) = self_rss_mb() else { continue };
            if rss > CLIENT_RSS_LIMIT_MB {
                println!(
                    "rooms-client: abort client-rss-guard rssMb={rss:.1} limitMb={CLIENT_RSS_LIMIT_MB:.0}"
                );
                let _ = std::io::Write::flush(&mut std::io::stdout());
                std::process::exit(EXIT_RSS_GUARD);
            }
        }
    });
}

/* -------------------------------------------------------------------------- */
/* Args                                                                        */
/* -------------------------------------------------------------------------- */

fn parse_or_default<T>(flag: &str, raw: Option<String>, default: T) -> T
where
    T: std::str::FromStr + Copy + std::fmt::Display,
{
    match raw {
        Some(v) => match v.parse::<T>() {
            Ok(parsed) => parsed,
            Err(_) => {
                eprintln!("rooms-client: bad value for {flag} ('{v}'); using {default}");
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
            "--role" => {
                let raw = args.next().unwrap_or_default();
                match Role::parse(&raw) {
                    Some(r) => o.role = r,
                    None => eprintln!("rooms-client: unknown --role '{raw}'; using publisher"),
                }
            }
            "--url" => o.url = args.next().unwrap_or_else(|| DEFAULT_URL.to_string()),
            "--sessions" => o.sessions = parse_or_default("--sessions", args.next(), o.sessions),
            "--index-base" => {
                o.index_base = parse_or_default("--index-base", args.next(), o.index_base)
            }
            "--index-stride" => {
                o.index_stride = parse_or_default("--index-stride", args.next(), o.index_stride)
            }
            "--total-publishers" => {
                o.total_publishers =
                    parse_or_default("--total-publishers", args.next(), o.total_publishers)
            }
            "--total-subscribers" => {
                o.total_subscribers =
                    parse_or_default("--total-subscribers", args.next(), o.total_subscribers)
            }
            "--publishers-per-room" => {
                o.publishers_per_room =
                    parse_or_default("--publishers-per-room", args.next(), o.publishers_per_room)
                        .max(1)
            }
            "--subscribers-per-room" => {
                o.subscribers_per_room = parse_or_default(
                    "--subscribers-per-room",
                    args.next(),
                    o.subscribers_per_room,
                )
            }
            "--rooms" => o.rooms = parse_or_default("--rooms", args.next(), o.rooms).max(1),
            "--rate" => o.rate_per_sec = parse_or_default("--rate", args.next(), o.rate_per_sec),
            "--payload-bytes" => {
                o.payload_bytes = parse_or_default("--payload-bytes", args.next(), o.payload_bytes)
                    .max(STAMP_BYTES_V3)
            }
            "--duration-sec" => {
                o.duration_sec = parse_or_default("--duration-sec", args.next(), o.duration_sec)
            }
            "--process-index" => {
                o.process_index = parse_or_default("--process-index", args.next(), o.process_index)
            }
            "--endpoints" => {
                o.endpoints =
                    parse_or_default("--endpoints", args.next(), o.endpoints).clamp(1, 250)
            }
            "--connect-concurrency" => {
                o.connect_concurrency =
                    parse_or_default("--connect-concurrency", args.next(), o.connect_concurrency)
                        .max(1)
            }
            "--json-out" => o.json_out = args.next(),
            other => eprintln!("rooms-client: ignoring unknown flag '{other}'"),
        }
    }
    o
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

async fn run(options: Options) -> Result<(), Box<dyn std::error::Error>> {
    spawn_rss_guard();

    let indices = global_indices(options.index_base, options.index_stride, options.sessions);
    let period_ns = if options.rate_per_sec > 0.0 {
        (1e9 / options.rate_per_sec).round() as u64
    } else {
        0
    };

    // One slot per room in the run, so a room this process happens not to serve
    // still reports a zero instead of being silently absent from the artifact.
    let rooms: Vec<Arc<RoomSink>> = (0..options.rooms)
        .map(|r| Arc::new(RoomSink::new(r)))
        .collect();

    let publishers: Vec<Arc<PublisherState>> = if options.role.publishes() {
        indices
            .iter()
            .map(|&global| {
                Arc::new(PublisherState::new(
                    global,
                    global / options.publishers_per_room,
                ))
            })
            .collect()
    } else {
        Vec::new()
    };

    let shared = Arc::new(Shared {
        publishers: publishers.clone(),
        rooms: rooms.clone(),
        sessions_opened: AtomicU64::new(0),
        sessions_failed: AtomicU64::new(0),
        hello_errors: AtomicU64::new(0),
        errors: Mutex::new(Vec::new()),
    });

    let endpoints = build_endpoints(options.endpoints)?;
    let options = Arc::new(options);

    // Connect every session and send its hello before any drive starts, so the
    // conductor's room map is complete when the window opens. A handshake inside
    // the window would be load the plan did not account for.
    let connect_gate = Arc::new(tokio::sync::Semaphore::new(options.connect_concurrency));
    let mut joins = Vec::with_capacity(indices.len());
    for (slot, &global) in indices.iter().enumerate() {
        let endpoint = Arc::clone(&endpoints[slot % endpoints.len()]);
        let shared = Arc::clone(&shared);
        let options = Arc::clone(&options);
        let gate = Arc::clone(&connect_gate);
        let publisher = publishers.get(slot).cloned();
        let room_id = room_of(&options, global);
        let sink = rooms.get(room_id).cloned();
        joins.push(tokio::spawn(async move {
            let _permit = gate.acquire().await;
            session_task(
                endpoint, shared, options, global, room_id, publisher, sink, period_ns,
            )
            .await;
        }));
    }

    let deadline =
        Instant::now() + Duration::from_secs_f64(options.duration_sec) + JOIN_TIMEOUT + DRAIN_GRACE;
    for join in joins {
        let left = deadline.saturating_duration_since(Instant::now());
        if tokio::time::timeout(left, join).await.is_err() {
            shared.record_error("session task did not finish inside the arm".to_string());
            break;
        }
    }

    emit_report(&options, &shared);
    // Explicit exit: a lingering endpoint task is how the egress driver used to
    // hang an arm forever (probe/egress-01, commit 1163a60).
    std::process::exit(0);
}

/// Which room a global session index belongs to.
///
/// Publishers pack `publishersPerRoom` to a room; subscribers pack
/// `subscribersPerRoom`. The strided assignment is in the *indices*, not here,
/// so consecutive members of one room land in different sink processes while
/// still computing the same room id.
fn room_of(options: &Options, global_index: usize) -> usize {
    let per_room = if options.role.publishes() && !options.role.receives() {
        options.publishers_per_room
    } else if options.role.receives() && !options.role.publishes() {
        options.subscribers_per_room.max(1)
    } else {
        options.publishers_per_room
    };
    (global_index / per_room.max(1)).min(options.rooms.saturating_sub(1))
}

#[allow(clippy::too_many_arguments)]
async fn session_task(
    endpoint: Arc<ClientEndpoint>,
    shared: Arc<Shared>,
    options: Arc<Options>,
    global_index: usize,
    room_id: usize,
    publisher: Option<Arc<PublisherState>>,
    sink: Option<Arc<RoomSink>>,
    period_ns: u64,
) {
    let connection = match tokio::time::timeout(JOIN_TIMEOUT, endpoint.connect(&options.url)).await
    {
        Ok(Ok(c)) => c,
        Ok(Err(e)) => {
            shared.sessions_failed.fetch_add(1, Ordering::Relaxed);
            shared.record_error(format!("connect: {e}"));
            return;
        }
        Err(_) => {
            shared.sessions_failed.fetch_add(1, Ordering::Relaxed);
            shared.record_error("connect: timed out".to_string());
            return;
        }
    };
    shared.sessions_opened.fetch_add(1, Ordering::Relaxed);

    // The hello. The server surface exposes no request path, so a session says
    // its room id once, in `sequence`. Excluded from every rate.
    let mut hello = vec![0u8; STAMP_BYTES_V3];
    let now = monotonic_ns();
    write_stamp_v3(&mut hello, now, now, room_id as u64, CLASS_ROOM_JOIN);
    if let Err(e) = connection.send_datagram(&hello[..]) {
        shared.hello_errors.fetch_add(1, Ordering::Relaxed);
        shared.record_error(format!("hello: {e}"));
    }

    let connection = Arc::new(connection);
    let drive = Duration::from_secs_f64(options.duration_sec);

    let receiver = if options.role.receives() {
        let connection = Arc::clone(&connection);
        let sink = sink.clone();
        Some(tokio::spawn(async move {
            receive_loop(connection, sink, drive + DRAIN_GRACE).await;
        }))
    } else {
        None
    };

    if let Some(state) = publisher {
        publish_loop(
            Arc::clone(&connection),
            state,
            &options,
            global_index,
            period_ns,
            drive,
        )
        .await;
    } else {
        tokio::time::sleep(drive).await;
    }

    if let Some(receiver) = receiver {
        let _ = receiver.await;
    }
    connection.close(0u32.into(), b"done");
}

/// The cumulative-deadline grid (§6 V-G).
async fn publish_loop(
    connection: Arc<wtransport::Connection>,
    state: Arc<PublisherState>,
    options: &Options,
    global_index: usize,
    period_ns: u64,
    drive: Duration,
) {
    if period_ns == 0 {
        tokio::time::sleep(drive).await;
        return;
    }
    let phase_ns = phase_offset_ns(global_index, options.total_publishers.max(1), period_ns);
    let start_instant = Instant::now();
    let start_ns = monotonic_ns();
    let end_ns = start_ns + drive.as_nanos() as u64;

    let mut payload = vec![0u8; options.payload_bytes];
    let mut n: u64 = 0;
    let mut sequence: u64 = 0;

    loop {
        let intended_ns = deadline_ns(start_ns, phase_ns, period_ns, n);
        if intended_ns >= end_ns {
            break;
        }
        // Sleep against the *same* cumulative deadline the stamp will carry, so
        // `intended` is the grid and not a re-read of the clock.
        let target = start_instant + Duration::from_nanos(intended_ns - start_ns);
        tokio::time::sleep_until(tokio::time::Instant::from_std(target)).await;

        let actual_ns = monotonic_ns();
        let (advanced, skipped) = advance_to_now(start_ns, phase_ns, period_ns, n, actual_ns);
        if skipped > 0 {
            state.ticks_skipped.fetch_add(skipped, Ordering::Relaxed);
            state.send_events.fetch_add(skipped, Ordering::Relaxed);
            n = advanced;
            continue;
        }

        write_stamp_v3(
            &mut payload,
            intended_ns,
            actual_ns,
            sequence,
            CLASS_ROOM_MEDIA,
        );
        match connection.send_datagram(&payload[..]) {
            Ok(()) => {
                state.sent.fetch_add(1, Ordering::Relaxed);
            }
            Err(e) => {
                state.send_errors.fetch_add(1, Ordering::Relaxed);
                if state.send_errors.load(Ordering::Relaxed) == 1 {
                    eprintln!("rooms-client: send: {e}");
                }
            }
        }
        state.send_events.fetch_add(1, Ordering::Relaxed);
        state
            .schedule_lag
            .record_signed(actual_ns as i64 - intended_ns as i64);
        sequence += 1;
        n += 1;
    }

    state
        .drive_ns
        .store(monotonic_ns().saturating_sub(start_ns), Ordering::Relaxed);
}

async fn receive_loop(
    connection: Arc<wtransport::Connection>,
    sink: Option<Arc<RoomSink>>,
    window: Duration,
) {
    let stop = Instant::now() + window;
    loop {
        let left = stop.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return;
        }
        let received = match tokio::time::timeout(left, connection.receive_datagram()).await {
            Ok(Ok(d)) => d,
            Ok(Err(_)) => return,
            Err(_) => return,
        };
        let arrived_ns = monotonic_ns();
        let Some(sink) = sink.as_ref() else { continue };
        match read_stamp(&received) {
            Some(stamp) if stamp.class == CLASS_ROOM_MEDIA => {
                sink.received.fetch_add(1, Ordering::Relaxed);
                // `actual` is the *publisher's* clock. On one host that is one
                // system-wide CLOCK_MONOTONIC, which is the whole reason §2
                // registers the on-box placement.
                sink.one_way
                    .record_signed(arrived_ns as i64 - stamp.actual_ns as i64);
            }
            _ => {
                sink.undecodable.fetch_add(1, Ordering::Relaxed);
            }
        }
    }
}

fn escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

fn emit_report(options: &Options, shared: &Shared) {
    let publishers = shared
        .publishers
        .iter()
        .map(|p| p.to_json(options.process_index, options.rate_per_sec))
        .collect::<Vec<_>>()
        .join(",");
    let rooms = shared
        .rooms
        .iter()
        .filter(|r| {
            r.received.load(Ordering::Relaxed) > 0 || r.undecodable.load(Ordering::Relaxed) > 0
        })
        .map(|r| r.to_json())
        .collect::<Vec<_>>()
        .join(",");
    let errors = shared
        .errors
        .lock()
        .map(|e| {
            e.iter()
                .map(|s| format!("\"{}\"", escape(s)))
                .collect::<Vec<_>>()
                .join(",")
        })
        .unwrap_or_default();
    let cpu = self_cpu_ms().unwrap_or(0.0);
    let rss = self_rss_mb().unwrap_or(0.0);
    let report = format!(
        "{{\"role\":\"{}\",\"processIndex\":{},\"sessionsOpened\":{},\"sessionsFailed\":{},\"helloErrors\":{},\"durationSec\":{:.6},\"cpuMs\":{:.3},\"rssMb\":{:.2},\"publishers\":[{}],\"rooms\":[{}],\"errors\":[{}]}}",
        options.role.label(),
        options.process_index,
        shared.sessions_opened.load(Ordering::Relaxed),
        shared.sessions_failed.load(Ordering::Relaxed),
        shared.hello_errors.load(Ordering::Relaxed),
        options.duration_sec,
        cpu,
        rss,
        publishers,
        rooms,
        errors,
    );
    match options.json_out.as_ref() {
        Some(path) => {
            if let Err(e) = std::fs::write(path, &report) {
                eprintln!("rooms-client: could not write {path}: {e}");
                println!("{report}");
            }
        }
        None => println!("{report}"),
    }
}

/* -------------------------------------------------------------------------- */
/* Tests — the arithmetic, off any runner                                      */
/* -------------------------------------------------------------------------- */

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn publishers_take_a_contiguous_slice_and_subscribers_a_strided_one() {
        assert_eq!(global_indices(25, 1, 4), vec![25, 26, 27, 28]);
        // Sink process 2 of 4 owns every fourth subscriber, so the ten members
        // of one room land in four different processes.
        assert_eq!(global_indices(2, 4, 3), vec![2, 6, 10]);
    }

    #[test]
    fn phase_offsets_spread_across_one_period_and_never_alias() {
        let period = 20_000_000u64;
        assert_eq!(phase_offset_ns(0, 4, period), 0);
        assert_eq!(phase_offset_ns(1, 4, period), 5_000_000);
        assert_eq!(phase_offset_ns(3, 4, period), 15_000_000);
        let mut seen = std::collections::HashSet::new();
        for i in 0..100 {
            let off = phase_offset_ns(i, 100, period);
            assert!(off < period);
            assert!(seen.insert(off), "offset {off} repeated");
        }
    }

    #[test]
    fn a_single_publisher_has_no_offset_to_spread() {
        assert_eq!(phase_offset_ns(0, 1, 20_000_000), 0);
    }

    #[test]
    fn deadlines_are_cumulative_and_cannot_drift() {
        let period = 20_000_000u64;
        let start = 1_000_000_000u64;
        // The thousandth deadline is exactly a thousand periods out, whatever
        // happened in between — the property a previous-plus-period pacer loses.
        assert_eq!(deadline_ns(start, 0, period, 1_000), start + 1_000 * period);
    }

    #[test]
    fn a_tick_that_is_merely_late_is_still_sent() {
        let period = 20_000_000u64;
        let start = 0u64;
        // 15 ms late: inside one period, so no skip and the lateness shows up in
        // the schedule-lag histogram instead.
        let (n, skipped) = advance_to_now(start, 0, period, 3, 3 * period + 15_000_000);
        assert_eq!(n, 3);
        assert_eq!(skipped, 0);
    }

    #[test]
    fn missed_ticks_are_skipped_and_counted_never_caught_up() {
        let period = 20_000_000u64;
        let start = 0u64;
        // 100 ms of stall at tick 3: five periods gone. A catch-up pacer would
        // emit five datagrams back to back here, which is the burst §1.6 exists
        // to prevent and which would corrupt the cadence falsifier.
        let (n, skipped) = advance_to_now(start, 0, period, 3, 3 * period + 100_000_000);
        assert_eq!(skipped, 5);
        assert_eq!(n, 8);
        assert!(deadline_ns(start, 0, period, n) >= 3 * period + 100_000_000);
    }

    #[test]
    fn a_deadline_still_in_the_future_advances_nothing() {
        let period = 20_000_000u64;
        let (n, skipped) = advance_to_now(0, 0, period, 7, 7 * period - 1);
        assert_eq!((n, skipped), (7, 0));
    }

    #[test]
    fn a_room_id_comes_from_the_global_index_and_the_arm_shape() {
        let mut o = Options {
            role: Role::Publisher,
            publishers_per_room: 1,
            rooms: 100,
            ..Options::default()
        };
        assert_eq!(room_of(&o, 0), 0);
        assert_eq!(room_of(&o, 42), 42);

        // Mutual: ten publishers to a room.
        o.role = Role::Mutual;
        o.publishers_per_room = 10;
        o.rooms = 10;
        assert_eq!(room_of(&o, 0), 0);
        assert_eq!(room_of(&o, 9), 0);
        assert_eq!(room_of(&o, 10), 1);

        // Subscribers: K to a room, and the stride lives in the index.
        o.role = Role::Subscriber;
        o.subscribers_per_room = 10;
        o.rooms = 100;
        assert_eq!(room_of(&o, 0), 0);
        assert_eq!(room_of(&o, 9), 0);
        assert_eq!(room_of(&o, 10), 1);
        // Two consecutive members of room 3 sitting in different sink processes.
        assert_eq!(room_of(&o, 30), 3);
        assert_eq!(room_of(&o, 31), 3);
    }

    #[test]
    fn a_room_id_can_never_run_off_the_end_of_the_room_table() {
        let o = Options {
            role: Role::Publisher,
            publishers_per_room: 1,
            rooms: 10,
            ..Options::default()
        };
        assert_eq!(room_of(&o, 999), 9);
    }
}
