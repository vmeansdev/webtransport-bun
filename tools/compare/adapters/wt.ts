/**
 * Task 5: native WebTransport comparison adapter.
 *
 * Uses ONLY the public root package surface (`createServer`, `connect`) from
 * `@webtransport-bun/webtransport`. No product code is modified or
 * imported from internal modules.
 *
 * On the server side the adapter calls `createServer` and forwards the
 * canonical capacity profile through `limits` and `rateLimits`.
 * On the client side the adapter calls `connect` with `caPem`/`serverName`
 * translated from the caller's `ClientTlsOptions`.
 *
 * Datagrams map to WT datagrams; reliable-messages map to persistent
 * long-lived bidi/uni streams. The adapter never labels a session with
 * 0-RTT state that does not come from the real session fields
 * (`has0Rtt`, `accepted0Rtt`, `handshakeConfirmed`).
 *
 * Unit tests use injected factories so no socket is opened.
 */

import type { Duplex, Readable, Writable } from "node:stream";
import { canonicalJson, sha256Canonical } from "../canonical.ts";
import { CANONICAL_CAPACITY_PROFILE } from "../scenario-registry.ts";
import type { CapacityProfile } from "../types.ts";
import {
	ackFor,
	decodeWireMessage,
	encodeWireMessage,
	type WireMessage,
	wireEnvelopeLength,
} from "../wire.ts";
import {
	type BidiChannel,
	type ClientConfig,
	type DeliveryKind,
	LoopBusyMeter,
	type LoopBusySpan,
	type ReceiveChannel,
	type SendChannel,
	type SendObservation,
	type ServerConfig,
	type ServerHandle,
	type ServerMetrics,
	type Session,
	type SubmittedCapacityProfile,
	systemTransportClock,
	type TransportAdapter,
	type TransportClock,
	type TransportMetrics,
} from "./transport.ts";

// ---------------------------------------------------------------------------
// Public factory types (injected in tests, native in production)
// ---------------------------------------------------------------------------

/** The shape of options passed to the native createServer factory. */
export interface WtServerOptions {
	host?: string;
	port: number;
	tls: {
		certPem?: string | Uint8Array;
		keyPem?: string | Uint8Array;
		cert?: string | Uint8Array;
		key?: string | Uint8Array;
	};
	limits?: Record<string, unknown>;
	rateLimits?: Record<string, unknown>;
	enable0Rtt?: boolean;
	allowEarlySession?: boolean;
	onSession?: (session: FakeWtServerSession) => void;
	[key: string]: unknown;
}

/** Subset of the native ServerSession interface used by the adapter. */
export interface FakeWtServerSession {
	readonly id: string;
	readonly peer: { ip: string; port: number };
	readonly has0Rtt: boolean;
	readonly accepted0Rtt: boolean;
	readonly handshakeConfirmed: boolean;
	readonly ready: Promise<void>;
	readonly closed: Promise<unknown>;
	readonly draining: Promise<void>;
	close(info?: unknown): void;
	drain(): void;
	sendDatagram(data: Uint8Array): Promise<void>;
	sendDatagramBatch(
		items: readonly Uint8Array[],
	): Promise<{ sent: number; error?: unknown }>;
	incomingDatagrams(): AsyncIterable<Uint8Array>;
	readonly incomingBidirectionalStreams: ReadableStream<{
		readable: Readable;
		writable: Writable;
	}>;
	/**
	 * What the native session actually yields: a WHATWG receive stream per
	 * incoming uni stream, not a Node `Readable`. It was declared as
	 * `ReadableStream<Readable>` and the one consumer cast the mismatch away
	 * (`as unknown as Readable`), which is how a stream nothing could
	 * `destroy()` came to be handed to a channel that calls `destroy()`.
	 * `packages/webtransport/src/index.ts:1022` is the surface this mirrors.
	 */
	readonly incomingUnidirectionalStreams: ReadableStream<
		ReadableStream<Uint8Array>
	>;
	createBidirectionalStream(options?: unknown): Promise<Duplex>;
	createUnidirectionalStream(options?: unknown): Promise<Writable>;
	metricsSnapshot(): unknown;
	goAway(): void;
}

/** Subset of the native ClientSession interface used by the adapter. */
export interface FakeWtClientSession {
	readonly id: string;
	readonly peer: { ip: string; port: number };
	readonly has0Rtt: boolean;
	readonly accepted0Rtt: boolean;
	readonly handshakeConfirmed: boolean;
	readonly ready: Promise<void>;
	readonly closed: Promise<unknown>;
	readonly draining: Promise<void>;
	close(info?: unknown): void;
	drain(): void;
	sendDatagram(data: Uint8Array): Promise<void>;
	sendDatagramBatch(
		items: readonly Uint8Array[],
	): Promise<{ sent: number; error?: unknown }>;
	incomingDatagrams(): AsyncIterable<Uint8Array>;
	createBidirectionalStream(options?: unknown): Promise<Duplex>;
	incomingBidirectionalStreams(): AsyncIterable<Duplex>;
	createUnidirectionalStream(options?: unknown): Promise<Writable>;
	incomingUnidirectionalStreams(): AsyncIterable<Readable>;
	metricsSnapshot(): unknown;
}

/** Minimal handle returned by the server factory. */
export interface WtServerHandle {
	readonly address: { host: string; port: number };
	readonly congestionControl: string;
	close(): Promise<void>;
	metricsSnapshot(): unknown;
	sendDatagramMirror(targets: readonly string[], payload: Uint8Array): unknown;
	sendDatagramMirrorPaced(
		targets: readonly string[],
		payload: Uint8Array,
	): unknown;
	readMirrorReports(max?: number): readonly unknown[];
	tlsSnapshot(): unknown;
	updateCert(tls: unknown): Promise<void>;
	updateTls(tls: unknown): Promise<void>;
	replaceSniCerts(sni: unknown[]): Promise<void>;
	upsertSniCert(entry: unknown): Promise<void>;
	removeSniCert(serverName: string): Promise<void>;
	setUnknownSniPolicy(policy: unknown): Promise<void>;
}

export type WtServerFactory = (options: WtServerOptions) => WtServerHandle;
export type WtClientFactory = (
	url: string,
	options: Record<string, unknown>,
) => Promise<FakeWtClientSession>;

// ---------------------------------------------------------------------------
// Atomic channel ID counter
// ---------------------------------------------------------------------------

let _nextChannelId = 1;
function nextChannelId(): number {
	return _nextChannelId++;
}

function toRemainingMs(
	deadlineOrTimeoutMs: number,
	clock: TransportClock,
): number {
	if (!Number.isFinite(deadlineOrTimeoutMs) || deadlineOrTimeoutMs <= 0) {
		return 1;
	}
	// If value is small (< 1e10, ~115 days), treat as relative timeout duration
	if (deadlineOrTimeoutMs < 1e10) {
		return Math.max(1, deadlineOrTimeoutMs);
	}
	// Otherwise treat as absolute epoch timestamp
	return Math.max(1, deadlineOrTimeoutMs - clock.nowMs());
}

/**
 * Read one chunk from a Node Readable or Web ReadableStream with a bounded
 * deadline. Returns null on EOF.
 *
 * `span` is the caller's, opened at the read seam and closed there. This
 * function pauses it across the one `await` and resumes it after, which
 * leaves the expensive part of the turn charged -- acquiring the reader,
 * arming the timer, building the race, clearing the timer and releasing the
 * lock -- and the suspension not (`SESSION_LOOP_BUSY_MS_DEFINITION`). The
 * arrival body is a few per cent of that turn; the turn is the read.
 */
async function readChunk(
	readable: any,
	deadlineMs: number,
	clock: TransportClock,
	span?: LoopBusySpan,
): Promise<Uint8Array | null> {
	if (readable && typeof readable.getReader === "function") {
		const reader = readable.getReader();
		const remaining = toRemainingMs(deadlineMs, clock);
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeoutPromise = new Promise<never>((_, reject) => {
			timer = setTimeout(
				() =>
					reject(new Error("E_BACKPRESSURE_TIMEOUT: read() deadline exceeded")),
				remaining,
			);
		});
		try {
			const readPromise = reader
				.read()
				.then((res: { value?: Uint8Array; done: boolean }) => {
					return res.done ? null : (res.value ?? null);
				});
			span?.pause();
			try {
				return await Promise.race([readPromise, timeoutPromise]);
			} finally {
				span?.resume();
			}
		} finally {
			if (timer !== undefined) clearTimeout(timer);
			reader.releaseLock();
		}
	}
	// The Node branch settles through listeners rather than an `await`, so the
	// pause goes after the executor -- which arms the timer, registers the
	// three listeners and takes the synchronous nudge -- and every settle path
	// runs through `cleanup`, which resumes. A path that never settles is a
	// span that stays paused and charges what it had, which is the same answer
	// the `finally` gives on the WHATWG branch.
	const pending = new Promise<Uint8Array | null>((resolve, reject) => {
		const timer = setTimeout(
			() => {
				cleanup();
				reject(new Error("E_BACKPRESSURE_TIMEOUT: read() deadline exceeded"));
			},
			toRemainingMs(deadlineMs, clock),
		);

		function cleanup() {
			clearTimeout(timer);
			readable.off?.("data", onData);
			readable.off?.("end", onEnd);
			readable.off?.("error", onError);
			span?.resume();
		}

		function onData(chunk: Buffer | Uint8Array) {
			cleanup();
			const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
			resolve(bytes);
		}
		function onEnd() {
			cleanup();
			resolve(null);
		}
		function onError(err: unknown) {
			cleanup();
			reject(err);
		}

		readable.once?.("data", onData);
		readable.once?.("end", onEnd);
		readable.once?.("error", onError);

		// Nudge the stream if it hasn't started flowing
		if (
			readable.readable &&
			!readable.readableFlowing &&
			typeof readable.read === "function"
		) {
			const chunk = readable.read();
			if (chunk !== null) {
				cleanup();
				const bytes =
					chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk as Buffer);
				resolve(bytes);
			}
		}
	});
	span?.pause();
	return pending;
}

