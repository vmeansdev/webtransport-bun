//! The native paced emitter's instruments: G11's frame header, the wall
//! clock its send stamps read, and a latency histogram whose bucket layout is
//! byte-compatible with `tools/load/g11-histogram.ts`.
//!
//! This is a **bench/harness surface**, compiled unconditionally but consumed
//! only by the G11 conductor (`tools/load/bench-g11.ts`) when
//! `G11_DOWN_ORIGINATOR=native`. It exists because the T arm's downstream
//! pacing loop saturates the conductor's single JS thread at 100 sessions
//! (issue 10, H1): ~26.4k awaited env-bound napi `write()`s/s cannot be issued
//! from one event loop beside 100 read loops. The emitter moves the *loop*
//! into native code; the write path it feeds is exactly the one a JS `write()`
//! crosses into (`ClientBidiStreamHandle::write_bytes` — the same budget
//! reservation, the same `StreamChunk`, the same bridge channel), so what the
//! transport serves is unchanged.
//!
//! Histogram layout parity matters because the conductor *merges* these
//! snapshots into its own `G11Histogram` ledgers, and `merge` /
//! `mergeLatencySnapshots` refuse a layout mismatch: 100 buckets of 10 µs to
//! 1 ms, then 64 buckets per doubling for 10 doublings to 1024 ms. Any drift
//! here fails the merge loudly rather than skewing a percentile silently.

use napi_derive::napi;

/// G11's frame header (`tools/load/g11-frame.ts`), little-endian:
/// u16 total length, u8 version (1), u8 class, u32 session, u32 sequence,
/// u64 send stamp in wall-clock nanoseconds.
pub const FRAME_HEADER_BYTES: usize = 20;
pub const FRAME_VERSION: u8 = 1;

/// One nanosecond, in milliseconds — `g11-pacer.ts`'s rounding guard against
/// the double-rounding livelock, not a design tolerance.
pub const DEADLINE_EPSILON_MS: f64 = 1e-6;

const SUB_MS_BUCKET_US: f64 = 10.0;
const SUB_MS_BUCKETS: usize = 100;
const BUCKETS_PER_DOUBLING: usize = 64;
const DOUBLINGS: usize = 10;
const BUCKETS: usize = SUB_MS_BUCKETS + DOUBLINGS * BUCKETS_PER_DOUBLING;
const CEILING_MS: f64 = 1024.0;

fn edges() -> Vec<f64> {
    let mut edges = Vec::with_capacity(BUCKETS);
    for i in 1..=SUB_MS_BUCKETS {
        edges.push((i as f64 * SUB_MS_BUCKET_US) / 1000.0);
    }
    for d in 0..DOUBLINGS {
        let lo = (1u64 << d) as f64;
        let hi = (1u64 << (d + 1)) as f64;
        for i in 1..=BUCKETS_PER_DOUBLING {
            edges.push(lo + ((hi - lo) * i as f64) / BUCKETS_PER_DOUBLING as f64);
        }
    }
    edges
}

fn index_of(ms: f64) -> usize {
    if ms <= 1.0 {
        let i = ((ms * 1000.0) / SUB_MS_BUCKET_US).ceil() as i64 - 1;
        return i.clamp(0, SUB_MS_BUCKETS as i64 - 1) as usize;
    }
    if ms >= CEILING_MS {
        return BUCKETS - 1;
    }
    let d = ms.log2().floor();
    let lo = 2f64.powf(d);
    let hi = 2.0 * lo;
    let within = (((ms - lo) / (hi - lo)) * BUCKETS_PER_DOUBLING as f64).ceil() as i64 - 1;
    let base = SUB_MS_BUCKETS as i64 + (d as i64) * BUCKETS_PER_DOUBLING as i64;
    (base + within.max(0)).clamp(0, BUCKETS as i64 - 1) as usize
}

/// Shaped exactly like `LatencySnapshot` in `g11-histogram.ts` (napi renames
/// the fields to camelCase), so the conductor can pass it straight to
/// `G11Histogram.merge` and the layout guard does the honesty check.
#[napi(object)]
pub struct EmitterLatencySnapshot {
    pub negative_count: f64,
    pub bucket_upper_ms: Vec<f64>,
    pub bucket_counts: Vec<f64>,
    pub max_ms: f64,
}

pub struct EmitterHistogram {
    counts: Vec<f64>,
    negative: f64,
    max: f64,
}

impl EmitterHistogram {
    pub fn new() -> Self {
        Self {
            counts: vec![0.0; BUCKETS],
            negative: 0.0,
            max: 0.0,
        }
    }

