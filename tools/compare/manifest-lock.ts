// R1 locked-manifest validation (Task C): the validated manifest is the
// complete official read set. Runs, artifacts, raw descriptors, and cell
// snapshots bind to the lock and campaign identity; warmups and overlays can
// never enter a primary delta. Pure validation: no OS I/O.
import {
	isSafeCount,
	sha256HexOfBytes,
	type ValidationFailure,
} from "./secure-fs.ts";
import {
	armIdentityIssue,
	type ArmTransport,
	assertRankedPairing,
	assertWithinTransportPairing,
} from "./evidence.ts";
import { observationProvenanceIssue } from "./supervisor-protocol.ts";

type Rec = Record<string, unknown>;

function isPlainObject(value: unknown): value is Rec {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

const EMPTY_INPUT_SHA256 =
	"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const ALL_F_SENTINEL = "f".repeat(64);

const RAW_KINDS = [
	"client",
	"server",
	"topology",
	"impairment",
	"cleanup",
] as const;

type PathIssue = "traversal" | "absolute" | null;

function relativePathIssue(path: unknown): PathIssue {
	if (typeof path !== "string" || path.length === 0) return "traversal";
	if (path.startsWith("/") || path.includes("\\")) return "absolute";
	const components = path.split("/");
	for (const component of components) {
		if (component === ".." || component === "." || component === "") {
			return "traversal";
		}
	}
	return null;
}

interface SnapshotContentFailure {
	readonly ok: false;
	readonly code: string;
	readonly evidenceStatus: "FAIL";
	readonly scenarioVerdict: "NO_VERDICT";
}

function postSnapshotRestored(bytes: Uint8Array): boolean {
	try {
		const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Rec;
		if (!isPlainObject(parsed)) return false;
		if (parsed.kind !== "snapshot-post") return false;
		if (parsed.cleanupStatus !== "restored-and-released") return false;
		const restoredQdisc = parsed.restoredQdisc;
		if (typeof restoredQdisc !== "string") return false;
		// A post-cell snapshot recording an impairment qdisc means restoration
		// never happened.
		return !restoredQdisc.includes("netem");
	} catch {
		return false;
	}
}

export function validateLockedManifest(input: unknown):
	| {
			ok: true;
			warmupRunCount: number;
			measuredRunCount: number;
			artifactCount: number;
			rawDescriptorCount: number;
			cellSnapshotBundleCount: number;
	  }
	| ValidationFailure
	| SnapshotContentFailure {
	if (
		!isPlainObject(input) ||
		!isPlainObject(input.lock) ||
		!isPlainObject(input.manifest)
	) {
		return { ok: false, code: "MANIFEST_INVALID" };
	}
	const lock = input.lock;
	const manifest = input.manifest;
	const expectedLockDigest = input.expectedLockDigest;
	if (typeof expectedLockDigest !== "string") {
		return { ok: false, code: "MANIFEST_INVALID" };
	}
	// Binding fields are required, not optional. Guarding each comparison on
	// its own presence means omitting the field skips the binding entirely.
	if (manifest.campaignId !== lock.campaignId) {
		return { ok: false, code: "MANIFEST_CAMPAIGN_MISMATCH" };
	}
	if (manifest.candidate !== lock.candidateId) {
		return { ok: false, code: "MANIFEST_CANDIDATE_MISMATCH" };
	}

	const snapshotBytesByPath = isPlainObject(input.snapshotBytesByPath)
		? input.snapshotBytesByPath
		: {};
	const bundles = Array.isArray(manifest.cellSnapshotBundles)
		? (manifest.cellSnapshotBundles as Rec[])
		: [];
	for (const bundle of bundles) {
		if (!isPlainObject(bundle)) {
			return { ok: false, code: "MANIFEST_SNAPSHOT_MISSING" };
		}
		for (const side of ["preCell", "postCell"] as const) {
			const record = bundle[side] as Rec;
			if (!isPlainObject(record)) {
				return { ok: false, code: "MANIFEST_SNAPSHOT_MISSING" };
			}
			const issue = relativePathIssue(record.relativePath);
			if (issue !== null) {
				return { ok: false, code: "MANIFEST_SNAPSHOT_MISSING" };
			}
			const bytes = snapshotBytesByPath[record.relativePath as string];
			if (!(bytes instanceof Uint8Array)) {
				return { ok: false, code: "MANIFEST_SNAPSHOT_MISSING" };
			}
			if (record.lockDigestSha256 !== expectedLockDigest) {
				return { ok: false, code: "MANIFEST_SNAPSHOT_DIGEST_MISMATCH" };
			}
			if (sha256HexOfBytes(bytes) !== record.sha256) {
				return { ok: false, code: "MANIFEST_SNAPSHOT_DIGEST_MISMATCH" };
			}
			if (side === "postCell" && !postSnapshotRestored(bytes)) {
				return {
					ok: false,
					code: "CELL_POST_SNAPSHOT_RESTORATION_MISMATCH",
					evidenceStatus: "FAIL",
					scenarioVerdict: "NO_VERDICT",
				};
			}
		}
	}

	const runEntries = Array.isArray(manifest.runEntries)
		? (manifest.runEntries as Rec[])
		: [];
	const artifactBytesByPath = isPlainObject(input.artifactBytesByPath)
		? input.artifactBytesByPath
		: {};
	const rawBytesByPath = isPlainObject(input.rawBytesByPath)
		? input.rawBytesByPath
		: {};

	const runIds = new Set<unknown>();
	for (const entry of runEntries) {
		if (!isPlainObject(entry)) {
			return { ok: false, code: "MANIFEST_RUN_MISSING" };
		}
		if (runIds.has(entry.runInstanceId)) {
			return { ok: false, code: "MANIFEST_RUN_DUPLICATE" };
		}
		runIds.add(entry.runInstanceId);
	}
	const rawBindings = lock.rawBindings as Rec;
	const expectedArtifactCount = isPlainObject(rawBindings)
		? rawBindings.artifactCount
		: undefined;
	if (
		!isSafeCount(expectedArtifactCount) ||
		runEntries.length !== expectedArtifactCount
	) {
		return { ok: false, code: "MANIFEST_RUN_MISSING" };
	}
	for (const [index, entry] of runEntries.entries()) {
		if (entry.executionIndex !== index) {
			return { ok: false, code: "MANIFEST_RUN_MISSING" };
		}
	}

	let warmupRunCount = 0;
	let measuredRunCount = 0;
	let rawDescriptorCount = 0;
	for (const entry of runEntries) {
		if (entry.phase === "warmup") warmupRunCount += 1;
		else if (entry.phase === "measured") measuredRunCount += 1;
		if (
			entry.candidateId !== lock.candidateId ||
			entry.campaignId !== lock.campaignId
		) {
			return { ok: false, code: "MANIFEST_CAMPAIGN_MISMATCH" };
		}
		const artifact = entry.artifact as Rec;
		if (!isPlainObject(artifact)) {
			return { ok: false, code: "MANIFEST_ARTIFACT_DIGEST_MISMATCH" };
		}
		const pathIssue = relativePathIssue(artifact.relativePath);
		if (pathIssue === "absolute") {
			return { ok: false, code: "MANIFEST_ARTIFACT_PATH_ABSOLUTE" };
		}
		if (pathIssue === "traversal") {
			return { ok: false, code: "MANIFEST_ARTIFACT_PATH_TRAVERSAL" };
		}
		if (artifact.lockDigestSha256 !== expectedLockDigest) {
			return { ok: false, code: "MANIFEST_ARTIFACT_DIGEST_MISMATCH" };
		}
		const artifactBytes = artifactBytesByPath[artifact.relativePath as string];
		if (
			!(artifactBytes instanceof Uint8Array) ||
			sha256HexOfBytes(artifactBytes) !== artifact.sha256
		) {
			return { ok: false, code: "MANIFEST_ARTIFACT_DIGEST_MISMATCH" };
		}

		const rawDescriptors = entry.rawDescriptors;
		if (!Array.isArray(rawDescriptors)) {
			return { ok: false, code: "MANIFEST_RAW_DESCRIPTOR_MISSING" };
		}
		const presentKinds = new Set(
			rawDescriptors.map((raw) => (isPlainObject(raw) ? raw.kind : null)),
		);
		for (const kind of RAW_KINDS) {
			if (!presentKinds.has(kind)) {
				return { ok: false, code: "MANIFEST_RAW_DESCRIPTOR_MISSING" };
			}
		}
		for (const raw of rawDescriptors as Rec[]) {
			if (raw.sha256 === EMPTY_INPUT_SHA256) {
				return { ok: false, code: "MANIFEST_RAW_EMPTY_DIGEST_FORBIDDEN" };
			}
			if (raw.sha256 === ALL_F_SENTINEL) {
				return { ok: false, code: "MANIFEST_RAW_ALL_F_DIGEST_FORBIDDEN" };
			}
			const rawIssue = relativePathIssue(raw.relativePath);
			if (rawIssue !== null) {
				return { ok: false, code: "MANIFEST_RAW_DESCRIPTOR_MISSING" };
			}
			if (raw.lockDigestSha256 !== expectedLockDigest) {
				return { ok: false, code: "MANIFEST_RAW_DIGEST_MISMATCH" };
			}
			const rawBytes = rawBytesByPath[raw.relativePath as string];
			if (
				!(rawBytes instanceof Uint8Array) ||
				sha256HexOfBytes(rawBytes) !== raw.sha256
			) {
				return { ok: false, code: "MANIFEST_RAW_DIGEST_MISMATCH" };
			}
			rawDescriptorCount += 1;
		}
	}

	// Nothing above can succeed vacuously: the `[]` defaults keep the
	// individual loops from throwing on a partial input, but a manifest that
	// declared no runs or no snapshots validated nothing and cannot be the
	// complete official read set it claims to be.
	if (runEntries.length === 0) {
		return { ok: false, code: "MANIFEST_RUN_MISSING" };
	}
	if (bundles.length === 0) {
		return { ok: false, code: "MANIFEST_SNAPSHOT_MISSING" };
	}

	return {
		ok: true,
		warmupRunCount,
		measuredRunCount,
		artifactCount: runEntries.length,
		rawDescriptorCount,
		cellSnapshotBundleCount: bundles.length,
	};
}

// ---------------------------------------------------------------------------
// Primary delta set
// ---------------------------------------------------------------------------

interface DeltaFailure {
	readonly ok: false;
	readonly code: string;
	readonly deltaCount: 0;
	readonly rankingCount: 0;
	readonly numericDelta: "not-computed";
}

function deltaFailure(code: string): DeltaFailure {
	return {
		ok: false,
		code,
		deltaCount: 0,
		rankingCount: 0,
		numericDelta: "not-computed",
	};
}

export function buildPrimaryDeltaSet(input: unknown):
	| {
			ok: true;
			deltaCount: number;
			rankingCount: number;
			excludedOverlayCount: number;
			excludedWarmupCount: number;
			requiresRawHashEquality: false;
			deltaCells: readonly string[];
	  }
	| DeltaFailure {
	if (
		!isPlainObject(input) ||
		!isPlainObject(input.manifest) ||
		!isPlainObject(input.verifiedArtifactsByRunInstanceId)
	) {
		return deltaFailure("DELTA_INPUT_INVALID");
	}
	const manifest = input.manifest;
	const verified = input.verifiedArtifactsByRunInstanceId;
	const expectedLockDigest = input.expectedLockDigest;
	const runEntries = Array.isArray(manifest.runEntries)
		? (manifest.runEntries as Rec[])
		: [];
	if (runEntries.length === 0) {
		return deltaFailure("DELTA_INPUT_INVALID");
	}

	let excludedWarmupCount = 0;
	const overlayArmIds = new Set<unknown>();
	const measuredPrimaryCells = new Map<string, { ws: number; wt: number }>();
	for (const entry of runEntries) {
		const artifact = verified[entry.runInstanceId as string];
		if (!isPlainObject(artifact)) {
			return deltaFailure("DELTA_WT_OR_WS_ARTIFACT_MISSING");
		}
		// Artifacts arrive as JSON, so a self-contradicting arm identity is
		// representable until something reads it.  The lock is the second place
		// that reads it, and the one that decides which set an entry enters.
		if (
			armIdentityIssue({
				transport: entry.transport,
				armId: entry.armId,
				armTransport: entry.armTransport,
				armKind: entry.armKind,
			}) !== null
		) {
			return deltaFailure("ARM_IDENTITY_INCONSISTENT");
		}
		if (entry.phase === "warmup") excludedWarmupCount += 1;
		// Read-path is not overlay: this set stays overlay-only.
		if (entry.armKind === "overlay") overlayArmIds.add(entry.armId);
		// The headline ws-vs-wt delta is a main-loop comparison. Read-path arms
		// are counted in the cardinality but stay out of these 35, so no
		// consumption-strategy change can perturb the headline number.
		const isMeasuredPrimary =
			entry.phase === "measured" && entry.armKind === "primary";
		if (!isMeasuredPrimary) continue;
		const sharedIdentity = artifact.sharedIdentity as Rec;
		if (
			!isPlainObject(sharedIdentity) ||
			sharedIdentity.lockDigestSha256 !== expectedLockDigest
		) {
			return deltaFailure("DELTA_SHARED_IDENTITY_MISMATCH");
		}
		if (
			artifact.evidenceStatus !== "PASS" ||
			(artifact.scenarioVerdict !== "PASS" &&
				artifact.scenarioVerdict !== "MISS")
		) {
			return deltaFailure("DELTA_EVIDENCE_NOT_COMPARABLE");
		}
		const cellId = String(entry.cellId);
		const counts = measuredPrimaryCells.get(cellId) ?? { ws: 0, wt: 0 };
		if (entry.transport === "ws") counts.ws += 1;
		else if (entry.transport === "wt") counts.wt += 1;
		measuredPrimaryCells.set(cellId, counts);
	}
	for (const [, counts] of measuredPrimaryCells) {
		if (counts.ws === 0 || counts.wt === 0) {
			return deltaFailure("DELTA_WT_OR_WS_ARTIFACT_MISSING");
		}
	}
	const deltaCells = [...measuredPrimaryCells.keys()].sort();
	return {
		ok: true,
		deltaCount: deltaCells.length,
		rankingCount: deltaCells.length,
		excludedOverlayCount: overlayArmIds.size,
		excludedWarmupCount,
		requiresRawHashEquality: false,
		deltaCells,
	};
}

/**
 * The measured, non-overlay entries of one manifest, grouped by cell and keyed
 * by the arm each entry declares.  Every set builder below starts here so that
 * none of them re-derives eligibility, exclusion or identity for itself.
 */
function measuredArmsByCell(
	manifest: Rec,
	verified: Rec,
	expectedLockDigest: unknown,
): Map<string, Map<ArmTransport, number>> | DeltaFailure {
	const runEntries = Array.isArray(manifest.runEntries)
		? (manifest.runEntries as Rec[])
		: [];
	if (runEntries.length === 0) return deltaFailure("DELTA_INPUT_INVALID");
	const byCell = new Map<string, Map<ArmTransport, number>>();
	for (const entry of runEntries) {
		const artifact = verified[entry.runInstanceId as string];
		if (!isPlainObject(artifact)) {
			return deltaFailure("DELTA_WT_OR_WS_ARTIFACT_MISSING");
		}
		if (entry.phase !== "measured" || entry.armKind === "overlay") continue;
		if (
			armIdentityIssue({
				transport: entry.transport,
				armId: entry.armId,
				armTransport: entry.armTransport,
				armKind: entry.armKind,
			}) !== null
		) {
			return deltaFailure("ARM_IDENTITY_INCONSISTENT");
		}
		const sharedIdentity = artifact.sharedIdentity as Rec;
		if (
			!isPlainObject(sharedIdentity) ||
			sharedIdentity.lockDigestSha256 !== expectedLockDigest
		) {
			return deltaFailure("DELTA_SHARED_IDENTITY_MISMATCH");
		}
		if (
			artifact.evidenceStatus !== "PASS" ||
			(artifact.scenarioVerdict !== "PASS" &&
				artifact.scenarioVerdict !== "MISS")
		) {
			return deltaFailure("DELTA_EVIDENCE_NOT_COMPARABLE");
		}
		const cellId = String(entry.cellId);
		const arms = byCell.get(cellId) ?? new Map<ArmTransport, number>();
		const arm = entry.armTransport as ArmTransport;
		arms.set(arm, (arms.get(arm) ?? 0) + 1);
		byCell.set(cellId, arms);
	}
	return byCell;
}

function isDeltaFailure(
	value: Map<string, Map<ArmTransport, number>> | DeltaFailure,
): value is DeltaFailure {
	return !(value instanceof Map);
}

/**
 * The off-loop tier's own ws-vs-wt delta.  It is a *ranked* set — a read-path
 * arm is first-class evidence — but it ranks `ws-worker` against
 * `wt-stream-sink` and never against a main-loop arm, because the two tiers
 * answer different questions and a cross-tier ranking would silently publish
 * the consumption strategy as a transport result.  The pairing is checked by
 * `evidence.ts`'s token assertion rather than re-spelled here.
 */
export function buildOffLoopDeltaSet(input: unknown):
	| {
			ok: true;
			deltaCount: number;
			rankingCount: number;
			deltaCells: readonly string[];
	  }
	| DeltaFailure {
	if (
		!isPlainObject(input) ||
		!isPlainObject(input.manifest) ||
		!isPlainObject(input.verifiedArtifactsByRunInstanceId)
	) {
		return deltaFailure("DELTA_INPUT_INVALID");
	}
	const byCell = measuredArmsByCell(
		input.manifest,
		input.verifiedArtifactsByRunInstanceId,
		input.expectedLockDigest,
	);
	if (isDeltaFailure(byCell)) return byCell;
	const deltaCells: string[] = [];
	for (const [cellId, arms] of byCell) {
		const worker = arms.get("ws-worker") ?? 0;
		const sink = arms.get("wt-stream-sink") ?? 0;
		if (worker === 0 && sink === 0) continue;
		if (worker === 0 || sink === 0) {
			return deltaFailure(
				worker === 0
					? "WS_WORKER_ARM_NOT_MEASURED"
					: "WT_STREAM_SINK_ARM_NOT_MEASURED",
			);
		}
		try {
			assertRankedPairing("ws-worker", "wt-stream-sink");
		} catch {
			return deltaFailure("RANKING_TIER_VIOLATION");
		}
		deltaCells.push(cellId);
	}
	deltaCells.sort();
	return {
		ok: true,
		deltaCount: deltaCells.length,
		rankingCount: deltaCells.length,
		deltaCells,
	};
}

/**
 * The within-transport reports: `ws` against `ws-worker`, `wt` against
 * `wt-stream-sink`.  These pair the two tiers of a single wire, which is a
 * consumption-strategy question and not a transport one, so the set is
 * **reported and never ranked** — it carries no ranking count at all, which is
 * the structural reason a within-transport pair cannot become a ranking.
 */
export function buildWithinTransportSet(input: unknown):
	| {
			ok: true;
			pairCount: number;
			pairs: ReadonlyArray<{
				readonly cellId: string;
				readonly mainLoop: ArmTransport;
				readonly offLoop: ArmTransport;
			}>;
	  }
	| DeltaFailure {
	if (
		!isPlainObject(input) ||
		!isPlainObject(input.manifest) ||
		!isPlainObject(input.verifiedArtifactsByRunInstanceId)
	) {
		return deltaFailure("DELTA_INPUT_INVALID");
	}
	const byCell = measuredArmsByCell(
		input.manifest,
		input.verifiedArtifactsByRunInstanceId,
		input.expectedLockDigest,
	);
	if (isDeltaFailure(byCell)) return byCell;
	const pairs: Array<{
		cellId: string;
		mainLoop: ArmTransport;
		offLoop: ArmTransport;
	}> = [];
	for (const cellId of [...byCell.keys()].sort()) {
		const arms = byCell.get(cellId);
		if (!arms) continue;
		for (const [mainLoop, offLoop] of [
			["ws", "ws-worker"],
			["wt", "wt-stream-sink"],
		] as const) {
			if ((arms.get(offLoop) ?? 0) === 0) continue;
			if ((arms.get(mainLoop) ?? 0) === 0) {
				return deltaFailure(
					mainLoop === "ws" ? "WS_ARM_NOT_MEASURED" : "WT_ARM_NOT_MEASURED",
				);
			}
			try {
				assertWithinTransportPairing(mainLoop, offLoop);
			} catch (error) {
				return deltaFailure(
					error instanceof Error && "code" in error
						? String((error as { code: unknown }).code)
						: "WITHIN_PAIR_WIRE_MISMATCH",
				);
			}
			pairs.push({ cellId, mainLoop, offLoop });
		}
	}
	return { ok: true, pairCount: pairs.length, pairs };
}

// ---------------------------------------------------------------------------
// Manifest descriptor publication set
// ---------------------------------------------------------------------------

const DESCRIPTOR_RUN_CYCLE = [
	"artifact",
	"raw-client",
	"raw-server",
	"raw-topology",
	"raw-impairment",
	"raw-cleanup",
] as const;

export function validateManifestDescriptorSet(input: unknown):
	| {
			ok: true;
			descriptorCount: number;
			rawDescriptorCount: number;
			snapshotDescriptorCount: number;
	  }
	| ValidationFailure {
	if (
		!isPlainObject(input) ||
		!isPlainObject(input.manifest) ||
		!Array.isArray(input.descriptors)
	) {
		return { ok: false, code: "MANIFEST_DESCRIPTOR_COUNT_INVALID" };
	}
	const manifest = input.manifest;
	const descriptors = input.descriptors as Rec[];
	const expectedDescriptorCount = input.expectedDescriptorCount;
	if (
		typeof expectedDescriptorCount !== "number" ||
		descriptors.length !== expectedDescriptorCount
	) {
		return { ok: false, code: "MANIFEST_DESCRIPTOR_COUNT_INVALID" };
	}
	const reservedOutputs = new Set(
		Array.isArray(input.reservedOutputs)
			? input.reservedOutputs.map((name) => String(name))
			: [],
	);

	const runEntries = Array.isArray(manifest.runEntries)
		? (manifest.runEntries as Rec[])
		: [];
	const bundles = Array.isArray(manifest.cellSnapshotBundles)
		? (manifest.cellSnapshotBundles as Rec[])
		: [];

	// Cardinality of the run set itself: overlays and warmups are part of the
	// declared execution plan and cannot be trimmed away.
	let warmupCount = 0;
	const overlayArmIds = new Set<unknown>();
	for (const entry of runEntries) {
		if (entry.phase === "warmup") warmupCount += 1;
		// Overlay-only, deliberately: read-path arms are their own evidence and
		// are not shadow entries that a trimmed plan could hide behind.
		if (entry.armKind === "overlay") overlayArmIds.add(entry.armId);
	}
	if (
		runEntries.length > 0 &&
		(warmupCount === 0 || overlayArmIds.size === 0)
	) {
		return {
			ok: false,
			code: "MANIFEST_OVERLAY_OR_WARMUP_CARDINALITY_INVALID",
		};
	}

	const digestByPath = new Map<string, unknown>();
	for (const entry of runEntries) {
		const artifact = entry.artifact as Rec;
		if (isPlainObject(artifact)) {
			digestByPath.set(String(artifact.relativePath), artifact.sha256);
		}
		const rawDescriptors = Array.isArray(entry.rawDescriptors)
			? (entry.rawDescriptors as Rec[])
			: [];
		for (const raw of rawDescriptors) {
			digestByPath.set(String(raw.relativePath), raw.sha256);
		}
	}
	for (const bundle of bundles) {
		for (const side of ["preCell", "postCell"] as const) {
			const record = bundle[side] as Rec;
			if (isPlainObject(record)) {
				digestByPath.set(String(record.relativePath), record.sha256);
			}
		}
	}

	let rawDescriptorCount = 0;
	let snapshotDescriptorCount = 0;
	const runCount = runEntries.length;
	for (const [index, descriptor] of descriptors.entries()) {
		if (!isPlainObject(descriptor)) {
			return { ok: false, code: "MANIFEST_DESCRIPTOR_ORDER_INVALID" };
		}
		const relativePath = descriptor.relativePath;
		if (typeof relativePath === "string") {
			const basename = relativePath.split("/").at(-1) ?? "";
			if (reservedOutputs.has(basename)) {
				return { ok: false, code: "MANIFEST_RESERVED_OUTPUT_SELECTED" };
			}
		}
		if (relativePathIssue(relativePath) !== null) {
			return { ok: false, code: "MANIFEST_PATH_COMPONENT_INVALID" };
		}
		const kind = descriptor.kind;
		let expectedKind: string;
		if (index < runCount * DESCRIPTOR_RUN_CYCLE.length) {
			expectedKind = DESCRIPTOR_RUN_CYCLE[index % DESCRIPTOR_RUN_CYCLE.length]!;
		} else if (index < descriptors.length - 1) {
			const snapshotIndex = index - runCount * DESCRIPTOR_RUN_CYCLE.length;
			expectedKind = snapshotIndex % 2 === 0 ? "snapshot-pre" : "snapshot-post";
		} else {
			expectedKind = "attestation";
		}
		if (kind !== expectedKind) {
			return { ok: false, code: "MANIFEST_DESCRIPTOR_ORDER_INVALID" };
		}
		if (typeof kind === "string" && kind.startsWith("raw-")) {
			rawDescriptorCount += 1;
		}
		if (kind === "snapshot-pre" || kind === "snapshot-post") {
			snapshotDescriptorCount += 1;
		}
		if (kind !== "attestation") {
			const expectedDigest = digestByPath.get(String(relativePath));
			if (
				expectedDigest !== undefined &&
				expectedDigest !== descriptor.sha256
			) {
				return { ok: false, code: "MANIFEST_DESCRIPTOR_DIGEST_MISMATCH" };
			}
		}
	}

	// The recomputation is only authority if it is bound to one.  Comparing it
	// against a caller-supplied constant proves the caller can count, not that
	// the campaign published what it locked.
	const cardinality = isPlainObject(input.lock)
		? input.lock.cardinality
		: undefined;
	if (!isPlainObject(cardinality)) {
		return { ok: false, code: "MANIFEST_CARDINALITY_MISMATCH" };
	}
	if (
		cardinality.descriptorCount !== descriptors.length ||
		cardinality.rawDescriptorCount !== rawDescriptorCount ||
		cardinality.snapshotDescriptorCount !== snapshotDescriptorCount
	) {
		return { ok: false, code: "MANIFEST_CARDINALITY_MISMATCH" };
	}

	return {
		ok: true,
		descriptorCount: descriptors.length,
		rawDescriptorCount,
		snapshotDescriptorCount,
	};
}

// ---------------------------------------------------------------------------
// Observed facts against the manifest
// ---------------------------------------------------------------------------

export function validateManifestObservedFacts(input: unknown):
	| {
			ok: true;
			measuredPrimaryCount: number;
			warmupExcluded: number;
			overlaysExcluded: number;
	  }
	| ValidationFailure {
	if (
		!isPlainObject(input) ||
		!isPlainObject(input.manifest) ||
		!isPlainObject(input.observedAttestation)
	) {
		return { ok: false, code: "ATTESTATION_OBSERVED_RUN_FACTS_MISSING" };
	}
	const manifest = input.manifest;
	const observed = input.observedAttestation;

	// An observation that declares a provenance must declare the
	// supervisor's own. Comparing observed digests against the planned ones
	// proves nothing on its own: the plan is exactly what an echo would
	// return.
	if (
		observed.provenance !== undefined &&
		observationProvenanceIssue(observed) !== null
	) {
		return { ok: false, code: "ATTESTATION_PLANNED_VALUE_ALIAS_FORBIDDEN" };
	}
	// The observed snapshot list must be structurally distinct from the
	// manifest's own — see the echo guard below.  It used to be the same array
	// object, which made every digest comparison a comparison against itself.

	const observedRunFacts = observed.observedRunFacts;
	if (!Array.isArray(observedRunFacts) || observedRunFacts.length === 0) {
		return { ok: false, code: "ATTESTATION_OBSERVED_RUN_FACTS_MISSING" };
	}
	for (const fact of observedRunFacts as Rec[]) {
		if (!isPlainObject(fact)) {
			return { ok: false, code: "ATTESTATION_OBSERVED_RUN_FACTS_MISSING" };
		}
		if (fact.routePath !== "direct-cable") {
			return { ok: false, code: "ATTESTATION_ROUTE_OR_PEER_MISMATCH" };
		}
		if (
			!isSafeCount(fact.dedicatedPgidObserved) ||
			fact.dedicatedPgidObserved <= 0 ||
			fact.restored !== true ||
			fact.cleanupStatus !== "restored-and-released"
		) {
			return { ok: false, code: "ATTESTATION_SUPERVISOR_FACTS_MISMATCH" };
		}
	}

	const runEntries = Array.isArray(manifest.runEntries)
		? (manifest.runEntries as Rec[])
		: [];
	let warmupExcluded = 0;
	let measuredPrimaryCellCount = 0;
	const overlayArmIds = new Set<unknown>();
	const measuredPrimaryCellIds = new Set<unknown>();
	for (const entry of runEntries) {
		// The predicate must say what the error code says — *warmup or overlay* —
		// not "not primary". A measured read-path arm is first-class: it may not
		// opt out of the delta, and reading the old `armKind !== "primary"` here
		// rejected every read-path execution outright.
		const excluded = entry.phase !== "measured" || entry.armKind === "overlay";
		if (
			excluded &&
			(entry.excludeFromDelta !== true || entry.excludeFromRanking !== true)
		) {
			return { ok: false, code: "MANIFEST_WARMUP_OR_OVERLAY_INCLUDED" };
		}
		// The converse, which the old predicate had no way to state: a measured
		// non-overlay arm is first-class and may not opt itself out. Without
		// this, a read-path arm could be published and then quietly excluded.
		if (
			!excluded &&
			(entry.excludeFromDelta !== false || entry.excludeFromRanking !== false)
		) {
			return { ok: false, code: "MANIFEST_MEASURED_ARM_SELF_EXCLUDED" };
		}
		if (entry.phase === "warmup") warmupExcluded += 1;
		// Overlay-only: read-path is not overlay.
		if (entry.armKind === "overlay") overlayArmIds.add(entry.armId);
		// The 35-cell primary delta, unchanged by the second tier.
		if (entry.phase === "measured" && entry.armKind === "primary") {
			measuredPrimaryCellIds.add(entry.cellId);
		}
	}
	measuredPrimaryCellCount = measuredPrimaryCellIds.size;

	const observedCellSnapshots = observed.observedCellSnapshots;
	const bundles = Array.isArray(manifest.cellSnapshotBundles)
		? (manifest.cellSnapshotBundles as Rec[])
		: [];
	if (
		!Array.isArray(observedCellSnapshots) ||
		observedCellSnapshots.length !== bundles.length ||
		observedCellSnapshots.length === 0
	) {
		return { ok: false, code: "ATTESTATION_CELL_SNAPSHOT_MISMATCH" };
	}
	// An observation that IS the manifest is not an observation.  Comparing a
	// thing against itself cannot fail, so the identity check has to come
	// before the digest comparison rather than instead of it.
	if (
		(observedCellSnapshots as unknown) ===
		(manifest.cellSnapshotBundles as unknown)
	) {
		return { ok: false, code: "ATTESTATION_CELL_SNAPSHOT_ECHOED" };
	}
	for (const [index, bundle] of bundles.entries()) {
		const observedBundle = observedCellSnapshots[index] as Rec;
		if (
			!isPlainObject(observedBundle) ||
			observedBundle.cellId !== bundle.cellId
		) {
			return { ok: false, code: "ATTESTATION_CELL_SNAPSHOT_MISMATCH" };
		}
		if ((observedBundle as unknown) === (bundle as unknown)) {
			return { ok: false, code: "ATTESTATION_CELL_SNAPSHOT_ECHOED" };
		}
		for (const side of ["preCell", "postCell"] as const) {
			const observedRecord = observedBundle[side] as Rec;
			const manifestRecord = bundle[side] as Rec;
			if (
				!isPlainObject(observedRecord) ||
				!isPlainObject(manifestRecord) ||
				observedRecord.sha256 !== manifestRecord.sha256
			) {
				return { ok: false, code: "ATTESTATION_CELL_SNAPSHOT_MISMATCH" };
			}
		}
	}

	return {
		ok: true,
		measuredPrimaryCount: measuredPrimaryCellCount,
		warmupExcluded,
		overlaysExcluded: overlayArmIds.size,
	};
}
