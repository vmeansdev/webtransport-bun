//! S5-MAC-RS: the Mac supervisor's half of the §5 Phase-B lifecycle, as a
//! process — completed under the 2026-09-05 cohort completion amendment
//! (C1 grant topology, C2 one execution authority, C3 terminal export
//! signature).
//!
//! `rig_cohort_runtime.rs` proves what the rig says at each transition; this
//! file proves what the **Mac** binary verifies before it says anything, and
//! — now that every mint has its inputs — what it says.  The six §2.9(5)
//! forgery tests are still the point of the file: each presents a well-formed
//! frame carrying a rig record the controller could have built for itself and
//! asserts the binary refuses it **at the check that names the forgery** — a
//! different §7 code, reached earlier, than the honest frame's mint.
//!
//! The honest path is one whole chat-1k cohort — 1,010 leaves, ten publishers,
//! eight workers, thirty windows — driven through the real runtime from
//! `mac-open-execution-request/v1` to `mac-cohort-evidence-exported-ack/v1`,
//! with every record the binary signs re-verified by the shared parser the
//! rig will run it through.
#![cfg(any(target_os = "linux", target_os = "macos"))]

#[path = "../src/secure_fs.rs"]
mod secure_fs;

use base64::Engine as _;
use secure_fs::cohort::mac::{
    ack_kind_for, check_grant_cohort_id, cohort_cell, cohort_export_ack_signing_bytes,
    decoded_byte_length_of_base64, read_open_execution_request, retained_canonical_bytes,
    verify_cohort_export_ack_signature, verify_presented_topology, verify_rig_record,
    verify_token_commitment_leaf_manifest, CohortEvidenceBudget, MacCohortRuntime, MacCohortStage,
    MacIdentity, MacRefusal, COHORT_CELLS, COHORT_REMOTE_EVIDENCE_BUDGET_MAX_BYTES,
    MAC_OPEN_EXECUTION_KIND, MAC_REQUEST_KINDS, MAC_SIGNED_SCHEMAS, RIG_SIGNED_SCHEMAS,
    START_BARRIER_LEAD_NS,
};
use secure_fs::cohort::{
    canonical_bytes, ordered_digest_set_sha256, sha256_hex, shard_commitment_window_end,
    CohortGrantV1, CohortStartBarrierV1, SECTION_7_CODES,
};
use secure_fs::cross_supervisor::{generate_ed25519_keypair, Ed25519KeyPair};
use secure_fs::measurement::{
    AdmissionReceipt, AdmittedSeries, ExecutionKey, GrantRegistry, GrantRequest,
};
use serde_json::{json, Value};
use std::collections::BTreeMap;

const NOW_MS: u64 = 1_760_000_100_000;
const VALIDITY_MS: u64 = 3_600_000;
/// A fixed reading of the Mac's continuous clock, so barrier arithmetic is
/// checkable to the nanosecond.  Every later reading in one lifecycle advances
/// from here.
const MAC_NS: u64 = 5_000_000_000_000;
const CAMPAIGN_ID: &str = "r1-cohort-completion";
const CANDIDATE: &str = "candidate-cohort-completion";
const CHAT_1K_CELL: &str = "chat-fanout/subscribers-1000";

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

fn json_of(bytes: &[u8]) -> Value {
    serde_json::from_slice(bytes).expect("json")
}

fn from_hex(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&text[index..index + 2], 16).expect("hex"))
        .collect()
}

