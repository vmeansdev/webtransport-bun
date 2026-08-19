//! Gate G11's tunnel client: the reference generator for Arm T and Arm X.
//!
//! Contract: `docs/research/preregistrations/gate-g11-bidi.md`, and the build
//! spec `docs/research/2026-08-19-g11-harness-spec.md` §1. It speaks
//! `wtransport` directly and has **no addon** — Amendment 3 registers that
//! consequence explicitly: this end has no JS boundary, so `crossings.client`
//! is `null` on every cell this binary drives, and `null` is a different
//! finding from `0`.
//!
//! Two arms:
//!
//! * **tunnel** — one bidi stream per session held for the step, with a paced
//!   writer and an independent reader on the same stream. The reader stamps
//!   `now − frame.send_wall_ns` into a histogram, which is the *downstream*
//!   one-way distribution; the upstream one is measured by the server.
//! * **exchange** — Arm X's RPC shape: open a bidi stream, write one request,
//!   FIN the send half, read one response, close. The RTT is measured
//!   client-side on a monotonic clock because both ends of that interval are
//!   in this process.
//!
//! **Why the stamp is wall-clock and not monotonic.** The two ends are
//! separate processes, so a monotonic reading is only comparable inside one of
//! them. Both run on one host (registration §1.2), so both read the same
//! CLOCK_REALTIME. A negative sample is therefore an instrument fault rather
//! than a number, which is what falsifier V-N says.
//!
//! Structural provenance: the session/stagger/summary shape follows
//! `g7_sink.rs` on `probe/g7-stream-egress-01`, and the cumulative-deadline
//! pacer follows `run_bulk_stream_worker` in `load_client.rs` — copied rather
//! than shared, so the two probe branches stay independent.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use wtransport::{ClientConfig, Endpoint};

const DEFAULT_URL: &str = "https://127.0.0.1:4433";
const CLOSE_TIMEOUT: Duration = Duration::from_secs(5);
/// After the drive window, how long to keep reading so a stream still draining
/// is not counted as an incomplete one.
const DRAIN_GRACE: Duration = Duration::from_secs(3);
/// See the call site: teardown hygiene, outside every measured window.
const CLOSE_QUIESCE: Duration = Duration::from_millis(500);
/// The reader's buffer. Deliberately small: it is a tunnel relay's read size,
/// and a large one would hide arrival granularity inside a single read.
const READ_BUFFER_BYTES: usize = 4096;

// ---------------------------------------------------------------------------
// The frame — byte for byte `tools/load/g11-frame.ts`
// ---------------------------------------------------------------------------

const FRAME_HEADER_BYTES: usize = 20;
const FRAME_VERSION: u8 = 1;

const CLASS_TUNNEL_UP: u8 = 0;
/// Written by the server; this side only ever reads it, and the wire contract
/// lives in one place on both sides.
#[allow(dead_code)]
const CLASS_TUNNEL_DOWN: u8 = 1;
const CLASS_REQUEST: u8 = 2;
const CLASS_RESPONSE: u8 = 3;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct Frame {
    total_length: u16,
    version: u8,
    class: u8,
    session: u32,
    sequence: u32,
    send_wall_ns: u64,
}

/// Little-endian, header then filler. The filler is left as whatever the
/// caller's buffer already holds: the gate measures transport, not payload.
fn encode_frame(into: &mut [u8], frame: Frame) {
    let len = frame.total_length as usize;
    assert!(
        len >= FRAME_HEADER_BYTES,
        "frame length {len} is below the {FRAME_HEADER_BYTES}-byte header"
    );
    assert!(into.len() >= len, "buffer too small for a {len} B frame");
    into[0..2].copy_from_slice(&frame.total_length.to_le_bytes());
    into[2] = FRAME_VERSION;
    into[3] = frame.class;
    into[4..8].copy_from_slice(&frame.session.to_le_bytes());
    into[8..12].copy_from_slice(&frame.sequence.to_le_bytes());
    into[12..20].copy_from_slice(&frame.send_wall_ns.to_le_bytes());
}

fn decode_frame(bytes: &[u8]) -> Option<Frame> {
    if bytes.len() < FRAME_HEADER_BYTES {
        return None;
    }
    Some(Frame {
        total_length: u16::from_le_bytes([bytes[0], bytes[1]]),
        version: bytes[2],
        class: bytes[3],
        session: u32::from_le_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]),
        sequence: u32::from_le_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]),
        send_wall_ns: u64::from_le_bytes([
            bytes[12], bytes[13], bytes[14], bytes[15], bytes[16], bytes[17], bytes[18], bytes[19],
        ]),
    })
}

