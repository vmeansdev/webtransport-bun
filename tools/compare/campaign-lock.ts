// R1 campaign-lock strict canonical parsing and intrinsic/attestation
// validation (Task C). Pure record validation: no OS I/O, no addon import.
import { canonicalJson } from "./canonical.ts";
import {
	canonicalRecordBytes,
	findDuplicateJsonKey,
	hasOwn,
	isImplausibleDigest,
	isSafeCount,
	looksByteCorrupted,
	sha256HexOfBytes,
	type ValidationFailure,
} from "./secure-fs.ts";
import { observationProvenanceIssue } from "./supervisor-protocol.ts";

const LOCK_REQUIRED_FIELDS = [
	"lockVersion",
	"candidateId",
	"campaignId",
	"source",
	"submissions",
	"topology",
	"hosts",
	"tls",
	"resourceContract",
	"supervisorPolicy",
	"executionPlan",
] as const;

const LOCK_OPTIONAL_FIELDS = ["rawBindings"] as const;

type Rec = Record<string, unknown>;

function isPlainObject(value: unknown): value is Rec {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function lockSchemaIssue(lock: Rec): "unknown" | "missing" | null {
	const allowed = new Set<string>([
		...LOCK_REQUIRED_FIELDS,
		...LOCK_OPTIONAL_FIELDS,
	]);
	for (const key of Object.keys(lock)) {
		if (!allowed.has(key)) return "unknown";
	}
	for (const key of LOCK_REQUIRED_FIELDS) {
		if (!hasOwn(lock, key)) return "missing";
	}
	return null;
}

/**
 * The lock's rawBindings block and the topology route/peer blocks are fully
 * derived from the execution plan and topology scalars; the canonical digest
 * treats omitted derived blocks as their derived values so key-order (and
 * derived-block) reorderings cannot change the digest.
 */
function withDerivedLockBlocks(lock: Rec): Rec {
	let completed = lock;
	if (!("rawBindings" in completed)) {
		const plan = completed.executionPlan;
		if (isPlainObject(plan)) {
			const totalRuns = plan.totalRuns;
			const sequences = plan.cellPhaseSequences;
			if (isSafeCount(totalRuns) && Array.isArray(sequences)) {
				completed = {
					...completed,
					rawBindings: {
						artifactCount: totalRuns,
						rawDescriptorCount: totalRuns * 5,
						cellSnapshotBundleCount: sequences.length / 2,
					},
				};
			}
		}
	}
	const topology = completed.topology;
	if (
		isPlainObject(topology) &&
		(!("requiredRoutes" in topology) ||
			!("expectedPeerRelationship" in topology))
	) {
		const derivedTopology: Rec = { ...topology };
		if (!("requiredRoutes" in derivedTopology)) {
			derivedTopology.requiredRoutes = {
				mac: {
					destination: `${String(topology.linuxAddress)}/32`,
					interface: topology.macInterface,
					gateway: null,
					path: topology.kind,
				},
				linux: {
					destination: `${String(topology.macAddress)}/32`,
					interface: topology.linuxInterface,
					gateway: null,
					path: topology.kind,
				},
			};
		}
		if (!("expectedPeerRelationship" in derivedTopology)) {
			derivedTopology.expectedPeerRelationship = {
				macPeerHostId: topology.linuxHostId,
				linuxPeerHostId: topology.macHostId,
			};
		}
		completed = { ...completed, topology: derivedTopology };
	}
	return completed;
}

// Attacker-shaped input drives this walk, so the depth is bounded rather
// than left to blow the stack with an uncatchable RangeError. No honest lock
// nests anywhere near this deep.
const MAX_FREEZE_DEPTH = 64;

function deepFreeze<T>(value: T, depth = 0): T {
	if (depth > MAX_FREEZE_DEPTH) return value;
	if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const key of Object.getOwnPropertyNames(value)) {
			deepFreeze((value as Rec)[key], depth + 1);
		}
	}
	return value;
}

