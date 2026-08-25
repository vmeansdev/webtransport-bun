//! WebTransport load client. Connects to a server and generates datagram + stream load.
//! Used by tools/load for CI and soak tests.

mod latency_probe;

use latency_probe::{monotonic_ns, read_stamp, write_stamp, AtomicHistogram, STAMP_BYTES};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::time::interval;
use wtransport::error::StreamWriteError;
use wtransport::ClientConfig;
use wtransport::Endpoint;

const DEFAULT_URL: &str = "https://127.0.0.1:4433";
const DEFAULT_SESSIONS: usize = 100;
const DEFAULT_DURATION_SECS: u64 = 30;
const DEFAULT_DATAGRAMS_PER_SEC: u64 = 1000;
const DEFAULT_STREAMS_PER_SEC: u64 = 10;
const CLOSE_TIMEOUT: Duration = Duration::from_secs(5);
const JOIN_TIMEOUT: Duration = Duration::from_secs(10);
const JOIN_POLL_INTERVAL: Duration = Duration::from_millis(50);
const JOIN_ABORT_WAIT: Duration = Duration::from_secs(1);
/// Per-probe echo deadline. 2s is ample locally, but a shared CI runner
/// handshaking hundreds of concurrent sessions can push a single echo past it;
/// `LOAD_CLIENT_PROBE_TIMEOUT_MS` gives such lanes headroom without relaxing
/// the load-phase error contract (a probe that never echoes still fails).
fn probe_timeout() -> Duration {
    std::env::var("LOAD_CLIENT_PROBE_TIMEOUT_MS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|&ms| ms > 0)
        .map(Duration::from_millis)
        .unwrap_or(Duration::from_secs(2))
}
const LOAD_DRAIN_GRACE: Duration = Duration::from_millis(250);
const DEFAULT_MAX_SESSION_ERRORS: u64 = 0;
const DEFAULT_MAX_DATAGRAM_ERRORS: u64 = 0;
const DEFAULT_MAX_STREAM_ERRORS: u64 = 0;
const DEFAULT_RECONNECT_HOLD_MS: u64 = 1_000;
/// 0 keeps the legacy tiny string payloads; a positive value pads every load
/// datagram to exactly that many bytes for bandwidth-oriented runs.
const DEFAULT_PAYLOAD_BYTES: usize = 0;
/// 64 Hz is the competitive-FPS default and the one the latency axis registers.
const DEFAULT_TICK_HZ: u64 = 64;
/// Floor on the uniform arm's wake period, applied to latency-stamped runs
/// only. Comfortably above the ~1 ms timer granularity both Linux and macOS
/// give tokio, so a requested rate above ~500/s/session is actually produced
/// instead of quietly halved.
const MIN_UNIFORM_PERIOD_NS: u64 = 2_000_000;
const RECONNECT_ERROR_BACKOFF: Duration = Duration::from_millis(50);
const PROBE_DATAGRAM_PREFIX: &str = "probe:datagram-echo:";
const PROBE_UNI_ECHO_PREFIX: &str = "probe:uni-echo:";
const PROBE_UNI_STOP_PREFIX: &str = "probe:uni-stop:";
const PROBE_BIDI_ECHO_PREFIX: &str = "probe:bidi-echo:";
const PROBE_BIDI_RESET_PREFIX: &str = "probe:bidi-reset:";
const LOAD_UNI_PREFIX: &str = "load:uni:";
const LOAD_BIDI_PREFIX: &str = "load:bidi:";

/// How the load client spaces its datagrams in time.
///
/// `Uniform` is the shape every previous bench used: one datagram per interval,
/// with each session phase-offset so arrivals spread out. `Tick` is the game
/// server shape: every session fires its whole per-tick quota back-to-back at
/// the *same* shared deadline, then goes quiet. Same aggregate rate, completely
/// different arrival process — best case for batch fill, worst case for the tail.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
enum ArrivalProfile {
    #[default]
    Uniform,
    Tick,
}

impl ArrivalProfile {
    fn as_str(self) -> &'static str {
        match self {
            Self::Uniform => "uniform",
            Self::Tick => "tick",
        }
    }
}

fn parse_arrival_profile(raw: Option<&str>) -> ArrivalProfile {
    match raw {
        Some("uniform") | None => ArrivalProfile::Uniform,
        Some("tick") => ArrivalProfile::Tick,
        Some(other) => {
            eprintln!("load-client: invalid value for --arrival ('{other}'); using default");
            ArrivalProfile::Uniform
        }
    }
}

