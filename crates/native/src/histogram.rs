//! Latency histograms for SLO observability (P3.1).
//! Fixed buckets in seconds; Prometheus-compatible cumulative counts.

use std::sync::atomic::{AtomicU64, Ordering};

/// Bucket upper bounds in seconds (Prometheus le values). +Inf implied.
pub const BUCKETS: [f64; 12] = [
    0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0,
];

/// Atomic latency histogram. Thread-safe; observe() increments cumulative bucket counters.
pub struct LatencyHistogram {
    buckets: [AtomicU64; 12],
    count: AtomicU64,
    sum: AtomicU64, // stored as nanos for precision, converted to seconds on snapshot
}

impl Default for LatencyHistogram {
    fn default() -> Self {
        Self {
            buckets: std::array::from_fn(|_| AtomicU64::new(0)),
            count: AtomicU64::new(0),
            sum: AtomicU64::new(0),
        }
    }
}

impl LatencyHistogram {
    /// Record a duration. Increments all buckets where le >= duration_secs (cumulative).
    pub fn observe(&self, duration: std::time::Duration) {
        let secs = duration.as_secs_f64();
        let nanos = duration.as_nanos().min(u64::MAX as u128) as u64;
        self.count.fetch_add(1, Ordering::Relaxed);
        self.sum.fetch_add(nanos, Ordering::Relaxed);
        for (i, &le) in BUCKETS.iter().enumerate() {
            if secs <= le {
                self.buckets[i].fetch_add(1, Ordering::Relaxed);
            }
        }
    }

    /// Cumulative counts per bucket (indices match BUCKETS). Last bucket = total count.
    pub fn cumulative_counts(&self) -> [u64; 12] {
        std::array::from_fn(|i| self.buckets[i].load(Ordering::Relaxed))
    }

    pub fn count(&self) -> u64 {
        self.count.load(Ordering::Relaxed)
    }

    pub fn sum_nanos(&self) -> u64 {
        self.sum.load(Ordering::Relaxed)
    }

    pub fn sum_secs(&self) -> f64 {
        self.sum_nanos() as f64 / 1_000_000_000.0
    }
}
