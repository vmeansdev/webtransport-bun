//! Minimal HTTP/3 + WebTransport framing with bounded dynamic QPACK.
//!
//! Wire constants per RFC 9114 (HTTP/3), RFC 9204 (QPACK), RFC 9297 (datagrams),
//! and draft-ietf-webtrans-http3.
//!
//! Dynamic QPACK support is foundational (Phase 2): a capped dynamic table,
//! encoder-stream inserts, and indexed dynamic field-line decode. Full claim
//! pass still needs broader encoder strategies, decoder-stream acks, and interop
//! evidence — see remaining gaps in module tests / `docs/WASM_PROTOCOL_SCOPE.md`.

use std::collections::VecDeque;

use crate::varint;

pub mod stream_type {
    pub const CONTROL: u64 = 0x00;
    pub const QPACK_ENCODER: u64 = 0x02;
    pub const QPACK_DECODER: u64 = 0x03;
    pub const WT_UNI: u64 = 0x54;
}
pub mod frame {
    pub const DATA: u64 = 0x00;
    pub const HEADERS: u64 = 0x01;
    pub const SETTINGS: u64 = 0x04;
    pub const WT_BIDI: u64 = 0x41;
}
pub mod setting {
    pub const QPACK_MAX_TABLE_CAPACITY: u64 = 0x01;
    pub const QPACK_BLOCKED_STREAMS: u64 = 0x07;
    pub const ENABLE_CONNECT_PROTOCOL: u64 = 0x08;
    pub const H3_DATAGRAM: u64 = 0x33;
    pub const ENABLE_WEBTRANSPORT: u64 = 0x2b60_3742;
    pub const WEBTRANSPORT_MAX_SESSIONS: u64 = 0x2b60_3743;
}

/// Production-safe default dynamic-table capacity (bytes), advertised in SETTINGS.
pub const DEFAULT_QPACK_MAX_TABLE_CAPACITY: u64 = 4096;
/// Conservative default for SETTINGS_QPACK_BLOCKED_STREAMS.
pub const DEFAULT_QPACK_BLOCKED_STREAMS: u64 = 16;

/// Local QPACK SETTINGS we advertise (and bound decoder state against).
/// Set either field to `0` for literal-only / no-blocking compat.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct QpackLocalSettings {
    pub max_table_capacity: u64,
    pub max_blocked_streams: u64,
}

impl Default for QpackLocalSettings {
    fn default() -> Self {
        Self {
            max_table_capacity: DEFAULT_QPACK_MAX_TABLE_CAPACITY,
            max_blocked_streams: DEFAULT_QPACK_BLOCKED_STREAMS,
        }
    }
}

impl QpackLocalSettings {
    /// Compat mode: advertise zero capacity / blocked streams (literal-only).
    pub const fn disabled() -> Self {
        Self {
            max_table_capacity: 0,
            max_blocked_streams: 0,
        }
    }
}

/// Encode the control-stream preamble: stream type byte + a SETTINGS frame
/// advertising WebTransport + H3 datagrams + QPACK limits (defaults).
pub fn encode_control_preamble(max_sessions: u64) -> Vec<u8> {
    // Production/Chromium-facing default: advertise zero QPACK table capacity
    // until decoder-stream ACKs are complete. Opt into dynamic QPACK via
    // `encode_control_preamble_with` + non-zero `QpackLocalSettings`.
    encode_control_preamble_with(max_sessions, &QpackLocalSettings::disabled())
}

/// Encode control preamble with explicit QPACK SETTINGS (use
/// [`QpackLocalSettings::disabled`] for zero-capacity compat).
pub fn encode_control_preamble_with(max_sessions: u64, qpack: &QpackLocalSettings) -> Vec<u8> {
    let mut payload = Vec::new();
    let pairs = [
        (setting::QPACK_MAX_TABLE_CAPACITY, qpack.max_table_capacity),
        (setting::QPACK_BLOCKED_STREAMS, qpack.max_blocked_streams),
        (setting::ENABLE_CONNECT_PROTOCOL, 1),
        (setting::H3_DATAGRAM, 1),
        (setting::ENABLE_WEBTRANSPORT, 1),
        (setting::WEBTRANSPORT_MAX_SESSIONS, max_sessions),
    ];
    for (id, val) in pairs {
        varint::encode(id, &mut payload);
        varint::encode(val, &mut payload);
    }
    let mut out = Vec::new();
    varint::encode(stream_type::CONTROL, &mut out);
    varint::encode(frame::SETTINGS, &mut out);
    varint::encode(payload.len() as u64, &mut out);
    out.extend_from_slice(&payload);
    out
}

#[derive(Default, Debug, PartialEq, Eq)]
pub struct PeerSettings {
    pub webtransport: bool,
    pub h3_datagram: bool,
    pub connect_protocol: bool,
    pub max_sessions: u64,
    /// Peer's SETTINGS_QPACK_MAX_TABLE_CAPACITY (0 if absent).
    pub qpack_max_table_capacity: u64,
    /// Peer's SETTINGS_QPACK_BLOCKED_STREAMS (0 if absent).
    pub qpack_blocked_streams: u64,
}

/// Parse a SETTINGS frame payload (after type+length already stripped).
pub fn parse_settings(mut payload: &[u8]) -> Option<PeerSettings> {
    let mut s = PeerSettings::default();
    while !payload.is_empty() {
        let (id, n1) = varint::decode(payload)?;
        payload = &payload[n1..];
        let (val, n2) = varint::decode(payload)?;
        payload = &payload[n2..];
        match id {
            setting::ENABLE_WEBTRANSPORT => s.webtransport = val == 1,
            setting::H3_DATAGRAM => s.h3_datagram = val == 1,
            setting::ENABLE_CONNECT_PROTOCOL => s.connect_protocol = val == 1,
            setting::WEBTRANSPORT_MAX_SESSIONS => s.max_sessions = val,
            setting::QPACK_MAX_TABLE_CAPACITY => s.qpack_max_table_capacity = val,
            setting::QPACK_BLOCKED_STREAMS => s.qpack_blocked_streams = val,
            _ => {}
        }
    }
    Some(s)
}

/// QPACK decode / encoder-stream errors.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QpackError {
    /// Field section references inserts not yet received (may unblock later).
    Blocked,
    /// Malformed encoding, OOB index, capacity abuse, or hard protocol violation.
    Invalid,
}

