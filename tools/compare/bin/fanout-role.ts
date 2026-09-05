/**
 * The Phase-B role child (plan §4.3, §4.4, §4.5; task B3).
 *
 * One spawned process owns one role: a publisher owns a single publisher
 * session, and a subscriber worker owns its shard of subscriber sessions
 * (`globalOrdinal mod 8 === workerIndex`). It learns everything it is allowed
 * to know from two inherited channels and nothing else:
 *
 *   - the private control pipe, which delivers exactly one `RoleSpawnConfigV1`
 *     before any FD 5 read or network call is legal, and afterwards carries the
 *     permit/warmup/barrier/stop/partial/exit conversation;
 *   - FD 5, a sealed read-only unlinked regular file holding one canonical
 *     `TokenBundleV1`, read once and closed before the first connect.
 *
 * The child never looks up a path, never asks the controller for a preimage,
 * and never accepts a digest in place of bytes. Every schema it speaks is B1's;
 * this module defines no wire, token, or partial shape of its own.
 *
 * Everything that touches the outside world is a seam -- the control channel,
 * the FD 5 source, the clock, the transport connector -- so the whole loop runs
 * in-process under test and as a real spawned child with the same code.
 */
import { dlopen, FFIType } from "bun:ffi";
import { createHash } from "node:crypto";
import {
	checkServerIdentity,
	connect as tlsConnect,
	type PeerCertificate,
} from "node:tls";

import {
	assertChildInboundSequence,
	assertChildOutboundSequence,
	createChildSequenceState,
	decodeRoleChildFrame,
	encodeRoleChildFrame,
	type ChildSequenceState,
	RoleChildFrameReader,
	roleChildMaxFramesPerDirection,
} from "../child-pipe-protocol.ts";
import {
	CHAT_10K_WORST_CASE_WORKER_SUBSCRIBERS,
	COHORT_DRAIN_DEADLINE_MS,
	COHORT_GRANT_MAX_BYTES,
	COHORT_NOT_READY_FAILURE_CODE,
	COHORT_PROTOCOL_FAILURE_CODE,
	COHORT_WARMUP_EPOCH_MAX_BYTES,
	COHORT_WORKER_COUNT,
	type CohortGrantV1,
	type CohortStartBarrierV1,
	type CohortWarmupEpochV1,
	decodeStrictBase64,
	ED25519_PUBLIC_KEY_BYTES,
	ED25519_SIGNATURE_BYTES,
	MEASUREMENT_WINDOW_FAILURE_CODE,
	NANOSECONDS_PER_SECOND,
	parseCohortGrant,
	parseCohortStartBarrier,
	parseCohortWarmupEpoch,
	parseConnectPermitGrant,
	parsePublisherPartial,
	parseRoleMeasureStart,
	parseRolePartialAccepted,
	parseRoleSpawnConfig,
	parseRoleStop,
	parseRoleWarmupStart,
	parseTokenBundle,
	parseWorkerPartial,
	ROLE_CHILD_FRAME_MAX_BYTES,
	type PublisherPartialV1,
	type RoleSpawnConfigV1,
	type RoleWarmupStartV1,
	SUBSCRIBER_SHARD_MODULUS,
	TOKEN_BUNDLE_FD,
	TOKEN_BUNDLE_FD_READ_DEADLINE_MS,
	TOKEN_BUNDLE_MAX_SIZE,
	type TokenBundleEntryV1,
	type TokenBundleV1,
	validateTokenBundleBytes,
	validateTokenBundleFdMetadata,
	verifyTokenMerkleProof,
	WARMUP_INTERVAL_MS,
	WARMUP_MESSAGES_PER_PUBLISHER,
	WARMUP_OFFSETS_MS,
	type WorkerPartialV1,
} from "../cohort-protocol.ts";
import {
	bytesOfCanonical,
	ed25519Verify,
	type Base64,
	type NsString,
	type ProtocolResult,
	type Sha256Hex,
} from "../cross-supervisor-protocol.ts";
import { fanoutPayload } from "../scenarios/fanout-relay.ts";
import {
	decodeFanoutWsMessage,
	decodeFanoutWtStream,
	encodeFanoutWsMessage,
	encodeFanoutWtFrame,
	FANOUT_CONTROL_FRAME_MAX_DECODED_BYTES,
	type FanoutWireV1,
} from "../scenarios/fanout-wire.ts";
import { parseStrictJsonBytes, sha256HexOfBytes } from "../secure-fs.ts";

type Rec = Record<string, unknown>;

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

const cohortFail = (message: string) =>
	fail(COHORT_PROTOCOL_FAILURE_CODE, message);
const notReady = (message: string) =>
	fail(COHORT_NOT_READY_FAILURE_CODE, message);

const NS_PER_MS_BIG = 1_000_000n;
const NS_PER_SECOND_BIG = BigInt(NANOSECONDS_PER_SECOND);

function nsPlusMs(at: NsString, deltaMs: number): NsString {
	return (BigInt(at) + BigInt(deltaMs) * NS_PER_MS_BIG).toString();
}

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

/**
 * The Mac continuous clock in production, a scripted value under test. The
 * child mints every Mac nanosecond it reports from exactly this one source, so a
 * partial can never mix two clocks.
 */
export interface RoleClock {
	nowNs(): NsString;
	/** Resolve at or after `atMacNs`. */
	sleepUntilNs(atMacNs: NsString): Promise<void>;
}

/**
 * The clock every Mac nanosecond in a cohort is read from, named the way the
 * artifact's `provenance.clockMethod` names it.
 *
 * `clock_gettime(CLOCK_MONOTONIC_RAW)` is what the Mac supervisor binary reads
 * (`crates/native/src/secure_fs.rs:18748-18770`, `observe_mac_continuous_ns`),
 * and the barrier it mints -- `measureStartAtMacNs`, `measureStopAtMacNs` --
 * is compared numerically against the child's own reading when the child
 * sleeps until the start and stamps each delivery. Two processes on two clocks
 * would put every delivery outside every window. `Bun.nanoseconds()` and
 * `process.hrtime.bigint()` are process-relative in Bun (measured: ~10 ms at
 * start), and `Date.now()` is epoch-based; neither is this clock, so the
 * reading goes through the one libSystem symbol that is.
 */
export const MAC_CONTINUOUS_CLOCK_METHOD = "clock_gettime(CLOCK_MONOTONIC_RAW)";

const CLOCK_MONOTONIC_RAW = 4;

let macContinuousClock: (() => bigint) | null = null;

/**
 * Read the Mac continuous clock as whole nanoseconds since boot.
 *
 * Throws rather than falling back: a child that could not reach the clock has
 * no Mac nanoseconds to report, and a substitute clock would be a value nothing
 * on the barrier's timeline measured.
 */
export function readMacContinuousNs(): NsString {
	if (macContinuousClock === null) {
		const library = dlopen("libSystem.B.dylib", {
			clock_gettime_nsec_np: { args: [FFIType.u32], returns: FFIType.u64 },
		});
		const read = library.symbols.clock_gettime_nsec_np;
		macContinuousClock = () => BigInt(read(CLOCK_MONOTONIC_RAW));
	}
	const ns = macContinuousClock();
	if (ns <= 0n) {
		throw new RangeError("CLOCK_MONOTONIC_RAW read zero");
	}
	return ns.toString();
}

/** The real child's clock: the Mac continuous clock, and nothing else. */
export function createSystemRoleClock(): RoleClock {
	const nowNs = (): NsString => readMacContinuousNs();
	return {
		nowNs,
		sleepUntilNs: async (atMacNs) => {
			const deltaNs = BigInt(atMacNs) - BigInt(nowNs());
			if (deltaNs <= 0n) return;
			const deltaMs = Number(deltaNs / NS_PER_MS_BIG);
			await new Promise<void>((resolve) => setTimeout(resolve, deltaMs));
		},
	};
}

/** The private supervisor pipe, already framed. */
export interface RoleControlChannel {
	/** Next inbound frame, already length-checked for `expectedSchema`. */
	receive(expectedSchema: string): Promise<Rec>;
	send(frame: Rec & { schema: string }): Promise<void>;
}

/**
 * FD 5. The child observes the descriptor twice -- as the supervisor described
 * it at spawn and as the child itself finds it at read -- and reads the bytes
 * exactly once, under a deadline, before closing it.
 */
export interface TokenBundleFdSource {
	/** The supervisor's spawn-time observation, inherited with the config. */
	observationAtSpawn(): Rec;
	/** What the child sees for itself, immediately before reading. */
	observationAtRead(): Rec;
	read(): Promise<Uint8Array>;
	close(): void;
}

export interface RoleSessionHandle {
	readonly roleId: string;
	send(frame: FanoutWireV1): Promise<ProtocolResult<true>>;
	close(): void;
}

/** How this child reaches the relay; `ws` and `wt` differ only in framing. */
export interface RoleTransportConnector {
	readonly transport: "ws" | "wt";
	connect(args: {
		readonly role: "publisher" | "subscriber";
		readonly roleId: string;
		readonly serverHost: string;
		readonly serverPort: number;
		readonly tlsServerName: string;
		/** Every frame the relay sends this session, in per-channel order. */
		readonly onFrame: (frame: FanoutWireV1) => void;
	}): Promise<RoleSessionHandle>;
}

/** What the child can honestly say about its own process. */
export interface RoleProcessFacts {
	readonly pid: number;
	readonly pgid: number;
}

// ---------------------------------------------------------------------------
// Spawn-config validation (§4.3)
// ---------------------------------------------------------------------------

/**
 * §5 step 9: the barrier's measured start is at least 250 ms after it was
 * minted, so every child has arming time it did not have to be told about.
 */
export const COHORT_BARRIER_MIN_ARM_DELAY_NS = 250_000_000n;

export interface ValidatedRoleSpawnConfig {
	readonly config: RoleSpawnConfigV1;
	readonly grant: CohortGrantV1;
	readonly grantBytes: Uint8Array;
	/**
	 * The 32 raw bytes of the Mac signing key, already pinned to the staged
	 * digest. Every later Mac-signed record the child is handed is verified
	 * under exactly this key -- a digest match is never authority on its own.
	 */
	readonly macSigningPublicKey: Uint8Array;
	/** Ordinals this child owns, ascending, in the one global domain. */
	readonly assignedGlobalOrdinals: readonly number[];
	/** The role IDs those ordinals map to, in the same order. */
	readonly assignedRoleIds: readonly string[];
}

/**
 * Verify a spawn config the way §4.3 requires: the embedded key must be the
 * staged key, the embedded signature must verify over the exact grant bytes
 * with it, and every endpoint/transport/schedule/payload field must equal the
 * signed grant. A config that merely parses is not yet trusted -- what makes it
 * trustworthy is that the child could not have chosen any of it.
 */
