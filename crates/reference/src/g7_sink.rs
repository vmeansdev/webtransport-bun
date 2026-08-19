//! Gate G7's sink: the peer for a server that originates.
//!
//! Every other axis in this effort points the load client *at* the server. G7
//! reverses it — the server is the byte source — so this binary connects,
//! then reads:
//!
//! * **bulk**: accepts the server's unidirectional streams and reads each to
//!   its end. The VOD/distribution shape.
//! * **tokens**: opens one bidirectional stream per session, writes a short
//!   prompt, and reads the fixed-size token records the server writes back,
//!   decoding a 28-byte stamp out of each one. The LLM shape.
//!
//! Why the sink is Rust: it isolates the *server's send path* from any JS
//! receive cost, which is the whole question. What that costs the claim is
//! recorded in the registration (§2.3): nothing here describes a Bun receiver.
//!
//! One-way latency is `arrival − actual`, both read from `CLOCK_MONOTONIC`,
//! which is one system-wide counter on Linux and is read by FFI on the Bun
//! side. The measurement is only meaningful on one box, which is where the
//! registration puts it.

// Shared instrumentation: this binary reads stamps and never writes them, so
// the writing half of the module is unused here and that is not a defect.
#[allow(dead_code)]
mod latency_probe;

use latency_probe::{monotonic_ns, read_stamp, AtomicHistogram, STAMP_BYTES};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use wtransport::ClientConfig;
use wtransport::Endpoint;

const DEFAULT_URL: &str = "https://127.0.0.1:4433";
const CLOSE_TIMEOUT: Duration = Duration::from_secs(5);
/// After the server's drive window ends, how long to keep reading so a stream
/// still draining is not counted as an incomplete one.
const DRAIN_GRACE: Duration = Duration::from_secs(3);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SinkMode {
    Bulk,
    Tokens,
}

#[derive(Default)]
struct Counters {
    sessions_ok: AtomicU64,
    sessions_err: AtomicU64,
    streams_accepted: AtomicU64,
    streams_completed: AtomicU64,
    streams_err: AtomicU64,
    bytes_read: AtomicU64,
    reads: AtomicU64,
    records: AtomicU64,
    stamps_decoded: AtomicU64,
    stamps_undecodable: AtomicU64,
    sequence_gaps: AtomicU64,
    out_of_order: AtomicU64,
    /// Reads that carried more than one token record: those records share one
    /// arrival instant, which is a disclosure on the one-way distribution.
    coalesced_reads: AtomicU64,
    udp_rx_datagrams: AtomicU64,
    udp_rx_bytes: AtomicU64,
}

struct Options {
    url: String,
    sessions: usize,
    duration: Duration,
    mode: SinkMode,
    /// Bulk only: how many uni streams each session should see. Reported, never
    /// enforced — a shortfall is the server's finding, not the sink's.
    expect_streams_per_session: usize,
    /// Connect stagger. G1's lesson and T02's CONFIRMED mechanism: a
    /// synchronized fleet measures the arrival impulse, not the shape.
    stagger_ms: u64,
    /// Token record size, which must match the server's write size exactly.
    record_bytes: usize,
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
                eprintln!("g7-sink: invalid value for {flag} ('{v}'): {e}; using default");
                default
            }
        },
        None => default,
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let mut opts = Options {
        url: DEFAULT_URL.to_string(),
        sessions: 4,
        duration: Duration::from_secs(60),
        mode: SinkMode::Bulk,
        expect_streams_per_session: 4,
        stagger_ms: 0,
        record_bytes: 40,
    };

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--url" => opts.url = args.next().unwrap_or_else(|| DEFAULT_URL.to_string()),
            "--sessions" => opts.sessions = parse_or_default("--sessions", args.next(), 4),
            "--duration" => {
                let secs = parse_or_default("--duration", args.next(), 60u64);
                opts.duration = Duration::from_secs(secs);
            }
            "--mode" => {
                opts.mode = match args.next().as_deref() {
                    Some("tokens") => SinkMode::Tokens,
                    Some("bulk") | None => SinkMode::Bulk,
                    Some(other) => {
                        eprintln!("g7-sink: invalid --mode '{other}'; using bulk");
                        SinkMode::Bulk
                    }
                }
            }
            "--streams-per-session" => {
                opts.expect_streams_per_session =
                    parse_or_default("--streams-per-session", args.next(), 4)
            }
            "--stagger-ms" => opts.stagger_ms = parse_or_default("--stagger-ms", args.next(), 0u64),
            "--record-bytes" => {
                opts.record_bytes = parse_or_default("--record-bytes", args.next(), 40)
            }
            other => eprintln!("g7-sink: ignoring unknown argument '{other}'"),
        }
    }

    if opts.record_bytes < STAMP_BYTES {
        return Err(format!(
            "--record-bytes {} is below the {STAMP_BYTES}-byte stamp: every record must carry one",
            opts.record_bytes
        )
        .into());
    }

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    runtime.block_on(run(opts))
}