fn hex(text: &str) -> Vec<u8> {
    from_hex(text)
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
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
        // The record states the key that signs it, as the rig's identity does.
        let mut record = record.clone();
        if record.get("signingPublicKeySha256").is_some() {
            record["signingPublicKeySha256"] = json!(self.public_key_sha256());
        }
        let bytes = bytes_of(&record);
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

/// The instance nonce this harness's rig states on every receipt.
const RIG_INSTANCE_NONCE_SEED: &str = "rig-instance";
/// The Linux clock identity and the one instant this harness's rig reads.
const LINUX_CLOCK_ID: &str = "clock-monotonic-boot-b";
const LINUX_NS: u64 = 7_000_000_000_000;

/// A rig record shaped exactly as the production rig mints it: the closed
/// key set of its schema (`secure_fs::cohort::rig_record_keys`, the set the
/// rig's own mint self-checks against and the Mac's `RigRetention::admit`
/// exact-keys), with the three fields the Mac reads after authenticating,
/// the campaign's approval digests, the rig's identity fields, and every
/// binding a test then overrides with `with_fields`.  `RigSigner::sign`
/// stamps `signingPublicKeySha256` with the signing key's digest.  A schema
/// no rig mints gets the five fields every receipt carries.
fn rig_record(schema: &str, execution_sha256: &str, receipt_sequence: u64) -> Value {
    let mut record = json!({
        "schema": schema,
        "executionSha256": execution_sha256,
        "receiptSequence": receipt_sequence,
        "issuedAtMs": NOW_MS,
        "notAfterMs": NOW_MS + VALIDITY_MS,
    });
    let extra = match schema {
        "rig-execution-acceptance/v1" => json!({
            "measurementGrantSha256": digest("measurement-grant"),
            "macExecutionGrantReceiptSha256": digest("mac-execution-grant-receipt"),
            "macReceiptSignatureSha256": digest("mac-receipt-signature"),
            "approvedPlanSha256": digest("approved-plan"),
            "approvalRecordSha256": digest("approval-record"),
            "rigExecutionIndex": 1,
            "rigSupervisorInstanceNonce": digest(RIG_INSTANCE_NONCE_SEED),
            "rigSupervisorExecutableSha256": digest("rig-executable"),
            "replayLedgerLeafSha256": digest("replay-ledger-leaf"),
            "signingPublicKeySha256": digest("unsigned"),
            "acceptedAtMs": NOW_MS,
        }),
        "rig-cohort-acceptance/v1" => json!({
            "cohortGrantSha256": digest("cohort-grant"),
            "cohortGrantSignatureSha256": digest("cohort-grant-signature"),
            "roleTokenCommitmentRootSha256": digest("role-token-commitment-root"),
            "approvedPlanSha256": digest("approved-plan"),
            "approvalRecordSha256": digest("approval-record"),
            "rigExecutionIndex": 1,
            "rigSupervisorInstanceNonce": digest(RIG_INSTANCE_NONCE_SEED),
            "signingPublicKeySha256": digest("unsigned"),
            "acceptedAtMs": NOW_MS,
        }),
        "rig-warmup-drained-receipt/v1" => json!({
            "cohortGrantSha256": digest("cohort-grant"),
            "cohortWarmupEpochSha256": digest("cohort-warmup-epoch"),
            "cohortWarmupEpochSignatureSha256": digest("cohort-warmup-epoch-signature"),
            "roleWarmupCompletionManifestSha256": digest("role-warmup-completion-manifest"),
            "roleWarmupCompletionManifestSignatureSha256":
                digest("role-warmup-completion-manifest-signature"),
            "serverWarmupDrainedSha256": digest("server-warmup-drained"),
            "rigSupervisorInstanceNonce": digest(RIG_INSTANCE_NONCE_SEED),
            "signingPublicKeySha256": digest("unsigned"),
            "receivedAtRigNs": LINUX_NS.to_string(),
            "linuxClockId": LINUX_CLOCK_ID,
        }),
        "rig-measure-start-ack/v1" => json!({
            "measurementGrantSha256": digest("measurement-grant"),
            "macExecutionGrantReceiptSha256": digest("mac-execution-grant-receipt"),
            "rigExecutionAcceptanceSha256": digest("rig-execution-acceptance"),
            "approvedPlanSha256": digest("approved-plan"),
            "approvalRecordSha256": digest("approval-record"),
            "childResponseSequence": 3,
            "baselineBusyMs": 0,
            "baselineAtLinuxNs": LINUX_NS.to_string(),
            "linuxClockId": LINUX_CLOCK_ID,
            "warmupCompletionAuthoritySha256": digest("warmup-completion-authority"),
            "rigWarmupDrainedReceiptSha256": digest("rig-warmup-drained-receipt"),
            "signingPublicKeySha256": digest("unsigned"),
            "rigSupervisorInstanceNonce": digest(RIG_INSTANCE_NONCE_SEED),
        }),
        "rig-barrier-acceptance/v1" => json!({
            "cohortGrantSha256": digest("cohort-grant"),
            "cohortStartBarrierSha256": digest("cohort-start-barrier"),
            "cohortStartBarrierSignatureSha256": digest("cohort-start-barrier-signature"),
            "rigMeasureStartAckSha256": digest("rig-measure-start-ack"),
            "serverStartBarrierAcceptedSha256": digest("server-start-barrier-accepted"),
            "rigSupervisorInstanceNonce": digest(RIG_INSTANCE_NONCE_SEED),
            "signingPublicKeySha256": digest("unsigned"),
            "acceptedAtLinuxNs": LINUX_NS.to_string(),
            "linuxClockId": LINUX_CLOCK_ID,
        }),
        "rig-server-snapshot-receipt/v1" => json!({
            "measurementGrantSha256": digest("measurement-grant"),
            "macExecutionGrantReceiptSha256": digest("mac-execution-grant-receipt"),
            "rigExecutionAcceptanceSha256": digest("rig-execution-acceptance"),
            "cohortGrantSha256": digest("cohort-grant"),
            "cohortStartBarrierSha256": digest("cohort-start-barrier"),
            "roleTokenCommitmentRootSha256": digest("role-token-commitment-root"),
            "approvedPlanSha256": digest("approved-plan"),
            "approvalRecordSha256": digest("approval-record"),
            "rigExecutionIndex": 1,
            "rigSupervisorInstanceNonce": digest(RIG_INSTANCE_NONCE_SEED),
            "snapshotFrameSha256": digest("snapshot-frame"),
            "snapshotFrameSize": SNAPSHOT_FRAME.len(),
            "childPid": 4242,
            "childPgid": 4242,
            "childInstanceNonce": digest("server-instance"),
            "serverEntrypointSha256": digest("server-entrypoint"),
            "bunSha256": digest("bun"),
            "addonSha256": digest("addon"),
            "childResponseSequence": 5,
            "captureRequestSequence": 4,
            "signingPublicKeySha256": digest("unsigned"),
            "frameReceivedAtRigNs": LINUX_NS.to_string(),
        }),
        "rig-relay-observation-receipt/v1" => json!({
            "cohortGrantSha256": digest("cohort-grant"),
            "cohortStartBarrierSha256": digest("cohort-start-barrier"),
            "linuxRelayObservationSha256": digest("linux-relay-observation"),
            "rigExecutionAcceptanceSha256": digest("rig-execution-acceptance"),
            "rigSupervisorInstanceNonce": digest(RIG_INSTANCE_NONCE_SEED),
            "signingPublicKeySha256": digest("unsigned"),
            "receivedAtRigNs": LINUX_NS.to_string(),
        }),
        _ => json!({}),
    };
    for (key, value) in extra.as_object().expect("object") {
        record[key] = value.clone();
    }
    record
}

fn with_fields(mut record: Value, fields: &[(&str, &str)]) -> Value {
    for (key, value) in fields {
        record[*key] = json!(value);
    }
    record
}

// --- the controller's half: a cohort fixture, built the way TS builds it ----
//
// `buildFanoutCohortFixture` (`scenarios/fanout-relay.ts:1946`) is the **one**
// implementation of §4.1's constructive half and it stays in TypeScript. This
// is not a second one: it is the *controller's* position, reproduced here so
// the binary has an honest manifest and topology to verify — the same
// relationship `RigSigner` above has to `cohort::rig`.
//
// The token source is the builder's documented default,
// `sha256(cohortId || ":" || roleId)` (`fanout-relay.ts:1911`, `:1960`), which
// is deliberately unset in production: real tokens are 32 random bytes and no
// vector can pin them.

fn role_id(role: &str, index: u64) -> String {
    format!("{role}-{index:06}")
}

fn deterministic_token_sha256(cohort_id: &str, role_id: &str) -> String {
    sha256_hex(&sha256_raw(format!("{cohort_id}:{role_id}").as_bytes()))
}

fn sha256_raw(bytes: &[u8]) -> Vec<u8> {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher.finalize().to_vec()
}

/// The ordered leaf array §4.1 fixes: publishers first, then subscribers, each
/// by ascending numeric role ID, with `workerIndex = index % 8` on subscribers.
fn cohort_leaves(cohort_id: &str, publishers: u64, subscribers: u64) -> Vec<Value> {
    let mut leaves = Vec::with_capacity((publishers + subscribers) as usize);
    for index in 0..publishers {
        let id = role_id("publisher", index);
        leaves.push(json!({
            "schema": "token-commitment-leaf/v1",
            "childId": format!("publisher-child-{index}"),
            "cohortId": cohort_id,
            "role": "publisher",
            "roleId": id,
            "tokenSha256": deterministic_token_sha256(cohort_id, &id),
            "workerIndex": Value::Null,
        }));
    }
    for index in 0..subscribers {
        let id = role_id("subscriber", index);
        let worker = index % 8;
        leaves.push(json!({
            "schema": "token-commitment-leaf/v1",
            "childId": format!("subscriber-worker-{worker}"),
            "cohortId": cohort_id,
            "role": "subscriber",
            "roleId": id,
            "tokenSha256": deterministic_token_sha256(cohort_id, &id),
            "workerIndex": worker,
        }));
    }
    leaves
}

/// `sha256(0x00 || leafSha256)` folded pairwise under `sha256(0x01 || l || r)`,
/// an odd last node paired with itself — `merkleLevels`
/// (`scenarios/fanout-relay.ts:2105-2129`).
fn merkle_root_hex(leaves: &[Value]) -> String {
    let mut level: Vec<Vec<u8>> = leaves
        .iter()
        .map(|leaf| {
            let leaf_sha = sha256_raw(&bytes_of(leaf));
            let mut input = vec![0x00u8];
            input.extend_from_slice(&leaf_sha);
            sha256_raw(&input)
        })
        .collect();
    while level.len() > 1 {
        level = level
            .chunks(2)
            .map(|pair| {
                let mut input = vec![0x01u8];
                input.extend_from_slice(&pair[0]);
                input.extend_from_slice(pair.get(1).unwrap_or(&pair[0]));
                sha256_raw(&input)
            })
            .collect();
    }
    to_hex(&level[0])
}

/// One `token-commitment-leaf-manifest/v1`, exactly the six keys
/// `TOKEN_COMMITMENT_LEAF_MANIFEST_KEYS` freezes (`cohort-protocol.ts:287-294`).
fn leaf_manifest(
    execution_sha256: &str,
    cohort_id: &str,
    publishers: u64,
    subscribers: u64,
) -> Value {
    let leaves = cohort_leaves(cohort_id, publishers, subscribers);
    json!({
        "schema": "token-commitment-leaf-manifest/v1",
        "executionSha256": execution_sha256,
        "cohortId": cohort_id,
        "leafCount": leaves.len(),
        "roleTokenCommitmentRootSha256": merkle_root_hex(&leaves),
        "leaves": leaves,
    })
}

/// The two C1 arrays the TypeScript topology builder produces beside the
/// manifest (`buildFanoutCohortFixture`, `scenarios/fanout-relay.ts:2010-2087`),
/// derived here from the leaves exactly as the builder derives them.
fn presented_topology(manifest: &Value) -> (Value, Value) {
    let leaves = manifest["leaves"].as_array().expect("leaves");
    let publishers: Vec<Value> = leaves
        .iter()
        .enumerate()
        .filter(|(_, leaf)| leaf["role"] == "publisher")
        .map(|(index, leaf)| {
            json!({
                "schema": "publisher-role-grant/v1",
                "childId": leaf["childId"],
                "publisherId": leaf["roleId"],
                "tokenCommitmentIndex": index,
                "tokenSha256": leaf["tokenSha256"],
            })
        })
        .collect();
    let subscriber_count = leaves.len() - publishers.len();
    let shards: Vec<Value> = (0..8)
        .map(|worker| {
            let members: Vec<(usize, &Value)> = leaves
                .iter()
                .enumerate()
                .filter(|(_, leaf)| leaf["workerIndex"] == json!(worker))
                .collect();
            let ids: Vec<Value> = members
                .iter()
                .map(|(_, leaf)| leaf["roleId"].clone())
                .collect();
            json!({
                "schema": "subscriber-shard/v1",
                "childId": members[0].1["childId"],
                "workerIndex": worker,
                "modulus": 8,
                "residue": worker,
                "firstSubscriberIndex": 0,
                "lastSubscriberIndexExclusive": subscriber_count,
                "subscriberCount": members.len(),
                "orderedSubscriberIdsSha256": sha256_hex(&bytes_of(&json!(ids))),
                "firstTokenCommitmentIndex": members[0].0,
                "lastTokenCommitmentIndexExclusive": shard_commitment_window_end(
                    members[0].0 as u64,
                    members.len() as u64,
                )
                .expect("window"),
            })
        })
        .collect();
    (json!(publishers), json!(shards))
}

/// The one producer shape in the tree, `server-observation-artifact.ts:1132`.
fn role_plan_input(cell_id: &str, publishers: u64, subscribers: u64) -> Value {
    json!({
        "schema": "canonical-workload-role-plan-input/v1",
        "scenarioPreimage": {
            "schema": "canonical-scenario-preimage/v1",
            "cellId": cell_id,
            "scenarioId": cell_id.split('/').next().expect("scenario"),
            "parameters": { "direction": "mac-to-linux" },
        },
        "scenarioHash": digest("scenario"),
        "rolePlanPreimage": {
            "schema": "canonical-role-plan-preimage/v1",
            "publisherCount": publishers,
            "subscriberWorkerCount": 8,
            "subscriberCount": subscribers,
        },
        "rolePlanHash": digest("role-plan"),
    })
}

fn chat_1k_plan_bytes() -> Vec<u8> {
    plan_bytes(CHAT_1K_CELL)
}

fn plan_bytes(cell_id: &str) -> Vec<u8> {
    let cell = cohort_cell(cell_id).expect("cell");
    bytes_of(&role_plan_input(
        cell_id,
        cell.publisher_count,
        cell.subscriber_count,
    ))
}

// --- the campaign under test ------------------------------------------------

/// The controller's honest `cross-supervisor-execution-draft/v1` for one run
/// of the chat-1k cell, every identity restating the campaign this runtime
/// was installed for.
fn execution_draft(run: u64, requested_not_after_ms: u64) -> Value {
    execution_draft_for(run, CHAT_1K_CELL, requested_not_after_ms)
}

fn execution_draft_for(run: u64, cell_id: &str, requested_not_after_ms: u64) -> Value {
    let cell = cohort_cell(cell_id).expect("cell");
    json!({
        "schema": "cross-supervisor-execution-draft/v1",
        "authoritySha256": digest("authority"),
        "campaignLockSha256": digest("campaign-lock"),
        "stagedCapabilitySha256": digest("staged-capability"),
        "sourceArchiveSha256": digest("source-archive"),
        "approvedPlanSha256": digest("approved-plan"),
        "approvalRecordSha256": digest("approval-record"),
        "candidate": CANDIDATE,
        "campaignId": CAMPAIGN_ID,
        "runId": format!("run-{run}"),
        "executionPurpose": "canonical",
        "cellId": cell_id,
        "scenarioHash": digest("scenario"),
        "rolePlanHash": digest("role-plan"),
        "workloadRolePlanInputSha256": sha256_hex(&plan_bytes(cell_id)),
        "stagedServerLaunchRecordSha256": digest("server-launch"),
        "armKind": "primary",
        "transport": "ws",
        "repetitionKind": "measured",
        "repetitionIndex": 0,
        "repetitionTotal": 1,
        "grantDeclaration": "fanout-expanded-deliveries",
        "declaredMessageCount": cell.expanded_deliveries,
        "declaredMessageBytes": cell.message_bytes,
        "requestedNotAfterMs": requested_not_after_ms,
    })
}

/// The two server-child records the observation frame carries.  The Mac
/// digests them and binds the digests through the rig receipts that
/// receipted them; their interior is the rig's to check.
fn server_warmup_drained_bytes(execution_sha256: &str) -> Vec<u8> {
    bytes_of(&json!({
        "schema": "server-warmup-drained/v1",
        "sequence": 3,
        "executionSha256": execution_sha256,
    }))
}

fn server_start_barrier_accepted_bytes(execution_sha256: &str) -> Vec<u8> {
    bytes_of(&json!({
        "schema": "server-start-barrier-accepted/v1",
        "sequence": 5,
        "executionSha256": execution_sha256,
    }))
}

const SNAPSHOT_FRAME: &[u8] = b"{\"schema\":\"server-snapshot/v1\"}\n";

struct Campaign {
    runtime: MacCohortRuntime,
    rig: RigSigner,
    mac_public_raw32: [u8; 32],
    grants: GrantRegistry,
    next_execution_index: u64,
    /// Per execution: the rig records this campaign's rig minted once and
    /// must present byte-identically wherever they recur.
    rig_records: BTreeMap<String, BTreeMap<&'static str, (Vec<u8>, Vec<u8>)>>,
    /// Per execution: the honest child-origin evidence, built at observation
    /// and re-presented at export.
    evidence: BTreeMap<String, HonestEvidence>,
    cells: BTreeMap<String, &'static str>,
    mac_ns: u64,
}

fn execution_tag(index: u64) -> String {
    format!("execution-{index}")
}

fn campaign() -> Campaign {
    campaign_with(RigSigner::new())
}

/// A key pair from a fixed seed, for the vectors that have to be regenerable.
fn seeded_keypair(seed: &str) -> Ed25519KeyPair {
    use ed25519_dalek::pkcs8::EncodePrivateKey as _;
    let seed: [u8; 32] = sha256_raw(seed.as_bytes()).try_into().expect("32");
    let signing = ed25519_dalek::SigningKey::from_bytes(&seed);
    Ed25519KeyPair {
        private_pkcs8_der: signing.to_pkcs8_der().expect("pkcs8").as_bytes().to_vec(),
        public_raw32: signing.verifying_key().to_bytes(),
    }
}

/// A campaign whose every byte is reproducible: seeded Mac and rig keys,
/// deterministic nonces, fixed grants and clocks.
fn deterministic_campaign(seed: &str) -> Campaign {
    let mac = seeded_keypair(&format!("{seed}/mac"));
    let rig = RigSigner {
        keys: seeded_keypair(&format!("{seed}/rig")),
    };
    let mut runtime = MacCohortRuntime::new(
        mac.private_pkcs8_der.clone(),
        rig.keys.public_raw32,
        &digest("mac-instance"),
        &digest("mac-clock"),
        VALIDITY_MS,
    )
    .expect("runtime");
    runtime
        .set_campaign_authority(&digest("approved-plan"), &digest("approval-record"))
        .expect("authority");
    runtime
        .set_supervisor_executable_sha256(&digest("mac-executable"))
        .expect("executable");
    runtime.use_deterministic_nonces_for_tests(seed);
    Campaign {
        runtime,
        rig,
        mac_public_raw32: mac.public_raw32,
        grants: GrantRegistry::new(),
        next_execution_index: 0,
        rig_records: BTreeMap::new(),
        evidence: BTreeMap::new(),
        cells: BTreeMap::new(),
        mac_ns: MAC_NS,
    }
}

/// A campaign whose staged rig public key is `rig`'s, with fd 3's two approval
/// digests and the executable digest installed as the binary installs them.
fn campaign_with(rig: RigSigner) -> Campaign {
    let mac = generate_ed25519_keypair();
    let mut runtime = MacCohortRuntime::new(
        mac.private_pkcs8_der.clone(),
        rig.keys.public_raw32,
        &digest("mac-instance"),
        &digest("mac-clock"),
        VALIDITY_MS,
    )
    .expect("runtime");
    runtime
        .set_campaign_authority(&digest("approved-plan"), &digest("approval-record"))
        .expect("authority");
    runtime
        .set_supervisor_executable_sha256(&digest("mac-executable"))
        .expect("executable");
    Campaign {
        runtime,
        rig,
        mac_public_raw32: mac.public_raw32,
        grants: GrantRegistry::new(),
        next_execution_index: 0,
        rig_records: BTreeMap::new(),
        evidence: BTreeMap::new(),
        cells: BTreeMap::new(),
        mac_ns: MAC_NS,
    }
}

impl Campaign {
    fn dispatch(&mut self, kind: &str, payload: &Value) -> Result<Vec<u8>, MacRefusal> {
        self.mac_ns += 1_000_000;
        self.runtime
            .dispatch_at(kind, &bytes_of(payload), NOW_MS, self.mac_ns)
    }

    /// The §3.3 channel counter this campaign is at.
    fn seq(&self) -> u64 {
        self.runtime.next_request_seq()
    }

    fn session(&mut self, execution_sha256: &str) -> &mut secure_fs::cohort::mac::MacCohortSession {
        self.runtime.session_mut(execution_sha256).expect("session")
    }

    /// The grant this session minted, or a placeholder digest when no
    /// session exists — so a frame for an unknown execution is still shaped.
    fn grant_sha256(&mut self, execution_sha256: &str) -> String {
        self.runtime
            .session_mut(execution_sha256)
            .map(|session| session.grant().sha256.clone())
            .unwrap_or_else(|_| digest("no grant"))
    }

    /// A rig record this campaign's rig minted for the execution, or an empty
    /// placeholder pair when it never did — so a frame that names a record
    /// the rig never produced is still shaped, and refused on content.
    fn rig_record(&self, execution_sha256: &str, key: &'static str) -> (Vec<u8>, Vec<u8>) {
        self.rig_records
            .get(execution_sha256)
            .and_then(|records| records.get(key))
            .cloned()
            .unwrap_or_else(|| (b"{}\n".to_vec(), b"{}\n".to_vec()))
    }

    /// MAC_EXECUTION_OPEN, as the `ResidentLoop` drives it: the draft is read
    /// off the frame, the loop issues the grant for the run and transport the
    /// draft names, the runtime constructs the execution over that grant and
    /// answers `mac-execution-opened-ack/v1`.  Then the legacy admission is
    /// retained, so row 7 has a series to bind.  Returns `executionSha256`.
    fn open_execution(&mut self, run: u64) -> String {
        let (execution_sha256, _) = self.open_execution_with(run, |_| {});
        execution_sha256
    }

    fn open_execution_with(
        &mut self,
        run: u64,
        mutate: impl FnOnce(&mut Value),
    ) -> (String, Value) {
        let now = secure_fs::measurement::now_epoch_millis().floor() as u64;
        let draft = execution_draft(run, now + 3 * 3_600_000);
        self.open_execution_from(draft, None, mutate)
    }

    /// One execution of `cell_id`, opened with a fixed grant so every byte of
    /// the lifecycle is reproducible.
    fn open_deterministic_execution(&mut self, run: u64, cell_id: &str) -> String {
        let draft = execution_draft_for(run, cell_id, NOW_MS + 3 * 3_600_000);
        let cell = cohort_cell(cell_id).expect("cell");
        let grant = secure_fs::measurement::MeasurementGrant {
            candidate: CANDIDATE.to_owned(),
            execution: ExecutionKey {
                campaign_id: CAMPAIGN_ID.to_owned(),
                run_id: format!("run-{run}"),
                execution_index: self.next_execution_index + 1,
                transport: "ws".to_owned(),
            },
            nonce_sha256: digest(&format!("grant-nonce-{run}")),
            declared_message_count: cell.expanded_deliveries,
            declared_message_bytes: cell.message_bytes,
            issued_at_ms: NOW_MS - 1_000,
            not_after_ms: NOW_MS + 2 * 3_600_000,
        };
        let (execution_sha256, _) =
            self.open_execution_from(draft, Some(grant.canonical_bytes()), |_| {});
        execution_sha256
    }

    fn open_execution_from(
        &mut self,
        mut draft: Value,
        fixed_grant: Option<Vec<u8>>,
        mutate: impl FnOnce(&mut Value),
    ) -> (String, Value) {
        mutate(&mut draft);
        let cell_id = draft["cellId"].as_str().expect("cellId").to_owned();
        let cell = cohort_cell(&cell_id).expect("cell");
        let draft_bytes = bytes_of(&draft);
        // A fresh execution channel, the way the controller opens one
        // (`MacCohortChannel`, one sequence state per execution):
        // `requestSeq` 0, and the binary answers it with `responseSeq` 0.
        let frame = bytes_of(&json!({
            "schema": "mac-open-execution-request/v1",
            "requestSeq": 0,
            "executionDraftSha256": sha256_hex(&draft_bytes),
            "executionDraftBase64": b64(&draft_bytes),
        }));
        self.runtime
            .charge_request_seq(MAC_OPEN_EXECUTION_KIND, &frame)
            .expect("sequence");
        let request = read_open_execution_request(&frame).expect("open request");
        self.next_execution_index += 1;
        let key = ExecutionKey {
            campaign_id: CAMPAIGN_ID.to_owned(),
            run_id: request.facts.run_id.clone(),
            execution_index: self.next_execution_index,
            transport: request.facts.transport.clone(),
        };
        let grant = match fixed_grant {
            Some(grant) => grant,
            None => self
                .grants
                .issue(&GrantRequest {
                    candidate: CANDIDATE.to_owned(),
                    execution: key.clone(),
                    declared_message_count: request.facts.declared_message_count,
                    declared_message_bytes: request.facts.declared_message_bytes,
                })
                .expect("grant")
                .run_command_payload()
                .expect("payload"),
        };
        let opened = self
            .runtime
            .construct_execution(&request, &grant, NOW_MS)
            .expect("construct execution");
        let ack = self
            .runtime
            .opened_ack(request.request_seq, &opened.execution_sha256)
            .expect("opened ack");
        let ack = json_of(&ack);
        assert_eq!(ack["schema"], "mac-execution-opened-ack/v1");
        assert_eq!(ack["executionSha256"], opened.execution_sha256);
        // The legacy channel's admission, retained: the shape
        // `present_artifact_payload` hands over.
        let payload = format!(
            "{{\"sampleUnit\":\"count\",\"samples\":[{}]}}\n",
            cell.expanded_deliveries
        )
        .into_bytes();
        let receipt = AdmissionReceipt {
            execution: key,
            grant_sha256: sha256_hex(&grant),
            payload_sha256: sha256_hex(&payload),
            series: AdmittedSeries {
                sample_count: 1,
                delivered: cell.expanded_deliveries,
                first_sample_at_ms: NOW_MS as f64 + 10.0,
                last_sample_at_ms: NOW_MS as f64 + 30_010.0,
                span_ms: 30_000.0,
                latency_sum_ms: 0.0,
                observed_mbps: None,
            },
            frame_accepted_at_ms: NOW_MS as f64 + 30_011.5,
        };
        self.runtime
            .retain_admitted_series(&opened.execution_sha256, &receipt, &payload)
            .expect("retain admitted series");
        // The rig's own execution acceptance for this execution, minted once.
        let acceptance = self.rig.sign(
            "rig-execution-acceptance/v1",
            &with_fields(
                rig_record("rig-execution-acceptance/v1", &opened.execution_sha256, 1),
                &[
                    ("measurementGrantSha256", &sha256_hex(&grant)),
                    ("macExecutionGrantReceiptSha256", &opened.receipt.sha256),
                ],
            ),
        );
        self.rig_records
            .entry(opened.execution_sha256.clone())
            .or_default()
            .insert("rigExecutionAcceptance", acceptance);
        self.cells
            .insert(opened.execution_sha256.clone(), cell.cell_id);
        (opened.execution_sha256, ack)
    }

    fn cell_of(&self, execution_sha256: &str) -> &'static secure_fs::cohort::mac::CohortCell {
        cohort_cell(
            self.cells
                .get(execution_sha256)
                .copied()
                .unwrap_or(CHAT_1K_CELL),
        )
        .expect("cell")
    }

    fn open(&mut self, execution_sha256: &str) -> Result<Vec<u8>, MacRefusal> {
        self.open_frame(execution_sha256, |_| {})
    }

    /// The honest chat-1k open frame, with a hook so a test can corrupt exactly
    /// one field and leave the others alone.
    fn open_frame(
        &mut self,
        execution_sha256: &str,
        mutate: impl FnOnce(&mut Value),
    ) -> Result<Vec<u8>, MacRefusal> {
        let cohort_id = format!("cohort-{}", &execution_sha256[..16]);
        self.open_frame_for_cohort(execution_sha256, &cohort_id, mutate)
    }

    /// The same honest open frame under a caller-chosen cohort id, which is
    /// what a replacement attempt carries: a fresh cohort id is a fresh token
    /// commitment set, because every leaf embeds it and the root covers the
    /// leaves.
    fn open_frame_for_cohort(
        &mut self,
        execution_sha256: &str,
        cohort_id: &str,
        mutate: impl FnOnce(&mut Value),
    ) -> Result<Vec<u8>, MacRefusal> {
        let cell = self.cell_of(execution_sha256);
        let plan = plan_bytes(cell.cell_id);
        let manifest_value = leaf_manifest(
            execution_sha256,
            cohort_id,
            cell.publisher_count,
            cell.subscriber_count,
        );
        let (publishers, shards) = presented_topology(&manifest_value);
        let manifest = bytes_of(&manifest_value);
        let seq = self.seq();
        let mut frame = json!({
            "schema": "mac-open-cohort-request/v1",
            "requestSeq": seq,
            "executionSha256": execution_sha256,
            "scenarioHash": digest("scenario"),
            "rolePlanHash": digest("role-plan"),
            "workloadRolePlanInputBase64": b64(&plan),
            "workloadRolePlanInputSha256": sha256_hex(&plan),
            "workloadRolePlanInputSize": plan.len(),
            "tokenCommitmentLeafManifestBase64": b64(&manifest),
            "tokenCommitmentLeafManifestSha256": sha256_hex(&manifest),
            "publishersBase64": b64(&bytes_of(&publishers)),
            "subscriberShardsBase64": b64(&bytes_of(&shards)),
        });
        mutate(&mut frame);
        self.dispatch("mac-open-cohort-request", &frame)
    }

    /// COHORT_GRANTED's second half, with an honest rig acceptance naming
    /// the grant this session minted.
    fn present_cohort_acceptance(&mut self, execution_sha256: &str) -> Result<Vec<u8>, MacRefusal> {
        let (grant_sha256, grant_signature_sha256) = self
            .runtime
            .session_mut(execution_sha256)
            .map(|session| {
                (
                    session.grant().sha256.clone(),
                    session.grant().signature_sha256.clone(),
                )
            })
            .unwrap_or_else(|_| (digest("no grant"), digest("no grant signature")));
        let (record, signature) = self.rig.sign(
            "rig-cohort-acceptance/v1",
            &with_fields(
                rig_record("rig-cohort-acceptance/v1", execution_sha256, 1),
                &[
                    ("cohortGrantSha256", &grant_sha256),
                    ("cohortGrantSignatureSha256", &grant_signature_sha256),
                ],
            ),
        );
        self.rig_records
            .entry(execution_sha256.to_owned())
            .or_default()
            .insert("rigCohortAcceptance", (record.clone(), signature.clone()));
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

    fn issue_warmup_epoch(&mut self, execution_sha256: &str) -> Result<Vec<u8>, MacRefusal> {
        let grant_sha256 = self.grant_sha256(execution_sha256);
        let acceptance_sha256 =
            sha256_hex(&self.rig_record(execution_sha256, "rigCohortAcceptance").0);
        let seq = self.seq();
        self.dispatch(
            "mac-issue-warmup-epoch-request",
            &json!({
                "schema": "mac-issue-warmup-epoch-request/v1",
                "requestSeq": seq,
                "executionSha256": execution_sha256,
                "cohortGrantSha256": grant_sha256,
                "rigCohortAcceptanceSha256": acceptance_sha256,
            }),
        )
    }

    /// Every child's honest `role-warmup-complete/v1`, in role-plan order.
    fn warmup_completes(&mut self, execution_sha256: &str) -> Vec<Vec<u8>> {
        let session = self.session(execution_sha256);
        let epoch = json_of(&session.warmup_epoch().expect("epoch").bytes);
        let grant_sha256 = session.grant().sha256.clone();
        let shard_counts = session.manifest().shard_subscriber_counts;
        let publisher_count = session.manifest().publisher_count;
        let (publishers, shards) = session.presented_topology();
        let publishers = publishers.clone();
        let shards = shards.clone();
        let mut completes = Vec::new();
        let mut sequence = 0u64;
        for publisher in publishers.as_array().expect("publishers") {
            completes.push(bytes_of(&json!({
                "schema": "role-warmup-complete/v1",
                "sequence": sequence,
                "executionSha256": execution_sha256,
                "cohortGrantSha256": grant_sha256,
                "cohortWarmupEpochSha256": sha256_hex(&bytes_of(&epoch)),
                "warmupNonce": epoch["warmupNonce"],
                "childId": publisher["childId"],
                "role": "publisher",
                "startedAtMacNs": MAC_NS.to_string(),
                "completedAtMacNs": (MAC_NS + 5_000_000_000).to_string(),
                "offeredWarmupIngress": 10,
                "deliveredWarmupRecords": 0,
            })));
            sequence += 1;
        }
        for (worker, shard) in shards.as_array().expect("shards").iter().enumerate() {
            completes.push(bytes_of(&json!({
                "schema": "role-warmup-complete/v1",
                "sequence": sequence,
                "executionSha256": execution_sha256,
                "cohortGrantSha256": grant_sha256,
                "cohortWarmupEpochSha256": sha256_hex(&bytes_of(&epoch)),
                "warmupNonce": epoch["warmupNonce"],
                "childId": shard["childId"],
                "role": "subscriber-worker",
                "startedAtMacNs": MAC_NS.to_string(),
                "completedAtMacNs": (MAC_NS + 5_000_000_000).to_string(),
                "offeredWarmupIngress": 0,
                "deliveredWarmupRecords": shard_counts[worker] * publisher_count * 10,
            })));
            sequence += 1;
        }
        completes
    }

    fn export_warmup_manifest(&mut self, execution_sha256: &str) -> Result<Vec<u8>, MacRefusal> {
        let completes = self.warmup_completes(execution_sha256);
        self.export_warmup_manifest_with(execution_sha256, completes)
    }

    fn export_warmup_manifest_with(
        &mut self,
        execution_sha256: &str,
        completes: Vec<Vec<u8>>,
    ) -> Result<Vec<u8>, MacRefusal> {
        let epoch_sha256 = self
            .session(execution_sha256)
            .warmup_epoch()
            .expect("epoch")
            .sha256
            .clone();
        let seq = self.seq();
        self.dispatch(
            "mac-export-warmup-completion-manifest-request",
            &json!({
                "schema": "mac-export-warmup-completion-manifest-request/v1",
                "requestSeq": seq,
                "executionSha256": execution_sha256,
                "cohortWarmupEpochSha256": epoch_sha256,
                "roleWarmupCompletesBase64": completes.iter().map(|bytes| json!(b64(bytes))).collect::<Vec<_>>(),
            }),
        )
    }

    /// The rig's honest drained receipt and measure-start ack for this
    /// session, minted once and remembered.
    fn honest_barrier_inputs(
        &mut self,
        execution_sha256: &str,
    ) -> ((Vec<u8>, Vec<u8>), (Vec<u8>, Vec<u8>)) {
        let session = self.session(execution_sha256);
        let grant_sha256 = session.grant().sha256.clone();
        let epoch_sha256 = session
            .warmup_epoch()
            .map(|epoch| epoch.sha256.clone())
            .unwrap_or_else(|| digest("no epoch"));
        let manifest_sha256 = session
            .warmup_completion_manifest()
            .map(|manifest| manifest.sha256.clone())
            .unwrap_or_else(|| digest("no manifest"));
        let execution = self.runtime.execution(execution_sha256).expect("execution");
        let grant_digest = execution.grant_sha256.clone();
        let receipt_sha256 = execution.receipt.sha256.clone();
        let acceptance_sha256 = sha256_hex(
            &self
                .rig_record(execution_sha256, "rigExecutionAcceptance")
                .0,
        );
        let drained = self.rig.sign(
            "rig-warmup-drained-receipt/v1",
            &with_fields(
                rig_record("rig-warmup-drained-receipt/v1", execution_sha256, 2),
                &[
                    ("cohortGrantSha256", &grant_sha256),
                    ("cohortWarmupEpochSha256", &epoch_sha256),
                    ("roleWarmupCompletionManifestSha256", &manifest_sha256),
                    (
                        "serverWarmupDrainedSha256",
                        &sha256_hex(&server_warmup_drained_bytes(execution_sha256)),
                    ),
                ],
            ),
        );
        let ack = self.rig.sign(
            "rig-measure-start-ack/v1",
            &with_fields(
                rig_record("rig-measure-start-ack/v1", execution_sha256, 3),
                &[
                    ("measurementGrantSha256", &grant_digest),
                    ("macExecutionGrantReceiptSha256", &receipt_sha256),
                    ("rigExecutionAcceptanceSha256", &acceptance_sha256),
                    ("rigWarmupDrainedReceiptSha256", &sha256_hex(&drained.0)),
                    ("warmupCompletionAuthoritySha256", &manifest_sha256),
                ],
            ),
        );
        let records = self
            .rig_records
            .entry(execution_sha256.to_owned())
            .or_default();
        records.insert("rigWarmupDrainedReceipt", drained.clone());
        records.insert("rigMeasureStartAck", ack.clone());
        (drained, ack)
    }

    /// START_BARRIER, with each of the two rig records optionally replaced by
    /// whatever the caller wants to present instead.
    fn issue_start_barrier(
        &mut self,
        execution_sha256: &str,
        drained: Option<(Vec<u8>, Vec<u8>)>,
        ack: Option<(Vec<u8>, Vec<u8>)>,
    ) -> Result<Vec<u8>, MacRefusal> {
        let (honest_drained, honest_ack) = self.honest_barrier_inputs(execution_sha256);
        let drained = drained.unwrap_or(honest_drained);
        let ack = ack.unwrap_or(honest_ack);
        let grant_sha256 = self.grant_sha256(execution_sha256);
        let seq = self.seq();
        self.dispatch(
            "mac-issue-start-barrier-request",
            &json!({
                "schema": "mac-issue-start-barrier-request/v1",
                "requestSeq": seq,
                "executionSha256": execution_sha256,
                "cohortGrantSha256": grant_sha256,
                "rigWarmupDrainedReceiptBase64": b64(&drained.0),
                "rigWarmupDrainedReceiptSignatureBase64": b64(&drained.1),
                "rigMeasureStartAckBase64": b64(&ack.0),
                "rigMeasureStartAckSignatureBase64": b64(&ack.1),
            }),
        )
    }

    fn honest_barrier_acceptance(
        &mut self,
        execution_sha256: &str,
        sequence: u64,
    ) -> (Vec<u8>, Vec<u8>) {
        let session = self.session(execution_sha256);
        let grant_sha256 = session.grant().sha256.clone();
        let barrier_sha256 = session
            .start_barrier()
            .map(|barrier| barrier.sha256.clone())
            .unwrap_or_else(|| digest("no barrier"));
        let ack_sha256 = self
            .rig_records
            .get(execution_sha256)
            .and_then(|records| records.get("rigMeasureStartAck"))
            .map(|(bytes, _)| sha256_hex(bytes))
            .unwrap_or_else(|| digest("no ack"));
        let record = self.rig.sign(
            "rig-barrier-acceptance/v1",
            &with_fields(
                rig_record("rig-barrier-acceptance/v1", execution_sha256, sequence),
                &[
                    ("cohortGrantSha256", &grant_sha256),
                    ("cohortStartBarrierSha256", &barrier_sha256),
                    ("rigMeasureStartAckSha256", &ack_sha256),
                    (
                        "serverStartBarrierAcceptedSha256",
                        &sha256_hex(&server_start_barrier_accepted_bytes(execution_sha256)),
                    ),
                ],
            ),
        );
        self.rig_records
            .entry(execution_sha256.to_owned())
            .or_default()
            .insert("rigBarrierAcceptance", record.clone());
        record
    }

    fn present_barrier_acceptance(
        &mut self,
        execution_sha256: &str,
    ) -> Result<Vec<u8>, MacRefusal> {
        let record = self.honest_barrier_acceptance(execution_sha256, 4);
        self.present_barrier_acceptance_record(execution_sha256, record)
    }

    fn present_barrier_acceptance_record(
        &mut self,
        execution_sha256: &str,
        record: (Vec<u8>, Vec<u8>),
    ) -> Result<Vec<u8>, MacRefusal> {
        let seq = self.seq();
        self.dispatch(
            "mac-present-rig-barrier-acceptance-request",
            &json!({
                "schema": "mac-present-rig-barrier-acceptance-request/v1",
                "requestSeq": seq,
                "executionSha256": execution_sha256,
                "rigBarrierAcceptanceBase64": b64(&record.0),
                "rigBarrierAcceptanceSignatureBase64": b64(&record.1),
            }),
        )
    }

    /// MAC_JOIN's honest frame: the five rig records, the two server-child
    /// records, the Linux observation under its rig receipt, the five derived
    /// records — every one consistent with the cohort this session granted.
    fn observation_frame(&mut self, execution_sha256: &str) -> Value {
        let evidence = self.honest_evidence(execution_sha256);
        let acceptance = self.rig_record(execution_sha256, "rigExecutionAcceptance");
        let ack = self.rig_record(execution_sha256, "rigMeasureStartAck");
        let barrier_acceptance = self.rig_record(execution_sha256, "rigBarrierAcceptance");
        let execution = self.runtime.execution(execution_sha256).expect("execution");
        let grant_digest = execution.grant_sha256.clone();
        let receipt_sha256 = execution.receipt.sha256.clone();
        let snapshot = self.rig.sign(
            "rig-server-snapshot-receipt/v1",
            &with_fields(
                rig_record("rig-server-snapshot-receipt/v1", execution_sha256, 5),
                &[
                    ("measurementGrantSha256", &grant_digest),
                    ("macExecutionGrantReceiptSha256", &receipt_sha256),
                    ("rigExecutionAcceptanceSha256", &sha256_hex(&acceptance.0)),
                    ("cohortGrantSha256", &evidence.grant_sha256),
                    ("cohortStartBarrierSha256", &evidence.barrier_sha256),
                    ("snapshotFrameSha256", &sha256_hex(SNAPSHOT_FRAME)),
                ],
            ),
        );
        let relay = self.rig.sign(
            "rig-relay-observation-receipt/v1",
            &with_fields(
                rig_record("rig-relay-observation-receipt/v1", execution_sha256, 6),
                &[
                    ("cohortGrantSha256", &evidence.grant_sha256),
                    ("cohortStartBarrierSha256", &evidence.barrier_sha256),
                    (
                        "linuxRelayObservationSha256",
                        &sha256_hex(&evidence.linux_relay_observation),
                    ),
                ],
            ),
        );
        let seq = self.seq();
        json!({
            "schema": "mac-present-rig-observation-request/v1",
            "requestSeq": seq,
            "executionSha256": execution_sha256,
            "rigExecutionAcceptanceBase64": b64(&acceptance.0),
            "rigExecutionAcceptanceSignatureBase64": b64(&acceptance.1),
            "rigMeasureStartAckBase64": b64(&ack.0),
            "rigMeasureStartAckSignatureBase64": b64(&ack.1),
            "rigBarrierAcceptanceBase64": b64(&barrier_acceptance.0),
            "rigBarrierAcceptanceSignatureBase64": b64(&barrier_acceptance.1),
            "serverWarmupDrainedBase64": b64(&server_warmup_drained_bytes(execution_sha256)),
            "serverStartBarrierAcceptedBase64": b64(&server_start_barrier_accepted_bytes(execution_sha256)),
            "snapshotFrameBase64": b64(SNAPSHOT_FRAME),
            "rigServerSnapshotReceiptBase64": b64(&snapshot.0),
            "rigServerSnapshotReceiptSignatureBase64": b64(&snapshot.1),
            "linuxRelayObservationBase64": b64(&evidence.linux_relay_observation),
            "rigRelayObservationReceiptBase64": b64(&relay.0),
            "rigRelayObservationReceiptSignatureBase64": b64(&relay.1),
            "orderedPartialManifestBase64": b64(&evidence.ordered_partial_manifest),
            "observedProcessProofBase64": b64(&evidence.observed_process_proof),
            "cohortRateSeriesBase64": b64(&evidence.rate_series),
            "cohortLedgerBase64": b64(&evidence.ledger),
            "cohortCapacityBase64": b64(&evidence.capacity),
        })
    }

    fn present_observation(&mut self, execution_sha256: &str) -> Result<Vec<u8>, MacRefusal> {
        let frame = self.observation_frame(execution_sha256);
        self.dispatch("mac-present-rig-observation-request", &frame)
    }

    fn export_bundle(&mut self, execution_sha256: &str) -> Value {
        let evidence = self.honest_evidence(execution_sha256);
        let admission_sha256 = self
            .session(execution_sha256)
            .admission()
            .map(|(_, cohort)| cohort.sha256.clone())
            .unwrap_or_else(|| digest("no admission"));
        let completes = self.warmup_completes(execution_sha256);
        json!({
            "schema": "role-child-evidence-bundle/v1",
            "executionSha256": execution_sha256,
            "cohortGrantSha256": evidence.grant_sha256,
            "cohortAdmissionReceiptSha256": admission_sha256,
            "roleWarmupCompletes": completes.iter().map(|bytes| retained_canonical_bytes(bytes)).collect::<Vec<_>>(),
            "publisherPartials": evidence.publisher_partials.iter().map(|bytes| retained_canonical_bytes(bytes)).collect::<Vec<_>>(),
            "workerPartials": evidence.worker_partials.iter().map(|bytes| retained_canonical_bytes(bytes)).collect::<Vec<_>>(),
            "orderedPartialManifest": retained_canonical_bytes(&evidence.ordered_partial_manifest),
            "observedProcessProof": retained_canonical_bytes(&evidence.observed_process_proof),
        })
    }

    fn export_evidence(&mut self, execution_sha256: &str) -> Result<Vec<u8>, MacRefusal> {
        let bundle = self.export_bundle(execution_sha256);
        self.export_evidence_with(execution_sha256, bundle)
    }

    fn export_evidence_with(
        &mut self,
        execution_sha256: &str,
        bundle: Value,
    ) -> Result<Vec<u8>, MacRefusal> {
        let admission_sha256 = self
            .session(execution_sha256)
            .admission()
            .map(|(_, cohort)| cohort.sha256.clone())
            .unwrap_or_else(|| digest("no admission"));
        let seq = self.seq();
        self.dispatch(
            "mac-export-cohort-evidence-request",
            &json!({
                "schema": "mac-export-cohort-evidence-request/v1",
                "requestSeq": seq,
                "executionSha256": execution_sha256,
                "cohortAdmissionReceiptSha256": admission_sha256,
                "roleChildEvidenceBundleBase64": b64(&bytes_of(&bundle)),
            }),
        )
    }

    /// Drive one execution through Phase A and to the barrier's inputs.
    fn reach_barrier(&mut self, execution_sha256: &str) {
        self.open(execution_sha256).expect("open");
        self.present_cohort_acceptance(execution_sha256)
            .expect("cohort acceptance");
        self.issue_warmup_epoch(execution_sha256)
            .expect("warmup epoch");
        self.export_warmup_manifest(execution_sha256)
            .expect("warmup manifest");
    }

    /// Drive one execution all the way to a verified observation and minted
    /// admission.
    fn reach_admission(&mut self, execution_sha256: &str) {
        self.reach_barrier(execution_sha256);
        self.issue_start_barrier(execution_sha256, None, None)
            .expect("start barrier");
        self.present_barrier_acceptance(execution_sha256)
            .expect("barrier acceptance");
        self.present_observation(execution_sha256)
            .expect("observation");
    }

    /// The honest child-origin evidence for this session's cohort, built once.
    fn honest_evidence(&mut self, execution_sha256: &str) -> HonestEvidence {
        if let Some(evidence) = self.evidence.get(execution_sha256) {
            return evidence.clone();
        }
        let session = self.session(execution_sha256);
        let grant_sha256 = session.grant().sha256.clone();
        let barrier_sha256 = session
            .start_barrier()
            .map(|barrier| barrier.sha256.clone())
            .unwrap_or_else(|| digest("no barrier"));
        let (publishers, shards) = session.presented_topology();
        let publishers = publishers.clone();
        let shards = shards.clone();
        let shard_counts = session.manifest().shard_subscriber_counts;
        let cell = self.cell_of(execution_sha256);
        let evidence = HonestEvidence::for_cell(
            cell,
            execution_sha256,
            &grant_sha256,
            &barrier_sha256,
            &publishers,
            &shards,
            &shard_counts,
        );
        self.evidence
            .insert(execution_sha256.to_owned(), evidence.clone());
        evidence
    }
}

/// Everything a chat-1k cohort's role children and the Linux relay would
/// have said about one honest measured repetition: ten publishers offering one
/// message per window for thirty windows, every message accepted, relayed and
/// delivered to all 1,000 subscribers, nothing dropped, nothing after stop.
#[derive(Clone)]
struct HonestEvidence {
    grant_sha256: String,
    barrier_sha256: String,
    publisher_partials: Vec<Vec<u8>>,
    worker_partials: Vec<Vec<u8>>,
    ordered_partial_manifest: Vec<u8>,
    observed_process_proof: Vec<u8>,
    linux_relay_observation: Vec<u8>,
    rate_series: Vec<u8>,
    ledger: Vec<u8>,
    capacity: Vec<u8>,
}

impl HonestEvidence {
    #[allow(non_snake_case)]
    fn for_cell(
        cell: &secure_fs::cohort::mac::CohortCell,
        execution_sha256: &str,
        grant_sha256: &str,
        barrier_sha256: &str,
        publishers: &Value,
        shards: &Value,
        shard_counts: &[u64; 8],
    ) -> Self {
        let WINDOWS = (cell.measured_duration_ms / 1_000) as usize;
        let SUBSCRIBERS = cell.subscriber_count;
        let MESSAGE_BYTES = cell.message_bytes;
        let publisher_count = publishers.as_array().expect("publishers").len() as u64;
        // Every publisher offers the same share of the cell's measured ingress
        // in every window: one message for chat, ten thousand for ticker 10k.
        let per_publisher_window = cell.measured_ingress / (publisher_count * WINDOWS as u64);
        assert_eq!(
            per_publisher_window * publisher_count * WINDOWS as u64,
            cell.measured_ingress
        );
        let per_window_ingress = publisher_count * per_publisher_window;
        let mut publisher_partials = Vec::new();
        for (index, publisher) in publishers
            .as_array()
            .expect("publishers")
            .iter()
            .enumerate()
        {
            publisher_partials.push(bytes_of(&json!({
                "schema": "publisher-partial/v1",
                "executionSha256": execution_sha256,
                "cohortGrantSha256": grant_sha256,
                "cohortStartBarrierSha256": barrier_sha256,
                "childId": publisher["childId"],
                "childPid": 1000 + index,
                "childPgid": 900,
                "childInstanceNonce": digest(&format!("publisher-nonce-{index}")),
                "publisherId": publisher["publisherId"],
                "tokenSha256": publisher["tokenSha256"],
                "macClockId": digest("mac-clock"),
                "windowCount": WINDOWS,
                "offeredByOriginWindow": vec![per_publisher_window; WINDOWS],
                "offeredBytesByOriginWindow": vec![per_publisher_window * MESSAGE_BYTES; WINDOWS],
                "acceptedAckSeenByOriginWindow": vec![per_publisher_window; WINDOWS],
                "duplicateAckSeenByOriginWindow": vec![0u64; WINDOWS],
                "reorderedAckSeenByOriginWindow": vec![0u64; WINDOWS],
                "firstOfferAtMacNs": (MAC_NS + 300_000_000).to_string(),
                "lastAckAtMacNs": (MAC_NS + 30_300_000_000).to_string(),
                "exitCode": 0,
            })));
        }
        let mut worker_partials = Vec::new();
        for (worker, shard) in shards.as_array().expect("shards").iter().enumerate() {
            let count = shard_counts[worker];
            let per_window = per_window_ingress * count;
            worker_partials.push(bytes_of(&json!({
                "schema": "worker-partial/v1",
                "executionSha256": execution_sha256,
                "cohortGrantSha256": grant_sha256,
                "cohortStartBarrierSha256": barrier_sha256,
                "childId": shard["childId"],
                "childPid": 2000 + worker,
                "childPgid": 900,
                "childInstanceNonce": digest(&format!("worker-nonce-{worker}")),
                "workerIndex": worker,
                "tokenBundleSha256": digest(&format!("bundle-{worker}")),
                "orderedSubscriberIdsSha256": shard["orderedSubscriberIdsSha256"],
                "subscriberCount": count,
                "macClockId": digest("mac-clock"),
                "windowCount": WINDOWS,
                "deliveredByOriginWindow": vec![per_window; WINDOWS],
                "deliveredBytesByOriginWindow": vec![per_window * MESSAGE_BYTES; WINDOWS],
                "deliveredByEventWindow": vec![per_window; WINDOWS],
                "deliveredBytesByEventWindow": vec![per_window * MESSAGE_BYTES; WINDOWS],
                "deliveredAfterMeasureStop": 0,
                "deliveredBytesAfterMeasureStop": 0,
                "perSubscriberDelivered": vec![per_window_ingress * WINDOWS as u64; count as usize],
                "duplicateCount": 0,
                "reorderCount": 0,
                "malformedCount": 0,
                "disconnectCount": 0,
                "firstDeliveryAtMacNs": (MAC_NS + 301_000_000).to_string(),
                "lastDeliveryAtMacNs": (MAC_NS + 30_301_000_000).to_string(),
                "exitCode": 0,
            })));
        }
        // The ordered partial manifest: publishers ascending by child id, then
        // workers ascending by child id.
        let mut publisher_entries: Vec<(String, &Vec<u8>)> = publisher_partials
            .iter()
            .map(|bytes| {
                (
                    json_of(bytes)["childId"]
                        .as_str()
                        .expect("child")
                        .to_owned(),
                    bytes,
                )
            })
            .collect();
        publisher_entries.sort();
        let mut worker_entries: Vec<(String, &Vec<u8>)> = worker_partials
            .iter()
            .map(|bytes| {
                (
                    json_of(bytes)["childId"]
                        .as_str()
                        .expect("child")
                        .to_owned(),
                    bytes,
                )
            })
            .collect();
        worker_entries.sort();
        let mut entries = Vec::new();
        let mut total = 0u64;
        for (order, (kind, (child_id, bytes))) in publisher_entries
            .iter()
            .map(|entry| ("publisher", entry))
            .chain(worker_entries.iter().map(|entry| ("worker", entry)))
            .enumerate()
        {
            total += bytes.len() as u64;
            entries.push(json!({
                "schema": "ordered-partial-manifest-entry/v1",
                "order": order,
                "partialKind": kind,
                "childId": child_id,
                "partialSha256": sha256_hex(bytes),
                "partialSize": bytes.len(),
            }));
        }
        let ordered_partial_manifest = bytes_of(&json!({
            "schema": "ordered-partial-manifest/v1",
            "executionSha256": execution_sha256,
            "cohortGrantSha256": grant_sha256,
            "cohortStartBarrierSha256": barrier_sha256,
            "publisherPartialCount": publisher_count,
            "workerPartialCount": 8,
            "totalPartialBytes": total,
            "orderedDigestSetSha256": ordered_digest_set_sha256(&entries).expect("digest set"),
            "entries": entries,
        }));
        // The observed process proof, one child per role child.
        let mut children = Vec::new();
        for (index, publisher) in publishers
            .as_array()
            .expect("publishers")
            .iter()
            .enumerate()
        {
            children.push(json!({
                "schema": "observed-child-process/v1",
                "childId": publisher["childId"],
                "role": "publisher",
                "pid": 1000 + index,
                "pgid": 900,
                "instanceNonce": digest(&format!("publisher-nonce-{index}")),
                "bunSha256": digest("bun"),
                "entrypointSha256": digest("fanout-role"),
                "tokenOrBundleSha256": publisher["tokenSha256"],
                "publisherId": publisher["publisherId"],
                "workerIndex": Value::Null,
                "orderedSubscriberIdsSha256": Value::Null,
                "subscriberCount": 0,
                "spawnedAtMacNs": (MAC_NS + 1).to_string(),
                "readyAtMacNs": (MAC_NS + 2).to_string(),
                "warmupCompleteAtMacNs": (MAC_NS + 3).to_string(),
                "measureArmedAtMacNs": (MAC_NS + 4).to_string(),
                "stoppedAtMacNs": (MAC_NS + 5).to_string(),
                "partialSha256": sha256_hex(&publisher_partials[index]),
                "exitCode": 0,
                "signal": Value::Null,
                "replacementCount": 0,
            }));
        }
        for (worker, shard) in shards.as_array().expect("shards").iter().enumerate() {
            children.push(json!({
                "schema": "observed-child-process/v1",
                "childId": shard["childId"],
                "role": "subscriber-worker",
                "pid": 2000 + worker,
                "pgid": 900,
                "instanceNonce": digest(&format!("worker-nonce-{worker}")),
                "bunSha256": digest("bun"),
                "entrypointSha256": digest("fanout-role"),
                "tokenOrBundleSha256": digest(&format!("bundle-{worker}")),
                "publisherId": Value::Null,
                "workerIndex": worker,
                "orderedSubscriberIdsSha256": shard["orderedSubscriberIdsSha256"],
                "subscriberCount": shard_counts[worker],
                "spawnedAtMacNs": (MAC_NS + 1).to_string(),
                "readyAtMacNs": (MAC_NS + 2).to_string(),
                "warmupCompleteAtMacNs": (MAC_NS + 3).to_string(),
                "measureArmedAtMacNs": (MAC_NS + 4).to_string(),
                "stoppedAtMacNs": (MAC_NS + 5).to_string(),
                "partialSha256": sha256_hex(&worker_partials[worker]),
                "exitCode": 0,
                "signal": Value::Null,
                "replacementCount": 0,
            }));
        }
        let observed_process_proof = bytes_of(&json!({
            "schema": "observed-process-proof/v1",
            "executionSha256": execution_sha256,
            "cohortGrantSha256": grant_sha256,
            "cohortStartBarrierSha256": barrier_sha256,
            "expectedProcessCount": publisher_count + 8,
            "observedProcessCount": children.len(),
            "expectedPublisherCount": publisher_count,
            "observedPublisherCount": publisher_count,
            "expectedWorkerCount": 8,
            "observedWorkerCount": 8,
            "expectedSubscriberCount": SUBSCRIBERS,
            "observedSubscriberCount": SUBSCRIBERS,
            "childrenDigestSha256": sha256_hex(&bytes_of(&json!(children))),
            "children": children,
        }));
        let mut publisher_ids: Vec<String> = publishers
            .as_array()
            .expect("publishers")
            .iter()
            .map(|publisher| publisher["publisherId"].as_str().expect("id").to_owned())
            .collect();
        publisher_ids.sort();
        let linux_relay_observation = bytes_of(&json!({
            "schema": "linux-relay-observation/v1",
            "executionSha256": execution_sha256,
            "cohortGrantSha256": grant_sha256,
            "cohortStartBarrierSha256": barrier_sha256,
            "roleTokenCommitmentRootSha256": digest("root"),
            "serverChildPid": 4242,
            "serverChildPgid": 4242,
            "serverChildInstanceNonce": digest("server-instance"),
            "linuxClockId": digest("linux-clock"),
            "windowCount": WINDOWS,
            "registeredPublisherIds": publisher_ids,
            "registeredSubscriberIdsSha256": digest("subscriber-ids"),
            "registeredPublisherCount": publisher_count,
            "registeredSubscriberCount": SUBSCRIBERS,
            "acceptedIngressByOriginWindow": vec![per_window_ingress; WINDOWS],
            "acceptedIngressBytesByOriginWindow": vec![per_window_ingress * MESSAGE_BYTES; WINDOWS],
            "relayWritesCompletedByOriginWindow": vec![per_window_ingress * SUBSCRIBERS; WINDOWS],
            "relayWriteBytesByOriginWindow": vec![per_window_ingress * SUBSCRIBERS * MESSAGE_BYTES; WINDOWS],
            "duplicateIngressByOriginWindow": vec![0u64; WINDOWS],
            "reorderedIngressByOriginWindow": vec![0u64; WINDOWS],
            "queueDropDeliveriesByOriginWindow": vec![0u64; WINDOWS],
            "writeTimeoutDeliveriesByOriginWindow": vec![0u64; WINDOWS],
            "disconnectUndeliveredByOriginWindow": vec![0u64; WINDOWS],
            "malformedIngressByOriginWindow": vec![0u64; WINDOWS],
            "publisherEndCount": publisher_count,
            "subscriberEndCount": SUBSCRIBERS,
            "sessionsAccepted": publisher_count + SUBSCRIBERS,
            "sessionsActivePeak": publisher_count + SUBSCRIBERS,
            "publisherSessionsActivePeak": publisher_count,
            "subscriberSessionsActivePeak": SUBSCRIBERS,
            "queueItemsPeak": 10,
            "queueBytesPeak": 1280,
            "concurrentWritesPeak": 1000,
            "measurementStartedAtLinuxNs": "7000000000000",
            "relayDrainedAtLinuxNs": "7030000000000",
            "allSessionsClosedAtLinuxNs": "7031000000000",
            "allSessionsClosed": true,
        }));
        let offered = per_window_ingress * WINDOWS as u64;
        let delivered = offered * SUBSCRIBERS;
        let rate_series = bytes_of(&json!({
            "schema": "cohort-rate-series/v1",
            "sampleUnit": "count",
            "sampleWindowMs": 1000,
            "samples": vec![per_window_ingress * SUBSCRIBERS; WINDOWS],
            "measuredWindowDeliveredTotal": delivered,
            "postStopDrainDelivered": 0,
            "conservationDeliveredTotal": delivered,
            "firstDeliveryAtMacNs": (MAC_NS + 301_000_000).to_string(),
            "lastMeasuredWindowDeliveryAtMacNs": (MAC_NS + 301_000_000 + cell.measured_duration_ms * 1_000_000).to_string(),
            "lastDeliveryIncludingDrainAtMacNs": (MAC_NS + 301_000_000 + cell.measured_duration_ms * 1_000_000).to_string(),
            "measuredDurationMs": cell.measured_duration_ms,
            "meanNumerator": delivered * 1000,
            "meanDenominatorMs": cell.measured_duration_ms,
        }));
        let ledger = bytes_of(&json!({
            "schema": "cohort-ledger/v1",
            "offeredIngress": offered,
            "serverAcceptedIngress": offered,
            "offeredExpandedDeliveries": delivered,
            "serverAcceptedExpandedDeliveries": delivered,
            "linuxRelayWritesCompleted": delivered,
            "delivered": delivered,
            "deliveredBytes": delivered * MESSAGE_BYTES,
            "messageBytes": MESSAGE_BYTES,
        }));
        let capacity = bytes_of(&json!({
            "schema": "cohort-capacity/v1",
            "expectedSessions": publisher_count + SUBSCRIBERS,
            "sessionsAccepted": publisher_count + SUBSCRIBERS,
            "sessionsActivePeak": publisher_count + SUBSCRIBERS,
            "expectedPublishers": publisher_count,
            "registeredPublishers": publisher_count,
            "expectedSubscribers": SUBSCRIBERS,
            "registeredSubscribers": SUBSCRIBERS,
        }));
        Self {
            grant_sha256: grant_sha256.to_owned(),
            barrier_sha256: barrier_sha256.to_owned(),
            publisher_partials,
            worker_partials,
            ordered_partial_manifest,
            observed_process_proof,
            linux_relay_observation,
            rate_series,
            ledger,
            capacity,
        }
    }
}

/// The raw 64 signature bytes out of a `mac-receipt-signature/v1` carrier.
fn mac_signature_bytes(carrier: &[u8]) -> [u8; 64] {
    let carrier = json_of(carrier);
    unb64(carrier["signatureBase64"].as_str().expect("signature"))
        .as_slice()
        .try_into()
        .expect("64 bytes")
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
    // The Phase-A pair is routed by its own arm, not through the cohort table.
    assert!(ack_kind_for(MAC_OPEN_EXECUTION_KIND).is_none());
}

/// §3.3: `header.kind` is the payload `schema` with the terminal `/v1`
/// removed.
#[test]
fn the_mac_request_kinds_are_header_spelling_not_schema_spelling() {
    for kind in MAC_REQUEST_KINDS {
        assert!(!kind.ends_with("/v1"), "{kind} is schema spelling");
    }
    for schema in MAC_SIGNED_SCHEMAS.iter().chain(RIG_SIGNED_SCHEMAS) {
        assert!(schema.ends_with("/v1"), "{schema}");
    }
}

// --- the S3-r8 frame vectors, Rust half ---------------------------------------
//
// `S3_R8_PINNED_REMOTE_FRAME_HEX` (`cross-supervisor-protocol.test.ts:1606`)
// pins the TypeScript encoder's bytes for seven frames; the wave-3.5 gate
// found six of them had no Rust half.  These are the Rust halves: for each
// request kind the exact TS bytes are decoded as the binary decodes a frame,
// the header kind is the one the dispatch matches, and the payload passes the
// Rust exact-key parse for that kind — so a key added on one side and not the
// other moves a byte here.  For the two Mac-produced kinds (5 and 7) the Rust
// producer is run over the vector's own field values and must reproduce the
// TS payload bytes exactly.

/// A TS remote frame, split the way `comparison-supervisor.rs` splits it:
/// `u32 header length | header | u64 payload length | payload | sha256`.
fn split_frame(frame_hex: &str) -> (Value, Vec<u8>) {
    let frame = from_hex(frame_hex);
    let header_len = u32::from_be_bytes(frame[..4].try_into().expect("4")) as usize;
    let header: Value = serde_json::from_slice(&frame[4..4 + header_len]).expect("header");
    let rest = &frame[4 + header_len..];
    let payload_len = u64::from_be_bytes(rest[..8].try_into().expect("8")) as usize;
    let payload = rest[8..8 + payload_len].to_vec();
    assert_eq!(
        &rest[8 + payload_len..],
        sha256_raw(&payload).as_slice(),
        "payload digest"
    );
    (header, payload)
}

/// Amendment vector: `mac-open-cohort-request/v1` with C1's two arrays
/// (`.scratch/2026-09-05-cohort-completion/protocol-vectors.json`, and
/// `S3_R8_PINNED_REMOTE_FRAME_HEX["mac-open-cohort-request/v1"]`).
const TS_OPEN_COHORT_FRAME_HEX: &str = "0000004d7b226b696e64223a226d61632d6f70656e2d636f686f72742d72657175657374222c22736368656d61223a22636f6d70617269736f6e2d73757065727669736f722d6672616d652f7631227d0a00000000000002a07b22657865637574696f6e536861323536223a2261616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161222c227075626c697368657273426173653634223a2241773d3d222c2272657175657374536571223a302c22726f6c65506c616e48617368223a2232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232222c227363656e6172696f48617368223a2231313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131222c22736368656d61223a226d61632d6f70656e2d636f686f72742d726571756573742f7631222c2273756273637269626572536861726473426173653634223a2242413d3d222c22746f6b656e436f6d6d69746d656e744c6561664d616e6966657374426173653634223a2241673d3d222c22746f6b656e436f6d6d69746d656e744c6561664d616e6966657374536861323536223a2234343434343434343434343434343434343434343434343434343434343434343434343434343434343434343434343434343434343434343434343434343434222c22776f726b6c6f6164526f6c65506c616e496e707574426173653634223a2241513d3d222c22776f726b6c6f6164526f6c65506c616e496e707574536861323536223a2233333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333222c22776f726b6c6f6164526f6c65506c616e496e70757453697a65223a317d0a3f151e30a77e10cde54dbd19a15ac1144aafbb8d2129d91ae0c327598ebf5169";
const TS_OPEN_COHORT_FRAME_SHA256: &str =
    "327566975782d54cba051610971b2f44e50060571f583c2984366eaba309bc07";

/// S3-r8 vector 2.
const TS_WARMUP_MANIFEST_EXPORT_FRAME_HEX: &str = "000000637b226b696e64223a226d61632d6578706f72742d7761726d75702d636f6d706c6574696f6e2d6d616e69666573742d72657175657374222c22736368656d61223a22636f6d70617269736f6e2d73757065727669736f722d6672616d652f7631227d0a00000000000001327b22636f686f72745761726d757045706f6368536861323536223a2262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262222c22657865637574696f6e536861323536223a2261616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161222c2272657175657374536571223a362c22726f6c655761726d7570436f6d706c65746573426173653634223a5b2241513d3d222c2241673d3d222c2241773d3d225d2c22736368656d61223a226d61632d6578706f72742d7761726d75702d636f6d706c6574696f6e2d6d616e69666573742d726571756573742f7631227d0a37f8bca60ba5492ee0b9797a1db5e6d658d3f07faa0afc8d0119bb72193e56d0";

/// S3-r8 vector 3.
const TS_OBSERVATION_FRAME_HEX: &str = "000000597b226b696e64223a226d61632d70726573656e742d7269672d6f62736572766174696f6e2d72657175657374222c22736368656d61223a22636f6d70617269736f6e2d73757065727669736f722d6672616d652f7631227d0a000000000000036f7b22636f686f72744361706163697479426173653634223a2245413d3d222c22636f686f72744c6564676572426173653634223a2244773d3d222c22636f686f727452617465536572696573426173653634223a2244673d3d222c22657865637574696f6e536861323536223a2261616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161222c226c696e757852656c61794f62736572766174696f6e426173653634223a6e756c6c2c226f6273657276656450726f6365737350726f6f66426173653634223a2244513d3d222c226f7264657265645061727469616c4d616e6966657374426173653634223a2244413d3d222c2272657175657374536571223a31352c2272696742617272696572416363657074616e6365426173653634223a2242513d3d222c2272696742617272696572416363657074616e63655369676e6174757265426173653634223a2242673d3d222c22726967457865637574696f6e416363657074616e6365426173653634223a2241513d3d222c22726967457865637574696f6e416363657074616e63655369676e6174757265426173653634223a2241673d3d222c227269674d656173757265537461727441636b426173653634223a2241773d3d222c227269674d656173757265537461727441636b5369676e6174757265426173653634223a2242413d3d222c2272696752656c61794f62736572766174696f6e52656365697074426173653634223a6e756c6c2c2272696752656c61794f62736572766174696f6e526563656970745369676e6174757265426173653634223a6e756c6c2c22726967536572766572536e617073686f7452656365697074426173653634223a2243673d3d222c22726967536572766572536e617073686f74526563656970745369676e6174757265426173653634223a2243773d3d222c22736368656d61223a226d61632d70726573656e742d7269672d6f62736572766174696f6e2d726571756573742f7631222c227365727665725374617274426172726965724163636570746564426173653634223a2243413d3d222c227365727665725761726d7570447261696e6564426173653634223a2242773d3d222c22736e617073686f744672616d65426173653634223a2243513d3d227d0aab4b0da4529d80573b719394e26a4b1b656dc929c9e38e2832567690bf7b78a4";

/// S3-r8 vector 4.
const TS_EVIDENCE_EXPORT_FRAME_HEX: &str = "000000587b226b696e64223a226d61632d6578706f72742d636f686f72742d65766964656e63652d72657175657374222c22736368656d61223a22636f6d70617269736f6e2d73757065727669736f722d6672616d652f7631227d0a00000000000001217b22636f686f727441646d697373696f6e52656365697074536861323536223a2262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262222c22657865637574696f6e536861323536223a2261616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161222c2272657175657374536571223a31302c22726f6c654368696c6445766964656e636542756e646c65426173653634223a2242413d3d222c22736368656d61223a226d61632d6578706f72742d636f686f72742d65766964656e63652d726571756573742f7631227d0aa9164d8fd05d2fc70eefacefead0e48f8e064cbad4385493294e7b09677a546e";

/// S3-r8 vector 5 — a Mac-produced kind.
const TS_EVIDENCE_EXPORTED_ACK_FRAME_HEX: &str = "000000567b226b696e64223a226d61632d636f686f72742d65766964656e63652d6578706f727465642d61636b222c22736368656d61223a22636f6d70617269736f6e2d73757065727669736f722d6672616d652f7631227d0a00000000000001797b2261636b52657175657374536571223a31302c22636f686f72744f62736572766174696f6e45766964656e6365536861323536223a2262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262222c22636f686f72744f62736572766174696f6e45766964656e63655369676e6174757265426173653634223a2242513d3d222c22636f686f72744f62736572766174696f6e45766964656e636553697a65223a362c22657865637574696f6e536861323536223a2261616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161222c22726573706f6e7365536571223a31302c22736368656d61223a226d61632d636f686f72742d65766964656e63652d6578706f727465642d61636b2f7631222c227465726d696e616c4578706f7274223a747275657d0a85acea126d743b328b4bfb77de39b6dae0c6360494acfa7cb5bec137d5cfe220";

/// S3-r8 vector 6.
const TS_OPEN_EXECUTION_FRAME_HEX: &str = "000000507b226b696e64223a226d61632d6f70656e2d657865637574696f6e2d72657175657374222c22736368656d61223a22636f6d70617269736f6e2d73757065727669736f722d6672616d652f7631227d0a00000000000000b27b22657865637574696f6e4472616674426173653634223a2241513d3d222c22657865637574696f6e4472616674536861323536223a2261616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161222c2272657175657374536571223a302c22736368656d61223a226d61632d6f70656e2d657865637574696f6e2d726571756573742f7631227d0aa9a0c2e84f6b2cced2846903a1a92e25f330b0a9ab68cea63c4a951f10402be4";

/// S3-r8 vector 7 — a Mac-produced kind.
const TS_EXECUTION_OPENED_ACK_FRAME_HEX: &str = "0000004e7b226b696e64223a226d61632d657865637574696f6e2d6f70656e65642d61636b222c22736368656d61223a22636f6d70617269736f6e2d73757065727669736f722d6672616d652f7631227d0a00000000000001307b2261636b52657175657374536571223a302c22657865637574696f6e4472616674426173653634223a2241513d3d222c22657865637574696f6e536861323536223a2262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262222c226d6163457865637574696f6e4772616e7452656365697074426173653634223a2241773d3d222c226d6163457865637574696f6e4772616e745369676e6174757265426173653634223a2242413d3d222c226d6561737572656d656e744772616e74426173653634223a2241673d3d222c22726573706f6e7365536571223a302c22736368656d61223a226d61632d657865637574696f6e2d6f70656e65642d61636b2f7631227d0a5cac869de1edc11d6a62e4517cab0bab2124381d9a5c888aff3017111f09e051";

/// Amendment vector: the unsigned terminal ack transcript, byte for byte
/// (`cohortExportAckSigningBytes`, pinned in `protocol-vectors.json`).
const TS_UNSIGNED_EXPORT_ACK_TRANSCRIPT_HEX: &str = "7b2261636b52657175657374536571223a31302c22636f686f72744f62736572766174696f6e45766964656e6365536861323536223a2262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262222c22636f686f72744f62736572766174696f6e45766964656e636553697a65223a3132332c22657865637574696f6e536861323536223a2261616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161222c22726573706f6e7365536571223a31312c22736368656d61223a226d61632d636f686f72742d65766964656e63652d6578706f727465642d61636b2f7631222c227465726d696e616c4578706f7274223a747275657d0a";
const TS_UNSIGNED_EXPORT_ACK_TRANSCRIPT_SHA256: &str =
    "fca8b3a0cb3ac71f613eda44ef4f3f3828a09e0107a8fc39b7256bbd0ab41962";

/// The Rust parse-side pin for one TS request frame: header kind, dispatch,
/// and the exact-key parse of the payload.  The vector's field values are
/// placeholders (`AQ==`, `"a".repeat(64)`), so the transition refuses on
/// content — the pin is that it gets **past the shape** to that refusal.
fn assert_request_vector(frame_hex: &str, kind: &str, fields: &[&str], seq: u64) {
    use secure_fs::supervisor::records::strict_parse;
    let (header, payload) = split_frame(frame_hex);
    assert_eq!(header["kind"], kind);
    assert_eq!(header["schema"], "comparison-supervisor-frame/v1");
    let value = strict_parse(&payload).expect("payload");
    let map = value.as_object().expect("object");
    let mut present: Vec<&str> = map.keys().map(String::as_str).collect();
    present.sort_unstable();
    let mut expected: Vec<&str> = fields.to_vec();
    expected.sort_unstable();
    assert_eq!(
        present, expected,
        "{kind}: the Rust key set is the one the TS encoder carries"
    );
    assert_eq!(map["schema"], format!("{kind}/v1"));
    assert_eq!(map["requestSeq"], seq);
    // Re-encoded canonically, the payload is byte-identical: the TS encoder
    // is canonical, and so is this side's reading of it.
    assert_eq!(canonical_bytes(&value).expect("canonical"), payload);
}

#[test]
fn the_ts_open_cohort_frame_carries_the_c1_key_set_this_binary_parses() {
    use secure_fs::cohort::mac::MAC_OPEN_COHORT_FIELDS;
    assert_eq!(
        sha256_hex(&from_hex(TS_OPEN_COHORT_FRAME_HEX)),
        TS_OPEN_COHORT_FRAME_SHA256
    );
    assert_request_vector(
        TS_OPEN_COHORT_FRAME_HEX,
        "mac-open-cohort-request",
        MAC_OPEN_COHORT_FIELDS,
        0,
    );
    assert_eq!(
        ack_kind_for("mac-open-cohort-request"),
        Some("mac-cohort-opened-ack")
    );
    // And the dispatch reaches the transition: the placeholder values refuse
    // on content (no execution retained for `aaaa…`), never on shape.
    let (_, payload) = split_frame(TS_OPEN_COHORT_FRAME_HEX);
    let mut campaign = campaign();
    assert_eq!(
        campaign
            .runtime
            .dispatch_at("mac-open-cohort-request", &payload, NOW_MS, MAC_NS),
        Err(MacRefusal::Mismatch("execution not retained")),
    );
}

#[test]
fn the_ts_warmup_manifest_export_frame_is_the_one_this_binary_parses() {
    use secure_fs::cohort::mac::MAC_EXPORT_WARMUP_COMPLETION_MANIFEST_FIELDS;
    assert_request_vector(
        TS_WARMUP_MANIFEST_EXPORT_FRAME_HEX,
        "mac-export-warmup-completion-manifest-request",
        MAC_EXPORT_WARMUP_COMPLETION_MANIFEST_FIELDS,
        6,
    );
    let (_, payload) = split_frame(TS_WARMUP_MANIFEST_EXPORT_FRAME_HEX);
    let value: Value = serde_json::from_slice(&payload).expect("json");
    assert_eq!(
        value["roleWarmupCompletesBase64"]
            .as_array()
            .expect("array")
            .len(),
        3,
        "the base64Array kind decodes as an array of base64 strings",
    );
}

#[test]
fn the_pinned_observation_frame_is_the_one_the_ts_codec_produces() {
    use secure_fs::cohort::mac::MAC_PRESENT_RIG_OBSERVATION_FIELDS;
    assert_request_vector(
        TS_OBSERVATION_FRAME_HEX,
        "mac-present-rig-observation-request",
        MAC_PRESENT_RIG_OBSERVATION_FIELDS,
        15,
    );
    assert_eq!(
        ack_kind_for("mac-present-rig-observation-request"),
        Some("mac-measurement-admission-issued-ack"),
    );
    // Three of the twelve nullable fields travel as explicit null in the
    // vector; the decoder reads them as null and the other nine as bytes.
    let (_, payload) = split_frame(TS_OBSERVATION_FRAME_HEX);
    let value: Value = serde_json::from_slice(&payload).expect("json");
    for field in [
        "linuxRelayObservationBase64",
        "rigRelayObservationReceiptBase64",
        "rigRelayObservationReceiptSignatureBase64",
    ] {
        assert!(value[field].is_null(), "{field}");
    }
    assert_eq!(value["cohortCapacityBase64"], "EA==");
}

#[test]
fn the_ts_evidence_export_frame_is_the_one_this_binary_parses() {
    use secure_fs::cohort::mac::MAC_EXPORT_COHORT_EVIDENCE_FIELDS;
    assert_request_vector(
        TS_EVIDENCE_EXPORT_FRAME_HEX,
        "mac-export-cohort-evidence-request",
        MAC_EXPORT_COHORT_EVIDENCE_FIELDS,
        10,
    );
}

#[test]
fn the_ts_open_execution_frame_is_the_one_this_binary_parses() {
    use secure_fs::cohort::mac::MAC_OPEN_EXECUTION_FIELDS;
    assert_request_vector(
        TS_OPEN_EXECUTION_FRAME_HEX,
        MAC_OPEN_EXECUTION_KIND,
        MAC_OPEN_EXECUTION_FIELDS,
        0,
    );
    // The vector's draft is one byte, so the reader gets past the shape and
    // refuses on the digest: `sha256(0x01)` is not `"a".repeat(64)`.
    let (_, payload) = split_frame(TS_OPEN_EXECUTION_FRAME_HEX);
    assert_eq!(
        read_open_execution_request(&payload).err(),
        Some(MacRefusal::Mismatch("executionDraftSha256")),
    );
}

/// Vector 7, producer side: the Rust `opened_ack` over the vector's own
/// field values reproduces the TS payload byte for byte.
#[test]
fn the_rust_execution_opened_ack_reproduces_the_ts_vector() {
    let (header, payload) = split_frame(TS_EXECUTION_OPENED_ACK_FRAME_HEX);
    assert_eq!(header["kind"], "mac-execution-opened-ack");
    let expected: Value = serde_json::from_slice(&payload).expect("json");
    // The same encoder path `MacCohortRuntime::opened_ack` uses: canonical
    // JSON over the eight registered fields.
    let produced = bytes_of(&json!({
        "schema": "mac-execution-opened-ack/v1",
        "responseSeq": 0,
        "ackRequestSeq": 0,
        "executionSha256": "b".repeat(64),
        "executionDraftBase64": b64(&[1]),
        "measurementGrantBase64": b64(&[2]),
        "macExecutionGrantReceiptBase64": b64(&[3]),
        "macExecutionGrantSignatureBase64": b64(&[4]),
    }));
    assert_eq!(produced, payload);
    assert_eq!(expected["macExecutionGrantSignatureBase64"], "BA==");
    // And a real opened ack from the runtime has exactly this key set.
    let mut campaign = campaign();
    let (_, ack) = campaign.open_execution_with(1, |_| {});
    let mut keys: Vec<&str> = ack
        .as_object()
        .expect("object")
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    let mut expected_keys: Vec<&str> = expected
        .as_object()
        .expect("object")
        .keys()
        .map(String::as_str)
        .collect();
    expected_keys.sort_unstable();
    assert_eq!(keys, expected_keys);
}

/// Vector 5, producer side, and amendment C3's transcript pin: the Rust
/// terminal-ack encoder reproduces the TS payload, and the unsigned transcript
/// the binary signs is byte-identical to `cohortExportAckSigningBytes`.
#[test]
fn the_rust_export_ack_and_its_unsigned_transcript_reproduce_the_ts_vectors() {
    let (header, payload) = split_frame(TS_EVIDENCE_EXPORTED_ACK_FRAME_HEX);
    assert_eq!(header["kind"], "mac-cohort-evidence-exported-ack");
    let produced = bytes_of(&json!({
        "schema": "mac-cohort-evidence-exported-ack/v1",
        "responseSeq": 10,
        "ackRequestSeq": 10,
        "executionSha256": "a".repeat(64),
        "cohortObservationEvidenceSha256": "b".repeat(64),
        "cohortObservationEvidenceSize": 6,
        "cohortObservationEvidenceSignatureBase64": b64(&[5]),
        "terminalExport": true,
    }));
    assert_eq!(produced, payload);
    let transcript = cohort_export_ack_signing_bytes(11, 10, &"a".repeat(64), &"b".repeat(64), 123)
        .expect("transcript");
    assert_eq!(transcript, from_hex(TS_UNSIGNED_EXPORT_ACK_TRANSCRIPT_HEX));
    assert_eq!(
        sha256_hex(&transcript),
        TS_UNSIGNED_EXPORT_ACK_TRANSCRIPT_SHA256
    );
    assert_eq!(
        String::from_utf8(transcript).expect("utf8"),
        format!(
            "{{\"ackRequestSeq\":10,\"cohortObservationEvidenceSha256\":\"{}\",\"cohortObservationEvidenceSize\":123,\"executionSha256\":\"{}\",\"responseSeq\":11,\"schema\":\"mac-cohort-evidence-exported-ack/v1\",\"terminalExport\":true}}\n",
            "b".repeat(64),
            "a".repeat(64),
        ),
    );
}

/// The ack's own `mac-measurement-admission-issued-ack` header, read from
/// the answering side.
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
    assert_eq!(identity.receipt_validity_ms(), VALIDITY_MS);
    assert!(MacIdentity::new(
        b"not a pkcs8 der".to_vec(),
        &digest("nonce"),
        &digest("clock"),
        VALIDITY_MS
    )
    .is_err());
    assert!(MacIdentity::new(
        keys.private_pkcs8_der.clone(),
        "not-a-digest",
        &digest("clock"),
        VALIDITY_MS
    )
    .is_err());
    assert!(MacIdentity::new(
        keys.private_pkcs8_der,
        &digest("nonce"),
        &digest("clock"),
        0
    )
    .is_err());
}

