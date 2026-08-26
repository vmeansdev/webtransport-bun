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
    let authority = CampaignAuthorityV1::parse(&bytes, &digest).expect("valid authority");
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
        CampaignAuthorityV1::parse(&flipped, &authority.sha256).unwrap_err(),
        RecordError::DigestMismatch
    );

    // Unknown field.
    let mut with_unknown = authority_value();
    with_unknown["unknownField"] = json!(true);
    let unknown_bytes = canonical_line(&with_unknown);
    assert!(matches!(
        CampaignAuthorityV1::parse(&unknown_bytes, &sha256_hex(&unknown_bytes)).unwrap_err(),
        RecordError::UnknownField(_)
    ));

    // Missing field.
    let mut missing = authority_value();
    missing.as_object_mut().unwrap().remove("topology");
    let missing_bytes = canonical_line(&missing);
    assert!(matches!(
        CampaignAuthorityV1::parse(&missing_bytes, &sha256_hex(&missing_bytes)).unwrap_err(),
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
        CampaignAuthorityV1::parse(&duplicated_bytes, &sha256_hex(&duplicated_bytes)).unwrap_err(),
        RecordError::DuplicateField(_)
    ));

    // Contradictory validity window.
    let mut contradictory = authority_value();
    contradictory["notAfter"] = json!("2026-08-24T11:00:00.000Z");
    let contradictory_bytes = canonical_line(&contradictory);
    assert_eq!(
        CampaignAuthorityV1::parse(&contradictory_bytes, &sha256_hex(&contradictory_bytes))
            .unwrap_err(),
        RecordError::SchemaInvalid
    );

    // Wrong root set.
    let mut short_roots = authority_value();
    short_roots["roots"].as_array_mut().unwrap().pop();
    let short_bytes = canonical_line(&short_roots);
    assert_eq!(
        CampaignAuthorityV1::parse(&short_bytes, &sha256_hex(&short_bytes)).unwrap_err(),
        RecordError::RootSetInvalid
    );

    // Interior control bytes are byte corruption, not JSON.
    let mut corrupted = bytes.clone();
    corrupted[5] = 0x01;
    assert_eq!(
        CampaignAuthorityV1::parse(&corrupted, &sha256_hex(&corrupted)).unwrap_err(),
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
        bootstrap::read_authority_from_pipe(syscalls.engine(), AUTHORITY_PIPE_FD, &"a".repeat(64))
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
        bootstrap::read_authority_from_pipe(writable.engine(), AUTHORITY_PIPE_FD, &"a".repeat(64))
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
        bootstrap::read_authority_from_pipe(syscalls.engine(), AUTHORITY_PIPE_FD, &"0".repeat(64))
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
    let encoded = bootstrap::child_input_frame(
        &authority,
        &lock,
        &capability,
        &manifest_sha256,
        "load-lock-manifest-verify-promote-report",
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
    // The canonical header round-trips byte-identically.
    assert_eq!(canonical_line(&header), decoded.header);
}