/// Client-side half of the latency instrumentation: round-trip time against the
/// client's own clock (no cross-process clock assumption at all), and the
/// client's own send-schedule lag, which is how generator saturation gets
/// separated from server latency instead of being blamed on the server.
#[derive(Default)]
struct LatencyProbe {
    rtt: AtomicHistogram,
    /// Server echo send instant → this datagram returning from
    /// `receive_datagram`. The egress half of the registered ingest-vs-egress
    /// cross-check, measured on the same datagram as the ingest half and against
    /// the same `CLOCK_MONOTONIC` both processes read.
    egress: AtomicHistogram,
    /// This client's send instant → the server's echo send instant: the server's
    /// ingest and turnaround legs added together, computed here from two stamps
    /// in one payload. Its whole job is to be compared against the server's own
    /// two histograms — if the two processes disagree about the same datagrams,
    /// the shared-clock assumption is broken and the cross-check is void.
    upstream_plus_turnaround: AtomicHistogram,
    /// Echoes that came back stamped but with no echo instant in them — a
    /// version-1 stamp, or a server that did not stamp. Counted, never inferred:
    /// treating a missing instant as zero would report an egress latency of
    /// "since the machine booted".
    echo_missing_echo_instant: AtomicU64,
    /// Wake lateness only: the *first* datagram of each send event against its
    /// deadline. Recording every datagram would fold the burst's own duration
    /// into the tick arm's lag and make it grow with rate for a structural
    /// reason that has nothing to do with saturation.
    schedule_lag: AtomicHistogram,
    /// How long a whole send event took to push out, first datagram to last.
    /// Always zero in the uniform arm, where a send event is one datagram.
    burst_spread: AtomicHistogram,
    echo_unstamped: AtomicU64,
    ticks_skipped: AtomicU64,
    send_events: AtomicU64,
    /// Longest window any single session actually spent offering load, and the
    /// sum across sessions that offered any. Requested volume is derived from
    /// the measured window, never from the nominal `--duration`: a step that ran
    /// short would otherwise be judged against load it was never given time to
    /// send, and a session that died would be judged against nothing.
    drive_ns_max: AtomicU64,
    drive_ns_total: AtomicU64,
    sessions_driving: AtomicU64,
}

impl LatencyProbe {
    /// One session finished offering load, having done so for `drive_ns`.
    fn record_drive(&self, drive_ns: u64) {
        self.drive_ns_max.fetch_max(drive_ns, Ordering::Relaxed);
        self.drive_ns_total.fetch_add(drive_ns, Ordering::Relaxed);
        self.sessions_driving.fetch_add(1, Ordering::Relaxed);
    }

    fn to_json(&self, arrival: ArrivalProfile, effective_rate: f64) -> String {
        let driving = self.sessions_driving.load(Ordering::Relaxed);
        let mean_drive_sec = if driving == 0 {
            0.0
        } else {
            self.drive_ns_total.load(Ordering::Relaxed) as f64 / driving as f64 / 1e9
        };
        format!(
            concat!(
                "{{\"arrival\":\"{}\",\"effectiveDatagramsPerSecPerSession\":{:.3},",
                "\"rtt\":{},\"scheduleLag\":{},\"burstSpread\":{},",
                "\"egressOneWay\":{},\"upstreamPlusTurnaround\":{},",
                "\"echoMissingEchoInstant\":{},",
                "\"echoUnstamped\":{},\"ticksSkipped\":{},\"sendEvents\":{},",
                "\"driveWindowSec\":{:.6},\"driveWindowMeanSec\":{:.6},\"sessionsDriving\":{}}}"
            ),
            arrival.as_str(),
            effective_rate,
            self.rtt.to_json(),
            self.schedule_lag.to_json(),
            self.burst_spread.to_json(),
            self.egress.to_json(),
            self.upstream_plus_turnaround.to_json(),
            self.echo_missing_echo_instant.load(Ordering::Relaxed),
            self.echo_unstamped.load(Ordering::Relaxed),
            self.ticks_skipped.load(Ordering::Relaxed),
            self.send_events.load(Ordering::Relaxed),
            self.drive_ns_max.load(Ordering::Relaxed) as f64 / 1e9,
            mean_drive_sec,
            driving,
        )
    }
}

/// Deadline generator shared by both arrival profiles.
///
/// Both profiles are the same machine with different `(period, burst)`: uniform
/// is `(1/rate, 1)`, tick is `(1/tick_hz, rate/tick_hz)`. Keeping one
/// implementation means the two arms cannot drift apart in some detail nobody
/// looked at.
struct DatagramSchedule {
    anchor: Instant,
    anchor_ns: u64,
    period_ns: u64,
    burst: u64,
    /// Index of the *next* send event, 1-based against the anchor.
    index: u64,
}

impl DatagramSchedule {
    fn deadline(&self) -> Instant {
        self.anchor + Duration::from_nanos(self.period_ns.saturating_mul(self.index))
    }

    fn intended_ns(&self) -> u64 {
        self.anchor_ns + self.period_ns.saturating_mul(self.index)
    }

    /// Skip past events whose deadline is already in the past, the way
    /// `MissedTickBehavior::Skip` does — a backlogged generator must not run
    /// away and reshape the offered load. The skipped count is reported so the
    /// shortfall shows up as evidence rather than as a mystery.
    fn catch_up(&mut self, now: Instant) -> u64 {
        let elapsed = now.saturating_duration_since(self.anchor).as_nanos() as u64;
        let min_index = elapsed / self.period_ns + 1;
        if min_index > self.index {
            let skipped = min_index - self.index;
            self.index = min_index;
            skipped
        } else {
            0
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
enum ClientMode {
    #[default]
    Load,
    Reconnect,
}

impl ClientMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Load => "load",
            Self::Reconnect => "reconnect",
        }
    }
}

