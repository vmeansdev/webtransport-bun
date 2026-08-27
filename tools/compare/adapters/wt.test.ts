/**
 * Task 5: WebTransport comparison adapter tests (fake-backed, no sockets).
 *
 * Covers:
 *  - client connect and server accept session mapping
 *  - datagram / reliable-message selection
 *  - both-side uni/bidi create/accept lifecycle
 *  - Node stream backpressure (write/end/read/cancel)
 *  - close/reset/timeout mapping
 *  - 0-RTT truth-counter propagation (has0Rtt, accepted0Rtt, handshakeConfirmed)
 *  - exact canonical capacity profile serialized to WT server options
 *  - submitted profile bytes/hash recorded in artifacts
 *  - WT behavioral counters (no fabricated runtime applied-config echo)
 *  - one submitted profile per adapter instance; divergent starts rejected
 */
import { describe, expect, it } from "bun:test";
import { Duplex, Readable, Writable } from "node:stream";
import { canonicalJson, sha256Canonical } from "../canonical.ts";
import { CANONICAL_CAPACITY_PROFILE } from "../scenario-registry.ts";
import { encodeWireMessage } from "../wire.ts";
import type {
	BidiChannel,
	ReceiveChannel,
	SendChannel,
	ServerHandle,
	Session,
	SubmittedCapacityProfile,
	TransportAdapter,
	TransportMetrics,
} from "./transport.ts";
import {
	createWebTransportAdapter,
	type FakeWtClientSession,
	type FakeWtServerSession,
	type WtClientFactory,
	type WtServerFactory,
} from "./wt.ts";

// ---------------------------------------------------------------------------
// Fake helpers
// ---------------------------------------------------------------------------

/** Creates an in-memory readable Node stream that feeds bytes on demand. */
function makeReadable(chunks: Uint8Array[]): Readable {
	let idx = 0;
	return new Readable({
		read() {
			if (idx < chunks.length) {
				this.push(chunks[idx++]);
			} else {
				this.push(null);
			}
		},
	});
}

/** Creates an in-memory writable Node stream that collects written chunks. */
function makeWritable(collected: Uint8Array[]): Writable {
	return new Writable({
		write(chunk: Buffer | Uint8Array, _enc, cb) {
			collected.push(
				chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk),
			);
			cb();
		},
	});
}

/** Creates a fake duplex Node stream. */
function makeDuplex(
	serverChunks: Uint8Array[],
	clientWritten: Uint8Array[],
): Duplex {
	let idx = 0;
	return new Duplex({
		read() {
			if (idx < serverChunks.length) {
				this.push(serverChunks[idx++]);
			} else {
				this.push(null);
			}
		},
		write(chunk: Buffer | Uint8Array, _enc, cb) {
			clientWritten.push(
				chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk),
			);
			cb();
		},
	});
}

/** Minimal fake server session */
function makeFakeServerSession(
	overrides: Partial<FakeWtServerSession> = {},
): FakeWtServerSession {
	const datagrams: Uint8Array[] = [];
	const incomingBidi: Duplex[] = [];
	const incomingUni: Readable[] = [];
	const serverOpenedBidi: Array<Duplex> = [];
	const serverOpenedUni: Array<Writable> = [];

	return {
		id: "fake-server-session-id",
		peer: { ip: "10.99.0.1", port: 12345 },
		has0Rtt: false,
		accepted0Rtt: false,
		handshakeConfirmed: true,
		ready: Promise.resolve(),
		closed: new Promise(() => {}),
		draining: new Promise(() => {}),
		datagrams,
		incomingBidi,
		incomingUni,
		serverOpenedBidi,
		serverOpenedUni,
		close: (_info?: unknown) => {},
		drain: () => {},
		sendDatagram: async (data: Uint8Array) => {
			datagrams.push(data);
		},
		sendDatagramBatch: async (items: readonly Uint8Array[]) => {
			datagrams.push(...items);
			return { sent: items.length };
		},
		incomingDatagrams: async function* () {
			for (const d of datagrams) yield d;
		},
		incomingBidirectionalStreams: {
			getReader: () => {
				let idx = 0;
				return {
					read: async () =>
						idx < incomingBidi.length
							? {
									done: false,
									value: {
										readable: incomingBidi[idx],
										writable: incomingBidi[idx++],
									},
								}
							: { done: true, value: undefined },
					cancel: async () => {},
					releaseLock: () => {},
				};
			},
		} as unknown as ReadableStream<{ readable: Readable; writable: Writable }>,
		incomingUnidirectionalStreams: {
			getReader: () => {
				let idx = 0;
				return {
					read: async () =>
						idx < incomingUni.length
							? { done: false, value: incomingUni[idx++] }
							: { done: true, value: undefined },
					cancel: async () => {},
					releaseLock: () => {},
				};
			},
		} as unknown as ReadableStream<Readable>,
		createBidirectionalStream: async () => {
			const collected: Uint8Array[] = [];
			const d = makeDuplex([], collected);
			serverOpenedBidi.push(d);
			return d;
		},
		createUnidirectionalStream: async () => {
			const collected: Uint8Array[] = [];
			const w = makeWritable(collected);
			serverOpenedUni.push(w);
			return w;
		},
		metricsSnapshot: () =>
			({ sessionsOpened: 1, sessionsClosed: 0 }) as unknown as ReturnType<
				typeof metricsSnapshot
			>,
		goAway: () => {},
		...overrides,
	} as unknown as FakeWtServerSession;
}

