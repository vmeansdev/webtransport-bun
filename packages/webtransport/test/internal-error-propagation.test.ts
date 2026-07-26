import { describe, expect, it } from "bun:test";
import { Duplex } from "node:stream";
import {
	E_INTERNAL,
	E_BACKPRESSURE_TIMEOUT,
	E_HANDSHAKE_TIMEOUT,
	E_INVALID_ARGUMENT,
	E_LIMIT_EXCEEDED,
	E_RATE_LIMITED,
	E_QUEUE_FULL,
	E_SESSION_CLOSED,
	E_SESSION_IDLE_TIMEOUT,
	E_STOP_SENDING,
	E_STREAM_RESET,
	E_TLS,
	E_UNSUPPORTED_ARGUMENT,
	WebTransport,
	WebTransportError,
} from "../src/index.js";
import { __TESTING__ } from "../src/internal.js";
import { nextWithTimeout, readWithTimeout } from "./helpers/harness.js";

describe("internal TS error propagation", () => {
	it("native error parser only recognizes enumerated stable codes", async () => {
		expect(__TESTING__.nativeErrorCodes).toEqual([
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
			E_INVALID_ARGUMENT,
			E_UNSUPPORTED_ARGUMENT,
			E_INTERNAL,
		]);

		const session = __TESTING__.createNativeClientSessionForTests({
			sendDatagram: async () => {
				throw new Error("E_HANDSHAKE_TIMEOUTX: not a real code");
			},
			close: () => {},
		});
		await expect(
			session.sendDatagram(new Uint8Array([1])),
		).rejects.toMatchObject({
			code: E_INTERNAL,
		});
	});

	it("native error parser prefers explicit err.code when present", async () => {
		const wrapped = new Error("not a real code message");
		(wrapped as { code: string }).code = "E_HANDSHAKE_TIMEOUT";
		const session = __TESTING__.createNativeClientSessionForTests({
			sendDatagram: async () => {
				throw wrapped;
			},
			close: () => {},
		});
		await expect(
			session.sendDatagram(new Uint8Array([1])),
		).rejects.toMatchObject({
			code: E_HANDSHAKE_TIMEOUT,
			message: "not a real code message",
		});
	});

	it("NativeClientSession.incomingDatagrams propagates non-close errors", async () => {
		const session = __TESTING__.createNativeClientSessionForTests({
			readDatagram: async () => {
				throw new Error("E_INTERNAL: synthetic datagram failure");
			},
			close: () => {},
		});
		const iter = session.incomingDatagrams()[Symbol.asyncIterator]();
		let err: unknown;
		try {
			await nextWithTimeout(iter, 2000, "datagram error propagation read");
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(WebTransportError);
		expect((err as WebTransportError).code).toBe(E_INTERNAL);
	});

	it("NativeClientSession.incomingDatagrams treats session-close errors as EOF", async () => {
		const session = __TESTING__.createNativeClientSessionForTests({
			readDatagram: async () => {
				throw new Error(`${E_SESSION_CLOSED}: closed`);
			},
			close: () => {},
		});
		const iter = session.incomingDatagrams()[Symbol.asyncIterator]();
		const first = await nextWithTimeout(
			iter,
			2000,
			"session-close datagram EOF read",
		);
		expect(first.done).toBe(true);
	});

	it("NativeClientSession.incomingBidirectionalStreams propagates non-close errors", async () => {
		const session = __TESTING__.createNativeClientSessionForTests({
			acceptBidiStream: async () => {
				throw new Error("E_INTERNAL: synthetic bidi accept failure");
			},
			close: () => {},
		});
		const iter = session.incomingBidirectionalStreams()[Symbol.asyncIterator]();
		let err: unknown;
		try {
			await nextWithTimeout(iter, 2000, "bidi accept error propagation read");
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(WebTransportError);
		expect((err as WebTransportError).code).toBe(E_INTERNAL);
	});

	it("NativeClientSession.incomingUnidirectionalStreams treats idle-timeout close as EOF", async () => {
		const session = __TESTING__.createNativeClientSessionForTests({
			acceptUniStream: async () => {
				throw new Error(`${E_SESSION_IDLE_TIMEOUT}: idle timeout`);
			},
			close: () => {},
		});
		const iter = session
			.incomingUnidirectionalStreams()
			[Symbol.asyncIterator]();
		const first = await nextWithTimeout(
			iter,
			2000,
			"idle-timeout uni EOF read",
		);
		expect(first.done).toBe(true);
	});

	it("server incoming bidi stream wrapper errors controller on non-close failures", async () => {
		const readable = __TESTING__.createServerIncomingBidiStreamsForTests(
			{
				acceptBidiStream: async () => {
					throw new Error("E_INTERNAL: synthetic server bidi accept failure");
				},
			},
			() => false,
		);
		const reader = readable.getReader();
		await expect(
			readWithTimeout(
				reader,
				2000,
				"server incoming bidi error propagation read",
			),
		).rejects.toMatchObject({ code: E_INTERNAL });
	});

	it("server incoming uni stream wrapper closes on session-closed failure", async () => {
		const readable = __TESTING__.createServerIncomingUniStreamsForTests(
			{
				acceptUniStream: async () => {
					throw new Error(`${E_SESSION_CLOSED}: closed`);
				},
			},
			() => false,
		);
		const reader = readable.getReader();
		const result = await readWithTimeout(
			reader,
			2000,
			"server incoming uni EOF read",
		);
		expect(result.done).toBe(true);
	});

	it("Web Streams adapters apply strictW3CErrors to stream write failures", async () => {
		const duplex = new Duplex({
			read() {},
			write(_chunk, _encoding, callback) {
				callback(new Error(`${E_STOP_SENDING}: peer stopped`));
			},
		});
		const closed = new Promise<{ code?: number; reason?: string }>(() => {});
		const session = {
			id: "wrapped",
			peer: { ip: "127.0.0.1", port: 4433 },
			ready: Promise.resolve(),
			closed,
			close() {},
			sendDatagram: async () => {},
			async *incomingDatagrams() {},
			createBidirectionalStream: async () => duplex,
			async *incomingBidirectionalStreams() {},
			createUnidirectionalStream: async () => duplex,
			async *incomingUnidirectionalStreams() {},
			metricsSnapshot: () => ({
				datagramsIn: 0,
				datagramsOut: 0,
				streamsActive: 0,
				queuedBytes: 0,
			}),
		};
		const wt = new WebTransport(session, { strictW3CErrors: true });
		const bidi = await wt.createBidirectionalStream();
		const writer = bidi.writable.getWriter();
		await expect(writer.write(new Uint8Array([1]))).rejects.toMatchObject({
			code: E_STOP_SENDING,
			name: "AbortError",
		});
	});
});
