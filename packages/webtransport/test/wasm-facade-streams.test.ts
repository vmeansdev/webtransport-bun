/**
 * Behavioral coverage for the wasm W3C facade wrapper
 * (`src/wasm-webtransport.ts`): incoming-stream delivery and cancellation,
 * WHATWG writable close/abort, readable cancel, send groups and their byte
 * accounting, and the `waitUntilAvailable` retry loop.
 *
 * These drive the facade over a scripted `WasmSession`/`WasmStream` pair so the
 * wrapper's own semantics are asserted directly, independent of a live
 * handshake (the wasm-backed end-to-end paths live in wasm-facade.test.ts and
 * the parity suites).
 */

import { describe, expect, test } from "bun:test";
import type {
	WasmPayloadReservation,
	WasmSession,
	WasmStream,
} from "../src/backend.js";
import {
	E_BACKPRESSURE_TIMEOUT,
	E_INVALID_ARGUMENT,
	E_LIMIT_EXCEEDED,
	E_QUEUE_FULL,
	E_SESSION_CLOSED,
	WebTransportError,
} from "../src/errors.js";
import { WasmWebTransport } from "../src/wasm-webtransport.js";

type ScriptedStream = {
	stream: WasmStream;
	calls: string[];
	writes: Uint8Array[];
	pushData(
		data: Uint8Array,
		fin: boolean,
		reservation?: WasmPayloadReservation,
	): void;
	pushReset(code: number): void;
};

function scriptedStream(bidi = true): ScriptedStream {
	const calls: string[] = [];
	const writes: Uint8Array[] = [];
	let onData:
		| ((
				data: Uint8Array,
				fin: boolean,
				reservation?: WasmPayloadReservation,
		  ) => void)
		| null = null;
	let onReset: ((code: number) => void) | null = null;

	const stream = {
		bidi,
		onData(cb: typeof onData) {
			onData = cb;
		},
		onReset(cb: typeof onReset) {
			onReset = cb;
		},
		pause() {
			calls.push("pause");
		},
		resume() {
			calls.push("resume");
		},
		stop(code: number) {
			calls.push(`stop:${code}`);
		},
		reset(code: number) {
			calls.push(`reset:${code}`);
		},
		finish() {
			calls.push("finish");
		},
		async writeAll(chunk: Uint8Array) {
			writes.push(chunk.slice());
		},
	} as unknown as WasmStream;

	return {
		stream,
		calls,
		writes,
		pushData(data, fin, reservation) {
			onData?.(data, fin, reservation);
		},
		pushReset(code) {
			onReset?.(code);
		},
	};
}