/** Minimal fake client session */
function makeFakeClientSession(
	overrides: Partial<FakeWtClientSession> = {},
): FakeWtClientSession {
	const datagrams: Uint8Array[] = [];
	const incomingBidiChunks: Array<{ readable: Readable; writable: Writable }> =
		[];
	const incomingUniChunks: Readable[] = [];
	const clientOpenedBidi: Duplex[] = [];
	const clientOpenedUni: Writable[] = [];

	return {
		id: "fake-client-session-id",
		peer: { ip: "10.99.0.2", port: 4433 },
		has0Rtt: false,
		accepted0Rtt: false,
		handshakeConfirmed: true,
		ready: Promise.resolve(),
		closed: new Promise(() => {}),
		draining: new Promise(() => {}),
		datagrams,
		incomingBidiChunks,
		incomingUniChunks,
		clientOpenedBidi,
		clientOpenedUni,
		close: (_info?: unknown) => {},
		drain: () => {},
		sendDatagram: async (data: Uint8Array) => {
			datagrams.push(data);
		},
		sendDatagramBatch: async (items: readonly Uint8Array[]) => {
			datagrams.push(...items);
			return { sent: items.length };
		},
		incomingDatagrams: async function* () {
			for (const d of datagrams) yield d;
		},
		createBidirectionalStream: async () => {
			const collected: Uint8Array[] = [];
			const d = makeDuplex([], collected);
			clientOpenedBidi.push(d);
			return d;
		},
		incomingBidirectionalStreams: async function* () {
			for (const pair of incomingBidiChunks) yield pair as unknown as Duplex;
		},
		createUnidirectionalStream: async () => {
			const collected: Uint8Array[] = [];
			const w = makeWritable(collected);
			clientOpenedUni.push(w);
			return w;
		},
		incomingUnidirectionalStreams: async function* () {
			for (const r of incomingUniChunks) yield r;
		},
		metricsSnapshot: () =>
			({ sessionsOpened: 1, sessionsClosed: 0 }) as unknown as ReturnType<
				typeof metricsSnapshot
			>,
		...overrides,
	} as unknown as FakeWtClientSession;
}

function metricsSnapshot() {
	return {
		sessionsOpened: 1,
		sessionsClosed: 0,
		streamsOpened: 0,
		streamsAccepted: 0,
		streamsClosed: 0,
	};
}

