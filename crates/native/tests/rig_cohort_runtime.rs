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
    AbsentServerChild, RigCohortSession, RigCohortStage, RigExecutionBinding, RigIdentity,
    ServerChildChannel, ServerSpawner, SpawnServerRequest, SpawnedServerChild,
};
use secure_fs::cohort::{
    canonical_bytes, merkle_proof, merkle_root, ordered_leaf_nodes, sha256_hex, CohortPhase,
    CohortRefusal, ProcessGroupReaper, RoleChildDescriptorPlan, TokenBundleMetadata,
    TokenCommitmentLeafV1, SUBSCRIBER_SHARD_MODULUS,
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
            "lastTokenCommitmentIndexExclusive": SUBSCRIBER_SHARD_MODULUS + 1,
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

fn spawn_request_payload(grant_sha256: &str) -> Vec<u8> {
    let launch_record = b"{\"schema\":\"staged-server-launch-record/v1\"}\n".to_vec();
    canonical_bytes(&json!({
        "schema": "rig-spawn-server-request/v1",
        "requestSeq": 2,
        "executionSha256": digest("execution"),
        "cohortGrantSha256": grant_sha256,
        "serverEntrypointSha256": digest("server.ts"),
        "bunSha256": digest("bun"),
        "addonSha256": digest("addon"),
        "stagedServerLaunchRecordBase64": b64(&launch_record),
        "stagedServerLaunchRecordSha256": sha256_hex(&launch_record),
        "stagedServerLaunchRecordSize": launch_record.len() as u64,
        "bindAddress": "10.99.0.2",
        "bindPort": 4433,
        "advertisedHost": "10.99.0.2",
        "tlsServerName": "wt-compare.local",
        "transport": "ws",
        "serverArgv": ["server.ts", "--transport=wt", "--mode=fanout-cohort"],
    }))
    .expect("canonical spawn request")
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
}

impl ScriptedServerChild {
    fn new() -> Self {
        Self {
            epoch_sha256: String::new(),
            manifest_sha256: String::new(),
            barrier_sha256: String::new(),
            warmup_ingress: 10,
            warmup_deliveries: 80,
        }
    }
}

impl ServerChildChannel for ScriptedServerChild {
    fn warmup_start(&mut self, epoch_bytes: &[u8]) -> Result<Vec<u8>, CohortRefusal> {
        self.epoch_sha256 = sha256_hex(epoch_bytes);
        canonical_bytes(&json!({
            "schema": "server-warmup-ready/v1",
            "sequence": 1,
            "executionSha256": digest("execution"),
            "cohortWarmupEpochSha256": self.epoch_sha256,
        }))
    }

    fn drain_warmup(&mut self, manifest_bytes: &[u8]) -> Result<Vec<u8>, CohortRefusal> {
        self.manifest_sha256 = sha256_hex(manifest_bytes);
        canonical_bytes(&json!({
            "schema": "server-warmup-drained/v1",
            "sequence": 2,
            "executionSha256": digest("execution"),
            "cohortWarmupEpochSha256": self.epoch_sha256,
            "roleWarmupCompletionManifestSha256": self.manifest_sha256,
            "warmupIngress": self.warmup_ingress,
            "warmupDeliveries": self.warmup_deliveries,
            "publisherWarmupEndCount": 1,
            "subscriberWarmupEndCount": SUBSCRIBER_SHARD_MODULUS,
            "warmupQueuesEmpty": true,
            "measuredCountersZero": true,
            "drainedAtLinuxNs": ns(6_100_000_000),
            "linuxClockId": "clock-monotonic-boot-b",
        }))
    }

    fn measure_start_baseline(&mut self) -> Result<(u64, u64), CohortRefusal> {
        Ok((17, 6_200_000_000))
    }

    fn present_start_barrier(&mut self, barrier_bytes: &[u8]) -> Result<Vec<u8>, CohortRefusal> {
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

    fn accept_cohort_payload(&self) -> Vec<u8> {
        let value = grant_value(&self.key_sha256(), &self.commitment);
        let bytes = canonical_bytes(&value).expect("canonical grant");
        let signature = mac_signature_record(&self.mac, "cohort-grant/v1", &bytes);
        request_payload(
            "rig-accept-cohort-request/v1",
            1,
            "cohortGrantBase64",
            &bytes,
            "cohortGrantSignatureBase64",
            &signature,
        )
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
        .accept_cohort(
            &request_payload(
                "rig-accept-cohort-request/v1",
                1,
                "cohortGrantBase64",
                &bytes,
                "cohortGrantSignatureBase64",
                &forged,
            ),
            NOW_MS,
        )
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
            &request_payload(
                "rig-accept-cohort-request/v1",
                1,
                "cohortGrantBase64",
                &tampered_bytes,
                "cohortGrantSignatureBase64",
                &honest,
            ),
            NOW_MS,
        )
        .expect_err("a grant edited after signing is refused");
    assert_eq!(refusal.code(), "MAC_GRANT_SIGNATURE_INVALID");

    // A real Mac signature over these exact bytes that claims to cover a
    // different record is a cross-record substitution, not a grant.
    let mislabelled = mac_signature_record(&rig.mac, "cohort-start-barrier/v1", &bytes);
    let refusal = rig
        .session
        .accept_cohort(
            &request_payload(
                "rig-accept-cohort-request/v1",
                1,
                "cohortGrantBase64",
                &bytes,
                "cohortGrantSignatureBase64",
                &mislabelled,
            ),
            NOW_MS,
        )
        .expect_err("a signature naming another schema is refused");
    assert_eq!(refusal.code(), "TRUST_RECORD_BINDING_MISMATCH");

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
    assert_eq!(refusal.code(), "TRUST_RECORD_BINDING_MISMATCH");
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
    assert_eq!(refusal.code(), "TRUST_RECORD_BINDING_MISMATCH");
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
