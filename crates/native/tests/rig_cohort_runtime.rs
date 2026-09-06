//! B3.5: the rig supervisor's half of the §5 Phase-B lifecycle.
//!
//! `fanout_supervisor.rs` proves what `CohortOwner` permits; this file proves
//! what the rig *says* at each transition — which controller request it will
//! answer, which Mac-signed record it authenticates first, which rig-signed
//! receipt it mints, and which requests it refuses because the transition
//! before them did not happen.
//!
//! Every test drives the session over the exact canonical request payload the
//! frozen §3.3 field table names, so a divergence between this file and the
//! TS controller is a byte divergence rather than a difference of opinion.
#![cfg(any(target_os = "linux", target_os = "macos"))]

#[path = "../src/secure_fs.rs"]
mod secure_fs;

use base64::Engine as _;
use secure_fs::cohort::rig::{
    AbsentServerChild, ChildBaseline, ChildCapture, RigCohortRuntime, RigCohortSession,
    RigCohortStage, RigExecutionBinding, RigIdentity, ServerChildChannel, ServerSpawner,
    SpawnServerRequest, SpawnedServerChild,
};
use secure_fs::cohort::{
    canonical_bytes, merkle_proof, merkle_root, ordered_leaf_nodes, sha256_hex, CohortPhase,
    CohortRefusal, ProcessGroupReaper, RoleChildDescriptorPlan, TokenBundleMetadata,
    TokenCommitmentLeafV1, SECTION_7_CODES, SUBSCRIBER_SHARD_MODULUS,
};
use secure_fs::cross_supervisor::{
    generate_ed25519_keypair, public_key_sha256, sign_bytes, verify_bytes, Ed25519KeyPair,
};
use serde_json::{json, Value};

const COHORT_ID: &str = "cohort-ticker-b35-ws";
const NOW_MS: u64 = 1_760_000_100_000;

fn digest(tag: &str) -> String {
    sha256_hex(tag.as_bytes())
}

fn ns(value: u64) -> Value {
    json!(value.to_string())
}

