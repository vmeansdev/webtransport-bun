/**
 * Phase-B cohort protocol codecs (plan §4.1, plus the §4.3 token-bundle
 * commitment and inherited-FD contract).
 *
 * Pure protocol, exactly like the A2 cross-supervisor codecs: canonical
 * encode/decode with exact key sets, typed refusal codes, named caps, Merkle
 * commitment over token hashes, and the FD-metadata oracle the role child uses
 * before it reads FD 5. Nothing here spawns a child, opens a socket, touches
 * the filesystem, or writes an artifact; byte-level inputs arrive from the
 * caller as `Uint8Array` and FD facts arrive as already-observed records.
 *
 * The one crypto seam is the A2 Ed25519 helper set; this module never mints a
 * second signature format.
 */
import { createHash } from "node:crypto";

import {
	bytesOfCanonical,
	fromBase64,
	parseMacReceiptSignature,
	sha256CanonicalRecord,
	verifyMacReceiptSignature,
	type Base64,
	type CrossSupervisorExecutionV1,
	type MacReceiptSignatureV1,
	type NsString,
	type ProtocolResult,
	type Sha256Hex,
	parseCrossSupervisorExecution,
} from "./cross-supervisor-protocol.ts";
import {
	hasOwn,
	isHex64,
	parseStrictJsonBytes,
	sha256HexOfBytes,
} from "./secure-fs.ts";

// ---------------------------------------------------------------------------
// Refusal classes
// ---------------------------------------------------------------------------

/** Structural/commitment defects in the cohort records themselves. */
export const COHORT_PROTOCOL_FAILURE_CODE = "COHORT_PROTOCOL" as const;
/** Readiness/barrier ordering defects: the cohort was never legally armed. */
export const COHORT_NOT_READY_FAILURE_CODE = "COHORT_NOT_READY" as const;
/** Warmup was vacuous, mispaced, mis-bound, or incompletely reported. */
export const WARMUP_PROTOCOL_FAILURE_CODE = "WARMUP_PROTOCOL" as const;

// ---------------------------------------------------------------------------
// Caps and fixed schedule constants (exact plan values)
// ---------------------------------------------------------------------------

/** §4.1 signed cohort grant cap. */
export const COHORT_GRANT_MAX_BYTES = 256 * 1024;
/** §4.1 retained leaf manifest cap (10,010 leaves fit with margin). */
export const TOKEN_COMMITMENT_LEAF_MANIFEST_MAX_BYTES = 4 * 1024 * 1024;
/** §4.1 signed warmup epoch cap. */
export const COHORT_WARMUP_EPOCH_MAX_BYTES = 16 * 1024;
/** §4.1 signed role warmup completion manifest cap. */
export const ROLE_WARMUP_COMPLETION_MANIFEST_MAX_BYTES = 256 * 1024;

/** At most ten publishers exist in any Phase B cell. */
export const COHORT_MAX_PUBLISHERS = 10;
/** Exactly eight subscriber worker children. */
export const COHORT_WORKER_COUNT = 8;
/** Subscriber shard assignment is `globalOrdinal mod 8`. */
export const SUBSCRIBER_SHARD_MODULUS = 8;

/**
 * The exclusive end of a shard's commitment window.
 *
 * A worker's members are its residue class of the subscriber leaves: with the
 * first member at commitment index `first`, the ordered members sit at
 * `first, first + 8, …, first + (count - 1) * 8` (design §2.3, one global
 * ordinal domain and worker `o mod 8`; `secure_fs.rs:19199-19205`), so the
 * window that spans exactly those leaves ends one past the last of them. A
 * dense `first + count` is the old placeholder that held only the first
 * sixteen members of a 125-member shard.
 */
export function subscriberShardCommitmentWindowEnd(
	firstTokenCommitmentIndex: number,
	subscriberCount: number,
): number {
	return (
		firstTokenCommitmentIndex +
		(subscriberCount - 1) * SUBSCRIBER_SHARD_MODULUS +
		1
	);
}

export const COHORT_CONNECTION_RATE_PER_SECOND = 500;
export const COHORT_MAX_CONNECTIONS_IN_FLIGHT = 200;
export const COHORT_IN_REPETITION_WARMUP_MS = 5_000;
export const COHORT_SAMPLE_WINDOW_MS = 1_000;
export const COHORT_DRAIN_DEADLINE_MS = 10_000;
export const COHORT_MEASURED_DURATION_MS_VALUES = [10_000, 30_000] as const;
export const COHORT_WINDOW_COUNT_VALUES = [10, 30] as const;
export const COHORT_MESSAGE_BYTES_VALUES = [100, 128] as const;

/**
 * Readiness deadlines are fixed per cell, not negotiated: every ticker row
 * takes the ticker deadline and every chat row the chat one (physical-budget
 * amendment D3), so the closed set has exactly two members.
 */
export const READINESS_DEADLINE_MS_TICKER = 30_000;
export const READINESS_DEADLINE_MS_CHAT = 90_000;
export const READINESS_DEADLINE_MS_VALUES = [
	READINESS_DEADLINE_MS_TICKER,
	READINESS_DEADLINE_MS_CHAT,
] as const;

/** Warmup is identical in every Phase B cell and is never vacuous. */
export const WARMUP_MESSAGES_PER_PUBLISHER = 10;
export const WARMUP_INTERVAL_MS = 500;
export const WARMUP_DURATION_MS = 5_000;
/** Ordered offsets 0,500,...,4500 ms from `startAtMacNs`; no catch-up burst. */
export const WARMUP_OFFSETS_MS: readonly number[] = Array.from(
	{ length: WARMUP_MESSAGES_PER_PUBLISHER },
	(_unused, index) => index * WARMUP_INTERVAL_MS,
);

/** Token bundles are inherited on this descriptor, never as a control frame. */
export const TOKEN_BUNDLE_FD = 5;
/** The child must finish its single read of FD 5 inside this deadline. */
export const TOKEN_BUNDLE_FD_READ_DEADLINE_MS = 5_000;
/** Mode the supervisor creates the backing file with before it unlinks it. */
export const TOKEN_BUNDLE_FILE_MODE = 0o600;
/** Hard cap checked before allocation, write, and read. */
export const TOKEN_BUNDLE_MAX_SIZE = 2_097_152;
/** Frozen worst-case canonical size of one bundle entry. */
export const TOKEN_BUNDLE_MAX_ENTRY_BYTES = 1_536;
/** Frozen worst-case canonical size of the bundle envelope around entries. */
export const TOKEN_BUNDLE_ENVELOPE_BYTES = 4_096;
/** Worst-case subscribers on one chat-10k worker: 10,000 / 8 shards. */
export const CHAT_10K_WORST_CASE_WORKER_SUBSCRIBERS = 1_250;
/** 1250 * 1536 + 4096, the frozen chat-10k worst-case bundle size. */
export const CHAT_10K_TOKEN_BUNDLE_MAX_BYTES = 1_924_096;
/** 2,097,152 - 1,924,096: headroom the frozen worst case leaves under the cap. */
export const CHAT_10K_TOKEN_BUNDLE_MARGIN_BYTES = 173_056;
/** Merkle depth of a 10,010-leaf chat-10k tree. */
export const CHAT_10K_TOKEN_MERKLE_PROOF_LENGTH = 14;
/** Upper bound on a Merkle proof; 2^64 leaves would still fit. */
export const TOKEN_MERKLE_MAX_PROOF_LENGTH = 64;

// ---------------------------------------------------------------------------
// Local strict-parse helpers (mirrors of the A2 codec helpers)
// ---------------------------------------------------------------------------

type Rec = Record<string, unknown>;

function isPlainObject(value: unknown): value is Rec {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function exactKeys(record: Rec, expected: readonly string[]): boolean {
	const keys = Object.keys(record).sort();
	if (keys.length !== expected.length) return false;
	return expected.every((key, index) => keys[index] === key);
}

function isSafeNonNegInt(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isSafePosInt(value: unknown): value is number {
	return isSafeNonNegInt(value) && value > 0;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 512;
}

const NS_STRING_RE = /^(0|[1-9][0-9]{0,19})$/;

/** Nanoseconds are decimal strings; leading zeros and signs are rejected. */
function isNsString(value: unknown): value is NsString {
	return typeof value === "string" && NS_STRING_RE.test(value);
}

function ns(value: NsString): bigint {
	return BigInt(value);
}

function isOneOf<T extends number | string>(
	value: unknown,
	allowed: readonly T[],
): value is T {
	return allowed.includes(value as T);
}

function fail(
	code: string,
	message: string,
): {
	readonly ok: false;
	readonly code: string;
	readonly message: string;
} {
	return { ok: false, code, message };
}

function cohortFail(message: string) {
	return fail(COHORT_PROTOCOL_FAILURE_CODE, message);
}

/** Checked multiplication that also refuses results JSON cannot carry exactly. */
function checkedMul(left: number, right: number): number | null {
	if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right)) return null;
	const product = left * right;
	if (!Number.isSafeInteger(product)) return null;
	return product;
}

function checkedAdd(left: number, right: number): number | null {
	if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right)) return null;
	const sum = left + right;
	if (!Number.isSafeInteger(sum)) return null;
	return sum;
}

/** Digest of an already-canonical record, capped before it is believed. */
function withinCap(
	value: unknown,
	cap: number,
	label: string,
): ProtocolResult<Uint8Array> {
	const bytes = bytesOfCanonical(value);
	if (bytes.byteLength > cap) {
		return cohortFail(`${label} ${bytes.byteLength} exceeds cap ${cap}`);
	}
	return { ok: true, value: bytes };
}

// ---------------------------------------------------------------------------
// Role grants, shards, and commitment leaves
// ---------------------------------------------------------------------------

export interface PublisherRoleGrantV1 {
	readonly schema: "publisher-role-grant/v1";
	readonly childId: string;
	readonly publisherId: string;
	readonly tokenCommitmentIndex: number;
	readonly tokenSha256: Sha256Hex;
}

export interface SubscriberShardV1 {
	readonly schema: "subscriber-shard/v1";
	readonly childId: string;
	readonly workerIndex: number;
	readonly modulus: 8;
	readonly residue: number;
	readonly firstSubscriberIndex: 0;
	readonly lastSubscriberIndexExclusive: number;
	readonly subscriberCount: number;
	readonly orderedSubscriberIdsSha256: Sha256Hex;
	readonly firstTokenCommitmentIndex: number;
	readonly lastTokenCommitmentIndexExclusive: number;
}

export interface TokenCommitmentLeafV1 {
	readonly schema: "token-commitment-leaf/v1";
	readonly childId: string;
	readonly cohortId: string;
	readonly role: "publisher" | "subscriber";
	readonly roleId: string;
	readonly tokenSha256: Sha256Hex;
	readonly workerIndex: number | null;
}

export interface TokenCommitmentLeafManifestV1 {
	readonly schema: "token-commitment-leaf-manifest/v1";
	readonly executionSha256: Sha256Hex;
	readonly cohortId: string;
	readonly leafCount: number;
	readonly leaves: readonly TokenCommitmentLeafV1[];
	readonly roleTokenCommitmentRootSha256: Sha256Hex;
}

const PUBLISHER_ROLE_GRANT_KEYS = [
	"childId",
	"publisherId",
	"schema",
	"tokenCommitmentIndex",
	"tokenSha256",
] as const;

const SUBSCRIBER_SHARD_KEYS = [
	"childId",
	"firstSubscriberIndex",
	"firstTokenCommitmentIndex",
	"lastSubscriberIndexExclusive",
	"lastTokenCommitmentIndexExclusive",
	"modulus",
	"orderedSubscriberIdsSha256",
	"residue",
	"schema",
	"subscriberCount",
	"workerIndex",
] as const;

const TOKEN_COMMITMENT_LEAF_KEYS = [
	"childId",
	"cohortId",
	"role",
	"roleId",
	"schema",
	"tokenSha256",
	"workerIndex",
] as const;

const TOKEN_COMMITMENT_LEAF_MANIFEST_KEYS = [
	"cohortId",
	"executionSha256",
	"leafCount",
	"leaves",
	"roleTokenCommitmentRootSha256",
	"schema",
] as const;

/** `publisher-000000` / `subscriber-009992`: zero-padded, at least six digits. */
const ROLE_ID_RE = /^(publisher|subscriber)-[0-9]{6,}$/;

function roleIdNumber(roleId: string): number | null {
	const dash = roleId.lastIndexOf("-");
	if (dash < 0) return null;
	const digits = roleId.slice(dash + 1);
	if (!/^[0-9]{6,}$/.test(digits)) return null;
	const parsed = Number(digits);
	return Number.isSafeInteger(parsed) ? parsed : null;
}

export function parsePublisherRoleGrant(
	value: unknown,
): ProtocolResult<PublisherRoleGrantV1> {
	if (!isPlainObject(value) || !exactKeys(value, PUBLISHER_ROLE_GRANT_KEYS)) {
		return cohortFail("publisher role grant keys");
	}
	if (
		value.schema !== "publisher-role-grant/v1" ||
		!isNonEmptyString(value.childId) ||
		!isNonEmptyString(value.publisherId) ||
		!ROLE_ID_RE.test(value.publisherId) ||
		!value.publisherId.startsWith("publisher-") ||
		!isSafeNonNegInt(value.tokenCommitmentIndex) ||
		!isHex64(value.tokenSha256)
	) {
		return cohortFail("publisher role grant fields");
	}
	return { ok: true, value: value as unknown as PublisherRoleGrantV1 };
}

/**
 * `grantSubscriberCount` is the grant's own `subscriberCount`, not the shard's.
 *
 * The two are different numbers and the difference is the whole point of the
 * field: `subscriberCount` is how many subscribers this residue carries, and
 * `lastSubscriberIndexExclusive` is the end of the one global subscriber run
 * every shard indexes into — which is why `firstSubscriberIndex` is a literal
 * `0` on all eight shards. Mirrors `parse_shards(map, subscriber_count)`
 * (`crates/native/src/secure_fs.rs:12531`, bound at `:12556`); the sum check
 * the Rust does at `:12572` is vacuous under any other reading.
 */
export function parseSubscriberShard(
	value: unknown,
	grantSubscriberCount: number,
): ProtocolResult<SubscriberShardV1> {
	if (!isPlainObject(value) || !exactKeys(value, SUBSCRIBER_SHARD_KEYS)) {
		return cohortFail("subscriber shard keys");
	}
	if (!isSafePosInt(grantSubscriberCount)) {
		return cohortFail("grant subscriber total is not a positive integer");
	}
	if (
		value.schema !== "subscriber-shard/v1" ||
		!isNonEmptyString(value.childId) ||
		!isSafeNonNegInt(value.workerIndex) ||
		value.workerIndex >= COHORT_WORKER_COUNT ||
		value.modulus !== SUBSCRIBER_SHARD_MODULUS ||
		!isSafeNonNegInt(value.residue) ||
		value.residue !== value.workerIndex ||
		value.firstSubscriberIndex !== 0 ||
		!isSafePosInt(value.lastSubscriberIndexExclusive) ||
		!isSafePosInt(value.subscriberCount) ||
		value.lastSubscriberIndexExclusive !== grantSubscriberCount ||
		!isHex64(value.orderedSubscriberIdsSha256) ||
		!isSafeNonNegInt(value.firstTokenCommitmentIndex) ||
		!isSafePosInt(value.lastTokenCommitmentIndexExclusive) ||
		// The window is the span of the residue class, never the dense
		// `first + count` (R-A): one short is refused here.
		value.lastTokenCommitmentIndexExclusive !==
			subscriberShardCommitmentWindowEnd(
				value.firstTokenCommitmentIndex,
				value.subscriberCount,
			)
	) {
		return cohortFail("subscriber shard fields");
	}
	return { ok: true, value: value as unknown as SubscriberShardV1 };
}

export function parseTokenCommitmentLeaf(
	value: unknown,
): ProtocolResult<TokenCommitmentLeafV1> {
	if (!isPlainObject(value) || !exactKeys(value, TOKEN_COMMITMENT_LEAF_KEYS)) {
		return cohortFail("token commitment leaf keys");
	}
	if (
		value.schema !== "token-commitment-leaf/v1" ||
		!isNonEmptyString(value.childId) ||
		!isNonEmptyString(value.cohortId) ||
		(value.role !== "publisher" && value.role !== "subscriber") ||
		!isNonEmptyString(value.roleId) ||
		!ROLE_ID_RE.test(value.roleId) ||
		!value.roleId.startsWith(`${value.role}-`) ||
		!isHex64(value.tokenSha256)
	) {
		return cohortFail("token commitment leaf fields");
	}
	// A publisher has no shard; a subscriber always names its worker. `null` is
	// required rather than omitted so the canonical bytes are identical either
	// way and an absent shard can never read as shard zero.
	if (value.role === "publisher") {
		if (value.workerIndex !== null) {
			return cohortFail("publisher leaf must carry null workerIndex");
		}
	} else if (
		!isSafeNonNegInt(value.workerIndex) ||
		value.workerIndex >= COHORT_WORKER_COUNT
	) {
		return cohortFail("subscriber leaf workerIndex");
	}
	return { ok: true, value: value as unknown as TokenCommitmentLeafV1 };
}

/**
 * Canonical commitment order: publishers before subscribers, then ascending
 * numeric role ID. The order is a property of the record set, so it is
 * recomputed rather than trusted from whatever order a caller supplied.
 */
export function orderTokenCommitmentLeaves(
	leaves: readonly TokenCommitmentLeafV1[],
): TokenCommitmentLeafV1[] {
	return [...leaves].sort((left, right) => {
		const leftRank = left.role === "publisher" ? 0 : 1;
		const rightRank = right.role === "publisher" ? 0 : 1;
		if (leftRank !== rightRank) return leftRank - rightRank;
		const leftId = roleIdNumber(left.roleId) ?? Number.MAX_SAFE_INTEGER;
		const rightId = roleIdNumber(right.roleId) ?? Number.MAX_SAFE_INTEGER;
		if (leftId !== rightId) return leftId - rightId;
		return left.roleId < right.roleId ? -1 : left.roleId > right.roleId ? 1 : 0;
	});
}

function leavesAreCanonicallyOrdered(
	leaves: readonly TokenCommitmentLeafV1[],
): boolean {
	const ordered = orderTokenCommitmentLeaves(leaves);
	return ordered.every((leaf, index) => leaf === leaves[index]);
}

export function parseTokenCommitmentLeafManifest(
	value: unknown,
): ProtocolResult<TokenCommitmentLeafManifestV1> {
	if (
		!isPlainObject(value) ||
		!exactKeys(value, TOKEN_COMMITMENT_LEAF_MANIFEST_KEYS)
	) {
		return cohortFail("leaf manifest keys");
	}
	if (
		value.schema !== "token-commitment-leaf-manifest/v1" ||
		!isHex64(value.executionSha256) ||
		!isNonEmptyString(value.cohortId) ||
		!isSafePosInt(value.leafCount) ||
		!Array.isArray(value.leaves) ||
		!isHex64(value.roleTokenCommitmentRootSha256)
	) {
		return cohortFail("leaf manifest fields");
	}
	if (value.leaves.length !== value.leafCount) {
		return cohortFail("leafCount does not match leaves cardinality");
	}
	const capped = withinCap(
		value,
		TOKEN_COMMITMENT_LEAF_MANIFEST_MAX_BYTES,
		"leaf manifest",
	);
	if (!capped.ok) return capped;

	const leaves: TokenCommitmentLeafV1[] = [];
	const seenRoleIds = new Set<string>();
	const seenTokenHashes = new Set<string>();
	for (const candidate of value.leaves) {
		const leaf = parseTokenCommitmentLeaf(candidate);
		if (!leaf.ok) return leaf;
		if (leaf.value.cohortId !== value.cohortId) {
			return cohortFail("leaf cohortId does not match manifest");
		}
		if (seenRoleIds.has(leaf.value.roleId)) {
			return cohortFail(`duplicate leaf roleId ${leaf.value.roleId}`);
		}
		// One token is spent once; two leaves committing the same token hash
		// would let one registration satisfy two roles.
		if (seenTokenHashes.has(leaf.value.tokenSha256)) {
			return cohortFail("duplicate leaf tokenSha256");
		}
		seenRoleIds.add(leaf.value.roleId);
		seenTokenHashes.add(leaf.value.tokenSha256);
		leaves.push(leaf.value);
	}
	if (!leavesAreCanonicallyOrdered(leaves)) {
		return cohortFail("leaves are not in canonical commitment order");
	}
	const root = computeTokenCommitmentRoot(
		leaves.map((leaf) => tokenCommitmentLeafSha256(leaf)),
	);
	if (!root.ok) return root;
	if (root.value !== value.roleTokenCommitmentRootSha256) {
		return cohortFail("declared root does not match recomputed root");
	}
	return { ok: true, value: value as unknown as TokenCommitmentLeafManifestV1 };
}

// ---------------------------------------------------------------------------
// Token commitment Merkle tree
// ---------------------------------------------------------------------------

const MERKLE_LEAF_PREFIX = 0x00;
const MERKLE_INTERNAL_PREFIX = 0x01;

function hexToBytes(hex: Sha256Hex): Uint8Array {
	const out = new Uint8Array(32);
	for (let index = 0; index < 32; index += 1) {
		out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
	}
	return out;
}

/** SHA-256 over the exact canonical leaf bytes, including the trailing LF. */
export function tokenCommitmentLeafSha256(
	leaf: TokenCommitmentLeafV1,
): Sha256Hex {
	return sha256CanonicalRecord(leaf);
}

/** Domain-separated leaf node: `SHA256(0x00 || leafSha256Bytes)`. */
export function tokenMerkleLeafNode(leafSha256: Sha256Hex): Sha256Hex {
	return createHash("sha256")
		.update(Uint8Array.of(MERKLE_LEAF_PREFIX))
		.update(hexToBytes(leafSha256))
		.digest("hex");
}

/** Domain-separated internal node: `SHA256(0x01 || left || right)`. */
export function tokenMerkleInternalNode(
	left: Sha256Hex,
	right: Sha256Hex,
): Sha256Hex {
	return createHash("sha256")
		.update(Uint8Array.of(MERKLE_INTERNAL_PREFIX))
		.update(hexToBytes(left))
		.update(hexToBytes(right))
		.digest("hex");
}

/**
 * Every tree level, bottom-up, with an odd trailing node paired with itself.
 * Levels are materialized once so proofs for many roles stay cheap.
 */
function tokenMerkleLevels(
	leafSha256List: readonly Sha256Hex[],
): ProtocolResult<Sha256Hex[][]> {
	if (leafSha256List.length === 0) {
		return cohortFail("token commitment tree requires at least one leaf");
	}
	for (const leaf of leafSha256List) {
		if (!isHex64(leaf))
			return cohortFail("leaf digest is not 64 lowercase hex");
	}
	const levels: Sha256Hex[][] = [
		leafSha256List.map((leaf) => tokenMerkleLeafNode(leaf)),
	];
	while ((levels[levels.length - 1] as Sha256Hex[]).length > 1) {
		const current = levels[levels.length - 1] as Sha256Hex[];
		const next: Sha256Hex[] = [];
		for (let index = 0; index < current.length; index += 2) {
			const left = current[index] as Sha256Hex;
			const right = (current[index + 1] ?? left) as Sha256Hex;
			next.push(tokenMerkleInternalNode(left, right));
		}
		levels.push(next);
	}
	return { ok: true, value: levels };
}

export function computeTokenCommitmentRoot(
	leafSha256List: readonly Sha256Hex[],
): ProtocolResult<Sha256Hex> {
	const levels = tokenMerkleLevels(leafSha256List);
	if (!levels.ok) return levels;
	const top = levels.value[levels.value.length - 1] as Sha256Hex[];
	return { ok: true, value: top[0] as Sha256Hex };
}

export function computeTokenMerkleProof(
	leafSha256List: readonly Sha256Hex[],
	tokenCommitmentIndex: number,
): ProtocolResult<Sha256Hex[]> {
	if (
		!isSafeNonNegInt(tokenCommitmentIndex) ||
		tokenCommitmentIndex >= leafSha256List.length
	) {
		return cohortFail("token commitment index out of range");
	}
	const levels = tokenMerkleLevels(leafSha256List);
	if (!levels.ok) return levels;
	const proof: Sha256Hex[] = [];
	let index = tokenCommitmentIndex;
	for (let level = 0; level < levels.value.length - 1; level += 1) {
		const nodes = levels.value[level] as Sha256Hex[];
		const siblingIndex = index % 2 === 0 ? index + 1 : index - 1;
		proof.push((nodes[siblingIndex] ?? nodes[index]) as Sha256Hex);
		index = Math.floor(index / 2);
	}
	return { ok: true, value: proof };
}

/**
 * Recompute the root from a leaf hash and its sibling array alone. The raw
 * token never enters this computation, which is what lets the offline verifier
 * check every role's commitment against a manifest that holds only hashes.
 */
export function verifyTokenMerkleProof(args: {
	readonly leafSha256: Sha256Hex;
	readonly tokenCommitmentIndex: number;
	readonly leafCount: number;
	readonly proof: readonly Sha256Hex[];
	readonly rootSha256: Sha256Hex;
}): ProtocolResult<true> {
	if (!isHex64(args.leafSha256) || !isHex64(args.rootSha256)) {
		return cohortFail("proof digests are not 64 lowercase hex");
	}
	if (!isSafePosInt(args.leafCount)) {
		return cohortFail("leafCount must be positive");
	}
	if (
		!isSafeNonNegInt(args.tokenCommitmentIndex) ||
		args.tokenCommitmentIndex >= args.leafCount
	) {
		return cohortFail("token commitment index out of range");
	}
	if (args.proof.length > TOKEN_MERKLE_MAX_PROOF_LENGTH) {
		return cohortFail("proof longer than the maximum tree depth");
	}
	for (const sibling of args.proof) {
		if (!isHex64(sibling)) return cohortFail("proof sibling is not hex64");
	}
	let node = tokenMerkleLeafNode(args.leafSha256);
	let index = args.tokenCommitmentIndex;
	let width = args.leafCount;
	let level = 0;
	while (width > 1) {
		if (level >= args.proof.length) {
			return cohortFail("proof shorter than the tree depth");
		}
		const sibling = args.proof[level] as Sha256Hex;
		node =
			index % 2 === 0
				? tokenMerkleInternalNode(node, sibling)
				: tokenMerkleInternalNode(sibling, node);
		index = Math.floor(index / 2);
		width = Math.ceil(width / 2);
		level += 1;
	}
	if (level !== args.proof.length) {
		return cohortFail("proof longer than the tree depth");
	}
	if (node !== args.rootSha256) {
		return cohortFail("recomputed root does not match the signed root");
	}
	return { ok: true, value: true };
}

/** Root recomputation from the retained, secret-free leaf manifest. */
export function recomputeRootFromLeafManifest(
	manifest: TokenCommitmentLeafManifestV1,
): ProtocolResult<Sha256Hex> {
	return computeTokenCommitmentRoot(
		manifest.leaves.map((leaf) => tokenCommitmentLeafSha256(leaf)),
	);
}

// ---------------------------------------------------------------------------
// Cohort grant (pre-readiness, Mac-signed)
// ---------------------------------------------------------------------------

export interface CohortGrantV1 {
	readonly schema: "cohort-grant/v1";
	readonly execution: CrossSupervisorExecutionV1;
	readonly executionSha256: Sha256Hex;
	readonly macExecutionGrantReceiptSha256: Sha256Hex;
	readonly approvedPlanSha256: Sha256Hex;
	readonly approvalRecordSha256: Sha256Hex;
	readonly cohortId: string;
	readonly cohortAttempt: number;
	readonly scenarioHash: Sha256Hex;
	readonly rolePlanHash: Sha256Hex;
	readonly workloadRolePlanInputSha256: Sha256Hex;
	readonly transport: "ws" | "wt";
	readonly publisherCount: number;
	readonly subscriberCount: number;
	readonly workerCount: 8;
	readonly expectedProcessCount: number;
	readonly expectedSessionCount: number;
	readonly publishers: readonly PublisherRoleGrantV1[];
	readonly subscriberShards: readonly SubscriberShardV1[];
	readonly tokenCommitmentLeafManifestSha256: Sha256Hex;
	readonly roleTokenCommitmentRootSha256: Sha256Hex;
	readonly roleTokenCommitmentCount: number;
	readonly connectionRatePerSecond: 500;
	readonly maxConnectionsInFlight: 200;
	readonly readinessDeadlineMs: number;
	readonly inRepetitionWarmupMs: 5000;
	readonly sampleWindowMs: 1000;
	readonly measuredDurationMs: 10000 | 30000;
	readonly drainDeadlineMs: 10000;
	readonly messageBytes: 100 | 128;
	readonly expectedOfferedIngress: number;
	readonly expectedExpandedDeliveries: number;
	readonly macSupervisorInstanceNonce: Sha256Hex;
	readonly signingPublicKeySha256: Sha256Hex;
	readonly receiptSequence: number;
	readonly issuedAtMs: number;
	readonly notAfterMs: number;
}

const COHORT_GRANT_KEYS = [
	"approvalRecordSha256",
	"approvedPlanSha256",
	"cohortAttempt",
	"cohortId",
	"connectionRatePerSecond",
	"drainDeadlineMs",
	"execution",
	"executionSha256",
	"expectedExpandedDeliveries",
	"expectedOfferedIngress",
	"expectedProcessCount",
	"expectedSessionCount",
	"inRepetitionWarmupMs",
	"issuedAtMs",
	"macExecutionGrantReceiptSha256",
	"macSupervisorInstanceNonce",
	"maxConnectionsInFlight",
	"measuredDurationMs",
	"messageBytes",
	"notAfterMs",
	"publisherCount",
	"publishers",
	"readinessDeadlineMs",
	"receiptSequence",
	"roleTokenCommitmentCount",
	"roleTokenCommitmentRootSha256",
	"rolePlanHash",
	"sampleWindowMs",
	"scenarioHash",
	"schema",
	"signingPublicKeySha256",
	"subscriberCount",
	"subscriberShards",
	"tokenCommitmentLeafManifestSha256",
	"transport",
	"workerCount",
	"workloadRolePlanInputSha256",
].sort() as readonly string[];

/**
 * The grant is minted before any session exists, so it can never carry a
 * measured-window timestamp. Naming them is redundant with the exact-key check
 * but makes the intent auditable next to the schema.
 */
const COHORT_GRANT_FORBIDDEN_FIELDS = [
	"barrierNonce",
	"measureStartAtMacNs",
	"measureStopAtMacNs",
	"mintedAtMacNs",
	"rigMeasureStartAckSha256",
] as const;

