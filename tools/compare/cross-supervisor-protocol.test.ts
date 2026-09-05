/**
 * A2 adversarial protocol tests (plan §8 A2 named checkbox list).
 */
import { describe, expect, test } from "bun:test";
import {
	assertChildInboundSequence,
	assertChildOutboundSequence,
	buildServerWarmupReady,
	CHILD_PIPE_REFUSAL_CODES,
	childPipeExactKeysAndBoundsFixture,
	createChildSequenceState,
	decodeChildPipeFrame,
	encodeChildPipeFrame,
	mapChildRefusalToIndexCode,
	mapsEveryChildRefusalStateToOneIndexCode,
	parseChildPipeRefusal,
	parseServerBindExecution,
	parseServerWarmupReady,
} from "./child-pipe-protocol.ts";
import {
	COHORT_MAX_PUBLISHERS,
	COHORT_WORKER_COUNT,
	recomputeRootFromLeafManifest,
	type TokenCommitmentLeafManifestV1,
} from "./cohort-protocol.ts";
import {
	admitSignedRecordWithExpiryAndReplay,
	assertRemoteRequestSeq,
	assertRemoteResponseSeq,
	bytesOfCanonical,
	CAMPAIGN_FAILURE_CODES,
	CAMPAIGN_REFUSAL_CODES,
	CAPS,
	COHORT_EVIDENCE_DEBIT_FIELDS,
	COHORT_EVIDENCE_EXPORT_MAX_ENCODED_BYTES,
	COHORT_EVIDENCE_EXPORTED_ACK_MAX_BYTES,
	COHORT_REMOTE_FIELD_KINDS,
	COHORT_REMOTE_MAX_BASE64_ARRAY_ENTRIES,
	COHORT_WARMUP_MANIFEST_EXPORT_MAX_ENCODED_BYTES,
	CohortEvidenceBudget,
	type CohortRemoteSchema,
	type CrossSupervisorExecutionDraftV1,
	cohortRemotePayloadKeys,
	createMemoryReplayLedger,
	createRemoteSequenceState,
	decodedByteLengthOfBase64,
	decodeRegisteredRemotePayload,
	decodeRemoteSupervisorPayload,
	encodeRegisteredRemotePayload,
	encodeRemoteSupervisorPayload,
	FANOUT_EXPANDED_DECLARATION_BY_CELL_ID,
	generateEd25519KeyPair,
	isPhaseAMacRemoteSchema,
	type MacExecutionGrantReceiptV1,
	macConstructFinalExecution,
	PHASE_A_DECLARED_MESSAGE_BYTES,
	PHASE_A_DECLARED_MESSAGE_COUNT,
	PHASE_A_MAC_REMOTE_SCHEMAS,
	PHASE_A_REMOTE_FIELD_KINDS,
	PHASE_A_REMOTE_PAYLOAD_SCHEMAS,
	PHASE_A_RIG_REMOTE_SCHEMAS,
	type PhaseARemoteFieldSpec,
	type ProtocolResult,
	parseCohortRemotePayload,
	parseCrossSupervisorExecution,
	parseCrossSupervisorExecutionDraft,
	parseMacExecutionGrantReceipt,
	parsePhaseAMacRemotePayload,
	parsePhaseARigRemotePayload,
	parseRemoteSupervisorRefusal,
	phaseAMacRemoteFieldSpec,
	phaseAMacRemotePayloadKeys,
	phaseARemoteFieldOk,
	phaseARigRemoteFieldSpec,
	phaseARigRemotePayloadKeys,
	type RigExecutionAcceptanceV1,
	rejectCrossExecutionRigReceipt,
	rejectHashOnlyGrantOrBaselineAck,
	rejectOversizeTruncatedTrailingAndEarlyEof,
	rejectPlanOrApprovalSwap,
	rejectUnsignedMacReceipt,
	rejectUnsignedOrInventedRigAcceptance,
	rejectWrongStagedPublicKey,
	remotePayloadBoundForSchema,
	STAGED_MAC_PUBLIC_KEY_LEAF,
	STAGED_RIG_PUBLIC_KEY_LEAF,
	sha256CanonicalRecord,
	signMacReceipt,
	signRigReceipt,
	toBase64,
	validateRemoteStatusCodePair,
	verifyMacReceiptSignature,
	verifyRigReceiptSignature,
} from "./cross-supervisor-protocol.ts";
import { buildFanoutCohortFixture } from "./scenarios/fanout-relay.ts";
import { sha256HexOfBytes } from "./secure-fs.ts";

const HEX_A = "a".repeat(64);
const HEX_B = "b".repeat(64);
const HEX_C = "c".repeat(64);
const HEX_D = "d".repeat(64);
const HEX_E = "e".repeat(64);
const HEX_F = "f".repeat(64);
const HEX_1 = "1".repeat(64);
const HEX_2 = "2".repeat(64);
const HEX_3 = "3".repeat(64);
const HEX_4 = "4".repeat(64);
const HEX_5 = "5".repeat(64);
const HEX_6 = "6".repeat(64);
const HEX_7 = "7".repeat(64);
const HEX_8 = "8".repeat(64);
const HEX_9 = "9".repeat(64);

/**
 * Reads the refusal code off a ProtocolResult after proving it refused.
 * Reaching for `.code` on the union silently yields `undefined` on the ok
 * branch, so a check that stopped refusing would still pass `toBe(...)`
 * against nothing. This throws instead.
 */
function refusalCode(result: ProtocolResult<unknown>): string {
	if (result.ok) {
		throw new Error("expected a refusal, got ok");
	}
	return result.code;
}

function sampleDraft(
	overrides: Partial<CrossSupervisorExecutionDraftV1> = {},
): CrossSupervisorExecutionDraftV1 {
	return {
		schema: "cross-supervisor-execution-draft/v1",
		authoritySha256: HEX_A,
		campaignLockSha256: HEX_B,
		stagedCapabilitySha256: HEX_C,
		sourceArchiveSha256: HEX_D,
		approvedPlanSha256: HEX_E,
		approvalRecordSha256: HEX_F,
		candidate: "cand",
		campaignId: "camp",
		runId: "camp/cell/ws/measured-1",
		executionPurpose: "focused",
		cellId: "bulk-one-way/physical",
		scenarioHash: HEX_1,
		rolePlanHash: HEX_2,
		workloadRolePlanInputSha256: HEX_3,
		stagedServerLaunchRecordSha256: HEX_4,
		armKind: "primary",
		transport: "ws",
		repetitionKind: "measured",
		repetitionIndex: 1,
		repetitionTotal: 1,
		grantDeclaration: "phase-a-completed-transfer",
		declaredMessageCount: PHASE_A_DECLARED_MESSAGE_COUNT,
		declaredMessageBytes: PHASE_A_DECLARED_MESSAGE_BYTES,
		requestedNotAfterMs: 1_700_000_000_0000,
		...overrides,
	};
}

