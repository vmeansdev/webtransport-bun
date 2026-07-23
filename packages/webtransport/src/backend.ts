// Backend selection + a high-level WebTransport facade over the wasm endpoint.
//
// The native Node-API addon path stays in index.ts. In a browser / Isolated Web
// App (where `UDPSocket` exists) the wasm backend is used instead, fed by a
// `UdpTransport` (Direct Sockets in production, InMemoryRelay in tests).

import {
	WasmEndpoint,
	type WasmEndpointConstructorOptions,
	type WasmModule,
	type WasmSessionEvents,
} from "./backend-wasm.js";
import { createMonotonicDeadline } from "./deadline.js";
import {
	E_BACKPRESSURE_TIMEOUT,
	E_HANDSHAKE_TIMEOUT,
	E_INTERNAL,
	E_LIMIT_EXCEEDED,
	E_QUEUE_FULL,
	E_RATE_LIMITED,
	E_SESSION_CLOSED,
	E_SESSION_IDLE_TIMEOUT,
	E_STOP_SENDING,
	E_STREAM_RESET,
	E_TLS,
	type ErrorCode,
	WebTransportError,
} from "./errors.js";
import type { WebTransportLike, WtCloseInfo } from "./shared.js";
import type { UdpTransport } from "./wasm-relay.js";
import { WasmWebTransport } from "./wasm-webtransport.js";
import { wasmToWebTransportLike } from "./webtransport-like-wasm.js";

export { WasmWebTransport } from "./wasm-webtransport.js";

export type WasmLimitsOptions = {
	maxSessions?: number;
	maxHandshakesInFlight?: number;
	maxStreamsPerSessionBidi?: number;
	maxStreamsPerSessionUni?: number;
	maxStreamsGlobal?: number;
	maxDatagramSize?: number;
	maxQueuedBytesGlobal?: number;
	maxQueuedBytesPerSession?: number;
	maxQueuedBytesPerStream?: number;
	backpressureTimeoutMs?: number;
	handshakeTimeoutMs?: number;
	idleTimeoutMs?: number;
};

export type WasmRateLimitOptions = {
	handshakesPerSec?: number;
	handshakesBurst?: number;
	streamOpensPerSec?: number;
	streamOpensBurst?: number;
	datagramsIngressPerSec?: number;
	datagramsIngressBurst?: number;
};

export const DEFAULT_WASM_LIMITS = {
	maxSessions: 2000,
	maxHandshakesInFlight: 200,
	maxStreamsPerSessionBidi: 200,
	maxStreamsPerSessionUni: 200,
	maxStreamsGlobal: 50_000,
	maxDatagramSize: 1200,
	maxQueuedBytesGlobal: 512 * 1024 * 1024,
	maxQueuedBytesPerSession: 2 * 1024 * 1024,
	maxQueuedBytesPerStream: 256 * 1024,
	backpressureTimeoutMs: 5_000,
	handshakeTimeoutMs: 10_000,
	idleTimeoutMs: 60_000,
} as const;

export const DEFAULT_WASM_RATE_LIMITS = {
	handshakesPerSec: 20,
	handshakesBurst: 40,
	streamOpensPerSec: 200,
	streamOpensBurst: 400,
	datagramsIngressPerSec: 2000,
	datagramsIngressBurst: 5000,
} as const;

export type WasmNormalizedLimits = {
	[K in keyof typeof DEFAULT_WASM_LIMITS]: number;
};
export type WasmNormalizedRateLimits = {
	[K in keyof typeof DEFAULT_WASM_RATE_LIMITS]: number;
};

export type WasmEndpointOptions = {
	limits?: WasmLimitsOptions;
	rateLimits?: WasmRateLimitOptions;
};

export type WasmNormalizedEndpointOptions = {
	limits: WasmNormalizedLimits;
	rateLimits: WasmNormalizedRateLimits;
};

const WASM_U32_MAX = 0xffff_ffff;
const HOST_TIMER_MAX_MS = 0x7fff_ffff;
const WASM_STABLE_ERROR_CODES: readonly ErrorCode[] = [
	E_TLS,
	E_HANDSHAKE_TIMEOUT,
	E_SESSION_CLOSED,
	E_SESSION_IDLE_TIMEOUT,
	E_STREAM_RESET,
	E_STOP_SENDING,
	E_QUEUE_FULL,
	E_BACKPRESSURE_TIMEOUT,
	E_LIMIT_EXCEEDED,
	E_RATE_LIMITED,
	E_INTERNAL,
];

function wasmOperationError(
	detail: string,
	fallbackCode: ErrorCode,
	fallbackMessage: string,
	streamErrorCode: number | null = null,
): WebTransportError {
	const code =
		WASM_STABLE_ERROR_CODES.find(
			(candidate) => detail === candidate || detail.startsWith(`${candidate}:`),
		) ?? fallbackCode;
	return new WebTransportError(code, detail || `${code}: ${fallbackMessage}`, {
		streamErrorCode,
	});
}

function normalizePositiveInteger(
	name: string,
	value: number,
	maximum = WASM_U32_MAX,
): number {
	if (!Number.isFinite(value) || !Number.isInteger(value)) {
		throw new TypeError(`${name} must be a finite integer`);
	}
	if (value <= 0) {
		throw new RangeError(`${name} must be a positive integer`);
	}
	if (value > maximum) {
		const range = maximum === HOST_TIMER_MAX_MS ? "host timer" : "WASM integer";
		throw new RangeError(`${name} exceeds the supported ${range} range`);
	}
	return value;
}

