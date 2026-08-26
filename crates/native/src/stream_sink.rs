//! SAB ring core for the native stream sink (docs/RFC_STREAM_SINK.md §4).
//!
//! One producer (the native sink task; on wasm a TS `RingWriter` twin of this
//! code) writes length-prefixed records into a SharedArrayBuffer-backed byte
//! ring; one consumer (`SinkReader` in a worker) drains them with plain reads
//! ordered by an Acquire/Release cursor pair. This module is the layout
//! authority: every byte offset, flag, and record shape the TS side relies on
//! is defined and golden-pinned here.
//!
//! Concurrency contract: the producer owns TAIL and all record bytes ahead of
//! it, the consumer owns HEAD. The producer loads HEAD with Acquire before
//! reusing reclaimed bytes and publishes TAIL with Release after the record
//! bytes are written; the consumer mirrors that pair. Record payloads are
//! written non-atomically — the cursor pair orders them (RFC risk R2).
//!
//! Ring geometry invariant: a record header never straddles the region end,
//! and no record starts within 32 bytes of it. Enforced by two rules at write
//! time, given every `rec_len` is a multiple of 8:
//! - remainder in `[rec_len + 32, ..)`: write normally (next start keeps the
//!   invariant or lands exactly on the boundary);
//! - remainder in `[rec_len, rec_len + 32)`: extend the record to span the
//!   whole remainder ("pad-to-end") — the consumer trusts `payload_len`, so
//!   up to 31 bytes of tail padding are invisible to it;
//! - remainder below `rec_len`: emit a WRAP record spanning the remainder
//!   (>= 32 by the invariant) and continue at position zero.
//!
//! The pad-to-end arm is why the 128-byte terminal reserve suffices: the
//! worst terminal commit is WRAP (<= 56) + terminal (64) = 120 bytes. A pure
//! WRAP rule would allow WRAP (<= 88) + terminal = 152 and overrun it.

use napi_derive::napi;
use once_cell::sync::Lazy;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};

pub const MAGIC: u32 = 0x5754_534B; // "WTSK"
pub const LAYOUT_VERSION: u32 = 1;
/// Data region start; the config/producer/consumer lines live below it.
pub const DATA_OFFSET: usize = 192;
pub const RECORD_HEADER_BYTES: usize = 32;
/// Capacity withheld from ordinary records so a terminal record (plus its
/// worst-case WRAP) can always commit on a "full" ring.
pub const RESERVED_TAIL_BYTES: u32 = 128;
/// Terminal payloads (error code strings) are capped so the reserve bound
/// holds: 32-byte header + 32-byte payload = one 64-byte record.
pub const MAX_TERMINAL_PAYLOAD_BYTES: usize = 32;
/// Structural bounds for the data region. The napi layer imposes the
/// product minimum (64 KiB ring); the core only needs room for its own
/// geometry, which keeps unit tests on small rings honest.
pub const MIN_DATA_CAPACITY: u32 = 1024;
pub const MAX_DATA_CAPACITY: u32 = 1 << 30;

// Header word offsets (bytes). Config line is written once at init and
// read-only afterwards; producer and consumer lines sit on separate cache
// lines so the cursors never false-share.
const OFF_MAGIC: usize = 0;
const OFF_VERSION: usize = 4;
const OFF_CAPACITY: usize = 8;
const OFF_FLAGS: usize = 12;
const OFF_DATA_OFFSET: usize = 16;
const OFF_TAIL: usize = 64;
const OFF_STATE: usize = 68;
const OFF_DROPPED_RECORDS: usize = 72;
const OFF_DROPPED_BYTES: usize = 80;
const OFF_HIGH_WATER: usize = 88;
const OFF_HEAD: usize = 128;
const OFF_HEARTBEAT: usize = 132;

// Config `flags` bits (RFC §4).
pub const FLAG_FRAMING: u32 = 1 << 0;
pub const FLAG_DROP_NEWEST: u32 = 1 << 1;
pub const FLAG_CLOCK_WALL: u32 = 1 << 2;
pub const FLAG_PRODUCER_NOTIFIES: u32 = 1 << 3;

/// `sinkState` word values.
pub const STATE_ACTIVE: u32 = 0;
pub const STATE_TERMINAL_COMMITTED: u32 = 1;
pub const STATE_EXITED: u32 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum RecordType {
    Data = 1,
    Message = 2,
    Eof = 3,
    Error = 4,
    Reset = 5,
    Wrap = 6,
    DropGap = 7,
}

