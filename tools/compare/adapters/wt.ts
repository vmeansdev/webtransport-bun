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
	type ReceiveChannel,
	type SendChannel,
	type SendObservation,
	type ServerConfig,
	type ServerHandle,
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
	readonly incomingUnidirectionalStreams: ReadableStream<Readable>;
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

/** Read one chunk from a Node Readable or Web ReadableStream with a bounded deadline. Returns null on EOF. */
async function readChunk(
	readable: any,
	deadlineMs: number,
	clock: TransportClock,
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
			return await Promise.race([readPromise, timeoutPromise]);
		} finally {
			if (timer !== undefined) clearTimeout(timer);
			reader.releaseLock();
		}
	}
	return new Promise<Uint8Array | null>((resolve, reject) => {
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
}

/** Write bytes to a Node Writable or Web WritableStream with a bounded deadline. */
async function writeChunk(
	writable: any,
	data: Uint8Array,
	deadlineMs: number,
	clock: TransportClock,
): Promise<void> {
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
			await Promise.race([writer.write(data), timeoutPromise]);
		} finally {
			if (timer !== undefined) clearTimeout(timer);
			writer.releaseLock();
		}
		return;
	}
	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new Error("E_BACKPRESSURE_TIMEOUT: write() deadline exceeded"));
		}, remaining);

		writable.write(data, (err: unknown) => {
			clearTimeout(timer);
			if (err) reject(err);
			else resolve();
		});
	});
}

/** End a Node Writable or Web WritableStream with a bounded deadline. */
async function endStream(
	writable: any,
	deadlineMs: number,
	clock: TransportClock,
): Promise<void> {
	const remaining = toRemainingMs(deadlineMs, clock);
	if (writable && typeof writable.getWriter === "function") {
		const writer = writable.getWriter();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeoutPromise = new Promise<never>((_, reject) => {
			timer = setTimeout(
				() =>
					reject(new Error("E_BACKPRESSURE_TIMEOUT: end() deadline exceeded")),
				remaining,
			);
		});
		try {
			await Promise.race([writer.close(), timeoutPromise]);
		} finally {
			if (timer !== undefined) clearTimeout(timer);
			writer.releaseLock();
		}
		return;
	}
	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new Error("E_BACKPRESSURE_TIMEOUT: end() deadline exceeded"));
		}, remaining);

		writable.end((err?: Error | null) => {
			clearTimeout(timer);
			if (err) reject(err);
			else resolve();
		});
	});
}

// ---------------------------------------------------------------------------
// Stream-backed channels
// ---------------------------------------------------------------------------

function makeSendChannel(
	writable: Writable,
	clock: TransportClock,
): SendChannel {
	const channelId = nextChannelId();
	return {
		channelId,
		async write(
			bytes: Uint8Array,
			deadlineMs: number,
		): Promise<SendObservation> {
			await writeChunk(writable, bytes, deadlineMs, clock);
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
			await endStream(writable, deadlineMs, clock);
		},
	};
}

function makeReceiveChannel(
	readable: Readable,
	clock: TransportClock,
): ReceiveChannel {
	const channelId = nextChannelId();
	return {
		channelId,
		async read(deadlineMs: number): Promise<Uint8Array | null> {
			return readChunk(readable, deadlineMs, clock);
		},
		async cancel(_deadlineMs: number): Promise<void> {
			readable.destroy();
		},
	};
}

function makeBidiChannel(duplex: Duplex, clock: TransportClock): BidiChannel {
	const channelId = nextChannelId();
	return {
		channelId,
		async write(
			bytes: Uint8Array,
			deadlineMs: number,
		): Promise<SendObservation> {
			await writeChunk(duplex, bytes, deadlineMs, clock);
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
			await endStream(duplex, deadlineMs, clock);
		},
		async read(deadlineMs: number): Promise<Uint8Array | null> {
			return readChunk(duplex, deadlineMs, clock);
		},
		async cancel(_deadlineMs: number): Promise<void> {
			duplex.destroy();
		},
	};
}

// ---------------------------------------------------------------------------
// ReadableStream reader helpers for native WT stream surfaces
// ---------------------------------------------------------------------------

