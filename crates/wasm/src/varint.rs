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
        for &n in &[
            0u64,
            0x3f,
            0x40,
            0x3fff,
            0x4000,
            0x3fff_ffff,
            0x4000_0000,
            u64::MAX >> 2,
        ] {
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
