//! Receive-only WebTransport server with a configurable tokio worker count.
//!
//! The control for the parallelism investigation. The addon's receive rate
//! plateaus near 62k datagrams/s no matter how many tokio workers it is given,
//! while using under 4 of this host's 10 cores — a serialisation point rather
//! than a CPU limit. Two candidates remain: quinn's single endpoint driver over
//! one UDP socket, and the single-threaded N-API/JS delivery hop.
//!
//! This binary is the same quinn + wtransport stack with the second candidate
//! deleted: no addon, no N-API, no JS. If it plateaus at the same rate, the
//! ceiling is in the transport. If it goes materially higher, the ceiling is
//! the delivery hop.
//!
//! It measures the same way the TS harness does — warmup, then a fixed window —
//! and prints one JSON line so the driver can treat both identically.

use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use wtransport::{Endpoint, Identity, ServerConfig};

struct Args {
    port: u16,
    workers: usize,
    warmup_secs: u64,
    measure_secs: u64,
}

fn parse_args() -> Args {
    let mut args = Args {
        port: 4433,
        workers: 1,
        warmup_secs: 5,
        measure_secs: 20,
    };
    let mut argv = std::env::args().skip(1);
    while let Some(flag) = argv.next() {
        let value = argv.next();
        let need = |what: &str| -> String {
            value.clone().unwrap_or_else(|| {
                eprintln!("recv-floor-server: {flag} requires {what}");
                std::process::exit(2);
            })
        };
        match flag.as_str() {
            "--port" => args.port = need("a port").parse().expect("--port must be a u16"),
            // "auto" resolves the same way the addon's env knob does, so the two
            // sides of the comparison mean the same thing by the same word.
            "--workers" => {
                let raw = need("a count or \"auto\"");
                args.workers = if raw == "auto" {
                    std::thread::available_parallelism()
                        .map(|n| n.get())
                        .unwrap_or(1)
                } else {
                    raw.parse().expect("--workers must be a count or \"auto\"")
                };
            }
            "--warmup" => args.warmup_secs = need("seconds").parse().expect("--warmup"),
            "--measure" => args.measure_secs = need("seconds").parse().expect("--measure"),
            other => {
                eprintln!("recv-floor-server: unknown flag {other}");
                std::process::exit(2);
            }
        }
    }
    assert!(args.workers >= 1, "--workers must be at least 1");
    args
}

thread_local! {
    static THREAD_REGISTERED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Record that this OS thread polled a datagram, once per thread.
///
/// Taking the lock per datagram would add a contended mutex to the very hot
/// path this binary exists to measure, which would bias the control against the
/// parallelism it is testing for.
fn note_thread(threads: &Mutex<HashSet<String>>) {
    if THREAD_REGISTERED.with(std::cell::Cell::get) {
        return;
    }
    THREAD_REGISTERED.with(|flag| flag.set(true));
    if let Ok(mut seen) = threads.lock() {
        seen.insert(format!("{:?}", std::thread::current().id()));
    }
}

/// Process CPU time in seconds, both user and system, across every thread.
fn cpu_seconds() -> f64 {
    // SAFETY: getrusage writes a plain POD struct we fully own; RUSAGE_SELF
    // needs no other state.
    unsafe {
        let mut usage: libc::rusage = std::mem::zeroed();
        if libc::getrusage(libc::RUSAGE_SELF, &mut usage) != 0 {
            return f64::NAN;
        }
        let secs = |t: libc::timeval| t.tv_sec as f64 + t.tv_usec as f64 / 1_000_000.0;
        secs(usage.ru_utime) + secs(usage.ru_stime)
    }
}

fn main() {
    let args = parse_args();
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(args.workers)
        .enable_all()
        .thread_name("recv-floor")
        .build()
        .expect("failed to build runtime");
    runtime.block_on(run(args));
}

async fn run(args: Args) {
    let received = Arc::new(AtomicU64::new(0));
    let bytes = Arc::new(AtomicU64::new(0));
    let sessions = Arc::new(AtomicU64::new(0));
    // Which OS threads actually polled datagrams — the same proof the addon
    // harness demands, so a worker count that silently did nothing is visible
    // here too.
    let threads: Arc<Mutex<HashSet<String>>> = Arc::new(Mutex::new(HashSet::new()));

    let identity =
        Identity::self_signed(["localhost", "127.0.0.1", "::1"]).expect("self-signed identity");
    let config = ServerConfig::builder()
        .with_bind_default(args.port)
        .with_identity(identity)
        .build();
    let server = Endpoint::server(config).expect("bind endpoint");
    println!(
        "recv-floor-server: listening on {} with {} worker(s)",
        server.local_addr().expect("local addr"),
        args.workers
    );

    let accept_received = received.clone();
    let accept_bytes = bytes.clone();
    let accept_sessions = sessions.clone();
    let accept_threads = threads.clone();
    tokio::spawn(async move {
        loop {
            let incoming = server.accept().await;
            let received = accept_received.clone();
            let bytes = accept_bytes.clone();
            let sessions = accept_sessions.clone();
            let threads = accept_threads.clone();
            tokio::spawn(async move {
                let Ok(request) = incoming.await else { return };
                let Ok(connection) = request.accept().await else {
                    return;
                };
                sessions.fetch_add(1, Ordering::Relaxed);
                // Receive-only, exactly like the addon arm: an echo would put the
                // send path in the measurement.
                while let Ok(datagram) = connection.receive_datagram().await {
                    received.fetch_add(1, Ordering::Relaxed);
                    bytes.fetch_add(datagram.len() as u64, Ordering::Relaxed);
                    note_thread(&threads);
                }
            });
        }
    });

    tokio::time::sleep(Duration::from_secs(args.warmup_secs)).await;
    let rx0 = received.load(Ordering::Relaxed);
    let bytes0 = bytes.load(Ordering::Relaxed);
    let cpu0 = cpu_seconds();
    let t0 = Instant::now();
    tokio::time::sleep(Duration::from_secs(args.measure_secs)).await;
    let window = t0.elapsed().as_secs_f64();
    let rx1 = received.load(Ordering::Relaxed);
    let bytes1 = bytes.load(Ordering::Relaxed);
    let cpu1 = cpu_seconds();
    let datagram_threads = threads.lock().expect("thread set").len();

    println!(
        "__SERVER_RESULT__{{\"received\":{},\"receivedBytes\":{},\"windowMs\":{:.3},\
         \"receivedPerSec\":{:.3},\"serverCpuCores\":{:.4},\"configuredWorkers\":{},\
         \"datagramThreads\":{},\"sessionsAccepted\":{}}}",
        rx1 - rx0,
        bytes1 - bytes0,
        window * 1000.0,
        (rx1 - rx0) as f64 / window,
        (cpu1 - cpu0) / window,
        args.workers,
        datagram_threads,
        sessions.load(Ordering::Relaxed),
    );
}
