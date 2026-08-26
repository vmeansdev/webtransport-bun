//! `comparison-supervisor`: the sole official comparison filesystem and
//! process supervisor for the R1 WS/WT comparison campaign.
//!
//! The Windows stub is the first executable branch: it runs before argument
//! parsing, environment access, descriptor access, module/addon loading,
//! pathname access, child spawn, or artifact access, and exits with the
//! frozen boundary/platform-unavailable code.
//!
//! On macOS and Linux, official authority bootstrap (anonymous-pipe authority
//! frames, staged capability, campaign lock) is Task C scope; until it is
//! wired, every subcommand fails closed with
//! `OUTPUT_TRUST_BOUNDARY_UNAVAILABLE` and writes no official output.

// The binary compiles the boundary module directly rather than linking the
// napi addon library: the cdylib's N-API imports resolve only inside a Node
// or Bun host process, never in a standalone executable.  Only the supervisor
// gate is reachable here until Task C wires authority bootstrap.
#[cfg_attr(not(test), allow(dead_code))]
#[path = "../secure_fs.rs"]
mod secure_fs;

use std::io::Write;
use std::process::ExitCode;

fn main() -> ExitCode {
    // Platform gate first: zero argument/environment/path/descriptor/loader/
    // spawn access on Windows.
    #[cfg(windows)]
    {
        let mut stderr = std::io::stderr().lock();
        let _ = stderr.write_all(secure_fs::supervisor::platform_unsupported_stderr().as_bytes());
        return ExitCode::from(secure_fs::supervisor::PLATFORM_UNSUPPORTED_EXIT as u8);
    }

    #[cfg(not(windows))]
    {
        // Authority arrives only over supervisor-owned bootstrap pipes; that
        // bootstrap is Task C scope.  Fail closed without touching any
        // argument-derived path, environment authority, or descriptor.
        let mut stderr = std::io::stderr().lock();
        let _ =
            stderr.write_all(secure_fs::supervisor::trust_boundary_unavailable_stderr().as_bytes());
        ExitCode::from(secure_fs::supervisor::PLATFORM_UNSUPPORTED_EXIT as u8)
    }
}