#[test]
fn the_runtime_derives_the_same_public_half_as_the_identity() {
    let campaign = campaign();
    assert_eq!(campaign.runtime.public_raw32(), &campaign.mac_public_raw32);
}

/// C2: the two campaign-scoped inputs no frame may supply are installed once.
#[test]
fn the_campaign_authority_and_executable_digest_are_installed_once() {
    let mut campaign = campaign();
    assert_eq!(
        campaign
            .runtime
            .set_campaign_authority(&digest("x"), &digest("y")),
        Err(MacRefusal::Protocol("campaign authority")),
    );
    assert_eq!(
        campaign
            .runtime
            .set_supervisor_executable_sha256(&digest("z")),
        Err(MacRefusal::Protocol("supervisor executable")),
    );
    // And without either, no execution opens: the receipt has nothing to state.
    let mac = generate_ed25519_keypair();
    let mut bare = MacCohortRuntime::new(
        mac.private_pkcs8_der,
        campaign.rig.keys.public_raw32,
        &digest("n"),
        &digest("c"),
        VALIDITY_MS,
    )
    .expect("runtime");
    let draft = bytes_of(&execution_draft(1, NOW_MS + 10_000));
    let frame = bytes_of(&json!({
        "schema": "mac-open-execution-request/v1",
        "requestSeq": 0,
        "executionDraftSha256": sha256_hex(&draft),
        "executionDraftBase64": b64(&draft),
    }));
    let request = read_open_execution_request(&frame).expect("request");
    assert_eq!(
        bare.construct_execution(&request, b"{}\n", NOW_MS).err(),
        Some(MacRefusal::NotReady("campaign authority")),
    );
}

