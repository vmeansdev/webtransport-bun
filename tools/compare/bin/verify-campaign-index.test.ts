import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Canonical } from "../canonical.ts";
import { mintPhaseAAttestationFixture } from "../cohort-fixture-signing.ts";
import { sealRunArtifact } from "../compare.ts";
import { FANOUT_COHORT_CELL_IDS, type RunArtifact } from "../evidence.ts";
import type { AttestationTrustMaterial } from "../server-observation-artifact.ts";
import {
	CAMPAIGN_INDEX_V2_SCHEMA,
	type CampaignIndexEntryV2,
	type CampaignIndexV2,
	checkExpectedTotals,
	main,
	parseVerifyCampaignIndexArgs,
	validateIndexEntryConsistency,
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
			readFileSync(
				join(import.meta.dir, "..", "fixtures", "valid-ws-run.json"),
			),
		),
	) as RunArtifact;
	artifact.artifactKind = "measured";
	// `cohortEvidenceExport` is a required own field on `RunArtifact` since B4.
	// `bulk-one-way/physical` runs no cohort, so the honest value is `null`;
	// the on-disk fixture predates the field and is not this slice's to edit.
	artifact.cohortEvidenceExport = null;
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
			flatCount: 0,
			pairCount: 0,
			promotedCells: [],
			canonicalFanoutComplete: false,
			integrityOnly: false,
			attestationsVerified: 0,
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
			flatCount: 0,
			pairCount: 0,
			promotedCells: [],
			canonicalFanoutComplete: false,
			integrityOnly: false,
			attestationsVerified: 0,
		});
	});

	// The run wrapper writes controller-terminal.json at the campaign root and
	// parses it to correlate the controller's exit code with the terminal
	// kind; it is run-control metadata, not an echo flat. Counting it as a
	// flat made every wrapper-protocol run fail the zero-flat focused gate
	// after an otherwise clean integrity pass.
	it("does_not_count_the_controller_terminal_record_as_a_flat", () => {
		const root = mkdtempSync(join(tmpdir(), "vci-terminal-"));
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
		writeFileSync(join(root, "controller-terminal.json"), "{}\n");
		const result = verifyCampaignIndex({
			campaignRoot: root,
			indexPath,
			externalTrustBoundSha256: "4".repeat(64),
			expectedFlatCount: 0,
		});
		expect(result.ok).toBe(true);
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
		// The zero-flat rule for focused/pilot is unconditional and fires before
		// the caller's own count assertion, so the message names the rule that
		// was actually broken rather than the option that happened to be set.
		expect(bad.message).toContain("focused campaigns write zero flats");
		expect(bad.message).toContain("bulk-one-way_physical-ws.json");
	});
});

/** A minimal index skeleton; every field a test does not care about is fixed. */
function indexOf(partial: Partial<CampaignIndexV2> = {}): CampaignIndexV2 {
	return {
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
		...partial,
	};
}

function writeIndex(root: string, index: CampaignIndexV2): string {
	const indexPath = join(root, "campaign-index.json");
	writeFileSync(indexPath, `${JSON.stringify(index)}\n`);
	return indexPath;
}

function expectRejection(result: ReturnType<typeof verifyCampaignIndex>): {
	readonly code: string;
	readonly message: string;
} {
	if (result.ok) throw new Error("expected a refusal, got ok");
	return result;
}

const TRUST_BOUND = "4".repeat(64);

/**
 * The golden fixture resealed around a freshly minted attestation graph, so the
 * test holds the very public keys the seal's signatures were taken under.
 *
 * The on-disk fixture's signers are not in the repo; without this the index
 * verifier could only ever be shown refusing. `rawSidecarDigests` and their
 * binding are recomputed because the attestation's client-series and snapshot
 * digests are what those fields bind.
 */
function attestedFixtureArtifact(options?: {
	readonly cellId?: string;
	readonly campaignId?: string;
}): {
	readonly bytes: Uint8Array;
	readonly artifact: RunArtifact;
	readonly trust: AttestationTrustMaterial;
	readonly approvedPlanSha256: string;
	readonly approvalRecordSha256: string;
} {
	const artifact = JSON.parse(
		new TextDecoder().decode(
			readFileSync(
				join(import.meta.dir, "..", "fixtures", "valid-ws-run.json"),
			),
		),
	) as RunArtifact & Record<string, unknown>;
	artifact.artifactKind = "measured";
	artifact.cohortEvidenceExport = null;
	const fx = mintPhaseAAttestationFixture({
		executionPurpose: "focused",
		repetitionKind: "measured",
		repetitionIndex: 1,
		repetitionTotal: 1,
		transport: "ws",
		cellId: options?.cellId ?? "bulk-one-way/physical",
		campaignId: options?.campaignId ?? artifact.comparisonId,
		candidate: artifact.source.sourceSha,
		runId: artifact.runId,
	});
	artifact.attestationEvidence = fx.attestation;
	artifact.rawSidecarDigests = {
		...artifact.rawSidecarDigests,
		client: fx.observation.admittedClientSeriesSha256,
		server: fx.observation.snapshotFrameSha256,
	};
	artifact.rawSidecarBindingSha256 = sha256Canonical({
		comparisonId: artifact.comparisonId,
		runId: artifact.runId,
		transport: artifact.transport,
		sourceBindingSha256: artifact.source.bindingSha256,
		scenarioHash: artifact.scenario.scenarioHash,
		metricContractHash: artifact.metricContractHash,
		rawSidecarDigests: artifact.rawSidecarDigests,
	});
	const bytes = sealRunArtifact(artifact);
	return {
		bytes,
		artifact: JSON.parse(new TextDecoder().decode(bytes)) as RunArtifact,
		trust: fx.trust,
		approvedPlanSha256: fx.draft.approvedPlanSha256,
		approvalRecordSha256: fx.draft.approvalRecordSha256,
	};
}

