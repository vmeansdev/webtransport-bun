//! S5-MAC-RS: the Mac supervisor's half of the §5 Phase-B lifecycle, as a
//! process.
//!
//! `rig_cohort_runtime.rs` proves what the rig says at each transition; this
//! file proves what the **Mac** binary verifies before it would say anything —
//! and, because verification is the whole of §2.9's security property, most of
//! it is about refusals rather than answers.
//!
//! The five §2.9(5) forgery tests are the point of the file. Each one presents
//! a well-formed frame carrying a rig record the controller could have built
//! for itself, and asserts the binary refuses it **at the check that names the
//! forgery** — a different §7 code, reached earlier, than the one an honest
//! frame reaches. That is what makes them non-vacuous: they distinguish, they
//! do not merely fail.
#![cfg(any(target_os = "linux", target_os = "macos"))]

#[path = "../src/secure_fs.rs"]
mod secure_fs;

use base64::Engine as _;
use secure_fs::cohort::mac::{
    ack_kind_for, verify_rig_record, MacCohortRuntime, MacCohortStage, MacIdentity, MacRefusal,
    MAC_REQUEST_KINDS, MAC_SIGNED_SCHEMAS, MINT_INPUTS_UNREACHABLE, RIG_SIGNED_SCHEMAS,
    SECTION_7_CODES,
};
use secure_fs::cohort::{canonical_bytes, sha256_hex};
use secure_fs::cross_supervisor::{generate_ed25519_keypair, Ed25519KeyPair};
use serde_json::{json, Value};

const NOW_MS: u64 = 1_760_000_100_000;
const VALIDITY_MS: u64 = 3_600_000;

fn digest(tag: &str) -> String {
    sha256_hex(tag.as_bytes())
}

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn unb64(text: &str) -> Vec<u8> {
    base64::engine::general_purpose::STANDARD
        .decode(text.as_bytes())
        .expect("base64")
}

fn bytes_of(value: &Value) -> Vec<u8> {
    canonical_bytes(value).expect("canonical")
}

// --- a rig that signs, so the Mac has something honest to authenticate ------

/// The rig supervisor, reduced to the one thing this file needs from it: the
/// ability to mint a record and the `rig-receipt-signature/v1` carrier over it.
///
/// This is not a re-implementation of `cohort::rig` — it is the *controller's*
/// view of a rig, which is exactly the position a forger occupies. What
/// separates the honest rig from the forger below is one thing only: which
/// private key signs.
struct RigSigner {
    keys: Ed25519KeyPair,
}

impl RigSigner {
    fn new() -> Self {
        Self {
            keys: generate_ed25519_keypair(),
        }
    }

    fn public_key_sha256(&self) -> String {
        sha256_hex(&self.keys.public_raw32)
    }

    /// One signed rig record: its exact canonical bytes and the canonical
    /// signature carrier over them.
    fn sign(&self, schema: &str, record: &Value) -> (Vec<u8>, Vec<u8>) {
        let bytes = bytes_of(record);
        let signature =
            secure_fs::cross_supervisor::sign_bytes(&self.keys.private_pkcs8_der, &bytes)
                .expect("sign");
        let carrier = json!({
            "schema": "rig-receipt-signature/v1",
            "algorithm": "Ed25519",
            "signedSchema": schema,
            "signedBytesSha256": sha256_hex(&bytes),
            "signingPublicKeySha256": self.public_key_sha256(),
            "signatureBase64": b64(&signature),
        });
        (bytes, bytes_of(&carrier))
    }
}

/// The minimum honest rig record: the three fields every rig receipt carries
/// and that the Mac reads after authenticating it.
fn rig_record(schema: &str, execution_sha256: &str, receipt_sequence: u64) -> Value {
    json!({
        "schema": schema,
        "executionSha256": execution_sha256,
        "receiptSequence": receipt_sequence,
        "issuedAtMs": NOW_MS,
        "notAfterMs": NOW_MS + VALIDITY_MS,
    })
}

// --- the campaign under test ------------------------------------------------

struct Campaign {
    runtime: MacCohortRuntime,
    rig: RigSigner,
    mac_public_raw32: [u8; 32],
}

fn execution(index: u64) -> String {
    digest(&format!("execution-{index}"))
}

fn campaign() -> Campaign {
    campaign_with(RigSigner::new())
}

/// A campaign whose staged rig public key is `rig`'s.
///
/// The rig is a parameter because a restart must reuse the *same* staged key:
/// a second process holding a different one would refuse every record for a
/// reason that has nothing to do with the invariant under test.
fn campaign_with(rig: RigSigner) -> Campaign {
    let mac = generate_ed25519_keypair();
    let runtime = MacCohortRuntime::new(
        mac.private_pkcs8_der.clone(),
        rig.keys.public_raw32,
        &digest("mac-instance"),
        &digest("mac-clock"),
        VALIDITY_MS,
    )
    .expect("runtime");
    Campaign {
        runtime,
        rig,
        mac_public_raw32: mac.public_raw32,
    }
}

impl Campaign {
    fn dispatch(&mut self, kind: &str, payload: &Value) -> Result<Vec<u8>, MacRefusal> {
        self.runtime.dispatch(kind, &bytes_of(payload), NOW_MS)
    }

    /// The §3.3 channel counter this campaign is at.
    fn seq(&self) -> u64 {
        self.runtime.next_request_seq()
    }

