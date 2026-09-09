/**
 * Recursive sealed campaign-index verifier (plan §6 / A3).
 *
 * Opens only indexed `*.sealed.json`, proves path↔entry identity and artifact
 * SHA, and supplies `externalTrustBoundSha256` to every artifact verification.
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { canonicalJson } from "../canonical.ts";
import { cohortCellCardinality } from "../cohort-protocol.ts";
import {
	type CampaignFailureCode,
	type CampaignRefusalCode,
	EXTERNAL_TRUST_BOUND_PREIMAGE_FIELDS,
	EXTERNAL_TRUST_BOUND_SCHEMA,
	type ExecutionPurpose,
	type ExternalTrustBoundPreimageV1,
	externalTrustBoundSha256,
} from "../cross-supervisor-protocol.ts";
import {
	type ArmKind,
	type ArtifactTrustContext,
	cohortCellForArm,
	FANOUT_COHORT_CELL_IDS,
	type RunArtifact,
	requiresCohortObservationEvidence,
} from "../evidence.ts";
import {
	CANONICAL_FANOUT_CELL_COUNT,
	CANONICAL_FANOUT_MEASURED_SEAL_COUNT,
	checkPromotionQuarantine,
	type ExternalTrustBoundValidation,
	evaluateCanonicalFanoutCompletion,
	evaluateCellPromotionGate,
	type PromotionGateEntry,
} from "../output-policy.ts";
import { parseStrictJsonBytes } from "../secure-fs.ts";
import {
	type ArmAttestationEvidenceV2,
	type AttestationTrustMaterial,
	publicKeySha256,
	verifyArmAttestationEvidence,
} from "../server-observation-artifact.ts";
import {
	type CohortReconstruction,
	reconstructCohortEvidenceOffline,
	trustContextForArtifact,
	verifyRunArtifact,
} from "../verify-artifact.ts";

export const CAMPAIGN_INDEX_V2_SCHEMA = "campaign-index/v2" as const;

export interface CampaignIndexReadPathV2 {
	readonly schema: "campaign-index-read-path/v2";
	readonly sinkMode: string | null;
	readonly configuredSinkMode: string | null;
	readonly queuedRecordsPeakBytes: number | null;
	readonly droppedByQueue: number | null;
	readonly readerBusyMs: number | null;
}

export interface CampaignIndexEntryV2 {
	readonly schema: "campaign-index-entry/v2";
	readonly cellId: string;
	readonly armId: string;
	readonly transport: "ws" | "wt";
	readonly armKind: "primary" | "read-path" | "overlay";
	readonly armTransport: string | null;
	readonly impairment: string;
	readonly executionPurpose: ExecutionPurpose;
	readonly repetitionKind: "measured";
	readonly repetitionIndex: number;
	readonly repetitionTotal: number;
	readonly status: "PASS" | "FAIL" | "REFUSED";
	readonly promotable: boolean;
	readonly failureCode: CampaignFailureCode | null;
	readonly refusalCode: CampaignRefusalCode | null;
	readonly sealedPath: string | null;
	readonly artifactSha256: string | null;
	readonly primaryMetricP50: number | null;
	readonly readPath: CampaignIndexReadPathV2 | null;
}

export interface CampaignIndexV2 {
	readonly schema: typeof CAMPAIGN_INDEX_V2_SCHEMA;
	readonly campaignRunId: string;
	readonly stage: "phase4" | "full";
	readonly candidate: string;
	readonly campaignId: string;
	readonly approvedPlanSha256: string;
	readonly approvalRecordSha256: string;
	readonly stagedCapabilitySha256: string;
	readonly sourceArchiveSha256: string;
	readonly executionPurpose: ExecutionPurpose;
	readonly cells: readonly string[];
	readonly arms: readonly ("ws" | "wt")[];
	readonly armKinds: readonly ("primary" | "read-path" | "overlay")[];
	readonly warmupRepetitions: 1;
	readonly measuredRepetitions: 1 | 5;
	readonly scheduledMeasuredArms: number;
	readonly entries: readonly CampaignIndexEntryV2[];
}

export interface VerifyCampaignIndexCounts {
	readonly ok: true;
	readonly passCount: number;
	readonly failCount: number;
	readonly refusedCount: number;
	/**
	 * Entries the index calls promotable that also survived verification.
	 *
	 * Always `0` under `integrityOnly`: a partial verification proves bytes,
	 * not promotion, so it may not raise this above zero.
	 */
	readonly promotableCount: number;
	readonly sealedCount: number;
	/** Top-level echo flats under the campaign root, excluding run control. */
	readonly flatCount: number;
	/** `<cell>-ws.json` files with a `<cell>-wt.json` beside them. */
	readonly pairCount: number;
	/** Cells whose §6 5+5 set gate passed. Empty under `integrityOnly`. */
	readonly promotedCells: readonly string[];
	/** §6 rule 4: 60 measured PASS seals and six paired promotions. */
	readonly canonicalFanoutComplete: boolean;
	readonly integrityOnly: boolean;
	/**
	 * Seals whose attestation graph was verified against the staged supervisor
	 * public keys.
	 *
	 * Zero unless both `--mac-public-key` and `--rig-public-key` are supplied:
	 * without key material there is nothing to verify signatures against, and a
	 * run that opened no signature graph may not read as one that did.
	 */
	readonly attestationsVerified: number;
}

export type VerifyCampaignIndexResult =
	| VerifyCampaignIndexCounts
	| { readonly ok: false; readonly code: string; readonly message: string };

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Files the run wrapper owns at the campaign root. `controller-terminal.json`
 * correlates the controller exit code with the terminal kind; counting it as an
 * echo flat failed every wrapper-protocol focused run after a clean integrity
 * pass.
 */
const RUN_CONTROL_FILENAMES = new Set([
	"campaign-index.json",
	"manifest.json",
	"controller-terminal.json",
]);

function reject(code: string, message: string): VerifyCampaignIndexResult {
	return { ok: false, code, message };
}

/** Encoded cell id as it appears in a flat filename. */
function safeCellName(cellId: string): string {
	return cellId.replace(/[/:]/g, "_");
}

function parseFlag(argv: readonly string[], name: string): string | undefined {
	const prefix = `--${name}=`;
	for (const arg of argv) {
		if (arg.startsWith(prefix)) return arg.slice(prefix.length);
	}
	return undefined;
}

