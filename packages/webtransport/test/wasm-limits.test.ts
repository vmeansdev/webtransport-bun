import { describe, expect, test } from "bun:test";
import {
	connectWasm,
	createWasmServer,
	DEFAULT_WASM_LIMITS,
	normalizeWasmEndpointOptions,
	serveOverUdp,
	type WasmLimitsOptions,
	WasmSession,
	WasmStream,
	WasmTransportManager,
	WasmWebTransport,
} from "../src/backend.js";
import {
	decodeWasmEvent,
	dispatchDecodedWasmEvent,
	WasmEndpoint,
	type WasmModule,
} from "../src/backend-wasm.js";
import {
	E_BACKPRESSURE_TIMEOUT,
	E_LIMIT_EXCEEDED,
	E_QUEUE_FULL,
	E_SESSION_CLOSED,
	E_STOP_SENDING,
	E_STREAM_RESET,
	WebTransportError,
} from "../src/errors.js";
import type { UdpAddr, UdpTransport } from "../src/wasm-relay.js";
import { InMemoryRelay } from "../src/wasm-relay.js";
import { readWithTimeout } from "./helpers/harness.js";
import { loadWasmModule, wasmAvailable } from "./helpers/wasm-availability.js";

const noopWasm = {} as WasmModule;
// Soft-skip when pkg is absent (local `bun test packages/`). With
// WEBTRANSPORT_REQUIRE_WASM=1 the helper throws at import time instead.
const wasm = wasmAvailable
	? await loadWasmModule()
	: (null as unknown as Awaited<ReturnType<typeof loadWasmModule>>);

type TestReservation = {
	readonly bytes: number;
	readonly released: boolean;
	release(): boolean;
};

function testReservation(bytes: number): TestReservation {
	let released = false;
	return {
		bytes,
		get released() {
			return released;
		},
		release() {
			if (released) return false;
			released = true;
			return true;
		},
	};
}

function requireValue<T>(value: T | undefined, label: string): T {
	if (value === undefined) throw new Error(`${label} was not delivered`);
	return value;
}

function trackedStreamCount(manager: WasmTransportManager): number {
	return (manager as unknown as { streams: Map<number, WasmStream> }).streams
		.size;
}

function incomingQueueLength(session: WasmSession): number {
	return (
		session as unknown as {
			incomingQueue: WasmStream[];
		}
	).incomingQueue.length;
}

function fakeManager(limits: WasmLimitsOptions = {}) {
	const errors: unknown[] = [];
	let writes = 0;
	const options = normalizeWasmEndpointOptions({ limits });
	const endpoint = {
		streamWrite() {
			writes += 1;
			return writes <= 100 ? 0 : -1;
		},
		waitForProgress() {
			return Bun.sleep(2);
		},
		streamPause() {},
		streamResume() {},
		streamFinish() {},
		streamReset() {},
		streamStop() {},
	};
	return {
		manager: {
			endpoint,
			options,
			_releaseStream() {},
			_reportResourceError(error: unknown) {
				errors.push(error);
			},
			emitLog() {},
			_recordDatagramOut() {},
			_recordDatagramIn() {},
			_recordDatagramDropped() {},
		} as unknown as WasmTransportManager,
		errors,
	};
}

function fakeModuleWithHostTokens(
	tokens: Set<number>,
	polledEvents: Uint8Array[] = [],
): WasmModule {
	const base = {
		wt_new_endpoint_with_options: () => JSON.stringify({ eid: 1 }),
		wt_connect: () => 1,
		wt_poll_transmits: () => new Uint8Array(),
		wt_poll_event: () => polledEvents.shift(),
		wt_next_timeout_ms: () => -1,
		wt_release_host_reservation: (_eid: number, token: number) =>
			tokens.delete(token),
		wt_governor_snapshot: () =>
			JSON.stringify({
				queuedBytesGlobal: tokens.size === 0 ? 0 : 4,
				hostTokensActive: tokens.size,
			}),
		wt_take_last_error: () => "",
		wt_max_datagram_size: () => 1200,
		wt_close_all() {},
		wt_close_endpoint() {},
	} satisfies Partial<WasmModule>;
	return new Proxy(base as unknown as WasmModule, {
		get(target, key) {
			return Reflect.get(target, key) ?? (() => 0);
		},
	});
}

function fakeOperationModule(options: {
	connect?: number;
	openStream?: number;
	sendDatagram?: boolean;
	streamWrite?: number;
	lastError?: string;
}): WasmModule {
	let lastError = options.lastError ?? "";
	const base = {
		wt_new_endpoint_with_options: () => JSON.stringify({ eid: 1 }),
		wt_connect: () => options.connect ?? 1,
		wt_open_stream: () => options.openStream ?? 7,
		wt_send_datagram: () => options.sendDatagram ?? true,
		wt_stream_write: () => options.streamWrite ?? 1,
		wt_max_datagram_size: () => 1200,
		wt_take_last_error: () => {
			const value = lastError;
			lastError = "";
			return value;
		},
		wt_poll_transmits: () => new Uint8Array(),
		wt_poll_event: () => undefined,
		wt_next_timeout_ms: () => -1,
		wt_governor_snapshot: () => "{}",
		wt_close_all() {},
		wt_close_endpoint() {},
	} satisfies Partial<WasmModule>;
	return new Proxy(base as unknown as WasmModule, {
		get(target, key) {
			return Reflect.get(target, key) ?? (() => 0);
		},
	});
}

function operationManager(module: WasmModule): WasmTransportManager {
	return WasmTransportManager.create(
		module,
		new InMemoryRelay().a,
		false,
		"127.0.0.1:5544",
		"127.0.0.1:4433",
		null,
		normalizeWasmEndpointOptions(),
	);
}

function controlledFacadeSession() {
	let resolveClosed!: (info: { code?: number; reason?: string }) => void;
	let rejectClosed!: (error: Error) => void;
	const closed = new Promise<{ code?: number; reason?: string }>(
		(resolve, reject) => {
			resolveClosed = resolve;
			rejectClosed = reject;
		},
	);
	// Mirrors the real session: `draining` is pending until the peer sends
	// WT_DRAIN_SESSION or this side starts closing.
	let resolveDraining!: () => void;
	const draining = new Promise<void>((resolve) => {
		resolveDraining = resolve;
	});
	const session = {
		ready: Promise.resolve(),
		closed,
		draining,
		maxDatagramSize: 1200,
		onDatagram() {},
		onIncomingStream() {},
		sendDatagram: async () => {},
		drain: () => true,
		close() {
			resolveDraining();
			resolveClosed({ code: 0, reason: "local close" });
		},
	} as unknown as WasmSession;
	return { session, resolveClosed, rejectClosed, resolveDraining };
}

async function settlesPromptly<T>(promise: Promise<T>): Promise<T> {
	return Promise.race([
		promise,
		Bun.sleep(100).then(() => {
			throw new Error("promise did not settle");
		}),
	]);
}

function seededBytes(seed: number, length: number): Uint8Array {
	let state = seed >>> 0;
	const out = new Uint8Array(length);
	for (let i = 0; i < out.length; i++) {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		out[i] = state & 0xff;
	}
	return out;
}

async function realManagedPair(limits: WasmLimitsOptions) {
	const relay = new InMemoryRelay();
	const options = normalizeWasmEndpointOptions({ limits });
	let resolveServerSession!: (session: WasmSession) => void;
	const serverSessionPromise = new Promise<WasmSession>((resolve) => {
		resolveServerSession = resolve;
	});
	const serverManager = WasmTransportManager.create(
		wasm,
		relay.a,
		true,
		"127.0.0.1:4433",
		"127.0.0.1:5544",
		resolveServerSession,
		options,
	);
	const clientManager = WasmTransportManager.create(
		wasm,
		relay.b,
		false,
		"127.0.0.1:5544",
		"127.0.0.1:4433",
		null,
		options,
	);
	const clientSession = clientManager.connectClient("localhost");
	const serverSession = await Promise.race([
		serverSessionPromise,
		Bun.sleep(3_000).then(() => {
			throw new Error("server session timeout");
		}),
	]);
	await Promise.race([
		clientSession.ready,
		Bun.sleep(3_000).then(() => {
			throw new Error("client session timeout");
		}),
	]);
	return { serverManager, serverSession, clientManager, clientSession };
}

