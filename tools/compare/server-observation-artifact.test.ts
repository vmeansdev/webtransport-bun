/**
 * A3 offline attestation graph tests (plan §8 A3 named coverage).
 */
import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
	cloneAttestation,
	mintPhaseAAttestationFixture,
	replaceEmbeddedBase64Field,
} from "./cohort-fixture-signing.ts";
import type { CohortObservationEvidenceV1 } from "./cohort-protocol.ts";
import { bytesOfCanonical, toBase64 } from "./cross-supervisor-protocol.ts";
import { FANOUT_COHORT_CELL_IDS } from "./evidence.ts";
import type {
	RigMeasureStartAckV1,
	RigServerSnapshotReceiptV1,
} from "./server-observation-artifact.ts";
import {
	RIG_MEASURE_START_ACK_KEYS,
	RIG_SERVER_SNAPSHOT_RECEIPT_KEYS,
	serverChildCpuIssue,
	verifyArmAttestationEvidence,
} from "./server-observation-artifact.ts";

function H(label: string): string {
	return createHash("sha256").update(label).digest("hex");
}

/** The Phase-A fixture's own cell/arm: `bulk-one-way/physical` runs no cohort. */
const PHASE_A_IDENTITY = {
	cellId: "bulk-one-way/physical",
	armKind: "primary",
} as const;

function retained(value: Record<string, unknown>): unknown {
	const bytes = bytesOfCanonical(value as never);
	return {
		schema: "retained-canonical-bytes/v1",
		encoding: "base64",
		mediaType: "application/json",
		bytesBase64: toBase64(bytes),
		byteLength: bytes.byteLength,
		sha256: createHash("sha256").update(bytes).digest("hex"),
	};
}

/**
 * A cohort export whose retained members are self-consistent.
 *
 * `verifyArmAttestationEvidence` decides presence and re-derives every retained
 * member's digest and size; the cohort's own reconstruction (tokens, ledger,
 * rate series) is `reconstructCohortEvidenceOffline`'s job in verify-artifact.
 */
function cohortEvidence(): CohortObservationEvidenceV1 {
	return {
		schema: "cohort-observation-evidence/v1",
		cohortGrant: retained({ schema: "cohort-grant/v1", cell: "ticker 100" }),
		observedProcessProof: retained({
			schema: "observed-process-proof/v1",
			observedPublisherCount: 1,
		}),
		publisherPartials: [retained({ schema: "publisher-partial/v1", seq: 1 })],
	} as unknown as CohortObservationEvidenceV1;
}