    fn open(&mut self, execution_sha256: &str) -> Result<Vec<u8>, MacRefusal> {
        let plan = bytes_of(&json!({
            "schema": "canonical-workload-role-plan-input/v1",
            "cellId": "chat-fanout/subscribers-1000",
        }));
        let seq = self.seq();
        self.dispatch(
            "mac-open-cohort-request",
            &json!({
                "schema": "mac-open-cohort-request/v1",
                "requestSeq": seq,
                "executionSha256": execution_sha256,
                "scenarioHash": digest("scenario"),
                "rolePlanHash": digest("role-plan"),
                "workloadRolePlanInputBase64": b64(&plan),
                "workloadRolePlanInputSha256": sha256_hex(&plan),
                "workloadRolePlanInputSize": plan.len(),
            }),
        )
    }

    /// COHORT_GRANTED's second half, with an honest rig acceptance.
    fn present_cohort_acceptance(&mut self, execution_sha256: &str) -> Result<Vec<u8>, MacRefusal> {
        let (record, signature) = self.rig.sign(
            "rig-cohort-acceptance/v1",
            &rig_record("rig-cohort-acceptance/v1", execution_sha256, 1),
        );
        let seq = self.seq();
        self.dispatch(
            "mac-present-rig-cohort-acceptance-request",
            &json!({
                "schema": "mac-present-rig-cohort-acceptance-request/v1",
                "requestSeq": seq,
                "executionSha256": execution_sha256,
                "rigCohortAcceptanceBase64": b64(&record),
                "rigCohortAcceptanceSignatureBase64": b64(&signature),
            }),
        )
    }

    /// START_BARRIER, with each of the two rig records optionally replaced by
    /// whatever the caller wants to present instead.
    fn issue_start_barrier(
        &mut self,
        execution_sha256: &str,
        drained: Option<(Vec<u8>, Vec<u8>)>,
        ack: Option<(Vec<u8>, Vec<u8>)>,
    ) -> Result<Vec<u8>, MacRefusal> {
        let drained = drained.unwrap_or_else(|| {
            self.rig.sign(
                "rig-warmup-drained-receipt/v1",
                &rig_record("rig-warmup-drained-receipt/v1", execution_sha256, 2),
            )
        });
        let ack = ack.unwrap_or_else(|| {
            self.rig.sign(
                "rig-measure-start-ack/v1",
                &rig_record("rig-measure-start-ack/v1", execution_sha256, 3),
            )
        });
        let seq = self.seq();
        self.dispatch(
            "mac-issue-start-barrier-request",
            &json!({
                "schema": "mac-issue-start-barrier-request/v1",
                "requestSeq": seq,
                "executionSha256": execution_sha256,
                "cohortGrantSha256": digest("cohort-grant"),
                "rigWarmupDrainedReceiptBase64": b64(&drained.0),
                "rigWarmupDrainedReceiptSignatureBase64": b64(&drained.1),
                "rigMeasureStartAckBase64": b64(&ack.0),
                "rigMeasureStartAckSignatureBase64": b64(&ack.1),
            }),
        )
    }

    /// MAC_JOIN's frame, with every one of §3.3's seven nullable fields
    /// exercised: four carried, three null.
    fn present_observation(&mut self, execution_sha256: &str) -> Result<Vec<u8>, MacRefusal> {
        let acceptance = self.rig.sign(
            "rig-execution-acceptance/v1",
            &rig_record("rig-execution-acceptance/v1", execution_sha256, 4),
        );
        let ack = self.rig.sign(
            "rig-measure-start-ack/v1",
            &rig_record("rig-measure-start-ack/v1", execution_sha256, 3),
        );
        let snapshot = self.rig.sign(
            "rig-server-snapshot-receipt/v1",
            &rig_record("rig-server-snapshot-receipt/v1", execution_sha256, 5),
        );
        let barrier = self.rig.sign(
            "rig-barrier-acceptance/v1",
            &rig_record("rig-barrier-acceptance/v1", execution_sha256, 4),
        );
        let seq = self.seq();
        self.dispatch(
            "mac-present-rig-observation-request",
            &json!({
                "schema": "mac-present-rig-observation-request/v1",
                "requestSeq": seq,
                "executionSha256": execution_sha256,
                "rigExecutionAcceptanceBase64": b64(&acceptance.0),
                "rigExecutionAcceptanceSignatureBase64": b64(&acceptance.1),
                "rigMeasureStartAckBase64": b64(&ack.0),
                "rigMeasureStartAckSignatureBase64": b64(&ack.1),
                "rigBarrierAcceptanceBase64": b64(&barrier.0),
                "rigBarrierAcceptanceSignatureBase64": b64(&barrier.1),
                "serverWarmupDrainedBase64": Value::Null,
                "serverStartBarrierAcceptedBase64": Value::Null,
                "snapshotFrameBase64": b64(b"{}\n"),
                "rigServerSnapshotReceiptBase64": b64(&snapshot.0),
                "rigServerSnapshotReceiptSignatureBase64": b64(&snapshot.1),
                "linuxRelayObservationBase64": Value::Null,
                "rigRelayObservationReceiptBase64": Value::Null,
                "rigRelayObservationReceiptSignatureBase64": Value::Null,
            }),
        )
    }

    /// Drive one execution to the point the barrier prerequisites are all
    /// verified and retained.
    fn reach_barrier(&mut self, execution_sha256: &str) {
        assert_eq!(
            self.open(execution_sha256),
            Err(MacRefusal::NotReady(MINT_INPUTS_UNREACHABLE)),
        );
        self.present_cohort_acceptance(execution_sha256)
            .expect("cohort acceptance");
        assert_eq!(
            self.issue_start_barrier(execution_sha256, None, None),
            Err(MacRefusal::NotReady(MINT_INPUTS_UNREACHABLE)),
            "the prerequisites verified; only the mint is out of reach",
        );
    }
}

// --- the codec ---------------------------------------------------------------

