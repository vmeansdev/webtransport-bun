import type { CapacityProfile, RuntimeScenarioParameters } from "../types.ts";
import type { WireMessage } from "../wire.ts";

/** Delivery semantics shared by the WS and WT adapters. */
export type DeliveryKind = "datagram" | "reliable-message";

export type TransportKind = "ws" | "wt";

export type SocketPayload = string | ArrayBuffer | ArrayBufferView;

export type WebSocketTransportErrorCode =
	| "E_BACKPRESSURE_TIMEOUT"
	| "E_HANDSHAKE_TIMEOUT"
	| "E_LIMIT_EXCEEDED"
	| "E_QUEUE_FULL"
	| "E_RATE_LIMITED"
	| "E_SESSION_CLOSED"
	| "E_TLS"
	| "E_INTERNAL";

/** Stable errors emitted by the comparison adapters. */
export class WebSocketTransportError extends Error {
	readonly code: WebSocketTransportErrorCode;
	override readonly cause?: unknown;

	constructor(
		code: WebSocketTransportErrorCode,
		message: string,
		options?: { readonly cause?: unknown },
	) {
		super(`${code}: ${message}`);
		this.name = "WebSocketTransportError";
		this.code = code;
		this.cause = options?.cause;
	}
}

/** Injectable time source used by all bounded adapter waits and token buckets. */
export interface TransportClock {
	nowMs(): number;
	sleep(milliseconds: number): Promise<void>;
	/**
	 * How this clock reads time, for a measurement to cite.
	 *
	 * Optional so that every fake clock in the test suite stays a `TransportClock`
	 * without stating one. A driver that cannot name its clock reports it as
	 * unstated rather than guessing, and a measurement whose clock is unstated —
	 * or is `Date.now` — cannot back a sub-millisecond claim.
	 */
	readonly method?: string;
	/**
	 * Optional deterministic busy-slice seam. Invoked once at the start of each
	 * outermost *ingest* busy measurement so tests can advance a fake clock by
	 * an exact amount between `busyStart` and `busyEnd` without wall time.
	 */
	noteBusySlice?(): void;
	/**
	 * The same seam for the *egress* half of the session's loop work, invoked
	 * once at the start of each outermost send-path slice.
	 *
	 * It is a second name rather than a second call to `noteBusySlice` so a
	 * test can price ingest and egress apart -- and so every fake clock that
	 * already prices a receive loop keeps reading exactly what it read before
	 * the send path started charging.
	 */
	noteEgressSlice?(): void;
}

/**
 * `Date.now()` ticks at 1 ms, and the campaign's whole subject is a difference
 * measured in tenths of one. Every latency this tool has ever reported below
 * about 3 ms was quantized by its own clock before anything about a transport
 * could show up in it, so the comparison ran on a ruler with no marks in the
 * range being compared.
 *
 * `performance.timeOrigin + performance.now()` is the same wall-clock epoch with
 * sub-millisecond resolution, and is what `tools/load/bench-sink.ts` already
 * uses for exactly this reason.
 */
export const systemTransportClock: TransportClock = Object.freeze({
	nowMs: () => performance.timeOrigin + performance.now(),
	sleep: (milliseconds: number) =>
		new Promise<void>((resolve) => {
			setTimeout(resolve, Math.max(0, milliseconds));
		}),
	method: "performance.timeOrigin+performance.now",
});

