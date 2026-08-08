/**
 * Parity tests: WebTransport datagrams facade (Phase P2).
 * Verifies datagrams.readable and datagrams.writable Web Streams.
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { forEachWithTimeout, readWithTimeout } from "./helpers/harness.js";
import {
	createParityHarness,
	type ParityHarness,
	skipWasmParityIfUnavailable,
} from "./helpers/parity-backend.js";

describe.skipIf(skipWasmParityIfUnavailable)("parity datagrams (P2)", () => {
	let harness: ParityHarness;

	beforeAll(async () => {
		harness = await createParityHarness({
			onSession: async (s) => {
				await forEachWithTimeout(
					s.incomingDatagrams(),
					5000,
					"parity datagrams server incoming datagram",
					async (d) => {
						await s.sendDatagram(d);
					},
				);
			},
		});
	});

	afterAll(async () => {
		await harness.close();
	});

	test("datagrams.writable.write sends datagram", async () => {
		const wt = await harness.open();
		const writer = wt.datagrams.writable.getWriter();
		await writer.write(new Uint8Array([1, 2, 3]));
		writer.releaseLock();
		wt.close();
	});

	test("datagrams.readable receives echoed datagram", async () => {
		const wt = await harness.open();
		const payload = new Uint8Array([10, 20, 30]);
		const writer = wt.datagrams.writable.getWriter();
		await writer.write(payload);
		writer.releaseLock();
		const reader = wt.datagrams.readable.getReader();
		const { value, done } = await readWithTimeout(
			reader,
			5000,
			"parity datagram echoed read",
		);
		expect(done).toBe(false);
		expect(value).toBeDefined();
		expect(new Uint8Array(value!)).toEqual(payload);
		reader.releaseLock();
		wt.close();
	});

	test("datagram round-trip via Web Streams", async () => {
		const wt = await harness.open();
		const sent = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
		const writer = wt.datagrams.writable.getWriter();
		await writer.write(sent);
		writer.releaseLock();
		const reader = wt.datagrams.readable.getReader();
		const { value } = await readWithTimeout(
			reader,
			5000,
			"parity datagram round-trip read",
		);
		expect(value).toBeDefined();
		expect(new Uint8Array(value!)).toEqual(sent);
		reader.releaseLock();
		wt.close();
	});

	test("datagrams.createWritable returns WritableStream", async () => {
		const wt = await harness.open();
		const writable = wt.datagrams.createWritable();
		expect(writable).toBeInstanceOf(WritableStream);
		const writer = writable.getWriter();
		await writer.write(new Uint8Array([1, 2, 3]));
		writer.releaseLock();
		wt.close();
	});

	test("datagrams.maxDatagramSize is positive number", async () => {
		const wt = await harness.open();
		expect(typeof wt.datagrams.maxDatagramSize).toBe("number");
		expect(wt.datagrams.maxDatagramSize).toBeGreaterThan(0);
		wt.close();
	});

	test("datagrams.createWritable accepts valid sendGroup and validates ownership", async () => {
		const wt = await harness.open();
		// Both backends have a nominally-private send-group class, so the union
		// needs a cast even though each half is self-consistent.
		const group = wt.createSendGroup() as never;
		expect(() =>
			wt.datagrams.createWritable({ sendGroup: group, sendOrder: 1 }),
		).not.toThrow();
		expect(() =>
			wt.datagrams.createWritable({ sendGroup: {} as unknown as never }),
		).toThrow(/sendGroup belongs to another transport/);
		wt.close();
	});
});