export function canonicalCampaignLockDigestSha256(
	input: unknown,
):
	| { ok: true; lockDigestSha256: string; lockBytes: Uint8Array }
	| ValidationFailure {
	if (!isPlainObject(input) || !isPlainObject(input.lock)) {
		return { ok: false, code: "CAMPAIGN_LOCK_JSON_INVALID" };
	}
	const issue = lockSchemaIssue(input.lock);
	if (issue === "unknown") {
		return { ok: false, code: "CAMPAIGN_LOCK_UNKNOWN_FIELD" };
	}
	if (issue === "missing") {
		return { ok: false, code: "CAMPAIGN_LOCK_MISSING_FIELD" };
	}
	const completed = withDerivedLockBlocks(input.lock);
	const lockBytes = canonicalRecordBytes(completed);
	const lockDigestSha256 = sha256HexOfBytes(lockBytes);
	if (expectedDigestMismatch(input.expectedLockDigest, lockDigestSha256)) {
		return { ok: false, code: "CAMPAIGN_LOCK_DIGEST_MISMATCH" };
	}
	return { ok: true, lockDigestSha256, lockBytes };
}

export function parseCampaignLockBytes(input: unknown):
	| {
			ok: true;
			frozen: true;
			lock: Rec;
			lockBytes: Uint8Array;
			resealedBytes: Uint8Array;
	  }
	| ValidationFailure {
	if (!isPlainObject(input) || !(input.lockBytes instanceof Uint8Array)) {
		return { ok: false, code: "CAMPAIGN_LOCK_JSON_INVALID" };
	}
	const lockBytes = input.lockBytes;
	const text = new TextDecoder().decode(lockBytes);
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		// Byte-level corruption (control bytes canonical JSON never contains)
		// is a digest failure of otherwise-sealed bytes, not a structural one.
		if (looksByteCorrupted(lockBytes)) {
			return { ok: false, code: "CAMPAIGN_LOCK_DIGEST_MISMATCH" };
		}
		return { ok: false, code: "CAMPAIGN_LOCK_JSON_INVALID" };
	}
	if (findDuplicateJsonKey(text) !== null) {
		return { ok: false, code: "CAMPAIGN_LOCK_DUPLICATE_KEY" };
	}
	if (!isPlainObject(parsed)) {
		return { ok: false, code: "CAMPAIGN_LOCK_JSON_INVALID" };
	}
	const issue = lockSchemaIssue(parsed);
	if (issue === "unknown") {
		return { ok: false, code: "CAMPAIGN_LOCK_UNKNOWN_FIELD" };
	}
	if (issue === "missing") {
		return { ok: false, code: "CAMPAIGN_LOCK_MISSING_FIELD" };
	}
	const resealedBytes = canonicalRecordBytes(withDerivedLockBlocks(parsed));
	const digest = sha256HexOfBytes(lockBytes);
	if (expectedDigestMismatch(input.expectedLockDigest, digest)) {
		return { ok: false, code: "CAMPAIGN_LOCK_DIGEST_MISMATCH" };
	}
	if (sha256HexOfBytes(resealedBytes) !== digest) {
		return { ok: false, code: "CAMPAIGN_LOCK_DIGEST_MISMATCH" };
	}
	return {
		ok: true,
		frozen: true,
		lock: deepFreeze(parsed),
		lockBytes,
		resealedBytes,
	};
}

// ---------------------------------------------------------------------------
// Intrinsic lock validation
// ---------------------------------------------------------------------------

/**
 * A declared expected digest must be present and must match. Gating the
 * comparison on `typeof === "string"` makes an omitted digest a skipped
 * check rather than a rejection.
 */
function expectedDigestMismatch(expected: unknown, actual: string): boolean {
	return expected !== actual;
}

function isLoopback(address: unknown): boolean {
	if (typeof address !== "string") return false;
	return (
		address === "::1" ||
		address === "localhost" ||
		address.startsWith("127.") ||
		address.startsWith("::ffff:127.")
	);
}