/** One-entry campaign whose single seal is the attested fixture. */
function attestedCampaign(options?: {
	readonly cellId?: string;
	readonly campaignId?: string;
}): {
	readonly root: string;
	readonly indexPath: string;
	readonly trust: AttestationTrustMaterial;
} {
	const cellId = options?.cellId ?? "bulk-one-way/physical";
	const { bytes, artifact, trust, approvedPlanSha256, approvalRecordSha256 } =
		attestedFixtureArtifact(options);
	const root = mkdtempSync(join(tmpdir(), "vci-attested-"));
	mkdirSync(join(root, "reps"), { recursive: true });
	const sealedRel = join("reps", "rep-1.sealed.json");
	writeFileSync(join(root, sealedRel), bytes);
	const indexPath = writeIndex(
		root,
		indexOf({
			candidate: artifact.source.sourceSha,
			campaignId: artifact.comparisonId,
			stagedCapabilitySha256: artifact.source.executableSha256,
			sourceArchiveSha256: artifact.source.archiveSha256,
			approvedPlanSha256,
			approvalRecordSha256,
			executionPurpose: "focused",
			cells: [cellId],
			arms: ["ws"],
			armKinds: ["primary"],
			entries: [
				entry({
					cellId,
					armId: `${cellId}/ws`,
					status: "PASS",
					sealedPath: sealedRel,
					artifactSha256: createHash("sha256").update(bytes).digest("hex"),
					primaryMetricP50: 1,
				}),
			],
		}),
	);
	return { root, indexPath, trust };
}

/**
 * R6: `verifyArmAttestationEvidence` had no production caller. These prove it
 * is reached from `verifyCampaignIndex` -- a seal whose graph verifies is
 * counted, and one whose signatures do not verify under the supplied keys is
 * named rather than silently accepted.
 */
describe("verify-campaign-index attestation verification", () => {
	it("verifies_the_attestation_graph_of_each_seal_under_the_staged_keys", () => {
		const { root, indexPath, trust } = attestedCampaign();
		const macKey = join(tmpdir(), `vci-mac-${process.hrtime.bigint()}.pub`);
		const rigKey = join(tmpdir(), `vci-rig-${process.hrtime.bigint()}.pub`);
		writeFileSync(macKey, trust.macPublicRaw32);
		writeFileSync(rigKey, trust.rigPublicRaw32);
		const result = verifyCampaignIndex({
			campaignRoot: root,
			indexPath,
			externalTrustBoundSha256: TRUST_BOUND,
			macPublicKeyPath: macKey,
			rigPublicKeyPath: rigKey,
		});
		expect(result).toMatchObject({
			ok: true,
			sealedCount: 1,
			attestationsVerified: 1,
		});
	});

	it("hands_the_staged_keys_to_each_seals_artifact_verification", () => {
		// A cohort seal verifies offline only with the staged keys in the
		// artifact's own trust context (`reconstructCohortEvidenceOffline`
		// refuses the export receipt without `stagedMacPublicRaw32`), so the
		// keys this verifier loads for the attestation graph must reach that
		// context too. Observable on any seal: `verifyRunArtifact` checks the
		// keys it is handed for shape, and a key that is 32 bytes on disk but
		// not what reached the context cannot be told apart from no key -- so
		// the pin is the negative: a context that carries a key of the wrong
		// shape is refused by the artifact verification, which it can only be
		// if the key travelled.
		const { root, indexPath, trust } = attestedCampaign();
		const macKey = join(tmpdir(), `vci-mac-${process.hrtime.bigint()}.pub`);
		const rigKey = join(tmpdir(), `vci-rig-${process.hrtime.bigint()}.pub`);
		writeFileSync(macKey, trust.macPublicRaw32);
		writeFileSync(rigKey, trust.rigPublicRaw32);
		const keyed = verifyCampaignIndex({
			campaignRoot: root,
			indexPath,
			externalTrustBoundSha256: TRUST_BOUND,
			macPublicKeyPath: macKey,
			rigPublicKeyPath: rigKey,
			artifactVerificationContext: (context) => {
				expect(context.stagedMacPublicRaw32).toEqual(trust.macPublicRaw32);
				expect(context.stagedRigPublicRaw32).toEqual(trust.rigPublicRaw32);
				return context;
			},
		});
		expect(keyed).toMatchObject({ ok: true, attestationsVerified: 1 });
	});

	it("counts_zero_attestations_when_no_trust_keys_are_supplied", () => {
		const { root, indexPath } = attestedCampaign();
		const result = verifyCampaignIndex({
			campaignRoot: root,
			indexPath,
			externalTrustBoundSha256: TRUST_BOUND,
		});
		expect(result).toMatchObject({
			ok: true,
			sealedCount: 1,
			attestationsVerified: 0,
		});
	});

	it("names_a_seal_whose_attestation_does_not_verify_under_the_supplied_keys", () => {
		const { root, indexPath } = attestedCampaign();
		const other = mintPhaseAAttestationFixture();
		const macKey = join(tmpdir(), `vci-mac-bad-${process.hrtime.bigint()}.pub`);
		const rigKey = join(tmpdir(), `vci-rig-bad-${process.hrtime.bigint()}.pub`);
		writeFileSync(macKey, other.trust.macPublicRaw32);
		writeFileSync(rigKey, other.trust.rigPublicRaw32);
		const bad = expectRejection(
			verifyCampaignIndex({
				campaignRoot: root,
				indexPath,
				externalTrustBoundSha256: TRUST_BOUND,
				macPublicKeyPath: macKey,
				rigPublicKeyPath: rigKey,
			}),
		);
		expect(bad.message).toContain("attestation does not verify");
		expect(bad.message).toContain("rep-1.sealed.json");
	});

	// The cohort *shape* of a seal is already named one layer earlier by the
	// index's own presence check, so the attestation verifier's cohort branch is
	// covered where it is decided -- see the cohort-shape tests in
	// server-observation-artifact.test.ts.
});

