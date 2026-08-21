//! The native paced reader's instruments: G11's up-direction deframer, the
//! dual-stamp record ring, and the shapes `run_frame_sink` reports.
//!
//! This is a **bench/harness surface**, the emitter's twin
//! (`paced_emitter.rs`) pointed at the read side. It exists because the T
//! arm's upstream deframe loop is the other half of the conductor's
//! single-JS-thread wall (issue 10): at 100 sessions the up-direction
//! app-level p99 reads ~330-350 ms while the identical machinery delivers
//! down p99 4.25 ms — the wire is exonerated, the napi-bound read scheduling
//! is not. The sink moves the *loop* into native code; the stream it drains
//! is read through the same internal path a JS `read()` crosses into
//! (`ClientBidiStreamHandle::read_inner` — the same bridge channel, the same
//! terminal semantics), so what the transport delivers is unchanged.
//!
//! **Dual stamp.** Every parsed frame yields two readings:
//!
//!  * a **native arrival stamp** (`wall_clock_ns`, CLOCK_REALTIME — the same
//!    clock domain as the sender's JS FFI stamp), recorded into a wire-latency
//!    histogram in the emitter's 740-edge layout. This is the successor
//!    clause C6-wire's population: sender stamp → transport arrival, never
//!    crossing the JS thread on the read side.
//!  * a fixed-width **record** pushed into a bounded ring the conductor
//!    drains from JS (`drain_frame_sink`). The conductor stamps delivery at
//!    drain time; that population continues the parent gate's C6 meaning —
//!    app-level delivery through napi onto the JS thread — and is disclosed
//!    beside C6-wire, never merged with it.
//!
//! A full ring **drops the newest record and counts it** (`dropped_records`):
//! "we did not book this sample" is a disclosed statement, never a silent
//! resample. The wire histogram sees every frame regardless — drops thin only
//! the JS-delivery disclosure, and the count says by how much.

use napi_derive::napi;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use crate::paced_emitter::{EmitterLatencySnapshot, FRAME_HEADER_BYTES};

/// One drained record, fixed 32-byte little-endian layout (see
/// `record_into`): u32 session, u32 sequence, u64 send stamp ns, u64 native
/// arrival ns, u32 total length, u8 class, 3 pad bytes.
pub const SINK_RECORD_BYTES: usize = 32;

/// Default ring capacity when the caller passes 0. At the gate rung's
/// ~264 frames/s per stream, 8192 records is ~31 s of undrained backlog per
/// stream — a conductor that far behind is itself the finding.
pub const DEFAULT_RING_CAPACITY: usize = 8192;

#[derive(Clone, Copy)]
pub struct SinkRecord {
    pub session: u32,
    pub sequence: u32,
    pub send_wall_ns: u64,
    pub arrival_wall_ns: u64,
    pub total_length: u32,
    pub class: u8,
}

fn record_into(out: &mut [u8], r: &SinkRecord) {
    out[0..4].copy_from_slice(&r.session.to_le_bytes());
    out[4..8].copy_from_slice(&r.sequence.to_le_bytes());
    out[8..16].copy_from_slice(&r.send_wall_ns.to_le_bytes());
    out[16..24].copy_from_slice(&r.arrival_wall_ns.to_le_bytes());
    out[24..28].copy_from_slice(&r.total_length.to_le_bytes());
    out[28] = r.class;
    out[29] = 0;
    out[30] = 0;
    out[31] = 0;
}

/// The ring the sink task fills and the JS drain empties. Plain mutex: both
/// sides touch it for nanoseconds, and the drain runs a few times per second.
pub struct SinkShared {
    ring: Mutex<VecDeque<SinkRecord>>,
    capacity: usize,
    dropped: AtomicU64,
}

impl SinkShared {
    pub fn new(capacity: usize) -> Self {
        let capacity = if capacity == 0 {
            DEFAULT_RING_CAPACITY
        } else {
            capacity
        };
        Self {
            ring: Mutex::new(VecDeque::with_capacity(capacity.min(1024))),
            capacity,
            dropped: AtomicU64::new(0),
        }
    }

    pub fn push(&self, record: SinkRecord) {
        let Ok(mut ring) = self.ring.lock() else {
            self.dropped.fetch_add(1, Ordering::Relaxed);
            return;
        };
        if ring.len() >= self.capacity {
            self.dropped.fetch_add(1, Ordering::Relaxed);
            return;
        }
        ring.push_back(record);
    }

