import { ByteBoundedQueue } from "../bounded-queue.ts";
import { canonicalJson, sha256Canonical } from "../canonical.ts";
import { CANONICAL_CAPACITY_PROFILE } from "../scenario-registry.ts";
import type { CapacityProfile } from "../types.ts";
import {
	ackFor,
	decodeWireMessage,
	encodeWireMessage,
	type WireMessage,
} from "../wire.ts";
import {
	type AdmissionCounters,
	type BidiChannel,
	type ClientConfig,
	type ClientSocketFactory,
	type ClientTlsOptions,
	type ClientWebSocketLike,
	type ClientWebSocketOptions,
	type DeliveryKind,
	type ReceiveChannel,
	type SendChannel,
	type SendObservation,
	type ServerConfig,
	type ServerHandle,
	type ServerWebSocketLike,
	type Session,
	type SubmittedCapacityProfile,
	systemTransportClock,
	type TransportAdapter,
	type TransportClock,
	type TransportMetrics,
	type WebSocketHandler,
	type WebSocketServerFactory,
	type WebSocketServerRuntime,
	type WebSocketServerRuntimeOptions,
	WebSocketTransportError,
	type WebSocketTransportErrorCode,
} from "./transport.ts";

// Keep the adapter independent from `bun` at module load time. This lets all
// unit tests use fakes and prevents a socket from being opened merely by
// importing the comparison tools.
const DEFAULT_FRAME_BYTES = 13;
const FRAME_MAGIC = 0x5753;
const FRAME_VERSION = 1;

export type WebSocketFrameKind =
	| "hello"
	| "hello-ack"
	| "message"
	| "text"
	| "open-uni"
	| "open-bidi"
	| "channel-data"
	| "channel-end"
	| "channel-cancel"
	| "ack";

export interface WebSocketFrame {
	readonly kind: WebSocketFrameKind;
	readonly channelId: number;
	readonly payload: Uint8Array;
	readonly deliveryKind?: DeliveryKind;
}

const FRAME_KIND_TO_CODE: Readonly<
	Record<Exclude<WebSocketFrameKind, "text">, number>
> = Object.freeze({
	hello: 1,
	"hello-ack": 2,
	message: 3,
	"open-uni": 4,
	"open-bidi": 5,
	"channel-data": 6,
	"channel-end": 7,
	"channel-cancel": 8,
	ack: 9,
});

const FRAME_CODE_TO_KIND: Readonly<
	Record<number, Exclude<WebSocketFrameKind, "text">>
> = Object.freeze(
	Object.fromEntries(
		Object.entries(FRAME_KIND_TO_CODE).map(([kind, code]) => [code, kind]),
	) as Record<number, Exclude<WebSocketFrameKind, "text">>,
);

const DELIVERY_KIND_TO_CODE: Readonly<Record<DeliveryKind, number>> =
	Object.freeze({ datagram: 1, "reliable-message": 2 });
const DELIVERY_CODE_TO_KIND: Readonly<Record<number, DeliveryKind>> =
	Object.freeze({ 1: "datagram", 2: "reliable-message" });

function bytesFromPayload(payload: Uint8Array | string): Uint8Array {
	if (typeof payload === "string") return new TextEncoder().encode(payload);
	return payload.slice();
}

function asUint8Array(value: unknown): Uint8Array | undefined {
	if (value instanceof Uint8Array) return value.slice();
	if (value instanceof ArrayBuffer) return new Uint8Array(value).slice();
	if (ArrayBuffer.isView(value)) {
		return new Uint8Array(
			value.buffer,
			value.byteOffset,
			value.byteLength,
		).slice();
	}
	return undefined;
}

function frameKindCode(kind: WebSocketFrameKind): number {
	if (kind === "text") throw new TypeError("text is not a binary frame kind");
	const code = FRAME_KIND_TO_CODE[kind];
	if (code === undefined)
		throw new TypeError(`unknown WebSocket frame kind ${kind}`);
	return code;
}

/** Encode one binary message sent over the physical WebSocket. */
export function encodeWebSocketFrame(frame: {
	readonly kind: Exclude<WebSocketFrameKind, "text">;
	readonly channelId?: number;
	readonly payload?: Uint8Array | string;
	readonly deliveryKind?: DeliveryKind;
}): Uint8Array {
	const channelId = frame.channelId ?? 0;
	if (
		!Number.isSafeInteger(channelId) ||
		channelId < 0 ||
		channelId > 0xffff_ffff
	) {
		throw new RangeError("WebSocket channelId must be a uint32");
	}
	const payload = bytesFromPayload(frame.payload ?? new Uint8Array());
	const result = new Uint8Array(DEFAULT_FRAME_BYTES + payload.byteLength);
	const view = new DataView(result.buffer);
	view.setUint16(0, FRAME_MAGIC);
	view.setUint8(2, FRAME_VERSION);
	view.setUint8(3, frameKindCode(frame.kind));
	view.setUint8(
		4,
		frame.deliveryKind ? (DELIVERY_KIND_TO_CODE[frame.deliveryKind] ?? 0) : 0,
	);
	view.setUint32(5, channelId);
	view.setUint32(9, payload.byteLength);
	result.set(payload, DEFAULT_FRAME_BYTES);
	return result;
}

