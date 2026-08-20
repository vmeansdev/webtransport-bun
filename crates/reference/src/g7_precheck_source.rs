//! G7's sink pre-check source: the honest originator PF1 has never had.
//!
//! `tools/load/g7-plan.ts` ships `evaluatePreflight` — the *evaluator* for the
//! PF1 report — but nothing in the tree ever produced a report for it to read.
//! PF1 was therefore a clause with no instrument. This binary is that
//! instrument's originating half.
//!
//! It is a wtransport **server** that drives `g7-sink` at whatever rate the
//! path will carry, so the rate the sink achieves is the sink's ceiling and not
//! the source's. That is deliberate and is the whole design:
//!
//! * **Unpaced.** A paced source measures the pacer. PF1 asks whether the sink
//!   *can* sustain a rate, which is a ceiling question, so the source writes as
//!   fast as flow control allows and the sink's achieved rate is the answer.
//! * **The target is only a shortfall test.** `--target-bytes-per-sec` and
//!   `--target-events-per-sec` never throttle anything. They exist so the
//!   source can report, in its own summary, that *it* failed to generate the
//!   demanded offer — K16's rule that a pre-check whose source could not source
//!   its own offer is a failure and not a pass.
//! * **The real read path, both arms.** Bulk opens server-side uni streams;
//!   tokens answers the sink's bidi stream with stamped fixed-size records. The
//!   sink runs its shipped code either way: no stub, no discard-before-read.
//!
//! This binary is a measurement instrument. It is not the product, it borrows
//! nothing from the addon, and no gate clause reads it — the only consumer is
//! `tools/load/g7-precheck.ts`, which turns its summary plus the sink's into
//! the `PreflightReport` the gate's own evaluator grades.

// Shared instrumentation: this binary writes stamps and never reads them, so
// the reading half of the module is unused here and that is not a defect.
#[allow(dead_code)]
mod latency_probe;

use latency_probe::{monotonic_ns, write_stamp, STAMP_BYTES};
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use wtransport::endpoint::IncomingSession;
use wtransport::Endpoint;
use wtransport::Identity;
use wtransport::ServerConfig;

const DEFAULT_PORT: u16 = 4491;
/// How long to wait for `--expect-sessions` to arrive before driving anyway.
/// A short ramp is not a failure; a missing fleet is, and the summary says so.
const CONNECT_WALL: Duration = Duration::from_secs(60);
/// Polling grain for the connect barrier. Well under the ramp it waits on.
const BARRIER_POLL: Duration = Duration::from_millis(20);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SourceMode {
    Bulk,
    Tokens,
}

#[derive(Default)]
struct Counters {
    sessions_accepted: AtomicU64,
    sessions_err: AtomicU64,
    streams_opened: AtomicU64,
    streams_err: AtomicU64,
    /// Application-level write calls: the crossing count, and the unit PF1's
    /// event bar is expressed in.
    writes: AtomicU64,
    bytes_written: AtomicU64,
}

struct Options {
    mode: SourceMode,
    port: u16,
    duration: Duration,
    write_bytes: usize,
    streams_per_session: usize,
    expect_sessions: usize,
    target_bytes_per_sec: f64,
    target_events_per_sec: f64,
}

fn parse_or_default<T>(flag: &str, raw: Option<String>, default: T) -> T
where
    T: FromStr + std::fmt::Display + Copy,
{
    match raw {
        None => {
            eprintln!("g7-precheck-source: {flag} needs a value; using {default}");
            default
        }
        Some(v) => match v.parse::<T>() {
            Ok(parsed) => parsed,
            Err(_) => {
                eprintln!("g7-precheck-source: {flag} '{v}' did not parse; using {default}");
                default
            }
        },
    }
}

