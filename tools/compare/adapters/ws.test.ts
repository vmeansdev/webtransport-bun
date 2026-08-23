import { describe, expect, test } from "bun:test";
import { canonicalJson } from "../canonical.ts";
import {
	CANONICAL_CAPACITY_PROFILE,
	CANONICAL_SCENARIO_REGISTRY,
} from "../scenario-registry.ts";
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

function deadline(now = 0, timeoutMs = 100): number {
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
			return socket;
		},
	});
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
		const server = await adapter.startServer({ port: 4433, role: "publisher" });
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
		const server = await adapter.startServer({ port: 4433, role: "publisher" });
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
			deadlineMs: 100,
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
			deadlineMs: 100,
		});
		socket.receive(encodeWebSocketFrame({ kind: "open-uni", channelId: 9 }));
		const uni = await session.acceptUni(100);
		socket.receive(
			encodeWebSocketFrame({
				kind: "channel-data",
				channelId: 9,
				payload: Uint8Array.from([8, 7]),
			}),
		);
		socket.receive(encodeWebSocketFrame({ kind: "channel-end", channelId: 9 }));
		expect(await boundedRead(uni, 100)).toEqual(Uint8Array.from([8, 7]));
		expect(await boundedRead(uni, 100)).toBeNull();
		const uniWriter = uni as unknown as {
			write(bytes: Uint8Array, deadlineMs: number): Promise<unknown>;
		};
		await expect(
			uniWriter.write(Uint8Array.from([1]), 100),
		).rejects.toMatchObject({ code: "E_SESSION_CLOSED" });

		socket.receive(encodeWebSocketFrame({ kind: "open-bidi", channelId: 10 }));
		const bidi = await session.acceptBidi(100);
		await bidi.write(Uint8Array.from([4]), 100);
		socket.receive(
			encodeWebSocketFrame({
				kind: "channel-data",
				channelId: 10,
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
			tls: { cert: "cert", key: "key" },
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
		expect(options.tls).toEqual({ cert: "cert", key: "key" });
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
				sockets.push(socket);
				return socket;
			},
		});
		const first = await adapter.connect({
			url: "wss://compare",
			role: "publisher",
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
});
