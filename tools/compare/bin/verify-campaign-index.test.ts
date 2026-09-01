import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sealRunArtifact } from "../compare.ts";
import type { RunArtifact } from "../evidence.ts";
import {
	CAMPAIGN_INDEX_V2_SCHEMA,
	type CampaignIndexEntryV2,
	type CampaignIndexV2,
	verifyCampaignIndex,
} from "./verify-campaign-index.ts";

/**
 * A real measured artifact, sealed from the golden fixture. Its embedded
 * source identity is what an honest campaign index must anchor against.
 */
function sealedFixtureArtifact(): {
	readonly bytes: Uint8Array;
	readonly artifact: RunArtifact;
} {
	const artifact = JSON.parse(
		new TextDecoder().decode(
			readFileSync(join(import.meta.dir, "..", "fixtures", "valid-ws-run.json")),
		),
	) as RunArtifact;
	artifact.artifactKind = "measured";
	const bytes = sealRunArtifact(artifact);
	return {
		bytes,
		artifact: JSON.parse(new TextDecoder().decode(bytes)) as RunArtifact,
	};
}

function entry(
	partial: Partial<CampaignIndexEntryV2> &
		Pick<CampaignIndexEntryV2, "cellId" | "armId" | "status">,
): CampaignIndexEntryV2 {
	return {
		schema: "campaign-index-entry/v2",
		transport: "ws",
		armKind: "primary",
		armTransport: "ws",
		impairment: "none",
		executionPurpose: "focused",
		repetitionKind: "measured",
		repetitionIndex: 1,
		repetitionTotal: 1,
		promotable: false,
		failureCode: null,
		refusalCode: null,
		sealedPath: null,
		artifactSha256: null,
		primaryMetricP50: null,
		readPath: null,
		...partial,
	};
}

