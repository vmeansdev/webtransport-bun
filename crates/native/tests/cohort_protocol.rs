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

use secure_fs::cohort::shard_commitment_window_end;
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
use secure_fs::cross_supervisor::{
    generate_ed25519_keypair, public_key_sha256, public_raw32_from_pkcs8_der, sign_bytes,
};
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
            // The publisher holds commitment index 0; residue `w` starts at
            // `1 + w` and spans its class, `first + (count - 1) * 8 + 1`.
            "firstTokenCommitmentIndex": 1 + worker_index,
            "lastTokenCommitmentIndexExclusive": shard_commitment_window_end(1 + worker_index, count)
                .expect("window"),
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

// ---------------------------------------------------------------------------
// The cross-language §4.1 grant vector
// ---------------------------------------------------------------------------

/// The canonical bytes of one `cohort-grant/v1` at the ticker 10k shape:
/// 1 publisher, 8 shards, 100 subscribers.
///
/// `tools/compare/cohort-protocol.test.ts` holds this same literal and asserts
/// `parseCohortGrant` accepts it and re-encodes to the identical bytes, so
/// neither language's §4.1 codec can move alone. Two readings are pinned:
/// `lastSubscriberIndexExclusive` is `100` on all eight shards -- the grant's
/// subscriber total -- while `subscriberCount` is 13 on residues 0..3 and 12
/// on residues 4..7, so a codec that read the field as the shard's own count
/// would refuse these exact bytes; and every commitment window is the span of
/// the shard's residue class (`first = 1 + w`, `last = first + (count - 1) * 8
/// + 1`: `[1, 98)` … `[4, 101)`, `[5, 94)` … `[8, 97)`), so a codec that still
/// expected the dense `first + count` would refuse them too.  Re-pinned
/// 2026-09-05 (ruling R-A) from the dense `[1, 14)`, `[14, 27)`, … layout no
/// producer's leaves satisfy.
const RUST_PINNED_TICKER10K_GRANT_HEX: &str = "7b22617070726f76616c5265636f7264536861323536223a2266666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666222c22617070726f766564506c616e536861323536223a2265656565656565656565656565656565656565656565656565656565656565656565656565656565656565656565656565656565656565656565656565656565222c22636f686f7274417474656d7074223a312c22636f686f72744964223a22636f686f72742d7469636b65722d31306b222c22636f6e6e656374696f6e526174655065725365636f6e64223a3530302c22647261696e446561646c696e654d73223a31303030302c22657865637574696f6e223a7b22617070726f76616c5265636f7264536861323536223a2266666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666222c22617070726f766564506c616e536861323536223a2265656565656565656565656565656565656565656565656565656565656565656565656565656565656565656565656565656565656565656565656565656565222c2261726d4b696e64223a227072696d617279222c22617574686f72697479536861323536223a2261616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161222c2263616d706169676e4964223a2263616d70222c2263616d706169676e4c6f636b536861323536223a2262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262222c2263616e646964617465223a2263616e64222c2263656c6c4964223a227469636b65722d66616e6f75742f726174652d3130303030222c226465636c617265644d6573736167654279746573223a3130302c226465636c617265644d657373616765436f756e74223a31303030303030302c226472616674536861323536223a2239356334656361363766633931356634373861363461356332663264666665323431343736396236666462306437633236393539303130643832336436306639222c22657865637574696f6e496e646578223a302c22657865637574696f6e507572706f7365223a22666f6375736564222c226772616e744465636c61726174696f6e223a2266616e6f75742d657870616e6465642d64656c69766572696573222c2269737375656441744d73223a313030302c226d616353757065727669736f72496e7374616e63654e6f6e6365223a2235353535353535353535353535353535353535353535353535353535353535353535353535353535353535353535353535353535353535353535353535353535222c226d6561737572656d656e744772616e74536861323536223a2234353037613832366366303139326434356664626164383038396130326533323137363730316537646234646435333563313136366362363161343666316335222c226e6f7441667465724d73223a323030302c2272657065746974696f6e496e646578223a312c2272657065746974696f6e4b696e64223a226d65617375726564222c2272657065746974696f6e546f74616c223a312c22726f6c65506c616e48617368223a2232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232222c2272756e4964223a2263616d702f7469636b65722d66616e6f75742d31306b2f77732f6d656173757265642d31222c227363656e6172696f48617368223a2231313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131222c22736368656d61223a2263726f73732d73757065727669736f722d657865637574696f6e2f7631222c22736f7572636541726368697665536861323536223a2264646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464222c227374616765644361706162696c697479536861323536223a2263636363636363636363636363636363636363636363636363636363636363636363636363636363636363636363636363636363636363636363636363636363222c227374616765645365727665724c61756e63685265636f7264536861323536223a2234343434343434343434343434343434343434343434343434343434343434343434343434343434343434343434343434343434343434343434343434343434222c227472616e73706f7274223a227773222c22776f726b6c6f6164526f6c65506c616e496e707574536861323536223a2233333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333227d2c22657865637574696f6e536861323536223a2261316638366665353331316638333536306135626530326237343134313861623264346232336366363830653539353261333434663565353033633834396230222c226578706563746564457870616e64656444656c69766572696573223a31303030303030302c2265787065637465644f666665726564496e6772657373223a3130303030302c22657870656374656450726f63657373436f756e74223a392c22657870656374656453657373696f6e436f756e74223a3130312c22696e52657065746974696f6e5761726d75704d73223a353030302c2269737375656441744d73223a313030302c226d6163457865637574696f6e4772616e7452656365697074536861323536223a2237373737373737373737373737373737373737373737373737373737373737373737373737373737373737373737373737373737373737373737373737373737222c226d616353757065727669736f72496e7374616e63654e6f6e6365223a2235353535353535353535353535353535353535353535353535353535353535353535353535353535353535353535353535353535353535353535353535353535222c226d6178436f6e6e656374696f6e73496e466c69676874223a3230302c226d656173757265644475726174696f6e4d73223a31303030302c226d6573736167654279746573223a3130302c226e6f7441667465724d73223a323030302c227075626c6973686572436f756e74223a312c227075626c697368657273223a5b7b226368696c644964223a227075626c69736865722d303030303030222c227075626c69736865724964223a227075626c69736865722d303030303030222c22736368656d61223a227075626c69736865722d726f6c652d6772616e742f7631222c22746f6b656e436f6d6d69746d656e74496e646578223a302c22746f6b656e536861323536223a2231323137643862613839393330343932343337313034653134313033393366623261393135633738373938383036633930343965623765653765363263313236227d5d2c2272656164696e657373446561646c696e654d73223a33303030302c227265636569707453657175656e6365223a312c22726f6c65506c616e48617368223a2232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232222c22726f6c65546f6b656e436f6d6d69746d656e74436f756e74223a3130312c22726f6c65546f6b656e436f6d6d69746d656e74526f6f74536861323536223a2231663431633739343964323963383361626261303435633430373530363539616361616636363765653266336337326339356432623463356631396430623562222c2273616d706c6557696e646f774d73223a313030302c227363656e6172696f48617368223a2231313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131222c22736368656d61223a22636f686f72742d6772616e742f7631222c227369676e696e675075626c69634b6579536861323536223a2262303964343438346239393966666530636362613131666639613639393539333864633562323066323762356564636133376632356563373264353839626232222c2273756273637269626572436f756e74223a3130302c2273756273637269626572536861726473223a5b7b226368696c644964223a22737562736372696265722d776f726b65722d30222c22666972737453756273637269626572496e646578223a302c226669727374546f6b656e436f6d6d69746d656e74496e646578223a312c226c61737453756273637269626572496e6465784578636c7573697665223a3130302c226c617374546f6b656e436f6d6d69746d656e74496e6465784578636c7573697665223a39382c226d6f64756c7573223a382c226f72646572656453756273637269626572496473536861323536223a2262343833646334633264663965343065353833383465643236646439626439306637373539333762393839663330663435656535323433633663313035653364222c2272657369647565223a302c22736368656d61223a22737562736372696265722d73686172642f7631222c2273756273637269626572436f756e74223a31332c22776f726b6572496e646578223a307d2c7b226368696c644964223a22737562736372696265722d776f726b65722d31222c22666972737453756273637269626572496e646578223a302c226669727374546f6b656e436f6d6d69746d656e74496e646578223a322c226c61737453756273637269626572496e6465784578636c7573697665223a3130302c226c617374546f6b656e436f6d6d69746d656e74496e6465784578636c7573697665223a39392c226d6f64756c7573223a382c226f72646572656453756273637269626572496473536861323536223a2264343763396461646633636165646439636262656265346132343233623161633062303165323935383064323130393861363166346665303139343964373365222c2272657369647565223a312c22736368656d61223a22737562736372696265722d73686172642f7631222c2273756273637269626572436f756e74223a31332c22776f726b6572496e646578223a317d2c7b226368696c644964223a22737562736372696265722d776f726b65722d32222c22666972737453756273637269626572496e646578223a302c226669727374546f6b656e436f6d6d69746d656e74496e646578223a332c226c61737453756273637269626572496e6465784578636c7573697665223a3130302c226c617374546f6b656e436f6d6d69746d656e74496e6465784578636c7573697665223a3130302c226d6f64756c7573223a382c226f72646572656453756273637269626572496473536861323536223a2234353738623831653538313232303830643766376435643237633933643536666135626237636666393864356532656561393035356134663933316432646435222c2272657369647565223a322c22736368656d61223a22737562736372696265722d73686172642f7631222c2273756273637269626572436f756e74223a31332c22776f726b6572496e646578223a327d2c7b226368696c644964223a22737562736372696265722d776f726b65722d33222c22666972737453756273637269626572496e646578223a302c226669727374546f6b656e436f6d6d69746d656e74496e646578223a342c226c61737453756273637269626572496e6465784578636c7573697665223a3130302c226c617374546f6b656e436f6d6d69746d656e74496e6465784578636c7573697665223a3130312c226d6f64756c7573223a382c226f72646572656453756273637269626572496473536861323536223a2233646237626662613461386337316266323063333739623738363266393438656430633038343432373663363935636537376334356534356433613563366364222c2272657369647565223a332c22736368656d61223a22737562736372696265722d73686172642f7631222c2273756273637269626572436f756e74223a31332c22776f726b6572496e646578223a337d2c7b226368696c644964223a22737562736372696265722d776f726b65722d34222c22666972737453756273637269626572496e646578223a302c226669727374546f6b656e436f6d6d69746d656e74496e646578223a352c226c61737453756273637269626572496e6465784578636c7573697665223a3130302c226c617374546f6b656e436f6d6d69746d656e74496e6465784578636c7573697665223a39342c226d6f64756c7573223a382c226f72646572656453756273637269626572496473536861323536223a2239346332306562653561616132326633613134656339396430366238376136666136656136343935393237383166303932313035386632646662393038666366222c2272657369647565223a342c22736368656d61223a22737562736372696265722d73686172642f7631222c2273756273637269626572436f756e74223a31322c22776f726b6572496e646578223a347d2c7b226368696c644964223a22737562736372696265722d776f726b65722d35222c22666972737453756273637269626572496e646578223a302c226669727374546f6b656e436f6d6d69746d656e74496e646578223a362c226c61737453756273637269626572496e6465784578636c7573697665223a3130302c226c617374546f6b656e436f6d6d69746d656e74496e6465784578636c7573697665223a39352c226d6f64756c7573223a382c226f72646572656453756273637269626572496473536861323536223a2239356536386162326238393239653430303966393934643136356462633338316465313739313661656130343435313665626638623930363830633334633931222c2272657369647565223a352c22736368656d61223a22737562736372696265722d73686172642f7631222c2273756273637269626572436f756e74223a31322c22776f726b6572496e646578223a357d2c7b226368696c644964223a22737562736372696265722d776f726b65722d36222c22666972737453756273637269626572496e646578223a302c226669727374546f6b656e436f6d6d69746d656e74496e646578223a372c226c61737453756273637269626572496e6465784578636c7573697665223a3130302c226c617374546f6b656e436f6d6d69746d656e74496e6465784578636c7573697665223a39362c226d6f64756c7573223a382c226f72646572656453756273637269626572496473536861323536223a2266313532303330646633626662366236386437333161343163396330396665383630643631333531336631383630356431343632383734376137353763363739222c2272657369647565223a362c22736368656d61223a22737562736372696265722d73686172642f7631222c2273756273637269626572436f756e74223a31322c22776f726b6572496e646578223a367d2c7b226368696c644964223a22737562736372696265722d776f726b65722d37222c22666972737453756273637269626572496e646578223a302c226669727374546f6b656e436f6d6d69746d656e74496e646578223a382c226c61737453756273637269626572496e6465784578636c7573697665223a3130302c226c617374546f6b656e436f6d6d69746d656e74496e6465784578636c7573697665223a39372c226d6f64756c7573223a382c226f72646572656453756273637269626572496473536861323536223a2236613830633262313761666562663861343634343063323964303862653666626261313936653562633134636437613466363838356232616133633130326561222c2272657369647565223a372c22736368656d61223a22737562736372696265722d73686172642f7631222c2273756273637269626572436f756e74223a31322c22776f726b6572496e646578223a377d5d2c22746f6b656e436f6d6d69746d656e744c6561664d616e6966657374536861323536223a2266373062313031613033343739663430306364343630613963633733343932306162636234623233383234633835653430303865316461393733306433393965222c227472616e73706f7274223a227773222c22776f726b6572436f756e74223a382c22776f726b6c6f6164526f6c65506c616e496e707574536861323536223a2233333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333227d0a";

