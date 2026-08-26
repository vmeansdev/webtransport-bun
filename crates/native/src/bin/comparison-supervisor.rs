//! `comparison-supervisor`: the sole official comparison filesystem and
//! process supervisor for the R1 WS/WT comparison campaign.
//!
//! The Windows stub is the first executable branch: it runs before argument
//! parsing, environment access, descriptor access, module/addon loading,
//! pathname access, child spawn, or artifact access, and exits with the
//! frozen boundary/platform-unavailable code.
//!
//! On macOS and Linux the supervisor runs its live trust bootstrap: authority
//! bytes arrive only over the anonymous bootstrap pipe, the expected digest
//! only over the independent digest descriptor, the campaign and staging
//! roots are taken into supervisor ownership and matched field-for-field
//! against the authority's declarations, and the lock, capability and
//! manifest are read through those pinned roots.  Absent, malformed, or
//! invalid authority fails closed with `OUTPUT_TRUST_BOUNDARY_UNAVAILABLE`
//! and writes no official output.

// The binary compiles the boundary module directly rather than linking the
// napi addon library: the cdylib's N-API imports resolve only inside a Node
// or Bun host process, never in a standalone executable.
#[cfg_attr(not(test), allow(dead_code))]
#[path = "../secure_fs.rs"]
mod secure_fs;

use std::io::Write;
use std::process::ExitCode;

/// Resolves one `--name <decimal fd>` option, requiring exactly one
/// occurrence and a non-negative decimal value.
///
/// This resolves only the four descriptors the trust bootstrap itself needs.
/// The complete frozen option list, its exact order, mode dispatch, and the
/// remaining five descriptors are the entrypoint contract and are validated
/// there; a descriptor this function does not own is left untouched.
#[cfg(not(windows))]
fn descriptor_option(args: &[String], name: &str) -> Result<i32, &'static str> {
    let mut found: Option<i32> = None;
    let mut index = 0;
    while index < args.len() {
        if args[index] == name {
            let value = args
                .get(index + 1)
                .ok_or("TRUST_DESCRIPTOR_ARGUMENT_INVALID")?;
            let parsed = value
                .parse::<i32>()
                .map_err(|_| "TRUST_DESCRIPTOR_ARGUMENT_INVALID")?;
            if parsed < 0 {
                return Err("TRUST_DESCRIPTOR_ARGUMENT_INVALID");
            }
            // A repeated descriptor option is an ambiguity the supervisor
            // must not resolve by preferring one occurrence.
            if found.is_some() {
                return Err("TRUST_DESCRIPTOR_ARGUMENT_INVALID");
            }
            found = Some(parsed);
            index += 2;
            continue;
        }
        index += 1;
    }
    found.ok_or("TRUST_DESCRIPTOR_ARGUMENT_INVALID")
}

/// Every descriptor the supervisor owns must be a distinct number: two
/// options naming one descriptor would let a single handle stand in for two
/// independent roots.
#[cfg(not(windows))]
fn resolve_descriptors(
    args: &[String],
) -> Result<secure_fs::supervisor::ResidentDescriptors, &'static str> {
    let descriptors = secure_fs::supervisor::ResidentDescriptors {
        authority_fd: descriptor_option(args, "--authority-fd")?,
        authority_digest_fd: descriptor_option(args, "--authority-digest-fd")?,
        campaign_root_fd: descriptor_option(args, "--campaign-root-fd")?,
        staging_root_fd: descriptor_option(args, "--staging-root-fd")?,
    };
    let numbers = [
        descriptors.authority_fd,
        descriptors.authority_digest_fd,
        descriptors.campaign_root_fd,
        descriptors.staging_root_fd,
    ];
    for (position, number) in numbers.iter().enumerate() {
        if numbers[position + 1..].contains(number) {
            return Err("TRUST_DESCRIPTOR_ARGUMENT_INVALID");
        }
    }
    Ok(descriptors)
}

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
        let args: Vec<String> = std::env::args().skip(1).collect();
        let bootstrapped = resolve_descriptors(&args)
            .and_then(|descriptors| secure_fs::supervisor::run_trust_bootstrap(&descriptors));
        match bootstrapped {
            Ok(_summary) => {
                // Authority, both owned roots, the lock, the capability and
                // the manifest are validated, and the supervisor holds its
                // own handles to the campaign and staging roots.  The
                // resident phase loop attaches here.
                ExitCode::SUCCESS
            }
            Err(_) => {
                let mut stderr = std::io::stderr().lock();
                let _ = stderr.write_all(
                    secure_fs::supervisor::trust_boundary_unavailable_stderr().as_bytes(),
                );
                ExitCode::from(secure_fs::supervisor::PLATFORM_UNSUPPORTED_EXIT as u8)
            }
        }
    }
}