export function validateRoleSpawnConfigFrame(args: {
	readonly frame: unknown;
	readonly stagedMacSigningPublicKeySha256: Sha256Hex;
}): ProtocolResult<ValidatedRoleSpawnConfig> {
	const parsed = parseRoleSpawnConfig(args.frame);
	if (!parsed.ok) return parsed;
	const config = parsed.value;

	if (
		config.macSigningPublicKeySha256 !== args.stagedMacSigningPublicKeySha256
	) {
		return cohortFail(
			"spawn config public key is not the staged supervisor key",
		);
	}
	const publicKey = decodeStrictBase64(
		config.macSigningPublicKeyBase64,
		ED25519_PUBLIC_KEY_BYTES,
	);
	const signature = decodeStrictBase64(
		config.cohortGrantSignatureBase64,
		ED25519_SIGNATURE_BYTES,
	);
	const grantBytes = decodeStrictBase64(
		config.cohortGrantBase64,
		COHORT_GRANT_MAX_BYTES,
	);
	if (publicKey === null || signature === null || grantBytes === null) {
		return cohortFail("spawn config carries an undecodable grant or key");
	}
	if (!ed25519Verify(publicKey, grantBytes, signature)) {
		return cohortFail("cohort grant signature does not verify under the key");
	}

	const json = parseStrictJsonBytes(grantBytes);
	if (!json.ok) return cohortFail(`cohort grant json ${json.reason}`);
	const grant = parseCohortGrant(json.value);
	if (!grant.ok) return grant;

	const bound = requireConfigMatchesGrant(config, grant.value);
	if (!bound.ok) return bound;

	const ordinals = assignedGlobalOrdinals(config, grant.value);
	if (!ordinals.ok) return ordinals;

	return {
		ok: true,
		value: {
			config,
			grant: grant.value,
			grantBytes,
			macSigningPublicKey: publicKey,
			assignedGlobalOrdinals: ordinals.value.ordinals,
			assignedRoleIds: ordinals.value.roleIds,
		},
	};
}

function requireConfigMatchesGrant(
	config: RoleSpawnConfigV1,
	grant: CohortGrantV1,
): ProtocolResult<true> {
	if (grant.executionSha256 !== config.executionSha256) {
		return cohortFail("spawn config names another execution than the grant");
	}
	if (grant.signingPublicKeySha256 !== config.macSigningPublicKeySha256) {
		return cohortFail("grant was signed by another key than the config names");
	}
	if (grant.transport !== config.transport) {
		return cohortFail("transport does not equal the signed grant");
	}
	if (grant.messageBytes !== config.payloadBytes) {
		return cohortFail("payloadBytes does not equal the signed messageBytes");
	}
	if (grant.measuredDurationMs !== config.measuredDurationMs) {
		return cohortFail("measuredDurationMs does not equal the signed grant");
	}
	if (grant.sampleWindowMs !== config.measuredSampleWindowMs) {
		return cohortFail("measuredSampleWindowMs does not equal the signed grant");
	}
	if (grant.inRepetitionWarmupMs !== config.warmupDurationMs) {
		return cohortFail("warmupDurationMs does not equal the signed grant");
	}
	if (
		grant.workloadRolePlanInputSha256 !== config.workloadRolePlanInputSha256
	) {
		return cohortFail("role plan input digest does not equal the signed grant");
	}
	if (grant.workerCount !== COHORT_WORKER_COUNT) {
		return cohortFail("grant does not carry the frozen worker count");
	}

	// The child must appear in the grant under its own child ID; a config that
	// assigns a role the grant never granted is a forgery even if it parses.
	if (config.role === "publisher") {
		const publisher = grant.publishers.find(
			(candidate) => candidate.publisherId === config.publisherId,
		);
		if (publisher === undefined) {
			return cohortFail("grant carries no publisher with this publisher ID");
		}
		if (publisher.childId !== config.childId) {
			return cohortFail("grant assigns this publisher to another child");
		}
		return { ok: true, value: true };
	}

	const shard = grant.subscriberShards.find(
		(candidate) => candidate.workerIndex === config.workerIndex,
	);
	if (shard === undefined) {
		return cohortFail("grant carries no shard for this worker index");
	}
	if (shard.childId !== config.childId) {
		return cohortFail("grant assigns this shard to another child");
	}
	if (shard.modulus !== SUBSCRIBER_SHARD_MODULUS) {
		return cohortFail("shard modulus is not the frozen subscriber modulus");
	}
	return { ok: true, value: true };
}

/**
 * The ordinals this child owns, in the one global domain: a publisher owns
 * exactly `subscriberCount + publisherIndex`; a worker owns every subscriber
 * ordinal congruent to its index mod 8. Derived, never received -- a child that
 * were handed its ordinal list could be handed someone else's.
 */
export function assignedGlobalOrdinals(
	config: RoleSpawnConfigV1,
	grant: CohortGrantV1,
): ProtocolResult<{
	readonly ordinals: readonly number[];
	readonly roleIds: readonly string[];
}> {
	if (config.role === "publisher") {
		const index = grant.publishers.findIndex(
			(candidate) => candidate.publisherId === config.publisherId,
		);
		if (index < 0) return notReady("publisher is not in the grant");
		return {
			ok: true,
			value: {
				ordinals: [grant.subscriberCount + index],
				roleIds: [config.publisherId as string],
			},
		};
	}
	const workerIndex = config.workerIndex as number;
	const ordinals: number[] = [];
	const roleIds: string[] = [];
	for (
		let ordinal = workerIndex;
		ordinal < grant.subscriberCount;
		ordinal += SUBSCRIBER_SHARD_MODULUS
	) {
		ordinals.push(ordinal);
		roleIds.push(`subscriber-${ordinal.toString().padStart(6, "0")}`);
	}
	if (ordinals.length === 0) {
		return notReady(`worker ${workerIndex} owns no subscriber ordinal`);
	}
	return { ok: true, value: { ordinals, roleIds } };
}

// ---------------------------------------------------------------------------
// Transition authority (§5 steps 7 and 9)
// ---------------------------------------------------------------------------

/**
 * Decide whether a `RoleWarmupStartV1` is authority to put warmup frames on the
 * wire. §5 is explicit that no warmup authority the child acts on is
 * digest-only, so the epoch's Mac signature is verified over its exact bytes
 * under the key the spawn config pinned to the staged digest, and the epoch is
 * then required to name this execution, this grant, this cohort, and this
 * nonce. A frame that merely carries matching digests is not authority: the
 * supervisor writes those digests.
 */
export function verifyRoleWarmupStart(args: {
	readonly frame: unknown;
	readonly config: RoleSpawnConfigV1;
	readonly grant: CohortGrantV1;
	readonly macSigningPublicKey: Uint8Array;
}): ProtocolResult<{
	readonly start: RoleWarmupStartV1;
	readonly epoch: CohortWarmupEpochV1;
}> {
	const { config, grant } = args;
	const parsed = parseRoleWarmupStart(args.frame);
	if (!parsed.ok) return parsed;
	const start = parsed.value;
	if (
		start.executionSha256 !== config.executionSha256 ||
		start.cohortGrantSha256 !== config.cohortGrantSha256
	) {
		return cohortFail("warmup start names another execution or grant");
	}
	const epoch = decodeWarmupEpoch({
		epochBase64: start.cohortWarmupEpochBase64,
		signatureBase64: start.cohortWarmupEpochSignatureBase64,
		macSigningPublicKey: args.macSigningPublicKey,
	});
	if (!epoch.ok) return epoch;
	if (
		epoch.value.executionSha256 !== config.executionSha256 ||
		epoch.value.cohortGrantSha256 !== config.cohortGrantSha256 ||
		epoch.value.cohortId !== grant.cohortId ||
		epoch.value.warmupNonce !== start.warmupNonce
	) {
		return cohortFail("warmup epoch is not bound to this cohort and nonce");
	}
	if (epoch.value.signingPublicKeySha256 !== config.macSigningPublicKeySha256) {
		return cohortFail("warmup epoch names another signing key than the config");
	}
	return { ok: true, value: { start, epoch: epoch.value } };
}

/**
 * Decide whether a `RoleMeasureStartV1` is authority to arm measured traffic.
 * The barrier travels by value, so the child recomputes its digest from the
 * exact bytes it was handed rather than trusting one, and requires the barrier
 * to name this cohort, this signing key, and the same schedule the spawn config
 * was signed for. The 250 ms arming gap is part of validity: a barrier that
 * starts sooner has not given this child time to arm, whatever it claims.
 */
export function verifyRoleMeasureStart(args: {
	readonly frame: unknown;
	readonly config: RoleSpawnConfigV1;
	readonly grant: CohortGrantV1;
	/** Optional cross-check; it may agree with the barrier, never replace it. */
	readonly macClockId?: string;
}): ProtocolResult<{
	readonly barrier: CohortStartBarrierV1;
	readonly cohortStartBarrierSha256: Sha256Hex;
}> {
	const { config, grant } = args;
	const parsed = parseRoleMeasureStart(args.frame);
	if (!parsed.ok) return parsed;
	if (parsed.value.executionSha256 !== config.executionSha256) {
		return cohortFail("measure start names another execution");
	}
	const barrierBytes = decodeStrictBase64(
		parsed.value.cohortStartBarrierBase64,
		ROLE_CHILD_FRAME_MAX_BYTES,
	);
	if (barrierBytes === null) return cohortFail("start barrier bytes");
	const barrier = decodeStartBarrier(parsed.value.cohortStartBarrierBase64);
	if (!barrier.ok) return barrier;
	if (
		barrier.value.executionSha256 !== config.executionSha256 ||
		barrier.value.cohortGrantSha256 !== config.cohortGrantSha256
	) {
		return cohortFail("start barrier names another execution or grant");
	}
	if (barrier.value.cohortId !== grant.cohortId) {
		return cohortFail("start barrier names another cohort");
	}
	if (barrier.value.measuredDurationMs !== config.measuredDurationMs) {
		return cohortFail("start barrier duration is not the signed duration");
	}
	if (barrier.value.sampleWindowMs !== config.measuredSampleWindowMs) {
		return cohortFail("start barrier sample window is not the signed window");
	}
	if (
		barrier.value.signingPublicKeySha256 !== config.macSigningPublicKeySha256
	) {
		return cohortFail(
			"start barrier names another signing key than the config",
		);
	}
	if (
		BigInt(barrier.value.measureStartAtMacNs) -
			BigInt(barrier.value.mintedAtMacNs) <
		COHORT_BARRIER_MIN_ARM_DELAY_NS
	) {
		return notReady("start barrier arms less than 250 ms after minting");
	}
	if (
		args.macClockId !== undefined &&
		args.macClockId !== barrier.value.macClockId
	) {
		return cohortFail("macClockId does not equal the barrier's clock");
	}
	return {
		ok: true,
		value: {
			barrier: barrier.value,
			cohortStartBarrierSha256: sha256HexOfBytes(barrierBytes),
		},
	};
}