export function parseCohortGrant(
	value: unknown,
): ProtocolResult<CohortGrantV1> {
	if (!isPlainObject(value)) return cohortFail("cohort grant not an object");
	for (const forbidden of COHORT_GRANT_FORBIDDEN_FIELDS) {
		if (hasOwn(value, forbidden)) {
			return cohortFail(`pre-readiness grant must not carry ${forbidden}`);
		}
	}
	if (!exactKeys(value, COHORT_GRANT_KEYS)) {
		return cohortFail("cohort grant exact keys mismatch");
	}
	if (value.schema !== "cohort-grant/v1") {
		return cohortFail("cohort grant schema");
	}
	const execution = parseCrossSupervisorExecution(value.execution);
	if (!execution.ok) return execution;
	if (
		!isHex64(value.executionSha256) ||
		!isHex64(value.macExecutionGrantReceiptSha256) ||
		!isHex64(value.approvedPlanSha256) ||
		!isHex64(value.approvalRecordSha256) ||
		!isNonEmptyString(value.cohortId) ||
		!isSafePosInt(value.cohortAttempt) ||
		!isHex64(value.scenarioHash) ||
		!isHex64(value.rolePlanHash) ||
		!isHex64(value.workloadRolePlanInputSha256) ||
		(value.transport !== "ws" && value.transport !== "wt") ||
		!isSafePosInt(value.publisherCount) ||
		!isSafePosInt(value.subscriberCount) ||
		value.workerCount !== COHORT_WORKER_COUNT ||
		!isSafePosInt(value.expectedProcessCount) ||
		!isSafePosInt(value.expectedSessionCount) ||
		!Array.isArray(value.publishers) ||
		!Array.isArray(value.subscriberShards) ||
		!isHex64(value.tokenCommitmentLeafManifestSha256) ||
		!isHex64(value.roleTokenCommitmentRootSha256) ||
		!isSafePosInt(value.roleTokenCommitmentCount) ||
		value.connectionRatePerSecond !== COHORT_CONNECTION_RATE_PER_SECOND ||
		value.maxConnectionsInFlight !== COHORT_MAX_CONNECTIONS_IN_FLIGHT ||
		!isOneOf(value.readinessDeadlineMs, READINESS_DEADLINE_MS_VALUES) ||
		value.inRepetitionWarmupMs !== COHORT_IN_REPETITION_WARMUP_MS ||
		value.sampleWindowMs !== COHORT_SAMPLE_WINDOW_MS ||
		!isOneOf(value.measuredDurationMs, COHORT_MEASURED_DURATION_MS_VALUES) ||
		value.drainDeadlineMs !== COHORT_DRAIN_DEADLINE_MS ||
		!isOneOf(value.messageBytes, COHORT_MESSAGE_BYTES_VALUES) ||
		!isSafePosInt(value.expectedOfferedIngress) ||
		!isSafePosInt(value.expectedExpandedDeliveries) ||
		!isHex64(value.macSupervisorInstanceNonce) ||
		!isHex64(value.signingPublicKeySha256) ||
		!isSafeNonNegInt(value.receiptSequence) ||
		!isSafeNonNegInt(value.issuedAtMs) ||
		!isSafeNonNegInt(value.notAfterMs)
	) {
		return cohortFail("cohort grant field types");
	}
	if (value.notAfterMs < value.issuedAtMs) {
		return fail("MAC_GRANT_EXPIRED", "notAfter < issued");
	}
	const capped = withinCap(value, COHORT_GRANT_MAX_BYTES, "cohort grant");
	if (!capped.ok) return capped;

	if (sha256CanonicalRecord(execution.value) !== value.executionSha256) {
		return cohortFail("executionSha256 does not match the embedded execution");
	}
	if (
		value.approvedPlanSha256 !== execution.value.approvedPlanSha256 ||
		value.approvalRecordSha256 !== execution.value.approvalRecordSha256
	) {
		return fail("APPROVAL_IDENTITY_MISMATCH", "plan/approval swap");
	}
	if (
		value.scenarioHash !== execution.value.scenarioHash ||
		value.rolePlanHash !== execution.value.rolePlanHash ||
		value.workloadRolePlanInputSha256 !==
			execution.value.workloadRolePlanInputSha256 ||
		value.transport !== execution.value.transport
	) {
		return fail(
			"CROSS_SUPERVISOR_MISMATCH",
			"grant workload identity differs from the signed execution",
		);
	}
	if (value.publisherCount > COHORT_MAX_PUBLISHERS) {
		return cohortFail(
			`publisherCount ${value.publisherCount} exceeds ${COHORT_MAX_PUBLISHERS}`,
		);
	}

	// Role cardinality: processes, sessions, and commitment leaves are three
	// views of the same cohort and must agree exactly.
	const expectedProcesses = checkedAdd(
		value.publisherCount,
		COHORT_WORKER_COUNT,
	);
	const expectedSessions = checkedAdd(
		value.publisherCount,
		value.subscriberCount,
	);
	if (expectedProcesses === null || expectedSessions === null) {
		return cohortFail("cohort cardinality overflow");
	}
	if (value.expectedProcessCount !== expectedProcesses) {
		return cohortFail("expectedProcessCount mismatch");
	}
	if (value.expectedSessionCount !== expectedSessions) {
		return cohortFail("expectedSessionCount mismatch");
	}
	if (value.roleTokenCommitmentCount !== expectedSessions) {
		return cohortFail("roleTokenCommitmentCount mismatch");
	}

	if (value.publishers.length !== value.publisherCount) {
		return cohortFail("publisher grant cardinality mismatch");
	}
	const seenPublisherIds = new Set<string>();
	const seenPublisherIndices = new Set<number>();
	const seenPublisherTokens = new Set<string>();
	for (const candidate of value.publishers) {
		const grant = parsePublisherRoleGrant(candidate);
		if (!grant.ok) return grant;
		if (seenPublisherIds.has(grant.value.publisherId)) {
			return cohortFail("duplicate publisherId");
		}
		if (seenPublisherIndices.has(grant.value.tokenCommitmentIndex)) {
			return cohortFail("duplicate publisher tokenCommitmentIndex");
		}
		if (seenPublisherTokens.has(grant.value.tokenSha256)) {
			return cohortFail("duplicate publisher tokenSha256");
		}
		if (grant.value.tokenCommitmentIndex >= value.publisherCount) {
			return cohortFail("publisher commitment index outside the publisher run");
		}
		seenPublisherIds.add(grant.value.publisherId);
		seenPublisherIndices.add(grant.value.tokenCommitmentIndex);
		seenPublisherTokens.add(grant.value.tokenSha256);
	}

	// Exactly `SUBSCRIBER_SHARD_MODULUS` entries, and each one at its own
	// residue's position. This is an array-level invariant, so it lives here
	// and not in `parseSubscriberShard`, which sees one entry at a time.
	// `secure_fs.rs:12540` refuses any other length and `:12554-12555` binds
	// both `workerIndex` and `residue` to the array index, so a reordered
	// shard array that TS accepted would be refused by the rig.
	if (value.subscriberShards.length !== SUBSCRIBER_SHARD_MODULUS) {
		return cohortFail("subscriber shard cardinality mismatch");
	}
	//
	// A shard's commitment fields are the residue class it carries, not a
	// dense interval: both producers assign `workerIndex = ordinal % 8` and
	// commitment indices in leaf order (`scenarios/fanout-relay.ts:2026`,
	// `:2036`, `:2078-2084`; `mac_cohort_runtime.rs:284-305`), so worker `w`
	// holds `first, first + 8, first + 16, ...` and `[first, first + count)` is
	// the range's *declaration*, which two consecutive workers overlap as
	// intervals while never sharing a leaf. Which leaves a shard holds is only
	// checkable against the leaf manifest, and that is
	// `verifyPresentedCohortTopology` below, mirroring the binary's
	// `verify_presented_topology` (`secure_fs.rs:18854-18970`). Here, without
	// leaves, the grant-level rule is the binary's `parse_shards`
	// (`secure_fs.rs:12646-12683`): per-shard fields, worker order, and the
	// eight `subscriberCount`s summing to the grant total, plus the bound
	// every residue-class range satisfies — it starts inside the subscriber
	// run and its declared end stays within the cohort.
	let shardSubscriberTotal = 0;
	for (let worker = 0; worker < COHORT_WORKER_COUNT; worker += 1) {
		const shard = parseSubscriberShard(
			value.subscriberShards[worker],
			value.subscriberCount,
		);
		if (!shard.ok) return shard;
		if (shard.value.workerIndex !== worker || shard.value.residue !== worker) {
			return cohortFail("subscriber shards are not in worker order");
		}
		const total = checkedAdd(shardSubscriberTotal, shard.value.subscriberCount);
		if (total === null) return cohortFail("shard subscriber total overflow");
		shardSubscriberTotal = total;
		if (
			shard.value.firstTokenCommitmentIndex < value.publisherCount ||
			shard.value.lastTokenCommitmentIndexExclusive > expectedSessions
		) {
			return cohortFail("shard commitment range outside the cohort");
		}
	}
	if (shardSubscriberTotal !== value.subscriberCount) {
		return cohortFail("shard subscriber counts do not sum to subscriberCount");
	}

	// The expanded delivery expectation is the offered ingress fanned out to
	// every subscriber; a rewritten product is the classic conservation forgery.
	const expanded = checkedMul(
		value.expectedOfferedIngress,
		value.subscriberCount,
	);
	if (expanded === null) {
		return cohortFail("expanded delivery expectation overflows");
	}
	if (value.expectedExpandedDeliveries !== expanded) {
		return cohortFail(
			"expectedExpandedDeliveries is not ingress * subscribers",
		);
	}
	return { ok: true, value: value as unknown as CohortGrantV1 };
}

/**
 * The grant's publishers and shards against the leaf manifest they claim to
 * partition — the binary's `verify_presented_topology`
 * (`crates/native/src/secure_fs.rs:18854-18970`), rule for rule.
 *
 * `leaves` is the manifest's own array in its canonical order, so a leaf's
 * position is its commitment index. Publishers are the leading leaves, one
 * grant per leaf at that leaf's index (`:18885-18908`). A shard's members are
 * the subscriber leaves that name its worker (`:18915-18924`); its count,
 * ordered-ID digest, commitment range and child are recomputed from those
 * members (`:18925-18959`), and the members must sit at stride
 * `SUBSCRIBER_SHARD_MODULUS` from the first (`:18960-18967`) — which is what
 * makes `[first, first + count)` a residue class and not an interval. The
 * union is exact because every subscriber leaf names one worker in `0..7` and
 * `parseCohortGrant` already requires the eight counts to sum to the total.
 */
export function verifyPresentedCohortTopology(args: {
	readonly grant: Pick<
		CohortGrantV1,
		"publisherCount" | "subscriberCount" | "publishers" | "subscriberShards"
	>;
	readonly leaves: readonly TokenCommitmentLeafV1[];
}): ProtocolResult<true> {
	const { grant, leaves } = args;
	const publisherLeafCount = leaves.filter(
		(leaf) => leaf.role === "publisher",
	).length;
	// `secure_fs.rs:18877-18882`.
	if (
		grant.publishers.length !== publisherLeafCount ||
		grant.publishers.length !== grant.publisherCount
	) {
		return cohortFail("publisher cardinality");
	}
	if (grant.subscriberShards.length !== SUBSCRIBER_SHARD_MODULUS) {
		return cohortFail("shard cardinality");
	}
	const subscriberLeafCount = leaves.length - publisherLeafCount;
	if (subscriberLeafCount !== grant.subscriberCount) {
		return cohortFail("subscriber cardinality");
	}

	// Publishers: one per leading leaf, in leaf order (`:18885-18908`).
	const seenPublisherIds = new Set<string>();
	for (const [index, publisher] of grant.publishers.entries()) {
		const leaf = leaves[index];
		if (leaf === undefined) return cohortFail("publisher topology");
		if (seenPublisherIds.has(publisher.publisherId)) {
			return cohortFail("duplicate publisherId");
		}
		seenPublisherIds.add(publisher.publisherId);
		if (
			leaf.role !== "publisher" ||
			publisher.childId !== leaf.childId ||
			publisher.publisherId !== leaf.roleId ||
			publisher.tokenSha256 !== leaf.tokenSha256 ||
			publisher.tokenCommitmentIndex !== index
		) {
			return cohortFail("publisher topology");
		}
	}

	// Shards: membership, digest and range recomputed from the leaves that
	// name the worker (`:18909-18968`).
	for (const [worker, shard] of grant.subscriberShards.entries()) {
		const members: {
			readonly index: number;
			readonly leaf: TokenCommitmentLeafV1;
		}[] = [];
		for (let index = grant.publisherCount; index < leaves.length; index += 1) {
			const leaf = leaves[index] as TokenCommitmentLeafV1;
			if (leaf.workerIndex === worker) members.push({ index, leaf });
		}
		const head = members[0];
		if (head === undefined) return cohortFail("empty shard");
		const idsDigest = sha256HexOfBytes(
			bytesOfCanonical(members.map(({ leaf }) => leaf.roleId)),
		);
		if (
			shard.workerIndex !== worker ||
			shard.residue !== worker ||
			shard.modulus !== SUBSCRIBER_SHARD_MODULUS ||
			shard.firstSubscriberIndex !== 0 ||
			shard.lastSubscriberIndexExclusive !== grant.subscriberCount ||
			shard.subscriberCount !== members.length ||
			shard.firstTokenCommitmentIndex !== head.index ||
			shard.lastTokenCommitmentIndexExclusive !==
				subscriberShardCommitmentWindowEnd(head.index, members.length) ||
			shard.orderedSubscriberIdsSha256 !== idsDigest ||
			members.some(({ leaf }) => leaf.childId !== shard.childId)
		) {
			return cohortFail("subscriber topology");
		}
		// Contiguity at stride 8 from the first member (`:19199-19205`): the
		// window above is exactly the span of these members.
		if (
			members.some(
				({ index }, position) =>
					index !== head.index + position * SUBSCRIBER_SHARD_MODULUS,
			)
		) {
			return cohortFail("subscriber topology");
		}
	}
	return { ok: true, value: true };
}

export function cohortGrantBytes(grant: CohortGrantV1): Uint8Array {
	return bytesOfCanonical(grant);
}

export function cohortGrantSha256(grant: CohortGrantV1): Sha256Hex {
	return sha256CanonicalRecord(grant);
}

/**
 * The rig's gate: no spawn, no bind, no permit until the exact grant bytes
 * carry a valid Mac signature from the staged key, inside its validity window.
 * A missing signature, a rig-side signature, a foreign key, a mutated grant, or
 * an expired grant all stop the cohort before any Linux action occurs.
 */
export function requireCohortGrantSignatureBeforeRigAction(args: {
	readonly grant: unknown;
	readonly signature: unknown;
	readonly stagedMacPublicRaw32: Uint8Array;
	readonly nowMs: number;
}): ProtocolResult<CohortGrantV1> {
	const grant = parseCohortGrant(args.grant);
	if (!grant.ok) return grant;
	if (args.signature == null) {
		return fail(
			"MAC_GRANT_SIGNATURE_INVALID",
			"cohort grant presented to the rig without a Mac signature",
		);
	}
	const signature = parseMacReceiptSignature(args.signature);
	if (!signature.ok) {
		return fail("MAC_GRANT_SIGNATURE_INVALID", "malformed Mac signature");
	}
	if (signature.value.signedSchema !== "cohort-grant/v1") {
		return fail(
			"MAC_GRANT_SIGNATURE_INVALID",
			`signature covers ${signature.value.signedSchema}, not cohort-grant/v1`,
		);
	}
	const stagedKeySha256 = sha256HexOfBytes(args.stagedMacPublicRaw32);
	if (grant.value.signingPublicKeySha256 !== stagedKeySha256) {
		return fail(
			"MAC_SIGNING_KEY_MISMATCH",
			"grant names a key the rig did not stage",
		);
	}
	const verified = verifyMacReceiptSignature({
		stagedMacPublicRaw32: args.stagedMacPublicRaw32,
		signedBytes: cohortGrantBytes(grant.value),
		signature: signature.value,
	});
	if (!verified.ok) return verified;
	if (!isSafeNonNegInt(args.nowMs)) {
		return cohortFail("nowMs must be a nonnegative safe integer");
	}
	if (args.nowMs > grant.value.notAfterMs) {
		return fail("MAC_GRANT_EXPIRED", "cohort grant validity window closed");
	}
	return grant;
}

// ---------------------------------------------------------------------------
// Rig cohort acceptance (rig-signed)
// ---------------------------------------------------------------------------

export interface RigCohortAcceptanceV1 {
	readonly schema: "rig-cohort-acceptance/v1";
	readonly executionSha256: Sha256Hex;
	readonly cohortGrantSha256: Sha256Hex;
	readonly cohortGrantSignatureSha256: Sha256Hex;
	readonly roleTokenCommitmentRootSha256: Sha256Hex;
	readonly approvedPlanSha256: Sha256Hex;
	readonly approvalRecordSha256: Sha256Hex;
	readonly rigExecutionIndex: number;
	readonly rigSupervisorInstanceNonce: Sha256Hex;
	readonly signingPublicKeySha256: Sha256Hex;
	readonly receiptSequence: number;
	readonly acceptedAtMs: number;
	readonly issuedAtMs: number;
	readonly notAfterMs: number;
}

const RIG_COHORT_ACCEPTANCE_KEYS = [
	"acceptedAtMs",
	"approvalRecordSha256",
	"approvedPlanSha256",
	"cohortGrantSha256",
	"cohortGrantSignatureSha256",
	"executionSha256",
	"issuedAtMs",
	"notAfterMs",
	"receiptSequence",
	"rigExecutionIndex",
	"rigSupervisorInstanceNonce",
	"roleTokenCommitmentRootSha256",
	"schema",
	"signingPublicKeySha256",
].sort() as readonly string[];

export function parseRigCohortAcceptance(
	value: unknown,
): ProtocolResult<RigCohortAcceptanceV1> {
	if (!isPlainObject(value) || !exactKeys(value, RIG_COHORT_ACCEPTANCE_KEYS)) {
		return cohortFail("rig cohort acceptance keys");
	}
	if (
		value.schema !== "rig-cohort-acceptance/v1" ||
		!isHex64(value.executionSha256) ||
		!isHex64(value.cohortGrantSha256) ||
		!isHex64(value.cohortGrantSignatureSha256) ||
		!isHex64(value.roleTokenCommitmentRootSha256) ||
		!isHex64(value.approvedPlanSha256) ||
		!isHex64(value.approvalRecordSha256) ||
		!isSafeNonNegInt(value.rigExecutionIndex) ||
		!isHex64(value.rigSupervisorInstanceNonce) ||
		!isHex64(value.signingPublicKeySha256) ||
		!isSafeNonNegInt(value.receiptSequence) ||
		!isSafeNonNegInt(value.acceptedAtMs) ||
		!isSafeNonNegInt(value.issuedAtMs) ||
		!isSafeNonNegInt(value.notAfterMs)
	) {
		return cohortFail("rig cohort acceptance fields");
	}
	if (value.notAfterMs < value.issuedAtMs) {
		return fail("RIG_RECEIPT_EXPIRED", "notAfter < issued");
	}
	return { ok: true, value: value as unknown as RigCohortAcceptanceV1 };
}

// ---------------------------------------------------------------------------
// Warmup epoch and completion manifest
// ---------------------------------------------------------------------------

export interface CohortWarmupEpochV1 {
	readonly schema: "cohort-warmup-epoch/v1";
	readonly executionSha256: Sha256Hex;
	readonly cohortGrantSha256: Sha256Hex;
	readonly cohortId: string;
	readonly warmupNonce: Sha256Hex;
	readonly durationMs: 5000;
	readonly warmupMessagesPerPublisher: 10;
	readonly warmupIntervalMs: 500;
	readonly expectedWarmupIngress: number;
	readonly expectedWarmupDeliveries: number;
	readonly macSupervisorInstanceNonce: Sha256Hex;
	readonly signingPublicKeySha256: Sha256Hex;
	readonly receiptSequence: number;
	readonly issuedAtMs: number;
	readonly notAfterMs: number;
}

const COHORT_WARMUP_EPOCH_KEYS = [
	"cohortGrantSha256",
	"cohortId",
	"durationMs",
	"executionSha256",
	"expectedWarmupDeliveries",
	"expectedWarmupIngress",
	"issuedAtMs",
	"macSupervisorInstanceNonce",
	"notAfterMs",
	"receiptSequence",
	"schema",
	"signingPublicKeySha256",
	"warmupIntervalMs",
	"warmupMessagesPerPublisher",
	"warmupNonce",
].sort() as readonly string[];

/** The warmup epoch is bound to the grant nonce, never to a measured barrier. */
const COHORT_WARMUP_EPOCH_FORBIDDEN_FIELDS = [
	"barrierNonce",
	"cohortStartBarrierSha256",
	"measureStartAtMacNs",
] as const;

export function expectedWarmupIngress(publisherCount: number): number {
	const product = checkedMul(publisherCount, WARMUP_MESSAGES_PER_PUBLISHER);
	if (product === null) throw new RangeError("warmup ingress overflow");
	return product;
}

export function expectedWarmupDeliveries(
	publisherCount: number,
	subscriberCount: number,
): number {
	const product = checkedMul(
		expectedWarmupIngress(publisherCount),
		subscriberCount,
	);
	if (product === null) throw new RangeError("warmup delivery overflow");
	return product;
}

export function parseCohortWarmupEpoch(
	value: unknown,
): ProtocolResult<CohortWarmupEpochV1> {
	if (!isPlainObject(value)) return fail(WARMUP_PROTOCOL_FAILURE_CODE, "epoch");
	for (const forbidden of COHORT_WARMUP_EPOCH_FORBIDDEN_FIELDS) {
		if (hasOwn(value, forbidden)) {
			return fail(
				WARMUP_PROTOCOL_FAILURE_CODE,
				`warmup epoch must not carry ${forbidden}`,
			);
		}
	}
	if (!exactKeys(value, COHORT_WARMUP_EPOCH_KEYS)) {
		return fail(WARMUP_PROTOCOL_FAILURE_CODE, "warmup epoch exact keys");
	}
	if (
		value.schema !== "cohort-warmup-epoch/v1" ||
		!isHex64(value.executionSha256) ||
		!isHex64(value.cohortGrantSha256) ||
		!isNonEmptyString(value.cohortId) ||
		!isHex64(value.warmupNonce) ||
		value.durationMs !== WARMUP_DURATION_MS ||
		value.warmupMessagesPerPublisher !== WARMUP_MESSAGES_PER_PUBLISHER ||
		value.warmupIntervalMs !== WARMUP_INTERVAL_MS ||
		!isHex64(value.macSupervisorInstanceNonce) ||
		!isHex64(value.signingPublicKeySha256) ||
		!isSafeNonNegInt(value.receiptSequence) ||
		!isSafeNonNegInt(value.issuedAtMs) ||
		!isSafeNonNegInt(value.notAfterMs)
	) {
		return fail(WARMUP_PROTOCOL_FAILURE_CODE, "warmup epoch fields");
	}
	// Non-vacuity is a schema-level property here: a zero expectation would let
	// a cell claim a warmup it never ran.
	if (
		!isSafePosInt(value.expectedWarmupIngress) ||
		!isSafePosInt(value.expectedWarmupDeliveries)
	) {
		return fail(
			WARMUP_PROTOCOL_FAILURE_CODE,
			"warmup expectations are vacuous",
		);
	}
	if (value.expectedWarmupIngress % WARMUP_MESSAGES_PER_PUBLISHER !== 0) {
		return fail(
			WARMUP_PROTOCOL_FAILURE_CODE,
			"warmup ingress is not publisherCount * 10",
		);
	}
	if (value.expectedWarmupDeliveries % value.expectedWarmupIngress !== 0) {
		return fail(
			WARMUP_PROTOCOL_FAILURE_CODE,
			"warmup deliveries are not ingress * subscriberCount",
		);
	}
	if (value.notAfterMs < value.issuedAtMs) {
		return fail("MAC_GRANT_EXPIRED", "notAfter < issued");
	}
	const capped = withinCap(
		value,
		COHORT_WARMUP_EPOCH_MAX_BYTES,
		"warmup epoch",
	);
	if (!capped.ok) {
		return fail(WARMUP_PROTOCOL_FAILURE_CODE, capped.message ?? "epoch cap");
	}
	return { ok: true, value: value as unknown as CohortWarmupEpochV1 };
}

export interface RetainedCanonicalBytesV1 {
	readonly schema: "retained-canonical-bytes/v1";
	readonly encoding: "base64";
	readonly mediaType: "application/json";
	readonly bytesBase64: Base64;
	readonly byteLength: number;
	readonly sha256: Sha256Hex;
}

export interface RoleWarmupCompletionManifestEntryV1 {
	readonly schema: "role-warmup-completion-manifest-entry/v1";
	readonly order: number;
	readonly childId: string;
	readonly role: "publisher" | "subscriber-worker";
	readonly roleWarmupComplete: RetainedCanonicalBytesV1;
	readonly roleWarmupCompleteSha256: Sha256Hex;
	readonly offeredWarmupIngress: number;
	readonly deliveredWarmupRecords: number;
}

export interface RoleWarmupCompletionManifestV1 {
	readonly schema: "role-warmup-completion-manifest/v1";
	readonly executionSha256: Sha256Hex;
	readonly cohortGrantSha256: Sha256Hex;
	readonly cohortWarmupEpochSha256: Sha256Hex;
	readonly entryCount: number;
	readonly entries: readonly RoleWarmupCompletionManifestEntryV1[];
	readonly allRoleChildrenComplete: true;
	readonly completedAtMacNs: NsString;
	readonly macSupervisorInstanceNonce: Sha256Hex;
	readonly signingPublicKeySha256: Sha256Hex;
	readonly receiptSequence: number;
	readonly issuedAtMs: number;
	readonly notAfterMs: number;
}

const RETAINED_CANONICAL_BYTES_KEYS = [
	"byteLength",
	"bytesBase64",
	"encoding",
	"mediaType",
	"schema",
	"sha256",
] as const;

const ROLE_WARMUP_ENTRY_KEYS = [
	"childId",
	"deliveredWarmupRecords",
	"offeredWarmupIngress",
	"order",
	"role",
	"roleWarmupComplete",
	"roleWarmupCompleteSha256",
	"schema",
] as const;

const ROLE_WARMUP_MANIFEST_KEYS = [
	"allRoleChildrenComplete",
	"cohortGrantSha256",
	"cohortWarmupEpochSha256",
	"completedAtMacNs",
	"entries",
	"entryCount",
	"executionSha256",
	"issuedAtMs",
	"macSupervisorInstanceNonce",
	"notAfterMs",
	"receiptSequence",
	"schema",
	"signingPublicKeySha256",
].sort() as readonly string[];

function parseRetainedCanonicalBytes(
	value: unknown,
	encodedCap: number = ROLE_WARMUP_COMPLETION_MANIFEST_MAX_BYTES,
): ProtocolResult<RetainedCanonicalBytesV1> {
	if (
		!isPlainObject(value) ||
		!exactKeys(value, RETAINED_CANONICAL_BYTES_KEYS)
	) {
		return cohortFail("retained canonical bytes keys");
	}
	if (
		value.schema !== "retained-canonical-bytes/v1" ||
		value.encoding !== "base64" ||
		value.mediaType !== "application/json" ||
		typeof value.bytesBase64 !== "string" ||
		!isSafePosInt(value.byteLength) ||
		!isHex64(value.sha256)
	) {
		return cohortFail("retained canonical bytes fields");
	}
	// Cap the encoded length before decoding, then require the decoded size to
	// equal the declared size exactly.
	if (value.bytesBase64.length > encodedCap) {
		return cohortFail("retained canonical bytes encoded length exceeds cap");
	}
	const bytes = fromBase64(value.bytesBase64);
	if (bytes === null) return cohortFail("retained canonical bytes base64");
	if (bytes.byteLength !== value.byteLength) {
		return cohortFail("retained canonical bytes size mismatch");
	}
	if (sha256HexOfBytes(bytes) !== value.sha256) {
		return cohortFail("retained canonical bytes digest mismatch");
	}
	return { ok: true, value: value as unknown as RetainedCanonicalBytesV1 };
}

export function parseRoleWarmupCompletionManifestEntry(
	value: unknown,
): ProtocolResult<RoleWarmupCompletionManifestEntryV1> {
	if (!isPlainObject(value) || !exactKeys(value, ROLE_WARMUP_ENTRY_KEYS)) {
		return fail(WARMUP_PROTOCOL_FAILURE_CODE, "warmup completion entry keys");
	}
	if (
		value.schema !== "role-warmup-completion-manifest-entry/v1" ||
		!isSafeNonNegInt(value.order) ||
		!isNonEmptyString(value.childId) ||
		(value.role !== "publisher" && value.role !== "subscriber-worker") ||
		!isHex64(value.roleWarmupCompleteSha256) ||
		!isSafeNonNegInt(value.offeredWarmupIngress) ||
		!isSafeNonNegInt(value.deliveredWarmupRecords)
	) {
		return fail(WARMUP_PROTOCOL_FAILURE_CODE, "warmup completion entry fields");
	}
	const retained = parseRetainedCanonicalBytes(value.roleWarmupComplete);
	if (!retained.ok) {
		return fail(
			WARMUP_PROTOCOL_FAILURE_CODE,
			retained.message ?? "retained warmup completion",
		);
	}
	if (retained.value.sha256 !== value.roleWarmupCompleteSha256) {
		return fail(
			WARMUP_PROTOCOL_FAILURE_CODE,
			"roleWarmupCompleteSha256 does not match the retained bytes",
		);
	}
	// A publisher offers and never receives; a worker receives and never offers.
	if (value.role === "publisher" && value.deliveredWarmupRecords !== 0) {
		return fail(
			WARMUP_PROTOCOL_FAILURE_CODE,
			"publisher completion claims delivered warmup records",
		);
	}
	if (value.role === "subscriber-worker" && value.offeredWarmupIngress !== 0) {
		return fail(
			WARMUP_PROTOCOL_FAILURE_CODE,
			"worker completion claims offered warmup ingress",
		);
	}
	return {
		ok: true,
		value: value as unknown as RoleWarmupCompletionManifestEntryV1,
	};
}

export function parseRoleWarmupCompletionManifest(
	value: unknown,
): ProtocolResult<RoleWarmupCompletionManifestV1> {
	if (!isPlainObject(value) || !exactKeys(value, ROLE_WARMUP_MANIFEST_KEYS)) {
		return fail(WARMUP_PROTOCOL_FAILURE_CODE, "warmup manifest keys");
	}
	if (
		value.schema !== "role-warmup-completion-manifest/v1" ||
		!isHex64(value.executionSha256) ||
		!isHex64(value.cohortGrantSha256) ||
		!isHex64(value.cohortWarmupEpochSha256) ||
		!isSafePosInt(value.entryCount) ||
		!Array.isArray(value.entries) ||
		value.allRoleChildrenComplete !== true ||
		!isNsString(value.completedAtMacNs) ||
		!isHex64(value.macSupervisorInstanceNonce) ||
		!isHex64(value.signingPublicKeySha256) ||
		!isSafeNonNegInt(value.receiptSequence) ||
		!isSafeNonNegInt(value.issuedAtMs) ||
		!isSafeNonNegInt(value.notAfterMs)
	) {
		return fail(WARMUP_PROTOCOL_FAILURE_CODE, "warmup manifest fields");
	}
	if (value.entries.length !== value.entryCount) {
		return fail(
			WARMUP_PROTOCOL_FAILURE_CODE,
			"entryCount cardinality mismatch",
		);
	}
	const capped = withinCap(
		value,
		ROLE_WARMUP_COMPLETION_MANIFEST_MAX_BYTES,
		"warmup manifest",
	);
	if (!capped.ok) {
		return fail(WARMUP_PROTOCOL_FAILURE_CODE, capped.message ?? "manifest cap");
	}
	const seenChildIds = new Set<string>();
	for (let index = 0; index < value.entries.length; index += 1) {
		const entry = parseRoleWarmupCompletionManifestEntry(value.entries[index]);
		if (!entry.ok) return entry;
		// Order is the manifest's own index: a missing or duplicated completion
		// shows up here rather than as a silently shorter array.
		if (entry.value.order !== index) {
			return fail(
				WARMUP_PROTOCOL_FAILURE_CODE,
				`entry order ${entry.value.order} is not manifest position ${index}`,
			);
		}
		if (seenChildIds.has(entry.value.childId)) {
			return fail(
				WARMUP_PROTOCOL_FAILURE_CODE,
				`duplicate warmup completion for ${entry.value.childId}`,
			);
		}
		seenChildIds.add(entry.value.childId);
	}
	if (value.notAfterMs < value.issuedAtMs) {
		return fail("MAC_GRANT_EXPIRED", "notAfter < issued");
	}
	return {
		ok: true,
		value: value as unknown as RoleWarmupCompletionManifestV1,
	};
}

