import { describe, expect, it } from "bun:test";
import { once } from "node:events";
import { E_INTERNAL, WebTransportError } from "../src/index.js";
import { __TESTING__ } from "../src/internal.js";
import { BidiStream, RecvStream } from "../src/streams.js";
import { nextWithTimeout, readWithTimeout } from "./helpers/harness.js";

describe("native payload ownership boundary", () => {
	const nextNodeChunk = async (stream: BidiStream | RecvStream) => {
		const result = await Promise.race([
			once(stream, "data").then(([chunk]) => chunk as Buffer),
			Bun.sleep(2_000).then(() => {
				throw new Error("timed out waiting for Node stream payload");
			}),
		]);
		return result;
	};

	it("prefers the engine-owned datagram method over the legacy Buffer method", async () => {
		const session = __TESTING__.createNativeClientSessionForTests({
			readDatagramOwned: async () => new Uint8Array([1, 2, 3]),
			readDatagram: async () => {
				throw new Error("legacy read must not run");
			},
			close: () => {},
		});

		const iter = session.incomingDatagrams()[Symbol.asyncIterator]();
		const first = await nextWithTimeout(iter, 2_000, "owned datagram read");
		expect(first.done).toBe(false);
		expect(first.value).toEqual(new Uint8Array([1, 2, 3]));
	});

	it("preserves a zero-length datagram instead of treating it as EOF", async () => {
		let reads = 0;
		const session = __TESTING__.createNativeClientSessionForTests({
			readDatagramOwned: async () => (reads++ === 0 ? new Uint8Array(0) : null),
			close: () => {},
		});

		const iter = session.incomingDatagrams()[Symbol.asyncIterator]();
		const first = await nextWithTimeout(iter, 2_000, "empty datagram read");
		expect(first.done).toBe(false);
		expect(first.value).toBeInstanceOf(Uint8Array);
		expect(first.value?.byteLength).toBe(0);
		const eof = await nextWithTimeout(iter, 2_000, "datagram EOF read");
		expect(eof.done).toBe(true);
	});

	it("fails closed when a production-like handle lacks owned payload methods", async () => {
		const session = __TESTING__.createNativeClientSessionForTests(
			{
				readDatagram: async () => Buffer.from([9]),
				close: () => {},
			},
			false,
			{ legacyPayloadReads: false },
		);

		const iter = session.incomingDatagrams()[Symbol.asyncIterator]();
		let thrown: unknown;
		try {
			await nextWithTimeout(iter, 2_000, "mismatched addon read");
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(WebTransportError);
		expect((thrown as WebTransportError).code).toBe(E_INTERNAL);
		expect((thrown as Error).message).toContain("payload ownership");
	});

	it("copies legacy payloads only for explicit test-double sessions", async () => {
		const source = Buffer.from([4, 5, 6]);
		const session = __TESTING__.createNativeClientSessionForTests({
			readDatagram: async () => source,
			close: () => {},
		});

		const iter = session.incomingDatagrams()[Symbol.asyncIterator]();
		const first = await nextWithTimeout(iter, 2_000, "legacy test read");
		expect(first.done).toBe(false);
		expect(first.value).toBeInstanceOf(Uint8Array);
		expect(first.value).not.toBe(source);
		source[0] = 99;
		expect(first.value).toEqual(new Uint8Array([4, 5, 6]));
	});

	it("Node bidi streams prefer the engine-owned read method", async () => {
		const stream = new BidiStream({
			handleId: 1,
			nativeHandle: {
				readOwned: async () => new Uint8Array([10, 11]),
				read: async () => {
					throw new Error("legacy stream read must not run");
				},
				write: async () => {},
				finish: () => {},
				dispose: () => {},
			},
		});

		const chunk = await nextNodeChunk(stream);
		expect(chunk).toEqual(Buffer.from([10, 11]));
		stream.destroy();
	});

	it("Node receive streams prefer the engine-owned read method", async () => {
		const stream = new RecvStream({
			handleId: 2,
			nativeHandle: {
				readOwned: async () => new Uint8Array([12, 13]),
				read: async () => {
					throw new Error("legacy stream read must not run");
				},
				dispose: () => {},
			},
		});

		const chunk = await nextNodeChunk(stream);
		expect(chunk).toEqual(Buffer.from([12, 13]));
		stream.destroy();
	});

	it("server Web Streams bidi reads use engine-owned payloads", async () => {
		let accepted = false;
		let reads = 0;
		const incoming = __TESTING__.createServerIncomingBidiStreamsForTests(
			{
				acceptBidiStream: async () => {
					if (accepted) return null;
					accepted = true;
					return {
						id: 3,
						readOwned: async () =>
							reads++ === 0 ? new Uint8Array([20, 21]) : null,
						read: async () => {
							throw new Error("legacy Web Stream read must not run");
						},
						write: async () => {},
						finish: () => {},
						dispose: () => {},
					};
				},
			},
			() => false,
		);
		const acceptedResult = await readWithTimeout(
			incoming.getReader(),
			2_000,
			"owned server bidi accept",
		);
		expect(acceptedResult.done).toBe(false);
		if (acceptedResult.done || !acceptedResult.value)
			throw new Error("missing accepted bidi stream");
		const payload = await readWithTimeout(
			acceptedResult.value.readable.getReader(),
			2_000,
			"owned server bidi payload",
		);
		expect(payload.value).toEqual(new Uint8Array([20, 21]));
	});

	it("server Web Streams uni reads use engine-owned payloads", async () => {
		let accepted = false;
		let reads = 0;
		const incoming = __TESTING__.createServerIncomingUniStreamsForTests(
			{
				acceptUniStream: async () => {
					if (accepted) return null;
					accepted = true;
					return {
						id: 4,
						readOwned: async () =>
							reads++ === 0 ? new Uint8Array([22, 23]) : null,
						read: async () => {
							throw new Error("legacy Web Stream read must not run");
						},
						dispose: () => {},
					};
				},
			},
			() => false,
		);
		const acceptedResult = await readWithTimeout(
			incoming.getReader(),
			2_000,
			"owned server uni accept",
		);
		expect(acceptedResult.done).toBe(false);
		if (acceptedResult.done || !acceptedResult.value)
			throw new Error("missing accepted uni stream");
		const payload = await readWithTimeout(
			acceptedResult.value.getReader(),
			2_000,
			"owned server uni payload",
		);
		expect(payload.value).toEqual(new Uint8Array([22, 23]));
	});
});
