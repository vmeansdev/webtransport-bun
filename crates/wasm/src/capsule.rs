//! WebTransport session capsules (draft-ietf-webtrans-http3 §6, RFC 9297).
//!
//! On an established CONNECT stream the WebTransport session is controlled by a
//! sequence of capsules carried as the payload of HTTP/3 DATA frames. Each
//! capsule is `Type (varint) + Length (varint) + Value`. We implement the two
//! session-lifecycle capsules:
//!
//! * `WT_CLOSE_SESSION` (0x2843): `Application Error Code (u32, big-endian)` +
//!   `Reason (UTF-8, <= 1024 bytes)`.
//! * `WT_DRAIN_SESSION` (0x78ae): empty payload.
//!
//! Parsing is bounded and panic-free: a capsule split across multiple DATA
//! frames (or multiple QUIC reads) is accumulated in [`CapsuleAssembler`] up to
//! a hard cap, and any protocol violation is surfaced as an error rather than a
//! panic. This mirrors the native wtransport fork's capsule wire format so
//! wasm<->native session close/drain interoperate.

use crate::varint;

/// `WT_CLOSE_SESSION` capsule type.
pub const CAPSULE_CLOSE_WT_SESSION: u64 = 0x2843;
/// `WT_DRAIN_SESSION` capsule type.
pub const CAPSULE_DRAIN_WT_SESSION: u64 = 0x78ae;

/// Maximum length, in bytes, of a session-close reason (§6).
pub const MAX_REASON_LEN: usize = 1024;

/// HTTP/3 DATA frame type (RFC 9114 §7.2.1); the carrier for capsules.
const H3_DATA_FRAME: u64 = 0x00;

/// Hard cap on a single accumulated capsule. The only capsules we parse have a
/// value of at most `4 + MAX_REASON_LEN`; anything claiming more is rejected
/// long before it can grow the buffer without bound.
const MAX_CAPSULE_VALUE_LEN: u64 = (4 + MAX_REASON_LEN) as u64;

/// A parsed session-lifecycle capsule.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Capsule {
    /// `WT_CLOSE_SESSION`: application error code + reason.
    Close { code: u32, reason: String },
    /// `WT_DRAIN_SESSION`.
    Drain,
}

/// A capsule-layer protocol violation. The peer's CONNECT stream must be reset
/// with `H3_MESSAGE_ERROR` when one of these is observed (§6).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CapsuleError {
    /// A `WT_CLOSE_SESSION` value was too short (<4B) or over-long (>4+1024B).
    CloseLength,
    /// A `WT_CLOSE_SESSION` reason was not valid UTF-8.
    CloseUtf8,
    /// A capsule length exceeded the hard accumulation cap.
    TooLarge,
}

/// Truncate `reason` to at most [`MAX_REASON_LEN`] bytes on a UTF-8 character
/// boundary (§6 requires senders truncate at a character boundary).
pub fn truncate_reason(reason: &[u8]) -> &[u8] {
    if reason.len() <= MAX_REASON_LEN {
        return reason;
    }
    let mut end = MAX_REASON_LEN;
    // Back up out of the middle of a multi-byte UTF-8 sequence (continuation
    // bytes are 0b10xxxxxx).
    while end > 0 && (reason[end] & 0xC0) == 0x80 {
        end -= 1;
    }
    &reason[..end]
}

/// Encode a `WT_CLOSE_SESSION` capsule (type + length + value) with the reason
/// truncated to a UTF-8 boundary. Returns the raw capsule bytes (not yet wrapped
/// in a DATA frame).
pub fn encode_close(code: u32, reason: &[u8]) -> Vec<u8> {
    let reason = truncate_reason(reason);
    let mut value = Vec::with_capacity(4 + reason.len());
    value.extend_from_slice(&code.to_be_bytes());
    value.extend_from_slice(reason);
    encode_capsule(CAPSULE_CLOSE_WT_SESSION, &value)
}

/// Encode a `WT_DRAIN_SESSION` capsule (empty value).
pub fn encode_drain() -> Vec<u8> {
    encode_capsule(CAPSULE_DRAIN_WT_SESSION, &[])
}