fn parse_client_mode(raw: Option<&str>) -> ClientMode {
    match raw {
        Some("load") | None => ClientMode::Load,
        Some("reconnect") => ClientMode::Reconnect,
        Some(other) => {
            eprintln!("load-client: invalid value for --mode ('{other}'); using default");
            ClientMode::Load
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
                eprintln!("load-client: invalid value for {flag} ('{v}'): {e}; using default");
                default
            }
        },
        None => default,
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let mut mode = ClientMode::Load;
    let mut url = DEFAULT_URL.to_string();
    let mut sessions = DEFAULT_SESSIONS;
    let mut duration_secs = DEFAULT_DURATION_SECS;
    let mut datagrams_per_sec = DEFAULT_DATAGRAMS_PER_SEC;
    let mut streams_per_sec = DEFAULT_STREAMS_PER_SEC;
    let mut max_session_errors = DEFAULT_MAX_SESSION_ERRORS;
    let mut max_datagram_errors = DEFAULT_MAX_DATAGRAM_ERRORS;
    let mut max_stream_errors = DEFAULT_MAX_STREAM_ERRORS;
    let mut reconnect_hold_ms = DEFAULT_RECONNECT_HOLD_MS;
    let mut skip_probes = false;
    let mut payload_bytes = DEFAULT_PAYLOAD_BYTES;
    let mut arrival = ArrivalProfile::Uniform;
    let mut tick_hz = DEFAULT_TICK_HZ;
    let mut latency_stamp = false;

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--mode" => mode = parse_client_mode(args.next().as_deref()),
            "--url" => url = args.next().unwrap_or_else(|| DEFAULT_URL.to_string()),
            "--sessions" => {
                sessions = parse_or_default("--sessions", args.next(), DEFAULT_SESSIONS)
            }
            "--duration" => {
                duration_secs = parse_or_default("--duration", args.next(), DEFAULT_DURATION_SECS)
            }
            "--datagrams-per-sec" => {
                datagrams_per_sec = parse_or_default(
                    "--datagrams-per-sec",
                    args.next(),
                    DEFAULT_DATAGRAMS_PER_SEC,
                )
            }
            "--streams-per-sec" => {
                streams_per_sec =
                    parse_or_default("--streams-per-sec", args.next(), DEFAULT_STREAMS_PER_SEC)
            }
            "--max-session-errors" => {
                max_session_errors = parse_or_default(
                    "--max-session-errors",
                    args.next(),
                    DEFAULT_MAX_SESSION_ERRORS,
                )
            }
            "--max-datagram-errors" => {
                max_datagram_errors = parse_or_default(
                    "--max-datagram-errors",
                    args.next(),
                    DEFAULT_MAX_DATAGRAM_ERRORS,
                )
            }
            "--max-stream-errors" => {
                max_stream_errors = parse_or_default(
                    "--max-stream-errors",
                    args.next(),
                    DEFAULT_MAX_STREAM_ERRORS,
                )
            }
            "--hold-ms" => {
                reconnect_hold_ms =
                    parse_or_default("--hold-ms", args.next(), DEFAULT_RECONNECT_HOLD_MS)
            }
            "--skip-probes" => skip_probes = true,
            "--payload-bytes" => {
                payload_bytes =
                    parse_or_default("--payload-bytes", args.next(), DEFAULT_PAYLOAD_BYTES)
            }
            "--arrival" => arrival = parse_arrival_profile(args.next().as_deref()),
            "--tick-hz" => tick_hz = parse_or_default("--tick-hz", args.next(), DEFAULT_TICK_HZ),
            "--latency-stamp" => latency_stamp = true,
            _ => {}
        }
    }

    if latency_stamp && payload_bytes < STAMP_BYTES {
        return Err(format!(
            "--latency-stamp needs --payload-bytes >= {STAMP_BYTES}, got {payload_bytes}"
        )
        .into());
    }
    if arrival == ArrivalProfile::Tick && tick_hz == 0 {
        return Err("--arrival tick needs --tick-hz > 0".into());
    }

    println!(
        "load-client: arrival={} tick_hz={} latency_stamp={}",
        arrival.as_str(),
        tick_hz,
        latency_stamp
    );
    println!(
        "load-client: mode={} url={} sessions={} duration={}s datagrams/s={} streams/s={} payload_bytes={} hold_ms={} skip_probes={} budgets(session={}, datagram={}, stream={})",
        mode.as_str(),
        url,
        sessions,
        duration_secs,
        datagrams_per_sec,
        streams_per_sec,
        payload_bytes,
        reconnect_hold_ms,
        skip_probes,
        max_session_errors,
        max_datagram_errors,
        max_stream_errors
    );

    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;

    rt.block_on(run(RunOptions {
        mode,
        url: &url,
        num_sessions: sessions,
        duration: Duration::from_secs(duration_secs),
        datagrams_per_sec,
        streams_per_sec,
        reconnect_hold: Duration::from_millis(reconnect_hold_ms),
        skip_probes,
        payload_bytes,
        arrival,
        tick_hz,
        latency_stamp,
        budgets: ErrorBudgets {
            max_session_errors,
            max_datagram_errors,
            max_stream_errors,
        },
    }))
}

#[derive(Default)]
struct Counters {
    sessions_ok: AtomicU64,
    sessions_err: AtomicU64,
    datagrams_sent: AtomicU64,
    datagrams_err: AtomicU64,
    datagrams_received: AtomicU64,
    datagram_bytes_sent: AtomicU64,
    datagram_bytes_received: AtomicU64,
    streams_opened: AtomicU64,
    load_streams_opened: AtomicU64,
    streams_err: AtomicU64,
    datagram_echo_ok: AtomicU64,
    uni_echo_ok: AtomicU64,
    bidi_echo_ok: AtomicU64,
    stream_reset_ok: AtomicU64,
    stop_sending_ok: AtomicU64,
    reconnects_ok: AtomicU64,
}

#[derive(Clone, Copy)]
struct ErrorBudgets {
    max_session_errors: u64,
    max_datagram_errors: u64,
    max_stream_errors: u64,
}

struct RunOptions<'a> {
    mode: ClientMode,
    url: &'a str,
    num_sessions: usize,
    duration: Duration,
    datagrams_per_sec: u64,
    streams_per_sec: u64,
    reconnect_hold: Duration,
    skip_probes: bool,
    payload_bytes: usize,
    arrival: ArrivalProfile,
    tick_hz: u64,
    latency_stamp: bool,
    budgets: ErrorBudgets,
}

