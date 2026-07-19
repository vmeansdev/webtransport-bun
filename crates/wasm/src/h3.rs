//! Minimal HTTP/3 + WebTransport framing (no dynamic QPACK table).
//!
//! Wire constants per RFC 9114 (HTTP/3), RFC 9204 (QPACK), RFC 9297 (datagrams),
//! and draft-ietf-webtrans-http3.

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
    QPACK_STATIC_TABLE.get(index as usize).copied()
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

/// Decode a QPACK field section into (name, value) pairs. Supports the encodings
/// a peer realistically uses without a dynamic table: indexed field lines and
/// literal field lines (literal name, or static name reference). Huffman-coded
/// strings are not decoded (returns None if encountered).
pub fn decode_literal_headers(mut buf: &[u8]) -> Option<Vec<(String, String)>> {
    if buf.len() < 2 {
        return None;
    }
    buf = &buf[2..]; // skip the 2-byte field section prefix (RIC=0, base=0)
    let mut out = Vec::new();
    while !buf.is_empty() {
        let first = *buf.first()?;
        if first & 0x80 != 0 {
            // Indexed Field Line: 1 T index(6). T=1 -> static table.
            let static_table = first & 0x40 != 0;
            let (idx, n) = qpack_int_decode(buf, 6)?;
            buf = &buf[n..];
            if static_table {
                let (name, value) = qpack_static(idx)?;
                out.push((name.to_string(), value.to_string()));
            } else {
                return None; // dynamic table unsupported
            }
        } else if first & 0x40 != 0 {
            // Literal Field Line With Name Reference: 0 1 N T index(4).
            let static_table = first & 0x10 != 0;
            let (idx, n) = qpack_int_decode(buf, 4)?;
            buf = &buf[n..];
            let name = if static_table {
                qpack_static(idx)?.0.to_string()
            } else {
                return None;
            };
            let value = read_qpack_string(&mut buf)?;
            out.push((name, value));
        } else if first & 0x20 != 0 {
            // Literal Field Line With Literal Name: 0 0 1 N H nameLen(3).
            let huffman = first & 0x08 != 0;
            let (nlen, n1) = qpack_int_decode(buf, 3)?;
            buf = &buf[n1..];
            let raw = buf.get(..nlen as usize)?;
            buf = &buf[nlen as usize..];
            let name = decode_qpack_bytes(raw, huffman)?;
            let value = read_qpack_string(&mut buf)?;
            out.push((name, value));
        } else {
            return None; // post-base / dynamic encodings unsupported
        }
    }
    Some(out)
}

/// Read a QPACK string literal: 1-bit Huffman flag + 7-bit length prefix + bytes.
/// Decodes HPACK Huffman when the flag is set.
fn read_qpack_string(buf: &mut &[u8]) -> Option<String> {
    let huffman = (*buf.first()?) & 0x80 != 0;
    let (len, n) = qpack_int_decode(buf, 7)?;
    *buf = &buf[n..];
    let raw = buf.get(..len as usize)?;
    *buf = &buf[len as usize..];
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
        for _ in 0..20 {
            buf.push(0x80); // continuation, value bits 0, keep going
        }
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
