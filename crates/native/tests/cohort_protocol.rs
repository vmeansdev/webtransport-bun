//! B1 Rust mirror of the plan's section 4 cohort contracts.
//!
//! Links `secure_fs` by path (the same pattern `secure_fs_trust.rs` and
//! `cross_supervisor_protocol.rs` use) so this target does not pull the napi
//! cdylib into a standalone executable.
//!
//! This file is protocol-only.  Nothing here spawns a child, opens a socket,
//! or reaches production; every test drives the codec and the offline
//! recomputation equations directly.
#![cfg(any(target_os = "linux", target_os = "macos"))]

#[path = "../src/secure_fs.rs"]
mod secure_fs;

use secure_fs::cohort::{
    canonical_bytes, chat_10k_token_bundle_ceiling, merkle_proof, merkle_root, ordered_leaf_nodes,
    publish_token_bundle_fd, read_token_bundle_fd, recompute_conservation, sha256_hex,
    verify_merkle_proof, ClaimedLedger, ClaimedRateSeries, CohortGrantV1, CohortRefusal,
    CohortStartBarrierV1, LinuxRelayObservationV1, LinuxWindowsV1, OrderedPartialManifestV1,
    PublisherWindowsV1, TokenBundleMetadata, TokenCommitmentLeafV1, TokenSpendTable,
    WorkerWindowsV1, COHORT_GRANT_MAX_BYTES, MAX_SAFE_INTEGER, ORDERED_PARTIAL_MANIFEST_MAX_BYTES,
    PUBLISHER_PARTIAL_MAX_BYTES, SUBSCRIBER_SHARD_MODULUS, TOKEN_BUNDLE_MAX_SIZE,
    WORKER_PARTIAL_MAX_BYTES,
};
use secure_fs::cross_supervisor::{generate_ed25519_keypair, public_key_sha256, sign_bytes};
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

fn temp_dir(label: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("time")
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("wt-cohort-{label}-{nanos}"));
    fs::create_dir_all(&dir).expect("temp dir");
    dir
}

/// A deterministic 64-hex digest so fixtures read as distinct identities
/// rather than as one repeated placeholder.
fn digest(tag: &str) -> String {
    sha256_hex(tag.as_bytes())
}

fn ns(value: u64) -> Value {
    json!(value.to_string())
}

/// One canonical `cohort-grant/v1` for a ticker cell: one publisher, eight
/// worker shards, one hundred subscribers.
fn grant_value(public_key_sha256: &str) -> Value {
    let mut shards = Vec::new();
    for worker_index in 0..SUBSCRIBER_SHARD_MODULUS {
        // 100 subscribers over 8 residues: residues 0..3 carry 13, 4..7 carry 12.
        let count = if worker_index < 4 { 13u64 } else { 12u64 };
        shards.push(json!({
            "schema": "subscriber-shard/v1",
            "childId": format!("worker-{worker_index}"),
            "workerIndex": worker_index,
            "modulus": SUBSCRIBER_SHARD_MODULUS,
            "residue": worker_index,
            "firstSubscriberIndex": 0,
            "lastSubscriberIndexExclusive": 100,
            "subscriberCount": count,
            "orderedSubscriberIdsSha256": digest(&format!("shard-{worker_index}")),
            "firstTokenCommitmentIndex": worker_index,
            "lastTokenCommitmentIndexExclusive": 100,
        }));
    }
    json!({
        "schema": "cohort-grant/v1",
        "execution": { "schema": "cross-supervisor-execution/v1", "executionIndex": 1 },
        "executionSha256": digest("execution"),
        "macExecutionGrantReceiptSha256": digest("mac-execution-grant-receipt"),
        "approvedPlanSha256": digest("approved-plan"),
        "approvalRecordSha256": digest("approval-record"),
        "cohortId": "cohort-ticker-10k-ws",
        "cohortAttempt": 1,
        "scenarioHash": digest("scenario"),
        "rolePlanHash": digest("role-plan"),
        "workloadRolePlanInputSha256": digest("workload-role-plan-input"),
        "transport": "ws",
        "publisherCount": 1,
        "subscriberCount": 100,
        "workerCount": 8,
        "expectedProcessCount": 9,
        "expectedSessionCount": 101,
        "publishers": [{
            "schema": "publisher-role-grant/v1",
            "childId": "publisher-000000",
            "publisherId": "publisher-000000",
            "tokenCommitmentIndex": 0,
            "tokenSha256": digest("publisher-token"),
        }],
        "subscriberShards": shards,
        "tokenCommitmentLeafManifestSha256": digest("leaf-manifest"),
        "roleTokenCommitmentRootSha256": digest("commitment-root"),
        "roleTokenCommitmentCount": 101,
        "connectionRatePerSecond": 500,
        "maxConnectionsInFlight": 200,
        "readinessDeadlineMs": 30000,
        "inRepetitionWarmupMs": 5000,
        "sampleWindowMs": 1000,
        "measuredDurationMs": 10000,
        "drainDeadlineMs": 10000,
        "messageBytes": 100,
        "expectedOfferedIngress": 100000,
        "expectedExpandedDeliveries": 10000000,
        "macSupervisorInstanceNonce": digest("mac-instance"),
        "signingPublicKeySha256": public_key_sha256,
        "receiptSequence": 0,
        "issuedAtMs": 1_760_000_000_000u64,
        "notAfterMs": 1_760_000_600_000u64,
    })
}