fn hex32(bytes: &[u8; 32]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn unb64(text: &str) -> Vec<u8> {
    base64::engine::general_purpose::STANDARD
        .decode(text.as_bytes())
        .expect("base64")
}

// --- the cohort the tests run ----------------------------------------------

struct Commitment {
    leaves: Vec<TokenCommitmentLeafV1>,
    root_hex: String,
    nodes: Vec<[u8; 32]>,
}

impl Commitment {
    fn mint(salt: &str) -> Self {
        let mut leaves = vec![TokenCommitmentLeafV1 {
            child_id: "publisher-000000".to_owned(),
            cohort_id: COHORT_ID.to_owned(),
            role: "publisher".to_owned(),
            role_id: "publisher-000000".to_owned(),
            token_sha256: digest(&format!("{salt}/publisher-000000")),
            worker_index: None,
        }];
        for index in 0..SUBSCRIBER_SHARD_MODULUS {
            leaves.push(TokenCommitmentLeafV1 {
                child_id: format!("worker-{index}"),
                cohort_id: COHORT_ID.to_owned(),
                role: "subscriber".to_owned(),
                role_id: format!("subscriber-{index:06}"),
                token_sha256: digest(&format!("{salt}/subscriber-{index:06}")),
                worker_index: Some(index as i64),
            });
        }
        let nodes = ordered_leaf_nodes(&mut leaves).expect("ordered leaves");
        let root_hex = hex32(&merkle_root(&nodes).expect("root"));
        Self {
            leaves,
            root_hex,
            nodes,
        }
    }

    fn proof(&self, index: usize) -> Vec<String> {
        merkle_proof(&self.nodes, index)
            .expect("proof")
            .iter()
            .map(hex32)
            .collect()
    }
}

fn grant_value(key_sha256: &str, commitment: &Commitment) -> Value {
    let mut shards = Vec::new();
    for worker_index in 0..SUBSCRIBER_SHARD_MODULUS {
        shards.push(json!({
            "schema": "subscriber-shard/v1",
            "childId": format!("worker-{worker_index}"),
            "workerIndex": worker_index,
            "modulus": SUBSCRIBER_SHARD_MODULUS,
            "residue": worker_index,
            "firstSubscriberIndex": 0,
            "lastSubscriberIndexExclusive": SUBSCRIBER_SHARD_MODULUS,
            "subscriberCount": 1,
            "orderedSubscriberIdsSha256": digest(&format!("shard-{worker_index}")),
            "firstTokenCommitmentIndex": worker_index + 1,
            // One member per shard: the residue window is `[first, first + 1)`.
            "lastTokenCommitmentIndexExclusive": worker_index + 2,
        }));
    }
    json!({
        "schema": "cohort-grant/v1",
        "execution": { "schema": "cross-supervisor-execution/v1", "executionIndex": 1 },
        "executionSha256": digest("execution"),
        "macExecutionGrantReceiptSha256": digest("mac-execution-grant-receipt"),
        "approvedPlanSha256": digest("approved-plan"),
        "approvalRecordSha256": digest("approval-record"),
        "cohortId": COHORT_ID,
        "cohortAttempt": 1,
        "scenarioHash": digest("scenario"),
        "rolePlanHash": digest("role-plan"),
        "workloadRolePlanInputSha256": digest("workload-role-plan-input"),
        "transport": "ws",
        "publisherCount": 1,
        "subscriberCount": SUBSCRIBER_SHARD_MODULUS,
        "workerCount": SUBSCRIBER_SHARD_MODULUS,
        "expectedProcessCount": SUBSCRIBER_SHARD_MODULUS + 1,
        "expectedSessionCount": SUBSCRIBER_SHARD_MODULUS + 1,
        "publishers": [{
            "schema": "publisher-role-grant/v1",
            "childId": "publisher-000000",
            "publisherId": "publisher-000000",
            "tokenCommitmentIndex": 0,
            "tokenSha256": commitment.leaves[0].token_sha256,
        }],
        "subscriberShards": shards,
        "tokenCommitmentLeafManifestSha256": digest("leaf-manifest"),
        "roleTokenCommitmentRootSha256": commitment.root_hex,
        "roleTokenCommitmentCount": SUBSCRIBER_SHARD_MODULUS + 1,
        "connectionRatePerSecond": 500,
        "maxConnectionsInFlight": 200,
        "readinessDeadlineMs": 30000,
        "inRepetitionWarmupMs": 5000,
        "sampleWindowMs": 1000,
        "measuredDurationMs": 10000,
        "drainDeadlineMs": 10000,
        "messageBytes": 100,
        "expectedOfferedIngress": 100,
        "expectedExpandedDeliveries": 800,
        "macSupervisorInstanceNonce": digest("mac-instance-1"),
        "signingPublicKeySha256": key_sha256,
        "receiptSequence": 0,
        "issuedAtMs": 1_760_000_000_000u64,
        "notAfterMs": 1_760_000_600_000u64,
    })
}

fn warmup_epoch_value(grant_sha256: &str, key_sha256: &str) -> Value {
    json!({
        "schema": "cohort-warmup-epoch/v1",
        "executionSha256": digest("execution"),
        "cohortGrantSha256": grant_sha256,
        "cohortId": COHORT_ID,
        "warmupNonce": digest("warmup-nonce"),
        "durationMs": 5000,
        "warmupMessagesPerPublisher": 10,
        "warmupIntervalMs": 500,
        "expectedWarmupIngress": 10,
        "expectedWarmupDeliveries": 80,
        "macSupervisorInstanceNonce": digest("mac-instance-1"),
        "signingPublicKeySha256": key_sha256,
        "receiptSequence": 1,
        "issuedAtMs": 1_760_000_000_000u64,
        "notAfterMs": 1_760_000_600_000u64,
    })
}

fn manifest_value(grant_sha256: &str, epoch_sha256: &str, key_sha256: &str) -> Value {
    json!({
        "schema": "role-warmup-completion-manifest/v1",
        "executionSha256": digest("execution"),
        "cohortGrantSha256": grant_sha256,
        "cohortWarmupEpochSha256": epoch_sha256,
        "entryCount": 1,
        "entries": [{
            "schema": "role-warmup-completion-manifest-entry/v1",
            "order": 0,
            "childId": "publisher-000000",
            "role": "publisher",
            "roleWarmupCompleteSha256": digest("role-warmup-complete"),
            "roleWarmupComplete": {
                "schema": "retained-canonical-bytes/v1",
                "encoding": "base64",
                "mediaType": "application/json",
                "bytesBase64": b64(b"{}\n"),
                "byteLength": 3,
                "sha256": digest("role-warmup-complete"),
            },
            "offeredWarmupIngress": 10,
            "deliveredWarmupRecords": 0,
        }],
        "allRoleChildrenComplete": true,
        "completedAtMacNs": ns(6_000_000_000),
        "macSupervisorInstanceNonce": digest("mac-instance-1"),
        "signingPublicKeySha256": key_sha256,
        "receiptSequence": 2,
        "issuedAtMs": 1_760_000_000_000u64,
        "notAfterMs": 1_760_000_600_000u64,
    })
}

#[allow(clippy::too_many_arguments)]
fn barrier_value(
    grant_sha256: &str,
    acceptance_sha256: &str,
    measure_start_ack_sha256: &str,
    manifest_sha256: &str,
    manifest_signature_sha256: &str,
    drained_receipt_sha256: &str,
    key_sha256: &str,
) -> Value {
    json!({
        "schema": "cohort-start-barrier/v1",
        "executionSha256": digest("execution"),
        "cohortGrantSha256": grant_sha256,
        "rigCohortAcceptanceSha256": acceptance_sha256,
        "rigMeasureStartAckSha256": measure_start_ack_sha256,
        "roleWarmupCompletionManifestSha256": manifest_sha256,
        "roleWarmupCompletionManifestSignatureSha256": manifest_signature_sha256,
        "rigWarmupDrainedReceiptSha256": drained_receipt_sha256,
        "cohortId": COHORT_ID,
        "barrierNonce": digest("barrier-nonce"),
        "macClockId": "mach-continuous-boot-a",
        "mintedAtMacNs": ns(6_500_000_000),
        "warmupStartedAtMacNs": ns(1_000_000_000),
        "warmupCompletedAtMacNs": ns(6_000_000_000),
        "measureStartAtMacNs": ns(7_000_000_000),
        "measureStopAtMacNs": ns(17_000_000_000),
        "sampleWindowMs": 1000,
        "windowCount": 10,
        "measuredDurationMs": 10000,
        "drainDeadlineMs": 10000,
        "macSupervisorInstanceNonce": digest("mac-instance-1"),
        "signingPublicKeySha256": key_sha256,
        "receiptSequence": 3,
        "issuedAtMs": 1_760_000_000_000u64,
        "notAfterMs": 1_760_000_600_000u64,
    })
}

// --- signing and request framing -------------------------------------------

/// The canonical `mac-receipt-signature/v1` carrier the remote payloads
/// actually transport, over the exact record bytes.
fn mac_signature_record(keys: &Ed25519KeyPair, signed_schema: &str, bytes: &[u8]) -> Vec<u8> {
    let signature = sign_bytes(&keys.private_pkcs8_der, bytes).expect("sign");
    canonical_bytes(&json!({
        "schema": "mac-receipt-signature/v1",
        "algorithm": "Ed25519",
        "signedSchema": signed_schema,
        "signedBytesSha256": sha256_hex(bytes),
        "signingPublicKeySha256": public_key_sha256(&keys.public_raw32),
        "signatureBase64": b64(&signature),
    }))
    .expect("canonical signature record")
}

/// A six-key `rig-accept-cohort-request/v1` over arbitrary grant bytes and an
/// arbitrary grant-signature record, carrying this rig's own honest Phase-A
/// acceptance. §2.13 made the acceptance pair part of the frame, so a
/// four-key accept frame is a missing field, not an unsigned grant — and a
/// test about grant signatures must not fail on the frame shape instead.
fn accept_payload(rig_keys: &Ed25519KeyPair, grant: &[u8], grant_signature: &[u8]) -> Vec<u8> {
    let acceptance = canonical_bytes(&acceptance_value(rig_keys)).expect("canonical acceptance");
    let acceptance_signature =
        rig_signature_record(rig_keys, "rig-execution-acceptance/v1", &acceptance);
    canonical_bytes(&json!({
        "schema": "rig-accept-cohort-request/v1",
        "requestSeq": 1,
        "executionSha256": digest("execution"),
        "cohortGrantBase64": b64(grant),
        "cohortGrantSignatureBase64": b64(grant_signature),
        "rigExecutionAcceptanceBase64": b64(&acceptance),
        "rigExecutionAcceptanceSignatureBase64": b64(&acceptance_signature),
    }))
    .expect("canonical accept payload")
}

fn request_payload(
    schema: &str,
    request_seq: u64,
    record_field: &str,
    record: &[u8],
    signature_field: &str,
    signature_record: &[u8],
) -> Vec<u8> {
    canonical_bytes(&json!({
        "schema": schema,
        "requestSeq": request_seq,
        "executionSha256": digest("execution"),
        record_field: b64(record),
        signature_field: b64(signature_record),
    }))
    .expect("canonical request payload")
}

/// The exact `staged-server-launch-record/v1` the controller ships
/// (`parseStagedServerLaunchRecord`, cohort-protocol.ts: fourteen keys), for
/// one wire and one argv.
fn staged_launch_record(transport: &str, argv: &[&str]) -> Vec<u8> {
    canonical_bytes(&json!({
        "schema": "staged-server-launch-record/v1",
        "stageReceiptSha256": digest("stage-receipt"),
        "serverEntrypointSha256": digest("server.ts"),
        "bunSha256": digest("bun"),
        "addonSha256": digest("addon"),
        "bindAddress": "10.99.0.2",
        "bindPort": 4433,
        "advertisedHost": "10.99.0.2",
        "tlsServerName": "wt-compare.local",
        "tlsCertificateSha256": digest("staged-server-tls.crt"),
        "tlsPrivateKeySha256": digest("staged-server-tls.key"),
        "transport": transport,
        "argv": argv,
        "allowedEnvironment": [],
    }))
    .expect("canonical launch record")
}

const FANOUT_WT_ARGV: &[&str] = &["server.ts", "--transport=wt", "--mode=fanout-cohort"];

/// A spawn request whose `transport`, `serverArgv` and `bindPort` may differ
/// from the launch record it carries — the three bindings the rig reads back
/// off the record.
fn spawn_request_with(
    grant_sha256: &str,
    launch_record: &[u8],
    transport: &str,
    argv: &[&str],
    bind_port: u64,
) -> Vec<u8> {
    canonical_bytes(&json!({
        "schema": "rig-spawn-server-request/v1",
        "requestSeq": 2,
        "executionSha256": digest("execution"),
        "cohortGrantSha256": grant_sha256,
        "serverEntrypointSha256": digest("server.ts"),
        "bunSha256": digest("bun"),
        "addonSha256": digest("addon"),
        "stagedServerLaunchRecordBase64": b64(launch_record),
        "stagedServerLaunchRecordSha256": sha256_hex(launch_record),
        "stagedServerLaunchRecordSize": launch_record.len() as u64,
        "bindAddress": "10.99.0.2",
        "bindPort": bind_port,
        "advertisedHost": "10.99.0.2",
        "tlsServerName": "wt-compare.local",
        "transport": transport,
        "serverArgv": argv,
    }))
    .expect("canonical spawn request")
}

/// The honest spawn: the wt fanout record and a request that restates it.
fn spawn_request_payload(grant_sha256: &str) -> Vec<u8> {
    spawn_request_with(
        grant_sha256,
        &staged_launch_record("wt", FANOUT_WT_ARGV),
        "wt",
        FANOUT_WT_ARGV,
        4433,
    )
}

// --- test doubles -----------------------------------------------------------

/// A spawner that launches nothing and reports what it was asked to launch.
#[derive(Default)]
struct RecordingSpawner {
    requests: Vec<SpawnServerRequest>,
}

impl ServerSpawner for RecordingSpawner {
    fn spawn(&mut self, request: &SpawnServerRequest) -> Result<SpawnedServerChild, CohortRefusal> {
        self.requests.push(request.clone());
        Ok(SpawnedServerChild {
            pid: 4_242,
            pgid: 4_242,
            instance_nonce_sha256: digest("server-instance"),
            ready_frame_sha256: digest("server-ready-frame"),
        })
    }
}

/// A server child that answers each control transition with the record a
/// real one would, so the session's own bindings are what is under test.
struct ScriptedServerChild {
    epoch_sha256: String,
    manifest_sha256: String,
    barrier_sha256: String,
    warmup_ingress: u64,
    warmup_deliveries: u64,
    publisher_warmup_end_count: u64,
    subscriber_warmup_end_count: u64,
    /// The two digests the snapshot and the relay observation have to name.
    /// Set by the harness after the grant is accepted, because the child
    /// learns them from the frames the rig sends it.
    grant_sha256: String,
    root_sha256: String,
    /// Whether the capture ack carries a relay observation at all. §1.3 types
    /// the field `Base64 | null`, so both branches are real.
    carries_relay_observation: bool,
    /// Emit the snapshot frame with its keys in declaration order and a space
    /// after each colon, rather than canonically. §1.3 says the rig digests
    /// what arrived; a rig that re-canonicalised before digesting would bind a
    /// digest nobody can recompute from the bytes on the wire.
    snapshot_frame_is_non_canonical: bool,
    /// How many times the control pipe was abandoned without the teardown
    /// handshake — the refused-arm path.
    abandoned: u64,
}

impl ScriptedServerChild {
    fn new() -> Self {
        Self {
            epoch_sha256: String::new(),
            manifest_sha256: String::new(),
            barrier_sha256: String::new(),
            warmup_ingress: 10,
            warmup_deliveries: 80,
            publisher_warmup_end_count: 1,
            subscriber_warmup_end_count: SUBSCRIBER_SHARD_MODULUS,
            grant_sha256: String::new(),
            root_sha256: String::new(),
            carries_relay_observation: true,
            snapshot_frame_is_non_canonical: false,
            abandoned: 0,
        }
    }

    /// The `server-loop-utilization/v1` the child answers the capture with.
    fn snapshot_frame(&self) -> Vec<u8> {
        let frame = json!({
            "schema": "server-loop-utilization/v1",
            "executionSha256": digest("execution"),
            "cellId": "chat-fanout/subscribers-1000",
            "scenarioHash": digest("scenario"),
            "cohortGrantSha256": self.grant_sha256,
            "cohortStartBarrierSha256": self.barrier_sha256,
            "roleTokenCommitmentRootSha256": self.root_sha256,
            "transport": "ws",
            "repetitionKind": "measured",
            "repetitionIndex": 0,
            "repetitionTotal": 1,
            "childPid": 4_242,
            "childPgid": 4_242,
            "childInstanceNonce": digest("server-instance"),
            "baselineBusyMs": 17,
            "finalBusyMs": 4_017,
            "busyMs": 4_000,
            "baselineAtLinuxNs": ns(6_200_000_000),
            "finalSnapshotAtLinuxNs": ns(16_200_000_000),
            "windowMs": 10_000,
            "linuxClockId": "clock-monotonic-boot-b",
            "allMeasuredSessionsClosed": true,
            "bulkSourceCompletion": Value::Null,
        });
        if self.snapshot_frame_is_non_canonical {
            // Same content, different bytes: unsorted keys and a space after
            // each colon. Still parseable, still a valid frame -- and a
            // different digest.
            let mut text = String::from("{");
            for (index, key) in [
                "schema",
                "executionSha256",
                "cellId",
                "scenarioHash",
                "cohortGrantSha256",
                "cohortStartBarrierSha256",
                "roleTokenCommitmentRootSha256",
                "transport",
                "repetitionKind",
                "repetitionIndex",
                "repetitionTotal",
                "childPid",
                "childPgid",
                "childInstanceNonce",
                "baselineBusyMs",
                "finalBusyMs",
                "busyMs",
                "baselineAtLinuxNs",
                "finalSnapshotAtLinuxNs",
                "windowMs",
                "linuxClockId",
                "allMeasuredSessionsClosed",
                "bulkSourceCompletion",
            ]
            .iter()
            .enumerate()
            {
                if index > 0 {
                    text.push(',');
                }
                text.push_str(&format!(
                    "{}: {}",
                    serde_json::to_string(key).expect("key"),
                    serde_json::to_string(&frame[*key]).expect("value"),
                ));
            }
            text.push_str("}\n");
            return text.into_bytes();
        }
        canonical_bytes(&frame).expect("canonical snapshot frame")
    }

    /// A conserving ten-window `linux-relay-observation/v1`: ten accepted
    /// records per window fan out to eighty completed writes over eight
    /// subscribers.
    fn relay_observation(&self) -> Option<Vec<u8>> {
        if !self.carries_relay_observation {
            return None;
        }
        let windows = 10usize;
        Some(
            canonical_bytes(&json!({
                "schema": "linux-relay-observation/v1",
                "executionSha256": digest("execution"),
                "cohortGrantSha256": self.grant_sha256,
                "cohortStartBarrierSha256": self.barrier_sha256,
                "roleTokenCommitmentRootSha256": self.root_sha256,
                "serverChildPid": 4_242,
                "serverChildPgid": 4_242,
                "serverChildInstanceNonce": digest("server-instance"),
                "linuxClockId": "clock-monotonic-boot-b",
                "windowCount": windows,
                "registeredPublisherIds": ["publisher-000000"],
                "registeredSubscriberIdsSha256": digest("subscriber-ids"),
                "registeredPublisherCount": 1,
                "registeredSubscriberCount": SUBSCRIBER_SHARD_MODULUS,
                "acceptedIngressByOriginWindow": vec![10u64; windows],
                "acceptedIngressBytesByOriginWindow": vec![1_000u64; windows],
                "relayWritesCompletedByOriginWindow": vec![80u64; windows],
                "relayWriteBytesByOriginWindow": vec![8_000u64; windows],
                "duplicateIngressByOriginWindow": vec![0u64; windows],
                "reorderedIngressByOriginWindow": vec![0u64; windows],
                "queueDropDeliveriesByOriginWindow": vec![0u64; windows],
                "writeTimeoutDeliveriesByOriginWindow": vec![0u64; windows],
                "disconnectUndeliveredByOriginWindow": vec![0u64; windows],
                "malformedIngressByOriginWindow": vec![0u64; windows],
                "publisherEndCount": 1,
                "subscriberEndCount": SUBSCRIBER_SHARD_MODULUS,
                "sessionsAccepted": SUBSCRIBER_SHARD_MODULUS + 1,
                "sessionsActivePeak": SUBSCRIBER_SHARD_MODULUS + 1,
                "publisherSessionsActivePeak": 1,
                "subscriberSessionsActivePeak": SUBSCRIBER_SHARD_MODULUS,
                "queueItemsPeak": 80,
                "queueBytesPeak": 8_000,
                "concurrentWritesPeak": 8,
                "measurementStartedAtLinuxNs": ns(1_000),
                "relayDrainedAtLinuxNs": ns(2_000),
                "allSessionsClosedAtLinuxNs": ns(3_000),
                "allSessionsClosed": true,
            }))
            .expect("canonical relay observation"),
        )
    }
}

impl ServerChildChannel for ScriptedServerChild {
    fn warmup_start(
        &mut self,
        epoch_bytes: &[u8],
        _epoch_signature_record: &[u8],
    ) -> Result<Vec<u8>, CohortRefusal> {
        self.epoch_sha256 = sha256_hex(epoch_bytes);
        canonical_bytes(&json!({
            "schema": "server-warmup-ready/v1",
            "sequence": 1,
            "executionSha256": digest("execution"),
            "cohortWarmupEpochSha256": self.epoch_sha256,
            "warmupCountersZero": true,
        }))
    }

    fn drain_warmup(
        &mut self,
        cohort_warmup_epoch_sha256: &str,
        manifest_bytes: &[u8],
    ) -> Result<Vec<u8>, CohortRefusal> {
        assert_eq!(cohort_warmup_epoch_sha256, self.epoch_sha256);
        self.manifest_sha256 = sha256_hex(manifest_bytes);
        canonical_bytes(&json!({
            "schema": "server-warmup-drained/v1",
            "sequence": 2,
            "executionSha256": digest("execution"),
            "cohortWarmupEpochSha256": self.epoch_sha256,
            "roleWarmupCompletionManifestSha256": self.manifest_sha256,
            "warmupIngress": self.warmup_ingress,
            "warmupDeliveries": self.warmup_deliveries,
            "publisherWarmupEndCount": self.publisher_warmup_end_count,
            "subscriberWarmupEndCount": self.subscriber_warmup_end_count,
            "warmupQueuesEmpty": true,
            "measuredCountersZero": true,
            "drainedAtLinuxNs": ns(6_100_000_000),
            "linuxClockId": "clock-monotonic-boot-b",
        }))
    }

    fn measure_start_baseline(
        &mut self,
        warmup_complete_sha256: &str,
    ) -> Result<ChildBaseline, CohortRefusal> {
        assert_eq!(warmup_complete_sha256, self.manifest_sha256);
        Ok(ChildBaseline {
            busy_ms: 17,
            at_linux_ns: 6_200_000_000,
            response_sequence: 3,
        })
    }

    fn present_start_barrier(
        &mut self,
        barrier_bytes: &[u8],
        _barrier_signature_record: &[u8],
    ) -> Result<Vec<u8>, CohortRefusal> {
        self.barrier_sha256 = sha256_hex(barrier_bytes);
        canonical_bytes(&json!({
            "schema": "server-start-barrier-accepted/v1",
            "sequence": 3,
            "executionSha256": digest("execution"),
            "cohortStartBarrierSha256": self.barrier_sha256,
            "acceptedAtLinuxNs": ns(7_000_000_000),
            "linuxClockId": "clock-monotonic-boot-b",
            "measuredTrafficAllowed": true,
        }))
    }

    fn stop_and_capture(
        &mut self,
        cohort_start_barrier_sha256: &str,
        drain_deadline_ms: u64,
    ) -> Result<ChildCapture, CohortRefusal> {
        assert_eq!(cohort_start_barrier_sha256, self.barrier_sha256);
        assert!(drain_deadline_ms > 0);
        let snapshot = self.snapshot_frame();
        let observation = self.relay_observation();
        let capture_ack = canonical_bytes(&json!({
            "schema": "server-capture-ack/v1",
            "sequence": 5,
            "executionSha256": digest("execution"),
            "snapshotFrameBase64": b64(&snapshot),
            "linuxRelayObservationBase64": match observation.as_ref() {
                Some(bytes) => Value::from(b64(bytes)),
                None => Value::Null,
            },
        }))?;
        Ok(ChildCapture {
            capture_ack,
            request_sequence: 5,
            response_sequence: 5,
        })
    }

    fn teardown(&mut self) -> Result<Vec<u8>, CohortRefusal> {
        canonical_bytes(&json!({
            "schema": "server-stopped/v1",
            "sequence": 6,
            "executionSha256": digest("execution"),
            "exitCode": 0,
            "allSessionsClosed": true,
        }))
    }

    fn abandon(&mut self) {
        self.abandoned += 1;
    }
}

#[derive(Default)]
struct RecordingReaper {
    reaped: Vec<i32>,
}

impl ProcessGroupReaper for RecordingReaper {
    fn kill_and_reap(&mut self, pgid: i32) -> Result<(), CohortRefusal> {
        self.reaped.push(pgid);
        Ok(())
    }
}

// --- the harness ------------------------------------------------------------

struct Rig {
    mac: Ed25519KeyPair,
    rig_keys: Ed25519KeyPair,
    commitment: Commitment,
    session: RigCohortSession,
}

impl Rig {
    fn new() -> Self {
        let mac = generate_ed25519_keypair();
        let rig_keys = generate_ed25519_keypair();
        let identity = RigIdentity::new(
            rig_keys.private_pkcs8_der.clone(),
            rig_keys.public_raw32,
            &digest("rig-instance"),
            &digest("linux-clock"),
            1,
            600_000,
        )
        .expect("a shaped rig identity");
        let session = RigCohortSession::new(
            identity,
            mac.public_raw32,
            RigExecutionBinding {
                execution_sha256: digest("execution"),
                measurement_grant_sha256: digest("measurement-grant"),
                mac_execution_grant_receipt_sha256: digest("mac-execution-grant-receipt"),
                rig_execution_acceptance_sha256: digest("rig-execution-acceptance"),
            },
        )
        .expect("a shaped execution binding");
        Self {
            mac,
            rig_keys,
            commitment: Commitment::mint("b35"),
            session,
        }
    }

    fn key_sha256(&self) -> String {
        public_key_sha256(&self.mac.public_raw32)
    }

    /// One signed controller -> rig request, with `base` the frozen field
    /// stem (`cohortWarmupEpoch` -> `cohortWarmupEpochBase64` plus
    /// `cohortWarmupEpochSignatureBase64`).
    fn signed_request(&self, schema: &str, seq: u64, base: &str, value: &Value) -> Vec<u8> {
        let bytes = canonical_bytes(value).expect("canonical record");
        let signed_schema = value["schema"].as_str().expect("schema");
        let signature = mac_signature_record(&self.mac, signed_schema, &bytes);
        request_payload(
            schema,
            seq,
            &format!("{base}Base64"),
            &bytes,
            &format!("{base}SignatureBase64"),
            &signature,
        )
    }

    /// §2.13: the accept frame carries the grant **and** this execution's
    /// Phase-A acceptance, so one campaign-scoped rig process can bind a
    /// second execution without a second startup.
    fn accept_cohort_payload(&self) -> Vec<u8> {
        let value = grant_value(&self.key_sha256(), &self.commitment);
        let bytes = canonical_bytes(&value).expect("canonical grant");
        let signature = mac_signature_record(&self.mac, "cohort-grant/v1", &bytes);
        let acceptance =
            canonical_bytes(&acceptance_value(&self.rig_keys)).expect("canonical acceptance");
        let acceptance_signature =
            rig_signature_record(&self.rig_keys, "rig-execution-acceptance/v1", &acceptance);
        canonical_bytes(&json!({
            "schema": "rig-accept-cohort-request/v1",
            "requestSeq": 1,
            "executionSha256": digest("execution"),
            "cohortGrantBase64": b64(&bytes),
            "cohortGrantSignatureBase64": b64(&signature),
            "rigExecutionAcceptanceBase64": b64(&acceptance),
            "rigExecutionAcceptanceSignatureBase64": b64(&acceptance_signature),
        }))
        .expect("canonical accept payload")
    }

    /// The same accept frame over a caller-supplied grant, so a test can
    /// present a *replacement* attempt rather than this rig's first one.
    fn accept_payload_for(&self, grant: &Value) -> Vec<u8> {
        let bytes = canonical_bytes(grant).expect("canonical grant");
        let signature = mac_signature_record(&self.mac, "cohort-grant/v1", &bytes);
        let acceptance =
            canonical_bytes(&acceptance_value(&self.rig_keys)).expect("canonical acceptance");
        let acceptance_signature =
            rig_signature_record(&self.rig_keys, "rig-execution-acceptance/v1", &acceptance);
        canonical_bytes(&json!({
            "schema": "rig-accept-cohort-request/v1",
            "requestSeq": 1,
            "executionSha256": digest("execution"),
            "cohortGrantBase64": b64(&bytes),
            "cohortGrantSignatureBase64": b64(&signature),
            "rigExecutionAcceptanceBase64": b64(&acceptance),
            "rigExecutionAcceptanceSignatureBase64": b64(&acceptance_signature),
        }))
        .expect("canonical accept payload")
    }

    /// Accept the grant and spawn the server child, and stop there: no role
    /// children, no registrations, and no `mark_ready`. This is the shape the
    /// production rig is actually in — §2.8's whole point is that the Mac
    /// owner's readiness counts are unreachable from here.
    fn accept_and_spawn(&mut self) -> String {
        let ack = self
            .session
            .accept_cohort(&self.accept_cohort_payload(), NOW_MS)
            .expect("a signed grant is accepted");
        let grant_sha256 = json_of(&ack)["cohortGrantSha256"]
            .as_str()
            .expect("grant digest")
            .to_owned();
        let mut spawner = RecordingSpawner::default();
        self.session
            .spawn_server(&spawn_request_payload(&grant_sha256), &mut spawner)
            .expect("the server child spawns");
        grant_sha256
    }

    fn reach_ready(&mut self) -> String {
        let ack = self
            .session
            .accept_cohort(&self.accept_cohort_payload(), NOW_MS)
            .expect("a signed grant is accepted");
        let grant_sha256 = json_of(&ack)["cohortGrantSha256"]
            .as_str()
            .expect("grant digest")
            .to_owned();
        let mut spawner = RecordingSpawner::default();
        self.session
            .spawn_server(&spawn_request_payload(&grant_sha256), &mut spawner)
            .expect("the server child spawns");
        self.session
            .spawn_role_child(
                "publisher-000000",
                "publisher",
                2_100,
                bundle_metadata("publisher-bundle"),
                descriptor_plan(),
            )
            .expect("the publisher child spawns");
        for index in 0..SUBSCRIBER_SHARD_MODULUS {
            self.session
                .spawn_role_child(
                    &format!("worker-{index}"),
                    "subscriber-worker",
                    2_200 + index as i32,
                    bundle_metadata(&format!("worker-{index}-bundle")),
                    descriptor_plan(),
                )
                .expect("a worker child spawns");
        }
        for index in 0..self.commitment.leaves.len() {
            let leaf = self.commitment.leaves[index].clone();
            let proof = self.commitment.proof(index);
            self.session
                .admit_role_registration(
                    &grant_sha256,
                    &leaf,
                    index,
                    &proof,
                    &leaf.role,
                    leaf.worker_index,
                )
                .expect("an honest registration is admitted");
        }
        self.session
            .mark_ready()
            .expect("a complete cohort is ready");
        grant_sha256
    }
}

fn bundle_metadata(tag: &str) -> TokenBundleMetadata {
    TokenBundleMetadata {
        sha256: digest(tag),
        size: 1_024,
        entry_count: 1,
    }
}

fn descriptor_plan() -> RoleChildDescriptorPlan {
    RoleChildDescriptorPlan::new(7, 8).expect("a private control pair")
}

fn json_of(bytes: &[u8]) -> Value {
    serde_json::from_slice(bytes).expect("the ack is a canonical record")
}

/// Verify one rig receipt the way the Mac supervisor does: parse the
/// signature carrier, insist it names the schema it covers, and check it over
/// the exact record bytes under the staged rig key.
fn verify_rig_receipt(
    rig_keys: &Ed25519KeyPair,
    signed_schema: &str,
    record_b64: &str,
    signature_b64: &str,
) {
    let record = unb64(record_b64);
    let carrier = json_of(&unb64(signature_b64));
    assert_eq!(carrier["schema"], "rig-receipt-signature/v1");
    assert_eq!(carrier["algorithm"], "Ed25519");
    assert_eq!(carrier["signedSchema"], signed_schema);
    assert_eq!(carrier["signedBytesSha256"], sha256_hex(&record));
    assert_eq!(
        carrier["signingPublicKeySha256"],
        public_key_sha256(&rig_keys.public_raw32)
    );
    let raw = unb64(carrier["signatureBase64"].as_str().expect("signature"));
    let signature: [u8; 64] = raw.as_slice().try_into().expect("64 bytes");
    verify_bytes(&rig_keys.public_raw32, &record, &signature)
        .expect("the rig's own key verifies its own receipt");
    assert_eq!(json_of(&record)["schema"], signed_schema);
}

// --- COHORT_GRANTED ---------------------------------------------------------

/// The first transition, and the one every later one rests on: the rig
/// authenticates the Mac's grant, takes ownership of the cohort, and hands
/// back its own signed acceptance over the exact grant bytes and the exact
/// signature record it was given.
#[test]
fn cohort_granted_mints_a_rig_signed_acceptance_over_the_exact_grant() {
    let mut rig = Rig::new();
    let payload = rig.accept_cohort_payload();
    let ack = rig
        .session
        .accept_cohort(&payload, NOW_MS)
        .expect("a signed grant is accepted");
    let value = json_of(&ack);
    assert_eq!(value["schema"], "rig-cohort-accepted-ack/v1");
    assert_eq!(value["ackRequestSeq"], 1);
    assert_eq!(value["executionSha256"], digest("execution"));
    assert_eq!(rig.session.stage(), RigCohortStage::CohortAccepted);
    assert_eq!(rig.session.phase(), CohortPhase::GrantAccepted);

    let acceptance_b64 = value["rigCohortAcceptanceBase64"]
        .as_str()
        .expect("acceptance");
    verify_rig_receipt(
        &rig.rig_keys,
        "rig-cohort-acceptance/v1",
        acceptance_b64,
        value["rigCohortAcceptanceSignatureBase64"]
            .as_str()
            .expect("signature"),
    );

    // The acceptance is bound to this grant, this grant's *signature record*,
    // and this cohort's committed token set — not to anything the controller
    // could have restated.
    let acceptance = json_of(&unb64(acceptance_b64));
    let request = json_of(&payload);
    assert_eq!(acceptance["cohortGrantSha256"], value["cohortGrantSha256"]);
    assert_eq!(
        acceptance["cohortGrantSha256"].as_str().expect("digest"),
        sha256_hex(&unb64(
            request["cohortGrantBase64"].as_str().expect("grant")
        ))
    );
    assert_eq!(
        acceptance["cohortGrantSignatureSha256"]
            .as_str()
            .expect("digest"),
        sha256_hex(&unb64(
            request["cohortGrantSignatureBase64"]
                .as_str()
                .expect("signature")
        ))
    );
    assert_eq!(
        acceptance["roleTokenCommitmentRootSha256"],
        rig.commitment.root_hex
    );
    assert_eq!(acceptance["approvedPlanSha256"], digest("approved-plan"));
    assert_eq!(acceptance["acceptedAtMs"], NOW_MS);
    assert_eq!(acceptance["notAfterMs"], NOW_MS + 600_000);
}

/// A grant nobody signed, or one signed and then edited, buys nothing: the
/// cohort stays un-granted, so the next transition is still refused.
#[test]
fn an_unsigned_or_tampered_grant_is_refused_and_grants_nothing() {
    let mut rig = Rig::new();
    let value = grant_value(&rig.key_sha256(), &rig.commitment);
    let bytes = canonical_bytes(&value).expect("canonical grant");

    // Signed by a key that is not the staged Mac key.
    let impostor = generate_ed25519_keypair();
    let forged = mac_signature_record(&impostor, "cohort-grant/v1", &bytes);
    let refusal = rig
        .session
        .accept_cohort(&accept_payload(&rig.rig_keys, &bytes, &forged), NOW_MS)
        .expect_err("a grant the staged Mac key did not sign is refused");
    assert_eq!(refusal.code(), "MAC_GRANT_SIGNATURE_INVALID");

    // Honestly signed, then edited after signing.
    let honest = mac_signature_record(&rig.mac, "cohort-grant/v1", &bytes);
    let mut tampered = value.clone();
    tampered["expectedSessionCount"] = json!(1);
    let tampered_bytes = canonical_bytes(&tampered).expect("canonical grant");
    let refusal = rig
        .session
        .accept_cohort(
            &accept_payload(&rig.rig_keys, &tampered_bytes, &honest),
            NOW_MS,
        )
        .expect_err("a grant edited after signing is refused");
    assert_eq!(refusal.code(), "MAC_GRANT_SIGNATURE_INVALID");

    // A real Mac signature over these exact bytes that claims to cover a
    // different record is a cross-record substitution, not a grant.
    let mislabelled = mac_signature_record(&rig.mac, "cohort-start-barrier/v1", &bytes);
    let refusal = rig
        .session
        .accept_cohort(&accept_payload(&rig.rig_keys, &bytes, &mislabelled), NOW_MS)
        .expect_err("a signature naming another schema is refused");
    assert_eq!(refusal.code(), "CROSS_SUPERVISOR_MISMATCH");

    assert_eq!(rig.session.stage(), RigCohortStage::AwaitingGrant);
    assert_eq!(rig.session.grant_sha256(), None);
}

/// One cohort, once.  A replayed accept is not a second cohort arriving, it
/// is the same one arriving twice, and the answer is the same either way.
#[test]
fn a_replayed_accept_cohort_request_is_refused() {
    let mut rig = Rig::new();
    let payload = rig.accept_cohort_payload();
    rig.session
        .accept_cohort(&payload, NOW_MS)
        .expect("the first acceptance");
    let refusal = rig
        .session
        .accept_cohort(&payload, NOW_MS)
        .expect_err("a replayed accept is refused");
    assert_eq!(refusal.code(), "COHORT_NOT_READY");
    assert_eq!(rig.session.stage(), RigCohortStage::CohortAccepted);
}

/// No grant, no server.  The spawn request is well formed and is refused for
/// what it is missing, not for how it is shaped.
#[test]
fn accept_before_spawn_is_the_only_admissible_order() {
    let mut rig = Rig::new();
    let mut spawner = RecordingSpawner::default();
    let refusal = rig
        .session
        .spawn_server(&spawn_request_payload(&digest("grant")), &mut spawner)
        .expect_err("a server spawned before the grant is refused");
    assert_eq!(refusal.code(), "COHORT_NOT_READY");
    assert!(spawner.requests.is_empty(), "nothing was launched");

    let grant_sha256 = {
        let ack = rig
            .session
            .accept_cohort(&rig.accept_cohort_payload(), NOW_MS)
            .expect("grant");
        json_of(&ack)["cohortGrantSha256"]
            .as_str()
            .expect("digest")
            .to_owned()
    };
    // A spawn naming a cohort this supervisor did not accept is refused even
    // now, because the launch would inherit this grant's authority.
    let refusal = rig
        .session
        .spawn_server(&spawn_request_payload(&digest("other-grant")), &mut spawner)
        .expect_err("a spawn naming another cohort is refused");
    assert_eq!(refusal.code(), "CROSS_SUPERVISOR_MISMATCH");
    assert!(spawner.requests.is_empty());

    let ack = rig
        .session
        .spawn_server(&spawn_request_payload(&grant_sha256), &mut spawner)
        .expect("the staged server child spawns");
    let value = json_of(&ack);
    assert_eq!(value["schema"], "rig-server-ready-ack/v1");
    assert_eq!(value["childPgid"], 4_242);
    assert_eq!(rig.session.stage(), RigCohortStage::ServerSpawned);
    assert_eq!(rig.session.phase(), CohortPhase::ServerSpawned);
    assert_eq!(spawner.requests.len(), 1);
    assert_eq!(
        spawner.requests[0].server_argv,
        vec!["server.ts", "--transport=wt", "--mode=fanout-cohort"]
    );
    assert_eq!(rig.session.unreaped_pgids(), vec![4_242]);
}

// --- IN_REPETITION_WARMUP and DRAINING -------------------------------------

/// Warmup is a transition the server child has to answer, so a supervisor
/// with no live child refuses rather than answering with a record nobody
/// measured.
#[test]
fn a_supervisor_with_no_server_child_refuses_the_warmup_it_cannot_witness() {
    let mut rig = Rig::new();
    let grant_sha256 = rig.reach_ready();
    let epoch = warmup_epoch_value(&grant_sha256, &rig.key_sha256());
    let payload = rig.signed_request(
        "rig-begin-warmup-request/v1",
        3,
        "cohortWarmupEpoch",
        &epoch,
    );
    let refusal = rig
        .session
        .begin_warmup(&payload, &mut AbsentServerChild)
        .expect_err("no child, no warmup");
    assert_eq!(refusal.code(), "COHORT_NOT_READY");
}

/// The drained receipt is bound to the epoch it drained, the manifest that
/// closed it, and the child's own drained frame — and the measure-start ack
/// it mints alongside is what the barrier will have to name.
#[test]
fn draining_mints_a_rig_signed_drained_receipt_and_a_measure_start_baseline() {
    let mut rig = Rig::new();
    let grant_sha256 = rig.reach_ready();
    let mut child = ScriptedServerChild::new();
    let epoch = warmup_epoch_value(&grant_sha256, &rig.key_sha256());
    let epoch_sha256 = sha256_hex(&canonical_bytes(&epoch).expect("epoch"));
    let ready = rig
        .session
        .begin_warmup(
            &rig.signed_request(
                "rig-begin-warmup-request/v1",
                3,
                "cohortWarmupEpoch",
                &epoch,
            ),
            &mut child,
        )
        .expect("the child comes up warm");
    assert_eq!(json_of(&ready)["schema"], "rig-warmup-ready-ack/v1");
    assert_eq!(rig.session.stage(), RigCohortStage::WarmupRunning);

    let manifest = manifest_value(&grant_sha256, &epoch_sha256, &rig.key_sha256());
    let drained = rig
        .session
        .finish_warmup(
            &rig.signed_request(
                "rig-finish-warmup-request/v1",
                4,
                "roleWarmupCompletionManifest",
                &manifest,
            ),
            &mut child,
            NOW_MS,
        )
        .expect("the warmup drains");
    let value = json_of(&drained);
    assert_eq!(value["schema"], "rig-warmup-drained-ack/v1");
    assert_eq!(value["ackRequestSeq"], 4);
    let drained_frame = unb64(value["serverWarmupDrainedBase64"].as_str().expect("frame"));
    assert_eq!(value["serverWarmupDrainedSize"], drained_frame.len() as u64);
    assert_eq!(
        value["serverWarmupDrainedSha256"].as_str().expect("digest"),
        sha256_hex(&drained_frame)
    );
    verify_rig_receipt(
        &rig.rig_keys,
        "rig-warmup-drained-receipt/v1",
        value["rigWarmupDrainedReceiptBase64"]
            .as_str()
            .expect("receipt"),
        value["rigWarmupDrainedReceiptSignatureBase64"]
            .as_str()
            .expect("signature"),
    );
    let receipt = json_of(&unb64(
        value["rigWarmupDrainedReceiptBase64"]
            .as_str()
            .expect("b64"),
    ));
    assert_eq!(receipt["cohortWarmupEpochSha256"], epoch_sha256);
    assert_eq!(
        receipt["serverWarmupDrainedSha256"],
        value["serverWarmupDrainedSha256"]
    );
    assert_eq!(rig.session.stage(), RigCohortStage::WarmupDrained);
    assert!(rig.session.rig_measure_start_ack_sha256().is_some());
}

/// A warmup that offered nothing or delivered nothing proves no fanout, and
/// the rig refuses to carry it forward however well formed the frame is.
#[test]
fn a_vacuous_warmup_drain_is_refused() {
    let mut rig = Rig::new();
    let grant_sha256 = rig.reach_ready();
    let mut child = ScriptedServerChild::new();
    child.warmup_deliveries = 0;
    let epoch = warmup_epoch_value(&grant_sha256, &rig.key_sha256());
    let epoch_sha256 = sha256_hex(&canonical_bytes(&epoch).expect("epoch"));
    rig.session
        .begin_warmup(
            &rig.signed_request(
                "rig-begin-warmup-request/v1",
                3,
                "cohortWarmupEpoch",
                &epoch,
            ),
            &mut child,
        )
        .expect("warm");
    let manifest = manifest_value(&grant_sha256, &epoch_sha256, &rig.key_sha256());
    let refusal = rig
        .session
        .finish_warmup(
            &rig.signed_request(
                "rig-finish-warmup-request/v1",
                4,
                "roleWarmupCompletionManifest",
                &manifest,
            ),
            &mut child,
            NOW_MS,
        )
        .expect_err("a warmup that delivered nothing is refused");
    assert_eq!(refusal.code(), "WARMUP_PROTOCOL");
}

// --- LINUX_BASELINE ---------------------------------------------------------

fn measure_start_request(
    request_seq: u64,
    grant_sha256: &str,
    warmup_complete_sha256: &str,
    drained_receipt_sha256: &str,
) -> Vec<u8> {
    canonical_bytes(&json!({
        "schema": "rig-measure-start-request/v1",
        "requestSeq": request_seq,
        "executionSha256": digest("execution"),
        "cohortGrantSha256": grant_sha256,
        "warmupCompleteSha256": warmup_complete_sha256,
        "rigWarmupDrainedReceiptSha256": drained_receipt_sha256,
    }))
    .expect("request encodes")
}

/// The baseline the drain read is what leaves on the wire — the same bytes,
/// under the rig's own signature, exactly once.
#[test]
fn the_measure_start_ack_is_exported_once_and_is_the_drains_own_baseline() {
    let mut rig = Rig::new();
    let grant_sha256 = rig.reach_ready();
    let mut child = ScriptedServerChild::new();

    // Before the drain there is no baseline to export.
    let early = rig
        .session
        .measure_start(&measure_start_request(
            5,
            &grant_sha256,
            &digest("manifest"),
            &digest("drained-receipt"),
        ))
        .expect_err("a baseline before the drain is refused");
    assert_eq!(early.code(), "COHORT_NOT_READY");

    let (_acceptance, measure_start_ack_sha256, manifest_sha256, _sig, drained_receipt_sha256) =
        drive_to_drained(&mut rig, &grant_sha256, &mut child);

    // A request naming some other drained receipt is not this session's.
    let substituted = rig
        .session
        .measure_start(&measure_start_request(
            5,
            &grant_sha256,
            &manifest_sha256,
            &digest("some-other-drained-receipt"),
        ))
        .expect_err("a baseline request joined to another receipt is refused");
    assert_eq!(substituted.code(), "CROSS_SUPERVISOR_MISMATCH");

    let ack = rig
        .session
        .measure_start(&measure_start_request(
            5,
            &grant_sha256,
            &manifest_sha256,
            &drained_receipt_sha256,
        ))
        .expect("the drain's own baseline");
    let value = json_of(&ack);
    assert_eq!(value["schema"], "rig-measure-started-ack/v1");
    assert_eq!(value["ackRequestSeq"], 5);
    verify_rig_receipt(
        &rig.rig_keys,
        "rig-measure-start-ack/v1",
        value["rigMeasureStartAckBase64"].as_str().expect("ack"),
        value["rigMeasureStartAckSignatureBase64"]
            .as_str()
            .expect("signature"),
    );
    // The exported bytes are the ones the drain retained, not a re-mint: the
    // barrier the Mac builds next has to name this exact digest.
    let exported = unb64(value["rigMeasureStartAckBase64"].as_str().expect("ack"));
    assert_eq!(sha256_hex(&exported), measure_start_ack_sha256);
    // Exporting does not move the lifecycle on; the barrier still follows a
    // drained warmup.
    assert_eq!(rig.session.stage(), RigCohortStage::WarmupDrained);

    let replayed = rig
        .session
        .measure_start(&measure_start_request(
            6,
            &grant_sha256,
            &manifest_sha256,
            &drained_receipt_sha256,
        ))
        .expect_err("the baseline is exported once");
    assert_eq!(replayed.code(), "COHORT_NOT_READY");
}

/// A cohort baseline names its cohort. Phase A's nulls are legal on the wire
/// and are not legal here, because a null would let a controller take this
/// rig's baseline without naming the execution it belongs to.
#[test]
fn a_measure_start_request_carrying_phase_a_nulls_is_refused_in_a_cohort() {
    let mut rig = Rig::new();
    let grant_sha256 = rig.reach_ready();
    let mut child = ScriptedServerChild::new();
    let (_acceptance, _ack, manifest_sha256, _sig, drained_receipt_sha256) =
        drive_to_drained(&mut rig, &grant_sha256, &mut child);
    let _ = (&manifest_sha256, &drained_receipt_sha256);
    let nulled = canonical_bytes(&json!({
        "schema": "rig-measure-start-request/v1",
        "requestSeq": 5,
        "executionSha256": digest("execution"),
        "cohortGrantSha256": Value::Null,
        "warmupCompleteSha256": Value::Null,
        "rigWarmupDrainedReceiptSha256": Value::Null,
    }))
    .expect("request encodes");
    let refusal = rig
        .session
        .measure_start(&nulled)
        .expect_err("a cohort baseline names its cohort");
    assert_eq!(refusal.code(), "CROSS_SUPERVISOR_MISMATCH");
}

/// No measured traffic before the barrier ack, and no barrier before the
/// warmup that precedes it: a barrier arriving early is refused, and a
/// barrier naming a baseline this rig never minted is refused too.
#[test]
fn the_barrier_precedes_measurement_and_must_name_this_rigs_own_baseline() {
    let mut rig = Rig::new();
    let grant_sha256 = rig.reach_ready();
    let mut child = ScriptedServerChild::new();

    // Early: nothing has drained, so there is no baseline to be bound to.
    let premature = barrier_value(
        &grant_sha256,
        &digest("acceptance"),
        &digest("measure-start-ack"),
        &digest("manifest"),
        &digest("manifest-signature"),
        &digest("drained-receipt"),
        &rig.key_sha256(),
    );
    let refusal = rig
        .session
        .present_start_barrier(
            &rig.signed_request(
                "rig-present-start-barrier-request/v1",
                5,
                "cohortStartBarrier",
                &premature,
            ),
            &mut child,
            NOW_MS,
        )
        .expect_err("a barrier before the drain is refused");
    assert_eq!(refusal.code(), "COHORT_NOT_READY");

    let (
        acceptance_sha256,
        measure_start_ack_sha256,
        manifest_sha256,
        manifest_signature_sha256,
        drained_receipt_sha256,
    ) = drive_to_drained(&mut rig, &grant_sha256, &mut child);

    // A barrier that names some other rig's baseline is not this rig's
    // barrier, whatever else it names correctly.
    let substituted = barrier_value(
        &grant_sha256,
        &acceptance_sha256,
        &digest("some-other-rigs-baseline"),
        &manifest_sha256,
        &manifest_signature_sha256,
        &drained_receipt_sha256,
        &rig.key_sha256(),
    );
    let refusal = rig
        .session
        .present_start_barrier(
            &rig.signed_request(
                "rig-present-start-barrier-request/v1",
                5,
                "cohortStartBarrier",
                &substituted,
            ),
            &mut child,
            NOW_MS,
        )
        .expect_err("a barrier naming another baseline is refused");
    assert_eq!(refusal.code(), "CROSS_SUPERVISOR_MISMATCH");
    assert_eq!(rig.session.stage(), RigCohortStage::WarmupDrained);

    let honest = barrier_value(
        &grant_sha256,
        &acceptance_sha256,
        &measure_start_ack_sha256,
        &manifest_sha256,
        &manifest_signature_sha256,
        &drained_receipt_sha256,
        &rig.key_sha256(),
    );
    let ack = rig
        .session
        .present_start_barrier(
            &rig.signed_request(
                "rig-present-start-barrier-request/v1",
                5,
                "cohortStartBarrier",
                &honest,
            ),
            &mut child,
            NOW_MS,
        )
        .expect("the barrier this rig's own baseline was minted for");
    let value = json_of(&ack);
    assert_eq!(value["schema"], "rig-barrier-accepted-ack/v1");
    verify_rig_receipt(
        &rig.rig_keys,
        "rig-barrier-acceptance/v1",
        value["rigBarrierAcceptanceBase64"]
            .as_str()
            .expect("acceptance"),
        value["rigBarrierAcceptanceSignatureBase64"]
            .as_str()
            .expect("signature"),
    );
    let accepted = unb64(
        value["serverStartBarrierAcceptedBase64"]
            .as_str()
            .expect("frame"),
    );
    assert_eq!(
        value["serverStartBarrierAcceptedSize"],
        accepted.len() as u64
    );
    assert_eq!(json_of(&accepted)["measuredTrafficAllowed"], true);
    assert_eq!(rig.session.stage(), RigCohortStage::Measuring);

    // And once: a replayed barrier does not re-open the measured window.
    let refusal = rig
        .session
        .present_start_barrier(
            &rig.signed_request(
                "rig-present-start-barrier-request/v1",
                5,
                "cohortStartBarrier",
                &honest,
            ),
            &mut child,
            NOW_MS,
        )
        .expect_err("a replayed barrier is refused");
    assert_eq!(refusal.code(), "COHORT_NOT_READY");
}

/// Drive one rig from readiness through the drained transition and return the
/// five digests the barrier has to name.
fn drive_to_drained(
    rig: &mut Rig,
    grant_sha256: &str,
    child: &mut ScriptedServerChild,
) -> (String, String, String, String, String) {
    let epoch = warmup_epoch_value(grant_sha256, &rig.key_sha256());
    let epoch_sha256 = sha256_hex(&canonical_bytes(&epoch).expect("epoch"));
    rig.session
        .begin_warmup(
            &rig.signed_request(
                "rig-begin-warmup-request/v1",
                3,
                "cohortWarmupEpoch",
                &epoch,
            ),
            child,
        )
        .expect("warm");
    let manifest = manifest_value(grant_sha256, &epoch_sha256, &rig.key_sha256());
    let manifest_bytes = canonical_bytes(&manifest).expect("manifest");
    let manifest_signature = mac_signature_record(
        &rig.mac,
        "role-warmup-completion-manifest/v1",
        &manifest_bytes,
    );
    let drained = rig
        .session
        .finish_warmup(
            &request_payload(
                "rig-finish-warmup-request/v1",
                4,
                "roleWarmupCompletionManifestBase64",
                &manifest_bytes,
                "roleWarmupCompletionManifestSignatureBase64",
                &manifest_signature,
            ),
            child,
            NOW_MS,
        )
        .expect("drained");
    let value = json_of(&drained);
    (
        // The acceptance digest is not carried back on the drained ack, so it
        // is recomputed from the acceptance the session already published.
        rig.session
            .rig_cohort_acceptance_sha256()
            .expect("an accepted cohort")
            .to_owned(),
        rig.session
            .rig_measure_start_ack_sha256()
            .expect("a minted baseline")
            .to_owned(),
        sha256_hex(&manifest_bytes),
        sha256_hex(&manifest_signature),
        sha256_hex(&unb64(
            value["rigWarmupDrainedReceiptBase64"]
                .as_str()
                .expect("receipt"),
        )),
    )
}

// --- teardown ---------------------------------------------------------------

/// Every group this session took ownership of is signalled on the terminal
/// path, and the session cannot say anything afterwards.
#[test]
fn teardown_reaps_every_process_group_the_session_owns() {
    let mut rig = Rig::new();
    rig.reach_ready();
    let mut reaper = RecordingReaper::default();
    let mut reaped = rig.session.teardown(&mut reaper).expect("teardown");
    reaped.sort_unstable();
    let mut expected = vec![4_242, 2_100];
    for index in 0..SUBSCRIBER_SHARD_MODULUS {
        expected.push(2_200 + index as i32);
    }
    expected.sort_unstable();
    assert_eq!(reaped, expected);
    assert_eq!(rig.session.stage(), RigCohortStage::Terminal);
    assert!(rig.session.unreaped_pgids().is_empty());

    // Idempotent: the second teardown signals nothing new.
    let again = rig.session.teardown(&mut reaper).expect("idempotent");
    assert!(again.is_empty());
    assert_eq!(reaper.reaped.len(), expected.len());
}

// --- the Phase-A acceptance a production cohort is installed from -----------
//
// The runtime install has three inputs and no frame: the rig's own signing
// key on a descriptor, the staged Mac public key under the owned staging
// root, and this execution's `rig-execution-acceptance/v1`. The third is the
// one that decides *which* execution the cohort belongs to, so it is the one
// worth proving cannot be swapped.

fn acceptance_value(rig_keys: &Ed25519KeyPair) -> Value {
    json!({
        "schema": "rig-execution-acceptance/v1",
        "executionSha256": digest("execution"),
        "measurementGrantSha256": digest("measurement-grant"),
        "macExecutionGrantReceiptSha256": digest("mac-receipt"),
        "macReceiptSignatureSha256": digest("mac-receipt-signature"),
        "approvedPlanSha256": digest("approved-plan"),
        "approvalRecordSha256": digest("approval-record"),
        "rigExecutionIndex": 7,
        "rigSupervisorInstanceNonce": digest("rig-instance"),
        "rigSupervisorExecutableSha256": digest("rig-executable"),
        "replayLedgerLeafSha256": digest("replay-leaf"),
        "signingPublicKeySha256": public_key_sha256(&rig_keys.public_raw32),
        "receiptSequence": 1,
        "acceptedAtMs": NOW_MS,
        "issuedAtMs": NOW_MS,
        "notAfterMs": NOW_MS + 600_000,
    })
}

fn rig_signature_record(keys: &Ed25519KeyPair, signed_schema: &str, bytes: &[u8]) -> Vec<u8> {
    let signature = sign_bytes(&keys.private_pkcs8_der, bytes).expect("sign");
    canonical_bytes(&json!({
        "schema": "rig-receipt-signature/v1",
        "algorithm": "Ed25519",
        "signedSchema": signed_schema,
        "signedBytesSha256": sha256_hex(bytes),
        "signingPublicKeySha256": public_key_sha256(&keys.public_raw32),
        "signatureBase64": b64(&signature),
    }))
    .expect("canonical rig signature record")
}

#[test]
fn the_execution_binding_is_read_from_this_rigs_own_signed_acceptance() {
    let rig_keys = generate_ed25519_keypair();
    let acceptance = canonical_bytes(&acceptance_value(&rig_keys)).expect("acceptance");
    let signature = rig_signature_record(&rig_keys, "rig-execution-acceptance/v1", &acceptance);

    let inputs = secure_fs::cohort::rig::read_rig_execution_acceptance(
        &acceptance,
        &signature,
        &rig_keys.public_raw32,
    )
    .expect("this rig's own acceptance verifies under this rig's own key");

    assert_eq!(inputs.binding.execution_sha256, digest("execution"));
    assert_eq!(
        inputs.binding.measurement_grant_sha256,
        digest("measurement-grant")
    );
    assert_eq!(
        inputs.binding.mac_execution_grant_receipt_sha256,
        digest("mac-receipt")
    );
    // Not a field of the record: the binding names the acceptance by the
    // digest of the exact bytes that were verified, so a record cannot claim
    // its own identity.
    assert_eq!(
        inputs.binding.rig_execution_acceptance_sha256,
        sha256_hex(&acceptance)
    );
    assert_eq!(inputs.rig_execution_index, 7);
    assert_eq!(inputs.instance_nonce_sha256, digest("rig-instance"));
    // Derived from the acceptance's own window, not chosen by the launcher.
    assert_eq!(inputs.receipt_validity_ms, 600_000);

    // And the whole thing composes into a live session.
    let identity = RigIdentity::new(
        rig_keys.private_pkcs8_der.clone(),
        rig_keys.public_raw32,
        &inputs.instance_nonce_sha256,
        &digest("linux-clock"),
        inputs.rig_execution_index,
        inputs.receipt_validity_ms,
    )
    .expect("identity");
    let mac_keys = generate_ed25519_keypair();
    RigCohortSession::new(identity, mac_keys.public_raw32, inputs.binding)
        .expect("a session installs from the acceptance alone");
}

#[test]
fn an_acceptance_this_rig_did_not_sign_installs_nothing() {
    let rig_keys = generate_ed25519_keypair();
    let other_keys = generate_ed25519_keypair();
    let acceptance = canonical_bytes(&acceptance_value(&rig_keys)).expect("acceptance");

    // Signed by another rig, and saying so.
    let foreign = rig_signature_record(&other_keys, "rig-execution-acceptance/v1", &acceptance);
    assert_eq!(
        secure_fs::cohort::rig::read_rig_execution_acceptance(
            &acceptance,
            &foreign,
            &rig_keys.public_raw32,
        )
        .expect_err("a foreign signature is not this rig's"),
        CohortRefusal::SigningKeyMismatch
    );

    // Signed by another rig while *claiming* this rig's key digest: the
    // carrier's claim is checked against the held key, and the signature is
    // then verified against the held key rather than the named one.
    let raw = sign_bytes(&other_keys.private_pkcs8_der, &acceptance).expect("sign");
    let liar = canonical_bytes(&json!({
        "schema": "rig-receipt-signature/v1",
        "algorithm": "Ed25519",
        "signedSchema": "rig-execution-acceptance/v1",
        "signedBytesSha256": sha256_hex(&acceptance),
        "signingPublicKeySha256": public_key_sha256(&rig_keys.public_raw32),
        "signatureBase64": b64(&raw),
    }))
    .expect("carrier");
    assert_eq!(
        secure_fs::cohort::rig::read_rig_execution_acceptance(
            &acceptance,
            &liar,
            &rig_keys.public_raw32,
        )
        .expect_err("naming the right key does not make it the signer"),
        CohortRefusal::SignatureInvalid
    );

    // One byte of the record moved after signing.
    let honest = rig_signature_record(&rig_keys, "rig-execution-acceptance/v1", &acceptance);
    let mut tampered = acceptance.clone();
    let index = tampered.len() / 2;
    tampered[index] ^= 0x01;
    assert!(secure_fs::cohort::rig::read_rig_execution_acceptance(
        &tampered,
        &honest,
        &rig_keys.public_raw32,
    )
    .is_err());

    // A signature that verifies over the right bytes while naming another
    // schema is a cross-record substitution.
    let wrong_schema = rig_signature_record(&rig_keys, "rig-cohort-acceptance/v1", &acceptance);
    assert_eq!(
        secure_fs::cohort::rig::read_rig_execution_acceptance(
            &acceptance,
            &wrong_schema,
            &rig_keys.public_raw32,
        )
        .expect_err("signedSchema is part of what is checked"),
        CohortRefusal::BindingMismatch("signedSchema")
    );
}

#[test]
fn an_acceptance_with_no_validity_window_installs_nothing() {
    let rig_keys = generate_ed25519_keypair();
    let mut value = acceptance_value(&rig_keys);
    // `notAfterMs == issuedAtMs` is a receipt that is expired at the instant
    // it is minted; a cohort run under it could never present a valid one.
    value["notAfterMs"] = json!(NOW_MS);
    let acceptance = canonical_bytes(&value).expect("acceptance");
    let signature = rig_signature_record(&rig_keys, "rig-execution-acceptance/v1", &acceptance);
    assert_eq!(
        secure_fs::cohort::rig::read_rig_execution_acceptance(
            &acceptance,
            &signature,
            &rig_keys.public_raw32,
        )
        .expect_err("a zero-length validity window is not a window"),
        CohortRefusal::SchemaInvalid
    );
}

#[test]
fn the_public_half_of_the_signing_key_is_derived_and_not_supplied() {
    let keys = generate_ed25519_keypair();
    let derived = secure_fs::cross_supervisor::public_raw32_from_pkcs8_der(&keys.private_pkcs8_der)
        .expect("derive");
    assert_eq!(derived, keys.public_raw32);
    assert!(secure_fs::cross_supervisor::public_raw32_from_pkcs8_der(b"not a key").is_err());
}

// --- §5 LINUX_CAPTURE and TEARDOWN ------------------------------------------

/// Drive one session all the way to `Measuring`, and return the digests the
/// capture's receipts have to state.
fn drive_to_measuring(rig: &mut Rig, child: &mut ScriptedServerChild) -> String {
    let grant_sha256 = rig.reach_ready();
    child.grant_sha256 = grant_sha256.clone();
    child.root_sha256 = rig.commitment.root_hex.clone();
    let (
        acceptance_sha256,
        measure_start_ack_sha256,
        manifest_sha256,
        manifest_signature_sha256,
        drained_receipt_sha256,
    ) = drive_to_drained(rig, &grant_sha256, child);
    let barrier = barrier_value(
        &grant_sha256,
        &acceptance_sha256,
        &measure_start_ack_sha256,
        &manifest_sha256,
        &manifest_signature_sha256,
        &drained_receipt_sha256,
        &rig.key_sha256(),
    );
    rig.session
        .present_start_barrier(
            &rig.signed_request(
                "rig-present-start-barrier-request/v1",
                5,
                "cohortStartBarrier",
                &barrier,
            ),
            child,
            NOW_MS,
        )
        .expect("the barrier is accepted");
    grant_sha256
}

fn stop_and_capture_payload(barrier_sha256: &str) -> Vec<u8> {
    canonical_bytes(&json!({
        "schema": "rig-stop-and-capture-request/v1",
        "requestSeq": 6,
        "executionSha256": digest("execution"),
        "cohortStartBarrierSha256": barrier_sha256,
        "macStopIssuedAtNs": ns(20_000_000_000),
        "drainDeadlineMs": 10_000,
    }))
    .expect("canonical capture request")
}

/// The two capture receipts digest the child's **exact** bytes.
///
/// §1.3's rule: the rig digests each record as it arrived. The frame carries
/// both as base64, and this test recomputes both digests from the base64 the
/// ack echoes back — so a rig that parsed and re-canonicalised either record
/// before signing over it fails here rather than at a hex re-pin months later.
#[test]
fn the_capture_receipts_bind_the_bytes_the_child_sent() {
    let mut rig = Rig::new();
    let mut child = ScriptedServerChild::new();
    let grant_sha256 = drive_to_measuring(&mut rig, &mut child);
    let barrier_sha256 = child.barrier_sha256.clone();

    let ack = rig
        .session
        .stop_and_capture(
            &stop_and_capture_payload(&barrier_sha256),
            &mut child,
            NOW_MS,
        )
        .expect("the capture completes");
    let value = json_of(&ack);
    assert_eq!(value["schema"], "rig-capture-complete-ack/v1");
    assert_eq!(value["ackRequestSeq"], 6);
    assert_eq!(value["executionSha256"], digest("execution"));

    let snapshot_bytes = unb64(value["snapshotFrameBase64"].as_str().expect("snapshot"));
    assert_eq!(snapshot_bytes, child.snapshot_frame());
    let observation_bytes = unb64(
        value["linuxRelayObservationBase64"]
            .as_str()
            .expect("observation"),
    );
    assert_eq!(Some(observation_bytes.clone()), child.relay_observation());

    let snapshot_receipt = unb64(
        value["rigServerSnapshotReceiptBase64"]
            .as_str()
            .expect("snapshot receipt"),
    );
    let receipt = json_of(&snapshot_receipt);
    assert_eq!(receipt["schema"], "rig-server-snapshot-receipt/v1");
    assert_eq!(receipt["snapshotFrameSha256"], sha256_hex(&snapshot_bytes));
    assert_eq!(receipt["snapshotFrameSize"], snapshot_bytes.len() as u64);
    assert_eq!(receipt["cohortGrantSha256"], grant_sha256);
    assert_eq!(receipt["cohortStartBarrierSha256"], barrier_sha256);
    assert_eq!(
        receipt["roleTokenCommitmentRootSha256"],
        rig.commitment.root_hex
    );
    // The three staged-artifact digests come off the spawn request, not the
    // capture frame: what was measured cannot be restated at capture time.
    assert_eq!(receipt["serverEntrypointSha256"], digest("server.ts"));
    assert_eq!(receipt["bunSha256"], digest("bun"));
    assert_eq!(receipt["addonSha256"], digest("addon"));
    assert_eq!(receipt["childPid"], 4_242);
    assert_eq!(receipt["childInstanceNonce"], digest("server-instance"));
    // Both sequences are the rig's own counters, never numbers the child stated.
    assert_eq!(receipt["captureRequestSequence"], 5);
    assert_eq!(receipt["childResponseSequence"], 5);
    verify_rig_receipt(
        &rig.rig_keys,
        "rig-server-snapshot-receipt/v1",
        value["rigServerSnapshotReceiptBase64"]
            .as_str()
            .expect("b64"),
        value["rigServerSnapshotReceiptSignatureBase64"]
            .as_str()
            .expect("signature b64"),
    );

    let observation_receipt = unb64(
        value["rigRelayObservationReceiptBase64"]
            .as_str()
            .expect("observation receipt"),
    );
    let relay = json_of(&observation_receipt);
    assert_eq!(relay["schema"], "rig-relay-observation-receipt/v1");
    assert_eq!(
        relay["linuxRelayObservationSha256"],
        sha256_hex(&observation_bytes)
    );
    assert_eq!(relay["cohortStartBarrierSha256"], barrier_sha256);
    verify_rig_receipt(
        &rig.rig_keys,
        "rig-relay-observation-receipt/v1",
        value["rigRelayObservationReceiptBase64"]
            .as_str()
            .expect("b64"),
        value["rigRelayObservationReceiptSignatureBase64"]
            .as_str()
            .expect("signature b64"),
    );

    assert_eq!(rig.session.stage(), RigCohortStage::Captured);
}

/// A capture naming a barrier this rig did not accept is refused, and a second
/// capture is a second claim about one measured window.
#[test]
fn a_capture_for_another_barrier_or_a_second_capture_is_refused() {
    let mut rig = Rig::new();
    let mut child = ScriptedServerChild::new();
    drive_to_measuring(&mut rig, &mut child);
    let barrier_sha256 = child.barrier_sha256.clone();

    let refusal = rig
        .session
        .stop_and_capture(
            &stop_and_capture_payload(&digest("some-other-barrier")),
            &mut child,
            NOW_MS,
        )
        .expect_err("a capture for another barrier is refused");
    assert_eq!(refusal.code(), "CROSS_SUPERVISOR_MISMATCH");

    rig.session
        .stop_and_capture(
            &stop_and_capture_payload(&barrier_sha256),
            &mut child,
            NOW_MS,
        )
        .expect("the first capture");
    let refusal = rig
        .session
        .stop_and_capture(
            &stop_and_capture_payload(&barrier_sha256),
            &mut child,
            NOW_MS,
        )
        .expect_err("one measured window, one capture");
    assert_eq!(refusal.code(), "COHORT_NOT_READY");
}

/// The capture ack's relay observation is `Base64 | null`, and the null branch
/// produces no observation receipt rather than a receipt over nothing.
#[test]
fn a_capture_with_no_relay_observation_mints_no_observation_receipt() {
    let mut rig = Rig::new();
    let mut child = ScriptedServerChild::new();
    child.carries_relay_observation = false;
    drive_to_measuring(&mut rig, &mut child);
    let barrier_sha256 = child.barrier_sha256.clone();
    let ack = rig
        .session
        .stop_and_capture(
            &stop_and_capture_payload(&barrier_sha256),
            &mut child,
            NOW_MS,
        )
        .expect("the capture completes without an observation");
    let value = json_of(&ack);
    assert!(value["linuxRelayObservationBase64"].is_null());
    assert!(value["rigRelayObservationReceiptBase64"].is_null());
    assert!(value["rigRelayObservationReceiptSignatureBase64"].is_null());
    // The snapshot half is unaffected: it is not optional.
    assert!(value["rigServerSnapshotReceiptBase64"].is_string());
}

/// TEARDOWN reaps, and `reaped: true` is a verdict about a process group this
/// rig actually waited for.
#[test]
fn teardown_server_reports_a_reaped_verdict_and_ends_the_session() {
    let mut rig = Rig::new();
    let mut child = ScriptedServerChild::new();
    drive_to_measuring(&mut rig, &mut child);
    let barrier_sha256 = child.barrier_sha256.clone();
    rig.session
        .stop_and_capture(
            &stop_and_capture_payload(&barrier_sha256),
            &mut child,
            NOW_MS,
        )
        .expect("the capture completes");

    let payload = canonical_bytes(&json!({
        "schema": "rig-teardown-server-request/v1",
        "requestSeq": 7,
        "executionSha256": digest("execution"),
    }))
    .expect("canonical teardown request");
    let mut reaper = RecordingReaper::default();
    let ack = rig
        .session
        .teardown_server(&payload, &mut child, &mut reaper)
        .expect("the server child is torn down");
    let value = json_of(&ack);
    assert_eq!(value["schema"], "rig-server-stopped-ack/v1");
    assert_eq!(value["ackRequestSeq"], 7);
    assert_eq!(value["exitCode"], 0);
    assert!(value["signal"].is_null());
    assert_eq!(value["reaped"], true);
    assert!(reaper.reaped.contains(&4_242));
    assert!(rig.session.unreaped_pgids().is_empty());
}

/// §2.8: readiness comes from the child's own warmup end counts, not from a
/// count declared at registration.
///
/// The Mac owner's `mark_ready` demands role children and registrations the
/// rig neither spawns nor observes, so it is unreachable here. What the rig
/// does observe is its child reporting that every publisher and every
/// subscriber the grant declared reached the end of the warmup wire.
#[test]
fn readiness_comes_from_the_childs_warmup_end_counts() {
    // The honest path: no `mark_ready` anywhere, and the barrier still opens.
    let mut rig = Rig::new();
    let grant_sha256 = rig.accept_and_spawn();
    assert_eq!(rig.session.phase(), CohortPhase::ServerSpawned);
    let mut child = ScriptedServerChild::new();
    drive_to_drained(&mut rig, &grant_sha256, &mut child);
    assert_eq!(rig.session.phase(), CohortPhase::Ready);

    // A child one subscriber short of the grant's count is not a ready cohort,
    // and a peer that registered and then died cannot reach this number.
    let mut short = Rig::new();
    let grant_sha256 = short.accept_and_spawn();
    let mut child = ScriptedServerChild::new();
    child.subscriber_warmup_end_count = SUBSCRIBER_SHARD_MODULUS - 1;
    let epoch = warmup_epoch_value(&grant_sha256, &short.key_sha256());
    let epoch_sha256 = sha256_hex(&canonical_bytes(&epoch).expect("epoch"));
    short
        .session
        .begin_warmup(
            &short.signed_request(
                "rig-begin-warmup-request/v1",
                3,
                "cohortWarmupEpoch",
                &epoch,
            ),
            &mut child,
        )
        .expect("warm");
    let manifest = manifest_value(&grant_sha256, &epoch_sha256, &short.key_sha256());
    let manifest_bytes = canonical_bytes(&manifest).expect("manifest");
    let manifest_signature = mac_signature_record(
        &short.mac,
        "role-warmup-completion-manifest/v1",
        &manifest_bytes,
    );
    let refusal = short
        .session
        .finish_warmup(
            &request_payload(
                "rig-finish-warmup-request/v1",
                4,
                "roleWarmupCompletionManifestBase64",
                &manifest_bytes,
                "roleWarmupCompletionManifestSignatureBase64",
                &manifest_signature,
            ),
            &mut child,
            NOW_MS,
        )
        .expect_err("a short warmup is not readiness");
    assert_eq!(refusal.code(), "CROSS_SUPERVISOR_MISMATCH");
    assert_eq!(short.session.phase(), CohortPhase::ServerSpawned);
}

/// §2.11: `rig-measure-start-ack/v1` carries exactly the settled key set, and
/// the three changes are each load-bearing because `cohort-start-barrier/v1`
/// binds this record's digest.
#[test]
fn the_measure_start_ack_key_set_is_the_same_on_both_sides() {
    let mut rig = Rig::new();
    let grant_sha256 = rig.reach_ready();
    let mut child = ScriptedServerChild::new();
    let (_, _, manifest_sha256, _, drained_receipt_sha256) =
        drive_to_drained(&mut rig, &grant_sha256, &mut child);
    let exported = rig
        .session
        .measure_start(&measure_start_request(
            6,
            &grant_sha256,
            &manifest_sha256,
            &drained_receipt_sha256,
        ))
        .expect("the baseline is exported");
    let ack_bytes = unb64(
        json_of(&exported)["rigMeasureStartAckBase64"]
            .as_str()
            .expect("ack"),
    );
    let ack = json_of(&ack_bytes);
    let mut keys: Vec<&str> = ack
        .as_object()
        .expect("object")
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        vec![
            "approvalRecordSha256",
            "approvedPlanSha256",
            "baselineAtLinuxNs",
            "baselineBusyMs",
            "childResponseSequence",
            "executionSha256",
            "issuedAtMs",
            "linuxClockId",
            "macExecutionGrantReceiptSha256",
            "measurementGrantSha256",
            "notAfterMs",
            "receiptSequence",
            "rigExecutionAcceptanceSha256",
            "rigSupervisorInstanceNonce",
            "rigWarmupDrainedReceiptSha256",
            "schema",
            "signingPublicKeySha256",
            "warmupCompletionAuthoritySha256",
        ],
    );
    // The plan's two fields are not synonyms: the first is the Mac's signed
    // manifest, the second is this rig's own receipt over the Linux drain.
    assert_eq!(ack["warmupCompletionAuthoritySha256"], manifest_sha256);
    assert_eq!(ack["rigWarmupDrainedReceiptSha256"], drained_receipt_sha256);
    assert_ne!(
        ack["warmupCompletionAuthoritySha256"],
        ack["rigWarmupDrainedReceiptSha256"]
    );
    // The child's FD-4 position at the instant the baseline was read, from the
    // rig's own counter.
    assert_eq!(ack["childResponseSequence"], 3);
    assert_eq!(ack["rigSupervisorInstanceNonce"], digest("rig-instance"));
    assert_eq!(ack["baselineBusyMs"], 17);
    assert_eq!(ack["baselineAtLinuxNs"], "6200000000");
}

