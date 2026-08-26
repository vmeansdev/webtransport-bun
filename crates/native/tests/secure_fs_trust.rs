//! Task C GREEN coverage for the supervisor trust bootstrap: strict
//! canonical record parsing (authority, lock, capability, manifest
//! components), the anonymous-pipe-only authority read, required OS
//! identity comparison, planned-vs-observed distinction, and the validated
//! child input frame.
//!
//! This target is deliberately outside the frozen RED approval bundle: it is
//! regression coverage for Task C production primitives, not a contract
//! change.

#![cfg(any(target_os = "linux", target_os = "macos"))]

#[path = "../src/secure_fs.rs"]
mod secure_fs;

use secure_fs::supervisor::bootstrap;
use secure_fs::supervisor::frame;
use secure_fs::supervisor::records::{
    self, CampaignAuthorityV1, CampaignLockV1, ObservationProvenance, ObservedPathFacts,
    PlannedPathFacts, RecordError, StagedCapabilityV1,
};
use secure_fs::test_support::{Reply, ScriptedCall, ScriptedSyscalls, Syscall};
#[cfg(target_os = "macos")]
use secure_fs::LibcSyscalls;
use secure_fs::{
    DirectoryIdentity, FileIdentity, FileKind, LinuxDirectoryIdentity, MacosDirectoryIdentity,
    SecureFsSyscalls,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn canonical_line(value: &Value) -> Vec<u8> {
    let mut bytes = serde_json::to_vec(value).expect("canonical serialization");
    bytes.push(b'\n');
    bytes
}

fn authority_value() -> Value {
    let identity = |inode: &str| {
        json!({
            "platform": "darwin",
            "device": "16777235",
            "inode": inode,
            "fsidWord0": "4294967297",
            "fsidWord1": "8589934593",
            "fileSystemType": "apfs",
            "volumeUuid": "0123456789abcdef0123456789abcdef",
            "mountTableEntrySha256": "a".repeat(64),
            "canonicalDescriptorPathSha256": "b".repeat(64),
            "ownerUid": 501,
            "mode": 448,
            "hardLinkCount": "1",
        })
    };
    let linux_identity = json!({
        "platform": "linux",
        "deviceMajor": "8",
        "deviceMinor": "1",
        "inode": "9200",
        "mountId": "44123",
        "fileSystemType": "ext4",
        "fileSystemTypeMagic": "0000ef53",
        "fsidWord0": "4294967298",
        "fsidWord1": "8589934594",
        "ownerUid": 1000,
        "mode": 448,
        "hardLinkCount": "1",
    });
    json!({
        "schema": "campaign-authority/v1",
        "candidate": "9d79264a5ff786c3bb7a9820b0589ec9d3bb91f4",
        "campaignId": "campaign-direct-cable-2026-08-24",
        "issuedAt": "2026-08-24T12:00:00.000Z",
        "notAfter": "2026-08-24T22:00:00.000Z",
        "campaignReservationSha256": "c".repeat(64),
        "approval": {
            "parentPlanSha256": "d".repeat(64),
            "parentDesignSha256": "e".repeat(64),
            "amendmentSha256": "f".repeat(64),
            "finalCandidateHead": "9d79264a5ff786c3bb7a9820b0589ec9d3bb91f4",
            "sourceArchiveReceiptSha256": "1".repeat(64),
            "r1RedApprovalBundleSha256": "2".repeat(64),
            "finalArchitectApprovalSha256": "3".repeat(64),
            "finalCriticApprovalSha256": "4".repeat(64),
            "finalVerifierApprovalSha256": "5".repeat(64),
        },
        "source": { "archiveSha256": "6".repeat(64) },
        "topology": { "kind": "direct-cable" },
        "roots": [
            { "hostId": "mac-controller-01", "kind": "mac-campaign", "identity": identity("9100") },
            { "hostId": "mac-controller-01", "kind": "mac-staging", "identity": identity("9101") },
            { "hostId": "linux-bench-01", "kind": "linux-staging", "identity": linux_identity },
            { "hostId": "mac-controller-01", "kind": "mac-exec-parent", "identity": identity("9102") },
        ],
    })
}

fn parsed_authority() -> (CampaignAuthorityV1, Vec<u8>) {
    let bytes = canonical_line(&authority_value());
    let digest = sha256_hex(&bytes);
    let authority = CampaignAuthorityV1::parse(&bytes, &digest, NOW).expect("valid authority");
    (authority, bytes)
}

fn lock_value(authority: &CampaignAuthorityV1) -> Value {
    json!({
        "schema": "campaign-lock/v1",
        "authoritySha256": authority.sha256,
        "candidate": authority.candidate,
        "campaignId": authority.campaign_id,
        "sourceArchiveReceiptSha256": "1".repeat(64),
        "r1RedApprovalBundleSha256": "2".repeat(64),
        "sourceArchiveSha256": "6".repeat(64),
        "registryHash": "7".repeat(64),
        "scheduleHash": "8".repeat(64),
        "capacityProfileHash": "9".repeat(64),
        "tlsPlanHash": "a".repeat(64),
        "topologyPlanHash": "b".repeat(64),
        "executionPlanHash": "c".repeat(64),
        "cardinality": { "executionCount": 2, "descriptorCount": 13 },
        "createdAt": "2026-08-24T12:00:00.000Z",
    })
}

fn parsed_lock(authority: &CampaignAuthorityV1) -> CampaignLockV1 {
    let bytes = canonical_line(&lock_value(authority));
    let digest = sha256_hex(&bytes);
    CampaignLockV1::parse(&bytes, &digest, authority).expect("valid lock")
}

fn capability_value(authority: &CampaignAuthorityV1, lock: &CampaignLockV1) -> Value {
    json!({
        "schema": "staged-capability/v1",
        "authoritySha256": authority.sha256,
        "lockSha256": lock.sha256,
        "candidate": authority.candidate,
        "campaignId": authority.campaign_id,
        "sourceArchiveReceiptSha256": "1".repeat(64),
        "r1RedApprovalBundleSha256": "2".repeat(64),
        "sourceArchiveSha256": "6".repeat(64),
        "macStagedArchiveSha256": "3".repeat(64),
        "linuxStagedArchiveSha256": "4".repeat(64),
        "hostSubmissions": [
            { "hostId": "mac-controller-01" },
            { "hostId": "linux-bench-01" },
        ],
        "sshHostReceiptSha256": "5".repeat(64),
        "macCampaignIdentity": { "platform": "darwin" },
        "issuedAt": "2026-08-24T12:00:00.000Z",
        "notAfter": "2026-08-24T22:00:00.000Z",
        "fixtureOnly": false,
    })
}

const NOW: &str = "2026-08-24T13:00:00.000Z";

#[test]
fn authority_parses_and_rejects_every_strict_violation() {
    let (authority, bytes) = parsed_authority();
    assert_eq!(
        authority.candidate,
        "9d79264a5ff786c3bb7a9820b0589ec9d3bb91f4"
    );
    assert_eq!(authority.roots.len(), 4);
    assert_eq!(authority.sha256, sha256_hex(&bytes));

    // Digest mismatch: one flipped byte.
    let mut flipped = bytes.clone();
    flipped[10] ^= 1;
    assert_eq!(
        CampaignAuthorityV1::parse(&flipped, &authority.sha256, NOW).unwrap_err(),
        RecordError::DigestMismatch
    );

    // Unknown field.
    let mut with_unknown = authority_value();
    with_unknown["unknownField"] = json!(true);
    let unknown_bytes = canonical_line(&with_unknown);
    assert!(matches!(
        CampaignAuthorityV1::parse(&unknown_bytes, &sha256_hex(&unknown_bytes), NOW).unwrap_err(),
        RecordError::UnknownField(_)
    ));

    // Missing field.
    let mut missing = authority_value();
    missing.as_object_mut().unwrap().remove("topology");
    let missing_bytes = canonical_line(&missing);
    assert!(matches!(
        CampaignAuthorityV1::parse(&missing_bytes, &sha256_hex(&missing_bytes), NOW).unwrap_err(),
        RecordError::MissingField(_)
    ));

    // Duplicate field in the raw bytes.
    let text = String::from_utf8(bytes.clone()).unwrap();
    let duplicated = text.replacen(
        "\"schema\":\"campaign-authority/v1\"",
        "\"schema\":\"campaign-authority/v1\",\"schema\":\"campaign-authority/v1\"",
        1,
    );
    let duplicated_bytes = duplicated.into_bytes();
    assert!(matches!(
        CampaignAuthorityV1::parse(&duplicated_bytes, &sha256_hex(&duplicated_bytes), NOW)
            .unwrap_err(),
        RecordError::DuplicateField(_)
    ));

    // Contradictory validity window.
    let mut contradictory = authority_value();
    contradictory["notAfter"] = json!("2026-08-24T11:00:00.000Z");
    let contradictory_bytes = canonical_line(&contradictory);
    assert_eq!(
        CampaignAuthorityV1::parse(&contradictory_bytes, &sha256_hex(&contradictory_bytes), NOW)
            .unwrap_err(),
        RecordError::SchemaInvalid
    );

    // Wrong root set.
    let mut short_roots = authority_value();
    short_roots["roots"].as_array_mut().unwrap().pop();
    let short_bytes = canonical_line(&short_roots);
    assert_eq!(
        CampaignAuthorityV1::parse(&short_bytes, &sha256_hex(&short_bytes), NOW).unwrap_err(),
        RecordError::RootSetInvalid
    );

    // Interior control bytes are byte corruption, not JSON.
    let mut corrupted = bytes.clone();
    corrupted[5] = 0x01;
    assert_eq!(
        CampaignAuthorityV1::parse(&corrupted, &sha256_hex(&corrupted), NOW).unwrap_err(),
        RecordError::Malformed
    );
}

#[test]
fn lock_and_capability_bind_authority_digests_and_times() {
    let (authority, _) = parsed_authority();
    let lock = parsed_lock(&authority);
    assert_eq!(lock.execution_count, 2);
    assert_eq!(lock.descriptor_count, 13);

    // Lock bound to a different authority digest fails.
    let mut foreign = authority.clone();
    foreign.sha256 = "0".repeat(64);
    let lock_bytes = canonical_line(&lock_value(&authority));
    assert!(matches!(
        CampaignLockV1::parse(&lock_bytes, &sha256_hex(&lock_bytes), &foreign).unwrap_err(),
        RecordError::BindingMismatch("authoritySha256")
    ));

    let capability_bytes = canonical_line(&capability_value(&authority, &lock));
    let capability = StagedCapabilityV1::parse(
        &capability_bytes,
        &sha256_hex(&capability_bytes),
        &authority,
        &lock,
        NOW,
    )
    .expect("valid capability");
    assert_eq!(capability.host_count, 2);

    // Time bounds.
    assert_eq!(
        StagedCapabilityV1::parse(
            &capability_bytes,
            &sha256_hex(&capability_bytes),
            &authority,
            &lock,
            "2026-08-24T11:59:59.000Z",
        )
        .unwrap_err(),
        RecordError::NotYetValid
    );
    assert_eq!(
        StagedCapabilityV1::parse(
            &capability_bytes,
            &sha256_hex(&capability_bytes),
            &authority,
            &lock,
            "2026-08-24T22:00:01.000Z",
        )
        .unwrap_err(),
        RecordError::Expired
    );

    // fixtureOnly can never authorize.
    let mut fixture_only = capability_value(&authority, &lock);
    fixture_only["fixtureOnly"] = json!(true);
    let fixture_bytes = canonical_line(&fixture_only);
    assert_eq!(
        StagedCapabilityV1::parse(
            &fixture_bytes,
            &sha256_hex(&fixture_bytes),
            &authority,
            &lock,
            NOW,
        )
        .unwrap_err(),
        RecordError::FixtureOnlyForbidden
    );

    // Identical mac/linux staged archives are contradictory.
    let mut same_archives = capability_value(&authority, &lock);
    same_archives["linuxStagedArchiveSha256"] = same_archives["macStagedArchiveSha256"].clone();
    let same_bytes = canonical_line(&same_archives);
    assert!(matches!(
        StagedCapabilityV1::parse(
            &same_bytes,
            &sha256_hex(&same_bytes),
            &authority,
            &lock,
            NOW,
        )
        .unwrap_err(),
        RecordError::BindingMismatch("stagedArchiveSha256")
    ));
}

#[test]
fn manifest_component_lists_are_exactly_the_declared_read_set() {
    let (authority, _) = parsed_authority();
    let lock = parsed_lock(&authority);
    let descriptors: Vec<Value> = (0..13)
        .map(|index| json!({ "components": ["official", format!("artifact-{index}.json")] }))
        .collect();
    let manifest = json!({
        "schema": "campaign-manifest/v1",
        "lockSha256": lock.sha256,
        "descriptors": descriptors,
    });
    let bytes = canonical_line(&manifest);
    let lists =
        records::manifest_component_lists(&bytes, &sha256_hex(&bytes), &lock).expect("valid");
    assert_eq!(lists.len(), 13);
    assert_eq!(
        lists[0],
        vec!["official".to_owned(), "artifact-0.json".to_owned()]
    );

    // Wrong cardinality against the lock.
    let short = json!({
        "schema": "campaign-manifest/v1",
        "lockSha256": lock.sha256,
        "descriptors": [{ "components": ["official", "a.json"] }],
    });
    let short_bytes = canonical_line(&short);
    assert!(matches!(
        records::manifest_component_lists(&short_bytes, &sha256_hex(&short_bytes), &lock)
            .unwrap_err(),
        RecordError::BindingMismatch("descriptorCount")
    ));

    // Traversal components never pass the admission point.
    let hostile_descriptors: Vec<Value> = (0..12)
        .map(|index| json!({ "components": ["official", format!("artifact-{index}.json")] }))
        .chain([json!({ "components": ["..", "escape.json"] })])
        .collect();
    let hostile = json!({
        "schema": "campaign-manifest/v1",
        "lockSha256": lock.sha256,
        "descriptors": hostile_descriptors,
    });
    let hostile_bytes = canonical_line(&hostile);
    assert_eq!(
        records::manifest_component_lists(&hostile_bytes, &sha256_hex(&hostile_bytes), &lock)
            .unwrap_err(),
        RecordError::ComponentInvalid
    );
}

#[test]
fn observed_facts_fail_on_omission_echo_drift_and_cleanup() {
    let planned = PlannedPathFacts {
        mac_interface: "en8".into(),
        mac_address: "10.99.0.1".into(),
        linux_interface: "eno1".into(),
        linux_address: "10.99.0.2".into(),
        mtu: 1500,
    };
    let complete = ObservedPathFacts {
        provenance: ObservationProvenance::SupervisorMeasured,
        mac_interface: Some("en8".into()),
        mac_address: Some("10.99.0.1".into()),
        linux_interface: Some("eno1".into()),
        linux_address: Some("10.99.0.2".into()),
        mtu: Some(1500),
        qdisc_restored: Some(true),
        cleanup_released: Some(true),
    };
    assert!(records::validate_observed_path_facts(&planned, &complete).is_ok());

    let mut echoed = complete.clone();
    echoed.provenance = ObservationProvenance::EchoOfPlan;
    assert_eq!(
        records::validate_observed_path_facts(&planned, &echoed).unwrap_err(),
        "TRUST_CHILD_OBSERVATION_FORBIDDEN"
    );

    let mut child = complete.clone();
    child.provenance = ObservationProvenance::ChildReported;
    assert_eq!(
        records::validate_observed_path_facts(&planned, &child).unwrap_err(),
        "TRUST_CHILD_OBSERVATION_FORBIDDEN"
    );

    let mut omitted = complete.clone();
    omitted.linux_address = None;
    assert_eq!(
        records::validate_observed_path_facts(&planned, &omitted).unwrap_err(),
        "TRUST_OBSERVATION_OMITTED"
    );

    let mut drifted = complete.clone();
    drifted.mac_interface = Some("en0".into());
    assert_eq!(
        records::validate_observed_path_facts(&planned, &drifted).unwrap_err(),
        "TRUST_OBSERVATION_DRIFT"
    );

    let mut unrestored = complete.clone();
    unrestored.qdisc_restored = Some(false);
    assert_eq!(
        records::validate_observed_path_facts(&planned, &unrestored).unwrap_err(),
        "TRUST_QDISC_RESTORATION_FAILED"
    );

    let mut leaked = complete.clone();
    leaked.cleanup_released = None;
    assert_eq!(
        records::validate_observed_path_facts(&planned, &leaked).unwrap_err(),
        "TRUST_CLEANUP_OBSERVATION_MISSING"
    );
}

fn pipe_identity(size: u64) -> FileIdentity {
    FileIdentity {
        kind: FileKind::Pipe,
        device: "16777235".into(),
        inode: "77".into(),
        mount_id: None,
        fsid_word0: "1".into(),
        fsid_word1: "2".into(),
        owner_uid: 501,
        mode: 0o600,
        hard_link_count: "1".into(),
        size,
    }
}

const AUTHORITY_PIPE_FD: i32 = 3;

#[test]
fn authority_bootstrap_reads_only_a_read_only_pipe_descriptor() {
    let (authority, bytes) = parsed_authority();
    let mut syscalls = ScriptedSyscalls::new(vec![
        ScriptedCall::ok(
            Syscall::Fstat {
                fd: AUTHORITY_PIPE_FD,
            },
            Reply::FileIdentity(pipe_identity(0)),
        ),
        ScriptedCall::ok(
            Syscall::FcntlGetFl {
                fd: AUTHORITY_PIPE_FD,
            },
            Reply::Flags(0),
        ),
        ScriptedCall::ok(
            Syscall::Read {
                fd: AUTHORITY_PIPE_FD,
                max: 1_048_576,
            },
            Reply::Bytes(bytes.clone()),
        ),
        ScriptedCall::ok(
            Syscall::Read {
                fd: AUTHORITY_PIPE_FD,
                max: 1_048_576,
            },
            Reply::Bytes(Vec::new()),
        ),
    ]);
    let (bootstrapped, raw) = bootstrap::read_authority_from_pipe(
        syscalls.engine(),
        AUTHORITY_PIPE_FD,
        &authority.sha256,
        NOW,
    )
    .expect("bootstrap succeeds over the scripted pipe");
    assert_eq!(bootstrapped, authority);
    assert_eq!(raw, bytes);
    assert_eq!(syscalls.engine().remaining(), 0);
}

#[test]
fn authority_bootstrap_rejects_non_pipe_and_writable_descriptors() {
    // A regular file — even one carrying the right bytes — is not the
    // anonymous bootstrap pipe.
    let mut regular = pipe_identity(0);
    regular.kind = FileKind::Regular;
    let mut syscalls = ScriptedSyscalls::new(vec![ScriptedCall::ok(
        Syscall::Fstat {
            fd: AUTHORITY_PIPE_FD,
        },
        Reply::FileIdentity(regular),
    )]);
    assert_eq!(
        bootstrap::read_authority_from_pipe(
            syscalls.engine(),
            AUTHORITY_PIPE_FD,
            &"a".repeat(64),
            NOW
        )
        .unwrap_err(),
        "TRUST_AUTHORITY_PIPE_INVALID"
    );
    assert_eq!(syscalls.engine().remaining(), 0);

    // A read-write pipe is not the read-only bootstrap descriptor.
    let mut writable = ScriptedSyscalls::new(vec![
        ScriptedCall::ok(
            Syscall::Fstat {
                fd: AUTHORITY_PIPE_FD,
            },
            Reply::FileIdentity(pipe_identity(0)),
        ),
        ScriptedCall::ok(
            Syscall::FcntlGetFl {
                fd: AUTHORITY_PIPE_FD,
            },
            Reply::Flags(2),
        ),
    ]);
    assert_eq!(
        bootstrap::read_authority_from_pipe(
            writable.engine(),
            AUTHORITY_PIPE_FD,
            &"a".repeat(64),
            NOW
        )
        .unwrap_err(),
        "TRUST_AUTHORITY_PIPE_INVALID"
    );
    assert_eq!(writable.engine().remaining(), 0);
}

#[test]
fn authority_bootstrap_rejects_digest_mismatch_on_exact_bytes() {
    let (_, bytes) = parsed_authority();
    let mut syscalls = ScriptedSyscalls::new(vec![
        ScriptedCall::ok(
            Syscall::Fstat {
                fd: AUTHORITY_PIPE_FD,
            },
            Reply::FileIdentity(pipe_identity(0)),
        ),
        ScriptedCall::ok(
            Syscall::FcntlGetFl {
                fd: AUTHORITY_PIPE_FD,
            },
            Reply::Flags(0),
        ),
        ScriptedCall::ok(
            Syscall::Read {
                fd: AUTHORITY_PIPE_FD,
                max: 1_048_576,
            },
            Reply::Bytes(bytes),
        ),
        ScriptedCall::ok(
            Syscall::Read {
                fd: AUTHORITY_PIPE_FD,
                max: 1_048_576,
            },
            Reply::Bytes(Vec::new()),
        ),
    ]);
    assert_eq!(
        bootstrap::read_authority_from_pipe(
            syscalls.engine(),
            AUTHORITY_PIPE_FD,
            &"0".repeat(64),
            NOW
        )
        .unwrap_err(),
        "TRUST_RECORD_DIGEST_MISMATCH"
    );
    assert_eq!(syscalls.engine().remaining(), 0);
}

#[test]
fn required_identity_comparison_matches_exactly_or_fails() {
    let (authority, _) = parsed_authority();
    let mac_root = authority
        .roots
        .iter()
        .find(|root| root.kind == "mac-campaign")
        .expect("mac root");
    let observed = DirectoryIdentity::Macos(MacosDirectoryIdentity {
        device: "16777235".into(),
        inode: "9100".into(),
        fsid_word0: "4294967297".into(),
        fsid_word1: "8589934593".into(),
        file_system_type: "apfs".into(),
        volume_uuid: "0123456789abcdef0123456789abcdef".into(),
        mount_table_entry_sha256: "a".repeat(64),
        canonical_descriptor_path_sha256: "b".repeat(64),
        owner_uid: 501,
        mode: 448,
        hard_link_count: "1".into(),
    });
    assert!(bootstrap::required_identity_matches(
        &mac_root.identity,
        &observed
    ));

    // Any single drifted field fails.
    let drifted = DirectoryIdentity::Macos(MacosDirectoryIdentity {
        inode: "9999".into(),
        ..match &observed {
            DirectoryIdentity::Macos(identity) => identity.clone(),
            DirectoryIdentity::Linux(_) => unreachable!(),
        }
    });
    assert!(!bootstrap::required_identity_matches(
        &mac_root.identity,
        &drifted
    ));

    let linux_root = authority
        .roots
        .iter()
        .find(|root| root.kind == "linux-staging")
        .expect("linux root");
    let observed_linux = DirectoryIdentity::Linux(LinuxDirectoryIdentity {
        device_major: "8".into(),
        device_minor: "1".into(),
        inode: "9200".into(),
        mount_id: "44123".into(),
        file_system_type: "ext4".into(),
        file_system_type_magic: "0000ef53".into(),
        fsid_word0: "4294967298".into(),
        fsid_word1: "8589934594".into(),
        owner_uid: 1000,
        mode: 448,
        hard_link_count: "1".into(),
    });
    assert!(bootstrap::required_identity_matches(
        &linux_root.identity,
        &observed_linux
    ));
    // A mac declaration can never satisfy a linux observation.
    assert!(!bootstrap::required_identity_matches(
        &mac_root.identity,
        &observed_linux
    ));
}

#[test]
fn child_input_frame_is_canonical_bounded_and_digest_verified() {
    let (authority, _) = parsed_authority();
    let lock = parsed_lock(&authority);
    let capability_bytes = canonical_line(&capability_value(&authority, &lock));
    let capability = StagedCapabilityV1::parse(
        &capability_bytes,
        &sha256_hex(&capability_bytes),
        &authority,
        &lock,
        NOW,
    )
    .expect("valid capability");

    let manifest_sha256 = "9".repeat(64);
    let host_ids = vec!["mac-controller-01".to_owned(), "linux-bench-01".to_owned()];
    let measurement = json!({ "armKind": "wt", "cellIndex": 0 })
        .as_object()
        .cloned()
        .expect("measurement object");
    let role_tuple = "a".repeat(64);
    let role_receipts = "b".repeat(64);
    let physical = "c".repeat(64);
    let facts = bootstrap::ChildInputFacts {
        role_tuple_oracle_sha256: &role_tuple,
        role_receipt_set_sha256: &role_receipts,
        physical_observation_sha256: &physical,
        host_ids: &host_ids,
        measurement: &measurement,
    };
    let encoded = bootstrap::child_input_frame(
        &authority,
        &lock,
        &capability,
        &manifest_sha256,
        "load-lock-manifest-verify-promote-report",
        &facts,
    )
    .expect("frame encodes");
    let decoded = frame::decode_single_frame(&encoded, 0).expect("frame decodes");
    assert!(decoded.payload.is_empty());
    let header: Value = serde_json::from_slice(&decoded.header).expect("canonical header");
    assert_eq!(
        header["schema"].as_str(),
        Some("comparison-supervisor-input/v1")
    );
    assert_eq!(
        header["authoritySha256"].as_str(),
        Some(authority.sha256.as_str())
    );
    assert_eq!(header["lockSha256"].as_str(), Some(lock.sha256.as_str()));
    assert_eq!(
        header["capabilitySha256"].as_str(),
        Some(capability.sha256.as_str())
    );
    assert_eq!(header["expectedProcessCount"].as_u64(), Some(2));
    assert_eq!(header["expectedDescriptorCount"].as_u64(), Some(13));
    // The frame shape matches the JS `ComparisonSupervisorInputV1` record
    // exactly: the boundary is validated on both sides against one field set.
    let mut fields: Vec<&str> = header
        .as_object()
        .expect("object header")
        .keys()
        .map(String::as_str)
        .collect();
    fields.sort_unstable();
    assert_eq!(
        fields,
        [
            "authoritySha256",
            "campaignId",
            "candidate",
            "capabilitySha256",
            "expectedDescriptorCount",
            "expectedProcessCount",
            "hostIds",
            "lockSha256",
            "manifestSha256",
            "measurement",
            "operation",
            "physicalObservationSha256",
            "roleReceiptSetSha256",
            "roleTupleOracleSha256",
            "schema",
        ]
    );
    // The canonical header round-trips byte-identically.
    assert_eq!(canonical_line(&header), decoded.header);
}

/// Regression: escaped duplicate keys.  A lexer that copies `\uXXXX`
/// through instead of decoding it sees `candidate` and `candidate` as
/// two different keys and reports no duplicate, while `serde_json` folds
/// them into one key holding the *last* value.  A byte audit then reads the
/// benign first value while the record binds the smuggled second one.
#[test]
fn escaped_duplicate_keys_are_rejected_on_every_binding_field() {
    let (authority, _) = parsed_authority();
    let lock = parsed_lock(&authority);

    for field in [
        "candidate",
        "campaignId",
        "authoritySha256",
        "lockSha256",
        "fixtureOnly",
    ] {
        let capability = capability_value(&authority, &lock);
        let text = String::from_utf8(canonical_line(&capability)).expect("utf8 record");
        // Escape the first character of the field name so the two keys are
        // lexically distinct but decode identically.
        let first = &field[..1];
        let escaped = format!("\\u{:04x}", first.as_bytes()[0]);
        let smuggled = text.replacen(
            &format!("\"{field}\":"),
            &format!("\"{field}\":\"benign\",\"{escaped}{}\":", &field[1..]),
            1,
        );
        let bytes = smuggled.into_bytes();

        // serde_json itself collapses the pair, so the record still parses.
        let parsed: Value =
            serde_json::from_slice(&bytes[..bytes.len() - 1]).expect("json still parses");
        assert_eq!(
            parsed.as_object().expect("object").keys().count(),
            capability.as_object().expect("object").keys().count(),
            "the two lexical keys collapse into one parsed key"
        );

        // Strict parsing must see the duplicate the parser hid.
        assert!(
            matches!(
                StagedCapabilityV1::parse(&bytes, &sha256_hex(&bytes), &authority, &lock, NOW)
                    .unwrap_err(),
                RecordError::DuplicateField(_)
            ),
            "escaped duplicate `{field}` must be rejected"
        );
    }
}

#[test]
fn escape_decoding_handles_short_escapes_and_surrogate_pairs() {
    let (authority, _) = parsed_authority();
    let lock = parsed_lock(&authority);

    // Short escapes alias too: `/` and `/` are the same key.
    let text = String::from_utf8(canonical_line(&capability_value(&authority, &lock)))
        .expect("utf8 record");
    let aliased = text.replacen(
        "\"schema\":",
        "\"sch\\u0065ma\":\"staged-capability/v1\",\"schema\":",
        1,
    );
    let bytes = aliased.into_bytes();
    assert!(matches!(
        StagedCapabilityV1::parse(&bytes, &sha256_hex(&bytes), &authority, &lock, NOW).unwrap_err(),
        RecordError::DuplicateField(_)
    ));

    // A surrogate pair decodes to one scalar, so an astral key spelled two
    // ways is one key; distinct astral keys stay distinct.
    let paired = r#"{"😀":1,"😀":2}"#;
    assert!(matches!(
        records::strict_parse(format!("{paired}\n").as_bytes()).unwrap_err(),
        RecordError::DuplicateField(_)
    ));
    let distinct = r#"{"😀":1,"😁":2}"#;
    assert!(records::strict_parse(format!("{distinct}\n").as_bytes()).is_ok());
}

/// Regression: an unvalidated validity window.  `"~"` sorts after every
/// digit, so a lexicographic-only comparison would never expire it.
#[test]
fn validity_windows_require_canonical_rfc3339_and_are_checked_against_now() {
    let (authority, _) = parsed_authority();
    let lock = parsed_lock(&authority);

    for hostile in [
        "~",
        "",
        "2026-08-24T22:00:00Z",
        "2026-08-24T22:00:00.000+01:00",
        "9999-99-99T99:99:99.999Z",
        "2026-08-24t22:00:00.000Z",
    ] {
        let mut capability = capability_value(&authority, &lock);
        capability["notAfter"] = json!(hostile);
        let bytes = canonical_line(&capability);
        assert_eq!(
            StagedCapabilityV1::parse(&bytes, &sha256_hex(&bytes), &authority, &lock, NOW)
                .unwrap_err(),
            RecordError::SchemaInvalid,
            "non-canonical notAfter `{hostile}` must never be compared"
        );
    }

    // A canonical but elapsed window still expires.
    let mut expired = capability_value(&authority, &lock);
    expired["notAfter"] = json!("2026-08-24T12:30:00.000Z");
    let bytes = canonical_line(&expired);
    assert_eq!(
        StagedCapabilityV1::parse(&bytes, &sha256_hex(&bytes), &authority, &lock, NOW).unwrap_err(),
        RecordError::Expired
    );

    // The authority's own window is enforced against now, not merely
    // checked for internal ordering.
    let mut stale = authority_value();
    stale["issuedAt"] = json!("2026-08-20T00:00:00.000Z");
    stale["notAfter"] = json!("2026-08-21T00:00:00.000Z");
    let stale_bytes = canonical_line(&stale);
    assert_eq!(
        CampaignAuthorityV1::parse(&stale_bytes, &sha256_hex(&stale_bytes), NOW).unwrap_err(),
        RecordError::Expired
    );
    let mut future = authority_value();
    future["issuedAt"] = json!("2026-09-01T00:00:00.000Z");
    future["notAfter"] = json!("2026-09-02T00:00:00.000Z");
    let future_bytes = canonical_line(&future);
    assert_eq!(
        CampaignAuthorityV1::parse(&future_bytes, &sha256_hex(&future_bytes), NOW).unwrap_err(),
        RecordError::NotYetValid
    );
}

/// Regression: unknown-field rejection must be total.  A nested object is
/// as good a smuggling channel as the top-level record.
#[test]
fn nested_objects_reject_unknown_fields() {
    let (authority, _) = parsed_authority();
    let lock = parsed_lock(&authority);

    let mut capability = capability_value(&authority, &lock);
    capability["hostSubmissions"][0]["smuggled"] = json!("payload");
    let bytes = canonical_line(&capability);
    assert!(matches!(
        StagedCapabilityV1::parse(&bytes, &sha256_hex(&bytes), &authority, &lock, NOW).unwrap_err(),
        RecordError::UnknownField(_)
    ));

    let manifest = json!({
        "schema": "campaign-manifest/v1",
        "lockSha256": lock.sha256,
        "descriptors": (0..13)
            .map(|index| json!({
                "components": ["official", format!("artifact-{index}.json")],
                "smuggled": index,
            }))
            .collect::<Vec<Value>>(),
    });
    let manifest_bytes = canonical_line(&manifest);
    assert!(matches!(
        records::manifest_component_lists(&manifest_bytes, &sha256_hex(&manifest_bytes), &lock)
            .unwrap_err(),
        RecordError::UnknownField(_)
    ));
}

/// Regression: an authority root that is group- or world-writable lets any
/// same-group process rename entries under a descriptor whose identity
/// still matches, so identity comparison must reject the mode outright.
#[test]
fn writable_roots_never_satisfy_required_identity() {
    let (authority, _) = parsed_authority();
    let mac_root = authority
        .roots
        .iter()
        .find(|root| root.kind == "mac-campaign")
        .expect("mac root");
    for mode in [0o770u32, 0o777, 0o702, 0o720] {
        let observed = DirectoryIdentity::Macos(MacosDirectoryIdentity {
            device: "16777235".into(),
            inode: "9100".into(),
            fsid_word0: "4294967297".into(),
            fsid_word1: "8589934593".into(),
            file_system_type: "apfs".into(),
            volume_uuid: "0123456789abcdef0123456789abcdef".into(),
            mount_table_entry_sha256: "a".repeat(64),
            canonical_descriptor_path_sha256: "b".repeat(64),
            owner_uid: 501,
            mode,
            hard_link_count: "1".into(),
        });
        assert!(
            !bootstrap::required_identity_matches(&mac_root.identity, &observed),
            "mode {mode:o} is writable beyond the owner and must be refused"
        );
    }
}

/// Regression for the macOS sealed launch: the child must land in its own
/// process group (the "dedicated process group" the supervisor policy
/// requires and cleanup attests to), the working directory must come from
/// the validated directory descriptor rather than from process cwd, and a
/// leaf whose identity drifted from the verified descriptor must never be
/// executed.
#[cfg(target_os = "macos")]
#[test]
fn pinned_directory_spawn_isolates_the_group_and_refuses_a_swapped_leaf() {
    use secure_fs::SecureFsSyscalls as _;
    use std::ffi::CString;

    let root = std::env::temp_dir().join(format!(
        "r1-pinned-spawn-{}-{}",
        std::process::id(),
        sha256_hex(b"pinned-spawn")[..8].to_owned()
    ));
    let sealed = root.join("exec-private-01");
    std::fs::create_dir_all(&sealed).expect("sealed directory");
    let leaf = "true-leaf";
    let target = sealed.join(leaf);
    std::fs::copy("/usr/bin/true", &target).expect("stage a real executable");

    let open_dir = |path: &std::path::Path| -> i32 {
        let c = CString::new(path.as_os_str().to_str().expect("utf8 path")).expect("c path");
        // SAFETY: open of a NUL-terminated path; closed below.
        let fd = unsafe {
            libc::open(
                c.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
            )
        };
        assert!(fd >= 0, "opening {path:?} must succeed");
        fd
    };
    let sealed_fd = open_dir(&sealed);
    // SAFETY: fchdir to a directory descriptor opened just above; the
    // original working directory is restored before the test returns.
    let saved_cwd = open_dir(&std::env::current_dir().expect("cwd"));
    assert_eq!(unsafe { libc::fchdir(sealed_fd) }, 0);

    let leaf_c = CString::new(leaf).expect("leaf");
    // SAFETY: open of the staged leaf relative to the pinned directory.
    let exec_fd = unsafe { libc::open(leaf_c.as_ptr(), libc::O_RDONLY | libc::O_CLOEXEC) };
    assert!(exec_fd >= 0, "the staged leaf must open");

    let context = secure_fs::test_support::LaunchContextV1 {
        supervisor_instance: "supervisor-instance-01".into(),
        run_id: "run-0001".into(),
        logical_role: "resident".into(),
        execution_index: 0,
        process_ordinal: 0,
        clock_rfc3339: "2026-08-24T00:00:12Z".into(),
        source_receipt_sha256: "0".repeat(64),
        source_receipt_bytes: Vec::new(),
        source_executable: FileIdentity {
            kind: FileKind::Regular,
            device: "1".into(),
            inode: "2".into(),
            mount_id: None,
            fsid_word0: "0".into(),
            fsid_word1: "0".into(),
            owner_uid: 501,
            mode: 0o500,
            hard_link_count: "1".into(),
            size: 0,
        },
        descriptor_map_preimage: Vec::new(),
        descriptor_map_sha256: "1".repeat(64),
        startup_nonce: Vec::new(),
        startup_nonce_sha256: "2".repeat(64),
        startup_digest: Vec::new(),
        startup_digest_sha256: "3".repeat(64),
    };
    let argv = vec![leaf.to_owned()];
    let env: Vec<(String, String)> = Vec::new();

    let mut syscalls = LibcSyscalls::new();
    let pid = syscalls
        .engine()
        .pinned_directory_spawn(exec_fd, &argv, &env, &context)
        .expect("the sealed leaf launches");

    // The dedicated process group exists and is the child's own.
    // SAFETY: getpgid on a child this test spawned.
    let pgid = unsafe { libc::getpgid(pid) };
    assert_eq!(
        pgid, pid,
        "the child must own a dedicated process group, not inherit ours"
    );
    let mut status = 0;
    // SAFETY: reaping our own child.
    unsafe { libc::waitpid(pid, &mut status, 0) };

    // The real attack: a same-uid process `renameat`s a different file over
    // the leaf.  The verified descriptor still holds the original inode, the
    // directory entry now resolves to another one, and `posix_spawn` would
    // execute the entry.  The pre-spawn identity re-check must see it.
    let decoy = sealed.join("decoy");
    std::fs::copy("/usr/bin/false", &decoy).expect("stage a decoy");
    std::fs::rename(&decoy, &target).expect("rename over the leaf");
    let swapped = syscalls
        .engine()
        .pinned_directory_spawn(exec_fd, &argv, &env, &context);
    assert!(
        swapped.is_err(),
        "a leaf whose identity drifted must never be executed"
    );

    // SAFETY: descriptors opened by this test, closed exactly once.
    unsafe {
        libc::fchdir(saved_cwd);
        libc::close(saved_cwd);
        libc::close(exec_fd);
        libc::close(sealed_fd);
    }
    let _ = std::fs::remove_dir_all(&root);
}