fn next_probe_id() -> u64 {
    static NEXT_ID: AtomicU64 = AtomicU64::new(1);
    NEXT_ID.fetch_add(1, Ordering::Relaxed)
}

fn load_summary_json(mode: ClientMode, counters: &Counters) -> String {
    format!(
        concat!(
            "{{",
            "\"mode\":\"{}\",",
            "\"requiredOperationClasses\":[",
            "\"datagram-echo\",\"uni-echo\",\"bidi-echo\",\"stream-reset\",\"stop-sending\"",
            "],",
            "\"observedOperationCounts\":{{",
            "\"datagram-echo\":{},",
            "\"uni-echo\":{},",
            "\"bidi-echo\":{},",
            "\"stream-reset\":{},",
            "\"stop-sending\":{}",
            "}},",
            "\"observedReconnects\":{},",
            "\"datagramsReceived\":{},",
            "\"datagramBytesSent\":{},",
            "\"datagramBytesReceived\":{}",
            "}}"
        ),
        mode.as_str(),
        counters.datagram_echo_ok.load(Ordering::Relaxed),
        counters.uni_echo_ok.load(Ordering::Relaxed),
        counters.bidi_echo_ok.load(Ordering::Relaxed),
        counters.stream_reset_ok.load(Ordering::Relaxed),
        counters.stop_sending_ok.load(Ordering::Relaxed),
        counters.reconnects_ok.load(Ordering::Relaxed),
        counters.datagrams_received.load(Ordering::Relaxed),
        counters.datagram_bytes_sent.load(Ordering::Relaxed),
        counters.datagram_bytes_received.load(Ordering::Relaxed),
    )
}

async fn read_stream_to_end(
    recv: &mut wtransport::RecvStream,
) -> Result<Vec<u8>, Box<dyn std::error::Error + Send + Sync>> {
    let mut buf = [0u8; 1024];
    let mut out = Vec::new();
    loop {
        match recv.read(&mut buf).await? {
            Some(n) => out.extend_from_slice(&buf[..n]),
            None => return Ok(out),
        }
    }
}

async fn run_datagram_echo_probe(
    conn: &wtransport::Connection,
    counters: &Counters,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let payload = format!("{PROBE_DATAGRAM_PREFIX}{}", next_probe_id()).into_bytes();
    conn.send_datagram(&payload)?;
    counters.datagrams_sent.fetch_add(1, Ordering::Relaxed);
    let received = tokio::time::timeout(probe_timeout(), conn.receive_datagram()).await??;
    if received.as_ref() != payload.as_slice() {
        return Err("datagram echo mismatch".into());
    }
    counters.datagram_echo_ok.fetch_add(1, Ordering::Relaxed);
    Ok(())
}

async fn run_uni_echo_probe(
    conn: &wtransport::Connection,
    counters: &Counters,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let payload = format!("{PROBE_UNI_ECHO_PREFIX}{}", next_probe_id()).into_bytes();
    let mut send = conn.open_uni().await?.await?;
    counters.streams_opened.fetch_add(1, Ordering::Relaxed);
    send.write_all(&payload).await?;
    send.finish().await?;
    let mut recv = tokio::time::timeout(probe_timeout(), conn.accept_uni()).await??;
    let echoed = read_stream_to_end(&mut recv).await?;
    if echoed != payload {
        return Err("uni echo mismatch".into());
    }
    counters.uni_echo_ok.fetch_add(1, Ordering::Relaxed);
    Ok(())
}

async fn run_bidi_echo_probe(
    conn: &wtransport::Connection,
    counters: &Counters,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let payload = format!("{PROBE_BIDI_ECHO_PREFIX}{}", next_probe_id()).into_bytes();
    let (mut send, mut recv) = conn.open_bi().await?.await?;
    counters.streams_opened.fetch_add(1, Ordering::Relaxed);
    send.write_all(&payload).await?;
    send.finish().await?;
    let echoed = read_stream_to_end(&mut recv).await?;
    if echoed != payload {
        return Err("bidi echo mismatch".into());
    }
    counters.bidi_echo_ok.fetch_add(1, Ordering::Relaxed);
    Ok(())
}

async fn run_bidi_reset_probe(
    conn: &wtransport::Connection,
    counters: &Counters,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let payload = format!("{PROBE_BIDI_RESET_PREFIX}{}", next_probe_id()).into_bytes();
    let (mut send, mut recv) = conn.open_bi().await?.await?;
    counters.streams_opened.fetch_add(1, Ordering::Relaxed);
    send.write_all(&payload).await?;
    send.finish().await?;
    let mut buf = [0u8; 32];
    match tokio::time::timeout(probe_timeout(), recv.read(&mut buf)).await {
        Ok(Err(_)) => {
            counters.stream_reset_ok.fetch_add(1, Ordering::Relaxed);
            Ok(())
        }
        Ok(Ok(_)) => Err("expected bidi reset error".into()),
        Err(_) => Err("timed out waiting for bidi reset".into()),
    }
}