/**
 * The manifest is checked against the signed epoch, not against itself: every
 * publisher offered exactly ten, every worker received exactly its shard's
 * expansion, and the ordered sums equal the epoch's expectations.
 */
export function validateRoleWarmupCompletionManifest(args: {
	readonly manifest: unknown;
	readonly epoch: unknown;
	readonly publisherCount: number;
	readonly subscriberCount: number;
	readonly shardSubscriberCounts: readonly number[];
}): ProtocolResult<true> {
	const manifest = parseRoleWarmupCompletionManifest(args.manifest);
	if (!manifest.ok) {
		return fail(WARMUP_PROTOCOL_FAILURE_CODE, manifest.message ?? "manifest");
	}
	const epoch = parseCohortWarmupEpoch(args.epoch);
	if (!epoch.ok) {
		return fail(WARMUP_PROTOCOL_FAILURE_CODE, epoch.message ?? "epoch");
	}
	if (
		manifest.value.cohortWarmupEpochSha256 !==
		sha256CanonicalRecord(epoch.value)
	) {
		return fail(
			WARMUP_PROTOCOL_FAILURE_CODE,
			"manifest is bound to a different warmup epoch",
		);
	}
	if (
		!isSafePosInt(args.publisherCount) ||
		!isSafePosInt(args.subscriberCount) ||
		args.shardSubscriberCounts.length !== COHORT_WORKER_COUNT
	) {
		return fail(WARMUP_PROTOCOL_FAILURE_CODE, "cohort cardinality arguments");
	}
	if (
		epoch.value.expectedWarmupIngress !==
			expectedWarmupIngress(args.publisherCount) ||
		epoch.value.expectedWarmupDeliveries !==
			expectedWarmupDeliveries(args.publisherCount, args.subscriberCount)
	) {
		return fail(
			WARMUP_PROTOCOL_FAILURE_CODE,
			"epoch expectations do not match the cohort cardinality",
		);
	}
	const expectedEntries = checkedAdd(args.publisherCount, COHORT_WORKER_COUNT);
	if (
		expectedEntries === null ||
		manifest.value.entryCount !== expectedEntries
	) {
		return fail(
			WARMUP_PROTOCOL_FAILURE_CODE,
			"manifest does not carry one completion per role child",
		);
	}
	let offeredTotal = 0;
	let deliveredTotal = 0;
	for (let index = 0; index < manifest.value.entries.length; index += 1) {
		const entry = manifest.value.entries[
			index
		] as RoleWarmupCompletionManifestEntryV1;
		if (index < args.publisherCount) {
			if (entry.role !== "publisher") {
				return fail(
					WARMUP_PROTOCOL_FAILURE_CODE,
					"publisher entries must lead",
				);
			}
			if (entry.offeredWarmupIngress !== WARMUP_MESSAGES_PER_PUBLISHER) {
				return fail(
					WARMUP_PROTOCOL_FAILURE_CODE,
					`publisher ${entry.childId} offered ${entry.offeredWarmupIngress}, not ${WARMUP_MESSAGES_PER_PUBLISHER}`,
				);
			}
		} else {
			const worker = index - args.publisherCount;
			if (entry.role !== "subscriber-worker") {
				return fail(WARMUP_PROTOCOL_FAILURE_CODE, "worker entries must trail");
			}
			const shardSubscribers = args.shardSubscriberCounts[worker] as number;
			const expected = checkedMul(
				shardSubscribers,
				expectedWarmupIngress(args.publisherCount),
			);
			if (expected === null) {
				return fail(WARMUP_PROTOCOL_FAILURE_CODE, "shard expansion overflow");
			}
			if (entry.deliveredWarmupRecords !== expected) {
				return fail(
					WARMUP_PROTOCOL_FAILURE_CODE,
					`worker ${worker} delivered ${entry.deliveredWarmupRecords}, not ${expected}`,
				);
			}
		}
		const nextOffered = checkedAdd(offeredTotal, entry.offeredWarmupIngress);
		const nextDelivered = checkedAdd(
			deliveredTotal,
			entry.deliveredWarmupRecords,
		);
		if (nextOffered === null || nextDelivered === null) {
			return fail(WARMUP_PROTOCOL_FAILURE_CODE, "warmup sum overflow");
		}
		offeredTotal = nextOffered;
		deliveredTotal = nextDelivered;
	}
	if (offeredTotal !== epoch.value.expectedWarmupIngress) {
		return fail(
			WARMUP_PROTOCOL_FAILURE_CODE,
			"offered warmup sum does not equal the epoch expectation",
		);
	}
	if (deliveredTotal !== epoch.value.expectedWarmupDeliveries) {
		return fail(
			WARMUP_PROTOCOL_FAILURE_CODE,
			"delivered warmup sum does not equal the epoch expectation",
		);
	}
	return { ok: true, value: true };
}

// ---------------------------------------------------------------------------
// Rig warmup drained receipt (rig-signed)
// ---------------------------------------------------------------------------

export interface RigWarmupDrainedReceiptV1 {
	readonly schema: "rig-warmup-drained-receipt/v1";
	readonly executionSha256: Sha256Hex;
	readonly cohortGrantSha256: Sha256Hex;
	readonly cohortWarmupEpochSha256: Sha256Hex;
	readonly cohortWarmupEpochSignatureSha256: Sha256Hex;
	readonly roleWarmupCompletionManifestSha256: Sha256Hex;
	readonly roleWarmupCompletionManifestSignatureSha256: Sha256Hex;
	readonly serverWarmupDrainedSha256: Sha256Hex;
	readonly rigSupervisorInstanceNonce: Sha256Hex;
	readonly signingPublicKeySha256: Sha256Hex;
	readonly receiptSequence: number;
	readonly receivedAtRigNs: NsString;
	readonly linuxClockId: string;
	readonly issuedAtMs: number;
	readonly notAfterMs: number;
}

const RIG_WARMUP_DRAINED_KEYS = [
	"cohortGrantSha256",
	"cohortWarmupEpochSha256",
	"cohortWarmupEpochSignatureSha256",
	"executionSha256",
	"issuedAtMs",
	"linuxClockId",
	"notAfterMs",
	"receiptSequence",
	"receivedAtRigNs",
	"rigSupervisorInstanceNonce",
	"roleWarmupCompletionManifestSha256",
	"roleWarmupCompletionManifestSignatureSha256",
	"schema",
	"serverWarmupDrainedSha256",
	"signingPublicKeySha256",
].sort() as readonly string[];

export function parseRigWarmupDrainedReceipt(
	value: unknown,
): ProtocolResult<RigWarmupDrainedReceiptV1> {
	if (!isPlainObject(value) || !exactKeys(value, RIG_WARMUP_DRAINED_KEYS)) {
		return cohortFail("rig warmup drained receipt keys");
	}
	if (
		value.schema !== "rig-warmup-drained-receipt/v1" ||
		!isHex64(value.executionSha256) ||
		!isHex64(value.cohortGrantSha256) ||
		!isHex64(value.cohortWarmupEpochSha256) ||
		!isHex64(value.cohortWarmupEpochSignatureSha256) ||
		!isHex64(value.roleWarmupCompletionManifestSha256) ||
		!isHex64(value.roleWarmupCompletionManifestSignatureSha256) ||
		!isHex64(value.serverWarmupDrainedSha256) ||
		!isHex64(value.rigSupervisorInstanceNonce) ||
		!isHex64(value.signingPublicKeySha256) ||
		!isSafeNonNegInt(value.receiptSequence) ||
		!isNsString(value.receivedAtRigNs) ||
		!isNonEmptyString(value.linuxClockId) ||
		!isSafeNonNegInt(value.issuedAtMs) ||
		!isSafeNonNegInt(value.notAfterMs)
	) {
		return cohortFail("rig warmup drained receipt fields");
	}
	if (value.notAfterMs < value.issuedAtMs) {
		return fail("RIG_RECEIPT_EXPIRED", "notAfter < issued");
	}
	return { ok: true, value: value as unknown as RigWarmupDrainedReceiptV1 };
}

// ---------------------------------------------------------------------------
// Post-readiness start barrier (Mac-signed) and rig barrier acceptance
// ---------------------------------------------------------------------------

export interface CohortStartBarrierV1 {
	readonly schema: "cohort-start-barrier/v1";
	readonly executionSha256: Sha256Hex;
	readonly cohortGrantSha256: Sha256Hex;
	readonly rigCohortAcceptanceSha256: Sha256Hex;
	readonly rigMeasureStartAckSha256: Sha256Hex;
	readonly roleWarmupCompletionManifestSha256: Sha256Hex;
	readonly roleWarmupCompletionManifestSignatureSha256: Sha256Hex;
	readonly rigWarmupDrainedReceiptSha256: Sha256Hex;
	readonly cohortId: string;
	readonly barrierNonce: Sha256Hex;
	readonly macClockId: string;
	readonly mintedAtMacNs: NsString;
	readonly warmupStartedAtMacNs: NsString;
	readonly warmupCompletedAtMacNs: NsString;
	readonly measureStartAtMacNs: NsString;
	readonly measureStopAtMacNs: NsString;
	readonly sampleWindowMs: 1000;
	readonly windowCount: 10 | 30;
	readonly measuredDurationMs: 10000 | 30000;
	readonly drainDeadlineMs: 10000;
	readonly macSupervisorInstanceNonce: Sha256Hex;
	readonly signingPublicKeySha256: Sha256Hex;
	readonly receiptSequence: number;
	readonly issuedAtMs: number;
	readonly notAfterMs: number;
}

const COHORT_START_BARRIER_KEYS = [
	"barrierNonce",
	"cohortGrantSha256",
	"cohortId",
	"drainDeadlineMs",
	"executionSha256",
	"issuedAtMs",
	"macClockId",
	"macSupervisorInstanceNonce",
	"measureStartAtMacNs",
	"measureStopAtMacNs",
	"measuredDurationMs",
	"mintedAtMacNs",
	"notAfterMs",
	"receiptSequence",
	"rigCohortAcceptanceSha256",
	"rigMeasureStartAckSha256",
	"rigWarmupDrainedReceiptSha256",
	"roleWarmupCompletionManifestSha256",
	"roleWarmupCompletionManifestSignatureSha256",
	"sampleWindowMs",
	"schema",
	"signingPublicKeySha256",
	"warmupCompletedAtMacNs",
	"warmupStartedAtMacNs",
	"windowCount",
].sort() as readonly string[];

const NS_PER_MS = 1_000_000n;

export function parseCohortStartBarrier(
	value: unknown,
): ProtocolResult<CohortStartBarrierV1> {
	if (!isPlainObject(value) || !exactKeys(value, COHORT_START_BARRIER_KEYS)) {
		return cohortFail("cohort start barrier keys");
	}
	if (
		value.schema !== "cohort-start-barrier/v1" ||
		!isHex64(value.executionSha256) ||
		!isHex64(value.cohortGrantSha256) ||
		!isHex64(value.rigCohortAcceptanceSha256) ||
		!isHex64(value.rigMeasureStartAckSha256) ||
		!isHex64(value.roleWarmupCompletionManifestSha256) ||
		!isHex64(value.roleWarmupCompletionManifestSignatureSha256) ||
		!isHex64(value.rigWarmupDrainedReceiptSha256) ||
		!isNonEmptyString(value.cohortId) ||
		!isHex64(value.barrierNonce) ||
		!isNonEmptyString(value.macClockId) ||
		!isNsString(value.mintedAtMacNs) ||
		!isNsString(value.warmupStartedAtMacNs) ||
		!isNsString(value.warmupCompletedAtMacNs) ||
		!isNsString(value.measureStartAtMacNs) ||
		!isNsString(value.measureStopAtMacNs) ||
		value.sampleWindowMs !== COHORT_SAMPLE_WINDOW_MS ||
		!isOneOf(value.windowCount, COHORT_WINDOW_COUNT_VALUES) ||
		!isOneOf(value.measuredDurationMs, COHORT_MEASURED_DURATION_MS_VALUES) ||
		value.drainDeadlineMs !== COHORT_DRAIN_DEADLINE_MS ||
		!isHex64(value.macSupervisorInstanceNonce) ||
		!isHex64(value.signingPublicKeySha256) ||
		!isSafeNonNegInt(value.receiptSequence) ||
		!isSafeNonNegInt(value.issuedAtMs) ||
		!isSafeNonNegInt(value.notAfterMs)
	) {
		return cohortFail("cohort start barrier fields");
	}
	const windowSpan = checkedMul(value.windowCount, value.sampleWindowMs);
	if (windowSpan === null || windowSpan !== value.measuredDurationMs) {
		return cohortFail(
			"windowCount * sampleWindowMs does not equal measuredDurationMs",
		);
	}
	// All five timestamps come from one Mac clock, so they are orderable. The
	// barrier is minted after warmup completes: the binary refuses to mint
	// while `now < warmupCompleted` (`secure_fs.rs:21160`) and publishes
	// `mintedAtMacNs = now` (`:21188`), so its parser requires
	// warmupStarted <= warmupCompleted <= minted <= measureStart
	// (`:12788-12796`), and the measured span must be exactly the declared
	// duration (`:12808-12813`).
	const minted = ns(value.mintedAtMacNs);
	const warmupStarted = ns(value.warmupStartedAtMacNs);
	const warmupCompleted = ns(value.warmupCompletedAtMacNs);
	const measureStart = ns(value.measureStartAtMacNs);
	const measureStop = ns(value.measureStopAtMacNs);
	if (
		warmupStarted > warmupCompleted ||
		minted < warmupCompleted ||
		measureStart < minted ||
		measureStart >= measureStop
	) {
		return cohortFail("cohort start barrier timestamps are not ordered");
	}
	if (
		measureStop - measureStart !==
		BigInt(value.measuredDurationMs) * NS_PER_MS
	) {
		return cohortFail("measured span does not equal measuredDurationMs");
	}
	if (value.notAfterMs < value.issuedAtMs) {
		return fail("MAC_GRANT_EXPIRED", "notAfter < issued");
	}
	return { ok: true, value: value as unknown as CohortStartBarrierV1 };
}

/**
 * The barrier may only be minted after the rig accepted the cohort, the
 * authenticated Linux measure-start ack fixed the baseline, the exact role
 * warmup manifest was retained, and the Linux drained/reset receipt arrived.
 * Presenting a barrier bound to any other digest is `FAIL/COHORT_NOT_READY`.
 */
export function validateCohortStartBarrierPreconditions(args: {
	readonly barrier: unknown;
	readonly rigCohortAcceptanceSha256: Sha256Hex;
	readonly rigMeasureStartAckSha256: Sha256Hex;
	readonly roleWarmupCompletionManifestSha256: Sha256Hex;
	readonly rigWarmupDrainedReceiptSha256: Sha256Hex;
}): ProtocolResult<true> {
	const barrier = parseCohortStartBarrier(args.barrier);
	if (!barrier.ok) {
		return fail(
			COHORT_NOT_READY_FAILURE_CODE,
			barrier.message ?? "cohort start barrier",
		);
	}
	const bindings: readonly (readonly [string, Sha256Hex, Sha256Hex])[] = [
		[
			"rigCohortAcceptanceSha256",
			barrier.value.rigCohortAcceptanceSha256,
			args.rigCohortAcceptanceSha256,
		],
		[
			"rigMeasureStartAckSha256",
			barrier.value.rigMeasureStartAckSha256,
			args.rigMeasureStartAckSha256,
		],
		[
			"roleWarmupCompletionManifestSha256",
			barrier.value.roleWarmupCompletionManifestSha256,
			args.roleWarmupCompletionManifestSha256,
		],
		[
			"rigWarmupDrainedReceiptSha256",
			barrier.value.rigWarmupDrainedReceiptSha256,
			args.rigWarmupDrainedReceiptSha256,
		],
	];
	for (const [label, declared, observed] of bindings) {
		if (!isHex64(observed)) {
			return fail(COHORT_NOT_READY_FAILURE_CODE, `${label} not retained`);
		}
		if (declared !== observed) {
			return fail(
				COHORT_NOT_READY_FAILURE_CODE,
				`${label} does not match the retained record`,
			);
		}
	}
	return { ok: true, value: true };
}

export interface RigBarrierAcceptanceV1 {
	readonly schema: "rig-barrier-acceptance/v1";
	readonly executionSha256: Sha256Hex;
	readonly cohortGrantSha256: Sha256Hex;
	readonly cohortStartBarrierSha256: Sha256Hex;
	readonly cohortStartBarrierSignatureSha256: Sha256Hex;
	readonly rigMeasureStartAckSha256: Sha256Hex;
	readonly serverStartBarrierAcceptedSha256: Sha256Hex;
	readonly rigSupervisorInstanceNonce: Sha256Hex;
	readonly signingPublicKeySha256: Sha256Hex;
	readonly receiptSequence: number;
	readonly acceptedAtLinuxNs: NsString;
	readonly linuxClockId: string;
	readonly issuedAtMs: number;
	readonly notAfterMs: number;
}

const RIG_BARRIER_ACCEPTANCE_KEYS = [
	"acceptedAtLinuxNs",
	"cohortGrantSha256",
	"cohortStartBarrierSha256",
	"cohortStartBarrierSignatureSha256",
	"executionSha256",
	"issuedAtMs",
	"linuxClockId",
	"notAfterMs",
	"receiptSequence",
	"rigMeasureStartAckSha256",
	"rigSupervisorInstanceNonce",
	"schema",
	"serverStartBarrierAcceptedSha256",
	"signingPublicKeySha256",
].sort() as readonly string[];

export function parseRigBarrierAcceptance(
	value: unknown,
): ProtocolResult<RigBarrierAcceptanceV1> {
	if (!isPlainObject(value) || !exactKeys(value, RIG_BARRIER_ACCEPTANCE_KEYS)) {
		return cohortFail("rig barrier acceptance keys");
	}
	if (
		value.schema !== "rig-barrier-acceptance/v1" ||
		!isHex64(value.executionSha256) ||
		!isHex64(value.cohortGrantSha256) ||
		!isHex64(value.cohortStartBarrierSha256) ||
		!isHex64(value.cohortStartBarrierSignatureSha256) ||
		!isHex64(value.rigMeasureStartAckSha256) ||
		!isHex64(value.serverStartBarrierAcceptedSha256) ||
		!isHex64(value.rigSupervisorInstanceNonce) ||
		!isHex64(value.signingPublicKeySha256) ||
		!isSafeNonNegInt(value.receiptSequence) ||
		!isNsString(value.acceptedAtLinuxNs) ||
		!isNonEmptyString(value.linuxClockId) ||
		!isSafeNonNegInt(value.issuedAtMs) ||
		!isSafeNonNegInt(value.notAfterMs)
	) {
		return cohortFail("rig barrier acceptance fields");
	}
	if (value.notAfterMs < value.issuedAtMs) {
		return fail("RIG_RECEIPT_EXPIRED", "notAfter < issued");
	}
	return { ok: true, value: value as unknown as RigBarrierAcceptanceV1 };
}

// ---------------------------------------------------------------------------
// Token bundle: canonical content, size accounting, and inherited-FD metadata
// ---------------------------------------------------------------------------

export interface TokenBundleEntryV1 {
	readonly schema: "token-bundle-entry/v1";
	readonly role: "publisher" | "subscriber";
	readonly roleId: string;
	readonly workerIndex: number | null;
	readonly tokenBase64: Base64;
	readonly tokenSha256: Sha256Hex;
	readonly tokenCommitmentIndex: number;
	readonly tokenMerkleProofSha256: readonly Sha256Hex[];
}

export interface TokenBundleV1 {
	readonly schema: "token-bundle/v1";
	readonly executionSha256: Sha256Hex;
	readonly cohortGrantSha256: Sha256Hex;
	readonly childId: string;
	readonly entryCount: number;
	readonly entries: readonly TokenBundleEntryV1[];
}

const TOKEN_BUNDLE_ENTRY_KEYS = [
	"role",
	"roleId",
	"schema",
	"tokenBase64",
	"tokenCommitmentIndex",
	"tokenMerkleProofSha256",
	"tokenSha256",
	"workerIndex",
] as const;

const TOKEN_BUNDLE_KEYS = [
	"childId",
	"cohortGrantSha256",
	"entries",
	"entryCount",
	"executionSha256",
	"schema",
] as const;

/** 32 random bytes, base64 with padding, is exactly 44 characters. */
export const TOKEN_RAW_BYTES = 32;
export const TOKEN_BASE64_LENGTH = 44;

export function parseTokenBundleEntry(
	value: unknown,
): ProtocolResult<TokenBundleEntryV1> {
	if (!isPlainObject(value) || !exactKeys(value, TOKEN_BUNDLE_ENTRY_KEYS)) {
		return cohortFail("token bundle entry keys");
	}
	if (
		value.schema !== "token-bundle-entry/v1" ||
		(value.role !== "publisher" && value.role !== "subscriber") ||
		!isNonEmptyString(value.roleId) ||
		!ROLE_ID_RE.test(value.roleId) ||
		!value.roleId.startsWith(`${value.role}-`) ||
		typeof value.tokenBase64 !== "string" ||
		!isHex64(value.tokenSha256) ||
		!isSafeNonNegInt(value.tokenCommitmentIndex) ||
		!Array.isArray(value.tokenMerkleProofSha256)
	) {
		return cohortFail("token bundle entry fields");
	}
	if (value.role === "publisher") {
		if (value.workerIndex !== null) {
			return cohortFail("publisher entry must carry null workerIndex");
		}
	} else if (
		!isSafeNonNegInt(value.workerIndex) ||
		value.workerIndex >= COHORT_WORKER_COUNT
	) {
		return cohortFail("subscriber entry workerIndex");
	}
	// Check the encoded length before decoding, then require exactly 32 bytes.
	if (value.tokenBase64.length !== TOKEN_BASE64_LENGTH) {
		return cohortFail("token base64 length");
	}
	const token = fromBase64(value.tokenBase64);
	if (token === null || token.byteLength !== TOKEN_RAW_BYTES) {
		return cohortFail("token does not decode to 32 raw bytes");
	}
	if (sha256HexOfBytes(token) !== value.tokenSha256) {
		return cohortFail("tokenSha256 does not commit to the carried token");
	}
	if (
		value.tokenMerkleProofSha256.length === 0 ||
		value.tokenMerkleProofSha256.length > TOKEN_MERKLE_MAX_PROOF_LENGTH
	) {
		return cohortFail("token merkle proof length out of range");
	}
	for (const sibling of value.tokenMerkleProofSha256) {
		if (!isHex64(sibling)) return cohortFail("token merkle sibling not hex64");
	}
	return { ok: true, value: value as unknown as TokenBundleEntryV1 };
}

export function parseTokenBundle(
	value: unknown,
): ProtocolResult<TokenBundleV1> {
	if (!isPlainObject(value) || !exactKeys(value, TOKEN_BUNDLE_KEYS)) {
		return cohortFail("token bundle keys");
	}
	if (
		value.schema !== "token-bundle/v1" ||
		!isHex64(value.executionSha256) ||
		!isHex64(value.cohortGrantSha256) ||
		!isNonEmptyString(value.childId) ||
		!isSafePosInt(value.entryCount) ||
		!Array.isArray(value.entries)
	) {
		return cohortFail("token bundle fields");
	}
	if (value.entries.length !== value.entryCount) {
		return cohortFail("entryCount cardinality mismatch");
	}
	// Frozen worst-case accounting: the entry count alone must fit under the cap
	// before any bytes are allocated.
	const worstCase = tokenBundleWorstCaseBytes(value.entryCount);
	if (!worstCase.ok) return worstCase;

	const seenRoleIds = new Set<string>();
	const seenIndices = new Set<number>();
	const seenTokens = new Set<string>();
	for (const candidate of value.entries) {
		const entry = parseTokenBundleEntry(candidate);
		if (!entry.ok) return entry;
		if (seenRoleIds.has(entry.value.roleId)) {
			return cohortFail("duplicate bundle roleId");
		}
		if (seenIndices.has(entry.value.tokenCommitmentIndex)) {
			return cohortFail("duplicate bundle tokenCommitmentIndex");
		}
		if (seenTokens.has(entry.value.tokenSha256)) {
			return cohortFail("duplicate bundle tokenSha256");
		}
		seenRoleIds.add(entry.value.roleId);
		seenIndices.add(entry.value.tokenCommitmentIndex);
		seenTokens.add(entry.value.tokenSha256);
	}
	const bytes = bytesOfCanonical(value);
	if (bytes.byteLength > TOKEN_BUNDLE_MAX_SIZE) {
		return cohortFail(
			`token bundle ${bytes.byteLength} exceeds cap ${TOKEN_BUNDLE_MAX_SIZE}`,
		);
	}
	return { ok: true, value: value as unknown as TokenBundleV1 };
}

/** `entryCount * 1536 + 4096`, refused if it overflows or exceeds the cap. */
export function tokenBundleWorstCaseBytes(
	entryCount: number,
): ProtocolResult<number> {
	if (!isSafePosInt(entryCount)) {
		return cohortFail("entryCount must be a positive safe integer");
	}
	const entryBytes = checkedMul(entryCount, TOKEN_BUNDLE_MAX_ENTRY_BYTES);
	if (entryBytes === null) return cohortFail("token bundle size overflow");
	const total = checkedAdd(entryBytes, TOKEN_BUNDLE_ENVELOPE_BYTES);
	if (total === null) return cohortFail("token bundle size overflow");
	if (total > TOKEN_BUNDLE_MAX_SIZE) {
		return cohortFail(
			`worst-case token bundle ${total} exceeds cap ${TOKEN_BUNDLE_MAX_SIZE}`,
		);
	}
	return { ok: true, value: total };
}

/** Byte-level cap check, applied before allocation, write, and read. */
export function validateTokenBundleBytes(
	bytes: Uint8Array,
): ProtocolResult<{ readonly byteLength: number }> {
	if (bytes.byteLength === 0) {
		return cohortFail("token bundle is empty");
	}
	if (bytes.byteLength > TOKEN_BUNDLE_MAX_SIZE) {
		return cohortFail(
			`token bundle ${bytes.byteLength} exceeds cap ${TOKEN_BUNDLE_MAX_SIZE}`,
		);
	}
	return { ok: true, value: { byteLength: bytes.byteLength } };
}

export type TokenBundleFileKind =
	| "regular"
	| "directory"
	| "fifo"
	| "socket"
	| "symlink"
	| "character-device"
	| "block-device";

export type TokenBundleAccessMode = "read-only" | "write-only" | "read-write";

export interface TokenBundleFdObservationV1 {
	readonly schema: "token-bundle-fd-observation/v1";
	readonly fd: 5;
	readonly fileKind: TokenBundleFileKind;
	readonly accessMode: TokenBundleAccessMode;
	readonly appendMode: boolean;
	readonly hardLinkCount: number;
	readonly deviceId: string;
	readonly inode: string;
	readonly byteSize: number;
	readonly contentSha256: Sha256Hex;
}

const TOKEN_BUNDLE_FD_OBSERVATION_KEYS = [
	"accessMode",
	"appendMode",
	"byteSize",
	"contentSha256",
	"deviceId",
	"fd",
	"fileKind",
	"hardLinkCount",
	"inode",
	"schema",
] as const;

const TOKEN_BUNDLE_FILE_KINDS: readonly TokenBundleFileKind[] = [
	"regular",
	"directory",
	"fifo",
	"socket",
	"symlink",
	"character-device",
	"block-device",
];

const TOKEN_BUNDLE_ACCESS_MODES: readonly TokenBundleAccessMode[] = [
	"read-only",
	"write-only",
	"read-write",
];

export function parseTokenBundleFdObservation(
	value: unknown,
): ProtocolResult<TokenBundleFdObservationV1> {
	if (
		!isPlainObject(value) ||
		!exactKeys(value, TOKEN_BUNDLE_FD_OBSERVATION_KEYS)
	) {
		return cohortFail("token bundle fd observation keys");
	}
	if (
		value.schema !== "token-bundle-fd-observation/v1" ||
		!isSafeNonNegInt(value.fd) ||
		!isOneOf(value.fileKind, TOKEN_BUNDLE_FILE_KINDS) ||
		!isOneOf(value.accessMode, TOKEN_BUNDLE_ACCESS_MODES) ||
		typeof value.appendMode !== "boolean" ||
		!isSafeNonNegInt(value.hardLinkCount) ||
		!isNsString(value.deviceId) ||
		!isNsString(value.inode) ||
		!isSafeNonNegInt(value.byteSize) ||
		!isHex64(value.contentSha256)
	) {
		return cohortFail("token bundle fd observation fields");
	}
	return { ok: true, value: value as unknown as TokenBundleFdObservationV1 };
}

/**
 * The FD-5 contract from §4.3, checked as metadata rather than by touching a
 * descriptor: the inherited FD must be a regular, read-only, already-unlinked
 * file whose size and digest equal the supervisor's retained commitment, and
 * whose identity and content are byte-identical at spawn and at read.
 *
 * Each rejected shape is a distinct forgery: a writable FD lets the child mint
 * its own tokens, a path-backed FD lets a third party open the same file by
 * name, and a changed identity or digest between spawn and read is FD reuse or
 * post-spawn mutation.
 */
export function validateTokenBundleFdMetadata(args: {
	readonly atSpawn: unknown;
	readonly atRead: unknown;
	readonly expectedSha256: Sha256Hex;
	readonly expectedSize: number;
}): ProtocolResult<true> {
	const atSpawn = parseTokenBundleFdObservation(args.atSpawn);
	if (!atSpawn.ok) return atSpawn;
	const atRead = parseTokenBundleFdObservation(args.atRead);
	if (!atRead.ok) return atRead;
	if (!isHex64(args.expectedSha256) || !isSafePosInt(args.expectedSize)) {
		return cohortFail("token bundle fd expectation is not a real commitment");
	}
	for (const observation of [atSpawn.value, atRead.value]) {
		if (observation.fd !== TOKEN_BUNDLE_FD) {
			return cohortFail(
				`unexpected descriptor ${observation.fd}; tokens arrive only on FD ${TOKEN_BUNDLE_FD}`,
			);
		}
		if (observation.fileKind !== "regular") {
			return cohortFail(
				`token bundle fd is ${observation.fileKind}, not a regular file`,
			);
		}
		if (observation.accessMode !== "read-only" || observation.appendMode) {
			return cohortFail(
				"token bundle fd is writable; only a read-only descriptor may carry tokens",
			);
		}
		if (observation.hardLinkCount !== 0) {
			return cohortFail(
				"token bundle fd is path-backed; the supervisor must unlink before spawn",
			);
		}
		if (observation.byteSize > TOKEN_BUNDLE_MAX_SIZE) {
			return cohortFail(
				`token bundle fd size ${observation.byteSize} exceeds cap ${TOKEN_BUNDLE_MAX_SIZE}`,
			);
		}
	}
	if (
		atRead.value.deviceId !== atSpawn.value.deviceId ||
		atRead.value.inode !== atSpawn.value.inode ||
		atRead.value.byteSize !== atSpawn.value.byteSize ||
		atRead.value.contentSha256 !== atSpawn.value.contentSha256
	) {
		return cohortFail(
			"token bundle fd was mutated or reused between spawn and read",
		);
	}
	if (atRead.value.byteSize !== args.expectedSize) {
		return cohortFail(
			`token bundle fd size ${atRead.value.byteSize} is not the committed ${args.expectedSize}`,
		);
	}
	if (atRead.value.contentSha256 !== args.expectedSha256) {
		return cohortFail("token bundle fd digest is not the committed digest");
	}
	return { ok: true, value: true };
}

// ---------------------------------------------------------------------------
// Frozen chat-10k worst-case fixture
// ---------------------------------------------------------------------------