/**
 * What `busyMs` means, in one place, for every adapter and every reader of an
 * artifact that carries it.
 *
 * **The JavaScript event-loop time this server spent on one session's transport
 * work -- inbound and outbound alike -- over the same wall-clock window.**
 *
 * Inbound is the time inside the handler that consumes bytes off the wire:
 * decoding a frame or an envelope, moving counters, and handing the result to
 * whoever is waiting for it. Outbound is the time inside the send path:
 * framing a message, reserving against the session's byte ledger, calling the
 * socket or the stream writer, and the loop time that resuming from a
 * backpressure wait costs. Outbound is deliberately *not* the wall time the
 * bytes take to leave: a send that parks on a full socket for 40 ms charges
 * only the slices in which this loop was actually executing, never the 40 ms
 * it spent suspended.
 *
 * The rules that keep the number honest, and that every adapter obeys through
 * `LoopBusyMeter`:
 *
 * - **One accumulator per session.** Ingest and egress add to the same
 *   milliseconds, so `busyMs` is the session's whole loop cost and not the
 *   cost of whichever half a given cell happens to exercise. A bulk sender
 *   and a bulk receiver are then the same measurement pointed two ways,
 *   which is the only reason a WS arm and a WT arm can be compared at all.
 * - **No slice is charged twice.** A send begun inside an inbound handler --
 *   a receipt, a handshake acknowledgement -- is already inside the ingest
 *   slice, so the meter's nesting depth charges the outermost span only.
 * - **No span crosses an `await`.** A span is paused before the loop yields
 *   and resumed when it comes back, so suspended time is never charged.
 * - **Every path charges, including the ones that throw.** Spans are closed
 *   in `finally`, so an early return, a refusal and a deadline all leave the
 *   accumulator holding the work they did before they gave up.
 *
 * What the number is **not**: it is not process CPU. It excludes everything
 * below the JavaScript boundary -- native addon time, the kernel's own send
 * and receive work, QUIC and TLS in the WT addon, Bun's WebSocket framing,
 * and anything the runtime does on another thread -- and it excludes
 * scenario-level work the harness does outside the session, such as
 * generating or digesting a bulk payload. Two arms with the same `busyMs`
 * can still cost the machine very different amounts of CPU.
 */
export const SESSION_LOOP_BUSY_MS_DEFINITION =
	"busyMs is the JavaScript event-loop time this server spent on this " +
	"session's transport work, ingest and egress, over the same wall-clock " +
	"window. Egress is the loop time spent framing, scheduling and resuming " +
	"outbound writes, never the wall time the bytes take to leave. It is not " +
	"process CPU: native, kernel and other-thread time are excluded.";

/** One charged interval of loop time, paused around every `await`. */
export interface LoopBusySpan {
	/** Stop charging, before the loop yields. Idempotent. */
	pause(): void;
	/** Charge again, after the loop comes back. Idempotent. */
	resume(): void;
	/** Stop charging for good. Safe from a `finally` after `pause`. */
	close(): void;
}

/** Which half of the session's transport work a span is charging. */
export type LoopBusyKind = "ingest" | "egress";

/**
 * One session's `busyMs` accumulator, and the only implementation of
 * `SESSION_LOOP_BUSY_MS_DEFINITION` in this tree.
 *
 * Both adapters own one per session and charge every ingest slice and every
 * egress slice into it, so the two transports report the same quantity. The
 * nesting depth is what keeps ingest and egress from charging the same
 * milliseconds twice; because no span crosses an `await`, the depth is a
 * plain synchronous stack and cannot interleave.
 */
export class LoopBusyMeter {
	private totalMs = 0;
	private depth = 0;
	private spanStartMs = 0;
	private readonly windowStartMs: number;

	constructor(private readonly clock: TransportClock) {
		this.windowStartMs = clock.nowMs();
	}

	/** Milliseconds charged so far. Only ever grows. */
	get busyMs(): number {
		return this.totalMs;
	}

	/** The wall clock since this session's meter opened. */
	get windowMs(): number {
		return Math.max(0, this.clock.nowMs() - this.windowStartMs);
	}

	snapshot(): { readonly busyMs: number; readonly windowMs: number } {
		return { busyMs: this.busyMs, windowMs: this.windowMs };
	}

	/** Charge one synchronous slice, whatever it returns or throws. */
	measure<T>(kind: LoopBusyKind, run: () => T, seam = true): T {
		const span = this.open(kind, seam);
		try {
			return run();
		} finally {
			span.close();
		}
	}

