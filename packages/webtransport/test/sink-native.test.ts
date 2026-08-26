/**
 * Native stream sink (RFC_STREAM_SINK): TS surface over the phase-3 napi
 * layer. Covers the cross-language golden vector (reader side), raw and
 * framed end-to-end delivery through a Worker-hosted SinkReader, the
 * ownership error paths, and close().
 */

import { describe, expect, it } from "bun:test";
import { createServer, openReadSink } from "../src/index.js";
import {
	SINK_DATA_OFFSET,
	type StreamSinkDescriptor,
} from "../src/sink-layout.js";
import { SinkReader, type SinkRecord } from "../src/sink-reader.js";
import type { StreamSinkHandle, StreamSinkOptions } from "../src/sink.js";
import { nextWithTimeout } from "./helpers/harness.js";
import { connectWithRetry, nextPort } from "./helpers/network.js";

/** Byte-exact dump pinned by stream_sink.rs golden_vector_layout_v1. */
const GOLDEN_HEX =
	"4b535457010000000004000005000000c00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000900000000100000000000000000000000000000000000000900000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000028000000010000000807060504030201000000000000000005000000000000000708090a0b000000480000000200000018171615141312110500000000000000280000000000000008090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f200000000500000028272625242322212d00000000000000000000004d00000000000000000000000000000000000000";

function patterned(seq: number, len: number): Uint8Array {
	const out = new Uint8Array(len);
	for (let i = 0; i < len; i++) out[i] = (seq + i) % 251;
	return out;
}

function drainInWorker(
	handle: StreamSinkHandle,
	deadlineMs: number,
): Promise<{ records: SinkRecord[]; endState: string }> {
	const worker = new Worker(
		new URL("./helpers/sink-worker.ts", import.meta.url).href,
	);
	return new Promise((resolve, reject) => {
		worker.onmessage = (event) => {
			worker.terminate();
			resolve(event.data as { records: SinkRecord[]; endState: string });
		};
		worker.onerror = (event) => {
			worker.terminate();
			reject(new Error(`sink worker failed: ${event.message}`));
		};
		worker.postMessage({
			sab: handle.buffer,
			descriptor: handle.descriptor,
			deadlineMs,
		});
	});
}

function concatData(records: SinkRecord[]): Buffer {
	return Buffer.concat(
		records
			.filter((r) => r.type === "data" || r.type === "message")
			.map((r) => Buffer.from(r.payload)),
	);
}

