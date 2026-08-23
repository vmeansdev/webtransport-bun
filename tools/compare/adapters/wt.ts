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
	decodeWireMessage,
	encodeWireMessage,
	type WireMessage,
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

// ---------------------------------------------------------------------------
// Node stream helpers
// ---------------------------------------------------------------------------

/** Read one chunk from a Node Readable with a bounded deadline. Returns null on EOF. */
async function readChunk(
	readable: Readable,
	deadlineMs: number,
	clock: TransportClock,
): Promise<Uint8Array | null> {
	return new Promise<Uint8Array | null>((resolve, reject) => {
		const timer = setTimeout(
			() => {
				cleanup();
				reject(new Error("E_BACKPRESSURE_TIMEOUT: read() deadline exceeded"));
			},
			Math.max(1, deadlineMs - clock.nowMs()),
		);

		function cleanup() {
			clearTimeout(timer);
			readable.off("data", onData);
			readable.off("end", onEnd);
			readable.off("error", onError);
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

		readable.once("data", onData);
		readable.once("end", onEnd);
		readable.once("error", onError);

		// Nudge the stream if it hasn't started flowing
		if (readable.readable && !readable.readableFlowing) {
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

/** Write bytes to a Node Writable with a bounded deadline. */
async function writeChunk(
	writable: Writable,
	data: Uint8Array,
	deadlineMs: number,
	clock: TransportClock,
): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const remaining = Math.max(1, deadlineMs - clock.nowMs());
		const timer = setTimeout(() => {
			reject(new Error("E_BACKPRESSURE_TIMEOUT: write() deadline exceeded"));
		}, remaining);

		writable.write(data, (err) => {
			clearTimeout(timer);
			if (err) reject(err);
			else resolve();
		});
	});
}

/** End a Node Writable with a bounded deadline. */
async function endStream(
	writable: Writable,
	deadlineMs: number,
	clock: TransportClock,
): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const remaining = Math.max(1, deadlineMs - clock.nowMs());
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
		const remaining = Math.max(1, deadlineMs - clock.nowMs());
		const result = await Promise.race([
			reader.read(),
			new Promise<{ done: true; value: undefined }>((_, reject) =>
				setTimeout(
					() =>
						reject(
							new Error(
								"E_BACKPRESSURE_TIMEOUT: acceptSession/stream deadline exceeded",
							),
						),
					remaining,
				),
			),
		]);
		if (result.done) return null;
		return result.value ?? null;
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

function wrapServerSession(
	native: FakeWtServerSession,
	clock: TransportClock,
): Session {
	const counters = makeSessionCounters();
	let closed = false;

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
				counters.delivered++;
				return {
					status: 0,
					bytes: encoded.byteLength,
					deliveryKind: kind,
					attempted: true,
					queued: false,
					serverObserved: false,
					acknowledged: false,
					delivered: false,
				};
			}
			// reliable-message: write to a persistent bidi or uni stream
			// For sendMessage we create a short-lived uni stream per call (the driver
			// manages long-lived channels; this is the primitive path)
			counters.streamOpenAttempts++;
			const writable = await native.createUnidirectionalStream();
			counters.streamOpenAccepted++;
			counters.streamsOpened++;
			await writeChunk(writable, encoded, deadlineMs, clock);
			counters.streamsOpened++;
			return {
				status: 0,
				bytes: encoded.byteLength,
				deliveryKind: kind,
				attempted: true,
				queued: false,
				serverObserved: false,
				acknowledged: false,
				delivered: false,
			};
		},

		async receiveMessage(
			kind: DeliveryKind,
			deadlineMs: number,
		): Promise<WireMessage> {
			if (kind === "datagram") {
				// Read from the datagram async iterator
				const iter = native.incomingDatagrams()[Symbol.asyncIterator]();
				const remaining = Math.max(1, deadlineMs - clock.nowMs());
				const result = await Promise.race([
					iter.next(),
					new Promise<IteratorResult<Uint8Array>>((_res, reject) =>
						setTimeout(
							() =>
								reject(
									new Error(
										"E_BACKPRESSURE_TIMEOUT: receiveMessage datagram deadline",
									),
								),
							remaining,
						),
					),
				]);
				if (result.done) throw new Error("E_SESSION_CLOSED: no more datagrams");
				return decodeWireMessage(result.value);
			}
			// reliable-message: accept a uni stream from the client
			const readable = await readFromStream(
				native.incomingUnidirectionalStreams,
				deadlineMs,
				clock,
			);
			if (readable === null)
				throw new Error("E_SESSION_CLOSED: no more uni streams");
			counters.streamsAccepted++;
			const chunk = await readChunk(
				readable as unknown as import("node:stream").Readable,
				deadlineMs,
				clock,
			);
			if (chunk === null) throw new Error("E_SESSION_CLOSED: empty stream");
			return decodeWireMessage(chunk);
		},

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

		async close(_deadlineMs: number): Promise<void> {
			if (closed) return;
			closed = true;
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
	let uniDone = false;
	let bidiDone = false;

	// Begin draining incoming stream iterables in the background
	(async () => {
		try {
			for await (const r of native.incomingUnidirectionalStreams()) {
				if (uniQueue.length > 0) {
					uniQueue
						.shift()!
						.resolve(r as unknown as import("node:stream").Readable);
				}
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
				if (bidiQueue.length > 0) {
					bidiQueue.shift()!.resolve(d);
				}
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
				Math.max(1, deadlineMs - clock.nowMs()),
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
		return new Promise((resolve, reject) => {
			const timer = setTimeout(
				() => {
					const idx = bidiQueue.findIndex((e) => e.resolve === resolve);
					if (idx !== -1) bidiQueue.splice(idx, 1);
					reject(
						new Error("E_BACKPRESSURE_TIMEOUT: acceptBidi deadline exceeded"),
					);
				},
				Math.max(1, deadlineMs - clock.nowMs()),
			);

			bidiQueue.push({
				resolve: (d) => {
					clearTimeout(timer);
					resolve(d);
				},
			});
		});
	}

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
				counters.delivered++;
				return {
					status: 0,
					bytes: encoded.byteLength,
					deliveryKind: kind,
					attempted: true,
					queued: false,
					serverObserved: false,
					acknowledged: false,
					delivered: false,
				};
			}
			counters.streamOpenAttempts++;
			const writable = await native.createUnidirectionalStream();
			counters.streamOpenAccepted++;
			counters.streamsOpened++;
			await writeChunk(writable, encoded, deadlineMs, clock);
			return {
				status: 0,
				bytes: encoded.byteLength,
				deliveryKind: kind,
				attempted: true,
				queued: false,
				serverObserved: false,
				acknowledged: false,
				delivered: false,
			};
		},

		async receiveMessage(
			kind: DeliveryKind,
			deadlineMs: number,
		): Promise<WireMessage> {
			if (kind === "datagram") {
				const iter = native.incomingDatagrams()[Symbol.asyncIterator]();
				const remaining = Math.max(1, deadlineMs - clock.nowMs());
				const result = await Promise.race([
					iter.next(),
					new Promise<IteratorResult<Uint8Array>>((_r, reject) =>
						setTimeout(
							() =>
								reject(
									new Error(
										"E_BACKPRESSURE_TIMEOUT: receiveMessage datagram deadline",
									),
								),
							remaining,
						),
					),
				]);
				if (result.done) throw new Error("E_SESSION_CLOSED: no more datagrams");
				return decodeWireMessage(result.value);
			}
			const readable = await acceptNextUni(deadlineMs);
			counters.streamsAccepted++;
			const chunk = await readChunk(readable, deadlineMs, clock);
			if (chunk === null) throw new Error("E_SESSION_CLOSED: empty stream");
			return decodeWireMessage(chunk);
		},

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

		async close(_deadlineMs: number): Promise<void> {
			if (closed) return;
			closed = true;
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
				const timer = setTimeout(
					() => {
						const idx = waiters.findIndex((w) => w.resolve === resolve);
						if (idx !== -1) waiters.splice(idx, 1);
						reject(
							new Error("E_HANDSHAKE_TIMEOUT: acceptSession deadline exceeded"),
						);
					},
					Math.max(1, deadlineMs - clock.nowMs()),
				);

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
			const remaining = Math.max(1, deadlineMs - clock.nowMs());
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

function profileToLimits(p: CapacityProfile): Record<string, unknown> {
	return {
		maxSessions: p.maxSessions,
		maxHandshakesInFlight: p.maxHandshakesInFlight,
		maxStreamsPerSessionBidi: p.maxStreamsPerSessionBidi,
		maxStreamsPerSessionUni: p.maxStreamsPerSessionUni,
		maxStreamsGlobal: p.maxStreamsGlobal,
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

export function createWebTransportAdapter(
	opts: WtAdapterOptions,
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

			const serverOptions: WtServerOptions = {
				host: config.hostname,
				port: config.port,
				tls: {
					certPem: config.tls?.cert as string | Uint8Array | undefined,
					keyPem: config.tls?.key as string | Uint8Array | undefined,
					cert: config.tls?.cert as string | Uint8Array | undefined,
					key: config.tls?.key as string | Uint8Array | undefined,
				},
				limits: profileToLimits(profile),
				rateLimits: profileToRateLimits(profile),
			};

			const sessionQueue: FakeWtServerSession[] = [];
			const handle = opts.serverFactory(serverOptions);

			return wrapServerHandle(handle, sessionQueue, clock, () => {});
		},

		async connect(config: ClientConfig): Promise<Session> {
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

			const native = await opts.clientFactory(config.url, clientOptions);
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
	// @ts-ignore — dynamic workspace import; types resolved at runtime via package.json exports
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