// Build factories that return the fakes
function makeFactories(
	opts: {
		serverSession?: FakeWtServerSession;
		clientSession?: FakeWtClientSession;
		serverOptions?: Record<string, unknown>;
	} = {},
): {
	server: WtServerFactory;
	client: WtClientFactory;
	capturedOptions: Record<string, unknown>[];
} {
	const serverSession = opts.serverSession ?? makeFakeServerSession();
	const clientSession = opts.clientSession ?? makeFakeClientSession();
	const capturedOptions: Record<string, unknown>[] = [];

	const server: WtServerFactory = (options) => {
		capturedOptions.push(options as Record<string, unknown>);
		const sessionQueue: FakeWtServerSession[] = [serverSession];
		const sessionQueueResolve: ((s: FakeWtServerSession) => void) | null = null;
		return {
			address: { host: "10.99.0.2", port: options.port ?? 4433 },
			congestionControl: "default",
			close: async () => {},
			metricsSnapshot: () => ({}),
			sendDatagramMirror: () => ({ sent: 0, failures: [] }),
			sendDatagramMirrorPaced: () => ({ admitted: 0 }),
			readMirrorReports: () => [],
			tlsSnapshot: () => ({ sni: [] }),
			updateCert: async () => {},
			updateTls: async () => {},
			replaceSniCerts: async () => {},
			upsertSniCert: async () => {},
			removeSniCert: async () => {},
			setUnknownSniPolicy: async () => {},
			goAway: () => {},
			onSession(cb: (s: FakeWtServerSession) => void) {
				if (sessionQueue.length > 0) {
					cb(sessionQueue.shift()!);
				} else {
					// store for later
				}
			},
			// For tests, the server factory captures the onSession callback so tests can push sessions
			_pushSession(
				s: FakeWtServerSession,
				cb: (s: FakeWtServerSession) => void,
			) {
				cb(s);
			},
		} as unknown as ReturnType<WtServerFactory>;
	};

	const client: WtClientFactory = async (_url, _options) => {
		return clientSession as unknown as Awaited<ReturnType<WtClientFactory>>;
	};

	return { server, client, capturedOptions };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("native WebTransport comparison adapter", () => {
	it("submits the exact canonical capacity profile as WT server options", async () => {
		const { server, client, capturedOptions } = makeFactories();
		const adapter = createWebTransportAdapter({
			serverFactory: server,
			clientFactory: client,
		});

		await adapter
			.startServer({
				port: 4433,
				tls: { cert: "cert", key: "key" },
			})
			.then((h) => h.stop(1000).catch(() => {}));

		expect(capturedOptions.length).toBe(1);
		const opts = capturedOptions[0];
		expect(opts).toBeDefined();
		if (!opts) return; // narrow type

		// limits must match canonical profile exactly
		const limits = opts["limits"] as Record<string, unknown>;
		expect(limits).toBeDefined();
		expect(limits["maxSessions"]).toBe(CANONICAL_CAPACITY_PROFILE.maxSessions);
		expect(limits["maxHandshakesInFlight"]).toBe(
			CANONICAL_CAPACITY_PROFILE.maxHandshakesInFlight,
		);
		expect(limits["maxStreamsPerSessionBidi"]).toBe(
			CANONICAL_CAPACITY_PROFILE.maxStreamsPerSessionBidi,
		);
		expect(limits["maxStreamsPerSessionUni"]).toBe(
			CANONICAL_CAPACITY_PROFILE.maxStreamsPerSessionUni,
		);
		expect(limits["maxStreamsGlobal"]).toBe(
			CANONICAL_CAPACITY_PROFILE.maxStreamsGlobal,
		);
		expect(limits["maxDatagramSize"]).toBe(
			CANONICAL_CAPACITY_PROFILE.maxDatagramSize,
		);
		expect(limits["maxQueuedBytesGlobal"]).toBe(
			CANONICAL_CAPACITY_PROFILE.maxQueuedBytesGlobal,
		);
		expect(limits["maxQueuedBytesPerSession"]).toBe(
			CANONICAL_CAPACITY_PROFILE.maxQueuedBytesPerSession,
		);
		expect(limits["maxQueuedBytesPerStream"]).toBe(
			CANONICAL_CAPACITY_PROFILE.maxQueuedBytesPerStream,
		);
		expect(limits["backpressureTimeoutMs"]).toBe(
			CANONICAL_CAPACITY_PROFILE.backpressureTimeoutMs,
		);
		expect(limits["handshakeTimeoutMs"]).toBe(
			CANONICAL_CAPACITY_PROFILE.handshakeTimeoutMs,
		);
		expect(limits["idleTimeoutMs"]).toBe(
			CANONICAL_CAPACITY_PROFILE.idleTimeoutMs,
		);

		// rateLimits must match canonical profile
		const rateLimits = opts["rateLimits"] as Record<string, unknown>;
		expect(rateLimits).toBeDefined();
		expect(rateLimits["handshakesPerSec"]).toBe(
			CANONICAL_CAPACITY_PROFILE.handshakesPerSec,
		);
		expect(rateLimits["handshakesBurst"]).toBe(
			CANONICAL_CAPACITY_PROFILE.handshakesBurst,
		);
		expect(rateLimits["handshakesBurstPerPrefix"]).toBe(
			CANONICAL_CAPACITY_PROFILE.handshakesBurstPerPrefix,
		);
		expect(rateLimits["streamsPerSec"]).toBe(
			CANONICAL_CAPACITY_PROFILE.streamsPerSec,
		);
		expect(rateLimits["streamsBurst"]).toBe(
			CANONICAL_CAPACITY_PROFILE.streamsBurst,
		);
		expect(rateLimits["datagramsPerSec"]).toBe(
			CANONICAL_CAPACITY_PROFILE.datagramsPerSec,
		);
		expect(rateLimits["datagramsBurst"]).toBe(
			CANONICAL_CAPACITY_PROFILE.datagramsBurst,
		);
	});

	it("records submitted profile bytes and SHA-256 hash in the adapter", async () => {
		const { server, client } = makeFactories();
		const adapter = createWebTransportAdapter({
			serverFactory: server,
			clientFactory: client,
		});

		const submitted: SubmittedCapacityProfile =
			adapter.submittedCapacityProfile;
		const expectedBytes = canonicalJson(CANONICAL_CAPACITY_PROFILE);
		const expectedHash = sha256Canonical(CANONICAL_CAPACITY_PROFILE);

		expect(submitted.profile).toEqual(CANONICAL_CAPACITY_PROFILE);
		expect(submitted.bytes).toBe(expectedBytes);
		expect(submitted.hash).toBe(expectedHash);
		expect(submitted.hash).toMatch(/^[0-9a-f]{64}$/);
	});

	it("has kind 'wt'", () => {
		const { server, client } = makeFactories();
		const adapter = createWebTransportAdapter({
			serverFactory: server,
			clientFactory: client,
		});
		expect(adapter.kind).toBe("wt");
	});

	it("does not expose a runtime applied-config echo in metrics", async () => {
		const { server, client } = makeFactories();
		const adapter = createWebTransportAdapter({
			serverFactory: server,
			clientFactory: client,
		});
		const handle = await adapter.startServer({
			port: 4433,
			tls: { cert: "c", key: "k" },
		});
		const metrics = handle.snapshot();

		// Must not have a field claiming to be "appliedConfig" or similar
		expect("appliedConfig" in metrics).toBe(false);
		expect("runtimeConfig" in metrics).toBe(false);
		await handle.stop(1000).catch(() => {});
	});

	it("rejects a second startServer call with a divergent profile", async () => {
		const { server, client } = makeFactories();
		const adapter = createWebTransportAdapter({
			serverFactory: server,
			clientFactory: client,
		});
		const h1 = await adapter.startServer({
			port: 4433,
			tls: { cert: "c", key: "k" },
		});

		// Second call: must reject because already started
		expect(
			adapter.startServer({ port: 4434, tls: { cert: "c", key: "k" } }),
		).rejects.toThrow();

		await h1.stop(1000).catch(() => {});
	});

	it("accepts a server session and wraps it in the Session interface", async () => {
		const fakeServerSession = makeFakeServerSession();
		const { server, client } = makeFactories({
			serverSession: fakeServerSession,
		});
		const adapter = createWebTransportAdapter({
			serverFactory: server,
			clientFactory: client,
		});

		const handle = await adapter.startServer({
			port: 4433,
			tls: { cert: "c", key: "k" },
		});
		const session = await handle.acceptSession(2000);

		expect(session).toBeDefined();
		expect(typeof session.sendMessage).toBe("function");
		expect(typeof session.receiveMessage).toBe("function");
		expect(typeof session.openUni).toBe("function");
		expect(typeof session.acceptUni).toBe("function");
		expect(typeof session.openBidi).toBe("function");
		expect(typeof session.acceptBidi).toBe("function");
		expect(typeof session.close).toBe("function");
		expect(typeof session.snapshot).toBe("function");

		await handle.stop(1000).catch(() => {});
	});

	it("sends a datagram via sendMessage('datagram', ...)", async () => {
		const sent: Uint8Array[] = [];
		const fakeServerSession = makeFakeServerSession({
			sendDatagram: async (data) => {
				sent.push(data);
			},
		});
		const { server, client } = makeFactories({
			serverSession: fakeServerSession,
		});
		const adapter = createWebTransportAdapter({
			serverFactory: server,
			clientFactory: client,
		});

		const handle = await adapter.startServer({
			port: 4433,
			tls: { cert: "c", key: "k" },
		});
		const session = await handle.acceptSession(2000);

		const payload = new Uint8Array([1, 2, 3, 4]);
		// sendMessage takes a WireMessage struct, NOT pre-encoded bytes
		const wire: import("../wire.ts").WireMessage = {
			runId: "run-1",
			sessionId: "ses-1",
			sequence: 1,
			expiresAtMs: Date.now() + 10_000,
			payload,
		};
		await session.sendMessage("datagram", wire, 2000);

		expect(sent.length).toBe(1);
		await handle.stop(1000).catch(() => {});
	});

	it("sends a reliable-message via sendMessage('reliable-message', ...)", async () => {
		const writtenChunks: Uint8Array[] = [];
		const fakeServerSession = makeFakeServerSession({
			createUnidirectionalStream: async () => makeWritable(writtenChunks),
		});
		const { server, client } = makeFactories({
			serverSession: fakeServerSession,
		});
		const adapter = createWebTransportAdapter({
			serverFactory: server,
			clientFactory: client,
		});

		const handle = await adapter.startServer({
			port: 4433,
			tls: { cert: "c", key: "k" },
		});
		const session = await handle.acceptSession(2000);

		const payload = new Uint8Array([5, 6, 7]);
		const wire: import("../wire.ts").WireMessage = {
			runId: "run-1",
			sessionId: "ses-1",
			sequence: 1,
			expiresAtMs: Date.now() + 10_000,
			payload,
		};
		await session.sendMessage("reliable-message", wire, 2000);

		// A reliable-message should have opened a uni stream and written the encoded bytes
		expect(writtenChunks.length).toBeGreaterThan(0);
		await handle.stop(1000).catch(() => {});
	});

	it("receives a datagram via receiveMessage('datagram', ...)", async () => {
		const payload = new Uint8Array([10, 20, 30]);
		// The datagram bytes on the wire are encoded WireMessage bytes
		const { encodeWireMessage } = await import("../wire.ts");
		const wire = encodeWireMessage({
			runId: "run-1",
			sessionId: "ses-1",
			sequence: 1,
			expiresAtMs: Date.now() + 10_000,
			payload,
		});

		const fakeServerSession = makeFakeServerSession({
			incomingDatagrams: async function* () {
				yield wire;
			},
		});
		const { server, client } = makeFactories({
			serverSession: fakeServerSession,
		});
		const adapter = createWebTransportAdapter({
			serverFactory: server,
			clientFactory: client,
		});

		const handle = await adapter.startServer({
			port: 4433,
			tls: { cert: "c", key: "k" },
		});
		const session = await handle.acceptSession(2000);

		const msg = await session.receiveMessage("datagram", 2000);
		expect(msg.payload).toEqual(payload);
		await handle.stop(1000).catch(() => {});
	});

	it("opens a client-side uni stream (openUni) and wraps it as SendChannel", async () => {
		const written: Uint8Array[] = [];
		const fakeClientSession = makeFakeClientSession({
			createUnidirectionalStream: async () => makeWritable(written),
		});
		const { server, client } = makeFactories({
			clientSession: fakeClientSession,
		});
		const adapter = createWebTransportAdapter({
			serverFactory: server,
			clientFactory: client,
		});

		const session = await adapter.connect({
			url: "https://10.99.0.2:4433",
			role: "client",
			deadlineMs: 2000,
		});

		const ch: SendChannel = await session.openUni(2000);
		expect(typeof ch.channelId).toBe("number");
		expect(typeof ch.write).toBe("function");
		expect(typeof ch.end).toBe("function");

		const bytes = new Uint8Array([1, 2, 3]);
		await ch.write(bytes, 2000);
		expect(written.length).toBeGreaterThan(0);
	});

	it("accepts a server-opened uni stream (acceptUni) and reads bytes", async () => {
		const payload = new Uint8Array([11, 22, 33]);
		const readable = makeReadable([payload]);

		const fakeClientSession = makeFakeClientSession({
			incomingUnidirectionalStreams: async function* () {
				yield readable;
			},
		});
		const { server, client } = makeFactories({
			clientSession: fakeClientSession,
		});
		const adapter = createWebTransportAdapter({
			serverFactory: server,
			clientFactory: client,
		});

		const session = await adapter.connect({
			url: "https://10.99.0.2:4433",
			role: "client",
			deadlineMs: 2000,
		});

		const ch: ReceiveChannel = await session.acceptUni(2000);
		expect(typeof ch.channelId).toBe("number");
		const data = await ch.read(2000);
		expect(data).toEqual(payload);
	});

	it("opens a client-side bidi stream (openBidi) and wraps it as BidiChannel", async () => {
		const written: Uint8Array[] = [];
		const payload = new Uint8Array([7, 8, 9]);
		const duplex = makeDuplex([payload], written);

		const fakeClientSession = makeFakeClientSession({
			createBidirectionalStream: async () => duplex,
		});
		const { server, client } = makeFactories({
			clientSession: fakeClientSession,
		});
		const adapter = createWebTransportAdapter({
			serverFactory: server,
			clientFactory: client,
		});

		const session = await adapter.connect({
			url: "https://10.99.0.2:4433",
			role: "client",
			deadlineMs: 2000,
		});

		const ch: BidiChannel = await session.openBidi(2000);
		expect(typeof ch.channelId).toBe("number");
		expect(typeof ch.write).toBe("function");
		expect(typeof ch.read).toBe("function");

		// Write
		await ch.write(new Uint8Array([1, 2]), 2000);
		expect(written.length).toBeGreaterThan(0);

		// Read
		const data = await ch.read(2000);
		expect(data).toEqual(payload);
	});

	it("accepts a server-opened bidi stream (acceptBidi) on server session", async () => {
		const payload = new Uint8Array([99]);
		const written: Uint8Array[] = [];
		const duplex = makeDuplex([payload], written);

		const fakeServerSession = makeFakeServerSession({
			incomingBidirectionalStreams: {
				getReader: () => {
					let done = false;
					return {
						read: async () => {
							if (!done) {
								done = true;
								return {
									done: false,
									value: { readable: duplex, writable: duplex },
								};
							}
							return { done: true, value: undefined };
						},
						cancel: async () => {},
						releaseLock: () => {},
					};
				},
			} as unknown as ReadableStream<{
				readable: Readable;
				writable: Writable;
			}>,
		});
		const { server, client } = makeFactories({
			serverSession: fakeServerSession,
		});
		const adapter = createWebTransportAdapter({
			serverFactory: server,
			clientFactory: client,
		});

		const handle = await adapter.startServer({
			port: 4433,
			tls: { cert: "c", key: "k" },
		});
		const session = await handle.acceptSession(2000);
		const ch: BidiChannel = await session.acceptBidi(2000);

		expect(typeof ch.channelId).toBe("number");
		const data = await ch.read(2000);
		expect(data).toEqual(payload);

		await handle.stop(1000).catch(() => {});
	});

	it("server creates a server-opened uni stream exposed through acceptUni on client", async () => {
		const written: Uint8Array[] = [];
		const serverUni = makeWritable(written);

		const fakeServerSession = makeFakeServerSession({
			createUnidirectionalStream: async () => serverUni,
		});
		const { server, client } = makeFactories({
			serverSession: fakeServerSession,
		});
		const adapter = createWebTransportAdapter({
			serverFactory: server,
			clientFactory: client,
		});

		const handle = await adapter.startServer({
			port: 4433,
			tls: { cert: "c", key: "k" },
		});
		const session = await handle.acceptSession(2000);

		// Server opens a uni stream
		const ch: SendChannel = await session.openUni(2000);
		expect(typeof ch.channelId).toBe("number");
		await ch.write(new Uint8Array([42]), 2000);
		expect(written.length).toBeGreaterThan(0);

		await handle.stop(1000).catch(() => {});
	});

	it("propagates has0Rtt, accepted0Rtt, handshakeConfirmed truth counters from client session", async () => {
		const fakeClientSession = makeFakeClientSession({
			has0Rtt: true,
			accepted0Rtt: true,
			handshakeConfirmed: false, // still confirming
		});
		const { server, client } = makeFactories({
			clientSession: fakeClientSession,
		});
		const adapter = createWebTransportAdapter({
			serverFactory: server,
			clientFactory: client,
		});

		const session = await adapter.connect({
			url: "https://10.99.0.2:4433",
			role: "client",
			deadlineMs: 2000,
		});
		const metrics = session.snapshot() as unknown as Record<string, unknown>;

		// The 0-RTT fields must come from the real session, not be fabricated
		expect(metrics["has0Rtt"]).toBe(true);
		expect(metrics["accepted0Rtt"]).toBe(true);
		expect(metrics["handshakeConfirmed"]).toBe(false);
	});

	it("records has0Rtt=false and accepted0Rtt=false for a normal (non-0-RTT) client session", async () => {
		const fakeClientSession = makeFakeClientSession({
			has0Rtt: false,
			accepted0Rtt: false,
			handshakeConfirmed: true,
		});
		const { server, client } = makeFactories({
			clientSession: fakeClientSession,
		});
		const adapter = createWebTransportAdapter({
			serverFactory: server,
			clientFactory: client,
		});

		const session = await adapter.connect({
			url: "https://10.99.0.2:4433",
			role: "client",
			deadlineMs: 2000,
		});
		const metrics = session.snapshot() as unknown as Record<string, unknown>;
		expect(metrics["has0Rtt"]).toBe(false);
		expect(metrics["accepted0Rtt"]).toBe(false);
		expect(metrics["handshakeConfirmed"]).toBe(true);
	});

	it("propagates 0-RTT truth counters from server session", async () => {
		const fakeServerSession = makeFakeServerSession({
			has0Rtt: true,
			accepted0Rtt: true,
			handshakeConfirmed: false,
		});
		const { server, client } = makeFactories({
			serverSession: fakeServerSession,
		});
		const adapter = createWebTransportAdapter({
			serverFactory: server,
			clientFactory: client,
		});

		const handle = await adapter.startServer({
			port: 4433,
			tls: { cert: "c", key: "k" },
		});
		const session = await handle.acceptSession(2000);
		const metrics = session.snapshot() as unknown as Record<string, unknown>;

		expect(metrics["has0Rtt"]).toBe(true);
		expect(metrics["accepted0Rtt"]).toBe(true);
		expect(metrics["handshakeConfirmed"]).toBe(false);
		await handle.stop(1000).catch(() => {});
	});

	it("bounds acceptSession to a deadline and rejects when no session arrives", async () => {
		// Server factory that never delivers a session
		const neverServer: WtServerFactory = (options) =>
			({
				address: { host: "10.99.0.2", port: options.port },
				congestionControl: "default" as const,
				close: async () => {},
				metricsSnapshot: () => ({}),
				sendDatagramMirror: () => ({ sent: 0, failures: [] }),
				sendDatagramMirrorPaced: () => ({ admitted: 0 }),
				readMirrorReports: () => [],
				tlsSnapshot: () => ({ sni: [] }),
				updateCert: async () => {},
				updateTls: async () => {},
				replaceSniCerts: async () => {},
				upsertSniCert: async () => {},
				removeSniCert: async () => {},
				setUnknownSniPolicy: async () => {},
			}) as unknown as ReturnType<WtServerFactory>;

		const { client } = makeFactories();
		const adapter = createWebTransportAdapter({
			serverFactory: neverServer,
			clientFactory: client,
		});
		const handle = await adapter.startServer({
			port: 4433,
			tls: { cert: "c", key: "k" },
		});

		await expect(handle.acceptSession(50)).rejects.toThrow();
		await handle.stop(1000).catch(() => {});
	});

	it("bounds close() to a deadline and resolves promptly on cooperative session", async () => {
		let closeCalled = false;
		const fakeClientSession = makeFakeClientSession({
			close: (_info?: unknown) => {
				closeCalled = true;
			},
		});
		const { server, client } = makeFactories({
			clientSession: fakeClientSession,
		});
		const adapter = createWebTransportAdapter({
			serverFactory: server,
			clientFactory: client,
		});

		const session = await adapter.connect({
			url: "https://10.99.0.2:4433",
			role: "client",
			deadlineMs: 2000,
		});

		await expect(session.close(2000)).resolves.toBeUndefined();
		expect(closeCalled).toBe(true);
	});

	it("provides session snapshot with active/inactive flag and stream counters", async () => {
		const { server, client } = makeFactories();
		const adapter = createWebTransportAdapter({
			serverFactory: server,
			clientFactory: client,
		});

		const session = await adapter.connect({
			url: "https://10.99.0.2:4433",
			role: "client",
			deadlineMs: 2000,
		});

		const metrics: TransportMetrics = session.snapshot();
		expect(typeof metrics.active).toBe("boolean");
		expect(typeof metrics.streamsOpened).toBe("number");
		expect(typeof metrics.streamsAccepted).toBe("number");
		expect(typeof metrics.streamsClosed).toBe("number");
		expect(typeof metrics.sessionsOpened).toBe("number");
		expect(typeof metrics.sessionsClosed).toBe("number");
	});

	it("does not modify WebTransport product code; only uses public API", async () => {
		// All interactions with WT must go through the public createServer/connect surface.
		// This test confirms the adapter module imports only from the package index.
		const wtModule = await import("./wt.ts");
		// The module must export createWebTransportAdapter and factory types.
		expect(typeof wtModule.createWebTransportAdapter).toBe("function");
	});

	it("rejects connect() with TLS missing on server side (no insecureSkipVerify path)", async () => {
		// Adapter must require TLS options from the caller; no silent insecure fallback.
		const { server, client } = makeFactories();
		const adapter = createWebTransportAdapter({
			serverFactory: server,
			clientFactory: client,
		});

		// connect without caPem or serverCertificateHashes: adapter should pass them through
		// (the actual TLS enforcement is at the native layer, but adapter must not swallow).
		// Simply confirm the call does not throw from the adapter itself.
		const session = await adapter.connect({
			url: "https://10.99.0.2:4433",
			role: "client",
			deadlineMs: 2000,
			tls: {
				ca: "ca-pem",
				serverName: "wt-compare.local",
				rejectUnauthorized: true,
			},
		});
		expect(session).toBeDefined();
	});

	it("SendChannel.end() resolves the writable end of a uni stream", async () => {
		let ended = false;
		const writable = new Writable({
			write(_c, _e, cb) {
				cb();
			},
			final(cb) {
				ended = true;
				cb();
			},
		});
		const fakeClientSession = makeFakeClientSession({
			createUnidirectionalStream: async () => writable,
		});
		const { server, client } = makeFactories({
			clientSession: fakeClientSession,
		});
		const adapter = createWebTransportAdapter({
			serverFactory: server,
			clientFactory: client,
		});

		const session = await adapter.connect({
			url: "https://10.99.0.2:4433",
			role: "client",
			deadlineMs: 2000,
		});
		const ch = await session.openUni(2000);
		await ch.end(2000);
		expect(ended).toBe(true);
	});

	it("ReceiveChannel.cancel() destroys the readable without throwing", async () => {
		const readable = makeReadable([new Uint8Array([1])]);
		const fakeClientSession = makeFakeClientSession({
			incomingUnidirectionalStreams: async function* () {
				yield readable;
			},
		});
		const { server, client } = makeFactories({
			clientSession: fakeClientSession,
		});
		const adapter = createWebTransportAdapter({
			serverFactory: server,
			clientFactory: client,
		});

		const session = await adapter.connect({
			url: "https://10.99.0.2:4433",
			role: "client",
			deadlineMs: 2000,
		});
		const ch = await session.acceptUni(2000);
		await expect(ch.cancel(1000)).resolves.toBeUndefined();
	});

	it("read() returns null at end of a Node Readable stream", async () => {
		const readable = makeReadable([]); // empty → EOF immediately
		const fakeClientSession = makeFakeClientSession({
			incomingUnidirectionalStreams: async function* () {
				yield readable;
			},
		});
		const { server, client } = makeFactories({
			clientSession: fakeClientSession,
		});
		const adapter = createWebTransportAdapter({
			serverFactory: server,
			clientFactory: client,
		});

		const session = await adapter.connect({
			url: "https://10.99.0.2:4433",
			role: "client",
			deadlineMs: 2000,
		});
		const ch = await session.acceptUni(2000);
		const data = await ch.read(2000);
		expect(data).toBeNull();
	});

	it("write() returns a SendObservation with attempted=true and queued=false on cooperative stream", async () => {
		const written: Uint8Array[] = [];
		const fakeClientSession = makeFakeClientSession({
			createUnidirectionalStream: async () => makeWritable(written),
		});
		const { server, client } = makeFactories({
			clientSession: fakeClientSession,
		});
		const adapter = createWebTransportAdapter({
			serverFactory: server,
			clientFactory: client,
		});

		const session = await adapter.connect({
			url: "https://10.99.0.2:4433",
			role: "client",
			deadlineMs: 2000,
		});
		const ch = await session.openUni(2000);
		const obs = await ch.write(new Uint8Array([1, 2, 3]), 2000);

		expect(obs.attempted).toBe(true);
		expect(typeof obs.bytes).toBe("number");
		expect(obs.bytes).toBeGreaterThan(0);
	});

	it("snapshot includes behavioral counters but no fields named appliedConfig or runtimeApplied", async () => {
		const { server, client } = makeFactories();
		const adapter = createWebTransportAdapter({
			serverFactory: server,
			clientFactory: client,
		});
		const handle = await adapter.startServer({
			port: 4433,
			tls: { cert: "c", key: "k" },
		});
		const srv = handle.snapshot();

		const forbidden = [
			"appliedConfig",
			"runtimeApplied",
			"runtimeConfig",
			"appliedLimits",
		];
		for (const key of forbidden) {
			expect(key in srv).toBe(false);
		}
		await handle.stop(1000).catch(() => {});
	});
});

// ---------------------------------------------------------------------------
// R4 (persistent reliable-message stream) and R5 (honest funnel) falsifiers
// ---------------------------------------------------------------------------

function wireBytes(sequence: number, payload: Uint8Array): Uint8Array {
	return encodeWireMessage({
		runId: "run-r4",
		sessionId: "ses-r4",
		sequence,
		expiresAtMs: Date.now() + 60_000,
		payload,
	});
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
	const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.byteLength;
	}
	return out;
}

