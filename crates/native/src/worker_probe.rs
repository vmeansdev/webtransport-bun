//! Per-thread accounting for the tokio-parallelism investigation.
//!
//! Three questions, one mechanism.
//!
//! **Did the arms differ?** An A/B on the runtime's worker count is worthless
//! unless the arms can be shown to have really run differently. Echoing back the
//! configured number proves nothing: it is the same value the harness passed in.
//! What proves it is observing that datagrams were processed on more than one OS
//! thread, and how the work divided between them.
//!
//! **Which thread is pinned?** The process burns ~2.1 cores with one worker, and
//! only two threads can be doing the work — the single `wt-server` tokio worker
//! and Bun's JS thread. If the JS thread is the saturated one, adding tokio
//! workers cannot help. `performance.eventLoopUtilization()` is a stub returning
//! zeroes under Bun, so each thread reads its own `CLOCK_THREAD_CPUTIME_ID`
//! instead: the tokio workers from the datagram path, the JS thread from the
//! N-API getter, which by definition runs on it.
//!
//! **Does the rate limiter contend?** `try_acquire_datagram_ingress` takes a
//! mutex keyed by peer IP, so on loopback every session shares one bucket and
//! every worker contends for it per datagram. `time_rate_limit` measures how
//! much of each thread's time goes in there.
//!
//! Counting costs a thread-local read plus a relaxed increment on a counter no
//! other thread writes. The two clock reads per datagram that the timing adds
//! are not free at 60k/s, so they are off unless
//! `WEBTRANSPORT_WORKER_PROBE_TIMING` is set, and the throughput arms run
//! without them.

use once_cell::sync::Lazy;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

/// How often a thread refreshes its own CPU clock, in datagrams. Reading it per
/// datagram would be a syscall-ish cost on the hot path for no extra fidelity.
const CPU_REFRESH_EVERY: u64 = 1024;

#[derive(Default)]
pub(crate) struct ThreadCounters {
    pub datagrams: AtomicU64,
    pub cpu_nanos: AtomicU64,
    pub rate_limit_nanos: AtomicU64,
    pub rate_limit_calls: AtomicU64,
}

type Slot = (String, Arc<ThreadCounters>);

/// Registered once per thread that ever touches the datagram path, so the lock
/// is contended only during the first few datagrams of a run.
static SLOTS: Lazy<Mutex<Vec<Slot>>> = Lazy::new(|| Mutex::new(Vec::new()));

/// Opt-in, because the timing itself costs two clock reads per datagram.
pub(crate) static TIMING_ENABLED: Lazy<bool> = Lazy::new(|| {
    std::env::var("WEBTRANSPORT_WORKER_PROBE_TIMING")
        .map(|v| !v.trim().is_empty() && v.trim() != "0")
        .unwrap_or(false)
});

thread_local! {
    static MY_SLOT: Arc<ThreadCounters> = register_current_thread();
}

/// This thread's own consumed CPU time, user plus system.
///
/// `CLOCK_THREAD_CPUTIME_ID` is per-thread by definition, which is the whole
/// point: a process-wide figure cannot say which thread is hot.
pub(crate) fn thread_cpu_nanos() -> u64 {
    // SAFETY: clock_gettime writes a timespec we own; the clock id is a constant.
    unsafe {
        let mut ts: libc::timespec = std::mem::zeroed();
        if libc::clock_gettime(libc::CLOCK_THREAD_CPUTIME_ID, &mut ts) != 0 {
            return 0;
        }
        (ts.tv_sec as u64)
            .saturating_mul(1_000_000_000)
            .saturating_add(ts.tv_nsec as u64)
    }
}

fn register_current_thread() -> Arc<ThreadCounters> {
    let counters = Arc::new(ThreadCounters::default());
    let current = std::thread::current();
    let label = format!("{}#{:?}", current.name().unwrap_or("unnamed"), current.id());
    if let Ok(mut slots) = SLOTS.lock() {
        slots.push((label, counters.clone()));
    }
    counters
}

