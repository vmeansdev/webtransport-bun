//! WebTransport load client. Connects to a server and generates datagram + stream load.
//! Used by tools/load for CI and soak tests.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Barrier;
use wtransport::error::StreamWriteError;
use wtransport::ClientConfig;
use wtransport::Endpoint;

const DEFAULT_URL: &str = "https://127.0.0.1:4433";
const DEFAULT_SESSIONS: usize = 100;
const DEFAULT_DURATION_SECS: u64 = 30;
const DEFAULT_DATAGRAMS_PER_SEC: u64 = 1000;
const DEFAULT_STREAMS_PER_SEC: u64 = 10;
const CLOSE_TIMEOUT: Duration = Duration::from_secs(5);
// A hosted soak can leave a bounded set of response drains behind the final
// workload tick. Give those drains time to observe FIN before aborting the
// session tasks, while keeping the client lifetime bounded by the harness.
const JOIN_TIMEOUT: Duration = Duration::from_secs(20);
const JOIN_POLL_INTERVAL: Duration = Duration::from_millis(50);
const JOIN_ABORT_WAIT: Duration = Duration::from_secs(1);
const PROBE_TIMEOUT: Duration = Duration::from_secs(2);
const DATAGRAM_PROBE_ATTEMPTS: usize = 3;
const LOAD_RESPONSE_TIMEOUT: Duration = Duration::from_secs(10);
const DEFAULT_MAX_SESSION_ERRORS: u64 = 0;
const DEFAULT_MAX_DATAGRAM_ERRORS: u64 = 0;
const DEFAULT_MAX_STREAM_ERRORS: u64 = 0;
const DEFAULT_RECONNECT_HOLD_MS: u64 = 1_000;
const RECONNECT_ERROR_BACKOFF: Duration = Duration::from_millis(50);
const INITIAL_CONNECT_RETRIES: usize = 3;
const INITIAL_CONNECT_RETRY_BACKOFF: Duration = Duration::from_millis(50);
const PROBE_DATAGRAM_PREFIX: &str = "probe:datagram-echo:";
const PROBE_UNI_ECHO_PREFIX: &str = "probe:uni-echo:";
const PROBE_UNI_STOP_PREFIX: &str = "probe:uni-stop:";
const SERVER_PROBE_PREFIX: &str = "server-probe:";
const PROBE_BIDI_ECHO_PREFIX: &str = "probe:bidi-echo:";
const PROBE_BIDI_RESET_PREFIX: &str = "probe:bidi-reset:";
const LOAD_UNI_PREFIX: &str = "load:uni:";
const LOAD_BIDI_PREFIX: &str = "load:bidi:";

#[derive(Debug, Eq, PartialEq)]
enum UniProbeDisposition {
    Expected,
    ServerOwned,
    Unexpected,
}