// ---------------------------------------------------------------------------
// FD 5 (§4.3)
// ---------------------------------------------------------------------------

export interface LoadedTokenBundle {
	readonly bundle: TokenBundleV1;
	readonly byteLength: number;
	readonly contentSha256: Sha256Hex;
}

/**
 * Read the sealed bundle once, under the 5 s deadline, and close the descriptor
 * before the caller is allowed to connect anything. Both FD observations are
 * checked against the supervisor's retained commitment first, so a writable,
 * path-backed, reused, or mutated descriptor is refused before its bytes are
 * ever allocated.
 */
export async function loadRoleTokenBundle(args: {
	readonly source: TokenBundleFdSource;
	readonly config: RoleSpawnConfigV1;
	readonly clock: RoleClock;
}): Promise<ProtocolResult<LoadedTokenBundle>> {
	const { source, config } = args;
	const metadata = validateTokenBundleFdMetadata({
		atSpawn: source.observationAtSpawn(),
		atRead: source.observationAtRead(),
		expectedSha256: config.tokenBundleSha256,
		expectedSize: config.tokenBundleSize,
	});
	if (!metadata.ok) {
		source.close();
		return metadata;
	}

	const deadlineMs = Date.now() + TOKEN_BUNDLE_FD_READ_DEADLINE_MS;
	let bytes: Uint8Array;
	try {
		bytes = await source.read();
	} finally {
		// The descriptor closes whether or not the read succeeded: a role child
		// must never hold an open token FD while it has a socket.
		source.close();
	}
	if (Date.now() > deadlineMs) {
		return cohortFail("token bundle read exceeded the 5 s deadline");
	}
	const capped = validateTokenBundleBytes(bytes);
	if (!capped.ok) return capped;
	if (bytes.byteLength !== config.tokenBundleSize) {
		return cohortFail("token bundle read is not the committed size");
	}
	if (bytes.byteLength > TOKEN_BUNDLE_MAX_SIZE) {
		return cohortFail("token bundle exceeds the frozen cap");
	}
	const contentSha256 = sha256HexOfBytes(bytes);
	if (contentSha256 !== config.tokenBundleSha256) {
		return cohortFail("token bundle read is not the committed digest");
	}
	const json = parseStrictJsonBytes(bytes);
	if (!json.ok) return cohortFail(`token bundle json ${json.reason}`);
	const bundle = parseTokenBundle(json.value);
	if (!bundle.ok) return bundle;
	if (bundle.value.childId !== config.childId) {
		return cohortFail("token bundle belongs to another child");
	}
	if (bundle.value.executionSha256 !== config.executionSha256) {
		return cohortFail("token bundle belongs to another execution");
	}
	if (bundle.value.cohortGrantSha256 !== config.cohortGrantSha256) {
		return cohortFail("token bundle belongs to another cohort grant");
	}
	if (bundle.value.entryCount !== config.tokenBundleEntryCount) {
		return cohortFail("token bundle entry count is not the committed count");
	}
	return {
		ok: true,
		value: {
			bundle: bundle.value,
			byteLength: bytes.byteLength,
			contentSha256,
		},
	};
}

// ---------------------------------------------------------------------------
// Token lookup (§4.3)
// ---------------------------------------------------------------------------

/**
 * This child's own entries, in assigned-ordinal order, each with its Merkle
 * proof checked against the root the signed grant carries. The bundle is the
 * only place a raw token exists, and a token whose proof does not reach the
 * signed root is not this cohort's token no matter which file it arrived in.
 */
export function selectRoleTokenEntries(args: {
	readonly bundle: TokenBundleV1;
	readonly config: RoleSpawnConfigV1;
	readonly grant: CohortGrantV1;
	readonly assignedRoleIds: readonly string[];
}): ProtocolResult<readonly TokenBundleEntryV1[]> {
	const { bundle, config, grant } = args;
	const byRoleId = new Map<string, TokenBundleEntryV1>();
	for (const entry of bundle.entries) {
		if (byRoleId.has(entry.roleId)) {
			return cohortFail(`token bundle repeats role ${entry.roleId}`);
		}
		byRoleId.set(entry.roleId, entry);
	}
	if (byRoleId.size !== args.assignedRoleIds.length) {
		return cohortFail(
			`token bundle holds ${byRoleId.size} roles for ${args.assignedRoleIds.length} assigned ordinals`,
		);
	}

	const selected: TokenBundleEntryV1[] = [];
	for (const roleId of args.assignedRoleIds) {
		const entry = byRoleId.get(roleId);
		if (entry === undefined) {
			return cohortFail(`token bundle is missing assigned role ${roleId}`);
		}
		const expectedRole =
			config.role === "publisher" ? "publisher" : "subscriber";
		if (entry.role !== expectedRole) {
			return cohortFail(`token for ${roleId} carries the wrong role`);
		}
		if (
			expectedRole === "subscriber" &&
			entry.workerIndex !== config.workerIndex
		) {
			return cohortFail(`token for ${roleId} belongs to another shard`);
		}
		if (expectedRole === "publisher" && entry.workerIndex !== null) {
			return cohortFail(`publisher token for ${roleId} carries a shard`);
		}
		const leafSha256 = tokenCommitmentLeafSha256ForEntry({
			cohortId: grant.cohortId,
			childId: config.childId,
			entry,
		});
		const proof = verifyTokenMerkleProof({
			leafSha256,
			tokenCommitmentIndex: entry.tokenCommitmentIndex,
			leafCount: grant.roleTokenCommitmentCount,
			proof: entry.tokenMerkleProofSha256,
			rootSha256: grant.roleTokenCommitmentRootSha256,
		});
		if (!proof.ok) {
			return cohortFail(`token proof for ${roleId} does not reach the root`);
		}
		selected.push(entry);
	}
	return { ok: true, value: selected };
}

/** The §4.1 leaf this entry commits to, rebuilt from what the child knows. */
function tokenCommitmentLeafSha256ForEntry(args: {
	readonly cohortId: string;
	readonly childId: string;
	readonly entry: TokenBundleEntryV1;
}): Sha256Hex {
	return sha256HexOfBytes(
		bytesOfCanonical({
			schema: "token-commitment-leaf/v1",
			childId: args.childId,
			cohortId: args.cohortId,
			role: args.entry.role,
			roleId: args.entry.roleId,
			tokenSha256: args.entry.tokenSha256,
			workerIndex: args.entry.workerIndex,
		}),
	);
}

// ---------------------------------------------------------------------------
// Window bookkeeping (§4.4 partial fields, §4.5 window rules)
// ---------------------------------------------------------------------------

function zeros(length: number): number[] {
	return new Array<number>(length).fill(0);
}

/**
 * A publisher's own view: what it offered, in the origin window it stamped on
 * the frame, and what the relay acknowledged, in that same immutable origin
 * window. An acknowledgement never moves a count to the window it arrived in --
 * that is exactly the relabeling §4.5 forbids.
 */
export class PublisherWindowBook {
	readonly windowCount: 10 | 30;
	readonly messageBytes: 100 | 128;
	private readonly offered: number[];
	private readonly offeredBytes: number[];
	private readonly acceptedAcks: number[];
	private readonly duplicateAcks: number[];
	private readonly reorderedAcks: number[];
	private offeredTotal = 0;
	private acknowledgedTotal = 0;
	private firstOfferAtMacNs: NsString | null = null;
	private lastAckAtMacNs: NsString | null = null;

	constructor(args: {
		readonly windowCount: 10 | 30;
		readonly messageBytes: 100 | 128;
	}) {
		this.windowCount = args.windowCount;
		this.messageBytes = args.messageBytes;
		this.offered = zeros(args.windowCount);
		this.offeredBytes = zeros(args.windowCount);
		this.acceptedAcks = zeros(args.windowCount);
		this.duplicateAcks = zeros(args.windowCount);
		this.reorderedAcks = zeros(args.windowCount);
	}

	/** Every measured frame this publisher has offered, all windows. */
	get offeredCount(): number {
		return this.offeredTotal;
	}

	/**
	 * Offers the relay has not answered yet. The relay answers every measured
	 * data frame with exactly one ack of some disposition (`accepted`,
	 * `duplicate`, `reordered` or `closed`), so this is what a post-stop drain
	 * has to wait for: the conservation rule `OA_origin[w] = A_origin[w]` (§4.5)
	 * needs every accepted ack recorded, and an offer can only be known to be
	 * unaccepted once its ack has said so.
	 */
	outstandingAcks(): number {
		return this.offeredTotal - this.acknowledgedTotal;
	}

	recordOffer(args: {
		readonly originWindowIndex: number;
		readonly atMacNs: NsString;
	}): ProtocolResult<true> {
		const window = args.originWindowIndex;
		if (
			!Number.isSafeInteger(window) ||
			window < 0 ||
			window >= this.windowCount
		) {
			return fail(MEASUREMENT_WINDOW_FAILURE_CODE, "offer window out of range");
		}
		this.offered[window] = (this.offered[window] as number) + 1;
		this.offeredBytes[window] =
			(this.offeredBytes[window] as number) + this.messageBytes;
		this.offeredTotal += 1;
		if (this.firstOfferAtMacNs === null) this.firstOfferAtMacNs = args.atMacNs;
		return { ok: true, value: true };
	}

	recordAck(args: {
		readonly originWindowIndex: number;
		readonly disposition: "accepted" | "duplicate" | "reordered" | "closed";
		readonly atMacNs: NsString;
	}): ProtocolResult<true> {
		const window = args.originWindowIndex;
		if (
			!Number.isSafeInteger(window) ||
			window < 0 ||
			window >= this.windowCount
		) {
			return fail(MEASUREMENT_WINDOW_FAILURE_CODE, "ack window out of range");
		}
		if (args.disposition === "accepted") {
			this.acceptedAcks[window] = (this.acceptedAcks[window] as number) + 1;
		} else if (args.disposition === "duplicate") {
			this.duplicateAcks[window] = (this.duplicateAcks[window] as number) + 1;
		} else if (args.disposition === "reordered") {
			this.reorderedAcks[window] = (this.reorderedAcks[window] as number) + 1;
		}
		this.acknowledgedTotal += 1;
		this.lastAckAtMacNs = args.atMacNs;
		return { ok: true, value: true };
	}