    /// Pop up to `max` records into the fixed-width byte layout.
    pub fn drain(&self, max: usize) -> Vec<u8> {
        let Ok(mut ring) = self.ring.lock() else {
            return Vec::new();
        };
        let n = ring.len().min(max);
        let mut out = vec![0u8; n * SINK_RECORD_BYTES];
        for i in 0..n {
            // n <= len, so the pop cannot fail; the unwrap_or keeps the
            // encoder total rather than trusting that arithmetic forever.
            let record = ring.pop_front().unwrap_or(SinkRecord {
                session: 0,
                sequence: 0,
                send_wall_ns: 0,
                arrival_wall_ns: 0,
                total_length: 0,
                class: 0,
            });
            record_into(
                &mut out[i * SINK_RECORD_BYTES..(i + 1) * SINK_RECORD_BYTES],
                &record,
            );
        }
        out
    }

    pub fn dropped(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }
}

/// `tools/load/g11-frame.ts`'s `Deframer`, clause for clause: a chunk can
/// carry a partial frame, several frames, or both; every frame in one chunk
/// shares that chunk's arrival instant ("they did arrive together" — the JS
/// file's own words); a claimed length below the header size is a wire fault,
/// not a partial.
pub struct Deframer {
    buffer: Vec<u8>,
}

pub struct ParsedFrame {
    pub total_length: u32,
    pub version: u8,
    pub class: u8,
    pub session: u32,
    pub sequence: u32,
    pub send_wall_ns: u64,
}

impl Deframer {
    pub fn new() -> Self {
        Self { buffer: Vec::new() }
    }

    pub fn pending_bytes(&self) -> usize {
        self.buffer.len()
    }

    pub fn push(&mut self, chunk: &[u8], out: &mut Vec<ParsedFrame>) -> Result<(), String> {
        // Mirror the JS deframer's shape: coalesce only when a partial is
        // actually pending, parse in place, keep the tail.
        if self.buffer.is_empty() {
            let consumed = Self::parse(chunk, out)?;
            if consumed < chunk.len() {
                self.buffer.extend_from_slice(&chunk[consumed..]);
            }
            return Ok(());
        }
        self.buffer.extend_from_slice(chunk);
        let combined = std::mem::take(&mut self.buffer);
        let consumed = Self::parse(&combined, out)?;
        if consumed < combined.len() {
            self.buffer.extend_from_slice(&combined[consumed..]);
        }
        Ok(())
    }

    fn parse(bytes: &[u8], out: &mut Vec<ParsedFrame>) -> Result<usize, String> {
        let mut offset = 0usize;
        loop {
            let remaining = bytes.len() - offset;
            if remaining < 2 {
                return Ok(offset);
            }
            let length = u16::from_le_bytes([bytes[offset], bytes[offset + 1]]) as usize;
            if length < FRAME_HEADER_BYTES {
                return Err(format!(
                    "g11: frame claims {length} B, below the header size"
                ));
            }
            if remaining < length {
                return Ok(offset);
            }
            let f = &bytes[offset..offset + length];
            out.push(ParsedFrame {
                total_length: length as u32,
                version: f[2],
                class: f[3],
                session: u32::from_le_bytes([f[4], f[5], f[6], f[7]]),
                sequence: u32::from_le_bytes([f[8], f[9], f[10], f[11]]),
                send_wall_ns: u64::from_le_bytes([
                    f[12], f[13], f[14], f[15], f[16], f[17], f[18], f[19],
                ]),
            });
            offset += length;
        }
    }
}

impl Default for Deframer {
    fn default() -> Self {
        Self::new()
    }
}

#[napi(object)]
pub struct FrameSinkOptions {
    /// Hard deadline for the sink loop in milliseconds. The parent gate's
    /// defect ledger has a conductor hang on a slow reader with no per-cell
    /// deadline; the sink refuses to reproduce it — EOF or this deadline,
    /// whichever first.
    pub deadline_ms: f64,
    /// Dual-stamp ring capacity in records; 0 means the default (8192).
    pub ring_capacity: u32,
}