/** Write bytes to a Node Writable or Web WritableStream with a bounded deadline. */
async function writeChunk(
	writable: any,
	data: Uint8Array,
	deadlineMs: number,
	clock: TransportClock,
	/**
	 * The session's `busyMs` accumulator, when this write belongs to one.
	 *
	 * Charged around the synchronous halves only: acquiring the writer,
	 * arming the deadline and handing the bytes to the stream is loop work;
	 * waiting for the stream to accept them is not
	 * (`SESSION_LOOP_BUSY_MS_DEFINITION`). A write with no session behind it
	 * -- a fixture channel -- passes none and is not charged to anybody.
	 */
	busy?: LoopBusyMeter,
): Promise<void> {
	const span = busy?.open("egress");
	try {
		const remaining = toRemainingMs(deadlineMs, clock);
		if (writable && typeof writable.getWriter === "function") {
			const writer = writable.getWriter();
			let timer: ReturnType<typeof setTimeout> | undefined;
			const timeoutPromise = new Promise<never>((_, reject) => {
				timer = setTimeout(
					() =>
						reject(
							new Error("E_BACKPRESSURE_TIMEOUT: write() deadline exceeded"),
						),
					remaining,
				);
			});
			try {
				span?.pause();
				await Promise.race([writer.write(data), timeoutPromise]);
			} finally {
				span?.resume();
				if (timer !== undefined) clearTimeout(timer);
				writer.releaseLock();
			}
			return;
		}
		const settled = new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				reject(new Error("E_BACKPRESSURE_TIMEOUT: write() deadline exceeded"));
			}, remaining);

			writable.write(data, (err: unknown) => {
				clearTimeout(timer);
				if (err) reject(err);
				else resolve();
			});
		});
		try {
			span?.pause();
			await settled;
		} finally {
			span?.resume();
		}
	} finally {
		span?.close();
	}
}

/** End a Node Writable or Web WritableStream with a bounded deadline. */
async function endStream(
	writable: any,
	deadlineMs: number,
	clock: TransportClock,
	busy?: LoopBusyMeter,
): Promise<void> {
	const span = busy?.open("egress");
	try {
		const remaining = toRemainingMs(deadlineMs, clock);
		if (writable && typeof writable.getWriter === "function") {
			const writer = writable.getWriter();
			let timer: ReturnType<typeof setTimeout> | undefined;
			const timeoutPromise = new Promise<never>((_, reject) => {
				timer = setTimeout(
					() =>
						reject(
							new Error("E_BACKPRESSURE_TIMEOUT: end() deadline exceeded"),
						),
					remaining,
				);
			});
			try {
				span?.pause();
				await Promise.race([writer.close(), timeoutPromise]);
			} finally {
				span?.resume();
				if (timer !== undefined) clearTimeout(timer);
				writer.releaseLock();
			}
			return;
		}
		const settled = new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				reject(new Error("E_BACKPRESSURE_TIMEOUT: end() deadline exceeded"));
			}, remaining);

			writable.end((err?: Error | null) => {
				clearTimeout(timer);
				if (err) reject(err);
				else resolve();
			});
		});
		try {
			span?.pause();
			await settled;
		} finally {
			span?.resume();
		}
	} finally {
		span?.close();
	}
}

// ---------------------------------------------------------------------------
// Stream-backed channels
// ---------------------------------------------------------------------------

function makeSendChannel(
	writable: Writable,
	clock: TransportClock,
	/** The owning session's accumulator; every write on this channel is its work. */
	busy?: LoopBusyMeter,
): SendChannel {
	const channelId = nextChannelId();
	return {
		channelId,
		async write(
			bytes: Uint8Array,
			deadlineMs: number,
		): Promise<SendObservation> {
			await writeChunk(writable, bytes, deadlineMs, clock, busy);
			return {
				status: 0,
				bytes: bytes.byteLength,
				deliveryKind: "reliable-message",
				attempted: true,
				queued: false,
				serverObserved: false,
				acknowledged: false,
				delivered: false,
				channelId,
			};
		},
		async end(deadlineMs: number): Promise<void> {
			await endStream(writable, deadlineMs, clock, busy);
		},
	};
}

/**
 * `busy` is required, not optional.
 *
 * A channel built without a meter reads for free, and that is exactly how the
 * sealed WebTransport arms came to publish `busyMs: 0` for a session that
 * received 100 MiB. Making it a parameter the compiler demands is what stops
 * the next construction site from omitting it silently.
 */
function makeReceiveChannel(
	readable: Readable | ReadableStream<Uint8Array>,
	clock: TransportClock,
	busy: LoopBusyMeter,
): ReceiveChannel {
	const channelId = nextChannelId();
	return {
		channelId,
		async read(deadlineMs: number): Promise<Uint8Array | null> {
			const span = busy.open("ingest");
			try {
				return await readChunk(readable, deadlineMs, clock, span);
			} finally {
				span.close();
			}
		},
		async cancel(_deadlineMs: number): Promise<void> {
			// Node streams destroy; WHATWG streams cancel. The declared type is
			// the union because both really arrive here: the native session's
			// `incomingUnidirectionalStreams` yields WHATWG receive streams.
			if ("destroy" in readable) readable.destroy();
			else void readable.cancel().catch(() => {});
		},
	};
}

function makeBidiChannel(
	duplex: Duplex,
	clock: TransportClock,
	busy: LoopBusyMeter,
): BidiChannel {
	const channelId = nextChannelId();
	return {
		channelId,
		async write(
			bytes: Uint8Array,
			deadlineMs: number,
		): Promise<SendObservation> {
			await writeChunk(duplex, bytes, deadlineMs, clock, busy);
			return {
				status: 0,
				bytes: bytes.byteLength,
				deliveryKind: "reliable-message",
				attempted: true,
				queued: false,
				serverObserved: false,
				acknowledged: false,
				delivered: false,
				channelId,
			};
		},
		async end(deadlineMs: number): Promise<void> {
			await endStream(duplex, deadlineMs, clock, busy);
		},
		async read(deadlineMs: number): Promise<Uint8Array | null> {
			const span = busy.open("ingest");
			try {
				return await readChunk(duplex, deadlineMs, clock, span);
			} finally {
				span.close();
			}
		},
		async cancel(_deadlineMs: number): Promise<void> {
			duplex.destroy();
		},
	};
}

// ---------------------------------------------------------------------------
// ReadableStream reader helpers for native WT stream surfaces
// ---------------------------------------------------------------------------

/**
 * Read one item from a WHATWG ReadableStream with a deadline.
 *
 * `span` is the caller's, on the same discipline `readChunk` uses: the reader
 * acquisition, the timer, the race and the release are charged, the suspension
 * is not.
 */
async function readFromStream<T>(
	stream: ReadableStream<T>,
	deadlineMs: number,
	clock: TransportClock,
	span?: LoopBusySpan,
): Promise<T | null> {
	const reader = stream.getReader();
	try {
		const remaining = toRemainingMs(deadlineMs, clock);
		const race = Promise.race([
			reader.read(),
			new Promise<{ done: true; value: undefined }>((_, reject) =>
				setTimeout(
					() =>
						reject(
							new Error(
								"E_BACKPRESSURE_TIMEOUT: readFromStream deadline exceeded",
							),
						),
					remaining,
				),
			),
		]);
		span?.pause();
		let result: Awaited<typeof race>;
		try {
			result = await race;
		} finally {
			span?.resume();
		}
		if (result.done) return null;
		return result.value as T;
	} finally {
		reader.releaseLock();
	}
}

// ---------------------------------------------------------------------------
// Session wrapper
// ---------------------------------------------------------------------------

interface SessionCounters {
	streamsOpened: number;
	streamsAccepted: number;
	streamsClosed: number;
	sessionsOpened: number;
	sessionsClosed: number;
	attempted: number;
	queued: number;
	serverObserved: number;
	acknowledged: number;
	delivered: number;
	refused: number;
	dropped: number;
	timedOut: number;
	queueBytes: number;
	queueBytesPeak: number;
	receiveQueueItems: number;
	receiveQueueBytes: number;
	harnessOverheadBytes: number;
	// admission
	sessionsActive: number;
	handshakesInFlight: number;
	handshakesAttempted: number;
	handshakesAccepted: number;
	handshakesRejected: number;
	streamOpenAttempts: number;
	streamOpenAccepted: number;
	streamOpenRejected: number;
	datagramAttempts: number;
	datagramAccepted: number;
	datagramRejected: number;
	tokenBucketRejected: number;
}