/// One canonical `cohort-start-barrier/v1` bound to `grant_sha256`.
///
/// `minted_at` is a parameter because the pre-readiness refusal is exactly a
/// mint stamp that precedes the warmup completion it claims to follow.
fn barrier_value(grant_sha256: &str, minted_at: u64, public_key_sha256: &str) -> Value {
    json!({
        "schema": "cohort-start-barrier/v1",
        "executionSha256": digest("execution"),
        "cohortGrantSha256": grant_sha256,
        "rigCohortAcceptanceSha256": digest("rig-cohort-acceptance"),
        "rigMeasureStartAckSha256": digest("rig-measure-start-ack"),
        "roleWarmupCompletionManifestSha256": digest("role-warmup-completion-manifest"),
        "roleWarmupCompletionManifestSignatureSha256": digest("role-warmup-manifest-signature"),
        "rigWarmupDrainedReceiptSha256": digest("rig-warmup-drained-receipt"),
        "cohortId": "cohort-ticker-10k-ws",
        "barrierNonce": digest("barrier-nonce"),
        "macClockId": "mach-continuous-boot-a",
        "mintedAtMacNs": ns(minted_at),
        "warmupStartedAtMacNs": ns(1_000_000_000),
        "warmupCompletedAtMacNs": ns(6_000_000_000),
        "measureStartAtMacNs": ns(7_000_000_000),
        "measureStopAtMacNs": ns(17_000_000_000),
        "sampleWindowMs": 1000,
        "windowCount": 10,
        "measuredDurationMs": 10000,
        "drainDeadlineMs": 10000,
        "macSupervisorInstanceNonce": digest("mac-instance"),
        "signingPublicKeySha256": public_key_sha256,
        "receiptSequence": 1,
        "issuedAtMs": 1_760_000_000_000u64,
        "notAfterMs": 1_760_000_600_000u64,
    })
}

fn leaf(role: &str, role_id: &str, worker_index: Option<i64>, tag: &str) -> TokenCommitmentLeafV1 {
    TokenCommitmentLeafV1 {
        child_id: format!("{role}-child"),
        cohort_id: "cohort-ticker-10k-ws".to_owned(),
        role: role.to_owned(),
        role_id: role_id.to_owned(),
        token_sha256: digest(tag),
        worker_index,
    }
}

#[test]
fn cohort_grant_v1_round_trips_exact_keys_and_signature() {
    let keys = generate_ed25519_keypair();
    let key_sha256 = public_key_sha256(&keys.public_raw32);
    let value = grant_value(&key_sha256);
    let bytes = canonical_bytes(&value).expect("canonical grant bytes");

    // Canonical form: sorted keys, no insignificant whitespace, one trailing LF.
    assert_eq!(bytes.last().copied(), Some(b'\n'));
    assert_eq!(bytes.iter().filter(|b| **b == b'\n').count(), 1);
    assert!(bytes.len() <= COHORT_GRANT_MAX_BYTES);
    let text = std::str::from_utf8(&bytes).expect("utf8");
    assert!(text.starts_with("{\"approvalRecordSha256\":"), "{text:.64}");

    let signature = sign_bytes(&keys.private_pkcs8_der, &bytes).expect("sign");
    let grant = CohortGrantV1::parse_signed(&bytes, &signature, &keys.public_raw32)
        .expect("signed grant parses");

    assert_eq!(grant.sha256, sha256_hex(&bytes));
    assert_eq!(grant.cohort_id, "cohort-ticker-10k-ws");
    assert_eq!(grant.transport, "ws");
    assert_eq!(grant.publisher_count, 1);
    assert_eq!(grant.subscriber_count, 100);
    assert_eq!(grant.worker_count, 8);
    assert_eq!(grant.expected_session_count, 101);
    assert_eq!(grant.expected_process_count, 9);
    assert_eq!(grant.message_bytes, 100);
    assert_eq!(grant.measured_duration_ms, 10_000);
    assert_eq!(grant.window_count(), 10);
    assert_eq!(grant.subscriber_shards.len(), 8);
    assert_eq!(grant.publishers.len(), 1);
    // The grant is pre-readiness: it carries no start timestamp at all.
    assert!(!text.contains("measureStartAtMacNs"));

    // Re-encoding the parsed record reproduces the exact signed bytes.
    assert_eq!(grant.canonical_bytes(), bytes);

    // One unknown key, one missing key, one duplicate key, one flipped bit.
    let mut extra = value.clone();
    extra["startAtMacNs"] = ns(7_000_000_000);
    let extra_bytes = canonical_bytes(&extra).expect("bytes");
    let extra_sig = sign_bytes(&keys.private_pkcs8_der, &extra_bytes).expect("sign");
    assert!(matches!(
        CohortGrantV1::parse_signed(&extra_bytes, &extra_sig, &keys.public_raw32),
        Err(CohortRefusal::UnknownField(ref key)) if key == "startAtMacNs"
    ));

    let mut missing = value.clone();
    missing.as_object_mut().unwrap().remove("cohortAttempt");
    let missing_bytes = canonical_bytes(&missing).expect("bytes");
    let missing_sig = sign_bytes(&keys.private_pkcs8_der, &missing_bytes).expect("sign");
    assert!(matches!(
        CohortGrantV1::parse_signed(&missing_bytes, &missing_sig, &keys.public_raw32),
        Err(CohortRefusal::MissingField("cohortAttempt"))
    ));

    let duplicated = text.replacen(
        "\"cohortAttempt\":1",
        "\"cohortAttempt\":1,\"cohortId\":\"x\"",
        1,
    );
    let duplicated_bytes = duplicated.into_bytes();
    let duplicated_sig = sign_bytes(&keys.private_pkcs8_der, &duplicated_bytes).expect("sign");
    assert!(matches!(
        CohortGrantV1::parse_signed(&duplicated_bytes, &duplicated_sig, &keys.public_raw32),
        Err(CohortRefusal::DuplicateField(ref key)) if key == "cohortId"
    ));

    let mut forged = signature;
    forged[0] ^= 0x01;
    assert_eq!(
        CohortGrantV1::parse_signed(&bytes, &forged, &keys.public_raw32),
        Err(CohortRefusal::SignatureInvalid)
    );

    // A real signature from a key whose digest is not the one the record names.
    let other = generate_ed25519_keypair();
    let other_sig = sign_bytes(&other.private_pkcs8_der, &bytes).expect("sign");
    assert_eq!(
        CohortGrantV1::parse_signed(&bytes, &other_sig, &other.public_raw32),
        Err(CohortRefusal::SigningKeyMismatch)
    );

    // Oversize is charged before any allocation of the parsed record.
    let mut oversize = Vec::with_capacity(COHORT_GRANT_MAX_BYTES + 1);
    oversize.resize(COHORT_GRANT_MAX_BYTES + 1, b' ');
    assert_eq!(
        CohortGrantV1::parse_signed(&oversize, &signature, &keys.public_raw32),
        Err(CohortRefusal::Oversize)
    );
}