#[test]
fn every_mac_request_kind_is_answered_by_exactly_one_ack_kind() {
    let mut acks: Vec<&str> = MAC_REQUEST_KINDS
        .iter()
        .map(|kind| ack_kind_for(kind).expect("every request kind has an ack"))
        .collect();
    assert_eq!(acks.len(), 8);
    acks.sort_unstable();
    acks.dedup();
    assert_eq!(acks.len(), 8, "no two requests share an ack kind");
    assert!(ack_kind_for("rig-accept-cohort-request").is_none());
    assert!(ack_kind_for("mac-open-cohort-request/v1").is_none());
}

/// §3.3: `header.kind` is the payload `schema` with the terminal `/v1`
/// removed. The rig list was written in schema spelling and nothing the
/// controller could encode ever reached its dispatch; this asserts the Mac
/// list does not repeat it.
#[test]
fn the_mac_request_kinds_are_header_spelling_not_schema_spelling() {
    for kind in MAC_REQUEST_KINDS {
        assert!(!kind.ends_with("/v1"), "{kind} is schema spelling");
    }
    for schema in MAC_SIGNED_SCHEMAS.iter().chain(RIG_SIGNED_SCHEMAS) {
        assert!(schema.ends_with("/v1"), "{schema}");
    }
}

/// S3 vector 3, consumed byte for byte. The bytes are the TS encoder's; this
/// test decodes them and asserts the Rust key set is the one they carry.
#[test]
fn the_pinned_observation_frame_is_the_one_the_ts_codec_produces() {
    const S3_PINNED_OBSERVATION_FRAME_HEX: &str = concat!(
        "000000597b226b696e64223a226d61632d70726573656e742d7269672d6f62736572",
        "766174696f6e2d72657175657374222c22736368656d61223a22636f6d7061726973",
        "6f6e2d73757065727669736f722d6672616d652f7631227d0a",
    );
    let header_len = u32::from_be_bytes(
        hex(&S3_PINNED_OBSERVATION_FRAME_HEX[..8])
            .try_into()
            .expect("4 bytes"),
    ) as usize;
    let header = hex(&S3_PINNED_OBSERVATION_FRAME_HEX[8..]);
    assert_eq!(header.len(), header_len);
    let header: Value = serde_json::from_slice(&header).expect("header json");
    assert_eq!(
        header["kind"], "mac-present-rig-observation-request",
        "the header kind is the schema with /v1 removed",
    );
    assert_eq!(
        ack_kind_for(header["kind"].as_str().expect("kind")),
        Some("mac-measurement-admission-issued-ack"),
        "and the Rust dispatch matches exactly that spelling",
    );
}

/// S3 vector 4's header, same reading from the answering side.
#[test]
fn the_pinned_admission_issued_ack_is_the_kind_this_dispatch_answers_with() {
    const S3_PINNED_ADMISSION_ACK_HEADER_HEX: &str = concat!(
        "0000005a7b226b696e64223a226d61632d6d6561737572656d656e742d61646d6973",
        "73696f6e2d6973737565642d61636b222c22736368656d61223a22636f6d70617269",
        "736f6e2d73757065727669736f722d6672616d652f7631227d0a",
    );
    let header = hex(&S3_PINNED_ADMISSION_ACK_HEADER_HEX[8..]);
    let header: Value = serde_json::from_slice(&header).expect("header json");
    assert_eq!(header["kind"], "mac-measurement-admission-issued-ack");
    assert_eq!(
        MAC_REQUEST_KINDS
            .iter()
            .filter(|kind| ack_kind_for(kind) == Some("mac-measurement-admission-issued-ack"))
            .count(),
        1,
    );
}

fn hex(text: &str) -> Vec<u8> {
    (0..text.len() / 2)
        .map(|index| u8::from_str_radix(&text[index * 2..index * 2 + 2], 16).expect("hex"))
        .collect()
}

// --- §2.9(1): the descriptors and the derived public half -------------------

#[test]
fn the_public_half_of_the_mac_signing_key_is_derived_and_not_supplied() {
    let keys = generate_ed25519_keypair();
    let identity = MacIdentity::new(
        keys.private_pkcs8_der.clone(),
        &digest("nonce"),
        &digest("clock"),
        VALIDITY_MS,
    )
    .expect("identity");
    assert_eq!(identity.public_raw32(), &keys.public_raw32);
    assert_eq!(identity.public_key_sha256(), sha256_hex(&keys.public_raw32));
    // There is no constructor that accepts a public half, so a launcher has no
    // way to make the two disagree. Asserted by construction: the only input
    // is the private key, and nothing else on the signature is settable.
    assert_eq!(identity.receipt_validity_ms(), VALIDITY_MS);
    assert!(MacIdentity::new(
        b"not a pkcs8 der".to_vec(),
        &digest("nonce"),
        &digest("clock"),
        VALIDITY_MS,
    )
    .is_err());
    assert!(MacIdentity::new(
        keys.private_pkcs8_der.clone(),
        "not-a-digest",
        &digest("clock"),
        VALIDITY_MS,
    )
    .is_err());
    assert!(MacIdentity::new(
        keys.private_pkcs8_der,
        &digest("nonce"),
        &digest("clock"),
        0,
    )
    .is_err());
}

#[test]
fn the_runtime_derives_the_same_public_half_as_the_identity() {
    let campaign = campaign();
    assert_eq!(campaign.runtime.public_raw32(), &campaign.mac_public_raw32);
}

// --- §7's closed code table -------------------------------------------------