async fn run_stop_sending_probe(
    conn: &wtransport::Connection,
    counters: &Counters,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let payload = format!("{PROBE_UNI_STOP_PREFIX}{}:payload", next_probe_id()).into_bytes();
    let mut send = conn.open_uni().await?.await?;
    counters.streams_opened.fetch_add(1, Ordering::Relaxed);
    send.write_all(&payload).await?;
    match tokio::time::timeout(probe_timeout(), send.stopped()).await {
        Ok(StreamWriteError::Stopped(_)) => {
            counters.stop_sending_ok.fetch_add(1, Ordering::Relaxed);
            Ok(())
        }
        Ok(other) => Err(format!("expected stop_sending, got {other:?}").into()),
        Err(_) => Err("timed out waiting for stop_sending".into()),
    }
}

async fn run_probe_suite(conn: &wtransport::Connection, counters: &Counters) {
    if let Err(e) = run_datagram_echo_probe(conn, counters).await {
        counters.datagrams_err.fetch_add(1, Ordering::Relaxed);
        eprintln!("load-client: datagram probe failed: {e}");
    }
    for result in [
        run_uni_echo_probe(conn, counters).await,
        run_bidi_echo_probe(conn, counters).await,
        run_bidi_reset_probe(conn, counters).await,
        run_stop_sending_probe(conn, counters).await,
    ] {
        if let Err(e) = result {
            counters.streams_err.fetch_add(1, Ordering::Relaxed);
            eprintln!("load-client: stream probe failed: {e}");
        }
    }
}