export interface Chat10kTokenBundleFixture {
	readonly bundle: TokenBundleV1;
	readonly canonicalBytes: Uint8Array;
	readonly roleTokenCommitmentRootSha256: Sha256Hex;
	readonly leafCount: number;
}

const CHAT_10K_PUBLISHERS = 10;
const CHAT_10K_SUBSCRIBERS = 10_000;

function deterministicToken(label: string): Uint8Array {
	return new Uint8Array(createHash("sha256").update(label).digest());
}

/**
 * The frozen worst case the plan sizes the cap against: one chat-10k subscriber
 * worker holding 1,250 of 10,000 subscribers, each entry carrying a 32-byte
 * token and the 14 siblings a 10,010-leaf tree produces. Deterministic, so the
 * measured canonical size is a property of the schema rather than of a run.
 */
export function buildChat10kWorstCaseTokenBundleFixture(): Chat10kTokenBundleFixture {
	const leaves: TokenCommitmentLeafV1[] = [];
	const tokens: Uint8Array[] = [];
	for (let index = 0; index < CHAT_10K_PUBLISHERS; index += 1) {
		const roleId = `publisher-${index.toString().padStart(6, "0")}`;
		const token = deterministicToken(`chat-10k:${roleId}`);
		tokens.push(token);
		leaves.push({
			schema: "token-commitment-leaf/v1",
			childId: roleId,
			cohortId: "chat-10k",
			role: "publisher",
			roleId,
			tokenSha256: sha256HexOfBytes(token),
			workerIndex: null,
		});
	}
	for (let index = 0; index < CHAT_10K_SUBSCRIBERS; index += 1) {
		const roleId = `subscriber-${index.toString().padStart(6, "0")}`;
		const token = deterministicToken(`chat-10k:${roleId}`);
		tokens.push(token);
		leaves.push({
			schema: "token-commitment-leaf/v1",
			childId: `subscriber-worker-${index % SUBSCRIBER_SHARD_MODULUS}`,
			cohortId: "chat-10k",
			role: "subscriber",
			roleId,
			tokenSha256: sha256HexOfBytes(token),
			workerIndex: index % SUBSCRIBER_SHARD_MODULUS,
		});
	}
	const leafHashes = leaves.map((leaf) => tokenCommitmentLeafSha256(leaf));
	const levels = tokenMerkleLevels(leafHashes);
	if (!levels.ok) throw new Error("chat-10k merkle levels");
	const top = levels.value[levels.value.length - 1] as Sha256Hex[];
	const root = top[0] as Sha256Hex;

	const proofAt = (leafIndex: number): Sha256Hex[] => {
		const proof: Sha256Hex[] = [];
		let index = leafIndex;
		for (let level = 0; level < levels.value.length - 1; level += 1) {
			const nodes = levels.value[level] as Sha256Hex[];
			const siblingIndex = index % 2 === 0 ? index + 1 : index - 1;
			proof.push((nodes[siblingIndex] ?? nodes[index]) as Sha256Hex);
			index = Math.floor(index / 2);
		}
		return proof;
	};

	const entries: TokenBundleEntryV1[] = [];
	for (
		let subscriber = 0;
		subscriber < CHAT_10K_SUBSCRIBERS;
		subscriber += SUBSCRIBER_SHARD_MODULUS
	) {
		const commitmentIndex = CHAT_10K_PUBLISHERS + subscriber;
		const token = tokens[commitmentIndex] as Uint8Array;
		entries.push({
			schema: "token-bundle-entry/v1",
			role: "subscriber",
			roleId: `subscriber-${subscriber.toString().padStart(6, "0")}`,
			workerIndex: 0,
			tokenBase64: Buffer.from(token).toString("base64"),
			tokenSha256: sha256HexOfBytes(token),
			tokenCommitmentIndex: commitmentIndex,
			tokenMerkleProofSha256: proofAt(commitmentIndex),
		});
	}
	const bundle: TokenBundleV1 = {
		schema: "token-bundle/v1",
		executionSha256: sha256CanonicalRecord({ fixture: "chat-10k-execution" }),
		cohortGrantSha256: sha256CanonicalRecord({ fixture: "chat-10k-grant" }),
		childId: "subscriber-worker-0",
		entryCount: entries.length,
		entries,
	};
	return {
		bundle,
		canonicalBytes: bytesOfCanonical(bundle),
		roleTokenCommitmentRootSha256: root,
		leafCount: leaves.length,
	};
}

export type { MacReceiptSignatureV1 };

// ---------------------------------------------------------------------------
// §4.3 Mac role-child control frames and the global connect ramp
// ---------------------------------------------------------------------------

/** `RoleSpawnConfigV1` is the one large frame; it is delivered once. */
export const ROLE_SPAWN_CONFIG_MAX_BYTES = 512 * 1024;
/** Every other role-child control frame is capped at 8 KiB. */
export const ROLE_CHILD_FRAME_MAX_BYTES = 8 * 1024;
/** §2 caps for the two records the spawn config carries by value. */
export const STAGED_SERVER_LAUNCH_RECORD_MAX_BYTES = 64 * 1024;
export const WORKLOAD_ROLE_PLAN_INPUT_MAX_BYTES = 160 * 1024;
export const STAGED_SERVER_LAUNCH_RECORD_MAX_ARGV = 32;
export const STAGED_SERVER_LAUNCH_RECORD_MAX_ARGV_BYTES = 1_024;
export const STAGED_SERVER_LAUNCH_RECORD_MAX_ENVIRONMENT = 32;
export const STAGED_SERVER_LAUNCH_RECORD_MAX_ENVIRONMENT_BYTES = 4_096;

/**
 * The server host is a staged, per-profile value, never negotiated per child
 * (design §3.1 "One machine, all real processes, loopback instead of
 * `10.99.0.2`"). The two physical profiles bind and advertise the rig's cable
 * address and refuse loopback; the local-acceptance profile binds and
 * advertises loopback and refuses the cable address. The launch record names
 * its profile, so a record's host is checked against the profile it carries
 * wherever the record is parsed, and every downstream field (`serverHost` on
 * the spawn config, the server child's `--bind`, the TLS SAN) equals it.
 */
export const COHORT_STAGE_PROFILES = [
	"phase-a",
	"phase-b",
	"local-acceptance",
] as const;
export type CohortStageProfile = (typeof COHORT_STAGE_PROFILES)[number];
/** The physical profiles' host: the rig on the measurement cable. */
export const COHORT_SERVER_HOST = "10.99.0.2" as const;
/** The local-acceptance profile's host: this machine, loopback. */
export const COHORT_LOCAL_ACCEPTANCE_SERVER_HOST = "127.0.0.1" as const;
export type CohortServerHost =
	| typeof COHORT_SERVER_HOST
	| typeof COHORT_LOCAL_ACCEPTANCE_SERVER_HOST;
export const COHORT_TLS_SERVER_NAME = "wt-compare.local" as const;

export function isCohortStageProfile(
	value: unknown,
): value is CohortStageProfile {
	return isOneOf(value, COHORT_STAGE_PROFILES);
}

export function cohortServerHostForProfile(
	profile: CohortStageProfile,
): CohortServerHost {
	return profile === "local-acceptance"
		? COHORT_LOCAL_ACCEPTANCE_SERVER_HOST
		: COHORT_SERVER_HOST;
}

/**
 * Whether `value` is the one host `profile` stages. A physical profile with
 * loopback and a local profile with the cable address are the two
 * substitutions this exists to refuse; anything else is not a host at all.
 */
export function isCohortServerHostForProfile(
	profile: CohortStageProfile,
	value: unknown,
): value is CohortServerHost {
	return value === cohortServerHostForProfile(profile);
}

const STAGE_PROFILE_ARG = "--stage-profile=";

/**
 * The profile a staged launch argv names: the value of its one
 * `--stage-profile=` element, or null when there is not exactly one such
 * element or its value is not a profile.
 */
export function stagedServerLaunchArgvProfile(
	argv: readonly string[],
): CohortStageProfile | null {
	const named = argv.filter((arg) => arg.startsWith(STAGE_PROFILE_ARG));
	if (named.length !== 1) return null;
	const profile = (named[0] as string).slice(STAGE_PROFILE_ARG.length);
	return isCohortStageProfile(profile) ? profile : null;
}

/** The profile a parsed launch record was staged under (from its argv). */
export function stagedServerLaunchRecordProfile(
	record: StagedServerLaunchRecordV1,
): CohortStageProfile {
	const profile = stagedServerLaunchArgvProfile(record.argv);
	if (profile === null) {
		throw new Error("a parsed launch record always names its profile");
	}
	return profile;
}

/** Ed25519 sizes, restated here so the parsers never accept a short key. */
export const ED25519_PUBLIC_KEY_BYTES = 32;
export const ED25519_SIGNATURE_BYTES = 64;

/** No role child is ever replaced; a replacement would break the ordinal domain. */
export const COHORT_ROLE_REPLACEMENT_COUNT = 0;

export const NANOSECONDS_PER_SECOND = 1_000_000_000;
const NANOSECONDS_PER_SECOND_BIG = 1_000_000_000n;
const NS_PER_MS_BIG = 1_000_000n;

/**
 * RFC 4648 standard alphabet with padding. The encoded length and the cap are
 * both checked before the decode allocates, and the re-encode must reproduce
 * the input so a non-canonical encoding cannot smuggle different bytes past a
 * digest comparison made on the decoded form.
 */
export function decodeStrictBase64(
	value: unknown,
	cap: number,
): Uint8Array | null {
	if (typeof value !== "string" || value.length === 0) return null;
	if (value.length % 4 !== 0) return null;
	if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
	// The decoded length is known exactly from the encoded length and padding,
	// so the cap is enforced before anything is allocated.
	const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
	if ((value.length / 4) * 3 - padding > cap) return null;
	const decoded = new Uint8Array(Buffer.from(value, "base64"));
	if (decoded.byteLength > cap) return null;
	if (Buffer.from(decoded).toString("base64") !== value) return null;
	return decoded;
}

function childFrameWithinCap(value: unknown): ProtocolResult<true> {
	const bytes = bytesOfCanonical(value);
	if (bytes.byteLength > ROLE_CHILD_FRAME_MAX_BYTES) {
		return cohortFail(
			`role child frame ${bytes.byteLength} exceeds cap ${ROLE_CHILD_FRAME_MAX_BYTES}`,
		);
	}
	return { ok: true, value: true };
}

// --- StagedServerLaunchRecordV1 (§2), carried by value in the spawn config ---

export interface StagedServerLaunchEnvironmentEntryV1 {
	readonly name: string;
	readonly value: string;
}

/**
 * The two staged TLS leaves the launch record binds by digest (amendment C4:
 * "Staging binds real launch argv, local/remote binaries/addon/Bun, TLS and
 * immutable roots"). Both live in the rig's staging root; the certificate
 * alone is also staged on the Mac, where it is the CA every role connector
 * verifies the named server against. The rig supervisor reads both through
 * its pinned staging-root handle at spawn time, refuses either whose digest
 * is not the record's, and hands the server child their content -- never a
 * path it could re-resolve and never the controller's environment.
 */
export const STAGED_SERVER_TLS_CERTIFICATE_LEAF = "staged-server-tls.crt";
export const STAGED_SERVER_TLS_PRIVATE_KEY_LEAF = "staged-server-tls.key";

export interface StagedServerLaunchRecordV1 {
	readonly schema: "staged-server-launch-record/v1";
	readonly stageReceiptSha256: Sha256Hex;
	readonly serverEntrypointSha256: Sha256Hex;
	readonly bunSha256: Sha256Hex;
	readonly addonSha256: Sha256Hex;
	/** Equal to `advertisedHost`: the child binds exactly what it advertises. */
	readonly bindAddress: CohortServerHost;
	readonly bindPort: number;
	readonly advertisedHost: CohortServerHost;
	readonly tlsServerName: "wt-compare.local";
	/** sha256 of `staged-server-tls.crt` (PEM), staged on both hosts. */
	readonly tlsCertificateSha256: Sha256Hex;
	/** sha256 of `staged-server-tls.key` (PEM), staged on the rig only. */
	readonly tlsPrivateKeySha256: Sha256Hex;
	readonly transport: "ws" | "wt";
	readonly argv: readonly string[];
	readonly allowedEnvironment: readonly StagedServerLaunchEnvironmentEntryV1[];
}

const STAGED_SERVER_LAUNCH_RECORD_KEYS = [
	"addonSha256",
	"advertisedHost",
	"allowedEnvironment",
	"argv",
	"bindAddress",
	"bindPort",
	"bunSha256",
	"schema",
	"serverEntrypointSha256",
	"stageReceiptSha256",
	"tlsCertificateSha256",
	"tlsPrivateKeySha256",
	"tlsServerName",
	"transport",
] as const;

const ENVIRONMENT_ENTRY_KEYS = ["name", "value"] as const;

function isPort(value: unknown): value is number {
	return isSafePosInt(value) && value <= 65_535;
}

export function parseStagedServerLaunchRecord(
	value: unknown,
): ProtocolResult<StagedServerLaunchRecordV1> {
	if (
		!isPlainObject(value) ||
		!exactKeys(value, STAGED_SERVER_LAUNCH_RECORD_KEYS)
	) {
		return cohortFail("staged server launch record keys");
	}
	if (
		value.schema !== "staged-server-launch-record/v1" ||
		!isHex64(value.stageReceiptSha256) ||
		!isHex64(value.serverEntrypointSha256) ||
		!isHex64(value.bunSha256) ||
		!isHex64(value.addonSha256) ||
		!isPort(value.bindPort) ||
		value.tlsServerName !== COHORT_TLS_SERVER_NAME ||
		!isHex64(value.tlsCertificateSha256) ||
		!isHex64(value.tlsPrivateKeySha256) ||
		(value.transport !== "ws" && value.transport !== "wt") ||
		!Array.isArray(value.argv) ||
		!Array.isArray(value.allowedEnvironment)
	) {
		return cohortFail("staged server launch record fields");
	}
	if (value.argv.length > STAGED_SERVER_LAUNCH_RECORD_MAX_ARGV) {
		return cohortFail("argv cardinality");
	}
	for (const entry of value.argv) {
		if (typeof entry !== "string" || entry.length === 0) {
			return cohortFail("argv entry is not a non-empty string");
		}
		if (
			new TextEncoder().encode(entry).byteLength >
			STAGED_SERVER_LAUNCH_RECORD_MAX_ARGV_BYTES
		) {
			return cohortFail("argv entry exceeds 1 KiB");
		}
	}
	// The profile is stated inside the argv the rig exec's and compares byte
	// for byte (`--stage-profile=<profile>`, exactly once), so the record
	// names its own profile with no extra key, and the host is that profile's
	// on both endpoint fields and on the argv's `--bind=`: a physical record
	// naming loopback and a local-acceptance record naming the cable address
	// are refused here, before any consumer reads either field, and a record
	// whose argv binds another host than its fields is two records.
	const profile = stagedServerLaunchArgvProfile(value.argv);
	if (profile === null) {
		return cohortFail("argv does not name exactly one stage profile");
	}
	if (!isCohortServerHostForProfile(profile, value.bindAddress)) {
		return cohortFail(`bindAddress is not the ${profile} profile's host`);
	}
	if (value.advertisedHost !== value.bindAddress) {
		return cohortFail("advertisedHost does not equal bindAddress");
	}
	if (
		value.argv.filter((arg) => arg.startsWith("--bind=")).length !== 1 ||
		!value.argv.includes(`--bind=${value.bindAddress}`)
	) {
		return cohortFail("argv does not bind the record's bindAddress");
	}
	if (
		value.allowedEnvironment.length >
		STAGED_SERVER_LAUNCH_RECORD_MAX_ENVIRONMENT
	) {
		return cohortFail("allowedEnvironment cardinality");
	}
	// Sorted by name with duplicates forbidden: the set is encoded as a sorted
	// array, so two orderings of the same environment cannot hash differently.
	let previousName: string | null = null;
	for (const entry of value.allowedEnvironment) {
		if (!isPlainObject(entry) || !exactKeys(entry, ENVIRONMENT_ENTRY_KEYS)) {
			return cohortFail("environment entry keys");
		}
		if (!isNonEmptyString(entry.name) || typeof entry.value !== "string") {
			return cohortFail("environment entry fields");
		}
		if (
			bytesOfCanonical(entry).byteLength >
			STAGED_SERVER_LAUNCH_RECORD_MAX_ENVIRONMENT_BYTES
		) {
			return cohortFail("environment entry exceeds 4 KiB");
		}
		if (previousName !== null && entry.name <= previousName) {
			return cohortFail("allowedEnvironment is not sorted by name");
		}
		previousName = entry.name;
	}
	const capped = withinCap(
		value,
		STAGED_SERVER_LAUNCH_RECORD_MAX_BYTES,
		"staged server launch record",
	);
	if (!capped.ok) return capped;
	return { ok: true, value: value as unknown as StagedServerLaunchRecordV1 };
}

// --- RoleSpawnConfigV1 -------------------------------------------------------

export interface RoleSpawnConfigV1 {
	readonly schema: "role-spawn-config/v1";
	readonly sequence: number;
	readonly executionSha256: Sha256Hex;
	readonly cohortGrantSha256: Sha256Hex;
	readonly cohortGrantBase64: Base64;
	readonly cohortGrantSignatureBase64: Base64;
	readonly workloadRolePlanInputBase64: Base64;
	readonly workloadRolePlanInputSha256: Sha256Hex;
	readonly stagedServerLaunchRecordBase64: Base64;
	readonly stagedServerLaunchRecordSha256: Sha256Hex;
	readonly stagedServerLaunchRecordSize: number;
	readonly childId: string;
	readonly role: "publisher" | "subscriber-worker";
	readonly publisherId: string | null;
	readonly workerIndex: number | null;
	readonly childInstanceNonce: Sha256Hex;
	readonly tokenBundleFd: 5;
	readonly tokenBundleSha256: Sha256Hex;
	readonly tokenBundleSize: number;
	readonly tokenBundleEntryCount: number;
	readonly tokenBundleMaxSize: 2097152;
	readonly transport: "ws" | "wt";
	/** The staged launch record's `advertisedHost`, restated for the child. */
	readonly serverHost: CohortServerHost;
	readonly serverPort: number;
	readonly tlsServerName: "wt-compare.local";
	readonly messageRatePerSecond: number;
	readonly warmupMessagesPerPublisher: 10;
	readonly warmupIntervalMs: 500;
	readonly warmupDurationMs: 5000;
	readonly measuredDurationMs: 10000 | 30000;
	readonly measuredSampleWindowMs: 1000;
	readonly payloadBytes: 100 | 128;
	readonly channelMapping:
		| "ws-binary-message-per-frame"
		| "wt-publisher-bidi-subscriber-control-bidi-server-uni";
	readonly macSigningPublicKeyBase64: Base64;
	readonly macSigningPublicKeySha256: Sha256Hex;
}

const ROLE_SPAWN_CONFIG_KEYS = [
	"channelMapping",
	"childId",
	"childInstanceNonce",
	"cohortGrantBase64",
	"cohortGrantSha256",
	"cohortGrantSignatureBase64",
	"executionSha256",
	"macSigningPublicKeyBase64",
	"macSigningPublicKeySha256",
	"measuredDurationMs",
	"measuredSampleWindowMs",
	"messageRatePerSecond",
	"payloadBytes",
	"publisherId",
	"role",
	"schema",
	"sequence",
	"serverHost",
	"serverPort",
	"stagedServerLaunchRecordBase64",
	"stagedServerLaunchRecordSha256",
	"stagedServerLaunchRecordSize",
	"tlsServerName",
	"tokenBundleEntryCount",
	"tokenBundleFd",
	"tokenBundleMaxSize",
	"tokenBundleSha256",
	"tokenBundleSize",
	"transport",
	"warmupDurationMs",
	"warmupIntervalMs",
	"warmupMessagesPerPublisher",
	"workerIndex",
	"workloadRolePlanInputBase64",
	"workloadRolePlanInputSha256",
] as const;

const CHANNEL_MAPPING_BY_TRANSPORT = {
	ws: "ws-binary-message-per-frame",
	wt: "wt-publisher-bidi-subscriber-control-bidi-server-uni",
} as const;

export function parseRoleSpawnConfig(
	value: unknown,
): ProtocolResult<RoleSpawnConfigV1> {
	if (!isPlainObject(value) || !exactKeys(value, ROLE_SPAWN_CONFIG_KEYS)) {
		return cohortFail("role spawn config keys");
	}
	if (
		value.schema !== "role-spawn-config/v1" ||
		!isSafeNonNegInt(value.sequence) ||
		!isHex64(value.executionSha256) ||
		!isHex64(value.cohortGrantSha256) ||
		!isHex64(value.workloadRolePlanInputSha256) ||
		!isHex64(value.stagedServerLaunchRecordSha256) ||
		!isSafePosInt(value.stagedServerLaunchRecordSize) ||
		!isNonEmptyString(value.childId) ||
		(value.role !== "publisher" && value.role !== "subscriber-worker") ||
		!isHex64(value.childInstanceNonce) ||
		value.tokenBundleFd !== TOKEN_BUNDLE_FD ||
		!isHex64(value.tokenBundleSha256) ||
		!isSafePosInt(value.tokenBundleSize) ||
		!isSafePosInt(value.tokenBundleEntryCount) ||
		value.tokenBundleMaxSize !== TOKEN_BUNDLE_MAX_SIZE ||
		(value.transport !== "ws" && value.transport !== "wt") ||
		(value.serverHost !== COHORT_SERVER_HOST &&
			value.serverHost !== COHORT_LOCAL_ACCEPTANCE_SERVER_HOST) ||
		!isPort(value.serverPort) ||
		value.tlsServerName !== COHORT_TLS_SERVER_NAME ||
		!isSafePosInt(value.messageRatePerSecond) ||
		value.warmupMessagesPerPublisher !== WARMUP_MESSAGES_PER_PUBLISHER ||
		value.warmupIntervalMs !== WARMUP_INTERVAL_MS ||
		value.warmupDurationMs !== WARMUP_DURATION_MS ||
		!isOneOf(value.measuredDurationMs, COHORT_MEASURED_DURATION_MS_VALUES) ||
		value.measuredSampleWindowMs !== COHORT_SAMPLE_WINDOW_MS ||
		!isOneOf(value.payloadBytes, COHORT_MESSAGE_BYTES_VALUES) ||
		!isHex64(value.macSigningPublicKeySha256)
	) {
		return cohortFail("role spawn config fields");
	}
	if (value.tokenBundleSize > TOKEN_BUNDLE_MAX_SIZE) {
		return cohortFail("tokenBundleSize exceeds the frozen cap");
	}
	if (value.channelMapping !== CHANNEL_MAPPING_BY_TRANSPORT[value.transport]) {
		return cohortFail("channelMapping does not match transport");
	}
	// A publisher owns one publisher ID and no shard; a subscriber worker owns
	// one shard and originates no traffic, so it must carry a null publisher ID.
	if (value.role === "publisher") {
		if (
			!isNonEmptyString(value.publisherId) ||
			!ROLE_ID_RE.test(value.publisherId) ||
			!value.publisherId.startsWith("publisher-")
		) {
			return cohortFail("publisher spawn config publisherId");
		}
		if (value.workerIndex !== null) {
			return cohortFail("publisher spawn config must carry null workerIndex");
		}
	} else {
		if (value.publisherId !== null) {
			return cohortFail("subscriber worker must carry null publisherId");
		}
		if (
			!isSafeNonNegInt(value.workerIndex) ||
			value.workerIndex >= COHORT_WORKER_COUNT
		) {
			return cohortFail("subscriber worker workerIndex");
		}
	}

	const grantBytes = decodeStrictBase64(
		value.cohortGrantBase64,
		COHORT_GRANT_MAX_BYTES,
	);
	if (grantBytes === null) return cohortFail("cohortGrantBase64");
	if (sha256HexOfBytes(grantBytes) !== value.cohortGrantSha256) {
		return cohortFail("cohortGrantSha256 does not commit to the carried grant");
	}
	const signature = decodeStrictBase64(
		value.cohortGrantSignatureBase64,
		ED25519_SIGNATURE_BYTES,
	);
	if (signature === null || signature.byteLength !== ED25519_SIGNATURE_BYTES) {
		return cohortFail("cohort grant signature is not 64 raw bytes");
	}
	const publicKey = decodeStrictBase64(
		value.macSigningPublicKeyBase64,
		ED25519_PUBLIC_KEY_BYTES,
	);
	if (publicKey === null || publicKey.byteLength !== ED25519_PUBLIC_KEY_BYTES) {
		return cohortFail("mac signing public key is not 32 raw bytes");
	}
	if (sha256HexOfBytes(publicKey) !== value.macSigningPublicKeySha256) {
		return cohortFail("macSigningPublicKeySha256 does not match the key");
	}
	const workloadBytes = decodeStrictBase64(
		value.workloadRolePlanInputBase64,
		WORKLOAD_ROLE_PLAN_INPUT_MAX_BYTES,
	);
	if (workloadBytes === null) return cohortFail("workloadRolePlanInputBase64");
	if (sha256HexOfBytes(workloadBytes) !== value.workloadRolePlanInputSha256) {
		return cohortFail("workloadRolePlanInputSha256 mismatch");
	}
	const launchBytes = decodeStrictBase64(
		value.stagedServerLaunchRecordBase64,
		STAGED_SERVER_LAUNCH_RECORD_MAX_BYTES,
	);
	if (launchBytes === null) {
		return cohortFail("stagedServerLaunchRecordBase64");
	}
	if (launchBytes.byteLength !== value.stagedServerLaunchRecordSize) {
		return cohortFail("stagedServerLaunchRecordSize mismatch");
	}
	if (sha256HexOfBytes(launchBytes) !== value.stagedServerLaunchRecordSha256) {
		return cohortFail("stagedServerLaunchRecordSha256 mismatch");
	}
	const launchJson = parseStrictJsonBytes(launchBytes);
	if (!launchJson.ok) {
		return cohortFail(`staged launch record json ${launchJson.reason}`);
	}
	const launch = parseStagedServerLaunchRecord(launchJson.value);
	if (!launch.ok) return launch;
	// The child never looks up an endpoint: every endpoint field must equal the
	// record the rig was signed to launch.
	if (launch.value.bindPort !== value.serverPort) {
		return cohortFail("serverPort does not equal the staged bindPort");
	}
	if (launch.value.transport !== value.transport) {
		return cohortFail("transport does not equal the staged transport");
	}
	if (launch.value.advertisedHost !== value.serverHost) {
		return cohortFail("serverHost does not equal the staged advertised host");
	}
	if (launch.value.tlsServerName !== value.tlsServerName) {
		return cohortFail("tlsServerName does not equal the staged server name");
	}
	const capped = withinCap(
		value,
		ROLE_SPAWN_CONFIG_MAX_BYTES,
		"role spawn config",
	);
	if (!capped.ok) return capped;
	return { ok: true, value: value as unknown as RoleSpawnConfigV1 };
}

// --- Readiness, permits, warmup, measurement, partials, exit ----------------

export interface RoleReadyV1 {
	readonly schema: "role-ready/v1";
	readonly sequence: number;
	readonly executionSha256: Sha256Hex;
	readonly cohortGrantSha256: Sha256Hex;
	readonly childId: string;
	readonly childPid: number;
	readonly childPgid: number;
	readonly childInstanceNonce: Sha256Hex;
	readonly registeredSessionCount: number;
}

const ROLE_READY_KEYS = [
	"childId",
	"childInstanceNonce",
	"childPgid",
	"childPid",
	"cohortGrantSha256",
	"executionSha256",
	"registeredSessionCount",
	"schema",
	"sequence",
] as const;

export function parseRoleReady(value: unknown): ProtocolResult<RoleReadyV1> {
	if (!isPlainObject(value) || !exactKeys(value, ROLE_READY_KEYS)) {
		return cohortFail("role ready keys");
	}
	if (
		value.schema !== "role-ready/v1" ||
		!isSafeNonNegInt(value.sequence) ||
		!isHex64(value.executionSha256) ||
		!isHex64(value.cohortGrantSha256) ||
		!isNonEmptyString(value.childId) ||
		!isSafePosInt(value.childPid) ||
		!isSafePosInt(value.childPgid) ||
		!isHex64(value.childInstanceNonce) ||
		!isSafePosInt(value.registeredSessionCount)
	) {
		return cohortFail("role ready fields");
	}
	const capped = childFrameWithinCap(value);
	if (!capped.ok) return capped;
	return { ok: true, value: value as unknown as RoleReadyV1 };
}

export interface ConnectPermitRequestV1 {
	readonly schema: "connect-permit-request/v1";
	readonly sequence: number;
	readonly executionSha256: Sha256Hex;
	readonly cohortGrantSha256: Sha256Hex;
	readonly childId: string;
	readonly globalOrdinal: number;
	readonly roleId: string;
}

const CONNECT_PERMIT_REQUEST_KEYS = [
	"childId",
	"cohortGrantSha256",
	"executionSha256",
	"globalOrdinal",
	"roleId",
	"schema",
	"sequence",
] as const;

export function parseConnectPermitRequest(
	value: unknown,
): ProtocolResult<ConnectPermitRequestV1> {
	if (!isPlainObject(value) || !exactKeys(value, CONNECT_PERMIT_REQUEST_KEYS)) {
		return cohortFail("connect permit request keys");
	}
	if (
		value.schema !== "connect-permit-request/v1" ||
		!isSafeNonNegInt(value.sequence) ||
		!isHex64(value.executionSha256) ||
		!isHex64(value.cohortGrantSha256) ||
		!isNonEmptyString(value.childId) ||
		!isSafeNonNegInt(value.globalOrdinal) ||
		!isNonEmptyString(value.roleId) ||
		!ROLE_ID_RE.test(value.roleId)
	) {
		return cohortFail("connect permit request fields");
	}
	const capped = childFrameWithinCap(value);
	if (!capped.ok) return capped;
	return { ok: true, value: value as unknown as ConnectPermitRequestV1 };
}

export interface ConnectPermitGrantV1 {
	readonly schema: "connect-permit-grant/v1";
	readonly sequence: number;
	readonly executionSha256: Sha256Hex;
	readonly cohortGrantSha256: Sha256Hex;
	readonly childId: string;
	readonly globalOrdinal: number;
	readonly notBeforeMacNs: NsString;
	readonly permitNonce: Sha256Hex;
}

const CONNECT_PERMIT_GRANT_KEYS = [
	"childId",
	"cohortGrantSha256",
	"executionSha256",
	"globalOrdinal",
	"notBeforeMacNs",
	"permitNonce",
	"schema",
	"sequence",
] as const;

export function parseConnectPermitGrant(
	value: unknown,
): ProtocolResult<ConnectPermitGrantV1> {
	if (!isPlainObject(value) || !exactKeys(value, CONNECT_PERMIT_GRANT_KEYS)) {
		return cohortFail("connect permit grant keys");
	}
	if (
		value.schema !== "connect-permit-grant/v1" ||
		!isSafeNonNegInt(value.sequence) ||
		!isHex64(value.executionSha256) ||
		!isHex64(value.cohortGrantSha256) ||
		!isNonEmptyString(value.childId) ||
		!isSafeNonNegInt(value.globalOrdinal) ||
		!isNsString(value.notBeforeMacNs) ||
		!isHex64(value.permitNonce)
	) {
		return cohortFail("connect permit grant fields");
	}
	const capped = childFrameWithinCap(value);
	if (!capped.ok) return capped;
	return { ok: true, value: value as unknown as ConnectPermitGrantV1 };
}