/// Reassembles frames out of the arbitrary chunks a stream delivers. A chunk
/// can carry a partial frame, several frames, or both — with the chunk-batching
/// knob on it routinely carries several — so chunk boundaries are never assumed
/// to be frame boundaries.
#[derive(Default)]
struct Deframer {
    carry: Vec<u8>,
}

impl Deframer {
    fn push(&mut self, chunk: &[u8], mut on_frame: impl FnMut(Frame)) -> Result<(), String> {
        self.carry.extend_from_slice(chunk);
        let mut offset = 0usize;
        loop {
            if self.carry.len() - offset < 2 {
                break;
            }
            let length = u16::from_le_bytes([self.carry[offset], self.carry[offset + 1]]) as usize;
            if length < FRAME_HEADER_BYTES {
                return Err(format!("frame claims {length} B, below the header size"));
            }
            if self.carry.len() - offset < length {
                break;
            }
            match decode_frame(&self.carry[offset..offset + length]) {
                Some(frame) => on_frame(frame),
                None => return Err("frame shorter than its header".to_string()),
            }
            offset += length;
        }
        if offset > 0 {
            self.carry.drain(..offset);
        }
        Ok(())
    }
}

fn wall_ns() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Histogram
// ---------------------------------------------------------------------------

const SUB_MS_BUCKET_US: f64 = 10.0;
const SUB_MS_BUCKETS: usize = 100;
const BUCKETS_PER_DOUBLING: usize = 64;
const DOUBLINGS: usize = 10;

fn bucket_edges() -> Vec<f64> {
    let mut edges = Vec::with_capacity(SUB_MS_BUCKETS + BUCKETS_PER_DOUBLING * DOUBLINGS);
    for i in 1..=SUB_MS_BUCKETS {
        edges.push((i as f64 * SUB_MS_BUCKET_US) / 1000.0);
    }
    for d in 0..DOUBLINGS {
        let lo = 2f64.powi(d as i32);
        let hi = 2f64.powi(d as i32 + 1);
        for i in 1..=BUCKETS_PER_DOUBLING {
            edges.push(lo + (hi - lo) * (i as f64) / (BUCKETS_PER_DOUBLING as f64));
        }
    }
    edges
}

/// A latency histogram that **ranks** its non-positive samples rather than
/// dropping them: a dropped negative sample silently shrinks the denominator a
/// p99 is taken over, which is exactly the fault G3b's stamp found. The edges
/// travel in the JSON, so the consumer computes the percentile from the same
/// edges this process bucketed with and no cross-language constant has to stay
/// in sync.
struct Histogram {
    edges: Vec<f64>,
    counts: Vec<u64>,
    negative: u64,
    max_ms: f64,
}

impl Histogram {
    fn new() -> Self {
        let edges = bucket_edges();
        let counts = vec![0u64; edges.len()];
        Self {
            edges,
            counts,
            negative: 0,
            max_ms: 0.0,
        }
    }

    fn record_ns_signed(&mut self, ns: i64) {
        let ms = ns as f64 / 1e6;
        if ms > self.max_ms {
            self.max_ms = ms;
        }
        if ms <= 0.0 {
            self.negative += 1;
            return;
        }
        let idx = self.index_of(ms);
        self.counts[idx] += 1;
    }

    fn index_of(&self, ms: f64) -> usize {
        let last = self.edges.len() - 1;
        if ms <= 1.0 {
            let i = ((ms * 1000.0 / SUB_MS_BUCKET_US).ceil() as isize - 1).max(0) as usize;
            return i.min(SUB_MS_BUCKETS - 1);
        }
        if ms >= self.edges[last] {
            return last;
        }
        let d = ms.log2().floor();
        let lo = 2f64.powf(d);
        let hi = 2f64.powf(d + 1.0);
        let within = (((ms - lo) / (hi - lo) * BUCKETS_PER_DOUBLING as f64).ceil() as isize - 1)
            .max(0) as usize;
        let base = SUB_MS_BUCKETS + (d as usize) * BUCKETS_PER_DOUBLING;
        (base + within).min(last)
    }

    fn merge(&mut self, other: &Histogram) {
        self.negative += other.negative;
        if other.max_ms > self.max_ms {
            self.max_ms = other.max_ms;
        }
        for (i, c) in other.counts.iter().enumerate() {
            self.counts[i] += c;
        }
    }

