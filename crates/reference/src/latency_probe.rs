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
pub const STAMP_VERSION: u16 = 2;
/// Bytes a version-2 stamp needs — what a writer must reserve.
pub const STAMP_BYTES: usize = 36;
/// Bytes a version-1 stamp needs. Still decoded; never written.
pub const STAMP_BYTES_V1: usize = 28;
/// Bytes a version-3 stamp needs. Registered in gate-g6-mmo.md §6.1.
pub const STAMP_BYTES_V3: usize = 48;

const OFFSET_INTENDED: usize = 4;
const OFFSET_ACTUAL: usize = 12;
const OFFSET_SEQUENCE: usize = 20;
const OFFSET_ECHO_ACTUAL: usize = 28;
const OFFSET_HOLD: usize = 36;
const OFFSET_CLASS: usize = 44;

/// Datagram classes (gate-g6-mmo.md §6.1). `MOVE` is zero so a version-1 or
/// version-2 stamp, which carries no class byte, decodes as the unremarkable
/// case rather than as something a G6 rule keys off.
pub const CLASS_MOVE: u8 = 0;
pub const CLASS_ACTION: u8 = 1;
pub const CLASS_ACK: u8 = 2;
pub const CLASS_SNAPSHOT: u8 = 3;
pub const CLASS_RAID: u8 = 4;
/// A raid subscriber's one-datagram hello: the server has no path to key a role
/// off, so a receive-only session says what it is once. Not load, and excluded
/// from every rate.
pub const CLASS_RAID_JOIN: u8 = 5;

/// Write the 36-byte header in place. The caller owns the padding beyond it.
///
/// `echo_actual` is left zero: it belongs to the server, which writes it into the
/// same payload just before echoing (Amendment 6 of the latency pre-registration).
pub fn write_stamp(buf: &mut [u8], intended_ns: u64, actual_ns: u64, sequence: u64) {
    debug_assert!(buf.len() >= STAMP_BYTES);
    buf[0..2].copy_from_slice(&STAMP_MAGIC.to_le_bytes());
    buf[2..4].copy_from_slice(&STAMP_VERSION.to_le_bytes());
    buf[OFFSET_INTENDED..OFFSET_INTENDED + 8].copy_from_slice(&intended_ns.to_le_bytes());
    buf[OFFSET_ACTUAL..OFFSET_ACTUAL + 8].copy_from_slice(&actual_ns.to_le_bytes());
    buf[OFFSET_SEQUENCE..OFFSET_SEQUENCE + 8].copy_from_slice(&sequence.to_le_bytes());
    buf[OFFSET_ECHO_ACTUAL..OFFSET_ECHO_ACTUAL + 8].copy_from_slice(&0u64.to_le_bytes());
}