export interface ConnectPermitCompleteV1 {
	readonly schema: "connect-permit-complete/v1";
	readonly sequence: number;
	readonly executionSha256: Sha256Hex;
	readonly cohortGrantSha256: Sha256Hex;
	readonly childId: string;
	readonly globalOrdinal: number;
	readonly permitNonce: Sha256Hex;
	readonly startedAtMacNs: NsString;
	readonly completedAtMacNs: NsString;
	readonly outcome: "ready" | "failed";
}

const CONNECT_PERMIT_COMPLETE_KEYS = [
	"childId",
	"cohortGrantSha256",
	"completedAtMacNs",
	"executionSha256",
	"globalOrdinal",
	"outcome",
	"permitNonce",
	"schema",
	"sequence",
	"startedAtMacNs",
] as const;

export function parseConnectPermitComplete(
	value: unknown,
): ProtocolResult<ConnectPermitCompleteV1> {
	if (
		!isPlainObject(value) ||
		!exactKeys(value, CONNECT_PERMIT_COMPLETE_KEYS)
	) {
		return cohortFail("connect permit complete keys");
	}
	if (
		value.schema !== "connect-permit-complete/v1" ||
		!isSafeNonNegInt(value.sequence) ||
		!isHex64(value.executionSha256) ||
		!isHex64(value.cohortGrantSha256) ||
		!isNonEmptyString(value.childId) ||
		!isSafeNonNegInt(value.globalOrdinal) ||
		!isHex64(value.permitNonce) ||
		!isNsString(value.startedAtMacNs) ||
		!isNsString(value.completedAtMacNs) ||
		(value.outcome !== "ready" && value.outcome !== "failed")
	) {
		return cohortFail("connect permit complete fields");
	}
	if (ns(value.completedAtMacNs) < ns(value.startedAtMacNs)) {
		return cohortFail("permit completed before it started");
	}
	const capped = childFrameWithinCap(value);
	if (!capped.ok) return capped;
	return { ok: true, value: value as unknown as ConnectPermitCompleteV1 };
}

export interface RoleWarmupStartV1 {
	readonly schema: "role-warmup-start/v1";
	readonly sequence: number;
	readonly executionSha256: Sha256Hex;
	readonly cohortGrantSha256: Sha256Hex;
	readonly cohortWarmupEpochBase64: Base64;
	readonly cohortWarmupEpochSha256: Sha256Hex;
	readonly cohortWarmupEpochSignatureBase64: Base64;
	readonly cohortWarmupEpochSignatureSha256: Sha256Hex;
	readonly warmupNonce: Sha256Hex;
	readonly expectedChildOfferedWarmupIngress: number;
	readonly expectedChildDeliveredWarmupRecords: number;
	readonly startAtMacNs: NsString;
	readonly durationMs: 5000;
}

const ROLE_WARMUP_START_KEYS = [
	"cohortGrantSha256",
	"cohortWarmupEpochBase64",
	"cohortWarmupEpochSha256",
	"cohortWarmupEpochSignatureBase64",
	"cohortWarmupEpochSignatureSha256",
	"durationMs",
	"executionSha256",
	"expectedChildDeliveredWarmupRecords",
	"expectedChildOfferedWarmupIngress",
	"schema",
	"sequence",
	"startAtMacNs",
	"warmupNonce",
] as const;

/** A warmup frame may never carry measured-window identity. */
const ROLE_WARMUP_FORBIDDEN_FIELDS = [
	"barrierNonce",
	"cohortStartBarrierBase64",
	"cohortStartBarrierSha256",
	"windowIndex",
] as const;

function rejectMeasuredFieldsInWarmup(record: Rec): ProtocolResult<true> {
	for (const forbidden of ROLE_WARMUP_FORBIDDEN_FIELDS) {
		if (hasOwn(record, forbidden)) {
			return fail(
				WARMUP_PROTOCOL_FAILURE_CODE,
				`warmup frame must not carry ${forbidden}`,
			);
		}
	}
	return { ok: true, value: true };
}

export function parseRoleWarmupStart(
	value: unknown,
): ProtocolResult<RoleWarmupStartV1> {
	if (!isPlainObject(value)) {
		return fail(WARMUP_PROTOCOL_FAILURE_CODE, "role warmup start");
	}
	const mixing = rejectMeasuredFieldsInWarmup(value);
	if (!mixing.ok) return mixing;
	if (!exactKeys(value, ROLE_WARMUP_START_KEYS)) {
		return fail(WARMUP_PROTOCOL_FAILURE_CODE, "role warmup start keys");
	}
	if (
		value.schema !== "role-warmup-start/v1" ||
		!isSafeNonNegInt(value.sequence) ||
		!isHex64(value.executionSha256) ||
		!isHex64(value.cohortGrantSha256) ||
		!isHex64(value.cohortWarmupEpochSha256) ||
		!isHex64(value.cohortWarmupEpochSignatureSha256) ||
		!isHex64(value.warmupNonce) ||
		!isSafeNonNegInt(value.expectedChildOfferedWarmupIngress) ||
		!isSafeNonNegInt(value.expectedChildDeliveredWarmupRecords) ||
		!isNsString(value.startAtMacNs) ||
		value.durationMs !== WARMUP_DURATION_MS
	) {
		return fail(WARMUP_PROTOCOL_FAILURE_CODE, "role warmup start fields");
	}
	const epochBytes = decodeStrictBase64(
		value.cohortWarmupEpochBase64,
		COHORT_WARMUP_EPOCH_MAX_BYTES,
	);
	if (
		epochBytes === null ||
		sha256HexOfBytes(epochBytes) !== value.cohortWarmupEpochSha256
	) {
		return fail(
			WARMUP_PROTOCOL_FAILURE_CODE,
			"cohortWarmupEpochSha256 does not commit to the carried epoch",
		);
	}
	const signature = decodeStrictBase64(
		value.cohortWarmupEpochSignatureBase64,
		ED25519_SIGNATURE_BYTES,
	);
	if (signature === null || signature.byteLength !== ED25519_SIGNATURE_BYTES) {
		return fail(
			WARMUP_PROTOCOL_FAILURE_CODE,
			"warmup epoch signature is not 64 raw bytes",
		);
	}
	if (sha256HexOfBytes(signature) !== value.cohortWarmupEpochSignatureSha256) {
		return fail(
			WARMUP_PROTOCOL_FAILURE_CODE,
			"warmup epoch signature digest mismatch",
		);
	}
	const capped = childFrameWithinCap(value);
	if (!capped.ok) return capped;
	return { ok: true, value: value as unknown as RoleWarmupStartV1 };
}

export interface RoleWarmupCompleteV1 {
	readonly schema: "role-warmup-complete/v1";
	readonly sequence: number;
	readonly executionSha256: Sha256Hex;
	readonly cohortGrantSha256: Sha256Hex;
	readonly cohortWarmupEpochSha256: Sha256Hex;
	readonly warmupNonce: Sha256Hex;
	readonly childId: string;
	readonly role: "publisher" | "subscriber-worker";
	readonly startedAtMacNs: NsString;
	readonly completedAtMacNs: NsString;
	readonly offeredWarmupIngress: number;
	readonly deliveredWarmupRecords: number;
}

const ROLE_WARMUP_COMPLETE_KEYS = [
	"childId",
	"cohortGrantSha256",
	"cohortWarmupEpochSha256",
	"completedAtMacNs",
	"deliveredWarmupRecords",
	"executionSha256",
	"offeredWarmupIngress",
	"role",
	"schema",
	"sequence",
	"startedAtMacNs",
	"warmupNonce",
] as const;

export function parseRoleWarmupComplete(
	value: unknown,
): ProtocolResult<RoleWarmupCompleteV1> {
	if (!isPlainObject(value)) {
		return fail(WARMUP_PROTOCOL_FAILURE_CODE, "role warmup complete");
	}
	const mixing = rejectMeasuredFieldsInWarmup(value);
	if (!mixing.ok) return mixing;
	if (!exactKeys(value, ROLE_WARMUP_COMPLETE_KEYS)) {
		return fail(WARMUP_PROTOCOL_FAILURE_CODE, "role warmup complete keys");
	}
	if (
		value.schema !== "role-warmup-complete/v1" ||
		!isSafeNonNegInt(value.sequence) ||
		!isHex64(value.executionSha256) ||
		!isHex64(value.cohortGrantSha256) ||
		!isHex64(value.cohortWarmupEpochSha256) ||
		!isHex64(value.warmupNonce) ||
		!isNonEmptyString(value.childId) ||
		(value.role !== "publisher" && value.role !== "subscriber-worker") ||
		!isNsString(value.startedAtMacNs) ||
		!isNsString(value.completedAtMacNs) ||
		!isSafeNonNegInt(value.offeredWarmupIngress) ||
		!isSafeNonNegInt(value.deliveredWarmupRecords)
	) {
		return fail(WARMUP_PROTOCOL_FAILURE_CODE, "role warmup complete fields");
	}
	if (ns(value.completedAtMacNs) < ns(value.startedAtMacNs)) {
		return fail(
			WARMUP_PROTOCOL_FAILURE_CODE,
			"warmup completed before it started",
		);
	}
	// A publisher offers ingress and delivers nothing; a subscriber worker
	// delivers records and originates nothing.
	if (value.role === "publisher" && value.deliveredWarmupRecords !== 0) {
		return fail(
			WARMUP_PROTOCOL_FAILURE_CODE,
			"a publisher delivers no warmup records",
		);
	}
	if (value.role === "subscriber-worker" && value.offeredWarmupIngress !== 0) {
		return fail(
			WARMUP_PROTOCOL_FAILURE_CODE,
			"a subscriber worker offers no warmup ingress",
		);
	}
	const capped = childFrameWithinCap(value);
	if (!capped.ok) return capped;
	return { ok: true, value: value as unknown as RoleWarmupCompleteV1 };
}

export interface RoleMeasureStartV1 {
	readonly schema: "role-measure-start/v1";
	readonly sequence: number;
	readonly executionSha256: Sha256Hex;
	readonly cohortStartBarrierBase64: Base64;
}

const ROLE_MEASURE_START_KEYS = [
	"cohortStartBarrierBase64",
	"executionSha256",
	"schema",
	"sequence",
] as const;

export function parseRoleMeasureStart(
	value: unknown,
): ProtocolResult<RoleMeasureStartV1> {
	if (!isPlainObject(value) || !exactKeys(value, ROLE_MEASURE_START_KEYS)) {
		return cohortFail("role measure start keys");
	}
	if (
		value.schema !== "role-measure-start/v1" ||
		!isSafeNonNegInt(value.sequence) ||
		!isHex64(value.executionSha256)
	) {
		return cohortFail("role measure start fields");
	}
	// The child is handed the barrier by value, so the frame must carry a real
	// barrier rather than a digest it would have to look up.
	const barrierBytes = decodeStrictBase64(
		value.cohortStartBarrierBase64,
		ROLE_CHILD_FRAME_MAX_BYTES,
	);
	if (barrierBytes === null) return cohortFail("cohortStartBarrierBase64");
	const json = parseStrictJsonBytes(barrierBytes);
	if (!json.ok) return cohortFail(`start barrier json ${json.reason}`);
	const barrier = parseCohortStartBarrier(json.value);
	if (!barrier.ok) return barrier;
	const capped = childFrameWithinCap(value);
	if (!capped.ok) return capped;
	return { ok: true, value: value as unknown as RoleMeasureStartV1 };
}

export interface RoleMeasureStartAckV1 {
	readonly schema: "role-measure-start-ack/v1";
	readonly sequence: number;
	readonly executionSha256: Sha256Hex;
	readonly childId: string;
	readonly cohortStartBarrierSha256: Sha256Hex;
	readonly armedAtMacNs: NsString;
}

const ROLE_MEASURE_START_ACK_KEYS = [
	"armedAtMacNs",
	"childId",
	"cohortStartBarrierSha256",
	"executionSha256",
	"schema",
	"sequence",
] as const;

export function parseRoleMeasureStartAck(
	value: unknown,
): ProtocolResult<RoleMeasureStartAckV1> {
	if (!isPlainObject(value) || !exactKeys(value, ROLE_MEASURE_START_ACK_KEYS)) {
		return cohortFail("role measure start ack keys");
	}
	if (
		value.schema !== "role-measure-start-ack/v1" ||
		!isSafeNonNegInt(value.sequence) ||
		!isHex64(value.executionSha256) ||
		!isNonEmptyString(value.childId) ||
		!isHex64(value.cohortStartBarrierSha256) ||
		!isNsString(value.armedAtMacNs)
	) {
		return cohortFail("role measure start ack fields");
	}
	const capped = childFrameWithinCap(value);
	if (!capped.ok) return capped;
	return { ok: true, value: value as unknown as RoleMeasureStartAckV1 };
}

export interface RoleStopV1 {
	readonly schema: "role-stop/v1";
	readonly sequence: number;
	readonly executionSha256: Sha256Hex;
	readonly cohortStartBarrierSha256: Sha256Hex;
	readonly stopAtMacNs: NsString;
}

const ROLE_STOP_KEYS = [
	"cohortStartBarrierSha256",
	"executionSha256",
	"schema",
	"sequence",
	"stopAtMacNs",
] as const;

export function parseRoleStop(value: unknown): ProtocolResult<RoleStopV1> {
	if (!isPlainObject(value) || !exactKeys(value, ROLE_STOP_KEYS)) {
		return cohortFail("role stop keys");
	}
	if (
		value.schema !== "role-stop/v1" ||
		!isSafeNonNegInt(value.sequence) ||
		!isHex64(value.executionSha256) ||
		!isHex64(value.cohortStartBarrierSha256) ||
		!isNsString(value.stopAtMacNs)
	) {
		return cohortFail("role stop fields");
	}
	const capped = childFrameWithinCap(value);
	if (!capped.ok) return capped;
	return { ok: true, value: value as unknown as RoleStopV1 };
}

export interface RolePartialV1 {
	readonly schema: "role-partial/v1";
	readonly sequence: number;
	readonly executionSha256: Sha256Hex;
	readonly childId: string;
	readonly partialKind: "publisher" | "worker";
	readonly partialBase64: Base64;
	readonly partialSha256: Sha256Hex;
}

const ROLE_PARTIAL_KEYS = [
	"childId",
	"executionSha256",
	"partialBase64",
	"partialKind",
	"partialSha256",
	"schema",
	"sequence",
] as const;

export function parseRolePartial(
	value: unknown,
): ProtocolResult<RolePartialV1> {
	if (!isPlainObject(value) || !exactKeys(value, ROLE_PARTIAL_KEYS)) {
		return cohortFail("role partial keys");
	}
	if (
		value.schema !== "role-partial/v1" ||
		!isSafeNonNegInt(value.sequence) ||
		!isHex64(value.executionSha256) ||
		!isNonEmptyString(value.childId) ||
		(value.partialKind !== "publisher" && value.partialKind !== "worker") ||
		!isHex64(value.partialSha256)
	) {
		return cohortFail("role partial fields");
	}
	const partialBytes = decodeStrictBase64(
		value.partialBase64,
		ROLE_CHILD_FRAME_MAX_BYTES,
	);
	if (partialBytes === null) return cohortFail("partialBase64");
	if (sha256HexOfBytes(partialBytes) !== value.partialSha256) {
		return cohortFail("partialSha256 does not commit to the carried partial");
	}
	const capped = childFrameWithinCap(value);
	if (!capped.ok) return capped;
	return { ok: true, value: value as unknown as RolePartialV1 };
}

export interface RolePartialAcceptedV1 {
	readonly schema: "role-partial-accepted/v1";
	readonly sequence: number;
	readonly executionSha256: Sha256Hex;
	readonly childId: string;
	readonly partialSha256: Sha256Hex;
}

const ROLE_PARTIAL_ACCEPTED_KEYS = [
	"childId",
	"executionSha256",
	"partialSha256",
	"schema",
	"sequence",
] as const;

export function parseRolePartialAccepted(
	value: unknown,
): ProtocolResult<RolePartialAcceptedV1> {
	if (!isPlainObject(value) || !exactKeys(value, ROLE_PARTIAL_ACCEPTED_KEYS)) {
		return cohortFail("role partial accepted keys");
	}
	if (
		value.schema !== "role-partial-accepted/v1" ||
		!isSafeNonNegInt(value.sequence) ||
		!isHex64(value.executionSha256) ||
		!isNonEmptyString(value.childId) ||
		!isHex64(value.partialSha256)
	) {
		return cohortFail("role partial accepted fields");
	}
	const capped = childFrameWithinCap(value);
	if (!capped.ok) return capped;
	return { ok: true, value: value as unknown as RolePartialAcceptedV1 };
}

export interface RoleExitV1 {
	readonly schema: "role-exit/v1";
	readonly sequence: number;
	readonly executionSha256: Sha256Hex;
	readonly childId: string;
}

const ROLE_EXIT_KEYS = [
	"childId",
	"executionSha256",
	"schema",
	"sequence",
] as const;

export function parseRoleExit(value: unknown): ProtocolResult<RoleExitV1> {
	if (!isPlainObject(value) || !exactKeys(value, ROLE_EXIT_KEYS)) {
		return cohortFail("role exit keys");
	}
	if (
		value.schema !== "role-exit/v1" ||
		!isSafeNonNegInt(value.sequence) ||
		!isHex64(value.executionSha256) ||
		!isNonEmptyString(value.childId)
	) {
		return cohortFail("role exit fields");
	}
	const capped = childFrameWithinCap(value);
	if (!capped.ok) return capped;
	return { ok: true, value: value as unknown as RoleExitV1 };
}

export interface RoleExitedV1 {
	readonly schema: "role-exited/v1";
	readonly sequence: number;
	readonly executionSha256: Sha256Hex;
	readonly childId: string;
	readonly exitCode: number;
}

const ROLE_EXITED_KEYS = [
	"childId",
	"executionSha256",
	"exitCode",
	"schema",
	"sequence",
] as const;

/** POSIX exit statuses are 0..255; a negative value is not an exit code. */
export const ROLE_EXIT_CODE_MAX = 255;

export function parseRoleExited(value: unknown): ProtocolResult<RoleExitedV1> {
	if (!isPlainObject(value) || !exactKeys(value, ROLE_EXITED_KEYS)) {
		return cohortFail("role exited keys");
	}
	if (
		value.schema !== "role-exited/v1" ||
		!isSafeNonNegInt(value.sequence) ||
		!isHex64(value.executionSha256) ||
		!isNonEmptyString(value.childId) ||
		!isSafeNonNegInt(value.exitCode) ||
		value.exitCode > ROLE_EXIT_CODE_MAX
	) {
		return cohortFail("role exited fields");
	}
	const capped = childFrameWithinCap(value);
	if (!capped.ok) return capped;
	return { ok: true, value: value as unknown as RoleExitedV1 };
}

// ---------------------------------------------------------------------------
// One global ordinal domain and the connect-permit scheduler math
// ---------------------------------------------------------------------------

export interface GlobalOrdinalAssignmentV1 {
	readonly globalOrdinal: number;
	readonly role: "publisher" | "subscriber";
	readonly roleId: string;
	readonly workerIndex: number | null;
}

function notReady(message: string) {
	return fail(COHORT_NOT_READY_FAILURE_CODE, message);
}

/** `subscriberCount + publisherCount`; every ordinal appears exactly once. */
export function globalOrdinalCount(args: {
	readonly publisherCount: number;
	readonly subscriberCount: number;
}): number {
	const total = checkedAdd(args.subscriberCount, args.publisherCount);
	if (total === null) throw new RangeError("global ordinal domain overflow");
	return total;
}

/**
 * Ordinals `0..subscriberCount-1` are subscribers, sharded by `o mod 8`;
 * the remainder are publishers in ascending publisher ID order. There is one
 * domain, so a per-role counter can never masquerade as global accounting.
 */
export function resolveGlobalOrdinal(args: {
	readonly globalOrdinal: number;
	readonly publisherCount: number;
	readonly subscriberCount: number;
}): ProtocolResult<GlobalOrdinalAssignmentV1> {
	const { globalOrdinal, publisherCount, subscriberCount } = args;
	if (
		!isSafeNonNegInt(globalOrdinal) ||
		!isSafeNonNegInt(publisherCount) ||
		!isSafeNonNegInt(subscriberCount)
	) {
		return notReady("global ordinal inputs must be nonnegative safe integers");
	}
	if (publisherCount > COHORT_MAX_PUBLISHERS) {
		return notReady("publisherCount exceeds the Phase B maximum");
	}
	const total = globalOrdinalCount({ publisherCount, subscriberCount });
	if (globalOrdinal >= total) {
		return notReady(`ordinal ${globalOrdinal} is outside the cohort domain`);
	}
	if (globalOrdinal < subscriberCount) {
		return {
			ok: true,
			value: {
				globalOrdinal,
				role: "subscriber",
				roleId: `subscriber-${globalOrdinal.toString().padStart(6, "0")}`,
				workerIndex: globalOrdinal % SUBSCRIBER_SHARD_MODULUS,
			},
		};
	}
	const publisherIndex = globalOrdinal - subscriberCount;
	return {
		ok: true,
		value: {
			globalOrdinal,
			role: "publisher",
			roleId: `publisher-${publisherIndex.toString().padStart(6, "0")}`,
			workerIndex: null,
		},
	};
}

/** The whole contiguous domain, in ordinal order, with no gap or repeat. */
export function enumerateGlobalOrdinals(args: {
	readonly publisherCount: number;
	readonly subscriberCount: number;
}): ProtocolResult<readonly GlobalOrdinalAssignmentV1[]> {
	const total = globalOrdinalCount(args);
	if (total === 0) return notReady("cohort domain is empty");
	const assignments: GlobalOrdinalAssignmentV1[] = [];
	for (let ordinal = 0; ordinal < total; ordinal += 1) {
		const resolved = resolveGlobalOrdinal({
			globalOrdinal: ordinal,
			publisherCount: args.publisherCount,
			subscriberCount: args.subscriberCount,
		});
		if (!resolved.ok) return resolved;
		assignments.push(resolved.value);
	}
	return { ok: true, value: assignments };
}

/**
 * `rampEpochMacNs + floor(ordinal * 1e9 / 500)`, in checked bigint arithmetic
 * so a large cohort cannot silently lose precision through a float.
 */
export function permitNotBeforeMacNs(args: {
	readonly rampEpochMacNs: NsString;
	readonly globalOrdinal: number;
}): ProtocolResult<NsString> {
	if (!isNsString(args.rampEpochMacNs)) {
		return notReady("rampEpochMacNs is not a nanosecond string");
	}
	if (!isSafeNonNegInt(args.globalOrdinal)) {
		return notReady("globalOrdinal must be a nonnegative safe integer");
	}
	const offset =
		(BigInt(args.globalOrdinal) * NANOSECONDS_PER_SECOND_BIG) /
		BigInt(COHORT_CONNECTION_RATE_PER_SECOND);
	return { ok: true, value: (ns(args.rampEpochMacNs) + offset).toString() };
}

/**
 * One `nextOrdinal`, one total in-flight map, one heap: a permit is legal only
 * for the deterministic owner of that ordinal, only at or after its ramp time,
 * and only while strictly fewer than 200 permits are already in flight.
 */
export function validateConnectPermitGrant(args: {
	readonly request: unknown;
	readonly grant: unknown;
	readonly rampEpochMacNs: NsString;
	readonly publisherCount: number;
	readonly subscriberCount: number;
	readonly inFlightBefore: number;
}): ProtocolResult<true> {
	const request = parseConnectPermitRequest(args.request);
	if (!request.ok) return notReady(request.message ?? "permit request");
	const grant = parseConnectPermitGrant(args.grant);
	if (!grant.ok) return notReady(grant.message ?? "permit grant");
	if (request.value.globalOrdinal !== grant.value.globalOrdinal) {
		return notReady("permit grant is for a different ordinal");
	}
	if (request.value.childId !== grant.value.childId) {
		return notReady("permit grant is for a different child");
	}
	if (request.value.cohortGrantSha256 !== grant.value.cohortGrantSha256) {
		return notReady("permit grant is bound to a different cohort grant");
	}
	if (request.value.executionSha256 !== grant.value.executionSha256) {
		return notReady("permit grant is bound to a different execution");
	}
	const owner = resolveGlobalOrdinal({
		globalOrdinal: grant.value.globalOrdinal,
		publisherCount: args.publisherCount,
		subscriberCount: args.subscriberCount,
	});
	if (!owner.ok) return owner;
	if (owner.value.roleId !== request.value.roleId) {
		return notReady(
			`ordinal ${grant.value.globalOrdinal} belongs to ${owner.value.roleId}`,
		);
	}
	const notBefore = permitNotBeforeMacNs({
		rampEpochMacNs: args.rampEpochMacNs,
		globalOrdinal: grant.value.globalOrdinal,
	});
	if (!notBefore.ok) return notBefore;
	if (ns(grant.value.notBeforeMacNs) < ns(notBefore.value)) {
		return notReady("permit granted before its ramp time");
	}
	if (!isSafeNonNegInt(args.inFlightBefore)) {
		return notReady("inFlightBefore must be a nonnegative safe integer");
	}
	if (args.inFlightBefore >= COHORT_MAX_CONNECTIONS_IN_FLIGHT) {
		return notReady(
			`${args.inFlightBefore} permits already in flight at the ${COHORT_MAX_CONNECTIONS_IN_FLIGHT} cap`,
		);
	}
	return { ok: true, value: true };
}

/** Completion spends the permit; it must be the same permit, on time. */
export function validateConnectPermitCompletion(args: {
	readonly complete: unknown;
	readonly grant: unknown;
	readonly readinessDeadlineMs: number;
	readonly rampEpochMacNs: NsString;
}): ProtocolResult<true> {
	const complete = parseConnectPermitComplete(args.complete);
	if (!complete.ok) return notReady(complete.message ?? "permit complete");
	const grant = parseConnectPermitGrant(args.grant);
	if (!grant.ok) return notReady(grant.message ?? "permit grant");
	if (complete.value.permitNonce !== grant.value.permitNonce) {
		return notReady("completion replays a different permit nonce");
	}
	if (complete.value.globalOrdinal !== grant.value.globalOrdinal) {
		return notReady("completion is for a different ordinal");
	}
	if (complete.value.childId !== grant.value.childId) {
		return notReady("completion is for a different child");
	}
	if (complete.value.outcome !== "ready") {
		return notReady("permit completed without the child becoming ready");
	}
	if (ns(complete.value.startedAtMacNs) < ns(grant.value.notBeforeMacNs)) {
		return notReady("connect started before the permit time");
	}
	if (!isOneOf(args.readinessDeadlineMs, READINESS_DEADLINE_MS_VALUES)) {
		return notReady("readinessDeadlineMs is not a frozen cell deadline");
	}
	if (!isNsString(args.rampEpochMacNs)) {
		return notReady("rampEpochMacNs is not a nanosecond string");
	}
	const deadline =
		ns(args.rampEpochMacNs) + BigInt(args.readinessDeadlineMs) * NS_PER_MS_BIG;
	if (ns(complete.value.completedAtMacNs) > deadline) {
		return notReady("permit completed after the readiness deadline");
	}
	return { ok: true, value: true };
}

/** No role child is ever replaced; a replacement breaks the ordinal domain. */
export function validateNoRoleReplacements(
	replacementCount: unknown,
): ProtocolResult<true> {
	if (replacementCount !== COHORT_ROLE_REPLACEMENT_COUNT) {
		return notReady(
			`replacementCount must be ${COHORT_ROLE_REPLACEMENT_COUNT}`,
		);
	}
	return { ok: true, value: true };
}

// ---------------------------------------------------------------------------
// §4.4 partials, ordered manifest, process proof, Linux observation, receipts,
// and the raw cohort-evidence export bundle
// ---------------------------------------------------------------------------

/** A measured window boundary was violated: the event cannot be placed. */
export const MEASUREMENT_WINDOW_FAILURE_CODE = "MEASUREMENT_WINDOW" as const;
/** Conservation across publisher, relay, and subscriber accounting broke. */
export const RELAY_DELIVERY_FAILURE_CODE = "RELAY_DELIVERY" as const;

/** §4.4 per-publisher partial cap. */
export const PUBLISHER_PARTIAL_MAX_BYTES = 64 * 1024;
/** §4.4 per-worker partial cap; `perSubscriberDelivered` makes it the largest. */
export const WORKER_PARTIAL_MAX_BYTES = 256 * 1024;
/** §4.4 ordered partial manifest cap. */
export const ORDERED_PARTIAL_MANIFEST_MAX_BYTES = 64 * 1024;
/** §4.4 observed process proof cap. */
export const OBSERVED_PROCESS_PROOF_MAX_BYTES = 128 * 1024;
/** §4.4 Linux relay observation cap. */
export const LINUX_RELAY_OBSERVATION_MAX_BYTES = 128 * 1024;
/** §4.4 rig-signed relay observation receipt cap. */
export const RIG_RELAY_OBSERVATION_RECEIPT_MAX_BYTES = 32 * 1024;
/** §4.4 Mac-signed cohort admission receipt cap. */
export const COHORT_ADMISSION_RECEIPT_MAX_BYTES = 64 * 1024;
/** §4.4 detached signature cap that accompanies the admission receipt. */
export const COHORT_ADMISSION_SIGNATURE_MAX_BYTES = 4 * 1024;
/** Decoded ceiling for the single terminal raw-evidence export. */
export const COHORT_OBSERVATION_EVIDENCE_MAX_DECODED_BYTES = 9 * 1024 * 1024;
/** Encoded ceiling, checked before any base64 is read or allocated. */
export const COHORT_OBSERVATION_EVIDENCE_MAX_ENCODED_BYTES = 14 * 1024 * 1024;
/** Per-execution remote-evidence budget the decode is charged against. */
export const COHORT_REMOTE_EVIDENCE_BUDGET_BYTES = 20 * 1024 * 1024;

/**
 * Caps for the members that are not otherwise frozen by §4.1/§4.4. These are
 * the smallest signed-record class, not a plan constant, and are named so a
 * future widening is a deliberate edit rather than a silent allocation.
 */
export const COHORT_DERIVED_RECORD_MAX_BYTES = 16 * 1024;
/** Detached-signature record class shared by every cohort signature member. */
export const COHORT_SIGNATURE_RECORD_MAX_BYTES = 4 * 1024;

function measurementFail(message: string) {
	return fail(MEASUREMENT_WINDOW_FAILURE_CODE, message);
}

function relayFail(message: string) {
	return fail(RELAY_DELIVERY_FAILURE_CODE, message);
}

/** Fixed-cardinality array of nonnegative safe-integer counts. */
function isCountArray(value: unknown, length: number): value is number[] {
	return (
		Array.isArray(value) &&
		value.length === length &&
		value.every((entry) => isSafeNonNegInt(entry))
	);
}

/** Checked sum that refuses anything JSON cannot carry exactly. */
function checkedSum(values: readonly number[]): number | null {
	let total = 0;
	for (const value of values) {
		const next = checkedAdd(total, value);
		if (next === null) return null;
		total = next;
	}
	return total;
}

export interface PublisherPartialV1 {
	readonly schema: "publisher-partial/v1";
	readonly executionSha256: Sha256Hex;
	readonly cohortGrantSha256: Sha256Hex;
	readonly cohortStartBarrierSha256: Sha256Hex;
	readonly childId: string;
	readonly childPid: number;
	readonly childPgid: number;
	readonly childInstanceNonce: Sha256Hex;
	readonly publisherId: string;
	readonly tokenSha256: Sha256Hex;
	readonly macClockId: string;
	readonly windowCount: 10 | 30;
	readonly offeredByOriginWindow: readonly number[];
	readonly offeredBytesByOriginWindow: readonly number[];
	readonly acceptedAckSeenByOriginWindow: readonly number[];
	readonly duplicateAckSeenByOriginWindow: readonly number[];
	readonly reorderedAckSeenByOriginWindow: readonly number[];
	readonly firstOfferAtMacNs: NsString;
	readonly lastAckAtMacNs: NsString;
	readonly exitCode: 0;
}