/// Wrap raw capsule bytes in the HTTP/3 DATA frame that carries them on the
/// CONNECT stream, matching the native fork's `Capsule::into_frame`.
pub fn into_data_frame(capsule: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(capsule.len() + 8);
    varint::encode(H3_DATA_FRAME, &mut out);
    varint::encode(capsule.len() as u64, &mut out);
    out.extend_from_slice(capsule);
    out
}

/// Convenience: a `WT_CLOSE_SESSION` capsule wrapped in its DATA frame, ready to
/// write to the CONNECT stream.
pub fn close_data_frame(code: u32, reason: &[u8]) -> Vec<u8> {
    into_data_frame(&encode_close(code, reason))
}

/// Convenience: a `WT_DRAIN_SESSION` capsule wrapped in its DATA frame.
pub fn drain_data_frame() -> Vec<u8> {
    into_data_frame(&encode_drain())
}

fn encode_capsule(kind: u64, value: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(value.len() + 8);
    varint::encode(kind, &mut out);
    varint::encode(value.len() as u64, &mut out);
    out.extend_from_slice(value);
    out
}

/// Outcome of attempting to parse one capsule from the front of a buffer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CapsuleParse {
    /// A recognized capsule was parsed; `consumed` bytes were used.
    Parsed { capsule: Capsule, consumed: usize },
    /// A well-formed capsule of an unrecognized type; skip `consumed` bytes.
    Skipped { consumed: usize },
    /// Not enough bytes yet; feed more and retry.
    Incomplete,
    /// A protocol violation; the CONNECT stream must be reset.
    Error(CapsuleError),
}

/// Parse a single capsule from the front of `buf` without consuming it. The
/// caller advances by `consumed` on `Parsed`/`Skipped`.
pub fn parse_capsule(buf: &[u8]) -> CapsuleParse {
    let Some((kind, n1)) = varint::decode(buf) else {
        return CapsuleParse::Incomplete;
    };
    let Some((len, n2)) = varint::decode(&buf[n1..]) else {
        return CapsuleParse::Incomplete;
    };
    // Bound every capsule we accumulate. Known capsules never exceed this; an
    // unknown capsule claiming more than the cap is treated as hostile.
    if len > MAX_CAPSULE_VALUE_LEN {
        return CapsuleParse::Error(CapsuleError::TooLarge);
    }
    let header = n1 + n2;
    let total = header + len as usize;
    if buf.len() < total {
        return CapsuleParse::Incomplete;
    }
    let value = &buf[header..total];
    match kind {
        CAPSULE_CLOSE_WT_SESSION => match parse_close_value(value) {
            Ok(capsule) => CapsuleParse::Parsed {
                capsule,
                consumed: total,
            },
            Err(e) => CapsuleParse::Error(e),
        },
        CAPSULE_DRAIN_WT_SESSION => CapsuleParse::Parsed {
            capsule: Capsule::Drain,
            consumed: total,
        },
        _ => CapsuleParse::Skipped { consumed: total },
    }
}

fn parse_close_value(value: &[u8]) -> Result<Capsule, CapsuleError> {
    if value.len() < 4 || value.len() > 4 + MAX_REASON_LEN {
        return Err(CapsuleError::CloseLength);
    }
    let code = u32::from_be_bytes([value[0], value[1], value[2], value[3]]);
    let reason = std::str::from_utf8(&value[4..])
        .map_err(|_| CapsuleError::CloseUtf8)?
        .to_string();
    Ok(Capsule::Close { code, reason })
}

/// Bounded accumulator for capsules arriving on the CONNECT stream. DATA-frame
/// payloads are fed in as they are decoded; complete capsules are popped in
/// order. A capsule fragmented across feeds is reassembled here.
#[derive(Debug, Default)]
pub struct CapsuleAssembler {
    buf: Vec<u8>,
}

impl CapsuleAssembler {
    pub fn new() -> Self {
        Self { buf: Vec::new() }
    }

    /// Append DATA-frame payload bytes.
    pub fn push(&mut self, data: &[u8]) {
        self.buf.extend_from_slice(data);
    }