#[derive(Debug, Clone)]
struct DynEntry {
    name: String,
    value: String,
}

/// Bounded QPACK dynamic table (RFC 9204 §3.2).
#[derive(Debug, Clone)]
pub struct DynamicTable {
    /// Oldest at front, newest at back.
    entries: VecDeque<DynEntry>,
    /// Current capacity (bytes); starts at 0 until Set Capacity.
    capacity: usize,
    /// SETTINGS / local hard cap.
    max_capacity: usize,
    /// Sum of entry sizes currently in the table.
    size: usize,
    /// Total inserts ever (absolute index of newest entry when non-empty).
    insert_count: u64,
}

impl DynamicTable {
    pub fn new(max_capacity: usize) -> Self {
        Self {
            entries: VecDeque::new(),
            capacity: 0,
            max_capacity,
            size: 0,
            insert_count: 0,
        }
    }

    pub fn insert_count(&self) -> u64 {
        self.insert_count
    }

    pub fn capacity(&self) -> usize {
        self.capacity
    }

    pub fn max_capacity(&self) -> usize {
        self.max_capacity
    }

    pub fn size(&self) -> usize {
        self.size
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    fn entry_size(name: &str, value: &str) -> usize {
        name.len().saturating_add(value.len()).saturating_add(32)
    }

    /// RFC 9204 §4.3.1 — capacity must not exceed the SETTINGS max.
    pub fn set_capacity(&mut self, capacity: usize) -> Result<(), QpackError> {
        if capacity > self.max_capacity {
            return Err(QpackError::Invalid);
        }
        self.capacity = capacity;
        self.evict_to_fit(0);
        Ok(())
    }

    /// Insert a name/value pair, evicting oldest entries as needed.
    pub fn insert(&mut self, name: String, value: String) -> Result<(), QpackError> {
        let sz = Self::entry_size(&name, &value);
        if sz > self.capacity {
            // Entry larger than current capacity: drop it (and empty the table)
            // per RFC 9204 §3.2.2 — not a hard error.
            self.evict_to_fit(usize::MAX);
            return Ok(());
        }
        self.evict_to_fit(sz);
        self.entries.push_back(DynEntry { name, value });
        self.size = self.size.saturating_add(sz);
        self.insert_count = self.insert_count.saturating_add(1);
        Ok(())
    }

    fn evict_to_fit(&mut self, additional: usize) {
        while !self.entries.is_empty()
            && (additional == usize::MAX || self.size.saturating_add(additional) > self.capacity)
        {
            if let Some(e) = self.entries.pop_front() {
                self.size = self
                    .size
                    .saturating_sub(Self::entry_size(&e.name, &e.value));
            }
            if additional == usize::MAX && self.entries.is_empty() {
                break;
            }
        }
    }

    fn oldest_absolute(&self) -> Option<u64> {
        if self.entries.is_empty() {
            None
        } else {
            Some(self.insert_count - self.entries.len() as u64 + 1)
        }
    }

    /// Look up by absolute index (1-based). `None` if missing / evicted / OOB.
    pub fn get_absolute(&self, abs: u64) -> Option<(&str, &str)> {
        if abs == 0 {
            return None;
        }
        let oldest = self.oldest_absolute()?;
        if abs < oldest || abs > self.insert_count {
            return None;
        }
        let idx = (abs - oldest) as usize;
        let e = self.entries.get(idx)?;
        Some((e.name.as_str(), e.value.as_str()))
    }

    /// Relative index w.r.t. Base (RFC 9204 §3.2.5): abs = Base - rel - 1.
    pub fn get_relative(&self, relative: u64, base: u64) -> Option<(&str, &str)> {
        let abs = base.checked_sub(relative)?.checked_sub(1)?;
        self.get_absolute(abs)
    }

    /// Post-base index (RFC 9204 §4.5.3): abs = Base + post + 1.
    pub fn get_post_base(&self, post: u64, base: u64) -> Option<(&str, &str)> {
        let abs = base.checked_add(post)?.checked_add(1)?;
        self.get_absolute(abs)
    }
}

/// Decoder-side QPACK state: dynamic table + blocked-stream limit.
#[derive(Debug, Clone)]
pub struct QpackDecoder {
    table: DynamicTable,
    max_blocked_streams: u64,
}

impl QpackDecoder {
    pub fn new(settings: &QpackLocalSettings) -> Self {
        let max_cap = usize::try_from(settings.max_table_capacity).unwrap_or(usize::MAX);
        Self {
            table: DynamicTable::new(max_cap),
            max_blocked_streams: settings.max_blocked_streams,
        }
    }

    pub fn disabled() -> Self {
        Self::new(&QpackLocalSettings::disabled())
    }

    pub fn table(&self) -> &DynamicTable {
        &self.table
    }

    pub fn table_mut(&mut self) -> &mut DynamicTable {
        &mut self.table
    }

    pub fn max_blocked_streams(&self) -> u64 {
        self.max_blocked_streams
    }

    pub fn max_table_capacity(&self) -> u64 {
        self.table.max_capacity() as u64
    }
}

impl Default for QpackDecoder {
    /// Matches [`encode_control_preamble`]: zero capacity until opt-in dynamic QPACK.
    fn default() -> Self {
        Self::disabled()
    }
}

/// Encoder-side dynamic table + helpers to emit encoder-stream inserts.
/// Outbound HEADERS continue to use literals by default (Chromium-safe).
#[derive(Debug, Clone)]
pub struct QpackEncoder {
    table: DynamicTable,
}

impl QpackEncoder {
    pub fn new(max_capacity: usize) -> Self {
        Self {
            table: DynamicTable::new(max_capacity),
        }
    }

    pub fn table(&self) -> &DynamicTable {
        &self.table
    }

    /// Emit a Set Dynamic Table Capacity instruction and apply it locally.
    pub fn set_capacity_instruction(&mut self, capacity: usize) -> Result<Vec<u8>, QpackError> {
        self.table.set_capacity(capacity)?;
        let mut out = Vec::new();
        // 001 capacity (5+)
        qpack_int(0x20, 5, capacity as u64, &mut out);
        Ok(out)
    }