/// The PKCS#8 Ed25519 private key the pinned vector's `signingPublicKeySha256`
/// names. A fixture key, generated once and written down: the vector is a
/// fixed byte string, and `parse_signed` refuses bytes whose named key digest
/// is not the staged key's, so a freshly generated key cannot verify it.
const PINNED_VECTOR_SIGNING_KEY_PKCS8_DER_HEX: &str = "302e020100300506032b657004220420f31c315b4e07d52efd1157654799cfc099c39d699507762149a10cbfb06b3f26";

fn hex_to_bytes(hex: &str) -> Vec<u8> {
    assert_eq!(hex.len() % 2, 0, "hex length");
    (0..hex.len() / 2)
        .map(|index| u8::from_str_radix(&hex[index * 2..index * 2 + 2], 16).expect("hex"))
        .collect()
}

/// The pinned vector as bytes, its signing key, and its JSON, for mutation.
fn pinned_grant() -> (Vec<u8>, Vec<u8>, [u8; 32], Value) {
    let bytes = hex_to_bytes(RUST_PINNED_TICKER10K_GRANT_HEX);
    let private_pkcs8_der = hex_to_bytes(PINNED_VECTOR_SIGNING_KEY_PKCS8_DER_HEX);
    let public_raw32 =
        public_raw32_from_pkcs8_der(&private_pkcs8_der).expect("pinned fixture key decodes");
    let value: Value = serde_json::from_slice(&bytes).expect("pinned vector is JSON");
    (bytes, private_pkcs8_der, public_raw32, value)
}