#[napi(object)]
pub struct FrameSinkResult {
    /// Internal read completions (the napi-free analogue of a JS read()
    /// resolution — what the artifact's readCrossings counted).
    pub reads: f64,
    pub frames: f64,
    pub bytes: f64,
    pub errors: f64,
    pub first_error: Option<String>,
    pub saw_eof: bool,
    /// True when the loop exited on its own deadline rather than EOF/error.
    pub deadline_hit: bool,
    /// C6-wire's population: sender JS send stamp -> native arrival stamp,
    /// per frame, in the emitter's 740-edge histogram layout.
    pub wire_latency: EmitterLatencySnapshot,
    /// Records the ring refused because the conductor was not draining.
    pub dropped_records: f64,
    /// Deframer residue at exit: bytes of a partial frame never completed.
    pub pending_partial_bytes: f64,
    /// Per-session byte ledger, parallel arrays (C5 reads per-session
    /// balance; a tunnel stream normally carries exactly one session).
    pub sessions: Vec<u32>,
    pub session_bytes: Vec<f64>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paced_emitter::encode_frame_header;

    fn frame(total: usize, session: u32, seq: u32, ns: u64) -> Vec<u8> {
        let mut f = vec![0u8; total];
        encode_frame_header(&mut f, session, seq, 1, ns);
        f
    }

    #[test]
    fn parses_frames_across_chunk_boundaries() {
        let mut d = Deframer::new();
        let mut out = Vec::new();
        let a = frame(1420, 7, 0, 100);
        let b = frame(40, 7, 1, 200);
        let mut wire = a.clone();
        wire.extend_from_slice(&b);
        d.push(&wire[..1000], &mut out).unwrap();
        assert_eq!(out.len(), 0);
        assert_eq!(d.pending_bytes(), 1000);
        d.push(&wire[1000..], &mut out).unwrap();
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].total_length, 1420);
        assert_eq!(out[0].sequence, 0);
        assert_eq!(out[1].total_length, 40);
        assert_eq!(out[1].send_wall_ns, 200);
        assert_eq!(d.pending_bytes(), 0);
    }

    #[test]
    fn several_frames_in_one_chunk_parse_together() {
        let mut d = Deframer::new();
        let mut out = Vec::new();
        let mut wire = Vec::new();
        for seq in 0..5u32 {
            wire.extend_from_slice(&frame(100, 3, seq, 1000 + seq as u64));
        }
        d.push(&wire, &mut out).unwrap();
        assert_eq!(out.len(), 5);
        assert_eq!(out[4].sequence, 4);
    }

    #[test]
    fn undersized_length_claim_is_a_wire_fault() {
        let mut d = Deframer::new();
        let mut out = Vec::new();
        let mut bad = vec![0u8; 30];
        bad[0..2].copy_from_slice(&10u16.to_le_bytes());
        assert!(d.push(&bad, &mut out).is_err());
    }

    #[test]
    fn ring_bounds_and_counts_drops() {
        let shared = SinkShared::new(2);
        let r = SinkRecord {
            session: 1,
            sequence: 0,
            send_wall_ns: 1,
            arrival_wall_ns: 2,
            total_length: 1420,
            class: 1,
        };
        shared.push(r);
        shared.push(r);
        shared.push(r);
        assert_eq!(shared.dropped(), 1);
        let drained = shared.drain(10);
        assert_eq!(drained.len(), 2 * SINK_RECORD_BYTES);
        assert_eq!(shared.drain(10).len(), 0);
    }

    #[test]
    fn record_layout_is_the_documented_32_bytes() {
        let mut out = vec![0u8; SINK_RECORD_BYTES];
        record_into(
            &mut out,
            &SinkRecord {
                session: 0x0102_0304,
                sequence: 0x0506_0708,
                send_wall_ns: 0x1111_2222_3333_4444,
                arrival_wall_ns: 0x5555_6666_7777_8888,
                total_length: 1420,
                class: 2,
            },
        );
        assert_eq!(
            u32::from_le_bytes([out[0], out[1], out[2], out[3]]),
            0x0102_0304
        );
        assert_eq!(
            u64::from_le_bytes([
                out[8], out[9], out[10], out[11], out[12], out[13], out[14], out[15]
            ]),
            0x1111_2222_3333_4444
        );
        assert_eq!(
            u32::from_le_bytes([out[24], out[25], out[26], out[27]]),
            1420
        );
        assert_eq!(out[28], 2);
    }
}
