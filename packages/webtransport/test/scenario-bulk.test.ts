import { describe, expect, it } from "bun:test";
import { runBulkClient } from "../../../examples/scenarios/bulk/client.js";
import { startBulkServer } from "../../../examples/scenarios/bulk/server.js";
import { generateDevTls } from "../../../examples/scenarios/shared/dev-tls.js";

// Keeps docs/scenarios/bulk-and-streaming.md's example runnable. It checks
// that the example works end to end at a small scale, not how fast it is: the
// runbook's numbers come from dedicated hardware, not from this test.
describe("scenario example: bulk transfer", () => {
	it("delivers every requested stream intact and waits on drain", async () => {
		const tls = generateDevTls();
		const bulk = startBulkServer({ port: 0, host: "127.0.0.1", tls });
		try {
			const report = await runBulkClient({
				url: `https://127.0.0.1:${bulk.port}/content`,
				caPem: tls.caPem,
				sessions: 3,
				streams: 4,
				bytesPerStream: 1024 * 1024,
				chunkBytes: 65_536,
				timeoutMs: 20_000,
			});
			expect(report.connectFailures).toBe(0);
			expect(report.errors).toEqual({});
			expect(report.streamsCompleted).toBe(12);
			expect(report.bytesReceived).toBe(report.bytesExpected);
			expect(report.patternMismatches).toBe(0);
			expect(report.serverBytesSent).toBe(report.bytesExpected);
			expect(report.serverStreamErrors).toEqual({});
			// 1 MiB per stream in 64 KiB writes overruns the 256 KiB writable
			// buffer, so the server must have parked on 'drain'.
			expect(bulk.drainWaits).toBeGreaterThan(0);
		} finally {
			await bulk.close();
		}
	}, 30_000);

	it("refuses a request it cannot serve and says why", async () => {
		const tls = generateDevTls();
		const bulk = startBulkServer({ port: 0, host: "127.0.0.1", tls });
		try {
			const report = await runBulkClient({
				url: `https://127.0.0.1:${bulk.port}/content`,
				caPem: tls.caPem,
				streams: 1,
				bytesPerStream: 1024,
				// Larger than the default 256 KiB per-stream budget.
				chunkBytes: 512 * 1024,
				timeoutMs: 10_000,
			});
			expect(report.streamsCompleted).toBe(0);
			expect(Object.keys(report.errors)).toEqual([
				"chunkBytes must be 1..262144",
			]);
			expect(bulk.transfers).toBe(0);
		} finally {
			await bulk.close();
		}
	}, 30_000);
});
