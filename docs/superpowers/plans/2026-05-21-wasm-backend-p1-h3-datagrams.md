# WASM Backend P1 — H3/WebTransport Handshake + Datagrams Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the proven Phase-0 wasm32 QUIC handshake spike into a real bridge that establishes a WebTransport-over-HTTP/3 session between a wasm server and a wasm client and echoes a datagram, driven by a JS pump loop over an in-memory UDP relay (no browser, no real socket yet).

**Architecture:** `crates/wasm` exposes a synchronous, sans-IO bridge: JS feeds inbound UDP datagrams via `recv_packet`, drains outbound via `poll_transmits`, advances timers via `next_timeout_ms`/`handle_timeout`, and drains an event queue via `poll_event`. On top of raw quinn-proto QUIC, a hand-rolled minimal HTTP/3 + WebTransport layer performs the control-stream SETTINGS exchange and the Extended CONNECT handshake, then carries WebTransport datagrams. A TS `backend-wasm.ts` wraps the wasm module; P1 tests it with an in-memory relay that shuttles datagrams between two endpoints.

**Tech Stack:** Rust (`quinn-proto 0.11`, `rustls 0.23`+ring, `rcgen 0.14`, `web-time`), `wasm-bindgen 0.2.121`, wasm32-unknown-unknown (ring C via brew LLVM clang), Bun test runner, TypeScript.

**Scope note:** This is P1 only. P2 (streams), P3 (backend refactor/parity), P4 (IWA + real UDPSocket), P5 (cross-interop) get their own plans. P1's deliverable is a green `wasm-datagram-echo` loopback test.

**Build invariant (all Rust steps):** every `cargo`/`wasm-bindgen` command runs with:
```
export RUSTUP_TOOLCHAIN=stable
export CC_wasm32_unknown_unknown=/opt/homebrew/opt/llvm/bin/clang
export AR_wasm32_unknown_unknown=/opt/homebrew/opt/llvm/bin/llvm-ar
```
A helper script (Task 1) captures this so steps can call it.

---

## File Structure

- `crates/wasm/Cargo.toml` — Modify: promote spike deps to the real bridge crate (add `bytes`, keep ring path).
- `crates/wasm/src/lib.rs` — Modify: shrink to module declarations + re-exports; move the spike's loopback into a test.
- `crates/wasm/src/varint.rs` — Create: QUIC/HTTP3 variable-length integer codec.
- `crates/wasm/src/h3.rs` — Create: HTTP/3 frame + SETTINGS + Extended CONNECT + QPACK-literal header coding + WebTransport datagram framing.
- `crates/wasm/src/endpoint.rs` — Create: `WtEndpoint` wrapping a quinn-proto `Endpoint` + its connections, the H3/WT session state machine, and the event queue.
- `crates/wasm/src/bridge.rs` — Create: `#[wasm_bindgen]` exports (the JS-facing API) over a global registry of `WtEndpoint`s.
- `crates/wasm/src/event.rs` — Create: the `WtEvent` enum + its compact serialization for `poll_event`.
- `crates/wasm/build-wasm.sh` — Create: builds wasm + runs wasm-bindgen for nodejs target into `pkg/`.
- `packages/webtransport/src/backend-wasm.ts` — Create: TS wrapper around the wasm module (endpoint handle, pump helpers, session/datagram surface). P1 subset only.
- `packages/webtransport/src/wasm-relay.ts` — Create: in-memory UDP relay used by tests (and a `UdpTransport` interface the real UDPSocket adapter will later implement).
- `packages/webtransport/test/wasm-datagram-echo.test.ts` — Create: the P1 acceptance test.

---

## Task 1: Build helper + crate module skeleton

**Files:**
- Create: `crates/wasm/build-wasm.sh`
- Modify: `crates/wasm/Cargo.toml`
- Modify: `crates/wasm/src/lib.rs`
- Create: `crates/wasm/src/varint.rs`

- [ ] **Step 1: Write the build helper**

Create `crates/wasm/build-wasm.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
export RUSTUP_TOOLCHAIN="${RUSTUP_TOOLCHAIN:-stable}"
export CC_wasm32_unknown_unknown="${CC_wasm32_unknown_unknown:-/opt/homebrew/opt/llvm/bin/clang}"
export AR_wasm32_unknown_unknown="${AR_wasm32_unknown_unknown:-/opt/homebrew/opt/llvm/bin/llvm-ar}"
cargo build --release --target wasm32-unknown-unknown
wasm-bindgen target/wasm32-unknown-unknown/release/wasm_spike.wasm \
  --out-dir pkg --target nodejs --out-name wasm_spike
echo "[build-wasm] done -> pkg/"
```
Make it executable: `chmod +x crates/wasm/build-wasm.sh`.

- [ ] **Step 2: Add `bytes` to deps (already present from spike) and confirm crate name**

Confirm `crates/wasm/Cargo.toml` `[package].name = "wasm-spike"` and `[lib].crate-type = ["cdylib", "rlib"]`. Leave the name `wasm-spike` for P1 (renamed in P3). Ensure `bytes = "1"` is under `[dependencies]`.

- [ ] **Step 3: Write the varint codec with a failing test**