export function normalizeWasmEndpointOptions(
	options: WasmEndpointOptions = {},
): WasmNormalizedEndpointOptions {
	const limits = {
		maxSessions: normalizePositiveInteger(
			"limits.maxSessions",
			options.limits?.maxSessions ?? DEFAULT_WASM_LIMITS.maxSessions,
		),
		maxHandshakesInFlight: normalizePositiveInteger(
			"limits.maxHandshakesInFlight",
			options.limits?.maxHandshakesInFlight ??
				DEFAULT_WASM_LIMITS.maxHandshakesInFlight,
		),
		maxStreamsPerSessionBidi: normalizePositiveInteger(
			"limits.maxStreamsPerSessionBidi",
			options.limits?.maxStreamsPerSessionBidi ??
				DEFAULT_WASM_LIMITS.maxStreamsPerSessionBidi,
		),
		maxStreamsPerSessionUni: normalizePositiveInteger(
			"limits.maxStreamsPerSessionUni",
			options.limits?.maxStreamsPerSessionUni ??
				DEFAULT_WASM_LIMITS.maxStreamsPerSessionUni,
		),
		maxStreamsGlobal: normalizePositiveInteger(
			"limits.maxStreamsGlobal",
			options.limits?.maxStreamsGlobal ?? DEFAULT_WASM_LIMITS.maxStreamsGlobal,
		),
		maxDatagramSize: normalizePositiveInteger(
			"limits.maxDatagramSize",
			options.limits?.maxDatagramSize ?? DEFAULT_WASM_LIMITS.maxDatagramSize,
		),
		maxQueuedBytesGlobal: normalizePositiveInteger(
			"limits.maxQueuedBytesGlobal",
			options.limits?.maxQueuedBytesGlobal ??
				DEFAULT_WASM_LIMITS.maxQueuedBytesGlobal,
		),
		maxQueuedBytesPerSession: normalizePositiveInteger(
			"limits.maxQueuedBytesPerSession",
			options.limits?.maxQueuedBytesPerSession ??
				DEFAULT_WASM_LIMITS.maxQueuedBytesPerSession,
		),
		maxQueuedBytesPerStream: normalizePositiveInteger(
			"limits.maxQueuedBytesPerStream",
			options.limits?.maxQueuedBytesPerStream ??
				DEFAULT_WASM_LIMITS.maxQueuedBytesPerStream,
		),
		backpressureTimeoutMs: normalizePositiveInteger(
			"limits.backpressureTimeoutMs",
			options.limits?.backpressureTimeoutMs ??
				DEFAULT_WASM_LIMITS.backpressureTimeoutMs,
			HOST_TIMER_MAX_MS,
		),
		handshakeTimeoutMs: normalizePositiveInteger(
			"limits.handshakeTimeoutMs",
			options.limits?.handshakeTimeoutMs ??
				DEFAULT_WASM_LIMITS.handshakeTimeoutMs,
			HOST_TIMER_MAX_MS,
		),
		idleTimeoutMs: normalizePositiveInteger(
			"limits.idleTimeoutMs",
			options.limits?.idleTimeoutMs ?? DEFAULT_WASM_LIMITS.idleTimeoutMs,
			HOST_TIMER_MAX_MS,
		),
	} as const;

	if (limits.maxQueuedBytesPerStream > limits.maxQueuedBytesPerSession) {
		throw new RangeError(
			"limits.maxQueuedBytesPerStream must be <= limits.maxQueuedBytesPerSession",
		);
	}
	if (limits.maxQueuedBytesPerSession > limits.maxQueuedBytesGlobal) {
		throw new RangeError(
			"limits.maxQueuedBytesPerSession must be <= limits.maxQueuedBytesGlobal",
		);
	}
	if (limits.maxStreamsPerSessionBidi > limits.maxStreamsGlobal) {
		throw new RangeError(
			"limits.maxStreamsPerSessionBidi must be <= limits.maxStreamsGlobal",
		);
	}
	if (limits.maxStreamsPerSessionUni > limits.maxStreamsGlobal) {
		throw new RangeError(
			"limits.maxStreamsPerSessionUni must be <= limits.maxStreamsGlobal",
		);
	}
	if (limits.handshakeTimeoutMs > limits.idleTimeoutMs) {
		throw new RangeError(
			"limits.handshakeTimeoutMs must be <= limits.idleTimeoutMs",
		);
	}

	const rateLimits = {
		handshakesPerSec: normalizePositiveInteger(
			"rateLimits.handshakesPerSec",
			options.rateLimits?.handshakesPerSec ??
				DEFAULT_WASM_RATE_LIMITS.handshakesPerSec,
		),
		handshakesBurst: normalizePositiveInteger(
			"rateLimits.handshakesBurst",
			options.rateLimits?.handshakesBurst ??
				DEFAULT_WASM_RATE_LIMITS.handshakesBurst,
		),
		streamOpensPerSec: normalizePositiveInteger(
			"rateLimits.streamOpensPerSec",
			options.rateLimits?.streamOpensPerSec ??
				DEFAULT_WASM_RATE_LIMITS.streamOpensPerSec,
		),
		streamOpensBurst: normalizePositiveInteger(
			"rateLimits.streamOpensBurst",
			options.rateLimits?.streamOpensBurst ??
				DEFAULT_WASM_RATE_LIMITS.streamOpensBurst,
		),
		datagramsIngressPerSec: normalizePositiveInteger(
			"rateLimits.datagramsIngressPerSec",
			options.rateLimits?.datagramsIngressPerSec ??
				DEFAULT_WASM_RATE_LIMITS.datagramsIngressPerSec,
		),
		datagramsIngressBurst: normalizePositiveInteger(
			"rateLimits.datagramsIngressBurst",
			options.rateLimits?.datagramsIngressBurst ??
				DEFAULT_WASM_RATE_LIMITS.datagramsIngressBurst,
		),
	} as const;

	if (rateLimits.handshakesBurst < rateLimits.handshakesPerSec) {
		throw new RangeError(
			"rateLimits.handshakesBurst must be >= rateLimits.handshakesPerSec",
		);
	}
	if (rateLimits.streamOpensBurst < rateLimits.streamOpensPerSec) {
		throw new RangeError(
			"rateLimits.streamOpensBurst must be >= rateLimits.streamOpensPerSec",
		);
	}
	if (rateLimits.datagramsIngressBurst < rateLimits.datagramsIngressPerSec) {
		throw new RangeError(
			"rateLimits.datagramsIngressBurst must be >= rateLimits.datagramsIngressPerSec",
		);
	}

	return { limits, rateLimits };
}

/**
 * Opaque ownership of one payload already charged to the Rust governor.
 * Queues move this object with the payload and release it exactly once when
 * the library no longer retains that payload.
 */
export interface WasmPayloadReservation {
	readonly bytes: number;
	readonly released: boolean;
	release(): boolean;
}

type RetainedPayload = {
	data: Uint8Array;
	reservation?: WasmPayloadReservation;
};

type RetainedStreamPayload = RetainedPayload & { fin: boolean };

type ReservationDeliveryOptions = {
	/** @internal The callback assumes ownership and must release on dequeue/drop. */
	retainReservation?: boolean;
};

function accountedReservationBytes(
	data: Uint8Array,
	reservation?: WasmPayloadReservation,
	fin = false,
): number {
	if (fin && data.length === 0) {
		return reservation?.bytes ?? 0;
	}
	return Math.max(1, reservation?.bytes ?? data.length);
}

/** True when the wasm backend should be used (Direct Sockets available). */
export function isWasmRuntime(): boolean {
	return (
		typeof (globalThis as { UDPSocket?: unknown }).UDPSocket !== "undefined"
	);
}

export type BackendKind = "native" | "wasm";

export function selectBackend(): BackendKind {
	return isWasmRuntime() ? "wasm" : "native";
}

