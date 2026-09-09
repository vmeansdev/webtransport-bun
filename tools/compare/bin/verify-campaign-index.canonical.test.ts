/**
 * The frozen 9.7 verifier over a canonical index of promotable seals, run to
 * `ok:true` for the first time.
 *
 * Every measured PASS seal a canonical campaign writes is `promotable:true`,
 * and until this suite nothing in the tree drove `verifyCampaignIndex` past
 * one: the quarantine refused every external trust bound as unvalidated, so a
 * B6 launch would have run all 72 executions and refused at verification.
 *
 * No honest sixty-seal canonical root exists to open here -- a cohort seal is
 * hundreds of lines of signed fixture per cell -- so the three seal-level
 * verifiers the index verifier delegates to (`verifyRunArtifact`, the cohort
 * reconstruction and the attestation graph) are replaced through `bun:test`'s
 * module seam, with the reconstruction answering the cell's own row so
 * `checkExpectedTotals` runs for real. Everything else is the frozen code:
 * the argv contract, the registered topology, the bytes and digests of sixty
 * seals, the external trust bound recomputed from the receipt and the leaves,
 * the quarantine, the flats and pairs, the completion gate and the counters.
 * The module mocks are restored after the suite: `bun test` runs every file in
 * one process, and a mock left in place would follow the next file.
 */
import { afterAll, describe, expect, it, mock } from "bun:test";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson } from "../canonical.ts";
import { cohortCellCardinality } from "../cohort-protocol.ts";
import {
	type ExternalTrustBoundPreimageV1,
	externalTrustBoundSha256,
	generateEd25519KeyPair,
} from "../cross-supervisor-protocol.ts";
import {
	cohortCellForArm,
	FANOUT_COHORT_CELL_IDS,
	type RunArtifact,
	sealRunArtifact,
} from "../evidence.ts";
import { publicKeySha256 } from "../server-observation-artifact.ts";
import type {
	CampaignIndexEntryV2,
	CampaignIndexV2,
} from "./verify-campaign-index.ts";

const actualVerifyArtifact = { ...(await import("../verify-artifact.ts")) };
const actualObservation = {
	...(await import("../server-observation-artifact.ts")),
};

const opened = { seals: 0, reconstructions: 0, attestations: 0 };

mock.module("../verify-artifact.ts", () => ({
	...actualVerifyArtifact,
	verifyRunArtifact: () => {
		opened.seals += 1;
		return { evidenceStatus: "PASS", rejections: [] };
	},
	reconstructCohortEvidenceOffline: (args: {
		readonly cellId: string;
		readonly armKind: "primary" | "read-path" | "overlay";
	}) => {
		opened.reconstructions += 1;
		const cell = cohortCellForArm(args);
		if (cell === null) throw new Error(`no cohort for ${args.cellId}`);
		const row = cohortCellCardinality(cell);
		return {
			ok: true,
			cell,
			publisherCount: row.publisherCount,
			subscriberCount: row.subscriberCount,
			ledger: {
				offeredIngress: row.measuredIngress,
				serverAcceptedIngress: row.measuredIngress,
				delivered: row.expandedDeliveries,
			},
			receiptGraphComplete: true,
			promotionEligible: true,
		};
	},
}));
mock.module("../server-observation-artifact.ts", () => ({
	...actualObservation,
	verifyArmAttestationEvidence: () => {
		opened.attestations += 1;
		return { ok: true };
	},
}));

const {
	CAMPAIGN_INDEX_V2_SCHEMA,
	parseVerifyCampaignIndexArgs,
	verifyCampaignIndex,
} = await import("./verify-campaign-index.ts");

afterAll(() => {
	mock.module("../verify-artifact.ts", () => actualVerifyArtifact);
	mock.module("../server-observation-artifact.ts", () => actualObservation);
});

const CAMPAIGN = "fanout-attested-r1";
const REPS = [1, 2, 3, 4, 5] as const;
const ARMS = ["ws", "wt"] as const;

function H(label: string): string {
	return createHash("sha256").update(label).digest("hex");
}

function safeCellName(cellId: string): string {
	return cellId.replace(/[/:]/g, "_");
}