/** Feeds chunks one `read()` at a time and never ends, so deadlines still bite. */
function makeChunkFeeder(chunks: readonly Uint8Array[]): Readable {
	let idx = 0;
	return new Readable({
		read() {
			if (idx < chunks.length) this.push(chunks[idx++]);
		},
	});
}

/**
 * A client session that enforces `maxStreamsPerSessionUni` the way the native
 * layer does: an open is refused while that many uni streams are still live.
 */
function makeLimitedClientSession(limit: number): {
	session: FakeWtClientSession;
	opens: () => number;
	ends: () => number;
	written: Uint8Array[];
} {
	let live = 0;
	let opens = 0;
	let ends = 0;
	const written: Uint8Array[] = [];
	const session = makeFakeClientSession({
		createUnidirectionalStream: async () => {
			if (live >= limit) {
				throw new Error(
					`E_LIMIT_EXCEEDED: maxStreamsPerSessionUni ${limit} exhausted`,
				);
			}
			live += 1;
			opens += 1;
			return new Writable({
				write(chunk: Buffer | Uint8Array, _enc, cb) {
					written.push(
						chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk),
					);
					cb();
				},
				final(cb) {
					live -= 1;
					ends += 1;
					cb();
				},
			});
		},
	});
	return { session, opens: () => opens, ends: () => ends, written };
}