describe("server-observation-artifact: signed full-byte graph", () => {
	it("complete_bidirectionally_signed_full_byte_graph_verifies", () => {
		const fx = mintPhaseAAttestationFixture();
		const result = verifyArmAttestationEvidence(fx.attestation, fx.trust, {
			...PHASE_A_IDENTITY,
			executionSha256: fx.executionSha256,
			executionPurpose: "focused",
			transport: "ws",
			repetitionKind: "measured",
			repetitionIndex: 1,
			repetitionTotal: 1,
			campaignId: fx.draft.campaignId,
			candidate: fx.draft.candidate,
			approvedPlanSha256: fx.draft.approvedPlanSha256,
			approvalRecordSha256: fx.draft.approvalRecordSha256,
		});
		expect(result).toEqual({ ok: true });
	});

	it("real_receipt_paired_with_different_grant_or_admission_fails", () => {
		const fx = mintPhaseAAttestationFixture();
		const other = mintPhaseAAttestationFixture({ runId: "other-run" });
		const swapped = cloneAttestation(fx.attestation);
		const obs = swapped.serverObservationEvidence;
		(obs as { measurementGrantBase64: string }).measurementGrantBase64 =
			other.observation.measurementGrantBase64;
		(obs as { measurementGrantSha256: string }).measurementGrantSha256 =
			other.observation.measurementGrantSha256;
		(obs as { measurementGrantSize: number }).measurementGrantSize =
			other.observation.measurementGrantSize;
		const result = verifyArmAttestationEvidence(swapped, fx.trust, {
			...PHASE_A_IDENTITY,
			executionSha256: fx.executionSha256,
		});
		expect(result.ok).toBe(false);
	});

	it("replacement_of_every_embedded_byte_field_fails", () => {
		const fx = mintPhaseAAttestationFixture();
		const fields = [
			"measurementGrantBase64",
			"macExecutionGrantReceiptBase64",
			"admittedClientSeriesBase64",
			"rigExecutionAcceptanceBase64",
			"rigMeasureStartAckBase64",
			"snapshotFrameBase64",
			"rigServerSnapshotReceiptBase64",
			"macMeasurementAdmissionReceiptBase64",
		] as const;
		for (const field of fields) {
			const junk = toBase64(new TextEncoder().encode(`junk-${field}`));
			const mutated = replaceEmbeddedBase64Field(fx.attestation, field, junk);
			const result = verifyArmAttestationEvidence(mutated, fx.trust, {
				...PHASE_A_IDENTITY,
				executionSha256: fx.executionSha256,
			});
			expect(result.ok).toBe(false);
		}
	});

	it("unsigned_invented_or_rewritten_rig_acceptance_baseline_snapshot_fails", () => {
		const fx = mintPhaseAAttestationFixture();
		const cases = [
			"rigExecutionAcceptanceSignatureBase64",
			"rigMeasureStartAckSignatureBase64",
			"rigServerSnapshotReceiptSignatureBase64",
		] as const;
		for (const field of cases) {
			const next = cloneAttestation(fx.attestation);
			const obs = next.serverObservationEvidence as unknown as Record<
				string,
				string
			>;
			const forged = bytesOfCanonical({
				schema: "rig-receipt-signature/v1",
				algorithm: "Ed25519",
				signedSchema: "rig-execution-acceptance/v1",
				signedBytesSha256: H(`forged-${field}`),
				signingPublicKeySha256: fx.trust.rigPublicKeySha256,
				signatureBase64: toBase64(new Uint8Array(64)),
			});
			obs[field] = toBase64(forged);
			obs[field.replace(/Base64$/, "Sha256")] = createHash("sha256")
				.update(forged)
				.digest("hex");
			obs[field.replace(/Base64$/, "Size")] = String(forged.byteLength);
			const result = verifyArmAttestationEvidence(next, fx.trust, {
				...PHASE_A_IDENTITY,
				executionSha256: fx.executionSha256,
			});
			expect(result.ok).toBe(false);
		}
	});

	it("wrong_plan_approval_candidate_source_cell_rep_transport_pid_pgid_nonce_fails", () => {
		const fx = mintPhaseAAttestationFixture({
			childPid: 100,
			childPgid: 100,
		});
		const expectedBase = {
			...PHASE_A_IDENTITY,
			executionSha256: fx.executionSha256,
			executionPurpose: "focused" as const,
			transport: "ws" as const,
			repetitionKind: "measured" as const,
			repetitionIndex: 1,
			repetitionTotal: 1,
			campaignId: fx.draft.campaignId,
			candidate: fx.draft.candidate,
			approvedPlanSha256: fx.draft.approvedPlanSha256,
			approvalRecordSha256: fx.draft.approvalRecordSha256,
		};
		expect(
			verifyArmAttestationEvidence(fx.attestation, fx.trust, {
				...expectedBase,
				approvedPlanSha256: H("wrong-plan"),
			}).ok,
		).toBe(false);
		expect(
			verifyArmAttestationEvidence(fx.attestation, fx.trust, {
				...expectedBase,
				approvalRecordSha256: H("wrong-approval"),
			}).ok,
		).toBe(false);
		expect(
			verifyArmAttestationEvidence(fx.attestation, fx.trust, {
				...expectedBase,
				candidate: "b".repeat(40),
			}).ok,
		).toBe(false);
		expect(
			verifyArmAttestationEvidence(fx.attestation, fx.trust, {
				...expectedBase,
				cellId: "other-cell",
			}).ok,
		).toBe(false);
		expect(
			verifyArmAttestationEvidence(fx.attestation, fx.trust, {
				...expectedBase,
				repetitionIndex: 2,
			}).ok,
		).toBe(false);
		expect(
			verifyArmAttestationEvidence(fx.attestation, fx.trust, {
				...expectedBase,
				transport: "wt",
			}).ok,
		).toBe(false);
	});

	it("phase_a_1600_chunk_100mib_completion_equations_hold", () => {
		const fx = mintPhaseAAttestationFixture();
		expect(fx.grant.declaredMessageCount).toBe(1600);
		expect(fx.grant.declaredMessageBytes).toBe(104_857_600);
		const result = verifyArmAttestationEvidence(fx.attestation, fx.trust, {
			...PHASE_A_IDENTITY,
			executionSha256: fx.executionSha256,
		});
		expect(result).toEqual({ ok: true });
	});

	it("extra_short_timeout_or_capture_before_close_is_measurement_or_lifecycle_fail", () => {
		const fx = mintPhaseAAttestationFixture();
		const next = cloneAttestation(fx.attestation);
		const admissionB64 =
			next.serverObservationEvidence.macMeasurementAdmissionReceiptBase64;
		const admission = JSON.parse(
			Buffer.from(admissionB64, "base64").toString("utf8"),
		) as { delivered: number };
		admission.delivered = 104_857_599;
		const rewritten = Buffer.from(`${JSON.stringify(admission)}\n`);
		const mutated = replaceEmbeddedBase64Field(
			fx.attestation,
			"macMeasurementAdmissionReceiptBase64",
			toBase64(rewritten),
		);
		const result = verifyArmAttestationEvidence(mutated, fx.trust, {
			...PHASE_A_IDENTITY,
			executionSha256: fx.executionSha256,
		});
		expect(result.ok).toBe(false);
	});

	it("duplicate_or_stale_snapshot_and_client_series_rewrite_fail", () => {
		const fx = mintPhaseAAttestationFixture();
		const other = mintPhaseAAttestationFixture({
			busyMs: 99,
			spanMs: 2_500,
			runId: "other/bulk-one-way/physical/ws/measured-1",
		});
		const swappedSnap = replaceEmbeddedBase64Field(
			fx.attestation,
			"snapshotFrameBase64",
			other.observation.snapshotFrameBase64,
		);
		expect(
			verifyArmAttestationEvidence(swappedSnap, fx.trust, {
				...PHASE_A_IDENTITY,
				executionSha256: fx.executionSha256,
			}).ok,
		).toBe(false);
		const swappedClient = replaceEmbeddedBase64Field(
			fx.attestation,
			"admittedClientSeriesBase64",
			other.observation.admittedClientSeriesBase64,
		);
		expect(
			verifyArmAttestationEvidence(swappedClient, fx.trust, {
				...PHASE_A_IDENTITY,
				executionSha256: fx.executionSha256,
			}).ok,
		).toBe(false);
	});

	it("warmup_identity_is_kind_index_total_warmup_0_1_with_distinct_run_id", () => {
		const measured = mintPhaseAAttestationFixture({
			repetitionKind: "measured",
			repetitionIndex: 1,
			repetitionTotal: 1,
			runId: "c/bulk-one-way/physical/ws/measured-1",
		});
		const warmup = mintPhaseAAttestationFixture({
			repetitionKind: "warmup",
			repetitionIndex: 0,
			repetitionTotal: 1,
			runId: "c/bulk-one-way/physical/ws/warmup-0",
		});
		expect(warmup.execution.repetitionKind).toBe("warmup");
		expect(warmup.execution.repetitionIndex).toBe(0);
		expect(warmup.execution.repetitionTotal).toBe(1);
		expect(warmup.execution.runId).not.toBe(measured.execution.runId);
		expect(
			verifyArmAttestationEvidence(warmup.attestation, warmup.trust, {
				...PHASE_A_IDENTITY,
				executionSha256: warmup.executionSha256,
				repetitionKind: "warmup",
				repetitionIndex: 0,
				repetitionTotal: 1,
			}),
		).toEqual({ ok: true });
	});

	it("measured_repetition_1_through_5_and_duplicate_missing_out_of_range_fail", () => {
		for (const index of [1, 2, 3, 4, 5]) {
			const fx = mintPhaseAAttestationFixture({
				executionPurpose: "canonical",
				repetitionKind: "measured",
				repetitionIndex: index,
				repetitionTotal: 5,
				runId: `c/cell/ws/measured-${index}`,
			});
			expect(
				verifyArmAttestationEvidence(fx.attestation, fx.trust, {
					...PHASE_A_IDENTITY,
					executionSha256: fx.executionSha256,
					executionPurpose: "canonical",
					repetitionIndex: index,
					repetitionTotal: 5,
				}),
			).toEqual({ ok: true });
		}
		const bad = mintPhaseAAttestationFixture({
			executionPurpose: "canonical",
			repetitionIndex: 1,
			repetitionTotal: 5,
		});
		expect(
			verifyArmAttestationEvidence(bad.attestation, bad.trust, {
				...PHASE_A_IDENTITY,
				executionSha256: bad.executionSha256,
				repetitionIndex: 6,
				repetitionTotal: 5,
			}).ok,
		).toBe(false);
		expect(
			verifyArmAttestationEvidence(bad.attestation, bad.trust, {
				...PHASE_A_IDENTITY,
				executionSha256: bad.executionSha256,
				repetitionIndex: 0,
				repetitionTotal: 5,
			}).ok,
		).toBe(false);
	});

	it("warmup_or_pilot_bytes_reused_across_measured_fail_by_execution_join", () => {
		const warmup = mintPhaseAAttestationFixture({
			repetitionKind: "warmup",
			repetitionIndex: 0,
			repetitionTotal: 1,
			runId: "c/cell/ws/warmup-0",
		});
		const measured = mintPhaseAAttestationFixture({
			executionPurpose: "pilot",
			repetitionKind: "measured",
			repetitionIndex: 1,
			repetitionTotal: 1,
			runId: "c/cell/ws/measured-1",
		});
		expect(
			verifyArmAttestationEvidence(warmup.attestation, measured.trust, {
				...PHASE_A_IDENTITY,
				executionSha256: measured.executionSha256,
			}).ok,
		).toBe(false);
	});
});