async fn run(options: RunOptions<'_>) -> Result<(), Box<dyn std::error::Error>> {
    let RunOptions {
        mode,
        url,
        num_sessions,
        duration,
        datagrams_per_sec,
        streams_per_sec,
        reconnect_hold,
        skip_probes,
        payload_bytes,
        arrival,
        tick_hz,
        latency_stamp,
        budgets,
    } = options;
    let config = ClientConfig::builder()
        .with_bind_default()
        .with_no_cert_validation()
        .build();

    let endpoint = Arc::new(Endpoint::client(config)?);
    let counters = Arc::new(Counters::default());
    let latency = latency_stamp.then(|| Arc::new(LatencyProbe::default()));
    // One anchor for the whole run, captured before any session exists. In tick
    // mode every session lands on this same grid — that is the thundering herd.
    // In uniform mode each session is phase-offset off it, so arrivals spread.
    let anchor = Instant::now();
    let anchor_ns = monotonic_ns();
    let (period_ns, burst) = match arrival {
        // A per-datagram timer cannot outrun the OS timer wheel: asking tokio
        // for a 0.9 ms period on a ~1 ms granularity clock silently halves the
        // offered rate. So the uniform arm keeps its period at or above
        // MIN_UNIFORM_PERIOD_NS and sends the smallest whole burst that still
        // hits the requested rate exactly. Below ~500/s/session that is one
        // datagram per wake, exactly as before; above it the arm becomes
        // mildly bursty (at most a handful of datagrams), which is disclosed
        // rather than hidden — and sessions stay phase-staggered, so aggregate
        // arrivals remain spread.
        ArrivalProfile::Uniform if datagrams_per_sec > 0 => {
            // The floor applies to latency runs only. Every other caller keeps
            // the historical one-datagram-per-wake shape, because changing the
            // arrival process of an existing gate would silently invalidate
            // comparisons against every stamp already taken with it.
            let min_period_ns = if latency_stamp {
                MIN_UNIFORM_PERIOD_NS
            } else {
                1
            };
            let burst = (datagrams_per_sec * min_period_ns)
                .div_ceil(1_000_000_000)
                .max(1);
            ((burst * 1_000_000_000 / datagrams_per_sec).max(1), burst)
        }
        ArrivalProfile::Uniform => (3_600_000_000_000, 1),
        ArrivalProfile::Tick => (
            (1_000_000_000 / tick_hz.max(1)).max(1),
            (datagrams_per_sec as f64 / tick_hz.max(1) as f64)
                .round()
                .max(1.0) as u64,
        ),
    };
    let effective_rate = burst as f64 * (1e9 / period_ns.max(1) as f64);

    match mode {
        ClientMode::Load => {
            let mut handles = Vec::with_capacity(num_sessions);
            for i in 0..num_sessions {
                let url = url.to_string();
                let endpoint = Arc::clone(&endpoint);
                let counters = Arc::clone(&counters);
                let latency = latency.clone();
                // Uniform spreads sessions evenly across one send period; tick
                // deliberately does not.
                let phase_ns = match arrival {
                    ArrivalProfile::Uniform if num_sessions > 0 => {
                        period_ns * i as u64 / num_sessions as u64
                    }
                    _ => 0,
                };
                if i > 0 {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
                let handle = tokio::spawn(async move {
                    match endpoint.connect(&url).await {
                        Ok(conn) => {
                            counters.sessions_ok.fetch_add(1, Ordering::Relaxed);
                            if !skip_probes {
                                run_probe_suite(&conn, counters.as_ref()).await;
                            }
                            run_session(
                                conn,
                                duration,
                                SessionLoad {
                                    schedule: DatagramSchedule {
                                        anchor: anchor + Duration::from_nanos(phase_ns),
                                        anchor_ns: anchor_ns + phase_ns,
                                        period_ns,
                                        burst,
                                        index: 1,
                                    },
                                    streams_per_sec,
                                    payload_bytes,
                                    latency,
                                },
                                counters.as_ref(),
                            )
                            .await;
                        }
                        Err(e) => {
                            counters.sessions_err.fetch_add(1, Ordering::Relaxed);
                            eprintln!("load-client: session connect failed: {e}");
                        }
                    }
                });
                handles.push(handle);
            }
            tokio::time::sleep(duration).await;
            wait_for_handles(handles).await;
        }
        ClientMode::Reconnect => {
            let deadline = Instant::now() + duration;
            let mut handles = Vec::with_capacity(num_sessions);
            for i in 0..num_sessions {
                let url = url.to_string();
                let endpoint = Arc::clone(&endpoint);
                let counters = Arc::clone(&counters);
                if i > 0 {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
                let handle = tokio::spawn(async move {
                    run_reconnect_worker(endpoint, url, deadline, reconnect_hold, counters).await;
                });
                handles.push(handle);
            }
            wait_for_handles(handles).await;
        }
    }

    // Don't call endpoint.close() — wtransport panics if connections are still alive.

    let ok = counters.sessions_ok.load(Ordering::Relaxed);
    let err = counters.sessions_err.load(Ordering::Relaxed);
    let dg_sent = counters.datagrams_sent.load(Ordering::Relaxed);
    let dg_err = counters.datagrams_err.load(Ordering::Relaxed);
    let st_open = counters.streams_opened.load(Ordering::Relaxed);
    let st_err = counters.streams_err.load(Ordering::Relaxed);

    println!(
        "load-client: summary {}",
        load_summary_json(mode, counters.as_ref())
    );
    println!("load-client: sessions ok={} err={}", ok, err);
    println!("load-client: datagrams sent={} err={}", dg_sent, dg_err);
    println!(
        "load-client: datagrams received={} bytes tx={} rx={}",
        counters.datagrams_received.load(Ordering::Relaxed),
        counters.datagram_bytes_sent.load(Ordering::Relaxed),
        counters.datagram_bytes_received.load(Ordering::Relaxed)
    );
    println!("load-client: streams opened={} err={}", st_open, st_err);
    println!(
        "load-client: load streams opened={}",
        counters.load_streams_opened.load(Ordering::Relaxed)
    );
    if let Some(probe) = latency.as_ref() {
        // Serialized only after `wait_for_handles`, which either joins every
        // session task or aborts it and awaits the abort. Nothing is recording
        // by the time these histograms are read; `recordedTotal` in the output
        // is what proves it rather than what assumes it.
        println!(
            "load-client: latency-json {}",
            probe.to_json(arrival, effective_rate)
        );
    }

    let pass = ok > 0
        && err <= budgets.max_session_errors
        && dg_err <= budgets.max_datagram_errors
        && st_err <= budgets.max_stream_errors;
    if pass {
        println!("load-client: PASS");
    } else {
        println!("load-client: FAIL (errors present or no successful sessions)");
        std::process::exit(1);
    }

    Ok(())
}

async fn wait_for_handles(handles: Vec<tokio::task::JoinHandle<()>>) {
    let join_deadline = Instant::now() + JOIN_TIMEOUT;
    while Instant::now() < join_deadline {
        if handles.iter().all(|h| h.is_finished()) {
            break;
        }
        tokio::time::sleep(JOIN_POLL_INTERVAL).await;
    }

    if handles.iter().any(|h| !h.is_finished()) {
        eprintln!("load-client: warning: task join timed out; aborting remaining tasks");
        for h in &handles {
            if !h.is_finished() {
                h.abort();
            }
        }
    }

    for h in handles {
        let _ = tokio::time::timeout(JOIN_ABORT_WAIT, h).await;
    }
}

struct SessionLoad {
    schedule: DatagramSchedule,
    streams_per_sec: u64,
    payload_bytes: usize,
    latency: Option<Arc<LatencyProbe>>,
}

async fn run_session(
    conn: wtransport::Connection,
    duration: Duration,
    load: SessionLoad,
    counters: &Counters,
) {
    let SessionLoad {
        mut schedule,
        streams_per_sec,
        payload_bytes,
        latency,
    } = load;
    let start = Instant::now();
    let mut stream_sequence = 0u64;
    let mut datagram_sequence = 0u64;
    let stream_interval = if streams_per_sec > 0 {
        Duration::from_secs_f64(1.0 / streams_per_sec as f64)
    } else {
        Duration::from_secs(3600)
    };

    let mut st_ticker = interval(stream_interval);
    st_ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    // Padded template for bandwidth runs; the per-datagram id is stamped over
    // the prefix region so every payload stays unique without a fresh alloc.
    let mut padded = if payload_bytes > 0 {
        vec![b'x'; payload_bytes]
    } else {
        Vec::new()
    };

    schedule.catch_up(Instant::now());
    while start.elapsed() < duration {
        let deadline = schedule.deadline();
        tokio::select! {
            _ = conn.closed() => break,
            _ = tokio::time::sleep_until(deadline.into()) => {
                let intended_ns = schedule.intended_ns();
                if let Some(probe) = latency.as_ref() {
                    probe.send_events.fetch_add(1, Ordering::Relaxed);
                }
                let mut first_actual_ns = 0u64;
                let mut last_actual_ns = 0u64;
                for burst_index in 0..schedule.burst {
                    let sent = if payload_bytes > 0 {
                        if let Some(probe) = latency.as_ref() {
                            let actual_ns = monotonic_ns();
                            write_stamp(&mut padded, intended_ns, actual_ns, datagram_sequence);
                            datagram_sequence += 1;
                            if burst_index == 0 {
                                first_actual_ns = actual_ns;
                                probe
                                    .schedule_lag
                                    .record_signed(actual_ns as i64 - intended_ns as i64);
                            }
                            last_actual_ns = actual_ns;
                        } else {
                            let header = format!("load:datagram:{}:", next_probe_id());
                            let n = header.len().min(padded.len());
                            padded[..n].copy_from_slice(&header.as_bytes()[..n]);
                        }
                        conn.send_datagram(&padded)
                    } else {
                        let payload = format!("load:datagram:{}", next_probe_id());
                        conn.send_datagram(payload.as_bytes())
                    };
                    if sent.is_ok() {
                        counters.datagrams_sent.fetch_add(1, Ordering::Relaxed);
                        let len = if payload_bytes > 0 { payload_bytes as u64 } else { 0 };
                        counters.datagram_bytes_sent.fetch_add(len, Ordering::Relaxed);
                    } else {
                        counters.datagrams_err.fetch_add(1, Ordering::Relaxed);
                    }
                }
                if let Some(probe) = latency.as_ref() {
                    probe
                        .burst_spread
                        .record_signed(last_actual_ns as i64 - first_actual_ns as i64);
                }
                schedule.index += 1;
                let skipped = schedule.catch_up(Instant::now());
                if skipped > 0 {
                    if let Some(probe) = latency.as_ref() {
                        probe.ticks_skipped.fetch_add(skipped, Ordering::Relaxed);
                    }
                }
            }
            received = conn.receive_datagram() => {
                match received {
                    Ok(datagram) => {
                        counters.datagrams_received.fetch_add(1, Ordering::Relaxed);
                        counters
                            .datagram_bytes_received
                            .fetch_add(datagram.as_ref().len() as u64, Ordering::Relaxed);
                        if let Some(probe) = latency.as_ref() {
                            // The server echoes the same payload back, so the
                            // stamp is the one this process wrote — round-trip
                            // time against a single clock, no cross-process
                            // assumption anywhere in it. The server adds one
                            // field on the way out, its own send instant, which
                            // splits that round trip into legs.
                            match read_stamp(datagram.as_ref()) {
                                Some(stamp) => {
                                    let now = monotonic_ns() as i64;
                                    probe.rtt.record_signed(now - stamp.actual_ns as i64);
                                    if stamp.echo_actual_ns == 0 {
                                        probe
                                            .echo_missing_echo_instant
                                            .fetch_add(1, Ordering::Relaxed);
                                    } else {
                                        probe
                                            .egress
                                            .record_signed(now - stamp.echo_actual_ns as i64);
                                        probe.upstream_plus_turnaround.record_signed(
                                            stamp.echo_actual_ns as i64 - stamp.actual_ns as i64,
                                        );
                                    }
                                }
                                None => {
                                    probe.echo_unstamped.fetch_add(1, Ordering::Relaxed);
                                }
                            }
                        }
                    }
                    Err(_) => break,
                }
            }
            _ = st_ticker.tick() => {
                let result = if stream_sequence.is_multiple_of(2) {
                    let payload = format!("{LOAD_UNI_PREFIX}{}", next_probe_id()).into_bytes();
                    match conn.open_uni().await {
                        Ok(opening) => match opening.await {
                            Ok(mut send) => {
                                counters.streams_opened.fetch_add(1, Ordering::Relaxed);
                                counters.load_streams_opened.fetch_add(1, Ordering::Relaxed);
                                match send.write_all(&payload).await {
                                    Ok(()) => match send.finish().await {
                                        Ok(()) => Ok::<(), Box<dyn std::error::Error + Send + Sync>>(()),
                                        Err(e) => Err(Box::new(e) as Box<dyn std::error::Error + Send + Sync>),
                                    },
                                    Err(e) => Err(Box::new(e) as Box<dyn std::error::Error + Send + Sync>),
                                }
                            }
                            Err(e) => Err(Box::new(e) as Box<dyn std::error::Error + Send + Sync>),
                        },
                        Err(e) => Err(Box::new(e) as Box<dyn std::error::Error + Send + Sync>),
                    }
                } else {
                    let payload = format!("{LOAD_BIDI_PREFIX}{}", next_probe_id()).into_bytes();
                    match conn.open_bi().await {
                        Ok(opening) => match opening.await {
                            Ok((mut send, _recv)) => {
                                counters.streams_opened.fetch_add(1, Ordering::Relaxed);
                                counters.load_streams_opened.fetch_add(1, Ordering::Relaxed);
                                match send.write_all(&payload).await {
                                    Ok(()) => match send.finish().await {
                                        Ok(()) => Ok::<(), Box<dyn std::error::Error + Send + Sync>>(()),
                                        Err(e) => Err(Box::new(e) as Box<dyn std::error::Error + Send + Sync>),
                                    },
                                    Err(e) => Err(Box::new(e) as Box<dyn std::error::Error + Send + Sync>),
                                }
                            }
                            Err(e) => Err(Box::new(e) as Box<dyn std::error::Error + Send + Sync>),
                        },
                        Err(e) => Err(Box::new(e) as Box<dyn std::error::Error + Send + Sync>),
                    }
                };
                stream_sequence = stream_sequence.wrapping_add(1);
                if let Err(e) = result {
                    counters.streams_err.fetch_add(1, Ordering::Relaxed);
                    eprintln!("load-client: stream workload failed: {e}");
                }
            }
        }
    }
    if let Some(probe) = latency.as_ref() {
        probe.record_drive(start.elapsed().as_nanos() as u64);
    }
    tokio::time::sleep(LOAD_DRAIN_GRACE).await;
    // Shutdown state machine: stop (loop exited) → close → wait-for-closed (timeout).
    conn.close(0u32.into(), b"load test done");
    let _ = tokio::time::timeout(CLOSE_TIMEOUT, conn.closed()).await;
}

async fn run_reconnect_worker(
    endpoint: Arc<Endpoint<wtransport::endpoint::endpoint_side::Client>>,
    url: String,
    deadline: Instant,
    reconnect_hold: Duration,
    counters: Arc<Counters>,
) {
    let mut successful_connects = 0u64;

    while Instant::now() < deadline {
        match endpoint.connect(&url).await {
            Ok(conn) => {
                counters.sessions_ok.fetch_add(1, Ordering::Relaxed);
                if successful_connects > 0 {
                    counters.reconnects_ok.fetch_add(1, Ordering::Relaxed);
                }
                successful_connects = successful_connects.saturating_add(1);
                run_probe_suite(&conn, counters.as_ref()).await;
                let remaining = deadline.saturating_duration_since(Instant::now());
                let hold = reconnect_hold.min(remaining);
                if !hold.is_zero() {
                    tokio::time::sleep(hold).await;
                }
                conn.close(0u32.into(), b"reconnect churn cycle complete");
                let _ = tokio::time::timeout(CLOSE_TIMEOUT, conn.closed()).await;
            }
            Err(e) => {
                counters.sessions_err.fetch_add(1, Ordering::Relaxed);
                eprintln!("load-client: reconnect connect failed: {e}");
                let backoff =
                    RECONNECT_ERROR_BACKOFF.min(deadline.saturating_duration_since(Instant::now()));
                if !backoff.is_zero() {
                    tokio::time::sleep(backoff).await;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        load_summary_json, parse_arrival_profile, parse_client_mode, parse_or_default,
        ArrivalProfile, ClientMode, Counters, DatagramSchedule, LatencyProbe,
    };
    use std::sync::atomic::Ordering;
    use std::time::{Duration, Instant};

    fn schedule(period_ns: u64, anchor: Instant) -> DatagramSchedule {
        DatagramSchedule {
            anchor,
            anchor_ns: 1_000_000_000,
            period_ns,
            burst: 1,
            index: 1,
        }
    }

    #[test]
    fn parse_arrival_profile_accepts_tick_and_falls_back_otherwise() {
        assert_eq!(parse_arrival_profile(Some("tick")), ArrivalProfile::Tick);
        assert_eq!(parse_arrival_profile(None), ArrivalProfile::Uniform);
        assert_eq!(
            parse_arrival_profile(Some("burst")),
            ArrivalProfile::Uniform
        );
    }

    #[test]
    fn schedule_deadlines_advance_by_one_period() {
        let anchor = Instant::now();
        let mut sched = schedule(1_000_000, anchor);
        assert_eq!(sched.deadline(), anchor + Duration::from_millis(1));
        assert_eq!(sched.intended_ns(), 1_001_000_000);
        sched.index += 1;
        assert_eq!(sched.deadline(), anchor + Duration::from_millis(2));
        assert_eq!(sched.intended_ns(), 1_002_000_000);
    }

    /// The bench derives requested volume from `driveWindowSec`, so it has to be
    /// the longest window a session actually offered load for — not the nominal
    /// duration, and not an average dragged down by a session that died early.
    #[test]
    fn drive_window_reports_the_longest_session_and_the_mean() {
        let probe = LatencyProbe::default();
        probe.record_drive(60_000_000_000);
        probe.record_drive(30_000_000_000);
        let json = probe.to_json(ArrivalProfile::Uniform, 100.0);
        assert!(json.contains("\"driveWindowSec\":60.000000"), "{json}");
        assert!(json.contains("\"driveWindowMeanSec\":45.000000"), "{json}");
        assert!(json.contains("\"sessionsDriving\":2"), "{json}");

        let idle = LatencyProbe::default();
        let json = idle.to_json(ArrivalProfile::Uniform, 100.0);
        assert!(json.contains("\"driveWindowSec\":0.000000"), "{json}");
        assert!(json.contains("\"sessionsDriving\":0"), "{json}");
    }

    #[test]
    fn schedule_catches_up_past_missed_deadlines_instead_of_running_away() {
        let anchor = Instant::now();
        let mut sched = schedule(1_000_000, anchor);
        // 10 ms of wall clock burned means ten 1 ms events are gone.
        let skipped = sched.catch_up(anchor + Duration::from_millis(10));
        assert_eq!(skipped, 10);
        assert_eq!(sched.index, 11);
        // A second catch-up at the same instant is a no-op.
        assert_eq!(sched.catch_up(anchor + Duration::from_millis(10)), 0);
    }

    #[test]
    fn parse_or_default_parses_valid_integer() {
        let parsed: usize = parse_or_default("--sessions", Some("42".to_string()), 100);
        assert_eq!(parsed, 42);
    }

    #[test]
    fn parse_or_default_falls_back_on_invalid_integer() {
        let parsed: usize = parse_or_default("--sessions", Some("not-a-number".to_string()), 100);
        assert_eq!(parsed, 100);
    }

    #[test]
    fn parse_or_default_falls_back_on_missing_value() {
        let parsed: u64 = parse_or_default("--duration", None, 30);
        assert_eq!(parsed, 30);
    }

    #[test]
    fn parse_client_mode_parses_reconnect() {
        assert_eq!(parse_client_mode(Some("reconnect")), ClientMode::Reconnect);
    }

    #[test]
    fn parse_client_mode_falls_back_on_unknown_values() {
        assert_eq!(parse_client_mode(Some("unknown")), ClientMode::Load);
    }

    #[test]
    fn load_summary_json_reports_observed_reconnects() {
        let counters = Counters::default();
        counters.reconnects_ok.store(3, Ordering::Relaxed);
        let summary = load_summary_json(ClientMode::Reconnect, &counters);
        assert!(summary.contains("\"observedReconnects\":3"));
    }
}
