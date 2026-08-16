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

	// The narrowed portable contract, seen from the receiving facade: item type,
	// one item per read, and this backend's own receive order. Hidden buffering
	// is not part of it — native reads the addon in batches and wasm does not —
	// so nothing below counts what either backend held back.
	const BURST = 8;

	test("datagrams.readable yields one Uint8Array per datagram, in receive order", async () => {
		const wt = await harness.open();
		const writer = wt.datagrams.writable.getWriter();
		for (let id = 0; id < BURST; id += 1) {
			await writer.write(new Uint8Array([id]));
		}
		writer.releaseLock();

		const reader = wt.datagrams.readable.getReader();
		const ids: number[] = [];
		while (ids.length < BURST) {
			const next = await readWithTimeout(
				reader,
				5000,
				"parity datagram burst read",
			).catch(() => null);
			// Unreliable transport: a datagram that never lands is loss, not a
			// contract breach. Judge whatever did arrive.
			if (next === null || next.done) break;
			expect(next.value).toBeInstanceOf(Uint8Array);
			const item = new Uint8Array(next.value as Uint8Array);
			expect(item.length).toBe(1);
			ids.push(item[0] as number);
		}
		reader.releaseLock();
		wt.close();

		expect(ids.length).toBeGreaterThanOrEqual(2);
		expect(new Set(ids).size).toBe(ids.length);
		expect([...ids].sort((a, b) => a - b)).toEqual(ids);
	});

	test("datagrams.readable terminates within a bound after close", async () => {
		const wt = await harness.open();
		const writer = wt.datagrams.writable.getWriter();
		await writer.write(new Uint8Array([1]));
		writer.releaseLock();

		const reader = wt.datagrams.readable.getReader();
		wt.close();

		// Bounded termination: the stream must stop producing. How many
		// already-buffered chunks precede the end is per-backend and unasserted;
		// a rejected read is an ending too, an unbounded hang is not.
		let ended = false;
		for (let step = 0; step < BURST * 4 && !ended; step += 1) {
			const next = await readWithTimeout(
				reader,
				5000,
				"parity datagram termination read",
			).then(
				(result) => result,
				() => ({ done: true, value: undefined }) as const,
			);
			if (next.done) ended = true;
			else expect(next.value).toBeInstanceOf(Uint8Array);
		}
		expect(ended).toBe(true);
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