fn parse_args() -> Result<Options, Box<dyn std::error::Error>> {
    let mut opts = Options {
        mode: SourceMode::Bulk,
        port: DEFAULT_PORT,
        duration: Duration::from_secs(20),
        write_bytes: 64 * 1024,
        streams_per_session: 4,
        expect_sessions: 4,
        target_bytes_per_sec: 0.0,
        target_events_per_sec: 0.0,
    };
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--mode" => {
                let raw = args.next().unwrap_or_default();
                opts.mode = match raw.as_str() {
                    "bulk" => SourceMode::Bulk,
                    "tokens" => SourceMode::Tokens,
                    other => {
                        eprintln!("g7-precheck-source: invalid --mode '{other}'; using bulk");
                        SourceMode::Bulk
                    }
                };
            }
            "--port" => opts.port = parse_or_default("--port", args.next(), DEFAULT_PORT),
            "--duration" => {
                let secs = parse_or_default("--duration", args.next(), 20u64);
                opts.duration = Duration::from_secs(secs);
            }
            "--write-bytes" => {
                opts.write_bytes = parse_or_default("--write-bytes", args.next(), 64 * 1024)
            }
            "--streams-per-session" => {
                opts.streams_per_session =
                    parse_or_default("--streams-per-session", args.next(), 4)
            }
            "--expect-sessions" => {
                opts.expect_sessions = parse_or_default("--expect-sessions", args.next(), 4)
            }
            "--target-bytes-per-sec" => {
                opts.target_bytes_per_sec =
                    parse_or_default("--target-bytes-per-sec", args.next(), 0.0)
            }
            "--target-events-per-sec" => {
                opts.target_events_per_sec =
                    parse_or_default("--target-events-per-sec", args.next(), 0.0)
            }
            other => eprintln!("g7-precheck-source: ignoring unknown argument '{other}'"),
        }
    }
    if opts.mode == SourceMode::Tokens && opts.write_bytes < STAMP_BYTES {
        return Err(format!(
            "--write-bytes {} is below the {STAMP_BYTES}-byte stamp: every token record carries one",
            opts.write_bytes
        )
        .into());
    }
    if opts.write_bytes == 0 {
        return Err("--write-bytes 0 writes nothing and measures nothing".into());
    }
    Ok(opts)
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let opts = parse_args()?;
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    runtime.block_on(run(opts))
}

async fn run(opts: Options) -> Result<(), Box<dyn std::error::Error>> {
    let counters = Arc::new(Counters::default());
    let driving = Arc::new(AtomicBool::new(false));
    let stop = Arc::new(AtomicBool::new(false));

    let identity = Identity::self_signed(["localhost", "127.0.0.1", "::1"])?;
    let config = ServerConfig::builder()
        .with_bind_default(opts.port)
        .with_identity(identity)
        .build();
    let server = Endpoint::server(config)?;

    // The driver reads both of these before it starts sampling: the port to
    // point the sink at, and one bracket of the clock check PF2 grades.
    println!("g7-precheck-source-port: {}", server.local_addr()?.port());
    println!("g7-precheck-source-clock-start: {}", monotonic_ns());

    let acceptor = {
        let counters = Arc::clone(&counters);
        let driving = Arc::clone(&driving);
        let stop = Arc::clone(&stop);
        let mode = opts.mode;
        let write_bytes = opts.write_bytes;
        let streams_per_session = opts.streams_per_session;
        tokio::spawn(async move {
            loop {
                let incoming = server.accept().await;
                let counters = Arc::clone(&counters);
                let driving = Arc::clone(&driving);
                let stop = Arc::clone(&stop);
                tokio::spawn(async move {
                    serve_session(
                        incoming,
                        mode,
                        write_bytes,
                        streams_per_session,
                        counters,
                        driving,
                        stop,
                    )
                    .await;
                });
            }
        })
    };

    // Connect barrier: the drive window starts when the fleet is up, so the
    // achieved rate is divided by the interval the sink was actually being
    // driven and not by the ramp. A fleet that never arrives drives anyway and
    // the summary reports how many did — an under-populated pre-check is a
    // disclosed fact, not a silent one.
    let barrier_started = monotonic_ns();
    let mut connect_wall_expired = false;
    while counters.sessions_accepted.load(Ordering::Relaxed) < opts.expect_sessions as u64 {
        if Duration::from_nanos(monotonic_ns() - barrier_started) >= CONNECT_WALL {
            connect_wall_expired = true;
            break;
        }
        tokio::time::sleep(BARRIER_POLL).await;
    }
    let sessions_at_drive_start = counters.sessions_accepted.load(Ordering::Relaxed);
    let connect_ramp_ns = monotonic_ns() - barrier_started;

    // Counters are read at both edges of the window, so sessions that connected
    // during the ramp contribute no writes to the measured rate.
    let writes_at_start = counters.writes.load(Ordering::Relaxed);
    let bytes_at_start = counters.bytes_written.load(Ordering::Relaxed);
    let drive_started = monotonic_ns();
    driving.store(true, Ordering::Relaxed);
    tokio::time::sleep(opts.duration).await;
    stop.store(true, Ordering::Relaxed);
    let drive_ns = monotonic_ns() - drive_started;
    let writes = counters.writes.load(Ordering::Relaxed) - writes_at_start;
    let bytes = counters.bytes_written.load(Ordering::Relaxed) - bytes_at_start;

    acceptor.abort();

    let drive_sec = drive_ns as f64 / 1e9;
    let bytes_per_sec = if drive_sec > 0.0 {
        bytes as f64 / drive_sec
    } else {
        0.0
    };
    let events_per_sec = if drive_sec > 0.0 {
        writes as f64 / drive_sec
    } else {
        0.0
    };

    // K16, mechanised on the source's own side: the source declares whether it
    // sourced its own offer. The driver copies this verbatim into
    // `sourceShortfall`; it does not re-derive it.
    let byte_shortfall = opts.target_bytes_per_sec > 0.0 && bytes_per_sec < opts.target_bytes_per_sec;
    let event_shortfall =
        opts.target_events_per_sec > 0.0 && events_per_sec < opts.target_events_per_sec;
    let session_shortfall = sessions_at_drive_start < opts.expect_sessions as u64;

    println!("g7-precheck-source-clock-end: {}", monotonic_ns());
    println!(
        "g7-precheck-source-summary: {}",
        summary_json(
            &opts,
            &counters,
            SummaryWindow {
                drive_sec,
                connect_ramp_sec: connect_ramp_ns as f64 / 1e9,
                sessions_at_drive_start,
                writes,
                bytes,
                bytes_per_sec,
                events_per_sec,
                byte_shortfall,
                event_shortfall,
                session_shortfall,
                connect_wall_expired,
            }
        )
    );
    Ok(())
}