/** A WebTransport stream surfaced through the wasm facade. */
export class WasmStream {
	private dataCb:
		| ((
				data: Uint8Array,
				fin: boolean,
				reservation?: WasmPayloadReservation,
		  ) => void)
		| null = null;
	private dataCbRetainsReservation = false;
	private resetCb: ((code: number) => void) | null = null;
	/** Reset surfaced before a consumer subscribed; replayed by onReset. */
	private pendingResetCode: number | null = null;
	private stoppedCb: ((code: number) => void) | null = null;
	private buffered: RetainedStreamPayload[] = [];
	private bufferedBytes = 0;
	/** Set when the peer STOP_SENDINGs our send half: writes will fail. */
	private stopCode: number | null = null;
	// Per-half completion, mirroring the Rust core. The manager releases this
	// handle only when BOTH halves are done, so a bidi stream that FINs its
	// recv half can still deliver a later STOP_SENDING on its live send half.
	private recvDone: boolean;
	private sendDone: boolean;

	constructor(
		private mgr: WasmTransportManager,
		readonly conn: number,
		readonly handle: number,
		readonly bidi: boolean,
		/** True for a peer-opened stream (via onStreamOpened). */
		incoming = false,
	) {
		// Uni streams have only one half live: a peer-opened uni is recv-only
		// (no send half), a self-opened uni is send-only (no recv half).
		this.recvDone = !bidi && !incoming;
		this.sendDone = !bidi && incoming;
	}

	write(data: Uint8Array): number {
		return this.mgr.endpoint.streamWrite(this.handle, data);
	}
	/**
	 * Write ALL bytes, waiting out closed flow-control windows. Unlike
	 * {@link write} (which returns the count accepted and may take less than
	 * the full chunk), this never silently drops a tail. Rejects if the stream
	 * is closed or reset mid-write.
	 */
	async writeAll(data: Uint8Array): Promise<void> {
		// wt_stream_write copies into wasm synchronously, so the FAST path (the
		// whole chunk accepted by the first write, no yield) needs no copy. Only
		// once we must yield do we snapshot the remainder, since the caller
		// regains control across the await and may reuse its buffer.
		let owned: Uint8Array | null = null;
		let off = 0;
		// Monotonic STALL deadline, re-armed on every accepted byte: the timeout
		// bounds time without progress, not total transfer time — a large chunk
		// draining slowly through a narrow flow-control window must not fail
		// while the peer keeps consuming. (Wall-clock Date.now() here made an
		// NTP step forward look like a stall.)
		let deadline = createMonotonicDeadline(
			this.mgr.options.limits.backpressureTimeoutMs,
		);
		while (off < data.length) {
			if (this.stopCode !== null) {
				throw new WebTransportError(
					E_STOP_SENDING,
					`${E_STOP_SENDING}: stream stopped by peer (code ${this.stopCode})`,
					{ streamErrorCode: this.stopCode },
				);
			}
			const view = owned ? owned.subarray(off) : data.subarray(off);
			const n = this.write(view);
			if (n < 0) {
				throw this.mgr._streamWriteError(this.conn);
			}
			if (n > 0) {
				off += n;
				deadline = createMonotonicDeadline(
					this.mgr.options.limits.backpressureTimeoutMs,
				);
			}
			if (off < data.length) {
				const remainingMs = deadline.remainingMs();
				if (remainingMs <= 0) {
					throw new WebTransportError(
						E_BACKPRESSURE_TIMEOUT,
						`${E_BACKPRESSURE_TIMEOUT}: stream write remained blocked past backpressureTimeoutMs`,
					);
				}
				if (!owned) owned = data.slice(); // snapshot once before yielding
				// Window closed — wait for real progress (next pump) instead of
				// a fixed 1ms poll, capped so a stalled peer can't hang forever.
				// The loop re-attempts the write before the deadline check, so a
				// window that opened during the wait is never thrown away.
				await this.mgr.endpoint.waitForProgress(Math.min(50, remainingMs));
			}
		}
	}
	/** Pause inbound delivery; QUIC flow control throttles the sender. */
	pause(): void {
		this.mgr.endpoint.streamPause(this.handle);
	}
	/** Resume inbound delivery after {@link pause}. */
	resume(): void {
		this.mgr.endpoint.streamResume(this.handle);
	}
	finish(): void {
		this.mgr.endpoint.streamFinish(this.handle);
		this.sendDone = true;
		this._maybeRelease();
	}
	reset(code: number): void {
		this.mgr.endpoint.streamReset(this.handle, code);
		this.sendDone = true;
		this._maybeRelease();
	}
	/** STOP_SENDING on the recv half (cancel an incoming readable). */
	stop(code: number): void {
		this.mgr.endpoint.streamStop(this.handle, code);
		this.recvDone = true;
		this._dropRetained();
		this._maybeRelease();
	}

	onData(
		cb: (
			data: Uint8Array,
			fin: boolean,
			reservation?: WasmPayloadReservation,
		) => void,
		options: ReservationDeliveryOptions = {},
	): void {
		this.dataCb = cb;
		this.dataCbRetainsReservation = options.retainReservation === true;
		const buffered = this.buffered;
		this.buffered = [];
		this.bufferedBytes = 0;
		for (let index = 0; index < buffered.length; index += 1) {
			const item = buffered[index];
			if (!item) continue;
			try {
				this._deliverData(item);
			} catch (error) {
				for (const pending of buffered.slice(index + 1)) {
					pending.reservation?.release();
				}
				throw error;
			}
		}
	}
	onReset(cb: (code: number) => void): void {
		this.resetCb = cb;
		// A reset surfaced before subscription (e.g. a recv-budget overflow on a
		// stream nobody was reading yet) must not strand a later consumer.
		if (this.pendingResetCode !== null) {
			const code = this.pendingResetCode;
			this.pendingResetCode = null;
			cb(code);
		}
	}
	/** Peer STOP_SENDING on our send half; reads continue, writes will fail. */
	onStopped(cb: (code: number) => void): void {
		this.stoppedCb = cb;
		if (this.stopCode !== null) cb(this.stopCode);
	}