async fn run(opts: Options) -> Result<(), Box<dyn std::error::Error>> {
    let counters = Arc::new(Counters::default());
    let one_way = Arc::new(AtomicHistogram::new());

    // One endpoint, one UDP socket, many sessions — the load client's shape, so
    // the sink's own socket accounting matches every other axis on this rig.
    let endpoint = Arc::new(Endpoint::client(
        ClientConfig::builder()
            .with_bind_default()
            .with_no_cert_validation()
            .build(),
    )?);

    // The conductor needs this to attribute per-socket kernel drops: on a
    // loopback rig `/proc/net/snmp` is host-wide and sums both processes, so
    // the receive-side clause can only be computed against the sink's own
    // socket, found by its local port.
    match endpoint.local_addr() {
        Ok(addr) => println!("g7-sink-local-port: {}", addr.port()),
        Err(e) => eprintln!("g7-sink: local_addr unavailable: {e}"),
    }

    let started_ns = monotonic_ns();
    let mut handles = Vec::with_capacity(opts.sessions);
    let stagger = Duration::from_millis(opts.stagger_ms);
    for index in 0..opts.sessions {
        if !stagger.is_zero() {
            tokio::time::sleep(stagger).await;
        }
        let url = opts.url.clone();
        let endpoint = Arc::clone(&endpoint);
        let counters = Arc::clone(&counters);
        let one_way = Arc::clone(&one_way);
        let mode = opts.mode;
        let duration = opts.duration;
        let record_bytes = opts.record_bytes;
        handles.push(tokio::spawn(async move {
            let conn = match endpoint.connect(&url).await {
                Ok(conn) => conn,
                Err(e) => {
                    counters.sessions_err.fetch_add(1, Ordering::Relaxed);
                    eprintln!("g7-sink: session {index} connect failed: {e}");
                    return;
                }
            };
            counters.sessions_ok.fetch_add(1, Ordering::Relaxed);
            match mode {
                SinkMode::Bulk => drain_uni_streams(&conn, duration, Arc::clone(&counters)).await,
                SinkMode::Tokens => {
                    read_token_stream(
                        &conn,
                        duration,
                        record_bytes,
                        counters.as_ref(),
                        one_way.as_ref(),
                    )
                    .await
                }
            }
            record_udp_stats(&conn, counters.as_ref());
            conn.close(0u32.into(), b"g7 sink done");
            let _ = tokio::time::timeout(CLOSE_TIMEOUT, conn.closed()).await;
        }));
    }

    for handle in handles {
        let _ = handle.await;
    }

    let elapsed_ns = monotonic_ns() - started_ns;
    println!(
        "g7-sink-summary: {}",
        summary_json(&opts, &counters, &one_way, elapsed_ns)
    );
    Ok(())
}

/// Bulk: accept every unidirectional stream the server opens and read it to
/// its end. Nothing is written back — the arm measures one direction.
async fn drain_uni_streams(
    conn: &wtransport::Connection,
    duration: Duration,
    counters: Arc<Counters>,
) {
    let deadline = tokio::time::Instant::now() + duration + DRAIN_GRACE;
    let mut readers = Vec::new();
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            break;
        }
        match tokio::time::timeout(remaining, conn.accept_uni()).await {
            Err(_) => break,
            Ok(Err(_)) => break,
            Ok(Ok(mut recv)) => {
                counters.streams_accepted.fetch_add(1, Ordering::Relaxed);
                let counters = Arc::clone(&counters);
                readers.push(tokio::spawn(async move {
                    // 256 KiB: one shipped per-stream governor's worth, so the
                    // read buffer is never the thing that fragments an arrival.
                    let mut buf = vec![0u8; 256 * 1024];
                    loop {
                        match recv.read(&mut buf).await {
                            Ok(Some(n)) => {
                                counters.bytes_read.fetch_add(n as u64, Ordering::Relaxed);
                                counters.reads.fetch_add(1, Ordering::Relaxed);
                            }
                            Ok(None) => {
                                counters.streams_completed.fetch_add(1, Ordering::Relaxed);
                                break;
                            }
                            Err(e) => {
                                counters.streams_err.fetch_add(1, Ordering::Relaxed);
                                eprintln!("g7-sink: uni read failed: {e}");
                                break;
                            }
                        }
                    }
                }));
            }
        }
    }
    for reader in readers {
        let _ = reader.await;
    }
}

