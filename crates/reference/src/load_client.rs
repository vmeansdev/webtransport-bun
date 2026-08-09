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
const DEFAULT_MAX_SESSION_ERRORS: u64 = 0;
const DEFAULT_MAX_DATAGRAM_ERRORS: u64 = 0;
const DEFAULT_MAX_STREAM_ERRORS: u64 = 0;
const DEFAULT_RECONNECT_HOLD_MS: u64 = 1_000;
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
            _ => {}
        }
    }

    println!(
        "load-client: mode={} url={} sessions={} duration={}s datagrams/s={} streams/s={} hold_ms={} skip_probes={} budgets(session={}, datagram={}, stream={})",
        mode.as_str(),
        url,
        sessions,
        duration_secs,
        datagrams_per_sec,
        streams_per_sec,
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
            "\"observedReconnects\":{}",
            "}}"
        ),
        mode.as_str(),
        counters.datagram_echo_ok.load(Ordering::Relaxed),
        counters.uni_echo_ok.load(Ordering::Relaxed),
        counters.bidi_echo_ok.load(Ordering::Relaxed),
        counters.stream_reset_ok.load(Ordering::Relaxed),
        counters.stop_sending_ok.load(Ordering::Relaxed),
        counters.reconnects_ok.load(Ordering::Relaxed),
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
    println!("load-client: streams opened={} err={}", st_open, st_err);
    println!(
        "load-client: load streams opened={}",
        counters.load_streams_opened.load(Ordering::Relaxed)
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

async fn run_session(
    conn: wtransport::Connection,
    duration: Duration,
    datagrams_per_sec: u64,
    streams_per_sec: u64,
    counters: &Counters,
) {
    let start = Instant::now();
    let mut stream_sequence = 0u64;
    let mut dg_ticker = ticker_for_rate(datagrams_per_sec);
    let mut st_ticker = ticker_for_rate(streams_per_sec);

    while start.elapsed() < duration {
        tokio::select! {
            _ = conn.closed() => break,
            _ = wait_for_session_deadline(start, duration) => break,
            _ = tick_if_enabled(&mut dg_ticker) => {
                let payload = format!("load:datagram:{}", next_probe_id());
                if conn.send_datagram(payload.as_bytes()).is_ok() {
                    counters.datagrams_sent.fetch_add(1, Ordering::Relaxed);
                } else {
                    counters.datagrams_err.fetch_add(1, Ordering::Relaxed);
                }
            }
            _ = tick_if_enabled(&mut st_ticker) => {
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
    // Shutdown state machine: stop (loop exited) → close → wait-for-closed (timeout).
    conn.close(0u32.into(), b"load test done");
    let _ = tokio::time::timeout(CLOSE_TIMEOUT, conn.closed()).await;
}

async fn wait_for_session_deadline(start: Instant, duration: Duration) {
    tokio::time::sleep(duration.saturating_sub(start.elapsed())).await;
}

fn ticker_for_rate(rate_per_sec: u64) -> Option<tokio::time::Interval> {
    if rate_per_sec == 0 {
        return None;
    }
    let mut ticker = interval(Duration::from_secs_f64(1.0 / rate_per_sec as f64));
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    Some(ticker)
}

async fn tick_if_enabled(ticker: &mut Option<tokio::time::Interval>) {
    match ticker {
        Some(ticker) => {
            ticker.tick().await;
        }
        None => std::future::pending::<()>().await,
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
        load_summary_json, parse_client_mode, parse_or_default, ticker_for_rate,
        wait_for_session_deadline, ClientMode, Counters,
    };
    use std::sync::atomic::Ordering;

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

    #[tokio::test]
    async fn zero_rate_disables_the_operation_ticker() {
        assert!(ticker_for_rate(0).is_none());
        assert!(ticker_for_rate(1).is_some());
    }

    #[tokio::test]
    async fn empty_workload_keeps_a_duration_deadline_wake() {
        tokio::time::timeout(
            std::time::Duration::from_millis(50),
            wait_for_session_deadline(
                std::time::Instant::now(),
                std::time::Duration::from_millis(1),
            ),
        )
        .await
        .expect("duration deadline must wake an idle session");
    }
}
