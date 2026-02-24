/**
 * Parity robustness tests (Phase 6).
 * Stress tests for backpressure + stream/datagram interplay.
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { WebTransport, createServer } from "../src/index.js";

describe("parity robustness (Phase 6)", () => {
	let server: ReturnType<typeof createServer>;
	let port: number;

	beforeAll(async () => {
		port = 15560;
		server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			onSession: async (s) => {
				void (async () => {
					for await (const d of s.incomingDatagrams()) {
						await s.sendDatagram(d);
					}
				})().catch(() => {});
				for await (const duplex of s.incomingBidirectionalStreams) {
					void (async () => {
						const reader = duplex.readable.getReader();
						const chunks: Uint8Array[] = [];
						while (true) {
							const { done, value } = await reader.read();
							if (done) break;
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
				}
			},
		});
		await Bun.sleep(2000);
	});

	afterAll(async () => {
		await server.close();
	});

	test("datagram and bidi streams both complete", async () => {
		const wt = new WebTransport(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
		});
		await wt.ready;

		const w = wt.datagrams.writable.getWriter();
		await w.write(new Uint8Array([1, 2, 3]));
		w.releaseLock();
		const dr = wt.datagrams.readable.getReader();
		const { value: dgramVal } = await dr.read();
		dr.releaseLock();
		expect(dgramVal).toBeDefined();
		expect(new Uint8Array(dgramVal!).toString()).toBe("1,2,3");

		const { readable, writable } = await wt.createBidirectionalStream();
		const bw = writable.getWriter();
		await bw.write(new Uint8Array([4, 5, 6]));
		await bw.close();
		const br = readable.getReader();
		const chunks: Uint8Array[] = [];
		while (true) {
			const { done, value } = await br.read();
			if (done) break;
			if (value) chunks.push(value);
		}
		br.releaseLock();
		expect(chunks.length).toBeGreaterThan(0);
		const echoed = Buffer.concat(chunks.map((c) => Buffer.from(c)));
		expect(new Uint8Array(echoed)).toEqual(new Uint8Array([4, 5, 6]));
		wt.close();
	}, 10000);

	test("multiple createWritable instances send independently", async () => {
		const wt = new WebTransport(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
		});
		await wt.ready;

		const w1 = wt.datagrams.createWritable();
		const w2 = wt.datagrams.createWritable();
		const writer1 = w1.getWriter();
		const writer2 = w2.getWriter();
		await writer1.write(new Uint8Array([0xa]));
		await writer2.write(new Uint8Array([0xb]));
		writer1.releaseLock();
		writer2.releaseLock();

		const reader = wt.datagrams.readable.getReader();
		const seen = new Set<number>();
		for (let i = 0; i < 2; i++) {
			const { value } = await reader.read();
			const first = value?.[0];
			if (first !== undefined) seen.add(first);
		}
		reader.releaseLock();
		expect(seen.has(0xa)).toBe(true);
		expect(seen.has(0xb)).toBe(true);
		wt.close();
	});
});
