//! Loss-attribution load generator.
//!
//! A counting-tap variant of `scale_client.rs` (probe/session-scale-01) built for
//! T02: run 32174398131 rung 4 lost 30.6% of datagrams at 10,000 sessions and
//! 2,000 datagrams/s while *every* server drop counter read zero. Delivery ratio
//! alone cannot say where those datagrams went, so this client adds the two taps
//! the session-scale client never had:
//!
//!   A. application enqueue — `send_datagram` returned `Ok` (what the old client
//!      called `sent`; it is a queue-accept, not a wire event).
//!   B. QUIC wire tx — `frame_tx.datagram` summed over every live connection,
//!      windowed to the steady phase. quinn's `Datagrams::send(_, drop = true)`
//!      silently evicts previously queued datagrams when the per-connection
//!      outgoing buffer overflows (quinn-proto `connection/datagrams.rs`), and
//!      that eviction increments no counter anywhere. A − B is exactly that
//!      eviction, and it is the live hypothesis carried over from the
//!      ingest-ceiling work.
//!
//! It also records `path.lost_packets`/`congestion_events`/`udp_tx` per window
//! so declared packet loss is separable from queue eviction, and counts how many
//! connections transmitted *nothing* during steady — which distinguishes loss
//! spread evenly across sessions from a subset of sessions going silent.
//!
//! Payloads keep the `scale:<seq>:` header of the session-scale client so the
//! server harness can rebuild a per-session sequence ledger and tell a prefix
//! loss (late start) from a suffix loss (late collapse) from scattered gaps.

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
/// snapshotted at that boundary. Same value as the session-scale client so the
/// two runs' windows are comparable.
const PHASE_SETTLE: Duration = Duration::from_millis(250);
const CLIENT_RSS_LIMIT_MB: f64 = 3584.0;
const RSS_GUARD_INTERVAL: Duration = Duration::from_secs(2);
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
    /// Ticks the session loop skipped because `MissedTickBehavior::Skip` ate
    /// them: the generator's own admission of schedule lag, so a low offered
    /// rate is never mistaken for transport loss.
    ticks_late: AtomicU64,
}

#[derive(Clone, Copy, Default)]
struct CounterSnapshot {
    sent: u64,
    err: u64,
    received: u64,
    lost: u64,
    late: u64,
}

impl Counters {
    fn snapshot(&self) -> CounterSnapshot {
        CounterSnapshot {
            sent: self.datagrams_sent.load(Ordering::Relaxed),
            err: self.datagrams_err.load(Ordering::Relaxed),
            received: self.datagrams_received.load(Ordering::Relaxed),
            lost: self.sessions_lost.load(Ordering::Relaxed),
            late: self.ticks_late.load(Ordering::Relaxed),
        }
    }
}

/// The per-window QUIC tap. Every field is a sum over live connections at the
/// instant of the snapshot; the harness reports differences between snapshots.
#[derive(Clone, Copy, Default)]
struct QuicTap {
    connections: u64,
    frame_tx_datagram: u64,
    frame_rx_datagram: u64,
    frame_tx_acks: u64,
    frame_tx_ping: u64,
    udp_tx_datagrams: u64,
    udp_tx_ios: u64,
    udp_tx_bytes: u64,
    udp_rx_datagrams: u64,
    sent_packets: u64,
    lost_packets: u64,
    congestion_events: u64,
    black_holes: u64,
}

impl QuicTap {
    fn add(&mut self, s: &quinn::ConnectionStats) {
        self.connections += 1;
        self.frame_tx_datagram += s.frame_tx.datagram;
        self.frame_rx_datagram += s.frame_rx.datagram;
        self.frame_tx_acks += s.frame_tx.acks;
        self.frame_tx_ping += s.frame_tx.ping;
        self.udp_tx_datagrams += s.udp_tx.datagrams;
        self.udp_tx_ios += s.udp_tx.ios;
        self.udp_tx_bytes += s.udp_tx.bytes;
        self.udp_rx_datagrams += s.udp_rx.datagrams;
        self.sent_packets += s.path.sent_packets;
        self.lost_packets += s.path.lost_packets;
        self.congestion_events += s.path.congestion_events;
        self.black_holes += s.path.black_holes_detected;
    }