	/**
	 * A cohort where nothing was offered still has to name a timestamp; §4.5
	 * fixes that on the exact barrier start rather than on "now".
	 */
	toPartial(args: {
		readonly executionSha256: Sha256Hex;
		readonly cohortGrantSha256: Sha256Hex;
		readonly cohortStartBarrierSha256: Sha256Hex;
		readonly childId: string;
		readonly process: RoleProcessFacts;
		readonly childInstanceNonce: Sha256Hex;
		readonly publisherId: string;
		readonly tokenSha256: Sha256Hex;
		readonly macClockId: string;
		readonly measureStartAtMacNs: NsString;
	}): ProtocolResult<PublisherPartialV1> {
		const record = {
			schema: "publisher-partial/v1",
			executionSha256: args.executionSha256,
			cohortGrantSha256: args.cohortGrantSha256,
			cohortStartBarrierSha256: args.cohortStartBarrierSha256,
			childId: args.childId,
			childPid: args.process.pid,
			childPgid: args.process.pgid,
			childInstanceNonce: args.childInstanceNonce,
			publisherId: args.publisherId,
			tokenSha256: args.tokenSha256,
			macClockId: args.macClockId,
			windowCount: this.windowCount,
			offeredByOriginWindow: [...this.offered],
			offeredBytesByOriginWindow: [...this.offeredBytes],
			acceptedAckSeenByOriginWindow: [...this.acceptedAcks],
			duplicateAckSeenByOriginWindow: [...this.duplicateAcks],
			reorderedAckSeenByOriginWindow: [...this.reorderedAcks],
			firstOfferAtMacNs: this.firstOfferAtMacNs ?? args.measureStartAtMacNs,
			lastAckAtMacNs: this.lastAckAtMacNs ?? args.measureStartAtMacNs,
			exitCode: 0,
		};
		return parsePublisherPartial(record);
	}
}

/**
 * A worker's own view. Two window families live here and they are deliberately
 * different observations: the origin family is the immutable window the
 * publisher stamped, and carries drain deliveries so conservation closes; the
 * event family is computed from the actual `deliveredAtMacNs` and carries only
 * deliveries that landed inside the measured window.
 */
export class WorkerWindowBook {
	readonly windowCount: 10 | 30;
	readonly messageBytes: 100 | 128;
	readonly orderedSubscriberIds: readonly string[];
	private readonly indexBySubscriberId: ReadonlyMap<string, number>;
	private readonly deliveredOrigin: number[];
	private readonly deliveredBytesOrigin: number[];
	private readonly deliveredEvent: number[];
	private readonly deliveredBytesEvent: number[];
	private readonly perSubscriber: number[];
	private deliveredAfterStop = 0;
	private deliveredBytesAfterStop = 0;
	private duplicates = 0;
	private reorders = 0;
	private malformed = 0;
	private disconnects = 0;
	private firstDeliveryAtMacNs: NsString | null = null;
	private lastDeliveryAtMacNs: NsString | null = null;
	private readonly seen = new Set<string>();
	private readonly nextSequenceByOrigin = new Map<string, number>();

	constructor(args: {
		readonly windowCount: 10 | 30;
		readonly messageBytes: 100 | 128;
		readonly orderedSubscriberIds: readonly string[];
	}) {
		this.windowCount = args.windowCount;
		this.messageBytes = args.messageBytes;
		this.orderedSubscriberIds = [...args.orderedSubscriberIds];
		this.indexBySubscriberId = new Map(
			this.orderedSubscriberIds.map((roleId, index) => [roleId, index]),
		);
		this.deliveredOrigin = zeros(args.windowCount);
		this.deliveredBytesOrigin = zeros(args.windowCount);
		this.deliveredEvent = zeros(args.windowCount);
		this.deliveredBytesEvent = zeros(args.windowCount);
		this.perSubscriber = zeros(this.orderedSubscriberIds.length);
	}

	recordMalformed(): void {
		this.malformed += 1;
	}

	recordDisconnect(): void {
		this.disconnects += 1;
	}

	/**
	 * One delivery. `classification` comes from `computeCohortEventWindow`, so
	 * this method never re-derives a window from anything but the caller's
	 * already-validated event decision.
	 */
	recordDelivery(args: {
		readonly subscriberId: string;
		readonly publisherId: string;
		readonly publisherSequence: number;
		readonly originWindowIndex: number;
		readonly deliveredAtMacNs: NsString;
		readonly eventWindow: number | null;
	}): ProtocolResult<true> {
		const subscriberIndex = this.indexBySubscriberId.get(args.subscriberId);
		if (subscriberIndex === undefined) {
			this.malformed += 1;
			return cohortFail(`${args.subscriberId} is not in this worker's shard`);
		}
		const window = args.originWindowIndex;
		if (
			!Number.isSafeInteger(window) ||
			window < 0 ||
			window >= this.windowCount
		) {
			this.malformed += 1;
			return fail(
				MEASUREMENT_WINDOW_FAILURE_CODE,
				"origin window out of range",
			);
		}

		const key = `${args.subscriberId}\u0000${args.publisherId}\u0000${args.publisherSequence}`;
		if (this.seen.has(key)) {
			this.duplicates += 1;
			return fail(MEASUREMENT_WINDOW_FAILURE_CODE, "duplicate delivery");
		}
		this.seen.add(key);
		const originKey = `${args.subscriberId}\u0000${args.publisherId}`;
		const expected = this.nextSequenceByOrigin.get(originKey) ?? 0;
		if (args.publisherSequence !== expected) {
			this.reorders += 1;
		}
		this.nextSequenceByOrigin.set(
			originKey,
			Math.max(expected, args.publisherSequence + 1),
		);

		// Origin conservation counts every delivery, drain included; only the
		// rate family is restricted to the measured window.
		this.deliveredOrigin[window] = (this.deliveredOrigin[window] as number) + 1;
		this.deliveredBytesOrigin[window] =
			(this.deliveredBytesOrigin[window] as number) + this.messageBytes;
		this.perSubscriber[subscriberIndex] =
			(this.perSubscriber[subscriberIndex] as number) + 1;

		if (args.eventWindow === null) {
			this.deliveredAfterStop += 1;
			this.deliveredBytesAfterStop += this.messageBytes;
		} else {
			const event = args.eventWindow;
			if (
				!Number.isSafeInteger(event) ||
				event < 0 ||
				event >= this.windowCount
			) {
				return fail(
					MEASUREMENT_WINDOW_FAILURE_CODE,
					"event window out of range",
				);
			}
			this.deliveredEvent[event] = (this.deliveredEvent[event] as number) + 1;
			this.deliveredBytesEvent[event] =
				(this.deliveredBytesEvent[event] as number) + this.messageBytes;
		}

		if (
			this.firstDeliveryAtMacNs === null ||
			BigInt(args.deliveredAtMacNs) < BigInt(this.firstDeliveryAtMacNs)
		) {
			this.firstDeliveryAtMacNs = args.deliveredAtMacNs;
		}
		if (
			this.lastDeliveryAtMacNs === null ||
			BigInt(args.deliveredAtMacNs) > BigInt(this.lastDeliveryAtMacNs)
		) {
			this.lastDeliveryAtMacNs = args.deliveredAtMacNs;
		}
		return { ok: true, value: true };
	}

	toPartial(args: {
		readonly executionSha256: Sha256Hex;
		readonly cohortGrantSha256: Sha256Hex;
		readonly cohortStartBarrierSha256: Sha256Hex;
		readonly childId: string;
		readonly process: RoleProcessFacts;
		readonly childInstanceNonce: Sha256Hex;
		readonly workerIndex: number;
		readonly tokenBundleSha256: Sha256Hex;
		readonly macClockId: string;
		readonly measureStartAtMacNs: NsString;
	}): ProtocolResult<WorkerPartialV1> {
		const record = {
			schema: "worker-partial/v1",
			executionSha256: args.executionSha256,
			cohortGrantSha256: args.cohortGrantSha256,
			cohortStartBarrierSha256: args.cohortStartBarrierSha256,
			childId: args.childId,
			childPid: args.process.pid,
			childPgid: args.process.pgid,
			childInstanceNonce: args.childInstanceNonce,
			workerIndex: args.workerIndex,
			tokenBundleSha256: args.tokenBundleSha256,
			orderedSubscriberIdsSha256: orderedSubscriberIdsSha256(
				this.orderedSubscriberIds,
			),
			subscriberCount: this.orderedSubscriberIds.length,
			macClockId: args.macClockId,
			windowCount: this.windowCount,
			deliveredByOriginWindow: [...this.deliveredOrigin],
			deliveredBytesByOriginWindow: [...this.deliveredBytesOrigin],
			deliveredByEventWindow: [...this.deliveredEvent],
			deliveredBytesByEventWindow: [...this.deliveredBytesEvent],
			deliveredAfterMeasureStop: this.deliveredAfterStop,
			deliveredBytesAfterMeasureStop: this.deliveredBytesAfterStop,
			perSubscriberDelivered: [...this.perSubscriber],
			duplicateCount: this.duplicates,
			reorderCount: this.reorders,
			malformedCount: this.malformed,
			disconnectCount: this.disconnects,
			firstDeliveryAtMacNs:
				this.firstDeliveryAtMacNs ?? args.measureStartAtMacNs,
			lastDeliveryAtMacNs: this.lastDeliveryAtMacNs ?? args.measureStartAtMacNs,
			exitCode: 0,
		};
		return parseWorkerPartial(record);
	}
}

/** The §4.1 shard digest: canonical bytes of the ordered subscriber IDs. */
export function orderedSubscriberIdsSha256(
	orderedSubscriberIds: readonly string[],
): Sha256Hex {
	return sha256HexOfBytes(bytesOfCanonical([...orderedSubscriberIds]));
}

// ---------------------------------------------------------------------------
// The child loop
// ---------------------------------------------------------------------------

export interface FanoutRoleChildArgs {
	readonly control: RoleControlChannel;
	readonly tokenBundleFd: TokenBundleFdSource;
	readonly clock: RoleClock;
	readonly connector: RoleTransportConnector;
	readonly process: RoleProcessFacts;
	readonly stagedMacSigningPublicKeySha256: Sha256Hex;
	/** The `macClockId` the supervisor and children share (§5). */
	readonly macClockId?: string;
}

export interface FanoutRoleChildOutcome {
	readonly childId: string;
	readonly role: "publisher" | "subscriber-worker";
	readonly registeredSessionCount: number;
	readonly partialSha256: Sha256Hex;
	readonly exitCode: 0;
}

/**
 * The whole ordered lifecycle of one role child (§5 steps 4-16, child side).
 *
 * Written as one straight-line sequence on purpose: every transition is a frame
 * the supervisor sends, and every frame is validated against the signed grant
 * before the child does anything observable. There is no path here that reaches
 * a socket before FD 5 is closed, and none that offers measured traffic before
 * a barrier the child has itself verified.
 */
