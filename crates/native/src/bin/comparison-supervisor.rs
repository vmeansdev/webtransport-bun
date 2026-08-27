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
/// The supervisor's grant registry and the executions it has open.
///
/// One per supervisor process, holding the campaign's whole execution set.
/// The registry is what makes a grant single-use, so it is also what stops one
/// honest leg from answering for every cell: the second cell to present that
/// leg is presenting a grant this registry has already spent.
#[cfg(not(windows))]
#[cfg_attr(not(test), allow(dead_code))]
struct ResidentAdmission {
    grants: secure_fs::measurement::GrantRegistry,
}

#[cfg(not(windows))]
#[cfg_attr(not(test), allow(dead_code))]
impl ResidentAdmission {
    fn new() -> Self {
        Self {
            grants: secure_fs::measurement::GrantRegistry::new(),
        }
    }

    /// Mint one execution's grant and return the `run-command` payload that
    /// carries it.
    ///
    /// Called as the run-command input frame is written — before the child
    /// exists, so before it can have measured anything.  The issuing instant
    /// is the bracket's lower edge and the registry keeps it; nothing about it
    /// comes back out of a frame.
    fn open_execution(
        &mut self,
        request: &secure_fs::measurement::GrantRequest,
    ) -> Result<Vec<u8>, &'static str> {
        self.grants
            .issue(request)
            .and_then(|grant| grant.run_command_payload())
            .map_err(|refusal| refusal.code())
    }

    /// Stamped as the `artifact-payload` frame is accepted, closing the
    /// bracket the series is checked against.
    ///
    /// The execution is named here, by the supervisor that opened it — never
    /// read out of the frame, which would let the payload choose which grant
    /// it is checked against.
    fn accept_artifact_payload(
        &mut self,
        execution: &secure_fs::measurement::ExecutionKey,
        frame_bytes: &[u8],
    ) -> Result<secure_fs::measurement::AdmittedSeries, &'static str> {
        let accepted_at_ms = secure_fs::measurement::now_epoch_millis();
        self.grants
            .admit_artifact_payload_frame(execution, frame_bytes, accepted_at_ms)
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
                // The frame transport for that loop — the child spawn and the
                // pipes the frames ride — is still the next phase's work.  The
                // admission rules it enforces are `ResidentAdmission` above,
                // which is deliberately reachable and testable before the
                // transport around it exists: the rules are what a fabricated
                // series has to defeat, and they should not be written for the
                // first time inside a loop.
                let _admission = ResidentAdmission::new();
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
    use secure_fs::measurement::{
        admit_series, ExecutionKey, GrantRequest, MeasurementRefusal, WallBracket,
    };
    use serde_json::Value;

    fn execution(index: u64, transport: &str) -> ExecutionKey {
        ExecutionKey {
            campaign_id: "r1-phase2".to_string(),
            run_id: format!("run-cell-{index:03}"),
            execution_index: index,
            transport: transport.to_string(),
        }
    }

    fn request(index: u64, transport: &str, message_count: u64) -> GrantRequest {
        GrantRequest {
            candidate: "candidate-phase2".to_string(),
            execution: execution(index, transport),
            declared_message_count: message_count,
            declared_message_bytes: 1_024,
        }
    }

    /// The grant exactly as the child receives it: the bytes of the
    /// `run-command` payload, decoded and echoed back untouched.
    fn granted(admission: &mut ResidentAdmission, request: &GrantRequest) -> Value {
        let payload = admission.open_execution(request).expect("grant is issued");
        serde_json::from_slice(&payload).expect("the run-command payload is a record")
    }

    /// A series shaped exactly as the driver's leg record is: `samples`,
    /// `roundTrips`, `provenance` and the adapter `ledger`, carrying the grant
    /// the child was handed for the execution it measured.
    fn series(
        grant: Option<&Value>,
        first_at_ms: f64,
        step_ms: f64,
        latency_ms: f64,
        count: usize,
    ) -> Vec<u8> {
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
        let mut record = serde_json::json!({
            "samples": samples,
            "roundTrips": trips,
            "ledger": { "attempted": count, "delivered": count },
            "provenance": {
                "sampleCount": count,
                "firstSampleAtMs": first_at_ms,
                "lastSampleAtMs": last,
            },
        });
        if let Some(grant) = grant {
            record["grant"] = grant.clone();
        }
        let mut bytes = serde_json::to_vec(&record).expect("series encodes");
        bytes.push(b'\n');
        bytes
    }

    /// An honest leg for a grant, taken inside the interval the grant opened.
    fn honest_leg(grant: &Value, count: usize) -> Vec<u8> {
        let issued = grant["issuedAt"].as_f64().expect("issuedAt is a number");
        series(Some(grant), issued + 2.0, 0.2, 0.5, count)
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
        let mut admission = ResidentAdmission::new();
        let spec = request(1, "ws", 64);
        let grant = granted(&mut admission, &spec);
        let payload = honest_leg(&grant, 6);
        // The leg has to be over before the payload frame arrives, so the
        // bracket only closes after the interval the series claims.
        std::thread::sleep(std::time::Duration::from_millis(20));
        let admitted = admission
            .accept_artifact_payload(&spec.execution, &framed(&payload))
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
        let mut admission = ResidentAdmission::new();
        let spec = request(1, "wt", 4_096);
        let grant = granted(&mut admission, &spec);
        let payload = series(Some(&grant), 1_000.0, 0.0, 28.6, 1_000);
        assert_eq!(
            admission
                .accept_artifact_payload(&spec.execution, &framed(&payload))
                .map(|_| ()),
            Err("MEASUREMENT_OUTSIDE_GRANT_WINDOW"),
        );
    }

    /// The same forgery re-based onto the supervisor's own clock still cannot
    /// be admitted: 1,000 round trips of 28.6 ms need 28.6 seconds, and the
    /// bracket around a leg that took milliseconds does not hold them.
    #[test]
    fn a_rebased_stepping_clock_still_overruns_the_bracket() {
        let mut admission = ResidentAdmission::new();
        let spec = request(1, "wt", 4_096);
        let grant = granted(&mut admission, &spec);
        let issued = grant["issuedAt"].as_f64().expect("issuedAt");
        let payload = series(Some(&grant), issued + 1.0, 0.0, 28.6, 1_000);
        assert_eq!(
            admission
                .accept_artifact_payload(&spec.execution, &framed(&payload))
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
        let honest = series(None, now, 0.2, 0.5, 6);
        assert!(admit_series(&honest, &bracket).is_ok());
        let text = String::from_utf8(honest).expect("utf8");
        let padded = text.replace("\"delivered\":6", "\"delivered\":1800");
        assert_eq!(
            admit_series(padded.as_bytes(), &bracket).map(|_| ()),
            Err(MeasurementRefusal::SeriesLedgerDiverges),
        );
    }

    /// A frame that is not an `artifact-payload` is not a measurement, however
    /// well-formed the series inside it is.
    #[test]
    fn a_non_artifact_payload_frame_is_never_admitted() {
        let mut admission = ResidentAdmission::new();
        let spec = request(1, "ws", 64);
        let grant = granted(&mut admission, &spec);
        let payload = honest_leg(&grant, 3);
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
            admission
                .accept_artifact_payload(&spec.execution, &frame)
                .map(|_| ()),
            Err("TRUST_CHILD_FRAME_INVALID"),
        );
    }

    // -----------------------------------------------------------------------
    // The grant
    // -----------------------------------------------------------------------

    /// A payload that never claims to have been authorised.  This is the
    /// phase-1 series verbatim — it passes M1 and M2 — and it is refused
    /// anyway, which is the whole of what the grant adds.
    #[test]
    fn a_payload_carrying_no_grant_is_refused() {
        let mut admission = ResidentAdmission::new();
        let spec = request(1, "ws", 64);
        let grant = granted(&mut admission, &spec);
        let issued = grant["issuedAt"].as_f64().expect("issuedAt");
        let payload = series(None, issued + 2.0, 0.2, 0.5, 6);
        std::thread::sleep(std::time::Duration::from_millis(20));
        assert_eq!(
            admission
                .accept_artifact_payload(&spec.execution, &framed(&payload))
                .map(|_| ()),
            Err("MEASUREMENT_GRANT_ABSENT"),
        );
    }

    /// One execution, one presentation.  The second attempt has nothing
    /// outstanding to present, because the first spent it.
    #[test]
    fn an_execution_gets_exactly_one_presentation() {
        let mut admission = ResidentAdmission::new();
        let spec = request(1, "ws", 64);
        let grant = granted(&mut admission, &spec);
        let payload = framed(&honest_leg(&grant, 6));
        std::thread::sleep(std::time::Duration::from_millis(20));
        assert!(admission
            .accept_artifact_payload(&spec.execution, &payload)
            .is_ok());
        assert_eq!(
            admission
                .accept_artifact_payload(&spec.execution, &payload)
                .map(|_| ()),
            Err("MEASUREMENT_GRANT_ABSENT"),
        );
    }

    /// A grant already spent on one execution, presented for the next.  The
    /// series inside it is a real one that really was admitted; what it cannot
    /// be is admitted twice.
    #[test]
    fn a_replayed_grant_is_refused() {
        let mut admission = ResidentAdmission::new();
        let first = request(1, "ws", 64);
        let second = request(2, "ws", 64);
        let grant = granted(&mut admission, &first);
        let _ = granted(&mut admission, &second);
        let payload = framed(&honest_leg(&grant, 6));
        std::thread::sleep(std::time::Duration::from_millis(20));
        assert!(admission
            .accept_artifact_payload(&first.execution, &payload)
            .is_ok());
        assert_eq!(
            admission
                .accept_artifact_payload(&second.execution, &payload)
                .map(|_| ()),
            Err("MEASUREMENT_GRANT_ABSENT"),
        );
    }

    /// A grant that has never been spent, presented under an execution it was
    /// not issued for.  Distinct from replay in diagnosis and identical in
    /// outcome: the execution in front of the supervisor has no grant.
    #[test]
    fn a_grant_issued_for_another_execution_is_refused() {
        let mut registry = secure_fs::measurement::GrantRegistry::new();
        let first = request(1, "ws", 64);
        let second = request(2, "ws", 64);
        let issued = registry.issue(&first).expect("first grant");
        let _ = registry.issue(&second).expect("second grant");
        let echoed: Value =
            serde_json::from_slice(&issued.run_command_payload().expect("payload")).expect("json");
        let payload = honest_leg(&echoed, 6);
        let accepted_at_ms = secure_fs::measurement::now_epoch_millis() + 50.0;
        let refusal = registry
            .admit_payload(&second.execution, &payload, accepted_at_ms)
            .expect_err("a grant for another execution is refused");
        assert_eq!(refusal, MeasurementRefusal::GrantBoundToAnotherExecution);
        assert_eq!(refusal.code(), "MEASUREMENT_GRANT_ABSENT");
    }

    /// A grant whose execution is right and whose record is not.  The
    /// supervisor issued no such thing, so this execution is presenting no
    /// grant rather than presenting somebody else's.
    #[test]
    fn a_grant_the_supervisor_did_not_issue_is_refused() {
        let mut registry = secure_fs::measurement::GrantRegistry::new();
        let spec = request(1, "ws", 64);
        let issued = registry.issue(&spec).expect("grant");
        let mut echoed: Value =
            serde_json::from_slice(&issued.run_command_payload().expect("payload")).expect("json");
        echoed["declaredMessageCount"] = serde_json::json!(1_000_000);
        let payload = honest_leg(&echoed, 6);
        let accepted_at_ms = secure_fs::measurement::now_epoch_millis() + 50.0;
        assert_eq!(
            registry
                .admit_payload(&spec.execution, &payload, accepted_at_ms)
                .map(|_| ()),
            Err(MeasurementRefusal::GrantAbsent),
        );
    }

    /// The grant declares how many messages the execution was authorised to
    /// send, so a series longer than that is reporting traffic nobody asked
    /// for — even though it is internally consistent and inside the bracket.
    #[test]
    fn a_series_longer_than_the_grant_authorised_is_refused() {
        let mut registry = secure_fs::measurement::GrantRegistry::new();
        let spec = request(1, "ws", 4);
        let issued = registry.issue(&spec).expect("grant");
        let echoed: Value =
            serde_json::from_slice(&issued.run_command_payload().expect("payload")).expect("json");
        let payload = honest_leg(&echoed, 6);
        let accepted_at_ms = secure_fs::measurement::now_epoch_millis() + 50.0;
        assert_eq!(
            registry
                .admit_payload(&spec.execution, &payload, accepted_at_ms)
                .map(|_| ()),
            Err(MeasurementRefusal::SeriesLedgerDiverges),
        );
        assert!(registry
            .admit_payload(&request(2, "ws", 4).execution, &payload, accepted_at_ms)
            .is_err());
    }

    /// The failure mode the phase exists to close: one leg that genuinely ran,
    /// spent across a campaign.
    ///
    /// M1 cannot see this.  Every one of the 105 presentations carries a real
    /// series, inside a real bracket, with a ledger that agrees with it — the
    /// leg happened.  What makes 104 of them false is not anything about the
    /// numbers; it is that they are the same numbers, and the campaign is
    /// counting them as 105 measurements.  The grant is the only thing in the
    /// design that asks that question.
    #[test]
    fn one_honest_leg_cannot_answer_for_a_hundred_and_five_cells() {
        let mut registry = secure_fs::measurement::GrantRegistry::new();
        let specs: Vec<GrantRequest> = (1..=105).map(|index| request(index, "wt", 64)).collect();
        let mut echoed_first: Option<Value> = None;
        for spec in &specs {
            let issued = registry.issue(spec).expect("every execution is granted");
            if echoed_first.is_none() {
                echoed_first = Some(
                    serde_json::from_slice(&issued.run_command_payload().expect("payload"))
                        .expect("json"),
                );
            }
        }
        assert_eq!(registry.outstanding_count(), 105);

        let leg = honest_leg(echoed_first.as_ref().expect("first grant"), 6);
        let accepted_at_ms = secure_fs::measurement::now_epoch_millis() + 50.0;
        let admitted = registry
            .admit_payload(&specs[0].execution, &leg, accepted_at_ms)
            .expect("the leg that really ran is admitted, once");
        assert_eq!(admitted.sample_count, 6);

        let mut refusals = Vec::new();
        for spec in &specs[1..] {
            let refusal = registry
                .admit_payload(&spec.execution, &leg, accepted_at_ms)
                .expect_err("a spent leg answers for no further cell");
            assert_eq!(refusal.code(), "MEASUREMENT_GRANT_ABSENT");
            refusals.push(refusal);
        }
        assert_eq!(refusals.len(), 104);
        assert!(refusals
            .iter()
            .all(|refusal| *refusal == MeasurementRefusal::GrantReplayed));
        assert_eq!(registry.outstanding_count(), 0);
    }

    /// A grant is unpredictable and belongs to one execution, so two of them
    /// are never interchangeable.
    #[test]
    fn each_execution_gets_its_own_unrepeatable_grant() {
        let mut registry = secure_fs::measurement::GrantRegistry::new();
        let first = registry.issue(&request(1, "ws", 64)).expect("first");
        let second = registry.issue(&request(2, "ws", 64)).expect("second");
        assert_ne!(first.nonce_sha256, second.nonce_sha256);
        assert_eq!(first.nonce_sha256.len(), 64);
        assert!(first.not_after_ms > first.issued_at_ms);
        // An execution the supervisor has already authorised is not
        // authorised again.
        assert_eq!(
            registry.issue(&request(1, "ws", 64)).map(|_| ()),
            Err(MeasurementRefusal::GrantReplayed),
        );
    }

    /// The record the child echoes is the record the supervisor wrote, byte
    /// for byte, and it fits the frozen `run-command` bound.
    #[test]
    fn the_grant_record_round_trips_through_its_canonical_bytes() {
        let mut registry = secure_fs::measurement::GrantRegistry::new();
        let grant = registry.issue(&request(7, "wt", 512)).expect("grant");
        let bytes = grant.run_command_payload().expect("payload");
        assert!(bytes.len() as u64 <= secure_fs::measurement::RUN_COMMAND_MAX_BYTES);
        assert_eq!(bytes.last(), Some(&b'\n'));
        let text = String::from_utf8(bytes.clone()).expect("utf8");
        // Keys in ASCII order, so both languages encode the same bytes.
        let mut keys: Vec<&str> = Vec::new();
        for key in [
            "campaignId",
            "candidate",
            "declaredMessageBytes",
            "declaredMessageCount",
            "executionIndex",
            "issuedAt",
            "nonceSha256",
            "notAfter",
            "runId",
            "schema",
            "transport",
        ] {
            assert!(text.contains(&format!("\"{key}\":")), "missing {key}");
            keys.push(key);
        }
        let mut sorted = keys.clone();
        sorted.sort_unstable();
        assert_eq!(keys, sorted);
        let mut offset = 0usize;
        for key in &keys {
            let at = text.find(&format!("\"{key}\":")).expect("key present");
            assert!(at >= offset, "{key} is out of canonical order");
            offset = at;
        }
    }

    /// A grant is admissible only inside its own lifetime, whatever the
    /// bracket would have said.
    #[test]
    fn a_grant_presented_after_it_expires_is_refused() {
        let mut registry = secure_fs::measurement::GrantRegistry::new();
        let spec = request(1, "ws", 64);
        let issued = registry.issue(&spec).expect("grant");
        let echoed: Value =
            serde_json::from_slice(&issued.run_command_payload().expect("payload")).expect("json");
        let payload = honest_leg(&echoed, 6);
        let expired_at_ms = issued.not_after_ms as f64 + 1.0;
        assert_eq!(
            registry
                .admit_payload(&spec.execution, &payload, expired_at_ms)
                .map(|_| ()),
            Err(MeasurementRefusal::OutsideGrantWindow),
        );
    }
}
