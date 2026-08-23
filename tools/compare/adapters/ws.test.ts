import { describe, expect, test } from "bun:test";
import { canonicalJson } from "../canonical.ts";
import {
	CANONICAL_CAPACITY_PROFILE,
	CANONICAL_SCENARIO_REGISTRY,
} from "../scenario-registry.ts";
import type { CapacityProfile } from "../types.ts";
import { encodeWireMessage, type WireMessage } from "../wire.ts";
import type { ReceiveChannel } from "./transport.ts";
import {
	type ClientWebSocketLike,
	decodeWebSocketFrame,
	encodeHandshakeFrame,
	encodeWebSocketFrame,
	type ServerWebSocketLike,
	WebSocketAdapter,
	type WebSocketServerRuntime,
	type WebSocketServerRuntimeOptions,
	WebSocketTransportError,
} from "./ws.ts";

type Listener = (...args: unknown[]) => void;

class FakeClientSocket implements ClientWebSocketLike {
	readonly sent: Array<string | Uint8Array> = [];
	readonly listeners = new Map<string, Set<Listener>>();
	readyState = 0;
	bufferedAmount = 0;
	binaryType = "uint8array" as const;
	closeCalls: Array<{ readonly code?: number; readonly reason?: string }> = [];

	send(data: string | ArrayBuffer | ArrayBufferView): void {
		if (this.readyState !== 1) throw new Error("socket is not open");
		if (typeof data === "string") {
			this.sent.push(data);
			return;
		}
		const bytes =
			data instanceof ArrayBuffer
				? new Uint8Array(data)
				: new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
		this.sent.push(bytes.slice());
	}

	close(code?: number, reason?: string): void {
		this.closeCalls.push({ code, reason });
		this.readyState = 3;
		this.emit("close", { code: code ?? 1000, reason: reason ?? "" });
	}

	addEventListener(type: string, listener: EventListener): void {
		const listeners = this.listeners.get(type) ?? new Set<Listener>();
		listeners.add(listener as unknown as Listener);
		this.listeners.set(type, listeners);
	}

	removeEventListener(type: string, listener: EventListener): void {
		this.listeners.get(type)?.delete(listener as unknown as Listener);
	}

	emit(type: string, ...args: unknown[]): void {
		for (const listener of this.listeners.get(type) ?? []) listener(...args);
	}

	open(): void {
		this.readyState = 1;
		this.emit("open", {});
	}

	receive(data: string | Uint8Array): void {
		this.emit("message", { data });
	}
}

class FakeServerSocket implements ServerWebSocketLike {
	readonly sent: Array<string | Uint8Array> = [];
	readonly listeners = new Map<string, Set<Listener>>();
	readonly statuses: number[] = [];
	readonly closeCalls: Array<{
		readonly code?: number;
		readonly reason?: string;
	}> = [];
	readonly remoteAddress = "10.99.0.1";
	readyState = 1 as const;
	data: { readonly role?: string } = {};

	send(data: string | ArrayBuffer | ArrayBufferView): number {
		const bytes =
			typeof data === "string"
				? data
				: data instanceof ArrayBuffer
					? new Uint8Array(data).slice()
					: new Uint8Array(
							data.buffer,
							data.byteOffset,
							data.byteLength,
						).slice();
		this.sent.push(bytes);
		return (
			this.statuses.shift() ?? (typeof data === "string" ? data.length : 1)
		);
	}

	close(code?: number, reason?: string): void {
		this.closeCalls.push({ code, reason });
		this.readyState = 3 as 1;
		this.emit("close", 1000, "");
	}

	addEventListener(type: string, listener: EventListener): void {
		const listeners = this.listeners.get(type) ?? new Set<Listener>();
		listeners.add(listener as unknown as Listener);
		this.listeners.set(type, listeners);
	}

	removeEventListener(type: string, listener: EventListener): void {
		this.listeners.get(type)?.delete(listener as unknown as Listener);
	}

	emit(type: string, ...args: unknown[]): void {
		for (const listener of this.listeners.get(type) ?? []) listener(...args);
	}

	receive(data: string | Uint8Array): void {
		this.emit("message", this, data);
	}
}

class FakeServerRuntime implements WebSocketServerRuntime {
	readonly options: WebSocketServerRuntimeOptions;
	readonly sockets: FakeServerSocket[] = [];
	stopped = false;

	constructor(options: WebSocketServerRuntimeOptions) {
		this.options = options;
	}

	stop(): void {
		this.stopped = true;
	}

	open(socket = new FakeServerSocket()): FakeServerSocket {
		this.sockets.push(socket);
		this.options.websocket.open?.(socket);
		return socket;
	}

	receive(socket: FakeServerSocket, data: Uint8Array): void {
		this.options.websocket.message(socket, data);
	}

	drain(socket: FakeServerSocket): void {
		this.options.websocket.drain?.(socket);
	}

	close(socket: FakeServerSocket, code = 1000, reason = ""): void {
		this.options.websocket.close?.(socket, code, reason);
	}
}

function message(sequence = 7): WireMessage {
	return {
		runId: "run-1",
		sessionId: "session-1",
		sequence,
		expiresAtMs: 10_000,
		payload: Uint8Array.from([0, 1, 2, 255]),
	};
}

const TEST_CLIENT_TLS = Object.freeze({
	ca: "CA",
	serverName: "wt-compare.local",
	rejectUnauthorized: true,
});

const TEST_SERVER_TLS = Object.freeze({
	cert: "cert",
	key: "key",
	serverName: "wt-compare.local",
});

function deadline(now = Date.now(), timeoutMs = 100): number {
	return now + timeoutMs;
}

function boundedRead(
	channel: ReceiveChannel,
	deadlineMs: number,
): Promise<Uint8Array | null> {
	const read = Reflect.get(channel, "read");
	if (typeof read !== "function")
		throw new TypeError("receive channel is not readable");
	return read.call(channel, deadlineMs) as Promise<Uint8Array | null>;
}

