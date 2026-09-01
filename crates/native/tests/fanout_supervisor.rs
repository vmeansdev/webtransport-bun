//! B3 supervisor-side cohort ownership.
//!
//! Links `secure_fs` by path, like `cohort_protocol.rs` and
//! `cross_supervisor_protocol.rs`, so this target does not pull the napi
//! cdylib into a standalone executable.
//!
//! `cohort_protocol.rs` proves the codecs: given bytes, the right record or
//! the right refusal.  This file proves the *order* those records are allowed
//! to arrive in and what each one authorises — no server before a signed
//! grant, no cross-cohort token, one relay observation, one pre-readiness
//! replacement that retires the whole old token set, no post-readiness
//! survival, and a reaped process group on every terminal path.
//!
//! Nothing here is routed from production: `CohortOwner` has no caller in
//! `serve`, exactly as B3 requires.
#![cfg(any(target_os = "linux", target_os = "macos"))]

#[path = "../src/secure_fs.rs"]
mod secure_fs;

use secure_fs::cohort::{
    canonical_bytes, merkle_proof, merkle_root, ordered_leaf_nodes, publish_token_bundle_fd,
    read_token_bundle_fd, sha256_hex, CohortOwner, CohortPhase, CohortRefusal,
    LibcProcessGroupReaper, ProcessGroupReaper, RoleChildDescriptorPlan, TokenBundleMetadata,
    TokenCommitmentLeafV1, MAX_PRE_READY_REPLACEMENTS, ROLE_CHILD_INHERITED_FD_COUNT,
    SUBSCRIBER_SHARD_MODULUS, TOKEN_BUNDLE_FD,
};
use secure_fs::cross_supervisor::{generate_ed25519_keypair, public_key_sha256, sign_bytes, Ed25519KeyPair};
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

const COHORT_ID: &str = "cohort-ticker-b3-ws";

fn digest(tag: &str) -> String {
    sha256_hex(tag.as_bytes())
}

fn ns(value: u64) -> Value {
    json!(value.to_string())
}

fn hex32(bytes: &[u8; 32]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn temp_dir(label: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("time")
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("wt-fanout-supervisor-{label}-{nanos}"));
    fs::create_dir_all(&dir).expect("temp dir");
    dir
}

/// One cohort's token commitments: one publisher and eight subscribers, one
/// per shard residue.
///
/// `salt` is what makes a replacement cohort a genuinely different token set
/// rather than the same secrets under a new name — every leaf digest, and so
/// the root, moves with it.
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

    fn claimed_role(&self, index: usize) -> &str {
        &self.leaves[index].role
    }

    fn claimed_worker(&self, index: usize) -> Option<i64> {
        self.leaves[index].worker_index
    }
}

/// A canonical `cohort-grant/v1` over one `Commitment`.
fn grant_value(key_sha256: &str, attempt: u64, commitment: &Commitment) -> Value {
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
        "cohortAttempt": attempt,
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
        "tokenCommitmentLeafManifestSha256": digest(&format!("leaf-manifest-{attempt}")),
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
        "macSupervisorInstanceNonce": digest(&format!("mac-instance-{attempt}")),
        "signingPublicKeySha256": key_sha256,
        "receiptSequence": 0,
        "issuedAtMs": 1_760_000_000_000u64,
        "notAfterMs": 1_760_000_600_000u64,
    })
}

fn barrier_value(grant_sha256: &str, key_sha256: &str) -> Value {
    json!({
        "schema": "cohort-start-barrier/v1",
        "executionSha256": digest("execution"),
        "cohortGrantSha256": grant_sha256,
        "rigCohortAcceptanceSha256": digest("rig-cohort-acceptance"),
        "rigMeasureStartAckSha256": digest("rig-measure-start-ack"),
        "roleWarmupCompletionManifestSha256": digest("role-warmup-completion-manifest"),
        "roleWarmupCompletionManifestSignatureSha256": digest("role-warmup-manifest-signature"),
        "rigWarmupDrainedReceiptSha256": digest("rig-warmup-drained-receipt"),
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
        "receiptSequence": 1,
        "issuedAtMs": 1_760_000_000_000u64,
        "notAfterMs": 1_760_000_600_000u64,
    })
}

/// A conserving ten-window `linux-relay-observation/v1`: ten accepted records
/// per window fan out to eighty completed writes over eight subscribers.
fn observation_value(grant_sha256: &str, barrier_sha256: &str) -> Value {
    let windows = 10usize;
    json!({
        "schema": "linux-relay-observation/v1",
        "executionSha256": digest("execution"),
        "cohortGrantSha256": grant_sha256,
        "cohortStartBarrierSha256": barrier_sha256,
        "roleTokenCommitmentRootSha256": digest("commitment-root"),
        "serverChildPid": 4242,
        "serverChildPgid": 4242,
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
    })
}