// --- cross-language conformance ---------------------------------------------
//
// The bytes below were produced by the **TypeScript** codecs and are consumed
// here verbatim. They are not re-derived: `.scratch/b35r3-notes/S1-vectors.md`
// (child-pipe, S1) and `.../S3-vectors.md` (remote registry, S3) publish them,
// and if this decoder disagrees with them the disagreement is the finding.

fn hex_bytes(hex: &str) -> Vec<u8> {
    (0..hex.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&hex[index..index + 2], 16).expect("hex pair"))
        .collect()
}

/// One §3.4 child-pipe frame: `u32be payloadLength || canonical JSON || 0x0a`,
/// with the newline inside the declared length.
fn child_pipe_body(hex: &str) -> Vec<u8> {
    let frame = hex_bytes(hex);
    let declared = u32::from_be_bytes([frame[0], frame[1], frame[2], frame[3]]) as usize;
    assert_eq!(
        frame.len(),
        4 + declared,
        "the declared length is the whole body, newline included",
    );
    let body = frame[4..].to_vec();
    assert_eq!(
        body.last(),
        Some(&b'\n'),
        "canonical records end in a newline"
    );
    // Canonical means canonical: the body must be the exact encoding of what
    // it decodes to, which is the property the rig's own `admit` enforces
    // before it digests anything.
    let value: Value = serde_json::from_slice(&body).expect("the vector is JSON");
    assert_eq!(
        canonical_bytes(&value).expect("re-encodes"),
        body,
        "the TS encoder and the Rust encoder agree on these bytes",
    );
    body
}