function reservation(
	bytes: number,
): WasmPayloadReservation & { released: boolean } {
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

type ScriptedSession = {
	session: WasmSession;
	pushIncoming(stream: WasmStream): void;
	pushDatagram(data: Uint8Array, res?: WasmPayloadReservation): void;
	closeInfo: Array<{ code?: number; reason?: string }>;
	sent: Uint8Array[];
	setClosing(value: boolean): void;
	resolveClosed(info: { code?: number; reason?: string }): void;
};

function scriptedSession(
	overrides: {
		backpressureTimeoutMs?: number;
		openBidi?: () => WasmStream;
		openUni?: () => WasmStream;
		sendDatagram?: (data: Uint8Array) => Promise<void>;
	} = {},
): ScriptedSession {
	let onIncoming: ((stream: WasmStream) => void) | null = null;
	let onDatagram:
		| ((data: Uint8Array, res?: WasmPayloadReservation) => void)
		| null = null;
	let resolveClosed!: (info: { code?: number; reason?: string }) => void;
	const closed = new Promise<{ code?: number; reason?: string }>((resolve) => {
		resolveClosed = resolve;
	});
	const closeInfo: Array<{ code?: number; reason?: string }> = [];
	const sent: Uint8Array[] = [];
	let closing = false;

	const session = {
		ready: Promise.resolve(),
		closed,
		draining: new Promise<void>(() => {}),
		maxDatagramSize: 1200,
		get backpressureTimeoutMs() {
			return overrides.backpressureTimeoutMs ?? 5_000;
		},
		get isClosingOrClosed() {
			return closing;
		},
		onDatagram(cb: typeof onDatagram) {
			onDatagram = cb;
		},
		onIncomingStream(cb: typeof onIncoming) {
			onIncoming = cb;
		},
		async sendDatagram(data: Uint8Array) {
			if (overrides.sendDatagram) return overrides.sendDatagram(data);
			sent.push(data.slice());
		},
		createBidirectionalStream() {
			if (!overrides.openBidi) throw new Error("openBidi not scripted");
			return overrides.openBidi();
		},
		createUnidirectionalStream() {
			if (!overrides.openUni) throw new Error("openUni not scripted");
			return overrides.openUni();
		},
		connectionStats() {
			return {
				bytesSent: 1,
				bytesReceived: 2,
				packetsSent: 3,
				packetsReceived: 4,
				datagrams: {
					droppedIncoming: 0,
					expiredIncoming: 0,
					expiredOutgoing: 0,
					lostOutgoing: 0,
				},
			};
		},
		close(info?: { code?: number; reason?: string }) {
			closing = true;
			closeInfo.push(info ?? {});
		},
	} as unknown as WasmSession;

	return {
		session,
		pushIncoming(stream) {
			onIncoming?.(stream);
		},
		pushDatagram(data, res) {
			onDatagram?.(data, res);
		},
		closeInfo,
		sent,
		setClosing(value) {
			closing = value;
		},
		resolveClosed(info) {
			resolveClosed(info);
		},
	};
}

async function readWithin<T>(promise: Promise<T>, label: string): Promise<T> {
	return Promise.race([
		promise,
		Bun.sleep(500).then<never>(() => {
			throw new Error(`${label} did not settle`);
		}),
	]);
}

describe("wasm facade incoming streams", () => {
	test("delivers an incoming bidi stream as a readable/writable pair", async () => {
		const scripted = scriptedSession();
		const facade = new WasmWebTransport(scripted.session);
		const incoming = scriptedStream(true);

		const reader = facade.incomingBidirectionalStreams.getReader();
		const pending = readWithin(reader.read(), "incoming bidi read");
		// The facade only subscribes to the session on the first pull.
		await Bun.sleep(1);
		scripted.pushIncoming(incoming.stream);
		const { value, done } = await pending;
		reader.releaseLock();
		expect(done).toBe(false);
		if (!value) throw new Error("incoming bidi stream missing");

		const payload = reservation(3);
		incoming.pushData(new Uint8Array([1, 2, 3]), false, payload);
		// Inbound data parks until a consumer pulls, and pauses the wasm stream
		// so QUIC flow control throttles the peer.
		expect(incoming.calls).toEqual(["pause"]);
		expect(payload.released).toBe(false);

		const inner = value.readable.getReader();
		const chunk = await readWithin(inner.read(), "incoming bidi payload");
		expect(chunk.value).toEqual(new Uint8Array([1, 2, 3]));
		expect(payload.released).toBe(true);
		expect(incoming.calls).toEqual(["pause", "resume"]);
		inner.releaseLock();

		const writer = value.writable.getWriter();
		await writer.write(new Uint8Array([9]));
		expect(incoming.writes).toEqual([new Uint8Array([9])]);
		await writer.close();
		expect(incoming.calls.at(-1)).toBe("finish");
	});

	test("cancelling incomingBidirectionalStreams stops and resets queued streams", async () => {
		const scripted = scriptedSession();
		const facade = new WasmWebTransport(scripted.session);
		const first = scriptedStream(true);
		const queuedA = scriptedStream(true);
		const queuedB = scriptedStream(true);

		const reader = facade.incomingBidirectionalStreams.getReader();
		const pending = readWithin(reader.read(), "incoming bidi read");
		await Bun.sleep(1);
		scripted.pushIncoming(first.stream);
		await pending;
		// No outstanding pull: these two sit in the facade's queue.
		scripted.pushIncoming(queuedA.stream);
		scripted.pushIncoming(queuedB.stream);
		expect(queuedA.calls).toEqual([]);

		await reader.cancel();
		expect(queuedA.calls).toEqual(["stop:0", "reset:0"]);
		expect(queuedB.calls).toEqual(["stop:0", "reset:0"]);
		// The already-delivered stream is the consumer's to own.
		expect(first.calls).toEqual([]);
	});

	test("cancelling incomingUnidirectionalStreams stops queued streams without resetting them", async () => {
		const scripted = scriptedSession();
		const facade = new WasmWebTransport(scripted.session);
		const first = scriptedStream(false);
		const queued = scriptedStream(false);

		const reader = facade.incomingUnidirectionalStreams.getReader();
		const pending = readWithin(reader.read(), "incoming uni read");
		await Bun.sleep(1);
		scripted.pushIncoming(first.stream);
		await pending;
		scripted.pushIncoming(queued.stream);

		await reader.cancel();
		// A peer-opened uni stream has no send half, so only STOP_SENDING applies.
		expect(queued.calls).toEqual(["stop:0"]);
	});

	test("cancelling an incoming readable stops the wasm stream and frees retained bytes", async () => {
		const scripted = scriptedSession();
		const facade = new WasmWebTransport(scripted.session);
		const incoming = scriptedStream(false);

		const reader = facade.incomingUnidirectionalStreams.getReader();
		const pending = readWithin(reader.read(), "incoming uni read");
		await Bun.sleep(1);
		scripted.pushIncoming(incoming.stream);
		const readable = (await pending).value;
		reader.releaseLock();
		if (!readable) throw new Error("incoming uni stream missing");

		const retained = reservation(4);
		incoming.pushData(new Uint8Array([1, 2, 3, 4]), false, retained);
		await readable.cancel();
		expect(incoming.calls).toEqual(["pause", "stop:0"]);
		expect(retained.released).toBe(true);
	});
});

describe("wasm facade writable lifecycle", () => {
	test("aborting a stream writable resets with a numeric code, or 0 for other reasons", async () => {
		const numeric = scriptedStream(false);
		const other = scriptedStream(false);
		const streams = [numeric, other];
		let index = 0;
		const scripted = scriptedSession({
			openUni: () => {
				const next = streams[index++];
				if (!next) throw new Error("no scripted stream left");
				return next.stream;
			},
		});
		const facade = new WasmWebTransport(scripted.session);

		const codeWritable = await facade.createUnidirectionalStream();
		await codeWritable.getWriter().abort(9);
		expect(numeric.calls).toEqual(["reset:9"]);

		const reasonWritable = await facade.createUnidirectionalStream();
		await reasonWritable.getWriter().abort(new Error("boom"));
		expect(other.calls).toEqual(["reset:0"]);
	});

	test("an incoming readable surfaces a peer reset with the peer's code", async () => {
		const scripted = scriptedSession();
		const facade = new WasmWebTransport(scripted.session);
		const incoming = scriptedStream(false);

		const reader = facade.incomingUnidirectionalStreams.getReader();
		const pending = readWithin(reader.read(), "incoming uni read");
		await Bun.sleep(1);
		scripted.pushIncoming(incoming.stream);
		const readable = (await pending).value;
		reader.releaseLock();
		if (!readable) throw new Error("incoming uni stream missing");

		const inner = readable.getReader();
		const read = readWithin(inner.read(), "reset read").catch((e) => e);
		incoming.pushReset(77);
		const error = await read;
		expect(error).toBeInstanceOf(WebTransportError);
		expect(
			(error as WebTransportError & { streamErrorCode?: number })
				.streamErrorCode,
		).toBe(77);
	});
});

describe("wasm facade send groups", () => {
	test("datagram writables account bytes against their send group only", async () => {
		const scripted = scriptedSession();
		const facade = new WasmWebTransport(scripted.session);
		const group = facade.createSendGroup();
		const other = facade.createSendGroup();

		expect(await group.getStats()).toEqual({ bytesSent: 0 });

		const grouped = facade.datagrams.createWritable({
			sendGroup: group,
			sendOrder: 3,
		});
		const writer = grouped.getWriter();
		await writer.write(new Uint8Array([1, 2, 3]));
		await writer.write(new Uint8Array([4, 5]));
		writer.releaseLock();

		expect(scripted.sent).toEqual([
			new Uint8Array([1, 2, 3]),
			new Uint8Array([4, 5]),
		]);
		expect(await group.getStats()).toEqual({ bytesSent: 5 });
		expect(await other.getStats()).toEqual({ bytesSent: 0 });

		// The default datagram writable belongs to the implicit group 0.
		const defaultWriter = facade.datagrams.writable.getWriter();
		await defaultWriter.write(new Uint8Array([6]));
		defaultWriter.releaseLock();
		expect(await group.getStats()).toEqual({ bytesSent: 5 });
	});

	test("a unidirectional stream opened with a send group accounts its writes", async () => {
		const outgoing = scriptedStream(false);
		const scripted = scriptedSession({ openUni: () => outgoing.stream });
		const facade = new WasmWebTransport(scripted.session);
		const group = facade.createSendGroup();

		const writable = await facade.createUnidirectionalStream({
			sendGroup: group,
			sendOrder: 1,
		});
		const writer = writable.getWriter();
		await writer.write(new Uint8Array([1, 2, 3, 4]));
		writer.releaseLock();

		expect(outgoing.writes).toEqual([new Uint8Array([1, 2, 3, 4])]);
		expect(await group.getStats()).toEqual({ bytesSent: 4 });
	});

	test("send groups are rejected across transports and sendOrder must be an integer", () => {
		const facade = new WasmWebTransport(scriptedSession().session);
		const foreign = new WasmWebTransport(scriptedSession().session);

		expect(() =>
			facade.datagrams.createWritable({ sendGroup: foreign.createSendGroup() }),
		).toThrow(DOMException);
		expect(() =>
			facade.datagrams.createWritable({ sendGroup: {} as never }),
		).toThrow(/another transport/);
		expect(() => facade.datagrams.createWritable({ sendOrder: 1.5 })).toThrow(
			TypeError,
		);
	});
});

describe("wasm facade waitUntilAvailable", () => {
	test("retries a capacity failure and returns the stream once it opens", async () => {
		const opened = scriptedStream(true);
		let attempts = 0;
		const scripted = scriptedSession({
			backpressureTimeoutMs: 1_000,
			openBidi: () => {
				attempts += 1;
				if (attempts < 3) {
					throw new WebTransportError(
						E_LIMIT_EXCEEDED,
						`${E_LIMIT_EXCEEDED}: stream capacity unavailable`,
					);
				}
				return opened.stream;
			},
		});
		const facade = new WasmWebTransport(scripted.session);

		const stream = await facade.createBidirectionalStream({
			waitUntilAvailable: true,
		});
		expect(attempts).toBe(3);
		expect(stream.readable).toBeInstanceOf(ReadableStream);
	});

	test("retries a non-typed backend error whose message carries a retryable code", async () => {
		const opened = scriptedStream(false);
		let attempts = 0;
		const scripted = scriptedSession({
			backpressureTimeoutMs: 1_000,
			openUni: () => {
				attempts += 1;
				if (attempts === 1) {
					throw new Error(`${E_QUEUE_FULL}: send queue blocked`);
				}
				return opened.stream;
			},
		});
		const facade = new WasmWebTransport(scripted.session);

		await facade.createUnidirectionalStream({ waitUntilAvailable: true });
		expect(attempts).toBe(2);
	});

	test("a non-retryable open error propagates unchanged", async () => {
		const scripted = scriptedSession({
			backpressureTimeoutMs: 1_000,
			openBidi: () => {
				throw new WebTransportError(E_SESSION_CLOSED, "session gone");
			},
		});
		const facade = new WasmWebTransport(scripted.session);

		await expect(
			facade.createBidirectionalStream({ waitUntilAvailable: true }),
		).rejects.toMatchObject({ code: E_SESSION_CLOSED });
	});

	test("gives up with E_BACKPRESSURE_TIMEOUT once the configured budget elapses", async () => {
		let attempts = 0;
		const scripted = scriptedSession({
			backpressureTimeoutMs: 30,
			openBidi: () => {
				attempts += 1;
				throw new WebTransportError(
					E_LIMIT_EXCEEDED,
					`${E_LIMIT_EXCEEDED}: stream capacity unavailable`,
				);
			},
		});
		const facade = new WasmWebTransport(scripted.session);

		await expect(
			facade.createBidirectionalStream({ waitUntilAvailable: true }),
		).rejects.toMatchObject({ code: E_BACKPRESSURE_TIMEOUT });
		expect(attempts).toBeGreaterThan(1);
	});

	test("a closing session fails the wait immediately instead of spinning", async () => {
		let attempts = 0;
		const scripted = scriptedSession({
			openUni: () => {
				attempts += 1;
				throw new WebTransportError(E_LIMIT_EXCEEDED, "no capacity");
			},
		});
		const facade = new WasmWebTransport(scripted.session);
		scripted.setClosing(true);

		await expect(
			facade.createUnidirectionalStream({ waitUntilAvailable: true }),
		).rejects.toMatchObject({ code: E_SESSION_CLOSED });
		expect(attempts).toBe(0);
	});

	test("a non-boolean waitUntilAvailable is rejected as an invalid argument", async () => {
		const scripted = scriptedSession({
			openBidi: () => scriptedStream().stream,
		});
		const facade = new WasmWebTransport(scripted.session);

		await expect(
			facade.createBidirectionalStream({
				waitUntilAvailable: "yes" as unknown as boolean,
			}),
		).rejects.toMatchObject({ code: E_INVALID_ARGUMENT });
	});
});

describe("wasm facade datagram readable cancel", () => {
	test("cancelling the datagram readable releases queued reservations", async () => {
		const scripted = scriptedSession();
		const facade = new WasmWebTransport(scripted.session);

		const retained = reservation(2);
		scripted.pushDatagram(new Uint8Array([1, 2]), retained);
		expect(retained.released).toBe(false);

		await facade.datagrams.readable.cancel();
		expect(retained.released).toBe(true);
	});

	test("close(info) forwards the W3C close code and reason to the session", () => {
		const scripted = scriptedSession();
		const facade = new WasmWebTransport(scripted.session);
		facade.close({ closeCode: 7, reason: "bye" });
		expect(scripted.closeInfo).toEqual([{ code: 7, reason: "bye" }]);
	});
});
