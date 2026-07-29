/**
 * Parity tests: WebTransport streams facade (Phase P3).
 * Verifies createBidirectionalStream, createUnidirectionalStream,
 * incomingBidirectionalStreams, incomingUnidirectionalStreams.
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import {
	collectWithTimeout,
	forEachWithTimeout,
	readWithTimeout,
} from "./helpers/harness.js";
import {
	createParityHarness,
	type ParityHarness,
	skipWasmParityIfUnavailable,
} from "./helpers/parity-backend.js";

describe.skipIf(skipWasmParityIfUnavailable)("parity streams (P3)", () => {
	let harness: ParityHarness;

	beforeAll(async () => {
		harness = await createParityHarness({
			onSession: async (s) => {
				await forEachWithTimeout(
					s.incomingBidirectionalStreams,
					5000,
					"parity streams server incoming bidi",
					async (duplex) => {
						void (async () => {
							const reader = duplex.readable.getReader();
							const chunks: Uint8Array[] = [];
							while (true) {
								const { done, value } = await readWithTimeout(
									reader,
									5000,
									"parity streams server bidi read",
								);
								if (done || value === undefined) break;
								chunks.push(value);
							}
							if (chunks.length > 0) {
								const writer = duplex.writable.getWriter();
								await writer.write(
									Buffer.concat(chunks.map((c) => Buffer.from(c))),
								);
								await writer.close();
							}
						})().catch(() => {});
					},
				);
				await forEachWithTimeout(
					s.incomingUnidirectionalStreams,
					5000,
					"parity streams server incoming uni",
					async (readable) => {
						void (async () => {
							const chunks = await collectWithTimeout(
								readable,
								5000,
								"parity streams server uni chunk read",
							);
							// Echo back on a new uni stream
							const w = await s.createUnidirectionalStream();
							const writer = w.getWriter();
							await writer.write(
								Buffer.concat(chunks.map((c) => Buffer.from(c))),
							);
							await writer.close();
						})().catch(() => {});
					},
				);
			},
		});
	});

	afterAll(async () => {
		await harness.close();
	});

	test("createBidirectionalStream returns Web Streams bidi", async () => {
		const wt = await harness.open();
		const { readable, writable } = await wt.createBidirectionalStream();
		expect(readable).toBeInstanceOf(ReadableStream);
		expect(writable).toBeInstanceOf(WritableStream);
		const writer = writable.getWriter();
		await writer.write(new Uint8Array([1, 2, 3]));
		await writer.close();
		const reader = readable.getReader();
		const { value } = await readWithTimeout(
			reader,
			5000,
			"parity streams bidi echo read",
		);
		expect(value).toBeDefined();
		expect(new Uint8Array(value!)).toEqual(new Uint8Array([1, 2, 3]));
		reader.releaseLock();
		wt.close();
	});

	test("createUnidirectionalStream returns WritableStream", async () => {
		const wt = await harness.open();
		const writable = await wt.createUnidirectionalStream();
		expect(writable).toBeInstanceOf(WritableStream);
		const writer = writable.getWriter();
		await writer.write(new Uint8Array([4, 5, 6]));
		await writer.close();
		wt.close();
	});

	test("incomingBidirectionalStreams is ReadableStream of bidi streams", async () => {
		const wt = await harness.open();
		expect(wt.incomingBidirectionalStreams).toBeInstanceOf(ReadableStream);
		expect(wt.incomingUnidirectionalStreams).toBeInstanceOf(ReadableStream);
		wt.close();
	});

	test("writable.abort(reason) maps to reset (browser-style stream control)", async () => {
		const wt = await harness.open();
		const { readable, writable } = await wt.createBidirectionalStream();
		const writer = writable.getWriter();
		await writer.write(new Uint8Array([1]));
		await writer.abort(42);
		await expect(writer.closed).rejects.toBeDefined();
		wt.close();
	});

	test("readable.cancel(reason) maps to stopSending (browser-style stream control)", async () => {
		const wt = await harness.open();
		const { readable } = await wt.createBidirectionalStream();
		const reader = readable.getReader();
		reader.cancel(99);
		await reader.closed.catch(() => {});
		wt.close();
	});
});