	/** @internal */
	_pushData(
		data: Uint8Array,
		fin: boolean,
		reservation?: WasmPayloadReservation,
	): void {
		const retained = { data, fin, reservation };
		if (this.dataCb) {
			// A throwing consumer must not skip the fin bookkeeping: without it
			// the handle stays in mgr.streams until connection teardown.
			// (_deliverData already releases the reservation on the throw path.)
			try {
				this._deliverData(retained);
			} finally {
				if (fin) {
					this.recvDone = true;
					this._maybeRelease();
				}
			}
			return;
		}
		const nextBytes =
			this.bufferedBytes + accountedReservationBytes(data, reservation, fin);
		if (nextBytes > this.mgr.options.limits.maxQueuedBytesPerStream) {
			reservation?.release();
			this.mgr._reportResourceError(
				new Error("E_QUEUE_FULL: maxQueuedBytesPerStream reached"),
			);
			this._failInboundPressure();
			return;
		}
		this.buffered.push(retained);
		this.bufferedBytes = nextBytes;
		if (fin) {
			this.recvDone = true;
			this._maybeRelease();
		}
	}
	/**
	 * @internal Recv-budget failure (queue overflow or a failed host-reservation
	 * adoption): fail the recv half CLOSED instead of silently dropping payload
	 * bytes — if JS/Rust accounting ever drift, a live stream missing bytes is
	 * silent data corruption. STOP_SENDING tells the peer; the reset surfaced
	 * here (buffered chunks are still delivered first on a late onData
	 * subscribe) errors the consumer instead of hanging it until idle timeout.
	 */
	_failInboundPressure(): void {
		if (this.recvDone) return;
		this.mgr.endpoint.streamStop(this.handle, 0);
		this.recvDone = true;
		this._surfaceReset(0);
		this._maybeRelease();
	}
	/** Deliver a reset now, or park it for the eventual onReset subscriber. */
	private _surfaceReset(code: number): void {
		if (this.resetCb) this.resetCb(code);
		else this.pendingResetCode = code;
	}
	/** @internal */
	_pushReset(code: number): void {
		this._dropRetained();
		// Park for a late subscriber like every other reset path — a peer reset
		// arriving before onReset must error the eventual consumer, not vanish.
		this._surfaceReset(code);
		// A reset ends the recv half. On connection teardown the manager also
		// force-releases, so mark the send half done too to guarantee release.
		this.recvDone = true;
		this._maybeRelease();
	}
	/** @internal */
	_pushStopped(code: number): void {
		if (this.stopCode === null) {
			this.stopCode = code;
			this.stoppedCb?.(code);
		}
		this.sendDone = true;
		this._maybeRelease();
	}
	/**
	 * @internal Called when the underlying connection closes. Errors the
	 * readable ONLY if its recv half was still live (a cleanly-FINed stream is
	 * already settled and must not get a spurious reset), then releases.
	 */
	_closeFromConnection(code: number): void {
		this._dropRetained();
		if (!this.recvDone) {
			this.recvDone = true;
			// Same parking rule as _pushReset: a consumer subscribing after the
			// connection died must still observe the failure.
			this._surfaceReset(code);
		}
		this.sendDone = true;
		this.mgr._releaseStream(this.handle);
	}

	/** @internal Release from the manager's map once both halves are done. */
	private _maybeRelease(): void {
		if (this.recvDone && this.sendDone) this.mgr._releaseStream(this.handle);
	}

	/** @internal Release every payload still retained before a consumer. */
	_dropRetained(): void {
		for (const item of this.buffered) item.reservation?.release();
		this.buffered = [];
		this.bufferedBytes = 0;
	}

	// INVARIANT (double-release safety): when a callback throws, the release
	// here runs first and the rethrow then reaches dispatchDecodedWasmEvent's
	// catch, which releases the same RAW token id again. That second release is
	// a safe no-op ONLY because both happen synchronously in the same dispatch
	// — no wt_poll_event (and thus no Rust-side token allocation) can interleave,
	// so the id cannot yet have been reused for a different live reservation.
	// (Rust reuses freed token ids; see backend-wasm.ts dispatchDecodedWasmEvent.)
	private _deliverData(item: RetainedStreamPayload): void {
		const callback = this.dataCb;
		if (!callback) return;
		if (this.dataCbRetainsReservation) {
			try {
				callback(item.data, item.fin, item.reservation);
			} catch (error) {
				item.reservation?.release();
				throw error;
			}
			return;
		}
		try {
			callback(item.data, item.fin);
		} finally {
			item.reservation?.release();
		}
	}
}

/** A WebTransport session (one QUIC connection) through the wasm facade. */
export class WasmSession {
	/** Resolves once established; REJECTS if the connection fails first. */
	readonly ready: Promise<void>;
	/** Resolves with close info after establishment, rejects if connect fails. */
	readonly closed: Promise<WtCloseInfo>;
	private resolveReady!: () => void;
	private rejectReady!: (err: Error) => void;
	private resolveClosed!: (info: WtCloseInfo) => void;
	private rejectClosed!: (err: Error) => void;
	private isClosed = false;
	private closeRequested = false;
	private established = false;
	private datagramCb:
		| ((data: Uint8Array, reservation?: WasmPayloadReservation) => void)
		| null = null;
	private datagramCbRetainsReservation = false;
	private datagramQueue: RetainedPayload[] = [];
	private datagramQueuedBytes = 0;
	private incomingCb: ((stream: WasmStream) => void) | null = null;
	private incomingQueue: WasmStream[] = [];

	constructor(
		private mgr: WasmTransportManager,
		readonly conn: number,
		private readonly configuredMaxDatagramSize: number,
	) {
		this.ready = new Promise((res, rej) => {
			this.resolveReady = res;
			this.rejectReady = rej;
		});
		// A failed connect rejects `ready`; fire-and-forget consumers that only
		// use `closed` must not die of an unhandled rejection.
		this.ready.catch(() => {});
		this.closed = new Promise((res, rej) => {
			this.resolveClosed = res;
			this.rejectClosed = rej;
		});
		this.closed.catch(() => {});
	}

	get maxDatagramSize(): number {
		return this.mgr._effectiveMaxDatagramSize(
			this.conn,
			this.configuredMaxDatagramSize,
		);
	}

	async sendDatagram(data: Uint8Array): Promise<void> {
		this.assertOpen("send a datagram");
		if (data.byteLength > this.maxDatagramSize) {
			throw new WebTransportError(
				E_LIMIT_EXCEEDED,
				`${E_LIMIT_EXCEEDED}: maxDatagramSize exceeded`,
			);
		}
		if (!this.mgr.endpoint.sendDatagram(this.conn, data)) {
			throw this.mgr._datagramSendError(this.conn);
		}
	}

	/**
	 * Close THIS session's connection (CONNECTION_CLOSE to the peer). Other
	 * sessions on the same endpoint are unaffected.
	 */
	close(info?: WtCloseInfo): void {
		if (this.isClosed || this.closeRequested) return;
		this.closeRequested = true;
		this.mgr.closeSession(this, info);
	}
	onDatagram(
		cb: (data: Uint8Array, reservation?: WasmPayloadReservation) => void,
		options: ReservationDeliveryOptions = {},
	): void {
		this.datagramCb = cb;
		this.datagramCbRetainsReservation = options.retainReservation === true;
		const datagrams = this.datagramQueue;
		this.datagramQueue = [];
		this.datagramQueuedBytes = 0;
		for (let index = 0; index < datagrams.length; index += 1) {
			const item = datagrams[index];
			if (!item) continue;
			try {
				this._deliverDatagram(item);
			} catch (error) {
				for (const pending of datagrams.slice(index + 1)) {
					pending.reservation?.release();
				}
				throw error;
			}
		}
	}