/// Write the 48-byte version-3 header in place, for the G6 upstream leg.
///
/// `echo_actual` and `hold_ns` belong to the server and are left zero; `class`
/// is what tells a movement tick from an action the server must acknowledge.
pub fn write_stamp_v3(buf: &mut [u8], intended_ns: u64, actual_ns: u64, sequence: u64, class: u8) {
    debug_assert!(buf.len() >= STAMP_BYTES_V3);
    buf[0..2].copy_from_slice(&STAMP_MAGIC.to_le_bytes());
    buf[2..4].copy_from_slice(&3u16.to_le_bytes());
    buf[OFFSET_INTENDED..OFFSET_INTENDED + 8].copy_from_slice(&intended_ns.to_le_bytes());
    buf[OFFSET_ACTUAL..OFFSET_ACTUAL + 8].copy_from_slice(&actual_ns.to_le_bytes());
    buf[OFFSET_SEQUENCE..OFFSET_SEQUENCE + 8].copy_from_slice(&sequence.to_le_bytes());
    buf[OFFSET_ECHO_ACTUAL..OFFSET_ECHO_ACTUAL + 8].copy_from_slice(&0u64.to_le_bytes());
    buf[OFFSET_HOLD..OFFSET_HOLD + 8].copy_from_slice(&0u64.to_le_bytes());
    buf[OFFSET_CLASS] = class;
    buf[OFFSET_CLASS + 1..OFFSET_CLASS + 4].copy_from_slice(&[0, 0, 0]);
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Stamp {
    pub intended_ns: u64,
    pub actual_ns: u64,
    pub sequence: u64,
    /// Server's echo send instant. Zero upstream, and zero for a version-1 stamp
    /// — the egress leg simply produces no sample rather than one measured from
    /// the epoch.
    pub echo_actual_ns: u64,
    /// Server dwell (receive → send), a duration and therefore host-portable.
    /// Zero below version 3.
    pub hold_ns: u64,
    /// Datagram class. `CLASS_MOVE` below version 3.
    pub class: u8,
    /// The version this payload actually carried.
    pub version: u16,
}

/// Decode a stamp, or `None` when the datagram is not one of ours — a probe
/// frame, a short payload, a version we don't speak.
pub fn read_stamp(buf: &[u8]) -> Option<Stamp> {
    if buf.len() < STAMP_BYTES_V1 {
        return None;
    }
    let magic = u16::from_le_bytes([buf[0], buf[1]]);
    let version = u16::from_le_bytes([buf[2], buf[3]]);
    if magic != STAMP_MAGIC || !(version == 1 || version == 2 || version == 3) {
        return None;
    }
    if version >= 2 && buf.len() < STAMP_BYTES {
        return None;
    }
    if version == 3 && buf.len() < STAMP_BYTES_V3 {
        return None;
    }
    let read = |at: usize| {
        let mut octets = [0u8; 8];
        octets.copy_from_slice(&buf[at..at + 8]);
        u64::from_le_bytes(octets)
    };
    Some(Stamp {
        version,
        intended_ns: read(OFFSET_INTENDED),
        actual_ns: read(OFFSET_ACTUAL),
        sequence: read(OFFSET_SEQUENCE),
        echo_actual_ns: if version >= 2 {
            read(OFFSET_ECHO_ACTUAL)
        } else {
            0
        },
        hold_ns: if version == 3 { read(OFFSET_HOLD) } else { 0 },
        class: if version == 3 {
            buf[OFFSET_CLASS]
        } else {
            CLASS_MOVE
        },
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
                version: 2,
                intended_ns: 1_234_567_890_123,
                actual_ns: 1_234_567_899_999,
                sequence: 8_589_934_593,
                echo_actual_ns: 0,
                hold_ns: 0,
                class: CLASS_MOVE,
            })
        );
    }

    #[test]
    fn stamp_rejects_foreign_payloads() {
        assert_eq!(read_stamp(&[0u8; STAMP_BYTES_V1 - 1]), None);
        let mut buf = [0u8; STAMP_BYTES];
        write_stamp(&mut buf, 1, 2, 3);
        assert!(read_stamp(&buf).is_some());
        buf[0] ^= 0xff;
        assert_eq!(read_stamp(&buf), None);
    }

    /// The server writes the echo instant into the same payload it received, so
    /// the client can split its round trip into legs that sum to it exactly.
    #[test]
    fn stamp_carries_the_servers_echo_instant() {
        let mut buf = [0u8; STAMP_BYTES];
        write_stamp(&mut buf, 10, 20, 30);
        buf[OFFSET_ECHO_ACTUAL..OFFSET_ECHO_ACTUAL + 8]
            .copy_from_slice(&9_876_543_210u64.to_le_bytes());
        assert_eq!(
            read_stamp(&buf).map(|s| s.echo_actual_ns),
            Some(9_876_543_210)
        );
    }

    /// A version-1 payload — an older binary, an older fragment — still decodes,
    /// and simply reports no echo instant rather than one measured from zero.
    #[test]
    fn version_one_stamps_still_decode_without_an_echo_instant() {
        let mut buf = [0u8; STAMP_BYTES_V1];
        buf[0..2].copy_from_slice(&STAMP_MAGIC.to_le_bytes());
        buf[2..4].copy_from_slice(&1u16.to_le_bytes());
        buf[OFFSET_INTENDED..OFFSET_INTENDED + 8].copy_from_slice(&11u64.to_le_bytes());
        buf[OFFSET_ACTUAL..OFFSET_ACTUAL + 8].copy_from_slice(&22u64.to_le_bytes());
        buf[OFFSET_SEQUENCE..OFFSET_SEQUENCE + 8].copy_from_slice(&33u64.to_le_bytes());
        assert_eq!(
            read_stamp(&buf),
            Some(Stamp {
                version: 1,
                intended_ns: 11,
                actual_ns: 22,
                sequence: 33,
                echo_actual_ns: 0,
                hold_ns: 0,
                class: CLASS_MOVE,
            })
        );
    }

    /// Version 3 carries the server's dwell and the datagram class, and a v3
    /// header that claims more than the frame holds is not ours.
    #[test]
    fn version_three_carries_hold_and_class() {
        let mut buf = [0u8; STAMP_BYTES_V3];
        write_stamp_v3(&mut buf, 10, 20, 30, CLASS_ACTION);
        let decoded = read_stamp(&buf).expect("v3 stamp decodes");
        assert_eq!(decoded.version, 3);
        assert_eq!(decoded.class, CLASS_ACTION);
        assert_eq!(decoded.hold_ns, 0);
        assert_eq!(decoded.actual_ns, 20);

        // The server's half: dwell and class written over the same buffer.
        buf[OFFSET_HOLD..OFFSET_HOLD + 8].copy_from_slice(&4_200_000u64.to_le_bytes());
        buf[OFFSET_CLASS] = CLASS_ACK;
        let reflected = read_stamp(&buf).expect("reflected stamp decodes");
        assert_eq!(reflected.hold_ns, 4_200_000);
        assert_eq!(reflected.class, CLASS_ACK);

        let mut short = [0u8; STAMP_BYTES_V3 - 1];
        short[0..2].copy_from_slice(&STAMP_MAGIC.to_le_bytes());
        short[2..4].copy_from_slice(&3u16.to_le_bytes());
        assert_eq!(read_stamp(&short), None);
    }

    /// A version-2 payload keeps decoding with the class the G6 rules treat as
    /// unremarkable, so adding version 3 cannot silently reclassify old traffic.
    #[test]
    fn version_two_still_decodes_as_move() {
        let mut buf = [0u8; STAMP_BYTES];
        write_stamp(&mut buf, 1, 2, 3);
        let decoded = read_stamp(&buf).expect("v2 decodes");
        assert_eq!(decoded.version, 2);
        assert_eq!(decoded.class, CLASS_MOVE);
        assert_eq!(decoded.hold_ns, 0);
    }

    /// A version-2 header that claims more than the frame carries is not ours.
    #[test]
    fn truncated_version_two_stamps_are_rejected() {
        let mut buf = [0u8; STAMP_BYTES - 1];
        buf[0..2].copy_from_slice(&STAMP_MAGIC.to_le_bytes());
        buf[2..4].copy_from_slice(&2u16.to_le_bytes());
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
