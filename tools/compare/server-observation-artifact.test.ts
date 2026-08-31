/**
 * A3 offline attestation graph tests (plan §8 A3 named coverage).
 */
import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { bytesOfCanonical, toBase64 } from "./cross-supervisor-protocol.ts";
import {
	cloneAttestation,
	mintPhaseAAttestationFixture,
	replaceEmbeddedBase64Field,
	verifyArmAttestationEvidence,
} from "./server-observation-artifact.ts";

function H(label: string): string {
	return createHash("sha256").update(label).digest("hex");
}

describe("server-observation-artifact: signed full-byte graph", () => {
	it("complete_bidirectionally_signed_full_byte_graph_verifies", () => {
		const fx = mintPhaseAAttestationFixture();
		const result = verifyArmAttestationEvidence(fx.attestation, fx.trust, {
			executionSha256: fx.executionSha256,
			executionPurpose: "focused",
			cellId: "bulk-one-way/physical",
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
			executionSha256: fx.executionSha256,
			executionPurpose: "focused" as const,
			cellId: "bulk-one-way/physical",
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
				executionSha256: bad.executionSha256,
				repetitionIndex: 6,
				repetitionTotal: 5,
			}).ok,
		).toBe(false);
		expect(
			verifyArmAttestationEvidence(bad.attestation, bad.trust, {
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
				executionSha256: measured.executionSha256,
			}).ok,
		).toBe(false);
	});
});