/// S1 vector 5 — `server-warmup-ready/v1`.
const S1_SERVER_WARMUP_READY_HEX: &str = "000000fd7b22636f686f72745761726d757045706f6368536861323536223a2237373737373737373737373737373737373737373737373737373737373737373737373737373737373737373737373737373737373737373737373737373737222c22657865637574696f6e536861323536223a2265316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531222c22736368656d61223a227365727665722d7761726d75702d72656164792f7631222c2273657175656e6365223a312c227761726d7570436f756e746572735a65726f223a747275657d0a";

/// S1 vector 7 — `server-warmup-drained/v1`.
const S1_SERVER_WARMUP_DRAINED_HEX: &str = "000002347b22636f686f72745761726d757045706f6368536861323536223a2237373737373737373737373737373737373737373737373737373737373737373737373737373737373737373737373737373737373737373737373737373737222c22647261696e656441744c696e75784e73223a22313233343536373839303132333435222c22657865637574696f6e536861323536223a2265316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531222c226c696e7578436c6f636b4964223a22434c4f434b5f4d4f4e4f544f4e4943222c226d65617375726564436f756e746572735a65726f223a747275652c227075626c69736865725761726d7570456e64436f756e74223a312c22726f6c655761726d7570436f6d706c6574696f6e4d616e6966657374536861323536223a2238383838383838383838383838383838383838383838383838383838383838383838383838383838383838383838383838383838383838383838383838383838222c22736368656d61223a227365727665722d7761726d75702d647261696e65642f7631222c2273657175656e6365223a322c22737562736372696265725761726d7570456e64436f756e74223a313030302c227761726d757044656c69766572696573223a353030303030302c227761726d7570496e6772657373223a353030302c227761726d7570517565756573456d707479223a747275657d0a";

