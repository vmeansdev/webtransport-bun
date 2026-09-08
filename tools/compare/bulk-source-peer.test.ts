/**
 * Bulk-one-way server source role: chunk schedule + openUni write path.
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type {
	SendChannel,
	SendObservation,
	ServerHandle,
	ServerMetrics,
	Session,
	TransportClock,
	TransportMetrics,
} from "./adapters/transport.ts";
import { generateBulkPayload } from "./scenarios/bulk.ts";
import { bulkChunkSchedule, runBulkSourcePeer } from "./server.ts";

function frozenClock(
	startMs = 1_000,
): TransportClock & { advance(ms: number): void } {
	let now = startMs;
	return {
		nowMs: () => now,
		sleep: async () => undefined,
		method: "test.frozen",
		advance(ms: number) {
			now += ms;
		},
	};
}

function emptyMetrics(): TransportMetrics {
	return {
		attempted: 0,
		queued: 0,
		serverObserved: 0,
		acknowledged: 0,
		delivered: 0,
		refused: 0,
		dropped: 0,
		timedOut: 0,
		sessionsOpened: 1,
		sessionsClosed: 0,
		streamsOpened: 1,
		streamsAccepted: 0,
		streamsClosed: 0,
		active: true,
		queueBytes: 0,
		queueBytesPeak: 0,
		receiveQueueItems: 0,
		receiveQueueBytes: 0,
		loopUtilization: { busyMs: 1, windowMs: 10 },
		harnessOverheadBytes: 0,
		sessionsActive: 1,
		handshakesInFlight: 0,
		handshakesAttempted: 1,
		handshakesAccepted: 1,
		handshakesRejected: 0,
		streamOpenAttempts: 1,
		streamOpenAccepted: 1,
		streamOpenRejected: 0,
		datagramAttempts: 0,
		datagramAccepted: 0,
		datagramRejected: 0,
		tokenBucketRejected: 0,
	};
}

function emptyServerMetrics(): ServerMetrics {
	return {
		...emptyMetrics(),
		serverLoopUtilization: { busyMs: 1, windowMs: 10 },
	};
}

function sendObservation(bytes: number): SendObservation {
	return {
		status: 0,
		bytes,
		deliveryKind: "reliable-message",
		attempted: true,
		queued: true,
		serverObserved: false,
		acknowledged: false,
		delivered: false,
	};
}

describe("bulkChunkSchedule", () => {
	test("ceil(bytes / chunkBytes)", () => {
		expect(bulkChunkSchedule(100, 64).chunkCount).toBe(2);
		expect(bulkChunkSchedule(65_536 * 4, 65_536).chunkCount).toBe(4);
		expect(bulkChunkSchedule(104_857_600, 65_536).chunkCount).toBe(1_600);
	});

	test("rejects non-positive inputs", () => {
		expect(() => bulkChunkSchedule(0, 64)).toThrow(RangeError);
		expect(() => bulkChunkSchedule(100, 0)).toThrow(RangeError);
	});
});

/** The one-session server a bulk source accepts, over a caller's channel. */
function sourceServerOver(channel: SendChannel): ServerHandle {
	const session: Session = {
		role: "server",
		async sendMessage() {
			throw new Error("unused");
		},
		async receiveMessage() {
			throw new Error("unused");
		},
		async sendText() {
			throw new Error("unused");
		},
		async openUni() {
			return channel;
		},
		async acceptUni() {
			throw new Error("source peer opens, does not accept");
		},
		async openBidi() {
			throw new Error("unused");
		},
		async acceptBidi() {
			throw new Error("unused");
		},
		async close() {},
		snapshot: emptyMetrics,
	};
	return {
		async acceptSession() {
			return session;
		},
		async stop() {},
		snapshot: emptyServerMetrics,
	};
}

