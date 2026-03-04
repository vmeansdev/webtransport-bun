//! WebTransport load client. Connects to a server and generates datagram + stream load.
//! Used by tools/load for CI and soak tests.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::time::interval;
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
const DEFAULT_MAX_SESSION_ERRORS: u64 = 0;
const DEFAULT_MAX_DATAGRAM_ERRORS: u64 = 0;
const DEFAULT_MAX_STREAM_ERRORS: u64 = 0;

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
    let mut url = DEFAULT_URL.to_string();
    let mut sessions = DEFAULT_SESSIONS;
    let mut duration_secs = DEFAULT_DURATION_SECS;
    let mut datagrams_per_sec = DEFAULT_DATAGRAMS_PER_SEC;
    let mut streams_per_sec = DEFAULT_STREAMS_PER_SEC;
    let mut max_session_errors = DEFAULT_MAX_SESSION_ERRORS;
    let mut max_datagram_errors = DEFAULT_MAX_DATAGRAM_ERRORS;
    let mut max_stream_errors = DEFAULT_MAX_STREAM_ERRORS;

    while let Some(arg) = args.next() {
        match arg.as_str() {
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
            _ => {}
        }
    }

    println!(
        "load-client: url={} sessions={} duration={}s datagrams/s={} streams/s={} budgets(session={}, datagram={}, stream={})",
        url,
        sessions,
        duration_secs,
        datagrams_per_sec,
        streams_per_sec,
        max_session_errors,
        max_datagram_errors,
        max_stream_errors
    );

    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;

    rt.block_on(run(
        &url,
        sessions,
        Duration::from_secs(duration_secs),
        datagrams_per_sec,
        streams_per_sec,
        ErrorBudgets {
            max_session_errors,
            max_datagram_errors,
            max_stream_errors,
        },
    ))
}

#[derive(Default)]
struct Counters {
    sessions_ok: AtomicU64,
    sessions_err: AtomicU64,
    datagrams_sent: AtomicU64,
    datagrams_err: AtomicU64,
    streams_opened: AtomicU64,
    streams_err: AtomicU64,
}

#[derive(Clone, Copy)]
struct ErrorBudgets {
    max_session_errors: u64,
    max_datagram_errors: u64,
    max_stream_errors: u64,
}

async fn run(
    url: &str,
    num_sessions: usize,
    duration: Duration,
    datagrams_per_sec: u64,
    streams_per_sec: u64,
    budgets: ErrorBudgets,
) -> Result<(), Box<dyn std::error::Error>> {
    let config = ClientConfig::builder()
        .with_bind_default()
        .with_no_cert_validation()
        .build();

    let endpoint = Arc::new(Endpoint::client(config)?);
    let counters = Arc::new(Counters::default());

    // Spawn session tasks (stagger slightly to avoid connection storms).
    // Sleep a fixed interval per spawn; do not multiply by index, otherwise
    // startup becomes O(n^2) wall time (e.g. 500 sessions ~20+ minutes).
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

    // Wait for duration
    tokio::time::sleep(duration).await;

    // Shutdown: sessions exit when duration elapses, run_session calls conn.close().
    // Apply a global bounded join window (not per-task) to keep teardown deterministic.
    let join_deadline = Instant::now() + JOIN_TIMEOUT;
    while Instant::now() < join_deadline {
        if handles.iter().all(|h| h.is_finished()) {
            break;
        }
        tokio::time::sleep(JOIN_POLL_INTERVAL).await;
    }

    // If any tasks are still alive after the global timeout, abort them.
    if handles.iter().any(|h| !h.is_finished()) {
        eprintln!("load-client: warning: task join timed out; aborting remaining tasks");
        for h in &handles {
            if !h.is_finished() {
                h.abort();
            }
        }
    }

    // Drain joins quickly so task resources are reclaimed before runtime shutdown.
    for h in handles {
        let _ = tokio::time::timeout(JOIN_ABORT_WAIT, h).await;
    }

    // Don't call endpoint.close() — wtransport panics if connections are still alive.

    let ok = counters.sessions_ok.load(Ordering::Relaxed);
    let err = counters.sessions_err.load(Ordering::Relaxed);
    let dg_sent = counters.datagrams_sent.load(Ordering::Relaxed);
    let dg_err = counters.datagrams_err.load(Ordering::Relaxed);
    let st_open = counters.streams_opened.load(Ordering::Relaxed);
    let st_err = counters.streams_err.load(Ordering::Relaxed);

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

async fn run_session(
    conn: wtransport::Connection,
    duration: Duration,
    datagrams_per_sec: u64,
    streams_per_sec: u64,
    counters: &Counters,
) {
    let start = Instant::now();
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

    let payload = b"load";

    while start.elapsed() < duration {
        tokio::select! {
            _ = conn.closed() => break,
            _ = dg_ticker.tick() => {
                if conn.send_datagram(payload).is_ok() {
                    counters.datagrams_sent.fetch_add(1, Ordering::Relaxed);
                } else {
                    counters.datagrams_err.fetch_add(1, Ordering::Relaxed);
                }
            }
            _ = st_ticker.tick() => {
                match conn.open_uni().await {
                    Ok(opening) => match opening.await {
                        Ok(mut send) => {
                            if send.write_all(payload).await.is_ok() {
                                counters.streams_opened.fetch_add(1, Ordering::Relaxed);
                            }
                        }
                        Err(e) => {
                            counters.streams_err.fetch_add(1, Ordering::Relaxed);
                            eprintln!("load-client: open_uni await failed: {e}");
                        }
                    },
                    Err(e) => {
                        counters.streams_err.fetch_add(1, Ordering::Relaxed);
                        eprintln!("load-client: open_uni failed: {e}");
                    }
                }
            }
        }
    }
    // Shutdown state machine: stop (loop exited) → close → wait-for-closed (timeout).
    conn.close(0u32.into(), b"load test done");
    let _ = tokio::time::timeout(CLOSE_TIMEOUT, conn.closed()).await;
}

#[cfg(test)]
mod tests {
    use super::parse_or_default;

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
}