function makeSessionCounters(): SessionCounters {
	return {
		streamsOpened: 0,
		streamsAccepted: 0,
		streamsClosed: 0,
		sessionsOpened: 1,
		sessionsClosed: 0,
		attempted: 0,
		queued: 0,
		serverObserved: 0,
		acknowledged: 0,
		delivered: 0,
		refused: 0,
		dropped: 0,
		timedOut: 0,
		queueBytes: 0,
		queueBytesPeak: 0,
		receiveQueueItems: 0,
		receiveQueueBytes: 0,
		harnessOverheadBytes: 0,
		sessionsActive: 1,
		handshakesInFlight: 0,
		handshakesAttempted: 1,
		handshakesAccepted: 1,
		handshakesRejected: 0,
		streamOpenAttempts: 0,
		streamOpenAccepted: 0,
		streamOpenRejected: 0,
		datagramAttempts: 0,
		datagramAccepted: 0,
		datagramRejected: 0,
		tokenBucketRejected: 0,
	};
}

// ---------------------------------------------------------------------------
// Persistent reliable-message stream
// ---------------------------------------------------------------------------
//
// `sendMessage("reliable-message", …)` is the primitive that mirrors a single
// WebSocket `send`. WS puts one frame on the socket it already has and takes no
// stream-admission token; WT must do the same, or the arm pays a per-message
// stream tax the other arm never pays and stalls against
// `maxStreamsPerSessionUni`. Both roles therefore share one lazily opened
// unidirectional stream per session, carrying envelopes back to back, closed
// once when the session closes.

/** The send half of a session's single reliable-message stream. */
interface MessageStreamSender {
	send(encoded: Uint8Array, deadlineMs: number): Promise<void>;
	close(deadlineMs: number): Promise<void>;
}

function makeMessageStreamSender(
	openUniStream: () => Promise<unknown>,
	counters: SessionCounters,
	clock: TransportClock,
	/** The owning session's accumulator; opening and writing this stream is its work. */
	busy?: LoopBusyMeter,
): MessageStreamSender {
	let writable: unknown = null;
	let opening: Promise<unknown> | null = null;
	// Writes are chained because a Web WritableStream refuses a second
	// concurrent writer, and because envelopes must not interleave on the wire.
	let tail: Promise<unknown> = Promise.resolve();
	let ended = false;

	function ensureStream(): Promise<unknown> {
		if (writable !== null) return Promise.resolve(writable);
		if (opening === null) {
			counters.streamOpenAttempts++;
			opening = openUniStream().then(
				(stream) => {
					counters.streamOpenAccepted++;
					counters.streamsOpened++;
					writable = stream;
					return stream;
				},
				(error) => {
					opening = null;
					counters.streamOpenRejected++;
					throw error;
				},
			);
		}
		return opening;
	}

	return {
		async send(encoded: Uint8Array, deadlineMs: number): Promise<void> {
			const span = busy?.open("egress");
			try {
				if (ended)
					throw new Error("E_SESSION_CLOSED: message stream is closed");
				span?.pause();
				const stream = await ensureStream();
				span?.resume();
				const write = tail
					.catch(() => {})
					.then(() => writeChunk(stream, encoded, deadlineMs, clock, busy));
				tail = write.catch(() => {});
				span?.pause();
				await write;
			} finally {
				span?.close();
			}
		},
		async close(deadlineMs: number): Promise<void> {
			if (ended) return;
			ended = true;
			if (writable === null) return;
			const stream = writable;
			writable = null;
			await tail.catch(() => {});
			await endStream(stream, deadlineMs, clock, busy);
			counters.streamsClosed++;
		},
	};
}

/**
 * A byte feed over one long-lived stream.
 *
 * `readChunk` attaches a one-shot `data` listener, which is correct for a
 * stream that carries exactly one message and lossy for one that carries
 * many: switching a Node Readable into flowing mode emits every buffered
 * chunk, and a one-shot listener drops all but the first. A persistent stream
 * therefore needs a persistent subscription.
 */
interface ByteFeed {
	/**
	 * The next chunk, or `null` at end of stream.
	 *
	 * Deliberately unbounded in time. The read is driven by the session's own
	 * ingest pump rather than by an application receive, so there is no caller
	 * deadline to enforce here -- an application's deadline is enforced against
	 * the queue the pump fills, exactly as WS enforces it against the queue its
	 * socket callback fills. Reading without a timer is also what keeps the
	 * pump from arming one timeout per chunk for the life of every session.
	 */
	pull(): Promise<Uint8Array | null>;
}

function makeByteFeed(stream: unknown): ByteFeed {
	const web = stream as { getReader?: () => ReadableStreamDefaultReader };
	if (web && typeof web.getReader === "function") {
		const reader = web.getReader();
		return {
			async pull(): Promise<Uint8Array | null> {
				const result = await reader.read();
				return result.done ? null : ((result.value as Uint8Array) ?? null);
			},
		};
	}

	const node = stream as {
		on?: (event: string, listener: (arg?: unknown) => void) => void;
	};
	const queue: Uint8Array[] = [];
	let ended = false;
	let failure: unknown = null;
	let notify: (() => void) | null = null;
	function wake(): void {
		const pending = notify;
		notify = null;
		pending?.();
	}
	node.on?.("data", (chunk) => {
		queue.push(
			chunk instanceof Uint8Array
				? chunk
				: new Uint8Array(chunk as ArrayBuffer),
		);
		wake();
	});
	node.on?.("end", () => {
		ended = true;
		wake();
	});
	node.on?.("error", (err) => {
		failure = err;
		wake();
	});

	return {
		async pull(): Promise<Uint8Array | null> {
			for (;;) {
				const next = queue.shift();
				if (next !== undefined) return next;
				if (failure !== null) throw failure;
				if (ended) return null;
				await new Promise<void>((resolve) => {
					notify = resolve;
				});
			}
		},
	};
}

/**
 * A source of whole envelopes, read without a caller deadline.
 *
 * `null` means the source is finished. Both of a session's sources -- the
 * persistent message stream and the datagram iterator -- are exposed through
 * this one shape so the ingest pump below is written once and cannot drift
 * between them.
 */
interface EnvelopeFeed {
	next(): Promise<Uint8Array | null>;
}

/** The receive half of a session's single reliable-message stream. */
interface MessageStreamReceiver {
	open(deadlineMs: number): Promise<EnvelopeFeed>;
}

function makeMessageStreamReceiver(
	acceptUniStream: (deadlineMs: number) => Promise<Readable | null>,
	counters: SessionCounters,
): MessageStreamReceiver {
	let opened: EnvelopeFeed | null = null;
	let accepting: Promise<EnvelopeFeed> | null = null;
	let buffered = new Uint8Array(0);

	function takeEnvelope(): Uint8Array | null {
		const total = wireEnvelopeLength(buffered);
		if (total === null || buffered.byteLength < total) return null;
		const envelope = buffered.slice(0, total);
		buffered = buffered.slice(total);
		return envelope;
	}

	return {
		open(deadlineMs: number): Promise<EnvelopeFeed> {
			if (opened !== null) return Promise.resolve(opened);
			if (accepting === null) {
				accepting = acceptUniStream(deadlineMs).then(
					(stream) => {
						if (stream === null)
							throw new Error("E_SESSION_CLOSED: no message stream");
						counters.streamsAccepted++;
						const feed = makeByteFeed(stream);
						opened = {
							async next(): Promise<Uint8Array | null> {
								for (;;) {
									const envelope = takeEnvelope();
									if (envelope !== null) return envelope;
									const chunk = await feed.pull();
									if (chunk === null) return null;
									const grown = new Uint8Array(
										buffered.byteLength + chunk.byteLength,
									);
									grown.set(buffered, 0);
									grown.set(chunk, buffered.byteLength);
									buffered = grown;
								}
							},
						};
						return opened;
					},
					(error) => {
						accepting = null;
						throw error;
					},
				);
			}
			return accepting;
		},
	};
}

/** One session's datagram source, as a feed over a single iterator. */
function makeDatagramFeed(
	incoming: () => AsyncIterable<Uint8Array>,
): EnvelopeFeed {
	let iterator: AsyncIterator<Uint8Array> | null = null;
	return {
		async next(): Promise<Uint8Array | null> {
			iterator ??= incoming()[Symbol.asyncIterator]();
			const result = await iterator.next();
			return result.done === true ? null : result.value;
		},
	};
}

/**
 * How many decoded messages one session may hold for an application that has
 * not collected them.
 *
 * The pump reads ahead of the application, so it needs a bound, and the bound
 * has to shed the way this arm already declares it sheds (`drop-and-count`).
 * It is stated in messages rather than bytes because that is the unit the
 * receive path counts in; WS's equivalent is the byte budget its incoming
 * queue reserves against.
 */
const MAX_QUEUED_INGEST_MESSAGES = 100_000;

/**
 * One session's ingest pump: everything that arrives, counted where it lands.
 *
 * This is the site WS has had all along -- its socket callback counts a
 * receipt when the transport hands the frame over, and queues application
 * messages for whoever asks next. WT counted receipts inside `receiveMessage`
 * instead, so a receipt that arrived while nobody was in the receive loop was
 * never counted, and there is always such a receipt: the trailing one. That is
 * why an honest zero-loss run showed `acknowledged 5` against `delivered 6` on
 * WT and `6/6` on WS. The one counter introduced to make the arms comparable
 * was the one counter the arms computed differently, so it is now counted at
 * the same logical site on both: at ingest, before any application demand.
 *
 * `delivered` deliberately stays on the application receive, because that is
 * where WS counts it. A pump that counted `delivered` at ingest would make WT
 * report deliveries for messages an application never collected while WS did
 * not -- the same defect, moved one stage down.
 *
 * The pump owns the only read on the feed, so nothing races it for a chunk.
 *
 * What it does not close, stated rather than rounded off: the pump starts when
 * the session first receives, because starting it earlier means accepting the
 * peer's message stream earlier, and a session that also accepts application
 * uni streams would have the harness take one out from under it. So a session
 * that never receives an application message never accepts the peer's stream
 * and never counts its receipts, where WS counts them because its socket is
 * already open. Every measured leg and every echo peer in the campaign
 * receives; a pure sender that only ever sends does not.
 */
