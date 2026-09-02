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
	admitSignedRecordWithExpiryAndReplay,
	assertRemoteRequestSeq,
	assertRemoteResponseSeq,
	bytesOfCanonical,
	CAMPAIGN_FAILURE_CODES,
	CAMPAIGN_REFUSAL_CODES,
	CAPS,
	type CrossSupervisorExecutionDraftV1,
	cohortRemotePayloadKeys,
	createMemoryReplayLedger,
	createRemoteSequenceState,
	decodeRegisteredRemotePayload,
	decodeRemoteSupervisorPayload,
	encodeRegisteredRemotePayload,
	encodeRemoteSupervisorPayload,
	FANOUT_EXPANDED_DECLARATION_BY_CELL_ID,
	generateEd25519KeyPair,
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

	const SAMPLES = [SPAWN, READY, MEASURE_START, MEASURE_STARTED, STOP, CAPTURE];

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
	"mac-present-rig-observation-request/v1":
		"000000597b226b696e64223a226d61632d70726573656e742d7269672d6f62736572766174696f6e2d72657175657374222c22736368656d61223a22636f6d70617269736f6e2d73757065727669736f722d6672616d652f7631227d0a00000000000002cb7b22657865637574696f6e536861323536223a2261616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161222c226c696e757852656c61794f62736572766174696f6e426173653634223a6e756c6c2c2272657175657374536571223a31352c2272696742617272696572416363657074616e6365426173653634223a2242513d3d222c2272696742617272696572416363657074616e63655369676e6174757265426173653634223a2242673d3d222c22726967457865637574696f6e416363657074616e6365426173653634223a2241513d3d222c22726967457865637574696f6e416363657074616e63655369676e6174757265426173653634223a2241673d3d222c227269674d656173757265537461727441636b426173653634223a2241773d3d222c227269674d656173757265537461727441636b5369676e6174757265426173653634223a2242413d3d222c2272696752656c61794f62736572766174696f6e52656365697074426173653634223a6e756c6c2c2272696752656c61794f62736572766174696f6e526563656970745369676e6174757265426173653634223a6e756c6c2c22726967536572766572536e617073686f7452656365697074426173653634223a2243673d3d222c22726967536572766572536e617073686f74526563656970745369676e6174757265426173653634223a2243773d3d222c22736368656d61223a226d61632d70726573656e742d7269672d6f62736572766174696f6e2d726571756573742f7631222c227365727665725374617274426172726965724163636570746564426173653634223a2243413d3d222c227365727665725761726d7570447261696e6564426173653634223a2242773d3d222c22736e617073686f744672616d65426173653634223a2243513d3d227d0af97089b111ae08ab9633e37967c5f06cfd341c8c9f02938e3abdd829f88ca12c",
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
		// vacuous.
		expect(shared).toBe(23);
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
		// observation request, two on the admission ack.
		const macNullable = nullable.filter((name) => name.startsWith("mac-"));
		expect(macNullable.length).toBe(9);
		expect(
			macNullable.filter((name) =>
				name.startsWith("mac-present-rig-observation-request/v1."),
			).length,
		).toBe(7);
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
		expect(PHASE_A_RIG_REMOTE_SCHEMAS.length).toBe(8);
		expect(PHASE_A_MAC_REMOTE_SCHEMAS.length).toBe(2);
		expect(
			new Set([...PHASE_A_RIG_REMOTE_SCHEMAS, ...PHASE_A_MAC_REMOTE_SCHEMAS])
				.size,
		).toBe(10);
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
			"mac-present-rig-observation-request/v1": MAC_OBSERVATION,
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