type BoundedResult<T> =
	| { readonly kind: "resolved"; readonly value: T }
	| { readonly kind: "rejected"; readonly reason: unknown }
	| { readonly kind: "timeout" };

async function observeBounded<T>(
	promise: Promise<T>,
	timeoutMs = 50,
): Promise<BoundedResult<T>> {
	return Promise.race([
		promise.then(
			(value) => ({ kind: "resolved" as const, value }),
			(reason) => ({ kind: "rejected" as const, reason }),
		),
		new Promise<BoundedResult<T>>((resolve) => {
			setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
		}),
	]);
}

function makeAdapter(
	socket: FakeClientSocket,
	clock: { nowMs: () => number; sleep: (ms: number) => Promise<void> } = {
		nowMs: () => Date.now(),
		sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	},
): WebSocketAdapter {
	return new WebSocketAdapter({
		clock,
		clientFactory: (_url, _options) => {
			socket.open();
			queueMicrotask(() =>
				socket.receive(encodeWebSocketFrame({ kind: "hello-ack" })),
			);
			return socket;
		},
	});
}

async function openServerFixture(
	adapter: WebSocketAdapter,
	holder: { current?: FakeServerRuntime },
	capacityProfile?: CapacityProfile,
): Promise<{
	readonly server: Awaited<ReturnType<WebSocketAdapter["startServer"]>>;
	readonly socket: FakeServerSocket;
	readonly session: Awaited<
		ReturnType<
			Awaited<ReturnType<WebSocketAdapter["startServer"]>>["acceptSession"]
		>
	>;
}> {
	const server = await adapter.startServer({
		port: 4433,
		role: "publisher",
		tls: TEST_SERVER_TLS,
		...(capacityProfile ? { capacityProfile } : {}),
	});
	const socket = holder.current?.open();
	if (!socket) throw new Error("fake socket was not opened");
	holder.current?.receive(socket, encodeHandshakeFrame("publisher"));
	const session = await server.acceptSession(100);
	return { server, socket, session };
}