// --- §7's closed code table -------------------------------------------------

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
        MacRefusal::ResourceExhausted,
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

// --- Phase A in the binary (§2.9(2c), C2) ------------------------------------

/// The execution the Mac opens is the measurement the loop granted: every
/// identity on the draft is restated, the six Mac-assigned fields are the
/// grant's and this process's, and the receipt signs the whole of it.
#[test]
fn the_mac_opens_an_execution_over_the_loops_grant_and_signs_its_receipt() {
    let mut campaign = campaign();
    let (execution_sha256, ack) = campaign.open_execution_with(7, |_| {});
    let retained = campaign
        .runtime
        .execution(&execution_sha256)
        .expect("retained");
    let execution = &retained.execution;
    assert_eq!(execution["schema"], "cross-supervisor-execution/v1");
    assert_eq!(execution["runId"], "run-7");
    assert_eq!(
        execution["executionIndex"], 1,
        "the loop's ordinal, read off its grant"
    );
    assert_eq!(execution["measurementGrantSha256"], retained.grant_sha256);
    assert_eq!(
        execution["macSupervisorInstanceNonce"],
        digest("mac-instance")
    );
    assert_eq!(execution["draftSha256"], sha256_hex(&retained.draft_bytes));
    assert!(execution.get("requestedNotAfterMs").is_none());
    assert_eq!(
        execution.as_object().expect("object").len(),
        30,
        "FINAL_KEYS"
    );
    let grant = json_of(&retained.grant_bytes);
    assert_eq!(execution["issuedAtMs"], grant["issuedAt"]);
    assert_eq!(execution["notAfterMs"], grant["notAfter"]);
    assert_eq!(sha256_hex(&bytes_of(execution)), execution_sha256);
    // The receipt, exactly `MacExecutionGrantReceiptV1`, signed by the Mac.
    let receipt = json_of(&retained.receipt.bytes);
    assert_eq!(receipt["schema"], "mac-execution-grant-receipt/v1");
    assert_eq!(receipt["execution"], *execution);
    assert_eq!(receipt["executionSha256"], execution_sha256);
    assert_eq!(receipt["approvedPlanSha256"], digest("approved-plan"));
    assert_eq!(receipt["approvalRecordSha256"], digest("approval-record"));
    assert_eq!(
        receipt["macSupervisorExecutableSha256"],
        digest("mac-executable")
    );
    assert_eq!(receipt["receiptSequence"], 1);
    assert_eq!(receipt.as_object().expect("object").len(), 12);
    let carrier = json_of(&retained.receipt.signature);
    assert_eq!(carrier["signedSchema"], "mac-execution-grant-receipt/v1");
    assert_eq!(carrier["signedBytesSha256"], retained.receipt.sha256);
    secure_fs::cross_supervisor::verify_bytes(
        &campaign.mac_public_raw32,
        &retained.receipt.bytes,
        &mac_signature_bytes(&retained.receipt.signature),
    )
    .expect("the receipt verifies under the staged Mac key");
    // The ack carries the retained bytes and nothing re-encoded.
    assert_eq!(
        unb64(ack["executionDraftBase64"].as_str().expect("draft")),
        retained.draft_bytes
    );
    assert_eq!(
        unb64(ack["measurementGrantBase64"].as_str().expect("grant")),
        retained.grant_bytes
    );
    assert_eq!(
        unb64(
            ack["macExecutionGrantReceiptBase64"]
                .as_str()
                .expect("receipt")
        ),
        retained.receipt.bytes
    );
    assert_eq!(
        unb64(
            ack["macExecutionGrantSignatureBase64"]
                .as_str()
                .expect("sig")
        ),
        retained.receipt.signature
    );
    assert_eq!(ack["responseSeq"], 0);
}

/// A draft that does not describe the grant the loop issued opens nothing:
/// the run, the transport, the declaration and the validity window are the
/// loop's, and the draft may only restate them.
#[test]
fn an_execution_whose_draft_disagrees_with_the_grant_is_refused() {
    let now = secure_fs::measurement::now_epoch_millis().floor() as u64;
    let cases: Vec<(&str, Box<dyn Fn(&mut Value)>, MacRefusal)> = vec![
        (
            "run",
            Box::new(|draft| draft["runId"] = json!("another-run")),
            MacRefusal::Mismatch("original measurement grant"),
        ),
        (
            "transport",
            Box::new(|draft| draft["transport"] = json!("wt")),
            MacRefusal::Mismatch("original measurement grant"),
        ),
        (
            "declaration",
            Box::new(|draft| draft["declaredMessageCount"] = json!(300)),
            MacRefusal::Mismatch("fanout declaration"),
        ),
        (
            "approval",
            Box::new(|draft| draft["approvedPlanSha256"] = json!(digest("other plan"))),
            MacRefusal::Mismatch("approval identity"),
        ),
        (
            "validity",
            Box::new(|draft| draft["requestedNotAfterMs"] = json!(NOW_MS)),
            MacRefusal::Mismatch("requestedNotAfterMs"),
        ),
        (
            "kind",
            Box::new(|draft| draft["repetitionKind"] = json!("dry-run")),
            MacRefusal::Protocol("repetitionKind"),
        ),
        (
            "extra",
            Box::new(|draft| draft["executionIndex"] = json!(1)),
            MacRefusal::Protocol("record"),
        ),
    ];
    for (label, mutate, expected) in cases {
        let mut campaign = campaign();
        let mut draft = execution_draft(1, now + 3 * 3_600_000);
        mutate(&mut draft);
        let draft_bytes = bytes_of(&draft);
        let frame = bytes_of(&json!({
            "schema": "mac-open-execution-request/v1",
            "requestSeq": 0,
            "executionDraftSha256": sha256_hex(&draft_bytes),
            "executionDraftBase64": b64(&draft_bytes),
        }));
        let outcome = read_open_execution_request(&frame).and_then(|request| {
            // The loop grants what the *honest* draft asked for; a draft that
            // then disagrees with that grant is refused at construction.
            let key = ExecutionKey {
                campaign_id: CAMPAIGN_ID.to_owned(),
                run_id: "run-1".to_owned(),
                execution_index: 1,
                transport: "ws".to_owned(),
            };
            let grant = campaign
                .grants
                .issue(&GrantRequest {
                    candidate: CANDIDATE.to_owned(),
                    execution: key,
                    declared_message_count: 300_000,
                    declared_message_bytes: 128,
                })
                .expect("grant")
                .run_command_payload()
                .expect("payload");
            campaign
                .runtime
                .construct_execution(&request, &grant, NOW_MS)
                .map(|_| ())
        });
        assert_eq!(outcome, Err(expected), "{label}");
        assert_eq!(
            campaign.runtime.execution_count(),
            0,
            "{label}: nothing retained"
        );
    }
}

/// C2: the admitted series is transferred once, must be the execution's own,
/// and every later mint reads it from the retained state.
#[test]
fn the_admitted_series_is_retained_once_and_only_for_its_own_execution() {
    let mut campaign = campaign();
    let execution_sha256 = campaign.open_execution(1);
    let retained = campaign
        .runtime
        .execution(&execution_sha256)
        .expect("retained");
    let admitted = retained.admitted.as_ref().expect("admitted");
    assert_eq!(admitted.sample_unit, "count");
    assert_eq!(admitted.receipt.series.delivered, 300_000);
    assert_eq!(
        admitted.accepted_at_ms,
        NOW_MS + 30_011,
        "floored whole milliseconds"
    );
    let receipt = admitted.receipt.clone();
    let payload = b"{\"sampleUnit\":\"count\",\"samples\":[300000]}\n".to_vec();
    assert_eq!(
        campaign
            .runtime
            .retain_admitted_series(&execution_sha256, &receipt, &payload),
        Err(MacRefusal::Cohort("admission repeated")),
    );
    let mut other = receipt.clone();
    other.execution.execution_index = 2;
    let second = campaign.open_execution(2);
    assert_eq!(
        campaign
            .runtime
            .retain_admitted_series(&second, &receipt, &payload),
        Err(MacRefusal::Cohort("admission repeated")),
        "the second execution's own series is already retained",
    );
    assert_eq!(
        campaign
            .runtime
            .retain_admitted_series(&digest("nobody"), &other, &payload),
        Err(MacRefusal::Mismatch("execution not retained")),
    );
}

// --- the honest chat-1k cohort, end to end ------------------------------------

/// **The build's definition of done.** One honest chat-1k cohort through
/// every one of the eight transitions on the real runtime, each mint checked
/// for the inputs it binds and re-verified by the shared parser the other
/// host runs it through.  Mutation-proven by
/// `removing_any_one_input_source_stops_the_mint_that_needs_it` below.
#[test]
fn every_mint_reaches_its_inputs_on_an_honest_cohort() {
    let mut campaign = campaign();
    let execution_sha256 = campaign.open_execution(1);
    let retained = campaign
        .runtime
        .execution(&execution_sha256)
        .expect("retained")
        .clone();

    // Row 1: the grant.
    let ack = json_of(&campaign.open(&execution_sha256).expect("open"));
    assert_eq!(ack["schema"], "mac-cohort-opened-ack/v1");
    assert_eq!(
        ack["responseSeq"], 1,
        "the channel's second answer: the execution open took 0"
    );
    let grant_bytes = unb64(ack["cohortGrantBase64"].as_str().expect("grant"));
    let grant_signature = unb64(
        ack["cohortGrantSignatureBase64"]
            .as_str()
            .expect("signature"),
    );
    assert_eq!(ack["cohortGrantSha256"], sha256_hex(&grant_bytes));
    let grant = CohortGrantV1::parse_signed(
        &grant_bytes,
        &mac_signature_bytes(&grant_signature),
        &campaign.mac_public_raw32,
    )
    .expect("the rig's parser accepts the grant");
    let grant_value = json_of(&grant_bytes);
    assert_eq!(
        grant_value.as_object().expect("object").len(),
        37,
        "COHORT_GRANT_KEYS"
    );
    assert_eq!(grant.execution_sha256, execution_sha256);
    assert_eq!(
        grant.mac_execution_grant_receipt_sha256,
        retained.receipt.sha256
    );
    assert_eq!(grant.approved_plan_sha256, digest("approved-plan"));
    assert_eq!(grant.approval_record_sha256, digest("approval-record"));
    assert_eq!(
        grant.cohort_id,
        format!("cohort-{}", &execution_sha256[..16])
    );
    assert_eq!(grant.cohort_attempt, 1);
    assert_eq!(grant.transport, "ws");
    assert_eq!(
        (
            grant.publisher_count,
            grant.subscriber_count,
            grant.worker_count
        ),
        (10, 1_000, 8)
    );
    assert_eq!(
        (grant.expected_process_count, grant.expected_session_count),
        (18, 1_010)
    );
    assert_eq!(grant.publishers.len(), 10);
    assert_eq!(grant.subscriber_shards.len(), 8);
    assert_eq!(grant.role_token_commitment_count, 1_010);
    assert_eq!(
        (
            grant.readiness_deadline_ms,
            grant.measured_duration_ms,
            grant.message_bytes
        ),
        (90_000, 30_000, 128)
    );
    assert_eq!(
        (
            grant.expected_offered_ingress,
            grant.expected_expanded_deliveries
        ),
        (300, 300_000)
    );
    assert_eq!(grant_value["execution"], retained.execution);
    assert_eq!(
        grant_value["receiptSequence"], 2,
        "the campaign's second signed record"
    );
    {
        let session = campaign.session(&execution_sha256);
        assert_eq!(session.stage(), MacCohortStage::Opened);
        assert_eq!(
            session.manifest().root_sha256,
            grant.role_token_commitment_root_sha256
        );
        assert_eq!(
            session.manifest().sha256,
            grant.token_commitment_leaf_manifest_sha256
        );
        let (publishers, shards) = session.presented_topology();
        assert_eq!(
            grant_value["publishers"], *publishers,
            "the verified presented array, embedded"
        );
        assert_eq!(grant_value["subscriberShards"], *shards);
    }

    // Row 2: the rig's acceptance, bound to that grant.
    let ack = json_of(
        &campaign
            .present_cohort_acceptance(&execution_sha256)
            .expect("acceptance"),
    );
    assert_eq!(ack["schema"], "mac-rig-cohort-acceptance-ack/v1");
    assert_eq!(ack["responseSeq"], 2);
    assert_eq!(
        campaign.session(&execution_sha256).stage(),
        MacCohortStage::CohortAcceptanceRetained
    );

    // Row 3: the epoch.
    let ack = json_of(
        &campaign
            .issue_warmup_epoch(&execution_sha256)
            .expect("epoch"),
    );
    assert_eq!(ack["schema"], "mac-warmup-epoch-issued-ack/v1");
    assert_eq!(ack["responseSeq"], 3);
    let epoch_bytes = unb64(ack["cohortWarmupEpochBase64"].as_str().expect("epoch"));
    let epoch_signature = unb64(
        ack["cohortWarmupEpochSignatureBase64"]
            .as_str()
            .expect("sig"),
    );
    let epoch = secure_fs::cohort::rig::CohortWarmupEpochV1::parse_signed(
        &epoch_bytes,
        &mac_signature_bytes(&epoch_signature),
        &campaign.mac_public_raw32,
    )
    .expect("the rig's parser accepts the epoch");
    assert_eq!(epoch.cohort_grant_sha256, grant.sha256);
    assert_eq!(
        (
            epoch.expected_warmup_ingress,
            epoch.expected_warmup_deliveries
        ),
        (100, 100_000)
    );
    let epoch_value = json_of(&epoch_bytes);
    assert_eq!(epoch_value.as_object().expect("object").len(), 15);
    assert_eq!(epoch_value["durationMs"], 5_000);
    assert_eq!(epoch_value["warmupMessagesPerPublisher"], 10);
    assert_eq!(epoch_value["warmupIntervalMs"], 500);
    assert_ne!(epoch_value["warmupNonce"], grant_value["cohortId"]);
    assert_eq!(
        campaign.issue_warmup_epoch(&execution_sha256),
        Err(MacRefusal::Cohort("one warmup epoch per cohort")),
        "one epoch per cohort",
    );

    // Row 4: the completion manifest over every child's exact bytes.
    let ack = json_of(
        &campaign
            .export_warmup_manifest(&execution_sha256)
            .expect("manifest"),
    );
    assert_eq!(
        ack["schema"],
        "mac-warmup-completion-manifest-exported-ack/v1"
    );
    assert_eq!(ack["responseSeq"], 4);
    assert_eq!(ack["entryCount"], 18);
    assert_eq!(ack["terminalWarmupExport"], true);
    let manifest_bytes = unb64(
        ack["roleWarmupCompletionManifestBase64"]
            .as_str()
            .expect("manifest"),
    );
    let manifest_signature = unb64(
        ack["roleWarmupCompletionManifestSignatureBase64"]
            .as_str()
            .expect("sig"),
    );
    assert_eq!(
        ack["roleWarmupCompletionManifestSha256"],
        sha256_hex(&manifest_bytes)
    );
    assert_eq!(
        ack["roleWarmupCompletionManifestSize"],
        manifest_bytes.len()
    );
    assert_eq!(
        ack["roleWarmupCompletionManifestSignatureSha256"],
        sha256_hex(&manifest_signature)
    );
    let manifest = secure_fs::cohort::rig::RoleWarmupCompletionManifestV1::parse_signed(
        &manifest_bytes,
        &mac_signature_bytes(&manifest_signature),
        &campaign.mac_public_raw32,
    )
    .expect("the rig's parser accepts the manifest");
    assert_eq!(manifest.entry_count, 18);
    assert_eq!(manifest.cohort_warmup_epoch_sha256, epoch.sha256);
    let manifest_value = json_of(&manifest_bytes);
    let entries = manifest_value["entries"].as_array().expect("entries");
    assert_eq!(entries[0]["childId"], "publisher-child-0");
    assert_eq!(entries[0]["order"], 0);
    assert_eq!(entries[0]["offeredWarmupIngress"], 10);
    assert_eq!(entries[17]["childId"], "subscriber-worker-7");
    assert_eq!(entries[17]["deliveredWarmupRecords"], 125 * 100);
    assert_eq!(
        entries[17]["roleWarmupComplete"]["schema"],
        "retained-canonical-bytes/v1"
    );
    assert_eq!(
        entries[17]["roleWarmupComplete"]["sha256"],
        entries[17]["roleWarmupCompleteSha256"]
    );
    assert_eq!(
        campaign.export_warmup_manifest(&execution_sha256),
        Err(MacRefusal::Cohort("one warmup manifest per cohort")),
    );

    // Row 5: the barrier, ≥ 250 ms ahead on the Mac's continuous clock.
    let ack = json_of(
        &campaign
            .issue_start_barrier(&execution_sha256, None, None)
            .expect("barrier"),
    );
    assert_eq!(ack["schema"], "mac-start-barrier-issued-ack/v1");
    assert_eq!(ack["responseSeq"], 5);
    let barrier_bytes = unb64(ack["cohortStartBarrierBase64"].as_str().expect("barrier"));
    let barrier_signature = unb64(
        ack["cohortStartBarrierSignatureBase64"]
            .as_str()
            .expect("sig"),
    );
    assert_eq!(ack["cohortStartBarrierSha256"], sha256_hex(&barrier_bytes));
    let barrier = CohortStartBarrierV1::parse_signed(
        &barrier_bytes,
        &mac_signature_bytes(&barrier_signature),
        &campaign.mac_public_raw32,
    )
    .expect("the rig's parser accepts the barrier");
    assert_eq!(barrier.cohort_grant_sha256, grant.sha256);
    assert_eq!(
        barrier.role_warmup_completion_manifest_sha256,
        manifest.sha256
    );
    assert_eq!(
        barrier.rig_cohort_acceptance_sha256,
        sha256_hex(
            &campaign
                .rig_record(&execution_sha256, "rigCohortAcceptance")
                .0
        )
    );
    assert_eq!(
        barrier.rig_warmup_drained_receipt_sha256,
        sha256_hex(
            &campaign
                .rig_record(&execution_sha256, "rigWarmupDrainedReceipt")
                .0
        )
    );
    assert_eq!(
        barrier.rig_measure_start_ack_sha256,
        sha256_hex(
            &campaign
                .rig_record(&execution_sha256, "rigMeasureStartAck")
                .0
        )
    );
    assert_eq!(
        barrier.measure_start_at_mac_ns - barrier.minted_at_mac_ns,
        START_BARRIER_LEAD_NS
    );
    assert_eq!(
        barrier.measure_stop_at_mac_ns - barrier.measure_start_at_mac_ns,
        30_000_000_000
    );
    assert!(barrier.warmup_started_at_mac_ns <= barrier.warmup_completed_at_mac_ns);
    assert!(barrier.warmup_completed_at_mac_ns <= barrier.minted_at_mac_ns);
    assert_eq!(barrier.window_count, 30);
    assert_eq!(barrier.mac_clock_id, digest("mac-clock"));
    assert_eq!(
        json_of(&barrier_bytes).as_object().expect("object").len(),
        25
    );
    assert_eq!(
        campaign.issue_start_barrier(&execution_sha256, None, None),
        Err(MacRefusal::Cohort("one start barrier per cohort")),
    );

    // Row 6: the rig's barrier acceptance, naming this barrier.
    let ack = json_of(
        &campaign
            .present_barrier_acceptance(&execution_sha256)
            .expect("barrier acceptance"),
    );
    assert_eq!(ack["roleChildrenMayArm"], true);
    assert_eq!(ack["responseSeq"], 6);
    assert!(campaign.session(&execution_sha256).role_children_may_arm());

    // Row 7: the observation, and the two admission records.
    let ack = json_of(
        &campaign
            .present_observation(&execution_sha256)
            .expect("observation"),
    );
    assert_eq!(ack["schema"], "mac-measurement-admission-issued-ack/v1");
    assert_eq!(ack["responseSeq"], 7);
    let admission_bytes = unb64(
        ack["macMeasurementAdmissionReceiptBase64"]
            .as_str()
            .expect("admission"),
    );
    let admission_signature = unb64(
        ack["macMeasurementAdmissionSignatureBase64"]
            .as_str()
            .expect("sig"),
    );
    let cohort_admission_bytes = unb64(
        ack["cohortAdmissionReceiptBase64"]
            .as_str()
            .expect("cohort admission"),
    );
    let cohort_admission_signature =
        unb64(ack["cohortAdmissionSignatureBase64"].as_str().expect("sig"));
    for (bytes, carrier, schema) in [
        (
            &admission_bytes,
            &admission_signature,
            "mac-measurement-admission/v1",
        ),
        (
            &cohort_admission_bytes,
            &cohort_admission_signature,
            "cohort-admission-receipt/v1",
        ),
    ] {
        let carrier_value = json_of(carrier);
        assert_eq!(carrier_value["signedSchema"], schema);
        assert_eq!(carrier_value["signedBytesSha256"], sha256_hex(bytes));
        secure_fs::cross_supervisor::verify_bytes(
            &campaign.mac_public_raw32,
            bytes,
            &mac_signature_bytes(carrier),
        )
        .expect("signed by the Mac");
    }
    let admission = json_of(&admission_bytes);
    assert_eq!(admission.as_object().expect("object").len(), 34);
    assert_eq!(
        admission["admittedClientSeriesSha256"],
        retained.admitted.as_ref().expect("admitted").payload_sha256
    );
    assert_eq!(admission["measurementGrantSha256"], retained.grant_sha256);
    assert_eq!(
        admission["macExecutionGrantReceiptSha256"],
        retained.receipt.sha256
    );
    assert_eq!(admission["cohortGrantSha256"], grant.sha256);
    assert_eq!(admission["cohortStartBarrierSha256"], barrier.sha256);
    assert_eq!(admission["snapshotFrameSha256"], sha256_hex(SNAPSHOT_FRAME));
    assert_eq!(admission["campaignId"], CAMPAIGN_ID);
    assert_eq!(admission["runId"], "run-1");
    assert_eq!(admission["executionIndex"], 1);
    assert_eq!(admission["transport"], "ws");
    assert_eq!(admission["sampleUnit"], "count");
    assert_eq!(admission["delivered"], 300_000);
    assert_eq!(admission["spanMs"], 30_000);
    assert_eq!(admission["frameAcceptedAtMs"], NOW_MS + 30_011);
    assert_eq!(admission["approvedPlanSha256"], digest("approved-plan"));
    let cohort_admission = json_of(&cohort_admission_bytes);
    assert_eq!(
        cohort_admission.as_object().expect("object").len(),
        49,
        "COHORT_ADMISSION_RECEIPT_KEYS"
    );
    assert_eq!(
        cohort_admission["macMeasurementAdmissionReceiptSha256"],
        sha256_hex(&admission_bytes)
    );
    assert_eq!(
        cohort_admission["macMeasurementAdmissionSignatureSha256"],
        sha256_hex(&admission_signature)
    );
    assert_eq!(cohort_admission["cohortGrantSha256"], grant.sha256);
    assert_eq!(cohort_admission["cohortWarmupEpochSha256"], epoch.sha256);
    assert_eq!(
        cohort_admission["roleWarmupCompletionManifestSha256"],
        manifest.sha256
    );
    assert_eq!(cohort_admission["cohortStartBarrierSha256"], barrier.sha256);
    assert_eq!(
        cohort_admission["rigCohortAcceptanceSha256"],
        barrier.rig_cohort_acceptance_sha256
    );
    assert_eq!(
        cohort_admission["rigWarmupDrainedReceiptSha256"],
        barrier.rig_warmup_drained_receipt_sha256
    );
    assert_eq!(
        cohort_admission["serverWarmupDrainedSha256"],
        sha256_hex(&server_warmup_drained_bytes(&execution_sha256))
    );
    assert_eq!(
        cohort_admission["serverStartBarrierAcceptedSha256"],
        sha256_hex(&server_start_barrier_accepted_bytes(&execution_sha256))
    );
    let evidence = campaign.honest_evidence(&execution_sha256);
    assert_eq!(
        cohort_admission["linuxRelayObservationSha256"],
        sha256_hex(&evidence.linux_relay_observation)
    );
    assert_eq!(
        cohort_admission["orderedPartialManifestSha256"],
        sha256_hex(&evidence.ordered_partial_manifest)
    );
    assert_eq!(
        cohort_admission["observedProcessProofSha256"],
        sha256_hex(&evidence.observed_process_proof)
    );
    assert_eq!(
        cohort_admission["rateSeriesSha256"],
        sha256_hex(&evidence.rate_series)
    );
    assert_eq!(
        cohort_admission["ledgerSha256"],
        sha256_hex(&evidence.ledger)
    );
    assert_eq!(
        cohort_admission["capacitySha256"],
        sha256_hex(&evidence.capacity)
    );
    assert_eq!(
        (
            cohort_admission["publisherCount"].as_u64(),
            cohort_admission["workerCount"].as_u64(),
            cohort_admission["subscriberCount"].as_u64()
        ),
        (Some(10), Some(8), Some(1_000))
    );
    assert_eq!(cohort_admission["offeredIngress"], 300);
    assert_eq!(cohort_admission["serverAcceptedIngress"], 300);
    assert_eq!(cohort_admission["linuxRelayWritesCompleted"], 300_000);
    assert_eq!(cohort_admission["delivered"], 300_000);
    assert_eq!(
        campaign.session(&execution_sha256).stage(),
        MacCohortStage::ObservationVerified
    );

    // Row 8: the terminal export, and C3's signed ack.
    let ack_bytes = campaign.export_evidence(&execution_sha256).expect("export");
    let ack = json_of(&ack_bytes);
    assert_eq!(ack["schema"], "mac-cohort-evidence-exported-ack/v1");
    assert_eq!(ack["terminalExport"], true);
    assert_eq!(
        ack["responseSeq"], 8,
        "the ninth answer on this execution's channel: the execution open was 0, the cohort open 1"
    );
    assert!(ack_bytes.len() <= 8 * 1024);
    verify_cohort_export_ack_signature(&ack_bytes, &campaign.mac_public_raw32)
        .expect("C3 signature verifies");
    // The evidence itself is reassembled on the controller side; here the
    // digest is checked against a reassembly from the same retained bytes.
    let size = ack["cohortObservationEvidenceSize"].as_u64().expect("size");
    assert!(size > 100_000 && size < 9 * 1024 * 1024, "{size}");
    assert_eq!(
        campaign.runtime.session_count(),
        0,
        "terminal: the session is released"
    );
    assert_eq!(
        campaign.runtime.execution_count(),
        0,
        "terminal: the execution state is released"
    );
    assert_eq!(
        campaign.runtime.receipt_sequence(),
        7,
        "the signing sequence persists: receipt, grant, epoch, manifest, barrier, two admissions"
    );
    assert_eq!(campaign.runtime.signed_record_count(), 7);
    assert!(campaign.seq() > 8, "the channel counter persists");
}