/// S1 vector 11 — `server-start-barrier-accepted/v1`.
const S1_SERVER_START_BARRIER_ACCEPTED_HEX: &str = "000001537b22616363657074656441744c696e75784e73223a22313233343536373839303132353030222c22636f686f7274537461727442617272696572536861323536223a2262356235623562356235623562356235623562356235623562356235623562356235623562356235623562356235623562356235623562356235623562356235222c22657865637574696f6e536861323536223a2265316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531222c226c696e7578436c6f636b4964223a22434c4f434b5f4d4f4e4f544f4e4943222c226d6561737572656454726166666963416c6c6f776564223a747275652c22736368656d61223a227365727665722d73746172742d626172726965722d61636365707465642f7631222c2273657175656e6365223a347d0a";

/// S1 vector 13 — `server-capture-ack/v1` with the §1.3 base64 key set.
const S1_SERVER_CAPTURE_ACK_HEX: &str = "000001077b22657865637574696f6e536861323536223a2265316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531222c226c696e757852656c61794f62736572766174696f6e426173653634223a2262476c7564586774636d567359586b7462324a7a5a584a32595852706232343d222c22736368656d61223a227365727665722d636170747572652d61636b2f7631222c2273657175656e6365223a352c22736e617073686f744672616d65426173653634223a2263325679646d56794c577876623341746458527062476c3659585270623234745a6e4a686257553d227d0a";