    fn delta(&self, base: &QuicTap) -> QuicTap {
        QuicTap {
            // Connection count is a level, not a flow: report the later one.
            connections: self.connections,
            frame_tx_datagram: self
                .frame_tx_datagram
                .saturating_sub(base.frame_tx_datagram),
            frame_rx_datagram: self
                .frame_rx_datagram
                .saturating_sub(base.frame_rx_datagram),
            frame_tx_acks: self.frame_tx_acks.saturating_sub(base.frame_tx_acks),
            frame_tx_ping: self.frame_tx_ping.saturating_sub(base.frame_tx_ping),
            udp_tx_datagrams: self.udp_tx_datagrams.saturating_sub(base.udp_tx_datagrams),
            udp_tx_ios: self.udp_tx_ios.saturating_sub(base.udp_tx_ios),
            udp_tx_bytes: self.udp_tx_bytes.saturating_sub(base.udp_tx_bytes),
            udp_rx_datagrams: self.udp_rx_datagrams.saturating_sub(base.udp_rx_datagrams),
            sent_packets: self.sent_packets.saturating_sub(base.sent_packets),
            lost_packets: self.lost_packets.saturating_sub(base.lost_packets),
            congestion_events: self
                .congestion_events
                .saturating_sub(base.congestion_events),
            black_holes: self.black_holes.saturating_sub(base.black_holes),
        }
    }

    fn to_json(self) -> String {
        format!(
            concat!(
                "{{\"connections\":{},\"frameTxDatagram\":{},\"frameRxDatagram\":{},",
                "\"frameTxAcks\":{},\"frameTxPing\":{},\"udpTxDatagrams\":{},\"udpTxIos\":{},",
                "\"udpTxBytes\":{},\"udpRxDatagrams\":{},\"sentPackets\":{},\"lostPackets\":{},",
                "\"congestionEvents\":{},\"blackHoles\":{}}}"
            ),
            self.connections,
            self.frame_tx_datagram,
            self.frame_rx_datagram,
            self.frame_tx_acks,
            self.frame_tx_ping,
            self.udp_tx_datagrams,
            self.udp_tx_ios,
            self.udp_tx_bytes,
            self.udp_rx_datagrams,
            self.sent_packets,
            self.lost_packets,
            self.congestion_events,
            self.black_holes,
        )
    }
}

/// Live QUIC connections, registered as each session completes its handshake.
/// `quinn::Connection` is an `Arc` handle, so holding one per session costs a
/// pointer and keeps no extra transport state alive.
type ConnRegistry = Arc<Mutex<Vec<quinn::Connection>>>;

/// Sum the QUIC tap over every registered connection, and return the per
/// connection DATAGRAM-frame tx counts alongside it so the caller can ask how
/// many connections were silent over a window.
fn sample_quic(registry: &ConnRegistry) -> (QuicTap, Vec<u64>) {
    let mut tap = QuicTap::default();
    let conns = match registry.lock() {
        Ok(c) => c,
        Err(poisoned) => poisoned.into_inner(),
    };
    let mut per_conn = Vec::with_capacity(conns.len());
    for conn in conns.iter() {
        let stats = conn.stats();
        tap.add(&stats);
        per_conn.push(stats.frame_tx.datagram);
    }
    (tap, per_conn)
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
                eprintln!("loss-client: invalid value for {flag} ('{v}'): {e}; using default");
                default
            }
        },
        None => default,
    }
}

/// Process RSS in MiB. Linux only; the local macOS repro reports null.
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
    let utime: f64 = fields.get(11)?.parse().ok()?;
    let stime: f64 = fields.get(12)?.parse().ok()?;
    let hz = 100.0;
    Some((utime + stime) * 1000.0 / hz)
}