	createBidirectionalStream(): WasmStream {
		this.assertOpen("create a bidirectional stream");
		return this.mgr.openStream(this, true);
	}
	createUnidirectionalStream(): WasmStream {
		this.assertOpen("create a unidirectional stream");
		return this.mgr.openStream(this, false);
	}
	onIncomingStream(cb: (stream: WasmStream) => void): void {
		this.incomingCb = cb;
		for (const s of this.incomingQueue) cb(s);
		this.incomingQueue = [];
	}

	/** @internal */
	_markEstablished(): void {
		if (!this.established) {
			this.established = true;
			this.resolveReady();
		}
	}
	/** @internal */
	_markClosed(info: WtCloseInfo, errorDetail = ""): void {
		if (!this.isClosed) {
			this.isClosed = true;
			this._dropRetained();
			if (!this.established) {
				const error = wasmOperationError(
					errorDetail ||
						`${E_SESSION_CLOSED}: connection closed before session established (code ${info.code ?? 0})`,
					E_SESSION_CLOSED,
					"connection closed before session established",
				);
				this.rejectReady(error);
				this.rejectClosed(error);
				return;
			}
			this.resolveClosed(info);
		}
	}
	/** @internal */
	_pushDatagram(
		data: Uint8Array,
		reservation?: WasmPayloadReservation,
	): boolean {
		const retained = { data, reservation };
		if (this.datagramCb) {
			this._deliverDatagram(retained);
			return true;
		}
		const nextBytes =
			this.datagramQueuedBytes + accountedReservationBytes(data, reservation);
		if (nextBytes > this.mgr.options.limits.maxQueuedBytesPerSession) {
			reservation?.release();
			this.mgr._reportResourceError(
				new Error("E_QUEUE_FULL: maxQueuedBytesPerSession reached"),
			);
			return false;
		}
		this.datagramQueue.push(retained);
		this.datagramQueuedBytes = nextBytes;
		return true;
	}
	/** @internal */
	_pushIncomingStream(stream: WasmStream): void {
		if (this.incomingCb) {
			this.incomingCb(stream);
			return;
		}
		const queuedOfKind = this.incomingQueue.filter(
			(candidate) => candidate.bidi === stream.bidi,
		).length;
		const limit = stream.bidi
			? this.mgr.options.limits.maxStreamsPerSessionBidi
			: this.mgr.options.limits.maxStreamsPerSessionUni;
		if (queuedOfKind >= limit) {
			stream.stop(0);
			if (stream.bidi) stream.reset(0);
			this.mgr._reportResourceError(
				new Error(
					`E_LIMIT_EXCEEDED: ${stream.bidi ? "maxStreamsPerSessionBidi" : "maxStreamsPerSessionUni"} reached`,
				),
			);
			return;
		}
		this.incomingQueue.push(stream);
	}

	/** @internal Release payloads/streams never handed to an application. */
	_dropRetained(): void {
		for (const item of this.datagramQueue) item.reservation?.release();
		this.datagramQueue = [];
		this.datagramQueuedBytes = 0;
		// The manager owns and tears down the underlying handles; the session must
		// still drop its pre-subscribe references so a user-held closed session
		// cannot retain every incoming stream object indefinitely.
		this.incomingQueue = [];
	}

	private _deliverDatagram(item: RetainedPayload): void {
		const callback = this.datagramCb;
		if (!callback) return;
		if (this.datagramCbRetainsReservation) {
			try {
				callback(item.data, item.reservation);
			} catch (error) {
				item.reservation?.release();
				throw error;
			}
			return;
		}
		try {
			callback(item.data);
		} finally {
			item.reservation?.release();
		}
	}

	private assertOpen(operation: string): void {
		if (!this.isClosed && !this.closeRequested) return;
		throw new WebTransportError(
			E_SESSION_CLOSED,
			`${E_SESSION_CLOSED}: cannot ${operation} after session close`,
		);
	}
}

class ManagerHostReservation implements WasmPayloadReservation {
	private isReleased = false;

	constructor(
		private readonly manager: WasmTransportManager,
		readonly conn: number,
		readonly stream: number | undefined,
		readonly token: number,
		readonly bytes: number,
	) {}

	get released(): boolean {
		return this.isReleased;
	}

	release(): boolean {
		if (this.isReleased) return false;
		this.isReleased = true;
		return this.manager._releaseHostReservation(this);
	}
}

/**
 * Owns one wasm endpoint and routes its events to per-connection sessions and
 * per-handle streams. Used for both the client (single session) and server
 * (one session per accepted connection) facades.
 */
export class WasmTransportManager {
	readonly endpoint: WasmEndpoint;
	private sessions = new Map<number, WasmSession>();
	private streams = new Map<number, WasmStream>();
	private onSession: ((session: WasmSession) => void) | null;
	/** Transport the manager owns and closes on {@link close}, if any. */
	private ownedTransport: UdpTransport | null = null;
	readonly options: WasmNormalizedEndpointOptions;
	private hostReservations = new Set<ManagerHostReservation>();
	private hostQueuedBytesGlobal = 0;
	private hostQueuedBytesPerSession = new Map<number, number>();
	private hostQueuedBytesPerStream = new Map<number, number>();
	private hostResourceError = "";
	private closeResourceSnapshot: ReturnType<
		WasmTransportManager["_currentResourceSnapshot"]
	> | null = null;

