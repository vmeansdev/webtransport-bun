//! WebTransport error codes and the §4.4 application-error remap.
//!
//! draft-ietf-webtrans-http3 §4.4 requires that a 32-bit WebTransport
//! application error code be remapped into the QUIC error space
//! `0x52e4a40fa8db..=0x52e5ac983162` before it is carried on a QUIC
//! RESET_STREAM / STOP_SENDING frame. The `floor(n / 0x1e)` term inserts a gap
//! every 30 codes so the output never lands on a reserved HTTP/3 codepoint of
//! the form `0x1f * N + 0x21`; no separate reserved-skip pass is needed.

/// Inclusive lower bound of the WT application-error range (§9.5), `f(0)`.
pub const WT_APP_ERROR_FIRST: u64 = 0x52e4_a40f_a8db;
/// Inclusive upper bound of the WT application-error range, `f(0xffffffff)`.
pub const WT_APP_ERROR_LAST: u64 = 0x52e5_ac98_3162;

/// WT_SESSION_GONE (§9.5): reset code for streams orphaned by session teardown.
pub const WT_SESSION_GONE: u32 = 0x170d_7b68;
/// WT_BUFFERED_STREAM_REJECTED (§9.5): a buffered stream was dropped at capacity.
pub const WT_BUFFERED_STREAM_REJECTED: u32 = 0x3994_bd84;

/// Remap a 32-bit WebTransport application error code into the QUIC error range
/// per §4.4 Figure 4: `first + n + floor(n / 0x1e)`.
///
/// The result is always within `WT_APP_ERROR_FIRST..=WT_APP_ERROR_LAST`, is
/// strictly monotonic in `code`, and never collides with a reserved HTTP/3
/// codepoint `0x1f * N + 0x21`.
pub fn remap_application_error(code: u32) -> u64 {
    let n = u64::from(code);
    WT_APP_ERROR_FIRST + n + n / 0x1e
}

/// Inverse of [`remap_application_error`]: recover the 32-bit application error
/// code from a QUIC error code carried on an inbound WT-stream RESET_STREAM /
/// STOP_SENDING. Returns `None` for values outside the WT application range or
/// that land on the reserved-codepoint gap (i.e. are not a valid remap image),
/// so callers can pass such codes through unchanged.
pub fn unmap_application_error(v: u64) -> Option<u32> {
    if !(WT_APP_ERROR_FIRST..=WT_APP_ERROR_LAST).contains(&v) {
        return None;
    }
    let d = v - WT_APP_ERROR_FIRST;
    // Each block of 30 inputs maps to 31 outputs (one reserved gap at r == 30).
    let (q, r) = (d / 31, d % 31);
    if r == 30 {
        return None; // reserved-codepoint gap, not a remap image
    }
    let n = q * 30 + r;
    u32::try_from(n).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoints_match_spec() {
        assert_eq!(remap_application_error(0), WT_APP_ERROR_FIRST);
        assert_eq!(remap_application_error(0xffff_ffff), WT_APP_ERROR_LAST);
    }

    fn is_reserved(v: u64) -> bool {
        // Reserved HTTP/3 codepoints have the form 0x1f * N + 0x21.
        v >= 0x21 && (v - 0x21) % 0x1f == 0
    }

    #[test]
    fn unmap_inverts_remap_strided() {
        let mut n: u64 = 0;
        while n <= 0xffff_ffff {
            let v = remap_application_error(n as u32);
            assert_eq!(unmap_application_error(v), Some(n as u32), "n={n:#x}");
            n += 0x1_0007;
        }
        let last = remap_application_error(0xffff_ffff);
        assert_eq!(unmap_application_error(last), Some(0xffff_ffff));
    }

    #[test]
    fn unmap_rejects_out_of_range_and_reserved() {
        // Below/above range pass through as None (caller keeps raw code).
        assert_eq!(unmap_application_error(0), None);
        assert_eq!(unmap_application_error(42), None);
        assert_eq!(unmap_application_error(WT_APP_ERROR_FIRST - 1), None);
        assert_eq!(unmap_application_error(WT_APP_ERROR_LAST + 1), None);
        // The reserved gap (d == 30) is not a valid remap image.
        assert_eq!(unmap_application_error(WT_APP_ERROR_FIRST + 30), None);
    }

    #[test]
    fn strided_property_holds() {
        // Fast default sweep: strictly increasing, in range, no reserved
        // collision. Stride is coprime-ish with 0x1e so successive samples land
        // in different residue classes.
        let mut prev = None;
        let mut n: u64 = 0;
        while n <= 0xffff_ffff {
            let v = remap_application_error(n as u32);
            assert!((WT_APP_ERROR_FIRST..=WT_APP_ERROR_LAST).contains(&v));
            assert!(!is_reserved(v), "reserved collision at n={n:#x} -> {v:#x}");
            if let Some(p) = prev {
                assert!(v > p, "not strictly increasing at n={n:#x}");
            }
            prev = Some(v);
            n += 0x1_0007;
        }
    }

    #[test]
    #[ignore = "exhaustive 0..=0xffffffff sweep; run explicitly or in CI"]
    fn exhaustive_property_holds() {
        let mut prev = WT_APP_ERROR_FIRST;
        assert_eq!(remap_application_error(0), prev);
        for n in 1u64..=0xffff_ffff {
            let v = remap_application_error(n as u32);
            debug_assert!(v > prev);
            debug_assert!(!is_reserved(v));
            prev = v;
        }
        assert_eq!(prev, WT_APP_ERROR_LAST);
    }
}