/** The frozen 9.7 section's own cell list, in its ladder order. */
function frozenCells(): string[] {
	const fragment = readFileSync(
		join(import.meta.dir, "frozen-run-section-9.7.fragment.sh"),
		"utf8",
	);
	const line = fragment
		.split("\n")
		.find((candidate) => candidate.startsWith("CELLS="));
	if (line === undefined) throw new Error("9.7 fragment declares no CELLS");
	return line.slice("CELLS=".length).split(",");
}

const golden = JSON.parse(
	readFileSync(
		join(import.meta.dir, "..", "fixtures", "valid-ws-run.json"),
		"utf8",
	),
) as RunArtifact & Record<string, unknown>;

/**
 * A canonical, promotable seal for one repetition of one arm. The golden
 * fixture supplies the source identity and observed toolchains the quarantine
 * reads; the sentinel sidecar digests it carries are replaced, because a
 * production seal never carries one and the quarantine refuses them.
 */
function sealFor(
	cellId: string,
	transport: "ws" | "wt",
	repetitionIndex: number,
	overrides: Record<string, unknown> = {},
): { readonly bytes: Uint8Array; readonly artifact: RunArtifact } {
	const runId = `${CAMPAIGN}-${safeCellName(cellId)}-${transport}-rep-${repetitionIndex}`;
	const artifact = {
		...golden,
		artifactKind: "measured",
		executionPurpose: "canonical",
		promotable: true,
		comparisonId: CAMPAIGN,
		transport,
		cellId,
		runId,
		rawSidecarDigests: {
			client: H(`client ${runId}`),
			server: H(`server ${runId}`),
			topology: H(`topology ${runId}`),
			impairment: H(`impairment ${runId}`),
			cleanup: H(`cleanup ${runId}`),
		},
		cohortEvidenceExport: {
			cohortObservationEvidenceSha256: H(`cohort ${runId}`),
		},
		attestationEvidence: {
			schema: "arm-attestation-evidence/v2",
			executionSha256: H(`execution ${runId}`),
			cohortObservationEvidence: { schema: "stubbed-for-this-suite" },
		},
		...overrides,
	};
	const bytes = sealRunArtifact(artifact);
	return {
		bytes,
		artifact: JSON.parse(new TextDecoder().decode(bytes)) as RunArtifact,
	};
}

interface CanonicalRoot {
	readonly root: string;
	readonly indexPath: string;
	readonly bound: string;
	readonly receiptPath: string;
	readonly macPublicKeyPath: string;
	readonly rigPublicKeyPath: string;
}

/**
 * A six-cell canonical root the way the controller leaves one: sixty seals
 * under `reps/`, twelve median flats at the root, a `campaign-index/v2`, and
 * beside it the staged trust the frozen command hands the verifier -- both
 * leaves and a stage receipt whose bound the live encoder minted.
 */