export async function runFanoutRoleChild(
	args: FanoutRoleChildArgs,
): Promise<ProtocolResult<FanoutRoleChildOutcome>> {
	const { control, clock, connector } = args;

	// -- 1. spawn config ----------------------------------------------------
	const configFrame = await control.receive("role-spawn-config/v1");
	const validated = validateRoleSpawnConfigFrame({
		frame: configFrame,
		stagedMacSigningPublicKeySha256: args.stagedMacSigningPublicKeySha256,
	});
	if (!validated.ok) return validated;
	const {
		config,
		grant,
		assignedGlobalOrdinals: ordinals,
		assignedRoleIds,
	} = validated.value;
	if (connector.transport !== config.transport) {
		return cohortFail("connector transport is not the signed transport");
	}

	// -- 2. FD 5, closed before the first connect ---------------------------
	const loaded = await loadRoleTokenBundle({
		source: args.tokenBundleFd,
		config,
		clock,
	});
	if (!loaded.ok) return loaded;
	const entries = selectRoleTokenEntries({
		bundle: loaded.value.bundle,
		config,
		grant,
		assignedRoleIds,
	});
	if (!entries.ok) return entries;

	// -- 3. permits, connections, registration ------------------------------
	const role = config.role === "publisher" ? "publisher" : "subscriber";
	const inboxes = new Map<string, FrameQueue>();
	const sessions = new Map<string, RoleSessionHandle>();
	const closeAll = (): void => {
		for (const session of sessions.values()) {
			try {
				session.close();
			} catch {
				// Already gone; teardown is what matters, not the close result.
			}
		}
	};

	for (let index = 0; index < ordinals.length; index += 1) {
		const globalOrdinal = ordinals[index] as number;
		const roleId = assignedRoleIds[index] as string;
		const entry = entries.value[index] as TokenBundleEntryV1;

		await control.send({
			schema: "connect-permit-request/v1",
			sequence: 0,
			executionSha256: config.executionSha256,
			cohortGrantSha256: config.cohortGrantSha256,
			childId: config.childId,
			globalOrdinal,
			roleId,
		});
		const permit = await control.receive("connect-permit-grant/v1");
		const permitGrant = requirePermitGrant(permit, {
			config,
			globalOrdinal,
		});
		if (!permitGrant.ok) {
			closeAll();
			return permitGrant;
		}
		await clock.sleepUntilNs(permitGrant.value.notBeforeMacNs);
		const startedAtMacNs = clock.nowNs();

		const inbox = createFrameQueue(clock);
		inboxes.set(roleId, inbox);
		let session: RoleSessionHandle;
		try {
			session = await connector.connect({
				role,
				roleId,
				serverHost: config.serverHost,
				serverPort: config.serverPort,
				tlsServerName: config.tlsServerName,
				onFrame: (frame) => {
					inbox.push(frame);
				},
			});
		} catch (error) {
			closeAll();
			return notReady(`connect for ${roleId} failed: ${String(error)}`);
		}
		sessions.set(roleId, session);

		const registered = await session.send({
			schema: "fanout-wire/v1",
			kind: "register",
			cohortGrantSha256: config.cohortGrantSha256,
			transport: config.transport,
			role,
			childId: config.childId,
			roleId,
			workerIndex: config.workerIndex,
			tokenBase64: entry.tokenBase64,
			tokenSha256: entry.tokenSha256,
			tokenCommitmentIndex: entry.tokenCommitmentIndex,
			tokenMerkleProofSha256: [...entry.tokenMerkleProofSha256],
		});
		if (!registered.ok) {
			closeAll();
			return registered;
		}
		const accepted = await inbox.nextOfKind("accept", "refuse");
		if (accepted === null || accepted.kind !== "accept") {
			closeAll();
			await control.send({
				schema: "connect-permit-complete/v1",
				sequence: 0,
				executionSha256: config.executionSha256,
				cohortGrantSha256: config.cohortGrantSha256,
				childId: config.childId,
				globalOrdinal,
				permitNonce: permitGrant.value.permitNonce,
				startedAtMacNs,
				completedAtMacNs: clock.nowNs(),
				outcome: "failed",
			});
			// The relay's closed refuse code travels with the refusal; a session
			// that ended without any answer is named as such, not as a refusal.
			return notReady(
				`relay refused registration for ${roleId}: ${
					accepted === null
						? "the session ended before an accept or refuse frame"
						: accepted.kind === "refuse"
							? accepted.code
							: `unexpected ${accepted.kind}`
				}`,
			);
		}

		await control.send({
			schema: "connect-permit-complete/v1",
			sequence: 0,
			executionSha256: config.executionSha256,
			cohortGrantSha256: config.cohortGrantSha256,
			childId: config.childId,
			globalOrdinal,
			permitNonce: permitGrant.value.permitNonce,
			startedAtMacNs,
			completedAtMacNs: clock.nowNs(),
			outcome: "ready",
		});
	}

	await control.send({
		schema: "role-ready/v1",
		sequence: 0,
		executionSha256: config.executionSha256,
		cohortGrantSha256: config.cohortGrantSha256,
		childId: config.childId,
		childPid: args.process.pid,
		childPgid: args.process.pgid,
		childInstanceNonce: config.childInstanceNonce,
		registeredSessionCount: sessions.size,
	});

	// -- 4. warmup ----------------------------------------------------------
	const warmupStartFrame = await control.receive("role-warmup-start/v1");
	const authorized = verifyRoleWarmupStart({
		frame: warmupStartFrame,
		config,
		grant,
		macSigningPublicKey: validated.value.macSigningPublicKey,
	});
	if (!authorized.ok) {
		closeAll();
		return authorized;
	}
	const warmupStart = authorized.value.start;

	const warmupStartedAtMacNs = clock.nowNs();
	let offeredWarmupIngress = 0;
	let deliveredWarmupRecords = 0;
	if (config.role === "publisher") {
		const publisherId = config.publisherId as string;
		const session = sessions.get(publisherId) as RoleSessionHandle;
		for (const offsetMs of WARMUP_OFFSETS_MS) {
			await clock.sleepUntilNs(nsPlusMs(warmupStart.startAtMacNs, offsetMs));
			const sequence = offsetMs / WARMUP_INTERVAL_MS;
			const payload = fanoutPayload(
				config.payloadBytes,
				`${config.cohortGrantSha256}:${publisherId}:warmup:${sequence}`,
			);
			const sent = await session.send({
				schema: "fanout-wire/v1",
				kind: "warmup-data",
				direction: "publisher-to-relay",
				cohortGrantSha256: config.cohortGrantSha256,
				cohortWarmupEpochSha256: warmupStart.cohortWarmupEpochSha256,
				warmupNonce: warmupStart.warmupNonce,
				publisherId,
				publisherSequence: sequence,
				subscriberId: null,
				linuxAcceptedOrdinal: null,
				payloadBase64: payload.payloadBase64,
				payloadSha256: payload.payloadSha256,
				payloadBytes: config.payloadBytes,
			});
			if (!sent.ok) {
				closeAll();
				return sent;
			}
			offeredWarmupIngress += 1;
		}
		if (offeredWarmupIngress !== WARMUP_MESSAGES_PER_PUBLISHER) {
			closeAll();
			return cohortFail("publisher did not offer exactly ten warmup frames");
		}
		const ended = await session.send({
			schema: "fanout-wire/v1",
			kind: "warmup-end",
			cohortGrantSha256: config.cohortGrantSha256,
			cohortWarmupEpochSha256: warmupStart.cohortWarmupEpochSha256,
			warmupNonce: warmupStart.warmupNonce,
			role: "publisher",
			roleId: publisherId,
			finalPublisherSequence: WARMUP_MESSAGES_PER_PUBLISHER - 1,
			reason: "publisher-warmup-complete",
		});
		if (!ended.ok) {
			closeAll();
			return ended;
		}
	} else {
		const expected = warmupStart.expectedChildDeliveredWarmupRecords;
		const deadlineMs =
			Date.now() + config.warmupDurationMs + COHORT_DRAIN_DEADLINE_MS;
		while (deliveredWarmupRecords < expected && Date.now() < deadlineMs) {
			const drained = await drainOnce(inboxes, ({ frame }) => {
				if (frame.kind === "warmup-data") {
					deliveredWarmupRecords += 1;
				}
			});
			if (!drained) await tick();
		}
		if (deliveredWarmupRecords !== expected) {
			closeAll();
			return fail(
				"WARMUP_PROTOCOL",
				`worker saw ${deliveredWarmupRecords} of ${expected} warmup deliveries`,
			);
		}
	}

	await control.send({
		schema: "role-warmup-complete/v1",
		sequence: 0,
		executionSha256: config.executionSha256,
		cohortGrantSha256: config.cohortGrantSha256,
		cohortWarmupEpochSha256: warmupStart.cohortWarmupEpochSha256,
		warmupNonce: warmupStart.warmupNonce,
		childId: config.childId,
		role: config.role,
		startedAtMacNs: warmupStartedAtMacNs,
		completedAtMacNs: clock.nowNs(),
		offeredWarmupIngress,
		deliveredWarmupRecords,
	});

	// -- 5. barrier ---------------------------------------------------------
	const measureStartFrame = await control.receive("role-measure-start/v1");
	const armed = verifyRoleMeasureStart({
		frame: measureStartFrame,
		config,
		grant,
		...(args.macClockId === undefined ? {} : { macClockId: args.macClockId }),
	});
	if (!armed.ok) {
		closeAll();
		return armed;
	}
	const barrier = armed.value.barrier;
	const cohortStartBarrierSha256 = armed.value.cohortStartBarrierSha256;
	const measureStartAtMacNs = armed.value.barrier.measureStartAtMacNs;
	const measureStopAtMacNs = armed.value.barrier.measureStopAtMacNs;
	const macClockId = armed.value.barrier.macClockId;

	// -- 6. measured traffic ------------------------------------------------
	const windowCount = barrier.windowCount;
	const publisherBook =
		config.role === "publisher"
			? new PublisherWindowBook({
					windowCount,
					messageBytes: config.payloadBytes,
				})
			: null;
	const workerBook =
		config.role === "subscriber-worker"
			? new WorkerWindowBook({
					windowCount,
					messageBytes: config.payloadBytes,
					orderedSubscriberIds: assignedRoleIds,
				})
			: null;

	// Subscriber sessions the relay has sent its `relay-drained` end marker to;
	// a worker's drain is complete when every session it owns has one.
	const endedSubscribers = new Set<string>();

	const consumeWorkerFrame = ({
		frame,
		arrivedAtMacNs,
	}: StampedFrame): void => {
		if (workerBook === null) return;
		if (frame.kind === "end" && frame.role === "subscriber") {
			endedSubscribers.add(frame.roleId);
			return;
		}
		if (frame.kind !== "data") return;
		const event = classifyDelivery({
			deliveredAtMacNs: arrivedAtMacNs,
			measureStartAtMacNs,
			measureStopAtMacNs,
			windowCount,
		});
		workerBook.recordDelivery({
			subscriberId: frame.subscriberId ?? "",
			publisherId: frame.publisherId,
			publisherSequence: frame.publisherSequence,
			originWindowIndex: frame.windowIndex,
			deliveredAtMacNs: arrivedAtMacNs,
			eventWindow: event,
		});
	};

	const consumePublisherFrame = ({
		frame,
		arrivedAtMacNs,
	}: StampedFrame): void => {
		if (publisherBook === null) return;
		if (frame.kind !== "ack") return;
		publisherBook.recordAck({
			originWindowIndex: frame.windowIndex,
			disposition: frame.disposition,
			atMacNs: arrivedAtMacNs,
		});
	};

	const consume = (stamped: StampedFrame): void => {
		consumePublisherFrame(stamped);
		consumeWorkerFrame(stamped);
	};

	// Armed means consuming: from here every ack and delivery is booked the
	// moment the transport hands it over, stamped with its arrival, whether or
	// not this child happens to be sleeping on its offer schedule or waiting on
	// the control pipe. The ack goes out only once that is true.
	for (const inbox of inboxes.values()) inbox.attach(consume);
	await control.send({
		schema: "role-measure-start-ack/v1",
		sequence: 0,
		executionSha256: config.executionSha256,
		childId: config.childId,
		cohortStartBarrierSha256,
		armedAtMacNs: clock.nowNs(),
	});

	// What the end marker has to report: the last frame this publisher actually
	// offered, not the schedule it was given. A publisher that stopped early says
	// so here rather than claiming the full window.
	let finalPublisherSequence: number | null = null;
	let finalWindowIndex = 0;
	if (publisherBook !== null) {
		const publisherId = config.publisherId as string;
		const session = sessions.get(publisherId) as RoleSessionHandle;
		const totalMessages =
			(config.messageRatePerSecond * config.measuredDurationMs) / 1000;
		if (!Number.isSafeInteger(totalMessages)) {
			closeAll();
			return cohortFail("rate and duration do not yield a whole message count");
		}
		for (let sequence = 0; sequence < totalMessages; sequence += 1) {
			const offsetNs =
				(BigInt(sequence) * NS_PER_SECOND_BIG) /
				BigInt(config.messageRatePerSecond);
			const offerAtMacNs = (BigInt(measureStartAtMacNs) + offsetNs).toString();
			await clock.sleepUntilNs(offerAtMacNs);
			const originWindowIndex = Number(offsetNs / NS_PER_SECOND_BIG);
			if (originWindowIndex >= windowCount) break;
			const payload = fanoutPayload(
				config.payloadBytes,
				`${cohortStartBarrierSha256}:${publisherId}:${sequence}`,
			);
			const sent = await session.send({
				schema: "fanout-wire/v1",
				kind: "data",
				direction: "publisher-to-relay",
				cohortGrantSha256: config.cohortGrantSha256,
				cohortStartBarrierSha256,
				windowIndex: originWindowIndex,
				publisherId,
				publisherSequence: sequence,
				subscriberId: null,
				linuxAcceptedOrdinal: null,
				payloadBase64: payload.payloadBase64,
				payloadSha256: payload.payloadSha256,
				payloadBytes: config.payloadBytes,
			});
			if (!sent.ok) {
				closeAll();
				return sent;
			}
			const offered = publisherBook.recordOffer({
				originWindowIndex,
				atMacNs: clock.nowNs(),
			});
			if (!offered.ok) {
				closeAll();
				return offered;
			}
			finalPublisherSequence = sequence;
			finalWindowIndex = originWindowIndex;
		}
	}

	// -- 7. stop and bounded drain ------------------------------------------
	const stopFrame = await control.receive("role-stop/v1");
	const stop = parseRoleStop(stopFrame);
	if (!stop.ok) {
		closeAll();
		return stop;
	}
	if (stop.value.cohortStartBarrierSha256 !== cohortStartBarrierSha256) {
		closeAll();
		return cohortFail("stop names another start barrier");
	}

	let endMarkerSent = false;
	if (publisherBook !== null) {
		const publisherId = config.publisherId as string;
		const session = sessions.get(publisherId) as RoleSessionHandle;
		if (finalPublisherSequence === null) {
			closeAll();
			return cohortFail("publisher offered no measured frame to end on");
		}
		const sent = await session.send({
			schema: "fanout-wire/v1",
			kind: "end",
			cohortGrantSha256: config.cohortGrantSha256,
			cohortStartBarrierSha256,
			role: "publisher",
			roleId: publisherId,
			finalWindowIndex,
			finalPublisherSequence,
			reason: "publisher-complete",
		});
		if (!sent.ok) {
			closeAll();
			return sent;
		}
		endMarkerSent = true;
	}

	// The drain is bounded by what is still owed, up to the same instant the
	// verifier applies to every delivery timestamp: the barrier's measured stop
	// plus the 10 s drain deadline, on this child's clock
	// (`computeCohortEventWindow`, cohort-protocol.ts). It is deliberately not
	// "ten seconds after the stop frame was read": the stop frame is queued on
	// the pipe from the moment the child is armed, and a worker's reading of it
	// has nothing to do with when the relay finishes.
	const drainDeadlineAtMacNs =
		BigInt(measureStopAtMacNs) +
		BigInt(COHORT_DRAIN_DEADLINE_MS) * NS_PER_MS_BIG;
	const drained = (): boolean =>
		publisherBook !== null
			? publisherBook.outstandingAcks() === 0
			: endedSubscribers.size >= assignedRoleIds.length;
	while (!drained() && BigInt(clock.nowNs()) < drainDeadlineAtMacNs) {
		await tick();
	}
	// Whatever lands after this is past the deadline the verifier refuses; the
	// books close here so the partial states exactly what arrived in time.
	for (const inbox of inboxes.values()) inbox.detach();
	if (publisherBook !== null && !drained()) {
		// An offer with no answer is not an offer the relay refused: it is an
		// unknown, and a partial that booked it as unaccepted would make
		// `OA_origin[w] = A_origin[w]` fail at recomputation for a reason this
		// child can name now. Plan §7: DRAIN_DEADLINE_EXCEEDED -> RELAY_DELIVERY.
		closeAll();
		return fail(
			"DRAIN_DEADLINE_EXCEEDED",
			`${publisherBook.outstandingAcks()} of ${publisherBook.offeredCount} offered frames unacknowledged at the drain deadline`,
		);
	}

	// -- 8. partial, acceptance, exit ---------------------------------------
	const partial =
		publisherBook !== null
			? publisherBook.toPartial({
					executionSha256: config.executionSha256,
					cohortGrantSha256: config.cohortGrantSha256,
					cohortStartBarrierSha256,
					childId: config.childId,
					process: args.process,
					childInstanceNonce: config.childInstanceNonce,
					publisherId: config.publisherId as string,
					tokenSha256: (entries.value[0] as TokenBundleEntryV1).tokenSha256,
					macClockId,
					measureStartAtMacNs,
				})
			: (workerBook as WorkerWindowBook).toPartial({
					executionSha256: config.executionSha256,
					cohortGrantSha256: config.cohortGrantSha256,
					cohortStartBarrierSha256,
					childId: config.childId,
					process: args.process,
					childInstanceNonce: config.childInstanceNonce,
					workerIndex: config.workerIndex as number,
					tokenBundleSha256: config.tokenBundleSha256,
					macClockId,
					measureStartAtMacNs,
				});
	if (!partial.ok) {
		closeAll();
		return partial;
	}
	const partialBytes = bytesOfCanonical(partial.value);
	const partialSha256 = sha256HexOfBytes(partialBytes);
	await control.send({
		schema: "role-partial/v1",
		sequence: 0,
		executionSha256: config.executionSha256,
		childId: config.childId,
		partialKind: config.role === "publisher" ? "publisher" : "worker",
		partialBase64: Buffer.from(partialBytes).toString("base64") as Base64,
		partialSha256,
	});
	const acceptedFrame = await control.receive("role-partial-accepted/v1");
	const accepted = parseRolePartialAccepted(acceptedFrame);
	if (!accepted.ok) {
		closeAll();
		return accepted;
	}
	if (accepted.value.partialSha256 !== partialSha256) {
		closeAll();
		return cohortFail("supervisor accepted a partial this child did not send");
	}

	await control.receive("role-exit/v1");
	closeAll();
	await control.send({
		schema: "role-exited/v1",
		sequence: 0,
		executionSha256: config.executionSha256,
		childId: config.childId,
		exitCode: 0,
	});
	if (publisherBook !== null && !endMarkerSent) {
		return cohortFail("publisher exited without sending its end marker");
	}
	return {
		ok: true,
		value: {
			childId: config.childId,
			role: config.role,
			registeredSessionCount: sessions.size,
			partialSha256,
			exitCode: 0,
		},
	};
}