	/**
	 * Open a span for an asynchronous path. The caller pauses it before every
	 * `await` and closes it in a `finally`, so suspended time is never charged
	 * and no path escapes without charging what it did.
	 *
	 * `seam` says whether this slice is one unit of work a fake clock should
	 * be allowed to price. A slice that carries no message -- tearing an
	 * exhausted feed down, for instance -- charges its real time like any
	 * other but passes `false`, because a deterministic clock that advanced
	 * there would price a shutdown as if it were a delivery.
	 */
	open(kind: LoopBusyKind, seam = true): LoopBusySpan {
		let charging = false;
		const enter = (): void => {
			if (charging) return;
			charging = true;
			if (this.depth++ > 0) return;
			this.spanStartMs = this.clock.nowMs();
			// The deterministic seam. `noteBusySlice` is the ingest seam the
			// suite already advances a fake clock through; `noteEgressSlice` is
			// its send-side twin, so a test can price the two halves apart.
			// Neither fires for a nested span: that slice is already charged.
			if (!seam) return;
			if (kind === "ingest") this.clock.noteBusySlice?.();
			else this.clock.noteEgressSlice?.();
		};
		const leave = (): void => {
			if (!charging) return;
			charging = false;
			this.depth = Math.max(0, this.depth - 1);
			if (this.depth > 0) return;
			this.totalMs += Math.max(0, this.clock.nowMs() - this.spanStartMs);
		};
		enter();
		return { pause: leave, resume: enter, close: leave };
	}
}

export interface AdmissionCounters {
	readonly sessionsActive: number;
	readonly handshakesInFlight: number;
	readonly handshakesAttempted: number;
	readonly handshakesAccepted: number;
	readonly handshakesRejected: number;
	readonly streamOpenAttempts: number;
	readonly streamOpenAccepted: number;
	readonly streamOpenRejected: number;
	readonly datagramAttempts: number;
	readonly datagramAccepted: number;
	readonly datagramRejected: number;
	readonly tokenBucketRejected: number;
}

/**
 * Transport counters intentionally do not collapse admission and delivery.
 * In particular, `queued` is not `serverObserved`, and neither is delivery.
 */
export interface TransportMetrics extends AdmissionCounters {
	readonly attempted: number;
	readonly queued: number;
	readonly serverObserved: number;
	readonly acknowledged: number;
	readonly delivered: number;
	readonly refused: number;
	readonly dropped: number;
	readonly timedOut: number;
	readonly sessionsOpened: number;
	readonly sessionsClosed: number;
	readonly streamsOpened: number;
	readonly streamsAccepted: number;
	readonly streamsClosed: number;
	readonly active: boolean;
	readonly queueBytes: number;
	readonly queueBytesPeak: number;
	readonly receiveQueueItems: number;
	readonly receiveQueueBytes: number;
	/**
	 * Fraction of the session's wall-clock window this session's transport
	 * work occupied the JavaScript event loop, ingest and egress alike --
	 * `SESSION_LOOP_BUSY_MS_DEFINITION` is the authority on what is counted
	 * and what is not.
	 *
	 * `busyMs / windowMs` is the load this session put on the loop; a
	 * tail-latency number published alongside this is interpretable as
	 * transport, queueing, or loop starvation depending on where the
	 * fraction sits. The two values are kept as raw milliseconds rather
	 * than a fraction so a reader can decide their own window and so the
	 * measurement does not collapse when a session's wall clock is short.
	 *
	 * Without this, a WS↔WT comparison whose WT arm reads on the main loop
	 * cannot tell whether a low tail is "WT is fast" or "the loop is
	 * barely loaded." The fraction is the answer to that question. It counts
	 * both directions because a cell that only sends -- Phase A's bulk
	 * source is exactly that -- would otherwise report a loop that did
	 * nothing while it wrote a hundred megabytes.
	 */
	readonly loopUtilization: {
		readonly busyMs: number;
		readonly windowMs: number;
	};
	/**
	 * Bytes this session put on the wire that the scenario did not ask for.
	 *
	 * Every byte of a send that is not application payload: envelope headers,
	 * whatever framing the adapter adds around them, and every byte of every
	 * receipt, which is harness traffic end to end. It is counted because the
	 * two arms do not add the same amount and the difference is not disclosed
	 * anywhere else -- WS wraps each envelope in a 13-byte frame and charges
	 * every receipt frame to `maxQueuedBytesPerSession`, where WT hands the
	 * envelope to QUIC and submits its byte budgets verbatim.
	 *
	 * It is what the adapter can see, and on WT that is less than the truth:
	 * QUIC's own framing is below this layer and is not counted, so the WT
	 * figure is a floor while the WS figure is complete at the WebSocket layer.
	 */
	readonly harnessOverheadBytes: number;
	readonly role?: string;
}