function canonicalRoot(
	options: {
		readonly mutateEntry?: (
			entry: CampaignIndexEntryV2,
			seal: ReturnType<typeof sealFor>,
		) => { entry: CampaignIndexEntryV2; bytes: Uint8Array } | undefined;
		readonly skipFlat?: (cellId: string, transport: "ws" | "wt") => boolean;
		readonly receipt?: Partial<ExternalTrustBoundPreimageV1>;
	} = {},
): CanonicalRoot {
	const root = mkdtempSync(join(tmpdir(), "vci-canonical-"));
	const trust = join(root, "trust");
	mkdirSync(trust, { recursive: true });
	const entries: CampaignIndexEntryV2[] = [];
	let anchors: RunArtifact["source"] | undefined;
	for (const cellId of FANOUT_COHORT_CELL_IDS) {
		for (const transport of ARMS) {
			const dir = join(root, "reps", safeCellName(cellId), transport);
			mkdirSync(dir, { recursive: true });
			let median: Uint8Array | undefined;
			for (const repetitionIndex of REPS) {
				const seal = sealFor(cellId, transport, repetitionIndex);
				anchors ??= seal.artifact.source;
				const sealedPath = join(
					"reps",
					safeCellName(cellId),
					transport,
					`rep-${repetitionIndex}.sealed.json`,
				);
				let bytes = seal.bytes;
				let entry: CampaignIndexEntryV2 = {
					schema: "campaign-index-entry/v2",
					cellId,
					armId: `${cellId}/${transport}`,
					transport,
					armKind: "primary",
					armTransport: transport,
					impairment: "none",
					executionPurpose: "canonical",
					repetitionKind: "measured",
					repetitionIndex,
					repetitionTotal: 5,
					status: "PASS",
					promotable: true,
					failureCode: null,
					refusalCode: null,
					sealedPath,
					artifactSha256: H("placeholder"),
					// Ascending in the repetition index on both wires, so the gate's
					// own rank (mean p50 ascending, lower middle of five) selects
					// rep 3 -- the seal the fixture then writes as the flat. The
					// verifier binds each flat to the entry the gate selected, so a
					// fixture whose flat is not the gate's median refuses itself.
					primaryMetricP50: 10 + repetitionIndex,
					readPath: null,
				};
				const mutated = options.mutateEntry?.(entry, seal);
				if (mutated !== undefined) {
					entry = mutated.entry;
					bytes = mutated.bytes;
				}
				entry = {
					...entry,
					artifactSha256: createHash("sha256").update(bytes).digest("hex"),
				};
				writeFileSync(join(root, sealedPath), bytes);
				if (repetitionIndex === 3) median = bytes;
				entries.push(entry);
			}
			if (median === undefined) throw new Error("no median seal");
			if (!options.skipFlat?.(cellId, transport)) {
				writeFileSync(
					join(root, `${safeCellName(cellId)}-${transport}.json`),
					median,
				);
			}
		}
	}
	if (anchors === undefined) throw new Error("no seals");
	const index: CampaignIndexV2 = {
		schema: CAMPAIGN_INDEX_V2_SCHEMA,
		campaignRunId: `${CAMPAIGN}-run`,
		stage: "full",
		candidate: anchors.sourceSha,
		campaignId: CAMPAIGN,
		approvedPlanSha256: H("approved plan"),
		approvalRecordSha256: H("approval record"),
		stagedCapabilitySha256: anchors.executableSha256,
		sourceArchiveSha256: anchors.archiveSha256,
		executionPurpose: "canonical",
		cells: [...FANOUT_COHORT_CELL_IDS],
		arms: ["ws", "wt"],
		armKinds: ["primary"],
		warmupRepetitions: 1,
		measuredRepetitions: 5,
		scheduledMeasuredArms: 60,
		entries,
	};
	const indexPath = join(root, "campaign-index.json");
	writeFileSync(indexPath, `${JSON.stringify(index)}\n`);

	const mac = generateEd25519KeyPair().publicRaw32;
	const rig = generateEd25519KeyPair().publicRaw32;
	const macPublicKeyPath = join(trust, "mac-supervisor-ed25519.pub");
	const rigPublicKeyPath = join(trust, "rig-supervisor-ed25519.pub");
	writeFileSync(macPublicKeyPath, mac);
	writeFileSync(rigPublicKeyPath, rig);
	const preimage: ExternalTrustBoundPreimageV1 = {
		candidate: index.candidate,
		campaignId: index.campaignId,
		authoritySha256: H("authority"),
		capabilitySha256: index.stagedCapabilitySha256,
		lockSha256: H("lock"),
		archiveSha256: index.sourceArchiveSha256,
		macSigningPublicKeySha256: publicKeySha256(mac),
		rigSigningPublicKeySha256: publicKeySha256(rig),
		macDirectoryIdentitySha256: H("mac-dir"),
		linuxDirectoryIdentitySha256: H("linux-dir"),
	};
	const bound = externalTrustBoundSha256(preimage);
	const receiptPath = join(trust, "stage-receipt.json");
	writeFileSync(
		receiptPath,
		`${canonicalJson({
			schema: "live-stage-receipt/v1",
			...preimage,
			...options.receipt,
			externalTrustBoundSha256: bound,
		})}\n`,
	);
	return {
		root,
		indexPath,
		bound,
		receiptPath,
		macPublicKeyPath,
		rigPublicKeyPath,
	};
}