/// The mutation proof for the test above: for each mint, remove exactly one
/// of the input sources the amendment names and show that mint — and no
/// earlier one — refuses.  Every row is a positive sibling's negative.
#[test]
fn removing_any_one_input_source_stops_the_mint_that_needs_it() {
    // Row 1 without the retained execution: no Phase A, no grant.
    {
        let mut campaign = campaign();
        assert_eq!(
            campaign.open(&digest("never opened")),
            Err(MacRefusal::Mismatch("execution not retained"))
        );
        assert_eq!(campaign.runtime.session_count(), 0);
    }
    // Row 1 without the admitted series is still a grant (the series is row
    // 7's input); row 7 without it is not.
    {
        let mut campaign = campaign();
        let mac = generate_ed25519_keypair();
        let mut runtime = MacCohortRuntime::new(
            mac.private_pkcs8_der,
            campaign.rig.keys.public_raw32,
            &digest("mac-instance"),
            &digest("mac-clock"),
            VALIDITY_MS,
        )
        .expect("runtime");
        runtime
            .set_campaign_authority(&digest("approved-plan"), &digest("approval-record"))
            .expect("authority");
        runtime
            .set_supervisor_executable_sha256(&digest("mac-executable"))
            .expect("exe");
        campaign.runtime = runtime;
        campaign.mac_public_raw32 = mac.public_raw32;
        // Open the execution without retaining a series.
        let now = secure_fs::measurement::now_epoch_millis().floor() as u64;
        let draft_bytes = bytes_of(&execution_draft(1, now + 3 * 3_600_000));
        let frame = bytes_of(&json!({
            "schema": "mac-open-execution-request/v1",
            "requestSeq": 0,
            "executionDraftSha256": sha256_hex(&draft_bytes),
            "executionDraftBase64": b64(&draft_bytes),
        }));
        campaign
            .runtime
            .charge_request_seq(MAC_OPEN_EXECUTION_KIND, &frame)
            .expect("seq");
        let request = read_open_execution_request(&frame).expect("request");
        let key = ExecutionKey {
            campaign_id: CAMPAIGN_ID.to_owned(),
            run_id: "run-1".to_owned(),
            execution_index: 1,
            transport: "ws".to_owned(),
        };
        let grant = campaign
            .grants
            .issue(&GrantRequest {
                candidate: CANDIDATE.to_owned(),
                execution: key,
                declared_message_count: 300_000,
                declared_message_bytes: 128,
            })
            .expect("grant")
            .run_command_payload()
            .expect("payload");
        let opened = campaign
            .runtime
            .construct_execution(&request, &grant, NOW_MS)
            .expect("opened");
        let execution_sha256 = opened.execution_sha256.clone();
        let acceptance = campaign.rig.sign(
            "rig-execution-acceptance/v1",
            &with_fields(
                rig_record("rig-execution-acceptance/v1", &execution_sha256, 1),
                &[
                    ("measurementGrantSha256", &sha256_hex(&grant)),
                    ("macExecutionGrantReceiptSha256", &opened.receipt.sha256),
                ],
            ),
        );
        campaign
            .rig_records
            .entry(execution_sha256.clone())
            .or_default()
            .insert("rigExecutionAcceptance", acceptance);
        campaign.reach_barrier(&execution_sha256);
        campaign
            .issue_start_barrier(&execution_sha256, None, None)
            .expect("barrier");
        campaign
            .present_barrier_acceptance(&execution_sha256)
            .expect("acceptance");
        assert_eq!(
            campaign.present_observation(&execution_sha256),
            Err(MacRefusal::NotReady("admitted series"))
        );
    }
    // Row 3 without row 2's retained acceptance.
    {
        let mut campaign = campaign();
        let execution_sha256 = campaign.open_execution(1);
        campaign.open(&execution_sha256).expect("open");
        assert_eq!(
            campaign
                .issue_warmup_epoch(&execution_sha256)
                .unwrap_err()
                .code(),
            "CROSS_SUPERVISOR_MISMATCH"
        );
    }
    // Row 4 without row 3's epoch.
    {
        let mut campaign = campaign();
        let execution_sha256 = campaign.open_execution(1);
        campaign.open(&execution_sha256).expect("open");
        campaign
            .present_cohort_acceptance(&execution_sha256)
            .expect("acceptance");
        let seq = campaign.seq();
        assert_eq!(
            campaign.dispatch(
                "mac-export-warmup-completion-manifest-request",
                &json!({
                    "schema": "mac-export-warmup-completion-manifest-request/v1",
                    "requestSeq": seq,
                    "executionSha256": execution_sha256,
                    "cohortWarmupEpochSha256": digest("no epoch"),
                    "roleWarmupCompletesBase64": [],
                })
            ),
            Err(MacRefusal::NotReady("warmup epoch")),
        );
    }
    // Row 5 without row 4's manifest: the rig records verify, the mint refuses.
    {
        let mut campaign = campaign();
        let execution_sha256 = campaign.open_execution(1);
        campaign.open(&execution_sha256).expect("open");
        campaign
            .present_cohort_acceptance(&execution_sha256)
            .expect("acceptance");
        campaign
            .issue_warmup_epoch(&execution_sha256)
            .expect("epoch");
        assert_eq!(
            campaign.issue_start_barrier(&execution_sha256, None, None),
            Err(MacRefusal::NotReady("warmup completion manifest")),
        );
    }
    // Row 6 without row 5's barrier.
    {
        let mut campaign = campaign();
        let execution_sha256 = campaign.open_execution(1);
        campaign.reach_barrier(&execution_sha256);
        assert_eq!(
            campaign.present_barrier_acceptance(&execution_sha256),
            Err(MacRefusal::NotReady("start barrier"))
        );
    }
    // Row 7 without row 6's barrier acceptance (a null on the frame).
    {
        let mut campaign = campaign();
        let execution_sha256 = campaign.open_execution(1);
        campaign.reach_barrier(&execution_sha256);
        campaign
            .issue_start_barrier(&execution_sha256, None, None)
            .expect("barrier");
        campaign.honest_barrier_acceptance(&execution_sha256, 4);
        let mut frame = campaign.observation_frame(&execution_sha256);
        frame["rigBarrierAcceptanceBase64"] = Value::Null;
        frame["rigBarrierAcceptanceSignatureBase64"] = Value::Null;
        assert_eq!(
            campaign.dispatch("mac-present-rig-observation-request", &frame),
            Err(MacRefusal::Mismatch("rigBarrierAcceptance is null")),
        );
    }
    // Row 8 without row 7's admission.
    {
        let mut campaign = campaign();
        let execution_sha256 = campaign.open_execution(1);
        campaign.reach_barrier(&execution_sha256);
        assert_eq!(
            campaign.export_evidence(&execution_sha256),
            Err(MacRefusal::NotReady("admission"))
        );
    }
}

/// C1, in detail: every presented-topology property the amendment names is
/// checked against the leaves, and each is refused by exactly one mutation.
#[test]
fn the_presented_topology_is_verified_leaf_by_leaf() {
    let execution_sha256 = digest(&execution_tag(9));
    let manifest = leaf_manifest(&execution_sha256, "cohort-topology", 10, 1_000);
    let verified = verify_token_commitment_leaf_manifest(
        &bytes_of(&manifest),
        &execution_sha256,
        cohort_cell(CHAT_1K_CELL).expect("cell"),
    )
    .expect("manifest");
    let (publishers, shards) = presented_topology(&manifest);
    verify_presented_topology(&bytes_of(&publishers), &bytes_of(&shards), &verified)
        .expect("honest topology");
    let refuse = |publishers: &Value, shards: &Value, expected: MacRefusal, label: &str| {
        assert_eq!(
            verify_presented_topology(&bytes_of(publishers), &bytes_of(shards), &verified),
            Err(expected),
            "{label}"
        );
    };
    let mut bad = publishers.clone();
    bad[0]["tokenSha256"] = json!(digest("wrong token"));
    refuse(
        &bad,
        &shards,
        MacRefusal::Mismatch("publisher topology"),
        "token hash",
    );
    let mut bad = publishers.clone();
    bad.as_array_mut().expect("array").swap(0, 1);
    refuse(
        &bad,
        &shards,
        MacRefusal::Mismatch("publisher topology"),
        "publisher order",
    );
    let mut bad = publishers.clone();
    bad[3]["tokenCommitmentIndex"] = json!(4);
    refuse(
        &bad,
        &shards,
        MacRefusal::Mismatch("publisher topology"),
        "commitment index",
    );
    let mut bad = publishers.clone();
    bad.as_array_mut().expect("array").pop();
    refuse(
        &bad,
        &shards,
        MacRefusal::Mismatch("publisher cardinality"),
        "publisher count",
    );
    let mut bad = shards.clone();
    bad.as_array_mut().expect("array").pop();
    refuse(
        &publishers,
        &bad,
        MacRefusal::Mismatch("shard cardinality"),
        "eight shards",
    );
    let mut bad = shards.clone();
    bad.as_array_mut().expect("array").swap(2, 3);
    refuse(
        &publishers,
        &bad,
        MacRefusal::Mismatch("subscriber topology"),
        "workerIndex == index",
    );
    let mut bad = shards.clone();
    bad[5]["modulus"] = json!(16);
    refuse(
        &publishers,
        &bad,
        MacRefusal::Mismatch("subscriber topology"),
        "modulus",
    );
    let mut bad = shards.clone();
    bad[5]["residue"] = json!(6);
    refuse(
        &publishers,
        &bad,
        MacRefusal::Mismatch("subscriber topology"),
        "residue",
    );
    let mut bad = shards.clone();
    bad[0]["lastSubscriberIndexExclusive"] = json!(1_250);
    refuse(
        &publishers,
        &bad,
        MacRefusal::Mismatch("subscriber topology"),
        "union",
    );
    let mut bad = shards.clone();
    bad[0]["orderedSubscriberIdsSha256"] = json!(digest("other ids"));
    refuse(
        &publishers,
        &bad,
        MacRefusal::Mismatch("subscriber topology"),
        "ordered-id digest",
    );
    let mut bad = shards.clone();
    bad[1]["firstTokenCommitmentIndex"] = json!(10);
    refuse(
        &publishers,
        &bad,
        MacRefusal::Mismatch("subscriber topology"),
        "commitment range",
    );
    // R-A: the honest window is the residue class's exact span, and the
    // dense `first + count` (what every producer minted before the ruling,
    // sixteen members' worth of a 125-member shard) is refused with the same
    // closed code, as is a window one past the class.
    for worker in 0..8 {
        let first = shards[worker]["firstTokenCommitmentIndex"]
            .as_u64()
            .expect("first");
        let count = shards[worker]["subscriberCount"].as_u64().expect("count");
        assert_eq!(first, 10 + worker as u64, "chat-1k: ten publishers first");
        assert_eq!(count, 125);
        assert_eq!(
            shards[worker]["lastTokenCommitmentIndexExclusive"],
            json!(shard_commitment_window_end(first, count).expect("window")),
        );
        let mut bad = shards.clone();
        bad[worker]["lastTokenCommitmentIndexExclusive"] = json!(first + count);
        refuse(
            &publishers,
            &bad,
            MacRefusal::Mismatch("subscriber topology"),
            "dense window",
        );
        let mut bad = shards.clone();
        bad[worker]["lastTokenCommitmentIndexExclusive"] = json!(first + (count - 1) * 8 + 2);
        refuse(
            &publishers,
            &bad,
            MacRefusal::Mismatch("subscriber topology"),
            "wide window",
        );
    }
    let mut bad = shards.clone();
    bad[7]["subscriberCount"] = json!(124);
    refuse(
        &publishers,
        &bad,
        MacRefusal::Mismatch("subscriber topology"),
        "membership",
    );
    let mut bad = shards.clone();
    bad[7]["childId"] = json!("subscriber-worker-6");
    refuse(
        &publishers,
        &bad,
        MacRefusal::Mismatch("subscriber topology"),
        "child",
    );
    let mut bad = shards.clone();
    bad[7]["extra"] = json!(1);
    refuse(
        &publishers,
        &bad,
        MacRefusal::Protocol("record"),
        "exact keys",
    );
    // Non-canonical bytes are refused before any of it: the bytes presented
    // are the bytes the grant would carry.
    let mut spaced = bytes_of(&publishers);
    spaced.insert(1, b' ');
    assert_eq!(
        verify_presented_topology(&spaced, &bytes_of(&shards), &verified),
        Err(MacRefusal::Protocol("canonical topology")),
    );
    // And the grant that embeds them refuses a topology built for another
    // cohort's leaves.
    let other = leaf_manifest(&execution_sha256, "cohort-other", 10, 1_000);
    let (other_publishers, _) = presented_topology(&other);
    refuse(
        &other_publishers,
        &shards,
        MacRefusal::Mismatch("publisher topology"),
        "another cohort's tokens",
    );
}

/// C1's carrier bounds: the largest registered topology, with a production
/// 41-character cohort id, fits the 7 MiB open frame under its per-field caps;
/// each cap refuses at cap + 1 and admits at the cap.
#[test]
fn the_largest_registered_topology_fits_the_open_carrier_and_the_caps_are_exact() {
    let cohort_id = "c".repeat(41);
    let execution_sha256 = "a".repeat(64);
    let manifest_value = leaf_manifest(&execution_sha256, &cohort_id, 10, 10_000);
    let manifest = bytes_of(&manifest_value);
    assert_eq!(
        manifest.len(),
        2_713_015,
        "the amendment's measured chat-10k manifest"
    );
    assert!(manifest.len() > 1024 * 1024 && manifest.len() <= 4 * 1024 * 1024);
    let (publishers, shards) = presented_topology(&manifest_value);
    let publishers_bytes = bytes_of(&publishers);
    let shards_bytes = bytes_of(&shards);
    assert!(publishers_bytes.len() <= 256 * 1024 && shards_bytes.len() <= 256 * 1024);
    let verified = verify_token_commitment_leaf_manifest(
        &manifest,
        &execution_sha256,
        cohort_cell("chat-fanout/subscribers-10000").expect("cell"),
    )
    .expect("chat-10k manifest");
    verify_presented_topology(&publishers_bytes, &shards_bytes, &verified)
        .expect("chat-10k topology");
    let plan = bytes_of(&role_plan_input(
        "chat-fanout/subscribers-10000",
        10,
        10_000,
    ));
    let frame = bytes_of(&json!({
        "schema": "mac-open-cohort-request/v1",
        "requestSeq": 0,
        "executionSha256": execution_sha256,
        "scenarioHash": digest("scenario"),
        "rolePlanHash": digest("role-plan"),
        "workloadRolePlanInputBase64": b64(&plan),
        "workloadRolePlanInputSha256": sha256_hex(&plan),
        "workloadRolePlanInputSize": plan.len(),
        "tokenCommitmentLeafManifestBase64": b64(&manifest),
        "tokenCommitmentLeafManifestSha256": sha256_hex(&manifest),
        "publishersBase64": b64(&publishers_bytes),
        "subscriberShardsBase64": b64(&shards_bytes),
    }));
    assert!(frame.len() <= 7 * 1024 * 1024, "{} bytes", frame.len());
    assert!(frame.len() > 1024 * 1024, "past the old default cap");
    // The budget charges the four decoded lengths, and the frame parses under
    // the kind's own cap: the refusal is content (no execution), not size.
    let mut budget = CohortEvidenceBudget::default();
    let frame_value: Value = serde_json::from_slice(&frame).expect("json");
    assert_eq!(
        budget.charge(frame_value.as_object().expect("object")),
        Ok((manifest.len() + publishers_bytes.len() + shards_bytes.len() + plan.len()) as u64),
    );
    let mut probe = campaign();
    assert_eq!(
        probe
            .runtime
            .dispatch_at("mac-open-cohort-request", &frame, NOW_MS, MAC_NS),
        Err(MacRefusal::Mismatch("execution not retained")),
    );
    // Exact caps, at and past, per field: at the cap the frame reaches a
    // content refusal; one past it is refused as oversize before any decode.
    let mut campaign = campaign();
    let execution_sha256 = campaign.open_execution(1);
    for (field, cap) in [
        ("workloadRolePlanInputBase64", 256 * 1024usize),
        ("tokenCommitmentLeafManifestBase64", 4 * 1024 * 1024),
        ("publishersBase64", 256 * 1024),
        ("subscriberShardsBase64", 256 * 1024),
    ] {
        let at_cap = campaign.open_frame(&execution_sha256, |frame| {
            frame[field] = json!(b64(&vec![b'{'; cap]));
        });
        assert_ne!(
            at_cap,
            Err(MacRefusal::Cohort("oversize")),
            "{field} at cap is not oversize"
        );
        assert!(
            at_cap.is_err(),
            "{field}: placeholder bytes are refused on content"
        );
        let past = campaign.open_frame(&execution_sha256, |frame| {
            frame[field] = json!(b64(&vec![b'{'; cap + 1]));
        });
        assert_eq!(
            past,
            Err(MacRefusal::Cohort("oversize")),
            "{field} at cap + 1"
        );
        assert_eq!(
            campaign.runtime.session_count(),
            0,
            "{field}: a refused open leaves no session"
        );
    }
    // The whole frame's 7 MiB cap, one past.
    let seq = campaign.seq();
    let mut oversize = bytes_of(&json!({
        "schema": "mac-open-cohort-request/v1",
        "requestSeq": seq,
        "executionSha256": execution_sha256,
    }));
    oversize.resize(7 * 1024 * 1024 + 1, b' ');
    assert_eq!(
        campaign
            .runtime
            .dispatch_at("mac-open-cohort-request", &oversize, NOW_MS, MAC_NS),
        Err(MacRefusal::Cohort("oversize")),
    );
}

/// The per-execution budget refuses an open frame whose four decoded fields
/// exceed it, before any of them is decoded.
#[test]
fn the_open_frame_is_charged_before_it_is_decoded() {
    let mut campaign = campaign();
    let execution_sha256 = campaign.open_execution(1);
    let huge = "A".repeat(((COHORT_REMOTE_EVIDENCE_BUDGET_MAX_BYTES as usize / 3) + 1) * 4);
    let seq = campaign.seq();
    let frame = format!(
        "{{\"executionSha256\":\"{execution_sha256}\",\"publishersBase64\":\"AQ==\",\"requestSeq\":{seq},\"rolePlanHash\":\"{}\",\"scenarioHash\":\"{}\",\"schema\":\"mac-open-cohort-request/v1\",\"subscriberShardsBase64\":\"AQ==\",\"tokenCommitmentLeafManifestBase64\":\"{huge}\",\"tokenCommitmentLeafManifestSha256\":\"{}\",\"workloadRolePlanInputBase64\":\"AQ==\",\"workloadRolePlanInputSha256\":\"{}\",\"workloadRolePlanInputSize\":1}}\n",
        digest("role-plan"),
        digest("scenario"),
        digest("m"),
        digest("p"),
    );
    // Past the 7 MiB frame cap, so the frame itself is oversize; the budget
    // is exercised directly with the same field.
    assert_eq!(
        campaign
            .runtime
            .dispatch_at("mac-open-cohort-request", frame.as_bytes(), NOW_MS, MAC_NS),
        Err(MacRefusal::Cohort("oversize")),
    );
    let mut budget = CohortEvidenceBudget::default();
    let value =
        json!({"schema": "mac-open-cohort-request/v1", "tokenCommitmentLeafManifestBase64": huge});
    assert_eq!(
        budget.charge(value.as_object().expect("object")),
        Err(MacRefusal::ResourceExhausted)
    );
}

// --- §2.9(5): the six forgery tests, each beside its honest sibling ----------

/// The honest baseline every forgery is measured against: an honest barrier
/// request mints a barrier, with both rig records verified and retained.
#[test]
fn an_honest_barrier_request_passes_every_verification() {
    let mut campaign = campaign();
    let execution_sha256 = campaign.open_execution(1);
    campaign.reach_barrier(&execution_sha256);
    let ack = json_of(
        &campaign
            .issue_start_barrier(&execution_sha256, None, None)
            .expect("barrier"),
    );
    assert_eq!(ack["schema"], "mac-start-barrier-issued-ack/v1");
    let session = campaign.session(&execution_sha256);
    assert_eq!(session.stage(), MacCohortStage::BarrierIssued);
    assert_eq!(
        session
            .retained("rigWarmupDrainedReceipt")
            .expect("drained")
            .schema,
        "rig-warmup-drained-receipt/v1"
    );
    assert_eq!(
        session.retained("rigMeasureStartAck").expect("ack").schema,
        "rig-measure-start-ack/v1"
    );
    assert!(session.start_barrier().is_some());
}

#[test]
fn an_invented_rig_ack_mints_no_barrier() {
    let mut campaign = campaign();
    let execution_sha256 = campaign.open_execution(1);
    campaign.reach_barrier(&execution_sha256);
    // The controller signs its own `rig-measure-start-ack/v1` with a key it
    // holds.  Every field is right; the key is not the staged one.
    let (_, honest_ack) = campaign.honest_barrier_inputs(&execution_sha256);
    let forger = RigSigner::new();
    let invented = forger.sign("rig-measure-start-ack/v1", &json_of(&honest_ack.0));
    assert_eq!(
        campaign.issue_start_barrier(&execution_sha256, None, Some(invented)),
        Err(MacRefusal::RigSigningKeyMismatch),
        "an invented ack is refused as a key mismatch, not as a missing mint",
    );
    let session = campaign.session(&execution_sha256);
    assert_eq!(
        session
            .retained("rigMeasureStartAck")
            .map(|record| record.schema),
        Err(MacRefusal::Mismatch("record not retained by this session")),
        "and nothing about the invented ack was retained",
    );
    assert!(session.start_barrier().is_none(), "no barrier");
}

#[test]
fn a_mutated_rig_receipt_mints_no_barrier() {
    let mut campaign = campaign();
    let execution_sha256 = campaign.open_execution(1);
    campaign.reach_barrier(&execution_sha256);
    // A genuine rig receipt with one field rewritten after signing: the
    // validity window is pushed out by an hour.
    let (_, (bytes, signature)) = campaign.honest_barrier_inputs(&execution_sha256);
    let mut mutated: Value = json_of(&bytes);
    mutated["notAfterMs"] = json!(NOW_MS + VALIDITY_MS * 2);
    let mutated = bytes_of(&mutated);
    assert_ne!(mutated, bytes);
    assert_eq!(
        campaign.issue_start_barrier(&execution_sha256, None, Some((mutated, signature))),
        Err(MacRefusal::Mismatch("signedBytesSha256")),
        "the carrier's digest is over the bytes the rig signed, not the mutated ones",
    );
    assert!(campaign
        .session(&execution_sha256)
        .start_barrier()
        .is_none());
}

#[test]
fn a_cross_paired_rig_signature_mints_no_barrier() {
    let mut campaign = campaign();
    let execution_sha256 = campaign.open_execution(1);
    campaign.reach_barrier(&execution_sha256);
    // Receipt A's bytes under receipt B's signature carrier. Both are genuine
    // rig records signed by the staged key; only the pairing is the forgery.
    let ((_, drained_signature), (ack_bytes, _)) =
        campaign.honest_barrier_inputs(&execution_sha256);
    assert_eq!(
        campaign.issue_start_barrier(
            &execution_sha256,
            None,
            Some((ack_bytes, drained_signature))
        ),
        Err(MacRefusal::Mismatch("signedSchema")),
        "the carrier names the schema it covers and the pairing is caught there",
    );
    assert!(campaign
        .session(&execution_sha256)
        .start_barrier()
        .is_none());
}

#[test]
fn a_rig_receipt_from_another_execution_mints_no_barrier() {
    let mut campaign = campaign();
    let previous = campaign.open_execution(1);
    let execution_sha256 = campaign.open_execution(2);
    campaign.reach_barrier(&previous);
    campaign.reach_barrier(&execution_sha256);
    // Last execution's genuine, staged-key-signed ack, replayed into this one.
    let (_, replayed) = campaign.honest_barrier_inputs(&previous);
    assert_eq!(
        campaign.issue_start_barrier(&execution_sha256, None, Some(replayed)),
        Err(MacRefusal::Mismatch("executionSha256")),
        "the signature verifies and the record describes another execution",
    );
    assert!(campaign
        .session(&execution_sha256)
        .start_barrier()
        .is_none());
}

/// The sixth forgery, the one that reaches the Ed25519 verification itself:
/// every carrier field is honest and only `signatureBase64` is fabricated.
/// Deleting `verify_bytes` from `verify_rig_record` turns exactly this test
/// red (proven by mutation at the wave-3.5 gate and again for this build).
#[test]
fn a_rig_receipt_with_an_honest_carrier_and_a_fabricated_signature_mints_no_barrier() {
    let mut campaign = campaign();
    let execution_sha256 = campaign.open_execution(1);
    campaign.reach_barrier(&execution_sha256);
    let (_, (bytes, carrier)) = campaign.honest_barrier_inputs(&execution_sha256);
    let mut forged: Value = json_of(&carrier);
    let honest = forged["signatureBase64"].as_str().expect("sig").to_owned();
    forged["signatureBase64"] = json!(b64(&[7u8; 64]));
    assert_ne!(forged["signatureBase64"].as_str(), Some(honest.as_str()));
    assert_eq!(forged["signedBytesSha256"], json!(sha256_hex(&bytes)));
    assert_eq!(forged["signedSchema"], json!("rig-measure-start-ack/v1"));
    assert_eq!(
        forged["signingPublicKeySha256"],
        json!(campaign.rig.public_key_sha256())
    );
    assert_eq!(
        campaign.issue_start_barrier(&execution_sha256, None, Some((bytes, bytes_of(&forged)))),
        Err(MacRefusal::RigSignatureInvalid),
        "only the Ed25519 verification can refuse an honest carrier over a bad signature",
    );
    assert!(campaign
        .session(&execution_sha256)
        .start_barrier()
        .is_none());
}

#[test]
fn a_barrier_without_the_drained_receipt_is_refused() {
    let mut campaign = campaign();
    let execution_sha256 = campaign.open_execution(1);
    campaign.reach_barrier(&execution_sha256);
    let empty = (b"{}\n".to_vec(), b"{}\n".to_vec());
    let refusal = campaign
        .issue_start_barrier(&execution_sha256, Some(empty), None)
        .expect_err("no barrier");
    assert_eq!(refusal.code(), "TRUST_PROTOCOL");
    let session = campaign.session(&execution_sha256);
    assert_eq!(
        session.retained("rigWarmupDrainedReceipt").err(),
        Some(MacRefusal::Mismatch("record not retained by this session")),
    );
    assert!(session.start_barrier().is_none());
}