/** Decode and validate a binary WebSocket frame. */
export function decodeWebSocketFrame(
	value: ArrayBuffer | ArrayBufferView,
): WebSocketFrame {
	const bytes = asUint8Array(value);
	if (!bytes || bytes.byteLength < DEFAULT_FRAME_BYTES) {
		throw new WebSocketTransportError(
			"E_INTERNAL",
			"truncated WebSocket frame",
		);
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (view.getUint16(0) !== FRAME_MAGIC || view.getUint8(2) !== FRAME_VERSION) {
		throw new WebSocketTransportError(
			"E_INTERNAL",
			"invalid WebSocket frame header",
		);
	}
	const kind = FRAME_CODE_TO_KIND[view.getUint8(3)];
	if (!kind)
		throw new WebSocketTransportError(
			"E_INTERNAL",
			"unknown WebSocket frame kind",
		);
	const payloadLength = view.getUint32(9);
	if (payloadLength !== bytes.byteLength - DEFAULT_FRAME_BYTES) {
		throw new WebSocketTransportError(
			"E_INTERNAL",
			"invalid WebSocket frame length",
		);
	}
	const deliveryCode = view.getUint8(4);
	const deliveryKind =
		deliveryCode === 0 ? undefined : DELIVERY_CODE_TO_KIND[deliveryCode];
	if (deliveryCode !== 0 && !deliveryKind) {
		throw new WebSocketTransportError(
			"E_INTERNAL",
			"unknown WebSocket delivery kind",
		);
	}
	return {
		kind,
		channelId: view.getUint32(5),
		payload: bytes.slice(DEFAULT_FRAME_BYTES),
		deliveryKind,
	};
}

export function encodeHandshakeFrame(role: string): Uint8Array {
	if (!role || role.length > 255)
		throw new RangeError("WebSocket role is invalid");
	return encodeWebSocketFrame({ kind: "hello", payload: role });
}

export interface WebSocketAdapterOptions {
	readonly capacityProfile?: CapacityProfile;
	readonly clientFactory?: ClientSocketFactory;
	readonly serverFactory?: WebSocketServerFactory;
	readonly clock?: TransportClock;
	readonly maxReceiveQueueBytes?: number;
	readonly maxReceiveQueueItems?: number;
	readonly receiveWaiterLimit?: number;
	readonly clientWatermarkPollMs?: number;
}

type MutableMetrics = {
	attempted: number;
	queued: number;
	serverObserved: number;
	acknowledged: number;
	delivered: number;
	refused: number;
	dropped: number;
	timedOut: number;
	sessionsOpened: number;
	sessionsClosed: number;
	streamsOpened: number;
	streamsAccepted: number;
	streamsClosed: number;
	queueBytesPeak: number;
};

function emptyMetrics(): MutableMetrics {
	return {
		attempted: 0,
		queued: 0,
		serverObserved: 0,
		acknowledged: 0,
		delivered: 0,
		refused: 0,
		dropped: 0,
		timedOut: 0,
		sessionsOpened: 0,
		sessionsClosed: 0,
		streamsOpened: 0,
		streamsAccepted: 0,
		streamsClosed: 0,
		queueBytesPeak: 0,
	};
}

function copyMetrics(value: MutableMetrics): MutableMetrics {
	return { ...value };
}

function mergeMetrics(target: MutableMetrics, source: MutableMetrics): void {
	for (const key of [
		"attempted",
		"queued",
		"serverObserved",
		"acknowledged",
		"delivered",
		"refused",
		"dropped",
		"timedOut",
		"sessionsOpened",
		"sessionsClosed",
		"streamsOpened",
		"streamsAccepted",
		"streamsClosed",
	] as const) {
		target[key] += source[key];
	}
	target.queueBytesPeak = Math.max(
		target.queueBytesPeak,
		source.queueBytesPeak,
	);
}

function finiteDeadline(deadlineMs: number): void {
	if (
		deadlineMs !== Number.POSITIVE_INFINITY &&
		(!Number.isFinite(deadlineMs) || deadlineMs < 0)
	) {
		throw new RangeError(
			"deadlineMs must be a non-negative finite time or infinity",
		);
	}
}

function normalizeAbsoluteDeadline(
	clock: TransportClock,
	deadlineMs: number,
	message: string,
): number {
	if (!Number.isFinite(deadlineMs) || deadlineMs < 0)
		throw deadlineError("E_HANDSHAKE_TIMEOUT", message);
	if (deadlineMs < 1e10) {
		return clock.nowMs() + deadlineMs;
	}
	return deadlineMs;
}

function remainingMs(clock: TransportClock, deadlineMs: number): number {
	finiteDeadline(deadlineMs);
	return deadlineMs === Number.POSITIVE_INFINITY
		? Number.POSITIVE_INFINITY
		: Math.max(0, deadlineMs - clock.nowMs());
}

function effectiveHandshakeDeadline(
	clock: TransportClock,
	deadlineMs: number,
	handshakeTimeoutMs: number,
): number {
	const callerDeadline = normalizeAbsoluteDeadline(
		clock,
		deadlineMs,
		"WebSocket handshake requires a finite deadline",
	);
	const handshakeDeadline = clock.nowMs() + handshakeTimeoutMs;
	if (!Number.isFinite(handshakeDeadline))
		throw deadlineError(
			"E_HANDSHAKE_TIMEOUT",
			"WebSocket handshake deadline is not representable",
		);
	return Math.min(callerDeadline, handshakeDeadline);
}

function remainingUntilAbsoluteDeadline(
	clock: TransportClock,
	deadlineMs: number,
	code: WebSocketTransportErrorCode,
	message: string,
): number {
	if (!Number.isFinite(deadlineMs) || deadlineMs < 0)
		throw deadlineError(code, message);
	return Math.max(0, deadlineMs - clock.nowMs());
}

function deadlineError(
	code: WebSocketTransportErrorCode,
	message: string,
): WebSocketTransportError {
	return new WebSocketTransportError(code, message);
}

function cloneCapacityProfile(profile: CapacityProfile): CapacityProfile {
	return {
		profileId: profile.profileId,
		maxSessions: profile.maxSessions,
		maxHandshakesInFlight: profile.maxHandshakesInFlight,
		maxStreamsPerSessionBidi: profile.maxStreamsPerSessionBidi,
		maxStreamsPerSessionUni: profile.maxStreamsPerSessionUni,
		maxStreamsGlobal: profile.maxStreamsGlobal,
		maxDatagramSize: profile.maxDatagramSize,
		maxQueuedBytesGlobal: profile.maxQueuedBytesGlobal,
		maxQueuedBytesPerSession: profile.maxQueuedBytesPerSession,
		maxQueuedBytesPerStream: profile.maxQueuedBytesPerStream,
		backpressureTimeoutMs: profile.backpressureTimeoutMs,
		handshakeTimeoutMs: profile.handshakeTimeoutMs,
		idleTimeoutMs: profile.idleTimeoutMs,
		handshakesPerSec: profile.handshakesPerSec,
		handshakesBurst: profile.handshakesBurst,
		handshakesBurstPerPrefix: profile.handshakesBurstPerPrefix,
		streamsPerSec: profile.streamsPerSec,
		streamsBurst: profile.streamsBurst,
		datagramsPerSec: profile.datagramsPerSec,
		datagramsBurst: profile.datagramsBurst,
		ringBytes: profile.ringBytes,
		overflowPolicy: profile.overflowPolicy,
		bridgePermits: profile.bridgePermits,
		sinkPermits: profile.sinkPermits,
		sinkDoorbellMs: profile.sinkDoorbellMs,
		pacerSkippedSlotsTolerance: profile.pacerSkippedSlotsTolerance,
		saturatorId: profile.saturatorId,
	};
}

function freezeCapacityProfile(profile: CapacityProfile): CapacityProfile {
	return Object.freeze(profile);
}

class ByteReservation {
	private released = false;

	constructor(
		private readonly ledger: ByteReservationLedger,
		readonly sessionKey: string,
		readonly streamKey: string | undefined,
		readonly bytes: number,
	) {}

	release(): void {
		if (this.released) return;
		this.released = true;
		this.ledger.release(this);
	}
}

class ByteReservationLedger {
	private globalBytes = 0;
	private readonly sessionBytesMap = new Map<string, number>();
	private readonly streamBytesMap = new Map<string, number>();

	constructor(private readonly profile: CapacityProfile) {}

	reserve(
		bytes: number,
		sessionKey: string,
		streamKey?: string,
	): ByteReservation {
		if (!Number.isSafeInteger(bytes) || bytes <= 0)
			throw new RangeError("reservation bytes must be a positive safe integer");
		const sessionBytes = this.sessionBytesMap.get(sessionKey) ?? 0;
		const streamBytes = streamKey
			? (this.streamBytesMap.get(streamKey) ?? 0)
			: 0;
		if (
			this.globalBytes + bytes > this.profile.maxQueuedBytesGlobal ||
			sessionBytes + bytes > this.profile.maxQueuedBytesPerSession ||
			(streamKey !== undefined &&
				streamBytes + bytes > this.profile.maxQueuedBytesPerStream)
		) {
			throw new WebSocketTransportError(
				"E_QUEUE_FULL",
				"WebSocket queued-byte budget exhausted",
			);
		}
		this.globalBytes += bytes;
		this.sessionBytesMap.set(sessionKey, sessionBytes + bytes);
		if (streamKey !== undefined)
			this.streamBytesMap.set(streamKey, streamBytes + bytes);
		return new ByteReservation(this, sessionKey, streamKey, bytes);
	}

	release(reservation: ByteReservation): void {
		this.globalBytes = Math.max(0, this.globalBytes - reservation.bytes);
		this.decrement(
			this.sessionBytesMap,
			reservation.sessionKey,
			reservation.bytes,
		);
		if (reservation.streamKey !== undefined)
			this.decrement(
				this.streamBytesMap,
				reservation.streamKey,
				reservation.bytes,
			);
	}

	sessionBytes(sessionKey: string): number {
		return this.sessionBytesMap.get(sessionKey) ?? 0;
	}

	private decrement(
		map: Map<string, number>,
		key: string,
		bytes: number,
	): void {
		const remaining = Math.max(0, (map.get(key) ?? 0) - bytes);
		if (remaining === 0) map.delete(key);
		else map.set(key, remaining);
	}
}

async function waitForQueue<T>(
	queue: ByteBoundedQueue<T>,
	clock: TransportClock,
	deadlineMs: number,
	code: WebSocketTransportErrorCode,
	message: string,
): Promise<T> {
	if (deadlineMs === Number.POSITIVE_INFINITY) {
		throw deadlineError(
			code,
			"a finite deadline is required for WebSocket queue waits",
		);
	}
	const absDeadline = normalizeAbsoluteDeadline(clock, deadlineMs, message);
	const remaining = remainingMs(clock, absDeadline);
	if (remaining <= 0) throw deadlineError(code, message);
	const controller = new AbortController();
	const read = queue.waitForItem({ signal: controller.signal });
	let timer: Promise<never> | undefined;
	if (remaining !== Number.POSITIVE_INFINITY) {
		timer = (async () => {
			// Let synchronous socket handlers finish enqueueing before an injected
			// zero-cost clock can win the race.
			await Promise.resolve();
			await Promise.resolve();
			await clock.sleep(remaining);
			controller.abort(deadlineError(code, message));
			throw deadlineError(code, message);
		})();
	}
	try {
		const result = timer ? await Promise.race([read, timer]) : await read;
		if (result.done) {
			if (result.reason instanceof Error) throw result.reason;
			throw deadlineError("E_SESSION_CLOSED", "WebSocket session closed");
		}
		return result.value;
	} finally {
		controller.abort();
	}
}

type DrainWaiter = {
	readonly resolve: () => void;
	readonly reject: (reason: unknown) => void;
};

async function waitForDrain(
	waiters: DrainWaiter[],
	clock: TransportClock,
	deadlineMs: number,
	maxWaiters: number,
): Promise<void> {
	if (deadlineMs === Number.POSITIVE_INFINITY) {
		throw deadlineError(
			"E_BACKPRESSURE_TIMEOUT",
			"a finite deadline is required for WebSocket drain waits",
		);
	}
	const absDeadline = normalizeAbsoluteDeadline(
		clock,
		deadlineMs,
		"a finite deadline is required for WebSocket drain waits",
	);
	const remaining = remainingMs(clock, absDeadline);
	if (remaining <= 0)
		throw deadlineError(
			"E_BACKPRESSURE_TIMEOUT",
			"server drain deadline expired",
		);
	if (remaining === Number.POSITIVE_INFINITY) {
		throw deadlineError(
			"E_BACKPRESSURE_TIMEOUT",
			"a finite deadline is required for WebSocket drain waits",
		);
	}
	if (waiters.length >= maxWaiters)
		throw deadlineError(
			"E_QUEUE_FULL",
			"WebSocket drain waiter limit exceeded",
		);
	let waiter!: DrainWaiter;
	let done = false;
	const ready = new Promise<void>((resolve, reject) => {
		waiter = {
			resolve,
			reject,
		};
		waiters.push(waiter);
	});
	const timeout = (async () => {
		await Promise.resolve();
		if (done) return new Promise<never>(() => {});
		await clock.sleep(remaining);
		if (done) return new Promise<never>(() => {});
		throw deadlineError(
			"E_BACKPRESSURE_TIMEOUT",
			"server drain deadline expired",
		);
	})();
	try {
		await Promise.race([ready, timeout]);
	} finally {
		done = true;
		const index = waiters.indexOf(waiter);
		if (index >= 0) waiters.splice(index, 1);
	}
}

async function runWithDeadline<T>(
	operation: Promise<T> | T,
	clock: TransportClock,
	timeoutMs: number,
	error: WebSocketTransportError,
): Promise<T> {
	if (timeoutMs === Number.POSITIVE_INFINITY)
		throw new WebSocketTransportError(
			error.code,
			`${error.message}; an explicit finite deadline is required`,
		);
	if (!Number.isFinite(timeoutMs) || timeoutMs < 0)
		throw new RangeError("timeoutMs must be a non-negative finite time");
	let done = false;
	const timeout = clock.sleep(timeoutMs).then(() => {
		if (done) return new Promise<never>(() => {});
		throw error;
	});
	try {
		return await Promise.race([Promise.resolve(operation), timeout]);
	} finally {
		done = true;
	}
}

function socketData(event: unknown): unknown {
	if (event && typeof event === "object" && "data" in event) {
		return (event as { readonly data: unknown }).data;
	}
	return event;
}

function socketCloseCode(event: unknown): number {
	if (event && typeof event === "object" && "code" in event) {
		const code = (event as { readonly code: unknown }).code;
		return typeof code === "number" ? code : 1000;
	}
	return 1000;
}

function socketCloseReason(event: unknown): string {
	if (event && typeof event === "object" && "reason" in event) {
		const reason = (event as { readonly reason: unknown }).reason;
		return typeof reason === "string" ? reason : "";
	}
	return "";
}

function asSocketPayload(value: unknown): Uint8Array | string | undefined {
	if (typeof value === "string") return value;
	return asUint8Array(value);
}

class TokenBucket {
	private tokens: number;
	private lastMs: number;

	constructor(
		private readonly ratePerSecond: number,
		private readonly burst: number,
		private readonly clock: TransportClock,
	) {
		this.tokens = burst;
		this.lastMs = clock.nowMs();
	}

	consume(): boolean {
		const now = this.clock.nowMs();
		const elapsed = Math.max(0, now - this.lastMs);
		this.lastMs = now;
		this.tokens = Math.min(
			this.burst,
			this.tokens + (elapsed * this.ratePerSecond) / 1000,
		);
		if (this.tokens < 1) return false;
		this.tokens -= 1;
		return true;
	}
}

class StreamAdmissionLease {
	private settled = false;

	constructor(private readonly admission: AdmissionController) {}

	commit(): void {
		if (this.settled) return;
		this.settled = true;
		this.admission.commitStream();
	}

	rollback(): void {
		if (this.settled) return;
		this.settled = true;
		this.admission.rollbackStream();
	}
}

class AdmissionController {
	private readonly counters = {
		sessionsActive: 0,
		handshakesInFlight: 0,
		handshakesAttempted: 0,
		handshakesAccepted: 0,
		handshakesRejected: 0,
		streamOpenAttempts: 0,
		streamOpenAccepted: 0,
		streamOpenRejected: 0,
		datagramAttempts: 0,
		datagramAccepted: 0,
		datagramRejected: 0,
		tokenBucketRejected: 0,
	};
	private readonly handshakeBuckets = new Map<string, TokenBucket>();
	private readonly streamBuckets = new Map<string, TokenBucket>();
	private readonly datagramBuckets = new Map<string, TokenBucket>();
	private streamsActive = 0;
	private streamsReserved = 0;

	constructor(
		private readonly profile: CapacityProfile,
		private readonly clock: TransportClock,
	) {}

	private bucket(
		map: Map<string, TokenBucket>,
		key: string,
		ratePerSecond: number,
		burst: number,
	): TokenBucket {
		const current = map.get(key);
		if (current) return current;
		const created = new TokenBucket(ratePerSecond, burst, this.clock);
		map.set(key, created);
		return created;
	}

	beginHandshake(source: string): boolean {
		this.counters.handshakesAttempted += 1;
		const bucket = this.bucket(
			this.handshakeBuckets,
			source,
			this.profile.handshakesPerSec,
			this.profile.handshakesBurstPerPrefix,
		);
		const tokenAvailable = bucket.consume();
		if (
			this.counters.sessionsActive >= this.profile.maxSessions ||
			this.counters.handshakesInFlight >= this.profile.maxHandshakesInFlight ||
			!tokenAvailable
		) {
			this.counters.handshakesRejected += 1;
			if (!tokenAvailable) this.counters.tokenBucketRejected += 1;
			return false;
		}
		this.counters.handshakesInFlight += 1;
		return true;
	}

	finishHandshake(accepted: boolean): void {
		this.counters.handshakesInFlight = Math.max(
			0,
			this.counters.handshakesInFlight - 1,
		);
		if (accepted) {
			this.counters.handshakesAccepted += 1;
			this.counters.sessionsActive += 1;
		} else {
			this.counters.handshakesRejected += 1;
		}
	}

	/** Record a handshake that arrived after the server stopped. */
	rejectHandshakeAttempt(): void {
		this.counters.handshakesAttempted += 1;
		this.counters.handshakesRejected += 1;
	}

	closeSession(): void {
		this.counters.sessionsActive = Math.max(
			0,
			this.counters.sessionsActive - 1,
		);
	}

	beginStream(source: string): StreamAdmissionLease | undefined {
		this.counters.streamOpenAttempts += 1;
		const bucket = this.bucket(
			this.streamBuckets,
			source,
			this.profile.streamsPerSec,
			this.profile.streamsBurst,
		);
		const tokenAvailable = bucket.consume();
		if (
			this.streamsActive + this.streamsReserved >=
				this.profile.maxStreamsGlobal ||
			!tokenAvailable
		) {
			this.counters.streamOpenRejected += 1;
			if (!tokenAvailable) this.counters.tokenBucketRejected += 1;
			return undefined;
		}
		this.streamsReserved += 1;
		return new StreamAdmissionLease(this);
	}

	commitStream(): void {
		this.streamsReserved = Math.max(0, this.streamsReserved - 1);
		this.streamsActive += 1;
		this.counters.streamOpenAccepted += 1;
	}

	rollbackStream(): void {
		this.streamsReserved = Math.max(0, this.streamsReserved - 1);
		this.counters.streamOpenRejected += 1;
	}

	rejectStreamAttempt(): void {
		this.counters.streamOpenAttempts += 1;
		this.counters.streamOpenRejected += 1;
	}

	rejectAcceptedStream(): void {
		this.counters.streamOpenRejected += 1;
	}

	closeStream(): void {
		this.streamsActive = Math.max(0, this.streamsActive - 1);
	}

	openDatagram(source: string): boolean {
		this.counters.datagramAttempts += 1;
		const bucket = this.bucket(
			this.datagramBuckets,
			source,
			this.profile.datagramsPerSec,
			this.profile.datagramsBurst,
		);
		if (!bucket.consume()) {
			this.counters.datagramRejected += 1;
			this.counters.tokenBucketRejected += 1;
			return false;
		}
		this.counters.datagramAccepted += 1;
		return true;
	}

	rejectDatagram(): void {
		this.counters.datagramAttempts += 1;
		this.counters.datagramRejected += 1;
	}

	snapshot(): AdmissionCounters {
		return { ...this.counters };
	}
}

type QueuedFrame = {
	readonly frame: WebSocketFrame;
	readonly bytes: number;
	readonly reservation: ByteReservation;
};

type SessionStreamAdmissionLease = {
	commit(): void;
	rollback(): void;
};

class WsSession implements Session {
	private readonly handshakeWaiters = new Set<DrainWaiter>();
	private _role: string;
	private active = true;
	private didCloseSocket = false;
	private readonly metrics: MutableMetrics = emptyMetrics();
	private readonly incoming: ByteBoundedQueue<QueuedFrame>;
	private readonly uniAcceptQueue: ByteBoundedQueue<WsChannel>;
	private readonly bidiAcceptQueue: ByteBoundedQueue<WsChannel>;
	private readonly channels = new Map<number, WsChannel>();
	private nextChannelId = 1;
	private readonly drainWaiters: DrainWaiter[] = [];
	private readonly blockedSendReservations = new Set<ByteReservation>();
	private serverBlocked = false;
	private handshakeComplete = false;
	private handshakeTerminal = false;
	private handshakeAdmissionSettled = false;
	private admissionAccepted = false;
	private acceptReservation: ByteReservation | undefined;
	private readonly sourceKey: string;
	private readonly clientHighWaterMark: number;
	private readonly clientLowWaterMark: number;
	private readonly clientWatermarkPollMs: number;
	private readonly onHandshakeRole?: (session: WsSession) => boolean;
	private readonly onHandshakeAccepted?: (session: WsSession) => boolean;
	private readonly openUniCount = { value: 0 };
	private readonly openBidiCount = { value: 0 };

	constructor(
		private readonly socket: ClientWebSocketLike | ServerWebSocketLike,
		private readonly isServer: boolean,
		initialRole: string,
		private readonly profile: CapacityProfile,
		private readonly clock: TransportClock,
		private readonly admission: AdmissionController,
		maxReceiveQueueBytes: number,
		maxReceiveQueueItems: number,
		private readonly receiveWaiterLimit: number,
		private readonly onClosed?: (session: WsSession) => void,
		clientHighWaterMark?: number,
		clientLowWaterMark?: number,
		clientWatermarkPollMs = 10,
		onHandshakeRole?: (session: WsSession) => boolean,
		onHandshakeAccepted?: (session: WsSession) => boolean,
		private readonly ledger: ByteReservationLedger = new ByteReservationLedger(
			profile,
		),
		private readonly sessionKey = "session",
		channelParity: 1 | 2 = isServer ? 2 : 1,
	) {
		this._role = initialRole;
		this.nextChannelId = channelParity;
		if (isServer || socket.readyState === 1)
			this.handshakeState = "socket-open";
		if (!isServer) this.metrics.sessionsOpened = 1;
		this.clientHighWaterMark =
			clientHighWaterMark ?? profile.maxQueuedBytesPerSession;
		this.clientLowWaterMark =
			clientLowWaterMark ?? Math.floor(this.clientHighWaterMark / 2);
		this.clientWatermarkPollMs = clientWatermarkPollMs;
		this.onHandshakeRole = onHandshakeRole;
		this.onHandshakeAccepted = onHandshakeAccepted;
		this.sourceKey = isServer
			? ((socket as ServerWebSocketLike).remoteAddress ?? "unknown")
			: "local";
		this.incoming = new ByteBoundedQueue<QueuedFrame>({
			maxBytes: maxReceiveQueueBytes,
			maxItems: maxReceiveQueueItems,
			maxWaiters: receiveWaiterLimit,
			sizeOf: (entry) => Math.max(1, entry.bytes),
		});
		this.uniAcceptQueue = new ByteBoundedQueue<WsChannel>({
			maxBytes: Math.max(1, profile.maxStreamsGlobal),
			maxItems: profile.maxStreamsGlobal,
			maxWaiters: receiveWaiterLimit,
			sizeOf: () => 1,
		});
		this.bidiAcceptQueue = new ByteBoundedQueue<WsChannel>({
			maxBytes: Math.max(1, profile.maxStreamsGlobal),
			maxItems: profile.maxStreamsGlobal,
			maxWaiters: receiveWaiterLimit,
			sizeOf: () => 1,
		});
	}

	private handshakeState:
		| "connecting"
		| "socket-open"
		| "hello-sent"
		| "established"
		| "failed" = "connecting";

	get role(): string {
		return this._role;
	}

	setRole(role: string): void {
		if (role) this._role = role;
	}

	markSocketOpen(): void {
		if (this.handshakeState === "connecting")
			this.handshakeState = "socket-open";
	}

	markHandshakeSent(): void {
		if (!this.handshakeTerminal) this.handshakeState = "hello-sent";
	}

	isActive(): boolean {
		return this.active;
	}

	setAcceptReservation(reservation: ByteReservation): void {
		this.acceptReservation?.release();
		this.acceptReservation = reservation;
	}

	releaseAcceptReservation(): void {
		this.acceptReservation?.release();
		this.acceptReservation = undefined;
	}

	private settleHandshakeAdmission(accepted: boolean): void {
		if (this.handshakeAdmissionSettled) return;
		this.handshakeAdmissionSettled = true;
		this.admissionAccepted = accepted;
		this.admission.finishHandshake(accepted);
	}

	markHandshakeComplete(): void {
		if (this.handshakeTerminal) return;
		this.handshakeTerminal = true;
		this.handshakeState = "established";
		this.handshakeComplete = true;
		this.settleHandshakeAdmission(true);
		for (const waiter of this.handshakeWaiters) waiter.resolve();
		this.handshakeWaiters.clear();
	}

	rejectHandshake(reason: unknown): void {
		if (this.handshakeTerminal) return;
		this.handshakeTerminal = true;
		this.handshakeState = "failed";
		this.settleHandshakeAdmission(false);
		for (const waiter of this.handshakeWaiters) waiter.reject(reason);
		this.handshakeWaiters.clear();
		this.closeInternal(reason, true);
	}

	async waitForHandshake(deadlineMs: number): Promise<void> {
		if (this.handshakeComplete) return;
		if (!this.active)
			throw new WebSocketTransportError(
				"E_SESSION_CLOSED",
				"WebSocket session closed before handshake",
			);
		const remaining = remainingMs(this.clock, deadlineMs);
		if (remaining === Number.POSITIVE_INFINITY || remaining <= 0) {
			const error = deadlineError(
				"E_HANDSHAKE_TIMEOUT",
				remaining === Number.POSITIVE_INFINITY
					? "WebSocket handshake acknowledgement requires a finite deadline"
					: "WebSocket handshake acknowledgement deadline expired",
			);
			this.rejectHandshake(error);
			throw error;
		}
		let waiter!: DrainWaiter;
		let done = false;
		const ready = new Promise<void>((resolve, reject) => {
			waiter = { resolve, reject };
			this.handshakeWaiters.add(waiter);
		});
		const timeout = (async () => {
			await Promise.resolve();
			if (done || this.handshakeComplete) return new Promise<never>(() => {});
			await this.clock.sleep(remaining);
			if (done || this.handshakeComplete || !this.active)
				return new Promise<never>(() => {});
			const error = deadlineError(
				"E_HANDSHAKE_TIMEOUT",
				"WebSocket handshake acknowledgement deadline expired",
			);
			this.rejectHandshake(error);
			throw error;
		})();
		try {
			await Promise.race([ready, timeout]);
		} finally {
			done = true;
			this.handshakeWaiters.delete(waiter);
		}
	}

	startServerHandshakeTimer(): void {
		if (!this.isServer || this.handshakeComplete) return;
		void (async () => {
			await Promise.resolve();
			await Promise.resolve();
			await this.clock.sleep(this.profile.handshakeTimeoutMs);
			if (!this.handshakeComplete && this.active)
				this.rejectHandshake(
					deadlineError(
						"E_HANDSHAKE_TIMEOUT",
						"WebSocket server handshake deadline expired",
					),
				);
		})().catch((error) => {
			if (!this.handshakeComplete && this.active) this.rejectHandshake(error);
		});
	}

	private assertActive(): void {
		if (!this.active)
			throw new WebSocketTransportError(
				"E_SESSION_CLOSED",
				"WebSocket session is closed",
			);
	}

	private updateQueuePeak(): void {
		this.metrics.queueBytesPeak = Math.max(
			this.metrics.queueBytesPeak,
			this.ledger.sessionBytes(this.sessionKey),
		);
	}

	reserve(bytes: number, channelId?: number): ByteReservation {
		const reservation = this.ledger.reserve(
			bytes,
			this.sessionKey,
			channelId === undefined
				? undefined
				: `${this.sessionKey}:stream:${channelId}`,
		);
		this.updateQueuePeak();
		return reservation;
	}

	private async waitClientWatermark(deadlineMs: number): Promise<void> {
		if (this.isServer) return;
		const socket = this.socket as ClientWebSocketLike;
		const highWaterMark = Math.max(0, this.clientHighWaterMark);
		const lowWaterMark = Math.min(
			highWaterMark,
			Math.max(0, this.clientLowWaterMark),
		);
		if (highWaterMark <= 0 || socket.bufferedAmount < highWaterMark) return;
		if (deadlineMs === Number.POSITIVE_INFINITY) {
			this.metrics.timedOut += 1;
			throw deadlineError(
				"E_BACKPRESSURE_TIMEOUT",
				"client bufferedAmount requires a finite deadline",
			);
		}
		while (socket.bufferedAmount > lowWaterMark) {
			const remaining = remainingMs(this.clock, deadlineMs);
			if (remaining <= 0) {
				this.metrics.timedOut += 1;
				throw deadlineError(
					"E_BACKPRESSURE_TIMEOUT",
					"client bufferedAmount did not reach low water",
				);
			}
			if (socket.readyState !== 1)
				throw new WebSocketTransportError(
					"E_SESSION_CLOSED",
					"WebSocket client closed",
				);
			await this.clock.sleep(Math.min(this.clientWatermarkPollMs, remaining));
		}
	}

	private async waitServerDrain(deadlineMs: number): Promise<void> {
		if (!this.serverBlocked) return;
		try {
			await waitForDrain(
				this.drainWaiters,
				this.clock,
				deadlineMs,
				this.receiveWaiterLimit,
			);
		} catch (error) {
			this.metrics.timedOut += 1;
			throw error;
		}
	}

	private async sendEncoded(
		encoded: Uint8Array,
		deliveryKind: DeliveryKind,
		deadlineMs: number,
		channelId?: number,
		countAttempt = true,
		attemptAlreadyCounted = false,
	): Promise<SendObservation> {
		this.assertActive();
		if (countAttempt && !attemptAlreadyCounted) this.metrics.attempted += 1;
		let reservation: ByteReservation;
		try {
			reservation = this.reserve(encoded.byteLength, channelId);
		} catch (error) {
			if (countAttempt) this.metrics.refused += 1;
			throw error;
		}
		try {
			if (!this.isServer) await this.waitClientWatermark(deadlineMs);
			else await this.waitServerDrain(deadlineMs);
		} catch (error) {
			reservation.release();
			if (countAttempt) this.metrics.refused += 1;
			throw error;
		}
		let status: number;
		try {
			status = this.isServer
				? (this.socket as ServerWebSocketLike).send(encoded, false)
				: ((this.socket as ClientWebSocketLike).send(
						encoded,
					) as unknown as number);
			if (!this.isServer) status = encoded.byteLength;
		} catch (error) {
			reservation.release();
			this.closeInternal(error, false);
			throw new WebSocketTransportError(
				"E_SESSION_CLOSED",
				"WebSocket send failed",
				{ cause: error },
			);
		}
		const accepted = !this.isServer || status === -1 || status > 0;
		if (accepted && countAttempt) {
			this.metrics.queued += 1;
			this.metrics.queueBytesPeak = Math.max(
				this.metrics.queueBytesPeak,
				encoded.byteLength,
			);
		}
		if (this.isServer && status === 0 && countAttempt)
			this.metrics.refused += 1;
		if (this.isServer && status === -1) {
			// Bun has already queued this exact message. Never call send again for it.
			this.serverBlocked = true;
			this.blockedSendReservations.add(reservation);
		} else {
			reservation.release();
		}
		if (this.isServer && status > 0) this.serverBlocked = false;
		return {
			status,
			bytes: encoded.byteLength,
			deliveryKind,
			attempted: true,
			queued: accepted,
			serverObserved: false,
			acknowledged: false,
			delivered: false,
			...(channelId === undefined ? {} : { channelId }),
		};
	}

	/**
	 * Send the server's handshake ACK synchronously. Bun's server send is
	 * synchronous, and keeping this control transition synchronous prevents an
	 * accept waiter from racing the handshake completion microtask.
	 */
	private sendHandshakeAck(): number {
		if (!this.isServer)
			throw new WebSocketTransportError(
				"E_INTERNAL",
				"only a server session can send a WebSocket handshake ACK",
			);
		const encoded = encodeWebSocketFrame({ kind: "hello-ack" });
		const reservation = this.reserve(encoded.byteLength);
		let status: number;
		try {
			status = (this.socket as ServerWebSocketLike).send(encoded, false);
		} catch (error) {
			reservation.release();
			throw new WebSocketTransportError(
				"E_SESSION_CLOSED",
				"WebSocket handshake acknowledgement failed",
				{ cause: error },
			);
		}
		if (status === 0) {
			reservation.release();
			throw new WebSocketTransportError(
				"E_QUEUE_FULL",
				"WebSocket handshake acknowledgement was refused",
			);
		}
		if (status === -1) {
			this.serverBlocked = true;
			this.blockedSendReservations.add(reservation);
		} else {
			reservation.release();
			this.serverBlocked = false;
		}
		return status;
	}

	private openStreamAdmission(
		kind: "uni" | "bidi",
	): SessionStreamAdmissionLease | undefined {
		const count = kind === "uni" ? this.openUniCount : this.openBidiCount;
		const limit =
			kind === "uni"
				? this.profile.maxStreamsPerSessionUni
				: this.profile.maxStreamsPerSessionBidi;
		if (count.value >= limit) {
			this.admission.rejectStreamAttempt();
			return undefined;
		}
		const admissionLease = this.admission.beginStream(this.sourceKey);
		if (!admissionLease) return undefined;
		count.value += 1;
		let settled = false;
		return {
			commit: () => {
				if (settled) return;
				settled = true;
				admissionLease.commit();
			},
			rollback: () => {
				if (settled) return;
				settled = true;
				count.value = Math.max(0, count.value - 1);
				admissionLease.rollback();
			},
		};
	}

	private allocateChannelId(): number {
		const channelId = this.nextChannelId;
		if (
			!Number.isSafeInteger(channelId) ||
			channelId <= 0 ||
			channelId > 0xffff_ffff
		)
			throw new WebSocketTransportError(
				"E_LIMIT_EXCEEDED",
				"WebSocket channel ID namespace exhausted",
			);
		this.nextChannelId += 2;
		return channelId;
	}

	private acceptsRemoteChannelId(channelId: number): boolean {
		const expectedParity = this.isServer ? 1 : 0;
		return (
			Number.isSafeInteger(channelId) &&
			channelId > 0 &&
			channelId <= 0xffff_ffff &&
			channelId % 2 === expectedParity &&
			!this.channels.has(channelId)
		);
	}

	releaseStream(kind: "uni" | "bidi"): void {
		const count = kind === "uni" ? this.openUniCount : this.openBidiCount;
		if (count.value <= 0) return;
		count.value -= 1;
		this.admission.closeStream();
		this.metrics.streamsClosed += 1;
	}

	async sendMessage(
		kind: DeliveryKind,
		message: WireMessage,
		deadlineMs: number,
	): Promise<SendObservation> {
		this.assertActive();
		this.metrics.attempted += 1;
		if (
			kind === "datagram" &&
			message.payload.byteLength > this.profile.maxDatagramSize
		) {
			this.admission.rejectDatagram();
			this.metrics.refused += 1;
			throw new WebSocketTransportError(
				"E_LIMIT_EXCEEDED",
				"datagram exceeds canonical maxDatagramSize",
			);
		}
		if (kind === "datagram" && !this.admission.openDatagram(this.sourceKey)) {
			this.metrics.refused += 1;
			throw new WebSocketTransportError(
				"E_RATE_LIMITED",
				"datagram admission rate exceeded",
			);
		}
		const payload = encodeWireMessage(message, {
			nowMs: this.clock.nowMs(),
			rejectExpired: false,
		});
		return this.sendEncoded(
			encodeWebSocketFrame({ kind: "message", payload, deliveryKind: kind }),
			kind,
			deadlineMs,
			undefined,
			true,
			true,
		);
	}

	/**
	 * Acknowledge one message this session admitted.
	 *
	 * The receipt is harness traffic and is counted as neither an attempt nor a
	 * queued message: it is not something the scenario asked to send, and
	 * charging it to the application's funnel would make every arm's `attempted`
	 * twice its message count. It is deliberately best effort. A receipt that
	 * cannot be sent -- a full queue, a closed socket -- must not fail the
	 * receive that earned it, and its loss is already visible in the one place
	 * it should be: the arm's `acknowledged` falls behind its own `queued`,
	 * which is what the send-side progression is for. It is deliberately not
	 * compared against `delivered` -- that counter measures the other
	 * direction, and ordering the two was the defect that made this very
	 * shortfall unbuildable.
	 *
	 * It is also never awaited by the receive that earned it. The driver stamps
	 * a message's arrival after `receiveMessage` resolves, so an awaited receipt
	 * put its own send inside the sample -- and this arm's send is the expensive
	 * one: a frame encode, a `reserve()` against `maxQueuedBytesPerSession`, and
	 * a `waitClientWatermark`/`waitServerDrain` that can block to the deadline,
	 * against a single stream write on the other arm.
	 */
	private async sendAck(
		message: WireMessage,
		deliveryKind: DeliveryKind,
		deadlineMs: number,
	): Promise<void> {
		try {
			await this.sendEncoded(
				encodeWebSocketFrame({
					kind: "ack",
					payload: encodeWireMessage(ackFor(message)),
				}),
				deliveryKind,
				deadlineMs,
				undefined,
				false,
			);
		} catch {
			// See above: an unsent receipt is a measured shortfall, not a failure.
		}
	}

	async sendText(text: string, deadlineMs: number): Promise<SendObservation> {
		this.assertActive();
		this.metrics.attempted += 1;
		const bytes = new TextEncoder().encode(text);
		let reservation: ByteReservation;
		try {
			reservation = this.reserve(bytes.byteLength);
		} catch (error) {
			this.metrics.refused += 1;
			throw error;
		}
		try {
			if (!this.isServer) await this.waitClientWatermark(deadlineMs);
			else await this.waitServerDrain(deadlineMs);
		} catch (error) {
			reservation.release();
			this.metrics.refused += 1;
			throw error;
		}
		let status: number;
		try {
			if (this.isServer) {
				status = (this.socket as ServerWebSocketLike).send(text, false);
			} else {
				(this.socket as ClientWebSocketLike).send(text);
				status = text.length;
			}
		} catch (error) {
			reservation.release();
			this.closeInternal(error, false);
			throw new WebSocketTransportError(
				"E_SESSION_CLOSED",
				"WebSocket text send failed",
				{ cause: error },
			);
		}
		const accepted = !this.isServer || status === -1 || status > 0;
		if (accepted) this.metrics.queued += 1;
		if (this.isServer && status === 0) this.metrics.refused += 1;
		if (this.isServer && status === -1) {
			this.serverBlocked = true;
			this.blockedSendReservations.add(reservation);
		} else reservation.release();
		return {
			status,
			bytes: bytes.byteLength,
			deliveryKind: "reliable-message",
			attempted: true,
			queued: accepted,
			serverObserved: false,
			acknowledged: false,
			delivered: false,
		};
	}

	async receiveMessage(
		kind: DeliveryKind,
		deadlineMs: number,
	): Promise<WireMessage> {
		for (;;) {
			const entry = await waitForQueue(
				this.incoming,
				this.clock,
				deadlineMs,
				"E_HANDSHAKE_TIMEOUT",
				"message receive deadline expired",
			);
			entry.reservation.release();
			if (entry.frame.kind !== "message") continue;
			if (entry.frame.deliveryKind && entry.frame.deliveryKind !== kind)
				continue;
			try {
				const value = decodeWireMessage(entry.frame.payload, {
					nowMs: this.clock.nowMs(),
					rejectExpired: false,
				});
				if (value.kind === "ack") {
					this.metrics.acknowledged += 1;
					continue;
				}
				this.metrics.delivered += 1;
				// Deliberately not awaited: see `sendAck`. Awaiting it put the
				// receipt's own send inside the measured round trip, and WS's
				// send is the expensive one -- frame encode, a reservation
				// against `maxQueuedBytesPerSession`, and a flow-control wait
				// that can block all the way to the deadline.
				void this.sendAck(value, kind, deadlineMs);
				return value;
			} catch (error) {
				this.metrics.dropped += 1;
				throw new WebSocketTransportError(
					"E_INTERNAL",
					"malformed WebSocket wire message",
					{ cause: error },
				);
			}
		}
	}

	async openUni(
		deadlineMs: number,
		_options?: { readonly sourceKey?: string },
	): Promise<SendChannel> {
		this.assertActive();
		const channelId = this.allocateChannelId();
		const lease = this.openStreamAdmission("uni");
		if (!lease)
			throw new WebSocketTransportError(
				"E_LIMIT_EXCEEDED",
				"uni stream admission limit exceeded",
			);
		const channel = new WsChannel(
			this,
			channelId,
			true,
			false,
			"uni",
			this.profile,
			this.clock,
		);
		this.channels.set(channel.channelId, channel);
		try {
			const observation = await this.sendControl(
				{ kind: "open-uni", channelId: channel.channelId },
				"reliable-message",
				deadlineMs,
			);
			if (observation.status === 0)
				throw new WebSocketTransportError(
					"E_QUEUE_FULL",
					"WebSocket uni channel open was refused",
				);
			lease.commit();
			this.metrics.streamsOpened += 1;
			return channel;
		} catch (error) {
			this.channels.delete(channel.channelId);
			lease.rollback();
			this.metrics.streamsClosed += 1;
			channel.closeBeforeCommit(error);
			throw error;
		}
	}

	async acceptUni(deadlineMs: number): Promise<ReceiveChannel> {
		const channel = await waitForQueue(
			this.uniAcceptQueue,
			this.clock,
			deadlineMs,
			"E_HANDSHAKE_TIMEOUT",
			"uni stream accept deadline expired",
		);
		channel.releaseAcceptReservation();
		return channel;
	}

	async openBidi(
		deadlineMs: number,
		_options?: { readonly sourceKey?: string },
	): Promise<BidiChannel> {
		this.assertActive();
		const channelId = this.allocateChannelId();
		const lease = this.openStreamAdmission("bidi");
		if (!lease)
			throw new WebSocketTransportError(
				"E_LIMIT_EXCEEDED",
				"bidi stream admission limit exceeded",
			);
		const channel = new WsChannel(
			this,
			channelId,
			true,
			true,
			"bidi",
			this.profile,
			this.clock,
		);
		this.channels.set(channel.channelId, channel);
		try {
			const observation = await this.sendControl(
				{ kind: "open-bidi", channelId: channel.channelId },
				"reliable-message",
				deadlineMs,
			);
			if (observation.status === 0)
				throw new WebSocketTransportError(
					"E_QUEUE_FULL",
					"WebSocket bidi channel open was refused",
				);
			lease.commit();
			this.metrics.streamsOpened += 1;
			return channel;
		} catch (error) {
			this.channels.delete(channel.channelId);
			lease.rollback();
			this.metrics.streamsClosed += 1;
			channel.closeBeforeCommit(error);
			throw error;
		}
	}

	async acceptBidi(deadlineMs: number): Promise<BidiChannel> {
		const channel = await waitForQueue(
			this.bidiAcceptQueue,
			this.clock,
			deadlineMs,
			"E_HANDSHAKE_TIMEOUT",
			"bidi stream accept deadline expired",
		);
		channel.releaseAcceptReservation();
		return channel;
	}

	private async sendControl(
		frame: {
			readonly kind: Exclude<WebSocketFrameKind, "text">;
			readonly channelId?: number;
			readonly payload?: Uint8Array | string;
		},
		deliveryKind: DeliveryKind,
		deadlineMs: number,
		countAttempt = true,
	): Promise<SendObservation> {
		return this.sendEncoded(
			encodeWebSocketFrame(frame),
			deliveryKind,
			deadlineMs,
			frame.channelId,
			countAttempt,
		);
	}

	async sendChannelData(
		channelId: number,
		bytes: Uint8Array,
		deadlineMs: number,
	): Promise<SendObservation> {
		return this.sendEncoded(
			encodeWebSocketFrame({ kind: "channel-data", channelId, payload: bytes }),
			"reliable-message",
			deadlineMs,
			channelId,
		);
	}

	async endChannel(channelId: number, deadlineMs: number): Promise<void> {
		await this.sendControl(
			{ kind: "channel-end", channelId },
			"reliable-message",
			deadlineMs,
		);
	}

	async cancelChannel(channelId: number, deadlineMs: number): Promise<void> {
		try {
			await this.sendControl(
				{ kind: "channel-cancel", channelId },
				"reliable-message",
				deadlineMs,
			);
		} finally {
			this.channels.get(channelId)?.closeLocal();
		}
	}

	private closeChannels(reason: unknown): void {
		for (const channel of this.channels.values()) channel.closeLocal(reason);
		this.channels.clear();
		this.uniAcceptQueue.close(reason);
		this.bidiAcceptQueue.close(reason);
	}

	private releaseIncomingReservations(): void {
		for (const entry of this.incoming.drain()) entry.reservation.release();
	}

	private rejectDrainWaiters(reason: unknown): void {
		for (const waiter of this.drainWaiters.splice(0)) waiter.reject(reason);
	}

	private closeInternal(reason: unknown, closeSocket: boolean): void {
		if (!this.active) return;
		this.active = false;
		if (!this.handshakeTerminal) {
			this.handshakeTerminal = true;
			this.handshakeState = "failed";
			for (const waiter of this.handshakeWaiters) waiter.reject(reason);
			this.handshakeWaiters.clear();
		}
		this.settleHandshakeAdmission(false);
		this.rejectDrainWaiters(reason);
		this.releaseAcceptReservation();
		for (const reservation of this.blockedSendReservations)
			reservation.release();
		this.blockedSendReservations.clear();
		this.releaseIncomingReservations();
		this.incoming.close(reason);
		this.closeChannels(reason);
		if (this.handshakeComplete && this.admissionAccepted) {
			this.admission.closeSession();
		}
		if (closeSocket && !this.didCloseSocket) {
			this.didCloseSocket = true;
			try {
				this.socket.close(
					1000,
					reason instanceof Error ? reason.message : "closed",
				);
			} catch {
				// Socket close is best effort after a close/error race.
			}
		}
		this.metrics.sessionsClosed += 1;
		this.onClosed?.(this);
	}

	async close(_deadlineMs: number): Promise<void> {
		this.closeInternal(
			new WebSocketTransportError(
				"E_SESSION_CLOSED",
				"WebSocket session closed locally",
			),
			true,
		);
	}

	onDrain(): void {
		this.serverBlocked = false;
		for (const waiter of this.drainWaiters.splice(0)) waiter.resolve();
		for (const reservation of this.blockedSendReservations)
			reservation.release();
		this.blockedSendReservations.clear();
	}

	onSocketError(error: unknown): void {
		this.closeInternal(
			error instanceof Error ? error : new Error(String(error)),
			true,
		);
	}

	onSocketClose(code: number, reason: string): void {
		this.closeInternal(
			new WebSocketTransportError(
				"E_SESSION_CLOSED",
				`WebSocket closed (${code}): ${reason}`,
			),
			false,
		);
	}

	onSocketMessage(value: unknown): void {
		if (!this.active) return;
		const payload = asSocketPayload(value);
		if (typeof payload === "string") {
			this.metrics.serverObserved += 1;
			return;
		}
		if (!payload) {
			this.metrics.dropped += 1;
			return;
		}
		let frame: WebSocketFrame;
		try {
			frame = decodeWebSocketFrame(payload);
		} catch {
			this.metrics.dropped += 1;
			return;
		}
		if (frame.kind === "hello") {
			if (
				!this.isServer ||
				this.handshakeTerminal ||
				this.handshakeState !== "socket-open"
			) {
				this.metrics.dropped += 1;
				return;
			}
			if (frame.payload.byteLength === 0 || frame.payload.byteLength > 255) {
				this.rejectHandshake(
					new WebSocketTransportError(
						"E_LIMIT_EXCEEDED",
						"WebSocket role handshake is invalid",
					),
				);
				return;
			}
			const role = new TextDecoder().decode(frame.payload);
			this.setRole(role);
			let handshakeReservation: ByteReservation;
			try {
				handshakeReservation = this.reserve(
					DEFAULT_FRAME_BYTES + frame.payload.byteLength,
				);
			} catch (error) {
				this.rejectHandshake(error);
				return;
			}
			try {
				if (this.onHandshakeRole && !this.onHandshakeRole(this))
					throw new WebSocketTransportError(
						"E_LIMIT_EXCEEDED",
						"WebSocket role rejected",
					);
				this.sendHandshakeAck();
				if (this.onHandshakeAccepted && !this.onHandshakeAccepted(this))
					throw new WebSocketTransportError(
						"E_QUEUE_FULL",
						"WebSocket session accept queue is full",
					);
				this.markHandshakeComplete();
			} catch (error) {
				this.rejectHandshake(error);
			} finally {
				handshakeReservation.release();
			}
			return;
		}
		if (frame.kind === "hello-ack") {
			if (
				!this.isServer &&
				this.handshakeState === "hello-sent" &&
				frame.channelId === 0 &&
				frame.payload.byteLength === 0 &&
				frame.deliveryKind === undefined
			) {
				try {
					const reservation = this.reserve(
						DEFAULT_FRAME_BYTES + frame.payload.byteLength,
					);
					reservation.release();
					this.markHandshakeComplete();
				} catch {
					this.metrics.dropped += 1;
				}
			} else this.metrics.dropped += 1;
			return;
		}
		// A receipt is harness traffic, not an application message the peer sent
		// us to measure, so it is counted as an acknowledgement and nothing else.
		// Counting it as `serverObserved` too would inflate one stage of the
		// funnel by exactly the number of messages the other arm also acked, and
		// the whole point of the receipt is that both arms carry the same one.
		if (frame.kind === "ack") {
			this.metrics.acknowledged += 1;
			return;
		}
		this.metrics.serverObserved += 1;
		if (frame.kind === "open-uni" || frame.kind === "open-bidi") {
			const streamKind = frame.kind === "open-uni" ? "uni" : "bidi";
			if (!this.acceptsRemoteChannelId(frame.channelId)) {
				this.admission.rejectStreamAttempt();
				this.metrics.dropped += 1;
				return;
			}
			const lease = this.openStreamAdmission(streamKind);
			if (!lease) {
				this.metrics.dropped += 1;
				return;
			}
			let acceptReservation: ByteReservation;
			try {
				acceptReservation = this.reserve(
					DEFAULT_FRAME_BYTES + frame.payload.byteLength,
				);
			} catch {
				this.metrics.dropped += 1;
				lease.rollback();
				return;
			}
			const channel = new WsChannel(
				this,
				frame.channelId,
				streamKind === "bidi",
				true,
				streamKind,
				this.profile,
				this.clock,
			);
			channel.setAcceptReservation(acceptReservation);
			this.channels.set(frame.channelId, channel);
			const accepted =
				frame.kind === "open-uni"
					? this.uniAcceptQueue.tryPush(channel)
					: this.bidiAcceptQueue.tryPush(channel);
			if (!accepted) {
				this.metrics.dropped += 1;
				this.channels.delete(frame.channelId);
				lease.rollback();
				channel.closeBeforeCommit(
					new WebSocketTransportError(
						"E_QUEUE_FULL",
						"WebSocket channel accept queue is full",
					),
				);
			} else {
				lease.commit();
				this.metrics.streamsAccepted += 1;
			}
			return;
		}
		if (frame.kind === "channel-data") {
			const channel = this.channels.get(frame.channelId);
			if (!channel?.onData(frame.payload)) this.metrics.dropped += 1;
			return;
		}
		if (frame.kind === "message") {
			if (frame.deliveryKind === "datagram") {
				try {
					const decoded = decodeWireMessage(frame.payload, {
						nowMs: this.clock.nowMs(),
						rejectExpired: false,
					});
					if (decoded.payload.byteLength > this.profile.maxDatagramSize) {
						this.metrics.dropped += 1;
						return;
					}
				} catch {
					// Preserve malformed-message accounting for receiveMessage().
				}
			}
			const bytes = frame.payload.byteLength + DEFAULT_FRAME_BYTES;
			let reservation: ByteReservation;
			try {
				reservation = this.reserve(bytes);
			} catch {
				this.metrics.dropped += 1;
				return;
			}
			const entry = { frame, bytes, reservation };
			if (!this.incoming.tryPush(entry)) {
				reservation.release();
				this.metrics.dropped += 1;
				return;
			}
			this.updateQueuePeak();
			return;
		}
		const channel = this.channels.get(frame.channelId);
		if (!channel) {
			this.metrics.dropped += 1;
			return;
		}
		if (frame.kind === "channel-end") channel.onEnd();
		if (frame.kind === "channel-cancel") channel.closeRemote();
	}

	snapshot(): TransportMetrics {
		const admission = this.admission.snapshot();
		return {
			...this.metrics,
			...admission,
			active: this.active,
			queueBytes: this.ledger.sessionBytes(this.sessionKey),
			receiveQueueItems: this.incoming.length,
			receiveQueueBytes: this.incoming.bytes,
			role: this.role,
		};
	}
}

type QueuedChannelData = {
	readonly bytes: Uint8Array;
	readonly reservation: ByteReservation;
};

class WsChannel implements SendChannel, ReceiveChannel {
	private sendEnded: boolean;
	private receiveEnded: boolean;
	private locallyClosed = false;
	private streamReleased = false;
	private acceptReservation: ByteReservation | undefined;
	private readonly incoming: ByteBoundedQueue<QueuedChannelData>;

	constructor(
		private readonly session: WsSession,
		readonly channelId: number,
		private readonly sendAllowed: boolean,
		private readonly receiveAllowed: boolean,
		private readonly streamKind: "uni" | "bidi",
		profile: CapacityProfile,
		private readonly clock: TransportClock,
	) {
		this.sendEnded = !sendAllowed;
		this.receiveEnded = !receiveAllowed;
		this.incoming = new ByteBoundedQueue<QueuedChannelData>({
			maxBytes: profile.maxQueuedBytesPerStream,
			maxItems: profile.maxStreamsGlobal,
			maxWaiters: 1_024,
			sizeOf: (entry) => Math.max(1, entry.bytes.byteLength),
		});
	}

	setAcceptReservation(reservation: ByteReservation): void {
		this.acceptReservation = reservation;
	}

	releaseAcceptReservation(): void {
		this.acceptReservation?.release();
		this.acceptReservation = undefined;
	}

	async write(bytes: Uint8Array, deadlineMs: number): Promise<SendObservation> {
		if (!this.sendAllowed || this.sendEnded || this.locallyClosed)
			throw new WebSocketTransportError(
				"E_SESSION_CLOSED",
				"channel is not writable",
			);
		return this.session.sendChannelData(
			this.channelId,
			bytes.slice(),
			deadlineMs,
		);
	}

	async end(deadlineMs: number): Promise<void> {
		if (this.sendEnded || this.locallyClosed) return;
		this.sendEnded = true;
		try {
			await this.session.endChannel(this.channelId, deadlineMs);
		} finally {
			this.sessionChannelClosed();
		}
	}

	async read(deadlineMs: number): Promise<Uint8Array | null> {
		if (!this.receiveAllowed)
			throw new WebSocketTransportError(
				"E_SESSION_CLOSED",
				"channel is not readable",
			);
		if (this.receiveEnded && this.incoming.length === 0) return null;
		try {
			const result = await waitForQueue(
				this.incoming,
				this.clock,
				deadlineMs,
				"E_HANDSHAKE_TIMEOUT",
				"channel read deadline expired",
			);
			result.reservation.release();
			return result.bytes;
		} catch (error) {
			if (
				this.receiveEnded &&
				error instanceof WebSocketTransportError &&
				error.code === "E_SESSION_CLOSED"
			)
				return null;
			throw error;
		}
	}

	async cancel(deadlineMs: number): Promise<void> {
		if (this.locallyClosed) return;
		this.locallyClosed = true;
		try {
			await this.session.cancelChannel(this.channelId, deadlineMs);
		} finally {
			this.receiveEnded = true;
			this.sendEnded = true;
			this.releaseQueuedData();
			this.incoming.close(
				new WebSocketTransportError("E_SESSION_CLOSED", "channel cancelled"),
			);
			this.sessionChannelClosed();
		}
	}

	onData(bytes: Uint8Array): boolean {
		if (!this.receiveAllowed || this.locallyClosed || this.receiveEnded) {
			return false;
		}
		let reservation: ByteReservation;
		try {
			reservation = this.session.reserve(
				DEFAULT_FRAME_BYTES + bytes.byteLength,
				this.channelId,
			);
		} catch {
			return false;
		}
		if (!this.incoming.tryPush({ bytes: bytes.slice(), reservation })) {
			reservation.release();
			return false;
		}
		return true;
	}

	onEnd(): void {
		this.receiveEnded = true;
		this.releaseAcceptReservation();
		this.incoming.close();
		this.sessionChannelClosed();
	}

	closeRemote(): void {
		this.locallyClosed = true;
		this.sendEnded = true;
		this.receiveEnded = true;
		this.releaseQueuedData();
		this.releaseAcceptReservation();
		this.incoming.close(
			new WebSocketTransportError(
				"E_SESSION_CLOSED",
				"channel cancelled by peer",
			),
		);
		this.sessionChannelClosed();
	}

	closeBeforeCommit(reason?: unknown): void {
		this.locallyClosed = true;
		this.sendEnded = true;
		this.receiveEnded = true;
		this.releaseQueuedData();
		this.releaseAcceptReservation();
		this.incoming.close(reason);
	}

	closeLocal(reason?: unknown): void {
		this.locallyClosed = true;
		this.sendEnded = true;
		this.receiveEnded = true;
		this.releaseQueuedData();
		this.releaseAcceptReservation();
		this.incoming.close(reason);
		this.sessionChannelClosed();
	}

	private releaseQueuedData(): void {
		for (const entry of this.incoming.drain()) entry.reservation.release();
	}

	private sessionChannelClosed(): void {
		if (this.streamReleased) return;
		if (!this.sendEnded || !this.receiveEnded) return;
		this.streamReleased = true;
		this.session.releaseStream(this.streamKind);
	}
}

class WsServerHandle implements ServerHandle {
	private readonly pending: ByteBoundedQueue<WsSession>;
	private readonly sessions = new Set<WsSession>();
	private readonly activeSessions = new Set<WsSession>();
	private readonly socketSessions = new WeakMap<object, WsSession>();
	private stopped = false;
	private stopState: "running" | "stopping" | "stopped" = "running";
	private stopPromise: Promise<void> | undefined;
	private readonly metrics = emptyMetrics();
	private nextSessionId = 0;

	constructor(
		private readonly runtime: WebSocketServerRuntime,
		private readonly expectedRole: string | undefined,
		private readonly clock: TransportClock,
		private readonly profile: CapacityProfile,
		private readonly admission: AdmissionController,
		private readonly maxReceiveQueueBytes: number,
		private readonly maxReceiveQueueItems: number,
		private readonly receiveWaiterLimit: number,
		private readonly ledger: ByteReservationLedger,
		private readonly onStopped?: () => void,
		private readonly onStopping?: () => void,
	) {
		this.pending = new ByteBoundedQueue<WsSession>({
			maxBytes: Math.max(1, profile.maxSessions),
			maxItems: profile.maxSessions,
			maxWaiters: receiveWaiterLimit,
			sizeOf: () => 1,
		});
	}

	addSocket(socket: ServerWebSocketLike): void {
		const source = socket.remoteAddress ?? "unknown";
		if (this.stopped) {
			this.admission.rejectHandshakeAttempt();
			socket.close(1013, "server closing");
			return;
		}
		if (!this.admission.beginHandshake(source)) {
			socket.close(1013, "capacity or rate limit");
			return;
		}
		const initialRole =
			socket.data && typeof socket.data === "object" && "role" in socket.data
				? String((socket.data as { readonly role?: unknown }).role ?? "unknown")
				: "unknown";
		const session = new WsSession(
			socket,
			true,
			initialRole,
			this.profile,
			this.clock,
			this.admission,
			this.maxReceiveQueueBytes,
			this.maxReceiveQueueItems,
			this.receiveWaiterLimit,
			(closed) => {
				this.activeSessions.delete(closed);
				this.sessions.delete(closed);
				this.socketSessions.delete(socket as object);
				mergeMetrics(
					this.metrics,
					closed.snapshot() as unknown as MutableMetrics,
				);
			},
			undefined,
			undefined,
			10,
			(closed) => this.acceptIfRole(closed),
			(closed) => this.enqueueAcceptedSession(closed),
			this.ledger,
			`server-${++this.nextSessionId}`,
			2,
		);
		this.sessions.add(session);
		this.activeSessions.add(session);
		this.socketSessions.set(socket as object, session);
		this.metrics.sessionsOpened += 1;
		// The real Bun server dispatches through the handler below. Fakes may
		// expose EventTarget hooks instead; wiring both keeps close/error races
		// deterministic without requiring a local socket in tests.
		socket.addEventListener?.("message", (event) =>
			session.onSocketMessage(socketData(event)),
		);
		socket.addEventListener?.("error", (event) =>
			session.onSocketError(socketData(event)),
		);
		socket.addEventListener?.("close", (event) =>
			session.onSocketClose(socketCloseCode(event), socketCloseReason(event)),
		);
		session.startServerHandshakeTimer();
	}

	private acceptIfRole(session: WsSession): boolean {
		return !this.expectedRole || session.role === this.expectedRole;
	}

	private enqueueAcceptedSession(session: WsSession): boolean {
		let reservation: ByteReservation;
		try {
			reservation = session.reserve(DEFAULT_FRAME_BYTES);
		} catch {
			return false;
		}
		session.setAcceptReservation(reservation);
		const pushed = this.pending.tryPush(session);
		if (pushed) return true;
		session.releaseAcceptReservation();
		return false;
	}

	sessionFor(socket: ServerWebSocketLike): WsSession | undefined {
		return this.socketSessions.get(socket as object);
	}

	async acceptSession(deadlineMs: number): Promise<Session> {
		if (this.stopped)
			throw new WebSocketTransportError(
				"E_SESSION_CLOSED",
				"WebSocket server stopped",
			);
		const session = await waitForQueue(
			this.pending,
			this.clock,
			deadlineMs,
			"E_HANDSHAKE_TIMEOUT",
			"session accept deadline expired",
		);
		session.releaseAcceptReservation();
		if (!session.isActive()) return this.acceptSession(deadlineMs);
		return session;
	}

	async stop(deadlineMs: number): Promise<void> {
		if (this.stopPromise) return this.stopPromise;
		if (this.stopState === "stopped") return;
		const remaining = remainingUntilAbsoluteDeadline(
			this.clock,
			deadlineMs,
			"E_BACKPRESSURE_TIMEOUT",
			"WebSocket server stop requires a finite absolute deadline",
		);
		this.stopState = "stopping";
		this.stopped = true;
		this.onStopping?.();
		this.pending.close(
			new WebSocketTransportError(
				"E_SESSION_CLOSED",
				"WebSocket server stopped",
			),
		);
		for (const session of this.pending.drain())
			session.releaseAcceptReservation();
		const operation = (async () => {
			for (const session of [...this.activeSessions])
				await session.close(Number.POSITIVE_INFINITY);
			try {
				await this.runtime.stop(true);
			} catch {
				// Stop is best effort
			}
		})();
		let finalized = false;
		const finalize = (): void => {
			if (finalized) return;
			finalized = true;
			this.stopState = "stopped";
			this.onStopped?.();
		};
		const underlying = operation.then(
			() => {
				finalize();
			},
			(error) => {
				console.error("[ws-server-stop] operation error:", error);
				finalize();
				throw error;
			},
		);
		this.stopPromise = runWithDeadline(
			underlying,
			this.clock,
			remaining,
			deadlineError(
				"E_BACKPRESSURE_TIMEOUT",
				"WebSocket server stop deadline expired",
			),
		);
		return this.stopPromise;
	}

	snapshot(): TransportMetrics {
		const aggregate = copyMetrics(this.metrics);
		let queueBytes = 0;
		let receiveQueueBytes = 0;
		for (const session of this.sessions) {
			const snapshot = session.snapshot();
			mergeMetrics(aggregate, snapshot as unknown as MutableMetrics);
			queueBytes += snapshot.queueBytes;
			receiveQueueBytes += snapshot.receiveQueueBytes;
		}
		const admission = this.admission.snapshot();
		return {
			...aggregate,
			...admission,
			active: !this.stopped,
			queueBytes,
			receiveQueueItems: this.pending.length,
			receiveQueueBytes,
		};
	}
}

function defaultClientFactory(
	url: string,
	options: ClientWebSocketOptions,
): ClientWebSocketLike {
	const Constructor = (
		globalThis as unknown as {
			WebSocket?: new (
				url: string,
				options?: ClientWebSocketOptions,
			) => ClientWebSocketLike;
		}
	).WebSocket;
	if (!Constructor)
		throw new WebSocketTransportError(
			"E_INTERNAL",
			"global WebSocket is unavailable",
		);
	return new Constructor(url, options);
}

function defaultServerFactory(
	options: WebSocketServerRuntimeOptions,
): WebSocketServerRuntime {
	const bun = (
		globalThis as unknown as {
			Bun?: {
				serve?: (
					value: WebSocketServerRuntimeOptions,
				) => WebSocketServerRuntime;
			};
		}
	).Bun;
	if (!bun?.serve)
		throw new WebSocketTransportError("E_INTERNAL", "Bun.serve is unavailable");
	return bun.serve(options);
}

function hasTlsMaterial(value: unknown): boolean {
	if (typeof value === "string") return value.trim().length > 0;
	if (value instanceof ArrayBuffer) return value.byteLength > 0;
	if (ArrayBuffer.isView(value)) return value.byteLength > 0;
	if (Array.isArray(value))
		return value.length > 0 && value.every((item) => hasTlsMaterial(item));
	return false;
}

function mergeClientTls(tls: ClientTlsOptions | undefined): ClientTlsOptions {
	if (
		!tls ||
		tls.rejectUnauthorized !== true ||
		typeof tls.serverName !== "string" ||
		tls.serverName.trim().length === 0 ||
		!hasTlsMaterial(tls.ca)
	) {
		throw new WebSocketTransportError(
			"E_TLS",
			"WebSocket comparison requires custom CA, SNI, and rejectUnauthorized",
		);
	}
	return { ...tls, rejectUnauthorized: true };
}

function validateServerTls(tls: ServerConfig["tls"]): void {
	if (
		!tls ||
		!hasTlsMaterial(tls.cert) ||
		!hasTlsMaterial(tls.key) ||
		typeof tls.serverName !== "string" ||
		tls.serverName.trim().length === 0
	) {
		throw new WebSocketTransportError(
			"E_TLS",
			"WebSocket comparison requires server certificate, key, and SNI",
		);
	}
}

export class WebSocketAdapter implements TransportAdapter {
	readonly kind = "ws" as const;
	readonly submittedCapacityProfile: SubmittedCapacityProfile;
	private readonly profile: CapacityProfile;
	private readonly clock: TransportClock;
	private readonly clientFactory: ClientSocketFactory;
	private readonly serverFactory: WebSocketServerFactory;
	private readonly maxReceiveQueueBytes: number;
	private readonly maxReceiveQueueItems: number;
	private readonly receiveWaiterLimit: number;
	private readonly clientWatermarkPollMs: number;
	private readonly clientAdmission: AdmissionController;
	private readonly ledger: ByteReservationLedger;
	private nextClientSessionId = 0;
	private activeServer: WsServerHandle | undefined;
	private stoppingServer: WsServerHandle | undefined;

	constructor(options: WebSocketAdapterOptions = {}) {
		this.profile = freezeCapacityProfile(
			cloneCapacityProfile(
				options.capacityProfile ?? CANONICAL_CAPACITY_PROFILE,
			),
		);
		this.clock = options.clock ?? systemTransportClock;
		this.clientFactory = options.clientFactory ?? defaultClientFactory;
		this.serverFactory = options.serverFactory ?? defaultServerFactory;
		this.maxReceiveQueueBytes =
			options.maxReceiveQueueBytes ?? this.profile.maxQueuedBytesPerSession;
		this.maxReceiveQueueItems = options.maxReceiveQueueItems ?? 100_000;
		this.receiveWaiterLimit = options.receiveWaiterLimit ?? 1_024;
		this.clientWatermarkPollMs = options.clientWatermarkPollMs ?? 10;
		this.clientAdmission = new AdmissionController(this.profile, this.clock);
		this.ledger = new ByteReservationLedger(this.profile);
		this.submittedCapacityProfile = Object.freeze({
			profile: this.profile,
			bytes: canonicalJson(this.profile),
			hash: sha256Canonical(this.profile),
		});
	}

	get lastClientOptions(): ClientWebSocketOptions | undefined {
		return this._lastClientOptions;
	}

	private _lastClientOptions: ClientWebSocketOptions | undefined;

	async connect(config: ClientConfig): Promise<Session> {
		const handshakeDeadline = effectiveHandshakeDeadline(
			this.clock,
			config.deadlineMs,
			this.profile.handshakeTimeoutMs,
		);
		const admission = this.clientAdmission;
		if (!admission.beginHandshake(config.sourceKey ?? "local"))
			throw new WebSocketTransportError(
				"E_LIMIT_EXCEEDED",
				"WebSocket handshake admission limit exceeded",
			);
		let tls: ClientTlsOptions | undefined;
		try {
			if (!/^wss:\/\//iu.test(config.url))
				throw new WebSocketTransportError(
					"E_TLS",
					"WebSocket comparison requires a wss:// URL",
				);
			tls = mergeClientTls(config.tls);
		} catch (error) {
			admission.finishHandshake(false);
			throw error;
		}
		const options: ClientWebSocketOptions = Object.freeze({
			tls,
			perMessageDeflate: false,
		});
		this._lastClientOptions = options;
		let socket: ClientWebSocketLike;
		try {
			socket = this.clientFactory(config.url, options);
		} catch (error) {
			admission.finishHandshake(false);
			if (error instanceof WebSocketTransportError) throw error;
			throw new WebSocketTransportError(
				"E_TLS",
				"WebSocket client construction failed",
				{ cause: error },
			);
		}
		const session = new WsSession(
			socket,
			false,
			config.role,
			this.profile,
			this.clock,
			admission,
			this.maxReceiveQueueBytes,
			this.maxReceiveQueueItems,
			this.receiveWaiterLimit,
			undefined,
			config.clientHighWaterMark,
			config.clientLowWaterMark,
			config.clientWatermarkPollMs ?? this.clientWatermarkPollMs,
			undefined,
			undefined,
			this.ledger,
			`client-${++this.nextClientSessionId}`,
			1,
		);
		socket.binaryType = "arraybuffer";
		socket.addEventListener("message", (event) =>
			session.onSocketMessage(socketData(event)),
		);
		socket.addEventListener("error", (event) =>
			session.onSocketError(socketData(event)),
		);
		socket.addEventListener("close", (event) =>
			session.onSocketClose(socketCloseCode(event), socketCloseReason(event)),
		);
		if (socket.readyState !== 1) {
			const remaining = remainingMs(this.clock, handshakeDeadline);
			if (remaining <= 0) {
				session.rejectHandshake(
					new WebSocketTransportError(
						"E_HANDSHAKE_TIMEOUT",
						"WebSocket open deadline expired",
					),
				);
				throw deadlineError(
					"E_HANDSHAKE_TIMEOUT",
					"WebSocket open deadline expired",
				);
			}
			let openListener: EventListener | undefined;
			let openErrorListener: EventListener | undefined;
			let openCloseListener: EventListener | undefined;
			try {
				const opened = new Promise<void>((resolve, reject) => {
					openListener = (() => {
						session.markSocketOpen();
						resolve();
					}) as unknown as EventListener;
					openErrorListener = ((event: unknown) =>
						reject(
							new WebSocketTransportError("E_TLS", "WebSocket open failed", {
								cause: socketData(event),
							}),
						)) as unknown as EventListener;
					openCloseListener = (() =>
						reject(
							new WebSocketTransportError(
								"E_SESSION_CLOSED",
								"WebSocket closed before open",
							),
						)) as unknown as EventListener;
					socket.addEventListener("close", openCloseListener);
					socket.addEventListener("error", openErrorListener);
					socket.addEventListener("open", openListener);
				});
				let done = false;
				const timeout = (async () => {
					await Promise.resolve();
					if (done) return new Promise<never>(() => {});
					await this.clock.sleep(remaining);
					if (done) return new Promise<never>(() => {});
					throw deadlineError(
						"E_HANDSHAKE_TIMEOUT",
						"WebSocket open deadline expired",
					);
				})();
				await Promise.race([opened, timeout]);
			} catch (error) {
				session.rejectHandshake(error);
				throw error;
			} finally {
				if (openListener) socket.removeEventListener("open", openListener);
				if (openErrorListener)
					socket.removeEventListener("error", openErrorListener);
				if (openCloseListener)
					socket.removeEventListener("close", openCloseListener);
			}
		}
		session.markSocketOpen();
		// The role handshake is control metadata, not application admission or
		// delivery, but its short-lived bytes still obey the queue budget.
		const hello = encodeHandshakeFrame(config.role);
		let handshakeReservation: ByteReservation | undefined;
		try {
			handshakeReservation = session.reserve(hello.byteLength);
			socket.send(hello);
		} catch (error) {
			handshakeReservation?.release();
			const handshakeError =
				error instanceof WebSocketTransportError
					? error
					: new WebSocketTransportError(
							"E_SESSION_CLOSED",
							"WebSocket role handshake failed",
							{ cause: error },
						);
			session.rejectHandshake(handshakeError);
			throw handshakeError;
		}
		handshakeReservation.release();
		session.markHandshakeSent();
		await session.waitForHandshake(handshakeDeadline);
		return session;
	}

	async startServer(config: ServerConfig): Promise<ServerHandle> {
		if (this.activeServer || this.stoppingServer)
			throw new WebSocketTransportError(
				"E_LIMIT_EXCEEDED",
				"only one active WebSocket comparison server is permitted",
			);
		const profile = config.capacityProfile
			? freezeCapacityProfile(cloneCapacityProfile(config.capacityProfile))
			: this.profile;
		if (canonicalJson(profile) !== this.submittedCapacityProfile.bytes)
			throw new WebSocketTransportError(
				"E_LIMIT_EXCEEDED",
				"server capacity profile differs from the submitted canonical profile",
			);
		validateServerTls(config.tls);
		const clock = this.clock;
		const admission = new AdmissionController(profile, clock);
		let handle: WsServerHandle | undefined;
		const pendingSockets: ServerWebSocketLike[] = [];
		type PendingServerEvent =
			| { readonly kind: "message"; readonly value: unknown }
			| { readonly kind: "drain" }
			| {
					readonly kind: "close";
					readonly code: number;
					readonly reason: string;
			  }
			| { readonly kind: "error"; readonly error: unknown };
		const pendingEvents = new Map<object, PendingServerEvent[]>();
		const handler: WebSocketHandler = {
			maxPayloadLength: profile.maxQueuedBytesPerStream,
			backpressureLimit: profile.maxQueuedBytesPerSession,
			closeOnBackpressureLimit: false,
			idleTimeout: Math.ceil(profile.idleTimeoutMs / 1000),
			perMessageDeflate: false,
			open: (socket) => {
				if (handle) handle.addSocket(socket);
				else pendingSockets.push(socket);
			},
			message: (socket, value) => handleSession(socket, value),
			drain: (socket) => handleDrain(socket),
			close: (socket, code, reason) => handleClose(socket, code, reason),
			error: (socket, error) => handleError(socket, error),
		};
		const options: WebSocketServerRuntimeOptions = {
			hostname: config.hostname,
			port: config.port,
			tls: config.tls,
			websocket: handler,
			fetch: (request, server) => {
				const serverObj = server as
					| {
							upgrade?: (
								request: Request,
								options?: { data?: unknown },
							) => boolean;
					  }
					| undefined;
				if (
					serverObj?.upgrade?.call(server, request, {
						data: { role: request.headers.get("x-ws-role") ?? undefined },
					})
				)
					return undefined;
				return new Response("WebSocket upgrade required", { status: 426 });
			},
		};
		const runtime = this.serverFactory(options);
		handle = new WsServerHandle(
			runtime,
			config.role,
			clock,
			profile,
			admission,
			this.maxReceiveQueueBytes,
			this.maxReceiveQueueItems,
			this.receiveWaiterLimit,
			this.ledger,
			() => {
				if (this.activeServer === handle) this.activeServer = undefined;
				if (this.stoppingServer === handle) this.stoppingServer = undefined;
			},
			() => {
				if (this.activeServer === handle) this.activeServer = undefined;
				this.stoppingServer = handle;
			},
		);
		this.activeServer = handle;
		for (const socket of pendingSockets.splice(0)) handle.addSocket(socket);
		for (const [socket, events] of pendingEvents) {
			for (const event of events)
				dispatchServerEvent(socket as ServerWebSocketLike, event);
			pendingEvents.delete(socket);
		}
		return handle;

		function handleSession(socket: ServerWebSocketLike, value: unknown): void {
			dispatchServerEvent(socket, { kind: "message", value });
		}
		function handleDrain(socket: ServerWebSocketLike): void {
			dispatchServerEvent(socket, { kind: "drain" });
		}
		function handleClose(
			socket: ServerWebSocketLike,
			code: number,
			reason: string,
		): void {
			dispatchServerEvent(socket, { kind: "close", code, reason });
		}
		function handleError(socket: ServerWebSocketLike, error: unknown): void {
			dispatchServerEvent(socket, { kind: "error", error });
		}
		function dispatchServerEvent(
			socket: ServerWebSocketLike,
			event: PendingServerEvent,
		): void {
			const session = handle?.sessionFor(socket);
			if (!session) {
				if (!handle) {
					const events = pendingEvents.get(socket as object) ?? [];
					events.push(event);
					pendingEvents.set(socket as object, events);
				}
				return;
			}
			if (event.kind === "message") session.onSocketMessage(event.value);
			else if (event.kind === "drain") session.onDrain();
			else if (event.kind === "close")
				session.onSocketClose(event.code, event.reason);
			else session.onSocketError(event.error);
		}
	}
}

// Compatibility aliases keep the adapter discoverable to scenario runners
// without introducing a second implementation or a third-party WebSocket API.
export const BunWebSocketAdapter = WebSocketAdapter;
export const createWebSocketAdapter = (
	options?: WebSocketAdapterOptions,
): WebSocketAdapter => new WebSocketAdapter(options);
export type {
	ClientWebSocketLike,
	ServerWebSocketLike,
	WebSocketServerRuntime,
	WebSocketServerRuntimeOptions,
} from "./transport.ts";
export { WebSocketTransportError } from "./transport.ts";
