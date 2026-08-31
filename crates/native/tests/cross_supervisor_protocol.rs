//! A2 Rust adversarial coverage for cross-supervisor Ed25519 + replay ledgers.
//!
//! Links `secure_fs` via path (same pattern as `secure_fs_trust.rs`) so the
//! test does not pull the napi cdylib into a standalone executable.
#![cfg(any(target_os = "linux", target_os = "macos"))]

#[path = "../src/secure_fs.rs"]
mod secure_fs;

use secure_fs::cross_supervisor::{
    decode_child_pipe, encode_child_pipe, generate_ed25519_keypair, hex_sha256, public_key_sha256,
    reject_approval_identity_mismatch, reject_rig_key_substitution, sign_bytes,
    verify_against_staged_key, verify_bytes, CrossSupervisorError, MemoryReplayLedger,
    RemoteSequenceState, ReplaySide, MAC_PUBLIC_LEAF, RIG_PUBLIC_LEAF,
};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

fn temp_dir(label: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("time")
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("wt-cross-supervisor-{label}-{nanos}"));
    fs::create_dir_all(&dir).expect("temp dir");
    dir
}

/// Test-local durable O_CREAT|O_EXCL replay ledger (production A3 binds the
/// sealed SecureFs writer; A2 proves one-shot semantics after restart).
struct DurableReplayLedger {
    root: PathBuf,
}

impl DurableReplayLedger {
    fn open(root: impl Into<PathBuf>) -> std::io::Result<Self> {
        let root = root.into();
        fs::create_dir_all(root.join("mac-records"))?;
        fs::create_dir_all(root.join("rig-records"))?;
        Ok(Self { root })
    }

    fn try_append(
        &self,
        side: ReplaySide,
        signed_schema: &str,
        signed_bytes_sha256: &str,
    ) -> Result<String, CrossSupervisorError> {
        let dir = self
            .root
            .join(side.dir_name())
            .join(signed_schema.replace('/', "_"));
        fs::create_dir_all(&dir).map_err(|e| CrossSupervisorError::Io(e.to_string()))?;
        let leaf = dir.join(signed_bytes_sha256);
        match OpenOptions::new().write(true).create_new(true).open(&leaf) {
            Ok(mut file) => {
                let payload = format!("{signed_bytes_sha256}\n");
                file.write_all(payload.as_bytes())
                    .and_then(|_| file.sync_all())
                    .map_err(|e| CrossSupervisorError::Io(e.to_string()))?;
                Ok(hex_sha256(payload.as_bytes()))
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                Err(CrossSupervisorError::Replay)
            }
            Err(e) => Err(CrossSupervisorError::Io(e.to_string())),
        }
    }
}

fn keygen_ed25519_to_paths(
    private_out: &Path,
    public_out: &Path,
    overwrite: bool,
) -> Result<secure_fs::cross_supervisor::Ed25519KeyPair, CrossSupervisorError> {
    if !overwrite && (private_out.exists() || public_out.exists()) {
        return Err(CrossSupervisorError::KeyExists);
    }
    let pair = generate_ed25519_keypair();
    if let Some(parent) = private_out.parent() {
        fs::create_dir_all(parent).map_err(|e| CrossSupervisorError::Io(e.to_string()))?;
    }
    if let Some(parent) = public_out.parent() {
        fs::create_dir_all(parent).map_err(|e| CrossSupervisorError::Io(e.to_string()))?;
    }
    if overwrite {
        let _ = fs::remove_file(private_out);
        let _ = fs::remove_file(public_out);
    }
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(private_out)
        .and_then(|mut f| {
            f.write_all(&pair.private_pkcs8_der)?;
            f.sync_all()
        })
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::AlreadyExists {
                CrossSupervisorError::KeyExists
            } else {
                CrossSupervisorError::Io(e.to_string())
            }
        })?;
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(public_out)
        .and_then(|mut f| {
            f.write_all(&pair.public_raw32)?;
            f.sync_all()
        })
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::AlreadyExists {
                CrossSupervisorError::KeyExists
            } else {
                CrossSupervisorError::Io(e.to_string())
            }
        })?;
    Ok(pair)
}

#[test]
fn ed25519_mac_and_rig_receipt_round_trip() {
    let mac = generate_ed25519_keypair();
    let rig = generate_ed25519_keypair();
    let mac_msg = b"mac-execution-grant-receipt/v1\n";
    let rig_msg = b"rig-execution-acceptance/v1\n";
    let mac_sig = sign_bytes(&mac.private_pkcs8_der, mac_msg).expect("mac sign");
    let rig_sig = sign_bytes(&rig.private_pkcs8_der, rig_msg).expect("rig sign");
    verify_bytes(&mac.public_raw32, mac_msg, &mac_sig).expect("mac verify");
    verify_bytes(&rig.public_raw32, rig_msg, &rig_sig).expect("rig verify");
    assert_eq!(MAC_PUBLIC_LEAF, "mac-supervisor-ed25519.pub");
    assert_eq!(RIG_PUBLIC_LEAF, "rig-supervisor-ed25519.pub");
}