function makeIngest(input: {
	readonly counters: SessionCounters;
	readonly clock: TransportClock;
	/**
	 * The session's one `busyMs` accumulator. Ingest charges the same
	 * milliseconds the send path charges, which is what makes this arm's
	 * reading the same quantity WS reports
	 * (`SESSION_LOOP_BUSY_MS_DEFINITION`).
	 */
	readonly busy: LoopBusyMeter;
	readonly open: (deadlineMs: number) => Promise<EnvelopeFeed>;
	readonly endedMessage: string;
}): {
	readonly receive: (deadlineMs: number) => Promise<WireMessage>;
} {
	const { counters, clock, busy } = input;
	const ready: WireMessage[] = [];
	const waiters: {
		resolve: (message: WireMessage) => void;
		reject: (error: unknown) => void;
		timer: ReturnType<typeof setTimeout>;
	}[] = [];
	// A malformed envelope is handed to one receiver and the pump carries on,
	// which is what the pull-driven path did before there was a pump.
	let malformed: unknown = null;
	let ended: unknown = null;
	let opening: Promise<EnvelopeFeed> | null = null;

	function settle(): void {
		while (waiters.length > 0) {
			const next = ready.shift();
			if (next !== undefined) {
				const waiter = waiters.shift()!;
				clearTimeout(waiter.timer);
				waiter.resolve(next);
				continue;
			}
			const failure = malformed ?? ended;
			if (failure === null || failure === undefined) return;
			malformed = null;
			const waiter = waiters.shift()!;
			clearTimeout(waiter.timer);
			waiter.reject(failure);
		}
	}

	async function pump(feed: EnvelopeFeed): Promise<void> {
		for (;;) {
			let envelope: Uint8Array | null;
			try {
				envelope = await feed.next();
			} catch (error) {
				ended = error;
				settle();
				return;
			}
			// The ingest half of `SESSION_LOOP_BUSY_MS_DEFINITION`. The
			// `await feed.next()` above is the idle wait; everything
			// from here to the next iteration is the loop being busy,
			// and the span closes in a `finally` so the malformed,
			// dropped and end-of-feed paths all charge what they did.
			// End of feed is not a decode slice: it charges its real time like
			// every other path, but does not fire the deterministic seam.
			const span = busy.open("ingest", envelope !== null);
			try {
				if (envelope === null) {
					ended = new Error(input.endedMessage);
					settle();
					return;
				}
				let decoded: WireMessage;
				try {
					decoded = decodeWireMessage(envelope);
				} catch (error) {
					counters.dropped++;
					malformed = error;
					settle();
					continue;
				}
				if (decoded.kind === "ack") {
					counters.acknowledged++;
					continue;
				}
				counters.serverObserved++;
				if (ready.length >= MAX_QUEUED_INGEST_MESSAGES) {
					counters.dropped++;
					continue;
				}
				ready.push(decoded);
				settle();
			} finally {
				span.close();
			}
		}
	}

	function start(deadlineMs: number): Promise<EnvelopeFeed> {
		if (opening === null) {
			opening = input.open(deadlineMs).catch((error: unknown) => {
				opening = null;
				throw error;
			});
			void opening.then(
				(feed) => {
					void pump(feed);
				},
				() => {},
			);
		}
		return opening;
	}

	return {
		receive: async function receive(deadlineMs: number): Promise<WireMessage> {
			await start(deadlineMs);
			const queued = ready.shift();
			if (queued !== undefined) return queued;
			if (malformed !== null) {
				const error = malformed;
				malformed = null;
				throw error;
			}
			if (ended !== null) throw ended;
			return new Promise<WireMessage>((resolve, reject) => {
				const waiter = {
					resolve,
					reject,
					timer: setTimeout(
						() => {
							const index = waiters.indexOf(waiter);
							if (index !== -1) waiters.splice(index, 1);
							reject(
								new Error("E_BACKPRESSURE_TIMEOUT: receiveMessage deadline"),
							);
						},
						toRemainingMs(deadlineMs, clock),
					),
				};
				waiters.push(waiter);
			});
		},
	};
}

/**
 * The receive half of one session's message path, receipts included.
 *
 * Both roles share it so the two cannot drift, which is how the double
 * `streamsOpened` increment survived: twin blocks a hundred lines apart are
 * edited one at a time.
 *
 * An envelope is decoded before any counter moves, so a malformed one is
 * counted as dropped rather than as a message the peer was observed to have
 * sent; an envelope that says it is a receipt is counted as an acknowledgement
 * and never returned to the caller as a message; and every admitted message is
 * acknowledged, which is what gives `acknowledged` a producer on this arm at
 * all -- WS carried an `ack` frame kind that nothing encoded, WT carried
 * nothing, and the stage was therefore zero on both arms of every comparison
 * the campaign could publish. All three now happen in the ingest pump above,
 * which is the site WS counts at.
 *
 * The receipt is best effort for the same reason as WS's: an unsent one is a
 * measured shortfall the send-side progression already reports, not a reason
 * to fail a receive that already happened.
 */
function makeMessageReceive(input: {
	readonly counters: SessionCounters;
	readonly clock: TransportClock;
	/** The session's one `busyMs` accumulator, shared with its send path. */
	readonly busy: LoopBusyMeter;
	readonly datagrams: () => AsyncIterable<Uint8Array>;
	readonly messageStream: MessageStreamReceiver;
	readonly sendDatagram: (bytes: Uint8Array) => Promise<void>;
	readonly sendEnvelope: (
		bytes: Uint8Array,
		deadlineMs: number,
	) => Promise<void>;
}): {
	readonly receiveMessage: (
		kind: DeliveryKind,
		deadlineMs: number,
	) => Promise<WireMessage>;
} {
	const { counters } = input;
	const datagramFeed = makeDatagramFeed(input.datagrams);
	/**
	 * Acknowledge one message this session admitted.
	 *
	 * Named and separate from the receive that earned it, so this arm has the
	 * same site WS has (`sendAck`) rather than a few statements inlined into a
	 * loop -- and so a cost injected into a receipt on one arm can be injected
	 * into the same thing on the other.
	 *
	 * Nothing awaits it. `runMeasuredLeg` stamps a message's arrival after
	 * `receiveMessage` resolves, so an awaited receipt put its own send inside
	 * the number the campaign ranks on, twice per round trip: the peer's
	 * receipt for the outbound message and this side's receipt for the echo.
	 * Executed, a 50 ms receipt cost moved the samples from [3,0,0,0,0] to
	 * [107,105,104,106,106]. The real cost is smaller and, worse, is not equal
	 * across the arms, so it is a harness cost the ranked p99 must not carry.
	 */
	async function sendReceipt(
		message: WireMessage,
		kind: DeliveryKind,
		deadlineMs: number,
	): Promise<void> {
		const receipt = input.busy.measure("egress", () =>
			encodeWireMessage(ackFor(message)),
		);
		// A receipt carries no application payload, so all of it is harness
		// traffic. Counting it on both arms is the point: the claim that
		// "neither arm pays for the receipt in header bytes" was true of the
		// envelope's flags byte and false of everything else the receipt costs.
		counters.harnessOverheadBytes += receipt.byteLength;
		try {
			if (kind === "datagram") await input.sendDatagram(receipt);
			else await input.sendEnvelope(receipt, deadlineMs);
		} catch {
			// Best effort: an unsent receipt is a measured shortfall in this
			// session's own `acknowledged`, not a reason to fail a receive that
			// already happened.
		}
	}
	// Both ingest paths (datagrams and envelopes) and the send path charge
	// the one accumulator the session owns. Summing two separate ingest
	// accumulators was the old shape; it under-reported the loop by leaving
	// egress out entirely, which is what made a bulk *sender* read zero.
	const receiveDatagram = makeIngest({
		counters,
		clock: input.clock,
		busy: input.busy,
		open: async () => datagramFeed,
		endedMessage: "E_SESSION_CLOSED: no more datagrams",
	});
	const receiveEnvelope = makeIngest({
		counters,
		clock: input.clock,
		busy: input.busy,
		open: (deadlineMs) => input.messageStream.open(deadlineMs),
		endedMessage: "E_SESSION_CLOSED: message stream ended",
	});
	const receiveMessage = async function receiveMessage(
		kind: DeliveryKind,
		deadlineMs: number,
	): Promise<WireMessage> {
		const decoded =
			kind === "datagram"
				? await receiveDatagram.receive(deadlineMs)
				: await receiveEnvelope.receive(deadlineMs);
		counters.delivered++;
		void sendReceipt(decoded, kind, deadlineMs);
		return decoded;
	};
	return { receiveMessage };
}