describe("verify-campaign-index trust flags", () => {
	it("rejects_an_external_trust_bound_that_is_not_a_sha256_digest", () => {
		const root = mkdtempSync(join(tmpdir(), "vci-bound-"));
		const indexPath = writeIndex(root, indexOf());
		const bad = expectRejection(
			verifyCampaignIndex({
				campaignRoot: root,
				indexPath,
				externalTrustBoundSha256: "not-a-digest",
			}),
		);
		expect(bad.message).toContain("externalTrustBoundSha256");
	});

	it("rejects_a_mac_public_key_flag_that_names_no_file", () => {
		const root = mkdtempSync(join(tmpdir(), "vci-mackey-"));
		const indexPath = writeIndex(root, indexOf());
		const bad = expectRejection(
			verifyCampaignIndex({
				campaignRoot: root,
				indexPath,
				externalTrustBoundSha256: TRUST_BOUND,
				macPublicKeyPath: join(root, "absent-mac.key"),
			}),
		);
		expect(bad.message).toContain("--mac-public-key");
	});

	it("rejects_a_rig_public_key_flag_that_names_a_directory", () => {
		const root = mkdtempSync(join(tmpdir(), "vci-rigkey-"));
		const indexPath = writeIndex(root, indexOf());
		mkdirSync(join(root, "keys"));
		const bad = expectRejection(
			verifyCampaignIndex({
				campaignRoot: root,
				indexPath,
				externalTrustBoundSha256: TRUST_BOUND,
				rigPublicKeyPath: join(root, "keys"),
			}),
		);
		expect(bad.message).toContain("--rig-public-key");
	});

	it("accepts_trust_key_flags_that_name_real_files", () => {
		const root = mkdtempSync(join(tmpdir(), "vci-keys-ok-"));
		const indexPath = writeIndex(root, indexOf());
		const macKey = join(root, "mac.key");
		const rigKey = join(root, "rig.key");
		writeFileSync(macKey, new Uint8Array(32).fill(1));
		writeFileSync(rigKey, new Uint8Array(32).fill(2));
		const result = verifyCampaignIndex({
			campaignRoot: root,
			indexPath,
			externalTrustBoundSha256: TRUST_BOUND,
			macPublicKeyPath: macKey,
			rigPublicKeyPath: rigKey,
		});
		// The key files sit at the campaign root but are not `.json`, so they
		// are not flats and the run is clean.
		expect(result.ok).toBe(true);
	});

	it("rejects_a_trust_key_file_that_is_not_a_raw_32_byte_key", () => {
		const root = mkdtempSync(join(tmpdir(), "vci-keys-short-"));
		const indexPath = writeIndex(root, indexOf());
		const macKey = join(root, "mac.key");
		const rigKey = join(root, "rig.key");
		writeFileSync(macKey, "mac");
		writeFileSync(rigKey, new Uint8Array(32).fill(2));
		const bad = expectRejection(
			verifyCampaignIndex({
				campaignRoot: root,
				indexPath,
				externalTrustBoundSha256: TRUST_BOUND,
				macPublicKeyPath: macKey,
				rigPublicKeyPath: rigKey,
			}),
		);
		expect(bad.message).toContain("raw 32-byte Ed25519 public key");
	});

	it("rejects_one_trust_key_flag_without_the_other", () => {
		const root = mkdtempSync(join(tmpdir(), "vci-keys-half-"));
		const indexPath = writeIndex(root, indexOf());
		const macKey = join(root, "mac.key");
		writeFileSync(macKey, new Uint8Array(32).fill(1));
		const bad = expectRejection(
			verifyCampaignIndex({
				campaignRoot: root,
				indexPath,
				externalTrustBoundSha256: TRUST_BOUND,
				macPublicKeyPath: macKey,
			}),
		);
		expect(bad.message).toContain("must be supplied together");
	});
});

describe("verify-campaign-index sealed path rules", () => {
	it("rejects_a_sealed_path_that_escapes_the_campaign_root", () => {
		const root = mkdtempSync(join(tmpdir(), "vci-esc-"));
		const indexPath = writeIndex(
			root,
			indexOf({
				entries: [
					entry({
						cellId: "a",
						armId: "a/ws",
						status: "PASS",
						sealedPath: join("..", "outside.sealed.json"),
						artifactSha256: "0".repeat(64),
					}),
				],
			}),
		);
		const bad = expectRejection(
			verifyCampaignIndex({
				campaignRoot: root,
				indexPath,
				externalTrustBoundSha256: TRUST_BOUND,
			}),
		);
		expect(bad.message).toContain("sealed path traversal");
	});

	it("rejects_a_symlinked_sealed_path", () => {
		const root = mkdtempSync(join(tmpdir(), "vci-link-"));
		const real = join(root, "real.sealed.json");
		writeFileSync(real, "{}\n");
		symlinkSync(real, join(root, "link.sealed.json"));
		const indexPath = writeIndex(
			root,
			indexOf({
				entries: [
					entry({
						cellId: "a",
						armId: "a/ws",
						status: "PASS",
						sealedPath: "link.sealed.json",
						artifactSha256: "0".repeat(64),
					}),
				],
			}),
		);
		const bad = expectRejection(
			verifyCampaignIndex({
				campaignRoot: root,
				indexPath,
				externalTrustBoundSha256: TRUST_BOUND,
			}),
		);
		expect(bad.message).toContain("symlink sealed path");
	});

	it("rejects_an_indexed_seal_that_is_absent", () => {
		const root = mkdtempSync(join(tmpdir(), "vci-absent-"));
		const indexPath = writeIndex(
			root,
			indexOf({
				entries: [
					entry({
						cellId: "a",
						armId: "a/ws",
						status: "PASS",
						sealedPath: "reps/gone.sealed.json",
						artifactSha256: "0".repeat(64),
					}),
				],
			}),
		);
		const bad = expectRejection(
			verifyCampaignIndex({
				campaignRoot: root,
				indexPath,
				externalTrustBoundSha256: TRUST_BOUND,
			}),
		);
		expect(bad.message).toContain("absent");
	});
});

