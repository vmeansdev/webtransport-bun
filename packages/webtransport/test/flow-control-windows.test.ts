import { describe, expect, test } from "bun:test";
import {
	__TESTING__,
	connect,
	createServer,
	DEFAULT_LIMITS,
} from "../src/index.js";
import { nextPort } from "./helpers/network.ts";

// The QUIC windows used to be a pure function of the application byte
// governors (transport_memory.rs): widening a window meant widening
// maxQueuedBytesPerSession, which also loosened backpressure and grew the
// datagram channel. The explicit window fields decouple the two. They are
// opt-in: absent, every derivation is exactly what shipped.

async function drainOneUniStream(
	limits: Parameters<typeof createServer>[0]["limits"],
	payload: Uint8Array,
): Promise<number> {
	const port = nextPort(29650, 500);
	let resolveTotal: (n: number) => void = () => {};
	let rejectTotal: (e: unknown) => void = () => {};
	const total = new Promise<number>((res, rej) => {
		resolveTotal = res;
		rejectTotal = rej;
	});

	const server = createServer({
		port,
		host: "127.0.0.1",
		tls: { certPem: "", keyPem: "" },
		limits,
		onSession: (session) => {
			void (async () => {
				try {
					const reader = session.incomingUnidirectionalStreams.getReader();
					const first = await reader.read();
					if (first.done) throw new Error("no incoming stream");
					const body = first.value.getReader();
					let received = 0;
					while (true) {
						const chunk = await body.read();
						if (chunk.done) break;
						received += chunk.value.byteLength;
					}
					resolveTotal(received);
				} catch (err) {
					rejectTotal(err);
				}
			})();
		},
	});

	const client = await connect(`https://127.0.0.1:${port}`, {
		tls: { insecureSkipVerify: true },
		limits,
	});
	try {
		const stream = await client.createUnidirectionalStream();
		// Written in chunks below maxQueuedBytesPerStream: the send-side byte
		// governor is deliberately NOT decoupled, so a single write larger than
		// it still blocks. The windows are what these tests move.
		const CHUNK = 64 * 1024;
		for (let off = 0; off < payload.byteLength; off += CHUNK) {
			const slice = payload.subarray(
				off,
				Math.min(off + CHUNK, payload.byteLength),
			);
			await new Promise<void>((res, rej) =>
				stream.write(slice, (e: Error | null | undefined) =>
					e ? rej(e) : res(),
				),
			);
		}
		await new Promise<void>((res, rej) =>
			stream.end((e?: Error | null) => (e ? rej(e) : res())),
		);
		return await total;
	} finally {
		client.close();
		await server.close();
	}
}

describe("explicit flow-control windows", () => {
	test("are absent from the defaults, so the shipped config is unchanged", () => {
		expect("streamReceiveWindow" in DEFAULT_LIMITS).toBe(false);
		expect("receiveWindow" in DEFAULT_LIMITS).toBe(false);
		expect("sendWindow" in DEFAULT_LIMITS).toBe(false);
		// The governors they decouple from keep their AGENTS.md values.
		expect(DEFAULT_LIMITS.maxQueuedBytesPerSession).toBe(2 * 1024 * 1024);
		expect(DEFAULT_LIMITS.maxQueuedBytesPerStream).toBe(256 * 1024);
	});

	test("reach the transport under the names the public options use", () => {
		const derived = __TESTING__.transportWindowsForLimitsForTests();
		expect(derived).toBeDefined();
		// The shipped derivation, unchanged: 256 KiB / 2 MiB / 2 MiB, and a
		// datagram channel of ceil(2 MiB / 1200) slots.
		expect(derived?.streamReceiveWindow).toBe(256 * 1024);
		expect(derived?.receiveWindow).toBe(2 * 1024 * 1024);
		expect(derived?.sendWindow).toBe(2 * 1024 * 1024);
		expect(derived?.datagramChannelCapacity).toBe(1748);

		const explicit = __TESTING__.transportWindowsForLimitsForTests({
			streamReceiveWindow: 8 * 1024 * 1024,
			receiveWindow: 32 * 1024 * 1024,
			sendWindow: 4 * 1024 * 1024,
		});
		expect(explicit?.streamReceiveWindow).toBe(8 * 1024 * 1024);
		expect(explicit?.receiveWindow).toBe(32 * 1024 * 1024);
		expect(explicit?.sendWindow).toBe(4 * 1024 * 1024);
		// The decoupling claim: 32× the connection window, same governors, so
		// the datagram channel does not move with it.
		expect(explicit?.datagramChannelCapacity).toBe(1748);

		// And the governor route still works on its own — raising
		// maxQueuedBytesPerSession lifts the derived windows exactly as before.
		const governed = __TESTING__.transportWindowsForLimitsForTests({
			maxQueuedBytesPerSession: 64 * 1024 * 1024,
			maxQueuedBytesPerStream: 8 * 1024 * 1024,
		});
		expect(governed?.streamReceiveWindow).toBe(8 * 1024 * 1024);
		expect(governed?.receiveWindow).toBe(64 * 1024 * 1024);
		expect(governed?.datagramChannelCapacity).toBe(2048);
	});

	test("a window widened past the governors carries a full payload", async () => {
		const payload = new Uint8Array(1024 * 1024);
		payload.fill(0x5a);
		const received = await drainOneUniStream(
			{
				// 8 MiB of stream window on top of the shipped 256 KiB governor:
				// before decoupling this needed maxQueuedBytesPerSession at 64 MiB.
				streamReceiveWindow: 8 * 1024 * 1024,
				receiveWindow: 32 * 1024 * 1024,
				sendWindow: 32 * 1024 * 1024,
			},
			payload,
		);
		expect(received).toBe(payload.byteLength);
	}, 30_000);

	test("a window narrowed below the governors paces rather than stalls", async () => {
		const payload = new Uint8Array(256 * 1024);
		payload.fill(0x3c);
		const received = await drainOneUniStream(
			{
				// Deliberately smaller than maxQueuedBytesPerStream: the peer now
				// has to wait for MAX_STREAM_DATA to send the tail. Delivery must
				// still complete — a window that deadlocks is the failure this
				// pins.
				streamReceiveWindow: 16 * 1024,
				receiveWindow: 64 * 1024,
				sendWindow: 64 * 1024,
			},
			payload,
		);
		expect(received).toBe(payload.byteLength);
	}, 30_000);
});
