/**
 * The bounded fanout relay engine (plan §4.1-§4.5, phase B2).
 *
 * This is the Linux-side state machine only: registration admission, accepted
 * ingress ordinals, warmup drain, measured-barrier enforcement, bounded
 * per-subscriber delivery, and bounded shutdown. It owns no socket. Every wire
 * schema, token schema, Merkle helper, and cap that already exists lives in
 * `cohort-protocol.ts` / `fanout-wire.ts` and is imported here; this module
 * defines no wire, auth, or token shape of its own.
 *
 * Two design choices make the same engine run over both transports and under a
 * deterministic test clock:
 *
 * 1. The transport seam is a non-blocking sink. `trySend` returns `accepted`,
 *    `would-block`, or `closed`; it never awaits. A congested WebSocket
 *    (`bufferedAmount` over threshold) and a congested WT stream (a pending
 *    write) both map onto `would-block`, and a test models a slow subscriber by
 *    returning `would-block` forever. Nothing in the engine schedules a timer.
 * 2. Time is injected. Write deadlines and the drain deadline are compared
 *    against `clock.nowMs()`, so a test advances a manual clock instead of
 *    sleeping and a production binding passes a real monotonic clock.
 *
 * Authority boundaries the engine enforces rather than trusts (§4.2): only the
 * relay assigns `linuxAcceptedOrdinal`; a publisher frame carrying one is
 * refused by the codec before it reaches here. Accepted ingress is recorded at
 * admission to the bounded global queue, and every per-subscriber delivery
 * failure afterwards lands in one of the three undelivered counters instead of
 * rewriting the acknowledgement the publisher already saw.
 */
import { createHash } from "node:crypto";
import {
	COHORT_DRAIN_DEADLINE_MS,
	COHORT_NOT_READY_FAILURE_CODE,
	COHORT_PROTOCOL_FAILURE_CODE,
	COHORT_WINDOW_COUNT_VALUES,
	COHORT_WORKER_COUNT,
	type LinuxRelayObservationV1,
	type PublisherRoleGrantV1,
	parseLinuxRelayObservation,
	parseRigBarrierAcceptance,
	RELAY_DELIVERY_FAILURE_CODE,
	type RigBarrierAcceptanceV1,
	SUBSCRIBER_SHARD_MODULUS,
	type SubscriberShardV1,
	type TokenCommitmentLeafV1,
	tokenCommitmentLeafSha256,
	verifyTokenMerkleProof,
	WARMUP_PROTOCOL_FAILURE_CODE,
} from "../cohort-protocol.ts";
import {
	type Base64,
	bytesOfCanonical,
	type NsString,
	type ProtocolResult,
	type Sha256Hex,
} from "../cross-supervisor-protocol.ts";
import { isHex64, sha256HexOfBytes } from "../secure-fs.ts";
import {
	decodeFanoutWsMessage,
	decodeFanoutWtStream,
	encodeFanoutWsMessage,
	encodeFanoutWtFrame,
	type FanoutAckClosedCode,
	type FanoutAckV1,
	type FanoutDataV1,
	type FanoutEndV1,
	type FanoutRefuseCode,
	type FanoutRegisterV1,
	type FanoutWarmupDataV1,
	type FanoutWarmupEndV1,
	type FanoutWireV1,
	parseFanoutWire,
	requireMeasuredFrameBinding,
	requireWarmupFrameBinding,
} from "./fanout-wire.ts";

// ---------------------------------------------------------------------------
// Relay bounds (plan line 123: the frozen relay envelope)
// ---------------------------------------------------------------------------

/** Per-subscriber delivery queue: 64 items and 64 KiB, whichever binds first. */
export const RELAY_SUBSCRIBER_QUEUE_MAX_ITEMS = 64;
export const RELAY_SUBSCRIBER_QUEUE_MAX_BYTES = 64 * 1024;

/** Global relay queue across every subscriber: 2,000,000 items and 256 MiB. */
export const RELAY_GLOBAL_QUEUE_MAX_ITEMS = 2_000_000;
export const RELAY_GLOBAL_QUEUE_MAX_BYTES = 256 * 1024 * 1024;

/** At most 256 subscriber writes are serviced in one pump round. */
export const RELAY_MAX_CONCURRENT_WRITES = 256;

/** A queued delivery older than 5 s is a write timeout and closes its session. */
export const RELAY_WRITE_DEADLINE_MS = 5_000;

/**
 * Control frames (accept/refuse/ack/end) are never dropped on a congested
 * transport, but they are not unbounded either: a session that cannot take this
 * many pending control frames is closed rather than buffered further.
 */
export const RELAY_CONTROL_BACKLOG_MAX_ITEMS = 16;

/** Bounded shutdown reuses the cohort-wide 10 s drain deadline. */
export const RELAY_DRAIN_DEADLINE_MS = COHORT_DRAIN_DEADLINE_MS;

export interface FanoutRelayCaps {
	readonly subscriberQueueMaxItems: number;
	readonly subscriberQueueMaxBytes: number;
	readonly globalQueueMaxItems: number;
	readonly globalQueueMaxBytes: number;
	readonly maxConcurrentWrites: number;
	readonly writeDeadlineMs: number;
	readonly drainDeadlineMs: number;
	readonly controlBacklogMaxItems: number;
}

export const FANOUT_RELAY_DEFAULT_CAPS: FanoutRelayCaps = {
	subscriberQueueMaxItems: RELAY_SUBSCRIBER_QUEUE_MAX_ITEMS,
	subscriberQueueMaxBytes: RELAY_SUBSCRIBER_QUEUE_MAX_BYTES,
	globalQueueMaxItems: RELAY_GLOBAL_QUEUE_MAX_ITEMS,
	globalQueueMaxBytes: RELAY_GLOBAL_QUEUE_MAX_BYTES,
	maxConcurrentWrites: RELAY_MAX_CONCURRENT_WRITES,
	writeDeadlineMs: RELAY_WRITE_DEADLINE_MS,
	drainDeadlineMs: RELAY_DRAIN_DEADLINE_MS,
	controlBacklogMaxItems: RELAY_CONTROL_BACKLOG_MAX_ITEMS,
};

// ---------------------------------------------------------------------------
// Transport seam
// ---------------------------------------------------------------------------

export type RelaySendOutcome = "accepted" | "would-block" | "closed";

/**
 * One relay-owned session. `trySend` must not block: a transport that cannot
 * take the bytes right now answers `would-block` and the engine leaves the
 * item at the head of that subscriber's queue, where the write deadline still
 * applies to it.
 */
export interface RelaySessionSink {
	trySend(bytes: Uint8Array): RelaySendOutcome;
	close(reason: string): void;
}

/** Framing is the only thing that differs between WS and WT (§4.2). */
export interface FanoutFrameCodec {
	readonly transport: "ws" | "wt";
	encode(frame: FanoutWireV1): ProtocolResult<Uint8Array>;
	decode(bytes: Uint8Array): ProtocolResult<FanoutWireV1>;
}

const WS_FANOUT_CODEC: FanoutFrameCodec = {
	transport: "ws",
	encode: encodeFanoutWsMessage,
	decode: decodeFanoutWsMessage,
};

/**
 * A WT reliable stream carries `u32be length || frame`. A relay read hands one
 * logical frame at a time, so a buffer holding anything but exactly one frame
 * is refused rather than silently split.
 */
const WT_FANOUT_CODEC: FanoutFrameCodec = {
	transport: "wt",
	encode: encodeFanoutWtFrame,
	decode: (bytes) => {
		const frames = decodeFanoutWtStream(bytes);
		if (!frames.ok) return frames;
		if (frames.value.length !== 1) {
			return relayFail(
				COHORT_PROTOCOL_FAILURE_CODE,
				`wt read carried ${frames.value.length} frames, expected exactly 1`,
			);
		}
		return { ok: true, value: frames.value[0] as FanoutWireV1 };
	},
};

export function fanoutFrameCodecFor(transport: "ws" | "wt"): FanoutFrameCodec {
	return transport === "ws" ? WS_FANOUT_CODEC : WT_FANOUT_CODEC;
}

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------

export interface RelayClock {
	nowMs(): number;
	nowNs(): NsString;
}

export interface ManualRelayClock extends RelayClock {
	advanceMs(deltaMs: number): void;
}

/**
 * Deterministic clock for tests: nanoseconds are derived from the same
 * millisecond value so an `NsString` on the wire and a deadline comparison can
 * never disagree about which happened first.
 */