Create `crates/wasm/src/varint.rs`:
```rust
//! QUIC/HTTP3 variable-length integers (RFC 9000 §16).

pub fn encode(value: u64, out: &mut Vec<u8>) {
    if value < 0x40 {
        out.push(value as u8);
    } else if value < 0x4000 {
        out.extend_from_slice(&((value as u16) | 0x4000).to_be_bytes());
    } else if value < 0x4000_0000 {
        out.extend_from_slice(&((value as u32) | 0x8000_0000).to_be_bytes());
    } else {
        out.extend_from_slice(&(value | 0xC000_0000_0000_0000).to_be_bytes());
    }
}

/// Returns (value, bytes_consumed) or None if `buf` is too short.
pub fn decode(buf: &[u8]) -> Option<(u64, usize)> {
    let first = *buf.first()?;
    let len = 1usize << (first >> 6);
    if buf.len() < len {
        return None;
    }
    let mut v = (first & 0x3f) as u64;
    for &b in &buf[1..len] {
        v = (v << 8) | b as u64;
    }
    Some((v, len))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_boundaries() {
        for &n in &[0u64, 0x3f, 0x40, 0x3fff, 0x4000, 0x3fff_ffff, 0x4000_0000, u64::MAX >> 2] {
            let mut buf = Vec::new();
            encode(n, &mut buf);
            let (got, used) = decode(&buf).unwrap();
            assert_eq!(got, n, "value {n:#x}");
            assert_eq!(used, buf.len(), "len for {n:#x}");
        }
    }

    #[test]
    fn decode_short_returns_none() {
        assert!(decode(&[0x80]).is_none()); // claims 4 bytes, only 1 present
    }
}
```

- [ ] **Step 4: Wire the module into lib.rs (keep the spike handshake as a test helper)**

Replace `crates/wasm/src/lib.rs` top with module declarations, keeping the existing `run_handshake()` available to tests:
```rust
//! webtransport-bun WASM backend bridge.
pub mod varint;
// (h3, endpoint, event, bridge added in later tasks)

// The Phase-0 loopback handshake stays as a regression test of the QUIC core.
mod spike;
#[cfg(all(test, not(target_arch = "wasm32")))]
mod spike_tests {
    #[test]
    fn loopback_handshake_completes() {
        let r = crate::spike::run_handshake().expect("handshake");
        assert!(r.starts_with("OK"), "unexpected: {r}");
    }
}
```
Move the current `run_handshake`, `server_crypto`, `client_crypto`, `AcceptAny`, `drain_transmits`, and the address consts from `lib.rs` into a new `crates/wasm/src/spike.rs` (cut/paste; make the items `pub(crate)`). Remove the old `#[cfg(target_arch="wasm32")] mod wasm` and `#[cfg(test)] mod tests` blocks from `lib.rs` (the test moves as shown above; the wasm export is replaced by the real bridge in Task 6).

- [ ] **Step 5: Run tests to verify varint + relocated spike pass**

Run: `cd crates/wasm && RUSTUP_TOOLCHAIN=stable cargo test`
Expected: PASS — `roundtrip_boundaries`, `decode_short_returns_none`, `loopback_handshake_completes`.

- [ ] **Step 6: Commit**

```bash
git add crates/wasm/build-wasm.sh crates/wasm/Cargo.toml crates/wasm/src/lib.rs crates/wasm/src/varint.rs crates/wasm/src/spike.rs
git commit -m "Restructure wasm crate into modules with varint codec and build helper"
```

---

## Task 2: HTTP/3 frame + SETTINGS codec

**Files:**
- Create: `crates/wasm/src/h3.rs`
- Modify: `crates/wasm/src/lib.rs` (add `pub mod h3;`)

WebTransport-over-HTTP/3 wire constants (draft-ietf-webtrans-http3 + RFC 9114/9204/9297):

| Name | Value |
|---|---|
| H3 stream type: control | `0x00` |
| H3 stream type: QPACK encoder | `0x02` |
| H3 stream type: QPACK decoder | `0x03` |
| WT uni stream type | `0x54` |
| WT bidi stream signal | `0x41` |
| H3 frame: DATA | `0x00` |
| H3 frame: HEADERS | `0x01` |
| H3 frame: SETTINGS | `0x04` |
| H3 frame: WEBTRANSPORT_STREAM (bidi) | `0x41` |
| SETTINGS_QPACK_MAX_TABLE_CAPACITY | `0x01` |
| SETTINGS_QPACK_BLOCKED_STREAMS | `0x07` |
| SETTINGS_ENABLE_CONNECT_PROTOCOL | `0x08` |
| SETTINGS_H3_DATAGRAM | `0x33` |
| SETTINGS_ENABLE_WEBTRANSPORT | `0x2b60_3742` |
| SETTINGS_WEBTRANSPORT_MAX_SESSIONS | `0x2b60_3743` |

- [ ] **Step 1: Write the SETTINGS encode/parse with a failing test**