impl RecordType {
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Eof | Self::Error | Self::Reset)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OverflowMode {
    /// Ring full parks the producer (caller retries): lossless, QUIC flow
    /// control throttles the sender.
    Block,
    /// Ring full drops the record and counts it; a DROPGAP record discloses
    /// the gap to the consumer once space frees.
    DropNewest,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PushOutcome {
    Written,
    /// Block mode only: no room outside the terminal reserve. Nothing was
    /// written; the caller re-polls HEAD and retries.
    WouldBlock,
    /// Drop-newest mode only: the record was counted into the gap instead of
    /// written.
    Dropped,
}

fn align8(len: usize) -> usize {
    (len + 7) & !7
}

/// Largest payload a ring of `data_capacity` accepts (RFC §4 sizing rule).
pub fn max_payload_bytes(data_capacity: u32) -> usize {
    (data_capacity as usize / 4) - RECORD_HEADER_BYTES
}

/// Producer half of the ring. Owned by exactly one task; `Send` but
/// deliberately not `Sync` (single-producer is a layout invariant, not a
/// convention). The consumer never sees this type — it works from the raw
/// buffer through the published layout.
pub struct SinkRing {
    base: *mut u8,
    data_capacity: u32,
    mode: OverflowMode,
    /// Records dropped since the last DROPGAP commit (drop-newest mode).
    /// Byte counts live only in the `droppedBytes` atomic.
    pending_gap_records: u64,
    /// Wire offset of the first byte the pending gap swallowed.
    pending_gap_start_offset: u64,
    high_water: u32,
}

// SAFETY: the producer task is the only party touching producer-owned state;
// all cross-thread words are atomics with explicit ordering.
unsafe impl Send for SinkRing {}

impl SinkRing {
    /// Validate a caller-supplied buffer and stamp the config line. `base`
    /// must be 8-aligned (SAB backing stores are) and `len` must cover the
    /// header lines plus a power-of-two data region within bounds.
    ///
    /// # Safety
    /// `base..base+len` must be valid for reads and writes for the lifetime
    /// of the returned ring and of every consumer attached to the same
    /// buffer, and no other producer may exist for it.
    pub unsafe fn init(
        base: *mut u8,
        len: usize,
        data_capacity: u32,
        flags: u32,
        mode: OverflowMode,
    ) -> Result<Self, String> {
        if base.is_null() || !(base as usize).is_multiple_of(8) {
            return Err("E_SINK_BAD_BUFFER: backing store is not 8-aligned".to_string());
        }
        if !data_capacity.is_power_of_two()
            || !(MIN_DATA_CAPACITY..=MAX_DATA_CAPACITY).contains(&data_capacity)
        {
            return Err(format!(
                "E_SINK_BAD_OPTIONS: data capacity {data_capacity} must be a power of two in [{MIN_DATA_CAPACITY}, {MAX_DATA_CAPACITY}]"
            ));
        }
        if len < DATA_OFFSET + data_capacity as usize {
            return Err(format!(
                "E_SINK_BAD_BUFFER: buffer holds {len} bytes, layout needs {}",
                DATA_OFFSET + data_capacity as usize
            ));
        }
        std::ptr::write_bytes(base, 0, DATA_OFFSET);
        let ring = Self {
            base,
            data_capacity,
            mode,
            pending_gap_records: 0,
            pending_gap_start_offset: 0,
            high_water: 0,
        };
        ring.config_u32(OFF_MAGIC).store(MAGIC, Ordering::Relaxed);
        ring.config_u32(OFF_VERSION)
            .store(LAYOUT_VERSION, Ordering::Relaxed);
        ring.config_u32(OFF_CAPACITY)
            .store(data_capacity, Ordering::Relaxed);
        ring.config_u32(OFF_FLAGS).store(flags, Ordering::Relaxed);
        ring.config_u32(OFF_DATA_OFFSET)
            .store(DATA_OFFSET as u32, Ordering::Release);
        Ok(ring)
    }

    fn config_u32(&self, offset: usize) -> &AtomicU32 {
        // SAFETY: init validated alignment and bounds; the offsets are
        // module constants inside the header lines.
        unsafe { &*(self.base.add(offset) as *const AtomicU32) }
    }

    fn config_u64(&self, offset: usize) -> &AtomicU64 {
        unsafe { &*(self.base.add(offset) as *const AtomicU64) }
    }

    fn mask(&self) -> u32 {
        self.data_capacity - 1
    }

    fn tail(&self) -> u32 {
        // Sole producer: our own store is the only writer.
        self.config_u32(OFF_TAIL).load(Ordering::Relaxed)
    }

    fn head(&self) -> u32 {
        // Pairs with the consumer's Release publish: the consumer is done
        // with everything below HEAD before we may overwrite it.
        self.config_u32(OFF_HEAD).load(Ordering::Acquire)
    }

    pub fn fill(&self) -> u32 {
        self.tail().wrapping_sub(self.head())
    }

    pub fn state(&self) -> u32 {
        self.config_u32(OFF_STATE).load(Ordering::Acquire)
    }

    pub fn set_exited(&self) {
        self.config_u32(OFF_STATE)
            .store(STATE_EXITED, Ordering::Release);
    }

    pub fn consumer_heartbeat(&self) -> u32 {
        self.config_u32(OFF_HEARTBEAT).load(Ordering::Acquire)
    }

    pub fn dropped_records(&self) -> u64 {
        self.config_u64(OFF_DROPPED_RECORDS).load(Ordering::Relaxed)
    }

    pub fn dropped_bytes(&self) -> u64 {
        self.config_u64(OFF_DROPPED_BYTES).load(Ordering::Relaxed)
    }

    pub fn high_water_bytes(&self) -> u32 {
        self.high_water
    }

    /// Ring-space cost of writing `rec_len` with the tail at `tail`,
    /// including the WRAP record or pad-to-end extension the position
    /// forces. Exact, not an upper bound: admission decisions use it.
    fn cost_at(&self, tail: u32, rec_len: u32) -> u32 {
        let remainder = self.data_capacity - (tail & self.mask());
        if remainder >= rec_len + RECORD_HEADER_BYTES as u32 {
            rec_len
        } else if remainder >= rec_len {
            remainder
        } else {
            remainder + rec_len
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn write_header(
        &self,
        pos: u32,
        rec_len: u32,
        kind: RecordType,
        timestamp_ns: u64,
        stream_offset: u64,
        payload_len: u32,
        aux: u32,
    ) {
        // SAFETY: pos + 32 <= data_capacity by the geometry invariant; the
        // cursor pair keeps the consumer out of these bytes.
        unsafe {
            let p = self.base.add(DATA_OFFSET + pos as usize);
            (p as *mut u32).write_unaligned(rec_len.to_le());
            p.add(4).write(kind as u8);
            p.add(5).write(0);
            (p.add(6) as *mut u16).write_unaligned(0);
            (p.add(8) as *mut u64).write_unaligned(timestamp_ns.to_le());
            (p.add(16) as *mut u64).write_unaligned(stream_offset.to_le());
            (p.add(24) as *mut u32).write_unaligned((payload_len).to_le());
            (p.add(28) as *mut u32).write_unaligned(aux.to_le());
        }
    }

    /// Write one record at the tail, applying the WRAP / pad-to-end geometry
    /// rules, and publish TAIL. `cost` must be `cost_at(tail, rec_len)` and
    /// already admitted against the relevant budget.
    #[allow(clippy::too_many_arguments)]
    fn commit(
        &mut self,
        rec_len: u32,
        cost: u32,
        kind: RecordType,
        timestamp_ns: u64,
        stream_offset: u64,
        payload: &[u8],
        aux: u32,
    ) {
        let tail = self.tail();
        let mut pos = tail & self.mask();
        let remainder = self.data_capacity - pos;
        let stored_len = if remainder >= rec_len + RECORD_HEADER_BYTES as u32 {
            rec_len
        } else if remainder >= rec_len {
            // Pad-to-end: the record absorbs the short remainder.
            remainder
        } else {
            self.write_header(pos, remainder, RecordType::Wrap, 0, 0, 0, 0);
            pos = 0;
            rec_len
        };
        self.write_header(
            pos,
            stored_len,
            kind,
            timestamp_ns,
            stream_offset,
            payload.len() as u32,
            aux,
        );
        if !payload.is_empty() {
            // SAFETY: header + payload fit below data_capacity by geometry.
            unsafe {
                std::ptr::copy_nonoverlapping(
                    payload.as_ptr(),
                    self.base
                        .add(DATA_OFFSET + pos as usize + RECORD_HEADER_BYTES),
                    payload.len(),
                );
            }
        }
        let new_tail = tail.wrapping_add(cost);
        let fill = new_tail.wrapping_sub(self.head());
        if fill > self.high_water {
            self.high_water = fill;
            self.config_u32(OFF_HIGH_WATER)
                .store(fill, Ordering::Relaxed);
        }
        self.config_u32(OFF_TAIL).store(new_tail, Ordering::Release);
    }

    /// Push one data-class record (DATA or MESSAGE). Terminal types go
    /// through `push_terminal`, which is allowed to eat the reserve.
    pub fn push(
        &mut self,
        kind: RecordType,
        timestamp_ns: u64,
        stream_offset: u64,
        payload: &[u8],
    ) -> Result<PushOutcome, String> {
        debug_assert!(matches!(kind, RecordType::Data | RecordType::Message));
        if payload.len() > max_payload_bytes(self.data_capacity) {
            return Err(format!(
                "E_SINK_OVERSIZED: {} byte payload exceeds the {} byte cap for this ring",
                payload.len(),
                max_payload_bytes(self.data_capacity)
            ));
        }
        let rec_len = align8(RECORD_HEADER_BYTES + payload.len()) as u32;
        let usable = self.data_capacity - RESERVED_TAIL_BYTES;

        // A pending gap is disclosed before the record that follows it, so
        // the consumer sees the loss at the position it happened. Admission
        // is exact: gap cost at the current tail, record cost at the tail
        // the gap leaves behind.
        let tail = self.tail();
        let gap_cost = if self.pending_gap_records > 0 {
            self.cost_at(tail, RECORD_HEADER_BYTES as u32)
        } else {
            0
        };
        let record_cost = self.cost_at(tail.wrapping_add(gap_cost), rec_len);
        if self.fill() + gap_cost + record_cost > usable {
            return match self.mode {
                OverflowMode::Block => Ok(PushOutcome::WouldBlock),
                OverflowMode::DropNewest => {
                    self.note_drop(stream_offset);
                    self.config_u64(OFF_DROPPED_BYTES)
                        .fetch_add(payload.len() as u64, Ordering::Relaxed);
                    Ok(PushOutcome::Dropped)
                }
            };
        }
        self.flush_pending_gap();
        self.commit(
            rec_len,
            record_cost,
            kind,
            timestamp_ns,
            stream_offset,
            payload,
            0,
        );
        Ok(PushOutcome::Written)
    }

    /// Commit the terminal record (EOF / ERROR / RESET). Draws on the
    /// 128-byte reserve, so it always fits; the state word makes it
    /// exactly-once. Returns false if a terminal was already committed.
    pub fn push_terminal(
        &mut self,
        kind: RecordType,
        timestamp_ns: u64,
        stream_offset: u64,
        payload: &[u8],
        aux: u32,
    ) -> bool {
        assert!(kind.is_terminal());
        assert!(payload.len() <= MAX_TERMINAL_PAYLOAD_BYTES);
        if self
            .config_u32(OFF_STATE)
            .compare_exchange(
                STATE_ACTIVE,
                STATE_TERMINAL_COMMITTED,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .is_err()
        {
            return false;
        }
        let rec_len = align8(RECORD_HEADER_BYTES + payload.len()) as u32;
        // Disclose any still-pending gap first, but only when the terminal
        // still fits after it — the reserve guarantees the terminal, not the
        // gap. An undisclosed tail-end gap stays visible through the
        // droppedRecords/droppedBytes atomics.
        if self.pending_gap_records > 0 {
            let tail = self.tail();
            let gap_cost = self.cost_at(tail, RECORD_HEADER_BYTES as u32);
            let terminal_after = self.cost_at(tail.wrapping_add(gap_cost), rec_len);
            if self.fill() + gap_cost + terminal_after <= self.data_capacity {
                self.flush_pending_gap();
            }
        }
        let cost = self.cost_at(self.tail(), rec_len);
        // The reserve makes this unconditional: ordinary admission keeps
        // fill <= capacity - 128, and a terminal's worst-case cost (WRAP
        // <= 56 plus a 64-byte record, or an <= 88-byte pad-to-end) is 120.
        debug_assert!(self.fill() + cost <= self.data_capacity);
        self.commit(
            rec_len,
            cost,
            kind,
            timestamp_ns,
            stream_offset,
            payload,
            aux,
        );
        true
    }

    fn note_drop(&mut self, stream_offset: u64) {
        if self.pending_gap_records == 0 {
            self.pending_gap_start_offset = stream_offset;
        }
        self.pending_gap_records += 1;
        self.config_u64(OFF_DROPPED_RECORDS)
            .fetch_add(1, Ordering::Relaxed);
    }

    fn flush_pending_gap(&mut self) {
        if self.pending_gap_records == 0 {
            return;
        }
        let count = u32::try_from(self.pending_gap_records).unwrap_or(u32::MAX);
        let cost = self.cost_at(self.tail(), RECORD_HEADER_BYTES as u32);
        self.commit(
            RECORD_HEADER_BYTES as u32,
            cost,
            RecordType::DropGap,
            0,
            self.pending_gap_start_offset,
            &[],
            count,
        );
        self.pending_gap_records = 0;
    }
}

// ---------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------

/// Declarative length-prefix framing (RFC §3 `StreamSinkFraming`). Validated
/// once at open; the deframer then cuts MESSAGE records out of the raw chunk
/// stream.
#[derive(Debug, Clone)]
pub struct FramingConfig {
    pub header_bytes: usize,
    pub length_offset: usize,
    pub length_width: usize,
    pub little_endian: bool,
    pub length_includes_header: bool,
    pub max_frame_bytes: usize,
}

impl FramingConfig {
    pub fn validate(&self) -> Result<(), String> {
        if !(1..=64).contains(&self.header_bytes) {
            return Err("E_SINK_BAD_OPTIONS: framing headerBytes must be 1..=64".to_string());
        }
        if !matches!(self.length_width, 1 | 2 | 4 | 8) {
            return Err(
                "E_SINK_BAD_OPTIONS: framing lengthWidth must be 1, 2, 4, or 8".to_string(),
            );
        }
        if self.length_offset + self.length_width > self.header_bytes {
            return Err(
                "E_SINK_BAD_OPTIONS: framing length field does not fit in the header".to_string(),
            );
        }
        if self.max_frame_bytes < self.header_bytes {
            return Err(
                "E_SINK_BAD_OPTIONS: framing maxFrameBytes is smaller than the header".to_string(),
            );
        }
        Ok(())
    }

    /// Total frame length claimed by a complete header, or the wire fault
    /// that disqualifies it.
    fn frame_len(&self, header: &[u8]) -> Result<usize, String> {
        let raw = &header[self.length_offset..self.length_offset + self.length_width];
        let mut value: u64 = 0;
        if self.little_endian {
            for (i, b) in raw.iter().enumerate() {
                value |= (*b as u64) << (8 * i);
            }
        } else {
            for b in raw {
                value = (value << 8) | *b as u64;
            }
        }
        let total = if self.length_includes_header {
            if (value as usize) < self.header_bytes {
                return Err(format!(
                    "E_SINK_FRAME_FAULT: claimed length {value} is shorter than the {} byte header",
                    self.header_bytes
                ));
            }
            value as usize
        } else {
            self.header_bytes + value as usize
        };
        if total > self.max_frame_bytes {
            return Err(format!(
                "E_SINK_FRAME_FAULT: frame of {total} bytes exceeds maxFrameBytes {}",
                self.max_frame_bytes
            ));
        }
        Ok(total)
    }
}

/// Incremental deframer. Whole frames inside a pushed chunk are handed to the
/// callback as borrows of that chunk; only frames split across chunk
/// boundaries stage bytes.
pub struct Deframer {
    config: FramingConfig,
    staging: Vec<u8>,
}

impl Deframer {
    pub fn new(config: FramingConfig) -> Result<Self, String> {
        config.validate()?;
        Ok(Self {
            config,
            staging: Vec::new(),
        })
    }

    pub fn pending_bytes(&self) -> usize {
        self.staging.len()
    }

    /// Feed one chunk; `emit` receives every completed frame (header
    /// included) in order. A wire fault or an emit error aborts the stream —
    /// the deframer must not be fed again after an Err.
    pub fn push<E>(
        &mut self,
        chunk: &[u8],
        mut emit: impl FnMut(&[u8]) -> Result<(), E>,
    ) -> Result<(), String>
    where
        E: std::fmt::Display,
    {
        let mut rest = chunk;
        // Drain the staged partial frame first.
        while !self.staging.is_empty() {
            if self.staging.len() < self.config.header_bytes {
                let want = self.config.header_bytes - self.staging.len();
                let take = want.min(rest.len());
                self.staging.extend_from_slice(&rest[..take]);
                rest = &rest[take..];
                if self.staging.len() < self.config.header_bytes {
                    return Ok(());
                }
            }
            let total = self
                .config
                .frame_len(&self.staging[..self.config.header_bytes])?;
            let want = total - self.staging.len().min(total);
            let take = want.min(rest.len());
            self.staging.extend_from_slice(&rest[..take]);
            rest = &rest[take..];
            if self.staging.len() < total {
                return Ok(());
            }
            emit(&self.staging[..total]).map_err(|e| e.to_string())?;
            self.staging.clear();
        }
        // Cut whole frames straight out of the chunk.
        while rest.len() >= self.config.header_bytes {
            let total = self.config.frame_len(&rest[..self.config.header_bytes])?;
            if rest.len() < total {
                break;
            }
            emit(&rest[..total]).map_err(|e| e.to_string())?;
            rest = &rest[total..];
        }
        if !rest.is_empty() {
            self.staging.extend_from_slice(rest);
        }
        Ok(())
    }

    /// `push` for the sink task: completed frames come back as owned
    /// `Bytes` — zero-copy slices of `chunk` for frames wholly inside it,
    /// copies only for frames staged across chunk boundaries. Owned frames
    /// let the caller `await` between frames (a borrow-callback cannot),
    /// which the block-mode ring push needs.
    pub fn push_bytes(
        &mut self,
        chunk: &bytes::Bytes,
        out: &mut Vec<bytes::Bytes>,
    ) -> Result<(), String> {
        let mut cursor = 0usize;
        // Complete the staged partial frame first.
        while !self.staging.is_empty() {
            let rest = &chunk[cursor..];
            if self.staging.len() < self.config.header_bytes {
                let want = self.config.header_bytes - self.staging.len();
                let take = want.min(rest.len());
                self.staging.extend_from_slice(&rest[..take]);
                cursor += take;
                if self.staging.len() < self.config.header_bytes {
                    return Ok(());
                }
                continue;
            }
            let total = self
                .config
                .frame_len(&self.staging[..self.config.header_bytes])?;
            let want = total.saturating_sub(self.staging.len());
            let take = want.min(rest.len());
            self.staging.extend_from_slice(&rest[..take]);
            cursor += take;
            if self.staging.len() < total {
                return Ok(());
            }
            out.push(bytes::Bytes::from(std::mem::take(&mut self.staging)));
        }
        // Whole frames slice the refcounted chunk without copying.
        loop {
            let rest = &chunk[cursor..];
            if rest.len() < self.config.header_bytes {
                break;
            }
            let total = self.config.frame_len(&rest[..self.config.header_bytes])?;
            if rest.len() < total {
                break;
            }
            out.push(chunk.slice(cursor..cursor + total));
            cursor += total;
        }
        if cursor < chunk.len() {
            self.staging.extend_from_slice(&chunk[cursor..]);
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Sink task
// ---------------------------------------------------------------------------

/// Process-wide bound on concurrently active sink tasks (RFC §6): a sink has
/// no channel or scratch buffer to bound, so this is a runaway-open backstop,
/// deliberately not the DEFERRED_READ_BRIDGES semaphore — latency-critical
/// opens must never park behind bulk readers' permits. Fail-fast, no parking.
pub const SINK_TASK_LIMIT: usize = 1024;
pub static SINKS_ACTIVE: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
/// Cumulative drop-newest records lost across all sinks, for metricsSnapshot.
pub static SINK_DROPPED_RECORDS_TOTAL: AtomicU64 = AtomicU64::new(0);

/// Claim a sink slot; the returned guard releases it on drop (task exit or
/// failed open).
pub fn try_acquire_sink_slot() -> Option<SinkSlot> {
    let prior = SINKS_ACTIVE.fetch_add(1, std::sync::atomic::Ordering::AcqRel);
    if prior >= SINK_TASK_LIMIT {
        SINKS_ACTIVE.fetch_sub(1, std::sync::atomic::Ordering::AcqRel);
        return None;
    }
    Some(SinkSlot(()))
}

pub struct SinkSlot(());

impl Drop for SinkSlot {
    fn drop(&mut self) {
        SINKS_ACTIVE.fetch_sub(1, std::sync::atomic::Ordering::AcqRel);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SinkClock {
    /// CLOCK_MONOTONIC-style: nanoseconds since a process-wide anchor.
    /// NTP-immune; the open info carries the (monotonic, wall) anchor pair so
    /// consumers can map into wall time when they need to.
    Monotonic,
    /// CLOCK_REALTIME nanoseconds since the Unix epoch, for cross-host
    /// sender-stamp arithmetic.
    Wall,
}

static MONOTONIC_ANCHOR: Lazy<std::time::Instant> = Lazy::new(std::time::Instant::now);

pub fn clock_now_ns(clock: SinkClock) -> u64 {
    match clock {
        SinkClock::Monotonic => MONOTONIC_ANCHOR.elapsed().as_nanos() as u64,
        SinkClock::Wall => std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0),
    }
}

/// Task-observable state mirror for `stats()`. The ring's in-band terminal
/// record is the ordering authority; this is the main thread's convenience.
pub const TASK_ACTIVE: u32 = 0;
pub const TASK_EOF: u32 = 1;
pub const TASK_ERROR: u32 = 2;
pub const TASK_RESET: u32 = 3;
pub const TASK_STALLED: u32 = 4;
pub const TASK_CLOSED: u32 = 5;

#[derive(Default)]
pub struct SinkCounters {
    pub bytes_in: AtomicU64,
    pub records: AtomicU64,
    pub pending_partial_bytes: AtomicU64,
    pub task_state: AtomicU32,
}

/// What the sink reads from. The enum (rather than a trait) keeps the task a
/// plain async fn: the QUIC arm is a thin adapter over quinn's `read_chunk`,
/// and the test arm drives the identical task logic without a transport.
pub enum SinkSource {
    Quic(wtransport::RecvStream),
    #[cfg(test)]
    Test(tokio::sync::mpsc::Receiver<std::result::Result<bytes::Bytes, SinkWireError>>),
}

/// A wire-terminal event: which terminal record it becomes and what rides
/// along (RESET carries the peer's app error code in `aux`; ERROR carries the
/// code string as payload).
#[derive(Debug, Clone)]
pub struct SinkWireError {
    pub kind: RecordType,
    pub code: &'static str,
    pub aux: u32,
}

impl SinkSource {
    async fn read(
        &mut self,
        max: usize,
    ) -> std::result::Result<Option<bytes::Bytes>, SinkWireError> {
        match self {
            Self::Quic(recv) => match recv.quic_stream_mut().read_chunk(max, true).await {
                Ok(Some(chunk)) => Ok(Some(chunk.bytes)),
                Ok(None) => Ok(None),
                Err(wtransport::quinn::ReadError::Reset(code)) => Err(SinkWireError {
                    kind: RecordType::Reset,
                    code: "E_STREAM_RESET",
                    aux: u32::try_from(code.into_inner()).unwrap_or(u32::MAX),
                }),
                Err(_) => Err(SinkWireError {
                    kind: RecordType::Error,
                    code: "E_SESSION_CLOSED",
                    aux: 0,
                }),
            },
            #[cfg(test)]
            Self::Test(rx) => match rx.recv().await {
                Some(Ok(bytes)) => Ok(Some(bytes)),
                Some(Err(err)) => Err(err),
                None => Ok(None),
            },
        }
    }

    /// Consumes the source: wtransport's `stop` takes the stream by value.
    fn stop(self, code: u32) {
        match self {
            Self::Quic(recv) => recv.stop(code),
            #[cfg(test)]
            Self::Test(_) => {}
        }
    }
}

pub struct SinkTaskConfig {
    pub clock: SinkClock,
    /// Constructed (and therefore validated) at open time.
    pub framing: Option<Deframer>,
    /// Block-mode stall deadline: ring full AND no consumer heartbeat for
    /// this long ends the sink (the abandoned-reader lesson — a dead worker
    /// must not wedge the sender forever).
    pub backpressure_timeout: std::time::Duration,
    /// Drop-newest liveness deadline; None (product default) never kills a
    /// merely idle consumer.
    pub idle_timeout: Option<std::time::Duration>,
    /// `streamByteOffset` base: bytes earlier direct reads already consumed.
    pub base_offset: u64,
}

/// Shared stop signal: flag + notify, so a stop that fires before the task
/// parks is never lost.
pub struct SinkStop {
    pub flag: std::sync::atomic::AtomicBool,
    pub notify: tokio::sync::Notify,
}

impl SinkStop {
    pub fn new() -> Self {
        Self {
            flag: std::sync::atomic::AtomicBool::new(false),
            notify: tokio::sync::Notify::new(),
        }
    }
    pub fn fire(&self) {
        self.flag.store(true, std::sync::atomic::Ordering::Release);
        self.notify.notify_waiters();
    }
    pub fn fired(&self) -> bool {
        self.flag.load(std::sync::atomic::Ordering::Acquire)
    }
}

impl Default for SinkStop {
    fn default() -> Self {
        Self::new()
    }
}

enum PushLoopEnd {
    Wrote,
    /// Drop-newest counted the record into the gap; the stream continues.
    DroppedRecord,
    Stalled,
    Stopped,
}

/// Push one record, absorbing block-mode fullness with an adaptive
/// 200µs→1ms poll of HEAD (BUDGET_POLL_INTERVAL precedent). Fullness is
/// consumer-bound latency already; the poll costs nothing when there is room.
async fn push_absorbing_fullness(
    ring: &mut SinkRing,
    stop: &SinkStop,
    backpressure_timeout: std::time::Duration,
    kind: RecordType,
    timestamp_ns: u64,
    stream_offset: u64,
    payload: &[u8],
) -> std::result::Result<PushLoopEnd, String> {
    let mut delay = std::time::Duration::from_micros(200);
    let mut stall_started: Option<std::time::Instant> = None;
    let mut heartbeat_seen = ring.consumer_heartbeat();
    loop {
        if stop.fired() {
            return Ok(PushLoopEnd::Stopped);
        }
        match ring.push(kind, timestamp_ns, stream_offset, payload)? {
            PushOutcome::Written => return Ok(PushLoopEnd::Wrote),
            PushOutcome::Dropped => {
                SINK_DROPPED_RECORDS_TOTAL.fetch_add(1, Ordering::Relaxed);
                return Ok(PushLoopEnd::DroppedRecord);
            }
            PushOutcome::WouldBlock => {
                let heartbeat = ring.consumer_heartbeat();
                let now = std::time::Instant::now();
                if heartbeat != heartbeat_seen {
                    heartbeat_seen = heartbeat;
                    stall_started = None;
                }
                let started = *stall_started.get_or_insert(now);
                if now.duration_since(started) >= backpressure_timeout {
                    return Ok(PushLoopEnd::Stalled);
                }
                tokio::select! {
                    _ = tokio::time::sleep(delay) => {}
                    _ = stop.notify.notified() => {}
                }
                delay = (delay * 2).min(std::time::Duration::from_millis(1));
            }
        }
    }
}

/// The sink task: the read loop that replaces JS consumption for one stream.
/// Owns the transport stream and the ring writer; owns no napi values, which
/// makes the Bun rejected-async self-ref leak class structurally impossible
/// here. `retain` is dropped on exit (stream guard, sink slot, and whatever
/// else must live exactly as long as the task).
pub async fn run_sink_task<R: Send + 'static>(
    mut source: SinkSource,
    mut ring: SinkRing,
    config: SinkTaskConfig,
    counters: std::sync::Arc<SinkCounters>,
    stop: std::sync::Arc<SinkStop>,
    exited: std::sync::Arc<SinkStop>,
    retain: R,
) {
    let mut deframer = config.framing;
    let mut offset = config.base_offset;
    let read_cap = max_payload_bytes(ring.data_capacity).min(64 * 1024);
    let mut frames: Vec<bytes::Bytes> = Vec::new();
    // Drop-newest liveness: (heartbeat value, when it last changed). Only
    // consulted when `idle_timeout` is configured; a merely idle consumer on
    // an idle wire is never killed (no chunks, no checks, nothing lost).
    let mut idle_watch: Option<(u32, std::time::Instant)> = None;

    // (terminal kind, code payload, aux, final task state)
    let outcome: (RecordType, &'static str, u32, u32) = 'run: loop {
        let chunk = tokio::select! {
            chunk = source.read(read_cap) => chunk,
            _ = stop.notify.notified() => break 'run (RecordType::Error, "E_SINK_CLOSED", 0, TASK_CLOSED),
        };
        if stop.fired() {
            break 'run (RecordType::Error, "E_SINK_CLOSED", 0, TASK_CLOSED);
        }
        match chunk {
            Ok(Some(bytes)) => {
                let timestamp = clock_now_ns(config.clock);
                counters
                    .bytes_in
                    .fetch_add(bytes.len() as u64, Ordering::Relaxed);
                if let Some(ref mut deframer) = deframer {
                    frames.clear();
                    if deframer.push_bytes(&bytes, &mut frames).is_err() {
                        break 'run (RecordType::Error, "E_SINK_FRAME_FAULT", 0, TASK_ERROR);
                    }
                    for frame in frames.drain(..) {
                        let end = push_absorbing_fullness(
                            &mut ring,
                            &stop,
                            config.backpressure_timeout,
                            RecordType::Message,
                            timestamp,
                            offset,
                            &frame,
                        )
                        .await;
                        offset += frame.len() as u64;
                        match end {
                            Ok(PushLoopEnd::Wrote) => {
                                counters.records.fetch_add(1, Ordering::Relaxed);
                            }
                            Ok(PushLoopEnd::DroppedRecord) => {}
                            Ok(PushLoopEnd::Stalled) => {
                                break 'run (RecordType::Error, "E_SINK_STALLED", 0, TASK_STALLED)
                            }
                            Ok(PushLoopEnd::Stopped) => {
                                break 'run (RecordType::Error, "E_SINK_CLOSED", 0, TASK_CLOSED)
                            }
                            Err(_) => {
                                break 'run (RecordType::Error, "E_SINK_INTERNAL", 0, TASK_ERROR)
                            }
                        }
                    }
                    counters
                        .pending_partial_bytes
                        .store(deframer.pending_bytes() as u64, Ordering::Relaxed);
                } else {
                    let len = bytes.len() as u64;
                    let end = push_absorbing_fullness(
                        &mut ring,
                        &stop,
                        config.backpressure_timeout,
                        RecordType::Data,
                        timestamp,
                        offset,
                        &bytes,
                    )
                    .await;
                    offset += len;
                    match end {
                        Ok(PushLoopEnd::Wrote) => {
                            counters.records.fetch_add(1, Ordering::Relaxed);
                        }
                        Ok(PushLoopEnd::DroppedRecord) => {}
                        Ok(PushLoopEnd::Stalled) => {
                            break 'run (RecordType::Error, "E_SINK_STALLED", 0, TASK_STALLED)
                        }
                        Ok(PushLoopEnd::Stopped) => {
                            break 'run (RecordType::Error, "E_SINK_CLOSED", 0, TASK_CLOSED)
                        }
                        Err(_) => break 'run (RecordType::Error, "E_SINK_INTERNAL", 0, TASK_ERROR),
                    }
                }
                // Drop-newest liveness (block mode has the fullness loop's
                // deadline instead): heartbeat frozen across `idle_timeout`
                // of arriving data means the consumer is gone.
                if let Some(idle) = config.idle_timeout {
                    let heartbeat = ring.consumer_heartbeat();
                    let now = std::time::Instant::now();
                    match idle_watch {
                        Some((seen, since)) if seen == heartbeat => {
                            if now.duration_since(since) >= idle {
                                break 'run (RecordType::Error, "E_SINK_STALLED", 0, TASK_STALLED);
                            }
                        }
                        _ => idle_watch = Some((heartbeat, now)),
                    }
                }
            }
            Ok(None) => break 'run (RecordType::Eof, "", 0, TASK_EOF),
            Err(wire) => {
                break 'run (
                    wire.kind,
                    wire.code,
                    wire.aux,
                    if wire.kind == RecordType::Reset {
                        TASK_RESET
                    } else {
                        TASK_ERROR
                    },
                )
            }
        }
    };

    let (kind, code, aux, task_state) = outcome;
    if task_state == TASK_STALLED || task_state == TASK_CLOSED {
        source.stop(0);
    } else {
        drop(source);
    }
    let payload = &code.as_bytes()[..code.len().min(MAX_TERMINAL_PAYLOAD_BYTES)];
    let terminal_payload = if kind == RecordType::Error {
        payload
    } else {
        &[]
    };
    ring.push_terminal(
        kind,
        clock_now_ns(config.clock),
        offset,
        terminal_payload,
        aux,
    );
    ring.set_exited();
    counters.task_state.store(task_state, Ordering::Release);
    drop(retain);
    exited.fire();
}

// ---------------------------------------------------------------------------
// napi option/result shapes (consumed by the handle methods in client_stream)
// ---------------------------------------------------------------------------

/// Product floor for the data region: the structural minimum admits tiny
/// test rings, but a product sink below 64 KiB cannot absorb even one
/// scheduling hiccup at latency-critical rates.
pub const PRODUCT_MIN_DATA_CAPACITY: u32 = 64 * 1024;
pub const DEFAULT_BACKPRESSURE_TIMEOUT_MS: f64 = 5000.0;

#[napi(object)]
pub struct StreamSinkFramingOptions {
    pub header_bytes: u32,
    pub length_offset: u32,
    pub length_width: u32,
    /// Default little-endian.
    pub big_endian: Option<bool>,
    /// Default true.
    pub length_includes_header: Option<bool>,
    pub max_frame_bytes: u32,
}

#[napi(object)]
pub struct NativeStreamSinkOptions {
    /// Bytes in the data region; the SAB must hold DATA_OFFSET + this.
    pub data_capacity: u32,
    /// Default false (block: lossless, sender throttles).
    pub drop_newest: Option<bool>,
    /// Default false (monotonic clock).
    pub wall_clock: Option<bool>,
    pub framing: Option<StreamSinkFramingOptions>,
    pub backpressure_timeout_ms: Option<f64>,
    /// Drop-newest liveness deadline; absent/0 = never.
    pub idle_timeout_ms: Option<f64>,
}

#[napi(object)]
pub struct StreamSinkOpenInfo {
    pub data_capacity: u32,
    pub flags: u32,
    /// (monotonic, wall) sampled at the same instant, in microseconds, so a
    /// consumer can map monotonic record stamps into wall time.
    pub monotonic_anchor_us: f64,
    pub wall_anchor_us: f64,
}

#[napi(object)]
pub struct StreamSinkStatsSnapshot {
    pub bytes_in: f64,
    pub records: f64,
    pub pending_partial_bytes: f64,
    /// TASK_* constant; ring-header words (drops, high water, state) are read
    /// by the TS side directly from the SharedArrayBuffer.
    pub task_state: u32,
    pub exited: bool,
}

pub struct ResolvedSinkOptions {
    pub data_capacity: u32,
    pub flags: u32,
    pub mode: OverflowMode,
    pub clock: SinkClock,
    pub framing: Option<FramingConfig>,
    pub backpressure_timeout: std::time::Duration,
    pub idle_timeout: Option<std::time::Duration>,
}

pub fn resolve_sink_options(
    options: &NativeStreamSinkOptions,
) -> std::result::Result<ResolvedSinkOptions, String> {
    if options.data_capacity < PRODUCT_MIN_DATA_CAPACITY {
        return Err(format!(
            "E_SINK_BAD_OPTIONS: ring data capacity {} is below the {} byte product minimum",
            options.data_capacity, PRODUCT_MIN_DATA_CAPACITY
        ));
    }
    let mode = if options.drop_newest.unwrap_or(false) {
        OverflowMode::DropNewest
    } else {
        OverflowMode::Block
    };
    let clock = if options.wall_clock.unwrap_or(false) {
        SinkClock::Wall
    } else {
        SinkClock::Monotonic
    };
    let framing = match &options.framing {
        None => None,
        Some(framing) => {
            let config = FramingConfig {
                header_bytes: framing.header_bytes as usize,
                length_offset: framing.length_offset as usize,
                length_width: framing.length_width as usize,
                little_endian: !framing.big_endian.unwrap_or(false),
                length_includes_header: framing.length_includes_header.unwrap_or(true),
                max_frame_bytes: framing.max_frame_bytes as usize,
            };
            config.validate()?;
            if framing.max_frame_bytes as usize > max_payload_bytes(options.data_capacity) {
                return Err(format!(
                    "E_SINK_BAD_OPTIONS: maxFrameBytes {} exceeds the {} byte cap for this ring",
                    framing.max_frame_bytes,
                    max_payload_bytes(options.data_capacity)
                ));
            }
            Some(config)
        }
    };
    let mut flags = 0u32;
    if framing.is_some() {
        flags |= FLAG_FRAMING;
    }
    if mode == OverflowMode::DropNewest {
        flags |= FLAG_DROP_NEWEST;
    }
    if clock == SinkClock::Wall {
        flags |= FLAG_CLOCK_WALL;
    }
    let backpressure_ms = options
        .backpressure_timeout_ms
        .filter(|ms| *ms > 0.0)
        .unwrap_or(DEFAULT_BACKPRESSURE_TIMEOUT_MS);
    let idle_timeout = options
        .idle_timeout_ms
        .filter(|ms| *ms > 0.0)
        .map(|ms| std::time::Duration::from_millis(ms as u64));
    Ok(ResolvedSinkOptions {
        data_capacity: options.data_capacity,
        flags,
        mode,
        clock,
        framing,
        backpressure_timeout: std::time::Duration::from_millis(backpressure_ms as u64),
        idle_timeout,
    })
}

// ---------------------------------------------------------------------------
// Tests: reference consumer, properties, golden vectors
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Aligned test buffer standing in for a SAB backing store.
    struct TestBuffer(Vec<u64>);

    impl TestBuffer {
        fn new(data_capacity: u32) -> Self {
            Self(vec![0u64; (DATA_OFFSET + data_capacity as usize) / 8])
        }
        fn base(&mut self) -> *mut u8 {
            self.0.as_mut_ptr() as *mut u8
        }
        fn len(&self) -> usize {
            self.0.len() * 8
        }
    }

    #[derive(Debug, Clone, PartialEq, Eq)]
    struct RefRecord {
        kind: u8,
        timestamp_ns: u64,
        stream_offset: u64,
        payload: Vec<u8>,
        aux: u32,
    }

    /// Reference consumer: the Rust twin of the worker-side SinkReader,
    /// used to prove FIFO byte-exactness against the producer.
    struct RefConsumer {
        base: *mut u8,
        data_capacity: u32,
    }

    impl RefConsumer {
        fn new(base: *mut u8, data_capacity: u32) -> Self {
            Self {
                base,
                data_capacity,
            }
        }
        fn atomic_u32(&self, off: usize) -> &AtomicU32 {
            unsafe { &*(self.base.add(off) as *const AtomicU32) }
        }
        fn read_u32(&self, pos: u32, off: usize) -> u32 {
            unsafe {
                (self.base.add(DATA_OFFSET + pos as usize + off) as *const u32).read_unaligned()
            }
        }
        fn read_u64(&self, pos: u32, off: usize) -> u64 {
            unsafe {
                (self.base.add(DATA_OFFSET + pos as usize + off) as *const u64).read_unaligned()
            }
        }
        fn next(&mut self) -> Option<RefRecord> {
            loop {
                let head = self.atomic_u32(OFF_HEAD).load(Ordering::Relaxed);
                let tail = self.atomic_u32(OFF_TAIL).load(Ordering::Acquire);
                if head == tail {
                    return None;
                }
                let pos = head & (self.data_capacity - 1);
                let rec_len = u32::from_le(self.read_u32(pos, 0));
                let kind = unsafe { self.base.add(DATA_OFFSET + pos as usize + 4).read() };
                if kind == RecordType::Wrap as u8 {
                    self.atomic_u32(OFF_HEAD)
                        .store(head.wrapping_add(rec_len), Ordering::Release);
                    continue;
                }
                let payload_len = u32::from_le(self.read_u32(pos, 24)) as usize;
                let mut payload = vec![0u8; payload_len];
                unsafe {
                    std::ptr::copy_nonoverlapping(
                        self.base
                            .add(DATA_OFFSET + pos as usize + RECORD_HEADER_BYTES),
                        payload.as_mut_ptr(),
                        payload_len,
                    );
                }
                let record = RefRecord {
                    kind,
                    timestamp_ns: u64::from_le(self.read_u64(pos, 8)),
                    stream_offset: u64::from_le(self.read_u64(pos, 16)),
                    payload,
                    aux: u32::from_le(self.read_u32(pos, 28)),
                };
                self.atomic_u32(OFF_HEAD)
                    .store(head.wrapping_add(rec_len), Ordering::Release);
                self.atomic_u32(OFF_HEARTBEAT)
                    .fetch_add(1, Ordering::Relaxed);
                return Some(record);
            }
        }
    }

    /// Deterministic xorshift so fuzz loops are reproducible.
    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            let mut x = self.0;
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            self.0 = x;
            x
        }
        fn below(&mut self, bound: usize) -> usize {
            (self.next() % bound as u64) as usize
        }
    }

    fn patterned(seq: u64, len: usize) -> Vec<u8> {
        (0..len)
            .map(|i| ((seq as usize).wrapping_add(i) % 251) as u8)
            .collect()
    }

    #[test]
    fn init_validates_geometry() {
        let mut buffer = TestBuffer::new(1024);
        let base = buffer.base();
        let len = buffer.len();
        unsafe {
            assert!(SinkRing::init(base, len, 1000, 0, OverflowMode::Block).is_err());
            assert!(SinkRing::init(base, len, 512, 0, OverflowMode::Block).is_err());
            assert!(SinkRing::init(base, 100, 1024, 0, OverflowMode::Block).is_err());
            let ring = SinkRing::init(base, len, 1024, FLAG_FRAMING, OverflowMode::Block).unwrap();
            assert_eq!(ring.state(), STATE_ACTIVE);
        }
        let consumer = RefConsumer::new(base, 1024);
        assert_eq!(
            consumer.atomic_u32(OFF_MAGIC).load(Ordering::Relaxed),
            MAGIC
        );
        assert_eq!(
            consumer.atomic_u32(OFF_VERSION).load(Ordering::Relaxed),
            LAYOUT_VERSION
        );
        assert_eq!(
            consumer.atomic_u32(OFF_FLAGS).load(Ordering::Relaxed),
            FLAG_FRAMING
        );
    }

    #[test]
    fn round_trip_preserves_records_exactly() {
        let mut buffer = TestBuffer::new(4096);
        let base = buffer.base();
        let len = buffer.len();
        let mut ring = unsafe { SinkRing::init(base, len, 4096, 0, OverflowMode::Block).unwrap() };
        let mut consumer = RefConsumer::new(base, 4096);
        let payloads = [3usize, 0, 17, 256, 800];
        for (i, plen) in payloads.iter().enumerate() {
            let payload = patterned(i as u64, *plen);
            assert_eq!(
                ring.push(RecordType::Data, 1000 + i as u64, 10 * i as u64, &payload)
                    .unwrap(),
                PushOutcome::Written
            );
        }
        assert!(ring.push_terminal(RecordType::Eof, 9999, 1076, &[], 0));
        for (i, plen) in payloads.iter().enumerate() {
            let record = consumer.next().expect("record present");
            assert_eq!(record.kind, RecordType::Data as u8);
            assert_eq!(record.timestamp_ns, 1000 + i as u64);
            assert_eq!(record.stream_offset, 10 * i as u64);
            assert_eq!(record.payload, patterned(i as u64, *plen));
        }
        let eof = consumer.next().expect("terminal present");
        assert_eq!(eof.kind, RecordType::Eof as u8);
        assert_eq!(eof.stream_offset, 1076);
        assert!(consumer.next().is_none());
    }

    #[test]
    fn fuzz_wraparound_fifo_integrity() {
        let cap: u32 = 4096;
        let mut buffer = TestBuffer::new(cap);
        let base = buffer.base();
        let len = buffer.len();
        let mut ring = unsafe { SinkRing::init(base, len, cap, 0, OverflowMode::Block).unwrap() };
        let mut consumer = RefConsumer::new(base, cap);
        let mut rng = Rng(0x5744_2026);
        let mut next_seq: u64 = 0;
        let mut expect_seq: u64 = 0;
        let mut offset: u64 = 0;
        for _ in 0..200_000 {
            if rng.next().is_multiple_of(2) {
                let plen = rng.below(max_payload_bytes(cap) + 1);
                let payload = patterned(next_seq, plen);
                match ring
                    .push(RecordType::Data, next_seq, offset, &payload)
                    .unwrap()
                {
                    PushOutcome::Written => {
                        next_seq += 1;
                        offset += plen as u64;
                    }
                    PushOutcome::WouldBlock => {
                        let record = consumer.next().expect("full ring must have records");
                        assert_eq!(record.timestamp_ns, expect_seq);
                        assert_eq!(record.payload, patterned(expect_seq, record.payload.len()));
                        expect_seq += 1;
                    }
                    PushOutcome::Dropped => unreachable!("block mode never drops"),
                }
            } else if let Some(record) = consumer.next() {
                assert_eq!(record.timestamp_ns, expect_seq, "FIFO order violated");
                assert_eq!(record.payload, patterned(expect_seq, record.payload.len()));
                expect_seq += 1;
            }
        }
        while let Some(record) = consumer.next() {
            assert_eq!(record.timestamp_ns, expect_seq);
            expect_seq += 1;
        }
        assert_eq!(expect_seq, next_seq);
        assert!(ring.high_water_bytes() > 0);
        assert!(ring.consumer_heartbeat() > 0);
    }

    #[test]
    fn cursor_wraparound_across_u32_boundary() {
        let cap: u32 = 1024;
        let mut buffer = TestBuffer::new(cap);
        let base = buffer.base();
        let len = buffer.len();
        let mut ring = unsafe { SinkRing::init(base, len, cap, 0, OverflowMode::Block).unwrap() };
        // Park both free-running cursors just below u32::MAX at a position
        // that is ring-aligned (a multiple of cap keeps geometry honest).
        let start = u32::MAX - (u32::MAX % cap) - 4 * cap;
        ring.config_u32(OFF_TAIL).store(start, Ordering::Relaxed);
        ring.config_u32(OFF_HEAD).store(start, Ordering::Relaxed);
        let mut consumer = RefConsumer::new(base, cap);
        let mut expect = 0u64;
        for seq in 0..2_000u64 {
            let payload = patterned(seq, 100);
            loop {
                match ring.push(RecordType::Data, seq, 0, &payload).unwrap() {
                    PushOutcome::Written => break,
                    PushOutcome::WouldBlock => {
                        let record = consumer.next().unwrap();
                        assert_eq!(record.timestamp_ns, expect);
                        expect += 1;
                    }
                    PushOutcome::Dropped => unreachable!(),
                }
            }
        }
        while let Some(record) = consumer.next() {
            assert_eq!(record.timestamp_ns, expect);
            expect += 1;
        }
        assert_eq!(expect, 2_000);
        // Both cursors crossed the 2^32 boundary during the run.
        assert!(ring.tail() < start);
    }

    #[test]
    fn drop_newest_counts_and_discloses_gap() {
        let cap: u32 = 1024;
        let mut buffer = TestBuffer::new(cap);
        let base = buffer.base();
        let len = buffer.len();
        let mut ring = unsafe {
            SinkRing::init(base, len, cap, FLAG_DROP_NEWEST, OverflowMode::DropNewest).unwrap()
        };
        let mut consumer = RefConsumer::new(base, cap);
        let payload = patterned(0, 200);
        let mut written = 0u64;
        let mut offset = 0u64;
        // Fill until drops start.
        loop {
            match ring
                .push(RecordType::Data, written, offset, &payload)
                .unwrap()
            {
                PushOutcome::Written => {
                    written += 1;
                    offset += payload.len() as u64;
                }
                PushOutcome::Dropped => break,
                PushOutcome::WouldBlock => unreachable!("drop mode never blocks"),
            }
        }
        let gap_start = offset;
        // Two more drops accumulate into the same pending gap.
        for _ in 0..2 {
            assert_eq!(
                ring.push(RecordType::Data, 99, offset, &payload).unwrap(),
                PushOutcome::Dropped
            );
            offset += payload.len() as u64;
        }
        assert_eq!(ring.dropped_records(), 3);
        assert_eq!(ring.dropped_bytes(), 3 * payload.len() as u64);
        // Drain one record; the next push must disclose the gap first.
        consumer.next().unwrap();
        consumer.next().unwrap();
        assert_eq!(
            ring.push(RecordType::Data, written, offset, &payload)
                .unwrap(),
            PushOutcome::Written
        );
        let mut kinds = Vec::new();
        while let Some(record) = consumer.next() {
            if record.kind == RecordType::DropGap as u8 {
                assert_eq!(record.aux, 3);
                assert_eq!(record.stream_offset, gap_start);
            }
            kinds.push(record.kind);
        }
        assert!(kinds.contains(&(RecordType::DropGap as u8)));
        // The gap precedes the record written after it.
        let gap_index = kinds
            .iter()
            .position(|k| *k == RecordType::DropGap as u8)
            .unwrap();
        assert_eq!(kinds[gap_index + 1], RecordType::Data as u8);
    }

    #[test]
    fn terminal_always_commits_and_is_exactly_once() {
        let cap: u32 = 1024;
        // Sweep tail geometry: park the tail at every 8-byte alignment class
        // near the region end, fill to the usable limit, and require the
        // terminal to commit from the reserve every time.
        for park in 0..28u32 {
            let mut buffer = TestBuffer::new(cap);
            let base = buffer.base();
            let len = buffer.len();
            let mut ring =
                unsafe { SinkRing::init(base, len, cap, 0, OverflowMode::Block).unwrap() };
            let mut consumer = RefConsumer::new(base, cap);
            // Position the tail: write one record whose padded length lands
            // the tail at an arbitrary spot, then drain it so fill is zero.
            let plen = (park * 8) as usize;
            ring.push(RecordType::Data, 0, 0, &patterned(0, plen))
                .unwrap();
            consumer.next().unwrap();
            // Fill with mid-size records until WouldBlock.
            let filler = patterned(1, 96);
            while ring.push(RecordType::Data, 1, 0, &filler).unwrap() == PushOutcome::Written {}
            // Terminal with the largest allowed payload must still commit.
            let code = b"E_SINK_STALLED_MAX_LEN_PAD_PAD__";
            assert_eq!(code.len(), MAX_TERMINAL_PAYLOAD_BYTES);
            assert!(ring.push_terminal(RecordType::Error, 7, 0, code, 0));
            assert!(!ring.push_terminal(RecordType::Error, 8, 0, code, 0));
            assert_eq!(ring.state(), STATE_TERMINAL_COMMITTED);
            // The consumer sees every filler record, then the terminal, in
            // order and intact.
            let mut last = None;
            while let Some(record) = consumer.next() {
                last = Some(record);
            }
            let last = last.unwrap();
            assert_eq!(last.kind, RecordType::Error as u8);
            assert_eq!(last.payload, code);
        }
    }

    #[test]
    fn exited_state_is_visible() {
        let mut buffer = TestBuffer::new(1024);
        let base = buffer.base();
        let len = buffer.len();
        let ring = unsafe {
            SinkRing::init(base, len, 1024, FLAG_PRODUCER_NOTIFIES, OverflowMode::Block).unwrap()
        };
        ring.set_exited();
        assert_eq!(ring.state(), STATE_EXITED);
        let consumer = RefConsumer::new(base, 1024);
        assert_eq!(
            consumer.atomic_u32(OFF_FLAGS).load(Ordering::Relaxed),
            FLAG_PRODUCER_NOTIFIES
        );
    }

    #[test]
    fn deframer_cuts_frames_at_every_split_point() {
        let config = FramingConfig {
            header_bytes: 8,
            length_offset: 2,
            length_width: 2,
            little_endian: true,
            length_includes_header: false,
            max_frame_bytes: 512,
        };
        // Three frames with varied payload sizes, concatenated.
        let mut wire = Vec::new();
        let mut frames = Vec::new();
        for (seq, plen) in [(1u8, 0usize), (2, 33), (3, 120)] {
            let mut frame = vec![seq, 0xAA, 0, 0, 0, 0, 0, 0];
            frame[2..4].copy_from_slice(&(plen as u16).to_le_bytes());
            frame.extend(patterned(seq as u64, plen));
            wire.extend_from_slice(&frame);
            frames.push(frame);
        }
        for split in 0..=wire.len() {
            let mut deframer = Deframer::new(config.clone()).unwrap();
            let mut seen: Vec<Vec<u8>> = Vec::new();
            for chunk in [&wire[..split], &wire[split..]] {
                deframer
                    .push::<String>(chunk, |frame| {
                        seen.push(frame.to_vec());
                        Ok(())
                    })
                    .unwrap();
            }
            assert_eq!(seen, frames, "split at {split}");
            assert_eq!(deframer.pending_bytes(), 0);
        }
    }

    #[test]
    fn deframer_variants_and_faults() {
        // Big-endian, length includes header.
        let config = FramingConfig {
            header_bytes: 4,
            length_offset: 0,
            length_width: 4,
            little_endian: false,
            length_includes_header: true,
            max_frame_bytes: 64,
        };
        let mut deframer = Deframer::new(config.clone()).unwrap();
        let mut frame = 12u32.to_be_bytes().to_vec();
        frame.extend(patterned(9, 8));
        let mut seen = 0;
        deframer
            .push::<String>(&frame, |f| {
                assert_eq!(f.len(), 12);
                seen += 1;
                Ok(())
            })
            .unwrap();
        assert_eq!(seen, 1);
        // Claimed length below header size is a wire fault.
        let mut deframer = Deframer::new(config.clone()).unwrap();
        assert!(deframer
            .push::<String>(&2u32.to_be_bytes(), |_| Ok(()))
            .is_err());
        // Oversized frame is a wire fault.
        let mut deframer = Deframer::new(config).unwrap();
        assert!(deframer
            .push::<String>(&65u32.to_be_bytes(), |_| Ok(()))
            .is_err());
        // Invalid configs are rejected up front.
        assert!(Deframer::new(FramingConfig {
            header_bytes: 0,
            length_offset: 0,
            length_width: 1,
            little_endian: true,
            length_includes_header: false,
            max_frame_bytes: 16,
        })
        .is_err());
        assert!(Deframer::new(FramingConfig {
            header_bytes: 4,
            length_offset: 3,
            length_width: 2,
            little_endian: true,
            length_includes_header: false,
            max_frame_bytes: 16,
        })
        .is_err());
    }

    struct TaskHarness {
        tx: tokio::sync::mpsc::Sender<std::result::Result<bytes::Bytes, SinkWireError>>,
        counters: std::sync::Arc<SinkCounters>,
        stop: std::sync::Arc<SinkStop>,
        exited: std::sync::Arc<SinkStop>,
        task: tokio::task::JoinHandle<()>,
    }

    /// Drive `run_sink_task` over the test source against a caller-owned
    /// buffer. The buffer must outlive the task; tests await `task` before
    /// dropping it.
    fn spawn_task_harness(
        buffer: &mut TestBuffer,
        data_capacity: u32,
        flags: u32,
        mode: OverflowMode,
        config_framing: Option<FramingConfig>,
        backpressure_timeout: std::time::Duration,
        idle_timeout: Option<std::time::Duration>,
    ) -> TaskHarness {
        let base = buffer.base();
        let len = buffer.len();
        let ring = unsafe { SinkRing::init(base, len, data_capacity, flags, mode).unwrap() };
        let (tx, rx) = tokio::sync::mpsc::channel(16);
        let counters = std::sync::Arc::new(SinkCounters::default());
        let stop = std::sync::Arc::new(SinkStop::new());
        let exited = std::sync::Arc::new(SinkStop::new());
        let config = SinkTaskConfig {
            clock: SinkClock::Monotonic,
            framing: config_framing.map(|f| Deframer::new(f).unwrap()),
            backpressure_timeout,
            idle_timeout,
            base_offset: 0,
        };
        let task = tokio::spawn(run_sink_task(
            SinkSource::Test(rx),
            ring,
            config,
            std::sync::Arc::clone(&counters),
            std::sync::Arc::clone(&stop),
            std::sync::Arc::clone(&exited),
            (),
        ));
        TaskHarness {
            tx,
            counters,
            stop,
            exited,
            task,
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn task_raw_mode_records_chunks_and_eof() {
        let cap: u32 = 4096;
        let mut buffer = TestBuffer::new(cap);
        let harness = spawn_task_harness(
            &mut buffer,
            cap,
            0,
            OverflowMode::Block,
            None,
            std::time::Duration::from_secs(5),
            None,
        );
        for seq in 0..3u64 {
            harness
                .tx
                .send(Ok(bytes::Bytes::from(patterned(seq, 50))))
                .await
                .unwrap();
        }
        drop(harness.tx); // channel close = EOF
        harness.task.await.unwrap();
        assert!(harness.exited.fired());
        assert_eq!(harness.counters.records.load(Ordering::Relaxed), 3);
        assert_eq!(harness.counters.bytes_in.load(Ordering::Relaxed), 150);
        assert_eq!(
            harness.counters.task_state.load(Ordering::Acquire),
            TASK_EOF
        );
        let mut consumer = RefConsumer::new(buffer.base(), cap);
        for seq in 0..3u64 {
            let record = consumer.next().unwrap();
            assert_eq!(record.kind, RecordType::Data as u8);
            assert_eq!(record.stream_offset, seq * 50);
            assert_eq!(record.payload, patterned(seq, 50));
            assert!(record.timestamp_ns > 0);
        }
        let terminal = consumer.next().unwrap();
        assert_eq!(terminal.kind, RecordType::Eof as u8);
        assert_eq!(terminal.stream_offset, 150);
        assert!(consumer.next().is_none());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn task_framed_mode_emits_messages_and_faults() {
        let framing = FramingConfig {
            header_bytes: 4,
            length_offset: 0,
            length_width: 2,
            little_endian: true,
            length_includes_header: false,
            max_frame_bytes: 256,
        };
        let cap: u32 = 4096;
        let mut buffer = TestBuffer::new(cap);
        let harness = spawn_task_harness(
            &mut buffer,
            cap,
            FLAG_FRAMING,
            OverflowMode::Block,
            Some(framing),
            std::time::Duration::from_secs(5),
            None,
        );
        // Two frames, the second split across chunks.
        let mut frame_a = vec![10, 0, 0xAA, 0xBB];
        frame_a[0..2].copy_from_slice(&10u16.to_le_bytes());
        frame_a.extend(patterned(1, 10));
        let mut frame_b = vec![0, 0, 0xCC, 0xDD];
        frame_b[0..2].copy_from_slice(&30u16.to_le_bytes());
        frame_b.extend(patterned(2, 30));
        let mut wire = frame_a.clone();
        wire.extend_from_slice(&frame_b);
        let (first, second) = wire.split_at(frame_a.len() + 7);
        harness
            .tx
            .send(Ok(bytes::Bytes::copy_from_slice(first)))
            .await
            .unwrap();
        harness
            .tx
            .send(Ok(bytes::Bytes::copy_from_slice(second)))
            .await
            .unwrap();
        // A frame claiming more than max_frame_bytes is a wire fault.
        let mut oversized = vec![0, 0, 0, 0];
        oversized[0..2].copy_from_slice(&1000u16.to_le_bytes());
        harness
            .tx
            .send(Ok(bytes::Bytes::from(oversized)))
            .await
            .unwrap();
        harness.task.await.unwrap();
        assert_eq!(
            harness.counters.task_state.load(Ordering::Acquire),
            TASK_ERROR
        );
        let mut consumer = RefConsumer::new(buffer.base(), cap);
        let a = consumer.next().unwrap();
        assert_eq!(a.kind, RecordType::Message as u8);
        assert_eq!(a.payload, frame_a);
        assert_eq!(a.stream_offset, 0);
        let b = consumer.next().unwrap();
        assert_eq!(b.payload, frame_b);
        assert_eq!(b.stream_offset, frame_a.len() as u64);
        let terminal = consumer.next().unwrap();
        assert_eq!(terminal.kind, RecordType::Error as u8);
        assert_eq!(terminal.payload, b"E_SINK_FRAME_FAULT");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn task_block_mode_stalls_without_consumer_heartbeat() {
        let cap: u32 = MIN_DATA_CAPACITY;
        let mut buffer = TestBuffer::new(cap);
        let harness = spawn_task_harness(
            &mut buffer,
            cap,
            0,
            OverflowMode::Block,
            None,
            std::time::Duration::from_millis(80),
            None,
        );
        // More bytes than the ring holds, and nobody drains.
        for seq in 0..16u64 {
            if harness
                .tx
                .send(Ok(bytes::Bytes::from(patterned(seq, 200))))
                .await
                .is_err()
            {
                break;
            }
        }
        harness.task.await.unwrap();
        assert_eq!(
            harness.counters.task_state.load(Ordering::Acquire),
            TASK_STALLED
        );
        // The terminal committed from the reserve even though the ring was
        // full; it is the last record.
        let mut consumer = RefConsumer::new(buffer.base(), cap);
        let mut last = None;
        while let Some(record) = consumer.next() {
            last = Some(record);
        }
        let last = last.unwrap();
        assert_eq!(last.kind, RecordType::Error as u8);
        assert_eq!(last.payload, b"E_SINK_STALLED");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn task_stop_commits_closed_terminal() {
        let cap: u32 = 4096;
        let mut buffer = TestBuffer::new(cap);
        let harness = spawn_task_harness(
            &mut buffer,
            cap,
            0,
            OverflowMode::Block,
            None,
            std::time::Duration::from_secs(5),
            None,
        );
        harness
            .tx
            .send(Ok(bytes::Bytes::from(patterned(0, 20))))
            .await
            .unwrap();
        harness.stop.fire();
        harness.task.await.unwrap();
        assert_eq!(
            harness.counters.task_state.load(Ordering::Acquire),
            TASK_CLOSED
        );
        let mut consumer = RefConsumer::new(buffer.base(), cap);
        let mut last = None;
        while let Some(record) = consumer.next() {
            last = Some(record);
        }
        assert_eq!(last.unwrap().payload, b"E_SINK_CLOSED");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn task_wire_reset_carries_app_code() {
        let cap: u32 = 4096;
        let mut buffer = TestBuffer::new(cap);
        let harness = spawn_task_harness(
            &mut buffer,
            cap,
            0,
            OverflowMode::Block,
            None,
            std::time::Duration::from_secs(5),
            None,
        );
        harness
            .tx
            .send(Err(SinkWireError {
                kind: RecordType::Reset,
                code: "E_STREAM_RESET",
                aux: 42,
            }))
            .await
            .unwrap();
        harness.task.await.unwrap();
        assert_eq!(
            harness.counters.task_state.load(Ordering::Acquire),
            TASK_RESET
        );
        let mut consumer = RefConsumer::new(buffer.base(), cap);
        let terminal = consumer.next().unwrap();
        assert_eq!(terminal.kind, RecordType::Reset as u8);
        assert_eq!(terminal.aux, 42);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn task_drop_newest_survives_full_ring_and_idle_deadline_ends_it() {
        let cap: u32 = MIN_DATA_CAPACITY;
        let mut buffer = TestBuffer::new(cap);
        let harness = spawn_task_harness(
            &mut buffer,
            cap,
            FLAG_DROP_NEWEST,
            OverflowMode::DropNewest,
            None,
            std::time::Duration::from_secs(5),
            Some(std::time::Duration::from_millis(60)),
        );
        let before = SINK_DROPPED_RECORDS_TOTAL.load(Ordering::Relaxed);
        // Keep sending well past capacity: never blocks, drops instead, and
        // the idle deadline (heartbeat frozen) eventually ends the task.
        let start = std::time::Instant::now();
        loop {
            if harness
                .tx
                .send(Ok(bytes::Bytes::from(patterned(0, 200))))
                .await
                .is_err()
            {
                break;
            }
            if start.elapsed() > std::time::Duration::from_secs(3) {
                panic!("idle deadline never fired");
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        harness.task.await.unwrap();
        assert_eq!(
            harness.counters.task_state.load(Ordering::Acquire),
            TASK_STALLED
        );
        assert!(SINK_DROPPED_RECORDS_TOTAL.load(Ordering::Relaxed) > before);
    }

    /// Byte-exact pin of LAYOUT_VERSION 1: a fixed scenario must serialize
    /// to exactly these bytes. The TS RingWriter/SinkReader (phases 4-5)
    /// replay this same scenario against this dump. If this test breaks, the
    /// layout changed: bump LAYOUT_VERSION or fix the regression.
    #[test]
    fn golden_vector_layout_v1() {
        let cap: u32 = 1024;
        let mut buffer = TestBuffer::new(cap);
        let base = buffer.base();
        let len = buffer.len();
        let mut ring = unsafe {
            SinkRing::init(
                base,
                len,
                cap,
                FLAG_FRAMING | FLAG_CLOCK_WALL,
                OverflowMode::Block,
            )
            .unwrap()
        };
        ring.push(RecordType::Data, 0x0102_0304_0506_0708, 0, &patterned(7, 5))
            .unwrap();
        ring.push(
            RecordType::Message,
            0x1112_1314_1516_1718,
            5,
            &patterned(8, 40),
        )
        .unwrap();
        ring.push_terminal(RecordType::Reset, 0x2122_2324_2526_2728, 45, &[], 77);

        let dump: Vec<u8> = (0..DATA_OFFSET + 160)
            .map(|i| unsafe { base.add(i).read() })
            .collect();
        let hex: String = dump.iter().map(|b| format!("{b:02x}")).collect();
        // Spot-check the load-bearing fields before pinning the whole dump:
        // records at 0 / 40 / 112 (recLen 40, 72, 32), TAIL = 144.
        let consumer = RefConsumer::new(base, cap);
        assert_eq!(consumer.atomic_u32(OFF_TAIL).load(Ordering::Relaxed), 144);
        assert_eq!(consumer.read_u32(0, 0), 40);
        assert_eq!(consumer.read_u32(40, 0), 72);
        assert_eq!(consumer.read_u32(112, 0), 32);
        assert_eq!(consumer.read_u32(112, 28), 77);
        let expected = "4b535457010000000004000005000000c00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000900000000100000000000000000000000000000000000000900000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000028000000010000000807060504030201000000000000000005000000000000000708090a0b000000480000000200000018171615141312110500000000000000280000000000000008090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f200000000500000028272625242322212d00000000000000000000004d00000000000000000000000000000000000000";
        assert_eq!(hex, expected, "layout v1 golden vector drifted");
    }
}