function wrapServerSession(
	native: FakeWtServerSession,
	clock: TransportClock,
	onSessionClose?: (session: Session, busyMs: number) => void,
): Session {
	const counters = makeSessionCounters();
	let closed = false;
	// One accumulator for the whole session, charged by ingest and egress
	// alike (`SESSION_LOOP_BUSY_MS_DEFINITION`). The window opens here, at
	// session accept, so a session that never receives still has a window.
	const busy = new LoopBusyMeter(clock);
	const sessionLoopUtilization = (): {
		readonly busyMs: number;
		readonly windowMs: number;
	} => busy.snapshot();
	const messageSender = makeMessageStreamSender(
		() => native.createUnidirectionalStream(),
		counters,
		clock,
		busy,
	);
	const messageReceiver = makeMessageStreamReceiver(
		// Accepting the peer's message stream is a read seam like any other:
		// the reader acquisition, the timer and the race are this session's
		// loop time even though only one accept happens per session.
		async (deadlineMs) => {
			const span = busy.open("ingest");
			try {
				return (await readFromStream(
					native.incomingUnidirectionalStreams,
					deadlineMs,
					clock,
					span,
				)) as unknown as Readable | null;
			} finally {
				span.close();
			}
		},
		counters,
	);

	const messageReceive = makeMessageReceive({
		counters,
		clock,
		busy,
		datagrams: () => native.incomingDatagrams(),
		messageStream: messageReceiver,
		sendDatagram: (bytes) => native.sendDatagram(bytes),
		sendEnvelope: (bytes, deadlineMs) => messageSender.send(bytes, deadlineMs),
	});
	const { receiveMessage: receiveMessageFn } = messageReceive;

	const session: Session = {
		role: "server",

		async sendMessage(
			kind: DeliveryKind,
			message: WireMessage,
			deadlineMs: number,
		): Promise<SendObservation> {
			// Framing is egress loop work on this arm exactly as it is on WS,
			// and is charged before a byte has left
			// (`SESSION_LOOP_BUSY_MS_DEFINITION`).
			const encoded = busy.measure("egress", () => {
				counters.attempted++;
				const bytes = encodeWireMessage(message);
				// The envelope header is what this arm adds; QUIC's own framing
				// is below this layer and is not visible here, so this is a
				// floor.
				counters.harnessOverheadBytes +=
					bytes.byteLength - message.payload.byteLength;
				return bytes;
			});
			if (kind === "datagram") {
				const span = busy.open("egress");
				try {
					counters.datagramAttempts++;
					span.pause();
					await native.sendDatagram(encoded);
				} finally {
					span.close();
				}
				counters.datagramAccepted++;
				counters.queued++;
				return {
					status: 0,
					bytes: encoded.byteLength,
					deliveryKind: kind,
					attempted: true,
					queued: true,
					serverObserved: false,
					acknowledged: false,
					delivered: false,
				};
			}
			// reliable-message: one envelope on the session's persistent uni
			// stream, mirroring one WS frame on the socket it already holds.
			await messageSender.send(encoded, deadlineMs);
			counters.queued++;
			return {
				status: 0,
				bytes: encoded.byteLength,
				deliveryKind: kind,
				attempted: true,
				queued: true,
				serverObserved: false,
				acknowledged: false,
				delivered: false,
			};
		},

		receiveMessage: receiveMessageFn,

		async sendText(
			_text: string,
			_deadlineMs: number,
		): Promise<SendObservation> {
			throw new Error("sendText not supported by WT adapter");
		},

		async openUni(_deadlineMs: number): Promise<SendChannel> {
			const span = busy.open("egress");
			try {
				counters.streamOpenAttempts++;
				span.pause();
				const writable = await native.createUnidirectionalStream();
				span.resume();
				counters.streamOpenAccepted++;
				counters.streamsOpened++;
				return makeSendChannel(writable, clock, busy);
			} finally {
				span.close();
			}
		},

		async acceptUni(deadlineMs: number): Promise<ReceiveChannel> {
			const span = busy.open("ingest");
			try {
				const readable = await readFromStream(
					native.incomingUnidirectionalStreams,
					deadlineMs,
					clock,
					span,
				);
				if (readable === null)
					throw new Error("E_SESSION_CLOSED: no more uni streams");
				counters.streamsAccepted++;
				return makeReceiveChannel(readable, clock, busy);
			} finally {
				span.close();
			}
		},

		async openBidi(_deadlineMs: number): Promise<BidiChannel> {
			const span = busy.open("egress");
			try {
				counters.streamOpenAttempts++;
				span.pause();
				const duplex = await native.createBidirectionalStream();
				span.resume();
				counters.streamOpenAccepted++;
				counters.streamsOpened++;
				return makeBidiChannel(duplex, clock, busy);
			} finally {
				span.close();
			}
		},

		async acceptBidi(deadlineMs: number): Promise<BidiChannel> {
			const acceptSpan = busy.open("ingest");
			let pair: Awaited<
				ReturnType<
					typeof readFromStream<{ readable: Readable; writable: Writable }>
				>
			>;
			try {
				pair = await readFromStream(
					native.incomingBidirectionalStreams,
					deadlineMs,
					clock,
					acceptSpan,
				);
			} finally {
				acceptSpan.close();
			}
			if (pair === null)
				throw new Error("E_SESSION_CLOSED: no more bidi streams");
			// The pair has { readable, writable }; wrap as a minimal Duplex-like
			const { readable, writable } = pair as {
				readable: import("node:stream").Readable;
				writable: import("node:stream").Writable;
			};
			counters.streamsAccepted++;
			const channelId = nextChannelId();
			return {
				channelId,
				async write(bytes: Uint8Array, dl: number): Promise<SendObservation> {
					await writeChunk(writable, bytes, dl, clock, busy);
					return {
						status: 0,
						bytes: bytes.byteLength,
						deliveryKind: "reliable-message",
						attempted: true,
						queued: false,
						serverObserved: false,
						acknowledged: false,
						delivered: false,
						channelId,
					};
				},
				async end(dl: number): Promise<void> {
					await endStream(writable, dl, clock, busy);
				},
				async read(dl: number): Promise<Uint8Array | null> {
					// The same seam `makeReceiveChannel` and `makeBidiChannel`
					// carry: this channel is built by hand, so the required
					// parameter that guards those two cannot reach it and the
					// charge is written out here.
					const span = busy.open("ingest");
					try {
						return await readChunk(readable, dl, clock, span);
					} finally {
						span.close();
					}
				},
				async cancel(_dl: number): Promise<void> {
					readable.destroy();
				},
			};
		},

		async close(deadlineMs: number): Promise<void> {
			if (closed) return;
			closed = true;
			await messageSender.close(deadlineMs).catch(() => {});
			counters.sessionsClosed++;
			counters.sessionsActive = 0;
			native.close();
			// Transfer this session from the live set into the
			// completed accumulator exactly once. Leaving it in
			// `liveServerSessions` after close double-counts the
			// same busyMs (live snapshot + closed sum).
			onSessionClose?.(session, sessionLoopUtilization().busyMs);
		},

		snapshot(): TransportMetrics {
			return {
				...counters,
				active: !closed,
				role: "server",
				// 0-RTT truth from the real session — never fabricated
				has0Rtt: native.has0Rtt,
				accepted0Rtt: native.accepted0Rtt,
				handshakeConfirmed: native.handshakeConfirmed,
				loopUtilization: sessionLoopUtilization(),
			} as unknown as TransportMetrics;
		},
	};

	return session;
}