describe("cross-supervisor-protocol A2", () => {
	test("draft_rejects_controller_supplied_execution_index_or_grant_digest", () => {
		const base = sampleDraft();
		const withIndex = {
			...base,
			executionIndex: 0,
		};
		expect(parseCrossSupervisorExecutionDraft(withIndex).ok).toBe(false);
		const withGrant = {
			...base,
			measurementGrantSha256: HEX_A,
		};
		expect(parseCrossSupervisorExecutionDraft(withGrant).ok).toBe(false);
		const withNonce = {
			...base,
			macSupervisorInstanceNonce: HEX_A,
			issuedAtMs: 1,
			notAfterMs: 2,
		};
		expect(parseCrossSupervisorExecutionDraft(withNonce).ok).toBe(false);
		expect(parseCrossSupervisorExecutionDraft(base).ok).toBe(true);
	});

	test("mac_constructs_final_execution_after_grant", () => {
		const draft = sampleDraft();
		const built = macConstructFinalExecution({
			draft,
			executionIndex: 0,
			macSupervisorInstanceNonce: HEX_5,
			issuedAtMs: 1_000,
			notAfterMs: 2_000,
			grantNonceSha256: HEX_6,
		});
		expect(built.ok).toBe(true);
		if (!built.ok) return;
		expect(built.value.execution.executionIndex).toBe(0);
		expect(built.value.execution.measurementGrantSha256).toBe(
			built.value.grantSha256,
		);
		expect(built.value.execution.draftSha256).toBe(built.value.draftSha256);
		expect(built.value.execution.macSupervisorInstanceNonce).toBe(HEX_5);
		expect(parseCrossSupervisorExecution(built.value.execution).ok).toBe(true);
	});

	test("rejects_wrong_phase_a_declared_count_or_bytes", () => {
		const badCount = sampleDraft({ declaredMessageCount: 1599 });
		expect(parseCrossSupervisorExecutionDraft(badCount).ok).toBe(false);
		expect(refusalCode(parseCrossSupervisorExecutionDraft(badCount))).toBe(
			"CROSS_SUPERVISOR_MISMATCH",
		);
		const badBytes = sampleDraft({ declaredMessageBytes: 1 });
		expect(parseCrossSupervisorExecutionDraft(badBytes).ok).toBe(false);
	});

	test("accepts_exact_fanout_expanded_declaration", () => {
		for (const [cellId, expected] of Object.entries(
			FANOUT_EXPANDED_DECLARATION_BY_CELL_ID,
		)) {
			const draft = sampleDraft({
				cellId,
				grantDeclaration: "fanout-expanded-deliveries",
				declaredMessageCount: expected.declaredMessageCount,
				declaredMessageBytes: expected.declaredMessageBytes,
			});
			expect(parseCrossSupervisorExecutionDraft(draft).ok).toBe(true);
		}
	});

	test("rejects_unexpanded_fanout_declared_count_or_bytes", () => {
		// The offered ingress for ticker 10k, not the 10,000,000 deliveries owed.
		const unexpanded = sampleDraft({
			cellId: "ticker-fanout/rate-10000",
			grantDeclaration: "fanout-expanded-deliveries",
			declaredMessageCount: 100_000,
			declaredMessageBytes: 100,
		});
		expect(refusalCode(parseCrossSupervisorExecutionDraft(unexpanded))).toBe(
			"CROSS_SUPERVISOR_MISMATCH",
		);
		const wrongCellCount = sampleDraft({
			cellId: "chat-fanout/subscribers-1000",
			grantDeclaration: "fanout-expanded-deliveries",
			// chat 5k's expansion under chat 1k's cell id.
			declaredMessageCount: 1_500_000,
			declaredMessageBytes: 128,
		});
		expect(
			refusalCode(parseCrossSupervisorExecutionDraft(wrongCellCount)),
		).toBe("CROSS_SUPERVISOR_MISMATCH");
		const wrongBytes = sampleDraft({
			cellId: "ticker-fanout/rate-10000",
			grantDeclaration: "fanout-expanded-deliveries",
			declaredMessageCount: 10_000_000,
			declaredMessageBytes: 128,
		});
		expect(refusalCode(parseCrossSupervisorExecutionDraft(wrongBytes))).toBe(
			"CROSS_SUPERVISOR_MISMATCH",
		);
	});

	test("rejects_fanout_declaration_on_a_non_fanout_cell", () => {
		const fanoutOnBulk = sampleDraft({
			grantDeclaration: "fanout-expanded-deliveries",
			declaredMessageCount: 10_000_000,
			declaredMessageBytes: 100,
		});
		expect(refusalCode(parseCrossSupervisorExecutionDraft(fanoutOnBulk))).toBe(
			"CROSS_SUPERVISOR_MISMATCH",
		);
	});

	test("rejects_unsigned_mac_receipt", () => {
		expect(rejectUnsignedMacReceipt(null).ok).toBe(false);
		expect(rejectUnsignedMacReceipt(undefined).ok).toBe(false);
		const mac = generateEd25519KeyPair();
		const draft = sampleDraft();
		const built = macConstructFinalExecution({
			draft,
			executionIndex: 0,
			macSupervisorInstanceNonce: HEX_5,
			issuedAtMs: 1_000,
			notAfterMs: 2_000,
			grantNonceSha256: HEX_6,
		});
		if (!built.ok) throw new Error("construct");
		const receipt: MacExecutionGrantReceiptV1 = {
			schema: "mac-execution-grant-receipt/v1",
			execution: built.value.execution,
			executionSha256: built.value.executionSha256,
			measurementGrantSha256: built.value.grantSha256,
			approvedPlanSha256: draft.approvedPlanSha256,
			approvalRecordSha256: draft.approvalRecordSha256,
			macSupervisorExecutableSha256: HEX_7,
			macSupervisorInstanceNonce: HEX_5,
			signingPublicKeySha256: mac.publicKeySha256,
			receiptSequence: 0,
			issuedAtMs: 1_000,
			notAfterMs: 2_000,
		};
		const sig = signMacReceipt({
			privatePkcs8Der: mac.privatePkcs8Der,
			publicRaw32: mac.publicRaw32,
			signedSchema: "mac-execution-grant-receipt/v1",
			signedBytes: bytesOfCanonical(receipt),
		});
		expect(rejectUnsignedMacReceipt(sig).ok).toBe(true);
		const verified = verifyMacReceiptSignature({
			stagedMacPublicRaw32: mac.publicRaw32,
			signedBytes: bytesOfCanonical(receipt),
			signature: sig,
		});
		expect(verified.ok).toBe(true);
	});

	test("rejects_unsigned_or_controller_invented_rig_acceptance", () => {
		const rig = generateEd25519KeyPair();
		const acceptance: RigExecutionAcceptanceV1 = {
			schema: "rig-execution-acceptance/v1",
			executionSha256: HEX_A,
			measurementGrantSha256: HEX_B,
			macExecutionGrantReceiptSha256: HEX_C,
			macReceiptSignatureSha256: HEX_D,
			approvedPlanSha256: HEX_E,
			approvalRecordSha256: HEX_F,
			rigExecutionIndex: 0,
			rigSupervisorInstanceNonce: HEX_1,
			rigSupervisorExecutableSha256: HEX_2,
			replayLedgerLeafSha256: HEX_3,
			signingPublicKeySha256: rig.publicKeySha256,
			receiptSequence: 0,
			acceptedAtMs: 1_000,
			issuedAtMs: 1_000,
			notAfterMs: 2_000,
		};
		expect(
			rejectUnsignedOrInventedRigAcceptance({
				acceptance,
				signature: null,
				stagedRigPublicRaw32: rig.publicRaw32,
			}).ok,
		).toBe(false);
		expect(
			rejectUnsignedOrInventedRigAcceptance({
				acceptance: { ...acceptance, executionSha256: "nope" },
				signature: { schema: "rig-receipt-signature/v1" },
				stagedRigPublicRaw32: rig.publicRaw32,
			}).ok,
		).toBe(false);
		const sig = signRigReceipt({
			privatePkcs8Der: rig.privatePkcs8Der,
			publicRaw32: rig.publicRaw32,
			signedSchema: "rig-execution-acceptance/v1",
			signedBytes: bytesOfCanonical(acceptance),
		});
		expect(
			rejectUnsignedOrInventedRigAcceptance({
				acceptance,
				signature: sig,
				stagedRigPublicRaw32: rig.publicRaw32,
			}).ok,
		).toBe(true);
	});

	test("rejects_wrong_mac_or_rig_staged_public_key", () => {
		const mac = generateEd25519KeyPair();
		const other = generateEd25519KeyPair();
		expect(STAGED_MAC_PUBLIC_KEY_LEAF).toBe("mac-supervisor-ed25519.pub");
		expect(STAGED_RIG_PUBLIC_KEY_LEAF).toBe("rig-supervisor-ed25519.pub");
		expect(
			refusalCode(
				rejectWrongStagedPublicKey({
					role: "mac",
					stagedPublicRaw32: mac.publicRaw32,
					signaturePublicKeySha256: other.publicKeySha256,
				}),
			),
		).toBe("MAC_SIGNING_KEY_MISMATCH");
		expect(
			refusalCode(
				rejectWrongStagedPublicKey({
					role: "rig",
					stagedPublicRaw32: mac.publicRaw32,
					signaturePublicKeySha256: other.publicKeySha256,
				}),
			),
		).toBe("RIG_SIGNING_KEY_MISMATCH");
	});

	test("rejects_plan_or_approval_swap", () => {
		expect(
			refusalCode(
				rejectPlanOrApprovalSwap({
					left: { approvedPlanSha256: HEX_A, approvalRecordSha256: HEX_B },
					right: { approvedPlanSha256: HEX_A, approvalRecordSha256: HEX_C },
				}),
			),
		).toBe("APPROVAL_IDENTITY_MISMATCH");
		expect(
			rejectPlanOrApprovalSwap({
				left: { approvedPlanSha256: HEX_A, approvalRecordSha256: HEX_B },
				right: { approvedPlanSha256: HEX_A, approvalRecordSha256: HEX_B },
			}).ok,
		).toBe(true);
	});

	test("rejects_expired_and_replayed_mac_and_rig_record_after_restart", () => {
		const ledger = createMemoryReplayLedger();
		const bytes = bytesOfCanonical({
			schema: "mac-execution-grant-receipt/v1",
			n: 1,
		});
		const first = admitSignedRecordWithExpiryAndReplay({
			ledger,
			side: "mac-records",
			signedSchema: "mac-execution-grant-receipt/v1",
			signedBytes: bytes,
			issuedAtMs: 1_000,
			notAfterMs: 5_000,
			stagedCapabilityNotAfterMs: 10_000,
			nowMs: 2_000,
		});
		expect(first.ok).toBe(true);
		const snap = ledger.snapshot();
		const restarted = createMemoryReplayLedger(snap);
		const replay = admitSignedRecordWithExpiryAndReplay({
			ledger: restarted,
			side: "mac-records",
			signedSchema: "mac-execution-grant-receipt/v1",
			signedBytes: bytes,
			issuedAtMs: 1_000,
			notAfterMs: 5_000,
			stagedCapabilityNotAfterMs: 10_000,
			nowMs: 2_000,
		});
		expect(replay.ok).toBe(false);
		expect(refusalCode(replay)).toBe("MAC_GRANT_REPLAYED");
		const expired = admitSignedRecordWithExpiryAndReplay({
			ledger: createMemoryReplayLedger(),
			side: "rig-records",
			signedSchema: "rig-execution-acceptance/v1",
			signedBytes: bytesOfCanonical({
				schema: "rig-execution-acceptance/v1",
				n: 2,
			}),
			issuedAtMs: 1_000,
			notAfterMs: 5_000,
			stagedCapabilityNotAfterMs: 4_000,
			nowMs: 4_500,
		});
		expect(refusalCode(expired)).toBe("RIG_RECEIPT_EXPIRED");
	});

	test("rejects_cross_execution_rig_receipt", () => {
		const acceptance: RigExecutionAcceptanceV1 = {
			schema: "rig-execution-acceptance/v1",
			executionSha256: HEX_A,
			measurementGrantSha256: HEX_B,
			macExecutionGrantReceiptSha256: HEX_C,
			macReceiptSignatureSha256: HEX_D,
			approvedPlanSha256: HEX_E,
			approvalRecordSha256: HEX_F,
			rigExecutionIndex: 0,
			rigSupervisorInstanceNonce: HEX_1,
			rigSupervisorExecutableSha256: HEX_2,
			replayLedgerLeafSha256: HEX_3,
			signingPublicKeySha256: HEX_4,
			receiptSequence: 0,
			acceptedAtMs: 1,
			issuedAtMs: 1,
			notAfterMs: 2,
		};
		expect(
			refusalCode(
				rejectCrossExecutionRigReceipt({
					expectedExecutionSha256: HEX_B,
					acceptance,
				}),
			),
		).toBe("CROSS_SUPERVISOR_MISMATCH");
	});

	test("rejects_hash_only_grant_or_baseline_ack", () => {
		expect(
			rejectHashOnlyGrantOrBaselineAck({
				measurementGrantBase64: null,
				measurementGrantSha256: HEX_A,
				baselineAckBase64: null,
				baselineAckSha256: HEX_B,
			}).ok,
		).toBe(false);
		const grantBytes = bytesOfCanonical({
			schema: "measurement-grant/v1",
			x: 1,
		});
		const baselineBytes = bytesOfCanonical({
			schema: "rig-measure-start-ack/v1",
			y: 1,
		});
		expect(
			rejectHashOnlyGrantOrBaselineAck({
				measurementGrantBase64: toBase64(grantBytes),
				measurementGrantSha256: sha256CanonicalRecord({
					schema: "measurement-grant/v1",
					x: 1,
				}),
				baselineAckBase64: toBase64(baselineBytes),
				baselineAckSha256: sha256CanonicalRecord({
					schema: "rig-measure-start-ack/v1",
					y: 1,
				}),
			}).ok,
		).toBe(true);
	});

	test("rejects_remote_sequence_per_direction", () => {
		const state = createRemoteSequenceState();
		expect(assertRemoteRequestSeq(state, 0).ok).toBe(true);
		expect(assertRemoteRequestSeq(state, 0).ok).toBe(false);
		expect(assertRemoteRequestSeq(state, 1).ok).toBe(true);
		const resp = createRemoteSequenceState();
		expect(assertRemoteResponseSeq(resp, 0, 0).ok).toBe(true);
		expect(assertRemoteResponseSeq(resp, 0, 0).ok).toBe(false);
		expect(assertRemoteResponseSeq(resp, 1, 1).ok).toBe(true);
	});

	test("rejects_child_sequence_per_direction", () => {
		const state = createChildSequenceState();
		expect(assertChildOutboundSequence(state, 0).ok).toBe(true);
		expect(assertChildOutboundSequence(state, 0).ok).toBe(false);
		expect(assertChildInboundSequence(state, 0).ok).toBe(true);
		expect(assertChildInboundSequence(state, 2).ok).toBe(false);
		expect(assertChildInboundSequence(state, 1).ok).toBe(true);
	});

	test("rejects_oversize_truncated_trailing_and_early_eof", () => {
		expect(
			rejectOversizeTruncatedTrailingAndEarlyEof({ kind: "early-eof" }).ok,
		).toBe(false);
		const payload = {
			schema: "mac-teardown-execution-request/v1",
			requestSeq: 0,
			executionSha256: HEX_A,
		};
		const encoded = encodeRemoteSupervisorPayload(
			payload,
			CAPS.remotePayloadDefault,
		);
		expect(encoded.ok).toBe(true);
		if (!encoded.ok) return;
		const truncated = encoded.value.subarray(0, 8);
		expect(
			rejectOversizeTruncatedTrailingAndEarlyEof({
				kind: "truncated",
				frame: truncated,
			}).ok,
		).toBe(false);
		const trailing = new Uint8Array(encoded.value.byteLength + 1);
		trailing.set(encoded.value);
		expect(
			rejectOversizeTruncatedTrailingAndEarlyEof({
				kind: "trailing",
				frame: trailing,
			}).ok,
		).toBe(false);
		const oversizeBound = 8;
		expect(
			rejectOversizeTruncatedTrailingAndEarlyEof({
				kind: "oversize",
				frame: encoded.value,
				payloadBound: oversizeBound,
			}).ok,
		).toBe(false);
		const child = encodeChildPipeFrame(
			{
				schema: "server-teardown/v1",
				sequence: 0,
				executionSha256: HEX_A,
			},
			16,
		);
		expect(child.ok).toBe(false);
	});

	test("rejects_unknown_remote_and_child_refusal_codes", () => {
		expect(
			parseRemoteSupervisorRefusal({
				schema: "remote-supervisor-refusal/v1",
				responseSeq: 0,
				ackRequestSeq: 0,
				executionSha256: null,
				code: "NOT_A_REAL_CODE",
				campaignStatus: "FAIL",
				terminal: true,
			}).ok,
		).toBe(false);
		expect(
			parseChildPipeRefusal({
				schema: "child-pipe-refusal/v1",
				sequence: 0,
				executionSha256: HEX_A,
				code: "NOT_A_REAL_CODE",
				terminal: true,
			}).ok,
		).toBe(false);
		expect(CAMPAIGN_REFUSAL_CODES.length).toBe(3);
		expect(CAMPAIGN_FAILURE_CODES.length).toBe(18);
	});

	test("rejects_illegal_remote_status_code_pair", () => {
		expect(validateRemoteStatusCodePair("FAIL", "RIG_UNREACHABLE").ok).toBe(
			false,
		);
		expect(validateRemoteStatusCodePair("REFUSED", "TRUST_PROTOCOL").ok).toBe(
			false,
		);
		expect(validateRemoteStatusCodePair("REFUSED", "RIG_UNREACHABLE").ok).toBe(
			true,
		);
		expect(validateRemoteStatusCodePair("FAIL", "TRUST_PROTOCOL").ok).toBe(
			true,
		);
	});

	test("maps_every_child_refusal_state_to_one_index_code", () => {
		const map = mapsEveryChildRefusalStateToOneIndexCode();
		expect(map.size).toBe(CHILD_PIPE_REFUSAL_CODES.length);
		expect(mapChildRefusalToIndexCode("FRAME_INVALID")).toBe("TRUST_PROTOCOL");
		expect(mapChildRefusalToIndexCode("EXECUTION_MISMATCH")).toBe(
			"CROSS_SUPERVISOR_MISMATCH",
		);
		expect(mapChildRefusalToIndexCode("PROCESS_RESOURCE_EXHAUSTED")).toBe(
			"RUNTIME_RESOURCE_EXHAUSTION",
		);
		for (const code of CHILD_PIPE_REFUSAL_CODES) {
			expect(typeof map.get(code)).toBe("string");
		}
	});

	test("cross_supervisor_execution_rejects_duplicate_or_missing_keys", () => {
		const draft = sampleDraft();
		const built = macConstructFinalExecution({
			draft,
			executionIndex: 0,
			macSupervisorInstanceNonce: HEX_5,
			issuedAtMs: 1_000,
			notAfterMs: 2_000,
			grantNonceSha256: HEX_6,
		});
		if (!built.ok) throw new Error("construct");
		const good = built.value.execution;
		expect(parseCrossSupervisorExecution(good).ok).toBe(true);
		const { issuedAtMs: _drop, ...missing } = good;
		expect(parseCrossSupervisorExecution(missing).ok).toBe(false);
		const extra = { ...good, unexpected: 1 };
		expect(parseCrossSupervisorExecution(extra).ok).toBe(false);
	});

	test("remote and child round-trip codecs", () => {
		const payload = {
			schema: "mac-teardown-execution-request/v1",
			requestSeq: 0,
			executionSha256: HEX_A,
		};
		const framed = encodeRemoteSupervisorPayload(payload);
		expect(framed.ok).toBe(true);
		if (!framed.ok) return;
		const decoded = decodeRemoteSupervisorPayload(framed.value);
		expect(decoded.ok).toBe(true);
		const bind = {
			schema: "server-bind-execution/v1",
			sequence: 0,
			executionSha256: HEX_A,
			rigExecutionAcceptanceSha256: HEX_B,
			cohortGrantBase64: null,
			cohortGrantSignatureBase64: null,
		};
		expect(parseServerBindExecution(bind).ok).toBe(true);
		const childFrame = encodeChildPipeFrame(bind);
		expect(childFrame.ok).toBe(true);
		if (!childFrame.ok) return;
		expect(decodeChildPipeFrame(childFrame.value).ok).toBe(true);
		const bounds = childPipeExactKeysAndBoundsFixture();
		expect(bounds.maxControlBytes).toBe(64 * 1024);
	});
});

// ---------------------------------------------------------------------------
// B3.5: the Phase-A rig payload shapes the cohort channel has to speak.
//
// §3.3 registers `rig-spawn-server-request/v1`, `rig-measure-start-request/v1`
// and `rig-stop-and-capture-request/v1` (and their acks) as remote kinds, but
// B1 gave exact-key parsers only to the cohort kinds. The rig cohort channel
// cannot spawn a server, take the Linux baseline, or collect the snapshot and
// relay observation without them, so they are parsed here rather than trusted.
// ---------------------------------------------------------------------------

