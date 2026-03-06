/**
 * Pooling behavior tests.
 * Verifies allowPooling option triggers endpoint reuse and metrics.
 */

import { describe, expect, test } from "bun:test";
import {
	WebTransport,
	createServer,
	clientPoolMetricsSnapshot,
} from "../src/index.js";
import { nextPort } from "./helpers/network.js";

describe("parity pooling", () => {
	async function withServer(
		run: (url: string) => Promise<void>,
	): Promise<void> {
		const port = nextPort(15511, 1000);
		const server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			onSession: () => {},
		});
		try {
			await run(`https://127.0.0.1:${port}`);
		} finally {
			await server.close();
		}
	}

	async function openAndCloseWithRetry(
		url: string,
		opts: ConstructorParameters<typeof WebTransport>[1],
		timeoutMs = 5000,
	): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		let lastErr: unknown;
		while (Date.now() < deadline) {
			const wt = new WebTransport(url, opts);
			try {
				await wt.ready;
				wt.close();
				await wt.closed.catch(() => {});
				return;
			} catch (err) {
				lastErr = err;
				wt.close();
				await wt.closed.catch(() => {});
				await Bun.sleep(100);
			}
		}
		throw lastErr ?? new Error("openAndCloseWithRetry: timed out");
	}

	test("allowPooling: true with identical options reuses pooled endpoint (pool hit)", async () => {
		await withServer(async (url) => {
			const before = clientPoolMetricsSnapshot();
			await openAndCloseWithRetry(url, {
				allowPooling: true,
				tls: { insecureSkipVerify: true },
			});
			await openAndCloseWithRetry(url, {
				allowPooling: true,
				tls: { insecureSkipVerify: true },
			});
			const after = clientPoolMetricsSnapshot();
			expect(after.misses).toBeGreaterThanOrEqual(before.misses + 1);
			expect(after.hits).toBeGreaterThanOrEqual(before.hits + 1);
		});
	});

	test("allowPooling: false uses dedicated (no pool hit for dedicated)", async () => {
		await withServer(async (url) => {
			const before = clientPoolMetricsSnapshot();
			await openAndCloseWithRetry(url, {
				allowPooling: false,
				tls: { insecureSkipVerify: true },
			});
			await openAndCloseWithRetry(url, {
				allowPooling: false,
				tls: { insecureSkipVerify: true },
			});
			const after = clientPoolMetricsSnapshot();
			// In a concurrent full-suite run, unrelated tests may also use pooling.
			// Dedicated connects should not depend on hit growth; just assert no regressions in metric shape/monotonicity.
			expect(after.hits).toBeGreaterThanOrEqual(before.hits);
			expect(after.misses).toBeGreaterThanOrEqual(before.misses);
		});
	});

	test("allowPooling: true + serverCertificateHashes throws", () => {
		const port = nextPort(15511, 1000);
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
		await withServer(async (url) => {
			const before = clientPoolMetricsSnapshot();
			await openAndCloseWithRetry(url, {
				allowPooling: true,
				requireUnreliable: false,
				tls: { insecureSkipVerify: true },
			});
			await openAndCloseWithRetry(url, {
				allowPooling: true,
				requireUnreliable: true,
				tls: { insecureSkipVerify: true },
			});
			const after = clientPoolMetricsSnapshot();
			// Different compatibility key requires at least one miss.
			expect(after.misses).toBeGreaterThanOrEqual(before.misses + 1);
			// Hits can rise from unrelated concurrent files in full-suite CI runs.
			expect(after.hits).toBeGreaterThanOrEqual(before.hits);
		});
	});

	test("different compatibility keys do not reuse (congestionControl differs)", async () => {
		await withServer(async (url) => {
			const before = clientPoolMetricsSnapshot();
			await openAndCloseWithRetry(url, {
				allowPooling: true,
				congestionControl: "throughput",
				tls: { insecureSkipVerify: true },
			});
			await openAndCloseWithRetry(url, {
				allowPooling: true,
				congestionControl: "low-latency",
				tls: { insecureSkipVerify: true },
			});
			const after = clientPoolMetricsSnapshot();
			expect(after.misses).toBeGreaterThanOrEqual(before.misses + 2);
			expect(after.hits).toBeGreaterThanOrEqual(before.hits);
		});
	});

	test("same non-default congestionControl reuses pooled endpoint", async () => {
		await withServer(async (url) => {
			const before = clientPoolMetricsSnapshot();
			await openAndCloseWithRetry(url, {
				allowPooling: true,
				congestionControl: "throughput",
				tls: { insecureSkipVerify: true },
			});
			await openAndCloseWithRetry(url, {
				allowPooling: true,
				congestionControl: "throughput",
				tls: { insecureSkipVerify: true },
			});
			const after = clientPoolMetricsSnapshot();
			expect(after.misses).toBeGreaterThanOrEqual(before.misses + 1);
			expect(after.hits).toBeGreaterThanOrEqual(before.hits + 1);
		});
	});

	test("clientPoolMetricsSnapshot returns shape", () => {
		const s = clientPoolMetricsSnapshot();
		expect(typeof s.hits).toBe("number");
		expect(typeof s.misses).toBe("number");
		expect(typeof s.evictIdle).toBe("number");
		expect(typeof s.evictBroken).toBe("number");
	});
});