	private constructor(
		isServer: boolean,
		onSession: ((session: WasmSession) => void) | null,
		options: WasmNormalizedEndpointOptions,
		makeEndpoint: (events: WasmSessionEvents) => WasmEndpoint,
	) {
		this.onSession = onSession;
		this.options = options;
		const events: WasmSessionEvents = {
			onEstablished: (conn) => {
				const s = this.ensureSession(conn);
				s._markEstablished();
				if (isServer) this.onSession?.(s);
			},
			onDatagram: (conn, data, hostToken) => {
				// Use get, not ensureSession: a datagram surfaced after the
				// session was already closed/deleted (final drain on a graceful
				// end) must NOT resurrect a zombie session no consumer holds.
				if (!hostToken) {
					this._reportResourceError(
						new Error("E_INTERNAL: datagram payload missing host reservation"),
					);
					return;
				}
				const reservation = this._adoptHostReservation(
					conn,
					undefined,
					hostToken,
					data.length,
				);
				if (!reservation) {
					this._closeSessionForInboundPressure(conn);
					return;
				}
				const session = this.sessions.get(conn);
				if (!session) {
					reservation.release();
					return;
				}
				if (!session._pushDatagram(data, reservation)) {
					this._closeSessionForInboundPressure(conn);
				}
			},
			onClosed: (conn, code) => {
				const detail = this.endpoint.takeLastError();
				this.ensureSession(conn)._markClosed(
					{ code, reason: detail || undefined },
					detail,
				);
				this._releaseConnectionHostReservations(conn);
				// Settle and release everything belonging to this connection.
				// _closeFromConnection errors only readers still live (a
				// cleanly-FINed stream stays settled), avoiding a spurious reset.
				// A throwing user onReset callback must not abort cleanup of the
				// remaining streams, so isolate each one.
				for (const [handle, ws] of this.streams) {
					if (ws.conn === conn) {
						try {
							ws._closeFromConnection(code);
						} catch (err) {
							this.onCallbackError?.(err);
						}
						this.streams.delete(handle);
					}
				}
				this.sessions.delete(conn);
			},
			onStreamOpened: (conn, stream, bidi) => {
				const s = this.ensureSession(conn);
				const ws = new WasmStream(this, conn, stream, bidi, true);
				this.streams.set(stream, ws);
				s._pushIncomingStream(ws);
			},
			onStreamData: (_conn, stream, data, fin, hostToken) => {
				// The stream releases itself from the map once BOTH halves are
				// done (see WasmStream._maybeRelease); deleting on fin here would
				// drop a later STOP_SENDING for a still-open bidi send half.
				if (!hostToken) {
					this._reportResourceError(
						new Error("E_INTERNAL: stream payload missing host reservation"),
					);
					return;
				}
				const reservation = this._adoptHostReservation(
					_conn,
					stream,
					hostToken,
					data.length,
					fin,
				);
				if (!reservation) {
					// Adoption failed (budget exhausted; _adoptHostReservation already
					// released the host token, exactly once). Fail closed like the
					// datagram path: dropping these bytes while leaving the stream
					// readable would be silent data corruption if JS/Rust accounting
					// ever drift.
					this.streams.get(stream)?._failInboundPressure();
					return;
				}
				const target = this.streams.get(stream);
				if (target) target._pushData(data, fin, reservation);
				else reservation?.release();
			},
			onStreamReset: (_conn, stream, code) => {
				this.streams.get(stream)?._pushReset(code);
			},
			onStreamStopped: (_conn, stream, code) => {
				// Send half rejected by the peer; reads (if bidi) continue.
				this.streams.get(stream)?._pushStopped(code);
			},
		};
		this.endpoint = makeEndpoint(events);
		// A throwing user callback is contained by the pump and surfaced here
		// instead of crashing the UDP data handler / stalling the endpoint.
		this.endpoint.onError = (err) => {
			if (this.onCallbackError) this.onCallbackError(err);
			else console.error("wasm transport: event callback threw:", err);
		};
	}

	/** Optional hook for exceptions thrown by user event callbacks. */
	onCallbackError: ((err: unknown) => void) | null = null;

	/** @internal Adopt, without copying, a Rust reservation transferred to JS. */
	_adoptHostReservation(
		conn: number,
		stream: number | undefined,
		token: number,
		bytes: number,
		fin = false,
	): WasmPayloadReservation | undefined {
		const accountedBytes = fin && bytes === 0 ? 0 : Math.max(1, bytes);
		const nextGlobal = this.hostQueuedBytesGlobal + accountedBytes;
		const nextSession =
			(this.hostQueuedBytesPerSession.get(conn) ?? 0) + accountedBytes;
		const nextStream =
			stream === undefined
				? 0
				: (this.hostQueuedBytesPerStream.get(stream) ?? 0) + accountedBytes;
		let error = "";
		if (nextGlobal > this.options.limits.maxQueuedBytesGlobal) {
			error = "E_QUEUE_FULL: maxQueuedBytesGlobal reached";
		} else if (nextSession > this.options.limits.maxQueuedBytesPerSession) {
			error = "E_QUEUE_FULL: maxQueuedBytesPerSession reached";
		} else if (
			stream !== undefined &&
			nextStream > this.options.limits.maxQueuedBytesPerStream
		) {
			error = "E_QUEUE_FULL: maxQueuedBytesPerStream reached";
		}
		if (error) {
			this.endpoint.releaseHostReservation(token);
			this._reportResourceError(new Error(error));
			return undefined;
		}

		const reservation = new ManagerHostReservation(
			this,
			conn,
			stream,
			token,
			accountedBytes,
		);
		this.hostReservations.add(reservation);
		this.hostQueuedBytesGlobal = nextGlobal;
		this.hostQueuedBytesPerSession.set(conn, nextSession);
		if (stream !== undefined)
			this.hostQueuedBytesPerStream.set(stream, nextStream);
		return reservation;
	}

	/** @internal Release the one Rust token and all mirrored host counters. */
	_releaseHostReservation(reservation: ManagerHostReservation): boolean {
		if (!this.hostReservations.delete(reservation)) return false;
		this.hostQueuedBytesGlobal = Math.max(
			0,
			this.hostQueuedBytesGlobal - reservation.bytes,
		);
		this._decrementHostBytes(
			this.hostQueuedBytesPerSession,
			reservation.conn,
			reservation.bytes,
		);
		if (reservation.stream !== undefined) {
			this._decrementHostBytes(
				this.hostQueuedBytesPerStream,
				reservation.stream,
				reservation.bytes,
			);
		}
		return this.endpoint.releaseHostReservation(reservation.token);
	}

	/** @internal Surface a stable host-side governor failure. */
	_reportResourceError(error: unknown): void {
		this.hostResourceError =
			error instanceof Error ? error.message : String(error);
		this.onCallbackError?.(error);
	}

	/** Return and clear the latest stable host-governor diagnostic. */
	takeResourceError(): string {
		const error = this.hostResourceError;
		this.hostResourceError = "";
		return error;
	}

	/** @internal Translate a failed Rust datagram send into a stable public error. */
	_datagramSendError(conn: number): WebTransportError {
		return wasmOperationError(
			this.endpoint.takeDatagramSendError(),
			this.sessions.has(conn) ? E_QUEUE_FULL : E_SESSION_CLOSED,
			"datagram send failed because the queue or session is unavailable",
		);
	}

	/** @internal Resolve the live negotiated/path cap without exceeding config. */
	_effectiveMaxDatagramSize(conn: number, configured: number): number {
		const effective = this.endpoint.maxDatagramSize(conn);
		return Number.isSafeInteger(effective) && effective >= 0
			? Math.min(configured, effective)
			: configured;
	}