#[test]
fn cohort_start_barrier_rejects_pre_readiness_issue() {
    let keys = generate_ed25519_keypair();
    let key_sha256 = public_key_sha256(&keys.public_raw32);
    let grant_bytes = canonical_bytes(&grant_value(&key_sha256)).expect("grant bytes");
    let grant_sha256 = sha256_hex(&grant_bytes);

    // Honest: minted after the warmup it names completed, before measure start.
    let honest = barrier_value(&grant_sha256, 6_500_000_000, &key_sha256);
    let honest_bytes = canonical_bytes(&honest).expect("bytes");
    let honest_sig = sign_bytes(&keys.private_pkcs8_der, &honest_bytes).expect("sign");
    let barrier =
        CohortStartBarrierV1::parse_signed(&honest_bytes, &honest_sig, &keys.public_raw32)
            .expect("honest barrier parses");
    assert_eq!(barrier.cohort_grant_sha256, grant_sha256);
    assert_eq!(barrier.window_count, 10);
    assert_eq!(barrier.measured_duration_ms, 10_000);
    assert_eq!(barrier.measure_start_at_mac_ns, 7_000_000_000);
    assert_eq!(barrier.measure_stop_at_mac_ns, 17_000_000_000);

    // Pre-readiness: the barrier is stamped before the warmup completion whose
    // manifest digest it carries.  Nothing about the record is malformed; it is
    // simply not yet mintable.
    let early = barrier_value(&grant_sha256, 5_999_999_999, &key_sha256);
    let early_bytes = canonical_bytes(&early).expect("bytes");
    let early_sig = sign_bytes(&keys.private_pkcs8_der, &early_bytes).expect("sign");
    assert_eq!(
        CohortStartBarrierV1::parse_signed(&early_bytes, &early_sig, &keys.public_raw32),
        Err(CohortRefusal::NotReady("mintedAtMacNs"))
    );
    assert_eq!(
        CohortRefusal::NotReady("mintedAtMacNs").code(),
        "COHORT_NOT_READY"
    );

    // Pre-readiness in the other direction: the Linux baseline digest is absent,
    // so no authenticated `RigMeasureStartAckV1` had fixed it when this was minted.
    let mut no_baseline = barrier_value(&grant_sha256, 6_500_000_000, &key_sha256);
    no_baseline["rigMeasureStartAckSha256"] = json!("");
    let nb_bytes = canonical_bytes(&no_baseline).expect("bytes");
    let nb_sig = sign_bytes(&keys.private_pkcs8_der, &nb_bytes).expect("sign");
    assert_eq!(
        CohortStartBarrierV1::parse_signed(&nb_bytes, &nb_sig, &keys.public_raw32),
        Err(CohortRefusal::NotReady("rigMeasureStartAckSha256"))
    );

    // The measured span must be exactly `windowCount * sampleWindowMs`.
    let mut short = barrier_value(&grant_sha256, 6_500_000_000, &key_sha256);
    short["measureStopAtMacNs"] = ns(16_999_999_999);
    let short_bytes = canonical_bytes(&short).expect("bytes");
    let short_sig = sign_bytes(&keys.private_pkcs8_der, &short_bytes).expect("sign");
    assert_eq!(
        CohortStartBarrierV1::parse_signed(&short_bytes, &short_sig, &keys.public_raw32),
        Err(CohortRefusal::BindingMismatch("measureStopAtMacNs"))
    );

    // Nanoseconds from different clock domains are never compared, so an
    // `NsString` that is not the frozen shape is refused outright.
    let mut bad_ns = barrier_value(&grant_sha256, 6_500_000_000, &key_sha256);
    bad_ns["mintedAtMacNs"] = json!("06500000000");
    let bad_bytes = canonical_bytes(&bad_ns).expect("bytes");
    let bad_sig = sign_bytes(&keys.private_pkcs8_der, &bad_bytes).expect("sign");
    assert_eq!(
        CohortStartBarrierV1::parse_signed(&bad_bytes, &bad_sig, &keys.public_raw32),
        Err(CohortRefusal::SchemaInvalid)
    );
}