Create `crates/wasm/src/h3.rs`:
```rust
//! Minimal HTTP/3 + WebTransport framing (no dynamic QPACK table).
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

/// Encode the control-stream preamble: stream type byte + a SETTINGS frame
/// advertising WebTransport + H3 datagrams.
pub fn encode_control_preamble(max_sessions: u64) -> Vec<u8> {
    let mut payload = Vec::new();
    let pairs = [
        (setting::QPACK_MAX_TABLE_CAPACITY, 0),
        (setting::QPACK_BLOCKED_STREAMS, 0),
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
            _ => {}
        }
    }
    Some(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn control_preamble_roundtrips_settings() {
        let buf = encode_control_preamble(16);
        // strip control stream type
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
    }
}
```
Add `pub mod h3;` to `crates/wasm/src/lib.rs`.

- [ ] **Step 2: Run test to verify it passes**

Run: `cd crates/wasm && RUSTUP_TOOLCHAIN=stable cargo test h3::`
Expected: PASS — `control_preamble_roundtrips_settings`.

- [ ] **Step 3: Commit**

```bash
git add crates/wasm/src/h3.rs crates/wasm/src/lib.rs
git commit -m "Add HTTP/3 control-stream SETTINGS codec for WebTransport"
```

---

## Task 3: Extended CONNECT request/response (QPACK literal-only)

**Files:**
- Modify: `crates/wasm/src/h3.rs`

QPACK with dynamic table disabled: emit a HEADERS frame whose payload is a QPACK
field section prefix of two zero bytes (Required Insert Count = 0, Base = 0)
followed by literal field lines. Use *Literal Field Line With Literal Name*
(pattern `0010NNNN` for the name-length prefix, Huffman bit off) for every header.
This avoids the static table entirely and is accepted by Chromium for the CONNECT
exchange.

- [ ] **Step 1: Write the QPACK literal string + header section encoders with a failing test**

Append to `crates/wasm/src/h3.rs`:
```rust
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
    // 0010 N(=0 never-indexed) then 3-bit name-length prefix -> pattern 0x20
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

/// Build a HEADERS frame for the CONNECT 200 response.
pub fn encode_connect_response_ok() -> Vec<u8> {
    let mut fields = Vec::new();
    fields.push(0x00);
    fields.push(0x00);
    qpack_literal(":status", "200", &mut fields);
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

/// Decode a QPACK literal-only field section into (name, value) pairs.
/// Only supports the encoding produced by `qpack_literal` (no Huffman, no table).
pub fn decode_literal_headers(mut buf: &[u8]) -> Option<Vec<(String, String)>> {
    if buf.len() < 2 {
        return None;
    }
    buf = &buf[2..]; // skip the 2-byte field section prefix
    let mut out = Vec::new();
    while !buf.is_empty() {
        // name: 0010 0NNN prefix(3-bit)
        let (nlen, n1) = qpack_int_decode(buf, 3)?;
        buf = &buf[n1..];
        let name = std::str::from_utf8(buf.get(..nlen as usize)?).ok()?.to_string();
        buf = &buf[nlen as usize..];
        let (vlen, n2) = qpack_int_decode(buf, 7)?;
        buf = &buf[n2..];
        let value = std::str::from_utf8(buf.get(..vlen as usize)?).ok()?.to_string();
        buf = &buf[vlen as usize..];
        out.push((name, value));
    }
    Some(out)
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
        value += (b & 0x7f) << m;
        i += 1;
        if b & 0x80 == 0 {
            break;
        }
        m += 7;
    }
    Some((value, i))
}

#[cfg(test)]
mod connect_tests {
    use super::*;

    #[test]
    fn connect_request_headers_roundtrip() {
        let f = encode_connect_request("example.com", "/chat");
        // strip frame type + len
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

    #[test]
    fn connect_response_status_200() {
        let f = encode_connect_response_ok();
        let (_t, n0) = varint::decode(&f).unwrap();
        let rest = &f[n0..];
        let (len, n1) = varint::decode(rest).unwrap();
        let hdrs = decode_literal_headers(&rest[n1..n1 + len as usize]).unwrap();
        assert_eq!(hdrs.iter().find(|(n, _)| n == ":status").unwrap().1, "200");
    }
}
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `cd crates/wasm && RUSTUP_TOOLCHAIN=stable cargo test h3::`
Expected: PASS — `connect_request_headers_roundtrip`, `connect_response_status_200` (plus the Task 2 settings test).

- [ ] **Step 3: Commit**

```bash
git add crates/wasm/src/h3.rs
git commit -m "Add Extended CONNECT request/response coding with literal QPACK"
```

---

## Task 4: WebTransport datagram framing

**Files:**
- Modify: `crates/wasm/src/h3.rs`

WebTransport datagrams (draft-ietf-webtrans-http3 §4 over RFC 9297): each QUIC
datagram payload is `varint(quarter_session_id) || app_payload`, where
`quarter_session_id = connect_stream_id / 4`. For the first client-initiated bidi
stream (the CONNECT stream), `stream_id = 0`, so `quarter_session_id = 0`.

- [ ] **Step 1: Write datagram wrap/unwrap with a failing test**

Append to `crates/wasm/src/h3.rs`:
```rust
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
mod datagram_tests {
    use super::*;

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
}
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cd crates/wasm && RUSTUP_TOOLCHAIN=stable cargo test h3::datagram`
Expected: PASS — `datagram_quarter_id_roundtrip`.

- [ ] **Step 3: Commit**

```bash
git add crates/wasm/src/h3.rs
git commit -m "Add WebTransport datagram quarter-session-id framing"
```

---

## Task 5: WtEndpoint state machine + event queue

**Files:**
- Create: `crates/wasm/src/event.rs`
- Create: `crates/wasm/src/endpoint.rs`
- Modify: `crates/wasm/src/lib.rs` (`pub mod event; pub mod endpoint;`)

`WtEndpoint` owns a quinn-proto `Endpoint`, a map of connections, and per-connection
H3/WT session state. It exposes Rust-level methods the bridge will call: `recv`,
`poll_transmits`, `poll_timeout`, `handle_timeout`, `connect`, `poll_event`,
`send_datagram`. The WT session is established by: open the H3 control stream +
QPACK encoder/decoder streams (uni), send SETTINGS; client opens a bidi stream and
sends the Extended CONNECT request; server replies 200; both surface
`SessionEstablished`.

This task is the largest. Implement it behind tests that drive two `WtEndpoint`s
through an in-memory relay (mirroring the proven spike loop), asserting that both
reach `SessionEstablished` and that a datagram echoes.

- [ ] **Step 1: Define the event type**

Create `crates/wasm/src/event.rs`:
```rust
//! Events surfaced from the bridge to JS, plus a compact wire form for poll_event.
use crate::varint;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WtEvent {
    /// A QUIC connection completed its TLS handshake.
    Connected { conn: u32 },
    /// A WebTransport session is established (CONNECT 200 exchanged).
    SessionEstablished { conn: u32 },
    /// A WebTransport datagram arrived for the session.
    Datagram { conn: u32, data: Vec<u8> },
    /// The connection/session closed.
    Closed { conn: u32, code: u32 },
}