/** The verifier argv of `frozen-run-wrapper.fragment.sh`, section 9.7. */
function frozenArgv(
	staged: CanonicalRoot,
	overrides: {
		readonly bound?: string;
		readonly omit?: readonly string[];
	} = {},
): string[] {
	return [
		`--campaign-root=${staged.root}`,
		`--index=${staged.indexPath}`,
		`--external-trust-bound-sha256=${overrides.bound ?? staged.bound}`,
		`--mac-public-key=${staged.macPublicKeyPath}`,
		`--rig-public-key=${staged.rigPublicKeyPath}`,
		`--stage-receipt=${staged.receiptPath}`,
		"--expected-pass-count=60",
		"--expected-fail-count=0",
		"--expected-refused-count=0",
		"--expected-promotable-count=60",
		"--expected-flat-count=12",
		"--expected-pair-count=6",
		"--expected-sealed-count=60",
		`--expect-cells=${frozenCells().join(",")}`,
		"--expect-arms=ws,wt",
		"--expect-arm-kinds=primary",
		"--expect-measured-repetitions=5",
		"--expect-canonical-fanout-complete",
	].filter(
		(arg) =>
			!(overrides.omit ?? []).some((flag) => arg.startsWith(`--${flag}`)),
	);
}

function verify(argv: readonly string[]) {
	const parsed = parseVerifyCampaignIndexArgs(argv);
	if (!parsed.ok) throw new Error(parsed.message);
	return verifyCampaignIndex(parsed.args);
}

function refusal(result: ReturnType<typeof verify>): {
	readonly code: string;
	readonly message: string;
} {
	if (result.ok) throw new Error("expected a refusal, got ok");
	return result;
}