    /// Insert With Literal Name (QPACK analogue of HPACK "literal with
    /// incremental indexing") and return the encoder-stream bytes.
    pub fn insert_literal_instruction(
        &mut self,
        name: &str,
        value: &str,
    ) -> Result<Vec<u8>, QpackError> {
        let mut out = Vec::new();
        // 01 H(=0) name-len (5+)
        qpack_int(0x40, 5, name.len() as u64, &mut out);
        out.extend_from_slice(name.as_bytes());
        qpack_int(0x00, 7, value.len() as u64, &mut out);
        out.extend_from_slice(value.as_bytes());
        self.table.insert(name.to_string(), value.to_string())?;
        Ok(out)
    }

    /// Build a field section that references the newest dynamic entry (relative
    /// index 0) with Base = insert_count + 1. Used by unit tests / optional
    /// encoder paths when capacity > 0.
    pub fn encode_indexed_newest_section(&self) -> Option<Vec<u8>> {
        let insert_count = self.table.insert_count();
        if insert_count == 0 {
            return None;
        }
        let ric = insert_count;
        let base = insert_count + 1;
        let mut out = Vec::new();
        encode_field_section_prefix(ric, base, self.table.max_capacity(), &mut out)?;
        // Indexed Field Line, dynamic (T=0), relative index 0.
        qpack_int(0x80, 6, 0, &mut out);
        Some(out)
    }
}

fn encode_field_section_prefix(
    ric: u64,
    base: u64,
    max_capacity: usize,
    out: &mut Vec<u8>,
) -> Option<()> {
    let encoded_ric = encode_required_insert_count(ric, max_capacity)?;
    qpack_int(0x00, 8, encoded_ric, out);
    if base >= ric {
        let delta = base - ric;
        qpack_int(0x00, 7, delta, out); // S=0
    } else {
        let delta = ric - base - 1;
        qpack_int(0x80, 7, delta, out); // S=1
    }
    Some(())
}

fn encode_required_insert_count(ric: u64, max_capacity: usize) -> Option<u64> {
    if ric == 0 {
        return Some(0);
    }
    let max_entries = (max_capacity / 32) as u64;
    if max_entries == 0 {
        return None;
    }
    Some((ric % (2 * max_entries)) + 1)
}

fn decode_required_insert_count(
    encoded: u64,
    max_capacity: usize,
    total_inserts: u64,
) -> Result<u64, QpackError> {
    if encoded == 0 {
        return Ok(0);
    }
    let max_entries = (max_capacity / 32) as u64;
    if max_entries == 0 {
        return Err(QpackError::Invalid);
    }
    let full_range = 2u64.checked_mul(max_entries).ok_or(QpackError::Invalid)?;
    let max_value = total_inserts
        .checked_add(max_entries)
        .ok_or(QpackError::Invalid)?;
    let max_wrapped = (max_value / full_range).saturating_mul(full_range);
    let mut ric = max_wrapped
        .checked_add(encoded)
        .ok_or(QpackError::Invalid)?
        .checked_sub(1)
        .ok_or(QpackError::Invalid)?;
    if ric > max_value {
        if ric <= max_value.saturating_add(max_entries) {
            ric = ric.checked_sub(full_range).ok_or(QpackError::Invalid)?;
        } else {
            return Err(QpackError::Invalid);
        }
    }
    if ric == 0 {
        return Err(QpackError::Invalid);
    }
    Ok(ric)
}

/// Apply complete encoder-stream instructions (RFC 9204 §4.3). Returns the
/// number of bytes consumed; trailing partial instructions are left unconsumed.
pub fn feed_encoder_stream(decoder: &mut QpackDecoder, data: &[u8]) -> Result<usize, QpackError> {
    let mut offset = 0usize;
    while offset < data.len() {
        let buf = &data[offset..];
        let first = buf[0];
        let consumed = if first & 0x80 != 0 {
            // Insert With Name Reference: 1 T index(6+) + value.
            let static_table = first & 0x40 != 0;
            let Some((idx, n)) = qpack_int_decode(buf, 6) else {
                break;
            };
            let mut rest = match buf.get(n..) {
                Some(r) => r,
                None => break,
            };
            let name = if static_table {
                qpack_static(idx).ok_or(QpackError::Invalid)?.0.to_string()
            } else {
                let abs = decoder
                    .table
                    .insert_count()
                    .checked_sub(idx)
                    .ok_or(QpackError::Invalid)?;
                decoder
                    .table
                    .get_absolute(abs)
                    .ok_or(QpackError::Invalid)?
                    .0
                    .to_string()
            };
            let Some(value) = read_qpack_string(&mut rest) else {
                break;
            };
            decoder.table.insert(name, value)?;
            let value_len = buf.len() - n - rest.len();
            n.checked_add(value_len).ok_or(QpackError::Invalid)?
        } else if first & 0x40 != 0 {
            // Insert With Literal Name: 01 H nameLen(5+) name value.
            let huffman = first & 0x20 != 0;
            let Some((nlen, n1)) = qpack_int_decode(buf, 5) else {
                break;
            };
            let nlen_us = usize::try_from(nlen).map_err(|_| QpackError::Invalid)?;
            if buf.len() < n1 + nlen_us {
                break;
            }
            let raw = &buf[n1..n1 + nlen_us];
            let mut rest = &buf[n1 + nlen_us..];
            let name = decode_qpack_bytes(raw, huffman).ok_or(QpackError::Invalid)?;
            let Some(value) = read_qpack_string(&mut rest) else {
                break;
            };
            decoder.table.insert(name, value)?;
            let after_name = n1 + nlen_us;
            let value_len = buf.len() - after_name - rest.len();
            after_name
                .checked_add(value_len)
                .ok_or(QpackError::Invalid)?
        } else if first & 0x20 != 0 {
            // Set Dynamic Table Capacity: 001 capacity(5+).
            let Some((cap, n)) = qpack_int_decode(buf, 5) else {
                break;
            };
            let cap_us = usize::try_from(cap).map_err(|_| QpackError::Invalid)?;
            decoder.table.set_capacity(cap_us)?;
            n
        } else {
            // Duplicate: 000 index(5+).
            let Some((idx, n)) = qpack_int_decode(buf, 5) else {
                break;
            };
            let abs = decoder
                .table
                .insert_count()
                .checked_sub(idx)
                .ok_or(QpackError::Invalid)?;
            let (name, value) = decoder
                .table
                .get_absolute(abs)
                .ok_or(QpackError::Invalid)
                .map(|(n, v)| (n.to_string(), v.to_string()))?;
            decoder.table.insert(name, value)?;
            n
        };
        offset += consumed;
    }
    Ok(offset)
}

/// QPACK integer with an N-bit prefix (RFC 9204 §4.1.1 / RFC 7541 §5.1).
fn qpack_int(prefix: u8, n: u8, value: u64, out: &mut Vec<u8>) {
    let max = (1u64 << n) - 1;
    if value < max {
        out.push(prefix | value as u8);
    } else {
        out.push(prefix | max as u8);
        let mut v = value - max;
        while v >= 128 {
            out.push((v as u8 & 0x7f) | 0x80);
            v >>= 7;
        }
        out.push(v as u8);
    }
}

/// Literal Field Line With Literal Name, no Huffman (RFC 9204 §4.5.6).
fn qpack_literal(name: &str, value: &str, out: &mut Vec<u8>) {
    // 0010 N(=0) then 3-bit name-length prefix -> pattern 0x20
    qpack_int(0x20, 3, name.len() as u64, out);
    out.extend_from_slice(name.as_bytes());
    qpack_int(0x00, 7, value.len() as u64, out); // value: 1-bit Huffman flag (0) + 7-bit len
    out.extend_from_slice(value.as_bytes());
}

/// Build a HEADERS frame for the WebTransport Extended CONNECT request.
pub fn encode_connect_request(authority: &str, path: &str) -> Vec<u8> {
    let mut fields = Vec::new();
    fields.push(0x00); // Required Insert Count = 0
    fields.push(0x00); // S bit + Delta Base = 0
    qpack_literal(":method", "CONNECT", &mut fields);
    qpack_literal(":protocol", "webtransport", &mut fields);
    qpack_literal(":scheme", "https", &mut fields);
    qpack_literal(":authority", authority, &mut fields);
    qpack_literal(":path", path, &mut fields);
    frame_wrap(frame::HEADERS, &fields)
}

/// Build a plain HTTP/3 GET request HEADERS frame (no `:protocol`). Used in
/// tests to exercise the non-CONNECT request rejection path.
pub fn encode_get_request(authority: &str, path: &str) -> Vec<u8> {
    let mut fields = Vec::new();
    fields.push(0x00);
    fields.push(0x00);
    qpack_literal(":method", "GET", &mut fields);
    qpack_literal(":scheme", "https", &mut fields);
    qpack_literal(":authority", authority, &mut fields);
    qpack_literal(":path", path, &mut fields);
    frame_wrap(frame::HEADERS, &fields)
}

/// Build a HEADERS frame for the CONNECT 200 response.
pub fn encode_connect_response_ok() -> Vec<u8> {
    encode_status_response("200")
}

/// Build a HEADERS frame carrying a single `:status`. Used to reject a
/// non-CONNECT request stream (e.g. `404`) instead of leaving it to hang.
pub fn encode_status_response(status: &str) -> Vec<u8> {
    let mut fields = Vec::new();
    fields.push(0x00);
    fields.push(0x00);
    qpack_literal(":status", status, &mut fields);
    frame_wrap(frame::HEADERS, &fields)
}

/// Wrap a payload as a typed, length-prefixed HTTP/3 frame.
pub fn frame_wrap(frame_type: u64, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    varint::encode(frame_type, &mut out);
    varint::encode(payload.len() as u64, &mut out);
    out.extend_from_slice(payload);
    out
}

/// QPACK static table (RFC 9204 Appendix A) — the complete 99-entry table
/// (indices 0..=98), each an (name, value) pair.
fn qpack_static(index: u64) -> Option<(&'static str, &'static str)> {
    QPACK_STATIC_TABLE
        .get(usize::try_from(index).ok()?)
        .copied()
}

/// RFC 9204 Appendix A: the QPACK static table, indices 0..=98.
const QPACK_STATIC_TABLE: [(&str, &str); 99] = [
    (":authority", ""),
    (":path", "/"),
    ("age", "0"),
    ("content-disposition", ""),
    ("content-length", "0"),
    ("cookie", ""),
    ("date", ""),
    ("etag", ""),
    ("if-modified-since", ""),
    ("if-none-match", ""),
    ("last-modified", ""),
    ("link", ""),
    ("location", ""),
    ("referer", ""),
    ("set-cookie", ""),
    (":method", "CONNECT"),
    (":method", "DELETE"),
    (":method", "GET"),
    (":method", "HEAD"),
    (":method", "OPTIONS"),
    (":method", "POST"),
    (":method", "PUT"),
    (":scheme", "http"),
    (":scheme", "https"),
    (":status", "103"),
    (":status", "200"),
    (":status", "304"),
    (":status", "404"),
    (":status", "503"),
    ("accept", "*/*"),
    ("accept", "application/dns-message"),
    ("accept-encoding", "gzip, deflate, br"),
    ("accept-ranges", "bytes"),
    ("access-control-allow-headers", "cache-control"),
    ("access-control-allow-headers", "content-type"),
    ("access-control-allow-origin", "*"),
    ("cache-control", "max-age=0"),
    ("cache-control", "max-age=2592000"),
    ("cache-control", "max-age=604800"),
    ("cache-control", "no-cache"),
    ("cache-control", "no-store"),
    ("cache-control", "public, max-age=31536000"),
    ("content-encoding", "br"),
    ("content-encoding", "gzip"),
    ("content-type", "application/dns-message"),
    ("content-type", "application/javascript"),
    ("content-type", "application/json"),
    ("content-type", "application/x-www-form-urlencoded"),
    ("content-type", "image/gif"),
    ("content-type", "image/jpeg"),
    ("content-type", "image/png"),
    ("content-type", "text/css"),
    ("content-type", "text/html; charset=utf-8"),
    ("content-type", "text/plain"),
    ("content-type", "text/plain;charset=utf-8"),
    ("range", "bytes=0-"),
    ("strict-transport-security", "max-age=31536000"),
    (
        "strict-transport-security",
        "max-age=31536000; includesubdomains",
    ),
    (
        "strict-transport-security",
        "max-age=31536000; includesubdomains; preload",
    ),
    ("vary", "accept-encoding"),
    ("vary", "origin"),
    ("x-content-type-options", "nosniff"),
    ("x-xss-protection", "1; mode=block"),
    (":status", "100"),
    (":status", "204"),
    (":status", "206"),
    (":status", "302"),
    (":status", "400"),
    (":status", "403"),
    (":status", "421"),
    (":status", "425"),
    (":status", "500"),
    ("accept-language", ""),
    ("access-control-allow-credentials", "FALSE"),
    ("access-control-allow-credentials", "TRUE"),
    ("access-control-allow-headers", "*"),
    ("access-control-allow-methods", "get"),
    ("access-control-allow-methods", "get, post, options"),
    ("access-control-allow-methods", "options"),
    ("access-control-expose-headers", "content-length"),
    ("access-control-request-headers", "content-type"),
    ("access-control-request-method", "get"),
    ("access-control-request-method", "post"),
    ("alt-svc", "clear"),
    ("authorization", ""),
    (
        "content-security-policy",
        "script-src 'none'; object-src 'none'; base-uri 'none'",
    ),
    ("early-data", "1"),
    ("expect-ct", ""),
    ("forwarded", ""),
    ("if-range", ""),
    ("origin", ""),
    ("purpose", "prefetch"),
    ("server", ""),
    ("timing-allow-origin", "*"),
    ("upgrade-insecure-requests", "1"),
    ("user-agent", ""),
    ("x-forwarded-for", ""),
    ("x-frame-options", "deny"),
    ("x-frame-options", "sameorigin"),
];

/// Decode a QPACK field section into (name, value) pairs without a dynamic
/// table (RIC must be 0; dynamic refs fail). Prefer [`decode_field_section`]
/// when a [`QpackDecoder`] is available.
pub fn decode_literal_headers(buf: &[u8]) -> Option<Vec<(String, String)>> {
    let decoder = QpackDecoder::disabled();
    decode_field_section(buf, &decoder).ok()
}

/// Decode a QPACK field section against decoder dynamic-table state.
///
/// Supports static/dynamic Indexed Field Lines, Literal With Name Reference
/// (static or dynamic), Literal With Literal Name, and Post-Base forms.
/// Returns [`QpackError::Blocked`] when Required Insert Count exceeds known
/// inserts (caller may wait for encoder-stream data), or [`QpackError::Invalid`]
/// for OOB / malformed / abuse.
pub fn decode_field_section(
    mut buf: &[u8],
    decoder: &QpackDecoder,
) -> Result<Vec<(String, String)>, QpackError> {
    if buf.len() < 2 {
        return Err(QpackError::Invalid);
    }
    let (encoded_ric, n_ric) = qpack_int_decode(buf, 8).ok_or(QpackError::Invalid)?;
    buf = buf.get(n_ric..).ok_or(QpackError::Invalid)?;
    let ric = decode_required_insert_count(
        encoded_ric,
        decoder.table.max_capacity(),
        decoder.table.insert_count(),
    )?;
    if ric > decoder.table.insert_count() {
        return Err(QpackError::Blocked);
    }
    if buf.is_empty() {
        return Err(QpackError::Invalid);
    }
    let s_bit = buf[0] & 0x80 != 0;
    let (delta_base, n_base) = qpack_int_decode(buf, 7).ok_or(QpackError::Invalid)?;
    buf = buf.get(n_base..).ok_or(QpackError::Invalid)?;
    let base = if !s_bit {
        ric.checked_add(delta_base).ok_or(QpackError::Invalid)?
    } else {
        ric.checked_sub(delta_base)
            .ok_or(QpackError::Invalid)?
            .checked_sub(1)
            .ok_or(QpackError::Invalid)?
    };

    let mut out = Vec::new();
    while !buf.is_empty() {
        let first = *buf.first().ok_or(QpackError::Invalid)?;
        if first & 0x80 != 0 {
            // Indexed Field Line: 1 T index(6).
            let static_table = first & 0x40 != 0;
            let (idx, n) = qpack_int_decode(buf, 6).ok_or(QpackError::Invalid)?;
            buf = buf.get(n..).ok_or(QpackError::Invalid)?;
            let (name, value) = if static_table {
                let (n, v) = qpack_static(idx).ok_or(QpackError::Invalid)?;
                (n.to_string(), v.to_string())
            } else {
                let (n, v) = decoder
                    .table
                    .get_relative(idx, base)
                    .ok_or(QpackError::Invalid)?;
                (n.to_string(), v.to_string())
            };
            out.push((name, value));
        } else if first & 0x40 != 0 {
            // Literal Field Line With Name Reference: 01 N T index(4).
            let static_table = first & 0x10 != 0;
            let (idx, n) = qpack_int_decode(buf, 4).ok_or(QpackError::Invalid)?;
            buf = buf.get(n..).ok_or(QpackError::Invalid)?;
            let name = if static_table {
                qpack_static(idx).ok_or(QpackError::Invalid)?.0.to_string()
            } else {
                decoder
                    .table
                    .get_relative(idx, base)
                    .ok_or(QpackError::Invalid)?
                    .0
                    .to_string()
            };
            let value = read_qpack_string(&mut buf).ok_or(QpackError::Invalid)?;
            out.push((name, value));
        } else if first & 0x20 != 0 {
            // Literal Field Line With Literal Name: 001 N H nameLen(3).
            let huffman = first & 0x08 != 0;
            let (nlen, n1) = qpack_int_decode(buf, 3).ok_or(QpackError::Invalid)?;
            buf = buf.get(n1..).ok_or(QpackError::Invalid)?;
            let nlen_us = usize::try_from(nlen).map_err(|_| QpackError::Invalid)?;
            let raw = buf.get(..nlen_us).ok_or(QpackError::Invalid)?;
            buf = buf.get(nlen_us..).ok_or(QpackError::Invalid)?;
            let name = decode_qpack_bytes(raw, huffman).ok_or(QpackError::Invalid)?;
            let value = read_qpack_string(&mut buf).ok_or(QpackError::Invalid)?;
            out.push((name, value));
        } else if first & 0x10 != 0 {
            // Indexed Field Line With Post-Base Index: 0001 index(4).
            let (idx, n) = qpack_int_decode(buf, 4).ok_or(QpackError::Invalid)?;
            buf = buf.get(n..).ok_or(QpackError::Invalid)?;
            let (name, value) = decoder
                .table
                .get_post_base(idx, base)
                .ok_or(QpackError::Invalid)
                .map(|(n, v)| (n.to_string(), v.to_string()))?;
            out.push((name, value));
        } else {
            // Literal Field Line With Post-Base Name Reference: 0000 N index(3).
            let (idx, n) = qpack_int_decode(buf, 3).ok_or(QpackError::Invalid)?;
            buf = buf.get(n..).ok_or(QpackError::Invalid)?;
            let name = decoder
                .table
                .get_post_base(idx, base)
                .ok_or(QpackError::Invalid)?
                .0
                .to_string();
            let value = read_qpack_string(&mut buf).ok_or(QpackError::Invalid)?;
            out.push((name, value));
        }
    }
    Ok(out)
}

/// Read a QPACK string literal: 1-bit Huffman flag + 7-bit length prefix + bytes.
/// Decodes HPACK Huffman when the flag is set.
fn read_qpack_string(buf: &mut &[u8]) -> Option<String> {
    let huffman = (*buf.first()?) & 0x80 != 0;
    let (len, n) = qpack_int_decode(buf, 7)?;
    *buf = &buf[n..];
    let len_us = usize::try_from(len).ok()?;
    let raw = buf.get(..len_us)?;
    *buf = &buf[len_us..];
    decode_qpack_bytes(raw, huffman)
}

/// Decode QPACK string bytes, applying HPACK Huffman decoding when `huffman` is set.
fn decode_qpack_bytes(raw: &[u8], huffman: bool) -> Option<String> {
    if huffman {
        let mut out = Vec::new();
        httlib_huffman::decode(raw, &mut out, httlib_huffman::DecoderSpeed::ThreeBits).ok()?;
        String::from_utf8(out).ok()
    } else {
        std::str::from_utf8(raw).ok().map(|s| s.to_string())
    }
}

fn qpack_int_decode(buf: &[u8], n: u8) -> Option<(u64, usize)> {
    let max = (1u64 << n) - 1;
    let first = (*buf.first()?) as u64 & max;
    if first < max {
        return Some((first, 1));
    }
    let mut value = max;
    let mut m = 0u32;
    let mut i = 1usize;
    loop {
        let b = *buf.get(i)? as u64;
        // Reject an over-long / malicious varint instead of panicking on a
        // shift >= 64 (UB in debug, wraps in release) or wrapping on add.
        // `checked_shl` guards the shift width; `checked_add` guards the sum.
        let shifted = (b & 0x7f).checked_shl(m)?;
        value = value.checked_add(shifted)?;
        i += 1;
        if b & 0x80 == 0 {
            break;
        }
        m += 7;
        if m >= 64 {
            return None;
        }
    }
    Some((value, i))
}

/// Prepend the quarter-session-id to an application datagram payload.
pub fn wrap_datagram(connect_stream_id: u64, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    varint::encode(connect_stream_id / 4, &mut out);
    out.extend_from_slice(payload);
    out
}

/// Split a received WebTransport datagram into (quarter_session_id, payload).
pub fn unwrap_datagram(buf: &[u8]) -> Option<(u64, &[u8])> {
    let (qsid, n) = varint::decode(buf)?;
    Some((qsid, &buf[n..]))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Deterministic, dependency-free xorshift64* PRNG for reproducible
    /// robustness fuzzing of the hand-rolled parsers.
    struct Rng(u64);
    impl Rng {
        fn next_u64(&mut self) -> u64 {
            let mut x = self.0;
            x ^= x >> 12;
            x ^= x << 25;
            x ^= x >> 27;
            self.0 = x;
            x.wrapping_mul(0x2545_f491_4f6c_dd1d)
        }
        fn bytes(&mut self, max_len: usize) -> Vec<u8> {
            let len = (self.next_u64() as usize) % (max_len + 1);
            (0..len).map(|_| self.next_u64() as u8).collect()
        }
    }

    // Robustness fuzz: feed many random + adversarial byte sequences to every
    // hand-rolled H3/QPACK parser and assert none panics (a panic in wasm
    // aborts and poisons the whole registry). Returning None/Some is fine — the
    // property under test is "never panics on hostile input".
    #[test]
    fn parsers_never_panic_on_random_input() {
        let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
        for _ in 0..200_000 {
            let buf = rng.bytes(64);
            let _ = crate::varint::decode(&buf);
            let _ = qpack_int_decode(&buf, (rng.next_u64() as u8 & 7) + 1);
            let _ = parse_settings(&buf);
            let _ = decode_literal_headers(&buf);
            let mut dec = QpackDecoder::default();
            let _ = feed_encoder_stream(&mut dec, &buf);
            let _ = decode_field_section(&buf, &dec);
            let _ = unwrap_datagram(&buf);
        }
    }

    // Structured adversarial inputs: valid-looking frames with mutated /
    // maximal varint length fields, all-continuation QPACK integers, and
    // truncations — the paths most likely to overflow or over-allocate.
    #[test]
    fn parsers_never_panic_on_structured_adversarial_input() {
        // QPACK integer with the maximum continuation run.
        let mut overlong = vec![0xffu8];
        overlong.extend(std::iter::repeat_n(0x80u8, 64));
        overlong.push(0x00);
        assert!(qpack_int_decode(&overlong, 8).is_none());

        // SETTINGS payload whose declared varint lengths are maximal.
        let mut settings = Vec::new();
        crate::varint::encode(u64::MAX, &mut settings); // id
        crate::varint::encode(u64::MAX, &mut settings); // value
        let _ = parse_settings(&settings);

        // Truncations of a valid datagram wrapper must not panic.
        let wrapped = wrap_datagram(8, b"payload");
        for cut in 0..=wrapped.len() {
            let _ = unwrap_datagram(&wrapped[..cut]);
        }
    }

    #[test]
    fn control_preamble_roundtrips_settings() {
        let buf = encode_control_preamble(16);
        let (st, n0) = varint::decode(&buf).unwrap();
        assert_eq!(st, stream_type::CONTROL);
        let rest = &buf[n0..];
        let (ft, n1) = varint::decode(rest).unwrap();
        assert_eq!(ft, frame::SETTINGS);
        let rest = &rest[n1..];
        let (len, n2) = varint::decode(rest).unwrap();
        let payload = &rest[n2..n2 + len as usize];
        let s = parse_settings(payload).unwrap();
        assert!(s.webtransport && s.h3_datagram && s.connect_protocol);
        assert_eq!(s.max_sessions, 16);
        // Default preamble stays Chromium-safe (zero dynamic table).
        assert_eq!(s.qpack_max_table_capacity, 0);
        assert_eq!(s.qpack_blocked_streams, 0);

        let buf_dyn = encode_control_preamble_with(16, &QpackLocalSettings::default());
        let rest = &buf_dyn[varint::decode(&buf_dyn).unwrap().1..];
        let (ft, n1) = varint::decode(rest).unwrap();
        assert_eq!(ft, frame::SETTINGS);
        let rest = &rest[n1..];
        let (len, n2) = varint::decode(rest).unwrap();
        let s_dyn = parse_settings(&rest[n2..n2 + len as usize]).unwrap();
        assert_eq!(
            s_dyn.qpack_max_table_capacity,
            DEFAULT_QPACK_MAX_TABLE_CAPACITY
        );
        assert_eq!(s_dyn.qpack_blocked_streams, DEFAULT_QPACK_BLOCKED_STREAMS);
    }

    #[test]
    fn control_preamble_can_advertise_zero_qpack_for_compat() {
        let buf = encode_control_preamble_with(1, &QpackLocalSettings::disabled());
        let (st, n0) = varint::decode(&buf).unwrap();
        assert_eq!(st, stream_type::CONTROL);
        let rest = &buf[n0..];
        let (ft, n1) = varint::decode(rest).unwrap();
        assert_eq!(ft, frame::SETTINGS);
        let rest = &rest[n1..];
        let (len, n2) = varint::decode(rest).unwrap();
        let payload = &rest[n2..n2 + len as usize];
        let s = parse_settings(payload).unwrap();
        assert_eq!(s.qpack_max_table_capacity, 0);
        assert_eq!(s.qpack_blocked_streams, 0);
    }

    #[test]
    fn advertised_settings_capacity_matches_decoder_default() {
        let buf = encode_control_preamble(2);
        let rest = &buf[varint::decode(&buf).unwrap().1..];
        let (ft, n1) = varint::decode(rest).unwrap();
        assert_eq!(ft, frame::SETTINGS);
        let rest = &rest[n1..];
        let (len, n2) = varint::decode(rest).unwrap();
        let s = parse_settings(&rest[n2..n2 + len as usize]).unwrap();
        let dec = QpackDecoder::default();
        assert_eq!(s.qpack_max_table_capacity, dec.max_table_capacity());
        assert_eq!(s.qpack_blocked_streams, dec.max_blocked_streams());
        assert_eq!(s.qpack_max_table_capacity, 0);
        assert_eq!(s.qpack_blocked_streams, 0);

        let settings = QpackLocalSettings::default();
        let buf_dyn = encode_control_preamble_with(2, &settings);
        let rest = &buf_dyn[varint::decode(&buf_dyn).unwrap().1..];
        let (ft, n1) = varint::decode(rest).unwrap();
        assert_eq!(ft, frame::SETTINGS);
        let rest = &rest[n1..];
        let (len, n2) = varint::decode(rest).unwrap();
        let s_dyn = parse_settings(&rest[n2..n2 + len as usize]).unwrap();
        let dec_dyn = QpackDecoder::new(&settings);
        assert_eq!(s_dyn.qpack_max_table_capacity, dec_dyn.max_table_capacity());
        assert_eq!(s_dyn.qpack_blocked_streams, dec_dyn.max_blocked_streams());
    }

    #[test]
    fn dynamic_qpack_insert_index_roundtrip() {
        let mut enc = QpackEncoder::new(4096);
        let mut dec = QpackDecoder::new(&QpackLocalSettings {
            max_table_capacity: 4096,
            max_blocked_streams: 16,
        });

        let mut enc_stream = enc.set_capacity_instruction(4096).unwrap();
        enc_stream.extend(
            enc.insert_literal_instruction(":protocol", "webtransport")
                .unwrap(),
        );
        let consumed = feed_encoder_stream(&mut dec, &enc_stream).unwrap();
        assert_eq!(consumed, enc_stream.len());
        assert_eq!(dec.table().insert_count(), 1);
        assert_eq!(
            dec.table().get_absolute(1),
            Some((":protocol", "webtransport"))
        );

        let section = enc.encode_indexed_newest_section().unwrap();
        let hdrs = decode_field_section(&section, &dec).unwrap();
        assert_eq!(hdrs, vec![(":protocol".into(), "webtransport".into())]);
    }

    #[test]
    fn dynamic_qpack_capacity_eviction() {
        // Capacity fits exactly one small entry (name+value+32).
        // "a"/"b" => 1+1+32 = 34 bytes.
        let mut table = DynamicTable::new(34);
        table.set_capacity(34).unwrap();
        table.insert("a".into(), "b".into()).unwrap();
        assert_eq!(table.len(), 1);
        assert_eq!(table.get_absolute(1), Some(("a", "b")));

        // Second insert of same size evicts the first.
        table.insert("c".into(), "d".into()).unwrap();
        assert_eq!(table.len(), 1);
        assert_eq!(table.get_absolute(1), None); // evicted
        assert_eq!(table.get_absolute(2), Some(("c", "d")));
        assert_eq!(table.insert_count(), 2);

        // Shrinking capacity to 0 empties the table.
        table.set_capacity(0).unwrap();
        assert!(table.is_empty());
        assert_eq!(table.size(), 0);
        assert_eq!(table.insert_count(), 2); // insert count is never decremented
    }

    #[test]
    fn dynamic_qpack_rejects_oob_and_empty_dynamic_index() {
        let dec = QpackDecoder::new(&QpackLocalSettings {
            max_table_capacity: 4096,
            max_blocked_streams: 16,
        });
        // RIC=0, Base=0, Indexed dynamic relative 0 → OOB on empty table.
        let section = [0x00u8, 0x00, 0x80];
        assert_eq!(
            decode_field_section(&section, &dec),
            Err(QpackError::Invalid)
        );

        // Direct table lookup OOB / empty.
        assert!(dec.table().is_empty());
        assert_eq!(dec.table().get_absolute(1), None);
        assert_eq!(dec.table().get_relative(0, 1), None);

        // Capacity larger than SETTINGS max is abuse.
        let mut table = DynamicTable::new(100);
        assert_eq!(table.set_capacity(101), Err(QpackError::Invalid));
    }

    #[test]
    fn dynamic_qpack_blocked_when_ric_exceeds_inserts() {
        let mut enc = QpackEncoder::new(4096);
        enc.set_capacity_instruction(4096).unwrap();
        enc.insert_literal_instruction("x", "y").unwrap();
        let section = enc.encode_indexed_newest_section().unwrap();

        // Decoder has not seen the insert yet → Blocked.
        let dec = QpackDecoder::new(&QpackLocalSettings {
            max_table_capacity: 4096,
            max_blocked_streams: 16,
        });
        assert_eq!(
            decode_field_section(&section, &dec),
            Err(QpackError::Blocked)
        );
    }

    #[test]
    fn connect_request_headers_roundtrip() {
        let f = encode_connect_request("example.com", "/chat");
        let (ft, n0) = varint::decode(&f).unwrap();
        assert_eq!(ft, frame::HEADERS);
        let rest = &f[n0..];
        let (len, n1) = varint::decode(rest).unwrap();
        let payload = &rest[n1..n1 + len as usize];
        let hdrs = decode_literal_headers(payload).unwrap();
        let get = |k: &str| hdrs.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str());
        assert_eq!(get(":method"), Some("CONNECT"));
        assert_eq!(get(":protocol"), Some("webtransport"));
        assert_eq!(get(":authority"), Some("example.com"));
        assert_eq!(get(":path"), Some("/chat"));
    }