#[test]
fn role_token_merkle_proof_rejects_wrong_role_and_replay() {
    // Publishers first, then subscribers, each by numeric role ID.
    let mut leaves = vec![
        leaf("subscriber", "subscriber-000002", Some(2), "s2"),
        leaf("publisher", "publisher-000001", None, "p1"),
        leaf("subscriber", "subscriber-000000", Some(0), "s0"),
        leaf("publisher", "publisher-000000", None, "p0"),
        leaf("subscriber", "subscriber-000001", Some(1), "s1"),
    ];
    let ordered = ordered_leaf_nodes(&mut leaves).expect("ordered leaves");
    assert_eq!(
        leaves
            .iter()
            .map(|l| l.role_id.as_str())
            .collect::<Vec<_>>(),
        vec![
            "publisher-000000",
            "publisher-000001",
            "subscriber-000000",
            "subscriber-000001",
            "subscriber-000002",
        ]
    );

    // Leaf node is SHA256(0x00 || leafSha256); internal is SHA256(0x01 || l || r).
    let publisher_leaf_bytes = canonical_bytes(&leaves[0].to_value()).expect("leaf bytes");
    let mut expected = Vec::with_capacity(33);
    expected.push(0x00);
    expected.extend_from_slice(&hex_to_32(&sha256_hex(&publisher_leaf_bytes)));
    assert_eq!(ordered[0], sha256_bytes(&expected));

    let root = merkle_root(&ordered).expect("root");
    let root_hex = hex32(&root);

    // Five leaves: the odd last node is paired with itself, so the tree is
    // three levels deep and every proof has exactly three siblings.
    for (index, committed) in leaves.iter().enumerate() {
        let proof = merkle_proof(&ordered, index).expect("proof");
        assert_eq!(proof.len(), 3);
        let leaf_sha256 = sha256_hex(&canonical_bytes(&committed.to_value()).expect("bytes"));
        verify_merkle_proof(
            &leaf_sha256,
            index,
            ordered.len(),
            &proof.iter().map(hex32).collect::<Vec<_>>(),
            &root_hex,
        )
        .expect("honest proof verifies");
    }

    let mut table = TokenSpendTable::new(&root_hex, ordered.len());

    // A real leaf presented at another leaf's index does not reach the root.
    let publisher_sha256 = sha256_hex(&canonical_bytes(&leaves[0].to_value()).expect("bytes"));
    let proof_for_two = merkle_proof(&ordered, 2)
        .expect("proof")
        .iter()
        .map(hex32)
        .collect::<Vec<_>>();
    assert_eq!(
        verify_merkle_proof(
            &publisher_sha256,
            2,
            ordered.len(),
            &proof_for_two,
            &root_hex
        ),
        Err(CohortRefusal::TokenProofInvalid)
    );

    // A leaf whose `role` was rewritten hashes to something outside the tree,
    // and the shard/role fields are checked against the presented registration.
    let mut wrong_role = leaves[2].clone();
    wrong_role.role = "publisher".to_owned();
    let wrong_sha256 = sha256_hex(&canonical_bytes(&wrong_role.to_value()).expect("bytes"));
    let proof_two = merkle_proof(&ordered, 2)
        .expect("proof")
        .iter()
        .map(hex32)
        .collect::<Vec<_>>();
    assert_eq!(
        verify_merkle_proof(&wrong_sha256, 2, ordered.len(), &proof_two, &root_hex),
        Err(CohortRefusal::TokenProofInvalid)
    );
    assert_eq!(
        table.admit(&leaves[2], 2, &proof_two, "subscriber", Some(1)),
        Err(CohortRefusal::WrongShard)
    );
    assert_eq!(
        table.admit(&leaves[2], 2, &proof_two, "publisher", Some(0)),
        Err(CohortRefusal::WrongRole)
    );

    // The honest registration is admitted once and once only.
    table
        .admit(&leaves[2], 2, &proof_two, "subscriber", Some(0))
        .expect("first spend");
    assert_eq!(
        table.admit(&leaves[2], 2, &proof_two, "subscriber", Some(0)),
        Err(CohortRefusal::TokenReplay)
    );
    assert_eq!(CohortRefusal::TokenReplay.code(), "COHORT_PROTOCOL");

    // An out-of-range index is refused before any hashing happens.
    assert_eq!(
        table.admit(&leaves[2], ordered.len(), &proof_two, "subscriber", Some(0)),
        Err(CohortRefusal::TokenProofInvalid)
    );
}