// ---------------------------------------------------------------------------
// Small internals
// ---------------------------------------------------------------------------

/** Delivery classification with the §4.5 event-window rule, inlined. */
function classifyDelivery(args: {
	readonly deliveredAtMacNs: NsString;
	readonly measureStartAtMacNs: NsString;
	readonly measureStopAtMacNs: NsString;
	readonly windowCount: 10 | 30;
}): number | null {
	const at = BigInt(args.deliveredAtMacNs);
	const start = BigInt(args.measureStartAtMacNs);
	const stop = BigInt(args.measureStopAtMacNs);
	if (at < start || at >= stop) return null;
	const window = Number((at - start) / NS_PER_SECOND_BIG);
	return window < args.windowCount ? window : null;
}

/**
 * §5 step 7: no warmup authority the child acts on is digest-only. The frame's
 * own parser already proved `cohortWarmupEpochSha256` commits to these bytes;
 * what this adds is the part a supervisor cannot forge without the Mac key --
 * the signature over the exact epoch bytes, verified under the key the spawn
 * config pinned to the staged digest.
 */
function decodeWarmupEpoch(args: {
	readonly epochBase64: Base64;
	readonly signatureBase64: Base64;
	readonly macSigningPublicKey: Uint8Array;
}): ProtocolResult<CohortWarmupEpochV1> {
	const bytes = decodeStrictBase64(
		args.epochBase64,
		COHORT_WARMUP_EPOCH_MAX_BYTES,
	);
	if (bytes === null) return cohortFail("warmup epoch bytes");
	const signature = decodeStrictBase64(
		args.signatureBase64,
		ED25519_SIGNATURE_BYTES,
	);
	if (signature === null) return cohortFail("warmup epoch signature bytes");
	if (!ed25519Verify(args.macSigningPublicKey, bytes, signature)) {
		return fail(
			"WARMUP_PROTOCOL",
			"warmup epoch signature does not verify under the staged Mac key",
		);
	}
	const json = parseStrictJsonBytes(bytes);
	if (!json.ok) return cohortFail(`warmup epoch json ${json.reason}`);
	return parseCohortWarmupEpoch(json.value);
}

