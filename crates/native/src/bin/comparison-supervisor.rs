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

/// The admission step of the resident phase loop, for one execution.
///
/// The supervisor writes the run-command input frame, then waits for the role
/// child's `artifact-payload` output frame.  It holds both instants itself, so
/// the interval the leg had to happen in is a supervisor observation and not
/// something the child can state.  A series claiming a window outside that
/// interval did not happen on this run.
///
/// Fail-closed by construction, and the direction matters: the cost of a bug
/// here is a refused honest execution, never an admitted fabricated one.  A
/// refusal kills the owned process group and creates no descriptor file — the
/// supervisor is the only writer, so a refused series is unwritable rather
/// than merely unpublished.
#[cfg(not(windows))]
#[cfg_attr(not(test), allow(dead_code))]
struct ResidentAdmission {
    grant_issued_at_ms: f64,
}

#[cfg(not(windows))]
#[cfg_attr(not(test), allow(dead_code))]
impl ResidentAdmission {
    /// Stamped as the run-command frame is written — before the child exists,
    /// so before it can have measured anything.
    fn open_execution() -> Self {
        Self {
            grant_issued_at_ms: secure_fs::measurement::now_epoch_millis(),
        }
    }

    /// Stamped as the `artifact-payload` frame is accepted, closing the
    /// bracket the series is checked against.
    fn accept_artifact_payload(
        &self,
        frame_bytes: &[u8],
    ) -> Result<secure_fs::measurement::AdmittedSeries, &'static str> {
        let bracket = secure_fs::measurement::WallBracket {
            grant_issued_at_ms: self.grant_issued_at_ms,
            frame_accepted_at_ms: secure_fs::measurement::now_epoch_millis(),
        };
        secure_fs::measurement::admit_artifact_payload_frame(frame_bytes, &bracket)
    }
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
                // resident phase loop attaches here: each execution opens an
                // admission bracket before its run-command frame is written
                // and closes it on the child's `artifact-payload` frame.
                //
                // The frame transport for that loop — the child spawn, the
                // pipes and the grant that rides the run-command frame — is
                // the next phase's work.  The admission rules it enforces are
                // `ResidentAdmission` above, which is deliberately reachable
                // and testable before the transport around it exists: the
                // rules are what a fabricated series has to defeat, and they
                // should not be written for the first time inside a loop.
                let _admission = ResidentAdmission::open_execution();
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

#[cfg(all(test, not(windows)))]
mod resident_admission_tests {
    use super::*;
    use secure_fs::measurement::{admit_series, WallBracket};

    /// A series shaped exactly as the driver's leg record is: `samples`,
    /// `roundTrips`, `provenance` and the adapter `ledger`.
    fn series(first_at_ms: f64, step_ms: f64, latency_ms: f64, count: usize) -> Vec<u8> {
        let mut samples = Vec::new();
        let mut trips = Vec::new();
        let mut sent = first_at_ms;
        let mut last = first_at_ms;
        for sequence in 1..=count {
            let received = sent + latency_ms;
            samples.push(serde_json::json!(latency_ms));
            trips.push(serde_json::json!({
                "sequence": sequence,
                "sentAtMs": sent,
                "receivedAtMs": received,
                "latencyMs": latency_ms,
            }));
            last = received;
            sent = received + step_ms;
        }
        let mut bytes = serde_json::to_vec(&serde_json::json!({
            "samples": samples,
            "roundTrips": trips,
            "ledger": { "attempted": count, "delivered": count },
            "provenance": {
                "sampleCount": count,
                "firstSampleAtMs": first_at_ms,
                "lastSampleAtMs": last,
            },
        }))
        .expect("series encodes");
        bytes.push(b'\n');
        bytes
    }

    fn framed(payload: &[u8]) -> Vec<u8> {
        let mut header = serde_json::to_vec(&serde_json::json!({
            "kind": "artifact-payload",
            "schema": "comparison-supervisor-frame/v1",
        }))
        .expect("header encodes");
        header.push(b'\n');
        secure_fs::supervisor::frame::encode_frame(
            &header,
            payload,
            secure_fs::measurement::ARTIFACT_PAYLOAD_MAX_BYTES,
        )
        .expect("frame encodes")
    }