fn parse_pinned(value: &Value) -> Result<CohortGrantV1, CohortRefusal> {
    let (_, private_pkcs8_der, public_raw32, _) = pinned_grant();
    let bytes = canonical_bytes(value)?;
    let signature = sign_bytes(&private_pkcs8_der, &bytes).expect("sign");
    CohortGrantV1::parse_signed(&bytes, &signature, &public_raw32)
}

#[test]
fn the_shard_bound_is_the_grants_subscriber_total() {
    let (bytes, private_pkcs8_der, public_raw32, value) = pinned_grant();

    // The pinned bytes are already canonical: re-encoding the JSON they decode
    // to reproduces them exactly, which is what makes the hex a vector rather
    // than one serialiser's opinion.
    assert_eq!(canonical_bytes(&value).expect("canonical"), bytes);

    let signature = sign_bytes(&private_pkcs8_der, &bytes).expect("sign");
    let grant = CohortGrantV1::parse_signed(&bytes, &signature, &public_raw32)
        .expect("the pinned vector parses");

    assert_eq!(grant.subscriber_count, 100);
    assert_eq!(grant.publisher_count, 1);
    assert_eq!(
        grant.subscriber_shards.len(),
        SUBSCRIBER_SHARD_MODULUS as usize
    );
    // 13 + 13 + 13 + 13 + 12 + 12 + 12 + 12 == 100: every shard carries fewer
    // subscribers than the bound it declares, so the two readings are visibly
    // different numbers in these bytes.
    let total: u64 = grant
        .subscriber_shards
        .iter()
        .map(|shard| shard.subscriber_count)
        .sum();
    assert_eq!(total, grant.subscriber_count);
    for (index, shard) in grant.subscriber_shards.iter().enumerate() {
        assert_eq!(shard.worker_index, index as u64);
        assert_eq!(shard.residue, index as u64);
        assert_ne!(shard.subscriber_count, grant.subscriber_count);
    }

    // The vector also pins this cell's two grant parameters, which
    // `COHORT_CELL_GRANT_PARAMETERS` in `tools/compare/cohort-protocol.ts`
    // carries for the ticker 10k row.
    assert_eq!(grant.measured_duration_ms, 10_000);
    assert_eq!(grant.message_bytes, 100);
    assert_eq!(grant.window_count(), 10);

    assert_eq!(grant.canonical_bytes(), bytes);
}