const PUBLISHER_PARTIAL_KEYS = [
	"acceptedAckSeenByOriginWindow",
	"childId",
	"childInstanceNonce",
	"childPgid",
	"childPid",
	"cohortGrantSha256",
	"cohortStartBarrierSha256",
	"duplicateAckSeenByOriginWindow",
	"executionSha256",
	"exitCode",
	"firstOfferAtMacNs",
	"lastAckAtMacNs",
	"macClockId",
	"offeredByOriginWindow",
	"offeredBytesByOriginWindow",
	"publisherId",
	"reorderedAckSeenByOriginWindow",
	"schema",
	"tokenSha256",
	"windowCount",
].sort() as readonly string[];

export function parsePublisherPartial(
	value: unknown,
): ProtocolResult<PublisherPartialV1> {
	if (!isPlainObject(value) || !exactKeys(value, PUBLISHER_PARTIAL_KEYS)) {
		return cohortFail("publisher partial keys");
	}
	if (
		value.schema !== "publisher-partial/v1" ||
		!isHex64(value.executionSha256) ||
		!isHex64(value.cohortGrantSha256) ||
		!isHex64(value.cohortStartBarrierSha256) ||
		!isNonEmptyString(value.childId) ||
		!isSafePosInt(value.childPid) ||
		!isSafePosInt(value.childPgid) ||
		!isHex64(value.childInstanceNonce) ||
		!isNonEmptyString(value.publisherId) ||
		!isHex64(value.tokenSha256) ||
		!isNonEmptyString(value.macClockId) ||
		!isOneOf(value.windowCount, COHORT_WINDOW_COUNT_VALUES) ||
		!isNsString(value.firstOfferAtMacNs) ||
		!isNsString(value.lastAckAtMacNs) ||
		value.exitCode !== 0
	) {
		return cohortFail("publisher partial fields");
	}
	const windows = value.windowCount;
	for (const key of [
		"offeredByOriginWindow",
		"offeredBytesByOriginWindow",
		"acceptedAckSeenByOriginWindow",
		"duplicateAckSeenByOriginWindow",
		"reorderedAckSeenByOriginWindow",
	] as const) {
		if (!isCountArray(value[key], windows)) {
			return cohortFail(`publisher partial ${key} cardinality`);
		}
	}
	// Acknowledgements are per origin window and can never exceed the offers
	// that minted those windows.
	for (let index = 0; index < windows; index += 1) {
		const offered = (value.offeredByOriginWindow as number[])[index]!;
		const accepted = (value.acceptedAckSeenByOriginWindow as number[])[index]!;
		if (accepted > offered) {
			return cohortFail(
				`publisher accepted acks exceed offers in window ${index}`,
			);
		}
	}
	if (ns(value.lastAckAtMacNs) < ns(value.firstOfferAtMacNs)) {
		return cohortFail("publisher partial last ack precedes first offer");
	}
	const capped = withinCap(
		value,
		PUBLISHER_PARTIAL_MAX_BYTES,
		"publisher partial",
	);
	if (!capped.ok) return capped;
	return { ok: true, value: value as unknown as PublisherPartialV1 };
}

export interface WorkerPartialV1 {
	readonly schema: "worker-partial/v1";
	readonly executionSha256: Sha256Hex;
	readonly cohortGrantSha256: Sha256Hex;
	readonly cohortStartBarrierSha256: Sha256Hex;
	readonly childId: string;
	readonly childPid: number;
	readonly childPgid: number;
	readonly childInstanceNonce: Sha256Hex;
	readonly workerIndex: number;
	readonly tokenBundleSha256: Sha256Hex;
	readonly orderedSubscriberIdsSha256: Sha256Hex;
	readonly subscriberCount: number;
	readonly macClockId: string;
	readonly windowCount: 10 | 30;
	readonly deliveredByOriginWindow: readonly number[];
	readonly deliveredBytesByOriginWindow: readonly number[];
	readonly deliveredByEventWindow: readonly number[];
	readonly deliveredBytesByEventWindow: readonly number[];
	readonly deliveredAfterMeasureStop: number;
	readonly deliveredBytesAfterMeasureStop: number;
	readonly perSubscriberDelivered: readonly number[];
	readonly duplicateCount: number;
	readonly reorderCount: number;
	readonly malformedCount: number;
	readonly disconnectCount: number;
	readonly firstDeliveryAtMacNs: NsString;
	readonly lastDeliveryAtMacNs: NsString;
	readonly exitCode: 0;
}

const WORKER_PARTIAL_KEYS = [
	"childId",
	"childInstanceNonce",
	"childPgid",
	"childPid",
	"cohortGrantSha256",
	"cohortStartBarrierSha256",
	"deliveredAfterMeasureStop",
	"deliveredBytesAfterMeasureStop",
	"deliveredBytesByEventWindow",
	"deliveredBytesByOriginWindow",
	"deliveredByEventWindow",
	"deliveredByOriginWindow",
	"disconnectCount",
	"duplicateCount",
	"executionSha256",
	"exitCode",
	"firstDeliveryAtMacNs",
	"lastDeliveryAtMacNs",
	"macClockId",
	"malformedCount",
	"orderedSubscriberIdsSha256",
	"perSubscriberDelivered",
	"reorderCount",
	"schema",
	"subscriberCount",
	"tokenBundleSha256",
	"windowCount",
	"workerIndex",
].sort() as readonly string[];

export function parseWorkerPartial(
	value: unknown,
): ProtocolResult<WorkerPartialV1> {
	if (!isPlainObject(value) || !exactKeys(value, WORKER_PARTIAL_KEYS)) {
		return cohortFail("worker partial keys");
	}
	if (
		value.schema !== "worker-partial/v1" ||
		!isHex64(value.executionSha256) ||
		!isHex64(value.cohortGrantSha256) ||
		!isHex64(value.cohortStartBarrierSha256) ||
		!isNonEmptyString(value.childId) ||
		!isSafePosInt(value.childPid) ||
		!isSafePosInt(value.childPgid) ||
		!isHex64(value.childInstanceNonce) ||
		!isSafeNonNegInt(value.workerIndex) ||
		value.workerIndex >= COHORT_WORKER_COUNT ||
		!isHex64(value.tokenBundleSha256) ||
		!isHex64(value.orderedSubscriberIdsSha256) ||
		!isSafeNonNegInt(value.subscriberCount) ||
		!isNonEmptyString(value.macClockId) ||
		!isOneOf(value.windowCount, COHORT_WINDOW_COUNT_VALUES) ||
		!isSafeNonNegInt(value.deliveredAfterMeasureStop) ||
		!isSafeNonNegInt(value.deliveredBytesAfterMeasureStop) ||
		!isSafeNonNegInt(value.duplicateCount) ||
		!isSafeNonNegInt(value.reorderCount) ||
		!isSafeNonNegInt(value.malformedCount) ||
		!isSafeNonNegInt(value.disconnectCount) ||
		!isNsString(value.firstDeliveryAtMacNs) ||
		!isNsString(value.lastDeliveryAtMacNs) ||
		value.exitCode !== 0
	) {
		return cohortFail("worker partial fields");
	}
	const windows = value.windowCount;
	for (const key of [
		"deliveredByOriginWindow",
		"deliveredBytesByOriginWindow",
		"deliveredByEventWindow",
		"deliveredBytesByEventWindow",
	] as const) {
		if (!isCountArray(value[key], windows)) {
			return cohortFail(`worker partial ${key} cardinality`);
		}
	}
	// The per-subscriber vector is the shard's exact membership, not a summary.
	if (!isCountArray(value.perSubscriberDelivered, value.subscriberCount)) {
		return cohortFail("worker partial perSubscriberDelivered cardinality");
	}
	if (ns(value.lastDeliveryAtMacNs) < ns(value.firstDeliveryAtMacNs)) {
		return cohortFail("worker partial last delivery precedes first delivery");
	}
	const capped = withinCap(value, WORKER_PARTIAL_MAX_BYTES, "worker partial");
	if (!capped.ok) return capped;
	return { ok: true, value: value as unknown as WorkerPartialV1 };
}

export interface OrderedPartialManifestEntryV1 {
	readonly schema: "ordered-partial-manifest-entry/v1";
	readonly order: number;
	readonly partialKind: "publisher" | "worker";
	readonly childId: string;
	readonly partialSha256: Sha256Hex;
	readonly partialSize: number;
}

export interface OrderedPartialManifestV1 {
	readonly schema: "ordered-partial-manifest/v1";
	readonly executionSha256: Sha256Hex;
	readonly cohortGrantSha256: Sha256Hex;
	readonly cohortStartBarrierSha256: Sha256Hex;
	readonly publisherPartialCount: number;
	readonly workerPartialCount: 8;
	readonly totalPartialBytes: number;
	readonly entries: readonly OrderedPartialManifestEntryV1[];
	readonly orderedDigestSetSha256: Sha256Hex;
}

const ORDERED_PARTIAL_MANIFEST_ENTRY_KEYS = [
	"childId",
	"order",
	"partialKind",
	"partialSha256",
	"partialSize",
	"schema",
].sort() as readonly string[];

const ORDERED_PARTIAL_MANIFEST_KEYS = [
	"cohortGrantSha256",
	"cohortStartBarrierSha256",
	"entries",
	"executionSha256",
	"orderedDigestSetSha256",
	"publisherPartialCount",
	"schema",
	"totalPartialBytes",
	"workerPartialCount",
].sort() as readonly string[];

/**
 * SHA-256 over the canonical projection the plan freezes: kind, child, digest,
 * and size only. Reordering, dropping, or resizing an entry changes it.
 */
export function orderedPartialDigestSetSha256(
	entries: readonly OrderedPartialManifestEntryV1[],
): Sha256Hex {
	return sha256CanonicalRecord(
		entries.map((entry) => ({
			childId: entry.childId,
			partialKind: entry.partialKind,
			partialSha256: entry.partialSha256,
			partialSize: entry.partialSize,
		})),
	);
}

export function parseOrderedPartialManifestEntry(
	value: unknown,
): ProtocolResult<OrderedPartialManifestEntryV1> {
	if (
		!isPlainObject(value) ||
		!exactKeys(value, ORDERED_PARTIAL_MANIFEST_ENTRY_KEYS)
	) {
		return cohortFail("ordered partial manifest entry keys");
	}
	if (
		value.schema !== "ordered-partial-manifest-entry/v1" ||
		!isSafeNonNegInt(value.order) ||
		(value.partialKind !== "publisher" && value.partialKind !== "worker") ||
		!isNonEmptyString(value.childId) ||
		!isHex64(value.partialSha256) ||
		!isSafePosInt(value.partialSize)
	) {
		return cohortFail("ordered partial manifest entry fields");
	}
	const cap =
		value.partialKind === "publisher"
			? PUBLISHER_PARTIAL_MAX_BYTES
			: WORKER_PARTIAL_MAX_BYTES;
	if (value.partialSize > cap) {
		return cohortFail(`${value.partialKind} partial size exceeds cap ${cap}`);
	}
	return { ok: true, value: value as unknown as OrderedPartialManifestEntryV1 };
}

export function parseOrderedPartialManifest(
	value: unknown,
): ProtocolResult<OrderedPartialManifestV1> {
	if (
		!isPlainObject(value) ||
		!exactKeys(value, ORDERED_PARTIAL_MANIFEST_KEYS)
	) {
		return cohortFail("ordered partial manifest keys");
	}
	if (
		value.schema !== "ordered-partial-manifest/v1" ||
		!isHex64(value.executionSha256) ||
		!isHex64(value.cohortGrantSha256) ||
		!isHex64(value.cohortStartBarrierSha256) ||
		!isSafePosInt(value.publisherPartialCount) ||
		value.publisherPartialCount > COHORT_MAX_PUBLISHERS ||
		value.workerPartialCount !== COHORT_WORKER_COUNT ||
		!isSafePosInt(value.totalPartialBytes) ||
		!Array.isArray(value.entries) ||
		!isHex64(value.orderedDigestSetSha256)
	) {
		return cohortFail("ordered partial manifest fields");
	}
	const expectedEntries = checkedAdd(
		value.publisherPartialCount,
		COHORT_WORKER_COUNT,
	);
	if (expectedEntries === null || value.entries.length !== expectedEntries) {
		return cohortFail("ordered partial manifest entry cardinality");
	}
	const capped = withinCap(
		value,
		ORDERED_PARTIAL_MANIFEST_MAX_BYTES,
		"ordered partial manifest",
	);
	if (!capped.ok) return capped;
	const entries: OrderedPartialManifestEntryV1[] = [];
	const seenChildIds = new Set<string>();
	const seenDigests = new Set<string>();
	let totalBytes = 0;
	for (let index = 0; index < value.entries.length; index += 1) {
		const entry = parseOrderedPartialManifestEntry(value.entries[index]);
		if (!entry.ok) return entry;
		// Publishers ascend first, then workers 0..7; order is the position.
		if (entry.value.order !== index) {
			return cohortFail(
				`entry order ${entry.value.order} is not position ${index}`,
			);
		}
		const expectedKind =
			index < value.publisherPartialCount ? "publisher" : "worker";
		if (entry.value.partialKind !== expectedKind) {
			return cohortFail(`entry ${index} must be a ${expectedKind} partial`);
		}
		if (seenChildIds.has(entry.value.childId)) {
			return cohortFail(`duplicate partial for ${entry.value.childId}`);
		}
		seenChildIds.add(entry.value.childId);
		if (seenDigests.has(entry.value.partialSha256)) {
			return cohortFail("duplicate partial digest in manifest");
		}
		seenDigests.add(entry.value.partialSha256);
		const next = checkedAdd(totalBytes, entry.value.partialSize);
		if (next === null) return cohortFail("totalPartialBytes overflow");
		totalBytes = next;
		entries.push(entry.value);
	}
	if (totalBytes !== value.totalPartialBytes) {
		return cohortFail("totalPartialBytes disagrees with the entry sizes");
	}
	if (orderedPartialDigestSetSha256(entries) !== value.orderedDigestSetSha256) {
		return cohortFail("orderedDigestSetSha256 does not recompute");
	}
	return { ok: true, value: value as unknown as OrderedPartialManifestV1 };
}

export interface ObservedChildProcessV1 {
	readonly schema: "observed-child-process/v1";
	readonly childId: string;
	readonly role: "publisher" | "subscriber-worker";
	readonly pid: number;
	readonly pgid: number;
	readonly instanceNonce: Sha256Hex;
	readonly bunSha256: Sha256Hex;
	readonly entrypointSha256: Sha256Hex;
	readonly tokenOrBundleSha256: Sha256Hex;
	readonly publisherId: string | null;
	readonly workerIndex: number | null;
	readonly orderedSubscriberIdsSha256: Sha256Hex | null;
	readonly subscriberCount: number;
	readonly spawnedAtMacNs: NsString;
	readonly readyAtMacNs: NsString;
	readonly warmupCompleteAtMacNs: NsString;
	readonly measureArmedAtMacNs: NsString;
	readonly stoppedAtMacNs: NsString;
	readonly partialSha256: Sha256Hex;
	readonly exitCode: number;
	readonly signal: string | null;
	readonly replacementCount: 0;
}

export interface ObservedProcessProofV1 {
	readonly schema: "observed-process-proof/v1";
	readonly executionSha256: Sha256Hex;
	readonly cohortGrantSha256: Sha256Hex;
	readonly cohortStartBarrierSha256: Sha256Hex;
	readonly expectedProcessCount: number;
	readonly observedProcessCount: number;
	readonly expectedPublisherCount: number;
	readonly observedPublisherCount: number;
	readonly expectedWorkerCount: 8;
	readonly observedWorkerCount: 8;
	readonly expectedSubscriberCount: number;
	readonly observedSubscriberCount: number;
	readonly children: readonly ObservedChildProcessV1[];
	readonly childrenDigestSha256: Sha256Hex;
}

const OBSERVED_CHILD_PROCESS_KEYS = [
	"bunSha256",
	"childId",
	"entrypointSha256",
	"exitCode",
	"instanceNonce",
	"measureArmedAtMacNs",
	"orderedSubscriberIdsSha256",
	"partialSha256",
	"pgid",
	"pid",
	"publisherId",
	"readyAtMacNs",
	"replacementCount",
	"role",
	"schema",
	"signal",
	"spawnedAtMacNs",
	"stoppedAtMacNs",
	"subscriberCount",
	"tokenOrBundleSha256",
	"warmupCompleteAtMacNs",
	"workerIndex",
].sort() as readonly string[];

const OBSERVED_PROCESS_PROOF_KEYS = [
	"children",
	"childrenDigestSha256",
	"cohortGrantSha256",
	"cohortStartBarrierSha256",
	"executionSha256",
	"expectedProcessCount",
	"expectedPublisherCount",
	"expectedSubscriberCount",
	"expectedWorkerCount",
	"observedProcessCount",
	"observedPublisherCount",
	"observedSubscriberCount",
	"observedWorkerCount",
	"schema",
].sort() as readonly string[];

/** SHA-256 over the exact ordered children array, not over a summary. */
export function observedChildrenDigestSha256(
	children: readonly ObservedChildProcessV1[],
): Sha256Hex {
	return sha256CanonicalRecord(children);
}

export function parseObservedChildProcess(
	value: unknown,
): ProtocolResult<ObservedChildProcessV1> {
	if (!isPlainObject(value) || !exactKeys(value, OBSERVED_CHILD_PROCESS_KEYS)) {
		return cohortFail("observed child process keys");
	}
	if (
		value.schema !== "observed-child-process/v1" ||
		!isNonEmptyString(value.childId) ||
		(value.role !== "publisher" && value.role !== "subscriber-worker") ||
		!isSafePosInt(value.pid) ||
		!isSafePosInt(value.pgid) ||
		!isHex64(value.instanceNonce) ||
		!isHex64(value.bunSha256) ||
		!isHex64(value.entrypointSha256) ||
		!isHex64(value.tokenOrBundleSha256) ||
		!isSafeNonNegInt(value.subscriberCount) ||
		!isNsString(value.spawnedAtMacNs) ||
		!isNsString(value.readyAtMacNs) ||
		!isNsString(value.warmupCompleteAtMacNs) ||
		!isNsString(value.measureArmedAtMacNs) ||
		!isNsString(value.stoppedAtMacNs) ||
		!isHex64(value.partialSha256) ||
		!isSafeNonNegInt(value.exitCode) ||
		value.exitCode > ROLE_EXIT_CODE_MAX ||
		(value.signal !== null && !isNonEmptyString(value.signal))
	) {
		return cohortFail("observed child process fields");
	}
	// A replacement would break the one-shot global ordinal domain outright.
	if (value.replacementCount !== COHORT_ROLE_REPLACEMENT_COUNT) {
		return cohortFail(
			`replacementCount must be ${COHORT_ROLE_REPLACEMENT_COUNT}`,
		);
	}
	if (value.role === "publisher") {
		if (
			!isNonEmptyString(value.publisherId) ||
			value.workerIndex !== null ||
			value.orderedSubscriberIdsSha256 !== null ||
			value.subscriberCount !== 0
		) {
			return cohortFail("publisher child carries worker-only fields");
		}
	} else {
		if (
			value.publisherId !== null ||
			!isSafeNonNegInt(value.workerIndex) ||
			value.workerIndex >= COHORT_WORKER_COUNT ||
			!isHex64(value.orderedSubscriberIdsSha256)
		) {
			return cohortFail(
				"subscriber worker child carries publisher-only fields",
			);
		}
	}
	// Lifecycle instants are ordered inside one Mac clock.
	const ordered = [
		value.spawnedAtMacNs,
		value.readyAtMacNs,
		value.warmupCompleteAtMacNs,
		value.measureArmedAtMacNs,
		value.stoppedAtMacNs,
	] as NsString[];
	for (let index = 1; index < ordered.length; index += 1) {
		if (ns(ordered[index]!) < ns(ordered[index - 1]!)) {
			return cohortFail("observed child lifecycle instants are out of order");
		}
	}
	return { ok: true, value: value as unknown as ObservedChildProcessV1 };
}

export function parseObservedProcessProof(
	value: unknown,
): ProtocolResult<ObservedProcessProofV1> {
	if (!isPlainObject(value) || !exactKeys(value, OBSERVED_PROCESS_PROOF_KEYS)) {
		return cohortFail("observed process proof keys");
	}
	if (
		value.schema !== "observed-process-proof/v1" ||
		!isHex64(value.executionSha256) ||
		!isHex64(value.cohortGrantSha256) ||
		!isHex64(value.cohortStartBarrierSha256) ||
		!isSafePosInt(value.expectedProcessCount) ||
		!isSafePosInt(value.observedProcessCount) ||
		!isSafePosInt(value.expectedPublisherCount) ||
		!isSafePosInt(value.observedPublisherCount) ||
		value.expectedWorkerCount !== COHORT_WORKER_COUNT ||
		value.observedWorkerCount !== COHORT_WORKER_COUNT ||
		!isSafePosInt(value.expectedSubscriberCount) ||
		!isSafePosInt(value.observedSubscriberCount) ||
		!Array.isArray(value.children) ||
		!isHex64(value.childrenDigestSha256)
	) {
		return cohortFail("observed process proof fields");
	}
	if (
		value.expectedProcessCount !== value.observedProcessCount ||
		value.expectedPublisherCount !== value.observedPublisherCount ||
		value.expectedSubscriberCount !== value.observedSubscriberCount
	) {
		return cohortFail("observed process proof expected/observed mismatch");
	}
	if (value.observedPublisherCount > COHORT_MAX_PUBLISHERS) {
		return cohortFail("observedPublisherCount exceeds the Phase B maximum");
	}
	const expectedChildren = checkedAdd(
		value.observedPublisherCount,
		COHORT_WORKER_COUNT,
	);
	if (
		expectedChildren === null ||
		value.observedProcessCount !== expectedChildren ||
		value.children.length !== expectedChildren
	) {
		return cohortFail("observed process proof child cardinality");
	}
	const capped = withinCap(
		value,
		OBSERVED_PROCESS_PROOF_MAX_BYTES,
		"observed process proof",
	);
	if (!capped.ok) return capped;
	const children: ObservedChildProcessV1[] = [];
	let subscriberTotal = 0;
	for (let index = 0; index < value.children.length; index += 1) {
		const child = parseObservedChildProcess(value.children[index]);
		if (!child.ok) return child;
		const expectedRole =
			index < value.observedPublisherCount ? "publisher" : "subscriber-worker";
		if (child.value.role !== expectedRole) {
			return cohortFail(`observed child ${index} must be a ${expectedRole}`);
		}
		if (
			expectedRole === "subscriber-worker" &&
			child.value.workerIndex !== index - value.observedPublisherCount
		) {
			return cohortFail(`observed worker ${index} is out of shard order`);
		}
		const next = checkedAdd(subscriberTotal, child.value.subscriberCount);
		if (next === null) return cohortFail("observed subscriber total overflow");
		subscriberTotal = next;
		children.push(child.value);
	}
	if (subscriberTotal !== value.observedSubscriberCount) {
		return cohortFail("shard subscriber counts do not sum to the cohort");
	}
	if (observedChildrenDigestSha256(children) !== value.childrenDigestSha256) {
		return cohortFail("childrenDigestSha256 does not recompute");
	}
	return { ok: true, value: value as unknown as ObservedProcessProofV1 };
}

export interface LinuxRelayObservationV1 {
	readonly schema: "linux-relay-observation/v1";
	readonly executionSha256: Sha256Hex;
	readonly cohortGrantSha256: Sha256Hex;
	readonly cohortStartBarrierSha256: Sha256Hex;
	readonly roleTokenCommitmentRootSha256: Sha256Hex;
	readonly serverChildPid: number;
	readonly serverChildPgid: number;
	readonly serverChildInstanceNonce: Sha256Hex;
	readonly linuxClockId: string;
	readonly windowCount: 10 | 30;
	readonly registeredPublisherIds: readonly string[];
	readonly registeredSubscriberIdsSha256: Sha256Hex;
	readonly registeredPublisherCount: number;
	readonly registeredSubscriberCount: number;
	readonly acceptedIngressByOriginWindow: readonly number[];
	readonly acceptedIngressBytesByOriginWindow: readonly number[];
	readonly relayWritesCompletedByOriginWindow: readonly number[];
	readonly relayWriteBytesByOriginWindow: readonly number[];
	readonly duplicateIngressByOriginWindow: readonly number[];
	readonly reorderedIngressByOriginWindow: readonly number[];
	readonly queueDropDeliveriesByOriginWindow: readonly number[];
	readonly writeTimeoutDeliveriesByOriginWindow: readonly number[];
	readonly disconnectUndeliveredByOriginWindow: readonly number[];
	readonly malformedIngressByOriginWindow: readonly number[];
	readonly publisherEndCount: number;
	readonly subscriberEndCount: number;
	readonly sessionsAccepted: number;
	readonly sessionsActivePeak: number;
	readonly publisherSessionsActivePeak: number;
	readonly subscriberSessionsActivePeak: number;
	readonly queueItemsPeak: number;
	readonly queueBytesPeak: number;
	readonly concurrentWritesPeak: number;
	readonly measurementStartedAtLinuxNs: NsString;
	readonly relayDrainedAtLinuxNs: NsString;
	readonly allSessionsClosedAtLinuxNs: NsString;
	readonly allSessionsClosed: true;
}

const LINUX_RELAY_WINDOW_ARRAY_KEYS = [
	"acceptedIngressByOriginWindow",
	"acceptedIngressBytesByOriginWindow",
	"relayWritesCompletedByOriginWindow",
	"relayWriteBytesByOriginWindow",
	"duplicateIngressByOriginWindow",
	"reorderedIngressByOriginWindow",
	"queueDropDeliveriesByOriginWindow",
	"writeTimeoutDeliveriesByOriginWindow",
	"disconnectUndeliveredByOriginWindow",
	"malformedIngressByOriginWindow",
] as const;

const LINUX_RELAY_OBSERVATION_KEYS = [
	"allSessionsClosed",
	"allSessionsClosedAtLinuxNs",
	"cohortGrantSha256",
	"cohortStartBarrierSha256",
	"concurrentWritesPeak",
	"executionSha256",
	"linuxClockId",
	"measurementStartedAtLinuxNs",
	"publisherEndCount",
	"publisherSessionsActivePeak",
	"queueBytesPeak",
	"queueItemsPeak",
	"registeredPublisherCount",
	"registeredPublisherIds",
	"registeredSubscriberCount",
	"registeredSubscriberIdsSha256",
	"relayDrainedAtLinuxNs",
	"roleTokenCommitmentRootSha256",
	"schema",
	"serverChildInstanceNonce",
	"serverChildPgid",
	"serverChildPid",
	"sessionsAccepted",
	"sessionsActivePeak",
	"subscriberEndCount",
	"subscriberSessionsActivePeak",
	"windowCount",
	...LINUX_RELAY_WINDOW_ARRAY_KEYS,
].sort() as readonly string[];

export function parseLinuxRelayObservation(
	value: unknown,
): ProtocolResult<LinuxRelayObservationV1> {
	if (
		!isPlainObject(value) ||
		!exactKeys(value, LINUX_RELAY_OBSERVATION_KEYS)
	) {
		return cohortFail("linux relay observation keys");
	}
	if (
		value.schema !== "linux-relay-observation/v1" ||
		!isHex64(value.executionSha256) ||
		!isHex64(value.cohortGrantSha256) ||
		!isHex64(value.cohortStartBarrierSha256) ||
		!isHex64(value.roleTokenCommitmentRootSha256) ||
		!isSafePosInt(value.serverChildPid) ||
		!isSafePosInt(value.serverChildPgid) ||
		!isHex64(value.serverChildInstanceNonce) ||
		!isNonEmptyString(value.linuxClockId) ||
		!isOneOf(value.windowCount, COHORT_WINDOW_COUNT_VALUES) ||
		!Array.isArray(value.registeredPublisherIds) ||
		!isHex64(value.registeredSubscriberIdsSha256) ||
		!isSafePosInt(value.registeredPublisherCount) ||
		!isSafePosInt(value.registeredSubscriberCount) ||
		!isSafeNonNegInt(value.publisherEndCount) ||
		!isSafeNonNegInt(value.subscriberEndCount) ||
		!isSafeNonNegInt(value.sessionsAccepted) ||
		!isSafeNonNegInt(value.sessionsActivePeak) ||
		!isSafeNonNegInt(value.publisherSessionsActivePeak) ||
		!isSafeNonNegInt(value.subscriberSessionsActivePeak) ||
		!isSafeNonNegInt(value.queueItemsPeak) ||
		!isSafeNonNegInt(value.queueBytesPeak) ||
		!isSafeNonNegInt(value.concurrentWritesPeak) ||
		!isNsString(value.measurementStartedAtLinuxNs) ||
		!isNsString(value.relayDrainedAtLinuxNs) ||
		!isNsString(value.allSessionsClosedAtLinuxNs) ||
		value.allSessionsClosed !== true
	) {
		return cohortFail("linux relay observation fields");
	}
	const windows = value.windowCount;
	for (const key of LINUX_RELAY_WINDOW_ARRAY_KEYS) {
		if (!isCountArray(value[key], windows)) {
			return cohortFail(`linux relay observation ${key} cardinality`);
		}
	}
	if (value.registeredPublisherCount > COHORT_MAX_PUBLISHERS) {
		return cohortFail("registeredPublisherCount exceeds the Phase B maximum");
	}
	if (value.registeredPublisherIds.length !== value.registeredPublisherCount) {
		return cohortFail("registeredPublisherIds cardinality");
	}
	const seenPublishers = new Set<string>();
	let previous = "";
	for (const publisherId of value.registeredPublisherIds) {
		if (!isNonEmptyString(publisherId)) {
			return cohortFail("registeredPublisherIds entry");
		}
		if (seenPublishers.has(publisherId)) {
			return cohortFail(`duplicate registered publisher ${publisherId}`);
		}
		// Sets are encoded as sorted arrays; an unsorted set hides a reorder.
		if (publisherId <= previous && previous !== "") {
			return cohortFail("registeredPublisherIds is not sorted ascending");
		}
		previous = publisherId;
		seenPublishers.add(publisherId);
	}
	const expectedSessions = checkedAdd(
		value.registeredPublisherCount,
		value.registeredSubscriberCount,
	);
	if (expectedSessions === null) {
		return cohortFail("registered session total overflow");
	}
	// Peaks are bounded by what was actually registered and accepted; this is a
	// structural bound, not the stricter promotion equality.
	if (
		value.sessionsActivePeak > value.sessionsAccepted ||
		value.publisherSessionsActivePeak > value.registeredPublisherCount ||
		value.subscriberSessionsActivePeak > value.registeredSubscriberCount ||
		value.publisherEndCount > value.registeredPublisherCount ||
		value.subscriberEndCount > value.registeredSubscriberCount
	) {
		return cohortFail("linux relay observation peak exceeds its population");
	}
	if (ns(value.relayDrainedAtLinuxNs) < ns(value.measurementStartedAtLinuxNs)) {
		return cohortFail("relay drained before measurement started");
	}
	if (ns(value.allSessionsClosedAtLinuxNs) < ns(value.relayDrainedAtLinuxNs)) {
		return cohortFail("sessions closed before the relay drained");
	}
	const capped = withinCap(
		value,
		LINUX_RELAY_OBSERVATION_MAX_BYTES,
		"linux relay observation",
	);
	if (!capped.ok) return capped;
	return { ok: true, value: value as unknown as LinuxRelayObservationV1 };
}