describe("verify-campaign-index purpose rules", () => {
	it("rejects_a_focused_entry_carried_into_a_canonical_index", () => {
		const root = mkdtempSync(join(tmpdir(), "vci-mixed-"));
		const indexPath = writeIndex(
			root,
			indexOf({
				executionPurpose: "canonical",
				measuredRepetitions: 5,
				entries: [
					entry({
						cellId: "a",
						armId: "a/ws",
						status: "REFUSED",
						refusalCode: "RIG_UNREACHABLE",
						executionPurpose: "focused",
					}),
				],
			}),
		);
		const bad = expectRejection(
			verifyCampaignIndex({
				campaignRoot: root,
				indexPath,
				externalTrustBoundSha256: TRUST_BOUND,
			}),
		);
		expect(bad.message).toContain("mixed purpose");
	});

	it("rejects_a_focused_index_entry_that_claims_promotable", () => {
		const { bytes, artifact } = sealedFixtureArtifact();
		const root = mkdtempSync(join(tmpdir(), "vci-focprom-"));
		writeFileSync(join(root, "rep-1.sealed.json"), bytes);
		const indexPath = writeIndex(
			root,
			indexOf({
				candidate: artifact.source.sourceSha,
				campaignId: artifact.comparisonId,
				stagedCapabilitySha256: artifact.source.executableSha256,
				sourceArchiveSha256: artifact.source.archiveSha256,
				entries: [
					entry({
						cellId: "bulk-one-way/physical",
						armId: "bulk-one-way/physical/ws",
						status: "PASS",
						promotable: true,
						sealedPath: "rep-1.sealed.json",
						artifactSha256: createHash("sha256").update(bytes).digest("hex"),
					}),
				],
			}),
		);
		const bad = expectRejection(
			verifyCampaignIndex({
				campaignRoot: root,
				indexPath,
				externalTrustBoundSha256: TRUST_BOUND,
			}),
		);
		expect(bad.message).toContain("claims promotable:true");
	});

	it("focused_index_rejects_any_flat_without_being_asked", () => {
		const root = mkdtempSync(join(tmpdir(), "vci-focflat-"));
		const indexPath = writeIndex(root, indexOf());
		writeFileSync(join(root, "ticker-fanout_rate-100-ws.json"), "{}\n");
		const bad = expectRejection(
			verifyCampaignIndex({
				campaignRoot: root,
				indexPath,
				externalTrustBoundSha256: TRUST_BOUND,
			}),
		);
		expect(bad.message).toContain("write zero flats");
	});
});

describe("verify-campaign-index stale echo flats", () => {
	it("rejects_a_flat_naming_a_cell_the_index_never_scheduled", () => {
		const root = mkdtempSync(join(tmpdir(), "vci-echo-cell-"));
		const indexPath = writeIndex(
			root,
			indexOf({
				executionPurpose: "canonical",
				measuredRepetitions: 5,
				cells: [FANOUT_COHORT_CELL_IDS[0]!],
			}),
		);
		writeFileSync(join(root, "some-other-cell-ws.json"), "{}\n");
		const bad = expectRejection(
			verifyCampaignIndex({
				campaignRoot: root,
				indexPath,
				externalTrustBoundSha256: TRUST_BOUND,
			}),
		);
		expect(bad.message).toContain("names no cell scheduled by this index");
	});

	it("rejects_a_stale_echo_flat_for_a_fanout_cell_without_a_complete_five_of_five_set", () => {
		const root = mkdtempSync(join(tmpdir(), "vci-echo-set-"));
		const cellId = FANOUT_COHORT_CELL_IDS[0]!;
		const safe = cellId.replace(/[/:]/g, "_");
		const indexPath = writeIndex(
			root,
			indexOf({
				executionPurpose: "canonical",
				measuredRepetitions: 5,
				cells: [cellId],
			}),
		);
		writeFileSync(join(root, `${safe}-ws.json`), "{}\n");
		writeFileSync(join(root, `${safe}-wt.json`), "{}\n");
		const bad = expectRejection(
			verifyCampaignIndex({
				campaignRoot: root,
				indexPath,
				externalTrustBoundSha256: TRUST_BOUND,
			}),
		);
		expect(bad.message).toContain(`stale echo flat for ${cellId}`);
		expect(bad.message).toContain("PROMOTION_ARM_PAIR_INCOMPLETE");
	});
});