	/** @internal Translate a failed Rust stream write into a stable public error. */
	_streamWriteError(conn: number): WebTransportError {
		return wasmOperationError(
			this.endpoint.takeStreamWriteError(),
			this.sessions.has(conn) ? E_STREAM_RESET : E_SESSION_CLOSED,
			"stream write failed because the stream or session is closed",
		);
	}

	/** Current combined Rust-to-host retained-payload accounting. */
	resourceSnapshot(): {
		hostReservationsActive: number;
		hostQueuedBytesGlobal: number;
		rustQueuedBytesGlobal: number;
		rustHostTokensActive: number;
	} {
		return this.closeResourceSnapshot ?? this._currentResourceSnapshot();
	}

	private _currentResourceSnapshot() {
		let rust: { queuedBytesGlobal?: number; hostTokensActive?: number } = {};
		try {
			rust = JSON.parse(this.endpoint.governorSnapshot());
		} catch {
			// A malformed diagnostic snapshot must not break teardown.
		}
		return {
			hostReservationsActive: this.hostReservations.size,
			hostQueuedBytesGlobal: this.hostQueuedBytesGlobal,
			rustQueuedBytesGlobal: rust.queuedBytesGlobal ?? 0,
			rustHostTokensActive: rust.hostTokensActive ?? 0,
		};
	}

	private _decrementHostBytes(
		map: Map<number, number>,
		key: number,
		bytes: number,
	): void {
		const next = (map.get(key) ?? 0) - bytes;
		if (next <= 0) map.delete(key);
		else map.set(key, next);
	}

	static create(
		wasm: WasmModule,
		udp: UdpTransport,
		isServer: boolean,
		addr: string,
		peerAddr: string,
		onSession: ((session: WasmSession) => void) | null,
		options: WasmNormalizedEndpointOptions,
		certHashesBase64?: string,
	): WasmTransportManager {
		const constructorOptions: WasmEndpointConstructorOptions = options;
		return new WasmTransportManager(isServer, onSession, options, (events) =>
			!isServer && certHashesBase64
				? WasmEndpoint.createPinnedClient(
						wasm,
						udp,
						addr,
						peerAddr,
						certHashesBase64,
						constructorOptions,
						events,
					)
				: WasmEndpoint.create(
						wasm,
						udp,
						isServer,
						addr,
						peerAddr,
						constructorOptions,
						events,
					),
		);
	}

	/** Wrap an endpoint already created wasm-side (e.g. via wt_new_server). */
	static adopt(
		wasm: WasmModule,
		udp: UdpTransport,
		eid: number,
		onSession: (session: WasmSession) => void,
		options: WasmNormalizedEndpointOptions,
	): WasmTransportManager {
		return new WasmTransportManager(true, onSession, options, (events) =>
			WasmEndpoint.adopt(wasm, udp, eid, events),
		);
	}

	private ensureSession(conn: number): WasmSession {
		let s = this.sessions.get(conn);
		if (!s) {
			s = new WasmSession(this, conn, this.options.limits.maxDatagramSize);
			this.sessions.set(conn, s);
		}
		return s;
	}

	/** @internal */
	openStream(session: WasmSession, bidi: boolean): WasmStream {
		const handle = this.endpoint.openStream(session.conn, bidi);
		if (handle < 0) {
			const detail = this.endpoint.takeLastError();
			throw wasmOperationError(
				detail,
				E_SESSION_CLOSED,
				"openStream failed because the session is unavailable",
			);
		}
		const ws = new WasmStream(this, session.conn, handle, bidi, false);
		this.streams.set(handle, ws);
		return ws;
	}

	/** @internal Remove a stream whose both halves are complete. */
	_releaseStream(handle: number): void {
		this.streams.delete(handle);
	}

	connectClient(authority: string): WasmSession {
		const conn = this.endpoint.connect(authority);
		if (conn <= 0) {
			// wt_connect returns a non-positive sentinel for a closed endpoint,
			// server endpoint, or rejected params. No
			// Rust connection exists, so `ready` would hang. Fail it eagerly.
			const detail = this.endpoint.takeLastError();
			throw wasmOperationError(
				detail,
				E_SESSION_CLOSED,
				"wasm connect failed because the endpoint rejected the connection",
			);
		}
		return this.ensureSession(conn);
	}

	/** @internal Close one session's connection; the endpoint stays up. */
	closeSession(session: WasmSession, info?: WtCloseInfo): void {
		this.endpoint.closeConn(session.conn, info?.code ?? 0, info?.reason ?? "");
	}

	private _releaseConnectionHostReservations(conn: number): void {
		for (const reservation of [...this.hostReservations]) {
			if (reservation.conn === conn) reservation.release();
		}
	}

	private _closeSessionForInboundPressure(conn: number): void {
		const detail =
			this.hostResourceError ||
			"E_QUEUE_FULL: inbound datagram delivery budget exhausted";
		this.sessions.get(conn)?._markClosed({ code: 0, reason: detail }, detail);
		this._releaseConnectionHostReservations(conn);
		this.endpoint.closeConn(conn, 0, detail);
	}

	/** Take ownership of a transport so {@link close} releases its socket. */
	ownTransport(udp: UdpTransport): void {
		this.ownedTransport = udp;
	}

	/**
	 * Shut down the endpoint: CONNECTION_CLOSE every session, drop wasm state,
	 * and close an owned transport so its UDP socket/port is released.
	 *
	 * INFALLIBLE by contract: teardown must never throw. A step that throws
	 * would mask the caller's original error (e.g. the connect failure that
	 * triggered this close) and skip the steps after it — every phase is
	 * isolated and reported instead of propagated.
	 */
	close(): void {
		const guard = (step: () => void) => {
			try {
				step();
			} catch (error) {
				try {
					this._reportResourceError(error);
				} catch {
					// onCallbackError hook threw while reporting — nothing left
					// to report to; teardown continues regardless.
				}
			}
		};
		guard(() => this.endpoint.beginClose());
		for (const session of this.sessions.values()) {
			guard(() => session._markClosed({ code: 0, reason: "endpoint closed" }));
		}
		for (const stream of this.streams.values()) {
			guard(() => stream._dropRetained());
		}
		for (const reservation of [...this.hostReservations]) {
			guard(() => reservation.release());
		}
		this.sessions.clear();
		this.streams.clear();
		// First close wins: a second close() runs after finishClose() freed the
		// endpoint, so governorSnapshot() would report zeros and clobber the
		// diagnostic captured at real teardown time.
		guard(() => {
			this.closeResourceSnapshot ??= this._currentResourceSnapshot();
		});
		guard(() => this.endpoint.finishClose());
		guard(() => this.ownedTransport?.close?.());
		this.ownedTransport = null;
	}
}