pub mod tag {
    pub const CONNECTED: u8 = 1;
    pub const SESSION_ESTABLISHED: u8 = 2;
    pub const DATAGRAM: u8 = 3;
    pub const CLOSED: u8 = 4;
}

impl WtEvent {
    /// Serialize as: tag(1) || conn varint || [code varint | len varint + bytes].
    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::new();
        match self {
            WtEvent::Connected { conn } => {
                out.push(tag::CONNECTED);
                varint::encode(*conn as u64, &mut out);
            }
            WtEvent::SessionEstablished { conn } => {
                out.push(tag::SESSION_ESTABLISHED);
                varint::encode(*conn as u64, &mut out);
            }
            WtEvent::Datagram { conn, data } => {
                out.push(tag::DATAGRAM);
                varint::encode(*conn as u64, &mut out);
                varint::encode(data.len() as u64, &mut out);
                out.extend_from_slice(data);
            }
            WtEvent::Closed { conn, code } => {
                out.push(tag::CLOSED);
                varint::encode(*conn as u64, &mut out);
                varint::encode(*code as u64, &mut out);
            }
        }
        out
    }
}
```

- [ ] **Step 2: Write the WtEndpoint skeleton + a failing loopback session test**

Create `crates/wasm/src/endpoint.rs`. Reuse the spike's crypto/config helpers
(make `server_crypto`/`client_crypto`/`AcceptAny` `pub(crate)` in `spike.rs` and
import them). Structure:
```rust
//! Sans-IO WebTransport endpoint: quinn-proto QUIC + minimal H3/WT session layer.
use std::collections::{HashMap, VecDeque};
use std::net::SocketAddr;
use std::sync::Arc;

use bytes::{Bytes, BytesMut};
use quinn_proto::{
    ClientConfig, Connection, ConnectionHandle, DatagramEvent, Dir, Endpoint, EndpointConfig,
    Event as QuicEvent, ServerConfig, StreamEvent, StreamId,
};
use web_time::Instant;

use crate::event::WtEvent;
use crate::h3;

#[derive(Default)]
struct Session {
    control_sent: bool,
    peer_settings: Option<h3::PeerSettings>,
    connect_stream: Option<StreamId>,
    connect_sent: bool,
    established: bool,
    // accumulates inbound control-stream bytes until a full SETTINGS frame is seen
    control_rx: Vec<u8>,
    // accumulates inbound CONNECT-stream bytes until a full HEADERS frame is seen
    connect_rx: Vec<u8>,
    control_recv_stream: Option<StreamId>,
}