function wrapClientSession(
	native: FakeWtClientSession,
	clock: TransportClock,
): Session {
	const counters = makeSessionCounters();
	let closed = false;
	// One accumulator for the whole session, charged by ingest and egress
	// alike (`SESSION_LOOP_BUSY_MS_DEFINITION`). The client role carries it
	// for the same reason the server does: a leg that only publishes would
	// otherwise report a loop that did nothing while it wrote.
	const busy = new LoopBusyMeter(clock);
	const sessionLoopUtilization = (): {
		readonly busyMs: number;
		readonly windowMs: number;
	} => busy.snapshot();

	// Buffer incoming unidirectional and bidirectional streams
	// so acceptUni / acceptBidi work correctly even when the stream
	// iterable has already begun.
	const uniQueue: Array<{
		resolve: (r: import("node:stream").Readable) => void;
	}> = [];
	const bidiQueue: Array<{ resolve: (d: Duplex) => void }> = [];
	// A stream that arrives before anyone asks for one is held, not dropped.
	// The pump used to discard it whenever `uniQueue` was empty, which is a race
	// nothing could win: the peer opens its message stream the moment it has
	// something to send, and this side only queues a waiter once it gets around
	// to reading. Losing that stream costs the arm every message and every
	// receipt on it, so the funnel it reports is a property of scheduling.
	const pendingUni: Array<import("node:stream").Readable> = [];
	const pendingBidi: Duplex[] = [];
	let uniDone = false;
	let bidiDone = false;

	// Begin draining incoming stream iterables in the background
	(async () => {
		try {
			for await (const r of native.incomingUnidirectionalStreams()) {
				const stream = r as unknown as import("node:stream").Readable;
				const waiter = uniQueue.shift();
				if (waiter) waiter.resolve(stream);
				else pendingUni.push(stream);
			}
		} finally {
			uniDone = true;
		}
	})().catch(() => {
		uniDone = true;
	});

	(async () => {
		try {
			for await (const d of native.incomingBidirectionalStreams()) {
				const waiter = bidiQueue.shift();
				if (waiter) waiter.resolve(d);
				else pendingBidi.push(d);
			}
		} finally {
			bidiDone = true;
		}
	})().catch(() => {
		bidiDone = true;
	});

	function acceptNextUni(
		deadlineMs: number,
	): Promise<import("node:stream").Readable> {
		const ready = pendingUni.shift();
		if (ready !== undefined) return Promise.resolve(ready);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(
				() => {
					// Remove ourselves from queue
					const idx = uniQueue.findIndex((e) => e.resolve === resolve);
					if (idx !== -1) uniQueue.splice(idx, 1);
					reject(
						new Error("E_BACKPRESSURE_TIMEOUT: acceptUni deadline exceeded"),
					);
				},
				toRemainingMs(deadlineMs, clock),
			);

			uniQueue.push({
				resolve: (r) => {
					clearTimeout(timer);
					resolve(r);
				},
			});
		});
	}

	function acceptNextBidi(deadlineMs: number): Promise<Duplex> {
		const ready = pendingBidi.shift();
		if (ready !== undefined) return Promise.resolve(ready);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(
				() => {
					const idx = bidiQueue.findIndex((e) => e.resolve === resolve);
					if (idx !== -1) bidiQueue.splice(idx, 1);
					reject(
						new Error("E_BACKPRESSURE_TIMEOUT: acceptBidi deadline exceeded"),
					);
				},
				toRemainingMs(deadlineMs, clock),
			);

			bidiQueue.push({
				resolve: (d) => {
					clearTimeout(timer);
					resolve(d);
				},
			});
		});
	}

	const messageSender = makeMessageStreamSender(
		() => native.createUnidirectionalStream(),
		counters,
		clock,
		busy,
	);
	const messageReceiver = makeMessageStreamReceiver(
		// The client role's twin of the server's message-stream accept, on the
		// same discipline: the synchronous turn charges, the wait does not.
		async (deadlineMs) => {
			const span = busy.open("ingest");
			try {
				span.pause();
				const stream = await acceptNextUni(deadlineMs);
				span.resume();
				return stream;
			} finally {
				span.close();
			}
		},
		counters,
	);

	const messageReceive = makeMessageReceive({
		counters,
		clock,
		busy,
		datagrams: () => native.incomingDatagrams(),
		messageStream: messageReceiver,
		sendDatagram: (bytes) => native.sendDatagram(bytes),
		sendEnvelope: (bytes, deadlineMs) => messageSender.send(bytes, deadlineMs),
	});
	const { receiveMessage: receiveMessageFn } = messageReceive;

	const session: Session = {
		role: "client",

		async sendMessage(
			kind: DeliveryKind,
			message: WireMessage,
			deadlineMs: number,
		): Promise<SendObservation> {
			// Framing is egress loop work on this arm exactly as it is on WS,
			// and is charged before a byte has left
			// (`SESSION_LOOP_BUSY_MS_DEFINITION`).
			const encoded = busy.measure("egress", () => {
				counters.attempted++;
				const bytes = encodeWireMessage(message);
				// The envelope header is what this arm adds; QUIC's own framing
				// is below this layer and is not visible here, so this is a
				// floor.
				counters.harnessOverheadBytes +=
					bytes.byteLength - message.payload.byteLength;
				return bytes;
			});
			if (kind === "datagram") {
				const span = busy.open("egress");
				try {
					counters.datagramAttempts++;
					span.pause();
					await native.sendDatagram(encoded);
				} finally {
					span.close();
				}
				counters.datagramAccepted++;
				counters.queued++;
				return {
					status: 0,
					bytes: encoded.byteLength,
					deliveryKind: kind,
					attempted: true,
					queued: true,
					serverObserved: false,
					acknowledged: false,
					delivered: false,
				};
			}
			// reliable-message: one envelope on the session's persistent uni
			// stream, mirroring one WS frame on the socket it already holds.
			await messageSender.send(encoded, deadlineMs);
			counters.queued++;
			return {
				status: 0,
				bytes: encoded.byteLength,
				deliveryKind: kind,
				attempted: true,
				queued: true,
				serverObserved: false,
				acknowledged: false,
				delivered: false,
			};
		},

		receiveMessage: receiveMessageFn,

		async sendText(
			_text: string,
			_deadlineMs: number,
		): Promise<SendObservation> {
			throw new Error("sendText not supported by WT adapter");
		},

		async openUni(_deadlineMs: number): Promise<SendChannel> {
			const span = busy.open("egress");
			try {
				counters.streamOpenAttempts++;
				span.pause();
				const writable = await native.createUnidirectionalStream();
				span.resume();
				counters.streamOpenAccepted++;
				counters.streamsOpened++;
				return makeSendChannel(writable, clock, busy);
			} finally {
				span.close();
			}
		},

		async acceptUni(deadlineMs: number): Promise<ReceiveChannel> {
			const span = busy.open("ingest");
			try {
				span.pause();
				const readable = await acceptNextUni(deadlineMs);
				span.resume();
				counters.streamsAccepted++;
				return makeReceiveChannel(readable, clock, busy);
			} finally {
				span.close();
			}
		},

		async openBidi(_deadlineMs: number): Promise<BidiChannel> {
			const span = busy.open("egress");
			try {
				counters.streamOpenAttempts++;
				span.pause();
				const duplex = await native.createBidirectionalStream();
				span.resume();
				counters.streamOpenAccepted++;
				counters.streamsOpened++;
				return makeBidiChannel(duplex, clock, busy);
			} finally {
				span.close();
			}
		},

		async acceptBidi(deadlineMs: number): Promise<BidiChannel> {
			const span = busy.open("ingest");
			try {
				span.pause();
				const duplex = await acceptNextBidi(deadlineMs);
				span.resume();
				counters.streamsAccepted++;
				return makeBidiChannel(duplex, clock, busy);
			} finally {
				span.close();
			}
		},

		async close(deadlineMs: number): Promise<void> {
			if (closed) return;
			closed = true;
			await messageSender.close(deadlineMs).catch(() => {});
			counters.sessionsClosed++;
			counters.sessionsActive = 0;
			native.close();
		},

		snapshot(): TransportMetrics {
			return {
				...counters,
				active: !closed,
				role: "client",
				// 0-RTT truth from the real session — never fabricated
				has0Rtt: native.has0Rtt,
				accepted0Rtt: native.accepted0Rtt,
				handshakeConfirmed: native.handshakeConfirmed,
				loopUtilization: sessionLoopUtilization(),
			} as unknown as TransportMetrics;
		},
	};

	return session;
}

// ---------------------------------------------------------------------------
// Server handle wrapper
// ---------------------------------------------------------------------------

function wrapServerHandle(
	native: WtServerHandle,
	sessionQueue: Array<FakeWtServerSession>,
	clock: TransportClock,
	onStop: () => void,
): ServerHandle {
	let stopped = false;
	const waiters: Array<{
		resolve: (s: Session) => void;
		reject: (e: unknown) => void;
		timer: ReturnType<typeof setTimeout>;
	}> = [];
	// Server-wide loop utilization. The server's main loop is
	// the union of the per-session consumer work, so the sum
	// across all live and closed sessions of the per-session
	// `busyMs` over the wall-clock window since server start is
	// what a tail-latency number published against the server is
	// interpretable against.
	//
	// `liveServerSessions` carries the current per-session busyMs
	// of every session that is still open, so the snapshot can
	// report an up-to-the-moment sum without each session having
	// to be retained in a registry the snapshot has to walk.
	// `closedServerBusyMs` carries the busy time of every session
	// that has already closed, so a snapshot taken after the last
	// session closes still reports the real cumulative load. The
	// combination is what the Phase 2.4 deviation calls
	// "completed-plus-active" accounting.
	const serverLoopWindowStartMs = clock.nowMs();
	const liveServerSessions = new Set<Session>();
	let closedServerBusyMs = 0;

	function onSessionClose(session: Session, busyMs: number): void {
		// Transfer exactly once: remove from the live set, then
		// accumulate into completed. A repeated close (or a
		// close for a session never tracked) is a no-op so the
		// closed accumulator cannot double-count.
		if (!liveServerSessions.delete(session)) {
			return;
		}
		closedServerBusyMs += Math.max(0, busyMs);
	}

	function serverLoopUtilization(): {
		readonly busyMs: number;
		readonly windowMs: number;
	} {
		let liveBusyMs = 0;
		for (const session of liveServerSessions) {
			liveBusyMs += Math.max(0, session.snapshot().loopUtilization.busyMs);
		}
		return {
			busyMs: closedServerBusyMs + liveBusyMs,
			windowMs: Math.max(0, clock.nowMs() - serverLoopWindowStartMs),
		};
	}

	function trackSession(session: Session): Session {
		liveServerSessions.add(session);
		return session;
	}

	// Drain queue into waiting acceptSession callers
	function deliverSession(raw: FakeWtServerSession) {
		const waiter = waiters.shift();
		if (waiter) {
			clearTimeout(waiter.timer);
			waiter.resolve(
				trackSession(wrapServerSession(raw, clock, onSessionClose)),
			);
		} else {
			sessionQueue.push(raw);
		}
	}

	// Sessions pushed via onSession callback
	(
		native as unknown as {
			onSession?: (cb: (s: FakeWtServerSession) => void) => void;
		}
	).onSession?.(deliverSession);

	return {
		async acceptSession(deadlineMs: number): Promise<Session> {
			if (stopped) throw new Error("E_SESSION_CLOSED: server stopped");
			// Check pre-queued sessions
			if (sessionQueue.length > 0) {
				return trackSession(
					wrapServerSession(sessionQueue.shift()!, clock, onSessionClose),
				);
			}
			return new Promise<Session>((resolve, reject) => {
				const remaining = toRemainingMs(deadlineMs, clock);
				const timer = setTimeout(() => {
					const idx = waiters.findIndex((w) => w.resolve === resolve);
					if (idx !== -1) waiters.splice(idx, 1);
					reject(
						new Error("E_HANDSHAKE_TIMEOUT: acceptSession deadline exceeded"),
					);
				}, remaining);

				waiters.push({
					resolve: (session) => resolve(trackSession(session)),
					reject,
					timer,
				});
			});
		},

		async stop(deadlineMs: number): Promise<void> {
			if (stopped) return;
			stopped = true;
			onStop();
			// Reject pending acceptSession callers
			for (const w of waiters.splice(0)) {
				clearTimeout(w.timer);
				w.reject(new Error("E_SESSION_CLOSED: server stopping"));
			}
			const remaining = toRemainingMs(deadlineMs, clock);
			await Promise.race([
				native.close(),
				new Promise<void>((_, reject) =>
					setTimeout(
						() =>
							reject(new Error("E_BACKPRESSURE_TIMEOUT: server stop deadline")),
						remaining,
					),
				),
			]).catch(() => {});
		},

		snapshot(): ServerMetrics {
			const m = (native.metricsSnapshot() as Record<string, unknown>) ?? {};
			const serverLoop = serverLoopUtilization();
			return {
				active: !stopped,
				role: "server",
				sessionsOpened: (m["sessionsOpened"] as number) ?? 0,
				sessionsClosed: (m["sessionsClosed"] as number) ?? 0,
				sessionsActive: (m["sessionsActive"] as number) ?? 0,
				streamsOpened: (m["streamsOpened"] as number) ?? 0,
				streamsAccepted: (m["streamsAccepted"] as number) ?? 0,
				streamsClosed: (m["streamsClosed"] as number) ?? 0,
				attempted: 0,
				queued: 0,
				serverObserved: 0,
				acknowledged: 0,
				delivered: 0,
				refused: 0,
				dropped: 0,
				timedOut: 0,
				queueBytes: 0,
				queueBytesPeak: 0,
				receiveQueueItems: 0,
				receiveQueueBytes: 0,
				harnessOverheadBytes: 0,
				loopUtilization: serverLoop,
				// The scope-explicit field. Same value as
				// `loopUtilization` on a server snapshot; readers
				// that need a server-scope value should use this
				// name and not the older overloaded key.
				serverLoopUtilization: serverLoop,
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
			} as unknown as ServerMetrics;
		},
	};
}