async fn serve_session(
    incoming: IncomingSession,
    mode: SourceMode,
    write_bytes: usize,
    streams_per_session: usize,
    counters: Arc<Counters>,
    driving: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
) {
    let request = match incoming.await {
        Ok(request) => request,
        Err(e) => {
            counters.sessions_err.fetch_add(1, Ordering::Relaxed);
            eprintln!("g7-precheck-source: session request failed: {e}");
            return;
        }
    };
    let connection = match request.accept().await {
        Ok(connection) => connection,
        Err(e) => {
            counters.sessions_err.fetch_add(1, Ordering::Relaxed);
            eprintln!("g7-precheck-source: session accept failed: {e}");
            return;
        }
    };
    counters.sessions_accepted.fetch_add(1, Ordering::Relaxed);

    match mode {
        SourceMode::Bulk => {
            for _ in 0..streams_per_session {
                let connection = connection.clone();
                let counters = Arc::clone(&counters);
                let driving = Arc::clone(&driving);
                let stop = Arc::clone(&stop);
                tokio::spawn(async move {
                    drive_uni_stream(&connection, write_bytes, counters, driving, stop).await;
                });
            }
        }
        SourceMode::Tokens => {
            let counters = Arc::clone(&counters);
            let driving = Arc::clone(&driving);
            let stop = Arc::clone(&stop);
            tokio::spawn(async move {
                drive_token_stream(&connection, write_bytes, counters, driving, stop).await;
            });
        }
    }
}

/// Wait out the connect barrier without burning a core on it.
async fn await_drive(driving: &AtomicBool, stop: &AtomicBool) -> bool {
    while !driving.load(Ordering::Relaxed) {
        if stop.load(Ordering::Relaxed) {
            return false;
        }
        tokio::time::sleep(BARRIER_POLL).await;
    }
    true
}

/// Bulk: one server-opened uni stream, written flat out until the window ends.
/// The stream is finished so the sink's `streamsCompleted` closes.
async fn drive_uni_stream(
    connection: &wtransport::Connection,
    write_bytes: usize,
    counters: Arc<Counters>,
    driving: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
) {
    let mut send = match connection.open_uni().await {
        Ok(opening) => match opening.await {
            Ok(send) => send,
            Err(e) => {
                counters.streams_err.fetch_add(1, Ordering::Relaxed);
                eprintln!("g7-precheck-source: uni open await failed: {e}");
                return;
            }
        },
        Err(e) => {
            counters.streams_err.fetch_add(1, Ordering::Relaxed);
            eprintln!("g7-precheck-source: uni open failed: {e}");
            return;
        }
    };
    counters.streams_opened.fetch_add(1, Ordering::Relaxed);
    if !await_drive(&driving, &stop).await {
        return;
    }

    let payload = vec![0xa7u8; write_bytes];
    while !stop.load(Ordering::Relaxed) {
        match send.write_all(&payload).await {
            Ok(()) => {
                counters.writes.fetch_add(1, Ordering::Relaxed);
                counters
                    .bytes_written
                    .fetch_add(write_bytes as u64, Ordering::Relaxed);
            }
            Err(e) => {
                counters.streams_err.fetch_add(1, Ordering::Relaxed);
                eprintln!("g7-precheck-source: uni write failed: {e}");
                return;
            }
        }
    }
    if let Err(e) = send.finish().await {
        eprintln!("g7-precheck-source: uni finish failed: {e}");
    }
}