describe("verify-campaign-index integrity-only", () => {
	it("integrity_only_verification_reports_zero_promotable_and_no_promoted_cells", () => {
		const { bytes, artifact } = sealedFixtureArtifact();
		const root = mkdtempSync(join(tmpdir(), "vci-integrity-"));
		writeFileSync(join(root, "rep-1.sealed.json"), bytes);
		const indexPath = writeIndex(
			root,
			indexOf({
				executionPurpose: "canonical",
				measuredRepetitions: 5,
				candidate: artifact.source.sourceSha,
				campaignId: artifact.comparisonId,
				cells: ["bulk-one-way/physical"],
				entries: [
					entry({
						cellId: "bulk-one-way/physical",
						armId: "bulk-one-way/physical/ws",
						status: "PASS",
						executionPurpose: "canonical",
						repetitionTotal: 5,
						promotable: true,
						sealedPath: "rep-1.sealed.json",
						artifactSha256: createHash("sha256").update(bytes).digest("hex"),
					}),
				],
			}),
		);
		const result = verifyCampaignIndex({
			campaignRoot: root,
			indexPath,
			externalTrustBoundSha256: TRUST_BOUND,
			integrityOnly: true,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected ok");
		// The index still says PASS -- integrity-only does not rewrite status --
		// but nothing it saw is allowed to promote.
		expect(result.passCount).toBe(1);
		expect(result.sealedCount).toBe(1);
		expect(result.promotableCount).toBe(0);
		expect(result.promotedCells).toEqual([]);
		expect(result.canonicalFanoutComplete).toBe(false);
		expect(result.integrityOnly).toBe(true);
	});

	it("integrity_only_verification_refuses_a_nonzero_expected_promotable_count", () => {
		const root = mkdtempSync(join(tmpdir(), "vci-integrity-prom-"));
		const indexPath = writeIndex(root, indexOf());
		const bad = expectRejection(
			verifyCampaignIndex({
				campaignRoot: root,
				indexPath,
				externalTrustBoundSha256: TRUST_BOUND,
				integrityOnly: true,
				expectedPromotableCount: 2,
			}),
		);
		expect(bad.message).toContain("integrity-only verification cannot promote");
	});

	it("integrity_only_verification_refuses_the_canonical_fanout_completion_claim", () => {
		const root = mkdtempSync(join(tmpdir(), "vci-integrity-fanout-"));
		const indexPath = writeIndex(root, indexOf());
		const bad = expectRejection(
			verifyCampaignIndex({
				campaignRoot: root,
				indexPath,
				externalTrustBoundSha256: TRUST_BOUND,
				integrityOnly: true,
				expectCanonicalFanoutComplete: true,
			}),
		);
		expect(bad.message).toContain("cannot complete the canonical fanout claim");
	});
});

describe("verify-campaign-index count assertions", () => {
	it("expected_sealed_count_mismatch_is_named", () => {
		const root = mkdtempSync(join(tmpdir(), "vci-sealed-count-"));
		const indexPath = writeIndex(root, indexOf());
		const bad = expectRejection(
			verifyCampaignIndex({
				campaignRoot: root,
				indexPath,
				externalTrustBoundSha256: TRUST_BOUND,
				expectedSealedCount: 60,
			}),
		);
		expect(bad.message).toContain("expectedSealedCount mismatch");
		expect(bad.message).toContain("found 0");
	});

	it("expected_flat_count_mismatch_is_named_on_a_canonical_index", () => {
		const root = mkdtempSync(join(tmpdir(), "vci-flat-count-"));
		const indexPath = writeIndex(
			root,
			indexOf({ executionPurpose: "canonical", measuredRepetitions: 5 }),
		);
		const bad = expectRejection(
			verifyCampaignIndex({
				campaignRoot: root,
				indexPath,
				externalTrustBoundSha256: TRUST_BOUND,
				expectedFlatCount: 12,
			}),
		);
		expect(bad.message).toContain("expectedFlatCount mismatch");
		expect(bad.message).toContain("expected 12, found 0");
	});

	it("expected_pair_count_mismatch_is_named_on_a_canonical_index", () => {
		const root = mkdtempSync(join(tmpdir(), "vci-pair-count-"));
		const indexPath = writeIndex(
			root,
			indexOf({ executionPurpose: "canonical", measuredRepetitions: 5 }),
		);
		const bad = expectRejection(
			verifyCampaignIndex({
				campaignRoot: root,
				indexPath,
				externalTrustBoundSha256: TRUST_BOUND,
				expectedPairCount: 6,
			}),
		);
		expect(bad.message).toContain("expectedPairCount mismatch");
		expect(bad.message).toContain("expected 6, found 0");
	});

	it("canonical_fanout_completion_requires_a_canonical_index_scheduling_all_six_cells", () => {
		const root = mkdtempSync(join(tmpdir(), "vci-fanout-scope-"));
		const indexPath = writeIndex(
			root,
			indexOf({ cells: ["bulk-one-way/physical"] }),
		);
		const bad = expectRejection(
			verifyCampaignIndex({
				campaignRoot: root,
				indexPath,
				externalTrustBoundSha256: TRUST_BOUND,
				expectCanonicalFanoutComplete: true,
			}),
		);
		expect(bad.message).toContain(
			"requires a canonical index scheduling all 6",
		);
	});

	it("names_the_missing_six_pair_sixty_seal_completion_on_an_empty_canonical_fanout_index", () => {
		const root = mkdtempSync(join(tmpdir(), "vci-fanout-empty-"));
		const indexPath = writeIndex(
			root,
			indexOf({
				executionPurpose: "canonical",
				measuredRepetitions: 5,
				cells: [...FANOUT_COHORT_CELL_IDS],
			}),
		);
		const bad = expectRejection(
			verifyCampaignIndex({
				campaignRoot: root,
				indexPath,
				externalTrustBoundSha256: TRUST_BOUND,
				expectCanonicalFanoutComplete: true,
			}),
		);
		expect(bad.message).toContain("0/6 paired promotions");
		expect(bad.message).toContain("0/60 measured PASS seals");
	});
});

describe("verify-campaign-index argv parser", () => {
	it("argv_parser_requires_campaign_root_index_and_external_trust_bound", () => {
		for (const argv of [
			[],
			["--campaign-root=/tmp/x"],
			["--campaign-root=/tmp/x", "--index=/tmp/x/campaign-index.json"],
			[
				`--index=/tmp/x/campaign-index.json`,
				`--external-trust-bound-sha256=${TRUST_BOUND}`,
			],
		]) {
			const parsed = parseVerifyCampaignIndexArgs(argv);
			expect(parsed.ok).toBe(false);
		}
		const complete = parseVerifyCampaignIndexArgs([
			"--campaign-root=/tmp/x",
			"--index=/tmp/x/campaign-index.json",
			`--external-trust-bound-sha256=${TRUST_BOUND}`,
		]);
		expect(complete.ok).toBe(true);
		if (!complete.ok) throw new Error("expected ok");
		expect(complete.args.campaignRoot).toBe("/tmp/x");
		expect(complete.args.indexPath).toBe("/tmp/x/campaign-index.json");
		expect(complete.args.externalTrustBoundSha256).toBe(TRUST_BOUND);
	});

	it("argv_parser_accepts_every_documented_expected_count_option", () => {
		const parsed = parseVerifyCampaignIndexArgs([
			"--campaign-root=/tmp/x",
			"--index=/tmp/x/campaign-index.json",
			`--external-trust-bound-sha256=${TRUST_BOUND}`,
			"--expected-pass-count=60",
			"--expected-fail-count=0",
			"--expected-refused-count=0",
			"--expected-promotable-count=60",
			"--expected-sealed-count=60",
			"--expected-flat-count=12",
			"--expected-pair-count=6",
		]);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) throw new Error("expected ok");
		expect(parsed.args.expectedPassCount).toBe(60);
		expect(parsed.args.expectedFailCount).toBe(0);
		expect(parsed.args.expectedRefusedCount).toBe(0);
		expect(parsed.args.expectedPromotableCount).toBe(60);
		expect(parsed.args.expectedSealedCount).toBe(60);
		expect(parsed.args.expectedFlatCount).toBe(12);
		expect(parsed.args.expectedPairCount).toBe(6);
	});

	it("argv_parser_carries_trust_keys_integrity_only_and_fanout_completion", () => {
		const parsed = parseVerifyCampaignIndexArgs([
			"--campaign-root=/tmp/x",
			"--index=/tmp/x/campaign-index.json",
			`--external-trust-bound-sha256=${TRUST_BOUND}`,
			"--mac-public-key=/tmp/mac.key",
			"--rig-public-key=/tmp/rig.key",
			"--integrity-only",
			"--expect-canonical-fanout-complete",
		]);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) throw new Error("expected ok");
		expect(parsed.args.macPublicKeyPath).toBe("/tmp/mac.key");
		expect(parsed.args.rigPublicKeyPath).toBe("/tmp/rig.key");
		expect(parsed.args.integrityOnly).toBe(true);
		expect(parsed.args.expectCanonicalFanoutComplete).toBe(true);
	});

	it("argv_parser_rejects_an_unknown_flag", () => {
		const parsed = parseVerifyCampaignIndexArgs([
			"--campaign-root=/tmp/x",
			"--index=/tmp/x/campaign-index.json",
			`--external-trust-bound-sha256=${TRUST_BOUND}`,
			"--expected-flat-counts=0",
		]);
		expect(parsed.ok).toBe(false);
		if (parsed.ok) throw new Error("expected refusal");
		expect(parsed.message).toContain("unknown flag --expected-flat-counts");
	});

	it("argv_parser_rejects_a_positional_argument", () => {
		const parsed = parseVerifyCampaignIndexArgs(["campaign-index.json"]);
		expect(parsed.ok).toBe(false);
	});

	it("argv_parser_rejects_a_non_integer_expected_count", () => {
		for (const value of ["abc", "-1", "1.5"]) {
			const parsed = parseVerifyCampaignIndexArgs([
				"--campaign-root=/tmp/x",
				"--index=/tmp/x/campaign-index.json",
				`--external-trust-bound-sha256=${TRUST_BOUND}`,
				`--expected-pair-count=${value}`,
			]);
			expect(parsed.ok).toBe(false);
			if (parsed.ok) throw new Error(`expected refusal for ${value}`);
			expect(parsed.message).toContain("--expected-pair-count");
		}
	});
});