/** Read one item from a WHATWG ReadableStream with a deadline. */
async function readFromStream<T>(
	stream: ReadableStream<T>,
	deadlineMs: number,
	clock: TransportClock,
): Promise<T | null> {
	const reader = stream.getReader();
	try {
		const remaining = toRemainingMs(deadlineMs, clock);
		const result = await Promise.race([
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
			if (ended) throw new Error("E_SESSION_CLOSED: message stream is closed");
			const stream = await ensureStream();
			const write = tail
				.catch(() => {})
				.then(() => writeChunk(stream, encoded, deadlineMs, clock));
			tail = write.catch(() => {});
			await write;
		},
		async close(deadlineMs: number): Promise<void> {
			if (ended) return;
			ended = true;
			if (writable === null) return;
			const stream = writable;
			writable = null;
			await tail.catch(() => {});
			await endStream(stream, deadlineMs, clock);
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
	readonly open: (deadlineMs: number) => Promise<EnvelopeFeed>;
	readonly endedMessage: string;
}): (deadlineMs: number) => Promise<WireMessage> {
	const { counters, clock } = input;
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

	return async function receive(deadlineMs: number): Promise<WireMessage> {
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
	readonly datagrams: () => AsyncIterable<Uint8Array>;
	readonly messageStream: MessageStreamReceiver;
	readonly sendDatagram: (bytes: Uint8Array) => Promise<void>;
	readonly sendEnvelope: (
		bytes: Uint8Array,
		deadlineMs: number,
	) => Promise<void>;
}): (kind: DeliveryKind, deadlineMs: number) => Promise<WireMessage> {
	const { counters } = input;
	const datagramFeed = makeDatagramFeed(input.datagrams);
	const receiveDatagram = makeIngest({
		counters,
		clock: input.clock,
		open: async () => datagramFeed,
		endedMessage: "E_SESSION_CLOSED: no more datagrams",
	});
	const receiveEnvelope = makeIngest({
		counters,
		clock: input.clock,
		open: (deadlineMs) => input.messageStream.open(deadlineMs),
		endedMessage: "E_SESSION_CLOSED: message stream ended",
	});
	return async function receiveMessage(
		kind: DeliveryKind,
		deadlineMs: number,
	): Promise<WireMessage> {
		const decoded =
			kind === "datagram"
				? await receiveDatagram(deadlineMs)
				: await receiveEnvelope(deadlineMs);
		counters.delivered++;
		const receipt = encodeWireMessage(ackFor(decoded));
		try {
			if (kind === "datagram") await input.sendDatagram(receipt);
			else await input.sendEnvelope(receipt, deadlineMs);
		} catch {
			// Best effort; see the note above.
		}
		return decoded;
	};
}

function wrapServerSession(
	native: FakeWtServerSession,
	clock: TransportClock,
): Session {
	const counters = makeSessionCounters();
	let closed = false;
	const messageSender = makeMessageStreamSender(
		() => native.createUnidirectionalStream(),
		counters,
		clock,
	);
	const messageReceiver = makeMessageStreamReceiver(
		(deadlineMs) =>
			readFromStream(
				native.incomingUnidirectionalStreams,
				deadlineMs,
				clock,
			) as Promise<Readable | null>,
		counters,
	);

	const receiveMessage = makeMessageReceive({
		counters,
		clock,
		datagrams: () => native.incomingDatagrams(),
		messageStream: messageReceiver,
		sendDatagram: (bytes) => native.sendDatagram(bytes),
		sendEnvelope: (bytes, deadlineMs) => messageSender.send(bytes, deadlineMs),
	});

	const session: Session = {
		role: "server",

		async sendMessage(
			kind: DeliveryKind,
			message: WireMessage,
			deadlineMs: number,
		): Promise<SendObservation> {
			counters.attempted++;
			const encoded = encodeWireMessage(message);
			if (kind === "datagram") {
				counters.datagramAttempts++;
				await native.sendDatagram(encoded);
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

		receiveMessage,

		async sendText(
			_text: string,
			_deadlineMs: number,
		): Promise<SendObservation> {
			throw new Error("sendText not supported by WT adapter");
		},

		async openUni(deadlineMs: number): Promise<SendChannel> {
			counters.streamOpenAttempts++;
			const writable = await native.createUnidirectionalStream();
			counters.streamOpenAccepted++;
			counters.streamsOpened++;
			return makeSendChannel(writable, clock);
		},

		async acceptUni(deadlineMs: number): Promise<ReceiveChannel> {
			const readable = await readFromStream(
				native.incomingUnidirectionalStreams,
				deadlineMs,
				clock,
			);
			if (readable === null)
				throw new Error("E_SESSION_CLOSED: no more uni streams");
			counters.streamsAccepted++;
			return makeReceiveChannel(
				readable as unknown as import("node:stream").Readable,
				clock,
			);
		},

		async openBidi(deadlineMs: number): Promise<BidiChannel> {
			counters.streamOpenAttempts++;
			const duplex = await native.createBidirectionalStream();
			counters.streamOpenAccepted++;
			counters.streamsOpened++;
			return makeBidiChannel(duplex, clock);
		},

		async acceptBidi(deadlineMs: number): Promise<BidiChannel> {
			const pair = await readFromStream(
				native.incomingBidirectionalStreams,
				deadlineMs,
				clock,
			);
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
					await writeChunk(writable, bytes, dl, clock);
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
					await endStream(writable, dl, clock);
				},
				async read(dl: number): Promise<Uint8Array | null> {
					return readChunk(readable, dl, clock);
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
	);
	const messageReceiver = makeMessageStreamReceiver(
		(deadlineMs) => acceptNextUni(deadlineMs),
		counters,
	);

	const receiveMessage = makeMessageReceive({
		counters,
		clock,
		datagrams: () => native.incomingDatagrams(),
		messageStream: messageReceiver,
		sendDatagram: (bytes) => native.sendDatagram(bytes),
		sendEnvelope: (bytes, deadlineMs) => messageSender.send(bytes, deadlineMs),
	});

	const session: Session = {
		role: "client",

		async sendMessage(
			kind: DeliveryKind,
			message: WireMessage,
			deadlineMs: number,
		): Promise<SendObservation> {
			counters.attempted++;
			const encoded = encodeWireMessage(message);
			if (kind === "datagram") {
				counters.datagramAttempts++;
				await native.sendDatagram(encoded);
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

		receiveMessage,

		async sendText(
			_text: string,
			_deadlineMs: number,
		): Promise<SendObservation> {
			throw new Error("sendText not supported by WT adapter");
		},

		async openUni(deadlineMs: number): Promise<SendChannel> {
			counters.streamOpenAttempts++;
			const writable = await native.createUnidirectionalStream();
			counters.streamOpenAccepted++;
			counters.streamsOpened++;
			return makeSendChannel(writable, clock);
		},

		async acceptUni(deadlineMs: number): Promise<ReceiveChannel> {
			const readable = await acceptNextUni(deadlineMs);
			counters.streamsAccepted++;
			return makeReceiveChannel(readable, clock);
		},

		async openBidi(deadlineMs: number): Promise<BidiChannel> {
			counters.streamOpenAttempts++;
			const duplex = await native.createBidirectionalStream();
			counters.streamOpenAccepted++;
			counters.streamsOpened++;
			return makeBidiChannel(duplex, clock);
		},

		async acceptBidi(deadlineMs: number): Promise<BidiChannel> {
			const duplex = await acceptNextBidi(deadlineMs);
			counters.streamsAccepted++;
			return makeBidiChannel(duplex, clock);
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

	// Drain queue into waiting acceptSession callers
	function deliverSession(raw: FakeWtServerSession) {
		const waiter = waiters.shift();
		if (waiter) {
			clearTimeout(waiter.timer);
			waiter.resolve(wrapServerSession(raw, clock));
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
				return wrapServerSession(sessionQueue.shift()!, clock);
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

				waiters.push({ resolve, reject, timer });
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

		snapshot(): TransportMetrics {
			const m = (native.metricsSnapshot() as Record<string, unknown>) ?? {};
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
			} as unknown as TransportMetrics;
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