#[test]
fn a_shard_window_one_short_of_its_residue_class_is_refused_on_both_sides() {
    let (_, _, _, value) = pinned_grant();
    assert!(parse_pinned(&value).is_ok(), "the unmutated vector parses");
    for worker in 0..SUBSCRIBER_SHARD_MODULUS as usize {
        let shard = &value["subscriberShards"][worker];
        let first = shard["firstTokenCommitmentIndex"].as_u64().expect("first");
        let count = shard["subscriberCount"].as_u64().expect("count");
        assert_eq!(
            shard["lastTokenCommitmentIndexExclusive"].as_u64(),
            shard_commitment_window_end(first, count),
            "the pinned shard {worker} spans its residue class"
        );
        // The dense reading, `first + count`: the window every producer and
        // verifier minted before R-A, which holds only the first sixteen
        // interleaved members and refused the seventeenth at the relay.
        let mut dense = value.clone();
        dense["subscriberShards"][worker]["lastTokenCommitmentIndexExclusive"] =
            json!(first + count);
        assert!(
            matches!(parse_pinned(&dense), Err(CohortRefusal::SchemaInvalid)),
            "shard {worker}: dense window"
        );
        // One past the class is as wrong as one short of it.
        let mut wide = value.clone();
        wide["subscriberShards"][worker]["lastTokenCommitmentIndexExclusive"] =
            json!(first + (count - 1) * SUBSCRIBER_SHARD_MODULUS + 2);
        assert!(
            matches!(parse_pinned(&wide), Err(CohortRefusal::SchemaInvalid)),
            "shard {worker}: wide window"
        );
    }
    // A memberless shard has no window: zero is refused before the total
    // check could name it.
    let mut empty = value.clone();
    empty["subscriberShards"][0]["subscriberCount"] = json!(0);
    empty["subscriberShards"][0]["lastTokenCommitmentIndexExclusive"] = json!(1);
    assert!(matches!(
        parse_pinned(&empty),
        Err(CohortRefusal::SchemaInvalid)
    ));
}

