import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CAMPAIGN_INDEX_V2_SCHEMA,
	type CampaignIndexEntryV2,
	type CampaignIndexV2,
	verifyCampaignIndex,
} from "./verify-campaign-index.ts";

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