#[test]
fn token_bundle_read_only_unlinked_fd_obeys_cap() {
    assert_eq!(TOKEN_BUNDLE_MAX_SIZE, 2_097_152);
    // 1250 entries * 1536 bytes + 4096 envelope, the frozen chat-10k ceiling.
    assert_eq!(chat_10k_token_bundle_ceiling(), 1_924_096);
    assert!(chat_10k_token_bundle_ceiling() < TOKEN_BUNDLE_MAX_SIZE);
    assert_eq!(
        TOKEN_BUNDLE_MAX_SIZE - chat_10k_token_bundle_ceiling(),
        173_056
    );

    let dir = temp_dir("token-bundle");
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
            "tokenCommitmentIndex": 0,
            "tokenMerkleProofSha256": [digest("sib-0"), digest("sib-1")],
        }],
    });
    let bundle_bytes = canonical_bytes(&bundle).expect("bundle bytes");

    let leaf_path = dir.join("worker-0.token-bundle");
    let (fd, metadata) =
        publish_token_bundle_fd(leaf_path.to_str().expect("path"), &bundle_bytes).expect("publish");
    assert_eq!(metadata.size, bundle_bytes.len() as u64);
    assert_eq!(metadata.sha256, sha256_hex(&bundle_bytes));
    assert_eq!(metadata.entry_count, 1);
    // The supervisor retains digest/size/entry count and destroys the pathname.
    assert!(!leaf_path.exists());

    let read_back = read_token_bundle_fd(fd, &metadata).expect("child reads the inherited FD");
    assert_eq!(read_back, bundle_bytes);

    // A second read of the same descriptor is not a second bundle: the child
    // reads once, and the reader refuses to serve a spent descriptor.
    assert_eq!(
        read_token_bundle_fd(fd, &metadata),
        Err(CohortRefusal::TokenBundleFdInvalid)
    );
    unsafe { libc::close(fd) };

    // A declared size that disagrees with the descriptor fails before the read.
    let (fd2, metadata2) = publish_token_bundle_fd(
        dir.join("worker-1.token-bundle").to_str().expect("path"),
        &bundle_bytes,
    )
    .expect("publish");
    let swapped = TokenBundleMetadata {
        sha256: digest("some-other-bundle"),
        ..metadata2.clone()
    };
    assert_eq!(
        read_token_bundle_fd(fd2, &swapped),
        Err(CohortRefusal::TokenBundleDigestMismatch)
    );
    unsafe { libc::close(fd2) };

    // A writable, still-linked descriptor is never a token bundle.
    let writable_path = dir.join("writable.token-bundle");
    fs::write(&writable_path, &bundle_bytes).expect("write");
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(&writable_path)
        .expect("open");
    let writable_fd = std::os::unix::io::AsRawFd::as_raw_fd(&file);
    assert_eq!(
        read_token_bundle_fd(writable_fd, &metadata),
        Err(CohortRefusal::TokenBundleFdInvalid)
    );

    // Cap+1 is refused before the file is created, so no oversize allocation
    // and no leaf on disk.
    let oversize = vec![b'x'; TOKEN_BUNDLE_MAX_SIZE + 1];
    let oversize_path = dir.join("oversize.token-bundle");
    assert_eq!(
        publish_token_bundle_fd(oversize_path.to_str().expect("path"), &oversize),
        Err(CohortRefusal::Oversize)
    );
    assert!(!oversize_path.exists());

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn linux_relay_observation_rejects_origin_and_capacity_mismatch() {
    let subscriber_count = 4u64;
    let window_count = 2usize;
    let honest = json!({
        "schema": "linux-relay-observation/v1",
        "executionSha256": digest("execution"),
        "cohortGrantSha256": digest("grant"),
        "cohortStartBarrierSha256": digest("barrier"),
        "roleTokenCommitmentRootSha256": digest("commitment-root"),
        "serverChildPid": 4242,
        "serverChildPgid": 4242,
        "serverChildInstanceNonce": digest("server-instance"),
        "linuxClockId": "clock-monotonic-boot-b",
        "windowCount": 2,
        "registeredPublisherIds": ["publisher-000000"],
        "registeredSubscriberIdsSha256": digest("subscriber-ids"),
        "registeredPublisherCount": 1,
        "registeredSubscriberCount": 4,
        "acceptedIngressByOriginWindow": [10, 10],
        "acceptedIngressBytesByOriginWindow": [1000, 1000],
        "relayWritesCompletedByOriginWindow": [40, 40],
        "relayWriteBytesByOriginWindow": [4000, 4000],
        "duplicateIngressByOriginWindow": [0, 0],
        "reorderedIngressByOriginWindow": [0, 0],
        "queueDropDeliveriesByOriginWindow": [0, 0],
        "writeTimeoutDeliveriesByOriginWindow": [0, 0],
        "disconnectUndeliveredByOriginWindow": [0, 0],
        "malformedIngressByOriginWindow": [0, 0],
        "publisherEndCount": 1,
        "subscriberEndCount": 4,
        "sessionsAccepted": 5,
        "sessionsActivePeak": 5,
        "publisherSessionsActivePeak": 1,
        "subscriberSessionsActivePeak": 4,
        "queueItemsPeak": 8,
        "queueBytesPeak": 800,
        "concurrentWritesPeak": 4,
        "measurementStartedAtLinuxNs": ns(1_000),
        "relayDrainedAtLinuxNs": ns(2_000),
        "allSessionsClosedAtLinuxNs": ns(3_000),
        "allSessionsClosed": true,
    });
    let bytes = canonical_bytes(&honest).expect("bytes");
    let observation = LinuxRelayObservationV1::parse(&bytes, subscriber_count).expect("honest");
    assert_eq!(observation.window_count, window_count);
    assert_eq!(observation.windows.accepted_ingress, vec![10, 10]);
    assert_eq!(observation.windows.relay_writes_completed, vec![40, 40]);

    // Origin mismatch: accepted * subscriberCount no longer equals completed
    // writes plus the three undelivered counters, so a delivery went missing
    // without any counter admitting it.
    let mut origin = honest.clone();
    origin["relayWritesCompletedByOriginWindow"] = json!([39, 40]);
    let origin_bytes = canonical_bytes(&origin).expect("bytes");
    assert_eq!(
        LinuxRelayObservationV1::parse(&origin_bytes, subscriber_count),
        Err(CohortRefusal::RelayDelivery(
            "relayWritesCompletedByOriginWindow"
        ))
    );

    // The same shortfall, but honestly attributed, is a parsable observation.
    let mut attributed = honest.clone();
    attributed["relayWritesCompletedByOriginWindow"] = json!([39, 40]);
    attributed["queueDropDeliveriesByOriginWindow"] = json!([1, 0]);
    let attributed_bytes = canonical_bytes(&attributed).expect("bytes");
    LinuxRelayObservationV1::parse(&attributed_bytes, subscriber_count)
        .expect("an attributed drop is recordable, if unpromotable");

    // Capacity mismatch: the separate peaks no longer sum to the total.
    let mut capacity = honest.clone();
    capacity["subscriberSessionsActivePeak"] = json!(3);
    let capacity_bytes = canonical_bytes(&capacity).expect("bytes");
    assert_eq!(
        LinuxRelayObservationV1::parse(&capacity_bytes, subscriber_count),
        Err(CohortRefusal::BindingMismatch(
            "subscriberSessionsActivePeak"
        ))
    );

    // A registered count that disagrees with the ID array it summarises.
    let mut counted = honest.clone();
    counted["registeredPublisherCount"] = json!(2);
    let counted_bytes = canonical_bytes(&counted).expect("bytes");
    assert_eq!(
        LinuxRelayObservationV1::parse(&counted_bytes, subscriber_count),
        Err(CohortRefusal::BindingMismatch("registeredPublisherCount"))
    );

    // Every window array carries exactly `windowCount` entries.
    let mut ragged = honest.clone();
    ragged["queueDropDeliveriesByOriginWindow"] = json!([0, 0, 0]);
    let ragged_bytes = canonical_bytes(&ragged).expect("bytes");
    assert_eq!(
        LinuxRelayObservationV1::parse(&ragged_bytes, subscriber_count),
        Err(CohortRefusal::SchemaInvalid)
    );
}

