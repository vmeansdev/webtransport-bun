//! WebTransport load client. Connects to a server and generates datagram + stream load.
//! Used by tools/load for CI and soak tests.

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
/// Streams are reliable, so closing the session too soon after `finish()` can
/// discard unacknowledged tail bytes and make a healthy step look truncated.
/// 3s comfortably covers the in-flight window on any path this runs on.
const STREAM_DRAIN_GRACE: Duration = Duration::from_secs(3);
const DEFAULT_MAX_SESSION_ERRORS: u64 = 0;
const DEFAULT_MAX_DATAGRAM_ERRORS: u64 = 0;
const DEFAULT_MAX_STREAM_ERRORS: u64 = 0;
const DEFAULT_RECONNECT_HOLD_MS: u64 = 1_000;
/// 0 keeps the legacy tiny string payloads; a positive value pads every load
/// datagram to exactly that many bytes for bandwidth-oriented runs.
const DEFAULT_PAYLOAD_BYTES: usize = 0;
const DEFAULT_STREAM_WRITE_BYTES: usize = 65_536;
const DEFAULT_STREAM_CONCURRENCY: usize = 4;
/// 0 means unpaced (write as fast as flow control allows).
const DEFAULT_STREAM_TARGET_BYTES_PER_SEC: u64 = 0;
const RECONNECT_ERROR_BACKOFF: Duration = Duration::from_millis(50);
const PROBE_DATAGRAM_PREFIX: &str = "probe:datagram-echo:";
const PROBE_UNI_ECHO_PREFIX: &str = "probe:uni-echo:";
const PROBE_UNI_STOP_PREFIX: &str = "probe:uni-stop:";
const PROBE_BIDI_ECHO_PREFIX: &str = "probe:bidi-echo:";
const PROBE_BIDI_RESET_PREFIX: &str = "probe:bidi-reset:";
const LOAD_UNI_PREFIX: &str = "load:uni:";
const LOAD_BIDI_PREFIX: &str = "load:bidi:";

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
enum ClientMode {
    #[default]
    Load,
    Reconnect,
    /// Bulk / churn unidirectional stream load for the stream-throughput axis.
    Stream,
}

impl ClientMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Load => "load",
            Self::Reconnect => "reconnect",
            Self::Stream => "stream",
        }
    }
}

fn parse_client_mode(raw: Option<&str>) -> ClientMode {
    match raw {
        Some("load") | None => ClientMode::Load,
        Some("reconnect") => ClientMode::Reconnect,
        Some("stream") => ClientMode::Stream,
        Some(other) => {
            eprintln!("load-client: invalid value for --mode ('{other}'); using default");
            ClientMode::Load
        }
    }
}

/// Which shape the `stream` mode drives: sustained bytes on long-lived streams,
/// or open/write/finish churn to find the stream-lifecycle ceiling.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
enum StreamWorkload {
    #[default]
    Bulk,
    Churn,
}

impl StreamWorkload {
    fn as_str(self) -> &'static str {
        match self {
            Self::Bulk => "bulk",
            Self::Churn => "churn",
        }
    }
}

fn parse_stream_workload(raw: Option<&str>) -> StreamWorkload {
    match raw {
        Some("bulk") | None => StreamWorkload::Bulk,
        Some("churn") => StreamWorkload::Churn,
        Some(other) => {
            eprintln!(
                "load-client: invalid value for --stream-workload ('{other}'); using default"
            );
            StreamWorkload::Bulk
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
    let mut stream_workload = StreamWorkload::Bulk;
    let mut stream_write_bytes = DEFAULT_STREAM_WRITE_BYTES;
    let mut stream_concurrency = DEFAULT_STREAM_CONCURRENCY;
    let mut stream_target_bytes_per_sec = DEFAULT_STREAM_TARGET_BYTES_PER_SEC;

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
            "--stream-workload" => stream_workload = parse_stream_workload(args.next().as_deref()),
            "--stream-write-bytes" => {
                stream_write_bytes = parse_or_default(
                    "--stream-write-bytes",
                    args.next(),
                    DEFAULT_STREAM_WRITE_BYTES,
                )
            }
            "--stream-concurrency" => {
                stream_concurrency = parse_or_default(
                    "--stream-concurrency",
                    args.next(),
                    DEFAULT_STREAM_CONCURRENCY,
                )
            }
            "--stream-target-bytes-per-sec" => {
                stream_target_bytes_per_sec = parse_or_default(
                    "--stream-target-bytes-per-sec",
                    args.next(),
                    DEFAULT_STREAM_TARGET_BYTES_PER_SEC,
                )
            }
            _ => {}
        }
    }

    let stream_concurrency = stream_concurrency.max(1);
    let stream_write_bytes = stream_write_bytes.max(1);

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
    if mode == ClientMode::Stream {
        println!(
            "load-client: stream workload={} write_bytes={} concurrency={} target_bytes_per_sec_per_session={}",
            stream_workload.as_str(),
            stream_write_bytes,
            stream_concurrency,
            stream_target_bytes_per_sec
        );
    }

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
        stream: StreamOptions {
            workload: stream_workload,
            write_bytes: stream_write_bytes,
            concurrency: stream_concurrency,
            target_bytes_per_sec: stream_target_bytes_per_sec,
        },
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
    stream_bytes_written: AtomicU64,
    stream_writes: AtomicU64,
    streams_completed: AtomicU64,
    // quinn per-connection UDP stats, summed over sessions at session teardown.
    // `ios` is the syscall count; `datagrams` the UDP datagram count. Their
    // ratio is the only direct read on whether GSO/GRO actually engaged, as
    // opposed to merely being available (see gso-probe for capability).
    udp_tx_datagrams: AtomicU64,
    udp_tx_bytes: AtomicU64,
    udp_tx_ios: AtomicU64,
    udp_rx_datagrams: AtomicU64,
    udp_rx_bytes: AtomicU64,
    udp_rx_ios: AtomicU64,
}