#[test]
fn the_residue_class_window_is_one_past_the_last_member() {
    // Ticker 10k: 100 subscribers behind one publisher, residue 0 holds
    // ordinals 0, 8, …, 96 at commitment indices 1, 9, …, 97.
    assert_eq!(shard_commitment_window_end(1, 13), Some(98));
    assert_eq!(shard_commitment_window_end(5, 12), Some(94));
    // Chat 1k: 1,000 subscribers behind ten publishers, 125 per residue.
    assert_eq!(shard_commitment_window_end(10, 125), Some(1003));
    assert_eq!(shard_commitment_window_end(17, 125), Some(1010));
    // One member: the window is that member alone.
    assert_eq!(shard_commitment_window_end(4, 1), Some(5));
    assert_eq!(shard_commitment_window_end(4, 0), None);
    assert_eq!(shard_commitment_window_end(u64::MAX, 1), None);
    assert_eq!(shard_commitment_window_end(0, u64::MAX / 4), None);
}

#[test]
fn a_shard_bound_to_its_own_count_is_refused_on_both_sides() {
    let (_, _, _, value) = pinned_grant();
    let mut mutated = value.clone();
    // Residue 0 carries 13 subscribers; claiming 13 as the bound is exactly
    // the shard-local reading, and it is the mutation that reading survives.
    mutated["subscriberShards"][0]["lastSubscriberIndexExclusive"] = json!(13);
    assert!(parse_pinned(&value).is_ok(), "the unmutated vector parses");
    assert!(matches!(
        parse_pinned(&mutated),
        Err(CohortRefusal::SchemaInvalid)
    ));
}