// ---------------------------------------------------------------------------
// Map canonical CapacityProfile → native WT options
// ---------------------------------------------------------------------------

/**
 * Uni streams a session spends on the harness rather than on the scenario.
 *
 * Exactly one: the persistent reliable-message stream. WS's equivalent rides
 * the socket the session already holds and takes no stream-admission token at
 * all -- `sendMessage` reserves bytes and nothing else -- so charging WT's to
 * the profile's per-session budget makes the two arms unequal by one stream.
 * A session that opens its full uni budget and then sends one reliable message
 * succeeds on WS and fails `E_LIMIT_EXCEEDED` on WT, which is a difference in
 * the harness rather than in the transports it is there to compare.
 *
 * The fix is in the accounting, not in the number. `CapacityProfile` states
 * what the *application* may open, which is what both arms enforce against;
 * the QUIC limit is that budget plus what the harness itself holds. Raising
 * the profile to nine would have said something false about the scenario -- it
 * would have given the application a ninth stream on one arm only.
 */
export const HARNESS_STREAMS_PER_SESSION = 1;

function profileToLimits(p: CapacityProfile): Record<string, unknown> {
	return {
		maxSessions: p.maxSessions,
		maxHandshakesInFlight: p.maxHandshakesInFlight,
		maxStreamsPerSessionBidi: p.maxStreamsPerSessionBidi,
		maxStreamsPerSessionUni:
			p.maxStreamsPerSessionUni + HARNESS_STREAMS_PER_SESSION,
		maxStreamsGlobal:
			p.maxStreamsGlobal + p.maxSessions * HARNESS_STREAMS_PER_SESSION,
		maxDatagramSize: p.maxDatagramSize,
		maxQueuedBytesGlobal: p.maxQueuedBytesGlobal,
		maxQueuedBytesPerSession: p.maxQueuedBytesPerSession,
		maxQueuedBytesPerStream: p.maxQueuedBytesPerStream,
		backpressureTimeoutMs: p.backpressureTimeoutMs,
		handshakeTimeoutMs: p.handshakeTimeoutMs,
		idleTimeoutMs: p.idleTimeoutMs,
	};
}