export function validateIntrinsicCampaignLock(
	input: unknown,
): { ok: true } | ValidationFailure {
	if (!isPlainObject(input) || !isPlainObject(input.lock)) {
		return { ok: false, code: "CAMPAIGN_LOCK_JSON_INVALID" };
	}
	const lock = input.lock;
	const source = lock.source as Rec;
	const topology = lock.topology as Rec;
	const hosts = lock.hosts as Rec;
	const tls = lock.tls as Rec;
	const resources = lock.resourceContract as Rec;
	const policy = lock.supervisorPolicy as Rec;
	if (
		!isPlainObject(source) ||
		!isPlainObject(topology) ||
		!isPlainObject(hosts) ||
		!isPlainObject(tls) ||
		!isPlainObject(resources) ||
		!isPlainObject(policy)
	) {
		return { ok: false, code: "CAMPAIGN_LOCK_MISSING_FIELD" };
	}
	const mac = hosts.mac as Rec;
	const linux = hosts.linux as Rec;
	if (!isPlainObject(mac) || !isPlainObject(linux)) {
		return { ok: false, code: "CAMPAIGN_LOCK_MISSING_FIELD" };
	}

	if (source.reviewedTreeState !== "clean") {
		return { ok: false, code: "LOCK_SOURCE_TREE_NOT_CLEAN" };
	}
	if (isLoopback(mac.address) || isLoopback(topology.macAddress)) {
		return { ok: false, code: "LOCK_LOOPBACK_ADDRESS_FORBIDDEN" };
	}
	if (isLoopback(linux.address) || isLoopback(topology.linuxAddress)) {
		return { ok: false, code: "LOCK_LOOPBACK_ADDRESS_FORBIDDEN" };
	}
	if (
		mac.hostId === linux.hostId ||
		topology.macHostId === topology.linuxHostId
	) {
		return { ok: false, code: "LOCK_HOST_IDS_MUST_DIFFER" };
	}
	if (topology.kind !== "direct-cable") {
		return { ok: false, code: "LOCK_TOPOLOGY_KIND_INVALID" };
	}
	const macRoute = mac.route as Rec;
	if (
		mac.interface !== topology.macInterface ||
		(isPlainObject(macRoute) && macRoute.interface !== mac.interface)
	) {
		return { ok: false, code: "LOCK_MAC_INTERFACE_INVALID" };
	}
	const linuxRoute = linux.route as Rec;
	if (
		linux.interface !== topology.linuxInterface ||
		(isPlainObject(linuxRoute) && linuxRoute.interface !== linux.interface)
	) {
		return { ok: false, code: "LOCK_LINUX_INTERFACE_INVALID" };
	}
	if (mac.address !== topology.macAddress) {
		return { ok: false, code: "LOCK_MAC_ADDRESS_INVALID" };
	}
	if (linux.address !== topology.linuxAddress) {
		return { ok: false, code: "LOCK_LINUX_ADDRESS_INVALID" };
	}
	if (
		typeof mac.mtu !== "number" ||
		typeof linux.mtu !== "number" ||
		mac.mtu !== linux.mtu
	) {
		return { ok: false, code: "LOCK_MTU_INVALID" };
	}
	if (tls.rejectUnauthorized !== true) {
		return { ok: false, code: "LOCK_TLS_REJECT_UNAUTHORIZED_REQUIRED" };
	}
	if (tls.compression !== "off") {
		return { ok: false, code: "LOCK_TLS_COMPRESSION_FORBIDDEN" };
	}
	for (const host of ["mac", "linux"] as const) {
		const contract = resources[host] as Rec;
		if (!isPlainObject(contract)) {
			return { ok: false, code: "LOCK_RESOURCE_FD_POLICY_INVALID" };
		}
		// The 588-run campaign requires the guaranteed child descriptor budget
		// the runtime-facts schema pins (nofile 65536 on both hosts).
		if (!isSafeCount(contract.fdSoftLimit) || contract.fdSoftLimit < 65536) {
			return { ok: false, code: "LOCK_RESOURCE_FD_POLICY_INVALID" };
		}
		const range = contract.ephemeralPortRange;
		if (
			!Array.isArray(range) ||
			range.length !== 2 ||
			!isSafeCount(range[0]) ||
			!isSafeCount(range[1]) ||
			range[0] <= 0 ||
			range[1] > 65535 ||
			range[1] - range[0] + 1 < 588
		) {
			return { ok: false, code: "LOCK_RESOURCE_PORT_POLICY_INVALID" };
		}
	}
	if (
		policy.dedicatedProcessGroupRequired !== true ||
		typeof policy.flockPath !== "string" ||
		policy.flockPath.length === 0 ||
		typeof policy.leasePath !== "string" ||
		policy.leasePath.length === 0 ||
		!isSafeCount(policy.leaseMs) ||
		policy.leaseMs <= 0
	) {
		return { ok: false, code: "LOCK_SUPERVISOR_POLICY_INVALID" };
	}
	return { ok: true };
}

