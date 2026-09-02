/**
 * A2 adversarial protocol tests (plan §8 A2 named checkbox list).
 */
import { describe, expect, test } from "bun:test";
import {
	assertChildInboundSequence,
	assertChildOutboundSequence,
	buildServerWarmupReady,
	CHILD_PIPE_REFUSAL_CODES,
	createChildSequenceState,
	decodeChildPipeFrame,
	encodeChildPipeFrame,
	mapChildRefusalToIndexCode,
	mapsEveryChildRefusalStateToOneIndexCode,
	parseChildPipeRefusal,
	parseServerBindExecution,
	parseServerWarmupReady,
	childPipeExactKeysAndBoundsFixture,
} from "./child-pipe-protocol.ts";
import {
	admitSignedRecordWithExpiryAndReplay,
	assertRemoteRequestSeq,
	assertRemoteResponseSeq,
	CAMPAIGN_FAILURE_CODES,
	CAMPAIGN_REFUSAL_CODES,
	CAPS,
	createMemoryReplayLedger,
	createRemoteSequenceState,
	decodeRegisteredRemotePayload,
	decodeRemoteSupervisorPayload,
	encodeRegisteredRemotePayload,
	encodeRemoteSupervisorPayload,
	generateEd25519KeyPair,
	parsePhaseARigRemotePayload,
	phaseARigRemotePayloadKeys,
	macConstructFinalExecution,
	parseCrossSupervisorExecution,
	parseCrossSupervisorExecutionDraft,
	parseMacExecutionGrantReceipt,
	parseRemoteSupervisorRefusal,
	FANOUT_EXPANDED_DECLARATION_BY_CELL_ID,
	PHASE_A_DECLARED_MESSAGE_BYTES,
	PHASE_A_DECLARED_MESSAGE_COUNT,
	rejectCrossExecutionRigReceipt,
	rejectHashOnlyGrantOrBaselineAck,
	rejectOversizeTruncatedTrailingAndEarlyEof,
	rejectPlanOrApprovalSwap,
	rejectUnsignedMacReceipt,
	rejectUnsignedOrInventedRigAcceptance,
	rejectWrongStagedPublicKey,
	signMacReceipt,
	signRigReceipt,
	STAGED_MAC_PUBLIC_KEY_LEAF,
	STAGED_RIG_PUBLIC_KEY_LEAF,
	toBase64,
	validateRemoteStatusCodePair,
	verifyMacReceiptSignature,
	verifyRigReceiptSignature,
	bytesOfCanonical,
	sha256CanonicalRecord,
	type CrossSupervisorExecutionDraftV1,
	type MacExecutionGrantReceiptV1,
	type ProtocolResult,
	type RigExecutionAcceptanceV1,
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
		expect(refusalCode(parseCrossSupervisorExecutionDraft(wrongCellCount))).toBe(
			"CROSS_SUPERVISOR_MISMATCH",
		);
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
		expect(parsePhaseARigRemotePayload({ ...SPAWN, transport: "quic" }).ok).toBe(
			false,
		);
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