pub struct WtEndpoint {
    inner: Endpoint,
    is_server: bool,
    addr: SocketAddr,
    peer_addr: SocketAddr,
    conns: HashMap<ConnectionHandle, Connection>,
    sessions: HashMap<ConnectionHandle, Session>,
    handle_to_id: HashMap<ConnectionHandle, u32>,
    next_id: u32,
    events: VecDeque<WtEvent>,
    client_config: Option<ClientConfig>,
}
```
Then implement (full method bodies; the agent writes these following the spike's
proven endpoint-driving pattern):
- `new(is_server, addr, peer_addr) -> WtEndpoint` — builds the quinn `Endpoint`
  (server gets `ServerConfig` from `spike::server_crypto`; client stores a
  `ClientConfig` from `spike::client_crypto`).
- `connect(authority) -> u32` — client: `inner.connect(...)`, registers the conn,
  returns its id, drains nothing yet (transmits pulled via `poll_transmits`).
- `recv(now, data)` — feeds `inner.handle`; on `NewConnection` calls
  `inner.accept`; on `ConnectionEvent` routes to the conn; then calls
  `drive(handle)` for any affected connection.
- `drive(handle)` — the per-connection pump: `conn.poll()` for `Connected`
  (push `WtEvent::Connected`, then `on_quic_connected`) and `Stream*` events;
  process readable control/CONNECT streams; advance the H3/WT state machine;
  drain datagrams (`conn.datagrams().recv()` → `h3::unwrap_datagram` →
  `WtEvent::Datagram`).
- `on_quic_connected(handle)` — open control uni stream
  (`streams().open(Dir::Uni)`), write `h3::encode_control_preamble`; open QPACK
  encoder/decoder uni streams and write their 1-byte stream-type ids; if client,
  open a bidi stream (`Dir::Bi`), record `connect_stream`, write
  `h3::encode_connect_request(authority, "/")`.
- control/CONNECT stream readers: read via `recv_stream(id).read(true)` /
  `Chunks`, append to the matching `*_rx` buffer, and parse incrementally:
  - control: skip the stream-type varint once, then read the SETTINGS frame;
    store `peer_settings`.
  - CONNECT (server side): parse the HEADERS frame; if `:method==CONNECT` &&
    `:protocol==webtransport`, write `h3::encode_connect_response_ok()` back on
    the same bidi stream, set `established=true`, push
    `WtEvent::SessionEstablished`.
  - CONNECT (client side): parse the HEADERS response; if `:status==200`, set
    `established=true`, push `WtEvent::SessionEstablished`.
- `send_datagram(conn_id, payload)` — look up the connection + its
  `connect_stream` id, `h3::wrap_datagram(stream_id, payload)`, then
  `conn.datagrams().send(Bytes::from(buf), true)`.
- `poll_transmits(now, out)` — for every connection, `poll_transmit` into a
  buffer; push each as a `(payload)` into `out` (P1 ignores addresses — the relay
  is point-to-point).
- `poll_timeout()` / `handle_timeout(now)` — min over connections; route timeouts.
- `poll_event() -> Option<WtEvent>` — `events.pop_front()`.

Add the failing test at the bottom:
```rust
#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;

    fn relay_step(from: &mut WtEndpoint, to: &mut WtEndpoint) -> bool {
        let now = Instant::now();
        let mut pkts = Vec::new();
        from.poll_transmits(now, &mut pkts);
        let moved = !pkts.is_empty();
        for p in pkts {
            to.recv(Instant::now(), &p);
        }
        moved
    }

    #[test]
    fn wt_session_and_datagram_echo() {
        let caddr = "127.0.0.1:5544".parse().unwrap();
        let saddr = "127.0.0.1:4433".parse().unwrap();
        let mut server = WtEndpoint::new(true, saddr, caddr);
        let mut client = WtEndpoint::new(false, caddr, saddr);
        let cid = client.connect("localhost");

        let mut server_est = false;
        let mut client_est = false;
        let mut echoed = false;

        for _ in 0..400 {
            let a = relay_step(&mut client, &mut server);
            let b = relay_step(&mut server, &mut client);

            while let Some(ev) = server.poll_event() {
                if let WtEvent::SessionEstablished { .. } = ev { server_est = true; }
                if let WtEvent::Datagram { conn, data } = ev {
                    // server echoes back
                    server.send_datagram(conn, &data);
                }
            }
            while let Some(ev) = client.poll_event() {
                match ev {
                    WtEvent::SessionEstablished { .. } => client_est = true,
                    WtEvent::Datagram { data, .. } => {
                        assert_eq!(data, b"ping");
                        echoed = true;
                    }
                    _ => {}
                }
            }

            if server_est && client_est && !echoed {
                client.send_datagram(cid, b"ping");
            }
            if echoed { break; }
            // advance timers if no packets moved
            if !a && !b {
                let now = Instant::now();
                server.handle_timeout(now);
                client.handle_timeout(now);
            }
        }
        assert!(server_est, "server session not established");
        assert!(client_est, "client session not established");
        assert!(echoed, "datagram did not echo");
    }
}
```

- [ ] **Step 3: Run the test (expect failures while implementing)**

Run: `cd crates/wasm && RUSTUP_TOOLCHAIN=stable cargo test endpoint::tests::wt_session_and_datagram_echo -- --nocapture`
Expected at first: FAIL (unimplemented methods / session not established). Iterate
on `drive`/readers until it passes. Common pitfalls to check while debugging:
QUIC stream reads return `Chunks` that must be `next()`-drained and the read
finalized; datagrams must be enabled (quinn-proto enables them by default when the
transport config allows — set `TransportConfig::datagram_receive_buffer_size` via
`EndpointConfig`/`ServerConfig` if `max_size()` returns `None`); the client must
open the CONNECT bidi stream only after `Connected`.

- [ ] **Step 4: Run to verify it passes**

Run: `cd crates/wasm && RUSTUP_TOOLCHAIN=stable cargo test endpoint::`
Expected: PASS — `wt_session_and_datagram_echo`.

- [ ] **Step 5: Commit**

```bash
git add crates/wasm/src/event.rs crates/wasm/src/endpoint.rs crates/wasm/src/lib.rs crates/wasm/src/spike.rs
git commit -m "Add WtEndpoint H3/WebTransport session state machine with datagram echo"
```

---

## Task 6: wasm-bindgen bridge exports

**Files:**
- Create: `crates/wasm/src/bridge.rs`
- Modify: `crates/wasm/src/lib.rs` (`mod bridge;`)

A global registry maps integer endpoint handles to `WtEndpoint`s (browsers are
single-threaded; use `thread_local!` + `RefCell`).

- [ ] **Step 1: Write the bridge**

Create `crates/wasm/src/bridge.rs`:
```rust
//! JS-facing wasm-bindgen API over a registry of WtEndpoints.
#![cfg(target_arch = "wasm32")]
use std::cell::RefCell;
use std::collections::HashMap;

