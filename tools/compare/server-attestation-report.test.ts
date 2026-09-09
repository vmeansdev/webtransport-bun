/**
 * Diagnostic report rules for attested arms (plan §6 report rules / A3).
 */
import { describe, expect, it } from "bun:test";
import { mintPhaseAAttestationFixture } from "./cohort-fixture-signing.ts";

export type AttestationLabel = "attested" | "unattested" | "not-applicable";

export function labelArmAttestation(input: {
	readonly hasAttestationEvidence: boolean;
	readonly armKind: "primary" | "read-path" | "overlay";
}): AttestationLabel {
	if (input.armKind === "overlay") return "not-applicable";
	return input.hasAttestationEvidence ? "attested" : "unattested";
}

export function reportIncompleteAttestationCaveat(
	labels: readonly AttestationLabel[],
): boolean {
	return labels.some((label) => label === "unattested");
}

export function serverAggregateTransparencyNote(): string {
	return "aggregate receive-loop work over Linux baseline-to-capture window; transparency only; may exceed 1x window";
}

describe("server-attestation-report", () => {
	it("diagnostic_render_without_flats_labels_attested_arms", () => {
		const fx = mintPhaseAAttestationFixture();
		const labels = [
			labelArmAttestation({
				hasAttestationEvidence: true,
				armKind: "primary",
			}),
			labelArmAttestation({
				hasAttestationEvidence: true,
				armKind: "primary",
			}),
		];
		expect(labels).toEqual(["attested", "attested"]);
		expect(reportIncompleteAttestationCaveat(labels)).toBe(false);
		expect(fx.attestation.schema).toBe("arm-attestation-evidence/v2");
		expect(serverAggregateTransparencyNote()).toContain("transparency only");
	});

	it("unattested_primary_forces_incomplete_attestation_caveat", () => {
		const labels: AttestationLabel[] = [
			"attested",
			"unattested",
			"not-applicable",
		];
		expect(reportIncompleteAttestationCaveat(labels)).toBe(true);
	});
});