describe("verify-campaign-index", () => {
	// The A5 regression class: the verifier fabricated its trust context
	// (placeholder digests, the campaign run id for a per-rep run id, an
	// unknown context field) so no sealed artifact could ever verify --
	// honest and dishonest seals were indistinguishable. The context must be
	// the index's staged anchors joined with the artifact's own per-rep
	// identity, so a matching seal passes and a swapped anchor is named.
	it("verifies_a_pass_entry_whose_seal_matches_the_staged_anchors", () => {
		const { bytes, artifact } = sealedFixtureArtifact();
		const root = mkdtempSync(join(tmpdir(), "vci-anchors-"));
		mkdirSync(join(root, "reps", "bulk-one-way_physical", "ws"), {
			recursive: true,
		});
		const sealedRel = join(
			"reps",
			"bulk-one-way_physical",
			"ws",
			"rep-1.sealed.json",
		);
		writeFileSync(join(root, sealedRel), bytes);
		const indexPath = join(root, "campaign-index.json");
		const index: CampaignIndexV2 = {
			schema: CAMPAIGN_INDEX_V2_SCHEMA,
			campaignRunId: "run",
			stage: "full",
			candidate: artifact.source.sourceSha,
			campaignId: artifact.comparisonId,
			approvedPlanSha256: "1".repeat(64),
			approvalRecordSha256: "2".repeat(64),
			stagedCapabilitySha256: artifact.source.executableSha256,
			sourceArchiveSha256: artifact.source.archiveSha256,
			executionPurpose: "focused",
			cells: ["bulk-one-way/physical"],
			arms: ["ws"],
			armKinds: ["primary"],
			warmupRepetitions: 1,
			measuredRepetitions: 1,
			scheduledMeasuredArms: 1,
			entries: [
				entry({
					cellId: "bulk-one-way/physical",
					armId: "bulk-one-way/physical/ws",
					status: "PASS",
					sealedPath: sealedRel,
					artifactSha256: createHash("sha256").update(bytes).digest("hex"),
					primaryMetricP50: 1,
				}),
			],
		};
		writeFileSync(indexPath, `${JSON.stringify(index)}\n`);
		const result = verifyCampaignIndex({
			campaignRoot: root,
			indexPath,
			externalTrustBoundSha256: "4".repeat(64),
		});
		expect(result).toEqual({
			ok: true,
			passCount: 1,
			failCount: 0,
			refusedCount: 0,
			promotableCount: 0,
			sealedCount: 1,
		});
	});

	it("names_the_anchor_when_a_staged_digest_does_not_match_the_seal", () => {
		const { bytes, artifact } = sealedFixtureArtifact();
		const root = mkdtempSync(join(tmpdir(), "vci-anchor-swap-"));
		mkdirSync(join(root, "reps", "bulk-one-way_physical", "ws"), {
			recursive: true,
		});
		const sealedRel = join(
			"reps",
			"bulk-one-way_physical",
			"ws",
			"rep-1.sealed.json",
		);
		writeFileSync(join(root, sealedRel), bytes);
		const indexPath = join(root, "campaign-index.json");
		const index: CampaignIndexV2 = {
			schema: CAMPAIGN_INDEX_V2_SCHEMA,
			campaignRunId: "run",
			stage: "full",
			candidate: artifact.source.sourceSha,
			campaignId: artifact.comparisonId,
			approvedPlanSha256: "1".repeat(64),
			approvalRecordSha256: "2".repeat(64),
			// A staged capability the seal was not produced under.
			stagedCapabilitySha256: "9".repeat(64),
			sourceArchiveSha256: artifact.source.archiveSha256,
			executionPurpose: "focused",
			cells: ["bulk-one-way/physical"],
			arms: ["ws"],
			armKinds: ["primary"],
			warmupRepetitions: 1,
			measuredRepetitions: 1,
			scheduledMeasuredArms: 1,
			entries: [
				entry({
					cellId: "bulk-one-way/physical",
					armId: "bulk-one-way/physical/ws",
					status: "PASS",
					sealedPath: sealedRel,
					artifactSha256: createHash("sha256").update(bytes).digest("hex"),
					primaryMetricP50: 1,
				}),
			],
		};
		writeFileSync(indexPath, `${JSON.stringify(index)}\n`);
		const result = verifyCampaignIndex({
			campaignRoot: root,
			indexPath,
			externalTrustBoundSha256: "4".repeat(64),
		});
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected failure");
		expect(result.message).toContain("TRUST_ANCHOR_MISMATCH");
		expect(result.message).toContain("executableSha256");
	});

	it("rejects_index_json_as_artifact_and_path_mismatch", () => {
		const root = mkdtempSync(join(tmpdir(), "vci-"));
		const indexPath = join(root, "campaign-index.json");
		const index: CampaignIndexV2 = {
			schema: CAMPAIGN_INDEX_V2_SCHEMA,
			campaignRunId: "run",
			stage: "full",
			candidate: "a".repeat(40),
			campaignId: "c",
			approvedPlanSha256: "1".repeat(64),
			approvalRecordSha256: "2".repeat(64),
			stagedCapabilitySha256: "3".repeat(64),
			sourceArchiveSha256: "5".repeat(64),
			executionPurpose: "focused",
			cells: ["bulk-one-way/physical"],
			arms: ["ws"],
			armKinds: ["primary"],
			warmupRepetitions: 1,
			measuredRepetitions: 1,
			scheduledMeasuredArms: 1,
			entries: [
				entry({
					cellId: "bulk-one-way/physical",
					armId: "bulk-one-way/physical/ws",
					status: "PASS",
					sealedPath: "campaign-index.json",
					artifactSha256: "0".repeat(64),
				}),
			],
		};
		writeFileSync(indexPath, `${JSON.stringify(index)}\n`);
		const result = verifyCampaignIndex({
			campaignRoot: root,
			indexPath,
			externalTrustBoundSha256: "4".repeat(64),
		});
		expect(result.ok).toBe(false);
	});

	it("rejects_unindexed_sealed_and_duplicates", () => {
		const root = mkdtempSync(join(tmpdir(), "vci2-"));
		mkdirSync(join(root, "seals"), { recursive: true });
		writeFileSync(join(root, "seals", "orphan.sealed.json"), "{}\n");
		const indexPath = join(root, "campaign-index.json");
		const index: CampaignIndexV2 = {
			schema: CAMPAIGN_INDEX_V2_SCHEMA,
			campaignRunId: "run",
			stage: "full",
			candidate: "a".repeat(40),
			campaignId: "c",
			approvedPlanSha256: "1".repeat(64),
			approvalRecordSha256: "2".repeat(64),
			stagedCapabilitySha256: "3".repeat(64),
			sourceArchiveSha256: "5".repeat(64),
			executionPurpose: "focused",
			cells: [],
			arms: ["ws"],
			armKinds: ["primary"],
			warmupRepetitions: 1,
			measuredRepetitions: 1,
			scheduledMeasuredArms: 0,
			entries: [
				entry({
					cellId: "a",
					armId: "a/ws",
					status: "REFUSED",
					refusalCode: "RIG_UNREACHABLE",
					promotable: false,
				}),
				entry({
					cellId: "a",
					armId: "a/ws",
					status: "REFUSED",
					refusalCode: "RIG_UNREACHABLE",
					promotable: false,
				}),
			],
		};
		writeFileSync(indexPath, `${JSON.stringify(index)}\n`);
		const result = verifyCampaignIndex({
			campaignRoot: root,
			indexPath,
			externalTrustBoundSha256: "4".repeat(64),
		});
		expect(result.ok).toBe(false);
	});

	it("external_trust_bound_recursion_requires_flag", () => {
		const root = mkdtempSync(join(tmpdir(), "vci3-"));
		const indexPath = join(root, "campaign-index.json");
		const index: CampaignIndexV2 = {
			schema: CAMPAIGN_INDEX_V2_SCHEMA,
			campaignRunId: "run",
			stage: "full",
			candidate: "a".repeat(40),
			campaignId: "c",
			approvedPlanSha256: "1".repeat(64),
			approvalRecordSha256: "2".repeat(64),
			stagedCapabilitySha256: "3".repeat(64),
			sourceArchiveSha256: "5".repeat(64),
			executionPurpose: "focused",
			cells: [],
			arms: ["ws"],
			armKinds: ["primary"],
			warmupRepetitions: 1,
			measuredRepetitions: 1,
			scheduledMeasuredArms: 0,
			entries: [],
		};
		writeFileSync(indexPath, `${JSON.stringify(index)}\n`);
		const ok = verifyCampaignIndex({
			campaignRoot: root,
			indexPath,
			externalTrustBoundSha256: "4".repeat(64),
			expectedPassCount: 0,
			expectedFailCount: 0,
			expectedRefusedCount: 0,
			expectedPromotableCount: 0,
			expectedFlatCount: 0,
			expectedPairCount: 0,
		});
		expect(ok).toEqual({
			ok: true,
			passCount: 0,
			failCount: 0,
			refusedCount: 0,
			promotableCount: 0,
			sealedCount: 0,
		});
	});

	it("expected_flat_count_zero_rejects_top_level_flat_json", () => {
		const root = mkdtempSync(join(tmpdir(), "vci-flats-"));
		const indexPath = join(root, "campaign-index.json");
		const index: CampaignIndexV2 = {
			schema: CAMPAIGN_INDEX_V2_SCHEMA,
			campaignRunId: "run",
			stage: "full",
			candidate: "a".repeat(40),
			campaignId: "c",
			approvedPlanSha256: "1".repeat(64),
			approvalRecordSha256: "2".repeat(64),
			stagedCapabilitySha256: "3".repeat(64),
			sourceArchiveSha256: "5".repeat(64),
			executionPurpose: "focused",
			cells: [],
			arms: ["ws"],
			armKinds: ["primary"],
			warmupRepetitions: 1,
			measuredRepetitions: 1,
			scheduledMeasuredArms: 0,
			entries: [],
		};
		writeFileSync(indexPath, `${JSON.stringify(index)}\n`);
		writeFileSync(join(root, "bulk-one-way_physical-ws.json"), "{}\n");
		writeFileSync(join(root, "bulk-one-way_physical-wt.json"), "{}\n");
		const bad = verifyCampaignIndex({
			campaignRoot: root,
			indexPath,
			externalTrustBoundSha256: "4".repeat(64),
			expectedPassCount: 0,
			expectedFailCount: 0,
			expectedRefusedCount: 0,
			expectedPromotableCount: 0,
			expectedFlatCount: 0,
			expectedPairCount: 0,
		});
		expect(bad.ok).toBe(false);
		if (bad.ok) throw new Error("expected failure");
		expect(bad.message).toContain("expectedFlatCount mismatch");
	});
});