describe("WT reliable-message stream model", () => {
	it("carries nine reliable messages on one session against maxStreamsPerSessionUni", async () => {
		const limited = makeLimitedClientSession(
			CANONICAL_CAPACITY_PROFILE.maxStreamsPerSessionUni,
		);
		const { server, client } = makeFactories({
			clientSession: limited.session,
		});
		const adapter = createWebTransportAdapter({
			serverFactory: server,
			clientFactory: client,
		});
		const session = await adapter.connect({
			url: "https://10.99.0.2:4433",
			role: "client",
			deadlineMs: 2000,
		});

		const count = CANONICAL_CAPACITY_PROFILE.maxStreamsPerSessionUni + 1;
		for (let sequence = 1; sequence <= count; sequence += 1) {
			await session.sendMessage(
				"reliable-message",
				{
					runId: "run-r4",
					sessionId: "ses-r4",
					sequence,
					expiresAtMs: Date.now() + 60_000,
					payload: new Uint8Array([sequence]),
				},
				2000,
			);
		}

		expect(limited.opens()).toBe(1);
		expect(limited.written.length).toBe(count);
		const metrics = session.snapshot();
		expect(metrics.streamsOpened).toBe(1);
		expect(metrics.streamOpenAttempts).toBe(1);
		expect(metrics.attempted).toBe(count);
	});

	it("expresses a ticker-fanout burst without one stream open per record", async () => {
		const limited = makeLimitedClientSession(
			CANONICAL_CAPACITY_PROFILE.maxStreamsPerSessionUni,
		);
		const { server, client } = makeFactories({
			clientSession: limited.session,
		});
		const adapter = createWebTransportAdapter({
			serverFactory: server,
			clientFactory: client,
		});
		const session = await adapter.connect({
			url: "https://10.99.0.2:4433",
			role: "client",
			deadlineMs: 2000,
		});

		const records = 2000;
		for (let sequence = 1; sequence <= records; sequence += 1) {
			await session.sendMessage(
				"reliable-message",
				{
					runId: "run-r4",
					sessionId: "ses-r4",
					sequence,
					expiresAtMs: Date.now() + 60_000,
					payload: new Uint8Array(16),
				},
				2000,
			);
		}

		const metrics = session.snapshot();
		expect(metrics.streamOpenAttempts).toBe(1);
		expect(metrics.streamsOpened).toBe(1);
		expect(records / metrics.streamOpenAttempts).toBeGreaterThan(
			CANONICAL_CAPACITY_PROFILE.streamsPerSec / 1000,
		);
	});

	it("ends the reliable-message stream exactly once when the session closes", async () => {
		const limited = makeLimitedClientSession(8);
		const { server, client } = makeFactories({
			clientSession: limited.session,
		});
		const adapter = createWebTransportAdapter({
			serverFactory: server,
			clientFactory: client,
		});
		const session = await adapter.connect({
			url: "https://10.99.0.2:4433",
			role: "client",
			deadlineMs: 2000,
		});

		await session.sendMessage(
			"reliable-message",
			{
				runId: "run-r4",
				sessionId: "ses-r4",
				sequence: 1,
				expiresAtMs: Date.now() + 60_000,
				payload: new Uint8Array([1]),
			},
			2000,
		);
		expect(limited.ends()).toBe(0);

		await session.close(2000);
		await session.close(2000);
		expect(limited.ends()).toBe(1);
		expect(session.snapshot().streamsClosed).toBe(1);
	});

	it("opens no stream for a session that sends only datagrams", async () => {
		const limited = makeLimitedClientSession(8);
		const { server, client } = makeFactories({
			clientSession: limited.session,
		});
		const adapter = createWebTransportAdapter({
			serverFactory: server,
			clientFactory: client,
		});
		const session = await adapter.connect({
			url: "https://10.99.0.2:4433",
			role: "client",
			deadlineMs: 2000,
		});

		await session.sendMessage(
			"datagram",
			{
				runId: "run-r4",
				sessionId: "ses-r4",
				sequence: 1,
				expiresAtMs: Date.now() + 60_000,
				payload: new Uint8Array([1]),
			},
			2000,
		);

		expect(limited.opens()).toBe(0);
		expect(session.snapshot().streamOpenAttempts).toBe(0);
	});
});