#[test]
fn cohort_partial_manifest_rejects_duplicate_and_oversize() {
    let mut entries = vec![json!({
        "schema": "ordered-partial-manifest-entry/v1",
        "order": 0,
        "partialKind": "publisher",
        "childId": "publisher-000000",
        "partialSha256": digest("publisher-partial-0"),
        "partialSize": 4096,
    })];
    for worker_index in 0..8 {
        entries.push(json!({
            "schema": "ordered-partial-manifest-entry/v1",
            "order": worker_index + 1,
            "partialKind": "worker",
            "childId": format!("worker-{worker_index}"),
            "partialSha256": digest(&format!("worker-partial-{worker_index}")),
            "partialSize": 8192,
        }));
    }
    let build = |entries: &Vec<Value>, total: u64| -> Value {
        json!({
            "schema": "ordered-partial-manifest/v1",
            "executionSha256": digest("execution"),
            "cohortGrantSha256": digest("grant"),
            "cohortStartBarrierSha256": digest("barrier"),
            "publisherPartialCount": 1,
            "workerPartialCount": 8,
            "totalPartialBytes": total,
            "entries": entries,
            "orderedDigestSetSha256": secure_fs::cohort::ordered_digest_set_sha256(entries)
                .unwrap_or_else(|_| digest("unset")),
        })
    };

    let honest = build(&entries, 4096 + 8 * 8192);
    let bytes = canonical_bytes(&honest).expect("bytes");
    assert!(bytes.len() <= ORDERED_PARTIAL_MANIFEST_MAX_BYTES);
    let manifest = OrderedPartialManifestV1::parse(&bytes).expect("honest manifest");
    assert_eq!(manifest.entries.len(), 9);
    assert_eq!(manifest.total_partial_bytes, 4096 + 8 * 8192);

    // Duplicate child: two entries name the same partial producer.
    let mut duplicate_entries = entries.clone();
    duplicate_entries[2] = json!({
        "schema": "ordered-partial-manifest-entry/v1",
        "order": 2,
        "partialKind": "worker",
        "childId": "worker-0",
        "partialSha256": digest("worker-partial-0"),
        "partialSize": 8192,
    });
    let duplicate = build(&duplicate_entries, 4096 + 8 * 8192);
    let duplicate_bytes = canonical_bytes(&duplicate).expect("bytes");
    assert!(matches!(
        OrderedPartialManifestV1::parse(&duplicate_bytes),
        Err(CohortRefusal::Duplicate(ref key)) if key == "worker-0"
    ));

    // Oversize partial: a worker partial above its own 256 KiB item cap.
    let mut oversize_entries = entries.clone();
    oversize_entries[1]["partialSize"] = json!(WORKER_PARTIAL_MAX_BYTES + 1);
    let oversize = build(
        &oversize_entries,
        4096 + 7 * 8192 + WORKER_PARTIAL_MAX_BYTES as u64 + 1,
    );
    let oversize_bytes = canonical_bytes(&oversize).expect("bytes");
    assert_eq!(
        OrderedPartialManifestV1::parse(&oversize_bytes),
        Err(CohortRefusal::Oversize)
    );

    // The publisher item cap is charged separately from the worker one.
    let mut publisher_oversize = entries.clone();
    publisher_oversize[0]["partialSize"] = json!(PUBLISHER_PARTIAL_MAX_BYTES + 1);
    let publisher_over = build(
        &publisher_oversize,
        PUBLISHER_PARTIAL_MAX_BYTES as u64 + 1 + 8 * 8192,
    );
    let publisher_bytes = canonical_bytes(&publisher_over).expect("bytes");
    assert_eq!(
        OrderedPartialManifestV1::parse(&publisher_bytes),
        Err(CohortRefusal::Oversize)
    );

    // Publishers ascending, then workers 0..7: a reordered manifest fails.
    let mut reordered = entries.clone();
    reordered.swap(1, 2);
    reordered[1]["order"] = json!(1);
    reordered[2]["order"] = json!(2);
    let reordered_manifest = build(&reordered, 4096 + 8 * 8192);
    let reordered_bytes = canonical_bytes(&reordered_manifest).expect("bytes");
    assert_eq!(
        OrderedPartialManifestV1::parse(&reordered_bytes),
        Err(CohortRefusal::SchemaInvalid)
    );

    // A rewritten total no longer equals the checked sum of the sizes.
    let rewritten = build(&entries, 4096 + 8 * 8192 - 1);
    let rewritten_bytes = canonical_bytes(&rewritten).expect("bytes");
    assert_eq!(
        OrderedPartialManifestV1::parse(&rewritten_bytes),
        Err(CohortRefusal::BindingMismatch("totalPartialBytes"))
    );

    // A record above the manifest's own decoded cap never reaches the parser.
    let padded = vec![b' '; ORDERED_PARTIAL_MANIFEST_MAX_BYTES + 1];
    assert_eq!(
        OrderedPartialManifestV1::parse(&padded),
        Err(CohortRefusal::Oversize)
    );
}

