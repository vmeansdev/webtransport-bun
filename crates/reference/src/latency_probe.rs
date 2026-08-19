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
//!
//! Provenance: this file is the latency axis's instrument (`probe/egress-01`),
//! taken unchanged onto the G7 branch except for [`AtomicHistogram::to_samples_json`],
//! which is added below.

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

const SUB_BITS: u32 = 5;
const SUB: u64 = 1 << SUB_BITS; // 32
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

/// Shared across every session task. Relaxed adds on a 1344-slot array: the
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
    pub fn to_json(&self) -> String {
        let mut counts = String::with_capacity(BUCKETS * 3);
        counts.push('[');
        for (i, slot) in self.counts.iter().enumerate() {
            if i > 0 {
                counts.push(',');
            }
            counts.push_str(&slot.load(Ordering::Relaxed).to_string());
        }
        counts.push(']');
        let total = self.total.load(Ordering::Relaxed);
        let min = if total == 0 {
            0
        } else {
            self.min.load(Ordering::Relaxed)
        };
        format!(
            "{{\"counts\":{},\"count\":{},\"negative\":{},\"minNs\":{},\"maxNs\":{},\"sumNs\":{}}}",
            counts,
            total,
            self.negative.load(Ordering::Relaxed),
            min,
            self.max.load(Ordering::Relaxed),
            self.sum.load(Ordering::Relaxed)
        )
    }

    /// The `LatencySamples` shape `tools/load/g7-classify.ts` grades, emitted
    /// **with its own bucket edges**.
    ///
    /// The existing `to_json` requires the reader to know this file's bucket
    /// layout, which is one more place for two implementations to drift. More
    /// importantly it reports `count` excluding negatives, and a percentile
    /// taken over that denominator is the exact defect G3b's stamp found. This
    /// emission is self-describing and puts the non-positive samples in the
    /// denominator where they belong; the consumer ranks them at the bottom.
    pub fn to_samples_json(&self) -> String {
        let mut edges = String::with_capacity(BUCKETS * 8);
        let mut counts = String::with_capacity(BUCKETS * 3);
        edges.push('[');
        counts.push('[');
        for i in 0..BUCKETS {
            if i > 0 {
                edges.push(',');
                counts.push(',');
            }
            edges.push_str(&format!("{:.6}", bucket_upper_ns(i) as f64 / 1e6));
            counts.push_str(&self.counts[i].load(Ordering::Relaxed).to_string());
        }
        edges.push(']');
        counts.push(']');
        format!(
            "{{\"negativeCount\":{},\"bucketUpperMs\":{},\"bucketCounts\":{},\"maxMs\":{:.6}}}",
            self.negative.load(Ordering::Relaxed),
            edges,
            counts,
            self.max.load(Ordering::Relaxed) as f64 / 1e6
        )
    }
}

/// Inclusive upper edge of a bucket, in nanoseconds. The inverse of
/// [`bucket_index`] at the top of each bucket.
fn bucket_upper_ns(index: usize) -> u64 {
    if index < SUB as usize {
        return index as u64;
    }
    let octave = (index as u32 / SUB as u32) + SUB_BITS - 1;
    let sub = index as u64 % SUB;
    let scale = 1u64 << (octave - SUB_BITS);
    (sub + SUB) * scale + (scale - 1)
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
        assert_eq!(BUCKETS, 1344);
        assert_eq!(bucket_index(0), 0);
        assert_eq!(bucket_index(31), 31);
        assert_eq!(bucket_index(32), 32);
        assert_eq!(bucket_index(33), 33);
        assert_eq!(bucket_index(64), 64);
        assert_eq!(bucket_index(u64::MAX), BUCKETS - 1);
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
    fn bucket_edges_are_the_inverse_of_the_index() {
        // Every bucket's own upper edge must land back in that bucket, and the
        // next nanosecond must not. This is what makes the emitted edges usable
        // as percentile boundaries by a reader that knows nothing of the layout.
        for index in [0usize, 1, 31, 32, 33, 64, 100, 640, BUCKETS - 2] {
            let upper = bucket_upper_ns(index);
            assert_eq!(bucket_index(upper), index, "upper edge of bucket {index}");
            assert!(
                bucket_index(upper + 1) > index,
                "bucket {index} did not end at {upper}"
            );
        }
    }

    #[test]
    fn samples_json_puts_negatives_in_the_denominator() {
        let h = AtomicHistogram::new();
        h.record_signed(-1);
        h.record_signed(-2);
        h.record_signed(1_000_000);
        let json = h.to_samples_json();
        assert!(json.contains("\"negativeCount\":2"), "{json}");
        assert!(json.contains("\"bucketUpperMs\":["), "{json}");
        assert!(json.contains("\"maxMs\":1.000000"), "{json}");
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
