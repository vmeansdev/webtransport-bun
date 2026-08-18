//! Latency instrumentation shared by the load client and anything that needs to
//! stamp datagrams with a clock the Bun server can also read.
//!
//! Two pieces, both deliberately small so a different axis can reuse them:
//!
//! * [`monotonic_ns`] — a raw `CLOCK_MONOTONIC` read. `std::time::Instant` is
//!   the same clock on Linux but hides its value, and a one-way measurement
//!   across two processes needs the value, not a duration.
//! * [`AtomicHistogram`] — a lock-free log-linear histogram whose bucketing is
//!   byte-for-byte the same as `tools/load/latency-histogram.ts`, so client and
//!   server percentiles are computed by identical arithmetic and can be diffed
//!   without an apology.
//!
//! The stamp layout is fixed by `docs/research/preregistrations/latency.md`.

use std::sync::atomic::{AtomicU64, Ordering};

/// Read `CLOCK_MONOTONIC` in nanoseconds. Same counter the Bun side reads
/// through `bun:ffi`, which is the whole reason one-way latency is meaningful.
pub fn monotonic_ns() -> u64 {
    let mut ts = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    // SAFETY: `ts` is a valid, fully initialized timespec we own for the call.
    let rc = unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut ts) };
    assert_eq!(rc, 0, "clock_gettime(CLOCK_MONOTONIC) failed");
    (ts.tv_sec as u64) * 1_000_000_000 + (ts.tv_nsec as u64)
}

pub const STAMP_MAGIC: u16 = 0x4c54; // "LT"
pub const STAMP_VERSION: u16 = 1;
pub const STAMP_BYTES: usize = 28;

const OFFSET_INTENDED: usize = 4;
const OFFSET_ACTUAL: usize = 12;
const OFFSET_SEQUENCE: usize = 20;