#[test]
fn cohort_equations_reject_overflow_rewrite_and_event_window_conflation() {
    let subscriber_count = 4u64;
    let message_bytes = 100u64;
    let window_count = 2usize;
    let measured_duration_ms = 10_000u64;

    // Honest cell: 10 origin-window accepts per window, fully delivered.
    // The boundary case is deliberate — one delivery whose origin window is 0
    // lands, 1 ns after the boundary, in event window 1.
    let publisher = PublisherWindowsV1 {
        offered: vec![10, 10],
        offered_bytes: vec![1_000, 1_000],
        accepted_ack_seen: vec![10, 10],
        duplicate_ack_seen: vec![0, 0],
        reordered_ack_seen: vec![0, 0],
    };
    let linux = LinuxWindowsV1 {
        accepted_ingress: vec![10, 10],
        accepted_ingress_bytes: vec![1_000, 1_000],
        relay_writes_completed: vec![40, 40],
        relay_write_bytes: vec![4_000, 4_000],
        duplicate_ingress: vec![0, 0],
        reordered_ingress: vec![0, 0],
        queue_drop_deliveries: vec![0, 0],
        write_timeout_deliveries: vec![0, 0],
        disconnect_undelivered: vec![0, 0],
        malformed_ingress: vec![0, 0],
    };
    // Origin windows carry 40 + 40; the event windows carry 39 + 41 because
    // one delivery crossed the boundary.  Both are honest, and they are not
    // the same observation.
    let worker = WorkerWindowsV1 {
        delivered_by_origin: vec![40, 40],
        delivered_bytes_by_origin: vec![4_000, 4_000],
        delivered_by_event: vec![39, 41],
        delivered_bytes_by_event: vec![3_900, 4_100],
        delivered_after_measure_stop: 0,
        delivered_bytes_after_measure_stop: 0,
    };

    let conservation = recompute_conservation(
        std::slice::from_ref(&publisher),
        &linux,
        std::slice::from_ref(&worker),
        subscriber_count,
        message_bytes,
        window_count,
        measured_duration_ms,
    )
    .expect("honest conservation");
    assert_eq!(conservation.offered_ingress, 20);
    assert_eq!(conservation.server_accepted_ingress, 20);
    assert_eq!(conservation.offered_expanded_deliveries, 80);
    assert_eq!(conservation.server_accepted_expanded_deliveries, 80);
    assert_eq!(conservation.linux_relay_writes_completed, 80);
    assert_eq!(conservation.delivered, 80);
    assert_eq!(conservation.delivered_bytes, 8_000);
    assert_eq!(conservation.samples, vec![39, 41]);
    assert_eq!(conservation.measured_window_delivered_total, 80);
    assert_eq!(conservation.post_stop_drain_delivered, 0);
    assert_eq!(conservation.conservation_delivered_total, 80);
    assert_eq!(conservation.mean_numerator, 80_000);
    assert_eq!(conservation.mean_denominator_ms, 10_000);
    // Boundary latency moved the rate event, not the origin conservation.
    assert_ne!(conservation.samples, conservation.delivered_by_origin);

    let honest_ledger = ClaimedLedger {
        offered_ingress: 20,
        server_accepted_ingress: 20,
        offered_expanded_deliveries: 80,
        server_accepted_expanded_deliveries: 80,
        linux_relay_writes_completed: 80,
        delivered: 80,
        delivered_bytes: 8_000,
        message_bytes,
    };
    let honest_series = ClaimedRateSeries {
        samples: vec![39, 41],
        measured_window_delivered_total: 80,
        post_stop_drain_delivered: 0,
        conservation_delivered_total: 80,
        measured_duration_ms,
        mean_numerator: 80_000,
        mean_denominator_ms: measured_duration_ms,
    };
    conservation
        .verify_claims(&honest_ledger, &honest_series)
        .expect("honest claims match the recomputation");

    // Rewrite: the producer's ledger claims a delivery the partial bytes do
    // not carry.
    let rewritten = ClaimedLedger {
        delivered: 81,
        ..honest_ledger.clone()
    };
    assert_eq!(
        conservation.verify_claims(&rewritten, &honest_series),
        Err(CohortRefusal::BindingMismatch("delivered"))
    );

    // Post-stop drain is a separate figure and is never folded back into the
    // measured samples.  Origin conservation is unchanged — the delivery
    // happened, and its origin window never moves — but one of the eighty
    // deliveries landed after `measureStopAtMacNs`, so it is excluded from the
    // rate samples and recorded on its own.
    let drained_worker = WorkerWindowsV1 {
        delivered_by_origin: vec![40, 40],
        delivered_bytes_by_origin: vec![4_000, 4_000],
        delivered_by_event: vec![39, 40],
        delivered_bytes_by_event: vec![3_900, 4_000],
        delivered_after_measure_stop: 1,
        delivered_bytes_after_measure_stop: 100,
    };
    let drained = recompute_conservation(
        std::slice::from_ref(&publisher),
        &linux,
        &[drained_worker],
        subscriber_count,
        message_bytes,
        window_count,
        measured_duration_ms,
    )
    .expect("a drained cell still conserves");
    assert_eq!(drained.conservation_delivered_total, 80);
    assert_eq!(drained.measured_window_delivered_total, 79);
    assert_eq!(drained.post_stop_drain_delivered, 1);
    assert_eq!(drained.samples, vec![39, 40]);
    assert!(!drained.promotable());

    // Conflation: the same worker relabels its origin windows as event
    // windows, so the drained delivery is silently counted as a measured one
    // and the measured total absorbs traffic that arrived after stop.
    let conflated_worker = WorkerWindowsV1 {
        delivered_by_origin: vec![40, 40],
        delivered_bytes_by_origin: vec![4_000, 4_000],
        delivered_by_event: vec![40, 40],
        delivered_bytes_by_event: vec![4_000, 4_000],
        delivered_after_measure_stop: 1,
        delivered_bytes_after_measure_stop: 100,
    };
    assert_eq!(
        recompute_conservation(
            std::slice::from_ref(&publisher),
            &linux,
            &[conflated_worker],
            subscriber_count,
            message_bytes,
            window_count,
            measured_duration_ms,
        ),
        Err(CohortRefusal::WindowConflation)
    );

    // Overflow: two workers each near u64::MAX cannot be summed, and the
    // refusal is arithmetic rather than a wrapped total.
    let huge = WorkerWindowsV1 {
        delivered_by_origin: vec![u64::MAX - 1, 0],
        delivered_bytes_by_origin: vec![0, 0],
        delivered_by_event: vec![0, 0],
        delivered_bytes_by_event: vec![0, 0],
        delivered_after_measure_stop: 0,
        delivered_bytes_after_measure_stop: 0,
    };
    assert_eq!(
        recompute_conservation(
            std::slice::from_ref(&publisher),
            &linux,
            &[huge.clone(), huge],
            subscriber_count,
            message_bytes,
            window_count,
            measured_duration_ms,
        ),
        Err(CohortRefusal::Overflow)
    );

    // A total that fits in u64 but is above `Number.MAX_SAFE_INTEGER` is
    // refused before it could be emitted as JSON.
    let unsafe_total = WorkerWindowsV1 {
        delivered_by_origin: vec![MAX_SAFE_INTEGER + 1, 0],
        delivered_bytes_by_origin: vec![0, 0],
        delivered_by_event: vec![0, 0],
        delivered_bytes_by_event: vec![0, 0],
        delivered_after_measure_stop: 0,
        delivered_bytes_after_measure_stop: 0,
    };
    assert_eq!(
        recompute_conservation(
            &[publisher],
            &linux,
            &[unsafe_total],
            subscriber_count,
            message_bytes,
            window_count,
            measured_duration_ms,
        ),
        Err(CohortRefusal::Overflow)
    );
    assert_eq!(CohortRefusal::Overflow.code(), "COHORT_PROTOCOL");
    assert_eq!(CohortRefusal::WindowConflation.code(), "MEASUREMENT_WINDOW");
}

// --- small local helpers ----------------------------------------------------

fn sha256_bytes(bytes: &[u8]) -> [u8; 32] {
    hex_to_32(&sha256_hex(bytes))
}

fn hex_to_32(hex: &str) -> [u8; 32] {
    let mut out = [0u8; 32];
    for (index, slot) in out.iter_mut().enumerate() {
        *slot = u8::from_str_radix(&hex[index * 2..index * 2 + 2], 16).expect("hex");
    }
    out
}

fn hex32(bytes: &[u8; 32]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