function decodeStartBarrier(
	barrierBase64: Base64,
): ProtocolResult<CohortStartBarrierV1> {
	const bytes = decodeStrictBase64(barrierBase64, ROLE_CHILD_FRAME_MAX_BYTES);
	if (bytes === null) return cohortFail("start barrier bytes");
	const json = parseStrictJsonBytes(bytes);
	if (!json.ok) return cohortFail(`start barrier json ${json.reason}`);
	return parseCohortStartBarrier(json.value);
}

function requirePermitGrant(
	frame: unknown,
	context: {
		readonly config: RoleSpawnConfigV1;
		readonly globalOrdinal: number;
	},
): ProtocolResult<{
	readonly notBeforeMacNs: NsString;
	readonly permitNonce: Sha256Hex;
}> {
	const parsed = parseConnectPermitGrant(frame);
	if (!parsed.ok) return parsed;
	const grant = parsed.value;
	// A permit is authority to open exactly one connection, for exactly one
	// ordinal, by exactly this child. A grant addressed to anyone else is not a
	// grant this child may spend, however well-formed it is.
	if (
		grant.executionSha256 !== context.config.executionSha256 ||
		grant.cohortGrantSha256 !== context.config.cohortGrantSha256 ||
		grant.childId !== context.config.childId ||
		grant.globalOrdinal !== context.globalOrdinal
	) {
		return notReady("connect permit grant is not for this child and ordinal");
	}
	return {
		ok: true,
		value: {
			notBeforeMacNs: grant.notBeforeMacNs,
			permitNonce: grant.permitNonce,
		},
	};
}

/**
 * A frame with the instant the transport handed it to this child. §4.5 makes
 * the event window a function of the *actual* `deliveredAtMacNs`, so the stamp
 * is taken here, at arrival, and never at whatever later moment the frame is
 * read out of the queue.
 */
interface StampedFrame {
	readonly frame: FanoutWireV1;
	readonly arrivedAtMacNs: NsString;
}

interface FrameQueue {
	push(frame: FanoutWireV1): void;
	take(): StampedFrame | null;
	nextOfKind(...kinds: readonly string[]): Promise<FanoutWireV1 | null>;
	/**
	 * Hand every queued frame, then every later one the moment it arrives, to
	 * `consumer`. After this the queue holds nothing; the measured phase reads
	 * frames as they land rather than in batches.
	 */
	attach(consumer: (stamped: StampedFrame) => void): void;
	/** Back to queueing; frames after this are held and not consumed. */
	detach(): void;
}

function createFrameQueue(clock: RoleClock): FrameQueue {
	const pending: StampedFrame[] = [];
	let live: ((stamped: StampedFrame) => void) | null = null;
	return {
		push: (frame) => {
			const stamped: StampedFrame = { frame, arrivedAtMacNs: clock.nowNs() };
			if (live !== null) live(stamped);
			else pending.push(stamped);
		},
		take: () => pending.shift() ?? null,
		nextOfKind: async (...kinds) => {
			const deadlineMs = Date.now() + COHORT_DRAIN_DEADLINE_MS;
			while (Date.now() < deadlineMs) {
				const index = pending.findIndex((stamped) =>
					kinds.includes(stamped.frame.kind),
				);
				if (index >= 0) {
					return (pending.splice(index, 1)[0] as StampedFrame).frame;
				}
				await tick();
			}
			return null;
		},
		attach: (consumer) => {
			live = consumer;
			for (const stamped of pending.splice(0)) consumer(stamped);
		},
		detach: () => {
			live = null;
		},
	};
}

/** Drain whatever has already arrived; `true` if anything moved. */
async function drainOnce(
	inboxes: ReadonlyMap<string, FrameQueue>,
	consume: (stamped: StampedFrame) => void,
): Promise<boolean> {
	let moved = false;
	for (const inbox of inboxes.values()) {
		for (;;) {
			const stamped = inbox.take();
			if (stamped === null) break;
			consume(stamped);
			moved = true;
		}
	}
	return moved;
}

function tick(): Promise<void> {
	return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

// ---------------------------------------------------------------------------
// Framed control channel over a byte stream
// ---------------------------------------------------------------------------

export interface RoleControlByteStream {
	readAtLeastOneChunk(): Promise<Uint8Array | null>;
	write(bytes: Uint8Array): Promise<void>;
}

/**
 * The production control channel: B1's role-child codec over a byte pipe, with
 * the independent per-direction sequence the framing contract requires. A frame
 * whose schema is not what the state machine expects is refused rather than
 * buffered, which is what keeps a supervisor from reordering the lifecycle.
 */
export function createFramedRoleControlChannel(args: {
	readonly stream: RoleControlByteStream;
	readonly maxFramesPerDirection: number;
}): RoleControlChannel {
	const sequence: ChildSequenceState = createChildSequenceState();
	const reader = new RoleChildFrameReader();
	const ready: Uint8Array[] = [];

	const nextFrame = async (): Promise<Uint8Array> => {
		for (;;) {
			const frame = ready.shift();
			if (frame !== undefined) return frame;
			const chunk = await args.stream.readAtLeastOneChunk();
			if (chunk === null) throw new Error("control pipe ended mid-lifecycle");
			const pushed = reader.push(chunk);
			if (!pushed.ok) throw new Error(`control pipe frame: ${pushed.code}`);
			ready.push(...pushed.value);
		}
	};

	return {
		receive: async (expectedSchema) => {
			const frame = await nextFrame();
			const decoded = decodeRoleChildFrame(frame, expectedSchema);
			if (!decoded.ok) {
				throw new Error(`control frame ${expectedSchema}: ${decoded.code}`);
			}
			const inbound = assertChildInboundSequence(
				sequence,
				decoded.value.sequence as number,
				args.maxFramesPerDirection,
			);
			if (!inbound.ok) {
				throw new Error(`control frame sequence: ${inbound.code}`);
			}
			return decoded.value;
		},
		send: async (frame) => {
			const outbound = assertChildOutboundSequence(
				sequence,
				sequence.outbound,
				args.maxFramesPerDirection,
			);
			if (!outbound.ok) {
				throw new Error(`control frame sequence: ${outbound.code}`);
			}
			const stamped = { ...frame, sequence: sequence.outbound - 1 };
			const encoded = encodeRoleChildFrame(stamped);
			if (!encoded.ok) throw new Error(`control frame: ${encoded.code}`);
			await args.stream.write(encoded.value);
		},
	};
}

/** The per-direction ceiling for a child that owns this many sessions. */
export function roleChildFrameCeiling(assignedSessionCount: number): number {
	return roleChildMaxFramesPerDirection(assignedSessionCount);
}

/** A deterministic instance nonce for a child that must mint one. */
export function roleChildInstanceNonce(label: string): Sha256Hex {
	return createHash("sha256").update(label).digest("hex");
}

// ---------------------------------------------------------------------------
// Spawned-child entrypoint
// ---------------------------------------------------------------------------

/** §3.4: FD 3 is supervisor->child read-only, FD 4 is child->supervisor. */
export const ROLE_CONTROL_READ_FD = 3;
export const ROLE_CONTROL_WRITE_FD = 4;

/** The two facts a spawned child cannot learn from a frame it has not read. */
export const STAGED_MAC_KEY_SHA256_ENV = "WT_COMPARE_STAGED_MAC_KEY_SHA256";
/** The staged CA PEM a spawned role child verifies the relay against. */
export const STAGED_TLS_CA_PEM_ENV = "WT_COMPARE_STAGED_TLS_CA_PEM";
export const TOKEN_FD_SPAWN_OBSERVATION_ENV = "WT_COMPARE_TOKEN_FD_OBSERVATION";

/** The control pipe as a byte stream over the inherited FD pair. */
export function createInheritedControlByteStream(args: {
	readonly readFd: number;
	readonly writeFd: number;
}): RoleControlByteStream {
	const fs = process.getBuiltinModule("node:fs") as typeof import("node:fs");
	return {
		readAtLeastOneChunk: () =>
			new Promise<Uint8Array | null>((resolve, reject) => {
				const buffer = Buffer.allocUnsafe(64 * 1024);
				fs.read(
					args.readFd,
					buffer,
					0,
					buffer.byteLength,
					null,
					(error, read) => {
						if (error) reject(error);
						else
							resolve(
								read === 0 ? null : new Uint8Array(buffer.subarray(0, read)),
							);
					},
				);
			}),
		write: (bytes) =>
			new Promise<void>((resolve, reject) => {
				fs.write(args.writeFd, bytes, 0, bytes.byteLength, null, (error) => {
					if (error) reject(error);
					else resolve();
				});
			}),
	};
}

/**
 * FD 5 as the child actually finds it. The spawn-time observation is the
 * supervisor's, inherited through the environment because it describes the
 * descriptor before the child existed; the read-time one is measured here, and
 * `validateTokenBundleFdMetadata` is what decides whether they agree.
 */
export function createInheritedTokenBundleFdSource(
	fd: number = TOKEN_BUNDLE_FD,
): TokenBundleFdSource {
	const fs = process.getBuiltinModule("node:fs") as typeof import("node:fs");
	let contents: Uint8Array | null = null;
	const readAll = (): Uint8Array => {
		if (contents !== null) return contents;
		const stat = fs.fstatSync(fd);
		const buffer = Buffer.allocUnsafe(Number(stat.size));
		let filled = 0;
		while (filled < buffer.byteLength) {
			const read = fs.readSync(
				fd,
				buffer,
				filled,
				buffer.byteLength - filled,
				filled,
			);
			if (read === 0) break;
			filled += read;
		}
		contents = new Uint8Array(buffer.subarray(0, filled));
		return contents;
	};
	return {
		observationAtSpawn: () => {
			const raw = process.env[TOKEN_FD_SPAWN_OBSERVATION_ENV];
			if (raw === undefined) {
				throw new Error(`${TOKEN_FD_SPAWN_OBSERVATION_ENV} was not inherited`);
			}
			return JSON.parse(raw) as Rec;
		},
		observationAtRead: () => {
			const stat = fs.fstatSync(fd);
			const bytes = readAll();
			return {
				schema: "token-bundle-fd-observation/v1",
				fd: TOKEN_BUNDLE_FD,
				fileKind: stat.isFile() ? "regular" : "fifo",
				accessMode: "read-only",
				appendMode: false,
				hardLinkCount: stat.nlink,
				deviceId: `${stat.dev}`,
				inode: `${stat.ino}`,
				byteSize: bytes.byteLength,
				contentSha256: sha256HexOfBytes(bytes),
			};
		},
		read: async () => readAll(),
		close: () => {
			try {
				fs.closeSync(fd);
			} catch {
				// Already closed; the contract is that it is not open afterwards.
			}
		},
	};
}

/** Bound on the identity handshake a WS role connector runs before it connects. */
export const WS_ROLE_TLS_IDENTITY_DEADLINE_MS = 5_000;

/**
 * Prove, on a real TLS handshake, that `host:port` presents a certificate for
 * `serverName` that chains to `caPem`, and return the exact leaf it presented.
 *
 * Bun's `WebSocket` verifies a chain against `tls.ca` but ignores
 * `servername` and `checkServerIdentity` (measured on Bun 1.3.14: a DNS-only
 * SAN certificate reached by IP opens under every spelling of those options),
 * so the name check has to happen on a handshake that does honour it --
 * `node:tls.connect`, which sends `serverName` as SNI and refuses a leaf whose
 * subjectAltName does not carry it. The leaf that passed is what the WebSocket
 * is then pinned to, so the socket that carries relay frames cannot be
 * answered by any certificate but the one whose identity was checked.
 */
export async function verifyWsRoleServerIdentity(args: {
	readonly host: string;
	readonly port: number;
	readonly serverName: string;
	readonly caPem: string;
	readonly deadlineMs?: number;
}): Promise<{ readonly leafPem: string; readonly leafSha256: string }> {
	return await new Promise((resolve, reject) => {
		let settled = false;
		const socket = tlsConnect({
			host: args.host,
			port: args.port,
			servername: args.serverName,
			ca: args.caPem,
			rejectUnauthorized: true,
			checkServerIdentity: (_host: string, certificate: PeerCertificate) =>
				checkServerIdentity(args.serverName, certificate),
		});
		const finish = (
			outcome:
				| { ok: true; leafPem: string; leafSha256: string }
				| { ok: false; error: Error },
		) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			if (outcome.ok)
				resolve({ leafPem: outcome.leafPem, leafSha256: outcome.leafSha256 });
			else reject(outcome.error);
		};
		const timer = setTimeout(
			() =>
				finish({
					ok: false,
					error: new Error(
						`TLS identity handshake to ${args.host}:${args.port} for ${args.serverName} exceeded ${args.deadlineMs ?? WS_ROLE_TLS_IDENTITY_DEADLINE_MS} ms`,
					),
				}),
			args.deadlineMs ?? WS_ROLE_TLS_IDENTITY_DEADLINE_MS,
		);
		socket.once("secureConnect", () => {
			if (!socket.authorized) {
				finish({
					ok: false,
					error: new Error(
						`TLS identity for ${args.serverName} not authorized: ${socket.authorizationError}`,
					),
				});
				return;
			}
			// Bun's abbreviated form carries no `raw`; the detailed form does
			// (measured on Bun 1.3.14: `getPeerCertificate(false)` is `{}`).
			const leaf = socket.getPeerCertificate(true);
			const raw = leaf?.raw;
			if (!(raw instanceof Uint8Array) || raw.byteLength === 0) {
				finish({
					ok: false,
					error: new Error(`${args.serverName} presented no leaf certificate`),
				});
				return;
			}
			const base64 = Buffer.from(raw).toString("base64");
			const lines = base64.match(/.{1,64}/g) ?? [];
			finish({
				ok: true,
				leafPem: `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----\n`,
				leafSha256: createHash("sha256").update(raw).digest("hex"),
			});
		});
		socket.once("error", (error: Error) => finish({ ok: false, error }));
	});
}