use wasm_bindgen::prelude::*;
use web_time::Instant;

use crate::endpoint::WtEndpoint;

thread_local! {
    static REGISTRY: RefCell<HashMap<u32, WtEndpoint>> = RefCell::new(HashMap::new());
    static NEXT: RefCell<u32> = const { RefCell::new(1) };
}

#[wasm_bindgen]
pub fn wt_new_endpoint(is_server: bool, addr: &str, peer_addr: &str) -> u32 {
    let ep = WtEndpoint::new(is_server, addr.parse().unwrap(), peer_addr.parse().unwrap());
    let id = NEXT.with(|n| { let mut n = n.borrow_mut(); let id = *n; *n += 1; id });
    REGISTRY.with(|r| r.borrow_mut().insert(id, ep));
    id
}

#[wasm_bindgen]
pub fn wt_connect(eid: u32, authority: &str) -> i32 {
    REGISTRY.with(|r| match r.borrow_mut().get_mut(&eid) {
        Some(ep) => ep.connect(authority) as i32,
        None => -1,
    })
}

#[wasm_bindgen]
pub fn wt_recv_packet(eid: u32, data: &[u8]) {
    REGISTRY.with(|r| {
        if let Some(ep) = r.borrow_mut().get_mut(&eid) {
            ep.recv(Instant::now(), data);
        }
    });
}

/// Returns a flat buffer of `[len:u32-le | payload]...` of outbound datagrams.
#[wasm_bindgen]
pub fn wt_poll_transmits(eid: u32) -> Vec<u8> {
    REGISTRY.with(|r| {
        let mut out = Vec::new();
        if let Some(ep) = r.borrow_mut().get_mut(&eid) {
            let mut pkts = Vec::new();
            ep.poll_transmits(Instant::now(), &mut pkts);
            for p in pkts {
                out.extend_from_slice(&(p.len() as u32).to_le_bytes());
                out.extend_from_slice(&p);
            }
        }
        out
    })
}

#[wasm_bindgen]
pub fn wt_next_timeout_ms(eid: u32) -> f64 {
    REGISTRY.with(|r| match r.borrow_mut().get_mut(&eid) {
        Some(ep) => ep.next_timeout_ms(),
        None => -1.0,
    })
}

#[wasm_bindgen]
pub fn wt_handle_timeout(eid: u32) {
    REGISTRY.with(|r| {
        if let Some(ep) = r.borrow_mut().get_mut(&eid) {
            ep.handle_timeout(Instant::now());
        }
    });
}

#[wasm_bindgen]
pub fn wt_poll_event(eid: u32) -> Option<Vec<u8>> {
    REGISTRY.with(|r| {
        r.borrow_mut()
            .get_mut(&eid)
            .and_then(|ep| ep.poll_event().map(|e| e.encode()))
    })
}

#[wasm_bindgen]
pub fn wt_send_datagram(eid: u32, conn: u32, data: &[u8]) -> bool {
    REGISTRY.with(|r| match r.borrow_mut().get_mut(&eid) {
        Some(ep) => ep.send_datagram(conn, data),
        None => false,
    })
}
```
Add to `lib.rs`: `mod bridge;`. Add a `pub fn next_timeout_ms(&mut self) -> f64`
to `WtEndpoint` (computes ms-from-now from `poll_timeout()`, or `-1.0`); make
`WtEndpoint::send_datagram` return `bool`.

- [ ] **Step 2: Build to wasm and verify the exports exist**

Run: `cd crates/wasm && ./build-wasm.sh`
Then: `grep -c 'wt_new_endpoint\|wt_poll_transmits\|wt_send_datagram' pkg/wasm_spike.js`
Expected: build succeeds; grep count ≥ 3.

- [ ] **Step 3: Commit**

```bash
git add crates/wasm/src/bridge.rs crates/wasm/src/lib.rs crates/wasm/src/endpoint.rs
git commit -m "Add wasm-bindgen bridge exports for the WebTransport endpoint"
```

---

## Task 7: TS backend wrapper + in-memory relay

**Files:**
- Create: `packages/webtransport/src/wasm-relay.ts`
- Create: `packages/webtransport/src/backend-wasm.ts`

- [ ] **Step 1: Write the UDP transport interface + in-memory relay**

Create `packages/webtransport/src/wasm-relay.ts`:
```ts
// Minimal point-to-point UDP transport abstraction. The real Direct Sockets
// adapter (P4) implements the same interface; tests use InMemoryRelay.
export interface UdpTransport {
  send(data: Uint8Array): void;
  onPacket(cb: (data: Uint8Array) => void): void;
}