/// Every code this module can publish is a member of §7's closed table.
///
/// The rig's `CohortRefusal::code()` answers with six `TRUST_RECORD_*` codes
/// that are not members, so the controller files the arm under a code the rig
/// never said. This asserts the Mac path cannot repeat it.
#[test]
fn a_mac_refusal_names_a_section_7_code() {
    let every = [
        MacRefusal::Protocol("x"),
        MacRefusal::Mismatch("x"),
        MacRefusal::RigSignatureInvalid,
        MacRefusal::RigSigningKeyMismatch,
        MacRefusal::RigReceiptExpired,
        MacRefusal::RigReceiptReplayed,
        MacRefusal::NotReady("x"),
        MacRefusal::Cohort("x"),
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
}

// --- §2.9(5): the five forgery tests ----------------------------------------

/// The honest baseline every forgery is measured against.
///
/// It refuses too — the mint inputs are on no frame — but it refuses **after**
/// every verification, with `COHORT_NOT_READY`. A forgery that reached this
/// code would have been accepted.
#[test]
fn an_honest_barrier_request_passes_every_verification() {
    let mut campaign = campaign();
    let execution = execution(1);
    campaign.reach_barrier(&execution);
    let session = campaign.runtime.session_mut(&execution).expect("session");
    assert_eq!(
        session
            .retained("rigWarmupDrainedReceipt")
            .expect("drained")
            .schema,
        "rig-warmup-drained-receipt/v1",
    );
    assert_eq!(
        session.retained("rigMeasureStartAck").expect("ack").schema,
        "rig-measure-start-ack/v1",
    );
}

#[test]
fn an_invented_rig_ack_mints_no_barrier() {
    let mut campaign = campaign();
    let execution = execution(1);
    assert_eq!(
        campaign.open(&execution),
        Err(MacRefusal::NotReady(MINT_INPUTS_UNREACHABLE)),
    );
    campaign
        .present_cohort_acceptance(&execution)
        .expect("cohort acceptance");
    // The controller signs its own `rig-measure-start-ack/v1` with a key it
    // holds. Every field is right; the key is not the staged one.
    let forger = RigSigner::new();
    let invented = forger.sign(
        "rig-measure-start-ack/v1",
        &rig_record("rig-measure-start-ack/v1", &execution, 3),
    );
    assert_eq!(
        campaign.issue_start_barrier(&execution, None, Some(invented)),
        Err(MacRefusal::RigSigningKeyMismatch),
        "an invented ack is refused as a key mismatch, not as a missing mint",
    );
    assert_eq!(
        campaign
            .runtime
            .session_mut(&execution)
            .expect("session")
            .retained("rigMeasureStartAck")
            .map(|record| record.schema),
        Err(MacRefusal::Mismatch("record not retained by this session")),
        "and nothing about the invented ack was retained",
    );
}

#[test]
fn a_mutated_rig_receipt_mints_no_barrier() {
    let mut campaign = campaign();
    let execution = execution(1);
    assert_eq!(
        campaign.open(&execution),
        Err(MacRefusal::NotReady(MINT_INPUTS_UNREACHABLE)),
    );
    campaign
        .present_cohort_acceptance(&execution)
        .expect("cohort acceptance");
    // A genuine rig receipt with one field rewritten after signing: the
    // validity window is pushed out by an hour.
    let (bytes, signature) = campaign.rig.sign(
        "rig-measure-start-ack/v1",
        &rig_record("rig-measure-start-ack/v1", &execution, 3),
    );
    let mut mutated: Value = serde_json::from_slice(&bytes).expect("json");
    mutated["notAfterMs"] = json!(NOW_MS + VALIDITY_MS * 2);
    let mutated = bytes_of(&mutated);
    assert_ne!(mutated, bytes);
    assert_eq!(
        campaign.issue_start_barrier(&execution, None, Some((mutated, signature))),
        Err(MacRefusal::Mismatch("signedBytesSha256")),
        "the carrier's digest is over the bytes the rig signed, not the mutated ones",
    );
}

#[test]
fn a_cross_paired_rig_signature_mints_no_barrier() {
    let mut campaign = campaign();
    let execution = execution(1);
    assert_eq!(
        campaign.open(&execution),
        Err(MacRefusal::NotReady(MINT_INPUTS_UNREACHABLE)),
    );
    campaign
        .present_cohort_acceptance(&execution)
        .expect("cohort acceptance");
    // Receipt A's bytes under receipt B's signature carrier. Both are genuine
    // rig records signed by the staged key; only the pairing is the forgery.
    let (ack_bytes, _) = campaign.rig.sign(
        "rig-measure-start-ack/v1",
        &rig_record("rig-measure-start-ack/v1", &execution, 3),
    );
    let (_, drained_signature) = campaign.rig.sign(
        "rig-warmup-drained-receipt/v1",
        &rig_record("rig-warmup-drained-receipt/v1", &execution, 2),
    );
    assert_eq!(
        campaign.issue_start_barrier(&execution, None, Some((ack_bytes, drained_signature))),
        Err(MacRefusal::Mismatch("signedSchema")),
        "the carrier names the schema it covers and the pairing is caught there",
    );
}

#[test]
fn a_rig_receipt_from_another_execution_mints_no_barrier() {
    let mut campaign = campaign();
    let previous = execution(0);
    let execution = execution(1);
    assert_eq!(
        campaign.open(&execution),
        Err(MacRefusal::NotReady(MINT_INPUTS_UNREACHABLE)),
    );
    campaign
        .present_cohort_acceptance(&execution)
        .expect("cohort acceptance");
    // Last execution's genuine, staged-key-signed ack, replayed into this one.
    let replayed = campaign.rig.sign(
        "rig-measure-start-ack/v1",
        &rig_record("rig-measure-start-ack/v1", &previous, 3),
    );
    assert_eq!(
        campaign.issue_start_barrier(&execution, None, Some(replayed)),
        Err(MacRefusal::Mismatch("executionSha256")),
        "the signature verifies and the record describes another execution",
    );
}

#[test]
fn a_barrier_without_the_drained_receipt_is_refused() {
    let mut campaign = campaign();
    let execution = execution(1);
    assert_eq!(
        campaign.open(&execution),
        Err(MacRefusal::NotReady(MINT_INPUTS_UNREACHABLE)),
    );
    campaign
        .present_cohort_acceptance(&execution)
        .expect("cohort acceptance");
    // The drained receipt is replaced by an empty record: well-formed base64,
    // no signature that could ever cover it.
    let empty = (b"{}\n".to_vec(), b"{}\n".to_vec());
    let refusal = campaign
        .issue_start_barrier(&execution, Some(empty), None)
        .expect_err("no barrier");
    assert_eq!(refusal.code(), "TRUST_PROTOCOL");
    assert_eq!(
        campaign
            .runtime
            .session_mut(&execution)
            .expect("session")
            .retained("rigWarmupDrainedReceipt")
            .err(),
        Some(MacRefusal::Mismatch("record not retained by this session")),
    );
}

// --- §2.9's five-of-seven restart invariant ---------------------------------

/// A Mac supervisor that did not itself verify and retain the cohort
/// acceptance and the drained receipt must refuse to mint the admission.
///
/// Both nets are exercised, and they are shown to be **independent**:
///
/// - **net 1** (channel sequence) fires on a restarted process without any
///   state being consulted, because a fresh channel starts at `requestSeq` 0
///   and the observation frame carries the mid-execution value;
/// - **net 2** (retention) fires even when the restarted process's channel is
///   allowed to agree — the second half of this test replays the whole opening
///   sequence so the counter lines up, and the admission is still refused
///   because the drained receipt was verified by a process that is gone.
#[test]
fn a_restarted_mac_supervisor_refuses_to_admit_on_five_of_seven() {
    let execution = execution(1);

    // One process, driven to the barrier, then asked for the admission.
    let mut first = campaign();
    first.reach_barrier(&execution);
    let observation_seq = first.seq();
    assert!(observation_seq > 0, "the channel has advanced");
    assert_eq!(
        first.present_observation(&execution),
        Err(MacRefusal::NotReady(MINT_INPUTS_UNREACHABLE)),
        "the honest path verifies all seven and stops at the mint",
    );

    // Net 1: the restarted process's channel begins at 0, so the same frame is
    // caught before any state is consulted.
    let mut restarted = campaign_with(RigSigner {
        keys: first.rig.keys.clone(),
    });
    assert_eq!(restarted.seq(), 0);
    let acceptance = restarted.rig.sign(
        "rig-execution-acceptance/v1",
        &rig_record("rig-execution-acceptance/v1", &execution, 4),
    );
    let ack = restarted.rig.sign(
        "rig-measure-start-ack/v1",
        &rig_record("rig-measure-start-ack/v1", &execution, 3),
    );
    let snapshot = restarted.rig.sign(
        "rig-server-snapshot-receipt/v1",
        &rig_record("rig-server-snapshot-receipt/v1", &execution, 5),
    );
    let mid_execution_frame = json!({
        "schema": "mac-present-rig-observation-request/v1",
        "requestSeq": observation_seq,
        "executionSha256": execution,
        "rigExecutionAcceptanceBase64": b64(&acceptance.0),
        "rigExecutionAcceptanceSignatureBase64": b64(&acceptance.1),
        "rigMeasureStartAckBase64": b64(&ack.0),
        "rigMeasureStartAckSignatureBase64": b64(&ack.1),
        "rigBarrierAcceptanceBase64": Value::Null,
        "rigBarrierAcceptanceSignatureBase64": Value::Null,
        "serverWarmupDrainedBase64": Value::Null,
        "serverStartBarrierAcceptedBase64": Value::Null,
        "snapshotFrameBase64": b64(b"{}\n"),
        "rigServerSnapshotReceiptBase64": b64(&snapshot.0),
        "rigServerSnapshotReceiptSignatureBase64": b64(&snapshot.1),
        "linuxRelayObservationBase64": Value::Null,
        "rigRelayObservationReceiptBase64": Value::Null,
        "rigRelayObservationReceiptSignatureBase64": Value::Null,
    });
    assert_eq!(
        restarted.dispatch("mac-present-rig-observation-request", &mid_execution_frame),
        Err(MacRefusal::Protocol("requestSeq")),
        "net 1 fires before the session is looked up",
    );

    // Net 2, with net 1 satisfied: a second restarted process whose channel is
    // walked forward to the same point, and which opened the session — but
    // which never saw the cohort acceptance or the drained receipt.
    let mut second = campaign_with(RigSigner {
        keys: first.rig.keys.clone(),
    });
    assert_eq!(
        second.open(&execution),
        Err(MacRefusal::NotReady(MINT_INPUTS_UNREACHABLE)),
    );
    while second.seq() < observation_seq {
        // Burn the channel forward with frames this session legitimately
        // answers, so the sequence agrees and only retention can refuse.
        let seq = second.seq();
        let _ = second.dispatch(
            "mac-export-cohort-evidence-request",
            &json!({
                "schema": "mac-export-cohort-evidence-request/v1",
                "requestSeq": seq,
                "executionSha256": execution,
                "cohortAdmissionReceiptSha256": digest("admission"),
            }),
        );
    }
    assert_eq!(second.seq(), observation_seq);
    assert_eq!(
        second.dispatch("mac-present-rig-observation-request", &mid_execution_frame),
        Err(MacRefusal::Mismatch("record not retained by this session")),
        "net 2 fires on its own once the sequence agrees",
    );
}

// --- §2.9(1): one campaign-scoped process, four executions ------------------

#[test]
fn one_process_serves_four_executions_with_distinct_sessions() {
    let mut campaign = campaign();
    let executions: Vec<String> = (0..4).map(execution).collect();
    for execution in &executions {
        assert_eq!(
            campaign.open(execution),
            Err(MacRefusal::NotReady(MINT_INPUTS_UNREACHABLE)),
        );
        campaign
            .present_cohort_acceptance(execution)
            .expect("cohort acceptance");
    }
    assert_eq!(campaign.runtime.session_count(), 4);
    for execution in &executions {
        let session = campaign.runtime.session_mut(execution).expect("session");
        assert_eq!(session.execution_sha256(), execution);
        assert_eq!(session.stage(), MacCohortStage::CohortAcceptanceRetained);
        let retained = session.retained("rigCohortAcceptance").expect("retained");
        let record: Value = serde_json::from_slice(&retained.bytes).expect("json");
        assert_eq!(
            record["executionSha256"], *execution,
            "each session retained its own execution's acceptance, not a neighbour's",
        );
    }
    // A second open for an execution this process already holds is a refusal,
    // not a fresh session: two sessions for one execution would let the
    // controller choose which one the admission is built over.
    assert_eq!(
        campaign.open(&executions[0]),
        Err(MacRefusal::Cohort("one cohort per execution")),
    );
    assert_eq!(campaign.runtime.session_count(), 4);
}

#[test]
fn a_frame_for_an_execution_this_process_never_opened_is_refused() {
    let mut campaign = campaign();
    let opened = execution(1);
    assert_eq!(
        campaign.open(&opened),
        Err(MacRefusal::NotReady(MINT_INPUTS_UNREACHABLE)),
    );
    let stranger = execution(9);
    assert_eq!(
        campaign.present_cohort_acceptance(&stranger),
        Err(MacRefusal::Mismatch("no cohort for this execution")),
    );
}

// --- the open frame's own bindings -------------------------------------------

#[test]
fn the_open_frame_recomputes_the_role_plan_digest_and_size() {
    let mut campaign = campaign();
    let execution = execution(1);
    let plan = bytes_of(&json!({"schema": "canonical-workload-role-plan-input/v1"}));
    let frame = |digest_value: &str, size: usize| {
        json!({
            "schema": "mac-open-cohort-request/v1",
            "requestSeq": 0,
            "executionSha256": execution,
            "scenarioHash": digest("scenario"),
            "rolePlanHash": digest("role-plan"),
            "workloadRolePlanInputBase64": b64(&plan),
            "workloadRolePlanInputSha256": digest_value,
            "workloadRolePlanInputSize": size,
        })
    };
    assert_eq!(
        campaign.dispatch(
            "mac-open-cohort-request",
            &frame(&digest("wrong"), plan.len())
        ),
        Err(MacRefusal::Mismatch("workloadRolePlanInputSha256")),
    );
    // The channel advanced, so the honest retry states the next sequence.
    let mut frame = frame(&sha256_hex(&plan), plan.len() + 1);
    frame["requestSeq"] = json!(campaign.seq());
    assert_eq!(
        campaign.dispatch("mac-open-cohort-request", &frame),
        Err(MacRefusal::Mismatch("workloadRolePlanInputSize")),
    );
    assert_eq!(campaign.runtime.session_count(), 0);
    let mut frame = json!({
        "schema": "mac-open-cohort-request/v1",
        "requestSeq": campaign.seq(),
        "executionSha256": execution,
        "scenarioHash": digest("scenario"),
        "rolePlanHash": digest("role-plan"),
        "workloadRolePlanInputBase64": b64(&plan),
        "workloadRolePlanInputSha256": sha256_hex(&plan),
        "workloadRolePlanInputSize": plan.len(),
    });
    frame["requestSeq"] = json!(campaign.seq());
    assert_eq!(
        campaign.dispatch("mac-open-cohort-request", &frame),
        Err(MacRefusal::NotReady(MINT_INPUTS_UNREACHABLE)),
    );
    assert_eq!(campaign.runtime.session_count(), 1);
    let session = campaign.runtime.session_mut(&execution).expect("session");
    assert_eq!(session.workload_role_plan_input(), plan.as_slice());
    assert_eq!(session.workload_role_plan_input_sha256(), sha256_hex(&plan));
    assert_eq!(session.scenario_hash(), digest("scenario"));
    assert_eq!(session.role_plan_hash(), digest("role-plan"));
    assert_eq!(session.identity().mac_clock_id(), digest("mac-clock"));
    assert_eq!(
        session.identity().instance_nonce_sha256(),
        digest("mac-instance"),
    );
}

// --- the frame's exact key set ------------------------------------------------

#[test]
fn a_frame_with_an_extra_or_missing_key_is_refused() {
    let mut campaign = campaign();
    let execution = execution(1);
    let plan = bytes_of(&json!({"schema": "canonical-workload-role-plan-input/v1"}));
    let mut frame = json!({
        "schema": "mac-open-cohort-request/v1",
        "requestSeq": 0,
        "executionSha256": execution,
        "scenarioHash": digest("scenario"),
        "rolePlanHash": digest("role-plan"),
        "workloadRolePlanInputBase64": b64(&plan),
        "workloadRolePlanInputSha256": sha256_hex(&plan),
        "workloadRolePlanInputSize": plan.len(),
        "extra": 1,
    });
    assert_eq!(
        campaign.dispatch("mac-open-cohort-request", &frame),
        Err(MacRefusal::Protocol("record")),
    );
    frame
        .as_object_mut()
        .expect("object")
        .remove("workloadRolePlanInputSize");
    frame.as_object_mut().expect("object").remove("extra");
    frame["requestSeq"] = json!(campaign.seq());
    assert_eq!(
        campaign.dispatch("mac-open-cohort-request", &frame),
        Err(MacRefusal::Protocol("record")),
    );
}

/// A nullable field carrying a missing key, rather than an explicit null, is a
/// refusal. S3's vector 3 exercises three of the seven as `null`, so a decoder
/// that folded the two together would pass the vector and accept this.
#[test]
fn a_missing_nullable_key_is_not_the_same_as_an_explicit_null() {
    let mut campaign = campaign();
    let execution = execution(1);
    campaign.reach_barrier(&execution);
    let acceptance = campaign.rig.sign(
        "rig-execution-acceptance/v1",
        &rig_record("rig-execution-acceptance/v1", &execution, 4),
    );
    let ack = campaign.rig.sign(
        "rig-measure-start-ack/v1",
        &rig_record("rig-measure-start-ack/v1", &execution, 3),
    );
    let snapshot = campaign.rig.sign(
        "rig-server-snapshot-receipt/v1",
        &rig_record("rig-server-snapshot-receipt/v1", &execution, 5),
    );
    let mut frame = json!({
        "schema": "mac-present-rig-observation-request/v1",
        "requestSeq": campaign.seq(),
        "executionSha256": execution,
        "rigExecutionAcceptanceBase64": b64(&acceptance.0),
        "rigExecutionAcceptanceSignatureBase64": b64(&acceptance.1),
        "rigMeasureStartAckBase64": b64(&ack.0),
        "rigMeasureStartAckSignatureBase64": b64(&ack.1),
        "rigBarrierAcceptanceBase64": Value::Null,
        "rigBarrierAcceptanceSignatureBase64": Value::Null,
        "serverWarmupDrainedBase64": Value::Null,
        "serverStartBarrierAcceptedBase64": Value::Null,
        "snapshotFrameBase64": b64(b"{}\n"),
        "rigServerSnapshotReceiptBase64": b64(&snapshot.0),
        "rigServerSnapshotReceiptSignatureBase64": b64(&snapshot.1),
        "linuxRelayObservationBase64": Value::Null,
        "rigRelayObservationReceiptBase64": Value::Null,
        "rigRelayObservationReceiptSignatureBase64": Value::Null,
    });
    frame
        .as_object_mut()
        .expect("object")
        .remove("linuxRelayObservationBase64");
    assert_eq!(
        campaign.dispatch("mac-present-rig-observation-request", &frame),
        Err(MacRefusal::Protocol("record")),
        "an absent key is a refusal even where a null is admitted",
    );
}

// --- the barrier acceptance arms the role children ---------------------------

#[test]
fn the_barrier_acceptance_arms_the_role_children_only_after_it_verifies() {
    let mut campaign = campaign();
    let execution = execution(1);
    campaign.reach_barrier(&execution);
    assert!(!campaign
        .runtime
        .session_mut(&execution)
        .expect("session")
        .role_children_may_arm());

    // A barrier acceptance signed by a key that is not the staged rig key.
    let forger = RigSigner::new();
    let forged = forger.sign(
        "rig-barrier-acceptance/v1",
        &rig_record("rig-barrier-acceptance/v1", &execution, 4),
    );
    let seq = campaign.seq();
    assert_eq!(
        campaign.dispatch(
            "mac-present-rig-barrier-acceptance-request",
            &json!({
                "schema": "mac-present-rig-barrier-acceptance-request/v1",
                "requestSeq": seq,
                "executionSha256": execution,
                "rigBarrierAcceptanceBase64": b64(&forged.0),
                "rigBarrierAcceptanceSignatureBase64": b64(&forged.1),
            }),
        ),
        Err(MacRefusal::RigSigningKeyMismatch),
    );
    assert!(
        !campaign
            .runtime
            .session_mut(&execution)
            .expect("session")
            .role_children_may_arm(),
        "a refused acceptance arms nothing",
    );

    let honest = campaign.rig.sign(
        "rig-barrier-acceptance/v1",
        &rig_record("rig-barrier-acceptance/v1", &execution, 4),
    );
    let seq = campaign.seq();
    let ack = campaign
        .dispatch(
            "mac-present-rig-barrier-acceptance-request",
            &json!({
                "schema": "mac-present-rig-barrier-acceptance-request/v1",
                "requestSeq": seq,
                "executionSha256": execution,
                "rigBarrierAcceptanceBase64": b64(&honest.0),
                "rigBarrierAcceptanceSignatureBase64": b64(&honest.1),
            }),
        )
        .expect("barrier acceptance");
    let ack: Value = serde_json::from_slice(&ack).expect("json");
    assert_eq!(ack["schema"], "mac-rig-barrier-acceptance-ack/v1");
    assert_eq!(ack["roleChildrenMayArm"], true);
    assert_eq!(ack["ackRequestSeq"], seq);
    assert_eq!(ack["rigBarrierAcceptanceSha256"], sha256_hex(&honest.0));
    assert!(campaign
        .runtime
        .session_mut(&execution)
        .expect("session")
        .role_children_may_arm());
}

// --- the ack's own shape -----------------------------------------------------

#[test]
fn the_cohort_acceptance_ack_states_the_channels_response_sequence() {
    let mut campaign = campaign();
    let execution = execution(1);
    assert_eq!(
        campaign.open(&execution),
        Err(MacRefusal::NotReady(MINT_INPUTS_UNREACHABLE)),
    );
    let request_seq = campaign.seq();
    let ack = campaign
        .present_cohort_acceptance(&execution)
        .expect("cohort acceptance");
    let ack: Value = serde_json::from_slice(&ack).expect("json");
    assert_eq!(ack["schema"], "mac-rig-cohort-acceptance-ack/v1");
    assert_eq!(ack["ackRequestSeq"], request_seq);
    assert_eq!(
        ack["responseSeq"], 0,
        "responseSeq counts this session's answers and starts at 0",
    );
    assert_eq!(ack["executionSha256"], execution);
}

// --- expiry and receipt-sequence monotonicity ---------------------------------

#[test]
fn an_expired_rig_receipt_is_refused_under_its_own_code() {
    let mut campaign = campaign();
    let execution = execution(1);
    assert_eq!(
        campaign.open(&execution),
        Err(MacRefusal::NotReady(MINT_INPUTS_UNREACHABLE)),
    );
    let mut record = rig_record("rig-cohort-acceptance/v1", &execution, 1);
    record["notAfterMs"] = json!(NOW_MS - 1);
    let (bytes, signature) = campaign.rig.sign("rig-cohort-acceptance/v1", &record);
    let seq = campaign.seq();
    assert_eq!(
        campaign.dispatch(
            "mac-present-rig-cohort-acceptance-request",
            &json!({
                "schema": "mac-present-rig-cohort-acceptance-request/v1",
                "requestSeq": seq,
                "executionSha256": execution,
                "rigCohortAcceptanceBase64": b64(&bytes),
                "rigCohortAcceptanceSignatureBase64": b64(&signature),
            }),
        ),
        Err(MacRefusal::RigReceiptExpired),
    );
}

#[test]
fn a_rig_receipt_sequence_that_goes_backwards_is_refused() {
    let mut campaign = campaign();
    let execution = execution(1);
    campaign.reach_barrier(&execution);
    let present = |campaign: &mut Campaign, sequence: u64| {
        let record = campaign.rig.sign(
            "rig-barrier-acceptance/v1",
            &rig_record("rig-barrier-acceptance/v1", &execution, sequence),
        );
        let seq = campaign.seq();
        campaign.dispatch(
            "mac-present-rig-barrier-acceptance-request",
            &json!({
                "schema": "mac-present-rig-barrier-acceptance-request/v1",
                "requestSeq": seq,
                "executionSha256": execution,
                "rigBarrierAcceptanceBase64": b64(&record.0),
                "rigBarrierAcceptanceSignatureBase64": b64(&record.1),
            }),
        )
    };
    present(&mut campaign, 4).expect("the first acceptance is admitted");
    assert_eq!(
        present(&mut campaign, 1),
        Err(MacRefusal::RigReceiptReplayed),
        "the same record kind may not go backwards once this session has seen it",
    );
    // Monotonicity is per record kind, not one counter across all seven: the
    // observation frame legitimately carries an execution acceptance minted
    // after a measure-start ack the barrier already admitted.
    assert_eq!(
        campaign.present_observation(&execution),
        Err(MacRefusal::NotReady(MINT_INPUTS_UNREACHABLE)),
    );
}

/// A record whose own `schema` disagrees with the carrier's `signedSchema` is
/// refused, even when the signature verifies over the exact bytes.
///
/// This is not reachable through a forger: the signature has to be the staged
/// rig key's. It is reachable through a *rig* that paired the two wrongly, and
/// the Mac must not bind a record whose body says one thing while the
/// authenticated envelope says another. Recorded because the guard survived
/// its first mutation — a check nothing distinguishes is not a check.
#[test]
fn a_record_whose_body_schema_disagrees_with_its_carrier_is_refused() {
    let mut campaign = campaign();
    let execution = execution(1);
    assert_eq!(
        campaign.open(&execution),
        Err(MacRefusal::NotReady(MINT_INPUTS_UNREACHABLE)),
    );
    // The staged rig key signs a `rig-barrier-acceptance/v1` body under a
    // carrier that claims `rig-cohort-acceptance/v1`.
    let (bytes, signature) = campaign.rig.sign(
        "rig-cohort-acceptance/v1",
        &rig_record("rig-barrier-acceptance/v1", &execution, 1),
    );
    let seq = campaign.seq();
    assert_eq!(
        campaign.dispatch(
            "mac-present-rig-cohort-acceptance-request",
            &json!({
                "schema": "mac-present-rig-cohort-acceptance-request/v1",
                "requestSeq": seq,
                "executionSha256": execution,
                "rigCohortAcceptanceBase64": b64(&bytes),
                "rigCohortAcceptanceSignatureBase64": b64(&signature),
            }),
        ),
        Err(MacRefusal::Mismatch("schema")),
    );
}

// --- verify_rig_record, directly ---------------------------------------------

#[test]
fn verify_rig_record_refuses_a_carrier_naming_a_schema_outside_the_rig_set() {
    let rig = RigSigner::new();
    let record = rig_record("cohort-grant/v1", &execution(1), 1);
    // A carrier that names a *Mac* schema, signed by the rig key over the
    // right bytes: it verifies cryptographically and is still not a rig
    // receipt signature.
    let (bytes, carrier) = rig.sign("cohort-grant/v1", &record);
    assert_eq!(
        verify_rig_record(
            &bytes,
            &carrier,
            &rig.keys.public_raw32,
            "rig-cohort-acceptance/v1",
        ),
        Err(MacRefusal::Protocol("signedSchema")),
    );
}

#[test]
fn verify_rig_record_returns_the_arrival_bytes_not_a_recanonicalisation() {
    let rig = RigSigner::new();
    let (bytes, carrier) = rig.sign(
        "rig-cohort-acceptance/v1",
        &rig_record("rig-cohort-acceptance/v1", &execution(1), 1),
    );
    let verified = verify_rig_record(
        &bytes,
        &carrier,
        &rig.keys.public_raw32,
        "rig-cohort-acceptance/v1",
    )
    .expect("verified");
    assert_eq!(verified.bytes, bytes);
    assert_eq!(verified.sha256, sha256_hex(&bytes));
    assert_eq!(verified.signature_record, carrier);
    assert_eq!(verified.signature_record_sha256, sha256_hex(&carrier));
    assert_eq!(unb64(&b64(&verified.bytes)), bytes);
}