describe("Bun-native WebSocket comparison adapter", () => {
	test("sends exact wire bytes and preserves text payloads without compression", async () => {
		const socket = new FakeClientSocket();
		const adapter = makeAdapter(socket);
		const session = await adapter.connect({
			url: "wss://wt-compare.local:4433/compare",
			role: "publisher",
			tls: {
				ca: "-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----",
				serverName: "wt-compare.local",
				rejectUnauthorized: true,
			},
			deadlineMs: deadline(),
		});

		const wire = encodeWireMessage(message(), { nowMs: 0 });
		await session.sendMessage("reliable-message", message(), deadline());
		await session.sendText("control text", deadline());

		const frames = socket.sent.filter(
			(value): value is Uint8Array => value instanceof Uint8Array,
		);
		const dataFrame = frames
			.map((value) => decodeWebSocketFrame(value))
			.find((frame) => frame.kind === "message");
		expect(dataFrame?.payload).toEqual(wire);
		expect(socket.sent.some((value) => value === "control text")).toBe(true);
		expect(adapter.lastClientOptions?.perMessageDeflate).toBe(false);
		expect(adapter.lastClientOptions?.tls).toEqual({
			ca: "-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----",
			serverName: "wt-compare.local",
			rejectUnauthorized: true,
		});
	});

	test("waits for client high/low watermarks and fails at the bounded deadline", async () => {
		const socket = new FakeClientSocket();
		socket.bufferedAmount = 10;
		let now = 0;
		let sleeps = 0;
		const adapter = makeAdapter(socket, {
			nowMs: () => now,
			sleep: async (ms) => {
				sleeps += 1;
				now += ms;
				if (sleeps === 1) socket.bufferedAmount = 0;
			},
		});
		const session = await adapter.connect({
			url: "wss://compare",
			role: "publisher",
			tls: TEST_CLIENT_TLS,
			clientHighWaterMark: 4,
			clientLowWaterMark: 1,
			deadlineMs: deadline(0, 50),
		});
		await session.sendMessage("datagram", message(), deadline(now, 50));
		expect(sleeps).toBe(1);

		const blockedSocket = new FakeClientSocket();
		blockedSocket.bufferedAmount = 10;
		let blockedNow = 0;
		const blocked = makeAdapter(blockedSocket, {
			nowMs: () => blockedNow,
			sleep: async (ms) => {
				blockedNow += ms;
			},
		});
		const blockedSession = await blocked.connect({
			url: "wss://compare",
			role: "publisher",
			tls: TEST_CLIENT_TLS,
			clientHighWaterMark: 4,
			clientLowWaterMark: 1,
			deadlineMs: 50,
		});
		await expect(
			blockedSession.sendMessage("datagram", message(), 50),
		).rejects.toMatchObject({
			code: "E_BACKPRESSURE_TIMEOUT",
		});
	});

	test("maps server send status 0, -1, and positive and never resends a queued -1", async () => {
		let runtime: FakeServerRuntime | undefined;
		const adapter = new WebSocketAdapter({
			serverFactory: (options) => {
				runtime = new FakeServerRuntime(options);
				return runtime;
			},
			clock: { nowMs: () => 0, sleep: async () => {} },
		});
		const server = await adapter.startServer({
			port: 4433,
			role: "publisher",
			tls: TEST_SERVER_TLS,
		});
		const socket = runtime?.open();
		if (!socket) throw new Error("fake socket was not opened");
		runtime?.receive(socket, encodeHandshakeFrame("publisher"));
		const session = await server.acceptSession(100);

		socket.statuses.push(-1, 0, 17);
		const queued = await session.sendMessage(
			"reliable-message",
			message(1),
			100,
		);
		expect(queued.status).toBe(-1);
		expect(socket.sent).toHaveLength(2); // HELLO_ACK plus one data frame

		const secondSend = session.sendMessage("reliable-message", message(2), 100);
		runtime?.drain(socket);
		const refused = await secondSend;
		const accepted = await session.sendMessage(
			"reliable-message",
			message(3),
			100,
		);
		expect(refused.status).toBe(0);
		expect(accepted.status).toBe(17);
		expect(socket.sent).toHaveLength(4);
		expect(session.snapshot()).toMatchObject({
			attempted: 3,
			queued: 2,
			refused: 1,
		});
	});

	test("bounds incoming messages and keeps attempted, queued, observed, ack, and delivered distinct", async () => {
		let runtime: FakeServerRuntime | undefined;
		const adapter = new WebSocketAdapter({
			serverFactory: (options) => {
				runtime = new FakeServerRuntime(options);
				return runtime;
			},
			maxReceiveQueueBytes: 80,
			clock: { nowMs: () => 0, sleep: async () => {} },
		});
		const server = await adapter.startServer({
			port: 4433,
			role: "publisher",
			tls: TEST_SERVER_TLS,
		});
		const socket = runtime?.open();
		if (!socket) throw new Error("fake socket was not opened");
		runtime?.receive(socket, encodeHandshakeFrame("publisher"));
		const session = await server.acceptSession(100);
		const encoded = encodeWebSocketFrame({
			kind: "message",
			channelId: 0,
			payload: encodeWireMessage(message(), { nowMs: 0 }),
		});
		runtime?.receive(socket, encoded);
		runtime?.receive(socket, encoded);
		const received = await session.receiveMessage("reliable-message", 100);
		expect(received.payload).toEqual(message().payload);
		const metrics = session.snapshot();
		expect(metrics.attempted).toBe(0);
		expect(metrics.queued).toBe(0);
		expect(metrics.serverObserved).toBe(2);
		expect(metrics.acknowledged).toBe(0);
		expect(metrics.delivered).toBe(1);
		expect(metrics.dropped).toBe(1);
	});

	test("accepts only the requested server role and closes close/error races once", async () => {
		let runtime: FakeServerRuntime | undefined;
		const adapter = new WebSocketAdapter({
			serverFactory: (options) => {
				runtime = new FakeServerRuntime(options);
				return runtime;
			},
			clock: { nowMs: () => 0, sleep: async () => {} },
		});
		const server = await adapter.startServer({
			port: 4433,
			role: "subscriber",
			tls: TEST_SERVER_TLS,
		});
		const wrong = runtime?.open();
		if (!wrong) throw new Error("wrong fake socket was not opened");
		runtime?.receive(wrong, encodeHandshakeFrame("publisher"));
		const right = runtime?.open();
		if (!right) throw new Error("right fake socket was not opened");
		runtime?.receive(right, encodeHandshakeFrame("subscriber"));
		const session = await server.acceptSession(100);
		expect(session.role).toBe("subscriber");
		const pending = session.receiveMessage("reliable-message", 100);
		right.emit("error", new Error("socket failed"));
		right.emit("close", 1006, "failed");
		await expect(pending).rejects.toThrow("socket failed");
		await session.close(100);
		expect(right.closeCalls).toHaveLength(1);
		expect(server.snapshot().sessionsClosed).toBe(2); // rejected role + raced accepted session
	});

	test("creates and accepts directional virtual uni/bidi channels over one physical socket", async () => {
		const socket = new FakeClientSocket();
		const adapter = makeAdapter(socket);
		const session = await adapter.connect({
			url: "wss://compare",
			role: "publisher",
			tls: TEST_CLIENT_TLS,
			deadlineMs: deadline(),
		});
		const uni = await session.openUni(100);
		const bidi = await session.openBidi(100);
		const frames = socket.sent
			.filter((value): value is Uint8Array => value instanceof Uint8Array)
			.map((value) => decodeWebSocketFrame(value));
		expect(frames.filter((frame) => frame.kind === "open-uni")).toHaveLength(1);
		expect(frames.filter((frame) => frame.kind === "open-bidi")).toHaveLength(
			1,
		);
		await uni.write(Uint8Array.from([1, 2, 3]), 100);
		await uni.end(100);
		await bidi.write(Uint8Array.from([4, 5]), 100);
		await bidi.end(100);
		const channels = socket.sent
			.filter((value): value is Uint8Array => value instanceof Uint8Array)
			.map((value) => decodeWebSocketFrame(value))
			.filter((frame) => frame.kind === "channel-data");
		expect(channels.map((frame) => [...frame.payload])).toEqual([
			[1, 2, 3],
			[4, 5],
		]);
		expect(session.snapshot().streamsOpened).toBe(2);
		await session.close(100);
		expect(session.snapshot().active).toBe(false);
	});

	test("accepts remote uni and bidi channels with exact direction and bounded reads", async () => {
		const socket = new FakeClientSocket();
		const adapter = makeAdapter(socket, {
			nowMs: () => 0,
			sleep: async () => {},
		});
		const session = await adapter.connect({
			url: "wss://compare",
			role: "subscriber",
			tls: TEST_CLIENT_TLS,
			deadlineMs: 100,
		});
		socket.receive(encodeWebSocketFrame({ kind: "open-uni", channelId: 10 }));
		const uni = await session.acceptUni(100);
		socket.receive(
			encodeWebSocketFrame({
				kind: "channel-data",
				channelId: 10,
				payload: Uint8Array.from([8, 7]),
			}),
		);
		socket.receive(
			encodeWebSocketFrame({ kind: "channel-end", channelId: 10 }),
		);
		expect(await boundedRead(uni, 100)).toEqual(Uint8Array.from([8, 7]));
		expect(await boundedRead(uni, 100)).toBeNull();
		const uniWriter = uni as unknown as {
			write(bytes: Uint8Array, deadlineMs: number): Promise<unknown>;
		};
		await expect(
			uniWriter.write(Uint8Array.from([1]), 100),
		).rejects.toMatchObject({ code: "E_SESSION_CLOSED" });

		socket.receive(encodeWebSocketFrame({ kind: "open-bidi", channelId: 12 }));
		const bidi = await session.acceptBidi(100);
		await bidi.write(Uint8Array.from([4]), 100);
		socket.receive(
			encodeWebSocketFrame({
				kind: "channel-data",
				channelId: 12,
				payload: Uint8Array.from([5]),
			}),
		);
		expect(await boundedRead(bidi, 100)).toEqual(Uint8Array.from([5]));
	});

	test("submits the exact canonical profile and explicit Bun server limits", async () => {
		let runtime: FakeServerRuntime | undefined;
		const adapter = new WebSocketAdapter({
			serverFactory: (options) => {
				runtime = new FakeServerRuntime(options);
				return runtime;
			},
		});
		await adapter.startServer({
			port: 4433,
			tls: TEST_SERVER_TLS,
		});
		const options = runtime?.options;
		if (!options) throw new Error("server options were not captured");
		expect(options.websocket.perMessageDeflate).toBe(false);
		expect(options.websocket.backpressureLimit).toBe(
			CANONICAL_CAPACITY_PROFILE.maxQueuedBytesPerSession,
		);
		expect(options.websocket.maxPayloadLength).toBe(
			CANONICAL_CAPACITY_PROFILE.maxQueuedBytesPerStream,
		);
		expect(options.websocket.closeOnBackpressureLimit).toBe(false);
		expect(options.websocket.idleTimeout).toBe(60);
		expect(adapter.submittedCapacityProfile.bytes).toBe(
			canonicalJson(CANONICAL_CAPACITY_PROFILE),
		);
		expect(adapter.submittedCapacityProfile.hash).toBe(
			CANONICAL_SCENARIO_REGISTRY.capacityProfileHash,
		);
		expect(options.tls).toEqual(TEST_SERVER_TLS);
	});

	test("rejects insecure custom-CA client configuration", async () => {
		const socket = new FakeClientSocket();
		const adapter = makeAdapter(socket);
		await expect(
			adapter.connect({
				url: "wss://compare",
				role: "publisher",
				tls: {
					ca: "CA",
					serverName: "wt-compare.local",
					rejectUnauthorized: false,
				},
				deadlineMs: 100,
			}),
		).rejects.toBeInstanceOf(WebSocketTransportError);
	});

	test("shares session admission and token buckets across client sessions", async () => {
		const sockets: FakeClientSocket[] = [];
		const profile = {
			...CANONICAL_CAPACITY_PROFILE,
			maxSessions: 2,
			handshakesPerSec: 1,
			handshakesBurst: 1,
			handshakesBurstPerPrefix: 1,
			datagramsPerSec: 1,
			datagramsBurst: 1,
		};
		const adapter = new WebSocketAdapter({
			capacityProfile: profile,
			clock: { nowMs: () => 0, sleep: async () => {} },
			clientFactory: () => {
				const socket = new FakeClientSocket();
				socket.open();
				queueMicrotask(() =>
					socket.receive(encodeWebSocketFrame({ kind: "hello-ack" })),
				);
				sockets.push(socket);
				return socket;
			},
		});
		const first = await adapter.connect({
			url: "wss://compare",
			role: "publisher",
			tls: TEST_CLIENT_TLS,
			deadlineMs: 100,
		});
		await expect(
			adapter.connect({
				url: "wss://compare",
				role: "publisher",
				deadlineMs: 100,
			}),
		).rejects.toMatchObject({
			code: "E_LIMIT_EXCEEDED",
		});
		await first.sendMessage("datagram", message(), 100);
		await expect(
			first.sendMessage("datagram", message(2), 100),
		).rejects.toMatchObject({
			code: "E_RATE_LIMITED",
		});
		expect(first.snapshot()).toMatchObject({
			sessionsActive: 1,
			handshakesAttempted: 2,
			handshakesAccepted: 1,
			handshakesRejected: 1,
			datagramAttempts: 2,
			datagramAccepted: 1,
			datagramRejected: 1,
			tokenBucketRejected: 2,
		});
		await first.close(100);
		expect(sockets).toHaveLength(1);
	});

	test("bounds drain waiters and enforces global queued bytes", async () => {
		let runtime: FakeServerRuntime | undefined;
		const profile = {
			...CANONICAL_CAPACITY_PROFILE,
			maxQueuedBytesGlobal: 80,
			maxQueuedBytesPerSession: 80,
			maxQueuedBytesPerStream: 80,
		};
		const adapter = new WebSocketAdapter({
			capacityProfile: profile,
			receiveWaiterLimit: 1,
			serverFactory: (options) => {
				runtime = new FakeServerRuntime(options);
				return runtime;
			},
			clock: {
				nowMs: () => 0,
				sleep: async () => new Promise<void>(() => {}),
			},
		});
		const server = await adapter.startServer({
			port: 4433,
			role: "publisher",
			tls: TEST_SERVER_TLS,
		});
		const blockedSocket = runtime?.open();
		if (!blockedSocket) throw new Error("blocked fake socket was not opened");
		runtime?.receive(blockedSocket, encodeHandshakeFrame("publisher"));
		const blockedSession = await server.acceptSession(100);
		blockedSocket.statuses.push(-1);
		await blockedSession.sendMessage("reliable-message", message(1), 100);
		const pendingDrain = blockedSession.sendMessage(
			"reliable-message",
			message(2),
			100,
		);
		const drainResult = await observeBounded(pendingDrain);
		runtime?.drain(blockedSocket);
		const afterDrain = await observeBounded(pendingDrain);

		const firstSocket = runtime?.open();
		const secondSocket = runtime?.open();
		if (!firstSocket || !secondSocket)
			throw new Error("global-queue fake sockets were not opened");
		runtime?.receive(firstSocket, encodeHandshakeFrame("publisher"));
		runtime?.receive(secondSocket, encodeHandshakeFrame("publisher"));
		const firstSession = await server.acceptSession(100);
		const secondSession = await server.acceptSession(100);
		const encoded = encodeWebSocketFrame({
			kind: "message",
			payload: encodeWireMessage(message(), { nowMs: 0 }),
		});
		runtime?.receive(firstSocket, encoded);
		runtime?.receive(secondSocket, encoded);

		expect({
			drainResult,
			afterDrain,
			first: firstSession.snapshot(),
			second: secondSession.snapshot(),
		}).toMatchObject({
			drainResult: {
				kind: "rejected",
				reason: { code: "E_QUEUE_FULL" },
			},
			afterDrain: {
				kind: "rejected",
				reason: { code: "E_QUEUE_FULL" },
			},
			first: { receiveQueueItems: 1, dropped: 0 },
			second: { receiveQueueItems: 0, dropped: 1 },
		});
	});

	test("waits for the server handshake acknowledgement and times out without one", async () => {
		const socket = new FakeClientSocket();
		let now = 0;
		const adapter = new WebSocketAdapter({
			clock: {
				nowMs: () => now,
				sleep: async (milliseconds) => {
					now += milliseconds;
				},
			},
			clientFactory: () => {
				socket.open();
				return socket;
			},
		});
		const result = await observeBounded(
			adapter.connect({
				url: "wss://compare",
				role: "publisher",
				tls: TEST_CLIENT_TLS,
				deadlineMs: 50,
			}),
		);
		if (result.kind === "resolved") await result.value.close(100);
		expect(result).toMatchObject({
			kind: "rejected",
			reason: { code: "E_HANDSHAKE_TIMEOUT" },
		});
	});

	test("bounds server stop and rejects a pre-open close", async () => {
		const adapter = new WebSocketAdapter({
			serverFactory: (options) => {
				const runtime = new FakeServerRuntime(options);
				runtime.stop = () => new Promise<void>(() => {});
				return runtime;
			},
			clock: { nowMs: () => 0, sleep: async () => {} },
		});
		const server = await adapter.startServer({
			port: 4433,
			tls: { cert: "cert", key: "key", serverName: "wt-compare.local" },
		});
		const stopResult = await observeBounded(server.stop(1));

		class PreOpenCloseSocket extends FakeClientSocket {
			override addEventListener(type: string, listener: EventListener): void {
				super.addEventListener(type, listener);
				if (type === "open" && this.readyState === 0)
					this.close(1006, "closed before open");
			}
		}
		const preOpen = new PreOpenCloseSocket();
		let now = 0;
		const preOpenAdapter = new WebSocketAdapter({
			clock: {
				nowMs: () => now,
				sleep: async (milliseconds) => {
					now += milliseconds;
				},
			},
			clientFactory: () => preOpen,
		});
		const openResult = await observeBounded(
			preOpenAdapter.connect({
				url: "wss://compare",
				role: "publisher",
				tls: TEST_CLIENT_TLS,
				deadlineMs: 50,
			}),
		);
		expect(stopResult.kind).toBe("rejected");
		expect(openResult.kind).toBe("rejected");
		if (stopResult.kind === "rejected")
			expect((stopResult.reason as WebSocketTransportError).code).toBe(
				"E_BACKPRESSURE_TIMEOUT",
			);
		if (openResult.kind === "rejected")
			expect((openResult.reason as WebSocketTransportError).code).toBe(
				"E_SESSION_CLOSED",
			);
	});

	test("allocates collision-free channel IDs for both endpoint roles", async () => {
		const clientSocket = new FakeClientSocket();
		const client = makeAdapter(clientSocket, {
			nowMs: () => 0,
			sleep: async () => {},
		});
		const clientSession = await client.connect({
			url: "wss://compare",
			role: "publisher",
			tls: TEST_CLIENT_TLS,
			deadlineMs: 100,
		});
		const clientChannel = await clientSession.openBidi(100);

		let runtime: FakeServerRuntime | undefined;
		const serverAdapter = new WebSocketAdapter({
			serverFactory: (options) => {
				runtime = new FakeServerRuntime(options);
				return runtime;
			},
			clock: { nowMs: () => 0, sleep: async () => {} },
		});
		const server = await serverAdapter.startServer({
			port: 4433,
			role: "publisher",
			tls: TEST_SERVER_TLS,
		});
		const socket = runtime?.open();
		if (!socket) throw new Error("server fake socket was not opened");
		runtime?.receive(socket, encodeHandshakeFrame("publisher"));
		const serverSession = await server.acceptSession(100);
		const serverChannel = await serverSession.openUni(100);

		expect(clientChannel.channelId % 2).not.toBe(serverChannel.channelId % 2);
		expect(clientChannel.channelId).not.toBe(serverChannel.channelId);
	});

	test("keeps bidi send and receive halves independent after either end closes", async () => {
		const localSocket = new FakeClientSocket();
		const local = makeAdapter(localSocket, {
			nowMs: () => 0,
			sleep: async () => {},
		});
		const localSession = await local.connect({
			url: "wss://compare",
			role: "publisher",
			tls: TEST_CLIENT_TLS,
			deadlineMs: 100,
		});
		const localChannel = await localSession.openBidi(100);
		await localChannel.end(100);
		localSocket.receive(
			encodeWebSocketFrame({
				kind: "channel-data",
				channelId: localChannel.channelId,
				payload: Uint8Array.from([3]),
			}),
		);
		const localRead = await observeBounded(boundedRead(localChannel, 100));

		const remoteSocket = new FakeClientSocket();
		const remote = makeAdapter(remoteSocket, {
			nowMs: () => 0,
			sleep: async () => {},
		});
		const remoteSession = await remote.connect({
			url: "wss://compare",
			role: "subscriber",
			tls: TEST_CLIENT_TLS,
			deadlineMs: 100,
		});
		remoteSocket.receive(
			encodeWebSocketFrame({ kind: "open-bidi", channelId: 12 }),
		);
		const remoteChannel = await remoteSession.acceptBidi(100);
		remoteSocket.receive(
			encodeWebSocketFrame({ kind: "channel-end", channelId: 12 }),
		);
		const remoteWrite = await observeBounded(
			remoteChannel.write(Uint8Array.from([4]), 100),
		);

		expect(localRead).toMatchObject({
			kind: "resolved",
			value: Uint8Array.from([3]),
		});
		expect(remoteWrite).toMatchObject({ kind: "resolved" });
	});

	test("rolls back a channel when server send status zero refuses its open frame", async () => {
		let runtime: FakeServerRuntime | undefined;
		const adapter = new WebSocketAdapter({
			serverFactory: (options) => {
				runtime = new FakeServerRuntime(options);
				return runtime;
			},
			clock: { nowMs: () => 0, sleep: async () => {} },
		});
		const server = await adapter.startServer({
			port: 4433,
			role: "publisher",
			tls: TEST_SERVER_TLS,
		});
		const socket = runtime?.open();
		if (!socket) throw new Error("server fake socket was not opened");
		runtime?.receive(socket, encodeHandshakeFrame("publisher"));
		const session = await server.acceptSession(100);
		socket.statuses.push(0);
		const result = await observeBounded(session.openUni(100));

		expect(result).toMatchObject({
			kind: "rejected",
			reason: { code: "E_QUEUE_FULL" },
		});
		expect(session.snapshot()).toMatchObject({
			streamsOpened: 0,
			streamsClosed: 1,
		});
	});

	test("retains lifetime metrics and counts rejected sends as attempted", async () => {
		const profile = { ...CANONICAL_CAPACITY_PROFILE, maxDatagramSize: 2 };
		const socket = new FakeClientSocket();
		const adapter = new WebSocketAdapter({
			capacityProfile: profile,
			clock: { nowMs: () => 0, sleep: async () => {} },
			clientFactory: () => {
				socket.open();
				queueMicrotask(() =>
					socket.receive(encodeWebSocketFrame({ kind: "hello-ack" })),
				);
				return socket;
			},
		});
		const session = await adapter.connect({
			url: "wss://compare",
			role: "publisher",
			tls: TEST_CLIENT_TLS,
			deadlineMs: 100,
		});
		await expect(
			session.sendMessage("datagram", message(), 100),
		).rejects.toMatchObject({
			code: "E_LIMIT_EXCEEDED",
		});
		expect(session.snapshot()).toMatchObject({
			sessionsOpened: 1,
			sessionsClosed: 0,
			attempted: 1,
			refused: 1,
		});
		await session.close(100);
		expect(session.snapshot()).toMatchObject({
			sessionsOpened: 1,
			sessionsClosed: 1,
			active: false,
		});
	});

	test("waits through the full high-to-low watermark hysteresis", async () => {
		const socket = new FakeClientSocket();
		socket.bufferedAmount = 10;
		let now = 0;
		let sleeps = 0;
		const adapter = makeAdapter(socket, {
			nowMs: () => now,
			sleep: async (milliseconds) => {
				now += milliseconds;
				sleeps += 1;
				socket.bufferedAmount = sleeps === 1 ? 7 : 4;
			},
		});
		const session = await adapter.connect({
			url: "wss://compare",
			role: "publisher",
			tls: TEST_CLIENT_TLS,
			clientHighWaterMark: 10,
			clientLowWaterMark: 5,
			deadlineMs: 100,
		});
		await session.sendText("hysteresis", 100);
		expect(sleeps).toBe(2);
	});

	test("requires strict custom-CA and SNI TLS on both client and server", async () => {
		const clientAdapter = new WebSocketAdapter({
			clock: { nowMs: () => 0, sleep: async () => {} },
			clientFactory: () => {
				const socket = new FakeClientSocket();
				socket.open();
				return socket;
			},
		});
		const missingCa = await observeBounded(
			clientAdapter.connect({
				url: "wss://compare",
				role: "publisher",
				tls: { serverName: "wt-compare.local", rejectUnauthorized: true },
				deadlineMs: 100,
			}),
		);
		const missingSni = await observeBounded(
			clientAdapter.connect({
				url: "wss://compare",
				role: "publisher",
				tls: { ca: "CA", rejectUnauthorized: true },
				deadlineMs: 100,
			}),
		);

		let runtime: FakeServerRuntime | undefined;
		const serverAdapter = new WebSocketAdapter({
			serverFactory: (options) => {
				runtime = new FakeServerRuntime(options);
				return runtime;
			},
		});
		const missingServerSni = await observeBounded(
			serverAdapter.startServer({
				port: 4433,
				tls: { cert: "cert", key: "key" },
			}),
		);

		expect([missingCa, missingSni, missingServerSni]).toMatchObject([
			{ kind: "rejected", reason: { code: "E_TLS" } },
			{ kind: "rejected", reason: { code: "E_TLS" } },
			{ kind: "rejected", reason: { code: "E_TLS" } },
		]);
	});

	test("uses one active submitted capacity profile and rejects divergent starts", async () => {
		const makeServerAdapter = () =>
			new WebSocketAdapter({
				serverFactory: (options) => new FakeServerRuntime(options),
			});
		const adapter = makeServerAdapter();
		const first = await adapter.startServer({
			port: 4433,
			tls: { cert: "cert", key: "key", serverName: "wt-compare.local" },
		});
		const second = await observeBounded(
			adapter.startServer({
				port: 4434,
				tls: { cert: "cert", key: "key", serverName: "wt-compare.local" },
			}),
		);
		const divergent = await observeBounded(
			makeServerAdapter().startServer({
				port: 4433,
				tls: { cert: "cert", key: "key", serverName: "wt-compare.local" },
				capacityProfile: {
					...CANONICAL_CAPACITY_PROFILE,
					maxSessions: CANONICAL_CAPACITY_PROFILE.maxSessions - 1,
				},
			}),
		);

		expect({
			submitted: adapter.submittedCapacityProfile.profile,
			second,
			divergent,
		}).toMatchObject({
			submitted: CANONICAL_CAPACITY_PROFILE,
			second: {
				kind: "rejected",
				reason: { code: "E_LIMIT_EXCEEDED" },
			},
			divergent: {
				kind: "rejected",
				reason: { code: "E_LIMIT_EXCEEDED" },
			},
		});
		await first.stop(100);
	});
});

