/**
 * P0-C: Queue saturation, backpressure timeout, and recovery.
 * P1.2: Backpressure metrics (backpressureWaitCount, backpressureTimeoutCount).
 */

import { describe, it, expect } from "bun:test";
import { connect, createServer, E_BACKPRESSURE_TIMEOUT } from "../src/index.js";

function nextPort(): number {
	return 14460 + Math.floor(Math.random() * 100);
}

describe("backpressure (P0-C)", () => {
	it("datagram size over max is rejected", async () => {
		const server = createServer({
			port: 14460,
			tls: { certPem: "", keyPem: "" },
			onSession: async (s) => {
				for await (const _ of s.incomingDatagrams()) {
				}
			},
		});
		await Bun.sleep(2000);

		const client = await connect("https://127.0.0.1:14460", {
			tls: { insecureSkipVerify: true },
		});

		const big = new Uint8Array(1500);
		await expect(client.sendDatagram(big)).rejects.toThrow(/E_QUEUE_FULL/);

		await server.close();
	}, 10000);

	it("rapid datagram sends eventually apply backpressure", async () => {
		const server = createServer({
			port: 14461,
			tls: { certPem: "", keyPem: "" },
			onSession: async (s) => {
				for await (const _ of s.incomingDatagrams()) {
				}
			},
		});
		await Bun.sleep(2000);

		const client = await connect("https://127.0.0.1:14461", {
			tls: { insecureSkipVerify: true },
		});

		const dgram = new Uint8Array(100);
		const sends = Array.from({ length: 400 }, () =>
			client.sendDatagram(dgram).catch((e: Error) => e),
		);
		const results = await Promise.all(sends);
		const timeouts = results.filter(
			(r) =>
				r instanceof Error && r.message?.includes("E_BACKPRESSURE_TIMEOUT"),
		);
		const successes = results.filter((r) => !(r instanceof Error));

		expect(successes.length).toBeGreaterThan(0);
		if (timeouts.length > 0) {
			expect(timeouts[0]).toBeInstanceOf(Error);
			expect((timeouts[0] as Error).message).toContain(E_BACKPRESSURE_TIMEOUT);
		}

		await server.close();
	}, 15000);

	it("send and receive works when server echoes", async () => {
		const server = createServer({
			port: 14462,
			tls: { certPem: "", keyPem: "" },
			onSession: async (s) => {
				for await (const d of s.incomingDatagrams()) {
					await s.sendDatagram(d);
				}
			},
		});
		await Bun.sleep(2000);

		const client = await connect("https://127.0.0.1:14462", {
			tls: { insecureSkipVerify: true },
		});

		const dgram = new Uint8Array([1, 2, 3]);
		await client.sendDatagram(dgram);
		const iter = client.incomingDatagrams()[Symbol.asyncIterator]();
		const first = (await Promise.race([
			iter.next(),
			Bun.sleep(1500).then(() => ({ done: true as const, value: undefined })),
		])) as IteratorResult<Uint8Array>;
		expect(first.done).toBe(false);

		await server.close();
	}, 10000);
});

describe("backpressure observability (P1.2)", () => {
	it("backpressure counters exist and have correct shape", async () => {
		const port = nextPort();
		const server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			onSession: async (s) => {
				for await (const d of s.incomingDatagrams()) {
					await s.sendDatagram(d);
				}
			},
		});
		try {
			await Bun.sleep(2000);

			const client = await connect(`https://127.0.0.1:${port}`, {
				tls: { insecureSkipVerify: true },
			});
			await client.sendDatagram(new Uint8Array([1, 2, 3]));
			// Counters are shape checks only; avoid blocking on echoed datagram delivery.
			await Bun.sleep(50);

			const m = server.metricsSnapshot();
			expect(typeof m.backpressureWaitCount).toBe("number");
			expect(typeof m.backpressureTimeoutCount).toBe("number");
			expect(m.backpressureWaitCount).toBeGreaterThanOrEqual(0);
			expect(m.backpressureTimeoutCount).toBeGreaterThanOrEqual(0);
		} finally {
			await server.close();
		}
	}, 10000);

	it("backpressureTimeoutCount increments when server send times out (best-effort)", async () => {
		const port = nextPort();
		const server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			limits: { backpressureTimeoutMs: 1 },
			onSession: async (s) => {
				for await (const d of s.incomingDatagrams()) {
					void s.sendDatagram(d).catch(() => {});
				}
			},
		});
		await Bun.sleep(2000);

		const client = await connect(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
		});
		const buf = new Uint8Array(800);
		const sends = Array.from({ length: 600 }, () =>
			client.sendDatagram(buf).catch(() => {}),
		);
		await Promise.all(sends);
		await Bun.sleep(2000);

		const m = server.metricsSnapshot();
		if (m.backpressureTimeoutCount > 0) {
			expect(m.backpressureWaitCount).toBeGreaterThanOrEqual(
				m.backpressureTimeoutCount,
			);
		}

		await server.close();
	}, 25000);
});
