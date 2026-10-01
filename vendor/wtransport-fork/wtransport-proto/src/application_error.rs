use crate::varint::VarInt;

/// First HTTP/3 error code reserved for `WT_APPLICATION_ERROR`.
pub const WT_APPLICATION_ERROR_FIRST: u64 = 0x52e4_a40f_a8db;

/// Last HTTP/3 error code reserved for `WT_APPLICATION_ERROR`.
pub const WT_APPLICATION_ERROR_LAST: u64 = 0x52e5_ac98_3162;

/// Number of usable codepoints between two consecutive HTTP/3 greased values.
const GREASE_STRIDE: u64 = 0x1e;

/// Maps a 32-bit WebTransport application error code onto the HTTP/3 error
/// code space, as described by `WT_APPLICATION_ERROR`.
///
/// The mapping is `first + n + floor(n / 0x1e)`, which by construction never
/// produces a value of the form `0x1f * N + 0x21` (those codepoints are
/// reserved for HTTP/3 greasing), so no extra skipping is required.
pub fn remap(code: u32) -> VarInt {
    let n = u64::from(code);
    let mapped = WT_APPLICATION_ERROR_FIRST + n + n / GREASE_STRIDE;

    debug_assert!(mapped <= WT_APPLICATION_ERROR_LAST);

    VarInt::try_from_u64(mapped).expect("remapped code is within varint bounds")
}

/// Inverse of [`remap`].
///
/// Returns `None` if `code` lies outside the `WT_APPLICATION_ERROR` range, or
/// if it falls on one of the reserved codepoints the mapping skips.
pub fn unmap(code: VarInt) -> Option<u32> {
    let code = code.into_inner();

    if !(WT_APPLICATION_ERROR_FIRST..=WT_APPLICATION_ERROR_LAST).contains(&code) {
        return None;
    }

    let delta = code - WT_APPLICATION_ERROR_FIRST;
    let (quotient, remainder) = (delta / (GREASE_STRIDE + 1), delta % (GREASE_STRIDE + 1));

    if remainder == GREASE_STRIDE {
        return None;
    }

    u32::try_from(quotient * GREASE_STRIDE + remainder).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn is_grease(code: u64) -> bool {
        code >= 0x21 && (code - 0x21) % 0x1f == 0
    }

    #[test]
    fn range_endpoints() {
        assert_eq!(remap(0).into_inner(), WT_APPLICATION_ERROR_FIRST);
        assert_eq!(remap(u32::MAX).into_inner(), WT_APPLICATION_ERROR_LAST);
    }

    #[test]
    fn round_trip_exhaustive() {
        // Walking every 32-bit code takes too long under a debug build, so
        // sample densely around the block boundaries the mapping cares about
        // plus a wide arithmetic sweep.
        let mut codes: Vec<u32> = (0..100_000).collect();
        codes.extend((0..1_000).map(|i| u32::MAX - i));
        codes.extend((0..200_000u32).map(|i| i.wrapping_mul(21_474)));

        for code in codes {
            let mapped = remap(code);
            assert_eq!(unmap(mapped), Some(code), "round trip failed for {code}");
            assert!(!is_grease(mapped.into_inner()), "{code} mapped onto grease");
        }
    }

    /// The sampled round trip is the one that runs by default; this walks the
    /// whole code space and is worth running by hand after touching the
    /// arithmetic (`cargo test --release -- --ignored`).
    #[test]
    #[ignore = "walks all 2^32 codes; minutes, not seconds"]
    fn round_trip_every_code() {
        for code in 0..=u32::MAX {
            let mapped = remap(code);
            assert_eq!(unmap(mapped), Some(code));
            assert!(!is_grease(mapped.into_inner()));
        }
    }

    #[test]
    fn monotonic_and_gap_free_within_a_block() {
        let mut previous = remap(0).into_inner();
        for code in 1..10_000u32 {
            let mapped = remap(code).into_inner();
            assert!(mapped > previous);
            assert!(mapped - previous <= 2);
            previous = mapped;
        }
    }

    #[test]
    fn unmap_rejects_out_of_range_and_reserved() {
        assert_eq!(unmap(VarInt::from_u32(42)), None);
        assert_eq!(
            unmap(VarInt::try_from_u64(WT_APPLICATION_ERROR_FIRST - 1).unwrap()),
            None
        );
        assert_eq!(
            unmap(VarInt::try_from_u64(WT_APPLICATION_ERROR_LAST + 1).unwrap()),
            None
        );

        // The codepoint the mapping steps over after the first 0x1e codes.
        let skipped = WT_APPLICATION_ERROR_FIRST + GREASE_STRIDE;
        assert!(is_grease(skipped));
        assert_eq!(unmap(VarInt::try_from_u64(skipped).unwrap()), None);
    }
}