export interface SubmittedCapacityProfile {
	readonly profile: CapacityProfile;
	readonly bytes: string;
	readonly hash: string;
}

export interface SendObservation {
	readonly status: number;
	readonly bytes: number;
	readonly deliveryKind: DeliveryKind;
	readonly attempted: true;
	readonly queued: boolean;
	readonly serverObserved: false;
	readonly acknowledged: false;
	readonly delivered: false;
	readonly channelId?: number;
}

export interface ClientTlsOptions {
	readonly ca?:
		| string
		| ArrayBuffer
		| ArrayBufferView
		| readonly (string | ArrayBuffer | ArrayBufferView)[];
	readonly serverName?: string;
	readonly rejectUnauthorized?: boolean;
	readonly [key: string]: unknown;
}

export interface ServerTlsOptions {
	readonly cert?: string | ArrayBuffer | ArrayBufferView;
	readonly key?: string | ArrayBuffer | ArrayBufferView;
	readonly serverName?: string;
	readonly [key: string]: unknown;
}

export interface ClientConfig {
	readonly url: string;
	readonly role: string;
	readonly tls?: ClientTlsOptions;
	readonly deadlineMs: number;
	readonly sourceKey?: string;
	readonly clientHighWaterMark?: number;
	readonly clientLowWaterMark?: number;
	readonly clientWatermarkPollMs?: number;
	readonly parameters?: RuntimeScenarioParameters;
}

export interface ServerConfig {
	readonly hostname?: string;
	readonly port: number;
	readonly role?: string;
	readonly tls?: ServerTlsOptions;
	readonly sourceKey?: string;
	readonly parameters?: RuntimeScenarioParameters;
	readonly capacityProfile?: CapacityProfile;
}

export interface ChannelConfig {
	readonly sourceKey?: string;
}

export interface ClientWebSocketLike {
	readonly readyState: number;
	bufferedAmount: number;
	binaryType?: "blob" | "arraybuffer" | "nodebuffer" | "uint8array";
	send(data: SocketPayload): void;
	close(code?: number, reason?: string): void;
	addEventListener(type: string, listener: EventListener): void;
	removeEventListener(type: string, listener: EventListener): void;
}

export interface ServerWebSocketLike<T = unknown> {
	readonly readyState: number;
	readonly remoteAddress?: string;
	data: T;
	send(data: SocketPayload, compress?: boolean): number;
	close(code?: number, reason?: string): void;
	addEventListener?(type: string, listener: EventListener): void;
	removeEventListener?(type: string, listener: EventListener): void;
}

export interface WebSocketHandler<T = unknown> {
	readonly data?: T;
	readonly maxPayloadLength: number;
	readonly backpressureLimit: number;
	readonly closeOnBackpressureLimit: boolean;
	readonly idleTimeout: number;
	readonly perMessageDeflate: false;
	readonly open: (socket: ServerWebSocketLike<T>) => void | Promise<void>;
	readonly message: (
		socket: ServerWebSocketLike<T>,
		message: string | ArrayBuffer | ArrayBufferView,
	) => void | Promise<void>;
	readonly drain: (socket: ServerWebSocketLike<T>) => void | Promise<void>;
	readonly close: (
		socket: ServerWebSocketLike<T>,
		code: number,
		reason: string,
	) => void | Promise<void>;
	readonly error?: (
		socket: ServerWebSocketLike<T>,
		error: unknown,
	) => void | Promise<void>;
}