describe("verify-campaign-index command", () => {
	it("command_level_run_reports_every_count_on_stdout", async () => {
		const root = mkdtempSync(join(tmpdir(), "vci-cmd-"));
		const indexPath = writeIndex(root, indexOf());
		const written: string[] = [];
		const original = process.stdout.write.bind(process.stdout);
		(process.stdout as { write: unknown }).write = ((chunk: string) => {
			written.push(String(chunk));
			return true;
		}) as typeof process.stdout.write;
		let code: number;
		try {
			code = await main([
				`--campaign-root=${root}`,
				`--index=${indexPath}`,
				`--external-trust-bound-sha256=${TRUST_BOUND}`,
				"--expected-pass-count=0",
				"--expected-flat-count=0",
				"--expected-pair-count=0",
			]);
		} finally {
			(process.stdout as { write: unknown }).write = original;
		}
		expect(code).toBe(0);
		const out = written.join("");
		expect(out).toContain("VERIFY_CAMPAIGN_INDEX_OK");
		expect(out).toContain("flats=0");
		expect(out).toContain("pairs=0");
		expect(out).toContain("canonicalFanoutComplete=false");
		expect(out).toContain("integrityOnly=false");
		expect(out).toContain("attestationsVerified=0");
	});

	it("command_level_run_without_required_flags_exits_2", async () => {
		const errors: string[] = [];
		const original = process.stderr.write.bind(process.stderr);
		(process.stderr as { write: unknown }).write = ((chunk: string) => {
			errors.push(String(chunk));
			return true;
		}) as typeof process.stderr.write;
		let code: number;
		try {
			code = await main(["--campaign-root=/tmp/x"]);
		} finally {
			(process.stderr as { write: unknown }).write = original;
		}
		expect(code).toBe(2);
		expect(errors.join("")).toContain("usage: verify-campaign-index");
	});

	it("command_level_run_on_a_bad_index_exits_3", async () => {
		const root = mkdtempSync(join(tmpdir(), "vci-cmd-bad-"));
		const errors: string[] = [];
		const original = process.stderr.write.bind(process.stderr);
		(process.stderr as { write: unknown }).write = ((chunk: string) => {
			errors.push(String(chunk));
			return true;
		}) as typeof process.stderr.write;
		let code: number;
		try {
			code = await main([
				`--campaign-root=${root}`,
				`--index=${join(root, "campaign-index.json")}`,
				`--external-trust-bound-sha256=${TRUST_BOUND}`,
			]);
		} finally {
			(process.stderr as { write: unknown }).write = original;
		}
		expect(code).toBe(3);
		expect(errors.join("")).toContain("TRUST_PROTOCOL");
	});
});

/**
 * A5 stop-gate topology (item 4).
 *
 * The count expectations are blind to `transport`, `armKind` and
 * `repetitionKind`: `--expected-pass-count=2` is satisfied by two PASS entries
 * of the same wire, by a read-path arm standing in for a primary, or by a
 * warmup entry that a producer relabelled. The registered topology -- the arms,
 * arm kinds, cells and measured repetitions the frozen section declares -- is
 * what the gate means, so the verifier proves the entries against it instead of
 * trusting the producer's own argv.
 */