fn classify_uni_probe_payload(payload: &[u8], expected: &[u8]) -> UniProbeDisposition {
    if payload == expected {
        UniProbeDisposition::Expected
    } else if payload.starts_with(SERVER_PROBE_PREFIX.as_bytes()) {
        UniProbeDisposition::ServerOwned
    } else {
        UniProbeDisposition::Unexpected
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

fn initial_connect_attempts(retry_sessions: bool) -> usize {
    if retry_sessions {
        INITIAL_CONNECT_RETRIES + 1
    } else {
        1
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
    let mut retry_sessions = false;

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
            "--retry-sessions" => retry_sessions = true,
            _ => {}
        }
    }

    println!(
        "load-client: mode={} url={} sessions={} duration={}s datagrams/s={} streams/s={} hold_ms={} budgets(session={}, datagram={}, stream={})",
        mode.as_str(),
        url,
        sessions,
        duration_secs,
        datagrams_per_sec,
        streams_per_sec,
        reconnect_hold_ms,
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
        retry_sessions,
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
    retry_sessions: bool,
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

async fn read_stream_to_end_before(
    recv: &mut wtransport::RecvStream,
    deadline: Instant,
) -> Result<Vec<u8>, Box<dyn std::error::Error + Send + Sync>> {
    let mut buf = [0u8; 1024];
    let mut out = Vec::new();
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("uni echo timed out while reading a candidate stream".into());
        }
        match tokio::time::timeout(remaining, recv.read(&mut buf)).await?? {
            Some(n) => out.extend_from_slice(&buf[..n]),
            None => return Ok(out),
        }
    }
}

async fn drain_load_bidi_response(
    recv: &mut wtransport::RecvStream,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let mut buf = [0u8; 1024];
    loop {
        match recv.read(&mut buf).await? {
            Some(_) => {}
            None => return Ok(()),
        }
    }
}

async fn run_datagram_echo_probe(
    conn: &wtransport::Connection,
    counters: &Counters,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let payload = format!("{PROBE_DATAGRAM_PREFIX}{}", next_probe_id()).into_bytes();
    for _ in 0..DATAGRAM_PROBE_ATTEMPTS {
        if conn.send_datagram(&payload).is_err() {
            continue;
        }
        counters.datagrams_sent.fetch_add(1, Ordering::Relaxed);
        let deadline = Instant::now() + PROBE_TIMEOUT;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            match tokio::time::timeout(remaining, conn.receive_datagram()).await {
                Ok(Ok(received)) if received.as_ref() == payload.as_slice() => {
                    counters.datagram_echo_ok.fetch_add(1, Ordering::Relaxed);
                    return Ok(());
                }
                Ok(Ok(_)) => {
                    // A server-owned datagram can arrive before the echo. Keep
                    // draining this bounded attempt until the expected payload
                    // arrives or its deadline expires.
                }
                Ok(Err(error)) => return Err(error.into()),
                Err(_) => break,
            }
        }
    }
    Err("datagram echo probe exhausted bounded attempts".into())
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
    let deadline = Instant::now() + PROBE_TIMEOUT;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("uni echo timed out waiting for the client echo".into());
        }
        let mut recv = tokio::time::timeout(remaining, conn.accept_uni()).await??;
        let echoed = read_stream_to_end_before(&mut recv, deadline).await?;
        match classify_uni_probe_payload(&echoed, &payload) {
            UniProbeDisposition::Expected => break,
            // The addon scale harness also exercises a server-created uni stream
            // on this session. Drain that known stream before accepting the
            // client-owned echo so stream ordering cannot make the probe flaky.
            UniProbeDisposition::ServerOwned => continue,
            UniProbeDisposition::Unexpected => {
                return Err("uni echo mismatch".into());
            }
        }
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
    let deadline = Instant::now() + PROBE_TIMEOUT;
    let echoed = read_stream_to_end_before(&mut recv, deadline).await?;
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
    match tokio::time::timeout(PROBE_TIMEOUT, recv.read(&mut buf)).await {
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
    match tokio::time::timeout(PROBE_TIMEOUT, send.stopped()).await {
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
        retry_sessions,
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
            let probe_barrier = Arc::new(Barrier::new(num_sessions.max(1)));
            for i in 0..num_sessions {
                let url = url.to_string();
                let endpoint = Arc::clone(&endpoint);
                let counters = Arc::clone(&counters);
                let probe_barrier = Arc::clone(&probe_barrier);
                if i > 0 {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
                let handle = tokio::spawn(async move {
                    match connect_initial_session(&endpoint, &url, retry_sessions).await {
                        Ok(conn) => {
                            counters.sessions_ok.fetch_add(1, Ordering::Relaxed);
                            run_probe_suite(&conn, counters.as_ref()).await;
                            // Keep high-rate workload traffic behind a barrier so
                            // late session probes are not competing with an
                            // already-saturated earlier session.
                            probe_barrier.wait().await;
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
                            probe_barrier.wait().await;
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

async fn connect_initial_session(
    endpoint: &Endpoint<wtransport::endpoint::endpoint_side::Client>,
    url: &str,
    retry_sessions: bool,
) -> Result<wtransport::Connection, String> {
    let attempts = initial_connect_attempts(retry_sessions);
    let mut last_error = String::from("no connection attempt was made");
    for attempt in 0..attempts {
        match endpoint.connect(url).await {
            Ok(connection) => return Ok(connection),
            Err(error) => {
                last_error = error.to_string();
                if attempt + 1 < attempts {
                    eprintln!(
                        "load-client: initial session connect attempt {}/{} failed: {}; retrying",
                        attempt + 1,
                        attempts,
                        last_error
                    );
                    tokio::time::sleep(INITIAL_CONNECT_RETRY_BACKOFF).await;
                }
            }
        }
    }
    Err(last_error)
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

    // Start after one interval instead of consuming Tokio's immediate first
    // tick. This keeps the zero-rate idle phase truly idle while preserving
    // the requested steady-state rates for active phases.
    let mut dg_ticker = tokio::time::interval_at(
        tokio::time::Instant::now() + datagram_interval,
        datagram_interval,
    );
    let mut st_ticker = tokio::time::interval_at(
        tokio::time::Instant::now() + stream_interval,
        stream_interval,
    );
    dg_ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    st_ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    while start.elapsed() < duration {
        tokio::select! {
            _ = conn.closed() => break,
            _ = dg_ticker.tick() => {
                let payload = format!("load:datagram:{}", next_probe_id());
                if conn.send_datagram(payload.as_bytes()).is_ok() {
                    counters.datagrams_sent.fetch_add(1, Ordering::Relaxed);
                } else {
                    counters.datagrams_err.fetch_add(1, Ordering::Relaxed);
                }
            }
            _ = st_ticker.tick() => {
                let result = if stream_sequence.is_multiple_of(2) {
                    let payload = format!("{LOAD_UNI_PREFIX}{}", next_probe_id()).into_bytes();
                    match conn.open_uni().await {
                        Ok(opening) => match opening.await {
                            Ok(mut send) => {
                                counters.streams_opened.fetch_add(1, Ordering::Relaxed);
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
                            Ok((mut send, mut recv)) => {
                                counters.streams_opened.fetch_add(1, Ordering::Relaxed);
                                match send.write_all(&payload).await {
                                    Ok(()) => match send.finish().await {
                                        Ok(()) => match tokio::time::timeout(
                                            LOAD_RESPONSE_TIMEOUT,
                                            drain_load_bidi_response(&mut recv),
                                        )
                                        .await
                                        {
                                            Ok(result) => result,
                                            Err(_) => {
                                                Err("timed out draining load bidi response".into())
                                            }
                                        },
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
        classify_uni_probe_payload, initial_connect_attempts, load_summary_json, parse_client_mode,
        parse_or_default, ClientMode, Counters, UniProbeDisposition,
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
    fn initial_session_retry_budget_is_bounded() {
        assert_eq!(initial_connect_attempts(false), 1);
        assert_eq!(initial_connect_attempts(true), 4);
    }

    #[test]
    fn load_summary_json_reports_observed_reconnects() {
        let counters = Counters::default();
        counters.reconnects_ok.store(3, Ordering::Relaxed);
        let summary = load_summary_json(ClientMode::Reconnect, &counters);
        assert!(summary.contains("\"observedReconnects\":3"));
    }

    #[test]
    fn classifies_the_client_echo_before_server_owned_probe_streams() {
        let expected = b"probe:uni-echo:42";

        assert_eq!(
            classify_uni_probe_payload(expected, expected),
            UniProbeDisposition::Expected
        );
        assert_eq!(
            classify_uni_probe_payload(b"server-probe:4433", expected),
            UniProbeDisposition::ServerOwned
        );
        assert_eq!(
            classify_uni_probe_payload(b"unexpected:payload", expected),
            UniProbeDisposition::Unexpected
        );
    }
}