describe("runBulkSourcePeer", () => {
	test("opens uni and writes patterned chunks matching generateBulkPayload", async () => {
		const clock = frozenClock();
		const bytes = 65_536 * 2;
		const chunkBytes = 65_536;
		const written: Uint8Array[] = [];
		let ended = false;
		const channel: SendChannel = {
			channelId: 1,
			async write(chunk) {
				written.push(new Uint8Array(chunk));
				clock.advance(1);
				return sendObservation(chunk.byteLength);
			},
			async end() {
				ended = true;
			},
		};

		const result = await runBulkSourcePeer({
			server: sourceServerOver(channel),
			bytes,
			chunkBytes,
			clock,
			acceptTimeoutMs: 1_000,
			writeTimeoutMs: 1_000,
		});

		expect(result.chunksWritten).toBe(2);
		expect(result.bytesWritten).toBe(bytes);
		expect(ended).toBe(true);
		expect(written).toHaveLength(2);
		expect(written[0]![0]).toBe(1);
		expect(written[1]![0]).toBe(2);

		const hasher = createHash("sha256");
		for (const chunk of written) hasher.update(chunk);
		expect(hasher.digest("hex")).toBe(
			generateBulkPayload(bytes, chunkBytes).digest,
		);
	});

	/**
	 * The eighth A5 campaign refused `bulk-one-way/physical/wt` at the rig's
	 * capture -- `CHILD_LIFECYCLE: server capture ack` -- and
	 * `phase-a-capture-real-process.test.ts` reproduces it in roughly one wt
	 * run in twenty with `bulk transfer: E_STREAM_RESET`.
	 *
	 * The mechanism is here: `end()` issues the stream FIN and then waits for
	 * the receiver to acknowledge it, and the bulk receiver reads that FIN,
	 * verifies the payload and closes its session in the same turn
	 * (`client.ts` `measureLegOverAdapter`'s `finally`). When its delayed ACK
	 * loses that race there is nobody left to acknowledge anything, and the
	 * wait ends in the connection loss the adapter reports as
	 * `E_STREAM_RESET`.
	 */
	test("a receiver that vanishes after taking the whole stream has not failed the transfer", async () => {
		const clock = frozenClock();
		const bytes = 65_536 * 2;
		const written: Uint8Array[] = [];
		const channel: SendChannel = {
			channelId: 1,
			async write(chunk) {
				written.push(new Uint8Array(chunk));
				return sendObservation(chunk.byteLength);
			},
			async end() {
				throw new Error("E_STREAM_RESET");
			},
		};

		const result = await runBulkSourcePeer({
			server: sourceServerOver(channel),
			bytes,
			chunkBytes: 65_536,
			clock,
			acceptTimeoutMs: 1_000,
			writeTimeoutMs: 1_000,
		});

		expect(result.bytesWritten).toBe(bytes);
		expect(result.chunksWritten).toBe(2);
		expect(result.payloadSha256).toBe(
			generateBulkPayload(bytes, 65_536).digest,
		);
		expect(written).toHaveLength(2);
	});

	/**
	 * The other half of the same discrimination: a receiver that refuses the
	 * remainder sends STOP_SENDING, which arrives as `E_STOP_SENDING` and is a
	 * real failure -- it says the peer did not take what was written.
	 */
	test("a receiver that refuses the stream still fails the transfer", async () => {
		const clock = frozenClock();
		const channel: SendChannel = {
			channelId: 1,
			async write(chunk) {
				return sendObservation(chunk.byteLength);
			},
			async end() {
				throw new Error("E_STOP_SENDING: peer stopped the stream");
			},
		};

		await expect(
			runBulkSourcePeer({
				server: sourceServerOver(channel),
				bytes: 65_536 * 2,
				chunkBytes: 65_536,
				clock,
				acceptTimeoutMs: 1_000,
				writeTimeoutMs: 1_000,
			}),
		).rejects.toThrow("E_STOP_SENDING");
	});

	/**
	 * The tolerance is on the end of a *complete* write and nowhere else: a
	 * reset that arrives while scheduled bytes are still outstanding fails one
	 * of the `write` awaits, and that transfer really did not run.
	 */
	test("a reset with bytes still outstanding fails the transfer", async () => {
		const clock = frozenClock();
		let writes = 0;
		const channel: SendChannel = {
			channelId: 1,
			async write(chunk) {
				writes += 1;
				if (writes === 2) throw new Error("E_STREAM_RESET");
				return sendObservation(chunk.byteLength);
			},
			async end() {
				throw new Error("end must not be reached");
			},
		};

		await expect(
			runBulkSourcePeer({
				server: sourceServerOver(channel),
				bytes: 65_536 * 2,
				chunkBytes: 65_536,
				clock,
				acceptTimeoutMs: 1_000,
				writeTimeoutMs: 1_000,
			}),
		).rejects.toThrow("E_STREAM_RESET");
	});
});
