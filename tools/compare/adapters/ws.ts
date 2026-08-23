import { ByteBoundedQueue } from "../bounded-queue.ts";
import { canonicalJson, sha256Canonical } from "../canonical.ts";
import { CANONICAL_CAPACITY_PROFILE } from "../scenario-registry.ts";
import type { CapacityProfile } from "../types.ts";
import {
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

function remainingMs(clock: TransportClock, deadlineMs: number): number {
	finiteDeadline(deadlineMs);
	return deadlineMs === Number.POSITIVE_INFINITY
		? Number.POSITIVE_INFINITY
		: Math.max(0, deadlineMs - clock.nowMs());
}

function deadlineError(
	code: WebSocketTransportErrorCode,
	message: string,
): WebSocketTransportError {
	return new WebSocketTransportError(code, message);
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
	const remaining = remainingMs(clock, deadlineMs);
	if (remaining <= 0) throw deadlineError(code, message);
	const controller = new AbortController();
	const read = queue.waitForItem({ signal: controller.signal });
	let timer: Promise<never> | undefined;
	if (remaining !== Number.POSITIVE_INFINITY) {
		timer = clock.sleep(remaining).then(() => {
			controller.abort(deadlineError(code, message));
			throw deadlineError(code, message);
		});
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

async function waitForDrain(
	waiters: Array<() => void>,
	clock: TransportClock,
	deadlineMs: number,
): Promise<void> {
	if (deadlineMs === Number.POSITIVE_INFINITY) {
		throw deadlineError(
			"E_BACKPRESSURE_TIMEOUT",
			"a finite deadline is required for WebSocket drain waits",
		);
	}
	const remaining = remainingMs(clock, deadlineMs);
	if (remaining <= 0)
		throw deadlineError(
			"E_BACKPRESSURE_TIMEOUT",
			"server drain deadline expired",
		);
	if (remaining === Number.POSITIVE_INFINITY) {
		await new Promise<void>((resolve) => waiters.push(resolve));
		return;
	}
	let resolver!: () => void;
	const ready = new Promise<void>((resolve) => {
		resolver = resolve;
		waiters.push(resolve);
	});
	const timeout = clock.sleep(remaining).then(() => {
		throw deadlineError(
			"E_BACKPRESSURE_TIMEOUT",
			"server drain deadline expired",
		);
	});
	try {
		await Promise.race([ready, timeout]);
	} finally {
		const index = waiters.indexOf(resolver);
		if (index >= 0) waiters.splice(index, 1);
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

	closeSession(): void {
		this.counters.sessionsActive = Math.max(
			0,
			this.counters.sessionsActive - 1,
		);
	}

	openStream(source: string): boolean {
		this.counters.streamOpenAttempts += 1;
		const bucket = this.bucket(
			this.streamBuckets,
			source,
			this.profile.streamsPerSec,
			this.profile.streamsBurst,
		);
		const tokenAvailable = bucket.consume();
		if (
			this.streamsActive >= this.profile.maxStreamsGlobal ||
			!tokenAvailable
		) {
			this.counters.streamOpenRejected += 1;
			if (!tokenAvailable) this.counters.tokenBucketRejected += 1;
			return false;
		}
		this.streamsActive += 1;
		this.counters.streamOpenAccepted += 1;
		return true;
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

	snapshot(): AdmissionCounters {
		return { ...this.counters };
	}
}

type QueuedFrame = { readonly frame: WebSocketFrame; readonly bytes: number };

class WsSession implements Session {
	private _role: string;
	private active = true;
	private didCloseSocket = false;
	private readonly metrics: MutableMetrics = emptyMetrics();
	private readonly incoming: ByteBoundedQueue<QueuedFrame>;
	private readonly uniAcceptQueue: ByteBoundedQueue<WsChannel>;
	private readonly bidiAcceptQueue: ByteBoundedQueue<WsChannel>;
	private readonly channels = new Map<number, WsChannel>();
	private nextChannelId = 1;
	private readonly drainWaiters: Array<() => void> = [];
	private serverBlocked = false;
	private handshakeComplete = false;
	private admissionAccepted = false;
	private readonly sourceKey: string;
	private readonly clientHighWaterMark: number;
	private readonly clientLowWaterMark: number;
	private readonly clientWatermarkPollMs: number;
	private readonly onHandshakeRole?: (session: WsSession) => boolean;
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
		receiveWaiterLimit: number,
		private readonly onClosed?: (session: WsSession) => void,
		clientHighWaterMark?: number,
		clientLowWaterMark?: number,
		clientWatermarkPollMs = 10,
		onHandshakeRole?: (session: WsSession) => boolean,
	) {
		this._role = initialRole;
		if (!isServer) this.metrics.sessionsOpened = 1;
		this.clientHighWaterMark =
			clientHighWaterMark ?? profile.maxQueuedBytesPerSession;
		this.clientLowWaterMark =
			clientLowWaterMark ?? Math.floor(this.clientHighWaterMark / 2);
		this.clientWatermarkPollMs = clientWatermarkPollMs;
		this.onHandshakeRole = onHandshakeRole;
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

	get role(): string {
		return this._role;
	}

	setRole(role: string): void {
		if (role) this._role = role;
	}

	markHandshakeComplete(): void {
		if (this.handshakeComplete) return;
		this.handshakeComplete = true;
		this.admissionAccepted = true;
		this.admission.finishHandshake(true);
	}

	rejectHandshake(reason: unknown): void {
		if (this.handshakeComplete) return;
		this.handshakeComplete = true;
		this.admissionAccepted = false;
		this.admission.finishHandshake(false);
		this.closeInternal(reason, true);
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
			this.incoming.bytes,
		);
	}

	private async waitClientWatermark(deadlineMs: number): Promise<void> {
		if (this.isServer) return;
		const socket = this.socket as ClientWebSocketLike;
		const highWaterMark = Math.max(0, this.clientHighWaterMark);
		const lowWaterMark = Math.min(
			highWaterMark,
			Math.max(0, this.clientLowWaterMark),
		);
		while (socket.bufferedAmount >= highWaterMark) {
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
			if (socket.bufferedAmount <= lowWaterMark) return;
		}
	}

	private async waitServerDrain(deadlineMs: number): Promise<void> {
		if (!this.serverBlocked) return;
		try {
			await waitForDrain(this.drainWaiters, this.clock, deadlineMs);
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
	): Promise<SendObservation> {
		this.assertActive();
		if (countAttempt) this.metrics.attempted += 1;
		if (!this.isServer) await this.waitClientWatermark(deadlineMs);
		else await this.waitServerDrain(deadlineMs);
		let status: number;
		try {
			status = this.isServer
				? (this.socket as ServerWebSocketLike).send(encoded, false)
				: ((this.socket as ClientWebSocketLike).send(
						encoded,
					) as unknown as number);
			if (!this.isServer) status = encoded.byteLength;
		} catch (error) {
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

	private openStreamAdmission(kind: "uni" | "bidi"): boolean {
		const count = kind === "uni" ? this.openUniCount : this.openBidiCount;
		const limit =
			kind === "uni"
				? this.profile.maxStreamsPerSessionUni
				: this.profile.maxStreamsPerSessionBidi;
		if (count.value >= limit || !this.admission.openStream(this.sourceKey))
			return false;
		count.value += 1;
		return true;
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
		if (
			kind === "datagram" &&
			message.payload.byteLength > this.profile.maxDatagramSize
		) {
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
		);
	}

	async sendText(text: string, deadlineMs: number): Promise<SendObservation> {
		this.assertActive();
		this.metrics.attempted += 1;
		if (!this.isServer) await this.waitClientWatermark(deadlineMs);
		else await this.waitServerDrain(deadlineMs);
		let status: number;
		try {
			if (this.isServer) {
				status = (this.socket as ServerWebSocketLike).send(text, false);
			} else {
				(this.socket as ClientWebSocketLike).send(text);
				status = text.length;
			}
		} catch (error) {
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
		if (this.isServer && status === -1) this.serverBlocked = true;
		return {
			status,
			bytes: new TextEncoder().encode(text).byteLength,
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
			if (entry.frame.kind !== "message") continue;
			if (entry.frame.deliveryKind && entry.frame.deliveryKind !== kind)
				continue;
			try {
				const value = decodeWireMessage(entry.frame.payload, {
					nowMs: this.clock.nowMs(),
					rejectExpired: false,
				});
				this.metrics.delivered += 1;
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
		if (!this.openStreamAdmission("uni"))
			throw new WebSocketTransportError(
				"E_LIMIT_EXCEEDED",
				"uni stream admission limit exceeded",
			);
		const channel = new WsChannel(
			this,
			this.nextChannelId++,
			true,
			false,
			"uni",
			this.profile,
			this.clock,
		);
		this.channels.set(channel.channelId, channel);
		this.metrics.streamsOpened += 1;
		await this.sendControl(
			{ kind: "open-uni", channelId: channel.channelId },
			"reliable-message",
			deadlineMs,
		);
		return channel;
	}

	async acceptUni(deadlineMs: number): Promise<ReceiveChannel> {
		const channel = await waitForQueue(
			this.uniAcceptQueue,
			this.clock,
			deadlineMs,
			"E_HANDSHAKE_TIMEOUT",
			"uni stream accept deadline expired",
		);
		return channel;
	}

	async openBidi(
		deadlineMs: number,
		_options?: { readonly sourceKey?: string },
	): Promise<BidiChannel> {
		this.assertActive();
		if (!this.openStreamAdmission("bidi"))
			throw new WebSocketTransportError(
				"E_LIMIT_EXCEEDED",
				"bidi stream admission limit exceeded",
			);
		const channel = new WsChannel(
			this,
			this.nextChannelId++,
			true,
			true,
			"bidi",
			this.profile,
			this.clock,
		);
		this.channels.set(channel.channelId, channel);
		this.metrics.streamsOpened += 1;
		await this.sendControl(
			{ kind: "open-bidi", channelId: channel.channelId },
			"reliable-message",
			deadlineMs,
		);
		return channel;
	}

	async acceptBidi(deadlineMs: number): Promise<BidiChannel> {
		const channel = await waitForQueue(
			this.bidiAcceptQueue,
			this.clock,
			deadlineMs,
			"E_HANDSHAKE_TIMEOUT",
			"bidi stream accept deadline expired",
		);
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

	private closeInternal(reason: unknown, closeSocket: boolean): void {
		if (!this.active) return;
		this.active = false;
		this.incoming.close(reason);
		this.closeChannels(reason);
		if (!this.handshakeComplete) {
			this.handshakeComplete = true;
			this.admission.finishHandshake(false);
		} else if (this.admissionAccepted) {
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
		for (const resolve of this.drainWaiters.splice(0)) resolve();
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
			const role = new TextDecoder().decode(frame.payload);
			this.setRole(role);
			if (this.onHandshakeRole && !this.onHandshakeRole(this)) return;
			this.markHandshakeComplete();
			if (this.isServer) {
				void this.sendControl(
					{ kind: "hello-ack" },
					"reliable-message",
					this.clock.nowMs() + this.profile.backpressureTimeoutMs,
					false,
				);
			}
			return;
		}
		if (frame.kind === "hello-ack") return;
		this.metrics.serverObserved += 1;
		if (frame.kind === "open-uni" || frame.kind === "open-bidi") {
			const streamKind = frame.kind === "open-uni" ? "uni" : "bidi";
			if (!this.openStreamAdmission(streamKind)) {
				this.metrics.dropped += 1;
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
			this.channels.set(frame.channelId, channel);
			const accepted =
				frame.kind === "open-uni"
					? this.uniAcceptQueue.tryPush(channel)
					: this.bidiAcceptQueue.tryPush(channel);
			if (!accepted) {
				this.metrics.dropped += 1;
				this.channels.delete(frame.channelId);
				this.releaseStream(streamKind);
			} else this.metrics.streamsAccepted += 1;
			return;
		}
		if (frame.kind === "ack") {
			this.metrics.acknowledged += 1;
			return;
		}
		if (frame.kind === "channel-data") {
			const channel = this.channels.get(frame.channelId);
			if (!channel?.onData(frame.payload)) this.metrics.dropped += 1;
			return;
		}
		if (frame.kind === "message") {
			if (
				frame.deliveryKind === "datagram" &&
				frame.payload.byteLength >
					this.profile.maxDatagramSize + DEFAULT_FRAME_BYTES
			) {
				this.metrics.dropped += 1;
				return;
			}
			const bytes = frame.payload.byteLength + DEFAULT_FRAME_BYTES;
			const entry = { frame, bytes };
			if (!this.incoming.tryPush(entry)) {
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
			queueBytes: this.incoming.bytes,
			receiveQueueItems: this.incoming.length,
			receiveQueueBytes: this.incoming.bytes,
			role: this.role,
		};
	}
}

class WsChannel implements SendChannel, ReceiveChannel {
	private ended = false;
	private locallyClosed = false;
	private streamReleased = false;
	private readonly incoming: ByteBoundedQueue<Uint8Array>;

	constructor(
		private readonly session: WsSession,
		readonly channelId: number,
		private readonly sendAllowed: boolean,
		private readonly receiveAllowed: boolean,
		private readonly streamKind: "uni" | "bidi",
		profile: CapacityProfile,
		private readonly clock: TransportClock,
	) {
		this.incoming = new ByteBoundedQueue<Uint8Array>({
			maxBytes: profile.maxQueuedBytesPerStream,
			maxItems: profile.maxStreamsGlobal,
			maxWaiters: 1_024,
			sizeOf: (bytes) => Math.max(1, bytes.byteLength),
		});
	}

	async write(bytes: Uint8Array, deadlineMs: number): Promise<SendObservation> {
		if (!this.sendAllowed || this.ended || this.locallyClosed)
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
		if (this.ended || this.locallyClosed) return;
		this.ended = true;
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
		if (this.ended && this.incoming.length === 0) return null;
		try {
			const result = await waitForQueue(
				this.incoming,
				this.clock,
				deadlineMs,
				"E_HANDSHAKE_TIMEOUT",
				"channel read deadline expired",
			);
			return result;
		} catch (error) {
			if (
				this.ended &&
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
			this.incoming.close(
				new WebSocketTransportError("E_SESSION_CLOSED", "channel cancelled"),
			);
			this.sessionChannelClosed();
		}
	}

	onData(bytes: Uint8Array): boolean {
		if (
			!this.receiveAllowed ||
			this.locallyClosed ||
			this.ended ||
			!this.incoming.tryPush(bytes.slice())
		) {
			return false;
		}
		return true;
	}

	onEnd(): void {
		this.ended = true;
		this.incoming.close();
		this.sessionChannelClosed();
	}

	closeRemote(): void {
		this.locallyClosed = true;
		this.incoming.close(
			new WebSocketTransportError(
				"E_SESSION_CLOSED",
				"channel cancelled by peer",
			),
		);
		this.sessionChannelClosed();
	}

	closeLocal(reason?: unknown): void {
		this.locallyClosed = true;
		this.incoming.close(reason);
		this.sessionChannelClosed();
	}

	private sessionChannelClosed(): void {
		if (this.streamReleased) return;
		this.streamReleased = true;
		this.session.releaseStream(this.streamKind);
	}
}

class WsServerHandle implements ServerHandle {
	private readonly pending: ByteBoundedQueue<WsSession>;
	private readonly sessions = new Set<WsSession>();
	private readonly socketSessions = new WeakMap<object, WsSession>();
	private stopped = false;
	private readonly metrics = emptyMetrics();

	constructor(
		private readonly runtime: WebSocketServerRuntime,
		private readonly expectedRole: string | undefined,
		private readonly clock: TransportClock,
		private readonly profile: CapacityProfile,
		private readonly admission: AdmissionController,
		private readonly maxReceiveQueueBytes: number,
		private readonly maxReceiveQueueItems: number,
		private readonly receiveWaiterLimit: number,
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
				this.sessions.delete(closed);
				this.metrics.sessionsClosed += 1;
			},
			undefined,
			undefined,
			10,
			(closed) => this.acceptIfRole(closed),
		);
		this.sessions.add(session);
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
	}

	private acceptIfRole(session: WsSession): boolean {
		if (this.expectedRole && session.role !== this.expectedRole) {
			session.rejectHandshake(
				new WebSocketTransportError(
					"E_LIMIT_EXCEEDED",
					"WebSocket role rejected",
				),
			);
			return false;
		}
		if (!this.pending.tryPush(session)) {
			session.rejectHandshake(
				new WebSocketTransportError(
					"E_QUEUE_FULL",
					"session accept queue full",
				),
			);
			return false;
		}
		return true;
	}

	sessionFor(socket: ServerWebSocketLike): WsSession | undefined {
		return this.socketSessions.get(socket as object);
	}

	acceptSession(deadlineMs: number): Promise<Session> {
		if (this.stopped)
			return Promise.reject(
				new WebSocketTransportError(
					"E_SESSION_CLOSED",
					"WebSocket server stopped",
				),
			);
		return waitForQueue(
			this.pending,
			this.clock,
			deadlineMs,
			"E_HANDSHAKE_TIMEOUT",
			"session accept deadline expired",
		);
	}

	async stop(_deadlineMs: number): Promise<void> {
		if (this.stopped) return;
		this.stopped = true;
		this.pending.close(
			new WebSocketTransportError(
				"E_SESSION_CLOSED",
				"WebSocket server stopped",
			),
		);
		for (const session of this.sessions)
			await session.close(Number.POSITIVE_INFINITY);
		await this.runtime.stop(true);
	}

	snapshot(): TransportMetrics {
		const aggregate = copyMetrics(this.metrics);
		for (const session of this.sessions)
			mergeMetrics(aggregate, session.snapshot() as unknown as MutableMetrics);
		const admission = this.admission.snapshot();
		return {
			...aggregate,
			...admission,
			active: !this.stopped,
			queueBytes: this.pending.bytes,
			receiveQueueItems: this.pending.length,
			receiveQueueBytes: this.pending.bytes,
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

function mergeClientTls(
	tls: ClientTlsOptions | undefined,
): ClientTlsOptions | undefined {
	if (!tls) return undefined;
	if (tls.rejectUnauthorized !== true) {
		throw new WebSocketTransportError(
			"E_TLS",
			"WebSocket comparison requires rejectUnauthorized: true",
		);
	}
	return { ...tls, rejectUnauthorized: true };
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

	constructor(options: WebSocketAdapterOptions = {}) {
		this.profile = options.capacityProfile ?? CANONICAL_CAPACITY_PROFILE;
		this.clock = options.clock ?? systemTransportClock;
		this.clientFactory = options.clientFactory ?? defaultClientFactory;
		this.serverFactory = options.serverFactory ?? defaultServerFactory;
		this.maxReceiveQueueBytes =
			options.maxReceiveQueueBytes ?? this.profile.maxQueuedBytesPerSession;
		this.maxReceiveQueueItems = options.maxReceiveQueueItems ?? 100_000;
		this.receiveWaiterLimit = options.receiveWaiterLimit ?? 1_024;
		this.clientWatermarkPollMs = options.clientWatermarkPollMs ?? 10;
		this.clientAdmission = new AdmissionController(this.profile, this.clock);
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
		const admission = this.clientAdmission;
		if (!admission.beginHandshake(config.sourceKey ?? "local"))
			throw new WebSocketTransportError(
				"E_LIMIT_EXCEEDED",
				"WebSocket handshake admission limit exceeded",
			);
		let tls: ClientTlsOptions | undefined;
		try {
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
			const remaining = remainingMs(this.clock, config.deadlineMs);
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
			try {
				const opened = new Promise<void>((resolve, reject) => {
					openListener = (() => resolve()) as unknown as EventListener;
					openErrorListener = ((event: unknown) =>
						reject(
							new WebSocketTransportError("E_TLS", "WebSocket open failed", {
								cause: socketData(event),
							}),
						)) as unknown as EventListener;
					socket.addEventListener("open", openListener);
					socket.addEventListener("error", openErrorListener);
				});
				const timeout = this.clock.sleep(remaining).then(() => {
					throw deadlineError(
						"E_HANDSHAKE_TIMEOUT",
						"WebSocket open deadline expired",
					);
				});
				await Promise.race([opened, timeout]);
			} catch (error) {
				session.rejectHandshake(error);
				throw error;
			} finally {
				if (openListener) socket.removeEventListener("open", openListener);
				if (openErrorListener)
					socket.removeEventListener("error", openErrorListener);
			}
		}
		// The role handshake is control metadata, not application admission or
		// delivery. It is deliberately excluded from the scenario ledger.
		try {
			socket.send(encodeHandshakeFrame(config.role));
		} catch (error) {
			session.onSocketError(error);
			throw new WebSocketTransportError(
				"E_SESSION_CLOSED",
				"WebSocket role handshake failed",
				{ cause: error },
			);
		}
		session.markHandshakeComplete();
		return session;
	}

	async startServer(config: ServerConfig): Promise<ServerHandle> {
		const profile = config.capacityProfile ?? this.profile;
		const clock = this.clock;
		const admission = new AdmissionController(profile, clock);
		let handle: WsServerHandle;
		const handler: WebSocketHandler = {
			maxPayloadLength: profile.maxQueuedBytesPerStream,
			backpressureLimit: profile.maxQueuedBytesPerSession,
			closeOnBackpressureLimit: false,
			idleTimeout: Math.ceil(profile.idleTimeoutMs / 1000),
			perMessageDeflate: false,
			open: (socket) => handle.addSocket(socket),
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
				const upgrade = (
					server as {
						upgrade?: (
							request: Request,
							options?: { data?: unknown },
						) => boolean;
					}
				).upgrade;
				if (
					upgrade?.(request, {
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
		);
		return handle;

		function handleSession(socket: ServerWebSocketLike, value: unknown): void {
			handle?.sessionFor(socket)?.onSocketMessage(value);
		}
		function handleDrain(socket: ServerWebSocketLike): void {
			handle?.sessionFor(socket)?.onDrain();
		}
		function handleClose(
			socket: ServerWebSocketLike,
			code: number,
			reason: string,
		): void {
			handle?.sessionFor(socket)?.onSocketClose(code, reason);
		}
		function handleError(socket: ServerWebSocketLike, error: unknown): void {
			handle?.sessionFor(socket)?.onSocketError(error);
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