export interface RigRelayObservationReceiptV1 {
	readonly schema: "rig-relay-observation-receipt/v1";
	readonly executionSha256: Sha256Hex;
	readonly cohortGrantSha256: Sha256Hex;
	readonly cohortStartBarrierSha256: Sha256Hex;
	readonly linuxRelayObservationSha256: Sha256Hex;
	readonly rigExecutionAcceptanceSha256: Sha256Hex;
	readonly rigSupervisorInstanceNonce: Sha256Hex;
	readonly signingPublicKeySha256: Sha256Hex;
	readonly receiptSequence: number;
	readonly receivedAtRigNs: NsString;
	readonly issuedAtMs: number;
	readonly notAfterMs: number;
}

const RIG_RELAY_OBSERVATION_RECEIPT_KEYS = [
	"cohortGrantSha256",
	"cohortStartBarrierSha256",
	"executionSha256",
	"issuedAtMs",
	"linuxRelayObservationSha256",
	"notAfterMs",
	"receiptSequence",
	"receivedAtRigNs",
	"rigExecutionAcceptanceSha256",
	"rigSupervisorInstanceNonce",
	"schema",
	"signingPublicKeySha256",
].sort() as readonly string[];

export function parseRigRelayObservationReceipt(
	value: unknown,
): ProtocolResult<RigRelayObservationReceiptV1> {
	if (
		!isPlainObject(value) ||
		!exactKeys(value, RIG_RELAY_OBSERVATION_RECEIPT_KEYS)
	) {
		return cohortFail("rig relay observation receipt keys");
	}
	if (
		value.schema !== "rig-relay-observation-receipt/v1" ||
		!isHex64(value.executionSha256) ||
		!isHex64(value.cohortGrantSha256) ||
		!isHex64(value.cohortStartBarrierSha256) ||
		!isHex64(value.linuxRelayObservationSha256) ||
		!isHex64(value.rigExecutionAcceptanceSha256) ||
		!isHex64(value.rigSupervisorInstanceNonce) ||
		!isHex64(value.signingPublicKeySha256) ||
		!isSafeNonNegInt(value.receiptSequence) ||
		!isNsString(value.receivedAtRigNs) ||
		!isSafeNonNegInt(value.issuedAtMs) ||
		!isSafeNonNegInt(value.notAfterMs)
	) {
		return cohortFail("rig relay observation receipt fields");
	}
	if (value.notAfterMs < value.issuedAtMs) {
		return fail("RIG_RECEIPT_EXPIRED", "notAfter < issued");
	}
	const capped = withinCap(
		value,
		RIG_RELAY_OBSERVATION_RECEIPT_MAX_BYTES,
		"rig relay observation receipt",
	);
	if (!capped.ok) return capped;
	return { ok: true, value: value as unknown as RigRelayObservationReceiptV1 };
}

export interface CohortRateSeriesV1 {
	readonly schema: "cohort-rate-series/v1";
	readonly sampleUnit: "count";
	readonly sampleWindowMs: 1000;
	readonly samples: readonly number[];
	readonly measuredWindowDeliveredTotal: number;
	readonly postStopDrainDelivered: number;
	readonly conservationDeliveredTotal: number;
	readonly firstDeliveryAtMacNs: NsString;
	readonly lastMeasuredWindowDeliveryAtMacNs: NsString;
	readonly lastDeliveryIncludingDrainAtMacNs: NsString;
	readonly measuredDurationMs: 10000 | 30000;
	readonly meanNumerator: number;
	readonly meanDenominatorMs: 10000 | 30000;
}

const COHORT_RATE_SERIES_KEYS = [
	"conservationDeliveredTotal",
	"firstDeliveryAtMacNs",
	"lastDeliveryIncludingDrainAtMacNs",
	"lastMeasuredWindowDeliveryAtMacNs",
	"meanDenominatorMs",
	"meanNumerator",
	"measuredDurationMs",
	"measuredWindowDeliveredTotal",
	"postStopDrainDelivered",
	"sampleUnit",
	"sampleWindowMs",
	"samples",
	"schema",
].sort() as readonly string[];

export function parseCohortRateSeries(
	value: unknown,
): ProtocolResult<CohortRateSeriesV1> {
	if (!isPlainObject(value) || !exactKeys(value, COHORT_RATE_SERIES_KEYS)) {
		return cohortFail("cohort rate series keys");
	}
	if (
		value.schema !== "cohort-rate-series/v1" ||
		value.sampleUnit !== "count" ||
		value.sampleWindowMs !== COHORT_SAMPLE_WINDOW_MS ||
		!isOneOf(value.measuredDurationMs, COHORT_MEASURED_DURATION_MS_VALUES) ||
		!isOneOf(value.meanDenominatorMs, COHORT_MEASURED_DURATION_MS_VALUES) ||
		!isSafeNonNegInt(value.measuredWindowDeliveredTotal) ||
		!isSafeNonNegInt(value.postStopDrainDelivered) ||
		!isSafeNonNegInt(value.conservationDeliveredTotal) ||
		!isSafeNonNegInt(value.meanNumerator) ||
		!isNsString(value.firstDeliveryAtMacNs) ||
		!isNsString(value.lastMeasuredWindowDeliveryAtMacNs) ||
		!isNsString(value.lastDeliveryIncludingDrainAtMacNs)
	) {
		return cohortFail("cohort rate series fields");
	}
	const windows = value.measuredDurationMs / COHORT_SAMPLE_WINDOW_MS;
	if (!isCountArray(value.samples, windows)) {
		return cohortFail("cohort rate series sample cardinality");
	}
	if (value.meanDenominatorMs !== value.measuredDurationMs) {
		return cohortFail("meanDenominatorMs is not the measured duration");
	}
	const measured = checkedSum(value.samples);
	if (measured === null || measured !== value.measuredWindowDeliveredTotal) {
		return relayFail("samples do not sum to measuredWindowDeliveredTotal");
	}
	const conservation = checkedAdd(measured, value.postStopDrainDelivered);
	if (
		conservation === null ||
		conservation !== value.conservationDeliveredTotal
	) {
		return relayFail("measured + drain does not equal the conservation total");
	}
	const numerator = checkedMul(measured, COHORT_SAMPLE_WINDOW_MS);
	if (numerator === null || numerator !== value.meanNumerator) {
		return relayFail(
			"meanNumerator is not measuredWindowDeliveredTotal * 1000",
		);
	}
	const capped = withinCap(
		value,
		COHORT_DERIVED_RECORD_MAX_BYTES,
		"cohort rate series",
	);
	if (!capped.ok) return capped;
	return { ok: true, value: value as unknown as CohortRateSeriesV1 };
}

export interface CohortLedgerV1 {
	readonly schema: "cohort-ledger/v1";
	readonly offeredIngress: number;
	readonly serverAcceptedIngress: number;
	readonly offeredExpandedDeliveries: number;
	readonly serverAcceptedExpandedDeliveries: number;
	readonly linuxRelayWritesCompleted: number;
	readonly delivered: number;
	readonly deliveredBytes: number;
	readonly messageBytes: 100 | 128;
}

const COHORT_LEDGER_KEYS = [
	"delivered",
	"deliveredBytes",
	"linuxRelayWritesCompleted",
	"messageBytes",
	"offeredExpandedDeliveries",
	"offeredIngress",
	"schema",
	"serverAcceptedExpandedDeliveries",
	"serverAcceptedIngress",
].sort() as readonly string[];

export function parseCohortLedger(
	value: unknown,
): ProtocolResult<CohortLedgerV1> {
	if (!isPlainObject(value) || !exactKeys(value, COHORT_LEDGER_KEYS)) {
		return cohortFail("cohort ledger keys");
	}
	if (
		value.schema !== "cohort-ledger/v1" ||
		!isSafeNonNegInt(value.offeredIngress) ||
		!isSafeNonNegInt(value.serverAcceptedIngress) ||
		!isSafeNonNegInt(value.offeredExpandedDeliveries) ||
		!isSafeNonNegInt(value.serverAcceptedExpandedDeliveries) ||
		!isSafeNonNegInt(value.linuxRelayWritesCompleted) ||
		!isSafeNonNegInt(value.delivered) ||
		!isSafeNonNegInt(value.deliveredBytes) ||
		!isOneOf(value.messageBytes, COHORT_MESSAGE_BYTES_VALUES)
	) {
		return cohortFail("cohort ledger fields");
	}
	if (value.serverAcceptedIngress > value.offeredIngress) {
		return relayFail("accepted ingress exceeds offered ingress");
	}
	if (value.delivered > value.linuxRelayWritesCompleted) {
		return relayFail("delivered exceeds completed relay writes");
	}
	const bytes = checkedMul(value.delivered, value.messageBytes);
	if (bytes === null || bytes !== value.deliveredBytes) {
		return relayFail("deliveredBytes is not delivered * messageBytes");
	}
	const capped = withinCap(
		value,
		COHORT_DERIVED_RECORD_MAX_BYTES,
		"cohort ledger",
	);
	if (!capped.ok) return capped;
	return { ok: true, value: value as unknown as CohortLedgerV1 };
}

export interface CohortCapacityV1 {
	readonly schema: "cohort-capacity/v1";
	readonly expectedSessions: number;
	readonly sessionsAccepted: number;
	readonly sessionsActivePeak: number;
	readonly expectedPublishers: number;
	readonly registeredPublishers: number;
	readonly expectedSubscribers: number;
	readonly registeredSubscribers: number;
}

const COHORT_CAPACITY_KEYS = [
	"expectedPublishers",
	"expectedSessions",
	"expectedSubscribers",
	"registeredPublishers",
	"registeredSubscribers",
	"schema",
	"sessionsAccepted",
	"sessionsActivePeak",
].sort() as readonly string[];

export function parseCohortCapacity(
	value: unknown,
): ProtocolResult<CohortCapacityV1> {
	if (!isPlainObject(value) || !exactKeys(value, COHORT_CAPACITY_KEYS)) {
		return cohortFail("cohort capacity keys");
	}
	if (
		value.schema !== "cohort-capacity/v1" ||
		!isSafePosInt(value.expectedSessions) ||
		!isSafeNonNegInt(value.sessionsAccepted) ||
		!isSafeNonNegInt(value.sessionsActivePeak) ||
		!isSafePosInt(value.expectedPublishers) ||
		!isSafeNonNegInt(value.registeredPublishers) ||
		!isSafePosInt(value.expectedSubscribers) ||
		!isSafeNonNegInt(value.registeredSubscribers)
	) {
		return cohortFail("cohort capacity fields");
	}
	const expected = checkedAdd(
		value.expectedPublishers,
		value.expectedSubscribers,
	);
	if (expected === null || expected !== value.expectedSessions) {
		return cohortFail("expectedSessions is not publishers + subscribers");
	}
	const capped = withinCap(
		value,
		COHORT_DERIVED_RECORD_MAX_BYTES,
		"cohort capacity",
	);
	if (!capped.ok) return capped;
	return { ok: true, value: value as unknown as CohortCapacityV1 };
}

export interface CohortAdmissionReceiptV1 {
	readonly schema: "cohort-admission-receipt/v1";
	readonly executionSha256: Sha256Hex;
	readonly measurementGrantSha256: Sha256Hex;
	readonly macExecutionGrantReceiptSha256: Sha256Hex;
	readonly cohortGrantSha256: Sha256Hex;
	readonly cohortGrantSignatureSha256: Sha256Hex;
	readonly rigCohortAcceptanceSha256: Sha256Hex;
	readonly rigCohortAcceptanceSignatureSha256: Sha256Hex;
	readonly tokenCommitmentLeafManifestSha256: Sha256Hex;
	readonly cohortWarmupEpochSha256: Sha256Hex;
	readonly cohortWarmupEpochSignatureSha256: Sha256Hex;
	readonly roleWarmupCompletionManifestSha256: Sha256Hex;
	readonly roleWarmupCompletionManifestSignatureSha256: Sha256Hex;
	readonly serverWarmupDrainedSha256: Sha256Hex;
	readonly rigWarmupDrainedReceiptSha256: Sha256Hex;
	readonly rigWarmupDrainedReceiptSignatureSha256: Sha256Hex;
	readonly rigMeasureStartAckSha256: Sha256Hex;
	readonly rigMeasureStartAckSignatureSha256: Sha256Hex;
	readonly cohortStartBarrierSha256: Sha256Hex;
	readonly cohortStartBarrierSignatureSha256: Sha256Hex;
	readonly rigBarrierAcceptanceSha256: Sha256Hex;
	readonly rigBarrierAcceptanceSignatureSha256: Sha256Hex;
	readonly serverStartBarrierAcceptedSha256: Sha256Hex;
	readonly orderedPartialManifestSha256: Sha256Hex;
	readonly observedProcessProofSha256: Sha256Hex;
	readonly linuxRelayObservationSha256: Sha256Hex;
	readonly rigRelayObservationReceiptSha256: Sha256Hex;
	readonly rigRelayObservationReceiptSignatureSha256: Sha256Hex;
	readonly rigServerSnapshotReceiptSha256: Sha256Hex;
	readonly rigServerSnapshotReceiptSignatureSha256: Sha256Hex;
	readonly macMeasurementAdmissionReceiptSha256: Sha256Hex;
	readonly macMeasurementAdmissionSignatureSha256: Sha256Hex;
	readonly rateSeriesSha256: Sha256Hex;
	readonly ledgerSha256: Sha256Hex;
	readonly capacitySha256: Sha256Hex;
	readonly approvedPlanSha256: Sha256Hex;
	readonly approvalRecordSha256: Sha256Hex;
	readonly publisherCount: number;
	readonly workerCount: 8;
	readonly subscriberCount: number;
	readonly offeredIngress: number;
	readonly serverAcceptedIngress: number;
	readonly linuxRelayWritesCompleted: number;
	readonly delivered: number;
	readonly macSupervisorInstanceNonce: Sha256Hex;
	readonly signingPublicKeySha256: Sha256Hex;
	readonly receiptSequence: number;
	readonly issuedAtMs: number;
	readonly notAfterMs: number;
}

/** Every admission field that is a bare digest of another retained record. */
const COHORT_ADMISSION_DIGEST_KEYS = [
	"executionSha256",
	"measurementGrantSha256",
	"macExecutionGrantReceiptSha256",
	"cohortGrantSha256",
	"cohortGrantSignatureSha256",
	"rigCohortAcceptanceSha256",
	"rigCohortAcceptanceSignatureSha256",
	"tokenCommitmentLeafManifestSha256",
	"cohortWarmupEpochSha256",
	"cohortWarmupEpochSignatureSha256",
	"roleWarmupCompletionManifestSha256",
	"roleWarmupCompletionManifestSignatureSha256",
	"serverWarmupDrainedSha256",
	"rigWarmupDrainedReceiptSha256",
	"rigWarmupDrainedReceiptSignatureSha256",
	"rigMeasureStartAckSha256",
	"rigMeasureStartAckSignatureSha256",
	"cohortStartBarrierSha256",
	"cohortStartBarrierSignatureSha256",
	"rigBarrierAcceptanceSha256",
	"rigBarrierAcceptanceSignatureSha256",
	"serverStartBarrierAcceptedSha256",
	"orderedPartialManifestSha256",
	"observedProcessProofSha256",
	"linuxRelayObservationSha256",
	"rigRelayObservationReceiptSha256",
	"rigRelayObservationReceiptSignatureSha256",
	"rigServerSnapshotReceiptSha256",
	"rigServerSnapshotReceiptSignatureSha256",
	"macMeasurementAdmissionReceiptSha256",
	"macMeasurementAdmissionSignatureSha256",
	"rateSeriesSha256",
	"ledgerSha256",
	"capacitySha256",
	"approvedPlanSha256",
	"approvalRecordSha256",
	"macSupervisorInstanceNonce",
	"signingPublicKeySha256",
] as const;

const COHORT_ADMISSION_RECEIPT_KEYS = [
	"schema",
	"publisherCount",
	"workerCount",
	"subscriberCount",
	"offeredIngress",
	"serverAcceptedIngress",
	"linuxRelayWritesCompleted",
	"delivered",
	"receiptSequence",
	"issuedAtMs",
	"notAfterMs",
	...COHORT_ADMISSION_DIGEST_KEYS,
].sort() as readonly string[];

export function parseCohortAdmissionReceipt(
	value: unknown,
): ProtocolResult<CohortAdmissionReceiptV1> {
	if (
		!isPlainObject(value) ||
		!exactKeys(value, COHORT_ADMISSION_RECEIPT_KEYS)
	) {
		return cohortFail("cohort admission receipt keys");
	}
	if (value.schema !== "cohort-admission-receipt/v1") {
		return cohortFail("cohort admission receipt schema");
	}
	for (const key of COHORT_ADMISSION_DIGEST_KEYS) {
		if (!isHex64(value[key])) {
			return cohortFail(`cohort admission receipt ${key}`);
		}
	}
	if (
		!isSafePosInt(value.publisherCount) ||
		value.publisherCount > COHORT_MAX_PUBLISHERS ||
		value.workerCount !== COHORT_WORKER_COUNT ||
		!isSafePosInt(value.subscriberCount) ||
		!isSafeNonNegInt(value.offeredIngress) ||
		!isSafeNonNegInt(value.serverAcceptedIngress) ||
		!isSafeNonNegInt(value.linuxRelayWritesCompleted) ||
		!isSafeNonNegInt(value.delivered) ||
		!isSafeNonNegInt(value.receiptSequence) ||
		!isSafeNonNegInt(value.issuedAtMs) ||
		!isSafeNonNegInt(value.notAfterMs)
	) {
		return cohortFail("cohort admission receipt fields");
	}
	if (value.notAfterMs < value.issuedAtMs) {
		return fail("MAC_GRANT_EXPIRED", "notAfter < issued");
	}
	const capped = withinCap(
		value,
		COHORT_ADMISSION_RECEIPT_MAX_BYTES,
		"cohort admission receipt",
	);
	if (!capped.ok) return capped;
	return { ok: true, value: value as unknown as CohortAdmissionReceiptV1 };
}

// ---------------------------------------------------------------------------
// §4.5 offline recomputation: event windows, origin conservation, ledger, rate
// ---------------------------------------------------------------------------

export type CohortDeliveryClassification =
	| "measured-window"
	| "after-measure-stop";

export interface CohortDeliveryEventV1 {
	readonly classification: CohortDeliveryClassification;
	/** The measured event window, or `null` for a post-stop drain completion. */
	readonly eventWindow: number | null;
}

/**
 * Event window `e = floor((deliveredAtMacNs - measureStartAtMacNs)/1e9)`.
 *
 * This is deliberately the ONLY window derivation for acknowledgement, relay
 * completion, and delivery. It never touches `originWindowIndex`, so honest
 * boundary latency moves the rate event and leaves conservation alone.
 */
export function computeCohortEventWindow(args: {
	readonly deliveredAtMacNs: NsString;
	readonly measureStartAtMacNs: NsString;
	readonly measureStopAtMacNs: NsString;
	readonly windowCount: 10 | 30;
}): ProtocolResult<CohortDeliveryEventV1> {
	if (
		!isNsString(args.deliveredAtMacNs) ||
		!isNsString(args.measureStartAtMacNs) ||
		!isNsString(args.measureStopAtMacNs)
	) {
		return measurementFail("event window inputs are not nanosecond strings");
	}
	if (!isOneOf(args.windowCount, COHORT_WINDOW_COUNT_VALUES)) {
		return measurementFail("windowCount is not 10 or 30");
	}
	const start = ns(args.measureStartAtMacNs);
	const stop = ns(args.measureStopAtMacNs);
	// The stop instant is not negotiable: it is exactly windowCount seconds.
	if (stop - start !== BigInt(args.windowCount) * NANOSECONDS_PER_SECOND_BIG) {
		return measurementFail("measure stop is not start + windowCount seconds");
	}
	const at = ns(args.deliveredAtMacNs);
	if (at < start) {
		return measurementFail("event timestamp precedes the barrier start");
	}
	const drainDeadline = stop + BigInt(COHORT_DRAIN_DEADLINE_MS) * NS_PER_MS_BIG;
	if (at > drainDeadline) {
		return measurementFail("event timestamp is past the drain deadline");
	}
	if (at >= stop) {
		return {
			ok: true,
			value: { classification: "after-measure-stop", eventWindow: null },
		};
	}
	const window = Number((at - start) / NANOSECONDS_PER_SECOND_BIG);
	if (!isSafeNonNegInt(window) || window >= args.windowCount) {
		return measurementFail("event window is outside 0 <= e < windowCount");
	}
	return {
		ok: true,
		value: { classification: "measured-window", eventWindow: window },
	};
}

export interface CohortOriginConservationV1 {
	readonly windowCount: 10 | 30;
	readonly subscriberCount: number;
	readonly messageBytes: 100 | 128;
	/** O: publisher-offered ingress per origin window. */
	readonly offeredByOriginWindow: readonly number[];
	/** OA: acknowledgements the publishers saw, attributed to their origin. */
	readonly acceptedAckSeenByOriginWindow: readonly number[];
	/** A: Linux accepted ingress, the sole ingress authority. */
	readonly acceptedIngressByOriginWindow: readonly number[];
	/** L: Linux relay writes completed. */
	readonly relayWritesCompletedByOriginWindow: readonly number[];
	/** D: subscriber deliveries, attributed to the immutable origin window. */
	readonly deliveredByOriginWindow: readonly number[];
	/** DB: delivered bytes, attributed to the same origin window. */
	readonly deliveredBytesByOriginWindow: readonly number[];
	readonly offeredIngressTotal: number;
	readonly serverAcceptedIngressTotal: number;
	readonly linuxRelayWritesCompletedTotal: number;
	readonly deliveredTotal: number;
	readonly deliveredBytesTotal: number;
}

/**
 * Recompute the §4.5 origin-window conservation from the retained publisher,
 * Linux, and worker partial bytes. Only origin-window arrays participate: the
 * event-window arrays are a different observation entirely.
 */
export function recomputeCohortOriginConservation(args: {
	readonly publisherPartials: readonly unknown[];
	readonly workerPartials: readonly unknown[];
	readonly linuxRelayObservation: unknown;
	readonly subscriberCount: number;
	readonly messageBytes: 100 | 128;
}): ProtocolResult<CohortOriginConservationV1> {
	if (!isSafePosInt(args.subscriberCount)) {
		return relayFail("subscriberCount must be a positive safe integer");
	}
	if (!isOneOf(args.messageBytes, COHORT_MESSAGE_BYTES_VALUES)) {
		return relayFail("messageBytes is not a frozen payload size");
	}
	const linux = parseLinuxRelayObservation(args.linuxRelayObservation);
	if (!linux.ok) return linux;
	const windows = linux.value.windowCount;
	if (
		args.publisherPartials.length === 0 ||
		args.publisherPartials.length > COHORT_MAX_PUBLISHERS
	) {
		return relayFail("publisher partial count is outside 1..10");
	}
	if (args.workerPartials.length !== COHORT_WORKER_COUNT) {
		return relayFail(`worker partial count must be ${COHORT_WORKER_COUNT}`);
	}
	const publishers: PublisherPartialV1[] = [];
	for (const candidate of args.publisherPartials) {
		const parsed = parsePublisherPartial(candidate);
		if (!parsed.ok) return parsed;
		if (parsed.value.windowCount !== windows) {
			return relayFail("publisher windowCount disagrees with the relay");
		}
		publishers.push(parsed.value);
	}
	const workers: WorkerPartialV1[] = [];
	let workerSubscriberTotal = 0;
	for (const candidate of args.workerPartials) {
		const parsed = parseWorkerPartial(candidate);
		if (!parsed.ok) return parsed;
		if (parsed.value.windowCount !== windows) {
			return relayFail("worker windowCount disagrees with the relay");
		}
		const next = checkedAdd(
			workerSubscriberTotal,
			parsed.value.subscriberCount,
		);
		if (next === null) return relayFail("worker subscriber total overflow");
		workerSubscriberTotal = next;
		workers.push(parsed.value);
	}
	if (workerSubscriberTotal !== args.subscriberCount) {
		return relayFail("shard subscriber counts do not sum to subscriberCount");
	}
	if (linux.value.registeredSubscriberCount !== args.subscriberCount) {
		return relayFail("relay registered a different subscriber population");
	}
	if (linux.value.registeredPublisherCount !== publishers.length) {
		return relayFail("relay registered a different publisher population");
	}

	const offered: number[] = [];
	const acceptedAck: number[] = [];
	const delivered: number[] = [];
	const deliveredBytes: number[] = [];
	for (let w = 0; w < windows; w += 1) {
		const o = checkedSum(publishers.map((p) => p.offeredByOriginWindow[w]!));
		const oa = checkedSum(
			publishers.map((p) => p.acceptedAckSeenByOriginWindow[w]!),
		);
		const d = checkedSum(
			workers.map((worker) => worker.deliveredByOriginWindow[w]!),
		);
		const db = checkedSum(
			workers.map((worker) => worker.deliveredBytesByOriginWindow[w]!),
		);
		if (o === null || oa === null || d === null || db === null) {
			return relayFail(`origin window ${w} sum overflows`);
		}
		const a = linux.value.acceptedIngressByOriginWindow[w]!;
		const l = linux.value.relayWritesCompletedByOriginWindow[w]!;
		// OA[w] = A[w]: the publishers' acknowledgements and the relay's own
		// accepted ingress are the same event counted at two places.
		if (oa !== a) {
			return relayFail(
				`window ${w}: acknowledged ${oa} != accepted ingress ${a}`,
			);
		}
		if (a > o) {
			return relayFail(`window ${w}: accepted ${a} exceeds offered ${o}`);
		}
		const expanded = checkedMul(a, args.subscriberCount);
		if (expanded === null) return relayFail(`window ${w}: expansion overflows`);
		if (l > expanded) {
			return relayFail(
				`window ${w}: relay writes ${l} exceed expansion ${expanded}`,
			);
		}
		if (d > l) {
			return relayFail(`window ${w}: delivered ${d} exceeds relay writes ${l}`);
		}
		const bytes = checkedMul(d, args.messageBytes);
		if (bytes === null || bytes !== db) {
			return relayFail(
				`window ${w}: delivered bytes are not delivered * messageBytes`,
			);
		}
		const undelivered = checkedSum([
			l,
			linux.value.queueDropDeliveriesByOriginWindow[w]!,
			linux.value.writeTimeoutDeliveriesByOriginWindow[w]!,
			linux.value.disconnectUndeliveredByOriginWindow[w]!,
		]);
		if (undelivered === null)
			return relayFail(`window ${w}: outcome sum overflows`);
		if (undelivered !== expanded) {
			return relayFail(
				`window ${w}: relay outcomes ${undelivered} do not account for ${expanded} expanded deliveries`,
			);
		}
		offered.push(o);
		acceptedAck.push(oa);
		delivered.push(d);
		deliveredBytes.push(db);
	}
	const offeredTotal = checkedSum(offered);
	const acceptedTotal = checkedSum(linux.value.acceptedIngressByOriginWindow);
	const relayTotal = checkedSum(linux.value.relayWritesCompletedByOriginWindow);
	const deliveredTotal = checkedSum(delivered);
	const deliveredBytesTotal = checkedSum(deliveredBytes);
	if (
		offeredTotal === null ||
		acceptedTotal === null ||
		relayTotal === null ||
		deliveredTotal === null ||
		deliveredBytesTotal === null
	) {
		return relayFail("conservation totals overflow");
	}
	return {
		ok: true,
		value: {
			windowCount: windows,
			subscriberCount: args.subscriberCount,
			messageBytes: args.messageBytes,
			offeredByOriginWindow: offered,
			acceptedAckSeenByOriginWindow: acceptedAck,
			acceptedIngressByOriginWindow: [
				...linux.value.acceptedIngressByOriginWindow,
			],
			relayWritesCompletedByOriginWindow: [
				...linux.value.relayWritesCompletedByOriginWindow,
			],
			deliveredByOriginWindow: delivered,
			deliveredBytesByOriginWindow: deliveredBytes,
			offeredIngressTotal: offeredTotal,
			serverAcceptedIngressTotal: acceptedTotal,
			linuxRelayWritesCompletedTotal: relayTotal,
			deliveredTotal,
			deliveredBytesTotal,
		},
	};
}

/** The §4.5 ledger is a pure projection of the origin-window conservation. */
export function recomputeCohortLedger(args: {
	readonly conservation: CohortOriginConservationV1;
	readonly subscriberCount: number;
	readonly messageBytes: 100 | 128;
}): ProtocolResult<CohortLedgerV1> {
	const { conservation } = args;
	if (
		conservation.subscriberCount !== args.subscriberCount ||
		conservation.messageBytes !== args.messageBytes
	) {
		return relayFail("ledger inputs disagree with the conservation record");
	}
	const offeredExpanded = checkedMul(
		conservation.offeredIngressTotal,
		args.subscriberCount,
	);
	const acceptedExpanded = checkedMul(
		conservation.serverAcceptedIngressTotal,
		args.subscriberCount,
	);
	if (offeredExpanded === null || acceptedExpanded === null) {
		return relayFail("expanded delivery totals overflow");
	}
	return parseCohortLedger({
		schema: "cohort-ledger/v1",
		offeredIngress: conservation.offeredIngressTotal,
		serverAcceptedIngress: conservation.serverAcceptedIngressTotal,
		offeredExpandedDeliveries: offeredExpanded,
		serverAcceptedExpandedDeliveries: acceptedExpanded,
		linuxRelayWritesCompleted: conservation.linuxRelayWritesCompletedTotal,
		delivered: conservation.deliveredTotal,
		deliveredBytes: conservation.deliveredBytesTotal,
		messageBytes: args.messageBytes,
	});
}

/**
 * The rate series is built ONLY from the workers' event-window arrays and the
 * post-stop drain counter. Its sole tie to conservation is the identity
 * `conservationDeliveredTotal = measured + drain`; there is deliberately no
 * equation binding an event window to an origin window.
 */
export function recomputeCohortRateSeries(args: {
	readonly workerPartials: readonly unknown[];
	readonly conservation: CohortOriginConservationV1;
	readonly windowCount: 10 | 30;
	readonly measuredDurationMs: 10000 | 30000;
	readonly firstDeliveryAtMacNs: NsString;
	readonly lastMeasuredWindowDeliveryAtMacNs: NsString;
	readonly lastDeliveryIncludingDrainAtMacNs: NsString;
}): ProtocolResult<CohortRateSeriesV1> {
	if (!isOneOf(args.windowCount, COHORT_WINDOW_COUNT_VALUES)) {
		return measurementFail("windowCount is not 10 or 30");
	}
	if (!isOneOf(args.measuredDurationMs, COHORT_MEASURED_DURATION_MS_VALUES)) {
		return measurementFail("measuredDurationMs is not a frozen duration");
	}
	if (args.measuredDurationMs !== args.windowCount * COHORT_SAMPLE_WINDOW_MS) {
		return measurementFail("measuredDurationMs disagrees with windowCount");
	}
	if (args.conservation.windowCount !== args.windowCount) {
		return measurementFail("conservation windowCount disagrees");
	}
	if (args.workerPartials.length !== COHORT_WORKER_COUNT) {
		return relayFail(`worker partial count must be ${COHORT_WORKER_COUNT}`);
	}
	const workers: WorkerPartialV1[] = [];
	for (const candidate of args.workerPartials) {
		const parsed = parseWorkerPartial(candidate);
		if (!parsed.ok) return parsed;
		if (parsed.value.windowCount !== args.windowCount) {
			return measurementFail("worker windowCount disagrees");
		}
		workers.push(parsed.value);
	}
	const samples: number[] = [];
	for (let e = 0; e < args.windowCount; e += 1) {
		const sample = checkedSum(workers.map((w) => w.deliveredByEventWindow[e]!));
		if (sample === null) return relayFail(`event window ${e} sum overflows`);
		samples.push(sample);
	}
	const measured = checkedSum(samples);
	const drain = checkedSum(workers.map((w) => w.deliveredAfterMeasureStop));
	const measuredBytes = checkedSum(
		workers.flatMap((w) => [...w.deliveredBytesByEventWindow]),
	);
	const drainBytes = checkedSum(
		workers.map((w) => w.deliveredBytesAfterMeasureStop),
	);
	if (
		measured === null ||
		drain === null ||
		measuredBytes === null ||
		drainBytes === null
	) {
		return relayFail("rate series totals overflow");
	}
	const totalBytes = checkedAdd(measuredBytes, drainBytes);
	if (
		totalBytes === null ||
		totalBytes !== args.conservation.deliveredBytesTotal
	) {
		return relayFail(
			"event-window bytes do not reconcile with delivered bytes",
		);
	}
	const meanNumerator = checkedMul(measured, COHORT_SAMPLE_WINDOW_MS);
	if (meanNumerator === null) return relayFail("meanNumerator overflows");
	return parseCohortRateSeries({
		schema: "cohort-rate-series/v1",
		sampleUnit: "count",
		sampleWindowMs: COHORT_SAMPLE_WINDOW_MS,
		samples,
		measuredWindowDeliveredTotal: measured,
		postStopDrainDelivered: drain,
		conservationDeliveredTotal: args.conservation.deliveredTotal,
		firstDeliveryAtMacNs: args.firstDeliveryAtMacNs,
		lastMeasuredWindowDeliveryAtMacNs: args.lastMeasuredWindowDeliveryAtMacNs,
		lastDeliveryIncludingDrainAtMacNs: args.lastDeliveryIncludingDrainAtMacNs,
		measuredDurationMs: args.measuredDurationMs,
		meanNumerator,
		meanDenominatorMs: args.measuredDurationMs,
	});
}