/// Snapshot the connection's quinn UDP counters into the run totals. Called
/// once per session, just before close, while the connection is still alive.
fn record_udp_stats(conn: &wtransport::Connection, counters: &Counters) {
    let stats = conn.quic_connection().stats();
    counters
        .udp_tx_datagrams
        .fetch_add(stats.udp_tx.datagrams, Ordering::Relaxed);
    counters
        .udp_tx_bytes
        .fetch_add(stats.udp_tx.bytes, Ordering::Relaxed);
    counters
        .udp_tx_ios
        .fetch_add(stats.udp_tx.ios, Ordering::Relaxed);
    counters
        .udp_rx_datagrams
        .fetch_add(stats.udp_rx.datagrams, Ordering::Relaxed);
    counters
        .udp_rx_bytes
        .fetch_add(stats.udp_rx.bytes, Ordering::Relaxed);
    counters
        .udp_rx_ios
        .fetch_add(stats.udp_rx.ios, Ordering::Relaxed);
}

#[derive(Clone, Copy)]
struct ErrorBudgets {
    max_session_errors: u64,
    max_datagram_errors: u64,
    max_stream_errors: u64,
}

#[derive(Clone, Copy)]
struct StreamOptions {
    workload: StreamWorkload,
    write_bytes: usize,
    concurrency: usize,
    /// Per-session target. 0 means unpaced.
    target_bytes_per_sec: u64,
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
    stream: StreamOptions,
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
        stream,
        budgets,
    } = options;
    let config = ClientConfig::builder()
        .with_bind_default()
        .with_no_cert_validation()
        .build();

    let endpoint = Arc::new(Endpoint::client(config)?);
    let counters = Arc::new(Counters::default());

    match mode {
        ClientMode::Load => {
            let mut handles = Vec::with_capacity(num_sessions);
            for i in 0..num_sessions {
                let url = url.to_string();
                let endpoint = Arc::clone(&endpoint);
                let counters = Arc::clone(&counters);
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
                                datagrams_per_sec,
                                streams_per_sec,
                                payload_bytes,
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
        ClientMode::Stream => {
            let mut handles = Vec::with_capacity(num_sessions);
            for i in 0..num_sessions {
                let url = url.to_string();
                let endpoint = Arc::clone(&endpoint);
                let counters = Arc::clone(&counters);
                if i > 0 {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
                let handle = tokio::spawn(async move {
                    match endpoint.connect(&url).await {
                        Ok(conn) => {
                            counters.sessions_ok.fetch_add(1, Ordering::Relaxed);
                            run_stream_session(conn, duration, stream, counters).await;
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
            // Stream sessions tail off with STREAM_DRAIN_GRACE + CLOSE_TIMEOUT
            // after the step ends; the default join window would abort them
            // mid-teardown and lose their quinn UDP stats.
            wait_for_handles_within(handles, JOIN_TIMEOUT + STREAM_DRAIN_GRACE + CLOSE_TIMEOUT)
                .await;
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
    println!(
        "load-client: stream bytes written={} writes={} completed={}",
        counters.stream_bytes_written.load(Ordering::Relaxed),
        counters.stream_writes.load(Ordering::Relaxed),
        counters.streams_completed.load(Ordering::Relaxed)
    );
    // GSO/GRO engagement evidence. datagrams/ios > 1 means quinn-udp coalesced;
    // == 1 means it silently fell back to one packet per syscall.
    println!(
        "load-client: udp tx datagrams={} bytes={} ios={} rx datagrams={} bytes={} ios={}",
        counters.udp_tx_datagrams.load(Ordering::Relaxed),
        counters.udp_tx_bytes.load(Ordering::Relaxed),
        counters.udp_tx_ios.load(Ordering::Relaxed),
        counters.udp_rx_datagrams.load(Ordering::Relaxed),
        counters.udp_rx_bytes.load(Ordering::Relaxed),
        counters.udp_rx_ios.load(Ordering::Relaxed)
    );

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
    wait_for_handles_within(handles, JOIN_TIMEOUT).await
}

async fn wait_for_handles_within(handles: Vec<tokio::task::JoinHandle<()>>, timeout: Duration) {
    let join_deadline = Instant::now() + timeout;
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

async fn run_session(
    conn: wtransport::Connection,
    duration: Duration,
    datagrams_per_sec: u64,
    streams_per_sec: u64,
    payload_bytes: usize,
    counters: &Counters,
) {
    let start = Instant::now();
    let mut stream_sequence = 0u64;
    let datagram_interval = if datagrams_per_sec > 0 {
        Duration::from_secs_f64(1.0 / datagrams_per_sec as f64)
    } else {
        Duration::from_secs(3600)
    };
    let stream_interval = if streams_per_sec > 0 {
        Duration::from_secs_f64(1.0 / streams_per_sec as f64)
    } else {
        Duration::from_secs(3600)
    };

    let mut dg_ticker = interval(datagram_interval);
    let mut st_ticker = interval(stream_interval);
    dg_ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    st_ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    // `interval` fires its first tick immediately, so a rate of 0 still emitted
    // one datagram / opened one stream per session. Burn that tick when the
    // arm is meant to be off, or a datagram-only run measures a few stray
    // streams too.
    if datagrams_per_sec == 0 {
        dg_ticker.tick().await;
    }
    if streams_per_sec == 0 {
        st_ticker.tick().await;
    }

    // Padded template for bandwidth runs; the per-datagram id is stamped over
    // the prefix region so every payload stays unique without a fresh alloc.
    let mut padded = if payload_bytes > 0 {
        vec![b'x'; payload_bytes]
    } else {
        Vec::new()
    };

    while start.elapsed() < duration {
        tokio::select! {
            _ = conn.closed() => break,
            _ = dg_ticker.tick() => {
                let sent = if payload_bytes > 0 {
                    let header = format!("load:datagram:{}:", next_probe_id());
                    let n = header.len().min(padded.len());
                    padded[..n].copy_from_slice(&header.as_bytes()[..n]);
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
            received = conn.receive_datagram() => {
                match received {
                    Ok(datagram) => {
                        counters.datagrams_received.fetch_add(1, Ordering::Relaxed);
                        counters
                            .datagram_bytes_received
                            .fetch_add(datagram.as_ref().len() as u64, Ordering::Relaxed);
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
    tokio::time::sleep(LOAD_DRAIN_GRACE).await;
    record_udp_stats(&conn, counters);
    // Shutdown state machine: stop (loop exited) → close → wait-for-closed (timeout).
    conn.close(0u32.into(), b"load test done");
    let _ = tokio::time::timeout(CLOSE_TIMEOUT, conn.closed()).await;
}

/// Stream-throughput session: fan out `concurrency` unidirectional writers and
/// let them run for the whole step. Bulk writers hold one stream open for the
/// step; churn writers open/write/finish in a loop.
async fn run_stream_session(
    conn: wtransport::Connection,
    duration: Duration,
    options: StreamOptions,
    counters: Arc<Counters>,
) {
    let per_worker_target = if options.target_bytes_per_sec > 0 {
        (options.target_bytes_per_sec / options.concurrency as u64).max(1)
    } else {
        0
    };

    let mut handles = Vec::with_capacity(options.concurrency);
    for _ in 0..options.concurrency {
        let conn = conn.clone();
        let counters = Arc::clone(&counters);
        handles.push(tokio::spawn(async move {
            match options.workload {
                StreamWorkload::Bulk => {
                    run_bulk_stream_worker(
                        &conn,
                        duration,
                        options.write_bytes,
                        per_worker_target,
                        counters.as_ref(),
                    )
                    .await
                }
                StreamWorkload::Churn => {
                    run_churn_stream_worker(&conn, duration, options.write_bytes, counters.as_ref())
                        .await
                }
            }
        }));
    }
    for handle in handles {
        let _ = handle.await;
    }

    tokio::time::sleep(STREAM_DRAIN_GRACE).await;
    record_udp_stats(&conn, counters.as_ref());
    conn.close(0u32.into(), b"stream bench done");
    let _ = tokio::time::timeout(CLOSE_TIMEOUT, conn.closed()).await;
}

/// One long-lived stream, written for the whole step. `target_bytes_per_sec`
/// of 0 is unpaced — the write loop then runs at whatever flow control allows,
/// which is what the bulk ladder wants.
async fn run_bulk_stream_worker(
    conn: &wtransport::Connection,
    duration: Duration,
    write_bytes: usize,
    target_bytes_per_sec: u64,
    counters: &Counters,
) {
    let buf = vec![b'x'; write_bytes];
    let mut send = match open_uni_send(conn, counters).await {
        Some(send) => send,
        None => return,
    };

    let start = Instant::now();
    let mut written: u64 = 0;
    while start.elapsed() < duration {
        if let Err(e) = send.write_all(&buf).await {
            counters.streams_err.fetch_add(1, Ordering::Relaxed);
            eprintln!("load-client: bulk stream write failed: {e}");
            return;
        }
        written += write_bytes as u64;
        counters
            .stream_bytes_written
            .fetch_add(write_bytes as u64, Ordering::Relaxed);
        counters.stream_writes.fetch_add(1, Ordering::Relaxed);

        if target_bytes_per_sec > 0 {
            let due = Duration::from_secs_f64(written as f64 / target_bytes_per_sec as f64);
            let elapsed = start.elapsed();
            if due > elapsed {
                tokio::time::sleep(due - elapsed).await;
            }
        }
    }

    match send.finish().await {
        Ok(()) => {
            counters.streams_completed.fetch_add(1, Ordering::Relaxed);
        }
        Err(e) => {
            counters.streams_err.fetch_add(1, Ordering::Relaxed);
            eprintln!("load-client: bulk stream finish failed: {e}");
        }
    }
}

/// Open / write / finish as fast as the peer allows, to find the stream
/// lifecycle ceiling rather than the byte ceiling. Bails on the first error so
/// a rejecting server produces one error, not a hot loop of them.
async fn run_churn_stream_worker(
    conn: &wtransport::Connection,
    duration: Duration,
    write_bytes: usize,
    counters: &Counters,
) {
    let buf = vec![b'x'; write_bytes];
    let start = Instant::now();
    while start.elapsed() < duration {
        let mut send = match open_uni_send(conn, counters).await {
            Some(send) => send,
            None => return,
        };
        if let Err(e) = send.write_all(&buf).await {
            counters.streams_err.fetch_add(1, Ordering::Relaxed);
            eprintln!("load-client: churn stream write failed: {e}");
            return;
        }
        if let Err(e) = send.finish().await {
            counters.streams_err.fetch_add(1, Ordering::Relaxed);
            eprintln!("load-client: churn stream finish failed: {e}");
            return;
        }
        counters
            .stream_bytes_written
            .fetch_add(write_bytes as u64, Ordering::Relaxed);
        counters.stream_writes.fetch_add(1, Ordering::Relaxed);
        counters.streams_completed.fetch_add(1, Ordering::Relaxed);
    }
}

async fn open_uni_send(
    conn: &wtransport::Connection,
    counters: &Counters,
) -> Option<wtransport::SendStream> {
    let opening = match conn.open_uni().await {
        Ok(opening) => opening,
        Err(e) => {
            counters.streams_err.fetch_add(1, Ordering::Relaxed);
            eprintln!("load-client: open_uni failed: {e}");
            return None;
        }
    };
    match opening.await {
        Ok(send) => {
            counters.streams_opened.fetch_add(1, Ordering::Relaxed);
            counters.load_streams_opened.fetch_add(1, Ordering::Relaxed);
            Some(send)
        }
        Err(e) => {
            counters.streams_err.fetch_add(1, Ordering::Relaxed);
            eprintln!("load-client: uni stream open await failed: {e}");
            None
        }
    }
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
        load_summary_json, parse_client_mode, parse_or_default, parse_stream_workload, ClientMode,
        Counters, StreamWorkload,
    };
    use std::sync::atomic::Ordering;

    #[test]
    fn parse_client_mode_parses_stream() {
        assert_eq!(parse_client_mode(Some("stream")), ClientMode::Stream);
    }

    #[test]
    fn parse_stream_workload_parses_churn() {
        assert_eq!(parse_stream_workload(Some("churn")), StreamWorkload::Churn);
    }

    #[test]
    fn parse_stream_workload_falls_back_on_unknown_values() {
        assert_eq!(parse_stream_workload(Some("nope")), StreamWorkload::Bulk);
        assert_eq!(parse_stream_workload(None), StreamWorkload::Bulk);
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