/// S1 vector 15 — `server-stopped/v1`.
const S1_SERVER_STOPPED_HEX: &str = "000000a77b22616c6c53657373696f6e73436c6f736564223a747275652c22657865637574696f6e536861323536223a2265316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531222c2265786974436f6465223a302c22736368656d61223a227365727665722d73746f707065642f7631222c2273657175656e6365223a367d0a";

/// S3 vector 6 — the same `server-capture-ack/v1` key set, published from the
/// §1.3 literal so S1, S5-RIG and S6 pin one shape.
const S3_SERVER_CAPTURE_ACK_HEX: &str = "000000c57b22657865637574696f6e536861323536223a2261616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161222c226c696e757852656c61794f62736572766174696f6e426173653634223a6e756c6c2c22736368656d61223a227365727665722d636170747572652d61636b2f7631222c2273657175656e6365223a352c22736e617073686f744672616d65426173653634223a2243513d3d227d0a";

fn sorted_keys(body: &[u8]) -> Vec<String> {
    let value: Value = serde_json::from_slice(body).expect("json");
    let mut keys: Vec<String> = value.as_object().expect("object").keys().cloned().collect();
    keys.sort();
    keys
}

fn sorted_fields(fields: &[&str]) -> Vec<String> {
    let mut owned: Vec<String> = fields.iter().map(|field| (*field).to_owned()).collect();
    owned.sort();
    owned
}

/// The key sets this rig parses against are the key sets the TS codec emits.
///
/// Each vector is decoded, not reconstructed. A schema whose Rust constant has
/// drifted from the TypeScript key set fails here with the two lists side by
/// side, rather than at a live e2e fifteen minutes in.
#[test]
fn the_pinned_child_frames_are_the_ones_the_ts_codec_produces() {
    use secure_fs::cohort::rig::{
        SERVER_CAPTURE_ACK_FIELDS, SERVER_START_BARRIER_ACCEPTED_FIELDS, SERVER_STOPPED_FIELDS,
        SERVER_WARMUP_DRAINED_FIELDS, SERVER_WARMUP_READY_FIELDS,
    };
    for (hex, schema, fields) in [
        (
            S1_SERVER_WARMUP_READY_HEX,
            "server-warmup-ready/v1",
            SERVER_WARMUP_READY_FIELDS,
        ),
        (
            S1_SERVER_WARMUP_DRAINED_HEX,
            "server-warmup-drained/v1",
            SERVER_WARMUP_DRAINED_FIELDS,
        ),
        (
            S1_SERVER_START_BARRIER_ACCEPTED_HEX,
            "server-start-barrier-accepted/v1",
            SERVER_START_BARRIER_ACCEPTED_FIELDS,
        ),
        (
            S1_SERVER_CAPTURE_ACK_HEX,
            "server-capture-ack/v1",
            SERVER_CAPTURE_ACK_FIELDS,
        ),
        (
            S3_SERVER_CAPTURE_ACK_HEX,
            "server-capture-ack/v1",
            SERVER_CAPTURE_ACK_FIELDS,
        ),
        (
            S1_SERVER_STOPPED_HEX,
            "server-stopped/v1",
            SERVER_STOPPED_FIELDS,
        ),
    ] {
        let body = child_pipe_body(hex);
        let value: Value = serde_json::from_slice(&body).expect("json");
        assert_eq!(value["schema"], schema);
        assert_eq!(sorted_keys(&body), sorted_fields(fields), "{schema}");
    }
}

/// §1.3's edit, checked against the bytes rather than against the prose: the
/// capture ack carries base64, not nested records, so the rig can digest what
/// arrived without re-canonicalising a parse.
#[test]
fn the_capture_ack_vector_carries_base64_and_not_nested_records() {
    for hex in [S1_SERVER_CAPTURE_ACK_HEX, S3_SERVER_CAPTURE_ACK_HEX] {
        let value: Value = serde_json::from_slice(&child_pipe_body(hex)).expect("json");
        assert!(value["snapshotFrameBase64"].is_string());
        assert!(value.get("snapshotFrame").is_none());
        assert!(value.get("linuxRelayObservation").is_none());
        let observation = &value["linuxRelayObservationBase64"];
        assert!(observation.is_string() || observation.is_null());
    }
}

/// The §3.4 key set for `server-measure-start-ack/v1`, exactly, as the TS
/// owner declares it (`child-pipe-protocol.ts`, `SERVER_CHILD_FIELDS`).
///
/// The rig has no parser for this frame yet — the real `ServerChildChannel`
/// is S6's — so this list lives beside the vector rather than in
/// `secure_fs::cohort::rig`. When the parser lands it takes this list, and
/// the vector below is what proves the two agree.
const S1_SERVER_MEASURE_START_ACK_FIELDS: &[&str] = &[
    "schema",
    "sequence",
    "executionSha256",
    "baselineBusyMs",
    "baselineAtLinuxNs",
    "linuxClockId",
];

/// S1 vector 9 — `server-measure-start-ack/v1`, recut for **D1**.
///
/// `baselineBusyMs` is a whole-millisecond count. The first cut of this vector
/// carried `1234.5`, which `cohort::canonical_bytes` refuses at encode time
/// (`secure_fs.rs`, `admit_scalars`) and which §1.3 row 2 would have carried
/// verbatim into a `rig-measure-start-ack/v1` no rig could mint: the one frame
/// where both languages pinned identical bytes, they pinned opposite verdicts.
/// The TS field kind is now `count`, and these are the bytes it produces.
///
/// `child_pipe_body` re-encodes the body with the Rust encoder and asserts the
/// result is the vector, so this literal is a byte-identical pin on both
/// sides rather than a shape both sides happen to like.
const S1_SERVER_MEASURE_START_ACK_HEX: &str = "000000e87b22626173656c696e6541744c696e75784e73223a22313233343536373839303132343030222c22626173656c696e65427573794d73223a313233342c22657865637574696f6e536861323536223a2265316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531222c226c696e7578436c6f636b4964223a22434c4f434b5f4d4f4e4f544f4e4943222c22736368656d61223a227365727665722d6d6561737572652d73746172742d61636b2f7631222c2273657175656e6365223a337d0a";

#[test]
fn the_pinned_measure_start_ack_vector_carries_an_integer_baseline() {
    let body = child_pipe_body(S1_SERVER_MEASURE_START_ACK_HEX);
    let value: Value = serde_json::from_slice(&body).expect("json");
    assert_eq!(value["schema"], "server-measure-start-ack/v1");
    assert_eq!(
        sorted_keys(&body),
        sorted_fields(S1_SERVER_MEASURE_START_ACK_FIELDS),
    );
    assert_eq!(value["baselineBusyMs"], json!(1234));
    assert!(
        value["baselineBusyMs"].is_u64(),
        "a whole-millisecond count, not a real",
    );
    // §1.3 row 2: the rig carries this baseline verbatim into its own receipt,
    // so the integer form has to survive the receipt encoder too.
    let receipt = json!({
        "schema": "rig-measure-start-ack/v1",
        "baselineBusyMs": value["baselineBusyMs"].clone(),
    });
    canonical_bytes(&receipt).expect("an integer baseline reaches a rig receipt");
}

/// The bytes the *first* cut of vector 9 carried, kept as the refusal they
/// are: `1234.5` where the recut vector has `1234`.
///
/// Both languages now refuse this. The TS half is
/// `a_fractional_baseline_busy_ms_is_refused_on_both_sides_of_the_pipe`
/// (`tools/compare/child-pipe-protocol.test.ts`), which refuses it at the
/// builder and at the parser; this half is the encode-time refusal that made
/// the field integer-only in the first place.
const FRACTIONAL_MEASURE_START_ACK_HEX: &str = "000000ea7b22626173656c696e6541744c696e75784e73223a22313233343536373839303132343030222c22626173656c696e65427573794d73223a313233342e352c22657865637574696f6e536861323536223a2265316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531222c226c696e7578436c6f636b4964223a22434c4f434b5f4d4f4e4f544f4e4943222c22736368656d61223a227365727665722d6d6561737572652d73746172742d61636b2f7631222c2273657175656e6365223a337d0a";

#[test]
fn a_fractional_baseline_busy_ms_cannot_reach_a_rig_receipt() {
    let frame = hex_bytes(FRACTIONAL_MEASURE_START_ACK_HEX);
    let body = &frame[4..];
    let value: Value = serde_json::from_slice(body).expect("the vector is JSON");
    assert_eq!(value["baselineBusyMs"], json!(1234.5));
    assert!(
        !value["baselineBusyMs"].is_u64(),
        "a fractional millisecond"
    );
    // The whole cohort codec refuses it, in either direction.
    let refusal = canonical_bytes(&value).expect_err("floats are refused at encode time");
    assert_eq!(refusal.code(), "TRUST_PROTOCOL");
    let receipt = json!({
        "schema": "rig-measure-start-ack/v1",
        "baselineBusyMs": value["baselineBusyMs"].clone(),
    });
    assert!(
        canonical_bytes(&receipt).is_err(),
        "and therefore cannot be carried into a rig receipt",
    );
}

// --- D4: `server-loop-utilization/v1`, both halves ---------------------------

/// The `ServerLoopUtilizationFrameV1` bytes the TypeScript owner produces.
///
/// This codec had 23 keys agreeing across two languages by inspection alone:
/// `isServerLoopUtilizationFrameV1` in
/// `tools/compare/server-snapshot-protocol.ts` and
/// `SERVER_LOOP_UTILIZATION_FIELDS` here, which `parse_snapshot_frame` runs
/// `exact_fields` against before the rig digests the frame the child sent.
/// Nothing enforced the agreement.
///
/// The literal below is published by
/// `the_pinned_loop_utilization_vector_is_the_one_this_codec_produces`
/// (`tools/compare/server-snapshot-protocol.test.ts`) and consumed here. These
/// are the bytes `loopUtilizationSnapshot` puts on the wire: canonical JSON
/// plus one LF, with no length prefix, because §1.3 carries the snapshot as
/// base64 of the child's exact record.
const TS_SERVER_LOOP_UTILIZATION_HEX: &str = "7b22616c6c4d6561737572656453657373696f6e73436c6f736564223a747275652c22626173656c696e6541744c696e75784e73223a22313233343536373839303132343030222c22626173656c696e65427573794d73223a313233342c2262756c6b536f75726365436f6d706c6574696f6e223a6e756c6c2c22627573794d73223a343434342c2263656c6c4964223a2263656c6c2d6233352d77732d30303031222c226368696c64496e7374616e63654e6f6e6365223a2263336333633363336333633363336333633363336333633363336333633363336333633363336333633363336333633363336333633363336333633363336333222c226368696c6450676964223a343234322c226368696c64506964223a343234322c22636f686f72744772616e74536861323536223a2236303630363036303630363036303630363036303630363036303630363036303630363036303630363036303630363036303630363036303630363036303630222c22636f686f7274537461727442617272696572536861323536223a2262356235623562356235623562356235623562356235623562356235623562356235623562356235623562356235623562356235623562356235623562356235222c22657865637574696f6e536861323536223a2265316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531222c2266696e616c427573794d73223a353637382c2266696e616c536e617073686f7441744c696e75784e73223a22313233343536373839303939393939222c226c696e7578436c6f636b4964223a22434c4f434b5f4d4f4e4f544f4e4943222c2272657065746974696f6e496e646578223a322c2272657065746974696f6e4b696e64223a226d65617375726564222c2272657065746974696f6e546f74616c223a352c22726f6c65546f6b656e436f6d6d69746d656e74526f6f74536861323536223a2237373737373737373737373737373737373737373737373737373737373737373737373737373737373737373737373737373737373737373737373737373737222c227363656e6172696f48617368223a2261316131613161316131613161316131613161316131613161316131613161316131613161316131613161316131613161316131613161316131613161316131222c22736368656d61223a227365727665722d6c6f6f702d7574696c697a6174696f6e2f7631222c227472616e73706f7274223a227773222c2277696e646f774d73223a38387d0a";

#[test]
fn the_loop_utilization_key_set_is_the_same_on_both_sides() {
    use secure_fs::cohort::rig::SERVER_LOOP_UTILIZATION_FIELDS;
    let body = hex_bytes(TS_SERVER_LOOP_UTILIZATION_HEX);
    assert_eq!(
        body.last(),
        Some(&b'\n'),
        "canonical records end in a newline"
    );
    let value: Value = serde_json::from_slice(&body).expect("the vector is JSON");
    assert_eq!(value["schema"], "server-loop-utilization/v1");
    // The production constant, against the production key set of the other
    // language. This is the assertion that was missing.
    assert_eq!(
        sorted_keys(&body),
        sorted_fields(SERVER_LOOP_UTILIZATION_FIELDS),
    );
    // Canonical means canonical: the Rust encoder reproduces the exact bytes
    // the TypeScript encoder wrote, which is what makes re-digesting the
    // child's frame and digesting a re-canonicalisation of it the same thing.
    assert_eq!(
        canonical_bytes(&value).expect("the vector re-encodes"),
        body,
    );
    // §1.3: the frame the rig digests is the child's own record, so the
    // snapshot is carried as base64 rather than as a nested record.
    assert!(value["bulkSourceCompletion"].is_null());
    assert_eq!(value["allMeasuredSessionsClosed"], json!(true));
    // The conservation the rig re-derives rather than trusts.
    assert_eq!(
        value["busyMs"].as_u64().expect("busyMs"),
        value["finalBusyMs"].as_u64().expect("finalBusyMs")
            - value["baselineBusyMs"].as_u64().expect("baselineBusyMs"),
    );
}