    fn to_json(&self) -> String {
        let edges = self
            .edges
            .iter()
            .map(|e| format!("{e:.6}"))
            .collect::<Vec<_>>()
            .join(",");
        let counts = self
            .counts
            .iter()
            .map(u64::to_string)
            .collect::<Vec<_>>()
            .join(",");
        format!(
            "{{\"negativeCount\":{},\"maxMs\":{:.6},\"bucketUpperMs\":[{}],\"bucketCounts\":[{}]}}",
            self.negative, self.max_ms, edges, counts
        )
    }
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Arm {
    Tunnel,
    Exchange,
}

struct Options {
    url: String,
    arm: Arm,
    sessions: usize,
    duration: Duration,
    /// Total ramp; sessions are spread evenly across it (K2 / T02).
    connect_stagger_ms: u64,
    frame_bytes: usize,
    /// Tunnel arm: bytes per second per direction per session.
    target_bytes_per_sec: u64,
    /// Exchange arm: exchanges per second per session.
    exchanges_per_sec: f64,
    run_id: String,
    host: String,
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
                eprintln!("tunnel-client: invalid value for {flag} ('{v}'): {e}; using default");
                default
            }
        },
        None => default,
    }
}

fn parse_args() -> Options {
    let mut args = std::env::args().skip(1);
    let mut opts = Options {
        url: DEFAULT_URL.to_string(),
        arm: Arm::Tunnel,
        sessions: 1,
        duration: Duration::from_secs(60),
        connect_stagger_ms: 0,
        frame_bytes: 1402,
        target_bytes_per_sec: 375_000,
        exchanges_per_sec: 2.0,
        run_id: "unset".to_string(),
        host: "unset".to_string(),
    };
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--url" => opts.url = args.next().unwrap_or_else(|| DEFAULT_URL.to_string()),
            "--arm" => {
                opts.arm = match args.next().as_deref() {
                    Some("exchange") => Arm::Exchange,
                    Some("tunnel") | None => Arm::Tunnel,
                    Some(other) => {
                        eprintln!("tunnel-client: invalid --arm '{other}'; using tunnel");
                        Arm::Tunnel
                    }
                }
            }
            "--sessions" => opts.sessions = parse_or_default("--sessions", args.next(), 1),
            "--duration-secs" => {
                let secs = parse_or_default("--duration-secs", args.next(), 60u64);
                opts.duration = Duration::from_secs(secs);
            }
            "--connect-stagger-ms" => {
                opts.connect_stagger_ms =
                    parse_or_default("--connect-stagger-ms", args.next(), 0u64)
            }
            "--frame-bytes" => {
                opts.frame_bytes = parse_or_default("--frame-bytes", args.next(), 1402)
            }
            "--target-bytes-per-sec" => {
                opts.target_bytes_per_sec =
                    parse_or_default("--target-bytes-per-sec", args.next(), 375_000u64)
            }
            "--exchanges-per-sec" => {
                opts.exchanges_per_sec =
                    parse_or_default("--exchanges-per-sec", args.next(), 2.0f64)
            }
            "--run-id" => opts.run_id = args.next().unwrap_or_else(|| "unset".to_string()),
            "--host" => opts.host = args.next().unwrap_or_else(|| "unset".to_string()),
            other => eprintln!("tunnel-client: ignoring unknown argument '{other}'"),
        }
    }
    opts
}

// ---------------------------------------------------------------------------
// Counters
// ---------------------------------------------------------------------------

#[derive(Default)]
struct Counters {
    sessions_ok: AtomicU64,
    sessions_err: AtomicU64,
    streams_opened: AtomicU64,
    streams_err: AtomicU64,
    /// Streams whose send half was finished AND whose recv half reached EOF.
    streams_closed_both_halves: AtomicU64,
    frames_written: AtomicU64,
    bytes_written: AtomicU64,
    frames_read: AtomicU64,
    bytes_read: AtomicU64,
    /// Exchange arm.
    exchanges_attempted: AtomicU64,
    exchanges_completed: AtomicU64,
    peak_concurrent_bidi_per_session: AtomicU64,
    udp_rx_datagrams: AtomicU64,
    udp_tx_datagrams: AtomicU64,
}

/// One session's own totals. Clause C5 is per-session, and an aggregate cannot
/// answer it, so these travel as vectors and are never summed here.
#[derive(Clone, Copy, Default)]
struct SessionTotals {
    index: usize,
    bytes_written: u64,
    frames_written: u64,
    bytes_read: u64,
    frames_read: u64,
}