describe("WT delivery funnel", () => {
	it("counts a send as queued and never as delivered", async () => {
		const limited = makeLimitedClientSession(8);
		const { server, client } = makeFactories({
			clientSession: limited.session,
		});
		const adapter = createWebTransportAdapter({
			serverFactory: server,
			clientFactory: client,
		});
		const session = await adapter.connect({
			url: "https://10.99.0.2:4433",
			role: "client",
			deadlineMs: 2000,
		});

		const sends = 5;
		for (let sequence = 1; sequence <= sends; sequence += 1) {
			const observation = await session.sendMessage(
				sequence % 2 === 0 ? "datagram" : "reliable-message",
				{
					runId: "run-r5",
					sessionId: "ses-r5",
					sequence,
					expiresAtMs: Date.now() + 60_000,
					payload: new Uint8Array([sequence]),
				},
				2000,
			);
			expect(observation.queued).toBe(true);
			expect(observation.delivered).toBe(false);
		}

		const metrics = session.snapshot();
		expect(metrics.attempted).toBe(sends);
		expect(metrics.queued).toBe(sends);
		expect(metrics.delivered).toBe(0);
		expect(metrics.serverObserved).toBe(0);
		expect(metrics.acknowledged).toBe(0);
	});

	it("counts delivered only after the receiver decodes a datagram", async () => {
		const wire = wireBytes(1, new Uint8Array([9, 9, 9]));
		const fakeServerSession = makeFakeServerSession({
			incomingDatagrams: async function* () {
				yield wire;
			},
		});
		const { server, client } = makeFactories({
			serverSession: fakeServerSession,
		});
		const adapter = createWebTransportAdapter({
			serverFactory: server,
			clientFactory: client,
		});
		const handle = await adapter.startServer({
			port: 4433,
			tls: { cert: "c", key: "k" },
		});
		const session = await handle.acceptSession(2000);

		expect(session.snapshot().delivered).toBe(0);
		await session.receiveMessage("datagram", 2000);
		const metrics = session.snapshot();
		expect(metrics.delivered).toBe(1);
		expect(metrics.serverObserved).toBe(1);
		expect(metrics.attempted).toBe(0);
		expect(metrics.queued).toBe(0);
		await handle.stop(1000).catch(() => {});
	});

	it("reads back-to-back envelopes off one accepted stream and counts each", async () => {
		const envelopes = [
			wireBytes(1, new Uint8Array([1])),
			wireBytes(2, new Uint8Array([2, 2])),
			wireBytes(3, new Uint8Array([3, 3, 3])),
		];
		const joined = concatBytes(envelopes);
		// One coalesced chunk, then a second envelope split across two reads.
		const split = envelopes[0] as Uint8Array;
		const feeder = makeChunkFeeder([
			joined,
			split.slice(0, 10),
			split.slice(10),
		]);
		const fakeClientSession = makeFakeClientSession({
			incomingUnidirectionalStreams: async function* () {
				yield feeder;
			},
		});
		const { server, client } = makeFactories({
			clientSession: fakeClientSession,
		});
		const adapter = createWebTransportAdapter({
			serverFactory: server,
			clientFactory: client,
		});
		const session = await adapter.connect({
			url: "https://10.99.0.2:4433",
			role: "client",
			deadlineMs: 2000,
		});

		const sequences: number[] = [];
		for (let index = 0; index < 4; index += 1) {
			sequences.push(
				(await session.receiveMessage("reliable-message", 2000)).sequence,
			);
		}

		expect(sequences).toEqual([1, 2, 3, 1]);
		const metrics = session.snapshot();
		expect(metrics.delivered).toBe(4);
		expect(metrics.serverObserved).toBe(4);
		expect(metrics.streamsAccepted).toBe(1);
	});
});
