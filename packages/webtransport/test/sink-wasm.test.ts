/**
 * Wasm-side sink producer (RFC_STREAM_SINK §7): the TS RingWriter is pinned
 * to the Rust writer's golden vector, and openWasmReadSink is driven end to
 * end over a mock wasm stream (the real WasmStream exposes the same
 * onData/onReset/pause/resume/stop slice).
 */

import { describe, expect, it } from "bun:test";
import {
	FLAG_CLOCK_WALL,
	FLAG_FRAMING,
	REC_DATA,
	REC_MESSAGE,
	REC_RESET,
	SINK_DATA_OFFSET,
	type StreamSinkDescriptor,
} from "../src/sink-layout.js";
import { SinkReader, type SinkRecord } from "../src/sink-reader.js";
import { FrameCutter, RingWriter } from "../src/sink-ring-writer.js";
import { openWasmReadSink, type WasmSinkStream } from "../src/wasm-sink.js";

/** Byte-exact dump pinned by stream_sink.rs golden_vector_layout_v1. */
const GOLDEN_HEX =
	"4b535457010000000004000005000000c00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000900000000100000000000000000000000000000000000000900000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000028000000010000000807060504030201000000000000000005000000000000000708090a0b000000480000000200000018171615141312110500000000000000280000000000000008090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f200000000500000028272625242322212d00000000000000000000004d00000000000000000000000000000000000000";

function patterned(seq: number, len: number): Uint8Array {
	const out = new Uint8Array(len);
	for (let i = 0; i < len; i++) out[i] = (seq + i) % 251;
	return out;
}

class MockWasmStream implements WasmSinkStream {
	dataCb:
		| ((
				data: Uint8Array,
				fin: boolean,
				reservation?: { release(): void },
		  ) => void)
		| null = null;
	resetCb: ((code: number) => void) | null = null;
	paused = 0;
	resumed = 0;
	stopped: number | null = null;

	onData(cb: NonNullable<MockWasmStream["dataCb"]>): void {
		this.dataCb = cb;
	}
	onReset(cb: (code: number) => void): void {
		this.resetCb = cb;
	}
	pause(): void {
		this.paused += 1;
	}
	resume(): void {
		this.resumed += 1;
	}
	stop(code: number): void {
		this.stopped = code;
	}
	deliver(data: Uint8Array, fin = false): void {
		this.dataCb?.(data, fin);
	}
}

function readerFor(handle: {
	buffer: SharedArrayBuffer;
	descriptor: StreamSinkDescriptor;
}): SinkReader {
	return new SinkReader(handle.descriptor, handle.buffer, { copy: true });
}

async function drainUntilEnded(
	reader: SinkReader,
	deadlineMs = 5000,
): Promise<SinkRecord[]> {
	const records: SinkRecord[] = [];
	const deadline = Date.now() + deadlineMs;
	while (reader.state === "active" && Date.now() < deadline) {
		// waitAsync path: this test shares the producer's thread.
		for await (const record of reader) {
			records.push(record);
			break;
		}
	}
	return records;
}