#[test]
fn a_reordered_shard_array_is_refused_on_both_sides() {
    let (_, _, _, value) = pinned_grant();
    let mut mutated = value.clone();
    let shards = mutated["subscriberShards"]
        .as_array_mut()
        .expect("shard array");
    shards.swap(2, 5);
    // Both entries are individually well formed and the eight are still the
    // same eight; only their positions moved. `workerIndex` is bound to the
    // array index (`secure_fs.rs:12554`), so position is checkable.
    assert!(parse_pinned(&value).is_ok(), "the unmutated vector parses");
    assert!(matches!(
        parse_pinned(&mutated),
        Err(CohortRefusal::SchemaInvalid)
    ));
}

#[test]
fn a_seven_shard_grant_is_refused_on_both_sides() {
    let (_, _, _, value) = pinned_grant();
    let mut mutated = value.clone();
    let shards = mutated["subscriberShards"]
        .as_array_mut()
        .expect("shard array");
    shards.pop();
    assert!(parse_pinned(&value).is_ok(), "the unmutated vector parses");
    assert!(matches!(
        parse_pinned(&mutated),
        Err(CohortRefusal::SchemaInvalid)
    ));
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

// --- G2: the rig receipts' closed key sets ------------------------------------

/// The seven rig receipt schemas have one closed key set each, shared by the
/// rig's mint (`minted_rig_record`) and the Mac's `RigRetention::admit`, and
/// mirrored key-for-key by `cohort-protocol.ts` (`RIG_COHORT_ACCEPTANCE_KEYS`
/// 14, `RIG_WARMUP_DRAINED_KEYS` 15, `RIG_BARRIER_ACCEPTANCE_KEYS` 14,
/// `RIG_RELAY_OBSERVATION_RECEIPT_KEYS` 12) and `cross-supervisor-protocol.ts`
/// (execution acceptance 16, measure-start ack 18, snapshot receipt 27).
#[test]
fn every_rig_receipt_schema_has_exactly_one_closed_key_set() {
    use secure_fs::cohort::rig::RIG_SIGNED_SCHEMAS;
    use secure_fs::cohort::rig_record_keys;
    let expected: &[(&str, usize)] = &[
        ("rig-execution-acceptance/v1", 16),
        ("rig-cohort-acceptance/v1", 14),
        ("rig-measure-start-ack/v1", 18),
        ("rig-warmup-drained-receipt/v1", 15),
        ("rig-barrier-acceptance/v1", 14),
        ("rig-server-snapshot-receipt/v1", 27),
        ("rig-relay-observation-receipt/v1", 12),
    ];
    assert_eq!(
        RIG_SIGNED_SCHEMAS,
        expected
            .iter()
            .map(|(schema, _)| *schema)
            .collect::<Vec<_>>()
            .as_slice()
    );
    for (schema, count) in expected {
        let keys = rig_record_keys::for_schema(schema).expect(schema);
        assert_eq!(keys.len(), *count, "{schema}");
        let distinct: std::collections::BTreeSet<&str> = keys.iter().copied().collect();
        assert_eq!(distinct.len(), keys.len(), "{schema}: duplicate key");
        for required in [
            "schema",
            "executionSha256",
            "receiptSequence",
            "issuedAtMs",
            "notAfterMs",
        ] {
            assert!(keys.contains(&required), "{schema} lacks {required}");
        }
    }
    assert_eq!(rig_record_keys::for_schema("cohort-grant/v1"), None);
    assert_eq!(
        rig_record_keys::for_schema("rig-cohort-acceptance/v2"),
        None
    );
}