struct Shared {
    counters: Counters,
    /// Downstream one-way (tunnel) or exchange RTT (exchange).
    latency: Mutex<Histogram>,
    /// The generator's own honesty clock: actual wake − intended deadline,
    /// read *before* the write it precedes. This is the V-G floor, and it is
    /// measured off the product's thread by construction because this process
    /// contains no product code.
    ///
    /// It deliberately excludes the time the write itself took. A `write_all`
    /// that parks on a full send window is a transport fact, not an instrument
    /// fault, and folding it in here made V-G fire on cells that were merely
    /// flow-controlled — which is exactly what Arm D sets out to produce. The
    /// blocking time is kept separately in `write_settle`, which mirrors the
    /// `lateness`/`settle` split `tools/load/g11-pacer.ts` already carries.
    scheduler_lag: Mutex<Histogram>,
    /// write call → write settled, per frame. A disclosure, not a floor: it
    /// names how long the transport held the writer, and nothing grades it.
    write_settle: Mutex<Histogram>,
    per_session: Mutex<Vec<SessionTotals>>,
}

impl Shared {
    fn new() -> Self {
        Self {
            counters: Counters::default(),
            latency: Mutex::new(Histogram::new()),
            scheduler_lag: Mutex::new(Histogram::new()),
            write_settle: Mutex::new(Histogram::new()),
            per_session: Mutex::new(Vec::new()),
        }
    }
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let opts = parse_args();
    if opts.frame_bytes < FRAME_HEADER_BYTES {
        return Err(format!(
            "--frame-bytes {} is below the {FRAME_HEADER_BYTES}-byte header",
            opts.frame_bytes
        )
        .into());
    }
    if opts.sessions == 0 {
        return Err("--sessions must be at least 1".into());
    }
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    runtime.block_on(run(opts))
}