async function waitForSnapshot(
	manager: WasmTransportManager,
	predicate: (
		snapshot: ReturnType<WasmTransportManager["resourceSnapshot"]>,
	) => boolean,
	label: string,
) {
	const deadline = Date.now() + 3_000;
	let snapshot = manager.resourceSnapshot();
	while (!predicate(snapshot) && Date.now() < deadline) {
		await Bun.sleep(5);
		snapshot = manager.resourceSnapshot();
	}
	if (!predicate(snapshot))
		throw new Error(`${label}: ${JSON.stringify(snapshot)}`);
	return snapshot;
}

function droppableTransportPair() {
	let drop = false;
	let onA: ((data: Uint8Array, source: UdpAddr) => void) | undefined;
	let onB: ((data: Uint8Array, source: UdpAddr) => void) | undefined;
	const aSource: UdpAddr = { address: "127.0.0.1", port: 4433 };
	const bSource: UdpAddr = { address: "127.0.0.1", port: 5544 };
	const a: UdpTransport = {
		send(data) {
			if (!drop && onB) {
				const copy = data.slice();
				queueMicrotask(() => onB?.(copy, aSource));
			}
		},
		onPacket(callback) {
			onA = callback;
		},
	};
	const b: UdpTransport = {
		send(data) {
			if (!drop && onA) {
				const copy = data.slice();
				queueMicrotask(() => onA?.(copy, bSource));
			}
		},
		onPacket(callback) {
			onB = callback;
		},
	};
	return { a, b, setDrop: (value: boolean) => (drop = value) };
}