/** Options for {@link connectWasm} / {@link connectWasmUnified}. */
export interface WasmConnectOptions {
	/**
	 * Comma-separated base64 SHA-256 cert hashes to pin (the `hashBase64` from
	 * `serveOverUdp`/`wt_generate_cert`) — the browser's
	 * `serverCertificateHashes` trust model. STRONGLY recommended: without it
	 * the client accepts ANY server certificate.
	 */
	certHashBase64?: string;
	limits?: WasmLimitsOptions;
	rateLimits?: WasmRateLimitOptions;
}

/** Client: connect to a WebTransport server over the given UDP transport. */
export async function connectWasm(
	wasm: WasmModule,
	udp: UdpTransport,
	authority: string,
	addr = "127.0.0.1:0",
	peerAddr = "127.0.0.1:443",
	opts: WasmConnectOptions = {},
): Promise<{ session: WasmSession; manager: WasmTransportManager }> {
	const normalized = normalizeWasmEndpointOptions(opts);
	const mgr = WasmTransportManager.create(
		wasm,
		udp,
		false,
		addr,
		peerAddr,
		null,
		normalized,
		opts.certHashBase64,
	);
	// connectClient can throw SYNCHRONOUSLY (rejected authority, wt_connect
	// failure) — it must sit inside the try so the endpoint, the transport's
	// onPacket subscription, and any armed timer are torn down on that path too.
	try {
		const session = mgr.connectClient(authority);
		await session.ready;
		return { session, manager: mgr };
	} catch (err) {
		// close() is infallible by contract, but the original connect error must
		// win even if that contract regresses — never let teardown mask it or
		// skip the transport release below.
		try {
			mgr.close();
		} catch {}
		// The connect failed and we're throwing, so the caller can't get the
		// transport back — release it here to avoid leaking its socket/read loop.
		// (mgr.close() only closes a transport the manager itself owns.)
		try {
			udp.close?.();
		} catch {}
		throw err;
	}
}

/** Server: accept WebTransport sessions over the given UDP transport. */
export function createWasmServer(
	wasm: WasmModule,
	udp: UdpTransport,
	onSession: (session: WasmSession) => void,
	addr = "0.0.0.0:443",
	peerAddr = "127.0.0.1:0",
	opts: WasmEndpointOptions = {},
): WasmTransportManager {
	const normalized = normalizeWasmEndpointOptions(opts);
	return WasmTransportManager.create(
		wasm,
		udp,
		true,
		addr,
		peerAddr,
		onSession,
		normalized,
	);
}

/**
 * Browser/IWA convenience: serve WebTransport over a Direct Sockets UDPSocket.
 * Returns the manager and the `serverCertificateHashes` value clients must pin.
 * `bind` is `(localAddress, localPort) => Promise<UdpTransport>` — pass
 * `DirectSocketsUdpTransport.bind` (kept injectable so the package core has no
 * hard dependency on the browser-only module).
 */
export async function serveOverUdp(
	wasm: WasmModule,
	bind: (localAddress: string, localPort: number) => Promise<UdpTransport>,
	opts: {
		localAddress?: string;
		localPort: number;
		commonName?: string;
		validityDays?: number;
		onSession: (session: WasmSession) => void;
	} & WasmEndpointOptions,
): Promise<{ manager: WasmTransportManager; certHashBase64: string }> {
	const normalized = normalizeWasmEndpointOptions(opts);
	const udp = await bind(opts.localAddress ?? "0.0.0.0", opts.localPort);
	const notBefore = Math.floor(Date.now() / 1000) - 3600;
	const json = wasm.wt_new_server_with_options(
		JSON.stringify({
			addr: `${opts.localAddress ?? "0.0.0.0"}:${opts.localPort}`,
			peerAddr: "127.0.0.1:0",
			commonName: opts.commonName ?? "localhost",
			validityDays: opts.validityDays ?? 14,
			notBeforeUnix: notBefore,
			...normalized,
		}),
	);
	const parsed = JSON.parse(json) as {
		eid?: number;
		hashBase64?: string;
		error?: string;
	};
	if (parsed.error || parsed.eid == null || parsed.hashBase64 == null) {
		// Release the socket we just bound before failing, or the port leaks.
		udp.close?.();
		throw new Error(`wt_new_server failed: ${parsed.error ?? "unknown"}`);
	}
	const manager = WasmTransportManager.adopt(
		wasm,
		udp,
		parsed.eid,
		opts.onSession,
		normalized,
	);
	// manager.close() now releases the bound UDP socket too.
	manager.ownTransport(udp);
	return { manager, certHashBase64: parsed.hashBase64 };
}

/**
 * Connect over the wasm backend and present the session through the shared
 * {@link WebTransportLike} contract. The returned `transport` is backend
 * agnostic; `manager` is exposed so callers can `close()` the endpoint.
 */
export async function connectWasmUnified(
	wasm: WasmModule,
	udp: UdpTransport,
	authority: string,
	addr = "127.0.0.1:0",
	peerAddr = "127.0.0.1:443",
	opts: WasmConnectOptions = {},
): Promise<{ transport: WebTransportLike; manager: WasmTransportManager }> {
	const { session, manager } = await connectWasm(
		wasm,
		udp,
		authority,
		addr,
		peerAddr,
		opts,
	);
	return {
		transport: wasmToWebTransportLike(new WasmWebTransport(session)),
		manager,
	};
}

/** Construction args for the wasm side of {@link createUnifiedClient}. */
export interface WasmClientArgs {
	kind: "wasm";
	wasm: WasmModule;
	udp: UdpTransport;
	authority: string;
	addr?: string;
	peerAddr?: string;
	/** Pin the server cert by base64 SHA-256 hash(es). See {@link WasmConnectOptions}. */
	certHashBase64?: string;
	limits?: WasmLimitsOptions;
	rateLimits?: WasmRateLimitOptions;
}

/** Construction args for the native side of {@link createUnifiedClient}. */
export interface NativeClientArgs {
	kind: "native";
	/** Wraps an already-constructed native W3C `WebTransport` instance. */
	create: () => WebTransportLike;
}

/**
 * Selector factory: yield a backend-agnostic {@link WebTransportLike} for the
 * current runtime. The wasm and native sides take different construction args
 * (module/udp vs a native-instance factory) — both yield the same contract.
 *
 * Pass `args` whose `kind` matches the runtime; mismatches throw. Use
 * {@link selectBackend} to pick which args to build.
 */
export async function createUnifiedClient(
	args: WasmClientArgs | NativeClientArgs,
): Promise<WebTransportLike> {
	if (args.kind === "wasm") {
		const { transport } = await connectWasmUnified(
			args.wasm,
			args.udp,
			args.authority,
			args.addr,
			args.peerAddr,
			{
				certHashBase64: args.certHashBase64,
				limits: args.limits,
				rateLimits: args.rateLimits,
			},
		);
		return transport;
	}
	return args.create();
}