/// Register the calling thread and record its CPU time now.
///
/// The N-API getter calls this so Bun's JS thread appears in the table even
/// though it never touches the datagram path itself.
pub(crate) fn record_current_thread_cpu() {
    let _ = MY_SLOT.try_with(|counters| {
        counters
            .cpu_nanos
            .store(thread_cpu_nanos(), Ordering::Relaxed);
    });
}

/// Called once per datagram accepted off the wire, on whichever worker thread
/// polled the session task.
pub(crate) fn record_datagram() {
    let _ = MY_SLOT.try_with(|counters| {
        let seen = counters.datagrams.fetch_add(1, Ordering::Relaxed) + 1;
        if seen % CPU_REFRESH_EVERY == 0 {
            counters
                .cpu_nanos
                .store(thread_cpu_nanos(), Ordering::Relaxed);
        }
    });
}

/// Run the datagram rate-limit check, attributing its wall time to this thread.
///
/// The bucket mutex is keyed by peer IP, so every loopback session shares one,
/// and this is where multiple workers would serialise against each other.
pub(crate) fn time_rate_limit<T>(f: impl FnOnce() -> T) -> T {
    if !*TIMING_ENABLED {
        return f();
    }
    let started = Instant::now();
    let out = f();
    let elapsed = started.elapsed().as_nanos() as u64;
    let _ = MY_SLOT.try_with(|counters| {
        counters
            .rate_limit_nanos
            .fetch_add(elapsed, Ordering::Relaxed);
        counters.rate_limit_calls.fetch_add(1, Ordering::Relaxed);
    });
    out
}

pub(crate) struct ThreadSample {
    pub label: String,
    pub datagrams: u64,
    pub cpu_nanos: u64,
    pub rate_limit_nanos: u64,
    pub rate_limit_calls: u64,
}

pub(crate) fn snapshot() -> Vec<ThreadSample> {
    let Ok(slots) = SLOTS.lock() else {
        return Vec::new();
    };
    slots
        .iter()
        .map(|(label, counters)| ThreadSample {
            label: label.clone(),
            datagrams: counters.datagrams.load(Ordering::Relaxed),
            cpu_nanos: counters.cpu_nanos.load(Ordering::Relaxed),
            rate_limit_nanos: counters.rate_limit_nanos.load(Ordering::Relaxed),
            rate_limit_calls: counters.rate_limit_calls.load(Ordering::Relaxed),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_land_on_the_recording_thread() {
        record_datagram();
        record_datagram();
        let mine = format!("{:?}", std::thread::current().id());
        let entry = snapshot()
            .into_iter()
            .find(|s| s.label.ends_with(&mine))
            .expect("current thread registers a slot on first record");
        assert!(entry.datagrams >= 2);
    }

    #[test]
    fn separate_threads_get_separate_slots() {
        let other = std::thread::spawn(|| {
            record_datagram();
            format!("{:?}", std::thread::current().id())
        })
        .join()
        .unwrap();
        let matching: Vec<_> = snapshot()
            .into_iter()
            .filter(|s| s.label.ends_with(&other))
            .collect();
        assert_eq!(matching.len(), 1, "one slot per thread");
        assert_eq!(matching[0].datagrams, 1);
    }

    #[test]
    fn the_thread_cpu_clock_advances_with_work() {
        let before = thread_cpu_nanos();
        let mut acc = 0u64;
        for i in 0..2_000_000u64 {
            acc = acc.wrapping_add(i * 3);
        }
        assert!(acc > 0);
        assert!(
            thread_cpu_nanos() > before,
            "CLOCK_THREAD_CPUTIME_ID must advance while this thread burns CPU"
        );
    }

    #[test]
    fn rate_limit_timing_is_transparent_when_disabled() {
        // Default build: the wrapper must pass the value through untouched and
        // record nothing, so the throughput arms are unaffected.
        assert!(!*TIMING_ENABLED, "timing must be opt-in");
        assert_eq!(time_rate_limit(|| 7), 7);
        let mine = format!("{:?}", std::thread::current().id());
        let entry = snapshot().into_iter().find(|s| s.label.ends_with(&mine));
        assert_eq!(entry.map(|s| s.rate_limit_calls).unwrap_or(0), 0);
    }
}