describe("Task4 reviewer regression probes (RED)", () => {
	test("accepts a 1200-byte application datagram despite envelope overhead", async () => {
		const holder: { current?: FakeServerRuntime } = {};
		const adapter = new WebSocketAdapter({
			serverFactory: (options) => {
				holder.current = new FakeServerRuntime(options);
				return holder.current;
			},
			clock: { nowMs: () => 0, sleep: async () => {} },
		});
		const { session, socket } = await openServerFixture(adapter, holder);
		const datagram = { ...message(11), payload: new Uint8Array(1_200) };
		holder.current?.receive(
			socket,
			encodeWebSocketFrame({
				kind: "message",
				deliveryKind: "datagram",
				payload: encodeWireMessage(datagram, { nowMs: 0 }),
			}),
		);

		expect(session.snapshot()).toMatchObject({
			serverObserved: 1,
			dropped: 0,
			receiveQueueItems: 1,
		});
		await session.close(100);
	});

	test("bounds invalid client open deadlines and settles handshake admission", async () => {
		const outcomes: Array<{
			readonly label: string;
			readonly firstKind: BoundedResult<unknown>["kind"];
			readonly secondKind: BoundedResult<unknown>["kind"];
			readonly secondInFlight?: number;
		}> = [];
		for (const deadlineMs of [Number.POSITIVE_INFINITY, Number.NaN, -1]) {
			let factoryCalls = 0;
			const adapter = new WebSocketAdapter({
				capacityProfile: {
					...CANONICAL_CAPACITY_PROFILE,
					maxHandshakesInFlight: 1,
				},
				clock: { nowMs: () => 0, sleep: async () => {} },
				clientFactory: () => {
					factoryCalls += 1;
					const socket = new FakeClientSocket();
					socket.open();
					if (factoryCalls === 1)
						queueMicrotask(() =>
							socket.receive(encodeWebSocketFrame({ kind: "hello-ack" })),
						);
					return socket;
				},
			});
			const first = await observeBounded(
				adapter.connect({
					url: "wss://compare",
					role: "publisher",
					tls: TEST_CLIENT_TLS,
					deadlineMs,
				}),
			);
			const second = await observeBounded(
				adapter.connect({
					url: "wss://compare",
					role: "publisher",
					tls: TEST_CLIENT_TLS,
					deadlineMs: 100,
				}),
			);
			let secondInFlight: number | undefined;
			if (second.kind === "resolved") {
				secondInFlight = second.value.snapshot().handshakesInFlight;
				await second.value.close(100);
			}
			outcomes.push({
				label: String(deadlineMs),
				firstKind: first.kind,
				secondKind: second.kind,
				secondInFlight,
			});
		}

		expect(outcomes).toEqual([
			{
				label: "Infinity",
				firstKind: "rejected",
				secondKind: "resolved",
				secondInFlight: 0,
			},
			{
				label: "NaN",
				firstKind: "rejected",
				secondKind: "resolved",
				secondInFlight: 0,
			},
			{
				label: "-1",
				firstKind: "rejected",
				secondKind: "resolved",
				secondInFlight: 0,
			},
		]);
	});

	test("conserves accepted and rejected counters for failed stream opens", async () => {
		const statusHolder: { current?: FakeServerRuntime } = {};
		const statusAdapter = new WebSocketAdapter({
			serverFactory: (options) => {
				statusHolder.current = new FakeServerRuntime(options);
				return statusHolder.current;
			},
			clock: { nowMs: () => 0, sleep: async () => {} },
		});
		const status = await openServerFixture(statusAdapter, statusHolder);
		status.socket.statuses.push(0);
		await expect(status.session.openUni(100)).rejects.toMatchObject({
			code: "E_QUEUE_FULL",
		});
		const statusMetrics = status.session.snapshot();
		await status.session.close(100);

		const reservationProfile = {
			...CANONICAL_CAPACITY_PROFILE,
			maxQueuedBytesPerStream: 12,
		};
		const reservationHolder: { current?: FakeServerRuntime } = {};
		const reservationAdapter = new WebSocketAdapter({
			capacityProfile: reservationProfile,
			serverFactory: (options) => {
				reservationHolder.current = new FakeServerRuntime(options);
				return reservationHolder.current;
			},
			clock: { nowMs: () => 0, sleep: async () => {} },
		});
		const reservation = await openServerFixture(
			reservationAdapter,
			reservationHolder,
			reservationProfile,
		);
		await expect(reservation.session.openUni(100)).rejects.toMatchObject({
			code: "E_QUEUE_FULL",
		});
		const reservationMetrics = reservation.session.snapshot();
		await reservation.session.close(100);

		const queueHolder: { current?: FakeServerRuntime } = {};
		const queueAdapter = new WebSocketAdapter({
			serverFactory: (options) => {
				queueHolder.current = new FakeServerRuntime(options);
				return queueHolder.current;
			},
			clock: { nowMs: () => 0, sleep: async () => {} },
		});
		const queue = await openServerFixture(queueAdapter, queueHolder);
		const acceptQueue = Reflect.get(queue.session, "uniAcceptQueue") as {
			close: (reason?: unknown) => void;
		};
		acceptQueue.close(new WebSocketTransportError("E_QUEUE_FULL", "full"));
		queueHolder.current?.receive(
			queue.socket,
			encodeWebSocketFrame({ kind: "open-uni", channelId: 1 }),
		);
		const queueMetrics = queue.session.snapshot();
		await queue.session.close(100);

		expect([statusMetrics, reservationMetrics, queueMetrics]).toMatchObject([
			{
				streamOpenAttempts: 1,
				streamOpenAccepted: 0,
				streamOpenRejected: 1,
			},
			{
				streamOpenAttempts: 1,
				streamOpenAccepted: 0,
				streamOpenRejected: 1,
			},
			{
				streamOpenAttempts: 1,
				streamOpenAccepted: 0,
				streamOpenRejected: 1,
			},
		]);
	});

	test("holds bidi capacity until both halves terminate", async () => {
		const socket = new FakeClientSocket();
		const adapter = new WebSocketAdapter({
			capacityProfile: {
				...CANONICAL_CAPACITY_PROFILE,
				maxStreamsPerSessionBidi: 1,
			},
			clientFactory: () => {
				socket.open();
				queueMicrotask(() =>
					socket.receive(encodeWebSocketFrame({ kind: "hello-ack" })),
				);
				return socket;
			},
		});
		const session = await adapter.connect({
			url: "wss://compare",
			role: "publisher",
			tls: TEST_CLIENT_TLS,
			deadlineMs: deadline(),
		});
		const channel = await session.openBidi(deadline());
		await channel.end(deadline());

		await expect(session.openBidi(deadline())).rejects.toMatchObject({
			code: "E_LIMIT_EXCEEDED",
		});
		await session.close(100);
	});

	test("ignores late frames after session close without mutating metrics or admission", async () => {
		const socket = new FakeClientSocket();
		const adapter = makeAdapter(socket);
		const session = await adapter.connect({
			url: "wss://compare",
			role: "publisher",
			tls: TEST_CLIENT_TLS,
			deadlineMs: deadline(),
		});
		await session.close(100);
		const before = session.snapshot();
		socket.receive(
			encodeWebSocketFrame({
				kind: "message",
				deliveryKind: "datagram",
				payload: encodeWireMessage(message(12), { nowMs: 0 }),
			}),
		);
		socket.receive(encodeWebSocketFrame({ kind: "open-uni", channelId: 2 }));

		expect(session.snapshot()).toEqual(before);
	});

	test("evicts closed session objects while conserving lifetime metrics", async () => {
		const holder: { current?: FakeServerRuntime } = {};
		const adapter = new WebSocketAdapter({
			serverFactory: (options) => {
				holder.current = new FakeServerRuntime(options);
				return holder.current;
			},
			clock: { nowMs: () => 0, sleep: async () => {} },
		});
		const { server, session } = await openServerFixture(adapter, holder);
		await session.close(100);
		const sessions = Reflect.get(server, "sessions") as Set<unknown>;

		expect(sessions.has(session)).toBe(false);
		expect(server.snapshot()).toMatchObject({ sessionsClosed: 1 });
	});

	test("uses an absolute stop deadline and clears activeServer after timeout", async () => {
		let now = 100;
		const sleeps: number[] = [];
		let starts = 0;
		const adapter = new WebSocketAdapter({
			clock: {
				nowMs: () => now,
				sleep: async (milliseconds) => {
					sleeps.push(milliseconds);
					now += milliseconds;
				},
			},
			serverFactory: (options) => {
				const runtime = new FakeServerRuntime(options);
				starts += 1;
				if (starts === 1) runtime.stop = () => new Promise<void>(() => {});
				return runtime;
			},
		});
		const server = await adapter.startServer({
			port: 4433,
			tls: TEST_SERVER_TLS,
		});
		const stopped = await observeBounded(server.stop(110));
		const restarted = await observeBounded(
			adapter.startServer({
				port: 4434,
				tls: TEST_SERVER_TLS,
			}),
		);
		if (restarted.kind === "resolved") await restarted.value.stop(now + 100);

		expect(Reflect.get(adapter, "activeServer")).toBeUndefined();
		expect({ stopped, sleeps, restarted }).toMatchObject({
			stopped: {
				kind: "rejected",
				reason: { code: "E_BACKPRESSURE_TIMEOUT" },
			},
			sleeps: [10],
			restarted: {
				kind: "rejected",
				reason: { code: "E_LIMIT_EXCEEDED" },
			},
		});
	});

	test("applies canonical handshakeTimeoutMs to the client handshake deadline", async () => {
		let now = 0;
		const sleeps: number[] = [];
		const adapter = new WebSocketAdapter({
			capacityProfile: {
				...CANONICAL_CAPACITY_PROFILE,
				handshakeTimeoutMs: 5,
			},
			clock: {
				nowMs: () => now,
				sleep: async (milliseconds) => {
					sleeps.push(milliseconds);
					now += milliseconds;
				},
			},
			clientFactory: () => {
				const socket = new FakeClientSocket();
				socket.open();
				return socket;
			},
		});
		const result = await observeBounded(
			adapter.connect({
				url: "wss://compare",
				role: "publisher",
				tls: TEST_CLIENT_TLS,
				deadlineMs: 1_000,
			}),
		);

		expect({ result, sleeps }).toMatchObject({
			result: { kind: "rejected", reason: { code: "E_HANDSHAKE_TIMEOUT" } },
			sleeps: [5],
		});
	});
});