/**
 * `ws-binary-message-per-frame`: one relay frame per binary WS message.
 *
 * Exactly one of `caPem` (a live run: the staged CA, SNI-verified against the
 * session's `tlsServerName` and the socket pinned to the verified leaf) and
 * `insecureSkipVerify` (development only: the Bun `rejectUnauthorized: false`
 * translation, never a live run) is accepted; neither is a refusal, because a
 * role child with nothing to verify against would be connecting to whatever
 * answered.
 */
export function createWsRoleTransportConnector(args?: {
	readonly urlFor?: (host: string, port: number) => string;
	readonly insecureSkipVerify?: boolean;
	readonly caPem?: string;
}): RoleTransportConnector {
	return {
		transport: "ws",
		connect: async (session) => {
			const url =
				args?.urlFor?.(session.serverHost, session.serverPort) ??
				`wss://${session.serverHost}:${session.serverPort}`;
			const { connectBinaryMessageClient } = await import("../adapters/ws.ts");
			let tls: { readonly rejectUnauthorized: boolean; readonly ca?: string };
			if (args?.insecureSkipVerify === true) {
				tls = { rejectUnauthorized: false };
			} else if (typeof args?.caPem === "string" && args.caPem.length > 0) {
				const verified = await verifyWsRoleServerIdentity({
					host: session.serverHost,
					port: session.serverPort,
					serverName: session.tlsServerName,
					caPem: args.caPem,
				});
				tls = { rejectUnauthorized: true, ca: verified.leafPem };
			} else {
				throw new Error(
					"ws role connector needs the staged CA (caPem) or an explicit development opt-out (insecureSkipVerify)",
				);
			}
			const client = await connectBinaryMessageClient({
				url,
				onMessage: (bytes) => {
					const decoded = decodeFanoutWsMessage(bytes);
					if (decoded.ok) session.onFrame(decoded.value);
				},
				tls,
			});
			return {
				roleId: session.roleId,
				send: async (frame) => {
					const encoded = encodeFanoutWsMessage(frame);
					if (!encoded.ok) return encoded;
					client.send(encoded.value);
					return { ok: true, value: true };
				},
				close: () => {
					client.close();
				},
			};
		},
	};
}

/**
 * `wt-publisher-bidi-subscriber-control-bidi-server-uni`: one control bidi
 * stream per role, server-opened uni streams for delivery, both carrying
 * `u32be length || frame`.
 */
export function createWtRoleTransportConnector(args?: {
	readonly urlFor?: (host: string, port: number) => string;
	readonly insecureSkipVerify?: boolean;
	readonly caPem?: string;
}): RoleTransportConnector {
	return {
		transport: "wt",
		connect: async (session) => {
			const url =
				args?.urlFor?.(session.serverHost, session.serverPort) ??
				`https://${session.serverHost}:${session.serverPort}`;
			const { LengthPrefixedFrameReader, productionWtAdapterOptions } =
				await import("../adapters/wt.ts");
			const { clientFactory } = await productionWtAdapterOptions();
			const client = await clientFactory(url, {
				tls: {
					serverName: session.tlsServerName,
					...(args?.insecureSkipVerify ? { insecureSkipVerify: true } : {}),
					...(args?.caPem === undefined ? {} : { caPem: args.caPem }),
				},
			});
			await client.ready;
			const readInto = (stream: {
				on(event: "data", listener: (chunk: Uint8Array) => void): unknown;
			}): void => {
				const frames = new LengthPrefixedFrameReader(
					FANOUT_CONTROL_FRAME_MAX_DECODED_BYTES,
				);
				stream.on("data", (chunk) => {
					for (const bytes of frames.push(chunk)) {
						const decoded = decodeFanoutWtStream(bytes);
						if (decoded.ok && decoded.value.length === 1) {
							session.onFrame(decoded.value[0] as FanoutWireV1);
						}
					}
				});
			};
			const control = (await client.createBidirectionalStream()) as unknown as {
				on(event: "data", listener: (chunk: Uint8Array) => void): unknown;
				write(chunk: Uint8Array): boolean;
			};
			readInto(control);
			void (async () => {
				for await (const uni of client.incomingUnidirectionalStreams()) {
					readInto(
						uni as unknown as {
							on(event: "data", listener: (chunk: Uint8Array) => void): unknown;
						},
					);
				}
			})().catch(() => {
				// The session ended; whatever it delivered before that stands.
			});
			return {
				roleId: session.roleId,
				send: async (frame) => {
					const encoded = encodeFanoutWtFrame(frame);
					if (!encoded.ok) return encoded;
					control.write(encoded.value);
					return { ok: true, value: true };
				},
				close: () => {
					client.close();
				},
			};
		},
	};
}

/**
 * Assemble the production seams and run the loop. Exported so the integration
 * harness can exercise the same assembly the spawned process uses, without
 * being the spawned process.
 */
export async function runSpawnedFanoutRoleChild(args?: {
	readonly transport?: "ws" | "wt";
}): Promise<ProtocolResult<FanoutRoleChildOutcome>> {
	const staged = process.env[STAGED_MAC_KEY_SHA256_ENV];
	if (staged === undefined || !/^[0-9a-f]{64}$/.test(staged)) {
		return cohortFail(
			`${STAGED_MAC_KEY_SHA256_ENV} is not a staged key digest`,
		);
	}
	// The staged CA is the only verification material a spawned child ever
	// connects with. There is no development opt-out on this path; a child
	// spawned without it still reads its config and asks for its permits, and
	// refuses at the first connect rather than connecting to whatever answered.
	const caPem = process.env[STAGED_TLS_CA_PEM_ENV];
	const connectorTls = caPem?.includes("-----BEGIN CERTIFICATE-----")
		? { caPem }
		: {};
	const stream = createInheritedControlByteStream({
		readFd: ROLE_CONTROL_READ_FD,
		writeFd: ROLE_CONTROL_WRITE_FD,
	});
	const transport = args?.transport ?? "ws";
	return runFanoutRoleChild({
		control: createFramedRoleControlChannel({
			stream,
			// Sized for the worst-case shard so the ramp protocol always fits.
			maxFramesPerDirection: roleChildFrameCeiling(
				CHAT_10K_WORST_CASE_WORKER_SUBSCRIBERS,
			),
		}),
		tokenBundleFd: createInheritedTokenBundleFdSource(),
		clock: createSystemRoleClock(),
		connector:
			transport === "wt"
				? createWtRoleTransportConnector(connectorTls)
				: createWsRoleTransportConnector(connectorTls),
		process: { pid: process.pid, pgid: process.pid },
		stagedMacSigningPublicKeySha256: staged,
	});
}

// Entrypoint when the Mac supervisor spawns this file as a role child.
if (import.meta.main) {
	const transport = process.argv.includes("--transport=wt") ? "wt" : "ws";
	const outcome = await runSpawnedFanoutRoleChild({ transport });
	if (!outcome.ok) {
		console.error(`[fanout-role] ${outcome.code}: ${outcome.message}`);
		process.exit(1);
	}
	process.exit(outcome.value.exitCode);
}
