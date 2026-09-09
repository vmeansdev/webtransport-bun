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
	type CohortGrantV1,
	cohortGrantBytes,
	type CohortWarmupEpochV1,
	decodeStrictBase64,
	type LinuxRelayObservationV1,
	type PublisherRoleGrantV1,
	parseCohortStartBarrier,
	parseCohortWarmupEpoch,
	parseLinuxRelayObservation,
	RELAY_DELIVERY_FAILURE_CODE,
	resolveGlobalOrdinal,
	requireCohortGrantSignatureBeforeRigAction,
	SUBSCRIBER_SHARD_MODULUS,
	type SubscriberShardV1,
	subscriberShardCommitmentWindowEnd,
	type TokenCommitmentLeafV1,
	tokenCommitmentLeafSha256,
	verifyTokenMerkleProof,
	WARMUP_PROTOCOL_FAILURE_CODE,
} from "../cohort-protocol.ts";
import {
	buildServerCaptureAck,
	buildServerMeasureStartAck,
	buildServerReady,
	buildServerStartBarrierAccepted,
	buildServerWarmupDrained,
	CHILD_PIPE_CONTROL_MAX_BYTES,
	type ChildPipeResult,
	type ServerCaptureAckV1,
	type ServerMeasureStartAckV1,
	type ServerReadyV1,
	type ServerStartBarrierAcceptedV1,
	type ServerWarmupDrainedV1,
} from "../child-pipe-protocol.ts";
import {
	type Base64,
	bytesOfCanonical,
	type NsString,
	parseMacReceiptSignature,
	type ProtocolResult,
	type Sha256Hex,
	verifyMacReceiptSignature,
} from "../cross-supervisor-protocol.ts";
import {
	isServerLoopUtilizationFrameV1,
	type ServerLoopUtilizationFrameV1,
} from "../server-snapshot-protocol.ts";
import { isHex64, sha256HexOfBytes } from "../secure-fs.ts";
import {
	buildFanoutDeliveryContext,
	cloneFanoutDeliveryForSubscriber,
	contextTagOfDeliveryContextSha256,
	decodeFanoutWsMessage,
	decodeFanoutWtStream,
	encodeFanoutDeliveryTemplate,
	encodeFanoutWsMessage,
	encodeFanoutWtFrame,
	FANOUT_DATA_FRAME_MAX_DECODED_BYTES,
	type FanoutAckClosedCode,
	type FanoutAckV1,
	type FanoutDataV1,
	type FanoutDeliveryContextFacts,
	type FanoutDeliveryEpoch,
	type FanoutEndV1,
	type FanoutRefuseCode,
	type FanoutRegisterV1,
	type FanoutWarmupDataV1,
	type FanoutWarmupEndV1,
	type FanoutWireV1,
	fanoutDeliveryUnitBytes,
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
 * One relay-owned session. Neither send may block: a transport that cannot
 * take the bytes right now answers `would-block` and the engine leaves the
 * item at the head of that subscriber's queue, where the write deadline still
 * applies to it.
 *
 * `trySend` is the control channel (accept, refuse, ack, end). `trySendDelivery`
 * is the subscriber's delivery channel -- the socket itself on WS, the
 * server-opened uni stream on WT -- and carries only what the relay queues per
 * subscriber: the per-epoch delivery context and the compact frames bound to
 * it. The engine addresses the channel; the transport never has to look inside
 * the bytes to find out which one they belong on.
 */
export interface RelaySessionSink {
	trySend(bytes: Uint8Array): RelaySendOutcome;
	trySendDelivery(bytes: Uint8Array): RelaySendOutcome;
	close(reason: string): void;
}

/**
 * The header offset of `contextTag` in a `fanout-delivery/c1` frame (D2 table).
 * The tag is per session -- the context digest commits to the subscriber's id
 * and index -- so every clone of an ingress template is patched here as well
 * as at `subscriberIndex`. `fanout-relay.test.ts` decodes a clone through the
 * codec and asserts the tag, so a header change is caught there.
 */
const FANOUT_DELIVERY_CONTEXT_TAG_OFFSET = 16;

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

/**
 * The placeholder a Linux child carries for a record it has not been handed
 * yet. A relay holding it for the warmup epoch or the start barrier refuses the
 * transition that record authorises; only `bindWarmupEpoch` / `bindStartBarrier`
 * replace it, and only once each. No SHA-256 preimage produces 64 zeros, so a
 * genuine digest can never collide with the unbound state.
 */
export const FANOUT_RELAY_UNBOUND_DIGEST = "0".repeat(64) as Sha256Hex;

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

/** What each publisher offered and what each subscriber worker received. */
export interface FanoutWarmupWireCountsV1 {
	readonly offersByPublisherId: ReadonlyMap<string, number>;
	readonly deliveriesBySubscriberId: ReadonlyMap<string, number>;
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

/**
 * One item of a subscriber's delivery queue. A `context` item is the epoch's
 * delivery context, placed at the head when the epoch binds; it shares the
 * queue's cap and write deadline with the deliveries behind it but is never
 * counted as one of them.
 */
interface QueuedDelivery {
	readonly kind: "context" | "delivery";
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
	/** The subscriber's position in the grant's subscriber order, once registered. */
	subscriberIndex: number | null;
	/** The tag every compact frame of the epoch carries for this session. */
	warmupContextTag: number | null;
	measuredContextTag: number | null;
	registered: boolean;
	closed: boolean;
	faultCode: FanoutAckClosedCode | null;
	queue: QueuedDelivery[];
	queueBytes: number;
	controlQueue: Uint8Array[];
	nextMeasuredSequence: number;
	nextWarmupSequence: number;
	/**
	 * Warmup records enqueued *for this subscriber*. The global
	 * `warmupDeliveries` total cannot tell a cohort where every worker took its
	 * share from one where a single worker took everything, and §5 step 7 asks
	 * each subscriber worker to prove its own expanded delivery count.
	 */
	warmupDeliveriesEnqueued: number;
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
	private configValue: FanoutRelayConfig;
	readonly caps: FanoutRelayCaps;
	readonly codec: FanoutFrameCodec;

	/**
	 * The cohort a Linux child is bound to is fixed at bind time, but the
	 * warmup epoch and the start barrier are minted later and reach the child
	 * as signed records (§4.1). `bindWarmupEpoch` / `bindStartBarrier` fill
	 * them in once each; a relay constructed with the real digests already in
	 * hand -- which is how the B2 engine tests drive it -- is bound on arrival.
	 */
	private warmupEpochBound: boolean;
	private startBarrierBound: boolean;

	/**
	 * Every role this relay ever admitted, in admission order. Registration is
	 * a fact about the cohort, not about who was still connected at the end: a
	 * subscriber that drops mid-run stays registered and is accounted for in the
	 * disconnect counters instead of quietly shrinking the population its own
	 * session peak is measured against.
	 */
	private readonly admittedPublisherIds = new Set<string>();
	private readonly admittedSubscriberIds = new Set<string>();

	get config(): FanoutRelayConfig {
		return this.configValue;
	}

	private phaseValue: FanoutRelayPhase = "registration";
	private readonly sessions = new Map<string, RelaySession>();
	private readonly sessionsByRoleId = new Map<string, RelaySession>();
	private readonly spentTokenSha256 = new Set<string>();
	private readonly publisherById = new Map<string, PublisherRoleGrantV1>();
	private readonly publisherIndexById = new Map<string, number>();
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
	/** The subscriber the last round serviced last; the next round starts after it. */
	private pumpResumeAfterRoleId: string | null = null;
	private warmupIngress = 0;
	private warmupDeliveries = 0;
	private warmupPublisherEndCount = 0;

	constructor(config: FanoutRelayConfig) {
		this.configValue = config;
		this.warmupEpochBound =
			config.cohortWarmupEpochSha256 !== FANOUT_RELAY_UNBOUND_DIGEST &&
			config.warmupNonce !== FANOUT_RELAY_UNBOUND_DIGEST;
		this.startBarrierBound =
			config.cohortStartBarrierSha256 !== FANOUT_RELAY_UNBOUND_DIGEST;
		this.caps = { ...FANOUT_RELAY_DEFAULT_CAPS, ...(config.caps ?? {}) };
		this.codec = fanoutFrameCodecFor(config.transport);
		for (const [index, publisher] of config.publishers.entries()) {
			this.publisherById.set(publisher.publisherId, publisher);
			this.publisherIndexById.set(publisher.publisherId, index);
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
			subscriberIndex: null,
			warmupContextTag: null,
			measuredContextTag: null,
			registered: false,
			closed: false,
			faultCode: null,
			queue: [],
			queueBytes: 0,
			controlQueue: [],
			nextMeasuredSequence: 0,
			nextWarmupSequence: 0,
			warmupDeliveriesEnqueued: 0,
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
		let undelivered = 0;
		for (const item of session.queue) {
			if (item.kind === "delivery") {
				this.disconnectUndelivered[item.originWindowIndex] =
					(this.disconnectUndelivered[item.originWindowIndex] ?? 0) + 1;
				undelivered += 1;
			}
			this.queuedItems -= 1;
			this.queuedBytes -= item.bytes.byteLength;
		}
		if (undelivered > 0) {
			this.recordFault(
				"disconnect-undelivered",
				RELAY_DELIVERY_FAILURE_CODE,
				`${session.roleId ?? sessionId} closed with ${undelivered} queued deliveries`,
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
		if (frame.role === "publisher") {
			this.admittedPublisherIds.add(frame.roleId);
		} else {
			this.admittedSubscriberIds.add(frame.roleId);
			// Admission already required the id to be in the grant's order.
			session.subscriberIndex = this.config.expectedSubscriberIds.indexOf(
				frame.roleId,
			);
		}
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

	/**
	 * Bind the warmup epoch this relay will accept traffic for. The caller has
	 * already authenticated the Mac signature over the epoch bytes; what this
	 * does is make those exact digests the only ones the wire binding will
	 * match, before registration closes.
	 */
	bindWarmupEpoch(binding: {
		readonly cohortWarmupEpochSha256: Sha256Hex;
		readonly warmupNonce: Sha256Hex;
	}): ProtocolResult<true> {
		if (this.phaseValue !== "registration") {
			return relayFail(
				WARMUP_PROTOCOL_FAILURE_CODE,
				`cannot bind a warmup epoch from ${this.phaseValue}`,
			);
		}
		if (this.warmupEpochBound) {
			return relayFail(
				WARMUP_PROTOCOL_FAILURE_CODE,
				"warmup epoch is already bound",
			);
		}
		if (
			!isHex64(binding.cohortWarmupEpochSha256) ||
			!isHex64(binding.warmupNonce) ||
			binding.cohortWarmupEpochSha256 === FANOUT_RELAY_UNBOUND_DIGEST ||
			binding.warmupNonce === FANOUT_RELAY_UNBOUND_DIGEST
		) {
			return relayFail(
				WARMUP_PROTOCOL_FAILURE_CODE,
				"warmup epoch binding is not a pair of digests",
			);
		}
		this.configValue = {
			...this.configValue,
			cohortWarmupEpochSha256: binding.cohortWarmupEpochSha256,
			warmupNonce: binding.warmupNonce,
		};
		this.warmupEpochBound = true;
		return { ok: true, value: true };
	}

	/**
	 * Put the epoch's delivery context at the head of every registered
	 * subscriber's queue. Both callers reach this with empty queues -- the
	 * registration close leaves phase `registration`, in which nothing is ever
	 * queued, and the measured open requires `warmup-drained`, which
	 * `drainWarmup` refuses while anything is queued -- so "at the head" is
	 * asserted rather than assumed: a context can never be placed ahead of a
	 * delivery already owed.
	 */
	private enqueueDeliveryContexts(
		epoch: FanoutDeliveryEpoch,
	): ProtocolResult<true> {
		const failureCode =
			epoch === "warmup"
				? WARMUP_PROTOCOL_FAILURE_CODE
				: COHORT_PROTOCOL_FAILURE_CODE;
		const subscribers = this.registeredSubscribers();
		for (const subscriber of subscribers) {
			if (subscriber.queue.length !== 0) {
				return relayFail(
					failureCode,
					`${subscriber.roleId} has ${subscriber.queue.length} items queued at the ${epoch} bind`,
				);
			}
		}
		const publisherIds = this.config.publishers.map(
			(publisher) => publisher.publisherId,
		);
		for (const subscriber of subscribers) {
			const roleId = subscriber.roleId as string;
			const subscriberIndex = subscriber.subscriberIndex as number;
			const common = {
				cohortGrantSha256: this.config.cohortGrantSha256,
				subscriberId: roleId,
				subscriberIndex,
				publisherIds,
				windowCount: this.config.windowCount,
				messageBytes: this.config.messageBytes,
			};
			const facts: FanoutDeliveryContextFacts =
				epoch === "warmup"
					? {
							...common,
							epoch,
							cohortWarmupEpochSha256: this.config.cohortWarmupEpochSha256,
							warmupNonce: this.config.warmupNonce,
						}
					: {
							...common,
							epoch,
							cohortStartBarrierSha256: this.config.cohortStartBarrierSha256,
						};
			const context = buildFanoutDeliveryContext(facts);
			if (!context.ok) return context;
			const encoded = this.codec.encode(context.value);
			if (!encoded.ok) return encoded;
			const tag = contextTagOfDeliveryContextSha256(
				context.value.deliveryContextSha256,
			);
			if (epoch === "warmup") subscriber.warmupContextTag = tag;
			else subscriber.measuredContextTag = tag;
			this.queueItem(subscriber, {
				kind: "context",
				bytes: encoded.value,
				originWindowIndex: 0,
				linuxAcceptedOrdinal: 0,
				enqueuedAtMs: this.config.clock.nowMs(),
				warmup: epoch === "warmup",
			});
		}
		return { ok: true, value: true };
	}

	/**
	 * Bind the start barrier this relay will accept measured traffic under.
	 * Legal only once the warmup has drained, which is the point in §4.1 at
	 * which the barrier exists at all.
	 */
	bindStartBarrier(binding: {
		readonly cohortStartBarrierSha256: Sha256Hex;
	}): ProtocolResult<true> {
		if (this.phaseValue !== "warmup-drained") {
			return relayFail(
				COHORT_NOT_READY_FAILURE_CODE,
				`cannot bind a start barrier from ${this.phaseValue}`,
			);
		}
		if (this.startBarrierBound) {
			return relayFail(
				COHORT_PROTOCOL_FAILURE_CODE,
				"start barrier is already bound",
			);
		}
		if (
			!isHex64(binding.cohortStartBarrierSha256) ||
			binding.cohortStartBarrierSha256 === FANOUT_RELAY_UNBOUND_DIGEST
		) {
			return relayFail(
				COHORT_PROTOCOL_FAILURE_CODE,
				"start barrier binding is not a digest",
			);
		}
		this.configValue = {
			...this.configValue,
			cohortStartBarrierSha256: binding.cohortStartBarrierSha256,
		};
		this.startBarrierBound = true;
		return { ok: true, value: true };
	}

	/** Registration closes exactly once, before the warmup epoch opens. */
	closeRegistration(): ProtocolResult<true> {
		if (this.phaseValue !== "registration") {
			return relayFail(
				COHORT_PROTOCOL_FAILURE_CODE,
				`cannot close registration from ${this.phaseValue}`,
			);
		}
		// Warmup traffic is bound to an epoch, so there is no legal warmup phase
		// to enter until the signed epoch has been verified and bound.
		if (!this.warmupEpochBound) {
			return relayFail(
				WARMUP_PROTOCOL_FAILURE_CODE,
				"registration cannot close before the signed warmup epoch is bound",
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
		// Nobody joins after this and nothing has been queued for anyone, so
		// the epoch's context is the first unit on every delivery channel; a
		// relay bound at construction reaches here without `bindWarmupEpoch`.
		const contexts = this.enqueueDeliveryContexts("warmup");
		if (!contexts.ok) return contexts;
		this.pumpContexts();
		return { ok: true, value: true };
	}

	/**
	 * Write the contexts just queued, as far as the transports will take them.
	 * A round is bounded at `maxConcurrentWrites` subscribers, and no ingress
	 * pumps again until the epoch's traffic starts, so one round would leave a
	 * cohort wider than a round with contexts still queued -- under the write
	 * deadline -- for as long as the Mac takes to start the epoch. Rounds run
	 * until one moves nothing; a channel that is not ready yet keeps its
	 * context at the head and the transport's own drain pumps it.
	 */
	private pumpContexts(): void {
		for (;;) {
			const before = this.queuedItems;
			if (before === 0) return;
			this.pump();
			if (this.queuedItems === before) return;
		}
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
		const template = this.deliveryTemplate(frame, 0, ordinal);
		if (template !== null) {
			for (const subscriber of this.registeredSubscribers()) {
				const enqueued = this.enqueue(
					subscriber,
					this.deliveryFor(subscriber, template, "warmup"),
					0,
					ordinal,
					true,
				);
				if (enqueued) {
					this.warmupDeliveries += 1;
					subscriber.warmupDeliveriesEnqueued += 1;
				}
			}
		}
		this.pump();
		return { ok: true, value: true };
	}

	/**
	 * One compact template per accepted ingress: the payload is decoded and
	 * copied once, and every field but the two that are per session is written.
	 * The ingress parser already proved the payload's length and digest, so a
	 * refusal here is the relay's own defect and is recorded as malformed for
	 * the ingress window rather than charged to a subscriber.
	 */
	private deliveryTemplate(
		frame: FanoutDataV1 | FanoutWarmupDataV1,
		windowIndex: number,
		linuxAcceptedOrdinal: number,
	): Uint8Array | null {
		const publisherIndex = this.publisherIndexById.get(frame.publisherId);
		const payload = decodeStrictBase64(
			frame.payloadBase64,
			FANOUT_DATA_FRAME_MAX_DECODED_BYTES,
		);
		if (publisherIndex === undefined || payload === null) {
			this.recordMalformedAt(
				windowIndex,
				"relay could not template the ingress",
			);
			return null;
		}
		const template = encodeFanoutDeliveryTemplate({
			windowIndex,
			publisherIndex,
			publisherSequence: frame.publisherSequence,
			linuxAcceptedOrdinal,
			// Patched per subscriber; the template carries no session's tag.
			contextTag: 0,
			payload,
		});
		if (!template.ok) {
			this.recordMalformedAt(
				windowIndex,
				`relay delivery template: ${template.message ?? template.code}`,
			);
			return null;
		}
		return template.value;
	}

	/** The per-subscriber clone: `subscriberIndex` and the session's epoch tag. */
	private deliveryFor(
		subscriber: RelaySession,
		template: Uint8Array,
		epoch: FanoutDeliveryEpoch,
	): Uint8Array {
		const bytes = cloneFanoutDeliveryForSubscriber(
			template,
			subscriber.subscriberIndex as number,
		);
		const tag =
			epoch === "warmup"
				? subscriber.warmupContextTag
				: subscriber.measuredContextTag;
		if (tag === null) {
			// Unreachable by construction: every registered subscriber was given
			// its context when the epoch bound, before any ingress of it exists.
			throw new Error(
				`${subscriber.roleId} has no ${epoch} delivery context to tag against`,
			);
		}
		new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(
			FANOUT_DELIVERY_CONTEXT_TAG_OFFSET,
			tag,
			true,
		);
		return bytes;
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
	 * Measured traffic is legal only after the exact start barrier this relay
	 * was configured with has been accepted, by digest.
	 *
	 * Round three's authority ruling took the rig's `rig-barrier-acceptance/v1`
	 * out of the server child, so what arms the gate is the barrier digest the
	 * child verified a Mac signature over
	 * (`FanoutLinuxAuthority.acceptStartBarrier`), not a rig record the child
	 * would have had to be handed. The check is the same one either way: a
	 * digest naming any other barrier leaves the relay in `warmup-drained`.
	 */
	openMeasuredWindow(args: {
		readonly cohortStartBarrierSha256: Sha256Hex;
	}): ProtocolResult<true> {
		if (this.phaseValue !== "warmup-drained") {
			return relayFail(
				COHORT_NOT_READY_FAILURE_CODE,
				`barrier acceptance in phase ${this.phaseValue}`,
			);
		}
		if (!this.startBarrierBound) {
			return relayFail(
				COHORT_NOT_READY_FAILURE_CODE,
				"no start barrier is bound, so no acceptance can name one",
			);
		}
		if (!isHex64(args.cohortStartBarrierSha256)) {
			return relayFail(
				COHORT_PROTOCOL_FAILURE_CODE,
				"barrier acceptance names no digest",
			);
		}
		if (
			args.cohortStartBarrierSha256 !== this.config.cohortStartBarrierSha256
		) {
			return relayFail(
				COHORT_PROTOCOL_FAILURE_CODE,
				"barrier acceptance names another start barrier",
			);
		}
		// The measured context goes out ahead of the first measured delivery on
		// every subscriber's channel; the drain left every queue empty.
		const contexts = this.enqueueDeliveryContexts("measured");
		if (!contexts.ok) return contexts;
		this.phaseValue = "measured";
		this.measurementStartedAtNs = this.config.clock.nowNs();
		this.pumpContexts();
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
		const frameBytesEstimate = this.estimateDeliveryBytes();
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
		const template = this.deliveryTemplate(frame, window, ordinal);
		if (template !== null) {
			for (const subscriber of subscribers) {
				this.enqueue(
					subscriber,
					this.deliveryFor(subscriber, template, "measured"),
					window,
					ordinal,
					false,
				);
			}
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
		bytes: Uint8Array,
		originWindowIndex: number,
		linuxAcceptedOrdinal: number,
		warmup: boolean,
	): boolean {
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
		this.queueItem(subscriber, {
			kind: "delivery",
			bytes,
			originWindowIndex,
			linuxAcceptedOrdinal,
			enqueuedAtMs: this.config.clock.nowMs(),
			warmup,
		});
		return true;
	}

	/** Append one item and keep the queue-depth bookkeeping exact. */
	private queueItem(subscriber: RelaySession, item: QueuedDelivery): void {
		subscriber.queue.push(item);
		subscriber.queueBytes += item.bytes.byteLength;
		this.queuedItems += 1;
		this.queuedBytes += item.bytes.byteLength;
		if (this.queuedItems > this.queueItemsPeak)
			this.queueItemsPeak = this.queuedItems;
		if (this.queuedBytes > this.queueBytesPeak)
			this.queueBytesPeak = this.queuedBytes;
	}

	/**
	 * One bounded delivery round: at most `maxConcurrentWrites` subscribers are
	 * serviced, in subscriber-ID order, and each stops at the first item the
	 * transport will not take. The head item's age is the write deadline, so a
	 * congested subscriber fails at a bounded time rather than accumulating.
	 *
	 * A round resumes after the subscriber the previous round serviced last and
	 * wraps, so a lap over every queued subscriber takes a bounded number of
	 * rounds whatever the transport answers. A round that always restarted at
	 * the head would spend its slots on the same congested subscribers each
	 * time and never reach the tail of the order: three workers that stop
	 * reading would starve the five that are.
	 */
	pump(): void {
		const nowMs = this.config.clock.nowMs();
		for (const session of this.activeSessions()) this.drainControl(session);
		const subscribers = this.registeredSubscribers();
		const start = this.pumpStartIndex(subscribers);
		let serviced = 0;
		for (let step = 0; step < subscribers.length; step += 1) {
			if (serviced >= this.caps.maxConcurrentWrites) break;
			const subscriber = subscribers[
				(start + step) % subscribers.length
			] as RelaySession;
			if (subscriber.controlQueue.length > 0) continue;
			if (subscriber.queue.length === 0) continue;
			serviced += 1;
			this.pumpResumeAfterRoleId = subscriber.roleId as string;
			while (subscriber.queue.length > 0 && !subscriber.closed) {
				const item = subscriber.queue[0] as QueuedDelivery;
				if (nowMs - item.enqueuedAtMs > this.caps.writeDeadlineMs) {
					this.dropHead(subscriber);
					// A context that cannot be written in time fails the session
					// exactly as a delivery would; it is just not a delivery, so
					// the per-window delivery counter does not move for it.
					if (item.kind === "delivery") {
						this.writeTimeouts[item.originWindowIndex] =
							(this.writeTimeouts[item.originWindowIndex] ?? 0) + 1;
					}
					this.recordFault(
						"write-timeout",
						RELAY_DELIVERY_FAILURE_CODE,
						`${subscriber.roleId} ${item.kind} write exceeded ${this.caps.writeDeadlineMs} ms`,
					);
					subscriber.faultCode = "RELAY_WRITE_TIMEOUT";
					this.closeSession(subscriber.sessionId, "relay write timeout");
					break;
				}
				const outcome = subscriber.sink.trySendDelivery(item.bytes);
				if (outcome === "would-block") break;
				if (outcome === "closed") {
					subscriber.faultCode = "SUBSCRIBER_DISCONNECTED";
					this.closeSession(subscriber.sessionId, "subscriber disconnected");
					break;
				}
				this.dropHead(subscriber);
				if (item.kind === "delivery" && !item.warmup) {
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

	/** Where this round starts: the first subscriber after the resume point. */
	private pumpStartIndex(subscribers: readonly RelaySession[]): number {
		const resumeAfter = this.pumpResumeAfterRoleId;
		if (resumeAfter === null) return 0;
		const index = subscribers.findIndex(
			(subscriber) =>
				(subscriber.roleId as string).localeCompare(resumeAfter) > 0,
		);
		return index < 0 ? 0 : index;
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

	/**
	 * How many distinct role tokens this relay has spent. Registration adds to
	 * a set (`:650`) only after `registrationRefusal` has rejected a replay
	 * (`:694`), so this is exactly "tokens spent, each once" -- the fact an
	 * admission check needs and cannot recover from the session list, because a
	 * session that closed after registering keeps its token spent.
	 */
	spentTokenCount(): number {
		return this.spentTokenSha256.size;
	}

	/**
	 * The subscriber IDs this relay was configured to admit -- the same list
	 * `registrationRefusal` checks each register frame against (`:709`), so an
	 * admission check that reads it here is reading the one source, not a second
	 * derivation of it.
	 */
	expectedSubscriberIds(): readonly string[] {
		return this.config.expectedSubscriberIds;
	}

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

	/**
	 * Per-role warmup wire counts, which the global totals cannot express: what
	 * each publisher actually offered, and what each subscriber worker was
	 * actually expanded to. Both are the relay's own tallies -- there is no
	 * argument here through which a caller could state either one.
	 */
	warmupWireCounts(): FanoutWarmupWireCountsV1 {
		const offersByPublisherId = new Map<string, number>();
		const deliveriesBySubscriberId = new Map<string, number>();
		for (const session of this.sessions.values()) {
			if (!session.registered || session.roleId === null) continue;
			if (session.role === "publisher") {
				offersByPublisherId.set(session.roleId, session.nextWarmupSequence);
			} else if (session.role === "subscriber") {
				deliveriesBySubscriberId.set(
					session.roleId,
					session.warmupDeliveriesEnqueued,
				);
			}
		}
		return { offersByPublisherId, deliveriesBySubscriberId };
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
		// The observation reports admission, which survives shutdown reaping the
		// sessions; sets go on the wire sorted so a reorder cannot hide.
		const publisherIds = [...this.admittedPublisherIds].sort();
		const subscriberIds = [...this.admittedSubscriberIds].sort();
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
			registeredPublisherIds: [...publisherIds],
			registeredSubscriberIdsSha256: sha256HexOfBytes(
				bytesOfCanonical(subscriberIds),
			),
			registeredPublisherCount: publisherIds.length,
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

	/** Every delivery of a cell is one compact unit of exactly this size. */
	private estimateDeliveryBytes(): number {
		return fanoutDeliveryUnitBytes(this.config.messageBytes);
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
 * first, then subscribers, each by ascending numeric role ID.
 *
 * This is the single implementation of that ordering, so it is production code
 * and not a fixture helper; what is fixture-only is the *default token source*.
 * Plan line 1221 puts token minting in the Mac supervisor, as 32 random bytes
 * per role. `tokenFor` is the seam those bytes arrive through. Left unset, the
 * builder falls back to `sha256(cohortId || ":" || roleId)`, which is
 * deterministic in the cohort ID -- fine for a test, and unusable in production
 * because the cohort ID travels inside the signed grant, which would make the
 * grant a universal token oracle (§4.3, plan 1768-1770).
 *
 * Two shapes are refused rather than silently accommodated:
 *
 * - fewer than eight subscribers, because §4.1 fixes eight shards and a cohort
 *   that cannot fill them emits a short shard array that the grant codec (and
 *   `parse_shards`, `secure_fs.rs:12540`) refuses one hop later, at a place
 *   with no idea which cohort was too small;
 * - a token that is not 32 raw bytes, because a shorter secret is a weaker one
 *   and every consumer sees only its digest.
 */
export function buildFanoutCohortFixture(args: {
	readonly cohortId: string;
	readonly publisherCount: number;
	readonly subscriberCount: number;
	/** 32 raw bytes per role. Defaults to the deterministic fixture token. */
	readonly tokenFor?: (roleId: string) => Uint8Array;
}): FanoutCohortFixture {
	const { cohortId, publisherCount, subscriberCount } = args;
	if (
		!Number.isSafeInteger(subscriberCount) ||
		subscriberCount < SUBSCRIBER_SHARD_MODULUS
	) {
		throw new RangeError(
			`a cohort needs at least eight subscribers to fill the eight shards, not ${subscriberCount}`,
		);
	}
	const tokenOf = (roleId: string): Uint8Array => {
		const supplied = args.tokenFor?.(roleId);
		const token = supplied ?? deterministicToken(`${cohortId}:${roleId}`);
		if (token.byteLength !== 32) {
			throw new RangeError(
				`the token for ${roleId} is ${token.byteLength} bytes, not 32`,
			);
		}
		// §2.4's mandatory guard, at the only place that can see both values: a
		// supplied token that happens to be the derived one is the derived
		// scheme wearing the production seam, and the signed grant carries the
		// cohort id, so it would be a universal token oracle. A guard that only
		// checked "two cohorts differ" passes on the derived scheme.
		if (
			supplied !== undefined &&
			Buffer.from(supplied).equals(
				Buffer.from(deterministicToken(`${cohortId}:${roleId}`)),
			)
		) {
			throw new RangeError(
				`the token for ${roleId} is derivable from the cohort id the grant carries`,
			);
		}
		return token;
	};
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
		const token = tokenOf(roleId);
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
		const token = tokenOf(roleId);
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
			// §2.3: the bound is the grant's subscriber total on every shard,
			// which is the reading `parse_shards` enforces (`secure_fs.rs:12556`)
			// and the only one under which summing the eight `subscriberCount`s
			// back to that total is not vacuous.
			lastSubscriberIndexExclusive: subscriberCount,
			subscriberCount: roleIds.length,
			orderedSubscriberIdsSha256: sha256HexOfBytes(bytesOfCanonical(roleIds)),
			// The window is the span of this residue class: `roleIds` sit at
			// `first, first + 8, …` in leaf order, so it ends one past the last
			// member, and the relay enforces exactly that window (`:717-722`).
			firstTokenCommitmentIndex: first,
			lastTokenCommitmentIndexExclusive: subscriberShardCommitmentWindowEnd(
				first,
				roleIds.length,
			),
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

// ---------------------------------------------------------------------------
// Linux-authoritative cohort session (B3)
//
// The engine above owns the relay's counters; this section owns the *right* to
// move it. Every transition a cohort makes on the Linux side is authorised by a
// record the Mac supervisor signed -- the grant before the server binds, the
// warmup epoch before registration closes, the start barrier before measured
// traffic. Nothing here trusts a digest the caller supplies: the signature is
// verified over the exact canonical bytes and the digest is recomputed from
// those bytes.
//
// What this section does *not* do, since round three's authority ruling, is
// sign. The server child holds no private key; it answers each authorised
// transition with a §3.4 child-pipe frame stating what the relay observed, and
// the rig supervisor -- the sole Linux signer -- receipts the exact bytes it
// received (design §1.3, §1.4). Every frame below is built through
// `child-pipe-protocol.ts`, which owns those key sets and their hex vectors, so
// there is one encoder for each and the rig's Rust parser is reading the bytes
// that encoder produced.
// ---------------------------------------------------------------------------

/**
 * §4.4: the Linux server-child cohort frames are 16 KiB each.
 *
 * Tighter than §3.4's 64 KiB control-pipe cap
 * (`CHILD_PIPE_CONTROL_MAX_BYTES`), and checked here rather than in the codec
 * because it is a property of these cohort frames rather than of the pipe.
 */
export const SERVER_CHILD_COHORT_FRAME_MAX_BYTES = 16 * 1024;

function isNonNegInt(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Adapt a `child-pipe-protocol.ts` build result onto this module's result type.
 *
 * The refusal codes are that module's `ChildPipeRefusalCode`s, which is what
 * `server.ts` puts on the wire as `child-pipe-refusal/v1`; here they are
 * carried in the message so a caller that only reads this module's codes still
 * sees which field the codec refused.
 */
function childFrame<T>(
	code: string,
	built: ChildPipeResult<T>,
): ProtocolResult<T> {
	if (built.ok) return { ok: true, value: built.value };
	return relayFail(
		code,
		`${built.code}${built.message === undefined ? "" : `: ${built.message}`}`,
	);
}

/** Every child cohort frame is capped before it leaves this module. */
function withinChildFrameCap<T>(
	code: string,
	frame: T,
): ProtocolResult<{ readonly frame: T; readonly bytes: Uint8Array }> {
	const bytes = bytesOfCanonical(frame);
	if (bytes.byteLength > SERVER_CHILD_COHORT_FRAME_MAX_BYTES) {
		return relayFail(code, `child cohort frame is ${bytes.byteLength} bytes`);
	}
	return { ok: true, value: { frame, bytes } };
}

// -- the authority ----------------------------------------------------------

/** Which cohort transitions this Linux side has been authorised to make. */
export type FanoutLinuxAuthorityStage =
	| "unbound"
	| "grant-accepted"
	| "server-ready"
	| "roles-registered"
	| "warmup-open"
	| "warmup-drained"
	| "barrier-accepted"
	| "measurement-stopped"
	| "observed";

/** The server child's own identity, which only the server child can state. */
export interface FanoutLinuxServerIdentityV1 {
	readonly serverChildPid: number;
	readonly serverChildPgid: number;
	readonly serverChildInstanceNonce: Sha256Hex;
}

/**
 * The server loop's busy-time reading, sampled at the moment it is needed.
 *
 * It is optional on the config, and every method that needs it refuses when it
 * is absent, precisely because a busy reading has no honest default: a zero
 * baseline that looked like a measurement is the placeholder-evidence defect
 * this whole plan exists to keep out of the record. It is a function rather
 * than a number so the baseline and the final reading are two separate reads of
 * the same loop rather than one number carried twice.
 *
 * Whole milliseconds, because the rig's parser reads `baselineBusyMs`,
 * `finalBusyMs` and `busyMs` with `as_u64` and requires
 * `finalBusyMs - baselineBusyMs == busyMs` exactly
 * (`crates/native/src/secure_fs.rs:12112-12117`, `:16764-16773`). A fractional
 * reading would be refused there, so it is refused here, where the reader can
 * still be told which value was wrong.
 */
export interface FanoutLinuxLoopObserverV1 {
	busyMs(): number;
}

export interface FanoutLinuxAuthorityConfig {
	readonly transport: "ws" | "wt";
	readonly executionSha256: Sha256Hex;
	/** The Mac public key the rig staged; nothing else can authorise a step. */
	readonly stagedMacPublicRaw32: Uint8Array;
	/**
	 * The server child this authority *is*. It is configuration and not a
	 * `startServer` argument because a process cannot be handed its own pid by a
	 * caller without that caller being able to state a different one.
	 */
	readonly serverIdentity: FanoutLinuxServerIdentityV1;
	readonly linuxClockId: string;
	readonly clock: RelayClock;
	/**
	 * How long a receipt over this session's frames stays valid.
	 *
	 * Design §2.1 keeps it in the config the server child is constructed with.
	 * Nothing in this module reads it any more: the validity window belongs to
	 * the records the rig signs, and this side signs none. It is carried so the
	 * child's construction still states the session's validity contract in one
	 * place rather than having it appear for the first time on the rig.
	 */
	readonly receiptValidityMs: number;
	readonly loop?: FanoutLinuxLoopObserverV1;
	readonly caps?: Partial<FanoutRelayCaps>;
}

/** One role peer offering itself to the relay under its Mac permit ordinal. */
export interface FanoutRolePeerAdmissionV1 {
	/** The global ordinal `MacPermitScheduler` issued this child's permit for. */
	readonly globalOrdinal: number;
	readonly sink: RelaySessionSink;
	/** The peer's own `register` frame, unparsed. */
	readonly register: unknown;
}

export interface FanoutRolePeerRegistrationV1 {
	readonly globalOrdinal: number;
	readonly role: "publisher" | "subscriber";
	readonly roleId: string;
	readonly sessionId: string;
}

export interface FanoutRolePeerRegistrationResultV1 {
	readonly registered: readonly FanoutRolePeerRegistrationV1[];
	readonly registeredPublisherCount: number;
	readonly registeredSubscriberCount: number;
}

/** What the Linux side observed on the warmup wire, per role. */
export interface FanoutWarmupWireResultV1 {
	readonly warmupIngress: number;
	readonly warmupDeliveries: number;
	readonly warmupMessagesPerPublisher: number;
	readonly offersByPublisherId: ReadonlyMap<string, number>;
	readonly deliveriesBySubscriberId: ReadonlyMap<string, number>;
}

export interface FanoutMeasuredWindowResultV1 {
	readonly acceptedIngressTotal: number;
	readonly relayWritesCompletedTotal: number;
	readonly postStopRelayWrites: number;
	readonly drainedAtLinuxNs: NsString;
	readonly publisherEndCount: number;
}

/**
 * Each observer result is one §3.4 frame and the exact bytes of it.
 *
 * The bytes are returned beside the record because the rig receipts *the bytes
 * it received*, and a caller that re-canonicalised the record to get them would
 * have reintroduced the divergence §1.3 deletes.
 */
export interface FanoutChildFrame<T> {
	readonly frame: T;
	readonly frameBytes: Uint8Array;
	readonly frameSha256: Sha256Hex;
}

/** What the child retained when it accepted the Mac-signed grant. */
export interface FanoutCohortAcceptance {
	readonly grant: CohortGrantV1;
	readonly cohortGrantSha256: Sha256Hex;
	readonly cohortGrantSignatureSha256: Sha256Hex;
}

export type FanoutServerReadyResult = FanoutChildFrame<ServerReadyV1>;
export type FanoutWarmupDrainedResult = FanoutChildFrame<ServerWarmupDrainedV1>;
export type FanoutMeasureStartAckResultV1 =
	FanoutChildFrame<ServerMeasureStartAckV1>;
export type FanoutBarrierAcceptanceResult =
	FanoutChildFrame<ServerStartBarrierAcceptedV1>;

export interface FanoutRelayObservationResult {
	readonly observation: LinuxRelayObservationV1;
	readonly observationBytes: Uint8Array;
	readonly observationSha256: Sha256Hex;
	readonly faults: readonly FanoutRelayFaultV1[];
}

export interface FanoutLoopSnapshotResult {
	readonly snapshot: ServerLoopUtilizationFrameV1;
	readonly snapshotBytes: Uint8Array;
	readonly snapshotSha256: Sha256Hex;
}

/** §5 `LINUX_CAPTURE`: the observation and the snapshot, as one frame. */
export interface FanoutCaptureAckResult
	extends FanoutChildFrame<ServerCaptureAckV1> {
	readonly observation: FanoutRelayObservationResult;
	readonly snapshot: FanoutLoopSnapshotResult;
}

/** The three cohort fields any rig server-snapshot receipt must be stamped with. */
export interface FanoutSnapshotBindingV1 {
	readonly cohortGrantSha256: Sha256Hex;
	readonly cohortStartBarrierSha256: Sha256Hex;
	readonly roleTokenCommitmentRootSha256: Sha256Hex;
}

/**
 * The Linux side of one cohort: it verifies what the Mac signed, moves the
 * relay only as far as that authorisation reaches, and answers each authorised
 * step with a §3.4 frame stating what it observed. `LinuxRelayObservationV1` is
 * the single authority for registration, ingress, capacity and faults -- the
 * projection takes no counts from any caller, only the server child's own
 * identity, so there is no argument through which a controller could state a
 * number the relay did not observe.
 *
 * It signs nothing. Under round three's authority ruling (design §1.1) the rig
 * supervisor process is the sole Linux signer; the frames below are the bytes
 * it receipts. The five rig records this class used to mint --
 * `rig-cohort-acceptance/v1`, `rig-warmup-drained-receipt/v1`,
 * `rig-measure-start-ack/v1`, `rig-barrier-acceptance/v1` and
 * `rig-relay-observation-receipt/v1` -- were a second implementation of records
 * `crates/native/src/secure_fs.rs` already mints, and none of them was ever the
 * authoritative one.
 *
 * The joins that used to live here went with them, to the place that can hold
 * them: `present_start_barrier` (`secure_fs.rs:16385-16412`) checks the
 * barrier's four retained-record bindings before it hands the barrier to the
 * child at `:16424`. Repeating those checks here would mean checking digests a
 * caller stated, which is the opinion this side must not have.
 */
export class FanoutLinuxAuthority {
	readonly config: FanoutLinuxAuthorityConfig;

	private stageValue: FanoutLinuxAuthorityStage = "unbound";
	private grantValue: CohortGrantV1 | null = null;
	private grantSha256Value: Sha256Hex | null = null;
	private grantSignatureSha256Value: Sha256Hex | null = null;
	private relayValue: FanoutRelay | null = null;
	private warmupEpochValue: CohortWarmupEpochV1 | null = null;
	private warmupWireProvenValue = false;
	private warmupEpochSha256Value: Sha256Hex | null = null;
	private warmupEpochSignatureSha256Value: Sha256Hex | null = null;
	private roleWarmupManifestSha256Value: Sha256Hex | null = null;
	private startBarrierSha256Value: Sha256Hex | null = null;
	private startBarrierAcceptedAtNsValue: NsString | null = null;
	private subscriberWarmupEndCountValue = 0;
	private baselineBusyMsValue: number | null = null;
	private baselineAtLinuxNsValue: NsString | null = null;
	private observationEmitted = false;
	private snapshotEmitted = false;

	constructor(config: FanoutLinuxAuthorityConfig) {
		this.config = config;
	}

	get stage(): FanoutLinuxAuthorityStage {
		return this.stageValue;
	}

	get grant(): CohortGrantV1 | null {
		return this.grantValue;
	}

	get cohortGrantSha256(): Sha256Hex | null {
		return this.grantSha256Value;
	}

	/** The relay, once a verified grant has produced one. */
	get relay(): FanoutRelay | null {
		return this.relayValue;
	}

	/**
	 * The relay a transport peer may serve. Refusing here and not only in
	 * `startServer` is deliberate: binding a socket is the execution point, and
	 * an unauthorised cohort must not reach it by any path.
	 */
	relayForServe(): ProtocolResult<FanoutRelay> {
		if (this.relayValue === null) {
			return relayFail(
				COHORT_NOT_READY_FAILURE_CODE,
				"no relay may be served before a signed cohort grant is accepted",
			);
		}
		return { ok: true, value: this.relayValue };
	}

	/**
	 * Read the server loop's busy time, in whole milliseconds.
	 *
	 * There is no default: an unconfigured observer refuses rather than
	 * reporting a zero that would read as a measurement, and a fractional
	 * reading refuses here rather than at the rig's `as_u64`, where nothing can
	 * say which of the three busy fields was wrong.
	 */
	private readBusyMs(): ProtocolResult<number> {
		const observer = this.config.loop;
		if (observer === undefined) {
			return relayFail(
				COHORT_NOT_READY_FAILURE_CODE,
				"no server loop observer is configured, so no honest busy reading can be stated",
			);
		}
		const busyMs = observer.busyMs();
		if (!isNonNegInt(busyMs)) {
			return relayFail(
				COHORT_PROTOCOL_FAILURE_CODE,
				`the server loop reported ${busyMs} busy ms, which is not a whole non-negative millisecond count`,
			);
		}
		return { ok: true, value: busyMs };
	}

	// -- 1. cohort grant ----------------------------------------------------

	/**
	 * The first gate. No server binds, no relay exists, and no token can be
	 * spent until the exact grant bytes carry a valid Mac signature from the
	 * staged key inside its validity window.
	 */
	acceptCohortGrant(args: {
		readonly grant: unknown;
		readonly signature: unknown;
		readonly nowMs: number;
	}): ProtocolResult<FanoutCohortAcceptance> {
		if (this.stageValue !== "unbound") {
			return relayFail(
				COHORT_PROTOCOL_FAILURE_CODE,
				`a cohort grant was already accepted at stage ${this.stageValue}`,
			);
		}
		const verified = requireCohortGrantSignatureBeforeRigAction({
			grant: args.grant,
			signature: args.signature,
			stagedMacPublicRaw32: this.config.stagedMacPublicRaw32,
			nowMs: args.nowMs,
		});
		if (!verified.ok) return verified;
		const grant = verified.value;
		if (grant.executionSha256 !== this.config.executionSha256) {
			return relayFail(
				COHORT_PROTOCOL_FAILURE_CODE,
				"cohort grant names another execution",
			);
		}
		if (grant.transport !== this.config.transport) {
			return relayFail(
				COHORT_PROTOCOL_FAILURE_CODE,
				`cohort grant is for ${grant.transport}, this server is ${this.config.transport}`,
			);
		}
		const signature = parseMacReceiptSignature(args.signature);
		if (!signature.ok) return signature;
		const grantBytes = cohortGrantBytes(grant);

		this.grantValue = grant;
		this.grantSha256Value = sha256HexOfBytes(grantBytes);
		this.grantSignatureSha256Value = sha256HexOfBytes(
			bytesOfCanonical(signature.value),
		);
		this.stageValue = "grant-accepted";
		return {
			ok: true,
			value: {
				grant,
				cohortGrantSha256: this.grantSha256Value,
				cohortGrantSignatureSha256: this.grantSignatureSha256Value,
			},
		};
	}

	/** The signature digest this side retained, once a grant was accepted. */
	get cohortGrantSignatureSha256(): Sha256Hex | null {
		return this.grantSignatureSha256Value;
	}

	// -- 2. server readiness ------------------------------------------------

	/**
	 * Build the relay from the accepted grant and nothing else. Publishers,
	 * shards, the commitment root, the window count and the message size all
	 * come from the signed record, so a token outside the accepted cohort has
	 * no root to open and a role outside it has no shard to claim.
	 */
	startServer(): ProtocolResult<FanoutRelay> {
		if (this.stageValue !== "grant-accepted") {
			return relayFail(
				COHORT_NOT_READY_FAILURE_CODE,
				`the server cannot become ready at stage ${this.stageValue}`,
			);
		}
		const grant = this.grantValue as CohortGrantV1;
		const identity = this.config.serverIdentity;
		if (
			!isNonNegInt(identity.serverChildPid) ||
			!isNonNegInt(identity.serverChildPgid) ||
			!isHex64(identity.serverChildInstanceNonce)
		) {
			return relayFail(
				COHORT_NOT_READY_FAILURE_CODE,
				"server child identity is not a pid/pgid/nonce triple",
			);
		}
		const windowCount = (grant.measuredDurationMs / grant.sampleWindowMs) as
			| 10
			| 30;
		if (!COHORT_WINDOW_COUNT_VALUES.includes(windowCount)) {
			return relayFail(
				COHORT_PROTOCOL_FAILURE_CODE,
				`grant schedule yields ${windowCount} windows`,
			);
		}
		const expectedSubscriberIds: string[] = [];
		for (let index = 0; index < grant.subscriberCount; index += 1) {
			expectedSubscriberIds.push(fanoutRoleId("subscriber", index));
		}
		const relay = new FanoutRelay({
			transport: grant.transport,
			cohortId: grant.cohortId,
			cohortGrantSha256: this.grantSha256Value as Sha256Hex,
			// Neither record exists yet; the relay refuses the transition each
			// one authorises until its signed bytes arrive.
			cohortWarmupEpochSha256: FANOUT_RELAY_UNBOUND_DIGEST,
			warmupNonce: FANOUT_RELAY_UNBOUND_DIGEST,
			cohortStartBarrierSha256: FANOUT_RELAY_UNBOUND_DIGEST,
			roleTokenCommitmentRootSha256: grant.roleTokenCommitmentRootSha256,
			roleTokenCommitmentCount: grant.roleTokenCommitmentCount,
			publishers: grant.publishers,
			subscriberShards: grant.subscriberShards,
			expectedSubscriberIds,
			windowCount,
			messageBytes: grant.messageBytes,
			linuxClockId: this.config.linuxClockId,
			clock: this.config.clock,
			...(this.config.caps ? { caps: this.config.caps } : {}),
		});
		this.relayValue = relay;
		this.stageValue = "server-ready";
		return { ok: true, value: relay };
	}

	/**
	 * §5 `SERVER_READY`, hand-off C->R 0: the child says it bound, on which
	 * address, and under which grant.
	 *
	 * The pid, pgid and instance nonce are the child's own -- configuration,
	 * not arguments -- so the rig can check them against the process it forked
	 * (`secure_fs.rs:16740-16749` does exactly that for the snapshot frame).
	 * The listening address is the caller's because only the listener knows it,
	 * and it is the one fact on this frame the rig cannot check.
	 */
	serverReady(args: {
		readonly sequence: number;
		readonly listeningAddress: string;
	}): ProtocolResult<FanoutServerReadyResult> {
		if (this.stageValue !== "server-ready") {
			return relayFail(
				COHORT_NOT_READY_FAILURE_CODE,
				`no server-ready frame exists at stage ${this.stageValue}`,
			);
		}
		if (args.listeningAddress.length === 0) {
			return relayFail(
				COHORT_NOT_READY_FAILURE_CODE,
				"a bound server states the address it bound",
			);
		}
		const identity = this.config.serverIdentity;
		const built = childFrame(
			COHORT_NOT_READY_FAILURE_CODE,
			buildServerReady({
				sequence: args.sequence,
				executionSha256: this.config.executionSha256,
				childPid: identity.serverChildPid,
				childPgid: identity.serverChildPgid,
				childInstanceNonce: identity.serverChildInstanceNonce,
				cohortGrantSha256: this.grantSha256Value,
				listeningAddress: args.listeningAddress,
			}),
		);
		if (!built.ok) return built;
		return this.childFrameResult(COHORT_NOT_READY_FAILURE_CODE, built.value);
	}

	/** One §3.4 frame, its canonical bytes and their digest, capped. */
	private childFrameResult<T>(
		code: string,
		frame: T,
	): ProtocolResult<FanoutChildFrame<T>> {
		const capped = withinChildFrameCap(code, frame);
		if (!capped.ok) return capped;
		return {
			ok: true,
			value: {
				frame,
				frameBytes: capped.value.bytes,
				frameSha256: sha256HexOfBytes(capped.value.bytes),
			},
		};
	}

	// -- 3. ramp and ready --------------------------------------------------

	/**
	 * §5 step 6 (`RAMP_AND_READY`): admit the role peers the Mac's permit
	 * schedule released, and no others.
	 *
	 * The ordinal is what ties a socket to a permit. `resolveGlobalOrdinal` is
	 * the one implementation of the ordinal-to-role map, so a peer that claims
	 * an ordinal belonging to another role, an ordinal outside the accepted
	 * cohort's domain, or an ordinal twice is refused before its register frame
	 * is ever handed to the relay. The order is the schedule's own -- ascending
	 * ordinal, which by that map means every subscriber before any publisher --
	 * so a cohort cannot be brought up publishers-first and still be admitted.
	 *
	 * The token itself is validated where it always is: by the relay, against
	 * the commitment root inside the signed grant. This method adds the permit
	 * dimension the relay has no way to see, and takes nothing else on trust.
	 */
	registerRolePeers(args: {
		readonly peers: readonly FanoutRolePeerAdmissionV1[];
	}): ProtocolResult<FanoutRolePeerRegistrationResultV1> {
		if (this.stageValue !== "server-ready") {
			return relayFail(
				COHORT_NOT_READY_FAILURE_CODE,
				`no role peer may register at stage ${this.stageValue}`,
			);
		}
		const grant = this.grantValue as CohortGrantV1;
		const relay = this.relayValue as FanoutRelay;
		const expected = grant.subscriberCount + grant.publishers.length;
		if (args.peers.length !== expected) {
			return relayFail(
				COHORT_NOT_READY_FAILURE_CODE,
				`${args.peers.length} role peers offered, the grant names ${expected}`,
			);
		}
		// Pass one settles the permit dimension without touching the relay, so a
		// cohort refused for its ordinals leaves no half-opened sessions behind
		// and the caller can offer a corrected one.
		const owners: {
			readonly role: "publisher" | "subscriber";
			readonly roleId: string;
		}[] = [];
		const seen = new Set<number>();
		let previousOrdinal = -1;
		for (const peer of args.peers) {
			const resolved = resolveGlobalOrdinal({
				globalOrdinal: peer.globalOrdinal,
				publisherCount: grant.publishers.length,
				subscriberCount: grant.subscriberCount,
			});
			if (!resolved.ok) return resolved;
			if (seen.has(peer.globalOrdinal)) {
				return relayFail(
					COHORT_NOT_READY_FAILURE_CODE,
					`ordinal ${peer.globalOrdinal} was offered twice`,
				);
			}
			if (peer.globalOrdinal <= previousOrdinal) {
				return relayFail(
					COHORT_NOT_READY_FAILURE_CODE,
					`ordinal ${peer.globalOrdinal} is out of permit order after ${previousOrdinal}`,
				);
			}
			seen.add(peer.globalOrdinal);
			previousOrdinal = peer.globalOrdinal;

			const claim = peer.register;
			if (
				typeof claim !== "object" ||
				claim === null ||
				(claim as { readonly roleId?: unknown }).roleId !==
					resolved.value.roleId
			) {
				return relayFail(
					COHORT_NOT_READY_FAILURE_CODE,
					`ordinal ${peer.globalOrdinal} belongs to ${resolved.value.roleId}`,
				);
			}
			owners.push({ role: resolved.value.role, roleId: resolved.value.roleId });
		}

		// Pass two spends the tokens. A refusal here is a token refusal, which
		// under §5 kills the whole cohort rather than being retried in place.
		const registered: FanoutRolePeerRegistrationV1[] = [];
		let publisherCount = 0;
		let subscriberCount = 0;
		for (const [index, peer] of args.peers.entries()) {
			const owner = owners[index] as {
				readonly role: "publisher" | "subscriber";
				readonly roleId: string;
			};
			const sessionId = relay.openSession(peer.sink);
			const admitted = relay.handleInbound(sessionId, peer.register);
			if (!admitted.ok) {
				relay.closeSession(sessionId, "registration refused");
				return admitted;
			}
			if (owner.role === "publisher") publisherCount += 1;
			else subscriberCount += 1;
			registered.push({
				globalOrdinal: peer.globalOrdinal,
				role: owner.role,
				roleId: owner.roleId,
				sessionId,
			});
		}
		const admitted = this.admissionVerdict();
		if (!admitted.ok) return admitted;
		this.stageValue = "roles-registered";
		return {
			ok: true,
			value: {
				registered,
				registeredPublisherCount: publisherCount,
				registeredSubscriberCount: subscriberCount,
			},
		};
	}

	/**
	 * §5 step 6 (`RAMP_AND_READY`) on the production serve path: the cohort came
	 * up on the wire, one peer at a time, not through `registerRolePeers`.
	 *
	 * `serveFanoutCohortRelay` (`server.ts:791`) hands the transport peers the
	 * relay alone; the ws peer calls `relay.openSession(sink)` (`server.ts:434`)
	 * and `relay.handleInboundBytes(...)` (`server.ts:442`) per socket, so every
	 * token spend, Merkle proof, shard check and `accept` emission has already
	 * happened per peer -- which is what §1.2's `RAMP_AND_READY` row assigns to
	 * the server child's data plane. What is left for the authority is the one
	 * thing no single register frame can decide: that the cohort is now complete
	 * and exact. That is `admissionVerdict`, shared with `registerRolePeers` so
	 * the two entry paths cannot diverge.
	 *
	 * The permit-ordinal dimension `registerRolePeers` adds is not weakened by
	 * this: on the production path the ordinal schedule is the Mac's, because the
	 * controller<->rig registry has no role-peer registration frame at all
	 * (`bin/compare-controller.ts:4004-4011`), and a child that withheld its
	 * `accept` frames until the whole cohort arrived would deadlock that
	 * scheduler (`bin/fanout-role.ts:1136` awaits accept before it sends
	 * `connect-permit-complete/v1`).
	 */
	admitWireRegisteredCohort(): ProtocolResult<FanoutRolePeerRegistrationResultV1> {
		const admitted = this.admissionVerdict();
		if (!admitted.ok) return admitted;
		this.stageValue = "roles-registered";
		return {
			ok: true,
			value: {
				// No ordinal and no session ID is claimed: the wire path never saw a
				// permit ordinal, and inventing one would fabricate a binding.
				registered: [],
				registeredPublisherCount: admitted.value.publisherIds.length,
				registeredSubscriberCount: admitted.value.subscriberIds.length,
			},
		};
	}

	/**
	 * The single admission rule both registration paths satisfy before the stage
	 * may advance to `roles-registered`.
	 *
	 * Every per-peer property is already the relay's: a replayed token is refused
	 * (`:694`), a role ID outside the grant is refused (`:701`, `:709`), a wrong
	 * shard residue or commitment range is refused (`:712-722`), and a role ID
	 * cannot hold two live sessions (`:693`). The whole-cohort properties are the
	 * residue: exact counts, an exact ID set both ways -- which is the exact shard
	 * union, each subscriber ID's residue having been pinned at registration --
	 * and exactly one spent token per admitted peer.
	 *
	 * Only the two count checks are reachable from the wire today: because the
	 * relay admits no role ID outside the grant and no ID twice, exact counts
	 * imply the exact ID set and the exact token spend. The set and ledger checks
	 * are kept because that implication is the relay's, not this method's, and a
	 * later relay change that loosened it would otherwise widen admission
	 * silently.
	 */
	private admissionVerdict(): ProtocolResult<{
		readonly publisherIds: readonly string[];
		readonly subscriberIds: readonly string[];
	}> {
		if (this.stageValue !== "server-ready") {
			return relayFail(
				COHORT_NOT_READY_FAILURE_CODE,
				`no cohort may be admitted at stage ${this.stageValue}`,
			);
		}
		const grant = this.grantValue as CohortGrantV1;
		const relay = this.relayValue as FanoutRelay;
		const counters = relay.counters();
		const publisherIds = counters.registeredPublisherIds;
		const subscriberIds = counters.registeredSubscriberIds;
		if (publisherIds.length !== grant.publishers.length) {
			return relayFail(
				COHORT_NOT_READY_FAILURE_CODE,
				`${publisherIds.length} publishers registered, the grant names ${grant.publishers.length}`,
			);
		}
		if (subscriberIds.length !== grant.subscriberCount) {
			return relayFail(
				COHORT_NOT_READY_FAILURE_CODE,
				`${subscriberIds.length} subscribers registered, the grant names ${grant.subscriberCount}`,
			);
		}
		const registeredPublishers = new Set(publisherIds);
		for (const publisher of grant.publishers) {
			if (!registeredPublishers.has(publisher.publisherId)) {
				return relayFail(
					COHORT_NOT_READY_FAILURE_CODE,
					`publisher ${publisher.publisherId} never registered`,
				);
			}
		}
		const registeredSubscribers = new Set(subscriberIds);
		for (const subscriberId of relay.expectedSubscriberIds()) {
			if (!registeredSubscribers.has(subscriberId)) {
				return relayFail(
					COHORT_NOT_READY_FAILURE_CODE,
					`subscriber ${subscriberId} never registered`,
				);
			}
		}
		const expectedSpend = grant.publishers.length + grant.subscriberCount;
		const spent = relay.spentTokenCount();
		if (spent !== expectedSpend) {
			return relayFail(
				COHORT_NOT_READY_FAILURE_CODE,
				`${spent} role tokens spent, the cohort admits ${expectedSpend}`,
			);
		}
		return { ok: true, value: { publisherIds, subscriberIds } };
	}

	// -- 4. warmup epoch ----------------------------------------------------

	/**
	 * The signed warmup epoch is what opens the warmup phase. Its digest is
	 * recomputed from the bytes the signature covers, never taken from a field
	 * beside them, and the epoch must name the grant this server accepted.
	 */
	acceptWarmupEpoch(args: {
		readonly epoch: unknown;
		readonly signature: unknown;
		readonly nowMs: number;
	}): ProtocolResult<{
		readonly epoch: CohortWarmupEpochV1;
		readonly cohortWarmupEpochSha256: Sha256Hex;
	}> {
		if (this.stageValue !== "roles-registered") {
			return relayFail(
				WARMUP_PROTOCOL_FAILURE_CODE,
				`no warmup epoch may be accepted at stage ${this.stageValue}`,
			);
		}
		const epoch = parseCohortWarmupEpoch(args.epoch);
		if (!epoch.ok) return epoch;
		const signature = parseMacReceiptSignature(args.signature);
		if (!signature.ok) {
			return relayFail(
				WARMUP_PROTOCOL_FAILURE_CODE,
				"warmup epoch presented without a Mac signature",
			);
		}
		if (signature.value.signedSchema !== "cohort-warmup-epoch/v1") {
			return relayFail(
				WARMUP_PROTOCOL_FAILURE_CODE,
				`signature covers ${signature.value.signedSchema}, not cohort-warmup-epoch/v1`,
			);
		}
		const epochBytes = bytesOfCanonical(epoch.value);
		const verified = verifyMacReceiptSignature({
			stagedMacPublicRaw32: this.config.stagedMacPublicRaw32,
			signedBytes: epochBytes,
			signature: signature.value,
		});
		if (!verified.ok) return verified;
		if (args.nowMs > epoch.value.notAfterMs) {
			return relayFail(
				WARMUP_PROTOCOL_FAILURE_CODE,
				"warmup epoch validity window closed",
			);
		}
		if (epoch.value.cohortGrantSha256 !== this.grantSha256Value) {
			return relayFail(
				WARMUP_PROTOCOL_FAILURE_CODE,
				"warmup epoch names another cohort grant",
			);
		}
		if (epoch.value.executionSha256 !== this.config.executionSha256) {
			return relayFail(
				WARMUP_PROTOCOL_FAILURE_CODE,
				"warmup epoch names another execution",
			);
		}
		if (epoch.value.cohortId !== (this.grantValue as CohortGrantV1).cohortId) {
			return relayFail(
				WARMUP_PROTOCOL_FAILURE_CODE,
				"warmup epoch names another cohort",
			);
		}
		const relay = this.relayValue as FanoutRelay;
		const epochSha256 = sha256HexOfBytes(epochBytes);
		const bound = relay.bindWarmupEpoch({
			cohortWarmupEpochSha256: epochSha256,
			warmupNonce: epoch.value.warmupNonce,
		});
		if (!bound.ok) return bound;
		const closed = relay.closeRegistration();
		if (!closed.ok) return closed;
		this.warmupEpochSha256Value = epochSha256;
		this.warmupEpochValue = epoch.value;
		this.warmupEpochSignatureSha256Value = sha256HexOfBytes(
			bytesOfCanonical(signature.value),
		);
		this.stageValue = "warmup-open";
		return {
			ok: true,
			value: { epoch: epoch.value, cohortWarmupEpochSha256: epochSha256 },
		};
	}

	// -- 5. warmup wire -----------------------------------------------------

	/**
	 * §5 step 7: prove the warmup wire against the epoch the Mac signed.
	 *
	 * The relay's own drain already checks that warmup was internally coherent
	 * -- every end marker in, queues empty, deliveries equal to ingress times
	 * subscribers. What it cannot check is whether that shape is the one the Mac
	 * authorised, because the epoch is not one of its inputs. This is that
	 * check, and it is per-role rather than in totals: every publisher offered
	 * exactly `warmupMessagesPerPublisher` frames, and every subscriber worker
	 * proves its own expanded delivery count. Two publishers offering five and
	 * fifteen sum to the right total and are refused here.
	 */
	runWarmupWire(): ProtocolResult<FanoutWarmupWireResultV1> {
		if (this.stageValue !== "warmup-open") {
			return relayFail(
				WARMUP_PROTOCOL_FAILURE_CODE,
				`no warmup wire may be proven at stage ${this.stageValue}`,
			);
		}
		const relay = this.relayValue as FanoutRelay;
		const epoch = this.warmupEpochValue as CohortWarmupEpochV1;
		relay.pump();
		const counters = relay.counters();
		const wire = relay.warmupWireCounts();
		const publisherIds = counters.registeredPublisherIds;
		const subscriberIds = counters.registeredSubscriberIds;

		if (counters.warmupPublisherEndCount !== publisherIds.length) {
			return relayFail(
				WARMUP_PROTOCOL_FAILURE_CODE,
				`${counters.warmupPublisherEndCount} warmup end markers for ${publisherIds.length} publishers`,
			);
		}
		for (const publisherId of publisherIds) {
			const offered = wire.offersByPublisherId.get(publisherId) ?? 0;
			if (offered !== epoch.warmupMessagesPerPublisher) {
				return relayFail(
					WARMUP_PROTOCOL_FAILURE_CODE,
					`${publisherId} offered ${offered} warmup frames, the epoch names ${epoch.warmupMessagesPerPublisher}`,
				);
			}
		}
		for (const subscriberId of subscriberIds) {
			const delivered = wire.deliveriesBySubscriberId.get(subscriberId) ?? 0;
			if (delivered !== counters.warmupIngress) {
				return relayFail(
					WARMUP_PROTOCOL_FAILURE_CODE,
					`${subscriberId} was expanded to ${delivered} of ${counters.warmupIngress} warmup records`,
				);
			}
		}
		if (counters.warmupIngress !== epoch.expectedWarmupIngress) {
			return relayFail(
				WARMUP_PROTOCOL_FAILURE_CODE,
				`warmup ingress ${counters.warmupIngress} != epoch ${epoch.expectedWarmupIngress}`,
			);
		}
		if (counters.warmupDeliveries !== epoch.expectedWarmupDeliveries) {
			return relayFail(
				WARMUP_PROTOCOL_FAILURE_CODE,
				`warmup deliveries ${counters.warmupDeliveries} != epoch ${epoch.expectedWarmupDeliveries}`,
			);
		}
		this.warmupWireProvenValue = true;
		return {
			ok: true,
			value: {
				warmupIngress: counters.warmupIngress,
				warmupDeliveries: counters.warmupDeliveries,
				warmupMessagesPerPublisher: epoch.warmupMessagesPerPublisher,
				offersByPublisherId: wire.offersByPublisherId,
				deliveriesBySubscriberId: wire.deliveriesBySubscriberId,
			},
		};
	}

	/** Whether the warmup wire has been proven against the signed epoch. */
	get warmupWireProven(): boolean {
		return this.warmupWireProvenValue;
	}

	// -- 6. warmup drain ----------------------------------------------------

	/**
	 * §5 `IN_REPETITION_WARMUP`, hand-off C->R 2: drain the warmup and state
	 * what the relay observed while doing it.
	 *
	 * The manifest digest is the Mac's, carried in on
	 * `server-warmup-drain-and-reset/v1`; everything else on the frame is the
	 * relay's own reading. The rig binds these exact bytes into
	 * `rig-warmup-drained-receipt/v1` (`secure_fs.rs:15886`) and reads the two
	 * end counts back as its readiness invariant (§2.8,
	 * `mark_ready_from_linux`, `secure_fs.rs:16158-16174`), so a vacuous warmup
	 * is refused here rather than receipted there.
	 */
	drainWarmup(args: {
		readonly sequence: number;
		readonly roleWarmupCompletionManifestSha256: Sha256Hex;
	}): ProtocolResult<FanoutWarmupDrainedResult> {
		if (this.stageValue !== "warmup-open") {
			return relayFail(
				WARMUP_PROTOCOL_FAILURE_CODE,
				`no warmup may be drained at stage ${this.stageValue}`,
			);
		}
		// The drain resets every measured counter, so it is the last moment at
		// which the warmup wire can still be proven against the signed epoch.
		if (!this.warmupWireProvenValue) {
			return relayFail(
				WARMUP_PROTOCOL_FAILURE_CODE,
				"the warmup wire was not proven against the signed epoch before the drain",
			);
		}
		if (!isHex64(args.roleWarmupCompletionManifestSha256)) {
			return relayFail(
				WARMUP_PROTOCOL_FAILURE_CODE,
				"role warmup completion manifest digest is not retained",
			);
		}
		const relay = this.relayValue as FanoutRelay;
		const before = relay.counters();
		const drained = relay.drainWarmup();
		if (!drained.ok) return drained;
		this.subscriberWarmupEndCountValue = before.registeredSubscriberIds.length;
		// §4.1: a vacuous warmup proves nothing. Defence in depth rather than
		// the gate: `runWarmupWire` above already refused any cohort whose
		// ingress did not equal the signed epoch's, so this is unreachable
		// while that proof stands and is here so a later change to the proof
		// cannot make a zero drain reportable.
		if (
			drained.value.warmupIngress === 0 ||
			drained.value.warmupDeliveries === 0
		) {
			return relayFail(WARMUP_PROTOCOL_FAILURE_CODE, "warmup was vacuous");
		}

		const built = childFrame(
			WARMUP_PROTOCOL_FAILURE_CODE,
			buildServerWarmupDrained({
				sequence: args.sequence,
				executionSha256: this.config.executionSha256,
				cohortWarmupEpochSha256: this.warmupEpochSha256Value as Sha256Hex,
				roleWarmupCompletionManifestSha256:
					args.roleWarmupCompletionManifestSha256,
				warmupIngress: drained.value.warmupIngress,
				warmupDeliveries: drained.value.warmupDeliveries,
				publisherWarmupEndCount: before.warmupPublisherEndCount,
				subscriberWarmupEndCount: this.subscriberWarmupEndCountValue,
				drainedAtLinuxNs: drained.value.drainedAtLinuxNs,
				linuxClockId: this.config.linuxClockId,
			}),
		);
		if (!built.ok) return built;
		const framed = this.childFrameResult(
			WARMUP_PROTOCOL_FAILURE_CODE,
			built.value,
		);
		if (!framed.ok) return framed;
		this.roleWarmupManifestSha256Value =
			args.roleWarmupCompletionManifestSha256;
		this.stageValue = "warmup-drained";
		return framed;
	}

	// -- 7. linux baseline --------------------------------------------------

	/**
	 * §5 `LINUX_BASELINE`, hand-off C->R 3: the busy-loop baseline no measured
	 * traffic may precede.
	 *
	 * The child states two numbers it read and nothing else. The rig binds them
	 * verbatim into `rig-measure-start-ack/v1` (`secure_fs.rs:16147-16149`),
	 * which is the record `rig-measure-start-request/v1` carries north; the
	 * digests that ack also names -- the measurement grant, the Mac execution
	 * grant receipt, the rig execution acceptance -- are the rig's own bindings
	 * and were never the child's to state.
	 *
	 * The baseline is retained because the snapshot frame at capture has to
	 * subtract *this* reading, not a second read of the same loop.
	 */
	measureStartAck(args: {
		readonly sequence: number;
	}): ProtocolResult<FanoutMeasureStartAckResultV1> {
		if (this.stageValue !== "warmup-drained") {
			return relayFail(
				COHORT_NOT_READY_FAILURE_CODE,
				`no Linux baseline exists at stage ${this.stageValue}`,
			);
		}
		if (this.baselineBusyMsValue !== null) {
			return relayFail(
				COHORT_PROTOCOL_FAILURE_CODE,
				"the Linux baseline is taken exactly once",
			);
		}
		// The observer first: a missing one is the placeholder-evidence refusal
		// this method exists for, and it is the more useful thing to be told.
		const busyMs = this.readBusyMs();
		if (!busyMs.ok) return busyMs;
		if (!isHex64(this.config.linuxClockId)) {
			return relayFail(
				COHORT_PROTOCOL_FAILURE_CODE,
				"the measure-start ack requires a digest-shaped linuxClockId",
			);
		}
		const baselineAtLinuxNs = this.config.clock.nowNs();
		const built = childFrame(
			COHORT_NOT_READY_FAILURE_CODE,
			buildServerMeasureStartAck({
				sequence: args.sequence,
				executionSha256: this.config.executionSha256,
				baselineBusyMs: busyMs.value,
				baselineAtLinuxNs,
				linuxClockId: this.config.linuxClockId,
			}),
		);
		if (!built.ok) return built;
		const framed = this.childFrameResult(
			COHORT_NOT_READY_FAILURE_CODE,
			built.value,
		);
		if (!framed.ok) return framed;
		this.baselineBusyMsValue = busyMs.value;
		this.baselineAtLinuxNsValue = baselineAtLinuxNs;
		return framed;
	}

	// -- 8. start barrier ---------------------------------------------------

	/**
	 * §5 `START_BARRIER`, hand-off C->R 4: the last gate before measured
	 * traffic.
	 *
	 * The barrier's Mac signature is verified over its exact bytes and it must
	 * name this execution and the grant this server accepted; only then does
	 * the relay leave `warmup-drained`.
	 *
	 * It does **not** re-check the barrier's four retained-record bindings. The
	 * rig holds those records and checks all four before it hands the barrier
	 * down the pipe (`crates/native/src/secure_fs.rs:16385-16412`, then
	 * `:16424`); a child re-check would be a check of digests some caller
	 * stated, which is exactly the opinion this side must not have.
	 */
	acceptStartBarrier(args: {
		readonly barrier: unknown;
		readonly signature: unknown;
		readonly sequence: number;
		readonly nowMs: number;
	}): ProtocolResult<FanoutBarrierAcceptanceResult> {
		if (this.stageValue !== "warmup-drained") {
			return relayFail(
				COHORT_NOT_READY_FAILURE_CODE,
				`no start barrier may be accepted at stage ${this.stageValue}`,
			);
		}
		const barrier = parseCohortStartBarrier(args.barrier);
		if (!barrier.ok) return barrier;
		const signature = parseMacReceiptSignature(args.signature);
		if (!signature.ok) {
			return relayFail(
				COHORT_NOT_READY_FAILURE_CODE,
				"start barrier presented without a Mac signature",
			);
		}
		if (signature.value.signedSchema !== "cohort-start-barrier/v1") {
			return relayFail(
				COHORT_NOT_READY_FAILURE_CODE,
				`signature covers ${signature.value.signedSchema}, not cohort-start-barrier/v1`,
			);
		}
		const barrierBytes = bytesOfCanonical(barrier.value);
		const verified = verifyMacReceiptSignature({
			stagedMacPublicRaw32: this.config.stagedMacPublicRaw32,
			signedBytes: barrierBytes,
			signature: signature.value,
		});
		if (!verified.ok) return verified;
		if (args.nowMs > barrier.value.notAfterMs) {
			return relayFail(
				COHORT_NOT_READY_FAILURE_CODE,
				"start barrier validity window closed",
			);
		}
		if (barrier.value.cohortGrantSha256 !== this.grantSha256Value) {
			return relayFail(
				COHORT_NOT_READY_FAILURE_CODE,
				"start barrier names another cohort grant",
			);
		}
		if (barrier.value.executionSha256 !== this.config.executionSha256) {
			return relayFail(
				COHORT_NOT_READY_FAILURE_CODE,
				"start barrier names another execution",
			);
		}

		const relay = this.relayValue as FanoutRelay;
		const barrierSha256 = sha256HexOfBytes(barrierBytes);
		const bound = relay.bindStartBarrier({
			cohortStartBarrierSha256: barrierSha256,
		});
		if (!bound.ok) return bound;

		const acceptedAtLinuxNs = this.config.clock.nowNs();
		const built = childFrame(
			COHORT_NOT_READY_FAILURE_CODE,
			buildServerStartBarrierAccepted({
				sequence: args.sequence,
				executionSha256: this.config.executionSha256,
				cohortStartBarrierSha256: barrierSha256,
				acceptedAtLinuxNs,
				linuxClockId: this.config.linuxClockId,
			}),
		);
		if (!built.ok) return built;
		const framed = this.childFrameResult(
			COHORT_NOT_READY_FAILURE_CODE,
			built.value,
		);
		if (!framed.ok) return framed;
		// The relay's own measured-traffic gate. It is armed from the barrier
		// digest this side verified, not from a rig record, because the rig's
		// acceptance does not exist yet at this point in the pipe.
		const armed = relay.openMeasuredWindow({
			cohortStartBarrierSha256: barrierSha256,
		});
		if (!armed.ok) return armed;

		this.startBarrierSha256Value = barrierSha256;
		this.startBarrierAcceptedAtNsValue = acceptedAtLinuxNs;
		this.stageValue = "barrier-accepted";
		return framed;
	}

	// -- 9. measured window and bounded drain -------------------------------

	/**
	 * §5 steps 10-12: close the measured window and drain what it left.
	 *
	 * The barrier is the gate rather than an argument: this refuses at any stage
	 * but `barrier-accepted`, which is only reachable through a Mac-signed
	 * barrier whose four retained-record bindings matched. Origin attribution is
	 * the relay's -- every delivery is charged to the window its ingress was
	 * accepted in, including deliveries that only complete during this drain --
	 * so stopping and draining cannot move a record between windows.
	 *
	 * The drain is bounded by progress and by the grant's own deadline, in that
	 * order: it pumps until the queues empty, and if a pump moves nothing while
	 * the deadline has passed it refuses instead of spinning. Nothing here
	 * sleeps, so the same code runs under a manual clock and a monotonic one.
	 */
	runMeasuredWindow(): ProtocolResult<FanoutMeasuredWindowResultV1> {
		if (this.stageValue !== "barrier-accepted") {
			return relayFail(
				COHORT_NOT_READY_FAILURE_CODE,
				`no measured window is open at stage ${this.stageValue}`,
			);
		}
		const relay = this.relayValue as FanoutRelay;
		const grant = this.grantValue as CohortGrantV1;
		const deadlineMs = this.config.clock.nowMs() + grant.drainDeadlineMs;

		relay.pump();
		const stopped = this.stopMeasurement();
		if (!stopped.ok) return stopped;

		for (;;) {
			const before = relay.counters();
			if (before.queuedItems === 0) break;
			relay.pump();
			const after = relay.counters();
			if (after.queuedItems === before.queuedItems) {
				if (this.config.clock.nowMs() < deadlineMs) {
					return relayFail(
						RELAY_DELIVERY_FAILURE_CODE,
						`the bounded drain stalled with ${after.queuedItems} records queued`,
					);
				}
				return relayFail(
					RELAY_DELIVERY_FAILURE_CODE,
					`${after.queuedItems} records were still queued at the drain deadline`,
				);
			}
		}

		const counters = relay.counters();
		const total = (values: readonly number[]): number =>
			values.reduce((sum, value) => sum + value, 0);
		return {
			ok: true,
			value: {
				acceptedIngressTotal: total(counters.acceptedIngressByOriginWindow),
				relayWritesCompletedTotal: total(
					counters.relayWritesCompletedByOriginWindow,
				),
				postStopRelayWrites: counters.postStopRelayWrites,
				drainedAtLinuxNs: this.config.clock.nowNs(),
				publisherEndCount: counters.publisherEndCount,
			},
		};
	}

	// -- 10. stop and observe -----------------------------------------------

	stopMeasurement(): ProtocolResult<true> {
		if (this.stageValue !== "barrier-accepted") {
			return relayFail(
				COHORT_PROTOCOL_FAILURE_CODE,
				`no measurement is running at stage ${this.stageValue}`,
			);
		}
		const stopped = (this.relayValue as FanoutRelay).stopMeasurement();
		if (!stopped.ok) return stopped;
		this.stageValue = "measurement-stopped";
		return { ok: true, value: true };
	}

	/**
	 * The cohort fields the rig must stamp into its server-snapshot receipt.
	 * They are read from what this side verified, so a snapshot receipt cannot
	 * name a cohort or a barrier the Linux server never accepted.
	 */
	snapshotBinding(): ProtocolResult<FanoutSnapshotBindingV1> {
		if (
			this.grantSha256Value === null ||
			this.startBarrierSha256Value === null
		) {
			return relayFail(
				COHORT_NOT_READY_FAILURE_CODE,
				"a snapshot cannot be bound before the grant and the barrier are accepted",
			);
		}
		return {
			ok: true,
			value: {
				cohortGrantSha256: this.grantSha256Value,
				cohortStartBarrierSha256: this.startBarrierSha256Value,
				roleTokenCommitmentRootSha256: (this.grantValue as CohortGrantV1)
					.roleTokenCommitmentRootSha256,
			},
		};
	}

	/**
	 * Shut the relay down and emit the single Linux observation, exactly once.
	 * The only inputs are the server child's identity: every registration,
	 * ingress, capacity and fault number in the record is the relay's own.
	 *
	 * Since the authority ruling this returns the record and its bytes and
	 * nothing else. `rig-relay-observation-receipt/v1` is the rig's, over these
	 * exact bytes, which is why the bytes are returned rather than left to be
	 * re-canonicalised by whoever wanted them (§1.3).
	 */
	observe(): ProtocolResult<FanoutRelayObservationResult> {
		if (this.observationEmitted) {
			return relayFail(
				COHORT_PROTOCOL_FAILURE_CODE,
				"the Linux relay observation is emitted exactly once",
			);
		}
		if (
			this.stageValue !== "barrier-accepted" &&
			this.stageValue !== "measurement-stopped"
		) {
			return relayFail(
				COHORT_NOT_READY_FAILURE_CODE,
				`no relay observation exists at stage ${this.stageValue}`,
			);
		}
		const relay = this.relayValue as FanoutRelay;
		const identity = this.config.serverIdentity;
		const faults = [...relay.promotionFaults()];
		const shutdown = relay.shutdown();
		if (!shutdown.ok) return shutdown;
		const observation = relay.buildLinuxRelayObservation({
			executionSha256: this.config.executionSha256,
			serverChildPid: identity.serverChildPid,
			serverChildPgid: identity.serverChildPgid,
			serverChildInstanceNonce: identity.serverChildInstanceNonce,
		});
		if (!observation.ok) return observation;
		// `parseLinuxRelayObservation` already enforced the 128 KiB cap.
		const observationBytes = bytesOfCanonical(observation.value);
		this.observationEmitted = true;
		this.stageValue = "observed";
		return {
			ok: true,
			value: {
				observation: observation.value,
				observationBytes,
				observationSha256: sha256HexOfBytes(observationBytes),
				faults,
			},
		};
	}

	/**
	 * The `server-loop-utilization/v1` frame (plan 1128-1152), built from what
	 * this side observed and from the signed grant it is running under.
	 *
	 * Nothing here is an argument. The execution identity -- cell, scenario
	 * hash, transport, repetition -- comes off `grant.execution`, which the Mac
	 * signed; the pid, pgid and nonce are the child's own; the two cohort
	 * digests are the ones this side verified; and the three busy numbers are
	 * two readings of the loop with their difference. That difference is
	 * re-derived by the rig (`crates/native/src/secure_fs.rs:16766-16773`), so
	 * a third independent number is not something the child could state even if
	 * it wanted to.
	 *
	 * `bulkSourceCompletion` is `null` because a fanout cohort runs no bulk
	 * source. That is a stated absence rather than a default: the field is
	 * `| null` in the frozen shape and the rig requires the key to be present
	 * (`secure_fs.rs:16783-16785`).
	 */
	loopUtilizationSnapshot(): ProtocolResult<FanoutLoopSnapshotResult> {
		if (this.snapshotEmitted) {
			return relayFail(
				COHORT_PROTOCOL_FAILURE_CODE,
				"the server loop snapshot is emitted exactly once",
			);
		}
		if (this.stageValue !== "observed") {
			return relayFail(
				COHORT_NOT_READY_FAILURE_CODE,
				`no server loop snapshot exists at stage ${this.stageValue}`,
			);
		}
		const baselineBusyMs = this.baselineBusyMsValue;
		const baselineAtLinuxNs = this.baselineAtLinuxNsValue;
		if (baselineBusyMs === null || baselineAtLinuxNs === null) {
			return relayFail(
				COHORT_NOT_READY_FAILURE_CODE,
				"no busy baseline was taken, so no busy window can be stated",
			);
		}
		const acceptedAtNs = this.startBarrierAcceptedAtNsValue;
		if (acceptedAtNs === null || this.startBarrierSha256Value === null) {
			return relayFail(
				COHORT_NOT_READY_FAILURE_CODE,
				"no start barrier was accepted, so no measured window was opened",
			);
		}
		const finalBusyMs = this.readBusyMs();
		if (!finalBusyMs.ok) return finalBusyMs;
		if (finalBusyMs.value < baselineBusyMs) {
			return relayFail(
				COHORT_PROTOCOL_FAILURE_CODE,
				`the server loop went backwards, from ${baselineBusyMs} to ${finalBusyMs.value} busy ms`,
			);
		}
		const finalSnapshotAtLinuxNs = this.config.clock.nowNs();
		const windowNs = BigInt(finalSnapshotAtLinuxNs) - BigInt(acceptedAtNs);
		if (windowNs <= 0n) {
			return relayFail(
				COHORT_PROTOCOL_FAILURE_CODE,
				"the measured window closed at or before it opened",
			);
		}
		// Whole milliseconds, rounded up, so a sub-millisecond window is 1 and
		// never the zero the rig refuses (`secure_fs.rs:16779-16781`).
		const windowMs = Number((windowNs + 999_999n) / 1_000_000n);
		const grant = this.grantValue as CohortGrantV1;
		const identity = this.config.serverIdentity;
		const snapshot = {
			schema: "server-loop-utilization/v1" as const,
			executionSha256: this.config.executionSha256,
			cellId: grant.execution.cellId,
			scenarioHash: grant.scenarioHash,
			cohortGrantSha256: this.grantSha256Value,
			cohortStartBarrierSha256: this.startBarrierSha256Value,
			roleTokenCommitmentRootSha256: grant.roleTokenCommitmentRootSha256,
			transport: grant.transport,
			repetitionKind: grant.execution.repetitionKind,
			repetitionIndex: grant.execution.repetitionIndex,
			repetitionTotal: grant.execution.repetitionTotal,
			childPid: identity.serverChildPid,
			childPgid: identity.serverChildPgid,
			childInstanceNonce: identity.serverChildInstanceNonce,
			baselineBusyMs,
			finalBusyMs: finalBusyMs.value,
			busyMs: finalBusyMs.value - baselineBusyMs,
			baselineAtLinuxNs,
			finalSnapshotAtLinuxNs,
			windowMs,
			linuxClockId: this.config.linuxClockId,
			allMeasuredSessionsClosed: true as const,
			bulkSourceCompletion: null,
		};
		// The shared codec is the authority on the shape; the projection is
		// validated rather than asserted, exactly as the relay observation is.
		if (!isServerLoopUtilizationFrameV1(snapshot)) {
			return relayFail(
				COHORT_PROTOCOL_FAILURE_CODE,
				"the server loop snapshot is not a server-loop-utilization/v1 frame",
			);
		}
		const snapshotBytes = bytesOfCanonical(snapshot);
		this.snapshotEmitted = true;
		return {
			ok: true,
			value: {
				snapshot,
				snapshotBytes,
				snapshotSha256: sha256HexOfBytes(snapshotBytes),
			},
		};
	}

	/**
	 * §5 `LINUX_CAPTURE`, hand-off C->R 5: both capture records, base64, in one
	 * frame.
	 *
	 * §1.3's registry edit is what makes this honest: the two records travel as
	 * base64 of the child's exact canonical bytes, so the rig digests what it
	 * received rather than a re-canonicalisation of fields it parsed. That is
	 * why the two byte arrays come from `observe()` and
	 * `loopUtilizationSnapshot()` rather than being rebuilt here.
	 */
	captureAck(args: {
		readonly sequence: number;
	}): ProtocolResult<FanoutCaptureAckResult> {
		const observation = this.observe();
		if (!observation.ok) return observation;
		const snapshot = this.loopUtilizationSnapshot();
		if (!snapshot.ok) return snapshot;
		const built = childFrame(
			COHORT_NOT_READY_FAILURE_CODE,
			buildServerCaptureAck({
				sequence: args.sequence,
				executionSha256: this.config.executionSha256,
				snapshotFrameBase64: Buffer.from(snapshot.value.snapshotBytes).toString(
					"base64",
				),
				linuxRelayObservationBase64: Buffer.from(
					observation.value.observationBytes,
				).toString("base64"),
			}),
		);
		if (!built.ok) return built;
		const bytes = bytesOfCanonical(built.value);
		if (bytes.byteLength > CHILD_PIPE_CONTROL_MAX_BYTES) {
			return relayFail(
				COHORT_NOT_READY_FAILURE_CODE,
				`server-capture-ack/v1 is ${bytes.byteLength} bytes`,
			);
		}
		return {
			ok: true,
			value: {
				frame: built.value,
				frameBytes: bytes,
				frameSha256: sha256HexOfBytes(bytes),
				observation: observation.value,
				snapshot: snapshot.value,
			},
		};
	}
}