    /// The bracket is the supervisor's, so an honest leg taken inside it is
    /// admitted through the same path the resident loop will use.
    #[test]
    fn an_honest_leg_inside_the_bracket_is_admitted() {
        let admission = ResidentAdmission::open_execution();
        let payload = series(admission.grant_issued_at_ms + 1.0, 0.2, 0.5, 6);
        // The leg has to be over before the payload frame arrives, so the
        // bracket only closes after the interval the series claims.
        std::thread::sleep(std::time::Duration::from_millis(20));
        let admitted = admission
            .accept_artifact_payload(&framed(&payload))
            .expect("honest leg is admitted");
        assert_eq!(admitted.sample_count, 6);
        assert_eq!(admitted.delivered, 6);
        assert!(admitted.latency_sum_ms <= admitted.span_ms);
    }

    /// The reviewer's forgery in the shape that defeated both in-process
    /// guards: a stepping clock, a thousand samples, 28.6 ms apiece.  Nothing
    /// about it is malformed and its own ledger agrees with it; what it cannot
    /// do is fit inside an interval the supervisor observed.
    #[test]
    fn a_stepping_clock_series_is_refused_on_the_bracket() {
        let admission = ResidentAdmission::open_execution();
        let payload = series(1_000.0, 0.0, 28.6, 1_000);
        assert_eq!(
            admission
                .accept_artifact_payload(&framed(&payload))
                .map(|_| ()),
            Err("MEASUREMENT_OUTSIDE_GRANT_WINDOW"),
        );
    }

    /// The same forgery re-based onto the supervisor's own clock still cannot
    /// be admitted: 1,000 round trips of 28.6 ms need 28.6 seconds, and the
    /// bracket around a leg that took milliseconds does not hold them.
    #[test]
    fn a_rebased_stepping_clock_still_overruns_the_bracket() {
        let admission = ResidentAdmission::open_execution();
        let payload = series(admission.grant_issued_at_ms + 1.0, 0.0, 28.6, 1_000);
        assert_eq!(
            admission
                .accept_artifact_payload(&framed(&payload))
                .map(|_| ()),
            Err("MEASUREMENT_OUTSIDE_GRANT_WINDOW"),
        );
    }

    /// M2 on its own: a window the bracket accepts, beside a ledger that
    /// recorded different traffic.
    #[test]
    fn a_series_the_ledger_contradicts_is_refused() {
        let now = secure_fs::measurement::now_epoch_millis();
        let bracket = WallBracket {
            grant_issued_at_ms: now - 1_000.0,
            frame_accepted_at_ms: now + 1_000.0,
        };
        let honest = series(now, 0.2, 0.5, 6);
        assert!(admit_series(&honest, &bracket).is_ok());
        let text = String::from_utf8(honest).expect("utf8");
        let padded = text.replace("\"delivered\":6", "\"delivered\":1800");
        assert_eq!(
            admit_series(padded.as_bytes(), &bracket).map(|_| ()),
            Err(secure_fs::measurement::MeasurementRefusal::SeriesLedgerDiverges),
        );
    }

    /// A frame that is not an `artifact-payload` is not a measurement, however
    /// well-formed the series inside it is.
    #[test]
    fn a_non_artifact_payload_frame_is_never_admitted() {
        let admission = ResidentAdmission::open_execution();
        let payload = series(admission.grant_issued_at_ms + 1.0, 0.2, 0.5, 3);
        std::thread::sleep(std::time::Duration::from_millis(20));
        let mut header = serde_json::to_vec(&serde_json::json!({
            "kind": "server-telemetry",
            "schema": "comparison-supervisor-frame/v1",
        }))
        .expect("header encodes");
        header.push(b'\n');
        let frame = secure_fs::supervisor::frame::encode_frame(
            &header,
            &payload,
            secure_fs::measurement::ARTIFACT_PAYLOAD_MAX_BYTES,
        )
        .expect("frame encodes");
        assert_eq!(
            admission.accept_artifact_payload(&frame).map(|_| ()),
            Err("TRUST_CHILD_FRAME_INVALID"),
        );
    }
}