describe("phase-A rig remote payloads", () => {
	const SPAWN = {
		schema: "rig-spawn-server-request/v1",
		requestSeq: 3,
		executionSha256: HEX_A,
		cohortGrantSha256: HEX_B,
		serverEntrypointSha256: HEX_C,
		bunSha256: HEX_D,
		addonSha256: HEX_E,
		stagedServerLaunchRecordBase64: toBase64(new Uint8Array([1, 2, 3])),
		stagedServerLaunchRecordSha256: HEX_F,
		stagedServerLaunchRecordSize: 3,
		bindAddress: "10.99.0.2",
		bindPort: 4433,
		advertisedHost: "10.99.0.2",
		tlsServerName: "wt-compare.local",
		transport: "wt",
		serverArgv: ["server.ts", "--transport=wt", "--mode=fanout-cohort"],
	} as const;

	const READY = {
		schema: "rig-server-ready-ack/v1",
		responseSeq: 3,
		ackRequestSeq: 3,
		executionSha256: HEX_A,
		childPid: 4242,
		childPgid: 4242,
		childInstanceNonce: HEX_1,
		serverReadyFrameSha256: HEX_2,
	} as const;

	const MEASURE_START = {
		schema: "rig-measure-start-request/v1",
		requestSeq: 7,
		executionSha256: HEX_A,
		cohortGrantSha256: HEX_B,
		warmupCompleteSha256: null,
		rigWarmupDrainedReceiptSha256: HEX_3,
	} as const;

	const MEASURE_STARTED = {
		schema: "rig-measure-started-ack/v1",
		responseSeq: 7,
		ackRequestSeq: 7,
		executionSha256: HEX_A,
		rigMeasureStartAckBase64: toBase64(new Uint8Array([9])),
		rigMeasureStartAckSignatureBase64: toBase64(new Uint8Array([8])),
	} as const;

	const STOP = {
		schema: "rig-stop-and-capture-request/v1",
		requestSeq: 11,
		executionSha256: HEX_A,
		cohortStartBarrierSha256: HEX_4,
		macStopIssuedAtNs: "1700000000000000000",
		drainDeadlineMs: 10_000,
	} as const;

	const CAPTURE = {
		schema: "rig-capture-complete-ack/v1",
		responseSeq: 11,
		ackRequestSeq: 11,
		executionSha256: HEX_A,
		snapshotFrameBase64: toBase64(new Uint8Array([1])),
		rigServerSnapshotReceiptBase64: toBase64(new Uint8Array([2])),
		rigServerSnapshotReceiptSignatureBase64: toBase64(new Uint8Array([3])),
		linuxRelayObservationBase64: null,
		rigRelayObservationReceiptBase64: null,
		rigRelayObservationReceiptSignatureBase64: null,
	} as const;

	const ACCEPT_EXECUTION = {
		schema: "rig-accept-execution-request/v1",
		requestSeq: 0,
		measurementGrantBase64: toBase64(new Uint8Array([4])),
		macExecutionGrantReceiptBase64: toBase64(new Uint8Array([5])),
		macExecutionGrantSignatureBase64: toBase64(new Uint8Array([6])),
	} as const;

	const EXECUTION_ACCEPTED = {
		schema: "rig-execution-accepted-ack/v1",
		responseSeq: 0,
		ackRequestSeq: 0,
		executionSha256: HEX_A,
		rigExecutionAcceptanceBase64: toBase64(new Uint8Array([7])),
		rigExecutionAcceptanceSignatureBase64: toBase64(new Uint8Array([8])),
	} as const;

	const SAMPLES = [
		ACCEPT_EXECUTION,
		EXECUTION_ACCEPTED,
		SPAWN,
		READY,
		MEASURE_START,
		MEASURE_STARTED,
		STOP,
		CAPTURE,
	];

	test("every_phase_a_rig_payload_round_trips_through_the_registered_codec", () => {
		for (const sample of SAMPLES) {
			const framed = encodeRegisteredRemotePayload(sample);
			expect(framed.ok).toBe(true);
			if (!framed.ok) continue;
			const decoded = decodeRegisteredRemotePayload(framed.value);
			expect(decoded.ok).toBe(true);
			if (!decoded.ok) continue;
			expect(decoded.value.headerKind).toBe(sample.schema.slice(0, -3));
			const parsed = parsePhaseARigRemotePayload(decoded.value.payload);
			if (!parsed.ok) throw new Error(`${sample.schema}: ${parsed.message}`);
			expect(parsed.value).toEqual(sample);
		}
	});

	test("the_field_table_and_the_declared_key_sets_agree", () => {
		for (const sample of SAMPLES) {
			expect(phaseARigRemotePayloadKeys(sample.schema)).toEqual(
				Object.keys(sample).sort(),
			);
		}
	});

	test("phase_a_rig_payloads_reject_extra_missing_and_ill_typed_keys", () => {
		expect(refusalCode(parsePhaseARigRemotePayload({ ...SPAWN, x: 1 }))).toBe(
			"TRUST_PROTOCOL",
		);
		const { bindPort: _drop, ...missing } = SPAWN;
		expect(parsePhaseARigRemotePayload(missing).ok).toBe(false);
		expect(
			parsePhaseARigRemotePayload({ ...SPAWN, bindAddress: "10.99.0.3" }).ok,
		).toBe(false);
		expect(
			parsePhaseARigRemotePayload({ ...SPAWN, tlsServerName: "elsewhere" }).ok,
		).toBe(false);
		expect(
			parsePhaseARigRemotePayload({ ...SPAWN, transport: "quic" }).ok,
		).toBe(false);
		expect(parsePhaseARigRemotePayload({ ...SPAWN, bindPort: 0 }).ok).toBe(
			false,
		);
		expect(parsePhaseARigRemotePayload({ ...SPAWN, bindPort: 65_536 }).ok).toBe(
			false,
		);
		expect(
			parsePhaseARigRemotePayload({ ...SPAWN, serverArgv: "server.ts" }).ok,
		).toBe(false);
		expect(parsePhaseARigRemotePayload({ ...SPAWN, serverArgv: [] }).ok).toBe(
			false,
		);
		expect(
			parsePhaseARigRemotePayload({ ...SPAWN, serverArgv: ["a", 1] }).ok,
		).toBe(false);
		expect(
			parsePhaseARigRemotePayload({
				...SPAWN,
				stagedServerLaunchRecordBase64: "not base64!!",
			}).ok,
		).toBe(false);
		expect(parsePhaseARigRemotePayload({ ...READY, childPid: 0 }).ok).toBe(
			false,
		);
		expect(
			parsePhaseARigRemotePayload({ ...STOP, macStopIssuedAtNs: "-1" }).ok,
		).toBe(false);
		expect(
			parsePhaseARigRemotePayload({ ...STOP, macStopIssuedAtNs: 1 }).ok,
		).toBe(false);
		expect(
			parsePhaseARigRemotePayload({ ...STOP, drainDeadlineMs: 0 }).ok,
		).toBe(false);
	});

	test("nullable_phase_a_rig_fields_accept_null_but_not_a_wrong_shape", () => {
		expect(
			parsePhaseARigRemotePayload({ ...MEASURE_START, cohortGrantSha256: null })
				.ok,
		).toBe(true);
		expect(
			parsePhaseARigRemotePayload({ ...MEASURE_START, cohortGrantSha256: "" })
				.ok,
		).toBe(false);
		expect(
			parsePhaseARigRemotePayload({
				...CAPTURE,
				linuxRelayObservationBase64: toBase64(new Uint8Array([7])),
			}).ok,
		).toBe(true);
		expect(
			parsePhaseARigRemotePayload({
				...CAPTURE,
				linuxRelayObservationBase64: 7,
			}).ok,
		).toBe(false);
	});

	test("a_cohort_schema_is_not_a_phase_a_rig_schema", () => {
		expect(
			parsePhaseARigRemotePayload({
				schema: "rig-accept-cohort-request/v1",
				requestSeq: 0,
				executionSha256: HEX_A,
				cohortGrantBase64: toBase64(new Uint8Array([1])),
				cohortGrantSignatureBase64: toBase64(new Uint8Array([2])),
			}).ok,
		).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// B3.5: the two child-pipe records that had a registration and nothing else.
//
// `server-warmup-ready/v1` was one line in `PHASE_A_CHILD_SCHEMAS` with no key
// set, no producer and no parser anywhere in the tree, and the rig's Rust
// codec checked two of its five fields because there was nothing to check the
// rest against. `server-bind-execution/v1` carried a cohort grant the server
// child had no way to authenticate; the signature field it now carries is a
// recorded registry edit, and the pairing rule below is why it is one field
// and not two independent optional ones.
// ---------------------------------------------------------------------------

describe("B3.5 child-pipe: the bind and warmup-ready records", () => {
	const PHASE_B_BIND = {
		schema: "server-bind-execution/v1",
		sequence: 0,
		executionSha256: HEX_A,
		rigExecutionAcceptanceSha256: HEX_B,
		cohortGrantBase64: "e30=",
		cohortGrantSignatureBase64: "e30=",
	};

	test("a_phase_b_bind_carries_the_grant_and_the_mac_signature_over_it", () => {
		const parsed = parseServerBindExecution(PHASE_B_BIND);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) throw new Error("unreachable");
		expect(parsed.value.cohortGrantSignatureBase64).toBe("e30=");
	});

	test("a_grant_with_no_signature_is_not_a_bind_this_child_may_act_on", () => {
		// The state the field exists to make unrepresentable: a server child
		// binding a listener under a grant nothing authenticated.
		const unsigned = parseServerBindExecution({
			...PHASE_B_BIND,
			cohortGrantSignatureBase64: null,
		});
		expect(unsigned.ok).toBe(false);
		if (unsigned.ok) throw new Error("unreachable");
		expect(unsigned.code).toBe("FRAME_INVALID");
		// And the mirror: a signature over a grant that is not there.
		expect(
			parseServerBindExecution({ ...PHASE_B_BIND, cohortGrantBase64: null }).ok,
		).toBe(false);
	});

	test("a_bind_missing_the_new_field_entirely_is_refused_on_its_key_set", () => {
		const { cohortGrantSignatureBase64: _dropped, ...withoutField } =
			PHASE_B_BIND;
		expect(parseServerBindExecution(withoutField).ok).toBe(false);
	});

	test("the_warmup_ready_builder_produces_exactly_the_frozen_key_set", () => {
		const built = buildServerWarmupReady({
			sequence: 1,
			executionSha256: HEX_A,
			cohortWarmupEpochSha256: HEX_B,
		});
		expect(built.ok).toBe(true);
		if (!built.ok) throw new Error("unreachable");
		expect(Object.keys(built.value).sort()).toEqual([
			"cohortWarmupEpochSha256",
			"executionSha256",
			"schema",
			"sequence",
			"warmupCountersZero",
		]);
		expect(built.value.warmupCountersZero).toBe(true);
		// Producer and parser are the same key set, checked by round trip
		// rather than by two hand-written lists that can drift apart.
		expect(parseServerWarmupReady(built.value).ok).toBe(true);
	});

	test("a_warmup_ready_declaring_dirty_counters_is_a_state_failure", () => {
		const dirty = parseServerWarmupReady({
			schema: "server-warmup-ready/v1",
			sequence: 1,
			executionSha256: HEX_A,
			cohortWarmupEpochSha256: HEX_B,
			warmupCountersZero: false,
		});
		expect(dirty.ok).toBe(false);
		if (dirty.ok) throw new Error("unreachable");
		// Not `FRAME_INVALID`: the frame is well formed and the child is
		// reporting an illegal state, and §7 maps the two differently.
		expect(dirty.code).toBe("STATE_INVALID");
		expect(mapChildRefusalToIndexCode("STATE_INVALID")).toBe("TRUST_PROTOCOL");
	});

	test("a_warmup_ready_with_an_extra_or_missing_key_is_refused", () => {
		const honest = {
			schema: "server-warmup-ready/v1",
			sequence: 1,
			executionSha256: HEX_A,
			cohortWarmupEpochSha256: HEX_B,
			warmupCountersZero: true,
		};
		expect(parseServerWarmupReady({ ...honest, extra: 1 }).ok).toBe(false);
		const { sequence: _dropped, ...short } = honest;
		expect(parseServerWarmupReady(short).ok).toBe(false);
		expect(
			parseServerWarmupReady({ ...honest, cohortWarmupEpochSha256: "nope" }).ok,
		).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// B3.5 R3 S3: the remote registry edits.
//
// Three things land here and they fail differently, so they are tested
// differently: a *widening* of the shared field-spec union (which every
// Phase-A rig frame already depends on, so it carries its own regression
// assertion), two *registrations* of key sets the plan froze and the registry
// never carried, and one recorded *registry edit* to a frame that already
// existed.
//
// The pinned hex is the half that cannot be replaced by an equality between
// two functions. The failure the pins exist to catch is two correct-looking
// encoders that disagree about a byte -- a key order, a null, a header kind --
// which every round-trip test in this file passes straight through.
// ---------------------------------------------------------------------------

const S3_B = (n: number) => toBase64(new Uint8Array([n]));

const TEARDOWN_REQUEST = {
	schema: "rig-teardown-server-request/v1",
	requestSeq: 13,
	executionSha256: HEX_A,
} as const;

const SERVER_STOPPED = {
	schema: "rig-server-stopped-ack/v1",
	responseSeq: 13,
	ackRequestSeq: 13,
	executionSha256: HEX_A,
	exitCode: 0,
	signal: null,
	reaped: true,
} as const;

const MAC_OBSERVATION = {
	schema: "mac-present-rig-observation-request/v1",
	requestSeq: 15,
	executionSha256: HEX_A,
	rigExecutionAcceptanceBase64: S3_B(1),
	rigExecutionAcceptanceSignatureBase64: S3_B(2),
	rigMeasureStartAckBase64: S3_B(3),
	rigMeasureStartAckSignatureBase64: S3_B(4),
	rigBarrierAcceptanceBase64: S3_B(5),
	rigBarrierAcceptanceSignatureBase64: S3_B(6),
	serverWarmupDrainedBase64: S3_B(7),
	serverStartBarrierAcceptedBase64: S3_B(8),
	snapshotFrameBase64: S3_B(9),
	rigServerSnapshotReceiptBase64: S3_B(10),
	rigServerSnapshotReceiptSignatureBase64: S3_B(11),
	linuxRelayObservationBase64: null,
	rigRelayObservationReceiptBase64: null,
	rigRelayObservationReceiptSignatureBase64: null,
	// Registry edit (d)'s five derived records. Present here because this is
	// the cohort shape of the frame; the null shape is exercised below.
	orderedPartialManifestBase64: S3_B(12),
	observedProcessProofBase64: S3_B(13),
	cohortRateSeriesBase64: S3_B(14),
	cohortLedgerBase64: S3_B(15),
	cohortCapacityBase64: S3_B(16),
} as const;

const MAC_ADMISSION = {
	schema: "mac-measurement-admission-issued-ack/v1",
	responseSeq: 15,
	ackRequestSeq: 15,
	executionSha256: HEX_A,
	macMeasurementAdmissionReceiptBase64: S3_B(1),
	macMeasurementAdmissionSignatureBase64: S3_B(2),
	cohortAdmissionReceiptBase64: null,
	cohortAdmissionSignatureBase64: null,
} as const;

const ACCEPT_COHORT_WITH_ACCEPTANCE = {
	schema: "rig-accept-cohort-request/v1",
	requestSeq: 1,
	executionSha256: HEX_A,
	cohortGrantBase64: "e30=",
	cohortGrantSignatureBase64: "e30=",
	rigExecutionAcceptanceBase64: "e30=",
	rigExecutionAcceptanceSignatureBase64: "e30=",
} as const;

const CAPTURE_ACK_BASE64 = {
	schema: "server-capture-ack/v1",
	sequence: 5,
	executionSha256: HEX_A,
	snapshotFrameBase64: S3_B(9),
	linuxRelayObservationBase64: null,
} as const;

/**
 * The bytes the Rust halves must decode, pinned so neither language can move
 * alone. Produced by this file's own encoder and consumed by S5-RIG
 * (`rig-teardown-server-request/v1`, `rig-server-stopped-ack/v1`,
 * `rig-accept-cohort-request/v1`) and S5-MAC-RS (the two `mac-*` frames).
 */
const S3_PINNED_REMOTE_FRAME_HEX: Readonly<Record<string, string>> = {
	"rig-teardown-server-request/v1":
		"000000517b226b696e64223a227269672d74656172646f776e2d7365727665722d72657175657374222c22736368656d61223a22636f6d70617269736f6e2d73757065727669736f722d6672616d652f7631227d0a00000000000000917b22657865637574696f6e536861323536223a2261616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161222c2272657175657374536571223a31332c22736368656d61223a227269672d74656172646f776e2d7365727665722d726571756573742f7631227d0a49a527e365411ed2b49144fa417fb26bbbb0d5c38e0fa13c3ba1ad74507da6eb",
	"rig-server-stopped-ack/v1":
		"0000004c7b226b696e64223a227269672d7365727665722d73746f707065642d61636b222c22736368656d61223a22636f6d70617269736f6e2d73757065727669736f722d6672616d652f7631227d0a00000000000000c97b2261636b52657175657374536571223a31332c22657865637574696f6e536861323536223a2261616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161222c2265786974436f6465223a302c22726561706564223a747275652c22726573706f6e7365536571223a31332c22736368656d61223a227269672d7365727665722d73746f707065642d61636b2f7631222c227369676e616c223a6e756c6c7d0acfd9d274fb388a8eaf06471cbd0757743c24b2a08e2e0ee2d9b6e9f5c30c497c",
	"mac-measurement-admission-issued-ack/v1":
		"0000005a7b226b696e64223a226d61632d6d6561737572656d656e742d61646d697373696f6e2d6973737565642d61636b222c22736368656d61223a22636f6d70617269736f6e2d73757065727669736f722d6672616d652f7631227d0a00000000000001567b2261636b52657175657374536571223a31352c22636f686f727441646d697373696f6e52656365697074426173653634223a6e756c6c2c22636f686f727441646d697373696f6e5369676e6174757265426173653634223a6e756c6c2c22657865637574696f6e536861323536223a2261616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161222c226d61634d6561737572656d656e7441646d697373696f6e52656365697074426173653634223a2241513d3d222c226d61634d6561737572656d656e7441646d697373696f6e5369676e6174757265426173653634223a2241673d3d222c22726573706f6e7365536571223a31352c22736368656d61223a226d61632d6d6561737572656d656e742d61646d697373696f6e2d6973737565642d61636b2f7631227d0a118ec663e777be7cecf09066dd93dbe93def8dd5456ed9e9c9d33a641e1806b6",
	"rig-accept-cohort-request/v1":
		"0000004f7b226b696e64223a227269672d6163636570742d636f686f72742d72657175657374222c22736368656d61223a22636f6d70617269736f6e2d73757065727669736f722d6672616d652f7631227d0a00000000000001227b22636f686f72744772616e74426173653634223a226533303d222c22636f686f72744772616e745369676e6174757265426173653634223a226533303d222c22657865637574696f6e536861323536223a2261616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161222c2272657175657374536571223a312c22726967457865637574696f6e416363657074616e6365426173653634223a226533303d222c22726967457865637574696f6e416363657074616e63655369676e6174757265426173653634223a226533303d222c22736368656d61223a227269672d6163636570742d636f686f72742d726571756573742f7631227d0a086cfd430284b746eb187ca91b232fca30fa21a947677f7d228ec9e27e859efa",
};

/** The child-pipe half of the same set: §1.3's base64 `server-capture-ack/v1`. */
const S3_PINNED_CAPTURE_ACK_HEX =
	"000000c57b22657865637574696f6e536861323536223a2261616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161222c226c696e757852656c61794f62736572766174696f6e426173653634223a6e756c6c2c22736368656d61223a227365727665722d636170747572652d61636b2f7631222c2273657175656e6365223a352c22736e617073686f744672616d65426173653634223a2243513d3d227d0a";

function s3Frame(payload: Record<string, unknown> & { schema: string }) {
	const encoded = encodeRegisteredRemotePayload(payload);
	if (!encoded.ok) throw new Error(`encode ${payload.schema}: ${encoded.code}`);
	return encoded.value;
}

describe("B3.5 R3 S3: the shared Phase-A field-spec union", () => {
	/**
	 * One accepting and one refusing value per kind that existed before the
	 * widening. A widening that changed a kind's reading would move a verdict
	 * here rather than showing up as a frame that parses in one language.
	 */
	const EXISTING_KIND_CASES: readonly {
		readonly spec: PhaseARemoteFieldSpec;
		readonly accepts: readonly unknown[];
		readonly refuses: readonly unknown[];
	}[] = [
		{ spec: { kind: "seq" }, accepts: [0, 7], refuses: [-1, 1.5, "0", null] },
		{
			spec: { kind: "positiveInt" },
			accepts: [1, 65_535],
			refuses: [0, -1, 1.5, null],
		},
		{ spec: { kind: "sha256" }, accepts: [HEX_A], refuses: [null, "", "ab"] },
		{
			spec: { kind: "sha256OrNull" },
			accepts: [HEX_A, null],
			refuses: ["", "ab", 0],
		},
		{ spec: { kind: "base64" }, accepts: ["e30="], refuses: [null, "", "a"] },
		{
			spec: { kind: "base64OrNull" },
			accepts: ["e30=", null],
			refuses: ["", "a", 0],
		},
		{
			spec: { kind: "nsString" },
			accepts: ["0", "1700000000000000000"],
			refuses: ["01", "", null, 0],
		},
		{
			spec: { kind: "port" },
			accepts: [1, 65_535],
			refuses: [0, 65_536, null, "80"],
		},
		{
			spec: { kind: "argv" },
			accepts: [["server.ts"]],
			refuses: [[], "server.ts", null, ["a", 1]],
		},
		{
			spec: { kind: "literal", value: "10.99.0.2" },
			accepts: ["10.99.0.2"],
			refuses: ["10.99.0.3", null, true],
		},
		{
			spec: { kind: "oneOf", values: ["ws", "wt"] },
			accepts: ["ws", "wt"],
			refuses: ["quic", null, 0],
		},
	];

	test("the_eleven_existing_field_kinds_are_unchanged_by_the_widening", () => {
		// Eleven before, three added, fourteen after -- asserted as a count so a
		// fourth kind cannot arrive without this test being read again.
		expect(EXISTING_KIND_CASES.length).toBe(11);
		expect(PHASE_A_REMOTE_FIELD_KINDS.length).toBe(14);
		const added: readonly string[] = [
			"intOrNull",
			"stringOrNull",
			"literalBoolean",
		];
		expect(
			PHASE_A_REMOTE_FIELD_KINDS.filter((kind) => !added.includes(kind)).length,
		).toBe(11);
		const declaredKinds: readonly string[] = PHASE_A_REMOTE_FIELD_KINDS;
		for (const kind of added) {
			expect(declaredKinds).toContain(kind);
		}
		for (const kindCase of EXISTING_KIND_CASES) {
			expect(PHASE_A_REMOTE_FIELD_KINDS).toContain(kindCase.spec.kind);
			for (const value of kindCase.accepts) {
				expect(phaseARemoteFieldOk(kindCase.spec, value)).toBe(true);
			}
			for (const value of kindCase.refuses) {
				expect(phaseARemoteFieldOk(kindCase.spec, value)).toBe(false);
			}
		}
	});

	test("the_three_added_kinds_read_the_plans_types_and_nothing_wider", () => {
		// `exitCode: number | null` (plan 929) is an integer, so a float and a
		// numeric string are both refusals.
		expect(phaseARemoteFieldOk({ kind: "intOrNull" }, 0)).toBe(true);
		expect(phaseARemoteFieldOk({ kind: "intOrNull" }, 143)).toBe(true);
		expect(phaseARemoteFieldOk({ kind: "intOrNull" }, null)).toBe(true);
		expect(phaseARemoteFieldOk({ kind: "intOrNull" }, 1.5)).toBe(false);
		expect(phaseARemoteFieldOk({ kind: "intOrNull" }, "0")).toBe(false);
		expect(phaseARemoteFieldOk({ kind: "intOrNull" }, undefined)).toBe(false);
		// `signal: string | null` (plan 933) is a signal name: bounded, and an
		// empty string is not one.
		expect(phaseARemoteFieldOk({ kind: "stringOrNull" }, "SIGTERM")).toBe(true);
		expect(phaseARemoteFieldOk({ kind: "stringOrNull" }, null)).toBe(true);
		expect(phaseARemoteFieldOk({ kind: "stringOrNull" }, "")).toBe(false);
		expect(
			phaseARemoteFieldOk({ kind: "stringOrNull" }, "x".repeat(4_097)),
		).toBe(false);
		expect(phaseARemoteFieldOk({ kind: "stringOrNull" }, 15)).toBe(false);
		// `reaped: true` is a boolean literal, which `literal` cannot express:
		// its `value` is a string, so the string "true" is not the boolean.
		expect(
			phaseARemoteFieldOk({ kind: "literalBoolean", value: true }, true),
		).toBe(true);
		expect(
			phaseARemoteFieldOk({ kind: "literalBoolean", value: true }, false),
		).toBe(false);
		expect(
			phaseARemoteFieldOk({ kind: "literalBoolean", value: true }, "true"),
		).toBe(false);
		expect(
			phaseARemoteFieldOk({ kind: "literalBoolean", value: true }, 1),
		).toBe(false);
		expect(phaseARemoteFieldOk({ kind: "literal", value: "true" }, true)).toBe(
			false,
		);
	});

	test("the_shared_field_spec_validates_both_tables_identically", () => {
		// The two tables are two key sets over one union and one validator. The
		// test that matters is not "each table parses its own frames" -- it is
		// that a kind used in both tables cannot be read two ways, which is what
		// a second copy of the union would eventually produce.
		const probes: readonly unknown[] = [
			null,
			"e30=",
			"",
			"not base64!!",
			0,
			-1,
			1.5,
			true,
			"SIGTERM",
			HEX_A,
			[],
		];
		const rigSpecs = new Map<string, PhaseARemoteFieldSpec>();
		for (const schema of PHASE_A_RIG_REMOTE_SCHEMAS) {
			for (const field of phaseARigRemotePayloadKeys(schema)) {
				if (field === "schema") continue;
				const spec = phaseARigRemoteFieldSpec(schema, field);
				if (spec === null) throw new Error(`${schema}.${field} has no spec`);
				rigSpecs.set(spec.kind, spec);
			}
		}
		let shared = 0;
		for (const schema of PHASE_A_MAC_REMOTE_SCHEMAS) {
			for (const field of phaseAMacRemotePayloadKeys(schema)) {
				if (field === "schema") continue;
				const macSpec = phaseAMacRemoteFieldSpec(schema, field);
				if (macSpec === null) throw new Error(`${schema}.${field} has no spec`);
				expect(PHASE_A_REMOTE_FIELD_KINDS).toContain(macSpec.kind);
				const rigSpec = rigSpecs.get(macSpec.kind);
				if (rigSpec === undefined) continue;
				shared += 1;
				for (const probe of probes) {
					expect(phaseARemoteFieldOk(macSpec, probe)).toBe(
						phaseARemoteFieldOk(rigSpec, probe),
					);
				}
			}
		}
		// Every Mac field's kind is one the rig table already uses, which is why
		// items 7-9 invent no field kind. A zero here would make the loop above
		// vacuous. Twenty-three at wave 1; edit (d)'s five derived records and
		// the two frames §2.9(2c) un-defers add ten more Mac fields whose kinds
		// the rig table already uses, which is the same property restated at a
		// larger size, not a widening.
		expect(shared).toBe(38);
	});

	test("a_null_base64_field_is_accepted_only_where_the_plan_allows_it", () => {
		// Nullable is a property of the field, not of the parser's mood. Walked
		// exhaustively over both tables so a field that quietly became nullable
		// fails here rather than admitting a missing record as evidence.
		const nullable: string[] = [];
		const walk = (
			schemas: readonly string[],
			keys: (schema: never) => readonly string[],
			specOf: (schema: never, field: string) => PhaseARemoteFieldSpec | null,
		) => {
			for (const schema of schemas) {
				for (const field of keys(schema as never)) {
					if (field === "schema") continue;
					const spec = specOf(schema as never, field);
					if (spec === null) throw new Error(`${schema}.${field} has no spec`);
					const allowsNull = phaseARemoteFieldOk(spec, null);
					expect(allowsNull).toBe(spec.kind.endsWith("OrNull"));
					if (allowsNull) nullable.push(`${schema}.${field}`);
				}
			}
		};
		walk(
			PHASE_A_RIG_REMOTE_SCHEMAS,
			phaseARigRemotePayloadKeys as never,
			phaseARigRemoteFieldSpec as never,
		);
		walk(
			PHASE_A_MAC_REMOTE_SCHEMAS,
			phaseAMacRemotePayloadKeys as never,
			phaseAMacRemoteFieldSpec as never,
		);
		// The plan's nine on the two Mac frames (697-725): seven on the
		// observation request, two on the admission ack -- plus registry edit
		// (d)'s five derived records, which are nullable for the same reason
		// the other seven are: this is a Phase-A frame and an execution with no
		// cohort has no such record. The two frames §2.9(2c) un-defers add
		// none: every field on both is required.
		const macNullable = nullable.filter((name) => name.startsWith("mac-"));
		expect(macNullable.length).toBe(14);
		expect(
			macNullable.filter((name) =>
				name.startsWith("mac-present-rig-observation-request/v1."),
			).length,
		).toBe(12);
		expect(
			macNullable.filter(
				(name) =>
					name.startsWith("mac-open-execution-request/v1.") ||
					name.startsWith("mac-execution-opened-ack/v1."),
			).length,
		).toBe(0);
		// And the parse arm agrees with the table: null where allowed, refused
		// where not.
		expect(parsePhaseAMacRemotePayload(MAC_OBSERVATION).ok).toBe(true);
		expect(
			parsePhaseAMacRemotePayload({
				...MAC_OBSERVATION,
				snapshotFrameBase64: null,
			}).ok,
		).toBe(false);
		expect(
			parsePhaseAMacRemotePayload({
				...MAC_ADMISSION,
				macMeasurementAdmissionReceiptBase64: null,
			}).ok,
		).toBe(false);
		// `signal: null` is legal; `exitCode` missing entirely is not.
		expect(parsePhaseARigRemotePayload(SERVER_STOPPED).ok).toBe(true);
		const { exitCode: _dropped, ...noExitCode } = SERVER_STOPPED;
		expect(parsePhaseARigRemotePayload(noExitCode).ok).toBe(false);
	});
});

describe("B3.5 R3 S3: the teardown pair and the Phase-A Mac table", () => {
	test("the_teardown_frames_round_trip_exactly", () => {
		for (const sample of [TEARDOWN_REQUEST, SERVER_STOPPED]) {
			expect(phaseARigRemotePayloadKeys(sample.schema)).toEqual(
				Object.keys(sample).sort(),
			);
			const decoded = decodeRegisteredRemotePayload(s3Frame(sample));
			expect(decoded.ok).toBe(true);
			if (!decoded.ok) throw new Error("unreachable");
			expect(decoded.value.headerKind).toBe(sample.schema.slice(0, -3));
			const parsed = parsePhaseARigRemotePayload(decoded.value.payload);
			if (!parsed.ok) throw new Error(`${sample.schema}: ${parsed.message}`);
			expect(parsed.value).toEqual(sample);
		}
		// `reaped` is the ack's claim, so `false` is not a smaller version of it.
		expect(
			parsePhaseARigRemotePayload({ ...SERVER_STOPPED, reaped: false }).ok,
		).toBe(false);
		expect(
			parsePhaseARigRemotePayload({ ...SERVER_STOPPED, reaped: "true" }).ok,
		).toBe(false);
		expect(
			parsePhaseARigRemotePayload({ ...SERVER_STOPPED, signal: "SIGTERM" }).ok,
		).toBe(true);
		expect(
			parsePhaseARigRemotePayload({ ...SERVER_STOPPED, exitCode: null }).ok,
		).toBe(true);
		expect(
			parsePhaseARigRemotePayload({ ...SERVER_STOPPED, exitCode: 1.5 }).ok,
		).toBe(false);
		expect(
			parsePhaseARigRemotePayload({ ...TEARDOWN_REQUEST, extra: 1 }).ok,
		).toBe(false);
	});

	test("the_phase_a_mac_frames_round_trip_exactly", () => {
		for (const sample of [MAC_OBSERVATION, MAC_ADMISSION]) {
			expect(phaseAMacRemotePayloadKeys(sample.schema)).toEqual(
				Object.keys(sample).sort(),
			);
			const decoded = decodeRegisteredRemotePayload(s3Frame(sample));
			expect(decoded.ok).toBe(true);
			if (!decoded.ok) throw new Error("unreachable");
			expect(decoded.value.headerKind).toBe(sample.schema.slice(0, -3));
			const parsed = parsePhaseAMacRemotePayload(decoded.value.payload);
			if (!parsed.ok) throw new Error(`${sample.schema}: ${parsed.message}`);
			expect(parsed.value).toEqual(sample);
		}
		expect(parsePhaseAMacRemotePayload({ ...MAC_ADMISSION, extra: 1 }).ok).toBe(
			false,
		);
		// The two tables are disjoint and neither admits the other's kinds.
		expect(parsePhaseAMacRemotePayload(TEARDOWN_REQUEST).ok).toBe(false);
		expect(parsePhaseARigRemotePayload(MAC_ADMISSION).ok).toBe(false);
	});

	test("the_four_registered_kinds_are_phase_a_and_bounded_at_the_default", () => {
		// Registration, not widening: all four names were already in the §3.3
		// schema list with nothing behind them, so the list is unchanged and
		// only the machinery is new.
		for (const schema of [
			...PHASE_A_RIG_REMOTE_SCHEMAS,
			...PHASE_A_MAC_REMOTE_SCHEMAS,
		]) {
			expect(PHASE_A_REMOTE_PAYLOAD_SCHEMAS).toContain(schema);
			expect(remotePayloadBoundForSchema(schema)).toBe(
				CAPS.remotePayloadDefault,
			);
		}
		// Eight at wave 3; amendment C4 registers the rig's Phase-A open pair
		// (`rig-accept-execution-request/v1`, `rig-execution-accepted-ack/v1`)
		// that base plan 760-773 named and nothing sent, and makes it ten.
		expect(PHASE_A_RIG_REMOTE_SCHEMAS.length).toBe(10);
		// Two at wave 1; §2.9(2c) un-defers `mac-open-execution-request/v1` and
		// `mac-execution-opened-ack/v1` and makes it four.
		expect(PHASE_A_MAC_REMOTE_SCHEMAS.length).toBe(4);
		expect(
			new Set([...PHASE_A_RIG_REMOTE_SCHEMAS, ...PHASE_A_MAC_REMOTE_SCHEMAS])
				.size,
		).toBe(14);
	});

	test("the_accept_cohort_request_carries_the_per_execution_acceptance", () => {
		// §2.13's recorded registry edit. One rig process serves the campaign, so
		// the acceptance has to travel per execution or executions 2-4 are refused
		// on a binding taken at process start.
		const decoded = decodeRegisteredRemotePayload(
			s3Frame(ACCEPT_COHORT_WITH_ACCEPTANCE),
		);
		expect(decoded.ok).toBe(true);
		if (!decoded.ok) throw new Error("unreachable");
		const parsed = parseCohortRemotePayload(decoded.value.payload);
		if (!parsed.ok) throw new Error(parsed.message);
		expect(parsed.value).toEqual(ACCEPT_COHORT_WITH_ACCEPTANCE);
		expect(cohortRemotePayloadKeys("rig-accept-cohort-request/v1")).toEqual(
			Object.keys(ACCEPT_COHORT_WITH_ACCEPTANCE).sort(),
		);
		// The pre-edit four-key frame is now short, and a short frame is a
		// refusal rather than a frame with an absent binding.
		const {
			rigExecutionAcceptanceBase64: _a,
			rigExecutionAcceptanceSignatureBase64: _b,
			...preEdit
		} = ACCEPT_COHORT_WITH_ACCEPTANCE;
		expect(parseCohortRemotePayload(preEdit).ok).toBe(false);
		// The pair is not nullable: an execution with no acceptance has no
		// business asking the rig to accept a cohort.
		expect(
			parseCohortRemotePayload({
				...ACCEPT_COHORT_WITH_ACCEPTANCE,
				rigExecutionAcceptanceBase64: null,
			}).ok,
		).toBe(false);
	});

	test("the_pinned_teardown_frame_is_the_one_the_rust_dispatch_matches", () => {
		// The forward half of the cross-language pair. The Rust dispatch matches
		// on `header.kind` -- the schema with the terminal `/v1` removed -- so
		// both the header and the canonical body are pinned, not just the body.
		const byName: Readonly<
			Record<string, Record<string, unknown> & { schema: string }>
		> = {
			"rig-teardown-server-request/v1": TEARDOWN_REQUEST,
			"rig-server-stopped-ack/v1": SERVER_STOPPED,
			// `mac-present-rig-observation-request/v1` is not here: registry
			// edit (d) changed its key set, so its pin lives with the other
			// r8 vectors rather than being maintained in two places.
			"mac-measurement-admission-issued-ack/v1": MAC_ADMISSION,
			"rig-accept-cohort-request/v1": ACCEPT_COHORT_WITH_ACCEPTANCE,
		};
		expect(Object.keys(S3_PINNED_REMOTE_FRAME_HEX).sort()).toEqual(
			Object.keys(byName).sort(),
		);
		for (const [schema, hex] of Object.entries(S3_PINNED_REMOTE_FRAME_HEX)) {
			const payload = byName[schema];
			if (payload === undefined) throw new Error(`no sample for ${schema}`);
			expect(Buffer.from(s3Frame(payload)).toString("hex")).toBe(hex);
			const decoded = decodeRegisteredRemotePayload(
				new Uint8Array(Buffer.from(hex, "hex")),
			);
			expect(decoded.ok).toBe(true);
			if (!decoded.ok) throw new Error("unreachable");
			expect(decoded.value.headerKind).toBe(schema.slice(0, -3));
		}
	});

	test("the_capture_ack_carries_base64_and_agrees_with_the_capture_complete_ack", () => {
		// §1.3's registry edit, from S3's side: the child-pipe ack and the remote
		// ack one hop later now carry the same two base64 fields, so the rig
		// digests the bytes it received instead of re-canonicalizing a parse.
		// The key set itself is S1's file; this is the pinned vector S1, S5-RIG
		// and S6 assert against, plus the shape agreement that motivated it.
		const encoded = encodeChildPipeFrame(CAPTURE_ACK_BASE64);
		expect(encoded.ok).toBe(true);
		if (!encoded.ok) throw new Error("unreachable");
		expect(Buffer.from(encoded.value).toString("hex")).toBe(
			S3_PINNED_CAPTURE_ACK_HEX,
		);
		for (const field of [
			"snapshotFrameBase64",
			"linuxRelayObservationBase64",
		]) {
			expect(Object.keys(CAPTURE_ACK_BASE64)).toContain(field);
			expect(
				phaseARigRemoteFieldSpec("rig-capture-complete-ack/v1", field),
			).not.toBeNull();
		}
		// Nested records are what the edit deleted: a `snapshotFrame` object on
		// this frame would be the re-canonicalization hazard back again.
		expect(Object.keys(CAPTURE_ACK_BASE64)).not.toContain("snapshotFrame");
		expect(Object.keys(CAPTURE_ACK_BASE64)).not.toContain(
			"linuxRelayObservation",
		);
	});
});

// ---------------------------------------------------------------------------
// B3.5 R3.5 S3-r8: revision 8/9's registry edits.
//
// Four edits and one shrink, each because a mint the design assigns to the Mac
// binary has an input no frozen frame carried, or an output no frame returned:
//
//   (c) `mac-export-warmup-completion-manifest-request/v1` gains the ordered
//       child `role-warmup-complete/v1` bytes, through a new `base64Array`
//       kind in `CohortRemoteFieldKind` -- not in `PhaseARemoteFieldSpec`,
//       which stays at fourteen kinds and is asserted so above;
//   (d) `mac-present-rig-observation-request/v1` gains the five derived cohort
//       records the admission receipt binds;
//   (e) `mac-export-cohort-evidence-request/v1` gains the role-child evidence
//       bundle and takes plan 529's 14/9 pair, and the ack drops the evidence
//       bytes and shrinks to a signed receipt at 8 KiB;
//   (g) `mac-open-cohort-request/v1` gains the token-commitment leaf manifest,
//       because minting stays in the controller and only commitments travel.
//
// Plus the two `PHASE_A_MAC_FIELDS` entries §2.9(2c) un-defers, and the budget
// accumulator that makes `COHORT_REMOTE_EVIDENCE_BUDGET_MAX_BYTES` mean
// something for the first time.
// ---------------------------------------------------------------------------

const OPEN_COHORT_WITH_MANIFEST = {
	schema: "mac-open-cohort-request/v1",
	requestSeq: 0,
	executionSha256: HEX_A,
	scenarioHash: HEX_1,
	rolePlanHash: HEX_2,
	workloadRolePlanInputBase64: S3_B(1),
	workloadRolePlanInputSha256: HEX_3,
	workloadRolePlanInputSize: 1,
	tokenCommitmentLeafManifestBase64: S3_B(2),
	publishersBase64: S3_B(3),
	subscriberShardsBase64: S3_B(4),
	tokenCommitmentLeafManifestSha256: HEX_4,
} as const;

const WARMUP_MANIFEST_EXPORT = {
	schema: "mac-export-warmup-completion-manifest-request/v1",
	requestSeq: 6,
	executionSha256: HEX_A,
	cohortWarmupEpochSha256: HEX_B,
	roleWarmupCompletesBase64: [S3_B(1), S3_B(2), S3_B(3)],
} as const;

const EXPORT_EVIDENCE_REQUEST = {
	schema: "mac-export-cohort-evidence-request/v1",
	requestSeq: 10,
	executionSha256: HEX_A,
	cohortAdmissionReceiptSha256: HEX_B,
	roleChildEvidenceBundleBase64: S3_B(4),
} as const;

const EVIDENCE_EXPORTED_ACK = {
	schema: "mac-cohort-evidence-exported-ack/v1",
	responseSeq: 10,
	ackRequestSeq: 10,
	executionSha256: HEX_A,
	cohortObservationEvidenceSha256: HEX_B,
	cohortObservationEvidenceSize: 6,
	cohortObservationEvidenceSignatureBase64: S3_B(5),
	terminalExport: true,
} as const;

const MAC_OPEN_EXECUTION = {
	schema: "mac-open-execution-request/v1",
	requestSeq: 0,
	executionDraftSha256: HEX_A,
	executionDraftBase64: S3_B(1),
} as const;

const MAC_EXECUTION_OPENED = {
	schema: "mac-execution-opened-ack/v1",
	responseSeq: 0,
	ackRequestSeq: 0,
	executionSha256: HEX_B,
	executionDraftBase64: S3_B(1),
	measurementGrantBase64: S3_B(2),
	macExecutionGrantReceiptBase64: S3_B(3),
	macExecutionGrantSignatureBase64: S3_B(4),
} as const;

/**
 * Seven of S3-r8's nine vectors. The other two are the per-cell
 * `token-commitment-leaf-manifest/v1` pair below, which is a record rather
 * than a frame and is pinned by digest for the reason stated there.
 */
const S3_R8_PINNED_REMOTE_FRAME_HEX: Readonly<Record<string, string>> = {
	"mac-open-cohort-request/v1":
		"0000004d7b226b696e64223a226d61632d6f70656e2d636f686f72742d72657175657374222c22736368656d61223a22636f6d70617269736f6e2d73757065727669736f722d6672616d652f7631227d0a00000000000002a07b22657865637574696f6e536861323536223a2261616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161222c227075626c697368657273426173653634223a2241773d3d222c2272657175657374536571223a302c22726f6c65506c616e48617368223a2232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232222c227363656e6172696f48617368223a2231313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131222c22736368656d61223a226d61632d6f70656e2d636f686f72742d726571756573742f7631222c2273756273637269626572536861726473426173653634223a2242413d3d222c22746f6b656e436f6d6d69746d656e744c6561664d616e6966657374426173653634223a2241673d3d222c22746f6b656e436f6d6d69746d656e744c6561664d616e6966657374536861323536223a2234343434343434343434343434343434343434343434343434343434343434343434343434343434343434343434343434343434343434343434343434343434222c22776f726b6c6f6164526f6c65506c616e496e707574426173653634223a2241513d3d222c22776f726b6c6f6164526f6c65506c616e496e707574536861323536223a2233333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333222c22776f726b6c6f6164526f6c65506c616e496e70757453697a65223a317d0a3f151e30a77e10cde54dbd19a15ac1144aafbb8d2129d91ae0c327598ebf5169",
	"mac-export-warmup-completion-manifest-request/v1":
		"000000637b226b696e64223a226d61632d6578706f72742d7761726d75702d636f6d706c6574696f6e2d6d616e69666573742d72657175657374222c22736368656d61223a22636f6d70617269736f6e2d73757065727669736f722d6672616d652f7631227d0a00000000000001327b22636f686f72745761726d757045706f6368536861323536223a2262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262222c22657865637574696f6e536861323536223a2261616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161222c2272657175657374536571223a362c22726f6c655761726d7570436f6d706c65746573426173653634223a5b2241513d3d222c2241673d3d222c2241773d3d225d2c22736368656d61223a226d61632d6578706f72742d7761726d75702d636f6d706c6574696f6e2d6d616e69666573742d726571756573742f7631227d0a37f8bca60ba5492ee0b9797a1db5e6d658d3f07faa0afc8d0119bb72193e56d0",
	"mac-present-rig-observation-request/v1":
		"000000597b226b696e64223a226d61632d70726573656e742d7269672d6f62736572766174696f6e2d72657175657374222c22736368656d61223a22636f6d70617269736f6e2d73757065727669736f722d6672616d652f7631227d0a000000000000036f7b22636f686f72744361706163697479426173653634223a2245413d3d222c22636f686f72744c6564676572426173653634223a2244773d3d222c22636f686f727452617465536572696573426173653634223a2244673d3d222c22657865637574696f6e536861323536223a2261616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161222c226c696e757852656c61794f62736572766174696f6e426173653634223a6e756c6c2c226f6273657276656450726f6365737350726f6f66426173653634223a2244513d3d222c226f7264657265645061727469616c4d616e6966657374426173653634223a2244413d3d222c2272657175657374536571223a31352c2272696742617272696572416363657074616e6365426173653634223a2242513d3d222c2272696742617272696572416363657074616e63655369676e6174757265426173653634223a2242673d3d222c22726967457865637574696f6e416363657074616e6365426173653634223a2241513d3d222c22726967457865637574696f6e416363657074616e63655369676e6174757265426173653634223a2241673d3d222c227269674d656173757265537461727441636b426173653634223a2241773d3d222c227269674d656173757265537461727441636b5369676e6174757265426173653634223a2242413d3d222c2272696752656c61794f62736572766174696f6e52656365697074426173653634223a6e756c6c2c2272696752656c61794f62736572766174696f6e526563656970745369676e6174757265426173653634223a6e756c6c2c22726967536572766572536e617073686f7452656365697074426173653634223a2243673d3d222c22726967536572766572536e617073686f74526563656970745369676e6174757265426173653634223a2243773d3d222c22736368656d61223a226d61632d70726573656e742d7269672d6f62736572766174696f6e2d726571756573742f7631222c227365727665725374617274426172726965724163636570746564426173653634223a2243413d3d222c227365727665725761726d7570447261696e6564426173653634223a2242773d3d222c22736e617073686f744672616d65426173653634223a2243513d3d227d0aab4b0da4529d80573b719394e26a4b1b656dc929c9e38e2832567690bf7b78a4",
	"mac-export-cohort-evidence-request/v1":
		"000000587b226b696e64223a226d61632d6578706f72742d636f686f72742d65766964656e63652d72657175657374222c22736368656d61223a22636f6d70617269736f6e2d73757065727669736f722d6672616d652f7631227d0a00000000000001217b22636f686f727441646d697373696f6e52656365697074536861323536223a2262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262222c22657865637574696f6e536861323536223a2261616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161222c2272657175657374536571223a31302c22726f6c654368696c6445766964656e636542756e646c65426173653634223a2242413d3d222c22736368656d61223a226d61632d6578706f72742d636f686f72742d65766964656e63652d726571756573742f7631227d0aa9164d8fd05d2fc70eefacefead0e48f8e064cbad4385493294e7b09677a546e",
	"mac-cohort-evidence-exported-ack/v1":
		"000000567b226b696e64223a226d61632d636f686f72742d65766964656e63652d6578706f727465642d61636b222c22736368656d61223a22636f6d70617269736f6e2d73757065727669736f722d6672616d652f7631227d0a00000000000001797b2261636b52657175657374536571223a31302c22636f686f72744f62736572766174696f6e45766964656e6365536861323536223a2262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262222c22636f686f72744f62736572766174696f6e45766964656e63655369676e6174757265426173653634223a2242513d3d222c22636f686f72744f62736572766174696f6e45766964656e636553697a65223a362c22657865637574696f6e536861323536223a2261616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161222c22726573706f6e7365536571223a31302c22736368656d61223a226d61632d636f686f72742d65766964656e63652d6578706f727465642d61636b2f7631222c227465726d696e616c4578706f7274223a747275657d0a85acea126d743b328b4bfb77de39b6dae0c6360494acfa7cb5bec137d5cfe220",
	"mac-open-execution-request/v1":
		"000000507b226b696e64223a226d61632d6f70656e2d657865637574696f6e2d72657175657374222c22736368656d61223a22636f6d70617269736f6e2d73757065727669736f722d6672616d652f7631227d0a00000000000000b27b22657865637574696f6e4472616674426173653634223a2241513d3d222c22657865637574696f6e4472616674536861323536223a2261616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161222c2272657175657374536571223a302c22736368656d61223a226d61632d6f70656e2d657865637574696f6e2d726571756573742f7631227d0aa9a0c2e84f6b2cced2846903a1a92e25f330b0a9ab68cea63c4a951f10402be4",
	"mac-execution-opened-ack/v1":
		"0000004e7b226b696e64223a226d61632d657865637574696f6e2d6f70656e65642d61636b222c22736368656d61223a22636f6d70617269736f6e2d73757065727669736f722d6672616d652f7631227d0a00000000000001307b2261636b52657175657374536571223a302c22657865637574696f6e4472616674426173653634223a2241513d3d222c22657865637574696f6e536861323536223a2262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262222c226d6163457865637574696f6e4772616e7452656365697074426173653634223a2241773d3d222c226d6163457865637574696f6e4772616e745369676e6174757265426173653634223a2242413d3d222c226d6561737572656d656e744772616e74426173653634223a2241673d3d222c22726573706f6e7365536571223a302c22736368656d61223a226d61632d657865637574696f6e2d6f70656e65642d61636b2f7631227d0a5cac869de1edc11d6a62e4517cab0bab2124381d9a5c888aff3017111f09e051",
};

/**
 * Vectors 8 and 9: the per-cell `token-commitment-leaf-manifest/v1` pair.
 *
 * Built by `buildFanoutCohortFixture` with its default deterministic token
 * source, so both languages can regenerate the inputs from the four numbers in
 * each row. `tokenFor` is left unset on purpose: the vector pins the *shape*
 * the Rust verifier folds, and production tokens are 32 random bytes that no
 * vector could pin.
 */
const S3_R8_MANIFEST_VECTORS = [
	{
		cell: "chat 1k",
		cohortId: "cohort-vector-chat-1k",
		publisherCount: 10,
		subscriberCount: 1_000,
		leafCount: 1_010,
		manifestSize: 253794,
		manifestSha256:
			"1c711a4538fe83934e9310e2d7aff6dec71337ba627c1f081b9d37ee1106d841",
		rootSha256:
			"3f3d35f15bd314607ab41b63e6b47ed6ba6db9a32f8039381807b10019616d48",
		firstLeafHex:
			"7b226368696c644964223a227075626c69736865722d6368696c642d30222c22636f686f72744964223a22636f686f72742d766563746f722d636861742d316b222c22726f6c65223a227075626c6973686572222c22726f6c654964223a227075626c69736865722d303030303030222c22736368656d61223a22746f6b656e2d636f6d6d69746d656e742d6c6561662f7631222c22746f6b656e536861323536223a2235616665313439663062613434373937346534363032613935313465653936646261643935396130316431623963643030346631643038633633306365343634222c22776f726b6572496e646578223a6e756c6c7d0a",
		lastLeafHex:
			"7b226368696c644964223a22737562736372696265722d776f726b65722d37222c22636f686f72744964223a22636f686f72742d766563746f722d636861742d316b222c22726f6c65223a2273756273637269626572222c22726f6c654964223a22737562736372696265722d303030393939222c22736368656d61223a22746f6b656e2d636f6d6d69746d656e742d6c6561662f7631222c22746f6b656e536861323536223a2231623663616163343433323966626161646365323463393935353337323730333966636361633466373839393432646164333632626232343836383862646464222c22776f726b6572496e646578223a377d0a",
	},
	{
		cell: "ticker 10k",
		cohortId: "cohort-vector-ticker-10k",
		publisherCount: 1,
		subscriberCount: 100,
		leafCount: 101,
		manifestSize: 25949,
		manifestSha256:
			"4a255a1d854f76dd0b9c75d86315acd5a966e77ffff77cd8ec039e2f596bc104",
		rootSha256:
			"33eb2d4a0aea3f570a603f3b7af2a43463ffc256b7d5d3030ae5ca2543aa39ef",
		firstLeafHex:
			"7b226368696c644964223a227075626c69736865722d6368696c642d30222c22636f686f72744964223a22636f686f72742d766563746f722d7469636b65722d31306b222c22726f6c65223a227075626c6973686572222c22726f6c654964223a227075626c69736865722d303030303030222c22736368656d61223a22746f6b656e2d636f6d6d69746d656e742d6c6561662f7631222c22746f6b656e536861323536223a2262396134316366363762363939313831373233613764326631646635303130383262383362303865383330386166643632316238333461373034353962333530222c22776f726b6572496e646578223a6e756c6c7d0a",
		lastLeafHex:
			"7b226368696c644964223a22737562736372696265722d776f726b65722d33222c22636f686f72744964223a22636f686f72742d766563746f722d7469636b65722d31306b222c22726f6c65223a2273756273637269626572222c22726f6c654964223a22737562736372696265722d303030303939222c22736368656d61223a22746f6b656e2d636f6d6d69746d656e742d6c6561662f7631222c22746f6b656e536861323536223a2266376534396235396166393963333465663139393830636334626461653765326265316138346636353564333230646132343162393061613338663261643333222c22776f726b6572496e646578223a337d0a",
	},
] as const;

describe("B3.5 R3.5 S3-r8: the revision 8/9 registry edits", () => {
	const R8_BY_NAME: Readonly<
		Record<string, Record<string, unknown> & { schema: string }>
	> = {
		"mac-open-cohort-request/v1": OPEN_COHORT_WITH_MANIFEST,
		"mac-export-warmup-completion-manifest-request/v1": WARMUP_MANIFEST_EXPORT,
		"mac-present-rig-observation-request/v1": MAC_OBSERVATION,
		"mac-export-cohort-evidence-request/v1": EXPORT_EVIDENCE_REQUEST,
		"mac-cohort-evidence-exported-ack/v1": EVIDENCE_EXPORTED_ACK,
		"mac-open-execution-request/v1": MAC_OPEN_EXECUTION,
		"mac-execution-opened-ack/v1": MAC_EXECUTION_OPENED,
	};

	test("the_seven_edited_frames_round_trip_exactly", () => {
		for (const [schema, sample] of Object.entries(R8_BY_NAME)) {
			const phaseA = isPhaseAMacRemoteSchema(schema);
			const keys = phaseA
				? phaseAMacRemotePayloadKeys(schema)
				: cohortRemotePayloadKeys(schema as CohortRemoteSchema);
			expect(keys).toEqual(Object.keys(sample).sort());
			const decoded = decodeRegisteredRemotePayload(s3Frame(sample));
			expect(decoded.ok).toBe(true);
			if (!decoded.ok) throw new Error(`${schema} decode`);
			expect(decoded.value.headerKind).toBe(schema.slice(0, -3));
			const parsed = phaseA
				? parsePhaseAMacRemotePayload(decoded.value.payload)
				: parseCohortRemotePayload(decoded.value.payload);
			if (!parsed.ok) throw new Error(`${schema}: ${parsed.message}`);
			expect(parsed.value as unknown as Record<string, unknown>).toEqual(
				sample as Record<string, unknown>,
			);
			// The pre-edit key set is short, and short is a refusal rather than
			// a frame with an absent binding.
			for (const added of Object.keys(sample)) {
				if (added === "schema") continue;
				const shortened: Record<string, unknown> = { ...sample };
				delete shortened[added];
				const reparsed = phaseA
					? parsePhaseAMacRemotePayload(shortened)
					: parseCohortRemotePayload(shortened);
				expect(reparsed.ok).toBe(false);
			}
		}
	});

	test("the_pinned_r8_frames_are_the_ones_the_rust_dispatch_matches", () => {
		expect(Object.keys(S3_R8_PINNED_REMOTE_FRAME_HEX).sort()).toEqual(
			Object.keys(R8_BY_NAME).sort(),
		);
		for (const [schema, hex] of Object.entries(S3_R8_PINNED_REMOTE_FRAME_HEX)) {
			const payload = R8_BY_NAME[schema];
			if (payload === undefined) throw new Error(`no sample for ${schema}`);
			expect(Buffer.from(s3Frame(payload)).toString("hex")).toBe(hex);
			const decoded = decodeRegisteredRemotePayload(
				new Uint8Array(Buffer.from(hex, "hex")),
			);
			expect(decoded.ok).toBe(true);
			if (!decoded.ok) throw new Error("unreachable");
			expect(decoded.value.headerKind).toBe(schema.slice(0, -3));
		}
	});

	test("the_warmup_completes_array_is_the_only_array_kind_and_it_is_bounded", () => {
		// The kind goes in the cohort vocabulary, not the shared Phase-A one.
		// The design aimed at the wrong union twice, so this is asserted rather
		// than commented: seven cohort kinds, fourteen Phase-A kinds, disjoint
		// in the one way that matters -- no array kind exists on the Phase-A
		// side and none of its fourteen names is `base64Array`.
		expect([...COHORT_REMOTE_FIELD_KINDS].sort()).toEqual([
			"base64",
			"base64Array",
			"byteSize",
			"count",
			"literalTrue",
			"seq",
			"sha256",
		]);
		expect(PHASE_A_REMOTE_FIELD_KINDS).not.toContain("base64Array");
		// Empty is refused: a manifest export with no child bytes is not a
		// smaller export, it is one the binary cannot build a manifest from.
		for (const bad of [
			[],
			"AQ==",
			null,
			[S3_B(1), ""],
			[S3_B(1), null],
			new Array(COHORT_REMOTE_MAX_BASE64_ARRAY_ENTRIES + 1).fill(S3_B(1)),
		]) {
			expect(
				parseCohortRemotePayload({
					...WARMUP_MANIFEST_EXPORT,
					roleWarmupCompletesBase64: bad,
				}).ok,
			).toBe(false);
		}
		// Eighteen is the largest legal cohort: ten publishers plus eight
		// subscriber workers.
		expect(COHORT_REMOTE_MAX_BASE64_ARRAY_ENTRIES).toBe(
			COHORT_MAX_PUBLISHERS + COHORT_WORKER_COUNT,
		);
		expect(
			parseCohortRemotePayload({
				...WARMUP_MANIFEST_EXPORT,
				roleWarmupCompletesBase64: new Array(
					COHORT_REMOTE_MAX_BASE64_ARRAY_ENTRIES,
				).fill(S3_B(1)),
			}).ok,
		).toBe(true);
		// The request takes the ack's own pair, not the 1 MiB default.
		expect(
			remotePayloadBoundForSchema(
				"mac-export-warmup-completion-manifest-request/v1",
			),
		).toBe(COHORT_WARMUP_MANIFEST_EXPORT_MAX_ENCODED_BYTES);
	});

	test("the_evidence_export_pair_carries_the_bulk_on_the_request_and_a_receipt_on_the_ack", () => {
		// NEW-21's cap split. Revision 8 gave both sides plan 529's pair, which
		// is 28 MiB encoded on one request/ack pair against a 20 MiB budget.
		expect(
			remotePayloadBoundForSchema("mac-export-cohort-evidence-request/v1"),
		).toBe(COHORT_EVIDENCE_EXPORT_MAX_ENCODED_BYTES);
		expect(
			remotePayloadBoundForSchema("mac-cohort-evidence-exported-ack/v1"),
		).toBe(COHORT_EVIDENCE_EXPORTED_ACK_MAX_BYTES);
		expect(COHORT_EVIDENCE_EXPORTED_ACK_MAX_BYTES).toBe(8_192);
		// The bytes left the ack. A frame still carrying them is refused on its
		// key set, which is what makes the shrink a contract rather than a
		// convention the sender may ignore.
		expect(
			parseCohortRemotePayload({
				...EVIDENCE_EXPORTED_ACK,
				cohortObservationEvidenceBase64: S3_B(9),
			}).ok,
		).toBe(false);
		expect(
			cohortRemotePayloadKeys("mac-cohort-evidence-exported-ack/v1"),
		).not.toContain("cohortObservationEvidenceBase64");
		// And the ack now carries the only signature `cohort-observation-evidence/v1`
		// ever gets: it is in neither signed-schema union, so the Mac signs its
		// digest here or the record is unsigned.
		expect(
			cohortRemotePayloadKeys("mac-cohort-evidence-exported-ack/v1"),
		).toContain("cohortObservationEvidenceSignatureBase64");
		// A 9 MiB decoded bundle is legal on the request and would not fit the
		// shrunken ack -- the split, demonstrated rather than asserted.
		const bulky = {
			...EXPORT_EVIDENCE_REQUEST,
			roleChildEvidenceBundleBase64: "A".repeat(2_000_000),
		};
		expect(encodeRegisteredRemotePayload(bulky).ok).toBe(true);
		expect(
			encodeRegisteredRemotePayload({
				...EVIDENCE_EXPORTED_ACK,
				cohortObservationEvidenceSignatureBase64: "A".repeat(20_000),
			}).ok,
		).toBe(false);
	});

	test("the_open_cohort_request_carries_commitments_and_never_a_raw_token", () => {
		// §2.9(2e)'s ruling, from the codec's side. What travels is the leaf
		// manifest -- leaf hashes, order, cohort id -- and the binary recomputes
		// the root from it. The frame has no field a raw token could ride on:
		// every added key is a digest or the manifest itself, and the manifest's
		// own leaf type carries `tokenSha256` and no token.
		const keys = cohortRemotePayloadKeys("mac-open-cohort-request/v1");
		expect(keys).toContain("tokenCommitmentLeafManifestBase64");
		expect(keys).toContain("tokenCommitmentLeafManifestSha256");
		expect(keys.filter((key) => /token/i.test(key)).sort()).toEqual([
			"tokenCommitmentLeafManifestBase64",
			"tokenCommitmentLeafManifestSha256",
		]);
		// The manifest is leaf records only, so the 1 MiB default holds: §4.3's
		// own arithmetic bounds the *raw* bundle at 1,924,096 bytes for the
		// 1,250-entry worst case including 44-char tokens and fourteen sibling
		// hashes per entry, and this carries neither.
		expect(remotePayloadBoundForSchema("mac-open-cohort-request/v1")).toBe(
			7 * 1024 * 1024,
		);
		// The pair is not nullable: a cohort opened without a commitment
		// manifest is one whose root the binary would have to take on trust.
		expect(
			parseCohortRemotePayload({
				...OPEN_COHORT_WITH_MANIFEST,
				tokenCommitmentLeafManifestBase64: null,
			}).ok,
		).toBe(false);
	});

	test("the_five_derived_records_travel_as_records_not_digests", () => {
		// Registry edit (d). Records, so the binary recomputes each digest over
		// the exact bytes it will bind rather than trusting a number: a
		// `...Sha256` key here would be the defect the edit exists to avoid.
		const keys = phaseAMacRemotePayloadKeys(
			"mac-present-rig-observation-request/v1",
		);
		for (const field of [
			"orderedPartialManifestBase64",
			"observedProcessProofBase64",
			"cohortRateSeriesBase64",
			"cohortLedgerBase64",
			"cohortCapacityBase64",
		]) {
			expect(keys).toContain(field);
			expect(keys).not.toContain(field.replace("Base64", "Sha256"));
			expect(
				phaseAMacRemoteFieldSpec(
					"mac-present-rig-observation-request/v1",
					field,
				),
			).toEqual({ kind: "base64OrNull" });
			// Nullable but never absent: this is a Phase-A frame and a
			// non-cohort execution has no such record, but a missing key is a
			// refusal in both shapes.
			expect(
				parsePhaseAMacRemotePayload({ ...MAC_OBSERVATION, [field]: null }).ok,
			).toBe(true);
			const missing: Record<string, unknown> = { ...MAC_OBSERVATION };
			delete missing[field];
			expect(parsePhaseAMacRemotePayload(missing).ok).toBe(false);
		}
		// The frame stays at the Phase-A default: all five records at chat-10k's
		// cardinality fit inside 1 MiB, the largest being `observed-process-proof/v1`
		// at ~10 KB because `perSubscriberDelivered` lives in the worker partials.
		expect(
			remotePayloadBoundForSchema("mac-present-rig-observation-request/v1"),
		).toBe(CAPS.remotePayloadDefault);
	});

	test("the_two_phase_a_mac_entries_are_the_plans_key_sets", () => {
		// §2.9(2c): Phase-A Mac minting moves into the binary, so these two
		// frames stop being names with nothing behind them. Plan 551-564.
		expect(phaseAMacRemotePayloadKeys("mac-open-execution-request/v1")).toEqual(
			["executionDraftBase64", "executionDraftSha256", "requestSeq", "schema"],
		);
		expect(phaseAMacRemotePayloadKeys("mac-execution-opened-ack/v1")).toEqual([
			"ackRequestSeq",
			"executionDraftBase64",
			"executionSha256",
			"macExecutionGrantReceiptBase64",
			"macExecutionGrantSignatureBase64",
			"measurementGrantBase64",
			"responseSeq",
			"schema",
		]);
		// The open request names no execution index and no grant digest: the
		// binary chooses the ordinal, which is the whole point of the draft.
		expect(
			phaseAMacRemotePayloadKeys("mac-open-execution-request/v1"),
		).not.toContain("executionIndex");
		for (const schema of PHASE_A_MAC_REMOTE_SCHEMAS) {
			expect(PHASE_A_REMOTE_PAYLOAD_SCHEMAS).toContain(schema);
		}
	});

	test("a_fourteen_mebibyte_base64_field_is_still_strict_base64", () => {
		// Found by executing the budget test rather than by reading. The
		// regex `isStrictBase64` used --
		// /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/ --
		// returns false, silently, for any well-formed base64 longer than
		// 5,570,552 characters: the counted group exhausts its match budget and
		// the engine reports a non-match rather than throwing. Registry edit
		// (e) puts a 14 MiB encoded field on the evidence-export request, so the
		// largest legal frame in the protocol was refused as malformed and the
		// refusal was indistinguishable from a corrupt payload.
		const overTheOldLimit = "A".repeat(5_570_556);
		expect(
			parseCohortRemotePayload({
				...EXPORT_EVIDENCE_REQUEST,
				roleChildEvidenceBundleBase64: overTheOldLimit,
			}).ok,
		).toBe(true);
		// And the scan still rejects what the regex rejected.
		for (const bad of ["A", "AAA=A", "A===", "A=A=", "AA*=", "===="]) {
			expect(
				parseCohortRemotePayload({
					...EXPORT_EVIDENCE_REQUEST,
					roleChildEvidenceBundleBase64: bad,
				}).ok,
			).toBe(false);
		}
		for (const good of ["AQ==", "AQI=", "AQID", "AQIDBA=="]) {
			expect(
				parseCohortRemotePayload({
					...EXPORT_EVIDENCE_REQUEST,
					roleChildEvidenceBundleBase64: good,
				}).ok,
			).toBe(true);
		}
	});

	test("the_budget_refuses_where_the_per_frame_cap_would_not", () => {
		// The constant had no consumer in either language -- a declaration and
		// two assertions that it equals 20 MiB. Two 9 MiB decoded exports in one
		// execution each pass their per-frame cap; the second must refuse on the
		// budget. Without this the accounting could be absent and every
		// per-frame check would still pass, which is how it reached HEAD.
		const nineMiB = "A".repeat((9 * 1024 * 1024 * 4) / 3);
		const bulky = {
			...EXPORT_EVIDENCE_REQUEST,
			roleChildEvidenceBundleBase64: nineMiB,
		};
		expect(encodeRegisteredRemotePayload(bulky).ok).toBe(true);
		expect(parseCohortRemotePayload(bulky).ok).toBe(true);
		const budget = new CohortEvidenceBudget();
		budget.openExecution(HEX_A);
		const first = budget.charge(bulky);
		expect(first.ok).toBe(true);
		if (!first.ok) throw new Error("unreachable");
		expect(first.value).toBe(9 * 1024 * 1024);
		expect(budget.chargedBytes).toBe(9 * 1024 * 1024);
		// §2.9(2d) says the *second* of two 9 MiB exports must refuse. On its
		// own numbers it does not: 9 + 9 is 18 against a 20 MiB budget, so the
		// second is legal and the third is where the budget bites. The property
		// the test exists for is unchanged and is asserted at the point it
		// actually holds rather than at the point the prose names.
		const second = budget.charge(bulky);
		expect(second.ok).toBe(true);
		expect(budget.chargedBytes).toBe(18 * 1024 * 1024);
		expect(budget.remainingBytes).toBe(2 * 1024 * 1024);
		const third = budget.charge(bulky);
		expect(third.ok).toBe(false);
		expect(refusalCode(third)).toBe("RUNTIME_RESOURCE_EXHAUSTION");
		// The refusal did not spend the budget it refused.
		expect(budget.chargedBytes).toBe(18 * 1024 * 1024);
		// A new execution resets; re-opening the same one does not, so a
		// repeated open cannot launder a spent budget.
		budget.openExecution(HEX_A);
		expect(budget.chargedBytes).toBe(18 * 1024 * 1024);
		budget.openExecution(HEX_B);
		expect(budget.chargedBytes).toBe(0);
		expect(budget.openExecutionSha256).toBe(HEX_B);
	});

	test("the_budget_debits_the_three_bulk_frames_and_nothing_else", () => {
		expect(Object.keys(COHORT_EVIDENCE_DEBIT_FIELDS).sort()).toEqual([
			"mac-export-cohort-evidence-request/v1",
			"mac-export-warmup-completion-manifest-request/v1",
			"mac-open-cohort-request/v1",
			"mac-present-rig-observation-request/v1",
		]);
		const budget = new CohortEvidenceBudget();
		budget.openExecution(HEX_A);
		// A frame with no debit field charges nothing: the budget is not a
		// frame counter.
		expect(budget.charge(OPEN_COHORT_WITH_MANIFEST)).toEqual({
			ok: true,
			value: 4,
		});
		// The array kind charges every element, decoded.
		const warmup = budget.charge(WARMUP_MANIFEST_EXPORT);
		expect(warmup).toEqual({ ok: true, value: 3 });
		// Edit (d)'s five, each one decoded byte here, and the null shape is free.
		expect(budget.charge(MAC_OBSERVATION)).toEqual({ ok: true, value: 5 });
		expect(
			budget.charge({
				...MAC_OBSERVATION,
				orderedPartialManifestBase64: null,
				observedProcessProofBase64: null,
				cohortRateSeriesBase64: null,
				cohortLedgerBase64: null,
				cohortCapacityBase64: null,
			}),
		).toEqual({ ok: true, value: 0 });
		expect(budget.chargedBytes).toBe(12);
		// Charged decoded, computed from the encoded string: `decodedByteLengthOfBase64`
		// is arithmetic on the length and never allocates, which is what
		// "charged before allocation" has to mean for the charge to protect
		// anything.
		expect(decodedByteLengthOfBase64("AQ==")).toBe(1);
		expect(decodedByteLengthOfBase64("AQI=")).toBe(2);
		expect(decodedByteLengthOfBase64("AQID")).toBe(3);
		expect(decodedByteLengthOfBase64("A")).toBeNull();
		expect(decodedByteLengthOfBase64(null)).toBeNull();
		// A malformed debit field cannot charge zero and proceed.
		expect(
			budget.charge({
				...EXPORT_EVIDENCE_REQUEST,
				roleChildEvidenceBundleBase64: "A",
			}).ok,
		).toBe(false);
	});

	test("the_token_commitment_leaf_manifest_agrees_per_cell", () => {
		// §4's vector rule, second clause: `token-commitment-leaf-manifest/v1`
		// is a record with two encoders -- TypeScript builds it, and Rust
		// recomputes the root from the leaves it parses -- so it needs a vector,
		// per cell, because leaf content is cardinality-dependent.
		//
		// Pinned by digest rather than by a full hex literal: chat-1k is 1,010
		// leaves, whose canonical bytes are ~200 KB and whose hex is ~400 KB.
		// What Rust actually has to reproduce is the *leaf* encoding and the
		// node rule, so the boundary leaves are pinned in full hex and the
		// manifest is pinned by its canonical digest and size. A divergence in
		// either the leaf encoding or the fold moves the root.
		for (const vector of S3_R8_MANIFEST_VECTORS) {
			const fixture = buildFanoutCohortFixture({
				cohortId: vector.cohortId,
				publisherCount: vector.publisherCount,
				subscriberCount: vector.subscriberCount,
			});
			const manifest: TokenCommitmentLeafManifestV1 = {
				schema: "token-commitment-leaf-manifest/v1",
				executionSha256: HEX_A,
				cohortId: vector.cohortId,
				leafCount: fixture.leaves.length,
				leaves: [...fixture.leaves],
				roleTokenCommitmentRootSha256: fixture.roleTokenCommitmentRootSha256,
			};
			expect(manifest.leafCount).toBe(vector.leafCount);
			const bytes = bytesOfCanonical(manifest);
			expect(bytes.byteLength).toBe(vector.manifestSize);
			expect(sha256HexOfBytes(bytes)).toBe(vector.manifestSha256);
			expect(manifest.roleTokenCommitmentRootSha256).toBe(vector.rootSha256);
			// The verifier's own half, run here so the vector proves the
			// property Rust is asked to reproduce and not merely some bytes.
			const recomputed = recomputeRootFromLeafManifest(manifest);
			expect(recomputed).toEqual({ ok: true, value: vector.rootSha256 });
			// The boundary leaves in full, canonical.
			const first = fixture.leaves[0];
			const last = fixture.leaves[fixture.leaves.length - 1];
			if (first === undefined || last === undefined) {
				throw new Error("empty leaf set");
			}
			expect(Buffer.from(bytesOfCanonical(first)).toString("hex")).toBe(
				vector.firstLeafHex,
			);
			expect(Buffer.from(bytesOfCanonical(last)).toString("hex")).toBe(
				vector.lastLeafHex,
			);
			// The manifest carries commitments and never a token: `tokenSha256`
			// on every leaf, and no key anywhere that could hold one.
			for (const leaf of [first, last]) {
				expect(Object.keys(leaf).sort()).toEqual([
					"childId",
					"cohortId",
					"role",
					"roleId",
					"schema",
					"tokenSha256",
					"workerIndex",
				]);
			}
			// The manifest fits the frame it rides on.
			expect(toBase64(bytes).length <= CAPS.remotePayloadDefault).toBe(true);
		}
		// Per-cell, and the two cells differ: a ticker-10k vector alone would
		// not exercise chat-1k's ten publishers.
		expect(S3_R8_MANIFEST_VECTORS.length).toBe(2);
		expect(S3_R8_MANIFEST_VECTORS[0]?.rootSha256).not.toBe(
			S3_R8_MANIFEST_VECTORS[1]?.rootSha256,
		);
	});
});

import {
	cohortExportAckSigningBytes,
	ed25519Sign,
	ed25519Verify,
	fromBase64,
	verifyCohortExportAckSignature,
} from "./cross-supervisor-protocol.ts";

describe("completion amendment terminal ack authentication and carrier bounds", () => {
	test("authenticates all seven unsigned fields with the external Mac key", () => {
		const key = generateEd25519KeyPair();
		const ack = {
			schema: "mac-cohort-evidence-exported-ack/v1" as const,
			responseSeq: 11,
			ackRequestSeq: 10,
			executionSha256: "a".repeat(64),
			cohortObservationEvidenceSha256: "b".repeat(64),
			cohortObservationEvidenceSize: 123,
			terminalExport: true as const,
			cohortObservationEvidenceSignatureBase64: "",
		};
		const transcript = cohortExportAckSigningBytes(ack);
		expect(new TextDecoder().decode(transcript)).toBe(
			'{"ackRequestSeq":10,"cohortObservationEvidenceSha256":"' +
				"b".repeat(64) +
				'","cohortObservationEvidenceSize":123,"executionSha256":"' +
				"a".repeat(64) +
				'","responseSeq":11,"schema":"mac-cohort-evidence-exported-ack/v1","terminalExport":true}\n',
		);
		// Amendment C3's two-sided transcript pin: the Rust side asserts this
		// same digest by name (`TS_UNSIGNED_EXPORT_ACK_TRANSCRIPT_SHA256`,
		// crates/native/tests/mac_cohort_runtime.rs:1630, and
		// `.scratch/2026-09-05-cohort-completion/protocol-vectors.json`).
		expect(Buffer.from(transcript).toString("hex")).toBe(
			UNSIGNED_EXPORT_ACK_TRANSCRIPT_HEX,
		);
		expect(sha256HexOfBytes(transcript)).toBe(
			UNSIGNED_EXPORT_ACK_TRANSCRIPT_SHA256,
		);
		ack.cohortObservationEvidenceSignatureBase64 = toBase64(
			ed25519Sign(key.privatePkcs8Der, transcript),
		);
		expect(verifyCohortExportAckSignature(ack, key.publicRaw32)).toBe(true);
		const alphabet =
			"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
		const canonicalSignature = ack.cohortObservationEvidenceSignatureBase64;
		const noncanonicalSignature =
			canonicalSignature.slice(0, 85) +
			alphabet[alphabet.indexOf(canonicalSignature[85]!) + 1] +
			"==";
		expect(
			verifyCohortExportAckSignature(
				{
					...ack,
					cohortObservationEvidenceSignatureBase64: noncanonicalSignature,
				},
				key.publicRaw32,
			),
		).toBe(false);
		for (const mutation of [
			{ responseSeq: 12 },
			{ ackRequestSeq: 11 },
			{ executionSha256: "c".repeat(64) },
			{ cohortObservationEvidenceSha256: "c".repeat(64) },
			{ cohortObservationEvidenceSize: 124 },
			{ terminalExport: false },
			{ schema: "other/v1" },
			{ key: toBase64(key.publicRaw32) },
			{
				cohortObservationEvidenceSignatureBase64: toBase64(new Uint8Array(64)),
			},
			{
				cohortObservationEvidenceSignatureBase64: toBase64(new Uint8Array(63)),
			},
		]) {
			expect(
				verifyCohortExportAckSignature(
					{ ...ack, ...mutation },
					key.publicRaw32,
				),
			).toBe(false);
		}
		expect(
			verifyCohortExportAckSignature(ack, generateEd25519KeyPair().publicRaw32),
		).toBe(false);
	});

	test("enforces each decoded carrier cap before allocating decoded evidence", () => {
		for (const [field, cap] of Object.entries({
			tokenCommitmentLeafManifestBase64: 4 * 1024 * 1024,
			publishersBase64: 256 * 1024,
			subscriberShardsBase64: 256 * 1024,
			workloadRolePlanInputBase64: 256 * 1024,
		})) {
			const atCap = {
				...OPEN_COHORT_WITH_MANIFEST,
				[field]: toBase64(new Uint8Array(cap)),
			};
			expect(parseCohortRemotePayload(atCap).ok).toBe(true);
			expect(
				parseCohortRemotePayload({
					...atCap,
					[field]: toBase64(new Uint8Array(cap + 1)),
				}).ok,
			).toBe(false);
			const budget = new CohortEvidenceBudget(cap + 2);
			budget.openExecution(HEX_A);
			expect(budget.charge(atCap).ok).toBe(false);
			expect(budget.chargedBytes).toBe(0);
		}
	});
});

test("chat-10k production-length cohort ID fits the bounded open carrier", () => {
	const cohortId = "c".repeat(41);
	const fixture = buildFanoutCohortFixture({
		cohortId,
		publisherCount: 10,
		subscriberCount: 10_000,
	});
	const manifest = {
		schema: "token-commitment-leaf-manifest/v1",
		executionSha256: HEX_A,
		cohortId,
		leafCount: fixture.leaves.length,
		leaves: fixture.leaves,
		roleTokenCommitmentRootSha256: fixture.roleTokenCommitmentRootSha256,
	};
	const bytes = bytesOfCanonical(manifest);
	const open = {
		...OPEN_COHORT_WITH_MANIFEST,
		tokenCommitmentLeafManifestBase64: toBase64(bytes),
		tokenCommitmentLeafManifestSha256: sha256HexOfBytes(bytes),
		publishersBase64: toBase64(bytesOfCanonical(fixture.publishers)),
		subscriberShardsBase64: toBase64(
			bytesOfCanonical(fixture.subscriberShards),
		),
	};
	expect(bytes.byteLength).toBeGreaterThan(1024 * 1024);
	expect(Object.keys(manifest)).toHaveLength(6);
	expect(parseCohortRemotePayload(open).ok).toBe(true);
	expect(encodeRegisteredRemotePayload(open).ok).toBe(true);
	const budget = new CohortEvidenceBudget();
	budget.openExecution(HEX_A);
	expect(budget.charge(open)).toEqual({
		ok: true,
		value:
			bytes.byteLength +
			bytesOfCanonical(fixture.publishers).byteLength +
			bytesOfCanonical(fixture.subscriberShards).byteLength +
			1,
	});
});

// ---------------------------------------------------------------------------
// Amendment C3: the chat-1k and ticker-10k full observation encodings, pinned
// independently in both production encoders.
//
// The Rust side (`the_chat_1k_evidence_vector_is_reproducible_and_pinned`,
// `the_ticker_10k_evidence_vector_is_reproducible_and_pinned`,
// crates/native/tests/mac_cohort_runtime.rs:5139/:5166) runs one deterministic
// lifecycle per cell, digests and signs the 33-member
// `cohort-observation-evidence/v1` it assembled, and pins size + digest. The
// files under fixtures/cohort-evidence-vectors/ are that lifecycle's exact
// output (written with `WTB_EVIDENCE_VECTOR_DIR`, see `evidence_vector` at
// :5095). The TS encoder has no access to that lifecycle: its inputs are the
// 33 retained members and the signed ack, and the contract is that
// `bytesOfCanonical` over those members reproduces the bytes the binary
// digested and signed (`cohortEvidenceFromExportAck`, artifact-builder.ts:230).
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cohortEvidenceFromExportAck } from "./artifact-builder.ts";
import { parseStrictJsonBytes } from "./secure-fs.ts";

/** Pinned 2026-09-05; the same constants as the Rust pin, by value. */
const UNSIGNED_EXPORT_ACK_TRANSCRIPT_HEX =
	"7b2261636b52657175657374536571223a31302c22636f686f72744f62736572766174696f6e45766964656e6365536861323536223a2262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262222c22636f686f72744f62736572766174696f6e45766964656e636553697a65223a3132332c22657865637574696f6e536861323536223a2261616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161222c22726573706f6e7365536571223a31312c22736368656d61223a226d61632d636f686f72742d65766964656e63652d6578706f727465642d61636b2f7631222c227465726d696e616c4578706f7274223a747275657d0a";
const UNSIGNED_EXPORT_ACK_TRANSCRIPT_SHA256 =
	"fca8b3a0cb3ac71f613eda44ef4f3f3828a09e0107a8fc39b7256bbd0ab41962";

const EVIDENCE_VECTOR_DIR = join(
	import.meta.dir,
	"fixtures",
	"cohort-evidence-vectors",
);

/** `CHAT_1K_EVIDENCE_*` / `TICKER_10K_EVIDENCE_*`, mac_cohort_runtime.rs `CHAT_1K_EVIDENCE_*`/`TICKER_10K_EVIDENCE_*` consts. */
const EVIDENCE_VECTORS = [
	{
		cellId: "chat-fanout/subscribers-1000",
		file: "chat-fanout_subscribers-1000",
		size: 507_198,
		sha256: "a543d54d948cb6c400cef70c7890af9eb04130c5ed4f81d2e58f565b69db5a61",
		publisherCount: 10,
		subscriberCount: 1000,
		roleWarmupCompletes: 18,
	},
	{
		cellId: "ticker-fanout/rate-10000",
		file: "ticker-fanout_rate-10000",
		size: 134_555,
		sha256: "3f640b72ca143cd67849e4797eea0ad88a6edabb746b11519b5ead7eee8999c4",
		publisherCount: 1,
		subscriberCount: 100,
		roleWarmupCompletes: 9,
	},
] as const;

type EvidenceVector = (typeof EVIDENCE_VECTORS)[number];

function readHexVector(name: string): Uint8Array {
	const hex = readFileSync(join(EVIDENCE_VECTOR_DIR, name), "utf8").trim();
	return new Uint8Array(Buffer.from(hex, "hex"));
}

function loadEvidenceVector(vector: EvidenceVector) {
	const evidenceBytes = readHexVector(
		`cohort-observation-evidence.${vector.file}.hex`,
	);
	const ackBytes = readHexVector(
		`mac-cohort-evidence-exported-ack.${vector.file}.hex`,
	);
	const keys = JSON.parse(
		readFileSync(join(EVIDENCE_VECTOR_DIR, `keys.${vector.file}.json`), "utf8"),
	) as {
		readonly executionSha256: string;
		readonly macPublicRaw32Hex: string;
		readonly rigPublicRaw32Hex: string;
	};
	const evidence = parseStrictJsonBytes(evidenceBytes);
	const ack = parseStrictJsonBytes(ackBytes);
	if (!evidence.ok || !ack.ok) throw new Error("vector is not strict JSON");
	return {
		evidenceBytes,
		observation: evidence.value as Record<string, unknown>,
		ackBytes,
		ack: ack.value as Record<string, unknown>,
		macPublicRaw32: new Uint8Array(Buffer.from(keys.macPublicRaw32Hex, "hex")),
		executionSha256: keys.executionSha256,
	};
}

/** Same members, presented in reverse key order: the encoder makes the bytes, not the fixture's layout. */
function reversedKeys(
	record: Record<string, unknown>,
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(record).reverse()) out[key] = record[key];
	return out;
}

function consumeVector(
	vector: EvidenceVector,
	loaded: ReturnType<typeof loadEvidenceVector>,
	patch: {
		readonly ack?: Record<string, unknown>;
		readonly observation?: Record<string, unknown>;
		readonly macPublicRaw32?: Uint8Array;
	} = {},
) {
	const grantSha256 = (loaded.observation.cohortGrant as { sha256: string })
		.sha256;
	return cohortEvidenceFromExportAck({
		ack: patch.ack ?? loaded.ack,
		observation: patch.observation ?? loaded.observation,
		stagedMacPublicRaw32: patch.macPublicRaw32 ?? loaded.macPublicRaw32,
		expectedExecutionSha256: loaded.executionSha256,
		expectedCohortGrantSha256: grantSha256,
		expectedPublisherCount: vector.publisherCount,
		expectedSubscriberCount: vector.subscriberCount,
		alreadyExported: false,
		expectedRequestSequence: loaded.ack.ackRequestSeq as number,
	});
}

describe("completion amendment C3: the per-cell evidence vectors pinned on the TS side", () => {
	for (const vector of EVIDENCE_VECTORS) {
		describe(vector.cellId, () => {
			test("the fixture is the bytes the Rust pin names", () => {
				const loaded = loadEvidenceVector(vector);
				expect(loaded.evidenceBytes.byteLength).toBe(vector.size);
				expect(sha256HexOfBytes(loaded.evidenceBytes)).toBe(vector.sha256);
				expect(loaded.ack.cohortObservationEvidenceSha256).toBe(vector.sha256);
				expect(loaded.ack.cohortObservationEvidenceSize).toBe(vector.size);
				expect(loaded.ack.executionSha256).toBe(loaded.executionSha256);
				expect(Object.keys(loaded.observation).length).toBe(34);
				expect(
					(loaded.observation.roleWarmupCompletes as unknown[]).length,
				).toBe(vector.roleWarmupCompletes);
				expect((loaded.observation.publisherPartials as unknown[]).length).toBe(
					vector.publisherCount,
				);
				expect((loaded.observation.workerPartials as unknown[]).length).toBe(
					COHORT_WORKER_COUNT,
				);
				// The retained grant digest is the digest of the retained bytes
				// it names, not a self-declaration.
				const grant = loaded.observation.cohortGrant as {
					sha256: string;
					bytesBase64: string;
				};
				expect(
					sha256HexOfBytes(
						new Uint8Array(Buffer.from(grant.bytesBase64, "base64")),
					),
				).toBe(grant.sha256);
			});

			test("the production TS encoder reproduces the binary's observation bytes from the 33 members", () => {
				const loaded = loadEvidenceVector(vector);
				const encoded = bytesOfCanonical(reversedKeys(loaded.observation));
				expect(encoded.byteLength).toBe(vector.size);
				expect(sha256HexOfBytes(encoded)).toBe(vector.sha256);
				expect(
					Buffer.from(encoded).equals(Buffer.from(loaded.evidenceBytes)),
				).toBe(true);
				// Any member change is a different encoding: the pin is not a
				// key-set check.
				const capacity = loaded.observation.capacity as Record<string, unknown>;
				const altered = bytesOfCanonical({
					...loaded.observation,
					capacity: {
						...capacity,
						byteLength: (capacity.byteLength as number) + 1,
					},
				});
				expect(sha256HexOfBytes(altered)).not.toBe(vector.sha256);
			});

			test("the production TS encoder reproduces the binary's signed terminal ack, whose transcript verifies under the staged Mac key", () => {
				const loaded = loadEvidenceVector(vector);
				// The eight-field ack the binary put on the wire, re-encoded.
				expect(
					Buffer.from(bytesOfCanonical(reversedKeys(loaded.ack))).equals(
						Buffer.from(loaded.ackBytes),
					),
				).toBe(true);
				expect(Object.keys(loaded.ack).length).toBe(8);
				expect(loaded.ack.terminalExport).toBe(true);
				// The seven-field transcript, signed by the binary, verified by
				// the production verifier under the external staged key.
				const { cohortObservationEvidenceSignatureBase64, ...unsigned } =
					loaded.ack;
				const transcript = cohortExportAckSigningBytes(
					unsigned as Parameters<typeof cohortExportAckSigningBytes>[0],
				);
				const signature = fromBase64(
					cohortObservationEvidenceSignatureBase64 as string,
				);
				if (signature === null) throw new Error("signature base64");
				expect(signature.byteLength).toBe(64);
				expect(
					ed25519Verify(loaded.macPublicRaw32, transcript, signature),
				).toBe(true);
				expect(
					verifyCohortExportAckSignature(loaded.ack, loaded.macPublicRaw32),
				).toBe(true);
				// Negatives against the same vector: another Mac key, a flipped
				// signature byte, and every one of the seven fields changed.
				expect(
					verifyCohortExportAckSignature(
						loaded.ack,
						generateEd25519KeyPair().publicRaw32,
					),
				).toBe(false);
				const flipped = Buffer.from(signature);
				flipped[0] = (flipped[0] as number) ^ 0x01;
				expect(
					verifyCohortExportAckSignature(
						{
							...loaded.ack,
							cohortObservationEvidenceSignatureBase64:
								flipped.toString("base64"),
						},
						loaded.macPublicRaw32,
					),
				).toBe(false);
				const mutations: Record<string, unknown> = {
					schema: "mac-cohort-evidence-exported-ack/v2",
					responseSeq: (loaded.ack.responseSeq as number) + 1,
					ackRequestSeq: (loaded.ack.ackRequestSeq as number) + 1,
					executionSha256: HEX_A,
					cohortObservationEvidenceSha256: HEX_B,
					cohortObservationEvidenceSize:
						(loaded.ack.cohortObservationEvidenceSize as number) + 1,
					terminalExport: false,
				};
				expect(Object.keys(mutations).length).toBe(7);
				for (const [field, value] of Object.entries(mutations)) {
					expect(
						verifyCohortExportAckSignature(
							{ ...loaded.ack, [field]: value },
							loaded.macPublicRaw32,
						),
					).toBe(false);
				}
			});

			test("the consumer's signature gate refuses another Mac key and a flipped signature before the graph is read", () => {
				const loaded = loadEvidenceVector(vector);
				const otherKey = consumeVector(vector, loaded, {
					macPublicRaw32: generateEd25519KeyPair().publicRaw32,
				});
				expect(otherKey.ok).toBe(false);
				if (!otherKey.ok) expect(otherKey.message).toContain("signature");
				const signature = Buffer.from(
					loaded.ack.cohortObservationEvidenceSignatureBase64 as string,
					"base64",
				);
				signature[0] = (signature[0] as number) ^ 0x01;
				const flipped = consumeVector(vector, loaded, {
					ack: {
						...loaded.ack,
						cohortObservationEvidenceSignatureBase64:
							signature.toString("base64"),
					},
				});
				expect(flipped.ok).toBe(false);
				if (!flipped.ok) expect(flipped.message).toContain("signature");
				// A dropped member is a different size before it is anything else.
				const { capacity: _dropped, ...withoutCapacity } = loaded.observation;
				const dropped = consumeVector(vector, loaded, {
					observation: withoutCapacity,
				});
				expect(dropped.ok).toBe(false);
				if (!dropped.ok) expect(dropped.message).toContain("size");
			});

			// The honest positive sibling of the three negatives above: the
			// binary's own graph, whose rig records carry the production rig's
			// closed key sets (secure_fs.rs `cohort::rig_record_keys`, minted
			// and admitted through `exact_fields` on the Rust side; the TS
			// `RIG_*_KEYS` mirror them field by field), parses under the
			// production consumer. The G1 counters show in the ack itself: the
			// terminal export is the ninth frame of its execution channel, so
			// `responseSeq === ackRequestSeq === 8`.
			test("the production consumer accepts the binary's own terminal ack against the reassembled observation", () => {
				const loaded = loadEvidenceVector(vector);
				expect(loaded.ack.responseSeq).toBe(8);
				expect(loaded.ack.ackRequestSeq).toBe(8);
				const accepted = consumeVector(vector, loaded);
				if (!accepted.ok) {
					throw new Error(
						`the binary's signed ack over ${vector.cellId} verifies, the TS encoder reproduces its ${vector.size} bytes, and the TS graph parser refuses them: ${accepted.message}`,
					);
				}
				expect(accepted.value.exportAck.cohortObservationEvidenceSha256).toBe(
					vector.sha256,
				);
				expect(accepted.value.processProof.observedPublisherCount).toBe(
					vector.publisherCount,
				);
				expect(accepted.value.processProof.observedSubscriberCount).toBe(
					vector.subscriberCount,
				);
				expect(bytesOfCanonical(accepted.value.observation)).toEqual(
					loaded.evidenceBytes,
				);
			});
		});
	}

	test("the two cells are distinct vectors under distinct keys and executions", () => {
		const chat = loadEvidenceVector(EVIDENCE_VECTORS[0]);
		const ticker = loadEvidenceVector(EVIDENCE_VECTORS[1]);
		expect(chat.executionSha256).not.toBe(ticker.executionSha256);
		expect(
			Buffer.from(chat.macPublicRaw32).equals(
				Buffer.from(ticker.macPublicRaw32),
			),
		).toBe(false);
		expect(
			verifyCohortExportAckSignature(chat.ack, ticker.macPublicRaw32),
		).toBe(false);
		expect(
			verifyCohortExportAckSignature(ticker.ack, chat.macPublicRaw32),
		).toBe(false);
	});
});