describe("wasm sink producer (RFC_STREAM_SINK §7)", () => {
	it("RingWriter reproduces the Rust golden vector byte-for-byte", () => {
		const cap = 1024;
		const sab = new SharedArrayBuffer(SINK_DATA_OFFSET + cap);
		// The golden scenario was written without producer notifies.
		const writer = new RingWriter(
			sab,
			cap,
			FLAG_FRAMING | FLAG_CLOCK_WALL,
			false,
		);
		expect(
			writer.push(REC_DATA, 0x0102030405060708n, 0n, patterned(7, 5)),
		).toBe("written");
		expect(
			writer.push(REC_MESSAGE, 0x1112131415161718n, 5n, patterned(8, 40)),
		).toBe("written");
		expect(
			writer.pushTerminal(
				REC_RESET,
				0x2122232425262728n,
				45n,
				new Uint8Array(0),
				77,
			),
		).toBe(true);
		expect(writer.pushTerminal(REC_RESET, 0n, 0n, new Uint8Array(0), 1)).toBe(
			false,
		);
		const dump = Buffer.from(new Uint8Array(sab, 0, SINK_DATA_OFFSET + 160));
		expect(dump.toString("hex")).toBe(GOLDEN_HEX);
	});

	it("round-trips records through RingWriter and SinkReader across wrap", () => {
		const cap = 4096;
		const sab = new SharedArrayBuffer(SINK_DATA_OFFSET + cap);
		const writer = new RingWriter(sab, cap, 0, false);
		const descriptor: StreamSinkDescriptor = {
			version: 1,
			dataCapacity: cap,
			flags: 0,
			clock: "monotonic",
			monotonicAnchorUs: 0,
			wallAnchorUs: 0,
			framing: null,
		};
		const reader = new SinkReader(descriptor, sab);
		let offset = 0n;
		let expectSeq = 0;
		// Push/consume alternately far past capacity to exercise wrap-around.
		for (let seq = 0; seq < 500; seq++) {
			const payload = patterned(seq, 100 + (seq % 7) * 41);
			let outcome = writer.push(REC_DATA, BigInt(seq), offset, payload);
			while (outcome === "wouldblock") {
				const record = reader.next(10);
				expect(record?.timestampNs).toBe(BigInt(expectSeq));
				expectSeq += 1;
				outcome = writer.push(REC_DATA, BigInt(seq), offset, payload);
			}
			offset += BigInt(payload.length);
		}
		let record = reader.next(10);
		while (record) {
			expect(record.timestampNs).toBe(BigInt(expectSeq));
			expect(
				Buffer.from(record.payload).equals(
					Buffer.from(patterned(expectSeq, record.payload.length)),
				),
			).toBe(true);
			expectSeq += 1;
			record = reader.next(10);
		}
		expect(expectSeq).toBe(500);
	});

	it("FrameCutter matches the Rust deframer at every split point", () => {
		const framing = {
			headerBytes: 8,
			lengthOffset: 2,
			lengthWidth: 2 as const,
			lengthIncludesHeader: false,
			maxFrameBytes: 512,
		};
		const frames: Uint8Array[] = [];
		const wire: number[] = [];
		for (const [seq, plen] of [
			[1, 0],
			[2, 33],
			[3, 120],
		] as const) {
			const frame = new Uint8Array(8 + plen);
			frame[0] = seq;
			frame[1] = 0xaa;
			new DataView(frame.buffer).setUint16(2, plen, true);
			frame.set(patterned(seq, plen), 8);
			frames.push(frame);
			wire.push(...frame);
		}
		for (let split = 0; split <= wire.length; split++) {
			const cutter = new FrameCutter(framing);
			const seen = [
				...cutter.push(Uint8Array.from(wire.slice(0, split))),
				...cutter.push(Uint8Array.from(wire.slice(split))),
			];
			expect(seen.length).toBe(frames.length);
			for (const [i, frame] of frames.entries()) {
				expect(Buffer.from(seen[i]!)).toEqual(Buffer.from(frame));
			}
			expect(cutter.pendingBytes).toBe(0);
		}
	});

	it("delivers chunks, EOF, and stats over a mock wasm stream", async () => {
		const stream = new MockWasmStream();
		const handle = openWasmReadSink(stream, { ringBytes: 65536 });
		const payloads = [patterned(1, 40), patterned(2, 2000)];
		for (const p of payloads) stream.deliver(p);
		// Drain completes with the stream still open: the producer resumes it.
		await Bun.sleep(10);
		expect(stream.resumed).toBeGreaterThan(0);
		stream.deliver(new Uint8Array(0), true);
		const reader = readerFor(handle);
		const records = await drainUntilEnded(reader);
		expect(records.at(-1)?.type).toBe("eof");
		const data = records.filter((r) => r.type === "data");
		expect(data.length).toBe(2);
		expect(Buffer.from(data[0]!.payload)).toEqual(Buffer.from(payloads[0]!));
		expect(Buffer.from(data[1]!.payload)).toEqual(Buffer.from(payloads[1]!));
		expect(data[1]!.streamOffset).toBe(40n);
		const stats = handle.stats();
		expect(stats.state).toBe("eof");
		expect(stats.bytesIn).toBe(2040);
		// The producer paused per delivered chunk.
		expect(stream.paused).toBeGreaterThan(0);
	});

	it("maps onReset to a reset terminal with the app code", async () => {
		const stream = new MockWasmStream();
		const handle = openWasmReadSink(stream, { ringBytes: 65536 });
		stream.deliver(patterned(9, 10));
		stream.resetCb?.(42);
		const records = await drainUntilEnded(readerFor(handle));
		const terminal = records.at(-1);
		expect(terminal?.type).toBe("reset");
		expect(terminal?.code).toBe(42);
		expect(handle.stats().state).toBe("reset");
	});

	it("close() commits E_SINK_CLOSED and stops the wire", async () => {
		const stream = new MockWasmStream();
		const handle = openWasmReadSink(stream, { ringBytes: 65536 });
		stream.deliver(patterned(3, 25));
		await handle.close();
		const records = await drainUntilEnded(readerFor(handle));
		const terminal = records.at(-1);
		expect(terminal?.type).toBe("error");
		expect(terminal?.code).toBe("E_SINK_CLOSED");
		expect(stream.stopped).toBe(0);
		await handle.close(); // idempotent
	});

	it("cuts frames with a framing descriptor over the mock stream", async () => {
		const stream = new MockWasmStream();
		const handle = openWasmReadSink(stream, {
			ringBytes: 65536,
			framing: {
				headerBytes: 4,
				lengthOffset: 0,
				lengthWidth: 2,
				lengthIncludesHeader: false,
				maxFrameBytes: 4096,
			},
		});
		const payload = patterned(5, 90);
		const frame = new Uint8Array(4 + payload.length);
		new DataView(frame.buffer).setUint16(0, payload.length, true);
		frame.set(payload, 4);
		// Split mid-frame across two deliveries.
		stream.deliver(frame.subarray(0, 30));
		stream.deliver(frame.subarray(30), true);
		const records = await drainUntilEnded(readerFor(handle));
		const messages = records.filter((r) => r.type === "message");
		expect(messages.length).toBe(1);
		expect(Buffer.from(messages[0]!.payload)).toEqual(Buffer.from(frame));
		expect(records.at(-1)?.type).toBe("eof");
	});
});