/**
 * R6: the verifier used to hard-refuse any non-null cohort, which made it wrong
 * for the six primary fanout cells. The cohort requirement is now
 * `requiresCohortObservationEvidence`'s decision, asked from the arm identity,
 * and both directions refuse rather than default.
 */
describe("server-observation-artifact: cohort shape by cell identity", () => {
	const COHORT_CELL = FANOUT_COHORT_CELL_IDS[0]!;

	it("phase_b_cohort_cell_with_a_non_null_cohort_verifies", () => {
		const fx = mintPhaseAAttestationFixture({
			cellId: COHORT_CELL,
			grantDeclaration: "fanout-expanded-deliveries",
		});
		const withCohort = {
			...cloneAttestation(fx.attestation),
			cohortObservationEvidence: cohortEvidence(),
		};
		const result = verifyArmAttestationEvidence(withCohort, fx.trust, {
			cellId: COHORT_CELL,
			armKind: "primary",
			executionSha256: fx.executionSha256,
		});
		expect(result).toEqual({ ok: true });
	});

	it("phase_b_cohort_cell_with_a_null_cohort_is_refused", () => {
		const fx = mintPhaseAAttestationFixture({ cellId: COHORT_CELL });
		expect(fx.attestation.cohortObservationEvidence).toBeNull();
		const result = verifyArmAttestationEvidence(fx.attestation, fx.trust, {
			cellId: COHORT_CELL,
			armKind: "primary",
			executionSha256: fx.executionSha256,
		});
		expect(result.ok).toBe(false);
		expect(result).toMatchObject({ code: "COHORT_PROTOCOL" });
	});

	it("phase_a_cell_with_a_non_null_cohort_is_refused", () => {
		const fx = mintPhaseAAttestationFixture();
		const withCohort = {
			...cloneAttestation(fx.attestation),
			cohortObservationEvidence: cohortEvidence(),
		};
		const result = verifyArmAttestationEvidence(withCohort, fx.trust, {
			...PHASE_A_IDENTITY,
			executionSha256: fx.executionSha256,
		});
		expect(result.ok).toBe(false);
		expect(result).toMatchObject({ code: "COHORT_PROTOCOL" });
	});

	it("read_path_arm_of_a_cohort_cell_still_carries_no_cohort", () => {
		const fx = mintPhaseAAttestationFixture({ cellId: COHORT_CELL });
		expect(
			verifyArmAttestationEvidence(fx.attestation, fx.trust, {
				cellId: COHORT_CELL,
				armKind: "read-path",
				executionSha256: fx.executionSha256,
			}),
		).toEqual({ ok: true });
	});

	it("a_fanout_primary_declares_the_expansion_and_is_admitted_as_a_count_series_over_its_windows", () => {
		// Plan 2142: the admitted series of a Phase-B arm is the count series
		// (`sampleUnit:"count"`, `sampleCount = windowCount`, `spanMs =
		// measuredDurationMs`), and the grant declares the cell's expanded
		// deliveries -- never the Phase-A bulk literals.
		const fx = mintPhaseAAttestationFixture({
			cellId: COHORT_CELL,
			grantDeclaration: "fanout-expanded-deliveries",
		});
		// The first table id is ticker 25: 250 offered, expanded to 100 subscribers.
		expect(fx.grant.declaredMessageCount).toBe(25_000);
		const withCohort = {
			...cloneAttestation(fx.attestation),
			cohortObservationEvidence: cohortEvidence(),
		};
		expect(
			verifyArmAttestationEvidence(withCohort, fx.trust, {
				cellId: COHORT_CELL,
				armKind: "primary",
				executionSha256: fx.executionSha256,
			}),
		).toEqual({ ok: true });
		// The same graph re-read as a Phase-A arm is refused: a fanout
		// declaration on an arm that runs no cohort.
		const asPhaseA = verifyArmAttestationEvidence(
			{ ...cloneAttestation(fx.attestation), cohortObservationEvidence: null },
			fx.trust,
			{
				cellId: COHORT_CELL,
				armKind: "read-path",
				executionSha256: fx.executionSha256,
			},
		);
		expect(asPhaseA.ok).toBe(false);
		expect(asPhaseA).toMatchObject({ code: "COHORT_PROTOCOL" });
	});

	it("a_cohort_primary_whose_execution_declares_the_phase_a_transfer_is_refused", () => {
		// The cohort is decided by the arm identity; an execution that opened
		// under the bulk-transfer declaration on a cohort primary describes a
		// single-session leg, and a cohort export beside it is not evidence of
		// the arm the index names.
		const fx = mintPhaseAAttestationFixture({ cellId: COHORT_CELL });
		expect(fx.execution.grantDeclaration).toBe("phase-a-completed-transfer");
		const withCohort = {
			...cloneAttestation(fx.attestation),
			cohortObservationEvidence: cohortEvidence(),
		};
		const result = verifyArmAttestationEvidence(withCohort, fx.trust, {
			cellId: COHORT_CELL,
			armKind: "primary",
			executionSha256: fx.executionSha256,
		});
		expect(result.ok).toBe(false);
		expect(result).toMatchObject({ code: "COHORT_PROTOCOL" });
	});

	it("cohort_member_whose_retained_digest_was_rewritten_is_refused", () => {
		const fx = mintPhaseAAttestationFixture({
			cellId: COHORT_CELL,
			grantDeclaration: "fanout-expanded-deliveries",
		});
		const cohort = cohortEvidence() as unknown as Record<
			string,
			{ sha256: string }
		>;
		cohort.cohortGrant = {
			...cohort.cohortGrant!,
			sha256: H("rewritten-cohort-grant"),
		};
		const withCohort = {
			...cloneAttestation(fx.attestation),
			cohortObservationEvidence:
				cohort as unknown as CohortObservationEvidenceV1,
		};
		const result = verifyArmAttestationEvidence(withCohort, fx.trust, {
			cellId: COHORT_CELL,
			armKind: "primary",
			executionSha256: fx.executionSha256,
		});
		expect(result.ok).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// §2.11 -- `rig-measure-start-ack/v1`, the one codec this module owns on both
// sides of the language boundary.
//
// The literal below is pinned in Rust at
// `crates/native/tests/rig_cohort_runtime.rs`
// (`RUST_PINNED_MEASURE_START_ACK_HEX`) and asserted here against this
// module's own type. A key added, renamed or removed on either side moves the
// bytes, and a slice that moves them alone breaks the other language's test.
// ---------------------------------------------------------------------------

/** The bytes `secure_fs::cohort::rig`'s `finish_warmup` mint produces. */
const RUST_PINNED_MEASURE_START_ACK_HEX =
	"7b22617070726f76616c5265636f7264536861323536223a2264346434643464346434643464346434643464346434643464346434643464346434643464346434643464346434643464346434643464346434643464346434222c22617070726f766564506c616e536861323536223a2264336433643364336433643364336433643364336433643364336433643364336433643364336433643364336433643364336433643364336433643364336433222c22626173656c696e6541744c696e75784e73223a2236323030303030303030222c22626173656c696e65427573794d73223a31372c226368696c64526573706f6e736553657175656e6365223a332c22657865637574696f6e536861323536223a2265316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531653165316531222c2269737375656441744d73223a313736303030303130303030302c226c696e7578436c6f636b4964223a2263636363636363636363636363636363636363636363636363636363636363636363636363636363636363636363636363636363636363636363636363636363222c226d6163457865637574696f6e4772616e7452656365697074536861323536223a2264326432643264326432643264326432643264326432643264326432643264326432643264326432643264326432643264326432643264326432643264326432222c226d6561737572656d656e744772616e74536861323536223a2264316431643164316431643164316431643164316431643164316431643164316431643164316431643164316431643164316431643164316431643164316431222c226e6f7441667465724d73223a313736303030303730303030302c227265636569707453657175656e6365223a322c22726967457865637574696f6e416363657074616e6365536861323536223a2261326132613261326132613261326132613261326132613261326132613261326132613261326132613261326132613261326132613261326132613261326132222c2272696753757065727669736f72496e7374616e63654e6f6e6365223a2263336333633363336333633363336333633363336333633363336333633363336333633363336333633363336333633363336333633363336333633363336333222c227269675761726d7570447261696e656452656365697074536861323536223a2264356435643564356435643564356435643564356435643564356435643564356435643564356435643564356435643564356435643564356435643564356435222c22736368656d61223a227269672d6d6561737572652d73746172742d61636b2f7631222c227369676e696e675075626c69634b6579536861323536223a2264366436643664366436643664366436643664366436643664366436643664366436643664366436643664366436643664366436643664366436643664366436222c227761726d7570436f6d706c6574696f6e417574686f72697479536861323536223a2238383838383838383838383838383838383838383838383838383838383838383838383838383838383838383838383838383838383838383838383838383838227d0a";

function hexOfBytes(bytes: Uint8Array): string {
	return Array.from(bytes)
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

function repeatDigest(byte: string): string {
	return byte.repeat(32);
}

describe("rig-measure-start-ack/v1 conformance", () => {
	const record: RigMeasureStartAckV1 = {
		schema: "rig-measure-start-ack/v1",
		executionSha256: repeatDigest("e1"),
		measurementGrantSha256: repeatDigest("d1"),
		macExecutionGrantReceiptSha256: repeatDigest("d2"),
		rigExecutionAcceptanceSha256: repeatDigest("a2"),
		approvedPlanSha256: repeatDigest("d3"),
		approvalRecordSha256: repeatDigest("d4"),
		childResponseSequence: 3,
		baselineBusyMs: 17,
		baselineAtLinuxNs: "6200000000",
		linuxClockId: repeatDigest("cc"),
		warmupCompletionAuthoritySha256: repeatDigest("88"),
		rigWarmupDrainedReceiptSha256: repeatDigest("d5"),
		signingPublicKeySha256: repeatDigest("d6"),
		rigSupervisorInstanceNonce: repeatDigest("c3"),
		receiptSequence: 2,
		issuedAtMs: 1_760_000_100_000,
		notAfterMs: 1_760_000_700_000,
	};

	it("encodes the bytes the Rust mint pinned", () => {
		expect(hexOfBytes(bytesOfCanonical(record as never))).toBe(
			RUST_PINNED_MEASURE_START_ACK_HEX,
		);
	});

	it("carries exactly the key set §2.11 settled", () => {
		expect(Object.keys(record).sort()).toEqual([...RIG_MEASURE_START_ACK_KEYS]);
	});

	it("keeps the two warmup digests apart", () => {
		// They are not synonyms: the first is the Mac's signed manifest, the
		// second is the rig's own receipt over the Linux drain. Collapsing them
		// -- which is what the record carried before §2.11 -- loses the ability
		// to show that the rig saw the Linux side drain.
		expect(record.warmupCompletionAuthoritySha256).not.toBe(
			record.rigWarmupDrainedReceiptSha256,
		);
		expect(RIG_MEASURE_START_ACK_KEYS).toContain(
			"warmupCompletionAuthoritySha256",
		);
		expect(RIG_MEASURE_START_ACK_KEYS).toContain(
			"rigWarmupDrainedReceiptSha256",
		);
		// The plan's frame-envelope fields are absent: they belong to
		// `rig-measure-started-ack/v1`, the frame this record travels inside.
		expect(RIG_MEASURE_START_ACK_KEYS).not.toContain("responseSeq");
		expect(RIG_MEASURE_START_ACK_KEYS).not.toContain("ackRequestSeq");
	});
});

// ---------------------------------------------------------------------------
// Physical-budget amendment D6 -- `serverChildCpu` on
// `rig-server-snapshot-receipt/v1`: the rig's own reading of the child's
// process and main-thread CPU over its window, beside the child's `busyMs`.
// The receipt has no hex pin (the fixture graph is minted at test time); its
// key set is asserted here against the Rust mint's, and the verifier's
// invariants are proved by execution against re-encoded receipts.
// ---------------------------------------------------------------------------

describe("D6: attested server-child CPU on the snapshot receipt", () => {
	function snapshotReceipt(
		attestation: ReturnType<typeof mintPhaseAAttestationFixture>["attestation"],
	): RigServerSnapshotReceiptV1 {
		const observation = attestation.serverObservationEvidence as unknown as {
			readonly rigServerSnapshotReceiptBase64: string;
		};
		return JSON.parse(
			Buffer.from(
				observation.rigServerSnapshotReceiptBase64,
				"base64",
			).toString("utf8"),
		) as RigServerSnapshotReceiptV1;
	}

	function withReceipt(
		fx: ReturnType<typeof mintPhaseAAttestationFixture>,
		receipt: Record<string, unknown>,
	) {
		const mutated = replaceEmbeddedBase64Field(
			fx.attestation,
			"rigServerSnapshotReceiptBase64",
			toBase64(bytesOfCanonical(receipt as never)),
		);
		return verifyArmAttestationEvidence(mutated, fx.trust, {
			...PHASE_A_IDENTITY,
			executionSha256: fx.executionSha256,
		});
	}

	it("the minted receipt carries exactly the key set the Rust mint has, with the three figures", () => {
		const fx = mintPhaseAAttestationFixture({ busyMs: 65, spanMs: 1_250 });
		const receipt = snapshotReceipt(fx.attestation);
		expect(Object.keys(receipt).sort()).toEqual([
			...RIG_SERVER_SNAPSHOT_RECEIPT_KEYS,
		]);
		expect(receipt.serverChildCpu).toEqual(fx.serverChildCpu);
		expect(receipt.serverChildCpu.windowMs).toBe(1_250);
		expect(receipt.serverChildCpu.mainThreadMs).toBeLessThanOrEqual(
			receipt.serverChildCpu.processMs,
		);
		const honest = verifyArmAttestationEvidence(fx.attestation, fx.trust, {
			...PHASE_A_IDENTITY,
			executionSha256: fx.executionSha256,
		});
		expect(honest.ok).toBe(true);
	});

	it("a figure that is not a non-negative integer, a main thread ahead of its process, or an empty window is refused by name", () => {
		const fx = mintPhaseAAttestationFixture();
		const receipt = snapshotReceipt(fx.attestation);
		const broken: unknown[] = [
			{ processMs: 100, mainThreadMs: 101, windowMs: 1_250 },
			{ processMs: -1, mainThreadMs: 0, windowMs: 1_250 },
			{ processMs: 1.5, mainThreadMs: 0, windowMs: 1_250 },
			{ processMs: "100", mainThreadMs: 0, windowMs: 1_250 },
			{ processMs: 100, mainThreadMs: 10, windowMs: 0 },
			{ processMs: 100, mainThreadMs: 10 },
			{ processMs: 100, mainThreadMs: 10, windowMs: 1_250, instrument: "x" },
			null,
			[100, 10, 1_250],
		];
		for (const serverChildCpu of broken) {
			const result = withReceipt(fx, { ...receipt, serverChildCpu });
			expect(result.ok).toBe(false);
			if (result.ok) continue;
			expect(result.code).toBe("TRUST_PROTOCOL");
			expect(result.message).toContain("serverChildCpu");
		}
	});

	it("a receipt without serverChildCpu is a different record, not a lenient one", () => {
		const fx = mintPhaseAAttestationFixture();
		const { serverChildCpu: _dropped, ...without } = snapshotReceipt(
			fx.attestation,
		);
		const result = withReceipt(fx, without);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.message).toContain("rig snapshot receipt key set");
		expect(result.message).toContain("27 keys");
	});

	it("serverChildCpuIssue names every invariant and passes the honest shape", () => {
		expect(
			serverChildCpuIssue({ processMs: 0, mainThreadMs: 0, windowMs: 1 }),
		).toBeNull();
		expect(
			serverChildCpuIssue({ processMs: 5, mainThreadMs: 6, windowMs: 1 }),
		).toContain("exceeds");
		expect(
			serverChildCpuIssue({ processMs: 5, mainThreadMs: 5, windowMs: 0 }),
		).toContain("windowMs is 0");
		expect(serverChildCpuIssue({ processMs: 5, mainThreadMs: 5 })).toContain(
			"keys",
		);
		expect(serverChildCpuIssue(undefined)).toContain("not an object");
	});
});
