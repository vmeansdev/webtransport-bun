//! Per-worker-thread datagram accounting for the tokio-parallelism investigation.
//!
//! An A/B on the server runtime's worker count is worthless unless the arms can
//! be shown to have really run differently. Echoing back the configured number
//! proves nothing: it is the same value the harness passed in. What proves it is
//! observing that datagrams were processed on more than one OS thread, and how
//! the work divided between them.
//!
//! The hot-path cost is a thread-local read plus a relaxed increment on a
//! counter no other thread writes, so this does not itself serialise anything.

use once_cell::sync::Lazy;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

type Slot = (String, Arc<AtomicU64>);

/// Registered once per thread that ever touches the datagram path, so the lock
/// is contended only during the first few datagrams of a run.
static SLOTS: Lazy<Mutex<Vec<Slot>>> = Lazy::new(|| Mutex::new(Vec::new()));

thread_local! {
    static MY_SLOT: Arc<AtomicU64> = register_current_thread();
}

fn register_current_thread() -> Arc<AtomicU64> {
    let counter = Arc::new(AtomicU64::new(0));
    let current = std::thread::current();
    let label = format!("{}#{:?}", current.name().unwrap_or("unnamed"), current.id());
    if let Ok(mut slots) = SLOTS.lock() {
        slots.push((label, counter.clone()));
    }
    counter
}

/// Called once per datagram accepted off the wire, on whichever worker thread
/// polled the session task.
pub(crate) fn record_datagram() {
    let _ = MY_SLOT.try_with(|counter| {
        counter.fetch_add(1, Ordering::Relaxed);
    });
}

pub(crate) fn snapshot() -> Vec<(String, u64)> {
    let Ok(slots) = SLOTS.lock() else {
        return Vec::new();
    };
    slots
        .iter()
        .map(|(label, counter)| (label.clone(), counter.load(Ordering::Relaxed)))
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
            .find(|(label, _)| label.ends_with(&mine))
            .expect("current thread registers a slot on first record");
        assert!(entry.1 >= 2);
    }

    #[test]
    fn separate_threads_get_separate_slots() {
        let other = std::thread::spawn(|| {
            record_datagram();
            format!("{:?}", std::thread::current().id())
        })
        .join()
        .unwrap();
        let counts = snapshot();
        let matching: Vec<_> = counts
            .iter()
            .filter(|(label, _)| label.ends_with(&other))
            .collect();
        assert_eq!(matching.len(), 1, "one slot per thread");
        assert_eq!(matching[0].1, 1);
    }
}
