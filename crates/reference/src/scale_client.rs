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

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::{watch, Semaphore};
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
}

#[derive(Clone, Copy, Default)]
struct CounterSnapshot {
    sent: u64,
    err: u64,
    received: u64,
    lost: u64,
}

impl Counters {
    fn snapshot(&self) -> CounterSnapshot {
        CounterSnapshot {
            sent: self.datagrams_sent.load(Ordering::Relaxed),
            err: self.datagrams_err.load(Ordering::Relaxed),
            received: self.datagrams_received.load(Ordering::Relaxed),
            lost: self.sessions_lost.load(Ordering::Relaxed),
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
                    parse_or_default("--payload-bytes", args.next(), DEFAULT_PAYLOAD_BYTES).max(8)
            }
            "--connect-timeout-secs" => {
                options.connect_timeout = Duration::from_secs(parse_or_default(
                    "--connect-timeout-secs",
                    args.next(),
                    DEFAULT_CONNECT_TIMEOUT_SECS,
                ))
            }
            "--json-out" => options.json_out = args.next(),
            _ => {}
        }
    }

    println!(
        "scale-client: url={} sessions={} endpoints={} connect_concurrency={} steady={}s idle={}s interval={}ms payload={}B",
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
    let EndpointPool {
        endpoints,
        distinct_source_ips,
    } = build_endpoints(options.endpoints)?;
    let counters = Arc::new(Counters::default());
    let permits = Arc::new(Semaphore::new(options.connect_concurrency));
    let latencies: Arc<Mutex<Vec<u64>>> =
        Arc::new(Mutex::new(Vec::with_capacity(options.sessions)));
    let errors: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
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
            counters.connect_done.fetch_add(1, Ordering::Relaxed);
            hold_session(conn, &mut phase, interval, payload_bytes, counters.as_ref()).await;
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
    let _ = phase_tx.send(PHASE_STEADY);
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
    tokio::time::sleep(PHASE_SETTLE).await;
    let after_steady = counters.snapshot();
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
            "\"schema\":\"scale-client/1\",",
            "\"sessionsRequested\":{},",
            "\"sessionsOk\":{},",
            "\"sessionsErr\":{},",
            "\"sessionsLost\":{},",
            "\"connectWallSec\":{:.3},",
            "\"connectTimedOut\":{},",
            "\"acceptsPerSec\":{},",
            "\"acceptMs\":{{\"p50\":{},\"p90\":{},\"p99\":{},\"max\":{}}},",
            "\"steady\":{{\"sent\":{},\"err\":{},\"received\":{},\"expectedSends\":{}}},",
            "\"idle\":{{\"sent\":{},\"err\":{},\"received\":{}}},",
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
        json_num(Some(expected_steady_sends)),
        after_idle.sent.saturating_sub(after_steady.sent),
        after_idle.err.saturating_sub(after_steady.err),
        after_idle.received.saturating_sub(after_steady.received),
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
    println!("scale-client: json {json}");
    Ok(())
}

async fn hold_session(
    conn: wtransport::Connection,
    phase: &mut watch::Receiver<u8>,
    interval: Duration,
    payload_bytes: usize,
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
    // Start one interval in, not immediately: tokio's first tick fires at once,
    // which would put one extra send in every session and inflate the harness's
    // offeredRatio above 1.0 — exactly the ratio that detects a saturated
    // generator, so it must not run rich.
    let mut ticker = tokio::time::interval_at(tokio::time::Instant::now() + interval, interval);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    loop {
        let current = *phase.borrow();
        if current == PHASE_STOP {
            break;
        }
        if current == PHASE_IDLE {
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
                if changed.is_err() { break; }
            }
            _ = ticker.tick() => {
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

    conn.close(0u32.into(), b"scale run complete");
}

#[cfg(test)]
mod tests {
    use super::{escape, json_num, json_u64, parse_or_default, percentile};

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