describe("verify-campaign-index: the canonical 60/12/6 claim", () => {
	it("the_frozen_9_7_argv_accepts_a_complete_canonical_root", () => {
		const staged = canonicalRoot();
		const before = { ...opened };
		const result = verify(frozenArgv(staged));
		expect(result).toEqual({
			ok: true,
			passCount: 60,
			failCount: 0,
			refusedCount: 0,
			promotableCount: 60,
			sealedCount: 60,
			flatCount: 12,
			pairCount: 6,
			promotedCells: [...FANOUT_COHORT_CELL_IDS],
			canonicalFanoutComplete: true,
			integrityOnly: false,
			attestationsVerified: 60,
		});
		// Every seal went through all three delegated verifiers.
		expect(opened.seals - before.seals).toBe(60);
		expect(opened.reconstructions - before.reconstructions).toBe(60);
		expect(opened.attestations - before.attestations).toBe(60);
		expect(new Set(frozenCells())).toEqual(new Set(FANOUT_COHORT_CELL_IDS));
		rmSync(staged.root, { recursive: true, force: true });
	});

	it("one_non_promotable_seal_refuses_the_claim", () => {
		const DEMOTED = "chat-fanout/subscribers-500";
		const demote = (
			entry: CampaignIndexEntryV2,
		): { entry: CampaignIndexEntryV2; bytes: Uint8Array } | undefined => {
			if (
				entry.cellId !== DEMOTED ||
				entry.transport !== "wt" ||
				entry.repetitionIndex !== 4
			) {
				return undefined;
			}
			return {
				entry: { ...entry, promotable: false },
				bytes: sealFor(entry.cellId, entry.transport, 4, { promotable: false })
					.bytes,
			};
		};
		// The controller promotes no flats for a cell whose set gate refused.
		const staged = canonicalRoot({
			mutateEntry: demote,
			skipFlat: (cellId) => cellId === DEMOTED,
		});
		const counted = refusal(verify(frozenArgv(staged)));
		expect(counted.message).toContain("expectedPromotableCount");
		// Without the counters the completion gate itself names the seal.
		const gated = refusal(
			verify(
				frozenArgv(staged, {
					omit: [
						"expected-promotable-count",
						"expected-pass-count",
						"expected-flat-count",
						"expected-pair-count",
					],
				}),
			),
		);
		expect(gated.message).toContain("canonical fanout incomplete");
		expect(gated.message).toContain("5/6 paired promotions");
		expect(gated.message).toContain("PROMOTION_ENTRY_NOT_PROMOTABLE");
		rmSync(staged.root, { recursive: true, force: true });

		// Flats left behind for that cell are a stale echo, named as such.
		const echoed = canonicalRoot({ mutateEntry: demote });
		const stale = refusal(
			verify(
				frozenArgv(echoed, {
					omit: ["expected-promotable-count", "expected-pass-count"],
				}),
			),
		);
		expect(stale.message).toContain(`stale echo flat for ${DEMOTED}`);
		expect(stale.message).toContain("PROMOTION_ENTRY_NOT_PROMOTABLE");
		rmSync(echoed.root, { recursive: true, force: true });
	});

	it("a_flat_that_is_another_repetition_of_its_own_arm_refuses_the_claim", () => {
		// Run #1's real bytes, recipe: rate-25's WT flat replaced by rep 1 of
		// the same arm. Every seal verifies and the pair count is unchanged;
		// only the binding to the gate's median says the flat is not the
		// promoted artifact.
		const staged = canonicalRoot();
		const cell = "ticker-fanout/rate-25";
		copyFileSync(
			join(staged.root, "reps", safeCellName(cell), "wt", "rep-1.sealed.json"),
			join(staged.root, `${safeCellName(cell)}-wt.json`),
		);
		const bad = refusal(verify(frozenArgv(staged)));
		expect(bad.code).toBe("PROMOTED_FLAT_MISMATCH");
		expect(bad.message).toContain(
			`${safeCellName(cell)}-wt.json is not the artifact the promotion gate selected for ${cell} wt (rep 3,`,
		);
		rmSync(staged.root, { recursive: true, force: true });
	});

	it("wt_flats_swapped_across_two_cells_refuse_the_claim", () => {
		// Run #1's real bytes, recipe: rate-25's and subscribers-250's WT flats
		// exchanged. Both are this campaign's promoted seals under the other
		// cell's name; the filename pairing counts six pairs, the binding
		// refuses the first cell it reaches.
		const staged = canonicalRoot();
		const a = join(
			staged.root,
			`${safeCellName("ticker-fanout/rate-25")}-wt.json`,
		);
		const b = join(
			staged.root,
			`${safeCellName("chat-fanout/subscribers-250")}-wt.json`,
		);
		const bytesA = readFileSync(a);
		copyFileSync(b, a);
		writeFileSync(b, bytesA);
		const bad = refusal(verify(frozenArgv(staged)));
		expect(bad.code).toBe("PROMOTED_FLAT_MISMATCH");
		expect(bad.message).toMatch(
			/-wt\.json is not the artifact the promotion gate selected for (ticker-fanout\/rate-25|chat-fanout\/subscribers-250) wt/,
		);
		rmSync(staged.root, { recursive: true, force: true });
	});

	it("one_missing_flat_refuses_the_claim", () => {
		const staged = canonicalRoot({
			skipFlat: (cellId, transport) =>
				cellId === "ticker-fanout/rate-50" && transport === "ws",
		});
		const bad = refusal(verify(frozenArgv(staged)));
		expect(bad.message).toContain(
			"expectedFlatCount mismatch: expected 12, found 11",
		);
		rmSync(staged.root, { recursive: true, force: true });
	});

	it("one_unpaired_cell_refuses_the_claim", () => {
		const staged = canonicalRoot({
			skipFlat: (cellId, transport) =>
				cellId === "chat-fanout/subscribers-1000" && transport === "wt",
		});
		const bad = refusal(
			verify(frozenArgv(staged, { omit: ["expected-flat-count"] })),
		);
		expect(bad.message).toContain(
			"expectedPairCount mismatch: expected 6, found 5",
		);
		rmSync(staged.root, { recursive: true, force: true });
	});

	it("a_bound_the_receipt_does_not_reproduce_refuses_the_whole_index", () => {
		const staged = canonicalRoot();
		const before = opened.seals;
		const flipped = refusal(
			verify(frozenArgv(staged, { bound: "9".repeat(64) })),
		);
		expect(flipped.code).toBe("EXTERNAL_TRUST_BOUND_MISMATCH");
		// Refused before any seal was opened.
		expect(opened.seals).toBe(before);
		rmSync(staged.root, { recursive: true, force: true });

		const moved = canonicalRoot({ receipt: { lockSha256: H("another lock") } });
		const recomputed = refusal(verify(frozenArgv(moved)));
		expect(recomputed.code).toBe("EXTERNAL_TRUST_BOUND_MISMATCH");
		expect(recomputed.message).toContain("recomputed as");
		rmSync(moved.root, { recursive: true, force: true });
	});

	it("without_the_stage_receipt_no_seal_is_promotable", () => {
		const staged = canonicalRoot();
		const bad = refusal(
			verify(frozenArgv(staged, { omit: ["stage-receipt"] })),
		);
		expect(bad.code).toBe("EXTERNAL_TRUST_BOUND_UNVALIDATED");
		rmSync(staged.root, { recursive: true, force: true });
	});
});