function profileToRateLimits(p: CapacityProfile): Record<string, unknown> {
	return {
		handshakesPerSec: p.handshakesPerSec,
		handshakesBurst: p.handshakesBurst,
		handshakesBurstPerPrefix: p.handshakesBurstPerPrefix,
		streamsPerSec: p.streamsPerSec,
		streamsBurst: p.streamsBurst,
		datagramsPerSec: p.datagramsPerSec,
		datagramsBurst: p.datagramsBurst,
	};
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

export interface WtAdapterOptions {
	serverFactory: WtServerFactory;
	clientFactory: WtClientFactory;
	clock?: TransportClock;
}

/**
 * What a caller may hand the factory.  Either factory can be omitted, in which
 * case it is resolved lazily from the production adapter on first use, so the
 * resolved WtAdapterOptions only exists once getFactories() has run.
 */
export type WtAdapterInit = Partial<WtAdapterOptions>;

export function createWebTransportAdapter(
	opts: WtAdapterInit = {},
): TransportAdapter {
	const clock = opts.clock ?? systemTransportClock;
	const profile = CANONICAL_CAPACITY_PROFILE;
	const submittedBytes = canonicalJson(profile);
	const submittedHash = sha256Canonical(profile);

	const submittedCapacityProfile: SubmittedCapacityProfile = Object.freeze({
		profile,
		bytes: submittedBytes,
		hash: submittedHash,
	});

	let started = false;

	let prodOpts: WtAdapterOptions | undefined;
	async function getFactories(): Promise<WtAdapterOptions> {
		const { serverFactory, clientFactory } = opts;
		if (serverFactory && clientFactory)
			return { serverFactory, clientFactory, clock: opts.clock };
		if (!prodOpts) prodOpts = await productionWtAdapterOptions();
		return {
			serverFactory: serverFactory ?? prodOpts.serverFactory,
			clientFactory: clientFactory ?? prodOpts.clientFactory,
			clock,
		};
	}

	const adapter: TransportAdapter = {
		kind: "wt",

		get submittedCapacityProfile(): SubmittedCapacityProfile {
			return submittedCapacityProfile;
		},

		async startServer(config: ServerConfig): Promise<ServerHandle> {
			if (started) {
				throw new Error(
					"E_INTERNAL: WT adapter: startServer called more than once on the same adapter instance",
				);
			}
			started = true;
			const factories = await getFactories();

			const rawTls = config.tls as Record<string, unknown> | undefined;
			const cert = (rawTls?.certPem ?? rawTls?.cert) as
				| string
				| Uint8Array
				| undefined;
			const key = (rawTls?.keyPem ?? rawTls?.key) as
				| string
				| Uint8Array
				| undefined;

			const serverOptions: WtServerOptions = {
				host: config.hostname,
				port: config.port,
				tls: {
					certPem: cert,
					keyPem: key,
					cert,
					key,
				},
				limits: profileToLimits(profile),
				rateLimits: profileToRateLimits(profile),
			};

			const sessionQueue: FakeWtServerSession[] = [];
			const handle = factories.serverFactory(serverOptions);

			return wrapServerHandle(handle, sessionQueue, clock, () => {});
		},

		async connect(config: ClientConfig): Promise<Session> {
			const factories = await getFactories();
			const clientOptions: Record<string, unknown> = {
				limits: profileToLimits(profile),
			};

			if (config.tls) {
				clientOptions["tls"] = {
					caPem: config.tls.ca,
					serverName: config.tls.serverName,
				};
			}

			if ((config.parameters as Record<string, unknown>)?.["enable0Rtt"]) {
				clientOptions["enable0Rtt"] = true;
			}

			const native = await factories.clientFactory(config.url, clientOptions);
			await native.ready;
			return wrapClientSession(native, clock);
		},
	};

	return adapter;
}

// ---------------------------------------------------------------------------
// Production-use default factory (loaded lazily so unit tests never open sockets)
// ---------------------------------------------------------------------------

/**
 * Returns a WtAdapterOptions using the real createServer / connect from the
 * root package. Only called at measurement time on actual hardware, never in
 * pure unit tests.
 */
export async function productionWtAdapterOptions(): Promise<WtAdapterOptions> {
	// Use relative path to the workspace package to satisfy TypeScript module resolution.
	// At runtime this resolves to the compiled package entry point.
	// eslint-disable-next-line @typescript-eslint/ban-ts-comment
	// @ts-expect-error — dynamic workspace import; types resolved at runtime via package.json exports
	const pkg = (await import("../../../packages/webtransport/src/index.ts")) as {
		createServer: (opts: Record<string, unknown>) => unknown;
		connect: (url: string, opts: unknown) => Promise<FakeWtClientSession>;
	};

	const serverFactory: WtServerFactory = (options) => {
		let capturedOnSession: ((s: FakeWtServerSession) => void) | null = null;

		// Merge tls: prefer certPem/keyPem, fall back to cert/key
		const certPem = options.tls.certPem ?? options.tls.cert;
		const keyPem = options.tls.keyPem ?? options.tls.key;

		const server = pkg.createServer({
			host: options.host,
			port: options.port,
			tls: { certPem, keyPem },
			limits: options.limits,
			rateLimits: options.rateLimits,
			enable0Rtt: options.enable0Rtt,
			allowEarlySession: options.allowEarlySession,
			onSession: (session: FakeWtServerSession) => {
				capturedOnSession?.(session);
			},
		});

		const native = server as unknown as WtServerHandle & {
			onSession(cb: (s: FakeWtServerSession) => void): void;
		};

		// Attach a synthetic onSession forwarder so wrapServerHandle can wire up
		native.onSession = (cb) => {
			capturedOnSession = cb;
		};

		return native;
	};

	const clientFactory: WtClientFactory = async (url, options) => {
		return pkg.connect(url, options);
	};

	return { serverFactory, clientFactory };
}

// ---------------------------------------------------------------------------
// Length-prefixed frame streams
//
// The fanout relay's WT mapping (plan §4.2) is `u32be length || frame` on
// reliable streams: a control bidi stream per role and one server-opened uni
// stream per subscriber. Everything above this line speaks the harness wire
// envelope on top of its own stream discipline, so the relay cannot ride on it
// without double-framing. What follows is the length-prefix plumbing and
// nothing else -- it holds no fanout schema, and no existing code path reads
// or writes any of it.
// ---------------------------------------------------------------------------

/** The `u32be` prefix every framed unit on a reliable stream carries. */
const LENGTH_PREFIX_BYTES = 4;

/**
 * What the transport did with one outbound frame.
 *
 * `would-block` is a promise that the bytes were *not* handed to the stream, so
 * a caller may hold them and retry; a writer that had buffered them and
 * answered `would-block` anyway would make every retry a duplicate delivery.
 */
export type LengthPrefixedSendOutcome = "accepted" | "would-block" | "closed";

/**
 * A second unit kind a stream may carry beside the prefixed ones: every unit
 * that opens with `firstByte` is exactly `unitBytes` long and carries no
 * prefix (its own header states the length). The caller owns both values; the
 * reader only frames by them.
 */
export interface FixedLengthUnitKind {
	readonly firstByte: number;
	readonly unitBytes: number;
}

/**
 * Reassemble whole `u32be length || body` units from arbitrary stream reads.
 *
 * A reliable stream may split or coalesce writes anywhere, so a reader that
 * decoded each chunk on its own would refuse valid traffic and accept two
 * frames as one. Each unit comes back with its prefix still attached, which is
 * what lets the caller hand it to the frame codec unchanged.
 *
 * In mixed mode (`fixed` given) the first byte of each unit decides its
 * framing before the prefix is read: a unit opening with the fixed kind's
 * byte is sliced at exactly `unitBytes` and handed back as-is, so a wrong
 * length inside such a unit is the decoder's refusal, never a stall here; a
 * prefixed unit can never open with that byte, since a legal prefix is far
 * below 2^24 and so starts with `0x00`.
 */
export class LengthPrefixedFrameReader {
	private buffered = new Uint8Array(0);

	/** `maxBodyBytes` is the caller's decoded-frame cap, not a buffer size. */
	constructor(
		private readonly maxBodyBytes: number,
		private readonly fixed?: FixedLengthUnitKind,
	) {
		if (
			fixed !== undefined &&
			(!Number.isInteger(fixed.firstByte) ||
				fixed.firstByte < 0 ||
				fixed.firstByte > 0xff ||
				!Number.isInteger(fixed.unitBytes) ||
				fixed.unitBytes <= 0)
		) {
			throw new RangeError("fixed-length unit kind needs a byte and a length");
		}
	}

	/** Bytes held back because they do not yet complete a unit. */
	get pendingBytes(): number {
		return this.buffered.byteLength;
	}

	push(chunk: Uint8Array): Uint8Array[] {
		if (chunk.byteLength > 0) {
			const merged = new Uint8Array(
				this.buffered.byteLength + chunk.byteLength,
			);
			merged.set(this.buffered, 0);
			merged.set(chunk, this.buffered.byteLength);
			this.buffered = merged;
		}

		const units: Uint8Array[] = [];
		let offset = 0;
		while (this.buffered.byteLength - offset > 0) {
			if (
				this.fixed !== undefined &&
				this.buffered[offset] === this.fixed.firstByte
			) {
				const total = this.fixed.unitBytes;
				if (this.buffered.byteLength - offset < total) break;
				units.push(this.buffered.slice(offset, offset + total));
				offset += total;
				continue;
			}
			if (this.buffered.byteLength - offset < LENGTH_PREFIX_BYTES) break;
			const view = new DataView(
				this.buffered.buffer,
				this.buffered.byteOffset + offset,
				LENGTH_PREFIX_BYTES,
			);
			const length = view.getUint32(0, false);
			// The declared length is checked before any slice is taken, so an
			// absurd prefix cannot drive an allocation; and a stream that has
			// declared an impossible length cannot be resynchronized, so it
			// throws rather than returning a short read.
			if (length === 0 || length > this.maxBodyBytes) {
				throw new RangeError(
					`length-prefixed frame declares ${length} bytes, cap ${this.maxBodyBytes}`,
				);
			}
			const total = LENGTH_PREFIX_BYTES + length;
			if (this.buffered.byteLength - offset < total) break;
			units.push(this.buffered.slice(offset, offset + total));
			offset += total;
		}
		if (offset > 0) this.buffered = this.buffered.slice(offset);
		return units;
	}
}

/** A stream a caller may hand framed units to without waiting on any of them. */
export interface LengthPrefixedWriter {
	/** Units handed to the stream, for a caller to reconcile against its peer. */
	readonly sentFrames: number;
	readonly closed: boolean;
	trySend(bytes: Uint8Array): LengthPrefixedSendOutcome;
	close(): void;
	/**
	 * Settles once everything handed to `trySend` has reached the stream.
	 *
	 * A caller that tears the session down the instant it stops writing would
	 * reset the stream out from under bytes it has already counted as sent, so
	 * the last frames -- a refusal, an end marker -- would never arrive.
	 */
	flushed(): Promise<void>;
}

/** The part of a Node writable stream a frame writer uses. */
interface NodeWritableLike {
	write(chunk: Uint8Array): boolean;
	once(
		event: "drain" | "finish" | "close" | "error",
		listener: () => void,
	): unknown;
	end(): unknown;
	destroy(error?: Error): unknown;
	readonly destroyed?: boolean;
}

/**
 * Write framed units to a Node writable (a WT uni or bidi stream).
 *
 * A `false` from `write` means the bytes were buffered, not dropped: they have
 * been sent once and must never be sent again, so this call is `accepted` and
 * only the *next* one blocks, until the stream drains.
 */
export function nodeWritableFrameWriter(
	writable: NodeWritableLike,
	onDrain?: () => void,
): LengthPrefixedWriter {
	let sent = 0;
	let closed = false;
	let congested = false;

	let finish: () => void = () => {};
	const finished = new Promise<void>((resolve) => {
		finish = resolve;
	});
	writable.once("finish", finish);
	writable.once("close", finish);
	writable.once("error", finish);

	return {
		get sentFrames() {
			return sent;
		},
		get closed() {
			return closed;
		},
		trySend: (bytes) => {
			if (closed || writable.destroyed === true) return "closed";
			if (congested) return "would-block";
			let taken: boolean;
			try {
				taken = writable.write(bytes);
			} catch {
				closed = true;
				return "closed";
			}
			sent += 1;
			if (!taken) {
				congested = true;
				writable.once("drain", () => {
					congested = false;
					onDrain?.();
				});
			}
			return "accepted";
		},
		close: () => {
			if (closed) return;
			closed = true;
			try {
				writable.end();
			} catch {
				// The stream was already gone; the writer is closed either way.
				finish();
			}
		},
		flushed: () => finished,
	};
}

/** The part of a WHATWG writable stream a frame writer uses. */
interface WebWritableLike {
	getWriter(): {
		write(chunk: Uint8Array): Promise<void>;
		readonly ready: Promise<void>;
		readonly desiredSize: number | null;
		close(): Promise<void>;
		releaseLock(): void;
	};
}

/**
 * Write framed units to a WHATWG writable (a WT server-side bidi stream).
 *
 * Writes are chained rather than awaited so the caller stays synchronous, and
 * order is preserved by the chain. `desiredSize <= 0` after a write is this
 * API's backpressure signal: the unit just written was taken, the next one is
 * refused until `ready` settles again.
 */
export function webWritableFrameWriter(
	writable: WebWritableLike,
	onDrain?: () => void,
): LengthPrefixedWriter {
	const writer = writable.getWriter();
	let sent = 0;
	let closed = false;
	let congested = false;
	let chain: Promise<void> = Promise.resolve();

	return {
		get sentFrames() {
			return sent;
		},
		get closed() {
			return closed;
		},
		trySend: (bytes) => {
			if (closed) return "closed";
			if (congested) return "would-block";
			chain = chain.then(
				() => writer.write(bytes),
				() => {
					closed = true;
				},
			);
			sent += 1;
			const desired = writer.desiredSize;
			if (desired !== null && desired <= 0) {
				congested = true;
				writer.ready.then(
					() => {
						congested = false;
						onDrain?.();
					},
					() => {
						closed = true;
					},
				);
			}
			return "accepted";
		},
		close: () => {
			if (closed) return;
			closed = true;
			chain = chain
				.then(() => writer.close())
				.catch(() => {})
				.finally(() => {
					try {
						writer.releaseLock();
					} catch {
						// Already released with the stream; nothing to give back.
					}
				});
		},
		flushed: () => chain.catch(() => {}),
	};
}
