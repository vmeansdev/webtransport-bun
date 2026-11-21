import { describe, expect, it } from "bun:test";
import {
	runExchanges,
	runTunnels,
} from "../../../examples/scenarios/rpc/client.js";
import { startRpcServer } from "../../../examples/scenarios/rpc/server.js";
import { generateDevTls } from "../../../examples/scenarios/shared/dev-tls.js";

// Keeps docs/scenarios/rpc-and-tunnels.md's example runnable. It checks that
// both modes work end to end at a small scale, not how fast they are: the
// runbook's numbers come from dedicated hardware, not from this test.

async function until(check: () => boolean, ms: number) {
	const deadline = performance.now() + ms;
	while (!check() && performance.now() < deadline) await Bun.sleep(10);
}

describe("scenario example: rpc and tunnels", () => {
	it("answers every call on its own stream", async () => {
		const tls = generateDevTls();
		const rpc = startRpcServer({
			port: 0,
			host: "127.0.0.1",
			tls,
			rateLimits: { handshakesPerSec: 1000, handshakesBurst: 1000 },
		});
		try {
			const report = await runExchanges({
				url: `https://127.0.0.1:${rpc.port}/rpc`,
				caPem: tls.caPem,
				sessions: 10,
				ratePerSession: 10,
				durationMs: 2000,
				callTimeoutMs: 5000,
			});
			expect(report.connectFailures).toBe(0);
			expect(report.errors).toEqual({});
			expect(report.attempted).toBeGreaterThan(50);
			expect(report.completed).toBe(report.attempted);
			// One stream per call: the server accepted exactly the streams the
			// client opened and answered each of them.
			await until(() => rpc.exchangesServed >= report.completed, 2000);
			expect(rpc.streamsAccepted).toBe(report.attempted);
			expect(rpc.exchangesServed).toBe(report.completed);
			expect(rpc.errors).toEqual({});
		} finally {
			await rpc.close();
		}
	}, 30_000);

	it("carries tunnels both ways with exact byte accounting", async () => {
		const tls = generateDevTls();
		const rpc = startRpcServer({
			port: 0,
			host: "127.0.0.1",
			tls,
			rateLimits: { handshakesPerSec: 1000, handshakesBurst: 1000 },
		});
		try {
			const report = await runTunnels({
				url: `https://127.0.0.1:${rpc.port}/tunnel`,
				caPem: tls.caPem,
				sessions: 5,
				upMbps: 3,
				downMbps: 3,
				durationMs: 2000,
			});
			expect(report.connectFailures).toBe(0);
			expect(report.errors).toEqual({});
			expect(report.tunnelsCompleted).toBe(5);
			for (const direction of [report.up, report.down]) {
				expect(direction.bytesReceived).toBeGreaterThan(0);
				expect(direction.exact).toBe(true);
				expect(direction.latencyP50Ms).toBeGreaterThan(0);
			}
			await until(() => rpc.tunnelsDone >= 5, 2000);
			expect(rpc.tunnelsDone).toBe(5);
			expect(rpc.errors).toEqual({});
		} finally {
			await rpc.close();
		}
	}, 30_000);
});