/// Write the 28-byte header in place. The caller owns the padding beyond it.
pub fn write_stamp(buf: &mut [u8], intended_ns: u64, actual_ns: u64, sequence: u64) {
    debug_assert!(buf.len() >= STAMP_BYTES);
    buf[0..2].copy_from_slice(&STAMP_MAGIC.to_le_bytes());
    buf[2..4].copy_from_slice(&STAMP_VERSION.to_le_bytes());
    buf[OFFSET_INTENDED..OFFSET_INTENDED + 8].copy_from_slice(&intended_ns.to_le_bytes());
    buf[OFFSET_ACTUAL..OFFSET_ACTUAL + 8].copy_from_slice(&actual_ns.to_le_bytes());
    buf[OFFSET_SEQUENCE..OFFSET_SEQUENCE + 8].copy_from_slice(&sequence.to_le_bytes());
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Stamp {
    pub intended_ns: u64,
    pub actual_ns: u64,
    pub sequence: u64,
}

/// Decode a stamp, or `None` when the datagram is not one of ours — a probe
/// frame, a short payload, a version we don't speak.
pub fn read_stamp(buf: &[u8]) -> Option<Stamp> {
    if buf.len() < STAMP_BYTES {
        return None;
    }
    let magic = u16::from_le_bytes([buf[0], buf[1]]);
    let version = u16::from_le_bytes([buf[2], buf[3]]);
    if magic != STAMP_MAGIC || version != STAMP_VERSION {
        return None;
    }
    let read = |at: usize| {
        let mut octets = [0u8; 8];
        octets.copy_from_slice(&buf[at..at + 8]);
        u64::from_le_bytes(octets)
    };
    Some(Stamp {
        intended_ns: read(OFFSET_INTENDED),
        actual_ns: read(OFFSET_ACTUAL),
        sequence: read(OFFSET_SEQUENCE),
    })
}

const SUB_BITS: u32 = 8;
const SUB: u64 = 1 << SUB_BITS; // 256
const MAX_OCTAVE: u32 = 45;
/// Must equal `HISTOGRAM_BUCKETS` in `tools/load/latency-histogram.ts`.
pub const BUCKETS: usize = ((MAX_OCTAVE - SUB_BITS + 1) as usize + 1) * SUB as usize;

fn bucket_index(ns: u64) -> usize {
    if ns < SUB {
        return ns as usize;
    }
    let octave = 63 - ns.leading_zeros();
    if octave > MAX_OCTAVE {
        return BUCKETS - 1;
    }
    let scale = 1u64 << (octave - SUB_BITS);
    let sub = (ns / scale) - SUB;
    ((octave - SUB_BITS + 1) as usize) * SUB as usize + sub as usize
}

/// Shared across every session task. Relaxed adds on a 9984-slot array: the
/// contention is real but it is nanoseconds against a path that already costs
/// microseconds, and it stays off the critical section a mutex would create.
pub struct AtomicHistogram {
    counts: Vec<AtomicU64>,
    total: AtomicU64,
    negative: AtomicU64,
    min: AtomicU64,
    max: AtomicU64,
    sum: AtomicU64,
}

impl Default for AtomicHistogram {
    fn default() -> Self {
        Self::new()
    }
}

impl AtomicHistogram {
    pub fn new() -> Self {
        Self {
            counts: (0..BUCKETS).map(|_| AtomicU64::new(0)).collect(),
            total: AtomicU64::new(0),
            negative: AtomicU64::new(0),
            min: AtomicU64::new(u64::MAX),
            max: AtomicU64::new(0),
            sum: AtomicU64::new(0),
        }
    }

    /// Record a signed delta. Negatives are counted separately rather than
    /// clamped: a negative one-way latency is a broken clock assumption, and
    /// hiding it as a zero would turn a void run into a good-looking one.
    pub fn record_signed(&self, delta_ns: i64) {
        if delta_ns < 0 {
            self.negative.fetch_add(1, Ordering::Relaxed);
            return;
        }
        self.record(delta_ns as u64);
    }

    pub fn record(&self, ns: u64) {
        self.counts[bucket_index(ns)].fetch_add(1, Ordering::Relaxed);
        self.total.fetch_add(1, Ordering::Relaxed);
        self.sum.fetch_add(ns, Ordering::Relaxed);
        self.min.fetch_min(ns, Ordering::Relaxed);
        self.max.fetch_max(ns, Ordering::Relaxed);
    }

    /// The exact JSON shape `LatencyHistogram.fromJson` consumes, so the client
    /// histogram and the server histogram are read by one implementation.
    ///
    /// Sparse: 9,984 slots of which a step fills a few hundred. The bucketing is
    /// stamped into the document so a fragment written by one build can never be
    /// read as if it came from another.
    ///
    /// `count` is the sum of the buckets this very pass emitted, never the
    /// separate `total` counter. `record` is five independent relaxed atomics,
    /// so a snapshot taken while sessions are still sending can see a `total`
    /// that its bucket array does not support — and a percentile reader given a
    /// rank its buckets cannot reach walks off the end and reports the maximum.
    /// The counter is still published as `recordedTotal`: equal to `count` for a
    /// quiesced producer, and the size of the gap is the evidence when it isn't.
    /// `minNs`/`maxNs`/`sumNs` are loaded after the sweep and may belong to a
    /// marginally later instant; no pre-registered rule reads them.
    pub fn to_json(&self) -> String {
        let mut buckets = String::with_capacity(1024);
        buckets.push('[');
        let mut written = 0usize;
        let mut summed = 0u64;
        for (i, slot) in self.counts.iter().enumerate() {
            let count = slot.load(Ordering::Relaxed);
            if count == 0 {
                continue;
            }
            if written > 0 {
                buckets.push(',');
            }
            buckets.push_str(&format!("[{i},{count}]"));
            written += 1;
            summed += count;
        }
        buckets.push(']');
        let total = self.total.load(Ordering::Relaxed);
        let min = if summed == 0 {
            0
        } else {
            self.min.load(Ordering::Relaxed)
        };
        format!(
            concat!(
                "{{\"version\":2,\"subBits\":{},\"maxOctave\":{},\"buckets\":{},",
                "\"count\":{},\"recordedTotal\":{},\"negative\":{},",
                "\"minNs\":{},\"maxNs\":{},\"sumNs\":{}}}"
            ),
            SUB_BITS,
            MAX_OCTAVE,
            buckets,
            summed,
            total,
            self.negative.load(Ordering::Relaxed),
            min,
            self.max.load(Ordering::Relaxed),
            self.sum.load(Ordering::Relaxed)
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn monotonic_clock_advances() {
        let a = monotonic_ns();
        std::thread::sleep(std::time::Duration::from_millis(5));
        let b = monotonic_ns();
        assert!(b > a, "monotonic clock went backwards: {a} -> {b}");
        assert!(b - a >= 4_000_000, "slept 5ms but only {}ns passed", b - a);
    }

    #[test]
    fn stamp_round_trips_past_u32() {
        let mut buf = [0u8; 64];
        write_stamp(
            &mut buf,
            1_234_567_890_123,
            1_234_567_899_999,
            8_589_934_593,
        );
        assert_eq!(
            read_stamp(&buf),
            Some(Stamp {
                intended_ns: 1_234_567_890_123,
                actual_ns: 1_234_567_899_999,
                sequence: 8_589_934_593,
            })
        );
    }

    #[test]
    fn stamp_rejects_foreign_payloads() {
        assert_eq!(read_stamp(&[0u8; STAMP_BYTES - 1]), None);
        let mut buf = [0u8; STAMP_BYTES];
        write_stamp(&mut buf, 1, 2, 3);
        assert!(read_stamp(&buf).is_some());
        buf[0] ^= 0xff;
        assert_eq!(read_stamp(&buf), None);
    }

    /// The Rust and TypeScript bucketings must agree, or the client RTT curve
    /// and the server ingest curve are drawn on different graph paper.
    #[test]
    fn bucket_layout_matches_the_typescript_side() {
        assert_eq!(BUCKETS, 9984);
        assert_eq!(bucket_index(0), 0);
        assert_eq!(bucket_index(255), 255);
        assert_eq!(bucket_index(256), 256);
        assert_eq!(bucket_index(257), 257);
        assert_eq!(bucket_index(512), 512);
        assert_eq!(bucket_index(u64::MAX), BUCKETS - 1);
        // 0.4% is the resolution the pre-registered 0.2 ms A/B band needs at a
        // tens-of-milliseconds p99.
        for ns in [1_000u64, 15_625_000, 33_300_000, 1_000_000_000] {
            let idx = bucket_index(ns);
            let octave = 63 - ns.leading_zeros();
            let scale = 1u64 << (octave - SUB_BITS);
            assert!(scale as f64 / ns as f64 <= 0.004, "bucket too wide at {ns}");
            assert!(idx < BUCKETS);
        }
        // Strictly non-decreasing across a wide sweep.
        let mut previous = 0usize;
        let mut ns = 1u64;
        while ns < 1 << 40 {
            let idx = bucket_index(ns);
            assert!(idx >= previous, "bucket index regressed at {ns}");
            previous = idx;
            ns = ns + 1 + ns / 7;
        }
    }

    #[test]
    fn json_is_sparse_and_stamps_its_bucketing() {
        let h = AtomicHistogram::new();
        h.record(1_000);
        h.record(1_000);
        h.record(2_000_000);
        let json = h.to_json();
        assert!(json.contains("\"version\":2"), "{json}");
        assert!(json.contains("\"subBits\":8,\"maxOctave\":45"), "{json}");
        // Two distinct buckets, one of them with two samples; nothing else.
        let buckets = json
            .split("\"buckets\":")
            .nth(1)
            .and_then(|s| s.split("],\"count\"").next())
            .unwrap_or_default();
        assert_eq!(buckets.matches('[').count(), 3, "{json}");
        assert!(buckets.contains(",2]"), "{json}");
        assert!(json.contains("\"count\":3,\"recordedTotal\":3"), "{json}");
    }

    /// A snapshot taken mid-record must describe itself, not the counter: the
    /// percentile reader is driven by `count`, and a count its buckets cannot
    /// support silently reports the maximum as every high percentile.
    #[test]
    fn json_count_comes_from_the_buckets_it_emitted() {
        let h = AtomicHistogram::new();
        h.record(1_000);
        // Stand-in for the window inside `record` where `total` has been bumped
        // and the bucket has not.
        h.total.fetch_add(7, Ordering::Relaxed);
        let json = h.to_json();
        assert!(json.contains("\"count\":1,\"recordedTotal\":8"), "{json}");
    }

    #[test]
    fn histogram_counts_negatives_apart() {
        let h = AtomicHistogram::new();
        h.record_signed(-1);
        h.record_signed(1_000);
        let json = h.to_json();
        assert!(json.contains("\"negative\":1"), "{json}");
        assert!(json.contains("\"count\":1"), "{json}");
    }
}