export interface WebSocketServerRuntimeOptions {
	readonly hostname?: string;
	readonly port: number;
	readonly tls?: ServerTlsOptions;
	readonly websocket: WebSocketHandler;
	readonly fetch?: (
		request: Request,
		server: unknown,
	) => Response | undefined | Promise<Response | undefined>;
}

export interface WebSocketServerRuntime {
	stop(closeActiveConnections?: boolean): void | Promise<void>;
}

export type ClientSocketFactory = (
	url: string,
	options: ClientWebSocketOptions,
) => ClientWebSocketLike;

export interface ClientWebSocketOptions {
	readonly tls?: ClientTlsOptions;
	readonly perMessageDeflate: false;
	readonly protocol?: string;
	readonly protocols?: string | readonly string[];
}

export type WebSocketServerFactory = (
	options: WebSocketServerRuntimeOptions,
) => WebSocketServerRuntime;

export interface SendChannel {
	readonly channelId: number;
	write(bytes: Uint8Array, deadlineMs: number): Promise<SendObservation>;
	end(deadlineMs: number): Promise<void>;
}

export interface ReceiveChannel {
	readonly channelId: number;
	read(deadlineMs: number): Promise<Uint8Array | null>;
	cancel(deadlineMs: number): Promise<void>;
}

export interface BidiChannel extends SendChannel, ReceiveChannel {}

export interface Session {
	readonly role: string;
	sendMessage(
		kind: DeliveryKind,
		message: WireMessage,
		deadlineMs: number,
	): Promise<SendObservation>;
	receiveMessage(kind: DeliveryKind, deadlineMs: number): Promise<WireMessage>;
	sendText(text: string, deadlineMs: number): Promise<SendObservation>;
	openUni(deadlineMs: number, options?: ChannelConfig): Promise<SendChannel>;
	acceptUni(deadlineMs: number): Promise<ReceiveChannel>;
	openBidi(deadlineMs: number, options?: ChannelConfig): Promise<BidiChannel>;
	acceptBidi(deadlineMs: number): Promise<BidiChannel>;
	close(deadlineMs: number): Promise<void>;
	snapshot(): TransportMetrics;
}

/**
 * Server-side metrics, with the server-aggregate loop utilization as a separate
 * field from any single-session view.
 *
 * `loopUtilization` is retained for backward compatibility with readers that
 * already pulled the server-scope value under that name; the new
 * `serverLoopUtilization` field is the canonical, scope-explicit name. Both
 * fields report the same value on a server snapshot. The two-name shape is
 * what the architect and critic reviews required (Phase 2.4 architect
 * review §2, issue 4; phase-2.4 deviation §"Commit 1"): the older
 * overloaded name risks being read as a session value, and the server
 * aggregate must be unambiguous to a renderer that has both per-session and
 * server values to display.
 *
 * `busyMs / windowMs` over a server lifetime is the load on the union of
 * all session loops, ingest and egress (`SESSION_LOOP_BUSY_MS_DEFINITION`).
 * A server that runs N concurrent sessions
 * can legitimately report a `serverLoopUtilization.busyMs` greater than
 * `windowMs` -- it is summed across sessions -- which is why the field
 * is not subject to the same per-session saturation rule that
 * `loopUtilization` would be if interpreted as a single-session fraction.
 */
export interface ServerMetrics extends TransportMetrics {
	/**
	 * The sum across all sessions of the per-session `busyMs` over the
	 * server's wall-clock window since server start, with completed-session
	 * busy time retained. `SESSION_LOOP_BUSY_MS_DEFINITION` states what one
	 * session's `busyMs` counts.
	 */
	readonly serverLoopUtilization: {
		readonly busyMs: number;
		readonly windowMs: number;
	};
}

export interface ServerHandle {
	acceptSession(deadlineMs: number): Promise<Session>;
	stop(deadlineMs: number): Promise<void>;
	snapshot(): ServerMetrics;
}

export interface TransportAdapter {
	readonly kind: TransportKind;
	readonly submittedCapacityProfile: SubmittedCapacityProfile;
	startServer(config: ServerConfig): Promise<ServerHandle>;
	connect(config: ClientConfig): Promise<Session>;
}