describe("wasm resource governor (Task 6 RED)", () => {
	test("exports authoritative v1 defaults", () => {
		expect(DEFAULT_WASM_LIMITS.maxSessions).toBe(2000);
		expect(DEFAULT_WASM_LIMITS.maxHandshakesInFlight).toBe(200);
		expect(DEFAULT_WASM_LIMITS.maxStreamsPerSessionBidi).toBe(200);
		expect(DEFAULT_WASM_LIMITS.maxStreamsPerSessionUni).toBe(200);
		expect(DEFAULT_WASM_LIMITS.maxStreamsGlobal).toBe(50_000);
		expect(DEFAULT_WASM_LIMITS.maxDatagramSize).toBe(1200);
		expect(DEFAULT_WASM_LIMITS.maxQueuedBytesGlobal).toBe(512 * 1024 * 1024);
		expect(DEFAULT_WASM_LIMITS.maxQueuedBytesPerSession).toBe(2 * 1024 * 1024);
		expect(DEFAULT_WASM_LIMITS.maxQueuedBytesPerStream).toBe(256 * 1024);
		expect(DEFAULT_WASM_LIMITS.backpressureTimeoutMs).toBe(5_000);
		expect(DEFAULT_WASM_LIMITS.handshakeTimeoutMs).toBe(10_000);
		expect(DEFAULT_WASM_LIMITS.idleTimeoutMs).toBe(60_000);
	});

	test("WASM event decoder property harness ignores arbitrary and malformed payloads without throwing", () => {
		const callbacks = {
			onConnected() {},
			onEstablished() {},
			onDatagram() {},
			onClosed() {},
			onSessionClosed() {},
			onStreamOpened() {},
			onStreamData() {},
			onStreamReset() {},
			onStreamStopped() {},
		};

		for (let seed = 1; seed <= 512; seed++) {
			const bytes = seededBytes(seed, seed % 31);
			expect(() => {
				const decoded = decodeWasmEvent(bytes);
				if (decoded) {
					dispatchDecodedWasmEvent(decoded, callbacks, () => false);
				}
			}).not.toThrow();
		}

		for (const bytes of [
			Uint8Array.of(),
			Uint8Array.of(3),
			Uint8Array.of(3, 0x40),
			Uint8Array.of(6, 1, 2, 1, 0x40),
			Uint8Array.of(255, 255, 255, 255, 255),
		]) {
			expect(() => {
				const decoded = decodeWasmEvent(bytes);
				if (decoded) {
					dispatchDecodedWasmEvent(decoded, callbacks, () => false);
				}
			}).not.toThrow();
		}
	});

	test("WASM event decoder property harness preserves host-token release on dropped malformed events", () => {
		let released = 0;
		const decoded = decodeWasmEvent(
			Uint8Array.of(3, 0x01, 0x00, 0x01, 0xaa, 0x01),
		);
		expect(decoded?.type).toBe("datagram");
		dispatchDecodedWasmEvent(decoded ?? null, {}, () => {
			released += 1;
			return true;
		});
		expect(released).toBe(1);

		released = 0;
		expect(() =>
			dispatchDecodedWasmEvent(null, {}, () => {
				released += 1;
				return true;
			}),
		).not.toThrow();
		expect(released).toBe(0);
	});

	test("rejects invalid endpoint options before bind or allocation", async () => {
		let bindCalls = 0;
		const invalid = {
			limits: {
				maxQueuedBytesGlobal: 32,
				maxQueuedBytesPerSession: 64,
			},
		} satisfies { limits: WasmLimitsOptions };

		expect(() => normalizeWasmEndpointOptions(invalid)).toThrow(
			/maxQueuedBytesPerSession/,
		);

		expect(() =>
			createWasmServer(
				noopWasm,
				new InMemoryRelay().a,
				() => {},
				"0.0.0.0:443",
				"127.0.0.1:0",
				invalid,
			),
		).toThrow(/maxQueuedBytesPerSession/);

		await expect(
			serveOverUdp(
				noopWasm,
				async () => {
					bindCalls += 1;
					throw new Error("bind should not run");
				},
				{
					localPort: 4433,
					onSession() {},
					...invalid,
				},
			),
		).rejects.toThrow(/maxQueuedBytesPerSession/);
		expect(bindCalls).toBe(0);
	});

	test("normalization accepts u32 max and rejects u32 max+1 before UDP bind", async () => {
		const max = 0xffff_ffff;
		expect(
			normalizeWasmEndpointOptions({ limits: { maxDatagramSize: max } }).limits
				.maxDatagramSize,
		).toBe(max);
		expect(() =>
			normalizeWasmEndpointOptions({ limits: { maxDatagramSize: max + 1 } }),
		).toThrow(/supported WASM integer range/);

		let bindCalls = 0;
		await expect(
			serveOverUdp(
				noopWasm,
				async () => {
					bindCalls += 1;
					throw new Error("bind must not run");
				},
				{
					localPort: 4433,
					onSession() {},
					limits: { maxDatagramSize: max + 1 },
				},
			),
		).rejects.toThrow(/supported WASM integer range/);
		expect(bindCalls).toBe(0);
	});

	test("normalization accepts optional wtMaxSessions and rejects out-of-range", () => {
		expect(
			normalizeWasmEndpointOptions({ wtMaxSessions: 4 }).wtMaxSessions,
		).toBe(4);
		expect(normalizeWasmEndpointOptions({}).wtMaxSessions).toBeUndefined();
		expect(() => normalizeWasmEndpointOptions({ wtMaxSessions: 0 })).toThrow(
			/wtMaxSessions must be a positive integer/,
		);
		expect(() => normalizeWasmEndpointOptions({ wtMaxSessions: 257 })).toThrow(
			/wtMaxSessions exceeds/,
		);
	});

	test("normalization rejects timer values outside the host timer range", () => {
		const maxTimerMs = 0x7fff_ffff;
		expect(
			normalizeWasmEndpointOptions({
				limits: {
					backpressureTimeoutMs: maxTimerMs,
					handshakeTimeoutMs: maxTimerMs,
					idleTimeoutMs: maxTimerMs,
				},
			}),
		).toMatchObject({
			limits: {
				backpressureTimeoutMs: maxTimerMs,
				handshakeTimeoutMs: maxTimerMs,
				idleTimeoutMs: maxTimerMs,
			},
		});
		expect(() =>
			normalizeWasmEndpointOptions({
				limits: {
					backpressureTimeoutMs: maxTimerMs + 1,
				},
			}),
		).toThrow(/host timer range/);
	});

	test("connect validates client options before endpoint construction", async () => {
		const relay = new InMemoryRelay();
		await expect(
			connectWasm(
				noopWasm,
				relay.a,
				"localhost",
				"127.0.0.1:0",
				"127.0.0.1:4433",
				{
					limits: { maxDatagramSize: 0 },
				},
			),
		).rejects.toThrow(/maxDatagramSize/);
	});

	test("WASM draining settles for local close, remote close, and connect failure", async () => {
		const local = controlledFacadeSession();
		const localFacade = new WasmWebTransport(local.session);
		localFacade.close();
		await expect(
			settlesPromptly(localFacade.draining),
		).resolves.toBeUndefined();

		const remote = controlledFacadeSession();
		const remoteFacade = new WasmWebTransport(remote.session);
		remote.resolveClosed({ code: 7, reason: "remote close" });
		await expect(
			settlesPromptly(remoteFacade.draining),
		).resolves.toBeUndefined();

		const failed = controlledFacadeSession();
		const failedFacade = new WasmWebTransport(failed.session);
		failedFacade.closed.catch(() => {});
		failed.rejectClosed(new Error("connect failed"));
		await expect(
			settlesPromptly(failedFacade.draining),
		).resolves.toBeUndefined();

		// The peer's WT_DRAIN_SESSION settles `draining` on its own, with the
		// session still open.
		const drained = controlledFacadeSession();
		const drainedFacade = new WasmWebTransport(drained.session);
		drained.resolveDraining();
		await expect(
			settlesPromptly(drainedFacade.draining),
		).resolves.toBeUndefined();
	});

	test("WASM datagram promises and writable reject false sends with stable codes", async () => {
		const queueManager = operationManager(
			fakeOperationModule({
				sendDatagram: false,
				lastError: "E_QUEUE_FULL: datagram send queue blocked",
			}),
		);
		const queueSession = queueManager.connectClient("localhost");
		await expect(
			queueSession.sendDatagram(new Uint8Array([1])),
		).rejects.toMatchObject({
			code: E_QUEUE_FULL,
		});
		queueManager.close();

		const writableQueueManager = operationManager(
			fakeOperationModule({
				sendDatagram: false,
				lastError: "E_QUEUE_FULL: datagram send queue blocked",
			}),
		);
		const writableFacade = new WasmWebTransport(
			writableQueueManager.connectClient("localhost"),
		);
		await expect(
			writableFacade.datagrams.writable.getWriter().write(new Uint8Array([1])),
		).rejects.toMatchObject({ code: E_QUEUE_FULL });
		writableQueueManager.close();

		const closedManager = operationManager(fakeOperationModule({}));
		const closedSession = closedManager.connectClient("localhost");
		const facade = new WasmWebTransport(closedSession);
		closedManager.close();
		await expect(facade.closed).rejects.toMatchObject({
			code: E_SESSION_CLOSED,
		});
		await expect(
			facade.datagrams.writable.getWriter().write(new Uint8Array([1])),
		).rejects.toMatchObject({ code: E_SESSION_CLOSED });
		await expect(facade.createBidirectionalStream()).rejects.toMatchObject({
			code: E_SESSION_CLOSED,
		});
		await expect(facade.createUnidirectionalStream()).rejects.toMatchObject({
			code: E_SESSION_CLOSED,
		});
	});

	test("WASM datagram writable rejects immediate writes after local close as session closed", async () => {
		const manager = operationManager(
			fakeOperationModule({
				sendDatagram: false,
				lastError: "E_QUEUE_FULL: datagram send queue blocked",
			}),
		);
		const facade = new WasmWebTransport(manager.connectClient("localhost"));

		facade.close();
		await expect(
			facade.datagrams.writable.getWriter().write(new Uint8Array([1])),
		).rejects.toMatchObject({ code: E_SESSION_CLOSED });
		await expect(facade.createBidirectionalStream()).rejects.toMatchObject({
			code: E_SESSION_CLOSED,
		});
		await expect(facade.createUnidirectionalStream()).rejects.toMatchObject({
			code: E_SESSION_CLOSED,
		});

		manager.close();
	});

	test("WASM manager preserves stable openStream and connectClient error codes", async () => {
		const exhaustedManager = operationManager(
			fakeOperationModule({
				openStream: -1,
				lastError: "E_LIMIT_EXCEEDED: stream capacity unavailable",
			}),
		);
		expect(() =>
			exhaustedManager.connectClient("localhost").createBidirectionalStream(),
		).toThrow(
			expect.objectContaining({
				name: WebTransportError.name,
				code: "E_LIMIT_EXCEEDED",
			}),
		);
		exhaustedManager.close();

		const closedManager = operationManager(
			fakeOperationModule({
				openStream: -1,
				lastError: "E_SESSION_CLOSED: session not established",
			}),
		);
		expect(() =>
			closedManager.connectClient("localhost").createUnidirectionalStream(),
		).toThrow(
			expect.objectContaining({
				name: WebTransportError.name,
				code: E_SESSION_CLOSED,
			}),
		);
		closedManager.close();

		const connectExhausted = fakeOperationModule({
			connect: -1,
			lastError: "E_LIMIT_EXCEEDED: maxSessions reached",
		});
		expect(() =>
			operationManager(connectExhausted).connectClient("localhost"),
		).toThrow(
			expect.objectContaining({
				name: WebTransportError.name,
				code: "E_LIMIT_EXCEEDED",
			}),
		);

		const connectClosed = fakeOperationModule({
			connect: -1,
			lastError: "E_SESSION_CLOSED: endpoint is closed",
		});
		expect(() =>
			operationManager(connectClosed).connectClient("localhost"),
		).toThrow(
			expect.objectContaining({
				name: WebTransportError.name,
				code: E_SESSION_CLOSED,
			}),
		);

		const sentinelClosedManager = operationManager(
			fakeOperationModule({ connect: 0 }),
		);
		expect(() => sentinelClosedManager.connectClient("localhost")).toThrow(
			expect.objectContaining({
				name: WebTransportError.name,
				code: E_SESSION_CLOSED,
			}),
		);
		expect(
			(
				sentinelClosedManager as unknown as {
					sessions: Map<number, WasmSession>;
				}
			).sessions.size,
		).toBe(0);
		sentinelClosedManager.close();
	});

	test("pre-establishment failure rejects ready and closed with the same typed error", async () => {
		const { manager } = fakeManager();
		const session = new WasmSession(manager, 1, 1n, 1200);
		const transport = new WasmWebTransport(session);

		const readyFailure = transport.ready.catch((error) => error);
		const closedFailure = transport.closed.catch((error) => error);
		session._markClosed(
			{ code: 0, reason: "timed out" },
			"E_HANDSHAKE_TIMEOUT: WebTransport CONNECT timed out",
		);

		const [readyError, closedError] = await Promise.all([
			readyFailure,
			closedFailure,
		]);
		expect(readyError).toBeInstanceOf(WebTransportError);
		expect(closedError).toBeInstanceOf(WebTransportError);
		expect((readyError as WebTransportError).code).toBe("E_HANDSHAKE_TIMEOUT");
		expect((closedError as WebTransportError).code).toBe("E_HANDSHAKE_TIMEOUT");
		expect(closedError).toBe(readyError);
	});

	test("transport-level pre-establishment close still rejects ready and closed with one typed fallback error", async () => {
		const { manager } = fakeManager();
		const session = new WasmSession(manager, 1, 1n, 1200);
		const transport = new WasmWebTransport(session);

		const readyFailure = transport.ready.catch((error) => error);
		const closedFailure = transport.closed.catch((error) => error);
		session._markClosed({ code: 0, reason: undefined });

		const [readyError, closedError] = await Promise.all([
			readyFailure,
			closedFailure,
		]);
		expect(readyError).toBeInstanceOf(WebTransportError);
		expect(closedError).toBeInstanceOf(WebTransportError);
		expect((readyError as WebTransportError).code).toBe(E_SESSION_CLOSED);
		expect((closedError as WebTransportError).code).toBe(E_SESSION_CLOSED);
		expect((readyError as WebTransportError).message).toContain(
			"closed before session established",
		);
		expect(closedError).toBe(readyError);
	});

	test.skipIf(!wasmAvailable)(
		"effective maxDatagramSize clamps to transport capacity and oversize sends stay stable",
		async () => {
			const pair = await realManagedPair({ maxDatagramSize: 100_000 });
			try {
				const facade = new WasmWebTransport(pair.clientSession);
				expect(pair.clientSession.maxDatagramSize).toBeGreaterThan(0);
				expect(pair.clientSession.maxDatagramSize).toBeLessThan(64 * 1024);
				expect(facade.datagrams.maxDatagramSize).toBe(
					pair.clientSession.maxDatagramSize,
				);
				await expect(
					pair.clientSession.sendDatagram(new Uint8Array(64 * 1024)),
				).rejects.toMatchObject({ code: E_LIMIT_EXCEEDED });
			} finally {
				pair.clientManager.close();
				pair.serverManager.close();
			}
		},
	);

	test("WASM stream writes expose stable stop, reset, close, and timeout errors", async () => {
		const stoppedManager = operationManager(fakeOperationModule({}));
		const stopped = stoppedManager
			.connectClient("localhost")
			.createUnidirectionalStream();
		stopped._pushStopped(41);
		await expect(stopped.writeAll(new Uint8Array([1]))).rejects.toMatchObject({
			code: E_STOP_SENDING,
			streamErrorCode: 41,
		});
		stoppedManager.close();

		const resetManager = operationManager(
			fakeOperationModule({
				streamWrite: -1,
				lastError: "E_STREAM_RESET: stream write failed",
			}),
		);
		const reset = resetManager
			.connectClient("localhost")
			.createUnidirectionalStream();
		await expect(reset.writeAll(new Uint8Array([1]))).rejects.toMatchObject({
			code: E_STREAM_RESET,
		});
		resetManager.close();

		const closedManager = operationManager(fakeOperationModule({}));
		const closed = closedManager
			.connectClient("localhost")
			.createUnidirectionalStream();
		closedManager.close();
		await expect(closed.writeAll(new Uint8Array([1]))).rejects.toMatchObject({
			code: E_SESSION_CLOSED,
		});

		const { manager: stalledManager } = fakeManager({
			backpressureTimeoutMs: 5,
		});
		const stalled = new WasmStream(stalledManager, 1, 31, false, false);
		await expect(stalled.writeAll(new Uint8Array([1]))).rejects.toMatchObject({
			code: E_BACKPRESSURE_TIMEOUT,
		});
	});

	test("WASM readable reset rejects with a stable stream error and peer code", async () => {
		const { manager } = fakeManager();
		const session = new WasmSession(manager, 1, 1n, 1200);
		const facade = new WasmWebTransport(session);
		const incoming = new WasmStream(manager, 1, 24, false, true);
		const outerReader = facade.incomingUnidirectionalStreams.getReader();
		const outerRead = readWithTimeout(
			outerReader,
			100,
			"wasm limits outer unidirectional read",
		);
		session._pushIncomingStream(incoming);
		const readable = requireValue((await outerRead).value, "incoming stream");
		outerReader.releaseLock();
		const readableReader = readable.getReader();
		const pendingRead = readWithTimeout(
			readableReader,
			100,
			"wasm limits pending readable reset",
		);

		incoming._pushReset(91);
		await expect(pendingRead).rejects.toEqual(
			expect.objectContaining({
				name: WebTransportError.name,
				code: E_STREAM_RESET,
				streamErrorCode: 91,
			}),
		);
	});

	test("pre-subscribe datagram bytes retain one reservation through exact limit and release on delivery", () => {
		const { manager, errors } = fakeManager({
			maxQueuedBytesGlobal: 4,
			maxQueuedBytesPerSession: 4,
			maxQueuedBytesPerStream: 4,
		});
		const session = new WasmSession(manager, 1, 1n, 4);
		const exact = testReservation(4);
		const excess = testReservation(1);

		session._pushDatagram(new Uint8Array(4), exact);
		expect(exact.released).toBe(false);
		session._pushDatagram(new Uint8Array(1), excess);
		expect(excess.released).toBe(true);
		expect(String(errors[0])).toContain("E_QUEUE_FULL");

		let delivered = 0;
		session.onDatagram((data) => {
			delivered += data.length;
		});
		expect(delivered).toBe(4);
		expect(exact.released).toBe(true);
	});

	test("pre-subscribe bidi and uni stream queues use configured exact limits", () => {
		const { manager } = fakeManager({
			maxStreamsPerSessionBidi: 1,
			maxStreamsPerSessionUni: 1,
			maxStreamsGlobal: 2,
		});
		const session = new WasmSession(manager, 1, 1n, 1200);
		const calls: string[] = [];
		const stream = (bidi: boolean, id: number) =>
			({
				bidi,
				handle: id,
				stop: () => calls.push(`stop:${id}`),
				reset: () => calls.push(`reset:${id}`),
			}) as unknown as WasmStream;

		session._pushIncomingStream(stream(true, 1));
		session._pushIncomingStream(stream(false, 2));
		session._pushIncomingStream(stream(true, 3));
		session._pushIncomingStream(stream(false, 4));
		expect(calls).toEqual(["stop:3", "reset:3", "stop:4"]);

		const accepted: number[] = [];
		session.onIncomingStream((value) => accepted.push(value.handle));
		expect(accepted).toEqual([1, 2]);
	});

	test("per-stream buffered bytes keep reservations and reject limit+1", () => {
		const { manager, errors } = fakeManager({
			maxQueuedBytesGlobal: 4,
			maxQueuedBytesPerSession: 4,
			maxQueuedBytesPerStream: 4,
		});
		const stream = new WasmStream(manager, 1, 9, false, true);
		const exact = testReservation(4);
		const excess = testReservation(1);

		stream._pushData(new Uint8Array(4), false, exact);
		expect(exact.released).toBe(false);
		stream._pushData(new Uint8Array(1), false, excess);
		expect(excess.released).toBe(true);
		expect(String(errors[0])).toContain("E_QUEUE_FULL");

		let delivered = 0;
		stream.onData((data) => {
			delivered += data.length;
		});
		expect(delivered).toBe(4);
		expect(exact.released).toBe(true);
	});

	test("per-stream overflow surfaces a reset to a late consumer instead of hanging it", () => {
		const { manager, errors } = fakeManager({
			maxQueuedBytesGlobal: 4,
			maxQueuedBytesPerSession: 4,
			maxQueuedBytesPerStream: 4,
		});
		const stream = new WasmStream(manager, 1, 9, false, true);
		stream._pushData(new Uint8Array(4), false, testReservation(4));
		stream._pushData(new Uint8Array(1), false, testReservation(1));
		expect(String(errors[0])).toContain("E_QUEUE_FULL");

		// Buffered bytes are still delivered first, then the parked reset fires
		// for the late subscriber (previously it hung until peer reset/idle).
		const order: string[] = [];
		stream.onData((data) => order.push(`data:${data.length}`));
		stream.onReset((code) => order.push(`reset:${code}`));
		expect(order).toEqual(["data:4", "reset:0"]);
	});

	test("a peer reset before onReset subscription is parked, not dropped", () => {
		const { manager } = fakeManager({});
		const stream = new WasmStream(manager, 1, 9, false, true);
		stream._pushReset(7);

		const resets: number[] = [];
		stream.onReset((code) => resets.push(code));
		expect(resets).toEqual([7]);
	});

	test("a connection close before onReset subscription is parked, not dropped", () => {
		const { manager } = fakeManager({});
		const stream = new WasmStream(manager, 1, 9, false, true);
		stream._closeFromConnection(3);

		const resets: number[] = [];
		stream.onReset((code) => resets.push(code));
		expect(resets).toEqual([3]);
	});

	test("per-stream overflow resets an already-subscribed reset consumer synchronously", () => {
		const { manager } = fakeManager({
			maxQueuedBytesGlobal: 4,
			maxQueuedBytesPerSession: 4,
			maxQueuedBytesPerStream: 4,
		});
		const stream = new WasmStream(manager, 1, 9, false, true);
		const resets: number[] = [];
		stream.onReset((code) => resets.push(code));
		stream._pushData(new Uint8Array(4), false, testReservation(4));
		stream._pushData(new Uint8Array(1), false, testReservation(1));
		expect(resets).toEqual([0]);
	});

	test("WHATWG datagram and stream pulls hold then release the original reservation", async () => {
		const { manager } = fakeManager({
			maxQueuedBytesGlobal: 8,
			maxQueuedBytesPerSession: 8,
			maxQueuedBytesPerStream: 4,
		});
		const session = new WasmSession(manager, 1, 1n, 4);
		const facade = new WasmWebTransport(session);

		const datagramReservation = testReservation(4);
		session._pushDatagram(new Uint8Array([1, 2, 3, 4]), datagramReservation);
		expect(datagramReservation.released).toBe(false);
		const datagramReader = facade.datagrams.readable.getReader();
		const datagram = await readWithTimeout(
			datagramReader,
			100,
			"wasm limits datagram readable pull",
		);
		datagramReader.releaseLock();
		expect(datagram.value).toEqual(new Uint8Array([1, 2, 3, 4]));
		expect(datagramReservation.released).toBe(true);

		const incoming = new WasmStream(manager, 1, 22, false, true);
		const incomingReader = facade.incomingUnidirectionalStreams.getReader();
		const incomingRead = readWithTimeout(
			incomingReader,
			100,
			"wasm limits incoming stream outer pull",
		);
		session._pushIncomingStream(incoming);
		const inner = requireValue((await incomingRead).value, "incoming stream");
		incomingReader.releaseLock();
		const streamReservation = testReservation(4);
		incoming._pushData(new Uint8Array([5, 6, 7, 8]), false, streamReservation);
		expect(streamReservation.released).toBe(false);
		const innerReader = inner.getReader();
		const chunk = await readWithTimeout(
			innerReader,
			100,
			"wasm limits incoming stream payload pull",
		);
		innerReader.releaseLock();
		expect(chunk.value).toEqual(new Uint8Array([5, 6, 7, 8]));
		expect(streamReservation.released).toBe(true);
	});

	test("WHATWG stream resolves a pending read when a zero-byte FIN arrives", async () => {
		const { manager } = fakeManager();
		const session = new WasmSession(manager, 1, 1n, 1200);
		const facade = new WasmWebTransport(session);
		const incoming = new WasmStream(manager, 1, 23, false, true);
		const incomingReader = facade.incomingUnidirectionalStreams.getReader();
		const incomingRead = readWithTimeout(
			incomingReader,
			100,
			"wasm limits zero-byte fin outer pull",
		);
		session._pushIncomingStream(incoming);
		const readable = requireValue(
			(await incomingRead).value,
			"incoming stream",
		);
		incomingReader.releaseLock();
		const readableReader = readable.getReader();
		const pendingRead = readWithTimeout(
			readableReader,
			100,
			"wasm limits zero-byte fin pending pull",
		);

		incoming._pushData(new Uint8Array(), true, testReservation(0));
		const result = await Promise.race([
			pendingRead,
			Bun.sleep(100).then(() => {
				throw new Error("zero-byte FIN did not settle pending read");
			}),
		]);
		expect(result).toEqual({ value: undefined, done: true });
	});

	test("zero-byte datagrams and stream chunks consume one logical queue unit", () => {
		const { manager, errors } = fakeManager({
			maxQueuedBytesGlobal: 1,
			maxQueuedBytesPerSession: 1,
			maxQueuedBytesPerStream: 1,
		});
		const session = new WasmSession(manager, 1, 1n, 1200);
		const firstDatagram = testReservation(0);
		const secondDatagram = testReservation(0);

		session._pushDatagram(new Uint8Array(), firstDatagram);
		expect(firstDatagram.released).toBe(false);
		session._pushDatagram(new Uint8Array(), secondDatagram);
		expect(secondDatagram.released).toBe(true);
		expect(String(errors[0])).toContain("E_QUEUE_FULL");

		const stream = new WasmStream(manager, 1, 33, true, true);
		const firstChunk = testReservation(0);
		const secondChunk = testReservation(0);
		stream._pushData(new Uint8Array(), false, firstChunk);
		expect(firstChunk.released).toBe(false);
		stream._pushData(new Uint8Array(), false, secondChunk);
		expect(secondChunk.released).toBe(true);
		expect(String(errors[1])).toContain("E_QUEUE_FULL");

		stream._dropRetained();
		expect(firstChunk.released).toBe(true);
	});

	test("zero-byte datagram pressure closes the public session instead of dropping silently", async () => {
		const tokens = new Set([1, 2]);
		const events: Uint8Array[] = [];
		const manager = WasmTransportManager.create(
			fakeModuleWithHostTokens(tokens, events),
			new InMemoryRelay().a,
			false,
			"127.0.0.1:5544",
			"127.0.0.1:4433",
			null,
			normalizeWasmEndpointOptions({
				limits: {
					maxQueuedBytesGlobal: 1,
					maxQueuedBytesPerSession: 1,
					maxQueuedBytesPerStream: 1,
				},
			}),
		);
		const session = manager.connectClient("localhost");
		// Remap pending → sessionId 0 so demuxed datagrams hit this session.
		events.push(Uint8Array.of(2, 1, 0));
		manager.endpoint.pump();
		let retained: TestReservation | undefined;
		session.onDatagram(
			(_data, reservation) => {
				retained = reservation as TestReservation | undefined;
			},
			{ retainReservation: true },
		);
		// tag DATAGRAM | conn=1 | sessionId=0 | len=0 | hostToken
		events.push(
			new Uint8Array([3, 1, 0, 0, 1]),
			new Uint8Array([3, 1, 0, 0, 2]),
		);

		manager.endpoint.pump();
		const closeInfo = await settlesPromptly(session.closed);
		expect(closeInfo.reason ?? "").toContain("E_QUEUE_FULL");
		expect(retained?.released).toBe(true);
		expect(tokens.size).toBe(0);
		expect(manager.resourceSnapshot()).toMatchObject({
			hostReservationsActive: 0,
			hostQueuedBytesGlobal: 0,
			rustHostTokensActive: 0,
		});
		manager.close();
	});

	test("configured backpressure timeout rejects a stalled write with a stable code", async () => {
		const { manager } = fakeManager({ backpressureTimeoutMs: 5 });
		const stream = new WasmStream(manager, 1, 31, false, false);
		await expect(stream.writeAll(new Uint8Array([1]))).rejects.toThrow(
			/E_BACKPRESSURE_TIMEOUT/,
		);
	});

	test("manager close releases every retained host lease and repeated churn returns to zero", () => {
		for (let iteration = 0; iteration < 20; iteration += 1) {
			const tokens = new Set([1, 2]);
			const module = fakeModuleWithHostTokens(tokens);
			const relay = new InMemoryRelay();
			const options = normalizeWasmEndpointOptions({
				limits: {
					maxQueuedBytesGlobal: 8,
					maxQueuedBytesPerSession: 8,
					maxQueuedBytesPerStream: 4,
				},
			});
			const manager = WasmTransportManager.create(
				module,
				relay.a,
				false,
				"127.0.0.1:5544",
				"127.0.0.1:4433",
				null,
				options,
			);
			const session = manager.connectClient("localhost");
			const first = manager._adoptHostReservation(1, undefined, 1, 4);
			const second = manager._adoptHostReservation(1, undefined, 2, 4);
			session._pushDatagram(new Uint8Array(4), first);
			session._pushDatagram(new Uint8Array(4), second);
			session._pushIncomingStream(
				new WasmStream(manager, 1, 100 + iteration, true, true),
			);
			expect(incomingQueueLength(session)).toBe(1);

			manager.close();
			expect(tokens.size).toBe(0);
			expect(incomingQueueLength(session)).toBe(0);
			expect(manager.resourceSnapshot()).toMatchObject({
				hostReservationsActive: 0,
				hostQueuedBytesGlobal: 0,
				rustQueuedBytesGlobal: 0,
			});
		}
	});

	test("failed host adoption drops datagram and stream payloads instead of delivering unaccounted bytes", () => {
		const options = normalizeWasmEndpointOptions({
			limits: {
				maxQueuedBytesGlobal: 4,
				maxQueuedBytesPerSession: 4,
				maxQueuedBytesPerStream: 4,
			},
		});

		const datagramTokens = new Set([1, 2]);
		const datagramEvents: Uint8Array[] = [];
		const datagramManager = WasmTransportManager.create(
			fakeModuleWithHostTokens(datagramTokens, datagramEvents),
			new InMemoryRelay().a,
			false,
			"127.0.0.1:5544",
			"127.0.0.1:4433",
			null,
			options,
		);
		const datagramSession = datagramManager.connectClient("localhost");
		const datagramFiller = requireValue(
			datagramManager._adoptHostReservation(1, undefined, 1, 4),
			"datagram filler reservation",
		);
		let datagramsDelivered = 0;
		datagramSession.onDatagram(() => {
			datagramsDelivered += 1;
		});
		// Establish then DATAGRAM: tag|conn|sid|len|payload|token
		datagramEvents.push(
			Uint8Array.of(2, 1, 0),
			new Uint8Array([3, 1, 0, 1, 7, 2]),
		);
		datagramManager.endpoint.pump();
		expect(datagramsDelivered).toBe(0);
		expect(datagramTokens.has(2)).toBe(false);
		datagramFiller.release();
		datagramManager.close();

		const streamTokens = new Set([1, 2]);
		const streamEvents: Uint8Array[] = [];
		const streamManager = WasmTransportManager.create(
			fakeModuleWithHostTokens(streamTokens, streamEvents),
			new InMemoryRelay().a,
			false,
			"127.0.0.1:5544",
			"127.0.0.1:4433",
			null,
			options,
		);
		const streamSession = streamManager.connectClient("localhost");
		const stream = streamSession.createBidirectionalStream();
		const streamFiller = requireValue(
			streamManager._adoptHostReservation(1, undefined, 1, 4),
			"stream filler reservation",
		);
		let streamBytesDelivered = 0;
		stream.onData((data) => {
			streamBytesDelivered += data.length;
		});
		streamEvents.push(
			Uint8Array.of(2, 1, 0),
			new Uint8Array([6, 1, 0, 0, 1, 9, 2]),
		);
		streamManager.endpoint.pump();
		expect(streamBytesDelivered).toBe(0);
		expect(streamTokens.has(2)).toBe(false);
		streamFiller.release();
		streamManager.close();
	});

	test("failed stream host adoption fails the stream closed and releases the token exactly once", () => {
		const tokens = new Set([1, 2]);
		const releases: number[] = [];
		const originalDelete = tokens.delete.bind(tokens);
		tokens.delete = (token: number) => {
			releases.push(token);
			return originalDelete(token);
		};
		const events: Uint8Array[] = [];
		const manager = WasmTransportManager.create(
			fakeModuleWithHostTokens(tokens, events),
			new InMemoryRelay().a,
			false,
			"127.0.0.1:5544",
			"127.0.0.1:4433",
			null,
			normalizeWasmEndpointOptions({
				limits: {
					maxQueuedBytesGlobal: 4,
					maxQueuedBytesPerSession: 4,
					maxQueuedBytesPerStream: 4,
				},
			}),
		);
		const session = manager.connectClient("localhost");
		const stream = session.createBidirectionalStream();
		const filler = requireValue(
			manager._adoptHostReservation(1, undefined, 1, 4),
			"filler reservation",
		);
		const resets: number[] = [];
		stream.onReset((code) => resets.push(code));
		// stream-data for handle 0 carrying token 2; adoption fails against the
		// exhausted budget. The recv half must fail CLOSED (stop + reset) rather
		// than silently dropping the bytes and leaving the stream readable.
		events.push(new Uint8Array([6, 1, 0, 0, 1, 9, 2]));
		manager.endpoint.pump();
		expect(resets).toEqual([0]);
		expect(releases.filter((token) => token === 2)).toEqual([2]);
		filler.release();
		manager.close();
	});

	test("throwing consumer on a fin payload still releases the stream handle", () => {
		const tokens = new Set([1]);
		const events: Uint8Array[] = [];
		const manager = WasmTransportManager.create(
			fakeModuleWithHostTokens(tokens, events),
			new InMemoryRelay().a,
			false,
			"127.0.0.1:5544",
			"127.0.0.1:4433",
			null,
			normalizeWasmEndpointOptions({
				limits: {
					maxQueuedBytesGlobal: 4,
					maxQueuedBytesPerSession: 4,
					maxQueuedBytesPerStream: 4,
				},
			}),
		);
		manager.onCallbackError = () => {};
		const session = manager.connectClient("localhost");
		let sawFin = false;
		session.onIncomingStream((stream) => {
			stream.onData((_data, fin) => {
				sawFin = fin;
				throw new Error("consumer failed");
			});
		});
		// Establish, then uni stream 9 + fin'd payload carrying token 1. The
		// throwing callback must not skip the fin bookkeeping that releases the
		// handle from the manager's stream map.
		// STREAM_OPENED: tag|conn|sessionId|stream|bidi
		events.push(
			Uint8Array.of(2, 1, 0),
			new Uint8Array([5, 1, 0, 9, 0]),
			new Uint8Array([6, 1, 9, 1, 1, 8, 1]),
		);
		manager.endpoint.pump();
		expect(sawFin).toBe(true);
		expect(tokens.size).toBe(0);
		expect(trackedStreamCount(manager)).toBe(0);
		manager.close();
	});

	test("a second close() keeps the first close's resource snapshot", () => {
		const tokens = new Set([7]);
		const manager = WasmTransportManager.create(
			fakeModuleWithHostTokens(tokens),
			new InMemoryRelay().a,
			false,
			"127.0.0.1:5544",
			"127.0.0.1:4433",
			null,
			normalizeWasmEndpointOptions(),
		);
		manager.connectClient("localhost");
		manager.close();
		const first = manager.resourceSnapshot();
		expect(first.rustHostTokensActive).toBe(1);
		manager.close();
		expect(manager.resourceSnapshot()).toEqual(first);
	});

	test("close() is infallible: a throwing teardown step is reported and later steps still run", () => {
		const tokens = new Set([7]);
		const manager = WasmTransportManager.create(
			fakeModuleWithHostTokens(tokens),
			new InMemoryRelay().a,
			false,
			"127.0.0.1:5544",
			"127.0.0.1:4433",
			null,
			normalizeWasmEndpointOptions(),
		);
		const reported: unknown[] = [];
		manager.onCallbackError = (error) => reported.push(error);
		manager.connectClient("localhost");
		let transportClosed = false;
		manager.ownTransport({
			send() {},
			onPacket() {},
			close() {
				transportClosed = true;
				throw new Error("transport close failed");
			},
		} as unknown as UdpTransport);

		// The owned transport's close throws — close() must neither propagate
		// nor skip: the error is reported and teardown completes.
		expect(() => manager.close()).not.toThrow();
		expect(transportClosed).toBe(true);
		expect(reported.length).toBe(1);
		expect(String(reported[0])).toContain("transport close failed");
		// And a second close stays a safe no-op.
		expect(() => manager.close()).not.toThrow();
	});

	test("throwing retained callbacks release mirrored host and Rust reservations", () => {
		const options = normalizeWasmEndpointOptions({
			limits: {
				maxQueuedBytesGlobal: 4,
				maxQueuedBytesPerSession: 4,
				maxQueuedBytesPerStream: 4,
			},
		});

		const datagramTokens = new Set([1]);
		const datagramEvents: Uint8Array[] = [];
		const datagramManager = WasmTransportManager.create(
			fakeModuleWithHostTokens(datagramTokens, datagramEvents),
			new InMemoryRelay().a,
			false,
			"127.0.0.1:5544",
			"127.0.0.1:4433",
			null,
			options,
		);
		datagramManager.onCallbackError = () => {};
		const datagramSession = datagramManager.connectClient("localhost");
		datagramSession.onDatagram(
			() => {
				throw new Error("consumer failed");
			},
			{ retainReservation: true },
		);
		datagramEvents.push(
			Uint8Array.of(2, 1, 0),
			new Uint8Array([3, 1, 0, 1, 7, 1]),
		);
		datagramManager.endpoint.pump();
		expect(datagramTokens.size).toBe(0);
		expect(datagramManager.resourceSnapshot()).toMatchObject({
			hostReservationsActive: 0,
			hostQueuedBytesGlobal: 0,
			rustHostTokensActive: 0,
		});
		datagramManager.close();

		const streamTokens = new Set([1]);
		const streamEvents: Uint8Array[] = [];
		const streamManager = WasmTransportManager.create(
			fakeModuleWithHostTokens(streamTokens, streamEvents),
			new InMemoryRelay().a,
			false,
			"127.0.0.1:5544",
			"127.0.0.1:4433",
			null,
			options,
		);
		streamManager.onCallbackError = () => {};
		const streamSession = streamManager.connectClient("localhost");
		streamSession.onIncomingStream((stream) => {
			stream.onData(
				() => {
					throw new Error("consumer failed");
				},
				{ retainReservation: true },
			);
		});
		streamEvents.push(
			Uint8Array.of(2, 1, 0),
			new Uint8Array([5, 1, 0, 9, 1]),
			new Uint8Array([6, 1, 9, 0, 1, 8, 1]),
		);
		streamManager.endpoint.pump();
		expect(streamTokens.size).toBe(0);
		expect(streamManager.resourceSnapshot()).toMatchObject({
			hostReservationsActive: 0,
			hostQueuedBytesGlobal: 0,
			rustHostTokensActive: 0,
		});
		streamManager.close();
	});

	test.skipIf(!wasmAvailable)(
		"real wasm host tokens keep bytes reserved until the host releases them",
		async () => {
			const relay = new InMemoryRelay();
			const normalized = normalizeWasmEndpointOptions({
				limits: {
					maxDatagramSize: 4,
					maxQueuedBytesGlobal: 4,
					maxQueuedBytesPerSession: 4,
					maxQueuedBytesPerStream: 4,
				},
			});
			const encoder = new TextEncoder();
			const decoder = new TextDecoder();
			let firstToken: number | undefined;
			const received: string[] = [];
			let sessionId = 0n;

			const server = WasmEndpoint.create(
				wasm,
				relay.a,
				true,
				"127.0.0.1:4433",
				"127.0.0.1:5544",
				normalized,
				{
					onEstablished: (_conn, sid) => {
						sessionId = sid;
					},
					onDatagram: (conn, sid, data, token) => {
						server.sendDatagram(conn, sid, data);
						if (token) {
							expect(server.releaseHostReservation(token)).toBe(true);
						}
					},
				},
			);

			let established = false;
			const client = WasmEndpoint.create(
				wasm,
				relay.b,
				false,
				"127.0.0.1:5544",
				"127.0.0.1:4433",
				normalized,
				{
					onEstablished: (_conn, sid) => {
						established = true;
						sessionId = sid;
					},
					onDatagram: (_conn, _sid, data, token) => {
						received.push(decoder.decode(data));
						if (firstToken === undefined && token) {
							firstToken = token;
							return;
						}
						if (token) {
							expect(client.releaseHostReservation(token)).toBe(true);
						}
					},
				},
			);

			const conn = client.connect("localhost");
			const readyDeadline = Date.now() + 3_000;
			while (!established && Date.now() < readyDeadline) {
				await Bun.sleep(5);
			}
			expect(established).toBe(true);

			client.sendDatagram(conn, sessionId, encoder.encode("ping"));
			const firstDeadline = Date.now() + 3_000;
			while (received.length < 1 && Date.now() < firstDeadline) {
				await Bun.sleep(5);
			}
			expect(received).toEqual(["ping"]);
			expect(firstToken).toBeDefined();
			expect(JSON.parse(client.governorSnapshot())).toMatchObject({
				queuedBytesGlobal: 4,
				hostTokensActive: 1,
			});

			client.sendDatagram(conn, sessionId, encoder.encode("pong"));
			await Bun.sleep(100);
			expect(received).toEqual(["ping"]);
			expect(JSON.parse(client.governorSnapshot())).toMatchObject({
				queuedBytesGlobal: 4,
				hostTokensActive: 1,
			});

			const retainedToken = requireValue(firstToken, "first host token");
			expect(client.releaseHostReservation(retainedToken)).toBe(true);
			expect(client.releaseHostReservation(retainedToken)).toBe(false);
			expect(JSON.parse(client.governorSnapshot())).toMatchObject({
				queuedBytesGlobal: 0,
				hostTokensActive: 0,
			});

			client.sendDatagram(conn, sessionId, encoder.encode("pong"));
			const secondDeadline = Date.now() + 3_000;
			while (received.length < 2 && Date.now() < secondDeadline) {
				await Bun.sleep(5);
			}
			expect(received).toEqual(["ping", "pong"]);
			expect(JSON.parse(client.governorSnapshot())).toMatchObject({
				queuedBytesGlobal: 0,
				hostTokensActive: 0,
			});

			client.close();
			server.close();
		},
	);

	test.skipIf(!wasmAvailable)(
		"real manager keeps paused datagram reservation through WHATWG pull and resumes after capacity frees",
		async () => {
			const pair = await realManagedPair({
				maxDatagramSize: 4,
				maxQueuedBytesGlobal: 4,
				maxQueuedBytesPerSession: 4,
				maxQueuedBytesPerStream: 4,
			});
			pair.serverSession.onDatagram((data) => {
				pair.serverSession.sendDatagram(data);
			});
			const facade = new WasmWebTransport(pair.clientSession);

			pair.clientSession.sendDatagram(new Uint8Array([1, 2, 3, 4]));
			const held = await waitForSnapshot(
				pair.clientManager,
				(snapshot) =>
					snapshot.hostQueuedBytesGlobal === 4 &&
					snapshot.rustQueuedBytesGlobal === 4,
				"datagram was not retained under one logical budget",
			);
			expect(held.hostReservationsActive).toBe(1);

			pair.clientSession.sendDatagram(new Uint8Array([5, 6, 7, 8]));
			await Bun.sleep(100);
			expect(pair.clientManager.resourceSnapshot().hostQueuedBytesGlobal).toBe(
				4,
			);
			expect(
				await Promise.race([
					pair.clientSession.closed.then(() => "closed"),
					Bun.sleep(100).then(() => "open"),
				]),
			).toBe("open");
			expect(pair.clientManager.resourceSnapshot().hostQueuedBytesGlobal).toBe(
				4,
			);

			const datagramReader = facade.datagrams.readable.getReader();
			const first = await readWithTimeout(
				datagramReader,
				100,
				"wasm limits real datagram retained pull",
			);
			expect(first.value).toEqual(new Uint8Array([1, 2, 3, 4]));
			const second = await readWithTimeout(
				datagramReader,
				3_000,
				"wasm limits real datagram resumed pull",
			);
			datagramReader.releaseLock();
			expect(second.value).toEqual(new Uint8Array([5, 6, 7, 8]));
			await waitForSnapshot(
				pair.clientManager,
				(snapshot) =>
					snapshot.hostQueuedBytesGlobal === 0 &&
					snapshot.rustQueuedBytesGlobal === 0,
				"datagram pull did not release the original token",
			);

			pair.clientSession.sendDatagram(new Uint8Array([9, 10, 11, 12]));
			await waitForSnapshot(
				pair.clientManager,
				(snapshot) => snapshot.hostQueuedBytesGlobal === 4,
				"second retained datagram",
			);
			pair.clientManager.close();
			expect(pair.clientManager.resourceSnapshot()).toMatchObject({
				hostReservationsActive: 0,
				hostQueuedBytesGlobal: 0,
				rustQueuedBytesGlobal: 0,
				rustHostTokensActive: 0,
			});
			pair.serverManager.close();
		},
		10_000,
	);

	test.skipIf(!wasmAvailable)(
		"real manager backpressures paused bidi and uni stream payloads and close-without-consume returns zero",
		async () => {
			const pair = await realManagedPair({
				maxStreamsPerSessionBidi: 1,
				maxStreamsPerSessionUni: 1,
				maxStreamsGlobal: 2,
				maxQueuedBytesGlobal: 8,
				maxQueuedBytesPerSession: 8,
				maxQueuedBytesPerStream: 4,
			});
			new WasmWebTransport(pair.clientSession);
			const bidi = pair.serverSession.createBidirectionalStream();
			const uni = pair.serverSession.createUnidirectionalStream();
			await bidi.writeAll(new Uint8Array([1, 2, 3, 4]));
			await uni.writeAll(new Uint8Array([5, 6, 7, 8]));

			const held = await waitForSnapshot(
				pair.clientManager,
				(snapshot) =>
					snapshot.hostQueuedBytesGlobal === 8 &&
					snapshot.hostReservationsActive === 2,
				"both stream kinds were not retained at the exact global boundary",
			);
			expect(held.rustQueuedBytesGlobal).toBe(8);
			await bidi.writeAll(new Uint8Array([9]));
			await Bun.sleep(100);
			expect(pair.clientManager.endpoint.takeLastError()).toBe("");
			expect(pair.clientManager.resourceSnapshot()).toMatchObject({
				hostReservationsActive: 2,
				hostQueuedBytesGlobal: 8,
				rustQueuedBytesGlobal: 8,
			});

			pair.clientManager.close();
			expect(pair.clientManager.resourceSnapshot()).toMatchObject({
				hostReservationsActive: 0,
				hostQueuedBytesGlobal: 0,
				rustQueuedBytesGlobal: 0,
				rustHostTokensActive: 0,
			});
			pair.serverManager.close();
		},
		10_000,
	);

	test.skipIf(!wasmAvailable)(
		"real WHATWG stream queue retains one token until pull and recovers at the exact byte limit",
		async () => {
			const pair = await realManagedPair({
				maxQueuedBytesGlobal: 4,
				maxQueuedBytesPerSession: 4,
				maxQueuedBytesPerStream: 4,
			});
			const facade = new WasmWebTransport(pair.clientSession);
			const incomingReader = facade.incomingUnidirectionalStreams.getReader();
			const incomingRead = readWithTimeout(
				incomingReader,
				3_000,
				"wasm limits real incoming stream outer pull",
			);
			const outgoing = pair.serverSession.createUnidirectionalStream();
			const inner = requireValue(
				(await incomingRead).value,
				"real incoming stream",
			);
			incomingReader.releaseLock();

			await outgoing.writeAll(new Uint8Array([1, 2, 3, 4]));
			await waitForSnapshot(
				pair.clientManager,
				(snapshot) =>
					snapshot.hostQueuedBytesGlobal === 4 &&
					snapshot.rustQueuedBytesGlobal === 4,
				"WHATWG stream source did not retain its token",
			);
			await outgoing.writeAll(new Uint8Array([5]));
			await Bun.sleep(25);
			expect(pair.clientManager.resourceSnapshot().hostQueuedBytesGlobal).toBe(
				4,
			);

			const reader = inner.getReader();
			const chunk = await readWithTimeout(
				reader,
				100,
				"wasm limits real incoming stream first payload pull",
			);
			expect(chunk.value).toEqual(new Uint8Array([1, 2, 3, 4]));
			const deferred = await readWithTimeout(
				reader,
				100,
				"wasm limits real incoming stream deferred payload pull",
			);
			expect(deferred.value).toEqual(new Uint8Array([5]));
			await waitForSnapshot(
				pair.clientManager,
				(snapshot) =>
					snapshot.hostQueuedBytesGlobal === 0 &&
					snapshot.rustQueuedBytesGlobal === 0,
				"WHATWG stream pull did not release token",
			);
			pair.clientManager.close();
			pair.serverManager.close();
		},
		10_000,
	);

	test.skipIf(!wasmAvailable)(
		"real exact-limit retained stream payload still surfaces FIN and reset",
		async () => {
			const pair = await realManagedPair({
				maxQueuedBytesGlobal: 4,
				maxQueuedBytesPerSession: 4,
				maxQueuedBytesPerStream: 4,
			});
			const nextIncoming = () =>
				Promise.race([
					new Promise<WasmStream>((resolve) => {
						pair.clientSession.onIncomingStream(resolve);
					}),
					Bun.sleep(3_000).then(() => {
						throw new Error("incoming stream timeout");
					}),
				]);

			const finIncoming = nextIncoming();
			const finOutgoing = pair.serverSession.createUnidirectionalStream();
			const finStream = await finIncoming;
			let retainedFinPayload:
				| { readonly bytes: number; release(): boolean }
				| undefined;
			let finObserved = false;
			finStream.onData(
				(data, fin, reservation) => {
					if (data.length > 0) retainedFinPayload = reservation;
					else reservation?.release();
					if (fin) finObserved = true;
				},
				{ retainReservation: true },
			);
			await finOutgoing.writeAll(new Uint8Array([1, 2, 3, 4]));
			await waitForSnapshot(
				pair.clientManager,
				(snapshot) =>
					snapshot.hostQueuedBytesGlobal === 4 &&
					retainedFinPayload?.bytes === 4,
				"exact-limit FIN payload was not retained",
			);
			finOutgoing.finish();
			const atFin = await waitForSnapshot(
				pair.clientManager,
				() => finObserved,
				"FIN was hidden behind the exact byte limit",
			);
			expect(atFin.hostQueuedBytesGlobal).toBe(4);
			expect(atFin.rustQueuedBytesGlobal).toBe(4);
			expect(retainedFinPayload?.release()).toBe(true);
			await waitForSnapshot(
				pair.clientManager,
				(snapshot) =>
					snapshot.hostQueuedBytesGlobal === 0 &&
					snapshot.rustQueuedBytesGlobal === 0,
				"retained FIN payload did not release",
			);

			const resetIncoming = nextIncoming();
			const resetOutgoing = pair.serverSession.createUnidirectionalStream();
			const resetStream = await resetIncoming;
			let retainedResetPayload:
				| { readonly bytes: number; release(): boolean }
				| undefined;
			let resetCode: number | undefined;
			resetStream.onData(
				(data, _fin, reservation) => {
					if (data.length > 0) retainedResetPayload = reservation;
					else reservation?.release();
				},
				{ retainReservation: true },
			);
			resetStream.onReset((code) => {
				resetCode = code;
			});
			await resetOutgoing.writeAll(new Uint8Array([5, 6, 7, 8]));
			await waitForSnapshot(
				pair.clientManager,
				(snapshot) =>
					snapshot.hostQueuedBytesGlobal === 4 &&
					retainedResetPayload?.bytes === 4,
				"exact-limit reset payload was not retained",
			);
			resetOutgoing.reset(37);
			const atReset = await waitForSnapshot(
				pair.clientManager,
				() => resetCode === 37,
				"reset was hidden behind the exact byte limit",
			);
			expect(atReset.hostQueuedBytesGlobal).toBe(4);
			expect(atReset.rustQueuedBytesGlobal).toBe(4);
			expect(retainedResetPayload?.release()).toBe(true);
			await waitForSnapshot(
				pair.clientManager,
				(snapshot) =>
					snapshot.hostQueuedBytesGlobal === 0 &&
					snapshot.rustQueuedBytesGlobal === 0,
				"retained reset payload did not release",
			);

			pair.clientManager.close();
			pair.serverManager.close();
		},
		15_000,
	);

	test.skipIf(!wasmAvailable)(
		"configured handshake and idle deadlines surface stable timeout diagnostics",
		async () => {
			const unreachable = new InMemoryRelay();
			const handshakeStarted = Date.now();
			await expect(
				connectWasm(
					wasm,
					unreachable.a,
					"localhost",
					"127.0.0.1:5544",
					"127.0.0.1:4433",
					{ limits: { handshakeTimeoutMs: 20, idleTimeoutMs: 50 } },
				),
			).rejects.toThrow(/E_HANDSHAKE_TIMEOUT/);
			expect(Date.now() - handshakeStarted).toBeLessThan(1_000);

			const transport = droppableTransportPair();
			const options = normalizeWasmEndpointOptions({
				limits: { handshakeTimeoutMs: 20, idleTimeoutMs: 50 },
			});
			let resolveServerSession!: (session: WasmSession) => void;
			const serverSession = new Promise<WasmSession>((resolve) => {
				resolveServerSession = resolve;
			});
			const serverManager = WasmTransportManager.create(
				wasm,
				transport.a,
				true,
				"127.0.0.1:4433",
				"127.0.0.1:5544",
				resolveServerSession,
				options,
			);
			const clientManager = WasmTransportManager.create(
				wasm,
				transport.b,
				false,
				"127.0.0.1:5544",
				"127.0.0.1:4433",
				null,
				options,
			);
			const clientSession = clientManager.connectClient("localhost");
			await Promise.race([
				Promise.all([clientSession.ready, serverSession]),
				Bun.sleep(3_000).then(() => {
					throw new Error("timeout pair establishment failed");
				}),
			]);
			transport.setDrop(true);
			const closed = await Promise.race([
				clientSession.closed,
				Bun.sleep(1_000).then(() => {
					throw new Error("idle timeout did not fire");
				}),
			]);
			expect(closed.reason).toContain("E_SESSION_IDLE_TIMEOUT");
			clientManager.close();
			serverManager.close();
		},
		10_000,
	);
});