fn spawn_rss_guard() {
    match self_rss_mb() {
        Some(rss) => println!(
            "loss-client: rss guard armed limitMb={CLIENT_RSS_LIMIT_MB:.0} sampleMs={} rssMb={rss:.1}",
            RSS_GUARD_INTERVAL.as_millis()
        ),
        None => println!("loss-client: rss guard inactive (no /proc/self/status)"),
    }
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(RSS_GUARD_INTERVAL).await;
            let Some(rss) = self_rss_mb() else { continue };
            if rss > CLIENT_RSS_LIMIT_MB {
                println!(
                    "loss-client: abort client-rss-guard rssMb={rss:.1} limitMb={CLIENT_RSS_LIMIT_MB:.0}"
                );
                let _ = std::io::Write::flush(&mut std::io::stdout());
                std::process::exit(EXIT_RSS_GUARD);
            }
        }
    });
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
    distinct_source_ips: usize,
}

/// One client endpoint per distinct loopback source IP (`127.0.<k>.1`), so the
/// server sees several distinct `IpAddr` rate-limit keys. With `endpoints == 1`
/// it binds the default address instead, which is what a local macOS repro can
/// do without interface aliases.
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
                Err(e) => eprintln!("loss-client: bind {addr} failed ({e}); using default bind"),
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
    };

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--url" => {
                if let Some(v) = args.next() {
                    options.url = v;
                }
            }
            "--sessions" => {
                options.sessions =
                    parse_or_default("--sessions", args.next(), DEFAULT_SESSIONS).max(1);
            }
            "--endpoints" => {
                options.endpoints =
                    parse_or_default("--endpoints", args.next(), DEFAULT_ENDPOINTS).max(1);
            }
            "--connect-concurrency" => {
                options.connect_concurrency = parse_or_default(
                    "--connect-concurrency",
                    args.next(),
                    DEFAULT_CONNECT_CONCURRENCY,
                )
                .max(1);
            }
            "--steady-secs" => {
                options.steady = Duration::from_secs(parse_or_default(
                    "--steady-secs",
                    args.next(),
                    DEFAULT_STEADY_SECS,
                ));
            }
            "--idle-secs" => {
                options.idle = Duration::from_secs(parse_or_default(
                    "--idle-secs",
                    args.next(),
                    DEFAULT_IDLE_SECS,
                ));
            }
            "--datagram-interval-ms" => {
                options.datagram_interval = Duration::from_millis(
                    parse_or_default(
                        "--datagram-interval-ms",
                        args.next(),
                        DEFAULT_DATAGRAM_INTERVAL_MS,
                    )
                    .max(1),
                );
            }
            "--payload-bytes" => {
                options.payload_bytes =
                    parse_or_default("--payload-bytes", args.next(), DEFAULT_PAYLOAD_BYTES).max(16);
            }
            "--connect-timeout-secs" => {
                options.connect_timeout = Duration::from_secs(parse_or_default(
                    "--connect-timeout-secs",
                    args.next(),
                    DEFAULT_CONNECT_TIMEOUT_SECS,
                ));
            }
            "--json-out" => options.json_out = args.next(),
            _ => {}
        }
    }

    println!(
        "loss-client: url={} sessions={} endpoints={} connect_concurrency={} steady={}s idle={}s interval={}ms payload={}B",
        options.url,
        options.sessions,
        options.endpoints,
        options.connect_concurrency,
        options.steady.as_secs(),
        options.idle.as_secs(),
        options.datagram_interval.as_millis(),
        options.payload_bytes,
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
        let url = options.url.clone();
        let mut phase = phase_rx.clone();
        let interval = options.datagram_interval;
        let payload_bytes = options.payload_bytes;
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
            hold_session(conn, &mut phase, interval, payload_bytes, counters.as_ref()).await;
        }));
    }

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
    let sessions_ok = counters.sessions_ok.load(Ordering::Relaxed);
    let sessions_err = counters.sessions_err.load(Ordering::Relaxed);
    println!(
        "loss-client: connect phase done ok={} err={} wall={:.1}s timed_out={}",
        sessions_ok,
        sessions_err,
        connect_wall.as_secs_f64(),
        connect_timed_out
    );

    let after_connect = counters.snapshot();
    let (quic_at_steady_start, tx_at_steady_start) = sample_quic(&registry);
    let _ = phase_tx.send(PHASE_STEADY);
    // Phase markers are line-buffered onto stdout so the harness can snapshot
    // server-side counters at the exact same boundaries this process uses.
    println!("loss-client: phase steady");
    tokio::time::sleep(options.steady).await;

    // Order matters: switch the sessions to idle and let every one of them
    // observe it BEFORE snapshotting sends, so a session that picked its ticker
    // over the phase change cannot push delivery above 1.0.
    let _ = phase_tx.send(PHASE_IDLE);
    tokio::time::sleep(PHASE_SETTLE).await;
    let after_steady = counters.snapshot();
    let (quic_at_steady_end, tx_at_steady_end) = sample_quic(&registry);
    let rss_steady = self_rss_mb();
    let cpu_after_steady = self_cpu_ms();
    println!("loss-client: phase idle");
    tokio::time::sleep(options.idle.saturating_sub(PHASE_SETTLE)).await;
    let after_idle = counters.snapshot();
    let rss_idle = self_rss_mb();
    let cpu_after_idle = self_cpu_ms();
    let fds = open_fd_count();

    let _ = phase_tx.send(PHASE_STOP);
    println!("loss-client: phase stop");
    let join_deadline = Instant::now() + JOIN_TIMEOUT;
    while Instant::now() < join_deadline && handles.iter().any(|h| !h.is_finished()) {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    for h in &handles {
        if !h.is_finished() {
            h.abort();
        }
    }

    let steady_quic = quic_at_steady_end.delta(&quic_at_steady_start);
    // Per-connection DATAGRAM-frame tx over the steady window. The two vectors
    // are indexed by registration order and the registry only grows during
    // connect, so a shorter baseline can only mean a connection registered late;
    // treat its baseline as zero rather than dropping the sample.
    let mut silent_conns = 0u64;
    let mut min_tx = u64::MAX;
    let mut max_tx = 0u64;
    for (index, end) in tx_at_steady_end.iter().enumerate() {
        let base = tx_at_steady_start.get(index).copied().unwrap_or(0);
        let delta = end.saturating_sub(base);
        if delta == 0 {
            silent_conns += 1;
        }
        min_tx = min_tx.min(delta);
        max_tx = max_tx.max(delta);
    }
    if tx_at_steady_end.is_empty() {
        min_tx = 0;
    }

    let mut sorted = latencies.lock().map(|l| l.clone()).unwrap_or_default();
    sorted.sort_unstable();
    let expected_steady_sends = (sessions_ok as f64) * options.steady.as_secs_f64()
        / options.datagram_interval.as_secs_f64();
    let steady_sent = after_steady.sent.saturating_sub(after_connect.sent);
    let recorded_errors = errors.lock().map(|e| e.clone()).unwrap_or_default();

    let cpu_steady_ms = match (cpu0, cpu_after_steady) {
        (Some(a), Some(b)) => Some(b - a),
        _ => None,
    };
    let cpu_idle_ms = match (cpu_after_steady, cpu_after_idle) {
        (Some(a), Some(b)) => Some(b - a),
        _ => None,
    };

    let json = format!(
        concat!(
            "{{",
            "\"schema\":\"loss-client/1\",",
            "\"sessionsRequested\":{},",
            "\"sessionsOk\":{},",
            "\"sessionsErr\":{},",
            "\"sessionsLost\":{},",
            "\"connectWallSec\":{:.3},",
            "\"connectTimedOut\":{},",
            "\"acceptsPerSec\":{},",
            "\"acceptMs\":{{\"p50\":{},\"p90\":{},\"p99\":{},\"max\":{}}},",
            "\"steady\":{{\"sent\":{},\"err\":{},\"received\":{},\"ticksLate\":{},\"expectedSends\":{}}},",
            "\"idle\":{{\"sent\":{},\"err\":{},\"received\":{}}},",
            "\"steadyQuic\":{},",
            "\"steadyPerConn\":{{\"sampled\":{},\"silent\":{},\"minDatagramFrames\":{},\"maxDatagramFrames\":{}}},",
            "\"client\":{{\"rssMbSteady\":{},\"rssMbIdle\":{},\"cpuMsSteady\":{},\"cpuMsIdle\":{},\"fdCount\":{},\"endpoints\":{},\"distinctSourceIps\":{}}},",
            "\"connectErrorsSample\":[{}]",
            "}}"
        ),
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
        after_steady.late.saturating_sub(after_connect.late),
        json_num(Some(expected_steady_sends)),
        after_idle.sent.saturating_sub(after_steady.sent),
        after_idle.err.saturating_sub(after_steady.err),
        after_idle.received.saturating_sub(after_steady.received),
        steady_quic.to_json(),
        tx_at_steady_end.len(),
        silent_conns,
        min_tx,
        max_tx,
        json_num(rss_steady),
        json_num(rss_idle),
        json_num(cpu_steady_ms),
        json_num(cpu_idle_ms),
        json_u64(fds),
        options.endpoints,
        distinct_source_ips,
        recorded_errors
            .iter()
            .map(|e| format!("\"{}\"", escape(e)))
            .collect::<Vec<_>>()
            .join(",")
    );

    if let Some(path) = &options.json_out {
        std::fs::write(path, format!("{json}\n"))?;
    }
    println!("loss-client: json {json}");
    Ok(())
}