// --- D2: the §5 TEARDOWN pair, both halves ----------------------------------
//
// `rig-teardown-server-request/v1` and `rig-server-stopped-ack/v1` gained
// their Rust half and their TypeScript half in the same wave and shipped with
// no conformance vector between them. The design's rule is that a codec change
// with no vector is not done, so S3's vectors 1 and 2 are pinned here and both
// are driven at the real dispatch (`secure_fs.rs`, `teardown_server`).

/// One `encodeRegisteredRemotePayload` frame: `u32be headerLength || canonical
/// header || u64be bodyLength || canonical body || sha256(body)`.
///
/// Every field of the envelope is checked, not skipped past: the trailer is
/// recomputed over the body, and both header and body are re-encoded with the
/// Rust canonical encoder and compared to the bytes the TypeScript encoder
/// produced. What comes back is the header record and the exact body bytes.
fn remote_frame_parts(hex: &str) -> (Value, Vec<u8>) {
    let frame = hex_bytes(hex);
    let header_len = u32::from_be_bytes([frame[0], frame[1], frame[2], frame[3]]) as usize;
    let length_at = 4 + header_len;
    let body_at = length_at + 8;
    let header = frame[4..length_at].to_vec();
    let body_len = u64::from_be_bytes(
        frame[length_at..body_at]
            .try_into()
            .expect("an eight-byte body length"),
    ) as usize;
    let body = frame[body_at..body_at + body_len].to_vec();
    assert_eq!(
        frame.len(),
        body_at + body_len + 32,
        "the frame is header, body and a 32-byte trailer",
    );
    assert_eq!(
        sha256_hex(&body),
        frame[body_at + body_len..]
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>(),
        "the trailer is sha256 of the body",
    );
    let header_value: Value = serde_json::from_slice(&header).expect("the header is JSON");
    let body_value: Value = serde_json::from_slice(&body).expect("the body is JSON");
    assert_eq!(
        canonical_bytes(&header_value).expect("the header re-encodes"),
        header,
    );
    assert_eq!(
        canonical_bytes(&body_value).expect("the body re-encodes"),
        body,
        "the TS encoder and the Rust encoder agree on these bytes",
    );
    (header_value, body)
}

/// S3 vector 1 — `rig-teardown-server-request/v1`.
const S3_RIG_TEARDOWN_SERVER_REQUEST_HEX: &str = "000000517b226b696e64223a227269672d74656172646f776e2d7365727665722d72657175657374222c22736368656d61223a22636f6d70617269736f6e2d73757065727669736f722d6672616d652f7631227d0a00000000000000917b22657865637574696f6e536861323536223a2261616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161222c2272657175657374536571223a31332c22736368656d61223a227269672d74656172646f776e2d7365727665722d726571756573742f7631227d0a49a527e365411ed2b49144fa417fb26bbbb0d5c38e0fa13c3ba1ad74507da6eb";

/// S3 vector 2 — `rig-server-stopped-ack/v1`.
const S3_RIG_SERVER_STOPPED_ACK_HEX: &str = "0000004c7b226b696e64223a227269672d7365727665722d73746f707065642d61636b222c22736368656d61223a22636f6d70617269736f6e2d73757065727669736f722d6672616d652f7631227d0a00000000000000c97b2261636b52657175657374536571223a31332c22657865637574696f6e536861323536223a2261616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161222c2265786974436f6465223a302c22726561706564223a747275652c22726573706f6e7365536571223a31332c22736368656d61223a227269672d7365727665722d73746f707065642d61636b2f7631222c227369676e616c223a6e756c6c7d0acfd9d274fb388a8eaf06471cbd0757743c24b2a08e2e0ee2d9b6e9f5c30c497c";

/// Drive one rig to the stage TEARDOWN is answered from.
fn rig_ready_to_tear_down() -> (Rig, ScriptedServerChild) {
    let mut rig = Rig::new();
    let mut child = ScriptedServerChild::new();
    drive_to_measuring(&mut rig, &mut child);
    let barrier_sha256 = child.barrier_sha256.clone();
    rig.session
        .stop_and_capture(
            &stop_and_capture_payload(&barrier_sha256),
            &mut child,
            NOW_MS,
        )
        .expect("the capture completes");
    (rig, child)
}

#[test]
fn the_teardown_request_vector_is_the_one_this_dispatch_parses() {
    let (header, body) = remote_frame_parts(S3_RIG_TEARDOWN_SERVER_REQUEST_HEX);
    // §3.3: the header kind is the payload schema without the version suffix.
    assert_eq!(header["kind"], "rig-teardown-server-request");
    assert_eq!(header["schema"], "comparison-supervisor-frame/v1");
    let value: Value = serde_json::from_slice(&body).expect("json");
    assert_eq!(value["schema"], "rig-teardown-server-request/v1");
    assert_eq!(
        sorted_keys(&body),
        sorted_fields(&["schema", "requestSeq", "executionSha256"]),
    );

    // The vector, byte for byte, at the real dispatch. It names execution
    // `a`*64 and this session is bound to another execution, so the last gate
    // it can reach is the binding check — which is exactly what proves every
    // gate before it accepted the TypeScript bytes. A key added or renamed on
    // either side stops it earlier, on a different code.
    let (mut rig, mut child) = rig_ready_to_tear_down();
    let mut reaper = RecordingReaper::default();
    let refusal = rig
        .session
        .teardown_server(&body, &mut child, &mut reaper)
        .expect_err("the vector names another execution");
    assert_eq!(refusal.code(), "CROSS_SUPERVISOR_MISMATCH");
    assert!(
        reaper.reaped.is_empty(),
        "a refused transition reaps nothing",
    );
}

#[test]
fn the_server_stopped_ack_vector_is_the_one_this_mint_produces() {
    let (header, body) = remote_frame_parts(S3_RIG_SERVER_STOPPED_ACK_HEX);
    assert_eq!(header["kind"], "rig-server-stopped-ack");
    let vector: Value = serde_json::from_slice(&body).expect("json");

    let (mut rig, mut child) = rig_ready_to_tear_down();
    let payload = canonical_bytes(&json!({
        "schema": "rig-teardown-server-request/v1",
        "requestSeq": 13,
        "executionSha256": digest("execution"),
    }))
    .expect("canonical teardown request");
    let mut reaper = RecordingReaper::default();
    let minted = rig
        .session
        .teardown_server(&payload, &mut child, &mut reaper)
        .expect("the server child is torn down");

    // Same key set, exactly: the mint cannot gain or lose a field without
    // moving this vector.
    assert_eq!(sorted_keys(&minted), sorted_keys(&body));
    // Everything the mint *decides* — the schema, the null signal, the
    // `reaped` verdict, the child's exit code — has to be what the TypeScript
    // encoder wrote. The three that are this session's own state are the three
    // substituted here, and nothing else may differ.
    let mut live: Value = serde_json::from_slice(&minted).expect("json");
    for field in ["responseSeq", "ackRequestSeq", "executionSha256"] {
        live[field] = vector[field].clone();
    }
    assert_eq!(canonical_bytes(&live).expect("canonical"), body);
}

/// §2.11's single hex conformance vector, pinned here and asserted from the
/// TypeScript owner (`tools/compare/server-observation-artifact.test.ts`).
///
/// The Rust half is the mint in `finish_warmup`; the TS half is
/// `RigMeasureStartAckV1` in `server-observation-artifact.ts`. One codec, one
/// owner, one set of bytes: a key added or renamed on either side moves this
/// literal, and a slice that moves it alone breaks the other language's test.
const RUST_PINNED_MEASURE_START_ACK_HEX: &str = "7b22617070726f76616c5265636f7264536861323536223a2264346434643464346434643464346434643464346434643464346434643464346434643464346434643464346434643464346434643464346434643464346434222c22617070726f766564506c616e536861323536223a2264336433643364336433643364336433643364336433643364336433643364336433643364336433643364336433643364336433643364336433643364336433222c22626173656c696e6541744c696e75784e73223a2236323030303030303030222c22626173656c696e65427573794d73223a31372c226368696c64526573706f6e736553657175656e6365223a332c22657865637574696f6e536861323536223a2265316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531222c2269737375656441744d73223a313736303030303130303030302c226c696e7578436c6f636b4964223a2263636363636363636363636363636363636363636363636363636363636363636363636363636363636363636363636363636363636363636363636363636363222c226d6163457865637574696f6e4772616e7452656365697074536861323536223a2264326432643264326432643264326432643264326432643264326432643264326432643264326432643264326432643264326432643264326432643264326432222c226d6561737572656d656e744772616e74536861323536223a2264316431643164316431643164316431643164316431643164316431643164316431643164316431643164316431643164316431643164316431643164316431222c226e6f7441667465724d73223a313736303030303730303030302c227265636569707453657175656e6365223a322c22726967457865637574696f6e416363657074616e6365536861323536223a2261326132613261326132613261326132613261326132613261326132613261326132613261326132613261326132613261326132613261326132613261326132222c2272696753757065727669736f72496e7374616e63654e6f6e6365223a2263336333633363336333633363336333633363336333633363336333633363336333633363336333633363336333633363336333633363336333633363336333222c227269675761726d7570447261696e656452656365697074536861323536223a2264356435643564356435643564356435643564356435643564356435643564356435643564356435643564356435643564356435643564356435643564356435222c22736368656d61223a227269672d6d6561737572652d73746172742d61636b2f7631222c227369676e696e675075626c69634b6579536861323536223a2264366436643664366436643664366436643664366436643664366436643664366436643664366436643664366436643664366436643664366436643664366436222c227761726d7570436f6d706c6574696f6e417574686f72697479536861323536223a2238383838383838383838383838383838383838383838383838383838383838383838383838383838383838383838383838383838383838383838383838383838227d0a";

fn repeat_digest(byte: &str) -> String {
    byte.repeat(32)
}

#[test]
fn the_pinned_measure_start_ack_is_the_one_the_ts_codec_produces() {
    let record = json!({
        "schema": "rig-measure-start-ack/v1",
        "executionSha256": repeat_digest("e1"),
        "measurementGrantSha256": repeat_digest("d1"),
        "macExecutionGrantReceiptSha256": repeat_digest("d2"),
        "rigExecutionAcceptanceSha256": repeat_digest("a2"),
        "approvedPlanSha256": repeat_digest("d3"),
        "approvalRecordSha256": repeat_digest("d4"),
        "childResponseSequence": 3,
        "baselineBusyMs": 17,
        "baselineAtLinuxNs": "6200000000",
        "linuxClockId": repeat_digest("cc"),
        "warmupCompletionAuthoritySha256": repeat_digest("88"),
        "rigWarmupDrainedReceiptSha256": repeat_digest("d5"),
        "signingPublicKeySha256": repeat_digest("d6"),
        "rigSupervisorInstanceNonce": repeat_digest("c3"),
        "receiptSequence": 2,
        "issuedAtMs": 1_760_000_100_000u64,
        "notAfterMs": 1_760_000_700_000u64,
    });
    let bytes = canonical_bytes(&record).expect("canonical");
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    assert_eq!(hex, RUST_PINNED_MEASURE_START_ACK_HEX);

    // The vector's key set is the key set the live mint uses, so the two
    // cannot drift: a field added to `finish_warmup` and not to the vector is
    // a failure here.
    let mut rig = Rig::new();
    let grant_sha256 = rig.reach_ready();
    let mut child = ScriptedServerChild::new();
    let (_, _, manifest_sha256, _, drained_receipt_sha256) =
        drive_to_drained(&mut rig, &grant_sha256, &mut child);
    let exported = rig
        .session
        .measure_start(&measure_start_request(
            6,
            &grant_sha256,
            &manifest_sha256,
            &drained_receipt_sha256,
        ))
        .expect("the baseline is exported");
    let minted = json_of(&unb64(
        json_of(&exported)["rigMeasureStartAckBase64"]
            .as_str()
            .expect("ack"),
    ));
    assert_eq!(sorted_keys(&bytes), {
        let mut keys: Vec<String> = minted
            .as_object()
            .expect("object")
            .keys()
            .cloned()
            .collect();
        keys.sort();
        keys
    },);
}

/// §1.3, stated as a property of the bytes: the receipt binds the frame **as
/// it arrived**, not a re-canonicalisation of what the rig parsed.
///
/// The child here emits a frame with the same content and different bytes.
/// A rig that re-encoded before digesting would bind a digest nobody can
/// recompute from the wire, and the two hex vectors would still agree — which
/// is exactly why this is a separate test from the vector pins.
#[test]
fn the_snapshot_receipt_digests_the_frame_as_it_arrived() {
    let mut rig = Rig::new();
    let mut child = ScriptedServerChild::new();
    child.snapshot_frame_is_non_canonical = true;
    drive_to_measuring(&mut rig, &mut child);
    let barrier_sha256 = child.barrier_sha256.clone();

    let arrived = child.snapshot_frame();
    let reencoded =
        canonical_bytes(&serde_json::from_slice::<Value>(&arrived).expect("the frame parses"))
            .expect("and re-encodes");
    assert_ne!(arrived, reencoded, "the two encodings differ");

    let ack = rig
        .session
        .stop_and_capture(
            &stop_and_capture_payload(&barrier_sha256),
            &mut child,
            NOW_MS,
        )
        .expect("the capture completes");
    let value = json_of(&ack);
    let carried = unb64(value["snapshotFrameBase64"].as_str().expect("snapshot"));
    assert_eq!(carried, arrived, "the ack forwards the child's own bytes");
    let receipt = json_of(&unb64(
        value["rigServerSnapshotReceiptBase64"]
            .as_str()
            .expect("receipt"),
    ));
    assert_eq!(receipt["snapshotFrameSha256"], sha256_hex(&arrived));
    assert_ne!(receipt["snapshotFrameSha256"], sha256_hex(&reencoded));
    assert_eq!(receipt["snapshotFrameSize"], arrived.len() as u64);
}

// --- §7's closed code table -------------------------------------------------

/// Every code the rig can publish is a member of §7's closed table.
///
/// The wave-3 gate found `CohortRefusal::code()` answering with six
/// `TRUST_RECORD_*` codes that are not members. `parseRemoteSupervisorRefusal`
/// (`cross-supervisor-protocol.ts`) refuses anything outside the table, so the
/// controller could not carry them and the arm was filed under a code the rig
/// never said. This enumerates the enum rather than sampling it, so a variant
/// added later without a §7 code goes red here and not in a campaign.
#[test]
fn a_rig_refusal_names_a_section_7_code() {
    let every = [
        CohortRefusal::Malformed,
        CohortRefusal::DuplicateField("x".into()),
        CohortRefusal::UnknownField("x".into()),
        CohortRefusal::MissingField("x"),
        CohortRefusal::SchemaInvalid,
        CohortRefusal::BindingMismatch("x"),
        CohortRefusal::Oversize,
        CohortRefusal::SignatureInvalid,
        CohortRefusal::SigningKeyMismatch,
        CohortRefusal::NotReady("x"),
        CohortRefusal::WarmupProtocol("x"),
        CohortRefusal::TokenReplay,
        CohortRefusal::TokenProofInvalid,
        CohortRefusal::WrongRole,
        CohortRefusal::WrongShard,
        CohortRefusal::TokenBundleFdInvalid,
        CohortRefusal::TokenBundleDigestMismatch,
        CohortRefusal::Duplicate("x".into()),
        CohortRefusal::Overflow,
        CohortRefusal::WindowConflation,
        CohortRefusal::RelayDelivery("x"),
        CohortRefusal::ChildLifecycle("x"),
        CohortRefusal::Io("x".into()),
    ];
    for refusal in &every {
        assert!(
            SECTION_7_CODES.contains(&refusal.code()),
            "{:?} publishes {} which is outside §7",
            refusal,
            refusal.code(),
        );
    }
    assert_eq!(SECTION_7_CODES.len(), 21);
    // The shape refusals are the six the gate mapped; pinned by value so a
    // later edit cannot quietly reintroduce the `TRUST_RECORD_*` vocabulary.
    assert_eq!(CohortRefusal::Malformed.code(), "TRUST_PROTOCOL");
    assert_eq!(CohortRefusal::SchemaInvalid.code(), "TRUST_PROTOCOL");
    assert_eq!(CohortRefusal::MissingField("x").code(), "TRUST_PROTOCOL");
    assert_eq!(
        CohortRefusal::BindingMismatch("x").code(),
        "CROSS_SUPERVISOR_MISMATCH"
    );
}

// --- G3c: the spawn request is bound to the launch record it carries -----------

