//! Best-effort allocator residency release after a fully drained server close.
//!
//! DISPROVEN FOR THIS WORKLOAD (2026-08-03, macOS): a pre-registered on/off
//! A/B at the same SHA — two runs per arm on both the 4-session strict smoke
//! and the 200-session drain-all lane — measured a median post-close RSS
//! improvement of 0.086 MB (smoke) and 0.047 MB (200-session) against a
//! 1.0 MB retention gate. `malloc_zone_pressure_relief(NULL, 0)` reported
//! ~0 bytes released: the post-close residual is not reclaimable free pages
//! in the default malloc zones (Bun's JS heap uses mimalloc, and quinn's
//! buffers were not sitting in releasable spans). The close-path wiring was
//! therefore reverted; this module and its tests remain as the recorded
//! implementation and disproof so the experiment is not silently repeated.
//!
//! If a platform or allocator change makes this worth retrying, rerun the
//! same A/B before wiring it back in. It must only ever run after the drain
//! seam reports zero logical work, close success must never depend on it, and
//! the reported byte figure is allocator-reported — NOT verified against RSS
//! and never a retain/reject criterion on its own.

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResidencyRelief {
    pub platform: &'static str,
    pub applied: bool,
    /// Allocator-reported figure; NOT verified against RSS. Diagnostic only.
    pub reported_bytes_released: Option<u64>,
    pub refused_reason: Option<&'static str>,
}

/// Release idle allocator pages once a server close has fully drained.
///
/// `drained` must come from the post-drain seam (zero sessions, tasks, and
/// gauges). When it is false the call refuses instead of touching the
/// allocator, which doubles as the drain-ordering observable for tests.
pub fn release_drained_residency(drained: bool) -> ResidencyRelief {
    if std::env::var_os("WEBTRANSPORT_DISABLE_ALLOCATOR_RELIEF").is_some_and(|v| v == "1") {
        return ResidencyRelief {
            platform: platform_name(),
            applied: false,
            reported_bytes_released: None,
            refused_reason: Some("disabled"),
        };
    }
    if !drained {
        return ResidencyRelief {
            platform: platform_name(),
            applied: false,
            reported_bytes_released: None,
            refused_reason: Some("not-drained"),
        };
    }
    apply_relief()
}

fn apply_relief() -> ResidencyRelief {
    // This dylib's Rust allocations go through mimalloc (see lib.rs
    // GLOBAL_ALLOCATOR). mi_collect(force) frees deferred segments, reclaims
    // abandoned pages, and purges free pages back to the OS immediately —
    // unlike macOS malloc_zone_pressure_relief, which is a measured no-op.
    // mi_collect only affects the calling thread's heap plus abandoned
    // segments, so long-lived runtime threads should also purge via the
    // mi_option purge settings configured at startup.
    unsafe extern "C" {
        fn mi_collect(force: bool);
    }
    unsafe { mi_collect(true) };
    ResidencyRelief {
        platform: platform_name(),
        applied: true,
        reported_bytes_released: None,
        refused_reason: None,
    }
}

fn platform_name() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "other"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relief_refuses_when_not_drained() {
        let r = release_drained_residency(false);
        assert!(!r.applied);
        assert_eq!(r.refused_reason, Some("not-drained"));
    }

    #[test]
    fn relief_reports_platform_and_never_panics_when_drained() {
        let r = release_drained_residency(true);
        assert!(!r.platform.is_empty());
        // mimalloc is the global allocator on every supported platform, so a
        // drained relief always applies.
        assert!(r.applied);
    }

    #[test]
    fn relief_is_idempotent() {
        release_drained_residency(true);
        release_drained_residency(true);
    }
}