/// Tokens: answer the sink's bidi stream with stamped fixed-size records,
/// written flat out. Every record carries a v1 stamp, so the sink runs its
/// whole record path — reassemble by length, decode, sequence-check — which is
/// the per-event cost PF1's event bar is about.
async fn drive_token_stream(
    connection: &wtransport::Connection,
    record_bytes: usize,
    counters: Arc<Counters>,
    driving: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
) {
    let (mut send, mut recv) = match connection.accept_bi().await {
        Ok(pair) => pair,
        Err(e) => {
            counters.streams_err.fetch_add(1, Ordering::Relaxed);
            eprintln!("g7-precheck-source: bidi accept failed: {e}");
            return;
        }
    };
    counters.streams_opened.fetch_add(1, Ordering::Relaxed);

    // The sink writes "g7:prompt" before it reads. Consuming it keeps the
    // request half from filling and stalling the session.
    let mut prompt = vec![0u8; 64];
    if let Err(e) = recv.read(&mut prompt).await {
        eprintln!("g7-precheck-source: prompt read failed: {e}");
    }
    if !await_drive(&driving, &stop).await {
        return;
    }

    let mut record = vec![0u8; record_bytes];
    let mut sequence: u64 = 0;
    while !stop.load(Ordering::Relaxed) {
        let now = monotonic_ns();
        // Unpaced, so there is no separate intended instant: the record was due
        // when it was written. The sink's one-way reading is not what PF1
        // grades — the stamp is here to make the sink pay the decode cost.
        write_stamp(&mut record, now, now, sequence);
        match send.write_all(&record).await {
            Ok(()) => {
                sequence += 1;
                counters.writes.fetch_add(1, Ordering::Relaxed);
                counters
                    .bytes_written
                    .fetch_add(record_bytes as u64, Ordering::Relaxed);
            }
            Err(e) => {
                counters.streams_err.fetch_add(1, Ordering::Relaxed);
                eprintln!("g7-precheck-source: token write failed: {e}");
                return;
            }
        }
    }
    if let Err(e) = send.finish().await {
        eprintln!("g7-precheck-source: token finish failed: {e}");
    }
}

struct SummaryWindow {
    drive_sec: f64,
    connect_ramp_sec: f64,
    sessions_at_drive_start: u64,
    writes: u64,
    bytes: u64,
    bytes_per_sec: f64,
    events_per_sec: f64,
    byte_shortfall: bool,
    event_shortfall: bool,
    session_shortfall: bool,
    connect_wall_expired: bool,
}

fn summary_json(opts: &Options, counters: &Counters, w: SummaryWindow) -> String {
    let load = |c: &AtomicU64| c.load(Ordering::Relaxed);
    format!(
        concat!(
            "{{\"mode\":\"{}\",\"writeBytes\":{},\"streamsPerSession\":{},",
            "\"expectSessions\":{},\"sessionsAtDriveStart\":{},",
            "\"sessionsAccepted\":{},\"sessionsErr\":{},",
            "\"streamsOpened\":{},\"streamsErr\":{},",
            "\"driveSec\":{:.6},\"connectRampSec\":{:.6},\"connectWallExpired\":{},",
            "\"writes\":{},\"bytesWritten\":{},",
            "\"bytesPerSec\":{:.3},\"eventsPerSec\":{:.3},",
            "\"targetBytesPerSec\":{:.3},\"targetEventsPerSec\":{:.3},",
            "\"byteShortfall\":{},\"eventShortfall\":{},\"sessionShortfall\":{}}}"
        ),
        match opts.mode {
            SourceMode::Bulk => "bulk",
            SourceMode::Tokens => "tokens",
        },
        opts.write_bytes,
        opts.streams_per_session,
        opts.expect_sessions,
        w.sessions_at_drive_start,
        load(&counters.sessions_accepted),
        load(&counters.sessions_err),
        load(&counters.streams_opened),
        load(&counters.streams_err),
        w.drive_sec,
        w.connect_ramp_sec,
        w.connect_wall_expired,
        w.writes,
        w.bytes,
        w.bytes_per_sec,
        w.events_per_sec,
        opts.target_bytes_per_sec,
        opts.target_events_per_sec,
        w.byte_shortfall,
        w.event_shortfall,
        w.session_shortfall
    )
}
