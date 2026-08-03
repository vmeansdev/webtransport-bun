//! Best-effort allocator residency release after a fully drained server close.
//!
//! The load evidence showed post-close RSS held above the cold-start baseline
//! while every logical gauge was zero: freed native pages stay resident in the
//! allocator. This module asks the platform allocator to return idle pages to
//! the OS. It runs only after the drain seam reports zero logical work, close
//! success never depends on it, and the reported byte figure is
//! allocator-reported — it is NOT verified against RSS and must never drive a
//! retain/reject decision on its own.

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

#[cfg(target_os = "macos")]
fn apply_relief() -> ResidencyRelief {
    unsafe extern "C" {
        fn malloc_zone_pressure_relief(zone: *mut core::ffi::c_void, goal: usize) -> usize;
    }
    // NULL zone = all zones; goal 0 = release as much as possible.
    let reported = unsafe { malloc_zone_pressure_relief(core::ptr::null_mut(), 0) };
    ResidencyRelief {
        platform: "macos",
        applied: true,
        reported_bytes_released: Some(reported as u64),
        refused_reason: None,
    }
}

#[cfg(all(target_os = "linux", target_env = "gnu"))]
fn apply_relief() -> ResidencyRelief {
    unsafe extern "C" {
        fn malloc_trim(pad: usize) -> core::ffi::c_int;
    }
    // malloc_trim returns 1 when memory was released; no byte count exists.
    let rc = unsafe { malloc_trim(0) };
    ResidencyRelief {
        platform: "linux-gnu",
        applied: rc == 1,
        reported_bytes_released: None,
        refused_reason: None,
    }
}

#[cfg(not(any(target_os = "macos", all(target_os = "linux", target_env = "gnu"))))]
fn apply_relief() -> ResidencyRelief {
    ResidencyRelief {
        platform: platform_name(),
        applied: false,
        reported_bytes_released: None,
        refused_reason: Some("unsupported-platform"),
    }
}

fn platform_name() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(all(target_os = "linux", target_env = "gnu")) {
        "linux-gnu"
    } else {
        "unsupported"
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
        #[cfg(any(target_os = "macos", all(target_os = "linux", target_env = "gnu")))]
        assert!(r.applied);
        #[cfg(not(any(target_os = "macos", all(target_os = "linux", target_env = "gnu"))))]
        assert!(!r.applied);
    }

    #[test]
    fn relief_is_idempotent() {
        release_drained_residency(true);
        release_drained_residency(true);
    }
}