export function createManualRelayClock(startMs = 1_000): ManualRelayClock {
	let currentMs = startMs;
	return {
		nowMs: () => currentMs,
		nowNs: () => `${BigInt(currentMs) * 1_000_000n}` as NsString,
		advanceMs: (deltaMs) => {
			if (!Number.isSafeInteger(deltaMs) || deltaMs < 0) {
				throw new Error("relay clock only advances by a non-negative integer");
			}
			currentMs += deltaMs;
		},
	};
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface FanoutRelayConfig {
	readonly transport: "ws" | "wt";
	readonly cohortId: string;
	readonly cohortGrantSha256: Sha256Hex;
	readonly cohortWarmupEpochSha256: Sha256Hex;
	readonly warmupNonce: Sha256Hex;
	readonly cohortStartBarrierSha256: Sha256Hex;
	readonly roleTokenCommitmentRootSha256: Sha256Hex;
	readonly roleTokenCommitmentCount: number;
	readonly publishers: readonly PublisherRoleGrantV1[];
	readonly subscriberShards: readonly SubscriberShardV1[];
	readonly expectedSubscriberIds: readonly string[];
	readonly windowCount: 10 | 30;
	readonly messageBytes: 100 | 128;
	readonly linuxClockId: string;
	readonly clock: RelayClock;
	readonly caps?: Partial<FanoutRelayCaps>;
}

export type FanoutRelayPhase =
	| "registration"
	| "warmup"
	| "warmup-drained"
	| "measured"
	| "draining"
	| "closed";

export const FANOUT_RELAY_FAULT_KINDS = [
	"control-backlog-full",
	"disconnect-undelivered",
	"duplicate-end-marker",
	"duplicate-ingress",
	"global-queue-full",
	"malformed-ingress",
	"missing-end-marker",
	"partial-connect",
	"post-stop-delivery",
	"queue-drop",
	"reordered-ingress",
	"subscriber-queue-full",
	"warmup-protocol",
	"write-timeout",
] as const;
export type FanoutRelayFaultKind = (typeof FANOUT_RELAY_FAULT_KINDS)[number];

export interface FanoutRelayFaultV1 {
	readonly kind: FanoutRelayFaultKind;
	readonly code: string;
	readonly detail: string;
}

export interface FanoutRelayCountersV1 {
	readonly windowCount: number;
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
	readonly registeredPublisherIds: readonly string[];
	readonly registeredSubscriberIds: readonly string[];
	readonly publisherEndCount: number;
	readonly subscriberEndCount: number;
	readonly sessionsAccepted: number;
	readonly sessionsActivePeak: number;
	readonly publisherSessionsActivePeak: number;
	readonly subscriberSessionsActivePeak: number;
	readonly queueItemsPeak: number;
	readonly queueBytesPeak: number;
	readonly concurrentWritesPeak: number;
	readonly queuedItems: number;
	readonly queuedBytes: number;
	readonly missingSubscriberRegistrations: number;
	readonly subscriberDisconnects: number;
	readonly postStopRelayWrites: number;
	readonly warmupIngress: number;
	readonly warmupDeliveries: number;
	readonly warmupPublisherEndCount: number;
}

export interface FanoutWarmupDrainSummaryV1 {
	readonly warmupIngress: number;
	readonly warmupDeliveries: number;
	readonly warmupQueuesEmpty: true;
	readonly measuredCountersReset: true;
	readonly drainedAtLinuxNs: NsString;
}

export interface FanoutRelayShutdownSummaryV1 {
	readonly allSessionsClosed: true;
	readonly drainedAtLinuxNs: NsString;
	readonly drainDurationMs: number;
	readonly subscriberEndCount: number;
	readonly reapedSessionCount: number;
	readonly queuedItemsAtClose: 0;
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

interface QueuedDelivery {
	readonly bytes: Uint8Array;
	readonly originWindowIndex: number;
	readonly linuxAcceptedOrdinal: number;
	readonly enqueuedAtMs: number;
	readonly warmup: boolean;
}

interface RelaySession {
	readonly sessionId: string;
	readonly sink: RelaySessionSink;
	role: "publisher" | "subscriber" | null;
	roleId: string | null;
	workerIndex: number | null;
	registered: boolean;
	closed: boolean;
	faultCode: FanoutAckClosedCode | null;
	queue: QueuedDelivery[];
	queueBytes: number;
	controlQueue: Uint8Array[];
	nextMeasuredSequence: number;
	nextWarmupSequence: number;
	measuredEndSeen: boolean;
	warmupEndSeen: boolean;
	relayEndSent: boolean;
}

function relayFail(
	code: string,
	message: string,
): { readonly ok: false; readonly code: string; readonly message: string } {
	return { ok: false, code, message };
}

function zeros(length: number): number[] {
	return new Array<number>(length).fill(0);
}

/** `subscriber-000042` -> 42; anything else is not a canonical role ID. */
function roleIdNumber(roleId: string): number | null {
	const dash = roleId.lastIndexOf("-");
	if (dash < 0) return null;
	const digits = roleId.slice(dash + 1);
	if (!/^[0-9]{6,}$/.test(digits)) return null;
	const parsed = Number(digits);
	return Number.isSafeInteger(parsed) ? parsed : null;
}

// ---------------------------------------------------------------------------
// The relay
// ---------------------------------------------------------------------------

export class FanoutRelay {
	readonly config: FanoutRelayConfig;
	readonly caps: FanoutRelayCaps;
	readonly codec: FanoutFrameCodec;

	private phaseValue: FanoutRelayPhase = "registration";
	private readonly sessions = new Map<string, RelaySession>();
	private readonly sessionsByRoleId = new Map<string, RelaySession>();
	private readonly spentTokenSha256 = new Set<string>();
	private readonly publisherById = new Map<string, PublisherRoleGrantV1>();
	private readonly shardByWorkerIndex = new Map<number, SubscriberShardV1>();
	private readonly faultList: FanoutRelayFaultV1[] = [];

	private nextSessionOrdinal = 0;
	private nextAcceptedOrdinal = 0;
	private nextWarmupOrdinal = 0;
	private measurementStartedAtNs: NsString | null = null;
	private drainedAtNs: NsString | null = null;
	private allSessionsClosedAtNs: NsString | null = null;

	private readonly accepted: number[];
	private readonly acceptedBytes: number[];
	private readonly writesCompleted: number[];
	private readonly writeBytes: number[];
	private readonly duplicates: number[];
	private readonly reordered: number[];
	private readonly queueDrops: number[];
	private readonly writeTimeouts: number[];
	private readonly disconnectUndelivered: number[];
	private readonly malformed: number[];

	private sessionsAccepted = 0;
	private sessionsActivePeak = 0;
	private publisherSessionsActivePeak = 0;
	private subscriberSessionsActivePeak = 0;
	private queueItemsPeak = 0;
	private queueBytesPeak = 0;
	private concurrentWritesPeak = 0;
	private queuedItems = 0;
	private queuedBytes = 0;
	private publisherEndCount = 0;
	private subscriberEndCount = 0;
	private subscriberDisconnects = 0;
	private postStopRelayWrites = 0;
	private warmupIngress = 0;
	private warmupDeliveries = 0;
	private warmupPublisherEndCount = 0;

	constructor(config: FanoutRelayConfig) {
		this.config = config;
		this.caps = { ...FANOUT_RELAY_DEFAULT_CAPS, ...(config.caps ?? {}) };
		this.codec = fanoutFrameCodecFor(config.transport);
		for (const publisher of config.publishers) {
			this.publisherById.set(publisher.publisherId, publisher);
		}
		for (const shard of config.subscriberShards) {
			this.shardByWorkerIndex.set(shard.workerIndex, shard);
		}
		const windows = config.windowCount;
		this.accepted = zeros(windows);
		this.acceptedBytes = zeros(windows);
		this.writesCompleted = zeros(windows);
		this.writeBytes = zeros(windows);
		this.duplicates = zeros(windows);
		this.reordered = zeros(windows);
		this.queueDrops = zeros(windows);
		this.writeTimeouts = zeros(windows);
		this.disconnectUndelivered = zeros(windows);
		this.malformed = zeros(windows);
	}

	get phase(): FanoutRelayPhase {
		return this.phaseValue;
	}

	// -- session lifecycle --------------------------------------------------

	openSession(sink: RelaySessionSink): string {
		const sessionId = `session-${this.nextSessionOrdinal.toString().padStart(6, "0")}`;
		this.nextSessionOrdinal += 1;
		this.sessions.set(sessionId, {
			sessionId,
			sink,
			role: null,
			roleId: null,
			workerIndex: null,
			registered: false,
			closed: false,
			faultCode: null,
			queue: [],
			queueBytes: 0,
			controlQueue: [],
			nextMeasuredSequence: 0,
			nextWarmupSequence: 0,
			measuredEndSeen: false,
			warmupEndSeen: false,
			relayEndSent: false,
		});
		return sessionId;
	}

	/**
	 * A session that disappears while deliveries are still queued for it makes
	 * those deliveries permanently undelivered; they are charged to their own
	 * origin window, never to the window the disconnect happened in.
	 */
	closeSession(sessionId: string, reason: string): void {
		const session = this.sessions.get(sessionId);
		if (session === undefined || session.closed) return;
		session.closed = true;
		for (const item of session.queue) {
			this.disconnectUndelivered[item.originWindowIndex] =
				(this.disconnectUndelivered[item.originWindowIndex] ?? 0) + 1;
			this.queuedItems -= 1;
			this.queuedBytes -= item.bytes.byteLength;
		}
		if (session.queue.length > 0) {
			this.recordFault(
				"disconnect-undelivered",
				RELAY_DELIVERY_FAILURE_CODE,
				`${session.roleId ?? sessionId} closed with ${session.queue.length} queued deliveries`,
			);
		}
		session.queue = [];
		session.queueBytes = 0;
		session.controlQueue = [];
		if (session.role === "subscriber" && session.registered) {
			this.subscriberDisconnects += 1;
		}
		session.sink.close(reason);
	}

	// -- inbound ------------------------------------------------------------

	handleInboundBytes(
		sessionId: string,
		bytes: Uint8Array,
	): ProtocolResult<true> {
		const decoded = this.codec.decode(bytes);
		if (!decoded.ok) {
			this.recordMalformed(`frame decode: ${decoded.message ?? decoded.code}`);
			return decoded;
		}
		return this.handleInbound(sessionId, decoded.value);
	}

	handleInbound(sessionId: string, frame: unknown): ProtocolResult<true> {
		const session = this.sessions.get(sessionId);
		if (session === undefined || session.closed) {
			return relayFail(
				COHORT_PROTOCOL_FAILURE_CODE,
				"unknown or closed session",
			);
		}
		const parsed = parseFanoutWire(frame);
		if (!parsed.ok) {
			this.recordMalformed(`frame parse: ${parsed.message ?? parsed.code}`);
			return parsed;
		}
		switch (parsed.value.kind) {
			case "register":
				return this.handleRegister(session, parsed.value);
			case "warmup-data":
				return this.handleWarmupData(session, parsed.value);
			case "warmup-end":
				return this.handleWarmupEnd(session, parsed.value);
			case "data":
				return this.handleData(session, parsed.value);
			case "end":
				return this.handleEnd(session, parsed.value);
			default:
				// accept / refuse / ack / warmup-ack are relay-authored; a role that
				// sends one back is speaking the wrong direction of the protocol.
				this.recordMalformed(
					`role sent relay-authored kind ${parsed.value.kind}`,
				);
				return relayFail(
					COHORT_PROTOCOL_FAILURE_CODE,
					`relay-authored kind ${parsed.value.kind} received from a role`,
				);
		}
	}

	// -- registration -------------------------------------------------------

	private handleRegister(
		session: RelaySession,
		frame: FanoutRegisterV1,
	): ProtocolResult<true> {
		const refusal = this.registrationRefusal(session, frame);
		if (refusal !== null) {
			this.sendRefuse(session, frame.role, frame.roleId, refusal);
			this.closeSession(session.sessionId, `register refused ${refusal}`);
			return relayFail(
				COHORT_PROTOCOL_FAILURE_CODE,
				`registration refused ${refusal}`,
			);
		}
		this.spentTokenSha256.add(frame.tokenSha256);
		session.role = frame.role;
		session.roleId = frame.roleId;
		session.workerIndex = frame.workerIndex;
		session.registered = true;
		this.sessionsByRoleId.set(frame.roleId, session);
		this.sessionsAccepted += 1;
		this.updateSessionPeaks();
		const accept: FanoutWireV1 = {
			schema: "fanout-wire/v1",
			kind: "accept",
			cohortGrantSha256: this.config.cohortGrantSha256,
			role: frame.role,
			roleId: frame.roleId,
			linuxSessionOrdinal: this.sessionsAccepted - 1,
			linuxAcceptedAtNs: this.config.clock.nowNs(),
			linuxClockId: this.config.linuxClockId,
		};
		this.sendFrame(session, accept);
		return { ok: true, value: true };
	}

	/**
	 * Registration is admitted only when the raw token opens the signed
	 * commitment, the token has never been spent, and the role/shard fields the
	 * frame claims are exactly the ones the grant issued for that role ID.
	 */
	private registrationRefusal(
		session: RelaySession,
		frame: FanoutRegisterV1,
	): FanoutRefuseCode | null {
		if (this.phaseValue !== "registration") return "REGISTRATION_CLOSED";
		if (session.registered) return "DUPLICATE_ROLE";
		if (frame.cohortGrantSha256 !== this.config.cohortGrantSha256) {
			return "WRONG_COHORT";
		}
		if (frame.transport !== this.config.transport) return "WRONG_COHORT";
		const existing = this.sessionsByRoleId.get(frame.roleId);
		if (existing !== undefined && !existing.closed) return "DUPLICATE_ROLE";
		if (this.spentTokenSha256.has(frame.tokenSha256)) return "TOKEN_REPLAY";

		const roleIndex = roleIdNumber(frame.roleId);
		if (roleIndex === null) return "UNKNOWN_TOKEN";
		let childId: string;
		if (frame.role === "publisher") {
			const grant = this.publisherById.get(frame.roleId);
			if (grant === undefined) return "WRONG_ROLE";
			if (grant.tokenCommitmentIndex !== frame.tokenCommitmentIndex) {
				return "WRONG_ROLE";
			}
			if (grant.tokenSha256 !== frame.tokenSha256) return "UNKNOWN_TOKEN";
			childId = grant.childId;
		} else {
			if (frame.workerIndex === null) return "WRONG_SHARD";
			if (!this.config.expectedSubscriberIds.includes(frame.roleId)) {
				return "WRONG_ROLE";
			}
			const shard = this.shardByWorkerIndex.get(frame.workerIndex);
			if (shard === undefined) return "WRONG_SHARD";
			if (roleIndex % SUBSCRIBER_SHARD_MODULUS !== shard.residue) {
				return "WRONG_SHARD";
			}
			if (
				frame.tokenCommitmentIndex < shard.firstTokenCommitmentIndex ||
				frame.tokenCommitmentIndex >= shard.lastTokenCommitmentIndexExclusive
			) {
				return "WRONG_SHARD";
			}
			childId = shard.childId;
		}
		if (frame.childId !== childId) return "WRONG_SHARD";

		// The leaf is rebuilt from the frame's own claimed identity, so a proof
		// that opens the root for some other role cannot be replayed here.
		const leaf: TokenCommitmentLeafV1 = {
			schema: "token-commitment-leaf/v1",
			childId,
			cohortId: this.config.cohortId,
			role: frame.role,
			roleId: frame.roleId,
			tokenSha256: frame.tokenSha256,
			workerIndex: frame.workerIndex,
		};
		const proof = verifyTokenMerkleProof({
			leafSha256: tokenCommitmentLeafSha256(leaf),
			tokenCommitmentIndex: frame.tokenCommitmentIndex,
			leafCount: this.config.roleTokenCommitmentCount,
			proof: frame.tokenMerkleProofSha256,
			rootSha256: this.config.roleTokenCommitmentRootSha256,
		});
		if (!proof.ok) return "UNKNOWN_TOKEN";
		return null;
	}

	/** Registration closes exactly once, before the warmup epoch opens. */
	closeRegistration(): ProtocolResult<true> {
		if (this.phaseValue !== "registration") {
			return relayFail(
				COHORT_PROTOCOL_FAILURE_CODE,
				`cannot close registration from ${this.phaseValue}`,
			);
		}
		const missing =
			this.config.expectedSubscriberIds.length -
			this.registeredSubscribers().length;
		if (missing > 0) {
			this.recordFault(
				"partial-connect",
				RELAY_DELIVERY_FAILURE_CODE,
				`${missing} subscriber registrations missing at registration close`,
			);
		}
		this.phaseValue = "warmup";
		return { ok: true, value: true };
	}

	// -- warmup -------------------------------------------------------------

	private handleWarmupData(
		session: RelaySession,
		frame: FanoutWarmupDataV1,
	): ProtocolResult<true> {
		if (this.phaseValue !== "warmup") {
			this.recordFault(
				"warmup-protocol",
				WARMUP_PROTOCOL_FAILURE_CODE,
				`warmup data in phase ${this.phaseValue}`,
			);
			return relayFail(
				WARMUP_PROTOCOL_FAILURE_CODE,
				`warmup data in phase ${this.phaseValue}`,
			);
		}
		const binding = requireWarmupFrameBinding(frame, {
			cohortGrantSha256: this.config.cohortGrantSha256,
			cohortWarmupEpochSha256: this.config.cohortWarmupEpochSha256,
			warmupNonce: this.config.warmupNonce,
		});
		if (!binding.ok) {
			this.recordFault(
				"warmup-protocol",
				WARMUP_PROTOCOL_FAILURE_CODE,
				binding.message ?? binding.code,
			);
			return binding;
		}
		const publisher = this.requirePublisherSession(session, frame.publisherId);
		if (!publisher.ok) return publisher;
		if (frame.publisherSequence !== session.nextWarmupSequence) {
			this.recordFault(
				"warmup-protocol",
				WARMUP_PROTOCOL_FAILURE_CODE,
				`warmup sequence ${frame.publisherSequence} is not the expected ${session.nextWarmupSequence}`,
			);
			return relayFail(WARMUP_PROTOCOL_FAILURE_CODE, "warmup sequence");
		}
		session.nextWarmupSequence += 1;
		const ordinal = this.nextWarmupOrdinal;
		this.nextWarmupOrdinal += 1;
		this.warmupIngress += 1;
		this.sendFrame(session, {
			schema: "fanout-wire/v1",
			kind: "warmup-ack",
			cohortGrantSha256: this.config.cohortGrantSha256,
			cohortWarmupEpochSha256: this.config.cohortWarmupEpochSha256,
			warmupNonce: this.config.warmupNonce,
			publisherId: frame.publisherId,
			publisherSequence: frame.publisherSequence,
			disposition: "accepted",
			linuxAcceptedOrdinal: ordinal,
			linuxAcceptedAtNs: this.config.clock.nowNs(),
		});
		for (const subscriber of this.registeredSubscribers()) {
			const roleId = subscriber.roleId as string;
			const fanned: FanoutWireV1 = {
				schema: "fanout-wire/v1",
				kind: "warmup-data",
				direction: "relay-to-subscriber",
				cohortGrantSha256: this.config.cohortGrantSha256,
				cohortWarmupEpochSha256: this.config.cohortWarmupEpochSha256,
				warmupNonce: this.config.warmupNonce,
				publisherId: frame.publisherId,
				publisherSequence: frame.publisherSequence,
				subscriberId: roleId,
				linuxAcceptedOrdinal: ordinal,
				payloadBase64: frame.payloadBase64,
				payloadSha256: frame.payloadSha256,
				payloadBytes: frame.payloadBytes,
			};
			const enqueued = this.enqueue(subscriber, fanned, 0, ordinal, true);
			if (enqueued) this.warmupDeliveries += 1;
		}
		this.pump();
		return { ok: true, value: true };
	}

	private handleWarmupEnd(
		session: RelaySession,
		frame: FanoutWarmupEndV1,
	): ProtocolResult<true> {
		if (
			frame.reason !== "publisher-warmup-complete" ||
			frame.role !== "publisher"
		) {
			this.recordFault(
				"warmup-protocol",
				WARMUP_PROTOCOL_FAILURE_CODE,
				"only a publisher may author a warmup end marker",
			);
			return relayFail(WARMUP_PROTOCOL_FAILURE_CODE, "warmup end authorship");
		}
		const publisher = this.requirePublisherSession(session, frame.roleId);
		if (!publisher.ok) return publisher;
		if (session.warmupEndSeen) {
			this.recordFault(
				"duplicate-end-marker",
				WARMUP_PROTOCOL_FAILURE_CODE,
				`${frame.roleId} sent a second warmup end marker`,
			);
			return relayFail(WARMUP_PROTOCOL_FAILURE_CODE, "duplicate warmup end");
		}
		session.warmupEndSeen = true;
		this.warmupPublisherEndCount += 1;
		return { ok: true, value: true };
	}

	/**
	 * The drain is the only path from warmup to measured. It requires every
	 * publisher's end marker, empty queues, and the nonzero expanded warmup
	 * equation; it then zeroes every measured counter and ordinal so a warmup
	 * record can never be counted as measured traffic (§4.1).
	 */
	drainWarmup(): ProtocolResult<FanoutWarmupDrainSummaryV1> {
		if (this.phaseValue !== "warmup") {
			return relayFail(
				WARMUP_PROTOCOL_FAILURE_CODE,
				`cannot drain warmup from ${this.phaseValue}`,
			);
		}
		this.pump();
		const publishers = this.registeredPublishers();
		const subscribers = this.registeredSubscribers();
		if (this.warmupPublisherEndCount !== publishers.length) {
			return relayFail(
				WARMUP_PROTOCOL_FAILURE_CODE,
				`warmup end markers ${this.warmupPublisherEndCount} != publishers ${publishers.length}`,
			);
		}
		if (this.queuedItems !== 0) {
			return relayFail(
				WARMUP_PROTOCOL_FAILURE_CODE,
				`warmup queues hold ${this.queuedItems} undelivered records`,
			);
		}
		if (this.warmupIngress === 0 || this.warmupDeliveries === 0) {
			return relayFail(WARMUP_PROTOCOL_FAILURE_CODE, "warmup was vacuous");
		}
		if (this.warmupDeliveries !== this.warmupIngress * subscribers.length) {
			return relayFail(
				WARMUP_PROTOCOL_FAILURE_CODE,
				`warmup deliveries ${this.warmupDeliveries} != ingress ${this.warmupIngress} * subscribers ${subscribers.length}`,
			);
		}
		for (const subscriber of subscribers) {
			this.sendFrame(subscriber, {
				schema: "fanout-wire/v1",
				kind: "warmup-end",
				cohortGrantSha256: this.config.cohortGrantSha256,
				cohortWarmupEpochSha256: this.config.cohortWarmupEpochSha256,
				warmupNonce: this.config.warmupNonce,
				role: "subscriber",
				roleId: subscriber.roleId as string,
				finalPublisherSequence: null,
				reason: "relay-warmup-drained",
			});
		}
		this.resetMeasuredState();
		this.phaseValue = "warmup-drained";
		return {
			ok: true,
			value: {
				warmupIngress: this.warmupIngress,
				warmupDeliveries: this.warmupDeliveries,
				warmupQueuesEmpty: true,
				measuredCountersReset: true,
				drainedAtLinuxNs: this.config.clock.nowNs(),
			},
		};
	}

	private resetMeasuredState(): void {
		this.nextAcceptedOrdinal = 0;
		for (let index = 0; index < this.config.windowCount; index += 1) {
			this.accepted[index] = 0;
			this.acceptedBytes[index] = 0;
			this.writesCompleted[index] = 0;
			this.writeBytes[index] = 0;
			this.duplicates[index] = 0;
			this.reordered[index] = 0;
			this.queueDrops[index] = 0;
			this.writeTimeouts[index] = 0;
			this.disconnectUndelivered[index] = 0;
			this.malformed[index] = 0;
		}
		this.publisherEndCount = 0;
		this.subscriberEndCount = 0;
		this.postStopRelayWrites = 0;
		this.queueItemsPeak = 0;
		this.queueBytesPeak = 0;
		this.concurrentWritesPeak = 0;
		for (const session of this.sessions.values()) {
			session.nextMeasuredSequence = 0;
			session.measuredEndSeen = false;
		}
	}

	// -- measured barrier ---------------------------------------------------

	/**
	 * Measured traffic is legal only after the rig has accepted the exact start
	 * barrier this relay was configured with. An acceptance naming another grant
	 * or another barrier leaves the relay in `warmup-drained`.
	 */
	acceptLinuxBarrier(acceptance: RigBarrierAcceptanceV1): ProtocolResult<true> {
		if (this.phaseValue !== "warmup-drained") {
			return relayFail(
				COHORT_NOT_READY_FAILURE_CODE,
				`barrier acceptance in phase ${this.phaseValue}`,
			);
		}
		const parsed = parseRigBarrierAcceptance(acceptance);
		if (!parsed.ok) return parsed;
		if (parsed.value.cohortGrantSha256 !== this.config.cohortGrantSha256) {
			return relayFail(
				COHORT_PROTOCOL_FAILURE_CODE,
				"barrier acceptance names another cohort grant",
			);
		}
		if (
			parsed.value.cohortStartBarrierSha256 !==
			this.config.cohortStartBarrierSha256
		) {
			return relayFail(
				COHORT_PROTOCOL_FAILURE_CODE,
				"barrier acceptance names another start barrier",
			);
		}
		this.phaseValue = "measured";
		this.measurementStartedAtNs = this.config.clock.nowNs();
		return { ok: true, value: true };
	}

	// -- measured data ------------------------------------------------------

	private handleData(
		session: RelaySession,
		frame: FanoutDataV1,
	): ProtocolResult<true> {
		if (this.phaseValue !== "measured") {
			// Pre-barrier measured traffic is never counted as ingress; it is
			// malformed for its own origin window and closes the ack.
			this.recordMalformedAt(
				frame.windowIndex,
				`measured data in phase ${this.phaseValue}`,
			);
			this.sendClosedAck(session, frame, "MEASUREMENT_WINDOW_CLOSED");
			return relayFail(
				COHORT_NOT_READY_FAILURE_CODE,
				`measured data before Linux barrier acceptance (phase ${this.phaseValue})`,
			);
		}
		const binding = requireMeasuredFrameBinding(frame, {
			cohortGrantSha256: this.config.cohortGrantSha256,
			cohortStartBarrierSha256: this.config.cohortStartBarrierSha256,
		});
		if (!binding.ok) {
			this.recordMalformedAt(
				frame.windowIndex,
				binding.message ?? binding.code,
			);
			return binding;
		}
		if (frame.windowIndex >= this.config.windowCount) {
			this.recordMalformed(`window ${frame.windowIndex} outside the cell`);
			return relayFail(
				COHORT_PROTOCOL_FAILURE_CODE,
				"origin window out of range",
			);
		}
		if (frame.payloadBytes !== this.config.messageBytes) {
			this.recordMalformedAt(
				frame.windowIndex,
				"payload size is not the cell size",
			);
			return relayFail(COHORT_PROTOCOL_FAILURE_CODE, "payload size");
		}
		const publisher = this.requirePublisherSession(session, frame.publisherId);
		if (!publisher.ok) return publisher;

		const window = frame.windowIndex;
		if (frame.publisherSequence < session.nextMeasuredSequence) {
			this.duplicates[window] = (this.duplicates[window] ?? 0) + 1;
			this.recordFault(
				"duplicate-ingress",
				RELAY_DELIVERY_FAILURE_CODE,
				`${frame.publisherId} resent sequence ${frame.publisherSequence}`,
			);
			this.sendAck(session, frame, {
				disposition: "duplicate",
				code: "DUPLICATE_PUBLISHER_SEQUENCE",
			});
			return relayFail(
				RELAY_DELIVERY_FAILURE_CODE,
				"duplicate publisher sequence",
			);
		}
		if (frame.publisherSequence > session.nextMeasuredSequence) {
			this.reordered[window] = (this.reordered[window] ?? 0) + 1;
			this.recordFault(
				"reordered-ingress",
				RELAY_DELIVERY_FAILURE_CODE,
				`${frame.publisherId} skipped to sequence ${frame.publisherSequence}`,
			);
			this.sendAck(session, frame, {
				disposition: "reordered",
				code: "REORDERED_PUBLISHER_SEQUENCE",
			});
			return relayFail(
				RELAY_DELIVERY_FAILURE_CODE,
				"reordered publisher sequence",
			);
		}

		// A subscriber that has already been closed for a delivery fault can no
		// longer receive the required expansion, so admission closes rather than
		// pretending the fanout is still possible.
		const blocked = this.firstBlockedSubscriberCode();
		if (blocked !== null) {
			this.sendClosedAck(session, frame, blocked);
			return relayFail(
				RELAY_DELIVERY_FAILURE_CODE,
				`admission closed ${blocked}`,
			);
		}

		const subscribers = this.registeredSubscribers();
		const expansion = subscribers.length;
		const frameBytesEstimate = this.estimateDeliveryBytes(frame);
		if (
			this.queuedItems + expansion > this.caps.globalQueueMaxItems ||
			this.queuedBytes + expansion * frameBytesEstimate >
				this.caps.globalQueueMaxBytes
		) {
			this.queueDrops[window] = (this.queueDrops[window] ?? 0) + expansion;
			this.recordFault(
				"global-queue-full",
				RELAY_DELIVERY_FAILURE_CODE,
				`global relay queue full at ${this.queuedItems} items / ${this.queuedBytes} bytes`,
			);
			this.sendClosedAck(session, frame, "RELAY_INGRESS_QUEUE_FULL");
			return relayFail(RELAY_DELIVERY_FAILURE_CODE, "relay ingress queue full");
		}

		session.nextMeasuredSequence += 1;
		const ordinal = this.nextAcceptedOrdinal;
		this.nextAcceptedOrdinal += 1;
		this.accepted[window] = (this.accepted[window] ?? 0) + 1;
		this.acceptedBytes[window] =
			(this.acceptedBytes[window] ?? 0) + this.config.messageBytes;
		this.sendAck(session, frame, {
			disposition: "accepted",
			ordinal,
		});
		for (const subscriber of subscribers) {
			const fanned: FanoutWireV1 = {
				schema: "fanout-wire/v1",
				kind: "data",
				direction: "relay-to-subscriber",
				cohortGrantSha256: this.config.cohortGrantSha256,
				cohortStartBarrierSha256: this.config.cohortStartBarrierSha256,
				windowIndex: window,
				publisherId: frame.publisherId,
				publisherSequence: frame.publisherSequence,
				subscriberId: subscriber.roleId as string,
				linuxAcceptedOrdinal: ordinal,
				payloadBase64: frame.payloadBase64,
				payloadSha256: frame.payloadSha256,
				payloadBytes: frame.payloadBytes,
			};
			this.enqueue(subscriber, fanned, window, ordinal, false);
		}
		this.pump();
		return { ok: true, value: true };
	}

	private handleEnd(
		session: RelaySession,
		frame: FanoutEndV1,
	): ProtocolResult<true> {
		if (frame.reason !== "publisher-complete" || frame.role !== "publisher") {
			this.recordMalformed("only a publisher may author a measured end marker");
			return relayFail(RELAY_DELIVERY_FAILURE_CODE, "end marker authorship");
		}
		const publisher = this.requirePublisherSession(session, frame.roleId);
		if (!publisher.ok) return publisher;
		if (session.measuredEndSeen) {
			this.recordFault(
				"duplicate-end-marker",
				RELAY_DELIVERY_FAILURE_CODE,
				`${frame.roleId} sent a second end marker`,
			);
			return relayFail(RELAY_DELIVERY_FAILURE_CODE, "duplicate publisher end");
		}
		session.measuredEndSeen = true;
		this.publisherEndCount += 1;
		return { ok: true, value: true };
	}

	// -- bounded delivery ---------------------------------------------------

	private enqueue(
		subscriber: RelaySession,
		frame: FanoutWireV1,
		originWindowIndex: number,
		linuxAcceptedOrdinal: number,
		warmup: boolean,
	): boolean {
		const encoded = this.codec.encode(frame);
		if (!encoded.ok) {
			this.recordMalformedAt(originWindowIndex, "relay frame failed to encode");
			return false;
		}
		const bytes = encoded.value;
		const overItems =
			subscriber.queue.length + 1 > this.caps.subscriberQueueMaxItems;
		const overBytes =
			subscriber.queueBytes + bytes.byteLength >
			this.caps.subscriberQueueMaxBytes;
		if (overItems || overBytes) {
			this.queueDrops[originWindowIndex] =
				(this.queueDrops[originWindowIndex] ?? 0) + 1;
			this.recordFault(
				"subscriber-queue-full",
				warmup ? WARMUP_PROTOCOL_FAILURE_CODE : RELAY_DELIVERY_FAILURE_CODE,
				`${subscriber.roleId} queue full at ${subscriber.queue.length} items / ${subscriber.queueBytes} bytes`,
			);
			subscriber.faultCode = "SUBSCRIBER_QUEUE_FULL";
			this.closeSession(subscriber.sessionId, "subscriber queue full");
			return false;
		}
		subscriber.queue.push({
			bytes,
			originWindowIndex,
			linuxAcceptedOrdinal,
			enqueuedAtMs: this.config.clock.nowMs(),
			warmup,
		});
		subscriber.queueBytes += bytes.byteLength;
		this.queuedItems += 1;
		this.queuedBytes += bytes.byteLength;
		if (this.queuedItems > this.queueItemsPeak)
			this.queueItemsPeak = this.queuedItems;
		if (this.queuedBytes > this.queueBytesPeak)
			this.queueBytesPeak = this.queuedBytes;
		return true;
	}

	/**
	 * One bounded delivery round: at most `maxConcurrentWrites` subscribers are
	 * serviced, in subscriber-ID order, and each stops at the first item the
	 * transport will not take. The head item's age is the write deadline, so a
	 * congested subscriber fails at a bounded time rather than accumulating.
	 */
	pump(): void {
		const nowMs = this.config.clock.nowMs();
		for (const session of this.activeSessions()) this.drainControl(session);
		let serviced = 0;
		for (const subscriber of this.registeredSubscribers()) {
			if (serviced >= this.caps.maxConcurrentWrites) break;
			if (subscriber.controlQueue.length > 0) continue;
			if (subscriber.queue.length === 0) continue;
			serviced += 1;
			while (subscriber.queue.length > 0 && !subscriber.closed) {
				const item = subscriber.queue[0] as QueuedDelivery;
				if (nowMs - item.enqueuedAtMs > this.caps.writeDeadlineMs) {
					this.dropHead(subscriber);
					this.writeTimeouts[item.originWindowIndex] =
						(this.writeTimeouts[item.originWindowIndex] ?? 0) + 1;
					this.recordFault(
						"write-timeout",
						RELAY_DELIVERY_FAILURE_CODE,
						`${subscriber.roleId} write exceeded ${this.caps.writeDeadlineMs} ms`,
					);
					subscriber.faultCode = "RELAY_WRITE_TIMEOUT";
					this.closeSession(subscriber.sessionId, "relay write timeout");
					break;
				}
				const outcome = subscriber.sink.trySend(item.bytes);
				if (outcome === "would-block") break;
				if (outcome === "closed") {
					subscriber.faultCode = "SUBSCRIBER_DISCONNECTED";
					this.closeSession(subscriber.sessionId, "subscriber disconnected");
					break;
				}
				this.dropHead(subscriber);
				if (!item.warmup) {
					this.writesCompleted[item.originWindowIndex] =
						(this.writesCompleted[item.originWindowIndex] ?? 0) + 1;
					this.writeBytes[item.originWindowIndex] =
						(this.writeBytes[item.originWindowIndex] ?? 0) +
						this.config.messageBytes;
					if (this.phaseValue === "draining") this.postStopRelayWrites += 1;
				}
			}
		}
		if (serviced > this.concurrentWritesPeak)
			this.concurrentWritesPeak = serviced;
	}

	private dropHead(subscriber: RelaySession): void {
		const item = subscriber.queue.shift();
		if (item === undefined) return;
		subscriber.queueBytes -= item.bytes.byteLength;
		this.queuedItems -= 1;
		this.queuedBytes -= item.bytes.byteLength;
	}

	// -- stop and shutdown --------------------------------------------------

	stopMeasurement(): ProtocolResult<true> {
		if (this.phaseValue !== "measured") {
			return relayFail(
				COHORT_PROTOCOL_FAILURE_CODE,
				`cannot stop measurement from ${this.phaseValue}`,
			);
		}
		this.phaseValue = "draining";
		const missingEnds = this.registeredPublishers().filter(
			(publisher) => !publisher.measuredEndSeen,
		);
		for (const publisher of missingEnds) {
			this.recordFault(
				"missing-end-marker",
				RELAY_DELIVERY_FAILURE_CODE,
				`${publisher.roleId} produced no end marker`,
			);
		}
		return { ok: true, value: true };
	}

	/**
	 * Bounded shutdown: pump until the queues are empty or the drain deadline
	 * passes, send each subscriber exactly one relay-drained end marker, close
	 * every session, and reap all per-session state. Calling it twice is a
	 * no-op that returns the same summary shape.
	 */
	shutdown(): ProtocolResult<FanoutRelayShutdownSummaryV1> {
		if (this.phaseValue === "closed") {
			return {
				ok: true,
				value: {
					allSessionsClosed: true,
					drainedAtLinuxNs: this.drainedAtNs ?? this.config.clock.nowNs(),
					drainDurationMs: 0,
					subscriberEndCount: this.subscriberEndCount,
					reapedSessionCount: 0,
					queuedItemsAtClose: 0,
				},
			};
		}
		if (this.phaseValue === "measured") this.stopMeasurement();
		const startedAtMs = this.config.clock.nowMs();
		let rounds = 0;
		while (this.queuedItems > 0) {
			// The budget is checked before the round, so a relay with no drain
			// budget left and records still queued refuses instead of pumping.
			const elapsed = this.config.clock.nowMs() - startedAtMs;
			if (elapsed >= this.caps.drainDeadlineMs) {
				return relayFail(
					RELAY_DELIVERY_FAILURE_CODE,
					`relay did not drain within ${this.caps.drainDeadlineMs} ms; ${this.queuedItems} deliveries remain`,
				);
			}
			const before = this.queuedItems;
			this.pump();
			rounds += 1;
			// A pump that moves nothing under a frozen clock will never move
			// anything: refuse rather than spin to the deadline.
			if (this.queuedItems === before && rounds > 1) {
				return relayFail(
					RELAY_DELIVERY_FAILURE_CODE,
					`relay drain stalled with ${this.queuedItems} deliveries queued`,
				);
			}
		}
		for (const subscriber of this.registeredSubscribers()) {
			if (subscriber.relayEndSent) continue;
			subscriber.relayEndSent = true;
			this.subscriberEndCount += 1;
			this.sendFrame(subscriber, {
				schema: "fanout-wire/v1",
				kind: "end",
				cohortGrantSha256: this.config.cohortGrantSha256,
				cohortStartBarrierSha256: this.config.cohortStartBarrierSha256,
				role: "subscriber",
				roleId: subscriber.roleId as string,
				finalWindowIndex: this.config.windowCount - 1,
				finalPublisherSequence: null,
				reason: "relay-drained",
			});
		}
		this.pump();
		const reapedSessionCount = this.sessions.size;
		for (const sessionId of [...this.sessions.keys()]) {
			this.closeSession(sessionId, "relay shutdown");
		}
		this.sessions.clear();
		this.sessionsByRoleId.clear();
		this.phaseValue = "closed";
		this.drainedAtNs = this.config.clock.nowNs();
		this.allSessionsClosedAtNs = this.drainedAtNs;
		return {
			ok: true,
			value: {
				allSessionsClosed: true,
				drainedAtLinuxNs: this.drainedAtNs,
				drainDurationMs: this.config.clock.nowMs() - startedAtMs,
				subscriberEndCount: this.subscriberEndCount,
				reapedSessionCount,
				queuedItemsAtClose: 0,
			},
		};
	}

	// -- observation --------------------------------------------------------

	counters(): FanoutRelayCountersV1 {
		return {
			windowCount: this.config.windowCount,
			acceptedIngressByOriginWindow: [...this.accepted],
			acceptedIngressBytesByOriginWindow: [...this.acceptedBytes],
			relayWritesCompletedByOriginWindow: [...this.writesCompleted],
			relayWriteBytesByOriginWindow: [...this.writeBytes],
			duplicateIngressByOriginWindow: [...this.duplicates],
			reorderedIngressByOriginWindow: [...this.reordered],
			queueDropDeliveriesByOriginWindow: [...this.queueDrops],
			writeTimeoutDeliveriesByOriginWindow: [...this.writeTimeouts],
			disconnectUndeliveredByOriginWindow: [...this.disconnectUndelivered],
			malformedIngressByOriginWindow: [...this.malformed],
			registeredPublisherIds: this.registeredPublisherIds(),
			registeredSubscriberIds: this.registeredSubscriberIds(),
			publisherEndCount: this.publisherEndCount,
			subscriberEndCount: this.subscriberEndCount,
			sessionsAccepted: this.sessionsAccepted,
			sessionsActivePeak: this.sessionsActivePeak,
			publisherSessionsActivePeak: this.publisherSessionsActivePeak,
			subscriberSessionsActivePeak: this.subscriberSessionsActivePeak,
			queueItemsPeak: this.queueItemsPeak,
			queueBytesPeak: this.queueBytesPeak,
			concurrentWritesPeak: this.concurrentWritesPeak,
			queuedItems: this.queuedItems,
			queuedBytes: this.queuedBytes,
			missingSubscriberRegistrations:
				this.config.expectedSubscriberIds.length -
				this.registeredSubscriberIds().length,
			subscriberDisconnects: this.subscriberDisconnects,
			postStopRelayWrites: this.postStopRelayWrites,
			warmupIngress: this.warmupIngress,
			warmupDeliveries: this.warmupDeliveries,
			warmupPublisherEndCount: this.warmupPublisherEndCount,
		};
	}

	promotionFaults(): readonly FanoutRelayFaultV1[] {
		return [...this.faultList];
	}

	isPromotable(): boolean {
		return this.faultList.length === 0;
	}

	/**
	 * Project the engine's counters into the B1 `LinuxRelayObservationV1`
	 * record. The parser is the authority on the shape, so the projection is
	 * validated rather than asserted.
	 */
	buildLinuxRelayObservation(identity: {
		readonly executionSha256: Sha256Hex;
		readonly serverChildPid: number;
		readonly serverChildPgid: number;
		readonly serverChildInstanceNonce: Sha256Hex;
	}): ProtocolResult<LinuxRelayObservationV1> {
		if (this.allSessionsClosedAtNs === null || this.drainedAtNs === null) {
			return relayFail(
				COHORT_NOT_READY_FAILURE_CODE,
				"relay observation requires a completed shutdown",
			);
		}
		const subscriberIds = this.registeredSubscriberIds();
		const candidate = {
			schema: "linux-relay-observation/v1",
			executionSha256: identity.executionSha256,
			cohortGrantSha256: this.config.cohortGrantSha256,
			cohortStartBarrierSha256: this.config.cohortStartBarrierSha256,
			roleTokenCommitmentRootSha256: this.config.roleTokenCommitmentRootSha256,
			serverChildPid: identity.serverChildPid,
			serverChildPgid: identity.serverChildPgid,
			serverChildInstanceNonce: identity.serverChildInstanceNonce,
			linuxClockId: this.config.linuxClockId,
			windowCount: this.config.windowCount,
			registeredPublisherIds: this.registeredPublisherIds(),
			registeredSubscriberIdsSha256: sha256HexOfBytes(
				bytesOfCanonical(subscriberIds),
			),
			registeredPublisherCount: this.registeredPublisherIds().length,
			registeredSubscriberCount: subscriberIds.length,
			acceptedIngressByOriginWindow: [...this.accepted],
			acceptedIngressBytesByOriginWindow: [...this.acceptedBytes],
			relayWritesCompletedByOriginWindow: [...this.writesCompleted],
			relayWriteBytesByOriginWindow: [...this.writeBytes],
			duplicateIngressByOriginWindow: [...this.duplicates],
			reorderedIngressByOriginWindow: [...this.reordered],
			queueDropDeliveriesByOriginWindow: [...this.queueDrops],
			writeTimeoutDeliveriesByOriginWindow: [...this.writeTimeouts],
			disconnectUndeliveredByOriginWindow: [...this.disconnectUndelivered],
			malformedIngressByOriginWindow: [...this.malformed],
			publisherEndCount: this.publisherEndCount,
			subscriberEndCount: this.subscriberEndCount,
			sessionsAccepted: this.sessionsAccepted,
			sessionsActivePeak: this.sessionsActivePeak,
			publisherSessionsActivePeak: this.publisherSessionsActivePeak,
			subscriberSessionsActivePeak: this.subscriberSessionsActivePeak,
			queueItemsPeak: this.queueItemsPeak,
			queueBytesPeak: this.queueBytesPeak,
			concurrentWritesPeak: this.concurrentWritesPeak,
			measurementStartedAtLinuxNs:
				this.measurementStartedAtNs ?? ("0" as NsString),
			relayDrainedAtLinuxNs: this.drainedAtNs,
			allSessionsClosedAtLinuxNs: this.allSessionsClosedAtNs,
			allSessionsClosed: true,
		};
		return parseLinuxRelayObservation(candidate);
	}

	// -- helpers ------------------------------------------------------------

	private requirePublisherSession(
		session: RelaySession,
		publisherId: string,
	): ProtocolResult<true> {
		if (!session.registered || session.role !== "publisher") {
			this.recordMalformed(
				"data frame from an unregistered or non-publisher session",
			);
			return relayFail(
				COHORT_PROTOCOL_FAILURE_CODE,
				"data frame from an unregistered or non-publisher session",
			);
		}
		if (session.roleId !== publisherId) {
			this.recordMalformed(
				`session ${session.roleId} authored a frame for ${publisherId}`,
			);
			return relayFail(
				COHORT_PROTOCOL_FAILURE_CODE,
				"publisher identity does not match its session",
			);
		}
		return { ok: true, value: true };
	}

	private firstBlockedSubscriberCode(): FanoutAckClosedCode | null {
		for (const session of this.sessions.values()) {
			if (session.role !== "subscriber" || !session.registered) continue;
			if (session.closed && session.faultCode !== null)
				return session.faultCode;
			if (session.closed) return "SUBSCRIBER_DISCONNECTED";
		}
		return null;
	}

	private estimateDeliveryBytes(frame: FanoutDataV1): number {
		const probe: FanoutWireV1 = {
			...frame,
			direction: "relay-to-subscriber",
			subscriberId: "subscriber-999999",
			linuxAcceptedOrdinal: 0,
		};
		return bytesOfCanonical(probe).byteLength;
	}

	private activeSessions(): RelaySession[] {
		return [...this.sessions.values()].filter(
			(session) => session.registered && !session.closed,
		);
	}

	private registeredPublishers(): RelaySession[] {
		return this.activeSessions()
			.filter((session) => session.role === "publisher")
			.sort((left, right) =>
				(left.roleId as string).localeCompare(right.roleId as string),
			);
	}

	/** Fanout enqueue order is ingress order, then ascending subscriber ID. */
	private registeredSubscribers(): RelaySession[] {
		return this.activeSessions()
			.filter((session) => session.role === "subscriber")
			.sort((left, right) =>
				(left.roleId as string).localeCompare(right.roleId as string),
			);
	}

	private registeredPublisherIds(): string[] {
		return this.registeredPublishers().map(
			(session) => session.roleId as string,
		);
	}

	private registeredSubscriberIds(): string[] {
		return this.registeredSubscribers().map(
			(session) => session.roleId as string,
		);
	}

	private updateSessionPeaks(): void {
		const active = this.activeSessions();
		const publishers = active.filter(
			(session) => session.role === "publisher",
		).length;
		const subscribers = active.length - publishers;
		if (active.length > this.sessionsActivePeak)
			this.sessionsActivePeak = active.length;
		if (publishers > this.publisherSessionsActivePeak) {
			this.publisherSessionsActivePeak = publishers;
		}
		if (subscribers > this.subscriberSessionsActivePeak) {
			this.subscriberSessionsActivePeak = subscribers;
		}
	}

	private recordFault(
		kind: FanoutRelayFaultKind,
		code: string,
		detail: string,
	): void {
		this.faultList.push({ kind, code, detail });
	}

	private recordMalformed(detail: string): void {
		this.recordMalformedAt(0, detail);
	}

	private recordMalformedAt(window: number, detail: string): void {
		const index = window < this.config.windowCount ? window : 0;
		this.malformed[index] = (this.malformed[index] ?? 0) + 1;
		this.recordFault("malformed-ingress", RELAY_DELIVERY_FAILURE_CODE, detail);
	}

	private sendFrame(session: RelaySession, frame: FanoutWireV1): void {
		if (session.closed) return;
		const encoded = this.codec.encode(frame);
		if (!encoded.ok) {
			this.recordMalformed(`relay frame failed to encode: ${encoded.code}`);
			return;
		}
		// A control frame is never dropped. If the transport is congested it waits
		// in a small bounded backlog that the next pump drains ahead of data, so
		// an accept or an end marker cannot be lost to backpressure.
		if (session.controlQueue.length > 0) {
			this.backlogControl(session, encoded.value);
			return;
		}
		const outcome = session.sink.trySend(encoded.value);
		if (outcome === "closed") {
			this.closeSession(session.sessionId, "control write failed");
			return;
		}
		if (outcome === "would-block") this.backlogControl(session, encoded.value);
	}

	private backlogControl(session: RelaySession, bytes: Uint8Array): void {
		if (session.controlQueue.length >= this.caps.controlBacklogMaxItems) {
			this.recordFault(
				"control-backlog-full",
				RELAY_DELIVERY_FAILURE_CODE,
				`${session.roleId ?? session.sessionId} control backlog full at ${session.controlQueue.length}`,
			);
			session.faultCode = "SUBSCRIBER_DISCONNECTED";
			this.closeSession(session.sessionId, "control backlog full");
			return;
		}
		session.controlQueue.push(bytes);
	}

	/** Control frames drain before any data frame on the same session. */
	private drainControl(session: RelaySession): void {
		while (session.controlQueue.length > 0 && !session.closed) {
			const bytes = session.controlQueue[0] as Uint8Array;
			const outcome = session.sink.trySend(bytes);
			if (outcome === "would-block") return;
			if (outcome === "closed") {
				session.faultCode = "SUBSCRIBER_DISCONNECTED";
				this.closeSession(session.sessionId, "control write failed");
				return;
			}
			session.controlQueue.shift();
		}
	}

	private sendRefuse(
		session: RelaySession,
		role: "publisher" | "subscriber",
		roleId: string,
		code: FanoutRefuseCode,
	): void {
		this.sendFrame(session, {
			schema: "fanout-wire/v1",
			kind: "refuse",
			cohortGrantSha256: this.config.cohortGrantSha256,
			role,
			roleId,
			code,
		});
	}

	private sendAck(
		session: RelaySession,
		frame: FanoutDataV1,
		disposition:
			| { readonly disposition: "accepted"; readonly ordinal: number }
			| {
					readonly disposition: "duplicate" | "reordered";
					readonly code:
						| "DUPLICATE_PUBLISHER_SEQUENCE"
						| "REORDERED_PUBLISHER_SEQUENCE";
			  },
	): void {
		const common = {
			schema: "fanout-wire/v1",
			kind: "ack",
			cohortGrantSha256: this.config.cohortGrantSha256,
			cohortStartBarrierSha256: this.config.cohortStartBarrierSha256,
			windowIndex: frame.windowIndex,
			publisherId: frame.publisherId,
			publisherSequence: frame.publisherSequence,
		} as const;
		const ack: FanoutAckV1 =
			disposition.disposition === "accepted"
				? {
						...common,
						disposition: "accepted",
						linuxAcceptedOrdinal: disposition.ordinal,
						linuxAcceptedAtNs: this.config.clock.nowNs(),
						code: null,
					}
				: ({
						...common,
						disposition: disposition.disposition,
						linuxAcceptedOrdinal: null,
						linuxAcceptedAtNs: null,
						code: disposition.code,
					} as FanoutAckV1);
		this.sendFrame(session, ack);
	}

	private sendClosedAck(
		session: RelaySession,
		frame: FanoutDataV1,
		code: FanoutAckClosedCode,
	): void {
		this.sendFrame(session, {
			schema: "fanout-wire/v1",
			kind: "ack",
			cohortGrantSha256: this.config.cohortGrantSha256,
			cohortStartBarrierSha256: this.config.cohortStartBarrierSha256,
			windowIndex: frame.windowIndex,
			publisherId: frame.publisherId,
			publisherSequence: frame.publisherSequence,
			disposition: "closed",
			linuxAcceptedOrdinal: null,
			linuxAcceptedAtNs: null,
			code,
		});
	}
}

// ---------------------------------------------------------------------------
// Cohort fixture: the deterministic role/token set a relay is configured from
// ---------------------------------------------------------------------------

export interface FanoutCohortFixture {
	readonly cohortId: string;
	readonly publishers: readonly PublisherRoleGrantV1[];
	readonly subscriberShards: readonly SubscriberShardV1[];
	readonly expectedSubscriberIds: readonly string[];
	readonly leaves: readonly TokenCommitmentLeafV1[];
	readonly leafSha256List: readonly Sha256Hex[];
	readonly roleTokenCommitmentRootSha256: Sha256Hex;
	readonly roleTokenCommitmentCount: number;
	readonly tokenBase64ByRoleId: ReadonlyMap<string, Base64>;
	readonly tokenSha256ByRoleId: ReadonlyMap<string, Sha256Hex>;
	readonly commitmentIndexByRoleId: ReadonlyMap<string, number>;
	readonly proofByRoleId: ReadonlyMap<string, readonly Sha256Hex[]>;
	readonly childIdByRoleId: ReadonlyMap<string, string>;
	readonly workerIndexByRoleId: ReadonlyMap<string, number | null>;
}

function deterministicToken(label: string): Uint8Array {
	return new Uint8Array(createHash("sha256").update(label).digest());
}

export function fanoutRoleId(
	role: "publisher" | "subscriber",
	index: number,
): string {
	return `${role}-${index.toString().padStart(6, "0")}`;
}

/**
 * Build the exact leaf set, Merkle root, per-role proofs, publisher grants, and
 * subscriber shards a relay needs, using the frozen §4.1 ordering: publishers
 * first, then subscribers, each by ascending numeric role ID. Deterministic in
 * the cohort ID, so two builds of the same cohort produce the same root.
 */
export function buildFanoutCohortFixture(args: {
	readonly cohortId: string;
	readonly publisherCount: number;
	readonly subscriberCount: number;
}): FanoutCohortFixture {
	const { cohortId, publisherCount, subscriberCount } = args;
	const leaves: TokenCommitmentLeafV1[] = [];
	const tokenBase64ByRoleId = new Map<string, Base64>();
	const tokenSha256ByRoleId = new Map<string, Sha256Hex>();
	const commitmentIndexByRoleId = new Map<string, number>();
	const childIdByRoleId = new Map<string, string>();
	const workerIndexByRoleId = new Map<string, number | null>();
	const publishers: PublisherRoleGrantV1[] = [];
	const expectedSubscriberIds: string[] = [];

	for (let index = 0; index < publisherCount; index += 1) {
		const roleId = fanoutRoleId("publisher", index);
		const token = deterministicToken(`${cohortId}:${roleId}`);
		const tokenSha256 = sha256HexOfBytes(token);
		const childId = `publisher-child-${index}`;
		tokenBase64ByRoleId.set(
			roleId,
			Buffer.from(token).toString("base64") as Base64,
		);
		tokenSha256ByRoleId.set(roleId, tokenSha256);
		commitmentIndexByRoleId.set(roleId, leaves.length);
		childIdByRoleId.set(roleId, childId);
		workerIndexByRoleId.set(roleId, null);
		publishers.push({
			schema: "publisher-role-grant/v1",
			childId,
			publisherId: roleId,
			tokenCommitmentIndex: leaves.length,
			tokenSha256,
		});
		leaves.push({
			schema: "token-commitment-leaf/v1",
			childId,
			cohortId,
			role: "publisher",
			roleId,
			tokenSha256,
			workerIndex: null,
		});
	}

	const shardRoleIds = new Map<number, string[]>();
	for (let index = 0; index < subscriberCount; index += 1) {
		const roleId = fanoutRoleId("subscriber", index);
		const workerIndex = index % SUBSCRIBER_SHARD_MODULUS;
		const token = deterministicToken(`${cohortId}:${roleId}`);
		const tokenSha256 = sha256HexOfBytes(token);
		const childId = `subscriber-worker-${workerIndex}`;
		tokenBase64ByRoleId.set(
			roleId,
			Buffer.from(token).toString("base64") as Base64,
		);
		tokenSha256ByRoleId.set(roleId, tokenSha256);
		commitmentIndexByRoleId.set(roleId, leaves.length);
		childIdByRoleId.set(roleId, childId);
		workerIndexByRoleId.set(roleId, workerIndex);
		expectedSubscriberIds.push(roleId);
		const bucket = shardRoleIds.get(workerIndex) ?? [];
		bucket.push(roleId);
		shardRoleIds.set(workerIndex, bucket);
		leaves.push({
			schema: "token-commitment-leaf/v1",
			childId,
			cohortId,
			role: "subscriber",
			roleId,
			tokenSha256,
			workerIndex,
		});
	}

	const leafSha256List = leaves.map((leaf) => tokenCommitmentLeafSha256(leaf));
	const levels = merkleLevels(leafSha256List);
	const root = (levels[levels.length - 1] as Sha256Hex[])[0] as Sha256Hex;
	const proofByRoleId = new Map<string, readonly Sha256Hex[]>();
	for (const [roleId, index] of commitmentIndexByRoleId) {
		proofByRoleId.set(roleId, merkleProof(levels, index));
	}

	const subscriberShards: SubscriberShardV1[] = [];
	for (let worker = 0; worker < COHORT_WORKER_COUNT; worker += 1) {
		const roleIds = shardRoleIds.get(worker);
		if (roleIds === undefined || roleIds.length === 0) continue;
		const first = commitmentIndexByRoleId.get(roleIds[0] as string) as number;
		subscriberShards.push({
			schema: "subscriber-shard/v1",
			childId: `subscriber-worker-${worker}`,
			workerIndex: worker,
			modulus: SUBSCRIBER_SHARD_MODULUS,
			residue: worker,
			firstSubscriberIndex: 0,
			lastSubscriberIndexExclusive: roleIds.length,
			subscriberCount: roleIds.length,
			orderedSubscriberIdsSha256: sha256HexOfBytes(bytesOfCanonical(roleIds)),
			firstTokenCommitmentIndex: first,
			lastTokenCommitmentIndexExclusive: first + roleIds.length,
		});
	}

	return {
		cohortId,
		publishers,
		subscriberShards,
		expectedSubscriberIds,
		leaves,
		leafSha256List,
		roleTokenCommitmentRootSha256: root,
		roleTokenCommitmentCount: leaves.length,
		tokenBase64ByRoleId,
		tokenSha256ByRoleId,
		commitmentIndexByRoleId,
		proofByRoleId,
		childIdByRoleId,
		workerIndexByRoleId,
	};
}

function merkleLevels(leafSha256List: readonly Sha256Hex[]): Sha256Hex[][] {
	const leafNodes = leafSha256List.map((leaf) =>
		createHash("sha256")
			.update(Uint8Array.of(0x00))
			.update(Buffer.from(leaf, "hex"))
			.digest("hex"),
	);
	const levels: Sha256Hex[][] = [leafNodes];
	while ((levels[levels.length - 1] as Sha256Hex[]).length > 1) {
		const current = levels[levels.length - 1] as Sha256Hex[];
		const next: Sha256Hex[] = [];
		for (let index = 0; index < current.length; index += 2) {
			const left = current[index] as Sha256Hex;
			const right = (current[index + 1] ?? left) as Sha256Hex;
			next.push(
				createHash("sha256")
					.update(Uint8Array.of(0x01))
					.update(Buffer.from(left, "hex"))
					.update(Buffer.from(right, "hex"))
					.digest("hex"),
			);
		}
		levels.push(next);
	}
	return levels;
}

function merkleProof(levels: Sha256Hex[][], leafIndex: number): Sha256Hex[] {
	const proof: Sha256Hex[] = [];
	let index = leafIndex;
	for (let level = 0; level < levels.length - 1; level += 1) {
		const nodes = levels[level] as Sha256Hex[];
		const siblingIndex = index % 2 === 0 ? index + 1 : index - 1;
		proof.push((nodes[siblingIndex] ?? nodes[index]) as Sha256Hex);
		index = Math.floor(index / 2);
	}
	return proof;
}

/** Deterministic payload of exactly the cell's declared size. */
export function fanoutPayload(
	messageBytes: 100 | 128,
	label: string,
): { readonly payloadBase64: Base64; readonly payloadSha256: Sha256Hex } {
	const bytes = new Uint8Array(messageBytes);
	let filled = 0;
	let round = 0;
	while (filled < messageBytes) {
		const block = new Uint8Array(
			createHash("sha256").update(`${label}:${round}`).digest(),
		);
		const take = Math.min(block.byteLength, messageBytes - filled);
		bytes.set(block.subarray(0, take), filled);
		filled += take;
		round += 1;
	}
	return {
		payloadBase64: Buffer.from(bytes).toString("base64") as Base64,
		payloadSha256: sha256HexOfBytes(bytes),
	};
}

/** A digest that is well-formed but bound to nothing but its own label. */
export function fanoutFixtureDigest(label: string): Sha256Hex {
	const digest = createHash("sha256").update(label).digest("hex");
	if (!isHex64(digest)) throw new Error("fixture digest");
	return digest;
}

/** The window counts a cell may declare; re-exported so tests name one source. */
export const FANOUT_RELAY_WINDOW_COUNT_VALUES = COHORT_WINDOW_COUNT_VALUES;