function sha256Bytes(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function isInsideRoot(root: string, target: string): boolean {
	const rel = relative(resolve(root), resolve(target));
	return rel === "" || (!rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function readCampaignIndexV2(path: string): CampaignIndexV2 | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as CampaignIndexV2;
		if (parsed?.schema !== CAMPAIGN_INDEX_V2_SCHEMA) return undefined;
		if (!Array.isArray(parsed.entries)) return undefined;
		return parsed;
	} catch {
		return undefined;
	}
}

export function campaignIndexEntryKey(
	entry: Pick<
		CampaignIndexEntryV2,
		"cellId" | "armId" | "repetitionIndex" | "transport"
	>,
): string {
	return `${entry.cellId}|${entry.armId}|${entry.transport}|${entry.repetitionIndex}`;
}

export type IndexEntryConsistency =
	| { readonly ok: true }
	| { readonly ok: false; readonly code: string; readonly message: string };

export function validateIndexEntryConsistency(
	entry: CampaignIndexEntryV2,
): IndexEntryConsistency {
	// A campaign index is an index of measured repetitions. The warmup is
	// unsealed by construction (`armRepetitionSchedule` gives it repetition
	// index 0, so it can never collide with a measured index), so an entry
	// that carries the warmup kind -- or the warmup index under a measured
	// label -- is an unmeasured run being counted as evidence. The type says
	// `"measured"`; the bytes on disk do not, and this is where they are read.
	if ((entry.repetitionKind as string) !== "measured") {
		return {
			ok: false,
			code: "TRUST_PROTOCOL",
			message: `entry ${entry.armId} is a ${entry.repetitionKind} repetition; a sealed campaign index holds measured repetitions only`,
		};
	}
	if (
		!Number.isSafeInteger(entry.repetitionIndex) ||
		entry.repetitionIndex < 1
	) {
		return {
			ok: false,
			code: "TRUST_PROTOCOL",
			message: `entry ${entry.armId} has repetitionIndex ${entry.repetitionIndex}; measured repetitions are numbered from 1 and 0 is the warmup`,
		};
	}
	if (entry.status === "PASS") {
		if (entry.failureCode !== null || entry.refusalCode !== null) {
			return {
				ok: false,
				code: "TRUST_PROTOCOL",
				message: "PASS requires null codes",
			};
		}
		if (!entry.sealedPath || !entry.artifactSha256) {
			return {
				ok: false,
				code: "TRUST_PROTOCOL",
				message: "PASS requires sealed path+sha",
			};
		}
		return { ok: true };
	}
	if (entry.status === "FAIL") {
		if (entry.failureCode === null || entry.promotable !== false) {
			return {
				ok: false,
				code: "TRUST_PROTOCOL",
				message: "FAIL requires failureCode and promotable=false",
			};
		}
		return { ok: true };
	}
	if (entry.status === "REFUSED") {
		if (
			entry.refusalCode === null ||
			entry.sealedPath !== null ||
			entry.promotable !== false
		) {
			return {
				ok: false,
				code: "TRUST_PROTOCOL",
				message: "REFUSED requires refusalCode, no sealed path",
			};
		}
		return { ok: true };
	}
	return { ok: false, code: "TRUST_PROTOCOL", message: "unknown status" };
}

/**
 * Physical-budget amendment D6: a pilot or canonical index is refused when a
 * sealed arm's totals are not the cell's cardinalities.
 *
 * The §4.5 promotion predicate compares the same totals, but a pilot never
 * promotes and a canonical arm that misses is merely non-promotable, so until
 * this check a cell whose relay delivered two orders of magnitude below its
 * gate sealed PASS entries and satisfied every wrapper count. The totals are
 * the ones `reconstructCohortEvidenceOffline` recomputed from the retained
 * partials, never the seal's own summary.
 */
export function checkExpectedTotals(args: {
	readonly cellId: string;
	readonly armKind: ArmKind;
	readonly executionPurpose: ExecutionPurpose;
	readonly reconstruction: Pick<
		CohortReconstruction,
		"publisherCount" | "subscriberCount" | "ledger"
	>;
}): IndexEntryConsistency {
	if (
		args.executionPurpose !== "pilot" &&
		args.executionPurpose !== "canonical"
	) {
		return { ok: true };
	}
	const cell = cohortCellForArm({
		cellId: args.cellId,
		armKind: args.armKind,
	});
	if (cell === null) return { ok: true };
	const cardinality = cohortCellCardinality(cell);
	const { ledger } = args.reconstruction;
	const expected: readonly (readonly [string, number, number])[] = [
		[
			"publishers",
			args.reconstruction.publisherCount,
			cardinality.publisherCount,
		],
		[
			"subscribers",
			args.reconstruction.subscriberCount,
			cardinality.subscriberCount,
		],
		["offered ingress", ledger.offeredIngress, cardinality.measuredIngress],
		[
			"accepted ingress",
			ledger.serverAcceptedIngress,
			cardinality.measuredIngress,
		],
		["delivered", ledger.delivered, cardinality.expandedDeliveries],
	];
	const differing = expected.filter(([, actual, wanted]) => actual !== wanted);
	if (differing.length === 0) return { ok: true };
	return {
		ok: false,
		code: "EXPECTED_TOTALS_MISMATCH",
		message: `${args.cellId} sealed ${differing
			.map(([what, actual, wanted]) => `${what} ${actual} (cell ${wanted})`)
			.join(", ")} under ${args.executionPurpose}`,
	};
}

/**
 * The topology a frozen run section registers: which cells, which wires, which
 * arm kinds, and how many measured repetitions each of those arms runs.
 *
 * The count expectations (`--expected-pass-count` and friends) are blind to
 * `transport`, `armKind` and `repetitionKind`, so `--expected-pass-count=2`
 * reads the same for the registered ws+wt primary pair, for two runs of one
 * wire, for a read-path arm standing in for a primary, and for a warmup a
 * producer relabelled. Those numbers are the producer's own argv restated. This
 * is the shape the section actually registered, and every measured seal is
 * proved against it.
 */
export interface RegisteredCampaignTopology {
	readonly cells: readonly string[];
	readonly arms: readonly ("ws" | "wt")[];
	readonly armKinds: readonly ("primary" | "read-path" | "overlay")[];
	readonly measuredRepetitions: 1 | 5;
}

function sameMembers(
	actual: readonly string[],
	expected: readonly string[],
): boolean {
	if (actual.length !== expected.length) return false;
	const left = [...actual].sort();
	const right = [...expected].sort();
	return left.every((value, i) => value === right[i]);
}

function topologyKey(
	cellId: string,
	transport: string,
	armKind: string,
): string {
	return `${cellId} ${transport} ${armKind}`;
}

/**
 * Prove the index's entries are exactly the registered topology's measured
 * arms, each PASSing every one of its repetitions.
 *
 * Runs before any seal is opened: it reads the index only, so a topology the
 * section never registered is named before the verifier spends a signature
 * check on it.
 */
export function proveRegisteredTopology(
	index: CampaignIndexV2,
	expected: RegisteredCampaignTopology,
): IndexEntryConsistency {
	if (!sameMembers(index.cells, expected.cells)) {
		return {
			ok: false,
			code: "TRUST_PROTOCOL",
			message: `index cells [${index.cells.join(",")}] are not the registered cells [${expected.cells.join(",")}]`,
		};
	}
	if (!sameMembers(index.arms, expected.arms)) {
		return {
			ok: false,
			code: "TRUST_PROTOCOL",
			message: `index arms [${index.arms.join(",")}] are not the registered arms [${expected.arms.join(",")}]`,
		};
	}
	if (!sameMembers(index.armKinds, expected.armKinds)) {
		return {
			ok: false,
			code: "TRUST_PROTOCOL",
			message: `index armKinds [${index.armKinds.join(",")}] are not the registered armKinds [${expected.armKinds.join(",")}]`,
		};
	}
	if (index.measuredRepetitions !== expected.measuredRepetitions) {
		return {
			ok: false,
			code: "TRUST_PROTOCOL",
			message: `index measuredRepetitions ${index.measuredRepetitions} is not the registered ${expected.measuredRepetitions}`,
		};
	}
	const scheduled =
		expected.cells.length *
		expected.arms.length *
		expected.armKinds.length *
		expected.measuredRepetitions;
	if (index.scheduledMeasuredArms !== scheduled) {
		return {
			ok: false,
			code: "TRUST_PROTOCOL",
			message: `index scheduledMeasuredArms ${index.scheduledMeasuredArms} is not the ${scheduled} the registered topology schedules`,
		};
	}
	const cells = new Set(expected.cells);
	const arms = new Set<string>(expected.arms);
	const armKinds = new Set<string>(expected.armKinds);
	const observed = new Map<string, number[]>();
	for (const entry of index.entries) {
		const where = topologyKey(entry.cellId, entry.transport, entry.armKind);
		if (!cells.has(entry.cellId)) {
			return {
				ok: false,
				code: "TRUST_PROTOCOL",
				message: `entry ${entry.armId} runs cell ${entry.cellId}, which the registered topology does not schedule`,
			};
		}
		if (!arms.has(entry.transport)) {
			return {
				ok: false,
				code: "TRUST_PROTOCOL",
				message: `entry ${entry.armId} runs transport ${entry.transport}, which the registered topology does not schedule`,
			};
		}
		if (!armKinds.has(entry.armKind)) {
			return {
				ok: false,
				code: "TRUST_PROTOCOL",
				message: `entry ${entry.armId} is a ${entry.armKind} arm, which the registered topology does not schedule`,
			};
		}
		if (entry.status !== "PASS") {
			return {
				ok: false,
				code: "TRUST_PROTOCOL",
				message: `${where} is ${entry.status}; every registered measured arm must PASS`,
			};
		}
		if (index.executionPurpose !== "canonical" && entry.promotable) {
			return {
				ok: false,
				code: "TRUST_PROTOCOL",
				message: `${where} claims promotable under ${index.executionPurpose}`,
			};
		}
		if (entry.repetitionTotal !== expected.measuredRepetitions) {
			return {
				ok: false,
				code: "TRUST_PROTOCOL",
				message: `${where} declares repetitionTotal ${entry.repetitionTotal}; the registered topology runs ${expected.measuredRepetitions}`,
			};
		}
		const indices = observed.get(where);
		if (indices) indices.push(entry.repetitionIndex);
		else observed.set(where, [entry.repetitionIndex]);
	}
	// Missing arms are named before duplicated ones: a run that measured one
	// wire twice is first of all a run that never measured the other.
	for (const cellId of expected.cells) {
		for (const transport of expected.arms) {
			for (const armKind of expected.armKinds) {
				if (!observed.has(topologyKey(cellId, transport, armKind))) {
					return {
						ok: false,
						code: "TRUST_PROTOCOL",
						message: `no measured PASS entry for ${topologyKey(cellId, transport, armKind)}`,
					};
				}
			}
		}
	}
	for (const [where, indices] of observed) {
		for (let rep = 1; rep <= expected.measuredRepetitions; rep += 1) {
			const found = indices.filter((index) => index === rep).length;
			if (found === 1) continue;
			return {
				ok: false,
				code: "TRUST_PROTOCOL",
				message:
					found === 0
						? `${where} is missing measured repetition ${rep}`
						: `${where} has ${found} entries for measured repetition ${rep}`,
			};
		}
	}
	if (index.entries.length !== scheduled) {
		return {
			ok: false,
			code: "TRUST_PROTOCOL",
			message: `index holds ${index.entries.length} entries; the registered topology schedules ${scheduled}`,
		};
	}
	return { ok: true };
}

/**
 * The digest the frozen run command carries as `--external-trust-bound-sha256`
 * is minted by the stage tool over the staged material
 * (`external-trust-bound/v1`). Until it is recomputed it is a marker, and a
 * marker is what the quarantine refuses. The verifier holds every preimage
 * field at verification time: the candidate, campaign, capability and archive
 * digests from the index it is proving, both signing leaves from the flags it
 * opens the signature graph with, and the authority, lock and directory
 * identities from the stage receipt the frozen command names. The receipt's
 * own copies of the shared fields are held to the index and the leaves, so a
 * receipt from another stage is named rather than averaged in.
 */
export function validateExternalTrustBound(args: {
	readonly stageReceiptPath: string;
	readonly externalTrustBoundSha256: string;
	readonly index: Pick<
		CampaignIndexV2,
		| "candidate"
		| "campaignId"
		| "stagedCapabilitySha256"
		| "sourceArchiveSha256"
	>;
	readonly macPublicKeySha256: string;
	readonly rigPublicKeySha256: string;
}):
	| { readonly ok: true; readonly validation: ExternalTrustBoundValidation }
	| { readonly ok: false; readonly code: string; readonly message: string } {
	const mismatch = (message: string) => ({
		ok: false as const,
		code: "EXTERNAL_TRUST_BOUND_MISMATCH",
		message,
	});
	let st: ReturnType<typeof lstatSync>;
	try {
		st = lstatSync(args.stageReceiptPath);
	} catch {
		return mismatch(`stage receipt is absent: ${args.stageReceiptPath}`);
	}
	if (!st.isFile()) {
		return mismatch(
			`stage receipt is not a regular file: ${args.stageReceiptPath}`,
		);
	}
	const bytes = new Uint8Array(readFileSync(args.stageReceiptPath));
	const parsed = parseStrictJsonBytes(bytes);
	if (!parsed.ok) {
		return mismatch(`stage receipt is not strict JSON: ${parsed.reason}`);
	}
	if (`${canonicalJson(parsed.value)}\n` !== new TextDecoder().decode(bytes)) {
		return mismatch("stage receipt is not the stage tool's canonical bytes");
	}
	if (
		parsed.value === null ||
		typeof parsed.value !== "object" ||
		Array.isArray(parsed.value)
	) {
		return mismatch("stage receipt is not a live-stage-receipt/v1 record");
	}
	const receipt = parsed.value as Record<string, unknown>;
	if (receipt.schema !== "live-stage-receipt/v1") {
		return mismatch("stage receipt is not a live-stage-receipt/v1 record");
	}
	for (const field of [
		...EXTERNAL_TRUST_BOUND_PREIMAGE_FIELDS,
		"externalTrustBoundSha256",
	] as const) {
		const value = receipt[field];
		const wellFormed =
			field === "candidate" || field === "campaignId"
				? typeof value === "string" && value.length > 0
				: typeof value === "string" && SHA256_HEX.test(value);
		if (!wellFormed) {
			return mismatch(`stage receipt field ${field} is missing or malformed`);
		}
	}
	if (receipt.externalTrustBoundSha256 !== args.externalTrustBoundSha256) {
		return mismatch(
			`stage receipt was minted for bound ${String(receipt.externalTrustBoundSha256)}, the command carries ${args.externalTrustBoundSha256}`,
		);
	}
	// The fields the verifier already holds are taken from where it holds
	// them; the receipt must merely agree.
	const held: Pick<
		ExternalTrustBoundPreimageV1,
		| "candidate"
		| "campaignId"
		| "capabilitySha256"
		| "archiveSha256"
		| "macSigningPublicKeySha256"
		| "rigSigningPublicKeySha256"
	> = {
		candidate: args.index.candidate,
		campaignId: args.index.campaignId,
		capabilitySha256: args.index.stagedCapabilitySha256,
		archiveSha256: args.index.sourceArchiveSha256,
		macSigningPublicKeySha256: args.macPublicKeySha256,
		rigSigningPublicKeySha256: args.rigPublicKeySha256,
	};
	for (const [field, value] of Object.entries(held)) {
		if (receipt[field] !== value) {
			return mismatch(
				`stage receipt ${field} ${String(receipt[field])} is not the verifier's ${value}`,
			);
		}
	}
	const recomputedSha256 = externalTrustBoundSha256({
		...held,
		authoritySha256: receipt.authoritySha256 as string,
		lockSha256: receipt.lockSha256 as string,
		macDirectoryIdentitySha256: receipt.macDirectoryIdentitySha256 as string,
		linuxDirectoryIdentitySha256:
			receipt.linuxDirectoryIdentitySha256 as string,
	});
	if (recomputedSha256 !== args.externalTrustBoundSha256) {
		return mismatch(
			`${EXTERNAL_TRUST_BOUND_SCHEMA} recomputed as ${recomputedSha256}, the command carries ${args.externalTrustBoundSha256}`,
		);
	}
	return {
		ok: true,
		validation: {
			sha256: args.externalTrustBoundSha256,
			recomputedSha256,
			method: `${EXTERNAL_TRUST_BOUND_SCHEMA} recomputed from the campaign index, the staged public leaves and the stage receipt`,
		},
	};
}

/**
 * The index entry reduced to what the §6 set gate reads.
 *
 * `receiptGraphComplete` is the artifact verifier's answer, not a default: it
 * is true only for an entry whose seal passed `verifyRunArtifact` in this same
 * pass, which is where the cohort reconstruction and both issuer graphs are
 * checked. An entry that was never opened (integrity-only, or a non-PASS
 * status) leaves it false and the gate refuses fail-closed.
 */
function toGateEntry(
	entry: CampaignIndexEntryV2,
	campaignId: string,
	receiptGraphComplete: boolean,
): PromotionGateEntry {
	return {
		campaignId,
		cellId: entry.cellId,
		transport: entry.transport,
		armKind: entry.armKind,
		executionPurpose: entry.executionPurpose,
		repetitionKind: entry.repetitionKind,
		repetitionIndex: entry.repetitionIndex,
		repetitionTotal: entry.repetitionTotal,
		status: entry.status,
		promotable: entry.promotable,
		sealedPath: entry.sealedPath,
		artifactSha256: entry.artifactSha256,
		receiptGraphComplete,
		primaryMetricP50: entry.primaryMetricP50,
	};
}

/**
 * Recursively verify a campaign index and every indexed sealed artifact.
 */
export function verifyCampaignIndex(args: {
	readonly campaignRoot: string;
	readonly indexPath: string;
	readonly externalTrustBoundSha256: string;
	readonly macPublicKeyPath?: string;
	readonly rigPublicKeyPath?: string;
	/**
	 * The stage receipt the bound was minted from. With it and both leaves the
	 * bound is recomputed (`validateExternalTrustBound`); without it no entry
	 * can be promotable, because a bound nobody recomputed is a marker.
	 */
	readonly stageReceiptPath?: string;
	/**
	 * Test seam: observe (and return) the trust context each seal's
	 * `verifyRunArtifact` receives. Production passes nothing.
	 */
	readonly artifactVerificationContext?: (
		context: ArtifactTrustContext,
	) => ArtifactTrustContext;
	readonly expectedPassCount?: number;
	readonly expectedFailCount?: number;
	readonly expectedRefusedCount?: number;
	readonly expectedPromotableCount?: number;
	readonly expectedFlatCount?: number;
	readonly expectedPairCount?: number;
	readonly expectedSealedCount?: number;
	/**
	 * The frozen section's registered topology. Supplied, every measured seal
	 * is proved against the shape the section registered rather than against
	 * the producer's own count argv.
	 */
	readonly expectedTopology?: RegisteredCampaignTopology;
	/**
	 * Require §6 rule 4: six paired promotions and sixty measured PASS seals
	 * over the frozen fanout cells. Anything less is not "mostly canonical".
	 */
	readonly expectCanonicalFanoutComplete?: boolean;
	/**
	 * Bytes, paths, digests and index self-consistency only.
	 *
	 * A partial verification is a useful triage tool and a dishonest promotion
	 * input: it never opens the signature graph, so it may not raise
	 * `promotableCount` above zero, may not promote a cell, and may not change
	 * any entry's status.
	 */
	readonly integrityOnly?: boolean;
}): VerifyCampaignIndexResult {
	const integrityOnly = args.integrityOnly === true;
	if (!SHA256_HEX.test(args.externalTrustBoundSha256)) {
		return reject(
			"TRUST_PROTOCOL",
			"externalTrustBoundSha256 must be a sha-256 hex digest",
		);
	}
	for (const [flag, path] of [
		["mac-public-key", args.macPublicKeyPath],
		["rig-public-key", args.rigPublicKeyPath],
	] as const) {
		if (path === undefined) continue;
		if (!existsSync(path) || !lstatSync(path).isFile()) {
			return reject(
				"TRUST_PROTOCOL",
				`--${flag} does not name a readable regular file: ${path}`,
			);
		}
	}
	// The staged keys are the raw 32-byte Ed25519 public keys the stage tool
	// writes as `mac-supervisor-ed25519.pub` / `rig-supervisor-ed25519.pub`.
	// Both or neither: half the trust material verifies half the graph, which is
	// exactly the shape of a flag that reads as evidence and proves nothing.
	let attestationTrust: AttestationTrustMaterial | null = null;
	if (
		(args.macPublicKeyPath === undefined) !==
		(args.rigPublicKeyPath === undefined)
	) {
		return reject(
			"TRUST_PROTOCOL",
			"--mac-public-key and --rig-public-key must be supplied together",
		);
	}
	if (
		args.macPublicKeyPath !== undefined &&
		args.rigPublicKeyPath !== undefined
	) {
		const macPublicRaw32 = new Uint8Array(readFileSync(args.macPublicKeyPath));
		const rigPublicRaw32 = new Uint8Array(readFileSync(args.rigPublicKeyPath));
		for (const [flag, raw] of [
			["mac-public-key", macPublicRaw32],
			["rig-public-key", rigPublicRaw32],
		] as const) {
			if (raw.byteLength !== 32) {
				return reject(
					"TRUST_PROTOCOL",
					`--${flag} must be a raw 32-byte Ed25519 public key, got ${raw.byteLength} bytes`,
				);
			}
		}
		attestationTrust = {
			macPublicRaw32,
			rigPublicRaw32,
			macPublicKeySha256: publicKeySha256(macPublicRaw32),
			rigPublicKeySha256: publicKeySha256(rigPublicRaw32),
		};
	}
	if (args.stageReceiptPath !== undefined && attestationTrust === null) {
		return reject(
			"TRUST_PROTOCOL",
			"--stage-receipt needs --mac-public-key and --rig-public-key: the bound is recomputed over the staged leaves",
		);
	}
	if (
		integrityOnly &&
		args.expectedPromotableCount !== undefined &&
		args.expectedPromotableCount !== 0
	) {
		return reject(
			"TRUST_PROTOCOL",
			"integrity-only verification cannot promote: expectedPromotableCount must be 0",
		);
	}
	if (integrityOnly && args.expectCanonicalFanoutComplete === true) {
		return reject(
			"TRUST_PROTOCOL",
			"integrity-only verification cannot complete the canonical fanout claim",
		);
	}
	const index = readCampaignIndexV2(args.indexPath);
	if (!index) {
		return {
			ok: false,
			code: "TRUST_PROTOCOL",
			message: "campaign-index/v2 missing or invalid",
		};
	}
	if (
		typeof index.sourceArchiveSha256 !== "string" ||
		!/^[0-9a-f]{64}$/.test(index.sourceArchiveSha256)
	) {
		return {
			ok: false,
			code: "TRUST_PROTOCOL",
			message: "campaign-index missing sourceArchiveSha256",
		};
	}
	if (index.sourceArchiveSha256 === index.approvedPlanSha256) {
		return {
			ok: false,
			code: "TRUST_PROTOCOL",
			message: "sourceArchiveSha256 must not equal approvedPlanSha256",
		};
	}
	if (!isInsideRoot(args.campaignRoot, args.indexPath)) {
		return {
			ok: false,
			code: "TRUST_PROTOCOL",
			message: "index path outside campaign root",
		};
	}

	if (args.expectedTopology) {
		const topology = proveRegisteredTopology(index, args.expectedTopology);
		if (!topology.ok) return topology;
	}

	// A canonical entry that claims promotion is a claim against the external
	// trust bound, so the bound is recomputed before any seal is opened: an
	// index that claims promotion without the material to check the claim is
	// refused here, not sixty seals later by the quarantine's fallback. (A
	// focused or pilot entry claiming promotion is refused by the purpose rule
	// in the loop below, which names the entry.)
	let externalTrustBoundValidation: ExternalTrustBoundValidation | undefined;
	if (args.stageReceiptPath !== undefined && attestationTrust !== null) {
		const validated = validateExternalTrustBound({
			stageReceiptPath: args.stageReceiptPath,
			externalTrustBoundSha256: args.externalTrustBoundSha256,
			index,
			macPublicKeySha256: attestationTrust.macPublicKeySha256,
			rigPublicKeySha256: attestationTrust.rigPublicKeySha256,
		});
		if (!validated.ok) return validated;
		externalTrustBoundValidation = validated.validation;
	} else if (
		!integrityOnly &&
		index.executionPurpose === "canonical" &&
		index.entries.some((entry) => entry.promotable)
	) {
		return reject(
			"EXTERNAL_TRUST_BOUND_UNVALIDATED",
			"the index carries promotable entries and the external trust bound was not recomputed: pass --stage-receipt with both staged public leaves",
		);
	}

	const indexedSealed = new Set<string>();
	let passCount = 0;
	let failCount = 0;
	let refusedCount = 0;
	let promotableCount = 0;
	let sealedCount = 0;
	let attestationsVerified = 0;
	const seenKeys = new Set<string>();
	const gateEntries: PromotionGateEntry[] = [];

	for (const entry of index.entries) {
		const consistency = validateIndexEntryConsistency(entry);
		if (!consistency.ok) return consistency;
		// Focused and pilot verify but never promote, and an entry minted under
		// one purpose may not be carried into an index declaring another.
		if (entry.executionPurpose !== index.executionPurpose) {
			return reject(
				"TRUST_PROTOCOL",
				`mixed purpose: entry ${entry.armId} is ${entry.executionPurpose} inside a ${index.executionPurpose} index`,
			);
		}
		if (index.executionPurpose !== "canonical" && entry.promotable) {
			return reject(
				"TRUST_PROTOCOL",
				`${index.executionPurpose} entry ${entry.armId} claims promotable:true`,
			);
		}
		const key = campaignIndexEntryKey(entry);
		if (seenKeys.has(key)) {
			return {
				ok: false,
				code: "TRUST_PROTOCOL",
				message: `duplicate index entry ${key}`,
			};
		}
		seenKeys.add(key);
		if (entry.status === "PASS") passCount += 1;
		if (entry.status === "FAIL") failCount += 1;
		if (entry.status === "REFUSED") refusedCount += 1;
		if (entry.promotable) promotableCount += 1;

		if (entry.sealedPath) {
			const sealedAbs = isAbsolute(entry.sealedPath)
				? entry.sealedPath
				: join(args.campaignRoot, entry.sealedPath);
			if (!isInsideRoot(args.campaignRoot, sealedAbs)) {
				return {
					ok: false,
					code: "TRUST_PROTOCOL",
					message: "sealed path traversal",
				};
			}
			let st: ReturnType<typeof lstatSync>;
			try {
				st = lstatSync(sealedAbs);
			} catch {
				return reject(
					"TRUST_PROTOCOL",
					`indexed sealed artifact is absent: ${entry.sealedPath}`,
				);
			}
			if (st.isSymbolicLink()) {
				return {
					ok: false,
					code: "TRUST_PROTOCOL",
					message: "symlink sealed path",
				};
			}
			if (!sealedAbs.endsWith(".sealed.json")) {
				return {
					ok: false,
					code: "TRUST_PROTOCOL",
					message: "sealed path must end with .sealed.json",
				};
			}
			const bytes = new Uint8Array(readFileSync(sealedAbs));
			const sha = sha256Bytes(bytes);
			if (entry.artifactSha256 !== sha) {
				return {
					ok: false,
					code: "TRUST_PROTOCOL",
					message: "artifact sha mismatch",
				};
			}
			// Reject treating the index JSON itself as an artifact.
			let parsed: RunArtifact;
			try {
				parsed = JSON.parse(new TextDecoder().decode(bytes)) as RunArtifact;
				if (
					(parsed as { schema?: string }).schema === CAMPAIGN_INDEX_V2_SCHEMA
				) {
					return {
						ok: false,
						code: "TRUST_PROTOCOL",
						message: "index JSON presented as artifact",
					};
				}
			} catch {
				return {
					ok: false,
					code: "TRUST_PROTOCOL",
					message: "sealed artifact is not JSON",
				};
			}
			if (integrityOnly) {
				// Bytes proved, graph unopened. The entry counts toward
				// `sealedCount` and nothing else: no gate entry is minted, so no
				// cell can promote out of a partial pass.
				indexedSealed.add(resolve(sealedAbs));
				sealedCount += 1;
				continue;
			}
			// The per-rep identity (runId, toolchains, sidecar digests) is the
			// artifact's own -- the index does not restate it, and the artifact's
			// internal signatures bind it. The staged anchors are the index's:
			// candidate, source archive, and capability digests come from the
			// stage receipt, so a seal produced under different bytes is named
			// here rather than accepted on its own word.
			// The staged keys ride in the same context: a cohort seal's export
			// receipt and both issuer graphs verify offline only under them
			// (`reconstructCohortEvidenceOffline`), and a verifier that opened
			// the attestation graph with the keys but verified the artifact
			// without them could never pass a cohort seal.
			let context: ArtifactTrustContext;
			try {
				context = {
					...trustContextForArtifact(parsed),
					comparisonId: index.campaignId,
					transport: entry.transport,
					sourceSha: index.candidate,
					archiveSha256: index.sourceArchiveSha256,
					executableSha256: index.stagedCapabilitySha256,
					...(attestationTrust !== null
						? {
								stagedMacPublicRaw32: attestationTrust.macPublicRaw32,
								stagedRigPublicRaw32: attestationTrust.rigPublicRaw32,
							}
						: {}),
				};
				if (args.artifactVerificationContext !== undefined) {
					context = args.artifactVerificationContext(context);
				}
			} catch {
				return {
					ok: false,
					code: "TRUST_PROTOCOL",
					message: `sealed artifact has no readable identity: ${entry.sealedPath}`,
				};
			}
			const verification = verifyRunArtifact(bytes, context);
			if (verification.evidenceStatus !== "PASS") {
				const detail = verification.rejections
					.map((r) => `${r.code}${r.path !== undefined ? ` ${r.path}` : ""}`)
					.join("; ");
				return {
					ok: false,
					code: "TRUST_PROTOCOL",
					message: `artifact verify failed for ${entry.sealedPath}: ${detail}`,
				};
			}
			if (parsed.promotable !== entry.promotable) {
				return {
					ok: false,
					code: "TRUST_PROTOCOL",
					message: `index promotable=${entry.promotable} contradicts sealed artifact for ${entry.sealedPath}`,
				};
			}
			// The external trust bound is what promotion is measured against; a
			// non-promotable entry claims nothing the bound could anchor.
			if (entry.promotable) {
				const quarantine = checkPromotionQuarantine({
					artifact: parsed,
					externalTrustBound: args.externalTrustBoundSha256,
					externalTrustBoundValidation,
					expectedComparisonId: index.campaignId,
				});
				if (!quarantine.promotable) {
					const detail = quarantine.reasons
						.map((reason) => reason.code)
						.join("; ");
					return {
						ok: false,
						code: "TRUST_PROTOCOL",
						message: `promotable entry fails quarantine for ${entry.sealedPath}: ${detail}`,
					};
				}
			}
			// B4: the six primary fanout cells seal a cohort. The artifact verifier
			// reconstructs it; the index verifier states the same decision at its
			// own layer so a seal whose cohort evidence never reached the trust
			// context is named here rather than counted.
			if (requiresCohortObservationEvidence(entry.cellId, entry.armKind)) {
				const attestation = parsed.attestationEvidence as
					| {
							readonly executionSha256?: unknown;
							readonly cohortObservationEvidence?: unknown;
					  }
					| undefined;
				if (
					parsed.cohortEvidenceExport === null ||
					parsed.cohortEvidenceExport === undefined ||
					attestation?.cohortObservationEvidence === null ||
					attestation?.cohortObservationEvidence === undefined
				) {
					return reject(
						"COHORT_PROTOCOL",
						`${entry.cellId} is a cohort cell and its seal carries no cohort evidence: ${entry.sealedPath}`,
					);
				}
				if (
					context.cohortObservationEvidenceSha256 !==
					parsed.cohortEvidenceExport.cohortObservationEvidenceSha256
				) {
					return reject(
						"COHORT_PROTOCOL",
						`trust context cohort digest does not match the export receipt for ${entry.sealedPath}`,
					);
				}
				// `verifyRunArtifact` reconstructed this cohort and passed, so the
				// reconstruction below cannot fail; it is repeated because the
				// verifier keeps its totals to itself and this index-level refusal
				// needs them, not a restatement from the seal.
				const reconstruction = reconstructCohortEvidenceOffline({
					cellId: entry.cellId,
					armKind: entry.armKind,
					transport: entry.transport,
					executionSha256: String(attestation?.executionSha256 ?? ""),
					cohortObservationEvidence: attestation?.cohortObservationEvidence,
					cohortEvidenceExport: parsed.cohortEvidenceExport,
					stagedMacPublicRaw32: context.stagedMacPublicRaw32,
					stagedRigPublicRaw32: context.stagedRigPublicRaw32,
				});
				if (!reconstruction.ok) {
					return reject(
						"COHORT_PROTOCOL",
						`cohort evidence does not reconstruct for ${entry.sealedPath}: ${reconstruction.code} ${reconstruction.reason}`,
					);
				}
				const totals = checkExpectedTotals({
					cellId: entry.cellId,
					armKind: entry.armKind,
					executionPurpose: index.executionPurpose,
					reconstruction,
				});
				if (!totals.ok) {
					return reject(totals.code, `${totals.message}: ${entry.sealedPath}`);
				}
			} else if (
				parsed.cohortEvidenceExport !== null &&
				parsed.cohortEvidenceExport !== undefined
			) {
				return reject(
					"COHORT_PROTOCOL",
					`${entry.cellId}/${entry.armKind} runs no cohort yet its seal carries an export receipt: ${entry.sealedPath}`,
				);
			}
			// R6: with the staged supervisor keys in hand, open the attestation
			// graph itself. `verifyArmAttestationEvidence` re-derives every
			// retained byte field, verifies the Mac/rig signatures, and decides
			// the cohort shape from this entry's own cell and arm -- so a
			// Phase-A seal carrying a cohort and a fanout seal carrying none are
			// both named here. The identity it is held to is the *index's*
			// (campaign, candidate, plan, approval, transport, repetition); only
			// `executionSha256` comes from the artifact, and that is the digest
			// every signature in the graph is taken over.
			if (attestationTrust !== null) {
				// `verifyRunArtifact` above already proved this is an
				// `arm-attestation-evidence/v2` record; `RunArtifact` types its
				// nested members as `unknown` because nothing else needs them.
				const attestation =
					parsed.attestationEvidence as unknown as ArmAttestationEvidenceV2;
				const attested = verifyArmAttestationEvidence(
					attestation,
					attestationTrust,
					{
						executionSha256: attestation.executionSha256,
						executionPurpose: index.executionPurpose,
						cellId: entry.cellId,
						armKind: entry.armKind,
						transport: entry.transport,
						repetitionKind: entry.repetitionKind,
						repetitionIndex: entry.repetitionIndex,
						repetitionTotal: entry.repetitionTotal,
						campaignId: index.campaignId,
						candidate: index.candidate,
						approvedPlanSha256: index.approvedPlanSha256,
						approvalRecordSha256: index.approvalRecordSha256,
					},
				);
				if (!attested.ok) {
					return reject(
						"TRUST_PROTOCOL",
						`attestation does not verify under the staged supervisor keys for ${entry.sealedPath}: ${attested.code} ${attested.message}`,
					);
				}
				attestationsVerified += 1;
			}
			gateEntries.push(toGateEntry(entry, index.campaignId, true));
			indexedSealed.add(resolve(sealedAbs));
			sealedCount += 1;
		}
	}
	if (integrityOnly) promotableCount = 0;

	// Reject unindexed seals under the campaign root.
	const walk = (dir: string): string[] => {
		const out: string[] = [];
		for (const ent of readdirSync(dir, { withFileTypes: true })) {
			const p = join(dir, ent.name);
			if (ent.isSymbolicLink()) continue;
			if (ent.isDirectory()) out.push(...walk(p));
			else if (ent.isFile() && ent.name.endsWith(".sealed.json")) out.push(p);
		}
		return out;
	};
	for (const sealed of walk(args.campaignRoot)) {
		if (!indexedSealed.has(resolve(sealed))) {
			return {
				ok: false,
				code: "TRUST_PROTOCOL",
				message: `unindexed sealed artifact ${sealed}`,
			};
		}
	}

	if (
		args.expectedPassCount !== undefined &&
		args.expectedPassCount !== passCount
	) {
		return {
			ok: false,
			code: "TRUST_PROTOCOL",
			message: `expectedPassCount ${args.expectedPassCount} got ${passCount}`,
		};
	}
	if (
		args.expectedFailCount !== undefined &&
		args.expectedFailCount !== failCount
	) {
		return {
			ok: false,
			code: "TRUST_PROTOCOL",
			message: `expectedFailCount mismatch`,
		};
	}
	if (
		args.expectedRefusedCount !== undefined &&
		args.expectedRefusedCount !== refusedCount
	) {
		return {
			ok: false,
			code: "TRUST_PROTOCOL",
			message: `expectedRefusedCount mismatch`,
		};
	}
	if (
		args.expectedPromotableCount !== undefined &&
		args.expectedPromotableCount !== promotableCount
	) {
		return {
			ok: false,
			code: "TRUST_PROTOCOL",
			message: `expectedPromotableCount mismatch`,
		};
	}
	if (
		args.expectedSealedCount !== undefined &&
		args.expectedSealedCount !== sealedCount
	) {
		return reject(
			"TRUST_PROTOCOL",
			`expectedSealedCount mismatch: expected ${args.expectedSealedCount}, found ${sealedCount}`,
		);
	}

	const flatNames = readdirSync(args.campaignRoot).filter((name) => {
		if (!name.endsWith(".json")) return false;
		// A seal is evidence, not an echo of it -- even when the campaign layout
		// puts one at the root rather than under `reps/`.
		if (name.endsWith(".sealed.json")) return false;
		if (RUN_CONTROL_FILENAMES.has(name)) return false;
		try {
			return lstatSync(join(args.campaignRoot, name)).isFile();
		} catch {
			return false;
		}
	});
	const flatCount = flatNames.length;
	const pairCount = flatNames.filter((name) => {
		const match = /^(.*)-ws\.json$/.exec(name);
		if (match === null) return false;
		return existsSync(join(args.campaignRoot, `${match[1]}-wt.json`));
	}).length;

	// Focused and pilot write zero flats -- unconditionally, not only when the
	// caller remembered to ask. A flat under a focused root is an echo from an
	// earlier campaign, which is exactly the stale claim §6 rule 4 forbids.
	if (index.executionPurpose !== "canonical" && flatCount !== 0) {
		return reject(
			"TRUST_PROTOCOL",
			`${index.executionPurpose} campaigns write zero flats; found ${flatCount}: ${flatNames.join(", ")}`,
		);
	}

	// Every flat must be backed by a complete §6 set in *this* index. A flat
	// whose cell has no five-of-five paired promotion is a stale echo, and a
	// flat naming a cell the index never scheduled is not this campaign's.
	const safeToCell = new Map(
		index.cells.map((cellId) => [safeCellName(cellId), cellId] as const),
	);
	const flatCells = new Set<string>();
	for (const name of flatNames) {
		const match = /^(.*)-(ws|wt)\.json$/.exec(name);
		const cellId = match === null ? undefined : safeToCell.get(match[1]!);
		if (cellId === undefined) {
			return reject(
				"TRUST_PROTOCOL",
				`stale echo flat: ${name} names no cell scheduled by this index`,
			);
		}
		flatCells.add(cellId);
	}
	const existingFlats = flatNames.flatMap((name) => {
		const match = /^(.*)-(ws|wt)\.json$/.exec(name);
		const cellId = match === null ? undefined : safeToCell.get(match[1]!);
		if (cellId === undefined || match === null) return [];
		return [
			{
				cellId,
				transport: match[2] as "ws" | "wt",
				campaignId: index.campaignId,
			},
		];
	});
	for (const cellId of flatCells) {
		const gate = evaluateCellPromotionGate({
			cellId,
			campaignId: index.campaignId,
			executionPurpose: index.executionPurpose,
			entries: gateEntries.filter(
				(gateEntry) =>
					gateEntry.cellId === cellId && gateEntry.armKind === "primary",
			),
		});
		if (!gate.promotable) {
			return reject(
				"TRUST_PROTOCOL",
				`stale echo flat for ${cellId}: ${gate.refusals.map((r) => r.code).join("; ")}`,
			);
		}
	}

	// The §6 rule 4 completion answer. Computed for canonical indices whose
	// scheduled cells cover the frozen fanout six; every other shape reports
	// `false` rather than a partial claim.
	let promotedCells: readonly string[] = [];
	let canonicalFanoutComplete = false;
	if (
		!integrityOnly &&
		index.executionPurpose === "canonical" &&
		FANOUT_COHORT_CELL_IDS.every((cellId) => index.cells.includes(cellId))
	) {
		const completion = evaluateCanonicalFanoutCompletion({
			campaignId: index.campaignId,
			executionPurpose: index.executionPurpose,
			cellIds: FANOUT_COHORT_CELL_IDS,
			entries: gateEntries.filter((entry) => entry.armKind === "primary"),
			existingFlats,
		});
		promotedCells = completion.promotedCells;
		canonicalFanoutComplete = completion.complete;
		if (args.expectCanonicalFanoutComplete === true && !completion.complete) {
			return reject(
				"TRUST_PROTOCOL",
				`canonical fanout incomplete: ${completion.promotedCells.length}/${CANONICAL_FANOUT_CELL_COUNT} paired promotions, ${completion.measuredPassSeals}/${CANONICAL_FANOUT_MEASURED_SEAL_COUNT} measured PASS seals; ${completion.refusals.map((r) => r.code).join("; ")}`,
			);
		}
	} else if (args.expectCanonicalFanoutComplete === true) {
		return reject(
			"TRUST_PROTOCOL",
			`canonical fanout completion requires a canonical index scheduling all ${CANONICAL_FANOUT_CELL_COUNT} fanout cells`,
		);
	}

	if (
		args.expectedFlatCount !== undefined &&
		flatCount !== args.expectedFlatCount
	) {
		return reject(
			"TRUST_PROTOCOL",
			`expectedFlatCount mismatch: expected ${args.expectedFlatCount}, found ${flatCount}`,
		);
	}
	if (
		args.expectedPairCount !== undefined &&
		pairCount !== args.expectedPairCount
	) {
		return reject(
			"TRUST_PROTOCOL",
			`expectedPairCount mismatch: expected ${args.expectedPairCount}, found ${pairCount}`,
		);
	}

	return {
		ok: true,
		passCount,
		failCount,
		refusedCount,
		promotableCount,
		sealedCount,
		flatCount,
		pairCount,
		promotedCells,
		canonicalFanoutComplete,
		integrityOnly,
		attestationsVerified,
	};
}

export const VERIFY_CAMPAIGN_INDEX_USAGE =
	"usage: verify-campaign-index --campaign-root=... --index=... --external-trust-bound-sha256=...\n" +
	"  optional: --mac-public-key=... --rig-public-key=... (both or neither: raw 32-byte\n" +
	"            Ed25519 keys; supplying them verifies each seal's attestation graph)\n" +
	"            --stage-receipt=... (with both keys: recomputes the external trust bound;\n" +
	"            required before any entry can be promotable)\n" +
	"            --integrity-only\n" +
	"            --expect-canonical-fanout-complete\n" +
	"            --expected-{pass,fail,refused,promotable,sealed,flat,pair}-count=<n>\n" +
	"            --expect-cells=<a,b> --expect-arms=<ws,wt> --expect-arm-kinds=<primary>\n" +
	"            --expect-measured-repetitions=<1|5> (all four together: the frozen\n" +
	"            section's registered topology, which every measured seal is proved against)\n";

export type ParseVerifyCampaignIndexArgs =
	| {
			readonly ok: true;
			readonly args: Parameters<typeof verifyCampaignIndex>[0];
	  }
	| { readonly ok: false; readonly message: string };

const COUNT_FLAGS = [
	["expected-pass-count", "expectedPassCount"],
	["expected-fail-count", "expectedFailCount"],
	["expected-refused-count", "expectedRefusedCount"],
	["expected-promotable-count", "expectedPromotableCount"],
	["expected-sealed-count", "expectedSealedCount"],
	["expected-flat-count", "expectedFlatCount"],
	["expected-pair-count", "expectedPairCount"],
] as const;

const TOPOLOGY_FLAGS = [
	"expect-cells",
	"expect-arms",
	"expect-arm-kinds",
	"expect-measured-repetitions",
] as const;

const ARM_KINDS = new Set(["primary", "read-path", "overlay"]);

const KNOWN_FLAGS = new Set<string>([
	"campaign-root",
	"index",
	"external-trust-bound-sha256",
	"mac-public-key",
	"rig-public-key",
	"stage-receipt",
	"integrity-only",
	"expect-canonical-fanout-complete",
	...COUNT_FLAGS.map(([flag]) => flag),
	...TOPOLOGY_FLAGS,
]);

/** A comma list with no blank and no repeated member. */
function parseMemberList(raw: string): readonly string[] | undefined {
	const members = raw.split(",").map((member) => member.trim());
	if (members.length === 0) return undefined;
	if (members.some((member) => member.length === 0)) return undefined;
	if (new Set(members).size !== members.length) return undefined;
	return members;
}

/**
 * The four topology flags are one argument: three of them describe a shape no
 * section registered, so a partial set is a refusal rather than a partial
 * proof.
 */
function parseRegisteredTopology(
	argv: readonly string[],
):
	| { readonly ok: true; readonly topology?: RegisteredCampaignTopology }
	| { readonly ok: false; readonly message: string } {
	const raw = TOPOLOGY_FLAGS.map((flag) => parseFlag(argv, flag));
	if (raw.every((value) => value === undefined)) return { ok: true };
	const missing = TOPOLOGY_FLAGS.filter((_, i) => raw[i] === undefined);
	if (missing.length > 0) {
		return {
			ok: false,
			message: `the registered topology needs all four flags together; missing ${missing
				.map((flag) => `--${flag}`)
				.join(" ")}`,
		};
	}
	const [cellsRaw, armsRaw, armKindsRaw, repetitionsRaw] = raw as [
		string,
		string,
		string,
		string,
	];
	const cells = parseMemberList(cellsRaw);
	if (!cells) {
		return {
			ok: false,
			message: `--expect-cells is not a cell list: ${cellsRaw}`,
		};
	}
	const arms = parseMemberList(armsRaw);
	if (!arms || arms.some((arm) => arm !== "ws" && arm !== "wt")) {
		return {
			ok: false,
			message: `--expect-arms must be ws and/or wt: ${armsRaw}`,
		};
	}
	const armKinds = parseMemberList(armKindsRaw);
	if (!armKinds || armKinds.some((kind) => !ARM_KINDS.has(kind))) {
		return {
			ok: false,
			message: `--expect-arm-kinds must name registered arm kinds: ${armKindsRaw}`,
		};
	}
	if (repetitionsRaw !== "1" && repetitionsRaw !== "5") {
		return {
			ok: false,
			message: `--expect-measured-repetitions is 1 (focused/pilot) or 5 (canonical), got ${repetitionsRaw}`,
		};
	}
	return {
		ok: true,
		topology: {
			cells,
			arms: arms as readonly ("ws" | "wt")[],
			armKinds: armKinds as readonly ("primary" | "read-path" | "overlay")[],
			measuredRepetitions: repetitionsRaw === "5" ? 5 : 1,
		},
	};
}

/**
 * The documented argv contract, separated from IO so a test can execute it.
 *
 * An unknown flag is a refusal, not a silent ignore: a caller that misspells
 * `--expected-flat-count` would otherwise get a green run that asserted
 * nothing, which is the exact failure mode §10's count options exist to close.
 */
export function parseVerifyCampaignIndexArgs(
	argv: readonly string[],
): ParseVerifyCampaignIndexArgs {
	for (const arg of argv) {
		if (!arg.startsWith("--")) {
			return { ok: false, message: `unexpected positional argument ${arg}` };
		}
		const name = arg.slice(2).split("=", 1)[0]!;
		if (!KNOWN_FLAGS.has(name)) {
			return { ok: false, message: `unknown flag --${name}` };
		}
	}
	const campaignRoot = parseFlag(argv, "campaign-root");
	const indexPath = parseFlag(argv, "index");
	const externalTrustBoundSha256 = parseFlag(
		argv,
		"external-trust-bound-sha256",
	);
	if (!campaignRoot || !indexPath || !externalTrustBoundSha256) {
		return { ok: false, message: VERIFY_CAMPAIGN_INDEX_USAGE };
	}
	const counts: Record<string, number> = {};
	for (const [flag, key] of COUNT_FLAGS) {
		const raw = parseFlag(argv, flag);
		if (raw === undefined) continue;
		const value = Number(raw);
		if (!Number.isSafeInteger(value) || value < 0) {
			return {
				ok: false,
				message: `--${flag} must be a nonnegative integer, got ${raw}`,
			};
		}
		counts[key] = value;
	}
	const topology = parseRegisteredTopology(argv);
	if (!topology.ok) return { ok: false, message: topology.message };
	const macPublicKeyPath = parseFlag(argv, "mac-public-key");
	const rigPublicKeyPath = parseFlag(argv, "rig-public-key");
	const stageReceiptPath = parseFlag(argv, "stage-receipt");
	return {
		ok: true,
		args: {
			campaignRoot,
			indexPath,
			externalTrustBoundSha256,
			...(macPublicKeyPath !== undefined ? { macPublicKeyPath } : {}),
			...(rigPublicKeyPath !== undefined ? { rigPublicKeyPath } : {}),
			...(stageReceiptPath !== undefined ? { stageReceiptPath } : {}),
			...(argv.includes("--integrity-only") ? { integrityOnly: true } : {}),
			...(argv.includes("--expect-canonical-fanout-complete")
				? { expectCanonicalFanoutComplete: true }
				: {}),
			...(topology.topology !== undefined
				? { expectedTopology: topology.topology }
				: {}),
			...counts,
		},
	};
}

export async function main(argv: readonly string[]): Promise<number> {
	const parsed = parseVerifyCampaignIndexArgs(argv);
	if (!parsed.ok) {
		process.stderr.write(
			parsed.message.endsWith("\n") ? parsed.message : `${parsed.message}\n`,
		);
		return 2;
	}
	const result = verifyCampaignIndex(parsed.args);
	if (!result.ok) {
		process.stderr.write(`${result.code}: ${result.message}\n`);
		return 3;
	}
	process.stdout.write(
		`VERIFY_CAMPAIGN_INDEX_OK pass=${result.passCount} fail=${result.failCount} ` +
			`refused=${result.refusedCount} promotable=${result.promotableCount} ` +
			`sealed=${result.sealedCount} flats=${result.flatCount} pairs=${result.pairCount} ` +
			`promotedCells=${result.promotedCells.length} ` +
			`canonicalFanoutComplete=${result.canonicalFanoutComplete} ` +
			`integrityOnly=${result.integrityOnly} ` +
			`attestationsVerified=${result.attestationsVerified}\n`,
	);
	return 0;
}

if (import.meta.main) {
	process.exit(await main(process.argv.slice(2)));
}