describe("verify-campaign-index registered topology", () => {
	const A5_TOPOLOGY = {
		cells: ["bulk-one-way/physical"],
		arms: ["ws", "wt"],
		armKinds: ["primary"],
		measuredRepetitions: 1,
	} as const;

	function a5Index(partial: Partial<CampaignIndexV2> = {}): CampaignIndexV2 {
		return indexOf({
			cells: ["bulk-one-way/physical"],
			arms: ["ws", "wt"],
			armKinds: ["primary"],
			measuredRepetitions: 1,
			scheduledMeasuredArms: 2,
			entries: [
				entry({
					cellId: "bulk-one-way/physical",
					armId: "bulk-one-way/physical/ws",
					transport: "ws",
					status: "PASS",
					sealedPath: join("reps", "ws.sealed.json"),
					artifactSha256: "7".repeat(64),
				}),
				entry({
					cellId: "bulk-one-way/physical",
					armId: "bulk-one-way/physical/wt",
					transport: "wt",
					armTransport: "wt",
					status: "PASS",
					sealedPath: join("reps", "wt.sealed.json"),
					artifactSha256: "8".repeat(64),
				}),
			],
			...partial,
		});
	}

	function verifyTopology(index: CampaignIndexV2) {
		const root = mkdtempSync(join(tmpdir(), "vci-topology-"));
		return verifyCampaignIndex({
			campaignRoot: root,
			indexPath: writeIndex(root, index),
			externalTrustBoundSha256: TRUST_BOUND,
			expectedTopology: A5_TOPOLOGY,
		});
	}

	// The defect exactly: two PASS entries on one wire satisfy
	// `--expected-pass-count=2`, and nothing else looks at `transport`.
	it("refuses_two_passes_on_one_wire_when_both_wires_are_registered", () => {
		const rejection = expectRejection(
			verifyTopology(
				a5Index({
					entries: [
						entry({
							cellId: "bulk-one-way/physical",
							armId: "bulk-one-way/physical/ws",
							transport: "ws",
							status: "PASS",
							sealedPath: join("reps", "ws.sealed.json"),
							artifactSha256: "7".repeat(64),
						}),
						entry({
							cellId: "bulk-one-way/physical",
							armId: "bulk-one-way/physical/ws-2",
							transport: "ws",
							status: "PASS",
							sealedPath: join("reps", "ws2.sealed.json"),
							artifactSha256: "8".repeat(64),
						}),
					],
				}),
			),
		);
		expect(rejection.code).toBe("TRUST_PROTOCOL");
		expect(rejection.message).toContain("wt");
		expect(rejection.message).toContain("primary");
	});

	it("refuses_a_read_path_arm_standing_in_for_the_registered_primary", () => {
		const rejection = expectRejection(
			verifyTopology(
				a5Index({
					entries: [
						entry({
							cellId: "bulk-one-way/physical",
							armId: "bulk-one-way/physical/ws",
							transport: "ws",
							status: "PASS",
							sealedPath: join("reps", "ws.sealed.json"),
							artifactSha256: "7".repeat(64),
						}),
						entry({
							cellId: "bulk-one-way/physical",
							armId: "bulk-one-way/physical/wt-read-path",
							transport: "wt",
							armKind: "read-path",
							status: "PASS",
							sealedPath: join("reps", "wt.sealed.json"),
							artifactSha256: "8".repeat(64),
						}),
					],
				}),
			),
		);
		expect(rejection.code).toBe("TRUST_PROTOCOL");
		expect(rejection.message).toContain("read-path");
	});

	it("refuses_an_index_header_that_is_not_the_frozen_declaration", () => {
		expect(
			expectRejection(verifyTopology(a5Index({ arms: ["ws"] }))).message,
		).toContain("arms");
		expect(
			expectRejection(
				verifyTopology(a5Index({ cells: ["ticker-fanout/rate-100"] })),
			).message,
		).toContain("cells");
		expect(
			expectRejection(
				verifyTopology(a5Index({ armKinds: ["primary", "read-path"] })),
			).message,
		).toContain("armKinds");
	});

	it("refuses_a_scheduled_arm_count_the_declared_topology_does_not_produce", () => {
		expect(
			expectRejection(verifyTopology(a5Index({ scheduledMeasuredArms: 3 })))
				.message,
		).toContain("scheduledMeasuredArms");
	});

	// A warmup is unsealed by construction (plan §6, `armRepetitionSchedule`
	// gives it repetition index 0); one appearing in a sealed index, whatever
	// the topology flags say, is a producer counting an unmeasured run.
	it("refuses_a_warmup_entry_in_a_sealed_index", () => {
		const consistency = validateIndexEntryConsistency(
			entry({
				cellId: "bulk-one-way/physical",
				armId: "bulk-one-way/physical/ws",
				status: "PASS",
				sealedPath: join("reps", "ws.sealed.json"),
				artifactSha256: "7".repeat(64),
				// Index 1, so only the kind is wrong: a warmup wearing a
				// measured repetition's number.
				repetitionKind: "warmup" as "measured",
			}),
		);
		expect(consistency.ok).toBe(false);
		if (consistency.ok) throw new Error("unreachable");
		expect(consistency.message).toContain("warmup");
	});

	it("refuses_a_measured_entry_carrying_the_warmup_repetition_index", () => {
		const consistency = validateIndexEntryConsistency(
			entry({
				cellId: "bulk-one-way/physical",
				armId: "bulk-one-way/physical/ws",
				status: "PASS",
				sealedPath: join("reps", "ws.sealed.json"),
				artifactSha256: "7".repeat(64),
				repetitionIndex: 0,
			}),
		);
		expect(consistency.ok).toBe(false);
		if (consistency.ok) throw new Error("unreachable");
		expect(consistency.message).toContain("repetitionIndex");
	});

	it("refuses_a_focused_topology_whose_entry_claims_promotable", () => {
		expect(
			expectRejection(
				verifyTopology(
					a5Index({
						entries: [
							entry({
								cellId: "bulk-one-way/physical",
								armId: "bulk-one-way/physical/ws",
								transport: "ws",
								status: "PASS",
								promotable: true,
								sealedPath: join("reps", "ws.sealed.json"),
								artifactSha256: "7".repeat(64),
							}),
							entry({
								cellId: "bulk-one-way/physical",
								armId: "bulk-one-way/physical/wt",
								transport: "wt",
								status: "PASS",
								sealedPath: join("reps", "wt.sealed.json"),
								artifactSha256: "8".repeat(64),
							}),
						],
					}),
				),
			).message,
		).toContain("promotable");
	});

	// The registered shape passes the topology proof and then fails on the
	// seal that is not on disk: proof of order, and proof that the honest A5
	// shape is not what the new refusals reject.
	it("accepts_the_registered_a5_shape_and_moves_on_to_the_seals", () => {
		const rejection = expectRejection(verifyTopology(a5Index()));
		expect(rejection.message).toContain("indexed sealed artifact is absent");
	});

	// Same proof for the canonical section: six cells, both wires, five
	// measured repetitions each.
	it("proves_the_canonical_sixty_seal_shape_and_names_a_missing_repetition", () => {
		const cells = [...FANOUT_COHORT_CELL_IDS];
		const entries: CampaignIndexEntryV2[] = [];
		for (const cellId of cells) {
			for (const transport of ["ws", "wt"] as const) {
				for (let rep = 1; rep <= 5; rep += 1) {
					// One repetition of one wire is missing: 59 PASS, and every
					// blind counter except the total still agrees.
					if (cellId === cells[0] && transport === "wt" && rep === 5) continue;
					entries.push(
						entry({
							cellId,
							armId: `${cellId}/${transport}`,
							transport,
							executionPurpose: "canonical",
							status: "PASS",
							repetitionIndex: rep,
							repetitionTotal: 5,
							sealedPath: join(
								"reps",
								`${safeName(cellId)}-${transport}-${rep}.sealed.json`,
							),
							artifactSha256: `${rep}`.repeat(64).slice(0, 64),
						}),
					);
				}
			}
		}
		const root = mkdtempSync(join(tmpdir(), "vci-topology-canon-"));
		const rejection = expectRejection(
			verifyCampaignIndex({
				campaignRoot: root,
				indexPath: writeIndex(
					root,
					indexOf({
						executionPurpose: "canonical",
						cells,
						arms: ["ws", "wt"],
						armKinds: ["primary"],
						measuredRepetitions: 5,
						scheduledMeasuredArms: 60,
						entries,
					}),
				),
				externalTrustBoundSha256: TRUST_BOUND,
				expectedTopology: {
					cells,
					arms: ["ws", "wt"],
					armKinds: ["primary"],
					measuredRepetitions: 5,
				},
			}),
		);
		expect(rejection.code).toBe("TRUST_PROTOCOL");
		expect(rejection.message).toContain(cells[0]!);
	});

	it("parses_the_four_topology_flags_together_and_refuses_a_partial_set", () => {
		const parsed = parseVerifyCampaignIndexArgs([
			"--campaign-root=/tmp/x",
			"--index=/tmp/x/campaign-index.json",
			`--external-trust-bound-sha256=${TRUST_BOUND}`,
			"--expect-cells=bulk-one-way/physical",
			"--expect-arms=ws,wt",
			"--expect-arm-kinds=primary",
			"--expect-measured-repetitions=1",
		]);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) throw new Error("unreachable");
		expect(parsed.args.expectedTopology).toEqual({
			cells: ["bulk-one-way/physical"],
			arms: ["ws", "wt"],
			armKinds: ["primary"],
			measuredRepetitions: 1,
		});
		const partial = parseVerifyCampaignIndexArgs([
			"--campaign-root=/tmp/x",
			"--index=/tmp/x/campaign-index.json",
			`--external-trust-bound-sha256=${TRUST_BOUND}`,
			"--expect-arms=ws,wt",
		]);
		expect(partial.ok).toBe(false);
		if (partial.ok) throw new Error("unreachable");
		expect(partial.message).toContain("--expect-cells");
	});

	it("refuses_an_unregistered_arm_kind_or_repetition_count_on_the_flags", () => {
		const badKind = parseVerifyCampaignIndexArgs([
			"--campaign-root=/tmp/x",
			"--index=/tmp/x/campaign-index.json",
			`--external-trust-bound-sha256=${TRUST_BOUND}`,
			"--expect-cells=bulk-one-way/physical",
			"--expect-arms=ws,wt",
			"--expect-arm-kinds=sidecar",
			"--expect-measured-repetitions=1",
		]);
		expect(badKind.ok).toBe(false);
		const badReps = parseVerifyCampaignIndexArgs([
			"--campaign-root=/tmp/x",
			"--index=/tmp/x/campaign-index.json",
			`--external-trust-bound-sha256=${TRUST_BOUND}`,
			"--expect-cells=bulk-one-way/physical",
			"--expect-arms=ws,wt",
			"--expect-arm-kinds=primary",
			"--expect-measured-repetitions=3",
		]);
		expect(badReps.ok).toBe(false);
	});
});