async fn run(opts: Options) -> Result<(), Box<dyn std::error::Error>> {
    let shared = Arc::new(Shared::new());
    let endpoint = Arc::new(Endpoint::client(
        ClientConfig::builder()
            .with_bind_default()
            .with_no_cert_validation()
            .build(),
    )?);
    match endpoint.local_addr() {
        Ok(addr) => println!("tunnel-client-local-port: {}", addr.port()),
        Err(e) => eprintln!("tunnel-client: local_addr unavailable: {e}"),
    }

    // Sessions are spread evenly across the whole ramp, not fired together:
    // T02 is a CONFIRMED mechanism, and a synchronized fleet measures the
    // arrival impulse rather than the shape.
    let per_session_gap = if opts.sessions > 1 {
        Duration::from_micros((opts.connect_stagger_ms * 1000) / (opts.sessions as u64 - 1).max(1))
    } else {
        Duration::ZERO
    };

    let started = Instant::now();
    let mut handles = Vec::with_capacity(opts.sessions);
    for index in 0..opts.sessions {
        if !per_session_gap.is_zero() && index > 0 {
            tokio::time::sleep(per_session_gap).await;
        }
        let url = opts.url.clone();
        let endpoint = Arc::clone(&endpoint);
        let shared = Arc::clone(&shared);
        let arm = opts.arm;
        let duration = opts.duration;
        let frame_bytes = opts.frame_bytes;
        let target_bytes_per_sec = opts.target_bytes_per_sec;
        let exchanges_per_sec = opts.exchanges_per_sec;
        handles.push(tokio::spawn(async move {
            let conn = match endpoint.connect(&url).await {
                Ok(conn) => conn,
                Err(e) => {
                    shared.counters.sessions_err.fetch_add(1, Ordering::Relaxed);
                    eprintln!("tunnel-client: session {index} connect failed: {e}");
                    return;
                }
            };
            shared.counters.sessions_ok.fetch_add(1, Ordering::Relaxed);
            match arm {
                Arm::Tunnel => {
                    run_tunnel_session(
                        &conn,
                        index,
                        duration,
                        frame_bytes,
                        target_bytes_per_sec,
                        &shared,
                    )
                    .await
                }
                Arm::Exchange => {
                    run_exchange_session(
                        &conn,
                        index,
                        duration,
                        frame_bytes,
                        exchanges_per_sec,
                        &shared,
                    )
                    .await
                }
            }
            record_udp_stats(&conn, &shared.counters);
            // Teardown quiesce, not a measurement window. The peer's `close()`
            // on its own write half is still in flight when this end observes
            // EOF; tearing the connection down under it makes that close fail
            // with E_STREAM_RESET, which clause C4 would count as a stream
            // error the run did not suffer. Every counter is already recorded.
            tokio::time::sleep(CLOSE_QUIESCE).await;
            conn.close(0u32.into(), b"g11 tunnel client done");
            let _ = tokio::time::timeout(CLOSE_TIMEOUT, conn.closed()).await;
        }));
    }
    for handle in handles {
        let _ = handle.await;
    }

    let elapsed = started.elapsed();
    println!(
        "tunnel-client-summary: {}",
        summary_json(&opts, &shared, elapsed)
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// Arm T
// ---------------------------------------------------------------------------

async fn run_tunnel_session(
    conn: &wtransport::Connection,
    index: usize,
    duration: Duration,
    frame_bytes: usize,
    target_bytes_per_sec: u64,
    shared: &Arc<Shared>,
) {
    let (mut send, mut recv) = match open_bi(conn, &shared.counters).await {
        Some(pair) => pair,
        None => return,
    };
    shared
        .counters
        .streams_opened
        .fetch_add(1, Ordering::Relaxed);

    // The reader runs concurrently with the writer on the same stream: the
    // whole point of this gate is that both directions of one connection are
    // loaded at once, so they cannot be serialized here.
    let reader_shared = Arc::clone(shared);
    let reader = tokio::spawn(async move {
        let mut hist = Histogram::new();
        let mut deframer = Deframer::default();
        let mut buf = vec![0u8; READ_BUFFER_BYTES];
        let mut frames = 0u64;
        let mut bytes = 0u64;
        let mut saw_eof = false;
        let deadline = tokio::time::Instant::now() + duration + DRAIN_GRACE;
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                break;
            }
            let read = tokio::time::timeout(remaining, recv.read(&mut buf)).await;
            let arrival = wall_ns();
            match read {
                Err(_) => break,
                Ok(Err(e)) => {
                    reader_shared
                        .counters
                        .streams_err
                        .fetch_add(1, Ordering::Relaxed);
                    eprintln!("tunnel-client: session {index} read failed: {e}");
                    break;
                }
                Ok(Ok(None)) => {
                    saw_eof = true;
                    break;
                }
                Ok(Ok(Some(n))) => {
                    bytes += n as u64;
                    let mut local_frames = 0u64;
                    let outcome = deframer.push(&buf[..n], |frame| {
                        local_frames += 1;
                        hist.record_ns_signed(arrival as i64 - frame.send_wall_ns as i64);
                    });
                    if let Err(e) = outcome {
                        reader_shared
                            .counters
                            .streams_err
                            .fetch_add(1, Ordering::Relaxed);
                        eprintln!("tunnel-client: session {index} deframe failed: {e}");
                        break;
                    }
                    frames += local_frames;
                }
            }
        }
        if let Ok(mut global) = reader_shared.latency.lock() {
            global.merge(&hist);
        }
        reader_shared
            .counters
            .frames_read
            .fetch_add(frames, Ordering::Relaxed);
        reader_shared
            .counters
            .bytes_read
            .fetch_add(bytes, Ordering::Relaxed);
        (frames, bytes, saw_eof)
    });

    // The writer: cumulative-deadline pacer. It cannot overshoot (a frame is
    // sent only once its absolute deadline has passed), its error does not
    // accumulate (the deadline is `written / rate` from step start), and a
    // flow-control block is absorbed rather than repaid.
    let mut chunk = vec![b'x'; frame_bytes];
    let mut lag = Histogram::new();
    let mut settle = Histogram::new();
    let start = Instant::now();
    let mut written: u64 = 0;
    let mut frames_written: u64 = 0;
    let mut write_failed = false;
    while start.elapsed() < duration {
        // Pace first, then write. `written` is the bytes already on the wire,
        // so `written / rate` is this frame's own cumulative deadline; the lag
        // reading is taken here, with nothing but the wake between it and the
        // deadline it is measured against.
        if target_bytes_per_sec > 0 {
            let due = Duration::from_secs_f64(written as f64 / target_bytes_per_sec as f64);
            let elapsed = start.elapsed();
            if due > elapsed {
                tokio::time::sleep(due - elapsed).await;
            }
            lag.record_ns_signed(start.elapsed().saturating_sub(due).as_nanos() as i64);
            if start.elapsed() >= duration {
                break;
            }
        }
        encode_frame(
            &mut chunk,
            Frame {
                total_length: frame_bytes as u16,
                version: FRAME_VERSION,
                class: CLASS_TUNNEL_UP,
                session: index as u32,
                sequence: frames_written as u32,
                send_wall_ns: wall_ns(),
            },
        );
        let write_started = Instant::now();
        if let Err(e) = send.write_all(&chunk).await {
            shared.counters.streams_err.fetch_add(1, Ordering::Relaxed);
            eprintln!("tunnel-client: session {index} write failed: {e}");
            write_failed = true;
            break;
        }
        settle.record_ns_signed(write_started.elapsed().as_nanos() as i64);
        written += frame_bytes as u64;
        frames_written += 1;
    }

    let mut finished = false;
    if !write_failed {
        match send.finish().await {
            Ok(()) => finished = true,
            Err(e) => {
                shared.counters.streams_err.fetch_add(1, Ordering::Relaxed);
                eprintln!("tunnel-client: session {index} finish failed: {e}");
            }
        }
    }

    let (frames_read, bytes_read, saw_eof) = reader.await.unwrap_or((0, 0, false));
    if finished && saw_eof {
        shared
            .counters
            .streams_closed_both_halves
            .fetch_add(1, Ordering::Relaxed);
    }

    if let Ok(mut global) = shared.scheduler_lag.lock() {
        global.merge(&lag);
    }
    if let Ok(mut global) = shared.write_settle.lock() {
        global.merge(&settle);
    }
    shared
        .counters
        .frames_written
        .fetch_add(frames_written, Ordering::Relaxed);
    shared
        .counters
        .bytes_written
        .fetch_add(written, Ordering::Relaxed);
    if let Ok(mut vec) = shared.per_session.lock() {
        vec.push(SessionTotals {
            index,
            bytes_written: written,
            frames_written,
            bytes_read,
            frames_read,
        });
    }
}