    /// Bytes currently buffered awaiting more input.
    pub fn buffered(&self) -> usize {
        self.buf.len()
    }

    /// Pop the next complete capsule, if any. Returns:
    /// * `Ok(Some(capsule))` for a recognized capsule (unknown types are
    ///   silently skipped, matching the native receiver),
    /// * `Ok(None)` when more bytes are needed,
    /// * `Err(_)` on a protocol violation (reset the CONNECT stream).
    pub fn next(&mut self) -> Result<Option<Capsule>, CapsuleError> {
        loop {
            match parse_capsule(&self.buf) {
                CapsuleParse::Parsed { capsule, consumed } => {
                    self.buf.drain(..consumed);
                    return Ok(Some(capsule));
                }
                CapsuleParse::Skipped { consumed } => {
                    self.buf.drain(..consumed);
                    // Keep scanning for a capsule we care about.
                    continue;
                }
                CapsuleParse::Incomplete => return Ok(None),
                CapsuleParse::Error(e) => return Err(e),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn close_round_trips() {
        let bytes = encode_close(0x0102_0304, b"bye");
        match parse_capsule(&bytes) {
            CapsuleParse::Parsed { capsule, consumed } => {
                assert_eq!(consumed, bytes.len());
                assert_eq!(
                    capsule,
                    Capsule::Close {
                        code: 0x0102_0304,
                        reason: "bye".to_string()
                    }
                );
            }
            other => panic!("expected Parsed, got {other:?}"),
        }
    }

    #[test]
    fn drain_round_trips() {
        let bytes = encode_drain();
        assert_eq!(
            parse_capsule(&bytes),
            CapsuleParse::Parsed {
                capsule: Capsule::Drain,
                consumed: bytes.len()
            }
        );
    }

    #[test]
    fn empty_reason_and_zero_code() {
        let bytes = encode_close(0, b"");
        match parse_capsule(&bytes) {
            CapsuleParse::Parsed { capsule, .. } => assert_eq!(
                capsule,
                Capsule::Close {
                    code: 0,
                    reason: String::new()
                }
            ),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn reason_truncated_at_utf8_boundary() {
        // 400 x 3-byte char = 1200 bytes > 1024. Truncation must not split a
        // char; 1024 / 3 = 341 full chars = 1023 bytes.
        let s = "√".repeat(400); // U+221A is 3 bytes in UTF-8
        assert!(s.len() > MAX_REASON_LEN);
        let bytes = encode_close(7, s.as_bytes());
        match parse_capsule(&bytes) {
            CapsuleParse::Parsed {
                capsule: Capsule::Close { code, reason },
                ..
            } => {
                assert_eq!(code, 7);
                assert!(reason.len() <= MAX_REASON_LEN);
                assert_eq!(reason.len(), 1023);
                assert!(reason.chars().all(|c| c == '√'));
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn max_length_reason_is_accepted() {
        let reason = vec![b'a'; MAX_REASON_LEN];
        let bytes = encode_close(1, &reason);
        match parse_capsule(&bytes) {
            CapsuleParse::Parsed {
                capsule: Capsule::Close { reason, .. },
                ..
            } => assert_eq!(reason.len(), MAX_REASON_LEN),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn over_length_close_value_rejected() {
        // Hand-craft a close capsule whose declared value length exceeds the cap.
        let mut bytes = Vec::new();
        varint::encode(CAPSULE_CLOSE_WT_SESSION, &mut bytes);
        varint::encode((4 + MAX_REASON_LEN + 1) as u64, &mut bytes);
        bytes.extend(std::iter::repeat(0u8).take(4 + MAX_REASON_LEN + 1));
        assert_eq!(
            parse_capsule(&bytes),
            CapsuleParse::Error(CapsuleError::TooLarge)
        );
    }

    #[test]
    fn short_close_value_rejected() {
        let mut bytes = Vec::new();
        varint::encode(CAPSULE_CLOSE_WT_SESSION, &mut bytes);
        varint::encode(3, &mut bytes); // < 4 bytes
        bytes.extend_from_slice(&[0, 0, 0]);
        assert_eq!(
            parse_capsule(&bytes),
            CapsuleParse::Error(CapsuleError::CloseLength)
        );
    }

    #[test]
    fn invalid_utf8_reason_rejected() {
        let mut value = Vec::new();
        value.extend_from_slice(&1u32.to_be_bytes());
        value.push(0xff); // invalid UTF-8
        let bytes = encode_capsule(CAPSULE_CLOSE_WT_SESSION, &value);
        assert_eq!(
            parse_capsule(&bytes),
            CapsuleParse::Error(CapsuleError::CloseUtf8)
        );
    }

    #[test]
    fn unknown_capsule_is_skipped() {
        let bytes = encode_capsule(0x1234, b"whatever");
        match parse_capsule(&bytes) {
            CapsuleParse::Skipped { consumed } => assert_eq!(consumed, bytes.len()),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn fragmented_capsule_reassembles() {
        let full = encode_close(0xdead_beef, b"fragmented reason string");
        // Feed the capsule one byte at a time; only the last byte completes it.
        let mut asm = CapsuleAssembler::new();
        for (i, b) in full.iter().enumerate() {
            asm.push(&[*b]);
            let got = asm.next().unwrap();
            if i + 1 < full.len() {
                assert_eq!(got, None, "capsule completed early at byte {i}");
            } else {
                assert_eq!(
                    got,
                    Some(Capsule::Close {
                        code: 0xdead_beef,
                        reason: "fragmented reason string".to_string()
                    })
                );
            }
        }
    }

    #[test]
    fn assembler_pops_multiple_and_skips_unknown() {
        let mut stream = Vec::new();
        stream.extend_from_slice(&encode_drain());
        stream.extend_from_slice(&encode_capsule(0x1234, b"skip me"));
        stream.extend_from_slice(&encode_close(9, b"end"));
        // Split the concatenation at an awkward offset to exercise reassembly.
        let mut asm = CapsuleAssembler::new();
        asm.push(&stream[..3]);
        asm.push(&stream[3..]);
        assert_eq!(asm.next().unwrap(), Some(Capsule::Drain));
        assert_eq!(
            asm.next().unwrap(),
            Some(Capsule::Close {
                code: 9,
                reason: "end".to_string()
            })
        );
        assert_eq!(asm.next().unwrap(), None);
    }

    #[test]
    fn data_frame_wrapping_round_trips() {
        let frame = close_data_frame(0x11, b"hi");
        // DATA frame: type(0x00) + len + capsule bytes.
        let (ftype, n1) = varint::decode(&frame).unwrap();
        assert_eq!(ftype, H3_DATA_FRAME);
        let (flen, n2) = varint::decode(&frame[n1..]).unwrap();
        let payload = &frame[n1 + n2..n1 + n2 + flen as usize];
        assert_eq!(
            parse_capsule(payload),
            CapsuleParse::Parsed {
                capsule: Capsule::Close {
                    code: 0x11,
                    reason: "hi".to_string()
                },
                consumed: payload.len()
            }
        );
    }

    #[test]
    fn parser_never_panics_on_arbitrary_bytes() {
        // Deterministic fuzz: xorshift over many lengths and payloads.
        let mut state: u64 = 0x9E37_79B9_7F4A_7C15;
        let mut rng = || {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state
        };
        for _ in 0..20_000 {
            let len = (rng() % 2100) as usize;
            let mut buf = Vec::with_capacity(len);
            for _ in 0..len {
                buf.push((rng() & 0xff) as u8);
            }
            // Single-shot parse must never panic.
            let _ = parse_capsule(&buf);
            // Assembler fed in random splits must never panic and stay bounded.
            let mut asm = CapsuleAssembler::new();
            let mid = if len == 0 {
                0
            } else {
                (rng() as usize) % (len + 1)
            };
            asm.push(&buf[..mid]);
            let _ = asm.next();
            asm.push(&buf[mid..]);
            loop {
                match asm.next() {
                    Ok(Some(_)) => continue,
                    Ok(None) | Err(_) => break,
                }
            }
            assert!(asm.buffered() <= buf.len());
        }
    }
}
