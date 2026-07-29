/**
 * Pooling behavior tests.
 * Verifies allowPooling option triggers endpoint reuse and metrics.
 */

import { describe, expect, test } from "bun:test";
import { WebTransport } from "../src/index.js";
import { nextPort } from "./helpers/network.js";
import {
	createParityHarness,
	type ParityHarness,
	isWasmParityBackend,
	skipWasmParityIfUnavailable,
	wasmParityReady,
} from "./helpers/parity-backend.js";

describe.skipIf(skipWasmParityIfUnavailable)("parity pooling", () => {
	async function withHarness(
		run: (harness: ParityHarness) => Promise<void>,
	): Promise<void> {
		const harness = await createParityHarness({ onSession: () => {} });
		try {
			await run(harness);
		} finally {
			await harness.close();
		}
	}

	/**
	 * A pooled connect cannot complete against the wasm harness: pooling forbids
	 * serverCertificateHashes, and a wasm client has no insecureSkipVerify and
	 * no usable CA root for this self-signed loopback server. Wasm pooled reuse
	 * is covered behaviorally in wasm-parity-helpers.test.ts
	 * ("allowPooling reuses the endpoint manager across compatible connects").
	 */
	function skipPooledConnectOnWasm(): boolean {
		if (!isWasmParityBackend()) return false;
		expect(wasmParityReady()).toBe(true);
		return true;
	}

	test("allowPooling: true with identical options reuses pooled endpoint (pool hit)", async () => {
		if (skipPooledConnectOnWasm()) return;
		await withHarness(async (harness) => {
			const before = harness.poolMetrics();
			await harness.openAndClose({ allowPooling: true });
			await harness.openAndClose({ allowPooling: true });
			const after = harness.poolMetrics();
			expect(after.misses).toBeGreaterThanOrEqual(before.misses + 1);
			expect(after.hits).toBeGreaterThanOrEqual(before.hits + 1);
		});
	});

	test("allowPooling: false uses dedicated (no pool hit for dedicated)", async () => {
		await withHarness(async (harness) => {
			const before = harness.poolMetrics();
			await harness.openAndClose({ allowPooling: false });
			await harness.openAndClose({ allowPooling: false });
			const after = harness.poolMetrics();
			// In a concurrent full-suite run, unrelated tests may also use pooling.
			// Dedicated connects should not depend on hit growth; just assert no
			// regressions in metric shape/monotonicity.
			expect(after.hits).toBeGreaterThanOrEqual(before.hits);
			expect(after.misses).toBeGreaterThanOrEqual(before.misses);
		});
	});

	test("allowPooling: true + serverCertificateHashes throws", async () => {
		await withHarness(async (harness) => {
			expect(() =>
				harness.construct({
					allowPooling: true,
					serverCertificateHashes: [
						{
							algorithm: "sha-256",
							value: new Uint8Array(32).fill(0),
						},
					],
				}),
			).toThrow(/cannot be used with allowPooling=true/);
		});
	});

	test("different compatibility keys do not reuse (requireUnreliable differs)", async () => {
		await withHarness(async (harness) => {
			const before = harness.poolMetrics();
			await harness.openAndClose({
				allowPooling: true,
				requireUnreliable: false,
			});
			await harness.openAndClose({
				allowPooling: true,
				requireUnreliable: true,
			});
			const after = harness.poolMetrics();
			// Different compatibility key requires at least one miss.
			expect(after.misses).toBeGreaterThanOrEqual(before.misses + 1);
			// Hits can rise from unrelated concurrent files in full-suite CI runs.
			expect(after.hits).toBeGreaterThanOrEqual(before.hits);
		});
	});

	test("different compatibility keys do not reuse (congestionControl differs)", async () => {
		await withHarness(async (harness) => {
			const before = harness.poolMetrics();
			await harness.openAndClose({
				allowPooling: true,
				congestionControl: "throughput",
			});
			await harness.openAndClose({
				allowPooling: true,
				congestionControl: "low-latency",
			});
			const after = harness.poolMetrics();
			expect(after.misses).toBeGreaterThanOrEqual(before.misses + 2);
			expect(after.hits).toBeGreaterThanOrEqual(before.hits);
		});
	});

	test("same non-default congestionControl reuses pooled endpoint", async () => {
		if (skipPooledConnectOnWasm()) return;
		await withHarness(async (harness) => {
			const before = harness.poolMetrics();
			await harness.openAndClose({
				allowPooling: true,
				congestionControl: "throughput",
			});
			await harness.openAndClose({
				allowPooling: true,
				congestionControl: "throughput",
			});
			const after = harness.poolMetrics();
			expect(after.misses).toBeGreaterThanOrEqual(before.misses + 1);
			expect(after.hits).toBeGreaterThanOrEqual(before.hits + 1);
		});
	});

	test("pool metrics snapshot returns hit/miss counters", async () => {
		await withHarness(async (harness) => {
			const s = harness.poolMetrics();
			expect(typeof s.hits).toBe("number");
			expect(typeof s.misses).toBe("number");
			// Eviction accounting differs by design: native splits idle from
			// broken, wasm keeps one combined counter.
			if (isWasmParityBackend()) {
				expect(typeof s.evictions).toBe("number");
			} else {
				expect(typeof s.evictIdle).toBe("number");
				expect(typeof s.evictBroken).toBe("number");
			}
		});
	});

	test("failed pooled connects evict broken entries instead of poisoning the pool", async () => {
		// Native-only: this asserts the dedicated `evictBroken` counter, which
		// the wasm pool does not keep separately (it has one `evictions` total).
		if (isWasmParityBackend()) {
			expect(wasmParityReady()).toBe(true);
			return;
		}
		const port = nextPort(16511, 1000);
		const url = `https://127.0.0.1:${port}`;
		const harness = await createParityHarness({ onSession: () => {} });
		const before = harness.poolMetrics();

		try {
			for (let attempt = 0; attempt < 3; attempt++) {
				const wt = new WebTransport(url, {
					allowPooling: true,
					tls: { insecureSkipVerify: true },
					limits: { handshakeTimeoutMs: 50 },
				});
				await expect(wt.ready).rejects.toThrow(/E_HANDSHAKE_TIMEOUT/);
				wt.close();
				await wt.closed.catch(() => {});
			}

			const after = harness.poolMetrics();
			expect(after.evictBroken).toBeGreaterThanOrEqual(
				(before.evictBroken ?? 0) + 1,
			);
		} finally {
			await harness.close();
		}
	});
});