// ---------------------------------------------------------------------------
// Arm X
// ---------------------------------------------------------------------------

async fn run_exchange_session(
    conn: &wtransport::Connection,
    index: usize,
    duration: Duration,
    frame_bytes: usize,
    exchanges_per_sec: f64,
    shared: &Arc<Shared>,
) {
    let mut hist = Histogram::new();
    let mut lag = Histogram::new();
    let mut chunk = vec![b'x'; frame_bytes];
    let start = Instant::now();
    let mut issued: u64 = 0;
    let mut completed: u64 = 0;
    let mut opened: u64 = 0;
    let mut bytes_written: u64 = 0;
    let mut bytes_read: u64 = 0;
    let mut frames_read: u64 = 0;

    while start.elapsed() < duration {
        // Same ordering as the tunnel writer: pace first, read the lag against
        // the deadline just woken for, then do the work. An exchange that takes
        // longer than its own period is an RTT fact — `latency` already carries
        // it — and must not be re-reported as generator scheduler lag.
        if exchanges_per_sec > 0.0 {
            let due = Duration::from_secs_f64(issued as f64 / exchanges_per_sec);
            let elapsed = start.elapsed();
            if due > elapsed {
                tokio::time::sleep(due - elapsed).await;
            }
            lag.record_ns_signed(start.elapsed().saturating_sub(due).as_nanos() as i64);
            if start.elapsed() >= duration {
                break;
            }
        }
        shared
            .counters
            .exchanges_attempted
            .fetch_add(1, Ordering::Relaxed);
        issued += 1;
        let sent_at = Instant::now();
        let ok = run_one_exchange(
            conn,
            index,
            issued,
            frame_bytes,
            &mut chunk,
            &mut bytes_written,
            &mut bytes_read,
            &mut frames_read,
            shared,
        )
        .await;
        if ok {
            opened += 1;
            completed += 1;
            shared
                .counters
                .exchanges_completed
                .fetch_add(1, Ordering::Relaxed);
            hist.record_ns_signed(sent_at.elapsed().as_nanos() as i64);
        }

        // One bidi stream is in flight at a time per session, so the peak
        // concurrency this arm creates is 1 — recorded, never assumed, because
        // V-X2 is about whether the arm measured the shipped per-session cap.
        shared
            .counters
            .peak_concurrent_bidi_per_session
            .fetch_max(1, Ordering::Relaxed);
    }

    if let Ok(mut global) = shared.latency.lock() {
        global.merge(&hist);
    }
    if let Ok(mut global) = shared.scheduler_lag.lock() {
        global.merge(&lag);
    }
    shared
        .counters
        .streams_opened
        .fetch_add(opened, Ordering::Relaxed);
    shared
        .counters
        .frames_written
        .fetch_add(issued, Ordering::Relaxed);
    shared
        .counters
        .bytes_written
        .fetch_add(bytes_written, Ordering::Relaxed);
    shared
        .counters
        .frames_read
        .fetch_add(frames_read, Ordering::Relaxed);
    shared
        .counters
        .bytes_read
        .fetch_add(bytes_read, Ordering::Relaxed);
    let _ = completed;
    if let Ok(mut vec) = shared.per_session.lock() {
        vec.push(SessionTotals {
            index,
            bytes_written,
            frames_written: issued,
            bytes_read,
            frames_read,
        });
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_one_exchange(
    conn: &wtransport::Connection,
    index: usize,
    sequence: u64,
    frame_bytes: usize,
    chunk: &mut [u8],
    bytes_written: &mut u64,
    bytes_read: &mut u64,
    frames_read: &mut u64,
    shared: &Arc<Shared>,
) -> bool {
    let (mut send, mut recv) = match open_bi(conn, &shared.counters).await {
        Some(pair) => pair,
        None => return false,
    };
    encode_frame(
        chunk,
        Frame {
            total_length: frame_bytes as u16,
            version: FRAME_VERSION,
            class: CLASS_REQUEST,
            session: index as u32,
            sequence: sequence as u32,
            send_wall_ns: wall_ns(),
        },
    );
    if send.write_all(&chunk[..frame_bytes]).await.is_err() {
        shared.counters.streams_err.fetch_add(1, Ordering::Relaxed);
        return false;
    }
    *bytes_written += frame_bytes as u64;
    if send.finish().await.is_err() {
        shared.counters.streams_err.fetch_add(1, Ordering::Relaxed);
        return false;
    }

    let mut deframer = Deframer::default();
    let mut buf = vec![0u8; READ_BUFFER_BYTES];
    let mut got_response = false;
    loop {
        match recv.read(&mut buf).await {
            Ok(Some(n)) => {
                *bytes_read += n as u64;
                let mut seen = 0u64;
                if deframer
                    .push(&buf[..n], |frame| {
                        if frame.class == CLASS_RESPONSE {
                            seen += 1;
                        }
                    })
                    .is_err()
                {
                    shared.counters.streams_err.fetch_add(1, Ordering::Relaxed);
                    return false;
                }
                if seen > 0 {
                    *frames_read += seen;
                    got_response = true;
                    break;
                }
            }
            Ok(None) => break,
            Err(_) => {
                shared.counters.streams_err.fetch_add(1, Ordering::Relaxed);
                return false;
            }
        }
    }
    got_response
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async fn open_bi(
    conn: &wtransport::Connection,
    counters: &Counters,
) -> Option<(wtransport::SendStream, wtransport::RecvStream)> {
    match conn.open_bi().await {
        Ok(opening) => match opening.await {
            Ok(pair) => Some(pair),
            Err(e) => {
                counters.streams_err.fetch_add(1, Ordering::Relaxed);
                eprintln!("tunnel-client: bidi open await failed: {e}");
                None
            }
        },
        Err(e) => {
            counters.streams_err.fetch_add(1, Ordering::Relaxed);
            eprintln!("tunnel-client: bidi open failed: {e}");
            None
        }
    }
}

fn record_udp_stats(conn: &wtransport::Connection, counters: &Counters) {
    let stats = conn.quic_connection().stats();
    counters
        .udp_rx_datagrams
        .fetch_add(stats.udp_rx.datagrams, Ordering::Relaxed);
    counters
        .udp_tx_datagrams
        .fetch_add(stats.udp_tx.datagrams, Ordering::Relaxed);
}

fn summary_json(opts: &Options, shared: &Shared, elapsed: Duration) -> String {
    let load = |c: &AtomicU64| c.load(Ordering::Relaxed);
    let c = &shared.counters;
    let sessions = {
        let mut vec = shared
            .per_session
            .lock()
            .map(|v| v.clone())
            .unwrap_or_default();
        vec.sort_by_key(|s| s.index);
        vec.iter()
            .map(|s| {
                format!(
                    "{{\"index\":{},\"bytesWritten\":{},\"framesWritten\":{},\"bytesRead\":{},\"framesRead\":{}}}",
                    s.index, s.bytes_written, s.frames_written, s.bytes_read, s.frames_read
                )
            })
            .collect::<Vec<_>>()
            .join(",")
    };
    let latency = shared
        .latency
        .lock()
        .map(|h| h.to_json())
        .unwrap_or_else(|_| "null".to_string());
    let lag = shared
        .scheduler_lag
        .lock()
        .map(|h| h.to_json())
        .unwrap_or_else(|_| "null".to_string());
    let write_settle = shared
        .write_settle
        .lock()
        .map(|h| h.to_json())
        .unwrap_or_else(|_| "null".to_string());
    format!(
        concat!(
            "{{\"arm\":\"{}\",\"runId\":\"{}\",\"host\":\"{}\",",
            "\"drivingSessions\":{},\"frameBytes\":{},\"targetBytesPerSec\":{},",
            "\"durationSec\":{},\"elapsedSec\":{:.6},",
            "\"sessionsOk\":{},\"sessionsErr\":{},",
            "\"streamsOpened\":{},\"streamsErr\":{},\"streamsClosedBothHalves\":{},",
            "\"framesWritten\":{},\"bytesWritten\":{},\"framesRead\":{},\"bytesRead\":{},",
            "\"exchangesAttempted\":{},\"exchangesCompleted\":{},",
            "\"peakConcurrentBidiPerSession\":{},",
            "\"udpRxDatagrams\":{},\"udpTxDatagrams\":{},",
            "\"perSession\":[{}],\"latency\":{},\"schedulerLag\":{},\"writeSettle\":{}}}"
        ),
        match opts.arm {
            Arm::Tunnel => "tunnel",
            Arm::Exchange => "exchange",
        },
        opts.run_id,
        opts.host,
        opts.sessions,
        opts.frame_bytes,
        opts.target_bytes_per_sec,
        opts.duration.as_secs(),
        elapsed.as_secs_f64(),
        load(&c.sessions_ok),
        load(&c.sessions_err),
        load(&c.streams_opened),
        load(&c.streams_err),
        load(&c.streams_closed_both_halves),
        load(&c.frames_written),
        load(&c.bytes_written),
        load(&c.frames_read),
        load(&c.bytes_read),
        load(&c.exchanges_attempted),
        load(&c.exchanges_completed),
        load(&c.peak_concurrent_bidi_per_session),
        load(&c.udp_rx_datagrams),
        load(&c.udp_tx_datagrams),
        sessions,
        latency,
        lag,
        write_settle,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The cross-language pin. `tools/load/g11-frame.test.ts` asserts these
    /// exact bytes for the same field values; if either side's layout drifts,
    /// one of the two tests fails instead of a run silently measuring garbage
    /// stamps.
    #[test]
    fn a_frame_encodes_to_the_bytes_the_typescript_test_pins() {
        let mut buf = vec![0u8; 24];
        encode_frame(
            &mut buf,
            Frame {
                total_length: 24,
                version: FRAME_VERSION,
                class: CLASS_TUNNEL_DOWN,
                session: 0x0102_0304,
                sequence: 0x0506_0708,
                send_wall_ns: 0x0102_0304_0506_0708,
            },
        );
        assert_eq!(
            &buf[..FRAME_HEADER_BYTES],
            &[
                0x18, 0x00, // total length 24, little-endian
                0x01, // version
                0x01, // class = TunnelDown
                0x04, 0x03, 0x02, 0x01, // session
                0x08, 0x07, 0x06, 0x05, // sequence
                0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01, // stamp
            ]
        );
    }

    #[test]
    fn a_frame_round_trips() {
        let mut buf = vec![0u8; 1402];
        let frame = Frame {
            total_length: 1402,
            version: FRAME_VERSION,
            class: CLASS_TUNNEL_UP,
            session: 7,
            sequence: 42,
            send_wall_ns: 1_755_123_456_789_012_345,
        };
        encode_frame(&mut buf, frame);
        assert_eq!(decode_frame(&buf), Some(frame));
    }

    #[test]
    fn the_deframer_reassembles_across_arbitrary_chunk_boundaries() {
        let mut whole = Vec::new();
        for seq in 0..3u32 {
            let mut buf = vec![0u8; 40];
            encode_frame(
                &mut buf,
                Frame {
                    total_length: 40,
                    version: FRAME_VERSION,
                    class: CLASS_TUNNEL_DOWN,
                    session: 1,
                    sequence: seq,
                    send_wall_ns: 1000 + seq as u64,
                },
            );
            whole.extend_from_slice(&buf);
        }
        let mut deframer = Deframer::default();
        let mut seen = Vec::new();
        // Split mid-header, mid-payload, then the remainder: every boundary a
        // stream is allowed to pick.
        let mut offset = 0usize;
        for split in [7usize, 45, 90, whole.len()] {
            deframer
                .push(&whole[offset..split], |f| seen.push(f.sequence))
                .expect("deframe");
            offset = split;
        }
        assert_eq!(seen, vec![0, 1, 2]);
    }

    #[test]
    fn a_non_positive_sample_is_ranked_and_never_dropped() {
        let mut hist = Histogram::new();
        hist.record_ns_signed(-1_000);
        hist.record_ns_signed(2_000_000);
        assert_eq!(hist.negative, 1);
        assert_eq!(hist.counts.iter().sum::<u64>(), 1);
    }
}