async fn hold_session(
    conn: wtransport::Connection,
    phase: &mut watch::Receiver<u8>,
    interval: Duration,
    payload_bytes: usize,
    counters: &Counters,
) {
    while *phase.borrow() == PHASE_CONNECT {
        if phase.changed().await.is_err() {
            return;
        }
    }

    let mut payload = vec![b'x'; payload_bytes];
    let mut sequence: u64 = 0;
    // Start one interval in, not immediately: tokio's first tick fires at once,
    // which would put one extra send in every session and inflate the offered
    // rate above 1.0 — the very ratio that detects a saturated generator.
    let mut ticker = tokio::time::interval_at(tokio::time::Instant::now() + interval, interval);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut last_tick = Instant::now();

    loop {
        let current = *phase.borrow();
        if current == PHASE_STOP {
            break;
        }
        if current == PHASE_IDLE {
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
                if changed.is_err() { break; }
            }
            _ = ticker.tick() => {
                // `Skip` silently swallows missed ticks, which is exactly how a
                // lagging generator disguises itself as transport loss. Count
                // the whole intervals that went by so the harness can subtract
                // generator lag from the loss it is attributing.
                let elapsed = last_tick.elapsed();
                last_tick = Instant::now();
                let skipped = (elapsed.as_secs_f64() / interval.as_secs_f64()).round() as i64 - 1;
                if skipped > 0 {
                    counters.ticks_late.fetch_add(skipped as u64, Ordering::Relaxed);
                }
                sequence = sequence.wrapping_add(1);
                let header = format!("scale:{sequence}:");
                let n = header.len().min(payload.len());
                payload[..n].copy_from_slice(&header.as_bytes()[..n]);
                match conn.send_datagram(&payload) {
                    Ok(()) => { counters.datagrams_sent.fetch_add(1, Ordering::Relaxed); }
                    Err(_) => { counters.datagrams_err.fetch_add(1, Ordering::Relaxed); }
                }
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
    }
}
