/**
 * Pooling behavior tests.
 * Verifies allowPooling option triggers endpoint reuse and metrics.
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import {
	WebTransport,
	createServer,
	clientPoolMetricsSnapshot,
} from "../src/index.js";

describe("parity pooling", () => {
	let server: ReturnType<typeof createServer>;
	let port: number;

	beforeAll(async () => {
		port = 15511;
		server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			onSession: () => {},
		});
		await Bun.sleep(2000);
	});

	afterAll(async () => {
		await server.close();
	});

	test("allowPooling: true with identical options reuses pooled endpoint (pool hit)", async () => {
		const before = clientPoolMetricsSnapshot();

		const wt1 = new WebTransport(`https://127.0.0.1:${port}`, {
			allowPooling: true,
			tls: { insecureSkipVerify: true },
		});
		await wt1.ready;
		wt1.close();
		await wt1.closed;

		const wt2 = new WebTransport(`https://127.0.0.1:${port}`, {
			allowPooling: true,
			tls: { insecureSkipVerify: true },
		});
		await wt2.ready;
		wt2.close();
		await wt2.closed;

		const after = clientPoolMetricsSnapshot();
		expect(after.misses).toBeGreaterThanOrEqual(before.misses + 1);
		expect(after.hits).toBeGreaterThanOrEqual(before.hits + 1);
	});

	test("allowPooling: false uses dedicated (no pool hit for dedicated)", async () => {
		const before = clientPoolMetricsSnapshot();

		const wt1 = new WebTransport(`https://127.0.0.1:${port}`, {
			allowPooling: false,
			tls: { insecureSkipVerify: true },
		});
		await wt1.ready;
		wt1.close();
		await wt1.closed;

		const wt2 = new WebTransport(`https://127.0.0.1:${port}`, {
			allowPooling: false,
			tls: { insecureSkipVerify: true },
		});
		await wt2.ready;
		wt2.close();
		await wt2.closed;

		const after = clientPoolMetricsSnapshot();
		expect(after.hits).toBe(before.hits);
	});

	test("allowPooling: true + serverCertificateHashes throws", () => {
		expect(
			() =>
				new WebTransport(`https://127.0.0.1:${port}`, {
					allowPooling: true,
					serverCertificateHashes: [
						{
							algorithm: "sha-256",
							value: new Uint8Array(32).fill(0),
						},
					],
					tls: { insecureSkipVerify: true },
				}),
		).toThrow(/cannot be used with allowPooling=true/);
	});

	test("different compatibility keys do not reuse (requireUnreliable differs)", async () => {
		const before = clientPoolMetricsSnapshot();

		const wt1 = new WebTransport(`https://127.0.0.1:${port}`, {
			allowPooling: true,
			requireUnreliable: false,
			tls: { insecureSkipVerify: true },
		});
		await wt1.ready;
		wt1.close();
		await wt1.closed;

		const wt2 = new WebTransport(`https://127.0.0.1:${port}`, {
			allowPooling: true,
			requireUnreliable: true,
			tls: { insecureSkipVerify: true },
		});
		await wt2.ready;
		wt2.close();
		await wt2.closed;

		const after = clientPoolMetricsSnapshot();
		// Second connect has different key (requireUnreliable differs), so cannot reuse first -> must be a miss
		expect(after.misses).toBeGreaterThanOrEqual(before.misses + 1);
		// First connect may hit prior test pool; second cannot hit first's entry (different key)
		expect(after.hits).toBeLessThanOrEqual(before.hits + 1);
	});

	test("clientPoolMetricsSnapshot returns shape", () => {
		const s = clientPoolMetricsSnapshot();
		expect(typeof s.hits).toBe("number");
		expect(typeof s.misses).toBe("number");
		expect(typeof s.evictIdle).toBe("number");
		expect(typeof s.evictBroken).toBe("number");
	});
});