    /// Same population rule as the JS histogram: a non-positive sample is a
    /// sample — it counts in the denominator and ranks at the bottom.
    pub fn record(&mut self, ms: f64) {
        if !ms.is_finite() {
            return;
        }
        if ms > self.max {
            self.max = ms;
        }
        if ms <= 0.0 {
            self.negative += 1.0;
            return;
        }
        self.counts[index_of(ms)] += 1.0;
    }

    pub fn snapshot(&self) -> EmitterLatencySnapshot {
        EmitterLatencySnapshot {
            negative_count: self.negative,
            bucket_upper_ms: edges(),
            bucket_counts: self.counts.clone(),
            max_ms: self.max,
        }
    }
}

impl Default for EmitterHistogram {
    fn default() -> Self {
        Self::new()
    }
}

#[napi(object)]
pub struct PacedEmitterOptions {
    /// This stream's share of the offer, exactly as the JS pacer takes it.
    pub bytes_per_sec: f64,
    /// Bytes per write, header included. Fixed for the whole step.
    pub frame_bytes: u32,
    pub duration_ms: f64,
    /// Frame-header session index (the conductor's stream index).
    pub session: u32,
    /// Frame-header class byte (`FrameClass.TunnelDown` for the T arm).
    pub frame_class: u32,
}

/// Mirrors `PacedWriteResult` in `g11-pacer.ts`, field for field, plus the
/// settle histogram the conductor's `writeLatency` ledger is built from.
#[napi(object)]
pub struct PacedEmitterResult {
    pub writes: f64,
    pub settles: f64,
    pub bytes: f64,
    pub errors: f64,
    pub first_error: Option<String>,
    pub completed_full_duration: bool,
    /// actual − intended, per write.
    pub lateness: EmitterLatencySnapshot,
    /// write issue → acceptance into the per-stream queue, per write.
    pub settle: EmitterLatencySnapshot,
}

/// `CLOCK_REALTIME` in nanoseconds — `SystemTime` reads the same system-wide
/// clock the JS end's FFI `clock_gettime(CLOCK_REALTIME)` reads, so the two
/// processes' stamps share an epoch by construction (the `g11-frame.ts`
/// argument, unchanged; V-N still reads any negative one-way sample as an
/// instrument fault).
pub fn wall_clock_ns() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0)
}

/// Write G11's frame header into `frame` (filler bytes stay as allocated —
/// zeroed, matching the JS pacer's `Buffer.alloc`).
pub fn encode_frame_header(frame: &mut [u8], session: u32, sequence: u32, class: u8, wall_ns: u64) {
    debug_assert!(frame.len() >= FRAME_HEADER_BYTES);
    debug_assert!(frame.len() <= u16::MAX as usize);
    let total_length = frame.len() as u16;
    frame[0..2].copy_from_slice(&total_length.to_le_bytes());
    frame[2] = FRAME_VERSION;
    frame[3] = class;
    frame[4..8].copy_from_slice(&session.to_le_bytes());
    frame[8..12].copy_from_slice(&sequence.to_le_bytes());
    frame[12..20].copy_from_slice(&wall_ns.to_le_bytes());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layout_matches_g11_histogram_ts() {
        let e = edges();
        assert_eq!(e.len(), 740);
        assert!((e[0] - 0.01).abs() < 1e-12);
        assert!((e[99] - 1.0).abs() < 1e-12);
        assert!((e[739] - 1024.0).abs() < 1e-9);
        // First doubling: 1..2 ms in 64 steps.
        assert!((e[100] - (1.0 + 1.0 / 64.0)).abs() < 1e-12);
    }

    #[test]
    fn index_matches_edges() {
        assert_eq!(index_of(0.005), 0);
        assert_eq!(index_of(1.0), 99);
        assert_eq!(index_of(1.5), 131);
        assert_eq!(index_of(2000.0), 739);
    }

    #[test]
    fn frame_header_layout() {
        let mut frame = vec![0u8; 1420];
        encode_frame_header(&mut frame, 7, 42, 1, 123_456_789);
        assert_eq!(u16::from_le_bytes([frame[0], frame[1]]), 1420);
        assert_eq!(frame[2], 1);
        assert_eq!(frame[3], 1);
        assert_eq!(u32::from_le_bytes(frame[4..8].try_into().unwrap()), 7);
        assert_eq!(u32::from_le_bytes(frame[8..12].try_into().unwrap()), 42);
        assert_eq!(
            u64::from_le_bytes(frame[12..20].try_into().unwrap()),
            123_456_789
        );
        assert!(frame[20..].iter().all(|&b| b == 0));
    }
}