#[test]
fn ed25519_wrong_public_key_is_rejected_both_directions() {
    let mac = generate_ed25519_keypair();
    let other = generate_ed25519_keypair();
    let msg = b"exact-canonical-bytes\n";
    let sig = sign_bytes(&mac.private_pkcs8_der, msg).expect("sign");
    assert_eq!(
        verify_bytes(&other.public_raw32, msg, &sig).unwrap_err(),
        CrossSupervisorError::SignatureInvalid
    );
    assert_eq!(
        verify_against_staged_key(
            &other.public_raw32,
            &public_key_sha256(&mac.public_raw32),
            msg,
            &sig,
        )
        .unwrap_err(),
        CrossSupervisorError::SigningKeyMismatch
    );
}

#[test]
fn mac_and_rig_replay_leaves_are_one_shot_after_restart() {
    let root = temp_dir("replay");
    let ledger = DurableReplayLedger::open(root.join("replay")).expect("open");
    let digest = hex_sha256(b"mac-receipt-bytes");
    ledger
        .try_append(
            ReplaySide::MacRecords,
            "mac-execution-grant-receipt/v1",
            &digest,
        )
        .expect("first mac");
    let restarted = DurableReplayLedger::open(root.join("replay")).expect("reopen");
    assert_eq!(
        restarted
            .try_append(
                ReplaySide::MacRecords,
                "mac-execution-grant-receipt/v1",
                &digest,
            )
            .unwrap_err(),
        CrossSupervisorError::Replay
    );
    let rig_digest = hex_sha256(b"rig-receipt-bytes");
    restarted
        .try_append(
            ReplaySide::RigRecords,
            "rig-execution-acceptance/v1",
            &rig_digest,
        )
        .expect("first rig");
    assert_eq!(
        restarted
            .try_append(
                ReplaySide::RigRecords,
                "rig-execution-acceptance/v1",
                &rig_digest,
            )
            .unwrap_err(),
        CrossSupervisorError::Replay
    );

    // Memory ledger restart path (controller/courier side).
    let mut memory = MemoryReplayLedger::new();
    memory
        .try_append(
            ReplaySide::MacRecords,
            "mac-execution-grant-receipt/v1",
            &digest,
        )
        .expect("memory first");
    let snap = memory.snapshot();
    let mut restored = MemoryReplayLedger::from_snapshot(&snap).expect("restore");
    assert_eq!(
        restored
            .try_append(
                ReplaySide::MacRecords,
                "mac-execution-grant-receipt/v1",
                &digest,
            )
            .unwrap_err(),
        CrossSupervisorError::Replay
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn approval_identity_mismatch_is_rejected() {
    assert_eq!(
        reject_approval_identity_mismatch("plan-a", "approval-a", "plan-a", "approval-b")
            .unwrap_err(),
        CrossSupervisorError::ApprovalIdentityMismatch
    );
    reject_approval_identity_mismatch("plan-a", "approval-a", "plan-a", "approval-a")
        .expect("match");
}

#[test]
fn rig_key_substitution_and_rotation_same_campaign_are_rejected() {
    let root = temp_dir("keys");
    let private = root.join("camp.rig.pk8");
    let public = root.join("rig-supervisor-ed25519.pub");
    let first = keygen_ed25519_to_paths(&private, &public, false).expect("keygen");
    assert_eq!(
        keygen_ed25519_to_paths(&private, &public, false).unwrap_err(),
        CrossSupervisorError::KeyExists
    );
    let substitute = generate_ed25519_keypair();
    assert_eq!(
        reject_rig_key_substitution(
            &first.public_raw32,
            &public_key_sha256(&substitute.public_raw32),
        )
        .unwrap_err()
        .code(),
        "MAC_SIGNING_KEY_MISMATCH"
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn remote_frame_sequences_are_direction_local() {
    let mut state = RemoteSequenceState::default();
    state.assert_request(0).expect("req0");
    assert!(state.assert_request(0).is_err());
    state.assert_request(1).expect("req1");
    state.assert_response(0, 0).expect("resp0");
    assert!(state.assert_response(0, 0).is_err());
    assert!(state.assert_response(1, 0).is_err());
    state.assert_response(1, 1).expect("resp1");
}

#[test]
fn child_pipe_exact_keys_and_bounds() {
    let payload = br#"{"cohortGrantBase64":null,"executionSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","rigExecutionAcceptanceSha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","schema":"server-bind-execution/v1","sequence":0}
"#;
    let frame = encode_child_pipe(payload).expect("encode");
    let decoded = decode_child_pipe(&frame).expect("decode");
    assert_eq!(decoded, payload);
    let oversize = vec![0u8; 64 * 1024 + 1];
    assert!(encode_child_pipe(&oversize).is_err());
    assert!(decode_child_pipe(&frame[..3]).is_err());
    let mut trailing = frame.clone();
    trailing.push(0);
    assert!(decode_child_pipe(&trailing).is_err());
}