/** Two linked endpoints whose sends deliver to the other's onPacket. */
export class InMemoryRelay {
  readonly a: UdpTransport;
  readonly b: UdpTransport;
  constructor() {
    let aCb: ((d: Uint8Array) => void) | null = null;
    let bCb: ((d: Uint8Array) => void) | null = null;
    this.a = {
      send: (d) => bCb && queueMicrotask(() => bCb!(d)),
      onPacket: (cb) => { aCb = cb; },
    };
    this.b = {
      send: (d) => aCb && queueMicrotask(() => aCb!(d)),
      onPacket: (cb) => { bCb = cb; },
    };
  }
}
```

- [ ] **Step 2: Write the backend wrapper (P1 subset)**

Create `packages/webtransport/src/backend-wasm.ts`:
```ts
import type { UdpTransport } from "./wasm-relay.js";

type WasmModule = typeof import("../../../crates/wasm/pkg/wasm_spike.js");

const EVENT = { CONNECTED: 1, SESSION_ESTABLISHED: 2, DATAGRAM: 3, CLOSED: 4 } as const;

function decodeVarint(buf: Uint8Array, off: number): [number, number] {
  const first = buf[off];
  const len = 1 << (first >> 6);
  let v = first & 0x3f;
  for (let i = 1; i < len; i++) v = v * 256 + buf[off + i];
  return [v, off + len];
}

export interface WasmSessionEvents {
  onEstablished?: (conn: number) => void;
  onDatagram?: (conn: number, data: Uint8Array) => void;
  onClosed?: (conn: number, code: number) => void;
}

export class WasmEndpoint {
  private eid: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  constructor(
    private wasm: WasmModule,
    private udp: UdpTransport,
    isServer: boolean,
    addr: string,
    peerAddr: string,
    private events: WasmSessionEvents = {},
  ) {
    this.eid = wasm.wt_new_endpoint(isServer, addr, peerAddr);
    udp.onPacket((data) => {
      this.wasm.wt_recv_packet(this.eid, data);
      this.pump();
    });
  }

  connect(authority: string): number {
    const conn = this.wasm.wt_connect(this.eid, authority);
    this.pump();
    return conn;
  }

  sendDatagram(conn: number, data: Uint8Array): boolean {
    const ok = this.wasm.wt_send_datagram(this.eid, conn, data);
    this.pump();
    return ok;
  }

  /** Drain transmits to the wire, dispatch events, reschedule the timer. */
  pump(): void {
    if (this.closed) return;
    const out = this.wasm.wt_poll_transmits(this.eid);
    let off = 0;
    while (off + 4 <= out.length) {
      const len = out[off] | (out[off + 1] << 8) | (out[off + 2] << 16) | (out[off + 3] << 24);
      off += 4;
      this.udp.send(out.subarray(off, off + len));
      off += len;
    }
    for (let ev = this.wasm.wt_poll_event(this.eid); ev; ev = this.wasm.wt_poll_event(this.eid)) {
      this.dispatch(ev);
    }
    this.reschedule();
  }

  private dispatch(ev: Uint8Array): void {
    const tag = ev[0];
    let off = 1;
    let conn: number;
    [conn, off] = decodeVarint(ev, off);
    if (tag === EVENT.SESSION_ESTABLISHED) this.events.onEstablished?.(conn);
    else if (tag === EVENT.DATAGRAM) {
      let len: number;
      [len, off] = decodeVarint(ev, off);
      this.events.onDatagram?.(conn, ev.subarray(off, off + len));
    } else if (tag === EVENT.CLOSED) {
      let code: number;
      [code] = decodeVarint(ev, off);
      this.events.onClosed?.(conn, code);
    }
  }

  private reschedule(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const ms = this.wasm.wt_next_timeout_ms(this.eid);
    if (ms >= 0) {
      this.timer = setTimeout(() => {
        this.wasm.wt_handle_timeout(this.eid);
        this.pump();
      }, Math.max(0, ms));
    }
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
  }
}
```

- [ ] **Step 3: Typecheck**

Run: `cd packages/webtransport && bunx tsc --noEmit -p tsconfig.json` (or repo root `bun run typecheck`).
Expected: PASS (no type errors). If the wasm `pkg/` types aren't generated yet, run `crates/wasm/build-wasm.sh` first.

- [ ] **Step 4: Commit**

```bash
git add packages/webtransport/src/wasm-relay.ts packages/webtransport/src/backend-wasm.ts
git commit -m "Add TS WASM backend wrapper and in-memory UDP relay for tests"
```

---

## Task 8: P1 acceptance test — wasm↔wasm datagram echo in Bun

**Files:**
- Create: `packages/webtransport/test/wasm-datagram-echo.test.ts`

- [ ] **Step 1: Write the acceptance test**

Create `packages/webtransport/test/wasm-datagram-echo.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { InMemoryRelay } from "../src/wasm-relay.js";
import { WasmEndpoint } from "../src/backend-wasm.js";

// Loads the nodejs-target wasm-bindgen glue built by crates/wasm/build-wasm.sh.
const wasm = await import("../../../crates/wasm/pkg/wasm_spike.js");