// ---------------------------------------------------------------------------
// Attestation validation (distinct planned vs observed structures)
// ---------------------------------------------------------------------------

function deepEqualJson(left: unknown, right: unknown): boolean {
	try {
		return canonicalJson(left) === canonicalJson(right);
	} catch {
		return false;
	}
}

interface SubmissionCheck {
	readonly key: string;
	readonly plannedDigest: unknown;
	readonly digestCode: string;
	readonly bytesCode: string;
}

export function validateCampaignLockAttestations(
	input: unknown,
): { ok: true } | ValidationFailure {
	if (
		!isPlainObject(input) ||
		!isPlainObject(input.lock) ||
		!isPlainObject(input.observedAttestation)
	) {
		return { ok: false, code: "ATTESTATION_INVALID" };
	}
	const lock = input.lock;
	const observed = input.observedAttestation;
	const lockSource = lock.source as Rec;
	const lockSubmissions = lock.submissions as Rec;
	const lockTopology = lock.topology as Rec;
	const lockPlan = lock.executionPlan as Rec;
	if (
		!isPlainObject(lockSource) ||
		!isPlainObject(lockSubmissions) ||
		!isPlainObject(lockTopology) ||
		!isPlainObject(lockPlan)
	) {
		return { ok: false, code: "ATTESTATION_INVALID" };
	}

	// Echo-only observation is forbidden. Reference identity alone is no
	// test — `structuredClone(lock.source)` passes it — so an observation
	// that declares a provenance must declare the supervisor's own, and the
	// observed blocks whose honest shape differs from the plan's must not be
	// canonical copies of the plan.
	const provenanceIssue = observationProvenanceIssue(observed);
	if (provenanceIssue !== null && observed.provenance !== undefined) {
		return { ok: false, code: "ATTESTATION_PLANNED_VALUE_ALIAS_FORBIDDEN" };
	}
	if (
		Object.is(observed.source, lock.source) ||
		Object.is(observed.executionPlan, lock.executionPlan) ||
		Object.is(observed.submissions, lock.submissions) ||
		deepEqualJson(observed.source, lock.source) ||
		deepEqualJson(observed.submissions, lock.submissions)
	) {
		return { ok: false, code: "ATTESTATION_PLANNED_VALUE_ALIAS_FORBIDDEN" };
	}

	if (observed.candidateId !== lock.candidateId) {
		return { ok: false, code: "ATTESTATION_CANDIDATE_MISMATCH" };
	}
	if (observed.campaignId !== lock.campaignId) {
		return { ok: false, code: "ATTESTATION_CAMPAIGN_MISMATCH" };
	}
	if (
		input.lockBytes instanceof Uint8Array &&
		expectedDigestMismatch(
			input.expectedLockDigest,
			sha256HexOfBytes(input.lockBytes),
		)
	) {
		return { ok: false, code: "ATTESTATION_LOCK_DIGEST_MISMATCH" };
	}

	const observedSource = observed.source as Rec;
	if (!isPlainObject(observedSource)) {
		return { ok: false, code: "ATTESTATION_SOURCE_HEAD_MISMATCH" };
	}
	if (observedSource.reviewedCleanHead !== lockSource.reviewedCleanHead) {
		return { ok: false, code: "ATTESTATION_SOURCE_HEAD_MISMATCH" };
	}
	if (observedSource.reviewedTreeState !== lockSource.reviewedTreeState) {
		return { ok: false, code: "ATTESTATION_SOURCE_TREE_MISMATCH" };
	}
	if (observedSource.jsExecutableSha256 !== lockSource.jsExecutableSha256) {
		return { ok: false, code: "ATTESTATION_JS_EXECUTABLE_MISMATCH" };
	}
	if (
		observedSource.darwinNativeSha256 !== lockSource.darwinNativeSha256 ||
		observedSource.linuxNativeSha256 !== lockSource.linuxNativeSha256
	) {
		return { ok: false, code: "ATTESTATION_NATIVE_EXECUTABLE_MISMATCH" };
	}
	const observedToolchains = observedSource.toolchains as Rec;
	const lockToolchains = lockSource.toolchains as Rec;
	if (!isPlainObject(observedToolchains) || !isPlainObject(lockToolchains)) {
		return { ok: false, code: "ATTESTATION_JS_TOOLCHAIN_MISMATCH" };
	}
	if (!deepEqualJson(observedToolchains.js, lockToolchains.js)) {
		return { ok: false, code: "ATTESTATION_JS_TOOLCHAIN_MISMATCH" };
	}
	if (!deepEqualJson(observedToolchains.darwin, lockToolchains.darwin)) {
		return { ok: false, code: "ATTESTATION_DARWIN_TOOLCHAIN_MISMATCH" };
	}
	if (!deepEqualJson(observedToolchains.linux, lockToolchains.linux)) {
		return { ok: false, code: "ATTESTATION_LINUX_TOOLCHAIN_MISMATCH" };
	}

	const submissions = observed.submissions as Rec;
	if (!isPlainObject(submissions)) {
		return { ok: false, code: "ATTESTATION_ARCHIVE_BYTES_MISMATCH" };
	}
	const submissionChecks: readonly SubmissionCheck[] = [
		{
			key: "archive",
			plannedDigest: lockSource.archiveSha256,
			digestCode: "ATTESTATION_ARCHIVE_DIGEST_MISMATCH",
			bytesCode: "ATTESTATION_ARCHIVE_BYTES_MISMATCH",
		},
		{
			key: "registry",
			plannedDigest: lockSubmissions.registrySha256,
			digestCode: "ATTESTATION_REGISTRY_DIGEST_MISMATCH",
			bytesCode: "ATTESTATION_REGISTRY_BYTES_MISMATCH",
		},
		{
			key: "spec",
			plannedDigest: lockSubmissions.specSha256,
			digestCode: "ATTESTATION_SPEC_DIGEST_MISMATCH",
			bytesCode: "ATTESTATION_SPEC_BYTES_MISMATCH",
		},
		{
			key: "capacity",
			plannedDigest: lockSubmissions.capacitySha256,
			digestCode: "ATTESTATION_CAPACITY_DIGEST_MISMATCH",
			bytesCode: "ATTESTATION_CAPACITY_BYTES_MISMATCH",
		},
	];
	for (const check of submissionChecks) {
		const submission = submissions[check.key] as Rec;
		if (!isPlainObject(submission)) {
			return { ok: false, code: check.bytesCode };
		}
		if (submission.sha256 !== check.plannedDigest) {
			return { ok: false, code: check.digestCode };
		}
		const bytes = submission.bytes;
		if (
			!(bytes instanceof Uint8Array) ||
			sha256HexOfBytes(bytes) !== submission.sha256
		) {
			return { ok: false, code: check.bytesCode };
		}
	}

	const stagedArchives = observed.stagedArchivesByHost;
	if (!Array.isArray(stagedArchives)) {
		return { ok: false, code: "ATTESTATION_STAGED_ARCHIVE_HOST_COUNT_INVALID" };
	}
	const stagedHostIds = new Set<unknown>();
	for (const entry of stagedArchives) {
		if (!isPlainObject(entry)) {
			return {
				ok: false,
				code: "ATTESTATION_STAGED_ARCHIVE_HOST_COUNT_INVALID",
			};
		}
		if (stagedHostIds.has(entry.hostId)) {
			return { ok: false, code: "ATTESTATION_STAGED_ARCHIVE_DUPLICATE_HOST" };
		}
		stagedHostIds.add(entry.hostId);
	}
	const expectedHosts = new Set([
		lockTopology.macHostId,
		lockTopology.linuxHostId,
	]);
	if (
		stagedArchives.length !== expectedHosts.size ||
		[...expectedHosts].some((hostId) => !stagedHostIds.has(hostId))
	) {
		return { ok: false, code: "ATTESTATION_STAGED_ARCHIVE_HOST_COUNT_INVALID" };
	}
	for (const entry of stagedArchives as Rec[]) {
		const bytes = entry.bytes;
		if (
			entry.sha256 !== lockSource.stagedArchiveSha256 ||
			!(bytes instanceof Uint8Array) ||
			sha256HexOfBytes(bytes) !== entry.sha256
		) {
			return { ok: false, code: "ATTESTATION_STAGED_ARCHIVE_DIGEST_MISMATCH" };
		}
	}

	const observedCellSnapshots = observed.observedCellSnapshots;
	if (!Array.isArray(observedCellSnapshots)) {
		return { ok: false, code: "ATTESTATION_CELL_SNAPSHOT_MISMATCH" };
	}
	for (const bundle of observedCellSnapshots) {
		if (!isPlainObject(bundle)) {
			return { ok: false, code: "ATTESTATION_CELL_SNAPSHOT_MISMATCH" };
		}
		for (const side of ["preCell", "postCell"] as const) {
			const record = bundle[side] as Rec;
			if (
				!isPlainObject(record) ||
				isImplausibleDigest(record.sha256) ||
				(typeof input.expectedLockDigest === "string" &&
					record.lockDigestSha256 !== input.expectedLockDigest)
			) {
				return { ok: false, code: "ATTESTATION_CELL_SNAPSHOT_MISMATCH" };
			}
		}
	}

	const observedPlan = observed.executionPlan as Rec;
	if (!isPlainObject(observedPlan)) {
		return { ok: false, code: "ATTESTATION_EXECUTION_PLAN_MISMATCH" };
	}
	if (
		observedPlan.warmupRuns !== lockPlan.warmupRuns ||
		observedPlan.measuredRuns !== lockPlan.measuredRuns ||
		observedPlan.totalRuns !== lockPlan.totalRuns
	) {
		return { ok: false, code: "ATTESTATION_EXECUTION_PLAN_MISMATCH" };
	}
	if (
		!deepEqualJson(observedPlan.cellPhaseSequences, lockPlan.cellPhaseSequences)
	) {
		return { ok: false, code: "ATTESTATION_EXECUTION_SEQUENCE_MISMATCH" };
	}

	const observedRunFacts = observed.observedRunFacts;
	if (!Array.isArray(observedRunFacts) || observedRunFacts.length === 0) {
		return { ok: false, code: "ATTESTATION_OBSERVED_RUN_FACTS_MISSING" };
	}
	const peerRelationship = lockTopology.expectedPeerRelationship as Rec;
	for (const fact of observedRunFacts) {
		if (!isPlainObject(fact)) {
			return { ok: false, code: "ATTESTATION_OBSERVED_RUN_FACTS_MISSING" };
		}
		if (
			fact.routePath !== "direct-cable" ||
			(isPlainObject(peerRelationship) &&
				(fact.macPeerHostId !== peerRelationship.macPeerHostId ||
					fact.linuxPeerHostId !== peerRelationship.linuxPeerHostId))
		) {
			return { ok: false, code: "ATTESTATION_ROUTE_OR_PEER_MISMATCH" };
		}
		if (
			!isSafeCount(fact.dedicatedPgidObserved) ||
			fact.dedicatedPgidObserved <= 0 ||
			fact.restored !== true ||
			fact.qdiscBefore !== fact.qdiscAfter ||
			fact.cleanupStatus !== "restored-and-released"
		) {
			return { ok: false, code: "ATTESTATION_SUPERVISOR_FACTS_MISMATCH" };
		}
	}

	const observedWtFacts = observed.observedWtFacts;
	if (!Array.isArray(observedWtFacts) || observedWtFacts.length === 0) {
		return { ok: false, code: "ATTESTATION_OBSERVED_WT_FACTS_MISSING" };
	}
	for (const fact of observedWtFacts) {
		if (
			!isPlainObject(fact) ||
			fact.zeroRttOutcome !== "not-attempted" ||
			fact.resumptionOutcome !== "disabled"
		) {
			return { ok: false, code: "ATTESTATION_WT_FACTS_MISMATCH" };
		}
	}

	return { ok: true };
}