    /// Encode a Huffman string with the 1-bit Huffman flag + N-bit length prefix.
    fn huffman_string(prefix_pattern: u8, n: u8, s: &str) -> Vec<u8> {
        let mut encoded = Vec::new();
        httlib_huffman::encode(s.as_bytes(), &mut encoded).expect("huffman encode");
        let mut out = Vec::new();
        // set the Huffman bit at position (n) within the prefix byte
        let huff_bit = 1u8 << n;
        qpack_int(prefix_pattern | huff_bit, n, encoded.len() as u64, &mut out);
        out.extend_from_slice(&encoded);
        out
    }

    #[test]
    fn decode_chromium_style_connect_request() {
        // Mirror how Chromium encodes the WebTransport Extended CONNECT with
        // Required Insert Count = 0 (static table + literal field lines only).
        let mut payload = Vec::new();
        payload.push(0x00); // Required Insert Count = 0
        payload.push(0x00); // S bit + Delta Base = 0

        // :method CONNECT -> Indexed Field Line, static table index 15.
        // 1 T(=1) index(6) -> 0xC0 | 15
        payload.push(0xC0 | 15);

        // :protocol webtransport -> Literal Field Line With Literal Name,
        // Huffman-coded name (":protocol") + Huffman-coded value ("webtransport").
        // Pattern: 0 0 1 N(=0) H nameLen(3) -> base 0x20.
        payload.extend_from_slice(&huffman_string(0x20, 3, ":protocol"));
        payload.extend_from_slice(&huffman_string(0x00, 7, "webtransport"));

        // :scheme https -> Literal Field Line With Name Reference, static index 23.
        // Pattern: 0 1 N(=0) T(=1) index(4) -> 0x50 | 7 (idx 23 needs continuation).
        let mut name_ref_scheme = Vec::new();
        qpack_int(0x50, 4, 23, &mut name_ref_scheme);
        payload.extend_from_slice(&name_ref_scheme);
        payload.extend_from_slice(&huffman_string(0x00, 7, "https"));

        // :authority example.com -> Literal Field Line With Name Reference, static index 0.
        let mut name_ref_auth = Vec::new();
        qpack_int(0x50, 4, 0, &mut name_ref_auth);
        payload.extend_from_slice(&name_ref_auth);
        payload.extend_from_slice(&huffman_string(0x00, 7, "example.com"));

        // :path /chat -> Literal Field Line With Name Reference, static index 1.
        let mut name_ref_path = Vec::new();
        qpack_int(0x50, 4, 1, &mut name_ref_path);
        payload.extend_from_slice(&name_ref_path);
        payload.extend_from_slice(&huffman_string(0x00, 7, "/chat"));

        let hdrs = decode_literal_headers(&payload).expect("decode must consume all field lines");
        let get = |k: &str| hdrs.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str());
        assert_eq!(get(":method"), Some("CONNECT"));
        assert_eq!(get(":protocol"), Some("webtransport"));
        assert_eq!(get(":scheme"), Some("https"));
        assert_eq!(get(":authority"), Some("example.com"));
        assert_eq!(get(":path"), Some("/chat"));
    }

    #[test]
    fn connect_response_status_200() {
        let f = encode_connect_response_ok();
        let (_t, n0) = varint::decode(&f).unwrap();
        let rest = &f[n0..];
        let (len, n1) = varint::decode(rest).unwrap();
        let hdrs = decode_literal_headers(&rest[n1..n1 + len as usize]).unwrap();
        assert_eq!(hdrs.iter().find(|(n, _)| n == ":status").unwrap().1, "200");
    }

    #[test]
    fn datagram_quarter_id_roundtrip() {
        let wrapped = wrap_datagram(0, b"hello");
        let (qsid, payload) = unwrap_datagram(&wrapped).unwrap();
        assert_eq!(qsid, 0);
        assert_eq!(payload, b"hello");

        let wrapped = wrap_datagram(8, b"x"); // stream 8 -> qsid 2
        let (qsid, _) = unwrap_datagram(&wrapped).unwrap();
        assert_eq!(qsid, 2);
    }

    #[test]
    fn qpack_int_decode_rejects_overlong_varint_without_panicking() {
        // Prefix all-ones (needs continuation) followed by many 0x80
        // continuation bytes: the pre-fix code shifted by m >= 64 (UB/panic in
        // debug, wrap in release). Must return None, never panic.
        let mut buf = vec![0xffu8]; // n=8 prefix, first == max -> continue
        buf.extend(std::iter::repeat_n(0x80, 20)); // continuation bytes
        buf.push(0x7f); // final byte, high bit clear
        assert_eq!(qpack_int_decode(&buf, 8), None);
    }

    #[test]
    fn qpack_int_decode_still_decodes_small_and_boundary_values() {
        // Single-byte value below the prefix max.
        assert_eq!(qpack_int_decode(&[5], 8), Some((5, 1)));
        // max prefix (255) + one continuation byte (0) => value 255.
        assert_eq!(qpack_int_decode(&[0xff, 0x00], 8), Some((255, 2)));
        // 255 + (1 << 0) = 256.
        assert_eq!(qpack_int_decode(&[0xff, 0x01], 8), Some((256, 2)));
    }
}