/// Canonical bytes plus the Mac supervisor's detached signature over exactly
/// those bytes.
fn signed(value: &Value, keys: &Ed25519KeyPair) -> (Vec<u8>, [u8; 64]) {
    let bytes = canonical_bytes(value).expect("canonical bytes");
    let signature = sign_bytes(&keys.private_pkcs8_der, &bytes).expect("sign");
    (bytes, signature)
}

/// A reaper that signals nothing and records everything, so "reaps on every
/// terminal path" is checkable without a process existing.
struct RecordingReaper {
    reaped: Vec<i32>,
    stuck: Option<i32>,
}

impl RecordingReaper {
    fn new() -> Self {
        Self {
            reaped: Vec::new(),
            stuck: None,
        }
    }

    fn with_stuck_group(pgid: i32) -> Self {
        Self {
            reaped: Vec::new(),
            stuck: Some(pgid),
        }
    }
}

impl ProcessGroupReaper for RecordingReaper {
    fn kill_and_reap(&mut self, pgid: i32) -> Result<(), CohortRefusal> {
        if self.stuck == Some(pgid) {
            return Err(CohortRefusal::ChildLifecycle(
                "process group survived SIGKILL and the reap deadline",
            ));
        }
        self.reaped.push(pgid);
        Ok(())
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

/// The nine role children of a ticker cohort: one publisher, eight workers.
fn spawn_all_role_children(owner: &mut CohortOwner) {
    owner
        .spawn_role_child(
            "publisher-000000",
            "publisher",
            2_100,
            bundle_metadata("publisher-bundle"),
            descriptor_plan(),
        )
        .expect("the publisher child spawns");
    for index in 0..SUBSCRIBER_SHARD_MODULUS {
        owner
            .spawn_role_child(
                &format!("worker-{index}"),
                "subscriber-worker",
                2_200 + index as i32,
                bundle_metadata(&format!("worker-{index}-bundle")),
                descriptor_plan(),
            )
            .expect("a worker child spawns");
    }
}

fn admit_every_registration(
    owner: &mut CohortOwner,
    grant_sha256: &str,
    commitment: &Commitment,
) {
    for index in 0..commitment.leaves.len() {
        owner
            .admit_role_registration(
                grant_sha256,
                &commitment.leaves[index],
                index,
                &commitment.proof(index),
                commitment.claimed_role(index),
                commitment.claimed_worker(index),
            )
            .expect("an honest registration is admitted");
    }
}

/// A cohort driven all the way to readiness, with its grant digest.
fn ready_cohort(keys: &Ed25519KeyPair, commitment: &Commitment) -> (CohortOwner, String) {
    let key_sha256 = public_key_sha256(&keys.public_raw32);
    let (bytes, signature) = signed(&grant_value(&key_sha256, 1, commitment), keys);
    let mut owner = CohortOwner::new();
    let grant_sha256 = owner
        .accept_grant(&bytes, &signature, &keys.public_raw32)
        .expect("a signed grant is accepted");
    owner.spawn_server(1_900).expect("the server child spawns");
    spawn_all_role_children(&mut owner);
    admit_every_registration(&mut owner, &grant_sha256, commitment);
    owner.mark_ready().expect("a complete cohort is ready");
    (owner, grant_sha256)
}

#[test]
fn supervisor_accepts_cohort_before_spawning_server() {
    let keys = generate_ed25519_keypair();
    let key_sha256 = public_key_sha256(&keys.public_raw32);
    let commitment = Commitment::mint("attempt-1");
    let (bytes, signature) = signed(&grant_value(&key_sha256, 1, &commitment), &keys);

    // Ordering, not decoration: with no accepted grant there is nothing for a
    // server child to serve, and the refusal happens before any group is owned.
    let mut owner = CohortOwner::new();
    assert_eq!(owner.phase(), CohortPhase::AwaitingGrant);
    let refusal = owner.spawn_server(1_900).expect_err("no grant, no server");
    assert_eq!(refusal.code(), "COHORT_NOT_READY");
    assert_eq!(owner.phase(), CohortPhase::AwaitingGrant);
    assert!(owner.owned_groups().is_empty());
    assert!(owner.grant().is_none());

    let grant_sha256 = owner
        .accept_grant(&bytes, &signature, &keys.public_raw32)
        .expect("a signed grant is accepted");
    assert_eq!(grant_sha256, sha256_hex(&bytes));
    assert_eq!(owner.phase(), CohortPhase::GrantAccepted);
    assert_eq!(
        owner.grant().expect("grant").role_token_commitment_root_sha256,
        commitment.root_hex
    );

    owner.spawn_server(1_900).expect("the server child spawns");
    assert_eq!(owner.phase(), CohortPhase::ServerSpawned);
    assert_eq!(owner.owned_groups().len(), 1);
    assert_eq!(owner.owned_groups()[0].label, "server");
    assert_eq!(owner.unreaped_pgids(), vec![1_900]);

    // A grant is accepted once.  A second one, however well signed, is a
    // different cohort arriving mid-flight.
    assert_eq!(
        owner
            .accept_grant(&bytes, &signature, &keys.public_raw32)
            .expect_err("a cohort has exactly one grant")
            .code(),
        "COHORT_NOT_READY"
    );

    // A grant whose bytes moved after signing never authorises a spawn: the
    // supervisor is left exactly where it started.
    let mut tampered = grant_value(&key_sha256, 1, &commitment);
    tampered["subscriberCount"] = json!(SUBSCRIBER_SHARD_MODULUS);
    tampered["messageBytes"] = json!(128);
    let tampered_bytes = canonical_bytes(&tampered).expect("bytes");
    let mut fresh = CohortOwner::new();
    assert_eq!(
        fresh.accept_grant(&tampered_bytes, &signature, &keys.public_raw32),
        Err(CohortRefusal::SignatureInvalid)
    );
    assert_eq!(fresh.phase(), CohortPhase::AwaitingGrant);
    assert_eq!(
        fresh
            .spawn_server(1_901)
            .expect_err("a refused grant authorises nothing")
            .code(),
        "COHORT_NOT_READY"
    );
    assert!(fresh.owned_groups().is_empty());
}

#[test]
fn supervisor_rejects_cross_cohort_role_token() {
    let keys = generate_ed25519_keypair();
    let key_sha256 = public_key_sha256(&keys.public_raw32);
    let mine = Commitment::mint("cohort-a");
    let theirs = Commitment::mint("cohort-b");
    assert_ne!(mine.root_hex, theirs.root_hex);

    let (bytes, signature) = signed(&grant_value(&key_sha256, 1, &mine), &keys);
    let mut owner = CohortOwner::new();
    let grant_sha256 = owner
        .accept_grant(&bytes, &signature, &keys.public_raw32)
        .expect("grant");
    owner.spawn_server(1_900).expect("server");
    spawn_all_role_children(&mut owner);

    // The honest registration this cohort actually committed to.
    owner
        .admit_role_registration(
            &grant_sha256,
            &mine.leaves[0],
            0,
            &mine.proof(0),
            "publisher",
            None,
        )
        .expect("an honest publisher registration");
    assert_eq!(owner.admitted_registration_count(), 1);

    // A registration that names a different cohort grant is refused on the
    // binding, before the proof is even attempted — the specific answer the
    // wire protocol has a code for.
    let (other_bytes, _) = signed(&grant_value(&key_sha256, 1, &theirs), &keys);
    let other_grant_sha256 = sha256_hex(&other_bytes);
    assert_ne!(other_grant_sha256, grant_sha256);
    assert_eq!(
        owner.admit_role_registration(
            &other_grant_sha256,
            &mine.leaves[1],
            1,
            &mine.proof(1),
            "subscriber",
            Some(0),
        ),
        Err(CohortRefusal::BindingMismatch("cohortGrantSha256"))
    );

    // The same token set, laundered through this cohort's grant digest: the
    // leaf is real and its proof is real, but they reach the *other* root.
    assert_eq!(
        owner.admit_role_registration(
            &grant_sha256,
            &theirs.leaves[1],
            1,
            &theirs.proof(1),
            "subscriber",
            Some(0),
        ),
        Err(CohortRefusal::TokenProofInvalid)
    );

    // A leaf carrying another cohort's identity is refused even when the
    // presented digest matches.
    let mut foreign = mine.leaves[2].clone();
    foreign.cohort_id = "cohort-somewhere-else".to_owned();
    assert_eq!(
        owner.admit_role_registration(
            &grant_sha256,
            &foreign,
            2,
            &mine.proof(2),
            "subscriber",
            Some(1),
        ),
        Err(CohortRefusal::BindingMismatch("cohortId"))
    );

    // Role and shard are checked against the committed leaf, and a spent
    // token is spent.
    assert_eq!(
        owner.admit_role_registration(
            &grant_sha256,
            &mine.leaves[1],
            1,
            &mine.proof(1),
            "publisher",
            Some(0),
        ),
        Err(CohortRefusal::WrongRole)
    );
    assert_eq!(
        owner.admit_role_registration(
            &grant_sha256,
            &mine.leaves[1],
            1,
            &mine.proof(1),
            "subscriber",
            Some(3),
        ),
        Err(CohortRefusal::WrongShard)
    );
    assert_eq!(
        owner.admit_role_registration(
            &grant_sha256,
            &mine.leaves[0],
            0,
            &mine.proof(0),
            "publisher",
            None,
        ),
        Err(CohortRefusal::TokenReplay)
    );

    // Every refusal above left the cohort exactly one registration in.
    assert_eq!(owner.admitted_registration_count(), 1);
    assert_eq!(owner.phase(), CohortPhase::ServerSpawned);
}

#[test]
fn supervisor_receipts_linux_relay_observation_once() {
    let keys = generate_ed25519_keypair();
    let key_sha256 = public_key_sha256(&keys.public_raw32);
    let commitment = Commitment::mint("attempt-1");
    let (mut owner, grant_sha256) = ready_cohort(&keys, &commitment);

    let observation = observation_value(&grant_sha256, &digest("unbound-barrier"));
    let observation_bytes = canonical_bytes(&observation).expect("bytes");

    // A ready cohort with no accepted barrier has no measured window an
    // observation could describe.
    assert_eq!(
        owner.receipt_relay_observation(&observation_bytes),
        Err(CohortRefusal::NotReady("cohort start barrier"))
    );

    let (barrier_bytes, barrier_signature) = signed(&barrier_value(&grant_sha256, &key_sha256), &keys);
    let barrier_sha256 = owner
        .accept_start_barrier(&barrier_bytes, &barrier_signature, &keys.public_raw32)
        .expect("a signed barrier is accepted after readiness");
    assert_eq!(barrier_sha256, sha256_hex(&barrier_bytes));

    // The observation must name the barrier this cohort actually accepted.
    assert_eq!(
        owner.receipt_relay_observation(&observation_bytes),
        Err(CohortRefusal::BindingMismatch("cohortStartBarrierSha256"))
    );

    let honest = canonical_bytes(&observation_value(&grant_sha256, &barrier_sha256)).expect("bytes");
    let receipted = owner
        .receipt_relay_observation(&honest)
        .expect("one honest observation is receipted");
    assert_eq!(receipted, sha256_hex(&honest));
    assert_eq!(owner.relay_observation_sha256(), Some(receipted.as_str()));
    assert_eq!(owner.phase(), CohortPhase::Ready);

    // A second observation is not the same answer restated; it is a second
    // claim about one measured window, so it ends the cohort.
    assert_eq!(
        owner.receipt_relay_observation(&honest),
        Err(CohortRefusal::Duplicate(
            "linux-relay-observation/v1".to_owned()
        ))
    );
    assert_eq!(owner.phase(), CohortPhase::Terminal);
    assert_eq!(owner.relay_observation_sha256(), Some(receipted.as_str()));

    // An observation belonging to another cohort is refused on the binding,
    // and one arriving before readiness is refused on the phase.
    let (other_owner_keys, other_commitment) =
        (generate_ed25519_keypair(), Commitment::mint("attempt-9"));
    let (mut other, other_grant_sha256) = ready_cohort(&other_owner_keys, &other_commitment);
    let other_key_sha256 = public_key_sha256(&other_owner_keys.public_raw32);
    let (other_barrier_bytes, other_barrier_signature) = signed(
        &barrier_value(&other_grant_sha256, &other_key_sha256),
        &other_owner_keys,
    );
    let other_barrier_sha256 = other
        .accept_start_barrier(
            &other_barrier_bytes,
            &other_barrier_signature,
            &other_owner_keys.public_raw32,
        )
        .expect("barrier");
    let cross = canonical_bytes(&observation_value(&grant_sha256, &other_barrier_sha256))
        .expect("bytes");
    assert_eq!(
        other.receipt_relay_observation(&cross),
        Err(CohortRefusal::BindingMismatch("cohortGrantSha256"))
    );

    let mut early = CohortOwner::new();
    assert_eq!(
        early
            .receipt_relay_observation(&honest)
            .expect_err("no observation before readiness")
            .code(),
        "COHORT_NOT_READY"
    );
}

#[test]
fn supervisor_role_child_fds_are_private_and_bounded() {
    // The set is decided in advance so "no unexpected inherited FD" is a
    // question with an answer.
    let plan = RoleChildDescriptorPlan::new(7, 8).expect("a private control pair");
    assert_eq!(plan.inherited_fds(), vec![0, 1, 2, 5, 7, 8]);
    assert_eq!(plan.inherited_fds().len(), ROLE_CHILD_INHERITED_FD_COUNT);
    assert_eq!(plan.token_bundle_fd(), TOKEN_BUNDLE_FD);
    assert!(plan.permits(TOKEN_BUNDLE_FD));
    assert!(plan.permits(plan.control_in_fd()));
    assert!(plan.permits(plan.control_out_fd()));
    for unexpected in [3, 4, 6, 9, 64] {
        assert!(!plan.permits(unexpected), "fd {unexpected} was never planned");
    }

    // A control pipe on FD 5 would let the child read its own tokens back out
    // of the channel it answers on; a control pipe on stderr would be whatever
    // the parent's stdio was; one descriptor cannot be both directions.
    assert_eq!(
        RoleChildDescriptorPlan::new(TOKEN_BUNDLE_FD, 8),
        Err(CohortRefusal::TokenBundleFdInvalid)
    );
    assert_eq!(
        RoleChildDescriptorPlan::new(7, TOKEN_BUNDLE_FD),
        Err(CohortRefusal::TokenBundleFdInvalid)
    );
    assert_eq!(
        RoleChildDescriptorPlan::new(2, 8),
        Err(CohortRefusal::TokenBundleFdInvalid)
    );
    assert_eq!(
        RoleChildDescriptorPlan::new(7, 7),
        Err(CohortRefusal::Duplicate("fd 7".to_owned()))
    );

    // The real descriptor: created exclusively, reopened read-only, unlinked
    // before any child could exist, and readable exactly once.
    let dir = temp_dir("role-child-fd");
    let bundle = json!({
        "schema": "token-bundle/v1",
        "executionSha256": digest("execution"),
        "cohortGrantSha256": digest("grant"),
        "childId": "worker-0",
        "entryCount": 1,
        "entries": [{
            "schema": "token-bundle-entry/v1",
            "role": "subscriber",
            "roleId": "subscriber-000000",
            "workerIndex": 0,
            "tokenBase64": "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
            "tokenSha256": digest("token"),
            "tokenCommitmentIndex": 1,
            "tokenMerkleProofSha256": [digest("sib-0"), digest("sib-1")],
        }],
    });
    let bundle_bytes = canonical_bytes(&bundle).expect("bundle bytes");
    let leaf_path = dir.join("worker-0.token-bundle");
    let (fd, metadata) =
        publish_token_bundle_fd(leaf_path.to_str().expect("path"), &bundle_bytes).expect("publish");
    assert!(!leaf_path.exists(), "the child never receives a pathname");
    assert_eq!(metadata.sha256, sha256_hex(&bundle_bytes));

    assert_eq!(
        read_token_bundle_fd(fd, &metadata).expect("the child reads once"),
        bundle_bytes
    );
    assert_eq!(
        read_token_bundle_fd(fd, &metadata),
        Err(CohortRefusal::TokenBundleFdInvalid),
        "a spent descriptor is not a second bundle"
    );

    // What the supervisor retains is the commitment, never the secret.
    let keys = generate_ed25519_keypair();
    let key_sha256 = public_key_sha256(&keys.public_raw32);
    let commitment = Commitment::mint("attempt-1");
    let (bytes, signature) = signed(&grant_value(&key_sha256, 1, &commitment), &keys);
    let mut owner = CohortOwner::new();
    owner
        .accept_grant(&bytes, &signature, &keys.public_raw32)
        .expect("grant");
    owner.spawn_server(1_900).expect("server");
    owner
        .spawn_role_child("worker-0", "subscriber-worker", 2_200, metadata.clone(), plan)
        .expect("a worker child spawns");
    let retained = &owner.role_children()[0];
    assert_eq!(retained.token_bundle, metadata);
    assert_eq!(retained.descriptors.inherited_fds().len(), ROLE_CHILD_INHERITED_FD_COUNT);

    // One identity and one process group per child.
    assert_eq!(
        owner.spawn_role_child(
            "worker-0",
            "subscriber-worker",
            2_201,
            bundle_metadata("again"),
            descriptor_plan(),
        ),
        Err(CohortRefusal::Duplicate("worker-0".to_owned()))
    );
    assert_eq!(
        owner.spawn_role_child(
            "worker-1",
            "subscriber-worker",
            2_200,
            bundle_metadata("worker-1"),
            descriptor_plan(),
        ),
        Err(CohortRefusal::Duplicate("pgid 2200".to_owned()))
    );

    // The cohort is bounded by its own signed cardinality: nine role children,
    // and the tenth is refused rather than silently owned.
    for index in 1..SUBSCRIBER_SHARD_MODULUS {
        owner
            .spawn_role_child(
                &format!("worker-{index}"),
                "subscriber-worker",
                2_200 + index as i32,
                bundle_metadata(&format!("worker-{index}")),
                descriptor_plan(),
            )
            .expect("a worker child spawns");
    }
    owner
        .spawn_role_child(
            "publisher-000000",
            "publisher",
            2_100,
            bundle_metadata("publisher"),
            descriptor_plan(),
        )
        .expect("the publisher child spawns");
    assert_eq!(owner.role_children().len(), 9);
    assert_eq!(
        owner.spawn_role_child(
            "publisher-000001",
            "publisher",
            2_101,
            bundle_metadata("extra"),
            descriptor_plan(),
        ),
        Err(CohortRefusal::BindingMismatch("expectedProcessCount"))
    );

    unsafe { libc::close(fd) };
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn supervisor_pre_ready_replacement_invalidates_old_tokens() {
    assert_eq!(MAX_PRE_READY_REPLACEMENTS, 1);
    let keys = generate_ed25519_keypair();
    let key_sha256 = public_key_sha256(&keys.public_raw32);
    let first = Commitment::mint("attempt-1");
    let second = Commitment::mint("attempt-2");
    let third = Commitment::mint("attempt-3");

    let (first_bytes, first_signature) = signed(&grant_value(&key_sha256, 1, &first), &keys);
    let mut owner = CohortOwner::new();
    let first_sha256 = owner
        .accept_grant(&first_bytes, &first_signature, &keys.public_raw32)
        .expect("grant");
    owner.spawn_server(1_900).expect("server");
    spawn_all_role_children(&mut owner);
    owner
        .admit_role_registration(
            &first_sha256,
            &first.leaves[0],
            0,
            &first.proof(0),
            "publisher",
            None,
        )
        .expect("a registration under the first attempt");
    let first_groups = owner
        .owned_groups()
        .iter()
        .map(|group| group.pgid)
        .collect::<Vec<_>>();
    assert_eq!(first_groups.len(), 10);

    // A replacement that reuses the retired root, or that does not advance the
    // attempt, is the old cohort wearing a new name.
    let (same_root_bytes, same_root_signature) = signed(&grant_value(&key_sha256, 2, &first), &keys);
    let mut reaper = RecordingReaper::new();
    assert_eq!(
        owner.replace_before_ready(
            &mut reaper,
            &same_root_bytes,
            &same_root_signature,
            &keys.public_raw32
        ),
        Err(CohortRefusal::BindingMismatch(
            "roleTokenCommitmentRootSha256"
        ))
    );
    let (same_attempt_bytes, same_attempt_signature) =
        signed(&grant_value(&key_sha256, 1, &second), &keys);
    assert_eq!(
        owner.replace_before_ready(
            &mut reaper,
            &same_attempt_bytes,
            &same_attempt_signature,
            &keys.public_raw32
        ),
        Err(CohortRefusal::BindingMismatch("cohortAttempt"))
    );
    // A refused replacement kills nothing.
    assert!(reaper.reaped.is_empty());
    assert_eq!(owner.replacement_count(), 0);

    let (second_bytes, second_signature) = signed(&grant_value(&key_sha256, 2, &second), &keys);
    let second_sha256 = owner
        .replace_before_ready(
            &mut reaper,
            &second_bytes,
            &second_signature,
            &keys.public_raw32,
        )
        .expect("one pre-readiness replacement is allowed");
    assert_ne!(second_sha256, first_sha256);
    assert_eq!(owner.replacement_count(), 1);
    assert_eq!(owner.phase(), CohortPhase::GrantAccepted);
    // The whole old cohort was killed, not patched: every group it owned was
    // reaped, and none is carried into the new attempt.
    let mut reaped = reaper.reaped.clone();
    reaped.sort_unstable();
    let mut expected = first_groups.clone();
    expected.sort_unstable();
    assert_eq!(reaped, expected);
    assert!(owner.owned_groups().is_empty());
    assert!(owner.role_children().is_empty());
    assert_eq!(owner.admitted_registration_count(), 0);

    owner.spawn_server(1_901).expect("a fresh server child");
    spawn_all_role_children(&mut owner);

    // The retired grant and its whole token set are dead in both directions:
    // the old digest no longer names this cohort, and the old leaves no longer
    // reach its root.
    assert_eq!(
        owner.admit_role_registration(
            &first_sha256,
            &first.leaves[0],
            0,
            &first.proof(0),
            "publisher",
            None,
        ),
        Err(CohortRefusal::BindingMismatch("cohortGrantSha256"))
    );
    assert_eq!(
        owner.admit_role_registration(
            &second_sha256,
            &first.leaves[0],
            0,
            &first.proof(0),
            "publisher",
            None,
        ),
        Err(CohortRefusal::TokenProofInvalid)
    );
    // The new attempt's own token at the same index is honest, so the refusal
    // above is about the retired secret rather than about the index.
    owner
        .admit_role_registration(
            &second_sha256,
            &second.leaves[0],
            0,
            &second.proof(0),
            "publisher",
            None,
        )
        .expect("the fresh token set is admitted");

    // A second pre-readiness replacement is terminal, and it still reaps.
    let (third_bytes, third_signature) = signed(&grant_value(&key_sha256, 3, &third), &keys);
    let second_groups = owner
        .owned_groups()
        .iter()
        .map(|group| group.pgid)
        .collect::<Vec<_>>();
    let mut final_reaper = RecordingReaper::new();
    assert_eq!(
        owner.replace_before_ready(
            &mut final_reaper,
            &third_bytes,
            &third_signature,
            &keys.public_raw32
        ),
        Err(CohortRefusal::ChildLifecycle(
            "a second pre-readiness cohort replacement is terminal"
        ))
    );
    assert_eq!(owner.phase(), CohortPhase::Terminal);
    let mut final_reaped = final_reaper.reaped.clone();
    final_reaped.sort_unstable();
    let mut expected_final = second_groups;
    expected_final.sort_unstable();
    assert_eq!(final_reaped, expected_final);
    assert!(owner.unreaped_pgids().is_empty());

    // The retired grant cannot be re-accepted by a fresh supervisor state
    // either, once this one has retired it.
    let mut replay = CohortOwner::new();
    replay
        .accept_grant(&first_bytes, &first_signature, &keys.public_raw32)
        .expect("a fresh supervisor has retired nothing");
    assert_eq!(replay.phase(), CohortPhase::GrantAccepted);
}

#[test]
fn supervisor_post_ready_child_exit_is_terminal() {
    let keys = generate_ed25519_keypair();
    let key_sha256 = public_key_sha256(&keys.public_raw32);
    let commitment = Commitment::mint("attempt-1");
    let replacement = Commitment::mint("attempt-2");

    // Before readiness a child exit is survivable; after it, it is not.
    let (bytes, signature) = signed(&grant_value(&key_sha256, 1, &commitment), &keys);
    let mut pre_ready = CohortOwner::new();
    pre_ready
        .accept_grant(&bytes, &signature, &keys.public_raw32)
        .expect("grant");
    pre_ready.spawn_server(1_900).expect("server");
    spawn_all_role_children(&mut pre_ready);
    pre_ready
        .note_child_exit("worker-3")
        .expect("a pre-readiness exit is a replacement trigger, not a verdict");
    assert_eq!(pre_ready.phase(), CohortPhase::ServerSpawned);
    assert_eq!(
        pre_ready.note_child_exit("worker-99"),
        Err(CohortRefusal::BindingMismatch("childId"))
    );

    let (mut owner, _) = ready_cohort(&keys, &commitment);
    assert_eq!(owner.phase(), CohortPhase::Ready);
    let exit = owner
        .note_child_exit("worker-3")
        .expect_err("a ready cohort that loses a child has lost the measurement");
    assert_eq!(
        exit,
        CohortRefusal::ChildLifecycle("a child exited after cohort readiness")
    );
    assert_eq!(exit.code(), "CHILD_LIFECYCLE");
    assert_eq!(owner.phase(), CohortPhase::Terminal);

    // Terminal is terminal: there is no replacement path out of it, and the
    // groups it owned are still owed a reap.
    let (replacement_bytes, replacement_signature) =
        signed(&grant_value(&key_sha256, 2, &replacement), &keys);
    let mut reaper = RecordingReaper::new();
    assert_eq!(
        owner.replace_before_ready(
            &mut reaper,
            &replacement_bytes,
            &replacement_signature,
            &keys.public_raw32
        ),
        Err(CohortRefusal::ChildLifecycle("cohort is already terminal"))
    );
    assert_eq!(
        owner.note_child_exit("worker-4"),
        Err(CohortRefusal::ChildLifecycle("cohort is already terminal"))
    );
    assert_eq!(owner.unreaped_pgids().len(), 10);
    owner.teardown(&mut reaper).expect("teardown still reaps");
    assert!(owner.unreaped_pgids().is_empty());

    // Replacement of a ready cohort is refused for its own reason and is
    // itself terminal.
    let (mut ready, _) = ready_cohort(&keys, &commitment);
    let mut ready_reaper = RecordingReaper::new();
    assert_eq!(
        ready.replace_before_ready(
            &mut ready_reaper,
            &replacement_bytes,
            &replacement_signature,
            &keys.public_raw32
        ),
        Err(CohortRefusal::ChildLifecycle(
            "replacement is forbidden after cohort readiness"
        ))
    );
    assert_eq!(ready.phase(), CohortPhase::Terminal);
}

#[test]
fn supervisor_teardown_reaps_entire_process_group() {
    // Part one, with real processes: a group whose leader has a child of its
    // own is killed whole, not down to its leader.
    let mut child = std::process::Command::new("/bin/sh");
    child
        .arg("-c")
        .arg("sleep 300 & echo $!; wait")
        .stdout(std::process::Stdio::piped())
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    unsafe {
        std::os::unix::process::CommandExt::pre_exec(&mut child, || {
            // Its own session, so the group this test signals can never be the
            // test runner's own.
            if libc::setsid() < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut spawned = child.spawn().expect("spawn a real process group leader");
    let pgid = spawned.id() as i32;
    let grandchild = {
        use std::io::BufRead;
        let stdout = spawned.stdout.take().expect("piped stdout");
        let mut line = String::new();
        std::io::BufReader::new(stdout)
            .read_line(&mut line)
            .expect("the leader reports its own child");
        line.trim().parse::<i32>().expect("a pid")
    };
    assert_ne!(grandchild, pgid);
    // SAFETY: signal 0 is an existence check only.
    assert_eq!(unsafe { libc::kill(grandchild, 0) }, 0);

    let keys = generate_ed25519_keypair();
    let key_sha256 = public_key_sha256(&keys.public_raw32);
    let commitment = Commitment::mint("attempt-1");
    let (bytes, signature) = signed(&grant_value(&key_sha256, 1, &commitment), &keys);
    let mut owner = CohortOwner::new();
    owner
        .accept_grant(&bytes, &signature, &keys.public_raw32)
        .expect("grant");
    owner.spawn_server(pgid).expect("the real group is owned");

    let mut reaper = LibcProcessGroupReaper {
        sigterm_grace_ms: 2_000,
        sigkill_reap_ms: 3_000,
    };
    assert_eq!(
        owner.teardown(&mut reaper).expect("bounded reap"),
        vec![pgid]
    );
    assert!(owner.unreaped_pgids().is_empty());
    assert_eq!(owner.phase(), CohortPhase::Terminal);
    // Nothing in the group survived, including the grandchild the supervisor
    // never spawned directly and cannot wait on.
    assert_eq!(unsafe { libc::killpg(pgid, 0) }, -1);
    assert_eq!(
        std::io::Error::last_os_error().raw_os_error(),
        Some(libc::ESRCH)
    );
    for _ in 0..200 {
        if unsafe { libc::kill(grandchild, 0) } == -1 {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    assert_eq!(unsafe { libc::kill(grandchild, 0) }, -1);
    // The reaper already collected this child's status, so the handle has
    // nothing left to wait on; the call is here so the leader is provably not
    // left as a zombie owned by the test.
    let _ = spawned.try_wait();

    // The supervisor never signals a group it does not own.
    assert_eq!(
        reaper.kill_and_reap(1),
        Err(CohortRefusal::ChildLifecycle(
            "refusing to signal a process group the supervisor does not own"
        ))
    );

    // Part two, by recording: every terminal path reaps every owned group.
    let commitment = Commitment::mint("attempt-1");
    let (mut ready, _) = ready_cohort(&keys, &commitment);
    let owned = ready
        .owned_groups()
        .iter()
        .map(|group| group.pgid)
        .collect::<Vec<_>>();
    assert_eq!(owned.len(), 10, "one server child plus nine role children");
    let mut recorder = RecordingReaper::new();
    let mut reaped = ready.teardown(&mut recorder).expect("teardown");
    reaped.sort_unstable();
    let mut expected = owned.clone();
    expected.sort_unstable();
    assert_eq!(reaped, expected);
    assert!(ready.unreaped_pgids().is_empty());
    // Idempotent: a second teardown reaps nothing because nothing is owed.
    assert_eq!(ready.teardown(&mut recorder).expect("again"), Vec::<i32>::new());
    assert_eq!(recorder.reaped.len(), owned.len());

    // A group that survives its deadline is reported, and the remaining groups
    // are still signalled rather than abandoned behind it.
    let (mut stuck_cohort, _) = ready_cohort(&keys, &commitment);
    let stuck_pgid = stuck_cohort.owned_groups()[0].pgid;
    let mut stuck = RecordingReaper::with_stuck_group(stuck_pgid);
    let failure = stuck_cohort
        .teardown(&mut stuck)
        .expect_err("a surviving group is a lifecycle failure");
    assert_eq!(failure.code(), "CHILD_LIFECYCLE");
    assert_eq!(stuck_cohort.phase(), CohortPhase::Terminal);
    assert_eq!(stuck.reaped.len(), owned.len() - 1);
    assert_eq!(stuck_cohort.unreaped_pgids(), vec![stuck_pgid]);
}