/// Tokens: open the request stream, then read fixed-size records off the
/// response half.
///
/// Records are fixed-size and reassembled by length, because a stream is a byte
/// stream: a token may arrive split across two reads or two tokens may arrive
/// in one. The arrival instant is taken once per read and attributed to every
/// record it carried — `coalesced_reads` counts how often that happened, since
/// it is a (small, disclosed) flattening of the one-way distribution.
async fn read_token_stream(
    conn: &wtransport::Connection,
    duration: Duration,
    record_bytes: usize,
    counters: &Counters,
    one_way: &AtomicHistogram,
) {
    let (mut send, mut recv) = match conn.open_bi().await {
        Ok(opening) => match opening.await {
            Ok(pair) => pair,
            Err(e) => {
                counters.streams_err.fetch_add(1, Ordering::Relaxed);
                eprintln!("g7-sink: bidi open await failed: {e}");
                return;
            }
        },
        Err(e) => {
            counters.streams_err.fetch_add(1, Ordering::Relaxed);
            eprintln!("g7-sink: bidi open failed: {e}");
            return;
        }
    };
    counters.streams_accepted.fetch_add(1, Ordering::Relaxed);
    if let Err(e) = send.write_all(b"g7:prompt").await {
        counters.streams_err.fetch_add(1, Ordering::Relaxed);
        eprintln!("g7-sink: prompt write failed: {e}");
        return;
    }

    let deadline = tokio::time::Instant::now() + duration + DRAIN_GRACE;
    let mut buf = vec![0u8; 64 * 1024];
    let mut carry: Vec<u8> = Vec::with_capacity(record_bytes * 2);
    let mut expected_sequence: Option<u64> = None;

    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            break;
        }
        let read = tokio::time::timeout(remaining, recv.read(&mut buf)).await;
        let arrival_ns = monotonic_ns();
        match read {
            Err(_) => break,
            Ok(Err(e)) => {
                counters.streams_err.fetch_add(1, Ordering::Relaxed);
                eprintln!("g7-sink: token read failed: {e}");
                break;
            }
            Ok(Ok(None)) => {
                counters.streams_completed.fetch_add(1, Ordering::Relaxed);
                break;
            }
            Ok(Ok(Some(n))) => {
                counters.reads.fetch_add(1, Ordering::Relaxed);
                carry.extend_from_slice(&buf[..n]);
                let mut records_this_read = 0u64;
                while carry.len() >= record_bytes {
                    let record: Vec<u8> = carry.drain(..record_bytes).collect();
                    records_this_read += 1;
                    counters.records.fetch_add(1, Ordering::Relaxed);
                    match read_stamp(&record) {
                        Some(stamp) => {
                            counters.stamps_decoded.fetch_add(1, Ordering::Relaxed);
                            one_way.record_signed(arrival_ns as i64 - stamp.actual_ns as i64);
                            match expected_sequence {
                                Some(expected) if stamp.sequence == expected => {}
                                Some(expected) if stamp.sequence > expected => {
                                    counters.sequence_gaps.fetch_add(1, Ordering::Relaxed);
                                }
                                Some(_) => {
                                    counters.out_of_order.fetch_add(1, Ordering::Relaxed);
                                }
                                None => {}
                            }
                            expected_sequence = Some(stamp.sequence + 1);
                        }
                        None => {
                            counters.stamps_undecodable.fetch_add(1, Ordering::Relaxed);
                        }
                    }
                }
                if records_this_read > 1 {
                    counters.coalesced_reads.fetch_add(1, Ordering::Relaxed);
                }
            }
        }
    }
}

fn record_udp_stats(conn: &wtransport::Connection, counters: &Counters) {
    let stats = conn.quic_connection().stats();
    counters
        .udp_rx_datagrams
        .fetch_add(stats.udp_rx.datagrams, Ordering::Relaxed);
    counters
        .udp_rx_bytes
        .fetch_add(stats.udp_rx.bytes, Ordering::Relaxed);
}

fn summary_json(
    opts: &Options,
    counters: &Counters,
    one_way: &AtomicHistogram,
    elapsed_ns: u64,
) -> String {
    let load = |c: &AtomicU64| c.load(Ordering::Relaxed);
    format!(
        concat!(
            "{{\"mode\":\"{}\",\"sessions\":{},\"expectStreamsPerSession\":{},",
            "\"recordBytes\":{},\"elapsedSec\":{:.6},",
            "\"sessionsOk\":{},\"sessionsErr\":{},",
            "\"streamsAccepted\":{},\"streamsCompleted\":{},\"streamsErr\":{},",
            "\"bytesRead\":{},\"reads\":{},\"records\":{},",
            "\"stampsDecoded\":{},\"stampsUndecodable\":{},",
            "\"sequenceGaps\":{},\"outOfOrder\":{},\"coalescedReads\":{},",
            "\"udpRxDatagrams\":{},\"udpRxBytes\":{},\"oneWay\":{}}}"
        ),
        match opts.mode {
            SinkMode::Bulk => "bulk",
            SinkMode::Tokens => "tokens",
        },
        opts.sessions,
        opts.expect_streams_per_session,
        opts.record_bytes,
        elapsed_ns as f64 / 1e9,
        load(&counters.sessions_ok),
        load(&counters.sessions_err),
        load(&counters.streams_accepted),
        load(&counters.streams_completed),
        load(&counters.streams_err),
        load(&counters.bytes_read),
        load(&counters.reads),
        load(&counters.records),
        load(&counters.stamps_decoded),
        load(&counters.stamps_undecodable),
        load(&counters.sequence_gaps),
        load(&counters.out_of_order),
        load(&counters.coalesced_reads),
        load(&counters.udp_rx_datagrams),
        load(&counters.udp_rx_bytes),
        one_way.to_samples_json()
    )
}