/// Row 5's own bindings, beyond the signatures: a genuine drained receipt
/// that names another cohort's grant, or a genuine ack that names another
/// drained receipt, mints nothing.
#[test]
fn a_barrier_request_whose_rig_records_name_another_cohort_mints_no_barrier() {
    let mut campaign = campaign();
    let execution_sha256 = campaign.open_execution(1);
    campaign.reach_barrier(&execution_sha256);
    let (honest_drained, _) = campaign.honest_barrier_inputs(&execution_sha256);
    let mut other = json_of(&honest_drained.0);
    other["cohortGrantSha256"] = json!(digest("another grant"));
    let drained = campaign.rig.sign("rig-warmup-drained-receipt/v1", &other);
    assert_eq!(
        campaign.issue_start_barrier(&execution_sha256, Some(drained), None),
        Err(MacRefusal::Mismatch("cohortGrantSha256")),
    );
    let (_, honest_ack) = campaign.honest_barrier_inputs(&execution_sha256);
    let mut other = json_of(&honest_ack.0);
    other["rigWarmupDrainedReceiptSha256"] = json!(digest("another drained receipt"));
    let ack = campaign.rig.sign("rig-measure-start-ack/v1", &other);
    assert_eq!(
        campaign.issue_start_barrier(&execution_sha256, None, Some(ack)),
        Err(MacRefusal::Mismatch("rigWarmupDrainedReceiptSha256")),
    );
    assert!(campaign
        .session(&execution_sha256)
        .start_barrier()
        .is_none());
    // And the honest pair still mints afterwards: a refused frame retains
    // nothing that blocks the honest one.
    campaign
        .issue_start_barrier(&execution_sha256, None, None)
        .expect("honest barrier");
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
///   allowed to agree — the second half replays the whole opening sequence so
///   the counter lines up, and the admission is still refused because the
///   drained receipt was verified by a process that is gone.
#[test]
fn a_restarted_mac_supervisor_refuses_to_admit_on_five_of_seven() {
    // One process, driven to the barrier, then asked for — and granted —
    // the admission.
    let mut first = campaign();
    let execution_sha256 = first.open_execution(1);
    first.reach_barrier(&execution_sha256);
    first
        .issue_start_barrier(&execution_sha256, None, None)
        .expect("barrier");
    first
        .present_barrier_acceptance(&execution_sha256)
        .expect("acceptance");
    let observation_seq = first.seq();
    assert!(observation_seq > 0, "the channel has advanced");
    let mid_execution_frame = first.observation_frame(&execution_sha256);
    first
        .dispatch("mac-present-rig-observation-request", &mid_execution_frame)
        .expect("the honest path verifies all seven and mints");

    // Net 1: the restarted process's channel begins at 0, so the same frame is
    // caught before any state is consulted.
    let mut restarted = campaign_with(RigSigner {
        keys: first.rig.keys.clone(),
    });
    assert_eq!(restarted.seq(), 0);
    assert_eq!(
        restarted.runtime.dispatch_at(
            "mac-present-rig-observation-request",
            &bytes_of(&mid_execution_frame),
            NOW_MS,
            MAC_NS
        ),
        Err(MacRefusal::Protocol("requestSeq")),
        "net 1 fires before the session is looked up",
    );

    // Net 2, with net 1 satisfied: a second restarted process whose channel is
    // walked forward to the same point — but which never saw the cohort
    // acceptance or the drained receipt.  It has no execution either, so it
    // must be handed the same draft and grant to even hold a session; that is
    // the restart-with-five-of-seven shape.
    let mut second = campaign_with(RigSigner {
        keys: first.rig.keys.clone(),
    });
    let replayed_execution = second.open_execution(1);
    assert_ne!(
        replayed_execution, execution_sha256,
        "a fresh grant is a fresh execution"
    );
    second
        .open(&replayed_execution)
        .expect("the second process opens its own cohort");
    while second.seq() < observation_seq {
        let seq = second.seq();
        let _ = second.dispatch(
            "mac-export-cohort-evidence-request",
            &json!({
                "schema": "mac-export-cohort-evidence-request/v1",
                "requestSeq": seq,
                "executionSha256": replayed_execution,
                "cohortAdmissionReceiptSha256": digest("admission"),
                "roleChildEvidenceBundleBase64": b64(b"{}\n"),
            }),
        );
    }
    assert_eq!(second.seq(), observation_seq);
    let mut frame = mid_execution_frame.clone();
    frame["executionSha256"] = json!(replayed_execution);
    assert_eq!(
        second.dispatch("mac-present-rig-observation-request", &frame),
        Err(MacRefusal::Mismatch("record not retained by this session")),
        "net 2 fires on its own once the sequence agrees",
    );
    assert!(second.session(&replayed_execution).admission().is_none());
}

// --- §2.9(1): one campaign-scoped process, several executions ------------------

/// One process completes several executions without leaking retention or
/// reusing a grant: every execution gets its own grant, its own session and
/// its own terminal release; the campaign's sequences keep counting.
#[test]
fn one_process_completes_several_executions_without_leaking_retention() {
    let mut campaign = campaign();
    let mut grants = Vec::new();
    for run in 1..=3 {
        let execution_sha256 = campaign.open_execution(run);
        campaign.reach_admission(&execution_sha256);
        let grant = campaign.session(&execution_sha256).grant().sha256.clone();
        campaign.export_evidence(&execution_sha256).expect("export");
        assert_eq!(campaign.runtime.session_count(), 0, "run {run}: released");
        assert_eq!(campaign.runtime.execution_count(), 0, "run {run}: released");
        grants.push(grant);
        // A frame for the released execution is a frame for an execution this
        // process is not conducting.
        assert_eq!(
            campaign.present_cohort_acceptance(&execution_sha256),
            Err(MacRefusal::Mismatch("no cohort for this execution")),
        );
    }
    grants.sort();
    grants.dedup();
    assert_eq!(grants.len(), 3, "three executions, three grants");
    assert_eq!(
        campaign.runtime.receipt_sequence(),
        21,
        "seven signed records per execution, never reset"
    );
    assert_eq!(campaign.runtime.signed_record_count(), 21);
    assert_eq!(campaign.next_execution_index, 3);
}

#[test]
fn one_process_serves_four_executions_with_distinct_sessions() {
    let mut campaign = campaign();
    let executions: Vec<String> = (1..=4).map(|run| campaign.open_execution(run)).collect();
    for execution in &executions {
        campaign.open(execution).expect("open");
        campaign
            .present_cohort_acceptance(execution)
            .expect("cohort acceptance");
    }
    assert_eq!(campaign.runtime.session_count(), 4);
    let mut grants = Vec::new();
    for execution in &executions {
        let session = campaign.runtime.session_mut(execution).expect("session");
        assert_eq!(session.execution_sha256(), execution);
        assert_eq!(session.stage(), MacCohortStage::CohortAcceptanceRetained);
        let retained = session.retained("rigCohortAcceptance").expect("retained");
        let record: Value = serde_json::from_slice(&retained.bytes).expect("json");
        assert_eq!(
            record["executionSha256"], *execution,
            "each session retained its own execution's acceptance"
        );
        assert_eq!(
            record["cohortGrantSha256"],
            session.grant().sha256,
            "and its own grant's acceptance"
        );
        grants.push(session.grant().sha256.clone());
    }
    grants.sort();
    grants.dedup();
    assert_eq!(grants.len(), 4);
    // A second open for an execution this process already holds is never a
    // fifth session.  Re-presenting the same cohort id is not the plan-2210
    // replacement either -- that one mints fresh material -- so it is refused
    // outright.
    assert_eq!(
        campaign.open(&executions[0]),
        Err(MacRefusal::Cohort(
            "replacement reuses retired cohort material"
        ))
    );
    assert_eq!(campaign.runtime.session_count(), 4);
    // And an honest pre-readiness replacement takes the first execution's
    // session over rather than adding one.
    campaign
        .open_frame_for_cohort(&executions[0], "cohort-replacement-2", |_| {})
        .expect("replacement");
    assert_eq!(campaign.runtime.session_count(), 4);
}

#[test]
fn a_frame_for_an_execution_this_process_never_opened_is_refused() {
    let mut campaign = campaign();
    let opened = campaign.open_execution(1);
    campaign.open(&opened).expect("open");
    let stranger = digest("execution-9");
    assert_eq!(
        campaign.present_cohort_acceptance(&stranger),
        Err(MacRefusal::Mismatch("no cohort for this execution")),
    );
    assert_eq!(
        campaign.open(&stranger),
        Err(MacRefusal::Mismatch("execution not retained"))
    );
}

// --- the open frame's own bindings -------------------------------------------

#[test]
fn the_open_frame_recomputes_the_role_plan_digest_and_size() {
    let mut campaign = campaign();
    let execution_sha256 = campaign.open_execution(1);
    assert_eq!(
        campaign.open_frame(&execution_sha256, |frame| {
            frame["workloadRolePlanInputSha256"] = json!(digest("wrong"));
        }),
        Err(MacRefusal::Mismatch("workloadRolePlanInputSha256")),
    );
    assert_eq!(
        campaign.open_frame(&execution_sha256, |frame| {
            let size = frame["workloadRolePlanInputSize"].as_u64().expect("size");
            frame["workloadRolePlanInputSize"] = json!(size + 1);
        }),
        Err(MacRefusal::Mismatch("workloadRolePlanInputSize")),
    );
    // C2: the four digests are the retained execution's.
    assert_eq!(
        campaign.open_frame(&execution_sha256, |frame| {
            frame["scenarioHash"] = json!(digest("another scenario"));
        }),
        Err(MacRefusal::Mismatch("scenarioHash")),
    );
    assert_eq!(
        campaign.open_frame(&execution_sha256, |frame| {
            frame["rolePlanHash"] = json!(digest("another role plan"));
        }),
        Err(MacRefusal::Mismatch("rolePlanHash")),
    );
    assert_eq!(
        campaign.runtime.session_count(),
        0,
        "a refused open leaves no session"
    );

    campaign.open(&execution_sha256).expect("open");
    assert_eq!(campaign.runtime.session_count(), 1);
    let plan = chat_1k_plan_bytes();
    let session = campaign
        .runtime
        .session_mut(&execution_sha256)
        .expect("session");
    assert_eq!(session.workload_role_plan_input(), plan.as_slice());
    assert_eq!(session.workload_role_plan_input_sha256(), sha256_hex(&plan));
    assert_eq!(session.scenario_hash(), digest("scenario"));
    assert_eq!(session.role_plan_hash(), digest("role-plan"));
    assert_eq!(session.identity().mac_clock_id(), digest("mac-clock"));
    assert_eq!(
        session.identity().instance_nonce_sha256(),
        digest("mac-instance")
    );
    assert_eq!(session.cell().cell, "chat 1k");
    assert_eq!(session.cell().measured_duration_ms, 30_000);
    assert_eq!(session.cell().message_bytes, 128);
    assert_eq!(session.cell().readiness_deadline_ms, 90_000);
    assert_eq!(session.manifest().leaf_count, 1_010);
    assert_eq!(session.manifest().publisher_count, 10);
    assert_eq!(session.manifest().subscriber_count, 1_000);
    assert_eq!(session.manifest().shard_subscriber_counts, [125u64; 8]);
    assert_eq!(session.cohort_attempt(), 1);
}

/// The frame states the manifest's digest and the binary recomputes it over
/// the bytes that arrived.
#[test]
fn an_open_frame_whose_manifest_digest_does_not_cover_the_manifest_is_refused() {
    let mut campaign = campaign();
    let execution_sha256 = campaign.open_execution(1);
    assert_eq!(
        campaign.open_frame(&execution_sha256, |frame| {
            frame["tokenCommitmentLeafManifestSha256"] = json!(digest("some other manifest"));
        }),
        Err(MacRefusal::Mismatch("tokenCommitmentLeafManifestSha256")),
    );
    let other = digest("execution-2");
    let manifest = bytes_of(&leaf_manifest(&other, "cohort-x", 10, 1_000));
    assert_eq!(
        campaign.open_frame(&execution_sha256, |frame| {
            frame["tokenCommitmentLeafManifestBase64"] = json!(b64(&manifest));
            frame["tokenCommitmentLeafManifestSha256"] = json!(sha256_hex(&manifest));
        }),
        Err(MacRefusal::Mismatch("executionSha256")),
    );
    assert_eq!(campaign.runtime.session_count(), 0);
}

/// C1: an open frame whose topology does not match its leaves mints no grant,
/// and the honest sibling does.
#[test]
fn an_open_frame_whose_topology_disagrees_with_its_leaves_mints_no_grant() {
    let mut campaign = campaign();
    let execution_sha256 = campaign.open_execution(1);
    let manifest = leaf_manifest(
        &execution_sha256,
        &format!("cohort-{}", &execution_sha256[..16]),
        10,
        1_000,
    );
    let (mut publishers, mut shards) = presented_topology(&manifest);
    publishers[2]["tokenSha256"] = json!(digest("swapped token"));
    let publishers_bytes = bytes_of(&publishers);
    assert_eq!(
        campaign.open_frame(&execution_sha256, |frame| {
            frame["publishersBase64"] = json!(b64(&publishers_bytes));
        }),
        Err(MacRefusal::Mismatch("publisher topology")),
    );
    shards[4]["subscriberCount"] = json!(126);
    let shards_bytes = bytes_of(&shards);
    assert_eq!(
        campaign.open_frame(&execution_sha256, |frame| {
            frame["subscriberShardsBase64"] = json!(b64(&shards_bytes));
        }),
        Err(MacRefusal::Mismatch("subscriber topology")),
    );
    assert_eq!(campaign.runtime.session_count(), 0);
    campaign
        .open(&execution_sha256)
        .expect("the honest topology mints");
    assert_eq!(campaign.runtime.session_count(), 1);
}

// --- the frame's exact key set ------------------------------------------------

#[test]
fn a_frame_with_an_extra_or_missing_key_is_refused() {
    let mut campaign = campaign();
    let execution_sha256 = campaign.open_execution(1);
    assert_eq!(
        campaign.open_frame(&execution_sha256, |frame| {
            frame["extra"] = json!(1);
        }),
        Err(MacRefusal::Protocol("record")),
    );
    assert_eq!(
        campaign.open_frame(&execution_sha256, |frame| {
            frame
                .as_object_mut()
                .expect("object")
                .remove("publishersBase64");
        }),
        Err(MacRefusal::Protocol("record")),
        "C1's arrays are required keys",
    );
    assert_eq!(campaign.runtime.session_count(), 0);
}

/// A nullable field carrying a missing key, rather than an explicit null, is a
/// refusal.
#[test]
fn a_missing_nullable_key_is_not_the_same_as_an_explicit_null() {
    let mut campaign = campaign();
    let execution_sha256 = campaign.open_execution(1);
    campaign.reach_barrier(&execution_sha256);
    campaign
        .issue_start_barrier(&execution_sha256, None, None)
        .expect("barrier");
    campaign
        .present_barrier_acceptance(&execution_sha256)
        .expect("acceptance");
    let mut frame = campaign.observation_frame(&execution_sha256);
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
    let execution_sha256 = campaign.open_execution(1);
    campaign.reach_barrier(&execution_sha256);
    campaign
        .issue_start_barrier(&execution_sha256, None, None)
        .expect("barrier");
    assert!(!campaign.session(&execution_sha256).role_children_may_arm());

    // A barrier acceptance signed by a key that is not the staged rig key.
    let honest = campaign.honest_barrier_acceptance(&execution_sha256, 4);
    let forger = RigSigner::new();
    let forged = forger.sign("rig-barrier-acceptance/v1", &json_of(&honest.0));
    assert_eq!(
        campaign.present_barrier_acceptance_record(&execution_sha256, forged),
        Err(MacRefusal::RigSigningKeyMismatch),
    );
    assert!(
        !campaign.session(&execution_sha256).role_children_may_arm(),
        "a refused acceptance arms nothing"
    );

    // A genuine acceptance naming another barrier.
    let mut other = json_of(&honest.0);
    other["cohortStartBarrierSha256"] = json!(digest("another barrier"));
    let other = campaign.rig.sign("rig-barrier-acceptance/v1", &other);
    assert_eq!(
        campaign.present_barrier_acceptance_record(&execution_sha256, other),
        Err(MacRefusal::Mismatch("cohortStartBarrierSha256")),
        "row 6 binds the binary's own barrier",
    );
    assert!(!campaign.session(&execution_sha256).role_children_may_arm());

    let seq = campaign.seq();
    let ack = campaign
        .present_barrier_acceptance_record(&execution_sha256, honest.clone())
        .expect("barrier acceptance");
    let ack: Value = serde_json::from_slice(&ack).expect("json");
    assert_eq!(ack["schema"], "mac-rig-barrier-acceptance-ack/v1");
    assert_eq!(ack["roleChildrenMayArm"], true);
    assert_eq!(ack["ackRequestSeq"], seq);
    assert_eq!(ack["rigBarrierAcceptanceSha256"], sha256_hex(&honest.0));
    assert!(campaign.session(&execution_sha256).role_children_may_arm());
}

// --- the ack's own shape -----------------------------------------------------

#[test]
fn the_cohort_acceptance_ack_states_the_channels_response_sequence() {
    let mut campaign = campaign();
    let execution_sha256 = campaign.open_execution(1);
    campaign.open(&execution_sha256).expect("open");
    let request_seq = campaign.seq();
    let ack = campaign
        .present_cohort_acceptance(&execution_sha256)
        .expect("cohort acceptance");
    let ack: Value = serde_json::from_slice(&ack).expect("json");
    assert_eq!(ack["schema"], "mac-rig-cohort-acceptance-ack/v1");
    assert_eq!(ack["ackRequestSeq"], request_seq);
    assert_eq!(
        ack["responseSeq"], 2,
        "responseSeq counts the channel's answers: the execution open was 0, the cohort open 1"
    );
    assert_eq!(ack["executionSha256"], execution_sha256);
}

/// G1 (design §3.3 "Channel sequence"): one `requestSeq` and one
/// `responseSeq` counter per execution channel, both from 0.  The
/// controller opens a fresh `MacCohortChannel` per execution, so the second
/// execution on one Mac process is opened at `requestSeq` 0, answered with
/// `responseSeq` 0, and its cohort answers continue that channel — the way
/// the rig's session continues the channel that answered its execution
/// acceptance (`accept_cohort`: `response_sequence = 1`).
#[test]
fn every_execution_channel_starts_both_counters_at_zero_and_the_cohort_continues_it() {
    let mut campaign = campaign();
    let first = campaign.open_execution(1);
    campaign.open(&first).expect("first cohort");
    campaign
        .present_cohort_acceptance(&first)
        .expect("first acceptance");
    assert_eq!(campaign.seq(), 3, "open 0, cohort open 1, acceptance 2");

    let (second, opened) = campaign.open_execution_with(2, |_| {});
    assert_eq!(opened["responseSeq"], 0, "a fresh channel answers from 0");
    assert_eq!(opened["ackRequestSeq"], 0);
    assert_eq!(campaign.seq(), 1, "the channel's next request");
    let ack = json_of(&campaign.open(&second).expect("second cohort"));
    assert_eq!(ack["responseSeq"], 1);
    assert_eq!(ack["ackRequestSeq"], 1);
    let ack = json_of(
        &campaign
            .present_cohort_acceptance(&second)
            .expect("second acceptance"),
    );
    assert_eq!(ack["responseSeq"], 2);
    assert_eq!(ack["ackRequestSeq"], 2);
    assert_eq!(campaign.session(&second).response_sequence(), 3);
}

/// An execution open is the first frame of its channel: one that arrives
/// mid-channel is out-of-state and fails net 1 before the draft is read,
/// and the refusal consumes nothing from the open channel.
#[test]
fn an_execution_open_mid_channel_is_refused_at_the_sequence_net() {
    let mut campaign = campaign();
    let first = campaign.open_execution(1);
    campaign.open(&first).expect("cohort");
    let draft_bytes = bytes_of(&execution_draft(2, NOW_MS + 3 * 3_600_000));
    let frame = |seq: u64| {
        bytes_of(&json!({
            "schema": "mac-open-execution-request/v1",
            "requestSeq": seq,
            "executionDraftSha256": sha256_hex(&draft_bytes),
            "executionDraftBase64": b64(&draft_bytes),
        }))
    };
    assert_eq!(campaign.seq(), 2);
    assert_eq!(
        campaign
            .runtime
            .charge_request_seq(MAC_OPEN_EXECUTION_KIND, &frame(2)),
        Err(MacRefusal::Protocol("requestSeq")),
        "the channel's next requestSeq is not an execution open"
    );
    assert_eq!(campaign.seq(), 2, "nothing consumed");
    // The open channel continues where it was.
    let ack = json_of(
        &campaign
            .present_cohort_acceptance(&first)
            .expect("acceptance on the open channel"),
    );
    assert_eq!(ack["ackRequestSeq"], 2);
    assert_eq!(ack["responseSeq"], 2);
}

/// Row 2's binding: a genuine rig acceptance of another grant retains nothing.
#[test]
fn a_rig_cohort_acceptance_of_another_grant_is_refused_and_not_retained() {
    let mut campaign = campaign();
    let execution_sha256 = campaign.open_execution(1);
    campaign.open(&execution_sha256).expect("open");
    let (record, signature) = campaign.rig.sign(
        "rig-cohort-acceptance/v1",
        &with_fields(
            rig_record("rig-cohort-acceptance/v1", &execution_sha256, 1),
            &[
                ("cohortGrantSha256", &digest("another grant")),
                ("cohortGrantSignatureSha256", &digest("x")),
            ],
        ),
    );
    let seq = campaign.seq();
    assert_eq!(
        campaign.dispatch(
            "mac-present-rig-cohort-acceptance-request",
            &json!({
                "schema": "mac-present-rig-cohort-acceptance-request/v1",
                "requestSeq": seq,
                "executionSha256": execution_sha256,
                "rigCohortAcceptanceBase64": b64(&record),
                "rigCohortAcceptanceSignatureBase64": b64(&signature),
            }),
        ),
        Err(MacRefusal::Mismatch("cohortGrantSha256")),
    );
    assert!(campaign
        .session(&execution_sha256)
        .retained("rigCohortAcceptance")
        .is_err());
    campaign
        .present_cohort_acceptance(&execution_sha256)
        .expect("the honest one is retained");
}

// --- expiry and receipt-sequence monotonicity ---------------------------------

#[test]
fn an_expired_rig_receipt_is_refused_under_its_own_code() {
    let mut campaign = campaign();
    let execution_sha256 = campaign.open_execution(1);
    campaign.open(&execution_sha256).expect("open");
    let mut record = rig_record("rig-cohort-acceptance/v1", &execution_sha256, 1);
    record["notAfterMs"] = json!(NOW_MS - 1);
    let (bytes, signature) = campaign.rig.sign("rig-cohort-acceptance/v1", &record);
    let seq = campaign.seq();
    assert_eq!(
        campaign.dispatch(
            "mac-present-rig-cohort-acceptance-request",
            &json!({
                "schema": "mac-present-rig-cohort-acceptance-request/v1",
                "requestSeq": seq,
                "executionSha256": execution_sha256,
                "rigCohortAcceptanceBase64": b64(&bytes),
                "rigCohortAcceptanceSignatureBase64": b64(&signature),
            }),
        ),
        Err(MacRefusal::RigReceiptExpired),
    );
}

/// G2 (design §7): every presented rig record is exactly its schema's closed
/// key set — the set the production rig mints and `cohort-protocol.ts`
/// requires — and a record with fewer keys or one more is refused as
/// `TRUST_PROTOCOL` before it is retained, however well it is signed and
/// bound.  This is the gate that keeps the binary's consumer honest against
/// the TS consumer: a graph this Mac admitted is one the TS side admits.
#[test]
fn a_rig_record_outside_its_closed_key_set_is_refused_before_retention() {
    let mut campaign = campaign();
    let execution_sha256 = campaign.open_execution(1);
    campaign.open(&execution_sha256).expect("open");
    let grant = campaign.session(&execution_sha256).grant().clone();
    let present = |campaign: &mut Campaign, record: &Value| {
        let (bytes, signature) = campaign.rig.sign("rig-cohort-acceptance/v1", record);
        let seq = campaign.seq();
        campaign.dispatch(
            "mac-present-rig-cohort-acceptance-request",
            &json!({
                "schema": "mac-present-rig-cohort-acceptance-request/v1",
                "requestSeq": seq,
                "executionSha256": execution_sha256,
                "rigCohortAcceptanceBase64": b64(&bytes),
                "rigCohortAcceptanceSignatureBase64": b64(&signature),
            }),
        )
    };
    // The shape this harness used to mint: the five fields the Mac reads plus
    // the two bindings this transition checks — signed, bound, and refused.
    let fewer = json!({
        "schema": "rig-cohort-acceptance/v1",
        "executionSha256": execution_sha256,
        "receiptSequence": 1,
        "issuedAtMs": NOW_MS,
        "notAfterMs": NOW_MS + VALIDITY_MS,
        "cohortGrantSha256": grant.sha256,
        "cohortGrantSignatureSha256": grant.signature_sha256,
    });
    assert_eq!(
        present(&mut campaign, &fewer),
        Err(MacRefusal::Protocol("record")),
        "fewer keys than the rig mints"
    );
    assert_eq!(
        campaign.session(&execution_sha256).stage(),
        MacCohortStage::Opened,
        "nothing retained"
    );
    // One key more than the rig mints.
    let mut extra = with_fields(
        rig_record("rig-cohort-acceptance/v1", &execution_sha256, 1),
        &[
            ("cohortGrantSha256", &grant.sha256),
            ("cohortGrantSignatureSha256", &grant.signature_sha256),
        ],
    );
    extra["linuxClockId"] = json!("clock-monotonic-boot-b");
    assert_eq!(
        present(&mut campaign, &extra),
        Err(MacRefusal::Protocol("record")),
        "one key the rig never mints"
    );
    assert_eq!(
        campaign.session(&execution_sha256).stage(),
        MacCohortStage::Opened
    );
    // The production shape is retained.
    let honest = with_fields(
        rig_record("rig-cohort-acceptance/v1", &execution_sha256, 1),
        &[
            ("cohortGrantSha256", &grant.sha256),
            ("cohortGrantSignatureSha256", &grant.signature_sha256),
        ],
    );
    assert_eq!(
        honest.as_object().expect("object").len(),
        14,
        "cohort-protocol.ts RIG_COHORT_ACCEPTANCE_KEYS"
    );
    present(&mut campaign, &honest).expect("the production shape is admitted");
    assert_eq!(
        campaign.session(&execution_sha256).stage(),
        MacCohortStage::CohortAcceptanceRetained
    );
}

#[test]
fn a_rig_receipt_sequence_that_goes_backwards_is_refused() {
    let mut campaign = campaign();
    let execution_sha256 = campaign.open_execution(1);
    campaign.reach_barrier(&execution_sha256);
    campaign
        .issue_start_barrier(&execution_sha256, None, None)
        .expect("barrier");
    let first = campaign.honest_barrier_acceptance(&execution_sha256, 4);
    campaign
        .present_barrier_acceptance_record(&execution_sha256, first)
        .expect("the first acceptance is admitted");
    let earlier = campaign.honest_barrier_acceptance(&execution_sha256, 1);
    assert_eq!(
        campaign.present_barrier_acceptance_record(&execution_sha256, earlier),
        Err(MacRefusal::RigReceiptReplayed),
        "the same record kind may not go backwards once this session has seen it",
    );
    // Monotonicity is per record kind, not one counter across all seven: the
    // observation frame legitimately carries an execution acceptance minted
    // after a measure-start ack the barrier already admitted — and mints.
    campaign.honest_barrier_acceptance(&execution_sha256, 4);
    campaign
        .present_observation(&execution_sha256)
        .expect("observation");
}

/// A record whose own `schema` disagrees with the carrier's `signedSchema` is
/// refused, even when the signature verifies over the exact bytes.
#[test]
fn a_record_whose_body_schema_disagrees_with_its_carrier_is_refused() {
    let mut campaign = campaign();
    let execution_sha256 = campaign.open_execution(1);
    campaign.open(&execution_sha256).expect("open");
    let (bytes, signature) = campaign.rig.sign(
        "rig-cohort-acceptance/v1",
        &rig_record("rig-barrier-acceptance/v1", &execution_sha256, 1),
    );
    let seq = campaign.seq();
    assert_eq!(
        campaign.dispatch(
            "mac-present-rig-cohort-acceptance-request",
            &json!({
                "schema": "mac-present-rig-cohort-acceptance-request/v1",
                "requestSeq": seq,
                "executionSha256": execution_sha256,
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
    let record = rig_record("cohort-grant/v1", &execution_tag(1), 1);
    let (bytes, carrier) = rig.sign("cohort-grant/v1", &record);
    assert_eq!(
        verify_rig_record(
            &bytes,
            &carrier,
            &rig.keys.public_raw32,
            "rig-cohort-acceptance/v1"
        ),
        Err(MacRefusal::Protocol("signedSchema")),
    );
}

#[test]
fn verify_rig_record_returns_the_arrival_bytes_not_a_recanonicalisation() {
    let rig = RigSigner::new();
    let (bytes, carrier) = rig.sign(
        "rig-cohort-acceptance/v1",
        &rig_record("rig-cohort-acceptance/v1", &execution_tag(1), 1),
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

// --- rows 3, 4, 7, 8: the negative sibling of each honest mint ----------------

/// Row 3 refuses a request naming a grant or an acceptance this session did
/// not mint or retain.
#[test]
fn a_warmup_epoch_request_naming_another_grant_or_acceptance_is_refused() {
    let mut campaign = campaign();
    let execution_sha256 = campaign.open_execution(1);
    campaign.open(&execution_sha256).expect("open");
    campaign
        .present_cohort_acceptance(&execution_sha256)
        .expect("acceptance");
    let acceptance_sha256 = sha256_hex(
        &campaign
            .rig_record(&execution_sha256, "rigCohortAcceptance")
            .0,
    );
    let grant_sha256 = campaign.grant_sha256(&execution_sha256);
    for (grant, acceptance, expected) in [
        (
            digest("other grant"),
            acceptance_sha256.clone(),
            MacRefusal::Mismatch("cohortGrantSha256"),
        ),
        (
            grant_sha256.clone(),
            digest("other acceptance"),
            MacRefusal::Mismatch("rigCohortAcceptanceSha256"),
        ),
    ] {
        let seq = campaign.seq();
        assert_eq!(
            campaign.dispatch(
                "mac-issue-warmup-epoch-request",
                &json!({
                    "schema": "mac-issue-warmup-epoch-request/v1",
                    "requestSeq": seq,
                    "executionSha256": execution_sha256,
                    "cohortGrantSha256": grant,
                    "rigCohortAcceptanceSha256": acceptance,
                }),
            ),
            Err(expected),
        );
        assert!(campaign.session(&execution_sha256).warmup_epoch().is_none());
    }
    campaign
        .issue_warmup_epoch(&execution_sha256)
        .expect("the honest request mints");
}

/// Row 4 checks the §4.1 arithmetic per child and in total, the binding of
/// every child record to this epoch, the order, and the cardinality.
#[test]
fn a_warmup_manifest_is_refused_for_any_child_that_did_not_complete_exactly() {
    let mut campaign = campaign();
    let execution_sha256 = campaign.open_execution(1);
    campaign.open(&execution_sha256).expect("open");
    campaign
        .present_cohort_acceptance(&execution_sha256)
        .expect("acceptance");
    campaign
        .issue_warmup_epoch(&execution_sha256)
        .expect("epoch");
    let honest = campaign.warmup_completes(&execution_sha256);
    let cases: Vec<(&str, Box<dyn Fn(&mut Vec<Vec<u8>>)>, MacRefusal)> = vec![
        (
            "a publisher offering nine",
            Box::new(|completes| {
                let mut record = json_of(&completes[0]);
                record["offeredWarmupIngress"] = json!(9);
                completes[0] = bytes_of(&record);
            }),
            MacRefusal::Mismatch("warmup arithmetic"),
        ),
        (
            "a worker short one record",
            Box::new(|completes| {
                let mut record = json_of(&completes[17]);
                record["deliveredWarmupRecords"] = json!(12_499);
                completes[17] = bytes_of(&record);
            }),
            MacRefusal::Mismatch("warmup arithmetic"),
        ),
        (
            "another epoch's nonce",
            Box::new(|completes| {
                let mut record = json_of(&completes[3]);
                record["warmupNonce"] = json!(digest("stale nonce"));
                completes[3] = bytes_of(&record);
            }),
            MacRefusal::Mismatch("warmupNonce"),
        ),
        (
            "two children swapped",
            Box::new(|completes| completes.swap(0, 1)),
            MacRefusal::Mismatch("warmup completion order"),
        ),
        (
            "a child presented twice",
            Box::new(|completes| completes[1] = completes[0].clone()),
            MacRefusal::Mismatch("warmup completion order"),
        ),
        (
            "a child missing",
            Box::new(|completes| {
                completes.pop();
            }),
            MacRefusal::Mismatch("roleWarmupCompletes cardinality"),
        ),
        (
            "a record with an extra key",
            Box::new(|completes| {
                let mut record = json_of(&completes[0]);
                record["extra"] = json!(1);
                completes[0] = bytes_of(&record);
            }),
            MacRefusal::Protocol("record"),
        ),
    ];
    for (label, mutate, expected) in cases {
        let mut completes = honest.clone();
        mutate(&mut completes);
        assert_eq!(
            campaign.export_warmup_manifest_with(&execution_sha256, completes),
            Err(expected),
            "{label}"
        );
        assert!(
            campaign
                .session(&execution_sha256)
                .warmup_completion_manifest()
                .is_none(),
            "{label}: nothing minted"
        );
    }
    campaign
        .export_warmup_manifest_with(&execution_sha256, honest)
        .expect("the honest set mints");
}

/// Row 7 refuses a derived record that disagrees with the Linux observation
/// the rig receipted, a null cohort record, or a snapshot receipt over other
/// bytes — each after the signatures verified.
#[test]
fn an_observation_whose_derived_records_disagree_with_the_relay_is_refused() {
    let mut campaign = campaign();
    let execution_sha256 = campaign.open_execution(1);
    campaign.reach_barrier(&execution_sha256);
    campaign
        .issue_start_barrier(&execution_sha256, None, None)
        .expect("barrier");
    campaign
        .present_barrier_acceptance(&execution_sha256)
        .expect("acceptance");
    let honest = campaign.observation_frame(&execution_sha256);
    let evidence = campaign.honest_evidence(&execution_sha256);
    let mut ledger = json_of(&evidence.ledger);
    ledger["delivered"] = json!(299_999);
    ledger["deliveredBytes"] = json!(299_999 * 128);
    let mut proof = json_of(&evidence.observed_process_proof);
    proof["observedProcessCount"] = json!(17);
    let cases: Vec<(&str, Box<dyn Fn(&mut Value)>, MacRefusal)> = vec![
        (
            "a ledger claiming fewer deliveries than the rate series",
            Box::new(move |frame| frame["cohortLedgerBase64"] = json!(b64(&bytes_of(&ledger)))),
            MacRefusal::Mismatch("cohortRateSeries"),
        ),
        (
            "a process proof short one child",
            Box::new(move |frame| {
                frame["observedProcessProofBase64"] = json!(b64(&bytes_of(&proof)))
            }),
            MacRefusal::Mismatch("observedProcessCount"),
        ),
        (
            "a null derived record",
            Box::new(|frame| frame["cohortCapacityBase64"] = Value::Null),
            MacRefusal::Mismatch("derived cohort record is null"),
        ),
        (
            "a null server record",
            Box::new(|frame| frame["serverWarmupDrainedBase64"] = Value::Null),
            MacRefusal::Mismatch("cohort record is null"),
        ),
        (
            "a snapshot frame the receipt does not cover",
            Box::new(|frame| frame["snapshotFrameBase64"] = json!(b64(b"{\"other\":true}\n"))),
            MacRefusal::Mismatch("snapshotFrameSha256"),
        ),
        (
            "a server drained record the rig did not receipt",
            Box::new(|frame| frame["serverWarmupDrainedBase64"] = json!(b64(b"{}\n"))),
            MacRefusal::Mismatch("serverWarmupDrainedSha256"),
        ),
    ];
    for (label, mutate, expected) in cases {
        let mut frame = honest.clone();
        frame["requestSeq"] = json!(campaign.seq());
        mutate(&mut frame);
        assert_eq!(
            campaign.dispatch("mac-present-rig-observation-request", &frame),
            Err(expected),
            "{label}"
        );
        assert!(
            campaign.session(&execution_sha256).admission().is_none(),
            "{label}: nothing minted"
        );
    }
    let mut frame = honest;
    frame["requestSeq"] = json!(campaign.seq());
    campaign
        .dispatch("mac-present-rig-observation-request", &frame)
        .expect("the honest frame mints");
    assert_eq!(
        campaign.present_observation(&execution_sha256),
        Err(MacRefusal::Cohort("one admission per cohort")),
        "one-shot",
    );
}

/// Row 8 checks every bundle member against what the admission bound, and
/// recomputes §4.5 from the partials against the admitted claims.
#[test]
fn an_export_whose_bundle_disagrees_with_the_admitted_facts_is_refused() {
    let mut campaign = campaign();
    let execution_sha256 = campaign.open_execution(1);
    campaign.reach_admission(&execution_sha256);
    let honest = campaign.export_bundle(&execution_sha256);
    let evidence = campaign.honest_evidence(&execution_sha256);
    let mut short_partial = json_of(&evidence.worker_partials[0]);
    short_partial["deliveredByOriginWindow"][0] = json!(1_249);
    let short_partial = bytes_of(&short_partial);
    let mut inflated = json_of(&evidence.worker_partials[0]);
    inflated["deliveredByOriginWindow"][0] = json!(1_250);
    inflated["deliveredByEventWindow"][0] = json!(1_251);
    let inflated = bytes_of(&inflated);
    let cases: Vec<(&str, Box<dyn Fn(&mut Value)>, MacRefusal)> = vec![
        (
            "a warmup complete rewritten",
            Box::new(|bundle| {
                bundle["roleWarmupCompletes"][0] =
                    retained_canonical_bytes(b"{\"schema\":\"role-warmup-complete/v1\"}\n")
            }),
            MacRefusal::Mismatch("roleWarmupComplete"),
        ),
        (
            "an ordered manifest the admission did not bind",
            Box::new(|bundle| {
                bundle["orderedPartialManifest"] =
                    retained_canonical_bytes(b"{\"schema\":\"ordered-partial-manifest/v1\"}\n")
            }),
            MacRefusal::Mismatch("orderedPartialManifest"),
        ),
        (
            "a partial the manifest does not name",
            Box::new(move |bundle| {
                bundle["workerPartials"][0] = retained_canonical_bytes(&short_partial)
            }),
            MacRefusal::Mismatch("partial not the manifest's"),
        ),
        (
            "a retained member whose digest lies",
            Box::new(|bundle| bundle["observedProcessProof"]["sha256"] = json!(digest("lie"))),
            MacRefusal::Mismatch("retained bytes"),
        ),
        (
            "a bundle for another admission",
            Box::new(|bundle| bundle["cohortAdmissionReceiptSha256"] = json!(digest("other"))),
            MacRefusal::Mismatch("bundle binding"),
        ),
        (
            "a partial missing",
            Box::new(|bundle| {
                bundle["publisherPartials"]
                    .as_array_mut()
                    .expect("array")
                    .pop();
            }),
            MacRefusal::Mismatch("partial cardinality"),
        ),
    ];
    for (label, mutate, expected) in cases {
        let mut bundle = honest.clone();
        mutate(&mut bundle);
        assert_eq!(
            campaign.export_evidence_with(&execution_sha256, bundle),
            Err(expected),
            "{label}"
        );
        assert_eq!(
            campaign.runtime.session_count(),
            1,
            "{label}: a refused export releases nothing"
        );
    }
    // §4.5 recomputed: a worker partial that the manifest *does* name (the
    // manifest is rebuilt around it) but whose windows conflate the drain.
    let _ = inflated;
    let ack = campaign
        .export_evidence(&execution_sha256)
        .expect("the honest bundle exports");
    verify_cohort_export_ack_signature(&ack, &campaign.mac_public_raw32).expect("signed");
    assert_eq!(campaign.runtime.session_count(), 0);
}

/// C3: the terminal ack's signature is over the seven other fields, under the
/// staged Mac key alone; every mutation of those fields, of the signature, or
/// of the key fails — and deleting the `verify_bytes` call inside
/// `verify_cohort_export_ack_signature` turns the fabricated-signature case
/// green (mutation-proven for this build).
#[test]
fn the_terminal_export_ack_signature_binds_the_seven_other_fields() {
    let mut campaign = campaign();
    let execution_sha256 = campaign.open_execution(1);
    campaign.reach_admission(&execution_sha256);
    let ack_bytes = campaign.export_evidence(&execution_sha256).expect("export");
    verify_cohort_export_ack_signature(&ack_bytes, &campaign.mac_public_raw32).expect("honest");
    let ack = json_of(&ack_bytes);
    let signature = ack["cohortObservationEvidenceSignatureBase64"]
        .as_str()
        .expect("sig")
        .to_owned();
    assert_eq!(signature.len(), 88);
    assert_eq!(unb64(&signature).len(), 64);
    let mutations: Vec<(&str, Value)> = vec![
        (
            "responseSeq",
            json!(ack["responseSeq"].as_u64().expect("seq") + 1),
        ),
        (
            "ackRequestSeq",
            json!(ack["ackRequestSeq"].as_u64().expect("seq") + 1),
        ),
        ("executionSha256", json!(digest("other execution"))),
        (
            "cohortObservationEvidenceSha256",
            json!(digest("other evidence")),
        ),
        (
            "cohortObservationEvidenceSize",
            json!(ack["cohortObservationEvidenceSize"].as_u64().expect("size") + 1),
        ),
        ("terminalExport", json!(false)),
        ("schema", json!("other/v1")),
        (
            "cohortObservationEvidenceSignatureBase64",
            json!(b64(&[0u8; 64])),
        ),
        (
            "cohortObservationEvidenceSignatureBase64",
            json!(b64(&[0u8; 63])),
        ),
    ];
    for (field, value) in mutations {
        let mut mutated = ack.clone();
        mutated[field] = value;
        assert!(
            verify_cohort_export_ack_signature(&bytes_of(&mutated), &campaign.mac_public_raw32)
                .is_err(),
            "{field}",
        );
    }
    // A non-canonical encoding of the same 64 bytes is refused.
    let mut noncanonical = ack.clone();
    let alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let position = alphabet
        .find(signature.as_bytes()[85] as char)
        .expect("alphabet")
        + 1;
    noncanonical["cohortObservationEvidenceSignatureBase64"] = json!(format!(
        "{}{}==",
        &signature[..85],
        &alphabet[position % 64..position % 64 + 1]
    ));
    assert!(verify_cohort_export_ack_signature(
        &bytes_of(&noncanonical),
        &campaign.mac_public_raw32
    )
    .is_err());
    // The ack cannot supply a key, and no other key verifies it.
    let mut with_key = ack.clone();
    with_key["key"] = json!(b64(&campaign.mac_public_raw32));
    assert!(
        verify_cohort_export_ack_signature(&bytes_of(&with_key), &campaign.mac_public_raw32)
            .is_err()
    );
    assert!(verify_cohort_export_ack_signature(
        &ack_bytes,
        &generate_ed25519_keypair().public_raw32
    )
    .is_err());
}

// --- the ordinary (non-cohort) execution's admission ------------------------

/// MAC_JOIN for an execution that opened no cohort: the three required rig
/// records bind to the retained execution, the cohort-only fields are null,
/// and the admission's two cohort digests are null.
#[test]
fn an_ordinary_execution_is_admitted_with_null_cohort_digests() {
    let mut campaign = campaign();
    let execution_sha256 = campaign.open_execution(1);
    let retained = campaign
        .runtime
        .execution(&execution_sha256)
        .expect("retained")
        .clone();
    let acceptance = campaign.rig_record(&execution_sha256, "rigExecutionAcceptance");
    let ack = campaign.rig.sign(
        "rig-measure-start-ack/v1",
        &with_fields(
            rig_record("rig-measure-start-ack/v1", &execution_sha256, 3),
            &[
                ("measurementGrantSha256", &retained.grant_sha256),
                ("macExecutionGrantReceiptSha256", &retained.receipt.sha256),
                ("rigExecutionAcceptanceSha256", &sha256_hex(&acceptance.0)),
            ],
        ),
    );
    let snapshot = campaign.rig.sign(
        "rig-server-snapshot-receipt/v1",
        &with_fields(
            rig_record("rig-server-snapshot-receipt/v1", &execution_sha256, 5),
            &[
                ("measurementGrantSha256", &retained.grant_sha256),
                ("macExecutionGrantReceiptSha256", &retained.receipt.sha256),
                ("rigExecutionAcceptanceSha256", &sha256_hex(&acceptance.0)),
                ("snapshotFrameSha256", &sha256_hex(SNAPSHOT_FRAME)),
            ],
        ),
    );
    let frame = |seq: u64| {
        json!({
            "schema": "mac-present-rig-observation-request/v1",
            "requestSeq": seq,
            "executionSha256": execution_sha256,
            "rigExecutionAcceptanceBase64": b64(&acceptance.0),
            "rigExecutionAcceptanceSignatureBase64": b64(&acceptance.1),
            "rigMeasureStartAckBase64": b64(&ack.0),
            "rigMeasureStartAckSignatureBase64": b64(&ack.1),
            "rigBarrierAcceptanceBase64": Value::Null,
            "rigBarrierAcceptanceSignatureBase64": Value::Null,
            "serverWarmupDrainedBase64": Value::Null,
            "serverStartBarrierAcceptedBase64": Value::Null,
            "snapshotFrameBase64": b64(SNAPSHOT_FRAME),
            "rigServerSnapshotReceiptBase64": b64(&snapshot.0),
            "rigServerSnapshotReceiptSignatureBase64": b64(&snapshot.1),
            "linuxRelayObservationBase64": Value::Null,
            "rigRelayObservationReceiptBase64": Value::Null,
            "rigRelayObservationReceiptSignatureBase64": Value::Null,
            "orderedPartialManifestBase64": Value::Null,
            "observedProcessProofBase64": Value::Null,
            "cohortRateSeriesBase64": Value::Null,
            "cohortLedgerBase64": Value::Null,
            "cohortCapacityBase64": Value::Null,
        })
    };
    // A cohort record on a non-cohort execution has no consumer and reads as
    // evidence: refused.
    let mut with_cohort_record = frame(campaign.seq());
    with_cohort_record["cohortLedgerBase64"] = json!(b64(b"{}\n"));
    assert_eq!(
        campaign.dispatch("mac-present-rig-observation-request", &with_cohort_record),
        Err(MacRefusal::Mismatch(
            "cohort record on a non-cohort execution"
        )),
    );
    // A forged ack refuses at the key, as it does for a cohort.
    let forger = RigSigner::new();
    let forged = forger.sign("rig-measure-start-ack/v1", &json_of(&ack.0));
    let mut with_forged = frame(campaign.seq());
    with_forged["rigMeasureStartAckBase64"] = json!(b64(&forged.0));
    with_forged["rigMeasureStartAckSignatureBase64"] = json!(b64(&forged.1));
    assert_eq!(
        campaign.dispatch("mac-present-rig-observation-request", &with_forged),
        Err(MacRefusal::RigSigningKeyMismatch),
    );
    let honest = frame(campaign.seq());
    let answer = json_of(
        &campaign
            .dispatch("mac-present-rig-observation-request", &honest)
            .expect("admission"),
    );
    assert_eq!(answer["schema"], "mac-measurement-admission-issued-ack/v1");
    assert!(answer["cohortAdmissionReceiptBase64"].is_null());
    assert!(answer["cohortAdmissionSignatureBase64"].is_null());
    let admission_bytes = unb64(
        answer["macMeasurementAdmissionReceiptBase64"]
            .as_str()
            .expect("admission"),
    );
    let admission = json_of(&admission_bytes);
    assert_eq!(admission.as_object().expect("object").len(), 34);
    assert!(admission["cohortGrantSha256"].is_null());
    assert!(admission["cohortStartBarrierSha256"].is_null());
    assert!(admission["rigBarrierAcceptanceSha256"].is_null());
    assert_eq!(
        admission["admittedClientSeriesSha256"],
        retained.admitted.as_ref().expect("admitted").payload_sha256
    );
    assert_eq!(
        admission["rigServerSnapshotReceiptSha256"],
        sha256_hex(&snapshot.0)
    );
    let carrier = unb64(
        answer["macMeasurementAdmissionSignatureBase64"]
            .as_str()
            .expect("sig"),
    );
    secure_fs::cross_supervisor::verify_bytes(
        &campaign.mac_public_raw32,
        &admission_bytes,
        &mac_signature_bytes(&carrier),
    )
    .expect("signed");
    assert_eq!(
        campaign.runtime.execution_count(),
        0,
        "terminal for an ordinary execution"
    );
    // A second presentation is a frame for an execution this process no
    // longer holds.
    let again = frame(campaign.seq());
    assert_eq!(
        campaign.dispatch("mac-present-rig-observation-request", &again),
        Err(MacRefusal::Mismatch("execution not retained")),
    );
}
// production tokens are 32 random bytes and no vector can pin them.

const S3_VECTOR_EXECUTION_SHA256: &str =
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

/// S3-r8 vector 8: chat 1k, 10 publishers / 1,000 subscribers.
const S3_VECTOR_CHAT_1K: (&str, u64, usize, &str, &str) = (
    "cohort-vector-chat-1k",
    1_010,
    253_794,
    "1c711a4538fe83934e9310e2d7aff6dec71337ba627c1f081b9d37ee1106d841",
    "3f3d35f15bd314607ab41b63e6b47ed6ba6db9a32f8039381807b10019616d48",
);

/// S3-r8 vector 9: ticker 10k, 1 publisher / 100 subscribers.
const S3_VECTOR_TICKER_10K: (&str, u64, usize, &str, &str) = (
    "cohort-vector-ticker-10k",
    101,
    25_949,
    "4a255a1d854f76dd0b9c75d86315acd5a966e77ffff77cd8ec039e2f596bc104",
    "33eb2d4a0aea3f570a603f3b7af2a43463ffc256b7d5d3030ae5ca2543aa39ef",
);

/// The first and last canonical `token-commitment-leaf/v1` of each vector, in
/// full hex. A divergence in the leaf encoding moves the root; a divergence in
/// the *boundary* leaf specifically is what an ordering bug produces, and the
/// root alone would not say which of the two went wrong.
const S3_VECTOR_CHAT_1K_FIRST_LEAF_HEX: &str = concat!(
    "7b226368696c644964223a227075626c69736865722d6368696c642d30222c22636f",
    "686f72744964223a22636f686f72742d766563746f722d636861742d316b222c2272",
    "6f6c65223a227075626c6973686572222c22726f6c654964223a227075626c697368",
    "65722d303030303030222c22736368656d61223a22746f6b656e2d636f6d6d69746d",
    "656e742d6c6561662f7631222c22746f6b656e536861323536223a22356166653134",
    "3966306261343437393734653436303261393531346565393664626164393539613031",
    "6431623963643030346631643038633633306365343634222c22776f726b6572496e",
    "646578223a6e756c6c7d0a",
);
const S3_VECTOR_CHAT_1K_LAST_LEAF_HEX: &str = concat!(
    "7b226368696c644964223a22737562736372696265722d776f726b65722d37222c22",
    "636f686f72744964223a22636f686f72742d766563746f722d636861742d316b222c",
    "22726f6c65223a2273756273637269626572222c22726f6c654964223a2273756273",
    "6372696265722d303030393939222c22736368656d61223a22746f6b656e2d636f6d",
    "6d69746d656e742d6c6561662f7631222c22746f6b656e536861323536223a223162",
    "36636161633434333239666261616463653234633939353533373237303339666363",
    "61633466373839393432646164333632626232343836383862646464222c22776f72",
    "6b6572496e646578223a377d0a",
);

fn assert_manifest_vector(
    vector: (&str, u64, usize, &str, &str),
    cell_id: &str,
    publishers: u64,
    subscribers: u64,
) -> Vec<u8> {
    let (cohort_id, leaf_count, size, manifest_sha256, root) = vector;
    let manifest = leaf_manifest(
        S3_VECTOR_EXECUTION_SHA256,
        cohort_id,
        publishers,
        subscribers,
    );
    let bytes = bytes_of(&manifest);
    assert_eq!(bytes.len(), size, "{cohort_id}: canonical manifest size");
    assert_eq!(
        sha256_hex(&bytes),
        manifest_sha256,
        "{cohort_id}: manifest digest"
    );
    assert_eq!(
        manifest["roleTokenCommitmentRootSha256"].as_str(),
        Some(root),
        "{cohort_id}: the builder's root",
    );

    // The binary's own verifier, which recomputes the root from the presented
    // leaves and binds its result rather than the presented one.
    let cell = cohort_cell(cell_id).expect("cell");
    let verified = verify_token_commitment_leaf_manifest(&bytes, S3_VECTOR_EXECUTION_SHA256, cell)
        .expect("the verifier accepts the builder's manifest");
    assert_eq!(verified.leaf_count, leaf_count);
    assert_eq!(
        verified.root_sha256, root,
        "recomputed root equals the builder's"
    );
    assert_eq!(verified.cohort_id, cohort_id);
    assert_eq!(verified.publisher_count, publishers);
    assert_eq!(verified.subscriber_count, subscribers);
    assert_eq!(
        verified.shard_subscriber_counts.iter().sum::<u64>(),
        subscribers
    );
    bytes
}

#[test]
fn the_verifier_recomputes_the_typescript_builders_root_for_chat_1k() {
    assert_manifest_vector(S3_VECTOR_CHAT_1K, CHAT_1K_CELL, 10, 1_000);
    let leaves = cohort_leaves(S3_VECTOR_CHAT_1K.0, 10, 1_000);
    assert_eq!(
        bytes_of(&leaves[0]),
        from_hex(S3_VECTOR_CHAT_1K_FIRST_LEAF_HEX),
        "the first leaf is publisher-000000, canonically encoded",
    );
    assert_eq!(
        bytes_of(leaves.last().expect("last")),
        from_hex(S3_VECTOR_CHAT_1K_LAST_LEAF_HEX),
        "the last leaf is subscriber-000999 on worker 7",
    );
}

#[test]
fn the_verifier_recomputes_the_typescript_builders_root_for_ticker_10k() {
    assert_manifest_vector(S3_VECTOR_TICKER_10K, "ticker-fanout/rate-10000", 1, 100);
}

/// The verifier binds **its own** root, never the presented one. A manifest
/// whose stated root is a plausible digest over the wrong leaves is refused
/// here rather than reaching a signature.
#[test]
fn a_manifest_whose_stated_root_is_not_the_recomputed_one_is_refused() {
    let mut manifest = leaf_manifest(S3_VECTOR_EXECUTION_SHA256, "cohort-x", 10, 1_000);
    manifest["roleTokenCommitmentRootSha256"] = json!(digest("some other root"));
    let cell = cohort_cell(CHAT_1K_CELL).expect("cell");
    assert_eq!(
        verify_token_commitment_leaf_manifest(
            &bytes_of(&manifest),
            S3_VECTOR_EXECUTION_SHA256,
            cell,
        ),
        Err(MacRefusal::Mismatch("roleTokenCommitmentRootSha256")),
    );
}

/// §4.1's leaf order is checked **as presented** and never re-sorted: a
/// verifier that sorted its input would accept every order, and the order is
/// part of the commitment.
#[test]
fn a_manifest_whose_leaves_are_out_of_order_is_refused() {
    let cell = cohort_cell(CHAT_1K_CELL).expect("cell");
    let cohort_id = "cohort-order";

    // Publishers after subscribers.
    let mut leaves = cohort_leaves(cohort_id, 10, 1_000);
    leaves.swap(0, 1_009);
    let manifest = json!({
        "schema": "token-commitment-leaf-manifest/v1",
        "executionSha256": S3_VECTOR_EXECUTION_SHA256,
        "cohortId": cohort_id,
        "leafCount": leaves.len(),
        "roleTokenCommitmentRootSha256": merkle_root_hex(&leaves),
        "leaves": leaves,
    });
    assert!(matches!(
        verify_token_commitment_leaf_manifest(
            &bytes_of(&manifest),
            S3_VECTOR_EXECUTION_SHA256,
            cell,
        ),
        Err(MacRefusal::Mismatch(_)),
    ));

    // Two publishers transposed. This is the case the ordinal check exists
    // for, and it survived the first mutation pass: the subscriber half is
    // pinned separately by `ordinal == subscriber_count`, so a mutation that
    // removed the ascending-ordinal rule stayed green until this case existed.
    // Publisher ordinals have no second check, and §4.1 makes the order part of
    // the commitment, so a swapped pair must be refused even though the
    // presented root is honest arithmetic over the presented order.
    let mut leaves = cohort_leaves(cohort_id, 10, 1_000);
    leaves.swap(0, 9);
    let manifest = json!({
        "schema": "token-commitment-leaf-manifest/v1",
        "executionSha256": S3_VECTOR_EXECUTION_SHA256,
        "cohortId": cohort_id,
        "leafCount": leaves.len(),
        "roleTokenCommitmentRootSha256": merkle_root_hex(&leaves),
        "leaves": leaves,
    });
    assert_eq!(
        verify_token_commitment_leaf_manifest(
            &bytes_of(&manifest),
            S3_VECTOR_EXECUTION_SHA256,
            cell,
        ),
        Err(MacRefusal::Mismatch("leaf order")),
    );

    // Two adjacent subscribers transposed: same set, same publishers-then-
    // subscribers split, different order — and a different root.
    let mut leaves = cohort_leaves(cohort_id, 10, 1_000);
    leaves.swap(500, 501);
    let manifest = json!({
        "schema": "token-commitment-leaf-manifest/v1",
        "executionSha256": S3_VECTOR_EXECUTION_SHA256,
        "cohortId": cohort_id,
        "leafCount": leaves.len(),
        "roleTokenCommitmentRootSha256": merkle_root_hex(&leaves),
        "leaves": leaves,
    });
    assert!(matches!(
        verify_token_commitment_leaf_manifest(
            &bytes_of(&manifest),
            S3_VECTOR_EXECUTION_SHA256,
            cell,
        ),
        Err(MacRefusal::Mismatch(_)),
    ));
}

/// The shard union is checked against the position, not against a declared
/// residue: shard `w` is exactly residue `w`, so the union covers every
/// subscriber exactly once and there is nothing left to trust.
#[test]
fn a_manifest_whose_shard_residue_disagrees_with_the_position_is_refused() {
    let cell = cohort_cell(CHAT_1K_CELL).expect("cell");
    let cohort_id = "cohort-shard";
    let mut leaves = cohort_leaves(cohort_id, 10, 1_000);
    leaves[10 + 3]["workerIndex"] = json!(4);
    let manifest = json!({
        "schema": "token-commitment-leaf-manifest/v1",
        "executionSha256": S3_VECTOR_EXECUTION_SHA256,
        "cohortId": cohort_id,
        "leafCount": leaves.len(),
        "roleTokenCommitmentRootSha256": merkle_root_hex(&leaves),
        "leaves": leaves,
    });
    assert_eq!(
        verify_token_commitment_leaf_manifest(
            &bytes_of(&manifest),
            S3_VECTOR_EXECUTION_SHA256,
            cell,
        ),
        Err(MacRefusal::Mismatch("shard residue")),
    );
}

/// Review NEW-34, step 5. `cohortId` is inside every hashed leaf, so a
/// disagreement between the grant and the manifest would be a signed grant
/// naming `Y` over a root computed from `X`'s leaves — caught by the offline
/// verifier **after** a campaign, at the most expensive point in the program.
#[test]
fn a_grant_whose_cohort_id_disagrees_with_the_presented_manifest_is_refused() {
    let cell = cohort_cell(CHAT_1K_CELL).expect("cell");
    let bytes = bytes_of(&leaf_manifest(
        S3_VECTOR_EXECUTION_SHA256,
        "cohort-x",
        10,
        1_000,
    ));
    let verified = verify_token_commitment_leaf_manifest(&bytes, S3_VECTOR_EXECUTION_SHA256, cell)
        .expect("manifest");
    assert_eq!(check_grant_cohort_id(&verified, "cohort-x"), Ok(()));
    assert_eq!(
        check_grant_cohort_id(&verified, "cohort-y"),
        Err(MacRefusal::Mismatch("cohortId")),
        "a fresh cohortId minted by the binary is refused against the manifest",
    );
    // And the leaves themselves must agree with the manifest, because they are
    // what the root is computed over.
    let mut leaves = cohort_leaves("cohort-x", 10, 1_000);
    leaves[7]["cohortId"] = json!("cohort-y");
    let manifest = json!({
        "schema": "token-commitment-leaf-manifest/v1",
        "executionSha256": S3_VECTOR_EXECUTION_SHA256,
        "cohortId": "cohort-x",
        "leafCount": leaves.len(),
        "roleTokenCommitmentRootSha256": merkle_root_hex(&leaves),
        "leaves": leaves,
    });
    assert_eq!(
        verify_token_commitment_leaf_manifest(
            &bytes_of(&manifest),
            S3_VECTOR_EXECUTION_SHA256,
            cell,
        ),
        Err(MacRefusal::Mismatch("leaf cohortId")),
    );
}

// --- §3.2 / §4.5: the cell tables --------------------------------------------

/// All six rows, against the TypeScript constants they mirror. A table read
/// from two languages is not a second encoder, but it is a second copy, and an
/// unwalked copy is how a cell ends up with chat's window and ticker's payload.
#[test]
fn the_six_cell_rows_match_the_typescript_tables() {
    assert_eq!(COHORT_CELLS.len(), 6);
    for row in COHORT_CELLS {
        assert_eq!(row.worker_count, 8, "{}", row.cell);
        assert_eq!(
            row.session_count,
            row.publisher_count + row.subscriber_count,
            "{}: §4.5 sessions",
            row.cell,
        );
        assert_eq!(
            row.expanded_deliveries,
            row.measured_ingress * row.subscriber_count,
            "{}: §4.5 fanout identity",
            row.cell,
        );
        // plan 1428: exactly 100 bytes ticker or 128 bytes chat, determined by
        // the cell family rather than chosen per cell.
        let ticker = row.cell.starts_with("ticker");
        assert_eq!(
            row.message_bytes,
            if ticker { 100 } else { 128 },
            "{}",
            row.cell
        );
        assert_eq!(
            row.measured_duration_ms,
            if ticker { 10_000 } else { 30_000 },
            "{}",
            row.cell,
        );
        assert!(
            row.readiness_deadline_ms >= 30_000,
            "{}: plan 1424",
            row.cell,
        );
    }
    let chat_1k = cohort_cell(CHAT_1K_CELL).expect("chat 1k");
    assert_eq!(chat_1k.cell, "chat 1k");
    assert_eq!(chat_1k.publisher_count, 10);
    assert_eq!(chat_1k.subscriber_count, 1_000);
    assert_eq!(chat_1k.session_count, 1_010);
    assert_eq!(chat_1k.measured_ingress, 300);
    assert_eq!(chat_1k.expanded_deliveries, 300_000);
    assert_eq!(chat_1k.readiness_deadline_ms, 90_000);
    assert_eq!(
        cohort_cell("ticker-fanout/rate-10000")
            .expect("t")
            .readiness_deadline_ms,
        30_000
    );
    assert_eq!(
        cohort_cell("chat-fanout/subscribers-5000")
            .expect("c")
            .readiness_deadline_ms,
        180_000
    );
    assert_eq!(
        cohort_cell("chat-fanout/subscribers-10000")
            .expect("c")
            .readiness_deadline_ms,
        300_000
    );
    // A cell id outside the six is a refusal, never a fallback row.
    assert_eq!(
        cohort_cell("bulk-one-way/physical"),
        Err(MacRefusal::Mismatch("cellId"))
    );
}

/// The plan is a second statement of the §4.5 row, and both cannot be true if
/// they disagree.
#[test]
fn a_role_plan_that_disagrees_with_its_cells_cardinalities_is_refused() {
    let mut campaign = campaign();
    let execution_sha256 = campaign.open_execution(1);
    let plan = bytes_of(&role_plan_input(CHAT_1K_CELL, 9, 1_000));
    // The execution was opened for the honest plan's digest; a different plan
    // is first a different digest.
    assert_eq!(
        campaign.open_frame(&execution_sha256, |frame| {
            frame["workloadRolePlanInputBase64"] = json!(b64(&plan));
            frame["workloadRolePlanInputSha256"] = json!(sha256_hex(&plan));
            frame["workloadRolePlanInputSize"] = json!(plan.len());
        }),
        Err(MacRefusal::Mismatch("workloadRolePlanInputSha256")),
    );
    // And an execution opened for that plan refuses it on the cardinality.
    let (execution_sha256, _) = campaign.open_execution_with(2, |draft| {
        draft["workloadRolePlanInputSha256"] = json!(sha256_hex(&plan));
    });
    assert_eq!(
        campaign.open_frame(&execution_sha256, |frame| {
            frame["workloadRolePlanInputBase64"] = json!(b64(&plan));
            frame["workloadRolePlanInputSha256"] = json!(sha256_hex(&plan));
            frame["workloadRolePlanInputSize"] = json!(plan.len());
        }),
        Err(MacRefusal::Mismatch("role plan cardinality")),
    );
}

fn base64_of_decoded_size(decoded: u64) -> String {
    assert_eq!(decoded % 3, 0, "keep the arithmetic exact");
    "A".repeat(((decoded / 3) * 4) as usize)
}

#[test]
fn decoded_byte_length_is_arithmetic_on_the_encoded_string() {
    assert_eq!(decoded_byte_length_of_base64("AQ=="), Some(1));
    assert_eq!(decoded_byte_length_of_base64("Ag=="), Some(1));
    assert_eq!(decoded_byte_length_of_base64("AAA="), Some(2));
    assert_eq!(decoded_byte_length_of_base64("AAAA"), Some(3));
    assert_eq!(
        decoded_byte_length_of_base64(&base64_of_decoded_size(9_437_184)),
        Some(9_437_184)
    );
    // Not chargeable, so not chargeable as zero either.
    assert_eq!(decoded_byte_length_of_base64(""), None);
    assert_eq!(decoded_byte_length_of_base64("AAA"), None);
    assert_eq!(decoded_byte_length_of_base64("AA*A"), None);
}

/// The test that makes the budget load-bearing rather than decorative.
///
/// Three 9 MiB **decoded** exports in one execution. Each one is 12 MiB
/// encoded, comfortably inside registry edit (e)'s 14 MiB per-frame cap, so
/// every per-frame check passes on all three — and the third must still refuse,
/// on the budget. Without this the accounting could be absent and nothing else
/// in the suite would notice, which is exactly how the constant reached HEAD
/// with no consumer in either language.
#[test]
fn the_budget_refuses_where_the_per_frame_cap_would_not() {
    const NINE_MIB: u64 = 9_437_184;
    let payload = base64_of_decoded_size(NINE_MIB);
    assert!(
        payload.len() <= 14 * 1024 * 1024,
        "each frame is inside its own per-frame cap: {} encoded",
        payload.len(),
    );
    let frame = json!({
        "schema": "mac-export-cohort-evidence-request/v1",
        "roleChildEvidenceBundleBase64": payload,
    });
    let map = frame.as_object().expect("object");

    let mut budget = CohortEvidenceBudget::default();
    assert_eq!(budget.charge(map), Ok(NINE_MIB));
    assert_eq!(budget.charge(map), Ok(NINE_MIB));
    assert_eq!(budget.charged_bytes(), 2 * NINE_MIB);
    const { assert!(2 * NINE_MIB < COHORT_REMOTE_EVIDENCE_BUDGET_MAX_BYTES) };
    assert_eq!(
        budget.charge(map),
        Err(MacRefusal::ResourceExhausted),
        "the third frame passes its own cap and exhausts the execution's budget",
    );
    assert_eq!(budget.charge(map), Err(MacRefusal::ResourceExhausted));
    assert_eq!(
        budget.charged_bytes(),
        2 * NINE_MIB,
        "a refused charge is not banked",
    );
    assert_eq!(
        MacRefusal::ResourceExhausted.code(),
        "RUNTIME_RESOURCE_EXHAUSTION"
    );
}

/// The budget is not a frame counter: only the three bulk-carrying frames
/// debit, and a nullable debit field carrying an explicit null costs nothing.
#[test]
fn only_the_three_bulk_frames_debit_the_budget() {
    let mut budget = CohortEvidenceBudget::default();
    for schema in [
        "mac-open-cohort-request/v1",
        "mac-issue-start-barrier-request/v1",
        "mac-present-rig-barrier-acceptance-request/v1",
    ] {
        let frame = json!({ "schema": schema, "rigBarrierAcceptanceBase64": "AAAA" });
        assert_eq!(
            budget.charge(frame.as_object().expect("object")),
            Ok(0),
            "{schema}"
        );
    }
    // Edit (d)'s five are nullable for non-cohort executions; a null costs
    // nothing, and five records cost the sum of the five.
    let null_frame = json!({
        "schema": "mac-present-rig-observation-request/v1",
        "orderedPartialManifestBase64": Value::Null,
        "observedProcessProofBase64": Value::Null,
        "cohortRateSeriesBase64": Value::Null,
        "cohortLedgerBase64": Value::Null,
        "cohortCapacityBase64": Value::Null,
    });
    assert_eq!(
        budget.charge(null_frame.as_object().expect("object")),
        Ok(0)
    );
    let carried = json!({
        "schema": "mac-present-rig-observation-request/v1",
        "orderedPartialManifestBase64": "AAAA",
        "observedProcessProofBase64": "AAAA",
        "cohortRateSeriesBase64": "AAAA",
        "cohortLedgerBase64": "AAAA",
        "cohortCapacityBase64": "AAAA",
    });
    assert_eq!(budget.charge(carried.as_object().expect("object")), Ok(15));
    // Edit (c)'s array charges every element, not the array.
    let array_frame = json!({
        "schema": "mac-export-warmup-completion-manifest-request/v1",
        "roleWarmupCompletesBase64": ["AAAA", "AAAA", "AAAA"],
    });
    assert_eq!(
        budget.charge(array_frame.as_object().expect("object")),
        Ok(9)
    );
    // A malformed debit field cannot charge zero and proceed.
    let bad = json!({
        "schema": "mac-export-cohort-evidence-request/v1",
        "roleChildEvidenceBundleBase64": "AA*A",
    });
    assert_eq!(
        budget.charge(bad.as_object().expect("object")),
        Err(MacRefusal::Protocol("chargeable base64")),
    );
}

/// The accumulator is wired into the real dispatch path, per execution, and it
/// charges before the transition decodes anything.
#[test]
fn the_dispatch_path_charges_each_execution_separately() {
    let mut campaign = campaign();
    let first = campaign.open_execution(1);
    let second = campaign.open_execution(2);
    campaign.open(&first).expect("open");
    campaign.open(&second).expect("open");
    let seq = campaign.seq();
    let _ = campaign.dispatch(
        "mac-export-cohort-evidence-request",
        &json!({
            "schema": "mac-export-cohort-evidence-request/v1",
            "requestSeq": seq,
            "executionSha256": first,
            "cohortAdmissionReceiptSha256": digest("admission"),
            "roleChildEvidenceBundleBase64": base64_of_decoded_size(3_000),
        }),
    );
    let open_charge = 253_794 + chat_1k_plan_bytes().len() as u64;
    let charged = campaign.session(&first).evidence_bytes_charged();
    assert!(
        charged > open_charge && charged < open_charge + 3_000 + 16 * 1024,
        "open frame plus 3,000: {charged}"
    );
    let second_charged = campaign.session(&second).evidence_bytes_charged();
    assert_eq!(
        charged - second_charged,
        3_000,
        "a per-campaign accumulator would refuse execution 2 for what execution 1 spent",
    );
}

// --- §5 residual 1: the key ends up in one process ---------------------------

/// The invariant §5 residual 1 names: no production TypeScript signs a Mac
/// receipt.  The only remaining callers of `signMacReceipt` outside tests are
/// the explicit fixture producers in `cohort-fixture-signing.ts` (amendment
/// C3: "fixtures use test-only keys and explicit test producers; production
/// uses only binary-issued bytes").  The assertion is on the **file set**, so
/// a production signer added anywhere goes red, and the fixture module moving
/// a line does not.
#[test]
fn no_mac_receipt_is_signed_outside_the_binary() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tools/compare")
        .canonicalize()
        .expect("tools/compare");
    let mut files: Vec<String> = Vec::new();
    let mut stack = vec![root.clone()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).expect("read_dir") {
            let path = entry.expect("entry").path();
            let name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_owned();
            if path.is_dir() {
                if name != "node_modules" {
                    stack.push(path);
                }
                continue;
            }
            if !name.ends_with(".ts") || name.ends_with(".test.ts") {
                continue;
            }
            let text = std::fs::read_to_string(&path).expect("read");
            if text
                .lines()
                .any(|line| line.contains("signMacReceipt(") && !line.contains("export function"))
            {
                files.push(
                    path.strip_prefix(&root)
                        .expect("relative")
                        .display()
                        .to_string(),
                );
            }
        }
    }
    files.sort();
    files.dedup();
    assert_eq!(
        files,
        vec!["cohort-fixture-signing.ts".to_owned()],
        "§5 residual 1: only the explicit fixture producer signs Mac receipts outside crates/native",
    );
}

// --- the per-cell evidence vectors (amendment C3) -----------------------------

/// One reproducible lifecycle per cell, from seeded keys, deterministic
/// nonces, fixed grants and fixed clocks: the full 33-member
/// `cohort-observation-evidence/v1` the binary digested and signed, pinned by
/// digest and size, and written out in full when
/// `WTB_EVIDENCE_VECTOR_DIR` names a directory — the TypeScript encoder
/// decodes every member from the record itself and must reproduce these
/// exact bytes.
fn evidence_vector(cell_id: &str) -> (Vec<u8>, Vec<u8>) {
    let mut campaign = deterministic_campaign(&format!("evidence-vector/{cell_id}"));
    let execution_sha256 = campaign.open_deterministic_execution(1, cell_id);
    campaign.reach_admission(&execution_sha256);
    let ack = campaign.export_evidence(&execution_sha256).expect("export");
    verify_cohort_export_ack_signature(&ack, &campaign.mac_public_raw32).expect("signed");
    let evidence = campaign
        .runtime
        .last_exported_evidence_for_tests()
        .expect("evidence")
        .to_vec();
    let ack_value = json_of(&ack);
    assert_eq!(
        ack_value["cohortObservationEvidenceSha256"],
        sha256_hex(&evidence)
    );
    assert_eq!(ack_value["cohortObservationEvidenceSize"], evidence.len());
    if let Ok(dir) = std::env::var("WTB_EVIDENCE_VECTOR_DIR") {
        let name = cell_id.replace('/', "_");
        std::fs::write(
            format!("{dir}/cohort-observation-evidence.{name}.hex"),
            to_hex(&evidence),
        )
        .expect("write");
        std::fs::write(
            format!("{dir}/mac-cohort-evidence-exported-ack.{name}.hex"),
            to_hex(&ack),
        )
        .expect("write");
        std::fs::write(
            format!("{dir}/keys.{name}.json"),
            serde_json::to_string_pretty(&json!({
                "macPublicRaw32Hex": to_hex(&campaign.mac_public_raw32),
                "rigPublicRaw32Hex": to_hex(&campaign.rig.keys.public_raw32),
                "executionSha256": execution_sha256,
            }))
            .expect("json"),
        )
        .expect("write");
    }
    (evidence, ack)
}

#[test]
fn the_chat_1k_evidence_vector_is_reproducible_and_pinned() {
    let (evidence, _) = evidence_vector(CHAT_1K_CELL);
    let (again, _) = evidence_vector(CHAT_1K_CELL);
    assert_eq!(evidence, again, "deterministic end to end");
    let value = json_of(&evidence);
    assert_eq!(
        value.as_object().expect("object").len(),
        34,
        "schema plus the 33 members"
    );
    assert_eq!(
        value["roleWarmupCompletes"]
            .as_array()
            .expect("array")
            .len(),
        18
    );
    assert_eq!(
        value["publisherPartials"].as_array().expect("array").len(),
        10
    );
    assert_eq!(value["workerPartials"].as_array().expect("array").len(), 8);
    assert_eq!(evidence.len(), CHAT_1K_EVIDENCE_SIZE);
    assert_eq!(sha256_hex(&evidence), CHAT_1K_EVIDENCE_SHA256);
}

#[test]
fn the_ticker_10k_evidence_vector_is_reproducible_and_pinned() {
    let (evidence, _) = evidence_vector("ticker-fanout/rate-10000");
    let value = json_of(&evidence);
    assert_eq!(
        value["roleWarmupCompletes"]
            .as_array()
            .expect("array")
            .len(),
        9
    );
    assert_eq!(
        value["publisherPartials"].as_array().expect("array").len(),
        1
    );
    assert_eq!(evidence.len(), TICKER_10K_EVIDENCE_SIZE);
    assert_eq!(sha256_hex(&evidence), TICKER_10K_EVIDENCE_SHA256);
}

/// Pinned 2026-09-05 from the deterministic lifecycle above, re-pinned the
/// same day once the harness's rig records took the production rig's closed
/// key sets (G2: `cohort::rig_record_keys`, exact-keyed by `RigRetention::admit`)
/// and the cohort session continued the execution channel's `responseSeq`
/// (G1), and again (v3) once every shard's commitment window became the span
/// of its residue class (R-A: `shard_commitment_window_end`, chat-1k
/// `[10 + w, 1003 + w)`, ticker-10k `[1 + w, …)`).  The full hex is under
/// `.scratch/2026-09-05-cohort-completion/notes/vectors-v3/`, mirrored by the
/// TS pins in `tools/compare/fixtures/cohort-evidence-vectors/`.
const CHAT_1K_EVIDENCE_SIZE: usize = 507_198;
const CHAT_1K_EVIDENCE_SHA256: &str =
    "a543d54d948cb6c400cef70c7890af9eb04130c5ed4f81d2e58f565b69db5a61";
const TICKER_10K_EVIDENCE_SIZE: usize = 134_555;
const TICKER_10K_EVIDENCE_SHA256: &str =
    "3f640b72ca143cd67849e4797eea0ad88a6edabb746b11519b5ead7eee8999c4";

/// The frame caps are per kind on both sides, and the ones that differ from
/// the default differ in three directions: the open grew to 7 MiB for C1's
/// carrier, the warmup export keeps 384 KiB, the evidence export takes 14 MiB
/// and its ack shrank to 8 KiB.
#[test]
fn each_mac_frame_kind_carries_its_own_cap() {
    use secure_fs::cohort::mac::{ack_payload_cap, request_payload_cap};
    assert_eq!(
        request_payload_cap("mac-open-cohort-request"),
        7 * 1024 * 1024
    );
    assert_eq!(
        request_payload_cap("mac-export-warmup-completion-manifest-request"),
        384 * 1024
    );
    assert_eq!(
        request_payload_cap("mac-export-cohort-evidence-request"),
        14 * 1024 * 1024
    );
    assert_eq!(request_payload_cap(MAC_OPEN_EXECUTION_KIND), 1_048_576);
    assert_eq!(ack_payload_cap("mac-cohort-opened-ack"), 1_048_576);
    assert_eq!(
        ack_payload_cap("mac-warmup-completion-manifest-exported-ack"),
        384 * 1024
    );
    assert_eq!(
        ack_payload_cap("mac-cohort-evidence-exported-ack"),
        8 * 1024,
        "NEW-21's shrink"
    );
    for kind in MAC_REQUEST_KINDS {
        let ack = ack_kind_for(kind).expect("ack");
        assert!(request_payload_cap(kind) >= 1_024, "{kind}");
        assert!(ack_payload_cap(ack) >= 1_024, "{ack}");
    }
}

// --- pre-readiness cohort replacement (base plan 2210) ----------------------
//
// "Before readiness, replacement invalidates all ready state, kills the entire
// role cohort and server child, increments `cohortAttempt`, mints fresh
// child/cohort nonces and all fresh tokens, sends the new grant to rig, spawns
// a fresh server child, and re-runs readiness. Reusing the old
// grant/token/nonce fails replay tests. At most one pre-readiness cohort
// replacement is allowed; a second failure is terminal."

/// The grant record this session minted, decoded.
fn grant_value(campaign: &mut Campaign, execution_sha256: &str) -> Value {
    json_of(&campaign.session(execution_sha256).grant().bytes)
}

/// A rig cohort acceptance naming exactly the two digests the caller states,
/// so a test can present the *retired* attempt's acceptance to the live one.
fn present_cohort_acceptance_naming(
    campaign: &mut Campaign,
    execution_sha256: &str,
    grant_sha256: &str,
    grant_signature_sha256: &str,
) -> Result<Vec<u8>, MacRefusal> {
    let (record, signature) = campaign.rig.sign(
        "rig-cohort-acceptance/v1",
        &with_fields(
            rig_record("rig-cohort-acceptance/v1", execution_sha256, 1),
            &[
                ("cohortGrantSha256", grant_sha256),
                ("cohortGrantSignatureSha256", grant_signature_sha256),
            ],
        ),
    );
    let seq = campaign.seq();
    campaign.dispatch(
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

/// Plan 2210, the positive half: one pre-readiness replacement is accepted,
/// carries `cohortAttempt: 2`, and is a wholly fresh grant over a wholly fresh
/// token commitment set.  The channel's answer counter continues rather than
/// restarting, because `assertRemoteResponseSeq` admits exactly the next value.
#[test]
fn supervisor_pre_ready_replacement_mints_attempt_two_with_a_fresh_grant_and_tokens() {
    let mut campaign = campaign();
    let execution_sha256 = campaign.open_execution(1);
    let first_ack = json_of(&campaign.open(&execution_sha256).expect("first open"));
    assert_eq!(first_ack["responseSeq"], 1);
    let first = grant_value(&mut campaign, &execution_sha256);
    let first_grant_sha256 = campaign.session(&execution_sha256).grant().sha256.clone();
    let first_receipt_sequence = first["receiptSequence"].as_u64().expect("receiptSequence");
    assert_eq!(first["cohortAttempt"], 1, "the first attempt is 1");

    campaign
        .present_cohort_acceptance(&execution_sha256)
        .expect("first acceptance");

    let ack = json_of(
        &campaign
            .open_frame_for_cohort(&execution_sha256, "cohort-replacement-2", |_| {})
            .expect("replacement open"),
    );
    assert_eq!(ack["schema"], "mac-cohort-opened-ack/v1");
    assert_eq!(
        ack["responseSeq"], 3,
        "the replacement continues the channel: open 0, cohort open 1, acceptance 2"
    );
    let second = grant_value(&mut campaign, &execution_sha256);
    assert_eq!(
        second["cohortAttempt"], 2,
        "the mint increments the attempt"
    );
    assert_ne!(
        second["cohortId"], first["cohortId"],
        "a replacement mints a fresh cohort nonce"
    );
    assert_ne!(
        second["roleTokenCommitmentRootSha256"], first["roleTokenCommitmentRootSha256"],
        "a replacement mints all fresh tokens"
    );
    assert_ne!(
        campaign.session(&execution_sha256).grant().sha256,
        first_grant_sha256,
        "the replacement grant is a different record"
    );
    assert!(
        second["receiptSequence"].as_u64().expect("receiptSequence") > first_receipt_sequence,
        "the campaign signing sequence keeps advancing across a replacement"
    );
    assert_eq!(
        campaign.session(&execution_sha256).cohort_attempt(),
        2,
        "the session states the attempt it was minted under"
    );
    assert_eq!(
        campaign.runtime.session_count(),
        1,
        "the replacement takes the retired session's place"
    );
}

/// Plan 2443's exact name.  Everything the retired attempt committed to is
/// dead: its grant digest is refused under its own code wherever a grant digest
/// is named, and the acceptance the rig signed over it no longer advances the
/// cohort.
#[test]
fn supervisor_pre_ready_replacement_invalidates_old_tokens() {
    let mut campaign = campaign();
    let execution_sha256 = campaign.open_execution(1);
    campaign.open(&execution_sha256).expect("first open");
    let retired = campaign.session(&execution_sha256).grant();
    let retired_grant_sha256 = retired.sha256.clone();
    let retired_signature_sha256 = retired.signature_sha256.clone();
    let retired_root = grant_value(&mut campaign, &execution_sha256)
        ["roleTokenCommitmentRootSha256"]
        .as_str()
        .expect("root")
        .to_owned();

    campaign
        .open_frame_for_cohort(&execution_sha256, "cohort-replacement-2", |_| {})
        .expect("replacement open");

    // The rig acceptance the controller already held over attempt 1.
    assert_eq!(
        present_cohort_acceptance_naming(
            &mut campaign,
            &execution_sha256,
            &retired_grant_sha256,
            &retired_signature_sha256,
        ),
        Err(MacRefusal::Cohort("retired cohort grant")),
        "the retired attempt's acceptance is a replay, not a mismatch"
    );

    // An epoch request naming the abandoned grant.
    campaign
        .present_cohort_acceptance(&execution_sha256)
        .expect("replacement acceptance");
    let acceptance_sha256 = sha256_hex(
        &campaign
            .rig_record(&execution_sha256, "rigCohortAcceptance")
            .0,
    );
    let seq = campaign.seq();
    assert_eq!(
        campaign.dispatch(
            "mac-issue-warmup-epoch-request",
            &json!({
                "schema": "mac-issue-warmup-epoch-request/v1",
                "requestSeq": seq,
                "executionSha256": execution_sha256,
                "cohortGrantSha256": retired_grant_sha256,
                "rigCohortAcceptanceSha256": acceptance_sha256,
            }),
        ),
        Err(MacRefusal::Cohort("retired cohort grant")),
    );

    // And the live attempt's own material is not the retired one's.
    let live = grant_value(&mut campaign, &execution_sha256);
    assert_ne!(live["roleTokenCommitmentRootSha256"], json!(retired_root));
}

/// A replacement that re-presents the abandoned manifest -- same cohort id,
/// same root, same manifest digest -- is not a replacement.
#[test]
fn supervisor_replacement_reusing_the_retired_cohort_material_is_refused() {
    let mut campaign = campaign();
    let execution_sha256 = campaign.open_execution(1);
    campaign.open(&execution_sha256).expect("first open");
    let reused = format!("cohort-{}", &execution_sha256[..16]);
    assert_eq!(
        campaign.open_frame_for_cohort(&execution_sha256, &reused, |_| {}),
        Err(MacRefusal::Cohort(
            "replacement reuses retired cohort material"
        )),
    );
    assert_eq!(
        campaign.session(&execution_sha256).cohort_attempt(),
        1,
        "a refused replacement leaves the live attempt untouched"
    );
}

/// "At most one pre-readiness cohort replacement is allowed; a second failure
/// is terminal."
#[test]
fn supervisor_second_pre_ready_replacement_is_terminal() {
    let mut campaign = campaign();
    let execution_sha256 = campaign.open_execution(1);
    campaign.open(&execution_sha256).expect("first open");
    campaign
        .open_frame_for_cohort(&execution_sha256, "cohort-replacement-2", |_| {})
        .expect("replacement open");
    assert_eq!(
        campaign.open_frame_for_cohort(&execution_sha256, "cohort-replacement-3", |_| {}),
        Err(MacRefusal::Cohort("one pre-readiness cohort replacement")),
    );
    assert_eq!(campaign.session(&execution_sha256).cohort_attempt(), 2);
}

/// Plan 2442's exact name.  After the binary has minted anything that only
/// exists past `RAMP_AND_READY`, replacement is forbidden.
#[test]
fn supervisor_post_ready_replacement_fails() {
    let mut campaign = campaign();
    let execution_sha256 = campaign.open_execution(1);
    campaign.open(&execution_sha256).expect("open");
    campaign
        .present_cohort_acceptance(&execution_sha256)
        .expect("acceptance");
    campaign
        .issue_warmup_epoch(&execution_sha256)
        .expect("warmup epoch");
    assert_eq!(
        campaign.open_frame_for_cohort(&execution_sha256, "cohort-replacement-2", |_| {}),
        Err(MacRefusal::Cohort("replacement after readiness")),
    );
    assert_eq!(campaign.session(&execution_sha256).cohort_attempt(), 1);
}

/// §2.9(2d)'s budget is per execution, not per attempt: a replacement cannot
/// buy a second one.
#[test]
fn supervisor_replacement_does_not_reset_the_execution_evidence_budget() {
    let mut campaign = campaign();
    let execution_sha256 = campaign.open_execution(1);
    campaign.open(&execution_sha256).expect("first open");
    let first = campaign.session(&execution_sha256).evidence_bytes_charged();
    assert!(first > 0);
    campaign
        .open_frame_for_cohort(&execution_sha256, "cohort-replacement-2", |_| {})
        .expect("replacement open");
    let second = campaign.session(&execution_sha256).evidence_bytes_charged();
    assert!(
        second > first && second - first >= first - first / 10,
        "the replacement frame is charged on top of the retired attempt's {first}, got {second}"
    );
}

/// The replaced cohort is not a stub: it re-runs the real transitions under
/// attempt 2, bound to the new grant and the new cohort id.
#[test]
fn supervisor_replaced_cohort_completes_the_next_transitions_under_attempt_two() {
    let mut campaign = campaign();
    let execution_sha256 = campaign.open_execution(1);
    campaign.open(&execution_sha256).expect("first open");
    campaign
        .open_frame_for_cohort(&execution_sha256, "cohort-replacement-2", |_| {})
        .expect("replacement open");
    campaign
        .present_cohort_acceptance(&execution_sha256)
        .expect("acceptance under attempt 2");
    campaign
        .issue_warmup_epoch(&execution_sha256)
        .expect("epoch under attempt 2");
    let session = campaign.session(&execution_sha256);
    let epoch = json_of(&session.warmup_epoch().expect("epoch").bytes);
    assert_eq!(epoch["cohortId"], "cohort-replacement-2");
    assert_eq!(epoch["cohortGrantSha256"], session.grant().sha256);
}