describe("wasm WebTransport backend (P1)", () => {
  test("establishes a session and echoes a datagram", async () => {
    const relay = new InMemoryRelay();

    let serverEstablished = false;
    const server = new WasmEndpoint(wasm, relay.a, true, "127.0.0.1:4433", "127.0.0.1:5544", {
      onEstablished: () => { serverEstablished = true; },
      onDatagram: (conn, data) => { server.sendDatagram(conn, data); }, // echo
    });

    let received: Uint8Array | null = null;
    let clientEstablished = false;
    const client = new WasmEndpoint(wasm, relay.b, false, "127.0.0.1:5544", "127.0.0.1:4433", {
      onEstablished: () => { clientEstablished = true; },
      onDatagram: (_conn, data) => { received = data; },
    });

    const conn = client.connect("localhost");

    // Wait (bounded) for the session, per the no-unbounded-wait test rule.
    const deadline = Date.now() + 3000;
    while (!(serverEstablished && clientEstablished) && Date.now() < deadline) {
      await Bun.sleep(5);
    }
    expect(serverEstablished).toBe(true);
    expect(clientEstablished).toBe(true);

    client.sendDatagram(conn, new TextEncoder().encode("ping"));

    const echoDeadline = Date.now() + 3000;
    while (received === null && Date.now() < echoDeadline) {
      await Bun.sleep(5);
    }
    expect(received).not.toBeNull();
    expect(new TextDecoder().decode(received!)).toBe("ping");

    client.close();
    server.close();
  });
});
```

- [ ] **Step 2: Build wasm, then run the test**

Run:
```bash
crates/wasm/build-wasm.sh
cd packages/webtransport && bun test test/wasm-datagram-echo.test.ts
```
Expected: PASS — "establishes a session and echoes a datagram".

- [ ] **Step 3: Add an npm script to rebuild + test the wasm backend**

Add to root `package.json` scripts:
```
"build:wasm": "crates/wasm/build-wasm.sh",
"test:wasm": "crates/wasm/build-wasm.sh && bun test packages/webtransport/test/wasm-datagram-echo.test.ts"
```

- [ ] **Step 4: Commit**

```bash
git add packages/webtransport/test/wasm-datagram-echo.test.ts package.json
git commit -m "Add P1 acceptance test: wasm WebTransport datagram echo over loopback"
```

---

## Task 9: Document P1 status + parity row

**Files:**
- Modify: `docs/PARITY_MATRIX.md`
- Modify: `docs/superpowers/specs/2026-05-21-wasm-webtransport-backend-design.md`

- [ ] **Step 1: Add a wasm-backend parity row**

In `docs/PARITY_MATRIX.md`, add a `wasm` backend column/section noting: session
establishment ✓ (P1), datagrams ✓ (P1), streams ✗ (P2), real UDPSocket ✗ (P4),
Chromium interop ✗ (P5); intentional divergences (no `allowPooling`, no
`congestionControl` selection, no per-IP rate limiting).

- [ ] **Step 2: Mark P1 done in the spec**

In the design spec §5, change "P1 — H3/WT handshake + datagrams." to include
"(DONE — wasm↔wasm loopback)" with the test name.

- [ ] **Step 3: Commit**

```bash
git add docs/PARITY_MATRIX.md docs/superpowers/specs/2026-05-21-wasm-webtransport-backend-design.md
git commit -m "Document P1 completion and wasm backend parity status"
```

---

## Definition of Done (P1)

- `cargo test` in `crates/wasm` is green (varint, h3 settings/connect/datagram, WtEndpoint loopback session+echo, relocated spike handshake).
- `crates/wasm/build-wasm.sh` produces `pkg/` with the `wt_*` exports.
- `bun test packages/webtransport/test/wasm-datagram-echo.test.ts` is green: two wasm endpoints establish a WebTransport session and echo a datagram over the in-memory relay.
- No real `UDPSocket`, no browser, no streams yet — those are P2/P4.
- Existing native tests and `bun run typecheck` remain green (P1 adds files; it does not modify the native path).

## Self-Review Notes

- **Spec coverage:** P1 covers spec §3 (proven foundation reused via `spike.rs`), §4.3 bridge contract (subset: recv/transmit/timeout/event/connect/send_datagram), §4.4 pumps (timer + transmit drain; Direct Sockets adapter deferred to P4 behind the `UdpTransport` interface), §4.5 crypto/cert (reused from spike), §4.6 H3/WT layer (settings + Extended CONNECT + datagram framing). Streams (§4.3 stream APIs), backend selection (§4.2), packaging (§10), and IWA (§10) are explicitly deferred to later phases.
- **Type consistency:** Rust `WtEndpoint` methods (`new`, `connect`, `recv`, `poll_transmits`, `next_timeout_ms`, `handle_timeout`, `poll_event`, `send_datagram`) match the bridge call sites and the TS wrapper expectations. Event tag values (1–4) match between `event.rs`, `bridge.rs` encoding, and `backend-wasm.ts` `EVENT`. The wasm module name `wasm_spike` is used consistently in `build-wasm.sh`, `backend-wasm.ts`, and the test import (rename to a stable name is a P3 task).
- **Known soft spots flagged for the implementer:** Task 5 is the load-bearing one and may need iteration on QUIC stream-read draining and datagram enablement; the plan calls these out in Step 3. QPACK literal encoding (Task 3) is the minimal subset Chromium accepts for CONNECT; full interop with Chrome is validated in P5, not P1.