/// Binding by digest alone let a request exec an argv the record never
/// froze.  The rig now reads `transport`, `argv` and `bindPort` back off the
/// exact record and refuses a request that restates any of them differently
/// — `CROSS_SUPERVISOR_MISMATCH`, before any spawner is consulted.  The
/// ordinary A5 case is the first: `--mode=bulk-source` under a
/// `--mode=fanout-cohort` record.
#[test]
fn a_spawn_that_restates_the_launch_records_argv_transport_or_port_is_refused() {
    let mut rig = Rig::new();
    let mut spawner = RecordingSpawner::default();
    let grant_sha256 = {
        let ack = rig
            .session
            .accept_cohort(&rig.accept_cohort_payload(), NOW_MS)
            .expect("grant");
        json_of(&ack)["cohortGrantSha256"]
            .as_str()
            .expect("digest")
            .to_owned()
    };
    let record = staged_launch_record("wt", FANOUT_WT_ARGV);
    let cases: &[(&str, Vec<u8>)] = &[
        (
            "serverArgv",
            spawn_request_with(
                &grant_sha256,
                &record,
                "wt",
                &["server.ts", "--transport=wt", "--mode=bulk-source"],
                4433,
            ),
        ),
        (
            "serverArgv",
            spawn_request_with(
                &grant_sha256,
                &record,
                "wt",
                &["server.ts", "--transport=wt"],
                4433,
            ),
        ),
        (
            "transport",
            spawn_request_with(&grant_sha256, &record, "ws", FANOUT_WT_ARGV, 4433),
        ),
        (
            "bindPort",
            spawn_request_with(&grant_sha256, &record, "wt", FANOUT_WT_ARGV, 4434),
        ),
    ];
    for (field, payload) in cases {
        let refusal = rig
            .session
            .spawn_server(payload, &mut spawner)
            .expect_err(field);
        assert_eq!(refusal, CohortRefusal::BindingMismatch(field), "{field}");
        assert_eq!(refusal.code(), "CROSS_SUPERVISOR_MISMATCH");
        assert!(spawner.requests.is_empty(), "{field}: nothing was launched");
        assert_eq!(rig.session.stage(), RigCohortStage::CohortAccepted);
    }
    // A record that is not the closed fourteen-key set is not a launch
    // record, whatever digest the request names for it.
    let bare = b"{\"schema\":\"staged-server-launch-record/v1\"}\n";
    let refusal = rig
        .session
        .spawn_server(
            &spawn_request_with(&grant_sha256, bare, "wt", FANOUT_WT_ARGV, 4433),
            &mut spawner,
        )
        .expect_err("a bare record");
    assert_eq!(refusal.code(), "TRUST_PROTOCOL");
    assert!(spawner.requests.is_empty());
    // The three staged digests the request restates are the record's too: a
    // request that names another entrypoint, Bun or addon than the stage
    // receipt bound is choosing what the rig is about to exec.
    for field in ["serverEntrypointSha256", "bunSha256", "addonSha256"] {
        let mut payload: Value =
            serde_json::from_slice(&spawn_request_payload(&grant_sha256)).expect("json");
        payload[field] = json!(digest("another-staged-artifact"));
        let refusal = rig
            .session
            .spawn_server(&canonical_bytes(&payload).expect("canonical"), &mut spawner)
            .expect_err(field);
        assert_eq!(refusal, CohortRefusal::BindingMismatch(field), "{field}");
        assert_eq!(refusal.code(), "CROSS_SUPERVISOR_MISMATCH");
        assert!(spawner.requests.is_empty(), "{field}: nothing was launched");
    }
    // The honest restatement spawns, and what the spawner is handed is the
    // record's argv and port.
    rig.session
        .spawn_server(&spawn_request_payload(&grant_sha256), &mut spawner)
        .expect("the honest spawn");
    let launched = spawner.requests.pop().expect("one launch");
    assert_eq!(launched.server_argv, FANOUT_WT_ARGV);
    assert_eq!(launched.transport, "wt");
    assert_eq!(launched.bind_port, 4433);
}

// --- a refused arm ends the execution, not the campaign-scoped process -------
//
// Plan 529: one remote channel carries one open execution, and a
// `remote-supervisor-refusal/v1` is `terminal: true` for it (plan 536-545) —
// an index row for that arm (plan 2305-2313).  Design §2.13: one rig process
// serves §3.2's four executions.  Plan 2191: "Next execution gets fresh
// nonces/tokens/grants."  So the runtime must be able to end every execution
// it holds — reap, release, refuse to rebuild — and go on accepting.

/// A reaper whose every group survives the ladder.
struct SurvivingReaper;

impl ProcessGroupReaper for SurvivingReaper {
    fn kill_and_reap(&mut self, _pgid: i32) -> Result<(), CohortRefusal> {
        Err(CohortRefusal::ChildLifecycle(
            "process group survived SIGKILL and the reap deadline",
        ))
    }
}

/// The accept frame as the campaign-scoped runtime reads it: the acceptance
/// on the frame is what binds the execution (design §2.13), so it names the
/// same Mac receipt digest the harness's grant does.
fn runtime_accept_payload(rig: &Rig) -> Vec<u8> {
    let grant =
        canonical_bytes(&grant_value(&rig.key_sha256(), &rig.commitment)).expect("canonical grant");
    let grant_signature = mac_signature_record(&rig.mac, "cohort-grant/v1", &grant);
    let mut acceptance = acceptance_value(&rig.rig_keys);
    acceptance["macExecutionGrantReceiptSha256"] = json!(digest("mac-execution-grant-receipt"));
    let acceptance = canonical_bytes(&acceptance).expect("canonical acceptance");
    let acceptance_signature =
        rig_signature_record(&rig.rig_keys, "rig-execution-acceptance/v1", &acceptance);
    canonical_bytes(&json!({
        "schema": "rig-accept-cohort-request/v1",
        "requestSeq": 1,
        "executionSha256": digest("execution"),
        "cohortGrantBase64": b64(&grant),
        "cohortGrantSignatureBase64": b64(&grant_signature),
        "rigExecutionAcceptanceBase64": b64(&acceptance),
        "rigExecutionAcceptanceSignatureBase64": b64(&acceptance_signature),
    }))
    .expect("canonical accept payload")
}

/// The runtime the rig binary installs, keyed like the `Rig` harness so the
/// harness's signed acceptance and grant verify under it.
fn runtime_for(rig: &Rig) -> RigCohortRuntime {
    RigCohortRuntime::new(
        rig.rig_keys.private_pkcs8_der.clone(),
        rig.rig_keys.public_raw32,
        rig.mac.public_raw32,
        &digest("linux-clock"),
        &digest("rig-instance"),
        &digest("rig-executable"),
    )
    .expect("a shaped campaign runtime")
}

#[test]
fn a_refused_arm_reaps_and_releases_its_execution_and_the_campaign_keeps_accepting() {
    let rig = Rig::new();
    let mut runtime = runtime_for(&rig);
    let ack = runtime
        .accept_cohort(&runtime_accept_payload(&rig), NOW_MS)
        .expect("a signed grant is accepted");
    let grant_sha256 = json_of(&ack)["cohortGrantSha256"]
        .as_str()
        .expect("grant digest")
        .to_owned();
    let mut spawner = RecordingSpawner::default();
    runtime
        .session_mut(&digest("execution"))
        .expect("the session that owns the execution")
        .spawn_server(&spawn_request_payload(&grant_sha256), &mut spawner)
        .expect("the server child spawns");
    assert_eq!(runtime.session_count(), 1);

    // The arm ends: the server child's group is reaped, the session is gone.
    let mut reaper = RecordingReaper::default();
    runtime.close_all(&mut reaper).expect("a bounded reap");
    assert_eq!(reaper.reaped, vec![4_242]);
    assert_eq!(runtime.session_count(), 0);
    assert_eq!(
        runtime
            .session_mut(&digest("execution"))
            .err()
            .expect("nothing routes to a closed execution")
            .code(),
        "COHORT_NOT_READY"
    );

    // The closed execution cannot be rebuilt from the acceptance it once
    // carried: a second accept for it is a duplicate, not a fresh arm.
    let refusal = runtime
        .accept_cohort(&runtime_accept_payload(&rig), NOW_MS)
        .expect_err("a closed execution is terminal for the campaign");
    assert_eq!(refusal, CohortRefusal::Duplicate(digest("execution")));
    assert_eq!(runtime.session_count(), 0);

    // Idempotent: closing again signals nothing.
    runtime.close_all(&mut reaper).expect("idempotent");
    assert_eq!(reaper.reaped, vec![4_242]);
    // The campaign still accepts: the refusal above is `Duplicate`, not
    // `NotReady` or `Overflow`.  The binary's resident-loop test drives a
    // second execution through the same loop after a refused first one.
}

#[test]
fn a_refused_arm_whose_children_survive_the_reap_ladder_reports_it_and_still_releases() {
    let rig = Rig::new();
    let mut runtime = runtime_for(&rig);
    let ack = runtime
        .accept_cohort(&runtime_accept_payload(&rig), NOW_MS)
        .expect("a signed grant is accepted");
    let grant_sha256 = json_of(&ack)["cohortGrantSha256"]
        .as_str()
        .expect("grant digest")
        .to_owned();
    let mut spawner = RecordingSpawner::default();
    runtime
        .session_mut(&digest("execution"))
        .expect("session")
        .spawn_server(&spawn_request_payload(&grant_sha256), &mut spawner)
        .expect("the server child spawns");

    let refusal = runtime
        .close_all(&mut SurvivingReaper)
        .expect_err("a child this supervisor cannot bound is reported, not swallowed");
    assert_eq!(refusal.code(), "CHILD_LIFECYCLE");
    // The execution is still closed: nothing routes to it and nothing
    // rebuilds it, whatever the caller now does with the process.
    assert_eq!(runtime.session_count(), 0);
    assert_eq!(
        runtime
            .accept_cohort(&runtime_accept_payload(&rig), NOW_MS)
            .expect_err("closed"),
        CohortRefusal::Duplicate(digest("execution"))
    );
}

#[test]
fn abandoning_the_control_pipe_needs_no_teardown_handshake() {
    let mut child = ScriptedServerChild::new();
    child.abandon();
    child.abandon();
    assert_eq!(
        child.abandoned, 2,
        "idempotent, and never answered by the child"
    );
    let mut absent = AbsentServerChild;
    absent.abandon();
}

// ---------------------------------------------------------------------------
// Plan 2210's pre-readiness replacement, on the rig half.
//
// The reliability gate proved by execution that the production sequence was
// blocked here: `teardown_server` refused from `ServerSpawned` ("the server
// child is torn down after it was measured") and `accept_cohort` refused a
// second acceptance ("a cohort is accepted once"), so the controller's
// replacement loop -- teardownServer, then admitCohortGrantAtRig -- always
// ended the arm at the rig
// (`.scratch/2026-09-05-cohort-completion/notes/reliability-gate.md` §3b).
// ---------------------------------------------------------------------------

/// One `cohort-grant/v1` value for a named attempt over a named commitment.
fn attempt_grant_value(key_sha256: &str, commitment: &Commitment, attempt: u64) -> Value {
    let mut value = grant_value(key_sha256, commitment);
    value["cohortAttempt"] = json!(attempt);
    value
}

fn teardown_payload(request_seq: u64) -> Vec<u8> {
    canonical_bytes(&json!({
        "schema": "rig-teardown-server-request/v1",
        "requestSeq": request_seq,
        "executionSha256": digest("execution"),
    }))
    .expect("canonical teardown request")
}

#[test]
fn a_pre_readiness_teardown_retires_the_cohort_and_admits_exactly_one_replacement() {
    let mut rig = Rig::new();
    let first_sha256 = rig.accept_and_spawn();
    assert_eq!(rig.session.stage(), RigCohortStage::ServerSpawned);
    assert_eq!(rig.session.phase(), CohortPhase::ServerSpawned);

    // 1. The teardown before readiness retires rather than ends: the child is
    //    reaped and the session is back where a grant can be accepted.
    let mut child = ScriptedServerChild::new();
    let mut reaper = RecordingReaper::default();
    let ack = rig
        .session
        .teardown_server(&teardown_payload(7), &mut child, &mut reaper)
        .expect("a pre-readiness teardown is step 1 of the replacement");
    let value = json_of(&ack);
    assert_eq!(value["schema"], "rig-server-stopped-ack/v1");
    assert_eq!(value["reaped"], true);
    assert!(reaper.reaped.contains(&4_242));
    assert!(rig.session.unreaped_pgids().is_empty());
    assert_eq!(rig.session.stage(), RigCohortStage::AwaitingGrant);
    assert_eq!(rig.session.phase(), CohortPhase::AwaitingGrant);
    // Nothing of the retired cohort is still readable on this session.
    assert_eq!(rig.session.grant_sha256(), None);
    assert_eq!(rig.session.rig_cohort_acceptance_sha256(), None);

    // 2. The retired grant cannot come back under the replacement's name.
    let replayed = rig.accept_cohort_payload();
    let refusal = rig
        .session
        .accept_cohort(&replayed, NOW_MS)
        .expect_err("the retired grant is superseded");
    assert_eq!(refusal, CohortRefusal::BindingMismatch("cohortGrantSha256"));
    assert_eq!(refusal.code(), "CROSS_SUPERVISOR_MISMATCH");

    // 3. Neither can a fresh cohort that did not advance the attempt.
    let stale_attempt = Commitment::mint("attempt-2-stale");
    let stale = rig.accept_payload_for(&attempt_grant_value(&rig.key_sha256(), &stale_attempt, 1));
    let refusal = rig
        .session
        .accept_cohort(&stale, NOW_MS)
        .expect_err("a replacement has to advance the attempt");
    assert_eq!(refusal, CohortRefusal::BindingMismatch("cohortAttempt"));

    // 4. The honest replacement is accepted, and its server child spawns.
    let second_commitment = Commitment::mint("attempt-2");
    let second = rig.accept_payload_for(&attempt_grant_value(
        &rig.key_sha256(),
        &second_commitment,
        2,
    ));
    let accepted = rig
        .session
        .accept_cohort(&second, NOW_MS)
        .expect("one pre-readiness replacement is accepted");
    let second_sha256 = json_of(&accepted)["cohortGrantSha256"]
        .as_str()
        .expect("grant digest")
        .to_owned();
    assert_ne!(second_sha256, first_sha256);
    assert_eq!(rig.session.stage(), RigCohortStage::CohortAccepted);
    let mut spawner = RecordingSpawner::default();
    rig.session
        .spawn_server(&spawn_request_payload(&second_sha256), &mut spawner)
        .expect("the replacement's server child spawns");
    assert_eq!(rig.session.stage(), RigCohortStage::ServerSpawned);

    // 5. A second pre-readiness replacement is terminal, by its closed code,
    //    and it still reaps what it found.
    let mut second_child = ScriptedServerChild::new();
    let mut second_reaper = RecordingReaper::default();
    let terminal = rig
        .session
        .teardown_server(&teardown_payload(8), &mut second_child, &mut second_reaper)
        .expect_err("at most one pre-readiness replacement");
    assert_eq!(
        terminal,
        CohortRefusal::ChildLifecycle("a second pre-readiness cohort replacement is terminal")
    );
    assert_eq!(terminal.code(), "CHILD_LIFECYCLE");
    assert_eq!(rig.session.phase(), CohortPhase::Terminal);
    assert!(rig.session.unreaped_pgids().is_empty());
}

#[test]
fn a_teardown_of_a_ready_cohort_is_a_post_readiness_replacement_and_is_terminal() {
    // The stage says "before the warmup", but the owner is the authority on
    // readiness and this cohort has reached it. Plan 2210 allows no
    // replacement there, so the frame is refused under its own code and the
    // cohort is terminal -- the same verdict the Mac binary gives
    // (`MacRefusal::Cohort("replacement after readiness")`), not the
    // `NotReady` a merely-early frame gets.
    let mut rig = Rig::new();
    let _ = rig.reach_ready();
    assert_eq!(rig.session.stage(), RigCohortStage::ServerSpawned);
    assert_eq!(rig.session.phase(), CohortPhase::Ready);
    let mut child = ScriptedServerChild::new();
    let mut reaper = RecordingReaper::default();
    let refusal = rig
        .session
        .teardown_server(&teardown_payload(9), &mut child, &mut reaper)
        .expect_err("a ready cohort has no replacement path");
    assert_eq!(
        refusal,
        CohortRefusal::ChildLifecycle("replacement is forbidden after cohort readiness")
    );
    assert_eq!(refusal.code(), "CHILD_LIFECYCLE");
    assert_eq!(rig.session.phase(), CohortPhase::Terminal);
    // The refusal reaped nothing; the groups are still owed to `teardown_all`.
    assert!(reaper.reaped.is_empty());
    assert!(!rig.session.unreaped_pgids().is_empty());
}