function safeName(cellId: string): string {
	return cellId.replace(/[/:]/g, "_");
}

describe("verify-campaign-index expected totals", () => {
	// Physical-budget amendment D6: a pilot or canonical index whose sealed
	// arm totals are not the cell's cardinalities is refused with its own
	// code. Before this, only promotion was gated by totals, so a pilot that
	// delivered two orders of magnitude below its gate sealed two PASS entries.
	const TICKER_100 = "ticker-fanout/rate-100";
	function reconstruction(partial: {
		readonly publisherCount?: number;
		readonly subscriberCount?: number;
		readonly offeredIngress?: number;
		readonly serverAcceptedIngress?: number;
		readonly delivered?: number;
	}) {
		const delivered = partial.delivered ?? 100_000;
		return {
			publisherCount: partial.publisherCount ?? 1,
			subscriberCount: partial.subscriberCount ?? 100,
			ledger: {
				schema: "cohort-ledger/v1" as const,
				offeredIngress: partial.offeredIngress ?? 1_000,
				serverAcceptedIngress: partial.serverAcceptedIngress ?? 1_000,
				offeredExpandedDeliveries: 100_000,
				serverAcceptedExpandedDeliveries: 100_000,
				linuxRelayWritesCompleted: delivered,
				delivered,
				deliveredBytes: delivered * 100,
				messageBytes: 100 as const,
			},
		};
	}

	it("accepts_the_cell_cardinalities_under_pilot_and_canonical", () => {
		for (const purpose of ["pilot", "canonical"] as const) {
			expect(
				checkExpectedTotals({
					cellId: TICKER_100,
					armKind: "primary",
					executionPurpose: purpose,
					reconstruction: reconstruction({}),
				}),
			).toEqual({ ok: true });
		}
	});

	it("refuses_a_pilot_whose_delivered_total_is_below_the_cell", () => {
		const result = checkExpectedTotals({
			cellId: TICKER_100,
			armKind: "primary",
			executionPurpose: "pilot",
			reconstruction: reconstruction({ delivered: 1_000 }),
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("EXPECTED_TOTALS_MISMATCH");
		expect(result.message).toContain("delivered 1000");
		expect(result.message).toContain("100000");
	});

	it("refuses_every_other_total_that_differs_from_the_cardinality", () => {
		const cases = [
			{ offeredIngress: 999 },
			{ serverAcceptedIngress: 1_001 },
			{ publisherCount: 2 },
			{ subscriberCount: 99 },
		];
		for (const partial of cases) {
			const result = checkExpectedTotals({
				cellId: TICKER_100,
				armKind: "primary",
				executionPurpose: "canonical",
				reconstruction: reconstruction(partial),
			});
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.code).toBe("EXPECTED_TOTALS_MISMATCH");
		}
	});

	it("does_not_gate_a_focused_probe_or_a_non_cohort_arm", () => {
		expect(
			checkExpectedTotals({
				cellId: TICKER_100,
				armKind: "primary",
				executionPurpose: "focused",
				reconstruction: reconstruction({ delivered: 1_000 }),
			}),
		).toEqual({ ok: true });
		expect(
			checkExpectedTotals({
				cellId: TICKER_100,
				armKind: "read-path",
				executionPurpose: "pilot",
				reconstruction: reconstruction({ delivered: 1_000 }),
			}),
		).toEqual({ ok: true });
	});
});