describe("native stream sink (RFC_STREAM_SINK)", () => {
	it("SinkReader parses the layout-v1 golden vector byte-for-byte", () => {
		const dump = Buffer.from(GOLDEN_HEX, "hex");
		// The golden dump covers the header plus the first 160 data bytes;
		// give the reader the full 1 KiB ring the vector was written into.
		const sab = new SharedArrayBuffer(SINK_DATA_OFFSET + 1024);
		new Uint8Array(sab).set(dump);
		const descriptor: StreamSinkDescriptor = {
			version: 1,
			dataCapacity: 1024,
			flags: dump.readUInt32LE(12),
			clock: "wall",
			monotonicAnchorUs: 0,
			wallAnchorUs: 0,
			framing: null,
		};
		const reader = new SinkReader(descriptor, sab);

		const first = reader.next(50);
		expect(first?.type).toBe("data");
		expect(first?.timestampNs).toBe(0x0102030405060708n);
		expect(first?.streamOffset).toBe(0n);
		expect(Buffer.from(first?.payload ?? [])).toEqual(
			Buffer.from(patterned(7, 5)),
		);

		const second = reader.next(50);
		expect(second?.type).toBe("message");
		expect(second?.streamOffset).toBe(5n);
		expect(Buffer.from(second?.payload ?? [])).toEqual(
			Buffer.from(patterned(8, 40)),
		);

		const terminal = reader.next(50);
		expect(terminal?.type).toBe("reset");
		expect(terminal?.code).toBe(77);
		expect(reader.state).toBe("ended");
		expect(reader.next(10)).toBeNull();
	});

	it("delivers a raw byte stream through the ring with an EOF terminal", async () => {
		const port = nextPort(24980, 500);
		const payloads = [
			Buffer.from("sink-raw-alpha"),
			Buffer.alloc(4096, 3),
			Buffer.from("tail"),
		];
		const sunk = Promise.withResolvers<StreamSinkHandle>();
		const server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			onSession: async (session) => {
				const stream = await nextWithTimeout(
					session.incomingBidirectionalStreams[Symbol.asyncIterator](),
					5000,
					"sink raw accept",
				);
				if (stream.done) throw new Error("no incoming stream");
				sunk.resolve(openReadSink(stream.value as never, { ringBytes: 65536 }));
			},
		});
		const client = await connectWithRetry(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
		});
		try {
			const out = await client.createBidirectionalStream();
			for (const p of payloads) {
				out.write(p);
				await Bun.sleep(10);
			}
			out.end();
			const handle = await sunk.promise;
			const { records, endState } = await drainInWorker(handle, 10_000);
			expect(endState).toBe("ended");
			expect(records.at(-1)?.type).toBe("eof");
			expect(concatData(records)).toEqual(Buffer.concat(payloads));
			// Contiguous stream offsets, starting at zero.
			let offset = 0n;
			for (const record of records) {
				expect(record.streamOffset).toBe(offset);
				offset += BigInt(record.payload.length);
			}
			const stats = handle.stats();
			expect(stats.state).toBe("eof");
			expect(stats.bytesIn).toBe(Buffer.concat(payloads).length);
			await handle.close();
		} finally {
			client.close();
			await server.close();
		}
	});

	it("cuts per-message records with a framing descriptor across write splits", async () => {
		const port = nextPort(25520, 500);
		const frames = [patterned(1, 24), patterned(2, 300), patterned(3, 0)].map(
			(payload) => {
				const frame = Buffer.alloc(4 + payload.length);
				frame.writeUInt16LE(payload.length, 0);
				frame.set(payload, 4);
				return frame;
			},
		);
		const wire = Buffer.concat(frames);
		const sunk = Promise.withResolvers<StreamSinkHandle>();
		const framingOpts: StreamSinkOptions = {
			ringBytes: 65536,
			framing: {
				headerBytes: 4,
				lengthOffset: 0,
				lengthWidth: 2,
				lengthIncludesHeader: false,
				maxFrameBytes: 4096,
			},
		};
		const server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			onSession: async (session) => {
				const stream = await nextWithTimeout(
					session.incomingBidirectionalStreams[Symbol.asyncIterator](),
					5000,
					"sink framed accept",
				);
				if (stream.done) throw new Error("no incoming stream");
				sunk.resolve(openReadSink(stream.value as never, framingOpts));
			},
		});
		const client = await connectWithRetry(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
		});
		try {
			const out = await client.createBidirectionalStream();
			// Split the wire at an offset that lands inside frame 2.
			out.write(wire.subarray(0, 40));
			await Bun.sleep(20);
			out.write(wire.subarray(40));
			out.end();
			const handle = await sunk.promise;
			const { records } = await drainInWorker(handle, 10_000);
			const messages = records.filter((r) => r.type === "message");
			expect(messages.length).toBe(frames.length);
			for (const [i, frame] of frames.entries()) {
				// MESSAGE payloads are the full frame, header included.
				expect(Buffer.from(messages[i]!.payload)).toEqual(frame);
			}
			expect(records.at(-1)?.type).toBe("eof");
			await handle.close();
		} finally {
			client.close();
			await server.close();
		}
	});

	it("enforces the one-way ownership contract", async () => {
		const port = nextPort(26060, 500);
		const scenario = Promise.withResolvers<void>();
		const server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			onSession: async (session) => {
				try {
					const stream = await nextWithTimeout(
						session.incomingBidirectionalStreams[Symbol.asyncIterator](),
						5000,
						"sink ownership accept",
					);
					if (stream.done) throw new Error("no incoming stream");
					const pair = stream.value as never as {
						readable: ReadableStream<Uint8Array>;
						openReadSink(opts?: StreamSinkOptions): StreamSinkHandle;
					};
					const handle = pair.openReadSink({ ringBytes: 65536 });
					// Second open rejects in-band at the native layer.
					expect(() => pair.openReadSink({ ringBytes: 65536 })).toThrow(
						"E_SINK_ALREADY_OPEN",
					);
					// A facade read on a sink-owned stream errors with the
					// sink code.
					const reader = pair.readable.getReader();
					let readError: Error | null = null;
					try {
						await reader.read();
					} catch (err) {
						readError = err as Error;
					}
					expect(readError?.message ?? "").toContain("E_SINK_ACTIVE");
					await handle.close();
					scenario.resolve();
				} catch (err) {
					scenario.reject(err as Error);
				}
			},
		});
		const client = await connectWithRetry(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
		});
		try {
			const out = await client.createBidirectionalStream();
			out.write(Buffer.from("ownership"));
			await scenario.promise;
			out.end();
		} finally {
			client.close();
			await server.close();
		}
	});

	it("rejects a sink once facade reading has started", async () => {
		const port = nextPort(26600, 500);
		const scenario = Promise.withResolvers<void>();
		const server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			onSession: async (session) => {
				try {
					const stream = await nextWithTimeout(
						session.incomingBidirectionalStreams[Symbol.asyncIterator](),
						5000,
						"sink after-read accept",
					);
					if (stream.done) throw new Error("no incoming stream");
					const pair = stream.value as never as {
						readable: ReadableStream<Uint8Array>;
						openReadSink(opts?: StreamSinkOptions): StreamSinkHandle;
					};
					// Start facade consumption, then attempt a sink.
					const reader = pair.readable.getReader();
					const first = await reader.read();
					expect(first.done).toBe(false);
					expect(() => pair.openReadSink({ ringBytes: 65536 })).toThrow(
						"E_SINK_READ_ACTIVE",
					);
					scenario.resolve();
				} catch (err) {
					scenario.reject(err as Error);
				}
			},
		});
		const client = await connectWithRetry(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
		});
		try {
			const out = await client.createBidirectionalStream();
			out.write(Buffer.from("read-first"));
			await scenario.promise;
			out.end();
		} finally {
			client.close();
			await server.close();
		}
	});

	it("close() ends an idle sink with an E_SINK_CLOSED terminal", async () => {
		const port = nextPort(27140, 500);
		const sunk = Promise.withResolvers<StreamSinkHandle>();
		const server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			onSession: async (session) => {
				const stream = await nextWithTimeout(
					session.incomingBidirectionalStreams[Symbol.asyncIterator](),
					5000,
					"sink close accept",
				);
				if (stream.done) throw new Error("no incoming stream");
				sunk.resolve(openReadSink(stream.value as never, { ringBytes: 65536 }));
			},
		});
		const client = await connectWithRetry(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
		});
		try {
			const out = await client.createBidirectionalStream();
			out.write(Buffer.from("kept-open"));
			const handle = await sunk.promise;
			// Let the first chunk land, then close while the wire stays open.
			await Bun.sleep(150);
			await handle.close();
			const { records } = await drainInWorker(handle, 3_000);
			const terminal = records.at(-1);
			expect(terminal?.type).toBe("error");
			expect(terminal?.code).toBe("E_SINK_CLOSED");
			expect(handle.stats().state).toBe("closed");
			// close() is idempotent.
			await handle.close();
			out.end();
		} finally {
			client.close();
			await server.close();
		}
	});
});