// ---------------------------------------------------------------------------
// The six-cell cardinality table: physical-budget amendment D3, which replaces
// the base plan's §4.5 rows with the ones the measured hardware budget admits
// ---------------------------------------------------------------------------

export type CohortCellId =
	| "ticker 50"
	| "ticker 100"
	| "ticker 250"
	| "chat 250"
	| "chat 500"
	| "chat 1k";

export interface CohortCellCardinalityV1 {
	readonly cell: CohortCellId;
	readonly publisherCount: number;
	readonly workerCount: 8;
	readonly subscriberCount: number;
	readonly sessionCount: number;
	readonly measuredIngress: number;
	readonly expandedDeliveries: number;
}

/** The exact D3 table; nothing here is derived at runtime from a knob. */
export const COHORT_CELL_CARDINALITIES: readonly CohortCellCardinalityV1[] = [
	{
		cell: "ticker 50",
		publisherCount: 1,
		workerCount: 8,
		subscriberCount: 100,
		sessionCount: 101,
		measuredIngress: 500,
		expandedDeliveries: 50_000,
	},
	{
		cell: "ticker 100",
		publisherCount: 1,
		workerCount: 8,
		subscriberCount: 100,
		sessionCount: 101,
		measuredIngress: 1_000,
		expandedDeliveries: 100_000,
	},
	{
		cell: "ticker 250",
		publisherCount: 1,
		workerCount: 8,
		subscriberCount: 100,
		sessionCount: 101,
		measuredIngress: 2_500,
		expandedDeliveries: 250_000,
	},
	{
		cell: "chat 250",
		publisherCount: 10,
		workerCount: 8,
		subscriberCount: 250,
		sessionCount: 260,
		measuredIngress: 300,
		expandedDeliveries: 75_000,
	},
	{
		cell: "chat 500",
		publisherCount: 10,
		workerCount: 8,
		subscriberCount: 500,
		sessionCount: 510,
		measuredIngress: 300,
		expandedDeliveries: 150_000,
	},
	{
		cell: "chat 1k",
		publisherCount: 10,
		workerCount: 8,
		subscriberCount: 1_000,
		sessionCount: 1_010,
		measuredIngress: 300,
		expandedDeliveries: 300_000,
	},
] as const;

export function cohortCellCardinality(cell: string): CohortCellCardinalityV1 {
	const row = COHORT_CELL_CARDINALITIES.find((entry) => entry.cell === cell);
	if (row === undefined) throw new RangeError(`unknown cohort cell ${cell}`);
	return row;
}

// ---------------------------------------------------------------------------
// Per-cell grant parameters — a selection inside the frozen unions, not a
// narrowing of them
// ---------------------------------------------------------------------------

/**
 * `measuredDurationMs` and `messageBytes` are open unions on `CohortGrantV1`
 * (`10000 | 30000` and `100 | 128`) and nothing in the repo chose either per
 * cell, so every mint was free to pick a different one for the same cell and
 * no verifier could tell. This table is that choice, made once.
 *
 * It is deliberately **not** two more columns on `COHORT_CELL_CARDINALITIES`:
 * that constant is the §4.5 table and its own comment says so, §4.5 has seven
 * columns, and neither of these is one of them. Selecting a value inside a
 * frozen union is not the same act as widening the table the union sits
 * beside, and only one of the two is a contract edit.
 *
 * `messageBytes` is a derivation, not a choice: plan §4.2 fixes the payload at
 * exactly 100 bytes ticker and 128 bytes chat, so the cell family decides it.
 *
 * `measuredDurationMs` is a derivation on the three ticker cells and a choice
 * on the three chat cells. A ticker cell id names an offered ingress *rate*
 * and its §4.5 row carries an offered ingress *count*; the quotient is the
 * window, and for all three it is 10 s — the only other legal value, 30 s,
 * contradicts the row. A chat cell id names a subscriber count and fixes no
 * rate, so 30 s is chosen there: it gives the §4.5 rate series thirty windows
 * instead of ten, which is the shape the conservation and mean-denominator
 * equations are written against.
 */
export interface CohortCellGrantParametersV1 {
	readonly cell: CohortCellId;
	readonly measuredDurationMs: 10000 | 30000;
	readonly messageBytes: 100 | 128;
}

export const COHORT_CELL_GRANT_PARAMETERS: readonly CohortCellGrantParametersV1[] =
	[
		{ cell: "ticker 50", measuredDurationMs: 10_000, messageBytes: 100 },
		{ cell: "ticker 100", measuredDurationMs: 10_000, messageBytes: 100 },
		{ cell: "ticker 250", measuredDurationMs: 10_000, messageBytes: 100 },
		{ cell: "chat 250", measuredDurationMs: 30_000, messageBytes: 128 },
		{ cell: "chat 500", measuredDurationMs: 30_000, messageBytes: 128 },
		{ cell: "chat 1k", measuredDurationMs: 30_000, messageBytes: 128 },
	] as const;

export function cohortCellGrantParameters(
	cell: string,
): CohortCellGrantParametersV1 {
	const row = COHORT_CELL_GRANT_PARAMETERS.find((entry) => entry.cell === cell);
	if (row === undefined) throw new RangeError(`unknown cohort cell ${cell}`);
	return row;
}

// ---------------------------------------------------------------------------
// The single terminal raw cohort-evidence export
// ---------------------------------------------------------------------------

export interface CohortObservationEvidenceV1 {
	readonly schema: "cohort-observation-evidence/v1";
	readonly workloadRolePlanInput: RetainedCanonicalBytesV1;
	readonly cohortGrant: RetainedCanonicalBytesV1;
	readonly cohortGrantSignature: RetainedCanonicalBytesV1;
	readonly rigCohortAcceptance: RetainedCanonicalBytesV1;
	readonly rigCohortAcceptanceSignature: RetainedCanonicalBytesV1;
	readonly tokenCommitmentLeafManifest: RetainedCanonicalBytesV1;
	readonly cohortWarmupEpoch: RetainedCanonicalBytesV1;
	readonly cohortWarmupEpochSignature: RetainedCanonicalBytesV1;
	readonly roleWarmupCompletionManifest: RetainedCanonicalBytesV1;
	readonly roleWarmupCompletionManifestSignature: RetainedCanonicalBytesV1;
	readonly roleWarmupCompletes: readonly RetainedCanonicalBytesV1[];
	readonly serverWarmupDrained: RetainedCanonicalBytesV1;
	readonly rigWarmupDrainedReceipt: RetainedCanonicalBytesV1;
	readonly rigWarmupDrainedReceiptSignature: RetainedCanonicalBytesV1;
	readonly rigMeasureStartAck: RetainedCanonicalBytesV1;
	readonly rigMeasureStartAckSignature: RetainedCanonicalBytesV1;
	readonly cohortStartBarrier: RetainedCanonicalBytesV1;
	readonly cohortStartBarrierSignature: RetainedCanonicalBytesV1;
	readonly rigBarrierAcceptance: RetainedCanonicalBytesV1;
	readonly rigBarrierAcceptanceSignature: RetainedCanonicalBytesV1;
	readonly serverStartBarrierAccepted: RetainedCanonicalBytesV1;
	readonly publisherPartials: readonly RetainedCanonicalBytesV1[];
	readonly workerPartials: readonly RetainedCanonicalBytesV1[];
	readonly orderedPartialManifest: RetainedCanonicalBytesV1;
	readonly observedProcessProof: RetainedCanonicalBytesV1;
	readonly linuxRelayObservation: RetainedCanonicalBytesV1;
	readonly rigRelayObservationReceipt: RetainedCanonicalBytesV1;
	readonly rigRelayObservationReceiptSignature: RetainedCanonicalBytesV1;
	readonly rateSeries: RetainedCanonicalBytesV1;
	readonly ledger: RetainedCanonicalBytesV1;
	readonly capacity: RetainedCanonicalBytesV1;
	readonly cohortAdmissionReceipt: RetainedCanonicalBytesV1;
	readonly cohortAdmissionSignature: RetainedCanonicalBytesV1;
}

/** Per-member decoded caps; nothing in the export is uncapped. */
const COHORT_EVIDENCE_MEMBER_CAPS: Readonly<Record<string, number>> = {
	workloadRolePlanInput: WORKLOAD_ROLE_PLAN_INPUT_MAX_BYTES,
	cohortGrant: COHORT_GRANT_MAX_BYTES,
	cohortGrantSignature: COHORT_SIGNATURE_RECORD_MAX_BYTES,
	rigCohortAcceptance: RIG_RELAY_OBSERVATION_RECEIPT_MAX_BYTES,
	rigCohortAcceptanceSignature: COHORT_SIGNATURE_RECORD_MAX_BYTES,
	tokenCommitmentLeafManifest: TOKEN_COMMITMENT_LEAF_MANIFEST_MAX_BYTES,
	cohortWarmupEpoch: COHORT_WARMUP_EPOCH_MAX_BYTES,
	cohortWarmupEpochSignature: COHORT_SIGNATURE_RECORD_MAX_BYTES,
	roleWarmupCompletionManifest: ROLE_WARMUP_COMPLETION_MANIFEST_MAX_BYTES,
	roleWarmupCompletionManifestSignature: COHORT_SIGNATURE_RECORD_MAX_BYTES,
	serverWarmupDrained: COHORT_DERIVED_RECORD_MAX_BYTES,
	rigWarmupDrainedReceipt: RIG_RELAY_OBSERVATION_RECEIPT_MAX_BYTES,
	rigWarmupDrainedReceiptSignature: COHORT_SIGNATURE_RECORD_MAX_BYTES,
	rigMeasureStartAck: RIG_RELAY_OBSERVATION_RECEIPT_MAX_BYTES,
	rigMeasureStartAckSignature: COHORT_SIGNATURE_RECORD_MAX_BYTES,
	cohortStartBarrier: COHORT_DERIVED_RECORD_MAX_BYTES,
	cohortStartBarrierSignature: COHORT_SIGNATURE_RECORD_MAX_BYTES,
	rigBarrierAcceptance: RIG_RELAY_OBSERVATION_RECEIPT_MAX_BYTES,
	rigBarrierAcceptanceSignature: COHORT_SIGNATURE_RECORD_MAX_BYTES,
	serverStartBarrierAccepted: COHORT_DERIVED_RECORD_MAX_BYTES,
	orderedPartialManifest: ORDERED_PARTIAL_MANIFEST_MAX_BYTES,
	observedProcessProof: OBSERVED_PROCESS_PROOF_MAX_BYTES,
	linuxRelayObservation: LINUX_RELAY_OBSERVATION_MAX_BYTES,
	rigRelayObservationReceipt: RIG_RELAY_OBSERVATION_RECEIPT_MAX_BYTES,
	rigRelayObservationReceiptSignature: COHORT_SIGNATURE_RECORD_MAX_BYTES,
	rateSeries: COHORT_DERIVED_RECORD_MAX_BYTES,
	ledger: COHORT_DERIVED_RECORD_MAX_BYTES,
	capacity: COHORT_DERIVED_RECORD_MAX_BYTES,
	cohortAdmissionReceipt: COHORT_ADMISSION_RECEIPT_MAX_BYTES,
	cohortAdmissionSignature: COHORT_ADMISSION_SIGNATURE_MAX_BYTES,
};

const COHORT_EVIDENCE_ARRAY_KEYS = [
	"roleWarmupCompletes",
	"publisherPartials",
	"workerPartials",
] as const;

const COHORT_OBSERVATION_EVIDENCE_KEYS = [
	"schema",
	...Object.keys(COHORT_EVIDENCE_MEMBER_CAPS),
	...COHORT_EVIDENCE_ARRAY_KEYS,
].sort() as readonly string[];

/** Decode one retained member and hand back both the bytes and the JSON. */
function retainedRecord(
	value: unknown,
	cap: number,
	label: string,
): ProtocolResult<{
	readonly retained: RetainedCanonicalBytesV1;
	readonly bytes: Uint8Array;
	readonly json: unknown;
}> {
	const retained = parseRetainedCanonicalBytes(value, cap);
	if (!retained.ok)
		return cohortFail(`${label}: ${retained.message ?? "retained"}`);
	if (retained.value.byteLength > cap) {
		return cohortFail(
			`${label} decoded ${retained.value.byteLength} exceeds ${cap}`,
		);
	}
	const bytes = fromBase64(retained.value.bytesBase64);
	if (bytes === null) return cohortFail(`${label} base64`);
	const json = parseStrictJsonBytes(bytes);
	if (!json.ok) return cohortFail(`${label} is not strict canonical JSON`);
	return {
		ok: true,
		value: { retained: retained.value, bytes, json: json.value },
	};
}

/**
 * Parse the exported evidence and re-verify every internal binding: ordered
 * partials, the manifest digests, the process proof, the rig receipt over the
 * exact Linux observation, and the admission receipt over the derived records.
 * A genuine receipt paired with different raw bytes fails here.
 */
export function parseCohortObservationEvidence(args: {
	readonly evidence: unknown;
	readonly expectedPublisherCount: number;
	readonly expectedSubscriberCount: number;
	readonly expectedExecutionSha256?: Sha256Hex;
	readonly expectedCohortGrantSha256?: Sha256Hex;
}): ProtocolResult<CohortObservationEvidenceV1> {
	const value = args.evidence;
	if (
		!isPlainObject(value) ||
		!exactKeys(value, COHORT_OBSERVATION_EVIDENCE_KEYS)
	) {
		return cohortFail("cohort observation evidence keys");
	}
	if (value.schema !== "cohort-observation-evidence/v1") {
		return cohortFail("cohort observation evidence schema");
	}
	if (
		!isSafePosInt(args.expectedPublisherCount) ||
		args.expectedPublisherCount > COHORT_MAX_PUBLISHERS ||
		!isSafePosInt(args.expectedSubscriberCount)
	) {
		return cohortFail("cohort observation evidence expected cardinality");
	}
	// Every scalar member is a retained record inside its own cap.
	const members = new Map<
		string,
		{ retained: RetainedCanonicalBytesV1; json: unknown }
	>();
	for (const [key, cap] of Object.entries(COHORT_EVIDENCE_MEMBER_CAPS)) {
		const member = retainedRecord(value[key], cap, key);
		if (!member.ok) return member;
		members.set(key, {
			retained: member.value.retained,
			json: member.value.json,
		});
	}
	for (const key of COHORT_EVIDENCE_ARRAY_KEYS) {
		if (!Array.isArray(value[key]))
			return cohortFail(`${key} must be an array`);
	}
	const expectedWarmupCompletes = checkedAdd(
		args.expectedPublisherCount,
		COHORT_WORKER_COUNT,
	);
	if (
		expectedWarmupCompletes === null ||
		(value.roleWarmupCompletes as unknown[]).length !== expectedWarmupCompletes
	) {
		return cohortFail("roleWarmupCompletes cardinality");
	}
	for (const frame of value.roleWarmupCompletes as unknown[]) {
		const parsed = parseRetainedCanonicalBytes(
			frame,
			ROLE_CHILD_FRAME_MAX_BYTES,
		);
		if (!parsed.ok) return parsed;
		if (parsed.value.byteLength > ROLE_CHILD_FRAME_MAX_BYTES) {
			return cohortFail(
				"retained warmup completion frame exceeds the child cap",
			);
		}
	}

	// Publishers ascend; workers are exactly 0..7 in order. A dropped, repeated,
	// or transposed partial is caught here, before any digest is believed.
	const publisherPartials = value.publisherPartials as unknown[];
	if (publisherPartials.length !== args.expectedPublisherCount) {
		return cohortFail("publisherPartials cardinality");
	}
	const publisherRetained: RetainedCanonicalBytesV1[] = [];
	const publisherRecords: PublisherPartialV1[] = [];
	let previousPublisherId = "";
	for (const candidate of publisherPartials) {
		const member = retainedRecord(
			candidate,
			PUBLISHER_PARTIAL_MAX_BYTES,
			"publisherPartials",
		);
		if (!member.ok) return member;
		const parsed = parsePublisherPartial(member.value.json);
		if (!parsed.ok) return parsed;
		if (
			parsed.value.publisherId <= previousPublisherId &&
			previousPublisherId !== ""
		) {
			return cohortFail(
				"publisher partials are not in ascending publisher order",
			);
		}
		previousPublisherId = parsed.value.publisherId;
		publisherRetained.push(member.value.retained);
		publisherRecords.push(parsed.value);
	}
	const workerPartials = value.workerPartials as unknown[];
	if (workerPartials.length !== COHORT_WORKER_COUNT) {
		return cohortFail("workerPartials cardinality");
	}
	const workerRetained: RetainedCanonicalBytesV1[] = [];
	const workerRecords: WorkerPartialV1[] = [];
	for (let index = 0; index < workerPartials.length; index += 1) {
		const member = retainedRecord(
			workerPartials[index],
			WORKER_PARTIAL_MAX_BYTES,
			"workerPartials",
		);
		if (!member.ok) return member;
		const parsed = parseWorkerPartial(member.value.json);
		if (!parsed.ok) return parsed;
		if (parsed.value.workerIndex !== index) {
			return cohortFail(`worker partial at position ${index} is out of order`);
		}
		workerRetained.push(member.value.retained);
		workerRecords.push(parsed.value);
	}

	const linuxMember = members.get("linuxRelayObservation")!;
	const linux = parseLinuxRelayObservation(linuxMember.json);
	if (!linux.ok) return linux;
	const rigReceiptMember = members.get("rigRelayObservationReceipt")!;
	const rigReceipt = parseRigRelayObservationReceipt(rigReceiptMember.json);
	if (!rigReceipt.ok) return rigReceipt;
	// Receipt swap: a genuine rig receipt over a different Linux observation.
	if (
		rigReceipt.value.linuxRelayObservationSha256 !== linuxMember.retained.sha256
	) {
		return cohortFail(
			"rig receipt does not cover the retained Linux observation",
		);
	}

	const manifestMember = members.get("orderedPartialManifest")!;
	const manifest = parseOrderedPartialManifest(manifestMember.json);
	if (!manifest.ok) return manifest;
	if (manifest.value.publisherPartialCount !== publisherRecords.length) {
		return cohortFail("manifest publisher count disagrees with the partials");
	}
	const orderedRetained = [...publisherRetained, ...workerRetained];
	const orderedChildIds = [
		...publisherRecords.map((record) => record.childId),
		...workerRecords.map((record) => record.childId),
	];
	for (let index = 0; index < orderedRetained.length; index += 1) {
		const entry = manifest.value.entries[index]!;
		const retained = orderedRetained[index]!;
		if (
			entry.partialSha256 !== retained.sha256 ||
			entry.partialSize !== retained.byteLength ||
			entry.childId !== orderedChildIds[index]
		) {
			return cohortFail(
				`manifest entry ${index} does not cover the retained bytes`,
			);
		}
	}

	const proofMember = members.get("observedProcessProof")!;
	const proof = parseObservedProcessProof(proofMember.json);
	if (!proof.ok) return proof;
	if (
		proof.value.observedPublisherCount !== publisherRecords.length ||
		proof.value.observedSubscriberCount !== args.expectedSubscriberCount
	) {
		return cohortFail("process proof cardinality disagrees with the export");
	}
	for (let index = 0; index < orderedRetained.length; index += 1) {
		const child = proof.value.children[index]!;
		if (
			child.partialSha256 !== orderedRetained[index]!.sha256 ||
			child.childId !== orderedChildIds[index]
		) {
			return cohortFail(
				`process proof child ${index} names other partial bytes`,
			);
		}
	}

	const seriesMember = members.get("rateSeries")!;
	const series = parseCohortRateSeries(seriesMember.json);
	if (!series.ok) return series;
	const ledgerMember = members.get("ledger")!;
	const ledger = parseCohortLedger(ledgerMember.json);
	if (!ledger.ok) return ledger;
	const capacityMember = members.get("capacity")!;
	const capacity = parseCohortCapacity(capacityMember.json);
	if (!capacity.ok) return capacity;

	const admissionMember = members.get("cohortAdmissionReceipt")!;
	const admission = parseCohortAdmissionReceipt(admissionMember.json);
	if (!admission.ok) return admission;
	const admissionBindings: readonly [Sha256Hex, Sha256Hex, string][] = [
		[
			admission.value.orderedPartialManifestSha256,
			manifestMember.retained.sha256,
			"orderedPartialManifest",
		],
		[
			admission.value.observedProcessProofSha256,
			proofMember.retained.sha256,
			"observedProcessProof",
		],
		[
			admission.value.linuxRelayObservationSha256,
			linuxMember.retained.sha256,
			"linuxRelayObservation",
		],
		[
			admission.value.rigRelayObservationReceiptSha256,
			rigReceiptMember.retained.sha256,
			"rigRelayObservationReceipt",
		],
		[
			admission.value.rateSeriesSha256,
			seriesMember.retained.sha256,
			"rateSeries",
		],
		[admission.value.ledgerSha256, ledgerMember.retained.sha256, "ledger"],
		[
			admission.value.capacitySha256,
			capacityMember.retained.sha256,
			"capacity",
		],
		[
			admission.value.cohortGrantSha256,
			members.get("cohortGrant")!.retained.sha256,
			"cohortGrant",
		],
		[
			admission.value.cohortStartBarrierSha256,
			members.get("cohortStartBarrier")!.retained.sha256,
			"cohortStartBarrier",
		],
	];
	for (const [claimed, actual, label] of admissionBindings) {
		if (claimed !== actual) {
			return cohortFail(
				`admission receipt ${label} digest does not match the bytes`,
			);
		}
	}
	if (
		admission.value.publisherCount !== publisherRecords.length ||
		admission.value.subscriberCount !== args.expectedSubscriberCount ||
		admission.value.offeredIngress !== ledger.value.offeredIngress ||
		admission.value.serverAcceptedIngress !==
			ledger.value.serverAcceptedIngress ||
		admission.value.linuxRelayWritesCompleted !==
			ledger.value.linuxRelayWritesCompleted ||
		admission.value.delivered !== ledger.value.delivered
	) {
		return cohortFail("admission receipt totals disagree with the ledger");
	}

	// One execution and one cohort grant bind every authenticated record.
	const executionBound = [
		linux.value.executionSha256,
		rigReceipt.value.executionSha256,
		manifest.value.executionSha256,
		proof.value.executionSha256,
		admission.value.executionSha256,
		...publisherRecords.map((record) => record.executionSha256),
		...workerRecords.map((record) => record.executionSha256),
	];
	const execution = args.expectedExecutionSha256 ?? executionBound[0]!;
	if (executionBound.some((digest) => digest !== execution)) {
		return cohortFail("cross-execution substitution inside the export");
	}
	const grantBound = [
		linux.value.cohortGrantSha256,
		rigReceipt.value.cohortGrantSha256,
		manifest.value.cohortGrantSha256,
		proof.value.cohortGrantSha256,
		admission.value.cohortGrantSha256,
		...publisherRecords.map((record) => record.cohortGrantSha256),
		...workerRecords.map((record) => record.cohortGrantSha256),
	];
	const grant = args.expectedCohortGrantSha256 ?? grantBound[0]!;
	if (grantBound.some((digest) => digest !== grant)) {
		return cohortFail("cross-cohort substitution inside the export");
	}
	return { ok: true, value: value as unknown as CohortObservationEvidenceV1 };
}

export interface RawCohortEvidenceBundleV1 {
	readonly schema: "raw-cohort-evidence-bundle/v1";
	readonly executionSha256: Sha256Hex;
	readonly cohortGrantSha256: Sha256Hex;
	readonly encoding: "base64";
	readonly mediaType: "application/json";
	readonly bytesBase64: Base64;
	readonly byteLength: number;
	readonly sha256: Sha256Hex;
	readonly terminalExport: true;
	readonly requestSequence: number;
	readonly responseSequence: number;
}

const RAW_COHORT_EVIDENCE_BUNDLE_KEYS = [
	"bytesBase64",
	"byteLength",
	"cohortGrantSha256",
	"encoding",
	"executionSha256",
	"mediaType",
	"requestSequence",
	"responseSequence",
	"schema",
	"sha256",
	"terminalExport",
].sort() as readonly string[];

export interface DecodedCohortEvidenceV1 {
	readonly evidence: CohortObservationEvidenceV1;
	readonly decodedByteLength: number;
	readonly budgetRemaining: number;
	readonly requestSequence: number;
	readonly responseSequence: number;
}

/**
 * The one correlation rule for a terminal cohort-evidence export, shared by the
 * raw wire bundle and by the supervisor's export acknowledgement.
 *
 * A response answers a request when it names the request that was actually
 * made. The responder's own sequence is its receipt counter, unrelated to the
 * requester's numbering, so it is bounded and carried forward rather than
 * compared -- requiring the two to be equal would refuse honest responses.
 */
export function correlateCohortExportSequences(args: {
	readonly requestSequence: unknown;
	readonly responseSequence: unknown;
	readonly expectedRequestSequence: number;
}): ProtocolResult<{
	readonly requestSequence: number;
	readonly responseSequence: number;
}> {
	if (!isSafePosInt(args.expectedRequestSequence)) {
		return cohortFail("expected export request sequence");
	}
	if (
		!isSafePosInt(args.requestSequence) ||
		!isSafePosInt(args.responseSequence)
	) {
		return cohortFail("export sequences must be positive safe integers");
	}
	if (args.requestSequence !== args.expectedRequestSequence) {
		return cohortFail("export response is not the answer to its request");
	}
	return {
		ok: true,
		value: {
			requestSequence: args.requestSequence,
			responseSequence: args.responseSequence,
		},
	};
}

/**
 * The sole final raw-evidence egress. The encoded length is capped BEFORE the
 * payload is read, the declared size is charged atomically against the
 * per-execution remote-evidence budget before any allocation, and only then is
 * the payload decoded, digested, and structurally verified.
 */
export function decodeRawCohortEvidenceBundle(args: {
	readonly bundle: unknown;
	readonly expectedExecutionSha256: Sha256Hex;
	readonly expectedCohortGrantSha256: Sha256Hex;
	readonly expectedPublisherCount: number;
	readonly expectedSubscriberCount: number;
	readonly remoteEvidenceBudgetRemaining: number;
	readonly alreadyExported: boolean;
	readonly expectedRequestSequence: number;
}): ProtocolResult<DecodedCohortEvidenceV1> {
	const value = args.bundle;
	if (
		!isPlainObject(value) ||
		!exactKeys(value, RAW_COHORT_EVIDENCE_BUNDLE_KEYS)
	) {
		return cohortFail("raw cohort evidence bundle keys");
	}
	if (
		value.schema !== "raw-cohort-evidence-bundle/v1" ||
		value.encoding !== "base64" ||
		value.mediaType !== "application/json" ||
		typeof value.bytesBase64 !== "string" ||
		!isSafePosInt(value.byteLength) ||
		!isHex64(value.sha256) ||
		!isHex64(value.executionSha256) ||
		!isHex64(value.cohortGrantSha256) ||
		value.terminalExport !== true
	) {
		return cohortFail("raw cohort evidence bundle fields");
	}
	const sequences = correlateCohortExportSequences({
		requestSequence: value.requestSequence,
		responseSequence: value.responseSequence,
		expectedRequestSequence: args.expectedRequestSequence,
	});
	if (!sequences.ok) return sequences;
	// A second terminal export of one execution is a duplicate, not an update.
	if (args.alreadyExported) {
		return cohortFail(
			"cohort evidence was already exported for this execution",
		);
	}
	if (
		value.executionSha256 !== args.expectedExecutionSha256 ||
		value.cohortGrantSha256 !== args.expectedCohortGrantSha256
	) {
		return cohortFail(
			"export bundle is bound to a different execution or cohort",
		);
	}
	// Encoded cap first: nothing is read or allocated above this length.
	if (
		value.bytesBase64.length > COHORT_OBSERVATION_EVIDENCE_MAX_ENCODED_BYTES
	) {
		return cohortFail(
			`encoded ${value.bytesBase64.length} exceeds ${COHORT_OBSERVATION_EVIDENCE_MAX_ENCODED_BYTES}`,
		);
	}
	if (value.byteLength > COHORT_OBSERVATION_EVIDENCE_MAX_DECODED_BYTES) {
		return cohortFail(
			`declared ${value.byteLength} exceeds ${COHORT_OBSERVATION_EVIDENCE_MAX_DECODED_BYTES}`,
		);
	}
	if (!isSafeNonNegInt(args.remoteEvidenceBudgetRemaining)) {
		return cohortFail(
			"remote evidence budget must be a nonnegative safe integer",
		);
	}
	// Charge the declared size atomically before the decode allocates.
	if (value.byteLength > args.remoteEvidenceBudgetRemaining) {
		return cohortFail(
			`declared ${value.byteLength} exceeds the remaining evidence budget ${args.remoteEvidenceBudgetRemaining}`,
		);
	}
	const bytes = fromBase64(value.bytesBase64);
	if (bytes === null) return cohortFail("export bundle base64");
	if (bytes.byteLength !== value.byteLength) {
		return cohortFail(
			"export bundle decoded size does not equal the declared size",
		);
	}
	if (sha256HexOfBytes(bytes) !== value.sha256) {
		return cohortFail("export bundle digest mismatch");
	}
	const json = parseStrictJsonBytes(bytes);
	if (!json.ok) return cohortFail("export bundle payload is not strict JSON");
	const evidence = parseCohortObservationEvidence({
		evidence: json.value,
		expectedPublisherCount: args.expectedPublisherCount,
		expectedSubscriberCount: args.expectedSubscriberCount,
		expectedExecutionSha256: value.executionSha256,
		expectedCohortGrantSha256: value.cohortGrantSha256,
	});
	if (!evidence.ok) return evidence;
	return {
		ok: true,
		value: {
			evidence: evidence.value,
			decodedByteLength: bytes.byteLength,
			budgetRemaining: args.remoteEvidenceBudgetRemaining - bytes.byteLength,
			requestSequence: sequences.value.requestSequence,
			responseSequence: sequences.value.responseSequence,
		},
	};
}
